//! Process tree + TCP owner-PID lookups for App-mode matching and FLOW races.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use winapi::shared::minwindef::{DWORD, FALSE, MAX_PATH};
use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
use winapi::um::processthreadsapi::OpenProcess;
use winapi::um::tlhelp32::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use winapi::um::winnt::{HANDLE, PROCESS_QUERY_LIMITED_INFORMATION};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn QueryFullProcessImageNameW(h: HANDLE, flags: DWORD, buf: *mut u16, size: *mut DWORD)
        -> i32;
}

#[link(name = "iphlpapi")]
unsafe extern "system" {
    fn GetExtendedTcpTable(
        pTcpTable: *mut u8,
        pdwSize: *mut DWORD,
        bOrder: i32,
        ulAf: u32,
        tableClass: u32,
        reserved: u32,
    ) -> u32;
}

const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;
// TCP_TABLE_CLASS (iphlpapi.h)
// 4 = OWNER_PID_CONNECTIONS, 5 = OWNER_PID_ALL (includes SYN_SENT etc.)
const TCP_TABLE_OWNER_PID_ALL: u32 = 5;
const NO_ERROR: u32 = 0;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

/// Snapshot of pid → (parent_pid, path) refreshed on a short interval.
pub struct ProcessTree {
    pub parent: HashMap<u32, u32>,
    pub path: HashMap<u32, String>,
    refreshed_at: Instant,
}

impl ProcessTree {
    pub fn new() -> Self {
        let mut t = Self {
            parent: HashMap::new(),
            path: HashMap::new(),
            refreshed_at: Instant::now() - Duration::from_secs(60),
        };
        t.refresh();
        t
    }

    pub fn refresh_if_stale(&mut self, max_age: Duration) {
        if self.refreshed_at.elapsed() >= max_age {
            self.refresh();
        }
    }

    pub fn refresh(&mut self) {
        self.parent.clear();
        self.path.clear();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return;
            }
            let mut pe: PROCESSENTRY32W = std::mem::zeroed();
            pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
            let mut ok = Process32FirstW(snap, &mut pe);
            while ok != FALSE {
                let pid = pe.th32ProcessID;
                let ppid = pe.th32ParentProcessID;
                if pid != 0 {
                    self.parent.insert(pid, ppid);
                    if let Some(p) = query_path(pid) {
                        self.path.insert(pid, p);
                    }
                }
                ok = Process32NextW(snap, &mut pe);
            }
            CloseHandle(snap);
        }
        self.refreshed_at = Instant::now();
    }

    pub fn path_of(&self, pid: u32) -> Option<&str> {
        self.path.get(&pid).map(|s| s.as_str())
    }

    /// Walk parent chain (bounded) collecting paths.
    pub fn ancestor_paths(&self, pid: u32) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = pid;
        for _ in 0..16 {
            if let Some(p) = self.path.get(&cur) {
                out.push(p.clone());
            }
            let Some(&pp) = self.parent.get(&cur) else {
                break;
            };
            if pp == 0 || pp == cur {
                break;
            }
            cur = pp;
        }
        out
    }
}

pub struct SharedTree {
    inner: Mutex<ProcessTree>,
}

impl SharedTree {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ProcessTree::new()),
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut ProcessTree) -> R) -> Option<R> {
        self.inner.lock().ok().map(|mut g| {
            g.refresh_if_stale(Duration::from_secs(2));
            f(&mut g)
        })
    }
}

unsafe fn query_path(pid: u32) -> Option<String> {
    use std::os::windows::ffi::OsStringExt;
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if h.is_null() {
        return None;
    }
    let mut buf = vec![0u16; MAX_PATH as usize * 4];
    let mut size = buf.len() as DWORD;
    let q = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
    CloseHandle(h);
    if q == 0 || size == 0 {
        return None;
    }
    let os = std::ffi::OsString::from_wide(&buf[..size as usize]);
    Some(os.to_string_lossy().to_string())
}

/// One TCP endpoint ownership row.
#[derive(Debug, Clone)]
pub struct TcpOwnerRow {
    pub local: IpAddr,
    pub local_port: u16,
    pub pid: u32,
}

fn read_tcp_table(af: u32) -> Option<Vec<u8>> {
    unsafe {
        let mut size: DWORD = 0;
        let r = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            1,
            af,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if r != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let r = GetExtendedTcpTable(
            buf.as_mut_ptr(),
            &mut size,
            1,
            af,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if r != NO_ERROR || buf.len() < 4 {
            return None;
        }
        Some(buf)
    }
}

/// Enumerate all IPv4/IPv6 TCP endpoints with owning PID (includes SYN_SENT).
pub fn list_tcp_owner_rows() -> Vec<TcpOwnerRow> {
    let mut out = Vec::new();
    if let Some(buf) = read_tcp_table(AF_INET) {
        let n = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let row_size = 24usize;
        for i in 0..n {
            let off = 4 + i * row_size;
            if off + row_size > buf.len() {
                break;
            }
            // IP octets stored in network order consecutively.
            let ip = Ipv4Addr::new(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
            let port = u16::from_be_bytes([buf[off + 8], buf[off + 9]]);
            let pid = u32::from_le_bytes([
                buf[off + 20],
                buf[off + 21],
                buf[off + 22],
                buf[off + 23],
            ]);
            if pid != 0 && port != 0 {
                out.push(TcpOwnerRow {
                    local: IpAddr::V4(ip),
                    local_port: port,
                    pid,
                });
            }
        }
    }
    if let Some(buf) = read_tcp_table(AF_INET6) {
        let n = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        // localAddr[16] + scopeId + localPort + remote[16] + rscope + rport + state + pid
        let row_size = 56usize;
        for i in 0..n {
            let off = 4 + i * row_size;
            if off + row_size > buf.len() {
                break;
            }
            let mut a = [0u8; 16];
            a.copy_from_slice(&buf[off..off + 16]);
            let ip = Ipv6Addr::from(a);
            let port = u16::from_be_bytes([buf[off + 20], buf[off + 21]]);
            let pid = u32::from_le_bytes([
                buf[off + 52],
                buf[off + 53],
                buf[off + 54],
                buf[off + 55],
            ]);
            if pid != 0 && port != 0 {
                out.push(TcpOwnerRow {
                    local: IpAddr::V6(ip),
                    local_port: port,
                    pid,
                });
            }
        }
    }
    out
}

pub fn tcp_owner_pid(local: IpAddr, local_port: u16) -> Option<u32> {
    for row in list_tcp_owner_rows() {
        if row.local_port != local_port || row.pid == 0 {
            continue;
        }
        // Match exact IP, or unspecified/any, or IPv4-mapped quirks: compare port-first.
        if row.local == local
            || row.local.is_unspecified()
            || matches!((row.local, local), (IpAddr::V4(a), IpAddr::V4(b)) if a.is_unspecified() || a == b)
        {
            return Some(row.pid);
        }
    }
    // Port-only fallback (local ports are unique on a host for a given family).
    list_tcp_owner_rows()
        .into_iter()
        .find(|r| r.local_port == local_port && r.pid != 0)
        .map(|r| r.pid)
}

/// Local TCP ports owned by any of `pids`.
///
/// Ports, not `"ip:port"` strings: a local port is unique per host, so the IP
/// added nothing that the port-only entry did not already cover — while the
/// two `format!`s per row made every refresh allocate twice per open socket on
/// the machine, and forced the packet path to allocate again to look one up.
pub fn ports_for_pids(pids: &std::collections::HashSet<u32>) -> std::collections::HashSet<u16> {
    let mut ports = std::collections::HashSet::new();
    if pids.is_empty() {
        return ports;
    }
    for row in list_tcp_owner_rows() {
        if pids.contains(&row.pid) {
            ports.insert(row.local_port);
        }
    }
    ports
}

pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\").to_ascii_lowercase();
    while s.ends_with('\\') {
        s.pop();
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }
    s
}

pub fn path_matches_selector(process_path: &str, selector: &str) -> bool {
    let p = normalize_path(process_path);
    let s = normalize_path(selector);
    if p.is_empty() || s.is_empty() {
        return false;
    }
    p == s || p.ends_with(&s)
}
