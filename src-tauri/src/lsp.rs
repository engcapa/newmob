use crate::sdk::{JavaRuntimeConfiguration, SdkManager, WorkspaceSdkEnvironment};
use crate::state::AppState;
use globset::GlobBuilder;
use notify::event::{ModifyKind, RenameMode};
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Notify, RwLock, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const REQUEST_TIMEOUT_SECS: u64 = 8;
/// Project-scope jdtls `executeCommand`s (java-debug's `resolveMainClass` /
/// `resolveClasspath` / `startDebugSession`, java-test discovery) search or
/// resolve the whole project and activate an OSGi bundle on first use, so they
/// routinely need more than the interactive [`REQUEST_TIMEOUT_SECS`] budget that
/// suits hover/completion. Too short a budget here reads to the user as "Debug
/// does nothing": the command is still running server-side when we give up.
const JAVA_COMMAND_TIMEOUT_SECS: u64 = 60;
/// A workspace build is minutes-scale on a cold multi-module project.
const BUILD_WORKSPACE_TIMEOUT_SECS: u64 = 600;
const INITIALIZE_TIMEOUT_SECS: u64 = 20;
/// Eclipse JDT LS cold-start (especially on Windows) routinely exceeds 20s.
const JDTLS_INITIALIZE_TIMEOUT_SECS: u64 = 120;
/// Current Eclipse JDT LS (snapshot/milestones) requires a modern JDK; the
/// upstream `jdtls.py` launcher refuses anything below this major version.
const JDTLS_MIN_JAVA_MAJOR: u32 = 21;
/// Default jdtls JVM args when Settings has no override (matches prior 1G heap).
const DEFAULT_JDTLS_VMARGS: &str = "-Xms1024m -Xmx1024m";
/// Marker file inside each jdtls `-data` dir naming the project it indexes, used to
/// prune indexes whose project has been deleted/renamed.
const JDTLS_WORKSPACE_MARKER: &str = ".taomni-workspace";
/// On-demand source download: how many times to re-poll classFileContents while the
/// build tool fetches the sources JAR, and how long to wait between polls. ~24s total
/// budget covers a cold Maven/Gradle source fetch without hanging the UI forever.
const DOWNLOAD_SOURCES_POLL_ATTEMPTS: u32 = 20;
const DOWNLOAD_SOURCES_POLL_INTERVAL_MS: u64 = 1200;
/// Bound archive/virtual source reads so a corrupt server URI or compressed
/// dependency cannot turn a navigation action into an unbounded allocation.
const MAX_VIRTUAL_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
/// Bound workspace/symbol fan-out and response materialization. A language
/// server is allowed to return an arbitrarily large array; the editor must
/// keep the query deterministic and responsive instead of trusting that size.
const MAX_WORKSPACE_SYMBOLS: usize = 20_000;
const MAX_WORKSPACE_SYMBOL_PROVIDERS: usize = 64;
const MAX_WORKSPACE_SYMBOL_DIAGNOSTICS: usize = 32;
/// Keep opaque workspace-symbol resolve payloads short-lived and bounded. The
/// token is only a routing handle; the raw provider payload never crosses the
/// frontend boundary.
const WORKSPACE_SYMBOL_RESOLUTION_TTL: Duration = Duration::from_secs(300);
const MAX_WORKSPACE_SYMBOL_RAW_BYTES: usize = 64 * 1024;
const MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKSPACE_SYMBOL_RESOLUTION_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCHES: usize = 8;
const SHUTDOWN_TIMEOUT_SECS: u64 = 3;
const EXIT_TIMEOUT_SECS: u64 = 2;
const COMMAND_AVAILABILITY_TTL: Duration = Duration::from_secs(30);
const WORKSPACE_APPLY_EDIT_TIMEOUT_SECS: u64 = 30;
const SHOW_MESSAGE_REQUEST_TIMEOUT_SECS: u64 = 300;
const WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS: u64 = 30;
const WORKSPACE_APPLY_EDIT_EVENT: &str = "lsp://workspace-apply-edit";
const SHOW_MESSAGE_REQUEST_EVENT: &str = "lsp://show-message-request";
const SHOW_MESSAGE_CANCELLED_EVENT: &str = "lsp://show-message-cancelled";
const SHOW_MESSAGE_EVENT: &str = "lsp://show-message";
const WORK_DONE_PROGRESS_EVENT: &str = "lsp://work-done-progress";
const DIAGNOSTICS_REFRESH_EVENT: &str = "lsp://diagnostics-refresh";
const EXTERNAL_FILE_CHANGE_EVENT: &str = "lsp://external-file-change";
const JSON_RPC_METHOD_NOT_FOUND: i64 = -32601;
const JSON_RPC_INVALID_PARAMS: i64 = -32602;
const JSON_RPC_INTERNAL_ERROR: i64 = -32603;
const LSP_REQUEST_CANCELLED: i64 = -32800;
const WATCH_KIND_CREATE: u8 = 1;
const WATCH_KIND_CHANGE: u8 = 2;
const WATCH_KIND_DELETE: u8 = 4;
const WATCH_KIND_ALL: u8 = WATCH_KIND_CREATE | WATCH_KIND_CHANGE | WATCH_KIND_DELETE;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandPreset {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub install_hint: String,
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCustomServerCommand {
    #[serde(default)]
    pub label: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Which jdtls command the caller's editor session is bound to, so Java debug /
/// test `executeCommand` calls resolve the *same* session (matters when the user
/// configured a custom jdtls command or a non-default preset binary). Empty =
/// default preset lookup, matching the pre-identity behavior.
#[derive(Clone, Debug, Default)]
pub struct JavaSessionIdentity {
    pub preferred_command_id: Option<String>,
    pub custom_command: Option<LspCustomServerCommand>,
}

impl JavaSessionIdentity {
    /// Build from the frontend's optional command-id + custom-command pair,
    /// trimming blanks so an empty string does not shadow the preset default.
    pub fn new(
        preferred_command_id: Option<String>,
        custom_command: Option<LspCustomServerCommand>,
    ) -> Self {
        Self {
            preferred_command_id: preferred_command_id
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty()),
            custom_command: custom_command.filter(|cmd| !cmd.command.trim().is_empty()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerPreset {
    pub id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub file_extensions: Vec<String>,
    pub file_names: Vec<String>,
    pub commands: Vec<LspServerCommandPreset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandStatus {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub install_hint: String,
    pub fallback: bool,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub preset_id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub available: bool,
    pub active: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: String,
    pub error: Option<String>,
    /// Human-readable runtime probe for Settings (e.g. Java major + path for jdtls).
    #[serde(default)]
    pub runtime_status: Option<String>,
    pub commands: Vec<LspServerCommandStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentStatus {
    pub path: String,
    pub uri: String,
    pub preset_id: Option<String>,
    pub language_id: Option<String>,
    pub display_name: Option<String>,
    pub available: bool,
    pub active: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: Option<String>,
    pub error: Option<String>,
    /// Present only while a session is active for this document.
    #[serde(default)]
    pub capabilities: Option<LspCapabilitySummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentContentChange {
    pub range: LspRange,
    pub range_length: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: LspRange,
    pub severity: Option<u8>,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
    pub tags: Vec<u8>,
    pub related_information: Vec<LspDiagnosticRelatedInformation>,
    pub code_description: Option<String>,
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticRelatedInformation {
    pub location: LspLocation,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsResult {
    pub status: LspDocumentStatus,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverResult {
    pub status: LspDocumentStatus,
    pub contents: Option<String>,
    pub range: Option<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocationsResult {
    pub status: LspDocumentStatus,
    pub locations: Vec<LspLocation>,
}

/// Contents of a library / virtual document (JDK, dependency JAR, jdt:// URI).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspUriContentsResult {
    pub status: LspDocumentStatus,
    pub uri: String,
    pub path: Option<String>,
    pub title: String,
    /// Human label for where the source came from (package · jar/module).
    pub container: Option<String>,
    pub language_id: String,
    pub text: String,
    pub read_only: bool,
    /// True when `text` is FernFlower-decompiled bytecode rather than attached
    /// source. The UI offers "Download sources" in this case (jdtls only).
    pub decompiled: bool,
}

/// One entry of a flattened `textDocument/documentSymbol` tree; `depth`
/// preserves the hierarchy for indented rendering.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub depth: u32,
    pub range: LspRange,
    pub selection_range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspDocumentSymbol>,
}

/// Workspace-wide symbol hit from `workspace/symbol`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbol {
    pub name: String,
    pub kind: u32,
    pub container_name: Option<String>,
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
    pub selection_range: LspRange,
    /// False when the provider returned only a URI and requires
    /// `workspaceSymbol/resolve` before a location is available.
    #[serde(default)]
    pub resolved: bool,
    /// Short-lived opaque handle for a deferred provider resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_token: Option<String>,
    #[serde(skip)]
    raw: Option<Value>,
    #[serde(skip)]
    provider_session_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspWorkspaceSymbol>,
    /// Number of ready language-server sessions discovered for this workspace.
    #[serde(default)]
    pub session_count: u32,
    /// Number of discovered sessions that advertised workspace/symbol and were
    /// actually queried (bounded by the provider fan-out limit).
    #[serde(default)]
    pub provider_count: u32,
    /// Ready sessions that were not queried because they did not advertise
    /// workspace/symbol or fell outside the bounded provider fan-out.
    #[serde(default)]
    pub skipped_provider_count: u32,
    /// Providers whose request or response could not be consumed.
    #[serde(default)]
    pub failed_provider_count: u32,
    /// False when at least one provider failed, no provider was available, or
    /// the bounded result limit was reached. Consumers must not present an
    /// incomplete result as an authoritative project index.
    #[serde(default)]
    pub complete: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<String>,
}

struct WorkspaceSymbolResolutionBatch {
    workspace_id: String,
    created_at: Instant,
    bytes: usize,
    entries: HashMap<String, WorkspaceSymbolResolutionEntry>,
}

#[derive(Clone)]
struct WorkspaceSymbolResolutionEntry {
    session: Weak<LspSession>,
    raw: Value,
}

/// Normalized CallHierarchyItem / TypeHierarchyItem. `raw` is echoed back to
/// the server for lazy child requests so opaque server `data` is preserved.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHierarchyItem {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
    pub selection_range: LspRange,
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHierarchyPrepareResult {
    pub status: LspDocumentStatus,
    pub items: Vec<LspHierarchyItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyEntry {
    pub item: LspHierarchyItem,
    pub from_ranges: Vec<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyResult {
    pub status: LspDocumentStatus,
    pub entries: Vec<LspCallHierarchyEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTypeHierarchyResult {
    pub status: LspDocumentStatus,
    pub items: Vec<LspHierarchyItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentHighlight {
    pub range: LspRange,
    /// 1 = text, 2 = read, 3 = write.
    pub kind: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentHighlightsResult {
    pub status: LspDocumentStatus,
    pub highlights: Vec<LspDocumentHighlight>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHint {
    pub position: LspPosition,
    pub label: String,
    /// 1 = type, 2 = parameter.
    pub kind: Option<u8>,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHintsResult {
    pub status: LspDocumentStatus,
    pub hints: Vec<LspInlayHint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSelectionRangesResult {
    pub status: LspDocumentStatus,
    /// Innermost to outermost range for the requested position.
    pub ranges: Vec<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticToken {
    pub range: LspRange,
    pub token_type: String,
    pub modifiers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticTokensResult {
    pub status: LspDocumentStatus,
    pub tokens: Vec<LspSemanticToken>,
}

/// Feature summary distilled from the server's `initialize` response so the
/// UI can enable/disable entry points per capability instead of guessing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCapabilitySummary {
    /// 0 = none, 1 = full, 2 = incremental.
    pub text_document_sync_kind: u8,
    pub completion: bool,
    pub signature_help: bool,
    pub hover: bool,
    pub definition: bool,
    pub type_definition: bool,
    pub implementation: bool,
    pub references: bool,
    pub document_symbol: bool,
    pub workspace_symbol: bool,
    /// The workspace-symbol provider accepts `workspaceSymbol/resolve`.
    pub workspace_symbol_resolve: bool,
    pub rename: bool,
    pub formatting: bool,
    pub range_formatting: bool,
    pub code_action: bool,
    pub document_highlight: bool,
    pub call_hierarchy: bool,
    pub type_hierarchy: bool,
    pub inlay_hint: bool,
    pub selection_range: bool,
    pub semantic_tokens: bool,
    pub workspace_diagnostics: bool,
    pub code_action_kinds: Vec<String>,
    pub completion_trigger_characters: Vec<String>,
    pub signature_trigger_characters: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTextEdit {
    pub range: LspRange,
    pub new_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
    /// 1 = plain text, 2 = snippet (`${1:placeholder}` syntax).
    pub insert_text_format: Option<u32>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub text_edit: Option<LspTextEdit>,
    pub additional_text_edits: Vec<LspTextEdit>,
    /// Original server item, echoed back verbatim for `completionItem/resolve`.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionResult {
    pub status: LspDocumentStatus,
    pub is_incomplete: bool,
    pub items: Vec<LspCompletionItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureParameter {
    pub label: String,
    pub documentation: Option<String>,
    /// Offsets into the signature label when the server sends `[start, end]`.
    pub label_start: Option<u32>,
    pub label_end: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureInfo {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LspSignatureParameter>,
    pub active_parameter: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureHelpResult {
    pub status: LspDocumentStatus,
    pub signatures: Vec<LspSignatureInfo>,
    pub active_signature: u32,
    pub active_parameter: u32,
}

#[derive(Clone, Debug)]
struct DetectedLanguage {
    preset_id: String,
    language_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct LspSessionKey {
    workspace_id: String,
    preset_id: String,
    root_path: String,
    command_id: String,
    sdk_fingerprint: String,
}

impl LspSessionKey {
    fn map_key(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}",
            self.workspace_id,
            self.preset_id,
            self.root_path,
            self.command_id,
            self.sdk_fingerprint
        )
    }
}

#[derive(Debug)]
struct PendingResponse {
    sender: oneshot::Sender<Result<Value, String>>,
    document_uri: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceApplyEditResponse {
    pub applied: bool,
    pub failure_reason: Option<String>,
    pub failed_change: Option<u32>,
}

impl LspWorkspaceApplyEditResponse {
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            applied: false,
            failure_reason: Some(reason.into()),
            failed_change: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspWorkspaceApplyEditRequest {
    request_id: String,
    workspace_id: String,
    label: Option<String>,
    edit: LspWorkspaceEdit,
}

struct PendingWorkspaceApplyEdit {
    workspace_id: String,
    sender: oneshot::Sender<LspWorkspaceApplyEditResponse>,
}

struct PendingShowMessageRequest {
    workspace_id: String,
    actions: Vec<Value>,
    sender: oneshot::Sender<Option<Value>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspShowMessageRequestEvent {
    request_id: String,
    workspace_id: String,
    server_label: String,
    message_type: u32,
    message: String,
    actions: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspShowMessageCancelledEvent {
    request_id: String,
    workspace_id: String,
    reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspShowMessageEvent {
    workspace_id: String,
    server_label: String,
    message_type: u32,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspWorkDoneProgressEvent {
    workspace_id: String,
    preset_id: String,
    server_label: String,
    root_uri: String,
    token: Value,
    kind: String,
    title: Option<String>,
    message: Option<String>,
    percentage: Option<u32>,
    cancellable: bool,
}

/// Server-initiated `workspace/diagnostic/refresh` notification for the
/// renderer. Pull diagnostics are otherwise only refreshed by the Problems
/// poller; forwarding this event keeps open-file squiggles and the project
/// Problems view in sync as soon as the server invalidates its report.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspDiagnosticsRefreshEvent {
    workspace_id: String,
    preset_id: String,
    root_uri: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspExternalFileChangeEvent {
    workspace_id: String,
    path: String,
    #[serde(rename = "type")]
    change_type: u8,
}

struct LspClientRequestBridge {
    app: OnceLock<AppHandle>,
    pending_workspace_edits: StdMutex<HashMap<String, PendingWorkspaceApplyEdit>>,
    pending_show_messages: StdMutex<HashMap<String, PendingShowMessageRequest>>,
    next_request_id: AtomicU64,
}

impl LspClientRequestBridge {
    fn new() -> Self {
        Self {
            app: OnceLock::new(),
            pending_workspace_edits: StdMutex::new(HashMap::new()),
            pending_show_messages: StdMutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
        }
    }

    fn attach_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    async fn apply_workspace_edit(
        &self,
        workspace_id: &str,
        label: Option<String>,
        edit: LspWorkspaceEdit,
    ) -> LspWorkspaceApplyEditResponse {
        let Some(app) = self.app.get().cloned() else {
            return LspWorkspaceApplyEditResponse::failed(
                "Code Workspace frontend is unavailable to apply the edit",
            );
        };
        let request_id = format!(
            "{}:{}",
            workspace_id,
            self.next_request_id.fetch_add(1, Ordering::SeqCst)
        );
        let (sender, receiver) = oneshot::channel();
        self.pending_workspace_edits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                request_id.clone(),
                PendingWorkspaceApplyEdit {
                    workspace_id: workspace_id.to_string(),
                    sender,
                },
            );
        let payload = LspWorkspaceApplyEditRequest {
            request_id: request_id.clone(),
            workspace_id: workspace_id.to_string(),
            label,
            edit,
        };
        if let Err(error) = app.emit(WORKSPACE_APPLY_EDIT_EVENT, payload) {
            self.pending_workspace_edits
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            return LspWorkspaceApplyEditResponse::failed(format!(
                "Cannot dispatch WorkspaceEdit to the editor: {error}"
            ));
        }
        match tokio::time::timeout(
            Duration::from_secs(WORKSPACE_APPLY_EDIT_TIMEOUT_SECS),
            receiver,
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => LspWorkspaceApplyEditResponse::failed(
                "Code Workspace closed before applying the edit",
            ),
            Err(_) => {
                self.pending_workspace_edits
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&request_id);
                LspWorkspaceApplyEditResponse::failed("WorkspaceEdit application timed out")
            }
        }
    }

    fn resolve_workspace_edit(
        &self,
        request_id: &str,
        workspace_id: &str,
        response: LspWorkspaceApplyEditResponse,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_workspace_edits
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(entry) = pending.remove(request_id) else {
            return Err(format!(
                "no pending LSP WorkspaceEdit request '{request_id}'"
            ));
        };
        if entry.workspace_id != workspace_id {
            pending.insert(request_id.to_string(), entry);
            return Err("WorkspaceEdit response does not match the target workspace".into());
        }
        let _ = entry.sender.send(response);
        Ok(())
    }

    fn start_show_message_request(
        &self,
        workspace_id: &str,
        server_label: &str,
        message_type: u32,
        message: String,
        actions: Vec<Value>,
    ) -> Result<(String, oneshot::Receiver<Option<Value>>), String> {
        let app = self.app.get().cloned().ok_or_else(|| {
            "Code Workspace frontend is unavailable to show the message".to_string()
        })?;
        let request_id = format!(
            "{}:message:{}",
            workspace_id,
            self.next_request_id.fetch_add(1, Ordering::SeqCst)
        );
        let (sender, receiver) = oneshot::channel();
        self.pending_show_messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                request_id.clone(),
                PendingShowMessageRequest {
                    workspace_id: workspace_id.to_string(),
                    actions: actions.clone(),
                    sender,
                },
            );
        let payload = LspShowMessageRequestEvent {
            request_id: request_id.clone(),
            workspace_id: workspace_id.to_string(),
            server_label: server_label.to_string(),
            message_type,
            message,
            actions,
        };
        if let Err(error) = app.emit(SHOW_MESSAGE_REQUEST_EVENT, payload) {
            self.pending_show_messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            return Err(format!(
                "Cannot dispatch language server message to the editor: {error}"
            ));
        }
        Ok((request_id, receiver))
    }

    async fn wait_for_show_message(
        &self,
        request_id: &str,
        receiver: oneshot::Receiver<Option<Value>>,
    ) -> Result<Option<Value>, String> {
        match tokio::time::timeout(
            Duration::from_secs(SHOW_MESSAGE_REQUEST_TIMEOUT_SECS),
            receiver,
        )
        .await
        {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Language server message request was cancelled".into()),
            Err(_) => {
                self.cancel_show_message(request_id, "Message request timed out");
                Err("Language server message request timed out waiting for user input".into())
            }
        }
    }

    fn resolve_show_message(
        &self,
        request_id: &str,
        workspace_id: &str,
        action_index: Option<u32>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_show_messages
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(entry) = pending.remove(request_id) else {
            return Err(format!("no pending LSP message request '{request_id}'"));
        };
        if entry.workspace_id != workspace_id {
            pending.insert(request_id.to_string(), entry);
            return Err(
                "Language server message response does not match the target workspace".into(),
            );
        }
        let selected = match action_index {
            Some(index) => match entry.actions.get(index as usize).cloned() {
                Some(action) => Some(action),
                None => {
                    pending.insert(request_id.to_string(), entry);
                    return Err(format!(
                        "Language server message action {index} is out of range"
                    ));
                }
            },
            None => None,
        };
        let _ = entry.sender.send(selected);
        Ok(())
    }

    fn cancel_show_message(&self, request_id: &str, reason: &str) -> bool {
        let entry = self
            .pending_show_messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(request_id);
        let Some(entry) = entry else {
            return false;
        };
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                SHOW_MESSAGE_CANCELLED_EVENT,
                LspShowMessageCancelledEvent {
                    request_id: request_id.to_string(),
                    workspace_id: entry.workspace_id,
                    reason: reason.to_string(),
                },
            );
        }
        true
    }

    fn emit_show_message(&self, payload: LspShowMessageEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(SHOW_MESSAGE_EVENT, payload);
        }
    }

    fn emit_work_done_progress(&self, payload: LspWorkDoneProgressEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(WORK_DONE_PROGRESS_EVENT, payload);
        }
    }

    fn emit_diagnostics_refresh(&self, payload: LspDiagnosticsRefreshEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(DIAGNOSTICS_REFRESH_EVENT, payload);
        }
    }

    fn emit_external_file_change(&self, payload: LspExternalFileChangeEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(EXTERNAL_FILE_CHANGE_EVENT, payload);
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct DynamicCapabilityRegistration {
    id: String,
    method: String,
    register_options: Value,
}

#[derive(Clone, Copy)]
struct CachedCommandAvailability {
    available: bool,
    checked_at: Instant,
}

static COMMAND_AVAILABILITY_CACHE: OnceLock<StdMutex<HashMap<String, CachedCommandAvailability>>> =
    OnceLock::new();

/// User-configured JDK home / `java` binary path from Language Servers settings.
/// Prefer this over auto-detected JAVA_HOME/PATH so GUI-launched Taomni can use
/// a JDK that is not on the process environment (common on Windows).
static CONFIGURED_JAVA_HOME: OnceLock<StdMutex<Option<PathBuf>>> = OnceLock::new();

/// User-configured jdtls JVM args (space-separated). `None` / empty → [`DEFAULT_JDTLS_VMARGS`].
static CONFIGURED_JAVA_VMARGS: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

/// User-configured `java.*` language settings (Lombok, autobuild, organize imports,
/// code generation, …). `None` → [`JavaLanguageSettings::default`]. Applied at jdtls
/// `initialize` and hot-updated via `workspace/didChangeConfiguration`.
static CONFIGURED_JAVA_SETTINGS: OnceLock<StdMutex<Option<JavaLanguageSettings>>> = OnceLock::new();

#[derive(Clone, Debug)]
struct SemanticTokensCache {
    result_id: String,
    data: Vec<u64>,
}

#[derive(Clone, Debug)]
struct WorkDoneProgressState {
    token: Value,
    cancellable: bool,
    title: Option<String>,
}

type LspSessionRegistry = Arc<Mutex<HashMap<String, LspSessionEntry>>>;
type LspLastErrorRegistry = Arc<Mutex<HashMap<String, String>>>;

struct WorkspaceWatcherHandle {
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Debug)]
struct WorkspaceWatchTarget {
    /// Whether notify should recurse below the requested directory.
    recursive: bool,
    /// Logical path used to discard events outside the requested workspace root
    /// or loose file. For a missing loose file this is the file itself, not its
    /// parent directory.
    filter_path: PathBuf,
}

pub struct LspManager {
    sessions: LspSessionRegistry,
    /// Last unexpected exit / start failure per session key. Surfaced by
    /// `document_status` so the UI does not stick on a silent "starting…"
    /// after the process dies with `available=true, active=false`.
    last_errors: LspLastErrorRegistry,
    sdk: Arc<SdkManager>,
    client_bridge: Arc<LspClientRequestBridge>,
    workspace_watchers: Arc<Mutex<HashMap<String, WorkspaceWatcherHandle>>>,
    local_watched_events: Arc<StdMutex<HashMap<(String, String, u8), Instant>>>,
    workspace_symbol_resolutions: Arc<Mutex<HashMap<String, WorkspaceSymbolResolutionBatch>>>,
    workspace_symbol_queries: Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>,
    next_workspace_symbol_query_id: AtomicU64,
}

enum LspSessionEntry {
    Starting(Arc<LspSessionStart>),
    Ready(Arc<LspSession>),
}

enum LspSessionClaim {
    Start(Arc<LspSessionStart>),
    Wait(Arc<LspSessionStart>),
    Ready(Arc<LspSession>),
}

struct LspSessionStart {
    workspace_id: String,
    result: Mutex<Option<Result<Arc<LspSession>, String>>>,
    completed: Notify,
    cancellation: Mutex<Option<String>>,
    cancelled: Notify,
}

struct LspSession {
    key: LspSessionKey,
    preset: LspServerPreset,
    command: LspServerCommandPreset,
    root_uri: String,
    root_name: String,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    incoming_show_message_requests: Mutex<HashMap<String, String>>,
    opened_documents: RwLock<HashSet<String>>,
    diagnostics: RwLock<HashMap<String, Vec<LspDiagnostic>>>,
    diagnostic_result_ids: RwLock<HashMap<String, String>>,
    diagnostic_pull_lock: Mutex<()>,
    /// Partial `workspace/diagnostic` reports are delivered through
    /// `$/progress` using a request-scoped token. Keep the raw report items
    /// until the matching final response arrives, then apply the complete
    /// report atomically.
    diagnostic_partial_results: Mutex<HashMap<String, Vec<Value>>>,
    diagnostic_provider_generation: AtomicU64,
    capabilities: RwLock<Option<LspCapabilitySummary>>,
    server_capabilities: RwLock<Value>,
    client_configuration: RwLock<Value>,
    work_done_progress: RwLock<HashMap<String, WorkDoneProgressState>>,
    dynamic_capabilities: RwLock<HashMap<String, DynamicCapabilityRegistration>>,
    text_document_sync_kind: AtomicU8,
    semantic_token_types: RwLock<Vec<String>>,
    semantic_token_modifiers: RwLock<Vec<String>>,
    semantic_tokens_delta: RwLock<bool>,
    semantic_tokens_cache: RwLock<HashMap<String, SemanticTokensCache>>,
    semantic_tokens_lock: Mutex<()>,
    next_id: AtomicU64,
    shutting_down: AtomicBool,
    child: Mutex<Child>,
    stderr_tail: Mutex<String>,
    client_bridge: Arc<LspClientRequestBridge>,
}

#[derive(Clone)]
struct ResolvedDocument {
    path: PathBuf,
    uri: String,
    root_path: PathBuf,
    workspace_id: String,
    preset: Option<LspServerPreset>,
    language_id: Option<String>,
    version: i64,
}

impl LspManager {
    pub fn new() -> Self {
        Self::with_sdk(Arc::new(SdkManager::load(
            crate::sdk::default_sdk_registry_path(),
        )))
    }

    pub fn with_sdk(sdk: Arc<SdkManager>) -> Self {
        // Drop indexes for projects that no longer exist so the cache dir does not
        // grow without bound. Off the async path — never blocks startup.
        std::thread::spawn(prune_stale_jdtls_data_dirs);
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            last_errors: Arc::new(Mutex::new(HashMap::new())),
            sdk,
            client_bridge: Arc::new(LspClientRequestBridge::new()),
            workspace_watchers: Arc::new(Mutex::new(HashMap::new())),
            local_watched_events: Arc::new(StdMutex::new(HashMap::new())),
            workspace_symbol_resolutions: Arc::new(Mutex::new(HashMap::new())),
            workspace_symbol_queries: Arc::new(Mutex::new(HashMap::new())),
            next_workspace_symbol_query_id: AtomicU64::new(1),
        }
    }

    pub fn attach_app(&self, app: AppHandle) {
        self.client_bridge.attach_app(app);
    }

    async fn stop_workspace_watcher(&self, workspace_id: &str) {
        let handle = self.workspace_watchers.lock().await.remove(workspace_id);
        let Some(mut handle) = handle else {
            return;
        };
        if let Some(stop) = handle.stop.take() {
            let _ = stop.send(());
        }
        handle.task.abort();
    }

    async fn start_workspace_watcher(
        &self,
        workspace_id: &str,
        roots: Vec<String>,
    ) -> Result<(), String> {
        let mut roots = roots
            .into_iter()
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty())
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        for root in &roots {
            if !Path::new(root).is_absolute() {
                return Err(format!(
                    "workspace watcher requires an absolute root path: {root}"
                ));
            }
        }
        self.stop_workspace_watcher(workspace_id).await;
        if roots.is_empty() {
            return Ok(());
        }

        let (event_sender, mut event_receiver) = mpsc::unbounded_channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = event_sender.send(event);
            },
            NotifyConfig::default(),
        )
        .map_err(|error| format!("cannot initialize workspace file watcher: {error}"))?;
        let mut watched_roots = 0;
        let mut root_errors = Vec::new();
        let mut watch_targets = Vec::new();
        let mut watch_registrations: HashMap<String, (PathBuf, bool, Vec<String>)> = HashMap::new();
        for root in &roots {
            let requested = PathBuf::from(root);
            let (watch_path, recursive, filter_path) = if requested.is_dir() {
                (requested.clone(), true, requested)
            } else if requested.exists() {
                // notify accepts files on all supported backends, but recursive
                // mode is rejected by some platform watchers for a file path.
                (requested.clone(), false, requested)
            } else if let Some(parent) = requested.parent().filter(|parent| parent.is_dir()) {
                // A loose file can be deleted before the workspace opens it. Keep
                // watching its parent so a later recreate is observable, while
                // filtering sibling events below.
                (parent.to_path_buf(), false, requested)
            } else {
                root_errors.push(format!("{root}: parent directory does not exist"));
                continue;
            };
            let mut registration_key = normalized_file_operation_path(&watch_path);
            if cfg!(windows) {
                registration_key.make_ascii_lowercase();
            }
            let registration = watch_registrations
                .entry(registration_key)
                .or_insert_with(|| (watch_path, false, Vec::new()));
            registration.1 |= recursive;
            registration.2.push(root.clone());
            watch_targets.push(WorkspaceWatchTarget {
                recursive,
                filter_path,
            });
        }
        let mut watch_registrations = watch_registrations.into_values().collect::<Vec<_>>();
        watch_registrations.sort_by(|left, right| {
            normalized_file_operation_path(&left.0).cmp(&normalized_file_operation_path(&right.0))
        });
        for (watch_path, recursive, requested_roots) in watch_registrations {
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            match watcher.watch(&watch_path, mode) {
                Ok(()) => watched_roots += 1,
                Err(error) => root_errors.push(format!("{}: {error}", requested_roots.join(", "))),
            }
        }
        if watched_roots == 0 {
            return Err(format!(
                "cannot watch workspace roots: {}",
                root_errors.join("; ")
            ));
        }

        let (stop_sender, mut stop_receiver) = oneshot::channel();
        let workspace_id = workspace_id.to_string();
        let watcher_workspace_id = workspace_id.clone();
        let sessions = self.sessions.clone();
        let client_bridge = self.client_bridge.clone();
        let local_events = self.local_watched_events.clone();
        let task = tokio::spawn(async move {
            // Keep the watcher alive for the lifetime of this task.
            let _watcher = watcher;
            let mut recent_external: HashMap<(String, u8), Instant> = HashMap::new();
            loop {
                tokio::select! {
                    _ = &mut stop_receiver => break,
                    event = event_receiver.recv() => {
                        let Some(event) = event else { break; };
                        let Ok(event) = event else {
                            log::warn!("workspace file watcher failed: {event:?}");
                            continue;
                        };
                        let changes = notify_event_changes(&event);
                        if changes.is_empty() {
                            continue;
                        }
                        let changes = changes
                            .into_iter()
                            .filter(|change| {
                                workspace_watch_target_matches(&watch_targets, &change.path)
                            })
                            .collect::<Vec<_>>();
                        if changes.is_empty() {
                            continue;
                        }
                        let now = Instant::now();
                        recent_external.retain(|_, seen| now.duration_since(*seen) < Duration::from_millis(250));
                        let mut forwarded = Vec::new();
                        for change in changes {
                            let key = (change.path.clone(), change.change_type);
                            let locally_emitted = local_watched_event_suppressed(
                                &local_events,
                                &watcher_workspace_id,
                                &change.path,
                                change.change_type,
                                now,
                            );
                            if locally_emitted || recent_external.contains_key(&key) {
                                continue;
                            }
                            recent_external.insert(key, now);
                            forwarded.push(change);
                        }
                        if forwarded.is_empty() {
                            continue;
                        }
                        for change in &forwarded {
                            client_bridge.emit_external_file_change(LspExternalFileChangeEvent {
                                workspace_id: watcher_workspace_id.clone(),
                                path: change.path.clone(),
                                change_type: change.change_type,
                            });
                        }
                        let _ = notify_watched_file_sessions(&sessions, &watcher_workspace_id, &forwarded).await;
                    }
                }
            }
        });
        self.workspace_watchers.lock().await.insert(
            workspace_id,
            WorkspaceWatcherHandle {
                stop: Some(stop_sender),
                task,
            },
        );
        if !root_errors.is_empty() {
            log::warn!(
                "workspace watcher started with unavailable roots: {}",
                root_errors.join("; ")
            );
        }
        Ok(())
    }

    fn mark_local_watched_events(&self, workspace_id: &str, changes: &[LspWatchedFileChange]) {
        let now = Instant::now();
        let mut local = self
            .local_watched_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        local.retain(|_, at| now.duration_since(*at) < Duration::from_secs(3));
        for change in changes {
            let path = normalized_file_operation_path(Path::new(&change.path));
            let mut event_types = vec![change.change_type];
            // Atomic replacement is reported as Create/Remove by some notify
            // backends even though the logical operation is Changed. Mark the
            // equivalent variants for the short local-event suppression window.
            if change.change_type == 2 {
                event_types.extend([1, 3]);
            } else {
                event_types.push(2);
            }
            for change_type in event_types {
                local.insert((workspace_id.to_string(), path.clone(), change_type), now);
            }
        }
    }

    async fn sdk_environment(&self, document: &ResolvedDocument) -> WorkspaceSdkEnvironment {
        let scope_path = document.path.parent().unwrap_or(&document.root_path);
        match self
            .sdk
            .resolve_environment(&document.root_path, scope_path)
            .await
        {
            Ok(environment) => environment,
            Err(error) => {
                log::warn!(
                    "failed to resolve SDK environment for {}: {error}",
                    document.root_path.display()
                );
                WorkspaceSdkEnvironment::passthrough(&document.root_path, scope_path)
            }
        }
    }

    async fn document_status(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> LspDocumentStatus {
        let Some(preset) = document.preset.as_ref() else {
            return LspDocumentStatus {
                path: document.path.to_string_lossy().into_owned(),
                uri: document.uri.clone(),
                preset_id: None,
                language_id: document.language_id.clone(),
                display_name: None,
                available: false,
                active: false,
                selected_command_id: None,
                selected_command: None,
                install_hint: None,
                error: Some("No language server preset for this file type".into()),
                capabilities: None,
            };
        };

        let sdk_environment = self.sdk_environment(document).await;

        let configured_command = configured_command(preset, preferred_command_id, custom_command);
        let command = select_available_command(preset, preferred_command_id, custom_command);
        let selected_command_id = command
            .as_ref()
            .or(configured_command.as_ref())
            .map(|cmd| cmd.id.clone());
        let selected_command = command
            .as_ref()
            .or(configured_command.as_ref())
            .map(|cmd| command_line(&cmd.command, &cmd.args));
        let map_key = command
            .as_ref()
            .map(|cmd| session_key(document, preset, cmd, &sdk_environment).map_key());
        let (active, starting, capabilities) = if let Some(cmd) = command.as_ref() {
            let key = session_key(document, preset, cmd, &sdk_environment);
            match self.sessions.lock().await.get(&key.map_key()) {
                Some(LspSessionEntry::Ready(session)) => {
                    (true, false, session.capabilities.read().await.clone())
                }
                Some(LspSessionEntry::Starting(_)) => (false, true, None),
                None => (false, false, None),
            }
        } else {
            (false, false, None)
        };
        let using_custom = custom_command_to_preset(custom_command).is_some();
        let binary_available = command.is_some();
        let jdtls_runtime_error = if !active && command.as_ref().is_some_and(command_is_jdtls) {
            resolve_java_for_jdtls_with_sdk(
                sdk_environment.tooling_java_home.as_deref().map(Path::new),
                sdk_environment.tooling_java_error.as_deref(),
            )
            .err()
        } else {
            None
        };
        // jdtls needs a suitable JDK as well as the wrapper on PATH.
        let available = binary_available && jdtls_runtime_error.is_none();
        let last_error = if active || starting {
            None
        } else if let Some(key) = map_key.as_ref() {
            self.last_errors.lock().await.get(key).cloned()
        } else {
            None
        };
        LspDocumentStatus {
            path: document.path.to_string_lossy().into_owned(),
            uri: document.uri.clone(),
            preset_id: Some(preset.id.clone()),
            language_id: document.language_id.clone(),
            display_name: Some(preset.display_name.clone()),
            available,
            active,
            selected_command_id,
            selected_command,
            // Only advertise install guidance when the binary is missing. Always
            // returning install_hint made the editor pill show "Install: …" even
            // when jdtls was on PATH but the session was still starting/failed.
            // When jdtls is present but Java is too old, prefer the runtime error
            // over a generic "install jdtls" hint.
            install_hint: if binary_available {
                None
            } else if using_custom {
                Some("Check the custom language server command".into())
            } else {
                primary_install_hint(preset)
            },
            error: if active {
                None
            } else if let Some(error) = last_error {
                Some(error)
            } else if let Some(error) = jdtls_runtime_error {
                Some(error)
            } else if binary_available {
                // Binary ok, not active, no recorded failure: idle / starting.
                None
            } else if using_custom {
                Some(format!(
                    "Custom {} language server command is not available",
                    preset.display_name
                ))
            } else {
                Some(format!(
                    "{} language server is not installed",
                    preset.display_name
                ))
            },
            capabilities,
        }
    }

    async fn remember_error(&self, map_key: &str, error: impl Into<String>) {
        self.last_errors
            .lock()
            .await
            .insert(map_key.to_string(), error.into());
    }

    async fn clear_error(&self, map_key: &str) {
        self.last_errors.lock().await.remove(map_key);
    }

    async fn ensure_session(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> Result<Arc<LspSession>, LspDocumentStatus> {
        let Some(preset) = document.preset.as_ref() else {
            return Err(self
                .document_status(document, preferred_command_id, custom_command)
                .await);
        };
        let Some(command) = select_available_command(preset, preferred_command_id, custom_command)
        else {
            return Err(self
                .document_status(document, preferred_command_id, custom_command)
                .await);
        };
        let sdk_environment = self.sdk_environment(document).await;
        let key = session_key(document, preset, &command, &sdk_environment);
        let map_key = key.map_key();
        let start = match self.claim_session(&map_key, &document.workspace_id).await {
            LspSessionClaim::Ready(session) => {
                self.clear_error(&map_key).await;
                return Ok(session);
            }
            LspSessionClaim::Wait(start) => {
                return match start.wait().await {
                    Ok(session) => {
                        self.clear_error(&map_key).await;
                        Ok(session)
                    }
                    Err(error) => {
                        self.remember_error(&map_key, error.clone()).await;
                        Err(session_start_error_status(
                            document, preset, &command, error,
                        ))
                    }
                };
            }
            LspSessionClaim::Start(start) => {
                // Clear a previous exit error so the UI can show "starting…"
                // while this attempt is in flight.
                self.clear_error(&map_key).await;
                start
            }
        };

        // Fail fast with a Settings-visible message before spawning when the
        // JDK is too old for current Eclipse JDT LS (all platforms).
        if command_is_jdtls(&command)
            && let Err(error) = resolve_java_for_jdtls_with_sdk(
                sdk_environment.tooling_java_home.as_deref().map(Path::new),
                sdk_environment.tooling_java_error.as_deref(),
            )
        {
            let _ = self
                .finish_session_start(&map_key, &start, Err(error.clone()))
                .await;
            self.remember_error(&map_key, error.clone()).await;
            return Err(session_start_error_status(
                document, preset, &command, error,
            ));
        }

        let session_root =
            lsp_session_root(&document.root_path, &sdk_environment.project_scope_path);
        let session_root_uri = match url::Url::from_directory_path(&session_root) {
            Ok(uri) => uri.to_string(),
            Err(_) => {
                let error = format!(
                    "Cannot convert SDK project scope to file URI: {}",
                    session_root.display()
                );
                let _ = self
                    .finish_session_start(&map_key, &start, Err(error.clone()))
                    .await;
                self.remember_error(&map_key, error.clone()).await;
                return Err(session_start_error_status(
                    document, preset, &command, error,
                ));
            }
        };
        let result = LspSession::spawn(
            key.clone(),
            preset.clone(),
            command.clone(),
            session_root,
            session_root_uri,
            sdk_environment,
            self.sessions.clone(),
            self.last_errors.clone(),
            self.client_bridge.clone(),
            map_key.clone(),
            start.clone(),
        )
        .await;
        let result = self.finish_session_start(&map_key, &start, result).await;
        match &result {
            Ok(_) => self.clear_error(&map_key).await,
            Err(error) => self.remember_error(&map_key, error.clone()).await,
        }
        result.map_err(|error| session_start_error_status(document, preset, &command, error))
    }

    async fn claim_session(&self, map_key: &str, workspace_id: &str) -> LspSessionClaim {
        let mut sessions = self.sessions.lock().await;
        match sessions.get(map_key) {
            Some(LspSessionEntry::Ready(session)) => LspSessionClaim::Ready(session.clone()),
            Some(LspSessionEntry::Starting(start)) => LspSessionClaim::Wait(start.clone()),
            None => {
                let start = Arc::new(LspSessionStart::new(workspace_id.to_string()));
                sessions.insert(
                    map_key.to_string(),
                    LspSessionEntry::Starting(start.clone()),
                );
                LspSessionClaim::Start(start)
            }
        }
    }

    async fn finish_session_start(
        &self,
        map_key: &str,
        start: &Arc<LspSessionStart>,
        result: Result<Arc<LspSession>, String>,
    ) -> Result<Arc<LspSession>, String> {
        let mut sessions = self.sessions.lock().await;
        let owns_slot = matches!(
            sessions.get(map_key),
            Some(LspSessionEntry::Starting(current)) if Arc::ptr_eq(current, start)
        );
        if owns_slot {
            match result.as_ref() {
                Ok(session) => {
                    sessions.insert(map_key.to_string(), LspSessionEntry::Ready(session.clone()));
                }
                Err(_) => {
                    sessions.remove(map_key);
                }
            }
        }
        drop(sessions);
        if !owns_slot && let Ok(session) = result.as_ref() {
            session.shutdown().await;
        }
        start.complete(result).await;
        start.wait().await
    }

    async fn stop_workspace(&self, workspace_id: &str) -> usize {
        self.stop_workspace_watcher(workspace_id).await;
        if let Some((_, cancellation)) = self
            .workspace_symbol_queries
            .lock()
            .await
            .remove(workspace_id)
        {
            cancellation.cancel();
        }
        self.workspace_symbol_resolutions
            .lock()
            .await
            .retain(|_, batch| batch.workspace_id != workspace_id);
        let (starts, ready) = {
            let mut sessions = self.sessions.lock().await;
            let matching: Vec<String> = sessions
                .iter()
                .filter_map(|(map_key, entry)| {
                    (entry.workspace_id() == workspace_id).then(|| map_key.clone())
                })
                .collect();
            let mut starts = Vec::new();
            let mut ready = Vec::new();
            for map_key in matching {
                match sessions.remove(&map_key) {
                    Some(LspSessionEntry::Starting(start)) => starts.push(start),
                    Some(LspSessionEntry::Ready(session)) => ready.push(session),
                    None => {}
                }
            }
            (starts, ready)
        };
        let stopped = starts.len() + ready.len();
        for start in starts {
            start
                .cancel(format!("LSP workspace stopped: {workspace_id}"))
                .await;
        }
        for session in ready {
            session.shutdown().await;
        }
        stopped
    }

    async fn active_session(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> Option<Arc<LspSession>> {
        let preset = document.preset.as_ref()?;
        let command = select_available_command(preset, preferred_command_id, custom_command)?;
        let sdk_environment = self.sdk_environment(document).await;
        let key = session_key(document, preset, &command, &sdk_environment);
        match self.sessions.lock().await.get(&key.map_key()) {
            Some(LspSessionEntry::Ready(session)) => Some(session.clone()),
            Some(LspSessionEntry::Starting(_)) | None => None,
        }
    }

    /// Run a jdtls `workspace/executeCommand` on the active session for a project
    /// file (M8): the shared jdtls access path for the Java debug adapter (D2,
    /// `vscode.java.resolveClasspath` / `startDebugSession` …) and test discovery
    /// (E, `vscode.java.test.*`). Errors when no jdtls session is active.
    pub async fn execute_java_command(
        &self,
        workspace_id: String,
        root_path: Option<String>,
        file_path: String,
        command: &str,
        arguments: Vec<Value>,
        identity: JavaSessionIdentity,
    ) -> Result<Value, String> {
        let document =
            resolve_document(workspace_id, root_path, file_path, Some("java".into()), 0)?;
        // Debug + test must target the SAME jdtls session the editor uses. When a
        // custom jdtls command is configured, the default `active_session(None,
        // None)` lookup recomputes the default `jdtls` session key and misses the
        // custom one — so intelligence works while debug/test report "no active
        // Java language server". Forward the caller's command identity so the
        // session key matches the editor's.
        let session = self
            .active_session(
                &document,
                identity.preferred_command_id.as_deref(),
                identity.custom_command.as_ref(),
            )
            .await
            .ok_or_else(|| {
                "No Java language server session is active for this project; open a project file first"
                    .to_string()
            })?;
        let started = Instant::now();
        let result = session
            .request_with_timeout(
                "workspace/executeCommand",
                json!({ "command": command, "arguments": arguments }),
                JAVA_COMMAND_TIMEOUT_SECS,
            )
            .await;
        match &result {
            Ok(_) => log::info!("lsp: {command} ok in {:?}", started.elapsed()),
            Err(error) => log::warn!(
                "lsp: {command} failed after {:?}: {error}",
                started.elapsed()
            ),
        }
        result
    }

    /// Push a `workspace/didChangeConfiguration` to every ready jdtls session so
    /// `java.*` settings changes take effect without restarting the servers.
    async fn notify_all_jdtls(&self, method: &str, params: Value) -> usize {
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if command_is_jdtls(&session.command) => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect()
        };
        let mut notified = 0;
        for session in sessions {
            if method == "workspace/didChangeConfiguration"
                && let Some(settings) = params.get("settings")
            {
                session.merge_client_configuration(settings).await;
            }
            if session.notify(method, params.clone()).await.is_ok() {
                notified += 1;
            }
        }
        notified
    }

    async fn cancel_work_done_progress(
        &self,
        workspace_id: &str,
        preset_id: &str,
        root_uri: &str,
        token: &Value,
    ) -> Result<bool, String> {
        if !is_progress_token(token) {
            return Err("work-done progress token must be a string or integer".into());
        }
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session)
                        if session.key.workspace_id == workspace_id
                            && session.key.preset_id == preset_id
                            && session.root_uri == root_uri =>
                    {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect()
        };
        let mut cancelled = false;
        for session in sessions {
            cancelled |= session.cancel_work_done_progress(token).await?;
        }
        Ok(cancelled)
    }

    async fn workspace_file_operation_sessions(&self, workspace_id: &str) -> Vec<Arc<LspSession>> {
        let guard = self.sessions.lock().await;
        let mut sessions = guard
            .iter()
            .filter_map(|(key, entry)| match entry {
                LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                    Some((key.clone(), session.clone()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.0.cmp(&right.0));
        sessions.into_iter().map(|(_, session)| session).collect()
    }

    async fn will_workspace_file_operation(
        &self,
        workspace_id: &str,
        operation: &LspWorkspaceFileOperation,
    ) -> Result<usize, String> {
        let method = operation.will_method();
        let sessions = self.workspace_file_operation_sessions(workspace_id).await;
        let mut requested = 0;
        let mut applied_edits = 0;
        for session in sessions {
            let Some(params) = session
                .workspace_file_operation_params(method, operation)
                .await?
            else {
                continue;
            };
            requested += 1;
            let result = session.request(method, params).await.map_err(|error| {
                format!(
                    "{} could not prepare for {}: {error}",
                    session.preset.display_name,
                    operation.label()
                )
            })?;
            if result.is_null() {
                continue;
            }
            if !result.is_object() {
                return Err(format!(
                    "{} returned an invalid {method} result",
                    session.preset.display_name
                ));
            }
            let edit = parse_workspace_edit(&result);
            if edit.operations.is_empty() {
                continue;
            }
            let response = self
                .client_bridge
                .apply_workspace_edit(
                    workspace_id,
                    Some(format!(
                        "{} before {}",
                        session.preset.display_name,
                        operation.label()
                    )),
                    edit,
                )
                .await;
            if !response.applied {
                let failed_change = response
                    .failed_change
                    .map(|index| format!(" at change {index}"))
                    .unwrap_or_default();
                let partial = (applied_edits > 0)
                    .then(|| {
                        format!("; {applied_edits} earlier server edit(s) were already applied")
                    })
                    .unwrap_or_default();
                return Err(format!(
                    "Cannot continue {}: {}{}{}",
                    operation.label(),
                    response
                        .failure_reason
                        .unwrap_or_else(|| "language-server edit was not applied".into()),
                    failed_change,
                    partial
                ));
            }
            applied_edits += 1;
        }
        Ok(requested)
    }

    async fn did_workspace_file_operation(
        &self,
        workspace_id: &str,
        operation: &LspWorkspaceFileOperation,
    ) -> usize {
        let method = operation.did_method();
        let sessions = self.workspace_file_operation_sessions(workspace_id).await;
        let mut notified = 0;
        for session in sessions {
            let params = match session
                .workspace_file_operation_params(method, operation)
                .await
            {
                Ok(Some(params)) => params,
                Ok(None) => continue,
                Err(error) => {
                    log::warn!(
                        "cannot prepare {method} for {}: {error}",
                        session.preset.display_name
                    );
                    continue;
                }
            };
            match session.notify(method, params).await {
                Ok(()) => notified += 1,
                Err(error) => log::warn!(
                    "cannot notify {} with {method}: {error}",
                    session.preset.display_name
                ),
            }
        }
        let watched_changes = operation.watched_file_changes();
        if !watched_changes.is_empty() {
            let watched_sessions = self
                .did_change_watched_files(workspace_id, &watched_changes)
                .await;
            log::debug!(
                "lsp: forwarded {} watched-file event batch(es) after {}",
                watched_sessions,
                operation.label()
            );
        }
        notified
    }

    async fn did_change_watched_files(
        &self,
        workspace_id: &str,
        changes: &[LspWatchedFileChange],
    ) -> usize {
        if changes.is_empty() {
            return 0;
        }
        self.mark_local_watched_events(workspace_id, changes);
        notify_watched_file_sessions(&self.sessions, workspace_id, changes).await
    }

    /// Refresh pull-capable servers, then collect every stored diagnostic across
    /// ready sessions for `workspace_id` (M7-C). Includes files the user never
    /// opened, de-duplicated per file (later sessions win) and sorted by path.
    /// Library / virtual (`jdt://`, non-`file:`) URIs are skipped.
    async fn workspace_diagnostics(&self, workspace_id: &str) -> Vec<WorkspaceDiagnosticFile> {
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            let mut sessions = guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            sessions.sort_by(|left, right| left.key.map_key().cmp(&right.key.map_key()));
            sessions
        };
        let pull_results = futures::future::join_all(
            sessions
                .iter()
                .map(|session| session.pull_workspace_diagnostics()),
        )
        .await;
        for (session, result) in sessions.iter().zip(pull_results) {
            if let Err(error) = result {
                // Keep publishDiagnostics data available when a server's advertised
                // pull provider fails. This path may run on a short polling interval,
                // so avoid repeating the same failure as a warning-level toast/log.
                log::debug!(
                    "lsp: workspace/diagnostic failed for {}: {error}",
                    session.preset.display_name
                );
            }
        }
        let mut by_path: HashMap<String, WorkspaceDiagnosticFile> = HashMap::new();
        for session in sessions {
            for (uri, diagnostics) in session.diagnostics.read().await.iter() {
                if diagnostics.is_empty() {
                    continue;
                }
                let Some(path) = file_path_from_uri(uri) else {
                    continue;
                };
                by_path.insert(
                    path.clone(),
                    WorkspaceDiagnosticFile {
                        path,
                        uri: uri.clone(),
                        diagnostics: diagnostics.clone(),
                    },
                );
            }
        }
        let mut files: Vec<WorkspaceDiagnosticFile> = by_path.into_values().collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    /// Query every ready language-server session in a workspace for
    /// `workspace/symbol`. The old command path queried only the session that
    /// owned the active document, which silently dropped symbols from other
    /// roots and languages in a multi-root project.
    async fn workspace_symbols(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<WorkspaceSymbolsAggregation, String> {
        let query_id = self
            .next_workspace_symbol_query_id
            .fetch_add(1, Ordering::SeqCst);
        let cancellation = {
            let mut queries = self.workspace_symbol_queries.lock().await;
            begin_workspace_symbol_query(&mut queries, workspace_id, query_id)
        };
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            let mut sessions = guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            sessions.sort_by(|left, right| left.key.map_key().cmp(&right.key.map_key()));
            sessions
        };

        let session_count = sessions.len() as u32;
        let provider_limit_reached = sessions.len() > MAX_WORKSPACE_SYMBOL_PROVIDERS;

        let capability_checks = sessions
            .into_iter()
            .take(MAX_WORKSPACE_SYMBOL_PROVIDERS)
            .map(|session| async move {
                let capabilities = session.capabilities.read().await;
                let capabilities = capabilities.as_ref()?;
                capabilities
                    .workspace_symbol
                    .then_some((session.clone(), capabilities.workspace_symbol_resolve))
            });
        let capable = futures::future::join_all(capability_checks)
            .await
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let provider_count = capable.len() as u32;
        // `capable` is collected only from the bounded session prefix, so all
        // other ready sessions (including sessions without the capability and
        // sessions beyond the fan-out limit) are intentionally skipped.
        let skipped_provider_count = session_count.saturating_sub(provider_count);
        let responses = futures::future::join_all(
            capable
                .into_iter()
                .take(MAX_WORKSPACE_SYMBOL_PROVIDERS)
                .map(|(session, supports_resolve)| {
                    let cancellation = cancellation.clone();
                    async move {
                        let label = session.preset.display_name.clone();
                        let result = session
                            .request_with_cancellation(
                                "workspace/symbol",
                                json!({ "query": query }),
                                &cancellation,
                            )
                            .await;
                        (label, session.key.map_key(), supports_resolve, result)
                    }
                }),
        )
        .await;
        let mut aggregation = aggregate_workspace_symbol_responses(
            responses,
            session_count,
            provider_count,
            skipped_provider_count,
            provider_limit_reached,
        );
        // Serialize the latest-query check with replacement so an old query
        // cannot pass the check and then populate the resolve cache after a
        // newer query starts.
        let mut queries = self.workspace_symbol_queries.lock().await;
        let is_latest = queries
            .get(workspace_id)
            .is_some_and(|(current_id, _)| *current_id == query_id);
        if cancellation.is_cancelled() || !is_latest {
            return Err("Workspace symbol query was superseded by a newer query".into());
        }
        self.cache_workspace_symbol_resolutions(workspace_id, &mut aggregation)
            .await;
        queries.remove(workspace_id);
        Ok(aggregation)
    }

    async fn cache_workspace_symbol_resolutions(
        &self,
        workspace_id: &str,
        aggregation: &mut WorkspaceSymbolsAggregation,
    ) {
        if !aggregation
            .symbols
            .iter()
            .any(|symbol| symbol.raw.is_some())
        {
            return;
        }

        let sessions = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .filter_map(|(key, entry)| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some((key.clone(), Arc::downgrade(session)))
                    }
                    _ => None,
                })
                .collect::<HashMap<_, _>>()
        };
        let batch_id = uuid::Uuid::new_v4().simple().to_string();
        let mut bytes = 0usize;
        let mut entries = HashMap::new();
        let mut skipped = 0usize;
        for (index, symbol) in aggregation.symbols.iter_mut().enumerate() {
            let Some(raw) = symbol.raw.take() else {
                continue;
            };
            let Some(provider_session_key) = symbol.provider_session_key.take() else {
                skipped += 1;
                continue;
            };
            let raw_bytes = match serde_json::to_vec(&raw) {
                Ok(value) => value.len(),
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let Some(session) = sessions.get(&provider_session_key) else {
                skipped += 1;
                continue;
            };
            if raw_bytes > MAX_WORKSPACE_SYMBOL_RAW_BYTES
                || bytes.saturating_add(raw_bytes) > MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES
            {
                skipped += 1;
                continue;
            }
            let entry_id = index.to_string();
            entries.insert(
                entry_id.clone(),
                WorkspaceSymbolResolutionEntry {
                    session: session.clone(),
                    raw,
                },
            );
            bytes += raw_bytes;
            symbol.resolve_token = Some(format!("{batch_id}:{entry_id}"));
        }
        if entries.is_empty() {
            if skipped > 0 {
                push_workspace_symbol_diagnostic(
                    &mut aggregation.diagnostics,
                    "Workspace symbol resolve payloads exceeded the bounded cache".into(),
                );
                aggregation.complete = false;
                aggregation.truncated = true;
            }
            return;
        }

        let now = Instant::now();
        let mut batches = self.workspace_symbol_resolutions.lock().await;
        prune_workspace_symbol_resolution_batches(&mut batches, now);
        batches.insert(
            batch_id,
            WorkspaceSymbolResolutionBatch {
                workspace_id: workspace_id.to_string(),
                created_at: now,
                bytes,
                entries,
            },
        );
        prune_workspace_symbol_resolution_batches(&mut batches, now);
        if skipped > 0 {
            push_workspace_symbol_diagnostic(
                &mut aggregation.diagnostics,
                format!("{skipped} workspace symbol resolve payloads exceeded the bounded cache"),
            );
            aggregation.complete = false;
            aggregation.truncated = true;
        }
    }

    async fn resolve_workspace_symbol(
        &self,
        workspace_id: &str,
        resolve_token: &str,
    ) -> Result<LspWorkspaceSymbol, String> {
        let (batch_id, entry_id) = parse_workspace_symbol_resolve_token(resolve_token)?;
        let entry = {
            let now = Instant::now();
            let mut batches = self.workspace_symbol_resolutions.lock().await;
            prune_workspace_symbol_resolution_batches(&mut batches, now);
            let batch = batches
                .get(batch_id)
                .ok_or_else(|| "Workspace symbol resolve token expired".to_string())?;
            if batch.workspace_id != workspace_id {
                return Err("Workspace symbol resolve token belongs to another workspace".into());
            }
            batch
                .entries
                .get(entry_id)
                .cloned()
                .ok_or_else(|| "Workspace symbol resolve token is invalid".to_string())?
        };
        let session = entry
            .session
            .upgrade()
            .ok_or_else(|| "Workspace symbol provider session is no longer active".to_string())?;
        if session.key.workspace_id != workspace_id {
            return Err("Workspace symbol provider session changed".into());
        }
        let resolved = session
            .request("workspaceSymbol/resolve", entry.raw.clone())
            .await?;
        let merged = merge_workspace_symbol_values(&entry.raw, &resolved);
        let symbol = parse_workspace_symbol(&merged)
            .ok_or_else(|| "workspaceSymbol/resolve returned an invalid symbol".to_string())?;
        if !symbol.resolved {
            return Err("workspaceSymbol/resolve did not return a source range".into());
        }
        Ok(symbol)
    }
}

struct WorkspaceSymbolsAggregation {
    symbols: Vec<LspWorkspaceSymbol>,
    session_count: u32,
    provider_count: u32,
    skipped_provider_count: u32,
    failed_provider_count: u32,
    complete: bool,
    truncated: bool,
    diagnostics: Vec<String>,
}

fn aggregate_workspace_symbol_responses(
    responses: Vec<(String, String, bool, Result<Value, String>)>,
    session_count: u32,
    provider_count: u32,
    skipped_provider_count: u32,
    provider_limit_reached: bool,
) -> WorkspaceSymbolsAggregation {
    let mut diagnostics = Vec::new();
    let mut failed_provider_count = 0u32;
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = provider_limit_reached;

    for (provider, provider_session_key, supports_resolve, response) in responses {
        let value = match response {
            Ok(value) => value,
            Err(error) => {
                failed_provider_count += 1;
                push_workspace_symbol_diagnostic(&mut diagnostics, format!("{provider}: {error}"));
                continue;
            }
        };
        if value.is_null() {
            continue;
        }
        let Some(items) = value.as_array() else {
            failed_provider_count += 1;
            push_workspace_symbol_diagnostic(
                &mut diagnostics,
                format!("{provider}: invalid workspace/symbol response"),
            );
            continue;
        };
        let mut provider_malformed = false;
        let mut provider_unresolvable = false;
        for item in items {
            let Some(mut symbol) = parse_workspace_symbol(item) else {
                provider_malformed = true;
                continue;
            };
            let key = format_workspace_symbol_key(&symbol);
            if !seen.insert(key) {
                continue;
            }
            if symbols.len() >= MAX_WORKSPACE_SYMBOLS {
                truncated = true;
                continue;
            }
            if !symbol.resolved {
                if supports_resolve {
                    symbol.raw = Some(item.clone());
                    symbol.provider_session_key = Some(provider_session_key.clone());
                } else {
                    provider_unresolvable = true;
                }
            }
            symbols.push(symbol);
        }
        if provider_malformed || provider_unresolvable {
            failed_provider_count += 1;
        }
        if provider_malformed {
            push_workspace_symbol_diagnostic(
                &mut diagnostics,
                format!("{provider}: ignored malformed symbol"),
            );
        }
        if provider_unresolvable {
            push_workspace_symbol_diagnostic(
                &mut diagnostics,
                format!(
                    "{provider}: returned URI-only symbols without advertising workspaceSymbol/resolve"
                ),
            );
        }
    }
    if truncated && !provider_limit_reached {
        push_workspace_symbol_diagnostic(
            &mut diagnostics,
            format!("Workspace symbol results limited to {MAX_WORKSPACE_SYMBOLS} entries"),
        );
    } else if provider_limit_reached {
        push_workspace_symbol_diagnostic(
            &mut diagnostics,
            format!("Workspace symbol query limited to {MAX_WORKSPACE_SYMBOL_PROVIDERS} providers"),
        );
    }
    if provider_count == 0 {
        push_workspace_symbol_diagnostic(
            &mut diagnostics,
            "No active language server advertises workspace/symbol".into(),
        );
    }
    symbols.sort_by(|left, right| {
        left.path
            .as_deref()
            .unwrap_or(left.uri.as_str())
            .cmp(right.path.as_deref().unwrap_or(right.uri.as_str()))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| {
                left.selection_range
                    .start
                    .line
                    .cmp(&right.selection_range.start.line)
            })
            .then_with(|| {
                left.selection_range
                    .start
                    .character
                    .cmp(&right.selection_range.start.character)
            })
    });
    let complete = session_count > 0
        && provider_count > 0
        && skipped_provider_count == 0
        && failed_provider_count == 0
        && diagnostics.is_empty()
        && !truncated;
    WorkspaceSymbolsAggregation {
        symbols,
        session_count,
        provider_count,
        skipped_provider_count,
        failed_provider_count,
        complete,
        truncated,
        diagnostics,
    }
}

fn push_workspace_symbol_diagnostic(diagnostics: &mut Vec<String>, message: String) {
    if diagnostics.len() < MAX_WORKSPACE_SYMBOL_DIAGNOSTICS {
        diagnostics.push(message);
    }
}

fn begin_workspace_symbol_query(
    queries: &mut HashMap<String, (u64, CancellationToken)>,
    workspace_id: &str,
    query_id: u64,
) -> CancellationToken {
    let cancellation = CancellationToken::new();
    if let Some((_, previous)) =
        queries.insert(workspace_id.to_string(), (query_id, cancellation.clone()))
    {
        previous.cancel();
    }
    cancellation
}

fn parse_workspace_symbol_resolve_token(token: &str) -> Result<(&str, &str), String> {
    let (batch_id, entry_id) = token
        .split_once(':')
        .ok_or_else(|| "Workspace symbol resolve token is invalid".to_string())?;
    if batch_id.len() != 32
        || !batch_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || entry_id.is_empty()
        || !entry_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Workspace symbol resolve token is invalid".into());
    }
    Ok((batch_id, entry_id))
}

fn prune_workspace_symbol_resolution_batches(
    batches: &mut HashMap<String, WorkspaceSymbolResolutionBatch>,
    now: Instant,
) {
    batches.retain(|_, batch| {
        now.saturating_duration_since(batch.created_at) <= WORKSPACE_SYMBOL_RESOLUTION_TTL
    });
    while batches.len() > MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCHES
        || batches.values().map(|batch| batch.bytes).sum::<usize>()
            > MAX_WORKSPACE_SYMBOL_RESOLUTION_CACHE_BYTES
    {
        let Some(oldest) = batches
            .iter()
            .min_by_key(|(_, batch)| batch.created_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        batches.remove(&oldest);
    }
}

fn merge_workspace_symbol_values(original: &Value, resolved: &Value) -> Value {
    let mut merged = merge_code_action_values(original, resolved);
    let Some(original_location) = original.get("location").and_then(Value::as_object) else {
        return merged;
    };
    let Some(resolved_location) = resolved.get("location").and_then(Value::as_object) else {
        return merged;
    };
    let Some(merged_object) = merged.as_object_mut() else {
        return merged;
    };
    let mut location = original_location.clone();
    location.extend(resolved_location.clone());
    merged_object.insert("location".into(), Value::Object(location));
    merged
}

fn format_workspace_symbol_key(symbol: &LspWorkspaceSymbol) -> String {
    format!(
        "{}\u{0}{}\u{0}{}:{}:{}:{}:{}",
        symbol.uri,
        symbol.name,
        symbol.container_name.as_deref().unwrap_or_default(),
        symbol.selection_range.start.line,
        symbol.selection_range.start.character,
        symbol.selection_range.end.line,
        symbol.selection_range.end.character,
    )
}

async fn notify_watched_file_sessions(
    sessions_registry: &LspSessionRegistry,
    workspace_id: &str,
    changes: &[LspWatchedFileChange],
) -> usize {
    let guard = sessions_registry.lock().await;
    let mut sessions = guard
        .iter()
        .filter_map(|(key, entry)| match entry {
            LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                Some((key.clone(), session.clone()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    drop(guard);
    sessions.sort_by(|left, right| left.0.cmp(&right.0));
    let mut notified = 0;
    for (_, session) in sessions {
        let params = match session.watched_file_params(changes).await {
            Ok(Some(params)) => params,
            Ok(None) => continue,
            Err(error) => {
                log::warn!(
                    "cannot prepare workspace/didChangeWatchedFiles for {}: {error}",
                    session.preset.display_name
                );
                continue;
            }
        };
        match session
            .notify("workspace/didChangeWatchedFiles", params)
            .await
        {
            Ok(()) => notified += 1,
            Err(error) => log::warn!(
                "cannot notify {} with workspace/didChangeWatchedFiles: {error}",
                session.preset.display_name
            ),
        }
    }
    notified
}

/// One file's diagnostics for the workspace-wide Problems view (M7-C).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiagnosticFile {
    /// Absolute filesystem path (from the `file:` URI).
    pub path: String,
    pub uri: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

/// Convert a `file:` URI to an absolute path; `None` for `jdt://` / non-file URIs.
fn file_path_from_uri(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

impl LspSessionEntry {
    fn workspace_id(&self) -> &str {
        match self {
            Self::Starting(start) => &start.workspace_id,
            Self::Ready(session) => &session.key.workspace_id,
        }
    }
}

impl LspSessionStart {
    fn new(workspace_id: String) -> Self {
        Self {
            workspace_id,
            result: Mutex::new(None),
            completed: Notify::new(),
            cancellation: Mutex::new(None),
            cancelled: Notify::new(),
        }
    }

    async fn wait(&self) -> Result<Arc<LspSession>, String> {
        loop {
            let completed = self.completed.notified();
            if let Some(result) = self.result.lock().await.clone() {
                return result;
            }
            completed.await;
        }
    }

    async fn complete(&self, result: Result<Arc<LspSession>, String>) {
        let mut current = self.result.lock().await;
        if current.is_none() {
            *current = Some(result);
            drop(current);
            self.completed.notify_waiters();
        }
    }

    async fn cancel(&self, error: String) {
        let mut cancellation = self.cancellation.lock().await;
        if cancellation.is_none() {
            *cancellation = Some(error.clone());
            drop(cancellation);
            self.cancelled.notify_waiters();
        }
        self.complete(Err(error)).await;
    }

    async fn wait_cancelled(&self) -> String {
        loop {
            let cancelled = self.cancelled.notified();
            if let Some(error) = self.cancellation.lock().await.clone() {
                return error;
            }
            cancelled.await;
        }
    }
}

fn session_start_error_status(
    document: &ResolvedDocument,
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
    error: String,
) -> LspDocumentStatus {
    LspDocumentStatus {
        path: document.path.to_string_lossy().into_owned(),
        uri: document.uri.clone(),
        preset_id: Some(preset.id.clone()),
        language_id: document.language_id.clone(),
        display_name: Some(preset.display_name.clone()),
        available: true,
        active: false,
        selected_command_id: Some(command.id.clone()),
        selected_command: Some(command_line(&command.command, &command.args)),
        // Binary was found; this is a runtime/start failure, not "please install".
        install_hint: None,
        error: Some(error),
        capabilities: None,
    }
}

impl LspSession {
    async fn merge_client_configuration(&self, patch: &Value) {
        merge_json_value(&mut *self.client_configuration.write().await, patch);
    }

    async fn spawn(
        key: LspSessionKey,
        preset: LspServerPreset,
        command: LspServerCommandPreset,
        root_path: PathBuf,
        root_uri: String,
        sdk_environment: WorkspaceSdkEnvironment,
        sessions: LspSessionRegistry,
        last_errors: LspLastErrorRegistry,
        client_bridge: Arc<LspClientRequestBridge>,
        map_key: String,
        start: Arc<LspSessionStart>,
    ) -> Result<Arc<Self>, String> {
        let is_jdtls = command_is_jdtls(&command);
        let tooling_java_home = sdk_environment.tooling_java_home.as_deref().map(Path::new);
        let mut process = build_lsp_server_command(
            &command.command,
            &command.args,
            &root_path,
            tooling_java_home,
            sdk_environment.tooling_java_error.as_deref(),
        )
        .map_err(|e| format!("prepare {}: {e}", command.command))?;
        for (key, value) in &sdk_environment.environment {
            process.env(key, value);
        }
        if let Some(path) = sdk_environment.prepend_path(std::env::var_os("PATH").as_deref()) {
            process.env("PATH", path);
        }
        // Ensure jdtls wrappers (non-Windows) use the tooling JDK. The project
        // JDK is delivered independently through java.configuration.runtimes.
        if is_jdtls
            && let Ok((java, _)) = resolve_java_for_jdtls_with_sdk(
                tooling_java_home,
                sdk_environment.tooling_java_error.as_deref(),
            )
            && let Some(home) = java_home_from_binary(&java)
        {
            process.env("JAVA_HOME", home);
        }
        // Non-Windows launches the `jdtls` wrapper; inject JVM args via JAVA_OPTS
        // so the script's JVM picks up Settings → Language Servers vmargs.
        if is_jdtls {
            apply_jdtls_vmargs_to_command(&mut process);
        }
        let initialization_options =
            lsp_initialization_options(&preset, &command, &sdk_environment);
        let client_configuration = initialization_options
            .get("settings")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let root_name = root_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace")
            .to_string();
        process
            .current_dir(&root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        no_console_window(&mut process);
        let mut child = process
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", command.command))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{} did not expose stdin", command.command))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{} did not expose stdout", command.command))?;
        let stderr = child.stderr.take();

        let session = Arc::new(Self {
            key,
            preset,
            command,
            root_uri,
            root_name,
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            incoming_show_message_requests: Mutex::new(HashMap::new()),
            opened_documents: RwLock::new(HashSet::new()),
            diagnostics: RwLock::new(HashMap::new()),
            diagnostic_result_ids: RwLock::new(HashMap::new()),
            diagnostic_pull_lock: Mutex::new(()),
            diagnostic_partial_results: Mutex::new(HashMap::new()),
            diagnostic_provider_generation: AtomicU64::new(0),
            capabilities: RwLock::new(None),
            server_capabilities: RwLock::new(Value::Null),
            client_configuration: RwLock::new(client_configuration),
            work_done_progress: RwLock::new(HashMap::new()),
            dynamic_capabilities: RwLock::new(HashMap::new()),
            text_document_sync_kind: AtomicU8::new(1),
            semantic_token_types: RwLock::new(Vec::new()),
            semantic_token_modifiers: RwLock::new(Vec::new()),
            semantic_tokens_delta: RwLock::new(false),
            semantic_tokens_cache: RwLock::new(HashMap::new()),
            semantic_tokens_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            child: Mutex::new(child),
            stderr_tail: Mutex::new(String::new()),
            client_bridge,
        });

        tokio::spawn(read_stdout(
            session.clone(),
            stdout,
            sessions,
            last_errors,
            map_key,
        ));
        if let Some(stderr) = stderr {
            tokio::spawn(read_stderr(session.clone(), stderr));
        }

        let initialize_params = json!({
            "processId": Value::Null,
            "rootUri": session.root_uri,
            "initializationOptions": initialization_options,
            "workspaceFolders": [{
                "uri": session.root_uri,
                "name": session.root_name
            }],
            "capabilities": {
                "window": {
                    "workDoneProgress": true,
                    "showMessage": {
                        "messageActionItem": {
                            "additionalPropertiesSupport": true
                        }
                    }
                },
                "general": {
                    "staleRequestSupport": {
                        "cancel": true,
                        "retryOnContentModified": []
                    }
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": true,
                        "didSave": true
                    },
                    "hover": {
                        "dynamicRegistration": true,
                        "contentFormat": ["markdown", "plaintext"]
                    },
                    "definition": {
                        "dynamicRegistration": true,
                        "linkSupport": true
                    },
                    "typeDefinition": { "dynamicRegistration": true, "linkSupport": true },
                    "implementation": { "dynamicRegistration": true, "linkSupport": true },
                    "references": {
                        "dynamicRegistration": true
                    },
                    "completion": {
                        "dynamicRegistration": true,
                        "contextSupport": true,
                        "completionItem": {
                            "snippetSupport": true,
                            "insertReplaceSupport": true,
                            "documentationFormat": ["markdown", "plaintext"],
                            "resolveSupport": {
                                "properties": ["documentation", "detail", "additionalTextEdits"]
                            }
                        },
                        "completionItemKind": {
                            "valueSet": (1..=25u32).collect::<Vec<_>>()
                        }
                    },
                    "signatureHelp": {
                        "dynamicRegistration": true,
                        "contextSupport": true,
                        "signatureInformation": {
                            "documentationFormat": ["markdown", "plaintext"],
                            "parameterInformation": { "labelOffsetSupport": true },
                            "activeParameterSupport": true
                        }
                    },
                    "documentSymbol": {
                        "dynamicRegistration": true,
                        "hierarchicalDocumentSymbolSupport": true
                    },
                    "documentHighlight": { "dynamicRegistration": true },
                    "codeAction": {
                        "dynamicRegistration": true,
                        "isPreferredSupport": true,
                        "dataSupport": true,
                        "resolveSupport": {
                            "properties": ["edit", "command"]
                        }
                    },
                    "formatting": { "dynamicRegistration": true },
                    "rangeFormatting": { "dynamicRegistration": true },
                    "rename": { "dynamicRegistration": true, "prepareSupport": true },
                    "callHierarchy": { "dynamicRegistration": true },
                    "typeHierarchy": { "dynamicRegistration": true },
                    "inlayHint": { "dynamicRegistration": true },
                    "selectionRange": { "dynamicRegistration": true },
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "versionSupport": true,
                        "tagSupport": { "valueSet": [1, 2] },
                        "codeDescriptionSupport": true,
                        "dataSupport": true
                    },
                    "diagnostic": {
                        "dynamicRegistration": true,
                        "relatedDocumentSupport": true
                    },
                    "semanticTokens": {
                        "dynamicRegistration": true,
                        "requests": { "full": { "delta": true }, "range": false },
                        "tokenTypes": [
                            "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
                            "parameter", "variable", "property", "enumMember", "event", "function",
                            "method", "macro", "keyword", "modifier", "comment", "string", "number",
                            "regexp", "operator", "decorator"
                        ],
                        "tokenModifiers": [
                            "declaration", "definition", "readonly", "static", "deprecated",
                            "abstract", "async", "modification", "documentation", "defaultLibrary"
                        ],
                        "formats": ["relative"],
                        "overlappingTokenSupport": false,
                        "multilineTokenSupport": true
                    }
                },
                "workspace": workspace_client_capabilities()
            }
        });
        let initialize_timeout = initialize_timeout_secs(&session.command);
        let initialize_result = match tokio::select! {
            result = session.request_with_timeout(
                "initialize",
                initialize_params,
                initialize_timeout,
            ) => result,
            error = start.wait_cancelled() => {
                session.abort(&error).await;
                return Err(error);
            }
        } {
            Ok(result) => result,
            Err(error) => {
                let error = if let Some(stderr) = session.stderr_snippet().await {
                    format!("{error} ({stderr})")
                } else {
                    error
                };
                session.abort(&error).await;
                return Err(error);
            }
        };
        let server_caps = initialize_result
            .get("capabilities")
            .cloned()
            .unwrap_or(Value::Null);
        *session.server_capabilities.write().await = server_caps;
        session.refresh_capabilities().await;
        if let Some(error) = start.cancellation.lock().await.clone() {
            session.abort(&error).await;
            return Err(error);
        }
        if let Err(error) = session.notify("initialized", json!({})).await {
            session.abort(&error).await;
            return Err(error);
        }
        Ok(session)
    }

    async fn refresh_capabilities(&self) {
        let server_capabilities = self.server_capabilities.read().await.clone();
        let mut registrations = self
            .dynamic_capabilities
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        registrations.sort_by(|left, right| left.id.cmp(&right.id));
        let (summary, token_types, token_modifiers, semantic_delta) =
            capability_state_from(&server_capabilities, &registrations);
        self.text_document_sync_kind
            .store(summary.text_document_sync_kind, Ordering::SeqCst);
        *self.capabilities.write().await = Some(summary);
        *self.semantic_token_types.write().await = token_types;
        *self.semantic_token_modifiers.write().await = token_modifiers;
        *self.semantic_tokens_delta.write().await = semantic_delta;
        self.semantic_tokens_cache.write().await.clear();
    }

    async fn register_capability_values(&self, registrations: Vec<DynamicCapabilityRegistration>) {
        if registrations.is_empty() {
            return;
        }
        let resets_diagnostic_results = registrations
            .iter()
            .any(|registration| registration.method == "workspace/diagnostic");
        let mut current = self.dynamic_capabilities.write().await;
        for registration in registrations {
            current.insert(registration.id.clone(), registration);
        }
        drop(current);
        if resets_diagnostic_results {
            self.diagnostic_provider_generation
                .fetch_add(1, Ordering::SeqCst);
            self.diagnostic_result_ids.write().await.clear();
        }
        self.refresh_capabilities().await;
    }

    async fn unregister_capability_ids(&self, ids: Vec<String>) {
        if ids.is_empty() {
            return;
        }
        let mut current = self.dynamic_capabilities.write().await;
        let mut resets_diagnostic_results = false;
        for id in ids {
            if current
                .remove(&id)
                .is_some_and(|registration| registration.method == "workspace/diagnostic")
            {
                resets_diagnostic_results = true;
            }
        }
        drop(current);
        if resets_diagnostic_results {
            self.diagnostic_provider_generation
                .fetch_add(1, Ordering::SeqCst);
            self.diagnostic_result_ids.write().await.clear();
        }
        self.refresh_capabilities().await;
    }

    async fn workspace_file_operation_params(
        &self,
        method: &str,
        operation: &LspWorkspaceFileOperation,
    ) -> Result<Option<Value>, String> {
        let server_capabilities = self.server_capabilities.read().await.clone();
        let registrations = self
            .dynamic_capabilities
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let Some(filters) =
            file_operation_filters_from(&server_capabilities, &registrations, method)
        else {
            return Ok(None);
        };
        workspace_file_operation_params(&self.root_uri, operation, &filters)
    }

    async fn watched_file_params(
        &self,
        changes: &[LspWatchedFileChange],
    ) -> Result<Option<Value>, String> {
        let registrations = self
            .dynamic_capabilities
            .read()
            .await
            .values()
            .filter(|registration| registration.method == "workspace/didChangeWatchedFiles")
            .cloned()
            .collect::<Vec<_>>();
        if registrations.is_empty() {
            return Ok(None);
        }

        let mut events = Vec::new();
        let mut seen = HashSet::new();
        for change in changes {
            let Some(watch_kind) = watch_kind_for_change(change.change_type) else {
                return Err(format!(
                    "workspace/didChangeWatchedFiles has invalid file change type {}",
                    change.change_type
                ));
            };
            let uri = file_operation_uri(&change.path)?;
            if !registrations.iter().any(|registration| {
                watched_file_registration_matches(registration, &self.root_uri, &uri, watch_kind)
            }) {
                continue;
            }
            if seen.insert((uri.clone(), change.change_type)) {
                events.push(json!({ "uri": uri, "type": change.change_type }));
            }
        }
        Ok((!events.is_empty()).then(|| json!({ "changes": events })))
    }

    /// Pull project diagnostics when the server implements LSP 3.17's
    /// `workspace/diagnostic`. Push diagnostics remain authoritative for
    /// servers without this provider, and remain as a fallback if a pull fails.
    async fn pull_workspace_diagnostics(&self) -> Result<bool, String> {
        let provider = {
            let server_capabilities = self.server_capabilities.read().await.clone();
            let registrations = self
                .dynamic_capabilities
                .read()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            workspace_diagnostic_provider_options(&server_capabilities, &registrations)
        };
        let Some(provider) = provider else {
            return Ok(false);
        };

        // The Problems panel polls this command. If the prior pull is still in
        // flight, serve its cached data instead of queuing another project-wide
        // request behind it.
        let Ok(_guard) = self.diagnostic_pull_lock.try_lock() else {
            return Ok(false);
        };
        let provider_generation = self.diagnostic_provider_generation.load(Ordering::SeqCst);
        let mut previous_result_ids = self
            .diagnostic_result_ids
            .read()
            .await
            .iter()
            .map(|(uri, value)| json!({ "uri": uri, "value": value }))
            .collect::<Vec<_>>();
        previous_result_ids.sort_by(|left, right| {
            left.get("uri")
                .and_then(Value::as_str)
                .cmp(&right.get("uri").and_then(Value::as_str))
        });
        let mut params = json!({ "previousResultIds": previous_result_ids });
        if let Some(identifier) = provider.get("identifier").and_then(Value::as_str) {
            params["identifier"] = json!(identifier);
        }
        let partial_token = format!(
            "workspace-diagnostic:{}",
            self.next_id.fetch_add(1, Ordering::SeqCst)
        );
        let partial_token_key = progress_token_key(&json!(partial_token));
        self.diagnostic_partial_results
            .lock()
            .await
            .insert(partial_token_key.clone(), Vec::new());
        params["partialResultToken"] = json!(partial_token);
        let response = self
            .request_with_timeout(
                "workspace/diagnostic",
                params,
                WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS,
            )
            .await;
        let partial_items = self
            .diagnostic_partial_results
            .lock()
            .await
            .remove(&partial_token_key)
            .unwrap_or_default();
        let response = merge_workspace_diagnostic_partial_results(response?, partial_items)?;
        if self.diagnostic_provider_generation.load(Ordering::SeqCst) != provider_generation {
            return Ok(false);
        }
        let mut diagnostics = self.diagnostics.write().await;
        let mut result_ids = self.diagnostic_result_ids.write().await;
        apply_workspace_diagnostic_report(&response, &mut diagnostics, &mut result_ids)?;
        Ok(true)
    }

    async fn apply_server_workspace_edit(&self, params: Option<&Value>) -> Value {
        let Some(edit_value) = params.and_then(|value| value.get("edit")) else {
            return json!({
                "applied": false,
                "failureReason": "workspace/applyEdit request did not include an edit"
            });
        };
        let label = params
            .and_then(|value| value.get("label"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let response = self
            .client_bridge
            .apply_workspace_edit(
                &self.key.workspace_id,
                label,
                parse_workspace_edit(edit_value),
            )
            .await;
        serde_json::to_value(response).unwrap_or_else(|error| {
            json!({
                "applied": false,
                "failureReason": format!("Cannot serialize WorkspaceEdit result: {error}")
            })
        })
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.write_message(&payload).await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT_SECS)
            .await
    }

    async fn request_with_cancellation(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, String> {
        if cancellation.is_cancelled() {
            return Err(format!("language server request cancelled: {method}"));
        }
        self.request_with_timeout_and_cancellation(
            method,
            params,
            REQUEST_TIMEOUT_SECS,
            Some(cancellation),
        )
        .await
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        self.request_with_timeout_and_cancellation(method, params, timeout_secs, None)
            .await
    }

    async fn request_with_timeout_and_cancellation(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        let document_uri = request_document_uri(&params).map(ToString::to_string);
        self.pending.lock().await.insert(
            id,
            PendingResponse {
                sender,
                document_uri,
            },
        );
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = self.write_message(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let response = tokio::time::timeout(Duration::from_secs(timeout_secs), receiver);
        tokio::pin!(response);
        let outcome = if let Some(cancellation) = cancellation {
            tokio::select! {
                biased;
                result = &mut response => result,
                _ = cancellation.cancelled() => {
                    if self.pending.lock().await.remove(&id).is_some() {
                        let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
                    }
                    return Err(format!("language server request cancelled: {method}"));
                }
            }
        } else {
            response.await
        };
        match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("language server closed request {method}")),
            Err(_) => {
                if self.pending.lock().await.remove(&id).is_some() {
                    let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
                }
                Err(format!("language server request timed out: {method}"))
            }
        }
    }

    async fn cancel_document_requests(&self, uri: &str, reason: &str) {
        let cancelled = {
            let mut pending = self.pending.lock().await;
            take_pending_for_document(&mut *pending, uri)
        };
        for (id, response) in cancelled {
            let _ = response.sender.send(Err(reason.to_string()));
            let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
        }
    }

    async fn write_message(&self, payload: &Value) -> Result<(), String> {
        let body =
            serde_json::to_vec(payload).map_err(|e| format!("serialize LSP message: {e}"))?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|e| format!("write LSP header: {e}"))?;
        stdin
            .write_all(&body)
            .await
            .map_err(|e| format!("write LSP body: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush LSP message: {e}"))
    }

    async fn send_server_result(&self, response_id: Value, result: Value) {
        let _ = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": response_id,
                "result": result,
            }))
            .await;
    }

    async fn send_server_error(&self, response_id: Value, code: i64, message: impl Into<String>) {
        let _ = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": response_id,
                "error": {
                    "code": code,
                    "message": message.into()
                }
            }))
            .await;
    }

    async fn configuration_response(&self, params: Option<&Value>) -> Result<Value, String> {
        let items = params
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .ok_or_else(|| "workspace/configuration requires an items array".to_string())?;
        let configuration = self.client_configuration.read().await.clone();
        Ok(Value::Array(
            items
                .iter()
                .map(|item| {
                    let section = item.get("section").and_then(Value::as_str);
                    configuration_section_value(&configuration, section)
                })
                .collect(),
        ))
    }

    async fn register_work_done_progress(&self, params: Option<&Value>) -> Result<Value, String> {
        let token = params
            .and_then(|value| value.get("token"))
            .filter(|token| is_progress_token(token))
            .cloned()
            .ok_or_else(|| {
                "window/workDoneProgress/create requires a string or integer token".to_string()
            })?;
        let key = progress_token_key(&token);
        let mut progress = self.work_done_progress.write().await;
        if progress.contains_key(&key) {
            return Err(format!(
                "work-done progress token '{key}' is already registered"
            ));
        }
        progress.insert(
            key,
            WorkDoneProgressState {
                token,
                cancellable: false,
                title: None,
            },
        );
        Ok(Value::Null)
    }

    async fn handle_progress_notification(&self, params: Option<&Value>) {
        let Some(params) = params else {
            return;
        };
        let Some(token) = params
            .get("token")
            .filter(|token| is_progress_token(token))
            .cloned()
        else {
            return;
        };
        let Some(value) = params.get("value") else {
            return;
        };
        let key = progress_token_key(&token);
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            let mut partial_results = self.diagnostic_partial_results.lock().await;
            if let Some(collected) = partial_results.get_mut(&key) {
                collected.extend(items.iter().cloned());
                return;
            }
        }
        let Some(kind) = value.get("kind").and_then(Value::as_str) else {
            return;
        };
        if !matches!(kind, "begin" | "report" | "end") {
            return;
        }
        let mut progress = self.work_done_progress.write().await;
        let (title, message, percentage, cancellable) = match kind {
            "begin" => {
                let title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let cancellable = value
                    .get("cancellable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                progress.insert(
                    key.clone(),
                    WorkDoneProgressState {
                        token: token.clone(),
                        cancellable,
                        title: title.clone(),
                    },
                );
                (
                    title,
                    progress_message(value),
                    progress_percentage(value),
                    cancellable,
                )
            }
            "report" => {
                let state = progress
                    .entry(key.clone())
                    .or_insert_with(|| WorkDoneProgressState {
                        token: token.clone(),
                        cancellable: false,
                        title: None,
                    });
                if let Some(cancellable_value) = value.get("cancellable").and_then(Value::as_bool) {
                    state.cancellable = cancellable_value;
                }
                let title = state.title.clone();
                (
                    title,
                    progress_message(value),
                    progress_percentage(value),
                    state.cancellable,
                )
            }
            "end" => {
                let state = progress.remove(&key);
                (
                    state.as_ref().and_then(|state| state.title.clone()),
                    progress_message(value),
                    progress_percentage(value),
                    state
                        .as_ref()
                        .map(|state| state.cancellable)
                        .unwrap_or(false),
                )
            }
            _ => return,
        };
        drop(progress);
        self.client_bridge
            .emit_work_done_progress(LspWorkDoneProgressEvent {
                workspace_id: self.key.workspace_id.clone(),
                preset_id: self.key.preset_id.clone(),
                server_label: self.preset.display_name.clone(),
                root_uri: self.root_uri.clone(),
                token,
                kind: kind.to_string(),
                title,
                message,
                percentage,
                cancellable,
            });
    }

    async fn cancel_work_done_progress(&self, token: &Value) -> Result<bool, String> {
        let key = progress_token_key(token);
        let mut progress = self.work_done_progress.write().await;
        let Some(state) = progress.get_mut(&key) else {
            return Ok(false);
        };
        if !state.cancellable {
            return Ok(false);
        }
        state.cancellable = false;
        let token = state.token.clone();
        drop(progress);
        self.notify("window/workDoneProgress/cancel", json!({ "token": token }))
            .await?;
        Ok(true)
    }

    async fn handle_message(self: &Arc<Self>, message: Value) {
        if let Some(response_id) = message.get("id").cloned() {
            // Response to one of our requests.
            if message.get("method").is_none() {
                let pending_id = response_id
                    .as_u64()
                    .or_else(|| response_id.as_str().and_then(|id| id.parse::<u64>().ok()));
                let pending = if let Some(id) = pending_id {
                    self.pending.lock().await.remove(&id)
                } else {
                    None
                };
                if let Some(pending) = pending {
                    let response = if let Some(error) = message.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .unwrap_or_else(|| error.to_string()))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = pending.sender.send(response);
                }
                return;
            }

            let method = message.get("method").and_then(Value::as_str).unwrap_or("");
            let params = message.get("params").cloned();
            match method {
                "workspace/applyEdit" => {
                    let session = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = session.apply_server_workspace_edit(params.as_ref()).await;
                        session.send_server_result(response_id, result).await;
                    });
                }
                "window/showMessageRequest" => {
                    let Some(request) = parse_show_message_request(params.as_ref()) else {
                        self.send_server_error(
                            response_id,
                            JSON_RPC_INVALID_PARAMS,
                            "window/showMessageRequest has invalid params",
                        )
                        .await;
                        return;
                    };
                    let Some(server_id) = json_rpc_id_key(&response_id) else {
                        self.send_server_error(
                            response_id,
                            -32600,
                            "Server request id must be a string or number",
                        )
                        .await;
                        return;
                    };
                    let (frontend_id, receiver) =
                        match self.client_bridge.start_show_message_request(
                            &self.key.workspace_id,
                            &self.preset.display_name,
                            request.message_type,
                            request.message,
                            request.actions,
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                self.send_server_error(response_id, JSON_RPC_INTERNAL_ERROR, error)
                                    .await;
                                return;
                            }
                        };
                    let duplicate = self
                        .incoming_show_message_requests
                        .lock()
                        .await
                        .insert(server_id.clone(), frontend_id.clone());
                    if duplicate.is_some() {
                        self.client_bridge
                            .cancel_show_message(&frontend_id, "Duplicate server request id");
                        self.send_server_error(
                            response_id,
                            -32600,
                            "A server request with this id is already pending",
                        )
                        .await;
                        return;
                    }
                    let session = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = session
                            .client_bridge
                            .wait_for_show_message(&frontend_id, receiver)
                            .await;
                        let owns_request = session
                            .incoming_show_message_requests
                            .lock()
                            .await
                            .remove(&server_id)
                            .is_some_and(|id| id == frontend_id);
                        if !owns_request {
                            return;
                        }
                        match result {
                            Ok(value) => {
                                session
                                    .send_server_result(response_id, value.unwrap_or(Value::Null))
                                    .await
                            }
                            Err(error) => {
                                session
                                    .send_server_error(response_id, LSP_REQUEST_CANCELLED, error)
                                    .await
                            }
                        }
                    });
                }
                "client/registerCapability" => {
                    let result =
                        match parse_dynamic_capability_registrations_checked(params.as_ref()) {
                            Ok(registrations) => {
                                self.register_capability_values(registrations).await;
                                Ok(Value::Null)
                            }
                            Err(error) => Err(error),
                        };
                    match result {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "client/unregisterCapability" => {
                    match parse_dynamic_capability_unregistrations_checked(params.as_ref()) {
                        Ok(ids) => {
                            self.unregister_capability_ids(ids).await;
                            self.send_server_result(response_id, Value::Null).await;
                        }
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await;
                        }
                    }
                }
                "workspace/configuration" => {
                    match self.configuration_response(params.as_ref()).await {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "workspace/workspaceFolders" => {
                    self.send_server_result(
                        response_id,
                        json!([{ "uri": self.root_uri, "name": self.root_name }]),
                    )
                    .await;
                }
                "window/workDoneProgress/create" => {
                    match self.register_work_done_progress(params.as_ref()).await {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "workspace/diagnostic/refresh" => {
                    self.client_bridge
                        .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                            workspace_id: self.key.workspace_id.clone(),
                            preset_id: self.key.preset_id.clone(),
                            root_uri: self.root_uri.clone(),
                        });
                    self.send_server_result(response_id, Value::Null).await;
                }
                "workspace/semanticTokens/refresh"
                | "workspace/inlayHint/refresh"
                | "workspace/codeLens/refresh"
                | "workspace/foldingRange/refresh"
                | "workspace/inlineValue/refresh" => {
                    self.send_server_result(response_id, Value::Null).await;
                }
                _ => {
                    self.send_server_error(
                        response_id,
                        JSON_RPC_METHOD_NOT_FOUND,
                        format!("Unsupported language server request: {method}"),
                    )
                    .await;
                }
            }
            return;
        }

        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        let params = message.get("params");
        if method == "$/cancelRequest" {
            let Some(cancel_id) = params.and_then(|value| value.get("id")).cloned() else {
                return;
            };
            let Some(server_id) = json_rpc_id_key(&cancel_id) else {
                return;
            };
            let frontend_id = self
                .incoming_show_message_requests
                .lock()
                .await
                .remove(&server_id);
            if let Some(frontend_id) = frontend_id {
                self.client_bridge
                    .cancel_show_message(&frontend_id, "Cancelled by the language server");
                self.send_server_error(cancel_id, LSP_REQUEST_CANCELLED, "Request cancelled")
                    .await;
            }
            return;
        }
        if method == "$/progress" {
            self.handle_progress_notification(params).await;
            return;
        }
        if method == "window/showMessage" {
            if let Some(notification) = parse_show_message_notification(params) {
                self.client_bridge.emit_show_message(LspShowMessageEvent {
                    workspace_id: self.key.workspace_id.clone(),
                    server_label: self.preset.display_name.clone(),
                    message_type: notification.message_type,
                    message: notification.message,
                });
            }
            return;
        }
        if method == "textDocument/publishDiagnostics" {
            let Some(params) = params else {
                return;
            };
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return;
            };
            let diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(parse_diagnostic).collect())
                .unwrap_or_default();
            self.diagnostics
                .write()
                .await
                .insert(uri.to_string(), diagnostics);
        }
    }

    async fn stderr_snippet(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().await;
        let trimmed = tail.trim();
        if trimmed.is_empty() {
            None
        } else {
            // Keep the error toast readable; full log is still in debug logs.
            let snippet: String = trimmed
                .chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            Some(snippet)
        }
    }

    async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self
            .request_with_timeout("shutdown", Value::Null, SHUTDOWN_TIMEOUT_SECS)
            .await;
        let _ = self.notify("exit", Value::Null).await;
        let _ = self.stdin.lock().await.shutdown().await;

        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(EXIT_TIMEOUT_SECS), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.fail_pending("language server stopped").await;
    }

    async fn abort(&self, error: &str) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let _ = self.stdin.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        drop(child);
        self.fail_pending(error).await;
    }

    async fn fail_pending(&self, error: &str) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for response in pending.into_values() {
            let _ = response.sender.send(Err(error.to_string()));
        }
        let incoming = std::mem::take(&mut *self.incoming_show_message_requests.lock().await);
        for frontend_id in incoming.into_values() {
            self.client_bridge.cancel_show_message(&frontend_id, error);
        }
    }
}

/// Packaged Windows builds use the GUI subsystem and have no parent console.
/// Every language-server command, including custom commands, is background
/// infrastructure and must not allocate a transient console window.
fn no_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

fn initialize_timeout_secs(command: &LspServerCommandPreset) -> u64 {
    let id = command.id.to_ascii_lowercase();
    let prog = command.command.to_ascii_lowercase();
    if id == "jdtls" || prog.contains("jdtls") {
        JDTLS_INITIALIZE_TIMEOUT_SECS
    } else {
        INITIALIZE_TIMEOUT_SECS
    }
}

fn workspace_client_capabilities() -> Value {
    json!({
        "applyEdit": true,
        "workspaceEdit": {
            "documentChanges": true,
            "resourceOperations": ["create", "rename", "delete"],
            "failureHandling": "abort",
            "changeAnnotationSupport": {
                "groupsOnLabel": false
            }
        },
        "workspaceFolders": true,
        "configuration": true,
        "diagnostics": {
            "refreshSupport": true,
            "relatedDocumentSupport": true
        },
        "fileOperations": {
            "dynamicRegistration": true,
            "didCreate": true,
            "willCreate": true,
            "didRename": true,
            "willRename": true,
            "didDelete": true,
            "willDelete": true
        },
        "didChangeWatchedFiles": {
            "dynamicRegistration": true
        },
        "symbol": {
            "dynamicRegistration": true,
            "resolveSupport": {
                "properties": ["location.range"]
            }
        }
    })
}

/// Build a process command for an LSP server binary.
///
/// On Windows:
/// - Prefer launching Eclipse JDT LS via `java -jar` so stdio is not mediated by
///   `cmd.exe` / `jdtls.cmd` (which often leaves the session stuck mid-start).
/// - Other `.cmd`/`.bat` shims (npm globals) go through `cmd.exe /D /S /C` with a
///   single properly-quoted command line after resolving the absolute path.
fn build_lsp_server_command(
    program: &str,
    args: &[String],
    workspace_root: &Path,
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<Command, String> {
    let program = program.trim();
    #[cfg(windows)]
    {
        let resolved = resolve_server_program(program);
        if is_jdtls_program(program, &resolved) {
            // Always expand jdtls ourselves. Falling back to jdtls.cmd hides
            // actionable errors (wrong JDK, missing config) as plain
            // "stdout closed" and reintroduces the cmd.exe stdio problems.
            return build_jdtls_java_command(
                &resolved,
                args,
                workspace_root,
                tooling_java_home,
                tooling_java_error,
            );
        }
        let is_batch = resolved
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
        if is_batch {
            let mut cmd = Command::new("cmd.exe");
            // /D skips AutoRun; /S keeps the quoted command line intact so paths
            // with spaces (and trailing args) reach the batch file correctly.
            cmd.arg("/D")
                .arg("/S")
                .arg("/C")
                .arg(windows_cmd_line(&resolved, args));
            return Ok(cmd);
        }
        let mut cmd = Command::new(&resolved);
        cmd.args(args);
        return Ok(cmd);
    }
    #[cfg(not(windows))]
    {
        let _ = (tooling_java_home, tooling_java_error);
        let mut cmd = Command::new(program);
        // For the jdtls wrapper, pin `-data` to our managed per-workspace index dir
        // (unless the caller already passed one) so the index location is ours to
        // control and prune — matching the Windows launch path. The wrapper forwards
        // unknown args straight to the Equinox launcher, and `-data` is exactly what
        // upstream jdtls.py appends.
        let resolved = which::which(program).unwrap_or_else(|_| PathBuf::from(program));
        if is_jdtls_program(program, &resolved)
            && !args.iter().any(|arg| arg == "-data" || arg == "--data")
        {
            let data_dir = jdtls_data_dir(workspace_root);
            ensure_jdtls_data_dir(&data_dir, workspace_root)?;
            cmd.args(args);
            cmd.arg("-data");
            cmd.arg(&data_dir);
            log::info!(
                "lsp: launching jdtls wrapper {program} with -data {}",
                data_dir.display()
            );
        } else {
            let _ = workspace_root;
            cmd.args(args);
        }
        Ok(cmd)
    }
}

fn is_jdtls_program(program: &str, resolved: &Path) -> bool {
    let name = program.to_ascii_lowercase();
    if name.contains("jdtls") {
        return true;
    }
    resolved
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("jdtls"))
}

/// Quote a Windows cmdline for `cmd.exe /S /C` so the batch path and args are
/// preserved: `"C:\path\tool.cmd" --stdio`.
#[cfg(windows)]
fn windows_cmd_line(program: &Path, args: &[String]) -> String {
    let mut line = format!("\"{}\"", program.display());
    for arg in args {
        line.push(' ');
        line.push_str(&windows_quote_arg(arg));
    }
    line
}

#[cfg(windows)]
fn windows_quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    if !arg.chars().any(|c| c.is_whitespace() || c == '"') {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    for ch in arg.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

#[cfg(windows)]
fn resolve_server_program(program: &str) -> PathBuf {
    let path = Path::new(program);
    if path.is_absolute() || program.contains('/') || program.contains('\\') {
        return path.to_path_buf();
    }
    which::which(program).unwrap_or_else(|_| PathBuf::from(program))
}

/// Expand `jdtls` / `jdtls.cmd` into a direct `java -jar …` command matching the
/// upstream `jdtls.py` launcher so stdio attaches to the JVM.
///
/// Critical details vs our old minimal command line:
/// - Current JDT LS needs **Java 21+** (JDK 17 exits immediately → "stdout closed").
/// - Use OSGi *shared* read-only `config_win` + writable `-data` (not
///   `-configuration config_win`, which often fails under a GUI process).
/// - Pass `--add-modules` / `--add-opens` required by modern Equinox on JPMS.
#[cfg(windows)]
fn build_jdtls_java_command(
    jdtls_path: &Path,
    extra_args: &[String],
    workspace_root: &Path,
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<Command, String> {
    let jdtls_home = resolve_jdtls_home(jdtls_path).ok_or_else(|| {
        format!(
            "cannot locate jdtls install (plugins/) from {}; set JDTLS_HOME or install under %LOCALAPPDATA%\\jdtls",
            jdtls_path.display()
        )
    })?;
    let launcher = find_equinox_launcher(&jdtls_home).ok_or_else(|| {
        format!(
            "equinox launcher jar missing under {}\\plugins",
            jdtls_home.display()
        )
    })?;
    let shared_config = jdtls_home.join("config_win");
    if !shared_config.is_dir() {
        return Err(format!(
            "jdtls config_win missing under {} (is the Windows archive fully extracted?)",
            jdtls_home.display()
        ));
    }
    let (java, java_major) =
        resolve_java_for_jdtls_with_sdk(tooling_java_home, tooling_java_error)?;
    if java_major < JDTLS_MIN_JAVA_MAJOR {
        return Err(format!(
            "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java {java_major} at {}. Install JDK {JDTLS_MIN_JAVA_MAJOR}+, configure it in Settings → Language Servers, or set JAVA_HOME",
            java.display()
        ));
    }
    let data_dir = jdtls_data_dir(workspace_root);
    ensure_jdtls_data_dir(&data_dir, workspace_root)?;

    // Mirror eclipse.jdt.ls product scripts/jdtls.py (shared config + JPMS opens).
    let mut cmd = Command::new(&java);
    if java_major >= 24 {
        cmd.arg("-Djdk.xml.maxGeneralEntitySizeLimit=0");
        cmd.arg("-Djdk.xml.totalEntitySizeLimit=0");
    }
    cmd.arg("-Declipse.application=org.eclipse.jdt.ls.core.id1");
    cmd.arg("-Dosgi.bundles.defaultStartLevel=4");
    cmd.arg("-Declipse.product=org.eclipse.jdt.ls.core.product");
    cmd.arg("-Dosgi.checkConfiguration=true");
    cmd.arg(format!(
        "-Dosgi.sharedConfiguration.area={}",
        shared_config.display()
    ));
    cmd.arg("-Dosgi.sharedConfiguration.area.readOnly=true");
    cmd.arg("-Dosgi.configuration.cascaded=true");
    cmd.arg("-Dlog.level=ERROR");
    // User/default vmargs (heap, GC, extra -D…, etc.) between product props and JPMS.
    for arg in jdtls_vmargs() {
        cmd.arg(arg);
    }
    cmd.arg("--add-modules=ALL-SYSTEM");
    cmd.arg("--add-opens");
    cmd.arg("java.base/java.util=ALL-UNNAMED");
    cmd.arg("--add-opens");
    cmd.arg("java.base/java.lang=ALL-UNNAMED");
    cmd.arg("-jar");
    cmd.arg(launcher);
    cmd.arg("-data");
    cmd.arg(&data_dir);
    cmd.args(extra_args);
    if let Some(home) = java_home_from_binary(&java) {
        cmd.env("JAVA_HOME", home);
    }
    log::info!(
        "lsp: launching jdtls via {} (Java {java_major}), home={}, data={}",
        java.display(),
        jdtls_home.display(),
        data_dir.display()
    );
    Ok(cmd)
}

#[cfg(windows)]
fn resolve_jdtls_home(jdtls_path: &Path) -> Option<PathBuf> {
    if let Ok(home) = std::env::var("JDTLS_HOME") {
        let home = PathBuf::from(home);
        if home.join("plugins").is_dir() {
            return Some(home);
        }
    }
    // Install guide layout: %LOCALAPPDATA%\jdtls-bin\jdtls.cmd + %LOCALAPPDATA%\jdtls
    if let Some(bin_dir) = jdtls_path.parent() {
        if let Some(local) = bin_dir.parent() {
            let candidate = local.join("jdtls");
            if candidate.join("plugins").is_dir() {
                return Some(candidate);
            }
        }
        // jdtls.cmd living next to an extracted distribution
        if bin_dir.join("plugins").is_dir() {
            return Some(bin_dir.to_path_buf());
        }
        if let Some(parent) = bin_dir.parent() {
            if parent.join("plugins").is_dir() {
                return Some(parent.to_path_buf());
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("jdtls");
        if candidate.join("plugins").is_dir() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn find_equinox_launcher(jdtls_home: &Path) -> Option<PathBuf> {
    let plugins = jdtls_home.join("plugins");
    // mason-registry packaging uses an unversioned jar name.
    let plain = plugins.join("org.eclipse.equinox.launcher.jar");
    if plain.is_file() {
        return Some(plain);
    }
    let mut matches: Vec<PathBuf> = std::fs::read_dir(&plugins)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar")
                })
        })
        .collect();
    matches.sort();
    matches.pop()
}

fn configured_java_vmargs_lock() -> &'static StdMutex<Option<String>> {
    CONFIGURED_JAVA_VMARGS.get_or_init(|| StdMutex::new(None))
}

fn set_configured_java_vmargs(vmargs: Option<&str>) {
    let normalized = vmargs
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Ok(mut guard) = configured_java_vmargs_lock().lock() {
        *guard = normalized;
    }
}

fn get_configured_java_vmargs() -> Option<String> {
    configured_java_vmargs_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Effective jdtls JVM args string (Settings override or default 1G heap).
fn jdtls_vmargs_string() -> String {
    get_configured_java_vmargs().unwrap_or_else(|| DEFAULT_JDTLS_VMARGS.to_string())
}

/// Split JVM arg strings with simple shell-style quoting (spaces, "…", '…').
fn split_jvm_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn jdtls_vmargs() -> Vec<String> {
    let mut args = split_jvm_args(&jdtls_vmargs_string());
    if let Some(agent) = lombok_javaagent_arg() {
        args.push(agent);
    }
    args
}

/// Apply Settings JVM args as JAVA_OPTS for the jdtls wrapper (Linux/macOS).
/// Settings win over a parent-shell JAVA_OPTS so heap/GC overrides are not ignored.
/// Includes the Lombok `-javaagent` when configured so wrapper launches match the
/// direct-launch path.
fn apply_jdtls_vmargs_to_command(cmd: &mut Command) {
    cmd.env("JAVA_OPTS", jdtls_vmargs().join(" "));
}

/// Lombok `-javaagent:<jar>` when Lombok is enabled with a configured jar path.
/// Short-term M6-A path (full bundle loading arrives with the jdtls bundle work).
fn lombok_javaagent_arg() -> Option<String> {
    let settings = get_configured_java_settings();
    let jar = settings.lombok_jar_path.as_deref().map(str::trim)?;
    if !settings.lombok_enabled || jar.is_empty() {
        return None;
    }
    Some(format!("-javaagent:{jar}"))
}

/// User-configured `java.*` settings mirrored from Language Servers settings. Serde
/// fills any omitted field from [`Self::default`] so partial payloads stay valid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JavaLanguageSettings {
    /// Background compile the whole project (prerequisite for full-project diagnostics).
    pub autobuild_enabled: bool,
    /// Lombok `-javaagent` support toggle.
    pub lombok_enabled: bool,
    /// Absolute path to a `lombok.jar` used for the `-javaagent`.
    pub lombok_jar_path: Option<String>,
    /// Run `source.organizeImports` on save.
    pub save_actions_organize_imports: bool,
    /// Eclipse/Google formatter profile URL or file path (empty → jdtls default).
    pub format_settings_url: Option<String>,
    /// Named profile inside the formatter settings file.
    pub format_settings_profile: Option<String>,
    /// Guess method arguments when completing calls.
    pub guess_method_arguments: bool,
    /// Import groups in organize-imports order (e.g. `["java","javax","com","org"]`).
    /// Empty → jdtls default order.
    pub completion_import_order: Vec<String>,
    /// Static members offered eagerly in completion (e.g. JUnit/Mockito).
    pub favorite_static_members: Vec<String>,
    /// `import` count before collapsing to `import a.*`.
    pub organize_imports_star_threshold: u32,
    /// static `import` count before collapsing to `import static a.*`.
    pub organize_imports_static_star_threshold: u32,
    /// Enable Maven importer.
    pub maven_import_enabled: bool,
    /// Enable Gradle importer.
    pub gradle_import_enabled: bool,
}

impl Default for JavaLanguageSettings {
    fn default() -> Self {
        Self {
            autobuild_enabled: true,
            lombok_enabled: false,
            lombok_jar_path: None,
            save_actions_organize_imports: false,
            format_settings_url: None,
            format_settings_profile: None,
            guess_method_arguments: true,
            completion_import_order: Vec::new(),
            favorite_static_members: vec![
                "org.junit.Assert.*".into(),
                "org.junit.Assume.*".into(),
                "org.junit.jupiter.api.Assertions.*".into(),
                "org.junit.jupiter.api.Assumptions.*".into(),
                "org.mockito.Mockito.*".into(),
                "org.mockito.ArgumentMatchers.*".into(),
            ],
            organize_imports_star_threshold: 99,
            organize_imports_static_star_threshold: 99,
            maven_import_enabled: true,
            gradle_import_enabled: true,
        }
    }
}

/// Trim a string option to a JSON string value, or `Null` when empty/absent.
fn non_empty_or_null(value: Option<&str>) -> Value {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Value::String(value.to_string()),
        None => Value::Null,
    }
}
impl JavaLanguageSettings {
    /// Build the `java` object for `settings.java` (initialize + didChangeConfiguration).
    /// `runtimes` is threaded in separately because it is backend-owned per project.
    fn to_java_settings(&self, runtimes: &[JavaRuntimeConfiguration]) -> Value {
        // Only carry runtimes when we actually have them: a live
        // didChangeConfiguration push sends `&[]` and must NOT clobber the JDK
        // config jdtls already resolved at initialize with an empty array.
        let mut configuration = json!({ "updateBuildConfiguration": "interactive" });
        if !runtimes.is_empty() {
            configuration["runtimes"] = json!(runtimes);
        }
        json!({
            "autobuild": { "enabled": self.autobuild_enabled },
            "maxConcurrentBuilds": 1,
            "configuration": configuration,
            "completion": {
                "enabled": true,
                "guessMethodArguments": self.guess_method_arguments,
                "importOrder": self.completion_import_order,
                "favoriteStaticMembers": self.favorite_static_members
            },
            "format": {
                "enabled": true,
                "settings": {
                    "url": non_empty_or_null(self.format_settings_url.as_deref()),
                    "profile": non_empty_or_null(self.format_settings_profile.as_deref())
                },
                "onType": { "enabled": true }
            },
            "import": {
                "maven": { "enabled": self.maven_import_enabled },
                "gradle": {
                    "enabled": self.gradle_import_enabled,
                    "wrapper": { "enabled": true },
                    "offline": { "enabled": false }
                }
            },
            "sources": {
                "organizeImports": {
                    "starThreshold": self.organize_imports_star_threshold,
                    "staticStarThreshold": self.organize_imports_static_star_threshold
                }
            },
            "saveActions": { "organizeImports": self.save_actions_organize_imports },
            "codeGeneration": {
                "hashCodeEquals": { "useJava7Objects": true },
                "useBlocks": true,
                "generateComments": false,
                "toString": {
                    "template": "${object.className} [${member.name()}=${member.value}, ${otherMembers}]"
                }
            },
            "referencesCodeLens": { "enabled": false },
            "implementationsCodeLens": { "enabled": false },
            "signatureHelp": { "enabled": true },
            "inlayHints": { "parameterNames": { "enabled": "all" } },
            "errors": { "incompleteClasspath": { "severity": "warning" } }
        })
    }
}
fn configured_java_settings_lock() -> &'static StdMutex<Option<JavaLanguageSettings>> {
    CONFIGURED_JAVA_SETTINGS.get_or_init(|| StdMutex::new(None))
}

fn set_configured_java_settings(settings: Option<JavaLanguageSettings>) {
    if let Ok(mut guard) = configured_java_settings_lock().lock() {
        *guard = settings;
    }
}

/// Effective `java.*` settings (Settings override or defaults).
fn get_configured_java_settings() -> JavaLanguageSettings {
    configured_java_settings_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

fn configured_java_home_lock() -> &'static StdMutex<Option<PathBuf>> {
    CONFIGURED_JAVA_HOME.get_or_init(|| StdMutex::new(None))
}

/// Store the Settings-configured JDK path (or clear with `None`).
fn set_configured_java_home(java_home: Option<&str>) {
    let path = java_home
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Ok(mut guard) = configured_java_home_lock().lock() {
        *guard = path;
    }
}

fn get_configured_java_home() -> Option<PathBuf> {
    configured_java_home_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Expand a user/env path that may be a JDK home, `bin/`, or the `java` binary.
fn resolve_java_binary_from_user_path(path: &Path) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if !path.is_dir() {
        return None;
    }
    let direct = path.join(bin_name);
    if direct.is_file() {
        return Some(direct);
    }
    let in_bin = path.join("bin").join(bin_name);
    if in_bin.is_file() {
        return Some(in_bin);
    }
    // macOS `.jdk` bundles: Contents/Home/bin/java
    let mac = path
        .join("Contents")
        .join("Home")
        .join("bin")
        .join(bin_name);
    if mac.is_file() {
        return Some(mac);
    }
    None
}

fn java_home_from_binary(java: &Path) -> Option<PathBuf> {
    let parent = java.parent()?;
    if parent
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
    {
        return parent.parent().map(|p| p.to_path_buf());
    }
    Some(parent.to_path_buf())
}

fn push_java_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|c| c == &path) {
        candidates.push(path);
    }
}

/// Pick a Java executable for jdtls, preferring the highest major >= 21.
/// Order: configured Settings path → JAVA_HOME → PATH → common install layouts.
fn resolve_java_for_jdtls() -> Result<(PathBuf, u32), String> {
    resolve_java_for_jdtls_with_sdk(None, None)
}

/// Resolve the JVM that runs JDT LS. The legacy Language Servers override is
/// retained as the highest-precedence migration path; otherwise an explicit
/// workspace tooling-JDK binding wins over process JAVA_HOME/PATH discovery.
fn resolve_java_for_jdtls_with_sdk(
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<(PathBuf, u32), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let configured_java_home = get_configured_java_home();
    if let Some(configured) = configured_java_home.as_ref() {
        if let Some(bin) = resolve_java_binary_from_user_path(&configured) {
            push_java_candidate(&mut candidates, bin);
        } else {
            return Err(format!(
                "configured Java runtime path is invalid: {} (expected JDK home or java binary, JDK {JDTLS_MIN_JAVA_MAJOR}+)",
                configured.display()
            ));
        }
    } else {
        if let Some(error) = tooling_java_error {
            return Err(error.to_string());
        }
        if let Some(tooling) = tooling_java_home {
            if let Some(bin) = resolve_java_binary_from_user_path(tooling) {
                push_java_candidate(&mut candidates, bin);
            } else {
                return Err(format!(
                    "workspace tooling JDK path is invalid: {} (expected JDK home or java binary, JDK {JDTLS_MIN_JAVA_MAJOR}+)",
                    tooling.display()
                ));
            }
        }
    }

    if let Ok(home) = std::env::var("JAVA_HOME") {
        if let Some(bin) = resolve_java_binary_from_user_path(Path::new(&home)) {
            push_java_candidate(&mut candidates, bin);
        }
    }
    if let Ok(path) = which::which("java") {
        push_java_candidate(&mut candidates, path);
    }
    // GUI-launched apps sometimes inherit a PATH that lacks the JDK even when
    // an interactive shell sees it. Probe common install layouts.
    #[cfg(windows)]
    {
        for base in [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
        ]
        .into_iter()
        .flatten()
        {
            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Amazon Corretto",
                "Semeru",
            ] {
                let root = PathBuf::from(&base).join(vendor);
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("bin").join("java.exe");
                        if candidate.is_file() {
                            push_java_candidate(&mut candidates, candidate);
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        for dir in [
            "/usr/lib/jvm",
            "/Library/Java/JavaVirtualMachines",
            "/opt/homebrew/opt/openjdk/bin",
            "/usr/local/opt/openjdk/bin",
        ] {
            let root = Path::new(dir);
            if root.is_file() {
                push_java_candidate(&mut candidates, root.to_path_buf());
                continue;
            }
            if root.is_dir() && root.ends_with("bin") {
                let candidate = root.join("java");
                if candidate.is_file() {
                    push_java_candidate(&mut candidates, candidate);
                }
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    for rel in ["bin/java", "Contents/Home/bin/java"] {
                        let candidate = path.join(rel);
                        if candidate.is_file() {
                            push_java_candidate(&mut candidates, candidate);
                        }
                    }
                }
            }
        }
    }

    if candidates.is_empty() {
        return Err(format!(
            "java not found for jdtls; install JDK {JDTLS_MIN_JAVA_MAJOR}+ and set it in Settings → Language Servers, JAVA_HOME, or PATH"
        ));
    }

    // If the user configured a path, only evaluate that first candidate so a
    // wrong/old override cannot silently fall back to another JDK on PATH.
    let configured_only = configured_java_home.is_some() || tooling_java_home.is_some();
    let search: Vec<PathBuf> = if configured_only {
        candidates.into_iter().take(1).collect()
    } else {
        candidates
    };

    let mut best_ok: Option<(PathBuf, u32)> = None;
    let mut best_any: Option<(PathBuf, u32)> = None;
    let mut last_err = String::new();
    for path in search {
        match java_major_version(&path) {
            Ok(major) => {
                if major >= JDTLS_MIN_JAVA_MAJOR {
                    if best_ok.as_ref().map(|(_, m)| major > *m).unwrap_or(true) {
                        best_ok = Some((path.clone(), major));
                    }
                }
                if best_any.as_ref().map(|(_, m)| major > *m).unwrap_or(true) {
                    best_any = Some((path, major));
                }
            }
            Err(e) => last_err = e,
        }
    }

    if let Some(ok) = best_ok {
        return Ok(ok);
    }
    if let Some((path, major)) = best_any {
        return Err(format!(
            "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java {major} at {}. Install JDK {JDTLS_MIN_JAVA_MAJOR}+ and configure it in Settings → Language Servers (or JAVA_HOME)",
            path.display()
        ));
    }
    Err(if last_err.is_empty() {
        format!("could not determine Java version for jdtls; need JDK {JDTLS_MIN_JAVA_MAJOR}+")
    } else {
        last_err
    })
}

/// Probe the JVM used by jdtls for Settings / pre-start checks.
/// Returns `(runtime_status label, error if unusable)`.
fn jdtls_runtime_probe() -> (Option<String>, Option<String>) {
    match resolve_java_for_jdtls() {
        Ok((path, major)) => {
            let short = path.display().to_string();
            let configured = get_configured_java_home().is_some();
            (
                Some(format!(
                    "Java {major} · {short}{} (JDK {JDTLS_MIN_JAVA_MAJOR}+ required)",
                    if configured { " · configured" } else { "" }
                )),
                None,
            )
        }
        Err(error) => {
            // Prefer a compact status line for the Settings row.
            let status = if let Some(major) = error
                .split("found Java ")
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok())
            {
                Some(format!(
                    "Java {major} — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for current JDT LS"
                ))
            } else if error.contains("java not found") || error.contains("invalid") {
                Some(format!(
                    "Java not found — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for jdtls"
                ))
            } else {
                Some(format!(
                    "Java runtime issue (need JDK {JDTLS_MIN_JAVA_MAJOR}+)"
                ))
            };
            (status, Some(error))
        }
    }
}

fn command_is_jdtls(command: &LspServerCommandPreset) -> bool {
    command.id.eq_ignore_ascii_case("jdtls")
        || command.command.to_ascii_lowercase().contains("jdtls")
}

fn preset_uses_jdtls(preset: &LspServerPreset, command: Option<&LspServerCommandPreset>) -> bool {
    if preset.id == "java" {
        return true;
    }
    command.is_some_and(command_is_jdtls) || preset.commands.iter().any(command_is_jdtls)
}

/// Parse `java -version` output (`openjdk version "17.0.4"` / `"21.0.2"` / `"1.8.0_xxx"`).
fn java_major_version(java: &Path) -> Result<u32, String> {
    let mut cmd = std::process::Command::new(java);
    cmd.arg("-version");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run {} -version: {e}", java.display()))?;
    let text = {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        if !err.trim().is_empty() {
            err.into_owned()
        } else {
            out.into_owned()
        }
    };
    parse_java_major_from_version_output(&text).ok_or_else(|| {
        format!(
            "could not parse Java version from {} -version output: {}",
            java.display(),
            text.lines().next().unwrap_or("(empty)").trim()
        )
    })
}

fn parse_java_major_from_version_output(text: &str) -> Option<u32> {
    // version "21.0.2" | version "17.0.4" | version "1.8.0_392"
    for line in text.lines() {
        let Some(after) = line.split("version").nth(1) else {
            continue;
        };
        let Some(start) = after.find('"') else {
            continue;
        };
        let rest = &after[start + 1..];
        let end = rest.find('"').unwrap_or(rest.len());
        let ver = rest[..end].trim();
        let mut parts = ver.split(['.', '_', '-']);
        let first: u32 = parts.next()?.parse().ok()?;
        if first == 1 {
            return parts.next()?.parse().ok();
        }
        return Some(first);
    }
    None
}

/// Root that holds every per-workspace jdtls `-data` directory.
///
/// Windows keeps the historical `%LOCALAPPDATA%\jdtls-ws`; other platforms use the
/// user cache dir (`~/.cache/jdtls-ws` on Linux, `~/Library/Caches/jdtls-ws` on
/// macOS) so the location is ours to manage rather than left to the wrapper script.
fn jdtls_data_root() -> PathBuf {
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("jdtls-ws");
    }
    #[cfg(not(windows))]
    if let Some(cache) = dirs::cache_dir() {
        return cache.join("jdtls-ws");
    }
    std::env::temp_dir().join("jdtls-ws")
}

/// Per-workspace jdtls index/metadata directory. Keyed by the project scope path so
/// the same project reuses its index across restarts, while distinct projects stay
/// isolated (matching how IDEA keeps one index per project).
fn jdtls_data_dir(workspace_root: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    workspace_root.to_string_lossy().hash(&mut hasher);
    let digest = format!("{:x}", hasher.finish());
    jdtls_data_root().join(digest)
}

/// Best-effort prune of stale jdtls index directories.
///
/// Each `-data` dir carries a `.taomni-workspace` marker naming the project it
/// indexes; when that project path no longer exists on disk, the whole index is
/// removed so abandoned/renamed projects do not accumulate unbounded disk usage.
/// Runs on a blocking thread and never fails the caller.
fn prune_stale_jdtls_data_dirs() {
    let root = jdtls_data_root();
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let marker = dir.join(JDTLS_WORKSPACE_MARKER);
        let Ok(project) = std::fs::read_to_string(&marker) else {
            // No marker (older layout or partial dir): leave it alone to be safe.
            continue;
        };
        let project = project.trim();
        if project.is_empty() || Path::new(project).exists() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            log::warn!(
                "lsp: failed to prune stale jdtls data dir {} (project {project} gone): {error}",
                dir.display()
            );
        } else {
            log::info!(
                "lsp: pruned stale jdtls data dir {} (project {project} no longer exists)",
                dir.display()
            );
        }
    }
}

/// Create `data_dir` and stamp the `.taomni-workspace` marker with `workspace_root`
/// so [`prune_stale_jdtls_data_dirs`] can later tell which project it belongs to.
fn ensure_jdtls_data_dir(data_dir: &Path, workspace_root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("cannot create jdtls data dir {}: {e}", data_dir.display()))?;
    // Marker write is best-effort: a missing marker only disables pruning for this dir.
    let _ = std::fs::write(
        data_dir.join(JDTLS_WORKSPACE_MARKER),
        workspace_root.to_string_lossy().as_bytes(),
    );
    Ok(())
}

struct ParsedShowMessage {
    message_type: u32,
    message: String,
    actions: Vec<Value>,
}

fn parse_show_message_request(params: Option<&Value>) -> Option<ParsedShowMessage> {
    let params = params?;
    let message_type = params.get("type").and_then(Value::as_u64)?;
    if !(1..=4).contains(&message_type) {
        return None;
    }
    let message = params.get("message").and_then(Value::as_str)?.to_string();
    let actions = match params.get("actions") {
        None => Vec::new(),
        Some(Value::Array(actions)) => actions
            .iter()
            .filter(|action| action.get("title").and_then(Value::as_str).is_some())
            .cloned()
            .collect(),
        Some(_) => return None,
    };
    if params
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|items| items.len() != actions.len())
    {
        return None;
    }
    Some(ParsedShowMessage {
        message_type: message_type as u32,
        message,
        actions,
    })
}

fn parse_show_message_notification(params: Option<&Value>) -> Option<ParsedShowMessage> {
    let mut parsed = parse_show_message_request(params)?;
    parsed.actions.clear();
    Some(parsed)
}

fn is_progress_token(value: &Value) -> bool {
    value.is_string() || value.as_i64().is_some() || value.as_u64().is_some()
}

fn progress_token_key(value: &Value) -> String {
    match value {
        Value::String(value) => format!("s:{value}"),
        Value::Number(value) => format!("n:{value}"),
        _ => value.to_string(),
    }
}

fn progress_message(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn progress_percentage(value: &Value) -> Option<u32> {
    value
        .get("percentage")
        .and_then(Value::as_u64)
        .map(|percentage| percentage.min(100) as u32)
}

fn json_rpc_id_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }
}

fn configuration_section_value(configuration: &Value, section: Option<&str>) -> Value {
    let Some(section) = section.map(str::trim).filter(|section| !section.is_empty()) else {
        return configuration.clone();
    };
    let mut current = configuration;
    for part in section.split('.') {
        let Some(next) = current.get(part) else {
            return Value::Null;
        };
        current = next;
    }
    current.clone()
}

fn merge_json_value(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            match target.get_mut(key) {
                Some(existing) => merge_json_value(existing, value),
                None => {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        return;
    }
    *target = patch.clone();
}

async fn read_stdout(
    session: Arc<LspSession>,
    stdout: ChildStdout,
    sessions: LspSessionRegistry,
    last_errors: LspLastErrorRegistry,
    map_key: String,
) {
    let mut reader = BufReader::new(stdout);
    let reason = 'messages: loop {
        let mut content_length = None;
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) => {
                    let exit = {
                        let mut child = session.child.lock().await;
                        match child.try_wait() {
                            Ok(Some(status)) => format!(" (exit {status})"),
                            _ => String::new(),
                        }
                    };
                    break 'messages format!("language server stdout closed{exit}");
                }
                Ok(_) => {
                    if line == b"\r\n" || line == b"\n" {
                        break;
                    }
                    if let Ok(header) = std::str::from_utf8(&line) {
                        let trimmed = header.trim();
                        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                            content_length = value.trim().parse::<usize>().ok();
                        }
                    }
                }
                Err(e) => {
                    break 'messages format!("language server stdout read failed: {e}");
                }
            }
        }
        let Some(len) = content_length else {
            break "language server response missing Content-Length".to_string();
        };
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            break format!("language server response body read failed: {e}");
        }
        match serde_json::from_slice::<Value>(&body) {
            Ok(message) => session.handle_message(message).await,
            Err(e) => log::warn!("lsp: invalid JSON from {}: {e}", session.command.command),
        }
    };
    let expected_shutdown = session.shutting_down.load(Ordering::SeqCst);
    let reason = if let Some(stderr) = session.stderr_snippet().await {
        format!("{reason} ({stderr})")
    } else {
        reason
    };
    if expected_shutdown {
        session.fail_pending(&reason).await;
    } else {
        session.abort(&reason).await;
        last_errors
            .lock()
            .await
            .insert(map_key.clone(), reason.clone());
    }
    remove_exited_session(&sessions, &map_key, &session).await;
    if expected_shutdown {
        log::debug!("lsp:{}: {reason}", session.command.command);
    } else {
        log::warn!("lsp:{}: {reason}", session.command.command);
    }
}

async fn remove_exited_session(
    sessions: &LspSessionRegistry,
    map_key: &str,
    session: &Arc<LspSession>,
) {
    let mut sessions = sessions.lock().await;
    let is_current = matches!(
        sessions.get(map_key),
        Some(LspSessionEntry::Ready(current)) if Arc::ptr_eq(current, session)
    );
    if is_current {
        sessions.remove(map_key);
    }
}

async fn read_stderr(session: Arc<LspSession>, stderr: ChildStderr) {
    let command = session.command.command.clone();
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                log::debug!("lsp:{command}: {line}");
                let mut tail = session.stderr_tail.lock().await;
                if !tail.is_empty() {
                    tail.push('\n');
                }
                tail.push_str(&line);
                // Cap memory if a server spams stderr.
                const MAX: usize = 8_192;
                let len = tail.len();
                if len > MAX {
                    *tail = tail[len - MAX..].to_string();
                }
            }
            Ok(None) => return,
            Err(e) => {
                log::debug!("lsp:{command}: stderr read failed: {e}");
                return;
            }
        }
    }
}

#[tauri::command]
pub fn lsp_list_presets() -> Vec<LspServerPreset> {
    lsp_presets()
}

/// Persist the Settings-configured Java runtime for jdtls (JDK home or java binary).
/// Empty / null clears the override and falls back to JAVA_HOME / PATH discovery.
#[tauri::command]
pub fn lsp_set_java_home(java_home: Option<String>) -> Result<(), String> {
    set_configured_java_home(java_home.as_deref());
    Ok(())
}

/// Persist Settings-configured jdtls JVM args (e.g. `-Xmx2G -XX:+UseG1GC`).
/// Null/empty restores the default (`-Xms1024m -Xmx1024m`). Takes effect on the
/// next jdtls process start (workspace restart).
#[tauri::command]
pub fn lsp_set_java_vmargs(vmargs: Option<String>) -> Result<String, String> {
    set_configured_java_vmargs(vmargs.as_deref());
    Ok(jdtls_vmargs_string())
}

/// Persist the Settings-configured `java.*` language settings (Lombok, autobuild,
/// organize imports, code generation, …) and hot-apply them to every ready jdtls
/// session via `workspace/didChangeConfiguration`. `None` restores defaults.
///
/// Fields that only take effect at process start (Lombok `-javaagent`) apply on the
/// next workspace restart; the rest update live. Returns the number of sessions
/// that received the live update.
#[tauri::command]
pub async fn lsp_set_java_settings(
    state: State<'_, AppState>,
    settings: Option<JavaLanguageSettings>,
) -> Result<usize, String> {
    set_configured_java_settings(settings);
    // Reuse the resolved settings (defaults when cleared). Runtimes are irrelevant
    // to a live config push — jdtls keeps the ones from initialize.
    let java_settings = get_configured_java_settings().to_java_settings(&[]);
    let notified = state
        .lsp
        .notify_all_jdtls(
            "workspace/didChangeConfiguration",
            json!({ "settings": { "java": java_settings } }),
        )
        .await;
    Ok(notified)
}

/// Persist the Settings-configured jdtls extension bundle paths (java-debug /
/// java-test). Applied on the next jdtls start via `initializationOptions.bundles`
/// (bundles cannot be hot-added). `None` fields clear that bundle.
#[tauri::command]
pub fn lsp_set_java_bundles(config: crate::java_bundles::JavaBundleConfig) -> Result<(), String> {
    crate::java_bundles::set_configured_bundles(config);
    Ok(())
}

/// Probe the configured jdtls extension bundles (java-debug / java-test) for the
/// Settings UI: which are found and the resolved jar path.
#[tauri::command]
pub fn lsp_detect_java_bundles() -> Vec<crate::java_bundles::BundleStatus> {
    crate::java_bundles::probe_bundles(&crate::java_bundles::get_configured_bundles())
}

/// Scan installed VS Code / Cursor / VSCodium extensions for the java-debug and
/// java-test plugin jars so the user can adopt them in one click instead of
/// hunting for a path or downloading anything (the common "setup is complex"
/// case — the jar already ships with a Java extension they have installed).
#[tauri::command]
pub fn lsp_discover_java_bundles() -> Vec<crate::java_bundles::DiscoveredBundle> {
    crate::java_bundles::discover_bundles()
}

#[tauri::command]
pub fn lsp_detect_servers(java_home: Option<String>) -> Vec<LspServerStatus> {
    // Accept an optional override so Settings can probe without waiting for a
    // separate set-home round-trip; also keep the process-global config in sync.
    if let Some(ref home) = java_home {
        set_configured_java_home(Some(home.as_str()));
    }
    clear_command_availability_cache();
    lsp_presets()
        .iter()
        .map(|preset| server_status(preset, None, false, None))
        .collect()
}

#[tauri::command]
pub async fn lsp_document_status(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_execute_command(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    command: String,
    arguments: Vec<Value>,
) -> Result<Value, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| "Language server is not active for this document".to_string())?;
    session
        .request_with_timeout(
            "workspace/executeCommand",
            json!({ "command": command, "arguments": arguments }),
            JAVA_COMMAND_TIMEOUT_SECS,
        )
        .await
}

#[tauri::command]
pub async fn lsp_resolve_workspace_edit(
    state: State<'_, AppState>,
    request_id: String,
    workspace_id: String,
    applied: bool,
    failure_reason: Option<String>,
    failed_change: Option<u32>,
) -> Result<(), String> {
    state.lsp.client_bridge.resolve_workspace_edit(
        &request_id,
        &workspace_id,
        LspWorkspaceApplyEditResponse {
            applied,
            failure_reason,
            failed_change,
        },
    )
}

#[tauri::command]
pub async fn lsp_resolve_show_message_request(
    state: State<'_, AppState>,
    request_id: String,
    workspace_id: String,
    action_index: Option<u32>,
) -> Result<(), String> {
    state
        .lsp
        .client_bridge
        .resolve_show_message(&request_id, &workspace_id, action_index)
}

#[tauri::command]
pub async fn lsp_cancel_work_done_progress(
    state: State<'_, AppState>,
    workspace_id: String,
    preset_id: String,
    root_uri: String,
    token: Value,
) -> Result<bool, String> {
    state
        .lsp
        .cancel_work_done_progress(&workspace_id, &preset_id, &root_uri, &token)
        .await
}

#[tauri::command]
pub async fn lsp_workspace_will_file_operation(
    state: State<'_, AppState>,
    workspace_id: String,
    operation: LspWorkspaceFileOperation,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    state
        .lsp
        .will_workspace_file_operation(workspace_id, &operation)
        .await
}

#[tauri::command]
pub async fn lsp_workspace_did_file_operation(
    state: State<'_, AppState>,
    workspace_id: String,
    operation: LspWorkspaceFileOperation,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    Ok(state
        .lsp
        .did_workspace_file_operation(workspace_id, &operation)
        .await)
}

#[tauri::command]
pub async fn lsp_workspace_did_change_watched_files(
    state: State<'_, AppState>,
    workspace_id: String,
    changes: Vec<LspWatchedFileChange>,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    for change in &changes {
        if !Path::new(&change.path).is_absolute() {
            return Err(format!(
                "workspace/didChangeWatchedFiles requires an absolute path: {}",
                change.path
            ));
        }
        if watch_kind_for_change(change.change_type).is_none() {
            return Err(format!(
                "workspace/didChangeWatchedFiles has invalid file change type {}",
                change.change_type
            ));
        }
    }
    Ok(state
        .lsp
        .did_change_watched_files(workspace_id, &changes)
        .await)
}

#[tauri::command]
pub async fn lsp_start_workspace_watcher(
    state: State<'_, AppState>,
    workspace_id: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    state.lsp.start_workspace_watcher(workspace_id, roots).await
}

#[tauri::command]
pub async fn lsp_stop_workspace_watcher(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspace id is required".into());
    }
    state.lsp.stop_workspace_watcher(workspace_id).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_open_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: String,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    let session = match state
        .lsp
        .ensure_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Ok(session) => session,
        Err(status) => return Ok(status),
    };
    let language_id = document.language_id.as_deref().unwrap_or("plaintext");
    session
        .notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": document.uri,
                    "languageId": language_id,
                    "version": document.version,
                    "text": text
                }
            }),
        )
        .await
        .map_err(|e| format!("LSP didOpen failed: {e}"))?;
    session
        .opened_documents
        .write()
        .await
        .insert(document.uri.clone());
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_change_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: Option<String>,
    change: Option<LspDocumentContentChange>,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        let Some(text) = text else {
            return Err("LSP change requires full document text while starting a session".into());
        };
        return lsp_open_document(
            state,
            document.workspace_id.clone(),
            Some(document.root_path.to_string_lossy().into_owned()),
            document.path.to_string_lossy().into_owned(),
            text,
            version,
            document.language_id.clone(),
            server_command_id,
            custom_server_command,
        )
        .await;
    };
    session
        .cancel_document_requests(
            &document.uri,
            "language server request cancelled: document changed",
        )
        .await;
    if !session
        .opened_documents
        .read()
        .await
        .contains(&document.uri)
    {
        let Some(text) = text else {
            return Err("LSP change requires full document text while reopening a document".into());
        };
        let language_id = document.language_id.as_deref().unwrap_or("plaintext");
        session
            .notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": document.uri,
                        "languageId": language_id,
                        "version": document.version,
                        "text": text
                    }
                }),
            )
            .await
            .map_err(|e| format!("LSP didOpen failed: {e}"))?;
        session
            .opened_documents
            .write()
            .await
            .insert(document.uri.clone());
        return Ok(state
            .lsp
            .document_status(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await);
    }
    let content_change = content_change_for_sync(
        text,
        change,
        session.text_document_sync_kind.load(Ordering::SeqCst),
    )?;
    session
        .notify(
            "textDocument/didChange",
            json!({
                "textDocument": {
                    "uri": document.uri,
                    "version": document.version
                },
                "contentChanges": [content_change]
            }),
        )
        .await
        .map_err(|e| format!("LSP didChange failed: {e}"))?;
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_save_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: Option<String>,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    if let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        let mut params = json!({
            "textDocument": { "uri": document.uri }
        });
        if let Some(text) = text {
            params["text"] = Value::String(text);
        }
        session
            .notify("textDocument/didSave", params)
            .await
            .map_err(|e| format!("LSP didSave failed: {e}"))?;
    }
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_close_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    if let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        session
            .cancel_document_requests(
                &document.uri,
                "language server request cancelled: document closed",
            )
            .await;
        session
            .notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": document.uri } }),
            )
            .await
            .map_err(|e| format!("LSP didClose failed: {e}"))?;
        session.opened_documents.write().await.remove(&document.uri);
        session.diagnostics.write().await.remove(&document.uri);
        let _semantic_tokens_guard = session.semantic_tokens_lock.lock().await;
        session
            .semantic_tokens_cache
            .write()
            .await
            .remove(&document.uri);
    }
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_stop_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<usize, String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".into());
    }
    Ok(state.lsp.stop_workspace(workspace_id).await)
}

#[tauri::command]
pub async fn lsp_get_diagnostics(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDiagnosticsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let diagnostics = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session
            .diagnostics
            .read()
            .await
            .get(&document.uri)
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspDiagnosticsResult {
        status,
        diagnostics,
    })
}

/// Refresh LSP 3.17 pull-capable servers, then return diagnostics stored across
/// the workspace's ready sessions (M7-C), including files the user never opened.
/// Servers without `workspace/diagnostic` keep using publishDiagnostics data.
/// Empty when no session is active.
#[tauri::command]
pub async fn lsp_workspace_diagnostics(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<WorkspaceDiagnosticFile>, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    Ok(state.lsp.workspace_diagnostics(workspace_id).await)
}

/// Outcome of a jdtls workspace build, mirroring JDT LS's `BuildWorkspaceStatus`
/// so the caller can tell "built clean" from "built, but the project has compile
/// errors" without a second diagnostics sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspBuildStatus {
    Failed,
    Succeed,
    WithError,
    Cancelled,
}

/// Map JDT LS's `BuildWorkspaceStatus` ordinal (`java/buildWorkspace` result).
fn build_status_from_result(value: &Value) -> LspBuildStatus {
    match value.as_u64() {
        Some(0) => LspBuildStatus::Failed,
        Some(2) => LspBuildStatus::WithError,
        Some(3) => LspBuildStatus::Cancelled,
        // 1 = SUCCEED. Anything unexpected is treated as a plain success: the
        // build ran, and blocking a launch on an unknown enum value would be
        // worse than trusting the diagnostics the caller checks next.
        _ => LspBuildStatus::Succeed,
    }
}

/// Build the project on the active jdtls session (M7-C "Rebuild project" and the
/// make-before-launch barrier of a Java debug start).
///
/// This is JDT LS's custom **`java/buildWorkspace` request** — NOT a
/// `workspace/executeCommand`. jdtls registers no `java.buildWorkspace` command
/// (it answers "No delegateCommandHandler for java.buildWorkspace"), and
/// java-debug's `vscode.java.buildWorkspace` takes a String argument, so both
/// executeCommand spellings fail outright — silently turning make-before-launch
/// into a no-op and leaving the debuggee to run stale bytecode.
///
/// `full = true` forces a clean rebuild (so diagnostics for unopened files are
/// republished); the launch barrier passes `false` for an incremental build.
#[tauri::command]
pub async fn lsp_build_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    full: Option<bool>,
) -> Result<LspBuildStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;
    // `java/buildWorkspace` takes the `forceReBuild` flag as a bare boolean.
    let full = full.unwrap_or(true);
    let started = Instant::now();
    let result = session
        .request_with_timeout(
            "java/buildWorkspace",
            json!(full),
            BUILD_WORKSPACE_TIMEOUT_SECS,
        )
        .await
        .map_err(|e| format!("Failed to build project: {e}"))?;
    let status = build_status_from_result(&result);
    log::info!(
        "lsp: java/buildWorkspace(full={full}) → {status:?} in {:?}",
        started.elapsed()
    );
    Ok(status)
}

#[tauri::command]
pub async fn lsp_hover(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspHoverResult, String> {
    let document = with_document_uri(
        resolve_document(workspace_id, root_path, file_path, language_id, 0)?,
        document_uri,
    );
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspHoverResult {
                status,
                contents: None,
                range: None,
            });
        }
    };
    let result = session
        .request(
            "textDocument/hover",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character }
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspHoverResult {
        status,
        contents: hover_contents(&result),
        range: result.get("range").and_then(parse_range),
    })
}

#[tauri::command]
pub async fn lsp_definition(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/definition",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_references(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    include_declaration: Option<bool>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/references",
        json!({
            "context": {
                "includeDeclaration": include_declaration.unwrap_or(true)
            }
        }),
    )
    .await
}

async fn lsp_location_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    method: &str,
    mut extra: Value,
) -> Result<LspLocationsResult, String> {
    let document = with_document_uri(
        resolve_document(workspace_id, root_path, file_path, language_id, 0)?,
        document_uri,
    );
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspLocationsResult {
                status,
                locations: Vec::new(),
            });
        }
    };
    extra["textDocument"] = json!({ "uri": document.uri });
    extra["position"] = json!({ "line": line, "character": character });
    let result = session.request(method, extra).await.unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspLocationsResult {
        status,
        locations: parse_locations(&result),
    })
}

#[tauri::command]
pub async fn lsp_document_symbols(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentSymbolsResult, String> {
    let document = with_document_uri(
        resolve_document(workspace_id, root_path, file_path, language_id, 0)?,
        document_uri,
    );
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspDocumentSymbolsResult {
                status,
                symbols: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": document.uri } }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let mut symbols = Vec::new();
    collect_document_symbols(&result, 0, &mut symbols);
    Ok(LspDocumentSymbolsResult { status, symbols })
}

#[tauri::command]
pub async fn lsp_completion(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    trigger_character: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCompletionResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCompletionResult {
                status,
                is_incomplete: false,
                items: Vec::new(),
            });
        }
    };
    let context = match trigger_character.as_deref().filter(|c| !c.is_empty()) {
        Some(character) => json!({ "triggerKind": 2, "triggerCharacter": character }),
        None => json!({ "triggerKind": 1 }),
    };
    let result = session
        .request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "context": context,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let (is_incomplete, items) = parse_completion_response(&result);
    Ok(LspCompletionResult {
        status,
        is_incomplete,
        items,
    })
}

#[tauri::command]
pub async fn lsp_completion_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<Option<LspCompletionItem>, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        return Ok(None);
    };
    let resolved = session
        .request("completionItem/resolve", item.clone())
        .await
        .unwrap_or(Value::Null);
    // Servers without resolve support may error or return null; fall back to
    // the original item so callers always get something applicable.
    Ok(parse_completion_item(&resolved).or_else(|| parse_completion_item(&item)))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFormattingResult {
    pub status: LspDocumentStatus,
    pub edits: Vec<LspTextEdit>,
}

/// One file's worth of TextEdits from a WorkspaceEdit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFileTextEdits {
    pub uri: String,
    pub path: Option<String>,
    pub version: Option<i64>,
    pub edits: Vec<LspTextEdit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotation_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspChangeAnnotation {
    pub id: String,
    pub label: String,
    pub needs_confirmation: bool,
    pub description: Option<String>,
}

/// Normalized workspace edit for clients (rename / code actions / replace).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LspWorkspaceEditOperation {
    Text {
        document: LspFileTextEdits,
    },
    Create {
        uri: String,
        path: Option<String>,
        overwrite: bool,
        ignore_if_exists: bool,
        annotation_id: Option<String>,
    },
    Rename {
        old_uri: String,
        old_path: Option<String>,
        new_uri: String,
        new_path: Option<String>,
        overwrite: bool,
        ignore_if_exists: bool,
        annotation_id: Option<String>,
    },
    Delete {
        uri: String,
        path: Option<String>,
        recursive: bool,
        ignore_if_not_exists: bool,
        annotation_id: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceEdit {
    pub document_edits: Vec<LspFileTextEdits>,
    #[serde(default)]
    pub operations: Vec<LspWorkspaceEditOperation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub change_annotations: Vec<LspChangeAnnotation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceFileOperationTarget {
    pub path: String,
    #[serde(default)]
    pub is_directory: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceFileRenameTarget {
    pub old_path: String,
    pub new_path: String,
    #[serde(default)]
    pub is_directory: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LspWorkspaceFileOperation {
    Create {
        files: Vec<LspWorkspaceFileOperationTarget>,
    },
    Rename {
        files: Vec<LspWorkspaceFileRenameTarget>,
    },
    Delete {
        files: Vec<LspWorkspaceFileOperationTarget>,
    },
}

/// A local filesystem event forwarded to language servers that registered
/// `workspace/didChangeWatchedFiles` watchers. The numeric `type` values are
/// the LSP FileChangeType enum: 1 = created, 2 = changed, 3 = deleted.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspWatchedFileChange {
    pub path: String,
    #[serde(rename = "type")]
    pub change_type: u8,
}

impl LspWorkspaceFileOperation {
    fn will_method(&self) -> &'static str {
        match self {
            Self::Create { .. } => "workspace/willCreateFiles",
            Self::Rename { .. } => "workspace/willRenameFiles",
            Self::Delete { .. } => "workspace/willDeleteFiles",
        }
    }

    fn did_method(&self) -> &'static str {
        match self {
            Self::Create { .. } => "workspace/didCreateFiles",
            Self::Rename { .. } => "workspace/didRenameFiles",
            Self::Delete { .. } => "workspace/didDeleteFiles",
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Create { .. } => "creating files",
            Self::Rename { .. } => "renaming files",
            Self::Delete { .. } => "deleting files",
        }
    }

    fn watched_file_changes(&self) -> Vec<LspWatchedFileChange> {
        match self {
            Self::Create { files } => files
                .iter()
                .map(|file| LspWatchedFileChange {
                    path: file.path.clone(),
                    change_type: 1,
                })
                .collect(),
            Self::Delete { files } => files
                .iter()
                .map(|file| LspWatchedFileChange {
                    path: file.path.clone(),
                    change_type: 3,
                })
                .collect(),
            Self::Rename { files } => files
                .iter()
                .flat_map(|file| {
                    [
                        LspWatchedFileChange {
                            path: file.old_path.clone(),
                            change_type: 3,
                        },
                        LspWatchedFileChange {
                            path: file.new_path.clone(),
                            change_type: 1,
                        },
                    ]
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub is_preferred: bool,
    pub edit: Option<LspWorkspaceEdit>,
    pub command: Option<String>,
    pub command_arguments: Option<Value>,
    /// Original server action for executeCommand / resolve.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeActionsResult {
    pub status: LspDocumentStatus,
    pub actions: Vec<LspCodeAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeActionResolveResult {
    pub status: LspDocumentStatus,
    pub action: Option<LspCodeAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPrepareRenameResult {
    pub status: LspDocumentStatus,
    pub range: Option<LspRange>,
    pub placeholder: Option<String>,
    pub allowed: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRenameResult {
    pub status: LspDocumentStatus,
    pub edit: LspWorkspaceEdit,
}

#[tauri::command]
pub async fn lsp_prepare_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspPrepareRenameResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspPrepareRenameResult {
                status,
                range: None,
                placeholder: None,
                allowed: false,
                message: Some("Language server is not active".into()),
            });
        }
    };
    let result = session
        .request(
            "textDocument/prepareRename",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
            }),
        )
        .await;
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    match result {
        Ok(Value::Null) | Err(_) => Ok(LspPrepareRenameResult {
            status,
            range: None,
            placeholder: None,
            allowed: false,
            message: Some("Rename is not available at this position".into()),
        }),
        Ok(value) => {
            // Range | { range, placeholder } | { defaultBehavior: true }
            if value.get("defaultBehavior").and_then(Value::as_bool) == Some(true) {
                return Ok(LspPrepareRenameResult {
                    status,
                    range: None,
                    placeholder: None,
                    allowed: true,
                    message: None,
                });
            }
            let range = value
                .get("range")
                .and_then(parse_range)
                .or_else(|| parse_range(&value));
            let placeholder = value
                .get("placeholder")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let allowed = range.is_some() || placeholder.is_some();
            Ok(LspPrepareRenameResult {
                status,
                range,
                placeholder,
                allowed,
                message: None,
            })
        }
    }
}

#[tauri::command]
pub async fn lsp_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    new_name: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspRenameResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspRenameResult {
                status,
                edit: LspWorkspaceEdit::default(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/rename",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "newName": new_name,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspRenameResult {
        status,
        edit: parse_workspace_edit(&result),
    })
}

#[tauri::command]
pub async fn lsp_type_definition(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/typeDefinition",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_implementation(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        document_uri,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/implementation",
        json!({}),
    )
    .await
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ServerVirtualDocument {
    text: String,
    title: String,
    container: Option<String>,
    language_id: String,
    decompiled: bool,
}

fn source_extension_for_language(language_id: &str) -> &'static str {
    match language_id {
        "kotlin" => "kt",
        "scala" => "scala",
        "csharp" => "cs",
        "swift" => "swift",
        "cpp" | "c" => "cpp",
        "python" => "py",
        "rust" => "rs",
        "go" => "go",
        "typescript" | "typescriptreact" => "ts",
        "javascript" | "javascriptreact" => "js",
        _ => "java",
    }
}

fn title_from_virtual_uri(uri: &str, language_id: &str) -> String {
    let clean = uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .trim_end_matches('/');
    let name = clean
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Library");
    if name.to_ascii_lowercase().ends_with(".class") {
        return format!(
            "{}.{}",
            &name[..name.len() - ".class".len()],
            source_extension_for_language(language_id)
        );
    }
    name.to_string()
}

fn response_string<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

async fn read_server_virtual_document(
    session: &Arc<LspSession>,
    uri: &str,
) -> Result<ServerVirtualDocument, String> {
    match session.key.preset_id.as_str() {
        "java" if is_virtual_class_uri(uri) => {
            let result = session
                .request_with_timeout(
                    "java/classFileContents",
                    json!({ "uri": uri }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to load Java class contents: {error}"))?;
            let text = result
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "Java language server returned no source for {}: attach a sources JAR or install a decompiler",
                        title_from_class_uri(uri)
                    )
                })?
                .to_string();
            Ok(ServerVirtualDocument {
                title: title_from_class_uri(uri),
                container: container_from_class_uri(uri),
                language_id: "java".into(),
                decompiled: is_decompiled_contents(&text),
                text,
            })
        }
        "kotlin" if uri.to_ascii_lowercase().starts_with("kls:") => {
            let result = session
                .request_with_timeout(
                    "kotlin/jarClassContents",
                    json!({ "uri": uri }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to load Kotlin library contents: {error}"))?;
            let text = result
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "Kotlin language server returned no library source".to_string())?
                .to_string();
            let language_id = language_id_from_uri(uri);
            Ok(ServerVirtualDocument {
                title: title_from_virtual_uri(uri, &language_id),
                container: archive_document_uri(uri).and_then(|document| {
                    document
                        .archive_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
                language_id,
                // This provider may decompile, but only jdtls supports Taomni's
                // on-demand source attachment action.
                decompiled: false,
                text,
            })
        }
        "kotlin" => {
            let result = session
                .request_with_timeout(
                    "workspace/executeCommand",
                    json!({ "command": "decompile", "arguments": [uri] }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to decompile Kotlin library source: {error}"))?;
            let text = response_string(&result, &["code", "Code"])
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "Kotlin language server returned no decompiled source".to_string())?
                .to_string();
            let language_id = response_string(&result, &["language", "Language"])
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("kotlin")
                .to_ascii_lowercase();
            Ok(ServerVirtualDocument {
                title: title_from_virtual_uri(uri, &language_id),
                container: archive_document_uri(uri).and_then(|document| {
                    document
                        .archive_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
                language_id,
                decompiled: false,
                text,
            })
        }
        "scala" => {
            let result = session
                .request_with_timeout(
                    "workspace/executeCommand",
                    json!({ "command": "file-decode", "arguments": [uri] }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to decode Scala library source: {error}"))?;
            let text = response_string(&result, &["value", "Value"])
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    response_string(&result, &["error", "Error"])
                        .unwrap_or("Metals returned no library source")
                        .to_string()
                })?
                .to_string();
            Ok(ServerVirtualDocument {
                title: title_from_virtual_uri(uri, "scala"),
                container: archive_document_uri(uri).and_then(|document| {
                    document
                        .archive_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
                language_id: "scala".into(),
                decompiled: false,
                text,
            })
        }
        "csharp" if uri.to_ascii_lowercase().starts_with("csharp:") => {
            let result = session
                .request_with_timeout(
                    "csharp/metadata",
                    json!({ "textDocument": { "uri": uri } }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to load C# metadata source: {error}"))?;
            let text = response_string(&result, &["source", "Source"])
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "C# language server returned no metadata source".to_string())?
                .to_string();
            let assembly = response_string(&result, &["assemblyName", "AssemblyName"]);
            let project = response_string(&result, &["projectName", "ProjectName"]);
            let title = response_string(&result, &["symbolName", "SymbolName"])
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("{value}.cs"))
                .unwrap_or_else(|| title_from_virtual_uri(uri, "csharp"));
            let container = match (assembly, project) {
                (Some(assembly), Some(project)) => Some(format!("{assembly} · {project}")),
                (Some(assembly), None) => Some(assembly.to_string()),
                (None, Some(project)) => Some(project.to_string()),
                (None, None) => None,
            };
            Ok(ServerVirtualDocument {
                title,
                container,
                language_id: "csharp".into(),
                decompiled: false,
                text,
            })
        }
        preset => Err(format!(
            "{preset} language server returned an unsupported virtual document URI: {uri}"
        )),
    }
}

/// Open library / virtual LSP locations. Real files cover most SDKs (Rust,
/// TypeScript, Python, Go, clangd, Swift). Archive and server-owned documents
/// cover Kotlin, Scala, C#, and Java dependency/JDK definitions.
#[tauri::command]
pub async fn lsp_read_uri_contents(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    uri: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspUriContentsResult, String> {
    let uri = uri.trim().to_string();
    if uri.is_empty() {
        return Err("Missing document URI".into());
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;

    // Real file on disk (workspace sources, cargo registry, jdt extracted sources, …).
    if let Some(path) = path_from_uri(&uri) {
        let target = PathBuf::from(&path);
        if target.is_file() {
            let text = std::fs::read_to_string(&target)
                .map_err(|e| format!("read {}: {e}", target.display()))?;
            let language = detect_language_for_path(&target)
                .map(|detected| detected.language_id)
                .unwrap_or_else(|| language_id_from_uri(&uri));
            return Ok(LspUriContentsResult {
                status,
                uri,
                path: Some(path.clone()),
                title: target
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone()),
                container: target
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned()),
                language_id: language,
                decompiled: is_decompiled_contents(&text),
                text,
                read_only: true,
            });
        }
    }

    // Attached sources in JAR/ZIP files need no server-specific extension.
    // Keep a read error as context, then let the server decompile/fetch instead.
    let archive_error = match read_archive_source_contents(&uri) {
        Ok(Some(contents)) => {
            return Ok(LspUriContentsResult {
                status,
                uri,
                path: None,
                title: contents.title,
                container: contents.container,
                language_id: contents.language_id,
                text: contents.text,
                read_only: true,
                decompiled: false,
            });
        }
        Ok(None) => None,
        Err(error) => Some(error),
    };

    let session = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            archive_error.clone().unwrap_or_else(|| {
                "No language server session is active for this file; cannot open library source"
                    .to_string()
            })
        })?;
    let contents = read_server_virtual_document(&session, &uri)
        .await
        .map_err(|error| match archive_error {
            Some(archive_error) => {
                format!("{error}; direct archive read also failed: {archive_error}")
            }
            None => error,
        })?;
    Ok(LspUriContentsResult {
        status,
        uri,
        path: None,
        title: contents.title,
        container: contents.container,
        language_id: contents.language_id,
        text: contents.text,
        read_only: true,
        decompiled: contents.decompiled,
    })
}

/// Result of an on-demand source-attachment request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDownloadSourcesResult {
    /// True when attached (non-decompiled) source is now available for the class.
    pub attached: bool,
    /// Fresh contents for the class (attached source when `attached`, otherwise the
    /// existing decompiled text) so the caller can refresh the buffer in place.
    pub text: String,
    pub decompiled: bool,
    /// User-facing note (why nothing was attached), when `attached` is false.
    pub message: Option<String>,
}

/// FernFlower stamps a fixed banner as the first line of decompiled output; jdtls
/// serves attached source verbatim, so the banner uniquely marks decompiled text.
/// Keep in sync with FernFlowerDecompiler.DECOMPILER_HEADER upstream.
const JDTLS_DECOMPILER_HEADER: &str =
    "// Source code is decompiled from a .class file using FernFlower decompiler";

fn is_decompiled_contents(text: &str) -> bool {
    text.trim_start().starts_with(JDTLS_DECOMPILER_HEADER)
}

/// IDEA-style "Download sources": enable Maven/Gradle source download for the
/// active jdtls session, trigger a project re-configuration so the build tool
/// fetches the sources JAR, then poll `java/classFileContents` until attached
/// source replaces the decompiled bytecode (or a timeout elapses).
///
/// Kept off by default (so imports stay fast); this only flips it on when the user
/// explicitly asks, matching IntelliJ's on-demand download button.
#[tauri::command]
pub async fn lsp_download_sources(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    uri: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDownloadSourcesResult, String> {
    let uri = uri.trim().to_string();
    if uri.is_empty() {
        return Err("Missing class URI".into());
    }
    if !is_virtual_class_uri(&uri) {
        return Err("Download sources is only available for library class files".into());
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    if document.preset.as_ref().map(|preset| preset.id.as_str()) != Some("java") {
        return Err("Download sources is only available for Java class files".into());
    }
    let session = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;

    // 1) Turn on source download for this session (Maven + Gradle + Eclipse importers).
    session
        .notify(
            "workspace/didChangeConfiguration",
            json!({
                "settings": {
                    "java": {
                        "maven": { "downloadSources": true },
                        "eclipse": { "downloadSources": true },
                        "gradle": { "wrapper": { "enabled": true } },
                        "import": {
                            "maven": { "enabled": true },
                            "gradle": { "enabled": true }
                        }
                    }
                }
            }),
        )
        .await?;

    // 2) Trigger project reconfiguration keyed on the origin project file so the
    //    build tool re-resolves the classpath and pulls the sources JAR.
    session
        .notify(
            "java/projectConfigurationUpdate",
            json!({ "uri": document.uri }),
        )
        .await?;

    // 3) Poll classFileContents until attached source shows up (no decompiler
    //    banner) or we give up. Reconfiguration + download is async in jdtls.
    let mut last_text = String::new();
    for attempt in 0..DOWNLOAD_SOURCES_POLL_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(DOWNLOAD_SOURCES_POLL_INTERVAL_MS)).await;
        let result = session
            .request_with_timeout("java/classFileContents", json!({ "uri": uri }), 20)
            .await
            .map_err(|e| format!("Failed to reload class contents: {e}"))?;
        let text = result.as_str().unwrap_or_default().to_string();
        if text.trim().is_empty() {
            continue;
        }
        last_text = text;
        if !is_decompiled_contents(&last_text) {
            return Ok(LspDownloadSourcesResult {
                attached: true,
                text: last_text,
                decompiled: false,
                message: None,
            });
        }
        log::debug!(
            "lsp: download sources poll {}/{} still decompiled for {uri}",
            attempt + 1,
            DOWNLOAD_SOURCES_POLL_ATTEMPTS
        );
    }

    Ok(LspDownloadSourcesResult {
        attached: false,
        text: last_text,
        decompiled: true,
        message: Some(
            "No sources published for this artifact (still showing decompiled bytecode). \
             The dependency may not ship a -sources JAR."
                .to_string(),
        ),
    })
}

/// Reload the Java project configuration for the active jdtls session (IDEA's
/// "Reload project"). Notifies `java/projectConfigurationUpdate` keyed on a build
/// file (pom.xml / build.gradle) so jdtls re-imports the Maven/Gradle model after
/// the user edits it. `file_path` should be the changed build file; any project
/// file works since jdtls reconfigures the owning project.
///
/// Fire-and-forget: jdtls reconfigures asynchronously (progress arrives via its
/// own status notifications), so this returns once the notify is delivered.
#[tauri::command]
pub async fn lsp_reload_project(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<(), String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;
    session
        .notify(
            "java/projectConfigurationUpdate",
            json!({ "uri": document.uri }),
        )
        .await
}

/// A Java project/module discovered by jdtls (`java.project.getAll`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JavaModule {
    /// Module name (last path segment of the project directory).
    pub name: String,
    /// Absolute filesystem path to the module root.
    pub path: String,
    /// Original project URI as reported by jdtls.
    pub uri: String,
}

/// Turn jdtls `java.project.getAll` output (an array of `file://` project URIs)
/// into module entries. Non-file / unparseable URIs are skipped; results are
/// de-duplicated and sorted by name for a stable module view.
fn parse_java_modules(value: &Value) -> Vec<JavaModule> {
    let mut modules: Vec<JavaModule> = Vec::new();
    let Some(items) = value.as_array() else {
        return modules;
    };
    for item in items {
        let Some(uri) = item.as_str() else {
            continue;
        };
        let path = url::Url::parse(uri)
            .ok()
            .filter(|url| url.scheme() == "file")
            .and_then(|url| url.to_file_path().ok());
        let Some(path) = path else {
            continue;
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("module")
            .to_string();
        let path_str = path.to_string_lossy().into_owned();
        if modules.iter().any(|module| module.path == path_str) {
            continue;
        }
        modules.push(JavaModule {
            name,
            path: path_str,
            uri: uri.to_string(),
        });
    }
    modules.sort_by(|a, b| a.name.cmp(&b.name));
    modules
}

/// List the Java projects/modules in the workspace via jdtls
/// `workspace/executeCommand: java.project.getAll` (M7 F-4). Returns an empty
/// list when the session has no such command; errors when no session is active.
#[tauri::command]
pub async fn lsp_java_modules(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<Vec<JavaModule>, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;
    let result = session
        .request(
            "workspace/executeCommand",
            json!({ "command": "java.project.getAll", "arguments": [] }),
        )
        .await
        .map_err(|e| format!("Failed to list Java modules: {e}"))?;
    Ok(parse_java_modules(&result))
}

#[tauri::command]
pub async fn lsp_workspace_symbols(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    query: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspWorkspaceSymbolsResult, String> {
    // Any open document under the workspace is enough to provide a status
    // context. The actual query fans out across every ready provider session
    // belonging to this workspace (including other roots/languages).
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let aggregation = state
        .lsp
        .workspace_symbols(&document.workspace_id, &query)
        .await?;
    Ok(LspWorkspaceSymbolsResult {
        status,
        symbols: aggregation.symbols,
        session_count: aggregation.session_count,
        provider_count: aggregation.provider_count,
        skipped_provider_count: aggregation.skipped_provider_count,
        failed_provider_count: aggregation.failed_provider_count,
        complete: aggregation.complete,
        truncated: aggregation.truncated,
        diagnostics: aggregation.diagnostics,
    })
}

#[tauri::command]
pub async fn lsp_workspace_symbol_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    resolve_token: String,
) -> Result<LspWorkspaceSymbol, String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".into());
    }
    let resolve_token = resolve_token.trim();
    if resolve_token.is_empty() {
        return Err("resolveToken is required".into());
    }
    state
        .lsp
        .resolve_workspace_symbol(workspace_id, resolve_token)
        .await
}

#[tauri::command]
pub async fn lsp_prepare_call_hierarchy(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspHierarchyPrepareResult, String> {
    lsp_hierarchy_prepare_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/prepareCallHierarchy",
    )
    .await
}

#[tauri::command]
pub async fn lsp_prepare_type_hierarchy(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspHierarchyPrepareResult, String> {
    lsp_hierarchy_prepare_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/prepareTypeHierarchy",
    )
    .await
}

async fn lsp_hierarchy_prepare_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    method: &str,
) -> Result<LspHierarchyPrepareResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        let status = state
            .lsp
            .document_status(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await;
        return Ok(LspHierarchyPrepareResult {
            status,
            items: Vec::new(),
        });
    };
    let result = session
        .request(
            method,
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspHierarchyPrepareResult {
        status,
        items: parse_hierarchy_items(&result),
    })
}

#[tauri::command]
pub async fn lsp_call_hierarchy_incoming(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCallHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        "callHierarchy/incomingCalls",
    )
    .await?;
    Ok(LspCallHierarchyResult {
        status,
        entries: parse_call_hierarchy_entries(&value, "from"),
    })
}

#[tauri::command]
pub async fn lsp_call_hierarchy_outgoing(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCallHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        "callHierarchy/outgoingCalls",
    )
    .await?;
    Ok(LspCallHierarchyResult {
        status,
        entries: parse_call_hierarchy_entries(&value, "to"),
    })
}

#[tauri::command]
pub async fn lsp_type_hierarchy_supertypes(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspTypeHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        "typeHierarchy/supertypes",
    )
    .await?;
    Ok(LspTypeHierarchyResult {
        status,
        items: parse_hierarchy_items(&value),
    })
}

#[tauri::command]
pub async fn lsp_type_hierarchy_subtypes(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspTypeHierarchyResult, String> {
    let (status, value) = lsp_hierarchy_item_request(
        state,
        workspace_id,
        root_path,
        file_path,
        item,
        language_id,
        server_command_id,
        custom_server_command,
        "typeHierarchy/subtypes",
    )
    .await?;
    Ok(LspTypeHierarchyResult {
        status,
        items: parse_hierarchy_items(&value),
    })
}

async fn lsp_hierarchy_item_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    method: &str,
) -> Result<(LspDocumentStatus, Value), String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let result = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session
            .request(method, json!({ "item": item }))
            .await
            .unwrap_or(Value::Null),
        None => Value::Null,
    };
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok((status, result))
}

#[tauri::command]
pub async fn lsp_document_highlights(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentHighlightsResult, String> {
    let (status, value) = lsp_document_feature_request(
        state,
        workspace_id,
        root_path,
        file_path,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/documentHighlight",
        json!({ "position": { "line": line, "character": character } }),
    )
    .await?;
    Ok(LspDocumentHighlightsResult {
        status,
        highlights: parse_document_highlights(&value),
    })
}

#[tauri::command]
pub async fn lsp_inlay_hints(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspInlayHintsResult, String> {
    let (status, value) = lsp_document_feature_request(
        state,
        workspace_id,
        root_path,
        file_path,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/inlayHint",
        json!({
            "range": {
                "start": { "line": start_line, "character": start_character },
                "end": { "line": end_line, "character": end_character },
            }
        }),
    )
    .await?;
    Ok(LspInlayHintsResult {
        status,
        hints: parse_inlay_hints(&value),
    })
}

#[tauri::command]
pub async fn lsp_selection_ranges(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspSelectionRangesResult, String> {
    let (status, value) = lsp_document_feature_request(
        state,
        workspace_id,
        root_path,
        file_path,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/selectionRange",
        json!({ "positions": [{ "line": line, "character": character }] }),
    )
    .await?;
    Ok(LspSelectionRangesResult {
        status,
        ranges: parse_selection_ranges(&value),
    })
}

#[tauri::command]
pub async fn lsp_semantic_tokens(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspSemanticTokensResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        return Ok(LspSemanticTokensResult {
            status,
            tokens: Vec::new(),
        });
    };
    if !session
        .capabilities
        .read()
        .await
        .as_ref()
        .map(|caps| caps.semantic_tokens)
        .unwrap_or(false)
    {
        return Ok(LspSemanticTokensResult {
            status,
            tokens: Vec::new(),
        });
    }
    let _semantic_tokens_guard = session.semantic_tokens_lock.lock().await;
    let cached = session
        .semantic_tokens_cache
        .read()
        .await
        .get(&document.uri)
        .cloned();
    let delta_supported = *session.semantic_tokens_delta.read().await;
    let mut resolved = None;
    if delta_supported && let Some(previous) = cached.as_ref() {
        let delta = session
            .request(
                "textDocument/semanticTokens/full/delta",
                json!({
                    "textDocument": { "uri": document.uri },
                    "previousResultId": previous.result_id,
                }),
            )
            .await;
        if let Ok(value) = delta {
            resolved = semantic_token_data_from_response(&value)
                .or_else(|| apply_semantic_token_delta(previous, &value));
        }
    }
    if resolved.is_none() {
        let value = session
            .request(
                "textDocument/semanticTokens/full",
                json!({ "textDocument": { "uri": document.uri } }),
            )
            .await
            .unwrap_or(Value::Null);
        resolved = semantic_token_data_from_response(&value);
    }
    let (data, result_id) = resolved.unwrap_or_default();
    if let Some(result_id) = result_id {
        session.semantic_tokens_cache.write().await.insert(
            document.uri.clone(),
            SemanticTokensCache {
                result_id,
                data: data.clone(),
            },
        );
    } else {
        session
            .semantic_tokens_cache
            .write()
            .await
            .remove(&document.uri);
    }
    let token_types = session.semantic_token_types.read().await.clone();
    let token_modifiers = session.semantic_token_modifiers.read().await.clone();
    let tokens = decode_semantic_token_data(&data, &token_types, &token_modifiers);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspSemanticTokensResult { status, tokens })
}

async fn lsp_document_feature_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    method: &str,
    mut params: Value,
) -> Result<(LspDocumentStatus, Value), String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    params["textDocument"] = json!({ "uri": document.uri });
    let result = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session.request(method, params).await.unwrap_or(Value::Null),
        None => Value::Null,
    };
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok((status, result))
}

#[tauri::command]
pub async fn lsp_code_actions(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    diagnostics: Option<Vec<Value>>,
    only: Option<Vec<String>>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCodeActionsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCodeActionsResult {
                status,
                actions: Vec::new(),
            });
        }
    };
    let context = code_action_context(diagnostics.unwrap_or_default(), only);
    let result = session
        .request(
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": document.uri },
                "range": {
                    "start": { "line": start_line, "character": start_character },
                    "end": { "line": end_line, "character": end_character },
                },
                "context": context,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspCodeActionsResult {
        status,
        actions: parse_code_actions(&result),
    })
}

/// Resolve a lazily populated CodeAction only after the user selects it.
/// Servers are allowed to return just `title`/`data` from codeAction and fill
/// in the edit or command during `codeAction/resolve`; merge the response with
/// the original object so omitted fields remain available to the client.
#[tauri::command]
pub async fn lsp_code_action_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    action: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCodeActionResolveResult, String> {
    if !action.is_object() {
        return Err("codeAction/resolve requires an object action".into());
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCodeActionResolveResult {
                status,
                action: parse_code_action(&action),
            });
        }
    };
    let resolved = session
        .request("codeAction/resolve", action.clone())
        .await?;
    let merged = if resolved.is_null() {
        action
    } else {
        merge_code_action_values(&action, &resolved)
    };
    let parsed = parse_code_action(&merged)
        .ok_or_else(|| "codeAction/resolve returned an invalid CodeAction".to_string())?;
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspCodeActionResolveResult {
        status,
        action: Some(parsed),
    })
}

#[tauri::command]
pub async fn lsp_formatting(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
) -> Result<LspFormattingResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspFormattingResult {
                status,
                edits: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/formatting",
            json!({
                "textDocument": { "uri": document.uri },
                "options": {
                    "tabSize": tab_size.unwrap_or(2),
                    "insertSpaces": insert_spaces.unwrap_or(true),
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspFormattingResult {
        status,
        edits: parse_text_edits(&result),
    })
}

#[tauri::command]
pub async fn lsp_range_formatting(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
) -> Result<LspFormattingResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspFormattingResult {
                status,
                edits: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/rangeFormatting",
            json!({
                "textDocument": { "uri": document.uri },
                "range": {
                    "start": { "line": start_line, "character": start_character },
                    "end": { "line": end_line, "character": end_character },
                },
                "options": {
                    "tabSize": tab_size.unwrap_or(2),
                    "insertSpaces": insert_spaces.unwrap_or(true),
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspFormattingResult {
        status,
        edits: parse_text_edits(&result),
    })
}

#[tauri::command]
pub async fn lsp_signature_help(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    trigger_character: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspSignatureHelpResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspSignatureHelpResult {
                status,
                signatures: Vec::new(),
                active_signature: 0,
                active_parameter: 0,
            });
        }
    };
    let context = match trigger_character.as_deref().filter(|c| !c.is_empty()) {
        Some(character) => json!({
            "triggerKind": 2,
            "triggerCharacter": character,
            "isRetrigger": false,
        }),
        None => json!({ "triggerKind": 1, "isRetrigger": false }),
    };
    let result = session
        .request(
            "textDocument/signatureHelp",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "context": context,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let (signatures, active_signature, active_parameter) = parse_signature_help(&result);
    Ok(LspSignatureHelpResult {
        status,
        signatures,
        active_signature,
        active_parameter,
    })
}

fn resolve_document(
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    version: i64,
) -> Result<ResolvedDocument, String> {
    let trimmed_workspace = workspace_id.trim();
    let workspace_id = if trimmed_workspace.is_empty() {
        "default".to_string()
    } else {
        trimmed_workspace.to_string()
    };
    let path = resolve_file_path(root_path.as_deref(), &file_path)?;
    let root_path = resolve_root_path(root_path.as_deref(), &path)?;
    let uri = url::Url::from_file_path(&path)
        .map_err(|_| format!("Cannot convert path to file URI: {}", path.display()))?
        .to_string();
    let detected = language_id
        .as_deref()
        .and_then(detect_language_id)
        .or_else(|| detect_language_for_path(&path));
    let preset = detected
        .as_ref()
        .and_then(|detected| find_preset(&detected.preset_id));
    Ok(ResolvedDocument {
        path,
        uri,
        root_path,
        workspace_id,
        preset,
        language_id: detected.map(|detected| detected.language_id),
        version,
    })
}

/// Retarget a resolved document at a virtual URI (a `jdt://` library buffer) while
/// keeping the origin file's path for session / SDK selection: library sources have
/// no project of their own, so requests must ride the origin project's session.
fn with_document_uri(
    mut document: ResolvedDocument,
    document_uri: Option<String>,
) -> ResolvedDocument {
    if let Some(uri) = document_uri
        .map(|uri| uri.trim().to_string())
        .filter(|uri| !uri.is_empty())
    {
        document.uri = uri;
    }
    document
}

fn resolve_file_path(root_path: Option<&str>, file_path: &str) -> Result<PathBuf, String> {
    let file = Path::new(file_path);
    let path = if file.is_absolute() {
        file.to_path_buf()
    } else if let Some(root) = root_path.map(str::trim).filter(|root| !root.is_empty()) {
        Path::new(root).join(file)
    } else {
        file.to_path_buf()
    };
    Ok(path)
}

fn resolve_root_path(root_path: Option<&str>, file_path: &Path) -> Result<PathBuf, String> {
    if let Some(root) = root_path.map(str::trim).filter(|root| !root.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    file_path.parent().map(Path::to_path_buf).ok_or_else(|| {
        format!(
            "Cannot resolve parent directory for {}",
            file_path.display()
        )
    })
}

/// Pick the directory to hand a language server as its `rootUri` / working dir.
///
/// `project_scope_path` comes from the SDK resolver, which canonicalizes the
/// workspace root (`std::fs::canonicalize`). Document URIs, however, are built
/// from `document.root_path` — the exact (often un-canonicalized) path the user
/// opened. When the workspace is reached through a symlink (e.g. the opened path
/// `/data/foo` is a link to `/data-raw-ssd/foo`), those two namespaces diverge.
///
/// rust-analyzer maps files to crates by VFS **path prefix**: if the launch root
/// is `/data-raw-ssd/foo` but a document opens as `file:///data/foo/src/main.rs`,
/// the file falls outside the workspace and gets no crate, so hover/completion/
/// goto/diagnostics all go silent even though the session initialized fine.
///
/// Re-express the scope in the opened path's namespace so the launch root shares
/// a prefix with the document URIs:
/// - scope canonically equals the opened root  → use the opened root verbatim;
/// - scope is a canonical descendant of the opened root (nested subproject) →
///   rebase that suffix onto the opened root;
/// - otherwise (unrelated / no canonical form)  → fall back to the scope as-is.
///
/// The session *key* still uses the canonical `project_scope_path`, so dedup and
/// fingerprinting remain stable regardless of which symlink alias was opened.
fn lsp_session_root(document_root: &Path, project_scope_path: &str) -> PathBuf {
    let scope = PathBuf::from(project_scope_path);
    let canonical_root = canonicalize_or_original(document_root);
    if scope == canonical_root {
        return document_root.to_path_buf();
    }
    if let Ok(suffix) = scope.strip_prefix(&canonical_root) {
        return document_root.join(suffix);
    }
    scope
}

fn canonicalize_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn session_key(
    document: &ResolvedDocument,
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
    sdk_environment: &WorkspaceSdkEnvironment,
) -> LspSessionKey {
    LspSessionKey {
        workspace_id: document.workspace_id.clone(),
        preset_id: preset.id.clone(),
        root_path: sdk_environment.project_scope_path.clone(),
        command_id: command.id.clone(),
        sdk_fingerprint: sdk_environment.fingerprint.clone(),
    }
}

fn lsp_initialization_options(
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
    sdk_environment: &WorkspaceSdkEnvironment,
) -> Value {
    if preset.id == "scala" {
        // Metals emits jar: locations for standard-library/dependency sources
        // only when the client promises it can resolve virtual documents.
        return json!({ "isVirtualDocumentSupported": true });
    }
    if !command_is_jdtls(command) {
        return Value::Null;
    }
    let runtimes: &[JavaRuntimeConfiguration] = &sdk_environment.java_runtimes;
    let java_settings = get_configured_java_settings().to_java_settings(runtimes);
    let mut options = json!({
        "settings": {
            "java": java_settings
        },
        // JDT LS drops every location that resolves into a `.class` file unless the
        // client declares `classFileContentsSupport` (JDTUtils#toUri(IClassFile)
        // returns null otherwise). Without it, Ctrl+click on a JDK or dependency
        // type silently resolves to nothing. It also widens workspace symbol search
        // to application/system libraries and enables decompiled-source lookups.
        "extendedClientCapabilities": {
            "classFileContentsSupport": true
        }
    });
    // Load configured jdtls extension bundles (java-debug / java-test) so
    // debugging + testing become available (M8). Omitted when none are configured.
    // Lombok is NOT here — it loads as a `-javaagent`, not an OSGi bundle.
    let bundles = crate::java_bundles::configured_bundle_jars();
    if !bundles.is_empty() {
        options["bundles"] = json!(bundles);
    }
    options
}

fn server_status(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    active: bool,
    error: Option<String>,
) -> LspServerStatus {
    let command = select_available_command(preset, preferred_command_id, None);
    let binary_available = command.is_some();
    let (runtime_status, runtime_error) = if preset_uses_jdtls(preset, command.as_ref()) {
        jdtls_runtime_probe()
    } else {
        (None, None)
    };
    // jdtls is only "available" when both the wrapper/binary and a suitable
    // JDK are present — otherwise Settings green-dots a broken install.
    let available = if command.as_ref().is_some_and(command_is_jdtls) {
        binary_available && runtime_error.is_none()
    } else {
        binary_available
    };
    let error = error.or_else(|| {
        if command.as_ref().is_some_and(command_is_jdtls) {
            runtime_error
        } else if !binary_available && preset.id == "java" {
            // Binary missing: keep install_hint primary; still surface a short
            // runtime note via runtime_status only.
            None
        } else {
            None
        }
    });
    LspServerStatus {
        preset_id: preset.id.clone(),
        display_name: preset.display_name.clone(),
        document_language_ids: preset.document_language_ids.clone(),
        available,
        active,
        selected_command_id: command.as_ref().map(|cmd| cmd.id.clone()),
        selected_command: command
            .as_ref()
            .map(|cmd| command_line(&cmd.command, &cmd.args)),
        install_hint: primary_install_hint(preset).unwrap_or_default(),
        error,
        runtime_status,
        commands: preset
            .commands
            .iter()
            .map(|cmd| LspServerCommandStatus {
                id: cmd.id.clone(),
                label: cmd.label.clone(),
                command: cmd.command.clone(),
                args: cmd.args.clone(),
                install_hint: cmd.install_hint.clone(),
                fallback: cmd.fallback,
                available: command_available(&cmd.command),
            })
            .collect(),
    }
}

fn primary_install_hint(preset: &LspServerPreset) -> Option<String> {
    preset
        .commands
        .iter()
        .find(|cmd| !cmd.fallback)
        .or_else(|| preset.commands.first())
        .map(|cmd| cmd.install_hint.clone())
}

fn select_available_command(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    if let Some(command) = custom_command_to_preset(custom_command) {
        return command_available(&command.command).then_some(command);
    }
    if let Some(preferred) = preferred_command_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(command) = preset
            .commands
            .iter()
            .find(|cmd| cmd.id == preferred && command_available(&cmd.command))
        {
            return Some(command.clone());
        }
    }
    preset
        .commands
        .iter()
        .find(|cmd| command_available(&cmd.command))
        .cloned()
}

fn configured_command(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    if let Some(command) = custom_command_to_preset(custom_command) {
        return Some(command);
    }
    if let Some(preferred) = preferred_command_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(command) = preset.commands.iter().find(|cmd| cmd.id == preferred) {
            return Some(command.clone());
        }
    }
    preset.commands.first().cloned()
}

fn custom_command_to_preset(
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    let custom = custom_command?;
    let command = custom.command.trim();
    if command.is_empty() {
        return None;
    }
    let args: Vec<String> = custom
        .args
        .iter()
        .map(|arg| arg.trim())
        .filter(|arg| !arg.is_empty())
        .map(ToString::to_string)
        .collect();
    let mut hasher = DefaultHasher::new();
    command.hash(&mut hasher);
    args.hash(&mut hasher);
    let id = format!("custom-{:x}", hasher.finish());
    let label = custom
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("Custom")
        .to_string();
    Some(LspServerCommandPreset {
        id,
        label,
        command: command.to_string(),
        args,
        install_hint: "Check the custom language server command".into(),
        fallback: false,
    })
}

fn command_available(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    let now = Instant::now();
    let mut cache = command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.get(command)
        && now.duration_since(cached.checked_at) < COMMAND_AVAILABILITY_TTL
    {
        return cached.available;
    }
    let available = command_available_uncached(command);
    cache.insert(
        command.to_string(),
        CachedCommandAvailability {
            available,
            checked_at: now,
        },
    );
    available
}

fn command_available_uncached(command: &str) -> bool {
    let path = Path::new(command);
    let resolved = if path.is_absolute() || command.contains('/') || command.contains('\\') {
        if !path.is_file() {
            return false;
        }
        path.to_path_buf()
    } else {
        match which::which(command) {
            Ok(resolved) => resolved,
            Err(_) => return false,
        }
    };
    // A resolved path is not proof the tool runs: rustup installs *proxy shims*
    // into `~/.cargo/bin` when rustup itself is installed, independent of which
    // components exist. `rust-analyzer.exe` is therefore always on PATH, and
    // `which` reports it available even when the component was never added — the
    // shim then fails at spawn with `error: Unknown binary 'rust-analyzer' in
    // official toolchain '…'`. That turned a missing component into a raw stderr
    // string in the editor instead of the `rustup component add` install hint.
    if is_rustup_shim(&resolved) {
        return binary_runs(&resolved);
    }
    true
}

/// Names rustup proxies out of `<cargo home>/bin` that can appear as a language
/// server command. A shim is only distinguishable from a real binary by living
/// next to rustup's own proxy, so require `rustup` as a sibling.
const RUSTUP_SHIMMED_LSP_BINARIES: &[&str] = &["rust-analyzer"];

fn is_rustup_shim(resolved: &Path) -> bool {
    let Some(stem) = resolved.file_stem().and_then(|stem| stem.to_str()) else {
        return false;
    };
    if !RUSTUP_SHIMMED_LSP_BINARIES
        .iter()
        .any(|name| stem.eq_ignore_ascii_case(name))
    {
        return false;
    }
    let Some(parent) = resolved.parent() else {
        return false;
    };
    parent
        .join(format!("rustup{}", std::env::consts::EXE_SUFFIX))
        .is_file()
}

/// Spawn `<binary> --version` to confirm the tool actually starts. Only used for
/// shims, so this costs one short-lived process per [`COMMAND_AVAILABILITY_TTL`]
/// window rather than on every availability query.
fn binary_runs(binary: &Path) -> bool {
    let mut cmd = std::process::Command::new(binary);
    cmd.arg("--version");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().is_ok_and(|status| status.success())
}

fn command_availability_cache() -> &'static StdMutex<HashMap<String, CachedCommandAvailability>> {
    COMMAND_AVAILABILITY_CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn clear_command_availability_cache() {
    command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

fn command_line(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    }
}

fn request_document_uri(params: &Value) -> Option<&str> {
    params
        .pointer("/textDocument/uri")
        .or_else(|| params.pointer("/item/uri"))
        .and_then(Value::as_str)
}

fn take_pending_for_document(
    pending: &mut HashMap<u64, PendingResponse>,
    uri: &str,
) -> Vec<(u64, PendingResponse)> {
    let ids = pending
        .iter()
        .filter_map(|(id, response)| (response.document_uri.as_deref() == Some(uri)).then_some(*id))
        .collect::<Vec<_>>();
    ids.into_iter()
        .filter_map(|id| pending.remove(&id).map(|response| (id, response)))
        .collect()
}

fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()?.try_into().ok()?,
        character: value.get("character")?.as_u64()?.try_into().ok()?,
    })
}

fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}

fn parse_diagnostic(value: &Value) -> Option<LspDiagnostic> {
    Some(LspDiagnostic {
        range: parse_range(value.get("range")?)?,
        severity: value
            .get("severity")
            .and_then(Value::as_u64)
            .and_then(|severity| severity.try_into().ok()),
        code: value.get("code").and_then(|code| {
            code.as_str()
                .map(ToString::to_string)
                .or_else(|| code.as_i64().map(|number| number.to_string()))
        }),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        message: value.get("message")?.as_str()?.to_string(),
        tags: value
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_u64)
                    .filter_map(|tag| u8::try_from(tag).ok())
                    .filter(|tag| matches!(tag, 1 | 2))
                    .collect()
            })
            .unwrap_or_default(),
        related_information: value
            .get("relatedInformation")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(64)
                    .filter_map(|item| {
                        Some(LspDiagnosticRelatedInformation {
                            location: parse_location(item.get("location")?)?,
                            message: item.get("message")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        code_description: value
            .pointer("/codeDescription/href")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        data: value.get("data").and_then(bounded_diagnostic_data),
    })
}

fn bounded_diagnostic_data(value: &Value) -> Option<Value> {
    serde_json::to_vec(value)
        .ok()
        .filter(|encoded| encoded.len() <= 64 * 1024)
        .map(|_| value.clone())
}

fn code_action_context(diagnostics: Vec<Value>, only: Option<Vec<String>>) -> Value {
    let mut context = json!({
        "diagnostics": diagnostics,
        "triggerKind": 1,
    });
    let kinds = only
        .unwrap_or_default()
        .into_iter()
        .map(|kind| kind.trim().to_string())
        .filter(|kind| !kind.is_empty())
        .collect::<Vec<_>>();
    if !kinds.is_empty() {
        context["only"] = json!(kinds);
    }
    context
}

fn hover_contents(value: &Value) -> Option<String> {
    let contents = value.get("contents")?;
    markup_to_string(contents)
}

fn markup_to_string(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(array) = value.as_array() {
        let parts = array
            .iter()
            .filter_map(markup_to_string)
            .collect::<Vec<_>>();
        return if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        };
    }
    if let Some(text) = value.get("value").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("language").and_then(Value::as_str) {
        let value = value.get("value").and_then(Value::as_str).unwrap_or("");
        return Some(format!("```{text}\n{value}\n```"));
    }
    None
}

/// A provider capability may be `true`, an options object, or absent/false.
fn has_provider(capabilities: &Value, key: &str) -> bool {
    match capabilities.get(key) {
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn workspace_diagnostic_provider_options(
    server_capabilities: &Value,
    registrations: &[DynamicCapabilityRegistration],
) -> Option<Value> {
    if let Some(registration) = registrations
        .iter()
        .filter(|registration| registration.method == "workspace/diagnostic")
        .min_by(|left, right| left.id.cmp(&right.id))
    {
        return Some(registration.register_options.clone());
    }
    let provider = server_capabilities.get("diagnosticProvider")?;
    provider
        .get("workspaceDiagnostics")
        .and_then(Value::as_bool)
        .filter(|supported| *supported)
        .map(|_| provider.clone())
}

struct WorkspaceDiagnosticUpdate {
    uri: String,
    diagnostics: Option<Vec<LspDiagnostic>>,
    /// `None` keeps the prior id; `Some(None)` clears it; `Some(Some(id))` replaces it.
    result_id: Option<Option<String>>,
}

fn collect_workspace_diagnostic_document_report(
    uri: &str,
    report: &Value,
    updates: &mut Vec<WorkspaceDiagnosticUpdate>,
) -> Result<(), String> {
    let kind = report.get("kind").and_then(Value::as_str).unwrap_or("full");
    let diagnostics = match kind {
        "full" => {
            let items = report
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    format!("workspace/diagnostic full report for '{uri}' is missing items")
                })?
                .iter()
                .filter_map(parse_diagnostic)
                .collect();
            Some(items)
        }
        "unchanged" => None,
        _ => {
            return Err(format!(
                "workspace/diagnostic returned an unsupported report kind '{kind}'"
            ));
        }
    };
    let result_id = if let Some(result_id) = report.get("resultId").and_then(Value::as_str) {
        Some(Some(result_id.to_string()))
    } else if kind == "full" {
        Some(None)
    } else {
        None
    };
    updates.push(WorkspaceDiagnosticUpdate {
        uri: uri.to_string(),
        diagnostics,
        result_id,
    });

    if let Some(related_documents) = report.get("relatedDocuments").and_then(Value::as_object) {
        for (related_uri, related_report) in related_documents {
            collect_workspace_diagnostic_document_report(related_uri, related_report, updates)?;
        }
    }
    Ok(())
}

/// Combine zero or more `$/progress` partial diagnostic chunks with the final
/// `workspace/diagnostic` response. The protocol permits the server to send
/// partial chunks before the final report; applying them only after validation
/// keeps a malformed final response from partially replacing cached diagnostics.
fn merge_workspace_diagnostic_partial_results(
    mut response: Value,
    partial_items: Vec<Value>,
) -> Result<Value, String> {
    if partial_items.is_empty() {
        return Ok(response);
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| "workspace/diagnostic final response must be an object".to_string())?;
    let final_items = object
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            "workspace/diagnostic final response is missing an items array".to_string()
        })?;
    let mut merged = partial_items;
    merged.append(final_items);
    *final_items = merged;
    Ok(response)
}

fn apply_workspace_diagnostic_report(
    response: &Value,
    diagnostics: &mut HashMap<String, Vec<LspDiagnostic>>,
    result_ids: &mut HashMap<String, String>,
) -> Result<(), String> {
    let items = response
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "workspace/diagnostic response is missing an items array".to_string())?;
    let mut updates = Vec::new();
    for (index, report) in items.iter().enumerate() {
        let uri = report.get("uri").and_then(Value::as_str).ok_or_else(|| {
            format!("workspace/diagnostic item {index} is missing a document URI")
        })?;
        collect_workspace_diagnostic_document_report(uri, report, &mut updates)?;
    }
    if let Some(related_documents) = response.get("relatedDocuments").and_then(Value::as_object) {
        for (related_uri, related_report) in related_documents {
            collect_workspace_diagnostic_document_report(
                related_uri,
                related_report,
                &mut updates,
            )?;
        }
    }
    for update in updates {
        if let Some(next) = update.diagnostics {
            diagnostics.insert(update.uri.clone(), next);
        }
        match update.result_id {
            Some(Some(result_id)) => {
                result_ids.insert(update.uri, result_id);
            }
            Some(None) => {
                result_ids.remove(&update.uri);
            }
            None => {}
        }
    }
    Ok(())
}

fn provider_strings(capabilities: &Value, key: &str, field: &str) -> Vec<String> {
    capabilities
        .get(key)
        .and_then(|provider| provider.get(field))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn file_operation_capability_key(method: &str) -> Option<&'static str> {
    match method {
        "workspace/willCreateFiles" => Some("willCreate"),
        "workspace/didCreateFiles" => Some("didCreate"),
        "workspace/willRenameFiles" => Some("willRename"),
        "workspace/didRenameFiles" => Some("didRename"),
        "workspace/willDeleteFiles" => Some("willDelete"),
        "workspace/didDeleteFiles" => Some("didDelete"),
        _ => None,
    }
}

fn file_operation_filters_from_options(options: &Value) -> Vec<Value> {
    options
        .get("filters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn file_operation_filters_from(
    server_capabilities: &Value,
    registrations: &[DynamicCapabilityRegistration],
    method: &str,
) -> Option<Vec<Value>> {
    let capability_key = file_operation_capability_key(method)?;
    let mut supported = false;
    let mut filters = Vec::new();
    if let Some(options) = server_capabilities
        .get("workspace")
        .and_then(|workspace| workspace.get("fileOperations"))
        .and_then(|operations| operations.get(capability_key))
    {
        supported = true;
        filters.extend(file_operation_filters_from_options(options));
    }
    for registration in registrations
        .iter()
        .filter(|registration| registration.method == method)
    {
        supported = true;
        filters.extend(file_operation_filters_from_options(
            &registration.register_options,
        ));
    }
    supported.then_some(filters)
}

fn file_operation_uri(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(format!(
            "LSP workspace file operation requires an absolute path: {}",
            path.display()
        ));
    }
    url::Url::from_file_path(path)
        .map(|uri| uri.to_string())
        .map_err(|_| format!("Cannot convert path to file URI: {}", path.display()))
}

fn normalized_file_operation_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(not(windows))]
fn relative_file_operation_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(normalized_file_operation_path)
}

#[cfg(windows)]
fn relative_file_operation_path(root: &Path, path: &Path) -> Option<String> {
    let root = normalized_file_operation_path(root);
    let path = normalized_file_operation_path(path);
    let root = root.trim_end_matches('/');
    if path.eq_ignore_ascii_case(root) {
        return Some(String::new());
    }
    let boundary = root.len();
    if path.len() <= boundary
        || !path[..boundary].eq_ignore_ascii_case(root)
        || path.as_bytes().get(boundary) != Some(&b'/')
    {
        return None;
    }
    Some(path[boundary + 1..].to_string())
}

fn file_operation_match_paths(root_uri: &str, uri: &str) -> Option<Vec<String>> {
    let root = url::Url::parse(root_uri).ok()?.to_file_path().ok()?;
    let file_url = url::Url::parse(uri).ok()?;
    if file_url.scheme() != "file" {
        return None;
    }
    let file = file_url.to_file_path().ok()?;
    let relative = relative_file_operation_path(&root, &file)?;
    let absolute = normalized_file_operation_path(&file);
    let mut paths = Vec::new();
    for candidate in [
        relative,
        absolute.clone(),
        absolute.trim_start_matches('/').to_string(),
    ] {
        if !candidate.is_empty() && !paths.contains(&candidate) {
            paths.push(candidate);
        }
    }
    Some(paths)
}

fn notify_change(path: &Path, change_type: u8) -> Option<LspWatchedFileChange> {
    path.is_absolute().then(|| LspWatchedFileChange {
        path: normalized_file_operation_path(path),
        change_type,
    })
}

fn normalized_watch_path_equals(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn normalized_watch_path_is_under(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return path.starts_with('/');
    }
    if normalized_watch_path_equals(root, path.trim_end_matches('/')) {
        return true;
    }
    let boundary = root.len();
    path.len() > boundary
        && path.get(..boundary).is_some_and(|prefix| {
            if cfg!(windows) {
                prefix.eq_ignore_ascii_case(root)
            } else {
                prefix == root
            }
        })
        && path.as_bytes().get(boundary) == Some(&b'/')
}

fn workspace_watch_target_matches(targets: &[WorkspaceWatchTarget], path: &str) -> bool {
    targets.iter().any(|target| {
        let filter = normalized_file_operation_path(&target.filter_path);
        if target.recursive {
            normalized_watch_path_is_under(&filter, path)
        } else {
            normalized_watch_path_equals(filter.trim_end_matches('/'), path.trim_end_matches('/'))
        }
    })
}

fn local_watched_event_suppressed(
    events: &StdMutex<HashMap<(String, String, u8), Instant>>,
    workspace_id: &str,
    path: &str,
    change_type: u8,
    now: Instant,
) -> bool {
    let mut events = events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    events.retain(|_, at| now.duration_since(*at) < Duration::from_secs(3));
    let normalized_path = normalized_file_operation_path(Path::new(path));
    let mut candidates = vec![change_type];
    if change_type == 1 || change_type == 3 {
        candidates.push(2);
    }
    candidates.into_iter().any(|candidate| {
        events
            .remove(&(workspace_id.to_string(), normalized_path.clone(), candidate))
            .is_some_and(|at| now.duration_since(at) < Duration::from_secs(3))
    })
}

fn notify_event_changes(event: &NotifyEvent) -> Vec<LspWatchedFileChange> {
    let mut changes = match event.kind {
        EventKind::Create(_) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 1))
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 3))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            let mut changes = Vec::new();
            if let Some(change) = notify_change(&event.paths[0], 3) {
                changes.push(change);
            }
            if let Some(change) = event.paths.last().and_then(|path| notify_change(path, 1)) {
                changes.push(change);
            }
            changes
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 3))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 1))
            .collect(),
        EventKind::Modify(ModifyKind::Name(_)) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, if path.exists() { 1 } else { 3 }))
            .collect(),
        EventKind::Modify(_) | EventKind::Any => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 2))
            .collect(),
        EventKind::Access(_) | EventKind::Other => Vec::new(),
    };
    let mut seen = HashSet::new();
    changes.retain(|change| seen.insert((change.path.clone(), change.change_type)));
    changes
}

fn watch_kind_for_change(change_type: u8) -> Option<u8> {
    match change_type {
        1 => Some(WATCH_KIND_CREATE),
        2 => Some(WATCH_KIND_CHANGE),
        3 => Some(WATCH_KIND_DELETE),
        _ => None,
    }
}

fn relative_pattern_base_path(pattern: &Value) -> Option<PathBuf> {
    let base = pattern.get("baseUri")?;
    let uri = base
        .as_str()
        .or_else(|| base.get("uri").and_then(Value::as_str))?;
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

fn watched_file_match_paths(
    root_uri: &str,
    uri: &str,
    relative_base: Option<&Path>,
) -> Option<Vec<String>> {
    if let Some(base) = relative_base {
        let file_url = url::Url::parse(uri).ok()?;
        if file_url.scheme() != "file" {
            return None;
        }
        let file = file_url.to_file_path().ok()?;
        let relative = relative_file_operation_path(base, &file)?;
        let absolute = normalized_file_operation_path(&file);
        let mut paths = vec![relative];
        if !absolute.is_empty() && !paths.contains(&absolute) {
            paths.push(absolute.clone());
        }
        let trimmed = absolute.trim_start_matches('/').to_string();
        if !trimmed.is_empty() && !paths.contains(&trimmed) {
            paths.push(trimmed);
        }
        return Some(paths);
    }
    file_operation_match_paths(root_uri, uri)
}

fn watched_file_glob_matches(
    root_uri: &str,
    uri: &str,
    glob_pattern: &str,
    relative_base: Option<&Path>,
) -> bool {
    let glob_pattern = glob_pattern.replace('\\', "/");
    let matcher = match GlobBuilder::new(&glob_pattern)
        .case_insensitive(cfg!(windows))
        .literal_separator(true)
        .build()
    {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => {
            log::warn!("ignoring invalid LSP watched-file glob '{glob_pattern}': {error}");
            return false;
        }
    };
    watched_file_match_paths(root_uri, uri, relative_base)
        .is_some_and(|paths| paths.iter().any(|path| matcher.is_match(path)))
}

fn watched_file_registration_matches(
    registration: &DynamicCapabilityRegistration,
    root_uri: &str,
    uri: &str,
    watch_kind: u8,
) -> bool {
    let watchers = registration
        .register_options
        .get("watchers")
        .and_then(Value::as_array);
    let Some(watchers) = watchers else {
        return false;
    };
    watchers.iter().any(|watcher| {
        let Some(glob_pattern) = watcher.get("globPattern") else {
            return false;
        };
        let kind = watcher
            .get("kind")
            .and_then(Value::as_u64)
            .unwrap_or(u64::from(WATCH_KIND_ALL));
        if kind > u64::from(WATCH_KIND_ALL) || (kind as u8 & watch_kind) == 0 {
            return false;
        }
        match glob_pattern {
            Value::String(glob) => watched_file_glob_matches(root_uri, uri, glob, None),
            Value::Object(pattern) => {
                let Some(glob) = pattern.get("pattern").and_then(Value::as_str) else {
                    return false;
                };
                let relative_base = relative_pattern_base_path(&json!(pattern));
                watched_file_glob_matches(root_uri, uri, glob, relative_base.as_deref())
            }
            _ => false,
        }
    })
}

fn file_operation_filter_matches(
    filter: &Value,
    root_uri: &str,
    uri: &str,
    is_directory: bool,
) -> bool {
    let Ok(uri_value) = url::Url::parse(uri) else {
        return false;
    };
    if let Some(scheme) = filter.get("scheme").and_then(Value::as_str)
        && !uri_value.scheme().eq_ignore_ascii_case(scheme)
    {
        return false;
    }
    let Some(pattern) = filter.get("pattern") else {
        return false;
    };
    match pattern.get("matches").and_then(Value::as_str) {
        Some("file") if is_directory => return false,
        Some("folder") if !is_directory => return false,
        Some("file" | "folder") | None => {}
        Some(_) => return false,
    }
    let Some(glob) = pattern.get("glob").and_then(Value::as_str) else {
        return false;
    };
    let ignore_case = pattern
        .get("options")
        .and_then(|options| options.get("ignoreCase"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let matcher = match GlobBuilder::new(glob)
        .case_insensitive(ignore_case)
        .literal_separator(true)
        .build()
    {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => {
            log::warn!("ignoring invalid LSP file operation glob '{glob}': {error}");
            return false;
        }
    };
    file_operation_match_paths(root_uri, uri)
        .is_some_and(|paths| paths.iter().any(|path| matcher.is_match(path)))
}

fn file_operation_matches_filters(
    filters: &[Value],
    root_uri: &str,
    uri: &str,
    is_directory: bool,
) -> bool {
    filters
        .iter()
        .any(|filter| file_operation_filter_matches(filter, root_uri, uri, is_directory))
}

fn workspace_file_operation_params(
    root_uri: &str,
    operation: &LspWorkspaceFileOperation,
    filters: &[Value],
) -> Result<Option<Value>, String> {
    let files = match operation {
        LspWorkspaceFileOperation::Create { files }
        | LspWorkspaceFileOperation::Delete { files } => files
            .iter()
            .map(|file| {
                let uri = file_operation_uri(&file.path)?;
                Ok(
                    file_operation_matches_filters(filters, root_uri, &uri, file.is_directory)
                        .then(|| json!({ "uri": uri })),
                )
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
        LspWorkspaceFileOperation::Rename { files } => files
            .iter()
            .map(|file| {
                let old_uri = file_operation_uri(&file.old_path)?;
                let new_uri = file_operation_uri(&file.new_path)?;
                let matches =
                    file_operation_matches_filters(filters, root_uri, &old_uri, file.is_directory)
                        || file_operation_matches_filters(
                            filters,
                            root_uri,
                            &new_uri,
                            file.is_directory,
                        );
                Ok(matches.then(|| json!({ "oldUri": old_uri, "newUri": new_uri })))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
    };
    Ok((!files.is_empty()).then(|| json!({ "files": files })))
}

fn capability_summary_from(capabilities: &Value) -> LspCapabilitySummary {
    LspCapabilitySummary {
        text_document_sync_kind: text_document_sync_kind(capabilities),
        completion: has_provider(capabilities, "completionProvider"),
        signature_help: has_provider(capabilities, "signatureHelpProvider"),
        hover: has_provider(capabilities, "hoverProvider"),
        definition: has_provider(capabilities, "definitionProvider"),
        type_definition: has_provider(capabilities, "typeDefinitionProvider"),
        implementation: has_provider(capabilities, "implementationProvider"),
        references: has_provider(capabilities, "referencesProvider"),
        document_symbol: has_provider(capabilities, "documentSymbolProvider"),
        workspace_symbol: has_provider(capabilities, "workspaceSymbolProvider"),
        workspace_symbol_resolve: capabilities
            .get("workspaceSymbolProvider")
            .and_then(|provider| provider.get("resolveProvider"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        rename: has_provider(capabilities, "renameProvider"),
        formatting: has_provider(capabilities, "documentFormattingProvider"),
        range_formatting: has_provider(capabilities, "documentRangeFormattingProvider"),
        code_action: has_provider(capabilities, "codeActionProvider"),
        document_highlight: has_provider(capabilities, "documentHighlightProvider"),
        call_hierarchy: has_provider(capabilities, "callHierarchyProvider"),
        type_hierarchy: has_provider(capabilities, "typeHierarchyProvider"),
        inlay_hint: has_provider(capabilities, "inlayHintProvider"),
        selection_range: has_provider(capabilities, "selectionRangeProvider"),
        semantic_tokens: has_provider(capabilities, "semanticTokensProvider"),
        workspace_diagnostics: workspace_diagnostic_provider_options(capabilities, &[]).is_some(),
        code_action_kinds: provider_strings(capabilities, "codeActionProvider", "codeActionKinds"),
        completion_trigger_characters: provider_strings(
            capabilities,
            "completionProvider",
            "triggerCharacters",
        ),
        signature_trigger_characters: provider_strings(
            capabilities,
            "signatureHelpProvider",
            "triggerCharacters",
        ),
    }
}

fn parse_dynamic_capability_registrations(
    params: Option<&Value>,
) -> Vec<DynamicCapabilityRegistration> {
    params
        .and_then(|value| value.get("registrations"))
        .and_then(Value::as_array)
        .map(|registrations| {
            registrations
                .iter()
                .filter_map(|registration| {
                    Some(DynamicCapabilityRegistration {
                        id: registration.get("id")?.as_str()?.to_string(),
                        method: registration.get("method")?.as_str()?.to_string(),
                        register_options: registration
                            .get("registerOptions")
                            .cloned()
                            .unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Strict parser used for the JSON-RPC `client/registerCapability` request.
///
/// The permissive parser above is intentionally useful when reconstructing a
/// capability snapshot from server data, but a request must distinguish a
/// valid empty registration list from malformed parameters. Silently dropping
/// malformed entries leaves the server waiting on a capability it believes we
/// registered, so return `-32602` instead.
fn parse_dynamic_capability_registrations_checked(
    params: Option<&Value>,
) -> Result<Vec<DynamicCapabilityRegistration>, String> {
    let params = params.ok_or_else(|| "client/registerCapability requires params".to_string())?;
    let registrations = params
        .get("registrations")
        .and_then(Value::as_array)
        .ok_or_else(|| "client/registerCapability requires a registrations array".to_string())?;
    registrations
        .iter()
        .enumerate()
        .map(|(index, registration)| {
            let object = registration.as_object().ok_or_else(|| {
                format!("client/registerCapability registration {index} must be an object")
            })?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    format!("client/registerCapability registration {index} has an invalid id")
                })?;
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|method| !method.is_empty())
                .ok_or_else(|| {
                    format!("client/registerCapability registration {index} has an invalid method")
                })?;
            Ok(DynamicCapabilityRegistration {
                id: id.to_string(),
                method: method.to_string(),
                register_options: object
                    .get("registerOptions")
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn parse_dynamic_capability_unregistrations(params: Option<&Value>) -> Vec<String> {
    params
        .and_then(|value| {
            value
                .get("unregisterations")
                .or_else(|| value.get("unregistrations"))
        })
        .and_then(Value::as_array)
        .map(|registrations| {
            registrations
                .iter()
                .filter_map(|registration| registration.get("id").and_then(Value::as_str))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_dynamic_capability_unregistrations_checked(
    params: Option<&Value>,
) -> Result<Vec<String>, String> {
    let params = params.ok_or_else(|| "client/unregisterCapability requires params".to_string())?;
    let registrations = params
        .get("unregisterations")
        .or_else(|| params.get("unregistrations"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "client/unregisterCapability requires an unregisterations array".to_string()
        })?;
    registrations
        .iter()
        .enumerate()
        .map(|(index, registration)| {
            let id = registration
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    format!("client/unregisterCapability registration {index} has an invalid id")
                })?;
            Ok(id.to_string())
        })
        .collect()
}

fn option_strings(options: &Value, field: &str) -> Vec<String> {
    options
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn extend_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

fn apply_dynamic_capability(
    summary: &mut LspCapabilitySummary,
    registration: &DynamicCapabilityRegistration,
) {
    match registration.method.as_str() {
        "textDocument/completion" => {
            summary.completion = true;
            extend_unique(
                &mut summary.completion_trigger_characters,
                option_strings(&registration.register_options, "triggerCharacters"),
            );
        }
        "textDocument/signatureHelp" => {
            summary.signature_help = true;
            extend_unique(
                &mut summary.signature_trigger_characters,
                option_strings(&registration.register_options, "triggerCharacters"),
            );
        }
        "textDocument/hover" => summary.hover = true,
        "textDocument/definition" => summary.definition = true,
        "textDocument/typeDefinition" => summary.type_definition = true,
        "textDocument/implementation" => summary.implementation = true,
        "textDocument/references" => summary.references = true,
        "textDocument/documentSymbol" => summary.document_symbol = true,
        "workspace/symbol" => {
            summary.workspace_symbol = true;
            summary.workspace_symbol_resolve |= registration
                .register_options
                .get("resolveProvider")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
        "textDocument/rename" => summary.rename = true,
        "textDocument/formatting" => summary.formatting = true,
        "textDocument/rangeFormatting" => summary.range_formatting = true,
        "textDocument/codeAction" => {
            summary.code_action = true;
            extend_unique(
                &mut summary.code_action_kinds,
                option_strings(&registration.register_options, "codeActionKinds"),
            );
        }
        "textDocument/documentHighlight" => summary.document_highlight = true,
        "textDocument/prepareCallHierarchy" => summary.call_hierarchy = true,
        "textDocument/prepareTypeHierarchy" => summary.type_hierarchy = true,
        "textDocument/inlayHint" => summary.inlay_hint = true,
        "textDocument/selectionRange" => summary.selection_range = true,
        "textDocument/semanticTokens" => summary.semantic_tokens = true,
        "workspace/diagnostic" => summary.workspace_diagnostics = true,
        "textDocument/didChange" => {
            summary.text_document_sync_kind = registration
                .register_options
                .get("syncKind")
                .and_then(Value::as_u64)
                .map(|kind| {
                    if kind == 2 {
                        2
                    } else if kind == 0 {
                        0
                    } else {
                        1
                    }
                })
                .unwrap_or(1);
        }
        _ => {}
    }
}

fn capability_state_from(
    server_capabilities: &Value,
    registrations: &[DynamicCapabilityRegistration],
) -> (LspCapabilitySummary, Vec<String>, Vec<String>, bool) {
    let mut summary = capability_summary_from(server_capabilities);
    let mut semantic_provider = None;
    for registration in registrations {
        apply_dynamic_capability(&mut summary, registration);
        if registration.method == "textDocument/semanticTokens" {
            semantic_provider = Some(registration.register_options.clone());
        }
    }
    let semantic_capabilities = semantic_provider
        .map(|provider| json!({ "semanticTokensProvider": provider }))
        .unwrap_or_else(|| server_capabilities.clone());
    let (token_types, token_modifiers) = semantic_token_legend_from(&semantic_capabilities);
    let semantic_delta = semantic_token_delta_supported(&semantic_capabilities);
    (summary, token_types, token_modifiers, semantic_delta)
}

fn text_document_sync_kind(capabilities: &Value) -> u8 {
    let sync = capabilities.get("textDocumentSync");
    let kind = match sync {
        Some(Value::Number(value)) => value.as_u64(),
        Some(Value::Object(options)) => options.get("change").and_then(Value::as_u64),
        _ => None,
    };
    match kind {
        Some(2) => 2,
        Some(0) => 0,
        _ => 1,
    }
}

fn content_change_for_sync(
    full_text: Option<String>,
    incremental: Option<LspDocumentContentChange>,
    sync_kind: u8,
) -> Result<Value, String> {
    if sync_kind == 2
        && let Some(change) = incremental
    {
        return Ok(json!(change));
    }
    full_text
        .map(|text| json!({ "text": text }))
        .ok_or_else(|| "LSP server requires full document synchronization".into())
}

fn parse_text_edit(value: &Value) -> Option<LspTextEdit> {
    let new_text = value.get("newText")?.as_str()?.to_string();
    // Plain TextEdit carries `range`; InsertReplaceEdit carries
    // `insert`/`replace` ranges — prefer the insert range.
    let range = value
        .get("range")
        .or_else(|| value.get("insert"))
        .or_else(|| value.get("replace"))
        .and_then(parse_range)?;
    Some(LspTextEdit { range, new_text })
}

fn parse_text_edits(value: &Value) -> Vec<LspTextEdit> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_text_edit).collect())
        .unwrap_or_default()
}

fn text_edit_annotation_ids(value: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(edits) = value.as_array() {
        for id in edits
            .iter()
            .filter_map(|edit| edit.get("annotationId").and_then(Value::as_str))
        {
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

fn parse_change_annotations(value: &Value) -> Vec<LspChangeAnnotation> {
    let mut annotations = value
        .get("changeAnnotations")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(id, annotation)| {
                    Some(LspChangeAnnotation {
                        id: id.clone(),
                        label: annotation.get("label")?.as_str()?.to_string(),
                        needs_confirmation: annotation
                            .get("needsConfirmation")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        description: annotation
                            .get("description")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    annotations.sort_by(|left, right| left.id.cmp(&right.id));
    annotations
}

fn parse_workspace_edit(value: &Value) -> LspWorkspaceEdit {
    let mut document_edits: Vec<LspFileTextEdits> = Vec::new();
    let mut operations: Vec<LspWorkspaceEditOperation> = Vec::new();
    if let Some(changes) = value.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            let document = LspFileTextEdits {
                uri: uri.clone(),
                path: path_from_uri(uri),
                version: None,
                edits: parse_text_edits(edits),
                annotation_ids: text_edit_annotation_ids(edits),
            };
            document_edits.push(document.clone());
            operations.push(LspWorkspaceEditOperation::Text { document });
        }
    }
    if let Some(document_changes) = value.get("documentChanges").and_then(Value::as_array) {
        for change in document_changes {
            let annotation_id = change
                .get("annotationId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let options = change.get("options").unwrap_or(&Value::Null);
            match change.get("kind").and_then(Value::as_str) {
                Some("create") => {
                    let Some(uri) = change.get("uri").and_then(Value::as_str) else {
                        continue;
                    };
                    operations.push(LspWorkspaceEditOperation::Create {
                        uri: uri.to_string(),
                        path: path_from_uri(uri),
                        overwrite: options
                            .get("overwrite")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        ignore_if_exists: options
                            .get("ignoreIfExists")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        annotation_id,
                    });
                }
                Some("rename") => {
                    let Some(old_uri) = change.get("oldUri").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(new_uri) = change.get("newUri").and_then(Value::as_str) else {
                        continue;
                    };
                    operations.push(LspWorkspaceEditOperation::Rename {
                        old_uri: old_uri.to_string(),
                        old_path: path_from_uri(old_uri),
                        new_uri: new_uri.to_string(),
                        new_path: path_from_uri(new_uri),
                        overwrite: options
                            .get("overwrite")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        ignore_if_exists: options
                            .get("ignoreIfExists")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        annotation_id,
                    });
                }
                Some("delete") => {
                    let Some(uri) = change.get("uri").and_then(Value::as_str) else {
                        continue;
                    };
                    operations.push(LspWorkspaceEditOperation::Delete {
                        uri: uri.to_string(),
                        path: path_from_uri(uri),
                        recursive: options
                            .get("recursive")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        ignore_if_not_exists: options
                            .get("ignoreIfNotExists")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        annotation_id,
                    });
                }
                _ => {
                    let Some(uri) = change
                        .get("textDocument")
                        .and_then(|doc| doc.get("uri"))
                        .and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let document = LspFileTextEdits {
                        uri: uri.to_string(),
                        path: path_from_uri(uri),
                        version: change
                            .get("textDocument")
                            .and_then(|document| document.get("version"))
                            .and_then(Value::as_i64),
                        edits: change
                            .get("edits")
                            .map(parse_text_edits)
                            .unwrap_or_default(),
                        annotation_ids: change
                            .get("edits")
                            .map(text_edit_annotation_ids)
                            .unwrap_or_default(),
                    };
                    if let Some(existing) = document_edits
                        .iter_mut()
                        .find(|item| item.uri == document.uri)
                    {
                        existing.edits.extend(document.edits.clone());
                        extend_unique(
                            &mut existing.annotation_ids,
                            document.annotation_ids.clone(),
                        );
                    } else {
                        document_edits.push(document.clone());
                    }
                    operations.push(LspWorkspaceEditOperation::Text { document });
                }
            }
        }
    }
    LspWorkspaceEdit {
        document_edits,
        operations,
        change_annotations: parse_change_annotations(value),
    }
}

fn merge_code_action_values(original: &Value, resolved: &Value) -> Value {
    let Some(original_object) = original.as_object() else {
        return resolved.clone();
    };
    let Some(resolved_object) = resolved.as_object() else {
        return original.clone();
    };
    let mut merged = original_object.clone();
    for (key, value) in resolved_object {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

fn parse_code_action(value: &Value) -> Option<LspCodeAction> {
    // Command-only entries appear as { title, command, arguments }.
    // Full CodeAction has title + optional edit/command/kind.
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())?
        .to_string();
    let command = value.get("command").and_then(|command| {
        if let Some(name) = command.as_str() {
            Some(name.to_string())
        } else {
            command
                .get("command")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }
    });
    let command_arguments = value
        .get("command")
        .and_then(|command| command.get("arguments"))
        .cloned()
        .or_else(|| value.get("arguments").cloned());
    let edit = value.get("edit").map(parse_workspace_edit);
    Some(LspCodeAction {
        title,
        kind: value
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        is_preferred: value
            .get("isPreferred")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        edit,
        command,
        command_arguments,
        raw: value.clone(),
    })
}

fn parse_code_actions(value: &Value) -> Vec<LspCodeAction> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_code_action).collect())
        .unwrap_or_default()
}

fn parse_workspace_symbol(value: &Value) -> Option<LspWorkspaceSymbol> {
    let name = value.get("name")?.as_str()?.to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_u64)
        .and_then(|kind| u32::try_from(kind).ok())
        .unwrap_or(0);
    // SymbolInformation: location.uri + location.range
    // WorkspaceSymbol (3.17): location may be { uri } only; range optional.
    let (uri, range, resolved) = if let Some(location) = value.get("location") {
        let uri = location.get("uri").and_then(Value::as_str)?;
        let parsed_range = location
            .get("range")
            .and_then(parse_range)
            .or_else(|| value.get("range").and_then(parse_range));
        let resolved = parsed_range.is_some();
        let range = parsed_range.unwrap_or(LspRange {
            start: LspPosition {
                line: 0,
                character: 0,
            },
            end: LspPosition {
                line: 0,
                character: 0,
            },
        });
        (uri.to_string(), range, resolved)
    } else {
        return None;
    };
    let selection_range = value
        .get("selectionRange")
        .and_then(parse_range)
        .unwrap_or_else(|| range.clone());
    let path = path_from_uri(&uri);
    Some(LspWorkspaceSymbol {
        name,
        kind,
        container_name: value
            .get("containerName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string),
        uri,
        path,
        range,
        selection_range,
        resolved,
        resolve_token: None,
        raw: None,
        provider_session_key: None,
    })
}

fn parse_workspace_symbols(value: &Value) -> Vec<LspWorkspaceSymbol> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_workspace_symbol).collect())
        .unwrap_or_default()
}

fn parse_completion_item(value: &Value) -> Option<LspCompletionItem> {
    let label = value.get("label")?.as_str()?.to_string();
    Some(LspCompletionItem {
        label,
        kind: value
            .get("kind")
            .and_then(Value::as_u64)
            .and_then(|kind| u32::try_from(kind).ok()),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        documentation: value.get("documentation").and_then(markup_to_string),
        insert_text: value
            .get("insertText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        insert_text_format: value
            .get("insertTextFormat")
            .and_then(Value::as_u64)
            .and_then(|format| u32::try_from(format).ok()),
        filter_text: value
            .get("filterText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sort_text: value
            .get("sortText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        text_edit: value.get("textEdit").and_then(parse_text_edit),
        additional_text_edits: value
            .get("additionalTextEdits")
            .and_then(Value::as_array)
            .map(|edits| edits.iter().filter_map(parse_text_edit).collect())
            .unwrap_or_default(),
        raw: value.clone(),
    })
}

/// Completion responses are either a bare `CompletionItem[]` or a
/// `CompletionList { isIncomplete, items }`.
fn parse_completion_response(value: &Value) -> (bool, Vec<LspCompletionItem>) {
    if let Some(items) = value.as_array() {
        return (
            false,
            items.iter().filter_map(parse_completion_item).collect(),
        );
    }
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        let is_incomplete = value
            .get("isIncomplete")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return (
            is_incomplete,
            items.iter().filter_map(parse_completion_item).collect(),
        );
    }
    (false, Vec::new())
}

fn parse_signature_parameter(
    value: &Value,
    signature_label: &str,
) -> Option<LspSignatureParameter> {
    let documentation = value.get("documentation").and_then(markup_to_string);
    match value.get("label") {
        Some(Value::String(label)) => Some(LspSignatureParameter {
            label: label.clone(),
            documentation,
            label_start: None,
            label_end: None,
        }),
        Some(Value::Array(offsets)) => {
            let start = offsets.first().and_then(Value::as_u64)?;
            let end = offsets.get(1).and_then(Value::as_u64)?;
            let label: String = signature_label
                .chars()
                .skip(usize::try_from(start).ok()?)
                .take(usize::try_from(end.saturating_sub(start)).ok()?)
                .collect();
            Some(LspSignatureParameter {
                label,
                documentation,
                label_start: u32::try_from(start).ok(),
                label_end: u32::try_from(end).ok(),
            })
        }
        _ => None,
    }
}

fn parse_signature_help(value: &Value) -> (Vec<LspSignatureInfo>, u32, u32) {
    let signatures = value
        .get("signatures")
        .and_then(Value::as_array)
        .map(|signatures| {
            signatures
                .iter()
                .filter_map(|signature| {
                    let label = signature.get("label")?.as_str()?.to_string();
                    let parameters = signature
                        .get("parameters")
                        .and_then(Value::as_array)
                        .map(|parameters| {
                            parameters
                                .iter()
                                .filter_map(|parameter| {
                                    parse_signature_parameter(parameter, &label)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(LspSignatureInfo {
                        documentation: signature.get("documentation").and_then(markup_to_string),
                        parameters,
                        active_parameter: signature
                            .get("activeParameter")
                            .and_then(Value::as_u64)
                            .and_then(|active| u32::try_from(active).ok()),
                        label,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let active_signature = value
        .get("activeSignature")
        .and_then(Value::as_u64)
        .and_then(|active| u32::try_from(active).ok())
        .unwrap_or(0);
    let active_parameter = value
        .get("activeParameter")
        .and_then(Value::as_u64)
        .and_then(|active| u32::try_from(active).ok())
        .unwrap_or(0);
    (signatures, active_signature, active_parameter)
}

/// Flattens a `textDocument/documentSymbol` response. Servers reply with
/// either hierarchical `DocumentSymbol[]` (has `selectionRange`/`children`)
/// or flat `SymbolInformation[]` (has `location`); both collapse into the
/// same depth-annotated list.
fn collect_document_symbols(value: &Value, depth: u32, out: &mut Vec<LspDocumentSymbol>) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let kind = item
            .get("kind")
            .and_then(Value::as_u64)
            .and_then(|kind| u32::try_from(kind).ok())
            .unwrap_or(0);
        if item.get("selectionRange").is_some() {
            let Some(range) = item.get("range").and_then(parse_range) else {
                continue;
            };
            let Some(selection_range) = item.get("selectionRange").and_then(parse_range) else {
                continue;
            };
            out.push(LspDocumentSymbol {
                name: name.to_string(),
                detail: item
                    .get("detail")
                    .and_then(Value::as_str)
                    .filter(|detail| !detail.is_empty())
                    .map(ToString::to_string),
                kind,
                depth,
                range,
                selection_range,
            });
            if let Some(children) = item.get("children") {
                collect_document_symbols(children, depth + 1, out);
            }
        } else if let Some(location) = item.get("location") {
            let Some(range) = location.get("range").and_then(parse_range) else {
                continue;
            };
            out.push(LspDocumentSymbol {
                name: name.to_string(),
                detail: item
                    .get("containerName")
                    .and_then(Value::as_str)
                    .filter(|container| !container.is_empty())
                    .map(ToString::to_string),
                kind,
                depth,
                range: range.clone(),
                selection_range: range,
            });
        }
    }
}

fn parse_locations(value: &Value) -> Vec<LspLocation> {
    if value.is_null() {
        return Vec::new();
    }
    if let Some(array) = value.as_array() {
        return array.iter().filter_map(parse_location).collect();
    }
    parse_location(value).into_iter().collect()
}

fn parse_hierarchy_item(value: &Value) -> Option<LspHierarchyItem> {
    let uri = value.get("uri")?.as_str()?.to_string();
    Some(LspHierarchyItem {
        name: value.get("name")?.as_str()?.to_string(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        kind: value.get("kind")?.as_u64()?.try_into().ok()?,
        path: path_from_uri(&uri),
        uri,
        range: value.get("range").and_then(parse_range)?,
        selection_range: value.get("selectionRange").and_then(parse_range)?,
        raw: value.clone(),
    })
}

fn parse_hierarchy_items(value: &Value) -> Vec<LspHierarchyItem> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_hierarchy_item).collect())
        .unwrap_or_default()
}

fn parse_call_hierarchy_entries(value: &Value, item_key: &str) -> Vec<LspCallHierarchyEntry> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let item = entry.get(item_key).and_then(parse_hierarchy_item)?;
                    let from_ranges = entry
                        .get("fromRanges")
                        .and_then(Value::as_array)
                        .map(|ranges| ranges.iter().filter_map(parse_range).collect())
                        .unwrap_or_default();
                    Some(LspCallHierarchyEntry { item, from_ranges })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_document_highlights(value: &Value) -> Vec<LspDocumentHighlight> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(LspDocumentHighlight {
                        range: item.get("range").and_then(parse_range)?,
                        kind: item
                            .get("kind")
                            .and_then(Value::as_u64)
                            .and_then(|kind| kind.try_into().ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn inlay_hint_label(value: &Value) -> Option<String> {
    if let Some(label) = value.as_str() {
        return Some(label.to_string());
    }
    let parts = value.as_array()?.iter().filter_map(|part| {
        part.get("value")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    });
    let label = parts.collect::<String>();
    (!label.is_empty()).then_some(label)
}

fn parse_inlay_hints(value: &Value) -> Vec<LspInlayHint> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(LspInlayHint {
                        position: item.get("position").and_then(parse_position)?,
                        label: item.get("label").and_then(inlay_hint_label)?,
                        kind: item
                            .get("kind")
                            .and_then(Value::as_u64)
                            .and_then(|kind| kind.try_into().ok()),
                        tooltip: item.get("tooltip").and_then(markup_to_string),
                        padding_left: item
                            .get("paddingLeft")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        padding_right: item
                            .get("paddingRight")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_selection_ranges(value: &Value) -> Vec<LspRange> {
    let Some(mut current) = value.as_array().and_then(|items| items.first()) else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    for _ in 0..64 {
        let Some(range) = current.get("range").and_then(parse_range) else {
            break;
        };
        ranges.push(range);
        let Some(parent) = current.get("parent").filter(|parent| parent.is_object()) else {
            break;
        };
        current = parent;
    }
    ranges
}

fn semantic_token_legend_from(capabilities: &Value) -> (Vec<String>, Vec<String>) {
    let legend = capabilities
        .get("semanticTokensProvider")
        .and_then(|provider| {
            if provider.is_object() {
                provider.get("legend")
            } else {
                None
            }
        });
    let token_types = legend
        .and_then(|legend| legend.get("tokenTypes"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                "namespace",
                "type",
                "class",
                "enum",
                "interface",
                "struct",
                "typeParameter",
                "parameter",
                "variable",
                "property",
                "enumMember",
                "event",
                "function",
                "method",
                "macro",
                "keyword",
                "modifier",
                "comment",
                "string",
                "number",
                "regexp",
                "operator",
                "decorator",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        });
    let token_modifiers = legend
        .and_then(|legend| legend.get("tokenModifiers"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                "declaration",
                "definition",
                "readonly",
                "static",
                "deprecated",
                "abstract",
                "async",
                "modification",
                "documentation",
                "defaultLibrary",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        });
    (token_types, token_modifiers)
}

fn semantic_token_delta_supported(capabilities: &Value) -> bool {
    capabilities
        .get("semanticTokensProvider")
        .and_then(|provider| provider.get("full"))
        .and_then(|full| full.get("delta"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn semantic_token_data_from_response(value: &Value) -> Option<(Vec<u64>, Option<String>)> {
    let (data, result_id) = if let Some(data) = value.get("data").and_then(Value::as_array) {
        (
            data.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()?,
            value
                .get("resultId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        )
    } else if let Some(data) = value.as_array() {
        (
            data.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()?,
            None,
        )
    } else {
        return None;
    };
    (data.len() % 5 == 0).then_some((data, result_id))
}

fn apply_semantic_token_delta(
    previous: &SemanticTokensCache,
    value: &Value,
) -> Option<(Vec<u64>, Option<String>)> {
    let edits = value.get("edits")?.as_array()?;
    let mut parsed = edits
        .iter()
        .map(|edit| {
            let start = usize::try_from(edit.get("start")?.as_u64()?).ok()?;
            let delete_count = usize::try_from(edit.get("deleteCount")?.as_u64()?).ok()?;
            let data = match edit.get("data") {
                Some(value) => value
                    .as_array()?
                    .iter()
                    .map(Value::as_u64)
                    .collect::<Option<Vec<_>>>()?,
                None => Vec::new(),
            };
            Some((start, delete_count, data))
        })
        .collect::<Option<Vec<_>>>()?;
    parsed.sort_by(|left, right| right.0.cmp(&left.0));
    let mut data = previous.data.clone();
    for (start, delete_count, inserted) in parsed {
        let end = start.checked_add(delete_count)?;
        if start > data.len() || end > data.len() {
            return None;
        }
        data.splice(start..end, inserted);
    }
    if data.len() % 5 != 0 {
        return None;
    }
    let result_id = value
        .get("resultId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| Some(previous.result_id.clone()));
    Some((data, result_id))
}

fn decode_semantic_token_data(
    data: &[u64],
    token_types: &[String],
    token_modifiers: &[String],
) -> Vec<LspSemanticToken> {
    let mut tokens = Vec::new();
    let mut line = 0u32;
    let mut character = 0u32;
    for chunk in data.chunks_exact(5) {
        let delta_line = chunk[0] as u32;
        let delta_start = chunk[1] as u32;
        let length = chunk[2] as u32;
        let type_index = chunk[3] as usize;
        let modifier_bits = chunk[4];
        if delta_line == 0 {
            character = character.saturating_add(delta_start);
        } else {
            line = line.saturating_add(delta_line);
            character = delta_start;
        }
        let token_type = token_types
            .get(type_index)
            .cloned()
            .unwrap_or_else(|| format!("unknown:{type_index}"));
        let mut modifiers = Vec::new();
        for (index, name) in token_modifiers.iter().enumerate() {
            if (modifier_bits >> index) & 1 == 1 {
                modifiers.push(name.clone());
            }
        }
        let end_character = character.saturating_add(length);
        tokens.push(LspSemanticToken {
            range: LspRange {
                start: LspPosition { line, character },
                end: LspPosition {
                    line,
                    character: end_character,
                },
            },
            token_type,
            modifiers,
        });
    }
    tokens
}

fn parse_semantic_tokens(
    value: &Value,
    token_types: &[String],
    token_modifiers: &[String],
) -> Vec<LspSemanticToken> {
    semantic_token_data_from_response(value)
        .map(|(data, _)| decode_semantic_token_data(&data, token_types, token_modifiers))
        .unwrap_or_default()
}

fn parse_location(value: &Value) -> Option<LspLocation> {
    let (uri, range) = if let Some(uri) = value.get("uri").and_then(Value::as_str) {
        (uri, parse_range(value.get("range")?)?)
    } else {
        let uri = value.get("targetUri").and_then(Value::as_str)?;
        let range = value
            .get("targetSelectionRange")
            .or_else(|| value.get("targetRange"))
            .and_then(parse_range)?;
        (uri, range)
    };
    Some(LspLocation {
        uri: uri.to_string(),
        path: path_from_uri(uri),
        range,
    })
}

fn path_from_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return None;
    }

    // jar:file:///path/to.jar!/com/Foo.class — not a plain filesystem path.
    // Open via java/classFileContents (or fail for non-Java servers).
    if trimmed.to_ascii_lowercase().starts_with("jar:file:") {
        return None;
    }

    if trimmed.starts_with("file:") {
        return path_from_file_uri(trimmed);
    }

    // Some servers emit raw absolute paths instead of file:// URIs.
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Some(normalize_os_path_string(trimmed.to_string()));
    }
    None
}

fn path_from_file_uri(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .map(|path| normalize_os_path_string(path.to_string_lossy().into_owned()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArchiveDocumentUri {
    archive_path: PathBuf,
    entry_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArchiveSourceContents {
    text: String,
    title: String,
    container: Option<String>,
    language_id: String,
}

/// Parse the archive URI shapes emitted by Metals and Kotlin language servers:
/// `jar:file:///.../sources.jar!/pkg/Foo.scala`, `jar:///...`, and
/// `kls:file:///.../library.jar!/pkg/Foo.kt?source=true`.
fn archive_document_uri(uri: &str) -> Option<ArchiveDocumentUri> {
    let trimmed = uri.trim();
    let scheme_end = trimmed.find(':')?;
    let scheme = trimmed[..scheme_end].to_ascii_lowercase();
    if scheme != "jar" && scheme != "kls" {
        return None;
    }
    let nested = &trimmed[scheme_end + 1..];
    let (archive_uri, entry) = nested.split_once("!/").or_else(|| nested.split_once('!'))?;
    let archive_path = if archive_uri.to_ascii_lowercase().starts_with("file:") {
        PathBuf::from(path_from_file_uri(archive_uri)?)
    } else if archive_uri.starts_with('/') {
        PathBuf::from(path_from_file_uri(&format!("file:{archive_uri}"))?)
    } else {
        let path = PathBuf::from(archive_uri);
        path.is_absolute().then_some(path)?
    };
    let encoded_entry = entry
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('/');
    let entry_path = urlencoding::decode(encoded_entry).ok()?.replace('\\', "/");
    (!entry_path.is_empty()).then_some(ArchiveDocumentUri {
        archive_path,
        entry_path,
    })
}

fn is_archive_source_path(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "java"
            | "kt"
            | "kts"
            | "scala"
            | "sc"
            | "sbt"
            | "groovy"
            | "clj"
            | "cs"
            | "swift"
            | "swiftinterface"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hpp"
            | "hh"
            | "hxx"
            | "py"
            | "pyi"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
    )
}

/// Read a source entry directly from an SDK/dependency archive. Binary `.class`,
/// `.tasty`, and JDK module entries deliberately fall through to the language
/// server's virtual-document/decompiler extension.
fn read_archive_source_contents(uri: &str) -> Result<Option<ArchiveSourceContents>, String> {
    let Some(document) = archive_document_uri(uri) else {
        return Ok(None);
    };
    if !is_archive_source_path(&document.entry_path) {
        return Ok(None);
    }
    let file = std::fs::File::open(&document.archive_path).map_err(|error| {
        format!(
            "open source archive {}: {error}",
            document.archive_path.display()
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        format!(
            "read source archive {}: {error}",
            document.archive_path.display()
        )
    })?;
    let mut entry = archive.by_name(&document.entry_path).map_err(|error| {
        format!(
            "read {} from {}: {error}",
            document.entry_path,
            document.archive_path.display()
        )
    })?;
    if entry.size() > MAX_VIRTUAL_DOCUMENT_BYTES {
        return Err(format!(
            "Archive source {} is too large ({} bytes; limit {} bytes)",
            document.entry_path,
            entry.size(),
            MAX_VIRTUAL_DOCUMENT_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .by_ref()
        .take(MAX_VIRTUAL_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read archive source {}: {error}", document.entry_path))?;
    if bytes.len() as u64 > MAX_VIRTUAL_DOCUMENT_BYTES {
        return Err(format!(
            "Archive source {} exceeds the {} byte limit",
            document.entry_path, MAX_VIRTUAL_DOCUMENT_BYTES
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        format!(
            "Archive entry {} is not UTF-8 source text",
            document.entry_path
        )
    })?;
    let title = Path::new(&document.entry_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| document.entry_path.clone());
    let container = document
        .archive_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    Ok(Some(ArchiveSourceContents {
        language_id: language_id_from_uri(&document.entry_path),
        text,
        title,
        container,
    }))
}

fn normalize_os_path_string(path: String) -> String {
    // Windows extended-length prefix breaks relativePathWithinRoot comparisons.
    path.strip_prefix(r"\\?\")
        .unwrap_or(path.as_str())
        .to_string()
}

fn is_virtual_class_uri(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    lower.starts_with("jdt:")
        || lower.starts_with("jar:file:")
        || lower.contains(".class?")
        || lower.ends_with(".class")
}

fn language_id_from_uri(uri: &str) -> String {
    let lower = uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .to_ascii_lowercase();
    if lower.ends_with(".tsx") {
        "typescriptreact".into()
    } else if lower.ends_with(".ts") || lower.ends_with(".mts") || lower.ends_with(".cts") {
        "typescript".into()
    } else if lower.ends_with(".jsx") {
        "javascriptreact".into()
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
        "javascript".into()
    } else if lower.ends_with(".kt") || lower.ends_with(".kts") {
        "kotlin".into()
    } else if lower.ends_with(".scala") || lower.ends_with(".sc") {
        "scala".into()
    } else if lower.ends_with(".rs") {
        "rust".into()
    } else if lower.ends_with(".py") || lower.ends_with(".pyi") {
        "python".into()
    } else if lower.ends_with(".go") {
        "go".into()
    } else if lower.ends_with(".cs") || lower.ends_with(".csx") {
        "csharp".into()
    } else if lower.ends_with(".swift") || lower.ends_with(".swiftinterface") {
        "swift".into()
    } else if [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        "cpp".into()
    } else {
        "java".into()
    }
}

/// Best-effort display name for jdt://contents/.../String.class?=... URIs.
fn title_from_class_uri(uri: &str) -> String {
    // jdt://contents/java.base/java.lang/String.class?=java.base/...
    if let Some(after) = uri.split("://").nth(1) {
        let path_part = after.split('?').next().unwrap_or(after);
        if let Some(name) = path_part.rsplit('/').next() {
            let clean = name.trim();
            if !clean.is_empty() {
                if clean.ends_with(".class") {
                    return clean[..clean.len() - 6].to_string() + ".java";
                }
                return clean.to_string();
            }
        }
    }
    "Library Class".into()
}

/// Where a library class came from, shown as the editor tab subtitle:
/// `java.lang · java.base` for jdt:// URIs, `com.foo · lib.jar` for jar: URIs.
fn container_from_class_uri(uri: &str) -> Option<String> {
    let after = uri.split("://").nth(1)?;
    let path = after.split('?').next().unwrap_or(after);
    if uri.to_ascii_lowercase().starts_with("jar:file:") {
        // /path/to/lib.jar!/com/foo/Bar.class
        let (archive, entry) = path.split_once("!/")?;
        let jar = archive.rsplit('/').next().unwrap_or(archive);
        let package = entry
            .rsplit_once('/')
            .map(|(dir, _)| dir.replace('/', "."))
            .unwrap_or_default();
        return Some(if package.is_empty() {
            jar.to_string()
        } else {
            format!("{package} · {jar}")
        });
    }
    // contents/java.base/java.lang/String.class
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 4 {
        return None;
    }
    let jar = segments[1].trim();
    let package = segments[2].trim();
    let package = if package.is_empty() {
        "(default package)"
    } else {
        package
    };
    if jar.is_empty() {
        return Some(package.to_string());
    }
    Some(format!("{package} · {jar}"))
}

fn detect_language_id(language_id: &str) -> Option<DetectedLanguage> {
    let language_id = language_id.trim();
    let preset_id = match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            "typescript-javascript"
        }
        "rust" => "rust",
        "python" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "cpp" | "objective-c" | "objective-cpp" => "cpp",
        "kotlin" => "kotlin",
        "scala" => "scala",
        "csharp" => "csharp",
        "swift" => "swift",
        _ => return None,
    };
    Some(DetectedLanguage {
        preset_id: preset_id.to_string(),
        language_id: language_id.to_string(),
    })
}

fn detect_language_for_path(path: &Path) -> Option<DetectedLanguage> {
    let file_name = path.file_name()?.to_string_lossy().to_lowercase();
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let language_id = match extension.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "c" => "c",
        "h" => {
            if file_name.ends_with(".h") {
                "cpp"
            } else {
                return None;
            }
        }
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "cs" | "csx" => "csharp",
        "swift" => "swift",
        _ => return None,
    };
    detect_language_id(language_id)
}

fn find_preset(id: &str) -> Option<LspServerPreset> {
    lsp_presets().into_iter().find(|preset| preset.id == id)
}

fn cmd(
    id: &str,
    label: &str,
    command: &str,
    args: &[&str],
    install_hint: &str,
    fallback: bool,
) -> LspServerCommandPreset {
    LspServerCommandPreset {
        id: id.into(),
        label: label.into(),
        command: command.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        install_hint: install_hint.into(),
        fallback,
    }
}

/// OS-aware install hints for language servers that lack a single cross-platform package.
fn install_hint_for(command_id: &str) -> String {
    let os = std::env::consts::OS;
    match command_id {
        "jdtls" => match os {
            "macos" => {
                "Requires JDK 21+ (current JDT LS). macOS: brew install jdtls. \
Or download Eclipse JDT LS (https://download.eclipse.org/jdtls/snapshots/) and put `jdtls` on PATH (config_mac)."
                    .into()
            }
            "windows" => {
                "Requires JDK 21+ (current JDT LS; JDK 17 exits immediately). Windows: download \
https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz, extract to \
%LOCALAPPDATA%\\jdtls, ensure java 21+ on PATH / JAVA_HOME."
                    .into()
            }
            _ => {
                "Requires JDK 21+ (current JDT LS). Linux: download Eclipse JDT LS tarball \
(https://download.eclipse.org/jdtls/snapshots/), extract to ~/.local/share/jdtls, wrap launcher with config_linux as `jdtls` on PATH. \
Arch: pacman -S jdtls (if available)."
                    .into()
            }
        },
        "clangd" => match os {
            "macos" => "brew install llvm  # then ensure clangd is on PATH".into(),
            "windows" => {
                "Install LLVM (https://llvm.org/) or use winget/choco `llvm`; ensure `clangd` is on PATH"
                    .into()
            }
            _ => {
                "sudo apt install clangd  # Debian/Ubuntu; or install LLVM clangd package for your distro"
                    .into()
            }
        },
        "kotlin-lsp" => {
            "Install JetBrains' official Kotlin LSP release and put `kotlin-lsp` on PATH: https://github.com/Kotlin/kotlin-lsp/releases"
                .into()
        }
        "kotlin-language-server" => match os {
            "macos" => {
                "brew install kotlin-language-server  # or download from \
https://github.com/fwcd/kotlin-language-server/releases"
                    .into()
            }
            _ => {
                "Download kotlin-language-server from \
https://github.com/fwcd/kotlin-language-server/releases and put it on PATH"
                    .into()
            }
        },
        "metals" => match os {
            "macos" => "brew install metals  # or: coursier install metals".into(),
            _ => {
                "Install Metals: coursier install metals  # or see https://scalameta.org/metals/docs/"
                    .into()
            }
        },
        "omnisharp" => match os {
            "macos" => "brew install omnisharp  # or download OmniSharp from GitHub releases".into(),
            "windows" => {
                "Install OmniSharp-roslyn release and ensure `omnisharp` is on PATH".into()
            }
            _ => "Install OmniSharp-roslyn and ensure `omnisharp` is on PATH".into(),
        },
        "sourcekit-lsp" => match os {
            "macos" => "Install Xcode or Swift toolchain (sourcekit-lsp ships with it)".into(),
            _ => {
                "Install Swift toolchain from https://www.swift.org/ and ensure `sourcekit-lsp` is on PATH"
                    .into()
            }
        },
        _ => format!("Install `{command_id}` and ensure it is on PATH"),
    }
}

pub fn lsp_presets() -> Vec<LspServerPreset> {
    vec![
        LspServerPreset {
            id: "typescript-javascript".into(),
            display_name: "TypeScript / JavaScript".into(),
            document_language_ids: vec![
                "typescript".into(),
                "typescriptreact".into(),
                "javascript".into(),
                "javascriptreact".into(),
            ],
            file_extensions: vec![
                "ts".into(),
                "tsx".into(),
                "mts".into(),
                "cts".into(),
                "js".into(),
                "jsx".into(),
                "mjs".into(),
                "cjs".into(),
            ],
            file_names: vec![],
            commands: vec![cmd(
                "typescript-language-server",
                "typescript-language-server",
                "typescript-language-server",
                &["--stdio"],
                "npm install -g typescript typescript-language-server",
                false,
            )],
        },
        LspServerPreset {
            id: "rust".into(),
            display_name: "Rust".into(),
            document_language_ids: vec!["rust".into()],
            file_extensions: vec!["rs".into()],
            file_names: vec![],
            commands: vec![cmd(
                "rust-analyzer",
                "rust-analyzer",
                "rust-analyzer",
                &[],
                "rustup component add rust-analyzer",
                false,
            )],
        },
        LspServerPreset {
            id: "python".into(),
            display_name: "Python".into(),
            document_language_ids: vec!["python".into()],
            file_extensions: vec!["py".into(), "pyi".into()],
            file_names: vec![],
            commands: vec![cmd(
                "pyright",
                "pyright-langserver",
                "pyright-langserver",
                &["--stdio"],
                "npm install -g pyright",
                false,
            )],
        },
        LspServerPreset {
            id: "go".into(),
            display_name: "Go".into(),
            document_language_ids: vec!["go".into()],
            file_extensions: vec!["go".into()],
            file_names: vec![],
            commands: vec![cmd(
                "gopls",
                "gopls",
                "gopls",
                &[],
                "go install golang.org/x/tools/gopls@latest",
                false,
            )],
        },
        LspServerPreset {
            id: "java".into(),
            display_name: "Java".into(),
            document_language_ids: vec!["java".into()],
            file_extensions: vec!["java".into()],
            file_names: vec![],
            commands: vec![cmd(
                "jdtls",
                "jdtls",
                "jdtls",
                &[],
                &install_hint_for("jdtls"),
                false,
            )],
        },
        LspServerPreset {
            id: "cpp".into(),
            display_name: "C / C++".into(),
            document_language_ids: vec!["c".into(), "cpp".into()],
            file_extensions: vec![
                "c".into(),
                "h".into(),
                "cc".into(),
                "cpp".into(),
                "cxx".into(),
                "hpp".into(),
                "hh".into(),
                "hxx".into(),
            ],
            file_names: vec![],
            commands: vec![cmd(
                "clangd",
                "clangd",
                "clangd",
                &[],
                &install_hint_for("clangd"),
                false,
            )],
        },
        LspServerPreset {
            id: "kotlin".into(),
            display_name: "Kotlin".into(),
            document_language_ids: vec!["kotlin".into()],
            file_extensions: vec!["kt".into(), "kts".into()],
            file_names: vec![],
            commands: vec![
                cmd(
                    "kotlin-lsp",
                    "Kotlin LSP (official)",
                    "kotlin-lsp",
                    &[],
                    &install_hint_for("kotlin-lsp"),
                    false,
                ),
                cmd(
                    "kotlin-language-server",
                    "kotlin-language-server (community)",
                    "kotlin-language-server",
                    &[],
                    &install_hint_for("kotlin-language-server"),
                    true,
                ),
            ],
        },
        LspServerPreset {
            id: "scala".into(),
            display_name: "Scala".into(),
            document_language_ids: vec!["scala".into()],
            file_extensions: vec!["scala".into(), "sc".into()],
            file_names: vec![],
            commands: vec![cmd(
                "metals",
                "Metals",
                "metals",
                &[],
                &install_hint_for("metals"),
                false,
            )],
        },
        LspServerPreset {
            id: "csharp".into(),
            display_name: "C#".into(),
            document_language_ids: vec!["csharp".into()],
            file_extensions: vec!["cs".into(), "csx".into()],
            file_names: vec![],
            commands: vec![
                cmd(
                    "csharp-ls",
                    "csharp-ls",
                    "csharp-ls",
                    &["--features", "metadata-uris"],
                    "dotnet tool install -g csharp-ls",
                    false,
                ),
                cmd(
                    "omnisharp",
                    "OmniSharp",
                    "omnisharp",
                    &["--languageserver"],
                    &install_hint_for("omnisharp"),
                    true,
                ),
            ],
        },
        LspServerPreset {
            id: "swift".into(),
            display_name: "Swift".into(),
            document_language_ids: vec!["swift".into()],
            file_extensions: vec!["swift".into()],
            file_names: vec![],
            commands: vec![cmd(
                "sourcekit-lsp",
                "SourceKit-LSP",
                "sourcekit-lsp",
                &[],
                &install_hint_for("sourcekit-lsp"),
                false,
            )],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Serializes tests that mutate the process-global jdtls vmargs / java settings
    /// (both feed `jdtls_vmargs()`), so parallel runs do not clobber each other.
    static JAVA_GLOBALS_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn java_install_hint_is_platform_specific() {
        let hint = install_hint_for("jdtls");
        assert!(
            hint.contains("JDK 21") || hint.contains("jdtls"),
            "expected JDK / jdtls guidance, got: {hint}"
        );
        let java = find_preset("java").expect("java preset");
        assert_eq!(java.commands[0].install_hint, hint);
    }

    #[test]
    fn jdtls_initialize_timeout_is_longer_than_default() {
        let java = find_preset("java").expect("java preset");
        let jdtls = &java.commands[0];
        assert!(
            initialize_timeout_secs(jdtls) >= JDTLS_INITIALIZE_TIMEOUT_SECS,
            "jdtls needs a long initialize window"
        );
        let rust = find_preset("rust").expect("rust preset");
        assert_eq!(
            initialize_timeout_secs(&rust.commands[0]),
            INITIALIZE_TIMEOUT_SECS
        );
    }

    #[test]
    fn workspace_client_capabilities_advertise_supported_edits() {
        let capabilities = workspace_client_capabilities();

        assert_eq!(capabilities["applyEdit"], json!(true));
        assert_eq!(
            capabilities["workspaceEdit"]["documentChanges"],
            json!(true)
        );
        assert_eq!(
            capabilities["workspaceEdit"]["resourceOperations"],
            json!(["create", "rename", "delete"])
        );
        assert_eq!(
            capabilities["workspaceEdit"]["failureHandling"],
            json!("abort")
        );
        assert_eq!(
            capabilities["workspaceEdit"]["changeAnnotationSupport"]["groupsOnLabel"],
            json!(false)
        );
        assert_eq!(capabilities["workspaceFolders"], json!(true));
        assert_eq!(capabilities["configuration"], json!(true));
        assert_eq!(capabilities["diagnostics"]["refreshSupport"], json!(true));
        assert_eq!(
            capabilities["diagnostics"]["relatedDocumentSupport"],
            json!(true)
        );
        assert_eq!(
            capabilities["fileOperations"],
            json!({
                "dynamicRegistration": true,
                "didCreate": true,
                "willCreate": true,
                "didRename": true,
                "willRename": true,
                "didDelete": true,
                "willDelete": true
            })
        );
        assert_eq!(
            capabilities["didChangeWatchedFiles"],
            json!({ "dynamicRegistration": true })
        );
        assert_eq!(capabilities["symbol"]["dynamicRegistration"], json!(true));
        assert_eq!(
            capabilities["symbol"]["resolveSupport"]["properties"],
            json!(["location.range"])
        );
    }

    #[test]
    fn watched_file_globs_honor_kind_root_and_relative_patterns() {
        let root = tempfile::tempdir().unwrap();
        let root_uri = url::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        let java_uri = url::Url::from_file_path(root.path().join("src/Main.java"))
            .unwrap()
            .to_string();
        let outside = tempfile::tempdir().unwrap();
        let outside_uri = url::Url::from_file_path(outside.path().join("src/Main.java"))
            .unwrap()
            .to_string();
        let registration = DynamicCapabilityRegistration {
            id: "java-watch".into(),
            method: "workspace/didChangeWatchedFiles".into(),
            register_options: json!({
                "watchers": [{
                    "globPattern": "**/*.java",
                    "kind": WATCH_KIND_CREATE
                }]
            }),
        };

        assert!(watched_file_registration_matches(
            &registration,
            &root_uri,
            &java_uri,
            WATCH_KIND_CREATE,
        ));
        assert!(!watched_file_registration_matches(
            &registration,
            &root_uri,
            &java_uri,
            WATCH_KIND_CHANGE,
        ));
        assert!(!watched_file_registration_matches(
            &registration,
            &root_uri,
            &outside_uri,
            WATCH_KIND_CREATE,
        ));

        let base = root.path().join("src");
        let base_uri = url::Url::from_directory_path(&base).unwrap().to_string();
        let relative_registration = DynamicCapabilityRegistration {
            id: "kotlin-watch".into(),
            method: "workspace/didChangeWatchedFiles".into(),
            register_options: json!({
                "watchers": [{
                    "globPattern": {
                        "baseUri": { "uri": base_uri },
                        "pattern": "**/*.kt"
                    }
                }]
            }),
        };
        let kotlin_uri = url::Url::from_file_path(base.join("nested/Main.kt"))
            .unwrap()
            .to_string();
        let wrong_uri = url::Url::from_file_path(root.path().join("Main.kt"))
            .unwrap()
            .to_string();
        assert!(watched_file_registration_matches(
            &relative_registration,
            &root_uri,
            &kotlin_uri,
            WATCH_KIND_CHANGE,
        ));
        assert!(!watched_file_registration_matches(
            &relative_registration,
            &root_uri,
            &wrong_uri,
            WATCH_KIND_CHANGE,
        ));
    }

    #[test]
    fn watched_file_changes_use_lsp_types_and_split_renames() {
        let operation: LspWorkspaceFileOperation = serde_json::from_value(json!({
            "kind": "rename",
            "files": [{
                "oldPath": "/repo/src/Old.java",
                "newPath": "/repo/src/New.java",
                "isDirectory": false
            }]
        }))
        .unwrap();
        assert_eq!(
            operation.watched_file_changes(),
            vec![
                LspWatchedFileChange {
                    path: "/repo/src/Old.java".into(),
                    change_type: 3,
                },
                LspWatchedFileChange {
                    path: "/repo/src/New.java".into(),
                    change_type: 1,
                },
            ]
        );
        let changed: LspWatchedFileChange = serde_json::from_value(json!({
            "path": "/repo/src/Main.java",
            "type": 2
        }))
        .unwrap();
        assert_eq!(changed.change_type, 2);
        assert_eq!(
            watch_kind_for_change(changed.change_type),
            Some(WATCH_KIND_CHANGE)
        );
        assert!(watch_kind_for_change(9).is_none());
    }

    #[test]
    fn native_watcher_events_normalize_create_change_delete_and_rename() {
        let root = tempfile::tempdir().unwrap();
        let old_path = root.path().join("Old.java");
        let new_path = root.path().join("New.java");
        let rename = NotifyEvent::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(old_path.clone())
            .add_path(new_path.clone());
        assert_eq!(
            notify_event_changes(&rename),
            vec![
                LspWatchedFileChange {
                    path: old_path.to_string_lossy().into_owned(),
                    change_type: 3,
                },
                LspWatchedFileChange {
                    path: new_path.to_string_lossy().into_owned(),
                    change_type: 1,
                },
            ]
        );

        let changed = NotifyEvent::new(EventKind::Modify(ModifyKind::Any))
            .add_path(new_path.clone())
            .add_path(new_path.clone());
        assert_eq!(notify_event_changes(&changed).len(), 1);
        assert_eq!(notify_event_changes(&changed)[0].change_type, 2);

        let removed = NotifyEvent::new(EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(new_path.clone());
        assert_eq!(notify_event_changes(&removed)[0].change_type, 3);
    }

    #[test]
    fn workspace_watcher_filters_recursive_roots_and_loose_files() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("src").join("Main.java");
        let sibling = root.path().join("outside.txt");
        let loose = root.path().join("notes.txt");
        let targets = vec![
            WorkspaceWatchTarget {
                recursive: true,
                filter_path: root.path().to_path_buf(),
            },
            WorkspaceWatchTarget {
                recursive: false,
                filter_path: loose.clone(),
            },
        ];
        assert!(workspace_watch_target_matches(
            &targets,
            &normalized_file_operation_path(&nested)
        ));
        assert!(workspace_watch_target_matches(
            &targets,
            &normalized_file_operation_path(&loose)
        ));
        assert!(workspace_watch_target_matches(
            &[WorkspaceWatchTarget {
                recursive: false,
                filter_path: loose.clone(),
            }],
            &normalized_file_operation_path(&loose)
        ));
        assert!(!workspace_watch_target_matches(
            &[WorkspaceWatchTarget {
                recursive: false,
                filter_path: loose,
            }],
            &normalized_file_operation_path(&sibling)
        ));
    }

    #[test]
    fn local_watcher_suppression_handles_atomic_save_event_variants() {
        let events = StdMutex::new(HashMap::new());
        let now = Instant::now();
        let path = "/repo/src/Main.java";
        events
            .lock()
            .unwrap()
            .insert(("workspace".into(), path.into(), 2), now);
        assert!(local_watched_event_suppressed(
            &events,
            "workspace",
            path,
            1,
            now,
        ));
        assert!(!local_watched_event_suppressed(
            &events,
            "workspace",
            path,
            3,
            now,
        ));

        events
            .lock()
            .unwrap()
            .insert(("workspace".into(), path.into(), 3), now);
        assert!(local_watched_event_suppressed(
            &events,
            "workspace",
            path,
            3,
            now,
        ));
    }

    #[test]
    fn workspace_diagnostic_provider_supports_static_and_dynamic_registration() {
        let static_capabilities = json!({
            "diagnosticProvider": {
                "identifier": "typescript",
                "workspaceDiagnostics": true
            }
        });
        assert_eq!(
            workspace_diagnostic_provider_options(&static_capabilities, &[]).unwrap()["identifier"],
            json!("typescript")
        );
        assert!(
            workspace_diagnostic_provider_options(
                &json!({ "diagnosticProvider": { "workspaceDiagnostics": false } }),
                &[]
            )
            .is_none()
        );

        let registrations = vec![DynamicCapabilityRegistration {
            id: "pull".into(),
            method: "workspace/diagnostic".into(),
            register_options: json!({ "identifier": "dynamic" }),
        }];
        assert_eq!(
            workspace_diagnostic_provider_options(&Value::Null, &registrations).unwrap()["identifier"],
            json!("dynamic")
        );
    }

    #[test]
    fn workspace_diagnostic_reports_apply_full_unchanged_and_related_documents_atomically() {
        let main_uri = "file:///repo/src/main.rs";
        let unchanged_uri = "file:///repo/src/lib.rs";
        let related_uri = "file:///repo/Cargo.toml";
        let old = LspDiagnostic {
            range: LspRange {
                start: LspPosition {
                    line: 0,
                    character: 0,
                },
                end: LspPosition {
                    line: 0,
                    character: 1,
                },
            },
            severity: Some(2),
            code: None,
            code_description: None,
            source: Some("old".into()),
            message: "keep".into(),
            tags: Vec::new(),
            related_information: Vec::new(),
            data: None,
        };
        let mut diagnostics = HashMap::from([(unchanged_uri.to_string(), vec![old])]);
        let mut result_ids = HashMap::from([
            (main_uri.to_string(), "old-main".to_string()),
            (unchanged_uri.to_string(), "old-lib".to_string()),
        ]);
        let response = json!({
            "items": [
                {
                    "uri": main_uri,
                    "kind": "full",
                    "resultId": "main-2",
                    "items": [{
                        "range": {
                            "start": { "line": 2, "character": 3 },
                            "end": { "line": 2, "character": 7 }
                        },
                        "severity": 1,
                        "source": "rustc",
                        "message": "broken"
                    }]
                },
                {
                    "uri": unchanged_uri,
                    "kind": "unchanged",
                    "resultId": "lib-2"
                }
            ],
            "relatedDocuments": {
                (related_uri): {
                    "kind": "full",
                    "resultId": "cargo-1",
                    "items": []
                }
            }
        });

        apply_workspace_diagnostic_report(&response, &mut diagnostics, &mut result_ids).unwrap();
        assert_eq!(diagnostics[main_uri][0].message, "broken");
        assert_eq!(diagnostics[unchanged_uri][0].message, "keep");
        assert!(diagnostics[related_uri].is_empty());
        assert_eq!(result_ids[main_uri], "main-2");
        assert_eq!(result_ids[unchanged_uri], "lib-2");
        assert_eq!(result_ids[related_uri], "cargo-1");

        let before_diagnostics = diagnostics.clone();
        let before_result_ids = result_ids.clone();
        assert!(
            apply_workspace_diagnostic_report(
                &json!({
                    "items": [
                        { "uri": main_uri, "kind": "full", "items": [] },
                        { "uri": unchanged_uri, "kind": "invalid" }
                    ]
                }),
                &mut diagnostics,
                &mut result_ids,
            )
            .is_err()
        );
        assert_eq!(diagnostics.len(), before_diagnostics.len());
        assert_eq!(
            diagnostics[main_uri][0].message,
            before_diagnostics[main_uri][0].message
        );
        assert_eq!(result_ids, before_result_ids);
    }

    #[test]
    fn workspace_diagnostic_partial_items_precede_final_items() {
        let response = merge_workspace_diagnostic_partial_results(
            json!({
                "items": [{
                    "uri": "file:///repo/src/final.rs",
                    "kind": "full",
                    "items": []
                }]
            }),
            vec![
                json!({
                    "uri": "file:///repo/src/first.rs",
                    "kind": "full",
                    "items": []
                }),
                json!({
                    "uri": "file:///repo/src/second.rs",
                    "kind": "unchanged",
                    "resultId": "second-1"
                }),
            ],
        )
        .unwrap();
        let uris = response["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["uri"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            uris,
            vec![
                "file:///repo/src/first.rs",
                "file:///repo/src/second.rs",
                "file:///repo/src/final.rs"
            ]
        );
        assert!(
            merge_workspace_diagnostic_partial_results(
                json!({ "kind": "full" }),
                vec![json!({ "uri": "file:///repo/a" })]
            )
            .is_err()
        );
    }

    #[test]
    fn file_operation_filters_merge_static_and_dynamic_capabilities() {
        let server_capabilities = json!({
            "workspace": {
                "fileOperations": {
                    "willRename": {
                        "filters": [{ "scheme": "file", "pattern": { "glob": "**/*.rs" } }]
                    }
                }
            }
        });
        let registrations = vec![DynamicCapabilityRegistration {
            id: "rename-files".into(),
            method: "workspace/willRenameFiles".into(),
            register_options: json!({
                "filters": [{ "scheme": "file", "pattern": { "glob": "**/*.toml" } }]
            }),
        }];

        let filters = file_operation_filters_from(
            &server_capabilities,
            &registrations,
            "workspace/willRenameFiles",
        )
        .expect("rename support");
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0]["pattern"]["glob"], json!("**/*.rs"));
        assert_eq!(filters[1]["pattern"]["glob"], json!("**/*.toml"));
        assert!(
            file_operation_filters_from(
                &server_capabilities,
                &registrations,
                "workspace/willCreateFiles"
            )
            .is_none()
        );
    }

    #[test]
    fn file_operation_filters_honor_root_glob_kind_scheme_and_case() {
        let root = tempfile::tempdir().unwrap();
        let root_uri = url::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        let source_uri = url::Url::from_file_path(root.path().join("src/Main.JAVA"))
            .unwrap()
            .to_string();
        let outside = tempfile::tempdir().unwrap();
        let outside_uri = url::Url::from_file_path(outside.path().join("Main.JAVA"))
            .unwrap()
            .to_string();
        let file_filter = json!({
            "scheme": "file",
            "pattern": {
                "glob": "**/*.java",
                "matches": "file",
                "options": { "ignoreCase": true }
            }
        });

        assert!(file_operation_filter_matches(
            &file_filter,
            &root_uri,
            &source_uri,
            false
        ));
        assert!(!file_operation_filter_matches(
            &file_filter,
            &root_uri,
            &source_uri,
            true
        ));
        assert!(!file_operation_filter_matches(
            &file_filter,
            &root_uri,
            &outside_uri,
            false
        ));
        assert!(!file_operation_filter_matches(
            &json!({
                "scheme": "untitled",
                "pattern": { "glob": "**/*" }
            }),
            &root_uri,
            &source_uri,
            false
        ));
    }

    #[test]
    fn workspace_file_operation_params_filter_batches_and_preserve_rename_uris() {
        let root = tempfile::tempdir().unwrap();
        let root_uri = url::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        let old_path = root.path().join("src/Main.java");
        let new_path = root.path().join("src/Main.kt");
        let ignored_old_path = root.path().join("README.md");
        let ignored_new_path = root.path().join("README.txt");
        let operation = LspWorkspaceFileOperation::Rename {
            files: vec![
                LspWorkspaceFileRenameTarget {
                    old_path: old_path.to_string_lossy().into_owned(),
                    new_path: new_path.to_string_lossy().into_owned(),
                    is_directory: false,
                },
                LspWorkspaceFileRenameTarget {
                    old_path: ignored_old_path.to_string_lossy().into_owned(),
                    new_path: ignored_new_path.to_string_lossy().into_owned(),
                    is_directory: false,
                },
            ],
        };
        let filters = vec![json!({
            "scheme": "file",
            "pattern": { "glob": "**/*.java", "matches": "file" }
        })];

        let params = workspace_file_operation_params(&root_uri, &operation, &filters)
            .unwrap()
            .expect("one matching rename");
        assert_eq!(params["files"].as_array().unwrap().len(), 1);
        assert_eq!(
            params["files"][0]["oldUri"],
            json!(url::Url::from_file_path(old_path).unwrap().to_string())
        );
        assert_eq!(
            params["files"][0]["newUri"],
            json!(url::Url::from_file_path(new_path).unwrap().to_string())
        );
    }

    #[test]
    fn deserializes_workspace_file_operation_camel_case_contract() {
        let operation: LspWorkspaceFileOperation = serde_json::from_value(json!({
            "kind": "rename",
            "files": [{
                "oldPath": "/repo/src/Old.java",
                "newPath": "/repo/src/New.java",
                "isDirectory": false
            }]
        }))
        .unwrap();

        assert_eq!(operation.will_method(), "workspace/willRenameFiles");
        assert_eq!(operation.did_method(), "workspace/didRenameFiles");
        match operation {
            LspWorkspaceFileOperation::Rename { files } => {
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].old_path, "/repo/src/Old.java");
                assert_eq!(files[0].new_path, "/repo/src/New.java");
                assert!(!files[0].is_directory);
            }
            _ => panic!("expected rename operation"),
        }
    }

    #[test]
    fn jdtls_initialization_uses_project_java_runtimes() {
        let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
        let mut environment = WorkspaceSdkEnvironment::passthrough(&root, &root);
        environment.java_runtimes = vec![JavaRuntimeConfiguration {
            name: "JavaSE-17".to_string(),
            path: "/sdk/jdk-17".to_string(),
            default: true,
        }];

        let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_configured_java_settings(None);
        let java = find_preset("java").expect("java preset");
        let options = lsp_initialization_options(&java, &java.commands[0], &environment);

        assert_eq!(
            options["settings"]["java"]["configuration"]["runtimes"][0],
            json!({ "name": "JavaSE-17", "path": "/sdk/jdk-17", "default": true })
        );
        // Required for jdt:// definitions into the JDK and dependency JARs.
        assert_eq!(
            options["extendedClientCapabilities"]["classFileContentsSupport"],
            json!(true)
        );
        // Default settings widen jdtls beyond bare runtimes (M6-A): autobuild on,
        // completion + format + import + code generation present.
        assert_eq!(
            options["settings"]["java"]["autobuild"]["enabled"],
            json!(true)
        );
        assert_eq!(
            options["settings"]["java"]["completion"]["guessMethodArguments"],
            json!(true)
        );
        assert!(
            options["settings"]["java"]["completion"]["favoriteStaticMembers"]
                .as_array()
                .is_some_and(|members| members
                    .iter()
                    .any(|m| m == "org.junit.jupiter.api.Assertions.*")),
            "JUnit 5 assertions should be a favorite static member by default"
        );
        assert_eq!(
            options["settings"]["java"]["saveActions"]["organizeImports"],
            json!(false)
        );
        let rust = find_preset("rust").expect("rust preset");
        assert_eq!(
            lsp_initialization_options(&rust, &rust.commands[0], &environment),
            Value::Null
        );
    }

    #[test]
    fn metals_initialization_enables_virtual_documents() {
        let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
        let environment = WorkspaceSdkEnvironment::passthrough(&root, &root);
        let scala = find_preset("scala").expect("scala preset");
        assert_eq!(
            lsp_initialization_options(&scala, &scala.commands[0], &environment),
            json!({ "isVirtualDocumentSupported": true })
        );
    }

    #[test]
    fn java_settings_default_and_round_trip() {
        let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_configured_java_settings(None);
        let defaults = get_configured_java_settings();
        assert!(defaults.autobuild_enabled);
        assert!(!defaults.lombok_enabled);
        assert!(!defaults.save_actions_organize_imports);

        // A partial JSON payload from the frontend fills omitted fields from Default.
        let partial: JavaLanguageSettings = serde_json::from_value(json!({
            "lombokEnabled": true,
            "saveActionsOrganizeImports": true
        }))
        .expect("partial settings deserialize");
        assert!(partial.lombok_enabled);
        assert!(partial.save_actions_organize_imports);
        // Untouched fields keep their defaults.
        assert!(partial.autobuild_enabled);
        assert!(partial.guess_method_arguments);

        set_configured_java_settings(Some(partial.clone()));
        assert_eq!(get_configured_java_settings(), partial);
        set_configured_java_settings(None);
    }

    #[test]
    fn lombok_javaagent_only_when_enabled_with_jar() {
        let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_configured_java_settings(None);
        assert!(lombok_javaagent_arg().is_none());

        set_configured_java_settings(Some(JavaLanguageSettings {
            lombok_enabled: true,
            lombok_jar_path: Some("  ".into()),
            ..Default::default()
        }));
        assert!(
            lombok_javaagent_arg().is_none(),
            "blank jar path must not produce a -javaagent"
        );

        let jar = if cfg!(windows) {
            r"C:\tools\lombok.jar"
        } else {
            "/opt/lombok.jar"
        };
        set_configured_java_settings(Some(JavaLanguageSettings {
            lombok_enabled: true,
            lombok_jar_path: Some(jar.into()),
            ..Default::default()
        }));
        assert_eq!(lombok_javaagent_arg(), Some(format!("-javaagent:{jar}")));
        assert!(
            jdtls_vmargs()
                .iter()
                .any(|arg| arg == &format!("-javaagent:{jar}")),
            "vmargs should carry the Lombok agent so both launch paths pick it up"
        );
        set_configured_java_settings(None);
    }

    #[test]
    fn file_path_from_uri_maps_file_and_skips_virtual() {
        let (uri, expected_suffix) = if cfg!(windows) {
            ("file:///C:/repo/src/Main.java", "Main.java")
        } else {
            ("file:///repo/src/Main.java", "Main.java")
        };
        let path = file_path_from_uri(uri).expect("file uri maps to a path");
        assert!(path.ends_with(expected_suffix), "got {path}");
        // Virtual / non-file URIs are skipped (library sources must not clutter Problems).
        assert!(file_path_from_uri("jdt://contents/java.base/java.lang/String.class?=x").is_none());
        assert!(file_path_from_uri("not a uri").is_none());
    }

    #[test]
    fn parses_java_modules_from_project_uris() {
        let (root_a, root_b) = if cfg!(windows) {
            ("file:///C:/repo/app", "file:///C:/repo/lib")
        } else {
            ("file:///repo/app", "file:///repo/lib")
        };
        // Out of order + a duplicate + a non-file URI that must be skipped.
        let value = json!([root_b, root_a, root_b, "jdt://contents/foo"]);
        let modules = parse_java_modules(&value);
        assert_eq!(modules.len(), 2, "dedup + skip non-file, got {modules:?}");
        // Sorted by name: app before lib.
        assert_eq!(modules[0].name, "app");
        assert_eq!(modules[1].name, "lib");
        assert_eq!(modules[0].uri, root_a);
        assert!(modules[0].path.ends_with("app"));

        assert!(parse_java_modules(&json!(null)).is_empty());
        assert!(parse_java_modules(&json!([])).is_empty());
    }

    #[test]
    fn hot_update_settings_omit_runtimes() {
        let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_configured_java_settings(None);
        // A live didChangeConfiguration push must not send an empty runtimes array
        // (that would clobber the JDK config jdtls resolved at initialize).
        let java = get_configured_java_settings().to_java_settings(&[]);
        assert!(
            java["configuration"].get("runtimes").is_none(),
            "empty runtimes must be omitted, got: {java:#}"
        );
        assert_eq!(
            java["configuration"]["updateBuildConfiguration"],
            json!("interactive")
        );

        // Whereas initialize carries them.
        let with_runtimes =
            get_configured_java_settings().to_java_settings(&[JavaRuntimeConfiguration {
                name: "JavaSE-21".into(),
                path: "/sdk/jdk-21".into(),
                default: true,
            }]);
        assert_eq!(
            with_runtimes["configuration"]["runtimes"][0]["name"],
            json!("JavaSE-21")
        );
    }

    #[test]
    fn session_key_changes_with_sdk_fingerprint_and_project_scope() {
        let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
        let document = ResolvedDocument {
            path: root.join("module/src/Main.kt"),
            uri: "file:///repo/module/src/Main.kt".to_string(),
            root_path: root.clone(),
            workspace_id: "workspace".to_string(),
            preset: find_preset("kotlin"),
            language_id: Some("kotlin".to_string()),
            version: 1,
        };
        let preset = document.preset.as_ref().expect("kotlin preset");
        let command = &preset.commands[0];
        let mut first = WorkspaceSdkEnvironment::passthrough(&root, &root);
        first.project_scope_path = root.join("module").to_string_lossy().into_owned();
        first.fingerprint = "jdk-17".to_string();
        let mut second = first.clone();
        second.fingerprint = "jdk-21".to_string();

        let first_key = session_key(&document, preset, command, &first);
        let second_key = session_key(&document, preset, command, &second);

        assert_ne!(first_key.map_key(), second_key.map_key());
        assert_eq!(first_key.root_path, first.project_scope_path);
    }

    #[test]
    fn lsp_session_root_is_a_noop_without_symlinks() {
        // A plain (already-canonical) root that equals the scope is returned as-is.
        let root = std::env::temp_dir().join(format!("taomni_ra_plain_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let scope = canonical.to_string_lossy().into_owned();

        let session_root = lsp_session_root(&canonical, &scope);
        assert_eq!(session_root, canonical);

        std::fs::remove_dir_all(&root).ok();
    }

    // The regression: the workspace is opened through a symlink, but the SDK
    // resolver canonicalizes the scope. The launch root must stay in the opened
    // (symlink) namespace so it shares a path prefix with the document URIs the
    // frontend sends — otherwise rust-analyzer treats every file as detached and
    // serves no intelligence while the session still reports "active".
    #[cfg(unix)]
    #[test]
    fn lsp_session_root_stays_in_opened_symlink_namespace() {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let unique = format!("taomni_ra_symlink_{}", std::process::id());
        let real = base.join(format!("{unique}_real"));
        let link = base.join(format!("{unique}_link"));
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // What the SDK resolver produces: the canonicalized real path.
        let scope = std::fs::canonicalize(&link)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(scope, real.to_string_lossy());

        // Opened via the symlink → launch root must be the symlink path, not `real`,
        // so it prefixes `file://<link>/src/main.rs`.
        let session_root = lsp_session_root(&link, &scope);
        assert_eq!(session_root, link);
        assert_ne!(session_root, real);

        std::fs::remove_file(&link).ok();
        std::fs::remove_dir_all(&real).ok();
    }

    // A nested SDK subproject scope (e.g. a Java module) under a symlinked root
    // must be rebased onto the opened path, preserving the nesting while keeping
    // the opened namespace.
    #[cfg(unix)]
    #[test]
    fn lsp_session_root_rebases_nested_scope_onto_symlink() {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let unique = format!("taomni_ra_nested_{}", std::process::id());
        let real = base.join(format!("{unique}_real"));
        let link = base.join(format!("{unique}_link"));
        std::fs::create_dir_all(real.join("module")).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Scope points at the canonical nested module.
        let scope = std::fs::canonicalize(link.join("module"))
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let session_root = lsp_session_root(&link, &scope);
        assert_eq!(session_root, link.join("module"));

        std::fs::remove_file(&link).ok();
        std::fs::remove_dir_all(&real).ok();
    }

    #[test]
    fn kotlin_prefers_official_lsp_and_keeps_community_fallback() {
        let kotlin = find_preset("kotlin").expect("kotlin preset");
        assert_eq!(kotlin.commands[0].id, "kotlin-lsp");
        assert!(!kotlin.commands[0].fallback);
        assert_eq!(kotlin.commands[1].id, "kotlin-language-server");
        assert!(kotlin.commands[1].fallback);
    }

    #[test]
    fn parses_java_major_versions_from_minus_version_output() {
        assert_eq!(
            parse_java_major_from_version_output(
                r#"openjdk version "21.0.2" 2024-01-16
OpenJDK Runtime Environment (build 21.0.2+13)
"#
            ),
            Some(21)
        );
        assert_eq!(
            parse_java_major_from_version_output(
                r#"java version "17.0.4" 2022-07-19 LTS
Java(TM) SE Runtime Environment (build 17.0.4+11-LTS-179)
"#
            ),
            Some(17)
        );
        assert_eq!(
            parse_java_major_from_version_output(r#"java version "1.8.0_392""#),
            Some(8)
        );
        assert_eq!(JDTLS_MIN_JAVA_MAJOR, 21);
    }

    #[test]
    fn jdtls_runtime_probe_labels_insufficient_java_message() {
        // Shape of the error string used to derive Settings runtimeStatus.
        let err = format!(
            "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java 17 at C:\\\\jdk-17\\\\bin\\\\java.exe"
        );
        let major = err
            .split("found Java ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|s| s.parse::<u32>().ok());
        assert_eq!(major, Some(17));
        let java = find_preset("java").expect("java preset");
        assert!(preset_uses_jdtls(&java, java.commands.first()));
        assert!(command_is_jdtls(&java.commands[0]));
    }

    #[test]
    fn resolve_java_binary_from_user_path_accepts_home_or_binary_shape() {
        let temp =
            std::env::temp_dir().join(format!("taomni-jdtls-java-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let bin_dir = temp.join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
        let java_bin = bin_dir.join(bin_name);
        std::fs::write(&java_bin, b"stub").expect("write stub java");

        assert_eq!(
            resolve_java_binary_from_user_path(&temp),
            Some(java_bin.clone())
        );
        assert_eq!(
            resolve_java_binary_from_user_path(&bin_dir),
            Some(java_bin.clone())
        );
        assert_eq!(
            resolve_java_binary_from_user_path(&java_bin),
            Some(java_bin.clone())
        );
        assert_eq!(
            java_home_from_binary(&java_bin).as_deref(),
            Some(temp.as_path())
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn configured_java_home_round_trips_and_rejects_missing_path() {
        set_configured_java_home(None);
        assert!(get_configured_java_home().is_none());

        let missing = PathBuf::from("/definitely/missing/jdk-for-taomni-test");
        set_configured_java_home(Some(missing.to_string_lossy().as_ref()));
        assert_eq!(get_configured_java_home(), Some(missing.clone()));
        let err = resolve_java_for_jdtls().expect_err("missing configured path must fail");
        assert!(
            err.contains("invalid") || err.contains("not found") || err.contains("configured"),
            "unexpected error: {err}"
        );

        set_configured_java_home(None);
        assert!(get_configured_java_home().is_none());
    }

    #[test]
    fn configured_java_vmargs_defaults_and_round_trips() {
        let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Lombok can append a -javaagent to jdtls_vmargs(); keep it off here so the
        // vec assertion below sees only the configured args.
        set_configured_java_settings(None);
        set_configured_java_vmargs(None);
        assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
        assert!(get_configured_java_vmargs().is_none());

        set_configured_java_vmargs(Some("   "));
        assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);

        set_configured_java_vmargs(Some("-Xmx2G -XX:+UseG1GC -Dfoo=bar"));
        assert_eq!(jdtls_vmargs_string(), "-Xmx2G -XX:+UseG1GC -Dfoo=bar");
        assert_eq!(
            jdtls_vmargs(),
            vec![
                "-Xmx2G".to_string(),
                "-XX:+UseG1GC".to_string(),
                "-Dfoo=bar".to_string(),
            ]
        );

        set_configured_java_vmargs(None);
        assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
    }

    #[test]
    fn split_jvm_args_honors_quotes() {
        let args = split_jvm_args(r#"-Xmx2G -Dpath="/opt/my jdk" -Dname='a b'"#);
        assert_eq!(
            args,
            vec![
                "-Xmx2G".to_string(),
                "-Dpath=/opt/my jdk".to_string(),
                "-Dname=a b".to_string(),
            ]
        );
    }

    #[test]
    fn build_lsp_server_command_keeps_program_on_unix_like() {
        // On every platform the non-batch path must still invoke the program name.
        // Windows batch routing is covered by platform integration; here we only
        // assert the builder returns a Command without panicking for a plain binary.
        let root = PathBuf::from("/tmp/workspace");
        let _cmd =
            build_lsp_server_command("rust-analyzer", &["--version".into()], &root, None, None)
                .expect("command builder");
    }

    #[test]
    fn maps_jdtls_build_workspace_status_ordinals() {
        // JDT LS answers `java/buildWorkspace` with a BuildWorkspaceStatus ordinal.
        assert_eq!(build_status_from_result(&json!(0)), LspBuildStatus::Failed);
        assert_eq!(build_status_from_result(&json!(1)), LspBuildStatus::Succeed);
        assert_eq!(
            build_status_from_result(&json!(2)),
            LspBuildStatus::WithError
        );
        assert_eq!(
            build_status_from_result(&json!(3)),
            LspBuildStatus::Cancelled
        );
        // Unknown / absent payloads must not block a launch.
        assert_eq!(
            build_status_from_result(&Value::Null),
            LspBuildStatus::Succeed
        );
        assert_eq!(
            build_status_from_result(&json!("done")),
            LspBuildStatus::Succeed
        );
    }

    #[test]
    fn java_project_commands_get_a_longer_budget_than_interactive_requests() {
        // resolveMainClass / resolveClasspath / startDebugSession search the whole
        // project and activate an OSGi bundle on first use; the interactive budget
        // cuts them off mid-flight and the Debug button then looks like a no-op.
        assert!(JAVA_COMMAND_TIMEOUT_SECS > REQUEST_TIMEOUT_SECS);
        assert!(BUILD_WORKSPACE_TIMEOUT_SECS > JAVA_COMMAND_TIMEOUT_SECS);
    }

    #[test]
    fn server_configuration_sections_are_resolved_without_silent_nulls() {
        let configuration = json!({
            "java": { "autobuild": { "enabled": true } },
            "editor": { "tabSize": 2 }
        });
        assert_eq!(
            configuration_section_value(&configuration, Some("java.autobuild")),
            json!({ "enabled": true })
        );
        assert_eq!(
            configuration_section_value(&configuration, Some("missing")),
            Value::Null
        );
        assert_eq!(
            configuration_section_value(&configuration, None),
            configuration
        );
    }

    #[test]
    fn server_message_requests_preserve_action_payloads_and_validate_indices() {
        let parsed = parse_show_message_request(Some(&json!({
            "type": 2,
            "message": "Choose",
            "actions": [{ "title": "Keep", "command": "keep" }, { "title": "Drop" }]
        })))
        .expect("valid message request");
        assert_eq!(parsed.message_type, 2);
        assert_eq!(parsed.actions[0]["command"], "keep");
        assert!(
            parse_show_message_request(Some(&json!({
                "type": 2,
                "message": "Choose",
                "actions": [{ "label": "missing title" }]
            })))
            .is_none()
        );
    }

    #[test]
    fn progress_tokens_are_type_sensitive_and_percentages_are_bounded() {
        assert_ne!(
            progress_token_key(&json!(1)),
            progress_token_key(&json!("1"))
        );
        assert_eq!(
            progress_percentage(&json!({ "percentage": 120 })),
            Some(100)
        );
        assert_eq!(progress_percentage(&json!({ "percentage": 42 })), Some(42));
        assert!(is_progress_token(&json!("build")));
        assert!(!is_progress_token(&Value::Null));
    }

    #[test]
    fn unknown_server_request_uses_standard_json_rpc_method_not_found_code() {
        assert_eq!(JSON_RPC_METHOD_NOT_FOUND, -32601);
        assert_eq!(LSP_REQUEST_CANCELLED, -32800);
    }

    #[test]
    fn detects_fernflower_decompiler_banner() {
        let decompiled =
            format!("{JDTLS_DECOMPILER_HEADER} (from Intellij IDEA).\npackage java.lang;\n");
        assert!(is_decompiled_contents(&decompiled));
        // Leading blank lines still count (jdtls hands us the banner verbatim).
        assert!(is_decompiled_contents(&format!("\n{decompiled}")));
        assert!(!is_decompiled_contents(
            "package java.lang;\npublic class String {}\n"
        ));
        assert!(!is_decompiled_contents(""));
    }

    #[test]
    fn jdtls_data_dir_is_stable_per_project_and_distinct_across_projects() {
        let a1 = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\a" } else { "/a" }));
        let a2 = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\a" } else { "/a" }));
        let b = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\b" } else { "/b" }));
        assert_eq!(a1, a2, "same project must reuse its index dir");
        assert_ne!(a1, b, "different projects must not share an index dir");
        assert!(a1.starts_with(jdtls_data_root()));
    }

    #[test]
    fn prune_removes_only_indexes_whose_project_is_gone() {
        let base = std::env::temp_dir().join(format!("taomni-jdtls-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let live_project = base.join("live-project");
        std::fs::create_dir_all(&live_project).unwrap();

        // Stand-ins for two index dirs: one for a live project, one for a deleted one.
        let live_index = base.join("index-live");
        let gone_index = base.join("index-gone");
        let no_marker = base.join("index-nomarker");
        for dir in [&live_index, &gone_index, &no_marker] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            live_index.join(JDTLS_WORKSPACE_MARKER),
            live_project.to_string_lossy().as_bytes(),
        )
        .unwrap();
        std::fs::write(
            gone_index.join(JDTLS_WORKSPACE_MARKER),
            base.join("deleted-project").to_string_lossy().as_bytes(),
        )
        .unwrap();

        // Exercise the same predicate prune uses, scoped to this temp tree.
        for entry in std::fs::read_dir(&base).unwrap().flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(project) = std::fs::read_to_string(dir.join(JDTLS_WORKSPACE_MARKER)) else {
                continue;
            };
            let project = project.trim();
            if !project.is_empty() && !Path::new(project).exists() {
                std::fs::remove_dir_all(&dir).unwrap();
            }
        }

        assert!(live_index.is_dir(), "index of a live project must be kept");
        assert!(
            !gone_index.is_dir(),
            "index of a deleted project must be pruned"
        );
        assert!(no_marker.is_dir(), "unmarked dirs are left untouched");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ensure_jdtls_data_dir_creates_dir_and_marker() {
        let base = std::env::temp_dir().join(format!("taomni-jdtls-ensure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data_dir = base.join("index");
        let workspace = base.join("proj");
        ensure_jdtls_data_dir(&data_dir, &workspace).unwrap();
        assert!(data_dir.is_dir());
        let marker = std::fs::read_to_string(data_dir.join(JDTLS_WORKSPACE_MARKER)).unwrap();
        assert_eq!(marker, workspace.to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_jdtls_program_detects_wrapper_names() {
        assert!(is_jdtls_program("jdtls", Path::new("jdtls")));
        assert!(is_jdtls_program(
            r"C:\Users\me\AppData\Local\jdtls-bin\jdtls.cmd",
            Path::new(r"C:\Users\me\AppData\Local\jdtls-bin\jdtls.cmd")
        ));
        assert!(!is_jdtls_program(
            "rust-analyzer",
            Path::new("rust-analyzer")
        ));
    }

    #[test]
    fn windows_cmd_line_quotes_paths_with_spaces() {
        #[cfg(windows)]
        {
            let line = windows_cmd_line(
                Path::new(r"C:\Program Files\tools\server.cmd"),
                &["--stdio".into()],
            );
            assert_eq!(line, r#""C:\Program Files\tools\server.cmd" --stdio"#);
        }
        #[cfg(not(windows))]
        {
            // windows_cmd_line is Windows-only; keep the test compiling.
            assert!(true);
        }
    }

    #[test]
    fn clangd_install_hint_mentions_package_or_path() {
        let hint = install_hint_for("clangd");
        assert!(
            hint.contains("clangd") || hint.contains("llvm") || hint.contains("LLVM"),
            "unexpected clangd hint: {hint}"
        );
    }

    #[tokio::test]
    async fn coalesces_concurrent_session_start_claims() {
        let manager = LspManager::new();
        let start = match manager
            .claim_session("workspace\nrust\n/root\nrust-analyzer", "workspace")
            .await
        {
            LspSessionClaim::Start(start) => start,
            _ => panic!("first claimant must own the session start"),
        };
        let waiter = match manager
            .claim_session("workspace\nrust\n/root\nrust-analyzer", "workspace")
            .await
        {
            LspSessionClaim::Wait(waiter) => waiter,
            _ => panic!("concurrent claimant must wait for the in-flight start"),
        };

        assert!(Arc::ptr_eq(&start, &waiter));
    }

    #[tokio::test]
    async fn broadcasts_start_failure_and_allows_retry() {
        let manager = LspManager::new();
        let key = "workspace\nrust\n/root\nrust-analyzer";
        let start = match manager.claim_session(key, "workspace").await {
            LspSessionClaim::Start(start) => start,
            _ => panic!("first claimant must own the session start"),
        };
        let waiter = match manager.claim_session(key, "workspace").await {
            LspSessionClaim::Wait(waiter) => waiter,
            _ => panic!("concurrent claimant must wait for the in-flight start"),
        };

        let _ = manager
            .finish_session_start(key, &start, Err("initialize failed".into()))
            .await;
        match waiter.wait().await {
            Err(error) => assert_eq!(error, "initialize failed"),
            Ok(_) => panic!("waiter must receive the shared initialization failure"),
        }
        assert!(matches!(
            manager.claim_session(key, "workspace").await,
            LspSessionClaim::Start(_)
        ));
    }

    #[tokio::test]
    async fn stopping_workspace_cancels_start_waiters_and_clears_slot() {
        let manager = LspManager::new();
        let key = "workspace\nrust\n/root\nrust-analyzer";
        let start = match manager.claim_session(key, "workspace").await {
            LspSessionClaim::Start(start) => start,
            _ => panic!("first claimant must own the session start"),
        };
        let waiter = match manager.claim_session(key, "workspace").await {
            LspSessionClaim::Wait(waiter) => waiter,
            _ => panic!("concurrent claimant must wait for the in-flight start"),
        };
        assert!(Arc::ptr_eq(&start, &waiter));

        assert_eq!(manager.stop_workspace("workspace").await, 1);
        match waiter.wait().await {
            Err(error) => assert!(error.contains("workspace stopped")),
            Ok(_) => panic!("workspace shutdown must cancel an in-flight start"),
        }
        assert!(matches!(
            manager.claim_session(key, "workspace").await,
            LspSessionClaim::Start(_)
        ));
    }

    #[test]
    fn flattens_hierarchical_document_symbols_with_depth() {
        let response = json!([
            {
                "name": "OpenFileState",
                "detail": "",
                "kind": 11,
                "range": { "start": { "line": 4, "character": 0 }, "end": { "line": 8, "character": 1 } },
                "selectionRange": { "start": { "line": 4, "character": 10 }, "end": { "line": 4, "character": 23 } },
                "children": [
                    {
                        "name": "path",
                        "detail": "string",
                        "kind": 7,
                        "range": { "start": { "line": 5, "character": 2 }, "end": { "line": 5, "character": 15 } },
                        "selectionRange": { "start": { "line": 5, "character": 2 }, "end": { "line": 5, "character": 6 } }
                    }
                ]
            }
        ]);

        let mut symbols = Vec::new();
        collect_document_symbols(&response, 0, &mut symbols);

        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "OpenFileState");
        assert_eq!(symbols[0].depth, 0);
        assert_eq!(symbols[0].detail, None);
        assert_eq!(symbols[0].selection_range.start.character, 10);
        assert_eq!(symbols[1].name, "path");
        assert_eq!(symbols[1].depth, 1);
        assert_eq!(symbols[1].detail.as_deref(), Some("string"));
    }

    #[test]
    fn accepts_flat_symbol_information_responses() {
        let response = json!([
            {
                "name": "workspace_read_file",
                "kind": 12,
                "containerName": "workspace",
                "location": {
                    "uri": "file:///repo/src/workspace.rs",
                    "range": { "start": { "line": 3, "character": 0 }, "end": { "line": 12, "character": 1 } }
                }
            },
            { "name": "missing range" }
        ]);

        let mut symbols = Vec::new();
        collect_document_symbols(&response, 0, &mut symbols);

        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "workspace_read_file");
        assert_eq!(symbols[0].kind, 12);
        assert_eq!(symbols[0].detail.as_deref(), Some("workspace"));
        assert_eq!(symbols[0].selection_range.start.line, 3);
    }

    #[test]
    fn ignores_null_and_non_array_responses() {
        let mut symbols = Vec::new();
        collect_document_symbols(&Value::Null, 0, &mut symbols);
        collect_document_symbols(&json!({ "unexpected": true }), 0, &mut symbols);
        assert!(symbols.is_empty());
    }

    #[test]
    fn summarizes_server_capabilities_across_provider_shapes() {
        let summary = capability_summary_from(&json!({
            "completionProvider": { "triggerCharacters": [".", "::"], "resolveProvider": true },
            "signatureHelpProvider": { "triggerCharacters": ["(", ","] },
            "hoverProvider": true,
            "workspaceSymbolProvider": { "resolveProvider": true },
            "renameProvider": { "prepareProvider": true },
            "selectionRangeProvider": true,
            "documentFormattingProvider": false,
            "typeHierarchyProvider": null,
        }));

        assert!(summary.completion);
        assert_eq!(summary.completion_trigger_characters, vec![".", "::"]);
        assert!(summary.signature_help);
        assert_eq!(summary.signature_trigger_characters, vec!["(", ","]);
        assert!(summary.hover);
        assert!(summary.rename);
        assert!(summary.selection_range);
        assert!(!summary.formatting);
        assert!(!summary.type_hierarchy);
        assert!(summary.workspace_symbol);
        assert!(summary.workspace_symbol_resolve);
    }

    #[test]
    fn dynamic_workspace_symbol_capability_tracks_resolve_provider() {
        let registration = DynamicCapabilityRegistration {
            id: "workspace-symbols".into(),
            method: "workspace/symbol".into(),
            register_options: json!({ "resolveProvider": true }),
        };
        let (summary, _, _, _) = capability_state_from(&json!({}), &[registration]);

        assert!(summary.workspace_symbol);
        assert!(summary.workspace_symbol_resolve);
    }

    #[test]
    fn parses_diagnostic_metadata_and_bounds_provider_data() {
        let related = json!({
            "location": {
                "uri": "file:///repo/src/sink.ts",
                "range": { "start": { "line": 2, "character": 1 }, "end": { "line": 2, "character": 4 } }
            },
            "message": "value reaches sink"
        });
        let value = json!({
            "range": { "start": { "line": 1, "character": 0 }, "end": { "line": 1, "character": 2 } },
            "severity": 2,
            "code": 6133,
            "source": "typescript",
            "message": "unused",
            "tags": [1, 2, 9],
            "relatedInformation": [related],
            "codeDescription": { "href": "https://example.test/6133" },
            "data": { "rule": "unused" }
        });
        let parsed = parse_diagnostic(&value).expect("diagnostic");
        assert_eq!(parsed.code.as_deref(), Some("6133"));
        assert_eq!(parsed.tags, vec![1, 2]);
        assert_eq!(parsed.related_information.len(), 1);
        assert_eq!(
            parsed.code_description.as_deref(),
            Some("https://example.test/6133")
        );
        assert_eq!(parsed.data, Some(json!({ "rule": "unused" })));

        let oversized = json!({ "payload": "x".repeat(64 * 1024) });
        assert!(bounded_diagnostic_data(&oversized).is_none());
    }

    #[test]
    fn code_action_context_omits_empty_only_and_trims_kinds() {
        let without_only = code_action_context(vec![], Some(vec![" ".into(), "".into()]));
        assert!(without_only.get("only").is_none());
        let with_only = code_action_context(
            vec![],
            Some(vec![" refactor.extract ".into(), "quickfix".into()]),
        );
        assert_eq!(with_only["only"], json!(["refactor.extract", "quickfix"]));
        assert_eq!(with_only["triggerKind"], json!(1));
    }

    #[test]
    fn dynamic_capabilities_register_and_unregister_independently() {
        let base = json!({ "hoverProvider": true });
        let params = json!({
            "registrations": [
                {
                    "id": "completion-one",
                    "method": "textDocument/completion",
                    "registerOptions": { "triggerCharacters": ["."] }
                },
                {
                    "id": "completion-two",
                    "method": "textDocument/completion",
                    "registerOptions": { "triggerCharacters": [":"] }
                },
                {
                    "id": "semantic",
                    "method": "textDocument/semanticTokens",
                    "registerOptions": {
                        "legend": { "tokenTypes": ["class"], "tokenModifiers": ["static"] },
                        "full": { "delta": true }
                    }
                }
            ]
        });
        let registrations = parse_dynamic_capability_registrations(Some(&params));
        let (summary, token_types, token_modifiers, delta) =
            capability_state_from(&base, &registrations);
        assert!(summary.hover);
        assert!(summary.completion);
        assert_eq!(summary.completion_trigger_characters, vec![".", ":"]);
        assert!(summary.semantic_tokens);
        assert_eq!(token_types, vec!["class"]);
        assert_eq!(token_modifiers, vec!["static"]);
        assert!(delta);

        let unregister = json!({
            "unregisterations": [{ "id": "completion-one", "method": "textDocument/completion" }]
        });
        assert_eq!(
            parse_dynamic_capability_unregistrations(Some(&unregister)),
            vec!["completion-one"]
        );
        let remaining = registrations
            .into_iter()
            .filter(|registration| registration.id != "completion-one")
            .collect::<Vec<_>>();
        let (summary, _, _, _) = capability_state_from(&base, &remaining);
        assert!(summary.completion);
        assert_eq!(summary.completion_trigger_characters, vec![":"]);
    }

    #[test]
    fn dynamic_capability_request_validation_accepts_empty_and_rejects_malformed_entries() {
        let empty = json!({ "registrations": [] });
        assert_eq!(
            parse_dynamic_capability_registrations_checked(Some(&empty)).unwrap(),
            Vec::<DynamicCapabilityRegistration>::new()
        );
        assert!(parse_dynamic_capability_registrations_checked(None).is_err());
        assert!(parse_dynamic_capability_registrations_checked(Some(&json!({}))).is_err());
        assert!(
            parse_dynamic_capability_registrations_checked(Some(&json!({
                "registrations": [{ "id": "", "method": "textDocument/hover" }]
            })))
            .is_err()
        );
        assert!(
            parse_dynamic_capability_registrations_checked(Some(&json!({
                "registrations": [{ "id": "hover", "method": 42 }]
            })))
            .is_err()
        );

        let unregister_empty = json!({ "unregisterations": [] });
        assert_eq!(
            parse_dynamic_capability_unregistrations_checked(Some(&unregister_empty)).unwrap(),
            Vec::<String>::new()
        );
        assert!(
            parse_dynamic_capability_unregistrations_checked(Some(&json!({
                "unregisterations": [{ "id": "" }]
            })))
            .is_err()
        );
    }

    #[test]
    fn reads_text_document_sync_kind_and_falls_back_to_full_changes() {
        assert_eq!(
            text_document_sync_kind(&json!({ "textDocumentSync": 2 })),
            2
        );
        assert_eq!(
            text_document_sync_kind(&json!({ "textDocumentSync": { "change": 2 } })),
            2
        );
        assert_eq!(
            text_document_sync_kind(&json!({ "textDocumentSync": 0 })),
            0
        );
        assert_eq!(text_document_sync_kind(&json!({})), 1);

        let incremental = LspDocumentContentChange {
            range: LspRange {
                start: LspPosition {
                    line: 1,
                    character: 4,
                },
                end: LspPosition {
                    line: 1,
                    character: 7,
                },
            },
            range_length: 3,
            text: "replacement".into(),
        };
        assert_eq!(
            content_change_for_sync(Some("full text".into()), Some(incremental.clone()), 2)
                .unwrap(),
            json!({
                "range": {
                    "start": { "line": 1, "character": 4 },
                    "end": { "line": 1, "character": 7 }
                },
                "rangeLength": 3,
                "text": "replacement"
            })
        );
        assert_eq!(
            content_change_for_sync(Some("full text".into()), Some(incremental), 1).unwrap(),
            json!({ "text": "full text" })
        );
        assert!(content_change_for_sync(None, None, 1).is_err());
    }

    #[test]
    fn associates_and_removes_pending_requests_by_document_uri() {
        let uri = "file:///repo/src/main.rs";
        assert_eq!(
            request_document_uri(&json!({ "textDocument": { "uri": uri } })),
            Some(uri)
        );
        assert_eq!(
            request_document_uri(&json!({ "item": { "uri": uri } })),
            Some(uri)
        );

        let (document_sender, _document_receiver) = oneshot::channel();
        let (workspace_sender, _workspace_receiver) = oneshot::channel();
        let mut pending = HashMap::from([
            (
                1,
                PendingResponse {
                    sender: document_sender,
                    document_uri: Some(uri.into()),
                },
            ),
            (
                2,
                PendingResponse {
                    sender: workspace_sender,
                    document_uri: None,
                },
            ),
        ]);

        let cancelled = take_pending_for_document(&mut pending, uri);
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].0, 1);
        assert!(pending.contains_key(&2));
    }

    #[test]
    fn caches_command_availability_until_explicit_refresh() {
        let directory = tempfile::tempdir().unwrap();
        let command_path = directory.path().join("temporary-language-server");
        std::fs::write(&command_path, b"test").unwrap();
        let command = command_path.to_string_lossy().into_owned();
        command_availability_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&command);

        assert!(command_available(&command));
        std::fs::remove_file(&command_path).unwrap();
        assert!(command_available(&command));

        command_availability_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&command);
        assert!(!command_available(&command));
    }

    #[test]
    fn treats_rust_analyzer_next_to_rustup_as_a_shim() {
        let directory = tempfile::tempdir().unwrap();
        let shim = directory
            .path()
            .join(format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&shim, b"test").unwrap();

        // No sibling rustup: a plain binary, taken at face value.
        assert!(!is_rustup_shim(&shim));

        std::fs::write(
            directory
                .path()
                .join(format!("rustup{}", std::env::consts::EXE_SUFFIX)),
            b"test",
        )
        .unwrap();
        assert!(is_rustup_shim(&shim));

        // Other binaries in the same directory are not rustup proxies.
        let other = directory
            .path()
            .join(format!("gopls{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&other, b"test").unwrap();
        assert!(!is_rustup_shim(&other));
    }

    #[test]
    fn reports_unrunnable_rustup_shim_as_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        // Not a real executable, so `--version` cannot succeed — stands in for a
        // shim whose component was never added.
        let shim = directory
            .path()
            .join(format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&shim, b"test").unwrap();
        std::fs::write(
            directory
                .path()
                .join(format!("rustup{}", std::env::consts::EXE_SUFFIX)),
            b"test",
        )
        .unwrap();

        let command = shim.to_string_lossy().into_owned();
        command_availability_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&command);
        assert!(!command_available(&command));
    }

    #[test]
    fn parses_completion_lists_and_bare_arrays() {
        let (incomplete, items) = parse_completion_response(&json!({
            "isIncomplete": true,
            "items": [
                {
                    "label": "openFile",
                    "kind": 3,
                    "detail": "(path: string) => Promise<void>",
                    "sortText": "11",
                    "insertTextFormat": 2,
                    "insertText": "openFile(${1:path})",
                    "textEdit": {
                        "newText": "openFile",
                        "insert": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 8 } },
                        "replace": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 10 } }
                    },
                    "additionalTextEdits": [
                        {
                            "newText": "import { openFile } from \"./files\";\n",
                            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }
                        }
                    ]
                },
                { "noLabel": true }
            ]
        }));

        assert!(incomplete);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.label, "openFile");
        assert_eq!(item.insert_text_format, Some(2));
        // InsertReplaceEdit prefers the insert range.
        assert_eq!(item.text_edit.as_ref().unwrap().range.end.character, 8);
        assert_eq!(item.additional_text_edits.len(), 1);
        assert!(item.raw.get("label").is_some());

        let (incomplete, items) = parse_completion_response(&json!([{ "label": "bare" }]));
        assert!(!incomplete);
        assert_eq!(items[0].label, "bare");

        let (_, empty) = parse_completion_response(&Value::Null);
        assert!(empty.is_empty());
    }

    #[test]
    fn parses_signature_help_with_offset_parameter_labels() {
        let (signatures, active_signature, active_parameter) = parse_signature_help(&json!({
            "signatures": [{
                "label": "openFile(path: string, preview: boolean): void",
                "documentation": "Opens a file.",
                "parameters": [
                    { "label": "path: string" },
                    { "label": [23, 39], "documentation": { "kind": "markdown", "value": "preview flag" } }
                ]
            }],
            "activeSignature": 0,
            "activeParameter": 1
        }));

        assert_eq!(signatures.len(), 1);
        assert_eq!(active_signature, 0);
        assert_eq!(active_parameter, 1);
        let signature = &signatures[0];
        assert_eq!(signature.parameters[0].label, "path: string");
        assert_eq!(signature.parameters[1].label, "preview: boolean");
        assert_eq!(signature.parameters[1].label_start, Some(23));
        assert_eq!(
            signature.parameters[1].documentation.as_deref(),
            Some("preview flag")
        );
    }

    #[test]
    fn parses_formatting_text_edit_arrays() {
        let edits = parse_text_edits(&json!([
            {
                "range": {
                    "start": { "line": 0, "character": 0 },
                    "end": { "line": 0, "character": 4 }
                },
                "newText": "  x"
            },
            { "newText": "missing range" },
            {
                "range": {
                    "start": { "line": 1, "character": 0 },
                    "end": { "line": 1, "character": 0 }
                },
                "newText": "\n"
            }
        ]));
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].new_text, "  x");
        assert_eq!(edits[0].range.start.line, 0);
        assert_eq!(edits[1].new_text, "\n");
        assert!(parse_text_edits(&Value::Null).is_empty());
        assert!(parse_text_edits(&json!({ "not": "array" })).is_empty());
    }

    #[test]
    fn parses_workspace_symbol_information() {
        let symbols = parse_workspace_symbols(&json!([
            {
                "name": "CodeWorkspaceTab",
                "kind": 5,
                "containerName": "editor",
                "location": {
                    "uri": "file:///repo/src/CodeWorkspaceTab.tsx",
                    "range": {
                        "start": { "line": 10, "character": 0 },
                        "end": { "line": 40, "character": 1 }
                    }
                }
            },
            { "name": "no location" }
        ]));
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "CodeWorkspaceTab");
        assert_eq!(symbols[0].kind, 5);
        assert_eq!(symbols[0].container_name.as_deref(), Some("editor"));
        assert_eq!(symbols[0].range.start.line, 10);
        assert!(symbols[0].resolved);
        assert!(symbols[0].resolve_token.is_none());
    }

    #[test]
    fn parses_uri_only_workspace_symbol_as_unresolved() {
        let symbol = parse_workspace_symbol(&json!({
            "name": "DeferredType",
            "kind": 5,
            "location": { "uri": "file:///repo/src/deferred.ts" },
            "data": { "providerHandle": 42 }
        }))
        .expect("URI-only workspace symbol");

        assert!(!symbol.resolved);
        assert_eq!(symbol.range.start.line, 0);
        assert_eq!(symbol.selection_range.start.character, 0);
        assert!(symbol.resolve_token.is_none());
    }

    #[test]
    fn aggregates_workspace_symbols_deterministically_and_deduplicates() {
        let response = |name: &str, path: &str| {
            json!([{
                "name": name,
                "kind": 5,
                "location": {
                    "uri": format!("file://{path}"),
                    "range": {
                        "start": { "line": 1, "character": 0 },
                        "end": { "line": 1, "character": 3 }
                    }
                }
            }])
        };
        let result = aggregate_workspace_symbol_responses(
            vec![
                (
                    "TypeScript".into(),
                    "typescript-session".into(),
                    false,
                    Ok(response("B", "/repo/b.ts")),
                ),
                (
                    "Java".into(),
                    "java-session".into(),
                    false,
                    Ok(response("A", "/repo/a.java")),
                ),
                (
                    "duplicate".into(),
                    "duplicate-session".into(),
                    false,
                    Ok(response("B", "/repo/b.ts")),
                ),
            ],
            3,
            3,
            0,
            false,
        );
        assert!(result.complete);
        assert_eq!(result.symbols.len(), 2);
        assert_eq!(result.symbols[0].name, "A");
        assert_eq!(result.symbols[1].name, "B");
        assert_eq!(result.failed_provider_count, 0);
    }

    #[test]
    fn marks_failed_and_malformed_workspace_symbol_providers_incomplete() {
        let result = aggregate_workspace_symbol_responses(
            vec![
                (
                    "broken".into(),
                    "broken-session".into(),
                    false,
                    Err("request timeout".into()),
                ),
                (
                    "malformed".into(),
                    "malformed-session".into(),
                    false,
                    Ok(json!([{ "name": "missing location" }])),
                ),
            ],
            2,
            2,
            0,
            false,
        );
        assert!(!result.complete);
        assert_eq!(result.failed_provider_count, 2);
        assert_eq!(result.symbols.len(), 0);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.contains("timeout"))
        );
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.contains("malformed"))
        );
    }

    #[test]
    fn marks_missing_providers_and_provider_limit_as_bounded() {
        let result = aggregate_workspace_symbol_responses(
            vec![(
                "TypeScript".into(),
                "typescript-session".into(),
                false,
                Ok(Value::Array(Vec::new())),
            )],
            65,
            1,
            64,
            true,
        );
        assert!(!result.complete);
        assert!(result.truncated);
        assert_eq!(result.skipped_provider_count, 64);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.contains("limited to"))
        );
    }

    #[test]
    fn reports_no_provider_without_claiming_complete_index() {
        let result = aggregate_workspace_symbol_responses(Vec::new(), 0, 0, 0, false);
        assert!(!result.complete);
        assert!(!result.truncated);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.contains("No active language server"))
        );
    }

    #[test]
    fn preserves_deferred_symbol_payload_only_for_resolve_provider() {
        let uri_only = json!([{
            "name": "DeferredType",
            "kind": 5,
            "location": { "uri": "file:///repo/src/deferred.ts" },
            "data": { "providerHandle": 42 }
        }]);
        let supported = aggregate_workspace_symbol_responses(
            vec![(
                "TypeScript".into(),
                "typescript-session".into(),
                true,
                Ok(uri_only.clone()),
            )],
            1,
            1,
            0,
            false,
        );
        assert!(supported.complete);
        assert!(!supported.symbols[0].resolved);
        assert_eq!(
            supported.symbols[0].provider_session_key.as_deref(),
            Some("typescript-session")
        );
        assert_eq!(supported.symbols[0].raw.as_ref(), Some(&uri_only[0]));

        let unsupported = aggregate_workspace_symbol_responses(
            vec![(
                "Legacy".into(),
                "legacy-session".into(),
                false,
                Ok(uri_only),
            )],
            1,
            1,
            0,
            false,
        );
        assert!(!unsupported.complete);
        assert_eq!(unsupported.failed_provider_count, 1);
        assert!(unsupported.symbols[0].raw.is_none());
        assert!(
            unsupported
                .diagnostics
                .iter()
                .any(|item| item.contains("without advertising"))
        );
    }

    #[test]
    fn validates_and_merges_workspace_symbol_resolve_payloads() {
        assert_eq!(
            parse_workspace_symbol_resolve_token("0123456789abcdef0123456789abcdef:17"),
            Ok(("0123456789abcdef0123456789abcdef", "17"))
        );
        for invalid in [
            "",
            "short:1",
            "0123456789abcdef0123456789abcdeg:1",
            "0123456789abcdef0123456789abcdef:-1",
        ] {
            assert!(parse_workspace_symbol_resolve_token(invalid).is_err());
        }

        let original = json!({
            "name": "DeferredType",
            "kind": 5,
            "location": { "uri": "file:///repo/src/deferred.ts" },
            "data": { "providerHandle": 42 }
        });
        let response = json!({
            "location": {
                "range": {
                    "start": { "line": 8, "character": 2 },
                    "end": { "line": 8, "character": 14 }
                }
            }
        });
        let resolved = parse_workspace_symbol(&merge_workspace_symbol_values(&original, &response))
            .expect("resolved symbol");
        assert!(resolved.resolved);
        assert_eq!(resolved.selection_range.start.line, 8);
        assert_eq!(resolved.name, "DeferredType");
    }

    #[test]
    fn newer_workspace_symbol_query_cancels_previous_generation() {
        let mut queries = HashMap::new();
        let first = begin_workspace_symbol_query(&mut queries, "workspace", 1);
        assert!(!first.is_cancelled());

        let second = begin_workspace_symbol_query(&mut queries, "workspace", 2);
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert_eq!(queries.get("workspace").map(|(id, _)| *id), Some(2));
    }

    #[tokio::test]
    async fn stopping_workspace_cancels_symbol_query_and_clears_resolve_batches() {
        let manager = LspManager::new();
        let cancellation = {
            let mut queries = manager.workspace_symbol_queries.lock().await;
            begin_workspace_symbol_query(&mut queries, "workspace", 1)
        };
        manager.workspace_symbol_resolutions.lock().await.insert(
            "0123456789abcdef0123456789abcdef".into(),
            WorkspaceSymbolResolutionBatch {
                workspace_id: "workspace".into(),
                created_at: Instant::now(),
                bytes: 0,
                entries: HashMap::new(),
            },
        );

        assert_eq!(manager.stop_workspace("workspace").await, 0);
        assert!(cancellation.is_cancelled());
        assert!(manager.workspace_symbol_queries.lock().await.is_empty());
        assert!(manager.workspace_symbol_resolutions.lock().await.is_empty());
    }

    #[test]
    fn parses_code_actions_and_workspace_edits() {
        let actions = parse_code_actions(&json!([
            {
                "title": "Add import",
                "kind": "quickfix",
                "isPreferred": true,
                "edit": {
                    "changes": {
                        "file:///repo/src/a.ts": [{
                            "range": {
                                "start": { "line": 0, "character": 0 },
                                "end": { "line": 0, "character": 0 }
                            },
                            "newText": "import x from 'x';\n"
                        }]
                    }
                }
            },
            {
                "title": "Organize Imports",
                "command": { "command": "source.organizeImports", "arguments": [] }
            },
            { "noTitle": true }
        ]));
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].title, "Add import");
        assert!(actions[0].is_preferred);
        assert_eq!(actions[0].edit.as_ref().unwrap().document_edits.len(), 1);
        assert_eq!(
            actions[1].command.as_deref(),
            Some("source.organizeImports")
        );
    }

    #[test]
    fn code_action_resolve_merges_deferred_fields_with_original_data() {
        let original = json!({
            "title": "Add import",
            "kind": "quickfix",
            "data": { "fixId": 7 }
        });
        let resolved = json!({
            "title": "Add import",
            "edit": {
                "changes": {
                    "file:///repo/src/main.ts": [{
                        "range": {
                            "start": { "line": 0, "character": 0 },
                            "end": { "line": 0, "character": 0 }
                        },
                        "newText": "import x;\n"
                    }]
                }
            }
        });

        let merged = merge_code_action_values(&original, &resolved);
        assert_eq!(merged["data"]["fixId"], 7);
        let parsed = parse_code_action(&merged).expect("merged CodeAction should parse");
        assert_eq!(parsed.kind.as_deref(), Some("quickfix"));
        assert_eq!(
            parsed.edit.as_ref().map(|edit| edit.document_edits.len()),
            Some(1)
        );
        assert_eq!(parsed.raw["data"]["fixId"], 7);
    }

    #[test]
    fn preserves_workspace_edit_resource_operation_order_and_options() {
        let edit = parse_workspace_edit(&json!({
            "changeAnnotations": {
                "text-1": {
                    "label": "Update generated source",
                    "needsConfirmation": true,
                    "description": "The file is generated"
                },
                "rename-1": { "label": "Rename generated source" }
            },
            "documentChanges": [
                {
                    "kind": "create",
                    "uri": "file:///repo/src/new.ts",
                    "options": { "overwrite": true, "ignoreIfExists": false }
                },
                {
                    "textDocument": { "uri": "file:///repo/src/new.ts", "version": 1 },
                    "edits": [{
                        "range": {
                            "start": { "line": 0, "character": 0 },
                            "end": { "line": 0, "character": 0 }
                        },
                        "newText": "content",
                        "annotationId": "text-1"
                    }]
                },
                {
                    "kind": "rename",
                    "oldUri": "file:///repo/src/new.ts",
                    "newUri": "file:///repo/src/final.ts",
                    "annotationId": "rename-1",
                    "options": { "ignoreIfExists": true }
                },
                {
                    "kind": "delete",
                    "uri": "file:///repo/src/final.ts",
                    "options": { "recursive": true, "ignoreIfNotExists": true }
                }
            ]
        }));
        assert_eq!(edit.operations.len(), 4);
        assert_eq!(edit.document_edits.len(), 1);
        assert_eq!(edit.change_annotations.len(), 2);
        assert_eq!(edit.change_annotations[1].id, "text-1");
        assert!(edit.change_annotations[1].needs_confirmation);
        assert!(matches!(
            &edit.operations[0],
            LspWorkspaceEditOperation::Create {
                overwrite: true,
                ..
            }
        ));
        assert!(matches!(
            &edit.operations[1],
            LspWorkspaceEditOperation::Text { document }
                if document.edits.len() == 1
                    && document.version == Some(1)
                    && document.annotation_ids == ["text-1"]
        ));
        assert!(matches!(
            &edit.operations[2],
            LspWorkspaceEditOperation::Rename {
                ignore_if_exists: true,
                annotation_id: Some(annotation_id),
                ..
            } if annotation_id == "rename-1"
        ));
        assert!(matches!(
            &edit.operations[3],
            LspWorkspaceEditOperation::Delete {
                recursive: true,
                ignore_if_not_exists: true,
                ..
            }
        ));
    }

    #[test]
    fn serializes_workspace_edit_and_apply_response_with_camel_case_contract() {
        let edit = LspWorkspaceEdit {
            document_edits: Vec::new(),
            operations: vec![LspWorkspaceEditOperation::Rename {
                old_uri: "file:///repo/old.ts".into(),
                old_path: Some("/repo/old.ts".into()),
                new_uri: "file:///repo/new.ts".into(),
                new_path: Some("/repo/new.ts".into()),
                overwrite: true,
                ignore_if_exists: false,
                annotation_id: Some("rename-1".into()),
            }],
            change_annotations: vec![LspChangeAnnotation {
                id: "rename-1".into(),
                label: "Rename source".into(),
                needs_confirmation: true,
                description: Some("Public API change".into()),
            }],
        };
        let value = serde_json::to_value(edit).unwrap();
        assert_eq!(value["documentEdits"], json!([]));
        assert_eq!(value["operations"][0]["kind"], "rename");
        assert_eq!(value["operations"][0]["oldUri"], "file:///repo/old.ts");
        assert_eq!(value["operations"][0]["newPath"], "/repo/new.ts");
        assert_eq!(value["operations"][0]["ignoreIfExists"], false);
        assert_eq!(value["operations"][0]["annotationId"], "rename-1");
        assert_eq!(value["changeAnnotations"][0]["needsConfirmation"], true);

        let response = serde_json::to_value(LspWorkspaceApplyEditResponse {
            applied: false,
            failure_reason: Some("disk changed".into()),
            failed_change: Some(2),
        })
        .unwrap();
        assert_eq!(
            response,
            json!({
                "applied": false,
                "failureReason": "disk changed",
                "failedChange": 2
            })
        );
    }

    #[tokio::test]
    async fn workspace_apply_edit_bridge_validates_workspace_before_resolving() {
        let bridge = LspClientRequestBridge::new();
        let (sender, receiver) = oneshot::channel();
        bridge.pending_workspace_edits.lock().unwrap().insert(
            "request-1".into(),
            PendingWorkspaceApplyEdit {
                workspace_id: "workspace-a".into(),
                sender,
            },
        );
        let response = LspWorkspaceApplyEditResponse {
            applied: false,
            failure_reason: Some("hash mismatch".into()),
            failed_change: Some(1),
        };

        let mismatch = bridge
            .resolve_workspace_edit("request-1", "workspace-b", response.clone())
            .unwrap_err();
        assert!(mismatch.contains("does not match"));
        assert!(
            bridge
                .pending_workspace_edits
                .lock()
                .unwrap()
                .contains_key("request-1")
        );

        bridge
            .resolve_workspace_edit("request-1", "workspace-a", response.clone())
            .unwrap();
        let received = receiver.await.unwrap();
        assert_eq!(received.applied, response.applied);
        assert_eq!(received.failure_reason, response.failure_reason);
        assert_eq!(received.failed_change, response.failed_change);
        assert!(
            bridge
                .resolve_workspace_edit("request-1", "workspace-a", response)
                .unwrap_err()
                .contains("no pending")
        );
    }

    #[tokio::test]
    async fn workspace_apply_edit_bridge_fails_when_frontend_is_unavailable() {
        let bridge = LspClientRequestBridge::new();
        let response = bridge
            .apply_workspace_edit("workspace-a", None, LspWorkspaceEdit::default())
            .await;
        assert!(!response.applied);
        assert!(
            response
                .failure_reason
                .as_deref()
                .unwrap_or_default()
                .contains("frontend is unavailable")
        );
    }

    #[tokio::test]
    async fn show_message_bridge_validates_workspace_and_action_index() {
        let bridge = LspClientRequestBridge::new();
        let (sender, receiver) = oneshot::channel();
        bridge.pending_show_messages.lock().unwrap().insert(
            "message-1".into(),
            PendingShowMessageRequest {
                workspace_id: "workspace-a".into(),
                actions: vec![json!({ "title": "Keep", "value": 1 })],
                sender,
            },
        );
        assert!(
            bridge
                .resolve_show_message("message-1", "workspace-b", Some(0))
                .unwrap_err()
                .contains("target workspace")
        );
        assert!(
            bridge
                .resolve_show_message("message-1", "workspace-a", Some(3))
                .unwrap_err()
                .contains("out of range")
        );
        bridge
            .resolve_show_message("message-1", "workspace-a", Some(0))
            .unwrap();
        assert_eq!(
            receiver.await.unwrap(),
            Some(json!({ "title": "Keep", "value": 1 }))
        );
    }

    #[test]
    fn parses_hierarchy_items_and_preserves_opaque_data() {
        let items = parse_hierarchy_items(&json!([{
            "name": "renderEditor",
            "detail": "CodeWorkspaceTab",
            "kind": 12,
            "uri": "file:///repo/src/editor.ts",
            "range": {
                "start": { "line": 8, "character": 0 },
                "end": { "line": 20, "character": 1 }
            },
            "selectionRange": {
                "start": { "line": 8, "character": 9 },
                "end": { "line": 8, "character": 21 }
            },
            "data": { "serverId": 42 }
        }]));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "renderEditor");
        assert_eq!(items[0].detail.as_deref(), Some("CodeWorkspaceTab"));
        assert_eq!(items[0].selection_range.start.character, 9);
        assert_eq!(items[0].raw["data"]["serverId"], 42);
    }

    #[test]
    fn parses_incoming_and_outgoing_call_entries() {
        let item = json!({
            "name": "caller",
            "kind": 12,
            "uri": "file:///repo/src/caller.ts",
            "range": {
                "start": { "line": 1, "character": 0 },
                "end": { "line": 4, "character": 1 }
            },
            "selectionRange": {
                "start": { "line": 1, "character": 9 },
                "end": { "line": 1, "character": 15 }
            }
        });
        let range = json!({
            "start": { "line": 3, "character": 2 },
            "end": { "line": 3, "character": 8 }
        });
        let incoming = parse_call_hierarchy_entries(
            &json!([{ "from": item.clone(), "fromRanges": [range.clone()] }]),
            "from",
        );
        let outgoing =
            parse_call_hierarchy_entries(&json!([{ "to": item, "fromRanges": [range] }]), "to");
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].item.name, "caller");
        assert_eq!(incoming[0].from_ranges[0].start.line, 3);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].item.name, "caller");
    }

    #[test]
    fn parses_highlights_inlay_hints_and_selection_ranges() {
        let highlights = parse_document_highlights(&json!([
            {
                "range": {
                    "start": { "line": 1, "character": 2 },
                    "end": { "line": 1, "character": 5 }
                },
                "kind": 3
            },
            { "invalid": true }
        ]));
        assert_eq!(highlights.len(), 1);
        assert_eq!(highlights[0].kind, Some(3));

        let hints = parse_inlay_hints(&json!([
            {
                "position": { "line": 2, "character": 8 },
                "label": [{ "value": "value" }, { "value": ": number" }],
                "kind": 1,
                "tooltip": { "kind": "markdown", "value": "inferred type" },
                "paddingLeft": true
            }
        ]));
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].label, "value: number");
        assert_eq!(hints[0].tooltip.as_deref(), Some("inferred type"));
        assert!(hints[0].padding_left);

        let ranges = parse_selection_ranges(&json!([{
            "range": {
                "start": { "line": 3, "character": 4 },
                "end": { "line": 3, "character": 8 }
            },
            "parent": {
                "range": {
                    "start": { "line": 3, "character": 0 },
                    "end": { "line": 3, "character": 10 }
                }
            }
        }]));
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].start.character, 4);
        assert_eq!(ranges[1].start.character, 0);
    }

    #[test]
    fn parses_semantic_tokens_relative_data() {
        let (types, modifiers) = semantic_token_legend_from(&json!({
            "semanticTokensProvider": {
                "legend": {
                    "tokenTypes": ["variable", "function", "class"],
                    "tokenModifiers": ["declaration", "readonly"]
                }
            }
        }));
        assert_eq!(types, vec!["variable", "function", "class"]);
        assert_eq!(modifiers, vec!["declaration", "readonly"]);

        // Token A at 0:0 len 3 type variable+declaration
        // Token B same line start+4 len 5 type function
        let tokens = parse_semantic_tokens(
            &json!({ "data": [0, 0, 3, 0, 1, 0, 4, 5, 1, 0] }),
            &types,
            &modifiers,
        );
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].token_type, "variable");
        assert_eq!(tokens[0].modifiers, vec!["declaration"]);
        assert_eq!(tokens[0].range.start.character, 0);
        assert_eq!(tokens[0].range.end.character, 3);
        assert_eq!(tokens[1].token_type, "function");
        assert_eq!(tokens[1].range.start.character, 4);
        assert_eq!(tokens[1].range.end.character, 9);
    }

    #[test]
    fn applies_semantic_token_delta_edits_and_detects_capability() {
        let capabilities = json!({
            "semanticTokensProvider": {
                "legend": { "tokenTypes": ["variable"], "tokenModifiers": [] },
                "full": { "delta": true }
            }
        });
        assert!(semantic_token_delta_supported(&capabilities));
        let previous = SemanticTokensCache {
            result_id: "one".into(),
            data: vec![0, 0, 3, 0, 0, 0, 4, 2, 0, 0],
        };
        let (data, result_id) = apply_semantic_token_delta(
            &previous,
            &json!({
                "resultId": "two",
                "edits": [{ "start": 5, "deleteCount": 5, "data": [1, 1, 4, 0, 0] }]
            }),
        )
        .unwrap();
        assert_eq!(result_id.as_deref(), Some("two"));
        assert_eq!(data, vec![0, 0, 3, 0, 0, 1, 1, 4, 0, 0]);
        assert!(
            apply_semantic_token_delta(
                &previous,
                &json!({ "edits": [{ "start": 99, "deleteCount": 1 }] }),
            )
            .is_none()
        );
    }

    #[test]
    fn path_from_uri_maps_file_uris_and_rejects_class_uris() {
        #[cfg(windows)]
        {
            let path = path_from_uri("file:///C:/Users/test/Project/Main.java").unwrap();
            assert!(
                path.replace('\\', "/")
                    .ends_with("Users/test/Project/Main.java")
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(
                path_from_uri("file:///home/test/Project/Main.java").as_deref(),
                Some("/home/test/Project/Main.java")
            );
        }
        assert!(path_from_uri("jdt://contents/java.base/java.lang/String.class?=x").is_none());
        assert!(path_from_uri("jar:file:///lib/foo.jar!/com/Foo.class").is_none());
        assert!(is_virtual_class_uri(
            "jdt://contents/java.base/java.lang/String.class?=x"
        ));
        assert_eq!(
            title_from_class_uri("jdt://contents/java.base/java.lang/String.class?=x"),
            "String.java"
        );
    }

    #[test]
    fn reads_percent_encoded_source_from_archive_uri() {
        use std::io::Write as _;

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("demo sources.jar");
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "com/acme/Hello World.kt",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        archive
            .write_all(b"package com.acme\nclass HelloWorld\n")
            .unwrap();
        archive.finish().unwrap();

        let file_uri = url::Url::from_file_path(&archive_path).unwrap();
        let uri = format!("jar:{file_uri}!/com/acme/Hello%20World.kt");
        let parsed = archive_document_uri(&uri).expect("archive URI");
        assert_eq!(parsed.archive_path, archive_path);
        assert_eq!(parsed.entry_path, "com/acme/Hello World.kt");

        let contents = read_archive_source_contents(&uri)
            .unwrap()
            .expect("archive source");
        assert_eq!(contents.title, "Hello World.kt");
        assert_eq!(contents.container.as_deref(), Some("demo sources.jar"));
        assert_eq!(contents.language_id, "kotlin");
        assert!(contents.text.contains("class HelloWorld"));
    }

    #[test]
    fn binary_archive_locations_fall_through_to_language_server() {
        let uri = if cfg!(windows) {
            "kls:file:///C:/sdk/kotlin.jar!/kotlin/String.class?source=false"
        } else {
            "kls:file:///sdk/kotlin.jar!/kotlin/String.class?source=false"
        };
        let parsed = archive_document_uri(uri).expect("kls URI");
        assert_eq!(parsed.entry_path, "kotlin/String.class");
        assert!(read_archive_source_contents(uri).unwrap().is_none());
    }

    #[test]
    fn maps_library_source_extensions_to_editor_languages() {
        for (uri, expected) in [
            ("file:///sdk/lib.d.ts", "typescript"),
            ("file:///sdk/lib.mjs", "javascript"),
            ("file:///sdk/types.pyi", "python"),
            ("file:///sdk/runtime.go", "go"),
            ("file:///sdk/System.String.cs", "csharp"),
            ("file:///sdk/UIKit.swiftinterface", "swift"),
            ("file:///sdk/vector.hpp", "cpp"),
        ] {
            assert_eq!(language_id_from_uri(uri), expected, "{uri}");
        }
    }

    #[test]
    fn csharp_ls_preset_enables_metadata_uris() {
        let csharp = find_preset("csharp").expect("csharp preset");
        let server = csharp
            .commands
            .iter()
            .find(|command| command.id == "csharp-ls")
            .expect("csharp-ls command");
        assert_eq!(server.args, ["--features", "metadata-uris"]);
    }

    #[test]
    fn container_from_class_uri_labels_package_and_archive() {
        assert_eq!(
            container_from_class_uri("jdt://contents/java.base/java.lang/String.class?=x")
                .as_deref(),
            Some("java.lang · java.base")
        );
        let jar_class = concat!(
            "jdt://contents/commons-lang3-3.12.0.jar/",
            "org.apache.commons.lang3/StringUtils.class?=y"
        );
        assert_eq!(
            container_from_class_uri(jar_class).as_deref(),
            Some("org.apache.commons.lang3 · commons-lang3-3.12.0.jar")
        );
        assert_eq!(
            container_from_class_uri("jar:file:///libs/foo.jar!/com/acme/Bar.class").as_deref(),
            Some("com.acme · foo.jar")
        );
        assert!(container_from_class_uri("jdt://contents/String.class").is_none());
    }

    #[test]
    fn with_document_uri_overrides_only_when_present() {
        let document = ResolvedDocument {
            path: PathBuf::from(if cfg!(windows) {
                r"C:\repo\src\Main.java"
            } else {
                "/repo/src/Main.java"
            }),
            uri: "file:///repo/src/Main.java".to_string(),
            root_path: PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" }),
            workspace_id: "workspace".to_string(),
            preset: find_preset("java"),
            language_id: Some("java".to_string()),
            version: 0,
        };
        let untouched = with_document_uri(document.clone(), Some("   ".to_string()));
        assert_eq!(untouched.uri, "file:///repo/src/Main.java");
        let library = with_document_uri(
            document,
            Some("jdt://contents/java.base/java.lang/String.class?=x".to_string()),
        );
        assert_eq!(
            library.uri,
            "jdt://contents/java.base/java.lang/String.class?=x"
        );
        // Session / SDK resolution still keys off the origin project file.
        assert!(library.path.ends_with("Main.java"));
    }
}
