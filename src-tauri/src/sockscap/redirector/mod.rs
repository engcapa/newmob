//! mitmproxy's signed macOS Redirector integration.
//!
//! Taomni treats Redirector as a pinned third-party capture engine. The
//! protobuf contract and scope compiler live here so the production backend and
//! tests share one implementation; no macOS system-proxy fallback exists.

pub mod ipc;
pub mod scope;

#[cfg(target_os = "macos")]
pub mod runtime;

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};

pub const REDIRECTOR_VERSION: &str = "0.12.11";
pub const REDIRECTOR_WHEEL_SHA256: &str =
    "63349d9b46514ca679547651f7c0548f9222892edfbcba087b82b3244fbae859";
pub const REDIRECTOR_TEAM_ID: &str = "S8XHQB96PW";
pub const REDIRECTOR_BUNDLE_ID: &str = "org.mitmproxy.macos-redirector";
pub const REDIRECTOR_EXTENSION_BUNDLE_ID: &str = "org.mitmproxy.macos-redirector.network-extension";
pub const REDIRECTOR_APP_PATH: &str = "/Applications/Mitmproxy Redirector.app";
pub const REDIRECTOR_EXECUTABLE_SHA256: &str =
    "fb154632717ac7780c2706757573f2352a769e07fef7db1e4ae22027d2e4bc7a";
pub const REDIRECTOR_EXTENSION_EXECUTABLE_SHA256: &str =
    "0785d00082db59543c093fe63581d31060f5fdc9677dbf2796bf6ac473f6087a";

pub fn installed_app_path() -> PathBuf {
    PathBuf::from(REDIRECTOR_APP_PATH)
}

pub fn installed_executable_path() -> PathBuf {
    installed_app_path()
        .join("Contents")
        .join("MacOS")
        .join("Mitmproxy Redirector")
}

pub fn installed_extension_path() -> PathBuf {
    installed_app_path()
        .join("Contents")
        .join("Library")
        .join("SystemExtensions")
        .join(format!("{REDIRECTOR_EXTENSION_BUNDLE_ID}.systemextension"))
}

pub fn installed_extension_executable_path() -> PathBuf {
    installed_extension_path()
        .join("Contents")
        .join("MacOS")
        .join(REDIRECTOR_EXTENSION_BUNDLE_ID)
}

pub fn is_installed() -> bool {
    verify_installed().is_ok()
}

pub fn is_redirector_executable(path: &Path) -> bool {
    path == installed_executable_path()
}

/// Refuse lookalike/replaced apps at the well-known path. The exact executable
/// hashes pin v0.12.11, while codesign verifies the intact nested signature and
/// the Team/bundle identities establish the upstream publisher boundary.
#[cfg(target_os = "macos")]
pub fn verify_installed() -> Result<(), String> {
    let app = installed_app_path();
    let executable = installed_executable_path();
    let extension = installed_extension_path();
    let extension_executable = installed_extension_executable_path();
    for path in [&app, &executable, &extension, &extension_executable] {
        if !path.exists() {
            return Err(format!(
                "Mitmproxy Redirector {REDIRECTOR_VERSION} is not installed completely: {} is missing",
                path.display()
            ));
        }
    }

    verify_signature(&app, REDIRECTOR_BUNDLE_ID)?;
    verify_signature(&extension, REDIRECTOR_EXTENSION_BUNDLE_ID)?;
    verify_sha256(&executable, REDIRECTOR_EXECUTABLE_SHA256)?;
    verify_sha256(
        &extension_executable,
        REDIRECTOR_EXTENSION_EXECUTABLE_SHA256,
    )?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn verify_installed() -> Result<(), String> {
    Err("Mitmproxy Redirector is only available on macOS".into())
}

#[cfg(target_os = "macos")]
fn verify_signature(path: &Path, bundle_id: &str) -> Result<(), String> {
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(path)
        .output()
        .map_err(|error| format!("run codesign for {}: {error}", path.display()))?;
    if !verified.status.success() {
        return Err(format!(
            "Mitmproxy Redirector signature verification failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&verified.stderr).trim()
        ));
    }

    let details = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|error| format!("read codesign identity for {}: {error}", path.display()))?;
    if !details.status.success() {
        return Err(format!(
            "read Mitmproxy Redirector signature identity for {}: {}",
            path.display(),
            String::from_utf8_lossy(&details.stderr).trim()
        ));
    }
    let details = String::from_utf8_lossy(&details.stderr);
    if !details
        .lines()
        .any(|line| line == format!("Identifier={bundle_id}"))
        || !details
            .lines()
            .any(|line| line == format!("TeamIdentifier={REDIRECTOR_TEAM_ID}"))
    {
        return Err(format!(
            "Mitmproxy Redirector identity mismatch for {} (expected bundle {bundle_id}, Team ID {REDIRECTOR_TEAM_ID})",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("open pinned Redirector file {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("hash pinned Redirector file {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hex::encode(hasher.finalize());
    if actual != expected {
        return Err(format!(
            "Mitmproxy Redirector {REDIRECTOR_VERSION} file hash mismatch for {}: {actual}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_layout_keeps_upstream_app_intact() {
        assert_eq!(
            installed_executable_path(),
            PathBuf::from(
                "/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector"
            )
        );
        assert!(is_redirector_executable(&installed_executable_path()));
    }

    #[test]
    fn pinned_supply_chain_values_are_not_placeholders() {
        assert_eq!(REDIRECTOR_WHEEL_SHA256.len(), 64);
        assert_eq!(REDIRECTOR_EXECUTABLE_SHA256.len(), 64);
        assert_eq!(REDIRECTOR_EXTENSION_EXECUTABLE_SHA256.len(), 64);
        assert_eq!(REDIRECTOR_TEAM_ID.len(), 10);
        assert!(!REDIRECTOR_VERSION.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_redirector_matches_the_pinned_signed_build_when_present() {
        if installed_app_path().exists() {
            verify_installed().unwrap();
        }
    }
}
