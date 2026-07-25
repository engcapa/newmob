//! SocksCap — OS-level TCP traffic routing through HTTP / SOCKS5 / SSH.
//!
//! - Rules / policy / GFWList / egress dialers (all platforms)
//! - Windows capture: elevated `sockscap-helper` + WinDivert
//!   FLOW (PID) + NETWORK (IPv4 TCP NAT → local relay → policy → upstream)
//! - Linux capture: nftables OUTPUT redirect + cgroup v2 + loopback relay
//! - macOS capture: not yet (capabilities report unavailable)

pub mod capture;
pub mod config;
pub mod core;
pub mod dns_win;
pub mod egress;
pub mod flow;
pub mod helper;
pub mod orchestrator;
pub mod paths;
pub mod policy;
pub mod process;
pub mod recovery;
pub mod relay;
pub mod rules;
pub mod stats;

pub use config::{Decision, RuleMode, SocksCapConfig};
pub use orchestrator::{Orchestrator, SocksCapStatus};
pub use policy::{PolicyEngine, PolicyInput};
pub use rules::GfwListMeta;
pub use stats::DomainRecord;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

use crate::state::AppState;

/* ---------------------------- runtime handle ---------------------------- */

/// Shared SocksCap runtime living on [`AppState`].
pub struct SocksCapRuntime {
    pub orch: Arc<RwLock<Orchestrator>>,
    pub helper: Arc<helper::HelperRegistry>,
    /// xray-core sidecar pool for core-backed upstreams. Initialized during
    /// `setup()` once the `AppHandle` (resource dir / app data dir) is available
    /// via [`init_xray_manager`]; `None` until then.
    pub xray: std::sync::OnceLock<Arc<core::XrayManager>>,
}

impl SocksCapRuntime {
    pub fn new() -> Self {
        Self {
            orch: Arc::new(RwLock::new(Orchestrator::new())),
            helper: Arc::new(helper::HelperRegistry::new()),
            xray: std::sync::OnceLock::new(),
        }
    }

    /// The xray manager, if it has been initialized.
    pub fn xray(&self) -> Option<&Arc<core::XrayManager>> {
        self.xray.get()
    }
}

/// Resolve the xray binary + work dir and install the [`core::XrayManager`] on
/// the runtime. Idempotent (later calls are ignored by the `OnceLock`). Called
/// from `setup()`; logs whether the binary was found so a missing provisioning
/// step is visible without blocking startup.
pub fn init_xray_manager(app: &AppHandle, state: &AppState) {
    let exe = paths::resolve_xray_exe(app);
    match &exe {
        Some(p) => tracing::info!("sockscap: xray-core found at {}", p.display()),
        None => tracing::info!(
            "sockscap: xray-core binary not provisioned (core-backed upstreams unavailable; run scripts/fetch-xray.ps1)"
        ),
    }
    let work_dir = data_dir(app)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("xray");
    let mgr = Arc::new(core::XrayManager::new(exe, work_dir));
    let _ = state.sockscap.xray.set(mgr);
}

impl Default for SocksCapRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("sockscap");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create sockscap dir: {e}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("config.json"))
}

fn rules_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("rules");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create rules dir: {e}"))?;
    Ok(dir)
}

/* ---------------------------- capabilities ------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapCapabilities {
    pub platform: String,
    pub global_tcp: bool,
    pub app_filter: bool,
    pub capture_backend: String,
    pub notes: Vec<String>,
    pub privileged_required: bool,
}

#[tauri::command]
pub async fn sockscap_capabilities() -> Result<SocksCapCapabilities, String> {
    Ok(capture::capabilities())
}

/* ---------------------------- config ------------------------------------ */

#[tauri::command]
pub async fn sockscap_get_config(app: AppHandle) -> Result<SocksCapConfig, String> {
    let path = config_path(&app)?;
    Ok(SocksCapConfig::load(&path))
}

#[tauri::command]
pub async fn sockscap_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SocksCapConfig,
) -> Result<(), String> {
    config.validate()?;
    let path = config_path(&app)?;
    config.save(&path)?;
    let mut orch = state.sockscap.orch.write().await;
    orch.apply_config(config.clone());
    // Hot-reload into running relay without restarting capture.
    let rules = orch.rules().map(|r| r.clone());
    orch.hot_reload_policy(config, rules).await;
    Ok(())
}

/* ---------------------------- rules ------------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwListStatus {
    pub loaded: bool,
    pub rule_count: usize,
    pub skipped: usize,
    pub last_refresh: Option<String>,
    pub source: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn sockscap_gfwlist_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GfwListStatus, String> {
    let orch = state.sockscap.orch.read().await;
    if let Some(meta) = orch.gfwlist_meta() {
        return Ok(GfwListStatus {
            loaded: true,
            rule_count: meta.rule_count,
            skipped: meta.skipped,
            last_refresh: meta.last_refresh.clone(),
            source: meta.source.clone(),
            error: None,
        });
    }
    // Fall back to disk meta if engine has not loaded yet.
    let meta_path = rules_dir(&app)?.join("gfwlist.meta.json");
    match GfwListMeta::load(&meta_path) {
        Some(m) => Ok(GfwListStatus {
            loaded: true,
            rule_count: m.rule_count,
            skipped: m.skipped,
            last_refresh: m.last_refresh,
            source: m.source,
            error: None,
        }),
        None => Ok(GfwListStatus {
            loaded: false,
            rule_count: 0,
            skipped: 0,
            last_refresh: None,
            source: String::new(),
            error: None,
        }),
    }
}

#[tauri::command]
pub async fn sockscap_refresh_gfwlist(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
) -> Result<GfwListStatus, String> {
    let cfg_path = config_path(&app)?;
    let mut cfg = SocksCapConfig::load(&cfg_path);
    let fetch_url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| cfg.gfwlist.url.clone());
    if !fetch_url.trim().is_empty() {
        cfg.gfwlist.url = fetch_url.clone();
    }

    let dir = rules_dir(&app)?;
    let result = rules::source::refresh_from_url(&fetch_url, &dir).await;
    match result {
        Ok(compiled) => {
            let meta = compiled.meta.clone();
            cfg.save(&cfg_path)?;
            let mut orch = state.sockscap.orch.write().await;
            orch.apply_config(cfg.clone());
            orch.set_rules(compiled.clone());
            orch.hot_reload_policy(cfg, Some(compiled)).await;
            Ok(GfwListStatus {
                loaded: true,
                rule_count: meta.rule_count,
                skipped: meta.skipped,
                last_refresh: meta.last_refresh,
                source: meta.source,
                error: None,
            })
        }
        Err(e) => {
            // Keep previous rules if any; surface error for UI.
            let orch = state.sockscap.orch.read().await;
            if let Some(meta) = orch.gfwlist_meta() {
                Ok(GfwListStatus {
                    loaded: true,
                    rule_count: meta.rule_count,
                    skipped: meta.skipped,
                    last_refresh: meta.last_refresh.clone(),
                    source: meta.source.clone(),
                    error: Some(format!("refresh failed (kept cache): {e}")),
                })
            } else {
                Ok(GfwListStatus {
                    loaded: false,
                    rule_count: 0,
                    skipped: 0,
                    last_refresh: None,
                    source: fetch_url,
                    error: Some(e),
                })
            }
        }
    }
}

#[tauri::command]
pub async fn sockscap_import_rules(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<GfwListStatus, String> {
    let dir = rules_dir(&app)?;
    let compiled = rules::source::import_from_path(std::path::Path::new(&path), &dir)?;
    let meta = compiled.meta.clone();
    let mut orch = state.sockscap.orch.write().await;
    orch.set_rules(compiled.clone());
    if let Some(cfg) = orch.config().cloned() {
        orch.hot_reload_policy(cfg, Some(compiled)).await;
    }
    Ok(GfwListStatus {
        loaded: true,
        rule_count: meta.rule_count,
        skipped: meta.skipped,
        last_refresh: meta.last_refresh,
        source: meta.source,
        error: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetTestResult {
    pub host: String,
    pub port: u16,
    pub decision: Decision,
    pub reason: String,
    pub matched_rule: Option<String>,
}

#[tauri::command]
pub async fn sockscap_test_target(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
) -> Result<TargetTestResult, String> {
    let port = port.unwrap_or(443);
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("host is empty".into());
    }

    // Ensure rules are loaded into the orchestrator for dry-run.
    {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            let dir = rules_dir(&app)?;
            if let Some(c) = rules::source::load_cached(&dir) {
                orch.set_rules(c);
            }
        }
        if orch.config().is_none() {
            let cfg = SocksCapConfig::load(&config_path(&app)?);
            orch.apply_config(cfg);
        }
    }

    let orch = state.sockscap.orch.read().await;
    let cfg = orch
        .config()
        .cloned()
        .unwrap_or_else(SocksCapConfig::default);
    let engine = PolicyEngine::from_config(&cfg, orch.rules());
    let input = PolicyInput {
        host: Some(host.clone()),
        ip: host.parse().ok(),
        port,
        process_path: None,
        pid: None,
    };
    let trace = engine.decide(&input);
    Ok(TargetTestResult {
        host,
        port,
        decision: trace.decision,
        reason: trace.reason,
        matched_rule: trace.matched_rule,
    })
}

/* ---------------------------- lifecycle --------------------------------- */

#[tauri::command]
pub async fn sockscap_status(state: State<'_, AppState>) -> Result<SocksCapStatus, String> {
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

#[tauri::command]
pub async fn sockscap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    sudo_password: Option<String>,
) -> Result<SocksCapStatus, String> {
    #[cfg(not(target_os = "linux"))]
    let _ = sudo_password;

    let cfg_path = config_path(&app)?;
    let cfg = SocksCapConfig::load(&cfg_path);
    cfg.validate()?;

    let dir = rules_dir(&app)?;
    {
        let mut orch = state.sockscap.orch.write().await;
        if matches!(
            orch.status().phase,
            orchestrator::EnginePhase::RecoveryRequired
        ) {
            return Err("sockscap recovery is required before starting again".into());
        }
        if orch.is_running() {
            return Err("sockscap already running".into());
        }
        orch.apply_config(cfg.clone());
        orch.set_preparing("starting");
    }

    // GFWList mode: require rules (cache or fresh fetch) before capture.
    let mut gfw_start_note = String::new();
    if matches!(cfg.rule_mode, RuleMode::GfwList) {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            if let Some(c) = rules::source::load_cached(&dir) {
                gfw_start_note = format!(
                    "using cached GFWList ({} rules)",
                    c.meta.rule_count
                );
                orch.set_rules(c);
            } else if !cfg.gfwlist.url.trim().is_empty() {
                let url = cfg.gfwlist.url.clone();
                drop(orch);
                match rules::source::refresh_from_url(&url, &dir).await {
                    Ok(compiled) => {
                        gfw_start_note = format!(
                            "downloaded GFWList ({} rules)",
                            compiled.meta.rule_count
                        );
                        state.sockscap.orch.write().await.set_rules(compiled);
                    }
                    Err(e) => {
                        let mut orch = state.sockscap.orch.write().await;
                        orch.set_start_failed(format!("GFWList required but not loaded: {e}"));
                        return Err(format!(
                            "GFWList mode needs a ruleset. Refresh GFWList or import a file first. ({e})"
                        ));
                    }
                }
            } else {
                orch.set_start_failed("GFWList URL empty and no cache");
                return Err(
                    "GFWList mode needs a ruleset. Set a URL and refresh, or import a local file."
                        .to_string(),
                );
            }
        } else if let Some(m) = orch.gfwlist_meta() {
            gfw_start_note = format!("GFWList ready ({} rules)", m.rule_count);
        }
    }

    if !gfw_start_note.is_empty() {
        tracing::info!("sockscap: {gfw_start_note}");
    }

    let caps = capture::capabilities();
    let journal_path = data_dir(&app)?.join("recovery.json");

    #[cfg(windows)]
    let status: Result<SocksCapStatus, String> =
        start_windows_capture(&app, &state, &cfg, &caps).await;

    #[cfg(target_os = "linux")]
    let status: Result<SocksCapStatus, String> =
        start_linux_capture(&state, &cfg, &caps, sudo_password).await;

    #[cfg(all(not(windows), not(target_os = "linux")))]
    let status: Result<SocksCapStatus, String> = {
        let mut orch = state.sockscap.orch.write().await;
        orch.apply_config(cfg.clone());
        let _ = orch.start_stub(&caps);
        Ok(orch.status())
    };

    let journal_result = match &status {
        Ok(st) => {
            let helper_port = state
                .sockscap
                .helper
                .inner
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|s| s.port));
            let relay_port = state.sockscap.orch.read().await.relay_port();
            recovery::write_journal(
                &journal_path,
                &recovery::RecoveryJournal {
                    platform: caps.platform.clone(),
                    capture_backend: st.capture_backend.clone(),
                    config_hash: cfg.content_hash(),
                    pid: std::process::id(),
                    clean: false,
                    relay_port,
                    helper_port,
                },
            )
        }
        Err(e) => {
            let mut orch = state.sockscap.orch.write().await;
            orch.set_start_failed(e.clone());
            Ok(())
        }
    };

    if let Err(journal_error) = journal_result {
        // A live capture without a dirty journal cannot be recovered after a
        // crash. Tear it down before reporting the failed Start; preserve a
        // RecoveryRequired phase if that teardown itself cannot complete.
        let teardown_error = full_teardown(&app, &state, false).await.err();
        let teardown_failed = teardown_error.is_some();
        let message = match teardown_error {
            Some(teardown_error) => format!(
                "write SocksCap recovery journal failed: {journal_error}; teardown also failed: {teardown_error}"
            ),
            None => format!(
                "write SocksCap recovery journal failed; capture was stopped: {journal_error}"
            ),
        };
        if !teardown_failed {
            state
                .sockscap
                .orch
                .write()
                .await
                .set_start_failed(message.clone());
        }
        return Err(message);
    }

    status
}

/// Extract the `passwordRef` a saved Proxy / SSH session keeps in its
/// `options_json`. `SessionConfig` has no password column of its own — the
/// secret is stored as a `vault:<id>` reference under `options_json.passwordRef`
/// (see `terminal::resolve_proxy_session`). Returns `None` when absent/blank.
fn session_password_ref(options_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(options_json)
        .ok()
        .and_then(|v| {
            v.get("passwordRef")
                .and_then(|r| r.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.trim().is_empty())
}

/// Resolve a saved session's stored proxy/SSH password to plaintext.
///
/// Mirrors `NetworkSettings::resolve_proxy_pass`: a `vault:<id>` reference is
/// decrypted through the vault; a non-reference value is treated as a literal
/// password (backwards compat). Returns `None` when the session carries no
/// `passwordRef` — callers then keep any password already resolved from the
/// upstream's own `password_ref`. Vault errors (e.g. locked) are swallowed to
/// match the sibling `password_ref` resolution and the UI's unlock gate.
fn session_proxy_password(
    vault: &crate::vault::Vault,
    session: &crate::session::models::SessionConfig,
) -> Option<String> {
    let pass_ref = session_password_ref(&session.options_json)?;
    match vault.resolve(&pass_ref) {
        Ok(Some(plain)) => Some((*plain).clone()),
        Ok(None) => Some(pass_ref),
        Err(_) => None,
    }
}

/// Resolve the SSH auth to use for a saved SSH session bound as an upstream.
///
/// PrivateKey sessions store a key **file path** in `auth_method` (a DB column),
/// while Password sessions keep the secret as a `vault:<id>` reference in
/// `options_json.passwordRef`. Mirrors `terminal::create_ssh_terminal` /
/// `terminal::resolve_jump_credentials`; without this a key-based SSH upstream
/// would silently fall through to the agent. Falls back to the SSH agent when
/// neither a key path nor a password is available.
fn session_ssh_auth(
    vault: &crate::vault::Vault,
    session: &crate::session::models::SessionConfig,
) -> crate::terminal::ssh::SshAuth {
    use crate::session::models::AuthMethod;
    use crate::terminal::ssh::SshAuth;
    match &session.auth_method {
        AuthMethod::PrivateKey { key_path } if !key_path.trim().is_empty() => {
            SshAuth::PrivateKey(key_path.clone())
        }
        AuthMethod::Agent => SshAuth::Agent,
        // Password / None / keyless PrivateKey: use the stored password if any.
        _ => match session_proxy_password(vault, session) {
            Some(pass) if !pass.is_empty() => SshAuth::Password(pass),
            _ => SshAuth::Agent,
        },
    }
}

/// Resolve a `vault:<id>` reference to plaintext, treating a non-reference value
/// as a literal (backwards compat, matching [`session_proxy_password`]). Blank
/// refs and vault errors (e.g. locked) yield an empty string.
fn resolve_secret_ref(vault: &crate::vault::Vault, reference: &str) -> String {
    let reference = reference.trim();
    if reference.is_empty() {
        return String::new();
    }
    match vault.resolve(reference) {
        Ok(Some(plain)) => (*plain).clone(),
        Ok(None) => reference.to_string(),
        Err(_) => String::new(),
    }
}

/// Build a [`core::ResolvedCoreUpstream`] for a core-backed upstream, decrypting
/// every `vault:<id>` secret to plaintext for the (short-lived) xray config.
/// `host`/`port` are the node address the xray outbound dials.
fn build_core_spec(
    vault: &crate::vault::Vault,
    kind: config::UpstreamKind,
    host: String,
    port: u16,
    up: &config::UpstreamRef,
) -> core::ResolvedCoreUpstream {
    core::ResolvedCoreUpstream {
        kind,
        host,
        port,
        secret: resolve_secret_ref(vault, &up.password_ref),
        uuid: resolve_secret_ref(vault, &up.params.uuid_ref),
        private_key: resolve_secret_ref(vault, &up.params.private_key_ref),
        pre_shared_key: resolve_secret_ref(vault, &up.params.pre_shared_key_ref),
        params: up.params.clone(),
    }
}

/// Ensure a core is running for a core-backed upstream and return its local
/// SOCKS port. Non-core kinds return None immediately. Failures are logged and
/// return None (the relay then emits a clear per-flow error) so one bad profile
/// does not abort the whole capture start — mirrors the per-profile SSH policy.
async fn ensure_core_port(
    state: &State<'_, AppState>,
    profile_key: &str,
    kind: config::UpstreamKind,
    host: &str,
    port: u16,
    up: &config::UpstreamRef,
) -> Option<u16> {
    if !kind.requires_core() {
        return None;
    }
    let mgr = state.sockscap.xray()?;
    let spec = build_core_spec(&state.vault, kind, host.to_string(), port, up);
    match mgr.ensure(profile_key, &spec).await {
        Ok(local_port) => Some(local_port),
        Err(e) => {
            tracing::warn!("sockscap: xray core for '{profile_key}' ({}) failed: {e}", kind.as_tag());
            None
        }
    }
}

/// Synthetic manager key for the global (non-profile) upstream's core.
const GLOBAL_CORE_KEY: &str = "__global__";

#[cfg(target_os = "linux")]
async fn build_linux_relay_context(
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
) -> Result<Arc<RwLock<relay::RelayContext>>, String> {
    let (mut upstream_host, mut upstream_port, mut upstream_user, mut upstream_pass) =
        relay::upstream_from_config(cfg);
    if !cfg.upstream.password_ref.is_empty() {
        if let Ok(Some(password)) = state.vault.resolve(&cfg.upstream.password_ref) {
            upstream_pass = (*password).clone();
        }
    }
    let mut upstream_session: Option<crate::session::models::SessionConfig> = None;
    if !cfg.upstream.session_id.is_empty() {
        let session = {
            let db = state.db.lock().ok();
            db.and_then(|db| {
                crate::session::db::get_session(&db, &cfg.upstream.session_id).ok()
            })
        };
        if let Some(session) = session {
            upstream_host = session.host.clone();
            upstream_port = session.port;
            if let Some(username) = session.username.clone().filter(|u| !u.is_empty()) {
                upstream_user = username;
            }
            // Session credentials live in the vault, not the upstream's own
            // `password_ref`; without this a session-backed SOCKS5/HTTP proxy
            // that needs auth would dial with an empty password.
            if let Some(pass) = session_proxy_password(&state.vault, &session) {
                upstream_pass = pass;
            }
            upstream_session = Some(session);
        }
    }

    let ssh_pool = if matches!(cfg.upstream.kind, config::UpstreamKind::Ssh) {
        use crate::sockscap::egress::ssh_pool::SshPool;
        use crate::terminal::ssh::SshAuth;

        // A bound SSH session carries its own auth (key path in `auth_method`,
        // or a vault password); manual upstreams fall back to the old rules.
        let auth = if let Some(sess) = &upstream_session {
            session_ssh_auth(&state.vault, sess)
        } else if !upstream_pass.is_empty() {
            SshAuth::Password(upstream_pass.clone())
        } else if cfg.upstream.password_ref.starts_with("key:") {
            SshAuth::PrivateKey(cfg.upstream.password_ref.clone())
        } else {
            SshAuth::Agent
        };
        Some(Arc::new(
            SshPool::connect(&upstream_host, upstream_port, &upstream_user, auth)
                .await
                .map_err(|error| format!("SSH upstream connect failed: {error}"))?,
        ))
    } else {
        None
    };

    let mut profile_upstreams = std::collections::HashMap::new();
    for profile in cfg.active_profiles() {
        let (mut host, mut port, mut user, mut password) =
            relay::upstream_from_config_ref(&profile.upstream);
        let mut profile_session: Option<crate::session::models::SessionConfig> = None;
        if host.is_empty() {
            host = upstream_host.clone();
            port = upstream_port;
            user = upstream_user.clone();
            password = upstream_pass.clone();
            // Inherit the global upstream's SSH auth (e.g. key-based session).
            profile_session = upstream_session.clone();
        } else {
            if !profile.upstream.password_ref.is_empty() {
                if let Ok(Some(resolved)) = state.vault.resolve(&profile.upstream.password_ref) {
                    password = (*resolved).clone();
                }
            }
            if !profile.upstream.session_id.is_empty() {
                let session = {
                    let db = state.db.lock().ok();
                    db.and_then(|db| {
                        crate::session::db::get_session(&db, &profile.upstream.session_id).ok()
                    })
                };
                if let Some(session) = session {
                    host = session.host.clone();
                    port = session.port;
                    if let Some(username) =
                        session.username.clone().filter(|u| !u.is_empty())
                    {
                        user = username;
                    }
                    if let Some(pass) = session_proxy_password(&state.vault, &session) {
                        password = pass;
                    }
                    profile_session = Some(session);
                }
            }
        }
        let profile_ssh_pool = if matches!(profile.upstream.kind, config::UpstreamKind::Ssh) {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;

            let auth = if let Some(sess) = &profile_session {
                session_ssh_auth(&state.vault, sess)
            } else if !password.is_empty() {
                SshAuth::Password(password.clone())
            } else if profile.upstream.password_ref.starts_with("key:") {
                SshAuth::PrivateKey(profile.upstream.password_ref.clone())
            } else {
                SshAuth::Agent
            };
            Some(Arc::new(
                SshPool::connect(&host, port, &user, auth)
                    .await
                    .map_err(|error| {
                        format!(
                            "Profile '{}' SSH upstream connect failed: {error}",
                            profile.name
                        )
                    })?,
            ))
        } else {
            None
        };
        // Core-backed profile: spawn/reuse an xray sidecar. NOTE: on Linux the
        // capture backend is cgroup-based; ensuring the xray child is excluded
        // from the taomni cgroup (so its node connection is not re-captured) is
        // a Linux-capture follow-up. Windows (PID bypass) is the phase-1 target.
        let profile_xray_port = ensure_core_port(
            state,
            &profile.id,
            profile.upstream.kind,
            &host,
            port,
            &profile.upstream,
        )
        .await;

        profile_upstreams.insert(
            profile.id.clone(),
            relay::ResolvedUpstream {
                kind: profile.upstream.kind,
                host,
                port,
                user,
                pass: password,
                ssh_pool: profile_ssh_pool,
                xray_port: profile_xray_port,
            },
        );
    }

    let (stats, domains, rules) = {
        let orch = state.sockscap.orch.read().await;
        (
            Arc::clone(&orch.stats),
            Arc::clone(&orch.domains),
            orch.rules().cloned(),
        )
    };
    let dns_map = Arc::new(std::sync::Mutex::new(rules::dns_map::DnsMap::new(
        8192,
        std::time::Duration::from_secs(300),
    )));

    // Optional global xray core (when the global upstream is core-backed).
    let global_xray_port = ensure_core_port(
        state,
        GLOBAL_CORE_KEY,
        cfg.upstream.kind,
        &upstream_host,
        upstream_port,
        &cfg.upstream,
    )
    .await;

    Ok(Arc::new(RwLock::new(relay::RelayContext {
        config: cfg.clone(),
        rules,
        helper: Arc::clone(&state.sockscap.helper),
        stats,
        upstream_host,
        upstream_port,
        upstream_user,
        upstream_pass,
        self_pid: std::process::id(),
        ssh_pool,
        xray_port: global_xray_port,
        profile_upstreams,
        dns_map,
        domains,
    })))
}

#[cfg(target_os = "linux")]
async fn start_linux_capture(
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
    sudo_password: Option<String>,
) -> Result<SocksCapStatus, String> {
    use crate::sockscap::capture::linux::{LinuxCapture, LinuxCaptureImpl};

    let ctx = build_linux_relay_context(state, cfg).await?;
    let backend = LinuxCaptureImpl;
    let capture = backend.start(cfg, Arc::clone(&ctx), sudo_password).await?;
    let relay_port = capture.relay_port();

    let mut orch = state.sockscap.orch.write().await;
    let gfw_note = orch
        .gfwlist_meta()
        .map(|meta| format!(", gfw={}", meta.rule_count))
        .unwrap_or_default();
    let active_profiles = cfg.active_profiles();
    let app_watch_note = if active_profiles
        .iter()
        .all(|profile| matches!(profile.mode, config::ScopeMode::Apps))
    {
        let application_count = active_profiles
            .iter()
            .map(|profile| profile.apps.len())
            .sum::<usize>();
        format!(", watching {application_count} application selector(s)")
    } else {
        String::new()
    };
    orch.relay_ctx = Some(ctx);
    orch.set_linux_capture(capture);
    orch.set_active(
        &caps.capture_backend,
        format!("capture active (Linux nft+cgroup relay :{relay_port}{gfw_note}{app_watch_note})"),
    );
    Ok(orch.status())
}

#[cfg(windows)]
async fn start_windows_capture(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
) -> Result<SocksCapStatus, String> {
    use crate::sockscap::config::ScopeMode;
    use crate::sockscap::helper::{CaptureStartArgs, capture_start, ensure_helper};
    use crate::sockscap::relay::{self, RelayContext};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    // 1) Elevated helper (UAC).
    let helper_st = ensure_helper(app, state).await?;
    if !helper_st.running {
        return Err(helper_st.message);
    }

    // 2) Resolve upstream credentials (manual fields; vault password_ref).
    let (mut up_host, mut up_port, mut up_user, mut up_pass) =
        relay::upstream_from_config(cfg);
    if !cfg.upstream.password_ref.is_empty() {
        if let Ok(Some(p)) = state.vault.resolve(&cfg.upstream.password_ref) {
            up_pass = (*p).clone();
        }
    }
    // Session-backed upstream: load host/port/user/password from the sessions
    // DB + vault when set. The password comes from the session's vault ref, not
    // the upstream's own `password_ref`.
    let mut up_session: Option<crate::session::models::SessionConfig> = None;
    if !cfg.upstream.session_id.is_empty() {
        let sess = {
            let db = state.db.lock().ok();
            db.and_then(|db| {
                crate::session::db::get_session(&db, &cfg.upstream.session_id).ok()
            })
        };
        if let Some(sess) = sess {
            up_host = sess.host.clone();
            up_port = sess.port;
            if let Some(u) = sess.username.clone().filter(|u| !u.is_empty()) {
                up_user = u;
            }
            if let Some(pass) = session_proxy_password(&state.vault, &sess) {
                up_pass = pass;
            }
            up_session = Some(sess);
        }
    }

    let active_profs = cfg.active_profiles();
    let mut profile_upstreams = std::collections::HashMap::new();
    for p in &active_profs {
        let (mut phost, mut pport, mut puser, mut ppass) =
            relay::upstream_from_config_ref(&p.upstream);
        let mut p_session: Option<crate::session::models::SessionConfig> = None;
        if phost.is_empty() {
            phost = up_host.clone();
            pport = up_port;
            puser = up_user.clone();
            ppass = up_pass.clone();
            // Inherit the global upstream's SSH auth (e.g. key-based session).
            p_session = up_session.clone();
        } else {
            if !p.upstream.password_ref.is_empty() {
                if let Ok(Some(pass)) = state.vault.resolve(&p.upstream.password_ref) {
                    ppass = (*pass).clone();
                }
            }
            if !p.upstream.session_id.is_empty() {
                let sess = {
                    let db = state.db.lock().ok();
                    db.and_then(|db| {
                        crate::session::db::get_session(&db, &p.upstream.session_id).ok()
                    })
                };
                if let Some(sess) = sess {
                    phost = sess.host.clone();
                    pport = sess.port;
                    if let Some(u) = sess.username.clone().filter(|u| !u.is_empty()) {
                        puser = u;
                    }
                    if let Some(pass) = session_proxy_password(&state.vault, &sess) {
                        ppass = pass;
                    }
                    p_session = Some(sess);
                }
            }
        }

        let p_ssh_pool = if matches!(p.upstream.kind, crate::sockscap::config::UpstreamKind::Ssh) {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;
            let auth = if let Some(sess) = &p_session {
                session_ssh_auth(&state.vault, sess)
            } else if !ppass.is_empty() {
                SshAuth::Password(ppass.clone())
            } else if !p.upstream.password_ref.is_empty() && p.upstream.password_ref.starts_with("key:") {
                SshAuth::PrivateKey(p.upstream.password_ref.clone())
            } else {
                SshAuth::Agent
            };
            match SshPool::connect(&phost, pport, &puser, auth).await {
                Ok(pool) => Some(Arc::new(pool)),
                Err(e) => {
                    tracing::warn!("Profile '{}' SSH upstream connect failed: {e}", p.name);
                    None
                }
            }
        } else {
            None
        };

        // Core-backed profile: spawn/reuse an xray sidecar and record its
        // local SOCKS port for the relay to dial.
        let p_xray_port =
            ensure_core_port(state, &p.id, p.upstream.kind, &phost, pport, &p.upstream).await;

        profile_upstreams.insert(
            p.id.clone(),
            relay::ResolvedUpstream {
                kind: p.upstream.kind,
                host: phost,
                port: pport,
                user: puser,
                pass: ppass,
                ssh_pool: p_ssh_pool,
                xray_port: p_xray_port,
            },
        );
    }

    // Optional global xray core (when the global upstream is core-backed).
    let global_xray_port = ensure_core_port(
        state,
        GLOBAL_CORE_KEY,
        cfg.upstream.kind,
        &up_host,
        up_port,
        &cfg.upstream,
    )
    .await;

    // Optional SSH pool for capture-path PROXY via direct-tcpip.
    let ssh_pool = if matches!(cfg.upstream.kind, crate::sockscap::config::UpstreamKind::Ssh)
    {
        use crate::sockscap::egress::ssh_pool::SshPool;
        use crate::terminal::ssh::SshAuth;
        let auth = if let Some(sess) = &up_session {
            session_ssh_auth(&state.vault, sess)
        } else if !up_pass.is_empty() {
            SshAuth::Password(up_pass.clone())
        } else if !cfg.upstream.password_ref.is_empty()
            && cfg.upstream.password_ref.starts_with("key:")
        {
            // Convention unused; private key path stored in password_ref rare.
            SshAuth::PrivateKey(cfg.upstream.password_ref.clone())
        } else {
            // Prefer agent when no password.
            SshAuth::Agent
        };
        match SshPool::connect(&up_host, up_port, &up_user, auth).await {
            Ok(p) => Some(Arc::new(p)),
            Err(e) => {
                return Err(format!("SSH upstream connect failed: {e}"));
            }
        }
    } else {
        None
    };

    let (stats, domains) = {
        let orch = state.sockscap.orch.read().await;
        (Arc::clone(&orch.stats), Arc::clone(&orch.domains))
    };
    let rules = {
        let orch = state.sockscap.orch.read().await;
        orch.rules().map(|r| r.clone())
    };
    let dns_map = Arc::new(std::sync::Mutex::new(
        crate::sockscap::rules::dns_map::DnsMap::new(8192, std::time::Duration::from_secs(300)),
    ));
    // Seed from Windows DNS client cache (no admin).
    crate::sockscap::dns_win::refresh_dns_client_cache(&dns_map);

    let ctx = Arc::new(RwLock::new(RelayContext {
        config: cfg.clone(),
        rules,
        helper: Arc::clone(&state.sockscap.helper),
        stats,
        upstream_host: up_host.clone(),
        upstream_port: up_port,
        upstream_user: up_user,
        upstream_pass: up_pass,
        self_pid: std::process::id(),
        ssh_pool,
        xray_port: global_xray_port,
        profile_upstreams,
        dns_map: Arc::clone(&dns_map),
        domains,
    }));
    let relay_handle = relay::start_relay(Arc::clone(&ctx)).await?;

    // Periodic DNS cache refresh while capture runs (stopped via orch.dns_stop).
    let dns_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _dns_task = crate::sockscap::dns_win::spawn_dns_cache_refresher(
        dns_map,
        Arc::clone(&dns_stop),
        std::time::Duration::from_secs(60),
    );

    // 3) Tell helper to start FLOW+NETWORK capture → NAT to relay.
    let mode_apps = !active_profs.is_empty()
        && active_profs
            .iter()
            .all(|p| matches!(p.mode, ScopeMode::Apps));

    let mut app_paths: Vec<String> = Vec::new();
    for p in &active_profs {
        if matches!(p.mode, ScopeMode::Apps) {
            for a in &p.apps {
                let norm = paths::normalize_exe_path(&a.path);
                if !norm.is_empty() && !app_paths.contains(&norm) {
                    app_paths.push(norm);
                }
            }
        }
    }

    let mut bypass_pids = vec![std::process::id()];
    if let Some(pid) = helper_st.pid {
        bypass_pids.push(pid);
    }
    // Bypass every xray core: its own connection to the remote node must not be
    // re-captured (that would loop node traffic back into the relay). Robust for
    // domain nodes / multi-IP resolution where endpoint bypass alone can miss.
    if let Some(mgr) = state.sockscap.xray() {
        for pid in mgr.pids().await {
            bypass_pids.push(pid);
        }
    }
    let mut bypass_endpoints = Vec::new();
    if !up_host.is_empty() && up_port > 0 {
        bypass_endpoints.push((up_host, up_port));
    }
    // Relay listens on 0.0.0.0 / :: (streamdump reflection). Bypass those endpoints
    // so we never re-capture the proxy's own accept path as a new flow.
    bypass_endpoints.push(("127.0.0.1".into(), relay_handle.port));
    bypass_endpoints.push(("::1".into(), relay_handle.port));
    bypass_endpoints.push(("0.0.0.0".into(), relay_handle.port));

    let args = CaptureStartArgs {
        mode_apps,
        app_paths,
        bypass_cidrs: cfg.bypass_cidrs.clone(),
        bypass_pids,
        bypass_endpoints,
        // Unused for streamdump reflection dest (kept for helper JSON compat).
        relay_ip: "0.0.0.0".into(),
        relay_port: relay_handle.port,
    };

    if args.mode_apps && args.app_paths.is_empty() {
        dns_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        relay_handle.stop().await;
        return Err("App mode requires at least one application path".into());
    }

    let capture_result = {
        let guard = state
            .sockscap
            .helper
            .inner
            .lock()
            .map_err(|e| e.to_string())?;
        let sess = guard
            .as_ref()
            .ok_or_else(|| "helper session lost".to_string())?;
        capture_start(sess, &args)
    };

    match capture_result {
        Ok(info) => {
            let mut orch = state.sockscap.orch.write().await;
            orch.relay = Some(relay_handle);
            orch.relay_ctx = Some(ctx);
            orch.dns_stop = Some(dns_stop);
            let gfw_note = orch
                .gfwlist_meta()
                .map(|m| format!(", gfw={}", m.rule_count))
                .unwrap_or_default();
            orch.set_active(
                &caps.capture_backend,
                format!(
                    "capture active (relay :{}, elevated=true{gfw_note})",
                    args.relay_port
                ),
            );
            tracing::info!("sockscap capture started: {info}");
            Ok(orch.status())
        }
        Err(e) => {
            dns_stop.store(true, std::sync::atomic::Ordering::SeqCst);
            relay_handle.stop().await;
            let mut orch = state.sockscap.orch.write().await;
            orch.set_start_failed(format!("helper/capture failed: {e}"));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn sockscap_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapStatus, String> {
    full_teardown(&app, &state, true).await?;
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

#[tauri::command]
pub async fn sockscap_recover(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Even if stopping the active session was incomplete, recovery gets one
    // more independent chance to remove the platform-owned state.
    let teardown_error = full_teardown(&app, &state, false).await.err();
    match capture::recover_system().await {
        Ok(()) => {
            state.sockscap.orch.write().await.force_idle();
            if let Ok(dir) = data_dir(&app) {
                let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
            }
            if let Some(error) = teardown_error {
                tracing::info!("sockscap: Recover repaired incomplete teardown: {error}");
            }
            Ok(())
        }
        Err(recovery_error) => {
            let message = match teardown_error {
                Some(teardown_error) => {
                    format!("teardown failed: {teardown_error}; recovery failed: {recovery_error}")
                }
                None => format!("recovery failed: {recovery_error}"),
            };
            let backend = capture::capabilities().capture_backend;
            state
                .sockscap
                .orch
                .write()
                .await
                .set_recovery_required(&backend, message.clone());
            Err(message)
        }
    }
}

/// Thorough capture teardown:
/// 1) Stop WinDivert NETWORK capture in the elevated helper (with timeout)
/// 2) Stop local relay accept loops (IPv4+IPv6 wake + abort fallback)
/// 3) Stop DNS refresher and clear relay context. The caller decides whether
///    it is safe to clear the recovery journal.
///
/// Does **not** kill the elevated helper process (avoids another UAC on next Start).
async fn full_teardown(
    app: &AppHandle,
    state: &State<'_, AppState>,
    clear_journal: bool,
) -> Result<(), String> {
    use std::time::Duration;

    #[cfg(target_os = "linux")]
    let mut errors = Vec::new();
    #[cfg(not(target_os = "linux"))]
    let errors: Vec<String> = Vec::new();

    // --- 1) Helper capture_stop (blocking RPC) off the async runtime ----------
    let sess = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());
    if let Some(sess) = sess {
        let stop_rpc = tokio::task::spawn_blocking(move || helper::capture_stop(&sess));
        match tokio::time::timeout(Duration::from_secs(4), stop_rpc).await {
            Ok(Ok(Ok(()))) => {
                tracing::info!("sockscap: helper capture_stop ok");
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!("sockscap: helper capture_stop error: {e}");
            }
            Ok(Err(e)) => {
                tracing::warn!("sockscap: helper capture_stop join error: {e}");
            }
            Err(_) => {
                tracing::warn!(
                    "sockscap: helper capture_stop timed out after 4s (WinDivert threads may still be exiting)"
                );
            }
        }
    }

    // --- 2) Linux removes nft rules + restores cgroups before its relay stops -
    #[cfg(target_os = "linux")]
    {
        let linux_capture = {
            let mut orch = state.sockscap.orch.write().await;
            orch.take_linux_capture_for_stop()
        };
        if let Some(capture) = linux_capture {
            if let Err(error) = capture.stop().await {
                tracing::warn!("sockscap: Linux capture teardown error: {error}");
                errors.push(format!("Linux capture teardown failed: {error}"));
            }
        }
    }

    // --- 3) Take any platform relay without holding write lock during await --
    let relay = {
        let mut orch = state.sockscap.orch.write().await;
        orch.take_relay_for_stop()
    };
    if let Some(relay) = relay {
        // Internal: dual-stack wake + 800ms abort fallback.
        relay.stop().await;
    }

    // --- 3b) Stop all xray cores (all platforms). Their node connections are
    //         now unnecessary; leaving them would leak processes on Stop.
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all().await;
    }

    // --- 4) Finish engine state + DNS + journal ------------------------------
    {
        let mut orch = state.sockscap.orch.write().await;
        orch.finish_stop();
        if !errors.is_empty() {
            orch.set_recovery_required("nft-cgroup-redirect", errors.join("; "));
        }
    }
    if errors.is_empty() {
        if clear_journal {
            if let Ok(dir) = data_dir(app) {
                let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
            }
        }
        tracing::info!("sockscap: teardown complete");
        Ok(())
    } else {
        let error = errors.join("; ");
        tracing::warn!("sockscap: teardown incomplete; Recover is required: {error}");
        Err(error)
    }
}

#[tauri::command]
pub async fn sockscap_stats_snapshot(
    state: State<'_, AppState>,
) -> Result<stats::StatsSnapshot, String> {
    let orch = state.sockscap.orch.read().await;
    Ok(orch.stats_snapshot())
}

#[tauri::command]
pub async fn sockscap_list_processes() -> Result<Vec<process::ProcessInfo>, String> {
    process::list_processes()
}

#[tauri::command]
pub async fn sockscap_test_upstream(
    state: State<'_, AppState>,
    kind: String,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    session_id: Option<String>,
    test_host: Option<String>,
    test_port: Option<u16>,
) -> Result<String, String> {
    let target_host = test_host.unwrap_or_else(|| "www.google.com".into());
    let target_port = test_port.unwrap_or(443);
    let mut host = host;
    let mut port = port;
    let mut user = username.unwrap_or_default();
    let mut pass = password.unwrap_or_default();
    // Resolve vault:<id> if the UI passed a password_ref.
    if pass.starts_with("vault:") {
        if let Ok(Some(p)) = state.vault.resolve(&pass) {
            pass = (*p).clone();
        }
    }
    // Session-backed upstream: pull host/port/user/password from the saved
    // session so the Test button matches what a real capture start would dial.
    // The session's own vault ref overrides any manually supplied credentials.
    let mut test_session: Option<crate::session::models::SessionConfig> = None;
    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        let session = {
            let db = state.db.lock().ok();
            db.and_then(|db| crate::session::db::get_session(&db, &sid).ok())
        };
        if let Some(session) = session {
            host = session.host.clone();
            port = session.port;
            if let Some(u) = session.username.clone().filter(|u| !u.is_empty()) {
                user = u;
            }
            if let Some(p) = session_proxy_password(&state.vault, &session) {
                pass = p;
            }
            test_session = Some(session);
        } else {
            return Err(format!("upstream session '{sid}' not found"));
        }
    }

    match kind.as_str() {
        "http" => {
            egress::http_connect::dial(&host, port, &target_host, target_port, &user, &pass).await?;
            Ok(format!(
                "HTTP CONNECT via {}:{} to {}:{} ok",
                host, port, target_host, target_port
            ))
        }
        "socks5" => {
            egress::socks5::dial(&host, port, &target_host, target_port, &user, &pass).await?;
            Ok(format!(
                "SOCKS5 via {}:{} to {}:{} ok",
                host, port, target_host, target_port
            ))
        }
        "ssh" => {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;
            // A bound SSH session carries its own auth (key path or vault
            // password); manual entry only has the typed password.
            let auth = if let Some(sess) = &test_session {
                session_ssh_auth(&state.vault, sess)
            } else if pass.is_empty() {
                SshAuth::Agent
            } else {
                SshAuth::Password(pass)
            };
            let pool = SshPool::connect(&host, port, &user, auth).await?;
            let stream = pool
                .dial(&target_host, target_port, "127.0.0.1", 0)
                .await?;
            // Drop after successful open.
            drop(stream);
            Ok(format!(
                "SSH direct-tcpip via {host}:{port} to {target_host}:{target_port} ok"
            ))
        }
        other => Err(format!("unknown upstream kind: {other}")),
    }
}

/// Parse a single proxy share link (`ss://`/`trojan://`/`vmess://`/`vless://`)
/// into upstream fields the UI can drop into a form. Secrets come back as
/// plaintext for the frontend to store as `vault:<id>` refs.
#[tauri::command]
pub async fn sockscap_parse_share_link(
    link: String,
) -> Result<core::share_link::ParsedShareLink, String> {
    core::share_link::parse(&link)
}

/// Parse a subscription blob (base64 or plain newline-separated links) into a
/// list of upstreams. Unparseable lines are skipped.
#[tauri::command]
pub async fn sockscap_parse_subscription(
    blob: String,
) -> Result<Vec<core::share_link::ParsedShareLink>, String> {
    Ok(core::share_link::parse_subscription(&blob))
}

/// Test a core-backed upstream (shadowsocks/trojan/vmess/vless/wireguard) by
/// spawning a throwaway xray sidecar, dialing a probe target through it, and
/// tearing it down. Secrets in `upstream` (password_ref / uuid_ref / wg key
/// refs) are resolved from the vault, matching a real capture start.
#[tauri::command]
pub async fn sockscap_test_core_upstream(
    state: State<'_, AppState>,
    upstream: config::UpstreamRef,
    test_host: Option<String>,
    test_port: Option<u16>,
) -> Result<String, String> {
    if !upstream.kind.requires_core() {
        return Err(format!(
            "{} is not a core-backed upstream",
            upstream.kind.as_tag()
        ));
    }
    let target_host = test_host.unwrap_or_else(|| "www.google.com".into());
    let target_port = test_port.unwrap_or(443);
    if upstream.host.trim().is_empty() || upstream.port == 0 {
        return Err("upstream host and port are required".into());
    }

    let mgr = state
        .sockscap
        .xray()
        .ok_or_else(|| "xray manager not initialized".to_string())?;
    if !mgr.has_exe() {
        return Err("xray-core binary not provisioned; run scripts/fetch-xray.ps1".into());
    }

    let spec = build_core_spec(
        &state.vault,
        upstream.kind,
        upstream.host.clone(),
        upstream.port,
        &upstream,
    );
    // Unique throwaway key so a concurrent Test never collides with a live
    // profile's core or another Test in flight.
    let key = format!(
        "__test_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let local_port = mgr.ensure(&key, &spec).await?;
    let result =
        egress::socks5::dial("127.0.0.1", local_port, &target_host, target_port, "", "").await;
    mgr.remove(&key).await;
    result.map(|_| {
        format!(
            "{} via {}:{} to {target_host}:{target_port} ok",
            upstream.kind.as_tag(),
            upstream.host,
            upstream.port
        )
    })
}

/// App-exit hook (blocking): cleanly stop the elevated helper's WinDivert
/// capture and shut the helper down, then clear the recovery journal. Called
/// from the Tauri `RunEvent::Exit` handler so a normal quit does not leave an
/// elevated helper + loaded WinDivert driver behind. The helper's own
/// parent-death watchdog is the backstop for crash/kill paths.
///
/// Runs synchronously (no async runtime is guaranteed at exit) and is
/// best-effort: any RPC error is logged, and the journal is only cleared when
/// the helper confirmed capture stopped (so a failure still triggers
/// `boot_repair` on the next launch).
pub fn shutdown_on_exit(app: &AppHandle, state: &AppState) {
    // Kill any xray-core sidecars first (all platforms). Best-effort, sync:
    // start_kill without reaping, since no async runtime is guaranteed at exit.
    // kill_on_drop is the further backstop for a hard crash.
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all_blocking();
    }

    let sess = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());
    let Some(sess) = sess else {
        // No helper (e.g. Linux, or capture never started). Nothing elevated
        // to reap here; leave any dirty journal for boot_repair.
        return;
    };

    let stopped = match helper::capture_stop(&sess) {
        Ok(()) => {
            tracing::info!("sockscap: exit — helper capture_stop ok");
            true
        }
        Err(e) => {
            tracing::warn!("sockscap: exit — helper capture_stop failed: {e}");
            false
        }
    };
    // Ask the helper process to exit so it and the WinDivert driver go away.
    if let Err(e) = helper::send_json(&sess, serde_json::json!({ "cmd": "shutdown" })) {
        tracing::warn!("sockscap: exit — helper shutdown RPC failed: {e}");
    }

    if stopped {
        if let Ok(dir) = data_dir(app) {
            let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
        }
    }
}

/// Boot-time hook: if the previous run left a dirty recovery journal, force
/// platform recover so the OS is not left with half-installed capture rules.
pub async fn boot_repair(app: &AppHandle) {
    let Ok(dir) = data_dir(app) else {
        return;
    };
    let journal_path = recovery::journal_path(&dir);
    if !recovery::needs_repair(&journal_path) {
        return;
    }
    tracing::warn!("sockscap: dirty recovery journal — repairing network state");
    if let Some(j) = recovery::read_journal(&journal_path) {
        tracing::warn!(
            "sockscap: dirty journal pid={} backend={} relay={:?} helper={:?}",
            j.pid,
            j.capture_backend,
            j.relay_port,
            j.helper_port
        );
    }
    // Previous helper cannot be contacted without its token; platform recover
    // + clear journal so the next Start opens a fresh elevated helper.
    if let Err(e) = capture::recover_system().await {
        // Leave the journal dirty so a later boot retries instead of falsely
        // declaring potentially-live nftables/cgroup state recovered.
        tracing::warn!("sockscap: boot recover failed; leaving journal dirty: {e}");
        return;
    }
    let _ = recovery::mark_clean_and_clear(&journal_path);
    tracing::info!("sockscap: recovery complete");
}

#[tauri::command]
pub async fn sockscap_get_domain_records(
    state: State<'_, AppState>,
) -> Result<Vec<DomainRecord>, String> {
    let orch = state.sockscap.orch.read().await;
    let guard = orch.domains.lock().map_err(|e| e.to_string())?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn sockscap_clear_domain_records(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let orch = state.sockscap.orch.read().await;
    let mut guard = orch.domains.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{session_password_ref, session_proxy_password, session_ssh_auth};
    use crate::session::models::{AuthMethod, SessionConfig, SessionType};
    use crate::terminal::ssh::SshAuth;
    use crate::vault::Vault;

    fn proxy_session(options_json: &str) -> SessionConfig {
        SessionConfig {
            id: "proxy-1".into(),
            name: "SOCKS5 upstream".into(),
            session_type: SessionType::Proxy,
            group_path: None,
            host: "10.0.0.9".into(),
            port: 1080,
            username: Some("alice".into()),
            auth_method: AuthMethod::Password,
            options_json: options_json.into(),
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
            sort_order: 0,
        }
    }

    fn fresh_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = Vault::open(&dir.path().join("vault.db")).expect("open vault");
        vault.init("correct-horse-battery-staple").expect("init vault");
        (dir, vault)
    }

    #[test]
    fn password_ref_extracted_from_options_json() {
        assert_eq!(
            session_password_ref(r#"{"proxyKind":"socks5","passwordRef":"vault:abc"}"#),
            Some("vault:abc".to_string())
        );
    }

    #[test]
    fn password_ref_absent_or_blank_is_none() {
        assert_eq!(session_password_ref(r#"{"proxyKind":"socks5"}"#), None);
        assert_eq!(session_password_ref(r#"{"passwordRef":"   "}"#), None);
        assert_eq!(session_password_ref("not json"), None);
    }

    #[test]
    fn session_password_resolves_vault_reference() {
        let (_dir, vault) = fresh_vault();
        let reference = vault
            .put("sockscap-upstream", "alice@proxy", "s3cret")
            .expect("put")
            .reference;
        let options = format!(r#"{{"proxyKind":"socks5","passwordRef":"{reference}"}}"#);
        assert_eq!(
            session_proxy_password(&vault, &proxy_session(&options)),
            Some("s3cret".to_string())
        );
    }

    #[test]
    fn session_without_password_ref_returns_none() {
        let (_dir, vault) = fresh_vault();
        assert_eq!(
            session_proxy_password(&vault, &proxy_session(r#"{"proxyKind":"socks5"}"#)),
            None
        );
    }

    #[test]
    fn non_reference_password_treated_as_literal() {
        // Backwards-compat: a plaintext value in passwordRef is used as-is.
        let (_dir, vault) = fresh_vault();
        assert_eq!(
            session_proxy_password(&vault, &proxy_session(r#"{"passwordRef":"plain-pass"}"#)),
            Some("plain-pass".to_string())
        );
    }

    #[test]
    fn locked_vault_swallows_error_and_returns_none() {
        let (_dir, vault) = fresh_vault();
        let reference = vault
            .put("sockscap-upstream", "alice@proxy", "s3cret")
            .expect("put")
            .reference;
        vault.lock().expect("lock");
        let options = format!(r#"{{"passwordRef":"{reference}"}}"#);
        assert_eq!(session_proxy_password(&vault, &proxy_session(&options)), None);
    }

    fn ssh_session(auth_method: AuthMethod, options_json: &str) -> SessionConfig {
        SessionConfig {
            id: "ssh-1".into(),
            name: "SSH upstream".into(),
            session_type: SessionType::SSH,
            group_path: None,
            host: "bastion.example".into(),
            port: 22,
            username: Some("bob".into()),
            auth_method,
            options_json: options_json.into(),
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
            sort_order: 0,
        }
    }

    #[test]
    fn ssh_private_key_session_uses_key_path() {
        let (_dir, vault) = fresh_vault();
        let session = ssh_session(
            AuthMethod::PrivateKey {
                key_path: "~/.ssh/id_ed25519".into(),
            },
            "{}",
        );
        match session_ssh_auth(&vault, &session) {
            SshAuth::PrivateKey(path) => assert_eq!(path, "~/.ssh/id_ed25519"),
            other => panic!("expected PrivateKey, got {}", auth_label(&other)),
        }
    }

    #[test]
    fn ssh_password_session_resolves_vault_password() {
        let (_dir, vault) = fresh_vault();
        let reference = vault
            .put("ssh-password", "bob@bastion", "hunter2")
            .expect("put")
            .reference;
        let options = format!(r#"{{"passwordRef":"{reference}"}}"#);
        let session = ssh_session(AuthMethod::Password, &options);
        match session_ssh_auth(&vault, &session) {
            SshAuth::Password(p) => assert_eq!(p, "hunter2"),
            other => panic!("expected Password, got {}", auth_label(&other)),
        }
    }

    #[test]
    fn ssh_agent_and_passwordless_sessions_fall_back_to_agent() {
        let (_dir, vault) = fresh_vault();
        assert!(matches!(
            session_ssh_auth(&vault, &ssh_session(AuthMethod::Agent, "{}")),
            SshAuth::Agent
        ));
        // Password auth but no stored secret → agent, not an empty password.
        assert!(matches!(
            session_ssh_auth(&vault, &ssh_session(AuthMethod::Password, "{}")),
            SshAuth::Agent
        ));
        // Keyless PrivateKey (blank path) → agent rather than an empty key path.
        assert!(matches!(
            session_ssh_auth(
                &vault,
                &ssh_session(AuthMethod::PrivateKey { key_path: "  ".into() }, "{}")
            ),
            SshAuth::Agent
        ));
    }

    fn auth_label(auth: &SshAuth) -> &'static str {
        match auth {
            SshAuth::Password(_) => "Password",
            SshAuth::PrivateKey(_) => "PrivateKey",
            SshAuth::Agent => "Agent",
        }
    }
}
