//! SocksCap xray-core sidecar tests.
//!
//! Two tiers, mirroring `sockscap_win11_scenarios.rs`:
//!   1. Pure config generation + manager guards — always run, no binary/network.
//!   2. Live spawn/teardown of a real `xray` process — opt-in, **skipped**
//!      (not failed) unless an xray binary is locatable, so `cargo test` stays
//!      green on machines/CI without it.
//!
//! Locate the binary for tier 2 via `SOCKSCAP_XRAY_EXE`, `SOCKSCAP_XRAY_DIR`,
//! or a staged `resources/sockscap/<platform>/xray[.exe]`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use taomni_lib::sockscap::config::{UpstreamKind, UpstreamParams};
use taomni_lib::sockscap::core::{ResolvedCoreUpstream, XrayManager, spec_config_hash};

/* ------------------------- tier 1: pure, always run ------------------------ */

fn ss_spec(host: &str, port: u16, pw: &str) -> ResolvedCoreUpstream {
    ResolvedCoreUpstream {
        kind: UpstreamKind::Shadowsocks,
        host: host.into(),
        port,
        secret: pw.into(),
        uuid: String::new(),
        private_key: String::new(),
        pre_shared_key: String::new(),
        params: UpstreamParams::default(),
    }
}

#[test]
fn config_gen_shadowsocks_has_loopback_socks_inbound() {
    let spec = ss_spec("1.2.3.4", 8388, "pw");
    let cfg = spec.to_xray_config(10800).expect("config");
    assert_eq!(cfg["inbounds"][0]["protocol"], "socks");
    assert_eq!(cfg["inbounds"][0]["listen"], "127.0.0.1");
    assert_eq!(cfg["inbounds"][0]["port"], 10800);
    assert_eq!(cfg["outbounds"][0]["protocol"], "shadowsocks");
    assert_eq!(
        cfg["outbounds"][0]["settings"]["servers"][0]["password"],
        "pw"
    );
}

#[test]
fn config_gen_rejects_incomplete_specs() {
    // missing password for trojan
    let mut t = ss_spec("h", 443, "");
    t.kind = UpstreamKind::Trojan;
    assert!(t.to_xray_config(1).is_err());
    // vmess without uuid
    let mut v = ss_spec("h", 443, "");
    v.kind = UpstreamKind::Vmess;
    assert!(v.to_xray_config(1).is_err());
    // non-core kind
    let mut s = ss_spec("h", 443, "pw");
    s.kind = UpstreamKind::Socks5;
    assert!(s.to_xray_config(1).is_err());
}

#[test]
fn config_hash_changes_with_secret() {
    let a = spec_config_hash(&ss_spec("h", 1, "one"));
    let b = spec_config_hash(&ss_spec("h", 1, "two"));
    assert_ne!(a, b);
}

#[tokio::test]
async fn manager_without_binary_reports_missing() {
    let mgr = XrayManager::new(None, std::env::temp_dir().join("xray-nobin"));
    assert!(!mgr.has_exe());
    let err = mgr
        .ensure("p1", &ss_spec("1.2.3.4", 8388, "pw"))
        .await
        .unwrap_err();
    assert!(err.contains("xray-core binary not found"), "got: {err}");
    assert_eq!(mgr.running_count().await, 0);
}

/* ----------------------- tier 2: live xray, opt-in ------------------------- */

/// Locate an xray binary for the live test, or None to skip.
fn locate_xray() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SOCKSCAP_XRAY_EXE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = if cfg!(windows) { "xray.exe" } else { "xray" };
    if let Ok(dir) = std::env::var("SOCKSCAP_XRAY_DIR") {
        let p = PathBuf::from(dir).join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    // Staged resource path relative to the crate (src-tauri).
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/sockscap")
        .join(platform)
        .join(exe);
    if staged.is_file() {
        return Some(staged);
    }
    None
}

/// Raw SOCKS5 no-auth greeting: confirms the listener actually speaks SOCKS5
/// (not merely that some TCP port is open). Returns Ok(()) on `05 00`.
async fn socks5_greeting_ok(port: u16) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(addr))
        .await
        .map_err(|_| "connect timeout".to_string())?
        .map_err(|e| format!("connect: {e}"))?;
    s.write_all(&[0x05, 0x01, 0x00])
        .await
        .map_err(|e| format!("write: {e}"))?;
    let mut buf = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(2), s.read_exact(&mut buf))
        .await
        .map_err(|_| "read timeout".to_string())?
        .map_err(|e| format!("read: {e}"))?;
    if buf[0] == 0x05 && buf[1] == 0x00 {
        Ok(())
    } else {
        Err(format!("unexpected SOCKS reply {buf:02x?}"))
    }
}

async fn port_is_closed(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    matches!(
        tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr)).await,
        Ok(Err(_)) | Err(_)
    )
}

fn free_tcp_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Spawn a raw xray process from an arbitrary config JSON (used to stand up a
/// real Shadowsocks *server* for the e2e chain). Killed on drop.
fn spawn_xray_raw(exe: &std::path::Path, config_json: &str, tag: &str) -> tokio::process::Child {
    let dir = std::env::temp_dir().join(format!("xray-srv-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = dir.join("config.json");
    std::fs::write(&cfg, config_json).unwrap();
    tokio::process::Command::new(exe)
        .arg("run")
        .arg("-c")
        .arg(&cfg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn xray server")
}

async fn wait_port_open(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if tokio::time::timeout(Duration::from_millis(200), TcpStream::connect(addr))
            .await
            .ok()
            .and_then(Result::ok)
            .is_some()
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// A1: a bad config must fail with the xray log tail in the error, not a
/// generic "not ready". Uses an invalid Shadowsocks cipher so xray rejects the
/// outbound and exits at startup. Skips without a binary.
#[tokio::test]
async fn bad_config_surfaces_xray_log_tail() {
    let Some(exe) = locate_xray() else {
        eprintln!("SKIP bad_config_surfaces_xray_log_tail: no xray binary");
        return;
    };
    let work = std::env::temp_dir().join(format!("xray-badcfg-{}", std::process::id()));
    let mgr = XrayManager::new(Some(exe), work.clone());
    let mut spec = ss_spec("127.0.0.1", 8388, "pw");
    spec.params.method = "definitely-not-a-real-cipher".into();

    let err = mgr
        .ensure("bad", &spec)
        .await
        .expect_err("invalid cipher should fail to start");
    // The error should carry xray's own diagnostics, not just "not ready".
    assert!(
        err.contains("xray log:"),
        "expected xray log tail in error, got: {err}"
    );
    assert_eq!(mgr.running_count().await, 0, "failed core must not linger");
    let _ = std::fs::remove_dir_all(&work);
}

/// End-to-end: our generated Shadowsocks *client* config must interoperate with
/// a real Shadowsocks server and carry bytes to a target — the exact path the
/// relay uses (`socks5::dial` → xray core → node → target).
///
/// Chain, fully local (no network):
///   echo TCP server  ◄── xray SS server (ss inbound + freedom out)
///                          ▲
///                          │ ss (aes-256-gcm)
///                   our xray core (socks in + ss out, config from config_gen)
///                          ▲
///                   socks5::dial (what the relay does)
///
/// Proves config_gen emits a valid, interoperable SS client — not merely a
/// structurally-plausible JSON. Skips without an xray binary.
#[tokio::test]
async fn shadowsocks_chain_carries_bytes_end_to_end() {
    use taomni_lib::sockscap::egress::socks5;

    let Some(exe) = locate_xray() else {
        eprintln!("SKIP shadowsocks_chain_carries_bytes_end_to_end: no xray binary");
        return;
    };

    // 1) Local echo target.
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = echo.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    // 2) Real Shadowsocks server via xray (ss inbound → freedom outbound).
    let ss_port = free_tcp_port();
    let password = "chain-secret-123";
    let server_cfg = serde_json::json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "port": ss_port,
            "listen": "127.0.0.1",
            "protocol": "shadowsocks",
            "settings": { "method": "aes-256-gcm", "password": password, "network": "tcp" }
        }],
        "outbounds": [{ "protocol": "freedom" }]
    })
    .to_string();
    let _server = spawn_xray_raw(&exe, &server_cfg, "ss");
    assert!(
        wait_port_open(ss_port, Duration::from_secs(8)).await,
        "SS server did not open port {ss_port}"
    );

    // 3) Our client core, config generated by config_gen (ss outbound → the server).
    let work = std::env::temp_dir().join(format!("xray-chain-{}", std::process::id()));
    let mgr = XrayManager::new(Some(exe), work.clone());
    let mut spec = ss_spec("127.0.0.1", ss_port, password);
    spec.params.method = "aes-256-gcm".into();
    let client_port = mgr
        .ensure("chain", &spec)
        .await
        .expect("client core should spawn");

    // 4) Dial exactly as the relay does, and round-trip bytes through the chain.
    let mut stream = socks5::dial("127.0.0.1", client_port, "127.0.0.1", echo_port, "", "")
        .await
        .expect("socks5 dial through xray core to echo target");
    let payload = b"ping-through-shadowsocks";
    stream.write_all(payload).await.expect("write");
    let mut got = vec![0u8; payload.len()];
    stream.read_exact(&mut got).await.expect("read echo");
    assert_eq!(&got, payload, "echo bytes should survive the SS chain");

    // Teardown.
    drop(stream);
    mgr.shutdown_all().await;
    let _ = std::fs::remove_dir_all(&work);
}

/// Full lifecycle: spawn a core, confirm its SOCKS inbound speaks SOCKS5,
/// idempotent ensure reuses the same core, and shutdown reaps it (port closes).
///
/// Uses a syntactically valid but unreachable Shadowsocks server; xray still
/// binds the local SOCKS inbound because the outbound is dialed lazily, so the
/// test needs no real proxy server or network egress.
#[tokio::test]
async fn xray_core_lifecycle_spawn_reuse_shutdown() {
    let Some(exe) = locate_xray() else {
        eprintln!(
            "SKIP xray_core_lifecycle_spawn_reuse_shutdown: no xray binary \
             (set SOCKSCAP_XRAY_EXE / SOCKSCAP_XRAY_DIR or stage resources/sockscap/<platform>/xray)"
        );
        return;
    };

    let work = std::env::temp_dir().join(format!("xray-it-{}", std::process::id()));
    let mgr = XrayManager::new(Some(exe), work.clone());
    let spec = ss_spec("127.0.0.1", 1, "test-password");

    // spawn
    let port = mgr
        .ensure("profile-a", &spec)
        .await
        .expect("core should spawn and become ready");
    assert_eq!(mgr.running_count().await, 1);
    assert_eq!(mgr.local_port("profile-a").await, Some(port));

    // speaks SOCKS5
    socks5_greeting_ok(port)
        .await
        .expect("core inbound should speak SOCKS5");

    // idempotent reuse: same spec → same port, still one process
    let port2 = mgr.ensure("profile-a", &spec).await.expect("reuse");
    assert_eq!(port, port2, "unchanged spec should reuse the same core");
    assert_eq!(mgr.running_count().await, 1);

    // teardown reaps the process → port closes, no orphan
    mgr.shutdown_all().await;
    assert_eq!(mgr.running_count().await, 0);
    // Give the OS a beat to release the socket.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        port_is_closed(port).await,
        "SOCKS port {port} should be closed after shutdown (process reaped)"
    );

    let _ = std::fs::remove_dir_all(&work);
}
