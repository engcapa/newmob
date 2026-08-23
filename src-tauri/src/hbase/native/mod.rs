//! Native HBase RPC client.
//!
//! A JVM-free, REST-free HBase client that speaks the native RegionServer /
//! Master RPC protocol directly, bootstrapped via ZooKeeper — the same wire
//! protocol the Java `hbase-client` uses. This replaces the REST/Stargate
//! transport so we can reach clusters that only expose the native RPC ports.
//!
//! Module layout mirrors the porting blueprint:
//! - `proto`   — generated protobuf types (`hbase.pb`)
//! - `rpc`     — connection actor, frame codecs, call-id multiplexing
//! - `auth`    — simple (0x50) and Kerberos (0x51 / GSSAPI) handshakes
//! - `cell`    — KeyValueCodec CellBlock encode/decode
//! - `zk`      — ZooKeeper znode bootstrap (meta-region-server / master)
//! - `region`  — RegionInfo, meta-row parsing, region-name comparator
//! - `meta`    — hbase:meta region location + cache
//! - `client`  — SendRPC orchestration, retries, scan state machine

pub mod auth;
pub mod cell;
pub mod client;
pub mod proto;
pub mod region;
pub mod rpc;
pub mod zk;
