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
/// A registered debug adapter: how to reach one for a given launch config. Java
/// (D2) is the first implementation; others (Node/Go/LLDB) plug in the same way.
/// `resolve_transport` is async because language adapters may need to talk to
/// their language server first (jdtls hands java-debug a port).
#[async_trait::async_trait]
pub trait DebugAdapter: Send + Sync {
    /// Stable adapter id (e.g. `"java"`), matched against `dap_start_session`.
    fn id(&self) -> &str;

    /// Resolve the transport for a launch/attach config (spawn args or a port).
    async fn resolve_transport(&self, launch_config: &Value) -> Result<DapTransport, String>;
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

/// Establish the read/write streams for a transport (spawn a process or connect a
/// socket). Returns the reader, writer, and (for stdio) the child to retain.
async fn connect_transport(
    transport: &DapTransport,
) -> Result<
    (
        Box<dyn tokio::io::AsyncRead + Send + Unpin>,
        Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
        Option<tokio::process::Child>,
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
            Ok((Box::new(stdout), Box::new(stdin), Some(child)))
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
/// Pump the adapter's output stream: decode frames, resolve pending responses,
/// and forward events + reverse-requests to the frontend. `emit` is a boxed
/// closure that wraps a cloned `AppHandle` (kept out of this module's types so
/// the AppState-reachable AppHandle link that broke M7-C never forms here).
async fn run_reader(
    mut reader: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
    pending: PendingResponses,
    session_id: String,
    emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
) {
    use tokio::io::AsyncReadExt;
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
                            Err(message
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("debug adapter request failed")
                                .to_string())
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
#[tauri::command]
pub async fn dap_start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    adapter_id: String,
    launch_config: Value,
) -> Result<String, String> {
    let adapter = state
        .dap
        .registry
        .get(&adapter_id)
        .ok_or_else(|| format!("No debug adapter registered for `{adapter_id}`"))?;
    let transport = adapter.resolve_transport(&launch_config).await?;
    let (reader, writer, child) = connect_transport(&transport).await?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
    let session = Arc::new(DapSession {
        next_seq: AtomicI64::new(1),
        pending: pending.clone(),
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
    tokio::spawn(run_reader(reader, pending, session_id.clone(), emit));

    // DAP handshake: initialize, then hand the launch/attach config to the adapter.
    let init = session
        .request(
            "initialize",
            json!({
                "clientID": "taomni",
                "clientName": "Taomni",
                "adapterID": adapter_id,
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsRunInTerminalRequest": true,
            }),
        )
        .await?;
    *session.capabilities.lock().await = init;

    state.dap.insert(session_id.clone(), session).await;
    Ok(session_id)
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

/// Terminate a session: best-effort `disconnect`, then drop it (killing the
/// spawned adapter for stdio transports via `kill_on_drop`).
#[tauri::command]
pub async fn dap_terminate(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.dap.remove(&session_id).await {
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
    fn content_length_header_is_case_insensitive() {
        assert_eq!(parse_content_length(b"content-length: 42"), Some(42));
        assert_eq!(parse_content_length(b"Content-Length: 7\r\nX: y"), Some(7));
        assert_eq!(parse_content_length(b"X-Other: 1"), None);
    }
}
