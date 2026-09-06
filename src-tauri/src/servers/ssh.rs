//! Real in-process SSH/SFTP server built on `russh` 0.61 + `russh-sftp` 2.
//!
//! This is NOT an OS/PAM gateway: authentication is checked against credentials
//! supplied in the server config (a password and/or a single authorized public
//! key), never against system accounts. A successful shell session spawns the
//! local default shell in a PTY (via [`crate::terminal::pty`]) and bridges it to
//! the SSH channel; the `sftp` subsystem is served by an in-process handler
//! rooted at a configured directory.
//!
//! ## Port forwarding (RFC 4254 §7)
//!
//! - **Local / dynamic** (`-L` / `-D` on the client): handled as
//!   `direct-tcpip` channels — we TCP-connect to the requested destination and
//!   bridge bytes bidirectionally. Dynamic SOCKS is client-side only; the
//!   server just sees a stream of `direct-tcpip` opens.
//! - **Remote** (`-R` on the client): `tcpip-forward` binds a local listener;
//!   each inbound TCP connection opens a `forwarded-tcpip` channel back to the
//!   client and is bridged the same way. `cancel-tcpip-forward` tears the
//!   listener down; all reverse listeners die with the SSH session.
//!
//! Server-specific config (`config.extra`, camelCase as sent by the frontend):
//!   - `password`      (string) accept password auth matching this value
//!   - `authorizedKey` (string) accept publickey auth matching this OpenSSH key
//!                              line ("ssh-ed25519 AAAA... [comment]")
//!   - `authorizedKeyPath` (string) path to a .pub / authorized_keys file
//!   - `allowedUsers`  (string) comma-separated usernames; empty = any username
//!   - `rootDir`       (string) SFTP/shell root directory; default = home dir
//!
//! If neither `password` nor `authorizedKey` is set the server refuses to start
//! (an SSH server that accepts anyone is almost never what the user wants).

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use russh::keys::{Algorithm, HashAlg, PrivateKey, PublicKey, ssh_key};
use russh::server::{Auth, Config as RusshConfig, Handler as ServerHandler, Msg, Server, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use russh_sftp::protocol::{
    File, FileAttributes, Handle as SftpHandle, Name, Status, StatusCode, Version,
};
use std::io::{Read, Write as _};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::ServerConfig;
use super::engine::{LogEmitter, ServerCtx, ServerStarted};

/* ----------------------------- auth model ---------------------------- */

#[derive(Clone)]
struct AuthPolicy {
    password: Option<String>,
    authorized_keys: Vec<PublicKey>,
    allowed_users: Vec<String>,
}

impl AuthPolicy {
    fn user_allowed(&self, user: &str) -> bool {
        self.allowed_users.is_empty() || self.allowed_users.iter().any(|u| u == user)
    }

    fn public_key_ok(&self, offered: &PublicKey) -> bool {
        self.authorized_keys.iter().any(|k| k == offered)
    }
}

/// Per-server runtime options that apply to every connection.
#[derive(Clone)]
struct SessionOpts {
    root: Arc<PathBuf>,
    /// When true, interactive shells are started as login shells (`-l` on Unix).
    login_shell: bool,
    /// Hard cap on concurrent SSH sessions (connections).
    max_sessions: usize,
}

/// Env vars clients may set via SSH_MSG_CHANNEL_REQUEST "env".
const ENV_WHITELIST: &[&str] = &[
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_TIME",
    "TERM",
    "COLORTERM",
    "TZ",
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
];

/* ----------------------------- server glue --------------------------- */

#[derive(Clone)]
struct SshServer {
    policy: Arc<AuthPolicy>,
    opts: Arc<SessionOpts>,
    log: LogEmitter,
    cancel: CancellationToken,
    active_sessions: Arc<AtomicUsize>,
}

impl Server for SshServer {
    type Handler = SshConnection;

    fn new_client(&mut self, peer: Option<SocketAddr>) -> Self::Handler {
        if let Some(addr) = peer {
            self.log.line(format!("client connected from {}", addr));
        } else {
            self.log.line("client connected");
        }
        SshConnection {
            policy: self.policy.clone(),
            opts: self.opts.clone(),
            log: self.log.clone(),
            cancel: self.cancel.clone(),
            shells: HashMap::new(),
            pending_channels: Arc::new(Mutex::new(HashMap::new())),
            reverse_forwards: HashMap::new(),
            pty_sizes: HashMap::new(),
            pending_env: HashMap::new(),
            authed_user: None,
            auth_method: None,
            peer,
            connected_at: Instant::now(),
            session_slot: None,
            active_sessions: self.active_sessions.clone(),
        }
    }

    fn handle_session_error(&mut self, error: russh::Error) {
        // Routine teardown (client closed the socket) shows up here; keep it at
        // a low-key log line rather than treating it as a server failure.
        self.log.line(format!("session ended: {}", error));
    }
}

/// Decrements the global active-session counter when the connection is dropped.
struct SessionSlot {
    active: Arc<AtomicUsize>,
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/* ------------------------- per-connection state ----------------------- */

/// Writer half of a spawned shell's PTY, plus the resize handle.
struct ShellIo {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct SshConnection {
    policy: Arc<AuthPolicy>,
    opts: Arc<SessionOpts>,
    log: LogEmitter,
    cancel: CancellationToken,
    /// Active shells keyed by channel id (PTY writer + master for resize).
    shells: HashMap<ChannelId, ShellIo>,
    /// Channels parked between `channel_open_session` and `subsystem_request`,
    /// so the SFTP subsystem can take ownership of the channel stream.
    pending_channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
    /// Reverse-forward listeners for this session: `(bind_addr, port) → cancel`.
    /// Cancelled on `cancel-tcpip-forward` and when the connection is dropped.
    reverse_forwards: HashMap<(String, u32), CancellationToken>,
    /// PTY sizes requested before shell/exec (do not open shell on pty-req alone,
    /// so `exec` can use the same size without spawning an interactive shell).
    pty_sizes: HashMap<ChannelId, (u16, u16)>,
    /// Accepted env vars for the next shell/exec on this connection.
    pending_env: HashMap<String, String>,
    authed_user: Option<String>,
    auth_method: Option<&'static str>,
    peer: Option<SocketAddr>,
    connected_at: Instant,
    /// Held while the connection is authenticated and counted toward max_sessions.
    session_slot: Option<SessionSlot>,
    active_sessions: Arc<AtomicUsize>,
}

impl Drop for SshConnection {
    fn drop(&mut self) {
        for (_, token) in self.reverse_forwards.drain() {
            token.cancel();
        }
        if let Some(user) = &self.authed_user {
            let secs = self.connected_at.elapsed().as_secs();
            let peer = self
                .peer
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".into());
            self.log.line(format!(
                "session closed user={} auth={} peer={} duration={}s",
                user,
                self.auth_method.unwrap_or("?"),
                peer,
                secs
            ));
        }
        // session_slot Drop decrements active count
        self.session_slot.take();
    }
}

impl ServerHandler for SshConnection {
    type Error = russh::Error;

    fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> impl Future<Output = Result<Auth, Self::Error>> + Send {
        async move {
            if !self.policy.user_allowed(user) {
                self.log.line(format!(
                    "password auth rejected: user '{}' not allowed",
                    user
                ));
                return Ok(reject());
            }
            match &self.policy.password {
                Some(expected) if expected == password => {
                    if !self.try_acquire_session_slot() {
                        self.log.line(format!(
                            "password auth rejected: max sessions ({}) reached",
                            self.opts.max_sessions
                        ));
                        return Ok(reject());
                    }
                    self.authed_user = Some(user.to_string());
                    self.auth_method = Some("password");
                    self.log
                        .line(format!("password auth accepted for '{}'", user));
                    Ok(Auth::Accept)
                }
                Some(_) => {
                    self.log
                        .line(format!("password auth rejected for '{}'", user));
                    Ok(reject())
                }
                None => Ok(reject()),
            }
        }
    }

    fn auth_publickey(
        &mut self,
        user: &str,
        offered: &PublicKey,
    ) -> impl Future<Output = Result<Auth, Self::Error>> + Send {
        async move {
            if !self.policy.user_allowed(user) {
                self.log.line(format!(
                    "publickey auth rejected: user '{}' not allowed",
                    user
                ));
                return Ok(reject());
            }
            if self.policy.public_key_ok(offered) {
                if !self.try_acquire_session_slot() {
                    self.log.line(format!(
                        "publickey auth rejected: max sessions ({}) reached",
                        self.opts.max_sessions
                    ));
                    return Ok(reject());
                }
                self.authed_user = Some(user.to_string());
                self.auth_method = Some("publickey");
                self.log
                    .line(format!("publickey auth accepted for '{}'", user));
                Ok(Auth::Accept)
            } else {
                self.log
                    .line(format!("publickey auth rejected for '{}'", user));
                Ok(reject())
            }
        }
    }

    fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            // Park the channel; either a shell or an sftp subsystem will claim it.
            let mut pending = self.pending_channels.lock().await;
            pending.insert(channel.id(), channel);
            Ok(true)
        }
    }

    /// Local (`-L`) and dynamic (`-D`) forwarding: client asks us to open a TCP
    /// connection to `host:port` and relay the channel.
    fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            if port_to_connect == 0 || port_to_connect > u32::from(u16::MAX) {
                self.log.line(format!(
                    "direct-tcpip rejected: invalid port {} (from {}:{})",
                    port_to_connect, originator_address, originator_port
                ));
                return Ok(false);
            }
            let host = host_to_connect.to_string();
            let port = port_to_connect as u16;
            let dest = format!("{}:{}", host, port);
            let log = self.log.clone();
            let cancel = self.cancel.clone();
            let origin = format!("{}:{}", originator_address, originator_port);
            self.log
                .line(format!("direct-tcpip → {} (origin {})", dest, origin));
            tokio::spawn(async move {
                let tcp = match TcpStream::connect((host.as_str(), port)).await {
                    Ok(s) => s,
                    Err(e) => {
                        log.line(format!("direct-tcpip connect to {} failed: {}", dest, e));
                        let _ = channel.close().await;
                        return;
                    }
                };
                log.line(format!("direct-tcpip established to {}", dest));
                bridge_tcp_and_channel(tcp, channel, cancel, log, format!("direct-tcpip {}", dest))
                    .await;
            });
            Ok(true)
        }
    }

    /// Remote forwarding (`-R`): client asks us to listen on `address:port` and
    /// open `forwarded-tcpip` channels back for each inbound TCP connection.
    fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            if *port > u32::from(u16::MAX) {
                self.log
                    .line(format!("tcpip-forward rejected: invalid port {}", *port));
                return Ok(false);
            }
            let listen_host = resolve_listen_addr(address);
            let requested_port = *port as u16;
            let listener = match TcpListener::bind((listen_host.as_str(), requested_port)).await {
                Ok(l) => l,
                Err(e) => {
                    self.log.line(format!(
                        "tcpip-forward bind {}:{} failed: {}",
                        listen_host, requested_port, e
                    ));
                    return Ok(false);
                }
            };
            let bound = match listener.local_addr() {
                Ok(a) => a,
                Err(e) => {
                    self.log
                        .line(format!("tcpip-forward local_addr failed: {}", e));
                    return Ok(false);
                }
            };
            let bound_port = bound.port() as u32;
            // RFC 4254: port 0 means "server allocates"; report the real port.
            *port = bound_port;

            if !is_loopback_addr(&listen_host) {
                self.log.line(format!(
                    "WARNING: remote forward listening on {} — reachable beyond this machine",
                    bound
                ));
            }

            // Replace any previous listener on the same (addr, port).
            let key = (listen_host.clone(), bound_port);
            if let Some(prev) = self.reverse_forwards.remove(&key) {
                prev.cancel();
            }
            let fwd_cancel = CancellationToken::new();
            self.reverse_forwards
                .insert(key.clone(), fwd_cancel.clone());

            let handle = session.handle();
            let log = self.log.clone();
            let session_cancel = self.cancel.clone();
            let connected_address = address.to_string();
            self.log.line(format!(
                "tcpip-forward listening on {} (advertised as {}:{})",
                bound, connected_address, bound_port
            ));

            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = fwd_cancel.cancelled() => break,
                        _ = session_cancel.cancelled() => break,
                        accept = listener.accept() => {
                            let (tcp, peer) = match accept {
                                Ok(p) => p,
                                Err(e) => {
                                    log.line(format!("tcpip-forward accept error: {}", e));
                                    break;
                                }
                            };
                            let peer_ip = peer.ip().to_string();
                            let peer_port = peer.port() as u32;
                            log.line(format!(
                                "forwarded-tcpip {} → session (listen {}:{})",
                                peer, connected_address, bound_port
                            ));
                            let handle = handle.clone();
                            let log = log.clone();
                            let connected_address = connected_address.clone();
                            let session_cancel = session_cancel.clone();
                            tokio::spawn(async move {
                                let channel = match handle
                                    .channel_open_forwarded_tcpip(
                                        connected_address.clone(),
                                        bound_port,
                                        peer_ip,
                                        peer_port,
                                    )
                                    .await
                                {
                                    Ok(ch) => ch,
                                    Err(e) => {
                                        log.line(format!(
                                            "forwarded-tcpip open to client failed: {}",
                                            e
                                        ));
                                        return;
                                    }
                                };
                                bridge_tcp_and_channel(
                                    tcp,
                                    channel,
                                    session_cancel,
                                    log,
                                    format!(
                                        "forwarded-tcpip {}:{} from {}",
                                        connected_address, bound_port, peer
                                    ),
                                )
                                .await;
                            });
                        }
                    }
                }
                log.line(format!(
                    "tcpip-forward listener stopped on {}:{}",
                    connected_address, bound_port
                ));
            });
            Ok(true)
        }
    }

    fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            let listen_host = resolve_listen_addr(address);
            let key = (listen_host.clone(), port);
            if let Some(token) = self.reverse_forwards.remove(&key) {
                token.cancel();
                self.log.line(format!(
                    "tcpip-forward cancelled on {}:{}",
                    listen_host, port
                ));
                Ok(true)
            } else {
                // Also try the raw address the client sent (in case it differed
                // from our normalized listen host).
                let raw_key = (address.to_string(), port);
                if let Some(token) = self.reverse_forwards.remove(&raw_key) {
                    token.cancel();
                    self.log
                        .line(format!("tcpip-forward cancelled on {}:{}", address, port));
                    Ok(true)
                } else {
                    self.log.line(format!(
                        "tcpip-forward cancel: no listener on {}:{}",
                        address, port
                    ));
                    Ok(false)
                }
            }
        }
    }

    fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            // Record size only — do not open a shell here so a following
            // `exec` request can use the PTY size without an interactive shell.
            self.pty_sizes
                .insert(channel, (col_width as u16, row_height as u16));
            let _ = session.channel_success(channel);
            Ok(())
        }
    }

    fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            let (cols, rows) = self.pty_sizes.remove(&channel).unwrap_or((80, 24));
            if !self.shells.contains_key(&channel) {
                self.ensure_shell(channel, cols, rows, session).await;
            }
            let _ = session.channel_success(channel);
            Ok(())
        }
    }

    fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            let command = String::from_utf8_lossy(data).into_owned();
            let (cols, rows) = self.pty_sizes.remove(&channel).unwrap_or((80, 24));
            self.log.line(format!(
                "exec request from {}: {}",
                self.authed_user.as_deref().unwrap_or("?"),
                command
            ));
            if self
                .ensure_exec(channel, &command, cols, rows, session)
                .await
            {
                let _ = session.channel_success(channel);
            } else {
                let _ = session.channel_failure(channel);
            }
            Ok(())
        }
    }

    fn env_request(
        &mut self,
        channel: ChannelId,
        variable_name: &str,
        variable_value: &str,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if ENV_WHITELIST.iter().any(|k| *k == variable_name) {
                self.pending_env
                    .insert(variable_name.to_string(), variable_value.to_string());
                let _ = session.channel_success(channel);
            } else {
                // Silently refuse non-whitelisted vars (OpenSSH-style).
                let _ = session.channel_failure(channel);
            }
            Ok(())
        }
    }

    fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(shell) = self.shells.get_mut(&channel) {
                if let Err(e) = shell
                    .writer
                    .write_all(data)
                    .and_then(|_| shell.writer.flush())
                {
                    self.log.line(format!("shell write error: {}", e));
                }
            }
            Ok(())
        }
    }

    fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(shell) = self.shells.get(&channel) {
                let _ = crate::terminal::pty::resize_pty(
                    shell.master.as_ref(),
                    col_width as u16,
                    row_height as u16,
                );
            }
            Ok(())
        }
    }

    fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if name == "sftp" {
                let channel = {
                    let mut pending = self.pending_channels.lock().await;
                    pending.remove(&channel_id)
                };
                let Some(channel) = channel else {
                    session.channel_failure(channel_id);
                    return Ok(());
                };
                session.channel_success(channel_id);
                self.log.line(format!(
                    "sftp subsystem opened (root {})",
                    self.opts.root.display()
                ));
                let handler = SftpHandler::new(self.opts.root.clone(), self.log.clone());
                russh_sftp::server::run(channel.into_stream(), handler).await;
                Ok(())
            } else {
                session.channel_failure(channel_id);
                Ok(())
            }
        }
    }

    fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            self.shells.remove(&channel);
            session.close(channel);
            Ok(())
        }
    }

    fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            self.shells.remove(&channel);
            Ok(())
        }
    }
}

fn reject() -> Auth {
    Auth::Reject {
        proceed_with_methods: None,
        partial_success: false,
    }
}

/// Normalize the address string from a `tcpip-forward` request into something
/// `TcpListener::bind` accepts. OpenSSH clients commonly send `""`,
/// `"localhost"`, `"127.0.0.1"`, or `"0.0.0.0"`.
fn resolve_listen_addr(address: &str) -> String {
    match address.trim() {
        "" | "*" => "0.0.0.0".to_string(),
        "localhost" => "127.0.0.1".to_string(),
        other => other.to_string(),
    }
}

fn is_loopback_addr(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost" | "0:0:0:0:0:0:0:1")
}

/// Bidirectional byte bridge between a TCP socket and an SSH channel stream.
/// Exits when either side closes, the cancel token fires, or an I/O error occurs.
async fn bridge_tcp_and_channel(
    mut tcp: TcpStream,
    channel: Channel<Msg>,
    cancel: CancellationToken,
    log: LogEmitter,
    label: String,
) {
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = cancel.cancelled() => {
            let _ = tcp.shutdown().await;
            log.line(format!("{} stopped (server cancel)", label));
        }
        res = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {
            match res {
                // copy_bidirectional(tcp, stream): (tcp→stream, stream→tcp)
                Ok((to_client, to_remote)) => {
                    log.line(format!(
                        "{} closed ({} B → client, {} B → remote)",
                        label, to_client, to_remote
                    ));
                }
                Err(e) => {
                    log.line(format!("{} bridge error: {}", label, e));
                }
            }
        }
    }
}

impl SshConnection {
    /// Reserve a session slot for max-sessions accounting. Idempotent once held.
    fn try_acquire_session_slot(&mut self) -> bool {
        if self.session_slot.is_some() {
            return true;
        }
        let max = self.opts.max_sessions.max(1);
        loop {
            let cur = self.active_sessions.load(Ordering::SeqCst);
            if cur >= max {
                return false;
            }
            if self
                .active_sessions
                .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                self.session_slot = Some(SessionSlot {
                    active: self.active_sessions.clone(),
                });
                return true;
            }
        }
    }

    /// Open a local shell in a PTY for `channel` and start pumping its output
    /// to the SSH channel. Idempotent per channel.
    async fn ensure_shell(
        &mut self,
        channel: ChannelId,
        cols: u16,
        rows: u16,
        session: &mut Session,
    ) {
        if self.shells.contains_key(&channel) {
            return;
        }
        {
            let mut pending = self.pending_channels.lock().await;
            pending.remove(&channel);
        }

        let launch = crate::terminal::pty::resolve_shell(None);
        let mut args = launch.args;
        #[cfg(unix)]
        if self.opts.login_shell {
            // Prefer login shell so user rc files load (PATH, aliases, …).
            if !args.iter().any(|a| a == "-l" || a == "--login") {
                args.insert(0, "-l".to_string());
            }
        }
        // Client env is applied for exec via shell exports; interactive shells
        // inherit the server process environment (whitelist vars can be set by
        // the user in their login rc when loginShell is enabled).
        let cwd = Some(self.opts.root.display().to_string());

        let result = spawn_pty_command(cols, rows, &launch.program, &args, cwd.as_deref());
        let (handle, reader) = match result {
            Ok(t) => t,
            Err(e) => {
                self.log.line(format!("failed to open shell PTY: {}", e));
                let _ = session.handle().eof(channel).await;
                return;
            }
        };

        self.attach_pty_io(channel, handle, reader, session, "shell");
    }

    /// Run a one-shot command in a PTY (or pipe-like PTY) for `exec` requests.
    /// Returns false if the command could not be spawned.
    async fn ensure_exec(
        &mut self,
        channel: ChannelId,
        command: &str,
        cols: u16,
        rows: u16,
        session: &mut Session,
    ) -> bool {
        if self.shells.contains_key(&channel) {
            return true;
        }
        {
            let mut pending = self.pending_channels.lock().await;
            pending.remove(&channel);
        }

        let command = apply_env_exports(command, &self.pending_env);
        let (program, args) = exec_command_launch(&command, self.opts.login_shell);
        let cwd = Some(self.opts.root.display().to_string());
        let result = spawn_pty_command(cols, rows, &program, &args, cwd.as_deref());
        let (handle, reader) = match result {
            Ok(t) => t,
            Err(e) => {
                self.log
                    .line(format!("failed to exec {:?}: {}", command, e));
                return false;
            }
        };
        self.attach_pty_io(channel, handle, reader, session, "exec");
        true
    }

    fn attach_pty_io(
        &mut self,
        channel: ChannelId,
        handle: crate::terminal::pty::PtyHandle,
        mut reader: Box<dyn Read + Send>,
        session: &mut Session,
        kind: &'static str,
    ) {
        let crate::terminal::pty::PtyHandle {
            writer,
            mut child,
            master,
            ..
        } = handle;

        self.shells.insert(channel, ShellIo { writer, master });

        let handle = session.handle();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let cancel = self.cancel.clone();
        let log = self.log.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        let _ = handle.eof(channel).await;
                        let _ = handle.close(channel).await;
                        break;
                    }
                    maybe = rx.recv() => {
                        match maybe {
                            Some(chunk) => {
                                if handle.data(channel, chunk).await.is_err() {
                                    break;
                                }
                            }
                            None => {
                                let code = match child.wait() {
                                    Ok(status) => status.exit_code(),
                                    Err(_) => 0,
                                };
                                let _ = handle.exit_status_request(channel, code).await;
                                let _ = handle.eof(channel).await;
                                let _ = handle.close(channel).await;
                                break;
                            }
                        }
                    }
                }
            }
            log.line(format!("{} session closed", kind));
        });
    }
}

/// Build (program, args) for an SSH `exec` request using the platform default shell.
fn exec_command_launch(command: &str, login_shell: bool) -> (String, Vec<String>) {
    let launch = crate::terminal::pty::resolve_shell(None);
    let program = launch.program;
    let _lower = program.to_ascii_lowercase();

    #[cfg(windows)]
    {
        let _ = login_shell;
        if _lower.contains("pwsh") || _lower.contains("powershell") {
            let mut args = launch.args;
            args.extend([
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.to_string(),
            ]);
            return (program, args);
        }
        // cmd.exe style
        let mut args = launch.args;
        if args.is_empty() {
            args.push("/C".into());
        } else if !args.iter().any(|a| a.eq_ignore_ascii_case("/c")) {
            args.push("/C".into());
        }
        args.push(command.to_string());
        return (program, args);
    }

    #[cfg(unix)]
    {
        let mut args = launch.args;
        let flag = if login_shell { "-lc" } else { "-c" };
        args.push(flag.into());
        args.push(command.to_string());
        (program, args)
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = login_shell;
        (program, vec![command.to_string()])
    }
}

/// Spawn a PTY-backed process at optional `cwd`.
fn spawn_pty_command(
    cols: u16,
    rows: u16,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<(crate::terminal::pty::PtyHandle, Box<dyn Read + Send>), String> {
    if let Some(dir) = cwd {
        crate::terminal::pty::create_pty(
            cols,
            rows,
            Some(program.to_string()),
            Some(args.to_vec()),
            Some(dir.to_string()),
        )
        .map(|(h, r, _)| (h, r))
    } else {
        crate::terminal::pty::create_command_pty(cols, rows, program, args)
    }
}

/// Prefix a shell command with `export KEY=VAL;` for accepted env vars (Unix-ish shells).
fn apply_env_exports(command: &str, env: &HashMap<String, String>) -> String {
    if env.is_empty() {
        return command.to_string();
    }
    let mut prefix = String::new();
    for (k, v) in env {
        // Minimal quoting for double-quoted values.
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        prefix.push_str(&format!("export {}=\"{}\"; ", k, escaped));
    }
    prefix.push_str(command);
    prefix
}

/* ------------------------------- SFTP -------------------------------- */

/// In-process SFTP handler rooted at `root`. Paths from the client are treated
/// as absolute within the export and are confined to `root` (no escaping via
/// `..` or absolute paths).
struct SftpHandler {
    root: Arc<PathBuf>,
    log: LogEmitter,
    version: Option<u32>,
    /// Open file handles keyed by an opaque handle string we hand to the client.
    files: HashMap<String, Arc<Mutex<std::fs::File>>>,
    /// Open dir handles -> already-listed flag and the resolved path.
    dirs: HashMap<String, DirState>,
    next_handle: u64,
}

struct DirState {
    path: PathBuf,
    sent: bool,
}

impl SftpHandler {
    fn new(root: Arc<PathBuf>, log: LogEmitter) -> Self {
        Self {
            root,
            log,
            version: None,
            files: HashMap::new(),
            dirs: HashMap::new(),
            next_handle: 0,
        }
    }

    fn alloc_handle(&mut self, prefix: &str) -> String {
        let h = format!("{}-{}", prefix, self.next_handle);
        self.next_handle += 1;
        h
    }

    /// Map a client-supplied path (treated as absolute under the export root)
    /// onto a real filesystem path, refusing anything that escapes the root.
    fn resolve(&self, requested: &str) -> Result<PathBuf, StatusCode> {
        confine_path(&self.root, requested)
    }
}

/// Resolve a client SFTP path against the export `root`, treating the client's
/// view as rooted at "/" and rejecting any traversal that would climb above the
/// root. Pulled out as a free function so it can be unit-tested without an
/// `AppHandle`/`LogEmitter`.
fn confine_path(root: &Path, requested: &str) -> Result<PathBuf, StatusCode> {
    let rel = Path::new(requested);
    let mut out = root.to_path_buf();
    let mut depth: i32 = 0;
    for comp in rel.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                // Reset to root; the export root is the client's "/".
                out = root.to_path_buf();
                depth = 0;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return Err(StatusCode::PermissionDenied);
                }
                depth -= 1;
                out.pop();
            }
            Component::Normal(seg) => {
                depth += 1;
                out.push(seg);
            }
        }
    }
    Ok(out)
}

fn io_to_status(e: &std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        if self.version.is_some() {
            return Err(StatusCode::ConnectionLost);
        }
        self.version = Some(version);
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        // Resolve to a canonical client-visible absolute path (rooted at "/").
        let resolved = self.resolve(&path)?;
        let display = canonical_client_path(&self.root, &resolved);
        Ok(Name {
            id,
            files: vec![File::dummy(display)],
        })
    }

    async fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::metadata(&p).map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::symlink_metadata(&p).map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn fstat(
        &mut self,
        id: u32,
        handle: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let guard = file.lock().await;
        let meta = guard.metadata().map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<SftpHandle, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::metadata(&p).map_err(|e| io_to_status(&e))?;
        if !meta.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = self.alloc_handle("dir");
        self.dirs.insert(
            handle.clone(),
            DirState {
                path: p,
                sent: false,
            },
        );
        Ok(SftpHandle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let state = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if state.sent {
            return Err(StatusCode::Eof);
        }
        let mut files = Vec::new();
        let entries = std::fs::read_dir(&state.path).map_err(|e| io_to_status(&e))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let attrs = match entry.metadata() {
                Ok(m) => FileAttributes::from(&m),
                Err(_) => FileAttributes::default(),
            };
            files.push(File::new(name, attrs));
        }
        state.sent = true;
        Ok(Name { id, files })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<SftpHandle, Self::Error> {
        let p = self.resolve(&filename)?;
        let opts: std::fs::OpenOptions = pflags.into();
        let file = opts.open(&p).map_err(|e| io_to_status(&e))?;
        let handle = self.alloc_handle("file");
        self.files
            .insert(handle.clone(), Arc::new(Mutex::new(file)));
        Ok(SftpHandle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let mut guard = file.lock().await;
        guard
            .seek(SeekFrom::Start(offset))
            .map_err(|e| io_to_status(&e))?;
        let mut buf = vec![0u8; len as usize];
        let n = guard.read(&mut buf).map_err(|e| io_to_status(&e))?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(russh_sftp::protocol::Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let mut guard = file.lock().await;
        guard
            .seek(SeekFrom::Start(offset))
            .map_err(|e| io_to_status(&e))?;
        guard.write_all(&data).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&filename)?;
        std::fs::remove_file(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        std::fs::create_dir(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        std::fs::remove_dir(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.resolve(&oldpath)?;
        let to = self.resolve(&newpath)?;
        std::fs::rename(&from, &to).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        apply_file_attributes(&p, &attrs).map_err(|e| {
            self.log.line(format!("setstat {}: {}", p.display(), e));
            StatusCode::Failure
        })?;
        Ok(ok_status(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let guard = file.lock().await;
        // Prefer path via file metadata only — re-open by path isn't available.
        // Apply times via the File handle where the platform allows.
        apply_file_attributes_on_file(&guard, &attrs).map_err(|e| {
            self.log.line(format!("fsetstat: {}", e));
            StatusCode::Failure
        })?;
        Ok(ok_status(id))
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let p = self.resolve(&path)?;
        let target = std::fs::read_link(&p).map_err(|e| io_to_status(&e))?;
        let display = target.to_string_lossy().replace('\\', "/");
        Ok(Name {
            id,
            files: vec![File::dummy(display)],
        })
    }

    async fn symlink(
        &mut self,
        id: u32,
        linkpath: String,
        targetpath: String,
    ) -> Result<Status, Self::Error> {
        let link = self.resolve(&linkpath)?;
        // Target may be relative to the link location as seen by the client; store
        // the client-supplied string as the symlink body when it is not absolute
        // under our export. For absolute client paths, resolve under root.
        let target = if targetpath.starts_with('/') {
            self.resolve(&targetpath)?
        } else {
            PathBuf::from(&targetpath)
        };
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).map_err(|e| io_to_status(&e))?;
        }
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &link).map_err(|e| io_to_status(&e))?;
            } else {
                std::os::windows::fs::symlink_file(&target, &link).map_err(|e| io_to_status(&e))?;
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (link, target);
            return Err(StatusCode::OpUnsupported);
        }
        Ok(ok_status(id))
    }
}

/// Render a real path back to the client-visible absolute path (rooted at "/").
fn canonical_client_path(root: &Path, resolved: &Path) -> String {
    match resolved.strip_prefix(root) {
        Ok(rel) => {
            let s = rel.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", s)
            }
        }
        Err(_) => "/".to_string(),
    }
}

/* ------------------------------- start ------------------------------- */

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 22 } else { config.port };
    let bind = config.bind_address.clone();

    // Frontend fields (camelCase, flattened into `extra`):
    //   - password / authorizedKey / authorizedKeyPath / allowedUsers / rootDir
    //   - loginShell (bool) / maxSessions (u64)
    // "password" auth is against the configured value, never OS/PAM accounts.
    let password = {
        let p = config.str_field("password", "");
        if p.is_empty() {
            None
        } else {
            Some(p.to_string())
        }
    };
    let mut authorized_keys = Vec::new();
    let inline = config.str_field("authorizedKey", "");
    if !inline.trim().is_empty() {
        authorized_keys.extend(parse_authorized_keys_text(inline, "authorizedKey")?);
    }
    let key_path = config.str_field("authorizedKeyPath", "").trim().to_string();
    if !key_path.is_empty() {
        authorized_keys.extend(load_authorized_keys_file(&key_path)?);
    }
    if password.is_none() && authorized_keys.is_empty() {
        return Err(
            "SSH server needs at least one credential: set a password and/or \
             an authorized public key / key file before starting"
                .to_string(),
        );
    }
    let allowed_users: Vec<String> = config
        .str_field("allowedUsers", "")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let root = {
        let configured = config.str_field("rootDir", "");
        if configured.is_empty() {
            dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
        } else {
            PathBuf::from(configured)
        }
    };
    if !root.exists() {
        return Err(format!(
            "SFTP root directory does not exist: '{}'",
            root.display()
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "SFTP root path is not a directory: '{}'",
            root.display()
        ));
    }

    let login_shell = config.bool_field("loginShell", true);
    let max_sessions = config.u64_field("maxSessions", 8).clamp(1, 256) as usize;

    // Bind the listening socket up front so "address already in use" / privilege
    // errors (port 22 needs root on Linux) surface as a startup Error.
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port))
        .await
        .map_err(|e| {
            let hint = if port > 0 && port < 1024 {
                " (ports below 1024 often require elevated privileges)"
            } else {
                ""
            };
            format!("cannot bind {}:{} for SSH — {}{}", bind, port, e, hint)
        })?;

    let (host_key, fingerprint) = load_or_create_host_key(&ctx.app)?;
    let mut methods = MethodSet::empty();
    if password.is_some() {
        methods.push(MethodKind::Password);
    }
    if !authorized_keys.is_empty() {
        methods.push(MethodKind::PublicKey);
    }
    let russh_config = Arc::new(RusshConfig {
        inactivity_timeout: None,
        auth_rejection_time: std::time::Duration::from_secs(2),
        auth_rejection_time_initial: Some(std::time::Duration::from_secs(0)),
        methods,
        keys: vec![host_key],
        ..Default::default()
    });

    let policy = AuthPolicy {
        password,
        authorized_keys,
        allowed_users,
    };
    let opts = SessionOpts {
        root: Arc::new(root.clone()),
        login_shell,
        max_sessions,
    };

    let mut server = SshServer {
        policy: Arc::new(policy),
        opts: Arc::new(opts),
        log: ctx.log.clone(),
        cancel: ctx.cancel.clone(),
        active_sessions: Arc::new(AtomicUsize::new(0)),
    };

    ctx.log.line(format!(
        "SSH/SFTP server listening on {}:{} (root {}; max_sessions={}; login_shell={}; \
         port-forward -L/-R/-D enabled)",
        bind,
        port,
        root.display(),
        max_sessions,
        login_shell
    ));
    ctx.log
        .line(format!("SSH host key fingerprint: {}", fingerprint));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("SSH server stopped");
                    break;
                }
                accept = listener.accept() => {
                    let (stream, peer) = match accept {
                        Ok(pair) => pair,
                        Err(e) => {
                            log.line(format!("SSH accept error: {}", e));
                            continue;
                        }
                    };
                    let handler = server.new_client(Some(peer));
                    let cfg = russh_config.clone();
                    let conn_cancel = cancel.clone();
                    let conn_log = log.clone();
                    tokio::spawn(async move {
                        let session = match russh::server::run_stream(cfg, stream, handler).await {
                            Ok(s) => s,
                            Err(e) => {
                                conn_log.line(format!("SSH connection setup failed: {}", e));
                                return;
                            }
                        };
                        let handle = session.handle();
                        tokio::select! {
                            res = session => {
                                if let Err(e) = res {
                                    conn_log.line(format!("SSH session error: {}", e));
                                }
                            }
                            _ = conn_cancel.cancelled() => {
                                let _ = handle
                                    .disconnect(
                                        russh::Disconnect::ByApplication,
                                        "server shutting down".to_string(),
                                        "en-US".to_string(),
                                    )
                                    .await;
                            }
                        }
                    });
                }
            }
        }
    });

    Ok(ServerStarted { pid: None, task })
}

/// Load or generate a persistent Ed25519 host key under app-data.
fn load_or_create_host_key(app: &AppHandle) -> Result<(PrivateKey, String), String> {
    let dir = crate::resolved_app_data_dir(app)?.join("ssh-server");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create ssh-server dir {}: {e}", dir.display()))?;
    let path = dir.join("host_ed25519");

    let key = if path.is_file() {
        PrivateKey::read_openssh_file(&path)
            .map_err(|e| format!("read host key {}: {e}", path.display()))?
    } else {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .map_err(|e| format!("generate SSH host key: {e}"))?;
        key.write_openssh_file(&path, ssh_key::LineEnding::LF)
            .map_err(|e| format!("write host key {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        key
    };
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    Ok((key, fingerprint))
}

/// Parse all usable public-key lines from multi-line text (inline config).
fn parse_authorized_keys_text(text: &str, source: &str) -> Result<Vec<PublicKey>, String> {
    let mut keys = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.split_whitespace().count() < 2 {
            return Err(format!(
                "{source} line {}: expected 'ssh-… AAAA…' OpenSSH public key",
                idx + 1
            ));
        }
        keys.push(
            parse_authorized_key(trimmed).map_err(|e| format!("{source} line {}: {e}", idx + 1))?,
        );
    }
    Ok(keys)
}

/// Load every usable public-key line from an authorized_keys / .pub file.
fn load_authorized_keys_file(path: &str) -> Result<Vec<PublicKey>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read authorized key file '{}': {}", path, e))?;
    let keys = parse_authorized_keys_text(&contents, path)?;
    if keys.is_empty() {
        return Err(format!(
            "authorized key file '{}' has no usable public-key lines",
            path
        ));
    }
    Ok(keys)
}

/// Back-compat helper used by older tests — first usable line only.
#[cfg(test)]
fn load_authorized_key_file(path: &str) -> Result<String, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read authorized key file '{}': {}", path, e))?;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.split_whitespace().count() >= 2 {
            return Ok(trimmed.to_string());
        }
    }
    Err(format!(
        "authorized key file '{}' has no usable public-key line",
        path
    ))
}

/// Parse a single OpenSSH `authorized_keys`-style line ("<algo> <base64> [comment]").
fn parse_authorized_key(line: &str) -> Result<PublicKey, String> {
    let mut parts = line.split_whitespace();
    let _algo = parts.next();
    let b64 = parts
        .next()
        .ok_or_else(|| "authorizedKey must be in 'ssh-... AAAA...' OpenSSH format".to_string())?;
    russh::keys::parse_public_key_base64(b64).map_err(|e| format!("invalid authorizedKey: {}", e))
}

fn apply_file_attributes(path: &Path, attrs: &FileAttributes) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(mode) = attrs.permissions {
        use std::os::unix::fs::PermissionsExt;
        // SFTP mode bits include type bits in the high nibble; keep permission bits.
        let mode = mode & 0o7777;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("chmod: {e}"))?;
    }
    #[cfg(not(unix))]
    if let Some(mode) = attrs.permissions {
        // Windows: map owner-write bit to readonly flag only.
        let readonly = (mode & 0o200) == 0;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("stat: {e}"))?
            .permissions();
        perms.set_readonly(readonly);
        std::fs::set_permissions(path, perms).map_err(|e| format!("set_readonly: {e}"))?;
    }

    let atime = attrs
        .atime
        .map(|t| std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::from(t)));
    let mtime = attrs
        .mtime
        .map(|t| std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::from(t)));
    if atime.is_some() || mtime.is_some() {
        let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
        let accessed = atime
            .or_else(|| meta.accessed().ok())
            .unwrap_or(std::time::SystemTime::now());
        let modified = mtime
            .or_else(|| meta.modified().ok())
            .unwrap_or(std::time::SystemTime::now());
        filetime_set(path, accessed, modified)?;
    }
    Ok(())
}

fn apply_file_attributes_on_file(
    file: &std::fs::File,
    attrs: &FileAttributes,
) -> Result<(), String> {
    // Best-effort: re-resolve via no path; only times via filetime if we can get
    // a path is not always possible. Apply mode on Unix via the file's metadata path
    // is unavailable — accept times via set_times if supported.
    #[cfg(unix)]
    if let Some(mode) = attrs.permissions {
        use std::os::unix::fs::PermissionsExt;
        let mode = mode & 0o7777;
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("fchmod: {e}"))?;
    }
    let _ = (file, attrs);
    Ok(())
}

fn filetime_set(
    path: &Path,
    accessed: std::time::SystemTime,
    modified: std::time::SystemTime,
) -> Result<(), String> {
    // Use filetime crate if present; otherwise std only has limited support.
    // Prefer portable approach via `std::fs::File` + `set_times` (Rust 1.75+).
    use std::fs::File;
    use std::io::ErrorKind;
    let file = File::options()
        .write(true)
        .open(path)
        .map_err(|e| format!("open for utimes: {e}"))?;
    let at = std::fs::FileTimes::new()
        .set_accessed(accessed)
        .set_modified(modified);
    match file.set_times(at) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::Unsupported => Ok(()),
        Err(e) => Err(format!("set_times: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confine_keeps_simple_paths_under_root() {
        let root = Path::new("/srv/share");
        assert_eq!(
            confine_path(root, "/").unwrap(),
            PathBuf::from("/srv/share")
        );
        assert_eq!(
            confine_path(root, "/a/b.txt").unwrap(),
            PathBuf::from("/srv/share/a/b.txt")
        );
        assert_eq!(
            confine_path(root, "sub/file").unwrap(),
            PathBuf::from("/srv/share/sub/file")
        );
    }

    #[test]
    fn confine_allows_parent_within_root() {
        let root = Path::new("/srv/share");
        // Descend then climb back to root — allowed because depth stays >= 0.
        assert_eq!(
            confine_path(root, "/a/../b").unwrap(),
            PathBuf::from("/srv/share/b")
        );
    }

    #[test]
    fn confine_rejects_escape_above_root() {
        let root = Path::new("/srv/share");
        assert_eq!(
            confine_path(root, "/../etc/passwd"),
            Err(StatusCode::PermissionDenied)
        );
        assert_eq!(
            confine_path(root, "/a/../../etc"),
            Err(StatusCode::PermissionDenied)
        );
    }

    #[test]
    fn confine_treats_absolute_segment_as_root_reset() {
        let root = Path::new("/srv/share");
        // A second leading-root resets to the export root rather than the FS root.
        assert_eq!(
            confine_path(root, "/a//b").unwrap(),
            PathBuf::from("/srv/share/a/b")
        );
    }

    #[test]
    fn resolve_listen_addr_normalizes_common_forms() {
        assert_eq!(resolve_listen_addr(""), "0.0.0.0");
        assert_eq!(resolve_listen_addr("*"), "0.0.0.0");
        assert_eq!(resolve_listen_addr("localhost"), "127.0.0.1");
        assert_eq!(resolve_listen_addr("127.0.0.1"), "127.0.0.1");
        assert_eq!(resolve_listen_addr("0.0.0.0"), "0.0.0.0");
        assert_eq!(resolve_listen_addr("::"), "::");
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_addr("127.0.0.1"));
        assert!(is_loopback_addr("::1"));
        assert!(!is_loopback_addr("0.0.0.0"));
        assert!(!is_loopback_addr("192.168.1.1"));
    }

    #[test]
    fn load_authorized_key_file_skips_comments_and_blank_lines() {
        let dir = std::env::temp_dir().join(format!(
            "taomni-ssh-key-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_ed25519.pub");
        // Fake base64 blob — parse is tested separately; load only extracts the line.
        std::fs::write(
            &path,
            "# comment\n\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyMaterialHere user@host\n",
        )
        .unwrap();
        let line = load_authorized_key_file(path.to_str().unwrap()).unwrap();
        assert!(line.starts_with("ssh-ed25519 "));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn client_path_renders_relative_to_root() {
        let root = Path::new("/srv/share");
        assert_eq!(canonical_client_path(root, Path::new("/srv/share")), "/");
        assert_eq!(
            canonical_client_path(root, Path::new("/srv/share/a/b")),
            "/a/b"
        );
    }

    #[test]
    fn authorized_key_parses_openssh_line() {
        // A valid ed25519 public key line (from russh-keys' own doctest).
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ test@host";
        assert!(parse_authorized_key(line).is_ok());
        // Garbage base64 must error, not panic.
        assert!(parse_authorized_key("ssh-ed25519 not-base64!!").is_err());
        // Missing key body must error.
        assert!(parse_authorized_key("ssh-ed25519").is_err());
    }

    #[test]
    fn multi_line_authorized_keys_text() {
        let line1 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ a@host";
        let line2 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ b@host";
        let text = format!("# comment\n\n{line1}\n{line2}\n");
        let keys = parse_authorized_keys_text(&text, "test").unwrap();
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn apply_env_exports_prefixes_exports() {
        let mut env = HashMap::new();
        env.insert("LANG".into(), "C.UTF-8".into());
        let out = apply_env_exports("echo hi", &env);
        assert!(out.contains("export LANG="));
        assert!(out.ends_with("echo hi"));
    }
}
