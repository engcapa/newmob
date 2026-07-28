//! Linux transparent-capture backend.
//!
//! The backend is deliberately split into pure PID/rule primitives and the
//! small privileged lifecycle that joins them. nftables redirects selected TCP
//! OUTPUT flows to the loopback relay; the relay recovers the original target
//! with `SO_ORIGINAL_DST` and reuses SocksCap's shared policy/egress engine.

pub mod cgroup;
pub mod exec;
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
pub struct LinuxCaptureHandle {
    relay_port: u16,
    relays: Vec<crate::sockscap::relay::RelayHandle>,
    redirect: tunnel::NftRedirect,
    cgroups: Arc<Mutex<cgroup::CgroupSession>>,
    sudo_password: Option<Arc<Zeroizing<String>>>,
    app_monitor: Option<AppProcessMonitor>,
}

impl LinuxCaptureHandle {
    pub fn relay_port(&self) -> u16 {
        self.relay_port
    }

    /// Remove redirect rules before stopping the relay, then restore all cgroup
    /// assignments. This ordering prevents new intercepted connections from
    /// reaching a relay that is already shutting down.
    pub async fn stop(mut self) -> Result<(), String> {
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
    ) -> Result<LinuxCaptureHandle, String>;
}

#[derive(Debug, Default)]
pub struct LinuxCaptureImpl;

#[derive(Debug, Clone)]
struct AppCaptureProfile {
    id: String,
    selectors: Vec<AppSelector>,
}

#[derive(Debug)]
enum CaptureScope {
    Global,
    Apps(Vec<AppCaptureProfile>),
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
    ) -> Result<LinuxCaptureHandle, String> {
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
        };
        if let Err(error) = relay_result {
            stop_relays(relays).await;
            let _ = cgroups.lock().await.cleanup(sudo_pw);
            return Err(error);
        }

        let relay_port = relays
            .first()
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
        };

        tracing::info!(
            relay_port,
            mode = ?scope,
            app_profiles = match &scope {
                CaptureScope::Global => 0,
                CaptureScope::Apps(profiles) => profiles.len(),
            },
            "sockscap Linux nftables transparent capture started"
        );
        Ok(LinuxCaptureHandle {
            relay_port,
            relays: relays.into_iter().map(|relay| relay.handle).collect(),
            redirect,
            cgroups,
            sudo_password,
            app_monitor,
        })
    }
}

async fn stop_relays(relays: Vec<relay::LinuxRelay>) {
    for relay in relays {
        relay.handle.stop().await;
    }
}

pub fn recover_system(sudo_password: Option<&str>) -> Result<(), String> {
    tunnel::recover_rules(sudo_password)?;
    match cgroup::cleanup_empty_sessions() {
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
    if active_profiles
        .iter()
        .any(|profile| matches!(profile.mode, ScopeMode::Global))
    {
        return Ok(CaptureScope::Global);
    }
    Ok(CaptureScope::Apps(
        active_profiles
            .into_iter()
            .map(|profile| AppCaptureProfile {
                id: profile.id.clone(),
                selectors: profile.apps.clone(),
            })
            .collect(),
    ))
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
            bundle_id: String::new(),
            name: "Example".into(),
        }];
        let CaptureScope::Apps(profiles) = capture_scope(&config).unwrap() else {
            panic!("expected app capture scope");
        };
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "default");
    }
}
