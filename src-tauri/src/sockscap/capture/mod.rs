//! Platform capture plane.
//!
//! OS capture adapters.
//!
//! Windows uses the elevated WinDivert helper. Linux uses nftables + cgroup v2
//! transparent TCP redirect. macOS currently exposes the rules engine only.

use serde::{Deserialize, Serialize};

// Re-export for orchestrator without circular path noise.
pub use super::SocksCapCapabilities;

#[cfg(target_os = "linux")]
pub mod linux;

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
            global_tcp: false,
            app_filter: false,
            capture_backend: "network-extension-planned".into(),
            notes: vec![
                "macOS Network Extension / utun is planned; rules/egress engine is available now."
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

/// Base name of the elevated Windows helper.
pub const HELPER_IMAGE_NAME: &str = "sockscap-helper.exe";

/// Undo any residual OS capture state left by an unclean shutdown.
///
/// Returns the pids of leftover helpers this process was **not permitted** to
/// terminate. They are elevated and we are (normally) not, so only another
/// elevated process can reap them — the caller hands the list to the next
/// helper launch, which runs under UAC and can finish the job.
pub async fn recover_system() -> Result<Vec<u32>, String> {
    #[cfg(target_os = "linux")]
    {
        return linux::recover_system(None).map(|()| Vec::new());
    }
    #[cfg(windows)]
    {
        return recover_system_windows();
    }
    #[cfg(all(not(target_os = "linux"), not(windows)))]
    Ok(Vec::new())
}

/// Windows recovery: terminate any leftover `sockscap-helper.exe`. When a helper
/// exits, its WinDivert handles close and the driver unloads on its own, so
/// terminating a stranded helper is sufficient to release capture state.
///
/// Uses `OpenProcess` + `TerminateProcess` rather than shelling out to
/// `taskkill`. The old code parsed `taskkill`'s **localized** output for the
/// English substrings "not found" and "access is denied", so on a non-English
/// Windows the benign "no such process" case was misread as a hard failure and
/// SocksCap stayed stuck in `RecoveryRequired`. It also treated Access Denied as
/// success, silently reporting a clean system while an orphaned helper was still
/// diverting every packet on the machine.
#[cfg(windows)]
fn recover_system_windows() -> Result<Vec<u32>, String> {
    use crate::sockscap::process::{pids_by_image_name, terminate_if_image};

    let pids = pids_by_image_name(HELPER_IMAGE_NAME);
    if pids.is_empty() {
        tracing::info!("sockscap: recover — no leftover helper processes");
        return Ok(Vec::new());
    }

    let mut killed = 0usize;
    let mut needs_elevation = Vec::new();
    for pid in pids {
        match terminate_if_image(pid, HELPER_IMAGE_NAME) {
            Ok(true) => killed += 1,
            // Already gone, or the pid now belongs to something else.
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("sockscap: cannot terminate helper pid {pid} ({e})");
                needs_elevation.push(pid);
            }
        }
    }
    tracing::info!(
        "sockscap: recover terminated {killed} leftover helper(s); {} need elevation",
        needs_elevation.len()
    );
    Ok(needs_elevation)
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
