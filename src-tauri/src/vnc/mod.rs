pub mod clipboard;
pub mod encodings;
pub mod error;
pub mod limits;
pub mod policy;
pub mod queue;
pub mod rfb;
pub mod ws;

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;
use crate::vnc::policy::VncClipboardPolicy;
use crate::vnc::ws::{VncControl, dial_vnc_transport, spawn_vnc_relay};

const MAX_DETACH_CLAIMS: usize = 64;
const MAX_DETACH_FIELD_BYTES: usize = 64 * 1024;
const DETACH_CLAIM_TTL: std::time::Duration = std::time::Duration::from_secs(60);

type VncDetachClaims =
    std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<String, VncDetachClaim>>>;

fn structured_error(error: String) -> String {
    crate::vnc::error::VncError::classify(error).json()
}

fn parse_network_settings(
    raw: Option<&str>,
) -> Result<Option<crate::terminal::network::NetworkSettings>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    serde_json::from_str(raw)
        .map(Some)
        .map_err(|error| format!("invalid VNC network settings: {error}"))
}

fn validate_connect_inputs(
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
    network_settings_json: Option<&str>,
) -> Result<(), String> {
    if host.trim().is_empty() || port == 0 {
        return Err("VNC host and port are required".into());
    }
    if host.len() > 1024 {
        return Err("VNC host exceeds the configured size limit".into());
    }
    if [username, password, network_settings_json]
        .into_iter()
        .flatten()
        .any(|value| value.len() > MAX_DETACH_FIELD_BYTES)
    {
        return Err("VNC connection input exceeds the configured size limit".into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct VncConnectResult {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
    pub width: u16,
    pub height: u16,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncDetachClaim {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub network_settings_json: Option<String>,
    pub security_policy: crate::vnc::policy::VncSecurityPolicy,
    pub view_only: bool,
    pub clipboard_policy: VncClipboardPolicy,
}

#[derive(Debug, Serialize)]
pub struct VncDetachClaimResult {
    pub claim_id: String,
}

async fn store_detach_claim(
    claims: &VncDetachClaims,
    claim: VncDetachClaim,
    ttl: std::time::Duration,
    max_claims: usize,
) -> Result<String, String> {
    validate_connect_inputs(
        &claim.host,
        claim.port,
        claim.username.as_deref(),
        claim.password.as_deref(),
        claim.network_settings_json.as_deref(),
    )?;

    let claim_id = Uuid::new_v4().to_string();
    {
        let mut pending = claims.write().await;
        if pending.len() >= max_claims {
            return Err("too many pending VNC detach claims".into());
        }
        pending.insert(claim_id.clone(), claim);
    }

    let expiry_claims = claims.clone();
    let expiry_id = claim_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(ttl).await;
        expiry_claims.write().await.remove(&expiry_id);
    });
    Ok(claim_id)
}

async fn consume_detach_claim(
    claims: &VncDetachClaims,
    claim_id: &str,
) -> Result<VncDetachClaim, String> {
    claims
        .write()
        .await
        .remove(claim_id)
        .ok_or_else(|| "VNC detach claim is missing or expired".to_string())
}

/// Connect to a VNC server. Returns WS port + framebuffer info.
#[tauri::command]
pub async fn vnc_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    network_settings_json: Option<String>,
    security_policy: Option<crate::vnc::policy::VncSecurityPolicy>,
    view_only: Option<bool>,
    clipboard_policy: Option<VncClipboardPolicy>,
) -> Result<VncConnectResult, String> {
    validate_connect_inputs(
        &host,
        port,
        username.as_deref(),
        password.as_deref(),
        network_settings_json.as_deref(),
    )
    .map_err(structured_error)?;
    let session_id = Uuid::new_v4().to_string();

    let resolved_password = match password.as_deref() {
        Some(p) => state
            .vault
            .resolve(p)
            .map_err(structured_error)?
            .map(|z| (*z).clone())
            .or(Some(p.to_string())),
        None => None,
    };

    let mut network =
        parse_network_settings(network_settings_json.as_deref()).map_err(structured_error)?;
    if let Some(n) = network.as_mut() {
        crate::terminal::resolve_proxy_session(&state, n).map_err(structured_error)?;
        n.resolve_proxy_pass(&state.vault)
            .map_err(structured_error)?;
        n.resolve_jump_secret(&state.vault)
            .map_err(structured_error)?;
        crate::terminal::resolve_jump_credentials(&state, n).map_err(structured_error)?;
    }
    let policy = security_policy.unwrap_or_default();
    let session = spawn_vnc_relay(
        host,
        port,
        username,
        resolved_password,
        network,
        policy,
        view_only.unwrap_or(false),
        clipboard_policy.unwrap_or_default(),
    )
    .await
    .map_err(structured_error)?;

    let result = VncConnectResult {
        session_id: session_id.clone(),
        ws_port: session.ws_port,
        ws_token: session.ws_token.clone(),
        width: 0, // updated by connected message from frontend
        height: 0,
        name: String::new(),
    };

    let reaper_cancel = session.cancel.clone();
    state
        .vnc_sessions
        .write()
        .await
        .insert(session_id.clone(), session);
    let reaper_sessions = state.vnc_sessions.clone();
    let reaper_id = session_id.clone();
    tokio::spawn(async move {
        reaper_cancel.cancelled().await;
        reaper_sessions.write().await.remove(&reaper_id);
    });

    Ok(result)
}

/// Store a one-time, in-memory detach claim. Sensitive fields never cross
/// localStorage/sessionStorage; the detached WebView receives only `claim_id`.
#[tauri::command]
pub async fn vnc_create_detach_claim(
    state: State<'_, AppState>,
    claim: VncDetachClaim,
) -> Result<VncDetachClaimResult, String> {
    let claim_id = store_detach_claim(
        &state.vnc_detach_claims,
        claim,
        DETACH_CLAIM_TTL,
        MAX_DETACH_CLAIMS,
    )
    .await?;
    Ok(VncDetachClaimResult { claim_id })
}

#[tauri::command]
pub async fn vnc_consume_detach_claim(
    state: State<'_, AppState>,
    claim_id: String,
) -> Result<VncDetachClaim, String> {
    consume_detach_claim(&state.vnc_detach_claims, &claim_id).await
}

/// Disconnect a VNC session.
#[tauri::command]
pub async fn vnc_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state.vnc_sessions.write().await.remove(&session_id);
    if let Some(session) = session {
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
    security_policy: Option<crate::vnc::policy::VncSecurityPolicy>,
) -> Result<String, String> {
    let result = async {
        validate_connect_inputs(
            &host,
            port,
            username.as_deref(),
            password.as_deref(),
            network_settings_json.as_deref(),
        )?;
        let resolved = match password.as_deref() {
            Some(p) => state
                .vault
                .resolve(p)?
                .map(|z| (*z).clone())
                .or(Some(p.to_string())),
            None => None,
        };
        let mut network = parse_network_settings(network_settings_json.as_deref())?;
        if let Some(settings) = network.as_mut() {
            crate::terminal::resolve_proxy_session(&state, settings)?;
            settings.resolve_proxy_pass(&state.vault)?;
            settings.resolve_jump_secret(&state.vault)?;
            crate::terminal::resolve_jump_credentials(&state, settings)?;
        }
        let policy = security_policy.unwrap_or_default();
        let transport = dial_vnc_transport(host, port, network).await?;
        let forward_task = transport.network_forward_task;
        let handshake = tokio::task::spawn_blocking(move || {
            let mut rfb = crate::vnc::rfb::RfbConnection::from_stream(
                transport.stream,
                std::time::Duration::from_secs(15),
                policy,
                crate::vnc::limits::DecodeLimits::default(),
            )?;
            let init =
                rfb.authenticate_with_policy(username.as_deref(), resolved.as_deref(), policy)?;
            Ok::<_, String>(format!(
                "Connection successful: {}x{} - {}",
                init.width, init.height, init.name
            ))
        })
        .await;
        if let Some(task) = forward_task {
            task.abort();
        }
        handshake.map_err(|e| format!("VNC handshake worker failed: {e}"))?
    }
    .await;
    result.map_err(|error| crate::vnc::error::VncError::classify(error).json())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detach_claim() -> VncDetachClaim {
        VncDetachClaim {
            host: "vnc.internal".into(),
            port: 5900,
            username: Some("alice".into()),
            password: Some("secret".into()),
            network_settings_json: None,
            security_policy: crate::vnc::policy::VncSecurityPolicy::PreferEncryption,
            view_only: false,
            clipboard_policy: VncClipboardPolicy::Bidirectional,
        }
    }

    #[test]
    fn malformed_network_settings_are_rejected() {
        assert!(parse_network_settings(Some("{")).is_err());
        assert!(parse_network_settings(Some("  ")).unwrap().is_none());
    }

    #[test]
    fn invalid_connection_inputs_are_rejected_without_echoing_secrets() {
        let error = validate_connect_inputs("", 5900, None, Some("secret"), None).unwrap_err();
        assert!(!error.contains("secret"));
        assert!(validate_connect_inputs("host", 0, None, None, None).is_err());
    }

    #[tokio::test]
    async fn detach_claim_is_consumed_once_and_capacity_is_bounded() {
        let claims = VncDetachClaims::default();
        let claim_id = store_detach_claim(
            &claims,
            detach_claim(),
            std::time::Duration::from_secs(60),
            1,
        )
        .await
        .unwrap();
        assert!(
            store_detach_claim(
                &claims,
                detach_claim(),
                std::time::Duration::from_secs(60),
                1,
            )
            .await
            .is_err()
        );

        let consumed = consume_detach_claim(&claims, &claim_id).await.unwrap();
        assert_eq!(consumed.password.as_deref(), Some("secret"));
        assert!(consume_detach_claim(&claims, &claim_id).await.is_err());
    }

    #[tokio::test]
    async fn detach_claim_expires_after_ttl() {
        let claims = VncDetachClaims::default();
        let ttl = std::time::Duration::from_millis(20);
        let claim_id = store_detach_claim(&claims, detach_claim(), ttl, 1)
            .await
            .unwrap();

        tokio::time::sleep(ttl + std::time::Duration::from_millis(30)).await;
        tokio::task::yield_now().await;
        assert!(consume_detach_claim(&claims, &claim_id).await.is_err());
    }
}
