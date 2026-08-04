//! Runtime installer for the pinned, upstream-signed Mitmproxy Redirector.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::{
    REDIRECTOR_APP_PATH, REDIRECTOR_APP_TAR_SHA256, REDIRECTOR_EXTENSION_BUNDLE_ID,
    REDIRECTOR_VERSION, installed_app_path, verify_bundle, verify_publisher_identity,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RedirectorInstallState {
    Ready,
    Missing,
    UpgradeAvailable,
    PendingSystemApproval,
    Conflict,
    ResourceMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedirectorInstallStatus {
    pub state: RedirectorInstallState,
    pub package_version: String,
    pub resource_available: bool,
    pub system_extension_state: RedirectorSystemExtensionState,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RedirectorSystemExtensionState {
    Enabled,
    WaitingForUser,
    NotRegistered,
    Other,
    Unavailable,
}

pub fn status(app: &tauri::AppHandle) -> RedirectorInstallStatus {
    let resource_available = resolve_archive(app).is_some();
    let installed = installed_app_path();
    let system_extension_state = system_extension_state();
    let (state, message) = if !installed.exists() {
        if resource_available {
            (
                RedirectorInstallState::Missing,
                "Mitmproxy Redirector is not installed.".into(),
            )
        } else {
            (
                RedirectorInstallState::ResourceMissing,
                "Mitmproxy Redirector is not installed and the pinned installer resource is unavailable in this build.".into(),
            )
        }
    } else {
        match verify_bundle(&installed) {
            Ok(()) => match system_extension_state {
                RedirectorSystemExtensionState::WaitingForUser => (
                    RedirectorInstallState::PendingSystemApproval,
                    "Mitmproxy Redirector is waiting for approval in System Settings. Approve its System Extension, then retry Start or Recover; repeated attempts cannot bypass macOS approval."
                        .into(),
                ),
                RedirectorSystemExtensionState::NotRegistered
                | RedirectorSystemExtensionState::Other => (
                    RedirectorInstallState::PendingSystemApproval,
                    "Mitmproxy Redirector is installed and verified. Start SocksCap once, then approve its System Extension and network configuration in System Settings.".into(),
                ),
                RedirectorSystemExtensionState::Enabled
                | RedirectorSystemExtensionState::Unavailable => (
                    RedirectorInstallState::Ready,
                    format!("Mitmproxy Redirector {REDIRECTOR_VERSION} is installed and verified."),
                ),
            },
            Err(error) => match verify_publisher_identity(&installed) {
                Ok(()) if resource_available => (
                    RedirectorInstallState::UpgradeAvailable,
                    format!(
                        "A signed Mitmproxy Redirector from the expected publisher needs replacement: {error}"
                    ),
                ),
                Ok(()) => (
                    RedirectorInstallState::ResourceMissing,
                    format!(
                        "The installed Redirector needs replacement, but the pinned resource is unavailable: {error}"
                    ),
                ),
                Err(identity_error) => (
                    RedirectorInstallState::Conflict,
                    format!(
                        "Refusing to replace the app at {REDIRECTOR_APP_PATH}: {identity_error}"
                    ),
                ),
            },
        }
    };
    RedirectorInstallStatus {
        state,
        package_version: REDIRECTOR_VERSION.into(),
        resource_available,
        system_extension_state,
        message,
    }
}

pub fn install(app: &tauri::AppHandle) -> Result<RedirectorInstallStatus, String> {
    let current = status(app);
    match current.state {
        RedirectorInstallState::Ready => return Ok(current),
        RedirectorInstallState::PendingSystemApproval => return Ok(current),
        RedirectorInstallState::Conflict => return Err(current.message),
        RedirectorInstallState::ResourceMissing => return Err(current.message),
        RedirectorInstallState::Missing | RedirectorInstallState::UpgradeAvailable => {}
    }

    let archive = resolve_archive(app).ok_or_else(|| {
        format!("pinned Mitmproxy Redirector {REDIRECTOR_VERSION} resource is missing")
    })?;
    verify_sha256(&archive, REDIRECTOR_APP_TAR_SHA256)?;

    let extraction = tempfile::Builder::new()
        .prefix("taomni-redirector-install-")
        .tempdir()
        .map_err(|error| format!("create Redirector install directory: {error}"))?;
    let extracted = extraction.path().join("Mitmproxy Redirector.app");
    let output = Command::new("/usr/bin/tar")
        .args(["-xf"])
        .arg(&archive)
        .arg("-C")
        .arg(extraction.path())
        .output()
        .map_err(|error| format!("extract Redirector resource: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "extract Redirector resource: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    verify_supply_chain(&extracted)?;

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let stage = PathBuf::from(format!(
        "/Applications/.taomni-redirector-stage-{suffix}.app"
    ));
    let backup = PathBuf::from(format!(
        "/Applications/.taomni-redirector-backup-{suffix}.app"
    ));
    if stage.exists() || backup.exists() {
        return Err("generated Redirector staging path already exists".into());
    }
    install_with_authorization(&extracted, &installed_app_path(), &stage, &backup)?;
    verify_supply_chain(&installed_app_path())?;
    Ok(status(app))
}

pub(crate) fn system_extension_state() -> RedirectorSystemExtensionState {
    let output = Command::new("/usr/bin/systemextensionsctl")
        .arg("list")
        .output()
        .ok();
    let Some(output) = output else {
        return RedirectorSystemExtensionState::Unavailable;
    };
    if !output.status.success() {
        return RedirectorSystemExtensionState::Unavailable;
    }
    parse_system_extension_state(&String::from_utf8_lossy(&output.stdout))
}

fn parse_system_extension_state(output: &str) -> RedirectorSystemExtensionState {
    let matching = output
        .lines()
        .filter(|line| line.contains(REDIRECTOR_EXTENSION_BUNDLE_ID))
        .collect::<Vec<_>>();
    if matching
        .iter()
        .any(|line| line.contains("[activated enabled]"))
    {
        RedirectorSystemExtensionState::Enabled
    } else if matching
        .iter()
        .any(|line| line.contains("waiting for user"))
    {
        RedirectorSystemExtensionState::WaitingForUser
    } else if matching.is_empty() {
        RedirectorSystemExtensionState::NotRegistered
    } else {
        RedirectorSystemExtensionState::Other
    }
}

fn resolve_archive(app: &tauri::AppHandle) -> Option<PathBuf> {
    let relative = Path::new("sockscap")
        .join("macos/redirector")
        .join(REDIRECTOR_VERSION)
        .join("Mitmproxy Redirector.app.tar");
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&relative));
        candidates.push(resource_dir.join("resources").join(&relative));
    }
    candidates.push(PathBuf::from("src-tauri/resources").join(&relative));
    candidates.push(PathBuf::from("resources").join(&relative));
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn verify_supply_chain(app: &Path) -> Result<(), String> {
    verify_bundle(app)?;
    let executable = app.join("Contents/MacOS/Mitmproxy Redirector");
    let extension = app
        .join("Contents/Library/SystemExtensions")
        .join(format!("{REDIRECTOR_EXTENSION_BUNDLE_ID}.systemextension"));
    let extension_executable = extension
        .join("Contents/MacOS")
        .join(REDIRECTOR_EXTENSION_BUNDLE_ID);
    verify_universal(&executable)?;
    verify_universal(&extension_executable)?;
    verify_entitlement(app, "com.apple.developer.system-extension.install")?;
    verify_entitlement(app, "app-proxy-provider-systemextension")?;
    verify_entitlement(&extension, "app-proxy-provider-systemextension")?;

    let assessment = Command::new("/usr/sbin/spctl")
        .args(["--assess", "--type", "execute", "--verbose=4"])
        .arg(app)
        .output()
        .map_err(|error| format!("run Gatekeeper assessment: {error}"))?;
    let assessment_text = format!(
        "{}{}",
        String::from_utf8_lossy(&assessment.stdout),
        String::from_utf8_lossy(&assessment.stderr)
    );
    if !assessment.status.success() || !assessment_text.contains("Notarized Developer ID") {
        return Err(format!(
            "Redirector Gatekeeper/notarization assessment failed: {}",
            assessment_text.trim()
        ));
    }
    Ok(())
}

fn verify_universal(executable: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/lipo")
        .arg("-archs")
        .arg(executable)
        .output()
        .map_err(|error| {
            format!(
                "inspect architectures for {}: {error}",
                executable.display()
            )
        })?;
    let architectures = String::from_utf8_lossy(&output.stdout);
    if !output.status.success()
        || !architectures.split_whitespace().any(|arch| arch == "arm64")
        || !architectures
            .split_whitespace()
            .any(|arch| arch == "x86_64")
    {
        return Err(format!(
            "Redirector executable is not universal arm64+x86_64: {} ({})",
            executable.display(),
            architectures.trim()
        ));
    }
    Ok(())
}

fn verify_entitlement(path: &Path, required: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "--entitlements", "-"])
        .arg(path)
        .output()
        .map_err(|error| format!("read Redirector entitlements: {error}"))?;
    let entitlements = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() || !entitlements.contains(required) {
        return Err(format!(
            "Redirector entitlement {required:?} is missing from {}",
            path.display()
        ));
    }
    Ok(())
}

fn install_with_authorization(
    source: &Path,
    target: &Path,
    stage: &Path,
    backup: &Path,
) -> Result<(), String> {
    let script = r#"on run argv
set sourcePath to item 1 of argv
set targetPath to item 2 of argv
set stagePath to item 3 of argv
set backupPath to item 4 of argv
set commandText to "set -e; /usr/bin/ditto " & quoted form of sourcePath & " " & quoted form of stagePath & "; if [ -e " & quoted form of targetPath & " ]; then /bin/mv " & quoted form of targetPath & " " & quoted form of backupPath & "; fi; if /bin/mv " & quoted form of stagePath & " " & quoted form of targetPath & "; then if [ -e " & quoted form of backupPath & " ]; then /bin/rm -rf " & quoted form of backupPath & "; fi; else if [ -e " & quoted form of backupPath & " ]; then /bin/mv " & quoted form of backupPath & " " & quoted form of targetPath & "; fi; exit 1; fi"
do shell script commandText with administrator privileges
end run"#;
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .arg(path_text(source)?)
        .arg(path_text(target)?)
        .arg(path_text(stage)?)
        .arg(path_text(backup)?)
        .output()
        .map_err(|error| format!("request Redirector installation authorization: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Redirector installation was not completed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("open Redirector archive {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("hash Redirector archive: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let actual = hex::encode(hasher.finalize());
    if actual != expected {
        return Err(format!(
            "Redirector archive SHA-256 mismatch: expected {expected}, found {actual}"
        ));
    }
    Ok(())
}

fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str().ok_or_else(|| {
        format!(
            "Redirector install path is not valid UTF-8: {}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_install_targets_stay_inside_applications() {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        for path in [
            PathBuf::from(format!(
                "/Applications/.taomni-redirector-stage-{suffix}.app"
            )),
            PathBuf::from(format!(
                "/Applications/.taomni-redirector-backup-{suffix}.app"
            )),
        ] {
            assert_eq!(path.parent(), Some(Path::new("/Applications")));
            assert_eq!(
                path.extension().and_then(|value| value.to_str()),
                Some("app")
            );
        }
    }

    #[test]
    fn installed_bundle_passes_the_full_supply_chain_gate_when_present() {
        if installed_app_path().exists() {
            verify_supply_chain(&installed_app_path()).unwrap();
        }
    }

    #[test]
    fn parses_system_extension_approval_states() {
        let waiting = "\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector.network-extension (2.0/1)\tnetwork-extension\t[activated waiting for user]";
        assert_eq!(
            parse_system_extension_state(waiting),
            RedirectorSystemExtensionState::WaitingForUser
        );

        let enabled = "*\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector.network-extension (2.0/1)\tnetwork-extension\t[activated enabled]";
        assert_eq!(
            parse_system_extension_state(enabled),
            RedirectorSystemExtensionState::Enabled
        );
        assert_eq!(
            parse_system_extension_state("no matching extensions"),
            RedirectorSystemExtensionState::NotRegistered
        );
    }
}
