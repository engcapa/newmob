//! Platform capture plane.
//!
//! OS capture adapters.
//!
//! Windows uses the elevated WinDivert helper. Linux uses nftables + cgroup v2
//! transparent TCP redirect. macOS uses mitmproxy's signed Redirector over its
//! Unix IPC bridge; no system-proxy fallback exists.

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
            linux: None,
        }
    }
    #[cfg(target_os = "linux")]
    {
        let transparent = linux::transparent_capability();
        let transparent_available =
            !matches!(&transparent, linux::TransparentCapability::Unavailable(_));
        let privileged_required = matches!(
            &transparent,
            linux::TransparentCapability::ElevationRequired
        );
        let launched = if transparent_available {
            Ok(())
        } else {
            linux::launched::preflight()
        };
        let launched_application_available = launched.is_ok();
        SocksCapCapabilities {
            platform: "linux".into(),
            global_tcp: transparent_available,
            app_filter: transparent_available || launched_application_available,
            capture_backend: if transparent_available {
                "nft-cgroup-redirect".into()
            } else if launched_application_available {
                "linux-app-launch".into()
            } else {
                "unavailable".into()
            },
            notes: if transparent_available {
                vec![if privileged_required {
                    "Linux nftables and cgroup transparent capture is available after sudo authentication.".into()
                } else {
                    "Linux nftables and cgroup transparent capture is available without additional elevation.".into()
                }]
            } else if launched_application_available {
                vec!["Linux transparent capture is unavailable. Launch selected applications from SocksCap to capture their TCP process tree without sudo or proxy environment variables.".into()]
            } else {
                vec!["The current Linux container or kernel does not allow unprivileged application capture.".into()]
            },
            privileged_required,
            linux: Some(crate::sockscap::LinuxCaptureCapabilities {
                transparent_available,
                launched_application_available,
                launch_only: !transparent_available,
                containerized: linux::is_containerized(),
                transparent_unavailable_reason: match transparent {
                    linux::TransparentCapability::Unavailable(error)
                        if launched_application_available =>
                    {
                        Some(error)
                    }
                    linux::TransparentCapability::Unavailable(_) => launched.err(),
                    linux::TransparentCapability::Available
                    | linux::TransparentCapability::ElevationRequired => None,
                },
            }),
        }
    }
    #[cfg(target_os = "macos")]
    {
        macos_capabilities(crate::sockscap::redirector::is_installed())
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
            linux: None,
        }
    }
}

/// macOS capabilities, parameterized on whether the pinned, signed Redirector
/// is installed.
#[cfg(any(target_os = "macos", test))]
pub fn macos_capabilities(redirector_installed: bool) -> SocksCapCapabilities {
    if redirector_installed {
        SocksCapCapabilities {
            platform: "macos".into(),
            global_tcp: true,
            app_filter: true,
            capture_backend: "mitmproxy-redirector".into(),
            notes: vec![
                "macOS: transparent TCP/UDP flow capture via the signed Mitmproxy Redirector; system proxy settings are never changed.".into(),
                "The first use may require approving Mitmproxy Redirector's System Extension and network configuration in System Settings.".into(),
                "Global and signed-application capture are available. Application identities are revalidated before each activation.".into(),
            ],
            privileged_required: false,
            linux: None,
        }
    } else {
        SocksCapCapabilities {
            platform: "macos".into(),
            global_tcp: false,
            app_filter: false,
            capture_backend: "unavailable".into(),
            notes: vec![format!(
                "macOS: Mitmproxy Redirector {} is not installed; SocksCap has no system-proxy fallback.",
                crate::sockscap::redirector::REDIRECTOR_VERSION
            )],
            privileged_required: false,
            linux: None,
        }
    }
}

/// Capabilities for the running build. Non-macOS platforms ignore `app` and
/// match [`capabilities`].
pub fn capabilities_for(app: &tauri::AppHandle) -> SocksCapCapabilities {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return macos_capabilities(crate::sockscap::redirector::is_installed());
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
        let _ = sudo_password;
        return macos::recover_system().await.map(|()| Vec::new());
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
    fn macos_without_redirector_is_unavailable_without_fallback() {
        let caps = macos_capabilities(false);
        assert_eq!(caps.platform, "macos");
        assert!(!caps.app_filter);
        assert_eq!(caps.capture_backend, "unavailable");
        assert!(!caps.global_tcp);
        assert!(!caps.privileged_required);
        assert!(
            caps.notes
                .iter()
                .any(|note| note.contains("no system-proxy fallback"))
        );
    }

    #[test]
    fn macos_with_redirector_offers_global_and_application_capture() {
        let caps = macos_capabilities(true);
        assert_eq!(caps.platform, "macos");
        assert!(caps.app_filter);
        assert_eq!(caps.capture_backend, "mitmproxy-redirector");
        assert!(caps.global_tcp);
        assert!(!caps.privileged_required);
        assert!(
            caps.notes
                .iter()
                .any(|n| n.contains("system proxy settings are never changed"))
        );
    }
}
