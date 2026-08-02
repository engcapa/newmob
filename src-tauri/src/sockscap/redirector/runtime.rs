//! Runtime bridge for the signed Mitmproxy Redirector app (macOS only).

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter, copy_bidirectional,
};
use tokio::net::{TcpStream, UdpSocket, UnixListener, UnixStream, lookup_host};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{RwLock, oneshot};
use tokio::task::{JoinHandle, JoinSet};

use super::bridge_protocol::{
    BRIDGE_PROTOCOL_VERSION, BridgeCommand, BridgeEvent, MAX_MANAGEMENT_LINE, decode_line,
    encode_line,
};
use super::ipc::{
    Address, NewFlow, TcpFlow, TunnelInfo, UdpFlow, UdpPacket, new_flow, read_optional_frame,
    read_required_frame, write_frame,
};
use super::scope::{ScopeSnapshot, inert_actions};
use super::{REDIRECTOR_APP_PATH, installed_executable_path, redirector_peer_pid};
use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::paths;
use crate::sockscap::relay::{
    CapturedFlow, MAX_ACTIVE_RELAY_FLOWS, RelayContext, handle_captured_stream,
};
use crate::sockscap::rules::dns::extract_ip_answers;

const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const FLOW_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(4);
const CAPTURE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const BRIDGE_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const MAX_PENDING_HEARTBEATS: usize = 3;
const UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const DNS_UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
const UDP_DATAGRAM_RATE_PER_SECOND: u64 = 2_048;
const UDP_DATAGRAM_BURST: u64 = 4_096;
const TARGET_NOFILE_LIMIT: libc::rlim_t = 4_096;
const RESERVED_FILE_DESCRIPTORS: u64 = 128;
const FILE_DESCRIPTORS_PER_FLOW: u64 = 2;
const MIN_RELAY_FLOW_CAPACITY: usize = 32;

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A running Redirector capture session. Stop is explicit because it must send
/// a nonmatching configuration before the control channel is closed.
pub struct RedirectorCaptureHandle {
    stop_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), String>>,
    telemetry: Arc<RuntimeTelemetry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedirectorTelemetrySnapshot {
    pub session_id: String,
    pub scope_hash: String,
    pub bridge_pid: u32,
    pub provider_pid: u32,
    pub bridge_healthy: bool,
    pub started_at: u64,
    pub last_heartbeat_at: Option<u64>,
    pub last_error: Option<String>,
    pub file_descriptor_limit: u64,
    pub flow_capacity: usize,
}

struct RuntimeTelemetry {
    session_id: String,
    scope_hash: String,
    bridge_pid: u32,
    provider_pid: u32,
    bridge_healthy: AtomicBool,
    started_at: u64,
    last_heartbeat_at: AtomicU64,
    last_error: Mutex<Option<String>>,
    file_descriptor_limit: u64,
    flow_capacity: usize,
}

impl RuntimeTelemetry {
    fn snapshot(&self) -> RedirectorTelemetrySnapshot {
        let heartbeat = self.last_heartbeat_at.load(Ordering::Relaxed);
        RedirectorTelemetrySnapshot {
            session_id: self.session_id.clone(),
            scope_hash: self.scope_hash.clone(),
            bridge_pid: self.bridge_pid,
            provider_pid: self.provider_pid,
            bridge_healthy: self.bridge_healthy.load(Ordering::Acquire),
            started_at: self.started_at,
            last_heartbeat_at: (heartbeat > 0).then_some(heartbeat),
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            file_descriptor_limit: self.file_descriptor_limit,
            flow_capacity: self.flow_capacity,
        }
    }

    fn heartbeat(&self) {
        self.last_heartbeat_at.store(now_unix(), Ordering::Relaxed);
    }

    fn failed(&self, error: String) {
        self.bridge_healthy.store(false, Ordering::Release);
        *self
            .last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
    }
}

struct BridgeSession {
    child: Child,
    input: BufWriter<ChildStdin>,
    output: BufReader<ChildStdout>,
    session_id: String,
    provider_pid: u32,
    generation: u64,
    next_request_id: u64,
}

impl RedirectorCaptureHandle {
    pub fn telemetry(&self) -> RedirectorTelemetrySnapshot {
        self.telemetry.snapshot()
    }

    pub async fn stop(mut self) -> Result<(), String> {
        if let Some(stop) = self.stop_tx.take() {
            let _ = stop.send(());
        }
        let mut task = self.task;
        match tokio::time::timeout(CAPTURE_STOP_TIMEOUT, &mut task).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(format!("Redirector bridge task failed: {error}")),
            Err(_) => {
                task.abort();
                let _ = task.await;
                Err(format!(
                    "Redirector bridge did not disable capture within {}s",
                    CAPTURE_STOP_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

pub async fn start(
    app: &tauri::AppHandle,
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
    session_id: &str,
) -> Result<RedirectorCaptureHandle, String> {
    preflight(config)?;
    let file_descriptor_limit = prepare_file_descriptor_budget()?;
    let flow_capacity = relay_flow_capacity(file_descriptor_limit);

    let executable = installed_executable_path();
    let mut exclusions = vec![
        std::env::current_exe().map_err(|error| format!("resolve Taomni executable: {error}"))?,
        PathBuf::from(REDIRECTOR_APP_PATH),
    ];
    if let Some(xray) = paths::resolve_xray_exe(app) {
        exclusions.push(xray);
    }
    let scope = Arc::new(ScopeSnapshot::compile(config, exclusions)?);

    let flow_socket_path = random_socket_path("flow");
    let provider_socket_path = random_socket_path("provider");
    let listener = bind_private_listener(&flow_socket_path)?;
    let cleanup = SocketCleanup(flow_socket_path.clone());
    let bridge = launch_bridge(
        &executable,
        &provider_socket_path,
        &flow_socket_path,
        scope.actions(),
        session_id,
    )
    .await?;
    let telemetry = Arc::new(RuntimeTelemetry {
        session_id: session_id.to_string(),
        scope_hash: scope.scope_hash(),
        bridge_pid: bridge.child.id().unwrap_or_default(),
        provider_pid: bridge.provider_pid,
        bridge_healthy: AtomicBool::new(true),
        started_at: now_unix(),
        last_heartbeat_at: AtomicU64::new(now_unix()),
        last_error: Mutex::new(None),
        file_descriptor_limit,
        flow_capacity,
    });

    tracing::info!(
        actions = scope.actions().len(),
        block_quic = config.block_quic,
        provider_pid = bridge.provider_pid,
        provider_socket = %provider_socket_path.display(),
        flow_socket = %flow_socket_path.display(),
        file_descriptor_limit,
        flow_capacity,
        "sockscap: isolated Redirector bridge active"
    );

    let (stop_tx, stop_rx) = oneshot::channel();
    let block_quic = config.block_quic;
    let task_telemetry = Arc::clone(&telemetry);
    let task = tokio::spawn(async move {
        let result = run_capture(
            listener,
            bridge,
            scope,
            block_quic,
            flow_capacity,
            ctx,
            stop_rx,
            cleanup,
            Arc::clone(&task_telemetry),
        )
        .await;
        if let Err(error) = &result {
            task_telemetry.failed(error.clone());
        }
        result
    });

    Ok(RedirectorCaptureHandle {
        stop_tx: Some(stop_tx),
        task,
        telemetry,
    })
}

/// Reacquire Redirector control after an unclean shutdown and replace any
/// residual process scope with a fresh inert sentinel. No business scope or
/// relay context is constructed on this path.
pub async fn recover() -> Result<(), String> {
    super::verify_installed()?;
    let flow_socket_path = random_socket_path("recovery-flow");
    let provider_socket_path = random_socket_path("recovery-provider");
    let listener = bind_private_listener(&flow_socket_path)?;
    let cleanup = SocketCleanup(flow_socket_path.clone());
    let mut bridge = launch_bridge(
        &installed_executable_path(),
        &provider_socket_path,
        &flow_socket_path,
        &inert_actions(),
        &uuid::Uuid::new_v4().to_string(),
    )
    .await?;
    stop_bridge(&mut bridge).await?;
    drop(listener);
    drop(cleanup);
    verify_direct_connectivity_after_recovery().await?;
    tracing::info!(
        provider_pid = bridge.provider_pid,
        "sockscap: Redirector recovery inert scope applied"
    );
    Ok(())
}

async fn verify_direct_connectivity_after_recovery() -> Result<(), String> {
    let targets = recovery_probe_targets()?;
    let mut errors = Vec::new();
    for target in targets {
        let status = tokio::time::timeout(
            Duration::from_secs(8),
            Command::new("/usr/bin/nc")
                .args(["-z", "-G", "5", "-w", "5"])
                .arg(target.ip().to_string())
                .arg(target.port().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output(),
        )
        .await;
        match status {
            Ok(Ok(output)) if output.status.success() => {
                tracing::info!(%target, probe = "/usr/bin/nc", "sockscap: post-recovery direct TCP probe succeeded");
                return Ok(());
            }
            Ok(Ok(output)) => errors.push(format!(
                "{target}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Ok(Err(error)) => errors.push(format!("{target}: launch /usr/bin/nc: {error}")),
            Err(_) => errors.push(format!("{target}: probe timed out")),
        }
    }
    Err(format!(
        "Redirector inert scope was sent, but an independent /usr/bin/nc process could not prove ordinary TCP connectivity ({}). The recovery journal remains dirty. Check the network, set SOCKSCAP_RECOVERY_PROBE_ADDR to a reachable IP:port, retry Recover, or use the manual macOS recovery steps",
        errors.join("; ")
    ))
}

fn recovery_probe_targets() -> Result<Vec<SocketAddr>, String> {
    let configured = std::env::var("SOCKSCAP_RECOVERY_PROBE_ADDR")
        .unwrap_or_else(|_| "1.1.1.1:443,8.8.8.8:443".into());
    parse_recovery_probe_targets(&configured)
}

fn parse_recovery_probe_targets(configured: &str) -> Result<Vec<SocketAddr>, String> {
    let targets = configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value.parse::<SocketAddr>().map_err(|_| {
                format!(
                    "invalid SOCKSCAP_RECOVERY_PROBE_ADDR target {value:?}; expected numeric IP:port"
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if targets.is_empty() {
        return Err("SOCKSCAP_RECOVERY_PROBE_ADDR has no targets".into());
    }
    Ok(targets)
}

/// Validate all fail-fast gates before building upstream pools/sidecars.
pub fn preflight(config: &SocksCapConfig) -> Result<(), String> {
    let _ = config;
    super::verify_installed()
        .map_err(|error| format!("{error}; no system-proxy fallback is available"))?;
    prepare_file_descriptor_budget()?;
    Ok(())
}

/// Raise launchd's conservative per-process soft limit before global capture.
/// A macOS GUI app commonly starts at 256 descriptors, while every active flow
/// needs one Redirector IPC socket and one egress socket in addition to the
/// desktop app's normal files, terminals, and database handles.
fn prepare_file_descriptor_budget() -> Result<u64, String> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(format!(
            "read macOS file descriptor limit: {}",
            std::io::Error::last_os_error()
        ));
    }
    let desired = TARGET_NOFILE_LIMIT.min(limit.rlim_max);
    if limit.rlim_cur < desired {
        let raised = libc::rlimit {
            rlim_cur: desired,
            rlim_max: limit.rlim_max,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } != 0 {
            return Err(format!(
                "raise macOS file descriptor limit from {} to {desired}: {}",
                limit.rlim_cur,
                std::io::Error::last_os_error()
            ));
        }
        limit.rlim_cur = desired;
    }
    Ok(limit.rlim_cur)
}

fn relay_flow_capacity(file_descriptor_limit: u64) -> usize {
    let descriptor_capacity =
        file_descriptor_limit.saturating_sub(RESERVED_FILE_DESCRIPTORS) / FILE_DESCRIPTORS_PER_FLOW;
    usize::try_from(descriptor_capacity)
        .unwrap_or(MAX_ACTIVE_RELAY_FLOWS)
        .clamp(MIN_RELAY_FLOW_CAPACITY, MAX_ACTIVE_RELAY_FLOWS)
}

async fn run_capture(
    listener: UnixListener,
    mut bridge: BridgeSession,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    flow_capacity: usize,
    ctx: Arc<RwLock<RelayContext>>,
    mut stop_rx: oneshot::Receiver<()>,
    _cleanup: SocketCleanup,
    telemetry: Arc<RuntimeTelemetry>,
) -> Result<(), String> {
    let mut flows = JoinSet::new();
    let limiter = Arc::new(tokio::sync::Semaphore::new(flow_capacity));
    let stats = Arc::clone(&ctx.read().await.stats);
    let mut accept_error = None;
    let mut pending_heartbeats = BTreeSet::new();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        while let Some(result) = flows.try_join_next() {
            if let Err(error) = result {
                tracing::warn!("sockscap: Redirector flow task failed: {error}");
            }
        }
        tokio::select! {
            _ = &mut stop_rx => break,
            _ = heartbeat.tick() => {
                if pending_heartbeats.len() >= MAX_PENDING_HEARTBEATS {
                    accept_error = Some(format!(
                        "Redirector bridge missed {} consecutive heartbeat responses",
                        pending_heartbeats.len()
                    ));
                    break;
                }
                let request_id = bridge.next_request_id;
                bridge.next_request_id = bridge.next_request_id.saturating_add(1);
                if let Err(error) = write_bridge_command(
                    &mut bridge.input,
                    &BridgeCommand::Ping {
                        version: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        session_id: bridge.session_id.clone(),
                        generation: bridge.generation,
                    },
                )
                .await
                {
                    accept_error = Some(format!("Redirector bridge heartbeat failed: {error}"));
                    break;
                }
                pending_heartbeats.insert(request_id);
            }
            event = read_bridge_event(&mut bridge.output) => {
                match event {
                    Ok(BridgeEvent::Pong { version, request_id, session_id, generation })
                        if version == BRIDGE_PROTOCOL_VERSION
                            && session_id == bridge.session_id
                            && generation == bridge.generation
                            && pending_heartbeats.remove(&request_id) => {
                            telemetry.heartbeat();
                        }
                    Ok(BridgeEvent::Error { message, .. }) => {
                        accept_error = Some(format!("Redirector bridge failed: {message}"));
                        break;
                    }
                    Ok(BridgeEvent::Stopped { .. }) => {
                        accept_error = Some("Redirector bridge stopped unexpectedly".into());
                        break;
                    }
                    Ok(other) => {
                        accept_error = Some(format!("unexpected Redirector bridge event: {other:?}"));
                        break;
                    }
                    Err(error) => {
                        accept_error = Some(format!("Redirector bridge event channel failed: {error}"));
                        break;
                    }
                }
            }
            accepted = accept_with_capacity(&listener, Arc::clone(&limiter)) => {
                let (stream, permit) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        accept_error = Some(error);
                        break;
                    }
                };
                match redirector_peer_pid(&stream) {
                    Ok(pid) if pid == telemetry.bridge_pid => {}
                    Ok(pid) => {
                        tracing::warn!(
                            pid,
                            expected_pid = telemetry.bridge_pid,
                            "sockscap: rejected flow socket from an unexpected process"
                        );
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!("sockscap: rejected unauthenticated bridge flow: {error}");
                        continue;
                    }
                }
                let scope = Arc::clone(&scope);
                let ctx = Arc::clone(&ctx);
                let flow_stats = Arc::clone(&stats);
                flows.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = serve_flow(stream, scope, block_quic, ctx).await {
                        flow_stats.record_flow_failure();
                        tracing::warn!("sockscap: Redirector flow failed: {error}");
                    }
                });
            }
        }
    }

    let disable_result = stop_bridge(&mut bridge).await;
    flows.shutdown().await;

    disable_result?;
    if let Some(error) = accept_error {
        return Err(error);
    }
    tracing::info!("sockscap: Redirector bridge disabled interception with inert scope");
    Ok(())
}

/// Apply backpressure at the Unix listener instead of accepting and then
/// refusing excess flows. Redirector can keep the connection in its socket
/// backlog briefly while an existing browser flow releases a permit.
async fn accept_with_capacity(
    listener: &UnixListener,
    limiter: Arc<tokio::sync::Semaphore>,
) -> Result<(UnixStream, tokio::sync::OwnedSemaphorePermit), String> {
    let permit = limiter
        .acquire_owned()
        .await
        .map_err(|_| "Redirector flow limiter closed".to_string())?;
    let (stream, _) = listener
        .accept()
        .await
        .map_err(|error| format!("accept Redirector flow: {error}"))?;
    Ok((stream, permit))
}

fn random_socket_path(label: &str) -> PathBuf {
    PathBuf::from(format!(
        "/tmp/taomni-redirector-{label}-{}.sock",
        uuid::Uuid::new_v4().simple()
    ))
}

fn bind_private_listener(path: &PathBuf) -> Result<UnixListener, String> {
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("bind Redirector IPC {}: {error}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("secure Redirector IPC {}: {error}", path.display()))?;
    Ok(listener)
}

async fn launch_bridge(
    redirector: &std::path::Path,
    provider_socket: &std::path::Path,
    flow_socket: &std::path::Path,
    actions: &[String],
    session_id: &str,
) -> Result<BridgeSession, String> {
    if actions.is_empty() {
        return Err("Redirector bridge actions must not be empty".into());
    }
    if session_id.trim().is_empty() {
        return Err("Redirector bridge session id must not be empty".into());
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve Taomni bridge executable: {error}"))?;
    let mut child = Command::new(&executable)
        .arg("--sockscap-redirector-bridge")
        .arg("--provider-socket")
        .arg(provider_socket)
        .arg("--flow-socket")
        .arg(flow_socket)
        .arg("--redirector")
        .arg(redirector)
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(false)
        .spawn()
        .map_err(|error| format!("launch isolated Redirector bridge: {error}"))?;
    let Some(stdin) = child.stdin.take() else {
        terminate_bridge_child(&mut child).await;
        return Err("Redirector bridge stdin is unavailable".into());
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_bridge_child(&mut child).await;
        return Err("Redirector bridge stdout is unavailable".into());
    };
    let mut input = BufWriter::new(stdin);
    let mut output = BufReader::new(stdout);

    let ready =
        match tokio::time::timeout(CONTROL_CONNECT_TIMEOUT, read_bridge_event(&mut output)).await {
            Ok(Ok(event)) => event,
            Ok(Err(error)) => {
                terminate_bridge_child(&mut child).await;
                return Err(error);
            }
            Err(_) => {
                terminate_bridge_child(&mut child).await;
                return Err("timed out waiting for Redirector bridge control readiness".into());
            }
        };
    let provider_pid = match ready {
        BridgeEvent::ControlReady {
            version,
            provider_pid,
        } if version == BRIDGE_PROTOCOL_VERSION => provider_pid,
        BridgeEvent::Error { message, .. } => {
            terminate_bridge_child(&mut child).await;
            return Err(message);
        }
        event => {
            terminate_bridge_child(&mut child).await;
            return Err(format!(
                "unexpected Redirector bridge readiness event: {event:?}"
            ));
        }
    };

    let session_id = session_id.to_string();
    if let Err(error) = write_bridge_command(
        &mut input,
        &BridgeCommand::Apply {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: 1,
            session_id: session_id.clone(),
            generation: 1,
            actions: actions.to_vec(),
        },
    )
    .await
    {
        terminate_bridge_child(&mut child).await;
        return Err(error);
    }
    let applied = match tokio::time::timeout(STOP_TIMEOUT, read_bridge_event(&mut output)).await {
        Ok(Ok(event)) => event,
        Ok(Err(error)) => {
            terminate_bridge_child(&mut child).await;
            return Err(error);
        }
        Err(_) => {
            terminate_bridge_child(&mut child).await;
            return Err("timed out waiting for Redirector bridge scope apply".into());
        }
    };
    match applied {
        BridgeEvent::Applied {
            version,
            request_id,
            session_id: applied_session,
            generation,
        } if version == BRIDGE_PROTOCOL_VERSION
            && request_id == 1
            && applied_session == session_id
            && generation == 1 => {}
        BridgeEvent::Error { message, .. } => {
            terminate_bridge_child(&mut child).await;
            return Err(message);
        }
        event => {
            terminate_bridge_child(&mut child).await;
            return Err(format!(
                "unexpected Redirector bridge apply event: {event:?}"
            ));
        }
    }

    Ok(BridgeSession {
        child,
        input,
        output,
        session_id,
        provider_pid,
        generation: 1,
        next_request_id: 2,
    })
}

async fn stop_bridge(bridge: &mut BridgeSession) -> Result<(), String> {
    let request_id = bridge.next_request_id;
    bridge.next_request_id = bridge.next_request_id.saturating_add(1);
    if let Err(error) = write_bridge_command(
        &mut bridge.input,
        &BridgeCommand::Stop {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id,
            session_id: bridge.session_id.clone(),
            generation: bridge.generation,
        },
    )
    .await
    {
        // Closing the management pipe is itself a watchdog trigger. Wait for
        // the bridge's inert cleanup instead of abandoning the child.
        bridge.input.shutdown().await.ok();
        terminate_bridge_child(&mut bridge.child).await;
        return Err(error);
    }

    let stopped = tokio::time::timeout(STOP_TIMEOUT, async {
        loop {
            match read_bridge_event(&mut bridge.output).await? {
                BridgeEvent::Pong { .. } => continue,
                BridgeEvent::Stopped {
                    version,
                    request_id: stopped_request_id,
                    session_id,
                    generation,
                } if version == BRIDGE_PROTOCOL_VERSION
                    && stopped_request_id == request_id
                    && session_id == bridge.session_id
                    && generation == bridge.generation =>
                {
                    return Ok(());
                }
                BridgeEvent::Error { message, .. } => return Err(message),
                event => return Err(format!("unexpected bridge stop event: {event:?}")),
            }
        }
    })
    .await;

    let stopped = match stopped {
        Ok(Ok(stopped)) => stopped,
        Ok(Err(error)) => {
            terminate_bridge_child(&mut bridge.child).await;
            return Err(error);
        }
        Err(_) => {
            terminate_bridge_child(&mut bridge.child).await;
            return Err("timed out waiting for Redirector bridge inert stop".into());
        }
    };

    if tokio::time::timeout(BRIDGE_EXIT_TIMEOUT, bridge.child.wait())
        .await
        .is_err()
    {
        let _ = bridge.child.start_kill();
        let _ = bridge.child.wait().await;
    }
    Ok(stopped)
}

async fn terminate_bridge_child(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SIGTERM gives the bridge a chance to install the inert scope. If it
        // is still in early startup, termination is safe because no business
        // scope has been applied yet.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(STOP_TIMEOUT, child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

async fn write_bridge_command<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    command: &BridgeCommand,
) -> Result<(), String> {
    writer
        .write_all(encode_line(command)?.as_bytes())
        .await
        .map_err(|error| format!("write Redirector bridge command: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("flush Redirector bridge command: {error}"))
}

async fn read_bridge_event<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<BridgeEvent, String> {
    let mut line = String::new();
    let size = (&mut *reader)
        .take((MAX_MANAGEMENT_LINE + 1) as u64)
        .read_line(&mut line)
        .await
        .map_err(|error| format!("read Redirector bridge event: {error}"))?;
    if size == 0 {
        return Err("Redirector bridge event channel closed".into());
    }
    if size > MAX_MANAGEMENT_LINE || !line.ends_with('\n') {
        return Err(format!(
            "Redirector bridge event exceeds {MAX_MANAGEMENT_LINE} bytes or is unterminated"
        ));
    }
    decode_line(&line).map_err(|error| format!("decode Redirector bridge event: {error}"))
}

async fn serve_flow(
    mut stream: UnixStream,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let flow = tokio::time::timeout(
        FLOW_HANDSHAKE_TIMEOUT,
        read_required_frame::<_, NewFlow>(&mut stream),
    )
    .await
    .map_err(|_| "Redirector flow handshake timed out".to_string())?
    .map_err(|error| format!("read Redirector NewFlow: {error}"))?;

    ctx.read().await.stats.record_flow_seen();
    match flow.message {
        Some(new_flow::Message::Tcp(flow)) => serve_tcp(stream, flow, scope, ctx).await,
        Some(new_flow::Message::Udp(flow)) => serve_udp(stream, flow, scope, block_quic, ctx).await,
        None => Err("Redirector NewFlow has no TCP/UDP payload".into()),
    }
}

async fn serve_tcp(
    stream: UnixStream,
    flow: TcpFlow,
    scope: Arc<ScopeSnapshot>,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let remote = resolve_required_address(flow.remote_address.as_ref(), "TCP remote").await?;
    let process_path = process_path(flow.tunnel_info.as_ref());
    let pid = flow.tunnel_info.as_ref().and_then(|info| info.pid);

    if !scope.matches_process(process_path.as_deref()) {
        tracing::warn!(
            ?pid,
            process = process_path.as_deref().unwrap_or("<unknown>"),
            %remote,
            "sockscap: Redirector delivered an out-of-scope TCP flow; failing open direct"
        );
        let stats = Arc::clone(&ctx.read().await.stats);
        stats.record_scope_mismatch();
        stats.record_decision(false, false);
        return relay_tcp_direct(stream, remote, stats).await;
    }

    let flow = CapturedFlow {
        dest_ip: Some(remote.ip()),
        dest_host: None,
        dest_port: remote.port(),
        process_path: process_path.clone(),
        pid,
        origin: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        profile_id_hint: scope
            .profile_id_hint(process_path.as_deref())
            .map(str::to_owned),
    };
    handle_captured_stream(stream, flow, ctx).await
}

async fn relay_tcp_direct(
    mut stream: UnixStream,
    remote: SocketAddr,
    stats: Arc<crate::sockscap::stats::StatsCounters>,
) -> Result<(), String> {
    let mut upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(remote))
        .await
        .map_err(|_| format!("direct TCP {remote} timed out"))?
        .map_err(|error| format!("direct TCP {remote}: {error}"))?;
    let (up, down) = copy_bidirectional(&mut stream, &mut upstream)
        .await
        .map_err(|error| format!("direct TCP bridge {remote}: {error}"))?;
    stats.add_bytes(up, down);
    Ok(())
}

async fn serve_udp(
    mut ipc: UnixStream,
    flow: UdpFlow,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let process_path = process_path(flow.tunnel_info.as_ref());
    let pid = flow.tunnel_info.as_ref().and_then(|info| info.pid);
    let in_scope = scope.matches_process(process_path.as_deref());
    let Some(first) = read_optional_frame::<_, UdpPacket>(&mut ipc)
        .await
        .map_err(|error| format!("read first Redirector UDP packet: {error}"))?
    else {
        return Ok(());
    };
    let remote = resolve_required_address(first.remote_address.as_ref(), "UDP remote").await?;
    let (stats, dns_map) = {
        let context = ctx.read().await;
        (Arc::clone(&context.stats), Arc::clone(&context.dns_map))
    };
    if !in_scope {
        stats.record_scope_mismatch();
        tracing::warn!(
            ?pid,
            process = process_path.as_deref().unwrap_or("<unknown>"),
            %remote,
            "sockscap: Redirector delivered an out-of-scope UDP flow; failing open direct"
        );
    }
    if should_block_udp(in_scope, block_quic, remote) {
        stats.record_decision(false, true);
        stats.record_quic_drop();
        tracing::info!(
            ?pid,
            process = process_path.as_deref().unwrap_or("<unknown>"),
            %remote,
            "sockscap: blocked in-scope UDP/443 for QUIC fallback"
        );
        let _ = ipc.shutdown().await;
        return Ok(());
    }

    let bind_address = match remote.ip() {
        IpAddr::V4(_) => "0.0.0.0:0",
        IpAddr::V6(_) => "[::]:0",
    };
    let udp = UdpSocket::bind(bind_address)
        .await
        .map_err(|error| format!("bind UDP relay {bind_address}: {error}"))?;
    udp.send_to(&first.data, remote)
        .await
        .map_err(|error| format!("send UDP to {remote}: {error}"))?;
    stats.record_decision(false, false);
    stats.record_udp_direct_datagram();
    stats.add_bytes(first.data.len() as u64, 0);

    let (mut reader, mut writer) = ipc.into_split();
    let mut receive_buf = vec![0u8; 65_535];
    let mut rate_limiter = DatagramRateLimiter::new();
    // macOS commonly opens a fresh UDP socket for each DNS lookup. Keeping
    // those one-shot Redirector flows for a full minute amplifies startup DNS
    // bursts and needlessly consumes IPC/file-descriptor capacity.
    let idle_timeout = if remote.port() == 53 {
        DNS_UDP_IDLE_TIMEOUT
    } else {
        UDP_IDLE_TIMEOUT
    };
    let idle = tokio::time::sleep(idle_timeout);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            _ = &mut idle => {
                tracing::debug!(?pid, %remote, "sockscap: UDP direct flow expired after idle timeout");
                break;
            }
            packet = read_optional_frame::<_, UdpPacket>(&mut reader) => {
                let Some(packet) = packet.map_err(|error| format!("read Redirector UDP packet: {error}"))? else {
                    break;
                };
                idle.as_mut().reset(tokio::time::Instant::now() + idle_timeout);
                if !rate_limiter.allow() {
                    tracing::warn!(?pid, "sockscap: UDP source rate limit reached; dropping datagram");
                    continue;
                }
                let packet_remote = resolve_required_address(packet.remote_address.as_ref(), "UDP remote").await?;
                if should_block_udp(in_scope, block_quic, packet_remote) {
                    stats.record_quic_drop();
                    tracing::info!(?pid, %packet_remote, "sockscap: blocked in-scope UDP/443 for QUIC fallback");
                    let _ = writer.shutdown().await;
                    break;
                }
                udp.send_to(&packet.data, packet_remote)
                    .await
                    .map_err(|error| format!("relay UDP to {packet_remote}: {error}"))?;
                stats.record_udp_direct_datagram();
                stats.add_bytes(packet.data.len() as u64, 0);
            }
            received = udp.recv_from(&mut receive_buf) => {
                let (size, peer) = received.map_err(|error| format!("receive relayed UDP: {error}"))?;
                idle.as_mut().reset(tokio::time::Instant::now() + idle_timeout);
                if remote.port() == 53 || peer.port() == 53 {
                    let answers = extract_ip_answers(&receive_buf[..size]);
                    if !answers.is_empty()
                        && let Ok(mut map) = dns_map.lock()
                    {
                        for answer in &answers {
                            map.insert(answer.ip, answer.host.clone(), Some(answer.ttl));
                        }
                        stats.record_dns_answers(answers.len() as u64);
                    }
                }
                let response = UdpPacket {
                    data: bytes::Bytes::copy_from_slice(&receive_buf[..size]),
                    remote_address: Some(Address {
                        host: peer.ip().to_string(),
                        port: u32::from(peer.port()),
                    }),
                };
                write_frame(&mut writer, &response)
                    .await
                    .map_err(|error| format!("write Redirector UDP response: {error}"))?;
                stats.record_udp_direct_datagram();
                stats.add_bytes(0, size as u64);
            }
        }
    }
    Ok(())
}

struct DatagramRateLimiter {
    tokens: u64,
    last_refill: std::time::Instant,
}

impl DatagramRateLimiter {
    fn new() -> Self {
        Self {
            tokens: UDP_DATAGRAM_BURST,
            last_refill: std::time::Instant::now(),
        }
    }

    fn allow(&mut self) -> bool {
        let elapsed = self.last_refill.elapsed();
        let refill = elapsed.as_secs_f64() * UDP_DATAGRAM_RATE_PER_SECOND as f64;
        if refill >= 1.0 {
            self.tokens = (self.tokens + refill as u64).min(UDP_DATAGRAM_BURST);
            self.last_refill = std::time::Instant::now();
        }
        if self.tokens == 0 {
            false
        } else {
            self.tokens -= 1;
            true
        }
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn should_block_udp(in_scope: bool, block_quic: bool, remote: SocketAddr) -> bool {
    in_scope && block_quic && remote.port() == 443
}

fn process_path(info: Option<&TunnelInfo>) -> Option<String> {
    info.and_then(|info| {
        info.process_name
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    })
}

async fn resolve_required_address(
    address: Option<&Address>,
    label: &str,
) -> Result<SocketAddr, String> {
    let address = address.ok_or_else(|| format!("Redirector {label} address is missing"))?;
    let port = u16::try_from(address.port)
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("Redirector {label} port is invalid: {}", address.port))?;
    if address.host.trim().is_empty() {
        return Err(format!("Redirector {label} host is empty"));
    }
    if let Ok(ip) = address.host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    lookup_host((address.host.as_str(), port))
        .await
        .map_err(|error| {
            format!(
                "resolve Redirector {label} {}:{port}: {error}",
                address.host
            )
        })?
        .next()
        .ok_or_else(|| format!("Redirector {label} resolved no addresses"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn udp_443_is_blocked_only_for_in_scope_flows_when_enabled() {
        let quic: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let dns: SocketAddr = "1.1.1.1:53".parse().unwrap();
        assert!(should_block_udp(true, true, quic));
        assert!(!should_block_udp(false, true, quic));
        assert!(!should_block_udp(true, false, quic));
        assert!(!should_block_udp(true, true, dns));
    }

    #[test]
    fn process_path_ignores_empty_metadata() {
        let empty = TunnelInfo {
            pid: Some(1),
            process_name: Some("  ".into()),
        };
        assert_eq!(process_path(Some(&empty)), None);
    }

    #[test]
    fn recovery_probe_targets_require_numeric_socket_addresses() {
        let targets = parse_recovery_probe_targets("127.0.0.1:80,[::1]:443").unwrap();
        assert_eq!(targets.len(), 2);
        assert!(parse_recovery_probe_targets("example.com:443").is_err());
        assert!(parse_recovery_probe_targets("  ").is_err());
    }

    #[test]
    fn relay_capacity_reserves_descriptors_for_the_desktop_app() {
        assert_eq!(relay_flow_capacity(256), 64);
        assert_eq!(relay_flow_capacity(1_024), 448);
        assert_eq!(relay_flow_capacity(4_096), MAX_ACTIVE_RELAY_FLOWS);
        assert_eq!(relay_flow_capacity(u64::MAX), MAX_ACTIVE_RELAY_FLOWS);
    }
}
