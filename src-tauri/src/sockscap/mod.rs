//! SocksCap — OS-level TCP traffic routing through HTTP / SOCKS5 / SSH.
//!
//! - Rules / policy / GFWList / egress dialers (all platforms)
//! - Windows capture: elevated `sockscap-helper` + WinDivert
//!   FLOW (PID) + NETWORK (IPv4 TCP NAT → local relay → policy → upstream)
//! - Linux capture: nftables OUTPUT redirect + cgroup v2 + loopback relay
//! - macOS capture: signed Mitmproxy Redirector → Unix IPC → shared relay
//!   (transparent Global; application identity gate follows on the same engine)

pub mod capture;
pub mod config;
pub mod core;
pub mod dns_win;
pub mod egress;
#[cfg(unix)]
pub mod elevate;
pub mod flow;
pub mod helper;
pub mod ingress;
pub mod listener_pid;
pub mod orchestrator;
pub mod paths;
pub mod policy;
pub mod process;
pub mod recovery;
pub mod redirector;
pub mod relay;
pub mod rules;
pub mod stats;
pub mod tun_detect;

pub use config::{Decision, RuleMode, SocksCapConfig};
pub use orchestrator::{Orchestrator, SocksCapStatus};
pub use policy::{PolicyEngine, PolicyInput};
pub use rules::GfwListMeta;
pub use stats::DomainRecord;

use std::path::PathBuf;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::module_lock::ModuleLock;
use crate::state::AppState;

/* ---------------------------- runtime handle ---------------------------- */

/// Shared SocksCap runtime living on [`AppState`].
pub struct SocksCapRuntime {
    pub orch: Arc<RwLock<Orchestrator>>,
    pub helper: Arc<helper::HelperRegistry>,
    /// Orphaned elevated helper pids that this (unelevated) process could not
    /// terminate. Handed to the next helper launch, which runs under UAC and
    /// can finish the job. See [`boot_repair`].
    pub pending_reap: std::sync::Mutex<Vec<u32>>,
    /// Cross-process ownership of the OS capture stack. SocksCap changes
    /// machine-wide capture state, so only one Taomni process may own it.
    activation_lock: std::sync::Mutex<Option<ModuleLock>>,
    /// macOS starts boot recovery asynchronously. Start remains blocked until
    /// that audit has finished so a user click cannot race a dirty-journal
    /// recovery and replace its inert-only scope with a business scope.
    #[cfg(target_os = "macos")]
    recovery_ready: AtomicBool,
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
            pending_reap: std::sync::Mutex::new(Vec::new()),
            activation_lock: std::sync::Mutex::new(None),
            #[cfg(target_os = "macos")]
            recovery_ready: AtomicBool::new(false),
            xray: std::sync::OnceLock::new(),
        }
    }

    /// The xray manager, if it has been initialized.
    pub fn xray(&self) -> Option<&Arc<core::XrayManager>> {
        self.xray.get()
    }

    fn has_activation_lock(&self) -> bool {
        self.activation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    fn install_activation_lock(&self, lock: ModuleLock) {
        *self
            .activation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(lock);
    }

    fn release_activation_lock(&self) {
        self.activation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    #[cfg(target_os = "macos")]
    fn recovery_ready(&self) -> bool {
        self.recovery_ready.load(Ordering::Acquire)
    }

    #[cfg(target_os = "macos")]
    fn mark_recovery_ready(&self) {
        self.recovery_ready.store(true, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
struct RecoveryReadyGuard<'a>(&'a SocksCapRuntime);

#[cfg(target_os = "macos")]
impl Drop for RecoveryReadyGuard<'_> {
    fn drop(&mut self) {
        self.0.mark_recovery_ready();
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linux: Option<LinuxCaptureCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxCaptureCapabilities {
    pub transparent_available: bool,
    pub launched_application_available: bool,
    pub launch_only: bool,
    pub containerized: bool,
    pub transparent_unavailable_reason: Option<String>,
}

#[tauri::command]
pub async fn sockscap_capabilities(app: AppHandle) -> Result<SocksCapCapabilities, String> {
    Ok(capture::capabilities_for(&app))
}

#[tauri::command]
pub async fn sockscap_redirector_install_status(
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        serde_json::to_value(redirector::installer::status(&app))
            .map_err(|error| format!("serialize Redirector install status: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Mitmproxy Redirector installation is only available on macOS".into())
    }
}

#[tauri::command]
pub async fn sockscap_install_redirector(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let install_app = app.clone();
        let status =
            tokio::task::spawn_blocking(move || redirector::installer::install(&install_app))
                .await
                .map_err(|error| format!("Redirector installer task failed: {error}"))??;
        serde_json::to_value(status)
            .map_err(|error| format!("serialize Redirector install status: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Mitmproxy Redirector installation is only available on macOS".into())
    }
}

/* ---------------------------- config ------------------------------------ */

#[tauri::command]
pub async fn sockscap_get_config(app: AppHandle) -> Result<SocksCapConfig, String> {
    let path = config_path(&app)?;
    Ok(SocksCapConfig::load(&path))
}

/// Resolve and validate a macOS application selector before it is persisted.
/// Other platforms expose the same IPC shape so frontend code stays portable,
/// but reject the command without changing their capture behavior.
#[tauri::command]
pub async fn sockscap_validate_macos_app(
    path: String,
    allow_unsigned: Option<bool>,
) -> Result<config::AppSelector, String> {
    #[cfg(target_os = "macos")]
    {
        redirector::app_identity::validate_application(&path, allow_unsigned.unwrap_or(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, allow_unsigned);
        Err("macOS application validation is only available on macOS".into())
    }
}

#[tauri::command]
pub async fn sockscap_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SocksCapConfig,
) -> Result<(), String> {
    config.validate()?;
    let path = config_path(&app)?;
    let mut orch = state.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    config.save(&path)?;
    orch.apply_config(config);
    Ok(())
}

fn ensure_configuration_unlocked(orch: &Orchestrator) -> Result<(), String> {
    if orch.configuration_locked() {
        Err("SocksCap configuration is locked while capture is running; stop capture before making changes".into())
    } else {
        Ok(())
    }
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
    // Hold the write lock for the complete mutation so Start cannot snapshot
    // the old rules while a refresh is being committed.
    let mut orch = state.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
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
            orch.apply_config(cfg);
            orch.set_rules(compiled);
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
    let mut orch = state.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    let dir = rules_dir(&app)?;
    let compiled = rules::source::import_from_path(std::path::Path::new(&path), &dir)?;
    let meta = compiled.meta.clone();
    orch.set_rules(compiled);
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
    #[cfg(target_os = "macos")]
    let mut orch = state.sockscap.orch.write().await;
    #[cfg(target_os = "macos")]
    orch.refresh_macos_capture_health();
    #[cfg(not(target_os = "macos"))]
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapDiagnostics {
    pub generated_at: u64,
    pub status: SocksCapStatus,
    pub capabilities: SocksCapCapabilities,
    pub stats: stats::StatsSnapshot,
    pub recovery_journal: Option<recovery::RecoveryJournal>,
    pub redirector: Option<serde_json::Value>,
    pub manual_recovery_steps: Vec<String>,
}

#[tauri::command]
pub async fn sockscap_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapDiagnostics, String> {
    #[cfg(target_os = "macos")]
    let mut orch = state.sockscap.orch.write().await;
    #[cfg(target_os = "macos")]
    orch.refresh_macos_capture_health();
    #[cfg(not(target_os = "macos"))]
    let orch = state.sockscap.orch.read().await;

    #[cfg(target_os = "macos")]
    let redirector = orch
        .macos_telemetry()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| format!("serialize Redirector telemetry: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    let redirector = None;

    #[cfg(target_os = "macos")]
    let manual_recovery_steps = vec![
        "Quit Taomni and Mitmproxy Redirector if they are still running.".into(),
        "Open System Settings > Network > VPN & Filters and disable the Mitmproxy Redirector network configuration.".into(),
        "If recovery still fails, open System Settings > General > Login Items & Extensions > Network Extensions and disable Mitmproxy Redirector, then restart macOS.".into(),
        "Reopen Taomni, run Recover, and only start SocksCap after RecoveryRequired clears.".into(),
    ];
    #[cfg(not(target_os = "macos"))]
    let manual_recovery_steps = Vec::new();

    Ok(SocksCapDiagnostics {
        generated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        status: orch.status(),
        capabilities: capture::capabilities_for(&app),
        stats: orch.stats_snapshot(),
        recovery_journal: recovery::read_journal(&recovery::journal_path(&data_dir(&app)?)),
        redirector,
        manual_recovery_steps,
    })
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
    #[cfg(target_os = "macos")]
    let mut cfg = SocksCapConfig::load(&cfg_path);
    #[cfg(not(target_os = "macos"))]
    let cfg = SocksCapConfig::load(&cfg_path);

    #[cfg(target_os = "macos")]
    if redirector::app_identity::revalidate_configuration(&mut cfg)? {
        cfg.save(&cfg_path)
            .map_err(|error| format!("save refreshed macOS application identity: {error}"))?;
    }
    cfg.validate()?;

    #[cfg(target_os = "macos")]
    if !state.sockscap.recovery_ready() {
        return Err(
            "macOS SocksCap startup recovery is still running; wait for it to finish before starting capture"
                .into(),
        );
    }

    // Check the local runtime before attempting to lock again: re-locking the
    // same file from one process has platform-specific semantics.
    {
        let orch = state.sockscap.orch.read().await;
        if matches!(
            orch.status().phase,
            orchestrator::EnginePhase::RecoveryRequired
        ) {
            return Err("sockscap recovery is required before starting again".into());
        }
        if orch.is_running() {
            return Err("sockscap already running".into());
        }
    }

    let activation_lock = ModuleLock::try_acquire_for_app(&app, "sockscap", "global", "SocksCap")?;

    let dir = rules_dir(&app)?;
    {
        let mut orch = state.sockscap.orch.write().await;
        orch.apply_config(cfg.clone());
        orch.set_preparing("starting");
    }

    // GFWList mode: require rules (cache or fresh fetch) before capture.
    let mut gfw_start_note = String::new();
    if cfg.requires_gfwlist() {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            if let Some(c) = rules::source::load_cached(&dir) {
                gfw_start_note = format!("using cached GFWList ({} rules)", c.meta.rule_count);
                orch.set_rules(c);
            } else if !cfg.gfwlist.url.trim().is_empty() {
                let url = cfg.gfwlist.url.clone();
                drop(orch);
                match rules::source::refresh_from_url(&url, &dir).await {
                    Ok(compiled) => {
                        gfw_start_note =
                            format!("downloaded GFWList ({} rules)", compiled.meta.rule_count);
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
        start_linux_capture(&app, &state, &cfg, &caps, sudo_password).await;

    #[cfg(target_os = "macos")]
    let status: Result<SocksCapStatus, String> =
        start_macos_capture(&app, &state, &cfg, &caps, &journal_path).await;

    #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
    let status: Result<SocksCapStatus, String> = {
        let mut orch = state.sockscap.orch.write().await;
        orch.apply_config(cfg.clone());
        let _ = orch.start_stub(&caps);
        Ok(orch.status())
    };

    #[cfg(not(target_os = "macos"))]
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
                    phase: recovery::RecoveryPhase::Active,
                    session_id: uuid::Uuid::new_v4().to_string(),
                    backend_version: None,
                    scope_hash: None,
                    bridge_pid: None,
                    provider_pid: None,
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

    // macOS uses a durable write-ahead journal inside start_macos_capture so no
    // business scope can become active before its recovery record exists.
    #[cfg(target_os = "macos")]
    let journal_result: Result<(), String> = {
        if let Err(error) = &status {
            let mut orch = state.sockscap.orch.write().await;
            if !matches!(
                orch.status().phase,
                orchestrator::EnginePhase::RecoveryRequired
            ) {
                orch.set_start_failed(error.clone());
            }
        }
        Ok(())
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
        } else {
            // Teardown could not prove the machine-wide state is clean. Keep
            // ownership until Recover succeeds or this process exits.
            state.sockscap.install_activation_lock(activation_lock);
        }
        return Err(message);
    }

    if status.is_ok() {
        state.sockscap.install_activation_lock(activation_lock);
    }

    // Start the xray health monitor once capture is up, so a core that crashes
    // mid-session is respawned on its same local port (keeps the relay working).
    // Idempotent; stopped by full_teardown / shutdown_on_exit.
    if status.is_ok() {
        if let Some(mgr) = state.sockscap.xray() {
            if mgr.running_count().await > 0 {
                mgr.start_monitor(std::time::Duration::from_secs(5));
            }
        }
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
            tracing::warn!(
                "sockscap: xray core for '{profile_key}' ({}) failed: {e}",
                kind.as_tag()
            );
            None
        }
    }
}

/// Synthetic manager key for the global (non-profile) upstream's core.
const GLOBAL_CORE_KEY: &str = "__global__";

/// Resolve upstreams (including vault secrets, session-backed hosts, and SSH
/// pools) into a relay context. Shared by the Unix capture backends.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn build_unix_relay_context(
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
            db.and_then(|db| crate::session::db::get_session(&db, &cfg.upstream.session_id).ok())
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
                    if let Some(username) = session.username.clone().filter(|u| !u.is_empty()) {
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

    let engine = relay::RelayContext::build_engine(cfg, rules.as_ref());
    Ok(Arc::new(RwLock::new(relay::RelayContext {
        config: cfg.clone(),
        rules,
        engine,
        helper: Arc::clone(&state.sockscap.helper),
        // Linux recovers the original destination from the redirected socket
        // itself (`SO_ORIGINAL_DST`); there is no privileged helper to ask.
        helper_client: None,
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
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
    sudo_password: Option<String>,
) -> Result<SocksCapStatus, String> {
    use crate::sockscap::capture::linux::{LinuxCapture, LinuxCaptureHandle, LinuxCaptureImpl};

    let ctx = build_unix_relay_context(state, cfg).await?;
    let transparent_available = caps
        .linux
        .as_ref()
        .is_some_and(|linux| linux.transparent_available);
    let capture = if sudo_password.is_some() {
        let backend = LinuxCaptureImpl;
        LinuxCaptureHandle::Transparent(backend.start(cfg, Arc::clone(&ctx), sudo_password).await?)
    } else if transparent_available {
        let backend = LinuxCaptureImpl;
        match backend.start(cfg, Arc::clone(&ctx), None).await {
            Ok(capture) => LinuxCaptureHandle::Transparent(capture),
            Err(error) if caps.privileged_required => return Err(error),
            Err(error) => {
                tracing::warn!(
                    "Linux transparent capture became unavailable after preflight; falling back to launch-only capture: {error}"
                );
                start_linux_launched_capture(app, Arc::clone(&ctx)).await?
            }
        }
    } else {
        start_linux_launched_capture(app, Arc::clone(&ctx)).await?
    };
    let relay_port = capture.relay_port();
    let launch_only = capture.is_launch_only();

    let mut orch = state.sockscap.orch.write().await;
    let gfw_note = orch
        .gfwlist_meta()
        .map(|meta| format!(", gfw={}", meta.rule_count))
        .unwrap_or_default();
    let active_profiles = cfg.active_profiles();
    let application_count = active_profiles
        .iter()
        .filter(|profile| matches!(profile.mode, config::ScopeMode::Apps))
        .map(|profile| profile.apps.len())
        .sum::<usize>();
    let app_watch_note = if launch_only {
        ", waiting for an application to be launched from SocksCap".to_string()
    } else if application_count > 0 {
        format!(", watching {application_count} application selector(s)")
    } else {
        String::new()
    };
    orch.relay_ctx = Some(ctx);
    orch.set_linux_capture(capture);
    let backend = if launch_only {
        "linux-app-launch"
    } else {
        "nft-cgroup-redirect"
    };
    let transport = if launch_only {
        "Linux unprivileged loopback launch relay"
    } else {
        "Linux nft+cgroup relay"
    };
    orch.set_active(
        backend,
        format!("capture active ({transport} :{relay_port}{gfw_note}{app_watch_note})"),
    );
    Ok(orch.status())
}

#[cfg(target_os = "linux")]
async fn start_linux_launched_capture(
    app: &AppHandle,
    ctx: Arc<RwLock<relay::RelayContext>>,
) -> Result<capture::linux::LinuxCaptureHandle, String> {
    let runtime_dir = data_dir(app)?.join("runtime");
    Ok(capture::linux::LinuxCaptureHandle::Launched(
        capture::linux::launched::LaunchedCaptureHandle::start(ctx, &runtime_dir).await?,
    ))
}

#[tauri::command]
pub async fn sockscap_launch_app(
    state: State<'_, AppState>,
    profile_id: String,
    path: String,
    args: Vec<String>,
    launch_preparation: config::AppLaunchPreparation,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let mut orch = state.sockscap.orch.write().await;
        if !orch.is_running() {
            return Err("start SocksCap before launching an application".into());
        }
        let configured = orch
            .config()
            .and_then(|config| {
                config
                    .active_profiles()
                    .into_iter()
                    .find(|profile| profile.id == profile_id)
            })
            .is_some_and(|profile| {
                profile.apps.iter().any(|app| {
                    app.path == path
                        && app.args == args
                        && app.launch_preparation == launch_preparation
                        && matches!(app.launch_mode, config::AppLaunchMode::Desktop)
                })
            });
        if !configured {
            return Err(
                "the application must belong to the selected active SocksCap profile".into(),
            );
        }
        let capture = orch
            .linux_capture_mut()
            .ok_or_else(|| "Linux capture backend is not active".to_string())?;
        let info = capture
            .launch_app(&profile_id, &path, &args, &launch_preparation)
            .await?;
        serde_json::to_value(info)
            .map_err(|error| format!("serialize launched application: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, profile_id, path, args, launch_preparation);
        Err("launching applications through SocksCap is currently Linux-only".into())
    }
}

#[tauri::command]
pub async fn sockscap_launch_terminal_app(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    path: String,
    args: Vec<String>,
    launch_preparation: config::AppLaunchPreparation,
    terminal_session_id: String,
    cols: u16,
    rows: u16,
    on_output: crate::terminal::TerminalOutputChannel,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        if state
            .terminals
            .read()
            .await
            .contains_key(&terminal_session_id)
        {
            return Err(format!("Terminal {} already exists", terminal_session_id));
        }

        let mut orch = state.sockscap.orch.write().await;
        // The frontend may be mounted twice by React StrictMode. Re-check
        // after serializing on the orchestrator lock so concurrent requests
        // with the same stable terminal id cannot both launch a process.
        if state
            .terminals
            .read()
            .await
            .contains_key(&terminal_session_id)
        {
            return Err(format!("Terminal {} already exists", terminal_session_id));
        }
        if !orch.is_running() {
            return Err("start SocksCap before launching an application".into());
        }
        let configured = orch
            .config()
            .and_then(|config| {
                config
                    .active_profiles()
                    .into_iter()
                    .find(|profile| profile.id == profile_id)
            })
            .is_some_and(|profile| {
                profile.apps.iter().any(|configured| {
                    configured.path == path
                        && configured.args == args
                        && configured.launch_preparation == launch_preparation
                        && matches!(configured.launch_mode, config::AppLaunchMode::Terminal)
                })
            });
        if !configured {
            return Err(
                "the terminal application must belong to the selected active SocksCap profile"
                    .into(),
            );
        }
        let capture = orch
            .linux_capture_mut()
            .ok_or_else(|| "Linux capture backend is not active".to_string())?;
        let (info, handle, reader) = capture.launch_terminal_app(
            &profile_id,
            &path,
            &args,
            &launch_preparation,
            &terminal_session_id,
            cols,
            rows,
        )?;
        if let Err(error) = crate::terminal::register_local_terminal(
            terminal_session_id,
            handle,
            reader,
            on_output,
            state.inner(),
            app,
        )
        .await
        {
            if let Err(stop_error) = capture.stop_launched_app(info.pid).await {
                tracing::warn!(
                    pid = info.pid,
                    "clean up failed terminal launch: {stop_error}"
                );
            }
            return Err(error);
        }
        serde_json::to_value(info)
            .map_err(|error| format!("serialize launched terminal application: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (
            app,
            state,
            profile_id,
            path,
            args,
            launch_preparation,
            terminal_session_id,
            cols,
            rows,
            on_output,
        );
        Err("launching terminal applications through SocksCap is currently Linux-only".into())
    }
}

#[tauri::command]
pub async fn sockscap_launched_apps(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let mut orch = state.sockscap.orch.write().await;
        let apps = orch
            .linux_capture_mut()
            .map(|capture| capture.launched_apps())
            .unwrap_or_default();
        serde_json::to_value(apps)
            .map_err(|error| format!("serialize launched applications: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        Ok(serde_json::json!([]))
    }
}

#[tauri::command]
pub async fn sockscap_stop_launched_app(
    state: State<'_, AppState>,
    pid: u32,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let mut orch = state.sockscap.orch.write().await;
        let capture = orch
            .linux_capture_mut()
            .ok_or_else(|| "Linux capture backend is not active".to_string())?;
        capture.stop_launched_app(pid).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, pid);
        Err("launching applications through SocksCap is currently Linux-only".into())
    }
}

#[cfg(target_os = "macos")]
async fn start_macos_capture(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
    journal_path: &std::path::Path,
) -> Result<SocksCapStatus, String> {
    capture::macos::preflight(cfg)?;
    redirector::cleanup_stale_sockets()?;
    redirector::cleanup_stale_launchers().await?;
    let ctx = match build_unix_relay_context(state, cfg).await {
        Ok(ctx) => ctx,
        Err(error) => {
            if let Some(manager) = state.sockscap.xray() {
                manager.shutdown_all().await;
            }
            return Err(error);
        }
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut journal = recovery::RecoveryJournal {
        platform: "macos".into(),
        capture_backend: caps.capture_backend.clone(),
        config_hash: cfg.content_hash(),
        pid: std::process::id(),
        clean: false,
        phase: recovery::RecoveryPhase::Preparing,
        session_id: session_id.clone(),
        backend_version: Some(redirector::REDIRECTOR_VERSION.into()),
        scope_hash: None,
        bridge_pid: None,
        provider_pid: None,
        relay_port: None,
        helper_port: None,
    };
    recovery::write_journal_durable(journal_path, &journal)
        .map_err(|error| format!("persist macOS SocksCap write-ahead journal: {error}"))?;

    let capture = match capture::macos::start(app, cfg, Arc::clone(&ctx), &session_id).await {
        Ok(capture) => capture,
        Err(start_error) => {
            if let Some(manager) = state.sockscap.xray() {
                manager.shutdown_all().await;
            }
            if start_error.recovery_required() {
                state.sockscap.orch.write().await.set_recovery_required(
                    &caps.capture_backend,
                    format!(
                        "macOS Redirector start may have reached the Provider after the dirty journal was written: {}; run Recover before retrying",
                        start_error.message()
                    ),
                );
            } else if let Err(clear_error) = recovery::mark_clean_and_clear(journal_path) {
                let message = format!(
                    "macOS Redirector failed before applying capture scope ({}), but the Preparing journal could not be cleared: {clear_error}",
                    start_error.message()
                );
                state
                    .sockscap
                    .orch
                    .write()
                    .await
                    .set_recovery_required(&caps.capture_backend, message.clone());
                return Err(message);
            }
            return Err(start_error.to_string());
        }
    };

    let telemetry = capture.telemetry();
    journal.phase = recovery::RecoveryPhase::Active;
    journal.scope_hash = Some(telemetry.scope_hash.clone());
    journal.bridge_pid = Some(telemetry.bridge_pid);
    journal.provider_pid = Some(telemetry.provider_pid);
    if let Err(journal_error) = recovery::write_journal_durable(journal_path, &journal) {
        let stop_error = capture.stop().await.err();
        if let Some(manager) = state.sockscap.xray() {
            manager.shutdown_all().await;
        }
        if stop_error.is_none() {
            if let Err(clear_error) = recovery::mark_clean_and_clear(journal_path) {
                state.sockscap.orch.write().await.set_recovery_required(
                    &caps.capture_backend,
                    format!(
                        "capture stopped after journal update failure, but the recovery journal could not be cleared: {clear_error}"
                    ),
                );
            }
        } else {
            state.sockscap.orch.write().await.set_recovery_required(
                &caps.capture_backend,
                format!(
                    "activate journal update failed: {journal_error}; Redirector stop also failed: {}",
                    stop_error.as_deref().unwrap_or("unknown error")
                ),
            );
        }
        return Err(format!(
            "persist active macOS SocksCap journal: {journal_error}"
        ));
    }
    let mut orch = state.sockscap.orch.write().await;
    let gfw_note = orch
        .gfwlist_meta()
        .map(|meta| format!(", gfw={}", meta.rule_count))
        .unwrap_or_default();
    orch.relay_ctx = Some(ctx);
    orch.set_macos_capture(capture);
    orch.set_active(
        &caps.capture_backend,
        format!("capture active (macOS Mitmproxy Redirector IPC{gfw_note})"),
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
    let (mut up_host, mut up_port, mut up_user, mut up_pass) = relay::upstream_from_config(cfg);
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
            db.and_then(|db| crate::session::db::get_session(&db, &cfg.upstream.session_id).ok())
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
    // Ports of native HTTP/SOCKS5 upstreams whose host is loopback (i.e. an
    // external local proxy such as Clash/v2rayN). We resolve the PID listening
    // on each and bypass it, so the proxy's own egress to its node isn't
    // re-captured into a loop. Only native kinds: core (xray) upstreams dial via
    // their sidecar (already PID-bypassed) and their host is the remote node.
    let mut loopback_proxy_ports: Vec<u16> = Vec::new();
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
            } else if !p.upstream.password_ref.is_empty()
                && p.upstream.password_ref.starts_with("key:")
            {
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

        // Native loopback proxy? Remember its port for PID-bypass below.
        if matches!(
            p.upstream.kind,
            crate::sockscap::config::UpstreamKind::Http
                | crate::sockscap::config::UpstreamKind::Socks5
        ) && pport != 0
            && listener_pid::is_loopback(&phost)
            && !loopback_proxy_ports.contains(&pport)
        {
            loopback_proxy_ports.push(pport);
        }

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

    // Global native loopback proxy → remember its port for PID-bypass below.
    if matches!(
        cfg.upstream.kind,
        crate::sockscap::config::UpstreamKind::Http | crate::sockscap::config::UpstreamKind::Socks5
    ) && up_port != 0
        && listener_pid::is_loopback(&up_host)
        && !loopback_proxy_ports.contains(&up_port)
    {
        loopback_proxy_ports.push(up_port);
    }

    // Optional SSH pool for capture-path PROXY via direct-tcpip.
    let ssh_pool = if matches!(
        cfg.upstream.kind,
        crate::sockscap::config::UpstreamKind::Ssh
    ) {
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

    // One persistent control channel for the whole capture session, instead of
    // a fresh blocking TCP connection per captured flow.
    let helper_client = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned())
        .map(|sess| Arc::new(helper::HelperClient::spawn(sess)));

    let engine = RelayContext::build_engine(cfg, rules.as_ref());
    let ctx = Arc::new(RwLock::new(RelayContext {
        config: cfg.clone(),
        rules,
        engine,
        helper: Arc::clone(&state.sockscap.helper),
        helper_client,
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
    let xray_pids: Vec<u32> = match state.sockscap.xray() {
        Some(mgr) => mgr.pids().await,
        None => Vec::new(),
    };
    bypass_pids.extend(xray_pids.iter().copied());
    // Bypass external local proxies used as loopback HTTP/SOCKS5 upstreams
    // (Clash/v2rayN etc): the process listening on the configured port owns the
    // egress to its node, which must not be re-captured into a loop. We bypass
    // both its PID (immediate) and its exe path (restart-proof: survives the
    // proxy restarting with a new PID, unlike the PID snapshot alone).
    let mut bypass_paths: Vec<String> = Vec::new();
    // Bypass the bundled xray binary by path as well as by pid. The pid list is
    // a snapshot; the path survives a core crashing and being respawned with a
    // new pid, which would otherwise have its node connection captured and
    // looped back into the relay.
    if let Some(xray) = paths::resolve_xray_exe(app) {
        let norm = paths::normalize_exe_path(&xray.display().to_string());
        if !norm.is_empty() && !bypass_paths.contains(&norm) {
            bypass_paths.push(norm);
        }
    }
    if !loopback_proxy_ports.is_empty() {
        let procs = process::list_processes().unwrap_or_default();
        for port in &loopback_proxy_ports {
            for pid in listener_pid::resolve_listener_pids(*port) {
                if !bypass_pids.contains(&pid) {
                    bypass_pids.push(pid);
                    tracing::info!("sockscap: bypassing local proxy pid {pid} on 127.0.0.1:{port}");
                }
                if let Some(path) = procs
                    .iter()
                    .find(|p| p.pid == pid)
                    .map(|p| paths::normalize_exe_path(&p.path))
                    .filter(|s| !s.is_empty())
                {
                    if !bypass_paths.contains(&path) {
                        tracing::info!("sockscap: bypassing local proxy path {path}");
                        bypass_paths.push(path);
                    }
                }
            }
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
        bypass_paths,
        bypass_endpoints,
        // Unused for streamdump reflection dest (kept for helper JSON compat).
        relay_ip: "0.0.0.0".into(),
        relay_port: relay_handle.port,
        block_quic: cfg.block_quic,
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
            // Keep the helper's bypass list current as cores are respawned.
            spawn_xray_bypass_updater(state, &args.bypass_pids, &xray_pids, &args.bypass_paths);
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

/// Push a refreshed bypass list to the helper whenever an xray core respawns.
///
/// The helper's bypass pids are a snapshot taken at capture start. A core that
/// crashes comes back with a new pid, and until the helper is told, that core's
/// connection to its remote node is captured and reflected into the relay —
/// which then dials the core's own SOCKS inbound. The resulting loop wedges all
/// proxied traffic, and a crash somewhere in a multi-hour session is exactly the
/// kind of event that made long runs stop working.
///
/// The task ends when the manager drops the sender (`stop_monitor`, called from
/// every teardown path) or when a later capture start replaces it.
#[cfg(windows)]
fn spawn_xray_bypass_updater(
    state: &State<'_, AppState>,
    base_pids: &[u32],
    initial_core_pids: &[u32],
    bypass_paths: &[String],
) {
    let Some(mgr) = state.sockscap.xray() else {
        return;
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u32>>();
    mgr.set_respawn_notifier(tx);

    let helper = Arc::clone(&state.sockscap.helper);
    // Everything except the core pids, which the notification re-supplies in
    // full. Dropping the dead ones matters: a recycled pid could later belong to
    // a process that should be captured.
    let mut base: Vec<u32> = base_pids.to_vec();
    base.retain(|p| !initial_core_pids.contains(p));
    let paths = bypass_paths.to_vec();

    tokio::spawn(async move {
        while let Some(core_pids) = rx.recv().await {
            let mut pids = base.clone();
            for p in core_pids {
                if !pids.contains(&p) {
                    pids.push(p);
                }
            }
            let Some(sess) = helper.inner.lock().ok().and_then(|g| g.as_ref().cloned()) else {
                continue;
            };
            let paths = paths.clone();
            let sent = tokio::task::spawn_blocking(move || {
                helper::capture_update_bypass(&sess, &pids, &paths)
            })
            .await;
            match sent {
                Ok(Ok(_)) => {
                    tracing::info!("sockscap: pushed refreshed bypass list after xray respawn")
                }
                Ok(Err(e)) => tracing::warn!("sockscap: bypass refresh failed: {e}"),
                Err(e) => tracing::warn!("sockscap: bypass refresh task failed: {e}"),
            }
        }
    });
}

#[cfg(not(windows))]
fn spawn_xray_bypass_updater(
    _state: &State<'_, AppState>,
    _pids: &[u32],
    _core_pids: &[u32],
    _paths: &[String],
) {
}

#[tauri::command]
pub async fn sockscap_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapStatus, String> {
    if !state.sockscap.has_activation_lock() {
        let orch = state.sockscap.orch.read().await;
        return Ok(orch.status());
    }
    full_teardown(&app, &state, true).await?;
    state.sockscap.release_activation_lock();
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

/// Gracefully release capture state owned by this process before the app exits.
///
/// The final [`tauri::RunEvent::Exit`] callback is synchronous, so Linux and
/// macOS teardown must happen while the async runtime and the stored sudo
/// credential are still available. If teardown fails, the exit command returns
/// an error and the UI keeps the process alive so the user can retry or Recover.
pub async fn prepare_for_exit(app: &AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let owns_capture = state.sockscap.has_activation_lock();
    let recovery_required = matches!(
        state.sockscap.orch.read().await.status().phase,
        orchestrator::EnginePhase::RecoveryRequired
    );
    // A dirty journal discovered by boot recovery is durable evidence for the
    // next launch, but it is not an active capture owned by this process. In
    // that state keeping Taomni open cannot make the network safer and can trap
    // an offline user in an unquittable app. Still block when this process owns
    // the capture lock: that path has live state and must finish teardown first.
    if should_block_exit_for_recovery(recovery_required, owns_capture) {
        return Err(
            "SocksCap network recovery is required before Taomni can exit safely; use Recover network first"
                .into(),
        );
    }
    let mut errors = Vec::new();

    if owns_capture {
        if let Err(error) = full_teardown(app, &state, true).await {
            errors.push(error);
        }
    } else if let Some(manager) = state.sockscap.xray() {
        // Core probes can exist without an active OS-capture lock.
        manager.shutdown_all().await;
    }

    if let Err(error) = helper::sockscap_helper_stop(state.clone()).await {
        errors.push(format!("SocksCap helper shutdown failed: {error}"));
    }

    if errors.is_empty() {
        if owns_capture {
            state.sockscap.release_activation_lock();
        }
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Release SocksCap's OS capture state and every privileged file the updater is
/// about to overwrite. Linux/macOS need the network teardown; Windows also
/// needs the helper and WinDivert image files to become writable.
///
/// The lock the installer trips over is a kernel one: while SocksCap captures,
/// WinDivert is loaded and Windows keeps `WinDivert64.sys` locked until the last
/// handle to it closes and the driver unloads. `sockscap-helper.exe` and
/// `WinDivert.dll` are locked too, as the running helper's own image.
///
/// The NSIS installer *cannot* release these on a per-user (`currentUser`)
/// install: it runs unelevated, so its `taskkill /F` against the UAC-elevated
/// helper and its `sc stop WinDivert` both get Access Denied. The app can,
/// though — not by elevating itself, but by asking the helper (over the control
/// channel it already owns) to close its WinDivert handles and exit. Closing the
/// handles unloads the driver (freeing the `.sys`); exiting frees the exe/DLL.
#[tauri::command]
pub async fn sockscap_prepare_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let owned_capture = state.sockscap.has_activation_lock();
    let recovery_required = matches!(
        state.sockscap.orch.read().await.status().phase,
        orchestrator::EnginePhase::RecoveryRequired
    );
    if recovery_required {
        return Err(
            "SocksCap network recovery is required before updating; use Recover network first"
                .into(),
        );
    }
    if !state.sockscap.has_activation_lock() {
        let lock = ModuleLock::try_acquire_for_app(
            &app,
            "sockscap",
            "global",
            "SocksCap update preparation",
        )?;
        state.sockscap.install_activation_lock(lock);
    }

    // A dirty journal not owned by this runtime means a previous process left
    // machine-wide state behind. Do not erase the journal or install an update
    // over it: the user must run Recover with elevation first.
    if !owned_capture {
        if let Ok(dir) = data_dir(&app) {
            let journal = recovery::journal_path(&dir);
            if recovery::needs_repair(&journal) {
                state.sockscap.release_activation_lock();
                return Err(
                    "SocksCap recovery is required before updating; use Recover network first"
                        .into(),
                );
            }
        }
    }

    // 1) Stop capture before the installer or relaunch can terminate the
    //    process. The running handle retains the credential needed to remove
    //    Linux nftables/cgroups; macOS disables Redirector interception over IPC.
    let teardown_error = if owned_capture {
        full_teardown(&app, &state, true).await.err()
    } else {
        if let Some(manager) = state.sockscap.xray() {
            manager.shutdown_all().await;
        }
        None
    };

    // 2) Ask the elevated helper to exit, freeing `sockscap-helper.exe` and
    //    `WinDivert.dll`. Reuses the same shutdown path as the Stop button.
    let helper_error = helper::sockscap_helper_stop(state.clone())
        .await
        .err()
        .map(|error| format!("SocksCap helper shutdown failed: {error}"));

    // 3) The driver unload is asynchronous, so poll until the files the installer
    //    overwrites are actually releasable (or a short deadline passes).
    #[cfg(windows)]
    wait_for_privileged_files_unlocked(&app).await;

    let mut errors = Vec::new();
    if let Some(error) = teardown_error {
        tracing::warn!("sockscap: prepare-for-update teardown incomplete: {error}");
        errors.push(error);
    }
    if let Some(error) = helper_error {
        tracing::warn!("sockscap: prepare-for-update helper stop failed: {error}");
        errors.push(error);
    }
    if errors.is_empty() {
        state.sockscap.release_activation_lock();
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Poll the bundled privileged files until each is openable for writing (i.e.
/// no longer locked by a live driver/helper), or a short deadline elapses.
///
/// Only the install-directory copies matter: those are what the updater
/// overwrites. When runtime staging is active the loaded driver's `.sys` lives
/// under app-data instead, so the install-directory copy is never locked and
/// this returns on the first probe.
#[cfg(windows)]
async fn wait_for_privileged_files_unlocked(app: &AppHandle) {
    use std::time::{Duration, Instant};

    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(dir) = paths::resolve_windivert_dir(app) {
        files.push(dir.join("WinDivert64.sys"));
        files.push(dir.join("WinDivert.dll"));
    }
    if let Ok(helper_exe) = paths::resolve_helper_exe(app) {
        files.push(helper_exe);
    }
    if let Some(xray_exe) = paths::resolve_xray_exe(app) {
        files.push(xray_exe);
    }
    files.retain(|p| p.is_file());
    if files.is_empty() {
        return;
    }

    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let still_locked: Vec<&PathBuf> = files.iter().filter(|p| is_file_locked(p)).collect();
        if still_locked.is_empty() {
            tracing::info!("sockscap: privileged files released; safe to upgrade");
            return;
        }
        if Instant::now() >= deadline {
            tracing::warn!(
                "sockscap: {} privileged file(s) still locked after wait; \
                 the installer may prompt to retry/ignore: {:?}",
                still_locked.len(),
                still_locked
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// True when `path` cannot be opened for writing because something holds it with
/// a sharing violation (a loaded driver or running image). An unrelated failure
/// (access denied, not found) is treated as "not our lock" so we never wait on
/// something stopping the helper would not fix.
#[cfg(windows)]
fn is_file_locked(path: &std::path::Path) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    // Open for write without truncation: probes the lock without altering bytes.
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(e) => matches!(
            e.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION)
        ),
    }
}

#[tauri::command]
pub async fn sockscap_recover(
    app: AppHandle,
    state: State<'_, AppState>,
    sudo_password: Option<String>,
) -> Result<(), String> {
    let mut acquired_recovery_lock = false;
    if !state.sockscap.has_activation_lock() {
        let lock =
            ModuleLock::try_acquire_for_app(&app, "sockscap", "global", "SocksCap recovery")?;
        state.sockscap.install_activation_lock(lock);
        acquired_recovery_lock = true;
    }

    // Even if stopping the active session was incomplete, recovery gets one
    // more independent chance to remove the platform-owned state.
    let teardown_error = full_teardown(&app, &state, false).await.err();
    #[cfg(target_os = "macos")]
    let stale_runtime_clean = {
        let sockets_clean = match redirector::cleanup_stale_sockets() {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!("sockscap: Recover stale Redirector socket cleanup failed: {error}");
                false
            }
        };
        let launchers_clean = match redirector::cleanup_stale_launchers().await {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(
                    "sockscap: Recover stale Redirector launcher cleanup failed: {error}"
                );
                false
            }
        };
        sockets_clean && launchers_clean
    };

    #[cfg(target_os = "macos")]
    let pending_approval_journal = data_dir(&app)
        .ok()
        .map(|dir| recovery::journal_path(&dir))
        .filter(|journal| {
            recovery::read_journal(journal)
                .as_ref()
                .is_some_and(pending_approval_never_recorded_scope)
        });

    #[cfg(target_os = "macos")]
    if teardown_error.is_none()
        && stale_runtime_clean
        && matches!(
            redirector::installer::system_extension_state(),
            redirector::installer::RedirectorSystemExtensionState::WaitingForUser
        )
        && pending_approval_journal.is_some()
    {
        let journal = pending_approval_journal.expect("checked above");
        if let Err(error) = recovery::mark_clean_and_clear(&journal) {
            let message = format!(
                "Redirector never applied capture while System Extension approval was pending, but its journal could not be cleared: {error}"
            );
            state
                .sockscap
                .orch
                .write()
                .await
                .set_recovery_required("mitmproxy-redirector", message.clone());
            state.sockscap.release_activation_lock();
            return Err(message);
        }
        state.sockscap.orch.write().await.force_idle();
        state.sockscap.release_activation_lock();
        tracing::info!(
            "sockscap: Recover cleared an aborted first-use approval attempt without starting another launcher"
        );
        return Ok(());
    }
    let sudo_password = sudo_password.map(Zeroizing::new);
    let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
    match capture::recover_system(sudo_pw).await {
        Ok(needs_elevation) => {
            // Queue anything only an elevated process can kill; the next Start
            // hands the list to the helper it launches under UAC.
            queue_reap(&state, &needs_elevation);
            #[cfg(target_os = "macos")]
            if let Ok(dir) = data_dir(&app) {
                if let Err(error) = recovery::mark_clean_and_clear(&recovery::journal_path(&dir)) {
                    let message = format!(
                        "network recovery succeeded, but the durable recovery journal could not be cleared: {error}"
                    );
                    state.sockscap.orch.write().await.set_recovery_required(
                        &capture::capabilities().capture_backend,
                        message.clone(),
                    );
                    if acquired_recovery_lock {
                        state.sockscap.release_activation_lock();
                    }
                    return Err(message);
                }
            }
            #[cfg(not(target_os = "macos"))]
            if let Ok(dir) = data_dir(&app) {
                let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
            }
            state.sockscap.orch.write().await.force_idle();
            if let Some(error) = teardown_error {
                tracing::info!("sockscap: Recover repaired incomplete teardown: {error}");
            }
            if !needs_elevation.is_empty() {
                tracing::warn!(
                    "sockscap: {} helper process(es) need Administrator; they will be reaped on the next Start",
                    needs_elevation.len()
                );
            }
            state.sockscap.release_activation_lock();
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
            // A lock acquired only to serialize this Recover attempt must not
            // turn a failed recovery into apparent ownership of live capture.
            // The durable journal remains dirty and another attempt (or the
            // next launch) can safely reacquire the module lock.
            if acquired_recovery_lock {
                state.sockscap.release_activation_lock();
            }
            Err(message)
        }
    }
}

fn should_block_exit_for_recovery(recovery_required: bool, owns_capture: bool) -> bool {
    recovery_required && owns_capture
}

#[cfg(target_os = "macos")]
fn pending_approval_never_recorded_scope(journal: &recovery::RecoveryJournal) -> bool {
    matches!(journal.phase, recovery::RecoveryPhase::Preparing)
        && journal.scope_hash.is_none()
        && journal.bridge_pid.is_none()
        && journal.provider_pid.is_none()
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

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let mut errors = Vec::new();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
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

    // Stop Linux xray health monitoring before cgroup cleanup. A respawn is a
    // child of Taomni and therefore inherits the global/mixed bypass cgroup;
    // allowing that during cleanup can repopulate the cgroup after its member
    // snapshot and make rmdir fail with EBUSY.
    #[cfg(target_os = "linux")]
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all().await;
    }

    // --- 2) Linux removes nft rules + restores cgroups before its relay stops -
    #[cfg(target_os = "linux")]
    let retryable_linux_capture = {
        let mut linux_capture = {
            let mut orch = state.sockscap.orch.write().await;
            orch.take_linux_capture_for_stop()
        };
        if let Some(capture) = linux_capture.as_mut() {
            if let Err(error) = capture.stop().await {
                tracing::warn!("sockscap: Linux capture teardown error: {error}");
                errors.push(format!("Linux capture teardown failed: {error}"));
            } else {
                linux_capture = None;
            }
        }

        // A partially-cleaned handle retains the original cgroup mappings so
        // Recover in this same process can retry safely.
        linux_capture
    };

    // --- 2b) macOS first sends Redirector's inert scope, then closes IPC ------
    #[cfg(target_os = "macos")]
    {
        if let Ok(dir) = data_dir(app) {
            let journal = recovery::journal_path(&dir);
            if recovery::needs_repair(&journal) {
                if let Err(error) =
                    recovery::update_phase_durable(&journal, recovery::RecoveryPhase::Stopping)
                {
                    tracing::warn!(
                        "sockscap: could not persist macOS Stopping journal phase: {error}"
                    );
                }
            }
        }
        let macos_capture = {
            let mut orch = state.sockscap.orch.write().await;
            orch.take_macos_capture_for_stop()
        };
        if let Some(capture) = macos_capture {
            if let Err(error) = capture.stop().await {
                tracing::warn!("sockscap: macOS capture teardown error: {error}");
                errors.push(format!("macOS capture teardown failed: {error}"));
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
    #[cfg(not(target_os = "linux"))]
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all().await;
    }

    // --- 4) Finish engine state + DNS + journal ------------------------------
    {
        let mut orch = state.sockscap.orch.write().await;
        orch.finish_stop();
        if !errors.is_empty() {
            orch.set_recovery_required(&capture::capabilities().capture_backend, errors.join("; "));
        }
        #[cfg(target_os = "linux")]
        if let Some(capture) = retryable_linux_capture {
            orch.set_linux_capture(capture);
        }
    }
    if errors.is_empty() {
        if clear_journal {
            #[cfg(target_os = "macos")]
            if let Ok(dir) = data_dir(app) {
                if let Err(error) = recovery::mark_clean_and_clear(&recovery::journal_path(&dir)) {
                    let message = format!(
                        "capture stopped, but the recovery journal could not be cleared: {error}"
                    );
                    state.sockscap.orch.write().await.set_recovery_required(
                        &capture::capabilities().capture_backend,
                        message.clone(),
                    );
                    return Err(message);
                }
            }
            #[cfg(not(target_os = "macos"))]
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
            egress::http_connect::dial(&host, port, &target_host, target_port, &user, &pass)
                .await?;
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
            let stream = pool.dial(&target_host, target_port, "127.0.0.1", 0).await?;
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

/// Fetch a subscription and parse it into upstreams. `input` is either an
/// http(s) subscription URL (fetched) or a pasted blob (base64 / newline links,
/// used as-is). Returns the parsed nodes for the UI to turn into profiles.
#[tauri::command]
pub async fn sockscap_import_subscription(
    input: String,
) -> Result<Vec<core::share_link::ParsedShareLink>, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("subscription is empty".into());
    }
    let blob = if input.starts_with("http://") || input.starts_with("https://") {
        let client = reqwest::Client::builder()
            .user_agent("taomni-sockscap")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(input)
            .send()
            .await
            .map_err(|e| format!("fetch subscription: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("subscription HTTP {}", resp.status()));
        }
        resp.text()
            .await
            .map_err(|e| format!("read subscription body: {e}"))?
    } else {
        input.to_string()
    };
    let nodes = core::share_link::parse_subscription(&blob);
    if nodes.is_empty() {
        return Err("no valid nodes found in subscription".into());
    }
    Ok(nodes)
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

/// A local proxy discovered on the machine, offered as a one-click upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyCandidate {
    /// "socks5" | "http" — detected by a lightweight handshake probe.
    pub kind: String,
    pub host: String,
    pub port: u16,
    /// Listening process name (best-effort; empty if not resolvable).
    pub process: String,
    /// Owning pid of the listener (0 if unknown).
    pub pid: u32,
    /// Normalized client family id derived from the process name
    /// ("clash" | "mihomo" | "sing-box" | "v2rayn" | "xray" | … | "unknown").
    /// Lets the UI group candidates by client.
    pub client: String,
    /// Human-friendly client name for display ("Clash Verge", "sing-box", …).
    /// Empty for the "unknown" family.
    pub client_label: String,
}

/// Map a listening process's image name to a `(client_id, client_label)`.
///
/// Pure and case-insensitive so it unit-tests on any platform. Order matters:
/// more specific families (mihomo, Clash Verge) are matched before the generic
/// "clash" fallback. Returns `("unknown", "")` when nothing matches.
pub(crate) fn classify_client(process_name: &str) -> (String, String) {
    let n = process_name.to_ascii_lowercase();
    let hit = |id: &str, label: &str| (id.to_string(), label.to_string());
    if n.contains("mihomo") {
        hit("mihomo", "Mihomo")
    } else if n.contains("verge") {
        hit("clash", "Clash Verge")
    } else if n.contains("clash") {
        hit("clash", "Clash")
    } else if n.contains("sing-box") || n.contains("sing_box") || n.contains("singbox") {
        hit("sing-box", "sing-box")
    } else if n.contains("nekoray") || n.contains("nekobox") {
        hit("nekoray", "NekoRay")
    } else if n.contains("v2rayn") {
        hit("v2rayn", "v2rayN")
    } else if n.contains("qv2ray") {
        hit("qv2ray", "Qv2ray")
    } else if n.contains("hysteria") {
        hit("hysteria", "Hysteria")
    } else if n.contains("xray") {
        hit("xray", "Xray")
    } else if n.contains("v2ray") {
        hit("v2ray", "V2Ray")
    } else if n.contains("shadowsocks") || n.contains("ss-local") || n == "sslocal" {
        hit("shadowsocks", "Shadowsocks")
    } else {
        ("unknown".to_string(), String::new())
    }
}

/// Common local-proxy listen ports for popular clients (Clash/Mihomo mixed,
/// v2rayN/xray, generic SOCKS/HTTP). Probed on 127.0.0.1 only.
const COMMON_PROXY_PORTS: &[u16] = &[
    7890, 7891, 7892, 7897, // Clash / Mihomo (mixed / socks / http / verge)
    10808, 10809, // v2rayN (socks / http)
    2080, 2081, // sing-box / others
    1080, 1081, // generic SOCKS
    8889, 8080, // generic HTTP
    20170, 20171, // Qv2ray defaults
];

/// Probe a loopback port: return Some("socks5"|"http") if it speaks one, else
/// None. Sends a SOCKS5 no-auth greeting; on a valid `05 xx` reply it's SOCKS5.
/// Otherwise tries an HTTP CONNECT and treats any HTTP status line as HTTP.
async fn probe_local_proxy_kind(port: u16) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let connect = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        TcpStream::connect(addr),
    );
    let mut s = connect.await.ok()?.ok()?;
    // SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=0 (no auth).
    if s.write_all(&[0x05, 0x01, 0x00]).await.is_ok() {
        let mut buf = [0u8; 2];
        if tokio::time::timeout(
            std::time::Duration::from_millis(300),
            s.read_exact(&mut buf),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .is_some()
            && buf[0] == 0x05
        {
            return Some("socks5".into());
        }
    }
    // Not SOCKS5 — try a fresh connection for an HTTP CONNECT probe.
    let mut s = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        TcpStream::connect(addr),
    )
    .await
    .ok()?
    .ok()?;
    let req = "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
    s.write_all(req.as_bytes()).await.ok()?;
    let mut buf = [0u8; 16];
    let n = tokio::time::timeout(std::time::Duration::from_millis(300), s.read(&mut buf))
        .await
        .ok()?
        .ok()?;
    let head = String::from_utf8_lossy(&buf[..n]);
    if head.starts_with("HTTP/") {
        return Some("http".into());
    }
    None
}

/// Detect running local proxies to offer as one-click upstreams.
///
/// Two sources are merged so the UI can list *actual* running proxies rather
/// than only a fixed port table:
///  1. Every loopback/wildcard TCP listener owned by a recognized circumvention
///     client (Clash/sing-box/Mihomo/v2rayN/xray/…), on whatever port it chose —
///     this catches non-default ports the user configured.
///  2. The `COMMON_PROXY_PORTS` fallback, so a proxy whose owning process we
///     could not identify (or on a platform without pid resolution) is still
///     surfaced when it sits on a well-known port.
///
/// Each port that passes a lightweight SOCKS5/HTTP handshake becomes a
/// candidate carrying its detected kind, owning pid, process name, and client
/// family (for grouping). Probing is restricted to identified-client ports plus
/// the common table, so unrelated loopback listeners (dev servers, databases)
/// are not probed.
#[tauri::command]
pub async fn sockscap_detect_local_proxies() -> Result<Vec<LocalProxyCandidate>, String> {
    use std::collections::HashMap;

    let procs = process::list_processes().unwrap_or_default();
    // pid -> display name. Prefer the (original-case) name from list_processes
    // (Windows/Linux); fall back to process_image_name for platforms where
    // list_processes is empty (macOS) or a pid it did not include.
    let name_of = |pid: u32| -> String {
        procs
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| p.name.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| process::process_image_name(pid))
            .unwrap_or_default()
    };

    // Metadata for a port we know a process is listening on.
    struct PortMeta {
        pid: u32,
        process: String,
        client: String,
        client_label: String,
    }

    // Build port -> metadata from the loopback listener enumeration. When two
    // listeners share a port (v4 + v6), prefer the one we could identify.
    let mut port_meta: HashMap<u16, PortMeta> = HashMap::new();
    for l in listener_pid::list_loopback_listeners() {
        let process = name_of(l.pid);
        let (client, client_label) = classify_client(&process);
        let meta = PortMeta {
            pid: l.pid,
            process,
            client,
            client_label,
        };
        match port_meta.get(&l.port) {
            Some(existing) if existing.client != "unknown" => {}
            _ => {
                port_meta.insert(l.port, meta);
            }
        }
    }

    // Ports to probe: the common table, plus any identified-client listener
    // ports not already in it (custom-port coverage).
    let mut ports: Vec<u16> = COMMON_PROXY_PORTS.to_vec();
    for (port, meta) in &port_meta {
        if meta.client != "unknown" && !ports.contains(port) {
            ports.push(*port);
        }
    }

    let mut out = Vec::new();
    for port in ports {
        // Something must be listening before we spend a handshake budget on it.
        // `port_meta` (from the cross-OS loopback enumeration) is the primary
        // gate on every platform; `resolve_listener_pids` is a Windows-only
        // secondary check. Common-table ports with nothing listening are skipped
        // rather than incurring a probe timeout each.
        let has_meta = port_meta.contains_key(&port);
        if !has_meta && listener_pid::resolve_listener_pids(port).is_empty() {
            continue;
        }
        let Some(kind) = probe_local_proxy_kind(port).await else {
            continue;
        };
        let (pid, process, client, client_label) = match port_meta.get(&port) {
            Some(m) => (
                m.pid,
                m.process.clone(),
                m.client.clone(),
                m.client_label.clone(),
            ),
            None => {
                let pid = listener_pid::resolve_listener_pids(port)
                    .into_iter()
                    .next()
                    .unwrap_or(0);
                let process = if pid != 0 {
                    name_of(pid)
                } else {
                    String::new()
                };
                let (client, client_label) = classify_client(&process);
                (pid, process, client, client_label)
            }
        };
        out.push(LocalProxyCandidate {
            kind,
            host: "127.0.0.1".into(),
            port,
            process,
            pid,
            client,
            client_label,
        });
    }

    // Identified clients first, then by port, so the UI's primary group leads.
    out.sort_by(|a, b| {
        let a_known = a.client != "unknown";
        let b_known = b.client != "unknown";
        b_known.cmp(&a_known).then(a.port.cmp(&b.port))
    });
    Ok(out)
}

/// Suspected proxy/VPN TUN adapters on this machine (Clash TUN, sing-box,
/// Wintun/TAP, WireGuard). A running L3 TUN client collides with SocksCap's
/// global capture, so the UI warns when this is non-empty. Empty = no conflict.
#[tauri::command]
pub async fn sockscap_detect_tun_conflicts() -> Result<Vec<String>, String> {
    Ok(tun_detect::detect_tun_adapters())
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
    // The helper removes its own ready file as it exits, but do it here too:
    // if the shutdown RPC never landed, the stale file would otherwise advertise
    // a helper that is gone (or wedged) to the next launch's boot repair.
    sess.remove_ready_file();

    if stopped {
        if let Ok(dir) = data_dir(app) {
            let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
        }
    }
}

/// A helper-ready file left in the sockscap data dir by some previous launch.
#[derive(Debug)]
struct StaleReadyFile {
    path: PathBuf,
    pid: Option<u32>,
    parent_pid: Option<u32>,
}

fn read_ready_files(dir: &std::path::Path) -> Vec<StaleReadyFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ready = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("helper-ready-") && n.ends_with(".json"));
        if !is_ready {
            continue;
        }
        let (mut pid, mut parent_pid) = (None, None);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                pid = v.get("pid").and_then(|x| x.as_u64()).map(|n| n as u32);
                parent_pid = v
                    .get("parentPid")
                    .and_then(|x| x.as_u64())
                    .map(|n| n as u32);
            }
        }
        out.push(StaleReadyFile {
            path,
            pid,
            parent_pid,
        });
    }
    out
}

/// Boot-time hook: reap helpers stranded by a previous run and repair any
/// half-installed OS capture state.
///
/// Two things happen here that did not before.
///
/// First, ready files are actually inspected. They were written and never read
/// back, so a helper stranded by a crash (or by a build with no exit hook at
/// all) was invisible: it kept diverting every outbound packet on the machine
/// toward a relay port that no longer existed, and contested the driver handle
/// with the next session. A ready file is now classified as: the pid is gone or
/// belongs to something else (delete the file); its owning app is still running
/// (leave it alone — it belongs to a live instance, which matters when two
/// copies of Taomni are open); or the owner is gone and the helper is not
/// (an orphan: record its pid and take ownership of reaping it).
///
/// Second, orphans that cannot be terminated from here — the normal case, since
/// they are elevated and this process is not — are queued for the next helper
/// launch, which runs under UAC. Nothing else in the system can do it.
pub async fn boot_repair(app: &AppHandle, state: &AppState) {
    #[cfg(target_os = "macos")]
    let _ready = RecoveryReadyGuard(&state.sockscap);

    // Another live instance may own the dirty journal. Never repair global
    // network state underneath its active capture session.
    let _repair_lock =
        match ModuleLock::try_acquire_for_app(app, "sockscap", "global", "SocksCap recovery") {
            Ok(lock) => lock,
            Err(error) => {
                tracing::info!("sockscap: boot repair skipped: {error}");
                return;
            }
        };

    let Ok(dir) = data_dir(app) else {
        return;
    };

    #[cfg(target_os = "macos")]
    let stale_sockets_clean = match redirector::cleanup_stale_sockets() {
        Ok(count) if count > 0 => {
            tracing::info!(count, "sockscap: removed stale Redirector Unix sockets");
            true
        }
        Ok(_) => true,
        Err(error) => {
            tracing::warn!("sockscap: stale Redirector socket cleanup failed: {error}");
            false
        }
    };

    #[cfg(target_os = "macos")]
    let stale_launchers_clean = match redirector::cleanup_stale_launchers().await {
        Ok(count) if count > 0 => {
            tracing::warn!(
                count,
                "sockscap: reaped stale Redirector approval launchers"
            );
            true
        }
        Ok(_) => true,
        Err(error) => {
            tracing::warn!("sockscap: stale Redirector launcher cleanup failed: {error}");
            false
        }
    };

    let mut orphans: Vec<u32> = Vec::new();
    for ready in read_ready_files(&dir) {
        let alive_helper = ready.pid.is_some_and(|pid| {
            process::process_image_name(pid).as_deref() == Some(capture::HELPER_IMAGE_NAME)
        });
        if !alive_helper {
            tracing::info!(
                "sockscap: removing stale ready file {} (helper pid {:?} is gone)",
                ready.path.display(),
                ready.pid
            );
            let _ = std::fs::remove_file(&ready.path);
            continue;
        }
        // A live owner means this helper belongs to a running instance.
        if ready
            .parent_pid
            .is_some_and(|ppid| process::process_image_name(ppid).is_some())
        {
            tracing::info!(
                "sockscap: helper pid {:?} still owned by a running instance; leaving it",
                ready.pid
            );
            continue;
        }
        if let Some(pid) = ready.pid {
            tracing::warn!("sockscap: orphaned elevated helper pid {pid} — scheduling reap");
            orphans.push(pid);
            let _ = std::fs::remove_file(&ready.path);
        }
    }

    let journal_path = recovery::journal_path(&dir);
    let dirty = recovery::needs_repair(&journal_path);
    if !dirty && orphans.is_empty() {
        return;
    }

    if dirty {
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
    }

    // If macOS is still waiting for first-use approval, the System Extension
    // is not enabled and cannot have installed a Provider scope. A Preparing
    // journal with no recorded bridge/provider/scope is therefore an aborted
    // approval attempt, not residual capture. Once its dead sockets and exact
    // coordinator processes are gone, clear it without launching another
    // coordinator that would only wait for the same approval again.
    #[cfg(target_os = "macos")]
    if dirty
        && stale_sockets_clean
        && stale_launchers_clean
        && matches!(
            redirector::installer::system_extension_state(),
            redirector::installer::RedirectorSystemExtensionState::WaitingForUser
        )
        && recovery::read_journal(&journal_path)
            .as_ref()
            .is_some_and(pending_approval_never_recorded_scope)
    {
        match recovery::mark_clean_and_clear(&journal_path) {
            Ok(()) => {
                tracing::info!(
                    "sockscap: cleared aborted first-use approval journal; waiting for System Settings approval"
                );
                state.sockscap.orch.write().await.force_idle();
            }
            Err(error) => {
                state.sockscap.orch.write().await.set_recovery_required(
                    "mitmproxy-redirector",
                    format!(
                        "Redirector never applied capture while System Extension approval was pending, but its journal could not be cleared: {error}"
                    ),
                );
            }
        }
        return;
    }

    // The previous helper cannot be contacted without its token, so recovery
    // terminates what it can and reports what needs elevation.
    match capture::recover_system(None).await {
        Ok(needs_elevation) => {
            for pid in needs_elevation {
                if !orphans.contains(&pid) {
                    orphans.push(pid);
                }
            }
        }
        Err(e) => {
            // Leave the journal dirty so a later boot retries instead of falsely
            // declaring potentially-live nftables/cgroup state recovered.
            tracing::warn!("sockscap: boot recover failed; leaving journal dirty: {e}");
            queue_reap(state, &orphans);
            #[cfg(target_os = "macos")]
            state.sockscap.orch.write().await.set_recovery_required(
                "mitmproxy-redirector",
                format!("macOS Redirector recovery failed: {e}"),
            );
            return;
        }
    }

    queue_reap(state, &orphans);
    if orphans.is_empty() {
        #[cfg(target_os = "macos")]
        match recovery::mark_clean_and_clear(&journal_path) {
            Ok(()) => tracing::info!("sockscap: recovery complete"),
            Err(error) => {
                tracing::warn!("sockscap: recovery journal cleanup failed: {error}");
                #[cfg(target_os = "macos")]
                state.sockscap.orch.write().await.set_recovery_required(
                    "mitmproxy-redirector",
                    format!(
                        "macOS network recovery succeeded, but journal cleanup failed: {error}"
                    ),
                );
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = recovery::mark_clean_and_clear(&journal_path);
            tracing::info!("sockscap: recovery complete");
        }
    } else {
        // Do not declare success while an elevated orphan is still diverting
        // packets. The journal stays dirty until a helper launch reaps it.
        let backend = capture::capabilities().capture_backend;
        let message = format!(
            "{} orphaned elevated helper process(es) from a previous run need Administrator to \
             clean up; they will be reaped when you next Start SocksCap (accept the UAC prompt)",
            orphans.len()
        );
        tracing::warn!("sockscap: {message}");
        state
            .sockscap
            .orch
            .write()
            .await
            .set_recovery_required(&backend, message);
    }
}

fn queue_reap(state: &AppState, pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    if let Ok(mut slot) = state.sockscap.pending_reap.lock() {
        for pid in pids {
            if !slot.contains(pid) {
                slot.push(*pid);
            }
        }
    }
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
pub async fn sockscap_clear_domain_records(state: State<'_, AppState>) -> Result<(), String> {
    let orch = state.sockscap.orch.read().await;
    let mut guard = orch.domains.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::pending_approval_never_recorded_scope;
    use super::{
        Orchestrator, classify_client, ensure_configuration_unlocked, session_password_ref,
        session_proxy_password, session_ssh_auth, should_block_exit_for_recovery,
    };
    use crate::session::models::{AuthMethod, SessionConfig, SessionType};
    #[cfg(target_os = "macos")]
    use crate::sockscap::recovery::{RecoveryJournal, RecoveryPhase};
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
        vault
            .init("correct-horse-battery-staple")
            .expect("init vault");
        (dir, vault)
    }

    #[test]
    fn configuration_mutations_are_rejected_during_capture() {
        let mut orchestrator = Orchestrator::new();
        assert!(ensure_configuration_unlocked(&orchestrator).is_ok());

        orchestrator.set_active("test", "active");
        let error = ensure_configuration_unlocked(&orchestrator).unwrap_err();
        assert!(error.contains("stop capture before making changes"));

        orchestrator.finish_stop();
        assert!(ensure_configuration_unlocked(&orchestrator).is_ok());
    }

    #[test]
    fn stale_recovery_journal_without_owned_capture_does_not_block_exit() {
        assert!(!should_block_exit_for_recovery(true, false));
        assert!(should_block_exit_for_recovery(true, true));
        assert!(!should_block_exit_for_recovery(false, true));
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
        assert_eq!(
            session_proxy_password(&vault, &proxy_session(&options)),
            None
        );
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
                &ssh_session(
                    AuthMethod::PrivateKey {
                        key_path: "  ".into()
                    },
                    "{}"
                )
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

    #[test]
    fn classify_client_maps_known_families() {
        // (process image name, expected id, expected label)
        let cases = [
            ("Clash Verge.exe", "clash", "Clash Verge"),
            ("clash-verge", "clash", "Clash Verge"),
            ("Clash for Windows.exe", "clash", "Clash"),
            ("clash-meta", "clash", "Clash"),
            ("mihomo", "mihomo", "Mihomo"),
            ("verge-mihomo.exe", "mihomo", "Mihomo"), // mihomo wins over verge
            ("sing-box.exe", "sing-box", "sing-box"),
            ("sing_box", "sing-box", "sing-box"),
            ("v2rayN.exe", "v2rayn", "v2rayN"),
            ("nekoray.exe", "nekoray", "NekoRay"),
            ("qv2ray", "qv2ray", "Qv2ray"),
            ("xray.exe", "xray", "Xray"),
            ("v2ray", "v2ray", "V2Ray"),
            ("hysteria.exe", "hysteria", "Hysteria"),
            ("sslocal", "shadowsocks", "Shadowsocks"),
        ];
        for (name, id, label) in cases {
            let (got_id, got_label) = classify_client(name);
            assert_eq!(got_id, id, "id for {name}");
            assert_eq!(got_label, label, "label for {name}");
        }
    }

    #[test]
    fn classify_client_unknown_has_empty_label() {
        for name in ["chrome.exe", "node", "", "postgres", "svchost.exe"] {
            let (id, label) = classify_client(name);
            assert_eq!(id, "unknown", "unexpected id for {name}");
            assert!(label.is_empty(), "unexpected label for {name}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_unapplied_preparing_journal_can_clear_during_pending_approval() {
        let mut journal = RecoveryJournal {
            platform: "macos".into(),
            capture_backend: "mitmproxy-redirector".into(),
            config_hash: "hash".into(),
            pid: 1,
            clean: false,
            phase: RecoveryPhase::Preparing,
            session_id: "session".into(),
            backend_version: Some("0.12.11".into()),
            scope_hash: None,
            bridge_pid: None,
            provider_pid: None,
            relay_port: None,
            helper_port: None,
        };
        assert!(pending_approval_never_recorded_scope(&journal));

        journal.scope_hash = Some("scope".into());
        assert!(!pending_approval_never_recorded_scope(&journal));
        journal.scope_hash = None;
        journal.phase = RecoveryPhase::Active;
        assert!(!pending_approval_never_recorded_scope(&journal));
    }
}
