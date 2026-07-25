use crate::sdk::{JavaRuntimeConfiguration, SdkManager, WorkspaceSdkEnvironment};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Notify, RwLock, oneshot};

const REQUEST_TIMEOUT_SECS: u64 = 8;
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
const SHUTDOWN_TIMEOUT_SECS: u64 = 3;
const EXIT_TIMEOUT_SECS: u64 = 2;
const COMMAND_AVAILABILITY_TTL: Duration = Duration::from_secs(30);

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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspWorkspaceSymbol>,
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

#[derive(Clone, Debug)]
struct SemanticTokensCache {
    result_id: String,
    data: Vec<u64>,
}

type LspSessionRegistry = Arc<Mutex<HashMap<String, LspSessionEntry>>>;
type LspLastErrorRegistry = Arc<Mutex<HashMap<String, String>>>;

pub struct LspManager {
    sessions: LspSessionRegistry,
    /// Last unexpected exit / start failure per session key. Surfaced by
    /// `document_status` so the UI does not stick on a silent "starting…"
    /// after the process dies with `available=true, active=false`.
    last_errors: LspLastErrorRegistry,
    sdk: Arc<SdkManager>,
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
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    opened_documents: RwLock<HashSet<String>>,
    diagnostics: RwLock<HashMap<String, Vec<LspDiagnostic>>>,
    capabilities: RwLock<Option<LspCapabilitySummary>>,
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
        let jdtls_runtime_error = if !active
            && command.as_ref().is_some_and(command_is_jdtls)
        {
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

        let session_root = PathBuf::from(&sdk_environment.project_scope_path);
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
                return Err(session_start_error_status(document, preset, &command, error));
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
    async fn spawn(
        key: LspSessionKey,
        preset: LspServerPreset,
        command: LspServerCommandPreset,
        root_path: PathBuf,
        root_uri: String,
        sdk_environment: WorkspaceSdkEnvironment,
        sessions: LspSessionRegistry,
        last_errors: LspLastErrorRegistry,
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
        let initialization_options = lsp_initialization_options(is_jdtls, &sdk_environment);
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
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            opened_documents: RwLock::new(HashSet::new()),
            diagnostics: RwLock::new(HashMap::new()),
            capabilities: RwLock::new(None),
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
                "name": root_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("workspace")
            }],
            "capabilities": {
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "didSave": true
                    },
                    "hover": {
                        "contentFormat": ["markdown", "plaintext"]
                    },
                    "definition": {
                        "linkSupport": true
                    },
                    "references": {
                        "dynamicRegistration": false
                    },
                    "completion": {
                        "dynamicRegistration": false,
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
                        "contextSupport": true,
                        "signatureInformation": {
                            "documentationFormat": ["markdown", "plaintext"],
                            "parameterInformation": { "labelOffsetSupport": true },
                            "activeParameterSupport": true
                        }
                    },
                    "documentSymbol": {
                        "hierarchicalDocumentSymbolSupport": true
                    },
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "versionSupport": true
                    },
                    "semanticTokens": {
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
                "workspace": {
                    "workspaceFolders": true,
                    "configuration": false
                }
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
        let server_caps = initialize_result.get("capabilities").cloned().unwrap_or(Value::Null);
        *session.capabilities.write().await = Some(capability_summary_from(&server_caps));
        session
            .text_document_sync_kind
            .store(text_document_sync_kind(&server_caps), Ordering::SeqCst);
        let (token_types, token_modifiers) = semantic_token_legend_from(&server_caps);
        *session.semantic_token_types.write().await = token_types;
        *session.semantic_token_modifiers.write().await = token_modifiers;
        *session.semantic_tokens_delta.write().await = semantic_token_delta_supported(&server_caps);
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

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
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
        match tokio::time::timeout(Duration::from_secs(timeout_secs), receiver).await {
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

    async fn handle_message(&self, message: Value) {
        if let Some(id) = message.get("id").and_then(message_id) {
            // Response to one of our requests.
            if message.get("method").is_none() {
                let pending = self.pending.lock().await.remove(&id);
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

            // Server → client request. Always answer so servers that wait on
            // registerCapability / configuration do not stall after initialize.
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("");
            let result = server_request_result(method, message.get("params"));
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result,
                }))
                .await;
            return;
        }

        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        if method == "textDocument/publishDiagnostics" {
            let Some(params) = message.get("params") else {
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
            let snippet: String = trimmed.chars().rev().take(400).collect::<String>().chars().rev().collect();
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
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")
            });
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
    split_jvm_args(&jdtls_vmargs_string())
}

/// Apply Settings JVM args as JAVA_OPTS for the jdtls wrapper (Linux/macOS).
/// Settings win over a parent-shell JAVA_OPTS so heap/GC overrides are not ignored.
fn apply_jdtls_vmargs_to_command(cmd: &mut Command) {
    cmd.env("JAVA_OPTS", jdtls_vmargs_string());
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
    let mac = path.join("Contents").join("Home").join("bin").join(bin_name);
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
            for vendor in ["Java", "Eclipse Adoptium", "Microsoft", "Amazon Corretto", "Semeru"] {
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
                    if best_ok
                        .as_ref()
                        .map(|(_, m)| major > *m)
                        .unwrap_or(true)
                    {
                        best_ok = Some((path.clone(), major));
                    }
                }
                if best_any
                    .as_ref()
                    .map(|(_, m)| major > *m)
                    .unwrap_or(true)
                {
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
            } else if error.contains("java not found")
                || error.contains("invalid")
            {
                Some(format!(
                    "Java not found — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for jdtls"
                ))
            } else {
                Some(format!("Java runtime issue (need JDK {JDTLS_MIN_JAVA_MAJOR}+)"))
            };
            (status, Some(error))
        }
    }
}

fn command_is_jdtls(command: &LspServerCommandPreset) -> bool {
    command.id.eq_ignore_ascii_case("jdtls")
        || command.command.to_ascii_lowercase().contains("jdtls")
}

fn preset_uses_jdtls(
    preset: &LspServerPreset,
    command: Option<&LspServerCommandPreset>,
) -> bool {
    if preset.id == "java" {
        return true;
    }
    command.is_some_and(command_is_jdtls)
        || preset.commands.iter().any(command_is_jdtls)
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

fn server_request_result(method: &str, params: Option<&Value>) -> Value {
    match method {
        "workspace/configuration" => {
            let count = params
                .and_then(|value| value.get("items"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            Value::Array(vec![Value::Null; count])
        }
        "window/showMessageRequest" => Value::Null,
        "window/workDoneProgress/create"
        | "client/registerCapability"
        | "client/unregisterCapability"
        | "workspace/workspaceFolders" => Value::Null,
        _ => Value::Null,
    }
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
    pub edits: Vec<LspTextEdit>,
}

/// Normalized workspace edit for clients (rename / code actions / replace).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceEdit {
    pub document_edits: Vec<LspFileTextEdits>,
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

/// Open library / virtual LSP locations (JDK classes, dependency JARs, jdt://).
/// Prefer a real filesystem path when the URI maps to one; otherwise ask JDT LS
/// for decompiled or attached source via `java/classFileContents`.
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

    // Virtual class-file URIs from Eclipse JDT LS (JDK + third-party JARs).
    if is_virtual_class_uri(&uri) {
        let session = state
            .lsp
            .active_session(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await
            .ok_or_else(|| {
                "No language server session is active for this file; cannot open library source"
                    .to_string()
            })?;
        let result = session
            .request_with_timeout(
                "java/classFileContents",
                json!({ "uri": uri }),
                REQUEST_TIMEOUT_SECS.max(20),
            )
            .await
            .map_err(|e| format!("Failed to load class contents: {e}"))?;
        // jdtls answers with an empty string when neither attached sources nor the
        // bundled decompiler could produce anything for this class.
        let text = result
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "{} returned no source for {}: attach a sources JAR or install a decompiler",
                    document
                        .preset
                        .as_ref()
                        .map(|preset| preset.display_name.clone())
                        .unwrap_or_else(|| "The language server".to_string()),
                    title_from_class_uri(&uri),
                )
            })?
            .to_string();
        return Ok(LspUriContentsResult {
            status,
            uri: uri.clone(),
            path: None,
            title: title_from_class_uri(&uri),
            container: container_from_class_uri(&uri),
            language_id: "java".to_string(),
            decompiled: is_decompiled_contents(&text),
            text,
            read_only: true,
        });
    }

    Err(format!(
        "Cannot open location URI (not a readable file path and not a class-file URI): {uri}"
    ))
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
    // Any open document under the workspace is enough to resolve the active
    // language server session for workspace/symbol.
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
            return Ok(LspWorkspaceSymbolsResult {
                status,
                symbols: Vec::new(),
            });
        }
    };
    let result = session
        .request("workspace/symbol", json!({ "query": query }))
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
    Ok(LspWorkspaceSymbolsResult {
        status,
        symbols: parse_workspace_symbols(&result),
    })
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
    let result = session
        .request(
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": document.uri },
                "range": {
                    "start": { "line": start_line, "character": start_character },
                    "end": { "line": end_line, "character": end_character },
                },
                "context": {
                    "diagnostics": diagnostics.unwrap_or_default(),
                    "only": null,
                    "triggerKind": 1,
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
    Ok(LspCodeActionsResult {
        status,
        actions: parse_code_actions(&result),
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
    is_jdtls: bool,
    sdk_environment: &WorkspaceSdkEnvironment,
) -> Value {
    if !is_jdtls {
        return Value::Null;
    }
    let runtimes: &[JavaRuntimeConfiguration] = &sdk_environment.java_runtimes;
    json!({
        "settings": {
            "java": {
                "configuration": {
                    "runtimes": runtimes
                }
            }
        },
        // JDT LS drops every location that resolves into a `.class` file unless the
        // client declares `classFileContentsSupport` (JDTUtils#toUri(IClassFile)
        // returns null otherwise). Without it, Ctrl+click on a JDK or dependency
        // type silently resolves to nothing. It also widens workspace symbol search
        // to application/system libraries and enables decompiled-source lookups.
        "extendedClientCapabilities": {
            "classFileContentsSupport": true
        }
    })
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
    if path.is_absolute() || command.contains('/') || command.contains('\\') {
        return path.is_file();
    }
    which::which(command).is_ok()
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

fn message_id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|id| id.parse::<u64>().ok()))
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
    })
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

fn parse_workspace_edit(value: &Value) -> LspWorkspaceEdit {
    let mut document_edits: Vec<LspFileTextEdits> = Vec::new();
    if let Some(changes) = value.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            document_edits.push(LspFileTextEdits {
                uri: uri.clone(),
                path: path_from_uri(uri),
                edits: parse_text_edits(edits),
            });
        }
    }
    if let Some(document_changes) = value.get("documentChanges").and_then(Value::as_array) {
        for change in document_changes {
            // TextDocumentEdit: { textDocument: { uri }, edits: [...] }
            // Skip CreateFile/RenameFile/DeleteFile for now.
            let Some(uri) = change
                .get("textDocument")
                .and_then(|doc| doc.get("uri"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let edits = change
                .get("edits")
                .map(parse_text_edits)
                .unwrap_or_default();
            if edits.is_empty() {
                continue;
            }
            if let Some(existing) = document_edits.iter_mut().find(|item| item.uri == uri) {
                existing.edits.extend(edits);
            } else {
                document_edits.push(LspFileTextEdits {
                    uri: uri.to_string(),
                    path: path_from_uri(uri),
                    edits,
                });
            }
        }
    }
    LspWorkspaceEdit { document_edits }
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
    let (uri, range) = if let Some(location) = value.get("location") {
        let uri = location.get("uri").and_then(Value::as_str)?;
        let range = location
            .get("range")
            .and_then(parse_range)
            .or_else(|| value.get("range").and_then(parse_range))
            .unwrap_or(LspRange {
                start: LspPosition {
                    line: 0,
                    character: 0,
                },
                end: LspPosition {
                    line: 0,
                    character: 0,
                },
            });
        (uri.to_string(), range)
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
                "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
                "parameter", "variable", "property", "enumMember", "event", "function",
                "method", "macro", "keyword", "modifier", "comment", "string", "number",
                "regexp", "operator", "decorator",
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
                "declaration", "definition", "readonly", "static", "deprecated",
                "abstract", "async", "modification", "documentation", "defaultLibrary",
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
    let lower = uri.to_ascii_lowercase();
    if lower.contains(".kt") {
        "kotlin".into()
    } else if lower.contains(".scala") {
        "scala".into()
    } else if lower.contains(".rs") {
        "rust".into()
    } else if lower.contains(".ts") {
        "typescript".into()
    } else if lower.contains(".js") {
        "javascript".into()
    } else if lower.contains(".py") {
        "python".into()
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
                    &[],
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
        assert_eq!(initialize_timeout_secs(&rust.commands[0]), INITIALIZE_TIMEOUT_SECS);
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

        let options = lsp_initialization_options(true, &environment);

        assert_eq!(
            options["settings"]["java"]["configuration"]["runtimes"][0],
            json!({ "name": "JavaSE-17", "path": "/sdk/jdk-17", "default": true })
        );
        // Required for jdt:// definitions into the JDK and dependency JARs.
        assert_eq!(
            options["extendedClientCapabilities"]["classFileContentsSupport"],
            json!(true)
        );
        assert_eq!(lsp_initialization_options(false, &environment), Value::Null);
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
        let temp = std::env::temp_dir().join(format!(
            "taomni-jdtls-java-home-{}",
            std::process::id()
        ));
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
        set_configured_java_vmargs(None);
        assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
        assert!(get_configured_java_vmargs().is_none());

        set_configured_java_vmargs(Some("   "));
        assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);

        set_configured_java_vmargs(Some("-Xmx2G -XX:+UseG1GC -Dfoo=bar"));
        assert_eq!(
            jdtls_vmargs_string(),
            "-Xmx2G -XX:+UseG1GC -Dfoo=bar"
        );
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
        let _cmd = build_lsp_server_command(
            "rust-analyzer",
            &["--version".into()],
            &root,
            None,
            None,
        )
        .expect("command builder");
    }

    #[test]
    fn server_request_result_answers_configuration_with_matching_length() {
        let params = json!({
            "items": [
                { "section": "java" },
                { "section": "editor" }
            ]
        });
        let result = server_request_result("workspace/configuration", Some(&params));
        assert_eq!(result, json!([null, null]));
        assert_eq!(
            server_request_result("client/registerCapability", None),
            Value::Null
        );
    }

    #[test]
    fn detects_fernflower_decompiler_banner() {
        let decompiled = format!(
            "{JDTLS_DECOMPILER_HEADER} (from Intellij IDEA).\npackage java.lang;\n"
        );
        assert!(is_decompiled_contents(&decompiled));
        // Leading blank lines still count (jdtls hands us the banner verbatim).
        assert!(is_decompiled_contents(&format!("\n{decompiled}")));
        assert!(!is_decompiled_contents("package java.lang;\npublic class String {}\n"));
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
        assert!(!gone_index.is_dir(), "index of a deleted project must be pruned");
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
        assert!(!summary.workspace_symbol);
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
            assert!(path.replace('\\', "/").ends_with("Users/test/Project/Main.java"));
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
        assert_eq!(library.uri, "jdt://contents/java.base/java.lang/String.class?=x");
        // Session / SDK resolution still keys off the origin project file.
        assert!(library.path.ends_with("Main.java"));
    }
}
