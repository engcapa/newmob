//! Structured multi-language Build/Run/Debug discovery for Code Workspace.
//!
//! Providers in this module are deliberately evidence-driven: a manifest owns a
//! project, commands are represented as argv rather than shell fragments, and a
//! debug configuration is enabled only when its adapter can be resolved.

use crate::workspace::WorkspaceToolConfig;
use ignore::{DirEntry, WalkBuilder};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_MANIFEST_DEPTH: usize = 8;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub display: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub id: String,
    pub label: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub install_hint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModel {
    pub id: String,
    pub provider: String,
    pub root: String,
    pub manifest: String,
    pub module: String,
    pub languages: Vec<String>,
    pub toolchain: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildTarget {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub kind: String,
    pub command: ExecutionCommand,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunConfiguration {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub kind: String,
    pub command: ExecutionCommand,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    pub pre_launch_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_configuration_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfiguration {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub adapter_id: String,
    pub request: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    pub pre_launch_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    pub launch_config: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExecutionModel {
    pub projects: Vec<ProjectModel>,
    pub build_targets: Vec<BuildTarget>,
    pub run_configurations: Vec<RunConfiguration>,
    pub debug_configurations: Vec<DebugConfiguration>,
    pub tools: Vec<ToolProbe>,
}

#[derive(Default)]
struct ModelBuilder {
    projects: Vec<ProjectModel>,
    build_targets: Vec<BuildTarget>,
    run_configurations: Vec<RunConfiguration>,
    debug_configurations: Vec<DebugConfiguration>,
    tools: BTreeMap<String, ToolProbe>,
}

impl ModelBuilder {
    fn finish(mut self) -> WorkspaceExecutionModel {
        self.projects.sort_by(|a, b| a.id.cmp(&b.id));
        self.build_targets.sort_by(|a, b| a.id.cmp(&b.id));
        self.run_configurations.sort_by(|a, b| a.id.cmp(&b.id));
        self.debug_configurations.sort_by(|a, b| a.id.cmp(&b.id));
        WorkspaceExecutionModel {
            projects: self.projects,
            build_targets: self.build_targets,
            run_configurations: self.run_configurations,
            debug_configurations: self.debug_configurations,
            tools: self.tools.into_values().collect(),
        }
    }

    fn tool(
        &mut self,
        root: &Path,
        config: Option<&WorkspaceToolConfig>,
        id: &str,
        label: &str,
        wrappers: &[&str],
        candidates: &[&str],
        install_hint: &str,
    ) -> ToolProbe {
        let cache_key = format!("{}\0{}", path_string(root), id);
        if let Some(existing) = self.tools.get(&cache_key) {
            return existing.clone();
        }
        let configured = configured_tool(config, id);
        let probe = resolve_tool(
            root,
            id,
            label,
            configured,
            wrappers,
            candidates,
            install_hint,
        );
        self.tools.insert(cache_key, probe.clone());
        probe
    }

    fn project(
        &mut self,
        provider: &str,
        manifest: &Path,
        languages: &[&str],
        toolchain: &str,
    ) -> ProjectModel {
        let root = manifest.parent().unwrap_or(manifest);
        let project = ProjectModel {
            id: stable_id("project", &[provider, &path_string(manifest)]),
            provider: provider.to_string(),
            root: path_string(root),
            manifest: path_string(manifest),
            module: root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("project")
                .to_string(),
            languages: languages.iter().map(|value| (*value).to_string()).collect(),
            toolchain: toolchain.to_string(),
            diagnostics: Vec::new(),
        };
        self.projects.push(project.clone());
        project
    }

    fn build(
        &mut self,
        project: &ProjectModel,
        label: &str,
        kind: &str,
        command: ExecutionCommand,
    ) -> String {
        let id = stable_id("build", &[&project.id, kind, label]);
        self.build_targets.push(BuildTarget {
            id: id.clone(),
            project_id: project.id.clone(),
            label: label.to_string(),
            kind: kind.to_string(),
            command,
            depends_on: Vec::new(),
        });
        id
    }

    fn debug(
        &mut self,
        project: &ProjectModel,
        label: &str,
        adapter_id: &str,
        adapter: &ToolProbe,
        pre_launch_targets: Vec<String>,
        source_file: Option<String>,
        arguments: Value,
        mode: Option<Value>,
    ) -> String {
        let id = stable_id("debug", &[&project.id, adapter_id, label]);
        let diagnostic = if adapter.state == "available" {
            None
        } else {
            Some(format!(
                "{} is unavailable. {}",
                adapter.label, adapter.install_hint
            ))
        };
        let mut launch_config = json!({
            "adapterCommand": adapter.executable,
            "adapterCwd": project.root,
            "request": "launch",
            "arguments": arguments,
        });
        if let Some(mode) = mode {
            launch_config["mode"] = mode;
        }
        self.debug_configurations.push(DebugConfiguration {
            id: id.clone(),
            project_id: project.id.clone(),
            label: label.to_string(),
            adapter_id: adapter_id.to_string(),
            request: "launch".to_string(),
            available: diagnostic.is_none(),
            diagnostic,
            pre_launch_targets,
            source_file,
            launch_config,
        });
        id
    }

    fn run(
        &mut self,
        project: &ProjectModel,
        label: &str,
        kind: &str,
        command: ExecutionCommand,
        source_file: Option<String>,
        pre_launch_targets: Vec<String>,
        debug_configuration_id: Option<String>,
    ) {
        self.run_configurations.push(RunConfiguration {
            id: stable_id(
                "run",
                &[
                    &project.id,
                    kind,
                    label,
                    source_file.as_deref().unwrap_or(""),
                ],
            ),
            project_id: project.id.clone(),
            label: label.to_string(),
            kind: kind.to_string(),
            command,
            source_file,
            pre_launch_targets,
            debug_configuration_id,
        });
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hex::encode(hasher.finalize());
    format!("{prefix}:{}", &digest[..16])
}

fn configured_tool<'a>(config: Option<&'a WorkspaceToolConfig>, id: &str) -> Option<&'a str> {
    let config = config?;
    let value = match id {
        "maven" => config.maven.as_deref(),
        "gradle" => config.gradle.as_deref(),
        "cargo" => config.cargo.as_deref(),
        "go" => config.go.as_deref(),
        "node" => config.node.as_deref(),
        "npm" => config.npm.as_deref(),
        "pnpm" => config.pnpm.as_deref(),
        "yarn" => config.yarn.as_deref(),
        "python" => config.python.as_deref(),
        "uv" => config.uv.as_deref(),
        "poetry" => config.poetry.as_deref(),
        "cmake" => config.cmake.as_deref(),
        "dotnet" => config.dotnet.as_deref(),
        "sbt" => config.sbt.as_deref(),
        "swift" => config.swift.as_deref(),
        "lldb-dap" => config.lldb_dap.as_deref(),
        "delve" => config.delve.as_deref(),
        "debugpy" => config.debugpy.as_deref(),
        "js-debug" => config.js_debug.as_deref(),
        "netcoredbg" => config.netcoredbg.as_deref(),
        _ => None,
    };
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn resolve_candidate(candidate: &str) -> Option<PathBuf> {
    let path = Path::new(candidate);
    if path.is_absolute() || candidate.contains('/') || candidate.contains('\\') {
        path.is_file().then(|| path.to_path_buf())
    } else {
        which::which(candidate).ok()
    }
}

fn resolve_tool(
    root: &Path,
    id: &str,
    label: &str,
    configured: Option<&str>,
    wrappers: &[&str],
    candidates: &[&str],
    install_hint: &str,
) -> ToolProbe {
    for wrapper in wrappers {
        let path = root.join(wrapper);
        if path.is_file() {
            return ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "available".to_string(),
                executable: Some(path_string(&path)),
                source: Some("wrapper".to_string()),
                install_hint: install_hint.to_string(),
            };
        }
    }
    if let Some(configured) = configured {
        return match resolve_candidate(configured) {
            Some(path) => ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "available".to_string(),
                executable: Some(path_string(&path)),
                source: Some("configured".to_string()),
                install_hint: install_hint.to_string(),
            },
            None => ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "missing".to_string(),
                executable: Some(configured.to_string()),
                source: Some("configured".to_string()),
                install_hint: format!(
                    "Configured executable `{configured}` was not found. {install_hint}"
                ),
            },
        };
    }
    for candidate in candidates {
        if let Some(path) = resolve_candidate(candidate) {
            return ToolProbe {
                id: id.to_string(),
                label: label.to_string(),
                state: "available".to_string(),
                executable: Some(path_string(&path)),
                source: Some("path".to_string()),
                install_hint: install_hint.to_string(),
            };
        }
    }
    ToolProbe {
        id: id.to_string(),
        label: label.to_string(),
        state: "missing".to_string(),
        executable: candidates.first().map(|value| (*value).to_string()),
        source: None,
        install_hint: install_hint.to_string(),
    }
}

fn shell_preview(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_+-./:=@\\".contains(ch))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn command(tool: &ToolProbe, args: Vec<String>, cwd: &Path) -> ExecutionCommand {
    let executable = tool.executable.clone().unwrap_or_else(|| tool.id.clone());
    let display = std::iter::once(shell_preview(&executable))
        .chain(args.iter().map(|arg| shell_preview(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    ExecutionCommand {
        executable,
        args,
        cwd: path_string(cwd),
        env: BTreeMap::new(),
        display,
        source: tool.source.clone().unwrap_or_else(|| "path".to_string()),
        error: (tool.state != "available")
            .then(|| format!("{} is unavailable. {}", tool.label, tool.install_hint)),
    }
}

fn manifest_entry(entry: &DirEntry) -> bool {
    if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
        return true;
    }
    !matches!(
        entry.file_name().to_string_lossy().as_ref(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | ".gradle"
            | ".idea"
    )
}

fn discover_manifests(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut manifests = Vec::new();
    for result in WalkBuilder::new(root)
        .max_depth(Some(MAX_MANIFEST_DEPTH))
        .hidden(false)
        .filter_entry(manifest_entry)
        .build()
    {
        let entry = result.map_err(|error| format!("scan {}: {error}", root.display()))?;
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if matches!(
            name.as_ref(),
            "Cargo.toml"
                | "go.mod"
                | "package.json"
                | "pyproject.toml"
                | "CMakeLists.txt"
                | "pom.xml"
                | "build.gradle"
                | "build.gradle.kts"
                | "build.sbt"
                | "Package.swift"
        ) || name.ends_with(".csproj")
        {
            manifests.push(entry.into_path());
        }
    }
    manifests.sort();
    Ok(manifests)
}

fn read_text(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "{} exceeds the 2 MiB discovery limit",
            path.display()
        ));
    }
    fs::read_to_string(path).map_err(|error| format!("read {}: {error}", path.display()))
}

fn active_in_project(
    active_file: Option<&Path>,
    project_root: &Path,
    extensions: &[&str],
) -> Option<PathBuf> {
    let active = active_file?;
    if !active.starts_with(project_root) {
        return None;
    }
    let extension = active.extension()?.to_str()?.to_ascii_lowercase();
    extensions
        .contains(&extension.as_str())
        .then(|| active.to_path_buf())
}

fn add_common_builds(
    builder: &mut ModelBuilder,
    project: &ProjectModel,
    tool: &ToolProbe,
    tasks: &[(&str, &str, &[&str])],
) -> BTreeMap<String, String> {
    let root = Path::new(&project.root);
    let mut ids = BTreeMap::new();
    for (label, kind, args) in tasks {
        let id = builder.build(
            project,
            label,
            kind,
            command(
                tool,
                args.iter().map(|value| (*value).to_string()).collect(),
                root,
            ),
        );
        ids.insert((*kind).to_string(), id);
    }
    ids
}

fn add_cargo(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let parsed: toml::Value = toml::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", manifest.display()))?;
    if parsed.get("package").is_none() {
        return Ok(());
    }
    let root = manifest.parent().unwrap_or(manifest);
    let package = parsed
        .get("package")
        .and_then(|value| value.get("name"))
        .and_then(toml::Value::as_str)
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("package")
        });
    let project = builder.project("cargo", manifest, &["rust"], "cargo");
    let cargo = builder.tool(
        root,
        config,
        "cargo",
        "Cargo",
        &[],
        &["cargo"],
        "Install Rust with rustup, or configure the Cargo executable for this workspace.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &cargo,
        &[
            (
                "Check",
                "check",
                &["check", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Build",
                "build",
                &["build", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Test",
                "test",
                &["test", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Clippy",
                "check",
                &["clippy", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
            (
                "Clean",
                "clean",
                &["clean", "--manifest-path", manifest.to_str().unwrap_or("")],
            ),
        ],
    );
    let lldb = builder.tool(
        root,
        config,
        "lldb-dap",
        "LLDB DAP",
        &[],
        &["lldb-dap"],
        "Install lldb-dap (or configure Code Workspace to use its executable).",
    );
    let mut bins = Vec::<(String, Option<PathBuf>, String)>::new();
    if root.join("src/main.rs").is_file() {
        bins.push((
            package.to_string(),
            Some(root.join("src/main.rs")),
            "bin".to_string(),
        ));
    }
    if let Some(entries) = parsed.get("bin").and_then(toml::Value::as_array) {
        for entry in entries {
            let Some(name) = entry.get("name").and_then(toml::Value::as_str) else {
                continue;
            };
            let source = entry
                .get("path")
                .and_then(toml::Value::as_str)
                .map(|path| root.join(path));
            bins.push((name.to_string(), source, "bin".to_string()));
        }
    }
    let examples = root.join("examples");
    if let Ok(entries) = fs::read_dir(&examples) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("rs") {
                if let Some(name) = path.file_stem().and_then(|value| value.to_str()) {
                    bins.push((name.to_string(), Some(path), "example".to_string()));
                }
            }
        }
    }
    bins.sort_by(|a, b| a.0.cmp(&b.0));
    bins.dedup_by(|a, b| a.0 == b.0 && a.2 == b.2);
    for (name, source, target_kind) in bins {
        let selector = if target_kind == "example" {
            "--example"
        } else {
            "--bin"
        };
        let args = vec![
            "run".to_string(),
            "--manifest-path".to_string(),
            path_string(manifest),
            selector.to_string(),
            name.clone(),
            "--".to_string(),
        ];
        let source_file = source.as_ref().map(|path| path_string(path));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {name}"),
            "lldb",
            &lldb,
            builds.get("build").cloned().into_iter().collect(),
            source_file.clone(),
            json!({ "name": name, "request": "launch", "cwd": project.root, "args": [] }),
            Some(json!({
                "kind": "cargo",
                "command": cargo.executable,
                "args": ["build", "--manifest-path", path_string(manifest), selector, name, "--message-format=json"],
                "targetName": name,
            })),
        );
        builder.run(
            &project,
            &format!("Run {name}"),
            target_kind.as_str(),
            command(&cargo, args, root),
            source_file,
            builds.get("build").cloned().into_iter().collect(),
            Some(debug_id),
        );
    }
    if let Some(active) = active_in_project(active_file, root, &["rs"]) {
        if !builder
            .run_configurations
            .iter()
            .any(|config| config.source_file.as_deref() == Some(path_string(&active).as_str()))
        {
            // Library-only Rust files are buildable but not independently runnable.
        }
    }
    Ok(())
}

fn go_main_regex() -> &'static Regex {
    static MAIN: OnceLock<Regex> = OnceLock::new();
    MAIN.get_or_init(|| {
        Regex::new(r"(?s)\bpackage\s+main\b.*\bfunc\s+main\s*\(").expect("valid Go main regex")
    })
}

fn source_directories(root: &Path, extension: &str, marker: &Regex) -> Vec<(PathBuf, PathBuf)> {
    let mut found = BTreeMap::<PathBuf, PathBuf>::new();
    for entry in WalkBuilder::new(root)
        .max_depth(Some(MAX_MANIFEST_DEPTH))
        .hidden(false)
        .filter_entry(manifest_entry)
        .build()
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some(extension) {
            continue;
        }
        let Ok(text) = read_text(path) else { continue };
        if marker.is_match(&text) {
            if let Some(parent) = path.parent() {
                found
                    .entry(parent.to_path_buf())
                    .or_insert_with(|| path.to_path_buf());
            }
        }
    }
    found.into_iter().collect()
}

fn add_go(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("go", manifest, &["go"], "go");
    let go = builder.tool(
        root,
        config,
        "go",
        "Go",
        &[],
        &["go"],
        "Install the Go toolchain, or configure its executable for this workspace.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &go,
        &[
            ("Build all packages", "build", &["build", "./..."]),
            ("Test all packages", "test", &["test", "./..."]),
            ("Vet all packages", "check", &["vet", "./..."]),
            ("Clean build cache", "clean", &["clean"]),
        ],
    );
    let delve = builder.tool(
        root,
        config,
        "delve",
        "Delve DAP",
        &[],
        &["dlv"],
        "Install Delve with `go install github.com/go-delve/delve/cmd/dlv@latest`.",
    );
    for (directory, source) in source_directories(root, "go", go_main_regex()) {
        let relative = directory.strip_prefix(root).unwrap_or(&directory);
        let package = if relative.as_os_str().is_empty() {
            ".".to_string()
        } else {
            format!("./{}", relative.to_string_lossy().replace('\\', "/"))
        };
        let label = if package == "." {
            project.module.clone()
        } else {
            package.clone()
        };
        let source_file = Some(path_string(&source));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {label}"),
            "delve",
            &delve,
            builds.get("build").cloned().into_iter().collect(),
            source_file.clone(),
            json!({ "name": label, "type": "go", "request": "launch", "mode": "debug", "program": path_string(&directory), "cwd": project.root, "args": [] }),
            Some(json!({ "kind": "managedTcp", "args": ["dap", "--listen=127.0.0.1:${port}", "--log=false"] })),
        );
        builder.run(
            &project,
            &format!("Run {label}"),
            "main-package",
            command(
                &go,
                vec!["run".to_string(), package, "--".to_string()],
                root,
            ),
            source_file,
            builds.get("build").cloned().into_iter().collect(),
            Some(debug_id),
        );
    }
    if let Some(active) = active_in_project(active_file, root, &["go"]) {
        if !builder
            .run_configurations
            .iter()
            .any(|item| item.source_file.as_deref() == Some(path_string(&active).as_str()))
        {
            let command = command(
                &go,
                vec!["run".to_string(), path_string(&active), "--".to_string()],
                root,
            );
            builder.run(
                &project,
                &format!(
                    "Run {}",
                    active.file_name().unwrap_or_default().to_string_lossy()
                ),
                "file",
                command,
                Some(path_string(&active)),
                Vec::new(),
                None,
            );
        }
    }
    Ok(())
}

fn package_manager(
    builder: &mut ModelBuilder,
    root: &Path,
    config: Option<&WorkspaceToolConfig>,
) -> ToolProbe {
    if root.join("pnpm-lock.yaml").is_file() {
        builder.tool(
            root,
            config,
            "pnpm",
            "pnpm",
            &[],
            &["pnpm"],
            "Install pnpm, or configure its executable for this workspace.",
        )
    } else if root.join("yarn.lock").is_file() {
        builder.tool(
            root,
            config,
            "yarn",
            "Yarn",
            &[],
            &["yarn"],
            "Install Yarn, or configure its executable for this workspace.",
        )
    } else {
        builder.tool(
            root,
            config,
            "npm",
            "npm",
            &[],
            &["npm"],
            "Install Node.js/npm, or configure npm for this workspace.",
        )
    }
}

fn add_node(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let package: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", manifest.display()))?;
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("node", manifest, &["javascript", "typescript"], "node");
    let manager = package_manager(builder, root, config);
    let node = builder.tool(
        root,
        config,
        "node",
        "Node.js",
        &[],
        &["node"],
        "Install Node.js, or configure its executable for this workspace.",
    );
    let js_debug = builder.tool(
        root,
        config,
        "js-debug",
        "JavaScript Debug Adapter",
        &[],
        &["js-debug-adapter"],
        "Install vscode-js-debug and configure its DAP adapter executable.",
    );
    if let Some(scripts) = package.get("scripts").and_then(Value::as_object) {
        let mut names = scripts.keys().cloned().collect::<Vec<_>>();
        names.sort();
        for name in names {
            let script_args = vec!["run".to_string(), name.clone(), "--".to_string()];
            if matches!(
                name.as_str(),
                "build" | "compile" | "clean" | "test" | "lint" | "check" | "typecheck"
            ) {
                let kind = match name.as_str() {
                    "clean" => "clean",
                    "test" => "test",
                    "lint" | "check" | "typecheck" => "check",
                    _ => "build",
                };
                builder.build(
                    &project,
                    &format!("Script: {name}"),
                    kind,
                    command(&manager, script_args, root),
                );
            } else if matches!(name.as_str(), "start" | "dev" | "serve")
                || name.starts_with("start:")
                || name.starts_with("dev:")
            {
                builder.run(
                    &project,
                    &format!("Script: {name}"),
                    "package-script",
                    command(&manager, script_args, root),
                    None,
                    Vec::new(),
                    None,
                );
            }
        }
    }
    if let Some(active) = active_in_project(
        active_file,
        root,
        &["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"],
    ) {
        let extension = active
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let runner = if matches!(extension, "ts" | "tsx" | "mts" | "cts") {
            let local_tsx = root.join("node_modules/.bin/tsx");
            let local_tsx_cmd = if cfg!(windows) {
                root.join("node_modules/.bin/tsx.cmd")
            } else {
                local_tsx
            };
            resolve_tool(
                root,
                "tsx",
                "tsx",
                None,
                &[],
                &[local_tsx_cmd.to_str().unwrap_or("tsx"), "tsx", "ts-node"],
                "Install the project `tsx` or `ts-node` runner before running TypeScript directly.",
            )
        } else {
            node.clone()
        };
        let source_file = Some(path_string(&active));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {}", active.file_name().unwrap_or_default().to_string_lossy()),
            "node",
            &js_debug,
            Vec::new(),
            source_file.clone(),
            json!({ "name": "Node", "type": "pwa-node", "request": "launch", "program": path_string(&active), "cwd": project.root, "args": [], "sourceMaps": true, "skipFiles": ["<node_internals>/**"] }),
            Some(json!({ "kind": "stdio", "args": [] })),
        );
        builder.run(
            &project,
            &format!(
                "Run {}",
                active.file_name().unwrap_or_default().to_string_lossy()
            ),
            "file",
            command(&runner, vec![path_string(&active), "--".to_string()], root),
            source_file,
            Vec::new(),
            Some(debug_id),
        );
    }
    Ok(())
}

fn python_module_name(root: &Path, source: &Path) -> Option<String> {
    let relative = source.strip_prefix(root).ok()?;
    let mut parts = relative
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()?;
    let last = parts.pop()?;
    let stem = last.strip_suffix(".py")?;
    if stem != "__init__" {
        parts.push(stem);
    }
    let valid = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").ok()?;
    (!parts.is_empty() && parts.iter().all(|part| valid.is_match(part))).then(|| parts.join("."))
}

fn python_entry_code(value: &str) -> Option<String> {
    let (module, function) = value.split_once(':')?;
    let valid = Regex::new(r"^[A-Za-z_][A-Za-z0-9_.]*$").ok()?;
    if !valid.is_match(module) || !valid.is_match(function) {
        return None;
    }
    Some(format!(
        "from {module} import {function} as _taomni_entry; raise SystemExit(_taomni_entry())"
    ))
}

fn add_python(
    builder: &mut ModelBuilder,
    manifest: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let parsed: toml::Value = toml::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", manifest.display()))?;
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("python", manifest, &["python"], "python");
    let python_candidates = if cfg!(windows) {
        &["python.exe", "python"] as &[&str]
    } else {
        &["python3", "python"]
    };
    let venv = if cfg!(windows) {
        root.join(".venv/Scripts/python.exe")
    } else {
        root.join(".venv/bin/python")
    };
    let python = resolve_tool(
        root,
        "python",
        "Python",
        configured_tool(config, "python"),
        &[],
        &[
            venv.to_str().unwrap_or("python"),
            python_candidates[0],
            python_candidates[1],
        ],
        "Create a workspace virtual environment or configure the Python interpreter.",
    );
    builder
        .tools
        .entry(format!("{}\0python", path_string(root)))
        .or_insert_with(|| python.clone());
    let debugpy = builder.tool(root, config, "debugpy", "debugpy adapter", &[], &["debugpy-adapter"], "Install debugpy in the selected environment (`python -m pip install debugpy`) or configure debugpy-adapter.");
    let mut build_ids = Vec::new();
    let has_build_system = parsed.get("build-system").is_some();
    if has_build_system {
        let build = builder.build(
            &project,
            "Build wheel and sdist",
            "build",
            command(&python, vec!["-m".to_string(), "build".to_string()], root),
        );
        build_ids.push(build);
    }
    if parsed
        .get("tool")
        .and_then(|value| value.get("pytest"))
        .is_some()
    {
        builder.build(
            &project,
            "Run tests",
            "test",
            command(&python, vec!["-m".to_string(), "pytest".to_string()], root),
        );
    }
    let tables = [
        parsed.get("project").and_then(|value| value.get("scripts")),
        parsed
            .get("tool")
            .and_then(|value| value.get("poetry"))
            .and_then(|value| value.get("scripts")),
    ];
    let mut seen = BTreeSet::new();
    for table in tables
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_table)
    {
        for (name, entry) in table {
            if !seen.insert(name.clone()) {
                continue;
            }
            let Some(value) = entry.as_str() else {
                continue;
            };
            let Some(code) = python_entry_code(value) else {
                continue;
            };
            builder.run(
                &project,
                &format!("Entry point: {name}"),
                "entry-point",
                command(&python, vec!["-c".to_string(), code], root),
                None,
                build_ids.clone(),
                None,
            );
        }
    }
    if let Some(active) = active_in_project(active_file, root, &["py", "pyw"]) {
        let source_file = Some(path_string(&active));
        let debug_id = builder.debug(
            &project,
            &format!("Debug {}", active.file_name().unwrap_or_default().to_string_lossy()),
            "python",
            &debugpy,
            build_ids.clone(),
            source_file.clone(),
            json!({ "name": "Python", "type": "python", "request": "launch", "program": path_string(&active), "cwd": project.root, "args": [], "justMyCode": true, "subProcess": false }),
            Some(json!({ "kind": "stdio", "args": [] })),
        );
        builder.run(
            &project,
            &format!(
                "Run {}",
                active.file_name().unwrap_or_default().to_string_lossy()
            ),
            "file",
            command(&python, vec![path_string(&active)], root),
            source_file.clone(),
            build_ids.clone(),
            Some(debug_id),
        );
        if let Some(module) = python_module_name(root, &active) {
            builder.run(
                &project,
                &format!("Run module {module}"),
                "module",
                command(&python, vec!["-m".to_string(), module], root),
                source_file,
                build_ids,
                None,
            );
        }
    }
    Ok(())
}

fn add_cmake(builder: &mut ModelBuilder, manifest: &Path, config: Option<&WorkspaceToolConfig>) {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("cmake", manifest, &["c", "cpp"], "cmake");
    let cmake = builder.tool(
        root,
        config,
        "cmake",
        "CMake",
        &[],
        &["cmake"],
        "Install CMake, or configure its executable for this workspace.",
    );
    let build_dir = root.join("build");
    let configure = builder.build(
        &project,
        "Configure (Debug)",
        "configure",
        command(
            &cmake,
            vec![
                "-S".to_string(),
                path_string(root),
                "-B".to_string(),
                path_string(&build_dir),
                "-DCMAKE_BUILD_TYPE=Debug".to_string(),
            ],
            root,
        ),
    );
    let build = builder.build(
        &project,
        "Build",
        "build",
        command(
            &cmake,
            vec![
                "--build".to_string(),
                path_string(&build_dir),
                "--config".to_string(),
                "Debug".to_string(),
            ],
            root,
        ),
    );
    if let Some(target) = builder
        .build_targets
        .iter_mut()
        .find(|target| target.id == build)
    {
        target.depends_on.push(configure);
    }
    builder.build(
        &project,
        "Run tests",
        "test",
        command(
            &cmake,
            vec![
                "--build".to_string(),
                path_string(&build_dir),
                "--target".to_string(),
                "test".to_string(),
                "--config".to_string(),
                "Debug".to_string(),
            ],
            root,
        ),
    );
    builder.build(
        &project,
        "Clean",
        "clean",
        command(
            &cmake,
            vec![
                "--build".to_string(),
                path_string(&build_dir),
                "--target".to_string(),
                "clean".to_string(),
            ],
            root,
        ),
    );
}

fn add_dotnet(builder: &mut ModelBuilder, manifest: &Path, config: Option<&WorkspaceToolConfig>) {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("dotnet", manifest, &["csharp"], "dotnet");
    let dotnet = builder.tool(
        root,
        config,
        "dotnet",
        ".NET SDK",
        &[],
        &["dotnet"],
        "Install a compatible .NET SDK, or configure dotnet for this workspace.",
    );
    let manifest_arg = path_string(manifest);
    let builds = add_common_builds(
        builder,
        &project,
        &dotnet,
        &[
            ("Restore", "restore", &["restore", manifest_arg.as_str()]),
            (
                "Build (Debug)",
                "build",
                &["build", manifest_arg.as_str(), "--configuration", "Debug"],
            ),
            (
                "Test",
                "test",
                &["test", manifest_arg.as_str(), "--configuration", "Debug"],
            ),
            (
                "Clean",
                "clean",
                &["clean", manifest_arg.as_str(), "--configuration", "Debug"],
            ),
        ],
    );
    builder.run(
        &project,
        &format!("Run {}", project.module),
        "project",
        command(
            &dotnet,
            vec![
                "run".to_string(),
                "--project".to_string(),
                manifest_arg,
                "--configuration".to_string(),
                "Debug".to_string(),
                "--".to_string(),
            ],
            root,
        ),
        None,
        builds.get("build").cloned().into_iter().collect(),
        None,
    );
    // netcoredbg needs a concrete build artifact. The provider intentionally
    // leaves Debug unavailable until MSBuild result parsing is implemented.
    builder.tool(root, config, "netcoredbg", "netcoredbg", &[], &["netcoredbg"], "Install netcoredbg and configure its executable. Debug also requires a resolved target framework artifact.");
}

fn detect_jvm_languages(root: &Path) -> Vec<&'static str> {
    let mut languages = BTreeSet::new();
    for entry in WalkBuilder::new(root)
        .max_depth(Some(6))
        .filter_entry(manifest_entry)
        .build()
        .flatten()
    {
        match entry.path().extension().and_then(|value| value.to_str()) {
            Some("java") => {
                languages.insert("java");
            }
            Some("kt") | Some("kts") => {
                languages.insert("kotlin");
            }
            Some("scala") => {
                languages.insert("scala");
            }
            _ => {}
        }
    }
    languages.into_iter().collect()
}

fn jvm_main_regex() -> &'static Regex {
    static MAIN: OnceLock<Regex> = OnceLock::new();
    MAIN.get_or_init(|| {
        Regex::new(r"(?m)(?:static\s+void\s+main\s*\(|fun\s+main\s*\(|def\s+main\s*\()")
            .expect("valid JVM main regex")
    })
}

fn add_jvm(builder: &mut ModelBuilder, manifest: &Path, config: Option<&WorkspaceToolConfig>) {
    let root = manifest.parent().unwrap_or(manifest);
    let languages = detect_jvm_languages(root);
    let language_refs = if languages.is_empty() {
        vec!["java"]
    } else {
        languages
    };
    let provider = if manifest.file_name().and_then(|value| value.to_str()) == Some("pom.xml") {
        "maven"
    } else {
        "gradle"
    };
    let project = builder.project(provider, manifest, &language_refs, provider);
    let (tool, tasks): (ToolProbe, &[(&str, &str, &[&str])]) = if provider == "maven" {
        let tool = builder.tool(
            root,
            config,
            "maven",
            "Maven",
            &["mvnw", "mvnw.cmd", "mvnw.bat"],
            &["mvn"],
            "Install Maven, configure it, or add the Maven wrapper.",
        );
        (
            tool,
            &[
                ("Compile", "build", &["compile"]),
                ("Package", "build", &["package"]),
                ("Test", "test", &["test"]),
                ("Clean", "clean", &["clean"]),
            ],
        )
    } else {
        let tool = builder.tool(
            root,
            config,
            "gradle",
            "Gradle",
            &["gradlew", "gradlew.bat", "gradlew.cmd"],
            &["gradle"],
            "Install Gradle, configure it, or add the Gradle wrapper.",
        );
        (
            tool,
            &[
                ("Classes", "build", &["classes"]),
                ("Build", "build", &["build"]),
                ("Test", "test", &["test"]),
                ("Clean", "clean", &["clean"]),
            ],
        )
    };
    let builds = add_common_builds(builder, &project, &tool, tasks);
    if provider == "gradle" {
        builder.run(
            &project,
            "Run application",
            "application",
            command(
                &tool,
                vec!["run".to_string(), "--args".to_string(), "".to_string()],
                root,
            ),
            None,
            builds.get("build").cloned().into_iter().collect(),
            None,
        );
    }
    // Bounded source discovery records explicit mains for Maven run. Gradle's
    // Application plugin remains the authority for its main class.
    if provider == "maven" {
        for (_, source) in ["java", "kt", "scala"]
            .into_iter()
            .flat_map(|extension| source_directories(root, extension, jvm_main_regex()))
        {
            let class = source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Main");
            builder.run(
                &project,
                &format!("Run {class}"),
                "main-class",
                command(
                    &tool,
                    vec![
                        "compile".to_string(),
                        "org.codehaus.mojo:exec-maven-plugin:3.5.0:java".to_string(),
                        format!("-Dexec.mainClass={class}"),
                        "-Dexec.args=".to_string(),
                    ],
                    root,
                ),
                Some(path_string(&source)),
                builds.get("build").cloned().into_iter().collect(),
                None,
            );
        }
    }
}

fn scala_main_name(source: &str) -> Option<String> {
    let package = Regex::new(r"(?m)^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)")
        .ok()?
        .captures(source)
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str());
    let object = Regex::new(r"(?m)^\s*object\s+([A-Za-z_][A-Za-z0-9_]*)[^\n]*")
        .ok()?
        .captures(source)?
        .get(1)?
        .as_str();
    Some(
        package
            .map(|prefix| format!("{prefix}.{object}"))
            .unwrap_or_else(|| object.to_string()),
    )
}

fn add_sbt(builder: &mut ModelBuilder, manifest: &Path, config: Option<&WorkspaceToolConfig>) {
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("sbt", manifest, &["scala"], "sbt");
    let sbt = builder.tool(
        root,
        config,
        "sbt",
        "sbt",
        &["sbt", "sbt.bat"],
        &["sbt"],
        "Install sbt, configure it, or add the sbt launcher script.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &sbt,
        &[
            ("Compile", "build", &["compile"]),
            ("Test", "test", &["test"]),
            ("Clean", "clean", &["clean"]),
        ],
    );
    for (_, source) in source_directories(root, "scala", jvm_main_regex()) {
        let Ok(contents) = read_text(&source) else {
            continue;
        };
        let Some(main) = scala_main_name(&contents) else {
            continue;
        };
        builder.run(
            &project,
            &format!("Run {main}"),
            "main-class",
            command(&sbt, vec![format!("runMain {main}")], root),
            Some(path_string(&source)),
            builds.get("build").cloned().into_iter().collect(),
            None,
        );
    }
}

fn swift_products(contents: &str) -> Vec<String> {
    let regex = Regex::new(r#"\.executable(?:Target)?\s*\(\s*name\s*:\s*"([^"]+)""#)
        .expect("valid Swift product regex");
    let mut products = regex
        .captures_iter(contents)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    products.sort();
    products.dedup();
    products
}

fn add_swift(
    builder: &mut ModelBuilder,
    manifest: &Path,
    config: Option<&WorkspaceToolConfig>,
) -> Result<(), String> {
    let contents = read_text(manifest)?;
    let root = manifest.parent().unwrap_or(manifest);
    let project = builder.project("swiftpm", manifest, &["swift"], "swift");
    let swift = builder.tool(
        root,
        config,
        "swift",
        "Swift",
        &[],
        &["swift"],
        "Install a Swift toolchain, or configure its executable for this workspace.",
    );
    let builds = add_common_builds(
        builder,
        &project,
        &swift,
        &[
            (
                "Build (debug)",
                "build",
                &["build", "--configuration", "debug"],
            ),
            ("Test", "test", &["test"]),
            ("Clean", "clean", &["package", "clean"]),
        ],
    );
    let lldb = builder.tool(
        root,
        config,
        "lldb-dap",
        "LLDB DAP",
        &[],
        &["lldb-dap"],
        "Install lldb-dap from the Swift/LLVM toolchain, or configure its executable.",
    );
    for product in swift_products(&contents) {
        let debug_id = builder.debug(
            &project,
            &format!("Debug {product}"),
            "lldb",
            &lldb,
            builds.get("build").cloned().into_iter().collect(),
            None,
            json!({ "name": product, "request": "launch", "cwd": project.root, "args": [] }),
            Some(json!({ "kind": "swift", "command": swift.executable, "product": product })),
        );
        builder.run(
            &project,
            &format!("Run {product}"),
            "product",
            command(
                &swift,
                vec!["run".to_string(), product.clone(), "--".to_string()],
                root,
            ),
            None,
            builds.get("build").cloned().into_iter().collect(),
            Some(debug_id),
        );
    }
    Ok(())
}

fn canonical_root(repo_root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(repo_root)
        .map_err(|error| format!("resolve workspace root `{repo_root}`: {error}"))?;
    if !root.is_dir() {
        return Err(format!(
            "workspace root is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

fn resolve_active(root: &Path, active_file: Option<&str>) -> Option<PathBuf> {
    let active = active_file?.trim();
    if active.is_empty() {
        return None;
    }
    let path = Path::new(active);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let canonical = fs::canonicalize(joined).ok()?;
    canonical.starts_with(root).then_some(canonical)
}

pub fn detect_execution_model(
    root: &Path,
    active_file: Option<&Path>,
    config: Option<&WorkspaceToolConfig>,
) -> Result<WorkspaceExecutionModel, String> {
    let mut builder = ModelBuilder::default();
    let manifests = discover_manifests(root)?;
    // Gradle projects often contain both build.gradle and build.gradle.kts while
    // transitioning. One provider per directory keeps stable ids unambiguous.
    let mut seen_provider_roots = BTreeSet::<(String, PathBuf)>::new();
    for manifest in manifests {
        let name = manifest
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let provider = match name {
            "Cargo.toml" => "cargo",
            "go.mod" => "go",
            "package.json" => "node",
            "pyproject.toml" => "python",
            "CMakeLists.txt" => "cmake",
            "pom.xml" => "maven",
            "build.gradle" | "build.gradle.kts" => "gradle",
            "build.sbt" => "sbt",
            "Package.swift" => "swiftpm",
            value if value.ends_with(".csproj") => "dotnet",
            _ => continue,
        };
        let project_root = manifest.parent().unwrap_or(&manifest).to_path_buf();
        if !seen_provider_roots.insert((provider.to_string(), project_root)) {
            continue;
        }
        match provider {
            "cargo" => add_cargo(&mut builder, &manifest, active_file, config)?,
            "go" => add_go(&mut builder, &manifest, active_file, config)?,
            "node" => add_node(&mut builder, &manifest, active_file, config)?,
            "python" => add_python(&mut builder, &manifest, active_file, config)?,
            "cmake" => add_cmake(&mut builder, &manifest, config),
            "dotnet" => add_dotnet(&mut builder, &manifest, config),
            "maven" | "gradle" => add_jvm(&mut builder, &manifest, config),
            "sbt" => add_sbt(&mut builder, &manifest, config),
            "swiftpm" => add_swift(&mut builder, &manifest, config)?,
            _ => {}
        }
    }
    Ok(builder.finish())
}

#[tauri::command]
pub fn workspace_execution_model(
    repo_root: String,
    active_file: Option<String>,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<WorkspaceExecutionModel, String> {
    let root = canonical_root(&repo_root)?;
    let active = resolve_active(&root, active_file.as_deref());
    detect_execution_model(&root, active.as_deref(), tool_config.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn cargo_targets_have_stable_ids_and_precise_bin_selectors() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("Cargo.toml"),
            "[package]\nname='demo'\nversion='0.1.0'\n[[bin]]\nname='worker'\npath='src/worker.rs'\n",
        );
        write(&directory.path().join("src/main.rs"), "fn main() {}\n");
        write(&directory.path().join("src/worker.rs"), "fn main() {}\n");
        let first = detect_execution_model(directory.path(), None, None).unwrap();
        let second = detect_execution_model(directory.path(), None, None).unwrap();
        assert_eq!(first.projects, second.projects);
        assert_eq!(first.run_configurations, second.run_configurations);
        assert!(first.run_configurations.iter().any(|target| {
            target
                .command
                .args
                .windows(2)
                .any(|args| args == ["--bin", "worker"])
        }));
        assert!(
            first
                .build_targets
                .iter()
                .all(|target| !target.command.executable.contains(' '))
        );
    }

    #[test]
    fn discovers_go_python_node_dotnet_cmake_and_swift_without_running_tools() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("go/go.mod"),
            "module example.test/demo\n",
        );
        write(
            &directory.path().join("go/cmd/demo/main.go"),
            "package main\nfunc main() {}\n",
        );
        write(
            &directory.path().join("py/pyproject.toml"),
            "[project]\nname='demo'\n[project.scripts]\nhello='demo.cli:main'\n",
        );
        write(
            &directory.path().join("py/demo/cli.py"),
            "def main(): pass\n",
        );
        write(
            &directory.path().join("web/package.json"),
            r#"{"name":"web","scripts":{"build":"tsc","dev":"vite"}}"#,
        );
        write(
            &directory.path().join("dotnet/App.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
        );
        write(
            &directory.path().join("native/CMakeLists.txt"),
            "cmake_minimum_required(VERSION 3.20)\n",
        );
        write(
            &directory.path().join("swift/Package.swift"),
            ".executableTarget(name: \"tool\")\n",
        );
        let model = detect_execution_model(
            directory.path(),
            Some(&directory.path().join("py/demo/cli.py")),
            None,
        )
        .unwrap();
        for provider in ["go", "python", "node", "dotnet", "cmake", "swiftpm"] {
            assert!(
                model
                    .projects
                    .iter()
                    .any(|project| project.provider == provider),
                "missing {provider}"
            );
        }
        assert!(
            model
                .run_configurations
                .iter()
                .any(|target| target.label == "Entry point: hello")
        );
        assert!(
            model
                .run_configurations
                .iter()
                .any(|target| target.kind == "main-package")
        );
        assert!(
            model
                .build_targets
                .iter()
                .any(|target| target.label == "Configure (Debug)")
        );
    }

    #[test]
    fn missing_adapters_are_reported_instead_of_falsely_enabled() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("pyproject.toml"),
            "[project]\nname='demo'\n",
        );
        write(&directory.path().join("main.py"), "print('hello')\n");
        let config = WorkspaceToolConfig {
            debugpy: Some(
                directory
                    .path()
                    .join("missing-debugpy")
                    .to_string_lossy()
                    .to_string(),
            ),
            ..Default::default()
        };
        let model = detect_execution_model(
            directory.path(),
            Some(&directory.path().join("main.py")),
            Some(&config),
        )
        .unwrap();
        let debug = model
            .debug_configurations
            .first()
            .expect("Python debug config");
        assert!(!debug.available);
        assert!(
            debug
                .diagnostic
                .as_deref()
                .unwrap_or_default()
                .contains("Configured executable")
        );
    }
}
