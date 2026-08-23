//! Thrift2-over-HTTP backend for Aliyun Lindorm / HBase 增强版 (port 9190).
//!
//! Lindorm exposes a standard Apache HBase `THBaseService` Thrift2 endpoint that
//! speaks `TBinaryProtocol` inside HTTP request/response bodies (the Thrift
//! "ThttpClient" transport). When ACL is enabled, auth is carried by two custom
//! HTTP headers: `ACCESSKEYID` (username) and `ACCESSSIGNATURE` (password). The
//! `idl` submodule holds bindings generated from the official IDL.
//!
//! The Apache Thrift Rust client is synchronous, so each operation runs inside
//! `tokio::task::spawn_blocking` and performs a blocking HTTP POST. Only plain
//! Rust values cross the await boundary, so no Thrift type needs to be `Send`.

mod idl;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{self, Cursor, Read, Write};
use std::rc::Rc;
use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use thrift::protocol::{TBinaryInputProtocol, TBinaryOutputProtocol};

use idl::{
    TColumn, TColumnFamilyDescriptor, TColumnValue, TDelete, TGet, THBaseServiceSyncClient,
    TIOError, TIllegalArgument, TPut, TResult, TScan, TTHBaseServiceSyncClient, TTableDescriptor,
    TTableName,
};

use super::HBaseConfig;
use super::native::client::ResultRow;

/// Concrete sync Thrift client over our one-shot HTTP channel.
type ThriftClient =
    THBaseServiceSyncClient<TBinaryInputProtocol<HttpChannel>, TBinaryOutputProtocol<HttpChannel>>;

/// Connection context for the Thrift2-over-HTTP backend. Cheap to clone (the
/// `reqwest::blocking::Client` is internally reference-counted), which lets each
/// operation move a copy into `spawn_blocking`.
#[derive(Clone)]
pub struct ThriftSession {
    client: reqwest::blocking::Client,
    url: String,
    headers: HeaderMap,
    namespace: Option<String>,
}

impl ThriftSession {
    pub fn new(config: &HBaseConfig, password: Option<String>) -> Result<Self, String> {
        let host = config.host.trim();
        if host.is_empty() {
            return Err("HBase Thrift host is required".into());
        }
        let scheme = if config.ssl { "https" } else { "http" };
        // The Thrift server serves the binary protocol at the root path.
        let url = format!("{scheme}://{host}:{}/", config.port);

        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/x-thrift"),
        );
        headers.insert(ACCEPT, HeaderValue::from_static("application/x-thrift"));
        // ACL auth headers (HTTP field names are case-insensitive, so the
        // lowercase form below is equivalent to the docs' ACCESSKEYID). Only
        // sent when a username is configured; Lindorm omits them when ACL is off.
        if let Some(user) = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            headers.insert(
                HeaderName::from_static("accesskeyid"),
                HeaderValue::from_str(user)
                    .map_err(|_| "Invalid HBase username for ACCESSKEYID header".to_string())?,
            );
            let pass = password.unwrap_or_default();
            headers.insert(
                HeaderName::from_static("accesssignature"),
                HeaderValue::from_str(&pass)
                    .map_err(|_| "Invalid HBase password for ACCESSSIGNATURE header".to_string())?,
            );
        }

        let timeout = Duration::from_secs(config.timeout_secs.unwrap_or(15).clamp(1, 300));
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| format!("HBase Thrift client build failed: {e}"))?;

        Ok(Self {
            client,
            url,
            headers,
            namespace: config.namespace.clone().filter(|s| !s.trim().is_empty()),
        })
    }

    /// Build a fresh sync client over a one-shot HTTP channel.
    fn connect(&self) -> ThriftClient {
        let chan = HttpChannel::new(self.client.clone(), self.url.clone(), self.headers.clone());
        let i_prot = TBinaryInputProtocol::new(chan.clone(), true);
        let o_prot = TBinaryOutputProtocol::new(chan, true);
        THBaseServiceSyncClient::new(i_prot, o_prot)
    }

    /// Parse a (possibly namespaced) table string into a `TTableName` for the
    /// admin methods (`ns:qualifier`, or bare qualifier in the session namespace).
    fn table_name(&self, table: &str) -> TTableName {
        table_name_of(self.namespace.as_deref(), table)
    }

    /// Table bytes (`ns:qualifier`) for the data methods (get/put/scan/delete).
    fn qualified(&self, table: &str) -> Vec<u8> {
        qualify(self.namespace.as_deref(), table)
    }
}

impl ThriftSession {
    pub async fn ping(&self) -> Result<String, String> {
        let ctx = self.clone();
        run(move || {
            let mut c = ctx.connect();
            // Cheapest call that proves both reachability and auth. There is no
            // permission-free probe, so an access-denied response here still
            // means we authenticated successfully — the account just lacks
            // GLOBAL list permission. Treat that as a (limited) connection
            // rather than failing, so ACL-restricted users can still operate on
            // the tables they do have access to.
            match c.get_table_names_by_pattern(".*".to_string(), true) {
                Ok(_) => Ok("HBase Thrift2 connection OK".to_string()),
                Err(e) => {
                    let msg = thrift_err(e);
                    if msg.contains("AccessDenied") || msg.contains("Access denied") {
                        Ok(
                            "HBase Thrift2 connection OK (authenticated; limited ACL permissions)"
                                .to_string(),
                        )
                    } else {
                        Err(msg)
                    }
                }
            }
        })
        .await
    }

    pub async fn list_tables(&self) -> Result<Vec<String>, String> {
        let ctx = self.clone();
        run(move || {
            let mut c = ctx.connect();
            let names = c
                .get_table_names_by_pattern(".*".to_string(), false)
                .map_err(thrift_err)?;
            Ok(names.iter().map(render_table_name).collect())
        })
        .await
    }

    pub async fn describe_table(
        &self,
        table: &str,
    ) -> Result<(String, Vec<(String, BTreeMap<String, String>)>), String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        let display = render_table_name(&tn);
        run(move || {
            let mut c = ctx.connect();
            let desc = c.get_table_descriptor(tn).map_err(thrift_err)?;
            Ok((display, families_of(&desc)))
        })
        .await
    }

    pub async fn create_table(
        &self,
        table: &str,
        families: &[(String, BTreeMap<String, String>)],
    ) -> Result<(), String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        let columns: Vec<TColumnFamilyDescriptor> = families
            .iter()
            .map(|(name, attrs)| tcfd(name, attrs))
            .collect();
        run(move || {
            let mut c = ctx.connect();
            c.create_table(ttd(tn, columns), Vec::new())
                .map_err(thrift_err)
        })
        .await
    }

    pub async fn drop_table(&self, table: &str) -> Result<(), String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        run(move || {
            let mut c = ctx.connect();
            // HBase requires disabling a table before deleting it. The disable
            // is best-effort: an already-disabled table makes it error, which
            // must not block the delete.
            let _ = c.disable_table(tn.clone());
            c.delete_table(tn).map_err(thrift_err)
        })
        .await
    }

    pub async fn enable_table(&self, table: &str) -> Result<(), String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        run(move || {
            let mut c = ctx.connect();
            c.enable_table(tn).map_err(thrift_err)
        })
        .await
    }

    pub async fn disable_table(&self, table: &str) -> Result<(), String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        run(move || {
            let mut c = ctx.connect();
            c.disable_table(tn).map_err(thrift_err)
        })
        .await
    }

    pub async fn table_exists(&self, table: &str) -> Result<bool, String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        run(move || {
            let mut c = ctx.connect();
            c.table_exists(tn).map_err(thrift_err)
        })
        .await
    }

    /// Add or modify column families (`alter`). Returns the number changed.
    pub async fn alter_table(
        &self,
        table: &str,
        families: &[(String, BTreeMap<String, String>)],
    ) -> Result<usize, String> {
        let ctx = self.clone();
        let tn = self.table_name(table);
        let names: Vec<String> = families.iter().map(|(n, _)| n.clone()).collect();
        let specs: Vec<TColumnFamilyDescriptor> = families
            .iter()
            .map(|(name, attrs)| tcfd(name, attrs))
            .collect();
        run(move || {
            let mut c = ctx.connect();
            let desc = c.get_table_descriptor(tn.clone()).map_err(thrift_err)?;
            let existing: Vec<String> = families_of(&desc).into_iter().map(|(n, _)| n).collect();
            for (i, cf) in specs.into_iter().enumerate() {
                if existing.iter().any(|n| n == &names[i]) {
                    c.modify_column_family(tn.clone(), cf).map_err(thrift_err)?;
                } else {
                    c.add_column_family(tn.clone(), cf).map_err(thrift_err)?;
                }
            }
            Ok(names.len())
        })
        .await
    }

    pub async fn get(
        &self,
        table: &str,
        row: &[u8],
        column: Option<&str>,
    ) -> Result<Vec<ResultRow>, String> {
        let ctx = self.clone();
        let table_bytes = self.qualified(table);
        let row = row.to_vec();
        let columns = column.map(|c| vec![parse_column(c)]);
        run(move || {
            let mut c = ctx.connect();
            let res = c.get(table_bytes, tget(row, columns)).map_err(thrift_err)?;
            Ok(result_to_rows(&res))
        })
        .await
    }

    pub async fn scan(
        &self,
        table: &str,
        limit: usize,
        start_row: Option<&[u8]>,
        stop_row: Option<&[u8]>,
        columns: &[String],
    ) -> Result<Vec<ResultRow>, String> {
        let ctx = self.clone();
        let table_bytes = self.qualified(table);
        let n = limit.clamp(1, 10_000) as i32;
        let start = start_row.map(|b| b.to_vec());
        let stop = stop_row.map(|b| b.to_vec());
        let cols: Option<Vec<TColumn>> = if columns.is_empty() {
            None
        } else {
            Some(columns.iter().map(|c| parse_column(c)).collect())
        };
        run(move || {
            let mut c = ctx.connect();
            let tscan = TScan {
                start_row: start,
                stop_row: stop,
                columns: cols,
                limit: Some(n),
                ..Default::default()
            };
            let results = c
                .get_scanner_results(table_bytes, tscan, n)
                .map_err(thrift_err)?;
            let mut rows = Vec::new();
            for r in &results {
                rows.extend(result_to_rows(r));
            }
            Ok(rows)
        })
        .await
    }

    pub async fn put(
        &self,
        table: &str,
        row: &[u8],
        column: &str,
        value: &[u8],
    ) -> Result<(), String> {
        let ctx = self.clone();
        let table_bytes = self.qualified(table);
        let (family, qualifier) = split_column(column)?;
        let row = row.to_vec();
        let value = value.to_vec();
        run(move || {
            let mut c = ctx.connect();
            let put = tput(row, vec![tcv(family, qualifier, value)]);
            c.put(table_bytes, put).map_err(thrift_err)
        })
        .await
    }

    pub async fn delete(&self, table: &str, row: &[u8], column: &str) -> Result<(), String> {
        let ctx = self.clone();
        let table_bytes = self.qualified(table);
        let col = parse_column(column);
        let row = row.to_vec();
        run(move || {
            let mut c = ctx.connect();
            c.delete_single(table_bytes, tdelete(row, Some(vec![col])))
                .map_err(thrift_err)
        })
        .await
    }

    pub async fn delete_all(&self, table: &str, row: &[u8]) -> Result<(), String> {
        let ctx = self.clone();
        let table_bytes = self.qualified(table);
        let row = row.to_vec();
        run(move || {
            let mut c = ctx.connect();
            // No columns => delete the whole row.
            c.delete_single(table_bytes, tdelete(row, None))
                .map_err(thrift_err)
        })
        .await
    }
}

// ---- HTTP store-and-forward Thrift transport -------------------------------

/// A Thrift transport that buffers the outgoing protocol bytes and, on `flush`,
/// POSTs them as one HTTP request and stashes the response for the read side.
/// Shared by the input and output protocols (single-threaded inside one
/// `spawn_blocking` call, so `Rc<RefCell<..>>` is sufficient).
#[derive(Clone)]
struct HttpChannel(Rc<RefCell<ChannelState>>);

struct ChannelState {
    client: reqwest::blocking::Client,
    url: String,
    headers: HeaderMap,
    out: Vec<u8>,
    inp: Cursor<Vec<u8>>,
}

impl HttpChannel {
    fn new(client: reqwest::blocking::Client, url: String, headers: HeaderMap) -> Self {
        HttpChannel(Rc::new(RefCell::new(ChannelState {
            client,
            url,
            headers,
            out: Vec::new(),
            inp: Cursor::new(Vec::new()),
        })))
    }
}

impl Write for HttpChannel {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().out.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut st = self.0.borrow_mut();
        let body = std::mem::take(&mut st.out);
        let resp = st
            .client
            .post(&st.url)
            .headers(st.headers.clone())
            .body(body)
            .send()
            .map_err(|e| {
                io::Error::new(
                    io::ErrorKind::Other,
                    format!("Thrift HTTP request failed: {e}"),
                )
            })?;
        let status = resp.status();
        let bytes = resp.bytes().map_err(|e| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("Thrift HTTP read failed: {e}"),
            )
        })?;
        if !status.is_success() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!(
                    "Thrift HTTP error {}: {}",
                    status,
                    String::from_utf8_lossy(&bytes).trim()
                ),
            ));
        }
        st.inp = Cursor::new(bytes.to_vec());
        Ok(())
    }
}

impl Read for HttpChannel {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.borrow_mut().inp.read(buf)
    }
}

// ---- helpers ----------------------------------------------------------------

/// Run a blocking Thrift call on the blocking pool and flatten the join error.
async fn run<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("HBase Thrift task failed: {e}"))?
}

fn thrift_err(e: thrift::Error) -> String {
    if let thrift::Error::User(u) = &e {
        if let Some(io_err) = u.downcast_ref::<TIOError>() {
            return format!(
                "HBase error: {}",
                io_err.message.clone().unwrap_or_else(|| "I/O error".into())
            );
        }
        if let Some(arg) = u.downcast_ref::<TIllegalArgument>() {
            return format!(
                "HBase illegal argument: {}",
                arg.message.clone().unwrap_or_default()
            );
        }
    }
    e.to_string()
}

fn render_table_name(tn: &TTableName) -> String {
    let qual = String::from_utf8_lossy(&tn.qualifier);
    match tn.ns.as_deref() {
        Some(ns) if !ns.is_empty() && ns != b"default" => {
            format!("{}:{}", String::from_utf8_lossy(ns), qual)
        }
        _ => qual.into_owned(),
    }
}

fn families_of(desc: &TTableDescriptor) -> Vec<(String, BTreeMap<String, String>)> {
    desc.columns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|cf| {
            let name = String::from_utf8_lossy(&cf.name).into_owned();
            let mut attrs = BTreeMap::new();
            if let Some(v) = cf.max_versions {
                attrs.insert("VERSIONS".to_string(), v.to_string());
            }
            if let Some(v) = cf.min_versions {
                attrs.insert("MIN_VERSIONS".to_string(), v.to_string());
            }
            if let Some(v) = cf.time_to_live {
                attrs.insert("TTL".to_string(), v.to_string());
            }
            if let Some(v) = cf.block_size {
                attrs.insert("BLOCKSIZE".to_string(), v.to_string());
            }
            if let Some(v) = cf.in_memory {
                attrs.insert("IN_MEMORY".to_string(), v.to_string());
            }
            (name, attrs)
        })
        .collect()
}

fn result_to_rows(res: &TResult) -> Vec<ResultRow> {
    let row = res.row.clone().unwrap_or_default();
    res.column_values
        .iter()
        .map(|cv| {
            let mut column = cv.family.clone();
            column.push(b':');
            column.extend_from_slice(&cv.qualifier);
            ResultRow {
                row: row.clone(),
                column,
                timestamp: cv.timestamp.unwrap_or(0).max(0) as u64,
                value: cv.value.clone(),
            }
        })
        .collect()
}

/// "family:qualifier" (or bare "family") -> TColumn, for get/scan/delete.
fn parse_column(col: &str) -> TColumn {
    match col.split_once(':') {
        Some((f, q)) => TColumn {
            family: f.as_bytes().to_vec(),
            qualifier: Some(q.as_bytes().to_vec()),
            timestamp: None,
        },
        None => TColumn {
            family: col.as_bytes().to_vec(),
            qualifier: None,
            timestamp: None,
        },
    }
}

/// "family:qualifier" -> (family, qualifier) bytes. A qualifier is required for put.
fn split_column(col: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    match col.split_once(':') {
        Some((f, q)) => Ok((f.as_bytes().to_vec(), q.as_bytes().to_vec())),
        None => Err(format!(
            "put column must be 'family:qualifier', got '{col}'"
        )),
    }
}

fn table_name_of(namespace: Option<&str>, table: &str) -> TTableName {
    let trimmed = table.trim();
    match trimmed.split_once(':') {
        Some((ns, qual)) => TTableName {
            ns: Some(ns.as_bytes().to_vec()),
            qualifier: qual.as_bytes().to_vec(),
        },
        None => TTableName {
            ns: namespace.map(|n| n.as_bytes().to_vec()),
            qualifier: trimmed.as_bytes().to_vec(),
        },
    }
}

fn qualify(namespace: Option<&str>, table: &str) -> Vec<u8> {
    let trimmed = table.trim();
    match (namespace, trimmed.contains(':')) {
        (Some(ns), false) => format!("{ns}:{trimmed}").into_bytes(),
        _ => trimmed.as_bytes().to_vec(),
    }
}

// Struct builders that centralize the (mostly-None) optional fields, since the
// generated structs don't derive Default (they have required fields).

fn tget(row: Vec<u8>, columns: Option<Vec<TColumn>>) -> TGet {
    TGet {
        row,
        columns,
        timestamp: None,
        time_range: None,
        max_versions: None,
        filter_string: None,
        attributes: None,
        authorizations: None,
        consistency: None,
        target_replica_id: None,
        cache_blocks: None,
        store_limit: None,
        store_offset: None,
        existence_only: None,
        filter_bytes: None,
    }
}

fn tdelete(row: Vec<u8>, columns: Option<Vec<TColumn>>) -> TDelete {
    TDelete {
        row,
        columns,
        timestamp: None,
        delete_type: None,
        attributes: None,
        durability: None,
    }
}

fn tcv(family: Vec<u8>, qualifier: Vec<u8>, value: Vec<u8>) -> TColumnValue {
    TColumnValue {
        family,
        qualifier,
        value,
        timestamp: None,
        tags: None,
        type_: None,
    }
}

fn tput(row: Vec<u8>, column_values: Vec<TColumnValue>) -> TPut {
    TPut {
        row,
        column_values,
        timestamp: None,
        attributes: None,
        durability: None,
        cell_visibility: None,
    }
}

fn ttd(table_name: TTableName, columns: Vec<TColumnFamilyDescriptor>) -> TTableDescriptor {
    TTableDescriptor {
        table_name,
        columns: Some(columns),
        attributes: None,
        durability: None,
    }
}

fn tcfd(name: &str, attrs: &BTreeMap<String, String>) -> TColumnFamilyDescriptor {
    let int = |k: &str| attrs.get(k).and_then(|s| s.parse::<i32>().ok());
    TColumnFamilyDescriptor {
        name: name.as_bytes().to_vec(),
        attributes: None,
        configuration: None,
        block_size: int("BLOCKSIZE"),
        bloomn_filter_type: None,
        compression_type: None,
        dfs_replication: None,
        data_block_encoding: None,
        keep_deleted_cells: None,
        max_versions: int("VERSIONS"),
        min_versions: int("MIN_VERSIONS"),
        scope: None,
        time_to_live: int("TTL"),
        block_cache_enabled: None,
        cache_blooms_on_write: None,
        cache_data_on_write: None,
        cache_indexes_on_write: None,
        compress_tags: None,
        evict_blocks_on_close: None,
        in_memory: attrs.get("IN_MEMORY").map(|s| s == "true" || s == "1"),
    }
}

#[cfg(test)]
mod tests;
