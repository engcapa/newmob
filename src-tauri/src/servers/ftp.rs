//! Minimal FTP server (an RFC 959 subset) built on `tokio`.
//!
//! Supported commands:
//!   USER, PASS, ACCT(noop), SYST, FEAT, PWD/XPWD, TYPE, CWD, CDUP, PASV,
//!   LIST, NLST, RETR, STOR, NOOP, QUIT.
//! Only passive mode (PASV) is implemented for data transfers; active mode
//! (PORT) is rejected. TYPE is accepted but transfers are always binary.
//!
//! Authentication model (kept intentionally simple, documented for operators):
//!   * If `allowAnonymous` is true, the `anonymous`/`ftp` user logs in with any
//!     (or no) password.
//!   * Otherwise, if a `password` is configured, any username is accepted as
//!     long as PASS matches that password.
//!   * Otherwise (no password configured, anonymous disabled) any USER/PASS is
//!     accepted — this is a developer convenience for a LAN file share, not a
//!     hardened multi-user server.
//!
//! The session is jailed to `rootDir` (fallback: home dir); virtual paths can
//! never escape it. `maxConnections` caps concurrent control connections.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::AsyncBufReadExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use super::ServerConfig;
use super::engine::{LogEmitter, ServerCtx, ServerStarted};

const DEFAULT_PORT: u16 = 21;

/// Immutable per-server settings shared with each connection.
#[derive(Clone)]
struct FtpOpts {
    root: PathBuf,
    bind_address: String,
    allow_anonymous: bool,
    password: Option<String>,
    max_connections: usize,
}

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 {
        DEFAULT_PORT
    } else {
        config.port
    };
    let bind = config.bind_address.clone();

    let root = {
        let raw = config.str_field("rootDir", "");
        if raw.is_empty() {
            dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
        } else {
            PathBuf::from(raw)
        }
    };
    if !root.is_dir() {
        return Err(format!(
            "root directory does not exist or is not a directory: {}",
            root.display()
        ));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("failed to resolve root {}: {}", root.display(), e))?;

    let password = match config.str_field("password", "") {
        "" => None,
        p => Some(p.to_string()),
    };
    let opts = FtpOpts {
        root: root.clone(),
        bind_address: bind.clone(),
        allow_anonymous: config.bool_field("allowAnonymous", false),
        password,
        max_connections: config.u64_field("maxConnections", 10).max(1) as usize,
    };

    let addr = format!("{}:{}", bind, port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("failed to bind {}: {}", addr, e))?;

    ctx.log.line(format!(
        "FTP server listening on {} — root {} (anonymous: {})",
        addr,
        root.display(),
        opts.allow_anonymous
    ));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let conn_count = Arc::new(AtomicUsize::new(0));

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("FTP server stopping");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => {
                            let current = conn_count.fetch_add(1, Ordering::SeqCst) + 1;
                            if current > opts.max_connections {
                                conn_count.fetch_sub(1, Ordering::SeqCst);
                                let mut s = stream;
                                let _ = s.write_all(b"421 Too many connections.\r\n").await;
                                log.line(format!("{}: rejected (max connections)", peer));
                                continue;
                            }
                            let opts = opts.clone();
                            let log = log.clone();
                            let conn_count = conn_count.clone();
                            let cancel_child = cancel.clone();
                            log.line(format!("{}: connected", peer));
                            tokio::spawn(async move {
                                let session = Session::new(opts);
                                tokio::select! {
                                    _ = cancel_child.cancelled() => {}
                                    r = session.run(stream, &log) => {
                                        if let Err(e) = r {
                                            log.line(format!("{}: session error: {}", peer, e));
                                        }
                                    }
                                }
                                log.line(format!("{}: disconnected", peer));
                                conn_count.fetch_sub(1, Ordering::SeqCst);
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

/// Per-connection FTP session state. `vpath` is the virtual working directory
/// relative to the jail root (always starts with `/`).
struct Session {
    opts: FtpOpts,
    #[allow(dead_code)]
    user: Option<String>,
    authenticated: bool,
    vpath: String,
    /// Listener opened by the most recent PASV, consumed by the next data
    /// command (LIST/NLST/RETR/STOR).
    pasv: Option<TcpListener>,
}

impl Session {
    fn new(opts: FtpOpts) -> Self {
        Self {
            opts,
            user: None,
            authenticated: false,
            vpath: "/".to_string(),
            pasv: None,
        }
    }

    async fn run(mut self, stream: TcpStream, log: &LogEmitter) -> std::io::Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);

        write_half
            .write_all(b"220 Taomni FTP server ready.\r\n")
            .await?;

        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                break; // client closed
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                continue;
            }
            let (cmd, arg) = match line.split_once(' ') {
                Some((c, a)) => (c.to_ascii_uppercase(), a.trim().to_string()),
                None => (line.to_ascii_uppercase(), String::new()),
            };

            // Avoid logging the actual password.
            if cmd == "PASS" {
                log.line("PASS ****");
            } else {
                log.line(line.to_string());
            }

            match cmd.as_str() {
                "USER" => {
                    self.user = Some(arg.clone());
                    self.authenticated = false;
                    if self.opts.allow_anonymous
                        && (arg.eq_ignore_ascii_case("anonymous")
                            || arg.eq_ignore_ascii_case("ftp"))
                    {
                        write_half
                            .write_all(b"331 Anonymous login ok, send your email as password.\r\n")
                            .await?;
                    } else {
                        write_half
                            .write_all(b"331 Username ok, need password.\r\n")
                            .await?;
                    }
                }
                "PASS" => {
                    if self.check_auth(&arg) {
                        self.authenticated = true;
                        write_half.write_all(b"230 Login successful.\r\n").await?;
                    } else {
                        write_half.write_all(b"530 Login incorrect.\r\n").await?;
                    }
                }
                "ACCT" => {
                    write_half.write_all(b"230 Account ok.\r\n").await?;
                }
                "SYST" => {
                    write_half.write_all(b"215 UNIX Type: L8\r\n").await?;
                }
                "FEAT" => {
                    write_half
                        .write_all(b"211-Features:\r\n PASV\r\n UTF8\r\n211 End\r\n")
                        .await?;
                }
                "NOOP" => {
                    write_half.write_all(b"200 NOOP ok.\r\n").await?;
                }
                "TYPE" => {
                    // Accept any type; we always transfer raw bytes.
                    write_half
                        .write_all(format!("200 Type set to {}.\r\n", arg).as_bytes())
                        .await?;
                }
                "QUIT" => {
                    write_half.write_all(b"221 Goodbye.\r\n").await?;
                    break;
                }
                _ if !self.authenticated => {
                    write_half
                        .write_all(b"530 Please login with USER and PASS.\r\n")
                        .await?;
                }
                "PWD" | "XPWD" => {
                    write_half
                        .write_all(
                            format!("257 \"{}\" is the current directory.\r\n", self.vpath)
                                .as_bytes(),
                        )
                        .await?;
                }
                "CWD" => {
                    self.handle_cwd(&arg, &mut write_half).await?;
                }
                "CDUP" => {
                    self.handle_cwd("..", &mut write_half).await?;
                }
                "PASV" => {
                    self.handle_pasv(&mut write_half, log).await?;
                }
                "LIST" => {
                    self.handle_list(&arg, &mut write_half, log, false).await?;
                }
                "NLST" => {
                    self.handle_list(&arg, &mut write_half, log, true).await?;
                }
                "RETR" => {
                    self.handle_retr(&arg, &mut write_half, log).await?;
                }
                "STOR" => {
                    self.handle_stor(&arg, &mut write_half, log).await?;
                }
                "PORT" | "EPRT" | "EPSV" => {
                    write_half
                        .write_all(b"502 Active mode not supported; use PASV.\r\n")
                        .await?;
                }
                _ => {
                    write_half
                        .write_all(b"502 Command not implemented.\r\n")
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Apply the documented auth policy to a PASS attempt.
    fn check_auth(&self, password: &str) -> bool {
        let user = self.user.as_deref().unwrap_or("");
        let is_anon = user.eq_ignore_ascii_case("anonymous") || user.eq_ignore_ascii_case("ftp");
        if self.opts.allow_anonymous && is_anon {
            return true;
        }
        match &self.opts.password {
            // A password is configured: any user must match it.
            Some(expected) => password == expected,
            // No password configured and anonymous disabled: accept any login
            // (LAN convenience). Anonymous users still require the flag above.
            None => !is_anon || self.opts.allow_anonymous,
        }
    }

    /// Resolve a client-supplied path argument against the virtual cwd and the
    /// jail root, returning both the real filesystem path and the new virtual
    /// path. Returns `None` if it would escape the root.
    fn resolve(&self, arg: &str) -> Option<(PathBuf, String)> {
        // Compute the target virtual path.
        let vpath = if arg.starts_with('/') {
            arg.to_string()
        } else if self.vpath == "/" {
            format!("/{}", arg)
        } else {
            format!("{}/{}", self.vpath, arg)
        };

        // Normalize the virtual path into canonical segments (resolving "..").
        let mut segs: Vec<String> = Vec::new();
        for part in vpath.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    segs.pop();
                }
                other => segs.push(other.to_string()),
            }
        }
        let norm_vpath = format!("/{}", segs.join("/"));

        // Map to a real path under root, rejecting any odd components.
        let mut real = self.opts.root.clone();
        for seg in &segs {
            for comp in Path::new(seg).components() {
                match comp {
                    Component::Normal(s) => real.push(s),
                    _ => return None,
                }
            }
        }

        // If it exists, canonicalize and verify containment (symlink guard).
        if let Ok(canon) = real.canonicalize() {
            if !canon.starts_with(&self.opts.root) {
                return None;
            }
            real = canon;
        }
        Some((real, norm_vpath))
    }

    async fn handle_cwd(
        &mut self,
        arg: &str,
        write_half: &mut tokio::net::tcp::OwnedWriteHalf,
    ) -> std::io::Result<()> {
        match self.resolve(arg) {
            Some((real, vpath)) if real.is_dir() => {
                self.vpath = vpath;
                write_half.write_all(b"250 Directory changed.\r\n").await?;
            }
            _ => {
                write_half
                    .write_all(b"550 Failed to change directory.\r\n")
                    .await?;
            }
        }
        Ok(())
    }

    /// Open a passive data listener and announce it via 227. We bind the same
    /// address the control socket is bound to; the advertised IP is derived
    /// from `bind_address` (falling back to 127.0.0.1 for a wildcard bind).
    async fn handle_pasv(
        &mut self,
        write_half: &mut tokio::net::tcp::OwnedWriteHalf,
        log: &LogEmitter,
    ) -> std::io::Result<()> {
        let bind_ip = &self.opts.bind_address;
        let listener = match TcpListener::bind(format!("{}:0", bind_ip)).await {
            Ok(l) => l,
            Err(e) => {
                log.line(format!("PASV bind failed: {}", e));
                write_half
                    .write_all(b"425 Cannot open passive connection.\r\n")
                    .await?;
                return Ok(());
            }
        };
        let local = listener.local_addr()?;
        let port = local.port();

        // Determine the advertised IP octets.
        let ip = advertise_ip(bind_ip);
        let (p1, p2) = (port / 256, port % 256);
        let msg = format!(
            "227 Entering Passive Mode ({},{},{},{},{},{}).\r\n",
            ip[0], ip[1], ip[2], ip[3], p1, p2
        );
        self.pasv = Some(listener);
        write_half.write_all(msg.as_bytes()).await?;
        Ok(())
    }

    /// Accept the pending passive connection (with a short timeout).
    async fn accept_data(
        &mut self,
        write_half: &mut tokio::net::tcp::OwnedWriteHalf,
    ) -> std::io::Result<Option<TcpStream>> {
        let listener = match self.pasv.take() {
            Some(l) => l,
            None => {
                write_half.write_all(b"425 Use PASV first.\r\n").await?;
                return Ok(None);
            }
        };
        match tokio::time::timeout(std::time::Duration::from_secs(30), listener.accept()).await {
            Ok(Ok((stream, _))) => Ok(Some(stream)),
            _ => {
                write_half
                    .write_all(b"425 Data connection failed.\r\n")
                    .await?;
                Ok(None)
            }
        }
    }

    async fn handle_list(
        &mut self,
        arg: &str,
        write_half: &mut tokio::net::tcp::OwnedWriteHalf,
        log: &LogEmitter,
        names_only: bool,
    ) -> std::io::Result<()> {
        // LIST may carry flags like "-la"; ignore any leading '-' token.
        let path_arg = arg
            .split_whitespace()
            .find(|t| !t.starts_with('-'))
            .unwrap_or("");
        let dir = match self.resolve(path_arg) {
            Some((real, _)) => real,
            None => {
                write_half.write_all(b"550 Invalid path.\r\n").await?;
                return Ok(());
            }
        };

        let mut data = match self.accept_data(write_half).await? {
            Some(d) => d,
            None => return Ok(()),
        };
        write_half
            .write_all(b"150 Here comes the directory listing.\r\n")
            .await?;

        let body = build_listing(&dir, names_only);
        let res = data.write_all(body.as_bytes()).await;
        let _ = data.shutdown().await;
        match res {
            Ok(()) => {
                write_half.write_all(b"226 Directory send OK.\r\n").await?;
                log.line(format!("LIST {} -> 226", dir.display()));
            }
            Err(e) => {
                write_half
                    .write_all(b"426 Connection closed; transfer aborted.\r\n")
                    .await?;
                log.line(format!("LIST failed: {}", e));
            }
        }
        Ok(())
    }

    async fn handle_retr(
        &mut self,
        arg: &str,
        write_half: &mut tokio::net::tcp::OwnedWriteHalf,
        log: &LogEmitter,
    ) -> std::io::Result<()> {
        let path = match self.resolve(arg) {
            Some((real, _)) if real.is_file() => real,
            _ => {
                self.pasv = None;
                write_half.write_all(b"550 File not found.\r\n").await?;
                return Ok(());
            }
        };

        let mut data = match self.accept_data(write_half).await? {
            Some(d) => d,
            None => return Ok(()),
        };
        write_half
            .write_all(b"150 Opening data connection.\r\n")
            .await?;

        let result = async {
            let mut file = tokio::fs::File::open(&path).await?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                data.write_all(&buf[..n]).await?;
            }
            data.flush().await
        }
        .await;
        let _ = data.shutdown().await;

        match result {
            Ok(()) => {
                write_half.write_all(b"226 Transfer complete.\r\n").await?;
                log.line(format!("RETR {} -> 226", path.display()));
            }
            Err(e) => {
                write_half.write_all(b"426 Transfer aborted.\r\n").await?;
                log.line(format!("RETR failed: {}", e));
            }
        }
        Ok(())
    }

    async fn handle_stor(
        &mut self,
        arg: &str,
        write_half: &mut tokio::net::tcp::OwnedWriteHalf,
        log: &LogEmitter,
    ) -> std::io::Result<()> {
        let path = match self.resolve(arg) {
            Some((real, _)) => real,
            None => {
                self.pasv = None;
                write_half.write_all(b"550 Invalid path.\r\n").await?;
                return Ok(());
            }
        };

        let mut data = match self.accept_data(write_half).await? {
            Some(d) => d,
            None => return Ok(()),
        };
        write_half.write_all(b"150 Ok to send data.\r\n").await?;

        let result = async {
            let mut file = tokio::fs::File::create(&path).await?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = data.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).await?;
            }
            file.flush().await
        }
        .await;

        match result {
            Ok(()) => {
                write_half.write_all(b"226 Transfer complete.\r\n").await?;
                log.line(format!("STOR {} -> 226", path.display()));
            }
            Err(e) => {
                write_half.write_all(b"426 Transfer aborted.\r\n").await?;
                log.line(format!("STOR failed: {}", e));
            }
        }
        Ok(())
    }
}

/// Derive four IP octets to advertise in a PASV reply. A wildcard bind
/// (`0.0.0.0`/empty) is reported as loopback, which works for local clients.
fn advertise_ip(bind: &str) -> [u8; 4] {
    if let Ok(addr) = bind.parse::<std::net::Ipv4Addr>() {
        if !addr.is_unspecified() {
            return addr.octets();
        }
    }
    [127, 0, 0, 1]
}

/// Build a directory listing body. `names_only` selects NLST (bare names);
/// otherwise an `ls -l`-style LIST listing is produced.
fn build_listing(dir: &Path, names_only: bool) -> String {
    let mut out = String::new();
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if names_only {
            out.push_str(&name);
            out.push_str("\r\n");
            continue;
        }
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let perms = if is_dir { "drwxr-xr-x" } else { "-rw-r--r--" };
        // A fixed date keeps the format valid without pulling timestamps.
        out.push_str(&format!(
            "{} 1 owner group {:>12} Jan 01 00:00 {}\r\n",
            perms, size, name
        ));
    }
    out
}
