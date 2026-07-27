//! FLOW (PID map) + NETWORK capture engine.
//!
//! TCP redirect uses the official WinDivert **streamdump reflection** pattern
//! (not NAT-to-127.0.0.1, which fails to deliver to loopback-only listeners):
//!
//! - Client C:sp → Remote R:dp  becomes  R:sp → C:relay  (inbound)
//! - Proxy reply C:relay → R:sp becomes  R:dp → C:sp     (inbound)
//!
//! Relay must listen on 0.0.0.0 (all interfaces), not only 127.0.0.1.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;
use winapi::um::winnt::HANDLE;

use crate::proc_info::{
    path_matches_selector, ports_for_pids, tcp_owner_pid, ProcessTree, SharedTree,
};
use crate::windivert::{
    addr_event, addr_for_reflect_inbound, addr_is_outbound, addr_layer, flow_endpoints_ip,
    flow_process_id, WinDivertApi, ADDR_LEN, LAYER_FLOW, LAYER_NETWORK, LAYER_SOCKET,
};

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub ip: IpAddr,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct CapturePlan {
    pub mode_apps: bool,
    pub app_paths: Vec<String>,
    pub bypass_cidrs: Vec<String>,
    pub bypass_pids: Vec<u32>,
    /// Executable paths to always exclude from capture (e.g. an external local
    /// proxy used as a loopback upstream). Matched per-flow, so it survives the
    /// proxy restarting with a new PID — unlike `bypass_pids`.
    pub bypass_paths: Vec<String>,
    pub bypass_endpoints: Vec<Endpoint>,
    pub relay_ip: Ipv4Addr,
    pub relay_port: u16,
}

/// Identifies a connection by its **client-side** `(ip, port)`.
///
/// A tuple, not a `"ip:port"` string: the old string keys cost one heap
/// allocation per packet to build and forced port-only lookups to be an O(n)
/// `ends_with(":port")` scan of the whole table while holding its lock.
type FlowKey = (IpAddr, u16);

#[derive(Debug, Clone)]
struct FlowInfo {
    pid: u32,
    path: String,
    remote: IpAddr,
    remote_port: u16,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct RedirectMapping {
    /// Client local address (original TCP source).
    orig_src: IpAddr,
    orig_sport: u16,
    /// Original remote destination.
    orig_dst: IpAddr,
    orig_port: u16,
    pid: u32,
    path: String,
}

/// What was decided for a connection the first time we saw it.
#[derive(Debug, Clone)]
enum FlowVerdict {
    /// Reflect toward the relay; carries what the relay needs to recover the
    /// original destination.
    Redirect(RedirectMapping),
    /// Pass through untouched (bypassed process/endpoint, out of scope, ...).
    Bypass,
}

/// Cheap answer for the packet hot path — no allocation, no clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlowAction {
    Redirect,
    Bypass,
}

#[derive(Debug, Clone)]
struct FlowEntry {
    /// Destination this verdict was reached for. A packet whose destination
    /// differs is, by definition, a different connection.
    dst: IpAddr,
    dport: u16,
    verdict: FlowVerdict,
    expires_at: Instant,
}

/// NETWORK-layer capture filter. Outbound TCP only: the streamdump reflection
/// reinjects packets as *inbound*, so an inbound clause would only re-feed our
/// own rewrites back into this loop.
const NETWORK_FILTER: &str = "tcp and outbound";

const TCP_FIN: u8 = 0x01;
const TCP_SYN: u8 = 0x02;
const TCP_RST: u8 = 0x04;
const TCP_ACK: u8 = 0x10;

/// SYN without ACK: a new connection is being opened on this 4-tuple.
fn is_syn_open(flags: u8) -> bool {
    flags & TCP_SYN != 0 && flags & TCP_ACK == 0
}

/// Idle lifetime of a decision. Only a backstop: FLOW delete events and
/// FIN/RST close entries far sooner. Long enough that a genuinely idle but
/// live connection (SSH, websocket) is not dropped before the peer speaks
/// again — losing the entry mid-connection would leave the relay's reply
/// packets untranslated.
const FLOW_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
/// Grace after FIN/RST so the remainder of the close handshake still
/// translates, while a closed connection still releases its slot promptly.
const FLOW_CLOSE_GRACE: Duration = Duration::from_secs(10);
/// Hard ceiling. Larger than the ~16k Windows ephemeral port range, so live
/// traffic cannot legitimately reach it; the soonest-to-expire go first.
const MAX_FLOW_ENTRIES: usize = 32_768;
/// Amortised sweep cadence for expired entries.
const FLOW_SWEEP_INTERVAL: Duration = Duration::from_secs(15);
/// Idle lifetime of a FLOW-layer PID association.
const PID_MAP_TTL: Duration = Duration::from_secs(10 * 60);

/// Per-connection decisions, keyed by the client's `(ip, port)`.
///
/// Capture *and* bypass verdicts live here together on purpose: they must share
/// one invalidation rule. The previous design cached only redirects and tested
/// mere key presence, so once Windows recycled an ephemeral port — there are
/// only ~16k, so on a busy host this is a matter of hours — the new connection
/// silently inherited the previous connection's destination. That is what made
/// long-running sessions degrade and eventually wedge. Validating the
/// destination on every lookup removes the whole class of bug, and it must hold
/// for the bypass cache too, or caching bypass decisions would simply reintroduce
/// it on the other side.
#[derive(Default)]
struct FlowTable {
    entries: HashMap<FlowKey, FlowEntry>,
    /// `(orig_dst, client_port)` → client key. Both the relay (as its accepted
    /// peer address) and the proxy→client packets see the reflected connection
    /// under this address.
    peer_index: HashMap<FlowKey, FlowKey>,
    /// `client_port` → client key, for `lookup_orig` without a source IP.
    /// Replaces the old O(n) suffix scan.
    sport_index: HashMap<u16, FlowKey>,
    last_sweep: Option<Instant>,
}

impl FlowTable {
    /// Decision for this packet's connection, or `None` when it must be
    /// classified afresh.
    ///
    /// A cached entry whose destination does not match the packet belongs to a
    /// previous connection that happened to use the same local port; it is
    /// dropped rather than reused.
    fn lookup(&mut self, key: FlowKey, dst: IpAddr, dport: u16, now: Instant) -> Option<FlowAction> {
        match self.entries.get(&key) {
            Some(e) if e.dst == dst && e.dport == dport => {}
            Some(_) => {
                self.remove(&key);
                return None;
            }
            None => return None,
        }
        let e = self.entries.get_mut(&key)?;
        e.expires_at = now + FLOW_IDLE_TTL;
        Some(match e.verdict {
            FlowVerdict::Redirect(_) => FlowAction::Redirect,
            FlowVerdict::Bypass => FlowAction::Bypass,
        })
    }

    fn insert(&mut self, key: FlowKey, dst: IpAddr, dport: u16, verdict: FlowVerdict, now: Instant) {
        self.remove(&key);
        if let FlowVerdict::Redirect(m) = &verdict {
            self.peer_index.insert((m.orig_dst, m.orig_sport), key);
            self.sport_index.insert(m.orig_sport, key);
        }
        self.entries.insert(
            key,
            FlowEntry {
                dst,
                dport,
                verdict,
                expires_at: now + FLOW_IDLE_TTL,
            },
        );
        if self.entries.len() > MAX_FLOW_ENTRIES {
            self.evict_overflow();
        }
    }

    fn remove(&mut self, key: &FlowKey) {
        let Some(e) = self.entries.remove(key) else {
            return;
        };
        if let FlowVerdict::Redirect(m) = &e.verdict {
            let peer = (m.orig_dst, m.orig_sport);
            if self.peer_index.get(&peer) == Some(key) {
                self.peer_index.remove(&peer);
            }
            if self.sport_index.get(&m.orig_sport) == Some(key) {
                self.sport_index.remove(&m.orig_sport);
            }
        }
    }

    /// Original destination port for a proxy→client packet, plus the client key
    /// so the caller can note a close. Refreshes the entry: the relay side of a
    /// busy connection keeps it alive just as the client side does.
    fn peer_lookup(&mut self, peer: FlowKey, now: Instant) -> Option<(FlowKey, u16)> {
        let key = *self.peer_index.get(&peer)?;
        let e = self.entries.get_mut(&key)?;
        let FlowVerdict::Redirect(m) = &e.verdict else {
            return None;
        };
        let port = m.orig_port;
        e.expires_at = now + FLOW_IDLE_TTL;
        Some((key, port))
    }

    /// Bring an entry's expiry forward after FIN/RST. Later traffic (half-close
    /// keeps one direction open) pushes it back out again via `lookup`.
    fn mark_closing(&mut self, key: &FlowKey, now: Instant) {
        if let Some(e) = self.entries.get_mut(key) {
            let deadline = now + FLOW_CLOSE_GRACE;
            if deadline < e.expires_at {
                e.expires_at = deadline;
            }
        }
    }

    fn mapping_by_peer(&self, peer: FlowKey) -> Option<RedirectMapping> {
        let key = self.peer_index.get(&peer)?;
        match &self.entries.get(key)?.verdict {
            FlowVerdict::Redirect(m) => Some(m.clone()),
            FlowVerdict::Bypass => None,
        }
    }

    fn mapping_by_sport(&self, sport: u16) -> Option<RedirectMapping> {
        let key = self.sport_index.get(&sport)?;
        match &self.entries.get(key)?.verdict {
            FlowVerdict::Redirect(m) => Some(m.clone()),
            FlowVerdict::Bypass => None,
        }
    }

    fn sweep_if_due(&mut self, now: Instant) {
        if let Some(last) = self.last_sweep {
            if now.duration_since(last) < FLOW_SWEEP_INTERVAL {
                return;
            }
        }
        self.last_sweep = Some(now);
        let expired: Vec<FlowKey> = self
            .entries
            .iter()
            .filter(|(_, e)| e.expires_at <= now)
            .map(|(k, _)| *k)
            .collect();
        for k in &expired {
            self.remove(k);
        }
    }

    /// Drop the soonest-to-expire eighth of the table. Reaching the cap means
    /// eviction signals are being missed, so free enough at once to avoid
    /// re-triggering on every subsequent insert.
    fn evict_overflow(&mut self) {
        let target = self.entries.len().saturating_sub(MAX_FLOW_ENTRIES * 7 / 8);
        let mut by_deadline: Vec<(Instant, FlowKey)> =
            self.entries.iter().map(|(k, e)| (e.expires_at, *k)).collect();
        by_deadline.sort_unstable_by_key(|(t, _)| *t);
        for (_, k) in by_deadline.into_iter().take(target) {
            self.remove(&k);
        }
        tracing::warn!(
            "sockscap-helper: flow table hit {MAX_FLOW_ENTRIES} entries; evicted {target} oldest"
        );
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// FLOW/SOCKET-layer PID associations, keyed by the socket's local `(ip, port)`.
///
/// Delete events remove entries, but they can be missed (queue overflow, FLOW
/// layer unavailable) and the `GetExtendedTcpTable` fallback inserts entries no
/// event will ever remove — so this expires idle entries as well.
#[derive(Default)]
struct FlowMap {
    map: HashMap<FlowKey, FlowInfo>,
    last_sweep: Option<Instant>,
}

impl FlowMap {
    fn get(&self, key: &FlowKey) -> Option<&FlowInfo> {
        self.map.get(key)
    }

    fn insert(&mut self, key: FlowKey, mut info: FlowInfo, now: Instant) {
        info.expires_at = now + PID_MAP_TTL;
        self.map.insert(key, info);
    }

    fn remove(&mut self, key: &FlowKey) {
        self.map.remove(key);
    }

    fn sweep_if_due(&mut self, now: Instant) {
        if let Some(last) = self.last_sweep {
            if now.duration_since(last) < FLOW_SWEEP_INTERVAL {
                return;
            }
        }
        self.last_sweep = Some(now);
        self.map.retain(|_, v| v.expires_at > now);
    }

    fn len(&self) -> usize {
        self.map.len()
    }
}

pub struct CaptureEngine {
    windivert_dir: Option<PathBuf>,
    api: Option<Arc<WinDivertApi>>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    flow_handle: Option<usize>,
    net_handle: Option<usize>,
    /// Socket local `(ip, port)` → owning process.
    flows: Arc<Mutex<FlowMap>>,
    /// Client `(ip, port)` → the capture/bypass decision for its connection.
    redirects: Arc<Mutex<FlowTable>>,
    plan: Option<CapturePlan>,
    packets_seen: Arc<AtomicU64>,
    packets_redirected: Arc<AtomicU64>,
    active: bool,
    /// Hot-swappable relay port shared with the running network thread.
    relay_port_live: Arc<AtomicU16>,
}

impl CaptureEngine {
    pub fn new(windivert_dir: Option<PathBuf>) -> Self {
        Self {
            windivert_dir,
            api: None,
            stop: Arc::new(AtomicBool::new(false)),
            threads: Vec::new(),
            flow_handle: None,
            net_handle: None,
            flows: Arc::new(Mutex::new(FlowMap::default())),
            redirects: Arc::new(Mutex::new(FlowTable::default())),
            plan: None,
            packets_seen: Arc::new(AtomicU64::new(0)),
            packets_redirected: Arc::new(AtomicU64::new(0)),
            active: false,
            relay_port_live: Arc::new(AtomicU16::new(0)),
        }
    }

    /// Hot-swap the relay port while capture is running.
    /// Returns an error if capture is not currently active.
    pub fn update_relay_port(&mut self, port: u16) -> Result<serde_json::Value, String> {
        if !self.active {
            return Err("capture not active".into());
        }
        self.relay_port_live.store(port, Ordering::SeqCst);
        if let Some(ref mut plan) = self.plan {
            plan.relay_port = port;
        }
        Ok(serde_json::json!({ "relayPort": port }))
    }

    pub fn status_json(&self) -> serde_json::Value {
        json!({
            "active": self.active,
            "packetsSeen": self.packets_seen.load(Ordering::Relaxed),
            "packetsRedirected": self.packets_redirected.load(Ordering::Relaxed),
            "flowEntries": self.flows.lock().map(|m| m.len()).unwrap_or(0),
            "redirectEntries": self.redirects.lock().map(|m| m.len()).unwrap_or(0),
            "relayPort": self.plan.as_ref().map(|p| p.relay_port),
            "ipv6": true,
        })
    }

    pub fn probe(&mut self, filter: &str) -> Result<serde_json::Value, String> {
        let api = self.ensure_api()?;
        let h = api.open(filter, LAYER_NETWORK, 0, 0)?;
        api.close_handle(h);
        Ok(json!({
            "message": "WinDivert open/close probe succeeded",
            "elevated": true,
            "filter": filter,
            "dll": api.dll_path.display().to_string(),
        }))
    }

    pub fn start(&mut self, plan: CapturePlan) -> Result<serde_json::Value, String> {
        self.stop();
        let api = self.ensure_api()?;
        self.stop = Arc::new(AtomicBool::new(false));
        self.relay_port_live = Arc::new(AtomicU16::new(plan.relay_port));
        self.plan = Some(plan.clone());
        self.packets_seen.store(0, Ordering::Relaxed);
        self.packets_redirected.store(0, Ordering::Relaxed);

        // FLOW/SOCKET layers: never use packet aliases like "tcp" (ERROR 87).
        // WinDivert 1.x has no FLOW/SOCKET — open will fail; we fall back to
        // GetExtendedTcpTable owner-PID matching for App mode.
        let mut flow_note = String::new();
        let flow_h = match api.open("true", LAYER_FLOW, 0, 0) {
            Ok(h) => Some(h),
            Err(e_flow) => match api.open("true", LAYER_SOCKET, 0, 0) {
                Ok(h) => {
                    flow_note = format!(
                        "FLOW unavailable ({e_flow}); using SOCKET layer for process events"
                    );
                    Some(h)
                }
                Err(e_sock) => {
                    flow_note = format!(
                        "FLOW/SOCKET unavailable (flow={e_flow}; socket={e_sock}); TCP-table PID only"
                    );
                    tracing::warn!("sockscap-helper: {flow_note}");
                    None
                }
            },
        };

        // NETWORK: outbound TCP only (streamdump). Reflected packets are
        // reinjected as inbound and are not recaptured by the same handle
        // (Impostor left clear, matching the official sample).
        //
        // There is deliberately **no** fallback to a bare `"tcp"` filter. The
        // `outbound` field is core WinDivert filter syntax (and `load()` has
        // already rejected 1.x), so a parse failure here means the driver is not
        // a supported build. Falling back would hand every *inbound* packet on
        // the machine to this single-threaded loop as well, only for it to be
        // passed straight through — doubling the load that already throttles
        // system-wide throughput, while hiding the real problem.
        let filter_used = NETWORK_FILTER.to_string();
        let net_h = api.open(NETWORK_FILTER, LAYER_NETWORK, 0, 0).map_err(|e| {
            format!(
                "WinDivert NETWORK open failed for filter {NETWORK_FILTER:?}: {e}. \
                 Ensure WinDivert.dll/sys match (2.2+ x64) and the helper is elevated."
            )
        })?;

        // Deepen the kernel queues before any traffic arrives. The NETWORK queue
        // holds real packets so it gets the byte-size bump too; FLOW events are
        // zero-length, so only its length matters.
        let net_queue = api.tune_queue(net_h, true);
        if let Some(h) = flow_h {
            let _ = api.tune_queue(h, false);
        }
        tracing::info!(
            "sockscap-helper: NETWORK queue length={} size={} time={}ms",
            net_queue.length,
            net_queue.size,
            net_queue.time_ms
        );

        // streamdump reflection delivers to client_lan:relay, not necessarily 127.0.0.1
        let relay_desc = format!("*:{}", plan.relay_port);
        let mode_apps = plan.mode_apps;

        self.flow_handle = flow_h.map(|h| h as usize);
        self.net_handle = Some(net_h as usize);
        self.active = true;

        if let Some(flow_h) = flow_h {
            let stop = Arc::clone(&self.stop);
            let flows = Arc::clone(&self.flows);
            let redirects = Arc::clone(&self.redirects);
            let api_flow = Arc::clone(&api);
            let flow_handle = flow_h as usize;
            self.threads.push(std::thread::spawn(move || {
                flow_loop(api_flow, flow_handle as HANDLE, flows, redirects, stop);
            }));
        }

        let stop = Arc::clone(&self.stop);
        let flows = Arc::clone(&self.flows);
        let redirects = Arc::clone(&self.redirects);
        let api_net = Arc::clone(&api);
        let net_handle = net_h as usize;
        let seen = Arc::clone(&self.packets_seen);
        let redirected = Arc::clone(&self.packets_redirected);
        let relay_port_live = Arc::clone(&self.relay_port_live);
        let tree = Arc::new(SharedTree::new());
        self.threads.push(std::thread::spawn(move || {
            network_loop(
                api_net,
                net_handle as HANDLE,
                flows,
                redirects,
                plan,
                relay_port_live,
                seen,
                redirected,
                stop,
                tree,
            );
        }));

        Ok(json!({
            "started": true,
            "filter": filter_used,
            "relay": relay_desc,
            "modeApps": mode_apps,
            "ipv6": true,
            "flowNote": flow_note,
            "flowLayer": self.flow_handle.is_some(),
            "dll": api.dll_path.display().to_string(),
            "queue": {
                "length": net_queue.length,
                "size": net_queue.size,
                "timeMs": net_queue.time_ms,
            },
        }))
    }

    /// Drop every cached decision. Used when the plan changes, so a stale
    /// verdict cannot outlive the configuration that produced it.
    fn clear_tables(&self) {
        if let Ok(mut m) = self.flows.lock() {
            *m = FlowMap::default();
        }
        if let Ok(mut m) = self.redirects.lock() {
            *m = FlowTable::default();
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(api) = &self.api {
            if let Some(h) = self.flow_handle.take() {
                api.close_handle(h as HANDLE);
            }
            if let Some(h) = self.net_handle.take() {
                api.close_handle(h as HANDLE);
            }
        }
        // Join divert threads with a short timeout so capture_stop RPC cannot
        // block the control plane indefinitely if WinDivertRecv never unblocks.
        for t in self.threads.drain(..) {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = t.join();
                let _ = tx.send(());
            });
            if rx
                .recv_timeout(std::time::Duration::from_millis(750))
                .is_err()
            {
                tracing::warn!("sockscap-helper: capture thread join timed out; detaching");
            }
        }
        self.clear_tables();
        self.active = false;
        self.plan = None;
    }

    pub fn lookup_orig(&self, src_port: u16) -> Option<serde_json::Value> {
        let map = self.redirects.lock().ok()?;
        Some(mapping_json(&map.mapping_by_sport(src_port)?))
    }

    pub fn lookup_orig_ip_port(&self, src_ip: &str, src_port: u16) -> Option<serde_json::Value> {
        if src_ip.is_empty() {
            return self.lookup_orig(src_port);
        }
        let Ok(ip) = src_ip.parse::<IpAddr>() else {
            return self.lookup_orig(src_port);
        };
        let map = self.redirects.lock().ok()?;
        // The relay's peer address is `orig_remote:client_port`, which is
        // exactly the peer index key.
        let m = map
            .mapping_by_peer((ip, src_port))
            .or_else(|| map.mapping_by_sport(src_port))?;
        Some(mapping_json(&m))
    }

    fn ensure_api(&mut self) -> Result<Arc<WinDivertApi>, String> {
        if let Some(api) = &self.api {
            return Ok(Arc::clone(api));
        }
        let api = Arc::new(WinDivertApi::load(self.windivert_dir.as_deref())?);
        self.api = Some(Arc::clone(&api));
        Ok(api)
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn mapping_json(m: &RedirectMapping) -> serde_json::Value {
    json!({
        "dstIp": m.orig_dst.to_string(),
        "dstPort": m.orig_port,
        "pid": m.pid,
        "path": m.path,
    })
}

fn flow_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<FlowMap>>,
    redirects: Arc<Mutex<FlowTable>>,
    stop: Arc<AtomicBool>,
) {
    let mut packet = vec![0u8; 1];
    let mut addr = vec![0u8; ADDR_LEN];
    while !stop.load(Ordering::SeqCst) {
        match api.recv(handle, &mut packet, &mut addr) {
            Ok(_) => {
                let layer = addr_layer(&addr);
                // Accept FLOW (2) or SOCKET (3) events.
                if layer != LAYER_FLOW as u8 && layer != LAYER_SOCKET as u8 {
                    continue;
                }
                let event = addr_event(&addr);
                // FLOW: 0=established, 1=deleted
                // SOCKET: 0=bind, 1=connect, 2=listen, 3=accept, 4=close...
                let is_delete = event == 1 && layer == LAYER_FLOW as u8
                    || event == 4 && layer == LAYER_SOCKET as u8;
                let pid = flow_process_id(&addr);
                let Some((local, local_port, remote, remote_port, proto)) =
                    flow_endpoints_ip(&addr)
                else {
                    continue;
                };
                // SOCKET layer may report proto 0; still track by ports.
                if proto != 0 && proto != 6 {
                    continue;
                }
                let key = (local, local_port);
                if is_delete {
                    if let Ok(mut m) = flows.lock() {
                        m.remove(&key);
                    }
                    // The socket is gone, so its capture decision is too. This
                    // is the authoritative eviction signal — far more precise
                    // than any timeout, and it is what keeps a recycled
                    // ephemeral port from inheriting a stale destination.
                    if let Ok(mut t) = redirects.lock() {
                        t.remove(&key);
                    }
                    continue;
                }
                // SOCKET connect = 1; FLOW established = 0; also accept SOCKET bind/connect/accept
                if layer == LAYER_SOCKET as u8 && event > 3 {
                    continue;
                }
                if layer == LAYER_FLOW as u8 && !addr_is_outbound(&addr) {
                    continue;
                }
                let path = process_path(pid).unwrap_or_default();
                let now = Instant::now();
                if let Ok(mut m) = flows.lock() {
                    m.insert(
                        key,
                        FlowInfo {
                            pid,
                            path,
                            remote,
                            remote_port,
                            expires_at: now,
                        },
                        now,
                    );
                    m.sweep_if_due(now);
                }
            }
            Err(_) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
}

fn network_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<FlowMap>>,
    redirects: Arc<Mutex<FlowTable>>,
    plan: CapturePlan,
    relay_port_live: Arc<AtomicU16>,
    seen: Arc<AtomicU64>,
    redirected: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    tree: Arc<SharedTree>,
) {
    let mut packet = vec![0u8; 0xFFFF];
    let mut addr = vec![0u8; ADDR_LEN];
    let bypass_nets = parse_cidrs(&plan.bypass_cidrs);
    let relay_v4 = IpAddr::V4(plan.relay_ip);
    let relay_v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);

    // App mode: inverted index — ports owned by matching PIDs (works without FLOW).
    let mut app_ports: HashSet<u16> = HashSet::new();
    let mut app_ports_refreshed = Instant::now() - Duration::from_secs(10);
    let mut matched_pids: HashSet<u32> = HashSet::new();
    let mut recv_errors: u32 = 0;

    let refresh_app_index = |tree: &SharedTree,
                             plan: &CapturePlan,
                             keys: &mut HashSet<u16>,
                             pids: &mut HashSet<u32>| {
        tree.with(|t| {
            t.refresh();
            pids.clear();
            // Collect PIDs whose path (or ancestor) matches app list.
            for (&pid, path) in t.path.iter() {
                if plan.bypass_pids.contains(&pid) {
                    continue;
                }
                if process_in_scope_tree(plan, pid, path, t) {
                    pids.insert(pid);
                }
            }
            // Also include children of matched pids (path may differ).
            let parents = t.parent.clone();
            for _ in 0..8 {
                let mut changed = false;
                for (&pid, &pp) in &parents {
                    if pids.contains(&pp)
                        && !pids.contains(&pid)
                        && !plan.bypass_pids.contains(&pid)
                    {
                        pids.insert(pid);
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
        });
        *keys = ports_for_pids(pids);
    };

    while !stop.load(Ordering::SeqCst) {
        // Keep App port index warm (every 100ms).
        if plan.mode_apps && app_ports_refreshed.elapsed() >= Duration::from_millis(100) {
            refresh_app_index(&tree, &plan, &mut app_ports, &mut matched_pids);
            app_ports_refreshed = Instant::now();
        }

        let len = match api.recv(handle, &mut packet, &mut addr) {
            Ok(n) => {
                recv_errors = 0;
                n
            }
            Err(e) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // Back off. `continue` alone spins this thread at 100% CPU for
                // as long as the failure lasts — and a failure that lasts is
                // exactly the likely case (handle closed underneath us, driver
                // unloaded, device removed). The FLOW loop already sleeps here;
                // only the NETWORK loop was missing it.
                recv_errors = recv_errors.saturating_add(1);
                if recv_errors >= 3 {
                    std::thread::sleep(Duration::from_millis(5));
                }
                if recv_errors == 1 || recv_errors == 100 || recv_errors % 2000 == 0 {
                    tracing::warn!(
                        "sockscap-helper: NETWORK recv failed ({recv_errors} consecutive): {e}"
                    );
                }
                continue;
            }
        };
        seen.fetch_add(1, Ordering::Relaxed);
        let pkt = &mut packet[..len];
        let outbound = addr_is_outbound(&addr);

        let Some(tcp) = parse_ip_tcp(pkt) else {
            let _ = api.send(handle, pkt, &addr);
            continue;
        };
        let TcpMeta {
            src,
            sport,
            dst,
            dport,
            flags,
        } = tcp;
        let now = Instant::now();
        let closing = flags & (TCP_FIN | TCP_RST) != 0;

        // ------------------------------------------------------------------
        // Streamdump PROXY→PORT: outbound from local relay/proxy.
        // Packet is C:relay → R:client_sport; reflect to R:orig_port → C:client_sport.
        // ------------------------------------------------------------------
        let relay_port = relay_port_live.load(Ordering::Relaxed);
        if outbound && sport == relay_port {
            let found = redirects.lock().ok().and_then(|mut t| {
                let hit = t.peer_lookup((dst, dport), now);
                if let (Some((key, _)), true) = (hit, closing) {
                    t.mark_closing(&key, now);
                }
                hit.map(|(_, port)| port)
            });
            if let Some(orig_port) = found {
                if reflect_from_proxy(pkt, orig_port) {
                    addr_for_reflect_inbound(&mut addr);
                    api.calc_checksums(pkt, &mut addr);
                }
            }
            // No mapping (control / unknown) — pass through unchanged.
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // Never re-process traffic already destined to the relay port.
        if dport == relay_port {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        if !outbound {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // ------------------------------------------------------------------
        // Outbound client → remote: streamdump PORT→PROXY reflection.
        // ------------------------------------------------------------------
        let key: FlowKey = (src, sport);

        // Cached decision for this connection. `lookup` only answers when the
        // destination still matches, so a recycled ephemeral port never
        // inherits the previous connection's verdict. A SYN-without-ACK is
        // stronger still: it *defines* the start of a new connection on this
        // 4-tuple, so any earlier decision is void even when the destination
        // happens to coincide. (Re-classifying a SYN retransmit is wasted work,
        // but only on a path that is already retransmitting.)
        let cached = if is_syn_open(flags) {
            if let Ok(mut t) = redirects.lock() {
                t.remove(&key);
            }
            None
        } else {
            redirects.lock().ok().and_then(|mut t| {
                let hit = t.lookup(key, dst, dport, now);
                if hit.is_some() && closing {
                    t.mark_closing(&key, now);
                }
                hit
            })
        };
        match cached {
            Some(FlowAction::Redirect) => {
                if reflect_towards_proxy(pkt, relay_port) {
                    addr_for_reflect_inbound(&mut addr);
                    api.calc_checksums(pkt, &mut addr);
                    if api.send(handle, pkt, &addr).is_ok() {
                        redirected.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    let _ = api.send(handle, pkt, &addr);
                }
                continue;
            }
            // Negative cache: the expensive classification below already ran
            // for this connection and said "leave it alone". Without this,
            // every packet of every un-captured flow re-enumerated the process
            // table and the whole TCP table — which is why traffic that
            // SocksCap does *not* handle was the slowest of all.
            Some(FlowAction::Bypass) => {
                let _ = api.send(handle, pkt, &addr);
                continue;
            }
            None => {}
        }

        // ---- first packet of a connection: classify, then remember ---------
        // The port index may simply be stale — a process that started, or
        // opened this socket, since the last refresh. Refreshing is expensive,
        // but it now happens at most once per *connection* instead of once per
        // packet of every un-captured flow.
        if plan.mode_apps && !app_ports.contains(&sport) {
            refresh_app_index(&tree, &plan, &mut app_ports, &mut matched_pids);
            app_ports_refreshed = Instant::now();
        }

        let verdict = classify_flow(
            &plan,
            &bypass_nets,
            &flows,
            &tree,
            key,
            dst,
            dport,
            &app_ports,
            &matched_pids,
        );

        if let Ok(mut t) = redirects.lock() {
            t.sweep_if_due(now);
            t.insert(key, dst, dport, verdict.clone(), now);
            if closing {
                t.mark_closing(&key, now);
            }
        }

        if matches!(verdict, FlowVerdict::Bypass) {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // Skip packets already reflecting (src looks like remote, rare).
        let _ = (relay_v4, relay_v6);

        if reflect_towards_proxy(pkt, relay_port) {
            addr_for_reflect_inbound(&mut addr);
            api.calc_checksums(pkt, &mut addr);
            if api.send(handle, pkt, &addr).is_ok() {
                redirected.fetch_add(1, Ordering::Relaxed);
            }
        } else {
            let _ = api.send(handle, pkt, &addr);
        }
    }
}

/// Decide, once per connection, whether to capture it.
///
/// Everything expensive lives here — process-tree walks, TCP-table owner
/// lookups, scope matching. Both outcomes are cached by the caller, so this
/// runs on the first packet of a connection and not again.
#[allow(clippy::too_many_arguments)]
fn classify_flow(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    flows: &Arc<Mutex<FlowMap>>,
    tree: &SharedTree,
    key: FlowKey,
    dst: IpAddr,
    dport: u16,
    app_ports: &HashSet<u16>,
    matched_pids: &HashSet<u32>,
) -> FlowVerdict {
    let (src, sport) = key;

    if should_bypass(plan, bypass_nets, &key, dst, dport, flows) {
        return FlowVerdict::Bypass;
    }
    // Local services are never proxied.
    if is_loopback_ip(dst) {
        return FlowVerdict::Bypass;
    }

    let (pid, path) = if plan.mode_apps {
        if app_ports.contains(&sport) {
            let pid = tcp_owner_pid(src, sport)
                .or_else(|| matched_pids.iter().copied().next())
                .unwrap_or(0);
            let path = tree
                .with(|t| t.path_of(pid).map(|s| s.to_string()))
                .flatten()
                .unwrap_or_default();
            (pid, path)
        } else {
            let Some(f) = resolve_flow(flows, tree, key) else {
                return FlowVerdict::Bypass;
            };
            if !matched_pids.contains(&f.pid) && !process_in_scope(plan, f.pid, &f.path, tree) {
                return FlowVerdict::Bypass;
            }
            (f.pid, f.path.clone())
        }
    } else {
        // Global: everything is in scope unless explicitly excluded.
        let (pid, path) = match resolve_flow(flows, tree, key) {
            Some(f) => (f.pid, f.path),
            None => (0, String::new()),
        };
        if (pid != 0 && plan.bypass_pids.contains(&pid)) || path_bypassed(plan, &path) {
            return FlowVerdict::Bypass;
        }
        (pid, path)
    };

    FlowVerdict::Redirect(RedirectMapping {
        orig_src: src,
        orig_sport: sport,
        orig_dst: dst,
        orig_port: dport,
        pid,
        path,
    })
}

fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback(),
    }
}

/// Streamdump PORT→PROXY:
/// `C:sp → R:dp`  ⇒  `R:sp → C:relay` (caller sets Outbound=false).
fn reflect_towards_proxy(pkt: &mut [u8], relay_port: u16) -> bool {
    let ver = pkt.first().map(|b| b >> 4).unwrap_or(0);
    if ver == 4 {
        if pkt.len() < 40 {
            return false;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 20 || pkt[9] != 6 {
            return false;
        }
        let mut src = [0u8; 4];
        let mut dst = [0u8; 4];
        src.copy_from_slice(&pkt[12..16]);
        dst.copy_from_slice(&pkt[16..20]);
        pkt[12..16].copy_from_slice(&dst); // src = old dst (remote)
        pkt[16..20].copy_from_slice(&src); // dst = old src (client)
        let pb = relay_port.to_be_bytes();
        pkt[ihl + 2] = pb[0];
        pkt[ihl + 3] = pb[1];
        // sport unchanged (client ephemeral)
        pkt[10] = 0;
        pkt[11] = 0;
        pkt[ihl + 16] = 0;
        pkt[ihl + 17] = 0;
        true
    } else if ver == 6 {
        if pkt.len() < 60 || pkt[6] != 6 {
            return false;
        }
        let mut src = [0u8; 16];
        let mut dst = [0u8; 16];
        src.copy_from_slice(&pkt[8..24]);
        dst.copy_from_slice(&pkt[24..40]);
        pkt[8..24].copy_from_slice(&dst);
        pkt[24..40].copy_from_slice(&src);
        let pb = relay_port.to_be_bytes();
        pkt[42] = pb[0];
        pkt[43] = pb[1];
        pkt[40 + 16] = 0;
        pkt[40 + 17] = 0;
        true
    } else {
        false
    }
}

/// Streamdump PROXY→PORT:
/// `C:relay → R:sp`  ⇒  `R:orig_port → C:sp`.
fn reflect_from_proxy(pkt: &mut [u8], orig_port: u16) -> bool {
    let ver = pkt.first().map(|b| b >> 4).unwrap_or(0);
    if ver == 4 {
        if pkt.len() < 40 {
            return false;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 20 || pkt[9] != 6 {
            return false;
        }
        let mut src = [0u8; 4];
        let mut dst = [0u8; 4];
        src.copy_from_slice(&pkt[12..16]);
        dst.copy_from_slice(&pkt[16..20]);
        pkt[12..16].copy_from_slice(&dst); // src = old dst (remote)
        pkt[16..20].copy_from_slice(&src); // dst = old src (client)
        let pb = orig_port.to_be_bytes();
        pkt[ihl] = pb[0];
        pkt[ihl + 1] = pb[1];
        // dport stays client ephemeral
        pkt[10] = 0;
        pkt[11] = 0;
        pkt[ihl + 16] = 0;
        pkt[ihl + 17] = 0;
        true
    } else if ver == 6 {
        if pkt.len() < 60 || pkt[6] != 6 {
            return false;
        }
        let mut src = [0u8; 16];
        let mut dst = [0u8; 16];
        src.copy_from_slice(&pkt[8..24]);
        dst.copy_from_slice(&pkt[24..40]);
        pkt[8..24].copy_from_slice(&dst);
        pkt[24..40].copy_from_slice(&src);
        let pb = orig_port.to_be_bytes();
        pkt[40] = pb[0];
        pkt[41] = pb[1];
        pkt[40 + 16] = 0;
        pkt[40 + 17] = 0;
        true
    } else {
        false
    }
}

fn should_bypass(
    plan: &CapturePlan,
    bypass_nets: &[(IpAddr, u8)],
    flow_key: &FlowKey,
    dst: IpAddr,
    dport: u16,
    flows: &Arc<Mutex<FlowMap>>,
) -> bool {
    if let Ok(m) = flows.lock() {
        if let Some(f) = m.get(flow_key) {
            if plan.bypass_pids.contains(&f.pid) || path_bypassed(plan, &f.path) {
                return true;
            }
        }
    }
    for e in &plan.bypass_endpoints {
        if e.ip == dst && (e.port == 0 || e.port == dport) {
            return true;
        }
    }
    for (net, prefix) in bypass_nets {
        if ip_in_cidr(dst, *net, *prefix) {
            return true;
        }
    }
    false
}

/// FLOW table miss → GetExtendedTcpTable owner PID + process tree path.
///
/// When FLOW/SOCKET is unavailable, keep the wait short: long spins on every
/// SYN stall the divert thread and cause app timeouts.
fn resolve_flow(
    flows: &Arc<Mutex<FlowMap>>,
    tree: &SharedTree,
    key: FlowKey,
) -> Option<FlowInfo> {
    let (src, sport) = key;
    if let Some(f) = flows.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Some(f);
    }
    // One brief yield for FLOW race; then TCP table (OWNER_PID_ALL includes SYN_SENT).
    if flows.lock().ok().and_then(|m| m.get(&key).cloned()).is_none() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    if let Some(f) = flows.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Some(f);
    }
    let pid = tcp_owner_pid(src, sport).or_else(|| {
        std::thread::sleep(std::time::Duration::from_millis(2));
        tcp_owner_pid(src, sport)
    })?;
    let path = tree
        .with(|t| {
            t.path_of(pid)
                .map(|s| s.to_string())
                .or_else(|| process_path(pid))
        })
        .flatten()
        .unwrap_or_else(|| process_path(pid).unwrap_or_default());
    let now = Instant::now();
    let info = FlowInfo {
        pid,
        path,
        remote: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        remote_port: 0,
        expires_at: now,
    };
    if let Ok(mut m) = flows.lock() {
        m.insert(key, info.clone(), now);
    }
    Some(info)
}

fn process_in_scope(plan: &CapturePlan, pid: u32, path: &str, tree: &SharedTree) -> bool {
    tree.with(|t| process_in_scope_tree(plan, pid, path, t))
        .unwrap_or(false)
}

/// True when a flow's process should be bypassed by executable path. Restart-
/// proof (matches the current path, not a snapshot PID). Empty path never matches.
fn path_bypassed(plan: &CapturePlan, path: &str) -> bool {
    if path.is_empty() || plan.bypass_paths.is_empty() {
        return false;
    }
    plan.bypass_paths
        .iter()
        .any(|sel| path_matches_selector(path, sel))
}

fn process_in_scope_tree(plan: &CapturePlan, pid: u32, path: &str, tree: &ProcessTree) -> bool {
    if plan.bypass_pids.contains(&pid) {
        return false;
    }
    if path_bypassed(plan, path) {
        return false;
    }
    if !plan.mode_apps {
        return true;
    }
    let mut candidates: Vec<String> = Vec::new();
    if !path.is_empty() {
        candidates.push(path.to_string());
    }
    candidates.extend(tree.ancestor_paths(pid));
    if candidates.is_empty() {
        return false;
    }
    plan.app_paths
        .iter()
        .any(|sel| candidates.iter().any(|p| path_matches_selector(p, sel)))
}

fn process_path(pid: u32) -> Option<String> {
    use std::os::windows::ffi::OsStringExt;
    use winapi::shared::minwindef::{DWORD, FALSE, MAX_PATH};
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; MAX_PATH as usize * 4];
        let mut size = buf.len() as DWORD;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn QueryFullProcessImageNameW(
                h: HANDLE,
                flags: DWORD,
                buf: *mut u16,
                size: *mut DWORD,
            ) -> i32;
        }
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        let os = std::ffi::OsString::from_wide(&buf[..size as usize]);
        Some(os.to_string_lossy().to_string())
    }
}

fn parse_cidrs(list: &[String]) -> Vec<(IpAddr, u8)> {
    let mut out = Vec::new();
    for s in list {
        let s = s.trim();
        if let Some((a, p)) = s.split_once('/') {
            if let (Ok(ip), Ok(pref)) = (a.parse::<IpAddr>(), p.parse::<u8>()) {
                let max = match ip {
                    IpAddr::V4(_) => 32,
                    IpAddr::V6(_) => 128,
                };
                out.push((ip, pref.min(max)));
            }
        } else if let Ok(ip) = s.parse::<IpAddr>() {
            let pref = match ip {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            out.push((ip, pref));
        }
    }
    out
}

fn ip_in_cidr(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let shift = 32u32.saturating_sub(prefix as u32);
            let mask = if shift >= 32 { 0 } else { u32::MAX << shift };
            (u32::from(a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let shift = 128u32.saturating_sub(prefix as u32);
            let mask = if shift >= 128 {
                0u128
            } else {
                u128::MAX << shift
            };
            (u128::from(a) & mask) == (u128::from(n) & mask)
        }
        _ => false,
    }
}

/// Addresses, ports and TCP flags of an IPv4/IPv6 TCP packet.
#[derive(Debug, Clone, Copy)]
struct TcpMeta {
    src: IpAddr,
    sport: u16,
    dst: IpAddr,
    dport: u16,
    /// TCP control bits; FIN/SYN/RST drive flow-table lifetime.
    flags: u8,
}

fn parse_ip_tcp(pkt: &[u8]) -> Option<TcpMeta> {
    if pkt.is_empty() {
        return None;
    }
    let ver = pkt[0] >> 4;
    if ver == 4 {
        if pkt.len() < 40 {
            return None;
        }
        let ihl = (pkt[0] & 0x0f) as usize * 4;
        if ihl < 20 || pkt.len() < ihl + 20 || pkt[9] != 6 {
            return None;
        }
        Some(TcpMeta {
            src: IpAddr::V4(Ipv4Addr::new(pkt[12], pkt[13], pkt[14], pkt[15])),
            sport: u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]),
            dst: IpAddr::V4(Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19])),
            dport: u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]),
            flags: pkt[ihl + 13],
        })
    } else if ver == 6 {
        // Fixed header only (no extension headers).
        if pkt.len() < 40 + 20 {
            return None;
        }
        if pkt[6] != 6 {
            return None; // next header must be TCP
        }
        let mut s = [0u8; 16];
        let mut d = [0u8; 16];
        s.copy_from_slice(&pkt[8..24]);
        d.copy_from_slice(&pkt[24..40]);
        Some(TcpMeta {
            src: IpAddr::V6(Ipv6Addr::from(s)),
            sport: u16::from_be_bytes([pkt[40], pkt[41]]),
            dst: IpAddr::V6(Ipv6Addr::from(d)),
            dport: u16::from_be_bytes([pkt[42], pkt[43]]),
            flags: pkt[40 + 13],
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_with_bypass_paths(paths: Vec<&str>) -> CapturePlan {
        CapturePlan {
            mode_apps: false,
            app_paths: vec![],
            bypass_cidrs: vec![],
            bypass_pids: vec![],
            bypass_paths: paths.into_iter().map(|s| s.to_string()).collect(),
            bypass_endpoints: vec![],
            relay_ip: Ipv4Addr::LOCALHOST,
            relay_port: 0,
        }
    }

    #[test]
    fn path_bypassed_matches_by_suffix_and_ignores_empty() {
        // Selector normalization is lowercase; store as the helper receives it.
        let plan = plan_with_bypass_paths(vec![r"clash.exe"]);
        assert!(path_bypassed(&plan, r"C:\Program Files\Clash\Clash.exe"));
        assert!(!path_bypassed(&plan, r"C:\Windows\System32\curl.exe"));
        // Empty flow path never matches (don't bypass unknown-path flows).
        assert!(!path_bypassed(&plan, ""));
    }

    #[test]
    fn path_bypassed_empty_list_never_matches() {
        let plan = plan_with_bypass_paths(vec![]);
        assert!(!path_bypassed(&plan, r"C:\anything.exe"));
    }

    fn client(port: u16) -> FlowKey {
        (IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)), port)
    }

    fn remote(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(93, 184, 216, last))
    }

    fn redirect_to(key: FlowKey, dst: IpAddr, dport: u16) -> FlowVerdict {
        FlowVerdict::Redirect(RedirectMapping {
            orig_src: key.0,
            orig_sport: key.1,
            orig_dst: dst,
            orig_port: dport,
            pid: 4242,
            path: r"c:\app.exe".into(),
        })
    }

    #[test]
    fn recycled_port_to_a_new_destination_is_not_reused() {
        // The long-uptime failure: Windows hands out only ~16k ephemeral ports,
        // so a busy host reuses one within hours. Matching on the key alone made
        // the new connection inherit the old destination.
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_000);
        t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);

        assert_eq!(t.lookup(key, remote(1), 443, now), Some(FlowAction::Redirect));
        // Same local port, different peer → previous verdict must not apply.
        assert_eq!(t.lookup(key, remote(2), 443, now), None);
        assert_eq!(t.len(), 0, "stale entry should be dropped, not kept");
    }

    #[test]
    fn recycled_port_to_a_new_port_on_the_same_host_is_not_reused() {
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_001);
        t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
        assert_eq!(t.lookup(key, remote(1), 8443, now), None);
    }

    #[test]
    fn bypass_verdicts_expire_by_the_same_rule_as_redirects() {
        // Caching "leave this flow alone" is what stops the packet path from
        // re-enumerating processes per packet — but it has to be invalidated
        // exactly like a redirect, or it just moves the staleness bug.
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_002);
        t.insert(key, remote(1), 80, FlowVerdict::Bypass, now);

        assert_eq!(t.lookup(key, remote(1), 80, now), Some(FlowAction::Bypass));
        assert_eq!(t.lookup(key, remote(3), 80, now), None);
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn peer_lookup_recovers_the_original_destination_port() {
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_003);
        t.insert(key, remote(1), 8443, redirect_to(key, remote(1), 8443), now);

        // Proxy→client packets arrive as `relay → orig_remote:client_port`.
        assert_eq!(t.peer_lookup((remote(1), 52_003), now), Some((key, 8443)));
        assert_eq!(t.peer_lookup((remote(9), 52_003), now), None);
    }

    #[test]
    fn removal_clears_every_index() {
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_004);
        t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
        t.remove(&key);

        assert_eq!(t.len(), 0);
        assert!(t.peer_index.is_empty(), "peer index leaked");
        assert!(t.sport_index.is_empty(), "sport index leaked");
        assert!(t.mapping_by_sport(52_004).is_none());
    }

    #[test]
    fn reinserting_a_key_does_not_leak_the_previous_peer_index() {
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_005);
        t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
        t.insert(key, remote(2), 443, redirect_to(key, remote(2), 443), now);

        assert_eq!(t.peer_index.len(), 1);
        assert_eq!(t.peer_lookup((remote(2), 52_005), now), Some((key, 443)));
        assert_eq!(t.peer_lookup((remote(1), 52_005), now), None);
    }

    #[test]
    fn close_grace_then_sweep_reclaims_the_entry() {
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_006);
        t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);

        // FIN/RST brings expiry forward without breaking the rest of the
        // close handshake.
        t.mark_closing(&key, now);
        assert_eq!(t.lookup(key, remote(1), 443, now), Some(FlowAction::Redirect));

        // `lookup` refreshed the entry, so close again and sweep past the grace.
        t.mark_closing(&key, now);
        t.sweep_if_due(now + FLOW_CLOSE_GRACE + Duration::from_secs(1));
        assert_eq!(t.len(), 0);
        assert!(t.sport_index.is_empty());
    }

    #[test]
    fn sweeping_is_rate_limited_so_the_packet_path_pays_it_rarely() {
        let mut t = FlowTable::default();
        let now = Instant::now();
        let key = client(52_007);
        t.insert(key, remote(1), 443, redirect_to(key, remote(1), 443), now);
        t.mark_closing(&key, now); // expires at now + FLOW_CLOSE_GRACE

        t.sweep_if_due(now); // primes last_sweep

        // Expired, but within the sweep interval — deliberately left alone so
        // the packet loop does not walk the table on every packet.
        let too_soon = now + FLOW_CLOSE_GRACE + Duration::from_secs(1);
        assert!(too_soon < now + FLOW_SWEEP_INTERVAL);
        t.sweep_if_due(too_soon);
        assert_eq!(t.len(), 1);

        t.sweep_if_due(now + FLOW_SWEEP_INTERVAL + Duration::from_secs(1));
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn table_stays_bounded_when_eviction_signals_are_missed() {
        // No FLOW delete events, no FIN/RST: memory must still not run away.
        let mut t = FlowTable::default();
        let now = Instant::now();
        for i in 0..(MAX_FLOW_ENTRIES + 2_000) {
            let key = (
                IpAddr::V4(Ipv4Addr::new(10, (i >> 16) as u8, (i >> 8) as u8, i as u8)),
                1024 + (i % 60_000) as u16,
            );
            t.insert(
                key,
                remote(1),
                443,
                redirect_to(key, remote(1), 443),
                now + Duration::from_millis(i as u64),
            );
        }
        assert!(t.len() <= MAX_FLOW_ENTRIES);
        assert!(t.peer_index.len() <= MAX_FLOW_ENTRIES);
        assert!(t.sport_index.len() <= MAX_FLOW_ENTRIES);
    }

    #[test]
    fn syn_without_ack_marks_a_new_connection() {
        assert!(is_syn_open(TCP_SYN));
        // SYN-ACK is the peer answering an existing handshake.
        assert!(!is_syn_open(TCP_SYN | TCP_ACK));
        assert!(!is_syn_open(TCP_ACK));
        assert!(!is_syn_open(TCP_FIN | TCP_ACK));
    }

    #[test]
    fn parses_tcp_flags_from_ipv4() {
        let mut pkt = vec![0u8; 60];
        pkt[0] = 0x45; // IPv4, ihl=5
        pkt[9] = 6; // TCP
        pkt[12..16].copy_from_slice(&[192, 168, 1, 10]);
        pkt[16..20].copy_from_slice(&[93, 184, 216, 34]);
        pkt[20..22].copy_from_slice(&50_000u16.to_be_bytes());
        pkt[22..24].copy_from_slice(&443u16.to_be_bytes());
        pkt[20 + 13] = TCP_SYN;

        let meta = parse_ip_tcp(&pkt).expect("valid IPv4 TCP packet");
        assert_eq!(meta.sport, 50_000);
        assert_eq!(meta.dport, 443);
        assert_eq!(meta.dst, remote(34));
        assert!(is_syn_open(meta.flags));
    }

    #[test]
    fn pid_map_expires_entries_the_tcp_table_fallback_inserted() {
        // FLOW delete events remove what FLOW inserted, but nothing ever
        // removed the GetExtendedTcpTable fallback's entries.
        let mut m = FlowMap::default();
        let now = Instant::now();
        let key = client(52_008);
        m.insert(
            key,
            FlowInfo {
                pid: 7,
                path: "x".into(),
                remote: remote(1),
                remote_port: 443,
                expires_at: now,
            },
            now,
        );
        assert!(m.get(&key).is_some());

        m.sweep_if_due(now + PID_MAP_TTL + Duration::from_secs(1));
        assert_eq!(m.len(), 0);
    }
}

