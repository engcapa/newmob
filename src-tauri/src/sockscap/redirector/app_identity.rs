//! macOS application selector identity and code-signing validation.
//!
//! Redirector matches process paths. A persisted path alone is unsafe because
//! an application can be replaced between selection and capture start. This
//! module binds the selector to the bundle identity and designated code-signing
//! requirement, revalidates the bundle immediately before activation, and then
//! refreshes paths/CD hashes for legitimate application updates.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;

use core_foundation::url::CFURL;
use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
use sha2::{Digest, Sha256};

use crate::sockscap::config::{AppSelector, MacosAppIdentity, ScopeMode, SocksCapConfig};

const VALIDATION_FLAGS: Flags = Flags::from_bits_retain(
    Flags::CHECK_ALL_ARCHITECTURES.bits()
        | Flags::CHECK_NESTED_CODE.bits()
        | Flags::STRICT_VALIDATE.bits()
        | Flags::NO_NETWORK_ACCESS.bits(),
);

#[derive(Debug)]
struct SigningDetails {
    signing_id: String,
    team_id: String,
    cd_hash: String,
    designated_requirement: String,
}

/// Validate a user-selected `.app` (or an executable inside one) and return a
/// selector suitable for persistence and Redirector path-family matching.
pub fn validate_application(path: &str, allow_unsigned: bool) -> Result<AppSelector, String> {
    let requested = Path::new(path.trim());
    if path.trim().is_empty() {
        return Err("macOS application path is empty".into());
    }
    let bundle_path = find_app_bundle(requested).ok_or_else(|| {
        format!(
            "macOS application selection must be a .app bundle or an executable inside one: {}",
            requested.display()
        )
    })?;
    let canonical_bundle = std::fs::canonicalize(&bundle_path).map_err(|error| {
        format!(
            "resolve macOS application bundle {}: {error}",
            bundle_path.display()
        )
    })?;
    if !canonical_bundle.is_dir() {
        return Err(format!(
            "macOS application bundle is not a directory: {}",
            canonical_bundle.display()
        ));
    }

    let info = plist::Value::from_file(canonical_bundle.join("Contents/Info.plist"))
        .map_err(|error| format!("read application Info.plist: {error}"))?;
    let info = info
        .as_dictionary()
        .ok_or_else(|| "application Info.plist is not a dictionary".to_string())?;
    let bundle_id = plist_string(info, "CFBundleIdentifier")?;
    let executable_name = plist_string(info, "CFBundleExecutable")?;
    let main_executable = canonical_bundle
        .join("Contents/MacOS")
        .join(&executable_name);
    if !main_executable.is_file() {
        return Err(format!(
            "application main executable is missing: {}",
            main_executable.display()
        ));
    }
    let canonical_executable = std::fs::canonicalize(&main_executable)
        .map_err(|error| format!("resolve application main executable: {error}"))?;

    let signing = match read_signing_details(&canonical_bundle) {
        Ok(details) => {
            validate_static_code(&canonical_bundle, &details.designated_requirement)?;
            if details.signing_id != bundle_id {
                return Err(format!(
                    "application signing identifier '{}' does not match bundle identifier '{}'",
                    details.signing_id, bundle_id
                ));
            }
            details
        }
        Err(_error) if allow_unsigned => SigningDetails {
            signing_id: String::new(),
            team_id: String::new(),
            cd_hash: sha256_file(&canonical_executable)?,
            designated_requirement: String::new(),
        },
        Err(error) => {
            return Err(format!(
                "application is not validly signed ({error}); unsigned application capture must be explicitly enabled"
            ));
        }
    };

    let name = info
        .get("CFBundleDisplayName")
        .and_then(plist::Value::as_string)
        .or_else(|| info.get("CFBundleName").and_then(plist::Value::as_string))
        .map(str::to_string)
        .or_else(|| {
            canonical_bundle
                .file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| bundle_id.clone());
    let canonical_bundle_path = path_text(&canonical_bundle)?;
    let canonical_executable_path = path_text(&canonical_executable)?;

    Ok(AppSelector {
        path: canonical_bundle_path.clone(),
        bundle_id: bundle_id.clone(),
        name,
        macos_identity: Some(MacosAppIdentity {
            bundle_path: path_text(&bundle_path)?,
            canonical_bundle_path,
            main_executable_path: canonical_executable_path,
            bundle_id,
            team_id: signing.team_id,
            signing_id: signing.signing_id,
            designated_requirement: signing.designated_requirement,
            last_validated_cd_hash: signing.cd_hash,
            supplemental_executables: Vec::new(),
            allow_unsigned,
        }),
    })
}

/// Revalidate every active Application profile immediately before capture.
/// Existing configs without identity metadata are upgraded in place.
pub fn revalidate_configuration(config: &mut SocksCapConfig) -> Result<bool, String> {
    let active_ids = config.active_profile_ids.clone();
    let mut changed = false;
    for profile in &mut config.profiles {
        if !profile.enabled
            || !active_ids.contains(&profile.id)
            || !matches!(profile.mode, ScopeMode::Apps)
        {
            continue;
        }
        for selector in &mut profile.apps {
            let refreshed = revalidate_selector(selector).map_err(|error| {
                format!(
                    "macOS application '{}' failed identity validation: {error}",
                    selector.name
                )
            })?;
            if serde_json::to_value(&*selector).ok() != serde_json::to_value(&refreshed).ok() {
                changed = true;
            }
            *selector = refreshed;
        }
    }
    if changed {
        config.normalize();
    }
    Ok(changed)
}

fn revalidate_selector(selector: &AppSelector) -> Result<AppSelector, String> {
    let Some(expected) = selector.macos_identity.as_ref() else {
        return validate_application(&selector.path, false);
    };

    let mut candidates = BTreeSet::new();
    for path in [
        selector.path.as_str(),
        expected.bundle_path.as_str(),
        expected.canonical_bundle_path.as_str(),
    ] {
        if !path.trim().is_empty() && Path::new(path).exists() {
            candidates.insert(PathBuf::from(path));
        }
    }
    if !expected.bundle_id.trim().is_empty() {
        candidates.extend(find_bundles_by_id(&expected.bundle_id));
    }

    let mut matches = Vec::new();
    let mut failures = Vec::new();
    for candidate in candidates {
        match validate_application(&path_text(&candidate)?, expected.allow_unsigned)
            .and_then(|fresh| validate_continuity(expected, fresh))
        {
            Ok(fresh) => {
                if !matches
                    .iter()
                    .any(|item: &AppSelector| item.path == fresh.path)
                {
                    matches.push(fresh);
                }
            }
            Err(error) => failures.push(format!("{}: {error}", candidate.display())),
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(if failures.is_empty() {
            format!(
                "bundle '{}' is missing; reinstall it or select it again",
                expected.bundle_id
            )
        } else {
            failures.join("; ")
        }),
        count => Err(format!(
            "found {count} valid copies of bundle '{}'; keep one copy or select the intended application again",
            expected.bundle_id
        )),
    }
}

fn validate_continuity(
    expected: &MacosAppIdentity,
    mut fresh: AppSelector,
) -> Result<AppSelector, String> {
    let actual = fresh
        .macos_identity
        .as_ref()
        .ok_or_else(|| "refreshed selector has no macOS identity".to_string())?;
    if expected.bundle_id != actual.bundle_id
        || expected.team_id != actual.team_id
        || expected.signing_id != actual.signing_id
    {
        return Err(format!(
            "identity changed (bundle/team/signing was '{}/{}/{}', now '{}/{}/{}')",
            expected.bundle_id,
            expected.team_id,
            expected.signing_id,
            actual.bundle_id,
            actual.team_id,
            actual.signing_id
        ));
    }
    if expected.designated_requirement.is_empty() {
        if !expected.allow_unsigned
            || expected.canonical_bundle_path != actual.canonical_bundle_path
            || expected.last_validated_cd_hash != actual.last_validated_cd_hash
        {
            return Err("unsigned application path or executable hash changed".into());
        }
    } else {
        validate_static_code(
            Path::new(&actual.canonical_bundle_path),
            &expected.designated_requirement,
        )?;
    }

    let fresh_bundle = PathBuf::from(&actual.canonical_bundle_path);
    let expected_bundle = Path::new(&expected.canonical_bundle_path);
    let mut refreshed_supplemental = Vec::new();
    for supplemental in &expected.supplemental_executables {
        let old_path = Path::new(supplemental);
        let candidate = old_path
            .strip_prefix(expected_bundle)
            .map(|relative| fresh_bundle.join(relative))
            .unwrap_or_else(|_| old_path.to_path_buf());
        let candidate_text = path_text(&candidate)?;
        validate_supplemental(&fresh_bundle, &candidate_text, expected)?;
        refreshed_supplemental
            .push(path_text(&std::fs::canonicalize(candidate).map_err(
                |error| format!("resolve refreshed supplemental executable: {error}"),
            )?)?);
    }
    if let Some(identity) = fresh.macos_identity.as_mut() {
        identity.supplemental_executables = refreshed_supplemental;
    }
    Ok(fresh)
}

fn validate_supplemental(
    bundle: &Path,
    supplemental: &str,
    expected: &MacosAppIdentity,
) -> Result<(), String> {
    let path = std::fs::canonicalize(supplemental)
        .map_err(|error| format!("resolve supplemental executable {supplemental}: {error}"))?;
    if !path.starts_with(bundle) || !path.is_file() {
        return Err(format!(
            "supplemental executable is outside the validated bundle: {}",
            path.display()
        ));
    }
    let details = read_signing_details(&path)?;
    if details.team_id != expected.team_id {
        return Err(format!(
            "supplemental executable Team ID '{}' does not match '{}'",
            details.team_id, expected.team_id
        ));
    }
    validate_static_code(&path, &details.designated_requirement)
}

fn validate_static_code(path: &Path, requirement: &str) -> Result<(), String> {
    if requirement.trim().is_empty() {
        return Err("signed application has no designated requirement".into());
    }
    let url = CFURL::from_path(path, path.is_dir())
        .ok_or_else(|| format!("create code-signing URL for {}", path.display()))?;
    let code = SecStaticCode::from_path(&url, Flags::NONE)
        .map_err(|error| format!("open static code {}: {error}", path.display()))?;
    let requirement = SecRequirement::from_str(requirement)
        .map_err(|error| format!("parse designated requirement: {error}"))?;
    code.check_validity(VALIDATION_FLAGS, &requirement)
        .map_err(|error| format!("code signature/seal validation failed: {error}"))
}

fn read_signing_details(path: &Path) -> Result<SigningDetails, String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4", "-r-"])
        .arg(path)
        .output()
        .map_err(|error| format!("run codesign: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    // `codesign` writes the descriptive fields to stderr, but emits the
    // designated requirement to stdout on current macOS releases. Parse both
    // streams so Apple platform-signed apps and Developer ID apps follow the
    // same strict validation path.
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    parse_signing_details(&details)
}

fn parse_signing_details(output: &str) -> Result<SigningDetails, String> {
    if output.contains("Signature=adhoc") || output.contains("(adhoc)") {
        return Err("ad-hoc code signatures are not accepted by default".into());
    }
    let value = |prefix: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(prefix))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let details = SigningDetails {
        signing_id: value("Identifier="),
        team_id: match value("TeamIdentifier=").as_str() {
            "not set" => String::new(),
            team => team.to_string(),
        },
        cd_hash: value("CDHash="),
        designated_requirement: value("designated => "),
    };
    if details.signing_id.is_empty()
        || details.cd_hash.is_empty()
        || details.designated_requirement.is_empty()
    {
        return Err(
            "codesign output is missing identity, CDHash, or designated requirement".into(),
        );
    }
    Ok(details)
}

fn find_bundles_by_id(bundle_id: &str) -> Vec<PathBuf> {
    let escaped = bundle_id.replace('\\', "\\\\").replace('"', "\\\"");
    let query = format!("kMDItemCFBundleIdentifier == \"{escaped}\"c");
    let Ok(output) = Command::new("/usr/bin/mdfind").arg(query).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(PathBuf::from)
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .collect()
}

fn find_app_bundle(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|candidate| candidate.extension().and_then(|value| value.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

fn plist_string(dictionary: &plist::Dictionary, key: &str) -> Result<String, String> {
    dictionary
        .get(key)
        .and_then(plist::Value::as_string)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("application Info.plist is missing {key}"))
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("application path is not valid UTF-8: {}", path.display()))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("open {} for hashing: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("hash {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_bundle_root_from_nested_executable() {
        assert_eq!(
            find_app_bundle(Path::new(
                "/Applications/Example.app/Contents/MacOS/Example"
            )),
            Some(PathBuf::from("/Applications/Example.app"))
        );
        assert_eq!(find_app_bundle(Path::new("/usr/bin/curl")), None);
    }

    #[test]
    fn parses_codesign_identity() {
        let details = parse_signing_details(
            "Identifier=com.example.App\nCDHash=abc123\nTeamIdentifier=TEAM123456\ndesignated => identifier \"com.example.App\" and anchor apple generic\n",
        )
        .unwrap();
        assert_eq!(details.signing_id, "com.example.App");
        assert_eq!(details.team_id, "TEAM123456");
        assert_eq!(details.cd_hash, "abc123");
    }

    #[test]
    fn validates_a_signed_system_application_when_present() {
        let calculator = "/System/Applications/Calculator.app";
        if Path::new(calculator).exists() {
            let selector = validate_application(calculator, false).unwrap();
            assert_eq!(selector.bundle_id, "com.apple.calculator");
            assert!(selector.macos_identity.is_some());
        }
    }
}
