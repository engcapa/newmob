//! High-level native HBase client: connection management, ZooKeeper bootstrap,
//! `hbase:meta` region location with caching, and the data/control plane
//! operations (get/put/delete/scan + list/describe/create/drop/status).
//!
//! This is the orchestration layer. It is deliberately synchronous-per-call
//! (locate region → RPC → parse) with a region-location cache; it does not yet
//! implement the full single-flight reconnect dance — on a NotServingRegion /
//! stale-cache error it invalidates the cached location and retries with a
//! bounded budget.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use prost::Message;
use tokio::sync::RwLock;

use super::cell::{self, Cell};
use super::proto::pb;
use super::region::{self, RegionLocation};
use super::rpc::codec::{CLIENT_SERVICE, MASTER_SERVICE};
use super::rpc::conn::{RpcConnection, RpcError};
use super::zk::{self, ServerEndpoint};

const META_TABLE: &str = "hbase:meta";
const MAX_RETRIES: usize = 6;
const BACKOFF_START_MS: u64 = 50;

/// Connection / bootstrap configuration for the native client.
#[derive(Debug, Clone)]
pub struct NativeConfig {
    /// Comma-separated `host:port` ZooKeeper quorum.
    pub zk_quorum: String,
    /// ZK root znode (default `/hbase`).
    pub zk_root: String,
    /// Effective user for simple auth.
    pub effective_user: String,
    /// Default namespace prefixed to unqualified table names.
    pub namespace: Option<String>,
    /// Connect/operation timeout.
    pub timeout: Duration,
    /// Authentication method (simple or Kerberos).
    pub auth: super::auth::AuthMethod,
}

impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            zk_quorum: "localhost:2181".into(),
            zk_root: zk::DEFAULT_ZK_ROOT.into(),
            effective_user: "root".into(),
            namespace: None,
            timeout: Duration::from_secs(15),
            auth: super::auth::AuthMethod::Simple,
        }
    }
}

#[derive(Debug)]
pub enum ClientError {
    Zk(String),
    Rpc(String),
    Region(String),
    Decode(String),
    Unsupported(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Zk(e) => write!(f, "{e}"),
            ClientError::Rpc(e) => write!(f, "{e}"),
            ClientError::Region(e) => write!(f, "{e}"),
            ClientError::Decode(e) => write!(f, "HBase decode error: {e}"),
            ClientError::Unsupported(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<RpcError> for ClientError {
    fn from(e: RpcError) -> Self {
        ClientError::Rpc(e.to_string())
    }
}

/// A get/scan cell row, flattened for the shell result table.
#[derive(Debug, Clone)]
pub struct ResultRow {
    pub row: Vec<u8>,
    pub column: Vec<u8>,
    pub timestamp: u64,
    pub value: Vec<u8>,
}

/// The native HBase client. Cheap to clone (shared connection pool + caches).
#[derive(Clone)]
pub struct NativeClient {
    cfg: Arc<NativeConfig>,
    /// addr -> connection to a RegionServer (ClientService).
    region_conns: Arc<RwLock<HashMap<String, RpcConnection>>>,
    /// Active master connection (MasterService), lazily established.
    master_conn: Arc<RwLock<Option<RpcConnection>>>,
    /// Cached meta RegionServer connection.
    meta_conn: Arc<RwLock<Option<RpcConnection>>>,
    /// table+row -> located region (simple cache, invalidated on NSRE).
    region_cache: Arc<RwLock<HashMap<String, RegionLocation>>>,
}

impl NativeClient {
    pub fn new(cfg: NativeConfig) -> Self {
        Self {
            cfg: Arc::new(cfg),
            region_conns: Arc::new(RwLock::new(HashMap::new())),
            master_conn: Arc::new(RwLock::new(None)),
            meta_conn: Arc::new(RwLock::new(None)),
            region_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Resolve a table name to its fully-qualified (namespace:qualifier) form.
    pub fn qualify(&self, table: &str) -> String {
        let t = table.trim();
        if t.contains(':') {
            return t.to_string();
        }
        match self.cfg.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => format!("{ns}:{t}"),
            _ => t.to_string(),
        }
    }

    /// Split a qualified table name into (namespace, qualifier) byte vectors.
    fn split_table(qualified: &str) -> (Vec<u8>, Vec<u8>) {
        match qualified.split_once(':') {
            Some((ns, q)) => (ns.as_bytes().to_vec(), q.as_bytes().to_vec()),
            None => (b"default".to_vec(), qualified.as_bytes().to_vec()),
        }
    }

    fn table_name_pb(qualified: &str) -> pb::TableName {
        let (ns, q) = Self::split_table(qualified);
        pb::TableName {
            namespace: ns,
            qualifier: q,
        }
    }

    /// Ping the cluster: resolve the master via ZK and call GetClusterStatus.
    pub async fn ping(&self) -> Result<String, ClientError> {
        let master = self.master().await?;
        let req = pb::GetClusterStatusRequest::default();
        let (resp, _) = master
            .call_pb::<_, pb::GetClusterStatusResponse>("GetClusterStatus", &req, None)
            .await?;
        let version = resp
            .cluster_status
            .hbase_version
            .map(|v| v.version)
            .unwrap_or_else(|| "unknown".into());
        Ok(format!("HBase native RPC connection OK ({version})"))
    }

    // ---- connection helpers ------------------------------------------------

    async fn region_connection(&self, ep: &ServerEndpoint) -> Result<RpcConnection, ClientError> {
        let addr = ep.addr();
        if let Some(conn) = self.region_conns.read().await.get(&addr).cloned() {
            return Ok(conn);
        }
        let conn = RpcConnection::connect_with_auth(
            &addr,
            CLIENT_SERVICE,
            &self.cfg.effective_user,
            &self.cfg.auth,
            self.cfg.timeout,
        )
        .await?;
        self.region_conns.write().await.insert(addr, conn.clone());
        Ok(conn)
    }

    async fn master(&self) -> Result<RpcConnection, ClientError> {
        if let Some(conn) = self.master_conn.read().await.clone() {
            return Ok(conn);
        }
        let ep = zk::locate_master(&self.cfg.zk_quorum, &self.cfg.zk_root, self.cfg.timeout)
            .await
            .map_err(|e| ClientError::Zk(e.to_string()))?;
        let conn = RpcConnection::connect_with_auth(
            &ep.addr(),
            MASTER_SERVICE,
            &self.cfg.effective_user,
            &self.cfg.auth,
            self.cfg.timeout,
        )
        .await?;
        *self.master_conn.write().await = Some(conn.clone());
        Ok(conn)
    }

    async fn meta_connection(&self) -> Result<RpcConnection, ClientError> {
        if let Some(conn) = self.meta_conn.read().await.clone() {
            return Ok(conn);
        }
        let ep = zk::locate_meta(&self.cfg.zk_quorum, &self.cfg.zk_root, self.cfg.timeout)
            .await
            .map_err(|e| ClientError::Zk(e.to_string()))?;
        let conn = RpcConnection::connect_with_auth(
            &ep.addr(),
            CLIENT_SERVICE,
            &self.cfg.effective_user,
            &self.cfg.auth,
            self.cfg.timeout,
        )
        .await?;
        *self.meta_conn.write().await = Some(conn.clone());
        Ok(conn)
    }

    // ---- region location ---------------------------------------------------

    /// Locate the region serving `(table, row)`, using the cache when possible.
    async fn locate_region(
        &self,
        qualified_table: &str,
        row: &[u8],
    ) -> Result<RegionLocation, ClientError> {
        let cache_key = format!("{qualified_table}\x00{}", String::from_utf8_lossy(row));
        if let Some(loc) = self.region_cache.read().await.get(&cache_key).cloned() {
            if loc.contains(row) {
                return Ok(loc);
            }
        }
        let loc = self.meta_lookup(qualified_table, row).await?;
        self.region_cache
            .write()
            .await
            .insert(cache_key, loc.clone());
        Ok(loc)
    }

    /// Invalidate any cached region location for `(table, row)`.
    async fn invalidate_region(&self, qualified_table: &str, row: &[u8]) {
        let cache_key = format!("{qualified_table}\x00{}", String::from_utf8_lossy(row));
        self.region_cache.write().await.remove(&cache_key);
    }

    /// Reverse-scan `hbase:meta` for the single region covering `(table, row)`.
    async fn meta_lookup(
        &self,
        qualified_table: &str,
        row: &[u8],
    ) -> Result<RegionLocation, ClientError> {
        let meta = self.meta_connection().await?;
        let search_key = region::meta_search_key(qualified_table, row);

        // A reversed scan from `table,row,:` returns the greatest meta row <=
        // the search key — i.e. the region whose range contains `row`. We fetch
        // a single row, so no stop_row is needed; supplying one with reversed
        // semantics risks excluding the very region we are looking for.
        let scan = pb::Scan {
            column: vec![pb::Column {
                family: b"info".to_vec(),
                qualifier: vec![],
            }],
            start_row: Some(search_key),
            reversed: Some(true),
            max_versions: Some(1),
            ..Default::default()
        };

        let region_spec = meta_region_specifier();
        let rows = scan_once(&meta, region_spec, scan, 1).await?;
        let (row_key, cells) = rows
            .into_iter()
            .next()
            .ok_or_else(|| ClientError::Region(format!("no meta entry for {qualified_table}")))?;
        // Guard against landing on a different table's region (e.g. when the
        // target table has no regions yet): verify the row key's table prefix.
        let prefix = region::meta_table_start_key(qualified_table);
        if !row_key.starts_with(&prefix) {
            return Err(ClientError::Region(format!(
                "no meta entry for {qualified_table}"
            )));
        }
        region::region_from_meta_cells(&row_key, &cells)
            .map_err(|e| ClientError::Region(e.to_string()))
    }

    // ---- data plane --------------------------------------------------------

    /// Get a single row, optionally restricted to one `family:qualifier`.
    pub async fn get(
        &self,
        table: &str,
        row: &[u8],
        column: Option<&str>,
    ) -> Result<Vec<ResultRow>, ClientError> {
        let qualified = self.qualify(table);
        let columns = column.map(|c| vec![parse_column(c)]).unwrap_or_default();
        let get = pb::Get {
            row: row.to_vec(),
            column: columns,
            max_versions: Some(1),
            ..Default::default()
        };

        self.with_region_retry(&qualified, row, |loc, conn| {
            let get = get.clone();
            async move {
                let req = pb::GetRequest {
                    region: region_specifier(&loc),
                    get,
                };
                let resp = conn.call("Get", Some(req.encode_to_vec()), None).await?;
                let get_resp = pb::GetResponse::decode(resp.param)
                    .map_err(|e| ClientError::Decode(e.to_string()))?;
                let cells = result_to_cells(get_resp.result.as_ref(), &resp.cell_block)?;
                Ok(cells_to_rows(&cells))
            }
        })
        .await
    }

    /// Put a single cell.
    pub async fn put(
        &self,
        table: &str,
        row: &[u8],
        column: &str,
        value: &[u8],
    ) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let (family, qualifier) = split_column(column);
        let cell = Cell {
            row: Bytes::copy_from_slice(row),
            family: Bytes::copy_from_slice(&family),
            qualifier: Bytes::copy_from_slice(&qualifier),
            timestamp: cell::LATEST_TIMESTAMP,
            cell_type: cell::cell_type::PUT,
            value: Bytes::copy_from_slice(value),
        };
        let mutation = pb::MutationProto {
            row: Some(row.to_vec()),
            mutate_type: Some(pb::mutation_proto::MutationType::Put as i32),
            associated_cell_count: Some(1),
            ..Default::default()
        };
        let cell_block = cell::encode_cell_block(&[cell]).to_vec();

        self.with_region_retry(&qualified, row, |loc, conn| {
            let mutation = mutation.clone();
            let cell_block = cell_block.clone();
            async move {
                let req = pb::MutateRequest {
                    region: region_specifier(&loc),
                    mutation,
                    condition: None,
                    nonce_group: None,
                };
                conn.call("Mutate", Some(req.encode_to_vec()), Some(cell_block))
                    .await?;
                Ok(())
            }
        })
        .await
    }

    /// Delete a single column (all versions) of a row.
    pub async fn delete(&self, table: &str, row: &[u8], column: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let (family, qualifier) = split_column(column);
        let mutation = pb::MutationProto {
            row: Some(row.to_vec()),
            mutate_type: Some(pb::mutation_proto::MutationType::Delete as i32),
            column_value: vec![pb::mutation_proto::ColumnValue {
                family: family.clone(),
                qualifier_value: vec![pb::mutation_proto::column_value::QualifierValue {
                    qualifier: Some(qualifier.clone()),
                    value: None,
                    timestamp: Some(cell::LATEST_TIMESTAMP),
                    delete_type: Some(
                        pb::mutation_proto::DeleteType::DeleteMultipleVersions as i32,
                    ),
                    tags: None,
                }],
            }],
            ..Default::default()
        };

        self.with_region_retry(&qualified, row, |loc, conn| {
            let mutation = mutation.clone();
            async move {
                let req = pb::MutateRequest {
                    region: region_specifier(&loc),
                    mutation,
                    condition: None,
                    nonce_group: None,
                };
                conn.call("Mutate", Some(req.encode_to_vec()), None).await?;
                Ok(())
            }
        })
        .await
    }

    /// Delete an entire row (all families/columns).
    pub async fn delete_all(&self, table: &str, row: &[u8]) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let mutation = pb::MutationProto {
            row: Some(row.to_vec()),
            mutate_type: Some(pb::mutation_proto::MutationType::Delete as i32),
            ..Default::default()
        };
        self.with_region_retry(&qualified, row, |loc, conn| {
            let mutation = mutation.clone();
            async move {
                let req = pb::MutateRequest {
                    region: region_specifier(&loc),
                    mutation,
                    condition: None,
                    nonce_group: None,
                };
                conn.call("Mutate", Some(req.encode_to_vec()), None).await?;
                Ok(())
            }
        })
        .await
    }

    /// Scan a table, returning up to `limit` cells, walking across regions.
    pub async fn scan(
        &self,
        table: &str,
        limit: usize,
        start_row: Option<&[u8]>,
        stop_row: Option<&[u8]>,
        columns: &[String],
    ) -> Result<Vec<ResultRow>, ClientError> {
        let qualified = self.qualify(table);
        let mut out: Vec<ResultRow> = Vec::new();
        let mut next_row: Vec<u8> = start_row.map(|r| r.to_vec()).unwrap_or_default();
        let column_specs: Vec<pb::Column> = columns.iter().map(|c| parse_column(c)).collect();

        for _ in 0..10_000 {
            if out.len() >= limit {
                break;
            }
            let loc = self.locate_region(&qualified, &next_row).await?;
            let conn = self.region_connection(&loc.server).await?;

            let scan = pb::Scan {
                column: column_specs.clone(),
                start_row: Some(next_row.clone()),
                stop_row: stop_row.map(|s| s.to_vec()),
                max_versions: Some(1),
                ..Default::default()
            };
            let remaining = limit - out.len();
            let rows = scan_once(
                &conn,
                region_specifier(&loc),
                scan,
                remaining.min(1000) as u32,
            )
            .await?;
            for (row_key, cells) in &rows {
                for c in cells {
                    out.push(cell_to_row(row_key, c));
                    if out.len() >= limit {
                        break;
                    }
                }
            }

            let end = loc.end_key().to_vec();
            if end.is_empty() {
                break;
            }
            if let Some(stop) = stop_row {
                if end.as_slice() >= stop {
                    break;
                }
            }
            next_row = end;
        }
        Ok(out)
    }

    /// Run `op` against the region serving `(table, row)`, invalidating the
    /// cache and retrying on NotServingRegion / connection errors.
    async fn with_region_retry<F, Fut, T>(
        &self,
        qualified_table: &str,
        row: &[u8],
        op: F,
    ) -> Result<T, ClientError>
    where
        F: Fn(RegionLocation, RpcConnection) -> Fut,
        Fut: std::future::Future<Output = Result<T, ClientError>>,
    {
        let mut backoff = BACKOFF_START_MS;
        let mut last_err: Option<ClientError> = None;
        for attempt in 0..MAX_RETRIES {
            let loc = match self.locate_region(qualified_table, row).await {
                Ok(l) => l,
                Err(e) => {
                    last_err = Some(e);
                    self.invalidate_region(qualified_table, row).await;
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                    backoff = (backoff * 2).min(5000);
                    continue;
                }
            };
            let conn = match self.region_connection(&loc.server).await {
                Ok(c) => c,
                Err(e) => {
                    last_err = Some(e);
                    self.drop_region_connection(&loc.server).await;
                    self.invalidate_region(qualified_table, row).await;
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                    backoff = (backoff * 2).min(5000);
                    continue;
                }
            };
            match op(loc.clone(), conn).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if is_retryable(&e) && attempt + 1 < MAX_RETRIES {
                        self.invalidate_region(qualified_table, row).await;
                        self.drop_region_connection(&loc.server).await;
                        tokio::time::sleep(Duration::from_millis(backoff)).await;
                        backoff = (backoff * 2).min(5000);
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| ClientError::Region("region retries exhausted".into())))
    }

    async fn drop_region_connection(&self, ep: &ServerEndpoint) {
        self.region_conns.write().await.remove(&ep.addr());
    }
}

// ---- control plane (MasterService) -----------------------------------------

/// A column family descriptor for `describe`.
#[derive(Debug, Clone)]
pub struct FamilyDesc {
    pub name: String,
    pub attributes: std::collections::BTreeMap<String, String>,
}

impl NativeClient {
    /// List user table names.
    pub async fn list_tables(&self) -> Result<Vec<String>, ClientError> {
        let master = self.master().await?;
        let req = pb::GetTableNamesRequest::default();
        let (resp, _) = master
            .call_pb::<_, pb::GetTableNamesResponse>("GetTableNames", &req, None)
            .await?;
        Ok(resp
            .table_names
            .into_iter()
            .map(|tn| qualify_table_name(&tn))
            .collect())
    }

    /// Describe a table's column families.
    pub async fn describe_table(
        &self,
        table: &str,
    ) -> Result<(String, Vec<FamilyDesc>), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let req = pb::GetTableDescriptorsRequest {
            table_names: vec![Self::table_name_pb(&qualified)],
            ..Default::default()
        };
        let (resp, _) = master
            .call_pb::<_, pb::GetTableDescriptorsResponse>("GetTableDescriptors", &req, None)
            .await?;
        let schema = resp
            .table_schema
            .into_iter()
            .next()
            .ok_or_else(|| ClientError::Region(format!("table not found: {qualified}")))?;
        let name = schema
            .table_name
            .as_ref()
            .map(qualify_table_name)
            .unwrap_or_else(|| qualified.clone());
        let families = schema
            .column_families
            .into_iter()
            .map(|cf| {
                let mut attributes = std::collections::BTreeMap::new();
                for attr in &cf.attributes {
                    attributes.insert(
                        String::from_utf8_lossy(&attr.first).into_owned(),
                        String::from_utf8_lossy(&attr.second).into_owned(),
                    );
                }
                for conf in &cf.configuration {
                    attributes.insert(conf.name.clone(), conf.value.clone());
                }
                FamilyDesc {
                    name: String::from_utf8_lossy(&cf.name).into_owned(),
                    attributes,
                }
            })
            .collect();
        Ok((name, families))
    }

    /// Create a table with the given column families.
    pub async fn create_table(
        &self,
        table: &str,
        families: &[(String, std::collections::BTreeMap<String, String>)],
    ) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let column_families = families
            .iter()
            .map(|(name, attrs)| pb::ColumnFamilySchema {
                name: name.as_bytes().to_vec(),
                attributes: attrs
                    .iter()
                    .map(|(k, v)| pb::BytesBytesPair {
                        first: k.as_bytes().to_vec(),
                        second: v.as_bytes().to_vec(),
                    })
                    .collect(),
                configuration: Vec::new(),
            })
            .collect();
        let req = pb::CreateTableRequest {
            table_schema: pb::TableSchema {
                table_name: Some(Self::table_name_pb(&qualified)),
                attributes: Vec::new(),
                column_families,
                configuration: Vec::new(),
            },
            split_keys: Vec::new(),
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::CreateTableResponse>("CreateTable", &req, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Poll `GetProcedureResult` until the master procedure `proc_id` finishes.
    async fn wait_for_procedure(
        &self,
        master: &RpcConnection,
        proc_id: u64,
    ) -> Result<(), ClientError> {
        let deadline = std::time::Instant::now() + self.cfg.timeout.max(Duration::from_secs(30));
        loop {
            let req = pb::GetProcedureResultRequest { proc_id };
            let (resp, _) = master
                .call_pb::<_, pb::GetProcedureResultResponse>("getProcedureResult", &req, None)
                .await?;
            use pb::get_procedure_result_response::State;
            match State::try_from(resp.state).unwrap_or(State::Running) {
                State::Finished => {
                    if let Some(exc) = resp.exception {
                        return Err(ClientError::Rpc(format!(
                            "procedure {proc_id} failed: {}",
                            exc.generic_exception
                                .and_then(|g| g.message)
                                .unwrap_or_else(|| "unknown".into())
                        )));
                    }
                    return Ok(());
                }
                State::NotFound => return Ok(()), // already reaped = done
                State::Running => {
                    if std::time::Instant::now() >= deadline {
                        return Err(ClientError::Rpc(format!(
                            "timed out waiting for procedure {proc_id}"
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }
    }

    /// Disable then delete a table.
    pub async fn drop_table(&self, table: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let tn = Self::table_name_pb(&qualified);

        // HBase requires a table to be disabled before deletion. Ignore "not
        // enabled" errors so a second drop / already-disabled table still works.
        let disable = pb::DisableTableRequest {
            table_name: tn.clone(),
            nonce_group: None,
            nonce: None,
        };
        match master
            .call_pb::<_, pb::DisableTableResponse>("DisableTable", &disable, None)
            .await
        {
            Ok((resp, _)) => {
                if let Some(proc_id) = resp.proc_id {
                    self.wait_for_procedure(&master, proc_id).await?;
                }
            }
            Err(e) => {
                // Tolerate "table already disabled" style errors; surface others.
                let msg = e.to_string();
                if !msg.contains("TableNotEnabled") && !msg.contains("not enabled") {
                    return Err(ClientError::Rpc(msg));
                }
            }
        }

        let del = pb::DeleteTableRequest {
            table_name: tn,
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::DeleteTableResponse>("DeleteTable", &del, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Enable a table.
    pub async fn enable_table(&self, table: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let req = pb::EnableTableRequest {
            table_name: Self::table_name_pb(&qualified),
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::EnableTableResponse>("EnableTable", &req, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Disable a table.
    pub async fn disable_table(&self, table: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let req = pb::DisableTableRequest {
            table_name: Self::table_name_pb(&qualified),
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::DisableTableResponse>("DisableTable", &req, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Add or modify column families (`alter`). For each spec, an existing
    /// family is modified, a new one is added. Returns the number of families
    /// changed.
    pub async fn alter_table(
        &self,
        table: &str,
        families: &[(String, std::collections::BTreeMap<String, String>)],
    ) -> Result<usize, ClientError> {
        let qualified = self.qualify(table);
        let (_, existing) = self.describe_table(table).await?;
        let existing_names: Vec<String> = existing.into_iter().map(|f| f.name).collect();
        let master = self.master().await?;
        let tn = Self::table_name_pb(&qualified);
        for (name, attrs) in families {
            let cf = pb::ColumnFamilySchema {
                name: name.as_bytes().to_vec(),
                attributes: attrs
                    .iter()
                    .map(|(k, v)| pb::BytesBytesPair {
                        first: k.as_bytes().to_vec(),
                        second: v.as_bytes().to_vec(),
                    })
                    .collect(),
                configuration: Vec::new(),
            };
            let proc_id = if existing_names.iter().any(|n| n == name) {
                let req = pb::ModifyColumnRequest {
                    table_name: tn.clone(),
                    column_families: cf,
                    nonce_group: None,
                    nonce: None,
                };
                master
                    .call_pb::<_, pb::ModifyColumnResponse>("ModifyColumn", &req, None)
                    .await?
                    .0
                    .proc_id
            } else {
                let req = pb::AddColumnRequest {
                    table_name: tn.clone(),
                    column_families: cf,
                    nonce_group: None,
                    nonce: None,
                };
                master
                    .call_pb::<_, pb::AddColumnResponse>("AddColumn", &req, None)
                    .await?
                    .0
                    .proc_id
            };
            if let Some(proc_id) = proc_id {
                self.wait_for_procedure(&master, proc_id).await?;
            }
        }
        Ok(families.len())
    }

    /// Cluster status as key/value pairs.
    pub async fn cluster_status(&self) -> Result<Vec<(String, String)>, ClientError> {
        let master = self.master().await?;
        let req = pb::GetClusterStatusRequest::default();
        let (resp, _) = master
            .call_pb::<_, pb::GetClusterStatusResponse>("GetClusterStatus", &req, None)
            .await?;
        let s = resp.cluster_status;
        let mut out = Vec::new();
        if let Some(v) = s.hbase_version {
            out.push(("hbaseVersion".into(), v.version));
        }
        out.push(("liveServers".into(), s.live_servers.len().to_string()));
        out.push(("deadServers".into(), s.dead_servers.len().to_string()));
        out.push((
            "regionsInTransition".into(),
            s.regions_in_transition.len().to_string(),
        ));
        if let Some(b) = s.balancer_on {
            out.push(("balancerOn".into(), b.to_string()));
        }
        if let Some(cid) = s.cluster_id {
            out.push(("clusterId".into(), cid.cluster_id));
        }
        Ok(out)
    }
}

// ---- free helpers ----------------------------------------------------------

/// Build a RegionSpecifier (by region name) for a located region.
fn region_specifier(loc: &RegionLocation) -> pb::RegionSpecifier {
    pb::RegionSpecifier {
        r#type: pb::region_specifier::RegionSpecifierType::RegionName as i32,
        value: loc.region_name.clone(),
    }
}

/// RegionSpecifier for the (single, well-known) `hbase:meta,,1` region.
fn meta_region_specifier() -> pb::RegionSpecifier {
    pb::RegionSpecifier {
        r#type: pb::region_specifier::RegionSpecifierType::RegionName as i32,
        value: b"hbase:meta,,1".to_vec(),
    }
}

/// Open a scanner, read one batch of up to `number_of_rows`, then close it.
/// Returns `(row_key, cells)` pairs. Used both for meta lookups and (per
/// region) user scans.
async fn scan_once(
    conn: &RpcConnection,
    region: pb::RegionSpecifier,
    scan: pb::Scan,
    number_of_rows: u32,
) -> Result<Vec<(Vec<u8>, Vec<Cell>)>, ClientError> {
    // Open: send the Scan, get a scanner_id + first batch.
    let open = pb::ScanRequest {
        region: Some(region),
        scan: Some(scan),
        number_of_rows: Some(number_of_rows),
        client_handles_partials: Some(true),
        client_handles_heartbeats: Some(true),
        ..Default::default()
    };
    let resp = conn.call("Scan", Some(open.encode_to_vec()), None).await?;
    let scan_resp =
        pb::ScanResponse::decode(resp.param).map_err(|e| ClientError::Decode(e.to_string()))?;
    let scanner_id = scan_resp.scanner_id;

    let mut rows = parse_scan_batch(&scan_resp, &resp.cell_block)?;

    // Pull more batches from the same region while results remain and we are
    // under the requested row count.
    let mut more_in_region = scan_resp.more_results_in_region.unwrap_or(false);
    if let Some(sid) = scanner_id {
        let mut guard = 0;
        while more_in_region && (rows.len() as u32) < number_of_rows && guard < 10_000 {
            guard += 1;
            let next = pb::ScanRequest {
                scanner_id: Some(sid),
                number_of_rows: Some(number_of_rows - rows.len() as u32),
                client_handles_partials: Some(true),
                client_handles_heartbeats: Some(true),
                ..Default::default()
            };
            let resp = conn.call("Scan", Some(next.encode_to_vec()), None).await?;
            let batch = pb::ScanResponse::decode(resp.param)
                .map_err(|e| ClientError::Decode(e.to_string()))?;
            let parsed = parse_scan_batch(&batch, &resp.cell_block)?;
            if parsed.is_empty() && !batch.more_results_in_region.unwrap_or(false) {
                break;
            }
            rows.extend(parsed);
            more_in_region = batch.more_results_in_region.unwrap_or(false);
        }

        // Best-effort close.
        let close = pb::ScanRequest {
            scanner_id: Some(sid),
            close_scanner: Some(true),
            number_of_rows: Some(0),
            ..Default::default()
        };
        let _ = conn.call("Scan", Some(close.encode_to_vec()), None).await;
    }

    Ok(rows)
}

/// Reconstruct `(row_key, cells)` from a ScanResponse + its cell block. Cells
/// arrive either inline (`results`) or in the cell block split by
/// `cells_per_result`.
fn parse_scan_batch(
    resp: &pb::ScanResponse,
    cell_block: &Bytes,
) -> Result<Vec<(Vec<u8>, Vec<Cell>)>, ClientError> {
    let mut out = Vec::new();

    if !resp.cells_per_result.is_empty() {
        // Cells are in the cell block; split by the per-result counts.
        let mut buf = cell_block.clone();
        for &count in &resp.cells_per_result {
            let mut cells = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let c = Cell::decode(&mut buf).map_err(|e| ClientError::Decode(e.to_string()))?;
                cells.push(c);
            }
            let row_key = cells.first().map(|c| c.row.to_vec()).unwrap_or_default();
            out.push((row_key, cells));
        }
    } else {
        // Cells are pb'd inline in `results`.
        for result in &resp.results {
            let cells: Vec<Cell> = result.cell.iter().map(pb_cell_to_cell).collect();
            let row_key = cells.first().map(|c| c.row.to_vec()).unwrap_or_default();
            out.push((row_key, cells));
        }
    }
    Ok(out)
}

/// Pull cells out of a Get/Mutate Result (inline or via the cell block).
fn result_to_cells(
    result: Option<&pb::Result>,
    cell_block: &Bytes,
) -> Result<Vec<Cell>, ClientError> {
    let Some(result) = result else {
        return Ok(Vec::new());
    };
    let assoc = result.associated_cell_count.unwrap_or(0);
    if assoc > 0 {
        let mut buf = cell_block.clone();
        let mut cells = Vec::with_capacity(assoc as usize);
        for _ in 0..assoc {
            cells.push(Cell::decode(&mut buf).map_err(|e| ClientError::Decode(e.to_string()))?);
        }
        Ok(cells)
    } else {
        Ok(result.cell.iter().map(pb_cell_to_cell).collect())
    }
}

fn pb_cell_to_cell(c: &pb::Cell) -> Cell {
    Cell {
        row: Bytes::copy_from_slice(c.row.as_deref().unwrap_or(&[])),
        family: Bytes::copy_from_slice(c.family.as_deref().unwrap_or(&[])),
        qualifier: Bytes::copy_from_slice(c.qualifier.as_deref().unwrap_or(&[])),
        timestamp: c.timestamp.unwrap_or(0),
        cell_type: c.cell_type.unwrap_or(0) as u8,
        value: Bytes::copy_from_slice(c.value.as_deref().unwrap_or(&[])),
    }
}

fn cells_to_rows(cells: &[Cell]) -> Vec<ResultRow> {
    cells.iter().map(|c| cell_to_row(&c.row, c)).collect()
}

fn cell_to_row(row_key: &[u8], c: &Cell) -> ResultRow {
    // Column is "family:qualifier".
    let mut column = Vec::with_capacity(c.family.len() + 1 + c.qualifier.len());
    column.extend_from_slice(&c.family);
    column.push(b':');
    column.extend_from_slice(&c.qualifier);
    ResultRow {
        row: row_key.to_vec(),
        column,
        timestamp: c.timestamp,
        value: c.value.to_vec(),
    }
}

/// Parse a `family:qualifier` (or bare `family`) into a `Column` spec.
fn parse_column(spec: &str) -> pb::Column {
    let (family, qualifier) = split_column(spec);
    pb::Column {
        family,
        qualifier: if qualifier.is_empty() {
            Vec::new()
        } else {
            vec![qualifier]
        },
    }
}

/// Split `family:qualifier` into (family, qualifier) byte vectors. A bare
/// `family` yields an empty qualifier.
fn split_column(spec: &str) -> (Vec<u8>, Vec<u8>) {
    match spec.split_once(':') {
        Some((f, q)) => (f.as_bytes().to_vec(), q.as_bytes().to_vec()),
        None => (spec.as_bytes().to_vec(), Vec::new()),
    }
}

/// Render a `TableName` proto as `namespace:qualifier` (dropping `default:`).
fn qualify_table_name(tn: &pb::TableName) -> String {
    let ns = String::from_utf8_lossy(&tn.namespace);
    let q = String::from_utf8_lossy(&tn.qualifier);
    if ns == "default" || ns.is_empty() {
        q.into_owned()
    } else {
        format!("{ns}:{q}")
    }
}

/// Whether a client error warrants a region-relocate + retry.
fn is_retryable(e: &ClientError) -> bool {
    let msg = e.to_string();
    msg.contains("NotServingRegion")
        || msg.contains("RegionMoved")
        || msg.contains("RegionOpening")
        || msg.contains("connection closed")
        || msg.contains("transport error")
        || msg.contains("CallQueueTooBig")
        || msg.contains("RegionTooBusy")
}

#[cfg(test)]
mod live_tests {
    //! Integration tests against a real HBase standalone cluster.
    //!
    //! These are gated behind `HBASE_LIVE_TEST=1` (and an optional
    //! `HBASE_ZK=host:port`, default `127.0.0.1:2181`) so the normal unit-test
    //! run stays hermetic. Run with:
    //! `HBASE_LIVE_TEST=1 cargo test --lib hbase::native::client::live_tests -- --nocapture --test-threads=1`
    use super::*;

    fn live_client() -> Option<NativeClient> {
        if std::env::var("HBASE_LIVE_TEST").ok().as_deref() != Some("1") {
            return None;
        }
        let zk = std::env::var("HBASE_ZK").unwrap_or_else(|_| "127.0.0.1:2181".into());
        Some(NativeClient::new(NativeConfig {
            zk_quorum: zk,
            zk_root: "/hbase".into(),
            effective_user: "test".into(),
            namespace: None,
            timeout: Duration::from_secs(20),
            auth: super::super::auth::AuthMethod::Simple,
        }))
    }

    #[tokio::test]
    async fn live_ping() {
        let Some(c) = live_client() else { return };
        let msg = c.ping().await.expect("ping failed");
        println!("PING: {msg}");
        assert!(msg.contains("OK"));
    }

    #[tokio::test]
    async fn live_full_lifecycle() {
        let Some(c) = live_client() else { return };
        let table = "taomni_native_it";
        let mut fam = std::collections::BTreeMap::new();
        fam.insert("VERSIONS".to_string(), "1".to_string());

        // Clean slate: drop if exists (ignore errors).
        let _ = c.drop_table(table).await;

        // create
        c.create_table(table, &[("cf".to_string(), fam)])
            .await
            .expect("create_table");
        println!("created {table}");

        // list contains it
        let tables = c.list_tables().await.expect("list_tables");
        println!("tables: {tables:?}");
        assert!(tables.iter().any(|t| t == table));

        // describe
        let (name, families) = c.describe_table(table).await.expect("describe");
        println!("describe {name}: {families:?}");
        assert!(families.iter().any(|f| f.name == "cf"));

        // put
        c.put(table, b"row1", "cf:q1", b"hello").await.expect("put");
        c.put(table, b"row2", "cf:q1", b"world")
            .await
            .expect("put2");
        println!("put 2 rows");

        // get
        let got = c.get(table, b"row1", Some("cf:q1")).await.expect("get");
        println!("get row1: {got:?}");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value, b"hello");

        // scan
        let scanned = c.scan(table, 100, None, None, &[]).await.expect("scan");
        println!("scan: {} cells", scanned.len());
        assert!(scanned.len() >= 2);

        // delete one column
        c.delete(table, b"row1", "cf:q1").await.expect("delete");
        let after = c.get(table, b"row1", Some("cf:q1")).await.expect("get2");
        println!("after delete row1: {after:?}");
        assert!(after.is_empty());

        // deleteall row2
        c.delete_all(table, b"row2").await.expect("delete_all");

        // drop
        c.drop_table(table).await.expect("drop_table");
        let tables = c.list_tables().await.expect("list2");
        assert!(!tables.iter().any(|t| t == table), "table still present");
        println!("dropped {table} — lifecycle OK");
    }
}
