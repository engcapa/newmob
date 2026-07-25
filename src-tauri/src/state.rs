use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::RwLock;

use crate::agent::acp_bridge::{AcpProcess, AcpThreadProcess};
use crate::agent::cc_bridge::process::CcProcess;
use crate::agent::codex_bridge::process::CodexAppServer;
use crate::ai::AppAiCtx;
use crate::chat::run::ChatRunRegistry;
use crate::database::DbSession;
use crate::filebrowser::sftp::ActiveSftp;
use crate::filebrowser::transfer::TransferHandle;
use crate::hbase::HBaseSession;
use crate::lanchat::LanChatState;
use crate::lsp::LspManager;
use crate::mail::MailImapPool;
use crate::objectstorage::ObjectStorageSession;
use crate::rdp::ws::RdpSession;
use crate::sdk::SdkManager;
use crate::servers::ServerRegistry;
use crate::terminal::{ActiveTerminal, TerminalOutputChannel};
use crate::sockscap::SocksCapRuntime;
use crate::tunnel::TunnelRegistry;
use crate::vault::Vault;
use crate::vnc::ws::VncSession;

pub type MailDbHandle = Arc<Mutex<rusqlite::Connection>>;

pub struct WriteStreamHandle {
    pub path: PathBuf,
    pub file: std::fs::File,
}

pub struct ReadStreamHandle {
    pub file: std::fs::File,
}

/// In-flight keyboard-interactive (MFA/OTP) auth round. The SSH connect task
/// registers a oneshot sender here keyed by a per-round request id, emits a
/// prompt event to the frontend, then awaits the user's answers on the
/// receiver. `submit_ssh_auth_response` looks the sender up and delivers the
/// responses (or `None` if the user cancelled).
pub type SshAuthResponder = tokio::sync::oneshot::Sender<Option<Vec<String>>>;

/// Outcome the frontend returns for a Claude Code *side-effect* tool call that
/// the in-app MCP server dispatched to it (`run_in_terminal`, `sftp_upload`,
/// `switch_tab`, …). The MCP tool handler registers a oneshot sender keyed by a
/// per-call id, emits an `agent-cc-tool` event, then blocks on the receiver
/// until `cc_resolve_tool_call` delivers this outcome (D2 hybrid model — the
/// human is naturally in the loop because the frontend performs the effect).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CcToolOutcome {
    pub ok: bool,
    pub output: String,
}

pub type CcToolResponder = tokio::sync::oneshot::Sender<CcToolOutcome>;

/// Human decision for a Claude Code permission prompt (HITL, Phase 2). The
/// `permission_prompt` MCP tool registers a oneshot keyed by a per-call id,
/// emits `agent-cc-permission`, and blocks until `cc_resolve_permission`
/// delivers the user's choice from the ActionCard.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CcPermissionDecision {
    Allow,
    AllowSession,
    Deny,
}

pub type CcPermissionResponder = tokio::sync::oneshot::Sender<CcPermissionDecision>;

pub struct AppState {
    pub terminals: Arc<RwLock<HashMap<String, ActiveTerminal>>>,
    pub terminal_outputs: Arc<Mutex<HashMap<String, Vec<TerminalOutputChannel>>>>,
    pub sftp_sessions: Arc<RwLock<HashMap<String, Arc<ActiveSftp>>>>,
    pub transfers: Arc<RwLock<HashMap<String, Arc<TransferHandle>>>>,
    pub tunnels: Arc<TunnelRegistry>,
    /// OS-level SocksCap engine (rules/egress now; capture in later phases).
    pub sockscap: Arc<SocksCapRuntime>,
    pub servers: Arc<ServerRegistry>,
    pub vnc_sessions: Arc<RwLock<HashMap<String, VncSession>>>,
    pub rdp_sessions: Arc<RwLock<HashMap<String, RdpSession>>>,
    /// Live database client connections (MySQL/PostgreSQL/Oracle/SQL Server/StarRocks/ClickHouse/Redis),
    /// keyed by session id. Each `DbSession` wraps the per-engine connection
    /// handle plus a cancellation token for in-flight queries.
    pub db_connections: Arc<RwLock<HashMap<String, Arc<DbSession>>>>,
    /// Live JVM-free HBase shell sessions over HBase REST/Stargate.
    pub hbase_sessions: Arc<RwLock<HashMap<String, Arc<HBaseSession>>>>,
    /// Live object-storage connections (S3 / S3-compatible / Azure Blob),
    /// keyed by session id. Each holds the per-engine client handle plus a
    /// cancellation token for in-flight list/transfer operations.
    pub oss_sessions: Arc<RwLock<HashMap<String, Arc<ObjectStorageSession>>>>,
    pub read_handles: Arc<Mutex<HashMap<String, ReadStreamHandle>>>,
    pub write_handles: Arc<Mutex<HashMap<String, WriteStreamHandle>>>,
    /// Pending keyboard-interactive auth rounds, keyed by request id. See
    /// [`SshAuthResponder`].
    pub ssh_auth_responders: Arc<Mutex<HashMap<String, SshAuthResponder>>>,
    pub clipboard: Arc<Mutex<Option<arboard::Clipboard>>>,
    pub db: Mutex<rusqlite::Connection>,
    /// Dedicated connection to the standalone Tao Notes database (`notes.db`),
    /// kept separate from `taomni.db` so note storage can evolve independently.
    pub notes_db: Mutex<rusqlite::Connection>,
    /// Directory containing one SQLite cache database per saved or transient mail
    /// session. Mail caches are intentionally isolated from `taomni.db`, and
    /// from each other, so mailbox refresh writes cannot block session CRUD.
    mail_db_dir: PathBuf,
    mail_dbs: Arc<Mutex<HashMap<String, MailDbHandle>>>,
    /// Live IMAP sessions keyed by mail account/session id. Reuses TCP/TLS/auth
    /// and any session-level proxy forwarder across mail commands. Never routes
    /// through the app global proxy.
    pub mail_imap_pool: Arc<MailImapPool>,
    pub vault: Arc<Vault>,
    /// Per-thread Claude Code process registry (v2.6).
    pub cc_processes: tokio::sync::Mutex<HashMap<String, Arc<CcProcess>>>,
    /// Per-thread Codex app-server registry.
    pub codex_processes: tokio::sync::Mutex<HashMap<String, Arc<CodexAppServer>>>,
    /// Per-thread ACP process registry, isolated from the legacy bridges.
    pub acp_processes: tokio::sync::Mutex<HashMap<String, Arc<AcpThreadProcess>>>,
    /// Short-lived ACP subprocesses used for native image/video generation.
    /// They participate in the same permission-gate and stop lifecycle as a
    /// normal ACP chat turn, but do not own MCP credentials or persisted ACP
    /// sessions.
    pub acp_media_processes: tokio::sync::Mutex<HashMap<String, Arc<AcpProcess>>>,
    /// Provider-agnostic stop handles for in-flight chat turns, keyed by thread_id.
    pub chat_runs: Arc<ChatRunRegistry>,
    /// Pending CC side-effect tool calls awaiting frontend execution, keyed by
    /// per-call id. See [`CcToolResponder`].
    pub cc_pending_tool_calls: Arc<Mutex<HashMap<String, CcToolResponder>>>,
    /// Pending CC permission prompts awaiting a human decision, keyed by
    /// per-call id. See [`CcPermissionResponder`].
    pub cc_pending_permissions: Arc<Mutex<HashMap<String, CcPermissionResponder>>>,
    /// Per-thread captured-command store (方案4). Holds the full stdout/stderr
    /// of `run_captured` runs (B path: Taomni-local files) so CC can grep/page
    /// large output without dumping it into context. Reduction happens here.
    pub captures: Arc<crate::agent::capture::CaptureRegistry>,
    /// Cancel handles for in-flight captures, keyed by capture id. Firing the
    /// `Notify` drops the SSH exec channel / kills the local child.
    pub cc_capture_cancels: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    /// Last working directory reported for an agent thread (filled each turn from
    /// `ChatSendRequest.cwd`). The B executor bridges it into `run_captured`
    /// (`cd <cwd> && …`) since an MCP tool call has no per-turn cwd of its own.
    pub agent_thread_cwd: Arc<Mutex<HashMap<String, String>>>,
    /// Maps a terminal *tab id* (the caller-facing id CC's tools see — equal to
    /// `chat thread.linked_session_id` / the token's `allowed_session_id`) to the
    /// *backend terminal session id* used as the `terminals` map key (a fresh
    /// `crypto.randomUUID()` per connection, distinct from the tab id). The
    /// frontend reports this as terminals connect/disconnect (`cc_track_terminal`
    /// / `cc_untrack_terminal`), so backend-side CC tools (`run_captured` /
    /// `read_capture`) can resolve the live terminal that `run_in_terminal`
    /// reaches indirectly through the frontend registry. Refreshed on reconnect.
    pub cc_tab_sessions: Arc<Mutex<HashMap<String, String>>>,
    /// Live DB connection id an agent thread is bound to (Phase 6). The runtime key
    /// for `db_connections` is generated in the frontend (`createRuntimeDbSessionId`)
    /// and isn't derivable backend-side, so the frontend bridges it over each
    /// turn via `ChatSendRequest.bound_db_connection_id`. The SQL/Redis MCP
    /// handlers resolve their bound connection from here (the model never names a
    /// connection id, so this is the only target — scope-safe by construction).
    pub agent_db_bindings: Arc<RwLock<HashMap<String, String>>>,
    /// Current objects selected in the bound DB tab's schema tree, bridged
    /// per chat turn just like `agent_db_bindings`. SQL MCP tools use this to
    /// resolve user phrases such as "selected tables" without reading frontend
    /// UI state directly. The list can include non-queryable object kinds; SQL
    /// MCP tools expose a queryable subset for SELECT workflows.
    pub agent_db_selected_objects:
        Arc<RwLock<HashMap<String, Vec<crate::agent::context::AgentDbSelectedObject>>>>,
    /// Current code workspace bound to an agent thread, bridged per chat turn.
    /// This gives Codex/Claude sidecars a stable repo/file context without
    /// reading frontend UI state directly.
    pub agent_code_workspaces:
        Arc<RwLock<HashMap<String, crate::agent::context::AgentCodeWorkspace>>>,
    /// Local language-server process registry for code-workspace editor tabs.
    pub lsp: Arc<LspManager>,
    /// Debug Adapter Protocol sessions + adapter registry (M8 D1).
    pub dap: Arc<crate::dap::DapManager>,
    /// Versioned SDK installations, defaults and per-workspace manual bindings.
    pub sdk: Arc<SdkManager>,
    /// Top-level AI context — holds AsrManager + LlmRouter.
    /// Wrapped in RwLock so save_ai_config can hot-rebuild the router.
    pub ai_ctx: Arc<RwLock<AppAiCtx>>,
    /// Decentralized LAN messenger (LanChat) runtime state. Distinct from the
    /// AI-assistant `chat`/`voice` modules. Holds node identity, peer roster,
    /// and the lanchat.sqlite path; populated by the lanchat background service.
    pub lanchat: Arc<LanChatState>,
}

impl AppState {
    pub fn new(
        db: rusqlite::Connection,
        notes_db: rusqlite::Connection,
        mail_db_dir: PathBuf,
        vault: Arc<Vault>,
        ai_ctx: AppAiCtx,
        lanchat: Arc<LanChatState>,
    ) -> Self {
        let sdk = Arc::new(SdkManager::load(crate::sdk::default_sdk_registry_path()));
        Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            terminal_outputs: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(RwLock::new(HashMap::new())),
            transfers: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(TunnelRegistry::new()),
            sockscap: Arc::new(SocksCapRuntime::new()),
            servers: Arc::new(ServerRegistry::new()),
            vnc_sessions: Arc::new(RwLock::new(HashMap::new())),
            rdp_sessions: Arc::new(RwLock::new(HashMap::new())),
            db_connections: Arc::new(RwLock::new(HashMap::new())),
            hbase_sessions: Arc::new(RwLock::new(HashMap::new())),
            oss_sessions: Arc::new(RwLock::new(HashMap::new())),
            read_handles: Arc::new(Mutex::new(HashMap::new())),
            write_handles: Arc::new(Mutex::new(HashMap::new())),
            ssh_auth_responders: Arc::new(Mutex::new(HashMap::new())),
            clipboard: Arc::new(Mutex::new(None)),
            db: Mutex::new(db),
            notes_db: Mutex::new(notes_db),
            mail_db_dir,
            mail_dbs: Arc::new(Mutex::new(HashMap::new())),
            mail_imap_pool: Arc::new(MailImapPool::new()),
            vault,
            cc_processes: tokio::sync::Mutex::new(HashMap::new()),
            codex_processes: tokio::sync::Mutex::new(HashMap::new()),
            acp_processes: tokio::sync::Mutex::new(HashMap::new()),
            acp_media_processes: tokio::sync::Mutex::new(HashMap::new()),
            chat_runs: Arc::new(ChatRunRegistry::new(HashMap::new())),
            cc_pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
            cc_pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            captures: Arc::new(crate::agent::capture::CaptureRegistry::new(
                std::env::temp_dir().join("taomni-cc-captures"),
            )),
            cc_capture_cancels: Arc::new(Mutex::new(HashMap::new())),
            agent_thread_cwd: Arc::new(Mutex::new(HashMap::new())),
            cc_tab_sessions: Arc::new(Mutex::new(HashMap::new())),
            agent_db_bindings: Arc::new(RwLock::new(HashMap::new())),
            agent_db_selected_objects: Arc::new(RwLock::new(HashMap::new())),
            agent_code_workspaces: Arc::new(RwLock::new(HashMap::new())),
            lsp: Arc::new(LspManager::with_sdk(sdk.clone())),
            dap: Arc::new(crate::dap::DapManager::new()),
            sdk,
            ai_ctx: Arc::new(RwLock::new(ai_ctx)),
            lanchat,
        }
    }

    pub fn mail_db(&self, account_id: &str) -> Result<MailDbHandle, String> {
        let stem = mail_db_file_stem(account_id);
        let mut dbs = self.mail_dbs.lock().map_err(|e| e.to_string())?;
        if let Some(db) = dbs.get(&stem) {
            return Ok(Arc::clone(db));
        }

        std::fs::create_dir_all(&self.mail_db_dir)
            .map_err(|e| format!("create mail cache directory: {e}"))?;
        let path = self.mail_db_dir.join(format!("{stem}.db"));
        let conn = rusqlite::Connection::open(&path)
            .map_err(|e| format!("open mail cache database {}: {e}", path.display()))?;
        let handle = Arc::new(Mutex::new(conn));
        dbs.insert(stem, Arc::clone(&handle));
        Ok(handle)
    }
}

fn mail_db_file_stem(account_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut cleaned = account_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if cleaned.is_empty() {
        cleaned = "mail".into();
    }
    cleaned = cleaned.chars().take(80).collect();

    let digest = Sha256::digest(account_id.as_bytes());
    let digest_hex = hex::encode(digest);
    format!("{cleaned}-{}", &digest_hex[..16])
}
