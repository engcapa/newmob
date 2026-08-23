//! Text messaging (phase 5): one-to-one send/receive with delivery state.
//!
//! Outbound: persist (sending) -> dial+send the `text-msg` frame -> mark `sent`,
//! then `delivered` on `text-ack` or `failed` on timeout. Inbound: persist
//! (deduped by message id), bump unread, emit to the UI, and reply `text-ack`.
//! Group fan-out is added in phase 6.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::lanchat::protocol::{Envelope, PROTOCOL_VERSION, frame};
use crate::lanchat::store::{LanMessage, direct_conv_id, group_conv_id};
use crate::lanchat::{LanChatState, events, transport};

/// How long an unacked message waits before it is marked `failed`.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

/// App-level cap on a chat message length (characters). Outbound is rejected,
/// inbound is truncated — a sanity bound on top of the transport frame cap.
const MAX_TEXT_CHARS: usize = 8192;

/// True if `text` is within the message-length cap.
fn within_limit(text: &str) -> bool {
    text.chars().take(MAX_TEXT_CHARS + 1).count() <= MAX_TEXT_CHARS
}

/// Truncate inbound text to the cap at a char boundary.
fn cap_text(text: String) -> String {
    if within_limit(&text) {
        text
    } else {
        text.chars().take(MAX_TEXT_CHARS).collect()
    }
}

fn emit_message(app: &AppHandle, msg: &LanMessage) {
    if let Err(e) = app.emit(events::MESSAGE, msg) {
        log::warn!("lanchat: emit message failed: {e}");
    }
}

async fn emit_conversation(app: &AppHandle, state: &Arc<LanChatState>, conv_id: &str) {
    if let Ok(Some(conv)) = state.store.get_conversation(conv_id) {
        if let Err(e) = app.emit(events::CONVERSATION, &conv) {
            log::warn!("lanchat: emit conversation failed: {e}");
        }
    }
}

/// Send `text` to a peer, tracking delivery. Returns the persisted message.
pub async fn send_text(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    text: String,
    mentions: Vec<String>,
) -> Result<LanMessage, String> {
    let my_id = state.node_id().await;
    let conv_id = direct_conv_id(peer_id);
    if !within_limit(&text) {
        return Err("message too long".into());
    }
    state
        .store
        .ensure_conversation(&conv_id, "direct", peer_id)
        .map_err(|e| e.to_string())?;

    let payload =
        json!({ "convId": conv_id.clone(), "text": text.clone(), "mentions": mentions.clone() });
    let env = Envelope::new(frame::TEXT_MSG, &my_id, Some(peer_id.to_string()), payload);
    let msg = LanMessage {
        id: env.id.clone(),
        conv_id: conv_id.clone(),
        sender_id: my_id,
        body: text,
        mentions,
        created_at: env.ts,
        state: "sending".into(),
    };
    state
        .store
        .insert_message(&msg)
        .map_err(|e| e.to_string())?;
    let _ = state.store.touch_conversation(&conv_id, msg.created_at, 0);
    emit_message(app, &msg);
    emit_conversation(app, state, &conv_id).await;

    dispatch_and_track(app, state, peer_id, env).await;
    Ok(state
        .store
        .get_message(&msg.id)
        .ok()
        .flatten()
        .unwrap_or(msg))
}

/// Re-send a previously failed/sending direct message (e.g. after reconnect),
/// reusing the original message id so the ack still correlates.
pub async fn resend(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    msg_id: &str,
) -> Result<LanMessage, String> {
    let msg = state
        .store
        .get_message(msg_id)
        .map_err(|e| e.to_string())?
        .ok_or("message not found")?;
    let peer_id = msg
        .conv_id
        .strip_prefix("direct:")
        .ok_or("resend only supports direct conversations")?
        .to_string();

    let my_id = state.node_id().await;
    let env = Envelope {
        v: PROTOCOL_VERSION,
        frame_type: frame::TEXT_MSG.to_string(),
        id: msg.id.clone(),
        from: my_id,
        to: Some(peer_id.clone()),
        ts: chrono::Utc::now().timestamp_millis(),
        payload: json!({ "convId": msg.conv_id, "text": msg.body, "mentions": msg.mentions }),
    };
    let _ = state.store.set_message_state(&msg.id, "sending");
    if let Ok(Some(m)) = state.store.get_message(&msg.id) {
        emit_message(app, &m);
    }
    dispatch_and_track(app, state, &peer_id, env).await;
    Ok(state
        .store
        .get_message(&msg.id)
        .ok()
        .flatten()
        .unwrap_or(msg))
}

/// Send the frame and track delivery: `sent` on success (+ failure timeout),
/// `failed` immediately if the peer is unreachable.
async fn dispatch_and_track(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    env: Envelope,
) {
    let msg_id = env.id.clone();
    match transport::send_to_peer(app, state, peer_id, env).await {
        Ok(()) => {
            let _ = state.store.set_message_state(&msg_id, "sent");
            if let Ok(Some(m)) = state.store.get_message(&msg_id) {
                emit_message(app, &m);
            }
            spawn_delivery_timeout(app.clone(), state.clone(), msg_id);
        }
        Err(e) => {
            log::debug!("lanchat: send to {peer_id} failed: {e}");
            let _ = state.store.set_message_state(&msg_id, "failed");
            if let Ok(Some(m)) = state.store.get_message(&msg_id) {
                emit_message(app, &m);
            }
        }
    }
}

/// After `DELIVERY_TIMEOUT`, demote a still-unacked `sent` message to `failed`.
fn spawn_delivery_timeout(app: AppHandle, state: Arc<LanChatState>, msg_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(DELIVERY_TIMEOUT).await;
        if let Ok(Some(m)) = state.store.get_message(&msg_id) {
            if m.state == "sent" {
                let _ = state.store.set_message_state(&msg_id, "failed");
                if let Ok(Some(updated)) = state.store.get_message(&msg_id) {
                    emit_message(&app, &updated);
                }
            }
        }
    });
}

/// Handle an inbound `text-msg`: persist (deduped), bump unread, emit, and ack.
pub async fn handle_text_msg(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    from: &str,
    env: &Envelope,
) {
    let text = env
        .payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let text = cap_text(text);
    let mentions: Vec<String> = env
        .payload
        .get("mentions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Group message (payload carries groupId) vs direct (keyed by sender).
    let group_id = env
        .payload
        .get("groupId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let conv_id = match &group_id {
        Some(g) => {
            // Ensure the group exists locally even if the announce was missed;
            // record the sender (and ourselves) as members.
            let _ = state.store.upsert_group(g, g);
            let _ = state.store.add_group_member(g, from);
            let my_id = state.node_id().await;
            let _ = state.store.add_group_member(g, &my_id);
            group_conv_id(g)
        }
        None => direct_conv_id(from),
    };
    let (kind, poid) = match &group_id {
        Some(g) => ("group", g.clone()),
        None => ("direct", from.to_string()),
    };
    if let Err(e) = state.store.ensure_conversation(&conv_id, kind, &poid) {
        log::debug!("lanchat: ensure conversation failed: {e}");
        return;
    }
    let msg = LanMessage {
        id: env.id.clone(),
        conv_id: conv_id.clone(),
        sender_id: from.to_string(),
        body: text,
        mentions,
        created_at: env.ts,
        state: "delivered".into(),
    };
    match state.store.insert_message(&msg) {
        Ok(true) => {
            let _ = state.store.touch_conversation(&conv_id, env.ts, 1);
            emit_message(app, &msg);
            emit_conversation(app, state, &conv_id).await;
        }
        Ok(false) => { /* duplicate delivery — already stored */ }
        Err(e) => log::debug!("lanchat: insert inbound message failed: {e}"),
    }
    // Ack even duplicates so the sender stops waiting.
    send_ack(state, from, &env.id).await;
}

/// Handle an inbound `text-ack`: mark the referenced message delivered.
pub async fn handle_text_ack(app: &AppHandle, state: &Arc<LanChatState>, env: &Envelope) {
    if let Some(ack_of) = env.payload.get("ackOf").and_then(|v| v.as_str()) {
        let _ = state.store.set_message_state(ack_of, "delivered");
        if let Ok(Some(m)) = state.store.get_message(ack_of) {
            emit_message(app, &m);
        }
    }
}

async fn send_ack(state: &Arc<LanChatState>, to: &str, msg_id: &str) {
    let my_id = state.node_id().await;
    let ack = Envelope::new(
        frame::TEXT_ACK,
        &my_id,
        Some(to.to_string()),
        json!({ "ackOf": msg_id }),
    );
    if let Some(handle) = state.connections.read().await.get(to) {
        let _ = handle.send(ack);
    }
}

/* ----------------------------- groups (phase 6) ----------------------------- */

fn emit_group(app: &AppHandle, group: &crate::lanchat::store::Group) {
    if let Err(e) = app.emit(events::GROUP, group) {
        log::warn!("lanchat: emit group failed: {e}");
    }
}

/// Broadcast an envelope to a set of peers (best-effort, skipping self).
async fn broadcast(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    members: &[String],
    my_id: &str,
    make: impl Fn() -> Envelope,
) {
    for member in members {
        if member == my_id {
            continue;
        }
        let env = make();
        if let Err(e) = transport::send_to_peer(app, state, member, env).await {
            log::debug!("lanchat: broadcast to {member} failed: {e}");
        }
    }
}

/// Create a group locally, announce it to members, and return it.
pub async fn create_group(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    name: &str,
    members: Vec<String>,
) -> Result<crate::lanchat::store::Group, String> {
    let my_id = state.node_id().await;
    let group_id = uuid::Uuid::new_v4().to_string();
    state
        .store
        .upsert_group(&group_id, name)
        .map_err(|e| e.to_string())?;
    state.store.add_group_member(&group_id, &my_id).ok();
    for m in &members {
        state.store.add_group_member(&group_id, m).ok();
    }
    let conv_id = group_conv_id(&group_id);
    state
        .store
        .ensure_conversation(&conv_id, "group", &group_id)
        .map_err(|e| e.to_string())?;

    let group = state
        .store
        .get_group(&group_id)
        .map_err(|e| e.to_string())?
        .ok_or("group missing after create")?;

    // Announce to all members so they create the group locally.
    let announce_members = group.members.clone();
    let payload = json!({ "groupId": group_id, "name": name, "members": announce_members });
    broadcast(app, state, &group.members, &my_id, || {
        Envelope::new(frame::GROUP_ANNOUNCE, &my_id, None, payload.clone())
    })
    .await;

    emit_group(app, &group);
    emit_conversation(app, state, &conv_id).await;
    Ok(group)
}

/// Send a group message to all online members (mesh fan-out from the sender).
pub async fn send_group_text(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    group_id: &str,
    text: String,
    mentions: Vec<String>,
) -> Result<LanMessage, String> {
    let my_id = state.node_id().await;
    let conv_id = group_conv_id(group_id);
    if !within_limit(&text) {
        return Err("message too long".into());
    }
    state
        .store
        .ensure_conversation(&conv_id, "group", group_id)
        .map_err(|e| e.to_string())?;

    let msg_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let msg = LanMessage {
        id: msg_id.clone(),
        conv_id: conv_id.clone(),
        sender_id: my_id.clone(),
        body: text.clone(),
        mentions: mentions.clone(),
        created_at: now,
        state: "sent".into(),
    };
    state
        .store
        .insert_message(&msg)
        .map_err(|e| e.to_string())?;
    let _ = state.store.touch_conversation(&conv_id, now, 0);
    emit_message(app, &msg);
    emit_conversation(app, state, &conv_id).await;

    // Fan out the same message id to every member; receivers dedup by id.
    let members = state.store.list_group_members(group_id).unwrap_or_default();
    let payload = json!({ "groupId": group_id, "text": text, "mentions": mentions });
    for member in members {
        if member == my_id {
            continue;
        }
        let env = Envelope {
            v: PROTOCOL_VERSION,
            frame_type: frame::TEXT_MSG.to_string(),
            id: msg_id.clone(),
            from: my_id.clone(),
            to: Some(member.clone()),
            ts: now,
            payload: payload.clone(),
        };
        if let Err(e) = transport::send_to_peer(app, state, &member, env).await {
            log::debug!("lanchat: group send to {member} failed: {e}");
        }
    }
    Ok(msg)
}

/// Inbound `group-announce`: create/refresh the group + its membership locally.
pub async fn handle_group_announce(app: &AppHandle, state: &Arc<LanChatState>, env: &Envelope) {
    let Some(group_id) = env.payload.get("groupId").and_then(|v| v.as_str()) else {
        return;
    };
    let name = env
        .payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(group_id);
    let _ = state.store.upsert_group(group_id, name);
    if let Some(members) = env.payload.get("members").and_then(|v| v.as_array()) {
        for m in members.iter().filter_map(|x| x.as_str()) {
            let _ = state.store.add_group_member(group_id, m);
        }
    }
    let my_id = state.node_id().await;
    let _ = state.store.add_group_member(group_id, &my_id);
    let conv_id = group_conv_id(group_id);
    let _ = state.store.ensure_conversation(&conv_id, "group", group_id);
    if let Ok(Some(group)) = state.store.get_group(group_id) {
        emit_group(app, &group);
    }
    emit_conversation(app, state, &conv_id).await;
}

/// Inbound `group-join` / `group-leave`: update membership and notify the UI.
pub async fn handle_group_membership(app: &AppHandle, state: &Arc<LanChatState>, env: &Envelope) {
    let Some(group_id) = env.payload.get("groupId").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(node_id) = env.payload.get("nodeId").and_then(|v| v.as_str()) else {
        return;
    };
    if env.frame_type == frame::GROUP_JOIN {
        let _ = state.store.add_group_member(group_id, node_id);
    } else {
        let _ = state.store.remove_group_member(group_id, node_id);
    }
    if let Ok(Some(group)) = state.store.get_group(group_id) {
        emit_group(app, &group);
    }
}

/// Leave a group locally and notify members.
pub async fn leave_group(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    group_id: &str,
) -> Result<(), String> {
    let my_id = state.node_id().await;
    let members = state.store.list_group_members(group_id).unwrap_or_default();
    state
        .store
        .remove_group_member(group_id, &my_id)
        .map_err(|e| e.to_string())?;
    let payload = json!({ "groupId": group_id, "nodeId": my_id });
    broadcast(app, state, &members, &my_id, || {
        Envelope::new(frame::GROUP_LEAVE, &my_id, None, payload.clone())
    })
    .await;
    if let Ok(Some(group)) = state.store.get_group(group_id) {
        emit_group(app, &group);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_limit_bounds_message_length() {
        assert!(within_limit("hello"));
        assert!(within_limit(&"x".repeat(MAX_TEXT_CHARS)));
        assert!(!within_limit(&"x".repeat(MAX_TEXT_CHARS + 1)));
    }

    #[test]
    fn cap_text_truncates_overlong_inbound() {
        let long = "у".repeat(MAX_TEXT_CHARS + 500); // multi-byte chars
        let capped = cap_text(long);
        assert_eq!(capped.chars().count(), MAX_TEXT_CHARS);
        // Short text is returned unchanged.
        assert_eq!(cap_text("hi".into()), "hi");
    }
}
