//! Oracle backend via `rust-oracle` (ODPI-C).
//!
//! The driver is synchronous, so every database operation runs inside
//! `spawn_blocking` while the async command layer keeps its normal shape.

use std::sync::Arc;
use std::time::{Duration, Instant};

use oracle::{Connection, Row, SqlValue, StatementType};
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use super::{
    ColumnDescription, ColumnInfo, DbConfig, DbHandle, DbObject, ForeignKeyInfo, IndexInfo,
    QueryResult, QueryStreamChannel, QueryStreamEvent, SchemaInfo, TableInfo, group_foreign_keys,
    send_query_stream_event,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;
const STREAM_BATCH_ROWS_U32: u32 = 100;

pub type OracleClient = Arc<Connection>;

fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

fn oracle_connect_string(config: &DbConfig) -> String {
    let service = config.database.as_deref().map(str::trim).unwrap_or("");
    if service.starts_with("//")
        || service.to_ascii_lowercase().starts_with("tcps://")
        || service.starts_with('(')
    {
        return service.to_string();
    }
    let scheme = if config.ssl { "tcps://" } else { "//" };
    if service.is_empty() {
        format!("{scheme}{}:{}", config.host, config.port)
    } else if service.starts_with('/') || service.starts_with('?') {
        format!("{scheme}{}:{}{}", config.host, config.port, service)
    } else {
        format!("{scheme}{}:{}/{}", config.host, config.port, service)
    }
}

fn join_blocking_error(err: JoinError) -> String {
    if err.is_panic() {
        "Oracle operation panicked".to_string()
    } else {
        format!("Oracle operation failed: {err}")
    }
}

async fn oracle_blocking<T, F>(
    client: OracleClient,
    token: Option<&CancellationToken>,
    op: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(OracleClient) -> Result<T, String> + Send + 'static,
{
    let cancel_client = client.clone();
    let mut task = tokio::task::spawn_blocking(move || op(client));
    if let Some(token) = token {
        tokio::select! {
            res = &mut task => res.map_err(join_blocking_error)?,
            _ = token.cancelled() => {
                let _ = tokio::task::spawn_blocking(move || cancel_client.break_execution()).await;
                match task.await {
                    Ok(_) => Err("Query cancelled".into()),
                    Err(err) => Err(join_blocking_error(err)),
                }
            }
        }
    } else {
        task.await.map_err(join_blocking_error)?
    }
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let username = config.username.clone().unwrap_or_default();
    let password = password.unwrap_or("").to_string();
    let connect_string = oracle_connect_string(config);
    let timeout = timeout(config);
    let connect = tokio::task::spawn_blocking(move || {
        let mut conn = Connection::connect(username, password, connect_string)
            .map_err(|e| format!("Oracle connect failed: {e}"))?;
        conn.set_autocommit(true);
        Ok::<_, String>(Arc::new(conn))
    });
    let client = tokio::time::timeout(timeout, connect)
        .await
        .map_err(|_| "Oracle connect timed out".to_string())?
        .map_err(join_blocking_error)??;
    Ok(DbHandle::Oracle(client))
}

pub async fn ping(client: &OracleClient) -> Result<String, String> {
    oracle_blocking(client.clone(), None, |conn| {
        conn.ping()
            .map_err(|e| format!("Oracle ping failed: {e}"))?;
        Ok("Oracle connection OK".into())
    })
    .await
}

fn oracle_owner_sql(schema: Option<&str>) -> String {
    match schema.map(str::trim).filter(|s| !s.is_empty()) {
        Some(schema) => format!("'{}'", schema.replace('\'', "''").to_uppercase()),
        None => "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')".to_string(),
    }
}

fn oracle_object_type(kind: &str) -> Option<&'static str> {
    match kind {
        "table" => Some("TABLE"),
        "view" => Some("VIEW"),
        "materialized_view" => Some("MATERIALIZED VIEW"),
        "procedure" => Some("PROCEDURE"),
        "function" => Some("FUNCTION"),
        "trigger" => Some("TRIGGER"),
        "sequence" => Some("SEQUENCE"),
        _ => None,
    }
}

fn dbms_metadata_object_type(kind: &str) -> Option<&'static str> {
    match kind {
        "table" => Some("TABLE"),
        "view" => Some("VIEW"),
        "materialized_view" => Some("MATERIALIZED_VIEW"),
        "procedure" => Some("PROCEDURE"),
        "function" => Some("FUNCTION"),
        "trigger" => Some("TRIGGER"),
        "sequence" => Some("SEQUENCE"),
        _ => None,
    }
}

fn oracle_table_kind(object_type: &str) -> String {
    match object_type {
        "VIEW" => "view",
        "MATERIALIZED VIEW" => "materialized_view",
        _ => "table",
    }
    .to_string()
}

fn oracle_value_to_string(value: &SqlValue<'_>) -> Option<String> {
    match value.is_null() {
        Ok(true) => None,
        _ => Some(value.to_string()),
    }
}

fn row_value(row: &Row, index: usize) -> Option<String> {
    row.sql_values().get(index).and_then(oracle_value_to_string)
}

fn row_bool(row: &Row, index: usize) -> bool {
    row_value(row, index)
        .map(|v| matches!(v.as_str(), "1" | "Y" | "YES" | "TRUE"))
        .unwrap_or(false)
}

fn oracle_rows(
    client: &OracleClient,
    sql: &str,
    max_rows: Option<u64>,
) -> Result<(Vec<ColumnInfo>, Vec<Vec<Option<String>>>, bool), String> {
    let mut stmt = client
        .statement(sql)
        .fetch_array_size(STREAM_BATCH_ROWS_U32)
        .prefetch_rows(STREAM_BATCH_ROWS_U32 + 1)
        .build()
        .map_err(|e| format!("Query failed: {e}"))?;
    let rows = stmt.query(&[]).map_err(|e| format!("Query failed: {e}"))?;
    let columns = rows
        .column_info()
        .iter()
        .map(|info| ColumnInfo {
            name: info.name().to_string(),
            type_name: info.oracle_type().to_string(),
        })
        .collect();
    let max_rows = max_rows.filter(|value| *value > 0);
    let mut out_rows = Vec::new();
    let mut limit_reached = false;
    for row_result in rows {
        if max_rows.is_some_and(|limit| out_rows.len() as u64 >= limit) {
            limit_reached = true;
            break;
        }
        let row = row_result.map_err(|e| format!("Query failed: {e}"))?;
        let values = row
            .sql_values()
            .iter()
            .map(oracle_value_to_string)
            .collect();
        out_rows.push(values);
    }
    Ok((columns, out_rows, limit_reached))
}

pub async fn execute(
    client: &OracleClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let sql = sql.to_string();
    oracle_blocking(client.clone(), Some(token), move |conn| {
        let start = Instant::now();
        let mut stmt = conn
            .statement(&sql)
            .build()
            .map_err(|e| format!("Statement failed: {e}"))?;
        if stmt.statement_type() == StatementType::Select {
            let (columns, rows, _) = oracle_rows(&conn, &sql, None)?;
            Ok(QueryResult {
                columns,
                rows,
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            })
        } else {
            stmt.execute(&[])
                .map_err(|e| format!("Statement failed: {e}"))?;
            let rows_affected = stmt.row_count().unwrap_or(0);
            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            })
        }
    })
    .await
}

pub async fn execute_stream(
    client: &OracleClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let sql = sql.to_string();
    let start = Instant::now();
    let result = oracle_blocking(client.clone(), Some(token), move |conn| {
        let mut stmt = conn
            .statement(&sql)
            .build()
            .map_err(|e| format!("Statement failed: {e}"))?;
        if stmt.statement_type() == StatementType::Select {
            let (columns, rows, limit_reached) = oracle_rows(&conn, &sql, max_rows)?;
            Ok((Some((columns, rows, limit_reached)), 0_u64))
        } else {
            stmt.execute(&[])
                .map_err(|e| format!("Statement failed: {e}"))?;
            Ok((None, stmt.row_count().unwrap_or(0)))
        }
    })
    .await?;

    match result {
        (Some((columns, rows, limit_reached)), _) => {
            if !columns.is_empty() {
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
            }
            for batch in rows.chunks(STREAM_BATCH_ROWS) {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: batch.to_vec(),
                    },
                )?;
            }
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Done {
                    rows_affected: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                    warnings: match (limit_reached, max_rows.filter(|value| *value > 0)) {
                        (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                        _ => Vec::new(),
                    },
                },
            )
        }
        (None, rows_affected) => send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        ),
    }
}

pub async fn list_schemas(client: &OracleClient) -> Result<Vec<SchemaInfo>, String> {
    oracle_blocking(client.clone(), None, |conn| {
        let sql = "SELECT DISTINCT owner \
                   FROM all_objects \
                   WHERE object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','TRIGGER') \
                   UNION SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual \
                   ORDER BY 1";
        let (columns, rows, _) = oracle_rows(&conn, sql, None)?;
        let _ = columns;
        Ok(rows
            .into_iter()
            .filter_map(|row| row.into_iter().next().flatten())
            .map(|name| SchemaInfo { name })
            .collect())
    })
    .await
}

pub async fn list_tables(
    client: &OracleClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let owner = oracle_owner_sql(schema);
    let sql = format!(
        "SELECT o.object_name, o.object_type, t.num_rows \
         FROM all_objects o \
         LEFT JOIN all_tables t ON t.owner = o.owner AND t.table_name = o.object_name \
         WHERE o.owner = {owner} \
           AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') \
           AND o.object_name NOT LIKE 'BIN$%' \
         ORDER BY o.object_name"
    );
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, None)?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name = row.first().and_then(Clone::clone)?;
                let object_type = row.get(1).and_then(Clone::clone).unwrap_or_default();
                let row_count = row
                    .get(2)
                    .and_then(Clone::clone)
                    .and_then(|value| value.parse::<i64>().ok());
                Some(TableInfo {
                    name,
                    kind: oracle_table_kind(&object_type),
                    row_count,
                })
            })
            .collect())
    })
    .await
}

pub async fn search_tables(
    client: &OracleClient,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let owner = oracle_owner_sql(schema);
    let prefix = prefix.replace('\'', "''");
    let prefix_filter = if prefix.is_empty() {
        String::new()
    } else {
        format!("AND SUBSTR(UPPER(o.object_name), 1, LENGTH('{prefix}')) = UPPER('{prefix}')")
    };
    let sql = format!(
        "SELECT object_name, object_type FROM ( \
           SELECT o.object_name, o.object_type \
           FROM all_objects o \
           WHERE o.owner = {owner} \
             AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') \
             AND o.object_name NOT LIKE 'BIN$%' \
             {prefix_filter} \
           ORDER BY o.object_name \
         ) WHERE ROWNUM <= {limit}"
    );
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, None)?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name = row.first().and_then(Clone::clone)?;
                let object_type = row.get(1).and_then(Clone::clone).unwrap_or_default();
                Some(TableInfo {
                    name,
                    kind: oracle_table_kind(&object_type),
                    row_count: None,
                })
            })
            .collect())
    })
    .await
}

pub async fn describe_table(
    client: &OracleClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let owner = oracle_owner_sql(schema);
    let table = table.replace('\'', "''").to_uppercase();
    let sql = format!(
        "SELECT c.column_name, \
                c.data_type || \
                CASE \
                  WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || c.data_length || ')' \
                  WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || CASE WHEN c.data_scale IS NOT NULL THEN ',' || c.data_scale ELSE '' END || ')' \
                  WHEN c.data_type LIKE 'TIMESTAMP%' AND c.data_scale IS NOT NULL THEN '(' || c.data_scale || ')' \
                  ELSE '' \
                END AS type_name, \
                c.nullable, c.data_default, \
                CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS is_pk \
         FROM all_tab_columns c \
         LEFT JOIN ( \
           SELECT acc.owner, acc.table_name, acc.column_name \
           FROM all_constraints ac \
           JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name \
           WHERE ac.constraint_type = 'P' \
         ) pk ON pk.owner = c.owner AND pk.table_name = c.table_name AND pk.column_name = c.column_name \
         WHERE c.owner = {owner} AND c.table_name = '{table}' \
         ORDER BY c.column_id"
    );
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, None)?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                Some(ColumnDescription {
                    name: row.first().and_then(Clone::clone)?,
                    type_name: row.get(1).and_then(Clone::clone).unwrap_or_default(),
                    nullable: row
                        .get(2)
                        .and_then(Clone::clone)
                        .map(|value| value.eq_ignore_ascii_case("Y"))
                        .unwrap_or(true),
                    default: row.get(3).and_then(Clone::clone),
                    primary_key: row
                        .get(4)
                        .and_then(Clone::clone)
                        .map(|value| value == "1")
                        .unwrap_or(false),
                })
            })
            .collect())
    })
    .await
}

pub async fn list_foreign_keys(
    client: &OracleClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let owner = oracle_owner_sql(schema);
    let table = table.replace('\'', "''").to_uppercase();
    let sql = format!(
        "SELECT child.constraint_name, child_col.column_name, parent.owner, \
                parent.table_name, parent_col.column_name \
         FROM all_constraints child \
         JOIN all_cons_columns child_col \
           ON child_col.owner = child.owner \
          AND child_col.constraint_name = child.constraint_name \
         JOIN all_constraints parent \
           ON parent.owner = child.r_owner \
          AND parent.constraint_name = child.r_constraint_name \
         JOIN all_cons_columns parent_col \
           ON parent_col.owner = parent.owner \
          AND parent_col.constraint_name = parent.constraint_name \
          AND parent_col.position = child_col.position \
         WHERE child.constraint_type = 'R' \
           AND child.owner = {owner} AND child.table_name = '{table}' \
         ORDER BY child.constraint_name, child_col.position"
    );
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, None)?;
        Ok(group_foreign_keys(rows.into_iter().filter_map(|row| {
            Some((
                row.first().and_then(Clone::clone)?,
                row.get(1).and_then(Clone::clone)?,
                row.get(2).and_then(Clone::clone),
                row.get(3).and_then(Clone::clone)?,
                row.get(4).and_then(Clone::clone)?,
            ))
        })))
    })
    .await
}

pub async fn list_indexes(
    client: &OracleClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let owner = oracle_owner_sql(schema);
    let table = table.replace('\'', "''").to_uppercase();
    let sql = format!(
        "SELECT i.index_name, c.column_name, CASE WHEN i.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END \
         FROM all_indexes i \
         JOIN all_ind_columns c ON c.index_owner = i.owner AND c.index_name = i.index_name \
         WHERE i.owner = {owner} AND i.table_name = '{table}' \
         ORDER BY i.index_name, c.column_position"
    );
    oracle_blocking(client.clone(), None, move |conn| {
        let mut grouped: Vec<IndexInfo> = Vec::new();
        let rows = conn
            .query(&sql, &[])
            .map_err(|e| format!("list indexes failed: {e}"))?;
        for row_result in rows {
            let row = row_result.map_err(|e| format!("list indexes failed: {e}"))?;
            let Some(name) = row_value(&row, 0) else {
                continue;
            };
            let column = row_value(&row, 1).unwrap_or_default();
            let unique = row_bool(&row, 2);
            if let Some(last) = grouped.last_mut().filter(|item| item.name == name) {
                last.columns.push(column);
                last.unique = last.unique || unique;
            } else {
                grouped.push(IndexInfo {
                    name,
                    columns: vec![column],
                    unique,
                });
            }
        }
        Ok(grouped)
    })
    .await
}

pub async fn list_objects(
    client: &OracleClient,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let Some(object_type) = oracle_object_type(kind) else {
        return Ok(Vec::new());
    };
    let owner = oracle_owner_sql(schema);
    let (sql, owner_col) = if kind == "trigger" {
        (
            format!(
                "SELECT trigger_name, table_name \
                 FROM all_triggers \
                 WHERE owner = {owner} \
                 ORDER BY trigger_name"
            ),
            true,
        )
    } else if kind == "sequence" {
        (
            format!(
                "SELECT sequence_name, CAST(NULL AS VARCHAR2(128)) \
                 FROM all_sequences \
                 WHERE sequence_owner = {owner} \
                 ORDER BY sequence_name"
            ),
            false,
        )
    } else {
        (
            format!(
                "SELECT object_name, CAST(NULL AS VARCHAR2(128)) \
                 FROM all_objects \
                 WHERE owner = {owner} \
                   AND object_type = '{object_type}' \
                   AND object_name NOT LIKE 'BIN$%' \
                 ORDER BY object_name"
            ),
            false,
        )
    };
    let kind = kind.to_string();
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, None)?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name = row.first().and_then(Clone::clone)?;
                let owner = if owner_col {
                    row.get(1).and_then(Clone::clone)
                } else {
                    None
                };
                Some(DbObject {
                    name,
                    kind: kind.clone(),
                    owner,
                })
            })
            .collect())
    })
    .await
}

pub async fn object_ddl(
    client: &OracleClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let object_type = dbms_metadata_object_type(kind).unwrap_or("TABLE");
    let owner = oracle_owner_sql(schema);
    let name = name.replace('\'', "''").to_uppercase();
    let sql = format!("SELECT DBMS_METADATA.GET_DDL('{object_type}', '{name}', {owner}) FROM dual");
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, Some(1))?;
        rows.first()
            .and_then(|row| row.first().cloned().flatten())
            .filter(|ddl| !ddl.trim().is_empty())
            .ok_or_else(|| format!("No DDL returned for {name}"))
    })
    .await
}

pub async fn table_stats(
    client: &OracleClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let owner = oracle_owner_sql(schema);
    let table = table.replace('\'', "''").to_uppercase();
    let sql = format!(
        "SELECT t.num_rows, \
                t.blocks, \
                t.avg_row_len, \
                t.tablespace_name, \
                TO_CHAR(t.last_analyzed, 'YYYY-MM-DD HH24:MI:SS'), \
                (SELECT SUM(s.bytes) \
                   FROM all_segments s \
                  WHERE s.owner = t.owner AND s.segment_name = t.table_name), \
                (SELECT SUM(s.bytes) \
                   FROM all_indexes i \
                   JOIN all_segments s ON s.owner = i.owner AND s.segment_name = i.index_name \
                  WHERE i.table_owner = t.owner AND i.table_name = t.table_name) \
         FROM all_tables t \
         WHERE t.owner = {owner} AND t.table_name = '{table}'"
    );
    oracle_blocking(client.clone(), None, move |conn| {
        let (_, rows, _) = oracle_rows(&conn, &sql, Some(1))?;
        let row = rows
            .first()
            .ok_or_else(|| format!("Table {table} not found"))?;
        let get = |index: usize| row.get(index).cloned().flatten();
        Ok(super::metric_result(vec![
            ("Estimated rows", get(0)),
            ("Blocks", get(1)),
            ("Average row length", get(2)),
            ("Tablespace", get(3)),
            ("Last analyzed", get(4)),
            ("Data bytes", get(5)),
            ("Index bytes", get(6)),
        ]))
    })
    .await
}
