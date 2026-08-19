//! ZooKeeper bootstrap for the native HBase client.
//!
//! HBase publishes the location of the meta region and the active master as
//! znodes under the configured root (default `/hbase`). The client reads
//! `/hbase/meta-region-server` to find the RegionServer hosting `hbase:meta`,
//! and `/hbase/master` to find the active Master.
//!
//! znode payload format (the "protobuf-with-magic" serialization):
//! ```text
//! 0xFF | u32 BE metadata_len | <metadata_len bytes, skipped> | "PBUF" | protobuf
//! ```

use prost::Message;
use std::time::Duration;

use super::proto::pb;

/// znode paths relative to the HBase ZK root.
pub const META_REGION_SERVER: &str = "/meta-region-server";
pub const MASTER: &str = "/master";
pub const DEFAULT_ZK_ROOT: &str = "/hbase";

/// `PBUF` magic delimiting the protobuf payload.
const PBUF_MAGIC: &[u8; 4] = b"PBUF";

#[derive(Debug)]
pub enum ZkError {
    Connect(String),
    Read(String),
    Parse(String),
}

impl std::fmt::Display for ZkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ZkError::Connect(e) => write!(f, "ZooKeeper connect failed: {e}"),
            ZkError::Read(e) => write!(f, "ZooKeeper read failed: {e}"),
            ZkError::Parse(e) => write!(f, "ZooKeeper znode parse failed: {e}"),
        }
    }
}

impl std::error::Error for ZkError {}

/// A resolved server endpoint (`host:port`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEndpoint {
    pub host: String,
    pub port: u16,
}

impl ServerEndpoint {
    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn server_name_to_endpoint(server: &pb::ServerName) -> ServerEndpoint {
    ServerEndpoint {
        host: server.host_name.clone(),
        // RegionServers always carry a port; default is informational only.
        port: server.port.unwrap_or(16020) as u16,
    }
}

/// Strip the `0xFF + metadata + PBUF` envelope from a znode payload, returning
/// the inner protobuf bytes.
fn strip_znode_envelope(data: &[u8]) -> Result<&[u8], ZkError> {
    if data.is_empty() {
        return Err(ZkError::Parse("empty znode".into()));
    }
    if data[0] != 0xFF {
        return Err(ZkError::Parse(format!(
            "first byte was 0x{:02x}, not 0xFF",
            data[0]
        )));
    }
    if data.len() < 5 {
        return Err(ZkError::Parse("missing metadata length".into()));
    }
    let metadata_len = u32::from_be_bytes([data[1], data[2], data[3], data[4]]) as usize;
    if metadata_len < 1 || metadata_len > 65000 {
        return Err(ZkError::Parse(format!(
            "implausible metadata length {metadata_len}"
        )));
    }
    // Layout: [0xFF][4B len][metadata_len bytes][PBUF][protobuf]
    let magic_start = 1 + 4 + metadata_len;
    let magic_end = magic_start + 4;
    if data.len() < magic_end {
        return Err(ZkError::Parse("truncated before PBUF magic".into()));
    }
    if &data[magic_start..magic_end] != PBUF_MAGIC {
        return Err(ZkError::Parse("missing PBUF magic".into()));
    }
    Ok(&data[magic_end..])
}

/// Parse a `/hbase/meta-region-server` payload into the meta RegionServer addr.
pub fn parse_meta_region_server(data: &[u8]) -> Result<ServerEndpoint, ZkError> {
    let pbuf = strip_znode_envelope(data)?;
    let msg = pb::MetaRegionServer::decode(pbuf).map_err(|e| ZkError::Parse(e.to_string()))?;
    Ok(server_name_to_endpoint(&msg.server))
}

/// Parse a `/hbase/master` payload into the active Master addr.
pub fn parse_master(data: &[u8]) -> Result<ServerEndpoint, ZkError> {
    let pbuf = strip_znode_envelope(data)?;
    let msg = pb::Master::decode(pbuf).map_err(|e| ZkError::Parse(e.to_string()))?;
    let mut ep = server_name_to_endpoint(&msg.master);
    // Master default port differs from RS; only override if proto omitted it.
    if msg.master.port.is_none() {
        ep.port = 16000;
    }
    Ok(ep)
}

/// Connect to the ZooKeeper quorum, read a znode, and return its raw bytes.
/// `quorum` is a comma-separated `host:port` list; `path` is the full znode
/// path (root already prepended).
pub async fn read_znode(quorum: &str, path: &str, timeout: Duration) -> Result<Vec<u8>, ZkError> {
    // A fresh, short-lived session per lookup (no watches): matches gohbase.
    let mut connector = zookeeper_client::Client::connector();
    connector.session_timeout(timeout);
    let client = connector
        .connect(quorum)
        .await
        .map_err(|e| ZkError::Connect(e.to_string()))?;
    let (data, _stat) = client
        .get_data(path)
        .await
        .map_err(|e| ZkError::Read(e.to_string()))?;
    Ok(data)
}

/// Resolve the meta RegionServer via ZooKeeper.
pub async fn locate_meta(
    quorum: &str,
    zk_root: &str,
    timeout: Duration,
) -> Result<ServerEndpoint, ZkError> {
    let path = format!("{}{}", zk_root, META_REGION_SERVER);
    let data = read_znode(quorum, &path, timeout).await?;
    parse_meta_region_server(&data)
}

/// Resolve the active Master via ZooKeeper.
pub async fn locate_master(
    quorum: &str,
    zk_root: &str,
    timeout: Duration,
) -> Result<ServerEndpoint, ZkError> {
    let path = format!("{}{}", zk_root, MASTER);
    let data = read_znode(quorum, &path, timeout).await?;
    parse_master(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic znode payload wrapping `proto_bytes`.
    fn wrap_znode(proto_bytes: &[u8]) -> Vec<u8> {
        let metadata = b"\x00metadata-magic-skipped"; // arbitrary, skipped
        let mut out = Vec::new();
        out.push(0xFF);
        out.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        out.extend_from_slice(metadata);
        out.extend_from_slice(PBUF_MAGIC);
        out.extend_from_slice(proto_bytes);
        out
    }

    #[test]
    fn parse_meta_region_server_ok() {
        let msg = pb::MetaRegionServer {
            server: pb::ServerName {
                host_name: "rs1.example.com".into(),
                port: Some(16020),
                start_code: Some(123456),
            },
            rpc_version: Some(1),
            state: None,
        };
        let payload = wrap_znode(&msg.encode_to_vec());
        let ep = parse_meta_region_server(&payload).unwrap();
        assert_eq!(ep.host, "rs1.example.com");
        assert_eq!(ep.port, 16020);
        assert_eq!(ep.addr(), "rs1.example.com:16020");
    }

    #[test]
    fn parse_master_ok() {
        let msg = pb::Master {
            master: pb::ServerName {
                host_name: "master.example.com".into(),
                port: Some(16000),
                start_code: Some(999),
            },
            rpc_version: Some(1),
            info_port: Some(16010),
        };
        let payload = wrap_znode(&msg.encode_to_vec());
        let ep = parse_master(&payload).unwrap();
        assert_eq!(ep.host, "master.example.com");
        assert_eq!(ep.port, 16000);
    }

    #[test]
    fn rejects_bad_first_byte() {
        let mut payload = wrap_znode(b"whatever");
        payload[0] = 0x00;
        assert!(matches!(
            strip_znode_envelope(&payload),
            Err(ZkError::Parse(_))
        ));
    }

    #[test]
    fn rejects_missing_pbuf_magic() {
        let metadata = b"meta";
        let mut out = Vec::new();
        out.push(0xFF);
        out.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        out.extend_from_slice(metadata);
        out.extend_from_slice(b"XXXX"); // wrong magic
        out.extend_from_slice(b"body");
        assert!(matches!(strip_znode_envelope(&out), Err(ZkError::Parse(_))));
    }

    #[test]
    fn rejects_implausible_metadata_len() {
        let mut out = Vec::new();
        out.push(0xFF);
        out.extend_from_slice(&70000u32.to_be_bytes()); // > 65000
        out.extend_from_slice(b"PBUF");
        assert!(matches!(strip_znode_envelope(&out), Err(ZkError::Parse(_))));
    }
}
