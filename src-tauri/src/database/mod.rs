//! Database client backend: MySQL / PostgreSQL / StarRocks (via `sqlx`),
//! PanWeiDB (via the native openGauss connector), Oracle (via `rust-oracle`),
//! SQL Server (via `tiberius`), ClickHouse and Presto (via the existing
//! `reqwest` HTTP client), and Redis (via `redis-rs`).
//!
//! SQL engines surface a single Tauri command surface (`db_*`, with
//! `redis_*` for Redis). Live connections are cached in
//! [`crate::state::AppState::db_connections`] keyed by session id; a
//! [`DbSession`] wraps the per-engine handle plus a cancellation token used by
//! `db_cancel`.

pub mod clickhouse;
pub mod forward;
pub mod oracle;
pub mod panwei;
pub mod presto;
pub mod redis_ops;
pub mod sql;
pub mod bookmarks;
pub mod history;
pub mod query_workspace;
pub mod saved_queries;
pub mod sql_rewrite;

pub use bookmarks::*;
pub use history::*;
pub use query_workspace::*;
pub use saved_queries::*;

use serde::{Deserialize, Serialize};
use sqlx_core::pool::Pool;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

const DEFAULT_METADATA_SEARCH_LIMIT: usize = 100;
const MAX_METADATA_SEARCH_LIMIT: usize = 500;

fn metadata_search_limit(limit: Option<u32>) -> usize {
    usize::try_from(limit.unwrap_or(DEFAULT_METADATA_SEARCH_LIMIT as u32))
        .unwrap_or(MAX_METADATA_SEARCH_LIMIT)
        .clamp(1, MAX_METADATA_SEARCH_LIMIT)
}

/// Connection parameters supplied by the frontend. Mirrors the
/// `DbConnectInfo` TypeScript interface (camelCase over the IPC boundary).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    /// Backend engine: "MySQL" | "PostgreSQL" | "PanWeiDB" | "Oracle" | "SQLServer" | "StarRocks" | "ClickHouse" | "Presto" | "Redis".
    pub engine: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    /// Password or a `vault:<id>` reference (resolved server-side).
    #[serde(default)]
    pub password: Option<String>,
    /// Default database / schema name for SQL engines.
    #[serde(default)]
    pub database: Option<String>,
    /// Presto catalog name. Presto needs both catalog + schema to browse tables.
    #[serde(default)]
    pub catalog: Option<String>,
    /// TLS/SSL toggle.
    #[serde(default)]
    pub ssl: bool,
    /// Connection timeout in seconds (0 / absent → engine default).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// ClickHouse HTTP port (defaults to 8123 when absent).
    #[serde(default)]
    pub http_port: Option<u16>,
    /// ClickHouse protocol: "http" (default) or "native".
    #[serde(default)]
    pub protocol: Option<String>,
    /// Presto/Trino HTTP header dialect: "presto" (default) or "trino".
    /// Controls `X-Presto-*` vs `X-Trino-*` request/response headers.
    #[serde(default)]
    pub presto_dialect: Option<String>,
    /// Redis logical DB index (0-15).
    #[serde(default)]
    pub db_index: Option<i64>,
    /// Per-session network settings (proxy / SSH jump host). When present and
    /// non-`none`, the connection is routed through a loopback forwarder so the
    /// engine client reaches the target via the proxy/jump path. Mirrors the
    /// SSH terminal's `networkSettings` payload (camelCase).
    #[serde(default)]
    pub network_settings: Option<crate::terminal::network::NetworkSettings>,
}

/// A column descriptor in a query result set.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// Result of `db_execute`. Rows are arrays of nullable strings aligned with
/// `columns` — the frontend grid renders strings and a distinct NULL badge.
#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Option<String>>>,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    /// Server warnings / notices, when the engine exposes them.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Incremental query result event sent over a Tauri Channel. Query commands
/// send column metadata first, then row batches, then one final completion
/// event with timing and warning information.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueryStreamEvent {
    Columns {
        columns: Vec<ColumnInfo>,
    },
    Rows {
        rows: Vec<Vec<Option<String>>>,
    },
    Done {
        #[serde(rename = "rowsAffected")]
        rows_affected: u64,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        #[serde(default)]
        warnings: Vec<String>,
    },
}

pub type QueryStreamChannel = Channel<QueryStreamEvent>;

pub(crate) fn send_query_stream_event(
    on_event: &QueryStreamChannel,
    event: QueryStreamEvent,
) -> Result<(), String> {
    on_event
        .send(event)
        .map_err(|e| format!("Query stream event failed: {e}"))
}

pub(crate) fn emit_query_result_stream(
    on_event: &QueryStreamChannel,
    result: QueryResult,
) -> Result<(), String> {
    if !result.columns.is_empty() {
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Columns {
                columns: result.columns,
            },
        )?;
    }
    for rows in result.rows.chunks(100) {
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Rows {
                rows: rows.to_vec(),
            },
        )?;
    }
    send_query_stream_event(
        on_event,
        QueryStreamEvent::Done {
            rows_affected: result.rows_affected,
            duration_ms: result.duration_ms,
            warnings: result.warnings,
        },
    )
}

/// A schema/database node.
#[derive(Debug, Clone, Serialize)]
pub struct SchemaInfo {
    pub name: String,
}

/// A top-level catalog node (currently used by Presto/Trino).
#[derive(Debug, Clone, Serialize)]
pub struct CatalogInfo {
    pub name: String,
}

/// A table/view node.
#[derive(Debug, Clone, Serialize)]
pub struct TableInfo {
    pub name: String,
    /// "table" | "view" | "materialized_view".
    pub kind: String,
    /// Best-effort row count from engine catalog metadata. This may be
    /// approximate for engines that only expose estimates.
    #[serde(rename = "rowCount")]
    pub row_count: Option<i64>,
}

/// A column in a table description.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnDescription {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    #[serde(rename = "primaryKey")]
    pub primary_key: bool,
}

/// A foreign-key constraint and its ordered local/referenced columns.
#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(rename = "referencedSchema")]
    pub referenced_schema: Option<String>,
    #[serde(rename = "referencedTable")]
    pub referenced_table: String,
    #[serde(rename = "referencedColumns")]
    pub referenced_columns: Vec<String>,
}

pub(crate) fn group_foreign_keys(
    rows: impl Iterator<Item = (String, String, Option<String>, String, String)>,
) -> Vec<ForeignKeyInfo> {
    let mut result: Vec<ForeignKeyInfo> = Vec::new();
    for (name, column, referenced_schema, referenced_table, referenced_column) in rows {
        if let Some(existing) = result.last_mut().filter(|foreign_key| {
            foreign_key.name == name
                && foreign_key.referenced_schema == referenced_schema
                && foreign_key.referenced_table == referenced_table
        }) {
            existing.columns.push(column);
            existing.referenced_columns.push(referenced_column);
        } else {
            result.push(ForeignKeyInfo {
                name,
                columns: vec![column],
                referenced_schema,
                referenced_table,
                referenced_columns: vec![referenced_column],
            });
        }
    }
    result
}

/// Index metadata.
#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// A non-table schema object (routine, trigger, event, sequence, dictionary).
#[derive(Debug, Clone, Serialize)]
pub struct DbObject {
    pub name: String,
    /// Canonical kind: "procedure" | "function" | "trigger" | "event" |
    /// "sequence" | "dictionary".
    pub kind: String,
    /// Owning table for triggers (needed to DROP/DISABLE on PostgreSQL); None
    /// for objects that stand on their own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

/// The live, engine-specific connection handle. Held behind an `Arc` in
/// `AppState::db_connections`; SQL pools are internally `Send + Sync` so they
/// need no extra lock, while the Redis multiplexed connection is cloneable.
pub enum DbHandle {
    MySql(Pool<MySql>),
    Postgres(Pool<Postgres>),
    PanWeiDB(panwei::PanWeiClient),
    Oracle(oracle::OracleClient),
    SqlServer(Arc<AsyncMutex<sql::SqlServerClient>>),
    StarRocks(Pool<MySql>),
    ClickHouse(clickhouse::ClickHouseClient),
    Presto(presto::PrestoClient),
    Redis(AsyncMutex<redis::aio::MultiplexedConnection>),
}

/// A cached database session: the live handle + a cancellation token so
/// `db_cancel` can interrupt an in-flight query on the same session.
pub struct DbSession {
    pub handle: DbHandle,
    pub cancel: AsyncMutex<CancellationToken>,
    /// Last successful default schema/database from `USE` / `SET search_path`
    /// etc. Shared with pool `after_connect` hooks so reconnects restore it.
    pub active_schema: sql::ActiveSchemaSlot,
    shutdown: CancellationToken,
    keepalive: Option<JoinHandle<()>>,
    /// Loopback forwarder task when the connection is routed through a proxy /
    /// SSH jump host. Aborted on close to release the bound local port.
    forward: Option<JoinHandle<()>>,
}

impl DbSession {
    fn with_forward(
        handle: DbHandle,
        forward: Option<JoinHandle<()>>,
        active_schema: sql::ActiveSchemaSlot,
    ) -> Self {
        let shutdown = CancellationToken::new();
        let keepalive = start_keepalive(&handle, shutdown.clone());
        Self {
            handle,
            cancel: AsyncMutex::new(CancellationToken::new()),
            active_schema,
            shutdown,
            keepalive,
            forward,
        }
    }

    /// Replace the cancellation token with a fresh one and return it, so each
    /// query gets an independent token that `db_cancel` can trip.
    async fn fresh_cancel_token(&self) -> CancellationToken {
        let mut guard = self.cancel.lock().await;
        let token = CancellationToken::new();
        *guard = token.clone();
        token
    }

    /// Record a successful session default-schema switch so reconnects and
    /// engines with client-side default DB (ClickHouse) stay in sync.
    async fn note_schema_switch(&self, sql: &str) {
        let Some(schema) = sql::parse_default_schema_switch(sql) else {
            return;
        };
        *self.active_schema.lock().await = Some(schema.clone());
        if let DbHandle::ClickHouse(client) = &self.handle {
            client.set_database(schema);
        }
    }
}

fn start_keepalive(handle: &DbHandle, shutdown: CancellationToken) -> Option<JoinHandle<()>> {
    const KEEPALIVE_INTERVAL_SECS: u64 = 30;

    match handle {
        DbHandle::MySql(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_mysql(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::StarRocks(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_starrocks(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Postgres(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_postgres(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::PanWeiDB(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = panwei::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Oracle(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = oracle::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::SqlServer(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_sqlserver(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::ClickHouse(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = clickhouse::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Presto(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = presto::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Redis(_) => None,
    }
}

async fn close_session(session: Arc<DbSession>) {
    session.shutdown.cancel();
    if let Some(task) = &session.keepalive {
        task.abort();
    }
    if let Some(task) = &session.forward {
        task.abort();
    }
    session.cancel.lock().await.cancel();
    match &session.handle {
        DbHandle::MySql(pool) => pool.close().await,
        DbHandle::StarRocks(pool) => pool.close().await,
        DbHandle::Postgres(pool) => pool.close().await,
        DbHandle::PanWeiDB(_)
        | DbHandle::Oracle(_)
        | DbHandle::SqlServer(_)
        | DbHandle::ClickHouse(_)
        | DbHandle::Presto(_)
        | DbHandle::Redis(_) => {}
    }
}

/// Resolve a possibly-`vault:`-prefixed secret to plaintext. Returns the
/// original string when it is not a vault reference (backwards compatible with
/// inline plaintext passwords).
fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match state.vault.resolve(v)? {
            Some(z) => Ok(Some((*z).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<DbSession>, String> {
    let map = state.db_connections.read().await;
    map.get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active database connection for session {session_id}"))
}

// ---------------------------------------------------------------------------
// Tauri commands — connection lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DbConnectResult {
    pub ok: bool,
}

#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    session_id: String,
    config: DbConfig,
) -> Result<DbConnectResult, String> {
    let password = resolve_secret(&state, config.password.as_deref())?;

    // If the session is routed through a proxy / SSH jump host, stand up a
    // loopback forwarder and point the engine client at 127.0.0.1:<local>.
    // The forwarder bridges each connection to the real target through the
    // same proxy/jump machinery the SSH terminal uses.
    let (config, forward_task) = match prepare_network_forward(&state, &config).await? {
        Some((effective, task)) => (effective, Some(task)),
        None => (config, None),
    };

    let active_schema = sql::new_active_schema_slot(&config);
    let handle = match config.engine.as_str() {
        "MySQL" => {
            sql::connect_mysql(&config, password.as_deref(), active_schema.clone()).await?
        }
        "PostgreSQL" => {
            sql::connect_postgres(&config, password.as_deref(), active_schema.clone()).await?
        }
        "PanWeiDB" => panwei::connect(&config, password.as_deref()).await?,
        "Oracle" => oracle::connect(&config, password.as_deref()).await?,
        "SQLServer" => sql::connect_sqlserver(&config, password.as_deref()).await?,
        "StarRocks" => {
            sql::connect_starrocks(&config, password.as_deref(), active_schema.clone()).await?
        }
        "ClickHouse" => clickhouse::connect(&config, password.as_deref()).await?,
        "Presto" => presto::connect(&config, password.as_deref()).await?,
        "Redis" => redis_ops::connect(&config, password.as_deref()).await?,
        other => {
            if let Some(task) = forward_task {
                task.abort();
            }
            return Err(format!("Unsupported database engine: {other}"));
        }
    };
    let session = Arc::new(DbSession::with_forward(handle, forward_task, active_schema));
    let previous = {
        let mut map = state.db_connections.write().await;
        // If a stale session exists under this id, close it after releasing the map lock.
        map.insert(session_id, session)
    };
    if let Some(previous) = previous {
        close_session(previous).await;
    }
    Ok(DbConnectResult { ok: true })
}

/// The TCP port an engine actually dials for `config` — ClickHouse uses its
/// HTTP port (default 8123); every other engine uses `config.port`.
fn engine_target_port(config: &DbConfig) -> u16 {
    if config.engine == "ClickHouse" {
        config.http_port.unwrap_or(8123)
    } else {
        config.port
    }
}

/// When `config.network_settings` requests a proxy or SSH jump host, resolve
/// its secrets, start a loopback forwarder to the engine's real target, and
/// return an effective `DbConfig` whose host/port point at the local forward
/// plus the listener task. Returns `None` for direct connections.
async fn prepare_network_forward(
    state: &State<'_, AppState>,
    config: &DbConfig,
) -> Result<Option<(DbConfig, JoinHandle<()>)>, String> {
    let mut net = match &config.network_settings {
        Some(n) => n.clone(),
        None => return Ok(None),
    };
    let uses_proxy = !matches!(net.proxy_kind.as_str(), "" | "none");
    if !uses_proxy {
        return Ok(None);
    }

    // Resolve proxy + jump credentials (vault refs → plaintext, session-mode
    // jump host → DB lookup) exactly like the SSH terminal path.
    crate::terminal::resolve_proxy_session(state, &mut net)?;
    net.resolve_proxy_pass(&state.vault)?;
    crate::terminal::resolve_jump_credentials(state, &mut net)?;

    let target_host = config.host.clone();
    let target_port = engine_target_port(config);
    let fwd = forward::start(target_host, target_port, net).await?;

    // Rewrite the effective config to dial the loopback listener. ClickHouse
    // keys off http_port, so redirect that; everyone else uses `port`.
    let mut effective = config.clone();
    effective.host = "127.0.0.1".to_string();
    if config.engine == "ClickHouse" {
        effective.http_port = Some(fwd.local_port);
    } else {
        effective.port = fwd.local_port;
    }
    Ok(Some((effective, fwd.task)))
}

#[tauri::command]
pub async fn db_ping(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::ping_mysql(pool).await,
        DbHandle::Postgres(pool) => sql::ping_postgres(pool).await,
        DbHandle::PanWeiDB(client) => panwei::ping(client).await,
        DbHandle::Oracle(client) => oracle::ping(client).await,
        DbHandle::SqlServer(client) => sql::ping_sqlserver(client).await,
        DbHandle::StarRocks(pool) => sql::ping_starrocks(pool).await,
        DbHandle::ClickHouse(client) => clickhouse::ping(client).await,
        DbHandle::Presto(client) => presto::ping(client).await,
        DbHandle::Redis(conn) => redis_ops::ping(conn).await,
    }
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let removed = {
        let mut map = state.db_connections.write().await;
        map.remove(&session_id)
    };
    if let Some(session) = removed {
        close_session(session).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — SQL schema introspection + queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_list_catalogs(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<CatalogInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Presto(client) => presto::list_catalogs(client).await,
        DbHandle::MySql(_)
        | DbHandle::Postgres(_)
        | DbHandle::PanWeiDB(_)
        | DbHandle::Oracle(_)
        | DbHandle::SqlServer(_)
        | DbHandle::StarRocks(_)
        | DbHandle::ClickHouse(_)
        | DbHandle::Redis(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn db_list_schemas(
    state: State<'_, AppState>,
    session_id: String,
    catalog: Option<String>,
) -> Result<Vec<SchemaInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_schemas_mysql(pool).await,
        DbHandle::StarRocks(pool) => sql::list_schemas_mysql(pool).await,
        DbHandle::Postgres(pool) => sql::list_schemas_postgres(pool).await,
        DbHandle::PanWeiDB(client) => panwei::list_schemas(client).await,
        DbHandle::Oracle(client) => oracle::list_schemas(client).await,
        DbHandle::SqlServer(client) => sql::list_schemas_sqlserver(client).await,
        DbHandle::ClickHouse(client) => clickhouse::list_schemas(client).await,
        DbHandle::Presto(client) => presto::list_schemas(client, catalog.as_deref()).await,
        DbHandle::Redis(_) => Err("Redis has no SQL schemas".into()),
    }
}

#[tauri::command]
pub async fn db_list_tables(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    catalog: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_tables_mysql(pool, schema.as_deref()).await,
        DbHandle::StarRocks(pool) => sql::list_tables_mysql(pool, schema.as_deref()).await,
        DbHandle::Postgres(pool) => sql::list_tables_postgres(pool, schema.as_deref()).await,
        DbHandle::PanWeiDB(client) => panwei::list_tables(client, schema.as_deref()).await,
        DbHandle::Oracle(client) => oracle::list_tables(client, schema.as_deref()).await,
        DbHandle::SqlServer(client) => sql::list_tables_sqlserver(client, schema.as_deref()).await,
        DbHandle::ClickHouse(client) => clickhouse::list_tables(client, schema.as_deref()).await,
        DbHandle::Presto(client) => {
            presto::list_tables(client, catalog.as_deref(), schema.as_deref()).await
        }
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_search_tables(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    catalog: Option<String>,
    prefix: String,
    limit: Option<u32>,
) -> Result<Vec<TableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    let limit = metadata_search_limit(limit);
    match &session.handle {
        DbHandle::MySql(pool) => {
            sql::search_tables_mysql(pool, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::StarRocks(pool) => {
            sql::search_tables_mysql(pool, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::Postgres(pool) => {
            sql::search_tables_postgres(pool, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::search_tables(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::Oracle(client) => {
            oracle::search_tables(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::SqlServer(client) => {
            sql::search_tables_sqlserver(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::search_tables(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::Presto(client) => {
            presto::search_tables(
                client,
                catalog.as_deref(),
                schema.as_deref(),
                &prefix,
                limit,
            )
            .await
        }
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_describe_table(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<ColumnDescription>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::describe_table_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::StarRocks(pool) => {
            sql::describe_table_mysql(pool, schema.as_deref(), &table).await
        }
        DbHandle::Postgres(pool) => {
            sql::describe_table_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::describe_table(client, schema.as_deref(), &table).await
        }
        DbHandle::Oracle(client) => {
            oracle::describe_table(client, schema.as_deref(), &table).await
        }
        DbHandle::SqlServer(client) => {
            sql::describe_table_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::describe_table(client, schema.as_deref(), &table).await
        }
        DbHandle::Presto(client) => {
            presto::describe_table(client, catalog.as_deref(), schema.as_deref(), &table).await
        }
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_list_foreign_keys(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => {
            sql::list_foreign_keys_mysql(pool, schema.as_deref(), &table).await
        }
        DbHandle::Postgres(pool) => {
            sql::list_foreign_keys_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::list_foreign_keys(client, schema.as_deref(), &table).await
        }
        DbHandle::Oracle(client) => {
            oracle::list_foreign_keys(client, schema.as_deref(), &table).await
        }
        DbHandle::SqlServer(client) => {
            sql::list_foreign_keys_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::StarRocks(_) | DbHandle::ClickHouse(_) | DbHandle::Presto(_) => {
            let _ = catalog;
            Ok(Vec::new())
        }
        DbHandle::Redis(_) => Err("Redis has no foreign keys".into()),
    }
}

#[tauri::command]
pub async fn db_list_indexes(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_indexes_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::StarRocks(_) => Ok(Vec::new()),
        DbHandle::Postgres(pool) => {
            sql::list_indexes_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::list_indexes(client, schema.as_deref(), &table).await
        }
        DbHandle::Oracle(client) => {
            oracle::list_indexes(client, schema.as_deref(), &table).await
        }
        DbHandle::SqlServer(client) => {
            sql::list_indexes_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(_) => Ok(Vec::new()),
        DbHandle::Presto(client) => presto::list_indexes(client, schema.as_deref(), &table).await,
        DbHandle::Redis(_) => Err("Redis has no indexes".into()),
    }
}

#[tauri::command]
pub async fn db_list_objects(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    kind: String,
) -> Result<Vec<DbObject>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_objects_mysql(pool, schema.as_deref(), &kind).await,
        DbHandle::StarRocks(_) => Ok(Vec::new()),
        DbHandle::Postgres(pool) => {
            sql::list_objects_postgres(pool, schema.as_deref(), &kind).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::list_objects(client, schema.as_deref(), &kind).await
        }
        DbHandle::Oracle(client) => oracle::list_objects(client, schema.as_deref(), &kind).await,
        DbHandle::SqlServer(client) => {
            sql::list_objects_sqlserver(client, schema.as_deref(), &kind).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::list_objects(client, schema.as_deref(), &kind).await
        }
        DbHandle::Presto(client) => presto::list_objects(client, schema.as_deref(), &kind).await,
        DbHandle::Redis(_) => Err("Redis has no SQL objects".into()),
    }
}

#[tauri::command]
pub async fn db_object_ddl(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    kind: String,
    name: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::object_ddl_mysql(pool, schema.as_deref(), &kind, &name).await,
        DbHandle::StarRocks(pool) => {
            sql::object_ddl_mysql(pool, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Postgres(pool) => {
            sql::object_ddl_postgres(pool, schema.as_deref(), &kind, &name).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Oracle(client) => {
            oracle::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::SqlServer(client) => {
            sql::object_ddl_sqlserver(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Presto(client) => {
            presto::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Redis(_) => Err("Redis has no SQL objects".into()),
    }
}

#[tauri::command]
pub async fn db_table_stats(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> Result<QueryResult, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::table_stats_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::StarRocks(pool) => sql::table_stats_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::Postgres(pool) => {
            sql::table_stats_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => panwei::table_stats(client, schema.as_deref(), &table).await,
        DbHandle::Oracle(client) => oracle::table_stats(client, schema.as_deref(), &table).await,
        DbHandle::SqlServer(client) => {
            sql::table_stats_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::table_stats(client, schema.as_deref(), &table).await
        }
        DbHandle::Presto(client) => presto::table_stats(client, schema.as_deref(), &table).await,
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

/// Build a two-column ("Metric"/"Value") result from label/value pairs, used by
/// the per-engine `table_stats_*` helpers.
pub(crate) fn metric_result(pairs: Vec<(&str, Option<String>)>) -> QueryResult {
    QueryResult {
        columns: vec![
            ColumnInfo {
                name: "Metric".into(),
                type_name: "text".into(),
            },
            ColumnInfo {
                name: "Value".into(),
                type_name: "text".into(),
            },
        ],
        rows: pairs
            .into_iter()
            .map(|(label, value)| vec![Some(label.to_string()), value])
            .collect(),
        rows_affected: 0,
        duration_ms: 0,
        warnings: Vec::new(),
    }
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let session = get_session(&state, &session_id).await?;
    let token = session.fresh_cancel_token().await;
    let result = match &session.handle {
        DbHandle::MySql(pool) => sql::execute_mysql(pool, &sql, &token).await,
        DbHandle::StarRocks(pool) => sql::execute_mysql(pool, &sql, &token).await,
        DbHandle::Postgres(pool) => sql::execute_postgres(pool, &sql, &token).await,
        DbHandle::PanWeiDB(client) => panwei::execute(client, &sql, &token).await,
        DbHandle::Oracle(client) => oracle::execute(client, &sql, &token).await,
        DbHandle::SqlServer(client) => sql::execute_sqlserver(client, &sql, &token).await,
        DbHandle::ClickHouse(client) => clickhouse::execute(client, &sql, &token).await,
        DbHandle::Presto(client) => presto::execute(client, &sql, &token).await,
        DbHandle::Redis(_) => Err("Use redis_exec for Redis commands".into()),
    };
    if result.is_ok() {
        session.note_schema_switch(&sql).await;
    }
    result
}

#[tauri::command]
pub async fn db_execute_stream(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: Option<u64>,
    on_event: QueryStreamChannel,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let token = session.fresh_cancel_token().await;
    let result = match &session.handle {
        DbHandle::MySql(pool) => {
            sql::execute_mysql_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::StarRocks(pool) => {
            sql::execute_mysql_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Postgres(pool) => {
            sql::execute_postgres_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Oracle(client) => {
            oracle::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::SqlServer(client) => {
            sql::execute_sqlserver_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Presto(client) => {
            presto::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Redis(_) => Err("Use redis_exec for Redis commands".into()),
    };
    if result.is_ok() {
        session.note_schema_switch(&sql).await;
    }
    result
}

#[tauri::command]
pub async fn db_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    session.cancel.lock().await.cancel();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — Redis
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RedisKeyEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// TTL in seconds: -1 = persistent, -2 = missing, else seconds remaining.
    pub ttl: i64,
}

#[derive(Debug, Serialize)]
pub struct RedisScanPage {
    pub cursor: String,
    pub keys: Vec<RedisKeyEntry>,
}

#[derive(Debug, Serialize)]
pub struct RedisValue {
    /// "string" | "hash" | "list" | "set" | "zset" | "stream" | "none".
    pub kind: String,
    /// JSON-encoded value whose shape depends on `kind`. Strings → JSON string;
    /// hashes/zsets → array of [field,value]; lists/sets → array of strings;
    /// streams → array of {id, fields}.
    pub value: serde_json::Value,
    pub ttl: i64,
    pub encoding: Option<String>,
    #[serde(rename = "memoryUsage")]
    pub memory_usage: Option<i64>,
}

#[tauri::command]
pub async fn redis_list_keys(
    state: State<'_, AppState>,
    session_id: String,
    pattern: String,
    cursor: String,
    count: u64,
) -> Result<RedisScanPage, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::list_keys(conn, &pattern, &cursor, count).await,
        _ => Err("redis_list_keys requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_get_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> Result<RedisValue, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::get_key(conn, &key).await,
        _ => Err("redis_get_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_set_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    kind: String,
    value: serde_json::Value,
    ttl: Option<i64>,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::set_key(conn, &key, &kind, value, ttl).await,
        _ => Err("redis_set_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_del_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::del_key(conn, &key).await,
        _ => Err("redis_del_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_exec(
    state: State<'_, AppState>,
    session_id: String,
    raw_command: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::exec(conn, &raw_command).await,
        _ => Err("redis_exec requires a Redis session".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        group_foreign_keys, metadata_search_limit, DEFAULT_METADATA_SEARCH_LIMIT,
        MAX_METADATA_SEARCH_LIMIT,
    };

    #[test]
    fn metadata_search_limits_are_bounded() {
        assert_eq!(metadata_search_limit(None), DEFAULT_METADATA_SEARCH_LIMIT);
        assert_eq!(metadata_search_limit(Some(0)), 1);
        assert_eq!(metadata_search_limit(Some(25)), 25);
        assert_eq!(
            metadata_search_limit(Some(u32::MAX)),
            MAX_METADATA_SEARCH_LIMIT
        );
    }

    #[test]
    fn groups_composite_foreign_key_columns_in_order() {
        let foreign_keys = group_foreign_keys(
            vec![
                (
                    "orders_account_fk".to_string(),
                    "account_id".to_string(),
                    Some("public".to_string()),
                    "accounts".to_string(),
                    "id".to_string(),
                ),
                (
                    "orders_account_fk".to_string(),
                    "tenant_id".to_string(),
                    Some("public".to_string()),
                    "accounts".to_string(),
                    "tenant_id".to_string(),
                ),
            ]
            .into_iter(),
        );

        assert_eq!(foreign_keys.len(), 1);
        assert_eq!(foreign_keys[0].columns, ["account_id", "tenant_id"]);
        assert_eq!(foreign_keys[0].referenced_columns, ["id", "tenant_id"]);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Live Hologres smoke test for issue #101. It is ignored so normal test
    /// runs do not depend on the user's network or credentials.
    #[tokio::test]
    #[ignore = "requires TAOMNI_TEST_HOST1/TAOMNI_TEST_AK1/TAOMNI_TEST_SK1 and Hologres network access"]
    async fn hologres_postgres_session_lists_schemas_and_executes_query() {
        let host = std::env::var("TAOMNI_TEST_HOST1")
            .expect("TAOMNI_TEST_HOST1 must contain the Hologres PostgreSQL host");
        let username = std::env::var("TAOMNI_TEST_AK1")
            .expect("TAOMNI_TEST_AK1 must contain the Hologres access key");
        let password = std::env::var("TAOMNI_TEST_SK1")
            .expect("TAOMNI_TEST_SK1 must contain the Hologres secret key");
        let config = DbConfig {
            engine: "PostgreSQL".into(),
            host,
            port: 80,
            username: Some(username),
            password: Some(password),
            database: Some("cdp".into()),
            catalog: None,
            ssl: false,
            timeout_secs: Some(30),
            http_port: None,
            protocol: None,
            presto_dialect: None,
            db_index: None,
            network_settings: None,
        };

        let active_schema = sql::new_active_schema_slot(&config);
        let handle = sql::connect_postgres(&config, config.password.as_deref(), active_schema)
            .await
            .expect("Hologres PostgreSQL connect should succeed");
        let pool = match handle {
            DbHandle::Postgres(pool) => pool,
            _ => unreachable!("PostgreSQL config must create a Postgres pool"),
        };

        let schemas = sql::list_schemas_postgres(&pool)
            .await
            .expect("Hologres PostgreSQL schema listing should succeed");
        assert!(
            !schemas.is_empty(),
            "Hologres PostgreSQL schema listing should return at least one schema"
        );

        let result =
            sql::execute_postgres(&pool, "SELECT 1 AS taomni_smoke", &CancellationToken::new())
                .await
                .expect("Hologres PostgreSQL query execution should succeed");
        assert_eq!(result.columns[0].name, "taomni_smoke");
        assert_eq!(result.rows[0][0].as_deref(), Some("1"));

        pool.close().await;
    }
}
