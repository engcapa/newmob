//! End-to-end coverage for the SocksCap proxy ingress.
//!
//! The ingress is the macOS Phase 1 capture front end (the system SOCKS proxy
//! points at it), but nothing in it is macOS-specific, so this runs everywhere.
//!
//! Each test drives the real listener with SocksCap's own egress dialers as the
//! client, which proves the server and client halves of both handshakes agree,
//! and that a flow reaches the shared policy/egress relay and gets bridged.

use std::sync::Arc;

use taomni_lib::sockscap::config::{Decision, RuleMode, SocksCapConfig};
use taomni_lib::sockscap::egress::{http_connect, socks5};
use taomni_lib::sockscap::helper::HelperRegistry;
use taomni_lib::sockscap::ingress;
use taomni_lib::sockscap::relay::RelayContext;
use taomni_lib::sockscap::rules::dns_map::DnsMap;
use taomni_lib::sockscap::stats::{DomainTracker, StatsCounters};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

/// Relay context that sends every decision down the Direct path, so the test
/// needs no upstream proxy and still exercises the whole ingress → policy →
/// egress → bridge chain.
fn direct_context(config: SocksCapConfig) -> Arc<RwLock<RelayContext>> {
    Arc::new(RwLock::new(RelayContext {
        config,
        rules: None,
        helper: Arc::new(HelperRegistry::new()),
        stats: Arc::new(StatsCounters::default()),
        upstream_host: String::new(),
        upstream_port: 0,
        upstream_user: String::new(),
        upstream_pass: String::new(),
        self_pid: std::process::id(),
        ssh_pool: None,
        profile_upstreams: std::collections::HashMap::new(),
        dns_map: Arc::new(std::sync::Mutex::new(DnsMap::new(
            64,
            std::time::Duration::from_secs(60),
        ))),
        domains: Arc::new(std::sync::Mutex::new(DomainTracker::new(32))),
    }))
}

fn direct_config() -> SocksCapConfig {
    let mut config = SocksCapConfig::default();
    for profile in &mut config.profiles {
        profile.rule_mode = RuleMode::Off;
        profile.default_action = Decision::Direct;
    }
    config.rule_mode = RuleMode::Off;
    config
}

/// Uppercasing echo server standing in for the origin host.
async fn spawn_echo_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                loop {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let reply = buffer[..read].to_ascii_uppercase();
                            if socket.write_all(&reply).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn socks5_ingress_bridges_a_flow_to_its_origin() {
    let (origin_port, origin) = spawn_echo_server().await;
    let ingress = ingress::start_ingress(direct_context(direct_config()), None)
        .await
        .expect("ingress should start");

    // SocksCap's own SOCKS5 dialer as the client, targeting a hostname so the
    // authoritative-hostname path (no SNI sniffing) is the one under test.
    let mut client = socks5::dial(
        "127.0.0.1",
        ingress.handle.port,
        "localhost",
        origin_port,
        "",
        "",
    )
    .await
    .expect("SOCKS5 CONNECT through the ingress");

    client.write_all(b"ping").await.unwrap();
    let mut reply = [0u8; 4];
    client.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"PING");

    drop(client);
    ingress.handle.stop().await;
    origin.abort();
}

#[tokio::test]
async fn http_connect_ingress_bridges_a_flow_to_its_origin() {
    let (origin_port, origin) = spawn_echo_server().await;
    let ingress = ingress::start_ingress(direct_context(direct_config()), None)
        .await
        .expect("ingress should start");

    let mut client = http_connect::dial(
        "127.0.0.1",
        ingress.handle.port,
        "localhost",
        origin_port,
        "",
        "",
    )
    .await
    .expect("HTTP CONNECT through the ingress");

    client.write_all(b"ping").await.unwrap();
    let mut reply = [0u8; 4];
    client.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"PING");

    drop(client);
    ingress.handle.stop().await;
    origin.abort();
}

#[tokio::test]
async fn a_blocked_target_is_not_bridged() {
    let (origin_port, origin) = spawn_echo_server().await;
    let mut config = direct_config();
    for profile in &mut config.profiles {
        profile.user_rules = vec![taomni_lib::sockscap::config::UserRule {
            pattern: "localhost".into(),
            action: taomni_lib::sockscap::config::UserRuleAction::Block,
            comment: String::new(),
        }];
    }
    let ingress = ingress::start_ingress(direct_context(config), None)
        .await
        .expect("ingress should start");

    let mut client = socks5::dial(
        "127.0.0.1",
        ingress.handle.port,
        "localhost",
        origin_port,
        "",
        "",
    )
    .await
    .expect("the handshake succeeds before policy runs");

    // The relay drops a blocked flow, so the tunnel closes without any payload.
    client.write_all(b"ping").await.ok();
    let mut sink = Vec::new();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.read_to_end(&mut sink),
    )
    .await
    .expect("blocked flow should be closed promptly");
    assert_eq!(read.unwrap_or(0), 0, "no payload should be relayed");

    ingress.handle.stop().await;
    origin.abort();
}

#[tokio::test]
async fn stopping_the_ingress_releases_its_port() {
    let ingress = ingress::start_ingress(direct_context(direct_config()), None)
        .await
        .expect("ingress should start");
    let port = ingress.handle.port;

    ingress.handle.stop().await;

    // Rebinding proves the accept loop released the port instead of lingering.
    // The listener has to stay alive for the connect below to have a peer.
    let rebound = TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("port should be free after stop");
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());
    drop(rebound);
}
