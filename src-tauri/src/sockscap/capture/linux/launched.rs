//! Unprivileged Linux capture for applications launched by SocksCap.
//!
//! The launched process loads a small connect interposer.  TCP sockets keep
//! their original file descriptor and nonblocking behaviour, but connect to a
//! loopback listener instead.  Original destinations arrive out-of-band over
//! a private Unix datagram control socket and are matched by the accepted
//! socket's source address. A private environment fallback carries only the
//! loopback ingress/control coordinates, so Chromium-style child launchers can
//! close inherited descriptors without escaping capture. No
//! HTTP_PROXY/ALL_PROXY-style application configuration is involved.

use std::collections::HashMap;
use std::ffi::{CString, OsString};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixDatagram as StdUnixDatagram;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, UnixDatagram};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify, RwLock, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use crate::sockscap::relay::{
    ACCEPT_BACKOFF_INITIAL, ACCEPT_BACKOFF_MAX, CapturedFlow, MAX_ACTIVE_RELAY_FLOWS,
    RELAY_PERMIT_WAIT, RelayContext, RelayHandle, acquire_relay_flow_permit,
    new_relay_flow_limiter,
};

const CONFIG_FD: libc::c_int = 199;
const CONFIG_MAGIC: u32 = 0x544d_5343;
const FLOW_MAGIC: u32 = 0x544d_464c;
const PROTOCOL_VERSION: u16 = 1;
const CONFIG_FLAG_IPV6_READY: u16 = 1;
const FLOW_WAIT: Duration = Duration::from_secs(2);
const MAX_PENDING_FLOWS: usize = 8192;
const PENDING_FLOW_TTL: Duration = Duration::from_secs(10);

static SHIM_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/libtaomni-sockscap-launch.so"));

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct LaunchConfig {
    magic: u32,
    version: u16,
    flags: u16,
    relay_port: u16,
    reserved: u16,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct FlowRegistration {
    magic: u32,
    version: u16,
    family: u16,
    pid: u32,
    fd: i32,
    source_port: u16,
    destination_port: u16,
    source_address: [u8; 16],
    destination_address: [u8; 16],
}

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
    child: Option<Child>,
    process_group: libc::pid_t,
    registration_task: JoinHandle<()>,
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

struct ControlSocketPath {
    path: PathBuf,
    socket: StdUnixDatagram,
}

impl ControlSocketPath {
    fn bind(path: PathBuf) -> Result<Self, String> {
        let socket = StdUnixDatagram::bind(&path).map_err(|error| {
            format!(
                "bind SocksCap launch control socket {}: {error}",
                path.display()
            )
        })?;
        Ok(Self { path, socket })
    }
}

impl Drop for ControlSocketPath {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::debug!(
                path = %self.path.display(),
                "remove SocksCap launch control socket: {error}"
            );
        }
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct FlowKey(SocketAddr);

#[derive(Debug, Clone)]
struct PendingFlow {
    destination: SocketAddr,
    pid: u32,
    process_path: String,
    profile_id: String,
    registered_at: Instant,
}

#[derive(Default)]
struct FlowRegistry {
    pending: Mutex<HashMap<FlowKey, PendingFlow>>,
    changed: Notify,
}

impl FlowRegistry {
    async fn insert(&self, source: SocketAddr, flow: PendingFlow) {
        let mut pending = self.pending.lock().await;
        if pending.len() >= MAX_PENDING_FLOWS {
            let now = Instant::now();
            pending.retain(|_, value| now.duration_since(value.registered_at) < PENDING_FLOW_TTL);
        }
        if pending.len() >= MAX_PENDING_FLOWS {
            if let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, value)| value.registered_at)
                .map(|(key, _)| key.clone())
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(FlowKey(source), flow);
        drop(pending);
        self.changed.notify_waiters();
    }

    async fn wait_take(&self, source: SocketAddr) -> Option<PendingFlow> {
        let deadline = tokio::time::Instant::now() + FLOW_WAIT;
        loop {
            let notified = self.changed.notified();
            if let Some(flow) = self.pending.lock().await.remove(&FlowKey(source)) {
                if flow.registered_at.elapsed() < PENDING_FLOW_TTL {
                    return Some(flow);
                }
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return None;
            }
            if tokio::time::timeout(deadline - now, notified)
                .await
                .is_err()
            {
                return None;
            }
        }
    }
}

/// Lifecycle for the launch-only backend.  It owns no system network state, so
/// stop can always return to Idle after closing its children and listener.
pub struct LaunchedCaptureHandle {
    relay: Option<RelayHandle>,
    relay_port: u16,
    ipv6_ready: bool,
    registry: Arc<FlowRegistry>,
    shim_path: PathBuf,
    runtime_dir: PathBuf,
    processes: Vec<LaunchedProcess>,
}

impl LaunchedCaptureHandle {
    pub async fn start(ctx: Arc<RwLock<RelayContext>>, runtime_dir: &Path) -> Result<Self, String> {
        let shim_path = materialize_shim(runtime_dir)?;
        let registry = Arc::new(FlowRegistry::default());
        let (relay, ipv6_ready) = start_redirect_ingress(ctx, Arc::clone(&registry)).await?;
        let relay_port = relay.port;
        Ok(Self {
            relay: Some(relay),
            relay_port,
            ipv6_ready,
            registry,
            shim_path,
            runtime_dir: runtime_dir.to_path_buf(),
            processes: Vec::new(),
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
        let control_path = self
            .runtime_dir
            .join(format!("launch-{}.sock", uuid::Uuid::new_v4()));
        let control_path_guard = ControlSocketPath::bind(control_path)?;
        let parent_control = control_path_guard
            .socket
            .try_clone()
            .map_err(|error| format!("clone SocksCap launch control socket: {error}"))?;
        parent_control
            .set_nonblocking(true)
            .map_err(|error| format!("configure SocksCap launch control socket: {error}"))?;
        let config_file = create_config_memfd(self.relay_port, self.ipv6_ready)?;
        let config_fd = duplicate_for_child(config_file.as_raw_fd())
            .map_err(|error| format!("prepare SocksCap launch config descriptor: {error}"))?;
        let config_raw = config_fd.as_raw_fd();

        let mut command = Command::new(&executable);
        command.args(args);
        let preload = match std::env::var_os("LD_PRELOAD") {
            Some(existing) if !existing.is_empty() => {
                let mut value = self.shim_path.as_os_str().to_os_string();
                value.push(":");
                value.push(existing);
                value
            }
            _ => self.shim_path.as_os_str().to_os_string(),
        };
        command.env("LD_PRELOAD", preload);
        command.env(
            "TAOMNI_SOCKSCAP_CONTROL_PATH",
            control_path_guard.path.as_os_str(),
        );
        command.env("TAOMNI_SOCKSCAP_RELAY_PORT", self.relay_port.to_string());
        command.env(
            "TAOMNI_SOCKSCAP_IPV6_READY",
            if self.ipv6_ready { "1" } else { "0" },
        );
        command.kill_on_drop(false);
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                duplicate_inherited_fd(config_raw, CONFIG_FD)?;
                Ok(())
            });
        }
        let child = command
            .spawn()
            .map_err(|error| format!("launch {command_name} through SocksCap: {error}"))?;
        drop(config_file);
        drop(config_fd);

        let pid = child.id().ok_or_else(|| {
            "launched application exited before its PID was available".to_string()
        })?;
        let process_path = executable.to_string_lossy().into_owned();
        let registration_task = spawn_registration_reader(
            parent_control,
            Arc::clone(&self.registry),
            profile_id.to_string(),
            process_path.clone(),
            control_path_guard,
        )?;
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
            "SocksCap launched application with rootless capture"
        );
        self.processes.push(LaunchedProcess {
            info: info.clone(),
            child: Some(child),
            process_group: pid as libc::pid_t,
            registration_task,
            terminal_running: None,
        });
        Ok(info)
    }

    /// Launch an interactive command in a controlling PTY while applying the
    /// same connect interposer as desktop launch mode. The returned PTY is
    /// registered with Taomni's terminal subsystem by the Tauri command layer.
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
        let control_path = self
            .runtime_dir
            .join(format!("launch-{}.sock", uuid::Uuid::new_v4()));
        let control_path_guard = ControlSocketPath::bind(control_path)?;
        let parent_control = control_path_guard
            .socket
            .try_clone()
            .map_err(|error| format!("clone SocksCap launch control socket: {error}"))?;
        parent_control
            .set_nonblocking(true)
            .map_err(|error| format!("configure SocksCap launch control socket: {error}"))?;

        let environment = launch_environment(
            &self.shim_path,
            &control_path_guard.path,
            self.relay_port,
            self.ipv6_ready,
        );
        let executable_text = executable.to_string_lossy().into_owned();
        let (mut handle, reader) = crate::terminal::pty::create_command_pty_with_environment(
            cols,
            rows,
            &executable_text,
            args,
            &environment,
        )?;
        let pid = handle.child.process_id().ok_or_else(|| {
            "terminal application exited before its PID was available".to_string()
        })?;
        let registration_task = match spawn_registration_reader(
            parent_control,
            Arc::clone(&self.registry),
            profile_id.to_string(),
            executable_text.clone(),
            control_path_guard,
        ) {
            Ok(task) => task,
            Err(error) => {
                let _ = handle.child.kill();
                return Err(error);
            }
        };
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
            "SocksCap launched terminal application with rootless capture"
        );
        let terminal_running = Arc::new(AtomicBool::new(true));
        let tracked_reader: Box<dyn Read + Send> = Box::new(TerminalActivityReader {
            inner: reader,
            running: Arc::clone(&terminal_running),
        });
        self.processes.push(LaunchedProcess {
            info: info.clone(),
            child: None,
            process_group: pid as libc::pid_t,
            registration_task,
            terminal_running: Some(terminal_running),
        });
        Ok((info, handle, tracked_reader))
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
                    process.registration_task.abort();
                    continue;
                }
                if let Some(child) = process.child.as_mut() {
                    if let Err(error) = child.try_wait() {
                        tracing::warn!(pid = process.info.pid, "read launched app status: {error}");
                    }
                }
                process.info.running = process_group_is_alive(process.process_group);
                if !process.info.running {
                    process.registration_task.abort();
                }
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
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
    }
}

fn process_group_is_alive(process_group: libc::pid_t) -> bool {
    let result = unsafe { libc::kill(-process_group, 0) };
    result == 0 || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
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
            if let Some(child) = process.child.as_mut() {
                let _ = child.try_wait();
            }
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
    if let Some(child) = process.child.as_mut() {
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }
    process.info.running = false;
    if let Some(running) = &process.terminal_running {
        running.store(false, Ordering::Release);
    }
    process.registration_task.abort();
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

fn launch_environment(
    shim_path: &Path,
    control_path: &Path,
    relay_port: u16,
    ipv6_ready: bool,
) -> Vec<(OsString, OsString)> {
    let preload = match std::env::var_os("LD_PRELOAD") {
        Some(existing) if !existing.is_empty() => {
            let mut value = shim_path.as_os_str().to_os_string();
            value.push(":");
            value.push(existing);
            value
        }
        _ => shim_path.as_os_str().to_os_string(),
    };
    vec![
        (OsString::from("LD_PRELOAD"), preload),
        (
            OsString::from("TAOMNI_SOCKSCAP_CONTROL_PATH"),
            control_path.as_os_str().to_os_string(),
        ),
        (
            OsString::from("TAOMNI_SOCKSCAP_RELAY_PORT"),
            OsString::from(relay_port.to_string()),
        ),
        (
            OsString::from("TAOMNI_SOCKSCAP_IPV6_READY"),
            OsString::from(if ipv6_ready { "1" } else { "0" }),
        ),
    ]
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

fn materialize_shim(runtime_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(runtime_dir)
        .map_err(|error| format!("create SocksCap runtime directory: {error}"))?;
    fs::set_permissions(runtime_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("secure SocksCap runtime directory: {error}"))?;
    let path = runtime_dir.join("libtaomni-sockscap-launch.so");
    if fs::read(&path).ok().as_deref() == Some(SHIM_BYTES) {
        return Ok(path);
    }
    let temporary = runtime_dir.join(format!(
        ".libtaomni-sockscap-launch-{}.tmp",
        std::process::id()
    ));
    let mut file = File::create(&temporary)
        .map_err(|error| format!("create SocksCap launch shim: {error}"))?;
    file.write_all(SHIM_BYTES)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("write SocksCap launch shim: {error}"))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("set SocksCap launch shim permissions: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("install SocksCap launch shim: {error}"))?;
    Ok(path)
}

fn create_config_memfd(relay_port: u16, ipv6_ready: bool) -> Result<File, String> {
    let name = CString::new("taomni-sockscap-launch")
        .map_err(|error| format!("create memfd name: {error}"))?;
    let fd = unsafe { libc::syscall(libc::SYS_memfd_create, name.as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(format!(
            "create SocksCap launch configuration: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut file = unsafe { File::from_raw_fd(fd as libc::c_int) };
    let config = LaunchConfig {
        magic: CONFIG_MAGIC,
        version: PROTOCOL_VERSION,
        flags: if ipv6_ready {
            CONFIG_FLAG_IPV6_READY
        } else {
            0
        },
        relay_port,
        reserved: 0,
    };
    let bytes = unsafe {
        std::slice::from_raw_parts(
            (&config as *const LaunchConfig).cast::<u8>(),
            std::mem::size_of::<LaunchConfig>(),
        )
    };
    file.write_all(bytes)
        .map_err(|error| format!("write SocksCap launch configuration: {error}"))?;
    Ok(file)
}

fn duplicate_inherited_fd(source: libc::c_int, destination: libc::c_int) -> std::io::Result<()> {
    if source != destination && unsafe { libc::dup2(source, destination) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(destination, libc::F_SETFD, 0) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn duplicate_for_child(source: libc::c_int) -> std::io::Result<OwnedFd> {
    let duplicated = unsafe { libc::fcntl(source, libc::F_DUPFD_CLOEXEC, 256) };
    if duplicated < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn spawn_registration_reader(
    socket: StdUnixDatagram,
    registry: Arc<FlowRegistry>,
    profile_id: String,
    configured_path: String,
    control_path: ControlSocketPath,
) -> Result<JoinHandle<()>, String> {
    let socket = UnixDatagram::from_std(socket)
        .map_err(|error| format!("adopt SocksCap launch control socket: {error}"))?;
    Ok(tokio::spawn(async move {
        // Keep the bound filesystem socket alive for every descendant. It is
        // removed automatically when this task exits or is aborted.
        let _control_path = control_path;
        let mut buffer = [0u8; 256];
        let mut reported_first_flow = false;
        loop {
            let count = match socket.recv(&mut buffer).await {
                Ok(count) => count,
                Err(error) => {
                    tracing::debug!("SocksCap launch control socket closed: {error}");
                    break;
                }
            };
            let Some(registration) = decode_registration(&buffer[..count]) else {
                tracing::warn!("ignored malformed SocksCap launch flow registration");
                continue;
            };
            let Some(source) = registration.source() else {
                continue;
            };
            let Some(destination) = registration.destination() else {
                continue;
            };
            if !reported_first_flow {
                tracing::info!(
                    pid = registration.pid,
                    %destination,
                    "SocksCap received the first rootless flow registration"
                );
                reported_first_flow = true;
            }
            let process_path = fs::read_link(format!("/proc/{}/exe", registration.pid))
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| configured_path.clone());
            registry
                .insert(
                    source,
                    PendingFlow {
                        destination,
                        pid: registration.pid,
                        process_path,
                        profile_id: profile_id.clone(),
                        registered_at: Instant::now(),
                    },
                )
                .await;
        }
    }))
}

fn decode_registration(bytes: &[u8]) -> Option<FlowRegistration> {
    if bytes.len() != std::mem::size_of::<FlowRegistration>() {
        return None;
    }
    let registration: FlowRegistration = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) };
    (registration.magic == FLOW_MAGIC && registration.version == PROTOCOL_VERSION)
        .then_some(registration)
}

impl FlowRegistration {
    fn source(&self) -> Option<SocketAddr> {
        socket_address(self.family, self.source_address, self.source_port)
    }

    fn destination(&self) -> Option<SocketAddr> {
        socket_address(self.family, self.destination_address, self.destination_port)
    }
}

fn socket_address(family: u16, bytes: [u8; 16], port: u16) -> Option<SocketAddr> {
    match family as libc::c_int {
        libc::AF_INET => Some(SocketAddr::V4(SocketAddrV4::new(
            Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]),
            port,
        ))),
        libc::AF_INET6 => Some(SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::from(bytes),
            port,
            0,
            0,
        ))),
        _ => None,
    }
}

async fn start_redirect_ingress(
    ctx: Arc<RwLock<RelayContext>>,
    registry: Arc<FlowRegistry>,
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
            Arc::clone(&registry),
            Arc::clone(&stop_for_task),
            Arc::clone(&limiter),
        );
        if let Some(listener_v6) = listener_v6 {
            let v6 = accept_loop(listener_v6, ctx, registry, stop_for_task, limiter);
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
    registry: Arc<FlowRegistry>,
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
        let registry = Arc::clone(&registry);
        clients.spawn(async move {
            let _permit = permit;
            let flow = registry
                .wait_take(peer)
                .await
                .ok_or_else(|| format!("no launch flow registration for {peer}"));
            match flow {
                Ok(flow) => {
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
                        tracing::warn!("Linux launch relay client {peer}: {error}");
                    }
                }
                Err(error) => tracing::warn!("Linux launch relay client {peer}: {error}"),
            }
        });
    }
    clients.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek};

    #[test]
    fn protocol_layout_matches_the_c_interposer() {
        assert_eq!(std::mem::size_of::<LaunchConfig>(), 12);
        assert_eq!(std::mem::size_of::<FlowRegistration>(), 52);
    }

    #[test]
    fn decodes_ipv4_registration() {
        let mut registration = FlowRegistration {
            magic: FLOW_MAGIC,
            version: PROTOCOL_VERSION,
            family: libc::AF_INET as u16,
            pid: 42,
            fd: 7,
            source_port: 32000,
            destination_port: 443,
            source_address: [0; 16],
            destination_address: [0; 16],
        };
        registration.source_address[..4].copy_from_slice(&[127, 0, 0, 1]);
        registration.destination_address[..4].copy_from_slice(&[93, 184, 216, 34]);
        assert_eq!(
            registration.source().unwrap(),
            "127.0.0.1:32000".parse().unwrap()
        );
        assert_eq!(
            registration.destination().unwrap(),
            "93.184.216.34:443".parse().unwrap()
        );
    }

    #[test]
    fn launch_config_records_ipv6_availability() {
        let mut file = create_config_memfd(43123, true).unwrap();
        file.rewind().unwrap();
        let mut bytes = [0u8; std::mem::size_of::<LaunchConfig>()];
        file.read_exact(&mut bytes).unwrap();
        let config = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<LaunchConfig>()) };
        assert_eq!(config.magic, CONFIG_MAGIC);
        assert_eq!(config.version, PROTOCOL_VERSION);
        assert_eq!(config.relay_port, 43123);
        assert_eq!(config.flags, CONFIG_FLAG_IPV6_READY);
    }

    #[test]
    fn materialized_shim_is_private_and_stable() {
        let directory = tempfile::tempdir().unwrap();
        let first = materialize_shim(directory.path()).unwrap();
        let second = materialize_shim(directory.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(fs::read(&first).unwrap(), SHIM_BYTES);
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

    #[test]
    fn filesystem_control_socket_survives_descriptor_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let control = ControlSocketPath::bind(path.clone()).unwrap();
        control
            .socket
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let sender = StdUnixDatagram::unbound().unwrap();
        sender.send_to(b"flow", &path).unwrap();
        let mut message = [0u8; 16];
        let count = control.socket.recv(&mut message).unwrap();
        assert_eq!(&message[..count], b"flow");
        drop(control);
        assert!(!path.exists());
    }
}
