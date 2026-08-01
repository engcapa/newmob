//! macOS capture backend: signed Mitmproxy Redirector → Unix IPC → relay.
//!
//! This is intentionally the only macOS capture path. It never reads or writes
//! the system HTTP/SOCKS proxy configuration and has no legacy fallback.

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::RwLock;

use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::redirector::runtime::{self, RedirectorCaptureHandle};
use crate::sockscap::relay::RelayContext;

pub type MacosCaptureHandle = RedirectorCaptureHandle;

pub fn preflight(config: &SocksCapConfig) -> Result<(), String> {
    runtime::preflight(config)
}

pub async fn start(
    app: &AppHandle,
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<MacosCaptureHandle, String> {
    runtime::start(app, config, ctx).await
}

/// Redirector recovery is handled by its control-channel inert configuration.
/// There is deliberately no legacy proxy cleanup here: new Taomni versions do
/// not own or mutate the user's system proxy state.
pub fn recover_system() -> Result<(), String> {
    Ok(())
}
