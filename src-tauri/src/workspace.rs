use crate::state::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use tauri::State;

const DEFAULT_MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_RECURSIVE_MAX_DEPTH: usize = 25;
const DEFAULT_RECURSIVE_MAX_FILES: usize = 2_000;
const HARD_RECURSIVE_MAX_DEPTH: usize = 100;
const HARD_RECURSIVE_MAX_FILES: usize = 10_000;
const GIT_ROOT_SCAN_MAX_DEPTH: usize = 4;
const GIT_ROOT_SCAN_MAX_DIRS: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
    pub mtime: u64,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub text: String,
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCompactChain {
    pub path: String,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRootCandidate {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub repo_root: String,
    pub root_ids: Vec<String>,
    pub is_submodule: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskExecution {
    pub executable: String,
    pub args: Vec<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A task-scoped environment value. The terminal renderer applies it only to
/// the launched task, rather than mutating the user's interactive shell.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskEnvironmentVariable {
    pub value: String,
    /// `append` preserves an existing value (used for MAVEN_OPTS).
    pub mode: String,
}

type WorkspaceTaskEnvironment = BTreeMap<String, WorkspaceTaskEnvironmentVariable>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTask {
    pub id: String,
    pub label: String,
    pub command: String,
    pub cwd: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<WorkspaceTaskExecution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<WorkspaceTaskEnvironment>,
}

/// A runnable Java `public static void main` entry point discovered from source.
///
/// This is intentionally independent from java-debug/jdtls bundles: Run must
/// keep working with only a JDK plus the project's Maven/Gradle wrapper.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JavaRunTarget {
    pub id: String,
    pub label: String,
    pub main_class: String,
    pub file_path: String,
    pub command: String,
    pub cwd: String,
    /// `maven`, `gradle`, or `source-file`.
    pub build_system: String,
    /// Workspace-relative build/module directory (`.` for the root project).
    pub module_path: String,
    pub execution: WorkspaceTaskExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<WorkspaceTaskEnvironment>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceToolConfig {
    #[serde(default, alias = "mvn", alias = "mavenExecutable")]
    pub maven: Option<String>,
    #[serde(default, alias = "gradleExecutable")]
    pub gradle: Option<String>,
    /// Explicit JVM options for Maven `exec:java`, configured per workspace.
    #[serde(default)]
    pub maven_jvm_args: Vec<String>,
    /// Omitted means enabled, preserving automatic support for existing users.
    #[serde(default)]
    pub inherit_maven_arg_line: Option<bool>,
}

impl WorkspaceToolConfig {
    fn inherits_maven_arg_line(&self) -> bool {
        self.inherit_maven_arg_line.unwrap_or(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostPlatform {
    Windows,
    Unix,
}

impl HostPlatform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BuildTool {
    Maven,
    Gradle,
}

impl BuildTool {
    fn name(self) -> &'static str {
        match self {
            Self::Maven => "Maven",
            Self::Gradle => "Gradle",
        }
    }

    fn path_command(self) -> &'static str {
        match self {
            Self::Maven => "mvn",
            Self::Gradle => "gradle",
        }
    }

    fn configured<'a>(self, config: Option<&'a WorkspaceToolConfig>) -> Option<&'a str> {
        match self {
            Self::Maven => config.and_then(|config| config.maven.as_deref()),
            Self::Gradle => config.and_then(|config| config.gradle.as_deref()),
        }
        .map(str::trim)
        .filter(|value| !value.is_empty())
    }

    fn wrapper_names(self, platform: HostPlatform) -> &'static [&'static str] {
        match (self, platform) {
            (Self::Maven, HostPlatform::Windows) => &["mvnw.cmd", "mvnw.bat", "mvnw"],
            (Self::Maven, HostPlatform::Unix) => &["mvnw"],
            (Self::Gradle, HostPlatform::Windows) => &["gradlew.bat", "gradlew.cmd", "gradlew"],
            (Self::Gradle, HostPlatform::Unix) => &["gradlew"],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolSource {
    Wrapper,
    Configured,
    Path,
}

impl ToolSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wrapper => "wrapper",
            Self::Configured => "configured",
            Self::Path => "path",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolResolution {
    tool: BuildTool,
    executable: PathBuf,
    source: ToolSource,
    available: bool,
    diagnostic: Option<String>,
}

impl ToolResolution {
    fn task_runner(&self, platform: HostPlatform) -> String {
        if self.source == ToolSource::Path {
            self.tool.path_command().to_string()
        } else {
            wrapper_command_for(&self.executable, platform)
        }
    }

    fn execution(&self, args: &[&str]) -> WorkspaceTaskExecution {
        self.execution_owned(args.iter().map(|arg| (*arg).to_string()).collect())
    }

    fn execution_owned(&self, args: Vec<String>) -> WorkspaceTaskExecution {
        WorkspaceTaskExecution {
            executable: path_to_string(&self.executable),
            args,
            source: self.source.as_str().to_string(),
            error: self.diagnostic.clone(),
        }
    }

    fn require_available(&self) -> Result<(), String> {
        if self.available {
            Ok(())
        } else {
            Err(self.diagnostic.clone().unwrap_or_else(|| {
                format!("{} executable could not be resolved", self.tool.name())
            }))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolLaunchPlan {
    program: String,
    args: Vec<String>,
}

fn is_windows_batch(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

fn plan_tool_launch(executable: &Path, args: &[String], platform: HostPlatform) -> ToolLaunchPlan {
    if platform == HostPlatform::Windows && is_windows_batch(executable) {
        let mut command_line = format!("\"{}\"", path_to_string(executable).replace('"', "\"\""));
        for arg in args {
            command_line.push(' ');
            command_line.push_str(&quote_windows_cmd_arg(arg));
        }
        ToolLaunchPlan {
            program: "cmd.exe".to_string(),
            args: vec!["/D".into(), "/S".into(), "/C".into(), command_line],
        }
    } else {
        ToolLaunchPlan {
            program: path_to_string(executable),
            args: args.to_vec(),
        }
    }
}

fn quote_windows_cmd_arg(value: &str) -> String {
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || "&|<>()^\"".contains(character))
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn push_task(
    tasks: &mut Vec<WorkspaceTask>,
    source: &str,
    label: impl Into<String>,
    command: impl Into<String>,
    cwd: &Path,
) {
    let label = label.into();
    tasks.push(WorkspaceTask {
        id: format!("{}:{}", source, label.to_lowercase().replace(' ', "-")),
        label,
        command: command.into(),
        cwd: path_to_string(cwd),
        source: source.to_string(),
        module_path: None,
        execution: None,
        environment: None,
    });
}

fn push_tool_task(
    tasks: &mut Vec<WorkspaceTask>,
    source: &str,
    label: &str,
    resolution: &ToolResolution,
    cwd: &Path,
) {
    let runner = resolution.task_runner(HostPlatform::current());
    push_task(tasks, source, label, format!("{runner} {label}"), cwd);
    if let Some(task) = tasks.last_mut() {
        task.execution = Some(resolution.execution(&[label]));
    }
}

fn parse_named_targets(contents: &str) -> Vec<String> {
    let mut targets = Vec::new();
    for line in contents.lines() {
        if line.starts_with(char::is_whitespace) || line.starts_with('#') {
            continue;
        }
        let Some((candidate, _)) = line.split_once(':') else {
            continue;
        };
        let candidate = candidate.trim();
        if candidate.is_empty()
            || candidate.contains(['=', '%', '$'])
            || candidate.split_whitespace().count() != 1
        {
            continue;
        }
        if !targets.iter().any(|target| target == candidate) {
            targets.push(candidate.to_string());
        }
        if targets.len() >= 50 {
            break;
        }
    }
    targets
}

/// A resolved dependency-tree node for the Build panel (M7 F-1). Nested by the
/// build tool's own tree output (Maven `dependency:tree` / Gradle `dependencies`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyNode {
    pub group: String,
    pub artifact: String,
    pub version: String,
    /// Maven scope (compile/test/…) or Gradle configuration hint; empty when unknown.
    pub scope: String,
    /// Version-arbitration note when the build tool bumped/omitted this node
    /// (e.g. Gradle `-> 2.0`, Maven verbose `omitted for conflict with 2.0`).
    pub conflict: Option<String>,
    pub children: Vec<DependencyNode>,
}

/// Parse `mvn dependency:tree` text output into a forest (the root project's
/// direct dependencies). Tree connectors are `+- ` / `\- `, each level indented
/// 3 columns (`|  ` / `   `). Coordinates are `group:artifact:packaging[:classifier]:version[:scope]`.
fn parse_maven_dependency_tree(output: &str) -> Vec<DependencyNode> {
    let mut forest: Vec<DependencyNode> = Vec::new();
    // Index path to the current parent at each depth: `path[d]` is the child index
    // (within its parent's `children`) of the depth-(d+1) ancestor. Navigating this
    // path each insert keeps the tree safe (no raw pointers into reallocating Vecs).
    let mut path: Vec<usize> = Vec::new();
    let mut seen_root = false;

    for raw in output.lines() {
        let line = raw.strip_prefix("[INFO] ").unwrap_or(raw);
        let trimmed_end = line.trim_end();
        if trimmed_end.is_empty() {
            continue;
        }
        let connector = ["+- ", "\\- "]
            .iter()
            .filter_map(|marker| trimmed_end.find(*marker).map(|idx| (idx, marker.len())))
            .min_by_key(|(idx, _)| *idx);
        let (coord_start, depth) = match connector {
            Some((idx, marker_len)) => (idx + marker_len, idx / 3 + 1),
            None => {
                if seen_root || trimmed_end.matches(':').count() < 2 {
                    continue;
                }
                (0, 0)
            }
        };
        let Some(node) = parse_maven_coordinate(&trimmed_end[coord_start..]) else {
            continue;
        };
        if depth == 0 {
            // Root project line: its direct deps (depth 1) become the forest.
            seen_root = true;
            forest.clear();
            path.clear();
            continue;
        }
        insert_dependency_node(&mut forest, &mut path, depth, node);
    }
    forest
}

/// Insert `node` at `depth` (1 = top-level) into `forest`, using `path` as the
/// index trail to the current parent. `path` is truncated to `depth - 1` so the
/// node attaches under the correct ancestor, then extended with the new index.
fn insert_dependency_node(
    forest: &mut Vec<DependencyNode>,
    path: &mut Vec<usize>,
    depth: usize,
    node: DependencyNode,
) {
    // Keep ancestors above the new node. `truncate` is a no-op when `level`
    // exceeds the path length (malformed deeper-by->1 jump → attach under deepest).
    path.truncate(depth - 1);
    if path.is_empty() {
        forest.push(node);
        path.push(forest.len() - 1);
        return;
    }
    // Walk the index path to the parent's children Vec.
    let mut children = &mut *forest;
    for &index in &path[..path.len() - 1] {
        children = &mut children[index].children;
    }
    let last = *path.last().unwrap();
    let siblings = &mut children[last].children;
    siblings.push(node);
    path.push(siblings.len() - 1);
}

/// Parse one Maven coordinate + optional conflict suffix into a leaf node.
fn parse_maven_coordinate(text: &str) -> Option<DependencyNode> {
    let text = text.trim();
    // Split off a trailing `(...)` note (verbose conflict/version-managed marker).
    let (coord, conflict) = match text.split_once(" (") {
        Some((coord, note)) => (coord.trim(), Some(format!("({}", note.trim()))),
        None => (text, None),
    };
    let parts: Vec<&str> = coord.split(':').collect();
    let (group, artifact, version, scope) = match parts.as_slice() {
        // group:artifact:packaging:version:scope
        [g, a, _pkg, v, s] => (
            (*g).to_string(),
            (*a).to_string(),
            (*v).to_string(),
            (*s).to_string(),
        ),
        // group:artifact:packaging:classifier:version:scope
        [g, a, _pkg, _cls, v, s] => (
            (*g).to_string(),
            (*a).to_string(),
            (*v).to_string(),
            (*s).to_string(),
        ),
        // group:artifact:packaging:version (root project — no scope)
        [g, a, _pkg, v] => (
            (*g).to_string(),
            (*a).to_string(),
            (*v).to_string(),
            String::new(),
        ),
        _ => return None,
    };
    if group.is_empty() || artifact.is_empty() {
        return None;
    }
    Some(DependencyNode {
        group,
        artifact,
        version,
        scope,
        conflict,
        children: Vec::new(),
    })
}

/// Parse `gradle dependencies --configuration <cfg>` output into a forest. Tree
/// connectors are `+--- ` / `\--- ` (5 columns per level). A `req -> resolved`
/// suffix marks Gradle's version arbitration (recorded as a conflict note, with
/// the resolved version used). Trailing `(*)` / `(c)` / `(n)` markers are dropped.
fn parse_gradle_dependencies(output: &str) -> Vec<DependencyNode> {
    let mut forest: Vec<DependencyNode> = Vec::new();
    let mut path: Vec<usize> = Vec::new();

    for raw in output.lines() {
        let line = raw.trim_end();
        let connector = ["+--- ", "\\--- "]
            .iter()
            .filter_map(|marker| line.find(*marker).map(|idx| (idx, marker.len())))
            .min_by_key(|(idx, _)| *idx);
        let Some((idx, marker_len)) = connector else {
            continue;
        };
        // Everything before the connector is `|    ` / `     ` indentation (5 cols).
        let depth = idx / 5 + 1;
        let Some(node) = parse_gradle_coordinate(&line[idx + marker_len..]) else {
            continue;
        };
        insert_dependency_node(&mut forest, &mut path, depth, node);
    }
    forest
}

/// Parse one Gradle coordinate line (already stripped of its connector).
fn parse_gradle_coordinate(text: &str) -> Option<DependencyNode> {
    let mut text = text.trim();
    // Drop trailing status markers: (*) already shown, (c) constraint, (n) not resolved.
    for marker in [" (*)", " (c)", " (n)"] {
        if let Some(stripped) = text.strip_suffix(marker) {
            text = stripped.trim_end();
        }
    }
    if text.is_empty() {
        return None;
    }
    // Version arbitration: `group:artifact:requested -> resolved`.
    let (coord, conflict, resolved) = match text.split_once(" -> ") {
        Some((left, resolved)) => {
            let resolved = resolved.trim();
            (
                left.trim(),
                Some(format!("{} -> {resolved}", left.trim())),
                Some(resolved.to_string()),
            )
        }
        None => (text, None, None),
    };
    let parts: Vec<&str> = coord.split(':').collect();
    let (group, artifact, requested) = match parts.as_slice() {
        [g, a, v] => ((*g).to_string(), (*a).to_string(), (*v).to_string()),
        // A constraint line may be just `group:artifact` with the version arbitrated.
        [g, a] => ((*g).to_string(), (*a).to_string(), String::new()),
        _ => return None,
    };
    if group.is_empty() || artifact.is_empty() {
        return None;
    }
    Some(DependencyNode {
        group,
        artifact,
        version: resolved.unwrap_or(requested),
        scope: String::new(),
        conflict,
        children: Vec::new(),
    })
}

/// Grouped task view for the Build panel task tree (M7 F-2). Unlike the flat
/// `workspace_detect_tasks`, tasks are bucketed by source and Maven/Gradle carry
/// their full lifecycle / common tasks rather than the two-entry Run-tab subset.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskGroup {
    /// Source key (also the group label), e.g. "Maven", "Gradle", "package.json".
    pub source: String,
    pub tasks: Vec<WorkspaceTask>,
}

fn wrapper_command_for(path: &Path, platform: HostPlatform) -> String {
    let quoted = shell_quote_for(&path_to_string(path), platform);
    if platform == HostPlatform::Windows {
        format!("& {quoted}")
    } else {
        quoted
    }
}

fn shell_quote_for(value: &str, platform: HostPlatform) -> String {
    if platform == HostPlatform::Windows {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn find_on_path(command: &str, path: Option<&OsStr>, platform: HostPlatform) -> Option<PathBuf> {
    let path = path?;
    let names: Vec<String> = if platform == HostPlatform::Windows {
        if Path::new(command).extension().is_some() {
            vec![command.to_string()]
        } else {
            vec![
                format!("{command}.exe"),
                format!("{command}.cmd"),
                format!("{command}.bat"),
                command.to_string(),
            ]
        }
    } else {
        vec![command.to_string()]
    };
    std::env::split_paths(path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| fs::canonicalize(&candidate).ok().or(Some(candidate)))
}

fn resolve_configured_executable(
    configured: &str,
    workspace_root: &Path,
    path: Option<&OsStr>,
    platform: HostPlatform,
) -> Option<PathBuf> {
    let configured_path = Path::new(configured);
    if configured_path.is_absolute()
        || configured_path.components().count() > 1
        || configured.contains(['/', '\\'])
    {
        let candidate = if configured_path.is_absolute() {
            configured_path.to_path_buf()
        } else {
            workspace_root.join(configured_path)
        };
        return candidate
            .is_file()
            .then(|| fs::canonicalize(&candidate).unwrap_or(candidate));
    }
    find_on_path(configured, path, platform)
}

fn resolve_build_tool_with_path(
    build_dir: &Path,
    workspace_root: &Path,
    tool: BuildTool,
    config: Option<&WorkspaceToolConfig>,
    platform: HostPlatform,
    path: Option<&OsStr>,
) -> ToolResolution {
    let mut current = Some(build_dir);
    while let Some(directory) = current {
        for name in tool.wrapper_names(platform) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                let executable = fs::canonicalize(&candidate).unwrap_or(candidate);
                return ToolResolution {
                    tool,
                    executable,
                    source: ToolSource::Wrapper,
                    available: true,
                    diagnostic: None,
                };
            }
        }
        if directory == workspace_root {
            break;
        }
        current = directory
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }

    if let Some(configured) = tool.configured(config) {
        if let Some(executable) =
            resolve_configured_executable(configured, workspace_root, path, platform)
        {
            return ToolResolution {
                tool,
                executable,
                source: ToolSource::Configured,
                available: true,
                diagnostic: None,
            };
        }
        return ToolResolution {
            tool,
            executable: PathBuf::from(configured),
            source: ToolSource::Configured,
            available: false,
            diagnostic: Some(format!(
                "Configured {} executable was not found: {configured}. Add a project wrapper, correct the configured path, or put `{}` on PATH.",
                tool.name(),
                tool.path_command()
            )),
        };
    }

    if let Some(executable) = find_on_path(tool.path_command(), path, platform) {
        return ToolResolution {
            tool,
            executable,
            source: ToolSource::Path,
            available: true,
            diagnostic: None,
        };
    }

    ToolResolution {
        tool,
        executable: PathBuf::from(tool.path_command()),
        source: ToolSource::Path,
        available: false,
        diagnostic: Some(format!(
            "{} executable was not found. Add a project wrapper ({}), configure an executable override, or put `{}` on PATH.",
            tool.name(),
            tool.wrapper_names(platform).join(" or "),
            tool.path_command()
        )),
    }
}

fn resolve_build_tool(
    build_dir: &Path,
    workspace_root: &Path,
    tool: BuildTool,
    config: Option<&WorkspaceToolConfig>,
) -> ToolResolution {
    resolve_build_tool_with_path(
        build_dir,
        workspace_root,
        tool,
        config,
        HostPlatform::current(),
        std::env::var_os("PATH").as_deref(),
    )
}

/// Like [`resolve_build_tool`] but searches an explicit `PATH` for the global
/// (last-tier) fallback — used when spawning a build tool directly so the lookup
/// matches the SDK-enhanced environment the process will actually run with.
fn resolve_build_tool_on_path(
    build_dir: &Path,
    workspace_root: &Path,
    tool: BuildTool,
    config: Option<&WorkspaceToolConfig>,
    path: Option<&OsStr>,
) -> ToolResolution {
    resolve_build_tool_with_path(
        build_dir,
        workspace_root,
        tool,
        config,
        HostPlatform::current(),
        path,
    )
}

/// Maven's default lifecycle phases most people run, in lifecycle order.
const MAVEN_LIFECYCLE_PHASES: &[&str] = &[
    "clean", "validate", "compile", "test", "package", "verify", "install",
];

/// Gradle tasks common to the base/Java plugins (a fixed set — a live
/// `gradle tasks --all` enumeration would require spawning Gradle and is left as
/// a follow-up so this stays a pure, fast, offline function).
const GRADLE_COMMON_TASKS: &[&str] = &[
    "clean", "classes", "build", "assemble", "check", "test", "jar",
];

fn discover_java_build_directories(
    root: &Path,
) -> Result<Vec<(JavaBuildSystem, PathBuf, String)>, String> {
    let mut files = Vec::new();
    collect_workspace_files(root, root, 0, 10, 3_000, &mut files)?;
    let mut builds = Vec::new();
    for entry in files {
        let file_name = Path::new(&entry.path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let build_system = match file_name {
            "pom.xml" => JavaBuildSystem::Maven,
            "build.gradle" | "build.gradle.kts" => JavaBuildSystem::Gradle,
            _ => continue,
        };
        let build_dir = root
            .join(&entry.path)
            .parent()
            .unwrap_or(root)
            .to_path_buf();
        if builds
            .iter()
            .any(|(existing, dir, _)| *existing == build_system && *dir == build_dir)
        {
            continue;
        }
        let module_path = relative_path(root, &build_dir)?;
        builds.push((
            build_system,
            build_dir,
            if module_path.is_empty() {
                ".".into()
            } else {
                module_path
            },
        ));
    }
    builds.sort_by(|left, right| {
        left.2
            .split('/')
            .count()
            .cmp(&right.2.split('/').count())
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| format!("{:?}", left.0).cmp(&format!("{:?}", right.0)))
    });
    Ok(builds)
}

fn build_task_id(source: &str, module_path: &str, task: &str) -> String {
    if module_path == "." {
        format!("{source}:{task}")
    } else {
        format!("{source}:{}:{task}", module_path.replace(['/', '\\'], ":"))
    }
}

fn gradle_task_selector(invocation_root: &Path, build_dir: &Path, task: &str) -> String {
    let Ok(relative) = build_dir.strip_prefix(invocation_root) else {
        return task.into();
    };
    if relative.as_os_str().is_empty() {
        return task.into();
    }
    let project = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(":");
    format!(":{project}:{task}")
}

/// Build the grouped task tree: detected tasks bucketed by source (first-seen
/// order preserved), with Maven/Gradle enriched to their full lifecycle / common
/// tasks. Pure and offline — no build tool is spawned.
fn build_workspace_task_tree(
    root: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTaskGroup>, String> {
    let detected = detect_workspace_tasks(root, tool_config)?;
    let mut groups: Vec<WorkspaceTaskGroup> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let push = |groups: &mut Vec<WorkspaceTaskGroup>,
                index: &mut std::collections::HashMap<String, usize>,
                task: WorkspaceTask| {
        // Skip duplicate labels within a source (enrichment may overlap detection).
        if let Some(&i) = index.get(&task.source) {
            let group: &mut WorkspaceTaskGroup = &mut groups[i];
            if group.tasks.iter().any(|existing| existing.id == task.id) {
                return;
            }
            group.tasks.push(task);
        } else {
            index.insert(task.source.clone(), groups.len());
            groups.push(WorkspaceTaskGroup {
                source: task.source.clone(),
                tasks: vec![task],
            });
        }
    };

    // Maven / Gradle full lifecycle first (before the detected subset merges
    // in), including nested modules in a monorepo. Build commands use the
    // nearest parent wrapper and a module-qualified Gradle task selector.
    for (build_system, build_dir, module_path) in discover_java_build_directories(root)? {
        match build_system {
            JavaBuildSystem::Maven => {
                let resolution =
                    resolve_build_tool(&build_dir, root, BuildTool::Maven, tool_config);
                let runner = resolution.task_runner(HostPlatform::current());
                for phase in MAVEN_LIFECYCLE_PHASES {
                    push(
                        &mut groups,
                        &mut index,
                        WorkspaceTask {
                            id: build_task_id("Maven", &module_path, phase),
                            label: (*phase).to_string(),
                            command: format!("{runner} {phase}"),
                            cwd: path_to_string(&build_dir),
                            source: "Maven".into(),
                            module_path: Some(module_path.clone()),
                            execution: Some(resolution.execution(&[phase])),
                            environment: None,
                        },
                    );
                }
                push(
                    &mut groups,
                    &mut index,
                    WorkspaceTask {
                        id: build_task_id("Maven", &module_path, "rebuild"),
                        label: "rebuild".into(),
                        command: format!("{runner} clean compile"),
                        cwd: path_to_string(&build_dir),
                        source: "Maven".into(),
                        module_path: Some(module_path),
                        execution: Some(resolution.execution(&["clean", "compile"])),
                        environment: None,
                    },
                );
            }
            JavaBuildSystem::Gradle => {
                let invocation_root = gradle_invocation_root(root, &build_dir);
                let resolution =
                    resolve_build_tool(&invocation_root, root, BuildTool::Gradle, tool_config);
                let runner = resolution.task_runner(HostPlatform::current());
                for task in GRADLE_COMMON_TASKS {
                    let selector = gradle_task_selector(&invocation_root, &build_dir, task);
                    push(
                        &mut groups,
                        &mut index,
                        WorkspaceTask {
                            id: build_task_id("Gradle", &module_path, task),
                            label: (*task).to_string(),
                            command: format!("{runner} {}", shell_quote(&selector)),
                            cwd: path_to_string(&invocation_root),
                            source: "Gradle".into(),
                            module_path: Some(module_path.clone()),
                            execution: Some(resolution.execution(&[&selector])),
                            environment: None,
                        },
                    );
                }
                let clean = gradle_task_selector(&invocation_root, &build_dir, "clean");
                let classes = gradle_task_selector(&invocation_root, &build_dir, "classes");
                push(
                    &mut groups,
                    &mut index,
                    WorkspaceTask {
                        id: build_task_id("Gradle", &module_path, "rebuild"),
                        label: "rebuild".into(),
                        command: format!(
                            "{runner} {} {}",
                            shell_quote(&clean),
                            shell_quote(&classes)
                        ),
                        cwd: path_to_string(&invocation_root),
                        source: "Gradle".into(),
                        module_path: Some(module_path),
                        execution: Some(resolution.execution(&[&clean, &classes])),
                        environment: None,
                    },
                );
            }
            JavaBuildSystem::SourceFile => {}
        }
    }

    for task in detected {
        push(&mut groups, &mut index, task);
    }
    Ok(groups)
}

fn detect_workspace_tasks(
    root: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTask>, String> {
    let mut tasks = Vec::new();

    let package_json = root.join("package.json");
    if package_json.is_file() {
        let contents = fs::read_to_string(&package_json)
            .map_err(|e| format!("read {}: {e}", package_json.display()))?;
        let package: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| format!("parse {}: {e}", package_json.display()))?;
        let manager = if root.join("pnpm-lock.yaml").is_file() {
            "pnpm"
        } else if root.join("yarn.lock").is_file() {
            "yarn"
        } else {
            "npm"
        };
        if let Some(scripts) = package
            .get("scripts")
            .and_then(serde_json::Value::as_object)
        {
            let mut names: Vec<_> = scripts.keys().cloned().collect();
            names.sort();
            for name in names {
                push_task(
                    &mut tasks,
                    "package.json",
                    name.clone(),
                    format!("{manager} run {name}"),
                    root,
                );
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        for (label, command) in [
            ("build", "cargo build"),
            ("test", "cargo test"),
            ("run", "cargo run"),
            ("clippy", "cargo clippy"),
        ] {
            push_task(&mut tasks, "Cargo.toml", label, command, root);
        }
    }

    for (file_name, runner) in [
        ("Makefile", "make"),
        ("makefile", "make"),
        ("justfile", "just"),
    ] {
        let path = root.join(file_name);
        if !path.is_file() {
            continue;
        }
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        for target in parse_named_targets(&contents) {
            push_task(
                &mut tasks,
                file_name,
                target.clone(),
                format!("{runner} {target}"),
                root,
            );
        }
        if file_name.eq_ignore_ascii_case("makefile") {
            break;
        }
    }

    if root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file() {
        let resolution = resolve_build_tool(root, root, BuildTool::Gradle, tool_config);
        for target in ["build", "test"] {
            push_tool_task(&mut tasks, "Gradle", target, &resolution, root);
        }
    }

    if root.join("pom.xml").is_file() {
        let resolution = resolve_build_tool(root, root, BuildTool::Maven, tool_config);
        for target in ["package", "test"] {
            push_tool_task(&mut tasks, "Maven", target, &resolution, root);
        }
    }

    if root.join("go.mod").is_file() {
        for (label, command) in [
            ("build", "go build ./..."),
            ("test", "go test ./..."),
            ("vet", "go vet ./..."),
        ] {
            push_task(&mut tasks, "go.mod", label, command, root);
        }
    }

    let pyproject = root.join("pyproject.toml");
    if pyproject.is_file() {
        let contents = fs::read_to_string(&pyproject)
            .map_err(|e| format!("read {}: {e}", pyproject.display()))?;
        let project: toml::Value =
            toml::from_str(&contents).map_err(|e| format!("parse {}: {e}", pyproject.display()))?;
        let runner = if root.join("uv.lock").is_file() {
            "uv run"
        } else if project
            .get("tool")
            .and_then(|value| value.get("poetry"))
            .is_some()
        {
            "poetry run"
        } else {
            ""
        };
        let script_tables = [
            project
                .get("project")
                .and_then(|value| value.get("scripts")),
            project
                .get("tool")
                .and_then(|value| value.get("poetry"))
                .and_then(|value| value.get("scripts")),
        ];
        for table in script_tables.into_iter().flatten() {
            let Some(table) = table.as_table() else {
                continue;
            };
            let mut names: Vec<_> = table.keys().cloned().collect();
            names.sort();
            for name in names {
                if tasks
                    .iter()
                    .any(|task| task.source == "pyproject.toml" && task.label == name)
                {
                    continue;
                }
                let command = if runner.is_empty() {
                    name.clone()
                } else {
                    format!("{runner} {name}")
                };
                push_task(&mut tasks, "pyproject.toml", name, command, root);
            }
        }
    }

    Ok(tasks)
}

const JAVA_RUN_SCAN_MAX_FILES: usize = 5_000;
const JAVA_RUN_SCAN_MAX_DEPTH: usize = 25;
const JAVA_RUN_SOURCE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const GRADLE_JAVA_RUN_INIT: &str = r#"allprojects { project ->
    project.afterEvaluate {
        if (project.plugins.hasPlugin('java') && project.tasks.findByName('taomniRun') == null) {
            project.tasks.register('taomniRun', JavaExec) {
                group = 'application'
                description = 'Run a Java main class selected by Taomni'
                classpath = project.sourceSets.main.runtimeClasspath
                def selectedMain = project.findProperty('taomniMainClass')
                if (selectedMain == null || selectedMain.toString().trim().isEmpty()) {
                    throw new GradleException('Missing -PtaomniMainClass')
                }
                if (delegate.hasProperty('mainClass')) {
                    mainClass.set(selectedMain.toString())
                } else {
                    main = selectedMain.toString()
                }
                standardInput = System.in
            }
        }
    }
}
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JavaBuildSystem {
    Maven,
    Gradle,
    SourceFile,
}

fn java_main_regex() -> &'static Regex {
    static MAIN: OnceLock<Regex> = OnceLock::new();
    MAIN.get_or_init(|| {
        Regex::new(
            r"(?s)\b(?:public\s+)?static\s+void\s+main\s*\(\s*(?:final\s+)?(?:java\.lang\.)?String\s*(?:\[\s*\]\s*[A-Za-z_$][A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*\s*\[\s*\]|\.{3}\s*[A-Za-z_$][A-Za-z0-9_$]*)\s*\)",
        )
        .expect("valid Java main regex")
    })
}

fn java_package_regex() -> &'static Regex {
    static PACKAGE: OnceLock<Regex> = OnceLock::new();
    PACKAGE.get_or_init(|| {
        Regex::new(
            r"(?m)^\s*package\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;",
        )
        .expect("valid Java package regex")
    })
}

fn maven_arg_line_regex() -> &'static Regex {
    static ARG_LINE: OnceLock<Regex> = OnceLock::new();
    ARG_LINE.get_or_init(|| {
        Regex::new(r"(?is)<argLine(?:\s[^>]*)?>(.*?)</argLine\s*>")
            .expect("valid Maven argLine regex")
    })
}

fn xml_comment_regex() -> &'static Regex {
    static XML_COMMENT: OnceLock<Regex> = OnceLock::new();
    XML_COMMENT.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").expect("valid XML comment regex"))
}

fn is_inheritable_maven_jvm_option(value: &str) -> bool {
    [
        "--add-opens",
        "--add-exports",
        "--add-reads",
        "--add-modules",
        "--enable-native-access",
    ]
    .iter()
    .any(|option| value == *option || value.starts_with(&format!("{option}=")))
}

/// Read JPMS/native-access options from Maven test-plugin `argLine` elements.
///
/// `exec:java` runs the application inside Maven's JVM, while Surefire/Failsafe
/// normally fork a JVM and apply `argLine` only there. Reusing only these
/// module-access options through MAVEN_OPTS makes Run behave like the project's
/// tests without also inheriting agents, heap limits, or arbitrary properties.
fn maven_inherited_jvm_args(workspace_root: &Path, build_dir: &Path) -> Vec<String> {
    let mut directories = Vec::new();
    let mut current = Some(build_dir);
    while let Some(directory) = current {
        if !directory.starts_with(workspace_root) {
            break;
        }
        directories.push(directory.to_path_buf());
        if directory == workspace_root {
            break;
        }
        current = directory.parent();
    }
    directories.reverse();

    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for directory in directories {
        let Ok(pom) = fs::read_to_string(directory.join("pom.xml")) else {
            continue;
        };
        let pom = xml_comment_regex().replace_all(&pom, "");
        for captures in maven_arg_line_regex().captures_iter(&pom) {
            let Some(arg_line) = captures.get(1) else {
                continue;
            };
            let tokens = arg_line
                .as_str()
                .replace("<![CDATA[", "")
                .replace("]]>", "")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&gt;", ">")
                .replace("&lt;", "<")
                .replace("&amp;", "&")
                .split_whitespace()
                .map(|value| value.trim_matches(['"', '\'']).to_string())
                .collect::<Vec<_>>();
            let mut index = 0;
            while index < tokens.len() {
                let token = &tokens[index];
                if !is_inheritable_maven_jvm_option(token) {
                    index += 1;
                    continue;
                }
                let option = if token.contains('=') {
                    token.clone()
                } else if let Some(value) = tokens.get(index + 1).filter(|value| {
                    !value.starts_with('-') && !value.starts_with('$') && !value.starts_with('@')
                }) {
                    index += 1;
                    format!("{token}={value}")
                } else {
                    index += 1;
                    continue;
                };
                if seen.insert(option.clone()) {
                    result.push(option);
                }
                index += 1;
            }
        }
    }
    result
}

fn maven_run_environment(
    workspace_root: &Path,
    build_dir: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Option<WorkspaceTaskEnvironment> {
    let mut args = if tool_config
        .map(WorkspaceToolConfig::inherits_maven_arg_line)
        .unwrap_or(true)
    {
        maven_inherited_jvm_args(workspace_root, build_dir)
    } else {
        Vec::new()
    };
    if let Some(config) = tool_config {
        args.extend(
            config
                .maven_jvm_args
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        );
    }
    let mut seen = HashSet::new();
    args.retain(|value| seen.insert(value.clone()));
    if args.is_empty() {
        return None;
    }
    Some(BTreeMap::from([(
        "MAVEN_OPTS".into(),
        WorkspaceTaskEnvironmentVariable {
            value: args.join(" "),
            mode: "append".into(),
        },
    )]))
}

/// Strip comments and string/char/text-block contents before looking for a
/// main signature. This avoids presenting a Run action for examples embedded
/// in Javadoc or string literals while keeping line structure irrelevant.
fn java_code_only(source: &str) -> String {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Code,
        LineComment,
        BlockComment,
        String,
        Character,
        TextBlock,
    }

    let bytes = source.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut state = State::Code;
    let mut i = 0;
    while i < bytes.len() {
        let current = bytes[i];
        let next = bytes.get(i + 1).copied();
        let third = bytes.get(i + 2).copied();
        match state {
            State::Code if current == b'/' && next == Some(b'/') => {
                out.push_str("  ");
                state = State::LineComment;
                i += 2;
            }
            State::Code if current == b'/' && next == Some(b'*') => {
                out.push_str("  ");
                state = State::BlockComment;
                i += 2;
            }
            State::Code if current == b'"' && next == Some(b'"') && third == Some(b'"') => {
                out.push_str("   ");
                state = State::TextBlock;
                i += 3;
            }
            State::Code if current == b'"' => {
                out.push(' ');
                state = State::String;
                i += 1;
            }
            State::Code if current == b'\'' => {
                out.push(' ');
                state = State::Character;
                i += 1;
            }
            State::LineComment if current == b'\n' => {
                out.push('\n');
                state = State::Code;
                i += 1;
            }
            State::BlockComment if current == b'*' && next == Some(b'/') => {
                out.push_str("  ");
                state = State::Code;
                i += 2;
            }
            State::TextBlock if current == b'"' && next == Some(b'"') && third == Some(b'"') => {
                out.push_str("   ");
                state = State::Code;
                i += 3;
            }
            State::String | State::Character if current == b'\\' && next.is_some() => {
                out.push_str("  ");
                i += 2;
            }
            State::String if current == b'"' => {
                out.push(' ');
                state = State::Code;
                i += 1;
            }
            State::Character if current == b'\'' => {
                out.push(' ');
                state = State::Code;
                i += 1;
            }
            State::Code => {
                out.push(current as char);
                i += 1;
            }
            _ => {
                out.push(if current == b'\n' { '\n' } else { ' ' });
                i += 1;
            }
        }
    }
    out
}

fn shell_quote(value: &str) -> String {
    if cfg!(windows) {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn nearest_java_build(workspace_root: &Path, source_file: &Path) -> (JavaBuildSystem, PathBuf) {
    let mut current = source_file.parent();
    while let Some(dir) = current {
        if dir.join("pom.xml").is_file() {
            return (JavaBuildSystem::Maven, dir.to_path_buf());
        }
        if dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file() {
            return (JavaBuildSystem::Gradle, dir.to_path_buf());
        }
        if dir == workspace_root {
            break;
        }
        current = dir
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }
    (JavaBuildSystem::SourceFile, workspace_root.to_path_buf())
}

fn gradle_invocation_root(workspace_root: &Path, build_dir: &Path) -> PathBuf {
    let mut result = build_dir.to_path_buf();
    let mut current = Some(build_dir);
    while let Some(dir) = current {
        if dir.join("settings.gradle").is_file() || dir.join("settings.gradle.kts").is_file() {
            result = dir.to_path_buf();
            break;
        }
        if dir == workspace_root {
            break;
        }
        current = dir
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }
    result
}

fn gradle_run_init_script() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("taomni-code-workspace");
    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "create Gradle run support directory {}: {error}",
            dir.display()
        )
    })?;
    let path = dir.join("java-run.init.gradle");
    let should_write = fs::read_to_string(&path)
        .map(|current| current != GRADLE_JAVA_RUN_INIT)
        .unwrap_or(true);
    if should_write {
        fs::write(&path, GRADLE_JAVA_RUN_INIT)
            .map_err(|error| format!("write Gradle run support {}: {error}", path.display()))?;
    }
    Ok(path)
}

fn java_run_target_for_path(
    workspace_root: &Path,
    source_file: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<JavaRunTarget, String> {
    let metadata = fs::metadata(source_file)
        .map_err(|error| format!("stat {}: {error}", source_file.display()))?;
    if metadata.len() > JAVA_RUN_SOURCE_MAX_BYTES {
        return Err(format!(
            "Java source is too large to inspect for a main class: {}",
            source_file.display()
        ));
    }
    let source = fs::read_to_string(source_file)
        .map_err(|error| format!("read {}: {error}", source_file.display()))?;
    let code = java_code_only(&source);
    if !java_main_regex().is_match(&code) {
        return Err("No `static void main(String[] args)` entry point found in this file".into());
    }
    let class_name = source_file
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Invalid Java source file name: {}", source_file.display()))?;
    let package_name = java_package_regex()
        .captures(&code)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str());
    let main_class = package_name
        .map(|package| format!("{package}.{class_name}"))
        .unwrap_or_else(|| class_name.to_string());
    let relative_file = relative_path(workspace_root, source_file)?;
    let (build_system, build_dir) = nearest_java_build(workspace_root, source_file);
    let (command, cwd, module_path, build_system_name, execution, environment) = match build_system
    {
        JavaBuildSystem::Maven => {
            let resolution =
                resolve_build_tool(&build_dir, workspace_root, BuildTool::Maven, tool_config);
            let runner = resolution.task_runner(HostPlatform::current());
            let main_class_arg = format!("-Dexec.mainClass={main_class}");
            let cleanup_arg = "-Dexec.cleanupDaemonThreads=false".to_string();
            let args = vec![
                "-q".into(),
                "-DskipTests".into(),
                main_class_arg.clone(),
                cleanup_arg.clone(),
                "compile".into(),
                "org.codehaus.mojo:exec-maven-plugin:3.5.0:java".into(),
            ];
            let command = format!(
                "{runner} -q -DskipTests {} {} compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java",
                shell_quote(&main_class_arg),
                shell_quote(&cleanup_arg),
            );
            (
                command,
                path_to_string(&build_dir),
                relative_path(workspace_root, &build_dir).unwrap_or_else(|_| ".".into()),
                "maven",
                resolution.execution_owned(args),
                maven_run_environment(workspace_root, &build_dir, tool_config),
            )
        }
        JavaBuildSystem::Gradle => {
            let invocation_root = gradle_invocation_root(workspace_root, &build_dir);
            let resolution = resolve_build_tool(
                &invocation_root,
                workspace_root,
                BuildTool::Gradle,
                tool_config,
            );
            let runner = resolution.task_runner(HostPlatform::current());
            let init_script = gradle_run_init_script()?;
            let module_relative = build_dir
                .strip_prefix(&invocation_root)
                .ok()
                .filter(|path| !path.as_os_str().is_empty());
            let task = module_relative
                .map(|path| {
                    let project = path
                        .components()
                        .filter_map(|component| match component {
                            Component::Normal(value) => Some(value.to_string_lossy()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(":");
                    format!(":{project}:taomniRun")
                })
                .unwrap_or_else(|| "taomniRun".into());
            let args = vec![
                "--console=plain".into(),
                "-I".into(),
                path_to_string(&init_script),
                format!("-PtaomniMainClass={main_class}"),
                task.clone(),
            ];
            let command = format!(
                "{runner} --console=plain -I {} -PtaomniMainClass={} {}",
                shell_quote(&path_to_string(&init_script)),
                shell_quote(&main_class),
                shell_quote(&task),
            );
            (
                command,
                path_to_string(&invocation_root),
                relative_path(workspace_root, &build_dir).unwrap_or_else(|_| ".".into()),
                "gradle",
                resolution.execution_owned(args),
                None,
            )
        }
        JavaBuildSystem::SourceFile => {
            let file_path = path_to_string(source_file);
            (
                format!("java {}", shell_quote(&file_path)),
                path_to_string(workspace_root),
                ".".into(),
                "source-file",
                WorkspaceTaskExecution {
                    executable: "java".into(),
                    args: vec![file_path],
                    source: "path".into(),
                    error: None,
                },
                None,
            )
        }
    };
    let module_path = if module_path.is_empty() {
        ".".into()
    } else {
        module_path
    };
    Ok(JavaRunTarget {
        id: format!("java-main:{relative_file}"),
        label: main_class.clone(),
        main_class,
        file_path: path_to_string(source_file),
        command,
        cwd,
        build_system: build_system_name.into(),
        module_path,
        execution,
        environment,
    })
}

fn detect_java_run_targets(
    root: &Path,
    tool_config: Option<&WorkspaceToolConfig>,
) -> Result<Vec<JavaRunTarget>, String> {
    let mut files = Vec::new();
    collect_workspace_files(
        root,
        root,
        0,
        JAVA_RUN_SCAN_MAX_DEPTH,
        JAVA_RUN_SCAN_MAX_FILES,
        &mut files,
    )?;
    let mut targets = Vec::new();
    for entry in files {
        if !entry.path.to_ascii_lowercase().ends_with(".java")
            || entry
                .path
                .split(['/', '\\'])
                .any(|segment| segment.eq_ignore_ascii_case("test"))
        {
            continue;
        }
        let source_file = root.join(&entry.path);
        match java_run_target_for_path(root, &source_file, tool_config) {
            Ok(target) => targets.push(target),
            Err(error) if error.starts_with("No `static void main") => {}
            Err(error) if error.starts_with("Java source is too large") => {}
            Err(error) => return Err(error),
        }
    }
    targets.sort_by(|left, right| {
        left.main_class
            .to_ascii_lowercase()
            .cmp(&right.main_class.to_ascii_lowercase())
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    Ok(targets)
}

#[tauri::command]
pub fn workspace_detect_tasks(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTask>, String> {
    let root = canonical_repo_root(&repo_root)?;
    detect_workspace_tasks(&root, tool_config.as_ref())
}

#[tauri::command]
pub fn workspace_java_run_targets(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<Vec<JavaRunTarget>, String> {
    let root = canonical_repo_root(&repo_root)?;
    detect_java_run_targets(&root, tool_config.as_ref())
}

#[tauri::command]
pub fn workspace_java_run_target(
    repo_root: String,
    file_path: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<JavaRunTarget, String> {
    let root = canonical_repo_root(&repo_root)?;
    let source_file = resolve_existing_path(&root, &file_path)?;
    if source_file.extension().and_then(|value| value.to_str()) != Some("java") {
        return Err("Run Java File requires a .java source file".into());
    }
    java_run_target_for_path(&root, &source_file, tool_config.as_ref())
}

/// Grouped task tree for the Build panel (M7 F-2). Maven/Gradle carry their full
/// lifecycle / common tasks; other ecosystems group their detected tasks by source.
#[tauri::command]
pub fn workspace_task_tree(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTaskGroup>, String> {
    let root = canonical_repo_root(&repo_root)?;
    build_workspace_task_tree(&root, tool_config.as_ref())
}

/// Suppress the transient console window when spawning `.cmd`/`.bat` wrappers
/// (mvnw.cmd / gradlew.bat) from the GUI process on Windows.
fn no_console_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Dependency resolution can take a while on a cold Maven/Gradle cache; cap it.
const DEPENDENCY_TREE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Resolve the project dependency tree (M7 F-1) by spawning the build tool:
/// `mvn dependency:tree` for a pom.xml, `gradle dependencies` for a Gradle build.
/// Requires the tool (or its wrapper) to be available; returns a clear error if
/// the project is neither Maven nor Gradle, or the command fails / times out.
#[tauri::command]
pub async fn workspace_dependency_tree(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
    state: State<'_, AppState>,
) -> Result<Vec<DependencyNode>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let is_maven = root.join("pom.xml").is_file();
    let is_gradle = root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file();
    if !is_maven && !is_gradle {
        return Err(
            "No pom.xml or build.gradle found; dependency tree needs a Maven or Gradle project"
                .into(),
        );
    }

    // Resolve the workspace SDK environment so a directly-spawned build tool sees
    // the same JAVA_HOME/PATH the integrated terminal injects. Best-effort — fall
    // back to the inherited environment if resolution fails.
    let sdk_environment = state.sdk.resolve_environment(&root, &root).await.ok();
    let process_path = std::env::var_os("PATH");
    let sdk_path: Option<OsString> = sdk_environment
        .as_ref()
        .and_then(|env| env.prepend_path(process_path.as_deref()));
    let lookup_path = sdk_path.as_deref().or(process_path.as_deref());

    // Maven is preferred when both exist (rare); its tree carries scopes. The
    // global (PATH) fallback tier searches the SDK-enhanced PATH.
    let (resolution, args): (ToolResolution, Vec<String>) = if is_maven {
        (
            resolve_build_tool_on_path(
                &root,
                &root,
                BuildTool::Maven,
                tool_config.as_ref(),
                lookup_path,
            ),
            vec!["-B".into(), "-q".into(), "dependency:tree".into()],
        )
    } else {
        (
            resolve_build_tool_on_path(
                &root,
                &root,
                BuildTool::Gradle,
                tool_config.as_ref(),
                lookup_path,
            ),
            vec![
                "-q".into(),
                "dependencies".into(),
                "--configuration".into(),
                "runtimeClasspath".into(),
            ],
        )
    };
    // Surface a clear diagnostic instead of spawning a runner we know is missing.
    resolution.require_available()?;

    // On Windows a `.cmd`/`.bat` wrapper cannot be launched directly by
    // CreateProcess and needs `cmd.exe /D /S /C`. `plan_tool_launch` returns the
    // correct program/args pair for the resolved executable.
    let plan = plan_tool_launch(&resolution.executable, &args, HostPlatform::current());
    let display = path_to_string(&resolution.executable);

    let mut command = tokio::process::Command::new(&plan.program);
    command
        .args(&plan.args)
        .current_dir(&root)
        .kill_on_drop(true);
    // Inject the SDK environment (JAVA_HOME etc. + prepended PATH) so the build
    // tool resolves the workspace's configured JDK, matching the terminal.
    if let Some(environment) = sdk_environment.as_ref() {
        for (key, value) in &environment.environment {
            command.env(key, value);
        }
        if let Some(path) = sdk_path.as_ref() {
            command.env("PATH", path);
        }
    }
    no_console_window(&mut command);

    let output = tokio::time::timeout(DEPENDENCY_TREE_TIMEOUT, command.output())
        .await
        .map_err(|_| "Dependency resolution timed out".to_string())?
        .map_err(|error| {
            format!("Failed to run `{display}` (is it installed / on PATH?): {error}")
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            stdout.trim()
        } else {
            detail
        };
        let snippet: String = detail.chars().take(600).collect();
        return Err(format!(
            "`{display}` exited with {}: {snippet}",
            output.status
        ));
    }

    let tree = if is_maven {
        parse_maven_dependency_tree(&stdout)
    } else {
        parse_gradle_dependencies(&stdout)
    };
    Ok(tree)
}

#[tauri::command]
pub fn workspace_list_dir(
    repo_root: String,
    path: Option<String>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", target.display()));
    }

    list_workspace_entries(&root, &target)
}

#[tauri::command]
pub fn workspace_compact_chain(
    repo_root: String,
    path: String,
    max_depth: Option<usize>,
) -> Result<WorkspaceCompactChain, String> {
    let root = canonical_repo_root(&repo_root)?;
    let mut current = resolve_existing_path(&root, &path)?;
    let limit = max_depth.unwrap_or(16).min(HARD_RECURSIVE_MAX_DEPTH);

    for _ in 0..limit {
        let entries = list_workspace_entries(&root, &current)?;
        if entries.len() != 1 || entries[0].file_type != "dir" {
            return Ok(WorkspaceCompactChain {
                path: relative_path(&root, &current)?,
                entries,
            });
        }
        current = resolve_existing_path(&root, &entries[0].path)?;
    }

    Ok(WorkspaceCompactChain {
        path: relative_path(&root, &current)?,
        entries: list_workspace_entries(&root, &current)?,
    })
}

#[tauri::command]
pub fn workspace_list_files_recursive(
    repo_root: String,
    path: Option<String>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let start = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
    let meta = fs::metadata(&start).map_err(|e| format!("stat {}: {e}", start.display()))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", start.display()));
    }

    let max_depth = max_depth
        .unwrap_or(DEFAULT_RECURSIVE_MAX_DEPTH)
        .min(HARD_RECURSIVE_MAX_DEPTH);
    let max_files = max_files
        .unwrap_or(DEFAULT_RECURSIVE_MAX_FILES)
        .min(HARD_RECURSIVE_MAX_FILES);
    let mut files = Vec::new();
    collect_workspace_files(&root, &start, 0, max_depth, max_files, &mut files)?;
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub fn workspace_detect_git_roots(
    roots: Vec<WorkspaceGitRootCandidate>,
) -> Result<Vec<WorkspaceGitRoot>, String> {
    let mut repos: Vec<WorkspaceGitRoot> = Vec::new();
    for root in roots {
        let Ok(path) = fs::canonicalize(&root.path) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mut found = Vec::new();
        if let Some(repo_root) = find_git_repo_root(&path) {
            found.push(repo_root);
        }
        let mut remaining_dirs = GIT_ROOT_SCAN_MAX_DIRS;
        collect_nested_git_roots(
            &path,
            0,
            GIT_ROOT_SCAN_MAX_DEPTH,
            &mut remaining_dirs,
            &mut found,
        )?;

        for repo_root in found {
            upsert_workspace_git_root(&mut repos, &root, &path, &repo_root);
        }
    }
    repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(repos)
}

#[tauri::command]
pub fn workspace_read_file(
    repo_root: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    file_from_bytes(&root, &target, bytes, meta)
}

#[tauri::command]
pub fn workspace_read_loose_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let target = resolve_existing_loose_file_path(&path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    loose_file_from_bytes(&target, bytes, meta)
}

#[tauri::command]
pub fn workspace_write_file(
    repo_root: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;

    if let Some(expected) = expected_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let current = fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Cannot compare expected hash; file does not exist: {}",
                    target.display()
                )
            } else {
                format!("read {}: {e}", target.display())
            }
        })?;
        let current_hash = sha256_hex(&current);
        if !current_hash.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "File changed on disk; expected hash {expected}, found {current_hash}"
            ));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    if let Err(e) = replace_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    workspace_read_file(repo_root, path, None)
}

#[tauri::command]
pub fn workspace_write_loose_file(
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    let target = resolve_writable_loose_file_path(&path)?;
    reject_protected_loose_write(&target)?;

    if let Some(expected) = expected_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let current = fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Cannot compare expected hash; file does not exist: {}",
                    target.display()
                )
            } else {
                format!("read {}: {e}", target.display())
            }
        })?;
        let current_hash = sha256_hex(&current);
        if !current_hash.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "File changed on disk; expected hash {expected}, found {current_hash}"
            ));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    if let Err(e) = replace_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    workspace_read_loose_file(path, None)
}

#[tauri::command]
pub fn workspace_create_file(
    repo_root: String,
    path: String,
    contents: Option<String>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;
    if target.exists() {
        return Err(format!("Path already exists: {}", target.display()));
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("create {}: {e}", target.display()))?;
    {
        use std::io::Write;
        file.write_all(contents.unwrap_or_default().as_bytes())
            .map_err(|e| format!("write {}: {e}", target.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", target.display()))?;
    }
    workspace_read_file(repo_root, path, None)
}

#[tauri::command]
pub fn workspace_create_dir(repo_root: String, path: String) -> Result<WorkspaceEntry, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;
    if target.exists() {
        return Err(format!("Path already exists: {}", target.display()));
    }
    fs::create_dir(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
    workspace_entry(&root, &target)
}

#[tauri::command]
pub fn workspace_delete_path(
    repo_root: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    reject_workspace_root_target(&root, &target, "delete")?;
    reject_protected_write(&root, &target)?;
    let meta =
        fs::symlink_metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(&target).map_err(|e| format!("rmdir {}: {e}", target.display()))?;
        } else {
            fs::remove_dir(&target).map_err(|e| format!("rmdir {}: {e}", target.display()))?;
        }
    } else {
        fs::remove_file(&target).map_err(|e| format!("remove {}: {e}", target.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_rename_path(
    repo_root: String,
    from_path: String,
    to_path: String,
) -> Result<WorkspaceEntry, String> {
    let root = canonical_repo_root(&repo_root)?;
    let from = resolve_existing_path(&root, &from_path)?;
    reject_workspace_root_target(&root, &from, "rename")?;
    reject_protected_write(&root, &from)?;
    let to = resolve_writable_path(&root, &to_path)?;
    reject_protected_write(&root, &to)?;
    if to.exists() {
        return Err(format!("Path already exists: {}", to.display()));
    }
    fs::rename(&from, &to)
        .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
    workspace_entry(&root, &to)
}

fn canonical_repo_root(repo_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(repo_root);
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("resolve repo root {}: {e}", root.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Repo root is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn resolve_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    let target = root.join(requested);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))?;
    ensure_inside(root, &canonical)?;
    Ok(canonical)
}

fn resolve_writable_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    if requested.as_os_str().is_empty() {
        return Err("Cannot write the workspace root".to_string());
    }
    let target = root.join(&requested);
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    ensure_inside(root, &parent_canonical)?;
    Ok(target)
}

fn resolve_existing_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))
}

fn resolve_writable_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    Ok(target)
}

fn loose_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Loose file path cannot be empty".into());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err("Loose file path must be absolute".into());
    }
    Ok(target)
}

fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => return Err("Workspace paths cannot contain '..'".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Workspace paths must be relative".into());
            }
        }
    }
    Ok(out)
}

fn ensure_inside(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err(format!(
            "Path escapes workspace root: {} is outside {}",
            target.display(),
            root.display()
        ))
    }
}

fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if target.exists() {
            fs::remove_file(target)?;
        }
    }
    fs::rename(tmp, target)
}

fn reject_workspace_root_target(root: &Path, target: &Path, operation: &str) -> Result<(), String> {
    if target == root {
        Err(format!("Cannot {operation} the workspace root"))
    } else {
        Ok(())
    }
}

fn reject_protected_write(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

fn reject_protected_loose_write(target: &Path) -> Result<(), String> {
    if target
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

fn list_workspace_entries(root: &Path, target: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(target).map_err(|e| format!("read {}: {e}", target.display()))?;
    for item in read {
        let Ok(item) = item else {
            continue;
        };
        let path = item.path();
        if let Ok(entry) = workspace_entry(root, &path) {
            entries.push(entry);
        }
    }
    entries.sort_by(
        |a, b| match (a.file_type.as_str() == "dir", b.file_type.as_str() == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        },
    );
    Ok(entries)
}

fn find_git_repo_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn upsert_workspace_git_root(
    repos: &mut Vec<WorkspaceGitRoot>,
    workspace_root: &WorkspaceGitRootCandidate,
    workspace_path: &Path,
    repo_root: &Path,
) {
    let repo_root = path_to_string(repo_root);
    if let Some(existing) = repos.iter_mut().find(|item| item.repo_root == repo_root) {
        if !existing.root_ids.contains(&workspace_root.id) {
            existing.root_ids.push(workspace_root.id.clone());
        }
        return;
    }
    repos.push(WorkspaceGitRoot {
        id: format!("{}:{}", workspace_root.id, repo_root),
        name: repo_display_name(repo_root.as_str(), &workspace_root.name),
        path: path_to_string(workspace_path),
        is_submodule: is_git_file(repo_root.as_str()),
        repo_root,
        root_ids: vec![workspace_root.id.clone()],
    });
}

fn is_git_file(repo_root: &str) -> bool {
    fs::symlink_metadata(Path::new(repo_root).join(".git"))
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

fn collect_nested_git_roots(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    remaining_dirs: &mut usize,
    repos: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > max_depth || *remaining_dirs == 0 {
        return Ok(());
    }
    if depth > 0 && should_skip_git_root_scan_dir(dir) {
        return Ok(());
    }
    *remaining_dirs = (*remaining_dirs).saturating_sub(1);
    if dir.join(".git").exists() && !repos.iter().any(|repo| repo == dir) {
        repos.push(dir.to_path_buf());
    }
    if depth == max_depth {
        return Ok(());
    }
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in read {
        if *remaining_dirs == 0 {
            return Ok(());
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        if should_skip_git_root_scan_dir(&path) {
            continue;
        }
        collect_nested_git_roots(&path, depth + 1, max_depth, remaining_dirs, repos)?;
    }
    Ok(())
}

fn should_skip_git_root_scan_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

fn repo_display_name(repo_root: &str, fallback: &str) -> String {
    Path::new(repo_root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn path_to_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    // Windows canonicalize() yields `\\?\C:\...`; strip the verbatim prefix so
    // repo roots compare equal to non-canonical paths from callers/tests.
    let stripped = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw.as_ref());
    stripped.to_string()
}

fn collect_workspace_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    max_files: usize,
    files: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > max_depth || files.len() >= max_files {
        return Ok(());
    }
    // Skip dependency / build trees on every platform; walking `node_modules`
    // or `target` is a common Windows CPU spike when the flat index builds.
    if depth > 0 && should_skip_git_root_scan_dir(dir) {
        return Ok(());
    }
    for entry in list_workspace_entries(root, dir)? {
        if entry.path == ".git" || entry.path.starts_with(".git/") {
            continue;
        }
        if should_skip_workspace_entry_path(&entry.path) {
            continue;
        }
        match entry.file_type.as_str() {
            "file" => {
                files.push(entry);
                if files.len() >= max_files {
                    return Ok(());
                }
            }
            "dir" if depth < max_depth => {
                let child = resolve_existing_path(root, &entry.path)?;
                collect_workspace_files(root, &child, depth + 1, max_depth, max_files, files)?;
                if files.len() >= max_files {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn should_skip_workspace_entry_path(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| {
        matches!(
            segment,
            ".git"
                | ".hg"
                | ".svn"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".turbo"
                | ".cache"
                | "__pycache__"
                | ".venv"
                | "venv"
        )
    })
}

fn workspace_entry(root: &Path, path: &Path) -> Result<WorkspaceEntry, String> {
    let symlink_meta =
        fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let file_type = if symlink_meta.file_type().is_symlink() {
        "symlink"
    } else if symlink_meta.is_dir() {
        "dir"
    } else if symlink_meta.is_file() {
        "file"
    } else {
        "other"
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(WorkspaceEntry {
        name: name.clone(),
        path: relative_path(root, path)?,
        file_type: file_type.to_string(),
        size: symlink_meta.len(),
        mtime: mtime_secs(&symlink_meta),
        is_hidden: name.starts_with('.'),
    })
}

fn file_from_bytes(
    root: &Path,
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let text =
        String::from_utf8(bytes.clone()).map_err(|e| format!("File is not valid UTF-8: {e}"))?;
    Ok(WorkspaceFile {
        path: relative_path(root, target)?,
        text,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

fn loose_file_from_bytes(
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let text =
        String::from_utf8(bytes.clone()).map_err(|e| format!("File is not valid UTF-8: {e}"))?;
    Ok(WorkspaceFile {
        path: path_for_display(target),
        text,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

fn path_for_display(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value
}

fn relative_path(root: &Path, target: &Path) -> Result<String, String> {
    let rel = target
        .strip_prefix(root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let err = workspace_list_dir(dir.path().to_string_lossy().to_string(), Some("../".into()))
            .unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn rejects_dot_git_writes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let err = workspace_write_file(
            dir.path().to_string_lossy().to_string(),
            ".git/config".into(),
            "x".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn detects_expected_hash_conflict() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "one").unwrap();
        let file = workspace_read_file(
            dir.path().to_string_lossy().to_string(),
            "a.txt".into(),
            None,
        )
        .unwrap();
        fs::write(dir.path().join("a.txt"), "two").unwrap();
        let err = workspace_write_file(
            dir.path().to_string_lossy().to_string(),
            "a.txt".into(),
            "three".into(),
            Some(file.hash),
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn reads_and_writes_loose_file_with_hash_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "one").unwrap();
        let path_string = path.to_string_lossy().to_string();

        let file = workspace_read_loose_file(path_string.clone(), None).unwrap();
        assert_eq!(file.path, path_string);
        assert_eq!(file.text, "one");

        let saved =
            workspace_write_loose_file(path_string.clone(), "two".into(), Some(file.hash)).unwrap();
        assert_eq!(saved.text, "two");

        let err = workspace_write_loose_file(path_string, "three".into(), Some("bad".into()))
            .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn rejects_dot_git_loose_writes() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        let path = git_dir.join("config");
        fs::write(&path, "x").unwrap();

        let err = workspace_write_loose_file(path.to_string_lossy().to_string(), "y".into(), None)
            .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn creates_renames_and_deletes_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        workspace_create_dir(root.clone(), "src".into()).unwrap();
        let file =
            workspace_create_file(root.clone(), "src/main.ts".into(), Some("one".into())).unwrap();
        assert_eq!(file.path, "src/main.ts");
        assert_eq!(file.text, "one");

        let renamed =
            workspace_rename_path(root.clone(), "src/main.ts".into(), "src/app.ts".into()).unwrap();
        assert_eq!(renamed.path, "src/app.ts");
        assert!(!dir.path().join("src/main.ts").exists());
        assert!(dir.path().join("src/app.ts").exists());

        workspace_delete_path(root, "src/app.ts".into(), None).unwrap();
        assert!(!dir.path().join("src/app.ts").exists());
    }

    #[test]
    fn creates_and_deletes_directory_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let entry = workspace_create_dir(root.clone(), "src".into()).unwrap();
        assert_eq!(entry.file_type, "dir");
        workspace_create_file(root.clone(), "src/main.ts".into(), None).unwrap();

        let err = workspace_delete_path(root.clone(), "src".into(), Some(false)).unwrap_err();
        assert!(err.contains("rmdir"));

        workspace_delete_path(root, "src".into(), Some(true)).unwrap();
        assert!(!dir.path().join("src").exists());
    }

    #[test]
    fn returns_compact_chain_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("src/main/java/com/example/service")).unwrap();
        fs::write(
            dir.path()
                .join("src/main/java/com/example/service/UserService.java"),
            "class UserService {}",
        )
        .unwrap();

        let chain = workspace_compact_chain(root, "src".into(), Some(16)).unwrap();

        assert_eq!(chain.path, "src/main/java/com/example/service");
        assert_eq!(chain.entries.len(), 1);
        assert_eq!(
            chain.entries[0].path,
            "src/main/java/com/example/service/UserService.java"
        );
    }

    #[test]
    fn recursively_lists_files_with_limits_and_skips_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("src/a")).unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("src/a/one.ts"), "one").unwrap();
        fs::write(dir.path().join("src/two.ts"), "two").unwrap();
        fs::write(dir.path().join(".git/config"), "hidden").unwrap();

        let files = workspace_list_files_recursive(root.clone(), None, Some(10), Some(10)).unwrap();
        let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["src/a/one.ts", "src/two.ts"]);

        let limited = workspace_list_files_recursive(root, None, Some(10), Some(1)).unwrap();
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn recursive_listing_skips_dependency_and_build_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("target/debug")).unwrap();
        fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(
            dir.path().join("node_modules/pkg/index.js"),
            "module.exports=1",
        )
        .unwrap();
        fs::write(dir.path().join("target/debug/app"), "bin").unwrap();

        let files = workspace_list_files_recursive(root, None, Some(10), Some(100)).unwrap();
        let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["src/main.rs"]);
    }

    #[test]
    fn detects_git_roots_and_deduplicates_nested_roots() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let nested = repo.join("packages/app");
        let plain = dir.path().join("plain");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&plain).unwrap();

        let repos = workspace_detect_git_roots(vec![
            WorkspaceGitRootCandidate {
                id: "repo".into(),
                name: "repo".into(),
                path: repo.to_string_lossy().to_string(),
            },
            WorkspaceGitRootCandidate {
                id: "app".into(),
                name: "app".into(),
                path: nested.to_string_lossy().to_string(),
            },
            WorkspaceGitRootCandidate {
                id: "plain".into(),
                name: "plain".into(),
                path: plain.to_string_lossy().to_string(),
            },
        ])
        .unwrap();

        let repo_root = path_to_string(&fs::canonicalize(&repo).unwrap_or(repo.clone()));
        let detected = repos
            .iter()
            .find(|item| item.repo_root == repo_root || Path::new(&item.repo_root) == repo)
            .expect("target repo should be detected");
        assert!(detected.root_ids.contains(&"repo".to_string()));
        assert!(detected.root_ids.contains(&"app".to_string()));
    }

    #[test]
    fn detects_child_git_roots_under_plain_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let app = workspace.join("app");
        let service = workspace.join("service");
        fs::create_dir_all(app.join(".git")).unwrap();
        fs::create_dir_all(service.join(".git")).unwrap();
        fs::create_dir_all(workspace.join("node_modules/ignored/.git")).unwrap();

        let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
            id: "workspace".into(),
            name: "workspace".into(),
            path: workspace.to_string_lossy().to_string(),
        }])
        .unwrap();

        let app_canon = fs::canonicalize(&app).unwrap_or(app.clone());
        let service_canon = fs::canonicalize(&service).unwrap_or(service.clone());
        let workspace_canon = fs::canonicalize(&workspace).unwrap_or(workspace.clone());
        let repo_roots: Vec<_> = repos
            .iter()
            .map(|item| PathBuf::from(&item.repo_root))
            .collect();
        assert!(repo_roots.iter().any(|root| {
            root == &app || root == &app_canon || path_to_string(root) == path_to_string(&app_canon)
        }));
        assert!(repo_roots.iter().any(|root| {
            root == &service
                || root == &service_canon
                || path_to_string(root) == path_to_string(&service_canon)
        }));
        assert!(
            !repos
                .iter()
                .any(|item| item.repo_root.contains("node_modules"))
        );
        assert_eq!(
            repo_roots
                .iter()
                .filter(|root| root.starts_with(&workspace) || root.starts_with(&workspace_canon))
                .count(),
            2
        );
    }

    #[test]
    fn marks_git_file_roots_as_submodules() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let submodule = workspace.join("vendor/lib");
        fs::create_dir_all(&submodule).unwrap();
        fs::write(
            submodule.join(".git"),
            "gitdir: ../../.git/modules/vendor/lib\n",
        )
        .unwrap();

        let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
            id: "workspace".into(),
            name: "workspace".into(),
            path: workspace.to_string_lossy().to_string(),
        }])
        .unwrap();

        let submodule_canon = fs::canonicalize(&submodule).unwrap_or(submodule.clone());
        let detected = repos
            .iter()
            .find(|item| {
                let root = Path::new(&item.repo_root);
                root == submodule
                    || root == submodule_canon
                    || item.repo_root == path_to_string(&submodule_canon)
            })
            .expect("submodule should be detected");
        assert!(detected.is_submodule);
    }

    #[test]
    fn rejects_dot_git_deletes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "x").unwrap();

        let err = workspace_delete_path(
            dir.path().to_string_lossy().to_string(),
            ".git/config".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn detects_package_cargo_and_make_tasks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        fs::write(dir.path().join("Cargo.toml"), "[package]\nname='demo'").unwrap();
        fs::write(
            dir.path().join("Makefile"),
            "build:\n\t@echo build\n.PHONY: build\ninvalid target: ignored\n",
        )
        .unwrap();

        let tasks = detect_workspace_tasks(dir.path(), None).unwrap();
        assert!(tasks.iter().any(|task| {
            task.source == "package.json" && task.label == "dev" && task.command == "pnpm run dev"
        }));
        assert!(tasks.iter().any(|task| {
            task.source == "Cargo.toml" && task.label == "clippy" && task.command == "cargo clippy"
        }));
        assert!(tasks.iter().any(|task| {
            task.source == "Makefile" && task.label == "build" && task.command == "make build"
        }));
        assert!(!tasks.iter().any(|task| task.label == "invalid target"));
    }

    #[test]
    fn detects_go_gradle_maven_and_python_tasks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("go.mod"), "module example.com/demo").unwrap();
        fs::write(dir.path().join("build.gradle.kts"), "plugins {}").unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        fs::write(
            dir.path().join("pyproject.toml"),
            "[project.scripts]\nserve = 'demo:main'\n[tool.poetry.scripts]\nworker = 'demo:worker'\n",
        )
        .unwrap();
        fs::write(dir.path().join("uv.lock"), "version = 1").unwrap();

        let tasks = detect_workspace_tasks(dir.path(), None).unwrap();
        for command in [
            "go test ./...",
            "gradle build",
            "mvn package",
            "uv run serve",
            "uv run worker",
        ] {
            assert!(
                tasks.iter().any(|task| task.command == command),
                "missing {command}"
            );
        }
    }

    #[test]
    fn parses_maven_dependency_tree_with_nesting_and_scopes() {
        let output = "\
[INFO] com.example:demo:jar:1.0.0
[INFO] +- org.springframework:spring-core:jar:5.3.0:compile
[INFO] |  \\- org.springframework:spring-jcl:jar:5.3.0:compile
[INFO] \\- junit:junit:jar:4.13:test
[INFO]    \\- org.hamcrest:hamcrest-core:jar:1.3:test
";
        let tree = parse_maven_dependency_tree(output);
        // Root project's direct deps become the forest.
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].artifact, "spring-core");
        assert_eq!(tree[0].scope, "compile");
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].artifact, "spring-jcl");
        assert_eq!(tree[1].artifact, "junit");
        assert_eq!(tree[1].scope, "test");
        assert_eq!(tree[1].children[0].artifact, "hamcrest-core");
        assert!(tree.iter().all(|node| node.conflict.is_none()));
    }

    #[test]
    fn parses_maven_verbose_conflict_marker() {
        let output = "\
[INFO] com.example:demo:jar:1.0.0
[INFO] +- a:one:jar:1.0:compile
[INFO] \\- b:two:jar:2.0:compile (omitted for conflict with 3.0)
";
        let tree = parse_maven_dependency_tree(output);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[1].artifact, "two");
        assert_eq!(
            tree[1].conflict.as_deref(),
            Some("(omitted for conflict with 3.0)")
        );
    }

    #[test]
    fn parses_gradle_dependencies_with_arbitration() {
        let output = "\
runtimeClasspath - Runtime classpath of source set 'main'.
+--- org.springframework:spring-core:5.3.0
|    \\--- org.springframework:spring-jcl:5.3.0
\\--- com.google.guava:guava:30.0 -> 31.0 (*)
";
        let tree = parse_gradle_dependencies(output);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].artifact, "spring-core");
        assert_eq!(tree[0].version, "5.3.0");
        assert_eq!(tree[0].children[0].artifact, "spring-jcl");
        // Arbitration: resolved version wins, conflict note records the bump.
        assert_eq!(tree[1].artifact, "guava");
        assert_eq!(tree[1].version, "31.0");
        assert_eq!(
            tree[1].conflict.as_deref(),
            Some("com.google.guava:guava:30.0 -> 31.0")
        );
    }

    #[test]
    fn dependency_parsers_tolerate_empty_and_noise() {
        assert!(parse_maven_dependency_tree("").is_empty());
        assert!(parse_gradle_dependencies("No dependencies\n").is_empty());
        assert!(parse_maven_dependency_tree("[INFO] Scanning for projects...\n").is_empty());
    }

    #[test]
    fn task_tree_groups_by_source_with_full_maven_and_gradle_lifecycles() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();

        let groups = build_workspace_task_tree(dir.path(), None).unwrap();
        let find = |source: &str| groups.iter().find(|group| group.source == source);

        // Maven carries the full lifecycle (not just the Run-tab package/test subset).
        let maven = find("Maven").expect("Maven group");
        for phase in ["clean", "compile", "package", "verify", "install"] {
            assert!(
                maven.tasks.iter().any(|task| task.label == phase),
                "Maven lifecycle missing {phase}"
            );
        }
        // Gradle carries the common tasks.
        let gradle = find("Gradle").expect("Gradle group");
        for task in ["clean", "build", "assemble", "check"] {
            assert!(
                gradle.tasks.iter().any(|entry| entry.label == task),
                "Gradle tasks missing {task}"
            );
        }
        // Other ecosystems still group their detected tasks.
        let npm = find("package.json").expect("package.json group");
        assert!(npm.tasks.iter().any(|task| task.label == "dev"));
        assert!(npm.tasks.iter().any(|task| task.label == "test"));

        // No duplicate labels within a group (enrichment vs detection overlap).
        for group in &groups {
            let mut labels: Vec<&str> =
                group.tasks.iter().map(|task| task.label.as_str()).collect();
            let count = labels.len();
            labels.sort_unstable();
            labels.dedup();
            assert_eq!(labels.len(), count, "duplicate label in {}", group.source);
        }
    }

    #[test]
    fn discovers_plain_java_main_without_debug_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let source_dir = dir.path().join("src/com/example");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join("App.java"),
            r#"
                package com.example;
                // public static void main(String[] ignored) {}
                public class App {
                    String example = "static void main(String[] fake)";
                    public static void main(final String[] args) {
                        System.out.println("ok");
                    }
                }
            "#,
        )
        .unwrap();

        let target = workspace_java_run_target(
            dir.path().to_string_lossy().into_owned(),
            "src/com/example/App.java".into(),
            None,
        )
        .unwrap();
        assert_eq!(target.main_class, "com.example.App");
        assert_eq!(target.build_system, "source-file");
        assert!(target.command.starts_with("java "));
        assert!(target.command.contains("App.java"));
        assert_eq!(target.module_path, ".");
    }

    #[test]
    fn rejects_java_file_with_main_only_in_comments_or_strings() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("Example.java"),
            r#"
                /** public static void main(String[] args) {} */
                class Example {
                    String sample = "public static void main(String[] args)";
                }
            "#,
        )
        .unwrap();

        let error = workspace_java_run_target(
            dir.path().to_string_lossy().into_owned(),
            "Example.java".into(),
            None,
        )
        .unwrap_err();
        assert!(error.contains("No `static void main"));
    }

    #[test]
    fn builds_maven_main_command_with_project_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
        let source_dir = dir.path().join("src/main/java/demo");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join("Main.java"),
            "package demo; class Main { public static void main(String... args) {} }",
        )
        .unwrap();

        let target =
            java_run_target_for_path(dir.path(), &source_dir.join("Main.java"), None).unwrap();
        assert_eq!(target.build_system, "maven");
        assert_eq!(target.main_class, "demo.Main");
        assert_eq!(target.cwd, path_to_string(dir.path()));
        assert!(target.command.contains("mvnw"));
        assert_eq!(target.execution.source, "wrapper");
        assert!(target.execution.executable.contains("mvnw"));
        assert!(target.execution.error.is_none());
        // PowerShell splits `-Dexec.mainClass='demo.Main'` at the property-name
        // dot. Quoting the whole Maven property keeps it a single argument.
        assert!(target.command.contains("'-Dexec.mainClass=demo.Main'"));
        assert!(
            target
                .command
                .contains("'-Dexec.cleanupDaemonThreads=false'")
        );
        assert_eq!(target.execution.args[2], "-Dexec.mainClass=demo.Main");
        assert_eq!(
            target.execution.args[3],
            "-Dexec.cleanupDaemonThreads=false"
        );
        assert!(target.command.contains("exec-maven-plugin:3.5.0:java"));
    }

    #[test]
    fn applies_maven_run_jvm_options_through_task_environment() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("pom.xml"),
            r#"
                <project>
                  <build><plugins><plugin><configuration>
                    <argLine>
                      @{argLine}
                      --add-exports java.base/sun.nio.ch=ALL-UNNAMED
                      --add-opens=java.base/java.lang.reflect=ALL-UNNAMED
                      --enable-native-access=ALL-UNNAMED
                      -javaagent:should-not-be-inherited.jar
                      -Xmx512m
                      --add-reads -Xms256m
                    </argLine>
                    <!-- <argLine>--add-opens=java.base/java.net=ALL-UNNAMED</argLine> -->
                  </configuration></plugin></plugins></build>
                </project>
            "#,
        )
        .unwrap();
        fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
        let module = dir.path().join("server");
        let source_dir = module.join("src/main/java/demo");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(module.join("pom.xml"), "<project />").unwrap();
        fs::write(
            source_dir.join("Main.java"),
            "package demo; class Main { public static void main(String... args) {} }",
        )
        .unwrap();

        let target = java_run_target_for_path(
            dir.path(),
            &source_dir.join("Main.java"),
            Some(&WorkspaceToolConfig {
                maven_jvm_args: vec![
                    "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into(),
                    "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED".into(),
                ],
                ..WorkspaceToolConfig::default()
            }),
        )
        .unwrap();
        let maven_opts = &target.environment.unwrap()["MAVEN_OPTS"];
        assert_eq!(maven_opts.mode, "append");
        assert_eq!(
            maven_opts.value,
            "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED \
             --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
             --enable-native-access=ALL-UNNAMED \
             --add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
        );
        assert!(!maven_opts.value.contains("-javaagent"));
        assert!(!maven_opts.value.contains("-Xmx"));
        assert!(!maven_opts.value.contains("java.net"));
    }

    #[test]
    fn can_disable_maven_arg_line_inheritance() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("pom.xml"),
            "<project><argLine>--add-opens=java.base/java.io=ALL-UNNAMED</argLine></project>",
        )
        .unwrap();
        let source_dir = dir.path().join("src/main/java/demo");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join("Main.java"),
            "package demo; class Main { public static void main(String... args) {} }",
        )
        .unwrap();

        let target = java_run_target_for_path(
            dir.path(),
            &source_dir.join("Main.java"),
            Some(&WorkspaceToolConfig {
                maven_jvm_args: vec!["--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into()],
                inherit_maven_arg_line: Some(false),
                ..WorkspaceToolConfig::default()
            }),
        )
        .unwrap();
        assert_eq!(
            target.environment.unwrap()["MAVEN_OPTS"].value,
            "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
        );
    }

    #[test]
    fn builds_gradle_subproject_main_command_and_module_tasks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.gradle"), "include 'app'").unwrap();
        fs::write(dir.path().join("build.gradle"), "plugins { id 'base' }").unwrap();
        fs::write(dir.path().join("gradlew"), "#!/bin/sh").unwrap();
        fs::create_dir_all(dir.path().join("app/src/main/java/demo")).unwrap();
        fs::write(dir.path().join("app/build.gradle"), "plugins { id 'java' }").unwrap();
        let source = dir.path().join("app/src/main/java/demo/App.java");
        fs::write(
            &source,
            "package demo; class App { static void main(String args[]) {} }",
        )
        .unwrap();

        let target = java_run_target_for_path(dir.path(), &source, None).unwrap();
        assert_eq!(target.build_system, "gradle");
        assert_eq!(target.module_path, "app");
        assert_eq!(target.cwd, path_to_string(dir.path()));
        assert!(target.command.contains(":app:taomniRun"));
        assert!(target.command.contains("-PtaomniMainClass='demo.App'"));
        assert!(target.command.contains("java-run.init.gradle"));

        let groups = build_workspace_task_tree(dir.path(), None).unwrap();
        let gradle = groups
            .iter()
            .find(|group| group.source == "Gradle")
            .unwrap();
        let module_compile = gradle
            .tasks
            .iter()
            .find(|task| task.module_path.as_deref() == Some("app") && task.label == "classes")
            .unwrap();
        assert!(module_compile.command.contains(":app:classes"));
        assert!(module_compile.command.contains("gradlew"));
    }

    #[test]
    fn java_target_scan_skips_test_sources() {
        let dir = tempfile::tempdir().unwrap();
        for (folder, name) in [
            ("src/main/java/demo", "App"),
            ("src/test/java/demo", "FixtureMain"),
        ] {
            let source_dir = dir.path().join(folder);
            fs::create_dir_all(&source_dir).unwrap();
            fs::write(
                source_dir.join(format!("{name}.java")),
                format!(
                    "package demo; class {name} {{ public static void main(String[] args) {{}} }}"
                ),
            )
            .unwrap();
        }
        let targets = detect_java_run_targets(dir.path(), None).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].main_class, "demo.App");
    }

    // ---- Cross-platform tool resolution (M11 build/run robustness) ----
    //
    // These tests inject `HostPlatform` and `PATH` explicitly so the Windows
    // `.cmd`/`.bat` resolution and launch planning are exercised on non-Windows
    // CI too (the production entry points use `HostPlatform::current()`).

    #[test]
    fn resolves_windows_batch_wrapper_before_configured_or_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        fs::write(dir.path().join("mvnw.cmd"), "@echo off").unwrap();
        let config = WorkspaceToolConfig {
            maven: Some("C:/tools/mvn.cmd".into()),
            gradle: None,
            ..WorkspaceToolConfig::default()
        };
        let resolution = resolve_build_tool_with_path(
            dir.path(),
            dir.path(),
            BuildTool::Maven,
            Some(&config),
            HostPlatform::Windows,
            None,
        );
        assert_eq!(resolution.source, ToolSource::Wrapper);
        assert!(resolution.available);
        assert!(resolution.executable.ends_with("mvnw.cmd"));
        // PowerShell call operator + absolute path (never the fragile bare `.\mvnw.cmd`).
        let runner = resolution.task_runner(HostPlatform::Windows);
        assert!(runner.starts_with("& '"));
        assert!(runner.contains("mvnw.cmd"));
    }

    #[test]
    fn walks_up_to_find_wrapper_in_monorepo() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
        let module = dir.path().join("services/api");
        fs::create_dir_all(&module).unwrap();
        let resolution = resolve_build_tool_with_path(
            &module,
            dir.path(),
            BuildTool::Maven,
            None,
            HostPlatform::Unix,
            None,
        );
        assert_eq!(resolution.source, ToolSource::Wrapper);
        assert!(resolution.executable.ends_with("mvnw"));
    }

    #[test]
    fn falls_back_to_configured_executable_then_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        let mvn = dir.path().join("custom-mvn");
        fs::write(&mvn, "#!/bin/sh").unwrap();

        // A configured path with a directory separator resolves relative to the
        // workspace root; a bare name (no separator) is a PATH lookup instead.
        let config = WorkspaceToolConfig {
            maven: Some("./custom-mvn".into()),
            gradle: None,
            ..WorkspaceToolConfig::default()
        };
        let resolution = resolve_build_tool_with_path(
            dir.path(),
            dir.path(),
            BuildTool::Maven,
            Some(&config),
            HostPlatform::Unix,
            None,
        );
        assert_eq!(resolution.source, ToolSource::Configured);
        assert!(resolution.available);
        assert_eq!(resolution.executable, fs::canonicalize(&mvn).unwrap_or(mvn));

        // A configured executable that does not exist yields a clear diagnostic
        // rather than a shell "not recognized" error at run time.
        let missing = WorkspaceToolConfig {
            maven: Some("nope-not-here".into()),
            gradle: None,
            ..WorkspaceToolConfig::default()
        };
        let resolution = resolve_build_tool_with_path(
            dir.path(),
            dir.path(),
            BuildTool::Maven,
            Some(&missing),
            HostPlatform::Unix,
            None,
        );
        assert_eq!(resolution.source, ToolSource::Configured);
        assert!(!resolution.available);
        assert!(resolution.require_available().is_err());
        assert!(
            resolution
                .diagnostic
                .as_deref()
                .unwrap()
                .contains("nope-not-here")
        );
    }

    #[test]
    fn reports_missing_tool_when_no_wrapper_config_or_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();
        let resolution = resolve_build_tool_with_path(
            dir.path(),
            dir.path(),
            BuildTool::Gradle,
            None,
            HostPlatform::Unix,
            None,
        );
        assert_eq!(resolution.source, ToolSource::Path);
        assert!(!resolution.available);
        let error = resolution.require_available().unwrap_err();
        assert!(error.contains("Gradle"));
        assert!(error.contains("gradlew"));
    }

    #[test]
    fn plans_windows_batch_launch_via_cmd_exe() {
        let plan = plan_tool_launch(
            Path::new(r"C:\proj\mvnw.cmd"),
            &["-B".into(), "dependency:tree".into()],
            HostPlatform::Windows,
        );
        assert_eq!(plan.program, "cmd.exe");
        assert_eq!(plan.args[0], "/D");
        assert_eq!(plan.args[1], "/S");
        assert_eq!(plan.args[2], "/C");
        // The whole command line is one argument, wrapper quoted, args appended.
        assert!(plan.args[3].contains(r"C:\proj\mvnw.cmd"));
        assert!(plan.args[3].contains("dependency:tree"));
    }

    #[test]
    fn plans_direct_launch_for_plain_executable() {
        let plan = plan_tool_launch(
            Path::new("/usr/bin/gradle"),
            &["dependencies".into()],
            HostPlatform::Unix,
        );
        assert_eq!(plan.program, "/usr/bin/gradle");
        assert_eq!(plan.args, vec!["dependencies".to_string()]);
    }

    #[test]
    fn build_task_tree_surfaces_missing_tool_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        // No wrapper, no config; PATH lookup disabled → execution carries the error.
        let resolution = resolve_build_tool_with_path(
            dir.path(),
            dir.path(),
            BuildTool::Maven,
            None,
            HostPlatform::Unix,
            None,
        );
        let execution = resolution.execution(&["package"]);
        assert_eq!(execution.args, vec!["package".to_string()]);
        assert!(execution.error.is_some());
    }
}
