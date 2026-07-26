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

/// Start the helper elevated on Windows (UAC prompt). No-op error on other OS.
#[tauri::command]
pub async fn sockscap_helper_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HelperStatus, String> {
    // Already running and elevated?
    if let Ok(guard) = state.sockscap.helper.inner.lock() {
        if let Some(sess) = guard.as_ref() {
            if let Ok(mut st) = request_status(sess) {
                if st.running {
                    if !st.elevated {
                        let _ = send_cmd(sess, "shutdown", None);
                    } else {
                        // Re-probe WinDivert so a stale helper without driver is rejected.
                        match send_cmd(sess, "windivert_probe", Some("false".into())) {
                            Ok(resp)
                                if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) =>
                            {
                                st.windivert = resp.get("result").cloned();
                                st.message = "helper elevated; WinDivert OK".into();
                                return Ok(st);
                            }
                            Ok(resp) => {
                                let err = resp
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("probe failed");
                                let _ = send_cmd(sess, "shutdown", None);
                                return Err(format!(
                                    "Existing helper cannot open WinDivert: {err}. {}",
                                    windivert_missing_hint(&app)
                                ));
                            }
                            Err(e) => {
                                let _ = send_cmd(sess, "shutdown", None);
                                return Err(format!("Helper probe failed: {e}"));
                            }
                        }
                    }
                }
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
        let helper = resolve_helper_exe(&app)?;
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
        let Some(wd) = resolve_windivert_dir(&app) else {
            return Err(windivert_missing_hint(&app));
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
            let _ = std::fs::remove_file(&sess.ready_file);
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
                return Err(format!(
                    "Elevated helper started but WinDivert failed: {err}. {}",
                    windivert_missing_hint(&app)
                ));
            }
            Err(e) => {
                let _ = send_cmd(&sess, "shutdown", None);
                return Err(format!("WinDivert probe error: {e}"));
            }
        }

        if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
            *guard = Some(sess);
        }
        Ok(st)
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
        let _ = std::fs::remove_file(&sess.ready_file);
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

pub fn lookup_orig(sess: &HelperSession, src_port: u16) -> Result<OrigMapping, String> {
    lookup_orig_key(sess, "", src_port)
}

pub fn lookup_orig_key(
    sess: &HelperSession,
    src_ip: &str,
    src_port: u16,
) -> Result<OrigMapping, String> {
    let mut body = json!({
        "cmd": "lookup_orig",
        "srcPort": src_port,
    });
    if !src_ip.is_empty() {
        body["srcIp"] = json!(src_ip);
    }
    let result = expect_ok(send_json(sess, body)?)?;
    Ok(OrigMapping {
        dst_ip: result
            .get("dstIp")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0.0")
            .to_string(),
        dst_port: result
            .get("dstPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u16,
        pid: result.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        path: result
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Ensure helper is running (elevate via UAC if needed). Returns current status.
pub async fn ensure_helper(app: &AppHandle, state: &State<'_, AppState>) -> Result<HelperStatus, String> {
    sockscap_helper_start(app.clone(), state.clone()).await
}
