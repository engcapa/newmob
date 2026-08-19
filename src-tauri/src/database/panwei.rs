//! PanWeiDB / openGauss-compatible backend via the native `tokio-opengauss`
//! connector. This is intentionally separate from the PostgreSQL `sqlx`
//! backend because PanWeiDB deployments can require openGauss SHA256
//! authentication that regular PostgreSQL clients do not implement.

use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::{Duration, Instant},
};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_opengauss::{
    Client as OgClient, Config as OgConfig, Error as OgError, NoTls, Row as OgRow,
    SimpleQueryMessage,
    config::SslMode,
    tls::{
        ChannelBinding as OgChannelBinding, MakeTlsConnect, TlsConnect, TlsStream as OgTlsStream,
    },
    types::ToSql,
};
use tokio_util::sync::CancellationToken;

use super::{
    ColumnDescription, ColumnInfo, DbConfig, DbHandle, DbObject, ForeignKeyInfo, IndexInfo,
    QueryResult, QueryStreamChannel, SchemaInfo, TableInfo, emit_query_result_stream,
    group_foreign_keys,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const FALLBACK_SCHEMA: &str = "public";

#[derive(Clone)]
struct PanWeiNativeTls {
    connector: tokio_native_tls::TlsConnector,
}

struct PanWeiNativeTlsConnect {
    connector: tokio_native_tls::TlsConnector,
    domain: String,
}

struct PanWeiNativeTlsStream<S>(tokio_native_tls::TlsStream<S>);

impl PanWeiNativeTls {
    fn new() -> Result<Self, native_tls::Error> {
        let mut builder = native_tls::TlsConnector::builder();
        // The UI currently exposes a single "encrypted connection" checkbox,
        // without CA/certificate pinning fields. Match SQL Server's existing
        // trust_cert behavior so self-signed intranet PanWeiDB deployments can
        // still get transport encryption.
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
        Ok(Self {
            connector: tokio_native_tls::TlsConnector::from(builder.build()?),
        })
    }
}

impl<S> MakeTlsConnect<S> for PanWeiNativeTls
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = PanWeiNativeTlsStream<S>;
    type TlsConnect = PanWeiNativeTlsConnect;
    type Error = native_tls::Error;

    fn make_tls_connect(&mut self, domain: &str) -> Result<Self::TlsConnect, Self::Error> {
        Ok(PanWeiNativeTlsConnect {
            connector: self.connector.clone(),
            domain: domain.to_string(),
        })
    }
}

impl<S> TlsConnect<S> for PanWeiNativeTlsConnect
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = PanWeiNativeTlsStream<S>;
    type Error = native_tls::Error;
    type Future =
        Pin<Box<dyn Future<Output = Result<PanWeiNativeTlsStream<S>, native_tls::Error>> + Send>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            self.connector
                .connect(&self.domain, stream)
                .await
                .map(PanWeiNativeTlsStream)
        })
    }
}

impl<S> AsyncRead for PanWeiNativeTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S> AsyncWrite for PanWeiNativeTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl<S> OgTlsStream for PanWeiNativeTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn channel_binding(&self) -> OgChannelBinding {
        OgChannelBinding::none()
    }
}

#[derive(Clone)]
pub struct PanWeiClient {
    inner: Arc<PanWeiInner>,
}

struct PanWeiInner {
    client: AsyncMutex<OgClient>,
    connection_task: JoinHandle<()>,
}

impl Drop for PanWeiInner {
    fn drop(&mut self) {
        self.connection_task.abort();
    }
}

impl PanWeiClient {
    fn new(client: OgClient, connection_task: JoinHandle<()>) -> Self {
        Self {
            inner: Arc::new(PanWeiInner {
                client: AsyncMutex::new(client),
                connection_task,
            }),
        }
    }
}

fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

fn build_connect_config(config: &DbConfig, password: Option<&str>) -> OgConfig {
    let mut opts = OgConfig::new();
    opts.host(&config.host)
        .port(config.port)
        .ssl_mode(if config.ssl {
            SslMode::Require
        } else {
            SslMode::Disable
        })
        .connect_timeout(timeout(config))
        .application_name("Taomni");
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts.user(user);
    }
    if let Some(pw) = password {
        opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts.dbname(db);
    }
    opts
}

fn spawn_connection_task<C>(connection: C) -> JoinHandle<()>
where
    C: Future<Output = Result<(), OgError>> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            log::debug!("PanWeiDB connection task ended: {e}");
        }
    })
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let opts = build_connect_config(config, password);

    if config.ssl {
        let tls = PanWeiNativeTls::new()
            .map_err(|e| format!("PanWeiDB TLS configuration failed: {e}"))?;
        let (client, connection) = tokio::time::timeout(timeout(config), opts.connect(tls))
            .await
            .map_err(|_| "PanWeiDB connect timed out".to_string())?
            .map_err(|e| format!("PanWeiDB TLS connect failed: {e}"))?;
        return Ok(DbHandle::PanWeiDB(PanWeiClient::new(
            client,
            spawn_connection_task(connection),
        )));
    }

    let (client, connection) = tokio::time::timeout(timeout(config), opts.connect(NoTls))
        .await
        .map_err(|_| "PanWeiDB connect timed out".to_string())?
        .map_err(|e| format!("PanWeiDB connect failed: {e}"))?;

    Ok(DbHandle::PanWeiDB(PanWeiClient::new(
        client,
        spawn_connection_task(connection),
    )))
}

pub async fn ping(client: &PanWeiClient) -> Result<String, String> {
    let guard = client.inner.client.lock().await;
    guard
        .execute("SELECT 1", &[])
        .await
        .map_err(|e| format!("PanWeiDB ping failed: {e}"))?;
    Ok("PanWeiDB connection OK".into())
}

fn simple_messages_to_result(messages: Vec<SimpleQueryMessage>, start: Instant) -> QueryResult {
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut rows_affected = 0;
    let mut warnings = Vec::new();

    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                let row_columns: Vec<ColumnInfo> = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: "text".to_string(),
                    })
                    .collect();
                if columns.is_empty() {
                    columns = row_columns;
                } else if columns.len() != row_columns.len()
                    || columns
                        .iter()
                        .zip(&row_columns)
                        .any(|(a, b)| a.name != b.name)
                {
                    warnings.push(
                        "Multiple result sets with different columns were flattened into one grid."
                            .to_string(),
                    );
                }

                let values = (0..row.len())
                    .map(|index| {
                        row.try_get(index)
                            .ok()
                            .flatten()
                            .map(|value| value.to_string())
                    })
                    .collect();
                rows.push(values);
            }
            SimpleQueryMessage::CommandComplete(count) => {
                rows_affected += count;
            }
            _ => {}
        }
    }

    QueryResult {
        rows_affected: if columns.is_empty() { rows_affected } else { 0 },
        columns,
        rows,
        duration_ms: start.elapsed().as_millis() as u64,
        warnings,
    }
}

async fn fetch(
    client: &PanWeiClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<OgRow>, String> {
    let guard = client.inner.client.lock().await;
    guard
        .query(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

async fn fetch_optional(
    client: &PanWeiClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Option<OgRow>, String> {
    let guard = client.inner.client.lock().await;
    guard
        .query_opt(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

fn is_user_schema_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed != "information_schema" && !trimmed.starts_with("pg_")
}

fn ordered_schema_infos(names: Vec<String>, preferred: Option<&str>) -> Vec<SchemaInfo> {
    let mut seen = std::collections::BTreeSet::new();
    let mut ordered = Vec::new();
    if let Some(preferred) = preferred
        .map(str::trim)
        .filter(|name| is_user_schema_name(name))
    {
        seen.insert(preferred.to_string());
        ordered.push(preferred.to_string());
    }
    for name in names {
        let name = name.trim();
        if is_user_schema_name(name) && seen.insert(name.to_string()) {
            ordered.push(name.to_string());
        }
    }
    ordered
        .into_iter()
        .map(|name| SchemaInfo { name })
        .collect()
}

async fn current_schema(client: &PanWeiClient) -> Result<Option<String>, String> {
    let row = fetch_optional(client, "SELECT current_schema()", &[]).await?;
    Ok(row
        .and_then(|row| row.try_get::<usize, String>(0).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty()))
}

async fn resolve_schema(client: &PanWeiClient, schema: Option<&str>) -> Result<String, String> {
    if let Some(schema) = schema.map(str::trim).filter(|schema| !schema.is_empty()) {
        return Ok(schema.to_string());
    }
    Ok(current_schema(client)
        .await?
        .filter(|schema| is_user_schema_name(schema))
        .unwrap_or_else(|| FALLBACK_SCHEMA.to_string()))
}

fn panwei_table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

fn panwei_relkind_to_kind(relkind: &str) -> Option<&'static str> {
    match relkind {
        "r" | "p" | "f" => Some("table"),
        "v" => Some("view"),
        "m" => Some("materialized_view"),
        _ => None,
    }
}

fn merge_table(tables: &mut std::collections::BTreeMap<String, TableInfo>, table: TableInfo) {
    tables.insert(table.name.clone(), table);
}

async fn list_tables_show(client: &PanWeiClient) -> Result<Vec<TableInfo>, String> {
    let guard = client.inner.client.lock().await;
    let messages = guard
        .simple_query("SHOW TABLES")
        .await
        .map_err(|e| format!("SHOW TABLES failed: {e}"))?;
    Ok(messages
        .into_iter()
        .filter_map(|message| match message {
            SimpleQueryMessage::Row(row) => row
                .try_get(0)
                .ok()
                .flatten()
                .map(|name: &str| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .map(|name| TableInfo {
                    name,
                    kind: "table".to_string(),
                    row_count: None,
                }),
            _ => None,
        })
        .collect())
}

fn should_use_show_tables_fallback(schema: &str, current: Option<&str>) -> bool {
    current
        .map(str::trim)
        .filter(|current| !current.is_empty())
        .is_some_and(|current| current == schema)
}

pub async fn execute(
    client: &PanWeiClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let guard = client.inner.client.lock().await;
    let cancel = guard.cancel_token();
    let run = guard.simple_query(sql);
    tokio::pin!(run);
    let messages = tokio::select! {
        _ = token.cancelled() => {
            let _ = cancel.cancel_query(NoTls).await;
            return Err("Query cancelled".into());
        }
        r = &mut run => r.map_err(|e| format!("Query failed: {e}"))?,
    };
    Ok(simple_messages_to_result(messages, start))
}

pub async fn execute_stream(
    client: &PanWeiClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let mut result = execute(client, sql, token).await?;
    if let Some(limit) = max_rows.filter(|value| *value > 0) {
        if result.rows.len() as u64 > limit {
            result.rows.truncate(limit as usize);
            result
                .warnings
                .push(format!("Result limited to {limit} rows"));
        }
    }
    emit_query_result_stream(on_event, result)
}

pub async fn list_schemas(client: &PanWeiClient) -> Result<Vec<SchemaInfo>, String> {
    let current = current_schema(client).await.ok().flatten();
    let rows = fetch(
        client,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' \
         ORDER BY schema_name",
        &[],
    )
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    let names = rows
        .iter()
        .filter_map(|row| row.try_get::<usize, String>(0).ok())
        .collect();
    Ok(ordered_schema_infos(names, current.as_deref()))
}

pub async fn list_tables(
    client: &PanWeiClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let current = current_schema(client).await.ok().flatten();
    let schema = schema
        .map(str::trim)
        .filter(|schema| !schema.is_empty())
        .map(str::to_string)
        .or_else(|| current.clone().filter(|schema| is_user_schema_name(schema)))
        .unwrap_or_else(|| FALLBACK_SCHEMA.to_string());
    let schema_ref = schema.as_str();
    let mut tables = std::collections::BTreeMap::<String, TableInfo>::new();
    let mut errors = Vec::new();

    match fetch(
        client,
        "SELECT t.table_name, t.table_type, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM information_schema.tables t \
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid \
         WHERE t.table_schema = $1 ORDER BY t.table_name",
        &[&schema_ref],
    )
    .await
    {
        Ok(rows) => {
            for row in &rows {
                let Some(name) = row.try_get::<usize, String>(0).ok() else {
                    continue;
                };
                let table_type: String = row.try_get(1).unwrap_or_default();
                let row_count: Option<i64> = row.try_get(2).ok().flatten();
                merge_table(
                    &mut tables,
                    TableInfo {
                        name,
                        kind: panwei_table_kind(&table_type),
                        row_count,
                    },
                );
            }
        }
        Err(err) => errors.push(format!("information_schema.tables: {err}")),
    }

    match fetch(
        client,
        "SELECT c.relname, c.relkind::text, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m') \
         ORDER BY c.relname",
        &[&schema_ref],
    )
    .await
    {
        Ok(rows) => {
            for row in &rows {
                let Some(name) = row.try_get::<usize, String>(0).ok() else {
                    continue;
                };
                let relkind: String = row.try_get(1).unwrap_or_default();
                let Some(kind) = panwei_relkind_to_kind(&relkind) else {
                    continue;
                };
                let row_count: Option<i64> = row.try_get(2).ok().flatten();
                merge_table(
                    &mut tables,
                    TableInfo {
                        name,
                        kind: kind.to_string(),
                        row_count,
                    },
                );
            }
        }
        Err(err) => errors.push(format!("pg_catalog.pg_class: {err}")),
    }

    if tables.is_empty() && should_use_show_tables_fallback(&schema, current.as_deref()) {
        match list_tables_show(client).await {
            Ok(show_tables) => {
                for table in show_tables {
                    merge_table(&mut tables, table);
                }
            }
            Err(err) => errors.push(err),
        }
    }

    if tables.is_empty() && !errors.is_empty() {
        return Err(format!("list tables failed: {}", errors.join("; ")));
    }

    Ok(tables.into_values().collect())
}

pub async fn search_tables(
    client: &PanWeiClient,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let prefix_ref = prefix;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = fetch(
        client,
        "SELECT c.relname, c.relkind::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m') \
           AND LEFT(LOWER(c.relname), char_length($2)) = LOWER($2) \
         ORDER BY c.relname LIMIT $3",
        &[&schema_ref, &prefix_ref, &limit],
    )
    .await
    .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row.try_get::<usize, String>(0).ok()?;
            let relkind: String = row.try_get(1).unwrap_or_default();
            let kind = panwei_relkind_to_kind(&relkind)?;
            Some(TableInfo {
                name,
                kind: kind.to_string(),
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let rows = match fetch(
        client,
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
        &[&schema_ref, &table],
    )
    .await
    {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) | Err(_) => {
            return describe_table_pg_catalog(client, schema_ref, table).await;
        }
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let type_name: String = row.try_get(1).unwrap_or_default();
            let nullable: String = row.try_get(2).unwrap_or_default();
            let default: Option<String> = row.try_get(3).ok().flatten();
            let primary_key: bool = row.try_get(4).unwrap_or(false);
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

pub async fn list_foreign_keys(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let rows = fetch(
        client,
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
        &[&schema_ref, &table],
    )
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

async fn describe_table_pg_catalog(
    client: &PanWeiClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let rows = fetch(
        client,
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
                EXISTS ( \
                    SELECT 1 \
                    FROM pg_catalog.pg_index i \
                    WHERE i.indrelid = c.oid \
                      AND i.indisprimary \
                      AND a.attnum = ANY(i.indkey) \
                ) AS is_pk \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
        &[&schema, &table],
    )
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let type_name: String = row.try_get(1).unwrap_or_default();
            let nullable: bool = row.try_get(2).unwrap_or(true);
            let default: Option<String> = row.try_get(3).ok().flatten();
            let primary_key: bool = row.try_get(4).unwrap_or(false);
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key,
            })
        })
        .collect())
}

pub async fn list_indexes(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let rows = fetch(
        client,
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
        &[&schema_ref, &table],
    )
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name: String = match row.try_get(0) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let column: String = row.try_get(1).unwrap_or_default();
        let unique: bool = row.try_get(2).unwrap_or(false);
        match grouped.iter_mut().find(|idx| idx.name == name) {
            Some(index) => index.columns.push(column),
            None => grouped.push(IndexInfo {
                name,
                columns: vec![column],
                unique,
            }),
        }
    }
    Ok(grouped)
}

pub async fn list_objects(
    client: &PanWeiClient,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
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
    let rows = fetch(client, sql, &[&schema_ref])
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner: None,
            })
        })
        .collect())
}

pub async fn object_ddl(
    client: &PanWeiClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    match kind {
        "view" | "materialized_view" => {
            let row = fetch_optional(
                client,
                "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[&schema_ref, &name],
            )
            .await
            .map_err(|e| format!("view definition failed: {e}"))?;
            let def: String = row
                .and_then(|row| row.try_get::<usize, String>(0).ok())
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
            let row = fetch_optional(
                client,
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1",
                &[&schema_ref, &name],
            )
            .await
            .map_err(|e| format!("function definition failed: {e}"))?;
            row.and_then(|row| row.try_get::<usize, String>(0).ok())
                .ok_or_else(|| format!("Function {name} not found"))
        }
        "sequence" => Ok(format!("CREATE SEQUENCE \"{schema}\".\"{name}\";")),
        _ => {
            let cols = describe_table(client, Some(schema_ref), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|column| {
                    let mut line = format!("  \"{}\" {}", column.name, column.type_name);
                    if !column.nullable {
                        line.push_str(" NOT NULL");
                    }
                    if let Some(default) = &column.default {
                        line.push_str(" DEFAULT ");
                        line.push_str(default);
                    }
                    line
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|column| column.primary_key)
                .map(|column| format!("\"{}\"", column.name))
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

pub async fn table_stats(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let row = fetch_optional(
        client,
        "SELECT pg_total_relation_size(c.oid), pg_relation_size(c.oid), \
                pg_indexes_size(c.oid), s.n_live_tup \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
         WHERE n.nspname = $1 AND c.relname = $2",
        &[&schema_ref, &table],
    )
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let num = |idx: usize| {
        row.try_get::<usize, Option<i64>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
    };
    Ok(super::metric_result(vec![
        ("Total size (bytes)", num(0)),
        ("Table size (bytes)", num(1)),
        ("Indexes size (bytes)", num(2)),
        ("Live rows (estimate)", num(3)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_current_schema_first_without_system_names() {
        let schemas = ordered_schema_infos(
            vec![
                "public".to_string(),
                "panwei_omm".to_string(),
                "information_schema".to_string(),
                "pg_catalog".to_string(),
            ],
            Some("panwei_omm"),
        );
        let names: Vec<_> = schemas.into_iter().map(|schema| schema.name).collect();
        assert_eq!(names, vec!["panwei_omm", "public"]);
    }

    #[test]
    fn maps_pg_relkind_to_object_kind() {
        assert_eq!(panwei_relkind_to_kind("r"), Some("table"));
        assert_eq!(panwei_relkind_to_kind("p"), Some("table"));
        assert_eq!(panwei_relkind_to_kind("v"), Some("view"));
        assert_eq!(panwei_relkind_to_kind("m"), Some("materialized_view"));
        assert_eq!(panwei_relkind_to_kind("i"), None);
    }

    #[test]
    fn show_tables_fallback_only_tracks_current_schema() {
        assert!(should_use_show_tables_fallback(
            "panwei_omm",
            Some("panwei_omm")
        ));
        assert!(!should_use_show_tables_fallback(
            "public",
            Some("panwei_omm")
        ));
        assert!(!should_use_show_tables_fallback("public", None));
    }

    #[test]
    fn config_uses_required_ssl_mode_when_tls_is_enabled() {
        let config = DbConfig {
            engine: "PanWeiDB".to_string(),
            host: "127.0.0.1".to_string(),
            port: 17700,
            username: Some("panwei_omm".to_string()),
            password: None,
            catalog: None,
            database: Some("panweidb".to_string()),
            ssl: true,
            timeout_secs: None,
            http_port: None,
            protocol: None,
            presto_dialect: None,
            db_index: None,
            network_settings: None,
        };
        assert_eq!(
            build_connect_config(&config, None).get_ssl_mode(),
            SslMode::Require
        );
    }

    #[test]
    fn config_disables_ssl_mode_when_tls_is_disabled() {
        let config = DbConfig {
            engine: "PanWeiDB".to_string(),
            host: "127.0.0.1".to_string(),
            port: 17700,
            username: Some("panwei_omm".to_string()),
            password: None,
            catalog: None,
            database: Some("panweidb".to_string()),
            ssl: false,
            timeout_secs: None,
            http_port: None,
            protocol: None,
            presto_dialect: None,
            db_index: None,
            network_settings: None,
        };
        assert_eq!(
            build_connect_config(&config, None).get_ssl_mode(),
            SslMode::Disable
        );
    }
}
