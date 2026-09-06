pub mod client;
pub mod forwards;
pub mod local_directories;
pub mod network;
pub mod pty;
pub mod shell_integration;
pub mod ssh;
pub mod x11;
pub mod x11_forward;

use crate::state::AppState;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use russh::Sig;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::io::{Read, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

pub type TerminalOutputChannel = Channel<InvokeResponseBody>;
type TerminalOutputSubscribers = Arc<Mutex<HashMap<String, Vec<TerminalOutputChannel>>>>;

pub enum ActiveTerminal {
    Local {
        writer: Mutex<Box<dyn Write + Send>>,
        master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
        #[allow(dead_code)]
        child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    },
    Ssh {
        channel: Arc<AsyncMutex<russh::ChannelWriteHalf<russh::client::Msg>>>,
        #[allow(dead_code)]
        handle: Arc<russh::client::Handle<ssh::SshHandler>>,
        /// Listener tasks for any session-attached local port forwards.
        /// `close_terminal` aborts these to release the bound TCP ports.
        forwards: AsyncMutex<Vec<JoinHandle<()>>>,
    },
}

unsafe impl Send for ActiveTerminal {}
unsafe impl Sync for ActiveTerminal {}

#[tauri::command]
pub fn list_local_shells() -> Vec<pty::LocalShellOption> {
    pty::list_local_shells()
}

#[tauri::command]
pub async fn list_common_local_directories(
    state: State<'_, AppState>,
) -> Result<local_directories::DirectoryListEnvelope, String> {
    // Block on the DB lock (the old try_lock fallback returned a fake
    // "defaults only" list, which silently lost history). Filesystem
    // probing happens inside `list_directory_shortcuts` without the DB
    // lock held.
    let db = state.db.lock().map_err(|e| format!("session database is unavailable: {e}"))?;
    let mut db = db;
    local_directories::init_tables(&db).map_err(|e| e.to_string())?;
    local_directories::migrate_legacy_history(&mut db).map_err(|e| e.to_string())?;
    local_directories::list_directory_shortcuts(&db)
}

/// Frontend-driven confirmed cwd report from a live native-local terminal
/// (OSC 7). Clicks, queueing, failed spawns and remote/WSL paths never
/// reach this command.
#[tauri::command]
pub async fn record_local_directory_use(
    backend_session_id: String,
    path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<local_directories::RecordDirectoryUseResponse, String> {
    // Only live native-local terminals may record use. Async lock: this runs
    // on the Tokio runtime, where `blocking_read` would panic.
    {
        let terminals = state.terminals.read().await;
        match terminals.get(&backend_session_id) {
            Some(ActiveTerminal::Local { .. }) => {}
            _ => {
                return Err(format!(
                    "terminal {backend_session_id} is not a live local terminal"
                ))
            }
        }
    }
    record_local_directory_use_inner(&backend_session_id, &path, &state, &app_handle)
}

pub(crate) fn record_local_directory_use_inner(
    backend_session_id: &str,
    path: &str,
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<local_directories::RecordDirectoryUseResponse, String> {
    if backend_session_id.trim().is_empty() {
        return Err("backend session id is required".to_string());
    }
    // Per-runtime dedup: repeated prompts/cwd probes for the same directory
    // never rewrite the record.
    let path_buf = std::path::PathBuf::from(path);
    let Some(new_key) = local_directories::normalize_path_key(&path_buf) else {
        return Err(format!("invalid local directory path: {path}"));
    };
    if let Some(last) = state.local_directory_runtime.lock().ok().and_then(|r| r.get(backend_session_id).cloned()) {
        if last == new_key {
            return Ok(local_directories::RecordDirectoryUseResponse {
                changed: false,
                directory: None,
            });
        }
    }
    let now_ms = local_directories::system_now_ms();
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    local_directories::init_tables(&db).map_err(|e| e.to_string())?;
    let (changed, revision) =
        local_directories::record_directory_use(&mut db, &path_buf, local_directories::SOURCE_LOCAL_CWD, now_ms)?;
    if let Ok(mut runtime) = state.local_directory_runtime.lock() {
        runtime.insert(backend_session_id.to_string(), new_key);
    }
    if changed {
        let _ = app_handle.emit("welcome-directories-changed", serde_json::json!({ "revision": revision }));
    }
    Ok(local_directories::RecordDirectoryUseResponse {
        changed,
        directory: None,
    })
}

/// Rust-internal confirmed spawn write. Called from the success path of
/// `create_local_terminal` with the requested cwd; the frontend can never
/// pass arbitrary times or treat clicks as successes.
pub(crate) fn record_successful_local_start(
    state: &AppState,
    app_handle: &AppHandle,
    backend_session_id: &str,
    requested_cwd: Option<&str>,
) -> Option<String> {
    let Some(cwd) = requested_cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        // No requested cwd: first confirmed OSC 7 will record instead.
        return None;
    };
    let path = std::path::PathBuf::from(cwd);
    let Some(new_key) = local_directories::normalize_path_key(&path) else {
        return None;
    };
    let now_ms = local_directories::system_now_ms();
    let mut db = match state.db.lock() {
        Ok(db) => db,
        Err(e) => {
            return Some(format!("local directory history save failed: {e}"));
        }
    };
    let result = local_directories::record_directory_use(
        &mut db,
        &path,
        local_directories::SOURCE_LOCAL_START,
        now_ms,
    );
    if let Ok(mut runtime) = state.local_directory_runtime.lock() {
        runtime.insert(backend_session_id.to_string(), new_key);
    }
    match result {
        Ok((true, revision)) => {
            let _ = app_handle.emit("welcome-directories-changed", serde_json::json!({ "revision": revision }));
            None
        }
        Ok((false, _)) => None,
        Err(error) => Some(format!("local directory history save failed: {error}")),
    }
}

/// Probe the local system X server (Xorg / XQuartz / VcXsrv / WSLg) and report
/// whether X11 forwarding has somewhere to display. Drives the X-server status
/// pill and the "install XQuartz/VcXsrv" hints in the UI.
#[tauri::command]
pub fn detect_x_server() -> x11::XServerStatus {
    x11::detect()
}

#[tauri::command]
pub fn open_local_shell_as_administrator(shell: Option<String>) -> Result<(), String> {
    pty::open_shell_as_administrator(shell)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalCreated {
    pub session_id: String,
    /// `LocalShellOption.id` of the shell that was actually launched. Lets the
    /// frontend skip features (e.g. inline history suggestions) that conflict
    /// with shells that already provide them, even when the caller didn't pass
    /// an explicit `shell` arg and we resolved a default.
    pub shell_id: String,
    /// Present when the terminal started successfully but the local-directory
    /// usage record could not be saved. Launch success is never downgraded to
    /// an IPC error for a history write failure (design §4.1.5).
    pub directory_use_warning: Option<String>,
}

/// Register an already-spawned local PTY in the shared terminal runtime and
/// start forwarding its output. SocksCap uses this after it has prepared the
/// rootless capture environment and spawned an interactive TUI command.
#[cfg(target_os = "linux")]
pub(crate) async fn register_local_terminal(
    session_id: String,
    handle: pty::PtyHandle,
    reader: Box<dyn Read + Send>,
    on_output: TerminalOutputChannel,
    state: &AppState,
    app_handle: AppHandle,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let terminal = ActiveTerminal::Local {
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        terminals.insert(session_id.clone(), terminal);
    }
    if let Err(error) = add_terminal_output_channel(&state.terminal_outputs, &session_id, on_output)
    {
        state.terminals.write().await.remove(&session_id);
        return Err(error);
    }

    let sid = session_id;
    let outputs = state.terminal_outputs.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, sid, app_handle, outputs);
    });
    Ok(())
}

/// Single prompt forwarded to the frontend for a keyboard-interactive
/// (MFA/OTP) auth round.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshAuthPromptEntry {
    prompt: String,
    echo: bool,
}

/// Payload for the `ssh-auth-prompt-{session_id}` event. The frontend renders
/// the prompts, collects the user's answers, and replies via
/// `submit_ssh_auth_response` carrying the same `request_id`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshAuthPromptPayload {
    request_id: String,
    name: String,
    instructions: String,
    prompts: Vec<SshAuthPromptEntry>,
}

/// Build a keyboard-interactive prompter that bridges russh's auth loop to the
/// frontend: each round registers a oneshot responder keyed by a fresh request
/// id, emits the prompt event, and awaits the user's answers (or cancellation).
pub(crate) fn build_kbd_prompter(
    app_handle: AppHandle,
    responders: Arc<Mutex<HashMap<String, crate::state::SshAuthResponder>>>,
    session_id: String,
) -> ssh::KbdInteractivePrompter {
    Arc::new(move |req: ssh::KbdInteractiveRequest| {
        let app_handle = app_handle.clone();
        let responders = responders.clone();
        let session_id = session_id.clone();
        Box::pin(async move {
            let request_id = format!("{}:{}", session_id, uuid_like());
            let (tx, rx) = tokio::sync::oneshot::channel();
            {
                let mut guard = match responders.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                guard.insert(request_id.clone(), tx);
            }

            let payload = SshAuthPromptPayload {
                request_id: request_id.clone(),
                name: req.name,
                instructions: req.instructions,
                prompts: req
                    .prompts
                    .into_iter()
                    .map(|p| SshAuthPromptEntry {
                        prompt: p.prompt,
                        echo: p.echo,
                    })
                    .collect(),
            };

            if app_handle
                .emit(&format!("ssh-auth-prompt-{}", session_id), payload)
                .is_err()
            {
                // No listener / window gone — clean up and cancel.
                if let Ok(mut guard) = responders.lock() {
                    guard.remove(&request_id);
                }
                return None;
            }

            // Wait for the user's answer. A dropped sender (window closed,
            // session torn down) resolves to `Err` → treated as cancellation.
            match rx.await {
                Ok(answers) => answers,
                Err(_) => {
                    if let Ok(mut guard) = responders.lock() {
                        guard.remove(&request_id);
                    }
                    None
                }
            }
        }) as Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>>
    })
}

/// Small unique-ish token for correlating auth prompt rounds. Avoids pulling in
/// a uuid dependency for what is only an internal, short-lived correlation id.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

#[tauri::command]
pub async fn create_local_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    workspace_root: Option<String>,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<LocalTerminalCreated, String> {
    validate_session_id(&session_id)?;
    let sdk_environment = if let Some(root) = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|root| !root.is_empty())
    {
        let root_path = std::path::Path::new(root);
        let scope_path = cwd
            .as_deref()
            .map(std::path::Path::new)
            .unwrap_or(root_path);
        match state.sdk.resolve_environment(root_path, scope_path).await {
            Ok(environment) => Some(environment),
            Err(error) => {
                log::warn!(
                    "failed to resolve workspace terminal SDK environment for {root}: {error}"
                );
                None
            }
        }
    } else {
        None
    };
    let (handle, reader, shell_id) = pty::create_pty_with_environment(
        cols,
        rows,
        shell,
        shell_args,
        cwd.clone(),
        sdk_environment.as_ref(),
    )?;

    let terminal = ActiveTerminal::Local {
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        terminals.insert(session_id.clone(), terminal);
    }
    add_terminal_output_channel(&state.terminal_outputs, &session_id, on_output)?;

    let sid = session_id.clone();
    let app = app_handle.clone();
    let outputs = state.terminal_outputs.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, sid, app, outputs);
    });

    let directory_use_warning =
        record_successful_local_start(&state, &app_handle, &session_id, cwd.as_deref());

    Ok(LocalTerminalCreated {
        session_id,
        shell_id,
        directory_use_warning,
    })
}

#[tauri::command]
pub async fn create_command_terminal(
    session_id: String,
    kind: String,
    host: String,
    port: u16,
    username: Option<String>,
    options_json: Option<String>,
    cols: u16,
    rows: u16,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    validate_session_id(&session_id)?;
    {
        let terminals = state.terminals.read().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
    }

    let launch = client::build_client_terminal_launch(
        &kind,
        &host,
        port,
        username.as_deref(),
        options_json.as_deref(),
    )?;
    let (handle, reader) = pty::create_command_pty(cols, rows, &launch.program, &launch.args)?;

    let terminal = ActiveTerminal::Local {
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        terminals.insert(session_id.clone(), terminal);
    }
    add_terminal_output_channel(&state.terminal_outputs, &session_id, on_output)?;

    let sid = session_id.clone();
    let app = app_handle.clone();
    let outputs = state.terminal_outputs.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, sid, app, outputs);
    });

    Ok(session_id)
}

/// Resolve SSH jump-host credentials into the manual `jump_*` fields of
/// `network`, so [`ssh::build_ssh_transport`] has a self-contained config.
///
/// - Session mode (`jump_session_id` set): look the jump session up in the
///   sessions DB, copy host/port/user/auth, and resolve its saved password
///   (`passwordRef` in options_json) or key path. A vault-locked password
///   surfaces as `VAULT_LOCKED`.
/// - Manual mode: just resolve a `vault:` reference in `jump_password`.
///
/// No-op when the session does not use a jump host.
pub(crate) fn resolve_jump_credentials(
    state: &State<'_, AppState>,
    network: &mut network::NetworkSettings,
) -> Result<(), String> {
    if !network.uses_jump_host() {
        return Ok(());
    }

    if !network.jump_session_id.trim().is_empty() {
        let jump = {
            let db = state
                .db
                .lock()
                .map_err(|_| "session database is unavailable".to_string())?;
            crate::session::db::get_session(&db, &network.jump_session_id)
                .map_err(|e| format!("jump session not found: {}", e))?
        };
        if jump.session_type != crate::session::models::SessionType::SSH {
            return Err("selected jump session is not an SSH session".into());
        }
        network.jump_host = jump.host.clone();
        network.jump_port = jump.port;
        network.jump_user = jump.username.clone().unwrap_or_default();
        match &jump.auth_method {
            crate::session::models::AuthMethod::PrivateKey { key_path } => {
                network.jump_auth_kind = "PrivateKey".into();
                network.jump_key_path = key_path.clone();
            }
            _ => {
                network.jump_auth_kind = "Password".into();
                // Saved SSH sessions stash the password as a `vault:` ref under
                // `passwordRef` in options_json; manual auth has none.
                let pass_ref = serde_json::from_str::<serde_json::Value>(&jump.options_json)
                    .ok()
                    .and_then(|v| {
                        v.get("passwordRef")
                            .and_then(|r| r.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();
                if !pass_ref.is_empty() {
                    network.jump_password = pass_ref;
                }
            }
        }
    }

    // Resolve any `vault:` reference in the (manual or session-derived)
    // password into plaintext.
    network.resolve_jump_secret(&state.vault)?;
    Ok(())
}

/// If `proxy_session_id` is set on the network settings, load the saved Proxy
/// session from the DB and override the proxy_kind/host/port/user/pass fields.
pub(crate) fn resolve_proxy_session(
    state: &State<'_, AppState>,
    network: &mut network::NetworkSettings,
) -> Result<(), String> {
    let id = network.proxy_session_id.trim();
    if id.is_empty() {
        return Ok(());
    }

    let proxy_session = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::session::db::get_session(&db, id)
            .map_err(|e| format!("proxy session not found: {}", e))?
    };

    // Read proxyKind from options_json
    let proxy_kind = serde_json::from_str::<serde_json::Value>(&proxy_session.options_json)
        .ok()
        .and_then(|v| {
            v.get("proxyKind")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "http".to_string());

    network.proxy_kind = proxy_kind;
    network.proxy_host = proxy_session.host.clone();
    network.proxy_port = proxy_session.port;
    network.proxy_user = proxy_session.username.clone().unwrap_or_default();

    // Read password from vault ref in options_json
    let pass_ref = serde_json::from_str::<serde_json::Value>(&proxy_session.options_json)
        .ok()
        .and_then(|v| {
            v.get("passwordRef")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    network.proxy_pass = pass_ref;

    Ok(())
}

#[tauri::command]
pub async fn create_ssh_terminal(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    cols: u16,
    rows: u16,
    network_settings_json: Option<String>,
    x11: Option<bool>,
    x11_trusted: Option<bool>,
    startup_command: Option<String>,
    keep_open_after_startup_command: Option<bool>,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    validate_session_id(&session_id)?;
    {
        let terminals = state.terminals.read().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
    }

    let auth = match auth_method.as_str() {
        "Password" => {
            let raw = auth_data.unwrap_or_default();
            let resolved = state.vault.resolve(&raw)?;
            ssh::SshAuth::Password(resolved.map(|z| (*z).clone()).unwrap_or(raw))
        }
        "PrivateKey" => {
            ssh::SshAuth::PrivateKey(auth_data.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string()))
        }
        "Agent" => ssh::SshAuth::Agent,
        _ => {
            let raw = auth_data.unwrap_or_default();
            let resolved = state.vault.resolve(&raw)?;
            ssh::SshAuth::Password(resolved.map(|z| (*z).clone()).unwrap_or(raw))
        }
    };

    let network = network::NetworkSettings::from_json(network_settings_json.as_deref());
    let network = match network {
        Some(mut n) => {
            resolve_proxy_session(&state, &mut n)?;
            n.resolve_proxy_pass(&state.vault)?;
            resolve_jump_credentials(&state, &mut n)?;
            Some(n)
        }
        None => None,
    };

    // Keyboard-interactive (MFA/OTP) prompter: bridges the SSH auth loop to
    // the frontend so a second factor can be entered mid-connect. Cleaned up
    // below once connect resolves (success or error).
    let prompter = build_kbd_prompter(
        app_handle.clone(),
        state.ssh_auth_responders.clone(),
        session_id.clone(),
    );

    // X11 forwarding: resolve the local X server + cookie if the session has
    // X11 enabled. Resolution failure (no local display) is non-fatal — we log
    // and connect without forwarding so the terminal still works.
    let x11_forward = if x11.unwrap_or(false) {
        match x11::resolve(None) {
            Ok(display) => {
                let trusted = x11_trusted.unwrap_or(true);
                Some(Arc::new(x11_forward::XForward::new(
                    Arc::new(display),
                    trusted,
                )))
            }
            Err(e) => {
                tracing::warn!(
                    "X11 enabled but no local display ({}); connecting without forwarding",
                    e
                );
                None
            }
        }
    } else {
        None
    };

    let startup_command = startup_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .map(|command| ssh::SshStartupCommand {
            command: command.to_string(),
            keep_open: keep_open_after_startup_command.unwrap_or(false),
        });

    let connect_result = ssh::connect_ssh(
        &host,
        port,
        &username,
        auth,
        cols,
        rows,
        network.as_ref(),
        Some(&prompter),
        x11_forward,
        startup_command.as_ref(),
    )
    .await;
    // Drop any responder left dangling for this session (e.g. auth failed
    // while a prompt round was still registered) so the map doesn't leak.
    clear_session_auth_responders(&state.ssh_auth_responders, &session_id);
    let (handle, channel, mut output_rx) = connect_result?;

    let handle_arc = Arc::new(handle);

    // Start any session-attached local port forwards. We capture the join
    // handles so `close_terminal` can abort them and release the bound
    // TCP listening ports.
    let forward_handles = if let Some(n) = &network {
        if !n.local_forwards.is_empty() {
            forwards::spawn_local_forwards(
                handle_arc.clone(),
                &n.local_forwards,
                app_handle.clone(),
                session_id.clone(),
            )
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let terminal = ActiveTerminal::Ssh {
        channel: Arc::new(AsyncMutex::new(channel)),
        handle: handle_arc,
        forwards: AsyncMutex::new(forward_handles),
    };

    {
        let mut terminals = state.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        terminals.insert(session_id.clone(), terminal);
    }

    add_terminal_output_channel(&state.terminal_outputs, &session_id, on_output)?;

    let sid = session_id.clone();
    let app = app_handle.clone();
    let terminals = state.terminals.clone();
    let outputs = state.terminal_outputs.clone();
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            send_terminal_output(&outputs, &sid, data);
        }
        // SSH session ended naturally (peer closed, network drop, exit).
        // Remove the terminal entry and abort any session-attached
        // forward listeners so their bound TCP ports are released and
        // the in-flight bridge tasks (owned by per-listener JoinSets)
        // are torn down. This mirrors what `close_terminal` does on an
        // explicit user close, so forwards always end with the SSH
        // session — never outlive it.
        let removed = {
            let mut map = terminals.write().await;
            map.remove(&sid)
        };
        if let Some(ActiveTerminal::Ssh { forwards, .. }) = removed {
            let mut tasks = forwards.lock().await;
            for h in tasks.drain(..) {
                h.abort();
            }
        }
        if let Ok(mut outputs) = outputs.lock() {
            outputs.remove(&sid);
        }
        let _ = app.emit(&format!("terminal-exit-{}", sid), "closed");
    });

    Ok(session_id)
}

fn read_loop_local(
    mut reader: Box<dyn Read + Send>,
    session_id: String,
    app: AppHandle,
    outputs: TerminalOutputSubscribers,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                send_terminal_output(&outputs, &session_id, buf[..n].to_vec());
            }
            Err(_) => break,
        }
    }
    if let Ok(mut outputs) = outputs.lock() {
        outputs.remove(&session_id);
    }
    let _ = app.emit(&format!("terminal-exit-{}", session_id), "closed");
}

fn add_terminal_output_channel(
    outputs: &TerminalOutputSubscribers,
    session_id: &str,
    on_output: TerminalOutputChannel,
) -> Result<(), String> {
    let mut outputs = outputs
        .lock()
        .map_err(|e| format!("Terminal output lock failed: {}", e))?;
    outputs
        .entry(session_id.to_string())
        .or_default()
        .push(on_output);
    Ok(())
}

fn send_terminal_output(outputs: &TerminalOutputSubscribers, session_id: &str, data: Vec<u8>) {
    let Ok(mut outputs) = outputs.lock() else {
        return;
    };
    let Some(channels) = outputs.get_mut(session_id) else {
        return;
    };
    channels.retain(|channel| channel.send(InvokeResponseBody::Raw(data.clone())).is_ok());
}

#[tauri::command]
pub async fn attach_terminal_output(
    session_id: String,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    {
        let terminals = state.terminals.read().await;
        if !terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} not found", session_id));
        }
    }
    add_terminal_output_channel(&state.terminal_outputs, &session_id, on_output)
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("Terminal session id is required".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn write_terminal(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bytes = B64
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let terminals = state.terminals.read().await;
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { writer, .. } => {
            let mut w = writer.lock().map_err(|e| format!("Lock failed: {}", e))?;
            w.write_all(&bytes)
                .map_err(|e| format!("Write failed: {}", e))?;
            w.flush().map_err(|e| format!("Flush failed: {}", e))?;
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let channel = Arc::clone(channel);
            drop(terminals);
            let ch = channel.lock().await;
            ch.data_bytes(bytes)
                .await
                .map_err(|e| format!("SSH write failed: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminals = state.terminals.read().await;
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { master, .. } => {
            let m = master.lock().map_err(|e| format!("Lock failed: {}", e))?;
            pty::resize_pty(&**m, cols, rows)
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let channel = Arc::clone(channel);
            drop(terminals);
            let ch = channel.lock().await;
            ch.window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|e| format!("SSH resize failed: {}", e))?;
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn send_terminal_signal(
    session_id: String,
    signal: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminals = state.terminals.read().await;
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { child, .. } => send_local_signal(child, &signal),
        ActiveTerminal::Ssh { channel, .. } => {
            let sig = ssh_signal_from_name(&signal)?;
            let channel = Arc::clone(channel);
            drop(terminals);
            let ch = channel.lock().await;
            ch.signal(sig)
                .await
                .map_err(|e| format!("SSH signal failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn close_terminal(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let removed = {
        let mut terminals = state.terminals.write().await;
        terminals.remove(&session_id)
    };
    if let Some(ActiveTerminal::Ssh { forwards, .. }) = removed {
        // Abort listener tasks so the local TCP ports are released
        // before the SSH handle drops.
        let mut tasks = forwards.lock().await;
        for h in tasks.drain(..) {
            h.abort();
        }
    }
    if let Ok(mut outputs) = state.terminal_outputs.lock() {
        outputs.remove(&session_id);
    }
    // A closed terminal can never accept late cwd reports; drop its
    // per-runtime dedup entry (design §4.1.5).
    if let Ok(mut runtime) = state.local_directory_runtime.lock() {
        runtime.remove(&session_id);
    }
    Ok(())
}

#[cfg(unix)]
fn send_local_signal(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    signal: &str,
) -> Result<(), String> {
    let sig = match signal {
        "SIGINT" => libc::SIGINT,
        "SIGTERM" => libc::SIGTERM,
        "SIGKILL" => libc::SIGKILL,
        "SIGQUIT" => libc::SIGQUIT,
        "SIGHUP" => libc::SIGHUP,
        _ => return Err(format!("Unsupported local signal {}", signal)),
    };
    let child = child.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let pid = child
        .process_id()
        .ok_or_else(|| "Local terminal process id is unavailable".to_string())?;
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!(
            "Local signal {} failed: {}",
            signal,
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
fn send_local_signal(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    signal: &str,
) -> Result<(), String> {
    match signal {
        "SIGTERM" | "SIGKILL" => {
            let mut child = child.lock().map_err(|e| format!("Lock failed: {}", e))?;
            child
                .kill()
                .map_err(|e| format!("Local kill failed: {}", e))
        }
        _ => Err(format!(
            "Local signal {} is not supported on this platform",
            signal
        )),
    }
}

fn ssh_signal_from_name(signal: &str) -> Result<Sig, String> {
    match signal {
        "SIGINT" => Ok(Sig::INT),
        "SIGTERM" => Ok(Sig::TERM),
        "SIGKILL" => Ok(Sig::KILL),
        "SIGQUIT" => Ok(Sig::QUIT),
        "SIGHUP" => Ok(Sig::HUP),
        _ => Err(format!("Unsupported SSH signal {}", signal)),
    }
}

#[tauri::command]
pub async fn test_ssh_connection(
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    network_settings_json: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let auth = match auth_method.as_str() {
        "Password" => {
            let raw = auth_data.unwrap_or_default();
            let resolved = state.vault.resolve(&raw)?;
            ssh::SshAuth::Password(resolved.map(|z| (*z).clone()).unwrap_or(raw))
        }
        "PrivateKey" => {
            ssh::SshAuth::PrivateKey(auth_data.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string()))
        }
        "Agent" => ssh::SshAuth::Agent,
        _ => {
            let raw = auth_data.unwrap_or_default();
            let resolved = state.vault.resolve(&raw)?;
            ssh::SshAuth::Password(resolved.map(|z| (*z).clone()).unwrap_or(raw))
        }
    };

    let network = network::NetworkSettings::from_json(network_settings_json.as_deref());
    let network = match network {
        Some(mut n) => {
            resolve_proxy_session(&state, &mut n)?;
            n.resolve_proxy_pass(&state.vault)?;
            resolve_jump_credentials(&state, &mut n)?;
            Some(n)
        }
        None => None,
    };

    let start = std::time::Instant::now();
    let (handle, channel, _rx) = ssh::connect_ssh(
        &host,
        port,
        &username,
        auth,
        80,
        24,
        network.as_ref(),
        None,
        None,
        None,
    )
    .await?;
    let elapsed = start.elapsed();

    // Close the test connection
    drop(channel);
    drop(handle);

    Ok(format!(
        "Connection successful ({:.0}ms)",
        elapsed.as_millis()
    ))
}

/// Test proxy connectivity by establishing a TCP connection through the proxy
/// to a user-specified test target (default: www.google.com:443). Returns timing on
/// success or an error message on failure.
#[tauri::command]
pub async fn test_proxy_connection(
    proxy_kind: String,
    proxy_host: String,
    proxy_port: u16,
    proxy_user: String,
    proxy_pass: String,
    test_host: String,
    test_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let resolved_pass = state
        .vault
        .resolve(&proxy_pass)?
        .map(|z| (*z).clone())
        .unwrap_or(proxy_pass);

    let ns = network::NetworkSettings {
        proxy_kind,
        proxy_host,
        proxy_port,
        proxy_user,
        proxy_pass: resolved_pass,
        ..Default::default()
    };

    let start = std::time::Instant::now();
    let stream = network::establish_transport(&test_host, test_port, Some(&ns)).await?;
    drop(stream);
    let elapsed = start.elapsed();

    Ok(format!("OK ({:.0}ms)", elapsed.as_millis()))
}

/// Deliver the user's answer to a pending keyboard-interactive (MFA/OTP) auth
/// round. `responses` is `None` when the user cancelled the prompt, which
/// aborts the in-flight connection. Returns `Ok(())` even when the request id
/// is unknown (the round may have already timed out or the session torn down),
/// so the frontend never has to special-case a benign race.
#[tauri::command]
pub fn submit_ssh_auth_response(
    request_id: String,
    responses: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let responder = {
        let mut guard = state
            .ssh_auth_responders
            .lock()
            .map_err(|_| "auth responder registry poisoned".to_string())?;
        guard.remove(&request_id)
    };
    if let Some(tx) = responder {
        // The receiver may have been dropped if connect was cancelled in the
        // meantime; ignore the send error in that case.
        let _ = tx.send(responses);
    }
    Ok(())
}

/// Drop every pending auth responder belonging to `session_id`. Called once a
/// connection attempt settles so stale rounds (which key by `session_id:<nanos>`)
/// don't accumulate. Dropping the sender resolves the waiting auth future to
/// cancellation if it somehow outlives this.
pub(crate) fn clear_session_auth_responders(
    responders: &Arc<Mutex<HashMap<String, crate::state::SshAuthResponder>>>,
    session_id: &str,
) {
    let prefix = format!("{}:", session_id);
    if let Ok(mut guard) = responders.lock() {
        guard.retain(|key, _| !key.starts_with(&prefix));
    }
}
