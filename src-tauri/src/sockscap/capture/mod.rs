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

/// Undo any residual OS capture state left by an unclean shutdown.
pub async fn recover_system() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return linux::recover_system(None);
    }
    #[cfg(windows)]
    {
        return recover_system_windows();
    }
    #[cfg(all(not(target_os = "linux"), not(windows)))]
    Ok(())
}

/// Windows recovery: kill any leftover elevated `sockscap-helper.exe`. When the
/// helper exits, its WinDivert handles close and the driver unloads on its own,
/// so terminating a stranded helper is sufficient to release capture state.
///
/// Best-effort: the main app is typically **not** elevated, so it cannot kill
/// the elevated helper directly — `taskkill` returns Access Denied. In that case
/// the helper's own parent-death watchdog already handles the common crash/kill
/// path; here we just surface a clear message and treat "no such process" and
/// "access denied" as non-fatal (nothing this process can further clean up).
#[cfg(windows)]
fn recover_system_windows() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = Command::new("taskkill.exe")
        .args(["/F", "/IM", "sockscap-helper.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill sockscap-helper: {e}"))?;

    if output.status.success() {
        tracing::info!("sockscap: recover killed leftover sockscap-helper.exe");
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        stderr
    );
    let lower = combined.to_ascii_lowercase();
    // "not found" → nothing to clean. "access is denied" → elevated helper we
    // can't touch from a non-elevated app; watchdog is the real safety net.
    if lower.contains("not found")
        || lower.contains("no running instance")
        || lower.contains("access is denied")
    {
        tracing::info!("sockscap: recover — no killable leftover helper ({})", combined.trim());
        return Ok(());
    }
    Err(format!("taskkill sockscap-helper failed: {}", combined.trim()))
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
