use super::protocol::{self, CodexEvent, CodexUsage};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

const REQUEST_TIMEOUT_SECS: u64 = 120;
const TURN_IDLE_TIMEOUT_SECS: u64 = 960;

type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type ActiveEventTx = Arc<StdMutex<Option<mpsc::UnboundedSender<Value>>>>;

#[derive(Debug, Clone)]
pub struct CodexThreadOptions {
    pub resume_thread_id: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub approval_policy: String,
    pub sandbox: String,
    pub network_access: bool,
    pub config: Map<String, Value>,
    pub base_instructions: Option<String>,
    pub developer_instructions: Option<String>,
    pub ephemeral: bool,
}

#[derive(Debug, Clone)]
pub struct CodexTurnOptions {
    pub cwd: Option<String>,
    pub approval_policy: String,
    pub sandbox: String,
    pub network_access: bool,
    pub model: Option<String>,
}

pub struct CodexAppServer {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    pending: PendingMap,
    active_events: ActiveEventTx,
    next_id: AtomicU64,
    stopped: AtomicBool,
    stderr_buf: Arc<Mutex<String>>,
    temp_dir: Option<PathBuf>,
    codex_token: Option<String>,
    thread_id: StdMutex<Option<String>>,
    active_turns: AtomicU32,
    pub last_active_at: StdMutex<Instant>,
}

impl CodexAppServer {
    pub async fn spawn(
        binary: impl Into<String>,
        proxy_url: Option<String>,
        temp_dir: Option<PathBuf>,
        codex_token: Option<String>,
        extra_env: Option<HashMap<String, String>>,
        isolated_home: bool,
    ) -> Result<Self, String> {
        let binary = binary.into();
        let mut cmd = Command::new(&binary);
        cmd.args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(env) = extra_env {
            for (key, value) in env {
                if !key.trim().is_empty() && !value.trim().is_empty() {
                    cmd.env(key, value);
                }
            }
        }
        if isolated_home {
            let base = temp_dir
                .as_ref()
                .ok_or_else(|| "isolated Codex profile requires a temp dir".to_string())?;
            let codex_home = base.join("codex-home");
            std::fs::create_dir_all(&codex_home)
                .map_err(|e| format!("Failed to create isolated CODEX_HOME: {e}"))?;
            cmd.env("CODEX_HOME", &codex_home)
                .env("CODEX_SQLITE_HOME", &codex_home);
        }
        super::apply_proxy_env(&mut cmd, proxy_url.as_deref());
        super::no_console_window(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn Codex app-server: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to get Codex app-server stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to get Codex app-server stdout")?;

        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let active_events: ActiveEventTx = Arc::new(StdMutex::new(None));
        let stderr_buf = Arc::new(Mutex::new(String::new()));

        if let Some(stderr) = child.stderr.take() {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let mut g = buf.lock().await;
                            g.push_str(&line);
                            if g.len() > 8192 {
                                let keep_from = g.len() - 8192;
                                *g = g[keep_from..].to_string();
                            }
                        }
                    }
                }
            });
        }

        spawn_stdout_reader(stdout, pending.clone(), active_events.clone());

        let server = Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending,
            active_events,
            next_id: AtomicU64::new(1),
            stopped: AtomicBool::new(false),
            stderr_buf,
            temp_dir,
            codex_token,
            thread_id: StdMutex::new(None),
            active_turns: AtomicU32::new(0),
            last_active_at: StdMutex::new(Instant::now()),
        };
        server.initialize().await?;
        Ok(server)
    }

    async fn initialize(&self) -> Result<(), String> {
        self.send_request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "taomni_codex_bridge",
                    "title": "Taomni Codex Bridge",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true,
                    "requestAttestation": false
                }
            }),
        )
        .await
        .map(|_| ())
    }

    pub fn current_thread_id(&self) -> Option<String> {
        self.thread_id.lock().unwrap().clone()
    }

    pub async fn start_or_resume_thread(&self, opts: CodexThreadOptions) -> Result<String, String> {
        if let Some(existing) = self.current_thread_id() {
            return Ok(existing);
        }

        let params = build_thread_params(&opts, false);
        let result = if let Some(resume) = opts
            .resume_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut resume_params = params.clone();
            resume_params["threadId"] = Value::String(resume.to_string());
            match self.send_request("thread/resume", resume_params).await {
                Ok(result) => result,
                Err(e) => {
                    tracing::warn!("Codex thread/resume failed, starting a new thread: {e}");
                    self.send_request("thread/start", build_thread_params(&opts, true))
                        .await?
                }
            }
        } else {
            self.send_request("thread/start", build_thread_params(&opts, true))
                .await?
        };

        let thread_id = result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Codex app-server returned no thread id: {result}"))?
            .to_string();
        *self.thread_id.lock().unwrap() = Some(thread_id.clone());
        Ok(thread_id)
    }

    pub async fn send_turn_with_callback<F: FnMut(&CodexEvent)>(
        &self,
        message: &str,
        opts: CodexTurnOptions,
        mut on_event: F,
    ) -> Result<Vec<CodexEvent>, String> {
        let thread_id = self
            .current_thread_id()
            .ok_or("Codex thread has not been started")?;

        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        {
            let mut active = self.active_events.lock().unwrap();
            if active.is_some() {
                return Err("Codex turn already in progress for this thread".into());
            }
            *active = Some(tx);
        }

        self.mark_turn_started();
        let result = async {
            let mut events = vec![CodexEvent::SessionInit {
                session_id: thread_id.clone(),
            }];
            let mut latest_usage: Option<CodexUsage> = None;
            let mut completed = false;

            let start_result = self
                .send_request("turn/start", build_turn_params(&thread_id, message, &opts))
                .await;
            if let Err(e) = start_result {
                return Err(e);
            }

            while !completed {
                let Some(value) =
                    tokio::time::timeout(Duration::from_secs(TURN_IDLE_TIMEOUT_SECS), rx.recv())
                        .await
                        .map_err(|_| {
                            "Codex turn timed out waiting for app-server output".to_string()
                        })?
                else {
                    break;
                };

                let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");
                match method {
                    "item/agentMessage/delta" => {
                        let content = value
                            .get("params")
                            .and_then(|p| p.get("delta"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !content.is_empty() {
                            let evt = CodexEvent::Partial { content };
                            on_event(&evt);
                            events.push(evt);
                        }
                    }
                    "item/started" => {
                        if let Some(item) = value.get("params").and_then(|p| p.get("item")) {
                            if let Some(name) = protocol::item_tool_name(item) {
                                let evt = CodexEvent::ToolUse {
                                    id: item
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    name,
                                    input: protocol::item_tool_input(item),
                                };
                                on_event(&evt);
                                events.push(evt);
                            }
                        }
                    }
                    "item/completed" => {
                        if let Some(item) = value.get("params").and_then(|p| p.get("item")) {
                            match item.get("type").and_then(|v| v.as_str()) {
                                Some("agentMessage") => {
                                    let content = item
                                        .get("text")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    if !content.is_empty() {
                                        let evt = CodexEvent::AssistantMessage { content };
                                        on_event(&evt);
                                        events.push(evt);
                                    }
                                }
                                Some("mcpToolCall" | "commandExecution" | "dynamicToolCall") => {
                                    let content = protocol::tool_result_text(item);
                                    let evt = CodexEvent::ToolResult {
                                        tool_use_id: item
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        content,
                                    };
                                    on_event(&evt);
                                    events.push(evt);
                                }
                                _ => {}
                            }
                        }
                    }
                    "thread/tokenUsage/updated" => {
                        latest_usage = Some(protocol::parse_token_usage(&value));
                    }
                    "turn/completed" => {
                        if let Some(duration) = value
                            .get("params")
                            .and_then(|p| p.get("turn"))
                            .and_then(|t| t.get("durationMs"))
                            .and_then(|v| v.as_u64())
                        {
                            latest_usage
                                .get_or_insert_with(CodexUsage::default)
                                .duration_ms = Some(duration);
                        }
                        if let Some(error) = value
                            .get("params")
                            .and_then(|p| p.get("turn"))
                            .and_then(|t| t.get("error"))
                            .and_then(|e| e.get("message"))
                            .and_then(|v| v.as_str())
                        {
                            let evt = CodexEvent::Error {
                                message: error.to_string(),
                            };
                            on_event(&evt);
                            events.push(evt);
                        }
                        let evt = CodexEvent::Done {
                            usage: latest_usage.clone(),
                        };
                        on_event(&evt);
                        events.push(evt);
                        completed = true;
                    }
                    "error" => {
                        let msg = value
                            .get("params")
                            .and_then(|p| p.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Codex app-server reported an error")
                            .to_string();
                        let evt = CodexEvent::Error { message: msg };
                        on_event(&evt);
                        events.push(evt);
                    }
                    _ => {}
                }
            }

            Ok(events)
        }
        .await;

        *self.active_events.lock().unwrap() = None;
        self.mark_turn_finished();
        result
    }

    pub async fn get_stderr(&self) -> String {
        self.stderr_buf.lock().await.clone()
    }

    pub fn is_turn_active(&self) -> bool {
        self.active_turns.load(Ordering::SeqCst) > 0
    }

    fn mark_turn_started(&self) {
        self.active_turns.fetch_add(1, Ordering::SeqCst);
        *self.last_active_at.lock().unwrap() = Instant::now();
    }

    fn mark_turn_finished(&self) {
        let _ = self
            .active_turns
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            });
        *self.last_active_at.lock().unwrap() = Instant::now();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(token) = &self.codex_token {
            crate::agent::cc_bridge::mcp_http::revoke_token(token);
        }
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        *self.stdin.lock().await = None;
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let line = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string()
            + "\n";

        let write_result = async {
            let mut guard = self.stdin.lock().await;
            let stdin = guard
                .as_mut()
                .ok_or_else(|| "Codex app-server stdin is closed".to_string())?;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("Failed to write Codex app-server request: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush Codex app-server stdin: {e}"))
        }
        .await;

        if let Err(e) = write_result {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }

        match tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex app-server response channel closed".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Codex app-server request `{method}` timed out"))
            }
        }
    }
}

impl Drop for CodexAppServer {
    fn drop(&mut self) {
        if let Some(token) = &self.codex_token {
            crate::agent::cc_bridge::mcp_http::revoke_token(token);
        }
        if let Ok(mut child_guard) = self.child.try_lock() {
            if let Some(child) = child_guard.as_mut() {
                let _ = child.start_kill();
            }
        }
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn spawn_stdout_reader(
    stdout: tokio::process::ChildStdout,
    pending: PendingMap,
    active_events: ActiveEventTx,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => {
                    let mut p = pending.lock().unwrap();
                    for (_, tx) in p.drain() {
                        let _ = tx.send(Err("Codex app-server stdout closed".into()));
                    }
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                        if value.get("result").is_some() || value.get("error").is_some() {
                            let result = if let Some(error) = value.get("error") {
                                Err(error
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                                    .unwrap_or_else(|| error.to_string()))
                            } else {
                                Ok(value.get("result").cloned().unwrap_or(Value::Null))
                            };
                            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                                let _ = tx.send(result);
                            }
                            continue;
                        }
                    }
                    if value.get("method").and_then(|v| v.as_str()).is_some()
                        && value.get("id").is_none()
                    {
                        if let Some(tx) = active_events.lock().unwrap().as_ref() {
                            let _ = tx.send(value);
                        }
                    }
                }
            }
        }
    });
}

fn build_thread_params(opts: &CodexThreadOptions, include_start_only: bool) -> Value {
    let mut params = Map::new();
    if let Some(model) = opts
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "auto")
    {
        params.insert("model".into(), Value::String(model.into()));
    }
    if let Some(cwd) = opts.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.insert("cwd".into(), Value::String(cwd.into()));
    }
    params.insert(
        "approvalPolicy".into(),
        Value::String(opts.approval_policy.clone()),
    );
    params.insert("sandbox".into(), Value::String(opts.sandbox.clone()));
    params.insert("config".into(), Value::Object(opts.config.clone()));
    if let Some(s) = opts.base_instructions.as_deref().filter(|s| !s.is_empty()) {
        params.insert("baseInstructions".into(), Value::String(s.into()));
    }
    if let Some(s) = opts
        .developer_instructions
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        params.insert("developerInstructions".into(), Value::String(s.into()));
    }
    if include_start_only {
        params.insert("serviceName".into(), Value::String("taomni-codex".into()));
        params.insert("ephemeral".into(), Value::Bool(opts.ephemeral));
    }
    Value::Object(params)
}

fn build_turn_params(thread_id: &str, message: &str, opts: &CodexTurnOptions) -> Value {
    let mut params = Map::new();
    params.insert("threadId".into(), Value::String(thread_id.into()));
    params.insert(
        "input".into(),
        json!([{
            "type": "text",
            "text": message,
            "text_elements": []
        }]),
    );
    if let Some(cwd) = opts.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.insert("cwd".into(), Value::String(cwd.into()));
    }
    if let Some(model) = opts
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "auto")
    {
        params.insert("model".into(), Value::String(model.into()));
    }
    params.insert(
        "approvalPolicy".into(),
        Value::String(opts.approval_policy.clone()),
    );
    params.insert(
        "sandboxPolicy".into(),
        build_sandbox_policy(&opts.sandbox, opts.network_access, opts.cwd.as_deref()),
    );
    Value::Object(params)
}

fn build_sandbox_policy(sandbox: &str, network_access: bool, cwd: Option<&str>) -> Value {
    match sandbox {
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        "workspace-write" => {
            let root = cwd
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    std::env::current_dir()
                        .ok()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| ".".into())
                });
            json!({
                "type": "workspaceWrite",
                "writableRoots": [root],
                "networkAccess": network_access,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false
            })
        }
        _ => json!({ "type": "readOnly", "networkAccess": network_access }),
    }
}
