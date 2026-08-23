use crate::agent::local::{LocalAgentEvent, LocalAgentUsage};
use serde::Serialize;
use serde_json::{Value, json};
use std::fmt;

pub const ACP_PROTOCOL_VERSION: u64 = 1;
pub const JSON_RPC_VERSION: &str = "2.0";

pub const METHOD_INITIALIZE: &str = "initialize";
pub const METHOD_AUTHENTICATE: &str = "authenticate";
pub const METHOD_SESSION_NEW: &str = "session/new";
pub const METHOD_SESSION_LOAD: &str = "session/load";
pub const METHOD_SESSION_PROMPT: &str = "session/prompt";
pub const METHOD_SESSION_CANCEL: &str = "session/cancel";
pub const METHOD_SESSION_UPDATE: &str = "session/update";
pub const METHOD_SESSION_REQUEST_PERMISSION: &str = "session/request_permission";

/// JSON-RPC IDs accepted by ACP. Taomni emits monotonically increasing numeric
/// IDs, but string IDs are parsed too so unexpected peer requests can receive a
/// standards-compliant error response.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum AcpRequestId {
    Number(u64),
    String(String),
}

impl From<u64> for AcpRequestId {
    fn from(value: u64) -> Self {
        Self::Number(value)
    }
}

impl AcpRequestId {
    fn parse(value: &Value) -> Result<Self, AcpProtocolError> {
        if let Some(id) = value.as_u64() {
            return Ok(Self::Number(id));
        }
        if let Some(id) = value.as_str() {
            return Ok(Self::String(id.to_string()));
        }
        Err(AcpProtocolError::InvalidRequestId)
    }
}

/// A JSON-RPC request sent from Taomni to an ACP agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcpRequest {
    #[serde(rename = "jsonrpc")]
    json_rpc: &'static str,
    pub id: AcpRequestId,
    pub method: String,
    pub params: Value,
}

impl AcpRequest {
    pub fn new(id: impl Into<AcpRequestId>, method: impl Into<String>, params: Value) -> Self {
        Self {
            json_rpc: JSON_RPC_VERSION,
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// A JSON-RPC notification sent from Taomni to an ACP agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcpNotification {
    #[serde(rename = "jsonrpc")]
    json_rpc: &'static str,
    pub method: String,
    pub params: Value,
}

impl AcpNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            json_rpc: JSON_RPC_VERSION,
            method: method.into(),
            params,
        }
    }
}

/// The supported subset of JSON-RPC envelopes received from an ACP agent.
///
/// Agent-to-client requests are retained so the stdio runtime can surface the
/// standard permission request through a human gate while explicitly rejecting
/// filesystem, terminal, and other unsupported calls. Taomni does not
/// advertise those capabilities in v1.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpIncomingMessage {
    Response {
        id: AcpRequestId,
        result: Value,
    },
    ErrorResponse {
        id: Option<AcpRequestId>,
        error: AcpRpcError,
    },
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: AcpRequestId,
        method: String,
        params: Value,
    },
}

/// A sanitized JSON-RPC error. The optional `data` field is intentionally not
/// retained because agents may place credentials or raw configuration there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpProtocolError {
    InvalidJson,
    InvalidJsonRpcVersion,
    InvalidEnvelope(&'static str),
    InvalidRequestId,
    InvalidInitializeResponse(&'static str),
    InvalidPermissionRequest(&'static str),
    MissingSessionId,
    MissingPromptStopReason,
}

impl fmt::Display for AcpProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson => f.write_str("ACP agent emitted invalid JSON"),
            Self::InvalidJsonRpcVersion => f.write_str("ACP message is not JSON-RPC 2.0"),
            Self::InvalidEnvelope(detail) => write!(f, "invalid ACP JSON-RPC envelope: {detail}"),
            Self::InvalidRequestId => f.write_str("ACP message contains an invalid request id"),
            Self::InvalidInitializeResponse(detail) => {
                write!(f, "invalid ACP initialize response: {detail}")
            }
            Self::InvalidPermissionRequest(detail) => {
                write!(f, "invalid ACP permission request: {detail}")
            }
            Self::MissingSessionId => {
                f.write_str("ACP session response did not include a session id")
            }
            Self::MissingPromptStopReason => {
                f.write_str("ACP prompt response did not include a stop reason")
            }
        }
    }
}

impl std::error::Error for AcpProtocolError {}

/// Parse one newline-delimited JSON-RPC message without retaining the original
/// line. The caller can safely report the returned error without leaking raw
/// ACP diagnostics or configuration.
pub fn parse_incoming_line(line: &str) -> Result<AcpIncomingMessage, AcpProtocolError> {
    let value: Value = serde_json::from_str(line).map_err(|_| AcpProtocolError::InvalidJson)?;
    let object = value.as_object().ok_or(AcpProtocolError::InvalidEnvelope(
        "message is not an object",
    ))?;

    if object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION) {
        return Err(AcpProtocolError::InvalidJsonRpcVersion);
    }

    let params = object.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        return match object.get("id") {
            Some(id) if !id.is_null() => Ok(AcpIncomingMessage::Request {
                id: AcpRequestId::parse(id)?,
                method: method.to_string(),
                params,
            }),
            _ => Ok(AcpIncomingMessage::Notification {
                method: method.to_string(),
                params,
            }),
        };
    }

    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error {
        return Err(AcpProtocolError::InvalidEnvelope(
            "response must contain exactly one of result or error",
        ));
    }

    if has_result {
        let id = object.get("id").filter(|id| !id.is_null()).ok_or(
            AcpProtocolError::InvalidEnvelope("result response is missing id"),
        )?;
        return Ok(AcpIncomingMessage::Response {
            id: AcpRequestId::parse(id)?,
            result: object.get("result").cloned().unwrap_or(Value::Null),
        });
    }

    let error = object
        .get("error")
        .and_then(Value::as_object)
        .ok_or(AcpProtocolError::InvalidEnvelope("error is not an object"))?;
    let code = error
        .get("code")
        .and_then(Value::as_i64)
        .ok_or(AcpProtocolError::InvalidEnvelope("error code is missing"))?;
    let message =
        error
            .get("message")
            .and_then(Value::as_str)
            .ok_or(AcpProtocolError::InvalidEnvelope(
                "error message is missing",
            ))?;
    let id = match object.get("id") {
        Some(id) if !id.is_null() => Some(AcpRequestId::parse(id)?),
        _ => None,
    };
    Ok(AcpIncomingMessage::ErrorResponse {
        id,
        error: AcpRpcError {
            code,
            message: truncate_display_text(message, 500),
        },
    })
}

/// A permission option whose opaque id is returned to the ACP agent only
/// after the user explicitly selects it. The request parser keeps just the
/// display-safe fields needed by the confirmation UI; `rawInput` and other
/// tool metadata are deliberately discarded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: AcpPermissionOptionKind,
}

/// ACP v1 permission choices supported by Taomni's human confirmation gate.
/// Unknown choices are rejected rather than presented with ambiguous safety
/// semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpPermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

/// The safe subset of an agent-originated `session/request_permission` call.
/// Session and tool-call ids stay inside the runtime; the UI receives only the
/// title, kind, and explicitly offered choices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpPermissionRequest {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: String,
    pub options: Vec<AcpPermissionOption>,
    /// When true, the tool targets Taomni's scoped MCP surface, which already
    /// owns the human-in-the-loop ActionCard for side effects. The ACP runtime
    /// auto-selects an allow option so the user is not asked twice.
    pub deferred_to_mcp: bool,
}

/// Parse a standard ACP `session/request_permission` request without
/// retaining raw tool arguments. The agent's option ids are opaque, so they
/// are kept exactly as sent and validated again before resolving the request.
pub fn parse_permission_request(params: &Value) -> Result<AcpPermissionRequest, AcpProtocolError> {
    let params = params
        .as_object()
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "params are not an object",
        ))?;
    let session_id = permission_identifier(params.get("sessionId"), "sessionId")?;
    let tool_call = params.get("toolCall").and_then(Value::as_object).ok_or(
        AcpProtocolError::InvalidPermissionRequest("toolCall is missing"),
    )?;
    let tool_call_id = permission_identifier(tool_call.get("toolCallId"), "toolCallId")?;
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| truncate_display_text(title, 240))
        .unwrap_or_else(|| "Tool action".into());
    let kind = tool_call
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .map(|kind| truncate_display_text(kind, 80))
        .unwrap_or_else(|| "tool".into());
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty())
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "options are missing",
        ))?
        .iter()
        .map(parse_permission_option)
        .collect::<Result<Vec<_>, _>>()?;

    if options.len() > 8 {
        return Err(AcpProtocolError::InvalidPermissionRequest(
            "too many options",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if options
        .iter()
        .any(|option| !seen.insert(option.option_id.as_str()))
    {
        return Err(AcpProtocolError::InvalidPermissionRequest(
            "option ids are not unique",
        ));
    }

    let deferred_to_mcp = tool_call_targets_taomni_mcp(tool_call);

    Ok(AcpPermissionRequest {
        session_id,
        tool_call_id,
        title,
        kind,
        options,
        deferred_to_mcp,
    })
}

/// Detect whether a permission request is for a Taomni-scoped MCP tool.
///
/// Grok (and other ACP agents) prompt via `session/request_permission` before
/// every non-auto-approved tool. Taomni MCP write tools then run the audited
/// ActionCard pipeline again. Identifying our MCP surface lets the runtime
/// skip the first card so the user only confirms once.
///
/// Only stable tool-name identifiers are inspected — never free-form argument
/// values — so secrets in `rawInput` never leave this check.
pub fn tool_call_targets_taomni_mcp(tool_call: &serde_json::Map<String, Value>) -> bool {
    for candidate in permission_tool_name_candidates(tool_call) {
        if is_taomni_mcp_tool_name(&candidate) {
            return true;
        }
    }
    false
}

/// Return true for fully-qualified Taomni MCP tool names in either Grok's
/// `server__tool` form or Claude's `mcp__server__tool` form, plus a small set
/// of bare tool names that only exist on Taomni's MCP surface (so a dispatcher
/// that drops the server prefix still defers correctly).
pub fn is_taomni_mcp_tool_name(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 256 {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("taomni__")
        || lower.starts_with("taomni_sql__")
        || lower.starts_with("taomni_redis__")
        || lower.starts_with("taomni_control__")
        || lower.starts_with("mcp__taomni__")
        || lower.starts_with("mcp__taomni_sql__")
        || lower.starts_with("mcp__taomni_redis__")
        || lower.starts_with("mcp__taomni_control__")
    {
        return true;
    }
    // Bare names that do not collide with Grok-native tools
    // (`run_terminal_command`, `search_replace`, …). Keep this list narrow.
    matches!(
        lower.as_str(),
        "run_in_terminal"
            | "run_captured"
            | "read_capture"
            | "read_terminal_tail"
            | "sftp_upload"
            | "sftp_download"
            | "save_as_runbook"
            | "open_session_editor"
            | "switch_tab"
            | "run_sql"
            | "run_sql_captured"
            | "export_result"
            | "redis_set_key"
            | "redis_del_key"
            | "redis_exec"
            | "session_open"
            | "session_create"
            | "session_update"
            | "session_delete"
            | "tab_switch"
            | "tab_close"
            | "quick_connect"
    )
}

fn permission_tool_name_candidates(tool_call: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<String>, value: Option<&str>| {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            if !out.iter().any(|existing| existing == value) {
                out.push(value.to_string());
            }
        }
    };

    push(&mut out, tool_call.get("title").and_then(Value::as_str));
    for key in ["name", "toolName", "tool_name", "serverToolName"] {
        push(&mut out, tool_call.get(key).and_then(Value::as_str));
    }
    if let Some(meta_name) = tool_call
        .get("_meta")
        .and_then(|meta| meta.pointer("/x.ai/tool/name"))
        .and_then(Value::as_str)
    {
        push(&mut out, Some(meta_name));
    }

    // Dispatcher wrappers (use_tool / CallMcpTool) may nest the real name.
    // Only read known identifier keys — never arbitrary argument values.
    if let Some(raw) = tool_call.get("rawInput").and_then(Value::as_object) {
        for key in [
            "name",
            "tool",
            "toolName",
            "tool_name",
            "serverToolName",
            "qualifiedName",
            "qualified_name",
        ] {
            push(&mut out, raw.get(key).and_then(Value::as_str));
        }
        if let (Some(server), Some(tool)) = (
            raw.get("server")
                .or_else(|| raw.get("serverName"))
                .or_else(|| raw.get("server_name"))
                .and_then(Value::as_str),
            raw.get("tool")
                .or_else(|| raw.get("toolName"))
                .or_else(|| raw.get("tool_name"))
                .and_then(Value::as_str),
        ) {
            let server = server.trim();
            let tool = tool.trim();
            if !server.is_empty() && !tool.is_empty() {
                push(&mut out, Some(&format!("{server}__{tool}")));
                push(&mut out, Some(&format!("mcp__{server}__{tool}")));
            }
        }
    }

    out
}

/// Build the ACP success response for a human-selected permission option.
pub fn permission_selected_response(id: AcpRequestId, option_id: &str) -> Value {
    json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": id,
        "result": {
            "outcome": {
                "outcome": "selected",
                "optionId": option_id,
            },
        },
    })
}

/// Build the ACP success response for a cancelled or expired confirmation.
pub fn permission_cancelled_response(id: AcpRequestId) -> Value {
    json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": id,
        "result": { "outcome": { "outcome": "cancelled" } },
    })
}

fn parse_permission_option(value: &Value) -> Result<AcpPermissionOption, AcpProtocolError> {
    let option = value
        .as_object()
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "option is not an object",
        ))?;
    let option_id = permission_identifier(option.get("optionId"), "optionId")?;
    let name = option
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| truncate_display_text(name, 160))
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "option name is missing",
        ))?;
    let kind = match option.get("kind").and_then(Value::as_str) {
        Some("allow_once") => AcpPermissionOptionKind::AllowOnce,
        Some("allow_always") => AcpPermissionOptionKind::AllowAlways,
        Some("reject_once") => AcpPermissionOptionKind::RejectOnce,
        Some("reject_always") => AcpPermissionOptionKind::RejectAlways,
        _ => {
            return Err(AcpProtocolError::InvalidPermissionRequest(
                "option kind is unsupported",
            ));
        }
    };
    Ok(AcpPermissionOption {
        option_id,
        name,
        kind,
    })
}

fn permission_identifier(
    value: Option<&Value>,
    field: &'static str,
) -> Result<String, AcpProtocolError> {
    let value = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.chars().count() <= 256)
        .ok_or(AcpProtocolError::InvalidPermissionRequest(field))?;
    Ok(value.to_string())
}

/// Build the restricted initialize request used for every ACP profile.
///
/// Taomni deliberately advertises neither general filesystem access nor a
/// terminal endpoint. Agents can only perform Taomni side effects through the
/// separately provisioned MCP surface.
pub fn initialize_request(
    id: impl Into<AcpRequestId>,
    client_name: impl Into<String>,
    client_version: impl Into<String>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_INITIALIZE,
        json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": false,
                    "writeTextFile": false,
                },
                "terminal": false,
            },
            "clientInfo": {
                "name": client_name.into(),
                "version": client_version.into(),
            },
        }),
    )
}

/// Build an authentication request for an advertised ACP auth method. The
/// method's credential handling remains inside the local CLI; this request
/// never transports an xAI API key or other secret from Taomni.
pub fn authenticate_request(
    id: impl Into<AcpRequestId>,
    method_id: impl Into<String>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_AUTHENTICATE,
        json!({ "methodId": method_id.into() }),
    )
}

/// Build a new ACP session request. `mcp_servers` must already have been
/// capability-checked and contain no secrets outside local loopback URLs.
pub fn new_session_request(
    id: impl Into<AcpRequestId>,
    cwd: impl Into<String>,
    mcp_servers: Vec<Value>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_SESSION_NEW,
        json!({
            "cwd": cwd.into(),
            "mcpServers": mcp_servers,
        }),
    )
}

/// Build a session resume request. ACP v1 requires the current cwd and MCP
/// server set again when loading a persisted session.
pub fn load_session_request(
    id: impl Into<AcpRequestId>,
    session_id: impl Into<String>,
    cwd: impl Into<String>,
    mcp_servers: Vec<Value>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_SESSION_LOAD,
        json!({
            "sessionId": session_id.into(),
            "cwd": cwd.into(),
            "mcpServers": mcp_servers,
        }),
    )
}

/// A local resource exposed to an ACP agent with a standard `resource_link`
/// prompt block. Unlike an inline `image` block, resource links do not require
/// the optional image prompt capability. They let a local agent opt into
/// opening an attachment from its own filesystem when that agent supports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpResourceLink {
    pub uri: String,
    pub name: String,
    pub mime_type: Option<String>,
}

impl AcpResourceLink {
    pub fn new(uri: impl Into<String>, name: impl Into<String>, mime_type: Option<String>) -> Self {
        Self {
            uri: uri.into(),
            name: name.into(),
            mime_type,
        }
    }

    fn as_prompt_block(&self) -> Value {
        let mut block = serde_json::Map::new();
        block.insert("type".into(), Value::String("resource_link".into()));
        block.insert("uri".into(), Value::String(self.uri.clone()));
        block.insert("name".into(), Value::String(self.name.clone()));
        if let Some(mime_type) = self
            .mime_type
            .as_deref()
            .map(str::trim)
            .filter(|mime_type| !mime_type.is_empty())
        {
            block.insert("mimeType".into(), Value::String(mime_type.into()));
        }
        Value::Object(block)
    }
}

/// Build a baseline text prompt turn. Text works for every compliant profile
/// without advertising unsupported image, audio, filesystem, or terminal
/// capabilities.
pub fn prompt_request(
    id: impl Into<AcpRequestId>,
    session_id: impl Into<String>,
    text: impl Into<String>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_SESSION_PROMPT,
        json!({
            "sessionId": session_id.into(),
            "prompt": [{ "type": "text", "text": text.into() }],
        }),
    )
}

/// Build a prompt turn with local ACP resource links. This intentionally does
/// not use an inline `image` content block: callers must honor an agent's
/// negotiated `promptCapabilities.image` before using that optional feature.
pub fn prompt_with_resource_links_request(
    id: impl Into<AcpRequestId>,
    session_id: impl Into<String>,
    text: impl Into<String>,
    resource_links: &[AcpResourceLink],
) -> AcpRequest {
    let mut prompt = vec![json!({ "type": "text", "text": text.into() })];
    prompt.extend(resource_links.iter().map(AcpResourceLink::as_prompt_block));
    AcpRequest::new(
        id,
        METHOD_SESSION_PROMPT,
        json!({
            "sessionId": session_id.into(),
            "prompt": prompt,
        }),
    )
}

/// Build the fire-and-forget ACP cancellation notification. Notifications never
/// receive a JSON-RPC response; the active prompt completes later with a
/// `cancelled` stop reason.
pub fn cancel_notification(session_id: impl Into<String>) -> AcpNotification {
    AcpNotification::new(
        METHOD_SESSION_CANCEL,
        json!({ "sessionId": session_id.into() }),
    )
}

/// A safe summary of the agent's negotiated ACP features. We intentionally do
/// not retain arbitrary capability metadata or agent-provided configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentInfo {
    pub protocol_version: u64,
    pub name: Option<String>,
    pub title: Option<String>,
    pub version: Option<String>,
    pub supports_session_load: bool,
    pub supports_prompt_images: bool,
    pub supports_mcp_http: bool,
    pub supports_mcp_sse: bool,
    pub auth_methods: Vec<AcpAuthMethod>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethod {
    pub id: String,
    pub name: String,
}

/// Extract the stable, UI-safe fields from an initialize response.
pub fn parse_initialize_result(result: &Value) -> Result<AcpAgentInfo, AcpProtocolError> {
    let object = result
        .as_object()
        .ok_or(AcpProtocolError::InvalidInitializeResponse(
            "result is not an object",
        ))?;
    let protocol_version = object
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or(AcpProtocolError::InvalidInitializeResponse(
            "protocolVersion is missing",
        ))?;

    let agent_info = object.get("agentInfo").and_then(Value::as_object);
    let capabilities = object.get("agentCapabilities").and_then(Value::as_object);
    let prompt_capabilities = capabilities
        .and_then(|caps| caps.get("promptCapabilities"))
        .and_then(Value::as_object);
    let mcp_capabilities = capabilities
        .and_then(|caps| caps.get("mcpCapabilities"))
        .and_then(Value::as_object);
    let auth_methods = object
        .get("authMethods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| {
                    let method = method.as_object()?;
                    let id = method.get("id")?.as_str()?.trim();
                    let name = method.get("name")?.as_str()?.trim();
                    if id.is_empty() || name.is_empty() {
                        return None;
                    }
                    Some(AcpAuthMethod {
                        id: truncate_display_text(id, 120),
                        name: truncate_display_text(name, 160),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(AcpAgentInfo {
        protocol_version,
        name: agent_info
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .map(|name| truncate_display_text(name, 160)),
        title: agent_info
            .and_then(|info| info.get("title"))
            .and_then(Value::as_str)
            .map(|title| truncate_display_text(title, 160)),
        version: agent_info
            .and_then(|info| info.get("version"))
            .and_then(Value::as_str)
            .map(|version| truncate_display_text(version, 120)),
        supports_session_load: capabilities
            .and_then(|caps| caps.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_prompt_images: prompt_capabilities
            .and_then(|caps| caps.get("image"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_mcp_http: mcp_capabilities
            .and_then(|caps| caps.get("http"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_mcp_sse: mcp_capabilities
            .and_then(|caps| caps.get("sse"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        auth_methods,
    })
}

/// Return a newly-created ACP session id while preventing an empty or raw
/// provider result from being persisted.
pub fn session_id_from_response(result: &Value) -> Result<String, AcpProtocolError> {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
        .ok_or(AcpProtocolError::MissingSessionId)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpStopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResult {
    pub stop_reason: AcpStopReason,
    pub usage: Option<LocalAgentUsage>,
}

pub fn parse_prompt_result(result: &Value) -> Result<AcpPromptResult, AcpProtocolError> {
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .ok_or(AcpProtocolError::MissingPromptStopReason)?;
    let stop_reason = match stop_reason {
        "end_turn" => AcpStopReason::EndTurn,
        "max_tokens" => AcpStopReason::MaxTokens,
        "max_turn_requests" => AcpStopReason::MaxTurnRequests,
        "refusal" => AcpStopReason::Refusal,
        "cancelled" => AcpStopReason::Cancelled,
        other => AcpStopReason::Other(truncate_display_text(other, 80)),
    };
    Ok(AcpPromptResult {
        stop_reason,
        usage: parse_prompt_usage(result),
    })
}

/// Extract only known numeric usage fields from agent-specific prompt
/// metadata. Grok currently reports final turn accounting under `_meta.usage`;
/// every other private metadata field remains intentionally unobserved.
fn parse_prompt_usage(result: &Value) -> Option<LocalAgentUsage> {
    let meta = result.get("_meta")?.as_object()?;
    let usage = meta.get("usage").and_then(Value::as_object).unwrap_or(meta);
    let input_tokens = first_u64(usage, &["inputTokens", "input_tokens"]);
    let output_tokens = first_u64(usage, &["outputTokens", "output_tokens"]);
    let total_tokens = first_u64(usage, &["totalTokens", "total_tokens"]);
    let total_cost_usd = first_f64(usage, &["totalCostUsd", "total_cost_usd", "costUsd"]);
    let duration_ms = first_u64(usage, &["durationMs", "duration_ms"]);
    let num_turns = first_u64(usage, &["numTurns", "num_turns"]);

    if [
        input_tokens,
        output_tokens,
        total_tokens,
        duration_ms,
        num_turns,
    ]
    .iter()
    .all(Option::is_none)
        && total_cost_usd.is_none()
    {
        return None;
    }

    Some(LocalAgentUsage {
        input_tokens,
        output_tokens,
        total_tokens,
        total_cost_usd,
        duration_ms,
        num_turns,
    })
}

fn first_u64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_u64))
}

fn first_f64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_f64))
}

/// A session-scoped ACP update. The event is intentionally optional because
/// protocol updates such as plans, modes, and unknown extensions are consumed
/// safely but are not yet surfaced in Taomni's chat UI.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpSessionUpdate {
    pub session_id: String,
    pub is_replay: bool,
    pub event: Option<LocalAgentEvent>,
    pub usage: Option<AcpUsageUpdate>,
    /// A local file emitted by a completed agent tool. Only the path is
    /// retained; raw tool input/output and provider metadata stay private.
    /// Consumers must validate and copy this file before exposing it.
    pub generated_media: Option<AcpGeneratedMedia>,
}

/// A candidate local media artifact emitted by an ACP agent tool update.
/// This is deliberately minimal: the raw tool output is never retained or
/// surfaced to chat, and the artifact kind is determined from the copied file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpGeneratedMedia {
    pub path: String,
}

/// Context-window usage carries different semantics from input/output token
/// accounting, so it remains a separate value rather than being forced into
/// `LocalAgentUsage`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpUsageUpdate {
    pub used_tokens: u64,
    pub total_tokens: u64,
    pub cost_amount: Option<f64>,
    pub cost_currency: Option<String>,
}

/// Parse an ACP `session/update` params object into the limited UI-safe event
/// vocabulary. Raw tool input, tool output, provider metadata, and thoughts are
/// deliberately never forwarded into the shared local-agent model.
pub fn parse_session_update(params: &Value) -> Option<AcpSessionUpdate> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_string();
    let update = params.get("update").unwrap_or(params);
    let update_type = update.get("sessionUpdate").and_then(Value::as_str)?;
    let is_replay = params
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("isReplay"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let generated_media = if is_replay {
        None
    } else {
        parse_generated_media(update, update_type)
    };

    let event = if is_replay {
        None
    } else {
        match update_type {
            "agent_message_chunk" | "agent_text" | "agent-text" => update
                .get("content")
                .and_then(Value::as_object)
                .filter(|content| {
                    content
                        .get("type")
                        .and_then(Value::as_str)
                        .is_none_or(|kind| kind == "text")
                })
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|content| LocalAgentEvent::AssistantDelta {
                    content: content.to_string(),
                }),
            "tool_call" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .unwrap_or("Tool");
                id.map(|id| LocalAgentEvent::ToolStarted {
                    id: id.to_string(),
                    name: truncate_display_text(title, 240),
                    // Display-safe subset only — never forward arbitrary rawInput.
                    input: tool_call_display_input(update),
                })
            }
            "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "completed" | "failed"));
                id.zip(status)
                    .map(|(id, status)| LocalAgentEvent::ToolCompleted {
                        id: id.to_string(),
                        output: tool_call_display_output(update, status),
                    })
            }
            _ => None,
        }
    };

    let usage = if !is_replay && update_type == "usage_update" {
        let used_tokens = update.get("used").and_then(Value::as_u64)?;
        let total_tokens = update.get("size").and_then(Value::as_u64)?;
        let cost = update.get("cost").and_then(Value::as_object);
        Some(AcpUsageUpdate {
            used_tokens,
            total_tokens,
            cost_amount: cost
                .and_then(|cost| cost.get("amount"))
                .and_then(Value::as_f64),
            cost_currency: cost
                .and_then(|cost| cost.get("currency"))
                .and_then(Value::as_str)
                .map(|currency| truncate_display_text(currency, 16)),
        })
    } else {
        None
    };

    Some(AcpSessionUpdate {
        session_id,
        is_replay,
        event,
        usage,
        generated_media,
    })
}

/// Keys whose string values are useful and safe to show in the tool-activity
/// transcript. Secrets / credentials are never allowlisted here.
const TOOL_DISPLAY_INPUT_KEYS: &[&str] = &[
    "command",
    "cmd",
    "query",
    "pattern",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "notebook_path",
    "url",
    "uri",
    "prompt",
    "description",
    "glob",
    "directory",
    "cwd",
    "working_directory",
    "name",
    "tool",
    "tool_name",
    "toolName",
    "server",
    "server_name",
    "message",
    "text",
    "search",
    "replace",
    "old_string",
    "new_string",
    "content",
    "offset",
    "limit",
    "language",
];

fn tool_display_key_looks_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("credential")
        || lower.contains("cookie")
        || lower.contains("private_key")
        || lower == "key"
        || lower.ends_with("_key")
}

/// Build a display-safe JSON object summarizing a tool_call for the chat UI.
///
/// Pulls only allowlisted scalar fields from `rawInput` / nested wrappers, plus
/// file paths from `locations`. Arbitrary values (and anything that looks like
/// a secret key) are dropped so credentials never enter the transcript.
fn tool_call_display_input(update: &Value) -> Value {
    let mut out = serde_json::Map::new();

    if let Some(kind) = update
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        out.insert(
            "kind".into(),
            Value::String(truncate_display_text(kind, 80)),
        );
    }

    // Prefer explicit file locations the agent already intends the client to follow.
    if let Some(locations) = update.get("locations").and_then(Value::as_array) {
        let paths: Vec<Value> = locations
            .iter()
            .filter_map(|loc| {
                loc.get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(|p| Value::String(truncate_display_text(p, 240)))
            })
            .take(4)
            .collect();
        if !paths.is_empty() {
            // Single path is the common case — surface as `path` for the
            // existing summary helper; multiple become a short list.
            if paths.len() == 1 {
                out.insert("path".into(), paths[0].clone());
            } else {
                out.insert("path".into(), Value::Array(paths));
            }
        }
    }

    // Text content blocks (e.g. a short description of what the tool will do).
    if let Some(text) = first_tool_content_text(update.get("content")) {
        out.entry("description".to_string())
            .or_insert_with(|| Value::String(text));
    }

    if let Some(raw) = update
        .get("rawInput")
        .or_else(|| update.get("raw_input"))
        .and_then(Value::as_object)
    {
        merge_allowlisted_tool_fields(&mut out, raw);
        // Nested MCP / dispatcher wrappers.
        for nest in ["arguments", "input", "params"] {
            if let Some(nested) = raw.get(nest).and_then(Value::as_object) {
                merge_allowlisted_tool_fields(&mut out, nested);
            }
        }
    }

    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}

fn merge_allowlisted_tool_fields(
    out: &mut serde_json::Map<String, Value>,
    raw: &serde_json::Map<String, Value>,
) {
    for key in TOOL_DISPLAY_INPUT_KEYS {
        if tool_display_key_looks_secret(key) {
            continue;
        }
        if out.contains_key(*key) {
            continue;
        }
        let Some(value) = raw.get(*key) else {
            continue;
        };
        match value {
            Value::String(s) => {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    out.insert(
                        (*key).to_string(),
                        Value::String(truncate_display_text(trimmed, 200)),
                    );
                }
            }
            Value::Number(n) => {
                out.insert((*key).to_string(), Value::Number(n.clone()));
            }
            Value::Bool(b) => {
                out.insert((*key).to_string(), Value::Bool(*b));
            }
            _ => {}
        }
    }
}

/// Prefer human-readable content blocks over a bare status string for tool results.
fn tool_call_display_output(update: &Value, status: &str) -> String {
    if let Some(text) = first_tool_content_text(update.get("content")) {
        return text;
    }

    // Safe scalar previews from rawOutput (never dump the whole object).
    if let Some(raw) = update
        .get("rawOutput")
        .or_else(|| update.get("raw_output"))
        .and_then(Value::as_object)
    {
        for key in [
            "message", "summary", "text", "output", "result", "stdout", "path", "error",
        ] {
            if let Some(s) = raw
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return truncate_display_text(s, 240);
            }
        }
    }

    // Locations updated by the tool (e.g. written files).
    if let Some(locations) = update.get("locations").and_then(Value::as_array) {
        let paths: Vec<&str> = locations
            .iter()
            .filter_map(|loc| {
                loc.get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
            })
            .take(3)
            .collect();
        if !paths.is_empty() {
            return truncate_display_text(&paths.join(", "), 240);
        }
    }

    status.to_string()
}

/// First non-empty text content block from a tool_call content array.
fn first_tool_content_text(content: Option<&Value>) -> Option<String> {
    let items = content.and_then(Value::as_array)?;
    for item in items {
        let obj = item.as_object()?;
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("content");
        // Skip diffs (can be huge) and media; keep plain text / content.
        if matches!(
            kind,
            "diff" | "terminal" | "image" | "audio" | "resource_link"
        ) {
            continue;
        }
        if let Some(text) = obj
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return Some(truncate_display_text(text, 240));
        }
        // content: { type: "content", content: { type: "text", text: "..." } }
        if let Some(nested) = obj
            .get("content")
            .and_then(Value::as_object)
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return Some(truncate_display_text(nested, 240));
        }
    }
    None
}

/// Extract a completed tool's local output path without preserving arbitrary
/// tool output. Grok's image and video tools place their saved artifact at
/// `rawOutput.path`; treating the path only as a candidate keeps this generic
/// and lets the chat media adapter validate MIME type, size, and regular-file
/// status before copying it into Taomni storage.
fn parse_generated_media(update: &Value, update_type: &str) -> Option<AcpGeneratedMedia> {
    if update_type != "tool_call_update"
        || update.get("status").and_then(Value::as_str) != Some("completed")
    {
        return None;
    }
    let path = update
        .get("rawOutput")
        .or_else(|| update.get("raw_output"))
        .and_then(Value::as_object)
        .and_then(|output| output.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty() && path.len() <= 32 * 1024)?;
    Some(AcpGeneratedMedia {
        path: path.to_string(),
    })
}

pub(super) fn truncate_display_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders_follow_acp_v1_and_advertise_restricted_capabilities() {
        let initialize = initialize_request(1, "taomni", "0.3.0");
        assert_eq!(initialize.method, METHOD_INITIALIZE);
        assert_eq!(
            serde_json::to_value(initialize).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                    },
                    "clientInfo": { "name": "taomni", "version": "0.3.0" },
                },
            }),
        );

        assert_eq!(
            serde_json::to_value(new_session_request(2, "/workspace", vec![])).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": { "cwd": "/workspace", "mcpServers": [] },
            }),
        );
        assert_eq!(
            serde_json::to_value(prompt_request(3, "session-1", "hello")).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {
                    "sessionId": "session-1",
                    "prompt": [{ "type": "text", "text": "hello" }],
                },
            }),
        );
        assert_eq!(
            serde_json::to_value(prompt_with_resource_links_request(
                4,
                "session-1",
                "Describe the attachment.",
                &[AcpResourceLink::new(
                    "file:///workspace/reference%20image.png",
                    "reference image.png",
                    Some("image/png".into()),
                )],
            ))
            .unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "session/prompt",
                "params": {
                    "sessionId": "session-1",
                    "prompt": [
                        { "type": "text", "text": "Describe the attachment." },
                        {
                            "type": "resource_link",
                            "uri": "file:///workspace/reference%20image.png",
                            "name": "reference image.png",
                            "mimeType": "image/png",
                        },
                    ],
                },
            }),
        );
        assert_eq!(
            serde_json::to_value(cancel_notification("session-1")).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": "session-1" },
            }),
        );
    }

    #[test]
    fn parses_json_rpc_response_error_notification_and_peer_request() {
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"2.0","id":7,"result":{"sessionId":"s1"}}"#).unwrap(),
            AcpIncomingMessage::Response {
                id: AcpRequestId::Number(7),
                result: json!({ "sessionId": "s1" }),
            },
        );
        assert_eq!(
            parse_incoming_line(
                r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32001,"message":"not authenticated","data":{"secret":"discarded"}}}"#,
            )
            .unwrap(),
            AcpIncomingMessage::ErrorResponse {
                id: Some(AcpRequestId::Number(7)),
                error: AcpRpcError {
                    code: -32001,
                    message: "not authenticated".into(),
                },
            },
        );
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#)
                .unwrap(),
            AcpIncomingMessage::Notification {
                method: "session/update".into(),
                params: json!({}),
            },
        );
        assert_eq!(
            parse_incoming_line(
                r#"{"jsonrpc":"2.0","id":"fs-1","method":"fs/read_text_file","params":{}}"#
            )
            .unwrap(),
            AcpIncomingMessage::Request {
                id: AcpRequestId::String("fs-1".into()),
                method: "fs/read_text_file".into(),
                params: json!({}),
            },
        );
    }

    #[test]
    fn parses_safe_permission_requests_and_builds_standard_outcomes() {
        let request = parse_permission_request(&json!({
            "sessionId": "session-1",
            "toolCall": {
                "toolCallId": "tool-1",
                "title": "Edit README.md",
                "kind": "edit",
                "rawInput": { "api_key": "must-not-retain" },
            },
            "options": [
                {
                    "optionId": "allow-once",
                    "name": "Allow once",
                    "kind": "allow_once",
                },
                {
                    "optionId": "reject-once",
                    "name": "Deny",
                    "kind": "reject_once",
                },
            ],
        }))
        .unwrap();
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.tool_call_id, "tool-1");
        assert_eq!(request.title, "Edit README.md");
        assert!(!request.deferred_to_mcp);
        assert_eq!(request.options[0].kind, AcpPermissionOptionKind::AllowOnce);
        assert!(!format!("{request:?}").contains("must-not-retain"));
        assert_eq!(
            permission_selected_response(AcpRequestId::String("permission-1".into()), "allow-once"),
            json!({
                "jsonrpc": "2.0",
                "id": "permission-1",
                "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } },
            }),
        );
        assert_eq!(
            permission_cancelled_response(AcpRequestId::Number(2)),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": { "outcome": { "outcome": "cancelled" } },
            }),
        );
    }

    #[test]
    fn defers_taomni_mcp_permission_requests_without_retaining_raw_input() {
        let request = parse_permission_request(&json!({
            "sessionId": "session-1",
            "toolCall": {
                "toolCallId": "tool-mcp-1",
                "title": "taomni__run_in_terminal",
                "kind": "execute",
                "rawInput": {
                    "command": "rm -rf /",
                    "session_id": "tab-1",
                    "api_key": "must-not-retain",
                },
            },
            "options": [
                {
                    "optionId": "allow-once",
                    "name": "Allow once",
                    "kind": "allow_once",
                },
            ],
        }))
        .unwrap();
        assert!(request.deferred_to_mcp);
        assert!(!format!("{request:?}").contains("must-not-retain"));
        assert!(!format!("{request:?}").contains("rm -rf"));

        let nested = parse_permission_request(&json!({
            "sessionId": "session-1",
            "toolCall": {
                "toolCallId": "tool-mcp-2",
                "title": "use_tool",
                "kind": "execute",
                "rawInput": {
                    "server": "taomni_control",
                    "tool": "session_open",
                },
            },
            "options": [
                {
                    "optionId": "allow-once",
                    "name": "Allow once",
                    "kind": "allow_once",
                },
            ],
        }))
        .unwrap();
        assert!(nested.deferred_to_mcp);

        assert!(is_taomni_mcp_tool_name("mcp__taomni_sql__run_sql"));
        assert!(is_taomni_mcp_tool_name("run_in_terminal"));
        assert!(!is_taomni_mcp_tool_name("run_terminal_command"));
        assert!(!is_taomni_mcp_tool_name("search_replace"));
    }

    #[test]
    fn rejects_ambiguous_permission_options() {
        let error = parse_permission_request(&json!({
            "sessionId": "session-1",
            "toolCall": { "toolCallId": "tool-1" },
            "options": [{
                "optionId": "maybe",
                "name": "Maybe",
                "kind": "ask_later",
            }],
        }))
        .unwrap_err();
        assert_eq!(
            error,
            AcpProtocolError::InvalidPermissionRequest("option kind is unsupported")
        );
    }

    #[test]
    fn rejects_malformed_or_ambiguous_json_rpc_messages() {
        assert_eq!(
            parse_incoming_line("not-json"),
            Err(AcpProtocolError::InvalidJson)
        );
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"1.0","id":1,"result":{}}"#),
            Err(AcpProtocolError::InvalidJsonRpcVersion),
        );
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"2.0","id":1,"result":{},"error":{}}"#),
            Err(AcpProtocolError::InvalidEnvelope(
                "response must contain exactly one of result or error"
            )),
        );
    }

    #[test]
    fn extracts_safe_initialize_session_and_prompt_metadata() {
        let initialize = parse_initialize_result(&json!({
            "protocolVersion": 1,
            "agentInfo": { "name": "grok", "title": "Grok", "version": "0.2.101" },
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": false },
                "mcpCapabilities": { "http": true, "sse": false },
            },
            "authMethods": [
                { "id": "cached_token", "name": "Cached token" },
                { "id": "xai.api_key", "name": "API key", "credentials": "discarded" },
            ],
        }))
        .unwrap();
        assert_eq!(
            initialize,
            AcpAgentInfo {
                protocol_version: 1,
                name: Some("grok".into()),
                title: Some("Grok".into()),
                version: Some("0.2.101".into()),
                supports_session_load: true,
                supports_prompt_images: false,
                supports_mcp_http: true,
                supports_mcp_sse: false,
                auth_methods: vec![
                    AcpAuthMethod {
                        id: "cached_token".into(),
                        name: "Cached token".into(),
                    },
                    AcpAuthMethod {
                        id: "xai.api_key".into(),
                        name: "API key".into(),
                    },
                ],
            },
        );
        assert_eq!(
            session_id_from_response(&json!({ "sessionId": "s1" })).unwrap(),
            "s1",
        );
        assert_eq!(
            parse_prompt_result(&json!({
                "stopReason": "cancelled",
                "_meta": {
                    "usage": {
                        "inputTokens": 12,
                        "outputTokens": 7,
                        "totalTokens": 19,
                        "numTurns": 2,
                        "privateConfig": "discarded",
                    },
                },
            }))
            .unwrap(),
            AcpPromptResult {
                stop_reason: AcpStopReason::Cancelled,
                usage: Some(LocalAgentUsage {
                    input_tokens: Some(12),
                    output_tokens: Some(7),
                    total_tokens: Some(19),
                    total_cost_usd: None,
                    duration_ms: None,
                    num_turns: Some(2),
                }),
            },
        );
    }

    #[test]
    fn maps_safe_session_updates_without_forwarding_raw_tool_data_or_thoughts() {
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "Hello" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::AssistantDelta {
                    content: "Hello".into(),
                }),
                usage: None,
                generated_media: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "title": "Read config",
                    "rawInput": { "token": "must not escape" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::ToolStarted {
                    id: "tool-1".into(),
                    name: "Read config".into(),
                    // Secrets stay out of the display payload.
                    input: Value::Null,
                }),
                usage: None,
                generated_media: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-2",
                    "title": "search_tool",
                    "kind": "search",
                    "rawInput": {
                        "query": "recent folders win11",
                        "token": "must not escape",
                    },
                    "locations": [{ "path": "/tmp/a.rs" }],
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::ToolStarted {
                    id: "tool-2".into(),
                    name: "search_tool".into(),
                    input: json!({
                        "kind": "search",
                        "path": "/tmp/a.rs",
                        "query": "recent folders win11",
                    }),
                }),
                usage: None,
                generated_media: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-1",
                    "status": "completed",
                    "rawOutput": { "token": "must not escape" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::ToolCompleted {
                    id: "tool-1".into(),
                    output: "completed".into(),
                }),
                usage: None,
                generated_media: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-2",
                    "status": "completed",
                    "content": [{
                        "type": "content",
                        "content": { "type": "text", "text": "Found 3 matches in src/" },
                    }],
                    "rawOutput": { "token": "must not escape" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::ToolCompleted {
                    id: "tool-2".into(),
                    output: "Found 3 matches in src/".into(),
                }),
                usage: None,
                generated_media: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "hidden reasoning" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: None,
                usage: None,
                generated_media: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "old answer" },
                },
                "_meta": { "isReplay": true },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: true,
                event: None,
                usage: None,
                generated_media: None,
            }),
        );
    }

    #[test]
    fn preserves_usage_as_context_window_metadata() {
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "usage_update",
                    "used": 240,
                    "size": 8192,
                    "cost": { "amount": 0.12, "currency": "USD" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: None,
                usage: Some(AcpUsageUpdate {
                    used_tokens: 240,
                    total_tokens: 8192,
                    cost_amount: Some(0.12),
                    cost_currency: Some("USD".into()),
                }),
                generated_media: None,
            }),
        );
    }

    #[test]
    fn extracts_only_completed_tool_output_paths_as_media_candidates() {
        let update = parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "image-1",
                "status": "completed",
                "rawOutput": {
                    "type": "ImageGen",
                    "path": "/tmp/grok/images/1.jpg",
                    "private": "not retained",
                },
            },
        }))
        .expect("valid update");
        assert_eq!(
            update.generated_media,
            Some(AcpGeneratedMedia {
                path: "/tmp/grok/images/1.jpg".into(),
            }),
        );

        let failed = parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "status": "failed",
                "rawOutput": { "path": "/tmp/grok/images/failed.jpg" },
            },
        }))
        .expect("valid update");
        assert_eq!(failed.generated_media, None);
    }
}
