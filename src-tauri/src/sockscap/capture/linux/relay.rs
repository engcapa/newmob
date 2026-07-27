//! Loopback relay for nftables REDIRECT traffic.

use std::mem::{size_of, zeroed};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{RwLock, Semaphore};
use tokio::task::JoinSet;

use crate::sockscap::relay::{
    ACCEPT_BACKOFF_INITIAL, ACCEPT_BACKOFF_MAX, CapturedFlow, MAX_ACTIVE_RELAY_FLOWS,
    RELAY_PERMIT_WAIT, RelayContext, RelayHandle, acquire_relay_flow_permit,
    new_relay_flow_limiter,
};

const SO_ORIGINAL_DST: libc::c_int = 80;

pub struct LinuxRelay {
    pub handle: RelayHandle,
    pub ipv6_ready: bool,
}

/// Start a loopback-only listener. nftables redirects locally-originated TCP
/// connections here, so accepting on all interfaces would only broaden attack
/// surface without helping capture.
pub async fn start_linux_relay(
    ctx: Arc<RwLock<RelayContext>>,
    profile_id_hint: Option<String>,
) -> Result<LinuxRelay, String> {
    let listener_v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| format!("bind Linux relay: {error}"))?;
    let port = listener_v4
        .local_addr()
        .map_err(|error| format!("read Linux relay port: {error}"))?
        .port();
    // On Linux the default dual-stack setting can make a plain `[::1]` bind
    // conflict with the IPv4 listener. Force v6-only so both loopback sockets
    // can coexist; when IPv6 is disabled, the caller limits nft redirect rules
    // to IPv4 instead of blackholing IPv6 TCP.
    let listener_v6 = match bind_loopback_v6(port) {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::warn!("Linux SocksCap IPv6 relay unavailable: {error}");
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

    Ok(LinuxRelay {
        handle: RelayHandle::new(port, stop, task),
        ipv6_ready,
    })
}

fn bind_loopback_v6(port: u16) -> Result<TcpListener, String> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))
        .map_err(|error| format!("create IPv6 Linux relay socket: {error}"))?;
    socket
        .set_only_v6(true)
        .map_err(|error| format!("set IPv6-only Linux relay socket: {error}"))?;
    socket
        .set_nonblocking(true)
        .map_err(|error| format!("set nonblocking IPv6 Linux relay socket: {error}"))?;
    let address = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0));
    socket
        .bind(&address.into())
        .map_err(|error| format!("bind IPv6 Linux relay: {error}"))?;
    socket
        .listen(1024)
        .map_err(|error| format!("listen IPv6 Linux relay: {error}"))?;
    TcpListener::from_std(socket.into()).map_err(|error| format!("adopt IPv6 Linux relay: {error}"))
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
        let (socket, peer) = match listener.accept().await {
            Ok(connection) => {
                accept_backoff = ACCEPT_BACKOFF_INITIAL;
                connection
            }
            Err(error) => {
                if !stop.load(Ordering::SeqCst) {
                    tracing::warn!(
                        "Linux SocksCap relay accept failed: {error}; retrying in {}ms",
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
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT).await
        else {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tracing::warn!(
                "Linux SocksCap relay at capacity ({MAX_ACTIVE_RELAY_FLOWS} concurrent flows); \
                 refusing {peer} after waiting {}s",
                RELAY_PERMIT_WAIT.as_secs()
            );
            drop(socket);
            continue;
        };

        let destination = match original_destination(&socket) {
            Ok(destination) => destination,
            Err(error) => {
                tracing::warn!(
                    "Linux SocksCap relay missing original destination for {peer}: {error}"
                );
                continue;
            }
        };
        let ctx = Arc::clone(&ctx);
        let profile_id_hint = profile_id_hint.clone();
        clients.spawn(async move {
            let _permit = permit;
            let flow = CapturedFlow {
                profile_id_hint: profile_id_hint.as_deref().map(str::to_owned),
                ..CapturedFlow::from_destination(destination, peer)
            };
            if let Err(error) =
                crate::sockscap::relay::handle_captured_client(socket, flow, ctx).await
            {
                tracing::warn!("Linux SocksCap relay client {peer}: {error}");
            }
        });
    }
    clients.shutdown().await;
}

/// Read the pre-NAT destination saved by the nftables REDIRECT hook.
pub fn original_destination(socket: &TcpStream) -> Result<SocketAddr, String> {
    match socket
        .local_addr()
        .map_err(|error| format!("read redirected socket address: {error}"))?
    {
        SocketAddr::V4(_) => original_destination_v4(socket.as_raw_fd()),
        SocketAddr::V6(_) => original_destination_v6(socket.as_raw_fd()),
    }
}

fn original_destination_v4(fd: std::os::fd::RawFd) -> Result<SocketAddr, String> {
    let mut address: libc::sockaddr_in = unsafe { zeroed() };
    let mut length = size_of::<libc::sockaddr_in>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_IP,
            SO_ORIGINAL_DST,
            (&mut address as *mut libc::sockaddr_in).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(format!(
            "getsockopt(SO_ORIGINAL_DST): {}",
            std::io::Error::last_os_error()
        ));
    }
    if length as usize != size_of::<libc::sockaddr_in>() {
        return Err("getsockopt(SO_ORIGINAL_DST) returned an invalid IPv4 address".into());
    }
    Ok(SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()),
        u16::from_be(address.sin_port),
    )))
}

fn original_destination_v6(fd: std::os::fd::RawFd) -> Result<SocketAddr, String> {
    let mut address: libc::sockaddr_in6 = unsafe { zeroed() };
    let mut length = size_of::<libc::sockaddr_in6>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::IPPROTO_IPV6,
            SO_ORIGINAL_DST,
            (&mut address as *mut libc::sockaddr_in6).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(format!(
            "getsockopt(IP6T_SO_ORIGINAL_DST): {}",
            std::io::Error::last_os_error()
        ));
    }
    if length as usize != size_of::<libc::sockaddr_in6>() {
        return Err("getsockopt(IP6T_SO_ORIGINAL_DST) returned an invalid IPv6 address".into());
    }
    Ok(SocketAddr::V6(SocketAddrV6::new(
        Ipv6Addr::from(address.sin6_addr.s6_addr),
        u16::from_be(address.sin6_port),
        address.sin6_flowinfo,
        address.sin6_scope_id,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_destination_option_is_the_linux_netfilter_value() {
        // SO_ORIGINAL_DST is defined by linux/netfilter_ipv4.h. Keeping the
        // value in one place makes a platform change explicit in review.
        assert_eq!(SO_ORIGINAL_DST, 80);
    }
}
