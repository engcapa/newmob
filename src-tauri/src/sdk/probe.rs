use super::{SdkKind, SdkProbe, SdkStatus};
use regex::Regex;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DISCOVERY_CANDIDATES: usize = 100;

#[derive(Debug)]
struct LocatedSdk {
    location: PathBuf,
    executables: BTreeMap<String, String>,
    primary: Option<PathBuf>,
    missing: Vec<&'static str>,
}

pub async fn probe_sdk(kind: SdkKind, location: &str) -> SdkProbe {
    let expanded = shellexpand::tilde(location.trim()).to_string();
    let requested = PathBuf::from(&expanded);
    if expanded.trim().is_empty() {
        return failed_probe(
            kind,
            requested,
            SdkStatus::Missing,
            "SDK location is required",
        );
    }
    if !requested.exists() {
        return failed_probe(
            kind,
            requested,
            SdkStatus::Missing,
            "SDK location does not exist",
        );
    }

    let located = locate_sdk(kind, &requested);
    let location = canonical_or_original(&located.location);
    if !located.missing.is_empty() {
        return SdkProbe {
            kind,
            location: path_string(&location),
            executables: located.executables,
            version: version_from_distribution(kind, &location),
            vendor: None,
            architecture: Some(std::env::consts::ARCH.to_string()),
            status: SdkStatus::Invalid,
            error: Some(format!(
                "Missing required executable{}: {}",
                if located.missing.len() == 1 { "" } else { "s" },
                located.missing.join(", ")
            )),
            source: None,
        };
    }

    let mut output_text = String::new();
    let mut command_error = None;
    if let Some(primary) = located.primary.as_ref() {
        if can_execute_directly(primary) {
            match read_version_output(kind, primary).await {
                Ok(text) => output_text = text,
                Err(error) => command_error = Some(error),
            }
        }
    }
    let version =
        version_from_distribution(kind, &location).or_else(|| parse_version(kind, &output_text));
    let vendor = if kind == SdkKind::Java {
        parse_java_vendor(&output_text)
    } else {
        None
    };
    let status = if command_error.is_some() && version.is_none() {
        SdkStatus::Invalid
    } else {
        SdkStatus::Ready
    };

    SdkProbe {
        kind,
        location: path_string(&location),
        executables: located.executables,
        version,
        vendor,
        architecture: Some(std::env::consts::ARCH.to_string()),
        status,
        error: command_error,
        source: None,
    }
}

pub async fn discover_sdks(kinds: &[SdkKind]) -> Vec<SdkProbe> {
    let candidates = discovery_candidates(kinds);
    let mut probes = Vec::with_capacity(candidates.len());
    for (kind, location, source) in candidates {
        let mut probe = probe_sdk(kind, &location).await;
        probe.source = Some(source);
        if probe.status == SdkStatus::Ready {
            probes.push(probe);
        }
    }
    probes.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.version.cmp(&right.version))
            .then_with(|| left.location.cmp(&right.location))
    });
    probes.dedup_by(|left, right| left.kind == right.kind && left.location == right.location);
    probes
}

fn failed_probe(kind: SdkKind, location: PathBuf, status: SdkStatus, error: &str) -> SdkProbe {
    SdkProbe {
        kind,
        location: path_string(&location),
        executables: BTreeMap::new(),
        version: None,
        vendor: None,
        architecture: Some(std::env::consts::ARCH.to_string()),
        status,
        error: Some(error.to_string()),
        source: None,
    }
}

fn locate_sdk(kind: SdkKind, requested: &Path) -> LocatedSdk {
    match kind {
        SdkKind::Java => locate_home_sdk(requested, "java", &["java", "javac"]),
        SdkKind::Kotlin => locate_home_sdk(requested, "kotlinc", &["kotlinc"]),
        SdkKind::Scala => locate_home_sdk(requested, "scala", &["scala", "scalac"]),
        SdkKind::Python => locate_python(requested),
    }
}

fn locate_home_sdk(requested: &Path, primary_name: &str, required: &[&'static str]) -> LocatedSdk {
    let location = if requested.is_file() {
        requested
            .parent()
            .and_then(|bin| bin.parent())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| requested.to_path_buf())
    } else {
        requested.to_path_buf()
    };
    let bin = location.join("bin");
    let mut executables = BTreeMap::new();
    let mut missing = Vec::new();
    for name in required {
        if let Some(path) = find_executable(&bin, name) {
            executables.insert(
                (*name).to_string(),
                path_string(&canonical_or_original(&path)),
            );
        } else {
            missing.push(*name);
        }
    }
    if !required.contains(&primary_name) {
        if let Some(path) = find_executable(&bin, primary_name) {
            executables.insert(
                primary_name.to_string(),
                path_string(&canonical_or_original(&path)),
            );
        }
    }
    let primary = executables.get(primary_name).map(PathBuf::from);
    LocatedSdk {
        location,
        executables,
        primary,
        missing,
    }
}

fn locate_python(requested: &Path) -> LocatedSdk {
    let (location, explicit) = if requested.is_file() {
        let parent = requested.parent().unwrap_or(requested);
        let location = if parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("bin") || name.eq_ignore_ascii_case("scripts")
            }) {
            parent.parent().unwrap_or(parent).to_path_buf()
        } else {
            parent.to_path_buf()
        };
        (location, Some(requested.to_path_buf()))
    } else {
        (requested.to_path_buf(), None)
    };

    let primary = explicit.or_else(|| {
        let search_dirs = if cfg!(windows) {
            vec![location.clone(), location.join("Scripts")]
        } else {
            vec![location.join("bin"), location.clone()]
        };
        search_dirs.into_iter().find_map(|dir| {
            find_executable(&dir, "python3").or_else(|| find_executable(&dir, "python"))
        })
    });
    let mut executables = BTreeMap::new();
    let mut missing = Vec::new();
    if let Some(path) = primary.as_ref() {
        executables.insert(
            "python".to_string(),
            path_string(&canonical_or_original(path)),
        );
    } else {
        missing.push("python");
    }
    LocatedSdk {
        location,
        executables,
        primary,
        missing,
    }
}

fn find_executable(dir: &Path, name: &str) -> Option<PathBuf> {
    executable_names(name)
        .into_iter()
        .map(|candidate| dir.join(candidate))
        .find(|candidate| candidate.is_file())
}

fn executable_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    }
}

fn can_execute_directly(path: &Path) -> bool {
    !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
        })
}

async fn read_version_output(kind: SdkKind, executable: &Path) -> Result<String, String> {
    let mut command = Command::new(executable);
    command.kill_on_drop(true);
    match kind {
        SdkKind::Java | SdkKind::Kotlin | SdkKind::Scala => {
            command.arg("-version");
        }
        SdkKind::Python => {
            command.arg("--version");
        }
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| "SDK version probe timed out".to_string())?
        .map_err(|error| format!("SDK version probe failed: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}").trim().to_string();
    if !output.status.success() {
        return Err(if combined.is_empty() {
            format!("SDK version probe exited with {}", output.status)
        } else {
            format!("SDK version probe failed: {combined}")
        });
    }
    Ok(combined)
}

fn parse_version(kind: SdkKind, output: &str) -> Option<String> {
    let pattern = match kind {
        SdkKind::Java => r#"(?i)(?:openjdk|java) version\s+\"?([^\"\s]+)"#,
        SdkKind::Kotlin => r"(?i)kotlinc(?:-jvm)?\s+([0-9][^\s()]*)",
        SdkKind::Scala => r"(?i)(?:scala(?: code runner| compiler)? version)\s+([0-9][^\s,]*)",
        SdkKind::Python => r"(?i)python\s+([0-9][^\s]*)",
    };
    Regex::new(pattern)
        .ok()?
        .captures(output)?
        .get(1)
        .map(|capture| capture.as_str().trim().to_string())
}

fn parse_java_vendor(output: &str) -> Option<String> {
    let lowered = output.to_ascii_lowercase();
    for (needle, vendor) in [
        ("temurin", "Eclipse Temurin"),
        ("adoptium", "Eclipse Adoptium"),
        ("corretto", "Amazon Corretto"),
        ("zulu", "Azul Zulu"),
        ("graalvm", "GraalVM"),
        ("microsoft", "Microsoft"),
        ("openjdk", "OpenJDK"),
        ("java(tm)", "Oracle"),
    ] {
        if lowered.contains(needle) {
            return Some(vendor.to_string());
        }
    }
    None
}

fn version_from_distribution(kind: SdkKind, location: &Path) -> Option<String> {
    match kind {
        SdkKind::Kotlin => std::fs::read_to_string(location.join("build.txt"))
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty()),
        SdkKind::Scala => scala_version_from_lib(location),
        _ => None,
    }
}

fn scala_version_from_lib(location: &Path) -> Option<String> {
    let entries = std::fs::read_dir(location.join("lib")).ok()?;
    let patterns = [
        Regex::new(r"^scala3-library_3-([0-9][^.]*?(?:\.[^.]*?)*)\.jar$").ok()?,
        Regex::new(r"^scala-library-([0-9][^.]*?(?:\.[^.]*?)*)\.jar$").ok()?,
    ];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        for pattern in &patterns {
            if let Some(version) = pattern.captures(&name).and_then(|captures| captures.get(1)) {
                return Some(version.as_str().to_string());
            }
        }
    }
    None
}

fn discovery_candidates(kinds: &[SdkKind]) -> Vec<(SdkKind, String, String)> {
    let requested: HashSet<SdkKind> = kinds.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    for (kind, variable) in [
        (SdkKind::Java, "JAVA_HOME"),
        (SdkKind::Java, "JDK_HOME"),
        (SdkKind::Kotlin, "KOTLIN_HOME"),
        (SdkKind::Scala, "SCALA_HOME"),
        (SdkKind::Python, "VIRTUAL_ENV"),
        (SdkKind::Python, "CONDA_PREFIX"),
    ] {
        if requested.contains(&kind) {
            if let Some(value) = std::env::var_os(variable) {
                add_discovery_candidate(
                    &mut candidates,
                    &mut seen,
                    kind,
                    PathBuf::from(value),
                    format!("environment:{variable}"),
                );
            }
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for (kind, names) in [
                (SdkKind::Java, &["java"][..]),
                (SdkKind::Kotlin, &["kotlinc"][..]),
                (SdkKind::Scala, &["scala"][..]),
                (SdkKind::Python, &["python3", "python"][..]),
            ] {
                if !requested.contains(&kind) {
                    continue;
                }
                if let Some(executable) = names.iter().find_map(|name| find_executable(&dir, name))
                {
                    add_discovery_candidate(
                        &mut candidates,
                        &mut seen,
                        kind,
                        guess_home_from_executable(kind, &executable),
                        "PATH".to_string(),
                    );
                }
            }
        }
    }

    for (kind, root, source) in common_discovery_roots() {
        if !requested.contains(&kind) || !root.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten().take(MAX_DISCOVERY_CANDIDATES) {
            let path = entry.path();
            if path.is_dir() {
                add_discovery_candidate(&mut candidates, &mut seen, kind, path, source.clone());
            }
        }
    }

    candidates.truncate(MAX_DISCOVERY_CANDIDATES);
    candidates
}

fn add_discovery_candidate(
    candidates: &mut Vec<(SdkKind, String, String)>,
    seen: &mut HashSet<(SdkKind, String)>,
    kind: SdkKind,
    path: PathBuf,
    source: String,
) {
    if candidates.len() >= MAX_DISCOVERY_CANDIDATES {
        return;
    }
    let normalized = path_string(&canonical_or_original(&path));
    let key = (kind, normalized.to_ascii_lowercase());
    if seen.insert(key) {
        candidates.push((kind, normalized, source));
    }
}

fn guess_home_from_executable(kind: SdkKind, executable: &Path) -> PathBuf {
    let parent = executable.parent().unwrap_or(executable);
    if kind == SdkKind::Python
        && !parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("bin") || name.eq_ignore_ascii_case("scripts")
            })
    {
        return parent.to_path_buf();
    }
    parent.parent().unwrap_or(parent).to_path_buf()
}

fn common_discovery_roots() -> Vec<(SdkKind, PathBuf, String)> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push((SdkKind::Java, home.join(".jdks"), "home:.jdks".to_string()));
        roots.push((
            SdkKind::Java,
            home.join(".sdkman/candidates/java"),
            "sdkman".to_string(),
        ));
        roots.push((
            SdkKind::Kotlin,
            home.join(".sdkman/candidates/kotlin"),
            "sdkman".to_string(),
        ));
        roots.push((
            SdkKind::Scala,
            home.join(".sdkman/candidates/scala"),
            "sdkman".to_string(),
        ));
        roots.push((
            SdkKind::Python,
            home.join(".pyenv/versions"),
            "pyenv".to_string(),
        ));
    }
    if cfg!(windows) {
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(program_files) = std::env::var_os(variable) {
                let base = PathBuf::from(program_files);
                roots.push((SdkKind::Java, base.join("Java"), variable.to_string()));
                roots.push((
                    SdkKind::Java,
                    base.join("Eclipse Adoptium"),
                    variable.to_string(),
                ));
                roots.push((SdkKind::Java, base.join("Microsoft"), variable.to_string()));
            }
        }
    }
    roots
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_string(path: &Path) -> String {
    // `canonical_or_original` returns a `\\?\` verbatim path on Windows; strip
    // it so persisted locations/executables stay usable by cmd.exe, batch
    // launchers, and PATH lookup rather than resolving to "path not found".
    super::strip_verbatim_prefix(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_version_outputs() {
        assert_eq!(
            parse_version(SdkKind::Java, "openjdk version \"21.0.7\" 2025-04-15"),
            Some("21.0.7".to_string())
        );
        assert_eq!(
            parse_version(SdkKind::Kotlin, "info: kotlinc-jvm 2.1.20 (JRE 21)"),
            Some("2.1.20".to_string())
        );
        assert_eq!(
            parse_version(SdkKind::Scala, "Scala code runner version 3.6.4"),
            Some("3.6.4".to_string())
        );
        assert_eq!(
            parse_version(SdkKind::Python, "Python 3.13.5"),
            Some("3.13.5".to_string())
        );
    }

    #[test]
    fn locates_java_home_from_java_binary() {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let java = bin.join(if cfg!(windows) { "java.exe" } else { "java" });
        let javac = bin.join(if cfg!(windows) { "javac.exe" } else { "javac" });
        std::fs::write(&java, "stub").unwrap();
        std::fs::write(&javac, "stub").unwrap();

        let located = locate_sdk(SdkKind::Java, &java);
        assert_eq!(located.location, directory.path());
        assert!(located.missing.is_empty());
        assert!(located.executables.contains_key("java"));
        assert!(located.executables.contains_key("javac"));
    }

    #[test]
    fn reads_kotlin_distribution_version_without_executing_batch_file() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("bin")).unwrap();
        std::fs::write(directory.path().join("build.txt"), "2.2.0\n").unwrap();
        assert_eq!(
            version_from_distribution(SdkKind::Kotlin, directory.path()),
            Some("2.2.0".to_string())
        );
    }
}
