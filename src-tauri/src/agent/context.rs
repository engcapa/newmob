use crate::agent::cc_bridge::mcp_http::Flavor;
use crate::agent::cc_bridge::session_card::{self, LocalTerminalEnv};
use crate::session::models::SessionConfig;
use crate::state::AppState;
use serde::{Deserialize, Serialize};

pub const SELECTABLE_DB_OBJECT_KINDS: &[&str] = &["table", "view", "materialized_view"];
const SUPPORTED_DB_OBJECT_KINDS: &[&str] = &[
    "table",
    "view",
    "materialized_view",
    "procedure",
    "function",
    "trigger",
    "event",
    "sequence",
    "dictionary",
];
const MAX_SELECTED_DB_OBJECTS: usize = 128;
const MAX_CODE_WORKSPACE_PATHS: usize = 64;
const MAX_CODE_WORKSPACE_PATH_LEN: usize = 512;
const MAX_CODE_WORKSPACE_ROOTS: usize = 16;
const MAX_CODE_WORKSPACE_LOOSE_FILES: usize = 64;
const MAX_CODE_WORKSPACE_LSP_DIAGNOSTIC_FILES: usize = 16;
const MAX_CODE_WORKSPACE_LSP_MESSAGES: usize = 5;
const MAX_CODE_WORKSPACE_LSP_TEXT_LEN: usize = 240;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentDbSelectedObject {
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(alias = "table")]
    pub name: String,
    pub kind: String,
}

impl AgentDbSelectedObject {
    pub fn normalized(&self) -> Option<Self> {
        let name = self.name.trim();
        if name.is_empty() {
            return None;
        }
        let kind = self.kind.trim();
        if !SUPPORTED_DB_OBJECT_KINDS.contains(&kind) {
            return None;
        }
        Some(Self {
            catalog: clean_opt(self.catalog.as_deref()),
            schema: clean_opt(self.schema.as_deref()),
            name: name.to_string(),
            kind: kind.to_string(),
        })
    }

    pub fn is_selectable(&self) -> bool {
        SELECTABLE_DB_OBJECT_KINDS.contains(&self.kind.as_str())
    }

    pub fn display_name(&self) -> String {
        let mut parts = Vec::new();
        if let Some(catalog) = self
            .catalog
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(catalog);
        }
        if let Some(schema) = self
            .schema
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(schema);
        }
        parts.push(self.name.trim());
        parts.join(".")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLooseFile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceFile {
    pub kind: String,
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub root_name: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLspStatus {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub language_id: Option<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub selected_command: Option<String>,
    #[serde(default)]
    pub install_hint: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLspDiagnostic {
    pub file: AgentCodeWorkspaceFile,
    #[serde(default)]
    pub error_count: u32,
    #[serde(default)]
    pub warning_count: u32,
    #[serde(default)]
    pub info_count: u32,
    #[serde(default)]
    pub messages: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLsp {
    #[serde(default)]
    pub active_status: Option<AgentCodeWorkspaceLspStatus>,
    #[serde(default)]
    pub diagnostics: Vec<AgentCodeWorkspaceLspDiagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspace {
    #[serde(default)]
    pub repo_root: String,
    #[serde(default)]
    pub active_path: Option<String>,
    #[serde(default)]
    pub open_paths: Vec<String>,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
    #[serde(default)]
    pub roots: Vec<AgentCodeWorkspaceRoot>,
    #[serde(default)]
    pub loose_files: Vec<AgentCodeWorkspaceLooseFile>,
    #[serde(default)]
    pub active_file: Option<AgentCodeWorkspaceFile>,
    #[serde(default)]
    pub open_files: Vec<AgentCodeWorkspaceFile>,
    #[serde(default)]
    pub dirty_files: Vec<AgentCodeWorkspaceFile>,
    #[serde(default)]
    pub lsp: Option<AgentCodeWorkspaceLsp>,
}

impl AgentCodeWorkspace {
    pub fn normalized(&self) -> Option<Self> {
        let mut roots = normalize_code_workspace_roots(&self.roots);
        let repo_root = clean_code_workspace_os_path(&self.repo_root);
        if roots.is_empty() {
            if let Some(root) = repo_root.as_deref() {
                roots.push(AgentCodeWorkspaceRoot {
                    id: "root-1".to_string(),
                    name: code_workspace_basename(root).unwrap_or_else(|| "Workspace".into()),
                    path: root.to_string(),
                    kind: Some("git".into()),
                });
            }
        }
        let loose_files = normalize_code_workspace_loose_files(&self.loose_files);
        if roots.is_empty() && loose_files.is_empty() {
            return None;
        }
        let repo_root = repo_root
            .or_else(|| roots.first().map(|root| root.path.clone()))
            .unwrap_or_default();
        let open_paths = normalize_code_workspace_paths(&self.open_paths);
        let dirty_paths = normalize_code_workspace_paths(&self.dirty_paths);
        let open_files = normalize_code_workspace_files(&self.open_files, &roots, &loose_files)
            .or_else(|| legacy_paths_to_files(&open_paths, &roots))
            .unwrap_or_default();
        let dirty_files = normalize_code_workspace_files(&self.dirty_files, &roots, &loose_files)
            .or_else(|| legacy_paths_to_files(&dirty_paths, &roots))
            .unwrap_or_default();
        let active_file = self
            .active_file
            .as_ref()
            .and_then(|file| normalize_code_workspace_file(file, &roots, &loose_files))
            .or_else(|| {
                self.active_path
                    .as_deref()
                    .and_then(clean_code_workspace_path)
                    .and_then(|path| roots.first().map(|root| root_file_for_path(root, path)))
            });
        let lsp = self
            .lsp
            .as_ref()
            .and_then(|lsp| normalize_code_workspace_lsp(lsp, &roots, &loose_files));
        Some(Self {
            repo_root,
            active_path: self
                .active_path
                .as_deref()
                .and_then(clean_code_workspace_path),
            open_paths,
            dirty_paths,
            roots,
            loose_files,
            active_file,
            open_files,
            dirty_files,
            lsp,
        })
    }
}

fn clean_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn clean_code_workspace_path(value: &str) -> Option<String> {
    let path = value.trim().replace('\\', "/");
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(':')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.len() > MAX_CODE_WORKSPACE_PATH_LEN
    {
        return None;
    }
    Some(path)
}

fn clean_code_workspace_os_path(value: &str) -> Option<String> {
    let path = value.trim().replace('\\', "/");
    if path.is_empty()
        || path.contains('\n')
        || path.contains('\r')
        || path.len() > MAX_CODE_WORKSPACE_PATH_LEN * 4
    {
        return None;
    }
    Some(path)
}

fn clean_code_workspace_id(value: &str) -> Option<String> {
    let id = value.trim();
    if id.is_empty()
        || id.len() > 128
        || id.contains('\n')
        || id.contains('\r')
        || id.contains('/')
        || id.contains('\\')
    {
        return None;
    }
    Some(id.to_string())
}

fn clean_code_workspace_name(value: &str) -> Option<String> {
    let name = value.trim();
    if name.is_empty() || name.len() > 160 || name.contains('\n') || name.contains('\r') {
        return None;
    }
    Some(name.to_string())
}

fn code_workspace_basename(path: &str) -> Option<String> {
    path.trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .and_then(clean_code_workspace_name)
}

fn normalize_code_workspace_paths(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for path in paths {
        let Some(clean) = clean_code_workspace_path(path) else {
            continue;
        };
        if out.iter().any(|existing| existing == &clean) {
            continue;
        }
        out.push(clean);
        if out.len() >= MAX_CODE_WORKSPACE_PATHS {
            break;
        }
    }
    out
}

fn normalize_code_workspace_roots(roots: &[AgentCodeWorkspaceRoot]) -> Vec<AgentCodeWorkspaceRoot> {
    let mut out: Vec<AgentCodeWorkspaceRoot> = Vec::new();
    for root in roots {
        let Some(id) = clean_code_workspace_id(&root.id) else {
            continue;
        };
        let Some(path) = clean_code_workspace_os_path(&root.path) else {
            continue;
        };
        if out
            .iter()
            .any(|existing| existing.id == id || existing.path == path)
        {
            continue;
        }
        let name = clean_code_workspace_name(&root.name)
            .or_else(|| code_workspace_basename(&path))
            .unwrap_or_else(|| "Workspace".into());
        let kind = root
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|kind| matches!(*kind, "git" | "folder"))
            .map(ToString::to_string)
            .or_else(|| Some("folder".into()));
        out.push(AgentCodeWorkspaceRoot {
            id,
            name,
            path,
            kind,
        });
        if out.len() >= MAX_CODE_WORKSPACE_ROOTS {
            break;
        }
    }
    out
}

fn normalize_code_workspace_loose_files(
    files: &[AgentCodeWorkspaceLooseFile],
) -> Vec<AgentCodeWorkspaceLooseFile> {
    let mut out: Vec<AgentCodeWorkspaceLooseFile> = Vec::new();
    for file in files {
        let Some(id) = clean_code_workspace_id(&file.id) else {
            continue;
        };
        let Some(path) = clean_code_workspace_os_path(&file.path) else {
            continue;
        };
        if out
            .iter()
            .any(|existing| existing.id == id || existing.path == path)
        {
            continue;
        }
        let name = file
            .name
            .as_deref()
            .and_then(clean_code_workspace_name)
            .or_else(|| code_workspace_basename(&path));
        out.push(AgentCodeWorkspaceLooseFile { id, name, path });
        if out.len() >= MAX_CODE_WORKSPACE_LOOSE_FILES {
            break;
        }
    }
    out
}

fn root_file_for_path(root: &AgentCodeWorkspaceRoot, path: String) -> AgentCodeWorkspaceFile {
    AgentCodeWorkspaceFile {
        kind: "root".into(),
        root_id: Some(root.id.clone()),
        root_name: Some(root.name.clone()),
        root_path: Some(root.path.clone()),
        id: None,
        name: None,
        path: Some(path),
    }
}

fn loose_file_for_path(file: &AgentCodeWorkspaceLooseFile) -> AgentCodeWorkspaceFile {
    AgentCodeWorkspaceFile {
        kind: "loose".into(),
        root_id: None,
        root_name: None,
        root_path: None,
        id: Some(file.id.clone()),
        name: file.name.clone(),
        path: Some(file.path.clone()),
    }
}

fn normalize_code_workspace_file(
    file: &AgentCodeWorkspaceFile,
    roots: &[AgentCodeWorkspaceRoot],
    loose_files: &[AgentCodeWorkspaceLooseFile],
) -> Option<AgentCodeWorkspaceFile> {
    match file.kind.trim() {
        "root" => {
            let root = file
                .root_id
                .as_deref()
                .and_then(clean_code_workspace_id)
                .and_then(|id| roots.iter().find(|root| root.id == id))
                .or_else(|| {
                    file.root_path
                        .as_deref()
                        .and_then(clean_code_workspace_os_path)
                        .and_then(|path| roots.iter().find(|root| root.path == path))
                })?;
            let path = file.path.as_deref().and_then(clean_code_workspace_path)?;
            Some(root_file_for_path(root, path))
        }
        "loose" => {
            let by_id = file
                .id
                .as_deref()
                .and_then(clean_code_workspace_id)
                .and_then(|id| loose_files.iter().find(|item| item.id == id));
            let by_path = file
                .path
                .as_deref()
                .and_then(clean_code_workspace_os_path)
                .and_then(|path| loose_files.iter().find(|item| item.path == path));
            by_id.or(by_path).map(loose_file_for_path)
        }
        _ => None,
    }
}

fn normalize_code_workspace_files(
    files: &[AgentCodeWorkspaceFile],
    roots: &[AgentCodeWorkspaceRoot],
    loose_files: &[AgentCodeWorkspaceLooseFile],
) -> Option<Vec<AgentCodeWorkspaceFile>> {
    if files.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for file in files {
        let Some(normalized) = normalize_code_workspace_file(file, roots, loose_files) else {
            continue;
        };
        if out.iter().any(|existing| existing == &normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= MAX_CODE_WORKSPACE_PATHS {
            break;
        }
    }
    Some(out)
}

fn clean_lsp_text(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|s| !s.is_empty()).map(|s| {
        let mut out = s.replace(['\n', '\r'], " ");
        if out.len() > MAX_CODE_WORKSPACE_LSP_TEXT_LEN {
            out.truncate(MAX_CODE_WORKSPACE_LSP_TEXT_LEN);
            out.push_str("...");
        }
        out
    })
}

fn normalize_code_workspace_lsp(
    lsp: &AgentCodeWorkspaceLsp,
    roots: &[AgentCodeWorkspaceRoot],
    loose_files: &[AgentCodeWorkspaceLooseFile],
) -> Option<AgentCodeWorkspaceLsp> {
    let active_status = lsp.active_status.as_ref().and_then(|status| {
        let display_name = clean_lsp_text(status.display_name.as_deref());
        let language_id = clean_lsp_text(status.language_id.as_deref());
        let selected_command = clean_lsp_text(status.selected_command.as_deref());
        let install_hint = clean_lsp_text(status.install_hint.as_deref());
        let error = clean_lsp_text(status.error.as_deref());
        if display_name.is_none()
            && language_id.is_none()
            && selected_command.is_none()
            && install_hint.is_none()
            && error.is_none()
            && !status.active
            && !status.available
        {
            return None;
        }
        Some(AgentCodeWorkspaceLspStatus {
            display_name,
            language_id,
            active: status.active,
            available: status.available,
            selected_command,
            install_hint,
            error,
        })
    });

    let mut diagnostics = Vec::new();
    for diagnostic in &lsp.diagnostics {
        let Some(file) = normalize_code_workspace_file(&diagnostic.file, roots, loose_files) else {
            continue;
        };
        let total = diagnostic.error_count + diagnostic.warning_count + diagnostic.info_count;
        if total == 0 && diagnostic.messages.is_empty() {
            continue;
        }
        let mut messages = Vec::new();
        for message in &diagnostic.messages {
            let Some(clean) = clean_lsp_text(Some(message)) else {
                continue;
            };
            if messages.iter().any(|existing| existing == &clean) {
                continue;
            }
            messages.push(clean);
            if messages.len() >= MAX_CODE_WORKSPACE_LSP_MESSAGES {
                break;
            }
        }
        diagnostics.push(AgentCodeWorkspaceLspDiagnostic {
            file,
            error_count: diagnostic.error_count.min(999),
            warning_count: diagnostic.warning_count.min(999),
            info_count: diagnostic.info_count.min(999),
            messages,
        });
        if diagnostics.len() >= MAX_CODE_WORKSPACE_LSP_DIAGNOSTIC_FILES {
            break;
        }
    }

    if active_status.is_none() && diagnostics.is_empty() {
        None
    } else {
        Some(AgentCodeWorkspaceLsp {
            active_status,
            diagnostics,
        })
    }
}

fn legacy_paths_to_files(
    paths: &[String],
    roots: &[AgentCodeWorkspaceRoot],
) -> Option<Vec<AgentCodeWorkspaceFile>> {
    let root = roots.first()?;
    Some(
        paths
            .iter()
            .cloned()
            .map(|path| root_file_for_path(root, path))
            .collect(),
    )
}

/// Per-turn execution context shared by Claude Code, Codex app-server, and
/// direct LLM providers that can use Taomni tools.
#[derive(Clone, Debug)]
pub struct AgentThreadContext {
    pub thread_id: String,
    pub linked_session_id: Option<String>,
    pub bound_session_id: Option<String>,
    pub cwd: Option<String>,
    pub local_terminal_env: Option<LocalTerminalEnv>,
    pub bound_db_connection_id: Option<String>,
    pub bound_db_selected_objects: Vec<AgentDbSelectedObject>,
    pub code_workspace: Option<AgentCodeWorkspace>,
    pub flavor: Flavor,
    pub session_card: String,
}

impl AgentThreadContext {
    pub async fn refresh_runtime_bindings(&self, state: &AppState) {
        if let Some(cwd) = self.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            state
                .agent_thread_cwd
                .lock()
                .unwrap()
                .insert(self.thread_id.clone(), cwd.to_string());
        }

        let conn = self
            .bound_db_connection_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let mut bindings = state.agent_db_bindings.write().await;
        match conn.as_deref() {
            Some(c) => {
                bindings.insert(self.thread_id.clone(), c.to_string());
            }
            None => {
                bindings.remove(&self.thread_id);
            }
        }
        drop(bindings);

        let selected = if conn.is_some() {
            normalize_selected_objects(&self.bound_db_selected_objects)
        } else {
            Vec::new()
        };
        let mut selected_objects = state.agent_db_selected_objects.write().await;
        if selected.is_empty() {
            selected_objects.remove(&self.thread_id);
        } else {
            selected_objects.insert(self.thread_id.clone(), selected);
        }
        drop(selected_objects);

        let workspace = self
            .code_workspace
            .as_ref()
            .and_then(AgentCodeWorkspace::normalized);
        let mut workspaces = state.agent_code_workspaces.write().await;
        match workspace {
            Some(workspace) => {
                workspaces.insert(self.thread_id.clone(), workspace);
            }
            None => {
                workspaces.remove(&self.thread_id);
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AgentThreadContextInput {
    pub thread_id: String,
    pub linked_session_id: Option<String>,
    pub bound_session_id: Option<String>,
    pub cwd: Option<String>,
    pub local_terminal_env: Option<LocalTerminalEnv>,
    pub bound_db_connection_id: Option<String>,
    pub bound_db_selected_objects: Vec<AgentDbSelectedObject>,
    pub bound_db_selected_table: Option<AgentDbSelectedObject>,
    pub code_workspace: Option<AgentCodeWorkspace>,
}

pub fn normalize_selected_objects(objects: &[AgentDbSelectedObject]) -> Vec<AgentDbSelectedObject> {
    let mut out: Vec<AgentDbSelectedObject> = Vec::new();
    for object in objects {
        let Some(normalized) = object.normalized() else {
            continue;
        };
        if out.iter().any(|existing| existing == &normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= MAX_SELECTED_DB_OBJECTS {
            break;
        }
    }
    out
}

pub fn build_agent_thread_context(
    state: &AppState,
    input: AgentThreadContextInput,
) -> Result<AgentThreadContext, String> {
    let (session, recent) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let session = input
            .bound_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|sid| crate::session::db::get_session(&db, sid).ok());
        let recent = session
            .as_ref()
            .map(|sc| {
                crate::history::db_list_recent(
                    &db,
                    &session_card::host_key_for(sc),
                    session_card::HISTORY_LIMIT,
                )
                .unwrap_or_default()
            })
            .unwrap_or_default();
        (session, recent)
    };

    let flavor = Flavor::for_session_type(session.as_ref().map(|sc| &sc.session_type));
    let session_card = render_session_card(
        session.as_ref(),
        &input.thread_id,
        input.linked_session_id.is_some(),
        &recent,
        input.local_terminal_env.as_ref(),
    );

    Ok(AgentThreadContext {
        thread_id: input.thread_id,
        linked_session_id: input.linked_session_id,
        bound_session_id: input.bound_session_id,
        cwd: input.cwd,
        local_terminal_env: input.local_terminal_env,
        bound_db_connection_id: input.bound_db_connection_id,
        bound_db_selected_objects: if input.bound_db_selected_objects.is_empty() {
            input.bound_db_selected_table.into_iter().collect()
        } else {
            input.bound_db_selected_objects
        },
        code_workspace: input
            .code_workspace
            .as_ref()
            .and_then(AgentCodeWorkspace::normalized),
        flavor,
        session_card,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_object_normalized_accepts_cross_object_selection() {
        let selected = AgentDbSelectedObject {
            catalog: Some("  hive  ".into()),
            schema: Some(" default ".into()),
            name: " orders ".into(),
            kind: "table".into(),
        }
        .normalized()
        .unwrap();

        assert_eq!(selected.catalog.as_deref(), Some("hive"));
        assert_eq!(selected.schema.as_deref(), Some("default"));
        assert_eq!(selected.name, "orders");
        assert!(selected.is_selectable());
        assert_eq!(selected.display_name(), "hive.default.orders");

        let procedure = AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: "sp_sync".into(),
            kind: "procedure".into(),
        }
        .normalized()
        .unwrap();
        assert!(!procedure.is_selectable());
        assert!(
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: " ".into(),
                kind: "table".into(),
            }
            .normalized()
            .is_none()
        );
        assert!(
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "orders".into(),
                kind: "unknown".into(),
            }
            .normalized()
            .is_none()
        );
    }

    #[test]
    fn selected_objects_normalized_dedupes_and_caps() {
        let objects = vec![
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "orders".into(),
                kind: "table".into(),
            },
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "orders".into(),
                kind: "table".into(),
            },
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "sp_sync".into(),
                kind: "procedure".into(),
            },
        ];
        let normalized = normalize_selected_objects(&objects);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].name, "orders");
        assert_eq!(normalized[1].kind, "procedure");
    }

    #[test]
    fn code_workspace_normalized_keeps_repo_relative_paths() {
        let workspace = AgentCodeWorkspace {
            repo_root: "  /repo/app  ".into(),
            active_path: Some(" src/main.ts ".into()),
            open_paths: vec![
                "src/main.ts".into(),
                "src/main.ts".into(),
                "../secret".into(),
                "/tmp/file".into(),
                "src/lib.rs".into(),
            ],
            dirty_paths: vec!["src/lib.rs".into(), "C:/absolute/file.rs".into()],
            roots: vec![],
            loose_files: vec![],
            active_file: None,
            open_files: vec![],
            dirty_files: vec![],
            lsp: None,
        }
        .normalized()
        .unwrap();

        assert_eq!(workspace.repo_root, "/repo/app");
        assert_eq!(workspace.active_path.as_deref(), Some("src/main.ts"));
        assert_eq!(workspace.open_paths, vec!["src/main.ts", "src/lib.rs"]);
        assert_eq!(workspace.dirty_paths, vec!["src/lib.rs"]);
        assert_eq!(workspace.roots.len(), 1);
        assert_eq!(workspace.open_files.len(), 2);
        assert_eq!(workspace.open_files[0].root_id.as_deref(), Some("root-1"));
    }

    #[test]
    fn code_workspace_normalized_rejects_empty_repo() {
        let workspace = AgentCodeWorkspace {
            repo_root: " ".into(),
            active_path: Some("src/main.ts".into()),
            open_paths: vec![],
            dirty_paths: vec![],
            roots: vec![],
            loose_files: vec![],
            active_file: None,
            open_files: vec![],
            dirty_files: vec![],
            lsp: None,
        };

        assert!(workspace.normalized().is_none());
    }

    #[test]
    fn code_workspace_normalized_accepts_roots_and_loose_files() {
        let workspace = AgentCodeWorkspace {
            repo_root: "".into(),
            active_path: None,
            open_paths: vec![],
            dirty_paths: vec![],
            roots: vec![
                AgentCodeWorkspaceRoot {
                    id: "app".into(),
                    name: " App ".into(),
                    path: " /repo/app ".into(),
                    kind: Some("git".into()),
                },
                AgentCodeWorkspaceRoot {
                    id: "lib".into(),
                    name: "Lib".into(),
                    path: "/repo/lib".into(),
                    kind: Some("folder".into()),
                },
            ],
            loose_files: vec![AgentCodeWorkspaceLooseFile {
                id: "scratch".into(),
                name: Some("scratch.md".into()),
                path: "/tmp/scratch.md".into(),
            }],
            active_file: Some(AgentCodeWorkspaceFile {
                kind: "loose".into(),
                root_id: None,
                root_name: None,
                root_path: None,
                id: Some("scratch".into()),
                name: None,
                path: Some("/tmp/scratch.md".into()),
            }),
            open_files: vec![
                AgentCodeWorkspaceFile {
                    kind: "root".into(),
                    root_id: Some("app".into()),
                    root_name: None,
                    root_path: None,
                    id: None,
                    name: None,
                    path: Some("src/main.ts".into()),
                },
                AgentCodeWorkspaceFile {
                    kind: "loose".into(),
                    root_id: None,
                    root_name: None,
                    root_path: None,
                    id: Some("scratch".into()),
                    name: None,
                    path: Some("/tmp/scratch.md".into()),
                },
            ],
            dirty_files: vec![AgentCodeWorkspaceFile {
                kind: "root".into(),
                root_id: Some("lib".into()),
                root_name: None,
                root_path: None,
                id: None,
                name: None,
                path: Some("README.md".into()),
            }],
            lsp: None,
        }
        .normalized()
        .unwrap();

        assert_eq!(workspace.repo_root, "/repo/app");
        assert_eq!(workspace.roots.len(), 2);
        assert_eq!(workspace.loose_files.len(), 1);
        assert_eq!(workspace.active_file.unwrap().kind, "loose");
        assert_eq!(workspace.open_files.len(), 2);
        assert_eq!(workspace.dirty_files[0].root_id.as_deref(), Some("lib"));
    }
}

fn render_session_card(
    session: Option<&SessionConfig>,
    thread_id: &str,
    linked: bool,
    recent: &[String],
    local_terminal_env: Option<&LocalTerminalEnv>,
) -> String {
    let raw = session_card::render_card(session, thread_id, linked, recent, local_terminal_env);
    crate::chat::redact::redact(&raw).0
}
