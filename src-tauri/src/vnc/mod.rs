pub mod clipboard;
pub mod encodings;
pub mod rfb;
pub mod ws;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use crate::vnc::ws::{VncClientOptions, VncControl, establish_vnc_transport, spawn_vnc_relay};
use tokio_util::sync::CancellationToken;

const VNC_CREDENTIAL_CAPABILITY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_VNC_CREDENTIAL_CAPABILITIES: usize = 128;

struct CredentialCapability {
    credential: Zeroizing<String>,
    last_used: Instant,
}

static VNC_CREDENTIAL_CAPABILITIES: LazyLock<Mutex<HashMap<String, CredentialCapability>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize)]
pub struct VncConnectResult {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
    pub width: u16,
    pub height: u16,
    pub name: String,
}

/// Store a VNC credential in process memory and return an opaque capability.
/// Detached windows persist only this random handle, never the credential.
#[tauri::command]
pub fn vnc_create_credential_capability(
    credential: Option<String>,
) -> Result<Option<String>, String> {
    let Some(credential) = credential else {
        return Ok(None);
    };
    let mut capabilities = VNC_CREDENTIAL_CAPABILITIES
        .lock()
        .map_err(|_| "VNC credential capability store is unavailable".to_string())?;
    let now = Instant::now();
    prune_credential_capabilities(&mut capabilities, now);
    Ok(Some(insert_credential_capability(
        &mut capabilities,
        credential,
        now,
    )))
}

fn insert_credential_capability(
    capabilities: &mut HashMap<String, CredentialCapability>,
    credential: String,
    now: Instant,
) -> String {
    while capabilities.len() >= MAX_VNC_CREDENTIAL_CAPABILITIES {
        let Some(oldest) = capabilities
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(token, _)| token.clone())
        else {
            break;
        };
        capabilities.remove(&oldest);
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    capabilities.insert(
        token.clone(),
        CredentialCapability {
            credential: Zeroizing::new(credential),
            last_used: now,
        },
    );
    token
}

/// Connect to a VNC server. Returns WS port + framebuffer info.
#[tauri::command]
pub async fn vnc_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    credential_capability: Option<String>,
    network_settings_json: Option<String>,
    client_options_json: Option<String>,
) -> Result<VncConnectResult, String> {
    let session_id = Uuid::new_v4().to_string();

    let supplied_password = match credential_capability.as_deref() {
        Some(token) => Some(resolve_credential_capability(token)?),
        None => password,
    };
    let resolved_password = match supplied_password.as_deref() {
        Some(p) => state
            .vault
            .resolve(p)?
            .map(|z| (*z).clone())
            .or(Some(p.to_string())),
        None => None,
    };

    let network = resolve_network_settings(&state, network_settings_json.as_deref())?;
    let options = parse_client_options(client_options_json.as_deref())?;
    let session =
        spawn_vnc_relay(host, port, username, resolved_password, network, options).await?;

    let result = VncConnectResult {
        session_id: session_id.clone(),
        ws_port: session.ws_port,
        ws_token: session.ws_token.clone(),
        width: 0, // updated by connected message from frontend
        height: 0,
        name: String::new(),
    };

    let reaper_cancel = session.cancel.clone();
    let reaper_sessions = state.vnc_sessions.clone();
    let reaper_id = session_id.clone();
    tokio::spawn(async move {
        reaper_cancel.cancelled().await;
        reaper_sessions.write().await.remove(&reaper_id);
    });

    let mut sessions = state.vnc_sessions.write().await;
    sessions.insert(session_id, session);

    Ok(result)
}

fn resolve_credential_capability(token: &str) -> Result<String, String> {
    let mut capabilities = VNC_CREDENTIAL_CAPABILITIES
        .lock()
        .map_err(|_| "VNC credential capability store is unavailable".to_string())?;
    resolve_credential_capability_from(&mut capabilities, token, Instant::now())
}

fn resolve_credential_capability_from(
    capabilities: &mut HashMap<String, CredentialCapability>,
    token: &str,
    now: Instant,
) -> Result<String, String> {
    prune_credential_capabilities(capabilities, now);
    let entry = capabilities
        .get_mut(token)
        .ok_or_else(|| "VNC credential capability is invalid or expired".to_string())?;
    entry.last_used = now;
    Ok(entry.credential.to_string())
}

fn prune_credential_capabilities(
    capabilities: &mut HashMap<String, CredentialCapability>,
    now: Instant,
) {
    capabilities.retain(|_, entry| {
        now.saturating_duration_since(entry.last_used) <= VNC_CREDENTIAL_CAPABILITY_TTL
    });
}

/// Disconnect a VNC session.
#[tauri::command]
pub async fn vnc_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.vnc_sessions.write().await;
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.control_tx.send(VncControl::Disconnect).await;
        session.cancel.cancel();
    }
    Ok(())
}

/// Test a VNC connection (handshake + auth only, no WS relay).
#[tauri::command]
pub async fn vnc_test_connection(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    network_settings_json: Option<String>,
    client_options_json: Option<String>,
) -> Result<String, String> {
    let resolved = match password.as_deref() {
        Some(p) => state
            .vault
            .resolve(p)?
            .map(|z| (*z).clone())
            .or(Some(p.to_string())),
        None => None,
    };
    let network = resolve_network_settings(&state, network_settings_json.as_deref())?;
    let options = parse_client_options(client_options_json.as_deref())?;
    let cancel = CancellationToken::new();
    let (transport, bridge) =
        establish_vnc_transport(&host, port, network.as_ref(), &cancel).await?;
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut rfb = crate::vnc::rfb::RfbConnection::from_stream(transport)?;
        rfb.authenticate(
            username.as_deref(),
            resolved.as_deref(),
            crate::vnc::rfb::RfbHandshakeOptions {
                security_policy: options.security_policy,
                shared: options.shared,
            },
        )?;
        Ok(format!(
            "Connection successful: {}x{} - {} ({})",
            rfb.width,
            rfb.height,
            rfb.name,
            rfb.security_type_label()
        ))
    })
    .await
    .map_err(|e| format!("VNC test worker failed: {}", e))?;
    if let Some(handle) = bridge {
        handle.abort();
    }
    result
}

fn parse_client_options(raw: Option<&str>) -> Result<VncClientOptions, String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<VncClientOptions>(value)
            .map(VncClientOptions::normalized)
            .map_err(|error| format!("invalid VNC client options: {error}")),
        None => Ok(VncClientOptions::default()),
    }
}

fn resolve_network_settings(
    state: &State<'_, AppState>,
    raw: Option<&str>,
) -> Result<Option<NetworkSettings>, String> {
    let mut network = NetworkSettings::from_json(raw);
    if let Some(settings) = network.as_mut() {
        crate::terminal::resolve_proxy_session(state, settings)?;
        settings.resolve_proxy_pass(&state.vault)?;
        crate::terminal::resolve_jump_credentials(state, settings)?;
    }
    Ok(network)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_options_default_to_authenticated_legacy_compatibility() {
        let defaults = parse_client_options(None).unwrap();
        assert_eq!(
            defaults.security_policy,
            crate::vnc::rfb::VncSecurityPolicy::LegacyCompatible
        );
        assert!(defaults.shared);
        assert!(!defaults.view_only);

        let normalized = parse_client_options(Some(
            r#"{"securityPolicy":"allow-none","shared":false,"viewOnly":true,"maxClipboardBytes":999999999}"#,
        ))
        .unwrap();
        assert_eq!(
            normalized.security_policy,
            crate::vnc::rfb::VncSecurityPolicy::AllowNone
        );
        assert!(!normalized.shared);
        assert!(normalized.view_only);
        assert_eq!(
            normalized.max_clipboard_bytes,
            crate::vnc::rfb::MAX_CLIPBOARD_BYTES
        );
    }

    #[test]
    fn credential_capability_is_reusable_and_sliding_ttl_is_bounded() {
        let mut capabilities = HashMap::new();
        let start = Instant::now();
        let token = insert_credential_capability(&mut capabilities, "secret".to_string(), start);
        assert_eq!(token.len(), 64);
        assert_eq!(
            resolve_credential_capability_from(
                &mut capabilities,
                &token,
                start + VNC_CREDENTIAL_CAPABILITY_TTL - Duration::from_secs(1),
            )
            .unwrap(),
            "secret"
        );
        assert_eq!(
            resolve_credential_capability_from(
                &mut capabilities,
                &token,
                start + VNC_CREDENTIAL_CAPABILITY_TTL * 2 - Duration::from_secs(2),
            )
            .unwrap(),
            "secret"
        );
        assert!(
            resolve_credential_capability_from(
                &mut capabilities,
                &token,
                start + VNC_CREDENTIAL_CAPABILITY_TTL * 3,
            )
            .is_err()
        );
    }

    #[test]
    fn credential_capability_store_evicts_oldest_entry_at_capacity() {
        let mut capabilities = HashMap::new();
        let start = Instant::now();
        let oldest = insert_credential_capability(&mut capabilities, "oldest".to_string(), start);
        for index in 1..MAX_VNC_CREDENTIAL_CAPABILITIES {
            insert_credential_capability(
                &mut capabilities,
                format!("secret-{index}"),
                start + Duration::from_millis(index as u64),
            );
        }
        insert_credential_capability(
            &mut capabilities,
            "newest".to_string(),
            start + Duration::from_secs(1),
        );

        assert_eq!(capabilities.len(), MAX_VNC_CREDENTIAL_CAPABILITIES);
        assert!(!capabilities.contains_key(&oldest));
    }
}
