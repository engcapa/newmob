//! Telnet server: bridges each TCP connection to a freshly-spawned local shell
//! running inside a PTY (reusing `crate::terminal::pty`).
//!
//! SECURITY: Telnet is unauthenticated and cleartext. Anyone who can reach the
//! listening port gets an interactive shell with this app's privileges, and all
//! keystrokes/output travel unencrypted. A warning is logged on startup.
//!
//! Each connection:
//!   * spawns the platform default shell in a PTY,
//!   * performs minimal IAC negotiation (server WILL ECHO + SGA) so a normal
//!     `telnet` client gets a usable line/char experience,
//!   * bridges socket<->pty bidirectionally. The PTY reader/writer are blocking
//!     (`portable_pty`), so they run on dedicated OS threads fed by channels.

use std::io::{Read, Write};
use std::sync::mpsc as std_mpsc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc as tokio_mpsc;

use super::ServerConfig;
use super::engine::{ServerCtx, ServerStarted};
use crate::terminal::pty::create_pty;

const DEFAULT_PORT: u16 = 23;

// Telnet protocol bytes (RFC 854).
const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 {
        DEFAULT_PORT
    } else {
        config.port
    };
    let addr = format!("{}:{}", config.bind_address, port);

    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("failed to bind {}: {}", addr, e))?;

    ctx.log.line(format!("Telnet server listening on {}", addr));
    ctx.log
        .line("WARNING: Telnet is unauthenticated and unencrypted — anyone who can reach this port gets a shell.");

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("Telnet server stopping");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => {
                            log.line(format!("{}: connected", peer));
                            let log = log.clone();
                            let conn_cancel = cancel.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_client(stream, conn_cancel, &log).await {
                                    log.line(format!("{}: error: {}", peer, e));
                                }
                                log.line(format!("{}: disconnected", peer));
                            });
                        }
                        Err(e) => log.line(format!("accept error: {}", e)),
                    }
                }
            }
        }
    });

    Ok(ServerStarted { pid: None, task })
}

/// Bridge a single accepted socket to a PTY-backed shell.
async fn handle_client(
    mut stream: tokio::net::TcpStream,
    cancel: tokio_util::sync::CancellationToken,
    log: &super::engine::LogEmitter,
) -> Result<(), String> {
    // Spawn the shell inside a PTY (80x24 default geometry).
    let (mut handle, mut reader, shell_id) = create_pty(80, 24, None, None, None).map_err(|e| e)?;
    log.line(format!("spawned shell ({})", shell_id));

    // PTY stdout -> async task, via a blocking reader thread.
    let (out_tx, mut out_rx) = tokio_mpsc::unbounded_channel::<Vec<u8>>();
    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // async task -> PTY stdin, via a blocking writer thread.
    let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
    let mut writer = std::mem::replace(&mut handle.writer, Box::new(std::io::sink()));
    let writer_thread = std::thread::spawn(move || {
        while let Ok(chunk) = in_rx.recv() {
            if writer.write_all(&chunk).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    // Initial negotiation: server WILL ECHO + WILL SGA -> client switches to
    // character mode and lets us echo.
    let hello = [IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA];
    stream.write_all(&hello).await.map_err(|e| e.to_string())?;

    let mut parser = Telnet::default();
    let mut sock_buf = [0u8; 8192];

    let result: Result<(), String> = loop {
        tokio::select! {
            _ = cancel.cancelled() => break Ok(()),

            // PTY produced output -> send to the client.
            chunk = out_rx.recv() => {
                match chunk {
                    Some(data) => {
                        if stream.write_all(&data).await.is_err() {
                            break Ok(());
                        }
                    }
                    None => break Ok(()), // shell exited
                }
            }

            // Client sent bytes -> negotiate / forward to the PTY.
            read = stream.read(&mut sock_buf) => {
                match read {
                    Ok(0) => break Ok(()), // client closed
                    Ok(n) => {
                        let mut to_pty = Vec::with_capacity(n);
                        let mut to_sock = Vec::new();
                        parser.process(&sock_buf[..n], &mut to_pty, &mut to_sock);
                        if !to_sock.is_empty() && stream.write_all(&to_sock).await.is_err() {
                            break Ok(());
                        }
                        if !to_pty.is_empty() && in_tx.send(to_pty).is_err() {
                            break Ok(()); // writer thread gone
                        }
                    }
                    Err(e) => break Err(e.to_string()),
                }
            }
        }
    };

    // Tear down: kill the shell, drop channels so the helper threads exit.
    let _ = handle.child.kill();
    drop(in_tx);
    drop(out_rx);
    let _ = reader_thread.join();
    let _ = writer_thread.join();

    result
}

/// Minimal Telnet input parser: strips IAC negotiation, answers option
/// requests (refusing client options, confirming our own ECHO/SGA), and
/// normalizes the Enter key (`CR LF`/`CR NUL` -> `CR`) for the PTY.
#[derive(Default)]
struct Telnet {
    /// 0=data, 1=saw IAC, 2=saw IAC+cmd (awaiting option), 3=subnegotiation,
    /// 4=subnegotiation saw IAC.
    state: u8,
    /// The negotiation command (DO/DONT/WILL/WONT) awaiting its option byte.
    cmd: u8,
    /// True after emitting a CR, so a following LF/NUL can be swallowed.
    cr_pending: bool,
}

impl Telnet {
    fn process(&mut self, input: &[u8], to_pty: &mut Vec<u8>, to_sock: &mut Vec<u8>) {
        for &b in input {
            match self.state {
                0 => {
                    if b == IAC {
                        self.state = 1;
                    } else if self.cr_pending && (b == b'\n' || b == 0) {
                        // Swallow the LF/NUL that follows a CR.
                        self.cr_pending = false;
                    } else {
                        self.cr_pending = b == b'\r';
                        to_pty.push(b);
                    }
                }
                1 => {
                    // After IAC.
                    match b {
                        DO | DONT | WILL | WONT => {
                            self.cmd = b;
                            self.state = 2;
                        }
                        SB => self.state = 3,
                        IAC => {
                            // Escaped 0xFF data byte.
                            to_pty.push(IAC);
                            self.state = 0;
                        }
                        _ => {
                            // Other 2-byte commands (GA, NOP, ...) — ignore.
                            self.state = 0;
                        }
                    }
                }
                2 => {
                    self.answer_option(self.cmd, b, to_sock);
                    self.state = 0;
                }
                3 => {
                    if b == IAC {
                        self.state = 4;
                    }
                    // else: discard subnegotiation payload.
                }
                4 => {
                    // SE ends subnegotiation; anything else stays in SB.
                    self.state = if b == SE { 0 } else { 3 };
                }
                _ => self.state = 0,
            }
        }
    }

    /// Respond to a single negotiation request without creating loops.
    fn answer_option(&self, cmd: u8, opt: u8, to_sock: &mut Vec<u8>) {
        match cmd {
            // Client asks us to enable an option.
            DO => {
                if opt == OPT_ECHO || opt == OPT_SGA {
                    // Already offered via our hello — confirmation, no reply.
                } else {
                    to_sock.extend_from_slice(&[IAC, WONT, opt]);
                }
            }
            // Client tells us to disable; acknowledge once with WONT.
            DONT => {
                if opt != OPT_ECHO && opt != OPT_SGA {
                    to_sock.extend_from_slice(&[IAC, WONT, opt]);
                }
            }
            // Client offers an option — refuse them all.
            WILL => to_sock.extend_from_slice(&[IAC, DONT, opt]),
            WONT => to_sock.extend_from_slice(&[IAC, DONT, opt]),
            _ => {}
        }
    }
}
