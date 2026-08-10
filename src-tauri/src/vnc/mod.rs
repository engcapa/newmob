pub mod clipboard;
pub mod encodings;
pub mod error;
pub mod limits;
pub mod options;
pub mod rfb;
pub mod transport;
pub mod ws;

use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use crate::vnc::error::{VncError, VncStage};
use crate::vnc::limits::DecodeLimits;
use crate::vnc::options::VncOptions;
use crate::vnc::ws::{VncControl, VncDiagnostics, VncSpawnConfig, spawn_vnc_relay};

#[derive(Debug, Serialize)]
pub struct VncConnectResult {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
    pub width: u16,
    pub height: u16,
    pub name: String,
}

/// Connect to a VNC server. Returns WS port + framebuffer info.
#[tauri::command]
pub async fn vnc_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<VncConnectResult, VncError> {
    let session_id = Uuid::new_v4().to_string();

    let resolved_password = resolve_secret(&state, password.as_deref())?;
    let options = VncOptions::from_json(options_json.as_deref()).map_err(|error| {
        VncError::new("VNC_INVALID_OPTIONS", VncStage::Initializing, false, error)
    })?;
    let mut network = NetworkSettings::from_json(network_settings_json.as_deref());
    resolve_network_settings(&state, &mut network)?;

    let session = spawn_vnc_relay(VncSpawnConfig {
        host,
        port,
        username,
        password: resolved_password,
        options,
        network,
    })
    .await?;

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
    tokio::spawn(async move {
        reaper_cancel.cancelled().await;
        reaper_sessions.write().await.remove(&session_id);
    });

    Ok(result)
}

/// Disconnect a VNC session.
#[tauri::command]
pub async fn vnc_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.vnc_sessions.write().await;
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.control_tx.try_send(VncControl::Disconnect);
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
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<String, VncError> {
    let resolved_password = resolve_secret(&state, password.as_deref())?;
    let options = VncOptions::from_json(options_json.as_deref()).map_err(|error| {
        VncError::new("VNC_INVALID_OPTIONS", VncStage::Initializing, false, error)
    })?;
    let mut network = NetworkSettings::from_json(network_settings_json.as_deref());
    resolve_network_settings(&state, &mut network)?;

    let cancel = CancellationToken::new();
    let transport = transport::open_transport(&host, port, network.as_ref(), &cancel)
        .await
        .map_err(VncError::from_transport)?;
    let transport::VncTransport {
        stream,
        mut bridge_task,
    } = transport;
    let handshake = tokio::task::spawn_blocking(move || {
        let mut rfb = rfb::RfbConnection::from_vencrypt_bridge(stream, DecodeLimits::default())?;
        let server = rfb.authenticate_with_options(
            username.as_deref(),
            resolved_password.as_deref(),
            &options,
        )?;
        Ok::<_, String>((server, rfb.security_info()))
    });
    let result = tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(30), handshake) => result,
        error = transport::wait_for_bridge_end(&mut bridge_task) => {
            cancel.cancel();
            bridge_task.take();
            return Err(VncError::from_transport(error));
        }
    };
    cancel.cancel();
    if let Some(task) = bridge_task.take() {
        task.abort();
    }
    let (server, security) = match result {
        Ok(Ok(Ok(value))) => value,
        Ok(Ok(Err(error))) => {
            return Err(VncError::from_protocol(VncStage::Negotiating, error));
        }
        Ok(Err(error)) => {
            return Err(VncError::new(
                "VNC_WORKER_FAILED",
                VncStage::Negotiating,
                false,
                error.to_string(),
            ));
        }
        Err(_) => {
            return Err(VncError::new(
                "VNC_HANDSHAKE_TIMEOUT",
                VncStage::Negotiating,
                true,
                "VNC handshake timed out after 30 seconds",
            ));
        }
    };
    Ok(format!(
        "VNC connection OK - protocol={}, security={}, desktop={}x{}, server={}",
        security.protocol_version, security.security_type, server.width, server.height, server.name
    ))
}

#[tauri::command]
pub async fn vnc_get_diagnostics(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<VncDiagnostics, String> {
    let diagnostics = state
        .vnc_sessions
        .read()
        .await
        .get(&session_id)
        .map(|session| session.diagnostics.clone())
        .ok_or_else(|| "VNC session not found".to_string())?;
    let snapshot = diagnostics.lock().await.clone();
    Ok(snapshot)
}

fn resolve_secret(state: &AppState, value: Option<&str>) -> Result<Option<String>, VncError> {
    match value {
        Some(value) if !value.is_empty() => state
            .vault
            .resolve(value)
            .map(|resolved| {
                resolved
                    .map(|plain| (*plain).clone())
                    .or(Some(value.to_string()))
            })
            .map_err(|error| {
                VncError::new(
                    "VNC_CREDENTIAL_UNAVAILABLE",
                    VncStage::Authenticating,
                    false,
                    error,
                )
            }),
        _ => Ok(None),
    }
}

fn resolve_network_settings(
    state: &State<'_, AppState>,
    network: &mut Option<NetworkSettings>,
) -> Result<(), VncError> {
    let Some(settings) = network.as_mut() else {
        return Ok(());
    };
    crate::terminal::resolve_proxy_session(state, settings)
        .and_then(|_| settings.resolve_proxy_pass(&state.vault))
        .and_then(|_| crate::terminal::resolve_jump_credentials(state, settings))
        .map_err(VncError::from_transport)
}
