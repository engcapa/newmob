//! Resolve which local process is LISTENing on a given TCP port, so SocksCap can
//! bypass an external local proxy (e.g. Clash/v2rayN) used as a loopback upstream
//! and avoid the proxy's own egress being re-captured into a loop.
//!
//! Only used for native HTTP/SOCKS5 upstreams whose host is loopback — the relay
//! dials that port directly, so the process answering there is the exit hop that
//! must not be recaptured. Core (xray) upstreams are handled separately by
//! bypassing the xray sidecar PID, and never route through here.

/// True when `host` refers to the local machine (loopback / localhost).
///
/// Only loopback upstreams can create a same-host capture loop; a remote proxy
/// egresses from its own machine and is covered by endpoint bypass instead.
pub fn is_loopback(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match h.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

/// PIDs of processes with a LISTEN socket on `port` (IPv4 + IPv6). Empty when
/// nothing listens there or on non-Windows platforms (loopback-upstream bypass
/// is a Windows/WinDivert concern; other platforms use their own capture model).
#[cfg(windows)]
pub fn resolve_listener_pids(port: u16) -> Vec<u32> {
    let mut out = win::listener_pids(port, false);
    for pid in win::listener_pids(port, true) {
        if !out.contains(&pid) {
            out.push(pid);
        }
    }
    out
}

#[cfg(not(windows))]
pub fn resolve_listener_pids(_port: u16) -> Vec<u32> {
    Vec::new()
}

/// One process LISTENing on a loopback (or wildcard) TCP port.
///
/// Used by the local-proxy detector to discover the *actual* ports a running
/// circumvention client (Clash/sing-box/Mihomo/…) is listening on — including
/// non-default ones the user changed — instead of only probing a fixed port
/// table. `pid` lets the caller join process identity (name → client family).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackListener {
    pub port: u16,
    pub pid: u32,
}

/// All processes LISTENing on a loopback or wildcard (`0.0.0.0` / `::`) TCP
/// address, across IPv4 + IPv6, with their owning pid.
///
/// Wildcard binds are included because a client bound to `0.0.0.0:7890` still
/// answers on `127.0.0.1:7890`, which is where the relay dials. Non-loopback,
/// non-wildcard binds (a public-IP-only listener) are excluded — they can't be
/// reached as a loopback upstream and probing them on 127.0.0.1 would fail
/// anyway. The final SOCKS/HTTP handshake probe is the real gate; this list
/// only narrows *which* ports are worth probing.
///
/// Empty on platforms without an implementation.
pub fn list_loopback_listeners() -> Vec<LoopbackListener> {
    #[cfg(windows)]
    {
        win::loopback_listeners()
    }
    #[cfg(target_os = "linux")]
    {
        linux::loopback_listeners()
    }
    #[cfg(target_os = "macos")]
    {
        macos::loopback_listeners()
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// Push `(port, pid)` into `out` unless an identical entry is already present.
/// A client commonly listens on the same port over both IPv4 and IPv6, and the
/// same (port,pid) pair is redundant for the detector.
fn push_unique(out: &mut Vec<LoopbackListener>, port: u16, pid: u32) {
    if port == 0 || pid == 0 {
        return;
    }
    let entry = LoopbackListener { port, pid };
    if !out.contains(&entry) {
        out.push(entry);
    }
}

/// Self-contained FFI to iphlpapi's GetExtendedTcpTable. Declared locally (with
/// the exact documented struct layouts) rather than via winapi features so this
/// stays independent of which winapi modules happen to be enabled. IPv4 and IPv6
/// use distinct row layouts, so each family is read with its own struct.
#[cfg(windows)]
mod win {
    use std::os::raw::c_int;

    type DWORD = u32;

    // TCP_TABLE_CLASS::TCP_TABLE_OWNER_PID_LISTENER
    const TCP_TABLE_OWNER_PID_LISTENER: c_int = 3;
    // MIB_TCP_STATE_LISTEN
    const MIB_TCP_STATE_LISTEN: DWORD = 2;
    const AF_INET: DWORD = 2;
    const AF_INET6: DWORD = 23;
    const NO_ERROR: DWORD = 0;
    const ERROR_INSUFFICIENT_BUFFER: DWORD = 122;

    // IPv4 row: state, localAddr, localPort, remoteAddr, remotePort, owningPid.
    #[repr(C)]
    struct MibTcpRowOwnerPid {
        dw_state: DWORD,
        dw_local_addr: DWORD,
        dw_local_port: DWORD,
        dw_remote_addr: DWORD,
        dw_remote_port: DWORD,
        dw_owning_pid: DWORD,
    }
    #[repr(C)]
    struct MibTcpTableOwnerPid {
        dw_num_entries: DWORD,
        table: [MibTcpRowOwnerPid; 1], // flexible array
    }

    // IPv6 row: 16-byte addr + scope id per endpoint, then state + owningPid.
    #[repr(C)]
    struct MibTcp6RowOwnerPid {
        uc_local_addr: [u8; 16],
        dw_local_scope_id: DWORD,
        dw_local_port: DWORD,
        uc_remote_addr: [u8; 16],
        dw_remote_scope_id: DWORD,
        dw_remote_port: DWORD,
        dw_state: DWORD,
        dw_owning_pid: DWORD,
    }
    #[repr(C)]
    struct MibTcp6TableOwnerPid {
        dw_num_entries: DWORD,
        table: [MibTcp6RowOwnerPid; 1],
    }

    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(
            p_tcp_table: *mut core::ffi::c_void,
            pdw_size: *mut DWORD,
            b_order: c_int,
            ul_af: DWORD,
            table_class: c_int,
            reserved: DWORD,
        ) -> DWORD;
    }

    /// Query the OWNER_PID_LISTENER table for one address family into a byte buf.
    fn fetch_table(family: DWORD) -> Option<Vec<u8>> {
        let mut size: DWORD = 0;
        // Size probe.
        let rc = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if size == 0 || (rc != NO_ERROR && rc != ERROR_INSUFFICIENT_BUFFER) {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let rc = unsafe {
            GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut _,
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        (rc == NO_ERROR).then_some(buf)
    }

    /// PIDs listening on `want_port` for the given family (false=v4, true=v6).
    pub fn listener_pids(want_port: u16, ipv6: bool) -> Vec<u32> {
        let family = if ipv6 { AF_INET6 } else { AF_INET };
        let Some(buf) = fetch_table(family) else {
            return Vec::new();
        };
        let mut pids = Vec::new();
        unsafe {
            if ipv6 {
                let table = &*(buf.as_ptr() as *const MibTcp6TableOwnerPid);
                let rows = table.table.as_ptr();
                for i in 0..table.dw_num_entries as usize {
                    let row = &*rows.add(i);
                    if row.dw_state == MIB_TCP_STATE_LISTEN
                        && port_from_dword(row.dw_local_port) == want_port
                        && row.dw_owning_pid != 0
                        && !pids.contains(&row.dw_owning_pid)
                    {
                        pids.push(row.dw_owning_pid);
                    }
                }
            } else {
                let table = &*(buf.as_ptr() as *const MibTcpTableOwnerPid);
                let rows = table.table.as_ptr();
                for i in 0..table.dw_num_entries as usize {
                    let row = &*rows.add(i);
                    if row.dw_state == MIB_TCP_STATE_LISTEN
                        && port_from_dword(row.dw_local_port) == want_port
                        && row.dw_owning_pid != 0
                        && !pids.contains(&row.dw_owning_pid)
                    {
                        pids.push(row.dw_owning_pid);
                    }
                }
            }
        }
        pids
    }

    /// `dwLocalPort` holds the port in network byte order in its low two bytes.
    /// e.g. bytes [0x1E, 0xE2] -> 7890.
    fn port_from_dword(dw: DWORD) -> u16 {
        u16::from_be_bytes([(dw & 0xff) as u8, ((dw >> 8) & 0xff) as u8])
    }

    /// IPv4 `dwLocalAddr` (network byte order) that is loopback (127/8) or the
    /// unspecified wildcard (0.0.0.0). Low byte of the little-endian DWORD is the
    /// first octet.
    fn v4_addr_is_local(dw: DWORD) -> bool {
        let first = (dw & 0xff) as u8;
        first == 127 || dw == 0
    }

    /// IPv6 16-byte address that is loopback (`::1`) or unspecified (`::`).
    fn v6_addr_is_local(addr: &[u8; 16]) -> bool {
        let all_zero = addr.iter().all(|&b| b == 0);
        let loopback = addr[..15].iter().all(|&b| b == 0) && addr[15] == 1;
        all_zero || loopback
    }

    /// Every LISTEN socket on a loopback/wildcard address (v4 + v6) with its pid.
    pub fn loopback_listeners() -> Vec<super::LoopbackListener> {
        let mut out = Vec::new();
        // IPv4
        if let Some(buf) = fetch_table(AF_INET) {
            unsafe {
                let table = &*(buf.as_ptr() as *const MibTcpTableOwnerPid);
                let rows = table.table.as_ptr();
                for i in 0..table.dw_num_entries as usize {
                    let row = &*rows.add(i);
                    if row.dw_state == MIB_TCP_STATE_LISTEN && v4_addr_is_local(row.dw_local_addr) {
                        super::push_unique(
                            &mut out,
                            port_from_dword(row.dw_local_port),
                            row.dw_owning_pid,
                        );
                    }
                }
            }
        }
        // IPv6
        if let Some(buf) = fetch_table(AF_INET6) {
            unsafe {
                let table = &*(buf.as_ptr() as *const MibTcp6TableOwnerPid);
                let rows = table.table.as_ptr();
                for i in 0..table.dw_num_entries as usize {
                    let row = &*rows.add(i);
                    if row.dw_state == MIB_TCP_STATE_LISTEN && v6_addr_is_local(&row.uc_local_addr) {
                        super::push_unique(
                            &mut out,
                            port_from_dword(row.dw_local_port),
                            row.dw_owning_pid,
                        );
                    }
                }
            }
        }
        out
    }
}

/// Parse `/proc/net/tcp` or `/proc/net/tcp6` content into `(port, inode)` pairs
/// for sockets in the LISTEN state (`st == 0x0A`).
///
/// Pure (takes the file text) so it is unit-testable on any platform. Address
/// filtering is intentionally *not* done here — the pid→known-client join and
/// the loopback probe downstream are the real gates, and the hex address column
/// differs subtly between v4 and v6. Line format (whitespace-separated):
/// `sl local_address rem_address st ... uid timeout inode ...` where
/// `local_address` is `HEXIP:HEXPORT` and `inode` is field index 9.
fn parse_proc_net_tcp(content: &str) -> Vec<(u16, u64)> {
    let mut out = Vec::new();
    for line in content.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 {
            continue;
        }
        // state
        if !f[3].eq_ignore_ascii_case("0A") {
            continue;
        }
        // local_address = HEXIP:HEXPORT
        let Some((_, hport)) = f[1].rsplit_once(':') else {
            continue;
        };
        let Ok(port) = u16::from_str_radix(hport, 16) else {
            continue;
        };
        let Ok(inode) = f[9].parse::<u64>() else {
            continue;
        };
        if port != 0 {
            out.push((port, inode));
        }
    }
    out
}

/// Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpn` field output into `(port, pid)`.
///
/// Pure (takes the command's stdout) so it is unit-testable on any platform.
/// `-F` emits one field per line, tagged by a leading letter: `p<pid>` opens a
/// process set, then each of its files emits `n<name>` (e.g. `127.0.0.1:7890`
/// or `*:7890`). We attribute every subsequent `n` line to the most recent `p`.
fn parse_lsof_fields(content: &str) -> Vec<(u16, u32)> {
    let mut out = Vec::new();
    let mut cur_pid: u32 = 0;
    for line in content.lines() {
        let mut chars = line.chars();
        let Some(tag) = chars.next() else {
            continue;
        };
        let val = chars.as_str();
        match tag {
            'p' => cur_pid = val.trim().parse().unwrap_or(0),
            'n' => {
                if cur_pid == 0 {
                    continue;
                }
                // name is host:port (host may be *, 127.0.0.1, [::1], etc.)
                if let Some((_, port_s)) = val.rsplit_once(':') {
                    if let Ok(port) = port_s.trim().parse::<u16>() {
                        if port != 0 && !out.contains(&(port, cur_pid)) {
                            out.push((port, cur_pid));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{parse_proc_net_tcp, push_unique, LoopbackListener};
    use std::collections::HashMap;

    /// LISTEN sockets on loopback/wildcard with their owning pid, resolved by
    /// joining `/proc/net/tcp{,6}` (port↔inode) against `/proc/*/fd` (inode↔pid).
    pub fn loopback_listeners() -> Vec<LoopbackListener> {
        let mut pairs = Vec::new();
        for p in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(txt) = std::fs::read_to_string(p) {
                pairs.extend(parse_proc_net_tcp(&txt));
            }
        }
        if pairs.is_empty() {
            return Vec::new();
        }
        let wanted: std::collections::HashSet<u64> = pairs.iter().map(|(_, ino)| *ino).collect();
        let inode_to_pid = map_socket_inodes_to_pids(&wanted);
        let mut out = Vec::new();
        for (port, inode) in pairs {
            if let Some(&pid) = inode_to_pid.get(&inode) {
                push_unique(&mut out, port, pid);
            }
        }
        out
    }

    /// Scan `/proc/<pid>/fd/*` symlinks for `socket:[<inode>]` targets, building
    /// inode→pid for the inodes in `wanted`. Stops early once all are found.
    fn map_socket_inodes_to_pids(wanted: &std::collections::HashSet<u64>) -> HashMap<u64, u32> {
        let mut map = HashMap::new();
        let Ok(proc) = std::fs::read_dir("/proc") else {
            return map;
        };
        for ent in proc.flatten() {
            let fname = ent.file_name();
            let name = fname.to_string_lossy();
            let Ok(pid) = name.parse::<u32>() else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(ent.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                if let Ok(target) = std::fs::read_link(fd.path()) {
                    let t = target.to_string_lossy();
                    if let Some(rest) = t.strip_prefix("socket:[") {
                        if let Some(num) = rest.strip_suffix(']') {
                            if let Ok(inode) = num.parse::<u64>() {
                                if wanted.contains(&inode) {
                                    map.entry(inode).or_insert(pid);
                                }
                            }
                        }
                    }
                }
            }
            if map.len() == wanted.len() {
                break;
            }
        }
        map
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{parse_lsof_fields, push_unique, LoopbackListener};

    /// LISTEN sockets with owning pid via `lsof`. macOS has no `/proc`; `lsof` is
    /// part of the base system. We restrict to TCP LISTEN and field output.
    pub fn loopback_listeners() -> Vec<LoopbackListener> {
        let output = std::process::Command::new("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut out = Vec::new();
        for (port, pid) in parse_lsof_fields(&stdout) {
            push_unique(&mut out, port, pid);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_classification() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.5.6.7"));
        assert!(is_loopback("::1"));
        assert!(is_loopback("[::1]"));
        assert!(is_loopback("localhost"));
        assert!(is_loopback("LocalHost"));
        assert!(!is_loopback("10.0.0.1"));
        assert!(!is_loopback("example.com"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback(""));
    }

    #[cfg(windows)]
    #[test]
    fn finds_our_own_listener_pid() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let pids = resolve_listener_pids(port);
        assert!(
            pids.contains(&std::process::id()),
            "expected own pid {} among listeners on {port}: {pids:?}",
            std::process::id()
        );
    }

    #[cfg(windows)]
    #[test]
    fn unlistened_port_has_no_pids() {
        // A port we bind then drop should have no listener afterwards.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        // Best-effort: usually free immediately after drop.
        let pids = resolve_listener_pids(port);
        assert!(!pids.contains(&std::process::id()));
    }

    #[cfg(windows)]
    #[test]
    fn loopback_listeners_includes_our_own() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let found = list_loopback_listeners();
        assert!(
            found
                .iter()
                .any(|l| l.port == port && l.pid == std::process::id()),
            "expected own listener on {port} among {found:?}"
        );
    }

    #[test]
    fn parse_proc_net_tcp_extracts_listen_ports() {
        // Header + one LISTEN (st=0A) on 127.0.0.1:7890 (0x1ED2) inode 45678,
        // one ESTABLISHED (st=01) that must be ignored, one LISTEN on *:1080
        // (0x0438) inode 45679.
        let sample = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1ED2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000 100
   1: 0100007F:1ED2 0100007F:C123 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000 100
   2: 00000000:0438 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45679 1 0000 100
";
        let got = parse_proc_net_tcp(sample);
        assert_eq!(got, vec![(0x1ED2, 45678u64), (0x0438, 45679u64)]);
    }

    #[test]
    fn parse_proc_net_tcp_ignores_malformed() {
        assert!(parse_proc_net_tcp("").is_empty());
        assert!(parse_proc_net_tcp("only a header line\n").is_empty());
        assert!(parse_proc_net_tcp("hdr\ntoo few fields here\n").is_empty());
    }

    #[test]
    fn parse_lsof_fields_attributes_ports_to_pid() {
        // Two processes: pid 111 listens on 127.0.0.1:7890 and *:7891;
        // pid 222 listens on [::1]:1080.
        let sample = "\
p111
n127.0.0.1:7890
n*:7891
p222
n[::1]:1080
";
        let got = parse_lsof_fields(sample);
        assert_eq!(got, vec![(7890, 111u32), (7891, 111u32), (1080, 222u32)]);
    }

    #[test]
    fn parse_lsof_fields_skips_files_before_first_pid() {
        // An `n` line with no preceding `p` must be dropped, not crash.
        let got = parse_lsof_fields("n127.0.0.1:9\np5\nn127.0.0.1:1080\n");
        assert_eq!(got, vec![(1080, 5u32)]);
    }
}
