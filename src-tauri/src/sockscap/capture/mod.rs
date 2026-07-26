//! Platform capture plane.
//!
//! OS capture adapters.
//!
//! Windows uses the elevated WinDivert helper. Linux uses nftables + cgroup v2
//! transparent TCP redirect. macOS points the system SOCKS proxy at a loopback
//! proxy ingress, which is not transparent and is Global-scoped only.

use serde::{Deserialize, Serialize};

// Re-export for orchestrator without circular path noise.
pub use super::SocksCapCapabilities;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

/// Describe what this build/OS can do today.
pub fn capabilities() -> SocksCapCapabilities {
    #[cfg(target_os = "windows")]
    {
        SocksCapCapabilities {
            platform: "windows".into(),
            global_tcp: true,
            app_filter: true,
            capture_backend: "windivert-helper".into(),
            notes: vec![
                "Windows: elevated sockscap-helper + WinDivert FLOW/NETWORK. Place WinDivert.dll next to the helper.".into(),
            ],
            privileged_required: true,
        }
    }
    #[cfg(target_os = "linux")]
    {
        SocksCapCapabilities {
            platform: "linux".into(),
            global_tcp: true,
            app_filter: true,
            capture_backend: "nft-cgroup-redirect".into(),
            notes: vec![
                "Linux: nftables transparent TCP redirect with cgroup v2 process filtering. Requires root or delegated CAP_NET_ADMIN/cgroup permissions.".into(),
            ],
            privileged_required: true,
        }
    }
    #[cfg(target_os = "macos")]
    {
        SocksCapCapabilities {
            platform: "macos".into(),
            global_tcp: true,
            // Per-application routing needs the source app identity that only a
            // NETransparentProxyProvider supplies.
            app_filter: false,
            capture_backend: "system-proxy".into(),
            notes: vec![
                "macOS: system SOCKS proxy points applications at SocksCap's loopback listener. \
                 Requires administrator rights to change the system proxy."
                    .into(),
                "Not transparent capture: applications that ignore the system proxy are not \
                 routed, and scope is Global only."
                    .into(),
            ],
            privileged_required: true,
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        SocksCapCapabilities {
            platform: std::env::consts::OS.into(),
            global_tcp: false,
            app_filter: false,
            capture_backend: "unsupported".into(),
            notes: vec!["Unsupported platform for SocksCap capture.".into()],
            privileged_required: false,
        }
    }
}

/// Undo any residual OS capture state left by an unclean shutdown.
pub async fn recover_system() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return linux::recover_system(None);
    }
    #[cfg(target_os = "macos")]
    {
        // No stored credential is available here, so this succeeds only when the
        // process is already privileged; otherwise the caller keeps the journal
        // dirty and asks the user to Recover, exactly as on Linux.
        return macos::recover_system(None);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Ok(())
}

/// Future trait for platform adapters.
#[allow(async_fn_in_trait)]
pub trait CapturePlane: Send + Sync {
    async fn preflight(&self) -> Result<SocksCapCapabilities, String>;
    async fn stop(&self) -> Result<(), String>;
    async fn recover(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePlan {
    pub global: bool,
    pub app_paths: Vec<String>,
}
