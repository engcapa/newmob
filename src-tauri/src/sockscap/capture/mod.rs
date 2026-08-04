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

pub mod local_proxy;

#[cfg(target_os = "macos")]
pub mod macos;

/// Backend name reported when capture runs as an explicit loopback proxy.
pub const LOCAL_PROXY_BACKEND: &str = "local-proxy";

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
            local_proxy: false,
        }
    }
    #[cfg(target_os = "linux")]
    {
        linux_capabilities(linux::support::transparent_support())
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
            local_proxy: false,
        }
    }
}

/// Linux capabilities, parameterized on whether transparent capture is possible
/// in this environment at all.
///
/// When it is not, reporting `privileged_required: false` matters as much as the
/// backend name: it is what stops the UI from asking for a sudo password that
/// cannot help, because the missing capability is absent from the bounding set.
#[cfg(any(target_os = "linux", test))]
pub fn linux_capabilities(transparent_support: Result<(), String>) -> SocksCapCapabilities {
    match transparent_support {
        Ok(()) => SocksCapCapabilities {
            platform: "linux".into(),
            global_tcp: true,
            app_filter: true,
            capture_backend: "nft-cgroup-redirect".into(),
            notes: vec![
                "Linux: nftables transparent TCP redirect with cgroup v2 process filtering. Requires root or delegated CAP_NET_ADMIN/cgroup permissions.".into(),
            ],
            privileged_required: true,
            local_proxy: true,
        },
        Err(reason) => SocksCapCapabilities {
            platform: "linux".into(),
            // No traffic is intercepted; clients opt in by pointing at the port.
            global_tcp: false,
            // A proxy handshake carries no process identity, so executable-path
            // selectors cannot be honoured. Profiles are selected by port.
            app_filter: false,
            capture_backend: LOCAL_PROXY_BACKEND.into(),
            notes: vec![
                format!("Linux transparent capture is unavailable here: {reason}."),
                "SocksCap runs a loopback SOCKS5 / HTTP-CONNECT proxy instead. Only clients pointed at its port are captured, and QUIC blocking does not apply.".into(),
                "For system-wide transparent capture, the container or host must provide CAP_NET_ADMIN and a mounted cgroup v2 hierarchy.".into(),
            ],
            privileged_required: false,
            local_proxy: true,
        },
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
            local_proxy: false,
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
            local_proxy: false,
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
    fn linux_with_transparent_support_reports_the_nft_backend() {
        let caps = linux_capabilities(Ok(()));
        assert_eq!(caps.capture_backend, "nft-cgroup-redirect");
        assert!(caps.global_tcp);
        assert!(caps.app_filter);
        assert!(
            caps.privileged_required,
            "a capable host still needs elevation, so the UI must ask for it"
        );
    }

    #[test]
    fn linux_without_transparent_support_falls_back_to_the_local_proxy() {
        let caps = linux_capabilities(Err("CAP_NET_ADMIN is not in the bounding set".into()));

        assert_eq!(caps.capture_backend, LOCAL_PROXY_BACKEND);
        // Nothing is intercepted and no process identity is available.
        assert!(!caps.global_tcp);
        assert!(!caps.app_filter);
        // The decisive part: a sudo password cannot help, so never ask for one.
        assert!(!caps.privileged_required);
    }

    #[test]
    fn linux_can_select_the_local_proxy_whether_or_not_transparent_works() {
        // The flag says the backend is *selectable*, so a user on a fully capable
        // host can still choose it deliberately. It is separate from which
        // backend is currently running.
        assert!(linux_capabilities(Ok(())).local_proxy);
        assert!(linux_capabilities(Err("cgroup v2 is not mounted".into())).local_proxy);
    }

    #[test]
    fn platforms_without_a_local_proxy_start_path_do_not_advertise_it() {
        // Offering the mode where nothing would happen is worse than omitting it.
        assert!(!macos_capabilities(true).local_proxy);
        assert!(!macos_capabilities(false).local_proxy);
    }

    #[test]
    fn the_local_proxy_fallback_explains_why_and_what_changed() {
        let caps = linux_capabilities(Err("cgroup v2 is not mounted".into()));

        let notes = caps.notes.join(" ");
        assert!(
            notes.contains("cgroup v2 is not mounted"),
            "the underlying reason must reach the user"
        );
        assert!(
            notes.contains("Only clients pointed at its port are captured"),
            "the reduced scope must be stated"
        );
        assert!(
            notes.contains("QUIC"),
            "QUIC blocking silently not applying must be called out"
        );
    }

    /// Checked against the machine actually running the tests, not a fixture.
    ///
    /// The invariant is what keeps a locked-down container out of an unresolvable
    /// password loop: elevation is only ever advertised where the environment can
    /// really reach transparent capture, and everywhere else a usable backend is
    /// named instead of none.
    #[cfg(target_os = "linux")]
    #[test]
    fn this_environment_never_advertises_elevation_it_cannot_use() {
        let caps = capabilities();

        if caps.privileged_required {
            assert!(
                linux::support::transparent_supported(),
                "elevation was advertised on a host that cannot do transparent capture"
            );
        } else {
            assert_eq!(
                caps.capture_backend, LOCAL_PROXY_BACKEND,
                "without elevation the local proxy must be the running backend"
            );
            assert!(!caps.global_tcp, "the local proxy intercepts nothing");
            assert!(
                !caps.app_filter,
                "a proxy handshake carries no process identity"
            );
        }
    }

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
