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
    session_id: &str,
) -> Result<MacosCaptureHandle, runtime::RedirectorStartError> {
    runtime::start(app, config, ctx, session_id).await
}

/// Reacquire Redirector control and replace any scope stranded by an unclean
/// shutdown with a fresh inert sentinel. There is deliberately no legacy proxy
/// cleanup: new Taomni versions do not own or mutate system proxy settings.
pub async fn recover_system() -> Result<(), String> {
    runtime::recover().await
}
