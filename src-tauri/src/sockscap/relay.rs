//! Local loopback relay: accept NAT'd connections from WinDivert helper,
//! attribute hostname (SNI / HTTP Host), apply policy, dial egress, bridge.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use crate::sockscap::config::{Decision, SocksCapConfig, UpstreamKind};
use crate::sockscap::egress;
use crate::sockscap::egress::ssh_pool::SshPool;
use crate::sockscap::helper::{self, HelperRegistry};
use crate::sockscap::policy::{PolicyEngine, PolicyInput};
use crate::sockscap::rules::CompiledRules;
use crate::sockscap::rules::dns_map::DnsMap;
use crate::sockscap::rules::sni::extract_hostname_from_prefix;
use crate::sockscap::stats::StatsCounters;

/// Each TCP relay consumes an accepted socket and normally one egress socket.
///
/// Windows global capture funnels *every* TCP connection on the machine through
/// here; a browser alone opens hundreds. 256 was far too low for that and made
/// saturation a routine event rather than an emergency. Windows has no
/// per-process descriptor limit worth defending against, so allow a real
/// ceiling there; on Linux stay well below the common 1024 soft
/// `RLIMIT_NOFILE`, which the rest of the desktop app also draws from.
pub(crate) const MAX_ACTIVE_RELAY_FLOWS: usize = if cfg!(windows) { 2048 } else { 512 };
pub(crate) const ACCEPT_BACKOFF_INITIAL: Duration = Duration::from_millis(50);
pub(crate) const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_PREFIX_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an accepted connection waits for a flow slot before being refused.
const RELAY_PERMIT_WAIT: Duration = Duration::from_secs(5);
/// A bridged flow that moves no bytes in *either* direction within this window
/// is treated as broken and torn down.
///
/// Deliberately only enforced before the first byte. Once a flow has carried
/// data, going quiet is normal — an idle SSH session, a websocket with
/// minute-scale pings — and tearing those down would be a regression. Keepalive
/// is the right detector for a peer that dies mid-session.
const RELAY_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(300);
/// Start probing an idle connection after this long, then every interval.
const RELAY_KEEPALIVE_IDLE: Duration = Duration::from_secs(60);
const RELAY_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

pub struct RelayHandle {
    pub port: u16,
    stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl RelayHandle {
    pub(crate) fn new(port: u16, stop: Arc<AtomicBool>, task: JoinHandle<()>) -> Self {
        Self { port, stop, task }
    }

    /// Stop accept loops promptly.
    ///
    /// Must wake **both** IPv4 and IPv6 listeners (we bind 0.0.0.0 and optionally ::).
    /// A previous bug only connected to 127.0.0.1, leaving the IPv6 accept task
    /// blocked forever so `Stop` never returned.
    pub async fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let port = self.port;
        // Best-effort wake of both stacks (ignore connect errors).
        let wake_v4 = TcpStream::connect(("127.0.0.1", port));
        let wake_v6 = TcpStream::connect((Ipv6Addr::LOCALHOST, port));
        let _ = tokio::join!(wake_v4, wake_v6);

        let mut task = self.task;
        tokio::select! {
            _ = &mut task => {}
            _ = tokio::time::sleep(Duration::from_millis(800)) => {
                tracing::warn!(
                    "sockscap relay accept loops did not exit within 800ms; aborting task"
                );
                task.abort();
                let _ = task.await;
            }
        }
    }
}

pub(crate) fn new_relay_flow_limiter() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_ACTIVE_RELAY_FLOWS))
}

/// Wait up to `max_wait` for relay capacity, polling `stop` so Stop is never
/// held up behind a full semaphore. The permit is owned by the spawned flow task
/// and releases on every success, error, cancellation, or panic path.
///
/// Returns `None` when the relay is stopping, the semaphore is closed, or the
/// wait elapsed; callers distinguish by testing `stop`.
pub(crate) async fn acquire_relay_flow_permit(
    limiter: &Arc<Semaphore>,
    stop: &AtomicBool,
    max_wait: Duration,
) -> Option<OwnedSemaphorePermit> {
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return None;
        }
        let slice = std::cmp::min(Duration::from_millis(100), deadline - now);
        match tokio::time::timeout(slice, Arc::clone(limiter).acquire_owned()).await {
            Ok(Ok(permit)) => return Some(permit),
            Ok(Err(_)) => return None,
            Err(_) => {}
        }
    }
}

/// Enable TCP keepalive so a peer that disappears silently — process killed,
/// NAT idle timeout, laptop suspended, route withdrawn — is detected instead of
/// holding a flow slot until the process restarts.
fn enable_keepalive(stream: &TcpStream) {
    let params = socket2::TcpKeepalive::new()
        .with_time(RELAY_KEEPALIVE_IDLE)
        .with_interval(RELAY_KEEPALIVE_INTERVAL);
    if let Err(e) = socket2::SockRef::from(stream).set_tcp_keepalive(&params) {
        tracing::debug!("sockscap relay: could not enable TCP keepalive: {e}");
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedUpstream {
    pub kind: UpstreamKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub ssh_pool: Option<Arc<SshPool>>,
    /// Loopback SOCKS port of this profile's xray-core sidecar, when the
    /// upstream kind is core-backed (shadowsocks/trojan/vmess/vless/wireguard).
    /// The relay dials this port through the plain socks5 egress.
    pub xray_port: Option<u16>,
}

pub struct RelayContext {
    pub config: SocksCapConfig,
    pub rules: Option<CompiledRules>,
    pub helper: Arc<HelperRegistry>,
    /// Long-lived control channel to the elevated helper (Windows capture).
    /// `None` on backends that recover the destination locally, such as Linux's
    /// `SO_ORIGINAL_DST`.
    pub helper_client: Option<Arc<helper::HelperClient>>,
    pub stats: Arc<StatsCounters>,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub upstream_user: String,
    pub upstream_pass: String,
    pub self_pid: u32,
    /// Shared SSH session when upstream kind is SSH.
    pub ssh_pool: Option<Arc<SshPool>>,
    /// Loopback SOCKS port of the global upstream's xray-core sidecar, when the
    /// global upstream kind is core-backed.
    pub xray_port: Option<u16>,
    pub profile_upstreams: std::collections::HashMap<String, ResolvedUpstream>,
    /// IP → hostname learned from SNI / HTTP Host.
    pub dns_map: Arc<Mutex<DnsMap>>,
    /// Domain & flow traffic tracker
    pub domains: Arc<Mutex<crate::sockscap::stats::DomainTracker>>,
}

/// Metadata recovered by an OS capture backend before a redirected connection
/// enters the shared policy relay. Windows obtains it from the WinDivert helper;
/// Linux reads `SO_ORIGINAL_DST` from the nftables-redirected socket.
#[derive(Debug, Clone)]
pub(crate) struct CapturedFlow {
    pub destination: SocketAddr,
    pub process_path: Option<String>,
    pub pid: Option<u32>,
    pub origin: SocketAddr,
    pub profile_id_hint: Option<String>,
}

/// Bind **0.0.0.0:0** (all interfaces) — required for WinDivert streamdump-style
/// reflection, which delivers connections as `remote → client_lan_ip:relay`
/// rather than to 127.0.0.1. Unknown peers without a redirect mapping are dropped.
/// IPv6: also listen on `[::]:port` when available.
pub async fn start_relay(ctx: Arc<RwLock<RelayContext>>) -> Result<RelayHandle, String> {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("relay bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // Best-effort dual-stack IPv6 any.
    let listener_v6 = TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port))
        .await
        .ok();

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let limiter = new_relay_flow_limiter();
    let task = tokio::spawn(async move {
        let stop_v4 = Arc::clone(&stop2);
        let ctx_v4 = Arc::clone(&ctx);
        let limiter_v4 = Arc::clone(&limiter);
        let v4 = accept_loop(listener, ctx_v4, stop_v4, limiter_v4);

        if let Some(l6) = listener_v6 {
            let stop_v6 = Arc::clone(&stop2);
            let ctx_v6 = Arc::clone(&ctx);
            let limiter_v6 = Arc::clone(&limiter);
            let v6 = accept_loop(l6, ctx_v6, stop_v6, limiter_v6);
            let _ = tokio::join!(v4, v6);
        } else {
            v4.await;
        }
    });
    Ok(RelayHandle::new(port, stop, task))
}

async fn accept_loop(
    listener: TcpListener,
    ctx: Arc<RwLock<RelayContext>>,
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
        let (sock, peer) = match listener.accept().await {
            Ok(v) => {
                accept_backoff = ACCEPT_BACKOFF_INITIAL;
                v
            }
            Err(error) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(
                    "sockscap relay accept failed: {error}; retrying in {}ms",
                    accept_backoff.as_millis()
                );
                tokio::time::sleep(accept_backoff).await;
                accept_backoff =
                    std::cmp::min(accept_backoff.saturating_mul(2), ACCEPT_BACKOFF_MAX);
                continue;
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }

        // Capacity is claimed *after* accepting, and never blocks the loop
        // indefinitely. Waiting for a permit before `accept` left the listener
        // un-drained: connections piled into the kernel backlog and, once it
        // filled, further SYNs were dropped. Because the client's SYN had
        // already been reflected toward the relay, the application saw an
        // indefinite hang rather than a refusal — the whole machine looked
        // wedged. Refusing promptly instead gives the app an error it can retry.
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT).await
        else {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tracing::warn!(
                "sockscap relay at capacity ({MAX_ACTIVE_RELAY_FLOWS} concurrent flows); \
                 refusing {peer} after waiting {}s",
                RELAY_PERMIT_WAIT.as_secs()
            );
            drop(sock);
            continue;
        };
        let ctx = Arc::clone(&ctx);
        clients.spawn(async move {
            let _permit = permit;
            if let Err(e) = handle_client(sock, peer, ctx).await {
                // Mapping miss / upstream fail are the usual "proxy does nothing" causes.
                tracing::warn!("sockscap relay client {peer}: {e}");
            }
        });
    }
    clients.shutdown().await;
}

async fn handle_client(
    client: TcpStream,
    peer: SocketAddr,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let peer_port = peer.port();
    let peer_ip = peer.ip().to_string();

    // Take a handle and release the context lock immediately. This lookup is a
    // round trip to another process; the previous code held both this read lock
    // and the helper registry's mutex across it, so every captured connection
    // queued behind every other one.
    let rpc = { ctx.read().await.helper_client.clone() };
    let rpc = rpc.ok_or_else(|| "helper control channel missing".to_string())?;

    // Streamdump peer is orig_remote:client_sport — prefer exact ip:port key.
    let mapping = match rpc.lookup_orig(&peer_ip, peer_port).await {
        Ok(m) => m,
        Err(_) => rpc.lookup_orig("", peer_port).await?,
    };
    let dst_ip: IpAddr = mapping
        .dst_ip
        .parse()
        .map_err(|e| format!("bad dst ip: {e}"))?;
    let flow = CapturedFlow {
        destination: SocketAddr::new(dst_ip, mapping.dst_port),
        process_path: (!mapping.path.is_empty()).then_some(mapping.path),
        pid: (mapping.pid != 0).then_some(mapping.pid),
        origin: peer,
        profile_id_hint: None,
    };
    handle_captured_client(client, flow, ctx).await
}

/// Apply shared hostname/policy/egress processing to a flow whose original
/// destination was recovered by a platform capture backend.
pub(crate) async fn handle_captured_client(
    mut client: TcpStream,
    flow: CapturedFlow,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String> {
    let destination = flow.destination;
    let process_path = flow.process_path;
    let pid = flow.pid;
    let origin = flow.origin;
    let profile_id_hint = flow.profile_id_hint;

    // The captured side is a real socket on every backend; keep it probed so a
    // vanished client releases its flow slot.
    enable_keepalive(&client);

    // Multi-read peek for SNI / HTTP Host (ClientHello may span packets).
    let (prefix, hostname) = peek_for_hostname(&mut client).await;

    let snap = {
        let g = ctx.read().await;
        // Learn IP→host from this flow for later pure-IP connections.
        if let Some(host) = hostname.as_ref() {
            if let Ok(mut map) = g.dns_map.lock() {
                map.insert(destination.ip(), host.clone(), None);
            }
        }

        // Prefer live SNI/Host, then dns_map, then none.
        let host_for_policy = hostname.clone().or_else(|| {
            g.dns_map
                .lock()
                .ok()
                .and_then(|mut m| m.lookup(destination.ip()))
        });

        let engine = PolicyEngine::from_config(&g.config, g.rules.as_ref());
        let input = PolicyInput {
            host: host_for_policy,
            ip: Some(destination.ip()),
            port: destination.port(),
            process_path: process_path.clone(),
            pid,
        };
        let trace = engine.decide_with_profile_hint(&input, profile_id_hint.as_deref());

        let (kind, up_host, up_port, up_user, up_pass, ssh_pool, xray_port) =
            match trace.profile_id.as_deref() {
                Some(pid) if g.profile_upstreams.contains_key(pid) => {
                    let up = &g.profile_upstreams[pid];
                    (
                        up.kind,
                        up.host.clone(),
                        up.port,
                        up.user.clone(),
                        up.pass.clone(),
                        up.ssh_pool.clone(),
                        up.xray_port,
                    )
                }
                _ => (
                    g.config.upstream.kind,
                    g.upstream_host.clone(),
                    g.upstream_port,
                    g.upstream_user.clone(),
                    g.upstream_pass.clone(),
                    g.ssh_pool.clone(),
                    g.xray_port,
                ),
            };

        (
            hostname,
            trace,
            kind,
            up_host,
            up_port,
            up_user,
            up_pass,
            Arc::clone(&g.stats),
            ssh_pool,
            Arc::clone(&g.domains),
            xray_port,
        )
    };

    let (
        hostname,
        trace,
        kind,
        up_host,
        up_port,
        up_user,
        up_pass,
        stats,
        ssh_pool,
        domains,
        xray_port,
    ) = snap;

    // Prefer hostname for dial when known (proxy-side DNS).
    let dial_host = hostname.unwrap_or_else(|| destination.ip().to_string());
    let dest_port = destination.port();

    let res = match trace.decision {
        Decision::Block => {
            stats.record_decision(false, true);
            if let Ok(mut doms) = domains.lock() {
                doms.record(
                    dial_host.clone(),
                    trace.decision,
                    trace.matched_rule.clone(),
                    trace.profile_name.clone(),
                    process_path.clone(),
                    pid,
                    0,
                    0,
                );
            }
            return Err(format!(
                "blocked {dial_host}:{dest_port} ({})",
                trace.reason
            ));
        }
        Decision::Direct => {
            stats.record_decision(false, false);
            let mut remote = tokio::time::timeout(
                RELAY_DIAL_TIMEOUT,
                TcpStream::connect((dial_host.as_str(), dest_port)),
            )
            .await
            .map_err(|_| {
                format!(
                    "direct connect {dial_host}:{dest_port}: timed out after {}s",
                    RELAY_DIAL_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("direct connect {dial_host}:{dest_port}: {e}"))?;
            write_prefix(&mut remote, &prefix).await?;
            bridge_tcp(&mut client, &mut remote).await
        }
        Decision::Proxy => {
            stats.record_decision(true, false);
            match kind {
                UpstreamKind::Http => {
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        egress::http_connect::dial(
                            &up_host, up_port, &dial_host, dest_port, &up_user, &up_pass,
                        ),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "HTTP proxy {up_host}:{up_port} connect to {dial_host}:{dest_port}: timed out after {}s",
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_tcp(&mut client, &mut remote).await
                }
                UpstreamKind::Socks5 => {
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        egress::socks5::dial(
                            &up_host, up_port, &dial_host, dest_port, &up_user, &up_pass,
                        ),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "SOCKS5 proxy {up_host}:{up_port} connect to {dial_host}:{dest_port}: timed out after {}s",
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_tcp(&mut client, &mut remote).await
                }
                UpstreamKind::Ssh => {
                    let pool = ssh_pool.ok_or_else(|| "SSH pool not initialized".to_string())?;
                    let origin_ip = origin.ip().to_string();
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        pool.dial(&dial_host, dest_port, &origin_ip, origin.port()),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "SSH connect to {dial_host}:{dest_port}: timed out after {}s",
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_any(&mut client, &mut remote).await
                }
                // xray-core–backed kinds (shadowsocks/trojan/vmess/vless/
                // wireguard): dial the per-profile local SOCKS inbound the
                // XrayManager opened for this upstream. All protocol/crypto/
                // transport work happens inside xray; the relay just bridges.
                other if other.requires_core() => {
                    let port = xray_port.ok_or_else(|| {
                        format!(
                            "{} upstream has no running xray core (check core provisioning / config)",
                            other.as_tag()
                        )
                    })?;
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        egress::socks5::dial(
                            "127.0.0.1", port, &dial_host, dest_port, "", "",
                        ),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "{} core (127.0.0.1:{port}) connect to {dial_host}:{dest_port}: timed out after {}s",
                            other.as_tag(),
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_tcp(&mut client, &mut remote).await
                }
                other => {
                    return Err(format!("unhandled upstream kind {}", other.as_tag()));
                }
            }
        }
    };

    match res {
        Ok((bytes_a, bytes_b)) => {
            let up = bytes_a + prefix.len() as u64;
            let down = bytes_b;
            stats.add_bytes(up, down);
            if let Ok(mut doms) = domains.lock() {
                doms.record(
                    dial_host,
                    trace.decision,
                    trace.matched_rule,
                    trace.profile_name,
                    process_path,
                    pid,
                    up,
                    down,
                );
            }
        }
        Err(e) => return Err(e),
    }

    Ok(())
}

/// Read until we extract a hostname, TLS record is complete, or budget exhausted.
async fn peek_for_hostname(client: &mut TcpStream) -> (Vec<u8>, Option<String>) {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(900);
    let mut prefix: Vec<u8> = Vec::new();
    while Instant::now() < deadline && prefix.len() < 16 * 1024 {
        if let Some(h) = extract_hostname_from_prefix(&prefix) {
            return (prefix, Some(h));
        }
        // TLS: wait for full record if we can see the length.
        if prefix.len() >= 5 && prefix[0] == 0x16 {
            let rec_len = u16::from_be_bytes([prefix[3], prefix[4]]) as usize;
            if prefix.len() >= 5 + rec_len {
                break;
            }
        } else if prefix.len() >= 32 {
            // Not TLS and no Host yet — stop waiting.
            if extract_hostname_from_prefix(&prefix).is_none()
                && !looks_like_incomplete_http(&prefix)
            {
                break;
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut buf = vec![0u8; 2048];
        match tokio::time::timeout(remaining, client.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => prefix.extend_from_slice(&buf[..n]),
            _ => break,
        }
    }
    let host = extract_hostname_from_prefix(&prefix);
    (prefix, host)
}

async fn write_prefix<W>(remote: &mut W, prefix: &[u8]) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    if prefix.is_empty() {
        return Ok(());
    }
    tokio::time::timeout(RELAY_PREFIX_WRITE_TIMEOUT, remote.write_all(prefix))
        .await
        .map_err(|_| {
            format!(
                "prefix write timed out after {}s",
                RELAY_PREFIX_WRITE_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("prefix write: {e}"))
}

fn looks_like_incomplete_http(data: &[u8]) -> bool {
    if data.is_empty() || data[0] == 0x16 {
        return false;
    }
    let Ok(s) = std::str::from_utf8(data) else {
        return false;
    };
    let upper = s.to_ascii_uppercase();
    (upper.starts_with("GET ")
        || upper.starts_with("POST ")
        || upper.starts_with("HEAD ")
        || upper.starts_with("CONNECT "))
        && !s.contains("\r\n\r\n")
}

async fn bridge_tcp(a: &mut TcpStream, b: &mut TcpStream) -> Result<(u64, u64), String> {
    // Both ends are real sockets here (direct, HTTP CONNECT, SOCKS5 and the
    // xray-core inbound all return one), so both get keepalive.
    enable_keepalive(b);
    bridge_any(a, b).await
}

/// Wraps a stream so the bridge can tell whether any data has moved, without
/// giving up `copy_bidirectional`'s buffering. Only reads are counted: every
/// byte that crosses the bridge is read from one side first.
struct Activity<'a, S> {
    inner: &'a mut S,
    reads: Arc<AtomicU64>,
}

impl<S: AsyncRead + Unpin> AsyncRead for Activity<'_, S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        let before = buf.filled().len();
        let r = Pin::new(&mut *me.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            me.reads.fetch_add(1, Ordering::Relaxed);
        }
        r
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Activity<'_, S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.get_mut().inner).poll_shutdown(cx)
    }
}

async fn bridge_any<A, B>(a: &mut A, b: &mut B) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    bridge_any_until(a, b, RELAY_FIRST_BYTE_TIMEOUT).await
}

async fn bridge_any_until<A, B>(
    a: &mut A,
    b: &mut B,
    first_byte_timeout: Duration,
) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let reads = Arc::new(AtomicU64::new(0));
    let mut ta = Activity {
        inner: a,
        reads: Arc::clone(&reads),
    };
    let mut tb = Activity {
        inner: b,
        reads: Arc::clone(&reads),
    };
    let copy = tokio::io::copy_bidirectional(&mut ta, &mut tb);
    tokio::pin!(copy);

    // Guard only the establishment phase. A flow that has never moved a byte in
    // either direction is not going to; one that has is a legitimate session
    // whose quiet periods are none of our business. Without this, a flow that
    // connected but never spoke held its slot for the lifetime of the process —
    // which is how a handful of broken flows could exhaust capacity outright.
    tokio::select! {
        r = &mut copy => r.map_err(|e| format!("bridge: {e}")),
        _ = tokio::time::sleep(first_byte_timeout) => {
            if reads.load(Ordering::Relaxed) == 0 {
                Err(format!(
                    "no data in either direction within {:?}; abandoning flow",
                    first_byte_timeout
                ))
            } else {
                copy.await.map_err(|e| format!("bridge: {e}"))
            }
        }
    }
}

/// Resolve manual upstream fields from config.
pub fn upstream_from_config(cfg: &SocksCapConfig) -> (String, u16, String, String) {
    (
        cfg.upstream.host.clone(),
        cfg.upstream.port,
        cfg.upstream.username.clone(),
        String::new(),
    )
}

pub fn upstream_from_config_ref(
    up: &crate::sockscap::config::UpstreamRef,
) -> (String, u16, String, String) {
    (up.host.clone(), up.port, up.username.clone(), String::new())
}

pub fn relay_loopback_ip() -> Ipv4Addr {
    Ipv4Addr::new(127, 0, 0, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_flow_limiter_reserves_fd_headroom() {
        let limiter = new_relay_flow_limiter();
        assert_eq!(limiter.available_permits(), MAX_ACTIVE_RELAY_FLOWS);
        // Global capture funnels every TCP connection on the machine through
        // here, so the ceiling has to be well above a single browser's usage.
        assert!(MAX_ACTIVE_RELAY_FLOWS >= 512);
    }

    #[tokio::test]
    async fn relay_flow_permit_is_released_when_flow_finishes() {
        let limiter = Arc::new(Semaphore::new(1));
        let stop = AtomicBool::new(false);

        let permit = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT)
            .await
            .expect("capacity should be available");
        assert_eq!(limiter.available_permits(), 0);

        drop(permit);
        assert_eq!(limiter.available_permits(), 1);
    }

    #[tokio::test]
    async fn stopped_relay_does_not_wait_for_capacity() {
        let limiter = Arc::new(Semaphore::new(0));
        let stop = AtomicBool::new(true);

        let result = tokio::time::timeout(
            Duration::from_millis(50),
            acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT),
        )
        .await
        .expect("stop should be observed promptly");

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn saturated_relay_gives_up_instead_of_waiting_forever() {
        // The accept loop relies on this returning: it has already accepted the
        // connection and must get back to `accept()` rather than parking here
        // while the kernel backlog fills and clients hang.
        let limiter = Arc::new(Semaphore::new(0));
        let stop = AtomicBool::new(false);

        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            acquire_relay_flow_permit(&limiter, &stop, Duration::from_millis(250)),
        )
        .await
        .expect("must not block past its own deadline");

        assert!(result.is_none());
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[tokio::test]
    async fn capacity_freed_while_waiting_is_picked_up() {
        let limiter = Arc::new(Semaphore::new(1));
        let stop = AtomicBool::new(false);
        let held = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT)
            .await
            .expect("first permit");

        let l2 = Arc::clone(&limiter);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            drop(held);
            let _ = &l2;
        });

        let permit = acquire_relay_flow_permit(&limiter, &stop, Duration::from_secs(3)).await;
        assert!(permit.is_some(), "should acquire once the holder releases");
    }

    const TEST_FIRST_BYTE: Duration = Duration::from_millis(150);

    #[tokio::test]
    async fn bridge_abandons_a_flow_that_never_moves_a_byte() {
        // A flow that connects and then says nothing used to hold its slot for
        // the lifetime of the process.
        let (mut a, _a_peer) = tokio::io::duplex(64);
        let (mut b, _b_peer) = tokio::io::duplex(64);

        let err = bridge_any_until(&mut a, &mut b, TEST_FIRST_BYTE)
            .await
            .expect_err("should abandon");
        assert!(err.contains("no data"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn bridge_leaves_an_active_flow_alone_after_it_goes_quiet() {
        // Once data has flowed the connection is legitimate; quiet periods are
        // normal for SSH sessions and websockets and must not be torn down.
        let (mut a, mut a_peer) = tokio::io::duplex(64);
        let (mut b, mut b_peer) = tokio::io::duplex(64);

        let task =
            tokio::spawn(async move { bridge_any_until(&mut a, &mut b, TEST_FIRST_BYTE).await });

        a_peer.write_all(b"hello").await.expect("write");
        let mut buf = [0u8; 5];
        b_peer.read_exact(&mut buf).await.expect("read through");
        assert_eq!(&buf, b"hello");

        // Well past the first-byte window, with no further traffic.
        tokio::time::sleep(TEST_FIRST_BYTE * 4).await;
        assert!(!task.is_finished(), "active flow must not be abandoned");

        // Closing both ends completes the copy normally.
        drop(a_peer);
        drop(b_peer);
        let (up, _down) = task.await.expect("task").expect("clean finish");
        assert_eq!(up, 5);
    }
}
