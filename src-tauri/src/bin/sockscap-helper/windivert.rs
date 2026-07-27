//! Dynamic WinDivert FFI (load DLL at runtime — LGPLv3/GPLv2 isolation).
//!
//! Requires **WinDivert 2.x** (Recv/Send parameter order and ADDRESS layout).
//! WinDivert 1.x is detected and rejected with a clear error (FLOW layers
//! return ERROR_INVALID_PARAMETER on 1.x).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

use winapi::shared::minwindef::{FARPROC, HMODULE};
use winapi::um::libloaderapi::{FreeLibrary, GetProcAddress, LoadLibraryW};
use winapi::um::winnt::HANDLE;

pub const LAYER_NETWORK: i32 = 0;
pub const LAYER_FLOW: i32 = 2;
pub const LAYER_SOCKET: i32 = 3;

pub const WINDIVERT_HELPER_NO_IP_CHECKSUM: u64 = 1;
pub const WINDIVERT_HELPER_NO_TCP_CHECKSUM: u64 = 2;

/// `WINDIVERT_PARAM` (windivert.h).
pub const PARAM_QUEUE_LENGTH: i32 = 0;
pub const PARAM_QUEUE_TIME: i32 = 1;
pub const PARAM_QUEUE_SIZE: i32 = 2;

type OpenFn = unsafe extern "C" fn(*const i8, i32, i16, u64) -> HANDLE;
// WinDivert 2.x: Recv(handle, packet, packetLen, *recvLen, *addr)
type RecvFn = unsafe extern "C" fn(HANDLE, *mut u8, u32, *mut u32, *mut u8) -> i32;
// WinDivert 2.x: Send(handle, packet, packetLen, *sendLen, *addr)
type SendFn = unsafe extern "C" fn(HANDLE, *const u8, u32, *mut u32, *const u8) -> i32;
type CloseFn = unsafe extern "C" fn(HANDLE) -> i32;
type CalcChecksumsFn = unsafe extern "C" fn(*mut u8, u32, *mut u8, u64) -> i32;
type ShutdownFn = unsafe extern "C" fn(HANDLE, i32) -> i32;
type SetParamFn = unsafe extern "C" fn(HANDLE, i32, u64) -> i32;
type GetParamFn = unsafe extern "C" fn(HANDLE, i32, *mut u64) -> i32;

/// Effective kernel queue limits for a handle (0 = could not be read).
#[derive(Debug, Clone, Copy, Default)]
pub struct QueueParams {
    pub length: u64,
    pub size: u64,
    pub time_ms: u64,
}

pub struct WinDivertApi {
    module: HMODULE,
    pub dll_path: PathBuf,
    open: OpenFn,
    recv: RecvFn,
    send: SendFn,
    close: CloseFn,
    calc_checksums: CalcChecksumsFn,
    shutdown: Option<ShutdownFn>,
    set_param: Option<SetParamFn>,
    get_param: Option<GetParamFn>,
}

// SAFETY: WinDivert handles are used from dedicated threads with external sync.
unsafe impl Send for WinDivertApi {}
unsafe impl Sync for WinDivertApi {}

impl WinDivertApi {
    pub fn load(dir: Option<&Path>) -> Result<Self, String> {
        let dll = resolve_dll(dir)?;
        // Must be absolute — elevated helper cwd is often C:\Windows\System32.
        let dll = std::fs::canonicalize(&dll).unwrap_or(dll);
        if !dll.is_file() {
            return Err(format!(
                "WinDivert.dll not found at {} (use absolute --windivert-dir with 2.2+ x64 build)",
                dll.display()
            ));
        }

        let wide: Vec<u16> = OsStr::new(&dll)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        if module.is_null() {
            return Err(format!(
                "LoadLibrary({}) failed: {}",
                dll.display(),
                std::io::Error::last_os_error()
            ));
        }

        unsafe {
            // WinDivert 2.0+ exports WinDivertShutdown; 1.x does not.
            let shutdown_ptr =
                GetProcAddress(module, b"WinDivertShutdown\0".as_ptr() as *const i8);
            if shutdown_ptr.is_null() {
                FreeLibrary(module);
                return Err(format!(
                    "WinDivert at {} looks like 1.x (missing WinDivertShutdown). \
                     SocksCap requires WinDivert 2.2+ x64. Replace WinDivert.dll and \
                     WinDivert64.sys next to the helper (see resources/sockscap/windows/README.md).",
                    dll.display()
                ));
            }

            let open = load_sym(module, b"WinDivertOpen\0")?;
            let recv = load_sym(module, b"WinDivertRecv\0")?;
            let send = load_sym(module, b"WinDivertSend\0")?;
            let close = load_sym(module, b"WinDivertClose\0")?;
            let calc = load_sym(module, b"WinDivertHelperCalcChecksums\0")?;

            // Optional: queue tuning degrades to driver defaults if absent.
            let set_param_ptr =
                GetProcAddress(module, b"WinDivertSetParam\0".as_ptr() as *const i8);
            let get_param_ptr =
                GetProcAddress(module, b"WinDivertGetParam\0".as_ptr() as *const i8);

            let api = Self {
                module,
                dll_path: dll.clone(),
                open: std::mem::transmute::<FARPROC, OpenFn>(open),
                recv: std::mem::transmute::<FARPROC, RecvFn>(recv),
                send: std::mem::transmute::<FARPROC, SendFn>(send),
                close: std::mem::transmute::<FARPROC, CloseFn>(close),
                calc_checksums: std::mem::transmute::<FARPROC, CalcChecksumsFn>(calc),
                shutdown: Some(std::mem::transmute::<FARPROC, ShutdownFn>(shutdown_ptr)),
                set_param: (!set_param_ptr.is_null())
                    .then(|| std::mem::transmute::<FARPROC, SetParamFn>(set_param_ptr)),
                get_param: (!get_param_ptr.is_null())
                    .then(|| std::mem::transmute::<FARPROC, GetParamFn>(get_param_ptr)),
            };

            // Sanity: NETWORK open must work with 2.x ABI.
            match api.open("false", LAYER_NETWORK, 0, 0) {
                Ok(h) => {
                    api.close_handle(h);
                }
                Err(e) => {
                    drop(api);
                    return Err(format!(
                        "WinDivert 2.x probe open failed for {}: {e}. \
                         Ensure the matching WinDivert64.sys is beside the DLL and helper is elevated.",
                        dll.display()
                    ));
                }
            }

            Ok(api)
        }
    }

    pub fn open(&self, filter: &str, layer: i32, priority: i16, flags: u64) -> Result<HANDLE, String> {
        let c = std::ffi::CString::new(filter).map_err(|e| e.to_string())?;
        let h = unsafe { (self.open)(c.as_ptr(), layer, priority, flags) };
        if h.is_null() || h == (-1isize as HANDLE) {
            let err = std::io::Error::last_os_error();
            let layer_name = match layer {
                0 => "NETWORK",
                1 => "NETWORK_FORWARD",
                2 => "FLOW",
                3 => "SOCKET",
                4 => "REFLECT",
                _ => "?",
            };
            return Err(format!(
                "WinDivertOpen(layer={layer}/{layer_name}, filter={filter:?}, prio={priority}, dll={}) failed: {err}",
                self.dll_path.display()
            ));
        }
        Ok(h)
    }

    pub fn recv(
        &self,
        handle: HANDLE,
        packet: &mut [u8],
        addr: &mut [u8],
    ) -> Result<usize, String> {
        let mut recv_len: u32 = 0;
        let ok = unsafe {
            (self.recv)(
                handle,
                packet.as_mut_ptr(),
                packet.len() as u32,
                &mut recv_len,
                addr.as_mut_ptr(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "WinDivertRecv failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(recv_len as usize)
    }

    pub fn send(&self, handle: HANDLE, packet: &[u8], addr: &[u8]) -> Result<(), String> {
        let mut send_len: u32 = 0;
        let ok = unsafe {
            (self.send)(
                handle,
                packet.as_ptr(),
                packet.len() as u32,
                &mut send_len,
                addr.as_ptr(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "WinDivertSend failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub fn calc_checksums(&self, packet: &mut [u8], addr: &mut [u8]) {
        unsafe {
            (self.calc_checksums)(
                packet.as_mut_ptr(),
                packet.len() as u32,
                addr.as_mut_ptr(),
                0,
            );
        }
    }

    pub fn set_param(&self, handle: HANDLE, param: i32, value: u64) -> bool {
        match self.set_param {
            Some(f) => unsafe { f(handle, param, value) != 0 },
            None => false,
        }
    }

    pub fn get_param(&self, handle: HANDLE, param: i32) -> u64 {
        let Some(f) = self.get_param else {
            return 0;
        };
        let mut v: u64 = 0;
        if unsafe { f(handle, param, &mut v) } == 0 {
            return 0;
        }
        v
    }

    /// Raise the kernel queue limits above the driver defaults (~4096 packets /
    /// 4 MB) for a diverted handle.
    ///
    /// When the queue overflows, the driver **silently drops** packets. Because
    /// the diverted flow owns every outbound TCP packet on the host, a drop
    /// storm shows up as machine-wide retransmits and collapsed congestion
    /// windows rather than as any error the helper can observe. A deeper queue
    /// absorbs bursts and the occasional scheduling hiccup.
    ///
    /// Candidates are tried in descending order and the first accepted value
    /// wins, so this does not depend on one WinDivert build's documented
    /// maximum — an out-of-range value simply fails and the next is tried.
    ///
    /// `QUEUE_TIME` is deliberately left at the driver default. It caps how long
    /// a packet may sit queued; raising it would let stale packets occupy queue
    /// slots (making length overflow *more* likely) and inject multi-second-old
    /// packets after TCP has already retransmitted them. Depth, not staleness,
    /// is what we want more of.
    pub fn tune_queue(&self, handle: HANDLE, with_size: bool) -> QueueParams {
        for v in [16384u64, 8192, 4096] {
            if self.set_param(handle, PARAM_QUEUE_LENGTH, v) {
                break;
            }
        }
        if with_size {
            for v in [16u64 << 20, 8 << 20, 4 << 20] {
                if self.set_param(handle, PARAM_QUEUE_SIZE, v) {
                    break;
                }
            }
        }
        QueueParams {
            length: self.get_param(handle, PARAM_QUEUE_LENGTH),
            size: self.get_param(handle, PARAM_QUEUE_SIZE),
            time_ms: self.get_param(handle, PARAM_QUEUE_TIME),
        }
    }

    pub fn close_handle(&self, handle: HANDLE) {
        unsafe {
            if let Some(sd) = self.shutdown {
                let _ = sd(handle, 0 /* both */);
            }
            let _ = (self.close)(handle);
        }
    }
}

impl Drop for WinDivertApi {
    fn drop(&mut self) {
        if !self.module.is_null() {
            unsafe {
                FreeLibrary(self.module);
            }
            self.module = ptr::null_mut();
        }
    }
}

unsafe fn load_sym(module: HMODULE, name: &[u8]) -> Result<FARPROC, String> {
    let p = GetProcAddress(module, name.as_ptr() as *const i8);
    if p.is_null() {
        Err(format!(
            "GetProcAddress({}) failed",
            String::from_utf8_lossy(name)
        ))
    } else {
        Ok(p)
    }
}

fn resolve_dll(dir: Option<&Path>) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(d) = dir {
        let d = if d.is_absolute() {
            d.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|c| c.join(d))
                .unwrap_or_else(|_| d.to_path_buf())
        };
        candidates.push(d.join("WinDivert.dll"));
        candidates.push(d.join("x64").join("WinDivert.dll"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("WinDivert.dll"));
            candidates.push(parent.join("sockscap").join("windows").join("WinDivert.dll"));
        }
    }
    if let Ok(d) = std::env::var("SOCKSCAP_WINDIVERT_DIR") {
        candidates.push(PathBuf::from(d).join("WinDivert.dll"));
    }

    for c in &candidates {
        if c.is_file() {
            return Ok(c.clone());
        }
    }

    Err(format!(
        "WinDivert.dll not found. Tried:\n  {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\n  ")
    ))
}

/// WinDivert 2.x ADDRESS layout (MSVC x64):
///   Timestamp: i64 @0
///   Layer:8 Event:8 Sniffed:1 Outbound:1 Loopback:1 Impostor:1 ... @8
///   Reserved2 @12
///   union (Network/Flow/Socket) @16
pub const ADDR_LEN: usize = 128;

pub fn addr_layer(addr: &[u8]) -> u8 {
    if addr.len() < 9 {
        return 0;
    }
    addr[8]
}

pub fn addr_event(addr: &[u8]) -> u8 {
    if addr.len() < 10 {
        return 0;
    }
    addr[9]
}

const FLAG_SNIFFED: u8 = 0x01;
const FLAG_OUTBOUND: u8 = 0x02;
const FLAG_LOOPBACK: u8 = 0x04;
const FLAG_IMPOSTOR: u8 = 0x08;

pub fn addr_is_outbound(addr: &[u8]) -> bool {
    if addr.len() < 11 {
        return false;
    }
    (addr[10] & FLAG_OUTBOUND) != 0
}

pub fn addr_set_outbound(addr: &mut [u8], on: bool) {
    if addr.len() < 11 {
        return;
    }
    if on {
        addr[10] |= FLAG_OUTBOUND;
    } else {
        addr[10] &= !FLAG_OUTBOUND;
    }
}

pub fn addr_set_loopback(addr: &mut [u8], on: bool) {
    if addr.len() < 11 {
        return;
    }
    if on {
        addr[10] |= FLAG_LOOPBACK;
    } else {
        addr[10] &= !FLAG_LOOPBACK;
    }
}

pub fn addr_set_impostor(addr: &mut [u8], on: bool) {
    if addr.len() < 11 {
        return;
    }
    if on {
        addr[10] |= FLAG_IMPOSTOR;
    } else {
        addr[10] &= !FLAG_IMPOSTOR;
    }
}

/// Streamdump-style reflect: reinject as inbound (only flip Outbound).
/// Official sample does NOT force Loopback/Impostor/IfIdx — those break
/// delivery when reflecting onto the host's LAN address.
pub fn addr_for_reflect_inbound(addr: &mut [u8]) {
    addr_set_outbound(addr, false);
    let _ = FLAG_SNIFFED;
    let _ = FLAG_LOOPBACK;
    let _ = FLAG_IMPOSTOR;
}

// Keep old names as aliases so any residual call sites compile.
pub fn addr_for_local_redirect(addr: &mut [u8]) {
    addr_for_reflect_inbound(addr);
}

pub fn addr_for_return_to_app(addr: &mut [u8]) {
    addr_for_reflect_inbound(addr);
}

/// FLOW/SOCKET process id lives in the layer-specific union at offset 16.
/// FLOW: EndpointId u64, ParentEndpointId u64, ProcessId u32 → pid at 16+16=32
pub fn flow_process_id(addr: &[u8]) -> u32 {
    if addr.len() < 16 + 8 + 8 + 4 {
        return 0;
    }
    let base = 16 + 16;
    u32::from_le_bytes(addr[base..base + 4].try_into().unwrap_or([0; 4]))
}

pub fn flow_endpoints_ip(
    addr: &[u8],
) -> Option<(std::net::IpAddr, u16, std::net::IpAddr, u16, u8)> {
    if addr.len() < 16 + 8 + 8 + 4 + 16 + 16 + 2 + 2 + 1 {
        return None;
    }
    let mut o = 16 + 16 + 4;
    let local = decode_addr128(&addr[o..o + 16]);
    o += 16;
    let remote = decode_addr128(&addr[o..o + 16]);
    o += 16;
    let local_port = u16::from_le_bytes([addr[o], addr[o + 1]]);
    let remote_port = u16::from_le_bytes([addr[o + 2], addr[o + 3]]);
    let protocol = addr[o + 4];
    Some((local, local_port, remote, remote_port, protocol))
}

fn decode_addr128(bytes: &[u8]) -> std::net::IpAddr {
    if bytes[4..16].iter().all(|&b| b == 0) {
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(
            bytes[0], bytes[1], bytes[2], bytes[3],
        ))
    } else {
        let mut a = [0u8; 16];
        a.copy_from_slice(&bytes[..16]);
        std::net::IpAddr::V6(std::net::Ipv6Addr::from(a))
    }
}
