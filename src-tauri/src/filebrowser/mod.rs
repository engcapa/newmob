//! SFTP-backed dual-pane file browser commands.
//!
//! The Rust side implements three groups of commands:
//!   * remote (`sftp_*`) — backed by `russh-sftp` against an authenticated SSH
//!     connection that is independent of the terminal channel;
//!   * local (`sftp_local_*`, `sftp_list_local`, …) — backed by `std::fs`;
//!   * transfers (`sftp_upload`/`download`/`cancel_transfer`) — long-running
//!     copies that emit progress + completion events on the Tauri event bus.
//!
//! Transfer events follow the convention used by the JS layer:
//!   `sftp-progress-{transferId}` and `sftp-transfer-complete-{transferId}`.

pub mod local;
pub mod sftp;
pub mod transfer;

use crate::state::AppState;
use crate::terminal::ssh::SshAuth;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum FileSide {
    Local,
    Remote,
}

#[derive(Debug, Serialize, Clone)]
pub struct AttachResultPayload {
    #[serde(rename = "homeDir")]
    pub home_dir: String,
}

fn auth_from(method: &str, data: Option<String>) -> SshAuth {
    match method {
        "Password" => SshAuth::Password(data.unwrap_or_default()),
        "PrivateKey" => SshAuth::PrivateKey(
            data.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string()),
        ),
        "Agent" => SshAuth::Agent,
        _ => SshAuth::Password(data.unwrap_or_default()),
    }
}

#[tauri::command]
pub async fn sftp_attach(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<AttachResultPayload, String> {
    let auth = auth_from(&auth_method, auth_data);
    let session = sftp::open_sftp(&host, port, &username, auth).await?;
    let home = session.home.clone();

    {
        let mut sessions = state.sftp_sessions.write().await;
        sessions.insert(session_id.clone(), Arc::new(session));
    }

    let payload = AttachResultPayload { home_dir: home };
    let _ = app_handle.emit(&format!("sftp-attached-{}", session_id), payload.clone());
    Ok(payload)
}

#[tauri::command]
pub async fn sftp_detach(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sftp_sessions.write().await;
    sessions.remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn sftp_list_remote(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<sftp::FileEntryDto>, String> {
    let session = get_session(&state, &session_id).await?;
    session.list_dir(&path).await
}

#[tauri::command]
pub fn sftp_list_local(path: String) -> Result<Vec<sftp::FileEntryDto>, String> {
    local::list_dir(Path::new(&path))
}

#[tauri::command]
pub fn sftp_local_home() -> Result<String, String> {
    local::home_dir()
}

#[tauri::command]
pub fn sftp_local_drives() -> Result<Vec<local::DriveDto>, String> {
    Ok(local::list_drives())
}

#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    side: FileSide,
    state: State<'_, AppState>,
) -> Result<(), String> {
    match side {
        FileSide::Local => local::mkdir(Path::new(&path)),
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.mkdir(&path).await
        }
    }
}

#[tauri::command]
pub async fn sftp_remove(
    session_id: String,
    path: String,
    side: FileSide,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    match side {
        FileSide::Local => local::remove(Path::new(&path), recursive),
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.remove(&path, recursive).await
        }
    }
}

#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    side: FileSide,
    state: State<'_, AppState>,
) -> Result<(), String> {
    match side {
        FileSide::Local => local::rename(Path::new(&old_path), Path::new(&new_path)),
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.rename(&old_path, &new_path).await
        }
    }
}

#[tauri::command]
pub async fn sftp_stat(
    session_id: String,
    path: String,
    side: FileSide,
    state: State<'_, AppState>,
) -> Result<sftp::FileEntryDto, String> {
    match side {
        FileSide::Local => local::stat(Path::new(&path)),
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.stat(&path).await
        }
    }
}

#[tauri::command]
pub async fn sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
    side: FileSide,
    state: State<'_, AppState>,
) -> Result<(), String> {
    match side {
        FileSide::Local => local::chmod(Path::new(&path), mode),
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.chmod(&path, mode).await
        }
    }
}

#[tauri::command]
pub async fn sftp_realpath(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    session.realpath(&path).await
}

#[tauri::command]
pub fn sftp_open_path(path: String) -> Result<(), String> {
    local::open_path(Path::new(&path))
}

#[tauri::command]
pub async fn sftp_read_file_text(
    session_id: String,
    path: String,
    side: FileSide,
    max_bytes: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let bytes = match side {
        FileSide::Local => local::read_bytes(Path::new(&path), max_bytes)?,
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.read_bytes(&path, max_bytes).await?
        }
    };
    String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {}", e))
}

#[tauri::command]
pub async fn sftp_write_file_text(
    session_id: String,
    path: String,
    side: FileSide,
    contents: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bytes = contents.into_bytes();
    match side {
        FileSide::Local => local::write_bytes(Path::new(&path), &bytes),
        FileSide::Remote => {
            let session = get_session(&state, &session_id).await?;
            session.write_bytes(&path, &bytes).await
        }
    }
}

#[tauri::command]
pub async fn sftp_upload_bytes(
    session_id: String,
    transfer_id: String,
    local_name: String,
    remote_path: String,
    bytes_b64: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let bytes = B64
        .decode(bytes_b64.as_bytes())
        .map_err(|e| format!("Invalid base64 payload: {}", e))?;
    let session = get_session(&state, &session_id).await?;
    // Frontend already passes the full destination path; only fall back to
    // joining when the caller explicitly provided a directory path with no
    // trailing filename component.
    let dest = if remote_path.ends_with('/') || remote_path.is_empty() {
        sftp::join_remote(&remote_path, &local_name)
    } else {
        remote_path.clone()
    };
    session.write_bytes(&dest, &bytes).await?;
    let _ = app_handle.emit(
        &format!("sftp-transfer-complete-{}", transfer_id),
        transfer::CompletePayload::ok(Some(dest)),
    );
    Ok(())
}

#[tauri::command]
pub async fn sftp_download_bytes(
    session_id: String,
    _transfer_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    // 32 MiB hard cap to match the JS-side proxy.
    let bytes = session.read_bytes(&remote_path, 32 * 1024 * 1024).await?;
    Ok(B64.encode(&bytes))
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    open_after: bool,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let handle = transfer::register(&state, &transfer_id).await;
    let local = PathBuf::from(&local_path);
    // Frontend (sftpController.upload) passes the full remote destination
    // already (`joinPath(remoteDir, entry.name)`). Only fall back to joining
    // basename when remote_path looks like a directory.
    let dest = if remote_path.ends_with('/') || remote_path.is_empty() {
        sftp::join_remote(&remote_path, file_name(&local))
    } else {
        remote_path.clone()
    };
    let app = app_handle.clone();
    let result = session
        .upload_file(&local, &dest, transfer_id.clone(), handle.clone(), app.clone())
        .await;
    transfer::unregister(&state, &transfer_id).await;
    let payload = match &result {
        Ok(_) => transfer::CompletePayload::ok(Some(dest)),
        Err(e) => transfer::CompletePayload::err(e),
    };
    let _ = app.emit(&format!("sftp-transfer-complete-{}", transfer_id), payload);
    let _ = open_after;
    result
}

#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    open_after: bool,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let handle = transfer::register(&state, &transfer_id).await;
    // Frontend (sftpController.download) passes the full local destination
    // already (`joinPath(localDir, entry.name)`). Treat trailing-separator or
    // empty paths as directory hints and append the remote basename.
    let dest = {
        let raw = PathBuf::from(&local_path);
        let needs_basename = local_path.is_empty()
            || local_path.ends_with('/')
            || local_path.ends_with('\\')
            || raw.is_dir();
        if needs_basename {
            raw.join(remote_basename(&remote_path))
        } else {
            raw
        }
    };
    let app = app_handle.clone();
    let result = session
        .download_file(&remote_path, &dest, transfer_id.clone(), handle.clone(), app.clone())
        .await;
    transfer::unregister(&state, &transfer_id).await;
    let final_path = dest.to_string_lossy().to_string();
    let payload = match &result {
        Ok(_) => {
            if open_after {
                let _ = local::open_path(&dest);
            }
            transfer::CompletePayload::ok(Some(final_path.clone()))
        }
        Err(e) => transfer::CompletePayload::err(e),
    };
    let _ = app.emit(&format!("sftp-transfer-complete-{}", transfer_id), payload);
    result
}

#[tauri::command]
pub async fn sftp_upload_dir(
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let handle = transfer::register(&state, &transfer_id).await;
    let local = PathBuf::from(&local_path);
    // Frontend (sftpController.upload) passes the full destination path; if
    // the caller provides a trailing-separator hint, append the local dir
    // basename so the source folder is materialised inside `remote_path`.
    let dest = if remote_path.ends_with('/') || remote_path.is_empty() {
        sftp::join_remote(&remote_path, file_name(&local))
    } else {
        remote_path.clone()
    };
    let app = app_handle.clone();
    let result = session
        .upload_dir(&local, &dest, transfer_id.clone(), handle.clone(), app.clone())
        .await;
    transfer::unregister(&state, &transfer_id).await;
    let payload = match &result {
        Ok(_) => transfer::CompletePayload::ok(Some(dest)),
        Err(e) => transfer::CompletePayload::err(e),
    };
    let _ = app.emit(&format!("sftp-transfer-complete-{}", transfer_id), payload);
    result
}

#[tauri::command]
pub async fn sftp_download_dir(
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let handle = transfer::register(&state, &transfer_id).await;
    let dest = {
        let raw = PathBuf::from(&local_path);
        let needs_basename = local_path.is_empty()
            || local_path.ends_with('/')
            || local_path.ends_with('\\')
            || raw.is_dir();
        if needs_basename {
            raw.join(remote_basename(&remote_path))
        } else {
            raw
        }
    };
    let app = app_handle.clone();
    let result = session
        .download_dir(&remote_path, &dest, transfer_id.clone(), handle.clone(), app.clone())
        .await;
    transfer::unregister(&state, &transfer_id).await;
    let final_path = dest.to_string_lossy().to_string();
    let payload = match &result {
        Ok(_) => transfer::CompletePayload::ok(Some(final_path)),
        Err(e) => transfer::CompletePayload::err(e),
    };
    let _ = app.emit(&format!("sftp-transfer-complete-{}", transfer_id), payload);
    result
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    transfer_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    transfer::cancel(&state, &transfer_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sftp_pause_transfer(
    transfer_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    transfer::pause(&state, &transfer_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sftp_resume_transfer(
    transfer_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    transfer::resume(&state, &transfer_id).await;
    Ok(())
}

/// Open a new native window pointing at `index.html?sftp=<session_id>`. The
/// caller is expected to seed the handoff payload via localStorage *before*
/// invoking; the detached window picks it up via
/// `readDetachedHandoff(sessionId)` in `SftpDetachedWindow`.
#[tauri::command]
pub async fn open_sftp_window(
    app_handle: AppHandle,
    session_id: String,
    title: Option<String>,
) -> Result<(), String> {
    let label = format!("sftp-{}", session_id.replace(|c: char| !c.is_alphanumeric(), "-"));
    if app_handle.get_webview_window(&label).is_some() {
        // Reuse / focus the existing window if it is still alive.
        if let Some(w) = app_handle.get_webview_window(&label) {
            let _ = w.set_focus();
        }
        return Ok(());
    }
    // Use WebviewUrl::App so Tauri resolves the correct base URL in both
    // dev mode (http://localhost:1420) and production (tauri:// scheme).
    // We pass the session id via the URL fragment (#sftp=...) because
    // WebviewUrl::App wraps a PathBuf and Tauri does NOT percent-encode
    // the fragment, whereas it does encode '?' in the path component.
    // The frontend reads window.location.hash to detect this route.
    let path_str = format!("index.html#sftp={}", session_id);
    log::info!("Opening SFTP window with path: {}", path_str);
    let url = WebviewUrl::App(std::path::PathBuf::from(path_str));
    let title = title.unwrap_or_else(|| format!("SFTP — {}", session_id));
    WebviewWindowBuilder::new(&app_handle, &label, url)
        .title(&title)
        .inner_size(1200.0, 760.0)
        .min_inner_size(720.0, 420.0)
        .resizable(true)
        // Disable Tauri's native drag-drop interception so the webview's
        // own HTML5 dragstart/dragover/drop events fire normally. Without
        // this, REMOTE↔LOCAL drag inside the SFTP browser silently
        // no-ops on Windows (WebView2) because Tauri swallows the events
        // before React sees them. Mirrors the same flag in tauri.conf.json
        // for the main window.
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| format!("failed to open SFTP window: {}", e))?;
    Ok(())
}

async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<sftp::ActiveSftp>, String> {
    let sessions = state.sftp_sessions.read().await;
    sessions
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("SFTP session {} not attached", session_id))
}

fn file_name(path: &Path) -> &str {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("file")
}

fn remote_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) => name.to_string(),
        None => trimmed.to_string(),
    }
}
