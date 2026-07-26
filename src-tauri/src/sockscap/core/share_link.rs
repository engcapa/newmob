//! Parse proxy share links (`ss://` / `trojan://` / `vmess://` / `vless://`)
//! into a [`ParsedShareLink`] the UI can drop into an upstream form.
//!
//! Pure and dependency-light (base64 + url only). Secrets are returned as
//! plaintext for the caller (frontend) to store as `vault:<id>` refs — this
//! module never touches the vault or disk. SSR (`ssr://`) is intentionally
//! unsupported (dropped from the project).

use base64::{Engine as _, engine::general_purpose};

use crate::sockscap::config::{UpstreamKind, UpstreamParams};

/// A share link decoded into upstream fields. `secret` / `uuid` are plaintext
/// (the frontend vaults them into `password_ref` / `params.uuid_ref`).
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedShareLink {
    pub kind_tag: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub params: UpstreamParams,
    /// SS / Trojan password (plaintext).
    pub secret: String,
    /// VMess / VLESS UUID (plaintext).
    pub uuid: String,
}

/// Decode base64 tolerating both standard and URL-safe alphabets, with or
/// without padding (share links use all four combinations).
fn b64_decode_loose(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    for eng in [
        &general_purpose::STANDARD,
        &general_purpose::URL_SAFE,
        &general_purpose::STANDARD_NO_PAD,
        &general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(v) = eng.decode(s) {
            return Ok(v);
        }
    }
    Err("invalid base64".into())
}

/// Percent-decode a query/fragment component to UTF-8 (lossy).
fn pct_decode(s: &str) -> String {
    percent_decode(s)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Split a URL-shaped link into (userinfo, host, port, query-map, fragment).
struct UrlParts {
    userinfo: String,
    host: String,
    port: u16,
    query: std::collections::HashMap<String, String>,
    fragment: String,
}

fn parse_url_shaped(rest: &str) -> Result<UrlParts, String> {
    // rest = userinfo@host:port?query#fragment  (scheme already stripped)
    let (before_frag, fragment) = match rest.split_once('#') {
        Some((a, b)) => (a, pct_decode(b)),
        None => (rest, String::new()),
    };
    let (before_query, query_str) = match before_frag.split_once('?') {
        Some((a, b)) => (a, b),
        None => (before_frag, ""),
    };
    let (userinfo, hostport) = match before_query.rsplit_once('@') {
        Some((u, hp)) => (u.to_string(), hp),
        None => (String::new(), before_query),
    };
    let (host, port) = split_host_port(hostport)?;
    let mut query = std::collections::HashMap::new();
    for pair in query_str.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(k.to_string(), pct_decode(v));
    }
    Ok(UrlParts {
        userinfo,
        host,
        port,
        query,
        fragment,
    })
}

fn split_host_port(hp: &str) -> Result<(String, u16), String> {
    // Support [v6]:port and host:port.
    if let Some(stripped) = hp.strip_prefix('[') {
        let (h, rest) = stripped
            .split_once(']')
            .ok_or_else(|| "malformed IPv6 host".to_string())?;
        let port = rest
            .trim_start_matches(':')
            .parse::<u16>()
            .map_err(|_| "invalid port".to_string())?;
        return Ok((h.to_string(), port));
    }
    let (h, p) = hp
        .rsplit_once(':')
        .ok_or_else(|| "missing host:port".to_string())?;
    let port = p.parse::<u16>().map_err(|_| "invalid port".to_string())?;
    if h.is_empty() {
        return Err("empty host".into());
    }
    Ok((h.to_string(), port))
}

/// Common transport/TLS extraction shared by trojan/vless from a query map.
fn transport_from_query(
    q: &std::collections::HashMap<String, String>,
    params: &mut UpstreamParams,
) {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    // type = transport (tcp/ws/grpc/h2/httpupgrade)
    let net = get("type");
    if !net.is_empty() {
        params.network = net;
    }
    // security = tls/reality/none
    let sec = get("security");
    if !sec.is_empty() {
        params.tls = sec;
    }
    let sni = if !get("sni").is_empty() {
        get("sni")
    } else {
        get("peer")
    };
    if !sni.is_empty() {
        params.sni = sni;
    }
    // ws/httpupgrade path + host
    let path = get("path");
    if !path.is_empty() {
        params.path = path;
    }
    let host_hdr = if !get("host").is_empty() {
        get("host")
    } else {
        get("serviceName") // grpc
    };
    if !host_hdr.is_empty() {
        params.ws_host = host_hdr;
    }
    let fp = get("fp");
    if !fp.is_empty() {
        params.fingerprint = fp;
    }
    // REALITY
    let pbk = get("pbk");
    if !pbk.is_empty() {
        params.reality_public_key = pbk;
    }
    let sid = get("sid");
    if !sid.is_empty() {
        params.reality_short_id = sid;
    }
    if q.get("allowInsecure").map(|v| v == "1" || v == "true") == Some(true) {
        params.allow_insecure = true;
    }
}

/// Parse a single share link. Errors on unknown/unsupported schemes.
pub fn parse(link: &str) -> Result<ParsedShareLink, String> {
    let link = link.trim();
    if let Some(rest) = link.strip_prefix("ss://") {
        parse_ss(rest)
    } else if let Some(rest) = link.strip_prefix("trojan://") {
        parse_trojan(rest)
    } else if let Some(rest) = link.strip_prefix("vmess://") {
        parse_vmess(rest)
    } else if let Some(rest) = link.strip_prefix("vless://") {
        parse_vless(rest)
    } else if link.starts_with("ssr://") {
        Err("ShadowsocksR is not supported".into())
    } else {
        Err("unrecognized share link scheme".into())
    }
}

/// ss://  — SIP002 (`base64(method:pass)@host:port#tag`) and the legacy
/// fully-base64 form (`base64(method:pass@host:port)#tag`).
fn parse_ss(rest: &str) -> Result<ParsedShareLink, String> {
    let (body, tag) = match rest.split_once('#') {
        Some((a, b)) => (a, pct_decode(b)),
        None => (rest, String::new()),
    };
    // Drop any plugin query (?plugin=...) — unsupported, but must not break parsing.
    let body = body.split('?').next().unwrap_or(body);

    let (method, password, host, port);
    if let Some((userinfo, hostport)) = body.rsplit_once('@') {
        // SIP002: userinfo is base64(method:password) (or already method:password).
        let decoded = b64_decode_loose(userinfo)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| pct_decode(userinfo));
        let (m, p) = decoded
            .split_once(':')
            .ok_or_else(|| "ss userinfo not method:password".to_string())?;
        method = m.to_string();
        password = p.to_string();
        let (h, pt) = split_host_port(hostport)?;
        host = h;
        port = pt;
    } else {
        // Legacy: whole body is base64(method:password@host:port).
        let decoded = b64_decode_loose(body)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| "ss legacy body not base64".to_string())?;
        let (creds, hostport) = decoded
            .rsplit_once('@')
            .ok_or_else(|| "ss legacy missing @host:port".to_string())?;
        let (m, p) = creds
            .split_once(':')
            .ok_or_else(|| "ss legacy creds not method:password".to_string())?;
        method = m.to_string();
        password = p.to_string();
        let (h, pt) = split_host_port(hostport)?;
        host = h;
        port = pt;
    }

    let mut params = UpstreamParams::default();
    params.method = method;
    Ok(ParsedShareLink {
        kind_tag: UpstreamKind::Shadowsocks.as_tag().to_string(),
        name: tag,
        host,
        port,
        params,
        secret: password,
        uuid: String::new(),
    })
}

/// trojan://password@host:port?security=tls&sni=..&type=ws&path=..#tag
fn parse_trojan(rest: &str) -> Result<ParsedShareLink, String> {
    let u = parse_url_shaped(rest)?;
    let password = pct_decode(&u.userinfo);
    if password.is_empty() {
        return Err("trojan link missing password".into());
    }
    let mut params = UpstreamParams::default();
    // trojan defaults to TLS unless the query says otherwise.
    params.tls = "tls".into();
    transport_from_query(&u.query, &mut params);
    Ok(ParsedShareLink {
        kind_tag: UpstreamKind::Trojan.as_tag().to_string(),
        name: u.fragment,
        host: u.host,
        port: u.port,
        params,
        secret: password,
        uuid: String::new(),
    })
}

/// vless://uuid@host:port?encryption=none&flow=..&security=..&type=..&..#tag
fn parse_vless(rest: &str) -> Result<ParsedShareLink, String> {
    let u = parse_url_shaped(rest)?;
    let uuid = pct_decode(&u.userinfo);
    if uuid.is_empty() {
        return Err("vless link missing uuid".into());
    }
    let mut params = UpstreamParams::default();
    let enc = u.query.get("encryption").cloned().unwrap_or_default();
    params.encryption = if enc.is_empty() { "none".into() } else { enc };
    if let Some(flow) = u.query.get("flow") {
        params.flow = flow.clone();
    }
    transport_from_query(&u.query, &mut params);
    Ok(ParsedShareLink {
        kind_tag: UpstreamKind::Vless.as_tag().to_string(),
        name: u.fragment,
        host: u.host,
        port: u.port,
        params,
        secret: String::new(),
        uuid,
    })
}

/// vmess://base64(json) with the standard v2rayN field set.
fn parse_vmess(rest: &str) -> Result<ParsedShareLink, String> {
    let json = b64_decode_loose(rest)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| "vmess body not base64 json".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("vmess json: {e}"))?;

    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    // port / aid may be number or string.
    let num = |k: &str| -> String {
        v.get(k)
            .map(|x| match x {
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::String(st) => st.clone(),
                _ => String::new(),
            })
            .unwrap_or_default()
    };

    let host = s("add");
    let port = num("port").parse::<u16>().map_err(|_| "vmess bad port".to_string())?;
    let uuid = s("id");
    if uuid.is_empty() {
        return Err("vmess missing id".into());
    }

    let mut params = UpstreamParams::default();
    params.security = {
        let scy = s("scy");
        if scy.is_empty() { "auto".into() } else { scy }
    };
    let net = s("net");
    if !net.is_empty() {
        params.network = net;
    }
    let path = s("path");
    if !path.is_empty() {
        params.path = path;
    }
    let hhost = s("host");
    if !hhost.is_empty() {
        params.ws_host = hhost;
    }
    let tls = s("tls");
    if !tls.is_empty() {
        params.tls = tls; // "tls" or ""
    }
    let sni = s("sni");
    if !sni.is_empty() {
        params.sni = sni;
    }

    Ok(ParsedShareLink {
        kind_tag: UpstreamKind::Vmess.as_tag().to_string(),
        name: s("ps"),
        host,
        port,
        params,
        secret: String::new(),
        uuid,
    })
}

/// Parse a subscription blob: base64 of newline-separated links, or plain
/// newline-separated links. Unparseable lines are skipped (best-effort).
pub fn parse_subscription(blob: &str) -> Vec<ParsedShareLink> {
    let text = b64_decode_loose(blob)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| blob.to_string());
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| parse(l).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ss_sip002() {
        // base64("aes-256-gcm:pass123") = YWVzLTI1Ni1nY206cGFzczEyMw==
        let link = "ss://YWVzLTI1Ni1nY206cGFzczEyMw==@1.2.3.4:8388#My%20Node";
        let p = parse(link).unwrap();
        assert_eq!(p.kind_tag, "shadowsocks");
        assert_eq!(p.host, "1.2.3.4");
        assert_eq!(p.port, 8388);
        assert_eq!(p.params.method, "aes-256-gcm");
        assert_eq!(p.secret, "pass123");
        assert_eq!(p.name, "My Node");
    }

    #[test]
    fn parse_ss_legacy_all_base64() {
        // base64("aes-256-gcm:pw@9.9.9.9:443")
        let inner = general_purpose::STANDARD.encode("aes-256-gcm:pw@9.9.9.9:443");
        let link = format!("ss://{inner}#legacy");
        let p = parse(&link).unwrap();
        assert_eq!(p.host, "9.9.9.9");
        assert_eq!(p.port, 443);
        assert_eq!(p.secret, "pw");
        assert_eq!(p.params.method, "aes-256-gcm");
    }

    #[test]
    fn parse_trojan_with_ws_tls() {
        let link = "trojan://mypass@example.com:443?security=tls&type=ws&path=%2Fws&sni=example.com&host=cdn.example.com#T";
        let p = parse(link).unwrap();
        assert_eq!(p.kind_tag, "trojan");
        assert_eq!(p.host, "example.com");
        assert_eq!(p.port, 443);
        assert_eq!(p.secret, "mypass");
        assert_eq!(p.params.tls, "tls");
        assert_eq!(p.params.network, "ws");
        assert_eq!(p.params.path, "/ws");
        assert_eq!(p.params.sni, "example.com");
        assert_eq!(p.params.ws_host, "cdn.example.com");
    }

    #[test]
    fn parse_vless_reality() {
        let link = "vless://11111111-2222-3333-4444-555555555555@node:443?encryption=none&flow=xtls-rprx-vision&security=reality&pbk=PUBKEY&sid=ab&fp=chrome&sni=www.microsoft.com#R";
        let p = parse(link).unwrap();
        assert_eq!(p.kind_tag, "vless");
        assert_eq!(p.uuid, "11111111-2222-3333-4444-555555555555");
        assert_eq!(p.params.flow, "xtls-rprx-vision");
        assert_eq!(p.params.tls, "reality");
        assert_eq!(p.params.reality_public_key, "PUBKEY");
        assert_eq!(p.params.reality_short_id, "ab");
        assert_eq!(p.params.fingerprint, "chrome");
        assert_eq!(p.params.sni, "www.microsoft.com");
    }

    #[test]
    fn parse_vmess_json() {
        let json = r#"{"v":"2","ps":"vm node","add":"1.2.3.4","port":"443","id":"abc-uuid","aid":"0","scy":"auto","net":"ws","type":"none","host":"h.example.com","path":"/p","tls":"tls","sni":"h.example.com"}"#;
        let link = format!("vmess://{}", general_purpose::STANDARD.encode(json));
        let p = parse(&link).unwrap();
        assert_eq!(p.kind_tag, "vmess");
        assert_eq!(p.host, "1.2.3.4");
        assert_eq!(p.port, 443);
        assert_eq!(p.uuid, "abc-uuid");
        assert_eq!(p.params.network, "ws");
        assert_eq!(p.params.path, "/p");
        assert_eq!(p.params.ws_host, "h.example.com");
        assert_eq!(p.params.tls, "tls");
        assert_eq!(p.name, "vm node");
    }

    #[test]
    fn ipv6_host_port() {
        let link = "trojan://pw@[2001:db8::1]:8443#v6";
        let p = parse(link).unwrap();
        assert_eq!(p.host, "2001:db8::1");
        assert_eq!(p.port, 8443);
    }

    #[test]
    fn ssr_rejected() {
        assert!(parse("ssr://whatever").is_err());
    }

    #[test]
    fn unknown_scheme_rejected() {
        assert!(parse("http://example.com").is_err());
    }

    #[test]
    fn subscription_base64_multiline() {
        let l1 = "ss://YWVzLTI1Ni1nY206cGFzczEyMw==@1.2.3.4:8388#n1";
        let l2 = "trojan://pw@ex.com:443#n2";
        let blob = general_purpose::STANDARD.encode(format!("{l1}\n{l2}\n"));
        let out = parse_subscription(&blob);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind_tag, "shadowsocks");
        assert_eq!(out[1].kind_tag, "trojan");
    }
}
