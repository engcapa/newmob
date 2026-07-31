//! jdtls extension bundle resolution (M8 Bundle 基建).
//!
//! jdtls loads extensions via `initializationOptions.bundles[]` — an array of
//! absolute jar paths. Debugging (java-debug) and testing (java-test) are such
//! extensions. This module resolves the highest-versioned jar for each from a
//! user-configured directory (or an explicit jar path) and reports availability.
//!
//! Lombok is intentionally NOT a bundle: it loads as a `-javaagent` (see
//! `lombok_javaagent_arg` in `lsp.rs`), which is the correct mechanism for it.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};

/// A jdtls extension bundle we know how to load.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleKind {
    /// `com.microsoft.java.debug.plugin-*.jar` (java-debug → DAP adapter).
    JavaDebug,
    /// `com.microsoft.java.test.plugin-*.jar` (java-test → test discovery/run).
    JavaTest,
}

impl BundleKind {
    /// Jar filename prefix (before the version) for this bundle.
    fn jar_prefix(self) -> &'static str {
        match self {
            BundleKind::JavaDebug => "com.microsoft.java.debug.plugin-",
            BundleKind::JavaTest => "com.microsoft.java.test.plugin-",
        }
    }

    fn config_key(self) -> &'static str {
        match self {
            BundleKind::JavaDebug => "javaDebug",
            BundleKind::JavaTest => "javaTest",
        }
    }
}

/// User-configured bundle locations. Each entry may be a directory to scan for
/// the versioned jar, or an explicit path to the jar itself. Empty → not
/// configured (that bundle simply is not injected).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaBundleConfig {
    /// Directory holding `com.microsoft.java.debug.plugin-*.jar`, or the jar path.
    pub java_debug_path: Option<String>,
    /// Directory holding `com.microsoft.java.test.plugin-*.jar`, or the jar path.
    pub java_test_path: Option<String>,
}
impl JavaBundleConfig {
    fn path_for(&self, kind: BundleKind) -> Option<&str> {
        let raw = match kind {
            BundleKind::JavaDebug => self.java_debug_path.as_deref(),
            BundleKind::JavaTest => self.java_test_path.as_deref(),
        };
        raw.map(str::trim).filter(|value| !value.is_empty())
    }
}

/// Availability of one bundle after probing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleStatus {
    /// Stable id (`javaDebug` / `javaTest`) so the UI can key on it.
    pub id: String,
    /// Resolved absolute jar path, when found.
    pub path: Option<String>,
    pub available: bool,
}

/// Parse a dotted numeric version (`0.53.1`) into comparable components. Trailing
/// non-numeric suffixes are ignored so `0.53.1.202401` still orders sensibly.
fn numeric_version(raw: &str) -> Vec<u64> {
    raw.split(['.', '-', '_'])
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// Compare two dotted-numeric versions component-wise (missing → 0).
fn compare_versions(left: &str, right: &str) -> Ordering {
    let left = numeric_version(left);
    let right = numeric_version(right);
    let len = left.len().max(right.len());
    for i in 0..len {
        let l = left.get(i).copied().unwrap_or(0);
        let r = right.get(i).copied().unwrap_or(0);
        match l.cmp(&r) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

/// Resolve the jar for `kind` from a configured path. If the path is a jar file,
/// use it directly; if a directory, pick the highest-versioned
/// `<prefix><version>.jar` inside it. Returns `None` when unset / nothing matches.
fn resolve_bundle_jar(kind: BundleKind, configured: Option<&str>) -> Option<PathBuf> {
    let path = PathBuf::from(configured?.trim());
    if path.is_file() {
        return Some(path);
    }
    if !path.is_dir() {
        return None;
    }
    let prefix = kind.jar_prefix();
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(&path).ok()?.flatten() {
        let entry_path = entry.path();
        let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(version) = rest.strip_suffix(".jar") else {
            continue;
        };
        let better = match &best {
            Some((best_version, _)) => compare_versions(version, best_version) == Ordering::Greater,
            None => true,
        };
        if better {
            best = Some((version.to_string(), entry_path));
        }
    }
    best.map(|(_, jar)| jar)
}

/// Resolve the absolute jar paths to inject into `initializationOptions.bundles`
/// (java-debug + java-test, in that order). Missing ones are simply omitted.
pub fn resolve_bundle_jars(config: &JavaBundleConfig) -> Vec<String> {
    [BundleKind::JavaDebug, BundleKind::JavaTest]
        .into_iter()
        .filter_map(|kind| {
            resolve_bundle_jar(kind, config.path_for(kind))
                .map(|jar| jar.to_string_lossy().into_owned())
        })
        .collect()
}

/// Probe each known bundle against `config` for the Settings UI.
pub fn probe_bundles(config: &JavaBundleConfig) -> Vec<BundleStatus> {
    [BundleKind::JavaDebug, BundleKind::JavaTest]
        .into_iter()
        .map(|kind| {
            let path = resolve_bundle_jar(kind, config.path_for(kind))
                .map(|jar| jar.to_string_lossy().into_owned());
            BundleStatus {
                id: kind.config_key().to_string(),
                available: path.is_some(),
                path,
            }
        })
        .collect()
}

static CONFIGURED_JAVA_BUNDLES: OnceLock<StdMutex<JavaBundleConfig>> = OnceLock::new();

fn configured_lock() -> &'static StdMutex<JavaBundleConfig> {
    CONFIGURED_JAVA_BUNDLES.get_or_init(|| StdMutex::new(JavaBundleConfig::default()))
}

/// Store the Settings-configured bundle paths (applied on the next jdtls start).
pub fn set_configured_bundles(config: JavaBundleConfig) {
    if let Ok(mut guard) = configured_lock().lock() {
        *guard = config;
    }
}

/// Current bundle config (default when unset).
pub fn get_configured_bundles() -> JavaBundleConfig {
    configured_lock()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Absolute jar paths for `initializationOptions.bundles`, from stored config.
pub fn configured_bundle_jars() -> Vec<String> {
    resolve_bundle_jars(&get_configured_bundles())
}

/// A jdtls extension jar found on disk that the user could adopt without any
/// manual path hunting or download (the 80% "install is complex" case: the jar
/// already ships inside a VS Code / Cursor / VSCodium extension).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredBundle {
    /// `javaDebug` | `javaTest`, matching `BundleStatus.id`.
    pub id: String,
    /// Absolute path to the versioned plugin jar.
    pub path: String,
    /// Parsed dotted version (`0.53.2`) for display / picking the newest.
    pub version: String,
    /// Human label for where it came from (e.g. `vscode: vscjava.vscode-java-debug`).
    pub source: String,
}

/// Editor extension roots that commonly contain the java-debug / java-test
/// plugin jars, cross-platform. VS Code, VSCodium, Cursor, and the Insiders
/// build all use `<home>/.<editor>/extensions` on every OS.
fn editor_extension_roots() -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    for (label, rel) in [
        ("vscode", ".vscode/extensions"),
        ("vscode-insiders", ".vscode-insiders/extensions"),
        ("vscode-server", ".vscode-server/extensions"),
        ("cursor", ".cursor/extensions"),
        ("vscodium", ".vscode-oss/extensions"),
        ("windsurf", ".windsurf/extensions"),
    ] {
        out.push((label, home.join(rel)));
    }
    out
}

/// Scan the known editor extension roots for the newest plugin jar of each
/// bundle kind. One entry per (source, kind); newest version per source wins.
/// Pure filesystem scan — never downloads, never mutates config.
pub fn discover_bundles() -> Vec<DiscoveredBundle> {
    let mut out: Vec<DiscoveredBundle> = Vec::new();
    for (label, root) in editor_extension_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let ext_dir = entry.path();
            if !ext_dir.is_dir() {
                continue;
            }
            // Extension dirs are named `publisher.name-version`; the jars live
            // under `server/`. Only the java debug/test extensions carry them.
            let server_dir = ext_dir.join("server");
            if !server_dir.is_dir() {
                continue;
            }
            let ext_name = ext_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            for kind in [BundleKind::JavaDebug, BundleKind::JavaTest] {
                if let Some((version, path)) =
                    newest_jar_in_dir(&server_dir, kind.jar_prefix())
                {
                    let source = format!("{label}: {ext_name}");
                    push_newest_discovery(&mut out, kind, version, path, source);
                }
            }
        }
    }
    out
}

/// Highest-versioned `<prefix><version>.jar` in `dir`, or None.
fn newest_jar_in_dir(dir: &Path, prefix: &str) -> Option<(String, PathBuf)> {
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(version) = rest.strip_suffix(".jar") else {
            continue;
        };
        let better = match &best {
            Some((best_version, _)) => compare_versions(version, best_version) == Ordering::Greater,
            None => true,
        };
        if better {
            best = Some((version.to_string(), path));
        }
    }
    best
}

/// Insert a discovery, keeping only the newest jar per (id, source).
fn push_newest_discovery(
    out: &mut Vec<DiscoveredBundle>,
    kind: BundleKind,
    version: String,
    path: PathBuf,
    source: String,
) {
    let id = kind.config_key().to_string();
    if let Some(existing) = out
        .iter_mut()
        .find(|d| d.id == id && d.source == source)
    {
        if compare_versions(&version, &existing.version) == Ordering::Greater {
            existing.version = version;
            existing.path = path.to_string_lossy().into_owned();
        }
        return;
    }
    out.push(DiscoveredBundle {
        id,
        path: path.to_string_lossy().into_owned(),
        version,
        source,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"jar").unwrap();
    }

    #[test]
    fn compares_dotted_versions_numerically_not_lexically() {
        assert_eq!(compare_versions("0.53.1", "0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.40.0", "0.40.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.1"), Ordering::Less);
    }

    #[test]
    fn picks_highest_version_jar_in_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.9.0.jar");
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.53.1.jar");
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.40.0.jar");
        touch(dir.path(), "unrelated.jar");

        let jar = resolve_bundle_jar(BundleKind::JavaDebug, Some(dir.path().to_str().unwrap()))
            .expect("resolves a jar");
        assert!(jar.to_string_lossy().ends_with("com.microsoft.java.debug.plugin-0.53.1.jar"));
    }

    #[test]
    fn accepts_an_explicit_jar_path() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.test.plugin-0.41.1.jar");
        let explicit = dir.path().join("com.microsoft.java.test.plugin-0.41.1.jar");
        let jar = resolve_bundle_jar(BundleKind::JavaTest, Some(explicit.to_str().unwrap()))
            .expect("explicit jar resolves");
        assert_eq!(jar, explicit);
    }

    #[test]
    fn resolve_and_probe_reflect_configured_paths() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.52.0.jar");
        // Only java-debug configured; java-test unset.
        let config = JavaBundleConfig {
            java_debug_path: Some(dir.path().to_string_lossy().into_owned()),
            java_test_path: Some("   ".into()),
        };
        let jars = resolve_bundle_jars(&config);
        assert_eq!(jars.len(), 1, "only java-debug should resolve, got {jars:?}");
        assert!(jars[0].ends_with("com.microsoft.java.debug.plugin-0.52.0.jar"));

        let statuses = probe_bundles(&config);
        assert_eq!(statuses.len(), 2);
        let debug = statuses.iter().find(|s| s.id == "javaDebug").unwrap();
        assert!(debug.available && debug.path.is_some());
        let test = statuses.iter().find(|s| s.id == "javaTest").unwrap();
        assert!(!test.available && test.path.is_none());
    }

    #[test]
    fn missing_config_yields_no_bundles() {
        assert!(resolve_bundle_jars(&JavaBundleConfig::default()).is_empty());
        assert!(resolve_bundle_jar(BundleKind::JavaDebug, None).is_none());
        assert!(resolve_bundle_jar(BundleKind::JavaDebug, Some("/no/such/dir")).is_none());
    }

    #[test]
    fn newest_jar_in_dir_picks_highest_and_ignores_others() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.40.0.jar");
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.53.2.jar");
        touch(dir.path(), "com.microsoft.java.test.plugin-0.43.1.jar");
        touch(dir.path(), "noise.jar");

        let (version, path) =
            newest_jar_in_dir(dir.path(), BundleKind::JavaDebug.jar_prefix()).expect("finds debug jar");
        assert_eq!(version, "0.53.2");
        assert!(path.to_string_lossy().ends_with("com.microsoft.java.debug.plugin-0.53.2.jar"));

        // A prefix with no match yields nothing rather than a wrong jar.
        assert!(newest_jar_in_dir(dir.path(), "com.example.absent-").is_none());
    }

    #[test]
    fn push_newest_discovery_keeps_newest_per_source() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        push_newest_discovery(
            &mut out,
            BundleKind::JavaDebug,
            "0.52.0".into(),
            dir.path().join("com.microsoft.java.debug.plugin-0.52.0.jar"),
            "vscode: vscjava.vscode-java-debug-0.58.0".into(),
        );
        // Same source, newer version → replaces in place (no duplicate row).
        push_newest_discovery(
            &mut out,
            BundleKind::JavaDebug,
            "0.53.2".into(),
            dir.path().join("com.microsoft.java.debug.plugin-0.53.2.jar"),
            "vscode: vscjava.vscode-java-debug-0.58.0".into(),
        );
        // A different source is a distinct row the user can choose between.
        push_newest_discovery(
            &mut out,
            BundleKind::JavaDebug,
            "0.53.2".into(),
            dir.path().join("com.microsoft.java.debug.plugin-0.53.2.jar"),
            "cursor: vscjava.vscode-java-debug-0.58.5".into(),
        );
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|d| d.id == "javaDebug" && d.version == "0.53.2"));
    }
}

