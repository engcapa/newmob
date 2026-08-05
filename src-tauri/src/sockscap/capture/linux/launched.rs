//! Unprivileged Linux capture for applications launched by SocksCap.
//!
//! A private launcher installs a seccomp filter and enters ptrace supervision
//! before it execs the requested desktop or TUI application. The filter is
//! inherited by the complete process tree and reports socket creation plus
//! TCP connection attempts.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::TcpListener;
use tokio::sync::{RwLock, Semaphore};
use tokio::task::JoinSet;

use super::tracer::{FlowQueue, ProcessIdentity, TracerSupervisor};
use crate::sockscap::relay::{
    ACCEPT_BACKOFF_INITIAL, ACCEPT_BACKOFF_MAX, CapturedFlow, MAX_ACTIVE_RELAY_FLOWS,
    RELAY_PERMIT_WAIT, RelayContext, RelayHandle, acquire_relay_flow_permit,
    new_relay_flow_limiter,
};

const FLOW_WAIT: Duration = Duration::from_secs(2);
static LAUNCHER_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/taomni-sockscap-trace-launcher"));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchedAppInfo {
    pub pid: u32,
    pub profile_id: String,
    pub path: String,
    pub args: Vec<String>,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_session_id: Option<String>,
}

struct LaunchedProcess {
    info: LaunchedAppInfo,
    process_group: libc::pid_t,
    terminal_running: Option<Arc<AtomicBool>>,
}

struct TerminalActivityReader {
    inner: Box<dyn Read + Send>,
    running: Arc<AtomicBool>,
}

impl Read for TerminalActivityReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let result = self.inner.read(buffer);
        if !matches!(result, Ok(count) if count > 0) {
            self.running.store(false, Ordering::Release);
        }
        result
    }
}

impl Drop for TerminalActivityReader {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

/// Lifecycle for the launch-only backend. It owns no system network state, so
/// stop can always return to Idle after closing its children and listener.
pub struct LaunchedCaptureHandle {
    relay: Option<RelayHandle>,
    relay_port: u16,
    launcher_path: PathBuf,
    processes: Vec<LaunchedProcess>,
    tracer: Option<TracerSupervisor>,
}

impl LaunchedCaptureHandle {
    pub async fn start(ctx: Arc<RwLock<RelayContext>>, runtime_dir: &Path) -> Result<Self, String> {
        let launcher_path = materialize_launcher(runtime_dir)?;
        super::tracer::preflight(&launcher_path).map_err(|error| {
            format!("Linux rootless application capture is unavailable: {error}")
        })?;
        let flows = Arc::new(FlowQueue::default());
        let (relay, ipv6_ready) = start_redirect_ingress(ctx, Arc::clone(&flows)).await?;
        let relay_port = relay.port;
        let tracer = TracerSupervisor::start(relay_port, ipv6_ready, flows);
        Ok(Self {
            relay: Some(relay),
            relay_port,
            launcher_path,
            processes: Vec::new(),
            tracer: Some(tracer),
        })
    }

    pub fn relay_port(&self) -> u16 {
        self.relay_port
    }

    pub async fn launch_app(
        &mut self,
        profile_id: &str,
        command_name: &str,
        args: &[String],
    ) -> Result<LaunchedAppInfo, String> {
        let command_name = command_name.trim();
        let executable = resolve_executable(command_name)?;
        let executable_text = executable.to_string_lossy().into_owned();
        let pid = self
            .tracer
            .as_ref()
            .ok_or_else(|| "SocksCap ptrace supervisor is not running".to_string())?
            .spawn_desktop(&self.launcher_path, &executable, args)?;
        if let Err(error) = self.register_trace(pid, profile_id, &executable_text) {
            kill_process_group(pid as libc::pid_t);
            return Err(error);
        }

        let info = LaunchedAppInfo {
            pid,
            profile_id: profile_id.to_string(),
            path: command_name.to_string(),
            args: args.to_vec(),
            running: true,
            terminal_session_id: None,
        };
        tracing::info!(
            pid,
            command = command_name,
            executable = %executable.display(),
            argument_count = args.len(),
            "SocksCap launched application under ptrace/seccomp capture"
        );
        self.processes.push(LaunchedProcess {
            info: info.clone(),
            process_group: pid as libc::pid_t,
            terminal_running: None,
        });
        Ok(info)
    }

    pub fn launch_terminal_app(
        &mut self,
        profile_id: &str,
        command_name: &str,
        args: &[String],
        terminal_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<
        (
            LaunchedAppInfo,
            crate::terminal::pty::PtyHandle,
            Box<dyn Read + Send>,
        ),
        String,
    > {
        let command_name = command_name.trim();
        let executable = resolve_executable(command_name)?;
        let executable_text = executable.to_string_lossy().into_owned();
        let (pid, mut handle, reader) = self
            .tracer
            .as_ref()
            .ok_or_else(|| "SocksCap ptrace supervisor is not running".to_string())?
            .spawn_terminal(&self.launcher_path, &executable, args, cols, rows)?;
        if let Err(error) = self.register_trace(pid, profile_id, &executable_text) {
            let _ = handle.child.kill();
            return Err(error);
        }

        let info = LaunchedAppInfo {
            pid,
            profile_id: profile_id.to_string(),
            path: command_name.to_string(),
            args: args.to_vec(),
            running: true,
            terminal_session_id: Some(terminal_session_id.to_string()),
        };
        tracing::info!(
            pid,
            command = command_name,
            executable = %executable.display(),
            argument_count = args.len(),
            terminal_session_id,
            "SocksCap launched terminal application under ptrace/seccomp capture"
        );
        let terminal_running = Arc::new(AtomicBool::new(true));
        let tracked_reader: Box<dyn Read + Send> = Box::new(TerminalActivityReader {
            inner: reader,
            running: Arc::clone(&terminal_running),
        });
        self.processes.push(LaunchedProcess {
            info: info.clone(),
            process_group: pid as libc::pid_t,
            terminal_running: Some(terminal_running),
        });
        Ok((info, handle, tracked_reader))
    }

    fn register_trace(&self, pid: u32, profile_id: &str, executable: &str) -> Result<(), String> {
        self.tracer
            .as_ref()
            .ok_or_else(|| "SocksCap ptrace supervisor is not running".to_string())?
            .register_root(
                pid,
                ProcessIdentity {
                    profile_id: profile_id.to_string(),
                    configured_path: executable.to_string(),
                },
            )
            .map_err(|error| format!("attach rootless capture to PID {pid}: {error}"))
    }

    pub fn apps(&mut self) -> Vec<LaunchedAppInfo> {
        for process in &mut self.processes {
            if process.info.running {
                if process
                    .terminal_running
                    .as_ref()
                    .is_some_and(|running| !running.load(Ordering::Acquire))
                {
                    process.info.running = false;
                    continue;
                }
                process.info.running = process_group_is_alive(process.process_group);
            }
        }
        self.processes
            .iter()
            .map(|process| process.info.clone())
            .collect()
    }

    pub async fn stop_app(&mut self, pid: u32) -> Result<(), String> {
        let process = self
            .processes
            .iter_mut()
            .find(|process| process.info.pid == pid)
            .ok_or_else(|| format!("no SocksCap-launched application with PID {pid}"))?;
        stop_process_group(process).await
    }

    pub async fn stop(&mut self) {
        for process in &mut self.processes {
            if let Err(error) = stop_process_group(process).await {
                tracing::warn!(pid = process.info.pid, "stop launched app: {error}");
            }
        }
        if let Some(mut tracer) = self.tracer.take() {
            tracer.shutdown();
        }
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
    }
}

fn process_group_is_alive(process_group: libc::pid_t) -> bool {
    let result = unsafe { libc::kill(-process_group, 0) };
    result == 0 || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
}

fn kill_process_group(process_group: libc::pid_t) {
    unsafe { libc::kill(-process_group, libc::SIGKILL) };
}

async fn stop_process_group(process: &mut LaunchedProcess) -> Result<(), String> {
    if process_group_is_alive(process.process_group) {
        let result = unsafe { libc::kill(-process.process_group, libc::SIGTERM) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "stop launched application PID {}: {error}",
                    process.info.pid
                ));
            }
        }
        for _ in 0..20 {
            if !process_group_is_alive(process.process_group) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if process_group_is_alive(process.process_group) {
            let result = unsafe { libc::kill(-process.process_group, libc::SIGKILL) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!(
                        "force-stop launched application PID {}: {error}",
                        process.info.pid
                    ));
                }
            }
        }
    }
    process.info.running = false;
    if let Some(running) = &process.terminal_running {
        running.store(false, Ordering::Release);
    }
    Ok(())
}

fn resolve_executable(command: &str) -> Result<PathBuf, String> {
    if command.is_empty() {
        return Err("SocksCap launch command is empty".into());
    }
    let path = which::which(command).map_err(|error| {
        format!("resolve SocksCap launch command {command:?} through PATH: {error}")
    })?;
    validate_executable(&path)?;
    Ok(path)
}

fn validate_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("inspect launch path {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "SocksCap launch path is not a file: {}",
            path.display()
        ));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!(
            "SocksCap launch path is not executable: {}",
            path.display()
        ));
    }
    if metadata.permissions().mode() & 0o6000 != 0 {
        return Err(format!(
            "SocksCap cannot launch setuid/setgid executables in unprivileged capture mode: {}",
            path.display()
        ));
    }
    Ok(())
}

fn materialize_launcher(runtime_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(runtime_dir)
        .map_err(|error| format!("create SocksCap runtime directory: {error}"))?;
    fs::set_permissions(runtime_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("secure SocksCap runtime directory: {error}"))?;
    let path = runtime_dir.join("taomni-sockscap-trace-launcher");
    if fs::read(&path).ok().as_deref() == Some(LAUNCHER_BYTES) {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure SocksCap trace launcher: {error}"))?;
        return Ok(path);
    }
    let temporary = runtime_dir.join(format!(
        ".taomni-sockscap-trace-launcher-{}.tmp",
        std::process::id()
    ));
    let mut file = File::create(&temporary)
        .map_err(|error| format!("create SocksCap trace launcher: {error}"))?;
    file.write_all(LAUNCHER_BYTES)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("write SocksCap trace launcher: {error}"))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("set SocksCap trace launcher permissions: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("install SocksCap trace launcher: {error}"))?;
    Ok(path)
}

/// Read-only capability probe used before rootless backend selection.
pub fn preflight() -> Result<(), String> {
    let directory = std::env::temp_dir().join(format!(
        "taomni-sockscap-preflight-{}-{}",
        unsafe { libc::geteuid() },
        uuid::Uuid::new_v4()
    ));
    let launcher = materialize_launcher(&directory)?;
    let result = super::tracer::preflight(&launcher);
    let _ = fs::remove_file(&launcher);
    let _ = fs::remove_dir(&directory);
    result
}

async fn start_redirect_ingress(
    ctx: Arc<RwLock<RelayContext>>,
    flows: Arc<FlowQueue>,
) -> Result<(RelayHandle, bool), String> {
    let listener_v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| format!("bind Linux launch redirect ingress: {error}"))?;
    let port = listener_v4
        .local_addr()
        .map_err(|error| format!("read Linux launch redirect ingress address: {error}"))?
        .port();
    let listener_v6 = match bind_loopback_v6(port) {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::warn!("Linux launch-only IPv6 capture unavailable: {error}");
            None
        }
    };
    let ipv6_ready = listener_v6.is_some();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = Arc::clone(&stop);
    let limiter = new_relay_flow_limiter();
    let task = tokio::spawn(async move {
        let v4 = accept_loop(
            listener_v4,
            Arc::clone(&ctx),
            Arc::clone(&flows),
            Arc::clone(&stop_for_task),
            Arc::clone(&limiter),
        );
        if let Some(listener_v6) = listener_v6 {
            let v6 = accept_loop(listener_v6, ctx, flows, stop_for_task, limiter);
            let _ = tokio::join!(v4, v6);
        } else {
            v4.await;
        }
    });
    Ok((RelayHandle::new(port, stop, task), ipv6_ready))
}

fn bind_loopback_v6(port: u16) -> Result<TcpListener, String> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))
        .map_err(|error| format!("create IPv6 launch ingress socket: {error}"))?;
    socket
        .set_only_v6(true)
        .map_err(|error| format!("set IPv6-only launch ingress socket: {error}"))?;
    socket
        .set_nonblocking(true)
        .map_err(|error| format!("set nonblocking launch ingress socket: {error}"))?;
    socket
        .bind(&SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0)).into())
        .map_err(|error| format!("bind IPv6 launch ingress: {error}"))?;
    socket
        .listen(1024)
        .map_err(|error| format!("listen IPv6 launch ingress: {error}"))?;
    TcpListener::from_std(socket.into())
        .map_err(|error| format!("adopt IPv6 launch ingress: {error}"))
}

async fn accept_loop(
    listener: TcpListener,
    ctx: Arc<RwLock<RelayContext>>,
    flows: Arc<FlowQueue>,
    stop: Arc<AtomicBool>,
    limiter: Arc<Semaphore>,
) {
    let mut clients = JoinSet::new();
    let mut accept_backoff = ACCEPT_BACKOFF_INITIAL;
    loop {
        while clients.try_join_next().is_some() {}
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let (socket, peer) = match listener.accept().await {
            Ok(connection) => {
                accept_backoff = ACCEPT_BACKOFF_INITIAL;
                connection
            }
            Err(error) => {
                if !stop.load(Ordering::SeqCst) {
                    tracing::warn!("Linux launch ingress accept failed: {error}");
                }
                tokio::time::sleep(accept_backoff).await;
                accept_backoff =
                    std::cmp::min(accept_backoff.saturating_mul(2), ACCEPT_BACKOFF_MAX);
                continue;
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT).await
        else {
            if !stop.load(Ordering::SeqCst) {
                tracing::warn!(
                    "Linux launch ingress at capacity ({MAX_ACTIVE_RELAY_FLOWS}); refusing {peer}"
                );
            }
            continue;
        };
        let ctx = Arc::clone(&ctx);
        let flows = Arc::clone(&flows);
        clients.spawn(async move {
            let _permit = permit;
            match flows.wait_take(FLOW_WAIT).await {
                Some(flow) => {
                    let captured = CapturedFlow {
                        dest_ip: Some(flow.destination.ip()),
                        dest_host: None,
                        dest_port: flow.destination.port(),
                        process_path: Some(flow.process_path),
                        pid: Some(flow.pid),
                        origin: peer,
                        profile_id_hint: Some(flow.profile_id),
                    };
                    if let Err(error) =
                        crate::sockscap::relay::handle_captured_client(socket, captured, ctx).await
                    {
                        tracing::warn!("Linux rootless relay client {peer}: {error}");
                    }
                }
                None => tracing::warn!("Linux rootless relay client {peer}: no traced connect"),
            }
        });
    }
    clients.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::process::Command;
    use std::sync::Mutex;

    use crate::sockscap::config::{RuleMode, ScopeMode, UpstreamKind};
    use crate::sockscap::helper::HelperRegistry;
    use crate::sockscap::relay::{RelayContext, ResolvedUpstream};
    use crate::sockscap::rules::dns_map::DnsMap;
    use crate::sockscap::stats::{DomainTracker, StatsCounters};

    struct RootlessTestCapture {
        capture: LaunchedCaptureHandle,
        profile_id: String,
        stats: Arc<StatsCounters>,
        directory: tempfile::TempDir,
    }

    async fn start_rootless_test_capture() -> RootlessTestCapture {
        let proxy = std::env::var("TAOMNI_TEST_HTTP_PROXY")
            .expect("set TAOMNI_TEST_HTTP_PROXY, for example http://127.0.0.1:31128");
        let proxy = url::Url::parse(&proxy).expect("parse TAOMNI_TEST_HTTP_PROXY");
        assert_eq!(proxy.scheme(), "http");
        let proxy_host = proxy.host_str().unwrap().to_string();
        let proxy_port = proxy.port_or_known_default().unwrap();

        let mut config = crate::sockscap::config::SocksCapConfig::default();
        let profile = &mut config.profiles[0];
        profile.mode = ScopeMode::Apps;
        profile.rule_mode = RuleMode::ProxyAll;
        profile.upstream.kind = UpstreamKind::Http;
        profile.upstream.host = proxy_host.clone();
        profile.upstream.port = proxy_port;
        let profile_id = profile.id.clone();
        config.active_profile_ids = vec![profile_id.clone()];

        let stats = Arc::new(StatsCounters::default());
        let mut profile_upstreams = HashMap::new();
        profile_upstreams.insert(
            profile_id.clone(),
            ResolvedUpstream {
                kind: UpstreamKind::Http,
                host: proxy_host.clone(),
                port: proxy_port,
                user: String::new(),
                pass: String::new(),
                ssh_pool: None,
                xray_port: None,
            },
        );
        let context = Arc::new(RwLock::new(RelayContext {
            engine: RelayContext::build_engine(&config, None),
            config,
            rules: None,
            helper: Arc::new(HelperRegistry::new()),
            helper_client: None,
            stats: Arc::clone(&stats),
            upstream_host: proxy_host,
            upstream_port: proxy_port,
            upstream_user: String::new(),
            upstream_pass: String::new(),
            self_pid: std::process::id(),
            ssh_pool: None,
            xray_port: None,
            profile_upstreams,
            dns_map: Arc::new(Mutex::new(DnsMap::new(64, Duration::from_secs(60)))),
            domains: Arc::new(Mutex::new(DomainTracker::new(32))),
        }));

        let directory = tempfile::tempdir().unwrap();
        let capture = LaunchedCaptureHandle::start(context, directory.path())
            .await
            .expect("start ptrace/seccomp capture");
        RootlessTestCapture {
            capture,
            profile_id,
            stats,
            directory,
        }
    }

    async fn wait_for_text(path: &Path, expected: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if fs::read_to_string(path)
                .ok()
                .is_some_and(|body| body.contains(expected))
            {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {} to contain {expected:?}",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn wait_for_nonempty_file(path: &Path) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn curl_arguments(output: &Path) -> Vec<String> {
        vec![
            "--noproxy".into(),
            "*".into(),
            "--silent".into(),
            "--show-error".into(),
            "--max-time".into(),
            "20".into(),
            "--output".into(),
            output.to_string_lossy().into_owned(),
            "http://example.com/".into(),
        ]
    }

    #[test]
    fn materialized_launcher_is_private_and_stable() {
        let directory = tempfile::tempdir().unwrap();
        let first = materialize_launcher(directory.path()).unwrap();
        let second = materialize_launcher(directory.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(fs::read(&first).unwrap(), LAUNCHER_BYTES);
        assert_eq!(
            fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn resolves_launch_commands_through_path() {
        let executable = resolve_executable("sh").unwrap();
        assert!(executable.is_absolute());
        assert!(fs::metadata(executable).unwrap().permissions().mode() & 0o111 != 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_TEST_HTTP_PROXY and unprivileged ptrace/seccomp"]
    async fn rootless_capture_routes_curl_through_http_upstream() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_test_writer()
            .try_init();
        let mut harness = start_rootless_test_capture().await;
        let output = harness.directory.path().join("example.html");
        let launched = harness
            .capture
            .launch_app(&harness.profile_id, "curl", &curl_arguments(&output))
            .await
            .expect("launch curl under rootless capture");
        wait_for_text(&output, "Example Domain").await;
        eprintln!(
            "rootless apps={:?}, stats={:?}",
            harness.capture.apps(),
            harness.stats.snapshot()
        );
        assert!(harness.stats.snapshot().flows_proxy >= 1);
        assert_eq!(harness.stats.snapshot().flow_failures, 0);
        harness.capture.stop_app(launched.pid).await.unwrap();
        harness.capture.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_TEST_HTTP_PROXY, curl, and unprivileged ptrace/seccomp"]
    async fn rootless_capture_follows_shell_children_and_terminal_apps() {
        let mut harness = start_rootless_test_capture().await;
        let concurrent = harness.directory.path().join("concurrent");
        fs::create_dir(&concurrent).unwrap();
        let script = r#"set -eu
for name in one two three four; do
  curl --noproxy '*' --silent --show-error --max-time 20 --output "$1/$name.html" http://example.com/ &
done
wait"#;
        let arguments = vec![
            "-c".into(),
            script.into(),
            "taomni-sockscap-test".into(),
            concurrent.to_string_lossy().into_owned(),
        ];
        let shell = harness
            .capture
            .launch_app(&harness.profile_id, "sh", &arguments)
            .await
            .expect("launch shell process tree under rootless capture");
        for name in ["one", "two", "three", "four"] {
            wait_for_text(&concurrent.join(format!("{name}.html")), "Example Domain").await;
        }
        assert!(harness.stats.snapshot().flows_proxy >= 4);
        harness.capture.stop_app(shell.pid).await.unwrap();

        let terminal_output = harness.directory.path().join("terminal.html");
        let terminal_script = "printf 'TAOMNI_PTY_READY\\n'; exec curl --noproxy '*' --silent --show-error --max-time 20 --output \"$1\" http://example.com/";
        let terminal_arguments = vec![
            "-c".into(),
            terminal_script.into(),
            "taomni-sockscap-test".into(),
            terminal_output.to_string_lossy().into_owned(),
        ];
        let (terminal, _handle, mut reader) = harness
            .capture
            .launch_terminal_app(
                &harness.profile_id,
                "sh",
                &terminal_arguments,
                "rootless-test-terminal",
                80,
                24,
            )
            .expect("launch PTY application under rootless capture");
        let reader_task = tokio::task::spawn_blocking(move || {
            let mut output = String::new();
            let _ = reader.read_to_string(&mut output);
            output
        });
        wait_for_text(&terminal_output, "Example Domain").await;
        let terminal_text = tokio::time::timeout(Duration::from_secs(5), reader_task)
            .await
            .expect("PTY reader should observe application exit")
            .expect("PTY reader task should not panic");
        assert!(terminal_text.contains("TAOMNI_PTY_READY"));
        assert!(harness.stats.snapshot().flows_proxy >= 5);
        assert_eq!(harness.stats.snapshot().flow_failures, 0);
        harness.capture.stop_app(terminal.pid).await.unwrap();
        harness.capture.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_TEST_HTTP_PROXY, Go, and unprivileged ptrace/seccomp"]
    async fn rootless_capture_routes_static_go_direct_syscalls() {
        let go = std::env::var_os("TAOMNI_TEST_GO")
            .map(PathBuf::from)
            .or_else(|| which::which("go").ok())
            .expect("set TAOMNI_TEST_GO to a Go executable");
        let build_directory = tempfile::tempdir().unwrap();
        let source = build_directory.path().join("direct.go");
        let executable = build_directory.path().join("direct-client");
        fs::write(
            &source,
            r#"package main

import (
    "io"
    "net"
    "net/http"
    "os"
    "time"
)

func main() {
    transport := &http.Transport{
        Proxy: nil,
        DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
    }
    client := &http.Client{Transport: transport, Timeout: 20 * time.Second}
    response, err := client.Get("http://example.com/")
    if err != nil {
        panic(err)
    }
    defer response.Body.Close()
    body, err := io.ReadAll(response.Body)
    if err != nil {
        panic(err)
    }
    if err := os.WriteFile(os.Args[1], body, 0600); err != nil {
        panic(err)
    }
}
"#,
        )
        .unwrap();
        let build = Command::new(go)
            .env("CGO_ENABLED", "0")
            .arg("build")
            .arg("-trimpath")
            .arg("-o")
            .arg(&executable)
            .arg(&source)
            .output()
            .expect("run go build");
        assert!(
            build.status.success(),
            "go build failed: {}",
            String::from_utf8_lossy(&build.stderr)
        );

        let mut harness = start_rootless_test_capture().await;
        let output = harness.directory.path().join("go-example.html");
        let launched = harness
            .capture
            .launch_app(
                &harness.profile_id,
                executable.to_str().unwrap(),
                &[output.to_string_lossy().into_owned()],
            )
            .await
            .expect("launch static Go client under rootless capture");
        wait_for_text(&output, "Example Domain").await;
        assert!(harness.stats.snapshot().flows_proxy >= 1);
        assert_eq!(harness.stats.snapshot().flow_failures, 0);
        harness.capture.stop_app(launched.pid).await.unwrap();
        harness.capture.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_TEST_HTTP_PROXY, Chrome/Chromium, and unprivileged ptrace/seccomp"]
    async fn rootless_capture_supports_chromium_process_tree() {
        let chrome = std::env::var_os("TAOMNI_TEST_CHROME")
            .map(PathBuf::from)
            .or_else(|| {
                ["google-chrome", "chromium", "chromium-browser"]
                    .into_iter()
                    .find_map(|command| which::which(command).ok())
            })
            .expect("set TAOMNI_TEST_CHROME to Chrome or Chromium");
        let mut harness = start_rootless_test_capture().await;
        let user_data = harness.directory.path().join("chrome-profile");
        let screenshot = harness.directory.path().join("example.png");
        let mut arguments = vec![
            "--headless=new".into(),
            "--disable-background-networking".into(),
            "--disable-component-update".into(),
            "--disable-default-apps".into(),
            "--disable-dev-shm-usage".into(),
            "--disable-gpu".into(),
            "--disable-sync".into(),
            "--metrics-recording-only".into(),
            "--no-first-run".into(),
            "--no-proxy-server".into(),
            "--window-size=800,600".into(),
            format!("--user-data-dir={}", user_data.display()),
            format!("--screenshot={}", screenshot.display()),
            "http://example.com/".into(),
        ];
        if unsafe { libc::geteuid() } == 0 {
            arguments.push("--no-sandbox".into());
        }
        let launched = harness
            .capture
            .launch_app(&harness.profile_id, chrome.to_str().unwrap(), &arguments)
            .await
            .expect("launch Chromium under rootless capture");
        wait_for_nonempty_file(&screenshot).await;
        assert!(harness.stats.snapshot().flows_proxy >= 1);
        assert_eq!(harness.stats.snapshot().flow_failures, 0);
        harness.capture.stop_app(launched.pid).await.unwrap();
        harness.capture.stop().await;
    }
}
