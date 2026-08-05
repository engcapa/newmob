//! Linux transparent-capture backend.
//!
//! The backend is deliberately split into pure PID/rule primitives and the
//! small privileged lifecycle that joins them. nftables redirects selected TCP
//! OUTPUT flows to the loopback relay; the relay recovers the original target
//! with `SO_ORIGINAL_DST` and reuses SocksCap's shared policy/egress engine.

pub mod cgroup;
pub mod exec;
pub mod launched;
pub mod pid_filter;
pub mod relay;
pub mod tunnel;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::sockscap::config::{AppSelector, ScopeMode, SocksCapConfig};
use crate::sockscap::relay::RelayContext;

/// A running Linux capture session. Dropping it is intentionally inert: callers
/// must call [`Self::stop`] so failures are visible and recovery can be offered.
pub struct TransparentCaptureHandle {
    relay_port: u16,
    relays: Vec<crate::sockscap::relay::RelayHandle>,
    redirect: tunnel::NftRedirect,
    cgroups: Arc<Mutex<cgroup::CgroupSession>>,
    sudo_password: Option<Arc<Zeroizing<String>>>,
    app_monitor: Option<AppProcessMonitor>,
}

impl TransparentCaptureHandle {
    pub fn relay_port(&self) -> u16 {
        self.relay_port
    }

    /// Remove redirect rules before stopping the relay, then restore all cgroup
    /// assignments. This ordering prevents new intercepted connections from
    /// reaching a relay that is already shutting down.
    pub async fn stop(&mut self) -> Result<(), String> {
        if let Some(monitor) = self.app_monitor.take() {
            monitor.stop().await;
        }
        let sudo_password = self.sudo_password.clone();
        let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
        let mut errors = Vec::new();
        if let Err(error) = self.redirect.remove(sudo_pw) {
            errors.push(error);
        }
        for relay in self.relays.drain(..) {
            relay.stop().await;
        }
        if let Err(error) = self.cgroups.lock().await.cleanup(sudo_pw) {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[async_trait]
pub trait LinuxCapture: Send + Sync {
    fn preflight(&self, sudo_password: Option<&str>) -> Result<(), String>;

    async fn start(
        &self,
        config: &SocksCapConfig,
        ctx: Arc<RwLock<RelayContext>>,
        sudo_password: Option<String>,
    ) -> Result<TransparentCaptureHandle, String>;
}

#[derive(Debug, Default)]
pub struct LinuxCaptureImpl;

/// Read-only capability probe used by the UI and backend selector.  It does
/// not create cgroups or mutate nftables state.
pub fn transparent_preflight() -> Result<(), String> {
    LinuxCaptureImpl.preflight(None)
}

/// Container detection is explanatory only; backend selection is driven by
/// the actual transparent-capture probe above.
pub fn is_containerized() -> bool {
    std::path::Path::new("/.dockerenv").exists()
        || std::path::Path::new("/run/.containerenv").exists()
        || std::fs::read_to_string("/proc/1/cgroup")
            .ok()
            .is_some_and(|value| {
                value.contains("docker")
                    || value.contains("containerd")
                    || value.contains("kubepods")
                    || value.contains("libpod")
            })
}

#[derive(Debug, Clone)]
struct AppCaptureProfile {
    id: String,
    selectors: Vec<AppSelector>,
}

#[derive(Debug)]
enum CaptureScope {
    Global,
    Apps(Vec<AppCaptureProfile>),
    /// Higher-priority application profiles followed by the first active
    /// global profile, which is the final catch-all by policy semantics.
    Mixed(Vec<AppCaptureProfile>),
}

struct AppProcessMonitor {
    stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl AppProcessMonitor {
    fn spawn(
        profiles: Vec<AppCaptureProfile>,
        cgroups: Arc<Mutex<cgroup::CgroupSession>>,
        sudo_password: Option<Arc<Zeroizing<String>>>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_task = Arc::clone(&stop);
        let selector_groups = profiles
            .into_iter()
            .map(|profile| profile.selectors)
            .collect::<Vec<_>>();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if stop_for_task.load(Ordering::SeqCst) {
                    break;
                }
                let target_groups = match pid_filter::resolve_target_pid_groups(&selector_groups) {
                    Ok(target_groups) => target_groups,
                    Err(error) => {
                        tracing::warn!("Linux SocksCap app process scan failed: {error}");
                        continue;
                    }
                };
                let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
                let mut session = cgroups.lock().await;
                for (profile_index, pids) in target_groups.iter().enumerate() {
                    for pid in pids {
                        match session.move_app_pid(profile_index, *pid, sudo_pw) {
                            Ok(true) => tracing::info!(
                                pid,
                                profile_index,
                                "Linux SocksCap attached newly-started application"
                            ),
                            Ok(false) => {}
                            Err(error) => tracing::warn!(
                                pid,
                                profile_index,
                                "Linux SocksCap could not attach application: {error}"
                            ),
                        }
                    }
                }
            }
        });
        Self { stop, task }
    }

    async fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let mut task = self.task;
        tokio::select! {
            _ = &mut task => {}
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                tracing::warn!("Linux SocksCap app process monitor did not stop promptly");
                task.abort();
                let _ = task.await;
            }
        }
    }
}

#[async_trait]
impl LinuxCapture for LinuxCaptureImpl {
    fn preflight(&self, sudo_password: Option<&str>) -> Result<(), String> {
        cgroup::CgroupSession::preflight()?;
        tunnel::NftRedirect::preflight(sudo_password)?;
        Ok(())
    }

    async fn start(
        &self,
        config: &SocksCapConfig,
        ctx: Arc<RwLock<RelayContext>>,
        sudo_password: Option<String>,
    ) -> Result<TransparentCaptureHandle, String> {
        let scope = capture_scope(config)?;
        let sudo_password = sudo_password.map(|password| Arc::new(Zeroizing::new(password)));
        let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
        self.preflight(sudo_pw)?;

        let cgroups = match &scope {
            CaptureScope::Global => {
                cgroup::CgroupSession::prepare_global(std::process::id(), sudo_pw)?
            }
            CaptureScope::Apps(profiles) => {
                let selector_groups = profiles
                    .iter()
                    .map(|profile| profile.selectors.clone())
                    .collect::<Vec<_>>();
                let target_groups = pid_filter::resolve_target_pid_groups(&selector_groups)?;
                cgroup::CgroupSession::prepare_apps(&target_groups, std::process::id(), sudo_pw)?
            }
            CaptureScope::Mixed(profiles) => {
                let selector_groups = profiles
                    .iter()
                    .map(|profile| profile.selectors.clone())
                    .collect::<Vec<_>>();
                let target_groups = pid_filter::resolve_target_pid_groups(&selector_groups)?;
                cgroup::CgroupSession::prepare_mixed(&target_groups, std::process::id(), sudo_pw)?
            }
        };
        let cgroups = Arc::new(Mutex::new(cgroups));

        let mut relays = Vec::new();
        let relay_result: Result<(), String> = match &scope {
            CaptureScope::Global => match relay::start_linux_relay(Arc::clone(&ctx), None).await {
                Ok(relay) => {
                    relays.push(relay);
                    Ok(())
                }
                Err(error) => Err(error),
            },
            CaptureScope::Apps(profiles) => {
                let mut result = Ok(());
                for profile in profiles {
                    match relay::start_linux_relay(Arc::clone(&ctx), Some(profile.id.clone())).await
                    {
                        Ok(relay) => relays.push(relay),
                        Err(error) => {
                            result = Err(error);
                            break;
                        }
                    }
                }
                result
            }
            CaptureScope::Mixed(profiles) => {
                let mut result = Ok(());
                for profile in profiles {
                    match relay::start_linux_relay(Arc::clone(&ctx), Some(profile.id.clone())).await
                    {
                        Ok(relay) => relays.push(relay),
                        Err(error) => {
                            result = Err(error);
                            break;
                        }
                    }
                }
                if result.is_ok() {
                    match relay::start_linux_relay(Arc::clone(&ctx), None).await {
                        Ok(relay) => relays.push(relay),
                        Err(error) => result = Err(error),
                    }
                }
                result
            }
        };
        if let Err(error) = relay_result {
            stop_relays(relays).await;
            let _ = cgroups.lock().await.cleanup(sudo_pw);
            return Err(error);
        }

        let relay_port = relays
            .get(match &scope {
                CaptureScope::Mixed(profiles) => profiles.len(),
                CaptureScope::Global | CaptureScope::Apps(_) => 0,
            })
            .map(|relay| relay.handle.port)
            .ok_or_else(|| "Linux capture did not create a relay".to_string())?;
        let redirect_ipv6 = relays.iter().all(|relay| relay.ipv6_ready);
        let plan_result = {
            let session = cgroups.lock().await;
            match &scope {
                CaptureScope::Global => tunnel::RedirectPlan::new(
                    ScopeMode::Global,
                    relay_port,
                    redirect_ipv6,
                    &config.bypass_cidrs,
                    session.bypass_match(),
                    &[],
                    config.block_quic,
                ),
                CaptureScope::Apps(_) => {
                    let routes = session
                        .capture_matches()
                        .iter()
                        .cloned()
                        .zip(relays.iter().map(|relay| relay.handle.port))
                        .collect::<Vec<_>>();
                    tunnel::RedirectPlan::new_app_routes(
                        redirect_ipv6,
                        &config.bypass_cidrs,
                        &routes,
                        config.block_quic,
                    )
                }
                CaptureScope::Mixed(profiles) => {
                    let routes = session
                        .capture_matches()
                        .iter()
                        .cloned()
                        .zip(
                            relays
                                .iter()
                                .take(profiles.len())
                                .map(|relay| relay.handle.port),
                        )
                        .collect::<Vec<_>>();
                    tunnel::RedirectPlan::new_mixed_routes(
                        relay_port,
                        redirect_ipv6,
                        &config.bypass_cidrs,
                        session.bypass_match(),
                        &routes,
                        config.block_quic,
                    )
                }
            }
        };
        let plan = match plan_result {
            Ok(plan) => plan,
            Err(error) => {
                stop_relays(relays).await;
                let _ = cgroups.lock().await.cleanup(sudo_pw);
                return Err(error);
            }
        };

        let redirect = match tunnel::NftRedirect::install(&plan, sudo_pw) {
            Ok(redirect) => redirect,
            Err(error) => {
                stop_relays(relays).await;
                let _ = cgroups.lock().await.cleanup(sudo_pw);
                return Err(error);
            }
        };
        let app_monitor = match &scope {
            CaptureScope::Global => None,
            CaptureScope::Apps(profiles) => Some(AppProcessMonitor::spawn(
                profiles.clone(),
                Arc::clone(&cgroups),
                sudo_password.clone(),
            )),
            CaptureScope::Mixed(profiles) => Some(AppProcessMonitor::spawn(
                profiles.clone(),
                Arc::clone(&cgroups),
                sudo_password.clone(),
            )),
        };

        tracing::info!(
            relay_port,
            mode = ?scope,
            app_profiles = match &scope {
                CaptureScope::Global => 0,
                CaptureScope::Apps(profiles) | CaptureScope::Mixed(profiles) => profiles.len(),
            },
            "sockscap Linux nftables transparent capture started"
        );
        Ok(TransparentCaptureHandle {
            relay_port,
            relays: relays.into_iter().map(|relay| relay.handle).collect(),
            redirect,
            cgroups,
            sudo_password,
            app_monitor,
        })
    }
}

/// Runtime-selected Linux backend. Transparent capture preserves the existing
/// nft/cgroup implementation; launched capture owns only loopback listeners and
/// applications explicitly started from SocksCap.
pub enum LinuxCaptureHandle {
    Transparent(TransparentCaptureHandle),
    Launched(launched::LaunchedCaptureHandle),
}

impl LinuxCaptureHandle {
    pub fn relay_port(&self) -> u16 {
        match self {
            Self::Transparent(capture) => capture.relay_port(),
            Self::Launched(capture) => capture.relay_port(),
        }
    }

    pub fn is_launch_only(&self) -> bool {
        matches!(self, Self::Launched(_))
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        match self {
            Self::Transparent(capture) => capture.stop().await,
            Self::Launched(capture) => {
                capture.stop().await;
                Ok(())
            }
        }
    }

    pub async fn launch_app(
        &mut self,
        profile_id: &str,
        command: &str,
        args: &[String],
    ) -> Result<launched::LaunchedAppInfo, String> {
        match self {
            Self::Launched(capture) => capture.launch_app(profile_id, command, args).await,
            Self::Transparent(_) => Err(
                "the active Linux backend captures applications transparently; launch-only control is unavailable"
                    .into(),
            ),
        }
    }

    pub fn launch_terminal_app(
        &mut self,
        profile_id: &str,
        command: &str,
        args: &[String],
        terminal_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<
        (
            launched::LaunchedAppInfo,
            crate::terminal::pty::PtyHandle,
            Box<dyn std::io::Read + Send>,
        ),
        String,
    > {
        match self {
            Self::Launched(capture) => capture.launch_terminal_app(
                profile_id,
                command,
                args,
                terminal_session_id,
                cols,
                rows,
            ),
            Self::Transparent(_) => Err(
                "the active Linux backend captures applications transparently; launch-only control is unavailable"
                    .into(),
            ),
        }
    }

    pub fn launched_apps(&mut self) -> Vec<launched::LaunchedAppInfo> {
        match self {
            Self::Launched(capture) => capture.apps(),
            Self::Transparent(_) => Vec::new(),
        }
    }

    pub async fn stop_launched_app(&mut self, pid: u32) -> Result<(), String> {
        match self {
            Self::Launched(capture) => capture.stop_app(pid).await,
            Self::Transparent(_) => Err("the active Linux backend is not launch-only".into()),
        }
    }
}

async fn stop_relays(relays: Vec<relay::LinuxRelay>) {
    for relay in relays {
        relay.handle.stop().await;
    }
}

pub fn recover_system(sudo_password: Option<&str>) -> Result<(), String> {
    tunnel::recover_rules(sudo_password)?;
    match cgroup::cleanup_empty_sessions(sudo_password) {
        Ok(()) => Ok(()),
        // The nft table is already removed. A live cgroup cannot be safely
        // moved by recovery, so leave it for the owning process and explain it.
        Err(error) => Err(format!(
            "nftables rules removed; cgroup cleanup incomplete: {error}"
        )),
    }
}

fn capture_scope(config: &SocksCapConfig) -> Result<CaptureScope, String> {
    let active_profiles = config.active_profiles();
    if active_profiles.is_empty() {
        return Err("At least one profile must be enabled and active".into());
    }
    let mut app_profiles = Vec::new();
    for profile in active_profiles {
        match profile.mode {
            ScopeMode::Apps => app_profiles.push(AppCaptureProfile {
                id: profile.id.clone(),
                selectors: profile.apps.clone(),
            }),
            ScopeMode::Global if app_profiles.is_empty() => return Ok(CaptureScope::Global),
            ScopeMode::Global => return Ok(CaptureScope::Mixed(app_profiles)),
        }
    }
    Ok(CaptureScope::Apps(app_profiles))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::config::SocksCapConfig;

    #[test]
    fn default_config_uses_global_capture() {
        let config = SocksCapConfig::default();
        assert!(matches!(
            capture_scope(&config).unwrap(),
            CaptureScope::Global
        ));
    }

    #[test]
    fn app_capture_scope_does_not_require_a_running_pid() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![AppSelector {
            path: "/opt/example/example".into(),
            args: Vec::new(),
            launch_mode: Default::default(),
            bundle_id: String::new(),
            name: "Example".into(),
            macos_identity: None,
        }];
        let CaptureScope::Apps(profiles) = capture_scope(&config).unwrap() else {
            panic!("expected app capture scope");
        };
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "default");
    }

    #[test]
    fn mixed_capture_keeps_only_apps_before_the_global_catch_all() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].id = "agy".into();
        config.profiles[0].priority = 1;
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![AppSelector {
            path: "/opt/agy/agy".into(),
            args: Vec::new(),
            launch_mode: Default::default(),
            bundle_id: String::new(),
            name: "agy".into(),
            macos_identity: None,
        }];

        let mut global = config.profiles[0].clone();
        global.id = "global".into();
        global.priority = 2;
        global.mode = ScopeMode::Global;
        global.apps.clear();
        let mut unreachable_app = config.profiles[0].clone();
        unreachable_app.id = "lower-app".into();
        unreachable_app.priority = 3;
        config.profiles.extend([global, unreachable_app]);
        config.active_profile_ids = vec!["agy".into(), "global".into(), "lower-app".into()];

        let CaptureScope::Mixed(profiles) = capture_scope(&config).unwrap() else {
            panic!("expected mixed capture scope");
        };
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "agy");
    }

    #[test]
    fn a_highest_priority_global_profile_is_the_only_capture_scope() {
        let mut config = SocksCapConfig::default();
        let mut lower_app = config.profiles[0].clone();
        lower_app.id = "lower-app".into();
        lower_app.priority = 10;
        lower_app.mode = ScopeMode::Apps;
        lower_app.apps = vec![AppSelector {
            path: "/opt/example/example".into(),
            args: Vec::new(),
            launch_mode: Default::default(),
            bundle_id: String::new(),
            name: "Example".into(),
            macos_identity: None,
        }];
        config.profiles.push(lower_app);
        config.active_profile_ids = vec!["default".into(), "lower-app".into()];

        assert!(matches!(
            capture_scope(&config).unwrap(),
            CaptureScope::Global
        ));
    }
}
