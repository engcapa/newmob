//! Real in-process RDP server built on `ironrdp-server` 0.10 (`ironrdp::server`).
//!
//! This is the SERVER half of RDP — it shares *this* machine's desktop with an
//! RDP client (mstsc, FreeRDP, Remote Desktop mobile). It is the mirror image of
//! the RDP *client* in `crate::rdp` (which connects out to a Windows host); the
//! two share the IronRDP umbrella but use opposite halves (`server`/`acceptor`
//! vs `connector`/`session`) and keep entirely separate state.
//!
//! Like [`super::ssh`], this is an in-process pure-Rust server (not an external
//! daemon like [`super::vnc`]), so `ServerStarted.pid` is `None`. It is NOT an
//! OS/PAM gateway: credentials are validated against the server config, never
//! against system accounts.
//!
//! Server-specific config (`config.extra`, camelCase as sent by the frontend):
//!   - `username`     (string) RDP username clients must present
//!   - `passwordRef`  (string) encrypted-vault reference resolved at startup
//!   - `domain`       (string) optional NLA domain
//!   - `viewOnly`     (bool)   ignore client keyboard/mouse input (default false)
//!   - `displayId`    (string) optional macOS display id; empty selects primary
//!   - `securityMode` (string) "hybrid" (NLA/CredSSP; the only production mode)
//!
//! ## Security
//!
//! Production mode is `hybrid` (NLA/CredSSP over TLS). TLS-only mode is not an
//! authentication mechanism in IronRDP and plain RDP has no transport
//! encryption, so both are rejected. TLS uses a self-signed cert cached in
//! app-data (see [`tls`]); credentials are mandatory and are only present in
//! memory after resolving the encrypted vault reference.
//!
//! ## Cancel bridge (the one new integration step vs `ssh.rs`)
//!
//! `RdpServer::run()` owns its own accept loop and is not aware of `ctx.cancel`.
//! It does, however, expose `event_sender()`: sending [`ServerEvent::Quit`] makes
//! the loop break cleanly the next time it is idle on the listener. We spawn a
//! small bridge task that forwards `ctx.cancel` → `ServerEvent::Quit`, and also
//! race `run()` against the cancel token as a hard backstop for the case where a
//! client connection is mid-flight when stop is requested.

use std::net::SocketAddr;

use ironrdp::server::{Credentials, DesktopSize, RdpServer, ServerEvent, TlsIdentityCtx};
use tokio_util::sync::CancellationToken;

use super::ServerConfig;
use super::engine::{LogEmitter, ServerCtx, ServerStarted};

mod auth;
/// Screen-capture backends (X11 / Wayland). Exposed crate-wide so the LanChat
/// native A/V stack can reuse the X11 capturer for screen sharing.
pub(crate) mod capture;
mod clipboard;
mod diff;
mod display;
mod input;
mod session;
mod tls;

use auth::AuthConfig;
use clipboard::ClipboardFactory;
use display::RdpDisplay;
use input::RdpInput;

/// The only production security mode: NLA/CredSSP over TLS.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SecurityMode {
    Hybrid,
}

impl SecurityMode {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "hybrid" | "nla" => Ok(SecurityMode::Hybrid),
            other => Err(format!(
                "RDP security mode '{other}' is disabled: production server requires NLA/CredSSP over TLS"
            )),
        }
    }
}

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 3389 } else { config.port };
    let bind = config.bind_address.clone();

    let view_only = config.bool_field("viewOnly", false);
    let display_id = config.str_field("displayId", "").trim().to_string();
    let display_id = (!display_id.is_empty()).then_some(display_id);
    let security = SecurityMode::parse(config.str_field("securityMode", "hybrid"))?;

    let auth = AuthConfig::from_fields(
        config.str_field("username", ""),
        config.str_field("password", ""),
        config.str_field("domain", ""),
    );
    let auth = auth?;

    // Resolve the bind address to a concrete SocketAddr up front so a bad
    // address surfaces as a startup error rather than inside the spawned task.
    let addr: SocketAddr = format!("{}:{}", bind, port)
        .parse()
        .map_err(|e| format!("invalid RDP bind address {}:{} — {}", bind, port, e))?;

    if addr.ip().is_unspecified() && !config.bool_field("allowPublicBind", false) {
        return Err(
            "RDP refuses to bind all network interfaces without explicit allowPublicBind consent"
                .to_string(),
        );
    }
    if addr.ip().is_unspecified() {
        ctx.log.line(
            "RDP public bind explicitly enabled — protect this port with a host firewall and \
             expose it only to trusted networks.",
        );
    }

    let identity = tls::identity(&ctx.app).map_err(|e| format!("RDP TLS setup failed: {}", e))?;
    ctx.log
        .line("loaded self-signed TLS certificate for NLA/CredSSP");

    let size = DesktopSize {
        width: 1920,
        height: 1080,
    };

    ctx.log.line(format!(
        "RDP capture: {}",
        capture::capture_capability_summary()
    ));

    // Phase 7 (Linux advanced): independent/headless virtual sessions. The base
    // server mirrors the current console desktop; when the user asks for a
    // virtual session we report what the host can actually do rather than
    // silently falling back to the console mirror.
    if config.bool_field("headlessSession", false) {
        let caps = session::probe();
        ctx.log.line(format!(
            "headless/virtual session requested — {}. This build mirrors the current \
             console desktop; per-session virtual displays (xrdp model) are not yet a live \
             gateway. Sharing the console desktop instead.",
            caps.summary()
        ));
    }

    ctx.log.line(format!(
        "RDP server listening on {} ({}x{}, {:?} security, {})",
        addr,
        size.width,
        size.height,
        security,
        if view_only {
            "view-only"
        } else {
            "interactive"
        }
    ));

    let params = ServerParams {
        addr,
        view_only,
        security,
        identity,
        credentials: auth.to_credentials(),
        display_id,
    };
    let task = spawn_server(params, ctx.cancel.clone(), ctx.log.clone()).await?;
    Ok(ServerStarted { pid: None, task })
}

/// Everything the server thread needs to build and run the [`RdpServer`].
struct ServerParams {
    addr: SocketAddr,
    view_only: bool,
    security: SecurityMode,
    identity: TlsIdentityCtx,
    credentials: Credentials,
    display_id: Option<String>,
}

/// Drive `RdpServer::run()` and bridge `cancel` → clean shutdown.
///
/// `RdpServer` and its `run()` future are `!Send` (they hold `Rc` internally),
/// so they cannot live on Tauri's multi-threaded Tokio runtime via
/// `tokio::spawn`. Instead we own a dedicated OS thread running a
/// `current_thread` runtime — mirroring the official example's
/// `#[tokio::main(flavor = "current_thread")]` — and build the server *inside*
/// that thread. The returned [`JoinHandle`] is an async wrapper that waits for
/// that thread to finish, so the registry's `task.abort()` plus the `cancel`
/// token both tear it down cleanly.
async fn spawn_server(
    params: ServerParams,
    cancel: CancellationToken,
    log: LogEmitter,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<SocketAddr, String>>();
    let thread_cancel = cancel.clone();
    let thread = std::thread::Builder::new()
        .name("rdp-server".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("failed to start RDP runtime: {e}")));
                    log.line(format!("RDP server: failed to start runtime: {}", e));
                    return;
                }
            };

            rt.block_on(async move {
                let mut server = match build_server(&params, &log) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        log.line(format!("RDP server: {}", e));
                        return;
                    }
                };
                server.set_credentials(Some(params.credentials.clone()));

                let ev_sender = server.event_sender().clone();
                let (addr_tx, addr_rx) = tokio::sync::oneshot::channel();
                if ev_sender.send(ServerEvent::GetLocalAddr(addr_tx)).is_err() {
                    let _ = ready_tx.send(Err("RDP listener event channel closed".to_string()));
                    return;
                }
                let run = server.run();
                tokio::pin!(run);

                tokio::select! {
                    bound = addr_rx => {
                        let result = bound
                            .map_err(|_| "RDP listener readiness channel closed".to_string())
                            .and_then(|addr| addr.ok_or_else(|| "RDP listener did not report an address".to_string()));
                        if ready_tx.send(result).is_err() {
                            return;
                        }
                    }
                    res = &mut run => {
                        let message = res
                            .err()
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "RDP listener stopped before becoming ready".to_string());
                        let _ = ready_tx.send(Err(message));
                        return;
                    }
                    _ = thread_cancel.cancelled() => {
                        let _ = ready_tx.send(Err("RDP server startup cancelled".to_string()));
                        return;
                    }
                }

                tokio::select! {
                    res = &mut run => {
                        if let Err(e) = res {
                            log.line(format!("RDP server error: {}", e));
                        }
                    }
                    _ = thread_cancel.cancelled() => {
                        let _ = ev_sender.send(ServerEvent::Quit("server stopped".to_string()));
                    }
                }
                log.line("RDP server stopped");
            });
        });

    let handle = thread.map_err(|e| format!("failed to spawn RDP server thread: {e}"))?;

    let task = tokio::task::spawn_blocking(move || {
        let _ = handle.join();
    });
    match tokio::time::timeout(std::time::Duration::from_secs(5), ready_rx).await {
        Ok(Ok(Ok(addr))) => {
            log_ready(addr);
            Ok(task)
        }
        Ok(Ok(Err(e))) => {
            cancel.cancel();
            let _ = task.await;
            Err(format!("RDP listener failed to start: {e}"))
        }
        Ok(Err(_)) => {
            cancel.cancel();
            let _ = task.await;
            Err("RDP listener readiness channel closed".to_string())
        }
        Err(_) => {
            cancel.cancel();
            let _ = task.await;
            Err("timed out waiting for RDP listener readiness".to_string())
        }
    }
}

fn log_ready(addr: SocketAddr) {
    tracing::info!(%addr, "RDP listener ready");
}

/// Assemble the [`RdpServer`] for the requested security mode. Each branch
/// produces a different builder type (the builder is a typestate machine), so
/// the input/display/build tail is repeated per branch.
fn build_server(params: &ServerParams, log: &LogEmitter) -> anyhow::Result<RdpServer> {
    let input = RdpInput::new(log.clone(), params.view_only);
    let display = RdpDisplay::new(log.clone(), params.display_id.clone())?;
    let cliprdr: Box<dyn ironrdp::server::CliprdrServerFactory> =
        Box::new(ClipboardFactory::new(log.clone()));

    let base = RdpServer::builder().with_addr(params.addr);

    let server = match params.security {
        SecurityMode::Hybrid => {
            let identity = &params.identity;
            let acceptor = identity.make_acceptor()?;
            base.with_hybrid(acceptor, identity.pub_key.clone())
                .with_input_handler(input)
                .with_display_handler(display)
                .with_cliprdr_factory(Some(cliprdr))
                .build()
        }
    };
    Ok(server)
}

#[cfg(test)]
mod tests {
    use super::{SecurityMode, SocketAddr};

    #[test]
    fn production_security_accepts_only_hybrid() {
        assert_eq!(SecurityMode::parse("hybrid"), Ok(SecurityMode::Hybrid));
        assert_eq!(SecurityMode::parse("NLA"), Ok(SecurityMode::Hybrid));
        assert!(SecurityMode::parse("tls").is_err());
        assert!(SecurityMode::parse("none").is_err());
    }

    #[test]
    fn socket_address_detects_public_wildcards() {
        let ipv4: SocketAddr = "0.0.0.0:3389".parse().unwrap();
        let ipv6: SocketAddr = "[::]:3389".parse().unwrap();
        assert!(ipv4.ip().is_unspecified());
        assert!(ipv6.ip().is_unspecified());
    }
}
