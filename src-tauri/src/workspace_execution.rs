//! Structured multi-language Build/Run/Debug discovery for Code Workspace.
//!
//! Providers in this module are deliberately evidence-driven: a manifest owns a
//! project, commands are represented as argv rather than shell fragments, and a
//! debug configuration is enabled only when its adapter can be resolved.

use crate::workspace::WorkspaceToolConfig;
use ignore::{DirEntry, WalkBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_MANIFEST_DEPTH: usize = 8;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const SHARED_RUN_CONFIG_RELATIVE_PATH: &str = ".taomni/run-configurations.json";
const SHARED_RUN_CONFIG_VERSION: u64 = 2;

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
    pub module_id: String,
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_level: Option<String>,
    pub toolchain: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleModel {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub root: String,
    pub manifest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_level: Option<String>,
    pub source_set_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_module_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub child_module_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub module_dependencies: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSetModel {
    pub id: String,
    pub project_id: String,
    pub module_id: String,
    pub name: String,
    pub kind: String,
    pub roots: Vec<String>,
    pub generated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompileArtifact {
    pub id: String,
    pub project_id: String,
    pub module_id: String,
    pub target_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub resolution: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildTarget {
    pub id: String,
    pub project_id: String,
    pub module_id: String,
    pub label: String,
    pub kind: String,
    pub command: ExecutionCommand,
    pub depends_on: Vec<String>,
    pub artifact_ids: Vec<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_modes: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_configuration_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_stop_on_failure: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_configuration_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_stop_on_failure: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExecutionModel {
    pub projects: Vec<ProjectModel>,
    pub modules: Vec<ModuleModel>,
    pub source_sets: Vec<SourceSetModel>,
    pub build_targets: Vec<BuildTarget>,
    pub compile_artifacts: Vec<CompileArtifact>,
    pub run_configurations: Vec<RunConfiguration>,
    pub debug_configurations: Vec<DebugConfiguration>,
    pub tools: Vec<ToolProbe>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedConfigurationFile {
    #[serde(default)]
    version: Option<u64>,
    #[serde(default)]
    configurations: Vec<SharedConfiguration>,
    /// Version 1 used a top-level `runs` array. It is intentionally kept as
    /// raw JSON so migration can accept the old command/object spellings.
    #[serde(default)]
    runs: Vec<Value>,
    #[serde(default)]
    templates: BTreeMap<String, SharedTemplate>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedTemplate {
    #[serde(flatten)]
    patch: SharedConfigurationPatch,
    #[serde(default)]
    platforms: BTreeMap<String, SharedConfigurationPatch>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedConfiguration {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default, alias = "baseConfigurationId")]
    base: Option<String>,
    #[serde(default)]
    template: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    source_file: Option<String>,
    #[serde(default, alias = "preLaunchTargets")]
    before_launch: Option<Vec<String>>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    run: Option<SharedRunSpec>,
    #[serde(default)]
    debug: Option<SharedDebugSpec>,
    #[serde(default)]
    compound: Option<SharedCompoundSpec>,
    #[serde(default)]
    platforms: BTreeMap<String, SharedConfigurationPatch>,
    // v1 accepted the run fields directly on each entry. Keeping these
    // optional fields makes migration deterministic and preserves hand-written
    // files from early Code Workspace previews.
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    display: Option<String>,
    #[serde(default)]
    runtime_options: Option<Vec<String>>,
    #[serde(default)]
    env_file: Option<String>,
    #[serde(default)]
    argument_strategy: Option<String>,
    #[serde(default)]
    environment_modes: Option<BTreeMap<String, String>>,
    #[serde(default)]
    adapter_id: Option<String>,
    #[serde(default)]
    request: Option<String>,
    #[serde(default)]
    launch_config: Option<Value>,
    #[serde(default, alias = "debugConfigurationId")]
    debug_reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedConfigurationPatch {
    #[serde(default)]
    source_file: Option<String>,
    #[serde(default)]
    before_launch: Option<Vec<String>>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    run: Option<SharedRunSpec>,
    #[serde(default)]
    debug: Option<SharedDebugSpec>,
    #[serde(default)]
    compound: Option<SharedCompoundSpec>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedCompoundSpec {
    configurations: Vec<String>,
    #[serde(default)]
    parallel: Option<bool>,
    #[serde(default)]
    stop_on_failure: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedRunSpec {
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    display: Option<String>,
    #[serde(default)]
    runtime_options: Option<Vec<String>>,
    #[serde(default)]
    env_file: Option<String>,
    #[serde(default)]
    argument_strategy: Option<String>,
    #[serde(default)]
    environment_modes: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedDebugSpec {
    #[serde(default)]
    adapter_id: Option<String>,
    #[serde(default)]
    request: Option<String>,
    #[serde(default)]
    available: Option<bool>,
    #[serde(default)]
    launch_config: Option<Value>,
    #[serde(default)]
    env_file: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedSharedConfiguration {
    id: String,
    label: String,
    kind: String,
    project_id: String,
    source_file: Option<String>,
    before_launch: Vec<String>,
    run: Option<ResolvedSharedRun>,
    debug: Option<ResolvedSharedDebug>,
    debug_reference: Option<String>,
    compound: Option<SharedCompoundSpec>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedSharedRun {
    executable: String,
    args: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    display: Option<String>,
    runtime_options: Option<Vec<String>>,
    env_file: Option<String>,
    argument_strategy: Option<String>,
    environment_modes: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedSharedDebug {
    adapter_id: String,
    request: String,
    available: Option<bool>,
    launch_config: Value,
    env_file: Option<String>,
}

#[derive(Default)]
struct ModelBuilder {
    projects: Vec<ProjectModel>,
    modules: Vec<ModuleModel>,
    source_sets: Vec<SourceSetModel>,
    build_targets: Vec<BuildTarget>,
    compile_artifacts: Vec<CompileArtifact>,
    run_configurations: Vec<RunConfiguration>,
    debug_configurations: Vec<DebugConfiguration>,
    tools: BTreeMap<String, ToolProbe>,
    diagnostics: Vec<String>,
}

impl ModelBuilder {
    fn finish(mut self) -> WorkspaceExecutionModel {
        self.resolve_module_hierarchy();
        self.projects.sort_by(|a, b| a.id.cmp(&b.id));
        self.modules.sort_by(|a, b| a.id.cmp(&b.id));
        self.source_sets.sort_by(|a, b| a.id.cmp(&b.id));
        self.build_targets.sort_by(|a, b| a.id.cmp(&b.id));
        self.compile_artifacts.sort_by(|a, b| a.id.cmp(&b.id));
        self.run_configurations.sort_by(|a, b| a.id.cmp(&b.id));
        self.debug_configurations.sort_by(|a, b| a.id.cmp(&b.id));
        self.diagnostics.sort();
        self.diagnostics.dedup();
        WorkspaceExecutionModel {
            projects: self.projects,
            modules: self.modules,
            source_sets: self.source_sets,
            build_targets: self.build_targets,
            compile_artifacts: self.compile_artifacts,
            run_configurations: self.run_configurations,
            debug_configurations: self.debug_configurations,
            tools: self.tools.into_values().collect(),
            diagnostics: self.diagnostics,
        }
    }

    fn resolve_module_hierarchy(&mut self) {
        let mut parent_to_children: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut child_to_parent: BTreeMap<String, String> = BTreeMap::new();
        let mut module_deps: BTreeMap<String, Vec<String>> = BTreeMap::new();

        // 1. Maven hierarchy from pom.xml <modules>
        for module in &self.modules {
            let manifest_path = Path::new(&module.manifest);
            if manifest_path.file_name().and_then(|v| v.to_str()) == Some("pom.xml") {
                if let Ok(content) = fs::read_to_string(manifest_path) {
                    let submodules = parse_maven_modules(&content);
                    let module_root = Path::new(&module.root);
                    for sub in submodules {
                        let sub_root = module_root.join(&sub);
                        let sub_root_str = path_string(&sub_root);
                        if let Some(child) = self.modules.iter().find(|m| m.root == sub_root_str) {
                            parent_to_children
                                .entry(module.id.clone())
                                .or_default()
                                .push(child.id.clone());
                            child_to_parent.insert(child.id.clone(), module.id.clone());
                        }
                    }
                }
            }
        }

        // 2. Gradle hierarchy from settings.gradle / settings.gradle.kts
        for module in &self.modules {
            let module_root = Path::new(&module.root);
            for settings_name in ["settings.gradle", "settings.gradle.kts"] {
                let settings_path = module_root.join(settings_name);
                if settings_path.is_file() {
                    if let Ok(content) = fs::read_to_string(&settings_path) {
                        let submodules = parse_gradle_settings_modules(&content);
                        for sub in submodules {
                            let sub_root = module_root.join(&sub);
                            let sub_root_str = path_string(&sub_root);
                            if let Some(child) =
                                self.modules.iter().find(|m| m.root == sub_root_str)
                            {
                                parent_to_children
                                    .entry(module.id.clone())
                                    .or_default()
                                    .push(child.id.clone());
                                child_to_parent.insert(child.id.clone(), module.id.clone());
                            }
                        }
                    }
                }
            }
        }

        // 3. Module dependencies from build.gradle / build.gradle.kts
        for module in &self.modules {
            let manifest_path = Path::new(&module.manifest);
            if let Ok(content) = fs::read_to_string(manifest_path) {
                let deps = parse_gradle_project_dependencies(&content);
                if !deps.is_empty() {
                    module_deps.insert(module.id.clone(), deps);
                }
            }
        }

        // Apply to self.modules
        for module in &mut self.modules {
            if let Some(parent_id) = child_to_parent.get(&module.id) {
                module.parent_module_id = Some(parent_id.clone());
            }
            if let Some(mut children) = parent_to_children.remove(&module.id) {
                children.sort();
                children.dedup();
                module.child_module_ids = children;
            }
            if let Some(mut deps) = module_deps.remove(&module.id) {
                deps.sort();
                deps.dedup();
                module.module_dependencies = deps;
            }
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
        let id = stable_id("project", &[provider, &path_string(manifest)]);
        let module_id = stable_id("module", &[&id, &path_string(root)]);
        let project = ProjectModel {
            id,
            provider: provider.to_string(),
            root: path_string(root),
            manifest: path_string(manifest),
            module: root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("project")
                .to_string(),
            module_id,
            languages: languages.iter().map(|value| (*value).to_string()).collect(),
            language_level: detect_language_level(provider, manifest),
            toolchain: toolchain.to_string(),
            diagnostics: Vec::new(),
        };
        self.register_project(project)
    }

    fn register_project(&mut self, project: ProjectModel) -> ProjectModel {
        if let Some(existing) = self.projects.iter().find(|entry| entry.id == project.id) {
            return existing.clone();
        }
        let source_sets = discover_source_sets(&project);
        let source_set_ids = source_sets
            .iter()
            .map(|source_set| source_set.id.clone())
            .collect();
        self.modules.push(ModuleModel {
            id: project.module_id.clone(),
            project_id: project.id.clone(),
            name: project.module.clone(),
            root: project.root.clone(),
            manifest: project.manifest.clone(),
            language_level: project.language_level.clone(),
            source_set_ids,
            parent_module_id: None,
            child_module_ids: Vec::new(),
            module_dependencies: Vec::new(),
            diagnostics: Vec::new(),
        });
        self.source_sets.extend(source_sets);
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
        let artifact_ids = if kind == "build" {
            let artifact_id = stable_id("artifact", &[&id, &project.module_id, label]);
            let root = Path::new(&project.root);
            let (path, resolution, diagnostic) = if command.error.is_some() {
                (None, "blocked".to_string(), command.error.clone())
            } else if let Some(resolved) =
                resolve_existing_artifact_path(root, &project.provider, label)
            {
                (Some(path_string(&resolved)), "resolved".to_string(), None)
            } else {
                (
                    None,
                    "pending-provider-output".to_string(),
                    Some(compile_artifact_diagnostic(&project.provider).to_string()),
                )
            };
            self.compile_artifacts.push(CompileArtifact {
                id: artifact_id.clone(),
                project_id: project.id.clone(),
                module_id: project.module_id.clone(),
                target_id: id.clone(),
                kind: compile_artifact_kind(&project.provider, label).to_string(),
                path,
                resolution,
                source: "build-target".to_string(),
                diagnostic,
            });
            vec![artifact_id]
        } else {
            Vec::new()
        };
        self.build_targets.push(BuildTarget {
            id: id.clone(),
            project_id: project.id.clone(),
            module_id: project.module_id.clone(),
            label: label.to_string(),
            kind: kind.to_string(),
            command,
            depends_on: Vec::new(),
            artifact_ids,
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
            env_file: None,
            configuration_source: Some("provider".to_string()),
            compound_configuration_ids: None,
            compound_parallel: None,
            compound_stop_on_failure: None,
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
            configuration_source: Some("provider".to_string()),
            runtime_options: None,
            env_file: None,
            argument_strategy: None,
            environment_modes: None,
            compound_configuration_ids: None,
            compound_parallel: None,
            compound_stop_on_failure: None,
        });
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn shared_project_model(workspace_root: &Path) -> ProjectModel {
    let id = "shared:workspace".to_string();
    ProjectModel {
        module_id: stable_id("module", &[&id, &path_string(workspace_root)]),
        id,
        provider: "shared".to_string(),
        root: path_string(workspace_root),
        manifest: path_string(&workspace_root.join(SHARED_RUN_CONFIG_RELATIVE_PATH)),
        module: workspace_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace")
            .to_string(),
        languages: Vec::new(),
        language_level: None,
        toolchain: "shared".to_string(),
        diagnostics: Vec::new(),
    }
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

fn first_capture(contents: &str, patterns: &[&str]) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(contents)?
            .get(1)
            .map(|value| value.as_str().trim().to_string())
    })
}

fn maven_language_level(contents: &str) -> Option<String> {
    let configured = first_capture(
        contents,
        &[
            r"<maven\.compiler\.release>\s*([^<]+)\s*</maven\.compiler\.release>",
            r"<maven\.compiler\.source>\s*([^<]+)\s*</maven\.compiler\.source>",
        ],
    );
    let value = configured
        .or_else(|| first_capture(contents, &[r"<java\.version>\s*([^<]+)\s*</java\.version>"]))?;
    let Some(property) = value
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
    else {
        return Some(value);
    };
    if property.is_empty()
        || !property
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return None;
    }
    let pattern = format!(
        r"<{}>\s*([^<]+)\s*</{}>",
        regex::escape(property),
        regex::escape(property)
    );
    first_capture(contents, &[&pattern])
}

fn detect_language_level(provider: &str, manifest: &Path) -> Option<String> {
    let contents = read_text(manifest).ok()?;
    let (prefix, value) = match provider {
        "cargo" => (
            "rust",
            first_capture(&contents, &[r#"(?m)^\s*edition\s*=\s*["']([^"']+)["']"#])?,
        ),
        "go" => (
            "go",
            first_capture(&contents, &[r"(?m)^\s*go\s+([0-9]+(?:\.[0-9]+)*)\s*$"])?,
        ),
        "python" => (
            "python",
            first_capture(
                &contents,
                &[r#"(?m)^\s*requires-python\s*=\s*["']([^"']+)["']"#],
            )?,
        ),
        "node" => {
            let value = serde_json::from_str::<Value>(&contents)
                .ok()?
                .pointer("/engines/node")?
                .as_str()?
                .trim()
                .to_string();
            ("node", value)
        }
        "maven" => ("java", maven_language_level(&contents)?),
        "gradle" => (
            "java",
            first_capture(
                &contents,
                &[
                    r"JavaLanguageVersion\.of\s*\(\s*([0-9]+)\s*\)",
                    r"jvmToolchain\s*\(\s*([0-9]+)\s*\)",
                    r#"sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?["']?([0-9_\.]+)"#,
                ],
            )?
            .replace('_', "."),
        ),
        "sbt" => (
            "scala",
            first_capture(
                &contents,
                &[r#"(?m)^\s*(?:ThisBuild\s*/\s*)?scalaVersion\s*:?=\s*["']([^"']+)["']"#],
            )?,
        ),
        "dotnet" => (
            "dotnet",
            first_capture(
                &contents,
                &[r"<TargetFramework>\s*([^<]+)\s*</TargetFramework>"],
            )?,
        ),
        "cmake" => (
            "cpp",
            first_capture(
                &contents,
                &[r"CMAKE_CXX_STANDARD\s+([0-9]+)", r"cxx_std_([0-9]+)"],
            )?,
        ),
        "swiftpm" => (
            "swift",
            first_capture(
                &contents,
                &[r"(?m)^\s*//\s*swift-tools-version:\s*([0-9]+(?:\.[0-9]+)*)"],
            )?,
        ),
        _ => return None,
    };
    (!value.is_empty()).then(|| format!("{prefix}:{value}"))
}

fn source_set(
    project: &ProjectModel,
    name: &str,
    kind: &str,
    roots: Vec<PathBuf>,
    generated: bool,
) -> Option<SourceSetModel> {
    let mut roots = roots
        .into_iter()
        .filter(|root| root.is_dir())
        .map(|root| path_string(&root))
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return None;
    }
    Some(SourceSetModel {
        id: stable_id("source-set", &[&project.module_id, name, kind]),
        project_id: project.id.clone(),
        module_id: project.module_id.clone(),
        name: name.to_string(),
        kind: kind.to_string(),
        roots,
        generated,
        language_level: project.language_level.clone(),
    })
}

fn discover_source_sets(project: &ProjectModel) -> Vec<SourceSetModel> {
    let root = Path::new(&project.root);
    let mut main_roots = Vec::new();
    let mut test_roots = Vec::new();
    let mut generated_roots = Vec::new();
    match project.provider.as_str() {
        "maven" | "gradle" | "sbt" => {
            for language in &project.languages {
                main_roots.push(root.join("src/main").join(language));
                test_roots.push(root.join("src/test").join(language));
            }
            main_roots.push(root.join("src/main/resources"));
            test_roots.push(root.join("src/test/resources"));
            generated_roots.extend([
                root.join("target/generated-sources"),
                root.join("build/generated/sources"),
            ]);
        }
        "cargo" => {
            main_roots.push(root.join("src"));
            test_roots.push(root.join("tests"));
            generated_roots.push(root.join("target/generated"));
        }
        "swiftpm" => {
            main_roots.push(root.join("Sources"));
            test_roots.push(root.join("Tests"));
        }
        "cmake" => {
            main_roots.extend([root.join("src"), root.join("include")]);
            test_roots.extend([root.join("tests"), root.join("test")]);
            generated_roots.push(root.join("build/generated"));
        }
        "node" => {
            main_roots.push(root.join("src"));
            test_roots.extend([root.join("test"), root.join("tests")]);
            generated_roots.push(root.join("generated"));
        }
        "python" => {
            main_roots.push(root.join("src"));
            test_roots.extend([root.join("test"), root.join("tests")]);
        }
        "go" | "dotnet" => {
            main_roots.push(root.to_path_buf());
            test_roots.extend([root.join("test"), root.join("tests")]);
        }
        _ => main_roots.push(root.to_path_buf()),
    }
    if !main_roots.iter().any(|candidate| candidate.is_dir()) {
        main_roots.push(root.to_path_buf());
    }
    [
        source_set(project, "main", "production", main_roots, false),
        source_set(project, "test", "test", test_roots, false),
        source_set(project, "generated", "generated", generated_roots, true),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn compile_artifact_kind(provider: &str, label: &str) -> &'static str {
    let label = label.to_ascii_lowercase();
    match provider {
        "cargo" => "cargo-compiler-artifact",
        "go" => "go-package",
        "node" => "script-output",
        "python" => "python-distribution",
        "cmake" => "cmake-target",
        "dotnet" => "dotnet-assembly",
        "maven" | "gradle" | "sbt" if label.contains("compile") || label.contains("class") => {
            "jvm-classes"
        }
        "maven" | "gradle" | "sbt" => "jvm-artifact",
        "swiftpm" => "swift-product",
        _ => "provider-output",
    }
}

fn compile_artifact_diagnostic(provider: &str) -> &'static str {
    match provider {
        "cargo" => "Artifact path resolves from Cargo compiler-artifact JSON after build.",
        "cmake" => "Artifact path requires CMake file-api target output.",
        "dotnet" => "Artifact path requires MSBuild target framework output.",
        "maven" | "gradle" | "sbt" => {
            "Artifact path requires the imported build-tool module and task result."
        }
        "swiftpm" => "Artifact path resolves from SwiftPM bin-path output after build.",
        _ => "Artifact path remains unresolved until the provider reports build output.",
    }
}

fn resolve_existing_artifact_path(root: &Path, provider: &str, label: &str) -> Option<PathBuf> {
    let label_lower = label.to_ascii_lowercase();
    match provider {
        "maven" => {
            if label_lower.contains("compile") || label_lower.contains("class") {
                let classes = root.join("target/classes");
                if classes.is_dir() {
                    return Some(classes);
                }
            } else if label_lower.contains("package") || label_lower.contains("build") {
                let target = root.join("target");
                if let Ok(entries) = fs::read_dir(&target) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|ext| ext.to_str()) == Some("jar") {
                            return Some(path);
                        }
                    }
                }
            }
            None
        }
        "gradle" => {
            if label_lower.contains("class") || label_lower.contains("compile") {
                for candidate in [
                    "build/classes/java/main",
                    "build/classes/kotlin/main",
                    "build/classes",
                ] {
                    let dir = root.join(candidate);
                    if dir.is_dir() {
                        return Some(dir);
                    }
                }
            } else if label_lower.contains("build") || label_lower.contains("package") {
                let libs = root.join("build/libs");
                if let Ok(entries) = fs::read_dir(&libs) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|ext| ext.to_str()) == Some("jar") {
                            return Some(path);
                        }
                    }
                }
            }
            None
        }
        "cargo" => {
            for candidate in ["target/debug", "target/release"] {
                let dir = root.join(candidate);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
            None
        }
        "node" => {
            for candidate in ["dist", "build", "lib", "out"] {
                let dir = root.join(candidate);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
            None
        }
        "cmake" => {
            let build = root.join("build");
            if build.is_dir() { Some(build) } else { None }
        }
        "dotnet" => {
            for candidate in ["bin/Debug", "bin/Release", "bin"] {
                let dir = root.join(candidate);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
            None
        }
        _ => None,
    }
}

fn parse_maven_modules(pom_content: &str) -> Vec<String> {
    static MODULE_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = MODULE_REGEX.get_or_init(|| {
        Regex::new(r"<module>\s*([^<\s]+)\s*</module>").expect("valid maven module regex")
    });
    regex
        .captures_iter(pom_content)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|m| !m.is_empty())
        .collect()
}

fn parse_gradle_settings_modules(settings_content: &str) -> Vec<String> {
    static INCLUDE_LINE_REGEX: OnceLock<Regex> = OnceLock::new();
    let include_line_regex = INCLUDE_LINE_REGEX.get_or_init(|| {
        Regex::new(r#"(?m)^\s*include\b([^\n\r]+)"#).expect("valid include line regex")
    });
    static QUOTED_REGEX: OnceLock<Regex> = OnceLock::new();
    let quoted_regex = QUOTED_REGEX.get_or_init(|| {
        Regex::new(r#"['"](?::)?([a-zA-Z0-9_\-:]+)['"]"#).expect("valid quoted regex")
    });

    let mut modules = Vec::new();
    for capture in include_line_regex.captures_iter(settings_content) {
        if let Some(rest) = capture.get(1) {
            for item in quoted_regex.captures_iter(rest.as_str()) {
                if let Some(name) = item.get(1) {
                    let cleaned = name
                        .as_str()
                        .trim_start_matches(':')
                        .replace(':', "/")
                        .trim()
                        .to_string();
                    if !cleaned.is_empty() {
                        modules.push(cleaned);
                    }
                }
            }
        }
    }
    modules
}

fn parse_gradle_project_dependencies(build_content: &str) -> Vec<String> {
    static GRADLE_DEP_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = GRADLE_DEP_REGEX.get_or_init(|| {
        Regex::new(r#"project\s*\(\s*['":]([a-zA-Z0-9_\-:]+)['"]\s*\)"#)
            .expect("valid gradle dep regex")
    });
    regex
        .captures_iter(build_content)
        .filter_map(|capture| {
            capture
                .get(1)
                .map(|m| m.as_str().trim_start_matches(':').trim().to_string())
        })
        .filter(|m| !m.is_empty())
        .collect()
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

fn shared_platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn expand_shared_string(value: &str, workspace_root: &Path, project_root: &Path) -> String {
    let workspace = path_string(workspace_root);
    let project = path_string(project_root);
    value
        // Match IntelliJ's `$PROJECT_DIR$` contract: it is the selected
        // project/module root. `${workspaceRoot}` is the explicit escape hatch
        // for repository/workspace-level files in a multi-project workspace.
        .replace("$PROJECT_DIR$", &project)
        .replace("${workspaceRoot}", &workspace)
        .replace("${projectRoot}", &project)
}

fn expand_shared_value(value: &mut Value, workspace_root: &Path, project_root: &Path) {
    match value {
        Value::String(item) => {
            *item = expand_shared_string(item, workspace_root, project_root);
        }
        Value::Array(items) => {
            for item in items {
                expand_shared_value(item, workspace_root, project_root);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                expand_shared_value(item, workspace_root, project_root);
            }
        }
        _ => {}
    }
}

fn resolve_shared_path(value: &str, workspace_root: &Path, project_root: &Path) -> String {
    let expanded = expand_shared_string(value, workspace_root, project_root);
    let path = Path::new(&expanded);
    if path.is_absolute() {
        path_string(path)
    } else {
        path_string(&project_root.join(path))
    }
}

fn resolve_shared_executable(value: &str, workspace_root: &Path, project_root: &Path) -> String {
    let expanded = expand_shared_string(value, workspace_root, project_root);
    let path = Path::new(&expanded);
    if path.is_absolute() || expanded.contains('/') || expanded.contains('\\') {
        if path.is_absolute() {
            path_string(path)
        } else {
            path_string(&project_root.join(path))
        }
    } else {
        expanded
    }
}

fn merge_shared_run(base: &mut SharedRunSpec, patch: SharedRunSpec) {
    if patch.executable.is_some() {
        base.executable = patch.executable;
    }
    if patch.args.is_some() {
        base.args = patch.args;
    }
    if patch.cwd.is_some() {
        base.cwd = patch.cwd;
    }
    if let Some(env) = patch.env {
        base.env.get_or_insert_with(BTreeMap::new).extend(env);
    }
    if patch.display.is_some() {
        base.display = patch.display;
    }
    if patch.runtime_options.is_some() {
        base.runtime_options = patch.runtime_options;
    }
    if patch.env_file.is_some() {
        base.env_file = patch.env_file;
    }
    if patch.argument_strategy.is_some() {
        base.argument_strategy = patch.argument_strategy;
    }
    if let Some(modes) = patch.environment_modes {
        base.environment_modes
            .get_or_insert_with(BTreeMap::new)
            .extend(modes);
    }
}

fn merge_shared_debug(base: &mut SharedDebugSpec, patch: SharedDebugSpec) {
    if patch.adapter_id.is_some() {
        base.adapter_id = patch.adapter_id;
    }
    if patch.request.is_some() {
        base.request = patch.request;
    }
    if patch.available.is_some() {
        base.available = patch.available;
    }
    if patch.launch_config.is_some() {
        base.launch_config = patch.launch_config;
    }
    if patch.env_file.is_some() {
        base.env_file = patch.env_file;
    }
}

fn apply_shared_platform(configuration: &mut SharedConfiguration) {
    let Some(patch) = configuration.platforms.remove(shared_platform_key()) else {
        return;
    };
    if patch.source_file.is_some() {
        configuration.source_file = patch.source_file;
    }
    if let Some(before_launch) = patch.before_launch {
        configuration.before_launch = Some(before_launch);
    }
    if patch.kind.is_some() {
        configuration.kind = patch.kind;
    }
    if let Some(run) = patch.run {
        merge_shared_run(
            configuration.run.get_or_insert_with(SharedRunSpec::default),
            run,
        );
    }
    if let Some(debug) = patch.debug {
        merge_shared_debug(
            configuration
                .debug
                .get_or_insert_with(SharedDebugSpec::default),
            debug,
        );
    }
    if patch.compound.is_some() {
        configuration.compound = patch.compound;
    }
}

fn merge_shared_configuration_patch(
    configuration: &mut SharedConfiguration,
    patch: SharedConfigurationPatch,
) {
    if patch.source_file.is_some() {
        configuration.source_file = patch.source_file;
    }
    if patch.before_launch.is_some() {
        configuration.before_launch = patch.before_launch;
    }
    if patch.kind.is_some() {
        configuration.kind = patch.kind;
    }
    if let Some(run) = patch.run {
        merge_shared_run(
            configuration.run.get_or_insert_with(SharedRunSpec::default),
            run,
        );
    }
    if let Some(debug) = patch.debug {
        merge_shared_debug(
            configuration
                .debug
                .get_or_insert_with(SharedDebugSpec::default),
            debug,
        );
    }
    if patch.compound.is_some() {
        configuration.compound = patch.compound;
    }
}

fn migrate_shared_file(
    mut file: SharedConfigurationFile,
) -> Result<Vec<SharedConfiguration>, String> {
    let version = file
        .version
        .unwrap_or_else(|| if file.runs.is_empty() { 2 } else { 1 });
    if version == 1 {
        if !file.configurations.is_empty() && !file.runs.is_empty() {
            return Err("version 1 cannot contain both `runs` and `configurations`".to_string());
        }
        let values = if file.runs.is_empty() {
            file.configurations
                .into_iter()
                .map(|configuration| serde_json::to_value(configuration).unwrap_or(Value::Null))
                .collect()
        } else {
            file.runs
        };
        file.configurations = values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                let mut configuration: SharedConfiguration = serde_json::from_value(value)
                    .map_err(|error| format!("migrate v1 run at index {index}: {error}"))?;
                if configuration.run.is_none() {
                    let has_run = configuration.executable.is_some()
                        || configuration.args.is_some()
                        || configuration.cwd.is_some()
                        || configuration.env.is_some();
                    if has_run {
                        configuration.run = Some(SharedRunSpec {
                            executable: configuration.executable.take(),
                            args: configuration.args.take(),
                            cwd: configuration.cwd.take(),
                            env: configuration.env.take(),
                            display: configuration.display.take(),
                            runtime_options: configuration.runtime_options.take(),
                            env_file: configuration.env_file.take(),
                            argument_strategy: configuration.argument_strategy.take(),
                            environment_modes: configuration.environment_modes.take(),
                        });
                    }
                }
                if configuration.debug.is_none()
                    && (configuration.adapter_id.is_some() || configuration.launch_config.is_some())
                {
                    configuration.debug = Some(SharedDebugSpec {
                        adapter_id: configuration.adapter_id.take(),
                        request: configuration.request.take(),
                        launch_config: configuration.launch_config.take(),
                        ..SharedDebugSpec::default()
                    });
                }
                Ok(configuration)
            })
            .collect::<Result<Vec<_>, String>>()?;
    } else if version != SHARED_RUN_CONFIG_VERSION {
        return Err(format!(
            "unsupported version {version}; expected 1 or {SHARED_RUN_CONFIG_VERSION}"
        ));
    } else if !file.runs.is_empty() {
        return Err("version 2 uses `configurations`; remove the legacy `runs` array".to_string());
    }
    if file.configurations.is_empty() {
        return Err(
            "shared configuration file must contain at least one configuration".to_string(),
        );
    }
    validate_shared_platforms(&file.templates, "templates")?;
    for configuration in &file.configurations {
        validate_shared_platform_map(
            &configuration.platforms,
            &format!("configuration `{}`", configuration.id),
        )?;
    }
    for configuration in &mut file.configurations {
        let Some(template_id) = configuration.template.clone() else {
            continue;
        };
        let Some(template) = file.templates.get(&template_id) else {
            return Err(format!(
                "configuration `{}` references unknown template `{template_id}`",
                configuration.id
            ));
        };
        let own_patch = SharedConfigurationPatch {
            source_file: configuration.source_file.take(),
            before_launch: configuration.before_launch.take(),
            kind: configuration.kind.take(),
            run: configuration.run.take(),
            debug: configuration.debug.take(),
            compound: configuration.compound.take(),
        };
        merge_shared_configuration_patch(configuration, template.patch.clone());
        if let Some(platform) = template.platforms.get(shared_platform_key()) {
            merge_shared_configuration_patch(configuration, platform.clone());
        }
        merge_shared_configuration_patch(configuration, own_patch);
    }
    Ok(file.configurations)
}

fn validate_shared_platform_map(
    platforms: &BTreeMap<String, SharedConfigurationPatch>,
    field: &str,
) -> Result<(), String> {
    for platform in platforms.keys() {
        if !matches!(platform.as_str(), "linux" | "macos" | "windows") {
            return Err(format!(
                "`{field}.platforms` contains unknown platform `{platform}`"
            ));
        }
    }
    Ok(())
}

fn validate_shared_platforms(
    templates: &BTreeMap<String, SharedTemplate>,
    field: &str,
) -> Result<(), String> {
    for (template_id, template) in templates {
        validate_shared_platform_map(
            &template.platforms,
            &format!("{field} template `{template_id}`"),
        )?;
    }
    Ok(())
}

fn validate_shared_identifier(value: &str, field: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("`{field}` must not be empty"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("`{field}` must not contain control characters"));
    }
    Ok(())
}

fn validate_shared_env(env: &BTreeMap<String, String>, field: &str) -> Result<(), String> {
    let name_pattern = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("valid env regex");
    for name in env.keys() {
        if !name_pattern.is_match(name) {
            return Err(format!(
                "`{field}` contains invalid environment name `{name}`"
            ));
        }
    }
    Ok(())
}

fn validate_string_list(values: &[String], field: &str) -> Result<(), String> {
    if let Some(index) = values.iter().position(|value| value.contains('\0')) {
        return Err(format!("`{field}[{index}]` contains a NUL byte"));
    }
    Ok(())
}

fn provider_project<'a>(
    builder: &'a ModelBuilder,
    reference: Option<&str>,
) -> Result<&'a ProjectModel, String> {
    let Some(reference) = reference.map(str::trim).filter(|value| !value.is_empty()) else {
        return if builder.projects.len() == 1 {
            Ok(&builder.projects[0])
        } else {
            Err(
                "`project` is required when the workspace contains zero or multiple projects"
                    .to_string(),
            )
        };
    };
    let mut matches = builder.projects.iter().filter(|project| {
        project.id == reference
            || project.module == reference
            || project.provider == reference
            || project.root == reference
    });
    let Some(project) = matches.next() else {
        return Err(format!("unknown project `{reference}`"));
    };
    if matches.next().is_some() {
        return Err(format!(
            "project reference `{reference}` is ambiguous; use a project id"
        ));
    }
    Ok(project)
}

fn portable_reference_matches(reference: &str, id: &str, kind: &str, label: &str) -> bool {
    reference == id
        || reference == kind
        || reference == label
        || reference == format!("{kind}:{label}")
}

fn provider_run_configuration<'a>(
    builder: &'a ModelBuilder,
    reference: &str,
    project_id: Option<&str>,
) -> Result<Option<&'a RunConfiguration>, String> {
    let matches = builder
        .run_configurations
        .iter()
        .filter(|candidate| project_id.is_none_or(|id| candidate.project_id == id))
        .filter(|candidate| {
            portable_reference_matches(reference, &candidate.id, &candidate.kind, &candidate.label)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(None),
        [configuration] => Ok(Some(*configuration)),
        _ => Err(format!(
            "provider base `{reference}` is ambiguous; add `project` or use `kind:label`"
        )),
    }
}

fn provider_debug_configuration<'a>(
    builder: &'a ModelBuilder,
    reference: &str,
    project_id: Option<&str>,
) -> Result<Option<&'a DebugConfiguration>, String> {
    let matches = builder
        .debug_configurations
        .iter()
        .filter(|candidate| project_id.is_none_or(|id| candidate.project_id == id))
        .filter(|candidate| {
            portable_reference_matches(
                reference,
                &candidate.id,
                &candidate.adapter_id,
                &candidate.label,
            )
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(None),
        [configuration] => Ok(Some(*configuration)),
        _ => Err(format!(
            "provider base `{reference}` is ambiguous; add `project` or use `adapterId:label`"
        )),
    }
}

fn resolve_build_references(
    builder: &ModelBuilder,
    references: Vec<String>,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for reference in references {
        let matches = builder
            .build_targets
            .iter()
            .filter(|target| target.project_id == project_id)
            .filter(|target| {
                portable_reference_matches(&reference, &target.id, &target.kind, &target.label)
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => return Err(format!("unknown Before launch target `{reference}`")),
            [target] => result.push(target.id.clone()),
            _ => {
                return Err(format!(
                    "Before launch target `{reference}` is ambiguous; use `kind:label`"
                ));
            }
        }
    }
    Ok(result)
}

/// Resolve a compound child using the same portable reference rules as `base`.
/// Shared ids are deliberately converted to the generated model ids so the
/// frontend can execute a compound without knowing repository-file syntax.
fn resolve_compound_child_id(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
    reference: &str,
    project_id: &str,
    debug: bool,
) -> Result<String, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("compound child reference must not be empty".to_string());
    }
    let shared = resolved.iter().find(|candidate| {
        candidate.id == reference
            || format!("shared-run:{}", candidate.id) == reference
            || format!("shared-debug:{}", candidate.id) == reference
    });
    if let Some(candidate) = shared {
        if !debug {
            if candidate.run.is_some() || candidate.compound.is_some() {
                return Ok(format!("shared-run:{}", candidate.id));
            }
        } else if candidate.debug.is_some() || candidate.compound.is_some() {
            return Ok(format!("shared-debug:{}", candidate.id));
        } else if let Some(reference) = candidate.debug_reference.as_deref() {
            // A shared run may inherit its debug target from a provider or
            // another shared entry. Resolve that reference before emitting the
            // compound model id.
            if let Some(debug) = provider_debug_configuration(builder, reference, Some(project_id))?
            {
                return Ok(debug.id.clone());
            }
            if let Some(run) = provider_run_configuration(builder, reference, Some(project_id))? {
                if let Some(debug_id) = &run.debug_configuration_id {
                    return Ok(debug_id.clone());
                }
            }
            if let Some(shared_debug) = resolved.iter().find(|item| item.id == reference) {
                if shared_debug.debug.is_some() || shared_debug.compound.is_some() {
                    return Ok(format!("shared-debug:{reference}"));
                }
            }
        }
        return Err(format!(
            "compound child `{reference}` does not define a {} target",
            if debug { "debug" } else { "run" }
        ));
    }
    if debug {
        if let Some(configuration) =
            provider_debug_configuration(builder, reference, Some(project_id))?
        {
            return Ok(configuration.id.clone());
        }
        if let Some(run) = provider_run_configuration(builder, reference, Some(project_id))? {
            if let Some(debug_id) = &run.debug_configuration_id {
                return Ok(debug_id.clone());
            }
        }
    } else if let Some(configuration) =
        provider_run_configuration(builder, reference, Some(project_id))?
    {
        return Ok(configuration.id.clone());
    }
    Err(format!("unknown compound child `{reference}`"))
}

fn resolve_compound_children(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
    configuration: &ResolvedSharedConfiguration,
    debug: bool,
) -> Result<Vec<String>, String> {
    let Some(compound) = &configuration.compound else {
        return Err("configuration is not compound".to_string());
    };
    let mut result = Vec::with_capacity(compound.configurations.len());
    for reference in &compound.configurations {
        let child_id = resolve_compound_child_id(
            resolved,
            builder,
            reference,
            &configuration.project_id,
            debug,
        )?;
        let child_project = if let Some(shared_id) = child_id.strip_prefix("shared-run:") {
            resolved
                .iter()
                .find(|item| item.id == shared_id)
                .map(|item| &item.project_id)
        } else if let Some(shared_id) = child_id.strip_prefix("shared-debug:") {
            resolved
                .iter()
                .find(|item| item.id == shared_id)
                .map(|item| &item.project_id)
        } else if debug {
            builder
                .debug_configurations
                .iter()
                .find(|item| item.id == child_id)
                .map(|item| &item.project_id)
        } else {
            builder
                .run_configurations
                .iter()
                .find(|item| item.id == child_id)
                .map(|item| &item.project_id)
        };
        if child_project.is_some_and(|project| project != &configuration.project_id) {
            return Err(format!(
                "compound child `{reference}` belongs to another project"
            ));
        }
        result.push(child_id);
    }
    Ok(result)
}

fn resolve_compound_plan_ids(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
    configuration: &ResolvedSharedConfiguration,
    debug: bool,
) -> Result<Vec<String>, String> {
    fn is_cycle_error(error: &str) -> bool {
        error.contains("compound configuration cycle")
    }

    fn visit(
        resolved: &[ResolvedSharedConfiguration],
        builder: &ModelBuilder,
        configuration: &ResolvedSharedConfiguration,
        debug: bool,
        visiting: &mut Vec<String>,
    ) -> Result<Vec<String>, String> {
        if let Some(index) = visiting.iter().position(|id| id == &configuration.id) {
            let mut cycle = visiting[index..].to_vec();
            cycle.push(configuration.id.clone());
            return Err(format!(
                "compound configuration cycle: {}",
                cycle.join(" -> ")
            ));
        }
        visiting.push(configuration.id.clone());
        let child_ids = resolve_compound_children(resolved, builder, configuration, debug)?;
        for child_id in &child_ids {
            let shared_id = if debug {
                child_id.strip_prefix("shared-debug:")
            } else {
                child_id.strip_prefix("shared-run:")
            };
            let Some(shared_id) = shared_id else {
                continue;
            };
            let Some(child) = resolved.iter().find(|item| item.id == shared_id) else {
                return Err(format!("unknown compound child `{shared_id}`"));
            };
            if child.compound.is_some() {
                visit(resolved, builder, child, debug, visiting).map_err(|error| {
                    if is_cycle_error(&error) {
                        error
                    } else {
                        format!(
                            "compound child `{}` is not valid for {}: {error}",
                            child.id,
                            if debug { "Debug" } else { "Run" }
                        )
                    }
                })?;
            }
        }
        visiting.pop();
        Ok(child_ids)
    }

    visit(resolved, builder, configuration, debug, &mut Vec::new())
}

fn validate_compound_configurations(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
) -> Result<(), String> {
    for configuration in resolved.iter().filter(|item| item.compound.is_some()) {
        let run = resolve_compound_plan_ids(resolved, builder, configuration, false);
        let debug = resolve_compound_plan_ids(resolved, builder, configuration, true);
        if let Some(error) = run
            .as_ref()
            .err()
            .filter(|error| error.contains("compound configuration cycle"))
            .or_else(|| {
                debug
                    .as_ref()
                    .err()
                    .filter(|error| error.contains("compound configuration cycle"))
            })
        {
            return Err(error.clone());
        }
        if let (Err(run_error), Err(debug_error)) = (run, debug) {
            return Err(format!(
                "compound configuration `{}` has no valid execution mode; Run: {run_error}; Debug: {debug_error}",
                configuration.id
            ));
        }
    }
    Ok(())
}

fn run_from_provider(base: &RunConfiguration) -> ResolvedSharedRun {
    ResolvedSharedRun {
        executable: base.command.executable.clone(),
        args: base.command.args.clone(),
        cwd: base.command.cwd.clone(),
        env: base.command.env.clone(),
        display: Some(base.command.display.clone()),
        runtime_options: base.runtime_options.clone(),
        env_file: base.env_file.clone(),
        argument_strategy: base.argument_strategy.clone(),
        environment_modes: base.environment_modes.clone(),
    }
}

fn debug_from_provider(base: &DebugConfiguration) -> ResolvedSharedDebug {
    ResolvedSharedDebug {
        adapter_id: base.adapter_id.clone(),
        request: base.request.clone(),
        // Re-probe the merged adapter command below. A shared configuration may
        // replace a provider's missing executable with a repository-specific one.
        available: None,
        launch_config: base.launch_config.clone(),
        env_file: None,
    }
}

fn apply_resolved_run(
    run: &mut ResolvedSharedRun,
    patch: SharedRunSpec,
    workspace_root: &Path,
    project_root: &Path,
) -> Result<(), String> {
    if let Some(executable) = patch.executable {
        run.executable = resolve_shared_executable(&executable, workspace_root, project_root);
    }
    if let Some(args) = patch.args {
        validate_string_list(&args, "run.args")?;
        run.args = args
            .into_iter()
            .map(|value| expand_shared_string(&value, workspace_root, project_root))
            .collect();
    }
    if let Some(cwd) = patch.cwd {
        run.cwd = resolve_shared_path(&cwd, workspace_root, project_root);
    }
    if let Some(env) = patch.env {
        validate_shared_env(&env, "run.env")?;
        run.env.extend(env.into_iter().map(|(name, value)| {
            (
                name,
                expand_shared_string(&value, workspace_root, project_root),
            )
        }));
    }
    if patch.display.is_some() {
        run.display = patch.display;
    }
    if let Some(options) = patch.runtime_options {
        validate_string_list(&options, "run.runtimeOptions")?;
        run.runtime_options = Some(options);
    }
    if let Some(env_file) = patch.env_file {
        run.env_file = Some(resolve_shared_path(&env_file, workspace_root, project_root));
    }
    if let Some(strategy) = patch.argument_strategy {
        if !matches!(
            strategy.as_str(),
            "append" | "maven-exec" | "gradle-javaexec"
        ) {
            return Err(format!("invalid run.argumentStrategy `{strategy}`"));
        }
        run.argument_strategy = Some(strategy);
    }
    if let Some(modes) = patch.environment_modes {
        validate_shared_env(&modes, "run.environmentModes")?;
        if let Some((name, mode)) = modes
            .iter()
            .find(|(_, mode)| !matches!(mode.as_str(), "append" | "replace"))
        {
            return Err(format!("invalid environment mode `{mode}` for `{name}`"));
        }
        run.environment_modes
            .get_or_insert_with(BTreeMap::new)
            .extend(modes);
    }
    Ok(())
}

fn apply_resolved_debug(
    debug: &mut ResolvedSharedDebug,
    patch: SharedDebugSpec,
    workspace_root: &Path,
    project_root: &Path,
) -> Result<(), String> {
    if let Some(adapter_id) = patch.adapter_id {
        validate_shared_identifier(&adapter_id, "debug.adapterId")?;
        debug.adapter_id = adapter_id;
    }
    if let Some(request) = patch.request {
        if !matches!(request.as_str(), "launch" | "attach") {
            return Err(format!("invalid debug.request `{request}`"));
        }
        debug.request = request;
    }
    if patch.available.is_some() {
        debug.available = patch.available;
    }
    if let Some(mut launch_config) = patch.launch_config {
        if !launch_config.is_object() {
            return Err("`debug.launchConfig` must be an object".to_string());
        }
        expand_shared_value(&mut launch_config, workspace_root, project_root);
        debug.launch_config = launch_config;
    }
    if let Some(env_file) = patch.env_file {
        debug.env_file = Some(resolve_shared_path(&env_file, workspace_root, project_root));
    }
    if let Some(object) = debug.launch_config.as_object_mut() {
        object.insert("request".to_string(), Value::String(debug.request.clone()));
    }
    Ok(())
}

fn resolve_shared_configuration(
    mut configuration: SharedConfiguration,
    builder: &ModelBuilder,
    workspace_root: &Path,
) -> Result<ResolvedSharedConfiguration, String> {
    validate_shared_identifier(&configuration.id, "id")?;
    apply_shared_platform(&mut configuration);
    if let Some(compound) = &configuration.compound {
        if compound.configurations.is_empty() {
            return Err("compound configuration must list at least one child".to_string());
        }
        let mut children = BTreeSet::new();
        for child in &compound.configurations {
            validate_shared_identifier(child, "compound.configurations entry")?;
            if !children.insert(child.trim()) {
                return Err(format!(
                    "compound configuration contains duplicate child `{child}`"
                ));
            }
        }
        if configuration.run.is_some()
            || configuration.debug.is_some()
            || configuration.base.is_some()
            || configuration.debug_reference.is_some()
        {
            return Err("compound configuration cannot also define run, debug, base, or debugConfigurationId".to_string());
        }
    }

    let requested_project = configuration
        .project_id
        .as_deref()
        .or(configuration.project.as_deref())
        .map(|reference| provider_project(builder, Some(reference)))
        .transpose()?;
    let provider_run = configuration
        .base
        .as_deref()
        .map(|reference| {
            provider_run_configuration(
                builder,
                reference,
                requested_project.map(|project| project.id.as_str()),
            )
        })
        .transpose()?
        .flatten();
    let provider_debug = if provider_run.is_none() {
        configuration
            .base
            .as_deref()
            .map(|reference| {
                provider_debug_configuration(
                    builder,
                    reference,
                    requested_project.map(|project| project.id.as_str()),
                )
            })
            .transpose()?
            .flatten()
    } else {
        None
    };
    if configuration.base.is_some() && provider_run.is_none() && provider_debug.is_none() {
        return Err(format!(
            "unknown provider base `{}`",
            configuration.base.as_deref().unwrap_or_default()
        ));
    }

    let project_reference = configuration
        .project_id
        .as_deref()
        .or(configuration.project.as_deref());
    let standalone_project;
    let project = if let Some(base) = provider_run {
        builder
            .projects
            .iter()
            .find(|project| project.id == base.project_id)
            .ok_or_else(|| format!("provider base `{}` has no project", base.id))?
    } else if let Some(base) = provider_debug {
        builder
            .projects
            .iter()
            .find(|project| project.id == base.project_id)
            .ok_or_else(|| format!("provider base `{}` has no project", base.id))?
    } else if builder.projects.is_empty() && project_reference.is_none() {
        standalone_project = shared_project_model(workspace_root);
        &standalone_project
    } else {
        requested_project.unwrap_or(provider_project(builder, project_reference)?)
    };
    if project_reference.is_some()
        && !matches!(provider_project(builder, project_reference), Ok(candidate) if candidate.id == project.id)
    {
        return Err("`project` does not match the selected provider base".to_string());
    }
    let project_root = Path::new(&project.root);

    let source_file = configuration
        .source_file
        .as_deref()
        .map(|value| resolve_shared_path(value, workspace_root, project_root))
        .or_else(|| {
            provider_run
                .and_then(|base| base.source_file.clone())
                .or_else(|| provider_debug.and_then(|base| base.source_file.clone()))
        });
    let before_launch_references = configuration.before_launch.clone().unwrap_or_else(|| {
        provider_run
            .map(|base| base.pre_launch_targets.clone())
            .or_else(|| provider_debug.map(|base| base.pre_launch_targets.clone()))
            .unwrap_or_default()
    });
    let before_launch = resolve_build_references(builder, before_launch_references, &project.id)?;

    let mut run = if let Some(base) = provider_run {
        Some(run_from_provider(base))
    } else {
        configuration.run.as_ref().map(|_| ResolvedSharedRun {
            cwd: project.root.clone(),
            ..ResolvedSharedRun::default()
        })
    };
    if let Some(patch) = configuration.run {
        apply_resolved_run(
            run.get_or_insert_with(|| ResolvedSharedRun {
                cwd: project.root.clone(),
                ..ResolvedSharedRun::default()
            }),
            patch,
            workspace_root,
            project_root,
        )?;
    }
    if let Some(run) = &run {
        validate_shared_identifier(&run.executable, "run.executable")?;
    }

    let mut debug = if let Some(base) = provider_debug {
        Some(debug_from_provider(base))
    } else if let Some(base) = provider_run.and_then(|run| {
        run.debug_configuration_id.as_ref().and_then(|id| {
            builder
                .debug_configurations
                .iter()
                .find(|debug| debug.id == *id)
        })
    }) {
        Some(debug_from_provider(base))
    } else {
        configuration
            .debug
            .as_ref()
            .map(|_| ResolvedSharedDebug::default())
    };
    if let Some(patch) = configuration.debug {
        apply_resolved_debug(
            debug.get_or_insert_with(ResolvedSharedDebug::default),
            patch,
            workspace_root,
            project_root,
        )?;
    }
    if let Some(debug) = &debug {
        validate_shared_identifier(&debug.adapter_id, "debug.adapterId")?;
        if !debug.launch_config.is_object() {
            return Err("`debug.launchConfig` must be an object".to_string());
        }
    }
    if run.is_none() && debug.is_none() && configuration.compound.is_none() {
        return Err("configuration must define `run`, `debug`, or a provider `base`".to_string());
    }

    Ok(ResolvedSharedConfiguration {
        id: configuration.id.trim().to_string(),
        label: configuration
            .name
            .or(configuration.label)
            .unwrap_or_else(|| configuration.id.clone()),
        kind: configuration
            .kind
            .or_else(|| provider_run.map(|base| base.kind.clone()))
            .unwrap_or_else(|| "shared".to_string()),
        project_id: project.id.clone(),
        source_file,
        before_launch,
        run,
        debug,
        debug_reference: configuration.debug_reference,
        compound: configuration.compound,
    })
}

fn merge_shared_configurations(builder: &mut ModelBuilder, workspace_root: &Path) {
    let path = workspace_root.join(SHARED_RUN_CONFIG_RELATIVE_PATH);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration: read {}: {error}",
                path.display()
            ));
            return;
        }
    };
    if contents.len() as u64 > MAX_SOURCE_BYTES {
        builder.diagnostics.push(format!(
            "Shared Run/Debug configuration: {} exceeds the 2 MiB limit",
            path.display()
        ));
        return;
    }
    let file: SharedConfigurationFile = match serde_json::from_str(&contents) {
        Ok(file) => file,
        Err(error) => {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration: parse {}: {error}",
                path.display()
            ));
            return;
        }
    };
    let configurations = match migrate_shared_file(file) {
        Ok(configurations) => configurations,
        Err(error) => {
            builder
                .diagnostics
                .push(format!("Shared Run/Debug configuration: {error}"));
            return;
        }
    };
    let mut ids = BTreeSet::new();
    for configuration in &configurations {
        if !ids.insert(configuration.id.trim().to_string()) {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration `{}`: duplicate id",
                configuration.id
            ));
        }
    }
    if !builder.diagnostics.is_empty() {
        return;
    }
    let known_adapter_ids = ["java", "lldb", "delve", "python", "node", "coreclr"]
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut resolved = Vec::new();
    for configuration in configurations {
        let id = configuration.id.clone();
        match resolve_shared_configuration(configuration, builder, workspace_root) {
            Ok(configuration) => resolved.push(configuration),
            Err(error) => builder
                .diagnostics
                .push(format!("Shared Run/Debug configuration `{id}`: {error}")),
        }
    }
    if !builder.diagnostics.is_empty() {
        return;
    }
    if let Err(error) = validate_compound_configurations(&resolved, builder) {
        builder
            .diagnostics
            .push(format!("Shared Run/Debug configuration: {error}"));
        return;
    }

    if builder.projects.is_empty() && !resolved.is_empty() {
        builder.register_project(shared_project_model(workspace_root));
    }

    let shared_debug_ids = resolved
        .iter()
        .filter(|configuration| {
            configuration.debug.is_some()
                || (configuration.compound.is_some()
                    && resolve_compound_plan_ids(&resolved, builder, configuration, true).is_ok())
        })
        .map(|configuration| configuration.id.clone())
        .collect::<BTreeSet<_>>();
    let provider_debug_ids = builder
        .debug_configurations
        .iter()
        .map(|configuration| configuration.id.clone())
        .collect::<BTreeSet<_>>();
    for configuration in &resolved {
        let Some(reference) = configuration.debug_reference.as_deref() else {
            continue;
        };
        if !provider_debug_ids.contains(reference) && !shared_debug_ids.contains(reference) {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration `{}`: unknown debug reference `{reference}`",
                configuration.id
            ));
        }
    }
    if !builder.diagnostics.is_empty() {
        return;
    }
    let resolved_snapshot = resolved.clone();
    for configuration in resolved {
        let compound_run_plan = configuration
            .compound
            .as_ref()
            .map(|_| resolve_compound_plan_ids(&resolved_snapshot, builder, &configuration, false));
        let compound_debug_plan = configuration
            .compound
            .as_ref()
            .map(|_| resolve_compound_plan_ids(&resolved_snapshot, builder, &configuration, true));
        let compound_run_ids = compound_run_plan
            .as_ref()
            .and_then(|plan| plan.as_ref().ok())
            .cloned();
        let compound_debug_ids = compound_debug_plan
            .as_ref()
            .and_then(|plan| plan.as_ref().ok())
            .cloned();
        let compound_debug_error = compound_debug_plan
            .as_ref()
            .and_then(|plan| plan.as_ref().err())
            .cloned();
        let debug_id = configuration
            .debug
            .clone()
            .map(|debug| {
                let id = format!("shared-debug:{}", configuration.id);
                let adapter_available = known_adapter_ids.contains(debug.adapter_id.as_str());
                let adapter_command_available = debug
                    .launch_config
                    .get("adapterCommand")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .and_then(resolve_candidate)
                    .is_some();
                let available = debug.available.unwrap_or(true)
                    && adapter_available
                    && (debug.adapter_id == "java" || adapter_command_available);
                let diagnostic = if !adapter_available {
                    Some(format!(
                        "Debug adapter `{}` is not registered by Code Workspace",
                        debug.adapter_id
                    ))
                } else if debug.adapter_id != "java" && !adapter_command_available {
                    Some(format!(
                        "Debug adapter executable for `{}` was not found",
                        debug.adapter_id
                    ))
                } else if !debug.available.unwrap_or(true) {
                    Some("Shared configuration explicitly disabled this debug target".to_string())
                } else {
                    None
                };
                builder.debug_configurations.push(DebugConfiguration {
                    id: id.clone(),
                    project_id: configuration.project_id.clone(),
                    label: configuration.label.clone(),
                    adapter_id: debug.adapter_id,
                    request: debug.request,
                    available,
                    diagnostic,
                    pre_launch_targets: configuration.before_launch.clone(),
                    source_file: configuration.source_file.clone(),
                    launch_config: debug.launch_config,
                    env_file: debug.env_file,
                    configuration_source: Some("shared".to_string()),
                    compound_configuration_ids: configuration
                        .compound
                        .as_ref()
                        .and(compound_debug_ids.clone()),
                    compound_parallel: configuration
                        .compound
                        .as_ref()
                        .and_then(|compound| compound.parallel),
                    compound_stop_on_failure: configuration
                        .compound
                        .as_ref()
                        .and_then(|compound| compound.stop_on_failure),
                });
                id
            })
            .or_else(|| {
                configuration.debug_reference.as_ref().map(|reference| {
                    if shared_debug_ids.contains(reference.as_str()) {
                        format!("shared-debug:{reference}")
                    } else {
                        reference.clone()
                    }
                })
            });
        let project_id = configuration.project_id.clone();
        let source_file = configuration.source_file.clone();
        let pre_launch_targets = configuration.before_launch.clone();
        let project_cwd = builder
            .projects
            .iter()
            .find(|project| project.id == configuration.project_id)
            .map(|project| project.root.clone())
            .unwrap_or_else(|| path_string(workspace_root));
        let label = configuration.label.clone();
        if let Some(run) = configuration.run {
            let display = run.display.unwrap_or_else(|| {
                std::iter::once(shell_preview(&run.executable))
                    .chain(run.args.iter().map(|arg| shell_preview(arg)))
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            let source = if resolve_candidate(&run.executable).is_some() {
                "configured"
            } else {
                "path"
            };
            let error = (resolve_candidate(&run.executable).is_none()).then(|| {
                format!(
                    "Shared executable `{}` was not found on this platform",
                    run.executable
                )
            });
            builder.run_configurations.push(RunConfiguration {
                id: format!("shared-run:{}", configuration.id),
                project_id,
                label: label.clone(),
                kind: configuration.kind,
                command: ExecutionCommand {
                    executable: run.executable,
                    args: run.args,
                    cwd: run.cwd,
                    env: run.env,
                    display,
                    source: source.to_string(),
                    error,
                },
                source_file,
                pre_launch_targets: pre_launch_targets,
                debug_configuration_id: debug_id,
                runtime_options: run.runtime_options,
                env_file: run.env_file,
                argument_strategy: run.argument_strategy,
                environment_modes: run.environment_modes,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: configuration
                    .compound
                    .as_ref()
                    .and(compound_run_ids.clone()),
                compound_parallel: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.parallel),
                compound_stop_on_failure: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.stop_on_failure),
            });
        } else if let Some(debug_configuration_id) = debug_id {
            // Keep debug-only shared entries selectable by the editor. IDEA
            // exposes these in the same Run/Debug configuration chooser even
            // though invoking Run is unavailable; the explicit error keeps the
            // Run panel from attempting to spawn a sentinel executable.
            builder.run_configurations.push(RunConfiguration {
                id: format!("shared-run:{}", configuration.id),
                project_id,
                label: configuration.label,
                kind: "debug-only".to_string(),
                command: ExecutionCommand {
                    executable: "__taomni_debug_only__".to_string(),
                    args: Vec::new(),
                    cwd: project_cwd,
                    env: BTreeMap::new(),
                    display: "Debug only".to_string(),
                    source: "configured".to_string(),
                    error: Some(
                        "This configuration is debug-only; choose Debug to launch it".to_string(),
                    ),
                },
                source_file,
                pre_launch_targets,
                debug_configuration_id: Some(debug_configuration_id),
                runtime_options: None,
                env_file: None,
                argument_strategy: None,
                environment_modes: None,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: configuration.compound.as_ref().and(compound_run_ids),
                compound_parallel: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.parallel),
                compound_stop_on_failure: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.stop_on_failure),
            });
        } else if configuration.compound.is_some() {
            let run_ids = compound_run_ids.clone();
            let debug_ids = compound_debug_ids.clone();
            let compound_debug_id = format!("shared-debug:{}", configuration.id);
            let compound = configuration.compound.as_ref().expect("compound exists");
            let debug_diagnostic =
                compound_debug_error.map(|error| format!("Compound Debug is unavailable: {error}"));
            let debug_available =
                debug_diagnostic.is_none() && debug_ids.as_ref().is_some_and(|ids| !ids.is_empty());
            builder.debug_configurations.push(DebugConfiguration {
                id: compound_debug_id.clone(),
                project_id: configuration.project_id.clone(),
                label: configuration.label.clone(),
                adapter_id: "compound".to_string(),
                request: "launch".to_string(),
                available: debug_available,
                diagnostic: debug_diagnostic.clone(),
                pre_launch_targets: configuration.before_launch.clone(),
                source_file: configuration.source_file.clone(),
                launch_config: json!({
                    "request": "launch",
                    "compoundConfigurations": debug_ids.clone().unwrap_or_default(),
                    "parallel": compound.parallel.unwrap_or(false),
                    "stopOnFailure": compound.stop_on_failure.unwrap_or(true),
                    "unavailableReason": debug_diagnostic,
                }),
                env_file: None,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: debug_ids,
                compound_parallel: compound.parallel,
                compound_stop_on_failure: compound.stop_on_failure,
            });
            let run_ids = run_ids.unwrap_or_default();
            let run_error = if run_ids.is_empty() {
                Some("Compound configuration has no valid Run children".to_string())
            } else {
                None
            };
            let compound = configuration.compound.as_ref().expect("compound exists");
            builder.run_configurations.push(RunConfiguration {
                id: format!("shared-run:{}", configuration.id),
                project_id: configuration.project_id.clone(),
                label: configuration.label,
                kind: "compound".to_string(),
                command: ExecutionCommand {
                    executable: "__taomni_compound__".to_string(),
                    args: Vec::new(),
                    cwd: project_cwd,
                    env: BTreeMap::new(),
                    display: "Compound configuration".to_string(),
                    source: "configured".to_string(),
                    error: run_error,
                },
                source_file,
                pre_launch_targets,
                debug_configuration_id: Some(compound_debug_id),
                runtime_options: None,
                env_file: None,
                argument_strategy: None,
                environment_modes: None,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: Some(run_ids),
                compound_parallel: compound.parallel,
                compound_stop_on_failure: compound.stop_on_failure,
            });
        }
    }

    // Compound entries are emitted alongside their leaves, so a parent may be
    // seen before a nested child. Resolve availability after the complete graph
    // exists and propagate an unavailable leaf/child diagnostic to every parent.
    let mut availability = builder
        .debug_configurations
        .iter()
        .map(|configuration| {
            (
                configuration.id.clone(),
                (
                    configuration.available,
                    configuration.diagnostic.clone(),
                    configuration.compound_configuration_ids.clone(),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let compound_ids = availability
        .iter()
        .filter_map(|(id, (_, _, children))| children.as_ref().map(|_| id.clone()))
        .collect::<Vec<_>>();
    for _ in 0..compound_ids.len().max(1) {
        let mut changed = false;
        for id in &compound_ids {
            let Some((true, _, Some(children))) = availability.get(id).cloned() else {
                continue;
            };
            if let Some(child_id) = children.iter().find(|child_id| {
                availability
                    .get(*child_id)
                    .is_none_or(|(available, _, _)| !available)
            }) {
                let reason = availability
                    .get(child_id)
                    .and_then(|(_, diagnostic, _)| diagnostic.clone())
                    .unwrap_or_else(|| "debug configuration is unavailable".to_string());
                availability.insert(
                    id.clone(),
                    (
                        false,
                        Some(format!(
                            "Compound Debug child `{child_id}` is unavailable: {reason}"
                        )),
                        Some(children),
                    ),
                );
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    for configuration in &mut builder.debug_configurations {
        let Some((available, diagnostic, _)) = availability.get(&configuration.id) else {
            continue;
        };
        configuration.available = *available;
        configuration.diagnostic = diagnostic.clone();
        if configuration.compound_configuration_ids.is_some() {
            if let Some(object) = configuration.launch_config.as_object_mut() {
                object.insert(
                    "unavailableReason".to_string(),
                    diagnostic.clone().map(Value::String).unwrap_or(Value::Null),
                );
            }
        }
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
    merge_shared_configurations(&mut builder, root);
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
    fn models_modules_source_sets_language_levels_and_compile_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join("rust/Cargo.toml"),
            "[package]\nname='native-app'\nversion='0.1.0'\nedition='2024'\n",
        );
        write(&directory.path().join("rust/src/main.rs"), "fn main() {}\n");
        write(
            &directory.path().join("rust/tests/smoke.rs"),
            "#[test] fn smoke() {}\n",
        );
        write(
            &directory.path().join("jvm/pom.xml"),
            "<project><properties><maven.compiler.release>${java.version}</maven.compiler.release><java.version>21</java.version></properties></project>\n",
        );
        write(
            &directory.path().join("jvm/src/main/java/App.java"),
            "class App {}\n",
        );
        write(
            &directory.path().join("jvm/src/test/java/AppTest.java"),
            "class AppTest {}\n",
        );
        write(
            &directory
                .path()
                .join("jvm/target/generated-sources/annotations/Generated.java"),
            "class Generated {}\n",
        );

        let available_tool = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let available_config = WorkspaceToolConfig {
            cargo: Some(available_tool.clone()),
            maven: Some(available_tool),
            ..Default::default()
        };
        let model =
            detect_execution_model(directory.path(), None, Some(&available_config)).unwrap();
        assert_eq!(model.modules.len(), model.projects.len());
        for project in &model.projects {
            let module = model
                .modules
                .iter()
                .find(|module| module.id == project.module_id)
                .expect("project module");
            assert_eq!(module.project_id, project.id);
            assert!(!module.source_set_ids.is_empty());
            assert!(module.source_set_ids.iter().all(|id| {
                model
                    .source_sets
                    .iter()
                    .any(|source_set| source_set.id == *id && source_set.module_id == module.id)
            }));
        }

        let rust = model
            .projects
            .iter()
            .find(|project| project.provider == "cargo")
            .expect("Cargo project");
        assert_eq!(rust.language_level.as_deref(), Some("rust:2024"));
        let rust_sets = model
            .source_sets
            .iter()
            .filter(|source_set| source_set.module_id == rust.module_id)
            .collect::<Vec<_>>();
        assert!(
            rust_sets
                .iter()
                .any(|source_set| source_set.kind == "production")
        );
        assert!(rust_sets.iter().any(|source_set| source_set.kind == "test"));

        let jvm = model
            .projects
            .iter()
            .find(|project| project.provider == "maven")
            .expect("Maven project");
        assert_eq!(jvm.language_level.as_deref(), Some("java:21"));
        let jvm_sets = model
            .source_sets
            .iter()
            .filter(|source_set| source_set.module_id == jvm.module_id)
            .collect::<Vec<_>>();
        assert!(
            jvm_sets
                .iter()
                .any(|source_set| source_set.kind == "production")
        );
        assert!(jvm_sets.iter().any(|source_set| source_set.kind == "test"));
        assert!(jvm_sets.iter().any(|source_set| source_set.generated));

        for target in &model.build_targets {
            assert!(
                model
                    .modules
                    .iter()
                    .any(|module| module.id == target.module_id)
            );
            if target.kind == "build" {
                assert_eq!(target.artifact_ids.len(), 1);
            } else {
                assert!(target.artifact_ids.is_empty());
            }
        }
        assert!(!model.compile_artifacts.is_empty());
        for artifact in &model.compile_artifacts {
            assert!(
                artifact.path.is_none(),
                "provider output must not be guessed"
            );
            assert_eq!(artifact.resolution, "pending-provider-output");
            assert!(artifact.diagnostic.is_some());
            assert!(model.build_targets.iter().any(|target| {
                target.id == artifact.target_id
                    && target.module_id == artifact.module_id
                    && target.artifact_ids.contains(&artifact.id)
            }));
        }

        let missing_tool = directory
            .path()
            .join("missing-build-tool")
            .to_string_lossy()
            .to_string();
        let missing_config = WorkspaceToolConfig {
            cargo: Some(missing_tool.clone()),
            maven: Some(missing_tool),
            ..Default::default()
        };
        let blocked_model =
            detect_execution_model(directory.path(), None, Some(&missing_config)).unwrap();
        assert!(!blocked_model.compile_artifacts.is_empty());
        for artifact in &blocked_model.compile_artifacts {
            assert_eq!(artifact.resolution, "blocked");
            assert!(
                artifact
                    .diagnostic
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Configured executable")
            );
        }
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

    #[test]
    fn migrates_v1_shared_runs_and_expands_workspace_variables() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            r#"{
              "version": 1,
              "runs": [{
                "id": "legacy",
                "name": "Legacy task",
                "executable": "cargo",
                "args": ["run", "--manifest-path", "$PROJECT_DIR$/Cargo.toml"],
                "cwd": "${workspaceRoot}",
                "env": { "WORKSPACE": "${workspaceRoot}" }
              }]
            }"#,
        );
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
        let run = model
            .run_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-run:legacy")
            .expect("migrated shared run");
        assert_eq!(run.label, "Legacy task");
        assert_eq!(run.command.executable, "cargo");
        assert_eq!(run.command.cwd, path_string(directory.path()));
        assert_eq!(run.command.env["WORKSPACE"], path_string(directory.path()));
        assert_eq!(run.configuration_source.as_deref(), Some("shared"));
        assert!(run.command.args[2].ends_with("Cargo.toml"));
        assert!(
            model
                .projects
                .iter()
                .any(|project| project.id == "shared:workspace")
        );
    }

    #[test]
    fn loads_shared_run_debug_templates_and_current_platform_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let executable_string = path_string(&executable);
        write(
            &directory.path().join("Cargo.toml"),
            "[package]\nname='demo'\nversion='0.1.0'\n",
        );
        write(&directory.path().join("src/main.rs"), "fn main() {}\n");
        let initial = detect_execution_model(directory.path(), None, None).unwrap();
        let base = initial
            .run_configurations
            .iter()
            .find(|configuration| configuration.kind == "bin")
            .expect("provider run");
        let build = base.pre_launch_targets.first().expect("provider build");
        let config = json!({
            "version": 2,
            "templates": {
                "integration": {
                    "run": {
                        "env": { "FROM_TEMPLATE": "yes" },
                        "runtimeOptions": ["--trace"]
                    }
                }
            },
            "configurations": [{
                "id": "team",
                "name": "Team launch",
                "base": base.id,
                "template": "integration",
                "sourceFile": "src/main.rs",
                "beforeLaunch": [build],
                "run": {
                    "args": ["--team"],
                    "cwd": "${projectRoot}",
                    "envFile": ".env.team"
                },
                "debug": {
                    "adapterId": "lldb",
                    "request": "attach",
                    "launchConfig": {
                        "adapterCommand": executable_string,
                        "adapterCwd": "${projectRoot}",
                        "arguments": { "program": "$PROJECT_DIR$/target/demo" }
                    }
                },
                "platforms": {
                    shared_platform_key(): {
                        "run": { "env": { "PLATFORM": shared_platform_key() } }
                    }
                }
            }]
        });
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            &serde_json::to_string_pretty(&config).unwrap(),
        );

        let model = detect_execution_model(directory.path(), None, None).unwrap();
        assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
        let run = model
            .run_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-run:team")
            .expect("shared run");
        assert_eq!(run.command.args, ["--team"]);
        assert_eq!(run.command.env["FROM_TEMPLATE"], "yes");
        assert_eq!(run.command.env["PLATFORM"], shared_platform_key());
        assert_eq!(
            run.runtime_options.as_deref(),
            Some(["--trace".to_string()].as_slice())
        );
        assert!(run.env_file.as_deref().unwrap().ends_with(".env.team"));
        assert_eq!(
            run.debug_configuration_id.as_deref(),
            Some("shared-debug:team")
        );
        assert_eq!(
            run.source_file.as_deref(),
            Some(path_string(&directory.path().join("src/main.rs")).as_str())
        );
        let debug = model
            .debug_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-debug:team")
            .expect("shared debug");
        assert_eq!(debug.request, "attach");
        assert_eq!(debug.launch_config["request"], "attach");
        assert_eq!(
            debug.launch_config["adapterCwd"],
            path_string(directory.path())
        );
        assert!(debug.available);
    }

    #[test]
    fn invalid_shared_files_are_atomic_and_report_actionable_diagnostics() {
        let cases = [
            (
                "duplicate",
                r#"{"version":2,"configurations":[{"id":"same","run":{"executable":"cargo"}},{"id":"same","run":{"executable":"cargo"}}]}"#,
                "duplicate id",
            ),
            (
                "base",
                r#"{"version":2,"configurations":[{"id":"bad","base":"run:missing"}]}"#,
                "unknown provider base",
            ),
            (
                "debug-reference",
                r#"{"version":2,"configurations":[{"id":"bad","debugConfigurationId":"missing","run":{"executable":"cargo"}}]}"#,
                "unknown debug reference",
            ),
            (
                "env",
                r#"{"version":2,"configurations":[{"id":"bad","run":{"executable":"cargo","env":{"NOT VALID":"x"}}}]}"#,
                "invalid environment name",
            ),
            (
                "before-launch",
                r#"{"version":2,"configurations":[{"id":"bad","beforeLaunch":["build:missing"],"run":{"executable":"cargo"}}]}"#,
                "unknown Before launch target",
            ),
        ];
        for (name, contents, expected) in cases {
            let directory = tempfile::tempdir().unwrap();
            write(
                &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
                contents,
            );
            let model = detect_execution_model(directory.path(), None, None).unwrap();
            assert!(
                model
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.contains(expected)),
                "{name}: {:?}",
                model.diagnostics
            );
            assert!(
                model
                    .run_configurations
                    .iter()
                    .all(
                        |configuration| configuration.configuration_source.as_deref()
                            != Some("shared")
                    ),
                "{name} partially merged"
            );
        }
    }

    #[test]
    fn missing_shared_file_is_silent() {
        let directory = tempfile::tempdir().unwrap();
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        assert!(model.diagnostics.is_empty());
        assert!(model.run_configurations.is_empty());
    }

    #[test]
    fn debug_only_shared_configuration_is_exposed_without_becoming_runnable() {
        let directory = tempfile::tempdir().unwrap();
        let adapter = path_string(&std::env::current_exe().unwrap());
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            &serde_json::to_string(&json!({
                "version": 2,
                "configurations": [{
                    "id": "debug-only",
                    "debug": {
                        "adapterId": "lldb",
                        "request": "launch",
                        "launchConfig": { "adapterCommand": adapter }
                    }
                }]
            }))
            .unwrap(),
        );
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        let run = model
            .run_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-run:debug-only")
            .expect("debug-only chooser entry");
        assert_eq!(run.kind, "debug-only");
        assert!(run.command.error.is_some());
        assert_eq!(run.configuration_source.as_deref(), Some("shared"));
        let debug = model
            .debug_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-debug:debug-only")
            .expect("debug-only debug entry");
        assert!(debug.available);
        assert_eq!(debug.configuration_source.as_deref(), Some("shared"));
    }

    #[test]
    fn compound_run_and_debug_resolve_children_with_group_launch_semantics() {
        let directory = tempfile::tempdir().unwrap();
        let adapter = path_string(&std::env::current_exe().unwrap());
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            &serde_json::to_string(&json!({
                "version": 2,
                "configurations": [
                    {
                        "id": "one",
                        "run": {"executable": "cargo", "args": ["run"]},
                        "debug": {"adapterId": "lldb", "launchConfig": {"adapterCommand": adapter}}
                    },
                    {
                        "id": "two",
                        "run": {"executable": "cargo", "args": ["test"]},
                        "debug": {"adapterId": "lldb", "launchConfig": {"adapterCommand": adapter}}
                    },
                    {"id":"all","compound":{"configurations":["one","two"],"parallel":true,"stopOnFailure":false}}
                ]
            }))
            .unwrap(),
        );
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
        let run = model
            .run_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-run:all")
            .expect("compound run");
        assert_eq!(run.kind, "compound");
        assert_eq!(
            run.compound_configuration_ids.as_deref(),
            Some(["shared-run:one".to_string(), "shared-run:two".to_string()].as_slice())
        );
        assert_eq!(run.compound_parallel, Some(true));
        assert_eq!(run.compound_stop_on_failure, Some(false));
        let debug = model
            .debug_configurations
            .iter()
            .find(|configuration| configuration.id == "shared-debug:all")
            .expect("compound debug chooser");
        assert!(debug.available, "{:?}", debug.diagnostic);
        assert_eq!(
            debug.compound_configuration_ids.as_deref(),
            Some(
                [
                    "shared-debug:one".to_string(),
                    "shared-debug:two".to_string()
                ]
                .as_slice()
            )
        );
        assert_eq!(debug.compound_parallel, Some(true));
        assert_eq!(debug.compound_stop_on_failure, Some(false));
    }

    #[test]
    fn compound_debug_propagates_unavailable_leaf_diagnostics() {
        let directory = tempfile::tempdir().unwrap();
        let adapter = path_string(&std::env::current_exe().unwrap());
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            &serde_json::to_string(&json!({
                "version": 2,
                "configurations": [
                    {
                        "id": "disabled",
                        "debug": {
                            "adapterId": "lldb",
                            "available": false,
                            "launchConfig": {"adapterCommand": adapter}
                        }
                    },
                    {"id": "nested", "compound": {"configurations": ["disabled"]}},
                    {"id": "all", "compound": {"configurations": ["nested"]}}
                ]
            }))
            .unwrap(),
        );
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        for id in ["shared-debug:nested", "shared-debug:all"] {
            let debug = model
                .debug_configurations
                .iter()
                .find(|configuration| configuration.id == id)
                .expect("compound debug chooser");
            assert!(!debug.available, "{id} should be unavailable");
            assert!(
                debug
                    .diagnostic
                    .as_deref()
                    .unwrap_or_default()
                    .contains("unavailable"),
                "{id}: {:?}",
                debug.diagnostic
            );
        }
    }

    #[test]
    fn compound_invalid_child_is_atomic_and_does_not_fall_back_to_empty_plan() {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            r#"{"version":2,"configurations":[{"id":"bad","compound":{"configurations":["missing"]}}]}"#,
        );
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        assert!(
            model
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.contains("unknown compound child")),
            "{:?}",
            model.diagnostics
        );
        assert!(
            model
                .run_configurations
                .iter()
                .all(
                    |configuration| configuration.configuration_source.as_deref() != Some("shared")
                )
        );
    }

    #[test]
    fn maven_multi_module_hierarchy_links_parent_and_children() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write(
            &root.join("pom.xml"),
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0.0</version><packaging>pom</packaging><modules><module>core</module><module>web</module></modules></project>"#,
        );
        fs::create_dir_all(root.join("core/src/main/java")).unwrap();
        write(
            &root.join("core/pom.xml"),
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0.0</version></parent><artifactId>core</artifactId></project>"#,
        );
        fs::create_dir_all(root.join("web/src/main/java")).unwrap();
        write(
            &root.join("web/pom.xml"),
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0.0</version></parent><artifactId>web</artifactId></project>"#,
        );

        let model = detect_execution_model(root, None, None).unwrap();
        let root_mod = model
            .modules
            .iter()
            .find(|m| m.root == path_string(root))
            .expect("root module");
        let core_mod = model
            .modules
            .iter()
            .find(|m| m.root == path_string(&root.join("core")))
            .expect("core module");
        let web_mod = model
            .modules
            .iter()
            .find(|m| m.root == path_string(&root.join("web")))
            .expect("web module");

        assert_eq!(root_mod.child_module_ids.len(), 2);
        assert!(root_mod.child_module_ids.contains(&core_mod.id));
        assert!(root_mod.child_module_ids.contains(&web_mod.id));
        assert_eq!(
            core_mod.parent_module_id.as_deref(),
            Some(root_mod.id.as_str())
        );
        assert_eq!(
            web_mod.parent_module_id.as_deref(),
            Some(root_mod.id.as_str())
        );
    }

    #[test]
    fn gradle_multi_project_hierarchy_and_dependencies() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write(
            &root.join("settings.gradle"),
            "rootProject.name = 'my-app'\ninclude 'core', 'web'\n",
        );
        write(
            &root.join("build.gradle"),
            "allprojects { repositories { mavenCentral() } }\n",
        );
        fs::create_dir_all(root.join("core/src/main/java")).unwrap();
        write(&root.join("core/build.gradle"), "plugins { id 'java' }\n");
        fs::create_dir_all(root.join("web/src/main/java")).unwrap();
        write(
            &root.join("web/build.gradle"),
            "plugins { id 'java' }\ndependencies { implementation project(':core') }\n",
        );

        let model = detect_execution_model(root, None, None).unwrap();
        let root_mod = model
            .modules
            .iter()
            .find(|m| m.root == path_string(root))
            .expect("root module");
        let core_mod = model
            .modules
            .iter()
            .find(|m| m.root == path_string(&root.join("core")))
            .expect("core module");
        let web_mod = model
            .modules
            .iter()
            .find(|m| m.root == path_string(&root.join("web")))
            .expect("web module");

        assert!(root_mod.child_module_ids.contains(&core_mod.id));
        assert!(root_mod.child_module_ids.contains(&web_mod.id));
        assert_eq!(
            core_mod.parent_module_id.as_deref(),
            Some(root_mod.id.as_str())
        );
        assert_eq!(
            web_mod.parent_module_id.as_deref(),
            Some(root_mod.id.as_str())
        );
        assert_eq!(web_mod.module_dependencies, vec!["core".to_string()]);
    }

    #[test]
    fn compile_artifact_path_resolves_when_output_dir_exists() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write(
            &root.join("pom.xml"),
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>app</artifactId><version>1.0.0</version></project>"#,
        );
        let classes_dir = root.join("target/classes");
        fs::create_dir_all(&classes_dir).unwrap();

        let model = detect_execution_model(root, None, None).unwrap();
        let artifact = model
            .compile_artifacts
            .iter()
            .find(|a| a.kind == "jvm-classes")
            .expect("classes artifact");
        assert_eq!(artifact.resolution, "resolved");
        assert_eq!(
            artifact.path.as_deref(),
            Some(path_string(&classes_dir).as_str())
        );
    }
}
