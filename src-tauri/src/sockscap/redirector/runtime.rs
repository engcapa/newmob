//! Runtime bridge for the signed Mitmproxy Redirector app (macOS only).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpStream, UdpSocket, UnixListener, UnixStream, lookup_host};
use tokio::process::Command;
use tokio::sync::{RwLock, oneshot};
use tokio::task::{JoinHandle, JoinSet};

use super::ipc::{
    Address, NewFlow, TcpFlow, TunnelInfo, UdpFlow, UdpPacket, new_flow, read_optional_frame,
    read_required_frame, send_intercept_config, write_frame,
};
use super::scope::{ScopeSnapshot, inert_actions};
use super::{REDIRECTOR_APP_PATH, installed_executable_path};
use crate::sockscap::config::{ScopeMode, SocksCapConfig};
use crate::sockscap::paths;
use crate::sockscap::relay::{
    CapturedFlow, MAX_ACTIVE_RELAY_FLOWS, RelayContext, handle_captured_stream,
};

const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const FLOW_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(4);
const DISABLE_DRAIN: Duration = Duration::from_millis(300);

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
}

impl RedirectorCaptureHandle {
    pub async fn stop(mut self) -> Result<(), String> {
        if let Some(stop) = self.stop_tx.take() {
            let _ = stop.send(());
        }
        let mut task = self.task;
        match tokio::time::timeout(STOP_TIMEOUT, &mut task).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(format!("Redirector bridge task failed: {error}")),
            Err(_) => {
                task.abort();
                let _ = task.await;
                Err(format!(
                    "Redirector bridge did not disable capture within {}s",
                    STOP_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

pub async fn start(
    app: &tauri::AppHandle,
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<RedirectorCaptureHandle, String> {
    preflight(config)?;

    let executable = installed_executable_path();
    let mut exclusions = vec![
        std::env::current_exe().map_err(|error| format!("resolve Taomni executable: {error}"))?,
        PathBuf::from(REDIRECTOR_APP_PATH),
    ];
    if let Some(xray) = paths::resolve_xray_exe(app) {
        exclusions.push(xray);
    }
    let scope = Arc::new(ScopeSnapshot::compile(config, exclusions)?);

    let socket_path = PathBuf::from(format!(
        "/tmp/taomni-mitmproxy-redirector-{}.sock",
        uuid::Uuid::new_v4().simple()
    ));
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("bind Redirector IPC {}: {error}", socket_path.display()))?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("secure Redirector IPC {}: {error}", socket_path.display()))?;
    let cleanup = SocketCleanup(socket_path.clone());

    let mut child = Command::new(&executable)
        .arg(&socket_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("launch signed Redirector {}: {error}", executable.display()))?;

    let (mut control, _) = tokio::time::timeout(CONTROL_CONNECT_TIMEOUT, listener.accept())
        .await
        .map_err(|_| {
            "timed out waiting for Mitmproxy Redirector; approve its System Extension and network configuration in System Settings, then retry"
                .to_string()
        })?
        .map_err(|error| format!("accept Redirector control channel: {error}"))?;
    send_intercept_config(&mut control, scope.actions())
        .await
        .map_err(|error| format!("send Redirector capture scope: {error}"))?;

    tracing::info!(
        actions = scope.actions().len(),
        block_quic = config.block_quic,
        socket = %socket_path.display(),
        "sockscap: mitmproxy Redirector control channel active"
    );

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) if status.success() => {
                tracing::debug!("sockscap: Redirector launcher exited successfully")
            }
            Ok(status) => tracing::warn!("sockscap: Redirector launcher exited with {status}"),
            Err(error) => tracing::warn!("sockscap: Redirector launcher wait failed: {error}"),
        }
    });

    let (stop_tx, stop_rx) = oneshot::channel();
    let block_quic = config.block_quic;
    let task = tokio::spawn(run_capture(
        listener, control, scope, block_quic, ctx, stop_rx, cleanup,
    ));

    Ok(RedirectorCaptureHandle {
        stop_tx: Some(stop_tx),
        task,
    })
}

/// Validate all fail-fast gates before building upstream pools/sidecars.
pub fn preflight(config: &SocksCapConfig) -> Result<(), String> {
    // Application scope is intentionally gated until the picker/signature
    // identity work and selected/unselected E2E matrix are complete. The scope
    // compiler already supports it and is tested independently.
    if config
        .active_profiles()
        .iter()
        .any(|profile| matches!(profile.mode, ScopeMode::Apps))
    {
        return Err(
            "macOS application capture is not enabled yet; use a Global profile until app identity validation is complete"
                .into(),
        );
    }

    super::verify_installed()
        .map_err(|error| format!("{error}; no system-proxy fallback is available"))?;
    Ok(())
}

async fn run_capture(
    listener: UnixListener,
    mut control: UnixStream,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
    ctx: Arc<RwLock<RelayContext>>,
    mut stop_rx: oneshot::Receiver<()>,
    _cleanup: SocketCleanup,
) -> Result<(), String> {
    let mut flows = JoinSet::new();
    let limiter = Arc::new(tokio::sync::Semaphore::new(MAX_ACTIVE_RELAY_FLOWS));
    let mut accept_error = None;

    loop {
        while let Some(result) = flows.try_join_next() {
            if let Err(error) = result {
                tracing::warn!("sockscap: Redirector flow task failed: {error}");
            }
        }
        tokio::select! {
            _ = &mut stop_rx => break,
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        accept_error = Some(format!("accept Redirector flow: {error}"));
                        break;
                    }
                };
                let permit = match Arc::clone(&limiter).try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        tracing::warn!(
                            max_flows = MAX_ACTIVE_RELAY_FLOWS,
                            "sockscap: Redirector flow limit reached; refusing flow"
                        );
                        drop(stream);
                        continue;
                    }
                };
                let scope = Arc::clone(&scope);
                let ctx = Arc::clone(&ctx);
                flows.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = serve_flow(stream, scope, block_quic, ctx).await {
                        tracing::warn!("sockscap: Redirector flow failed: {error}");
                    }
                });
            }
        }
    }

    let inert = inert_actions();
    let disable_result = send_intercept_config(&mut control, &inert)
        .await
        .map_err(|error| format!("disable Redirector interception: {error}"));
    tokio::time::sleep(DISABLE_DRAIN).await;
    let _ = control.shutdown().await;
    flows.shutdown().await;

    disable_result?;
    if let Some(error) = accept_error {
        return Err(error);
    }
    tracing::info!("sockscap: Redirector interception disabled with inert scope");
    Ok(())
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

    match flow.message {
        Some(new_flow::Message::Tcp(flow)) => serve_tcp(stream, flow, scope, ctx).await,
        Some(new_flow::Message::Udp(flow)) => serve_udp(stream, flow, scope, block_quic).await,
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
        return relay_tcp_direct(stream, remote).await;
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

async fn relay_tcp_direct(mut stream: UnixStream, remote: SocketAddr) -> Result<(), String> {
    let mut upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(remote))
        .await
        .map_err(|_| format!("direct TCP {remote} timed out"))?
        .map_err(|error| format!("direct TCP {remote}: {error}"))?;
    copy_bidirectional(&mut stream, &mut upstream)
        .await
        .map(|_| ())
        .map_err(|error| format!("direct TCP bridge {remote}: {error}"))
}

async fn serve_udp(
    mut ipc: UnixStream,
    flow: UdpFlow,
    scope: Arc<ScopeSnapshot>,
    block_quic: bool,
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
    if should_block_udp(in_scope, block_quic, remote) {
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

    let (mut reader, mut writer) = ipc.into_split();
    let mut receive_buf = vec![0u8; 65_535];
    loop {
        tokio::select! {
            packet = read_optional_frame::<_, UdpPacket>(&mut reader) => {
                let Some(packet) = packet.map_err(|error| format!("read Redirector UDP packet: {error}"))? else {
                    break;
                };
                let packet_remote = resolve_required_address(packet.remote_address.as_ref(), "UDP remote").await?;
                if should_block_udp(in_scope, block_quic, packet_remote) {
                    tracing::info!(?pid, %packet_remote, "sockscap: blocked in-scope UDP/443 for QUIC fallback");
                    let _ = writer.shutdown().await;
                    break;
                }
                udp.send_to(&packet.data, packet_remote)
                    .await
                    .map_err(|error| format!("relay UDP to {packet_remote}: {error}"))?;
            }
            received = udp.recv_from(&mut receive_buf) => {
                let (size, peer) = received.map_err(|error| format!("receive relayed UDP: {error}"))?;
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
            }
        }
    }
    Ok(())
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
    fn preflight_rejects_any_application_profile_while_capability_is_gated() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = ScopeMode::Apps;
        let error = preflight(&config).unwrap_err();
        assert!(error.contains("application capture is not enabled yet"));
    }
}
