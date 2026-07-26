//! Language-agnostic Debug Adapter Protocol kernel (M8 D1).
//!
//! DAP frames messages exactly like LSP — `Content-Length: N\r\n\r\n` followed by
//! N bytes of JSON — so the codec here mirrors the LSP one. Everything in this
//! module is DAP-standard: sessions hold threads / stackFrames / scopes /
//! variables / breakpoints as raw JSON with no language-specific fields. A
//! `DebugAdapterRegistry` (empty until the Java adapter, D2) decides how to reach
//! an adapter for a given launch config; the kernel then runs the same request /
//! response / event pump regardless of language.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use tokio::sync::{Mutex, oneshot};

/// Encode a DAP message (JSON body) with the `Content-Length` header framing.
pub fn encode_message(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_default();
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend_from_slice(&body);
    framed
}

/// Incremental decoder for a DAP byte stream. Feed bytes with [`Self::push`], then
/// drain complete messages with [`Self::next_message`] — handles partial reads and
/// multiple messages coalesced in one chunk (same framing as LSP).
#[derive(Default)]
pub struct DapDecoder {
    buffer: Vec<u8>,
}

impl DapDecoder {
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Pop the next fully-received message, or `None` if more bytes are needed.
    /// Skips a frame whose body is not valid JSON (returns the next good one).
    pub fn next_message(&mut self) -> Option<Value> {
        loop {
            let header_end = find_subsequence(&self.buffer, b"\r\n\r\n")?;
            let header = &self.buffer[..header_end];
            let content_length = parse_content_length(header);
            let Some(len) = content_length else {
                // Malformed header (no Content-Length): drop it and resync.
                self.buffer.drain(..header_end + 4);
                continue;
            };
            let body_start = header_end + 4;
            if self.buffer.len() < body_start + len {
                return None; // Body not fully arrived yet.
            }
            let body: Vec<u8> = self.buffer[body_start..body_start + len].to_vec();
            self.buffer.drain(..body_start + len);
            match serde_json::from_slice::<Value>(&body) {
                Ok(value) => return Some(value),
                Err(_) => continue, // Skip the bad frame, try the next.
            }
        }
    }
}
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Parse the `Content-Length` value from a raw header block (case-insensitive key).
fn parse_content_length(header: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(header).ok()?;
    for line in text.split("\r\n") {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("Content-Length") {
                return value.trim().parse::<usize>().ok();
            }
        }
    }
    None
}

/// Classification of an inbound DAP message from the adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundMessage {
    /// A response to a request we sent (carries `request_seq`).
    Response { request_seq: i64 },
    /// An adapter-initiated event (`stopped`, `output`, `terminated`, …).
    Event { event: String },
    /// A reverse request from the adapter (`runInTerminal`, `startDebugging`).
    ReverseRequest { command: String, seq: i64 },
    /// Anything that does not match a known DAP `type`.
    Unknown,
}

/// Classify an inbound message by its DAP `type` field (pure — unit-tested).
pub fn classify_message(message: &Value) -> InboundMessage {
    match message.get("type").and_then(Value::as_str) {
        Some("response") => InboundMessage::Response {
            request_seq: message.get("request_seq").and_then(Value::as_i64).unwrap_or(-1),
        },
        Some("event") => InboundMessage::Event {
            event: message
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        Some("request") => InboundMessage::ReverseRequest {
            command: message
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            seq: message.get("seq").and_then(Value::as_i64).unwrap_or(-1),
        },
        _ => InboundMessage::Unknown,
    }
}

/// Extract the most useful error text from a failed DAP response. The spec's
/// `ErrorResponse` carries a structured `body.error` message with a `format`
/// template and `{key}` placeholders resolved from `variables`; the flat
/// top-level `message` is often just a terse summary (java-debug puts the real
/// reason — "Failed to launch debuggee VM. Reason: …" — in `body.error`).
pub fn extract_error_message(message: &Value) -> String {
    if let Some(error) = message.pointer("/body/error") {
        if let Some(format) = error.get("format").and_then(Value::as_str) {
            let mut text = format.to_string();
            if let Some(variables) = error.get("variables").and_then(Value::as_object) {
                for (key, value) in variables {
                    if let Some(value) = value.as_str() {
                        text = text.replace(&format!("{{{key}}}"), value);
                    }
                }
            }
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    message
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("debug adapter request failed")
        .to_string()
}

/// How the kernel reaches a debug adapter. `Stdio` spawns a process and speaks DAP
/// over its stdin/stdout; `Tcp` connects to an already-listening adapter (java-debug
/// hands back a port via jdtls, so the Java adapter, D2, will use `Tcp`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DapTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Tcp {
        #[serde(default = "default_host")]
        host: String,
        port: u16,
    },
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}
/// The kernel's plan for reaching + launching a debuggee, produced by an adapter
/// from a launch config. `transport` says how to connect; `request` +
/// `arguments` are the resolved `launch`/`attach` payload the client sends after
/// `initialize` (the Java adapter fills these from jdtls — D2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapLaunchPlan {
    pub transport: DapTransport,
    /// `"launch"` or `"attach"`.
    pub request: String,
    /// Resolved launch/attach arguments (adapter-specific, opaque to the kernel).
    pub arguments: Value,
}

/// A registered debug adapter: how to reach + launch a debuggee for a given
/// config. Java (D2) is the first implementation; others (Node/Go/LLDB) plug in
/// the same way. `resolve` is async because language adapters may need to talk to
/// their language server first (jdtls hands java-debug a port).
#[async_trait::async_trait]
pub trait DebugAdapter: Send + Sync {
    /// Stable adapter id (e.g. `"java"`), matched against `dap_start_session`.
    fn id(&self) -> &str;

    /// Resolve transport + launch/attach payload from a launch config.
    async fn resolve(&self, launch_config: &Value) -> Result<DapLaunchPlan, String>;
}

/// Registry of debug adapters, keyed by id — analogous to `lsp_presets`. Empty in
/// D1; the Java adapter is inserted in D2.
#[derive(Default)]
pub struct DebugAdapterRegistry {
    adapters: HashMap<String, Arc<dyn DebugAdapter>>,
}

impl DebugAdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, adapter: Arc<dyn DebugAdapter>) {
        self.adapters.insert(adapter.id().to_string(), adapter);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn DebugAdapter>> {
        self.adapters.get(id).cloned()
    }
}

type PendingResponses = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// How long `initialize` may take before the session is reported as unreachable.
const INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Grace period for a graceful `terminate` before falling back to `disconnect`.
const TERMINATE_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// A live debug session. Holds the write half + pending-response correlation +
/// child handle; **no `AppHandle`** — the reader task owns a cloned handle so this
/// struct stays out of the AppState-reachable AppHandle trap (see M7-C).
pub struct DapSession {
    /// DAP `seq` counter (starts at 1; every message we send gets the next).
    next_seq: AtomicI64,
    pending: PendingResponses,
    writer: Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    /// Spawned adapter process for `Stdio` transport (kept so drop kills it).
    child: Mutex<Option<tokio::process::Child>>,
    /// Adapter capabilities from the `initialize` response.
    capabilities: Mutex<Value>,
}

impl DapSession {
    fn next_seq(&self) -> i64 {
        self.next_seq.fetch_add(1, Ordering::SeqCst)
    }

    /// Reply to an adapter-initiated (reverse) request. Every reverse request
    /// MUST get a response or the adapter blocks waiting for one, so the reader
    /// answers ones the kernel cannot serve with a failure (see
    /// [`reverse_response`]).
    pub async fn respond(&self, response: &Value) -> Result<(), String> {
        let mut response = response.clone();
        response["seq"] = json!(self.next_seq());
        self.write_message(&response).await
    }

    /// Send a DAP request and await its response (correlated by `seq`).
    pub async fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let seq = self.next_seq();
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(seq, tx);
        self.write_message(&message).await?;
        rx.await
            .map_err(|_| "DAP session closed before response".to_string())?
    }

    /// Fire a DAP request without awaiting a response (e.g. `disconnect`).
    pub async fn notify(&self, command: &str, arguments: Value) -> Result<(), String> {
        let seq = self.next_seq();
        self.write_message(&json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        }))
        .await
    }

    async fn write_message(&self, message: &Value) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let framed = encode_message(message);
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&framed)
            .await
            .map_err(|e| format!("DAP write failed: {e}"))?;
        writer.flush().await.map_err(|e| format!("DAP flush failed: {e}"))
    }
}
/// Holds live sessions + the adapter registry. Lives in `AppState`; holds **no
/// `AppHandle`** (event emission uses a handle cloned into the reader task).
pub struct DapManager {
    sessions: Mutex<HashMap<String, Arc<DapSession>>>,
    registry: DebugAdapterRegistry,
}

impl Default for DapManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            // D1 ships an empty registry; D2 registers the Java adapter here.
            registry: DebugAdapterRegistry::new(),
        }
    }
}

impl DapManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a manager with the language adapters that need `LspManager` access
    /// registered (D2: Java, via jdtls executeCommand). Used from `AppState::new`.
    pub fn with_lsp(lsp: Arc<crate::lsp::LspManager>) -> Self {
        let mut registry = DebugAdapterRegistry::new();
        registry.register(Arc::new(crate::java_debug_adapter::JavaDebugAdapter::new(lsp)));
        Self {
            sessions: Mutex::new(HashMap::new()),
            registry,
        }
    }

    async fn insert(&self, session_id: String, session: Arc<DapSession>) {
        self.sessions.lock().await.insert(session_id, session);
    }

    async fn get(&self, session_id: &str) -> Option<Arc<DapSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    async fn remove(&self, session_id: &str) -> Option<Arc<DapSession>> {
        self.sessions.lock().await.remove(session_id)
    }
}

/// A spawned stdio adapter: the child to retain plus its stderr pipe, which
/// MUST be drained (see [`run_stderr_pump`]).
type StdioChild = (tokio::process::Child, Option<tokio::process::ChildStderr>);

/// Establish the read/write streams for a transport (spawn a process or connect
/// a socket). Returns the reader, the writer, and — for stdio — the child.
async fn connect_transport(
    transport: &DapTransport,
) -> Result<
    (
        Box<dyn tokio::io::AsyncRead + Send + Unpin>,
        Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
        Option<StdioChild>,
    ),
    String,
> {
    match transport {
        DapTransport::Stdio { command, args, cwd } => {
            let mut cmd = tokio::process::Command::new(command);
            cmd.args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            if let Some(cwd) = cwd {
                cmd.current_dir(cwd);
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("failed to start debug adapter `{command}`: {e}"))?;
            let stdout = child.stdout.take().ok_or("adapter has no stdout")?;
            let stdin = child.stdin.take().ok_or("adapter has no stdin")?;
            let stderr = child.stderr.take();
            Ok((Box::new(stdout), Box::new(stdin), Some((child, stderr))))
        }
        DapTransport::Tcp { host, port } => {
            let stream = tokio::net::TcpStream::connect((host.as_str(), *port))
                .await
                .map_err(|e| format!("failed to connect to debug adapter {host}:{port}: {e}"))?;
            let (read, write) = stream.into_split();
            Ok((Box::new(read), Box::new(write), None))
        }
    }
}
/// Build the response to an adapter-initiated (reverse) request. The DAP spec
/// requires the client to answer *every* reverse request; an adapter that gets
/// no answer blocks. The kernel implements none of them (`runInTerminal` is
/// declined in `initialize`, `startDebugging` needs a child-session model), so
/// it replies with a well-formed failure rather than leaving the adapter
/// hanging. Pure — unit-tested.
pub fn reverse_response(request: &Value) -> Value {
    let command = request.get("command").and_then(Value::as_str).unwrap_or("");
    let request_seq = request.get("seq").and_then(Value::as_i64).unwrap_or(-1);
    json!({
        "type": "response",
        "request_seq": request_seq,
        "success": false,
        "command": command,
        "message": format!("`{command}` is not supported by this debug client"),
    })
}

/// Drain a stdio adapter's stderr and surface it as DAP `output` events. Without
/// this the pipe fills (a few KB) and the adapter blocks forever mid-session —
/// java-debug uses TCP so it is unaffected, but every stdio adapter (debugpy,
/// delve, js-debug…) writes diagnostics there.
async fn run_stderr_pump(
    mut stderr: tokio::process::ChildStderr,
    session_id: String,
    emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
) {
    use tokio::io::AsyncReadExt;
    let mut chunk = [0u8; 4096];
    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let text = String::from_utf8_lossy(&chunk[..read]).to_string();
        emit(
            &format!("dap:event:{session_id}"),
            json!({
                "sessionId": session_id,
                "event": "output",
                "message": { "type": "event", "event": "output",
                    "body": { "category": "stderr", "output": text } },
            }),
        );
    }
}

/// Pump the adapter's output stream: decode frames, resolve pending responses,
/// forward events to the frontend, and answer reverse requests. `emit` is a
/// boxed closure that wraps a cloned `AppHandle` (kept out of this module's
/// types so the AppState-reachable AppHandle link that broke M7-C never forms
/// here). On EOF the session is dropped from `manager` so a dead adapter cannot
/// leak an entry even when the frontend never calls `dap_terminate`.
async fn run_reader(
    mut reader: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
    session: Arc<DapSession>,
    manager: Arc<DapManager>,
    session_id: String,
    emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
) {
    use tokio::io::AsyncReadExt;
    let pending = session.pending.clone();
    let mut decoder = DapDecoder::default();
    let mut chunk = [0u8; 8192];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) => break, // EOF: adapter exited.
            Ok(n) => n,
            Err(_) => break,
        };
        decoder.push(&chunk[..read]);
        while let Some(message) = decoder.next_message() {
            match classify_message(&message) {
                InboundMessage::Response { request_seq } => {
                    if let Some(tx) = pending.lock().await.remove(&request_seq) {
                        let ok = message.get("success").and_then(Value::as_bool).unwrap_or(false);
                        let payload = if ok {
                            Ok(message.get("body").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(extract_error_message(&message))
                        };
                        let _ = tx.send(payload);
                    }
                }
                InboundMessage::Event { event } => {
                    emit(
                        &format!("dap:event:{session_id}"),
                        json!({ "sessionId": session_id, "event": event, "message": message }),
                    );
                }
                InboundMessage::ReverseRequest { command, seq } => {
                    // Answer first (an unanswered reverse request stalls the
                    // adapter), then report it for visibility.
                    let _ = session.respond(&reverse_response(&message)).await;
                    emit(
                        &format!("dap:reverse-request:{session_id}"),
                        json!({ "sessionId": session_id, "command": command, "seq": seq, "message": message }),
                    );
                }
                InboundMessage::Unknown => {}
            }
        }
    }
    // Adapter stream ended: notify the frontend so it can tear down the UI.
    emit(
        &format!("dap:event:{session_id}"),
        json!({ "sessionId": session_id, "event": "terminated", "message": Value::Null }),
    );
    manager.remove(&session_id).await;
    // Fail any still-pending requests so callers do not hang.
    let mut guard = pending.lock().await;
    for (_, tx) in guard.drain() {
        let _ = tx.send(Err("debug adapter disconnected".to_string()));
    }
}
/// Start a debug session: resolve the adapter, connect its transport, run the
/// reader pump, and send `initialize`. `app` is a **command parameter** cloned
/// into the reader closure — never stored in `AppState` (M7-C safeguard).
/// Returns the new `sessionId`. D1 ships an empty registry, so this reports
/// "no adapter" until the Java adapter (D2) is registered.
/// Result of starting a session: the id + adapter capabilities + the resolved
/// launch/attach payload. The frontend (D3) drives the rest of the DAP handshake
/// — send `request`/`arguments`, then on the `initialized` event set breakpoints
/// and `configurationDone` — so breakpoints land before the debuggee runs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapStartResult {
    pub session_id: String,
    pub capabilities: Value,
    /// `"launch"` or `"attach"` — the request the frontend should send next.
    pub request: String,
    pub arguments: Value,
}

#[tauri::command]
pub async fn dap_start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    adapter_id: String,
    launch_config: Value,
) -> Result<DapStartResult, String> {
    let adapter = state
        .dap
        .registry
        .get(&adapter_id)
        .ok_or_else(|| format!("No debug adapter registered for `{adapter_id}`"))?;
    let plan = adapter.resolve(&launch_config).await?;
    let (reader, writer, child) = connect_transport(&plan.transport).await?;
    let (child, stderr) = match child {
        Some((child, stderr)) => (Some(child), stderr),
        None => (None, None),
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(DapSession {
        next_seq: AtomicI64::new(1),
        pending: Arc::new(Mutex::new(HashMap::new())),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        capabilities: Mutex::new(Value::Null),
    });

    // Clone the AppHandle into the reader task's emitter closure only.
    let emit_app = app.clone();
    let emit: Arc<dyn Fn(&str, Value) + Send + Sync> = Arc::new(move |event: &str, payload: Value| {
        use tauri::Emitter;
        let _ = emit_app.emit(event, payload);
    });
    tokio::spawn(run_reader(
        reader,
        session.clone(),
        state.dap.clone(),
        session_id.clone(),
        emit.clone(),
    ));
    if let Some(stderr) = stderr {
        tokio::spawn(run_stderr_pump(stderr, session_id.clone(), emit));
    }

    // DAP handshake: initialize, then hand the launch/attach config to the adapter.
    // `supportsConfigurationDoneRequest: true` is REQUIRED — without it, adapters
    // (java-debug) do not wait for `configurationDone` and resume the debuggee
    // immediately after launch, so breakpoints set after the `initialized` event
    // are armed too late and never hit. `supportsRunInTerminalRequest: false`:
    // we do not implement the `runInTerminal` reverse request, so adapters must
    // launch the debuggee themselves (console: internalConsole).
    //
    // Bounded: a wedged adapter that connects but never answers would otherwise
    // leave this command pending forever and the UI stuck at "starting".
    let init = tokio::time::timeout(
        INITIALIZE_TIMEOUT,
        session.request(
            "initialize",
            json!({
                "clientID": "taomni",
                "clientName": "Taomni",
                "adapterID": adapter_id,
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsConfigurationDoneRequest": true,
                "supportsRunInTerminalRequest": false,
                // Ask adapters to include `type` on variables/evaluate results
                // (the variables view shows it as a tooltip).
                "supportsVariableType": true,
            }),
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "debug adapter `{adapter_id}` did not answer `initialize` within {}s",
            INITIALIZE_TIMEOUT.as_secs()
        )
    })??;
    *session.capabilities.lock().await = init.clone();

    state.dap.insert(session_id.clone(), session).await;
    Ok(DapStartResult {
        session_id,
        capabilities: init,
        request: plan.request,
        arguments: plan.arguments,
    })
}

/// Send an arbitrary DAP request on a session and return its response body.
/// (D3–D5 wrap this with typed helpers: setBreakpoints, continue, stackTrace…)
#[tauri::command]
pub async fn dap_send_request(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
    command: String,
    arguments: Option<Value>,
) -> Result<Value, String> {
    let session = state
        .dap
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No debug session `{session_id}`"))?;
    session.request(&command, arguments.unwrap_or(Value::Null)).await
}

/// Fire a DAP request without awaiting its response. Needed for the launch
/// handshake: `launch`'s response does not arrive until after `configurationDone`,
/// so the frontend fires `launch`, reacts to the `initialized` event
/// (setBreakpoints…), then fires `configurationDone` — awaiting `launch` would
/// deadlock that sequence.
#[tauri::command]
pub async fn dap_send(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
    command: String,
    arguments: Option<Value>,
) -> Result<(), String> {
    let session = state
        .dap
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No debug session `{session_id}`"))?;
    session.notify(&command, arguments.unwrap_or(Value::Null)).await
}

/// Terminate a session. Prefers the graceful `terminate` request when the
/// adapter advertises it (the debuggee gets to run shutdown hooks — IDEA's and
/// VS Code's Stop both do this), then always falls back to `disconnect` and
/// kills a spawned stdio adapter.
#[tauri::command]
pub async fn dap_terminate(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.dap.remove(&session_id).await {
        let graceful = session
            .capabilities
            .lock()
            .await
            .get("supportsTerminateRequest")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if graceful {
            // Bounded: a stuck adapter must not block the Stop button.
            let _ = tokio::time::timeout(
                TERMINATE_GRACE,
                session.request("terminate", json!({ "restart": false })),
            )
            .await;
        }
        let _ = session
            .notify("disconnect", json!({ "terminateDebuggee": true }))
            .await;
        if let Some(mut child) = session.child.lock().await.take() {
            let _ = child.start_kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_with_content_length_framing() {
        let framed = encode_message(&json!({ "seq": 1, "type": "request", "command": "next" }));
        let text = String::from_utf8(framed).unwrap();
        let (header, body) = text.split_once("\r\n\r\n").expect("header/body split");
        assert!(header.starts_with("Content-Length: "));
        let declared: usize = header.trim_start_matches("Content-Length: ").parse().unwrap();
        assert_eq!(declared, body.len());
        assert!(body.contains("\"command\":\"next\""));
    }

    #[test]
    fn decodes_a_single_message() {
        let mut decoder = DapDecoder::default();
        decoder.push(&encode_message(&json!({ "type": "event", "event": "stopped" })));
        let message = decoder.next_message().expect("one message");
        assert_eq!(message["event"], "stopped");
        assert!(decoder.next_message().is_none());
    }

    #[test]
    fn reassembles_a_partial_frame_across_pushes() {
        let framed = encode_message(&json!({ "type": "event", "event": "output" }));
        let (head, tail) = framed.split_at(framed.len() / 2);
        let mut decoder = DapDecoder::default();
        decoder.push(head);
        assert!(decoder.next_message().is_none(), "incomplete frame yields nothing");
        decoder.push(tail);
        assert_eq!(decoder.next_message().expect("completed")["event"], "output");
    }

    #[test]
    fn splits_multiple_messages_in_one_chunk() {
        let mut buf = encode_message(&json!({ "type": "event", "event": "a" }));
        buf.extend(encode_message(&json!({ "type": "event", "event": "b" })));
        let mut decoder = DapDecoder::default();
        decoder.push(&buf);
        assert_eq!(decoder.next_message().unwrap()["event"], "a");
        assert_eq!(decoder.next_message().unwrap()["event"], "b");
        assert!(decoder.next_message().is_none());
    }

    #[test]
    fn skips_a_frame_with_invalid_json_body() {
        let mut buf = b"Content-Length: 3\r\n\r\n{[}".to_vec();
        buf.extend(encode_message(&json!({ "type": "event", "event": "recovered" })));
        let mut decoder = DapDecoder::default();
        decoder.push(&buf);
        // The bad frame is dropped; the next valid one is returned.
        assert_eq!(decoder.next_message().unwrap()["event"], "recovered");
    }

    #[test]
    fn classifies_dap_message_types() {
        assert_eq!(
            classify_message(&json!({ "type": "response", "request_seq": 7, "success": true })),
            InboundMessage::Response { request_seq: 7 },
        );
        assert_eq!(
            classify_message(&json!({ "type": "event", "event": "stopped" })),
            InboundMessage::Event { event: "stopped".into() },
        );
        assert_eq!(
            classify_message(&json!({ "type": "request", "command": "runInTerminal", "seq": 4 })),
            InboundMessage::ReverseRequest { command: "runInTerminal".into(), seq: 4 },
        );
        assert_eq!(classify_message(&json!({ "type": "bogus" })), InboundMessage::Unknown);
    }

    #[test]
    fn empty_registry_returns_none() {
        let registry = DebugAdapterRegistry::new();
        assert!(registry.get("java").is_none());
    }

    #[test]
    fn extracts_structured_error_details_with_variable_substitution() {
        // ErrorResponse body.error wins over the terse top-level message.
        let response = json!({
            "type": "response", "success": false, "message": "launch failed",
            "body": { "error": {
                "format": "Failed to launch debuggee VM. Reason: {reason}",
                "variables": { "reason": "mainClass not found" },
            }},
        });
        assert_eq!(
            extract_error_message(&response),
            "Failed to launch debuggee VM. Reason: mainClass not found",
        );
        // Falls back to the flat message, then to a generic string.
        assert_eq!(
            extract_error_message(&json!({ "success": false, "message": "boom" })),
            "boom",
        );
        assert_eq!(
            extract_error_message(&json!({ "success": false })),
            "debug adapter request failed",
        );
    }

    #[test]
    fn answers_reverse_requests_with_a_correlated_failure() {
        // Every reverse request must get a response or the adapter blocks. The
        // kernel implements none of them, so it declines by name.
        let response = reverse_response(&json!({
            "type": "request", "seq": 12, "command": "runInTerminal",
            "arguments": { "args": ["java"] },
        }));
        assert_eq!(response["type"], "response");
        assert_eq!(response["request_seq"], 12);
        assert_eq!(response["command"], "runInTerminal");
        assert_eq!(response["success"], json!(false));
        assert!(response["message"].as_str().unwrap().contains("runInTerminal"));
        // A malformed reverse request still yields a well-formed response.
        let fallback = reverse_response(&json!({ "type": "request" }));
        assert_eq!(fallback["request_seq"], -1);
        assert_eq!(fallback["success"], json!(false));
    }

    #[test]
    fn content_length_header_is_case_insensitive() {
        assert_eq!(parse_content_length(b"content-length: 42"), Some(42));
        assert_eq!(parse_content_length(b"Content-Length: 7\r\nX: y"), Some(7));
        assert_eq!(parse_content_length(b"X-Other: 1"), None);
    }
}
