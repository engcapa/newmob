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
    path_matches_selector, port_keys_for_pids, tcp_owner_pid, ProcessTree, SharedTree,
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

#[derive(Debug, Clone)]
struct FlowInfo {
    pid: u32,
    path: String,
    remote: IpAddr,
    remote_port: u16,
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

fn flow_key(ip: IpAddr, port: u16) -> String {
    format!("{ip}:{port}")
}

/// NETWORK-layer capture filter. Outbound TCP only: the streamdump reflection
/// reinjects packets as *inbound*, so an inbound clause would only re-feed our
/// own rewrites back into this loop.
const NETWORK_FILTER: &str = "tcp and outbound";

pub struct CaptureEngine {
    windivert_dir: Option<PathBuf>,
    api: Option<Arc<WinDivertApi>>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    flow_handle: Option<usize>,
    net_handle: Option<usize>,
    /// "local_ip:local_port" → flow info
    flows: Arc<Mutex<HashMap<String, FlowInfo>>>,
    /// "src_ip:src_port" after redirect → original destination
    redirects: Arc<Mutex<HashMap<String, RedirectMapping>>>,
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
            flows: Arc::new(Mutex::new(HashMap::new())),
            redirects: Arc::new(Mutex::new(HashMap::new())),
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

        // streamdump reflection delivers to client_lan:relay, not necessarily 127.0.0.1
        let relay_desc = format!("*:{}", plan.relay_port);
        let mode_apps = plan.mode_apps;

        self.flow_handle = flow_h.map(|h| h as usize);
        self.net_handle = Some(net_h as usize);
        self.active = true;

        if let Some(flow_h) = flow_h {
            let stop = Arc::clone(&self.stop);
            let flows = Arc::clone(&self.flows);
            let api_flow = Arc::clone(&api);
            let flow_handle = flow_h as usize;
            self.threads.push(std::thread::spawn(move || {
                flow_loop(api_flow, flow_handle as HANDLE, flows, stop);
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
        }))
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
        if let Ok(mut m) = self.flows.lock() {
            m.clear();
        }
        if let Ok(mut m) = self.redirects.lock() {
            m.clear();
        }
        self.active = false;
        self.plan = None;
    }

    pub fn lookup_orig(&self, src_port: u16) -> Option<serde_json::Value> {
        // Prefer exact key match ending with :port (first hit).
        let map = self.redirects.lock().ok()?;
        let suffix = format!(":{src_port}");
        let m = map
            .iter()
            .find(|(k, _)| k.ends_with(&suffix))
            .map(|(_, v)| v.clone())?;
        Some(json!({
            "dstIp": m.orig_dst.to_string(),
            "dstPort": m.orig_port,
            "pid": m.pid,
            "path": m.path,
        }))
    }

    pub fn lookup_orig_ip_port(&self, src_ip: &str, src_port: u16) -> Option<serde_json::Value> {
        let key = if src_ip.is_empty() {
            return self.lookup_orig(src_port);
        } else {
            format!("{src_ip}:{src_port}")
        };
        let map = self.redirects.lock().ok()?;
        let m = map.get(&key).cloned().or_else(|| {
            // Fallback: any entry with this port.
            let suffix = format!(":{src_port}");
            map.iter()
                .find(|(k, _)| k.ends_with(&suffix))
                .map(|(_, v)| v.clone())
        })?;
        Some(json!({
            "dstIp": m.orig_dst.to_string(),
            "dstPort": m.orig_port,
            "pid": m.pid,
            "path": m.path,
        }))
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

fn flow_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<HashMap<String, FlowInfo>>>,
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
                let key = flow_key(local, local_port);
                if is_delete {
                    if let Ok(mut m) = flows.lock() {
                        m.remove(&key);
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
                if let Ok(mut m) = flows.lock() {
                    m.insert(
                        key,
                        FlowInfo {
                            pid,
                            path,
                            remote,
                            remote_port,
                        },
                    );
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
    flows: Arc<Mutex<HashMap<String, FlowInfo>>>,
    redirects: Arc<Mutex<HashMap<String, RedirectMapping>>>,
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
    let mut app_port_keys: HashSet<String> = HashSet::new();
    let mut app_ports_refreshed = Instant::now() - Duration::from_secs(10);
    let mut matched_pids: HashSet<u32> = HashSet::new();
    let mut recv_errors: u32 = 0;

    let refresh_app_index = |tree: &SharedTree,
                             plan: &CapturePlan,
                             keys: &mut HashSet<String>,
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
        *keys = port_keys_for_pids(pids);
    };

    while !stop.load(Ordering::SeqCst) {
        // Keep App port index warm (every 100ms).
        if plan.mode_apps && app_ports_refreshed.elapsed() >= Duration::from_millis(100) {
            refresh_app_index(&tree, &plan, &mut app_port_keys, &mut matched_pids);
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

        let Some((src, sport, dst, dport, _is_v6)) = parse_ip_tcp(pkt) else {
            let _ = api.send(handle, pkt, &addr);
            continue;
        };

        // ------------------------------------------------------------------
        // Streamdump PROXY→PORT: outbound from local relay/proxy.
        // Packet is C:relay → R:client_sport; reflect to R:orig_port → C:client_sport.
        // ------------------------------------------------------------------
        let relay_port = relay_port_live.load(Ordering::Relaxed);
        if outbound && sport == relay_port {
            // Prefer reverse key R:client_sport; also try by client port alone.
            let rev_key = flow_key(dst, dport);
            let mapping = redirects.lock().ok().and_then(|m| {
                m.get(&rev_key)
                    .cloned()
                    .or_else(|| {
                        let suffix = format!(":{dport}");
                        m.iter()
                            .find(|(k, v)| {
                                k.ends_with(&suffix) && v.orig_sport == dport
                            })
                            .map(|(_, v)| v.clone())
                    })
            });
            if let Some(mapping) = mapping {
                if reflect_from_proxy(pkt, mapping.orig_port) {
                    addr_for_reflect_inbound(&mut addr);
                    api.calc_checksums(pkt, &mut addr);
                    let _ = api.send(handle, pkt, &addr);
                } else {
                    let _ = api.send(handle, pkt, &addr);
                }
            } else {
                // No mapping (control / unknown) — pass through.
                let _ = api.send(handle, pkt, &addr);
            }
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
        let key = flow_key(src, sport);

        if let Some(_existing) = redirects.lock().ok().and_then(|m| m.get(&key).cloned()) {
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

        if should_bypass(&plan, &bypass_nets, &key, dst, dport, &flows) {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // Skip pure loopback destinations (local services).
        if is_loopback_ip(dst) {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // Skip packets already reflecting (src looks like remote, rare).
        let _ = (relay_v4, relay_v6);

        let (pid, path) = if plan.mode_apps {
            let port_hit = app_port_keys.contains(&key)
                || app_port_keys.contains(&format!("*:{sport}"));
            if !port_hit {
                refresh_app_index(&tree, &plan, &mut app_port_keys, &mut matched_pids);
                app_ports_refreshed = Instant::now();
                let port_hit = app_port_keys.contains(&key)
                    || app_port_keys.contains(&format!("*:{sport}"));
                if !port_hit {
                    let f = resolve_flow(&flows, &tree, &key, src, sport);
                    let Some(f) = f else {
                        let _ = api.send(handle, pkt, &addr);
                        continue;
                    };
                    if !matched_pids.contains(&f.pid)
                        && !process_in_scope(&plan, f.pid, &f.path, &tree)
                    {
                        let _ = api.send(handle, pkt, &addr);
                        continue;
                    }
                    (f.pid, f.path.clone())
                } else {
                    let pid = tcp_owner_pid(src, sport)
                        .or_else(|| matched_pids.iter().copied().next())
                        .unwrap_or(0);
                    let path = tree
                        .with(|t| t.path_of(pid).map(|s| s.to_string()))
                        .flatten()
                        .unwrap_or_default();
                    (pid, path)
                }
            } else {
                let pid = tcp_owner_pid(src, sport).unwrap_or(0);
                let path = tree
                    .with(|t| t.path_of(pid).map(|s| s.to_string()))
                    .flatten()
                    .unwrap_or_default();
                (pid, path)
            }
        } else {
            // Global: avoid long PID spins — only resolve when bypass_pids set.
            let f = resolve_flow(&flows, &tree, &key, src, sport);
            let (pid, path) = match f {
                Some(f) => (f.pid, f.path),
                None => (0, String::new()),
            };
            if (pid != 0 && plan.bypass_pids.contains(&pid)) || path_bypassed(&plan, &path) {
                let _ = api.send(handle, pkt, &addr);
                continue;
            }
            (pid, path)
        };

        let mapping = RedirectMapping {
            orig_src: src,
            orig_sport: sport,
            orig_dst: dst,
            orig_port: dport,
            pid,
            path,
        };
        // Client key (continuations) + reverse key (proxy peer = R:client_sport).
        if let Ok(mut m) = redirects.lock() {
            m.insert(key.clone(), mapping.clone());
            m.insert(flow_key(dst, sport), mapping);
        }

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
    flow_key: &str,
    dst: IpAddr,
    dport: u16,
    flows: &Arc<Mutex<HashMap<String, FlowInfo>>>,
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
    flows: &Arc<Mutex<HashMap<String, FlowInfo>>>,
    tree: &SharedTree,
    key: &str,
    src: IpAddr,
    sport: u16,
) -> Option<FlowInfo> {
    if let Some(f) = flows.lock().ok().and_then(|m| m.get(key).cloned()) {
        return Some(f);
    }
    // One brief yield for FLOW race; then TCP table (OWNER_PID_ALL includes SYN_SENT).
    if flows.lock().ok().and_then(|m| m.get(key).cloned()).is_none() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    if let Some(f) = flows.lock().ok().and_then(|m| m.get(key).cloned()) {
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
    let info = FlowInfo {
        pid,
        path,
        remote: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        remote_port: 0,
    };
    if let Ok(mut m) = flows.lock() {
        m.insert(key.to_string(), info.clone());
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

/// Returns (src, sport, dst, dport, is_v6)
fn parse_ip_tcp(pkt: &[u8]) -> Option<(IpAddr, u16, IpAddr, u16, bool)> {
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
        let src = IpAddr::V4(Ipv4Addr::new(pkt[12], pkt[13], pkt[14], pkt[15]));
        let dst = IpAddr::V4(Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19]));
        let sport = u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]);
        let dport = u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]);
        Some((src, sport, dst, dport, false))
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
        let src = IpAddr::V6(Ipv6Addr::from(s));
        let dst = IpAddr::V6(Ipv6Addr::from(d));
        let sport = u16::from_be_bytes([pkt[40], pkt[41]]);
        let dport = u16::from_be_bytes([pkt[42], pkt[43]]);
        Some((src, sport, dst, dport, true))
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
}

