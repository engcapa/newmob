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
}
