//! ClickHouse backend over the HTTP interface (default port 8123) using the
//! existing `reqwest` client. Queries are issued with `FORMAT JSONCompact` so
//! we get column names, types, and row data in one response.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::sql;
use super::{
    ColumnDescription, ColumnInfo, DbConfig, DbHandle, DbObject, QueryResult, QueryStreamChannel,
    QueryStreamEvent, SchemaInfo, TableInfo, emit_query_result_stream, send_query_stream_event,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;

/// A configured ClickHouse HTTP endpoint plus credentials.
#[derive(Clone)]
pub struct ClickHouseClient {
    client: reqwest::Client,
    base_url: String,
    user: Option<String>,
    password: Option<String>,
    /// Default database sent as the HTTP `database` query param. Updated when
    /// the user runs `USE db` so subsequent queries follow the UI selection.
    database: Arc<Mutex<String>>,
}

impl ClickHouseClient {
    pub fn database(&self) -> String {
        self.database
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_database(&self, database: String) {
        match self.database.lock() {
            Ok(mut guard) => *guard = database,
            Err(poisoned) => *poisoned.into_inner() = database,
        }
    }
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    // Only the HTTP interface is implemented. The native binary protocol
    // (default port 9000) is not supported yet — fail with a clear message
    // rather than silently connecting over HTTP on a different port.
    if config
        .protocol
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case("native"))
    {
        return Err(
            "ClickHouse native protocol is not supported yet — switch the protocol to HTTP.".into(),
        );
    }
    let scheme = if config.ssl { "https" } else { "http" };
    // HTTP interface port: explicit http_port wins, else 8123.
    let port = config.http_port.unwrap_or(8123);
    let base_url = format!("{scheme}://{}:{}", config.host, port);
    let timeout = Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    });
    // Disable reqwest's implicit system-proxy detection (env HTTP(S)_PROXY /
    // ALL_PROXY, plus the Windows/macOS system proxy a corporate VPN installs).
    // DB routing is explicit: a per-session proxy/jump host is handled upstream
    // by `forward.rs`, which rewrites host/port to a loopback forwarder, so this
    // client always dials directly (or the local forward). Without this an
    // ambient VPN/shell proxy could silently reroute requests to a gateway that
    // can't reach the server. Mirrors `presto::connect` and `objectstorage`.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("ClickHouse client build failed: {e}"))?;
    let ch = ClickHouseClient {
        client,
        base_url,
        user: config.username.clone().filter(|u| !u.is_empty()),
        password: password.map(|p| p.to_string()),
        database: Arc::new(Mutex::new(
            config
                .database
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| "default".to_string()),
        )),
    };
    // Verify reachability eagerly so db_connect reports failures up front.
    ping(&ch).await?;
    Ok(DbHandle::ClickHouse(ch))
}

fn sql_request(client: &ClickHouseClient, sql: &str) -> reqwest::RequestBuilder {
    let database = client.database();
    let mut req = client
        .client
        .post(&client.base_url)
        .query(&[("database", database.as_str())])
        .body(sql.to_string());
    if let Some(user) = &client.user {
        req = req.header("X-ClickHouse-User", user);
    }
    if let Some(pw) = &client.password {
        req = req.header("X-ClickHouse-Key", pw);
    }
    req
}

/// POST a raw SQL string to the HTTP interface and return the response body.
async fn post_sql(
    client: &ClickHouseClient,
    sql: &str,
    token: Option<&CancellationToken>,
) -> Result<String, String> {
    let send = sql_request(client, sql).send();
    let resp = match token {
        Some(t) => tokio::select! {
            _ = t.cancelled() => return Err("Query cancelled".into()),
            r = send => r.map_err(|e| format!("ClickHouse request failed: {e}"))?,
        },
        None => send
            .await
            .map_err(|e| format!("ClickHouse request failed: {e}"))?,
    };
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("ClickHouse response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("ClickHouse error ({status}): {}", body.trim()));
    }
    Ok(body)
}

async fn post_sql_response(
    client: &ClickHouseClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<reqwest::Response, String> {
    let send = sql_request(client, sql).send();
    let resp = tokio::select! {
        _ = token.cancelled() => return Err("Query cancelled".into()),
        r = send => r.map_err(|e| format!("ClickHouse request failed: {e}"))?,
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp
            .text()
            .await
            .map_err(|e| format!("ClickHouse response read failed: {e}"))?;
        return Err(format!("ClickHouse error ({status}): {}", body.trim()));
    }
    Ok(resp)
}

pub async fn ping(client: &ClickHouseClient) -> Result<String, String> {
    post_sql(client, "SELECT 1", None).await?;
    Ok("ClickHouse connection OK".into())
}

// ClickHouse JSONCompact response shape.
#[derive(Deserialize)]
struct JsonCompactMeta {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
}

#[derive(Deserialize)]
struct JsonCompactResponse {
    #[serde(default)]
    meta: Vec<JsonCompactMeta>,
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows: u64,
}

fn json_cell_to_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn is_select(sql: &str) -> bool {
    let head: String = sql
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase();
    matches!(
        head.as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH" | "EXISTS"
    )
}

pub async fn execute(
    client: &ClickHouseClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_select(sql) {
        // Append the JSONCompact format unless the user already specified one.
        let has_format = sql.to_uppercase().contains("FORMAT ");
        let query = if has_format {
            sql.to_string()
        } else {
            format!("{sql} FORMAT JSONCompact")
        };
        let body = post_sql(client, &query, Some(token)).await?;
        if has_format {
            // Caller chose their own format; return the raw text in one cell.
            return Ok(QueryResult {
                columns: vec![ColumnInfo {
                    name: "result".into(),
                    type_name: "String".into(),
                }],
                rows: vec![vec![Some(body)]],
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            });
        }
        let parsed: JsonCompactResponse = serde_json::from_str(&body)
            .map_err(|e| format!("ClickHouse response parse failed: {e}"))?;
        let columns = parsed
            .meta
            .iter()
            .map(|m| ColumnInfo {
                name: m.name.clone(),
                type_name: m.type_name.clone(),
            })
            .collect();
        let rows = parsed
            .data
            .iter()
            .map(|row| row.iter().map(json_cell_to_string).collect())
            .collect();
        Ok(QueryResult {
            columns,
            rows,
            rows_affected: parsed.rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else if let Some(database) = sql::parse_default_schema_switch(sql) {
        // ClickHouse HTTP binds the default DB via the `database` query param
        // on every request, so a server-side USE would not stick. Switch the
        // client-side default instead.
        client.set_database(database);
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        // DDL/DML: ClickHouse returns an empty body on success.
        post_sql(client, sql, Some(token)).await?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

struct ClickHouseStreamState {
    names: Option<Vec<String>>,
    columns_sent: bool,
    row_count: u64,
    max_rows: Option<u64>,
    limit_reached: bool,
    batch: Vec<Vec<Option<String>>>,
}

impl ClickHouseStreamState {
    fn new(max_rows: Option<u64>) -> Self {
        Self {
            names: None,
            columns_sent: false,
            row_count: 0,
            max_rows: max_rows.filter(|value| *value > 0),
            limit_reached: false,
            batch: Vec::with_capacity(STREAM_BATCH_ROWS),
        }
    }

    fn process_line(&mut self, line: &[u8], on_event: &QueryStreamChannel) -> Result<bool, String> {
        let line = trim_json_line(line);
        if line.is_empty() {
            return Ok(true);
        }
        let values: Vec<serde_json::Value> = serde_json::from_slice(line)
            .map_err(|e| format!("ClickHouse stream parse failed: {e}"))?;
        if !self.columns_sent && self.names.is_none() {
            self.names = Some(values.into_iter().map(json_value_label).collect());
            return Ok(true);
        }
        if !self.columns_sent {
            let names = self.names.take().unwrap_or_default();
            let types: Vec<String> = values.into_iter().map(json_value_label).collect();
            let columns = names
                .into_iter()
                .enumerate()
                .map(|(i, name)| ColumnInfo {
                    name,
                    type_name: types.get(i).cloned().unwrap_or_else(|| "String".into()),
                })
                .collect();
            send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
            self.columns_sent = true;
            return Ok(true);
        }

        if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
            self.limit_reached = true;
            return Ok(false);
        }

        self.batch
            .push(values.iter().map(json_cell_to_string).collect());
        self.row_count += 1;
        if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
            self.limit_reached = true;
        }
        if self.batch.len() >= STREAM_BATCH_ROWS {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Rows {
                    rows: std::mem::take(&mut self.batch),
                },
            )?;
        }
        Ok(!self.limit_reached)
    }

    fn finish(self, on_event: &QueryStreamChannel, duration_ms: u64) -> Result<(), String> {
        if !self.batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: self.batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: self.row_count,
                duration_ms,
                warnings: match (self.limit_reached, self.max_rows) {
                    (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                    _ => Vec::new(),
                },
            },
        )
    }
}

fn trim_json_line(mut line: &[u8]) -> &[u8] {
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line = &line[..line.len() - 1];
    }
    line
}

fn json_value_label(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        other => json_cell_to_string(&other).unwrap_or_default(),
    }
}

pub async fn execute_stream(
    client: &ClickHouseClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_select(sql) {
        let has_format = sql.to_uppercase().contains("FORMAT ");
        if has_format {
            let result = execute(client, sql, token).await?;
            return emit_query_result_stream(on_event, result);
        }

        let query = format!("{sql} FORMAT JSONCompactEachRowWithNamesAndTypes");
        let resp = post_sql_response(client, &query, token).await?;
        let mut stream = resp.bytes_stream();
        let mut pending = Vec::<u8>::new();
        let mut state = ClickHouseStreamState::new(max_rows);

        loop {
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.next() => r,
            };
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk.map_err(|e| format!("ClickHouse response stream failed: {e}"))?;
            pending.extend_from_slice(&chunk);
            while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = pending.drain(..=pos).collect();
                if !state.process_line(&line, on_event)? {
                    pending.clear();
                    return state.finish(on_event, start.elapsed().as_millis() as u64);
                }
            }
        }

        if !pending.is_empty() {
            state.process_line(&pending, on_event)?;
        }
        state.finish(on_event, start.elapsed().as_millis() as u64)
    } else {
        post_sql(client, sql, Some(token)).await?;
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

pub async fn list_schemas(client: &ClickHouseClient) -> Result<Vec<SchemaInfo>, String> {
    let token = CancellationToken::new();
    let res = execute(
        client,
        "SELECT name FROM system.databases ORDER BY name",
        &token,
    )
    .await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|r| r.into_iter().next().flatten())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables(
    client: &ClickHouseClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let default_db = client.database();
    let db = schema.unwrap_or(default_db.as_str());
    let sql = format!(
        "SELECT name, engine, total_rows FROM system.tables WHERE database = '{}' ORDER BY name",
        db.replace('\'', "''")
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|r| {
            let name = r.first().cloned().flatten()?;
            let engine = r.get(1).cloned().flatten().unwrap_or_default();
            let row_count = r
                .get(2)
                .cloned()
                .flatten()
                .and_then(|value| value.parse::<i64>().ok());
            let kind = if engine.contains("MaterializedView") {
                "materialized_view"
            } else if engine.contains("View") {
                "view"
            } else {
                "table"
            };
            Some(TableInfo {
                name,
                kind: kind.to_string(),
                row_count,
            })
        })
        .collect())
}

pub async fn search_tables(
    client: &ClickHouseClient,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let default_db = client.database();
    let database = schema.unwrap_or(default_db.as_str()).replace('\'', "''");
    let prefix = prefix.replace('\\', "\\\\").replace('\'', "''");
    let sql = format!(
        "SELECT name, engine FROM system.tables \
         WHERE database = '{database}' AND positionCaseInsensitive(name, '{prefix}') = 1 \
         ORDER BY name LIMIT {limit}"
    );
    let token = CancellationToken::new();
    let result = execute(client, &sql, &token).await?;
    Ok(result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let engine = row.get(1).cloned().flatten().unwrap_or_default();
            let kind = if engine.contains("MaterializedView") {
                "materialized_view"
            } else if engine.contains("View") {
                "view"
            } else {
                "table"
            };
            Some(TableInfo {
                name,
                kind: kind.to_string(),
                row_count: None,
            })
        })
        .collect())
}

/// List ClickHouse dictionaries. Views / materialized views are surfaced via
/// `list_tables`; other object kinds do not exist in ClickHouse.
pub async fn list_objects(
    client: &ClickHouseClient,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    if kind != "dictionary" {
        return Ok(Vec::new());
    }
    let default_db = client.database();
    let db = schema.unwrap_or(default_db.as_str());
    let sql = format!(
        "SELECT name FROM system.dictionaries WHERE database = '{}' ORDER BY name",
        db.replace('\'', "''")
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|r| r.into_iter().next().flatten())
        .map(|name| DbObject {
            name,
            kind: "dictionary".to_string(),
            owner: None,
        })
        .collect())
}

/// `SHOW CREATE TABLE|DICTIONARY` for a ClickHouse object.
pub async fn object_ddl(
    client: &ClickHouseClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let default_db = client.database();
    let db = schema.unwrap_or(default_db.as_str());
    let verb = if kind == "dictionary" {
        "DICTIONARY"
    } else {
        "TABLE"
    };
    let sql = format!(
        "SHOW CREATE {verb} `{}`.`{}`",
        db.replace('`', "``"),
        name.replace('`', "``"),
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    res.rows
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .ok_or_else(|| format!("No DDL returned for {name}"))
}

/// Row / byte totals for a ClickHouse table from `system.parts`.
pub async fn table_stats(
    client: &ClickHouseClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let default_db = client.database();
    let db = schema.unwrap_or(default_db.as_str());
    let sql = format!(
        "SELECT sum(rows), sum(bytes_on_disk), count() FROM system.parts \
         WHERE database = '{}' AND table = '{}' AND active",
        db.replace('\'', "''"),
        table.replace('\'', "''"),
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    let r0 = res.rows.first();
    let get = |i: usize| r0.and_then(|r| r.get(i).cloned().flatten());
    Ok(super::metric_result(vec![
        ("Rows", get(0)),
        ("Bytes on disk", get(1)),
        ("Active parts", get(2)),
    ]))
}

pub async fn describe_table(
    client: &ClickHouseClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let default_db = client.database();
    let db = schema.unwrap_or(default_db.as_str());
    let sql = format!(
        "SELECT name, type, default_expression, is_in_primary_key \
         FROM system.columns WHERE database = '{}' AND table = '{}' ORDER BY position",
        db.replace('\'', "''"),
        table.replace('\'', "''"),
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|r| {
            let name = r.first().cloned().flatten()?;
            let type_name = r.get(1).cloned().flatten().unwrap_or_default();
            let default = r.get(2).cloned().flatten().filter(|s| !s.is_empty());
            let is_pk = r.get(3).cloned().flatten().unwrap_or_default();
            // Nullable(...) types are nullable.
            let nullable = type_name.contains("Nullable(");
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key: is_pk == "1",
            })
        })
        .collect())
}
