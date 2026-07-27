//! SocksCap privileged helper (Windows).
//!
//! Elevated (UAC) process that owns WinDivert handles:
//! - FLOW layer → PID association for TCP 5-tuples
//! - NETWORK layer → IPv4 TCP redirect/NAT toward a loopback relay
//!
//! Control plane: newline JSON on 127.0.0.1 with shared token.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod proc_info;
#[cfg(windows)]
mod windivert;

fn main() {
    #[cfg(windows)]
    {
        windows_main::run();
    }
    #[cfg(not(windows))]
    {
        eprintln!("sockscap-helper is only supported on Windows");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod windows_main {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};

    use serde::{Deserialize, Serialize};
    use serde_json::json;

    use crate::capture::{CaptureEngine, CapturePlan, Endpoint};

    /// Ready-file written at startup; removed on every controlled exit path so
    /// the unelevated app never finds a ready file pointing at a dead helper.
    static READY_FILE: OnceLock<PathBuf> = OnceLock::new();

    /// Remove the ready file (best effort) and terminate the process.
    ///
    /// The helper **must** actually exit rather than merely flipping a flag:
    /// while it lives it keeps `sockscap-helper.exe` and the loaded
    /// `WinDivert.dll` file-locked, which breaks in-place upgrades.
    fn cleanup_and_exit(code: i32) -> ! {
        if let Some(p) = READY_FILE.get() {
            let _ = std::fs::remove_file(p);
        }
        std::process::exit(code);
    }

    #[derive(Debug, Deserialize)]
    struct Request {
        id: u64,
        token: String,
        cmd: String,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        mode: Option<String>,
        #[serde(default, rename = "appPaths")]
        app_paths: Option<Vec<String>>,
        #[serde(default, rename = "bypassCidrs")]
        bypass_cidrs: Option<Vec<String>>,
        #[serde(default, rename = "bypassPids")]
        bypass_pids: Option<Vec<u32>>,
        #[serde(default, rename = "bypassPaths")]
        bypass_paths: Option<Vec<String>>,
        #[serde(default, rename = "bypassEndpoints")]
        bypass_endpoints: Option<Vec<EndpointDto>>,
        #[serde(default, rename = "relayIp")]
        relay_ip: Option<String>,
        #[serde(default, rename = "relayPort")]
        relay_port: Option<u16>,
        #[serde(default, rename = "srcIp")]
        src_ip: Option<String>,
        #[serde(default, rename = "srcPort")]
        src_port: Option<u16>,
    }

    #[derive(Debug, Deserialize)]
    struct EndpointDto {
        ip: String,
        port: u16,
    }

    #[derive(Debug, Serialize)]
    struct Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut token = String::new();
        let mut port: u16 = 0;
        let mut ready_file: Option<PathBuf> = None;
        let mut windivert_dir: Option<PathBuf> = None;
        let mut parent_pid: Option<u32> = None;
        let mut reap_pids: Vec<u32> = Vec::new();

        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--token" => {
                    i += 1;
                    token = args.get(i).cloned().unwrap_or_default();
                }
                "--port" => {
                    i += 1;
                    port = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
                }
                "--ready-file" => {
                    i += 1;
                    ready_file = args.get(i).map(PathBuf::from);
                }
                "--windivert-dir" => {
                    i += 1;
                    windivert_dir = args.get(i).map(PathBuf::from);
                }
                "--parent-pid" => {
                    i += 1;
                    parent_pid = args.get(i).and_then(|s| s.parse().ok());
                }
                "--reap-pids" => {
                    i += 1;
                    reap_pids = args
                        .get(i)
                        .map(|s| {
                            s.split(',')
                                .filter_map(|p| p.trim().parse::<u32>().ok())
                                .collect()
                        })
                        .unwrap_or_default();
                }
                other => eprintln!("unknown arg: {other}"),
            }
            i += 1;
        }

        if token.is_empty() || port == 0 {
            eprintln!("sockscap-helper: --token and --port are required");
            std::process::exit(2);
        }

        // Reap orphaned helpers before touching WinDivert. This process is
        // elevated and the app that launched it is not, so this is the only
        // point in the system where an orphan can actually be terminated: the
        // app's own attempt gets Access Denied. A surviving orphan keeps
        // diverting every outbound packet on the machine toward a relay port
        // that no longer exists, and fights this session for the driver handle.
        reap_orphan_helpers(&reap_pids);

        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("bind 127.0.0.1:{port}: {e}");
                std::process::exit(1);
            }
        };

        if let Some(path) = &ready_file {
            let body = json!({
                "pid": std::process::id(),
                "port": port,
                "elevated": is_elevated(),
                // Recorded so a later launch can tell an orphan (owning app
                // gone) from a helper belonging to a still-running instance.
                "parentPid": parent_pid,
            });
            let _ = std::fs::write(path, body.to_string());
            let _ = READY_FILE.set(path.clone());
        }

        let running = Arc::new(AtomicBool::new(true));
        let token = Arc::new(token);
        let engine = Arc::new(Mutex::new(CaptureEngine::new(windivert_dir)));

        // Parent-death watchdog: if the main Taomni process exits without a
        // clean shutdown RPC (crash, kill, forced logoff), tear down WinDivert
        // and exit so an elevated helper + loaded driver never leak.
        if let Some(ppid) = parent_pid {
            let engine_wd = Arc::clone(&engine);
            std::thread::spawn(move || {
                wait_for_parent_exit(ppid);
                if let Ok(mut eng) = engine_wd.lock() {
                    eng.stop();
                }
                // Parent is gone; nothing left to serve.
                cleanup_and_exit(0);
            });
        }

        while running.load(Ordering::SeqCst) {
            let (stream, _) = match listener.accept() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let running = Arc::clone(&running);
            let token = Arc::clone(&token);
            let engine = Arc::clone(&engine);
            std::thread::spawn(move || handle_client(stream, &token, &engine, &running));
        }

        if let Ok(mut eng) = engine.lock() {
            eng.stop();
        }
        cleanup_and_exit(0);
    }

    fn handle_client(
        stream: TcpStream,
        token: &str,
        engine: &Mutex<CaptureEngine>,
        running: &AtomicBool,
    ) {
        let reader_stream = match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut reader = BufReader::new(reader_stream);
        let mut writer = stream;
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let req: Request = match serde_json::from_str(trimmed) {
                Ok(r) => r,
                Err(e) => {
                    let _ = write_resp(
                        &mut writer,
                        Response {
                            id: 0,
                            ok: false,
                            result: None,
                            error: Some(format!("bad json: {e}")),
                        },
                    );
                    continue;
                }
            };
            if req.token != token {
                let _ = write_resp(
                    &mut writer,
                    Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some("unauthorized".into()),
                    },
                );
                continue;
            }

            let resp = dispatch(&req, engine, running);
            let _ = write_resp(&mut writer, resp);
            if !running.load(Ordering::SeqCst) {
                // A `shutdown` RPC was served. The accept loop is parked inside
                // a blocking `listener.accept()` and would never observe the
                // flag, so terminate here — otherwise the helper lingers,
                // keeping its exe and WinDivert.dll locked against upgrades.
                // Half-close and pause briefly so the caller reads the reply
                // before the socket goes away.
                let _ = writer.flush();
                let _ = writer.shutdown(Shutdown::Write);
                std::thread::sleep(std::time::Duration::from_millis(150));
                cleanup_and_exit(0);
            }
        }
    }

    fn dispatch(req: &Request, engine: &Mutex<CaptureEngine>, running: &AtomicBool) -> Response {
        match req.cmd.as_str() {
            "ping" | "status" => {
                let capt = engine
                    .lock()
                    .ok()
                    .map(|e| e.status_json())
                    .unwrap_or(json!({}));
                Response {
                    id: req.id,
                    ok: true,
                    result: Some(json!({
                        "pong": true,
                        "pid": std::process::id(),
                        "elevated": is_elevated(),
                        "platform": "windows",
                        "capture": capt,
                    })),
                    error: None,
                }
            }
            "windivert_probe" => match engine.lock() {
                Ok(mut eng) => match eng.probe(req.filter.as_deref().unwrap_or("false")) {
                    Ok(v) => Response {
                        id: req.id,
                        ok: true,
                        result: Some(v),
                        error: None,
                    },
                    Err(e) => Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some(e),
                    },
                },
                Err(e) => Response {
                    id: req.id,
                    ok: false,
                    result: None,
                    error: Some(e.to_string()),
                },
            },
            "capture_start" => {
                let plan = CapturePlan {
                    mode_apps: req.mode.as_deref() == Some("apps"),
                    app_paths: req
                        .app_paths
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|p| p.replace('/', "\\").to_ascii_lowercase())
                        .collect(),
                    bypass_cidrs: req.bypass_cidrs.clone().unwrap_or_default(),
                    bypass_pids: {
                        let mut p = req.bypass_pids.clone().unwrap_or_default();
                        p.push(std::process::id());
                        p
                    },
                    bypass_paths: req
                        .bypass_paths
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|p| p.replace('/', "\\").to_ascii_lowercase())
                        .collect(),
                    bypass_endpoints: req
                        .bypass_endpoints
                        .as_ref()
                        .map(|v| {
                            v.iter()
                                .filter_map(|e| {
                                    Some(Endpoint {
                                        ip: e.ip.parse().ok()?,
                                        port: e.port,
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    relay_ip: req
                        .relay_ip
                        .as_deref()
                        .unwrap_or("127.0.0.1")
                        .parse()
                        .unwrap_or(std::net::Ipv4Addr::new(127, 0, 0, 1)),
                    relay_port: req.relay_port.unwrap_or(0),
                };
                if plan.relay_port == 0 {
                    return Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some("relayPort required".into()),
                    };
                }
                match engine.lock() {
                    Ok(mut eng) => match eng.start(plan) {
                        Ok(v) => Response {
                            id: req.id,
                            ok: true,
                            result: Some(v),
                            error: None,
                        },
                        Err(e) => Response {
                            id: req.id,
                            ok: false,
                            result: None,
                            error: Some(e),
                        },
                    },
                    Err(e) => Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            "capture_stop" => match engine.lock() {
                Ok(mut eng) => {
                    eng.stop();
                    Response {
                        id: req.id,
                        ok: true,
                        result: Some(json!({ "stopped": true })),
                        error: None,
                    }
                }
                Err(e) => Response {
                    id: req.id,
                    ok: false,
                    result: None,
                    error: Some(e.to_string()),
                },
            },
            // Hot-update the running plan. Every field is optional; omitted
            // fields are left as they are. Used both to re-point the relay port
            // and to refresh the bypass lists when a bypassed process restarts
            // with a new pid (an xray core respawn, most importantly).
            "capture_update" => {
                if req.relay_port.is_none()
                    && req.bypass_pids.is_none()
                    && req.bypass_paths.is_none()
                {
                    return Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some(
                            "capture_update needs at least one of relayPort, bypassPids, bypassPaths"
                                .into(),
                        ),
                    };
                }
                match engine.lock() {
                    Ok(mut eng) => match eng.update_plan(
                        req.relay_port,
                        req.bypass_pids.clone(),
                        req.bypass_paths.clone(),
                    ) {
                        Ok(v) => Response {
                            id: req.id,
                            ok: true,
                            result: Some(v),
                            error: None,
                        },
                        Err(e) => Response {
                            id: req.id,
                            ok: false,
                            result: None,
                            error: Some(e),
                        },
                    },
                    Err(e) => Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            "lookup_orig" => {
                let src_port = req.src_port.unwrap_or(0);
                let src_ip = req.src_ip.as_deref().unwrap_or("");
                match engine.lock() {
                    Ok(eng) => {
                        let found = if src_ip.is_empty() {
                            eng.lookup_orig(src_port)
                        } else {
                            eng.lookup_orig_ip_port(src_ip, src_port)
                        };
                        match found {
                            Some(v) => Response {
                                id: req.id,
                                ok: true,
                                result: Some(v),
                                error: None,
                            },
                            None => Response {
                                id: req.id,
                                ok: false,
                                result: None,
                                error: Some("no mapping".into()),
                            },
                        }
                    }
                    Err(e) => Response {
                        id: req.id,
                        ok: false,
                        result: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            // Stop capture and mark the helper for termination. The actual
            // `exit` happens in `handle_client` right after this response is
            // written, so the caller always receives an ack.
            "shutdown" => {
                if let Ok(mut eng) = engine.lock() {
                    eng.stop();
                }
                running.store(false, Ordering::SeqCst);
                Response {
                    id: req.id,
                    ok: true,
                    result: Some(json!({ "shuttingDown": true })),
                    error: None,
                }
            }
            other => Response {
                id: req.id,
                ok: false,
                result: None,
                error: Some(format!("unknown cmd: {other}")),
            },
        }
    }

    fn write_resp(w: &mut TcpStream, resp: Response) -> std::io::Result<()> {
        let mut line = serde_json::to_string(&resp)
            .unwrap_or_else(|_| r#"{"id":0,"ok":false,"error":"ser"}"#.into());
        line.push('\n');
        w.write_all(line.as_bytes())?;
        w.flush()
    }

    /// Terminate the given pids, but only those still running *this* image.
    ///
    /// The name check matters: the pids come from ready files that may be
    /// arbitrarily old, and Windows recycles process identifiers.
    fn reap_orphan_helpers(pids: &[u32]) {
        if pids.is_empty() {
            return;
        }
        let own = std::process::id();
        let image = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()))
            .unwrap_or_else(|| "sockscap-helper.exe".to_string());

        for &pid in pids {
            if pid == own {
                continue;
            }
            match crate::proc_info::terminate_if_image(pid, &image) {
                Ok(true) => eprintln!("sockscap-helper: reaped orphan helper pid {pid}"),
                Ok(false) => {}
                Err(e) => eprintln!("sockscap-helper: could not reap pid {pid}: {e}"),
            }
        }
    }

    fn is_elevated() -> bool {
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn IsUserAnAdmin() -> i32;
        }
        unsafe { IsUserAnAdmin() != 0 }
    }

    /// Block until the process `ppid` exits, then return. Uses a wait on the
    /// process handle (no polling / PID-reuse race: the handle refers to the
    /// exact process even if the pid is later recycled). If the handle cannot
    /// be opened (already gone, or access denied), return promptly so the
    /// caller shuts down rather than lingering forever.
    fn wait_for_parent_exit(ppid: u32) {
        use winapi::shared::minwindef::FALSE;
        use winapi::um::handleapi::CloseHandle;
        use winapi::um::processthreadsapi::OpenProcess;
        use winapi::um::synchapi::WaitForSingleObject;
        use winapi::um::winbase::INFINITE;
        use winapi::um::winnt::SYNCHRONIZE;

        unsafe {
            let h = OpenProcess(SYNCHRONIZE, FALSE, ppid);
            if h.is_null() {
                // Parent already gone or not openable — do not hang.
                return;
            }
            let _ = WaitForSingleObject(h, INFINITE);
            CloseHandle(h);
        }
    }
}
