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
//!   - `requireControlApproval` (bool) require local consent before input (default true)
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

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use ironrdp::server::{
    ConnectionHandler, Credentials, DesktopSize, PostConnectionAction, RdpServer, ServerEvent,
    TlsIdentityCtx,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
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
#[cfg(target_os = "macos")]
mod gfx;
mod input;
#[cfg(target_os = "macos")]
pub(crate) use input::{control_permission_granted, request_control_permission};
mod metrics;
mod session;
mod tls;

use auth::AuthConfig;
use clipboard::ClipboardFactory;
use display::RdpDisplay;
use input::RdpInput;
use metrics::RdpMetrics;

const CONTROL_APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Pending local approvals are registered by the dedicated RDP server thread
/// and resolved by the main-window command handler.
#[derive(Default)]
pub(crate) struct ApprovalBroker {
    pending: Mutex<HashMap<String, std::sync::mpsc::Sender<bool>>>,
}

impl ApprovalBroker {
    fn register(&self, request_id: String) -> std::sync::mpsc::Receiver<bool> {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(request_id, tx);
        }
        rx
    }

    pub(crate) fn resolve(&self, request_id: &str, approved: bool) -> bool {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id));
        sender.is_some_and(|sender| sender.send(approved).is_ok())
    }

    fn cancel(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionApprovalRequest {
    request_id: String,
    peer: String,
    timeout_seconds: u64,
    expires_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RdpSessionEvent {
    state: &'static str,
    peer: String,
    view_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum ControlDecision {
    #[default]
    Unknown,
    Awaiting,
    Approved,
    Denied,
}

#[derive(Default)]
struct ControlGateState {
    peer: Option<SocketAddr>,
    decision: ControlDecision,
    request_id: Option<String>,
}

/// Input injection gate shared by the connection lifecycle handler and the
/// input handler. The prompt is raised on the first post-authentication input
/// event, not on raw TCP accept, so unauthenticated network probes cannot spam
/// local consent dialogs.
pub(crate) struct ControlGate {
    app: AppHandle,
    log: LogEmitter,
    approvals: Arc<ApprovalBroker>,
    cancel: CancellationToken,
    state: Mutex<ControlGateState>,
}

impl ControlGate {
    fn begin_session(&self, peer: SocketAddr) {
        if let Ok(mut state) = self.state.lock() {
            state.peer = Some(peer);
            state.decision = ControlDecision::Unknown;
        }
    }

    fn end_session(&self) {
        let request_id = self.state.lock().ok().and_then(|mut state| {
            state.peer = None;
            state.decision = ControlDecision::Denied;
            state.request_id.take()
        });
        if let Some(request_id) = request_id {
            self.approvals.cancel(&request_id);
        }
    }

    pub(crate) fn ensure_approved(&self) -> bool {
        let (peer, request_id) = {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            match state.decision {
                ControlDecision::Approved => return true,
                ControlDecision::Denied | ControlDecision::Awaiting => return false,
                ControlDecision::Unknown => {
                    state.decision = ControlDecision::Awaiting;
                    let Some(peer) = state.peer else {
                        state.decision = ControlDecision::Denied;
                        return false;
                    };
                    let request_id = uuid::Uuid::new_v4().to_string();
                    state.request_id = Some(request_id.clone());
                    (peer, request_id)
                }
            }
        };

        let receiver = self.approvals.register(request_id.clone());
        let request = ConnectionApprovalRequest {
            request_id: request_id.clone(),
            peer: peer.to_string(),
            timeout_seconds: CONTROL_APPROVAL_TIMEOUT.as_secs(),
            expires_at: crate::servers::now_ms() + CONTROL_APPROVAL_TIMEOUT.as_millis() as i64,
        };
        self.log.line(format!(
            "RDP control attempt from {peer}; waiting up to {}s for local approval",
            CONTROL_APPROVAL_TIMEOUT.as_secs()
        ));

        let delivered = self
            .app
            .emit_to("main", "server://rdp/connection-request", request)
            .is_ok();
        let approved = delivered && self.wait_for_approval(&request_id, &receiver);
        self.approvals.cancel(&request_id);

        let approved = self
            .state
            .lock()
            .ok()
            .filter(|state| {
                state.peer == Some(peer) && state.request_id.as_deref() == Some(request_id.as_str())
            })
            .map(|mut state| {
                state.request_id = None;
                state.decision = if approved {
                    ControlDecision::Approved
                } else {
                    ControlDecision::Denied
                };
                approved
            })
            .unwrap_or(false);
        self.log.line(format!(
            "RDP control from {peer} {}",
            if approved {
                "approved locally"
            } else {
                "denied, cancelled, or timed out"
            }
        ));
        approved
    }

    fn wait_for_approval(
        &self,
        request_id: &str,
        receiver: &std::sync::mpsc::Receiver<bool>,
    ) -> bool {
        let deadline = std::time::Instant::now() + CONTROL_APPROVAL_TIMEOUT;
        loop {
            if self.cancel.is_cancelled() {
                self.approvals.cancel(request_id);
                return false;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                self.approvals.cancel(request_id);
                return false;
            }
            let slice = deadline
                .saturating_duration_since(now)
                .min(std::time::Duration::from_millis(250));
            match receiver.recv_timeout(slice) {
                Ok(approved) => return approved,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
            }
        }
    }
}

struct ConnectionPolicy {
    app: AppHandle,
    log: LogEmitter,
    control_gate: Option<Arc<ControlGate>>,
    view_only: bool,
    active: bool,
}

impl ConnectionPolicy {
    fn emit_session(
        &self,
        state: &'static str,
        peer: SocketAddr,
        duration: Option<std::time::Duration>,
        reason: Option<String>,
    ) {
        let _ = self.app.emit(
            "server://rdp/session",
            RdpSessionEvent {
                state,
                peer: peer.to_string(),
                view_only: self.view_only,
                duration_ms: duration.map(|value| value.as_millis() as u64),
                reason,
            },
        );
    }
}

impl ConnectionHandler for ConnectionPolicy {
    fn on_accept(&mut self, peer: SocketAddr) -> bool {
        // IronRDP currently drives one connection at a time. Keep the invariant
        // explicit so a future concurrent accept loop cannot silently turn
        // console sharing into an uncontrolled multi-client service.
        if self.active {
            self.log.line(format!(
                "RDP rejected {peer}: single-client policy already has an active session"
            ));
            self.emit_session(
                "rejected",
                peer,
                None,
                Some("single-client policy".to_string()),
            );
            return false;
        }

        self.active = true;
        if let Some(gate) = &self.control_gate {
            gate.begin_session(peer);
        }
        self.log.line(format!(
            "RDP client connection from {peer} ({})",
            if self.view_only {
                "view-only"
            } else if self.control_gate.is_some() {
                "control requires local approval"
            } else {
                "unattended control"
            }
        ));
        self.emit_session("connecting", peer, None, None);
        true
    }

    fn on_disconnected(
        &mut self,
        peer: SocketAddr,
        duration: std::time::Duration,
        error: Option<&anyhow::Error>,
    ) -> PostConnectionAction {
        self.active = false;
        if let Some(gate) = &self.control_gate {
            gate.end_session();
        }
        let reason = error.map(ToString::to_string);
        self.log.line(format!(
            "RDP client {peer} disconnected after {:.1}s{}",
            duration.as_secs_f64(),
            reason
                .as_deref()
                .map(|value| format!(": {value}"))
                .unwrap_or_default()
        ));
        self.emit_session("disconnected", peer, Some(duration), reason);
        PostConnectionAction::Continue
    }
}

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
    let require_control_approval = config.bool_field("requireControlApproval", true);
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
    if !view_only && !require_control_approval {
        ctx.log.line(
            "RDP unattended control is enabled: authenticated clients can control this Mac without a local confirmation prompt.",
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
        app: ctx.app.clone(),
        approvals: ctx
            .app
            .state::<crate::state::AppState>()
            .servers
            .rdp_approvals
            .clone(),
        require_control_approval,
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
    app: AppHandle,
    approvals: Arc<ApprovalBroker>,
    require_control_approval: bool,
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
                let mut server = match build_server(&params, &log, thread_cancel.clone()) {
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
fn build_server(
    params: &ServerParams,
    log: &LogEmitter,
    cancel: CancellationToken,
) -> anyhow::Result<RdpServer> {
    let control_gate = (!params.view_only && params.require_control_approval).then(|| {
        Arc::new(ControlGate {
            app: params.app.clone(),
            log: log.clone(),
            approvals: params.approvals.clone(),
            cancel: cancel.clone(),
            state: Mutex::new(ControlGateState::default()),
        })
    });
    let metrics = RdpMetrics::new(log.clone());
    #[cfg(target_os = "macos")]
    if !params.view_only && !input::control_permission_granted() {
        anyhow::bail!(
            "Accessibility permission is required for RDP keyboard and mouse control. Open RDP Server settings, grant permission, then start the server again."
        );
    }
    #[cfg(target_os = "macos")]
    let gfx = gfx::GfxTransport::new(log.clone());
    let display = RdpDisplay::new(
        log.clone(),
        params.display_id.clone(),
        metrics.clone(),
        #[cfg(target_os = "macos")]
        gfx.clone(),
    )?;
    #[cfg(target_os = "macos")]
    let input_mapping = if params.view_only {
        None
    } else {
        Some(input::MacInputMapping::new(
            capture::mac::selected_display_bounds(params.display_id.as_deref())?,
            display.input_surface_size(),
        )?)
    };
    #[cfg(target_os = "macos")]
    let honor_client_desktop_size = display.supports_client_size();
    let input = RdpInput::new(
        log.clone(),
        params.view_only,
        control_gate.clone(),
        metrics.clone(),
        #[cfg(target_os = "macos")]
        input_mapping,
    );
    let cliprdr: Box<dyn ironrdp::server::CliprdrServerFactory> =
        Box::new(ClipboardFactory::new(log.clone()));

    let base = RdpServer::builder().with_addr(params.addr);
    let connection_handler: Box<dyn ConnectionHandler> = Box::new(ConnectionPolicy {
        app: params.app.clone(),
        log: log.clone(),
        control_gate,
        view_only: params.view_only,
        active: false,
    });

    let server = match params.security {
        SecurityMode::Hybrid => {
            let identity = &params.identity;
            let acceptor = identity.make_acceptor()?;
            let builder = base
                .with_hybrid(acceptor, identity.pub_key.clone())
                .with_input_handler(input)
                .with_display_handler(display)
                .with_cliprdr_factory(Some(cliprdr));
            #[cfg(target_os = "macos")]
            let builder = builder.with_honor_client_desktop_size(honor_client_desktop_size);
            #[cfg(target_os = "macos")]
            let builder = {
                log.line("RDP display transport: EGFX/AVC420 with decoded-frame bitmap fallback");
                builder.with_gfx_factory(Some(Box::new(gfx.factory())))
            };
            builder
                .with_connection_handler(Some(connection_handler))
                .build()
        }
    };
    Ok(server)
}

#[cfg(test)]
mod tests {
    use super::{ApprovalBroker, SecurityMode, SocketAddr};

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

    #[test]
    fn approval_broker_resolves_each_request_once() {
        let broker = ApprovalBroker::default();
        let receiver = broker.register("request-1".to_string());
        assert!(broker.resolve("request-1", true));
        assert_eq!(receiver.recv().unwrap(), true);
        assert!(!broker.resolve("request-1", false));
        assert!(!broker.resolve("missing", true));
    }
}
