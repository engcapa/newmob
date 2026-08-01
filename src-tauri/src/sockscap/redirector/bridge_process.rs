//! Standalone macOS Redirector bridge process mode.
//!
//! The bridge is launched from the signed Taomni executable with a private CLI
//! flag. It owns Redirector's control socket and survives long enough to send an
//! inert scope when the UI/backend process disappears. Flow byte streams are
//! forwarded to a separate Unix listener owned by the main process.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::bridge_protocol::{
    BRIDGE_PROTOCOL_VERSION, BridgeCommand, BridgeEvent, MAX_MANAGEMENT_LINE, decode_line,
    encode_line,
};
use super::ipc::send_intercept_config;
use super::scope::inert_actions;
use super::{redirector_peer_pid, verify_redirector_peer};

const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_CHECK: Duration = Duration::from_secs(1);
const DISABLE_DRAIN: Duration = Duration::from_millis(300);

struct Options {
    provider_socket: PathBuf,
    flow_socket: PathBuf,
    redirector: PathBuf,
    parent_pid: u32,
}

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn run_from_cli() -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("sockscap bridge: create runtime: {error}");
            return 1;
        }
    };
    match runtime.block_on(run()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("sockscap bridge: {error}");
            1
        }
    }
}

async fn run() -> Result<(), String> {
    let options = parse_options()?;
    validate_socket_path(&options.provider_socket, "provider")?;
    validate_socket_path(&options.flow_socket, "flow")?;
    if !options.redirector.is_file() {
        return Err(format!(
            "Redirector executable is missing: {}",
            options.redirector.display()
        ));
    }
    if options.provider_socket.exists() {
        return Err(format!(
            "refusing to replace existing provider socket path {}",
            options.provider_socket.display()
        ));
    }

    let listener = UnixListener::bind(&options.provider_socket).map_err(|error| {
        format!(
            "bind provider socket {}: {error}",
            options.provider_socket.display()
        )
    })?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        &options.provider_socket,
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|error| format!("secure provider socket: {error}"))?;
    let _cleanup = SocketCleanup(options.provider_socket.clone());

    let mut launcher = Command::new(&options.redirector)
        .arg(&options.provider_socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            format!(
                "launch signed Redirector {}: {error}",
                options.redirector.display()
            )
        })?;

    let (mut control, provider_pid) =
        accept_verified_control(&listener, CONTROL_CONNECT_TIMEOUT).await?;
    tokio::spawn(async move {
        match launcher.wait().await {
            Ok(status) if status.success() => {
                eprintln!("sockscap bridge: Redirector launcher exited successfully")
            }
            Ok(status) => eprintln!("sockscap bridge: Redirector launcher exited with {status}"),
            Err(error) => eprintln!("sockscap bridge: Redirector launcher wait failed: {error}"),
        }
    });

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut input = BufReader::new(stdin);
    let mut output = BufWriter::new(stdout);
    write_event(
        &mut output,
        &BridgeEvent::ControlReady {
            version: BRIDGE_PROTOCOL_VERSION,
            provider_pid,
        },
    )
    .await?;

    let mut terminate = signal(SignalKind::terminate())
        .map_err(|error| format!("install SIGTERM handler: {error}"))?;
    let mut interrupt = signal(SignalKind::interrupt())
        .map_err(|error| format!("install SIGINT handler: {error}"))?;
    let mut hangup =
        signal(SignalKind::hangup()).map_err(|error| format!("install SIGHUP handler: {error}"))?;
    let mut heartbeat = tokio::time::interval(HEARTBEAT_CHECK);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_management = Instant::now();
    let mut session_id: Option<String> = None;
    let mut generation = 0u64;
    let mut stop_request_id = 0u64;
    let mut active = false;
    let mut flows = JoinSet::new();
    let mut stop_reason = "management stop".to_string();

    loop {
        let mut line = String::new();
        tokio::select! {
            read = read_management_line(&mut input, &mut line) => {
                let size = read.map_err(|error| format!("read management command: {error}"))?;
                if size == 0 {
                    stop_reason = "parent management pipe closed".into();
                    break;
                }
                last_management = Instant::now();
                let command: BridgeCommand = match decode_line(&line) {
                    Ok(command) => command,
                    Err(error) => {
                        write_error(&mut output, None, format!("invalid management command: {error}")).await?;
                        stop_reason = "invalid management command".into();
                        break;
                    }
                };
                if command.version() != BRIDGE_PROTOCOL_VERSION {
                    write_error(
                        &mut output,
                        None,
                        format!(
                            "management protocol version {} is unsupported (expected {BRIDGE_PROTOCOL_VERSION})",
                            command.version()
                        ),
                    )
                    .await?;
                    stop_reason = "protocol version mismatch".into();
                    break;
                }
                match command {
                    BridgeCommand::Apply { request_id, session_id: requested, generation: requested_generation, actions, .. } => {
                        if active || requested.trim().is_empty() || requested_generation == 0 {
                            write_error(&mut output, Some(request_id), "duplicate, empty, or zero-generation bridge session".into()).await?;
                            stop_reason = "invalid Apply command".into();
                            break;
                        }
                        send_intercept_config(&mut control, &actions)
                            .await
                            .map_err(|error| format!("apply Redirector scope: {error}"))?;
                        session_id = Some(requested.clone());
                        generation = requested_generation;
                        active = true;
                        write_event(
                            &mut output,
                            &BridgeEvent::Applied {
                                version: BRIDGE_PROTOCOL_VERSION,
                                request_id,
                                session_id: requested,
                                generation,
                            },
                        )
                        .await?;
                    }
                    BridgeCommand::Ping { request_id, session_id: requested, generation: requested_generation, .. } => {
                        if session_id.as_deref() != Some(requested.as_str()) || generation != requested_generation {
                            write_error(&mut output, Some(request_id), "heartbeat session/generation mismatch".into()).await?;
                            stop_reason = "heartbeat session mismatch".into();
                            break;
                        }
                        write_event(
                            &mut output,
                            &BridgeEvent::Pong {
                                version: BRIDGE_PROTOCOL_VERSION,
                                request_id,
                                session_id: requested,
                                generation,
                            },
                        )
                        .await?;
                    }
                    BridgeCommand::Stop { request_id, session_id: requested, generation: requested_generation, .. } => {
                        stop_request_id = request_id;
                        if session_id.as_deref() != Some(requested.as_str()) || generation != requested_generation {
                            write_error(&mut output, Some(request_id), "stop session/generation mismatch".into()).await?;
                            stop_reason = "stop session/generation mismatch".into();
                        }
                        break;
                    }
                }
            }
            accepted = listener.accept(), if active => {
                let (provider_flow, _) = accepted
                    .map_err(|error| format!("accept Redirector flow: {error}"))?;
                let flow_pid = match redirector_peer_pid(&provider_flow) {
                    Ok(pid) if pid == provider_pid => pid,
                    Ok(pid) => {
                        eprintln!(
                            "sockscap bridge: rejected flow from Redirector pid {pid}; control pid is {provider_pid}"
                        );
                        continue;
                    }
                    Err(error) => {
                        eprintln!("sockscap bridge: rejected unverified flow peer: {error}");
                        continue;
                    }
                };
                let flow_socket = options.flow_socket.clone();
                let parent_pid = options.parent_pid;
                flows.spawn(async move {
                    proxy_flow(provider_flow, &flow_socket, flow_pid, parent_pid).await
                });
            }
            ready = control.readable(), if active => {
                ready.map_err(|error| format!("monitor Redirector control channel: {error}"))?;
                let mut unexpected = [0u8; 1];
                match control.try_read(&mut unexpected) {
                    Ok(0) => {
                        stop_reason = "Redirector Provider closed the control channel".into();
                        break;
                    }
                    Ok(_) => {
                        stop_reason = "Redirector Provider sent unexpected control data".into();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => {
                        stop_reason = format!("Redirector control channel failed: {error}");
                        break;
                    }
                }
            }
            _ = terminate.recv() => {
                stop_reason = "SIGTERM".into();
                break;
            }
            _ = interrupt.recv() => {
                stop_reason = "SIGINT".into();
                break;
            }
            _ = hangup.recv() => {
                stop_reason = "SIGHUP".into();
                break;
            }
            _ = heartbeat.tick(), if active => {
                if !process_exists(options.parent_pid) {
                    stop_reason = format!("parent pid {} exited", options.parent_pid);
                    break;
                }
                if last_management.elapsed() >= HEARTBEAT_TIMEOUT {
                    stop_reason = format!(
                        "management heartbeat timed out after {}s",
                        HEARTBEAT_TIMEOUT.as_secs()
                    );
                    break;
                }
            }
            joined = flows.join_next(), if !flows.is_empty() => {
                if let Some(Err(error)) = joined {
                    eprintln!("sockscap bridge: flow forwarding task failed: {error}");
                }
            }
        }
    }

    eprintln!("sockscap bridge: disabling interception ({stop_reason})");
    let disable_result = send_intercept_config(&mut control, &inert_actions())
        .await
        .map_err(|error| format!("disable Redirector interception: {error}"));
    tokio::time::sleep(DISABLE_DRAIN).await;
    let _ = control.shutdown().await;
    flows.shutdown().await;

    if let Err(error) = disable_result {
        let _ = write_error(&mut output, Some(stop_request_id), error.clone()).await;
        return Err(error);
    }
    write_event(
        &mut output,
        &BridgeEvent::Stopped {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: stop_request_id,
            session_id: session_id.unwrap_or_default(),
            generation,
        },
    )
    .await
}

async fn accept_verified_control(
    listener: &UnixListener,
    timeout: Duration,
) -> Result<(UnixStream, u32), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out waiting for a verified Redirector control channel".into());
        }
        let (stream, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| {
                "timed out waiting for Mitmproxy Redirector; approve its System Extension and network configuration in System Settings, then retry"
                    .to_string()
            })?
            .map_err(|error| format!("accept Redirector control channel: {error}"))?;
        match verify_redirector_peer(&stream) {
            Ok(pid) => return Ok((stream, pid)),
            Err(error) => {
                eprintln!("sockscap bridge: rejected unverified control peer: {error}");
            }
        }
    }
}

async fn proxy_flow(
    mut provider_flow: UnixStream,
    flow_socket: &Path,
    provider_pid: u32,
    parent_pid: u32,
) -> Result<(), String> {
    let mut app_flow = UnixStream::connect(flow_socket).await.map_err(|error| {
        format!(
            "connect Taomni flow socket {} for provider pid {provider_pid}: {error}",
            flow_socket.display()
        )
    })?;
    let peer_pid = redirector_peer_pid(&app_flow)?;
    if peer_pid != parent_pid {
        return Err(format!(
            "Taomni flow socket peer pid {peer_pid} does not match parent pid {parent_pid}"
        ));
    }
    tokio::io::copy_bidirectional(&mut provider_flow, &mut app_flow)
        .await
        .map(|_| ())
        .map_err(|error| format!("forward Redirector flow: {error}"))
}

async fn read_management_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut String,
) -> Result<usize, std::io::Error> {
    let size = (&mut *reader)
        .take((MAX_MANAGEMENT_LINE + 1) as u64)
        .read_line(line)
        .await?;
    if size > MAX_MANAGEMENT_LINE || (size > 0 && !line.ends_with('\n')) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Redirector bridge command exceeds {MAX_MANAGEMENT_LINE} bytes or is unterminated"
            ),
        ));
    }
    Ok(size)
}

async fn write_event<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    event: &BridgeEvent,
) -> Result<(), String> {
    output
        .write_all(encode_line(event)?.as_bytes())
        .await
        .map_err(|error| format!("write bridge event: {error}"))?;
    output
        .flush()
        .await
        .map_err(|error| format!("flush bridge event: {error}"))
}

async fn write_error<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    request_id: Option<u64>,
    message: String,
) -> Result<(), String> {
    write_event(
        output,
        &BridgeEvent::Error {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id,
            message,
        },
    )
    .await
}

fn parse_options() -> Result<Options, String> {
    let mut args = std::env::args().skip(2);
    let mut provider_socket = None;
    let mut flow_socket = None;
    let mut redirector = None;
    let mut parent_pid = None;
    while let Some(arg) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {arg}"))?;
        match arg.as_str() {
            "--provider-socket" => provider_socket = Some(PathBuf::from(value)),
            "--flow-socket" => flow_socket = Some(PathBuf::from(value)),
            "--redirector" => redirector = Some(PathBuf::from(value)),
            "--parent-pid" => {
                parent_pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| format!("invalid parent pid {value:?}"))?,
                )
            }
            _ => return Err(format!("unknown bridge option {arg:?}")),
        }
    }
    Ok(Options {
        provider_socket: provider_socket.ok_or("missing --provider-socket")?,
        flow_socket: flow_socket.ok_or("missing --flow-socket")?,
        redirector: redirector.ok_or("missing --redirector")?,
        parent_pid: parent_pid.ok_or("missing --parent-pid")?,
    })
}

fn validate_socket_path(path: &Path, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} socket has no parent"))?;
    if !path.is_absolute() || parent != Path::new("/tmp") {
        return Err(format!(
            "{label} socket must be an absolute child of /tmp: {}",
            path.display()
        ));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !name.starts_with("taomni-redirector-") || !name.ends_with(".sock") {
        return Err(format!("unsafe {label} socket name {name:?}"));
    }
    Ok(())
}

fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_paths_must_be_private_tmp_names() {
        assert!(
            validate_socket_path(
                Path::new("/tmp/taomni-redirector-provider-a.sock"),
                "provider"
            )
            .is_ok()
        );
        assert!(validate_socket_path(Path::new("/tmp/unrelated.sock"), "provider").is_err());
        assert!(
            validate_socket_path(Path::new("/var/tmp/taomni-redirector-x.sock"), "flow").is_err()
        );
    }
}
