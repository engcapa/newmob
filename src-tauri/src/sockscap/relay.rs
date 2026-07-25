//! Local loopback relay: accept NAT'd connections from WinDivert helper,
//! attribute hostname (SNI / HTTP Host), apply policy, dial egress, bridge.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
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
/// Keep enough headroom below the common Linux soft RLIMIT_NOFILE of 1024 for
/// the rest of the desktop application.
pub(crate) const MAX_ACTIVE_RELAY_FLOWS: usize = 256;
pub(crate) const ACCEPT_BACKOFF_INITIAL: Duration = Duration::from_millis(50);
pub(crate) const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_PREFIX_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Wait for relay capacity without making Stop wait indefinitely behind a full
/// semaphore. The permit is owned by the spawned flow task and releases on
/// every success, error, cancellation, or panic path.
pub(crate) async fn acquire_relay_flow_permit(
    limiter: &Arc<Semaphore>,
    stop: &AtomicBool,
) -> Option<OwnedSemaphorePermit> {
    loop {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        match tokio::time::timeout(
            Duration::from_millis(100),
            Arc::clone(limiter).acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => return Some(permit),
            Ok(Err(_)) => return None,
            Err(_) => {}
        }
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
}

pub struct RelayContext {
    pub config: SocksCapConfig,
    pub rules: Option<CompiledRules>,
    pub helper: Arc<HelperRegistry>,
    pub stats: Arc<StatsCounters>,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub upstream_user: String,
    pub upstream_pass: String,
    pub self_pid: u32,
    /// Shared SSH session when upstream kind is SSH.
    pub ssh_pool: Option<Arc<SshPool>>,
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
        let Some(permit) = acquire_relay_flow_permit(&limiter, &stop).await else {
            break;
        };
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

    let mapping = {
        let g = ctx.read().await;
        let guard = g.helper.inner.lock().map_err(|e| e.to_string())?;
        let sess = guard
            .as_ref()
            .ok_or_else(|| "helper session missing".to_string())?;
        // Streamdump peer is orig_remote:client_sport — prefer exact ip:port key.
        helper::lookup_orig_key(sess, &peer_ip, peer_port)
            .or_else(|_| helper::lookup_orig(sess, peer_port))?
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

        let (kind, up_host, up_port, up_user, up_pass, ssh_pool) = match trace.profile_id.as_deref()
        {
            Some(pid) if g.profile_upstreams.contains_key(pid) => {
                let up = &g.profile_upstreams[pid];
                (
                    up.kind,
                    up.host.clone(),
                    up.port,
                    up.user.clone(),
                    up.pass.clone(),
                    up.ssh_pool.clone(),
                )
            }
            _ => (
                g.config.upstream.kind,
                g.upstream_host.clone(),
                g.upstream_port,
                g.upstream_user.clone(),
                g.upstream_pass.clone(),
                g.ssh_pool.clone(),
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
        )
    };

    let (hostname, trace, kind, up_host, up_port, up_user, up_pass, stats, ssh_pool, domains) =
        snap;

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
                // xray-core–backed kinds are dialed via a per-profile local SOCKS
                // port opened by the XrayManager. P1 wires that port into
                // `ResolvedUpstream`; until then the relay cannot serve them.
                other if other.requires_core() => {
                    return Err(format!(
                        "upstream kind {} is core-backed; relay integration lands in P1",
                        other.as_tag()
                    ));
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
    bridge_any(a, b).await
}

async fn bridge_any<A, B>(a: &mut A, b: &mut B) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    tokio::io::copy_bidirectional(a, b)
        .await
        .map_err(|e| format!("bridge: {e}"))
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
    }

    #[tokio::test]
    async fn relay_flow_permit_is_released_when_flow_finishes() {
        let limiter = Arc::new(Semaphore::new(1));
        let stop = AtomicBool::new(false);

        let permit = acquire_relay_flow_permit(&limiter, &stop)
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
            acquire_relay_flow_permit(&limiter, &stop),
        )
        .await
        .expect("stop should be observed promptly");

        assert!(result.is_none());
    }
}
