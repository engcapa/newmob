use russh::ChannelStream;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::ssh_key::{Algorithm as SshAlgorithm, EcdsaCurve, HashAlg};
use russh::keys::{self, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelId, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Pty, client::Msg, kex, mac};
use std::borrow::Cow;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;

use crate::terminal::network::{NetworkSettings, establish_transport};
use crate::terminal::x11_forward::{self, XForward};

pub const MISSING_JUMP_PASSWORD_ERROR: &str = "TAOMNI_MISSING_JUMP_PASSWORD";

pub struct SshSession {
    pub handle: client::Handle<SshHandler>,
}

pub struct SshHandler {
    pub output_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
    /// X11 forwarding config for this session, if enabled. When set, inbound
    /// `x11` channels opened by the server are bridged to the local X server.
    pub x11: Option<Arc<XForward>>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async {
            // TODO: proper host key verification
            Ok(true)
        }
    }

    fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(tx) = self.output_tx.lock().await.as_ref() {
                let _ = tx.send(data.to_vec());
            }
            Ok(())
        }
    }

    fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(tx) = self.output_tx.lock().await.as_ref() {
                let _ = tx.send(data.to_vec());
            }
            Ok(())
        }
    }

    /// The remote opened an X11 channel (a forwarded X client wants to talk to
    /// our display). Bridge it to the local X server. We spawn the pump as a
    /// detached task so the SSH event loop keeps servicing other channels; the
    /// task ends when either side closes, and is torn down with the session.
    fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(forward) = self.x11.clone() {
                tokio::spawn(async move {
                    let stream = channel.into_stream();
                    if let Err(e) = x11_forward::bridge(forward, stream).await {
                        tracing::debug!("X11 forward bridge ended: {}", e);
                    }
                });
            }
            // If X11 wasn't enabled for this session, dropping `channel` closes it.
            Ok(())
        }
    }
}

#[derive(Clone)]
pub enum SshAuth {
    Password(String),
    PrivateKey(String),
    Agent,
}

#[derive(Debug, Clone)]
pub struct SshStartupCommand {
    pub command: String,
    pub keep_open: bool,
}

/// The byte transport an SSH session is layered on top of.
///
/// - `Tcp` — a direct or proxied (HTTP CONNECT / SOCKS5) TCP socket.
/// - `Jump` — a `direct-tcpip` channel opened on an intermediate SSH jump
///   host. The jump host's `Handle` is held alongside the channel stream so
///   the jump connection stays alive exactly as long as the tunnelled stream;
///   dropping the transport tears the jump connection down with it.
pub(crate) enum SshTransport {
    Tcp(TcpStream),
    Jump {
        stream: ChannelStream<Msg>,
        // Kept solely to own the jump connection's lifetime. Dropped together
        // with `stream`.
        #[allow(dead_code)]
        jump: Arc<client::Handle<SshHandler>>,
    },
}

impl AsyncRead for SshTransport {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_read(cx, buf),
            Self::Jump { stream, .. } => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for SshTransport {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_write(cx, buf),
            Self::Jump { stream, .. } => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_flush(cx),
            Self::Jump { stream, .. } => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(s) => Pin::new(s).poll_shutdown(cx),
            Self::Jump { stream, .. } => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

/// Resolve the byte transport for an SSH connection to `host:port`.
///
/// When `network` selects an SSH jump host (`proxy_kind == "ssh-tunnel"`), we
/// first open an authenticated connection to the jump host (single level — the
/// jump connection itself is always direct, never chained), then open a
/// `direct-tcpip` channel through it to the final target and hand back its
/// stream. Otherwise this is a direct or proxied TCP socket via
/// [`establish_transport`].
///
/// The jump credentials are expected to already be resolved into `network`
/// (host/port/user + plaintext password or key path) by the caller; vault
/// references must be resolved before this point.
///
/// Exposed to the database layer, which bridges this transport to a local
/// loopback listener so non-SSH clients (sqlx / redis-rs / reqwest) can reach
/// a target through the same proxy/jump machinery.
pub(crate) async fn build_ssh_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
) -> Result<SshTransport, String> {
    match network {
        Some(n) if n.uses_jump_host() => {
            if n.jump_host.trim().is_empty() {
                return Err("SSH jump host is empty".into());
            }
            if n.jump_port == 0 {
                return Err("SSH jump port must be greater than 0".into());
            }
            let jump_auth = match n.jump_auth_kind.as_str() {
                "PrivateKey" => {
                    let path = if n.jump_key_path.trim().is_empty() {
                        "~/.ssh/id_ed25519".to_string()
                    } else {
                        n.jump_key_path.clone()
                    };
                    SshAuth::PrivateKey(path)
                }
                _ => SshAuth::Password(n.jump_password.clone()),
            };
            if let SshAuth::Password(password) = &jump_auth {
                if password.is_empty() {
                    return Err(format!(
                        "{MISSING_JUMP_PASSWORD_ERROR}: SSH jump host password is required for {}@{}:{}",
                        n.jump_user, n.jump_host, n.jump_port
                    ));
                }
            }

            // The jump connection is always direct: pass no network settings so
            // it cannot itself recurse into another jump/proxy hop. Boxed to
            // break the async-recursion cycle the compiler sees (this fn ->
            // connect_ssh_authenticated_with -> ... -> this fn); the runtime
            // path never actually recurses because `network` is `None` here.
            let jump = Box::pin(connect_ssh_authenticated_with(
                &n.jump_host,
                n.jump_port,
                &n.jump_user,
                jump_auth,
                None,
            ))
            .await
            .map_err(|e| format!("jump host {}:{}: {}", n.jump_host, n.jump_port, e))?;
            let jump = Arc::new(jump);

            let channel = jump
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    format!(
                        "jump host could not open channel to {}:{}: {}",
                        host, port, e
                    )
                })?;
            Ok(SshTransport::Jump {
                stream: channel.into_stream(),
                jump,
            })
        }
        other => {
            let stream = establish_transport(host, port, other).await?;
            Ok(SshTransport::Tcp(stream))
        }
    }
}

/// A single prompt inside a keyboard-interactive auth round (e.g. the
/// "Please Input Mfa Code (AliyunOTP):" line from an Aliyun bastion host).
#[derive(Clone, Debug)]
pub struct KbdPrompt {
    pub prompt: String,
    /// When `false` the answer is secret (e.g. password/OTP) and the UI should
    /// mask it. When `true` the typed characters may be echoed.
    pub echo: bool,
}

/// One keyboard-interactive request from the server. A server may send several
/// of these in sequence; each carries zero or more prompts the user must
/// answer.
#[derive(Clone, Debug)]
pub struct KbdInteractiveRequest {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdPrompt>,
}

/// Callback invoked for each keyboard-interactive round. Implementations
/// surface the prompts to the user and resolve with one response per prompt,
/// or `None` if the user cancelled (which aborts the connection). The terminal
/// connect path wires this to a Tauri event + `submit_ssh_auth_response`
/// round-trip; non-interactive callers (tunnels) pass `None` and simply can't
/// satisfy interactive MFA.
pub type KbdInteractivePrompter = Arc<
    dyn Fn(KbdInteractiveRequest) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>>
        + Send
        + Sync,
>;

const COMPAT_KEX_ORDER: &[kex::Name] = &[
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::ECDH_SHA2_NISTP256,
    kex::ECDH_SHA2_NISTP384,
    kex::ECDH_SHA2_NISTP521,
    kex::DH_G16_SHA512,
    kex::DH_G14_SHA256,
    kex::DH_G14_SHA1,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_SUPPORT_AS_SERVER,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
];

const COMPAT_HOST_KEY_ORDER: &[SshAlgorithm] = &[
    SshAlgorithm::Ed25519,
    SshAlgorithm::Ecdsa {
        curve: EcdsaCurve::NistP256,
    },
    SshAlgorithm::Ecdsa {
        curve: EcdsaCurve::NistP384,
    },
    SshAlgorithm::Ecdsa {
        curve: EcdsaCurve::NistP521,
    },
    SshAlgorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
    SshAlgorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
    SshAlgorithm::Rsa { hash: None },
];

/// MAC algorithms offered to the server. This mirrors russh's modern default
/// (`SAFE_HMAC_ORDER`) but appends the SHA-1 HMACs that russh 0.61 dropped from
/// its built-in default. Some legacy servers (older OpenSSH, Dropbear, embedded
/// devices) only support hmac-sha1; without it the handshake fails with
/// "No common Mac algorithm". The SHA-1 variants are listed last so modern
/// servers still negotiate a SHA-2 MAC and only old servers fall back to SHA-1.
/// Note: russh 0.61 implements only these MAC names — hmac-md5, umac-64,
/// hmac-ripemd160 and the *-96 truncated variants are not available, so
/// hmac-sha1 is the only legacy MAC we can offer.
const COMPAT_MAC_ORDER: &[mac::Name] = &[
    mac::HMAC_SHA512_ETM,
    mac::HMAC_SHA256_ETM,
    mac::HMAC_SHA512,
    mac::HMAC_SHA256,
    mac::HMAC_SHA1_ETM,
    mac::HMAC_SHA1,
];

const DEFAULT_PTY_MODES: &[(Pty, u32)] = &[
    (Pty::VINTR, 3),
    (Pty::VQUIT, 28),
    (Pty::VERASE, 127),
    (Pty::VKILL, 21),
    (Pty::VEOF, 4),
    (Pty::VSTART, 17),
    (Pty::VSTOP, 19),
    (Pty::VSUSP, 26),
    (Pty::VREPRINT, 18),
    (Pty::VWERASE, 23),
    (Pty::VLNEXT, 22),
    (Pty::IGNPAR, 0),
    (Pty::PARMRK, 0),
    (Pty::INPCK, 0),
    (Pty::ISTRIP, 0),
    (Pty::INLCR, 0),
    (Pty::IGNCR, 0),
    (Pty::ICRNL, 1),
    (Pty::IXON, 1),
    (Pty::IXANY, 0),
    (Pty::IXOFF, 0),
    (Pty::IMAXBEL, 1),
    (Pty::IUTF8, 1),
    (Pty::ISIG, 1),
    (Pty::ICANON, 1),
    (Pty::ECHO, 1),
    (Pty::ECHOE, 1),
    (Pty::ECHOK, 1),
    (Pty::ECHONL, 0),
    (Pty::NOFLSH, 0),
    (Pty::TOSTOP, 0),
    (Pty::IEXTEN, 1),
    (Pty::ECHOCTL, 1),
    (Pty::ECHOKE, 1),
    (Pty::OPOST, 1),
    (Pty::OLCUC, 0),
    (Pty::ONLCR, 1),
    (Pty::OCRNL, 0),
    (Pty::ONOCR, 0),
    (Pty::ONLRET, 0),
    (Pty::CS7, 0),
    (Pty::CS8, 1),
    (Pty::PARENB, 0),
    (Pty::PARODD, 0),
    (Pty::TTY_OP_ISPEED, 38400),
    (Pty::TTY_OP_OSPEED, 38400),
];

fn build_client_config(network: Option<&NetworkSettings>) -> Arc<client::Config> {
    let mut cfg = client::Config::default();
    let preferred = cfg.preferred.clone();
    cfg.preferred = russh::Preferred {
        kex: Cow::Borrowed(COMPAT_KEX_ORDER),
        key: Cow::Borrowed(COMPAT_HOST_KEY_ORDER),
        cipher: preferred.cipher,
        mac: Cow::Borrowed(COMPAT_MAC_ORDER),
        compression: preferred.compression,
    };
    if let Some(n) = network {
        if let Some(d) = n.keepalive_duration() {
            cfg.keepalive_interval = Some(d);
            cfg.keepalive_max = 3;
        }
    }
    Arc::new(cfg)
}

async fn authenticate(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    auth: SshAuth,
    prompter: Option<&KbdInteractivePrompter>,
) -> Result<(), String> {
    match auth {
        SshAuth::Password(password) => {
            // First try plain password auth. Many enterprise hosts (e.g. Aliyun
            // bastion) accept the password as the first factor but then demand
            // a second keyboard-interactive factor (an MFA/OTP code). russh
            // collapses that partial success into `false`, so on a non-success
            // we fall through to keyboard-interactive while the connection is
            // still alive, mirroring how OpenSSH / MobaXterm behave.
            let ok = handle
                .authenticate_password(username, &password)
                .await
                .map_err(|e| format!("SSH auth failed: {}", e))?;
            if ok.success() {
                return Ok(());
            }
            if let Some(prompter) = prompter {
                return authenticate_keyboard_interactive(
                    handle,
                    username,
                    Some(&password),
                    prompter,
                )
                .await;
            }
            return Err("SSH password authentication rejected".to_string());
        }
        SshAuth::PrivateKey(key_path) => {
            let key_path = shellexpand::tilde(&key_path).to_string();
            let key = keys::load_secret_key(&key_path, None)
                .map_err(|e| format!("Failed to load key {}: {}", key_path, e))?;
            authenticate_private_key(handle, username, key).await?;
        }
        SshAuth::Agent => {
            return Err("SSH agent auth not yet implemented".to_string());
        }
    }
    Ok(())
}

/// Drive a keyboard-interactive auth exchange to completion. Each
/// `InfoRequest` round is forwarded to `prompter`; its answers are sent back.
///
/// As a convenience, when a round has exactly one non-echo prompt that looks
/// like a password request and we still hold an unused password (`known_password`),
/// it is answered automatically without bothering the user — this covers
/// servers that expose the *password* itself via keyboard-interactive. Every
/// other prompt (notably the MFA/OTP code) is surfaced to the user.
async fn authenticate_keyboard_interactive(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    known_password: Option<&str>,
    prompter: &KbdInteractivePrompter,
) -> Result<(), String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| format!("SSH keyboard-interactive auth failed: {}", e))?;

    let mut password_used = false;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH authentication rejected (MFA/keyboard-interactive)".to_string());
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // Empty info-requests need an empty response set; just continue.
                if prompts.is_empty() {
                    response = handle
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                        .map_err(|e| format!("SSH keyboard-interactive auth failed: {}", e))?;
                    continue;
                }

                // Auto-answer a lone password prompt when we already have one.
                if !password_used {
                    if let Some(pw) = known_password {
                        if prompts.len() == 1
                            && !prompts[0].echo
                            && looks_like_password_prompt(&prompts[0].prompt)
                        {
                            password_used = true;
                            response = handle
                                .authenticate_keyboard_interactive_respond(vec![pw.to_string()])
                                .await
                                .map_err(|e| {
                                    format!("SSH keyboard-interactive auth failed: {}", e)
                                })?;
                            continue;
                        }
                    }
                }

                let request = KbdInteractiveRequest {
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|p| KbdPrompt {
                            prompt: p.prompt,
                            echo: p.echo,
                        })
                        .collect(),
                };
                let answers = prompter(request)
                    .await
                    .ok_or_else(|| "SSH authentication cancelled".to_string())?;

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| format!("SSH keyboard-interactive auth failed: {}", e))?;
            }
        }
    }
}

/// Heuristic: does this keyboard-interactive prompt look like a request for the
/// account password (as opposed to an MFA/OTP code, which we must never
/// auto-fill with the password)?
fn looks_like_password_prompt(prompt: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    p.contains("password") || p.contains("密码")
}

async fn authenticate_private_key(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    key: PrivateKey,
) -> Result<(), String> {
    let best_rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("SSH key auth failed while probing RSA algorithms: {}", e))?
        .flatten();
    let attempts = private_key_auth_attempts(key, best_rsa_hash);
    let mut tried = Vec::with_capacity(attempts.len());

    for key in attempts {
        let algorithm = key.algorithm().as_str().to_string();
        tried.push(algorithm.clone());
        let ok = handle
            .authenticate_publickey(username, key)
            .await
            .map_err(|e| format!("SSH key auth failed using {}: {}", algorithm, e))?;
        if ok.success() {
            return Ok(());
        }
    }

    Err(format!(
        "SSH key authentication rejected (tried {})",
        tried.join(", ")
    ))
}

fn private_key_auth_attempts(
    key: PrivateKey,
    best_rsa_hash: Option<HashAlg>,
) -> Vec<PrivateKeyWithHashAlg> {
    let key = Arc::new(key);
    if !matches!(key.algorithm(), SshAlgorithm::Rsa { .. }) {
        return vec![PrivateKeyWithHashAlg::new(key, None)];
    }

    let mut hashes = Vec::new();
    if let Some(hash) = best_rsa_hash {
        hashes.push(Some(hash));
    }
    for hash in [Some(HashAlg::Sha512), Some(HashAlg::Sha256), None] {
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    }
    hashes
        .into_iter()
        .map(|hash| PrivateKeyWithHashAlg::new(key.clone(), hash))
        .collect()
}

pub async fn connect_ssh(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    cols: u16,
    rows: u16,
    network: Option<&NetworkSettings>,
    prompter: Option<&KbdInteractivePrompter>,
    x11: Option<Arc<XForward>>,
    startup: Option<&SshStartupCommand>,
) -> Result<
    (
        client::Handle<SshHandler>,
        ChannelWriteHalf<Msg>,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    ),
    String,
> {
    let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel();

    let config = build_client_config(network);

    let handler = SshHandler {
        output_tx: Arc::new(Mutex::new(None)),
        x11: x11.clone(),
    };

    let stream = build_ssh_transport(host, port, network).await?;
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    authenticate(&mut handle, username, auth, prompter).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open SSH channel: {}", e))?;

    channel
        .request_pty(
            false,
            "xterm-256color",
            cols as u32,
            rows as u32,
            0,
            0,
            DEFAULT_PTY_MODES,
        )
        .await
        .map_err(|e| format!("Failed to request PTY: {}", e))?;

    // Request X11 forwarding on the session channel before the shell starts so
    // the remote `$DISPLAY` is set for the login shell. A failure here is
    // non-fatal: we log and continue with a normal (non-X11) shell rather than
    // aborting the whole connection.
    if let Some(forward) = &x11 {
        if let Err(e) = channel
            .request_x11(
                false,
                !forward.trusted, // single_connection in untrusted mode
                forward.advertised_protocol.clone(),
                forward.advertised_cookie_hex.clone(),
                forward.display.screen,
            )
            .await
        {
            tracing::warn!("X11 forwarding request failed (continuing without): {}", e);
        }
    }

    if let Some(startup) = startup {
        if startup.keep_open {
            channel
                .request_shell(false)
                .await
                .map_err(|e| format!("Failed to request shell: {}", e))?;

            let mut command = startup.command.trim().as_bytes().to_vec();
            command.push(b'\r');
            channel
                .data_bytes(command)
                .await
                .map_err(|e| format!("Failed to send startup command: {}", e))?;
        } else {
            channel
                .exec(false, startup.command.trim().as_bytes().to_vec())
                .await
                .map_err(|e| format!("Failed to execute startup command: {}", e))?;
        }
    } else {
        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("Failed to request shell: {}", e))?;
    }

    let (read_half, write_half) = channel.split();
    spawn_terminal_output_pump(read_half, output_tx);

    Ok((handle, write_half, output_rx))
}

fn spawn_terminal_output_pump(mut read_half: ChannelReadHalf, output_tx: UnboundedSender<Vec<u8>>) {
    tokio::spawn(async move {
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if output_tx.send(data.to_vec()).is_err() {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    });
}

/// Authenticate against the server and return the handle without opening a
/// PTY/shell. The SFTP module reuses this to open its own subsystem channel.
pub async fn connect_ssh_authenticated(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
) -> Result<client::Handle<SshHandler>, String> {
    connect_ssh_authenticated_with(host, port, username, auth, None).await
}

/// Same as `connect_ssh_authenticated` but allows callers to pass through
/// per-session network settings (proxy, keep-alive, IP version, …).
pub async fn connect_ssh_authenticated_with(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    network: Option<&NetworkSettings>,
) -> Result<client::Handle<SshHandler>, String> {
    connect_ssh_authenticated_with_prompter(host, port, username, auth, network, None).await
}

/// Same as `connect_ssh_authenticated_with` but lets UI callers surface
/// keyboard-interactive auth prompts (MFA/OTP) during the auth exchange.
pub async fn connect_ssh_authenticated_with_prompter(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    network: Option<&NetworkSettings>,
    prompter: Option<&KbdInteractivePrompter>,
) -> Result<client::Handle<SshHandler>, String> {
    let config = build_client_config(network);
    let handler = SshHandler {
        output_tx: Arc::new(Mutex::new(None)),
        x11: None,
    };

    let stream = build_ssh_transport(host, port, network).await?;
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    authenticate(&mut handle, username, auth, prompter).await?;
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, timeout};

    fn live_ssh_target() -> Option<(String, u16, String, String)> {
        let host = std::env::var("TAOMNI_LIVE_SSH_HOST").ok()?;
        let username = std::env::var("TAOMNI_LIVE_SSH_USER").ok()?;
        let password = std::env::var("TAOMNI_LIVE_SSH_PASSWORD").ok()?;
        let port = std::env::var("TAOMNI_LIVE_SSH_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(22);
        Some((host, port, username, password))
    }

    async fn read_until(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
        needle: &[u8],
    ) -> Vec<u8> {
        timeout(Duration::from_secs(12), async {
            let mut transcript = Vec::new();
            while let Some(chunk) = rx.recv().await {
                transcript.extend_from_slice(&chunk);
                if transcript.windows(needle.len()).any(|w| w == needle) {
                    return transcript;
                }
            }
            transcript
        })
        .await
        .expect("timed out waiting for SSH terminal output")
    }

    #[tokio::test]
    async fn jump_host_password_auth_requires_non_empty_password() {
        let mut net = NetworkSettings::default();
        net.proxy_kind = "ssh-tunnel".into();
        net.jump_host = "127.0.0.1".into();
        net.jump_port = 22;
        net.jump_user = "ops".into();
        net.jump_auth_kind = "Password".into();

        let err = match build_ssh_transport("example.com", 22, Some(&net)).await {
            Ok(_) => panic!("empty jump password should fail before dialing"),
            Err(err) => err,
        };
        assert!(err.contains(MISSING_JUMP_PASSWORD_ERROR));
    }

    #[tokio::test]
    #[ignore = "requires TAOMNI_LIVE_SSH_HOST/USER/PASSWORD"]
    async fn live_terminal_survives_vi_quit_and_followup_input() {
        let Some((host, port, username, password)) = live_ssh_target() else {
            eprintln!("skipping live SSH smoke: TAOMNI_LIVE_SSH_* is not set");
            return;
        };

        let (handle, channel, mut rx) = connect_ssh(
            &host,
            port,
            &username,
            SshAuth::Password(password),
            80,
            24,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("connect live SSH terminal");

        channel
            .data_bytes(b"printf 'TAOMNI_BEFORE_VI\\n'; vi -Nu NONE -n /tmp/taomni-russh-smoke; printf 'TAOMNI_AFTER_VI\\n'\r".to_vec())
            .await
            .expect("start vi smoke");
        let before = read_until(&mut rx, b"TAOMNI_BEFORE_VI").await;
        assert!(
            before
                .windows(b"TAOMNI_BEFORE_VI".len())
                .any(|w| w == b"TAOMNI_BEFORE_VI"),
            "did not see pre-vi marker"
        );

        channel
            .data_bytes(b":q!\r".to_vec())
            .await
            .expect("quit vi");
        let after = read_until(&mut rx, b"TAOMNI_AFTER_VI").await;
        assert!(
            after
                .windows(b"TAOMNI_AFTER_VI".len())
                .any(|w| w == b"TAOMNI_AFTER_VI"),
            "did not return from vi"
        );

        channel
            .data_bytes(b"printf 'TAOMNI_STILL_RESPONSIVE\\n'\r".to_vec())
            .await
            .expect("write after vi");
        let still_responsive = read_until(&mut rx, b"TAOMNI_STILL_RESPONSIVE").await;
        assert!(
            still_responsive
                .windows(b"TAOMNI_STILL_RESPONSIVE".len())
                .any(|w| w == b"TAOMNI_STILL_RESPONSIVE"),
            "terminal did not accept follow-up input after vi"
        );

        drop(channel);
        drop(handle);
    }

    // -----------------------------------------------------------------------
    // Strategy 2: drive a real SSH connection through an in-process proxy
    // bridging to the live target. Verifies the proxy → SSH handshake path
    // end-to-end against a real server. Requires TAOMNI_LIVE_SSH_*.
    // -----------------------------------------------------------------------

    /// In-process no-auth SOCKS5 proxy that connects to whatever target the
    /// client requests and pumps bytes both ways. Returns the listening port.
    async fn spawn_socks5_bridge() -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut head = [0u8; 2];
                    if c.read_exact(&mut head).await.is_err() {
                        return;
                    }
                    let mut methods = vec![0u8; head[1] as usize];
                    let _ = c.read_exact(&mut methods).await;
                    let _ = c.write_all(&[0x05, 0x00]).await;
                    let mut req = [0u8; 4];
                    if c.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let host = match req[3] {
                        0x01 => {
                            let mut a = [0u8; 4];
                            let _ = c.read_exact(&mut a).await;
                            std::net::Ipv4Addr::from(a).to_string()
                        }
                        0x03 => {
                            let mut l = [0u8; 1];
                            let _ = c.read_exact(&mut l).await;
                            let mut d = vec![0u8; l[0] as usize];
                            let _ = c.read_exact(&mut d).await;
                            String::from_utf8_lossy(&d).to_string()
                        }
                        0x04 => {
                            let mut a = [0u8; 16];
                            let _ = c.read_exact(&mut a).await;
                            std::net::Ipv6Addr::from(a).to_string()
                        }
                        _ => return,
                    };
                    let mut p = [0u8; 2];
                    let _ = c.read_exact(&mut p).await;
                    let dport = u16::from_be_bytes(p);
                    let _ = c
                        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                        .await;
                    if let Ok(mut up) = TcpStream::connect((host.as_str(), dport)).await {
                        let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    #[ignore = "requires TAOMNI_LIVE_SSH_HOST/USER/PASSWORD"]
    async fn live_ssh_through_socks5_proxy() {
        let Some((host, port, username, password)) = live_ssh_target() else {
            eprintln!("skipping: TAOMNI_LIVE_SSH_* is not set");
            return;
        };
        let proxy_port = spawn_socks5_bridge().await;

        let mut net = NetworkSettings::default();
        net.proxy_kind = "socks5".into();
        net.proxy_host = "127.0.0.1".into();
        net.proxy_port = proxy_port;

        let handle = connect_ssh_authenticated_with(
            &host,
            port,
            &username,
            SshAuth::Password(password),
            Some(&net),
        )
        .await
        .expect("authenticate over socks5 proxy to live SSH");
        drop(handle);
    }

    /// Live SSH jump-host test. Requires the live SSH target as the jump host
    /// plus `TAOMNI_INTERNAL_HOST` (and optional `TAOMNI_INTERNAL_PORT`,
    /// default 22) reachable *from* that jump host — typically a private-network
    /// address only the jump host can route to. Credentials for the inner
    /// target reuse the same TAOMNI_LIVE_SSH_USER/PASSWORD by default, or
    /// TAOMNI_INTERNAL_USER/PASSWORD when set.
    #[tokio::test]
    #[ignore = "requires TAOMNI_LIVE_SSH_* + TAOMNI_INTERNAL_HOST"]
    async fn live_ssh_through_jump_host() {
        let Some((jump_host, jump_port, jump_user, jump_pass)) = live_ssh_target() else {
            eprintln!("skipping: TAOMNI_LIVE_SSH_* is not set");
            return;
        };
        let Ok(inner_host) = std::env::var("TAOMNI_INTERNAL_HOST") else {
            eprintln!("skipping: TAOMNI_INTERNAL_HOST is not set");
            return;
        };
        let inner_port = std::env::var("TAOMNI_INTERNAL_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(22);
        let inner_user = std::env::var("TAOMNI_INTERNAL_USER").unwrap_or(jump_user.clone());
        let inner_pass = std::env::var("TAOMNI_INTERNAL_PASSWORD").unwrap_or(jump_pass.clone());

        let mut net = NetworkSettings::default();
        net.proxy_kind = "ssh-tunnel".into();
        net.jump_host = jump_host;
        net.jump_port = jump_port;
        net.jump_user = jump_user;
        net.jump_auth_kind = "Password".into();
        net.jump_password = jump_pass;

        let handle = connect_ssh_authenticated_with(
            &inner_host,
            inner_port,
            &inner_user,
            SshAuth::Password(inner_pass),
            Some(&net),
        )
        .await
        .expect("authenticate to internal host through SSH jump");
        drop(handle);
    }
}
