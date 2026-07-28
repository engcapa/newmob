//! Locating and activating the macOS transparent-proxy system extension.
//!
//! Two halves, split by what can run in a code-only environment:
//!
//! * **Bundle detection** ([`locate_extension_bundle`], [`resolve_extension_bundle`])
//!   is pure filesystem probing — built and unit-tested on every platform. It
//!   answers "is a transparent-capture extension actually present in this
//!   build?", which gates whether the engine offers per-app capture at all.
//! * **Activation** ([`request_activation`], macOS only) submits an
//!   `OSSystemExtensionRequest` through a tiny C shim compiled by `build.rs`.
//!   Producing a *loadable* extension needs an Apple Network Extension
//!   entitlement, a Developer ID, and notarization — none of which a `cargo
//!   build` can do — so when no bundle is present this fails fast with
//!   [`ENTITLEMENT_UNAVAILABLE`] and the caller falls back to the system-proxy
//!   backend. The engine only reports the transparent plane *Active* once the
//!   provider connects to the control socket and completes `Hello`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Bundle identifier of the Network Extension system extension (the `.appex`).
///
/// Must match the extension target's `CFBundleIdentifier`, the value passed to
/// `OSSystemExtensionRequest`, and the provider's self-bypass identity so the
/// extension's own upstream dials are never re-captured.
pub const EXTENSION_IDENTIFIER: &str = "com.taomni.app.SockscapExtension";

/// Reason surfaced to the UI when transparent capture cannot activate because no
/// signed extension is bundled. Kept verbatim so the user sees an infrastructure
/// gap, not a bug.
pub const ENTITLEMENT_UNAVAILABLE: &str = "macOS transparent capture is unavailable: it needs a Network Extension \
     system extension (com.apple.developer.networking.networkextension), a \
     Developer ID signing identity, and notarization. Until that bundle ships, \
     use the system-proxy backend (Global scope).";

/// Leaf name of the embedded system-extension bundle.
const BUNDLE_LEAF: &str = "SockscapExtension.systemextension";

/// Candidate paths for the extension bundle relative to a base directory (the
/// app's `Contents/`, its `MacOS/` dir, or a resource root). First existing wins.
///
/// Mirrors the layered lookup style of [`crate::sockscap::paths`]: the installed
/// `Contents/Library/SystemExtensions/` embed, plus the dev/staged
/// `resources/macos-provider/` layout.
pub fn bundle_candidates(base: &Path) -> Vec<PathBuf> {
    vec![
        base.join("Library")
            .join("SystemExtensions")
            .join(BUNDLE_LEAF),
        base.join("Contents")
            .join("Library")
            .join("SystemExtensions")
            .join(BUNDLE_LEAF),
        base.join("resources")
            .join("macos-provider")
            .join(BUNDLE_LEAF),
        base.join("macos-provider").join(BUNDLE_LEAF),
    ]
}

/// The first candidate that exists as a directory (a `.systemextension` bundle
/// is a directory), or `None`. Pure over the candidate list so it is testable
/// without a real bundle on disk.
pub fn first_existing_bundle(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.is_dir()).cloned()
}

/// Resolve the embedded system-extension bundle across dev / installed layouts,
/// or `None` when no extension is bundled (the common code-only case).
pub fn resolve_extension_bundle(app: &AppHandle) -> Option<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // Installed macOS layout: `Taomni.app/Contents/MacOS/Taomni` → the
        // extension embeds under `Contents/Library/SystemExtensions/`.
        if let Some(macos_dir) = exe.parent() {
            bases.push(macos_dir.to_path_buf());
            if let Some(contents) = macos_dir.parent() {
                bases.push(contents.to_path_buf());
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        bases.push(dir);
    }
    // Dev / CWD-relative (running from the repo).
    bases.push(PathBuf::from("src-tauri"));
    bases.push(PathBuf::from("."));

    for base in bases {
        if let Some(found) = first_existing_bundle(&bundle_candidates(&base)) {
            return Some(found);
        }
    }
    None
}

/// Whether a transparent-capture extension is present in this build. Drives
/// [`capabilities`](crate::sockscap::capture) reporting `app_filter=true`.
pub fn extension_present(app: &AppHandle) -> bool {
    resolve_extension_bundle(app).is_some()
}

/// Submit an activation request for the system extension.
///
/// # macOS
/// Calls the `build.rs`-compiled C shim, which runs `OSSystemExtensionRequest`.
/// Submission is asynchronous: success here means "the request was accepted by
/// the OS", not "the extension is running". The engine confirms readiness only
/// when the provider connects to the control socket and authenticates.
///
/// # Other platforms
/// Never called at runtime (the transparent backend is macOS-only); returns the
/// infrastructure error so the type-checks and any accidental call fail safe.
#[cfg(all(target_os = "macos", sockscap_ne_shim))]
pub fn request_activation(extension_identifier: &str) -> Result<(), String> {
    activation_macos::submit(extension_identifier)
}

/// No shim linked (non-macOS, or a macOS build without the provider scaffolding):
/// report the infrastructure gap so the caller falls back to system-proxy.
#[cfg(not(all(target_os = "macos", sockscap_ne_shim)))]
pub fn request_activation(_extension_identifier: &str) -> Result<(), String> {
    Err(ENTITLEMENT_UNAVAILABLE.to_string())
}

/// macOS `OSSystemExtensionRequest` binding.
///
/// AUTHORED-BUT-UNVERIFIABLE on this Linux host: the `extern "C"` symbol is
/// provided by `resources/macos-provider/activation_shim.m`, compiled + linked
/// only in a macOS `cargo build` (see `build.rs`). The shim submits the request
/// to `OSSystemExtensionManager.shared` and returns 0 on accepted-submission,
/// non-zero on a synchronous reject. Real end-to-end behaviour needs the signed,
/// notarized extension and on-device approval and cannot be exercised here.
#[cfg(all(target_os = "macos", sockscap_ne_shim))]
mod activation_macos {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};

    unsafe extern "C" {
        /// Returns 0 when the activation request was submitted, non-zero on a
        /// synchronous failure (e.g. malformed identifier).
        fn sockscap_ne_activate(identifier: *const c_char) -> c_int;
    }

    pub fn submit(extension_identifier: &str) -> Result<(), String> {
        let identifier = CString::new(extension_identifier)
            .map_err(|_| "extension identifier contains an interior NUL".to_string())?;
        // SAFETY: `identifier` is a valid NUL-terminated C string that outlives
        // the call; the shim only reads it and returns an int.
        let rc = unsafe { sockscap_ne_activate(identifier.as_ptr()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(format!(
                "OSSystemExtensionRequest submission failed (code {rc}); \
                 check the extension is signed, notarized, and its identifier matches"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_cover_installed_and_dev_layouts() {
        let base = Path::new("/opt/Taomni.app/Contents");
        let candidates = bundle_candidates(base);
        // Installed embed location must be among them.
        assert!(
            candidates
                .iter()
                .any(|p| p.ends_with("Library/SystemExtensions/SockscapExtension.systemextension"))
        );
        // Dev/staged resource location must be among them.
        assert!(
            candidates
                .iter()
                .any(|p| p.ends_with("resources/macos-provider/SockscapExtension.systemextension"))
        );
    }

    #[test]
    fn first_existing_bundle_picks_the_present_directory() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("SockscapExtension.systemextension");
        std::fs::create_dir_all(&present).unwrap();
        let missing = dir.path().join("nope.systemextension");

        // Missing-first, present-second: the present one is chosen.
        let chosen = first_existing_bundle(&[missing.clone(), present.clone()]);
        assert_eq!(chosen.as_deref(), Some(present.as_path()));
    }

    #[test]
    fn no_bundle_means_no_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let candidates = bundle_candidates(dir.path());
        // Nothing created, so none exist.
        assert!(first_existing_bundle(&candidates).is_none());
    }

    #[test]
    fn a_plain_file_is_not_accepted_as_a_bundle() {
        // A `.systemextension` is a directory; a same-named file must be ignored.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("SockscapExtension.systemextension");
        std::fs::write(&file, b"not a bundle").unwrap();
        assert!(first_existing_bundle(&[file]).is_none());
    }

    #[cfg(not(all(target_os = "macos", sockscap_ne_shim)))]
    #[test]
    fn activation_without_shim_reports_infra_gap() {
        let err = request_activation(EXTENSION_IDENTIFIER).unwrap_err();
        assert!(err.contains("Network Extension"));
    }
}
