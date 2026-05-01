pub mod pty;
pub mod ssh;

use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::Sig;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub enum ActiveTerminal {
    Local {
        writer: Mutex<Box<dyn Write + Send>>,
        master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
        #[allow(dead_code)]
        child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    },
    Ssh {
        channel: tokio::sync::Mutex<russh::Channel<russh::client::Msg>>,
        #[allow(dead_code)]
        handle: Mutex<russh::client::Handle<ssh::SshHandler>>,
    },
}

unsafe impl Send for ActiveTerminal {}
unsafe impl Sync for ActiveTerminal {}

#[tauri::command]
pub fn list_local_shells() -> Vec<pty::LocalShellOption> {
    pty::list_local_shells()
}

#[tauri::command]
pub fn open_local_shell_as_administrator(shell: Option<String>) -> Result<(), String> {
    pty::open_shell_as_administrator(shell)
}

#[tauri::command]
pub async fn create_local_terminal(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let (handle, reader) = pty::create_pty(cols, rows, shell, cwd)?;

    let terminal = ActiveTerminal::Local {
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminals.write().await;
        terminals.insert(session_id.clone(), terminal);
    }

    let sid = session_id.clone();
    let app = app_handle.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, &sid, &app);
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn create_ssh_terminal(
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let auth = match auth_method.as_str() {
        "Password" => ssh::SshAuth::Password(auth_data.unwrap_or_default()),
        "PrivateKey" => ssh::SshAuth::PrivateKey(
            auth_data.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string()),
        ),
        "Agent" => ssh::SshAuth::Agent,
        _ => ssh::SshAuth::Password(auth_data.unwrap_or_default()),
    };

    let (handle, channel, mut output_rx) =
        ssh::connect_ssh(&host, port, &username, auth, cols, rows).await?;

    let terminal = ActiveTerminal::Ssh {
        channel: tokio::sync::Mutex::new(channel),
        handle: Mutex::new(handle),
    };

    {
        let mut terminals = state.terminals.write().await;
        terminals.insert(session_id.clone(), terminal);
    }

    let sid = session_id.clone();
    let app = app_handle.clone();
    tokio::spawn(async move {
        let event_name = format!("terminal-output-{}", sid);
        while let Some(data) = output_rx.recv().await {
            let encoded = B64.encode(&data);
            let _ = app.emit(&event_name, encoded);
        }
        let _ = app.emit(&format!("terminal-exit-{}", sid), "closed");
    });

    Ok(session_id)
}

fn read_loop_local(mut reader: Box<dyn Read + Send>, session_id: &str, app: &AppHandle) {
    let event_name = format!("terminal-output-{}", session_id);
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let encoded = B64.encode(&buf[..n]);
                let _ = app.emit(&event_name, encoded);
            }
            Err(_) => break,
        }
    }
    let _ = app.emit(&format!("terminal-exit-{}", session_id), "closed");
}

#[tauri::command]
pub async fn write_terminal(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bytes = B64
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let terminals = state.terminals.read().await;
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { writer, .. } => {
            let mut w = writer.lock().map_err(|e| format!("Lock failed: {}", e))?;
            w.write_all(&bytes).map_err(|e| format!("Write failed: {}", e))?;
            w.flush().map_err(|e| format!("Flush failed: {}", e))?;
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let ch = channel.lock().await;
            ch.data(&bytes[..])
                .await
                .map_err(|e| format!("SSH write failed: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminals = state.terminals.read().await;
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { master, .. } => {
            let m = master.lock().map_err(|e| format!("Lock failed: {}", e))?;
            pty::resize_pty(&**m, cols, rows)
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let ch = channel.lock().await;
            ch.window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|e| format!("SSH resize failed: {}", e))?;
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn send_terminal_signal(
    session_id: String,
    signal: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminals = state.terminals.read().await;
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { child, .. } => {
            send_local_signal(child, &signal)
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let sig = ssh_signal_from_name(&signal)?;
            let ch = channel.lock().await;
            ch.signal(sig)
                .await
                .map_err(|e| format!("SSH signal failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn close_terminal(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut terminals = state.terminals.write().await;
    terminals.remove(&session_id);
    Ok(())
}

#[cfg(unix)]
fn send_local_signal(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    signal: &str,
) -> Result<(), String> {
    let sig = match signal {
        "SIGINT" => libc::SIGINT,
        "SIGTERM" => libc::SIGTERM,
        "SIGKILL" => libc::SIGKILL,
        "SIGQUIT" => libc::SIGQUIT,
        "SIGHUP" => libc::SIGHUP,
        _ => return Err(format!("Unsupported local signal {}", signal)),
    };
    let child = child.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let pid = child
        .process_id()
        .ok_or_else(|| "Local terminal process id is unavailable".to_string())?;
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!(
            "Local signal {} failed: {}",
            signal,
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
fn send_local_signal(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    signal: &str,
) -> Result<(), String> {
    match signal {
        "SIGTERM" | "SIGKILL" => {
            let mut child = child.lock().map_err(|e| format!("Lock failed: {}", e))?;
            child.kill().map_err(|e| format!("Local kill failed: {}", e))
        }
        _ => Err(format!("Local signal {} is not supported on this platform", signal)),
    }
}

fn ssh_signal_from_name(signal: &str) -> Result<Sig, String> {
    match signal {
        "SIGINT" => Ok(Sig::INT),
        "SIGTERM" => Ok(Sig::TERM),
        "SIGKILL" => Ok(Sig::KILL),
        "SIGQUIT" => Ok(Sig::QUIT),
        "SIGHUP" => Ok(Sig::HUP),
        _ => Err(format!("Unsupported SSH signal {}", signal)),
    }
}

#[tauri::command]
pub async fn test_ssh_connection(
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
) -> Result<String, String> {
    let auth = match auth_method.as_str() {
        "Password" => ssh::SshAuth::Password(auth_data.unwrap_or_default()),
        "PrivateKey" => ssh::SshAuth::PrivateKey(
            auth_data.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string()),
        ),
        "Agent" => ssh::SshAuth::Agent,
        _ => ssh::SshAuth::Password(auth_data.unwrap_or_default()),
    };

    let start = std::time::Instant::now();
    let (handle, channel, _rx) = ssh::connect_ssh(&host, port, &username, auth, 80, 24).await?;
    let elapsed = start.elapsed();

    // Close the test connection
    drop(channel);
    drop(handle);

    Ok(format!("Connection successful ({:.0}ms)", elapsed.as_millis()))
}
