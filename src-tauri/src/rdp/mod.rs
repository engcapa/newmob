//! RDP (Remote Desktop Protocol) client and WebSocket relay.
//!
//! This module mirrors the VNC architecture (`crate::vnc`):
//!
//! - The Tauri command `rdp_connect` opens a transport (direct TCP, HTTP/SOCKS5
//!   proxy via [`crate::terminal::network::establish_transport`], or RD
//!   Gateway), performs the X.224 / RDP Negotiation handshake, and binds a
//!   loopback WebSocket the frontend canvas connects to.
//! - The relay (`ws.rs`) bridges WS frames from the canvas to RDP fast-path
//!   input PDUs and back, multiplexing display, audio, clipboard, and drive
//!   redirection over a single tagged binary frame format.
//! - Virtual channels live in `cliprdr.rs`, `rdpsnd.rs`, and `rdpdr.rs`.
//! - RD Gateway's MS-TSGU transport (RPC-over-HTTPS twin-channel) lives in
//!   `gateway.rs`.
//!
//! The first cut focuses on *correct framing and codecs* — every PDU encoder /
//! decoder in this module ships with round-trip unit tests. Wire-level
//! integration with a real Windows host happens behind the same WS protocol,
//! so the canvas does not need to know which transport carried the bytes.

pub mod cliprdr;
pub mod frame;
pub mod gateway;
pub mod input;
pub mod pdu;
pub mod rdpdr;
pub mod rdpsnd;
pub mod rfx;
pub mod session;
pub mod tls;
pub mod transport;
pub mod ws;

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::rdp::session::{RdpSessionConfig, test_ironrdp_connection};
use crate::rdp::ws::{RdpControl, RdpSpawnConfig, spawn_rdp_relay};
use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use crate::vault::Vault;

/// Configuration parsed out of `SessionConfig.options_json` for an RDP
/// session. Mirrors the TS-side `RdpOptions` in `src/types/rdp.ts`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOptions {
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default = "default_color_depth")]
    pub color_depth: u8,
    #[serde(default = "default_screen_w")]
    pub screen_w: u16,
    #[serde(default = "default_screen_h")]
    pub screen_h: u16,
    #[serde(default)]
    pub nla: bool,
    /// Optional SHA-256 pin for a self-signed/private-CA RDP certificate.
    /// System trust is always attempted first.
    #[serde(default)]
    pub certificate_fingerprint: Option<String>,
    #[serde(default)]
    pub performance: PerformanceFlags,
    #[serde(default = "default_true")]
    pub redirect_clipboard: bool,
    #[serde(default = "default_audio_mode")]
    pub redirect_audio: String, // "play" | "off"
    #[serde(default)]
    pub redirect_drive: DriveRedirectOpt,
    #[serde(default)]
    pub gateway: Option<GatewayOpt>,
}

fn default_color_depth() -> u8 {
    32
}
fn default_screen_w() -> u16 {
    1920
}
fn default_screen_h() -> u16 {
    1080
}
fn default_true() -> bool {
    true
}
fn default_audio_mode() -> String {
    "play".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceFlags {
    #[serde(default)]
    pub wallpaper: bool,
    #[serde(default)]
    pub themes: bool,
    #[serde(default = "default_true")]
    pub font_smooth: bool,
    #[serde(default = "default_true")]
    pub disable_full_window_drag: bool,
    #[serde(default = "default_true")]
    pub disable_menu_animations: bool,
    #[serde(default = "default_true")]
    pub disable_cursor_shadow: bool,
}

impl Default for PerformanceFlags {
    fn default() -> Self {
        Self {
            wallpaper: false,
            themes: false,
            font_smooth: true,
            disable_full_window_drag: true,
            disable_menu_animations: true,
            disable_cursor_shadow: true,
        }
    }
}

impl PerformanceFlags {
    /// Encode to the `performanceFlags` bitmask documented in MS-RDPBCGR
    /// 2.2.1.11.1.1.1 (TS_EXTENDED_INFO_PACKET.performanceFlags).
    pub fn to_bitmask(&self) -> u32 {
        let mut m = 0u32;
        if !self.wallpaper {
            m |= 0x0000_0001;
        } // PERF_DISABLE_WALLPAPER
        if !self.font_smooth {
            m |= 0x0000_0080;
        } // PERF_DISABLE_FONT_SMOOTHING (sense inverted in spec)
        if self.disable_full_window_drag {
            m |= 0x0000_0002;
        }
        if self.disable_menu_animations {
            m |= 0x0000_0004;
        }
        if !self.themes {
            m |= 0x0000_0008;
        } // PERF_DISABLE_THEMING
        if self.disable_cursor_shadow {
            m |= 0x0000_0020;
        }
        m
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveRedirectOpt {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayOpt {
    pub host: String,
    #[serde(default = "default_gateway_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_gateway_auth")]
    pub auth: String, // "basic" | "ntlm"
    #[serde(default = "default_true")]
    pub use_session_creds: bool,
    /// Optional SHA-256 pin for the HTTPS certificate presented by RD Gateway.
    #[serde(default)]
    pub certificate_fingerprint: Option<String>,
}

fn default_gateway_port() -> u16 {
    443
}
fn default_gateway_auth() -> String {
    "ntlm".into()
}

impl RdpOptions {
    pub fn from_json(raw: Option<&str>) -> Self {
        let s = match raw {
            Some(s) if !s.trim().is_empty() => s,
            _ => return Self::default(),
        };
        match serde_json::from_str::<Self>(s) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("invalid RDP options_json: {}", e);
                Self::default()
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RdpConnectResult {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
}

/// Resolve a possibly-vault-referenced secret. Mirrors the helper used by
/// `vnc_connect`. Errors map to `VAULT_LOCKED` strings the UI already handles.
fn resolve_secret(vault: &Vault, value: Option<&str>) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match vault.resolve(v)? {
            Some(plain) => Ok(Some((*plain).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

fn apply_session_credentials_to_gateway(
    options: &mut RdpOptions,
    username: &Option<String>,
    password: &Option<String>,
) {
    if let Some(g) = options.gateway.as_mut() {
        if g.use_session_creds {
            g.username = username.clone().unwrap_or_default();
            g.password = password.clone();
        }
    }
}

fn apply_stored_certificate_pins(
    state: &AppState,
    host: &str,
    port: u16,
    options: &mut RdpOptions,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(pin) = tls::load_pin(&db, host, port).map_err(|e| e.to_string())? {
        options.certificate_fingerprint = Some(pin);
    } else if let Some(pin) = options.certificate_fingerprint.as_deref() {
        options.certificate_fingerprint = Some(tls::normalize_fingerprint(pin)?);
    }
    if let Some(gateway) = options.gateway.as_mut() {
        if let Some(pin) =
            tls::load_pin(&db, &gateway.host, gateway.port).map_err(|e| e.to_string())?
        {
            gateway.certificate_fingerprint = Some(pin);
        } else if let Some(pin) = gateway.certificate_fingerprint.as_deref() {
            gateway.certificate_fingerprint = Some(tls::normalize_fingerprint(pin)?);
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rdp_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<RdpConnectResult, String> {
    let session_id = Uuid::new_v4().to_string();

    let resolved_password = resolve_secret(&state.vault, password.as_deref())?;
    let mut options = RdpOptions::from_json(options_json.as_deref());
    apply_stored_certificate_pins(&state, &host, port, &mut options)?;
    if let Some(g) = options.gateway.as_mut() {
        if let Some(p) = g.password.as_deref() {
            if let Some(plain) = state.vault.resolve(p)? {
                g.password = Some((*plain).clone());
            }
        }
    }
    apply_session_credentials_to_gateway(&mut options, &username, &resolved_password);
    let mut network = NetworkSettings::from_json(network_settings_json.as_deref());
    if let Some(n) = network.as_mut() {
        crate::terminal::resolve_proxy_session(&state, n)?;
        n.resolve_proxy_pass(&state.vault)?;
        crate::terminal::resolve_jump_credentials(&state, n)?;
    }

    let session = spawn_rdp_relay(RdpSpawnConfig {
        host,
        port,
        username,
        password: resolved_password,
        options,
        network,
    })
    .await?;

    let result = RdpConnectResult {
        session_id: session_id.clone(),
        ws_port: session.ws_port,
        ws_token: session.ws_token.clone(),
    };

    // Reap the session-map entry once the relay's cancellation token fires
    // (idle timeout, WS close, server disconnect, or explicit
    // `rdp_disconnect`). Without this the `RdpSession` would linger in the
    // map after its backend worker has already exited.
    let reaper_cancel = session.cancel.clone();
    let reaper_sessions = state.rdp_sessions.clone();
    let reaper_id = session_id.clone();
    tokio::spawn(async move {
        reaper_cancel.cancelled().await;
        reaper_sessions.write().await.remove(&reaper_id);
    });

    let mut sessions = state.rdp_sessions.write().await;
    sessions.insert(session_id, session);
    Ok(result)
}

#[tauri::command]
pub async fn rdp_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.rdp_sessions.write().await;
    if let Some(s) = sessions.remove(&session_id) {
        let _ = s.control_tx.send(RdpControl::Disconnect);
        s.cancel.cancel();
    }
    Ok(())
}

/// Persist an explicitly confirmed SHA-256 certificate fingerprint. Future
/// handshakes for this exact host/port pair accept only that leaf certificate
/// when operating-system trust validation fails.
#[tauri::command]
pub async fn rdp_trust_certificate(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err("RDP certificate trust requires a valid host and port".to_string());
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    tls::save_pin(&db, host, port, &fingerprint)
}

/// Run the real IronRDP connection path without spawning the UI relay. Used
/// by the SessionEditor "Test connection" button.
#[tauri::command]
pub async fn rdp_test_connection(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<String, String> {
    let resolved_password = resolve_secret(&state.vault, password.as_deref())?;
    let mut options = RdpOptions::from_json(options_json.as_deref());
    apply_stored_certificate_pins(&state, &host, port, &mut options)?;
    if let Some(g) = options.gateway.as_mut() {
        if let Some(p) = g.password.as_deref() {
            if let Some(plain) = state.vault.resolve(p)? {
                g.password = Some((*plain).clone());
            }
        }
    }
    apply_session_credentials_to_gateway(&mut options, &username, &resolved_password);
    let mut network = NetworkSettings::from_json(network_settings_json.as_deref());
    if let Some(n) = network.as_mut() {
        crate::terminal::resolve_proxy_session(&state, n)?;
        n.resolve_proxy_pass(&state.vault)?;
        crate::terminal::resolve_jump_credentials(&state, n)?;
    }

    let transport =
        transport::open_transport(&host, port, network.as_ref(), options.gateway.as_ref()).await?;
    let result = test_ironrdp_connection(
        RdpSessionConfig {
            stream: transport.stream,
            local_addr: transport.local_addr,
            host: host.clone(),
            port,
            username,
            password: resolved_password,
            options,
            network,
        },
        std::time::Duration::from_secs(45),
    )
    .await?;

    Ok(format!(
        "RDP connection OK — protocol={}, desktop={}x{}, server={}",
        result.protocol, result.width, result.height, result.server_name,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_reuses_session_credentials_when_requested() {
        let mut options = RdpOptions {
            gateway: Some(GatewayOpt {
                host: "rdg.example.com".into(),
                port: 443,
                username: "gateway-user".into(),
                password: Some("gateway-pass".into()),
                auth: "ntlm".into(),
                use_session_creds: true,
                certificate_fingerprint: None,
            }),
            ..RdpOptions::default()
        };
        apply_session_credentials_to_gateway(
            &mut options,
            &Some("rdp-user".into()),
            &Some("rdp-pass".into()),
        );
        let gateway = options.gateway.unwrap();
        assert_eq!(gateway.username, "rdp-user");
        assert_eq!(gateway.password.as_deref(), Some("rdp-pass"));
    }

    #[test]
    fn gateway_keeps_explicit_credentials_when_not_reusing_session() {
        let mut options = RdpOptions {
            gateway: Some(GatewayOpt {
                host: "rdg.example.com".into(),
                port: 443,
                username: "gateway-user".into(),
                password: Some("gateway-pass".into()),
                auth: "basic".into(),
                use_session_creds: false,
                certificate_fingerprint: None,
            }),
            ..RdpOptions::default()
        };
        apply_session_credentials_to_gateway(
            &mut options,
            &Some("rdp-user".into()),
            &Some("rdp-pass".into()),
        );
        let gateway = options.gateway.unwrap();
        assert_eq!(gateway.username, "gateway-user");
        assert_eq!(gateway.password.as_deref(), Some("gateway-pass"));
    }
}
