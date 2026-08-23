//! MySQL / StarRocks / PostgreSQL backend via `sqlx` and SQL Server via
//! `tiberius`. Values are decoded to `Option<String>` based on the column's SQL
//! type so the frontend grid can render them as text with a distinct NULL badge.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};

use futures::TryStreamExt;
use sqlx_core::Error as SqlxError;
use sqlx_core::column::Column;
use sqlx_core::pool::Pool;
use sqlx_core::query::query;
use sqlx_core::raw_sql::raw_sql;
use sqlx_core::row::Row;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_core::type_info::TypeInfo;
use sqlx_core::types::{BigDecimal, Uuid};
use sqlx_mysql::{MySql, MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx_postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode, Postgres};
use tiberius::{
    AuthMethod as TdsAuthMethod, Client as TdsClient, ColumnType as TdsColumnType,
    Config as TdsConfig, EncryptionLevel as TdsEncryptionLevel, QueryItem as TdsQueryItem,
    Row as TdsRow, ToSql as TdsToSql,
};
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

use super::{
    ColumnDescription, ColumnInfo, DbConfig, DbHandle, DbObject, ForeignKeyInfo, IndexInfo,
    QueryResult, QueryStreamChannel, QueryStreamEvent, SchemaInfo, TableInfo, group_foreign_keys,
    send_query_stream_event,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;

pub type SqlServerClient = TdsClient<Compat<TcpStream>>;

fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/// Session default schema/database remembered across pool reconnects.
///
/// `USE` / `SET search_path` only affect the live connection. sqlx may recreate
/// the single pooled connection after idle timeout or network blips; the
/// `after_connect` hook re-applies this value so the UI "active schema" sticks.
pub type ActiveSchemaSlot = Arc<AsyncMutex<Option<String>>>;

fn initial_active_schema(config: &DbConfig) -> Option<String> {
    config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn new_active_schema_slot(config: &DbConfig) -> ActiveSchemaSlot {
    // Only engines where the connection "database" field is the default schema
    // should seed the restore slot. Postgres/PanWei/Oracle/SQLServer use a
    // separate schema namespace from the connect database name.
    let initial = match config.engine.as_str() {
        "MySQL" | "StarRocks" | "ClickHouse" | "Presto" => initial_active_schema(config),
        _ => None,
    };
    Arc::new(AsyncMutex::new(initial))
}

async fn restore_mysql_schema(
    conn: &mut sqlx_mysql::MySqlConnection,
    active_schema: &ActiveSchemaSlot,
) -> Result<(), SqlxError> {
    let schema = active_schema.lock().await.clone();
    let Some(schema) = schema.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    // USE is not supported by MySQL's prepared-statement protocol (error 1295).
    let sql = format!("USE {}", quote_mysql_ident(&schema));
    raw_sql(AssertSqlSafe(sql)).execute(&mut *conn).await?;
    Ok(())
}

async fn restore_postgres_schema(
    conn: &mut sqlx_postgres::PgConnection,
    active_schema: &ActiveSchemaSlot,
) -> Result<(), SqlxError> {
    let schema = active_schema.lock().await.clone();
    let Some(schema) = schema.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    // Postgres search_path is session state; re-apply after reconnect.
    let sql = format!("SET search_path TO {}", quote_pg_ident(&schema));
    raw_sql(AssertSqlSafe(sql)).execute(&mut *conn).await?;
    Ok(())
}

fn quote_pg_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

pub async fn connect_mysql(
    config: &DbConfig,
    password: Option<&str>,
    active_schema: ActiveSchemaSlot,
) -> Result<DbHandle, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    });

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .after_connect(move |conn, _meta| {
            let active_schema = active_schema.clone();
            Box::pin(async move { restore_mysql_schema(conn, &active_schema).await })
        })
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL connect failed: {e}"))?;
    Ok(DbHandle::MySql(pool))
}

pub async fn connect_starrocks(
    config: &DbConfig,
    password: Option<&str>,
    active_schema: ActiveSchemaSlot,
) -> Result<DbHandle, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .pipes_as_concat(false)
        .no_engine_substitution(false)
        .timezone(None)
        .set_names(false);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    });

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .after_connect(move |conn, _meta| {
            let active_schema = active_schema.clone();
            Box::pin(async move { restore_mysql_schema(conn, &active_schema).await })
        })
        .connect_with(opts)
        .await
        .map_err(|e| format!("StarRocks connect failed: {e}"))?;
    Ok(DbHandle::StarRocks(pool))
}

pub async fn connect_postgres(
    config: &DbConfig,
    password: Option<&str>,
    active_schema: ActiveSchemaSlot,
) -> Result<DbHandle, String> {
    let mut opts = PgConnectOptions::new().host(&config.host).port(config.port);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        PgSslMode::Prefer
    } else {
        PgSslMode::Disable
    });

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .after_connect(move |conn, _meta| {
            let active_schema = active_schema.clone();
            Box::pin(async move { restore_postgres_schema(conn, &active_schema).await })
        })
        .connect_with(opts)
        .await
        .map_err(|e| format!("PostgreSQL connect failed: {e}"))?;
    Ok(DbHandle::Postgres(pool))
}

pub async fn connect_sqlserver(
    config: &DbConfig,
    password: Option<&str>,
) -> Result<DbHandle, String> {
    let mut opts = TdsConfig::new();
    opts.host(&config.host);
    opts.port(config.port);
    opts.application_name("Taomni");
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts.database(db);
    }

    let user = config.username.as_deref().unwrap_or("");
    if !user.is_empty() || password.is_some() {
        opts.authentication(TdsAuthMethod::sql_server(user, password.unwrap_or("")));
    }

    if config.ssl {
        opts.encryption(TdsEncryptionLevel::Required);
        // Many SQL Server developer and intranet deployments use self-signed
        // certificates. Match the app's boolean TLS model by encrypting without
        // requiring a separate CA picker.
        opts.trust_cert();
    } else {
        opts.encryption(TdsEncryptionLevel::Off);
    }

    let connect = async {
        let tcp = TcpStream::connect(opts.get_addr())
            .await
            .map_err(|e| format!("SQL Server TCP connect failed: {e}"))?;
        tcp.set_nodelay(true)
            .map_err(|e| format!("SQL Server TCP option failed: {e}"))?;
        TdsClient::connect(opts, tcp.compat_write())
            .await
            .map_err(|e| format!("SQL Server connect failed: {e}"))
    };

    let client = tokio::time::timeout(timeout(config), connect)
        .await
        .map_err(|_| "SQL Server connect timed out".to_string())??;
    Ok(DbHandle::SqlServer(Arc::new(AsyncMutex::new(client))))
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

pub async fn ping_mysql(pool: &Pool<MySql>) -> Result<String, String> {
    query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("MySQL ping failed: {e}"))?;
    Ok("MySQL connection OK".into())
}

pub async fn ping_starrocks(pool: &Pool<MySql>) -> Result<String, String> {
    query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("StarRocks ping failed: {e}"))?;
    Ok("StarRocks connection OK".into())
}

pub async fn ping_postgres(pool: &Pool<Postgres>) -> Result<String, String> {
    query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("PostgreSQL ping failed: {e}"))?;
    Ok("PostgreSQL connection OK".into())
}

pub async fn ping_sqlserver(client: &AsyncMutex<SqlServerClient>) -> Result<String, String> {
    let rows = sqlserver_fetch(client, "SELECT 1", &[])
        .await
        .map_err(|e| format!("SQL Server ping failed: {e}"))?;
    if rows.is_empty() {
        return Err("SQL Server ping failed: no response".into());
    }
    Ok("SQL Server connection OK".into())
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

/// Decode the i-th column of a MySQL row to an optional display string. The
/// column's SQL type name drives which concrete `try_get` is attempted, with a
/// raw-bytes / lossy-utf8 fallback so unknown types never panic.
fn mysql_value_to_string(row: &MySqlRow, i: usize) -> Option<String> {
    let col = &row.columns()[i];
    let type_name = col.type_info().name().to_uppercase();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match type_name.as_str() {
        "BOOLEAN" | "BOOL" => try_as!(bool),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" => try_as!(i64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            try_as!(u64)
        }
        "BIGINT" => try_as!(i64),
        "FLOAT" => try_as!(f32),
        "DOUBLE" | "REAL" => try_as!(f64),
        "DECIMAL" | "NUMERIC" => try_as!(BigDecimal),
        "DATE" => try_as!(chrono::NaiveDate),
        "TIME" => try_as!(chrono::NaiveTime),
        "DATETIME" | "TIMESTAMP" => try_as!(chrono::NaiveDateTime),
        "JSON" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        "BIT" => {
            if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
                return v.map(|x| x.to_string());
            }
            if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
                return v.map(|b| {
                    if b.is_empty() {
                        "0".to_string()
                    } else if b.len() == 1 {
                        b[0].to_string()
                    } else {
                        let mut val: u64 = 0;
                        for &byte in &b {
                            val = (val << 8) | (byte as u64);
                        }
                        val.to_string()
                    }
                });
            }
        }
        _ => {}
    }
    // Fallback: text, then raw bytes (lossy utf8 for BLOB/VARBINARY).
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

/// Decode the i-th column of a PostgreSQL row to an optional display string.
fn pg_value_to_string(row: &PgRow, i: usize) -> Option<String> {
    let col = &row.columns()[i];
    let type_name = col.type_info().name().to_uppercase();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match type_name.as_str() {
        "BOOL" => try_as!(bool),
        "INT2" => try_as!(i16),
        "INT4" => try_as!(i32),
        "INT8" => try_as!(i64),
        "FLOAT4" => try_as!(f32),
        "FLOAT8" => try_as!(f64),
        "NUMERIC" => try_as!(BigDecimal),
        "DATE" => try_as!(chrono::NaiveDate),
        "TIME" => try_as!(chrono::NaiveTime),
        "TIMESTAMP" => try_as!(chrono::NaiveDateTime),
        "TIMESTAMPTZ" => try_as!(chrono::DateTime<chrono::Utc>),
        "UUID" => try_as!(Uuid),
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        _ => {}
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

fn sqlserver_column_type_name(kind: TdsColumnType) -> &'static str {
    match kind {
        TdsColumnType::Null => "null",
        TdsColumnType::Bit | TdsColumnType::Bitn => "bit",
        TdsColumnType::Int1 => "tinyint",
        TdsColumnType::Int2 => "smallint",
        TdsColumnType::Int4 => "int",
        TdsColumnType::Int8 => "bigint",
        TdsColumnType::Intn => "int",
        TdsColumnType::Float4 => "real",
        TdsColumnType::Float8 | TdsColumnType::Floatn => "float",
        TdsColumnType::Money | TdsColumnType::Money4 => "money",
        TdsColumnType::Decimaln => "decimal",
        TdsColumnType::Numericn => "numeric",
        TdsColumnType::Datetime | TdsColumnType::Datetime4 | TdsColumnType::Datetimen => "datetime",
        TdsColumnType::Daten => "date",
        TdsColumnType::Timen => "time",
        TdsColumnType::Datetime2 => "datetime2",
        TdsColumnType::DatetimeOffsetn => "datetimeoffset",
        TdsColumnType::Guid => "uniqueidentifier",
        TdsColumnType::BigVarBin | TdsColumnType::BigBinary => "varbinary",
        TdsColumnType::BigVarChar | TdsColumnType::BigChar | TdsColumnType::Text => "varchar",
        TdsColumnType::NVarchar | TdsColumnType::NChar | TdsColumnType::NText => "nvarchar",
        TdsColumnType::Xml => "xml",
        TdsColumnType::Udt => "udt",
        TdsColumnType::Image => "image",
        TdsColumnType::SSVariant => "sql_variant",
    }
}

fn sqlserver_value_to_string(row: &TdsRow, i: usize) -> Option<String> {
    let kind = row.columns()[i].column_type();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<$t, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match kind {
        TdsColumnType::Bit | TdsColumnType::Bitn => try_as!(bool),
        TdsColumnType::Int1 => try_as!(u8),
        TdsColumnType::Int2 => try_as!(i16),
        TdsColumnType::Int4 | TdsColumnType::Intn => try_as!(i32),
        TdsColumnType::Int8 => try_as!(i64),
        TdsColumnType::Float4 => try_as!(f32),
        TdsColumnType::Float8 | TdsColumnType::Floatn => try_as!(f64),
        TdsColumnType::Decimaln
        | TdsColumnType::Numericn
        | TdsColumnType::Money
        | TdsColumnType::Money4 => {
            try_as!(tiberius::numeric::Numeric)
        }
        TdsColumnType::Guid => try_as!(Uuid),
        TdsColumnType::Daten => try_as!(chrono::NaiveDate),
        TdsColumnType::Timen => try_as!(chrono::NaiveTime),
        TdsColumnType::Datetime
        | TdsColumnType::Datetime4
        | TdsColumnType::Datetimen
        | TdsColumnType::Datetime2 => try_as!(chrono::NaiveDateTime),
        TdsColumnType::DatetimeOffsetn => try_as!(chrono::DateTime<chrono::FixedOffset>),
        TdsColumnType::Xml => {
            if let Ok(v) = row.try_get::<&tiberius::xml::XmlData, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        _ => {}
    }
    if let Ok(v) = row.try_get::<&str, _>(i) {
        return v.map(|x| x.to_string());
    }
    if let Ok(v) = row.try_get::<&[u8], _>(i) {
        return v.map(|b| String::from_utf8_lossy(b).into_owned());
    }
    None
}

/// Heuristic: does the statement return rows? (SELECT/SHOW/DESCRIBE/WITH/...)
fn sql_head_keyword(sql: &str) -> String {
    executable_sql_head(sql)
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase()
}

fn is_query(sql: &str) -> bool {
    matches!(
        sql_head_keyword(sql).as_str(),
        "SELECT"
            | "SHOW"
            | "DESCRIBE"
            | "DESC"
            | "EXPLAIN"
            | "WITH"
            | "TABLE"
            | "VALUES"
            | "PRAGMA"
    )
}

/// MySQL (and StarRocks) reject some statements under the prepared-statement
/// protocol with error 1295. Run those via the text protocol (`raw_sql`).
fn needs_mysql_text_protocol(sql: &str) -> bool {
    matches!(
        sql_head_keyword(sql).as_str(),
        "USE" | "PREPARE" | "EXECUTE" | "DEALLOCATE" | "HELP"
    )
}

/// Parse the target of session default-schema switch statements:
/// `USE db`, `SET search_path TO schema`, `ALTER SESSION SET CURRENT_SCHEMA = schema`.
pub fn parse_default_schema_switch(sql: &str) -> Option<String> {
    let head = executable_sql_head(sql);
    let keyword = sql_head_keyword(sql);
    match keyword.as_str() {
        "USE" => {
            let rest = head.get(keyword.len()..)?.trim();
            let first = rest.split_whitespace().next().unwrap_or(rest);
            // Presto: USE catalog.schema → keep the last component as schema.
            let target = first.rsplit('.').next().unwrap_or(first);
            unquote_sql_ident(target)
        }
        "SET" => {
            // SET search_path TO ident  |  SET search_path = ident
            let rest = head.get(keyword.len()..)?.trim();
            let upper = rest.to_ascii_uppercase();
            if !upper.starts_with("SEARCH_PATH") {
                return None;
            }
            let after = rest.get("search_path".len()..)?.trim_start();
            let after_upper = after.to_ascii_uppercase();
            let after = if after_upper.starts_with("TO") {
                after.get(2..).unwrap_or("").trim_start()
            } else if after.starts_with('=') {
                after.get(1..).unwrap_or("").trim_start()
            } else {
                after
            };
            // search_path can be a comma list; take the first entry.
            let first = after.split(',').next().unwrap_or(after).trim();
            unquote_sql_ident(first)
        }
        "ALTER" => {
            // ALTER SESSION SET CURRENT_SCHEMA = ident
            let upper = head.to_ascii_uppercase();
            let marker = "CURRENT_SCHEMA";
            let idx = upper.find(marker)?;
            let after = head.get(idx + marker.len()..)?.trim_start();
            let after = after.strip_prefix('=').map(str::trim).unwrap_or(after);
            let first = after.split_whitespace().next().unwrap_or(after);
            unquote_sql_ident(first)
        }
        _ => None,
    }
}

fn unquote_sql_ident(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return None;
    }
    let unquoted = if (trimmed.starts_with('`') && trimmed.ends_with('`'))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        let inner = &trimmed[1..trimmed.len() - 1];
        inner
            .replace("``", "`")
            .replace("\"\"", "\"")
            .replace("]]", "]")
            .replace("''", "'")
    } else {
        trimmed.to_string()
    };
    let unquoted = unquoted.trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

fn executable_sql_head(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after_comment) = rest.strip_prefix("--") {
            rest = match after_comment.find('\n') {
                Some(index) => &after_comment[index + 1..],
                None => "",
            }
            .trim_start();
            continue;
        }
        if let Some(after_comment) = rest.strip_prefix('#') {
            rest = match after_comment.find('\n') {
                Some(index) => &after_comment[index + 1..],
                None => "",
            }
            .trim_start();
            continue;
        }
        if let Some(after_comment) = rest.strip_prefix("/*") {
            rest = match after_comment.find("*/") {
                Some(index) => &after_comment[index + 2..],
                None => "",
            }
            .trim_start();
            continue;
        }
        return rest;
    }
}

fn limit_warning(limit_reached: bool, max_rows: Option<u64>) -> Vec<String> {
    match (limit_reached, max_rows) {
        (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
        _ => Vec::new(),
    }
}

async fn sqlserver_fetch(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    params: &[&dyn TdsToSql],
) -> Result<Vec<TdsRow>, String> {
    let mut guard = client.lock().await;
    let stream = guard
        .query(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))?;
    stream
        .into_first_result()
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

async fn sqlserver_query_result(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
) -> Result<(Vec<ColumnInfo>, Vec<Vec<Option<String>>>, bool), String> {
    let max_rows = max_rows.filter(|value| *value > 0);
    let run = async {
        let mut guard = client.lock().await;
        let mut stream = guard
            .simple_query(sql)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut first_result_index: Option<usize> = None;
        let mut limit_reached = false;

        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| format!("Query failed: {e}"))?
        {
            match item {
                TdsQueryItem::Metadata(meta) => {
                    if first_result_index.is_some() {
                        break;
                    }
                    first_result_index = Some(meta.result_index());
                    columns = meta
                        .columns()
                        .iter()
                        .map(|c| ColumnInfo {
                            name: c.name().to_string(),
                            type_name: sqlserver_column_type_name(c.column_type()).to_string(),
                        })
                        .collect();
                }
                TdsQueryItem::Row(row) => {
                    let row_result_index = row.result_index();
                    if let Some(index) = first_result_index {
                        if row_result_index != index {
                            break;
                        }
                    } else {
                        first_result_index = Some(row_result_index);
                    }
                    if columns.is_empty() {
                        columns = row
                            .columns()
                            .iter()
                            .map(|c| ColumnInfo {
                                name: c.name().to_string(),
                                type_name: sqlserver_column_type_name(c.column_type()).to_string(),
                            })
                            .collect();
                    }
                    if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
                        limit_reached = true;
                        break;
                    }
                    rows.push(
                        (0..row.len())
                            .map(|i| sqlserver_value_to_string(&row, i))
                            .collect(),
                    );
                }
            }
        }
        Ok((columns, rows, limit_reached))
    };
    tokio::select! {
        _ = token.cancelled() => Err("Query cancelled".into()),
        r = run => r,
    }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

pub async fn execute_mysql(
    pool: &Pool<MySql>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let fetch = query(AssertSqlSafe(sql)).fetch_all(pool);
        let rows = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = fetch => r.map_err(|e| format!("Query failed: {e}"))?,
        };
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(mysql_value_to_string(row, i));
            }
            out_rows.push(vals);
        }
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows: out_rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else if needs_mysql_text_protocol(sql) {
        // MySQL rejects USE (and a few admin commands) on COM_STMT_PREPARE with
        // 1295 HY000. Text protocol via raw_sql is required.
        let exec = raw_sql(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_postgres(
    pool: &Pool<Postgres>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let fetch = query(AssertSqlSafe(sql)).fetch_all(pool);
        let rows = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = fetch => r.map_err(|e| format!("Query failed: {e}"))?,
        };
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(pg_value_to_string(row, i));
            }
            out_rows.push(vals);
        }
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows: out_rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let (columns, rows, _limit_reached) =
            sqlserver_query_result(client, sql, None, token).await?;
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let run = async {
            let mut guard = client.lock().await;
            guard
                .execute(sql, &[])
                .await
                .map(|res| res.total())
                .map_err(|e| format!("Statement failed: {e}"))
        };
        let rows_affected = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = run => r?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_mysql_stream(
    pool: &Pool<MySql>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let mut stream = query(AssertSqlSafe(sql)).fetch(pool);
        let mut columns_sent = false;
        let mut row_count = 0_u64;
        let max_rows = max_rows.filter(|value| *value > 0);
        let mut limit_reached = false;
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(STREAM_BATCH_ROWS);

        loop {
            if max_rows.is_some_and(|limit| row_count >= limit) {
                limit_reached = true;
                break;
            }
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.try_next() => r.map_err(|e| format!("Query failed: {e}"))?,
            };
            let Some(row) = next else {
                break;
            };

            if !columns_sent {
                let columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
                columns_sent = true;
            }

            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(mysql_value_to_string(&row, i));
            }
            batch.push(vals);
            row_count += 1;
            if batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut batch),
                    },
                )?;
            }
        }

        if !batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows),
            },
        )
    } else if needs_mysql_text_protocol(sql) {
        let exec = raw_sql(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

pub async fn execute_postgres_stream(
    pool: &Pool<Postgres>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let mut stream = query(AssertSqlSafe(sql)).fetch(pool);
        let mut columns_sent = false;
        let mut row_count = 0_u64;
        let max_rows = max_rows.filter(|value| *value > 0);
        let mut limit_reached = false;
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(STREAM_BATCH_ROWS);

        loop {
            if max_rows.is_some_and(|limit| row_count >= limit) {
                limit_reached = true;
                break;
            }
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.try_next() => r.map_err(|e| format!("Query failed: {e}"))?,
            };
            let Some(row) = next else {
                break;
            };

            if !columns_sent {
                let columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
                columns_sent = true;
            }

            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(pg_value_to_string(&row, i));
            }
            batch.push(vals);
            row_count += 1;
            if batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut batch),
                    },
                )?;
            }
        }

        if !batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows),
            },
        )
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

pub async fn execute_sqlserver_stream(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let (columns, rows, limit_reached) =
            sqlserver_query_result(client, sql, max_rows, token).await?;
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
                warnings: limit_warning(limit_reached, max_rows.filter(|value| *value > 0)),
            },
        )
    } else {
        let run = async {
            let mut guard = client.lock().await;
            guard
                .execute(sql, &[])
                .await
                .map(|res| res.total())
                .map_err(|e| format!("Statement failed: {e}"))
        };
        let rows_affected = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = run => r?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Schema introspection — MySQL
// ---------------------------------------------------------------------------

fn quote_mysql_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

fn quote_mysql_table(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(schema) => format!("{}.{}", quote_mysql_ident(schema), quote_mysql_ident(table)),
        None => quote_mysql_ident(table),
    }
}

fn add_mysql_schema_name(names: &mut BTreeSet<String>, name: Option<String>) {
    if let Some(name) = name.map(|n| n.trim().to_string()) {
        if !name.is_empty() {
            names.insert(name);
        }
    }
}

async fn current_mysql_database(pool: &Pool<MySql>) -> Result<Option<String>, SqlxError> {
    query("SELECT DATABASE()")
        .fetch_optional(pool)
        .await?
        .and_then(|r| r.try_get::<Option<String>, _>(0).ok().flatten())
        .map_or(Ok(None), |db| Ok(Some(db)))
}

async fn list_schemas_mysql_show(pool: &Pool<MySql>) -> Result<Vec<String>, SqlxError> {
    let rows = query("SHOW DATABASES").fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| mysql_value_to_string(r, 0))
        .collect())
}

fn mysql_table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

fn mysql_non_unique_is_unique(row: &MySqlRow, index: usize) -> bool {
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return v == 0;
    }
    if let Ok(v) = row.try_get::<u64, _>(index) {
        return v == 0;
    }
    false
}

async fn list_tables_mysql_show(
    pool: &Pool<MySql>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, SqlxError> {
    let sql = match schema {
        Some(schema) => format!("SHOW FULL TABLES FROM {}", quote_mysql_ident(schema)),
        None => "SHOW FULL TABLES".to_string(),
    };
    let rows = query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let table_type = mysql_value_to_string(r, 1).unwrap_or_default();
            Some(TableInfo {
                name,
                kind: mysql_table_kind(&table_type),
                row_count: None,
            })
        })
        .collect())
}

async fn describe_table_mysql_show(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, SqlxError> {
    let sql = format!(
        "SHOW FULL COLUMNS FROM {}",
        quote_mysql_table(schema, table)
    );
    let rows = query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let type_name = mysql_value_to_string(r, 1).unwrap_or_default();
            let nullable = mysql_value_to_string(r, 3).unwrap_or_default();
            let key = mysql_value_to_string(r, 4).unwrap_or_default();
            let default = mysql_value_to_string(r, 5);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key.eq_ignore_ascii_case("PRI"),
            })
        })
        .collect())
}

async fn list_indexes_mysql_show(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, SqlxError> {
    let sql = format!("SHOW INDEX FROM {}", quote_mysql_table(schema, table));
    let rows = query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    let mut parsed: Vec<(String, i64, String, bool)> = rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 2)?;
            let seq: i64 = r
                .try_get::<i64, _>(3)
                .ok()
                .or_else(|| {
                    r.try_get::<u64, _>(3)
                        .ok()
                        .and_then(|v| i64::try_from(v).ok())
                })
                .unwrap_or(0);
            let col = mysql_value_to_string(r, 4).unwrap_or_default();
            Some((name, seq, col, mysql_non_unique_is_unique(r, 1)))
        })
        .collect();
    parsed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(group_indexes(
        parsed
            .into_iter()
            .map(|(name, _seq, col, unique)| (name, col, unique)),
    ))
}

pub async fn list_schemas_mysql(pool: &Pool<MySql>) -> Result<Vec<SchemaInfo>, String> {
    let mut names = BTreeSet::new();
    let mut errors = Vec::new();

    match query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('information_schema','mysql','sys','performance_schema') \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for row in &rows {
                add_mysql_schema_name(&mut names, mysql_value_to_string(row, 0));
            }
        }
        Err(err) => errors.push(format!("information_schema.schemata: {err}")),
    }

    match list_schemas_mysql_show(pool).await {
        Ok(show_names) => {
            for name in show_names {
                add_mysql_schema_name(&mut names, Some(name));
            }
        }
        Err(err) => {
            if names.is_empty() {
                errors.push(format!("SHOW DATABASES: {err}"));
            }
        }
    }

    match current_mysql_database(pool).await {
        Ok(current) => add_mysql_schema_name(&mut names, current),
        Err(err) => errors.push(format!("SELECT DATABASE(): {err}")),
    }

    if names.is_empty() && !errors.is_empty() {
        return Err(format!("list schemas failed: {}", errors.join("; ")));
    }

    Ok(names.into_iter().map(|name| SchemaInfo { name }).collect())
}

pub async fn list_tables_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let q = if schema.is_some() {
        "SELECT table_name, table_type, table_rows FROM information_schema.tables \
         WHERE table_schema = ? ORDER BY table_name"
    } else {
        "SELECT table_name, table_type, table_rows FROM information_schema.tables \
         WHERE table_schema = DATABASE() ORDER BY table_name"
    };
    let mut query = query(q);
    if let Some(s) = schema {
        query = query.bind(s);
    }
    let mut tables = BTreeMap::<String, TableInfo>::new();
    let mut errors = Vec::new();

    match query.fetch_all(pool).await {
        Ok(rows) => {
            for r in &rows {
                if let Some(name) = mysql_value_to_string(r, 0) {
                    let table_type = mysql_value_to_string(r, 1).unwrap_or_default();
                    let row_count = r.try_get::<Option<i64>, _>(2).ok().flatten().or_else(|| {
                        r.try_get::<Option<u64>, _>(2)
                            .ok()
                            .flatten()
                            .and_then(|v| i64::try_from(v).ok())
                            .or_else(|| {
                                mysql_value_to_string(r, 2).and_then(|v| v.parse::<i64>().ok())
                            })
                    });
                    tables.insert(
                        name.clone(),
                        TableInfo {
                            name,
                            kind: mysql_table_kind(&table_type),
                            row_count,
                        },
                    );
                }
            }
        }
        Err(err) => errors.push(format!("information_schema.tables: {err}")),
    }

    match list_tables_mysql_show(pool, schema).await {
        Ok(show_tables) => {
            for table in show_tables {
                tables.entry(table.name.clone()).or_insert(table);
            }
        }
        Err(err) => {
            if tables.is_empty() {
                errors.push(format!("SHOW FULL TABLES: {err}"));
            }
        }
    }

    if tables.is_empty() && !errors.is_empty() {
        return Err(format!("list tables failed: {}", errors.join("; ")));
    }

    Ok(tables.into_values().collect())
}

pub async fn search_tables_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let sql = if schema.is_some() {
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = ? \
           AND LEFT(LOWER(table_name), CHAR_LENGTH(?)) = LOWER(?) \
         ORDER BY table_name LIMIT ?"
    } else {
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = DATABASE() \
           AND LEFT(LOWER(table_name), CHAR_LENGTH(?)) = LOWER(?) \
         ORDER BY table_name LIMIT ?"
    };
    let mut statement = query(sql);
    if let Some(schema) = schema {
        statement = statement.bind(schema);
    }
    let rows = statement
        .bind(prefix)
        .bind(prefix)
        .bind(limit as i64)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = mysql_value_to_string(row, 0)?;
            let table_type = mysql_value_to_string(row, 1).unwrap_or_default();
            Some(TableInfo {
                name,
                kind: mysql_table_kind(&table_type),
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let q = "SELECT column_name, column_type, is_nullable, column_default, column_key \
             FROM information_schema.columns \
             WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
             ORDER BY ordinal_position";
    let rows = match query(q).bind(schema).bind(table).fetch_all(pool).await {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => {
            return describe_table_mysql_show(pool, schema, table)
                .await
                .map_err(|e| format!("describe table failed: {e}"));
        }
        Err(err) => {
            return describe_table_mysql_show(pool, schema, table)
                .await
                .map_err(|show_err| {
                    format!(
                        "describe table failed: information_schema.columns: {err}; SHOW FULL COLUMNS: {show_err}"
                    )
                });
        }
    };
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let type_name = mysql_value_to_string(r, 1).unwrap_or_default();
            let nullable = mysql_value_to_string(r, 2).unwrap_or_default();
            let default = mysql_value_to_string(r, 3);
            let key = mysql_value_to_string(r, 4).unwrap_or_default();
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key.eq_ignore_ascii_case("PRI"),
            })
        })
        .collect())
}

pub async fn list_foreign_keys_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let rows = query(
        "SELECT constraint_name, column_name, referenced_table_schema, \
                referenced_table_name, referenced_column_name \
         FROM information_schema.key_column_usage \
         WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
           AND referenced_table_name IS NOT NULL \
         ORDER BY constraint_name, ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            mysql_value_to_string(row, 0)?,
            mysql_value_to_string(row, 1)?,
            mysql_value_to_string(row, 2),
            mysql_value_to_string(row, 3)?,
            mysql_value_to_string(row, 4)?,
        ))
    })))
}

pub async fn list_indexes_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let q = "SELECT index_name, column_name, non_unique \
             FROM information_schema.statistics \
             WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
             ORDER BY index_name, seq_in_index";
    let rows = match query(q).bind(schema).bind(table).fetch_all(pool).await {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => {
            return list_indexes_mysql_show(pool, schema, table)
                .await
                .map_err(|e| format!("list indexes failed: {e}"));
        }
        Err(err) => {
            return list_indexes_mysql_show(pool, schema, table)
                .await
                .map_err(|show_err| {
                    format!(
                        "list indexes failed: information_schema.statistics: {err}; SHOW INDEX: {show_err}"
                    )
                });
        }
    };
    Ok(group_indexes(rows.iter().filter_map(|r| {
        let name = mysql_value_to_string(r, 0)?;
        let col = mysql_value_to_string(r, 1).unwrap_or_default();
        // non_unique is 0 for unique indexes.
        Some((name, col, mysql_non_unique_is_unique(r, 2)))
    })))
}

// ---------------------------------------------------------------------------
// Schema introspection — SQL Server
// ---------------------------------------------------------------------------

fn quote_sqlserver_ident(ident: &str) -> String {
    format!("[{}]", ident.replace(']', "]]"))
}

fn sqlserver_qualified(schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!(
                "{}.{}",
                quote_sqlserver_ident(s),
                quote_sqlserver_ident(name)
            )
        }
        _ => quote_sqlserver_ident(name),
    }
}

fn sqlserver_default_schema(schema: Option<&str>) -> String {
    schema
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("dbo")
        .to_string()
}

fn sqlserver_text(row: &TdsRow, index: usize) -> Option<String> {
    sqlserver_value_to_string(row, index)
}

fn sqlserver_bool(row: &TdsRow, index: usize) -> bool {
    row.try_get::<bool, _>(index)
        .ok()
        .flatten()
        .unwrap_or(false)
}

fn sqlserver_i64(row: &TdsRow, index: usize) -> Option<i64> {
    row.try_get::<i64, _>(index)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i32, _>(index).ok().flatten().map(i64::from))
}

pub async fn list_schemas_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
) -> Result<Vec<SchemaInfo>, String> {
    let rows = sqlserver_fetch(
        client,
        "SELECT name FROM sys.schemas \
         WHERE name NOT IN (N'sys', N'INFORMATION_SCHEMA') \
         ORDER BY name",
        &[],
    )
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| sqlserver_text(r, 0))
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let params: [&dyn TdsToSql; 1] = [&schema_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT o.name, \
                CASE WHEN o.type = 'V' THEN N'view' ELSE N'table' END AS kind, \
                CASE WHEN o.type = 'U' THEN SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) ELSE NULL END AS row_count \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.partitions p ON p.object_id = o.object_id \
         WHERE s.name = @P1 AND o.type IN ('U','V') \
         GROUP BY o.name, o.type \
         ORDER BY o.name",
        &params,
    )
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;

    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = sqlserver_text(r, 0)?;
            let kind = sqlserver_text(r, 1).unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: sqlserver_i64(r, 2),
            })
        })
        .collect())
}

pub async fn search_tables_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let prefix_ref = prefix;
    let limit = i32::try_from(limit).unwrap_or(i32::MAX);
    let params: [&dyn TdsToSql; 3] = [&schema_ref, &prefix_ref, &limit];
    let rows = sqlserver_fetch(
        client,
        "SELECT TOP (@P3) o.name, \
                CASE WHEN o.type = 'V' THEN N'view' ELSE N'table' END AS kind \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.type IN ('U','V') \
           AND LEFT(LOWER(o.name), LEN(@P2)) = LOWER(@P2) \
         ORDER BY o.name",
        &params,
    )
    .await
    .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = sqlserver_text(row, 0)?;
            let kind = sqlserver_text(row, 1).unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT c.name, \
                t.name + \
                CASE \
                  WHEN t.name IN (N'varchar', N'char', N'varbinary', N'binary') \
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'max' ELSE CONVERT(nvarchar(16), c.max_length) END + N')' \
                  WHEN t.name IN (N'nvarchar', N'nchar') \
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'max' ELSE CONVERT(nvarchar(16), c.max_length / 2) END + N')' \
                  WHEN t.name IN (N'decimal', N'numeric') \
                    THEN N'(' + CONVERT(nvarchar(16), c.precision) + N',' + CONVERT(nvarchar(16), c.scale) + N')' \
                  WHEN t.name IN (N'time', N'datetime2', N'datetimeoffset') \
                    THEN N'(' + CONVERT(nvarchar(16), c.scale) + N')' \
                  ELSE N'' \
                END AS type_name, \
                c.is_nullable, dc.definition, \
                CASE WHEN pk.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_pk \
         FROM sys.columns c \
         JOIN sys.objects o ON o.object_id = c.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.types t ON t.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN ( \
             SELECT ic.object_id, ic.column_id \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             WHERE i.is_primary_key = 1 \
         ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
         WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U','V') \
         ORDER BY c.column_id",
        &params,
    )
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;

    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(ColumnDescription {
                name: sqlserver_text(r, 0)?,
                type_name: sqlserver_text(r, 1).unwrap_or_default(),
                nullable: sqlserver_bool(r, 2),
                default: sqlserver_text(r, 3),
                primary_key: sqlserver_bool(r, 4),
            })
        })
        .collect())
}

pub async fn list_foreign_keys_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT fk.name, parent_column.name, referenced_schema.name, \
                referenced_table.name, referenced_column.name \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.tables parent_table ON parent_table.object_id = fk.parent_object_id \
         JOIN sys.schemas parent_schema ON parent_schema.schema_id = parent_table.schema_id \
         JOIN sys.columns parent_column \
           ON parent_column.object_id = parent_table.object_id \
          AND parent_column.column_id = fkc.parent_column_id \
         JOIN sys.tables referenced_table ON referenced_table.object_id = fk.referenced_object_id \
         JOIN sys.schemas referenced_schema ON referenced_schema.schema_id = referenced_table.schema_id \
         JOIN sys.columns referenced_column \
           ON referenced_column.object_id = referenced_table.object_id \
          AND referenced_column.column_id = fkc.referenced_column_id \
         WHERE parent_schema.name = @P1 AND parent_table.name = @P2 \
         ORDER BY fk.name, fkc.constraint_column_id",
        &params,
    )
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            sqlserver_text(row, 0)?,
            sqlserver_text(row, 1)?,
            sqlserver_text(row, 2),
            sqlserver_text(row, 3)?,
            sqlserver_text(row, 4)?,
        ))
    })))
}

pub async fn list_indexes_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT i.name, c.name, i.is_unique \
         FROM sys.indexes i \
         JOIN sys.objects o ON o.object_id = i.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE s.name = @P1 AND o.name = @P2 AND i.name IS NOT NULL AND i.is_hypothetical = 0 \
         ORDER BY i.name, ic.key_ordinal, ic.index_column_id",
        &params,
    )
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;

    Ok(group_indexes(rows.iter().filter_map(|r| {
        Some((
            sqlserver_text(r, 0)?,
            sqlserver_text(r, 1).unwrap_or_default(),
            sqlserver_bool(r, 2),
        ))
    })))
}

// ---------------------------------------------------------------------------
// Schema introspection — PostgreSQL
// ---------------------------------------------------------------------------

pub async fn list_schemas_postgres(pool: &Pool<Postgres>) -> Result<Vec<SchemaInfo>, String> {
    let rows = query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT t.table_name, t.table_type, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM information_schema.tables t \
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid \
         WHERE t.table_schema = $1 ORDER BY t.table_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;
    let mut out: Vec<TableInfo> = rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let t: String = r.try_get(1).unwrap_or_default();
            let row_count: Option<i64> = r.try_get(2).ok().flatten();
            let kind = if t.eq_ignore_ascii_case("VIEW") {
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
        .collect();
    // Materialized views live in pg_matviews, not information_schema.
    if let Ok(mvs) = query("SELECT matviewname FROM pg_matviews WHERE schemaname = $1")
        .bind(schema)
        .fetch_all(pool)
        .await
    {
        for r in &mvs {
            if let Ok(name) = r.try_get::<String, _>(0) {
                out.push(TableInfo {
                    name,
                    kind: "materialized_view".to_string(),
                    row_count: None,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn search_tables_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT c.relname, \
                CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE 'table' END AS kind \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m') \
           AND LEFT(LOWER(c.relname), char_length($2)) = LOWER($2) \
         ORDER BY c.relname LIMIT $3",
    )
    .bind(schema)
    .bind(prefix)
    .bind(limit as i64)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let kind: String = row.try_get(1).unwrap_or_else(|_| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
            COALESCE(pk.is_pk, false) AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
            SELECT kcu.column_name, true AS is_pk \
            FROM information_schema.table_constraints tc \
            JOIN information_schema.key_column_usage kcu \
              ON tc.constraint_name = kcu.constraint_name \
             AND tc.table_schema = kcu.table_schema \
            WHERE tc.constraint_type = 'PRIMARY KEY' \
              AND tc.table_schema = $1 AND tc.table_name = $2 \
         ) pk ON pk.column_name = c.column_name \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let type_name: String = r.try_get(1).unwrap_or_default();
            let nullable: String = r.try_get(2).unwrap_or_default();
            let default: Option<String> = r.try_get(3).ok().flatten();
            let primary_key: bool = r.try_get(4).unwrap_or(false);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key,
            })
        })
        .collect())
}

pub async fn list_foreign_keys_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT fk.constraint_name, fk.column_name, pk.table_schema, \
                pk.table_name, pk.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage fk \
           ON fk.constraint_catalog = tc.constraint_catalog \
          AND fk.constraint_schema = tc.constraint_schema \
          AND fk.constraint_name = tc.constraint_name \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_catalog = tc.constraint_catalog \
          AND rc.constraint_schema = tc.constraint_schema \
          AND rc.constraint_name = tc.constraint_name \
         JOIN information_schema.key_column_usage pk \
           ON pk.constraint_catalog = rc.unique_constraint_catalog \
          AND pk.constraint_schema = rc.unique_constraint_schema \
          AND pk.constraint_name = rc.unique_constraint_name \
          AND pk.ordinal_position = fk.position_in_unique_constraint \
         WHERE tc.constraint_type = 'FOREIGN KEY' \
           AND tc.table_schema = $1 AND tc.table_name = $2 \
         ORDER BY fk.constraint_name, fk.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            row.try_get(0).ok()?,
            row.try_get(1).ok()?,
            row.try_get(2).ok(),
            row.try_get(3).ok()?,
            row.try_get(4).ok()?,
        ))
    })))
}

pub async fn list_indexes_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;
    Ok(group_indexes(rows.iter().filter_map(|r| {
        let name: String = r.try_get(0).ok()?;
        let col: String = r.try_get(1).unwrap_or_default();
        let unique: bool = r.try_get(2).unwrap_or(false);
        Some((name, col, unique))
    })))
}

/// Collapse an ordered (index_name, column, unique) stream into one
/// `IndexInfo` per index, preserving column order.
fn group_indexes(rows: impl Iterator<Item = (String, String, bool)>) -> Vec<IndexInfo> {
    let mut out: Vec<IndexInfo> = Vec::new();
    for (name, col, unique) in rows {
        if let Some(last) = out.last_mut().filter(|x| x.name == name) {
            last.columns.push(col);
        } else {
            out.push(IndexInfo {
                name,
                columns: vec![col],
                unique,
            });
        }
    }
    out
}

/// List routine-style objects (procedures, functions, triggers, events) for
/// MySQL. Returns an empty vec for kinds MySQL does not have.
pub async fn list_objects_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let (sql, owner_col) = match kind {
        "procedure" | "function" => (
            "SELECT routine_name FROM information_schema.routines \
             WHERE routine_schema = COALESCE(?, DATABASE()) AND routine_type = ? \
             ORDER BY routine_name",
            false,
        ),
        "trigger" => (
            "SELECT trigger_name, event_object_table FROM information_schema.triggers \
             WHERE trigger_schema = COALESCE(?, DATABASE()) ORDER BY trigger_name",
            true,
        ),
        "event" => (
            "SELECT event_name FROM information_schema.events \
             WHERE event_schema = COALESCE(?, DATABASE()) ORDER BY event_name",
            false,
        ),
        _ => return Ok(Vec::new()),
    };
    let mut q = query(sql).bind(schema);
    if kind == "procedure" || kind == "function" {
        q = q.bind(kind.to_uppercase());
    }
    let rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let owner = if owner_col {
                mysql_value_to_string(r, 1)
            } else {
                None
            };
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner,
            })
        })
        .collect())
}

/// List functions, sequences, and (defensively) other objects for PostgreSQL.
/// Materialized views are surfaced through `list_tables_postgres`.
pub async fn list_objects_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = schema.unwrap_or("public");
    let sql = match kind {
        "function" => {
            "SELECT DISTINCT p.proname FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 ORDER BY p.proname"
        }
        "sequence" => {
            "SELECT sequence_name FROM information_schema.sequences \
             WHERE sequence_schema = $1 ORDER BY sequence_name"
        }
        _ => return Ok(Vec::new()),
    };
    let rows = query(sql)
        .bind(schema)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner: None,
            })
        })
        .collect())
}

pub async fn list_objects_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let params: [&dyn TdsToSql; 1] = [&schema_ref];
    let (sql, owner_col) = match kind {
        "procedure" => (
            "SELECT o.name, CAST(NULL AS nvarchar(128)) AS owner \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('P','PC') ORDER BY o.name",
            false,
        ),
        "function" => (
            "SELECT o.name, CAST(NULL AS nvarchar(128)) AS owner \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('FN','IF','TF','FS','FT') ORDER BY o.name",
            false,
        ),
        "trigger" => (
            "SELECT tr.name, parent.name AS owner \
             FROM sys.triggers tr \
             JOIN sys.objects parent ON parent.object_id = tr.parent_id \
             JOIN sys.schemas s ON s.schema_id = parent.schema_id \
             WHERE s.name = @P1 ORDER BY tr.name",
            true,
        ),
        "sequence" => (
            "SELECT seq.name, CAST(NULL AS nvarchar(128)) AS owner \
             FROM sys.sequences seq JOIN sys.schemas s ON s.schema_id = seq.schema_id \
             WHERE s.name = @P1 ORDER BY seq.name",
            false,
        ),
        _ => return Ok(Vec::new()),
    };
    let rows = sqlserver_fetch(client, sql, &params)
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(DbObject {
                name: sqlserver_text(r, 0)?,
                kind: kind.to_string(),
                owner: if owner_col {
                    sqlserver_text(r, 1)
                } else {
                    None
                },
            })
        })
        .collect())
}

/// Backtick-quote and qualify a MySQL identifier.
fn mysql_qualified(schema: Option<&str>, name: &str) -> String {
    let esc = |s: &str| s.replace('`', "``");
    match schema {
        Some(s) if !s.is_empty() => format!("`{}`.`{}`", esc(s), esc(name)),
        _ => format!("`{}`", esc(name)),
    }
}

/// `SHOW CREATE …` for a MySQL object; returns the DDL column verbatim.
pub async fn object_ddl_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let verb = match kind {
        "view" => "VIEW",
        "procedure" => "PROCEDURE",
        "function" => "FUNCTION",
        "trigger" => "TRIGGER",
        "event" => "EVENT",
        _ => "TABLE",
    };
    let sql = format!("SHOW CREATE {verb} {}", mysql_qualified(schema, name));
    let token = CancellationToken::new();
    let res = execute_mysql(pool, &sql, &token).await?;
    // The DDL lives in the column whose name starts with "Create".
    let idx = res
        .columns
        .iter()
        .position(|c| c.name.to_ascii_lowercase().starts_with("create"))
        .unwrap_or(res.columns.len().saturating_sub(1));
    res.rows
        .first()
        .and_then(|r| r.get(idx).cloned().flatten())
        .ok_or_else(|| format!("No DDL returned for {name}"))
}

/// Reconstruct DDL / fetch definitions for PostgreSQL objects.
pub async fn object_ddl_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = schema.unwrap_or("public");
    match kind {
        "view" | "materialized_view" => {
            let row = query(
                "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
            )
            .bind(schema)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("view definition failed: {e}"))?;
            let def: String = row
                .and_then(|r| r.try_get::<String, _>(0).ok())
                .ok_or_else(|| format!("View {name} not found"))?;
            let kw = if kind == "materialized_view" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            Ok(format!(
                "CREATE OR REPLACE {kw} \"{schema}\".\"{name}\" AS\n{def}"
            ))
        }
        "function" => {
            let row = query(
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1",
            )
            .bind(schema)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("function definition failed: {e}"))?;
            row.and_then(|r| r.try_get::<String, _>(0).ok())
                .ok_or_else(|| format!("Function {name} not found"))
        }
        "sequence" => Ok(format!("CREATE SEQUENCE \"{schema}\".\"{name}\";")),
        _ => {
            // Tables: reconstruct a best-effort CREATE TABLE from the columns.
            let cols = describe_table_postgres(pool, Some(schema), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|c| {
                    let null = if c.nullable { "" } else { " NOT NULL" };
                    let default = c
                        .default
                        .as_ref()
                        .map(|d| format!(" DEFAULT {d}"))
                        .unwrap_or_default();
                    format!("  \"{}\" {}{}{}", c.name, c.type_name, null, default)
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| format!("\"{}\"", c.name))
                .collect();
            if !pks.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
            }
            Ok(format!(
                "CREATE TABLE \"{schema}\".\"{name}\" (\n{}\n);",
                lines.join(",\n")
            ))
        }
    }
}

pub async fn object_ddl_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = sqlserver_default_schema(schema);
    match kind {
        "view" | "procedure" | "function" | "trigger" => {
            let schema_ref = schema.as_str();
            let name_ref = name;
            let params: [&dyn TdsToSql; 2] = [&schema_ref, &name_ref];
            let rows = sqlserver_fetch(
                client,
                "SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@P1) + N'.' + QUOTENAME(@P2)))",
                &params,
            )
            .await
            .map_err(|e| format!("object definition failed: {e}"))?;
            rows.first()
                .and_then(|r| sqlserver_text(r, 0))
                .filter(|ddl| !ddl.trim().is_empty())
                .ok_or_else(|| format!("No DDL returned for {name}"))
        }
        "sequence" => Ok(format!(
            "CREATE SEQUENCE {};",
            sqlserver_qualified(Some(&schema), name)
        )),
        _ => {
            let cols = describe_table_sqlserver(client, Some(&schema), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|c| {
                    let null = if c.nullable { " NULL" } else { " NOT NULL" };
                    let default = c
                        .default
                        .as_ref()
                        .map(|d| format!(" DEFAULT {d}"))
                        .unwrap_or_default();
                    format!(
                        "  {} {}{}{}",
                        quote_sqlserver_ident(&c.name),
                        c.type_name,
                        null,
                        default
                    )
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| quote_sqlserver_ident(&c.name))
                .collect();
            if !pks.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
            }
            Ok(format!(
                "CREATE TABLE {} (\n{}\n);",
                sqlserver_qualified(Some(&schema), name),
                lines.join(",\n")
            ))
        }
    }
}

/// Table size / row estimates for MySQL.
pub async fn table_stats_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let rows = query(
        "SELECT engine, table_rows, data_length, index_length, data_free, \
                table_collation, create_time, update_time \
         FROM information_schema.tables \
         WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let pairs = vec![
        ("Engine", mysql_value_to_string(&rows, 0)),
        ("Estimated rows", mysql_value_to_string(&rows, 1)),
        ("Data length (bytes)", mysql_value_to_string(&rows, 2)),
        ("Index length (bytes)", mysql_value_to_string(&rows, 3)),
        ("Data free (bytes)", mysql_value_to_string(&rows, 4)),
        ("Collation", mysql_value_to_string(&rows, 5)),
        ("Created", mysql_value_to_string(&rows, 6)),
        ("Updated", mysql_value_to_string(&rows, 7)),
    ];
    Ok(super::metric_result(pairs))
}

/// Table size / row estimates for PostgreSQL.
pub async fn table_stats_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = schema.unwrap_or("public");
    let row = query(
        "SELECT pg_total_relation_size(c.oid), pg_relation_size(c.oid), \
                pg_indexes_size(c.oid), s.n_live_tup \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let num = |idx: usize| {
        row.try_get::<Option<i64>, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
    };
    let pairs = vec![
        ("Total size (bytes)", num(0)),
        ("Table size (bytes)", num(1)),
        ("Indexes size (bytes)", num(2)),
        ("Live rows (estimate)", num(3)),
    ];
    Ok(super::metric_result(pairs))
}

pub async fn table_stats_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS row_count, \
                SUM(a.total_pages) * 8192 AS reserved_bytes, \
                SUM(a.used_pages) * 8192 AS used_bytes, \
                SUM(a.data_pages) * 8192 AS data_bytes \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.partitions p ON p.object_id = o.object_id \
         LEFT JOIN sys.allocation_units a ON a.container_id = p.partition_id \
         WHERE s.name = @P1 AND o.name = @P2 AND o.type = 'U'",
        &params,
    )
    .await
    .map_err(|e| format!("table stats failed: {e}"))?;
    let row = rows
        .first()
        .ok_or_else(|| format!("Table {table} not found"))?;
    let pairs = vec![
        ("Rows", sqlserver_text(row, 0)),
        ("Reserved bytes", sqlserver_text(row, 1)),
        ("Used bytes", sqlserver_text(row, 2)),
        ("Data bytes", sqlserver_text(row, 3)),
    ];
    Ok(super::metric_result(pairs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_schema_names_include_visible_databases_and_deduplicate() {
        let mut names = BTreeSet::new();
        add_mysql_schema_name(&mut names, Some("mysql".into()));
        add_mysql_schema_name(&mut names, Some(" information_schema ".into()));
        add_mysql_schema_name(&mut names, Some("test".into()));
        add_mysql_schema_name(&mut names, Some("test".into()));
        add_mysql_schema_name(&mut names, Some("app".into()));

        assert_eq!(
            names.into_iter().collect::<Vec<_>>(),
            vec![
                "app".to_string(),
                "information_schema".to_string(),
                "mysql".to_string(),
                "test".to_string()
            ]
        );
    }

    #[test]
    fn mysql_identifier_quoting_escapes_backticks() {
        assert_eq!(quote_mysql_ident("te`st"), "`te``st`");
        assert_eq!(
            quote_mysql_table(Some("db`1"), "ta`ble"),
            "`db``1`.`ta``ble`"
        );
    }

    #[test]
    fn mysql_table_kind_maps_views() {
        assert_eq!(mysql_table_kind("VIEW"), "view");
        assert_eq!(mysql_table_kind("BASE TABLE"), "table");
    }

    #[test]
    fn sqlserver_identifier_quoting_escapes_brackets() {
        assert_eq!(quote_sqlserver_ident("te]st"), "[te]]st]");
        assert_eq!(
            sqlserver_qualified(Some("dbo]x"), "ta]ble"),
            "[dbo]]x].[ta]]ble]"
        );
    }

    #[test]
    fn sqlserver_default_schema_falls_back_to_dbo() {
        assert_eq!(sqlserver_default_schema(None), "dbo");
        assert_eq!(sqlserver_default_schema(Some("  ")), "dbo");
        assert_eq!(sqlserver_default_schema(Some("sales")), "sales");
    }

    #[test]
    fn query_detection_skips_leading_comments() {
        assert!(is_query("-- explain selected statement\nSELECT 1"));
        assert!(is_query("/* leading ; block */ SHOW TABLES"));
        assert!(is_query(
            "# mysql comment\nWITH cte AS (SELECT 1) SELECT * FROM cte"
        ));
        assert!(!is_query("-- mutate\nINSERT INTO t VALUES (1)"));
        assert!(!is_query("/* unterminated"));
    }

    #[test]
    fn mysql_use_requires_text_protocol() {
        assert!(needs_mysql_text_protocol("USE `app`"));
        assert!(needs_mysql_text_protocol("-- switch\nUSE app;"));
        assert!(!needs_mysql_text_protocol("INSERT INTO t VALUES (1)"));
        assert!(!needs_mysql_text_protocol("SELECT 1"));
    }

    #[test]
    fn parse_default_schema_switch_supports_common_dialects() {
        assert_eq!(
            parse_default_schema_switch("USE `ali-model-tools`"),
            Some("ali-model-tools".into())
        );
        assert_eq!(
            parse_default_schema_switch("use ecommerce;"),
            Some("ecommerce".into())
        );
        assert_eq!(
            parse_default_schema_switch(r#"SET search_path TO "sales""#),
            Some("sales".into())
        );
        assert_eq!(
            parse_default_schema_switch(r#"ALTER SESSION SET CURRENT_SCHEMA = "HR""#),
            Some("HR".into())
        );
        assert_eq!(parse_default_schema_switch("SELECT 1"), None);
    }
}
