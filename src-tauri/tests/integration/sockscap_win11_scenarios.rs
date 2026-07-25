//! Automated egress/policy test suite for Taomni SocksCap on Windows 11.
//!
//! Scenarios covered:
//! 1. Policy Engine & Process Isolation (`apps` filter, bypass CIDRs) — pure, always runs.
//! 2. Upstream HTTP Proxy Dialer — network, opt-in via env.
//! 3. Upstream SOCKS5 Proxy Dialer — network, opt-in via env.
//! 4. Upstream SSH Tunnel Egress — network, opt-in via env.
//! 5. Direct curl verification — network, Windows only, opt-in via env.
//!
//! Scenarios 2-5 reach real infrastructure and are **skipped** (not failed)
//! unless the matching environment variables are set, so `cargo test` stays
//! green in CI and on machines without the test network. No credentials or
//! internal hosts are baked into this file. Configure via:
//!   QA_HTTP_PROXY_HOST / QA_HTTP_PROXY_PORT
//!   QA_SOCKS5_PROXY_HOST / QA_SOCKS5_PROXY_PORT
//!   QA_SSH_HOST / QA_SSH_PORT / QA_SSH_USER / QA_SSH_PASSWORD
//!   QA_TARGET_HOST / QA_TARGET_PORT   (default: www.baidu.com:443)
//!   QA_DIRECT_URL                     (scenario 5; e.g. https://www.baidu.com)

use std::net::IpAddr;
#[cfg(target_os = "windows")]
use std::process::Command;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use taomni_lib::sockscap::config::{
    AppSelector, Decision, RuleMode, ScopeMode, SocksCapConfig, UpstreamKind, UpstreamRef,
};
use taomni_lib::sockscap::egress::{http_connect, socks5, ssh_pool::SshPool};
use taomni_lib::sockscap::policy::{PolicyEngine, PolicyInput};
use taomni_lib::terminal::ssh::SshAuth;

/// Default egress probe target — a public host, safe to keep in-tree.
const DEFAULT_TARGET_HOST: &str = "www.baidu.com";
const DEFAULT_TARGET_PORT: u16 = 443;

/// Read a non-empty environment variable, trimming surrounding whitespace.
///
/// Network scenarios are opt-in: a missing value makes the test skip rather
/// than fail, so `cargo test` stays green without the internal test network.
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_port(key: &str) -> Option<u16> {
    env_opt(key).and_then(|v| v.parse().ok())
}

fn target_host() -> String {
    env_opt("QA_TARGET_HOST").unwrap_or_else(|| DEFAULT_TARGET_HOST.to_string())
}

fn target_port() -> u16 {
    env_port("QA_TARGET_PORT").unwrap_or(DEFAULT_TARGET_PORT)
}

fn make_test_config(mode: ScopeMode, upstream: UpstreamRef) -> SocksCapConfig {
    let mut cfg = SocksCapConfig {
        enabled: true,
        active_profile_ids: vec![],
        selected_profile_id: String::new(),
        profiles: vec![],
        mode,
        apps: vec![AppSelector {
            path: "C:\\Windows\\System32\\curl.exe".to_string(),
            bundle_id: String::new(),
            name: "curl.exe".to_string(),
        }],
        upstream,
        rule_mode: RuleMode::ProxyAll,
        gfwlist: taomni_lib::sockscap::config::GfwListSource {
            enabled: false,
            url: "".into(),
            auto_refresh_hours: 24,
        },
        user_rules: vec![],
        bypass_cidrs: vec![
            "127.0.0.0/8".into(),
            "10.0.0.0/8".into(),
            "172.16.0.0/12".into(),
            "192.168.0.0/16".into(),
            "::1/128".into(),
        ],
        default_action: Decision::Proxy,
        restore_on_login: false,
    };
    cfg.normalize();
    cfg
}

/// Scenario 1: Policy Engine App Isolation and CIDR Bypass
#[test]
fn test_policy_app_isolation_and_bypass() {
    let cfg = make_test_config(
        ScopeMode::Apps,
        UpstreamRef {
            kind: UpstreamKind::Socks5,
            session_id: String::new(),
            host: "127.0.0.1".to_string(),
            port: 1080,
            username: String::new(),
            password_ref: String::new(),
        },
    );

    let engine = PolicyEngine::from_config(&cfg, None);

    // 1. Target process `curl.exe` -> should be PROXY
    let input_curl = PolicyInput {
        host: Some("example.com".into()),
        ip: None,
        port: 443,
        process_path: Some("C:\\Windows\\System32\\curl.exe".into()),
        pid: Some(1234),
    };
    let trace_curl = engine.decide(&input_curl);
    assert_eq!(
        trace_curl.decision,
        Decision::Proxy,
        "curl.exe should be proxied under apps mode"
    );

    // 2. Non-target process `powershell.exe` -> should be DIRECT (bypassed)
    let input_ps = PolicyInput {
        host: Some("example.com".into()),
        ip: None,
        port: 443,
        process_path: Some("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".into()),
        pid: Some(5678),
    };
    let trace_ps = engine.decide(&input_ps);
    assert_eq!(
        trace_ps.decision,
        Decision::Direct,
        "powershell.exe should be direct under apps mode"
    );

    // 3. Traffic to a private 10.0.0.0/8 IP -> should be DIRECT (bypass CIDR rule)
    let input_local = PolicyInput {
        host: None,
        ip: Some("10.99.99.99".parse::<IpAddr>().unwrap()),
        port: 80,
        process_path: Some("C:\\Windows\\System32\\curl.exe".into()),
        pid: Some(1234),
    };
    let trace_local = engine.decide(&input_local);
    assert_eq!(
        trace_local.decision,
        Decision::Direct,
        "10.99.99.99 should be bypassed via the 10.0.0.0/8 bypass CIDR"
    );
}

/// Scenario 2: Egress dialing through an upstream HTTP proxy (opt-in).
#[tokio::test]
async fn test_upstream_http_dialer() {
    let (Some(proxy_host), Some(proxy_port)) =
        (env_opt("QA_HTTP_PROXY_HOST"), env_port("QA_HTTP_PROXY_PORT"))
    else {
        eprintln!(
            "SKIP test_upstream_http_dialer: set QA_HTTP_PROXY_HOST and QA_HTTP_PROXY_PORT to run"
        );
        return;
    };
    let target_host = target_host();
    let target_port = target_port();
    println!("[HTTP Test] Connecting to HTTP proxy {proxy_host}:{proxy_port}...");
    let result =
        http_connect::dial(&proxy_host, proxy_port, &target_host, target_port, "", "").await;

    match result {
        Ok(mut stream) => {
            println!("[HTTP Test] CONNECT handshake succeeded! Sending probe...");
            let req =
                format!("HEAD / HTTP/1.1\r\nHost: {target_host}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(req.as_bytes()).await;
            let mut buf = [0u8; 64];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            println!("[HTTP Test] Received {n} bytes response header prefix");
        }
        Err(e) => {
            panic!("HTTP proxy dial to {proxy_host}:{proxy_port} failed: {e}");
        }
    }
}

/// Scenario 3: Egress dialing through an upstream SOCKS5 proxy (opt-in).
#[tokio::test]
async fn test_upstream_socks5_dialer() {
    let (Some(proxy_host), Some(proxy_port)) = (
        env_opt("QA_SOCKS5_PROXY_HOST"),
        env_port("QA_SOCKS5_PROXY_PORT"),
    ) else {
        eprintln!(
            "SKIP test_upstream_socks5_dialer: set QA_SOCKS5_PROXY_HOST and QA_SOCKS5_PROXY_PORT to run"
        );
        return;
    };
    let target_host = target_host();
    let target_port = target_port();
    println!("[SOCKS5 Test] Connecting to SOCKS5 proxy {proxy_host}:{proxy_port}...");
    let result = socks5::dial(&proxy_host, proxy_port, &target_host, target_port, "", "").await;

    match result {
        Ok(mut stream) => {
            println!("[SOCKS5 Test] Handshake succeeded! Connected to {target_host}:{target_port}");
            let req =
                format!("HEAD / HTTP/1.1\r\nHost: {target_host}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(req.as_bytes()).await;
            let mut buf = [0u8; 64];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            println!("[SOCKS5 Test] Received {n} bytes response");
        }
        Err(e) => {
            panic!("SOCKS5 proxy dial to {proxy_host}:{proxy_port} failed: {e}");
        }
    }
}

/// Scenario 4: Egress dialing through an SSH direct-tcpip tunnel (opt-in).
#[tokio::test]
async fn test_upstream_ssh_tunnel_dialer() {
    let (Some(ssh_host), Some(ssh_user), Some(ssh_pass)) = (
        env_opt("QA_SSH_HOST"),
        env_opt("QA_SSH_USER"),
        env_opt("QA_SSH_PASSWORD"),
    ) else {
        eprintln!(
            "SKIP test_upstream_ssh_tunnel_dialer: set QA_SSH_HOST, QA_SSH_USER and QA_SSH_PASSWORD to run"
        );
        return;
    };
    let ssh_port = env_port("QA_SSH_PORT").unwrap_or(22);
    let target_host = target_host();
    let target_port = target_port();

    println!("[SSH Tunnel Test] Connecting to SSH server {ssh_host}:{ssh_port} as {ssh_user}...");
    let auth = SshAuth::Password(ssh_pass);
    let pool = SshPool::connect(&ssh_host, ssh_port, &ssh_user, auth)
        .await
        .expect("SSH connection failed");

    println!("[SSH Tunnel Test] Channel connected. Dialing {target_host}:{target_port} over tunnel...");
    let mut channel = pool
        .dial(&target_host, target_port, "127.0.0.1", 12345)
        .await
        .expect("SSH direct-tcpip channel creation failed");

    let req = format!(
        "HEAD / HTTP/1.1\r\nHost: {target_host}\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n"
    );
    channel
        .write_all(req.as_bytes())
        .await
        .expect("Failed to write to SSH channel");

    let mut buf = [0u8; 128];
    let n = channel
        .read(&mut buf)
        .await
        .expect("Failed to read from SSH channel");
    let resp = String::from_utf8_lossy(&buf[..n]);
    println!("[SSH Tunnel Test] Received response via SSH tunnel:\n{resp}");
    assert!(n > 0, "expected a response over the SSH tunnel");
}

/// Scenario 5: Direct curl reachability (Windows only, opt-in).
#[test]
#[cfg(target_os = "windows")]
fn test_curl_command_direct_reachability() {
    let Some(url) = env_opt("QA_DIRECT_URL") else {
        eprintln!("SKIP test_curl_command_direct_reachability: set QA_DIRECT_URL to run");
        return;
    };
    println!("[Curl Test] Testing local curl.exe against {url}...");
    let output = Command::new("curl.exe")
        .args(["-s", "-o", "NUL", "-w", "%{http_code}", &url])
        .output()
        .expect("Failed to execute curl.exe");

    let status_code = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("[Curl Test] Direct curl {url} status: {status_code}");
    assert_eq!(status_code, "200", "curl.exe should return 200 OK");
}
