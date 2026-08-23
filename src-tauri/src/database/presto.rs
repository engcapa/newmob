//! Presto/Trino backend over the HTTP statement API. The client follows the
//! `/v1/statement` response `nextUri` chain and translates JSON rows into the
//! same string/null grid shape used by the other SQL engines.
//!
//! Header dialect is selected per connection: Presto uses `X-Presto-*` while
//! Trino uses `X-Trino-*` (see `DbConfig.presto_dialect`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::HeaderMap;
use serde::Deserialize;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::{
    CatalogInfo, ColumnDescription, ColumnInfo, DbConfig, DbHandle, DbObject, IndexInfo,
    QueryResult, QueryStreamChannel, QueryStreamEvent, SchemaInfo, TableInfo,
    send_query_stream_event,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;
const DEFAULT_PRESTO_USER: &str = "taomni";
const HEADER_PREFIX_PRESTO: &str = "X-Presto";
const HEADER_PREFIX_TRINO: &str = "X-Trino";

/// Precomputed protocol header names for either the Presto or Trino dialect.
#[derive(Clone, Copy)]
struct ProtocolHeaders {
    /// Display / User-Agent label: "Presto" or "Trino".
    engine_label: &'static str,
    user: &'static str,
    source: &'static str,
    catalog: &'static str,
    schema: &'static str,
    set_catalog: &'static str,
    set_schema: &'static str,
}

const PRESTO_HEADERS: ProtocolHeaders = ProtocolHeaders {
    engine_label: "Presto",
    user: "X-Presto-User",
    source: "X-Presto-Source",
    catalog: "X-Presto-Catalog",
    schema: "X-Presto-Schema",
    set_catalog: "X-Presto-Set-Catalog",
    set_schema: "X-Presto-Set-Schema",
};

const TRINO_HEADERS: ProtocolHeaders = ProtocolHeaders {
    engine_label: "Trino",
    user: "X-Trino-User",
    source: "X-Trino-Source",
    catalog: "X-Trino-Catalog",
    schema: "X-Trino-Schema",
    set_catalog: "X-Trino-Set-Catalog",
    set_schema: "X-Trino-Set-Schema",
};

/// Resolve protocol headers from connect config.
/// Missing / unknown values default to Presto for backward compatibility.
fn protocol_headers_from_dialect(dialect: Option<&str>) -> ProtocolHeaders {
    match dialect.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.eq_ignore_ascii_case("trino") => TRINO_HEADERS,
        _ => PRESTO_HEADERS,
    }
}

/// Resolve the HTTP header prefix from connect config (test/helpers).
fn header_prefix_from_dialect(dialect: Option<&str>) -> &'static str {
    if protocol_headers_from_dialect(dialect).engine_label == "Trino" {
        HEADER_PREFIX_TRINO
    } else {
        HEADER_PREFIX_PRESTO
    }
}

#[derive(Clone)]
pub struct PrestoClient {
    client: reqwest::Client,
    base_url: String,
    user: String,
    password: Option<String>,
    /// Presto (`X-Presto-*`) or Trino (`X-Trino-*`) protocol header set.
    headers: ProtocolHeaders,
    catalog: Arc<AsyncMutex<Option<String>>>,
    schema: Arc<AsyncMutex<Option<String>>>,
    current_next_uri: Arc<AsyncMutex<Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoColumn {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoResults {
    #[serde(default)]
    next_uri: Option<String>,
    #[serde(default)]
    columns: Vec<PrestoColumn>,
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    update_count: Option<u64>,
    #[serde(default)]
    error: Option<PrestoError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoError {
    message: String,
    #[serde(default)]
    error_name: Option<String>,
    #[serde(default)]
    error_location: Option<PrestoErrorLocation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoErrorLocation {
    line_number: u64,
    column_number: u64,
}

struct StatementOutcome {
    result: QueryResult,
}

struct StreamState {
    columns_sent: bool,
    row_count: u64,
    rows_affected: u64,
    max_rows: Option<u64>,
    limit_reached: bool,
    batch: Vec<Vec<Option<String>>>,
}

impl StreamState {
    fn new(max_rows: Option<u64>) -> Self {
        Self {
            columns_sent: false,
            row_count: 0,
            rows_affected: 0,
            max_rows: max_rows.filter(|value| *value > 0),
            limit_reached: false,
            batch: Vec::with_capacity(STREAM_BATCH_ROWS),
        }
    }

    fn consume_results(
        &mut self,
        results: PrestoResults,
        on_event: &QueryStreamChannel,
    ) -> Result<bool, String> {
        if let Some(error) = results.error {
            return Err(format_presto_error(error));
        }
        if let Some(update_count) = results.update_count {
            self.rows_affected = update_count;
        }
        if !self.columns_sent && !results.columns.is_empty() {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Columns {
                    columns: presto_columns(results.columns),
                },
            )?;
            self.columns_sent = true;
        }
        for row in results.data {
            if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
                self.limit_reached = true;
                return Ok(false);
            }
            self.batch
                .push(row.iter().map(json_cell_to_string).collect());
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
        }
        Ok(!self.limit_reached)
    }

    fn finish(mut self, on_event: &QueryStreamChannel, duration_ms: u64) -> Result<(), String> {
        if !self.batch.is_empty() {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Rows {
                    rows: std::mem::take(&mut self.batch),
                },
            )?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: self.rows_affected,
                duration_ms,
                warnings: match (self.limit_reached, self.max_rows) {
                    (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                    _ => Vec::new(),
                },
            },
        )
    }
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let scheme = if config.ssl { "https" } else { "http" };
    let base_url = format!("{scheme}://{}:{}", config.host, config.port);
    let timeout = Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    });
    // reqwest enables implicit system-proxy detection by default
    // (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY env vars, plus the Windows/macOS system
    // proxy a corporate VPN installs). DB routing is explicit: a per-session
    // proxy/jump host is handled upstream by `forward.rs` via a loopback
    // forwarder, so this client always dials directly. Disable the implicit
    // layer so an ambient VPN/shell proxy can't silently reroute `/v1/statement`
    // and turn a healthy Trino into a 502 from some gateway that can't reach it.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Presto client build failed: {e}"))?;
    let presto = PrestoClient {
        client,
        base_url,
        user: config
            .username
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| DEFAULT_PRESTO_USER.to_string()),
        password: password.map(|value| value.to_string()),
        headers: protocol_headers_from_dialect(config.presto_dialect.as_deref()),
        catalog: Arc::new(AsyncMutex::new(
            config.catalog.clone().filter(|value| !value.is_empty()),
        )),
        schema: Arc::new(AsyncMutex::new(
            config.database.clone().filter(|value| !value.is_empty()),
        )),
        current_next_uri: Arc::new(AsyncMutex::new(None)),
    };
    ping(&presto).await?;
    Ok(DbHandle::Presto(presto))
}

async fn request_context(client: &PrestoClient) -> (Option<String>, Option<String>) {
    let catalog = client.catalog.lock().await.clone();
    let schema = client.schema.lock().await.clone();
    (catalog, schema)
}

async fn request_context_with_overrides(
    client: &PrestoClient,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> (Option<String>, Option<String>) {
    let (catalog, schema) = request_context(client).await;
    let catalog = catalog_override
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(catalog);
    let schema = schema_override
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(schema);
    (catalog, schema)
}

fn add_presto_headers(
    client: &PrestoClient,
    mut req: reqwest::RequestBuilder,
    catalog: Option<&str>,
    schema: Option<&str>,
) -> reqwest::RequestBuilder {
    let h = client.headers;
    req = req
        .header(h.user, client.user.as_str())
        .header(h.source, "taomni")
        .header("User-Agent", format!("Taomni {} Client", h.engine_label));
    if let Some(catalog) = catalog.filter(|value| !value.is_empty()) {
        req = req.header(h.catalog, catalog);
    }
    if let Some(schema) = schema.filter(|value| !value.is_empty()) {
        req = req.header(h.schema, schema);
    }
    if let Some(password) = &client.password {
        req = req.basic_auth(client.user.as_str(), Some(password));
    }
    req
}

async fn apply_session_headers(client: &PrestoClient, headers: &HeaderMap) {
    let h = client.headers;
    if let Some(catalog) = header_string(headers, h.set_catalog) {
        *client.catalog.lock().await = Some(catalog);
    }
    if let Some(schema) = header_string(headers, h.set_schema) {
        *client.schema.lock().await = Some(schema);
    }
}

fn header_string(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

async fn read_results_response(
    client: &PrestoClient,
    resp: reqwest::Response,
) -> Result<PrestoResults, String> {
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Presto response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Presto error ({status}): {}", body.trim()));
    }
    apply_session_headers(client, &headers).await;
    let results: PrestoResults =
        serde_json::from_str(&body).map_err(|e| format!("Presto response parse failed: {e}"))?;
    Ok(results)
}

fn normalize_presto_statement(sql: &str) -> Result<String, String> {
    let mut statements = split_presto_statements(sql);
    match statements.len() {
        0 => Err("Presto SQL statement is empty".into()),
        1 => Ok(statements.remove(0)),
        _ => Err(
            "Presto accepts one SQL statement per HTTP request; split scripts before executing."
                .into(),
        ),
    }
}

fn split_presto_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut chars = sql.chars().peekable();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(ch) = chars.next() {
        if line_comment {
            current.push(ch);
            if ch == '\n' {
                line_comment = false;
            }
            continue;
        }

        if block_comment {
            current.push(ch);
            if ch == '*' && matches!(chars.peek(), Some('/')) {
                current.push('/');
                chars.next();
                block_comment = false;
            }
            continue;
        }

        if single_quoted {
            current.push(ch);
            if ch == '\'' {
                if matches!(chars.peek(), Some('\'')) {
                    current.push('\'');
                    chars.next();
                } else {
                    single_quoted = false;
                }
            }
            continue;
        }

        if double_quoted {
            current.push(ch);
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    current.push('"');
                    chars.next();
                } else {
                    double_quoted = false;
                }
            }
            continue;
        }

        match ch {
            '-' if matches!(chars.peek(), Some('-')) => {
                current.push(ch);
                current.push('-');
                chars.next();
                line_comment = true;
            }
            '/' if matches!(chars.peek(), Some('*')) => {
                current.push(ch);
                current.push('*');
                chars.next();
                block_comment = true;
            }
            '\'' => {
                current.push(ch);
                single_quoted = true;
            }
            '"' => {
                current.push(ch);
                double_quoted = true;
            }
            ';' => push_presto_statement(&mut statements, &mut current),
            _ => current.push(ch),
        }
    }

    push_presto_statement(&mut statements, &mut current);
    statements
}

fn push_presto_statement(statements: &mut Vec<String>, current: &mut String) {
    let statement = current.trim();
    if !statement.is_empty() && has_executable_presto_sql(statement) {
        statements.push(statement.to_string());
    }
    current.clear();
}

fn has_executable_presto_sql(statement: &str) -> bool {
    let mut chars = statement.chars().peekable();
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(ch) = chars.next() {
        if line_comment {
            if ch == '\n' {
                line_comment = false;
            }
            continue;
        }
        if block_comment {
            if ch == '*' && matches!(chars.peek(), Some('/')) {
                chars.next();
                block_comment = false;
            }
            continue;
        }
        if ch.is_whitespace() {
            continue;
        }
        match ch {
            '-' if matches!(chars.peek(), Some('-')) => {
                chars.next();
                line_comment = true;
            }
            '/' if matches!(chars.peek(), Some('*')) => {
                chars.next();
                block_comment = true;
            }
            _ => return true,
        }
    }
    false
}

async fn post_statement(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<PrestoResults, String> {
    post_statement_with_context(client, sql, token, track_cancel, None, None).await
}

async fn post_statement_with_context(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
    track_cancel: bool,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> Result<PrestoResults, String> {
    let statement = normalize_presto_statement(sql)?;
    let (catalog, schema) =
        request_context_with_overrides(client, catalog_override, schema_override).await;
    let req = add_presto_headers(
        client,
        client
            .client
            .post(format!("{}/v1/statement", client.base_url))
            .body(statement),
        catalog.as_deref(),
        schema.as_deref(),
    );
    let send = req.send();
    let resp = tokio::select! {
        _ = token.cancelled() => {
            cancel_current(client).await;
            return Err("Query cancelled".into());
        }
        r = send => r.map_err(|e| format!("Presto request failed: {e}"))?,
    };
    let results = read_results_response(client, resp).await?;
    if track_cancel {
        set_current_next_uri(client, results.next_uri.as_deref()).await;
    }
    Ok(results)
}

async fn get_next(
    client: &PrestoClient,
    uri: &str,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<PrestoResults, String> {
    get_next_with_context(client, uri, token, track_cancel, None, None).await
}

async fn get_next_with_context(
    client: &PrestoClient,
    uri: &str,
    token: &CancellationToken,
    track_cancel: bool,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> Result<PrestoResults, String> {
    let (catalog, schema) =
        request_context_with_overrides(client, catalog_override, schema_override).await;
    let req = add_presto_headers(
        client,
        client.client.get(uri),
        catalog.as_deref(),
        schema.as_deref(),
    );
    let send = req.send();
    let resp = tokio::select! {
        _ = token.cancelled() => {
            cancel_current(client).await;
            return Err("Query cancelled".into());
        }
        r = send => r.map_err(|e| format!("Presto request failed: {e}"))?,
    };
    let results = read_results_response(client, resp).await?;
    if track_cancel {
        set_current_next_uri(client, results.next_uri.as_deref()).await;
    }
    Ok(results)
}

async fn set_current_next_uri(client: &PrestoClient, next_uri: Option<&str>) {
    *client.current_next_uri.lock().await = next_uri.map(ToOwned::to_owned);
}

async fn cancel_current(client: &PrestoClient) {
    let uri = client.current_next_uri.lock().await.clone();
    if let Some(uri) = uri {
        let _ = delete_uri(client, &uri).await;
    }
}

async fn delete_uri(client: &PrestoClient, uri: &str) -> Result<(), String> {
    let (catalog, schema) = request_context(client).await;
    let req = add_presto_headers(
        client,
        client.client.delete(uri),
        catalog.as_deref(),
        schema.as_deref(),
    );
    req.send()
        .await
        .map_err(|e| format!("Presto cancel failed: {e}"))?;
    Ok(())
}

fn presto_columns(columns: Vec<PrestoColumn>) -> Vec<ColumnInfo> {
    columns
        .into_iter()
        .map(|column| ColumnInfo {
            name: column.name,
            type_name: column.type_name,
        })
        .collect()
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

fn format_presto_error(error: PrestoError) -> String {
    let mut message = error.message;
    if let Some(name) = error.error_name {
        message = format!("{name}: {message}");
    }
    if let Some(location) = error.error_location {
        message = format!(
            "{message} at line {}, column {}",
            location.line_number, location.column_number
        );
    }
    message
}

async fn run_statement(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<StatementOutcome, String> {
    run_statement_with_context(client, sql, max_rows, token, track_cancel, None, None).await
}

async fn run_statement_with_context(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    track_cancel: bool,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> Result<StatementOutcome, String> {
    let start = Instant::now();
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut rows_affected = 0_u64;
    let mut limit_reached = false;
    let max_rows = max_rows.filter(|value| *value > 0);

    let first = post_statement_with_context(
        client,
        sql,
        token,
        track_cancel,
        catalog_override,
        schema_override,
    )
    .await?;
    if let Some(error) = first.error {
        return Err(format_presto_error(error));
    }
    if !first.columns.is_empty() {
        columns = presto_columns(first.columns);
    }
    if let Some(update_count) = first.update_count {
        rows_affected = update_count;
    }
    for row in first.data {
        if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
            limit_reached = true;
            break;
        }
        rows.push(row.iter().map(json_cell_to_string).collect());
    }
    let mut next = first.next_uri;

    while let Some(uri) = next {
        if limit_reached {
            delete_uri(client, &uri).await?;
            break;
        }
        let result = get_next_with_context(
            client,
            &uri,
            token,
            track_cancel,
            catalog_override,
            schema_override,
        )
        .await?;
        if let Some(error) = result.error {
            return Err(format_presto_error(error));
        }
        if columns.is_empty() && !result.columns.is_empty() {
            columns = presto_columns(result.columns);
        }
        if let Some(update_count) = result.update_count {
            rows_affected = update_count;
        }
        for row in result.data {
            if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
                limit_reached = true;
                break;
            }
            rows.push(row.iter().map(json_cell_to_string).collect());
        }
        next = result.next_uri;
    }

    if track_cancel {
        set_current_next_uri(client, None).await;
    }
    Ok(StatementOutcome {
        result: QueryResult {
            columns,
            rows,
            rows_affected,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: match (limit_reached, max_rows) {
                (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                _ => Vec::new(),
            },
        },
    })
}

pub async fn ping(client: &PrestoClient) -> Result<String, String> {
    let token = CancellationToken::new();
    run_statement(client, "SELECT 1", Some(1), &token, false).await?;
    Ok("Presto connection OK".into())
}

pub async fn execute(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let result = run_statement(client, sql, None, token, true).await?.result;
    apply_use_statement_hint(client, sql).await;
    Ok(result)
}

pub async fn execute_stream(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    let mut state = StreamState::new(max_rows);
    let first = post_statement(client, sql, token, true).await?;
    let mut next = first.next_uri.clone();
    if !state.consume_results(first, on_event)? {
        if let Some(uri) = next {
            delete_uri(client, &uri).await?;
        }
        set_current_next_uri(client, None).await;
        return state.finish(on_event, start.elapsed().as_millis() as u64);
    }

    while let Some(uri) = next {
        let result = get_next(client, &uri, token, true).await?;
        next = result.next_uri.clone();
        if !state.consume_results(result, on_event)? {
            if let Some(uri) = next {
                delete_uri(client, &uri).await?;
            }
            break;
        }
    }

    set_current_next_uri(client, None).await;
    apply_use_statement_hint(client, sql).await;
    state.finish(on_event, start.elapsed().as_millis() as u64)
}

fn quote_presto_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[cfg(test)]
fn quote_presto_qualified(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| quote_presto_ident(part))
        .collect::<Vec<_>>()
        .join(".")
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn apply_use_statement_hint(client: &PrestoClient, sql: &str) {
    let Some(parts) = parse_use_parts(sql) else {
        return;
    };
    if let Some(schema) = parts.last().filter(|value| !value.is_empty()) {
        *client.schema.lock().await = Some(schema.clone());
    }
    if parts.len() >= 2 {
        if let Some(catalog) = parts.get(parts.len() - 2).filter(|value| !value.is_empty()) {
            *client.catalog.lock().await = Some(catalog.clone());
        }
    }
}

fn parse_use_parts(sql: &str) -> Option<Vec<String>> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let rest = trimmed
        .get(..3)
        .filter(|head| head.eq_ignore_ascii_case("USE"))
        .and_then(|_| trimmed.get(3..))?
        .trim();
    if rest.is_empty() {
        return None;
    }
    let parts = split_qualified_ident(rest);
    if parts.is_empty() { None } else { Some(parts) }
}

fn split_qualified_ident(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quoted = false;

    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    current.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' => quoted = true,
            '.' => {
                let part = current.trim().to_string();
                if !part.is_empty() {
                    parts.push(part);
                }
                current.clear();
            }
            c if c.is_whitespace() => {
                if !current.trim().is_empty() {
                    current.push(c);
                }
            }
            _ => current.push(ch),
        }
    }

    let part = current.trim().to_string();
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}

async fn current_catalog(client: &PrestoClient) -> Result<String, String> {
    client
        .catalog
        .lock()
        .await
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Presto catalog is required for schema browsing. Set the Catalog field in this session."
                .to_string()
        })
}

fn table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub async fn list_catalogs(client: &PrestoClient) -> Result<Vec<CatalogInfo>, String> {
    let token = CancellationToken::new();
    let res = run_statement(client, "SHOW CATALOGS", None, &token, false)
        .await?
        .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().flatten())
        .map(|name| CatalogInfo { name })
        .collect())
}

pub async fn list_schemas(
    client: &PrestoClient,
    catalog: Option<&str>,
) -> Result<Vec<SchemaInfo>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let token = CancellationToken::new();
    let res = run_statement_with_context(
        client,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name <> 'information_schema' ORDER BY schema_name",
        None,
        &token,
        false,
        Some(&catalog),
        None,
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().flatten())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables(
    client: &PrestoClient,
    catalog: Option<&str>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table browsing. Select a schema first.".to_string()
        })?,
    };
    let sql = format!(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = {} ORDER BY table_name",
        sql_literal(&schema)
    );
    let token = CancellationToken::new();
    let res = run_statement_with_context(
        client,
        &sql,
        None,
        &token,
        false,
        Some(&catalog),
        Some(&schema),
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let kind = row
                .get(1)
                .cloned()
                .flatten()
                .map(|value| table_kind(&value))
                .unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn search_tables(
    client: &PrestoClient,
    catalog: Option<&str>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table completion. Select a schema first.".to_string()
        })?,
    };
    let prefix = sql_literal(prefix);
    let sql = format!(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = {} \
           AND substr(lower(table_name), 1, length(lower({prefix}))) = lower({prefix}) \
         ORDER BY table_name LIMIT {limit}",
        sql_literal(&schema),
    );
    let token = CancellationToken::new();
    let result = run_statement_with_context(
        client,
        &sql,
        None,
        &token,
        false,
        Some(&catalog),
        Some(&schema),
    )
    .await?
    .result;
    Ok(result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let kind = row
                .get(1)
                .cloned()
                .flatten()
                .map(|value| table_kind(&value))
                .unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table(
    client: &PrestoClient,
    catalog: Option<&str>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table description. Select a schema first.".to_string()
        })?,
    };
    let sql = format!(
        "SELECT column_name, data_type, is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = {} AND table_name = {} \
         ORDER BY ordinal_position",
        sql_literal(&schema),
        sql_literal(table),
    );
    let token = CancellationToken::new();
    let res = run_statement_with_context(
        client,
        &sql,
        None,
        &token,
        false,
        Some(&catalog),
        Some(&schema),
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let type_name = row.get(1).cloned().flatten().unwrap_or_default();
            let nullable = row
                .get(2)
                .cloned()
                .flatten()
                .is_some_and(|value| value.eq_ignore_ascii_case("YES"));
            let default = row.get(3).cloned().flatten();
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key: false,
            })
        })
        .collect())
}

pub async fn list_indexes(
    _client: &PrestoClient,
    _schema: Option<&str>,
    _table: &str,
) -> Result<Vec<IndexInfo>, String> {
    Ok(Vec::new())
}

/// Presto/Trino catalogs expose only tables and views (surfaced via
/// `list_tables`); there are no routine-style schema objects to list.
pub async fn list_objects(
    _client: &PrestoClient,
    _schema: Option<&str>,
    _kind: &str,
) -> Result<Vec<DbObject>, String> {
    Ok(Vec::new())
}

/// Resolve the effective catalog + schema and build a quoted qualified name.
async fn presto_qualified(
    client: &PrestoClient,
    schema: Option<&str>,
    name: &str,
) -> Result<String, String> {
    let catalog = current_catalog(client).await?;
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client
            .schema
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Presto schema is required. Select a schema first.".to_string())?,
    };
    Ok(format!(
        "{}.{}.{}",
        quote_presto_ident(&catalog),
        quote_presto_ident(&schema),
        quote_presto_ident(name)
    ))
}

pub async fn object_ddl(
    client: &PrestoClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let qualified = presto_qualified(client, schema, name).await?;
    let verb = if kind == "view" { "VIEW" } else { "TABLE" };
    let sql = format!("SHOW CREATE {verb} {qualified}");
    let token = CancellationToken::new();
    let res = run_statement(client, &sql, None, &token, false)
        .await?
        .result;
    res.rows
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .ok_or_else(|| format!("No DDL returned for {name}"))
}

pub async fn table_stats(
    client: &PrestoClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let qualified = presto_qualified(client, schema, table).await?;
    let sql = format!("SHOW STATS FOR {qualified}");
    let token = CancellationToken::new();
    Ok(run_statement(client, &sql, None, &token, false)
        .await?
        .result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    struct ExpectedRequest {
        method: &'static str,
        path: String,
        body_contains: Option<&'static str>,
        body_equals: Option<&'static str>,
        headers: Vec<(&'static str, &'static str)>,
        /// Optional response headers (e.g. X-Trino-Set-Catalog) returned before the body.
        response_headers: Vec<(&'static str, &'static str)>,
        response_body: String,
    }

    async fn read_request(stream: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        let header_end;
        loop {
            let n = stream.read(&mut tmp).await.unwrap();
            assert!(n > 0, "connection closed before request headers");
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = find_bytes(&buf, b"\r\n\r\n") {
                header_end = pos + 4;
                break;
            }
        }
        let request_head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let content_length = request_head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while buf.len() < header_end + content_length {
            let n = stream.read(&mut tmp).await.unwrap();
            assert!(n > 0, "connection closed before request body");
            buf.extend_from_slice(&tmp[..n]);
        }
        String::from_utf8(buf).unwrap()
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|value| value == needle)
    }

    fn request_body(request: &str) -> &str {
        request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    fn header_value<'a>(request: &'a str, key: &str) -> Option<&'a str> {
        request.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case(key).then(|| value.trim())
        })
    }

    async fn serve_expected_requests(listener: TcpListener, expected: Vec<ExpectedRequest>) {
        let mut expected = VecDeque::from(expected);
        while let Some(expected) = expected.pop_front() {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            let request_line = request.lines().next().unwrap_or_default();
            assert!(
                request_line.starts_with(&format!("{} {} ", expected.method, expected.path)),
                "unexpected request line: {request_line}"
            );
            for (key, value) in expected.headers {
                assert_eq!(header_value(&request, key), Some(value), "header {key}");
            }
            if let Some(body_part) = expected.body_contains {
                assert!(
                    request_body(&request).contains(body_part),
                    "request body did not contain {body_part:?}: {}",
                    request_body(&request)
                );
            }
            if let Some(body) = expected.body_equals {
                assert_eq!(request_body(&request), body);
            }
            let mut response =
                String::from("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n");
            for (key, value) in &expected.response_headers {
                response.push_str(&format!("{key}: {value}\r\n"));
            }
            response.push_str(&format!(
                "Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                expected.response_body.len(),
                expected.response_body
            ));
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    }

    fn test_client(base_url: String) -> PrestoClient {
        test_client_with_headers(base_url, PRESTO_HEADERS)
    }

    fn test_client_with_headers(base_url: String, headers: ProtocolHeaders) -> PrestoClient {
        PrestoClient {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .no_proxy()
                .build()
                .unwrap(),
            base_url,
            user: "analyst".to_string(),
            password: None,
            headers,
            catalog: Arc::new(AsyncMutex::new(Some("hive".to_string()))),
            schema: Arc::new(AsyncMutex::new(Some("sales".to_string()))),
            current_next_uri: Arc::new(AsyncMutex::new(None)),
        }
    }

    #[test]
    fn presto_identifier_quoting_escapes_double_quotes() {
        assert_eq!(quote_presto_ident("te\"st"), "\"te\"\"st\"");
        assert_eq!(
            quote_presto_qualified(&["hive", "sales", "or\"ders"]),
            "\"hive\".\"sales\".\"or\"\"ders\""
        );
    }

    #[test]
    fn json_cells_render_as_nullable_strings() {
        assert_eq!(json_cell_to_string(&serde_json::Value::Null), None);
        assert_eq!(
            json_cell_to_string(&serde_json::json!({"a": 1})),
            Some("{\"a\":1}".to_string())
        );
        assert_eq!(
            json_cell_to_string(&serde_json::json!(["x", 2])),
            Some("[\"x\",2]".to_string())
        );
    }

    #[test]
    fn presto_error_includes_name_and_location() {
        let error = PrestoError {
            message: "bad query".to_string(),
            error_name: Some("SYNTAX_ERROR".to_string()),
            error_location: Some(PrestoErrorLocation {
                line_number: 3,
                column_number: 7,
            }),
        };
        assert_eq!(
            format_presto_error(error),
            "SYNTAX_ERROR: bad query at line 3, column 7"
        );
    }

    #[test]
    fn use_statement_parser_handles_quoted_catalog_schema() {
        assert_eq!(
            parse_use_parts("USE \"hive\".\"sales\";"),
            Some(vec!["hive".to_string(), "sales".to_string()])
        );
        assert_eq!(
            parse_use_parts("use tpch.tiny"),
            Some(vec!["tpch".to_string(), "tiny".to_string()])
        );
        assert_eq!(parse_use_parts("SELECT 1"), None);
    }

    #[test]
    fn presto_statement_splitter_ignores_semicolons_inside_strings_and_comments() {
        assert_eq!(
            split_presto_statements(
                "SELECT ';' AS literal -- comment ; ignored\nFROM t;\n\
                 /* comment ; ignored */ SELECT 'it''s; ok';"
            ),
            vec![
                "SELECT ';' AS literal -- comment ; ignored\nFROM t".to_string(),
                "/* comment ; ignored */ SELECT 'it''s; ok'".to_string(),
            ]
        );
        assert_eq!(
            split_presto_statements("; /* comment only */ ; -- trailing"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn presto_statement_normalization_requires_one_statement() {
        assert_eq!(
            normalize_presto_statement("SELECT 1; -- trailing comment").unwrap(),
            "SELECT 1"
        );
        assert!(normalize_presto_statement("SELECT 1; SELECT 2").is_err());
    }

    #[tokio::test]
    async fn execute_posts_statement_and_polls_next_uri() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let next_path = "/v1/statement/query-1/1";
        let next_uri = format!("{base_url}{next_path}");
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("SELECT * FROM orders"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: format!(
                        r#"{{"id":"query-1","columns":[{{"name":"id","type":"bigint"}}],"data":[[1]],"nextUri":"{next_uri}"}}"#
                    ),
                },
                ExpectedRequest {
                    method: "GET",
                    path: next_path.to_string(),
                    body_contains: None,
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"query-1","data":[[2]]}"#.to_string(),
                },
            ],
        ));
        let token = CancellationToken::new();

        let result = execute(&test_client(base_url), "SELECT * FROM orders", &token)
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, "id");
        assert_eq!(
            result.rows,
            vec![vec![Some("1".to_string())], vec![Some("2".to_string())]]
        );
        assert_eq!(result.rows_affected, 0);
    }

    #[tokio::test]
    async fn execute_posts_single_statement_without_outer_semicolon() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: None,
                body_equals: Some("SELECT 1"),
                headers: vec![
                    ("X-Presto-User", "analyst"),
                    ("X-Presto-Catalog", "hive"),
                    ("X-Presto-Schema", "sales"),
                ],
                response_headers: Vec::new(),
                response_body:
                    r#"{"id":"query-1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                        .to_string(),
            }],
        ));
        let token = CancellationToken::new();

        let result = execute(
            &test_client(base_url),
            "SELECT 1; -- trailing comment",
            &token,
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(result.rows, vec![vec![Some("1".to_string())]]);
    }

    #[tokio::test]
    async fn metadata_calls_use_catalog_context() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: None,
                    body_equals: Some("SHOW CATALOGS"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"catalogs","data":[["hive"],["iceberg"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("information_schema.schemata"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"schemas","data":[["marketing"],["sales"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("table_schema = 'sales'"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"tables","data":[["orders","BASE TABLE"],["orders_v","VIEW"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("table_name = 'orders'"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"columns","data":[["id","bigint","NO",null],["note","varchar","YES","'new'"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("information_schema.schemata"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "iceberg"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"iceberg-schemas","data":[["lake"]]}"#
                        .to_string(),
                },
            ],
        ));
        let client = test_client(base_url);

        let catalogs = list_catalogs(&client).await.unwrap();
        let schemas = list_schemas(&client, None).await.unwrap();
        let tables = list_tables(&client, None, Some("sales")).await.unwrap();
        let columns = describe_table(&client, None, Some("sales"), "orders")
            .await
            .unwrap();
        let iceberg_schemas = list_schemas(&client, Some("iceberg")).await.unwrap();
        server.await.unwrap();

        assert_eq!(
            catalogs
                .into_iter()
                .map(|catalog| catalog.name)
                .collect::<Vec<_>>(),
            vec!["hive", "iceberg"]
        );
        assert_eq!(
            schemas
                .into_iter()
                .map(|schema| schema.name)
                .collect::<Vec<_>>(),
            vec!["marketing", "sales"]
        );
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].name, "orders");
        assert_eq!(tables[0].kind, "table");
        assert_eq!(tables[1].name, "orders_v");
        assert_eq!(tables[1].kind, "view");
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].type_name, "bigint");
        assert!(!columns[0].nullable);
        assert_eq!(columns[1].name, "note");
        assert!(columns[1].nullable);
        assert_eq!(columns[1].default.as_deref(), Some("'new'"));
        assert_eq!(iceberg_schemas[0].name, "lake");
    }

    #[test]
    fn header_prefix_from_dialect_defaults_to_presto() {
        assert_eq!(header_prefix_from_dialect(None), HEADER_PREFIX_PRESTO);
        assert_eq!(header_prefix_from_dialect(Some("")), HEADER_PREFIX_PRESTO);
        assert_eq!(
            header_prefix_from_dialect(Some("presto")),
            HEADER_PREFIX_PRESTO
        );
        assert_eq!(
            header_prefix_from_dialect(Some("Presto")),
            HEADER_PREFIX_PRESTO
        );
        assert_eq!(
            header_prefix_from_dialect(Some("unknown")),
            HEADER_PREFIX_PRESTO
        );
        assert_eq!(
            header_prefix_from_dialect(Some("trino")),
            HEADER_PREFIX_TRINO
        );
        assert_eq!(
            header_prefix_from_dialect(Some("TRINO")),
            HEADER_PREFIX_TRINO
        );
        assert_eq!(
            header_prefix_from_dialect(Some("  trino  ")),
            HEADER_PREFIX_TRINO
        );
    }

    #[tokio::test]
    async fn trino_dialect_sends_x_trino_headers_on_post_and_poll() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let next_path = "/v1/statement/query-trino/1";
        let next_uri = format!("{base_url}{next_path}");
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("SELECT * FROM orders"),
                    body_equals: None,
                    headers: vec![
                        ("X-Trino-User", "analyst"),
                        ("X-Trino-Catalog", "hive"),
                        ("X-Trino-Schema", "sales"),
                        ("X-Trino-Source", "taomni"),
                    ],
                    response_headers: Vec::new(),
                    response_body: format!(
                        r#"{{"id":"query-trino","columns":[{{"name":"id","type":"bigint"}}],"data":[[10]],"nextUri":"{next_uri}"}}"#
                    ),
                },
                ExpectedRequest {
                    method: "GET",
                    path: next_path.to_string(),
                    body_contains: None,
                    body_equals: None,
                    headers: vec![
                        ("X-Trino-User", "analyst"),
                        ("X-Trino-Catalog", "hive"),
                        ("X-Trino-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"query-trino","data":[[11]]}"#.to_string(),
                },
            ],
        ));
        let token = CancellationToken::new();
        let client = test_client_with_headers(base_url, TRINO_HEADERS);

        let result = execute(&client, "SELECT * FROM orders", &token)
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(
            result.rows,
            vec![vec![Some("10".to_string())], vec![Some("11".to_string())]]
        );
        assert_eq!(client.headers.engine_label, "Trino");
        assert_eq!(client.headers.user, "X-Trino-User");
    }

    #[tokio::test]
    async fn trino_set_catalog_and_schema_response_headers_update_client() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: None,
                    body_equals: Some("SELECT 1"),
                    headers: vec![
                        ("X-Trino-User", "analyst"),
                        ("X-Trino-Catalog", "hive"),
                        ("X-Trino-Schema", "sales"),
                    ],
                    response_headers: vec![
                        ("X-Trino-Set-Catalog", "iceberg"),
                        ("X-Trino-Set-Schema", "analytics"),
                    ],
                    response_body:
                        r#"{"id":"q1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                            .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: None,
                    body_equals: Some("SELECT 2"),
                    headers: vec![
                        ("X-Trino-User", "analyst"),
                        ("X-Trino-Catalog", "iceberg"),
                        ("X-Trino-Schema", "analytics"),
                    ],
                    response_headers: Vec::new(),
                    response_body:
                        r#"{"id":"q2","columns":[{"name":"_col0","type":"integer"}],"data":[[2]]}"#
                            .to_string(),
                },
            ],
        ));
        let token = CancellationToken::new();
        let client = test_client_with_headers(base_url, TRINO_HEADERS);

        execute(&client, "SELECT 1", &token).await.unwrap();
        assert_eq!(client.catalog.lock().await.as_deref(), Some("iceberg"));
        assert_eq!(client.schema.lock().await.as_deref(), Some("analytics"));

        let result = execute(&client, "SELECT 2", &token).await.unwrap();
        server.await.unwrap();
        assert_eq!(result.rows, vec![vec![Some("2".to_string())]]);
    }

    #[tokio::test]
    async fn presto_set_catalog_and_schema_response_headers_still_apply() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: None,
                    body_equals: Some("SELECT 1"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: vec![
                        ("X-Presto-Set-Catalog", "memory"),
                        ("X-Presto-Set-Schema", "default"),
                    ],
                    response_body:
                        r#"{"id":"q1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                            .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: None,
                    body_equals: Some("SELECT 2"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "memory"),
                        ("X-Presto-Schema", "default"),
                    ],
                    response_headers: Vec::new(),
                    response_body:
                        r#"{"id":"q2","columns":[{"name":"_col0","type":"integer"}],"data":[[2]]}"#
                            .to_string(),
                },
            ],
        ));
        let token = CancellationToken::new();
        let client = test_client(base_url);

        execute(&client, "SELECT 1", &token).await.unwrap();
        assert_eq!(client.catalog.lock().await.as_deref(), Some("memory"));
        assert_eq!(client.schema.lock().await.as_deref(), Some("default"));

        let result = execute(&client, "SELECT 2", &token).await.unwrap();
        server.await.unwrap();
        assert_eq!(result.rows, vec![vec![Some("2".to_string())]]);
    }

    /// Serializes tests that mutate the process-global proxy environment so a
    /// concurrent client build in the same test binary can't observe a
    /// half-set state. reqwest snapshots the env at `Client::build()`, so each
    /// test only needs to hold this across `connect()`.
    static PROXY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct ProxyEnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ProxyEnvGuard {
        /// Point every proxy env var reqwest honors at `dead_proxy` and clear
        /// NO_PROXY (so loopback isn't implicitly excluded). Restores the prior
        /// values on drop.
        fn install(dead_proxy: &str) -> Self {
            let lock = PROXY_ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let keys = [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "NO_PROXY",
                "no_proxy",
            ];
            let saved = keys
                .iter()
                .map(|&k| (k, std::env::var(k).ok()))
                .collect::<Vec<_>>();
            // SAFETY: env mutation is process-global; PROXY_ENV_LOCK serializes
            // these tests and no other unit test makes real non-proxied
            // localhost reqwest calls (verified in the crate).
            unsafe {
                for k in [
                    "HTTP_PROXY",
                    "http_proxy",
                    "HTTPS_PROXY",
                    "https_proxy",
                    "ALL_PROXY",
                    "all_proxy",
                ] {
                    std::env::set_var(k, dead_proxy);
                }
                std::env::remove_var("NO_PROXY");
                std::env::remove_var("no_proxy");
            }
            Self { saved, _lock: lock }
        }
    }

    impl Drop for ProxyEnvGuard {
        fn drop(&mut self) {
            // SAFETY: still holding PROXY_ENV_LOCK; restore the exact prior env.
            unsafe {
                for (k, v) in &self.saved {
                    match v {
                        Some(val) => std::env::set_var(k, val),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    /// Regression for the VPN/proxy 502: an ambient system/env proxy must not
    /// hijack a Presto connection. `connect()` builds its client with
    /// `.no_proxy()`, so even with HTTP(S)_PROXY/ALL_PROXY pointed at a dead
    /// address it dials the target directly. Without `.no_proxy()` reqwest would
    /// route `/v1/statement` through the dead proxy and `connect()` would error.
    #[tokio::test]
    async fn connect_ignores_ambient_env_proxy() {
        // A proxy that accepts then instantly drops every connection — any
        // request routed here fails fast (no hanging on a real timeout).
        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_addr = dead.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = dead.accept().await {
                drop(stream);
            }
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: None,
                body_equals: Some("SELECT 1"),
                headers: vec![("X-Presto-User", "taomni")],
                response_headers: Vec::new(),
                response_body:
                    r#"{"id":"q1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                        .to_string(),
            }],
        ));

        let config = DbConfig {
            engine: "Presto".to_string(),
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: None,
            password: None,
            database: None,
            catalog: None,
            ssl: false,
            timeout_secs: Some(5),
            http_port: None,
            protocol: None,
            presto_dialect: None,
            db_index: None,
            network_settings: None,
        };

        let result = {
            let _guard = ProxyEnvGuard::install(&format!("http://{dead_addr}"));
            // reqwest reads the env at build time (inside connect), so the guard
            // only needs to span the connect() call.
            connect(&config, None).await
        };

        result.expect("connect must bypass the ambient env proxy and dial the target directly");
        server.await.unwrap();
    }
}
