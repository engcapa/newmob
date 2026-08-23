use super::protocol::{CcEvent, parse_ndjson_line};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const MAX_RESTART_ATTEMPTS: u32 = 3;
const HEALTH_CHECK_INTERVAL_SECS: u64 = 30;
const RESTART_COOLDOWN_SECS: u64 = 60;
/// How long to wait for the *next* line of output before declaring the turn
/// dead. This is an idle timeout, not a wall-clock budget: every line CC emits
/// (including the `--include-partial-messages` token deltas) resets the clock,
/// so a long-running `Bash` build that streams progress stays alive, while a
/// genuinely wedged process is still reaped. Default is relaxed; override per
/// process with `with_idle_timeout`.
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 600;
/// Upper bound on how long CC's stdout may legitimately stay silent *while a
/// tool call is in flight*. Between a `tool_use` line and its matching
/// `tool_result`, CC blocks on the Taomni MCP round-trip — the human
/// confirmation (≤ `mcp_http::PERMISSION_TIMEOUT_SECS` = 300s) plus the tool's
/// own execution (≤ `mcp_http::TOOL_TIMEOUT_SECS` = 600s). The normal idle
/// reaper would kill that healthy turn, so we widen the deadline to this
/// ceiling whenever a tool is outstanding. Must stay ≥ 300 + 600 so the idle
/// reaper never fires before the tool's own timeout resolves the call.
const TOOL_WAIT_CEILING_SECS: u64 = 960;

/// Pick the per-line read deadline. While one or more tool calls are in flight
/// (CC blocked waiting on us), use the wider ceiling; otherwise the normal idle
/// timeout. Pulled out as a pure fn so the decision is unit-testable without a
/// live child process.
fn effective_read_timeout(tools_in_flight: u32, idle: Duration) -> Duration {
    if tools_in_flight > 0 {
        Duration::from_secs(TOOL_WAIT_CEILING_SECS)
    } else {
        idle
    }
}

/// One Claude Code child per chat thread.
///
/// Lifecycle:
/// - First send() spawns the process via `ensure_running`.
/// - A background watchdog wakes every 30s and verifies the child is still
///   running; if the OS reports it exited, we mark the process unhealthy so
///   the next send() respawns (subject to the 3-failure circuit breaker).
/// - On a 3rd consecutive failure within RESTART_COOLDOWN_SECS, the breaker
///   opens and `ensure_running` returns an error that the caller surfaces to
///   the user (so they know to fall back to the secondary provider).
/// - The breaker auto-resets after the cooldown so a transiently-flapping CLI
///   can recover without a Taomni restart.
pub struct CcProcess {
    binary: String,
    args: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    stdout: Mutex<Option<BufReader<tokio::process::ChildStdout>>>,
    restart_count: AtomicU32,
    last_failure_at: Mutex<Option<Instant>>,
    /// Set by the watchdog when it observes a dead process between calls.
    needs_respawn: AtomicBool,
    /// Set by `stop()` so the watchdog stops itself.
    stopped: AtomicBool,
    watchdog_started: AtomicBool,
    /// Rolling capture of the child's stderr, used to surface spawn/runtime
    /// errors (e.g. missing flags, auth failures) that would otherwise be
    /// invisible and present as an empty assistant bubble.
    stderr_buf: Arc<Mutex<String>>,
    /// Obscure temp directory holding this session's `--settings` /
    /// `--mcp-config` files. Owned by the process so the (possibly
    /// credential-bearing) settings file is removed when the session ends —
    /// see `stop()` and the `Drop` impl. `None` when the caller manages the
    /// files itself.
    temp_dir: Option<PathBuf>,
    /// Idle timeout between successive output lines for a single turn.
    idle_timeout: Duration,
    /// Bearer token this process uses to authenticate to the in-app rmcp MCP
    /// server. Revoked on stop/drop so a dead thread's token can't be reused.
    cc_token: Option<String>,
    /// Optional outbound proxy URL applied to the Claude CLI child process via
    /// standard proxy environment variables.
    proxy_url: Option<String>,
    /// Number of turns currently using this process. The app-wide idle reaper
    /// must not stop a process until all turns have finished.
    active_turns: AtomicU32,
    /// Last completed turn activity time of this process (for reaping idle processes)
    pub last_active_at: std::sync::Mutex<std::time::Instant>,
}

impl CcProcess {
    pub fn new(
        binary: impl Into<String>,
        extra_args: Vec<String>,
        temp_dir: Option<PathBuf>,
    ) -> Self {
        let mut args = vec![
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
            // CC requires --verbose when combining --print with
            // --output-format stream-json; without it the CLI exits
            // immediately with an error.
            "--verbose".into(),
            // v2.6 §22: surface partial assistant tokens so the UI can stream.
            "--include-partial-messages".into(),
        ];
        args.extend(extra_args);

        Self {
            binary: binary.into(),
            args,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            stdout: Mutex::new(None),
            restart_count: AtomicU32::new(0),
            last_failure_at: Mutex::new(None),
            needs_respawn: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            watchdog_started: AtomicBool::new(false),
            stderr_buf: Arc::new(Mutex::new(String::new())),
            temp_dir,
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
            cc_token: None,
            proxy_url: None,
            active_turns: AtomicU32::new(0),
            last_active_at: std::sync::Mutex::new(std::time::Instant::now()),
        }
    }

    /// Override the per-turn idle timeout (builder style). Lets the caller wire
    /// the value from config without changing the `new` signature.
    pub fn with_idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    /// Attach the in-app MCP server token this process authenticates with, so
    /// it is revoked when the process stops (builder style).
    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.cc_token = Some(token.into());
        self
    }

    pub fn with_proxy_url(mut self, proxy_url: Option<String>) -> Self {
        self.proxy_url = proxy_url
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub async fn get_stderr(&self) -> String {
        self.stderr_buf.lock().await.clone()
    }

    pub fn is_turn_active(&self) -> bool {
        self.active_turns.load(Ordering::SeqCst) > 0
    }

    fn mark_turn_started(&self) {
        self.active_turns.fetch_add(1, Ordering::SeqCst);
        *self.last_active_at.lock().unwrap() = std::time::Instant::now();
    }

    fn mark_turn_finished(&self) {
        let _ = self
            .active_turns
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            });
        *self.last_active_at.lock().unwrap() = std::time::Instant::now();
    }

    /// Send a message and collect all events until Done or Error.
    /// Spawns the process if not already running.
    pub async fn send(&self, message: &str) -> Result<Vec<CcEvent>, String> {
        self.send_with_callback(message, |_| {}).await
    }

    /// Send a message with a per-event callback so callers can stream partial
    /// tokens to the UI as they arrive.
    pub async fn send_with_callback<F: FnMut(&CcEvent)>(
        &self,
        message: &str,
        mut on_event: F,
    ) -> Result<Vec<CcEvent>, String> {
        self.mark_turn_started();
        let result = async {
            self.ensure_running().await?;

            // Write the message as a JSON line to stdin. CC's stream-json input
            // format expects `message` to be a full Anthropic message object
            // ({"role":"user","content":"..."}), not a bare string.
            let input = format!(
                "{}\n",
                serde_json::json!({
                    "type": "user",
                    "message": { "role": "user", "content": message }
                })
            );
            {
                let mut stdin_guard = self.stdin.lock().await;
                if let Some(stdin) = stdin_guard.as_mut() {
                    stdin
                        .write_all(input.as_bytes())
                        .await
                        .map_err(|e| format!("Failed to write to CC stdin: {}", e))?;
                    stdin
                        .flush()
                        .await
                        .map_err(|e| format!("Failed to flush CC stdin: {}", e))?;
                }
            }

            // Read events from stdout until Done or Error.
            self.collect_events(&mut on_event).await
        }
        .await;
        self.mark_turn_finished();
        result
    }

    async fn ensure_running(self: &Self) -> Result<(), String> {
        // Watchdog flagged a dead child since the last call — clear the slot
        // so the spawn path runs.
        if self.needs_respawn.swap(false, Ordering::SeqCst) {
            let mut child_guard = self.child.lock().await;
            if let Some(mut c) = child_guard.take() {
                let _ = c.kill().await;
            }
            *self.stdin.lock().await = None;
        }

        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            return Ok(());
        }

        // Circuit breaker: refuse to keep respawning a binary that just won't
        // come up. We auto-reset the counter once RESTART_COOLDOWN_SECS have
        // passed since the last failure — that lets a transiently-broken CLI
        // recover without forcing a Taomni restart.
        let count = self.restart_count.load(Ordering::SeqCst);
        if count >= MAX_RESTART_ATTEMPTS {
            let last = *self.last_failure_at.lock().await;
            let cooled_down = last
                .map(|t| t.elapsed().as_secs() >= RESTART_COOLDOWN_SECS)
                .unwrap_or(false);
            if cooled_down {
                self.restart_count.store(0, Ordering::SeqCst);
            } else {
                return Err(format!(
                    "Claude Code process failed {} times. Falling back to default provider; will retry after {}s.",
                    MAX_RESTART_ATTEMPTS, RESTART_COOLDOWN_SECS,
                ));
            }
        }

        let mut cmd = Command::new(&self.binary);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        super::apply_proxy_env(&mut cmd, self.proxy_url.as_deref());
        // Windows: don't pop a console window for the claude .cmd/.ps1 shim.
        super::no_console_window(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.record_failure().await;
                return Err(format!("Failed to spawn Claude Code: {}", e));
            }
        };

        let stdin = child.stdin.take().ok_or("Failed to get CC stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get CC stdout")?;

        // Drain stderr into a rolling buffer so we can report why the CLI
        // exited if it dies without producing usable stdout.
        if let Some(stderr) = child.stderr.take() {
            let buf = self.stderr_buf.clone();
            {
                let mut g = buf.lock().await;
                g.clear();
            }
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let mut g = buf.lock().await;
                            if g.len() < 8192 {
                                g.push_str(&line);
                            }
                        }
                    }
                }
            });
        }

        *child_guard = Some(child);
        *self.stdin.lock().await = Some(stdin);
        *self.stdout.lock().await = Some(BufReader::new(stdout));
        // Drop the guard so callers (and the watchdog) can lock back in. The
        // watchdog is started by the owner of the `Arc<CcProcess>` (see
        // `start_watchdog`), not here, because it needs a `Weak<Self>`.
        drop(child_guard);

        Ok(())
    }

    async fn record_failure(&self) {
        self.restart_count.fetch_add(1, Ordering::SeqCst);
        *self.last_failure_at.lock().await = Some(Instant::now());
    }

    /// Spawn the liveness watchdog for this process. Holds only a `Weak<Self>`
    /// between ticks, so it never keeps the process alive on its own: once the
    /// registry drops the last strong `Arc` (e.g. `recycle_thread_process` or a
    /// replaced entry), the next `upgrade()` fails and the task exits. This
    /// replaces the previous raw-pointer (`self as *const Self as usize`)
    /// approach and its fragile "the Arc outlives the task" contract.
    ///
    /// Idempotent — the `watchdog_started` guard makes repeat calls a no-op, so
    /// the caller can invoke it unconditionally on every send.
    pub fn start_watchdog(self: &Arc<Self>) {
        if self.watchdog_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS)).await;
                // Upgrade only for the duration of this tick; if the last strong
                // Arc is gone, stop watching.
                let Some(this) = weak.upgrade() else { break };
                if this.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let mut guard = this.child.lock().await;
                let dead = match guard.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(_status)) => true, // process exited
                        Ok(None) => false,         // still running
                        Err(_) => true,
                    },
                    None => false,
                };
                if dead {
                    if let Some(mut c) = guard.take() {
                        let _ = c.kill().await;
                    }
                    drop(guard);
                    *this.stdin.lock().await = None;
                    *this.stdout.lock().await = None;
                    this.needs_respawn.store(true, Ordering::SeqCst);
                    this.record_failure().await;
                }
                // `this` (the strong Arc) drops here → back to Weak-only until
                // the next tick, so the watchdog never extends the lifetime.
            }
        });
    }

    async fn collect_events<F: FnMut(&CcEvent)>(
        &self,
        on_event: &mut F,
    ) -> Result<Vec<CcEvent>, String> {
        let mut events = Vec::new();
        let mut terminal_seen = false;
        let mut stdout_guard = self.stdout.lock().await;

        let reader = stdout_guard.as_mut().ok_or("CC stdout not available")?;

        let mut line = String::new();

        // Captures a read error / idle timeout so we can run the shared
        // kill+respawn cleanup once, after dropping the child guard, instead
        // of returning early with a poisoned (still-running, half-read) child.
        let mut read_failure: Option<String> = None;

        // Count of tool calls CC has emitted a `tool_use` for but not yet a
        // `tool_result`. While > 0, CC's stdout is legitimately silent for the
        // duration of the MCP round-trip (confirmation + execution), so we
        // widen the read deadline (see `TOOL_WAIT_CEILING_SECS`). Saturating
        // decrement keeps a stray unmatched `tool_result` from underflowing.
        let mut tools_in_flight: u32 = 0;

        loop {
            line.clear();
            let effective = effective_read_timeout(tools_in_flight, self.idle_timeout);
            match tokio::time::timeout(effective, reader.read_line(&mut line)).await {
                Ok(Ok(0)) => break, // EOF — process exited.
                Ok(Ok(_)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some(event) = parse_ndjson_line(trimmed) {
                        match &event {
                            CcEvent::ToolUse { .. } => tools_in_flight += 1,
                            CcEvent::ToolResult { .. } => {
                                tools_in_flight = tools_in_flight.saturating_sub(1);
                            }
                            _ => {}
                        }
                        on_event(&event);
                        let done = matches!(event, CcEvent::Done { .. } | CcEvent::Error { .. });
                        events.push(event);
                        if done {
                            terminal_seen = true;
                            break;
                        }
                    }
                }
                Ok(Err(e)) => {
                    read_failure = Some(format!("CC stdout read error: {}", e));
                    break;
                }
                Err(_) => {
                    read_failure = Some(format!(
                        "CC response timed out after {}s of inactivity",
                        effective.as_secs()
                    ));
                    break;
                }
            }
        }

        // A turn that ended without a terminal event — EOF (child died early
        // on bad flags / auth failure / crash), a read error, or an idle
        // timeout — leaves the child in an unusable state. Reap it, schedule a
        // respawn and trip the failure counter so the breaker can engage, then
        // surface a real error instead of an empty bubble or a poisoned next
        // turn reading this turn's leftover output.
        if !terminal_seen {
            drop(stdout_guard);
            if let Some(mut c) = self.child.lock().await.take() {
                let _ = c.kill().await;
            }
            *self.stdin.lock().await = None;
            *self.stdout.lock().await = None;
            self.needs_respawn.store(true, Ordering::SeqCst);
            self.record_failure().await;
            if let Some(reason) = read_failure {
                return Err(reason);
            }
            let stderr = self.stderr_buf.lock().await.trim().to_string();
            let detail = if stderr.is_empty() {
                "no stderr output".to_string()
            } else {
                stderr
            };
            return Err(format!("Claude Code exited unexpectedly: {}", detail));
        }

        Ok(events)
    }

    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        *self.stdin.lock().await = None;
        *self.stdout.lock().await = None;
        // Revoke our MCP server token so it can't be reused after the process
        // is gone.
        if let Some(token) = &self.cc_token {
            super::mcp_http::revoke_token(token);
        }
        // Remove the session's temp files now that the process is gone. The
        // settings file may carry the user's ANTHROPIC_AUTH_TOKEN, so we don't
        // want it lingering in the temp directory after use.
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl Drop for CcProcess {
    /// Safety net: if the process is dropped without an explicit `stop()`
    /// (e.g. the registry entry is replaced), still scrub the temp directory
    /// and revoke the MCP token. `stop()` sets `stopped` before the Arc is
    /// dropped, so the watchdog has already exited by the time this runs.
    fn drop(&mut self) {
        if let Some(token) = &self.cc_token {
            super::mcp_http::revoke_token(token);
        }
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_used_when_no_tool_in_flight() {
        let idle = Duration::from_secs(600);
        assert_eq!(effective_read_timeout(0, idle), idle);
    }

    #[test]
    fn ceiling_used_while_a_tool_is_in_flight() {
        let idle = Duration::from_secs(600);
        let eff = effective_read_timeout(1, idle);
        assert_eq!(eff, Duration::from_secs(TOOL_WAIT_CEILING_SECS));
        assert!(eff > idle, "in-flight deadline must exceed the idle one");
    }

    #[test]
    fn ceiling_covers_permission_plus_tool_wait() {
        // The ceiling must outlast a human confirmation (300s) followed by the
        // tool's own execution budget (600s); otherwise the idle reaper would
        // kill CC mid-call. Mirrors mcp_http::{PERMISSION_TIMEOUT_SECS,
        // TOOL_TIMEOUT_SECS} — keep in sync if those change.
        assert!(TOOL_WAIT_CEILING_SECS >= 300 + 600);
    }

    #[test]
    fn multiple_in_flight_tools_still_use_ceiling() {
        let idle = Duration::from_secs(600);
        assert_eq!(
            effective_read_timeout(3, idle),
            Duration::from_secs(TOOL_WAIT_CEILING_SECS)
        );
    }
}
