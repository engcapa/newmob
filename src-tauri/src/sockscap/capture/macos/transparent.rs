//! macOS transparent capture backend — the runtime wiring (macOS only).
//!
//! AUTHORED, PARTIALLY-VERIFIABLE. Every non-trivial decision this file makes is
//! delegated to helpers that build and are unit-tested on all Unix:
//! [`choose_macos_backend`], [`ControlServerHandle`], [`wait_for_provider`],
//! [`ProviderConfig`], [`selected_from_config`], and the loopback
//! [`ingress`](crate::sockscap::ingress). What lives *only* here is the glue that
//! cannot run without macOS + a signed extension: submitting activation and
//! (the remaining infra step) starting the `NEAppProxyProviderManager` tunnel and
//! delivering [`ProviderConfig`] to the provider.
//!
//! ## Lifecycle contract
//!
//! [`start`] brings up the loopback ingress and the `AF_UNIX` control server,
//! submits system-extension activation, then waits a bounded time for the
//! provider to connect and authenticate. If it does, the transparent plane is
//! Active. If it does not — no bundle, not yet approved, or the NE tunnel glue is
//! not wired — [`start`] tears its own resources down and returns `Err`, and the
//! caller falls back to the Phase 1 system-proxy backend. So the engine never
//! reports the transparent plane Active unless a provider is genuinely relaying.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::ingress;
use crate::sockscap::relay::{RelayContext, RelayHandle};
use crate::sockscap::transparent::adapter::{ControlServerHandle, TransparentAdapter};
use crate::sockscap::transparent::provider_config::ProviderConfig;
use crate::sockscap::transparent::{selected_from_config, wait_for_provider};

/// How long to wait for the provider to connect before falling back. Long enough
/// for an already-approved extension to launch and handshake; a first run that
/// still needs user approval exceeds this and falls back (approval prompt shown).
const PROVIDER_READY_TIMEOUT: Duration = Duration::from_secs(6);

/// A running macOS transparent capture session. Like the other capture handles,
/// dropping it is inert: [`Self::stop`] must be called so teardown failures stay
/// visible and the plane degrades to DIRECT deterministically.
pub struct MacosTransparentCaptureHandle {
    ingress_port: u16,
    ingress: Option<RelayHandle>,
    control_server: Option<ControlServerHandle>,
    #[allow(dead_code)]
    sudo_password: Option<Arc<Zeroizing<String>>>,
}

impl MacosTransparentCaptureHandle {
    /// The loopback SOCKS port the provider relays handled flows into.
    pub fn ingress_port(&self) -> u16 {
        self.ingress_port
    }

    /// Stop the control channel first (the provider then fails open to DIRECT),
    /// then the ingress — so no flow is relayed into a listener that is already
    /// shutting down. The system extension stays *installed*; Start/Stop toggles
    /// capture through the control channel + ingress, not by reinstalling it.
    pub async fn stop(mut self) -> Result<(), String> {
        if let Some(control) = self.control_server.take() {
            control.stop().await;
        }
        if let Some(ingress) = self.ingress.take() {
            ingress.stop().await;
        }
        Ok(())
    }
}

/// Start the transparent backend.
///
/// `control_socket_path` must be reachable by the provider. A production build
/// places it in the app-group container shared by the app and the system
/// extension (the extension runs as root and cannot read the app's per-user data
/// dir); that path is chosen by the caller.
pub async fn start(
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
    control_socket_path: PathBuf,
    sudo_password: Option<String>,
) -> Result<MacosTransparentCaptureHandle, String> {
    let sudo_password = sudo_password.map(|password| Arc::new(Zeroizing::new(password)));

    // TODO(sockscap-quic): honor config.block_quic on the macOS transparent NE
    // backend (see claudedocs/sockscap-quic-block-design.md §12.3). The provider
    // could see UDP 443 and drop it (forcing QUIC→TCP fallback), but the current
    // ingress only handles TCP (reads a SOCKS5/HTTP CONNECT handshake); no UDP
    // path exists. When implemented, the drop must cover the same in-scope set as
    // TCP capture and pass bypassed flows. `block_quic` is session-level in
    // SocksCapConfig and is currently unused on macOS.

    // 1) Loopback ingress the provider relays handled flows into.
    let ingress = ingress::start_ingress(ctx, None).await?;
    let ingress_port = ingress.handle.port;

    // 2) Control server + adapter (token, selection). Bind before activating so
    //    the provider has something to connect to the instant it launches.
    let selected = selected_from_config(config);
    let adapter = TransparentAdapter::new(control_socket_path.clone(), selected.clone());
    let control_server = match ControlServerHandle::bind(&control_socket_path, adapter.token()) {
        Ok(server) => server,
        Err(error) => {
            ingress.handle.stop().await;
            return Err(format!("start transparent control server: {error}"));
        }
    };

    // The configuration the provider needs (dynamic port, token, selection).
    // Delivered to the provider by the NE tunnel glue (remaining infra step).
    let provider_config = ProviderConfig::new(
        ingress_port,
        control_socket_path.to_string_lossy(),
        adapter.token(),
        &selected,
    );
    tracing::debug!(
        socks_port = ingress_port,
        "sockscap: transparent provider configuration prepared"
    );

    // 3) Submit system-extension activation. On non-macOS or without a bundled,
    //    signed extension this returns the infrastructure error; roll back.
    if let Err(error) = adapter.activate() {
        control_server.stop().await;
        ingress.handle.stop().await;
        return Err(error);
    }

    // 4) Wait (bounded) for the provider to connect + authenticate. The NE tunnel
    //    glue that delivers `provider_config` and starts relaying is the final
    //    infra step; until it exists this wait times out and the caller falls
    //    back to system-proxy, which is the correct, safe behaviour.
    let _ = &provider_config;
    let ready = wait_for_provider(control_server.ready_rx(), PROVIDER_READY_TIMEOUT).await;
    if !ready {
        control_server.stop().await;
        ingress.handle.stop().await;
        return Err(
            "macOS transparent capture: the Network Extension did not connect. Approve the \
             system extension in System Settings › Privacy & Security, then Start again. \
             Falling back to the system-proxy backend."
                .into(),
        );
    }

    tracing::info!(
        ingress_port,
        ipv6 = ingress.ipv6_ready,
        "sockscap macOS transparent capture active"
    );
    Ok(MacosTransparentCaptureHandle {
        ingress_port,
        ingress: Some(ingress.handle),
        control_server: Some(control_server),
        sudo_password,
    })
}
