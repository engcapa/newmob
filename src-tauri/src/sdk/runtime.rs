use super::resolve::{ResolvedSdkStatus, WorkspaceSdkResolution};
use super::{SdkBindingMode, SdkInstallation, SdkKind, SdkRegistry, SdkRole, SdkStatus};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const JDTLS_MIN_JAVA_MAJOR: u32 = 21;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeConfiguration {
    pub name: String,
    pub path: String,
    pub default: bool,
}

/// Backend-computed process environment shared by language servers, workspace
/// terminals and task runners. The frontend only transports the workspace and
/// scope paths; SDK precedence and compatibility remain backend-owned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkEnvironment {
    pub workspace_root: String,
    pub scope_path: String,
    pub project_scope_path: String,
    pub fingerprint: String,
    pub environment: BTreeMap<String, String>,
    pub path_entries: Vec<String>,
    pub project_java_home: Option<String>,
    pub launcher_java_home: Option<String>,
    pub tooling_java_home: Option<String>,
    pub tooling_java_error: Option<String>,
    pub python_home: Option<String>,
    pub kotlin_home: Option<String>,
    pub scala_home: Option<String>,
    pub java_runtimes: Vec<JavaRuntimeConfiguration>,
}

impl WorkspaceSdkEnvironment {
    pub fn passthrough(workspace_root: &Path, scope_path: &Path) -> Self {
        let workspace_root = path_string(workspace_root);
        let scope_path = path_string(scope_path);
        // The requested file directory is diagnostic metadata, not process
        // identity. Keeping it here spawned one language server per package.
        let fingerprint = fingerprint(&[workspace_root.as_str(), "passthrough"]);
        Self {
            project_scope_path: workspace_root.clone(),
            workspace_root,
            scope_path,
            fingerprint,
            environment: BTreeMap::new(),
            path_entries: Vec::new(),
            project_java_home: None,
            launcher_java_home: None,
            tooling_java_home: None,
            tooling_java_error: None,
            python_home: None,
            kotlin_home: None,
            scala_home: None,
            java_runtimes: Vec::new(),
        }
    }

    pub fn prepend_path(&self, inherited: Option<&std::ffi::OsStr>) -> Option<std::ffi::OsString> {
        if self.path_entries.is_empty() {
            return None;
        }
        let mut paths = self
            .path_entries
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        if let Some(inherited) = inherited {
            paths.extend(std::env::split_paths(inherited));
        }
        std::env::join_paths(paths).ok()
    }
}

pub fn build_workspace_environment(
    resolution: &WorkspaceSdkResolution,
    registry: &SdkRegistry,
    requested_scope: &Path,
) -> WorkspaceSdkEnvironment {
    let workspace_root = PathBuf::from(&resolution.analysis.workspace_root);
    let requested_scope = canonical_or_original(requested_scope);
    let project_scope = nearest_project_scope(resolution, &requested_scope)
        .unwrap_or_else(|| workspace_root.clone());

    let project_java = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Java,
        SdkRole::Project,
    );
    let launcher_java = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Java,
        SdkRole::Launcher,
    )
    .or_else(|| project_java.clone());
    let python = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Python,
        SdkRole::Project,
    );
    let kotlin = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Kotlin,
        SdkRole::Compiler,
    );
    let scala = selected_installation(
        resolution,
        registry,
        &requested_scope,
        SdkKind::Scala,
        SdkRole::Compiler,
    );
    let (tooling_java, tooling_java_error) = select_tooling_java(registry, &requested_scope);

    let mut environment = BTreeMap::new();
    // All home paths are normalized (verbatim prefix stripped) before they
    // become environment values so a legacy `\\?\C:\...` registry entry can't
    // poison JAVA_HOME/VIRTUAL_ENV for shells and batch launchers.
    let project_java_home = project_java.as_ref().map(sdk_home);
    let launcher_java_home = launcher_java.as_ref().map(sdk_home);
    if let Some(java_home) = launcher_java_home.as_ref().or(project_java_home.as_ref()) {
        environment.insert("JAVA_HOME".to_string(), java_home.clone());
    }

    let python_home = python.as_ref().map(sdk_home);
    if let Some(sdk) = python.as_ref()
        && is_python_environment(&sdk.location)
    {
        environment.insert("VIRTUAL_ENV".to_string(), sdk_home(sdk));
    }
    let kotlin_home = kotlin.as_ref().map(sdk_home);
    if let Some(home) = kotlin_home.as_ref() {
        environment.insert("KOTLIN_HOME".to_string(), home.clone());
    }
    let scala_home = scala.as_ref().map(sdk_home);
    if let Some(home) = scala_home.as_ref() {
        environment.insert("SCALA_HOME".to_string(), home.clone());
    }

    let selected = [
        launcher_java.as_ref(),
        project_java.as_ref(),
        python.as_ref(),
        kotlin.as_ref(),
        scala.as_ref(),
    ];
    let path_entries = executable_directories(selected.into_iter().flatten());
    let java_runtimes = java_runtime_configurations(registry, project_java.as_ref());
    let tooling_java_home = tooling_java.as_ref().map(sdk_home);
    let workspace_root = path_string(&workspace_root);
    let scope_path = path_string(&requested_scope);
    let project_scope_path = path_string(&project_scope);

    // `scope_path` is the current file's parent directory. The selected SDKs
    // and nearest project scope below already capture every environment input;
    // including the request directory made otherwise-identical files in two
    // packages produce distinct LSP session keys and relaunch jdtls.
    let mut fingerprint_parts = vec![workspace_root.as_str(), project_scope_path.as_str()];
    for sdk in selected.into_iter().flatten() {
        fingerprint_parts.extend([
            sdk.id.as_str(),
            sdk.location.as_str(),
            sdk.version.as_deref().unwrap_or(""),
        ]);
    }
    if let Some(sdk) = tooling_java.as_ref() {
        fingerprint_parts.extend([
            sdk.id.as_str(),
            sdk.location.as_str(),
            sdk.version.as_deref().unwrap_or(""),
        ]);
    }
    if let Some(error) = tooling_java_error.as_deref() {
        fingerprint_parts.push(error);
    }
    for runtime in &java_runtimes {
        fingerprint_parts.extend([
            runtime.name.as_str(),
            runtime.path.as_str(),
            if runtime.default { "default" } else { "" },
        ]);
    }
    let fingerprint = fingerprint(&fingerprint_parts);

    WorkspaceSdkEnvironment {
        workspace_root,
        scope_path,
        project_scope_path,
        fingerprint,
        environment,
        path_entries,
        project_java_home,
        launcher_java_home,
        tooling_java_home,
        tooling_java_error,
        python_home,
        kotlin_home,
        scala_home,
        java_runtimes,
    }
}

fn nearest_project_scope(
    resolution: &WorkspaceSdkResolution,
    requested_scope: &Path,
) -> Option<PathBuf> {
    resolution
        .analysis
        .profiles
        .iter()
        .filter(|profile| path_is_within(requested_scope, Path::new(&profile.scope_path)))
        .max_by_key(|profile| profile.scope_path.len())
        .map(|profile| PathBuf::from(&profile.scope_path))
}

fn selected_installation(
    resolution: &WorkspaceSdkResolution,
    registry: &SdkRegistry,
    requested_scope: &Path,
    kind: SdkKind,
    role: SdkRole,
) -> Option<SdkInstallation> {
    let resolved = resolution
        .resolved
        .iter()
        .filter(|item| {
            item.kind == kind
                && item.role == role
                && item.status == ResolvedSdkStatus::Resolved
                && path_is_within(requested_scope, Path::new(&item.scope_path))
        })
        .max_by_key(|item| item.scope_path.len())
        .and_then(|item| item.installation.clone());
    if resolved.is_some() {
        return resolved;
    }

    // A direct manual binding is meaningful even for a workspace whose source
    // scanner found no matching file yet (for example, an empty new project).
    nearest_manual_binding(registry, requested_scope, kind, role)
        .and_then(|binding| binding.sdk_id.as_deref())
        .and_then(|id| ready_installation(registry, id))
        .cloned()
}

fn select_tooling_java(
    registry: &SdkRegistry,
    requested_scope: &Path,
) -> (Option<SdkInstallation>, Option<String>) {
    if let Some(binding) =
        nearest_manual_binding(registry, requested_scope, SdkKind::Java, SdkRole::Tooling)
    {
        let Some(id) = binding.sdk_id.as_deref() else {
            return (
                None,
                Some("The tooling JDK binding has no installation".to_string()),
            );
        };
        let Some(installation) = registry.installations.iter().find(|sdk| sdk.id == id) else {
            return (
                None,
                Some("The tooling JDK binding references a removed installation".to_string()),
            );
        };
        if installation.status != SdkStatus::Ready {
            return (
                None,
                Some(format!(
                    "The tooling JDK {} is not ready: {}",
                    installation.name,
                    installation
                        .last_error
                        .as_deref()
                        .unwrap_or(&installation.location)
                )),
            );
        }
        let major = installation.version.as_deref().and_then(java_major);
        if !major.is_some_and(|major| major >= JDTLS_MIN_JAVA_MAJOR) {
            return (
                None,
                Some(format!(
                    "The tooling JDK {} is {}, but JDT LS requires JDK {}+",
                    installation.name,
                    installation
                        .version
                        .as_deref()
                        .unwrap_or("an unknown version"),
                    JDTLS_MIN_JAVA_MAJOR
                )),
            );
        }
        return (Some(installation.clone()), None);
    }

    let default_java = registry
        .defaults
        .iter()
        .find(|entry| entry.kind == SdkKind::Java)
        .map(|entry| entry.sdk_id.as_str());
    let mut candidates = registry
        .installations
        .iter()
        .filter(|sdk| {
            sdk.kind == SdkKind::Java
                && sdk.status == SdkStatus::Ready
                && sdk
                    .version
                    .as_deref()
                    .and_then(java_major)
                    .is_some_and(|major| major >= JDTLS_MIN_JAVA_MAJOR)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_default = default_java == Some(left.id.as_str());
        let right_default = default_java == Some(right.id.as_str());
        right_default
            .cmp(&left_default)
            .then_with(|| {
                right
                    .version
                    .as_deref()
                    .and_then(java_major)
                    .cmp(&left.version.as_deref().and_then(java_major))
            })
            .then_with(|| left.name.cmp(&right.name))
    });
    (candidates.first().map(|sdk| (*sdk).clone()), None)
}

fn nearest_manual_binding<'a>(
    registry: &'a SdkRegistry,
    requested_scope: &Path,
    kind: SdkKind,
    role: SdkRole,
) -> Option<&'a super::WorkspaceSdkBinding> {
    registry
        .bindings
        .iter()
        .filter(|binding| {
            binding.mode == SdkBindingMode::Manual
                && binding.kind == kind
                && binding.role == role
                && path_is_within(requested_scope, Path::new(&binding.scope_path))
        })
        .max_by_key(|binding| binding.scope_path.len())
}

fn ready_installation<'a>(registry: &'a SdkRegistry, id: &str) -> Option<&'a SdkInstallation> {
    registry
        .installations
        .iter()
        .find(|installation| installation.id == id && installation.status == SdkStatus::Ready)
}

fn java_runtime_configurations(
    registry: &SdkRegistry,
    project_java: Option<&SdkInstallation>,
) -> Vec<JavaRuntimeConfiguration> {
    let default_java = registry
        .defaults
        .iter()
        .find(|entry| entry.kind == SdkKind::Java)
        .map(|entry| entry.sdk_id.as_str());
    let mut candidates = registry
        .installations
        .iter()
        .filter(|sdk| sdk.kind == SdkKind::Java && sdk.status == SdkStatus::Ready)
        .cloned()
        .collect::<Vec<_>>();
    if let Some(project_java) = project_java
        && !candidates
            .iter()
            .any(|sdk| paths_equal(&sdk.location, &project_java.location))
    {
        candidates.push(project_java.clone());
    }
    candidates.sort_by(|left, right| {
        let left_project =
            project_java.is_some_and(|sdk| paths_equal(&sdk.location, &left.location));
        let right_project =
            project_java.is_some_and(|sdk| paths_equal(&sdk.location, &right.location));
        let left_default = default_java == Some(left.id.as_str());
        let right_default = default_java == Some(right.id.as_str());
        right_project
            .cmp(&left_project)
            .then_with(|| right_default.cmp(&left_default))
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut seen_majors = HashSet::new();
    let mut runtimes = Vec::new();
    for sdk in candidates {
        let Some(major) = sdk.version.as_deref().and_then(java_major) else {
            continue;
        };
        if !seen_majors.insert(major) {
            continue;
        }
        runtimes.push(JavaRuntimeConfiguration {
            name: if major == 8 {
                "JavaSE-1.8".to_string()
            } else {
                format!("JavaSE-{major}")
            },
            // jdtls writes this into runtime configs; keep it a plain path.
            path: sdk_home(&sdk),
            default: project_java
                .is_some_and(|project| paths_equal(&project.location, &sdk.location)),
        });
    }
    runtimes.sort_by_key(|runtime| runtime.name.clone());
    runtimes
}

fn executable_directories<'a>(
    installations: impl Iterator<Item = &'a SdkInstallation>,
) -> Vec<String> {
    let mut directories = Vec::new();
    let mut seen = HashSet::new();
    for installation in installations {
        let candidates = if installation.executables.is_empty() {
            vec![Path::new(&installation.location).join(
                if cfg!(windows) && installation.kind == SdkKind::Python {
                    "Scripts"
                } else {
                    "bin"
                },
            )]
        } else {
            installation
                .executables
                .values()
                .filter_map(|executable| Path::new(executable).parent().map(Path::to_path_buf))
                .collect::<Vec<_>>()
        };
        for directory in candidates {
            let value = path_string(&directory);
            let key = path_key(&directory);
            if seen.insert(key) {
                directories.push(value);
            }
        }
    }
    directories
}

fn is_python_environment(location: &str) -> bool {
    let path = Path::new(location);
    path.join("pyvenv.cfg").is_file() || path.join("conda-meta").is_dir()
}

fn java_major(value: &str) -> Option<u32> {
    let numbers = value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>();
    match numbers.as_slice() {
        [1, major, ..] => Some(*major),
        [major, ..] => Some(*major),
        [] => None,
    }
}

fn path_is_within(path: &Path, ancestor: &Path) -> bool {
    let path = canonical_or_original(path);
    let ancestor = canonical_or_original(ancestor);
    if cfg!(windows) {
        let path = path_string(&path).to_ascii_lowercase();
        let ancestor = path_string(&ancestor).to_ascii_lowercase();
        return path == ancestor
            || path
                .strip_prefix(&ancestor)
                .is_some_and(|suffix| suffix.starts_with(['/', '\\']));
    }
    path == ancestor || path.starts_with(ancestor)
}

fn paths_equal(left: &str, right: &str) -> bool {
    let left = path_string(&canonical_or_original(Path::new(left)));
    let right = path_string(&canonical_or_original(Path::new(right)));
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_key(path: &Path) -> String {
    let value = path_string(&canonical_or_original(path));
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn path_string(path: &Path) -> String {
    // Strip Windows `\\?\` verbatim prefixes (from `canonicalize`) so emitted
    // scope paths and PATH entries work with cmd.exe / batch launchers.
    super::strip_verbatim_prefix(&path.to_string_lossy())
}

/// An SDK's install location as a plain string for use as an environment value
/// (`JAVA_HOME`, `VIRTUAL_ENV`, …). Strips any verbatim prefix so batch
/// launchers resolving `%JAVA_HOME%\bin\java.exe` don't hit "path not found".
fn sdk_home(installation: &SdkInstallation) -> String {
    super::strip_verbatim_prefix(&installation.location)
}

fn fingerprint(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    hex::encode(digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::super::detect::{
        ProjectBuildSystem, ProjectSdkProfile, SdkConfidence, SdkRequirement, WorkspaceSdkAnalysis,
    };
    use super::super::resolve::{ResolvedSdk, ResolvedSdkSource, WorkspaceSdkResolution};
    use super::super::{SdkDefault, SdkOrigin, WorkspaceSdkBinding};
    use super::*;

    fn installation(id: &str, kind: SdkKind, version: &str, location: &str) -> SdkInstallation {
        SdkInstallation {
            id: id.to_string(),
            kind,
            name: format!("{kind:?} {version}"),
            location: location.to_string(),
            executables: BTreeMap::new(),
            version: Some(version.to_string()),
            vendor: None,
            architecture: None,
            origin: SdkOrigin::Manual,
            status: SdkStatus::Ready,
            last_error: None,
            last_probed_at: None,
        }
    }

    fn resolved(scope: &str, kind: SdkKind, role: SdkRole, sdk: SdkInstallation) -> ResolvedSdk {
        ResolvedSdk {
            scope_path: scope.to_string(),
            kind,
            role,
            requirement: SdkRequirement {
                kind,
                role,
                constraint: None,
                required_location: None,
                managed_by_build: false,
                source: "test".to_string(),
                confidence: SdkConfidence::High,
                evidence: Vec::new(),
            },
            installation: Some(sdk),
            source: ResolvedSdkSource::AutoMatch,
            status: ResolvedSdkStatus::Resolved,
            reason: "test".to_string(),
        }
    }

    fn resolution(root: &str, scope: &str, resolved: Vec<ResolvedSdk>) -> WorkspaceSdkResolution {
        WorkspaceSdkResolution {
            analysis: WorkspaceSdkAnalysis {
                workspace_root: root.to_string(),
                profiles: vec![ProjectSdkProfile {
                    scope_path: scope.to_string(),
                    relative_path: ".".to_string(),
                    display_name: "test".to_string(),
                    build_systems: vec![ProjectBuildSystem::Gradle],
                    languages: vec![SdkKind::Kotlin],
                    requirements: Vec::new(),
                    kotlin: None,
                }],
                warnings: Vec::new(),
            },
            resolved,
        }
    }

    #[test]
    fn separates_jdtls_tooling_jdk_from_project_jdk() {
        let root = if cfg!(windows) { r"C:\repo" } else { "/repo" };
        let project = installation("jdk-17", SdkKind::Java, "17.0.12", "/sdk/jdk-17");
        let tooling = installation("jdk-21", SdkKind::Java, "21.0.6", "/sdk/jdk-21");
        let registry = SdkRegistry {
            installations: vec![project.clone(), tooling.clone()],
            defaults: vec![SdkDefault {
                kind: SdkKind::Java,
                sdk_id: tooling.id.clone(),
            }],
            ..SdkRegistry::default()
        };
        let resolution = resolution(
            root,
            root,
            vec![resolved(root, SdkKind::Java, SdkRole::Project, project)],
        );

        let environment = build_workspace_environment(&resolution, &registry, Path::new(root));

        assert_eq!(
            environment.project_java_home.as_deref(),
            Some("/sdk/jdk-17")
        );
        assert_eq!(
            environment.tooling_java_home.as_deref(),
            Some("/sdk/jdk-21")
        );
        assert_eq!(
            environment.environment.get("JAVA_HOME").map(String::as_str),
            Some("/sdk/jdk-17")
        );
        assert!(
            environment
                .java_runtimes
                .iter()
                .any(|runtime| runtime.name == "JavaSE-17" && runtime.default)
        );
    }

    #[test]
    fn incompatible_manual_tooling_binding_is_visible_and_not_applied() {
        let root = if cfg!(windows) { r"C:\repo" } else { "/repo" };
        let old = installation("jdk-17", SdkKind::Java, "17", "/sdk/jdk-17");
        let registry = SdkRegistry {
            installations: vec![old.clone()],
            bindings: vec![WorkspaceSdkBinding {
                scope_path: root.to_string(),
                kind: SdkKind::Java,
                role: SdkRole::Tooling,
                mode: SdkBindingMode::Manual,
                sdk_id: Some(old.id),
                updated_at: "now".to_string(),
            }],
            ..SdkRegistry::default()
        };
        let resolution = resolution(root, root, Vec::new());

        let environment = build_workspace_environment(&resolution, &registry, Path::new(root));

        assert!(environment.tooling_java_home.is_none());
        assert!(
            environment
                .tooling_java_error
                .as_deref()
                .is_some_and(|error| error.contains("requires JDK 21+"))
        );
    }

    #[test]
    fn strips_verbatim_prefix_from_java_home_and_path_entries() {
        // A registry entry saved with a Windows `\\?\` verbatim prefix must not
        // reach JAVA_HOME / PATH: cmd.exe and batch launchers (mvn.cmd) resolve
        // `%JAVA_HOME%\bin\java.exe` and fail with "path not found" on `\\?\`.
        let root = if cfg!(windows) { r"C:\repo" } else { "/repo" };
        let mut project = installation(
            "jdk-21",
            SdkKind::Java,
            "21.0.4",
            r"\\?\C:\Program Files\Java\jdk-21",
        );
        project.executables = BTreeMap::from([(
            "java".to_string(),
            r"\\?\C:\Program Files\Java\jdk-21\bin\java.exe".to_string(),
        )]);
        let registry = SdkRegistry {
            installations: vec![project.clone()],
            ..SdkRegistry::default()
        };
        let resolution = resolution(
            root,
            root,
            vec![resolved(root, SdkKind::Java, SdkRole::Project, project)],
        );

        let environment = build_workspace_environment(&resolution, &registry, Path::new(root));

        // Core of the bug: JAVA_HOME must be a plain path (pure string strip,
        // identical on every host).
        assert_eq!(
            environment.environment.get("JAVA_HOME").map(String::as_str),
            Some(r"C:\Program Files\Java\jdk-21")
        );
        assert_eq!(
            environment.project_java_home.as_deref(),
            Some(r"C:\Program Files\Java\jdk-21")
        );
        // Invariant that holds on every host: nothing emitted keeps a verbatim
        // prefix (env values, PATH entries, runtime paths).
        assert!(
            environment
                .environment
                .values()
                .chain(environment.path_entries.iter())
                .chain(
                    environment
                        .java_runtimes
                        .iter()
                        .map(|runtime| &runtime.path)
                )
                .all(|value| !value.contains(r"\\?\") && !value.contains("//?/")),
            "no emitted path may keep a verbatim prefix: env={:?} path={:?}",
            environment.environment,
            environment.path_entries,
        );
        // The executable-derived PATH entry maps to `<home>\bin` on Windows,
        // where `\\?\...\bin\java.exe`'s parent resolves natively.
        #[cfg(windows)]
        assert_eq!(
            environment.path_entries.first().map(String::as_str),
            Some(r"C:\Program Files\Java\jdk-21\bin")
        );
    }

    #[test]
    fn applies_all_standalone_sdks_and_keeps_java_home_aligned_with_path() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let project_java_path = root.join("jdk-17");
        let launcher_java_path = root.join("jdk-21");
        let python_path = root.join(".venv");
        let kotlin_path = root.join("kotlin");
        let scala_path = root.join("scala");
        for path in [
            &project_java_path,
            &launcher_java_path,
            &python_path,
            &kotlin_path,
            &scala_path,
        ] {
            std::fs::create_dir_all(path.join("bin")).unwrap();
        }
        std::fs::write(python_path.join("pyvenv.cfg"), "home = test\n").unwrap();

        let project_java = installation(
            "jdk-17",
            SdkKind::Java,
            "17.0.12",
            &path_string(&project_java_path),
        );
        let launcher_java = installation(
            "jdk-21",
            SdkKind::Java,
            "21.0.6",
            &path_string(&launcher_java_path),
        );
        let python = installation(
            "python",
            SdkKind::Python,
            "3.12.9",
            &path_string(&python_path),
        );
        let kotlin = installation(
            "kotlin",
            SdkKind::Kotlin,
            "2.1.20",
            &path_string(&kotlin_path),
        );
        let scala = installation("scala", SdkKind::Scala, "3.6.4", &path_string(&scala_path));
        let registry = SdkRegistry {
            installations: vec![
                project_java.clone(),
                launcher_java.clone(),
                python.clone(),
                kotlin.clone(),
                scala.clone(),
            ],
            ..SdkRegistry::default()
        };
        let root_string = path_string(root);
        let resolution = resolution(
            &root_string,
            &root_string,
            vec![
                resolved(&root_string, SdkKind::Java, SdkRole::Project, project_java),
                resolved(
                    &root_string,
                    SdkKind::Java,
                    SdkRole::Launcher,
                    launcher_java,
                ),
                resolved(&root_string, SdkKind::Python, SdkRole::Project, python),
                resolved(&root_string, SdkKind::Kotlin, SdkRole::Compiler, kotlin),
                resolved(&root_string, SdkKind::Scala, SdkRole::Compiler, scala),
            ],
        );

        let environment = build_workspace_environment(&resolution, &registry, root);

        assert_eq!(
            environment.environment.get("JAVA_HOME").map(String::as_str),
            Some(path_string(&launcher_java_path).as_str())
        );
        assert_eq!(
            environment
                .environment
                .get("VIRTUAL_ENV")
                .map(String::as_str),
            Some(path_string(&python_path).as_str())
        );
        assert_eq!(
            environment
                .environment
                .get("KOTLIN_HOME")
                .map(String::as_str),
            Some(path_string(&kotlin_path).as_str())
        );
        assert_eq!(
            environment
                .environment
                .get("SCALA_HOME")
                .map(String::as_str),
            Some(path_string(&scala_path).as_str())
        );
        assert_eq!(
            environment.path_entries.first().map(String::as_str),
            Some(path_string(&launcher_java_path.join("bin")).as_str())
        );
        assert_eq!(
            environment.path_entries.get(1).map(String::as_str),
            Some(path_string(&project_java_path.join("bin")).as_str())
        );
    }

    #[test]
    fn fingerprint_is_stable_across_packages_in_the_same_project_scope() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let package_a = root.join("src/main/java/com/example/a");
        let package_b = root.join("src/main/java/com/example/b");
        std::fs::create_dir_all(&package_a).unwrap();
        std::fs::create_dir_all(&package_b).unwrap();

        let root_string = path_string(root);
        let project_java = installation("jdk-25", SdkKind::Java, "25.0.2", "/sdk/jdk-25");
        let registry = SdkRegistry {
            installations: vec![project_java.clone()],
            ..SdkRegistry::default()
        };
        let resolution = resolution(
            &root_string,
            &root_string,
            vec![resolved(
                &root_string,
                SdkKind::Java,
                SdkRole::Project,
                project_java,
            )],
        );

        let first = build_workspace_environment(&resolution, &registry, &package_a);
        let second = build_workspace_environment(&resolution, &registry, &package_b);

        assert_ne!(first.scope_path, second.scope_path);
        assert_eq!(first.project_scope_path, second.project_scope_path);
        assert_eq!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn passthrough_fingerprint_is_stable_across_workspace_directories() {
        let root = Path::new("/repo/project");
        let first = WorkspaceSdkEnvironment::passthrough(root, Path::new("/repo/project/pkg/a"));
        let second = WorkspaceSdkEnvironment::passthrough(root, Path::new("/repo/project/pkg/b"));

        assert_ne!(first.scope_path, second.scope_path);
        assert_eq!(first.fingerprint, second.fingerprint);
    }
}
