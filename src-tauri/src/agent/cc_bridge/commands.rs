use crate::agent::cc_bridge::process::CcProcess;
use crate::agent::cc_bridge::protocol::{CcEvent, extract_answer, extract_session_id};
use crate::agent::cc_bridge::{CcStatusResult, detect};
use crate::ai::config::{AiConfig, default_ai_config_path};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Per-thread CC process registry (held in AppState via a separate Mutex).
pub type CcProcessRegistry = Mutex<HashMap<String, Arc<CcProcess>>>;

/// Detect Claude Code CLI status. Returns NotFound when full-local mode is on,
/// so the frontend hides the integration without leaking that CC is installed.
#[tauri::command]
pub async fn cc_detect(state: State<'_, AppState>) -> Result<CcStatusResult, String> {
    let ai_ctx = state.ai_ctx.read().await;
    if ai_ctx.config.full_local_mode || ai_ctx.config.fully_disabled {
        return Ok(CcStatusResult {
            status: crate::agent::cc_bridge::CcStatus::NotFound,
            message: "Claude Code is hidden in full-local / fully-disabled mode.".into(),
            binary_path: None,
        });
    }
    let cc_bridge = ai_ctx.config.cc_bridge.clone();
    let binary = if cc_bridge.binary == "auto" {
        None
    } else {
        Some(cc_bridge.binary.clone())
    };
    drop(ai_ctx);
    let proxy = crate::agent::cc_bridge::config::resolve_global_proxy_url(&state, &cc_bridge)?;
    Ok(detect(binary.as_deref(), proxy.as_deref()).await)
}

/// Return the raw user-supplied Claude Code `settings.json` (decrypted from the
/// vault) so the Settings UI can load it into its editor. Returns:
/// - `Ok(None)` when no custom settings are configured.
/// - `Ok(Some(json))` the stored settings JSON.
/// - `Err("VAULT_LOCKED: …")` when a reference is set but the vault is locked.
#[tauri::command]
pub async fn cc_get_custom_settings(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let config = AiConfig::load(&default_ai_config_path());
    crate::agent::cc_bridge::config::resolve_custom_settings(&config.cc_bridge, &state.vault)
}

#[tauri::command]
pub async fn cc_get_profile_settings(
    vault_ref: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if !vault_ref.starts_with("vault:") {
        return Err("Invalid vault reference".into());
    }
    match state.vault.resolve(&vault_ref) {
        Ok(Some(plaintext)) => Ok(Some(plaintext.to_string())),
        Ok(None) => Ok(None),
        Err(e) if e.contains(crate::vault::ERR_VAULT_LOCKED) => Err(format!(
            "{}: unlock the credential vault to read settings.",
            crate::vault::ERR_VAULT_LOCKED
        )),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CcSendRequest {
    pub thread_id: String,
    pub message: String,
    /// Optional thread workspace root. Forwarded to CC via `--add-dir` so the
    /// CLI is constrained to read only that directory tree (in addition to
    /// the deny list configured in settings.json). Per the plan §9.5.5, CC
    /// must not be able to walk `~/.ssh`, the vault, or the Taomni config
    /// directory; combining `--add-dir` (allow) with the deny list double-
    /// gates these critical paths.
    #[serde(default)]
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CcSendResponse {
    pub answer: String,
    pub events: Vec<CcEvent>,
    pub tool_calls: Vec<CcToolCall>,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CcToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// Send a message to Claude Code for a given thread.
/// Spawns a CC process if one isn't running for this thread.
#[tauri::command]
pub async fn cc_send_message(
    req: CcSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CcSendResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled || ai_ctx.config.full_local_mode {
            return Err("Claude Code is unavailable in full-local / fully-disabled mode.".into());
        }
        if !ai_ctx.config.cc_bridge.enabled {
            return Err("Claude Code integration is disabled.".into());
        }
    }

    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.cc_bridge.binary == "auto" {
        crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
    } else {
        config.cc_bridge.binary.clone()
    };

    // Look up the saved session id for this thread (for --resume continuity)
    // and the linked SSH session (for token trust scoping).
    let (resume_session, linked_session) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = crate::chat::store::list_threads(&db, 200)
            .ok()
            .and_then(|ts| ts.into_iter().find(|t| t.id == req.thread_id));
        match thread {
            Some(t) => (t.cc_session_id, t.linked_session_id),
            None => (None, None),
        }
    };

    // Get or create CC process for this thread. Only a *new* process writes
    // temp config files; a reused one keeps the obscure settings file it was
    // launched with (scrubbed when the session stops).
    let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
    let process = match existing {
        Some(p) => p,
        None => {
            let effective_proxy = crate::agent::cc_bridge::config::resolve_effective_proxy_url(
                &state,
                &config.cc_bridge,
            )?;
            // Provision the in-app rmcp MCP server + a per-thread scoped token.
            // This alternate path is shell-only (DB flavor selection lives in
            // the active `chat_stream` path), so it uses the Shell flavor.
            let flavor = crate::agent::cc_bridge::mcp_http::Flavor::Shell;
            let (cc_server_url, cc_token) =
                crate::agent::cc_bridge::mcp_http::provision_for_thread(
                    &app,
                    &req.thread_id,
                    linked_session.clone(),
                    // Legacy direct-CC path: the saved SessionConfig.id isn't
                    // resolved here (only the chat_stream path carries it), so
                    // config-id scope acceptance is unavailable on this path.
                    None,
                    flavor,
                    config.cc_bridge.confirm_readonly,
                )
                .await?;
            let control_server_url = crate::agent::cc_bridge::mcp_http::control_server_url()?;
            // Resolve the user's custom settings.json from the vault (when set).
            let custom = crate::agent::cc_bridge::config::resolve_custom_settings(
                &config.cc_bridge,
                &state.vault,
            )?;
            let files = crate::agent::cc_bridge::config::create_session_files(
                custom.as_deref(),
                flavor.server_name(),
                &cc_server_url,
                &cc_token,
                &control_server_url,
            )?;

            // Build extra args.
            let mut extra_args = vec![
                "--model".into(),
                config.cc_bridge.default_model.clone(),
                "--max-turns".into(),
                config.cc_bridge.max_turns.to_string(),
                "--settings".into(),
                files.settings_path.to_string_lossy().to_string(),
                // §36/37: route every tool call through Taomni's permission prompt
                // and expose Taomni's tool surface back to CC via --mcp-config.
                "--mcp-config".into(),
                files.mcp_path.to_string_lossy().to_string(),
                "--strict-mcp-config".into(),
                "--permission-prompt-tool".into(),
                flavor.permission_prompt_tool().into(),
            ];
            // §21: thread workspace whitelist. CC walks files via the Read/Glob
            // tools; `--add-dir` constrains those to the requested workspace tree.
            if let Some(ws) = &req.workspace_dir {
                let path = PathBuf::from(ws);
                if path.is_absolute() && path.exists() {
                    extra_args.push("--add-dir".into());
                    extra_args.push(path.to_string_lossy().to_string());
                }
            }
            if let Some(sid) = &resume_session {
                extra_args.push("--resume".into());
                extra_args.push(sid.clone());
            }

            let p = Arc::new(
                CcProcess::new(&binary, extra_args, Some(files.dir))
                    .with_proxy_url(effective_proxy)
                    .with_token(cc_token.clone()),
            );
            let mut registry = state.cc_processes.lock().await;
            match registry.get(&req.thread_id) {
                Some(existing) => existing.clone(),
                None => {
                    registry.insert(req.thread_id.clone(), p.clone());
                    p
                }
            }
        }
    };

    // Start the Weak-based liveness watchdog (idempotent).
    process.start_watchdog();

    let events = process.send(&req.message).await?;

    let answer = extract_answer(&events);
    let session_id = extract_session_id(&events).or(resume_session);
    if let Some(sid) = &session_id {
        if let Ok(db) = state.db.lock() {
            let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
        }
    }

    let tool_calls: Vec<CcToolCall> = events
        .iter()
        .filter_map(|e| match e {
            CcEvent::ToolUse { id, name, input } => Some(CcToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect();

    Ok(CcSendResponse {
        answer,
        events,
        tool_calls,
        session_id,
    })
}

/// Stop the CC process for a thread.
#[tauri::command]
pub async fn cc_stop_session(thread_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut registry = state.cc_processes.lock().await;
    if let Some(process) = registry.remove(&thread_id) {
        process.stop().await;
    }
    Ok(())
}

/// Stop and drop the CC process bound to a thread (if any) so the next send
/// re-spawns it. Use this whenever a *spawn-time* argument changes — the
/// provider switched away from `claude-code`, or the per-thread model changed —
/// since those are baked into the child's argv and a live, reused process
/// can't adopt them. Removing the Arc from the registry revokes the MCP token,
/// scrubs the temp dir (via `stop()`/`Drop`), and lets the Weak-based watchdog
/// exit. No-op when the thread has no live process.
///
/// The registry lock is released before `stop()` so we don't hold it across the
/// child kill.
pub(crate) async fn recycle_thread_process(state: &AppState, thread_id: &str) {
    let process = { state.cc_processes.lock().await.remove(thread_id) };
    if let Some(process) = process {
        process.stop().await;
    }
    // Best-effort `rm -f` of any remote (C-path) capture temp files before we
    // drop the captures; the local scrub in purge_thread can't reach a remote
    // host. The session may already be gone — failures are harmless.
    let remote = state.captures.remote_files(thread_id);
    if !remote.is_empty() {
        let terms = state.terminals.read().await;
        for (session_id, path) in remote {
            // `session_id` is the tab id stored at capture time; `terminals` is
            // keyed by the backend session id, so translate via the live map.
            let backend_sid = state
                .cc_tab_sessions
                .lock()
                .ok()
                .and_then(|m| m.get(&session_id).cloned())
                .unwrap_or(session_id);
            if let Some(crate::terminal::ActiveTerminal::Ssh { handle, .. }) =
                terms.get(&backend_sid)
            {
                crate::agent::capture::exec_c::cleanup_remote(handle, &path).await;
            }
        }
    }
    // Drop + scrub this thread's captures (方案4); their files are tied to the
    // process lifetime the same way the temp dir is.
    state.captures.purge_thread(thread_id);
}

/// Cancel an in-flight captured run (方案4). Fires the capture's cancel
/// `Notify`, which drops the SSH exec channel / kills the local child; the
/// run loop then finalizes the capture as `cancelled`. Idempotent.
#[tauri::command]
pub async fn cc_cancel_capture(
    capture_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let notify = state
        .cc_capture_cancels
        .lock()
        .map_err(|e| e.to_string())?
        .get(&capture_id)
        .cloned();
    if let Some(n) = notify {
        n.notify_waiters();
    }
    Ok(())
}

/// Record that a live terminal tab (`tab_id`, the caller-facing id CC's tools
/// see) is backed by a concrete backend terminal session (`session_id`, the
/// `state.terminals` key). The frontend calls this from its terminal registry
/// as a panel connects, so backend-side CC tools (`run_captured` /
/// `read_capture`) can resolve the live terminal that `run_in_terminal` reaches
/// indirectly through the frontend registry. Overwrites on reconnect. Idempotent.
#[tauri::command]
pub async fn cc_track_terminal(
    tab_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .cc_tab_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(tab_id, session_id);
    Ok(())
}

/// Drop a terminal tab → backend session mapping recorded by
/// [`cc_track_terminal`]. Only removes the entry when it still points at
/// `session_id`, so a stale unmount can't clobber a newer reconnect's mapping
/// (mirrors the frontend registry's own ownership guard). Idempotent.
#[tauri::command]
pub async fn cc_untrack_terminal(
    tab_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut map = state.cc_tab_sessions.lock().map_err(|e| e.to_string())?;
    if map.get(&tab_id).is_some_and(|s| *s == session_id) {
        map.remove(&tab_id);
    }
    Ok(())
}

/// Resolve a pending CC side-effect tool call. The frontend calls this after it
/// has performed the effect dispatched by an `agent-cc-tool` event; the value
/// unblocks the in-app MCP server's tool handler so CC receives the result.
#[tauri::command]
pub async fn cc_resolve_tool_call(
    call_id: String,
    ok: bool,
    output: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sender = state
        .cc_pending_tool_calls
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&call_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(crate::state::CcToolOutcome { ok, output });
            Ok(())
        }
        None => Err(format!("no pending CC tool call '{call_id}'")),
    }
}

/// Resolve a pending CC permission prompt with the human's decision (from the
/// ActionCard). Unblocks the in-app MCP server's `permission_prompt` handler.
#[tauri::command]
pub async fn cc_resolve_permission(
    call_id: String,
    decision: crate::state::CcPermissionDecision,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sender = state
        .cc_pending_permissions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&call_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(decision);
            Ok(())
        }
        None => Err(format!("no pending CC permission prompt '{call_id}'")),
    }
}

/// Streaming variant of `cc_send_message`. Emits `cc-stream:{thread_id}`
/// events for every CcEvent the CLI produces (assistant_message, tool_use,
/// partial, etc.). Resolves once the stream finishes.
#[tauri::command]
pub async fn cc_stream_message(
    req: CcSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CcSendResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled || ai_ctx.config.full_local_mode {
            return Err("Claude Code is unavailable in full-local / fully-disabled mode.".into());
        }
        if !ai_ctx.config.cc_bridge.enabled {
            return Err("Claude Code integration is disabled.".into());
        }
    }

    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.cc_bridge.binary == "auto" {
        crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
    } else {
        config.cc_bridge.binary.clone()
    };

    let (resume_session, linked_session) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = crate::chat::store::list_threads(&db, 200)
            .ok()
            .and_then(|ts| ts.into_iter().find(|t| t.id == req.thread_id));
        match thread {
            Some(t) => (t.cc_session_id, t.linked_session_id),
            None => (None, None),
        }
    };

    let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
    let process = match existing {
        Some(p) => p,
        None => {
            let effective_proxy = crate::agent::cc_bridge::config::resolve_effective_proxy_url(
                &state,
                &config.cc_bridge,
            )?;
            // Shell-only alternate path (see the streaming variant above).
            let flavor = crate::agent::cc_bridge::mcp_http::Flavor::Shell;
            let (cc_server_url, cc_token) =
                crate::agent::cc_bridge::mcp_http::provision_for_thread(
                    &app,
                    &req.thread_id,
                    linked_session.clone(),
                    // Legacy direct-CC path: the saved SessionConfig.id isn't
                    // resolved here (only the chat_stream path carries it), so
                    // config-id scope acceptance is unavailable on this path.
                    None,
                    flavor,
                    config.cc_bridge.confirm_readonly,
                )
                .await?;
            let control_server_url = crate::agent::cc_bridge::mcp_http::control_server_url()?;
            let custom = crate::agent::cc_bridge::config::resolve_custom_settings(
                &config.cc_bridge,
                &state.vault,
            )?;
            let files = crate::agent::cc_bridge::config::create_session_files(
                custom.as_deref(),
                flavor.server_name(),
                &cc_server_url,
                &cc_token,
                &control_server_url,
            )?;

            let mut extra_args = vec![
                "--model".into(),
                config.cc_bridge.default_model.clone(),
                "--max-turns".into(),
                config.cc_bridge.max_turns.to_string(),
                "--settings".into(),
                files.settings_path.to_string_lossy().to_string(),
                "--mcp-config".into(),
                files.mcp_path.to_string_lossy().to_string(),
                "--strict-mcp-config".into(),
                "--permission-prompt-tool".into(),
                flavor.permission_prompt_tool().into(),
            ];
            if let Some(ws) = &req.workspace_dir {
                let path = PathBuf::from(ws);
                if path.is_absolute() && path.exists() {
                    extra_args.push("--add-dir".into());
                    extra_args.push(path.to_string_lossy().to_string());
                }
            }
            if let Some(sid) = &resume_session {
                extra_args.push("--resume".into());
                extra_args.push(sid.clone());
            }

            let p = Arc::new(
                CcProcess::new(&binary, extra_args, Some(files.dir))
                    .with_proxy_url(effective_proxy)
                    .with_token(cc_token.clone()),
            );
            let mut registry = state.cc_processes.lock().await;
            match registry.get(&req.thread_id) {
                Some(existing) => existing.clone(),
                None => {
                    registry.insert(req.thread_id.clone(), p.clone());
                    p
                }
            }
        }
    };

    let event_name = format!("cc-stream:{}", req.thread_id);
    let app_clone = app.clone();
    process.start_watchdog();
    let events = process
        .send_with_callback(&req.message, move |evt| {
            let _ = app_clone.emit(&event_name, evt.clone());
        })
        .await?;

    let answer = extract_answer(&events);
    let session_id = extract_session_id(&events).or(resume_session);
    if let Some(sid) = &session_id {
        if let Ok(db) = state.db.lock() {
            let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
        }
    }
    let tool_calls: Vec<CcToolCall> = events
        .iter()
        .filter_map(|e| match e {
            CcEvent::ToolUse { id, name, input } => Some(CcToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect();
    Ok(CcSendResponse {
        answer,
        events,
        tool_calls,
        session_id,
    })
}

#[tauri::command]
pub async fn cc_test_settings(
    settings_json: String,
    proxy_mode: Option<String>,
    proxy_session_id: Option<String>,
    proxy_url: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.cc_bridge.binary == "auto" {
        crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
    } else {
        config.cc_bridge.binary.clone()
    };
    let effective_proxy =
        crate::agent::cc_bridge::config::resolve_effective_proxy_url_with_profile_override(
            &state,
            &config.cc_bridge,
            proxy_mode.as_deref(),
            proxy_session_id.as_deref(),
            proxy_url.as_deref(),
        )?;

    let thread_id = "cc_test_settings_thread".to_string();
    let event_name = "cc-test-settings-stream".to_string();

    let emit = |evt: crate::chat::StreamEventOut| {
        let _ = app.emit(&event_name, evt);
    };

    // Kill any existing test process first to clean up
    {
        let mut registry = state.cc_processes.lock().await;
        if let Some(old) = registry.remove(&thread_id) {
            old.stop().await;
        }
    }

    let flavor = crate::agent::cc_bridge::mcp_http::Flavor::Shell;
    let (cc_server_url, cc_token) = crate::agent::cc_bridge::mcp_http::provision_for_thread(
        &app,
        &thread_id,
        None,
        None,
        flavor,
        config.cc_bridge.confirm_readonly,
    )
    .await?;
    let control_server_url = crate::agent::cc_bridge::mcp_http::control_server_url()?;

    let files = crate::agent::cc_bridge::config::create_session_files(
        Some(&settings_json),
        flavor.server_name(),
        &cc_server_url,
        &cc_token,
        &control_server_url,
    )?;

    eprintln!(
        "[cc test settings] Temporary settings.json path: {}",
        files.settings_path.to_string_lossy()
    );

    let extra_args = vec![
        "--model".into(),
        config.cc_bridge.default_model.clone(),
        "--max-turns".into(),
        "3".into(),
        "--settings".into(),
        files.settings_path.to_string_lossy().to_string(),
        "--mcp-config".into(),
        files.mcp_path.to_string_lossy().to_string(),
        "--strict-mcp-config".into(),
        "--permission-prompt-tool".into(),
        flavor.permission_prompt_tool().into(),
        "--bare".into(),
    ];

    let process = Arc::new(
        crate::agent::cc_bridge::process::CcProcess::new(&binary, extra_args, Some(files.dir))
            .with_proxy_url(effective_proxy)
            .with_token(cc_token.clone()),
    );

    {
        let mut registry = state.cc_processes.lock().await;
        registry.insert(thread_id.clone(), process.clone());
    }

    let app_clone = app.clone();
    let event_name_clone = event_name.clone();
    let prompt = "Hello, My name is Taomni, Can you help me?".to_string();

    let events_result = process
        .send_with_callback(&prompt, move |evt| {
            use crate::agent::cc_bridge::protocol::CcEvent;
            if let CcEvent::Partial { content } = evt {
                let _ = app_clone.emit(
                    &event_name_clone,
                    crate::chat::StreamEventOut::Token {
                        id: "test".to_string(),
                        content: content.clone(),
                    },
                );
            }
        })
        .await;

    // Clean up registry
    let stderr = process.get_stderr().await.trim().to_string();
    {
        let mut registry = state.cc_processes.lock().await;
        if let Some(old) = registry.remove(&thread_id) {
            old.stop().await;
        }
    }

    if stderr.contains("Settings Error") || stderr.contains("Invalid value") {
        let msg = format!("Settings validation failed:\n{}", stderr);
        emit(crate::chat::StreamEventOut::Error {
            id: "test".to_string(),
            message: msg.clone(),
        });
        return Err(msg);
    }

    match events_result {
        Ok(events) => {
            let mut final_content = String::new();
            for event in &events {
                use crate::agent::cc_bridge::protocol::CcEvent;
                if let CcEvent::AssistantMessage { content } = event {
                    final_content.push_str(content);
                }
            }
            emit(crate::chat::StreamEventOut::End {
                id: "test".to_string(),
                thread_id,
                content: final_content,
                redacted_count: 0,
            });
            Ok(())
        }
        Err(e) => {
            emit(crate::chat::StreamEventOut::Error {
                id: "test".to_string(),
                message: e.clone(),
            });
            Err(e)
        }
    }
}
