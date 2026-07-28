//! Transparent capture backend for macOS (`NETransparentProxyProvider`).
//!
//! The per-flow decision and the control protocol are defined once in the
//! [`sockscap_core`] crate and linked into both the Taomni engine (here, as an
//! rlib) and the macOS system extension (as a staticlib, called over the
//! [`sockscap_core::ffi`] C-ABI). This module is the **engine-side** glue:
//!
//! * [`decision`] — re-exports the core gate + [`decision::selected_from_config`],
//!   which builds a selection from Taomni's config.
//! * [`control`] — re-exports the core protocol types.
//! * [`adapter`] — the macOS-only `AF_UNIX` server loop + the activation stub
//!   that fails fast until the Network Extension bundle exists.
//!
//! ## What runs where
//!
//! * [`decision`] / [`control`] — platform-independent, always built + tested.
//! * [`adapter`] — the `AF_UNIX` control-server the engine runs so the provider
//!   can authenticate and heartbeat. It needs only `std`/`tokio` Unix sockets,
//!   so it builds and is unit-tested on **all Unix** (not just macOS); only the
//!   thing it *cannot* fake — activating the system extension — is macOS-gated.
//! * [`activation`] — locating the extension bundle (pure, tested everywhere)
//!   and, on macOS only, submitting `OSSystemExtensionRequest` through a small
//!   C shim. Bundle absent ⇒ [`activation::ENTITLEMENT_UNAVAILABLE`], so the
//!   engine never reports Active for a capture plane that is not installed.
//!
//! Real activation is still **Blocked-on-infra** (Apple Network Extension
//! entitlement, Developer ID, notarization, on-device approval). The runtime is
//! wired to *use* the transparent backend when the signed extension is present
//! and connects back over the control channel, and to fall back to the Phase 1
//! system-proxy backend otherwise.

pub mod activation;
pub mod control;
pub mod decision;
pub mod provider_config;
pub mod runtime;

#[cfg(unix)]
pub mod adapter;

pub use control::{
    CONTROL_PROTOCOL_VERSION, ControlRequest, ControlResponse, ControlServer, ControlState,
};
pub use decision::{
    ProviderFlowDecision, SelectedApps, macos_provider_decision, selected_from_config,
};
pub use runtime::{MacosBackend, choose_macos_backend, wait_for_provider};
