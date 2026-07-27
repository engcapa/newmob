mod detect;
mod probe;
mod resolve;
mod runtime;

pub use runtime::{JavaRuntimeConfiguration, WorkspaceSdkEnvironment};

use crate::state::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::{Mutex, RwLock};

const SDK_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SdkKind {
    Java,
    Kotlin,
    Scala,
    Python,
}

impl SdkKind {
    fn label(self) -> &'static str {
        match self {
            Self::Java => "JDK",
            Self::Kotlin => "Kotlin",
            Self::Scala => "Scala",
            Self::Python => "Python",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkOrigin {
    Manual,
    Discovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkStatus {
    Ready,
    Missing,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkRole {
    Project,
    Launcher,
    Tooling,
    Compiler,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkBindingMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkInstallation {
    pub id: String,
    pub kind: SdkKind,
    pub name: String,
    pub location: String,
    #[serde(default)]
    pub executables: BTreeMap<String, String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub architecture: Option<String>,
    pub origin: SdkOrigin,
    pub status: SdkStatus,
    pub last_error: Option<String>,
    pub last_probed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkDefault {
    pub kind: SdkKind,
    pub sdk_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkBinding {
    pub scope_path: String,
    pub kind: SdkKind,
    pub role: SdkRole,
    pub mode: SdkBindingMode,
    pub sdk_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkRegistry {
    pub schema_version: u32,
    #[serde(default)]
    pub installations: Vec<SdkInstallation>,
    #[serde(default)]
    pub defaults: Vec<SdkDefault>,
    #[serde(default)]
    pub bindings: Vec<WorkspaceSdkBinding>,
}

impl Default for SdkRegistry {
    fn default() -> Self {
        Self {
            schema_version: SDK_REGISTRY_SCHEMA_VERSION,
            installations: Vec::new(),
            defaults: Vec::new(),
            bindings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkProbe {
    pub kind: SdkKind,
    pub location: String,
    pub executables: BTreeMap<String, String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub architecture: Option<String>,
    pub status: SdkStatus,
    pub error: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSdkInstallationRequest {
    pub id: Option<String>,
    pub kind: SdkKind,
    pub name: Option<String>,
    pub location: String,
    #[serde(default)]
    pub origin: Option<SdkOrigin>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSdkDefaultRequest {
    pub kind: SdkKind,
    pub sdk_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceSdkBindingRequest {
    pub scope_path: String,
    pub kind: SdkKind,
    pub role: SdkRole,
    pub mode: SdkBindingMode,
    pub sdk_id: Option<String>,
}

pub struct SdkManager {
    path: PathBuf,
    registry: RwLock<SdkRegistry>,
    revision: AtomicU64,
    resolution_cache: Mutex<HashMap<String, CachedWorkspaceResolution>>,
}

struct CachedWorkspaceResolution {
    revision: u64,
    resolved_at: Instant,
    resolution: resolve::WorkspaceSdkResolution,
}

const WORKSPACE_RESOLUTION_CACHE_TTL: Duration = Duration::from_secs(5);

impl SdkManager {
    pub fn load(path: PathBuf) -> Self {
        let registry = load_registry(&path).unwrap_or_else(|error| {
            log::warn!("failed to load SDK registry {}: {error}", path.display());
            SdkRegistry::default()
        });
        Self {
            path,
            registry: RwLock::new(registry),
            revision: AtomicU64::new(1),
            resolution_cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn snapshot(&self) -> SdkRegistry {
        self.registry.read().await.clone()
    }

    pub async fn resolve_workspace(
        &self,
        workspace_root: &str,
    ) -> Result<resolve::WorkspaceSdkResolution, String> {
        let root = normalize_scope_path(workspace_root)?;
        let revision = self.revision.load(Ordering::SeqCst);
        if let Some(cached) = self.resolution_cache.lock().await.get(&root)
            && cached.revision == revision
            && cached.resolved_at.elapsed() <= WORKSPACE_RESOLUTION_CACHE_TTL
        {
            return Ok(cached.resolution.clone());
        }

        let analysis_root = root.clone();
        let analysis =
            tokio::task::spawn_blocking(move || detect::analyze_workspace(&analysis_root))
                .await
                .map_err(|error| format!("SDK workspace analysis task failed: {error}"))??;
        let registry = self.snapshot().await;
        let resolution = resolve::resolve_workspace(analysis, &registry).await;
        self.resolution_cache.lock().await.insert(
            root,
            CachedWorkspaceResolution {
                revision,
                resolved_at: Instant::now(),
                resolution: resolution.clone(),
            },
        );
        Ok(resolution)
    }

    pub async fn resolve_environment(
        &self,
        workspace_root: &Path,
        scope_path: &Path,
    ) -> Result<WorkspaceSdkEnvironment, String> {
        let resolution = self
            .resolve_workspace(&workspace_root.to_string_lossy())
            .await?;
        let registry = self.snapshot().await;
        Ok(runtime::build_workspace_environment(
            &resolution,
            &registry,
            scope_path,
        ))
    }

    fn registry_changed(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn save_installation(
        &self,
        request: SaveSdkInstallationRequest,
    ) -> Result<SdkInstallation, String> {
        let probe = probe::probe_sdk(request.kind, &request.location).await;
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        let requested_id = request
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let existing_index = requested_id
            .map(|id| {
                next.installations
                    .iter()
                    .position(|installation| installation.id == id)
                    .ok_or_else(|| format!("SDK installation {id} was not found"))
            })
            .transpose()?;

        if next
            .installations
            .iter()
            .enumerate()
            .any(|(index, installation)| {
                Some(index) != existing_index
                    && installation.kind == request.kind
                    && paths_equal(&installation.location, &probe.location)
            })
        {
            return Err(format!(
                "A {} installation is already registered at {}",
                request.kind.label(),
                probe.location
            ));
        }

        let id = requested_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let name = request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_installation_name(request.kind, probe.version.as_deref()));
        let installation = SdkInstallation {
            id,
            kind: request.kind,
            name,
            location: probe.location,
            executables: probe.executables,
            version: probe.version,
            vendor: probe.vendor,
            architecture: probe.architecture,
            origin: request.origin.unwrap_or(SdkOrigin::Manual),
            status: probe.status,
            last_error: probe.error,
            last_probed_at: Some(Utc::now().to_rfc3339()),
        };
        if let Some(index) = existing_index {
            next.installations[index] = installation.clone();
        } else {
            next.installations.push(installation.clone());
        }
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(installation)
    }

    pub async fn remove_installation(&self, id: &str) -> Result<(), String> {
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        let original_len = next.installations.len();
        next.installations
            .retain(|installation| installation.id != id);
        if next.installations.len() == original_len {
            return Err(format!("SDK installation {id} was not found"));
        }
        next.defaults.retain(|default| default.sdk_id != id);
        next.bindings
            .retain(|binding| binding.sdk_id.as_deref() != Some(id));
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(())
    }

    pub async fn set_default(&self, request: SetSdkDefaultRequest) -> Result<(), String> {
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        next.defaults.retain(|entry| entry.kind != request.kind);
        if let Some(sdk_id) = request
            .sdk_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            require_installation(&next, sdk_id, request.kind)?;
            next.defaults.push(SdkDefault {
                kind: request.kind,
                sdk_id: sdk_id.to_string(),
            });
        }
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(())
    }

    pub async fn save_binding(
        &self,
        request: SaveWorkspaceSdkBindingRequest,
    ) -> Result<WorkspaceSdkBinding, String> {
        let scope_path = normalize_scope_path(&request.scope_path)?;
        let sdk_id = request
            .sdk_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if request.mode == SdkBindingMode::Manual && sdk_id.is_none() {
            return Err("A manual SDK binding requires an SDK installation".to_string());
        }

        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        if let Some(id) = sdk_id.as_deref() {
            require_installation(&next, id, request.kind)?;
        }
        next.bindings.retain(|binding| {
            !(paths_equal(&binding.scope_path, &scope_path)
                && binding.kind == request.kind
                && binding.role == request.role)
        });
        let binding = WorkspaceSdkBinding {
            scope_path,
            kind: request.kind,
            role: request.role,
            mode: request.mode,
            sdk_id,
            updated_at: Utc::now().to_rfc3339(),
        };
        next.bindings.push(binding.clone());
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(binding)
    }

    pub async fn remove_binding(
        &self,
        scope_path: &str,
        kind: SdkKind,
        role: SdkRole,
    ) -> Result<(), String> {
        let scope_path = normalize_scope_path(scope_path)?;
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        next.bindings.retain(|binding| {
            !(paths_equal(&binding.scope_path, &scope_path)
                && binding.kind == kind
                && binding.role == role)
        });
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(())
    }

    pub async fn refresh_installations(
        &self,
        id: Option<&str>,
    ) -> Result<Vec<SdkInstallation>, String> {
        let snapshot = self.snapshot().await;
        let selected: Vec<_> = snapshot
            .installations
            .iter()
            .filter(|installation| id.is_none_or(|id| installation.id == id))
            .cloned()
            .collect();
        if id.is_some() && selected.is_empty() {
            return Err(format!(
                "SDK installation {} was not found",
                id.unwrap_or_default()
            ));
        }
        let mut probes = Vec::with_capacity(selected.len());
        for installation in &selected {
            probes.push((
                installation.id.clone(),
                probe::probe_sdk(installation.kind, &installation.location).await,
            ));
        }

        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        let now = Utc::now().to_rfc3339();
        for (id, probe) in probes {
            if let Some(installation) = next.installations.iter_mut().find(|item| item.id == id) {
                installation.location = probe.location;
                installation.executables = probe.executables;
                installation.version = probe.version;
                installation.vendor = probe.vendor;
                installation.architecture = probe.architecture;
                installation.status = probe.status;
                installation.last_error = probe.error;
                installation.last_probed_at = Some(now.clone());
            }
        }
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        let refreshed = next
            .installations
            .iter()
            .filter(|installation| selected.iter().any(|item| item.id == installation.id))
            .cloned()
            .collect();
        *registry = next;
        self.registry_changed();
        Ok(refreshed)
    }
}

pub fn default_sdk_registry_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("taomni")
        .join("sdk.json")
}

#[tauri::command]
pub async fn sdk_get_registry(state: State<'_, AppState>) -> Result<SdkRegistry, String> {
    Ok(state.sdk.snapshot().await)
}

#[tauri::command]
pub async fn sdk_probe_installation(kind: SdkKind, location: String) -> Result<SdkProbe, String> {
    Ok(probe::probe_sdk(kind, &location).await)
}

#[tauri::command]
pub async fn sdk_discover_installations(
    kinds: Option<Vec<SdkKind>>,
) -> Result<Vec<SdkProbe>, String> {
    let kinds = kinds.unwrap_or_else(|| {
        vec![
            SdkKind::Java,
            SdkKind::Kotlin,
            SdkKind::Scala,
            SdkKind::Python,
        ]
    });
    Ok(probe::discover_sdks(&kinds).await)
}

#[tauri::command]
pub async fn sdk_save_installation(
    request: SaveSdkInstallationRequest,
    state: State<'_, AppState>,
) -> Result<SdkInstallation, String> {
    state.sdk.save_installation(request).await
}

#[tauri::command]
pub async fn sdk_remove_installation(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.sdk.remove_installation(&id).await
}

#[tauri::command]
pub async fn sdk_refresh_installations(
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SdkInstallation>, String> {
    state.sdk.refresh_installations(id.as_deref()).await
}

#[tauri::command]
pub async fn sdk_set_default(
    request: SetSdkDefaultRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sdk.set_default(request).await
}

#[tauri::command]
pub async fn sdk_save_workspace_binding(
    request: SaveWorkspaceSdkBindingRequest,
    state: State<'_, AppState>,
) -> Result<WorkspaceSdkBinding, String> {
    state.sdk.save_binding(request).await
}

#[tauri::command]
pub async fn sdk_remove_workspace_binding(
    scope_path: String,
    kind: SdkKind,
    role: SdkRole,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sdk.remove_binding(&scope_path, kind, role).await
}

#[tauri::command]
pub async fn sdk_analyze_workspace(
    workspace_root: String,
) -> Result<detect::WorkspaceSdkAnalysis, String> {
    tokio::task::spawn_blocking(move || detect::analyze_workspace(&workspace_root))
        .await
        .map_err(|error| format!("SDK workspace analysis task failed: {error}"))?
}

#[tauri::command]
pub async fn sdk_resolve_workspace(
    workspace_root: String,
    state: State<'_, AppState>,
) -> Result<resolve::WorkspaceSdkResolution, String> {
    state.sdk.resolve_workspace(&workspace_root).await
}

fn load_registry(path: &Path) -> Result<SdkRegistry, String> {
    if !path.exists() {
        let backup = backup_path(path);
        if backup.exists() {
            return read_registry(&backup);
        }
        return Ok(SdkRegistry::default());
    }
    read_registry(path)
}

fn read_registry(path: &Path) -> Result<SdkRegistry, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut registry: SdkRegistry = serde_json::from_str(&text)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if registry.schema_version != SDK_REGISTRY_SCHEMA_VERSION {
        return Err(format!(
            "unsupported SDK registry schema version {}",
            registry.schema_version
        ));
    }
    // Heal registries written before verbatim-prefix stripping: a stored
    // `\\?\C:\...` location becomes `JAVA_HOME` / a PATH entry that cmd.exe and
    // batch launchers (mvn.cmd, gradlew.bat) cannot resolve. Strip on load so
    // every downstream consumer — terminals, jdtls, the frontend — sees a plain
    // path, and the next save persists the cleaned form.
    normalize_registry_paths(&mut registry);
    Ok(registry)
}

/// Strip Windows verbatim/extended-length prefixes (`\\?\`, `\\?\UNC\`) from
/// every stored path in the registry. A no-op for already-clean paths and on
/// non-Windows hosts, so it is safe to run unconditionally on load.
fn normalize_registry_paths(registry: &mut SdkRegistry) {
    for installation in &mut registry.installations {
        installation.location = strip_verbatim_prefix(&installation.location);
        for executable in installation.executables.values_mut() {
            *executable = strip_verbatim_prefix(executable);
        }
    }
    for binding in &mut registry.bindings {
        binding.scope_path = strip_verbatim_prefix(&binding.scope_path);
    }
}

/// Remove a Windows verbatim path prefix so the result works with cmd.exe,
/// batch scripts (`%JAVA_HOME%\bin\java.exe`), and PATH lookup — none of which
/// accept `\\?\`. Mirrors `workspace.rs::path_to_string`. Returns the input
/// unchanged when no such prefix is present (all Unix paths, clean Windows
/// paths), converting a `\\?\UNC\server\share` path back to `\\server\share`.
pub(crate) fn strip_verbatim_prefix(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = value.strip_prefix("//?/UNC/") {
        return format!(r"\\{rest}");
    }
    value
        .strip_prefix(r"\\?\")
        .or_else(|| value.strip_prefix("//?/"))
        .unwrap_or(value)
        .to_string()
}

fn persist_registry(path: &Path, registry: &SdkRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("serialize SDK registry: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sdk.json");
    let temporary = path.with_file_name(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("create {}: {error}", temporary.display()))?;
    if let Err(error) = file
        .write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("write {}: {error}", temporary.display()));
    }
    drop(file);

    if path.exists() {
        let backup = backup_path(path);
        if backup.exists() {
            std::fs::remove_file(&backup)
                .map_err(|error| format!("remove stale {}: {error}", backup.display()))?;
        }
        std::fs::rename(path, &backup)
            .map_err(|error| format!("backup {}: {error}", path.display()))?;
        if let Err(error) = std::fs::rename(&temporary, path) {
            let _ = std::fs::rename(&backup, path);
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("commit {}: {error}", path.display()));
        }
        let _ = std::fs::remove_file(backup);
    } else {
        std::fs::rename(&temporary, path)
            .map_err(|error| format!("commit {}: {error}", path.display()))?;
    }
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sdk.json");
    path.with_file_name(format!("{file_name}.bak"))
}

fn default_installation_name(kind: SdkKind, version: Option<&str>) -> String {
    version
        .map(|version| format!("{} {version}", kind.label()))
        .unwrap_or_else(|| kind.label().to_string())
}

fn require_installation(registry: &SdkRegistry, id: &str, kind: SdkKind) -> Result<(), String> {
    match registry
        .installations
        .iter()
        .find(|installation| installation.id == id)
    {
        Some(installation) if installation.kind == kind => Ok(()),
        Some(_) => Err(format!("SDK installation {id} has a different kind")),
        None => Err(format!("SDK installation {id} was not found")),
    }
}

fn normalize_scope_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Workspace scope path is required".to_string());
    }
    let expanded = PathBuf::from(shellexpand::tilde(trimmed).to_string());
    let normalized = std::fs::canonicalize(&expanded).unwrap_or(expanded);
    // `canonicalize` yields a `\\?\` verbatim path on Windows; strip it so
    // stored bindings and the resolution cache key match plain caller paths.
    Ok(strip_verbatim_prefix(&normalized.to_string_lossy()))
}

fn paths_equal(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn sort_registry(registry: &mut SdkRegistry) {
    registry.installations.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    registry.defaults.sort_by_key(|entry| entry.kind);
    registry.bindings.sort_by(|left, right| {
        left.scope_path
            .cmp(&right.scope_path)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| format!("{:?}", left.role).cmp(&format!("{:?}", right.role)))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing_request(kind: SdkKind, name: &str, location: &Path) -> SaveSdkInstallationRequest {
        SaveSdkInstallationRequest {
            id: None,
            kind,
            name: Some(name.to_string()),
            location: location.to_string_lossy().into_owned(),
            origin: None,
        }
    }

    #[test]
    fn registry_serializes_stable_camel_case_contract() {
        let registry = SdkRegistry {
            bindings: vec![WorkspaceSdkBinding {
                scope_path: "C:/repo".into(),
                kind: SdkKind::Java,
                role: SdkRole::Project,
                mode: SdkBindingMode::Auto,
                sdk_id: None,
                updated_at: "2026-01-01T00:00:00Z".into(),
            }],
            ..SdkRegistry::default()
        };
        let value = serde_json::to_value(registry).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["bindings"][0]["scopePath"], "C:/repo");
        assert_eq!(value["bindings"][0]["kind"], "java");
        assert_eq!(value["bindings"][0]["role"], "project");
    }

    #[tokio::test]
    async fn manager_persists_multiple_installations_and_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sdk.json");
        let manager = SdkManager::load(path.clone());
        let java = manager
            .save_installation(missing_request(
                SdkKind::Java,
                "JDK 17",
                &directory.path().join("jdk-17"),
            ))
            .await
            .unwrap();
        let java_21 = manager
            .save_installation(missing_request(
                SdkKind::Java,
                "JDK 21",
                &directory.path().join("jdk-21"),
            ))
            .await
            .unwrap();
        let kotlin = manager
            .save_installation(missing_request(
                SdkKind::Kotlin,
                "Kotlin CLI",
                &directory.path().join("kotlin"),
            ))
            .await
            .unwrap();
        assert_eq!(java.status, SdkStatus::Missing);
        manager
            .set_default(SetSdkDefaultRequest {
                kind: SdkKind::Java,
                sdk_id: Some(java_21.id.clone()),
            })
            .await
            .unwrap();
        manager
            .save_binding(SaveWorkspaceSdkBindingRequest {
                scope_path: directory.path().to_string_lossy().into_owned(),
                kind: SdkKind::Kotlin,
                role: SdkRole::Compiler,
                mode: SdkBindingMode::Manual,
                sdk_id: Some(kotlin.id.clone()),
            })
            .await
            .unwrap();

        let reloaded = SdkManager::load(path).snapshot().await;
        assert_eq!(reloaded.installations.len(), 3);
        assert_eq!(reloaded.defaults[0].sdk_id, java_21.id);
        assert_eq!(
            reloaded.bindings[0].sdk_id.as_deref(),
            Some(kotlin.id.as_str())
        );
        assert_ne!(java.id, java_21.id);
    }

    #[tokio::test]
    async fn removing_installation_cleans_references() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SdkManager::load(directory.path().join("sdk.json"));
        let java = manager
            .save_installation(missing_request(
                SdkKind::Java,
                "JDK",
                &directory.path().join("jdk"),
            ))
            .await
            .unwrap();
        manager
            .set_default(SetSdkDefaultRequest {
                kind: SdkKind::Java,
                sdk_id: Some(java.id.clone()),
            })
            .await
            .unwrap();
        manager
            .save_binding(SaveWorkspaceSdkBindingRequest {
                scope_path: directory.path().to_string_lossy().into_owned(),
                kind: SdkKind::Java,
                role: SdkRole::Project,
                mode: SdkBindingMode::Manual,
                sdk_id: Some(java.id.clone()),
            })
            .await
            .unwrap();

        manager.remove_installation(&java.id).await.unwrap();
        let registry = manager.snapshot().await;
        assert!(registry.installations.is_empty());
        assert!(registry.defaults.is_empty());
        assert!(registry.bindings.is_empty());
    }

    #[test]
    fn strip_verbatim_prefix_cleans_windows_extended_paths() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Program Files\Java\jdk-21"),
            r"C:\Program Files\Java\jdk-21"
        );
        assert_eq!(strip_verbatim_prefix(r"//?/C:/Tools/jdk"), "C:/Tools/jdk");
        // UNC verbatim paths fold back to the `\\server\share` form.
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\jdk"),
            r"\\server\share\jdk"
        );
        // Already-clean paths (and all Unix paths) pass through untouched.
        assert_eq!(
            strip_verbatim_prefix(r"C:\Program Files\Java\jdk-21"),
            r"C:\Program Files\Java\jdk-21"
        );
        assert_eq!(
            strip_verbatim_prefix("/usr/lib/jvm/jdk-21"),
            "/usr/lib/jvm/jdk-21"
        );
    }

    #[test]
    fn normalize_registry_paths_heals_verbatim_locations_on_load() {
        let mut registry = SdkRegistry {
            installations: vec![SdkInstallation {
                id: "jdk-21".into(),
                kind: SdkKind::Java,
                name: "java21".into(),
                location: r"\\?\C:\Program Files\Java\jdk-21".into(),
                executables: BTreeMap::from([(
                    "java".to_string(),
                    r"\\?\C:\Program Files\Java\jdk-21\bin\java.exe".to_string(),
                )]),
                version: Some("21.0.4".into()),
                vendor: None,
                architecture: None,
                origin: SdkOrigin::Manual,
                status: SdkStatus::Ready,
                last_error: None,
                last_probed_at: None,
            }],
            bindings: vec![WorkspaceSdkBinding {
                scope_path: r"\\?\D:\code\ads\ique".into(),
                kind: SdkKind::Java,
                role: SdkRole::Project,
                mode: SdkBindingMode::Manual,
                sdk_id: Some("jdk-21".into()),
                updated_at: "now".into(),
            }],
            ..SdkRegistry::default()
        };

        normalize_registry_paths(&mut registry);

        assert_eq!(
            registry.installations[0].location,
            r"C:\Program Files\Java\jdk-21"
        );
        assert_eq!(
            registry.installations[0].executables.get("java").unwrap(),
            r"C:\Program Files\Java\jdk-21\bin\java.exe"
        );
        assert_eq!(registry.bindings[0].scope_path, r"D:\code\ads\ique");
    }

    #[tokio::test]
    async fn manual_binding_requires_matching_installation() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SdkManager::load(directory.path().join("sdk.json"));
        let error = manager
            .save_binding(SaveWorkspaceSdkBindingRequest {
                scope_path: directory.path().to_string_lossy().into_owned(),
                kind: SdkKind::Python,
                role: SdkRole::Project,
                mode: SdkBindingMode::Manual,
                sdk_id: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("requires"));
    }
}
