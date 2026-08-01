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
        // The plain (no-AppHandle) probe reports the always-available Phase 1
        // backend. `capabilities_for` upgrades this to the transparent backend
        // when a signed Network Extension bundle is actually present.
        macos_capabilities(false)
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

/// macOS capabilities, parameterized on whether a transparent-capture Network
/// Extension is bundled. Pure (builds the struct only) so both branches are
/// unit-tested on any host.
///
/// * `extension_present = true` — the signed `NETransparentProxyProvider` ships
///   in this build: per-app capture is available (`app_filter=true`) through the
///   `ne-transparent` backend.
/// * `extension_present = false` — Phase 1 only: the system SOCKS proxy points
///   apps at the loopback listener, Global scope, no per-app identity.
#[cfg(any(target_os = "macos", test))]
pub fn macos_capabilities(extension_present: bool) -> SocksCapCapabilities {
    if extension_present {
        SocksCapCapabilities {
            platform: "macos".into(),
            global_tcp: true,
            app_filter: true,
            capture_backend: "ne-transparent".into(),
            notes: vec![
                "macOS: transparent per-flow capture via a NETransparentProxyProvider system \
                 extension; selected apps are routed by code-signing identity."
                    .into(),
                "Requires approving the system extension once (System Settings › Privacy & \
                 Security) and, on first run, an administrator."
                    .into(),
            ],
            privileged_required: true,
        }
    } else {
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
                 routed, and scope is Global only. Install the Network Extension for per-app \
                 transparent capture."
                    .into(),
            ],
            privileged_required: true,
        }
    }
}

/// Capabilities for the running build, probing the app bundle so macOS reports
/// the transparent backend (with `app_filter=true`) only when the Network
/// Extension is actually present. Non-macOS platforms ignore `app` and match
/// [`capabilities`].
pub fn capabilities_for(app: &tauri::AppHandle) -> SocksCapCapabilities {
    #[cfg(target_os = "macos")]
    {
        return macos_capabilities(crate::sockscap::transparent::activation::extension_present(
            app,
        ));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        capabilities()
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
pub async fn recover_system(sudo_password: Option<&str>) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "linux")]
    {
        return linux::recover_system(sudo_password).map(|()| Vec::new());
    }
    #[cfg(windows)]
    {
        let _ = sudo_password;
        return recover_system_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return macos::recover_system(sudo_password).map(|()| Vec::new());
    }
    #[cfg(all(not(target_os = "linux"), not(windows), not(target_os = "macos")))]
    {
        let _ = sudo_password;
        Ok(Vec::new())
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_without_extension_is_phase1_system_proxy() {
        let caps = macos_capabilities(false);
        assert_eq!(caps.platform, "macos");
        assert!(!caps.app_filter, "no NE bundle ⇒ Global-only");
        assert_eq!(caps.capture_backend, "system-proxy");
        assert!(caps.global_tcp);
        assert!(caps.privileged_required);
    }

    #[test]
    fn macos_with_extension_offers_transparent_per_app_capture() {
        let caps = macos_capabilities(true);
        assert_eq!(caps.platform, "macos");
        assert!(caps.app_filter, "NE bundle present ⇒ per-app capture");
        assert_eq!(caps.capture_backend, "ne-transparent");
        assert!(caps.global_tcp);
        assert!(caps.privileged_required);
        // The user-facing note must explain the one-time approval step.
        assert!(caps.notes.iter().any(|n| n.contains("system extension")));
    }
}
