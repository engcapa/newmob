//! Local "Servers" feature backend (MobaXterm-style server management).
//!
//! Manages a fixed set of ten local server types (SSH, FTP, TFTP, HTTP,
//! Telnet, VNC, NFS, Cron, iperf, RDP). Each running server lives in the
//! [`ServerRegistry`] held by `AppState`; the registry tracks the cancel
//! token, the supervising task, an optional auto-stop timer, and the last
//! published [`ServerStatus`].
//!
//! The command layer mirrors `tunnel/mod.rs`: every `#[tauri::command]`
//! returns `Result<_, String>`, status changes go through
//! [`engine::set_status`] (which updates the registry and emits
//! `server://status/<type>`), and `autostart_servers` runs at startup.

pub mod cron;
pub mod db;
pub mod engine;
pub mod ftp;
pub mod http;
pub mod iperf;
pub mod nfs;
pub mod process;
pub mod rdp;
pub mod ssh;
pub mod telnet;
pub mod tftp;
pub mod vnc;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::module_lock::ModuleLock;
use crate::state::AppState;
use engine::{ServerCtx, set_status};

const RDP_PASSWORD_KIND: &str = "rdp-server-password";
const RDP_PASSWORD_LABEL: &str = "RDP server password";

/* ---------------------------- shared DTOs --------------------------- */

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerType {
    Ssh,
    Ftp,
    Tftp,
    Http,
    Telnet,
    Vnc,
    Nfs,
    Cron,
    Iperf,
    Rdp,
}

impl ServerType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServerType::Ssh => "ssh",
            ServerType::Ftp => "ftp",
            ServerType::Tftp => "tftp",
            ServerType::Http => "http",
            ServerType::Telnet => "telnet",
            ServerType::Vnc => "vnc",
            ServerType::Nfs => "nfs",
            ServerType::Cron => "cron",
            ServerType::Iperf => "iperf",
            ServerType::Rdp => "rdp",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "ssh" => Some(ServerType::Ssh),
            "ftp" => Some(ServerType::Ftp),
            "tftp" => Some(ServerType::Tftp),
            "http" => Some(ServerType::Http),
            "telnet" => Some(ServerType::Telnet),
            "vnc" => Some(ServerType::Vnc),
            "nfs" => Some(ServerType::Nfs),
            "cron" => Some(ServerType::Cron),
            "iperf" => Some(ServerType::Iperf),
            "rdp" => Some(ServerType::Rdp),
            _ => None,
        }
    }

    pub fn all() -> [ServerType; 10] {
        [
            ServerType::Ssh,
            ServerType::Ftp,
            ServerType::Tftp,
            ServerType::Http,
            ServerType::Telnet,
            ServerType::Vnc,
            ServerType::Nfs,
            ServerType::Cron,
            ServerType::Iperf,
            ServerType::Rdp,
        ]
    }
}

fn default_bind() -> String {
    "0.0.0.0".to_string()
}

fn default_autostop() -> u64 {
    3600
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(default)]
    pub port: u16,
    #[serde(default = "default_bind")]
    pub bind_address: String,
    #[serde(default)]
    pub auto_stop: bool,
    #[serde(default = "default_autostop")]
    pub auto_stop_seconds: u64,
    #[serde(default)]
    pub start_on_launch: bool,
    /// Server-specific fields (e.g. `rootDir`, `username`). Leaf modules read
    /// these via the typed accessors below.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ServerConfig {
    /// Read a string-valued server-specific field from `extra`.
    // Part of the leaf-facing API surface; placeholder leaves don't use these yet.
    #[allow(dead_code)]
    pub fn str_field<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.extra
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(default)
    }

    /// Read a bool-valued server-specific field from `extra`.
    #[allow(dead_code)]
    pub fn bool_field(&self, key: &str, default: bool) -> bool {
        self.extra
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    }

    /// Read a u64-valued server-specific field from `extra`.
    #[allow(dead_code)]
    pub fn u64_field(&self, key: &str, default: u64) -> u64 {
        self.extra
            .get(key)
            .and_then(|v| v.as_u64())
            .unwrap_or(default)
    }
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ServerRunState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub server_type: ServerType,
    pub status: ServerRunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ServerStatus {
    fn stopped(server_type: ServerType) -> Self {
        Self {
            server_type,
            status: ServerRunState::Stopped,
            pid: None,
            started_at: None,
            error: None,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ---------------------------- runtime registry ---------------------- */

pub struct ActiveServer {
    pub cancel: CancellationToken,
    pub task: JoinHandle<()>,
    pub auto_stop_task: Option<JoinHandle<()>>,
    pub status: ServerStatus,
    _process_lock: ModuleLock,
}

#[derive(Default)]
pub struct ServerRegistry {
    pub running: AsyncMutex<HashMap<ServerType, ActiveServer>>,
    pub statuses: AsyncMutex<HashMap<ServerType, ServerStatus>>,
    pub(crate) rdp_approvals: std::sync::Arc<rdp::ApprovalBroker>,
}

#[tauri::command]
pub async fn resolve_rdp_connection_request(
    state: State<'_, AppState>,
    request_id: String,
    approved: bool,
) -> Result<bool, String> {
    Ok(state.servers.rdp_approvals.resolve(&request_id, approved))
}

impl ServerRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/* ---------------------------- internals ----------------------------- */

/// Tear down a running server: cancel its token, abort its supervisor (and any
/// auto-stop timer), remove it from the registry, and publish `Stopped`.
/// Safe to call when nothing is running (no-op apart from publishing Stopped).
async fn stop_internal(
    app: &AppHandle,
    registry: &ServerRegistry,
    server_type: ServerType,
) -> ServerStatus {
    {
        let mut running = registry.running.lock().await;
        if let Some(active) = running.remove(&server_type) {
            active.cancel.cancel();
            active.task.abort();
            if let Some(t) = active.auto_stop_task {
                t.abort();
            }
        }
    }
    let info = ServerStatus::stopped(server_type);
    set_status(app, registry, info.clone()).await;
    info
}

/// Spawn the auto-stop timer for a freshly started server. After
/// `auto_stop_seconds` it logs `Auto-stopped after Ns`, tears the server down
/// and publishes `Stopped`. Exits early (without stopping) if the server is
/// cancelled first.
fn spawn_auto_stop(
    app: AppHandle,
    registry: std::sync::Arc<ServerRegistry>,
    server_type: ServerType,
    cancel: CancellationToken,
    log: engine::LogEmitter,
    seconds: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(seconds)) => {
                log.line(format!("Auto-stopped after {}s", seconds));
                // Minimal teardown that never aborts this task itself: cancel
                // the server token, abort its supervisor, drop the entry.
                {
                    let mut running = registry.running.lock().await;
                    if let Some(active) = running.remove(&server_type) {
                        active.cancel.cancel();
                        active.task.abort();
                        // active.auto_stop_task is this very task — just drop it.
                    } else {
                        // Already stopped elsewhere; nothing to do.
                        return;
                    }
                }
                set_status(&app, &registry, ServerStatus::stopped(server_type)).await;
            }
            _ = cancel.cancelled() => {
                // Server stopped (manually or on error) before the timer fired.
            }
        }
    })
}

/* ---------------------------- Tauri commands ------------------------ */

#[tauri::command]
pub async fn start_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_type: String,
    config: serde_json::Value,
) -> Result<ServerStatus, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;

    // Ignore duplicate start: return the current status.
    {
        let running = state.servers.running.lock().await;
        if let Some(active) = running.get(&st) {
            return Ok(active.status.clone());
        }
    }

    let mut config: ServerConfig = serde_json::from_value(config)
        .map_err(|e| format!("invalid config for {}: {}", server_type, e))?;
    // There is one persisted configuration per server type. Keep that type
    // exclusive across Taomni processes; different server types may coexist.
    let process_lock = ModuleLock::try_acquire_for_app(
        &app,
        "local-server",
        st.as_str(),
        &format!("{} server", st.as_str()),
    )?;

    // Publish Starting.
    let starting = ServerStatus {
        server_type: st,
        status: ServerRunState::Starting,
        pid: None,
        started_at: None,
        error: None,
    };
    set_status(&app, &state.servers, starting).await;

    if st == ServerType::Rdp {
        if let Err(e) = resolve_rdp_password(&state, &mut config) {
            let info = ServerStatus {
                server_type: st,
                status: ServerRunState::Error,
                pid: None,
                started_at: None,
                error: Some(e.clone()),
            };
            set_status(&app, &state.servers, info).await;
            return Err(e);
        }
    }

    // Dispatch to the leaf. Fallible setup (bind/locate) surfaces here.
    let cancel = CancellationToken::new();
    let ctx = ServerCtx::new(app.clone(), st, cancel.clone());
    let log = ctx.log.clone();
    let started = match engine::start(ctx, config.clone()).await {
        Ok(s) => s,
        Err(e) => {
            cancel.cancel();
            let info = ServerStatus {
                server_type: st,
                status: ServerRunState::Error,
                pid: None,
                started_at: None,
                error: Some(e.clone()),
            };
            set_status(&app, &state.servers, info).await;
            return Err(e);
        }
    };

    let running_status = ServerStatus {
        server_type: st,
        status: ServerRunState::Running,
        pid: started.pid,
        started_at: Some(now_ms()),
        error: None,
    };

    // Optional auto-stop timer.
    let auto_stop_task = if config.auto_stop {
        Some(spawn_auto_stop(
            app.clone(),
            state.servers.clone(),
            st,
            cancel.clone(),
            log,
            config.auto_stop_seconds,
        ))
    } else {
        None
    };

    {
        let mut running = state.servers.running.lock().await;
        running.insert(
            st,
            ActiveServer {
                cancel,
                task: started.task,
                auto_stop_task,
                status: running_status.clone(),
                _process_lock: process_lock,
            },
        );
    }
    set_status(&app, &state.servers, running_status.clone()).await;
    Ok(running_status)
}

#[tauri::command]
pub async fn stop_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_type: String,
) -> Result<ServerStatus, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    Ok(stop_internal(&app, &state.servers, st).await)
}

#[tauri::command]
pub async fn get_server_status(
    state: State<'_, AppState>,
    server_type: String,
) -> Result<ServerStatus, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    let s = state.servers.statuses.lock().await;
    Ok(s.get(&st)
        .cloned()
        .unwrap_or_else(|| ServerStatus::stopped(st)))
}

#[tauri::command]
pub async fn list_server_statuses(state: State<'_, AppState>) -> Result<Vec<ServerStatus>, String> {
    let s = state.servers.statuses.lock().await;
    // Return a status for every known server type so the UI has a complete
    // list even before anything has started.
    let out = ServerType::all()
        .into_iter()
        .map(|st| {
            s.get(&st)
                .cloned()
                .unwrap_or_else(|| ServerStatus::stopped(st))
        })
        .collect();
    Ok(out)
}

/// Probe RDP desktop-capture readiness. On macOS the optional permission
/// request is dispatched to the main thread because the OS owns the consent
/// prompt. Merely opening settings passes `false` and never prompts.
#[tauri::command]
pub async fn probe_rdp_capture(
    app: AppHandle,
    request_permission: bool,
) -> Result<rdp::capture::CaptureProbe, String> {
    #[cfg(target_os = "macos")]
    if request_permission && !rdp::capture::mac::permission_granted() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(rdp::capture::mac::request_permission());
        })
        .map_err(|e| format!("failed to request Screen Recording permission: {e}"))?;
        let _ = rx
            .await
            .map_err(|_| "Screen Recording permission request was cancelled".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, request_permission);

    rdp::capture::probe().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_server_config(
    state: State<'_, AppState>,
    server_type: String,
    mut config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    if st == ServerType::Rdp {
        let legacy_password = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db::load_server_config(&db, st.as_str())
                .map_err(|e| e.to_string())?
                .and_then(|value| rdp_plaintext_password(&value).map(str::to_owned))
        };
        secure_rdp_config(
            state.vault.as_ref(),
            &mut config,
            legacy_password.as_deref(),
        )?;
    }
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::save_server_config(&db, st.as_str(), &json).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn load_server_configs(
    state: State<'_, AppState>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let mut configs = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db::load_server_configs(&db).map_err(|e| e.to_string())?
    };

    if let Some(config) = configs.get_mut(ServerType::Rdp.as_str()) {
        let legacy_password = rdp_plaintext_password(config).map(str::to_owned);
        if legacy_password.is_some() {
            match secure_rdp_config(state.vault.as_ref(), config, legacy_password.as_deref()) {
                Ok(()) => {
                    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    db::save_server_config(&db, ServerType::Rdp.as_str(), &json)
                        .map_err(|e| e.to_string())?;
                }
                Err(e) if e == crate::vault::ERR_VAULT_LOCKED => {
                    redact_legacy_rdp_password(config);
                }
                Err(e) => return Err(e),
            }
        } else {
            redact_rdp_password(config);
        }
    }

    Ok(configs)
}

fn rdp_plaintext_password(config: &serde_json::Value) -> Option<&str> {
    config
        .get("password")
        .and_then(|value| value.as_str())
        .filter(|password| {
            !password.is_empty() && !password.starts_with(crate::vault::VAULT_REF_PREFIX)
        })
}

fn redact_rdp_password(config: &mut serde_json::Value) {
    if let Some(object) = config.as_object_mut() {
        object.remove("password");
    }
}

fn redact_legacy_rdp_password(config: &mut serde_json::Value) {
    if let Some(object) = config.as_object_mut() {
        object.remove("password");
        object.insert(
            "credentialMigrationRequired".to_string(),
            serde_json::Value::Bool(true),
        );
    }
}

/// Move an RDP password out of the general configuration database and into the
/// encrypted credential vault. The returned JSON is safe to persist or send
/// back to the frontend: it contains only a `vault:` reference.
fn secure_rdp_config(
    vault: &crate::vault::Vault,
    config: &mut serde_json::Value,
    legacy_password: Option<&str>,
) -> Result<(), String> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| "invalid RDP server config: expected an object".to_string())?;

    let submitted_password = object
        .remove("password")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|password| !password.is_empty());
    let existing_reference = object
        .get("passwordRef")
        .and_then(|value| value.as_str())
        .filter(|reference| reference.starts_with(crate::vault::VAULT_REF_PREFIX))
        .map(str::to_owned);
    let plaintext = submitted_password
        .as_deref()
        .filter(|password| !password.starts_with(crate::vault::VAULT_REF_PREFIX))
        .or(legacy_password);

    let reference = if let Some(plaintext) = plaintext {
        if let Some(reference) = existing_reference.as_deref() {
            let id = reference
                .strip_prefix(crate::vault::VAULT_REF_PREFIX)
                .ok_or_else(|| "invalid RDP password vault reference".to_string())?;
            vault.update(id, plaintext)?;
            reference.to_string()
        } else {
            vault
                .put(RDP_PASSWORD_KIND, RDP_PASSWORD_LABEL, plaintext)?
                .reference
        }
    } else if let Some(reference) = existing_reference {
        reference
    } else if let Some(reference) = submitted_password
        .as_deref()
        .filter(|password| password.starts_with(crate::vault::VAULT_REF_PREFIX))
    {
        reference.to_string()
    } else {
        return Err(
            "RDP server password is required and must be stored in the credential vault"
                .to_string(),
        );
    };

    object.insert(
        "passwordRef".to_string(),
        serde_json::Value::String(reference),
    );
    object.remove("credentialMigrationRequired");
    Ok(())
}

fn resolve_rdp_password(state: &AppState, config: &mut ServerConfig) -> Result<(), String> {
    let reference = config
        .extra
        .get("passwordRef")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "RDP server password is not stored in the credential vault".to_string())?;
    let password = state
        .vault
        .resolve(reference)?
        .ok_or_else(|| "invalid RDP server password vault reference".to_string())?;
    config.extra.insert(
        "password".to_string(),
        serde_json::Value::String(password.to_string()),
    );
    Ok(())
}

/// Called once at startup to start any servers whose persisted config has
/// `startOnLaunch=true`. Errors are logged but never abort startup; each
/// failure still surfaces via the normal `server://status/<type>` event.
pub async fn autostart_servers(app: AppHandle) {
    let configs = {
        let state: State<AppState> = app.state();
        let db = match state.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::warn!("autostart servers: db lock: {}", e);
                return;
            }
        };
        match db::load_server_configs(&db) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("autostart servers: load: {}", e);
                return;
            }
        }
    };

    for (type_str, value) in configs {
        // Only autostart entries explicitly flagged for it.
        let should = value
            .get("startOnLaunch")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !should {
            continue;
        }
        let state: State<AppState> = app.state();
        if let Err(e) = start_local_server(app.clone(), state, type_str.clone(), value).await {
            tracing::warn!("autostart server {}: {}", type_str, e);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{redact_legacy_rdp_password, secure_rdp_config};
    use crate::vault::Vault;

    #[test]
    fn rdp_password_is_persisted_only_as_a_vault_reference() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(&dir.path().join("vault.db")).unwrap();
        vault.init("test-master-password").unwrap();
        let mut config = json!({
            "username": "alice",
            "password": "first-secret",
            "securityMode": "hybrid"
        });

        secure_rdp_config(&vault, &mut config, None).unwrap();

        assert!(config.get("password").is_none());
        let reference = config["passwordRef"].as_str().unwrap().to_string();
        assert!(reference.starts_with("vault:"));
        assert_eq!(
            vault.resolve(&reference).unwrap().unwrap().as_str(),
            "first-secret"
        );

        config["password"] = json!("replacement-secret");
        secure_rdp_config(&vault, &mut config, None).unwrap();
        assert_eq!(config["passwordRef"].as_str(), Some(reference.as_str()));
        assert_eq!(
            vault.resolve(&reference).unwrap().unwrap().as_str(),
            "replacement-secret"
        );
    }

    #[test]
    fn locked_legacy_config_is_redacted_before_returning_to_ui() {
        let mut config = json!({ "username": "alice", "password": "legacy-secret" });
        redact_legacy_rdp_password(&mut config);
        assert!(config.get("password").is_none());
        assert_eq!(config["credentialMigrationRequired"], true);
    }
}
