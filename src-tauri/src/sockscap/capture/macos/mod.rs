//! macOS capture backend — Phase 1: system SOCKS proxy → loopback ingress.
//!
//! macOS has no equivalent of WinDivert or nftables redirect available without
//! a signed Network Extension, so this backend steers traffic the supported way:
//! the OS system-proxy setting points applications at SocksCap's loopback
//! [`ingress`](crate::sockscap::ingress), and everything past the proxy
//! handshake reuses the shared policy/egress relay.
//!
//! Consequences, all of them visible in `capabilities()`:
//!
//! * Only applications that honour the system proxy are captured. This is not
//!   transparent capture — a program that ignores proxy settings is unaffected.
//! * Scope is global. Per-application routing needs the source app's identity,
//!   which only a `NETransparentProxyProvider` can supply, so app mode is
//!   refused rather than silently proxying everything.
//!
//! Unlike the transparent backends there is no self-capture hazard: our own
//! upstream dials use plain sockets, which do not consult the system proxy, so
//! no bypass rules for our own PID or the upstream endpoint are needed.

pub mod system_proxy;

use std::sync::Arc;

use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::sockscap::config::{ScopeMode, SocksCapConfig};
use crate::sockscap::ingress;
use crate::sockscap::relay::{RelayContext, RelayHandle};

use system_proxy::SystemProxyScope;

/// A running macOS capture session. Like the Linux handle, dropping it is inert:
/// [`Self::stop`] must be called so restore failures stay visible.
pub struct MacosCaptureHandle {
    ingress_port: u16,
    ingress: Option<RelayHandle>,
    proxy: SystemProxyScope,
    sudo_password: Option<Arc<Zeroizing<String>>>,
}

impl MacosCaptureHandle {
    pub fn ingress_port(&self) -> u16 {
        self.ingress_port
    }

    /// Restore the system proxy *before* stopping the ingress, so no client is
    /// pointed at a listener that is already shutting down.
    pub async fn stop(mut self) -> Result<(), String> {
        let sudo_password = self.sudo_password.clone();
        let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
        let restore = self.proxy.restore(sudo_pw);
        if let Some(ingress) = self.ingress.take() {
            ingress.stop().await;
        }
        restore
    }
}

pub fn preflight(config: &SocksCapConfig, sudo_password: Option<&str>) -> Result<(), String> {
    let active_profiles = config.active_profiles();
    if active_profiles.is_empty() {
        return Err("At least one profile must be enabled and active".into());
    }
    // Refusing beats pretending: with no per-flow app identity, an app-scoped
    // profile would either proxy nothing or proxy everything.
    if active_profiles
        .iter()
        .all(|profile| matches!(profile.mode, ScopeMode::Apps))
    {
        return Err(
            "macOS capture currently supports Global scope only (system proxy mode). \
             Switch the active profile to Global; per-application routing needs the \
             macOS Network Extension backend."
                .into(),
        );
    }
    system_proxy::preflight(sudo_password)
}

pub async fn start(
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
    sudo_password: Option<String>,
) -> Result<MacosCaptureHandle, String> {
    let sudo_password = sudo_password.map(|password| Arc::new(Zeroizing::new(password)));
    let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
    preflight(config, sudo_pw)?;

    let ingress = ingress::start_ingress(ctx, None).await?;
    let ingress_port = ingress.handle.port;

    let proxy = match SystemProxyScope::apply(ingress_port, sudo_pw) {
        Ok(proxy) => proxy,
        Err(error) => {
            ingress.handle.stop().await;
            return Err(error);
        }
    };

    tracing::info!(
        ingress_port,
        ipv6 = ingress.ipv6_ready,
        "sockscap macOS system-proxy capture started"
    );
    Ok(MacosCaptureHandle {
        ingress_port,
        ingress: Some(ingress.handle),
        proxy,
        sudo_password,
    })
}

/// Undo system-proxy state left behind by an unclean shutdown.
///
/// Only services still pointing at a loopback SOCKS proxy are touched, so a
/// proxy the user configured themselves is left alone.
pub fn recover_system(sudo_password: Option<&str>) -> Result<(), String> {
    system_proxy::clear_loopback_proxies(sudo_password)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_scoped_profiles_are_refused_instead_of_over_capturing() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = ScopeMode::Apps;

        let error = preflight(&config, Some("password")).unwrap_err();

        assert!(error.contains("Global scope only"));
    }

    #[test]
    fn a_global_profile_passes_scope_validation() {
        let config = SocksCapConfig::default();
        assert!(matches!(config.profiles[0].mode, ScopeMode::Global));

        // Scope is fine, so only the privilege precondition can fail here.
        if let Err(error) = preflight(&config, Some("password")) {
            assert!(!error.contains("Global scope only"), "unexpected: {error}");
        }
    }
}
