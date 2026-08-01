//! Local proxy **ingress**: a loopback SOCKS5 / HTTP-CONNECT front end.
//!
//! Windows and Linux capture transparently, so their relays recover the target
//! from the OS (WinDivert's NAT table, `SO_ORIGINAL_DST`). macOS transparent
//! flows arrive through the separate Redirector IPC bridge and do not use this
//! listener. The ingress remains useful for explicit local proxy entry points.
//!
//! Everything after the handshake is identical to the other platforms: the flow
//! is handed to [`crate::sockscap::relay::handle_captured_client`], which owns
//! policy, GFWList, SNI attribution, egress dialing, and accounting.
//!
//! A hostname from a proxy handshake is *authoritative* — better than sniffing
//! SNI — so it is passed through as [`CapturedFlow::dest_host`] and DNS is left
//! to the upstream.
//!
//! Security: the listener binds loopback only and offers no authentication, so
//! any local process can reach the configured upstream through it — the same
//! exposure as `ssh -D` or any local proxy. It is never bound to a routable
//! address.

pub mod http;
pub mod socks5;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{RwLock, Semaphore};
use tokio::task::JoinSet;

use crate::sockscap::relay::{
    ACCEPT_BACKOFF_INITIAL, ACCEPT_BACKOFF_MAX, CapturedFlow, RELAY_PERMIT_WAIT, RelayContext,
    RelayHandle, acquire_relay_flow_permit, new_relay_flow_limiter,
};

/// A stalled handshake must not hold a flow permit indefinitely.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a client asked to go. Exactly one of `host` / `ip` is set: a hostname
/// is kept verbatim for upstream-side DNS, and a literal address is normalized
/// to `ip` so CIDR bypass and IP rules still apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngressTarget {
    pub host: Option<String>,
    pub ip: Option<IpAddr>,
    pub port: u16,
}

pub struct Ingress {
    pub handle: RelayHandle,
    pub ipv6_ready: bool,
}

/// Start the loopback proxy listener. Returns the port the OS proxy settings
/// (or a manually configured client) should point at.
pub async fn start_ingress(
    ctx: Arc<RwLock<RelayContext>>,
    profile_id_hint: Option<String>,
) -> Result<Ingress, String> {
    let listener_v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| format!("bind SocksCap proxy ingress: {error}"))?;
    let port = listener_v4
        .local_addr()
        .map_err(|error| format!("read SocksCap proxy ingress port: {error}"))?
        .port();

    // Clients that resolve "localhost" to ::1 must reach the same port.
    let listener_v6 = match bind_loopback_v6(port) {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::warn!("SocksCap proxy ingress IPv6 unavailable: {error}");
            None
        }
    };
    let ipv6_ready = listener_v6.is_some();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = Arc::clone(&stop);
    let profile_id_hint = profile_id_hint.map(Arc::<str>::from);
    let limiter = new_relay_flow_limiter();
    let task = tokio::spawn(async move {
        let v4 = accept_loop(
            listener_v4,
            Arc::clone(&ctx),
            Arc::clone(&stop_for_task),
            Arc::clone(&limiter),
            profile_id_hint.clone(),
        );
        if let Some(listener_v6) = listener_v6 {
            let v6 = accept_loop(
                listener_v6,
                ctx,
                Arc::clone(&stop_for_task),
                limiter,
                profile_id_hint,
            );
            let _ = tokio::join!(v4, v6);
        } else {
            v4.await;
        }
    });

    Ok(Ingress {
        handle: RelayHandle::new(port, stop, task),
        ipv6_ready,
    })
}

/// Bind `[::1]:port` as IPv6-only so it can coexist with the IPv4 listener.
fn bind_loopback_v6(port: u16) -> Result<TcpListener, String> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))
        .map_err(|error| format!("create IPv6 ingress socket: {error}"))?;
    socket
        .set_only_v6(true)
        .map_err(|error| format!("set IPv6-only ingress socket: {error}"))?;
    socket
        .set_nonblocking(true)
        .map_err(|error| format!("set nonblocking IPv6 ingress socket: {error}"))?;
    let address = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0));
    socket
        .bind(&address.into())
        .map_err(|error| format!("bind IPv6 ingress: {error}"))?;
    socket
        .listen(1024)
        .map_err(|error| format!("listen IPv6 ingress: {error}"))?;
    TcpListener::from_std(socket.into()).map_err(|error| format!("adopt IPv6 ingress: {error}"))
}

async fn accept_loop(
    listener: TcpListener,
    ctx: Arc<RwLock<RelayContext>>,
    stop: Arc<AtomicBool>,
    limiter: Arc<Semaphore>,
    profile_id_hint: Option<Arc<str>>,
) {
    let mut clients = JoinSet::new();
    let mut accept_backoff = ACCEPT_BACKOFF_INITIAL;
    loop {
        while clients.try_join_next().is_some() {}
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // OURS's `acquire_relay_flow_permit` now takes a `max_wait`, so `None`
        // means either "stopping" or "at capacity after waiting". Break only when
        // stopping; a transient capacity spike must not tear down the listener.
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT).await
        else {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tracing::warn!("SocksCap proxy ingress at capacity; retrying");
            continue;
        };
        let (socket, peer) = match listener.accept().await {
            Ok(connection) => {
                accept_backoff = ACCEPT_BACKOFF_INITIAL;
                connection
            }
            Err(error) => {
                if !stop.load(Ordering::SeqCst) {
                    tracing::warn!(
                        "SocksCap proxy ingress accept failed: {error}; retrying in {}ms",
                        accept_backoff.as_millis()
                    );
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

        let ctx = Arc::clone(&ctx);
        let profile_id_hint = profile_id_hint.clone();
        clients.spawn(async move {
            let _permit = permit;
            if let Err(error) = serve_client(socket, peer, ctx, profile_id_hint).await {
                tracing::warn!("SocksCap proxy ingress client {peer}: {error}");
            }
        });
    }
    clients.shutdown().await;
}

async fn serve_client(
    mut socket: TcpStream,
    peer: SocketAddr,
    ctx: Arc<RwLock<RelayContext>>,
    profile_id_hint: Option<Arc<str>>,
) -> Result<(), String> {
    let target = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut socket))
        .await
        .map_err(|_| {
            format!(
                "proxy handshake timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs()
            )
        })??;

    let flow = CapturedFlow {
        dest_ip: target.ip,
        dest_host: target.host,
        dest_port: target.port,
        // An explicit local proxy client does not provide process identity; its
        // loopback peer port would have to be mapped back to an owning process.
        process_path: None,
        pid: None,
        origin: peer,
        profile_id_hint: profile_id_hint.as_deref().map(str::to_owned),
    };
    crate::sockscap::relay::handle_captured_client(socket, flow, ctx).await
}

/// Pick the handshake by first byte: SOCKS5 always starts with its version.
async fn handshake(socket: &mut TcpStream) -> Result<IngressTarget, String> {
    let mut first = [0u8; 1];
    let peeked = socket
        .peek(&mut first)
        .await
        .map_err(|error| format!("peek proxy request: {error}"))?;
    if peeked == 0 {
        return Err("client closed the connection before sending a request".into());
    }
    if first[0] == socks5::VERSION {
        socks5::accept_handshake(socket).await
    } else {
        http::accept_handshake(socket).await
    }
}
