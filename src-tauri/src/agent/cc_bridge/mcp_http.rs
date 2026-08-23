//! In-app rmcp Streamable-HTTP MCP server that Claude Code connects to (D1).
//!
//! Replaces the stdio `--mcp-server` bridges for the CC path: instead of CC
//! re-invoking the Taomni binary over stdio, CC's `.mcp.json` points a
//! `type:"http"` entry at this loopback server (Bearer-gated), so the tool
//! handlers run *inside* the live app and can touch `AppState` directly.
//!
//! Execution model (D2 hybrid):
//!   - read-only tools (`list_sessions`, `search_history`) run synchronously
//!     against `AppState.db` — no second connection, no round-trip.
//!   - side-effect tools (`run_in_terminal`, `sftp_upload`, `sftp_download`, `switch_tab`,
//!     `open_session_editor`, `save_as_runbook`) and `read_terminal_tail`
//!     (whose data lives in the frontend) emit an `agent-cc-tool` event and
//!     block on a oneshot until the frontend performs the effect and calls
//!     `cc_resolve_tool_call`.
//!   - `permission_prompt` (CC's `--permission-prompt-tool`) runs the safety
//!     pipeline + grading, and for write tools blocks on a human decision
//!     delivered by `cc_resolve_permission` (HITL, Phase 2).
//!
//! Security:
//!   - Bound to `127.0.0.1:random`; every request needs `Authorization:
//!     Bearer <token>` matching a minted per-thread token (401 otherwise).
//!   - Each token carries a scope `{thread_id, allowed_session_id, trust}`; a
//!     tool call naming a `session_id` outside that scope is rejected, so one
//!     thread's CC can never drive another thread's SSH session. Control-plane
//!     tools are the exception: their `session_id` values name saved Taomni
//!     session configs or UI targets, not the current terminal execution scope.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::StreamableHttpService;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::agent::tools::ToolCall;
use crate::state::{AppState, CcPermissionDecision, CcToolOutcome};

/// How long `permission_prompt` waits for a human decision before defaulting
/// to deny.
const PERMISSION_TIMEOUT_SECS: u64 = 300;
/// How long a side-effect tool waits for the frontend to perform the effect.
pub(crate) const TOOL_TIMEOUT_SECS: u64 = 600;
/// Hard wall-clock cap on a single captured run (方案4). Kept below the CC
/// idle-reaper's in-flight ceiling (`process::TOOL_WAIT_CEILING_SECS` = 960) so
/// the capture's own timeout fires first and the CC process is never reaped
/// mid-capture.
const CAPTURE_TIMEOUT_SECS: u64 = 900;

/// Which tool surface a CC thread's MCP endpoint exposes. Selected at spawn
/// from the bound session's type (E): a terminal/SSH/local thread gets `Shell`;
/// a SQL DB session (MySQL/PG/PanWeiDB/Oracle/SQL Server/ClickHouse/Presto) gets `Sql`; a Redis session
/// gets `Redis`. One listener serves all three at distinct nest paths, and a
/// thread's `.mcp.json` lists *only* its flavor's server — so a DB thread never
/// sees shell tools, and vice-versa (reduces cross-surface confusion).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Shell,
    Sql,
    Redis,
    Control,
}

impl Flavor {
    /// Nest path this flavor's `StreamableHttpService` is mounted at. Shell keeps
    /// the legacy `/mcp` so the GUI-verified shell path is byte-for-byte
    /// unchanged.
    pub fn path(self) -> &'static str {
        match self {
            Flavor::Shell => "/mcp",
            Flavor::Sql => "/mcp/sql",
            Flavor::Redis => "/mcp/redis",
            Flavor::Control => "/mcp/control",
        }
    }

    /// Server name CC sees in `.mcp.json` (and thus in `mcp__<name>__<tool>`).
    pub fn server_name(self) -> &'static str {
        match self {
            Flavor::Shell => "taomni",
            Flavor::Sql => "taomni_sql",
            Flavor::Redis => "taomni_redis",
            Flavor::Control => "taomni_control",
        }
    }

    /// The `--permission-prompt-tool` name for this flavor's server.
    pub fn permission_prompt_tool(self) -> &'static str {
        match self {
            Flavor::Shell => "mcp__taomni__permission_prompt",
            Flavor::Sql => "mcp__taomni_sql__permission_prompt",
            Flavor::Redis => "mcp__taomni_redis__permission_prompt",
            Flavor::Control => "mcp__taomni_control__permission_prompt",
        }
    }

    /// Pick the MCP flavor for a thread from its bound session's type: SQL DB
    /// engines (MySQL/PG/PanWeiDB/Oracle/SQL Server/StarRocks/ClickHouse/Presto) →
    /// `Sql`, Redis → `Redis`, anything else (SSH/terminal/local/unbound) →
    /// `Shell`.
    pub fn for_session_type(t: Option<&crate::session::models::SessionType>) -> Flavor {
        use crate::session::models::SessionType;
        match t {
            Some(
                SessionType::MySQL
                | SessionType::PostgreSQL
                | SessionType::PanWeiDB
                | SessionType::Oracle
                | SessionType::SQLServer
                | SessionType::StarRocks
                | SessionType::ClickHouse
                | SessionType::Presto,
            ) => Flavor::Sql,
            Some(SessionType::Redis) => Flavor::Redis,
            _ => Flavor::Shell,
        }
    }
}

/// Trust tier inferred for a CC thread (D3). Local working dirs are lenient;
/// remote SSH sessions are strict. Surfaced to the UI; the safety pipeline
/// itself stays conservative regardless.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustLevel {
    Lenient,
    Strict,
}

impl TrustLevel {
    fn as_str(self) -> &'static str {
        match self {
            TrustLevel::Lenient => "lenient",
            TrustLevel::Strict => "strict",
        }
    }
}

/// Authorization scope bound to a single minted token (one per CC thread).
#[derive(Clone)]
pub struct TokenScope {
    pub thread_id: String,
    pub allowed_session_id: Option<String>,
    /// The saved `SessionConfig.id` of the bound session, when the thread is
    /// bound to one. Distinct from `allowed_session_id` (a terminal *tab id*):
    /// the session-identity card advertises *this* id to CC, so CC will often
    /// name it as `session_id`. Accepting it here (and normalizing it back to
    /// the canonical tab id in `fill_session_id`) keeps the card, the scope
    /// check, and the tools speaking one id space instead of three.
    pub allowed_config_id: Option<String>,
    pub trust: TrustLevel,
    /// Which tool surface this token's thread uses (Shell / Sql / Redis).
    pub flavor: Flavor,
    /// When true, read-only `Bash`/`run_in_terminal` commands still require a
    /// confirmation (3.6 noise-reduction disabled by config). Snapshotted from
    /// `CcBridgeConfig.confirm_readonly` at provision time.
    pub confirm_readonly: bool,
    /// Codex app-server calls MCP tools directly instead of using Claude
    /// Code's `--permission-prompt-tool` preflight. When this is true, write
    /// tools run the same permission pipeline inside the handler before
    /// executing.
    pub inline_permission: bool,
    /// Tools the user pre-approved for the rest of this session via the
    /// ActionCard's "allow for session" choice.
    pub session_approved: Arc<Mutex<HashSet<String>>>,
}

pub(crate) type TokenMap = Arc<Mutex<HashMap<String, TokenScope>>>;

struct RunningServer {
    addr: SocketAddr,
    tokens: TokenMap,
}

static SERVER: OnceLock<Mutex<Option<RunningServer>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<RunningServer>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Loopback MCP endpoint URL for an address + flavor (the flavor's nest path).
pub fn server_url(addr: SocketAddr, flavor: Flavor) -> String {
    format!("http://{addr}{}", flavor.path())
}

pub fn control_server_url() -> Result<String, String> {
    let guard = slot().lock().unwrap();
    let server = guard.as_ref().ok_or("CC MCP server not started")?;
    Ok(server_url(server.addr, Flavor::Control))
}

fn generate_token() -> String {
    let mut buf = [0u8; 24];
    rand::fill(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Start the in-app CC MCP server if it isn't running yet; returns its address.
/// Idempotent — repeated calls return the existing listener. One listener hosts
/// all flavors at distinct nest paths (`/mcp`, `/mcp/sql`, `/mcp/redis`), behind
/// one Bearer auth layer + one shared token map.
pub async fn ensure_started(app: &AppHandle) -> Result<SocketAddr, String> {
    {
        let guard = slot().lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(s.addr);
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind CC MCP listener: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let tokens: TokenMap = Arc::new(Mutex::new(HashMap::new()));

    // Shell flavor (legacy `/mcp`) — the existing CcHandler tool surface.
    let shell_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || Ok(CcHandler::new(app.clone(), toks.clone())),
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };
    // SQL flavor (`/mcp/sql`) — MySQL/PG/PanWeiDB/Oracle/SQL Server/StarRocks/ClickHouse/Presto.
    let sql_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || Ok(super::mcp_sql::SqlHandler::new(app.clone(), toks.clone())),
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };
    // Redis flavor (`/mcp/redis`).
    let redis_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || {
                Ok(super::mcp_redis::RedisHandler::new(
                    app.clone(),
                    toks.clone(),
                ))
            },
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };
    // Control flavor (`/mcp/control`) — Taomni sessions, tabs, and app config.
    let control_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || {
                Ok(super::mcp_control::ControlHandler::new(
                    app.clone(),
                    toks.clone(),
                ))
            },
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };

    let auth_tokens = tokens.clone();
    let router = axum::Router::new()
        .nest_service(Flavor::Sql.path(), sql_service)
        .nest_service(Flavor::Redis.path(), redis_service)
        .nest_service(Flavor::Control.path(), control_service)
        // Shell at `/mcp` is mounted last so the more specific `/mcp/sql` and
        // `/mcp/redis`/`/mcp/control` nests take precedence over the `/mcp`
        // prefix.
        .nest_service(Flavor::Shell.path(), shell_service)
        .layer(axum::middleware::from_fn(
            move |req: Request, next: Next| {
                let toks = auth_tokens.clone();
                async move { auth_mw(toks, req, next).await }
            },
        ));

    {
        let mut guard = slot().lock().unwrap();
        // Lost a race: another caller bound + stored first. Drop our listener.
        if let Some(s) = guard.as_ref() {
            return Ok(s.addr);
        }
        *guard = Some(RunningServer {
            addr,
            tokens: tokens.clone(),
        });
    }

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("CC MCP server exited: {e}");
        }
    });

    Ok(addr)
}

/// Mint a token scoped to one CC thread. The server must already be started.
pub fn mint_token(
    thread_id: String,
    allowed_session_id: Option<String>,
    allowed_config_id: Option<String>,
    trust: TrustLevel,
    flavor: Flavor,
    confirm_readonly: bool,
    inline_permission: bool,
) -> Result<(SocketAddr, String), String> {
    let guard = slot().lock().unwrap();
    let server = guard.as_ref().ok_or("CC MCP server not started")?;
    let token = generate_token();
    server.tokens.lock().unwrap().insert(
        token.clone(),
        TokenScope {
            thread_id,
            allowed_session_id,
            allowed_config_id,
            trust,
            flavor,
            confirm_readonly,
            inline_permission,
            session_approved: Arc::new(Mutex::new(HashSet::new())),
        },
    );
    Ok((server.addr, token))
}

/// Revoke a token (e.g. when its CC process stops). Idempotent.
pub fn revoke_token(token: &str) {
    if let Some(s) = slot().lock().unwrap().as_ref() {
        s.tokens.lock().unwrap().remove(token);
    }
}

/// Ensure the server is up and mint a scoped token for one CC thread. Trust is
/// inferred (D3): a thread linked to a remote session is strict and scoped to
/// that session; an unlinked (local-workspace) thread is lenient. `flavor`
/// selects the tool surface (Shell / Sql / Redis). Returns the
/// `(server_url, token)` to inject into the thread's `.mcp.json`.
pub async fn provision_for_thread(
    app: &AppHandle,
    thread_id: &str,
    linked_session_id: Option<String>,
    linked_config_id: Option<String>,
    flavor: Flavor,
    confirm_readonly: bool,
) -> Result<(String, String), String> {
    provision_for_thread_with_inline_permission(
        app,
        thread_id,
        linked_session_id,
        linked_config_id,
        flavor,
        confirm_readonly,
        false,
    )
    .await
}

pub async fn provision_for_thread_with_inline_permission(
    app: &AppHandle,
    thread_id: &str,
    linked_session_id: Option<String>,
    linked_config_id: Option<String>,
    flavor: Flavor,
    confirm_readonly: bool,
    inline_permission: bool,
) -> Result<(String, String), String> {
    ensure_started(app).await?;
    let trust = if linked_session_id.is_some() {
        TrustLevel::Strict
    } else {
        TrustLevel::Lenient
    };
    let (addr, token) = mint_token(
        thread_id.to_string(),
        linked_session_id,
        linked_config_id,
        trust,
        flavor,
        confirm_readonly,
        inline_permission,
    )?;
    Ok((server_url(addr, flavor), token))
}

/// Reject any request without a recognised Bearer token (401). Per-call scope
/// checks happen later, in the handler.
async fn auth_mw(tokens: TokenMap, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| tokens.lock().unwrap().contains_key(t))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap()
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Build the CC permission-prompt `allow` reply CC expects from its
/// `--permission-prompt-tool`: `{behavior:"allow", updatedInput:{...}}`.
pub(crate) fn allow_json(input: &serde_json::Value) -> String {
    serde_json::json!({ "behavior": "allow", "updatedInput": input }).to_string()
}

/// Build the CC permission-prompt `deny` reply: `{behavior:"deny", message}`.
pub(crate) fn deny_json(message: impl Into<String>) -> String {
    serde_json::json!({ "behavior": "deny", "message": message.into() }).to_string()
}

pub(crate) fn allow_result(input: &serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(allow_json(input))])
}

pub(crate) fn deny_result(message: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(deny_json(message))])
}

/// CC names MCP tools as `mcp__<server>__<tool>` when it asks the
/// `--permission-prompt-tool` for a decision. Strip that prefix so the call is
/// graded against Taomni's bare tool vocabulary (`run_in_terminal`, …) — the
/// same names `is_write_tool` / `check_tool_call` recognize. CC's own built-in
/// tools (`Bash`, `Edit`, …) arrive unprefixed and pass through unchanged.
pub(crate) fn normalize_tool_name(name: &str) -> &str {
    name.strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
        .map(|(_server, tool)| tool)
        .unwrap_or(name)
}

/// Returns true for tools whose `session_id` argument identifies the current
/// execution target bound to this thread. Taomni control/UI tools use ids for
/// saved session configs or tabs instead, so applying the terminal scope check
/// to them would incorrectly reject valid actions like opening `pi-1` from a
/// local PowerShell chat.
pub(crate) fn tool_uses_bound_session_scope(tool: &str) -> bool {
    !matches!(
        normalize_tool_name(tool),
        // Shared control MCP: saved session config management.
        "session_list"
            | "session_get"
            | "session_create"
            | "session_update"
            | "session_duplicate"
            | "session_delete"
            | "session_move_group"
            // Shared control MCP: groups.
            | "group_list"
            | "group_create"
            | "group_rename"
            | "group_delete"
            // Shared control MCP: UI/session opening.
            | "session_open"
            | "session_open_editor"
            | "quick_connect"
            // Shared control MCP: tabs and app UI.
            | "tab_list"
            | "tab_switch"
            | "tab_duplicate"
            | "tab_rename"
            | "tab_close"
            | "tab_move"
            | "tab_open_settings"
            | "tab_open_local_terminal"
            | "tab_open_file_browser"
            // Legacy shell UI tools kept for compatibility.
            | "switch_tab"
            | "open_session_editor"
    )
}

/// Resolve a caller-named `session_id` against the token's bound terminal. CC
/// may name the bound session either by its terminal *tab id* (the canonical
/// scope id) or by the saved `SessionConfig.id` the identity card advertises;
/// both refer to the one bound terminal. Returns the canonical *tab id* when
/// `sid` is in scope, else `None` (foreign session, or a thread bound to none).
fn canonical_bound_id<'a>(scope: &'a TokenScope, sid: &str) -> Option<&'a str> {
    let tab = scope.allowed_session_id.as_deref()?;
    if sid == tab || scope.allowed_config_id.as_deref() == Some(sid) {
        Some(tab)
    } else {
        None
    }
}

/// Enforce that any `session_id` named in a tool call refers to the terminal
/// this token is bound to — by tab id or by the advertised `SessionConfig.id`.
/// Tokens with no bound session may not touch a session at all.
pub(crate) fn enforce_session_scope(
    scope: &TokenScope,
    args: &serde_json::Value,
) -> Result<(), String> {
    if let Some(sid) = args.get("session_id").and_then(|v| v.as_str()) {
        if canonical_bound_id(scope, sid).is_some() {
            Ok(())
        } else {
            Err(format!("session '{sid}' is out of scope for this thread"))
        }
    } else {
        Ok(())
    }
}

/// Resolve the calling token's scope from a request's Bearer header. Shared by
/// every flavor's handler (`scope()` methods delegate here).
pub(crate) fn scope_from_ctx(
    tokens: &TokenMap,
    ctx: &RequestContext<RoleServer>,
) -> Result<TokenScope, ErrorData> {
    let parts = ctx
        .extensions
        .get::<axum::http::request::Parts>()
        .ok_or_else(|| ErrorData::internal_error("missing http request parts", None))?;
    let token = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| ErrorData::invalid_params("missing bearer token", None))?;
    tokens
        .lock()
        .unwrap()
        .get(token)
        .cloned()
        .ok_or_else(|| ErrorData::invalid_params("unknown token", None))
}

/// Emit `agent-cc-permission` and block until a human decision arrives via
/// `cc_resolve_permission` (defaults to deny on timeout). Shared by all flavors.
pub(crate) async fn await_permission(
    app: &AppHandle,
    scope: &TokenScope,
    tool: &str,
    input: &serde_json::Value,
) -> CcPermissionDecision {
    let call_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<CcPermissionDecision>();
    {
        let state = app.state::<AppState>();
        state
            .cc_pending_permissions
            .lock()
            .unwrap()
            .insert(call_id.clone(), tx);
    }
    let _ = app.emit(
        "agent-cc-permission",
        serde_json::json!({
            "callId": call_id,
            "threadId": scope.thread_id,
            "tool": tool,
            "args": input,
            "trust": scope.trust.as_str(),
        }),
    );

    match tokio::time::timeout(Duration::from_secs(PERMISSION_TIMEOUT_SECS), rx).await {
        Ok(Ok(decision)) => decision,
        _ => {
            let state = app.state::<AppState>();
            state
                .cc_pending_permissions
                .lock()
                .unwrap()
                .remove(&call_id);
            CcPermissionDecision::Deny
        }
    }
}

/// The shared `permission_prompt` grading pipeline used by every flavor's
/// `permission_prompt` tool. `raw_tool_name` is CC's `mcp__server__tool` (or a
/// built-in like `Bash`); `is_readonly` is the flavor-specific verdict that a
/// confidently read-only operation may waive the *confirmation* card (never the
/// safety checks, which always run). Returns the CC allow/deny reply.
pub(crate) async fn decide_permission(
    app: &AppHandle,
    scope: &TokenScope,
    raw_tool_name: &str,
    input: &serde_json::Value,
    is_readonly: bool,
) -> CallToolResult {
    let tool_name = normalize_tool_name(raw_tool_name).to_string();
    let uses_bound_session_scope = tool_uses_bound_session_scope(&tool_name);

    // 1. Session/thread scope.
    if uses_bound_session_scope {
        if let Err(reason) = enforce_session_scope(scope, input) {
            return deny_result(reason);
        }
    }
    // 2. Blacklist / sensitive-path deny-list.
    let call = ToolCall {
        tool: tool_name.clone(),
        args: input.clone(),
    };
    if let Err(reason) = crate::agent::safety::check_tool_call(&call) {
        return deny_result(reason);
    }
    // 3. Per-session "AI 写动作禁用".
    if uses_bound_session_scope {
        let state = app.state::<AppState>();
        if let Err(reason) = crate::agent::safety::check_session_disable(&state, &call) {
            return deny_result(reason);
        }
    }
    // 4. Grading: writes need a human unless already approved for session.
    let already = scope.session_approved.lock().unwrap().contains(&tool_name);
    let needs_confirm =
        crate::agent::safety::requires_confirmation(&tool_name) && !already && !is_readonly;
    if !needs_confirm {
        return allow_result(input);
    }
    // 5. Human-in-the-loop.
    match await_permission(app, scope, &tool_name, input).await {
        CcPermissionDecision::Allow => allow_result(input),
        CcPermissionDecision::AllowSession => {
            scope.session_approved.lock().unwrap().insert(tool_name);
            allow_result(input)
        }
        CcPermissionDecision::Deny => deny_result("denied by user"),
    }
}

/// Handler-side permission gate for clients that do not use the Claude Code
/// `permission_prompt` preflight. No-op for legacy Claude tokens.
pub(crate) async fn enforce_inline_permission(
    app: &AppHandle,
    scope: &TokenScope,
    raw_tool_name: &str,
    input: &serde_json::Value,
    is_readonly: bool,
) -> Result<(), ErrorData> {
    if !scope.inline_permission {
        return Ok(());
    }
    let tool_name = normalize_tool_name(raw_tool_name).to_string();
    let uses_bound_session_scope = tool_uses_bound_session_scope(&tool_name);
    if uses_bound_session_scope {
        enforce_session_scope(scope, input).map_err(|e| ErrorData::invalid_params(e, None))?;
    }
    let call = ToolCall {
        tool: tool_name.clone(),
        args: input.clone(),
    };
    crate::agent::safety::check_tool_call(&call).map_err(|e| ErrorData::invalid_params(e, None))?;
    if uses_bound_session_scope {
        let state = app.state::<AppState>();
        crate::agent::safety::check_session_disable(&state, &call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
    }

    let already = scope.session_approved.lock().unwrap().contains(&tool_name);
    let needs_confirm =
        crate::agent::safety::requires_confirmation(&tool_name) && !already && !is_readonly;
    if !needs_confirm {
        return Ok(());
    }
    match await_permission(app, scope, &tool_name, input).await {
        CcPermissionDecision::Allow => Ok(()),
        CcPermissionDecision::AllowSession => {
            scope.session_approved.lock().unwrap().insert(tool_name);
            Ok(())
        }
        CcPermissionDecision::Deny => Err(ErrorData::invalid_params("denied by user", None)),
    }
}

#[derive(Clone)]
struct CcHandler {
    app: AppHandle,
    tokens: TokenMap,
    tool_router: ToolRouter<Self>,
}

impl CcHandler {
    fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    /// Resolve the calling token's scope from the request's Bearer header.
    fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    fn app_state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// Emit an `agent-cc-tool` event and block until the frontend performs the
    /// effect and calls `cc_resolve_tool_call` (or we time out).
    async fn dispatch_side_effect(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<CallToolResult, ErrorData> {
        let call_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<CcToolOutcome>();
        {
            let state = self.app_state();
            state
                .cc_pending_tool_calls
                .lock()
                .unwrap()
                .insert(call_id.clone(), tx);
        }
        let _ = self.app.emit(
            "agent-cc-tool",
            serde_json::json!({
                "callId": call_id,
                "threadId": scope.thread_id,
                "tool": tool,
                "args": args,
            }),
        );

        match tokio::time::timeout(Duration::from_secs(TOOL_TIMEOUT_SECS), rx).await {
            Ok(Ok(outcome)) if outcome.ok => {
                Ok(CallToolResult::success(vec![Content::text(outcome.output)]))
            }
            Ok(Ok(outcome)) => Err(ErrorData::internal_error(outcome.output, None)),
            _ => {
                // Timed out or sender dropped — clean up the registry slot.
                let state = self.app_state();
                state.cc_pending_tool_calls.lock().unwrap().remove(&call_id);
                Err(ErrorData::internal_error(
                    "tool call timed out or was cancelled".to_string(),
                    None,
                ))
            }
        }
    }

    /// Run a command on the bound host capturing its full output (方案4), then
    /// return only a bounded summary. `reflect_session=false` → B path
    /// (independent channel, Taomni-local file); `true` → C path (live
    /// interactive session, remote temp file, POSIX SSH only). Blocks with
    /// progress events + a hard timeout; cancellable via `cc_cancel_capture`.
    async fn run_captured_impl(
        &self,
        scope: &TokenScope,
        command: &str,
        reflect_session: bool,
        session_id: Option<String>,
    ) -> Result<CallToolResult, ErrorData> {
        use crate::agent::capture::{CaptureSource, CaptureStatus, exec_b, exec_c};
        use crate::terminal::ActiveTerminal;

        let sid = session_id
            .or_else(|| scope.allowed_session_id.clone())
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    "run_captured requires a bound terminal session".to_string(),
                    None,
                )
            })?;
        let state = self.app_state();

        if state.captures.running_count(&scope.thread_id) >= 2 {
            return Err(ErrorData::internal_error(
                "too many captures already running for this thread; retry shortly".to_string(),
                None,
            ));
        }

        // Clone connection handles out of the terminals map so we don't hold its
        // lock across a possibly-minutes-long run.
        type SshHandle = Arc<russh::client::Handle<crate::terminal::ssh::SshHandler>>;
        type SshWrite = Arc<tokio::sync::Mutex<russh::ChannelWriteHalf<russh::client::Msg>>>;
        enum Target {
            Ssh(SshHandle, SshWrite),
            Local,
        }
        let target = {
            // `sid` is a tab id (token scope / fill_session_id). `state.terminals`
            // is keyed by the backend session id, so translate before lookup —
            // otherwise this always misses and reports a live terminal as dead.
            let backend_sid = resolve_backend_session_id(&state, &sid);
            let terms = state.terminals.read().await;
            match terms.get(&backend_sid) {
                Some(ActiveTerminal::Ssh {
                    handle, channel, ..
                }) => Target::Ssh(handle.clone(), channel.clone()),
                Some(ActiveTerminal::Local { .. }) => Target::Local,
                None => {
                    return Err(ErrorData::invalid_params(
                        format!("no live terminal for session {sid}"),
                        None,
                    ));
                }
            }
        };

        let cwd = state
            .agent_thread_cwd
            .lock()
            .unwrap()
            .get(&scope.thread_id)
            .cloned();

        // Shared live counts (C reads these for the final tally; B reads the
        // writer). The progress closure also emits to the UI.
        let counts = Arc::new(std::sync::Mutex::new((0u64, 0u64)));
        let app = self.app.clone();
        let cap_thread = scope.thread_id.clone();
        let counts_cb = counts.clone();
        let make_progress = move |cap_id: String| {
            let app = app.clone();
            let thread = cap_thread.clone();
            let counts = counts_cb.clone();
            move |lines: u64, bytes: u64| {
                *counts.lock().unwrap() = (lines, bytes);
                let _ = app.emit(
                    "agent-cc-capture-progress",
                    serde_json::json!({
                        "captureId": cap_id, "threadId": thread, "lines": lines, "bytes": bytes,
                    }),
                );
            }
        };

        let cancel = Arc::new(tokio::sync::Notify::new());

        // ---- C path: in-session, remote temp file (POSIX SSH only) ---------
        if reflect_session {
            let (handle, write_half) = match target {
                Target::Ssh(h, w) => (h, w),
                Target::Local => {
                    return Err(ErrorData::invalid_params(
                        "reflect_session=true is only available for remote SSH sessions; \
                         use reflect_session=false here"
                            .to_string(),
                        None,
                    ));
                }
            };
            let meta = state.captures.begin(
                &scope.thread_id,
                command,
                CaptureSource::RemoteFile {
                    session_id: sid.clone(),
                    path: String::new(),
                    family: crate::agent::capture::ShellFamily::Posix,
                },
            );
            let (family, path) = exec_c::start_c_ssh(&handle, &write_half, command, &meta.id)
                .await
                .map_err(|e| {
                    state
                        .captures
                        .finish(&meta.id, CaptureStatus::Failed, None, 0, 0, false);
                    ErrorData::invalid_params(e, None)
                })?;
            state.captures.set_source(
                &meta.id,
                CaptureSource::RemoteFile {
                    session_id: sid.clone(),
                    path: path.clone(),
                    family,
                },
            );
            state
                .cc_capture_cancels
                .lock()
                .unwrap()
                .insert(meta.id.clone(), cancel.clone());

            let progress = make_progress(meta.id.clone());
            let marker = format!("__TAOMNI_END_{}", meta.id);
            let poll = exec_c::poll_c_ssh(
                &handle,
                &write_half,
                &path,
                &marker,
                cancel.clone(),
                progress,
            );
            let (status, rc) =
                match tokio::time::timeout(Duration::from_secs(CAPTURE_TIMEOUT_SECS), poll).await {
                    Ok(r) => r,
                    Err(_) => {
                        cancel.notify_waiters();
                        (CaptureStatus::TimedOut, None)
                    }
                };
            state.cc_capture_cancels.lock().unwrap().remove(&meta.id);
            let (lines, bytes) = *counts.lock().unwrap();
            state
                .captures
                .finish(&meta.id, status, rc, lines, bytes, false);
            self.emit_capture_end(&meta.id, &scope.thread_id, status, lines, bytes, rc, false);

            let head = exec_c::reduce_remote(
                &handle,
                family,
                &path,
                &meta.id,
                &crate::agent::capture::reduce::ReduceOp::Head {
                    n: crate::agent::capture::SUMMARY_HEAD,
                },
            )
            .await
            .map(|r| r.text)
            .unwrap_or_default();
            let tail = exec_c::reduce_remote(
                &handle,
                family,
                &path,
                &meta.id,
                &crate::agent::capture::reduce::ReduceOp::Tail {
                    n: crate::agent::capture::SUMMARY_TAIL,
                },
            )
            .await
            .map(|r| r.text)
            .unwrap_or_default();
            return Ok(CallToolResult::success(vec![Content::text(
                capture_summary(&meta.id, status, rc, lines, bytes, false, &head, &tail),
            )]));
        }

        // ---- B path: independent channel / local child, Taomni-local file --
        let dir = state.captures.thread_dir(&scope.thread_id);
        let meta = state.captures.begin(
            &scope.thread_id,
            command,
            CaptureSource::LocalFile(dir.join("placeholder")),
        );
        let writer = crate::agent::capture::CaptureWriter::create(&dir, &meta.id)
            .map_err(|e| ErrorData::internal_error(format!("capture file: {e}"), None))?;
        state
            .captures
            .set_source(&meta.id, CaptureSource::LocalFile(writer.path()));
        state
            .cc_capture_cancels
            .lock()
            .unwrap()
            .insert(meta.id.clone(), cancel.clone());

        let progress = make_progress(meta.id.clone());
        let run = async {
            match target {
                Target::Ssh(handle, _) => {
                    exec_b::run_ssh(
                        &handle,
                        command,
                        cwd.as_deref(),
                        &writer,
                        cancel.clone(),
                        progress,
                    )
                    .await
                }
                Target::Local => {
                    exec_b::run_local(command, cwd.as_deref(), &writer, cancel.clone(), progress)
                        .await
                }
            }
        };
        let outcome =
            match tokio::time::timeout(Duration::from_secs(CAPTURE_TIMEOUT_SECS), run).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    state.captures.finish(
                        &meta.id,
                        CaptureStatus::Failed,
                        None,
                        writer.lines(),
                        writer.bytes(),
                        writer.truncated(),
                    );
                    state.cc_capture_cancels.lock().unwrap().remove(&meta.id);
                    return Err(ErrorData::internal_error(e, None));
                }
                Err(_) => {
                    cancel.notify_waiters();
                    exec_b::ExecOutcome {
                        status: CaptureStatus::TimedOut,
                        exit_code: None,
                    }
                }
            };

        state.cc_capture_cancels.lock().unwrap().remove(&meta.id);
        let truncated = writer.truncated();
        state.captures.finish(
            &meta.id,
            outcome.status,
            outcome.exit_code,
            writer.lines(),
            writer.bytes(),
            truncated,
        );
        self.emit_capture_end(
            &meta.id,
            &scope.thread_id,
            outcome.status,
            writer.lines(),
            writer.bytes(),
            outcome.exit_code,
            truncated,
        );

        let path = writer.path();
        let head = crate::agent::capture::reduce::reduce_file(
            &path,
            &crate::agent::capture::reduce::ReduceOp::Head {
                n: crate::agent::capture::SUMMARY_HEAD,
            },
        )
        .map(|r| r.text)
        .unwrap_or_default();
        let tail = crate::agent::capture::reduce::reduce_file(
            &path,
            &crate::agent::capture::reduce::ReduceOp::Tail {
                n: crate::agent::capture::SUMMARY_TAIL,
            },
        )
        .map(|r| r.text)
        .unwrap_or_default();
        // Mirror this run into the bound terminal as a read-only trace (the B
        // path is otherwise invisible there). `sid` is the terminal tab id.
        self.emit_terminal_echo(
            &sid,
            &scope.thread_id,
            &meta.id,
            command,
            &head,
            Some(&path),
            outcome.status,
            writer.lines(),
            writer.bytes(),
            outcome.exit_code,
            truncated,
        );
        Ok(CallToolResult::success(vec![Content::text(
            capture_summary(
                &meta.id,
                outcome.status,
                outcome.exit_code,
                writer.lines(),
                writer.bytes(),
                truncated,
                &head,
                &tail,
            ),
        )]))
    }

    /// Emit the capture-end event so the UI progress card clears.
    fn emit_capture_end(
        &self,
        id: &str,
        thread_id: &str,
        status: crate::agent::capture::CaptureStatus,
        lines: u64,
        bytes: u64,
        exit_code: Option<i32>,
        truncated: bool,
    ) {
        let _ = self.app.emit(
            "agent-cc-capture-end",
            serde_json::json!({
                "captureId": id, "threadId": thread_id,
                "status": format!("{status:?}"), "lines": lines, "bytes": bytes,
                "exitCode": exit_code, "truncated": truncated,
            }),
        );
    }

    /// Mirror a finished B-path captured run into its bound terminal as a
    /// read-only trace. The default `run_captured` path runs in an independent
    /// channel and is invisible in the live terminal; this event lets the
    /// frontend paint the command + a head of the output + stats into that
    /// terminal so the user sees what CC ran. `session_id` is the terminal *tab
    /// id* (the frontend registry key), not the backend session id. Not emitted
    /// for the C path (already visible via `tee`) or `run_in_terminal` (writes
    /// to the live session directly).
    #[allow(clippy::too_many_arguments)]
    fn emit_terminal_echo(
        &self,
        session_id: &str,
        thread_id: &str,
        capture_id: &str,
        command: &str,
        head: &str,
        capture_path: Option<&std::path::Path>,
        status: crate::agent::capture::CaptureStatus,
        lines: u64,
        bytes: u64,
        exit_code: Option<i32>,
        truncated: bool,
    ) {
        let capture_path = capture_path.map(|p| p.to_string_lossy().to_string());
        let _ = self.app.emit(
            "agent-cc-terminal-echo",
            serde_json::json!({
                "sessionId": session_id, "threadId": thread_id, "captureId": capture_id,
                "command": command, "head": head, "capturePath": capture_path,
                "status": format!("{status:?}"), "lines": lines, "bytes": bytes,
                "exitCode": exit_code, "truncated": truncated,
            }),
        );
    }

    /// Reduce a previously-captured output (方案4). Read-only, thread-scoped.
    async fn read_capture_impl(
        &self,
        scope: &TokenScope,
        p: &ReadCaptureParams,
    ) -> Result<CallToolResult, ErrorData> {
        use crate::agent::capture::CaptureSource;
        let meta = self
            .app_state()
            .captures
            .get_scoped(&scope.thread_id, &p.capture_id)
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    format!("no capture '{}' for this thread", p.capture_id),
                    None,
                )
            })?;
        let op = parse_reduce_op(p).map_err(|e| ErrorData::invalid_params(e, None))?;
        match &meta.source {
            CaptureSource::LocalFile(path) => {
                let r = crate::agent::capture::reduce::reduce_file(path, &op)
                    .map_err(|e| ErrorData::internal_error(e, None))?;
                Ok(CallToolResult::success(vec![Content::text(
                    annotate_reduce(r),
                )]))
            }
            CaptureSource::RemoteFile {
                session_id,
                path,
                family,
            } => {
                use crate::terminal::ActiveTerminal;
                // Re-resolve the SSH handle (the run may have been turns ago).
                // `session_id` is the tab id stored at capture time; translate to
                // the live backend session id (the connection — and its key — may
                // have changed across a reconnect since the capture ran).
                let st = self.app_state();
                let backend_sid = resolve_backend_session_id(&st, session_id);
                let handle = {
                    let terms = st.terminals.read().await;
                    match terms.get(&backend_sid) {
                        Some(ActiveTerminal::Ssh { handle, .. }) => handle.clone(),
                        _ => {
                            return Err(ErrorData::internal_error(
                                "the session backing this capture is no longer connected"
                                    .to_string(),
                                None,
                            ));
                        }
                    }
                };
                let r = crate::agent::capture::exec_c::reduce_remote(
                    &handle, *family, path, &meta.id, &op,
                )
                .await
                .map_err(|e| ErrorData::internal_error(e, None))?;
                Ok(CallToolResult::success(vec![Content::text(
                    annotate_reduce(r),
                )]))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct ListSessionsParams {
    /// Optional case-insensitive filter over session name / host.
    #[serde(default)]
    query: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct SearchHistoryParams {
    /// Substring to search command history for.
    query: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct ReadTerminalTailParams {
    session_id: Option<String>,
    #[serde(default)]
    lines: Option<u32>,
    /// Must be true — only available when the user explicitly triggered a read.
    user_invoked: bool,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct RunInTerminalParams {
    session_id: Option<String>,
    command: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SwitchTabParams {
    /// Session id, name, or host fragment to switch to.
    query: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct OpenSessionEditorParams {
    name: Option<String>,
    host: Option<String>,
    username: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SftpUploadParams {
    /// Optional; omitted calls target the thread's bound terminal/SFTP session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    /// Single local file or directory to upload. Use `local_paths` for batches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_path: Option<String>,
    /// Multiple local files/directories uploaded into `remote_path`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    local_paths: Vec<String>,
    /// Remote directory, or a full destination path when uploading one item.
    remote_path: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SftpDownloadParams {
    session_id: Option<String>,
    remote_path: String,
    local_dir: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SaveAsRunbookParams {
    name: String,
    commands: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct RunCapturedParams {
    /// Command to run on the bound session's host. Its full stdout+stderr are
    /// captured; only a summary is returned. Use read_capture to grep/page it.
    command: String,
    /// false (default): run in an independent channel (clean output, divorced
    /// from interactive shell state, cwd bridged). true: run in the live
    /// interactive session (visible, full shell state) — C path.
    #[serde(default)]
    reflect_session: bool,
    session_id: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize, Clone)]
struct ReadCaptureParams {
    capture_id: String,
    /// One of: head | tail | range | grep | jq | stats.
    op: String,
    /// head/tail: number of lines.
    n: Option<u32>,
    /// range: 1-based inclusive bounds.
    start: Option<u32>,
    end: Option<u32>,
    /// grep: regex pattern + optional context lines.
    pattern: Option<String>,
    context: Option<u32>,
    /// jq: filter expression.
    filter: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct PermissionParams {
    pub(crate) tool_name: String,
    // Claude Code's permission-prompt protocol sends the requested tool's input
    // under `input`. Accept `tool_input` as an alias for forward/back-compat.
    // Without this the field silently defaulted to `Null`, so we emitted
    // `args: null` to the UI and handed CC back `updatedInput: null`.
    #[serde(default, alias = "input")]
    pub(crate) tool_input: serde_json::Value,
}

pub(crate) fn as_value<T: serde::Serialize>(p: &T) -> serde_json::Value {
    serde_json::to_value(p).unwrap_or(serde_json::Value::Null)
}

/// Map `read_capture` params onto a typed reduction op, validating presence of
/// the fields each op needs.
fn parse_reduce_op(
    p: &ReadCaptureParams,
) -> Result<crate::agent::capture::reduce::ReduceOp, String> {
    use crate::agent::capture::reduce::ReduceOp;
    match p.op.as_str() {
        "head" => Ok(ReduceOp::Head {
            n: p.n.unwrap_or(50) as usize,
        }),
        "tail" => Ok(ReduceOp::Tail {
            n: p.n.unwrap_or(50) as usize,
        }),
        "range" => {
            let start = p.start.ok_or("range requires `start`")? as usize;
            let end = p.end.ok_or("range requires `end`")? as usize;
            Ok(ReduceOp::Range { start, end })
        }
        "grep" => Ok(ReduceOp::Grep {
            pattern: p.pattern.clone().ok_or("grep requires `pattern`")?,
            context: p.context.unwrap_or(0) as usize,
        }),
        "jq" => Ok(ReduceOp::Jq {
            filter: p.filter.clone().ok_or("jq requires `filter`")?,
        }),
        "stats" => Ok(ReduceOp::Stats),
        other => Err(format!(
            "unknown op '{other}' (expected head|tail|range|grep|jq|stats)"
        )),
    }
}

/// Append the reduction's note / truncation receipt to its text for CC.
fn annotate_reduce(r: crate::agent::capture::reduce::ReduceResult) -> String {
    let mut text = r.text;
    if let Some(note) = r.note {
        text.push_str(&format!("\n[{note}]"));
    }
    if r.truncated {
        text.push_str("\n[output clipped by read_capture cap — narrow with grep/range]");
    }
    text
}

/// Build the bounded `run_captured` summary (shared by B and C paths).
fn capture_summary(
    id: &str,
    status: crate::agent::capture::CaptureStatus,
    rc: Option<i32>,
    lines: u64,
    bytes: u64,
    truncated: bool,
    head: &str,
    tail: &str,
) -> String {
    format!(
        "[capture {id}] status={status:?} exit={exit} lines={lines} bytes≈{bytes} truncated={trunc}\n\
         --- head {h} ---\n{head}--- tail {t} ---\n{tail}\
         提示：完整输出已捕获。用 read_capture(capture_id=\"{id}\", op=\"grep|head|tail|range|jq|stats\", …) 按需检索，不要重跑命令。",
        exit = rc.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
        trunc = truncated,
        h = crate::agent::capture::SUMMARY_HEAD,
        t = crate::agent::capture::SUMMARY_TAIL,
    )
}

/// Normalize a tool call's `session_id` to the canonical terminal *tab id*.
///
/// - Omitted (the common case — CC doesn't know the thread's bound session):
///   inject the bound tab id so the effect targets the linked terminal and the
///   scope check passes. No-op for a global thread (no bound session).
/// - Present as the advertised `SessionConfig.id`: rewrite it to the tab id, so
///   downstream registry / `state.terminals` lookups (which key on the tab id)
///   resolve instead of missing. The identity card hands CC the config id, so
///   this is the path CC takes when it "helpfully" names the session.
/// - Present as the tab id already, or as a foreign id: left unchanged (a
///   foreign id is then rejected by `enforce_session_scope`).
fn fill_session_id(args: &mut serde_json::Value, scope: &TokenScope) {
    // Own the present value first so the immutable borrow of `args` is released
    // before we may mutate it below.
    let present: Option<String> = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let target: Option<String> = match present {
        // Omitted: inject the bound tab id (None for a global thread → no-op).
        None => scope.allowed_session_id.clone(),
        // Present: rewrite an advertised config id to the canonical tab id; a
        // tab id (already canonical) or a foreign id needs no change here (a
        // foreign id is rejected later by `enforce_session_scope`).
        Some(sid) => match canonical_bound_id(scope, &sid) {
            Some(tab) if tab != sid => Some(tab.to_string()),
            _ => None,
        },
    };
    if let (Some(sid), Some(obj)) = (target, args.as_object_mut()) {
        obj.insert("session_id".into(), serde_json::Value::String(sid));
    }
}

/// Resolve a caller-facing session id (a terminal *tab id* — what the token
/// scope and `fill_session_id` use) to the *backend terminal session id* that
/// keys `state.terminals`. The frontend reports this mapping as terminals
/// connect (`cc_track_terminal`). `run_in_terminal` / `read_terminal_tail`
/// don't need this — they dispatch the tab id to the frontend registry, which
/// owns the indirection — but the backend-side capture tools (`run_captured` /
/// `read_capture`) index `state.terminals` directly and must translate first.
///
/// Falls back to the id unchanged when no mapping exists, so a caller that
/// already passes a backend session id, or a test/local setup with no tracking,
/// still resolves (a miss then surfaces as the usual "no live terminal").
fn resolve_backend_session_id(state: &AppState, sid: &str) -> String {
    state
        .cc_tab_sessions
        .lock()
        .ok()
        .and_then(|m| m.get(sid).cloned())
        .unwrap_or_else(|| sid.to_string())
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

#[tool_router]
impl CcHandler {
    #[tool(
        name = "list_sessions",
        description = "列出所有已保存的 SSH/终端会话（可按名称/主机过滤）"
    )]
    async fn list_sessions(
        &self,
        Parameters(p): Parameters<ListSessionsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let q = p.query.unwrap_or_default().to_lowercase();
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let lines: Vec<String> = sessions
            .iter()
            .filter(|s| {
                q.is_empty()
                    || s.name.to_lowercase().contains(&q)
                    || s.host.to_lowercase().contains(&q)
            })
            .map(|s| {
                format!(
                    "{}: {} ({}@{}:{})",
                    s.id,
                    s.name,
                    s.username.as_deref().unwrap_or(""),
                    s.host,
                    s.port
                )
            })
            .collect();
        Ok(CallToolResult::success(vec![Content::text(
            lines.join("\n"),
        )]))
    }

    #[tool(
        name = "search_history",
        description = "搜索命令历史记录并返回匹配的命令列表"
    )]
    async fn search_history(
        &self,
        Parameters(p): Parameters<SearchHistoryParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let results = crate::history::db_search(&db, &p.query, 20)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::text(
            results.join("\n"),
        )]))
    }

    #[tool(
        name = "read_terminal_tail",
        description = "读取当前活跃终端最近 N 行输出（需 user_invoked=true）"
    )]
    async fn read_terminal_tail(
        &self,
        Parameters(p): Parameters<ReadTerminalTailParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "read_terminal_tail", args)
            .await
    }

    #[tool(
        name = "run_in_terminal",
        description = "在指定会话的终端中执行命令（危险动作，需用户确认）"
    )]
    async fn run_in_terminal(
        &self,
        Parameters(p): Parameters<RunInTerminalParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        let is_readonly = !scope.confirm_readonly
            && crate::agent::cmd_classify::classify(&p.command)
                == crate::agent::cmd_classify::CommandClass::ReadOnly;
        enforce_inline_permission(&self.app, &scope, "run_in_terminal", &args, is_readonly).await?;
        // Defense in depth: re-run the blacklist even though permission_prompt
        // already did (CC may have an allowlist that skips the prompt).
        let call = ToolCall {
            tool: "run_in_terminal".into(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "run_in_terminal", args)
            .await
    }

    #[tool(
        name = "switch_tab",
        description = "旧版兼容工具；打开/切换 Taomni 会话请优先使用 taomni_control.session_open，切换已打开标签请用 taomni_control.tab_switch。"
    )]
    async fn switch_tab(
        &self,
        Parameters(p): Parameters<SwitchTabParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "switch_tab", as_value(&p))
            .await
    }

    #[tool(
        name = "open_session_editor",
        description = "旧版兼容工具；打开 Taomni 会话编辑器请优先使用 taomni_control.session_open_editor。"
    )]
    async fn open_session_editor(
        &self,
        Parameters(p): Parameters<OpenSessionEditorParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "open_session_editor", as_value(&p))
            .await
    }

    #[tool(
        name = "sftp_upload",
        description = "上传一个或多个本地文件/目录到绑定的 SFTP 会话；local_path 传单个，local_paths 传多个；remote_path 可为远端目录，单文件时也可为完整目标路径。超过 60 MiB 时界面会提示耗时和进度。危险动作需用户确认。"
    )]
    async fn sftp_upload(
        &self,
        Parameters(p): Parameters<SftpUploadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        enforce_inline_permission(&self.app, &scope, "sftp_upload", &args, false).await?;
        self.dispatch_side_effect(&scope, "sftp_upload", args).await
    }

    #[tool(
        name = "sftp_download",
        description = "从绑定的 SFTP 会话下载远程文件/目录到本地目录；若目标已存在，界面会自动加序号避免覆盖。"
    )]
    async fn sftp_download(
        &self,
        Parameters(p): Parameters<SftpDownloadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "sftp_download", args)
            .await
    }

    #[tool(
        name = "save_as_runbook",
        description = "把一组命令打包成 Runbook（写动作，需用户确认）"
    )]
    async fn save_as_runbook(
        &self,
        Parameters(p): Parameters<SaveAsRunbookParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = as_value(&p);
        enforce_inline_permission(&self.app, &scope, "save_as_runbook", &args, false).await?;
        self.dispatch_side_effect(&scope, "save_as_runbook", args)
            .await
    }

    #[tool(
        name = "run_captured",
        description = "在绑定会话主机上运行命令并完整捕获输出（stdout+stderr+退出码），只返回摘要；用于输出很大、需要后续 grep/分页分析的场景，避免把大量输出灌进上下文。之后用 read_capture 检索。reflect_session=false（默认）在独立通道运行（输出干净、与交互 shell 状态隔离）；true 在当前交互会话内运行并可见（保留 cwd/环境，仅支持 POSIX 远端 SSH）。危险动作需用户确认。"
    )]
    async fn run_captured(
        &self,
        Parameters(p): Parameters<RunCapturedParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        let is_readonly = !scope.confirm_readonly
            && crate::agent::cmd_classify::classify(&p.command)
                == crate::agent::cmd_classify::CommandClass::ReadOnly;
        enforce_inline_permission(&self.app, &scope, "run_captured", &args, is_readonly).await?;
        // Defense in depth: re-run the blacklist (permission_prompt already did,
        // but CC may have an allowlist that skips the prompt).
        let call = ToolCall {
            tool: "run_captured".into(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        self.run_captured_impl(&scope, &p.command, p.reflect_session, session_id)
            .await
    }

    #[tool(
        name = "read_capture",
        description = "检索 run_captured 的完整输出：op=head|tail|range|grep|jq|stats（grep 用正则、jq 用 jq 表达式）。每次返回有界，必要时用 grep/range 收窄。只读、限本线程自己的捕获。"
    )]
    async fn read_capture(
        &self,
        Parameters(p): Parameters<ReadCaptureParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.read_capture_impl(&scope, &p).await
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Claude Code tool call per Taomni's safety rules + human-in-the-loop confirmation."
    )]
    async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;

        // CC sends MCP tools as `mcp__taomni__<tool>`; grade the bare name.
        let tool_name = normalize_tool_name(&p.tool_name).to_string();

        // 3.6 — a confidently read-only shell command waives the *confirmation*
        // card (unless the user forced confirm-all via config). Anything not
        // provably read-only stays Mutating (the safe default) and still
        // confirms. The safety checks inside `decide_permission` always run, so
        // this only ever waives confirmation, never safety.
        let is_readonly = !scope.confirm_readonly
            && matches!(
                tool_name.as_str(),
                "Bash" | "run_in_terminal" | "run_captured"
            )
            && p.tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .map(|cmd| {
                    crate::agent::cmd_classify::classify(cmd)
                        == crate::agent::cmd_classify::CommandClass::ReadOnly
                })
                .unwrap_or(false);

        Ok(decide_permission(&self.app, &scope, &p.tool_name, &p.tool_input, is_readonly).await)
    }
}

#[tool_handler]
impl ServerHandler for CcHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions =
            Some("Taomni in-app tools. Side-effect tools route through human confirmation.".into());
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope(thread: &str, allowed: Option<&str>) -> TokenScope {
        TokenScope {
            thread_id: thread.into(),
            allowed_session_id: allowed.map(|s| s.to_string()),
            allowed_config_id: None,
            trust: TrustLevel::Strict,
            flavor: Flavor::Shell,
            confirm_readonly: false,
            inline_permission: false,
            session_approved: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Variant carrying a bound `SessionConfig.id` (the id the identity card
    /// advertises), so we can exercise config-id acceptance / normalization.
    fn scope_with_config(thread: &str, tab: &str, config: &str) -> TokenScope {
        TokenScope {
            thread_id: thread.into(),
            allowed_session_id: Some(tab.to_string()),
            allowed_config_id: Some(config.to_string()),
            trust: TrustLevel::Strict,
            flavor: Flavor::Shell,
            confirm_readonly: false,
            inline_permission: false,
            session_approved: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[test]
    fn no_session_id_always_in_scope() {
        let s = scope("t1", Some("sess-a"));
        assert!(enforce_session_scope(&s, &json!({ "command": "ls" })).is_ok());
    }

    #[test]
    fn matching_session_id_allowed() {
        let s = scope("t1", Some("sess-a"));
        assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-a" })).is_ok());
    }

    #[test]
    fn foreign_session_id_rejected() {
        let s = scope("t1", Some("sess-a"));
        assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-b" })).is_err());
    }

    #[test]
    fn local_token_cannot_name_any_session() {
        // A thread bound to no session (local working dir) must not touch one.
        let s = scope("t1", None);
        assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-a" })).is_err());
    }

    #[test]
    fn allow_result_carries_updated_input() {
        let input = json!({ "command": "ls -la" });
        let parsed: serde_json::Value = serde_json::from_str(&allow_json(&input)).unwrap();
        assert_eq!(parsed["behavior"], "allow");
        assert_eq!(parsed["updatedInput"]["command"], "ls -la");
    }

    #[test]
    fn deny_result_carries_message() {
        let parsed: serde_json::Value =
            serde_json::from_str(&deny_json("blocked: rm -rf /")).unwrap();
        assert_eq!(parsed["behavior"], "deny");
        assert_eq!(parsed["message"], "blocked: rm -rf /");
    }

    #[test]
    fn normalize_strips_mcp_prefix() {
        // CC sends our tools prefixed; grading must see the bare name so
        // `requires_confirmation` recognizes the write tool and fires a card.
        assert_eq!(
            normalize_tool_name("mcp__taomni__run_in_terminal"),
            "run_in_terminal"
        );
        assert!(crate::agent::safety::requires_confirmation(
            normalize_tool_name("mcp__taomni__run_in_terminal")
        ));
    }

    #[test]
    fn normalize_leaves_builtin_tools_untouched() {
        assert_eq!(normalize_tool_name("Bash"), "Bash");
        assert_eq!(normalize_tool_name("Edit"), "Edit");
    }

    #[test]
    fn control_tools_do_not_use_bound_terminal_scope() {
        assert!(!tool_uses_bound_session_scope("session_open"));
        assert!(!tool_uses_bound_session_scope(
            "mcp__taomni_control__session_open"
        ));
        assert!(!tool_uses_bound_session_scope("session_get"));
        assert!(!tool_uses_bound_session_scope("tab_duplicate"));
        assert!(!tool_uses_bound_session_scope("switch_tab"));

        assert!(tool_uses_bound_session_scope("run_in_terminal"));
        assert!(tool_uses_bound_session_scope(
            "mcp__taomni__run_in_terminal"
        ));
        assert!(tool_uses_bound_session_scope("run_sql"));
        assert!(tool_uses_bound_session_scope("redis_exec"));
    }

    #[test]
    fn control_session_ids_are_not_execution_scope_ids() {
        let s = scope("t1", Some("current-tab"));
        let args = json!({ "session_id": "pi-1" });

        assert!(enforce_session_scope(&s, &args).is_err());
        assert!(!tool_uses_bound_session_scope("session_open"));
        assert!(tool_uses_bound_session_scope("run_in_terminal"));
    }

    #[test]
    fn flavor_for_session_type_maps_db_engines() {
        use crate::session::models::SessionType;
        let sql = [
            SessionType::MySQL,
            SessionType::PostgreSQL,
            SessionType::PanWeiDB,
            SessionType::Oracle,
            SessionType::SQLServer,
            SessionType::StarRocks,
            SessionType::ClickHouse,
            SessionType::Presto,
        ];
        for t in sql {
            assert_eq!(
                Flavor::for_session_type(Some(&t)),
                Flavor::Sql,
                "{t:?} → Sql"
            );
        }
        assert_eq!(
            Flavor::for_session_type(Some(&SessionType::Redis)),
            Flavor::Redis
        );
        // Terminal / object-storage / unbound all fall back to Shell.
        assert_eq!(
            Flavor::for_session_type(Some(&SessionType::SSH)),
            Flavor::Shell
        );
        assert_eq!(
            Flavor::for_session_type(Some(&SessionType::HBaseShell)),
            Flavor::Shell
        );
        assert_eq!(Flavor::for_session_type(None), Flavor::Shell);
    }

    #[test]
    fn flavor_paths_and_servers_are_distinct() {
        // Each flavor mounts a distinct path + names a distinct server, so a
        // thread's .mcp.json (one server) can't accidentally expose another
        // flavor's tools.
        for f in [Flavor::Shell, Flavor::Sql, Flavor::Redis, Flavor::Control] {
            assert!(f.permission_prompt_tool().contains(f.server_name()));
        }
        assert_ne!(Flavor::Sql.path(), Flavor::Redis.path());
        assert_ne!(Flavor::Sql.path(), Flavor::Shell.path());
        assert_ne!(Flavor::Control.path(), Flavor::Shell.path());
        assert_ne!(Flavor::Sql.server_name(), Flavor::Shell.server_name());
        assert_eq!(Flavor::Control.server_name(), "taomni_control");
    }

    #[test]
    fn parse_reduce_op_maps_each_op() {
        use crate::agent::capture::reduce::ReduceOp;
        let base = |op: &str| ReadCaptureParams {
            capture_id: "c".into(),
            op: op.into(),
            n: None,
            start: None,
            end: None,
            pattern: None,
            context: None,
            filter: None,
        };
        assert_eq!(
            parse_reduce_op(&ReadCaptureParams {
                n: Some(10),
                ..base("head")
            })
            .unwrap(),
            ReduceOp::Head { n: 10 }
        );
        assert_eq!(
            parse_reduce_op(&base("tail")).unwrap(),
            ReduceOp::Tail { n: 50 } // default
        );
        assert_eq!(
            parse_reduce_op(&ReadCaptureParams {
                start: Some(2),
                end: Some(5),
                ..base("range")
            })
            .unwrap(),
            ReduceOp::Range { start: 2, end: 5 }
        );
        assert_eq!(
            parse_reduce_op(&ReadCaptureParams {
                pattern: Some("ERR".into()),
                context: Some(2),
                ..base("grep")
            })
            .unwrap(),
            ReduceOp::Grep {
                pattern: "ERR".into(),
                context: 2
            }
        );
        assert_eq!(
            parse_reduce_op(&ReadCaptureParams {
                filter: Some(".a".into()),
                ..base("jq")
            })
            .unwrap(),
            ReduceOp::Jq {
                filter: ".a".into()
            }
        );
        assert_eq!(parse_reduce_op(&base("stats")).unwrap(), ReduceOp::Stats);
    }

    #[test]
    fn parse_reduce_op_requires_op_fields() {
        let p = ReadCaptureParams {
            capture_id: "c".into(),
            op: "range".into(),
            n: None,
            start: None,
            end: None,
            pattern: None,
            context: None,
            filter: None,
        };
        assert!(
            parse_reduce_op(&p).is_err(),
            "range without start/end must error"
        );
        let p2 = ReadCaptureParams {
            op: "grep".into(),
            ..p.clone()
        };
        assert!(
            parse_reduce_op(&p2).is_err(),
            "grep without pattern must error"
        );
        let p3 = ReadCaptureParams {
            op: "bogus".into(),
            ..p
        };
        assert!(parse_reduce_op(&p3).is_err(), "unknown op must error");
    }

    #[test]
    fn permission_params_reads_cc_input_field() {
        // CC's permission-prompt protocol sends the requested tool's args under
        // `input`. If we only accept `tool_input` the field defaults to Null and
        // we emit `args: null` (crashing the UI card) + hand CC `updatedInput: null`.
        let p: PermissionParams = serde_json::from_value(json!({
            "tool_name": "mcp__taomni__run_in_terminal",
            "input": { "command": "uname -a" }
        }))
        .unwrap();
        assert_eq!(p.tool_input["command"], "uname -a");
    }

    #[test]
    fn permission_params_still_reads_tool_input_alias() {
        let p: PermissionParams = serde_json::from_value(json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls" }
        }))
        .unwrap();
        assert_eq!(p.tool_input["command"], "ls");
    }

    #[test]
    fn fill_session_id_uses_bound_session_when_omitted() {
        let s = scope("t1", Some("sess-a"));
        let mut args = json!({ "command": "uname -a" });
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "sess-a");
        // And the scope check now passes for the injected id.
        assert!(enforce_session_scope(&s, &args).is_ok());
    }

    #[test]
    fn fill_session_id_replaces_null_session_id() {
        let s = scope("t1", Some("sess-a"));
        let mut args = json!({
            "session_id": null,
            "local_path": "d:\\temp\\a.txt",
            "remote_path": "/tmp"
        });
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "sess-a");
        assert!(enforce_session_scope(&s, &args).is_ok());
    }

    #[test]
    fn fill_session_id_respects_explicit_arg() {
        let s = scope("t1", Some("sess-a"));
        let mut args = json!({ "session_id": "sess-a", "command": "ls" });
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "sess-a");
    }

    #[test]
    fn fill_session_id_noop_for_global_thread() {
        let s = scope("t1", None);
        let mut args = json!({ "command": "ls" });
        fill_session_id(&mut args, &s);
        assert!(args.get("session_id").is_none());
    }

    #[test]
    fn config_id_is_in_scope_and_normalized_to_tab_id() {
        // The identity card hands CC the SessionConfig.id; CC then names it as
        // session_id. It must be accepted (scope) and rewritten to the tab id
        // (fill) so downstream registry / state.terminals lookups resolve.
        let s = scope_with_config("t1", "ssh-cfg-123", "cfg-uuid");
        let mut args = json!({ "session_id": "cfg-uuid", "command": "free -h" });
        assert!(enforce_session_scope(&s, &args).is_ok());
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "ssh-cfg-123");
        assert!(enforce_session_scope(&s, &args).is_ok());
    }

    #[test]
    fn tab_id_stays_canonical_with_config_bound() {
        let s = scope_with_config("t1", "ssh-cfg-123", "cfg-uuid");
        let mut args = json!({ "session_id": "ssh-cfg-123", "command": "ls" });
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "ssh-cfg-123");
    }

    #[test]
    fn foreign_session_id_rejected_even_with_config_bound() {
        let s = scope_with_config("t1", "ssh-cfg-123", "cfg-uuid");
        assert!(enforce_session_scope(&s, &json!({ "session_id": "ssh-other-999" })).is_err());
    }

    // Exercises the Bearer auth boundary over a real loopback HTTP round-trip,
    // using the same `auth_mw` the server mounts — without needing CC or a
    // Tauri AppState. Covers the "401 when no/invalid token" requirement.
    #[tokio::test]
    async fn auth_middleware_gates_on_bearer() {
        use axum::routing::get;

        let tokens: TokenMap = Arc::new(Mutex::new(HashMap::new()));
        tokens
            .lock()
            .unwrap()
            .insert("good-token".to_string(), scope("t1", None));

        let mw_tokens = tokens.clone();
        let app = axum::Router::new()
            .route("/x", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(
                move |req: Request, next: Next| {
                    let toks = mw_tokens.clone();
                    async move { auth_mw(toks, req, next).await }
                },
            ));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let base = format!("http://{addr}/x");
        let client = reqwest::Client::new();

        let no_token = client.get(&base).send().await.unwrap();
        assert_eq!(no_token.status(), 401, "missing token must be 401");

        let bad = client
            .get(&base)
            .header("Authorization", "Bearer wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), 401, "unknown token must be 401");

        let good = client
            .get(&base)
            .header("Authorization", "Bearer good-token")
            .send()
            .await
            .unwrap();
        assert_eq!(good.status(), 200, "valid token must pass");
    }
}
