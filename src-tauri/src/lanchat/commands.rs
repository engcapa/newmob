//! LanChat Tauri command surface (`lanchat_*`).
//!
//! Single backend entry point for the frontend IPC layer (`src/lib/ipc.ts`).
//! Commands are added per phase; phase 1 ships only a lightweight status probe
//! used by the status bar / web-preview banner.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::lanchat::protocol::PresenceStatus;
use crate::lanchat::store::{decode_avatar_base64, Conversation, Group, LanMessage, Profile, RetentionSettings};
use crate::lanchat::messaging;
use crate::lanchat::protocol::PeerRecord;
use crate::lanchat::store::direct_conv_id;
use crate::lanchat::swarm;
use crate::lanchat::transfer;
use crate::state::AppState;

async fn ensure_ready(state: &State<'_, AppState>) -> Result<(), String> {
    state.lanchat.ensure_unlocked(&state.vault).await
}

/// Snapshot of the LanChat service for the status bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanChatStatus {
    /// Whether the background service task is running.
    pub running: bool,
    /// This node's stable id.
    pub node_id: String,
    /// Number of peers currently discovered on the LAN.
    pub peer_count: usize,
}

/// Report current LanChat service status (running + node id + peer count).
#[tauri::command]
pub async fn lanchat_status(state: State<'_, AppState>) -> Result<LanChatStatus, String> {
    Ok(LanChatStatus {
        running: state
            .lanchat
            .running
            .load(std::sync::atomic::Ordering::SeqCst),
        node_id: state.lanchat.node_id().await,
        peer_count: state.lanchat.peer_count().await,
    })
}

/// Current roster: live peers plus cached offline peers so historical chats can
/// still display the last known name.
#[tauri::command]
pub async fn lanchat_list_peers(state: State<'_, AppState>) -> Result<Vec<PeerRecord>, String> {
    let mut by_id = std::collections::HashMap::new();
    for peer in state.lanchat.store.list_peers().map_err(|e| e.to_string())? {
        by_id.insert(peer.id.clone(), peer);
    }
    for peer in state.lanchat.peers.read().await.values().cloned() {
        by_id.insert(peer.id.clone(), peer);
    }
    let mut roster: Vec<PeerRecord> = by_id.into_values().collect();
    roster.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(roster)
}

/// Read this node's local profile.
#[tauri::command]
pub async fn lanchat_get_profile(state: State<'_, AppState>) -> Result<Profile, String> {
    ensure_ready(&state).await?;
    state
        .lanchat
        .store
        .get_profile()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "lanchat profile not initialized".to_string())
}

/// Arguments for [`lanchat_update_profile`]. `avatarBase64` may be a raw
/// base64 string or a `data:<mime>;base64,...` URL; omit/empty to keep the
/// current avatar unchanged.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileArgs {
    pub name: String,
    #[serde(default)]
    pub avatar_base64: Option<String>,
    #[serde(default)]
    pub signature: String,
    pub status: String,
}

/// Update this node's local profile (display name / avatar / signature /
/// status). Persists to SQLite and returns the updated profile. mDNS TXT
/// re-advertise + `profile-update` broadcast are wired in later phases.
#[tauri::command]
pub async fn lanchat_update_profile(
    state: State<'_, AppState>,
    args: UpdateProfileArgs,
) -> Result<Profile, String> {
    ensure_ready(&state).await?;
    let avatar = match args.avatar_base64.as_deref() {
        Some(s) if !s.trim().is_empty() => Some(decode_avatar_base64(s)?),
        _ => None,
    };
    let status = PresenceStatus::from_txt(&args.status);
    let profile = state
        .lanchat
        .store
        .update_profile(&args.name, avatar, &args.signature, status)
        .map_err(|e| e.to_string())?;
    // Re-announce the mDNS TXT so peers see the new name/avatar/status. The
    // control-channel `profile-update` broadcast is added with messaging.
    if let Err(e) = crate::lanchat::discovery::reregister(&state.lanchat) {
        log::warn!("lanchat: re-register after profile update failed: {e}");
    }
    Ok(profile)
}

/// Arguments for [`lanchat_send_text`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTextArgs {
    pub peer_id: String,
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// Send a one-to-one text message to a peer. Returns the locally persisted
/// message (state transitions to delivered/failed via `lanchat://message`).
#[tauri::command]
pub async fn lanchat_send_text(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SendTextArgs,
) -> Result<LanMessage, String> {
    ensure_ready(&state).await?;
    if args.text.trim().is_empty() {
        return Err("message text is empty".into());
    }
    messaging::send_text(&app, &state.lanchat, &args.peer_id, args.text, args.mentions).await
}

/// Re-send a failed/pending direct message (e.g. after the peer reconnects).
#[tauri::command]
pub async fn lanchat_resend_message(
    app: AppHandle,
    state: State<'_, AppState>,
    msg_id: String,
) -> Result<LanMessage, String> {
    ensure_ready(&state).await?;
    messaging::resend(&app, &state.lanchat, &msg_id).await
}

/// List conversations, most-recently-active first.
#[tauri::command]
pub async fn lanchat_list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
    state.lanchat.store.list_conversations().map_err(|e| e.to_string())
}

/// List recent messages for a conversation (oldest-first, last `limit`).
#[tauri::command]
pub async fn lanchat_list_messages(
    state: State<'_, AppState>,
    conv_id: String,
    limit: Option<i64>,
) -> Result<Vec<LanMessage>, String> {
    ensure_ready(&state).await?;
    state
        .lanchat
        .store
        .list_messages(&conv_id, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// Clear a conversation's unread counter (opened/read).
#[tauri::command]
pub async fn lanchat_mark_read(
    state: State<'_, AppState>,
    conv_id: String,
) -> Result<(), String> {
    state.lanchat.store.reset_unread(&conv_id).map_err(|e| e.to_string())
}

/// Arguments for [`lanchat_create_group`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupArgs {
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
}

/// Create a named group/channel and announce it to the given members.
#[tauri::command]
pub async fn lanchat_create_group(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CreateGroupArgs,
) -> Result<Group, String> {
    ensure_ready(&state).await?;
    if args.name.trim().is_empty() {
        return Err("group name is empty".into());
    }
    messaging::create_group(&app, &state.lanchat, &args.name, args.members).await
}

/// Arguments for [`lanchat_send_group_text`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendGroupTextArgs {
    pub group_id: String,
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// Send a text message to all online members of a group.
#[tauri::command]
pub async fn lanchat_send_group_text(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SendGroupTextArgs,
) -> Result<LanMessage, String> {
    ensure_ready(&state).await?;
    if args.text.trim().is_empty() {
        return Err("message text is empty".into());
    }
    messaging::send_group_text(&app, &state.lanchat, &args.group_id, args.text, args.mentions).await
}

/// List all known groups (with their members).
#[tauri::command]
pub async fn lanchat_list_groups(state: State<'_, AppState>) -> Result<Vec<Group>, String> {
    state.lanchat.store.list_groups().map_err(|e| e.to_string())
}

/// Leave a group locally and notify its members.
#[tauri::command]
pub async fn lanchat_leave_group(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    messaging::leave_group(&app, &state.lanchat, &group_id).await
}

/* ----------------------------- transfers (task 02) ----------------------------- */

/// Offer a file to a single peer (a swarm of one). Returns the content file id
/// (the transfer id); progress arrives on `lanchat://transfer`.
#[tauri::command]
pub async fn lanchat_send_file(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let conv = direct_conv_id(&peer_id);
    swarm::send(
        &app,
        &state.lanchat,
        vec![peer_id.clone()],
        vec![peer_id],
        std::path::PathBuf::from(path),
        conv,
        None,
    )
    .await
}

/// Offer a file to every member of a group (swarm fan-out; members also trade
/// pieces with each other). Returns the content file id.
#[tauri::command]
pub async fn lanchat_send_group_file(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    swarm::send_to_group(&app, &state.lanchat, &group_id, std::path::PathBuf::from(path)).await
}

/// Accept an inbound file offer. Pass an empty `save_path` to use the default
/// downloads location. Returns the resolved save path.
#[tauri::command]
pub async fn lanchat_accept_file(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    save_path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    swarm::accept_offer(&app, &state.lanchat, &transfer_id, std::path::PathBuf::from(save_path)).await
}

/// Open a received file (or its folder) with the OS default handler.
#[tauri::command]
pub async fn lanchat_open_path(path: String) -> Result<(), String> {
    transfer::open_path(&path)
}

/* ----------------------------- A/V signaling (task 03) ----------------------------- */

/// Send a WebRTC signaling frame to a single peer (call-*/signal-*/media-state).
#[tauri::command]
pub async fn lanchat_send_signal(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    frame_type: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    let my_id = state.lanchat.node_id().await;
    let env = crate::lanchat::protocol::Envelope::new(&frame_type, &my_id, Some(peer_id.clone()), payload);
    crate::lanchat::transport::send_to_peer(&app, &state.lanchat, &peer_id, env).await
}

/// Broadcast a signaling frame to all members of a group (meeting fan-out).
#[tauri::command]
pub async fn lanchat_signal_group(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    frame_type: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    let my_id = state.lanchat.node_id().await;
    let members = state.lanchat.store.list_group_members(&group_id).map_err(|e| e.to_string())?;
    for member in members {
        if member == my_id {
            continue;
        }
        let env = crate::lanchat::protocol::Envelope::new(&frame_type, &my_id, Some(member.clone()), payload.clone());
        let _ = crate::lanchat::transport::send_to_peer(&app, &state.lanchat, &member, env).await;
    }
    Ok(())
}

/// Reject an inbound file offer.
#[tauri::command]
pub async fn lanchat_reject_file(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    swarm::reject_offer(&app, &state.lanchat, &transfer_id).await
}

/* ----------------------------- Native A/V media (v4, Linux stack) ----------------------------- */

/// Start a native media session for `call_id`: spawn its loopback WS relay and
/// return the port the webview connects to. Idempotent — returns the existing
/// port if the session already exists.
#[tauri::command]
pub async fn nmedia_start(state: State<'_, AppState>, call_id: String) -> Result<u16, String> {
    ensure_ready(&state).await?;
    let lan = &state.lanchat;
    if let Some(existing) = lan.media_sessions.read().await.get(&call_id) {
        return Ok(existing.ws_port());
    }
    let session = crate::lanchat::media::NativeMediaSession::start(lan.clone(), call_id.clone()).await?;
    let port = session.ws_port();
    lan.media_sessions.write().await.insert(call_id, session);
    Ok(port)
}

/// Tear down a native media session (releases the relay + capture/encoders).
#[tauri::command]
pub async fn nmedia_stop(state: State<'_, AppState>, call_id: String) -> Result<(), String> {
    if let Some(session) = state.lanchat.media_sessions.write().await.remove(&call_id) {
        session.stop();
    }
    Ok(())
}

/// The loopback WS port for an active native media session.
#[tauri::command]
pub async fn nmedia_ws_port(state: State<'_, AppState>, call_id: String) -> Result<u16, String> {
    state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .map(|s| s.ws_port())
        .ok_or_else(|| format!("no native media session for {call_id}"))
}

/// Register a peer in a native media session (start exchanging media with it).
#[tauri::command]
pub async fn nmedia_add_peer(
    state: State<'_, AppState>,
    call_id: String,
    peer_id: String,
) -> Result<(), String> {
    let session = state.lanchat.media_sessions.read().await.get(&call_id).cloned();
    match session {
        Some(s) => {
            s.add_peer(&peer_id).await;
            Ok(())
        }
        None => Err(format!("no native media session for {call_id}")),
    }
}

/// Remove a peer from a native media session (stop media + drop its tile).
#[tauri::command]
pub async fn nmedia_remove_peer(
    state: State<'_, AppState>,
    call_id: String,
    peer_id: String,
) -> Result<(), String> {
    if let Some(s) = state.lanchat.media_sessions.read().await.get(&call_id).cloned() {
        s.remove_peer(&peer_id).await;
    }
    Ok(())
}

/// Forward a remote peer's mic/cam/screen state into the relay (so the webview
/// updates its tile). Driven by the `media-state` signaling frame.
#[tauri::command]
pub async fn nmedia_peer_state(
    state: State<'_, AppState>,
    call_id: String,
    peer_id: String,
    mic: bool,
    cam: bool,
    screen: bool,
) -> Result<(), String> {
    if let Some(s) = state.lanchat.media_sessions.read().await.get(&call_id).cloned() {
        s.peer_state(&peer_id, mic, cam, screen);
    }
    Ok(())
}

/// Toggle the local microphone for a native media session (mutes the outgoing
/// Opus stream without stopping capture).
#[tauri::command]
pub async fn nmedia_toggle_mic(
    state: State<'_, AppState>,
    call_id: String,
    on: bool,
) -> Result<(), String> {
    if let Some(s) = state.lanchat.media_sessions.read().await.get(&call_id).cloned() {
        s.set_mic(on);
    }
    Ok(())
}

/// Start/stop native screen sharing for a call (X11 capture + H.264 to peers).
#[tauri::command]
pub async fn nmedia_toggle_screen(
    app: AppHandle,
    state: State<'_, AppState>,
    call_id: String,
    on: bool,
) -> Result<(), String> {
    let session = state.lanchat.media_sessions.read().await.get(&call_id).cloned();
    match session {
        Some(s) => s.set_screen(app, state.lanchat.clone(), on).await,
        None => Err(format!("no native media session for {call_id}")),
    }
}

/// Start/stop the native camera for a call (nokhwa capture + H.264 to peers).
#[tauri::command]
pub async fn nmedia_toggle_cam(
    state: State<'_, AppState>,
    call_id: String,
    on: bool,
) -> Result<(), String> {
    let session = state.lanchat.media_sessions.read().await.get(&call_id).cloned();
    match session {
        Some(s) => s.set_cam(state.lanchat.clone(), on).await,
        None => Err(format!("no native media session for {call_id}")),
    }
}
#[tauri::command]
pub async fn lanchat_send_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let conv = direct_conv_id(&peer_id);
    swarm::send_dir(&app, &state.lanchat, vec![peer_id], std::path::PathBuf::from(path), conv, None).await
}

/// Pause / resume / cancel a transfer (`action`: "pause" | "resume" | "cancel").
#[tauri::command]
pub async fn lanchat_transfer_control(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    action: String,
) -> Result<(), String> {
    swarm::control(&app, &state.lanchat, &transfer_id, &action).await
}

/// Capture the primary screen and send it to a peer as a PNG.
#[tauri::command]
pub async fn lanchat_send_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let log = crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
    let path = tokio::task::spawn_blocking(move || transfer::capture_screenshot(&log))
        .await
        .map_err(|e| e.to_string())??;
    let conv = direct_conv_id(&peer_id);
    swarm::send(&app, &state.lanchat, vec![peer_id.clone()], vec![peer_id], path, conv, None).await
}

/// Send a pre-encoded PNG (base64) to a peer as a file. Used as the webview
/// screenshot fallback when native screen capture (the `screen-capture` build
/// feature) is unavailable — e.g. macOS, or any default build.
#[tauri::command]
pub async fn lanchat_send_image_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    data: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("decode image: {e}"))?;
    let path = transfer::save_png_bytes(&bytes)?;
    let conv = direct_conv_id(&peer_id);
    swarm::send(&app, &state.lanchat, vec![peer_id.clone()], vec![peer_id], path, conv, None).await
}
#[tauri::command]
pub async fn lanchat_send_clipboard_image(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let path = {
        let mut guard = state.clipboard.lock().map_err(|_| "clipboard lock".to_string())?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        let cb = guard.as_mut().unwrap();
        let img = cb.get_image().map_err(|_| "剪贴板中没有图片".to_string())?;
        transfer::save_rgba_png(img.width as u32, img.height as u32, &img.bytes)?
    };
    let conv = direct_conv_id(&peer_id);
    swarm::send(&app, &state.lanchat, vec![peer_id.clone()], vec![peer_id], path, conv, None).await
}

/* ----------------------------- retention & security (phase 4) ----------------------------- */

/// Read the message-retention policy.
#[tauri::command]
pub async fn lanchat_get_retention(
    state: State<'_, AppState>,
) -> Result<RetentionSettings, String> {
    state.lanchat.store.get_retention().map_err(|e| e.to_string())
}

/// Update the message-retention policy and apply it immediately.
#[tauri::command]
pub async fn lanchat_set_retention(
    state: State<'_, AppState>,
    settings: RetentionSettings,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .set_retention(&settings)
        .map_err(|e| e.to_string())?;
    let _ = state.lanchat.store.apply_retention();
    Ok(())
}

/// Service enablement state for the UI: whether the background service is
/// currently running, and whether it is configured to start on app launch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanChatServiceState {
    pub running: bool,
    pub start_on_launch: bool,
}

/// Read whether the service is running + the start-on-launch policy.
#[tauri::command]
pub async fn lanchat_get_service_state(
    state: State<'_, AppState>,
) -> Result<LanChatServiceState, String> {
    Ok(LanChatServiceState {
        running: state
            .lanchat
            .running
            .load(std::sync::atomic::Ordering::SeqCst),
        start_on_launch: state
            .lanchat
            .store
            .get_start_on_launch()
            .map_err(|e| e.to_string())?,
    })
}

/// Start the background service on demand (manual enable from the chat UI).
/// Idempotent and one-way: once started it runs until the app exits. The work
/// The service's long-running loops are spawned internally; lock or bind
/// failures are returned to the caller and also published via the service event.
#[tauri::command]
pub async fn lanchat_start_service(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state
        .lanchat
        .running
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Ok(());
    }
    crate::lanchat::start_service(app).await
}

/// Set the "start LanChat on app launch" policy. Does not start/stop the
/// running service — only affects the next launch.
#[tauri::command]
pub async fn lanchat_set_start_on_launch(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .set_start_on_launch(enabled)
        .map_err(|e| e.to_string())
}

/// Delete a single message from local history.
#[tauri::command]
pub async fn lanchat_delete_message(
    state: State<'_, AppState>,
    msg_id: String,
) -> Result<(), String> {
    state.lanchat.store.delete_message(&msg_id).map_err(|e| e.to_string())
}

/// Clear all messages in a conversation.
#[tauri::command]
pub async fn lanchat_clear_conversation(
    state: State<'_, AppState>,
    conv_id: String,
) -> Result<(), String> {
    state.lanchat.store.clear_conversation(&conv_id).map_err(|e| e.to_string())
}

/// Delete all local chat history and reclaim disk space.
#[tauri::command]
pub async fn lanchat_clear_all_history(state: State<'_, AppState>) -> Result<(), String> {
    state.lanchat.store.clear_all_history().map_err(|e| e.to_string())?;
    let _ = state.lanchat.store.vacuum();
    Ok(())
}

/// A pinned peer identity record (trust-on-first-use).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPeer {
    pub node_id: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

/// List pinned peer identities (the verified-on-first-use record).
#[tauri::command]
pub async fn lanchat_list_pinned(state: State<'_, AppState>) -> Result<Vec<PinnedPeer>, String> {
    Ok(state
        .lanchat
        .store
        .list_pins()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(node_id, first_seen, last_seen)| PinnedPeer {
            node_id,
            first_seen,
            last_seen,
        })
        .collect())
}

/// Forget a peer's pinned identity so the next connection re-pins it (use after a
/// peer legitimately reinstalled and now presents a new identity).
#[tauri::command]
pub async fn lanchat_retrust_peer(
    state: State<'_, AppState>,
    node_id: String,
) -> Result<(), String> {
    state.lanchat.store.clear_pin(&node_id).map_err(|e| e.to_string())
}
