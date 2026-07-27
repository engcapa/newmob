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
//! It is deliberately dormant: nothing here is wired into
//! [`sockscap_start`](crate::sockscap::sockscap_start) yet, and
//! [`capabilities`](crate::sockscap::capture::capabilities) still reports the
//! Phase 1 system-proxy backend with `app_filter=false`. What is blocked is
//! external (entitlement / Developer ID / notarization); what is buildable —
//! the shared crate, its C-ABI, and this glue — is done and tested, including a
//! C program that links the staticlib and calls the decision (see
//! `sockscap-core/tests/`).

pub mod control;
pub mod decision;

#[cfg(target_os = "macos")]
pub mod adapter;

pub use control::{
    CONTROL_PROTOCOL_VERSION, ControlRequest, ControlResponse, ControlServer, ControlState,
};
pub use decision::{
    ProviderFlowDecision, SelectedApps, macos_provider_decision, selected_from_config,
};
