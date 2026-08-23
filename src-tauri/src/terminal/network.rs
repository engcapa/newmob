//! Per-session network settings: proxy chain, keep-alive, TCP_NODELAY,
//! IP-version preference, and local port forwarding rows.
//!
//! Frontend marshals these as `networkSettings` on the IPC payload; we
//! deserialize once per connect and apply them when establishing the
//! TCP socket and when configuring the russh client.

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, lookup_host};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkForward {
    pub local: String,
    pub remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
    #[serde(default = "default_proxy_kind")]
    pub proxy_kind: String,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_user: String,
    #[serde(default)]
    pub proxy_pass: String,
    /// When set and proxy_kind is "http" or "socks5", the proxy config is
    /// resolved from a saved Proxy session at connect time. Empty means use
    /// the manual fields above.
    #[serde(default)]
    pub proxy_session_id: String,
    #[serde(default = "default_true")]
    pub keep_alive: bool,
    #[serde(default)]
    pub keep_alive_interval_secs: u64,
    #[serde(default = "default_true")]
    pub tcp_nodelay: bool,
    #[serde(default = "default_ip_version")]
    pub ip_version: String,
    #[serde(default)]
    pub local_forwards: Vec<NetworkForward>,

    // --- SSH jump host (proxy_kind == "ssh-tunnel") ---
    /// When set, the jump host is taken from a saved SSH session; the backend
    /// resolves host/port/user/auth from the sessions DB. When empty, the
    /// manual `jump_*` fields below are used instead.
    #[serde(default)]
    pub jump_session_id: String,
    #[serde(default)]
    pub jump_host: String,
    #[serde(default)]
    pub jump_port: u16,
    #[serde(default)]
    pub jump_user: String,
    /// "Password" | "PrivateKey".
    #[serde(default = "default_jump_auth_kind")]
    pub jump_auth_kind: String,
    /// Password, or a `vault:<id>` reference. Used when `jump_auth_kind` is
    /// "Password". Resolved to plaintext by `resolve_jump_secret`.
    #[serde(default)]
    pub jump_password: String,
    /// Private key file path. Used when `jump_auth_kind` is "PrivateKey".
    #[serde(default)]
    pub jump_key_path: String,
}

fn default_jump_auth_kind() -> String {
    "Password".into()
}

fn default_proxy_kind() -> String {
    "none".into()
}
fn default_ip_version() -> String {
    "auto".into()
}
fn default_true() -> bool {
    true
}

impl NetworkSettings {
    /// Parse a JSON blob coming from the frontend. Returns `None` for
    /// missing/empty input or unparseable JSON; the caller should treat
    /// that as "use defaults / no proxy".
    pub fn from_json(raw: Option<&str>) -> Option<Self> {
        let s = raw?.trim();
        if s.is_empty() {
            return None;
        }
        match serde_json::from_str::<Self>(s) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!("invalid networkSettings JSON: {}", e);
                None
            }
        }
    }

    pub fn keepalive_duration(&self) -> Option<Duration> {
        if self.keep_alive && self.keep_alive_interval_secs > 0 {
            Some(Duration::from_secs(self.keep_alive_interval_secs))
        } else {
            None
        }
    }

    /// If `proxy_pass` is a `vault:<id>` reference, replace it in-place with
    /// the resolved plaintext. Non-references are left as-is. Returns the
    /// vault error string when locked / missing so the caller can bubble
    /// `VAULT_LOCKED` to the UI.
    pub fn resolve_proxy_pass(&mut self, vault: &crate::vault::Vault) -> Result<(), String> {
        if let Some(plain) = vault.resolve(&self.proxy_pass)? {
            self.proxy_pass = (*plain).clone();
        }
        Ok(())
    }

    /// If `jump_password` is a `vault:<id>` reference, replace it in-place with
    /// the resolved plaintext. Mirrors `resolve_proxy_pass` for the SSH jump
    /// host credential; surfaces `VAULT_LOCKED` when the vault is locked.
    pub fn resolve_jump_secret(&mut self, vault: &crate::vault::Vault) -> Result<(), String> {
        if let Some(plain) = vault.resolve(&self.jump_password)? {
            self.jump_password = (*plain).clone();
        }
        Ok(())
    }

    /// True when this session should be tunnelled through an SSH jump host.
    pub fn uses_jump_host(&self) -> bool {
        self.proxy_kind == "ssh-tunnel"
    }
}

/// Resolve `host:port` honouring the IP-version preference, then connect
/// to the first address that succeeds. Returns the underlying TCP stream;
/// the caller is expected to layer SSH (or a proxy hop) on top.
async fn open_tcp_filtered(host: &str, port: u16, ip_version: &str) -> Result<TcpStream, String> {
    let mut addrs: Vec<std::net::SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup for {}:{} failed: {}", host, port, e))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("No addresses resolved for {}:{}", host, port));
    }
    match ip_version {
        "ipv4" => addrs.retain(|a| a.is_ipv4()),
        "ipv6" => addrs.retain(|a| a.is_ipv6()),
        _ => addrs.sort_by_key(|a| !a.is_ipv4()), // auto: prefer v4 first
    }
    if addrs.is_empty() {
        return Err(format!(
            "No matching IP{} addresses for {}",
            ip_version, host
        ));
    }
    let mut last_err: Option<std::io::Error> = None;
    for a in addrs {
        match TcpStream::connect(a).await {
            Ok(s) => return Ok(s),
            Err(e) => last_err = Some(e),
        }
    }
    Err(format!(
        "Could not connect to {}:{}: {}",
        host,
        port,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no addresses".into()),
    ))
}

/// Resolve the destination host into a single deterministic identifier
/// to send across a proxy hop, honoring the IP-version preference.
///
/// Semantics:
/// - `ip_version == "auto"`: pass the original hostname to the proxy and
///   let the proxy do its own resolution (preserves split-DNS / proxy-side
///   resolution, the standard behavior for HTTP CONNECT and SOCKS5).
/// - `ip_version == "ipv4"` or `"ipv6"`: resolve locally to a matching IP
///   literal and pass that to the proxy. This makes the policy
///   deterministic end-to-end even through a proxy hop.
async fn resolve_destination_for_proxy(
    host: &str,
    port: u16,
    ip_version: &str,
) -> Result<String, String> {
    if ip_version != "ipv4" && ip_version != "ipv6" {
        return Ok(host.to_string());
    }
    // Already an IP literal? respect it as-is so no surprise re-resolution.
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(host.to_string());
    }
    let addrs: Vec<std::net::SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup for {}:{} failed: {}", host, port, e))?
        .filter(|a| match ip_version {
            "ipv4" => a.is_ipv4(),
            "ipv6" => a.is_ipv6(),
            _ => true,
        })
        .collect();
    let chosen = addrs
        .into_iter()
        .next()
        .ok_or_else(|| format!("No matching IP{} addresses for {}", ip_version, host))?;
    Ok(chosen.ip().to_string())
}

/// Establish the TCP transport for an SSH connection, applying proxy hop
/// (HTTP CONNECT or SOCKS5), TCP_NODELAY, and IP-version preference per
/// the supplied `NetworkSettings`. When `network` is `None` this is a
/// direct TCP connect with `nodelay=true`.
///
/// IP-version policy under proxy: when the user picked `ipv4` / `ipv6`,
/// the destination hostname is pre-resolved locally to a matching IP
/// literal and that literal is sent to the proxy. With `auto`, the
/// hostname is forwarded as-is and the proxy performs its own
/// resolution (the standard CONNECT/SOCKS5 behavior).
pub async fn establish_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
) -> Result<TcpStream, String> {
    let ip_pref = network.map(|n| n.ip_version.as_str()).unwrap_or("auto");
    let proxy_kind = network.map(|n| n.proxy_kind.as_str()).unwrap_or("none");
    let nodelay = network.map(|n| n.tcp_nodelay).unwrap_or(true);

    let stream = match proxy_kind {
        "" | "none" => open_tcp_filtered(host, port, ip_pref).await?,
        "http" => {
            let n = network.unwrap();
            require_proxy(n)?;
            let dest = resolve_destination_for_proxy(host, port, ip_pref).await?;
            let mut s = open_tcp_filtered(&n.proxy_host, n.proxy_port, ip_pref).await?;
            s.set_nodelay(nodelay)
                .map_err(|e| format!("set_nodelay: {}", e))?;
            http_connect_handshake(&mut s, &dest, port, &n.proxy_user, &n.proxy_pass).await?;
            s
        }
        "socks5" => {
            let n = network.unwrap();
            require_proxy(n)?;
            let dest = resolve_destination_for_proxy(host, port, ip_pref).await?;
            let mut s = open_tcp_filtered(&n.proxy_host, n.proxy_port, ip_pref).await?;
            s.set_nodelay(nodelay)
                .map_err(|e| format!("set_nodelay: {}", e))?;
            socks5_handshake(&mut s, &dest, port, &n.proxy_user, &n.proxy_pass).await?;
            s
        }
        other => {
            return Err(format!(
                "Proxy type '{}' is not implemented in this build (supported: none, http, socks5).",
                other,
            ));
        }
    };

    stream
        .set_nodelay(nodelay)
        .map_err(|e| format!("set_nodelay: {}", e))?;
    Ok(stream)
}

fn require_proxy(n: &NetworkSettings) -> Result<(), String> {
    if n.proxy_host.trim().is_empty() {
        return Err("Proxy host is empty".into());
    }
    if n.proxy_port == 0 {
        return Err("Proxy port must be greater than 0".into());
    }
    Ok(())
}

async fn http_connect_handshake(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let mut req = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: keep-alive\r\n",
        host = host,
        port = port,
    );
    if !user.is_empty() {
        let token = B64.encode(format!("{}:{}", user, pass));
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", token));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("proxy write: {}", e))?;

    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = s
            .read(&mut byte)
            .await
            .map_err(|e| format!("proxy read: {}", e))?;
        if n == 0 {
            return Err("Proxy closed connection during CONNECT handshake".into());
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8192 {
            return Err("Proxy CONNECT response exceeded 8KB".into());
        }
    }
    let resp = String::from_utf8_lossy(&buf);
    let status = resp.lines().next().unwrap_or("").to_string();
    // "HTTP/1.1 200 Connection Established"
    let parts: Vec<&str> = status.split_whitespace().collect();
    if parts.len() < 2 || parts[1] != "200" {
        return Err(format!("HTTP proxy rejected CONNECT: {}", status));
    }
    Ok(())
}

async fn socks5_handshake(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let methods: Vec<u8> = if user.is_empty() {
        vec![0x00]
    } else {
        vec![0x00, 0x02]
    };
    let mut greet = vec![0x05u8, methods.len() as u8];
    greet.extend_from_slice(&methods);
    s.write_all(&greet)
        .await
        .map_err(|e| format!("socks write: {}", e))?;

    let mut sel = [0u8; 2];
    s.read_exact(&mut sel)
        .await
        .map_err(|e| format!("socks read: {}", e))?;
    if sel[0] != 0x05 {
        return Err("SOCKS5: bad version in greeting".into());
    }
    match sel[1] {
        0x00 => {}
        0x02 => {
            let u = user.as_bytes();
            let p = pass.as_bytes();
            if u.len() > 255 || p.len() > 255 {
                return Err("SOCKS5 user/pass too long (>255 bytes)".into());
            }
            let mut auth = vec![0x01u8, u.len() as u8];
            auth.extend_from_slice(u);
            auth.push(p.len() as u8);
            auth.extend_from_slice(p);
            s.write_all(&auth)
                .await
                .map_err(|e| format!("socks auth: {}", e))?;
            let mut ack = [0u8; 2];
            s.read_exact(&mut ack)
                .await
                .map_err(|e| format!("socks auth read: {}", e))?;
            if ack[1] != 0x00 {
                return Err("SOCKS5 username/password rejected".into());
            }
        }
        0xff => return Err("SOCKS5 server requires an auth method we don't support".into()),
        m => return Err(format!("SOCKS5 unsupported auth method 0x{:02x}", m)),
    }

    // Prefer ATYP=IP literal when the destination already parses as one
    // (typical when the IP-version policy pre-resolved the host); fall
    // back to ATYP=DOMAINNAME so the proxy resolves it.
    let mut req: Vec<u8> = vec![0x05, 0x01, 0x00];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            req.push(0x01);
            req.extend_from_slice(&v4.octets());
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            req.push(0x04);
            req.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            let host_bytes = host.as_bytes();
            if host_bytes.len() > 255 {
                return Err("SOCKS5 destination host too long (>255 bytes)".into());
            }
            req.push(0x03);
            req.push(host_bytes.len() as u8);
            req.extend_from_slice(host_bytes);
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req)
        .await
        .map_err(|e| format!("socks request: {}", e))?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head)
        .await
        .map_err(|e| format!("socks reply: {}", e))?;
    if head[0] != 0x05 {
        return Err("SOCKS5: bad version in reply".into());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 connect failed (rep=0x{:02x})", head[1]));
    }
    let skip = match head[3] {
        0x01 => 4usize,
        0x04 => 16,
        0x03 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)
                .await
                .map_err(|e| format!("socks bnd: {}", e))?;
            l[0] as usize
        }
        other => return Err(format!("SOCKS5 unknown ATYP 0x{:02x}", other)),
    };
    let mut bnd = vec![0u8; skip + 2];
    s.read_exact(&mut bnd)
        .await
        .map_err(|e| format!("socks bnd: {}", e))?;
    Ok(())
}

/// Parse a `host:port` row from the local-port-forwarding table. Returns
/// `(host, port)` on success, or an error suitable for surfacing to the
/// user as the reason a single forward could not be started.
pub fn parse_endpoint(s: &str) -> Result<(String, u16), String> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        // [::1]:22 - IPv6 literal in brackets
        if let Some(idx) = rest.rfind(']') {
            let host = &rest[..idx];
            let after = &rest[idx + 1..];
            let port_str = after
                .strip_prefix(':')
                .ok_or_else(|| format!("missing port in '{}'", s))?;
            let port: u16 = port_str
                .parse()
                .map_err(|_| format!("invalid port in '{}'", s))?;
            return Ok((host.to_string(), port));
        }
        return Err(format!("unbalanced brackets in '{}'", s));
    }
    let (host, port_str) = s
        .rsplit_once(':')
        .ok_or_else(|| format!("expected host:port, got '{}'", s))?;
    if host.is_empty() {
        return Err(format!("empty host in '{}'", s));
    }
    let port: u16 = port_str
        .parse()
        .map_err(|_| format!("invalid port in '{}'", s))?;
    Ok((host.to_string(), port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn parse_endpoint_host_port() {
        let (h, p) = parse_endpoint("db.lan:5432").unwrap();
        assert_eq!(h, "db.lan");
        assert_eq!(p, 5432);
    }

    #[test]
    fn parse_endpoint_ipv6_bracketed() {
        let (h, p) = parse_endpoint("[::1]:22").unwrap();
        assert_eq!(h, "::1");
        assert_eq!(p, 22);
    }

    #[test]
    fn parse_endpoint_rejects_garbage() {
        assert!(parse_endpoint("no-port-here").is_err());
        assert!(parse_endpoint(":5432").is_err());
        assert!(parse_endpoint("host:notaport").is_err());
        assert!(parse_endpoint("[::1:22").is_err());
    }

    #[test]
    fn from_json_returns_none_on_empty_or_garbage() {
        assert!(NetworkSettings::from_json(None).is_none());
        assert!(NetworkSettings::from_json(Some("")).is_none());
        assert!(NetworkSettings::from_json(Some("   ")).is_none());
        assert!(NetworkSettings::from_json(Some("not-json")).is_none());
    }

    #[test]
    fn from_json_parses_jump_host_fields() {
        let raw = r#"{
            "proxyKind": "ssh-tunnel",
            "jumpSessionId": "",
            "jumpHost": "bastion.lan",
            "jumpPort": 2222,
            "jumpUser": "ops",
            "jumpAuthKind": "PrivateKey",
            "jumpKeyPath": "~/.ssh/id_ed25519"
        }"#;
        let n = NetworkSettings::from_json(Some(raw)).expect("parsed");
        assert!(n.uses_jump_host());
        assert_eq!(n.jump_host, "bastion.lan");
        assert_eq!(n.jump_port, 2222);
        assert_eq!(n.jump_user, "ops");
        assert_eq!(n.jump_auth_kind, "PrivateKey");
        assert_eq!(n.jump_key_path, "~/.ssh/id_ed25519");
    }

    #[test]
    fn jump_defaults_apply_when_fields_absent() {
        // A bare proxy config without any jump_* keys still deserializes; the
        // jump fields take their serde defaults and uses_jump_host() is false.
        let n = NetworkSettings::from_json(Some(r#"{"proxyKind":"none"}"#)).expect("parsed");
        assert!(!n.uses_jump_host());
        assert_eq!(n.jump_auth_kind, "Password");
        assert_eq!(n.jump_port, 0);
        assert!(n.jump_host.is_empty());
    }

    #[test]
    fn from_json_round_trip_camel_case() {
        let raw = r#"{
            "proxyKind": "http",
            "proxyHost": "proxy.corp",
            "proxyPort": 3128,
            "proxyUser": "alice",
            "proxyPass": "s3cret",
            "keepAlive": true,
            "keepAliveIntervalSecs": 30,
            "tcpNodelay": false,
            "ipVersion": "ipv6",
            "localForwards": [{"local":"127.0.0.1:5432","remote":"db.lan:5432"}]
        }"#;
        let n = NetworkSettings::from_json(Some(raw)).expect("parsed");
        assert_eq!(n.proxy_kind, "http");
        assert_eq!(n.proxy_host, "proxy.corp");
        assert_eq!(n.proxy_port, 3128);
        assert_eq!(n.proxy_user, "alice");
        assert_eq!(n.proxy_pass, "s3cret");
        assert!(n.keep_alive);
        assert_eq!(n.keep_alive_interval_secs, 30);
        assert!(!n.tcp_nodelay);
        assert_eq!(n.ip_version, "ipv6");
        assert_eq!(n.local_forwards.len(), 1);
        assert_eq!(n.local_forwards[0].local, "127.0.0.1:5432");
        assert_eq!(n.local_forwards[0].remote, "db.lan:5432");
    }

    #[test]
    fn keepalive_duration_respects_flag_and_interval() {
        let mut n = NetworkSettings::default();
        n.keep_alive = false;
        n.keep_alive_interval_secs = 30;
        assert!(n.keepalive_duration().is_none());

        n.keep_alive = true;
        n.keep_alive_interval_secs = 0;
        assert!(n.keepalive_duration().is_none());

        n.keep_alive_interval_secs = 30;
        assert_eq!(n.keepalive_duration(), Some(Duration::from_secs(30)));
    }

    #[tokio::test]
    async fn establish_transport_rejects_unsupported_proxy_kinds() {
        // `socks4` is no longer offered by the UI but a legacy/hand-crafted
        // value must still be safely rejected rather than mishandled.
        for kind in ["socks4", "system"] {
            let mut n = NetworkSettings::default();
            n.proxy_kind = kind.into();
            n.proxy_host = "127.0.0.1".into();
            n.proxy_port = 1;
            let err = establish_transport("example.com", 22, Some(&n))
                .await
                .expect_err("should reject unsupported proxy kind");
            assert!(err.contains("not implemented"), "got: {}", err);
        }
    }

    #[tokio::test]
    async fn establish_transport_validates_proxy_fields() {
        let mut n = NetworkSettings::default();
        n.proxy_kind = "http".into();
        // empty proxy_host
        n.proxy_host = "".into();
        n.proxy_port = 3128;
        let err = establish_transport("example.com", 22, Some(&n))
            .await
            .expect_err("empty proxy host should error");
        assert!(err.to_lowercase().contains("proxy host"), "got: {}", err);

        n.proxy_host = "127.0.0.1".into();
        n.proxy_port = 0;
        let err = establish_transport("example.com", 22, Some(&n))
            .await
            .expect_err("zero proxy port should error");
        assert!(err.to_lowercase().contains("proxy port"), "got: {}", err);
    }

    #[tokio::test]
    async fn resolve_destination_passes_through_in_auto_mode() {
        let dest = resolve_destination_for_proxy("example.com", 22, "auto")
            .await
            .unwrap();
        assert_eq!(dest, "example.com");
    }

    #[tokio::test]
    async fn resolve_destination_keeps_ip_literals_unchanged() {
        let dest = resolve_destination_for_proxy("203.0.113.5", 22, "ipv4")
            .await
            .unwrap();
        assert_eq!(dest, "203.0.113.5");
    }

    // -----------------------------------------------------------------------
    // Strategy 1: real-server handshake verification.
    //
    // Stand up an in-process echo server and an in-process proxy (SOCKS5 /
    // HTTP CONNECT) that bridges to it, then drive `establish_transport`
    // through the proxy and assert a byte round-trips end-to-end. This
    // exercises the actual client handshake bytes against a real listener —
    // no network, no external services, always runs under `cargo test`.
    // -----------------------------------------------------------------------

    /// Spawn a loopback TCP echo server. Returns its `(host, port)`.
    async fn spawn_echo() -> (String, u16) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    loop {
                        match s.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if s.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        ("127.0.0.1".to_string(), port)
    }

    /// Spawn a minimal SOCKS5 proxy (no-auth) that connects to whatever target
    /// the client requests and pumps bytes both ways. Returns its port.
    async fn spawn_socks5_proxy() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // Greeting: VER, NMETHODS, METHODS...
                    let mut head = [0u8; 2];
                    if c.read_exact(&mut head).await.is_err() {
                        return;
                    }
                    let mut methods = vec![0u8; head[1] as usize];
                    let _ = c.read_exact(&mut methods).await;
                    // Select no-auth.
                    let _ = c.write_all(&[0x05, 0x00]).await;
                    // Request: VER CMD RSV ATYP ...
                    let mut req = [0u8; 4];
                    if c.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let host = match req[3] {
                        0x01 => {
                            let mut a = [0u8; 4];
                            let _ = c.read_exact(&mut a).await;
                            std::net::Ipv4Addr::from(a).to_string()
                        }
                        0x03 => {
                            let mut l = [0u8; 1];
                            let _ = c.read_exact(&mut l).await;
                            let mut d = vec![0u8; l[0] as usize];
                            let _ = c.read_exact(&mut d).await;
                            String::from_utf8_lossy(&d).to_string()
                        }
                        0x04 => {
                            let mut a = [0u8; 16];
                            let _ = c.read_exact(&mut a).await;
                            std::net::Ipv6Addr::from(a).to_string()
                        }
                        _ => return,
                    };
                    let mut p = [0u8; 2];
                    let _ = c.read_exact(&mut p).await;
                    let dport = u16::from_be_bytes(p);
                    // Reply success with a dummy BND.ADDR.
                    let _ = c
                        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                        .await;
                    if let Ok(mut up) = TcpStream::connect((host.as_str(), dport)).await {
                        let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                    }
                });
            }
        });
        port
    }

    /// Spawn a minimal HTTP CONNECT proxy that tunnels to the requested target.
    async fn spawn_http_connect_proxy() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // Read request headers up to CRLFCRLF.
                    let mut buf = Vec::new();
                    let mut byte = [0u8; 1];
                    loop {
                        match c.read(&mut byte).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => {
                                buf.push(byte[0]);
                                if buf.ends_with(b"\r\n\r\n") {
                                    break;
                                }
                                if buf.len() > 8192 {
                                    return;
                                }
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&buf);
                    // First line: "CONNECT host:port HTTP/1.1"
                    let target = text
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .map(|s| s.to_string());
                    let Some(target) = target else {
                        return;
                    };
                    let _ = c
                        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                        .await;
                    if let Ok(mut up) = TcpStream::connect(target).await {
                        let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn socks5_handshake_round_trips_through_real_proxy() {
        let (echo_host, echo_port) = spawn_echo().await;
        let proxy_port = spawn_socks5_proxy().await;

        let mut n = NetworkSettings::default();
        n.proxy_kind = "socks5".into();
        n.proxy_host = "127.0.0.1".into();
        n.proxy_port = proxy_port;

        let mut stream = establish_transport(&echo_host, echo_port, Some(&n))
            .await
            .expect("socks5 establish_transport");
        stream.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
    }

    #[tokio::test]
    async fn http_connect_handshake_round_trips_through_real_proxy() {
        let (echo_host, echo_port) = spawn_echo().await;
        let proxy_port = spawn_http_connect_proxy().await;

        let mut n = NetworkSettings::default();
        n.proxy_kind = "http".into();
        n.proxy_host = "127.0.0.1".into();
        n.proxy_port = proxy_port;

        let mut stream = establish_transport(&echo_host, echo_port, Some(&n))
            .await
            .expect("http establish_transport");
        stream.write_all(b"pong").await.unwrap();
        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"pong");
    }

    #[tokio::test]
    async fn socks5_handshake_with_username_password_auth() {
        // Verify the client speaks user/pass (RFC 1929) when credentials are
        // set: a proxy that *requires* method 0x02 must complete the auth
        // sub-negotiation and then bridge to the target.
        let (echo_host, echo_port) = spawn_echo().await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut c, _) = listener.accept().await.unwrap();
            let mut head = [0u8; 2];
            c.read_exact(&mut head).await.unwrap();
            let mut methods = vec![0u8; head[1] as usize];
            c.read_exact(&mut methods).await.unwrap();
            assert!(methods.contains(&0x02), "client must offer user/pass");
            // Require user/pass.
            c.write_all(&[0x05, 0x02]).await.unwrap();
            // Auth sub-negotiation: VER=1, ULEN, UNAME, PLEN, PASSWD.
            let mut v = [0u8; 2];
            c.read_exact(&mut v).await.unwrap();
            assert_eq!(v[0], 0x01);
            let mut uname = vec![0u8; v[1] as usize];
            c.read_exact(&mut uname).await.unwrap();
            let mut pl = [0u8; 1];
            c.read_exact(&mut pl).await.unwrap();
            let mut passwd = vec![0u8; pl[0] as usize];
            c.read_exact(&mut passwd).await.unwrap();
            assert_eq!(uname, b"alice");
            assert_eq!(passwd, b"s3cret");
            c.write_all(&[0x01, 0x00]).await.unwrap(); // auth ok
            // Request.
            let mut req = [0u8; 4];
            c.read_exact(&mut req).await.unwrap();
            let host = match req[3] {
                0x01 => {
                    let mut a = [0u8; 4];
                    c.read_exact(&mut a).await.unwrap();
                    std::net::Ipv4Addr::from(a).to_string()
                }
                0x03 => {
                    let mut l = [0u8; 1];
                    c.read_exact(&mut l).await.unwrap();
                    let mut d = vec![0u8; l[0] as usize];
                    c.read_exact(&mut d).await.unwrap();
                    String::from_utf8_lossy(&d).to_string()
                }
                _ => return,
            };
            let mut p = [0u8; 2];
            c.read_exact(&mut p).await.unwrap();
            let dport = u16::from_be_bytes(p);
            c.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            if let Ok(mut up) = TcpStream::connect((host.as_str(), dport)).await {
                let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
            }
        });

        let mut n = NetworkSettings::default();
        n.proxy_kind = "socks5".into();
        n.proxy_host = "127.0.0.1".into();
        n.proxy_port = proxy_port;
        n.proxy_user = "alice".into();
        n.proxy_pass = "s3cret".into();

        let mut stream = establish_transport(&echo_host, echo_port, Some(&n))
            .await
            .expect("socks5 auth establish_transport");
        stream.write_all(b"auth").await.unwrap();
        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"auth");
    }
}
