//! Generate an xray-core JSON config for a single SocksCap upstream.
//!
//! Each core-backed upstream becomes a minimal xray instance:
//!   - one `socks` inbound on `127.0.0.1:<local_port>` (no auth, loopback only)
//!   - one protocol outbound (shadowsocks / trojan / vmess / vless / wireguard)
//!
//! The SocksCap relay then dials that local SOCKS port through the existing
//! `egress::socks5` dialer, so all protocol/crypto/transport complexity lives
//! in xray-core, not in taomni.
//!
//! This module is pure (no process, no vault, no filesystem): it takes an
//! already-resolved spec (secrets decrypted by the caller) and returns
//! `serde_json::Value`. That keeps it unit-testable with snapshot assertions.

use serde_json::{Value, json};

use crate::sockscap::config::{UpstreamKind, UpstreamParams};

/// An upstream with all `vault:<id>` references already resolved to plaintext by
/// the caller (orchestrator). Never persisted; lives only for the duration of a
/// core spawn.
#[derive(Debug, Clone)]
pub struct ResolvedCoreUpstream {
    pub kind: UpstreamKind,
    pub host: String,
    pub port: u16,
    /// Primary secret: SS password / trojan password (plaintext, resolved).
    pub secret: String,
    /// Resolved UUID (vmess/vless).
    pub uuid: String,
    /// Resolved WireGuard local private key.
    pub private_key: String,
    /// Resolved WireGuard pre-shared key (optional).
    pub pre_shared_key: String,
    pub params: UpstreamParams,
}

impl ResolvedCoreUpstream {
    /// Build the full xray config document for this upstream, listening on
    /// `local_port` for loopback SOCKS.
    pub fn to_xray_config(&self, local_port: u16) -> Result<Value, String> {
        if !self.kind.requires_core() {
            return Err(format!(
                "{} is not a core-backed upstream",
                self.kind.as_tag()
            ));
        }
        if self.host.trim().is_empty() {
            return Err("upstream host is empty".into());
        }
        if self.port == 0 {
            return Err("upstream port must be > 0".into());
        }

        let outbound = self.build_outbound()?;
        Ok(json!({
            // Quiet by default; the manager captures stderr for diagnostics.
            "log": { "loglevel": "warning" },
            "inbounds": [{
                "tag": "socks-in",
                "listen": "127.0.0.1",
                "port": local_port,
                "protocol": "socks",
                "settings": {
                    "udp": false,
                    "auth": "noauth"
                },
                "sniffing": { "enabled": false }
            }],
            "outbounds": [outbound]
        }))
    }

    fn build_outbound(&self) -> Result<Value, String> {
        let settings = match self.kind {
            UpstreamKind::Shadowsocks => self.shadowsocks_settings()?,
            UpstreamKind::Trojan => self.trojan_settings()?,
            UpstreamKind::Vmess => self.vmess_settings()?,
            UpstreamKind::Vless => self.vless_settings()?,
            UpstreamKind::Wireguard => self.wireguard_settings()?,
            other => return Err(format!("{} is not core-backed", other.as_tag())),
        };

        let mut ob = json!({
            "tag": "proxy",
            "protocol": self.kind.as_tag(),
            "settings": settings,
        });

        // WireGuard carries endpoints in its own settings; no streamSettings.
        if !matches!(self.kind, UpstreamKind::Wireguard) {
            if let Some(stream) = self.stream_settings() {
                ob["streamSettings"] = stream;
            }
        }
        Ok(ob)
    }

    fn shadowsocks_settings(&self) -> Result<Value, String> {
        let method = if self.params.method.is_empty() {
            "aes-256-gcm"
        } else {
            &self.params.method
        };
        Ok(json!({
            "servers": [{
                "address": self.host,
                "port": self.port,
                "method": method,
                "password": self.secret,
            }]
        }))
    }

    fn trojan_settings(&self) -> Result<Value, String> {
        if self.secret.is_empty() {
            return Err("trojan requires a password".into());
        }
        Ok(json!({
            "servers": [{
                "address": self.host,
                "port": self.port,
                "password": self.secret,
            }]
        }))
    }

    fn vmess_settings(&self) -> Result<Value, String> {
        if self.uuid.is_empty() {
            return Err("vmess requires a uuid".into());
        }
        let security = if self.params.security.is_empty() {
            "auto"
        } else {
            &self.params.security
        };
        Ok(json!({
            "vnext": [{
                "address": self.host,
                "port": self.port,
                "users": [{
                    "id": self.uuid,
                    "security": security,
                }]
            }]
        }))
    }

    fn vless_settings(&self) -> Result<Value, String> {
        if self.uuid.is_empty() {
            return Err("vless requires a uuid".into());
        }
        let mut user = json!({
            "id": self.uuid,
            "encryption": if self.params.encryption.is_empty() {
                "none"
            } else {
                &self.params.encryption
            },
        });
        if !self.params.flow.is_empty() {
            user["flow"] = json!(self.params.flow);
        }
        Ok(json!({
            "vnext": [{
                "address": self.host,
                "port": self.port,
                "users": [user]
            }]
        }))
    }

    fn wireguard_settings(&self) -> Result<Value, String> {
        if self.private_key.is_empty() {
            return Err("wireguard requires a local private key".into());
        }
        if self.params.peer_public_key.is_empty() {
            return Err("wireguard requires a peer public key".into());
        }
        let mut peer = json!({
            "publicKey": self.params.peer_public_key,
            "endpoint": format!("{}:{}", self.host, self.port),
            // Route everything through the tunnel; policy already decided PROXY.
            "allowedIPs": ["0.0.0.0/0", "::/0"],
        });
        if !self.pre_shared_key.is_empty() {
            peer["preSharedKey"] = json!(self.pre_shared_key);
        }
        let mut settings = json!({
            "secretKey": self.private_key,
            "peers": [peer],
        });
        if !self.params.local_address.is_empty() {
            settings["address"] = json!(self.params.local_address);
        }
        if self.params.mtu > 0 {
            settings["mtu"] = json!(self.params.mtu);
        }
        Ok(settings)
    }

    /// Build `streamSettings` (transport + TLS/REALITY) shared by trojan/vmess/vless.
    /// Returns None for a plain TCP + no-TLS transport (xray defaults suffice).
    fn stream_settings(&self) -> Option<Value> {
        let p = &self.params;
        let network = if p.network.is_empty() {
            "tcp"
        } else {
            &p.network
        };
        let tls = if p.tls.is_empty() { "none" } else { &p.tls };

        if network == "tcp" && tls == "none" {
            return None;
        }

        let mut stream = json!({ "network": network, "security": tls });

        match network {
            "ws" | "httpupgrade" => {
                let mut t = json!({});
                if !p.path.is_empty() {
                    t["path"] = json!(p.path);
                }
                if !p.ws_host.is_empty() {
                    t["host"] = json!(p.ws_host);
                }
                let key = if network == "ws" {
                    "wsSettings"
                } else {
                    "httpupgradeSettings"
                };
                stream[key] = t;
            }
            "grpc" => {
                stream["grpcSettings"] = json!({ "serviceName": p.path });
            }
            _ => {}
        }

        match tls {
            "tls" => {
                let mut t = json!({});
                let sni = if p.sni.is_empty() { &self.host } else { &p.sni };
                t["serverName"] = json!(sni);
                if !p.alpn.is_empty() {
                    t["alpn"] = json!(p.alpn);
                }
                if !p.fingerprint.is_empty() {
                    t["fingerprint"] = json!(p.fingerprint);
                }
                if p.allow_insecure {
                    t["allowInsecure"] = json!(true);
                }
                stream["tlsSettings"] = t;
            }
            "reality" => {
                let mut t = json!({});
                let sni = if p.sni.is_empty() { &self.host } else { &p.sni };
                t["serverName"] = json!(sni);
                if !p.fingerprint.is_empty() {
                    t["fingerprint"] = json!(p.fingerprint);
                }
                if !p.reality_public_key.is_empty() {
                    t["publicKey"] = json!(p.reality_public_key);
                }
                if !p.reality_short_id.is_empty() {
                    t["shortId"] = json!(p.reality_short_id);
                }
                stream["realitySettings"] = t;
            }
            _ => {}
        }

        Some(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(kind: UpstreamKind) -> ResolvedCoreUpstream {
        ResolvedCoreUpstream {
            kind,
            host: "node.example.com".into(),
            port: 443,
            secret: String::new(),
            uuid: String::new(),
            private_key: String::new(),
            pre_shared_key: String::new(),
            params: UpstreamParams::default(),
        }
    }

    #[test]
    fn shadowsocks_default_cipher_and_inbound() {
        let mut up = base(UpstreamKind::Shadowsocks);
        up.secret = "hunter2".into();
        let cfg = up.to_xray_config(10800).unwrap();
        // loopback socks inbound on the requested port
        let inb = &cfg["inbounds"][0];
        assert_eq!(inb["protocol"], "socks");
        assert_eq!(inb["listen"], "127.0.0.1");
        assert_eq!(inb["port"], 10800);
        // outbound server + defaulted cipher
        let srv = &cfg["outbounds"][0]["settings"]["servers"][0];
        assert_eq!(cfg["outbounds"][0]["protocol"], "shadowsocks");
        assert_eq!(srv["method"], "aes-256-gcm");
        assert_eq!(srv["password"], "hunter2");
        assert_eq!(srv["address"], "node.example.com");
        // plain tcp/no-tls → no streamSettings
        assert!(cfg["outbounds"][0].get("streamSettings").is_none());
    }

    #[test]
    fn vless_reality_flow_stream_settings() {
        let mut up = base(UpstreamKind::Vless);
        up.uuid = "11111111-2222-3333-4444-555555555555".into();
        up.params.flow = "xtls-rprx-vision".into();
        up.params.tls = "reality".into();
        up.params.reality_public_key = "PUB".into();
        up.params.reality_short_id = "ab".into();
        up.params.fingerprint = "chrome".into();
        let cfg = up.to_xray_config(20000).unwrap();
        let user = &cfg["outbounds"][0]["settings"]["vnext"][0]["users"][0];
        assert_eq!(user["id"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(user["flow"], "xtls-rprx-vision");
        assert_eq!(user["encryption"], "none");
        let stream = &cfg["outbounds"][0]["streamSettings"];
        assert_eq!(stream["security"], "reality");
        assert_eq!(stream["realitySettings"]["publicKey"], "PUB");
        assert_eq!(stream["realitySettings"]["shortId"], "ab");
        assert_eq!(stream["realitySettings"]["serverName"], "node.example.com");
    }

    #[test]
    fn vmess_ws_tls_transport() {
        let mut up = base(UpstreamKind::Vmess);
        up.uuid = "abc".into();
        up.params.network = "ws".into();
        up.params.path = "/ray".into();
        up.params.ws_host = "cdn.example.com".into();
        up.params.tls = "tls".into();
        up.params.sni = "cdn.example.com".into();
        let cfg = up.to_xray_config(30000).unwrap();
        assert_eq!(cfg["outbounds"][0]["protocol"], "vmess");
        let stream = &cfg["outbounds"][0]["streamSettings"];
        assert_eq!(stream["network"], "ws");
        assert_eq!(stream["wsSettings"]["path"], "/ray");
        assert_eq!(stream["wsSettings"]["host"], "cdn.example.com");
        assert_eq!(stream["security"], "tls");
        assert_eq!(stream["tlsSettings"]["serverName"], "cdn.example.com");
    }

    #[test]
    fn trojan_requires_password() {
        let up = base(UpstreamKind::Trojan);
        assert!(up.to_xray_config(1).is_err());
    }

    #[test]
    fn wireguard_endpoint_and_keys() {
        let mut up = base(UpstreamKind::Wireguard);
        up.host = "1.2.3.4".into();
        up.port = 51820;
        up.private_key = "PRIV".into();
        up.params.peer_public_key = "PEER".into();
        up.params.local_address = vec!["10.0.0.2/32".into()];
        up.pre_shared_key = "PSK".into();
        let cfg = up.to_xray_config(40000).unwrap();
        let s = &cfg["outbounds"][0]["settings"];
        assert_eq!(cfg["outbounds"][0]["protocol"], "wireguard");
        assert_eq!(s["secretKey"], "PRIV");
        assert_eq!(s["peers"][0]["publicKey"], "PEER");
        assert_eq!(s["peers"][0]["endpoint"], "1.2.3.4:51820");
        assert_eq!(s["peers"][0]["preSharedKey"], "PSK");
        assert_eq!(s["address"][0], "10.0.0.2/32");
        // wireguard has no streamSettings
        assert!(cfg["outbounds"][0].get("streamSettings").is_none());
    }

    #[test]
    fn rejects_non_core_kind() {
        let up = base(UpstreamKind::Socks5);
        assert!(up.to_xray_config(1).is_err());
    }

    #[test]
    fn rejects_empty_host_or_port() {
        let mut up = base(UpstreamKind::Shadowsocks);
        up.secret = "x".into();
        up.host = String::new();
        assert!(up.to_xray_config(1).is_err());
        let mut up2 = base(UpstreamKind::Shadowsocks);
        up2.secret = "x".into();
        up2.port = 0;
        assert!(up2.to_xray_config(1).is_err());
    }
}
