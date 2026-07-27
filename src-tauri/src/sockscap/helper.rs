//! Launch and talk to the elevated SocksCap helper (Windows UAC).

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
#[cfg(windows)]
use tauri::Manager;

use crate::sockscap::paths::{
    resolve_helper_exe, resolve_windivert_dir, windivert_missing_hint,
};
use crate::state::AppState;

static REQ_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub running: bool,
    pub elevated: bool,
    pub endpoint: Option<String>,
    pub message: String,
    pub windivert: Option<serde_json::Value>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct HelperSession {
    pub token: String,
    pub port: u16,
    pub pid: Option<u32>,
    ready_file: PathBuf,
}

impl HelperSession {
    /// Remove the ready file advertising this helper. Idempotent, best effort.
    ///
    /// Must run on every path that abandons a session: a ready file left behind
    /// points at a helper that is dead (or wedged), and boot repair would treat
    /// it as a live orphan.
    pub fn remove_ready_file(&self) {
        let _ = std::fs::remove_file(&self.ready_file);
    }
}

/// In-process registry of the active helper session (if any).
pub struct HelperRegistry {
    pub(crate) inner: Mutex<Option<HelperSession>>,
}

#[derive(Debug, Clone)]
pub struct OrigMapping {
    pub dst_ip: String,
    pub dst_port: u16,
    pub pid: u32,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct CaptureStartArgs {
    pub mode_apps: bool,
    pub app_paths: Vec<String>,
    pub bypass_cidrs: Vec<String>,
    pub bypass_pids: Vec<u32>,
    /// Executable paths to always bypass (restart-proof local-proxy exclusion).
    pub bypass_paths: Vec<String>,
    pub bypass_endpoints: Vec<(String, u16)>,
    pub relay_ip: String,
    pub relay_port: u16,
}

impl HelperRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Default for HelperRegistry {
    fn default() -> Self {
        Self::new()
    }
}



fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("pick free port: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("sc-{:x}-{:x}", n, std::process::id())
}

/// Probe a session already held in the registry.
///
/// - `Ok(Some(status))` — healthy and reusable, no new UAC prompt needed.
/// - `Ok(None)` — not usable; the caller should launch a fresh helper.
/// - `Err(_)` — broken in a way the user needs to see (e.g. WinDivert missing).
fn probe_existing_helper(
    app: &AppHandle,
    sess: &HelperSession,
) -> Result<Option<HelperStatus>, String> {
    let Ok(mut st) = request_status(sess) else {
        return Ok(None);
    };
    if !st.running {
        return Ok(None);
    }
    if !st.elevated {
        let _ = send_cmd(sess, "shutdown", None);
        return Ok(None);
    }
    // Re-probe WinDivert so a stale helper without driver is rejected.
    match send_cmd(sess, "windivert_probe", Some("false".into())) {
        Ok(resp) if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
            st.windivert = resp.get("result").cloned();
            st.message = "helper elevated; WinDivert OK".into();
            Ok(Some(st))
        }
        Ok(resp) => {
            let err = resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("probe failed");
            let _ = send_cmd(sess, "shutdown", None);
            Err(format!(
                "Existing helper cannot open WinDivert: {err}. {}",
                windivert_missing_hint(app)
            ))
        }
        Err(e) => {
            let _ = send_cmd(sess, "shutdown", None);
            Err(format!("Helper probe failed: {e}"))
        }
    }
}

/// Forget a session: clear the registry slot (only if it is still *this*
/// session) and delete its ready file, so neither a retry nor boot repair can
/// rediscover a helper we have given up on.
fn discard_helper_session(state: &State<'_, AppState>, sess: &HelperSession) {
    if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
        if guard.as_ref().map(|s| s.port) == Some(sess.port) {
            *guard = None;
        }
    }
    sess.remove_ready_file();
}

/// Start the helper elevated on Windows (UAC prompt). No-op error on other OS.
#[tauri::command]
pub async fn sockscap_helper_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HelperStatus, String> {
    // Snapshot the registered session and release the lock before any blocking
    // helper RPC — holding it across the network round-trips below would stall
    // every other caller (relay lookups included) for the RPC timeout.
    let existing = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());

    if let Some(sess) = existing {
        match probe_existing_helper(&app, &sess) {
            Ok(Some(st)) => return Ok(st),
            // Unusable but not worth surfacing — fall through to a fresh launch.
            Ok(None) => discard_helper_session(&state, &sess),
            Err(e) => {
                // Drop the broken session *before* returning: leaving it in the
                // registry meant a retry in the same run kept re-probing the
                // very helper we just gave up on.
                discard_helper_session(&state, &sess);
                return Err(e);
            }
        }
    }
    // Clear dead session slot.
    if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
        *guard = None;
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        return Err("Elevated SocksCap helper is only implemented on Windows".into());
    }

    #[cfg(windows)]
    {
        // Run the privileged binaries from a per-version app-data copy rather
        // than the install directory, so a live helper and a loaded WinDivert
        // driver never hold install-directory files open against an upgrade.
        // Falling back to running in place is no worse than before.
        let staged = crate::sockscap::paths::stage_privileged_runtime(&app);
        if let Err(e) = &staged {
            tracing::warn!("sockscap: staging privileged runtime failed ({e}); running in place");
        }
        let helper = match &staged {
            Ok((exe, _)) => exe.clone(),
            Err(_) => resolve_helper_exe(&app)?,
        };
        let token = random_token();
        let port = pick_free_port()?;
        let ready_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("sockscap");
        std::fs::create_dir_all(&ready_dir).map_err(|e| e.to_string())?;
        let ready_file = ready_dir.join(format!("helper-ready-{port}.json"));
        let ready_file = std::fs::canonicalize(&ready_dir)
            .map(|d| d.join(format!("helper-ready-{port}.json")))
            .unwrap_or(ready_file);
        let _ = std::fs::remove_file(&ready_file);

        let mut args = vec![
            "--token".into(),
            token.clone(),
            "--port".into(),
            port.to_string(),
            "--ready-file".into(),
            ready_file.display().to_string(),
            // Parent-death watchdog: helper self-terminates (and unloads
            // WinDivert) if this process dies without a clean shutdown RPC.
            "--parent-pid".into(),
            std::process::id().to_string(),
        ];
        // The pid alone is not a stable identity across the UAC prompt, which
        // the user may leave open for minutes. Pair it with this process's
        // creation time so the helper can tell "my parent" from "whatever now
        // holds that pid".
        if let Some(start) = current_process_start_filetime() {
            args.push("--parent-start".into());
            args.push(start.to_string());
        }

        // Hand over any orphaned helpers boot repair found but could not
        // terminate. This process is not elevated; the helper we are about to
        // launch is, so it is the only thing that can reap them.
        let reap: Vec<u32> = state
            .sockscap
            .pending_reap
            .lock()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default();
        if !reap.is_empty() {
            tracing::info!("sockscap: asking the new helper to reap orphan pids {reap:?}");
            args.push("--reap-pids".into());
            args.push(
                reap.iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let wd = match &staged {
            Ok((_, dir)) => dir.clone(),
            Err(_) => match resolve_windivert_dir(&app) {
                Some(d) => d,
                None => return Err(windivert_missing_hint(&app)),
            },
        };
        // Absolute path required: elevated process cwd is typically System32.
        args.push("--windivert-dir".into());
        args.push(wd.display().to_string());
        tracing::info!(
            "sockscap: launching helper={} windivert-dir={}",
            helper.display(),
            wd.display()
        );

        // UAC elevation: PowerShell Start-Process -Verb RunAs
        elevate_and_spawn(&helper, &args)?;

        // Wait for ready file or TCP accept.
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut elevated = false;
        let mut pid = None;
        while Instant::now() < deadline {
            if ready_file.is_file() {
                if let Ok(s) = std::fs::read_to_string(&ready_file) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                        elevated = v
                            .get("elevated")
                            .and_then(|x| x.as_bool())
                            .unwrap_or(false);
                        pid = v.get("pid").and_then(|x| x.as_u64()).map(|n| n as u32);
                    }
                }
                if TcpStream::connect_timeout(
                    &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                    Duration::from_millis(200),
                )
                .is_ok()
                {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(150));
        }

        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(500),
        )
        .is_err()
        {
            // Abandon whatever half-started: a ready file for a helper we can
            // no longer reach would otherwise linger for boot repair to find.
            let _ = std::fs::remove_file(&ready_file);
            return Err(
                "Helper did not become ready. If you cancelled the UAC prompt, try again and click Yes."
                    .into(),
            );
        }

        let sess = HelperSession {
            token,
            port,
            pid,
            ready_file,
        };
        let mut st = request_status(&sess).unwrap_or(HelperStatus {
            running: true,
            elevated,
            endpoint: Some(format!("127.0.0.1:{port}")),
            message: "helper listening".into(),
            windivert: None,
            pid,
        });
        // Prefer live status elevated flag.
        elevated = st.elevated || elevated;
        st.elevated = elevated;

        if !st.elevated {
            let _ = send_cmd(&sess, "shutdown", None);
            sess.remove_ready_file();
            return Err(
                "SocksCap helper is not elevated. Capture requires Administrator. Re-start and accept the UAC prompt."
                    .into(),
            );
        }

        // Verify WinDivert can open under the elevated helper.
        match send_cmd(&sess, "windivert_probe", Some("false".into())) {
            Ok(resp) if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
                st.windivert = resp.get("result").cloned();
                st.message = "helper elevated; WinDivert OK".into();
            }
            Ok(resp) => {
                let err = resp
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("WinDivert probe failed");
                let _ = send_cmd(&sess, "shutdown", None);
                sess.remove_ready_file();
                return Err(format!(
                    "Elevated helper started but WinDivert failed: {err}. {}",
                    windivert_missing_hint(&app)
                ));
            }
            Err(e) => {
                let _ = send_cmd(&sess, "shutdown", None);
                sess.remove_ready_file();
                return Err(format!("WinDivert probe error: {e}"));
            }
        }

        if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
            *guard = Some(sess);
        }
        Ok(st)
    }
}

/// This process's creation time as a 64-bit FILETIME. Combined with the pid it
/// identifies the process uniquely, which a pid alone does not once the pid can
/// be recycled.
#[cfg(windows)]
fn current_process_start_filetime() -> Option<u64> {
    use winapi::shared::minwindef::FILETIME;
    use winapi::um::processthreadsapi::{GetCurrentProcess, GetProcessTimes};

    unsafe {
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return None;
        }
        Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}

#[cfg(windows)]
fn elevate_and_spawn(helper: &Path, args: &[String]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let helper_s = helper.display().to_string().replace('\'', "''");
    let arg_list = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "Start-Process -FilePath '{}' -ArgumentList @({}) -Verb RunAs -WindowStyle Hidden",
        helper_s, arg_list
    );

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to launch elevated helper: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "UAC elevate failed (cancelled?): {}",
            stderr.trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn sockscap_helper_stop(state: State<'_, AppState>) -> Result<(), String> {
    let sess = {
        let mut guard = state
            .sockscap
            .helper
            .inner
            .lock()
            .map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(sess) = sess {
        let _ = send_cmd(&sess, "shutdown", None);
        sess.remove_ready_file();
    }
    Ok(())
}

#[tauri::command]
pub async fn sockscap_helper_status(state: State<'_, AppState>) -> Result<HelperStatus, String> {
    let guard = state
        .sockscap
        .helper
        .inner
        .lock()
        .map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(sess) => request_status(sess),
        None => Ok(HelperStatus {
            running: false,
            elevated: false,
            endpoint: None,
            message: "helper not running".into(),
            windivert: None,
            pid: None,
        }),
    }
}

#[tauri::command]
pub async fn sockscap_helper_probe_windivert(
    state: State<'_, AppState>,
    filter: Option<String>,
) -> Result<serde_json::Value, String> {
    let guard = state
        .sockscap
        .helper
        .inner
        .lock()
        .map_err(|e| e.to_string())?;
    let sess = guard
        .as_ref()
        .ok_or_else(|| "helper not running — start it first (UAC)".to_string())?;
    let resp = send_cmd(sess, "windivert_probe", filter)?;
    if resp
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        Ok(resp.get("result").cloned().unwrap_or(json!({})))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("windivert probe failed")
            .to_string())
    }
}

fn request_status(sess: &HelperSession) -> Result<HelperStatus, String> {
    let resp = send_cmd(sess, "status", None)?;
    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        return Ok(HelperStatus {
            running: false,
            elevated: false,
            endpoint: Some(format!("127.0.0.1:{}", sess.port)),
            message: resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("helper not responding")
                .to_string(),
            windivert: None,
            pid: sess.pid,
        });
    }
    let result = resp.get("result").cloned().unwrap_or(json!({}));
    Ok(HelperStatus {
        running: true,
        elevated: result
            .get("elevated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        endpoint: Some(format!("127.0.0.1:{}", sess.port)),
        message: "helper ok".into(),
        windivert: None,
        pid: result
            .get("pid")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .or(sess.pid),
    })
}

fn send_cmd(
    sess: &HelperSession,
    cmd: &str,
    filter: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut body = json!({
        "cmd": cmd,
    });
    if let Some(f) = filter {
        body["filter"] = json!(f);
    }
    send_json(sess, body)
}

/// Low-level helper RPC with a free-form JSON body (`cmd` required).
pub fn send_json(sess: &HelperSession, body: serde_json::Value) -> Result<serde_json::Value, String> {
    send_json_timeout(sess, body, Duration::from_secs(15))
}

/// Same as [`send_json`] with an explicit read timeout (used by capture_stop).
pub fn send_json_timeout(
    sess: &HelperSession,
    mut body: serde_json::Value,
    read_timeout: Duration,
) -> Result<serde_json::Value, String> {
    let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("id".into(), json!(id));
        obj.insert("token".into(), json!(&sess.token));
    }
    let mut stream = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], sess.port)),
        Duration::from_secs(2),
    )
    .map_err(|e| format!("connect helper: {e}"))?;
    stream.set_read_timeout(Some(read_timeout)).ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok();

    let line = format!("{}\n", body);
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("write helper: {e}"))?;
    stream.flush().ok();

    let mut reader = BufReader::new(stream);
    let mut resp_line = String::new();
    reader
        .read_line(&mut resp_line)
        .map_err(|e| format!("read helper: {e}"))?;
    serde_json::from_str(resp_line.trim()).map_err(|e| format!("helper json: {e}"))
}

fn expect_ok(resp: serde_json::Value) -> Result<serde_json::Value, String> {
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(resp.get("result").cloned().unwrap_or(json!({})))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("helper error")
            .to_string())
    }
}

pub fn capture_start(sess: &HelperSession, args: &CaptureStartArgs) -> Result<serde_json::Value, String> {
    let endpoints: Vec<serde_json::Value> = args
        .bypass_endpoints
        .iter()
        .map(|(ip, port)| json!({ "ip": ip, "port": port }))
        .collect();
    let body = json!({
        "cmd": "capture_start",
        "mode": if args.mode_apps { "apps" } else { "global" },
        "appPaths": args.app_paths,
        "bypassCidrs": args.bypass_cidrs,
        "bypassPids": args.bypass_pids,
        "bypassPaths": args.bypass_paths,
        "bypassEndpoints": endpoints,
        "relayIp": args.relay_ip,
        "relayPort": args.relay_port,
    });
    expect_ok(send_json(sess, body)?)
}

pub fn capture_stop(sess: &HelperSession) -> Result<(), String> {
    // Helper joins divert threads after WinDivertClose; keep client wait short
    // so Stop never hangs the UI for the full 15s RPC default.
    let _ = expect_ok(send_json_timeout(
        sess,
        json!({ "cmd": "capture_stop" }),
        Duration::from_secs(3),
    )?)?;
    Ok(())
}

/// Hot-swap the relay port on the running capture session.
/// Does not restart WinDivert — takes effect on the next intercepted packet.
pub fn capture_update_relay(sess: &HelperSession, relay_port: u16) -> Result<serde_json::Value, String> {
    expect_ok(send_json(sess, json!({ "cmd": "capture_update", "relayPort": relay_port }))?)
}

/// Replace the running session's bypass lists.
///
/// Needed because the set of processes that must never be captured is not fixed
/// at start: an xray core that crashes is respawned with a **new pid**, and a
/// local proxy can be restarted by the user. Until the helper learns the new
/// pid, that process's connection to its remote node is captured and reflected
/// back into the relay, which dials the core's own inbound — a loop that wedges
/// all proxied traffic.
pub fn capture_update_bypass(
    sess: &HelperSession,
    bypass_pids: &[u32],
    bypass_paths: &[String],
) -> Result<serde_json::Value, String> {
    expect_ok(send_json(
        sess,
        json!({
            "cmd": "capture_update",
            "bypassPids": bypass_pids,
            "bypassPaths": bypass_paths,
        }),
    )?)
}

pub fn lookup_orig(sess: &HelperSession, src_port: u16) -> Result<OrigMapping, String> {
    lookup_orig_key(sess, "", src_port)
}

pub fn lookup_orig_key(
    sess: &HelperSession,
    src_ip: &str,
    src_port: u16,
) -> Result<OrigMapping, String> {
    let result = expect_ok(send_json(sess, lookup_orig_body(src_ip, src_port))?)?;
    Ok(parse_orig_mapping(&result))
}

fn lookup_orig_body(src_ip: &str, src_port: u16) -> serde_json::Value {
    let mut body = json!({
        "cmd": "lookup_orig",
        "srcPort": src_port,
    });
    if !src_ip.is_empty() {
        body["srcIp"] = json!(src_ip);
    }
    body
}

fn parse_orig_mapping(result: &serde_json::Value) -> OrigMapping {
    OrigMapping {
        dst_ip: result
            .get("dstIp")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0.0")
            .to_string(),
        dst_port: result.get("dstPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
        pid: result.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        path: result
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/* ------------------------- async control channel ------------------------- */

/// Queue depth before callers start waiting. Requests are tiny and serviced in
/// microseconds; this only has to absorb a burst of simultaneous connections.
const CLIENT_QUEUE: usize = 512;
const CLIENT_CALL_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// After a failed connect, fail fast for a moment rather than having every
/// queued request pay the connect timeout in turn.
const CLIENT_RECONNECT_DEBOUNCE: Duration = Duration::from_millis(200);

struct Job {
    body: serde_json::Value,
    reply: tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
}

/// Long-lived async control channel to the elevated helper.
///
/// The relay asks the helper to resolve the original destination once per
/// captured connection. Doing that with the synchronous [`send_json`] path
/// opened a fresh TCP connection, wrote, and blocked on the read — on a tokio
/// worker thread, while holding the `HelperRegistry` mutex and a `RelayContext`
/// read lock. Every captured connection therefore serialised behind every
/// other, a worker was parked for the duration, and each lookup burned an
/// ephemeral port of its own — accelerating the very port exhaustion that made
/// long runs fail.
///
/// One task owns one connection and services requests in order; callers await a
/// oneshot. A broken connection is dropped and re-established on the next
/// request.
pub struct HelperClient {
    tx: tokio::sync::mpsc::Sender<Job>,
}

impl HelperClient {
    /// Start the control task. It ends when the returned client is dropped.
    pub fn spawn(sess: HelperSession) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(CLIENT_QUEUE);
        tokio::spawn(client_loop(sess, rx));
        Self { tx }
    }

    pub async fn call(&self, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.tx
            .send(Job { body, reply })
            .await
            .map_err(|_| "helper control channel closed".to_string())?;
        wait.await
            .map_err(|_| "helper control channel dropped the request".to_string())?
    }

    pub async fn lookup_orig(&self, src_ip: &str, src_port: u16) -> Result<OrigMapping, String> {
        let result = expect_ok(self.call(lookup_orig_body(src_ip, src_port)).await?)?;
        Ok(parse_orig_mapping(&result))
    }
}

async fn client_loop(sess: HelperSession, mut rx: tokio::sync::mpsc::Receiver<Job>) {
    use tokio::io::BufReader;
    use tokio::net::TcpStream;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], sess.port));
    let mut conn: Option<BufReader<TcpStream>> = None;
    let mut last_connect_failure: Option<Instant> = None;

    while let Some(job) = rx.recv().await {
        if conn.is_none() {
            if last_connect_failure
                .is_some_and(|at| at.elapsed() < CLIENT_RECONNECT_DEBOUNCE)
            {
                let _ = job
                    .reply
                    .send(Err("helper control connection unavailable".into()));
                continue;
            }
            match tokio::time::timeout(CLIENT_CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
                Ok(Ok(s)) => {
                    let _ = s.set_nodelay(true);
                    conn = Some(BufReader::new(s));
                    last_connect_failure = None;
                }
                Ok(Err(e)) => {
                    last_connect_failure = Some(Instant::now());
                    let _ = job.reply.send(Err(format!("connect helper: {e}")));
                    continue;
                }
                Err(_) => {
                    last_connect_failure = Some(Instant::now());
                    let _ = job.reply.send(Err("connect helper: timed out".into()));
                    continue;
                }
            }
        }

        let stream = conn.as_mut().expect("connection established above");
        let res = client_call(stream, &sess, job.body).await;
        if res.is_err() {
            // Any failure may have left a partial response in the buffer, so
            // the connection is discarded rather than resynchronised.
            conn = None;
        }
        let _ = job.reply.send(res);
    }
}

async fn client_call(
    stream: &mut tokio::io::BufReader<tokio::net::TcpStream>,
    sess: &HelperSession,
    mut body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("id".into(), json!(id));
        obj.insert("token".into(), json!(&sess.token));
    }
    let line = format!("{body}\n");

    tokio::time::timeout(CLIENT_CALL_TIMEOUT, async {
        stream
            .get_mut()
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write helper: {e}"))?;
        stream
            .get_mut()
            .flush()
            .await
            .map_err(|e| format!("flush helper: {e}"))?;
        let mut resp = String::new();
        let n = stream
            .read_line(&mut resp)
            .await
            .map_err(|e| format!("read helper: {e}"))?;
        if n == 0 {
            return Err("helper closed the control connection".to_string());
        }
        serde_json::from_str(resp.trim()).map_err(|e| format!("helper json: {e}"))
    })
    .await
    .map_err(|_| {
        format!(
            "helper call timed out after {}s",
            CLIENT_CALL_TIMEOUT.as_secs()
        )
    })?
}

/// Ensure helper is running (elevate via UAC if needed). Returns current status.
pub async fn ensure_helper(app: &AppHandle, state: &State<'_, AppState>) -> Result<HelperStatus, String> {
    sockscap_helper_start(app.clone(), state.clone()).await
}
