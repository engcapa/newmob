//! SocksCap capture-plane primitives — the single source of truth for the
//! macOS transparent-proxy backend's per-flow decision and its control protocol.
//!
//! # Why this is a separate crate
//!
//! On macOS the capture decision runs inside a `NETransparentProxyProvider`
//! **system extension**, which is a *separate process* from the Taomni app and
//! cannot link the full `taomni_lib` (tokio, tauri, webview…). This crate is
//! deliberately tiny (serde only) so the extension's Xcode target can link its
//! staticlib and call the [`ffi`] C-ABI. The Taomni engine links the same crate
//! as an rlib. One implementation, linked into both — the Swift side holds *no*
//! decision logic, so the rule cannot drift between engine and extension.
//!
//! * [`decision`] — the per-flow capture gate (`Handle` vs `PassThrough`).
//! * [`control`] — the versioned control protocol (auth, heartbeat, atomic
//!   config versioning, degraded/recovery state).
//! * [`ffi`] — `extern "C"` exports the Network Extension calls per flow.

pub mod control;
pub mod decision;
pub mod ffi;

pub use control::{
    CONTROL_PROTOCOL_VERSION, ControlRequest, ControlResponse, ControlServer, ControlState,
};
pub use decision::{ProviderFlowDecision, SelectedApps, macos_provider_decision};
