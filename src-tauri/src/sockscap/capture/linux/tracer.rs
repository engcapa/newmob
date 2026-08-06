//! ptrace/seccomp supervisor for unprivileged Linux application capture.
//!
//! The launcher installs a seccomp filter that reports `socket(2)` and
//! `connect(2)`. This supervisor follows the complete process tree, tracks
//! socket types, temporarily rewrites TCP destinations to the rootless
//! loopback ingress, and restores application memory after the syscall returns.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

const TRACE_POLL_INTERVAL: Duration = Duration::from_millis(5);
const TRACE_START_TIMEOUT: Duration = Duration::from_secs(3);
const FLOW_CLAIM_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PENDING_FLOWS: usize = 8192;
const LINUX_SOCK_TYPE_MASK: libc::c_int = 0xf;

#[derive(Debug, Clone)]
pub struct ProcessIdentity {
    pub profile_id: String,
    pub configured_path: String,
}

#[derive(Debug, Clone)]
pub struct TracedFlow {
    pub destination: SocketAddr,
    pub pid: u32,
    pub process_path: String,
    pub profile_id: String,
}

struct QueuedFlow {
    id: u64,
    flow: TracedFlow,
}

#[derive(Default)]
struct FlowQueueState {
    pending: VecDeque<QueuedFlow>,
}

/// Synchronous producer/asynchronous consumer handoff between the tracer and
/// loopback ingress. The tracer executes one rewritten connect at a time, so
/// accept order is an exact and race-free flow identity.
#[derive(Default)]
pub struct FlowQueue {
    state: Mutex<FlowQueueState>,
    claimed: Condvar,
    available: Notify,
    next_id: AtomicU64,
}

impl FlowQueue {
    fn push(&self, flow: TracedFlow) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "rootless flow queue lock is poisoned".to_string())?;
        if state.pending.len() >= MAX_PENDING_FLOWS {
            return Err(format!(
                "rootless flow queue reached its {MAX_PENDING_FLOWS}-connection limit"
            ));
        }
        state.pending.push_back(QueuedFlow { id, flow });
        drop(state);
        self.available.notify_waiters();
        Ok(id)
    }

    fn cancel(&self, id: u64) {
        if let Ok(mut state) = self.state.lock()
            && let Some(index) = state.pending.iter().position(|entry| entry.id == id)
        {
            state.pending.remove(index);
            self.claimed.notify_all();
        }
    }

    fn wait_claimed(&self, id: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        loop {
            if !state.pending.iter().any(|entry| entry.id == id) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let Ok((next, result)) = self.claimed.wait_timeout(state, deadline - now) else {
                return false;
            };
            state = next;
            if result.timed_out() {
                return !state.pending.iter().any(|entry| entry.id == id);
            }
        }
    }

    pub async fn wait_take(&self, timeout: Duration) -> Option<TracedFlow> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.available.notified();
            if let Ok(mut state) = self.state.lock()
                && let Some(entry) = state.pending.pop_front()
            {
                self.claimed.notify_all();
                return Some(entry.flow);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline
                || tokio::time::timeout(deadline - now, notified)
                    .await
                    .is_err()
            {
                return None;
            }
        }
    }
}

enum TraceCommand {
    SpawnDesktop {
        launcher: PathBuf,
        launch: LaunchCommand,
        response: mpsc::Sender<Result<u32, String>>,
    },
    SpawnTerminal {
        launcher: PathBuf,
        launch: LaunchCommand,
        cols: u16,
        rows: u16,
        response: mpsc::Sender<Result<SpawnedTerminal, String>>,
    },
    Register {
        pid: libc::pid_t,
        identity: ProcessIdentity,
        execs_until_running: u8,
        ready: mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

pub type SpawnedTerminal = (u32, crate::terminal::pty::PtyHandle, Box<dyn Read + Send>);

#[derive(Debug, Clone)]
pub struct LaunchCommand {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_directory: Option<PathBuf>,
    pub environment: Vec<(OsString, OsString)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchStatus {
    Preparing,
    Running,
    Exited,
    Failed(String),
}

#[derive(Debug, Clone)]
struct LaunchLifecycle {
    status: LaunchStatus,
    execs_until_running: u8,
}

impl LaunchLifecycle {
    fn new(execs_until_running: u8) -> Self {
        Self {
            status: LaunchStatus::Preparing,
            execs_until_running,
        }
    }

    fn observe_exec(&mut self) {
        if !matches!(self.status, LaunchStatus::Preparing) {
            return;
        }
        self.execs_until_running = self.execs_until_running.saturating_sub(1);
        if self.execs_until_running == 0 {
            self.status = LaunchStatus::Running;
        }
    }

    fn finish(&mut self, failure: String) {
        self.status = if matches!(self.status, LaunchStatus::Preparing) {
            LaunchStatus::Failed(failure)
        } else {
            LaunchStatus::Exited
        };
    }
}

pub struct TracerSupervisor {
    commands: mpsc::Sender<TraceCommand>,
    launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
    thread: Option<JoinHandle<()>>,
}

impl TracerSupervisor {
    pub fn start(relay_port: u16, ipv6_ready: bool, flows: Arc<FlowQueue>) -> Self {
        let (commands, receiver) = mpsc::channel();
        let launch_lifecycles = Arc::new(Mutex::new(HashMap::new()));
        let thread_lifecycles = Arc::clone(&launch_lifecycles);
        let thread = std::thread::Builder::new()
            .name("sockscap-ptrace".into())
            .spawn(move || trace_loop(receiver, flows, relay_port, ipv6_ready, thread_lifecycles))
            .expect("spawn SocksCap ptrace supervisor");
        Self {
            commands,
            launch_lifecycles,
            thread: Some(thread),
        }
    }

    pub fn spawn_desktop(&self, launcher: &Path, launch: &LaunchCommand) -> Result<u32, String> {
        let (response, result) = mpsc::channel();
        self.commands
            .send(TraceCommand::SpawnDesktop {
                launcher: launcher.to_path_buf(),
                launch: launch.clone(),
                response,
            })
            .map_err(|_| "SocksCap ptrace supervisor stopped before launch".to_string())?;
        result
            .recv_timeout(TRACE_START_TIMEOUT)
            .map_err(|_| "timed out waiting for the SocksCap launcher".to_string())?
    }

    pub fn spawn_terminal(
        &self,
        launcher: &Path,
        launch: &LaunchCommand,
        cols: u16,
        rows: u16,
    ) -> Result<SpawnedTerminal, String> {
        let (response, result) = mpsc::channel();
        self.commands
            .send(TraceCommand::SpawnTerminal {
                launcher: launcher.to_path_buf(),
                launch: launch.clone(),
                cols,
                rows,
                response,
            })
            .map_err(|_| "SocksCap ptrace supervisor stopped before terminal launch".to_string())?;
        result
            .recv_timeout(TRACE_START_TIMEOUT)
            .map_err(|_| "timed out waiting for the SocksCap terminal launcher".to_string())?
    }

    pub fn register_root(
        &self,
        pid: u32,
        identity: ProcessIdentity,
        execs_until_running: u8,
    ) -> Result<(), String> {
        let (ready, response) = mpsc::channel();
        self.commands
            .send(TraceCommand::Register {
                pid: pid as libc::pid_t,
                identity,
                execs_until_running,
                ready,
            })
            .map_err(|_| "SocksCap ptrace supervisor stopped before launch".to_string())?;
        response.recv_timeout(TRACE_START_TIMEOUT).map_err(|_| {
            "timed out waiting for the launched application to enter ptrace".to_string()
        })?
    }

    pub fn launch_status(&self, pid: u32) -> Option<LaunchStatus> {
        self.launch_lifecycles
            .lock()
            .ok()?
            .get(&(pid as libc::pid_t))
            .map(|lifecycle| lifecycle.status.clone())
    }

    pub fn shutdown(&mut self) {
        let _ = self.commands.send(TraceCommand::Shutdown);
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::warn!("SocksCap ptrace supervisor panicked during shutdown");
        }
    }
}

impl Drop for TracerSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct TraceState {
    identities: HashMap<libc::pid_t, ProcessIdentity>,
    initialized: HashSet<libc::pid_t>,
    launch_ready: HashMap<libc::pid_t, mpsc::Sender<Result<(), String>>>,
    deferred_statuses: HashMap<libc::pid_t, libc::c_int>,
    socket_types: HashMap<String, libc::c_int>,
    launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
}

impl TraceState {
    fn new(launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>) -> Self {
        Self {
            identities: HashMap::new(),
            initialized: HashSet::new(),
            launch_ready: HashMap::new(),
            deferred_statuses: HashMap::new(),
            socket_types: HashMap::new(),
            launch_lifecycles,
        }
    }

    fn remove(&mut self, pid: libc::pid_t, detail: &str) {
        self.identities.remove(&pid);
        self.initialized.remove(&pid);
        self.deferred_statuses.remove(&pid);
        if let Some(ready) = self.launch_ready.remove(&pid) {
            let _ = ready.send(Err(detail.to_string()));
        }
        if let Ok(mut lifecycles) = self.launch_lifecycles.lock()
            && let Some(lifecycle) = lifecycles.get_mut(&pid)
        {
            lifecycle.finish(detail.to_string());
        }
    }

    fn observe_exec(&self, pid: libc::pid_t) {
        if let Ok(mut lifecycles) = self.launch_lifecycles.lock()
            && let Some(lifecycle) = lifecycles.get_mut(&pid)
        {
            lifecycle.observe_exec();
        }
    }
}

fn trace_loop(
    receiver: mpsc::Receiver<TraceCommand>,
    flows: Arc<FlowQueue>,
    relay_port: u16,
    ipv6_ready: bool,
    launch_lifecycles: Arc<Mutex<HashMap<libc::pid_t, LaunchLifecycle>>>,
) {
    let mut state = TraceState::new(launch_lifecycles);
    loop {
        while let Ok(command) = receiver.try_recv() {
            if handle_trace_command(command, &mut state) {
                return;
            }
        }

        let mut handled_event = false;
        let registered_deferred = state
            .deferred_statuses
            .keys()
            .filter(|pid| state.identities.contains_key(pid))
            .copied()
            .collect::<Vec<_>>();
        for pid in registered_deferred {
            let Some(status) = state.deferred_statuses.remove(&pid) else {
                continue;
            };
            handled_event = true;
            handle_wait_status(pid, status, &mut state, &flows, relay_port, ipv6_ready);
        }

        loop {
            let mut status = 0;
            let waited = unsafe {
                libc::waitpid(
                    -1,
                    &mut status,
                    libc::WNOHANG | libc::WUNTRACED | libc::__WALL | libc::__WNOTHREAD,
                )
            };
            if waited == 0 {
                break;
            }
            if waited < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ECHILD) {
                    tracing::warn!("wait for traced process tree: {error}");
                }
                break;
            }
            handled_event = true;
            if state.identities.contains_key(&waited) {
                handle_wait_status(waited, status, &mut state, &flows, relay_port, ipv6_ready);
            } else {
                // A launcher can enter its initial SIGSTOP between the spawn
                // response and Register command. A clone child can likewise
                // stop before its parent's event is consumed. Keep that one
                // status until the tracee identity becomes available.
                state.deferred_statuses.insert(waited, status);
            }
        }

        if handled_event {
            continue;
        }
        match receiver.recv_timeout(TRACE_POLL_INTERVAL) {
            Ok(command) => {
                if handle_trace_command(command, &mut state) {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn handle_trace_command(command: TraceCommand, state: &mut TraceState) -> bool {
    match command {
        TraceCommand::SpawnDesktop {
            launcher,
            launch,
            response,
        } => {
            let _ = response.send(spawn_desktop(launcher, launch));
            false
        }
        TraceCommand::SpawnTerminal {
            launcher,
            launch,
            cols,
            rows,
            response,
        } => {
            let _ = response.send(spawn_terminal(launcher, launch, cols, rows));
            false
        }
        TraceCommand::Register {
            pid,
            identity,
            execs_until_running,
            ready,
        } => {
            if state.identities.insert(pid, identity).is_some() {
                let _ = ready.send(Err(format!(
                    "application PID {pid} is already registered with SocksCap"
                )));
            } else {
                if let Ok(mut lifecycles) = state.launch_lifecycles.lock() {
                    lifecycles.insert(pid, LaunchLifecycle::new(execs_until_running));
                }
                state.launch_ready.insert(pid, ready);
            }
            false
        }
        TraceCommand::Shutdown => true,
    }
}

fn spawn_desktop(launcher: PathBuf, launch: LaunchCommand) -> Result<u32, String> {
    let mut command = Command::new(&launcher);
    command.arg(&launch.executable);
    command.args(&launch.args);
    command.envs(launch.environment);
    if let Some(directory) = &launch.working_directory {
        command.current_dir(directory);
    }
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| {
        format!(
            "launch {} through SocksCap: {error}",
            launch.executable.display()
        )
    })?;
    let pid = child.id();
    drop(child);
    Ok(pid)
}

fn spawn_terminal(
    launcher: PathBuf,
    launch: LaunchCommand,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, String> {
    let launcher = launcher.to_string_lossy().into_owned();
    let executable = launch.executable.to_string_lossy().into_owned();
    let mut launcher_args = Vec::with_capacity(launch.args.len() + 1);
    launcher_args.push(executable);
    launcher_args.extend(launch.args);
    let (handle, reader) = crate::terminal::pty::create_command_pty_with_launch_options(
        cols,
        rows,
        &launcher,
        &launcher_args,
        launch
            .working_directory
            .map(|path| path.to_string_lossy().into_owned()),
        &launch.environment,
    )?;
    let pid = handle
        .child
        .process_id()
        .ok_or_else(|| "terminal application exited before its PID was available".to_string())?;
    Ok((pid, handle, reader))
}

fn handle_wait_status(
    pid: libc::pid_t,
    status: libc::c_int,
    state: &mut TraceState,
    flows: &FlowQueue,
    relay_port: u16,
    ipv6_ready: bool,
) {
    if libc::WIFEXITED(status) {
        let code = libc::WEXITSTATUS(status);
        state.remove(
            pid,
            &format!("application PID {pid} exited with status {code} before the target started"),
        );
        return;
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        state.remove(
            pid,
            &format!(
                "application PID {pid} was terminated by signal {signal} before the target started"
            ),
        );
        return;
    }
    if !libc::WIFSTOPPED(status) {
        return;
    }

    let signal = libc::WSTOPSIG(status);
    let event = status >> 16;
    if !state.initialized.contains(&pid) {
        match initialize_tracee(pid) {
            Ok(()) => {
                state.initialized.insert(pid);
                if let Some(ready) = state.launch_ready.remove(&pid) {
                    let _ = ready.send(Ok(()));
                }
                if let Err(error) = ptrace_resume(pid, libc::PTRACE_CONT, 0) {
                    tracing::warn!(pid, "resume newly traced application: {error}");
                }
            }
            Err(error) => {
                if let Some(ready) = state.launch_ready.remove(&pid) {
                    let _ = ready.send(Err(error.clone()));
                }
                tracing::warn!(pid, "initialize rootless trace: {error}");
                kill_tracee(pid);
            }
        }
        return;
    }

    if event == libc::PTRACE_EVENT_SECCOMP {
        let registers = match syscall_registers(pid) {
            Ok(registers) => registers,
            Err(error) => {
                tracing::warn!(pid, "read seccomp syscall: {error}");
                kill_tracee(pid);
                return;
            }
        };
        if registers.number() == libc::SYS_socket {
            if let Err(error) = handle_socket(pid, &registers, &mut state.socket_types) {
                tracing::warn!(pid, "observe rootless socket syscall: {error}");
                kill_tracee(pid);
            }
            return;
        }
        let Some(identity) = state.identities.get(&pid).cloned() else {
            kill_tracee(pid);
            return;
        };
        if let Err(error) = handle_connect(
            pid,
            &identity,
            &state.socket_types,
            flows,
            relay_port,
            ipv6_ready,
        ) {
            tracing::warn!(pid, "capture rootless connect syscall: {error}");
            kill_tracee(pid);
        }
        return;
    }

    if matches!(
        event,
        libc::PTRACE_EVENT_FORK | libc::PTRACE_EVENT_VFORK | libc::PTRACE_EVENT_CLONE
    ) {
        match ptrace_event_pid(pid) {
            Ok(child) => {
                if let Some(identity) = state.identities.get(&pid).cloned() {
                    state.identities.insert(child, identity);
                    state.initialized.insert(child);
                }
            }
            Err(error) => tracing::warn!(pid, "read traced child PID: {error}"),
        }
        let _ = ptrace_resume(pid, libc::PTRACE_CONT, 0);
        return;
    }

    if event == libc::PTRACE_EVENT_EXEC {
        state.observe_exec(pid);
        let _ = ptrace_resume(pid, libc::PTRACE_CONT, 0);
        return;
    }

    if event != 0 || signal == libc::SIGTRAP {
        let _ = ptrace_resume(pid, libc::PTRACE_CONT, 0);
        return;
    }

    // Automatically attached children first report SIGSTOP. Other signals are
    // real signal-delivery stops and must remain visible to the application.
    let delivered_signal = if signal == libc::SIGSTOP { 0 } else { signal };
    let _ = ptrace_resume(pid, libc::PTRACE_CONT, delivered_signal);
}

fn initialize_tracee(pid: libc::pid_t) -> Result<(), String> {
    let options = libc::PTRACE_O_EXITKILL
        | libc::PTRACE_O_TRACESYSGOOD
        | libc::PTRACE_O_TRACEFORK
        | libc::PTRACE_O_TRACEVFORK
        | libc::PTRACE_O_TRACECLONE
        | libc::PTRACE_O_TRACEEXEC
        | libc::PTRACE_O_TRACESECCOMP;
    ptrace_call(
        libc::PTRACE_SETOPTIONS,
        pid,
        std::ptr::null_mut(),
        options as usize as *mut libc::c_void,
    )
    .map(|_| ())
    .map_err(|error| format!("configure ptrace options for PID {pid}: {error}"))
}

fn ptrace_event_pid(pid: libc::pid_t) -> Result<libc::pid_t, String> {
    let mut child: libc::c_ulong = 0;
    ptrace_call(
        libc::PTRACE_GETEVENTMSG,
        pid,
        std::ptr::null_mut(),
        (&mut child as *mut libc::c_ulong).cast(),
    )
    .map_err(|error| format!("PTRACE_GETEVENTMSG: {error}"))?;
    Ok(child as libc::pid_t)
}

fn handle_connect(
    pid: libc::pid_t,
    identity: &ProcessIdentity,
    socket_types: &HashMap<String, libc::c_int>,
    flows: &FlowQueue,
    relay_port: u16,
    ipv6_ready: bool,
) -> Result<(), String> {
    let registers = syscall_registers(pid)?;
    let arguments = registers.connect_arguments()?;
    if arguments.address == 0
        || arguments.length < 2
        || !socket_is_stream(pid, arguments.fd, socket_types)
    {
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    }

    let target = read_socket_address(pid, arguments.address, arguments.length)?;
    let Some((destination, original)) = target else {
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    };
    if destination.ip().is_loopback() {
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    }
    // A host with IPv6 disabled cannot accept the rewritten connection. Route
    // that attempt to the reserved local port 0 so the kernel returns a normal
    // connection error and Happy Eyeballs clients can fall back to IPv4.
    let ingress_port = if destination.is_ipv6() && !ipv6_ready {
        0
    } else {
        relay_port
    };
    let replacement = encode_loopback(destination, ingress_port, original.len())?;

    if ingress_port == 0 {
        write_process_memory(pid, arguments.address, &replacement)?;
        if let Err(error) = ptrace_resume(pid, libc::PTRACE_SYSCALL, 0) {
            let _ = write_process_memory(pid, arguments.address, &original);
            return Err(error);
        }
        let syscall_result = wait_for_syscall_exit(pid);
        let restore_result = write_process_memory(pid, arguments.address, &original);
        syscall_result?;
        restore_result?;
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    }

    let process_path = fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| identity.configured_path.clone());
    let flow_id = flows.push(TracedFlow {
        destination,
        pid: pid as u32,
        process_path,
        profile_id: identity.profile_id.clone(),
    })?;

    if let Err(error) = write_process_memory(pid, arguments.address, &replacement) {
        flows.cancel(flow_id);
        return Err(error);
    }
    if let Err(error) = ptrace_resume(pid, libc::PTRACE_SYSCALL, 0) {
        let _ = write_process_memory(pid, arguments.address, &original);
        flows.cancel(flow_id);
        return Err(error);
    }

    let syscall_result = wait_for_syscall_exit(pid);
    let restore_result = write_process_memory(pid, arguments.address, &original);
    let syscall_result = syscall_result?;
    restore_result?;

    if connect_started(syscall_result) {
        if !flows.wait_claimed(flow_id, FLOW_CLAIM_TIMEOUT) {
            flows.cancel(flow_id);
            return Err(format!(
                "loopback ingress did not accept the rewritten connection to {destination}"
            ));
        }
    } else {
        flows.cancel(flow_id);
    }
    ptrace_resume(pid, libc::PTRACE_CONT, 0)
}

fn handle_socket(
    pid: libc::pid_t,
    registers: &SyscallRegisters,
    socket_types: &mut HashMap<String, libc::c_int>,
) -> Result<(), String> {
    let arguments = registers.socket_arguments()?;
    ptrace_resume(pid, libc::PTRACE_SYSCALL, 0)?;
    let fd = wait_for_syscall_exit(pid)?;
    if fd >= 0
        && matches!(arguments.domain, libc::AF_INET | libc::AF_INET6)
        && let Some(inode) = socket_inode(pid, fd as libc::c_int)
    {
        if socket_types.len() >= 65_536 {
            socket_types.clear();
        }
        socket_types.insert(inode, arguments.socket_type & LINUX_SOCK_TYPE_MASK);
    }
    ptrace_resume(pid, libc::PTRACE_CONT, 0)
}

fn wait_for_syscall_exit(pid: libc::pid_t) -> Result<i64, String> {
    loop {
        let mut status = 0;
        if unsafe { libc::waitpid(pid, &mut status, libc::__WALL) } < 0 {
            return Err(format!(
                "wait for connect syscall exit: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
            return Err("application exited during connect syscall".into());
        }
        if !libc::WIFSTOPPED(status) {
            continue;
        }
        let signal = libc::WSTOPSIG(status);
        if signal == libc::SIGTRAP | 0x80 {
            return syscall_registers(pid)?.result();
        }
        let delivered_signal = if signal == libc::SIGSTOP || signal == libc::SIGTRAP {
            0
        } else {
            signal
        };
        ptrace_resume(pid, libc::PTRACE_SYSCALL, delivered_signal)?;
    }
}

fn connect_started(result: i64) -> bool {
    result == 0 || result == -(libc::EINPROGRESS as i64)
}

struct ConnectArguments {
    fd: libc::c_int,
    address: usize,
    length: usize,
}

struct SocketArguments {
    domain: libc::c_int,
    socket_type: libc::c_int,
}

#[cfg(target_arch = "x86_64")]
struct SyscallRegisters(libc::user_regs_struct);

#[cfg(target_arch = "x86_64")]
fn syscall_registers(pid: libc::pid_t) -> Result<SyscallRegisters, String> {
    let mut registers = std::mem::MaybeUninit::<libc::user_regs_struct>::zeroed();
    ptrace_call(
        libc::PTRACE_GETREGS,
        pid,
        std::ptr::null_mut(),
        registers.as_mut_ptr().cast(),
    )
    .map_err(|error| format!("read x86_64 syscall registers: {error}"))?;
    Ok(SyscallRegisters(unsafe { registers.assume_init() }))
}

#[cfg(target_arch = "x86_64")]
impl SyscallRegisters {
    fn number(&self) -> libc::c_long {
        self.0.orig_rax as libc::c_long
    }

    fn connect_arguments(&self) -> Result<ConnectArguments, String> {
        Ok(ConnectArguments {
            fd: self.0.rdi as libc::c_int,
            address: self.0.rsi as usize,
            length: self.0.rdx as usize,
        })
    }

    fn result(&self) -> Result<i64, String> {
        Ok(self.0.rax as i64)
    }

    fn socket_arguments(&self) -> Result<SocketArguments, String> {
        Ok(SocketArguments {
            domain: self.0.rdi as libc::c_int,
            socket_type: self.0.rsi as libc::c_int,
        })
    }
}

#[cfg(target_arch = "aarch64")]
struct SyscallRegisters([u64; 34]);

#[cfg(target_arch = "aarch64")]
fn syscall_registers(pid: libc::pid_t) -> Result<SyscallRegisters, String> {
    let mut registers = [0u64; 34];
    let mut io = libc::iovec {
        iov_base: registers.as_mut_ptr().cast(),
        iov_len: std::mem::size_of_val(&registers),
    };
    ptrace_call(
        libc::PTRACE_GETREGSET,
        pid,
        libc::NT_PRSTATUS as usize as *mut libc::c_void,
        (&mut io as *mut libc::iovec).cast(),
    )
    .map_err(|error| format!("read aarch64 syscall registers: {error}"))?;
    Ok(SyscallRegisters(registers))
}

#[cfg(target_arch = "aarch64")]
impl SyscallRegisters {
    fn number(&self) -> libc::c_long {
        self.0[8] as libc::c_long
    }

    fn connect_arguments(&self) -> Result<ConnectArguments, String> {
        Ok(ConnectArguments {
            fd: self.0[0] as libc::c_int,
            address: self.0[1] as usize,
            length: self.0[2] as usize,
        })
    }

    fn result(&self) -> Result<i64, String> {
        Ok(self.0[0] as i64)
    }

    fn socket_arguments(&self) -> Result<SocketArguments, String> {
        Ok(SocketArguments {
            domain: self.0[0] as libc::c_int,
            socket_type: self.0[1] as libc::c_int,
        })
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
struct SyscallRegisters;

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
fn syscall_registers(_pid: libc::pid_t) -> Result<SyscallRegisters, String> {
    Err(format!(
        "Linux rootless capture does not support {} syscall registers",
        std::env::consts::ARCH
    ))
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
impl SyscallRegisters {
    fn number(&self) -> libc::c_long {
        -1
    }

    fn connect_arguments(&self) -> Result<ConnectArguments, String> {
        Err("unsupported Linux rootless capture architecture".into())
    }

    fn result(&self) -> Result<i64, String> {
        Err("unsupported Linux rootless capture architecture".into())
    }

    fn socket_arguments(&self) -> Result<SocketArguments, String> {
        Err("unsupported Linux rootless capture architecture".into())
    }
}

fn read_socket_address(
    pid: libc::pid_t,
    address: usize,
    supplied_length: usize,
) -> Result<Option<(SocketAddr, Vec<u8>)>, String> {
    let mut family_bytes = [0u8; 2];
    read_process_memory(pid, address, &mut family_bytes)?;
    let family = u16::from_ne_bytes(family_bytes) as libc::c_int;
    let required = match family {
        libc::AF_INET => std::mem::size_of::<libc::sockaddr_in>(),
        libc::AF_INET6 => std::mem::size_of::<libc::sockaddr_in6>(),
        _ => return Ok(None),
    };
    if supplied_length < required {
        return Err(format!(
            "connect sockaddr length {supplied_length} is shorter than required {required}"
        ));
    }
    let mut original = vec![0u8; required];
    read_process_memory(pid, address, &mut original)?;
    let destination = decode_socket_address(&original)?;
    Ok(Some((destination, original)))
}

fn decode_socket_address(bytes: &[u8]) -> Result<SocketAddr, String> {
    let family = u16::from_ne_bytes(
        bytes
            .get(..2)
            .ok_or_else(|| "missing sockaddr family".to_string())?
            .try_into()
            .unwrap(),
    ) as libc::c_int;
    let port = u16::from_be_bytes(
        bytes
            .get(2..4)
            .ok_or_else(|| "missing sockaddr port".to_string())?
            .try_into()
            .unwrap(),
    );
    match family {
        libc::AF_INET => {
            let octets: [u8; 4] = bytes
                .get(4..8)
                .ok_or_else(|| "missing IPv4 sockaddr address".to_string())?
                .try_into()
                .unwrap();
            Ok(SocketAddr::V4(SocketAddrV4::new(octets.into(), port)))
        }
        libc::AF_INET6 => {
            let octets: [u8; 16] = bytes
                .get(8..24)
                .ok_or_else(|| "missing IPv6 sockaddr address".to_string())?
                .try_into()
                .unwrap();
            let flowinfo = u32::from_ne_bytes(bytes[4..8].try_into().unwrap());
            let scope_id = u32::from_ne_bytes(bytes[24..28].try_into().unwrap());
            Ok(SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::from(octets),
                port,
                flowinfo,
                scope_id,
            )))
        }
        _ => Err(format!("unsupported sockaddr family {family}")),
    }
}

fn encode_loopback(
    destination: SocketAddr,
    relay_port: u16,
    length: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; length];
    match destination {
        SocketAddr::V4(_) => {
            bytes[..2].copy_from_slice(&(libc::AF_INET as u16).to_ne_bytes());
            bytes[4..8].copy_from_slice(&Ipv4Addr::LOCALHOST.octets());
        }
        SocketAddr::V6(_) => {
            bytes[..2].copy_from_slice(&(libc::AF_INET6 as u16).to_ne_bytes());
            bytes[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        }
    }
    bytes[2..4].copy_from_slice(&relay_port.to_be_bytes());
    Ok(bytes)
}

fn socket_is_stream(
    pid: libc::pid_t,
    fd: libc::c_int,
    socket_types: &HashMap<String, libc::c_int>,
) -> bool {
    if let Some(socket_type) = duplicate_socket_type(pid, fd) {
        return socket_type == libc::SOCK_STREAM;
    }
    let Some(inode) = socket_inode(pid, fd) else {
        return false;
    };
    if let Some(socket_type) = socket_types.get(&inode) {
        return *socket_type == libc::SOCK_STREAM;
    }
    for protocol in ["udp", "udp6", "raw", "raw6"] {
        if socket_table_contains(pid, protocol, &inode) {
            return false;
        }
    }
    // Unconnected TCP sockets are not consistently listed in /proc/net/tcp.
    // Any socket not identified as datagram/raw is therefore treated as TCP.
    true
}

fn duplicate_socket_type(pid: libc::pid_t, fd: libc::c_int) -> Option<libc::c_int> {
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
    if pidfd < 0 {
        return None;
    }
    let duplicated = unsafe { libc::syscall(libc::SYS_pidfd_getfd, pidfd, fd, 0) } as libc::c_int;
    unsafe { libc::close(pidfd) };
    if duplicated < 0 {
        return None;
    }
    let duplicated = unsafe { OwnedFd::from_raw_fd(duplicated) };
    let mut socket_type: libc::c_int = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            std::os::fd::AsRawFd::as_raw_fd(&duplicated),
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut socket_type as *mut libc::c_int).cast(),
            &mut length,
        )
    };
    (result == 0).then_some(socket_type)
}

fn socket_inode(pid: libc::pid_t, fd: libc::c_int) -> Option<String> {
    let target = fs::read_link(format!("/proc/{pid}/fd/{fd}")).ok()?;
    let text = target.to_str()?;
    text.strip_prefix("socket:[")
        .and_then(|value| value.strip_suffix(']'))
        .map(str::to_string)
}

fn socket_table_contains(pid: libc::pid_t, protocol: &str, inode: &str) -> bool {
    fs::read_to_string(format!("/proc/{pid}/net/{protocol}"))
        .ok()
        .is_some_and(|table| {
            table.lines().skip(1).any(|line| {
                line.split_ascii_whitespace()
                    .nth(9)
                    .is_some_and(|value| value == inode)
            })
        })
}

fn read_process_memory(pid: libc::pid_t, address: usize, bytes: &mut [u8]) -> Result<(), String> {
    let local = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let remote = libc::iovec {
        iov_base: address as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let count = unsafe { libc::process_vm_readv(pid, &local, 1, &remote, 1, 0) };
    if count == bytes.len() as isize {
        return Ok(());
    }
    ptrace_read_memory(pid, address, bytes)
}

fn write_process_memory(pid: libc::pid_t, address: usize, bytes: &[u8]) -> Result<(), String> {
    let local = libc::iovec {
        iov_base: bytes.as_ptr() as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let remote = libc::iovec {
        iov_base: address as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let count = unsafe { libc::process_vm_writev(pid, &local, 1, &remote, 1, 0) };
    if count == bytes.len() as isize {
        return Ok(());
    }
    ptrace_write_memory(pid, address, bytes)
}

fn ptrace_read_memory(pid: libc::pid_t, address: usize, bytes: &mut [u8]) -> Result<(), String> {
    let word_size = std::mem::size_of::<libc::c_long>();
    let mut copied = 0;
    while copied < bytes.len() {
        let remote_address = address + copied;
        let aligned_address = remote_address & !(word_size - 1);
        let word_offset = remote_address - aligned_address;
        let count = std::cmp::min(word_size - word_offset, bytes.len() - copied);
        let word = ptrace_peek_word(pid, aligned_address)?;
        let word_bytes = word.to_ne_bytes();
        bytes[copied..copied + count]
            .copy_from_slice(&word_bytes[word_offset..word_offset + count]);
        copied += count;
    }
    Ok(())
}

fn ptrace_write_memory(pid: libc::pid_t, address: usize, bytes: &[u8]) -> Result<(), String> {
    let word_size = std::mem::size_of::<libc::c_long>();
    let mut copied = 0;
    while copied < bytes.len() {
        let remote_address = address + copied;
        let aligned_address = remote_address & !(word_size - 1);
        let word_offset = remote_address - aligned_address;
        let count = std::cmp::min(word_size - word_offset, bytes.len() - copied);
        let mut word_bytes = if word_offset == 0 && count == word_size {
            [0u8; std::mem::size_of::<libc::c_long>()]
        } else {
            ptrace_peek_word(pid, aligned_address)?.to_ne_bytes()
        };
        word_bytes[word_offset..word_offset + count]
            .copy_from_slice(&bytes[copied..copied + count]);
        let word = libc::c_long::from_ne_bytes(word_bytes);
        ptrace_call(
            libc::PTRACE_POKEDATA,
            pid,
            aligned_address as *mut libc::c_void,
            word as usize as *mut libc::c_void,
        )
        .map_err(|error| format!("PTRACE_POKEDATA PID {pid} at 0x{aligned_address:x}: {error}"))?;
        copied += count;
    }
    Ok(())
}

fn ptrace_peek_word(pid: libc::pid_t, address: usize) -> Result<libc::c_long, String> {
    unsafe { *libc::__errno_location() = 0 };
    let word = unsafe {
        libc::ptrace(
            libc::PTRACE_PEEKDATA,
            pid,
            address as *mut libc::c_void,
            std::ptr::null_mut::<libc::c_void>(),
        )
    };
    let error = std::io::Error::last_os_error();
    if word == -1 && error.raw_os_error().unwrap_or(0) != 0 {
        Err(format!(
            "PTRACE_PEEKDATA PID {pid} at 0x{address:x}: {error}"
        ))
    } else {
        Ok(word)
    }
}

fn ptrace_resume(
    pid: libc::pid_t,
    request: libc::c_uint,
    signal: libc::c_int,
) -> Result<(), String> {
    ptrace_call(
        request,
        pid,
        std::ptr::null_mut(),
        signal as usize as *mut libc::c_void,
    )
    .map(|_| ())
    .map_err(|error| format!("ptrace resume PID {pid}: {error}"))
}

fn ptrace_call(
    request: libc::c_uint,
    pid: libc::pid_t,
    address: *mut libc::c_void,
    data: *mut libc::c_void,
) -> std::io::Result<libc::c_long> {
    let result = unsafe { libc::ptrace(request, pid, address, data) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

fn kill_tracee(pid: libc::pid_t) {
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let _ = ptrace_resume(pid, libc::PTRACE_CONT, libc::SIGKILL);
}

/// Verify both ptrace supervision and a seccomp TRACE event with the exact
/// launcher that will be used for applications.
pub fn preflight(launcher: &Path) -> Result<(), String> {
    if !cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
        return Err(format!(
            "Linux rootless application capture is unsupported on {}",
            std::env::consts::ARCH
        ));
    }
    let child = Command::new(launcher)
        .arg("--preflight")
        .spawn()
        .map_err(|error| format!("start ptrace/seccomp preflight: {error}"))?;
    let pid = child.id() as libc::pid_t;
    drop(child);
    let deadline = Instant::now() + TRACE_START_TIMEOUT;
    let mut saw_seccomp = false;
    loop {
        let mut status = 0;
        let waited = unsafe {
            libc::waitpid(
                pid,
                &mut status,
                libc::WNOHANG | libc::WUNTRACED | libc::__WALL,
            )
        };
        if waited < 0 {
            return Err(format!(
                "wait for ptrace/seccomp preflight: {}",
                std::io::Error::last_os_error()
            ));
        }
        if waited == 0 {
            if Instant::now() >= deadline {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                let _ = unsafe { libc::waitpid(pid, &mut status, 0) };
                return Err("ptrace/seccomp preflight timed out".into());
            }
            std::thread::sleep(TRACE_POLL_INTERVAL);
            continue;
        }
        if libc::WIFEXITED(status) {
            return if libc::WEXITSTATUS(status) == 0 && saw_seccomp {
                Ok(())
            } else {
                Err(
                    "current Linux container or kernel forbids unprivileged ptrace/seccomp capture"
                        .into(),
                )
            };
        }
        if libc::WIFSIGNALED(status) {
            return Err(format!(
                "ptrace/seccomp preflight was terminated by signal {}",
                libc::WTERMSIG(status)
            ));
        }
        if !libc::WIFSTOPPED(status) {
            continue;
        }
        let event = status >> 16;
        if !saw_seccomp && event == 0 && libc::WSTOPSIG(status) == libc::SIGSTOP {
            initialize_tracee(pid)?;
        } else if event == libc::PTRACE_EVENT_SECCOMP {
            saw_seccomp = true;
        }
        ptrace_resume(pid, libc::PTRACE_CONT, 0)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_lifecycle_requires_the_target_exec_and_preserves_preparation_failure() {
        let mut prepared = LaunchLifecycle::new(2);
        prepared.observe_exec();
        assert_eq!(prepared.status, LaunchStatus::Preparing);
        prepared.observe_exec();
        assert_eq!(prepared.status, LaunchStatus::Running);
        prepared.finish("normal exit".into());
        assert_eq!(prepared.status, LaunchStatus::Exited);

        let mut failed = LaunchLifecycle::new(2);
        failed.observe_exec();
        failed.finish("pre-command exited with status 7".into());
        assert_eq!(
            failed.status,
            LaunchStatus::Failed("pre-command exited with status 7".into())
        );
    }

    #[test]
    fn rewrites_ipv4_sockaddr_to_loopback_without_changing_destination_port() {
        let destination: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let bytes =
            encode_loopback(destination, 43123, std::mem::size_of::<libc::sockaddr_in>()).unwrap();
        assert_eq!(
            decode_socket_address(&bytes).unwrap(),
            "127.0.0.1:43123".parse().unwrap()
        );
    }

    #[test]
    fn rewrites_ipv6_sockaddr_to_loopback_without_changing_destination_port() {
        let destination: SocketAddr = "[2001:db8::1]:8443".parse().unwrap();
        let bytes = encode_loopback(
            destination,
            43123,
            std::mem::size_of::<libc::sockaddr_in6>(),
        )
        .unwrap();
        assert_eq!(
            decode_socket_address(&bytes).unwrap(),
            "[::1]:43123".parse().unwrap()
        );
    }

    #[test]
    fn only_new_or_in_progress_connects_expect_an_ingress_accept() {
        assert!(connect_started(0));
        assert!(connect_started(-(libc::EINPROGRESS as i64)));
        assert!(!connect_started(-(libc::EALREADY as i64)));
        assert!(!connect_started(-(libc::EISCONN as i64)));
        assert!(!connect_started(-(libc::ECONNREFUSED as i64)));
    }

    #[tokio::test]
    async fn flow_queue_preserves_serialized_connect_order() {
        let queue = Arc::new(FlowQueue::default());
        let first = queue
            .push(TracedFlow {
                destination: "192.0.2.1:80".parse().unwrap(),
                pid: 1,
                process_path: "/first".into(),
                profile_id: "a".into(),
            })
            .unwrap();
        let second = queue
            .push(TracedFlow {
                destination: "192.0.2.2:443".parse().unwrap(),
                pid: 2,
                process_path: "/second".into(),
                profile_id: "b".into(),
            })
            .unwrap();

        assert_eq!(
            queue
                .wait_take(Duration::from_millis(10))
                .await
                .unwrap()
                .pid,
            1
        );
        assert!(queue.wait_claimed(first, Duration::from_millis(10)));
        assert!(!queue.wait_claimed(second, Duration::from_millis(1)));
        assert_eq!(
            queue
                .wait_take(Duration::from_millis(10))
                .await
                .unwrap()
                .pid,
            2
        );
    }
}
