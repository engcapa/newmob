//! Auto-update support helpers.
//!
//! The heavy lifting (download, minisign verification, install) is done by
//! `tauri-plugin-updater`. This module only exposes the small piece the plugin
//! can't answer on its own: *which* platform artifacts the user may install on
//! this machine.
//!
//! The updater looks up `latest.json`'s `platforms` map with a key of the form
//! `{os}-{arch}` (e.g. `darwin-aarch64`). By default it uses the running
//! binary's own target, so an x86_64 build can never offer to switch the user
//! to the native arm64 build. We want to let the user choose (see
//! `claudedocs/auto-update-plan.md`), so the frontend asks this command which
//! targets are valid for the current OS/hardware and which one to recommend,
//! then passes the chosen target to `check({ target })`.

use serde::Serialize;

/// Platform/architecture info used to drive the update-package selector.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterPlatform {
    /// Updater OS token: `"darwin" | "windows" | "linux"`.
    pub os: String,
    /// Updater key for the currently running binary, e.g. `"darwin-x86_64"`.
    pub native_target: String,
    /// Target we suggest installing (native arch preferred).
    pub recommended_target: String,
    /// Targets that can actually run on this machine, for the selector. Always
    /// contains `native_target`. Length 1 ⇒ the frontend hides the selector.
    pub candidates: Vec<String>,
    /// macOS only: the running x86_64 binary is translated by Rosetta on an
    /// Apple Silicon machine, so switching to the native arm64 build is worth
    /// recommending.
    pub is_rosetta: bool,
}

/// Updater OS token for the build target.
fn os_token() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Arch token matching Tauri's updater keys. We only ship `x86_64`/`aarch64`,
/// which line up with `std::env::consts::ARCH` exactly; 32-bit/armv7 would need
/// a remap (`x86` → `i686`, `arm` → `armv7`) before being offered.
fn arch_token() -> &'static str {
    std::env::consts::ARCH
}

/// Detect whether the current (x86_64) process is running under Rosetta 2 on
/// Apple Silicon. Returns `false` on every non-macOS platform and on native
/// arm64 / Intel macOS.
#[cfg(target_os = "macos")]
fn detect_rosetta() -> bool {
    // `sysctl.proc_translated`: 1 = translated (Rosetta), 0 = native,
    // absent (rc == -1, errno ENOENT) = the key doesn't exist ⇒ genuine Intel.
    let mut translated: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>() as libc::size_t;
    // SAFETY: `sysctlbyname` writes at most `size` bytes into `translated` and
    // updates `size`; the name is a valid NUL-terminated C string.
    let rc = unsafe {
        libc::sysctlbyname(
            c"sysctl.proc_translated".as_ptr(),
            &mut translated as *mut libc::c_int as *mut libc::c_void,
            &mut size as *mut libc::size_t,
            std::ptr::null_mut(),
            0,
        )
    };
    rc == 0 && translated == 1
}

#[cfg(not(target_os = "macos"))]
fn detect_rosetta() -> bool {
    false
}

/// Pure resolver so the matrix is unit-testable without touching the OS.
///
/// * `os` / `arch` — updater tokens for the running binary.
/// * `is_rosetta` — true only when an x86_64 macOS binary runs on Apple Silicon.
fn resolve(os: &str, arch: &str, is_rosetta: bool) -> UpdaterPlatform {
    let native_target = format!("{os}-{arch}");

    let (candidates, recommended_target) = match os {
        "darwin" => {
            if arch == "aarch64" {
                // Apple Silicon native: native arm64 + x86_64 (runs via Rosetta).
                (
                    vec!["darwin-aarch64".to_string(), "darwin-x86_64".to_string()],
                    "darwin-aarch64".to_string(),
                )
            } else if is_rosetta {
                // x86_64 binary on Apple Silicon: offer both, recommend native arm64.
                (
                    vec!["darwin-aarch64".to_string(), "darwin-x86_64".to_string()],
                    "darwin-aarch64".to_string(),
                )
            } else {
                // Genuine Intel Mac: arm64 won't run, so x86_64 only.
                (
                    vec!["darwin-x86_64".to_string()],
                    "darwin-x86_64".to_string(),
                )
            }
        }
        // Windows/Linux currently ship a single x86_64 artifact. When arm64
        // builds are added, extend these arms (and arch detection above).
        _ => (vec![native_target.clone()], native_target.clone()),
    };

    UpdaterPlatform {
        os: os.to_string(),
        native_target,
        recommended_target,
        candidates,
        is_rosetta,
    }
}

/// Frontend-facing command: see module docs.
#[tauri::command]
pub fn updater_platform() -> UpdaterPlatform {
    resolve(os_token(), arch_token(), detect_rosetta())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_silicon_native_offers_both_recommends_arm64() {
        let p = resolve("darwin", "aarch64", false);
        assert_eq!(p.native_target, "darwin-aarch64");
        assert_eq!(p.recommended_target, "darwin-aarch64");
        assert_eq!(p.candidates, vec!["darwin-aarch64", "darwin-x86_64"]);
        assert!(!p.is_rosetta);
    }

    #[test]
    fn rosetta_offers_both_recommends_native_arm64() {
        let p = resolve("darwin", "x86_64", true);
        // Running binary is x86_64...
        assert_eq!(p.native_target, "darwin-x86_64");
        // ...but we steer the user to the native build.
        assert_eq!(p.recommended_target, "darwin-aarch64");
        assert_eq!(p.candidates, vec!["darwin-aarch64", "darwin-x86_64"]);
        assert!(p.is_rosetta);
    }

    #[test]
    fn intel_mac_offers_x86_only() {
        let p = resolve("darwin", "x86_64", false);
        assert_eq!(p.native_target, "darwin-x86_64");
        assert_eq!(p.recommended_target, "darwin-x86_64");
        assert_eq!(p.candidates, vec!["darwin-x86_64"]);
        assert!(!p.is_rosetta);
    }

    #[test]
    fn windows_single_candidate_hides_selector() {
        let p = resolve("windows", "x86_64", false);
        assert_eq!(p.native_target, "windows-x86_64");
        assert_eq!(p.recommended_target, "windows-x86_64");
        assert_eq!(p.candidates, vec!["windows-x86_64"]);
    }

    #[test]
    fn linux_single_candidate() {
        let p = resolve("linux", "x86_64", false);
        assert_eq!(p.candidates, vec!["linux-x86_64"]);
        assert_eq!(p.recommended_target, "linux-x86_64");
    }
}
