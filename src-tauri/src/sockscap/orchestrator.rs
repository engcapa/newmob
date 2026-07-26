//! SocksCap engine state machine.

use crate::sockscap::capture::SocksCapCapabilities;
#[cfg(target_os = "linux")]
use crate::sockscap::capture::linux::LinuxCaptureHandle;
#[cfg(target_os = "macos")]
use crate::sockscap::capture::macos::MacosCaptureHandle;
use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::relay::RelayHandle;
use crate::sockscap::rules::{CompiledRules, GfwListMeta};
use crate::sockscap::stats::{StatsCounters, StatsSnapshot};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnginePhase {
    Idle,
    Preparing,
    Active,
    Degraded,
    Stopping,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapStatus {
    pub phase: EnginePhase,
    pub message: String,
    pub rule_count: usize,
    pub capture_backend: String,
}

pub struct Orchestrator {
    phase: EnginePhase,
    message: String,
    config: Option<SocksCapConfig>,
    rules: Option<Arc<CompiledRules>>,
    pub stats: Arc<StatsCounters>,
    pub domains: Arc<std::sync::Mutex<crate::sockscap::stats::DomainTracker>>,
    capture_backend: String,
    /// Active local relay (if capture is running).
    pub relay: Option<RelayHandle>,
    /// Linux owns both the nftables rules and its loopback relay as one
    /// lifecycle unit, so the two can be removed in the safe order.
    #[cfg(target_os = "linux")]
    linux_capture: Option<LinuxCaptureHandle>,
    /// macOS owns the system-proxy settings and its loopback ingress as one
    /// lifecycle unit, so the proxy is restored before the listener goes away.
    #[cfg(target_os = "macos")]
    macos_capture: Option<MacosCaptureHandle>,
    /// Shared with the relay task so config/rules can hot-reload while Active.
    pub relay_ctx:
        Option<std::sync::Arc<tokio::sync::RwLock<crate::sockscap::relay::RelayContext>>>,
    /// Signal DNS cache refresher to exit when capture stops.
    pub dns_stop: Option<Arc<AtomicBool>>,
}

impl Orchestrator {
    pub fn new() -> Self {
        Self {
            phase: EnginePhase::Idle,
            message: "idle".into(),
            config: None,
            rules: None,
            stats: Arc::new(StatsCounters::default()),
            domains: Arc::new(std::sync::Mutex::new(
                crate::sockscap::stats::DomainTracker::new(200),
            )),
            capture_backend: "none".into(),
            relay: None,
            #[cfg(target_os = "linux")]
            linux_capture: None,
            #[cfg(target_os = "macos")]
            macos_capture: None,
            relay_ctx: None,
            dns_stop: None,
        }
    }

    pub fn apply_config(&mut self, cfg: SocksCapConfig) {
        self.config = Some(cfg);
    }

    pub fn config(&self) -> Option<&SocksCapConfig> {
        self.config.as_ref()
    }

    pub fn set_rules(&mut self, rules: CompiledRules) {
        self.rules = Some(Arc::new(rules));
    }

    pub fn rules(&self) -> Option<&CompiledRules> {
        self.rules.as_deref()
    }

    pub fn rules_arc(&self) -> Option<Arc<CompiledRules>> {
        self.rules.clone()
    }

    pub fn gfwlist_meta(&self) -> Option<&GfwListMeta> {
        self.rules.as_ref().map(|r| &r.meta)
    }

    pub fn status(&self) -> SocksCapStatus {
        SocksCapStatus {
            phase: self.phase,
            message: self.message.clone(),
            rule_count: self.rules.as_ref().map(|r| r.meta.rule_count).unwrap_or(0),
            capture_backend: self.capture_backend.clone(),
        }
    }

    pub fn stats_snapshot(&self) -> StatsSnapshot {
        self.stats.snapshot()
    }

    pub fn set_preparing(&mut self, backend: &str) {
        self.phase = EnginePhase::Preparing;
        self.capture_backend = backend.to_string();
        self.message = "preparing capture".into();
        // Fresh session counters for the dashboard.
        self.stats.reset();
    }

    pub fn set_active(&mut self, backend: &str, message: impl Into<String>) {
        self.phase = EnginePhase::Active;
        self.capture_backend = backend.to_string();
        self.message = message.into();
    }

    pub fn set_degraded(&mut self, backend: &str, message: impl Into<String>) {
        self.phase = EnginePhase::Degraded;
        self.capture_backend = backend.to_string();
        self.message = message.into();
    }

    /// A Start attempt failed before it installed an active capture handle.
    ///
    /// This is intentionally distinct from [`Self::set_degraded`]: degraded
    /// represents a running fallback/partially operational session and must
    /// remain stoppable, while a failed preflight must be immediately
    /// retryable (for example after the user supplies sudo credentials).
    pub fn set_start_failed(&mut self, message: impl Into<String>) {
        self.phase = EnginePhase::Idle;
        self.capture_backend = "none".into();
        self.message = message.into();
    }

    /// Capture teardown was incomplete. Keep this distinct from `Idle` so the
    /// UI can direct the user to Recover instead of claiming the host's
    /// networking state is clean.
    pub fn set_recovery_required(&mut self, backend: &str, message: impl Into<String>) {
        self.phase = EnginePhase::RecoveryRequired;
        self.capture_backend = backend.to_string();
        self.message = message.into();
    }

    /// Phase-1 fallback when OS capture is unavailable.
    pub fn start_stub(&mut self, caps: &SocksCapCapabilities) -> Result<(), String> {
        if matches!(
            self.phase,
            EnginePhase::Active | EnginePhase::Preparing | EnginePhase::Degraded
        ) {
            return Err("sockscap already running".into());
        }
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| "no config loaded".to_string())?;
        cfg.validate()?;

        self.phase = EnginePhase::Preparing;
        self.capture_backend = caps.capture_backend.clone();
        self.phase = EnginePhase::Degraded;
        self.message = format!(
            "rules engine ready; capture unavailable on {} ({})",
            caps.platform,
            caps.notes.first().cloned().unwrap_or_default()
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn set_linux_capture(&mut self, capture: LinuxCaptureHandle) {
        self.linux_capture = Some(capture);
    }

    #[cfg(target_os = "linux")]
    pub fn take_linux_capture_for_stop(&mut self) -> Option<LinuxCaptureHandle> {
        if !matches!(self.phase, EnginePhase::Idle) {
            self.phase = EnginePhase::Stopping;
            self.message = "stopping".into();
        }
        self.linux_capture.take()
    }

    #[cfg(target_os = "linux")]
    pub fn relay_port(&self) -> Option<u16> {
        self.relay.as_ref().map(|relay| relay.port).or_else(|| {
            self.linux_capture
                .as_ref()
                .map(LinuxCaptureHandle::relay_port)
        })
    }

    #[cfg(target_os = "macos")]
    pub fn set_macos_capture(&mut self, capture: MacosCaptureHandle) {
        self.macos_capture = Some(capture);
    }

    #[cfg(target_os = "macos")]
    pub fn take_macos_capture_for_stop(&mut self) -> Option<MacosCaptureHandle> {
        if !matches!(self.phase, EnginePhase::Idle) {
            self.phase = EnginePhase::Stopping;
            self.message = "stopping".into();
        }
        self.macos_capture.take()
    }

    #[cfg(target_os = "macos")]
    pub fn relay_port(&self) -> Option<u16> {
        self.relay.as_ref().map(|relay| relay.port).or_else(|| {
            self.macos_capture
                .as_ref()
                .map(MacosCaptureHandle::ingress_port)
        })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn relay_port(&self) -> Option<u16> {
        self.relay.as_ref().map(|relay| relay.port)
    }

    /// Take the running relay out so the caller can stop it without holding
    /// the orchestrator write lock (avoids deadlocking status/stats polls).
    pub fn take_relay_for_stop(&mut self) -> Option<RelayHandle> {
        if !matches!(self.phase, EnginePhase::Idle) {
            self.phase = EnginePhase::Stopping;
            self.message = "stopping".into();
        }
        self.relay.take()
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        let no_platform_capture = self.linux_capture.is_none();
        #[cfg(target_os = "macos")]
        let no_platform_capture = self.macos_capture.is_none();
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let no_platform_capture = true;

        if matches!(self.phase, EnginePhase::Idle) && self.relay.is_none() && no_platform_capture {
            return Ok(());
        }
        self.phase = EnginePhase::Stopping;
        let capture_backend = self.capture_backend.clone();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let mut errors = Vec::new();
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let errors: Vec<String> = Vec::new();
        #[cfg(target_os = "linux")]
        if let Some(capture) = self.linux_capture.take() {
            if let Err(error) = capture.stop().await {
                errors.push(error);
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(capture) = self.macos_capture.take() {
            if let Err(error) = capture.stop().await {
                errors.push(error);
            }
        }
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
        self.finish_stop();
        if errors.is_empty() {
            Ok(())
        } else {
            let error = errors.join("; ");
            self.set_recovery_required(&capture_backend, error.clone());
            Err(error)
        }
    }

    /// Clear runtime handles after relay has been stopped (or abandoned).
    pub fn finish_stop(&mut self) {
        if let Some(flag) = self.dns_stop.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.relay_ctx = None;
        self.relay = None;
        #[cfg(target_os = "linux")]
        {
            self.linux_capture = None;
        }
        #[cfg(target_os = "macos")]
        {
            self.macos_capture = None;
        }
        self.message = "stopped".into();
        self.phase = EnginePhase::Idle;
        self.capture_backend = "none".into();
    }

    pub fn force_idle(&mut self) {
        if let Some(flag) = self.dns_stop.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.phase = EnginePhase::Idle;
        self.message = "recovered".into();
        self.capture_backend = "none".into();
        self.relay_ctx = None;
        self.relay = None;
        #[cfg(target_os = "linux")]
        {
            self.linux_capture = None;
        }
        #[cfg(target_os = "macos")]
        {
            self.macos_capture = None;
        }
    }

    /// Hot-update policy surface used by the running relay.
    pub async fn hot_reload_policy(
        &self,
        cfg: SocksCapConfig,
        rules: Option<crate::sockscap::rules::CompiledRules>,
    ) {
        if let Some(ctx) = &self.relay_ctx {
            let mut g = ctx.write().await;
            g.config = cfg;
            if let Some(r) = rules {
                g.rules = Some(r);
            }
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(
            self.phase,
            EnginePhase::Active | EnginePhase::Preparing | EnginePhase::Degraded
        )
    }
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_start_returns_to_a_retryable_idle_state() {
        let mut orchestrator = Orchestrator::new();
        orchestrator.set_preparing("nft-cgroup-redirect");

        orchestrator.set_start_failed("authorization required");

        let status = orchestrator.status();
        assert_eq!(status.phase, EnginePhase::Idle);
        assert_eq!(status.capture_backend, "none");
        assert_eq!(status.message, "authorization required");
        assert!(!orchestrator.is_running());
    }
}
