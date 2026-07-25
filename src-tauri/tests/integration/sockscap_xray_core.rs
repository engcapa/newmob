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
