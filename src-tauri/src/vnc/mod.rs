pub mod clipboard;
pub mod encodings;
pub mod rfb;
pub mod ws;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;
use crate::vnc::ws::{spawn_vnc_relay, VncControl};

#[derive(Debug, Serialize)]
pub struct VncConnectResult {
    pub session_id: String,
    pub ws_port: u16,
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
) -> Result<VncConnectResult, String> {
    let session_id = Uuid::new_v4().to_string();

    let session = spawn_vnc_relay(host, port, username, password).await?;

    let result = VncConnectResult {
        session_id: session_id.clone(),
        ws_port: session.ws_port,
        width: 0, // updated by connected message from frontend
        height: 0,
        name: String::new(),
    };

    let mut sessions = state.vnc_sessions.write().await;
    sessions.insert(session_id, session);

    Ok(result)
}

/// Disconnect a VNC session.
#[tauri::command]
pub async fn vnc_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.vnc_sessions.write().await;
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.control_tx.send(VncControl::Disconnect);
        session.cancel.cancel();
    }
    Ok(())
}

/// Test a VNC connection (handshake + auth only, no WS relay).
#[tauri::command]
pub async fn vnc_test_connection(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    let mut rfb = crate::vnc::rfb::RfbConnection::connect(&host, port)?;
    rfb.authenticate(username.as_deref(), password.as_deref())?;
    Ok(format!(
        "Connection successful: {}x{} - {}",
        rfb.width, rfb.height, rfb.name
    ))
}
