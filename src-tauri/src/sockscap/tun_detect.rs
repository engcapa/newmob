//! Detect virtual TUN network adapters created by circumvention clients running
//! in TUN/global mode (Clash TUN, sing-box, Wintun/TAP, WireGuard). SocksCap's
//! own global capture collides with an L3 TUN client (double capture / routing
//! loops), so we surface a warning rather than silently misbehaving.
//!
//! Windows uses self-contained FFI to iphlpapi's GetAdaptersAddresses (same
//! standalone-FFI approach as `listener_pid`). Non-Windows returns empty (its
//! capture model differs and this is a WinDivert-coexistence concern).

/// Adapter name markers that indicate a proxy/VPN TUN interface. Matched
/// case-insensitively against the adapter's friendly name + description.
const TUN_MARKERS: &[&str] = &[
    "wintun",
    "tun",
    "tap-windows",
    "tap",
    "clash",
    "mihomo",
    "sing-box",
    "singbox",
    "wireguard",
    "utun",
];

/// Friendly names/descriptions of adapters that look like a proxy/VPN TUN.
/// Empty when none found or on non-Windows.
#[cfg(windows)]
pub fn detect_tun_adapters() -> Vec<String> {
    win::tun_adapters()
}

#[cfg(not(windows))]
pub fn detect_tun_adapters() -> Vec<String> {
    Vec::new()
}

/// True when `name` contains any TUN marker (case-insensitive).
fn looks_like_tun(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    TUN_MARKERS.iter().any(|m| lower.contains(m))
}

#[cfg(windows)]
mod win {
    use super::looks_like_tun;
    use std::os::raw::c_void;

    type DWORD = u32;
    type ULONG = u32;

    const AF_UNSPEC: ULONG = 0;
    // Skip address enumeration we don't need (unicast/anycast/multicast/dns).
    const GAA_FLAG_SKIP: ULONG = 0x0001 | 0x0002 | 0x0004 | 0x0008;
    const ERROR_BUFFER_OVERFLOW: ULONG = 111;
    const NO_ERROR: ULONG = 0;

    /// Partial IP_ADAPTER_ADDRESSES: only the leading fields through
    /// FriendlyName (the rest of the record follows in the OS-filled buffer and
    /// is reached via `next`; we never deref past what's declared here).
    #[repr(C)]
    struct IpAdapterAddresses {
        length: ULONG,
        if_index: DWORD,
        next: *mut IpAdapterAddresses,
        adapter_name: *mut u8,           // PCHAR (ansi)
        first_unicast: *mut c_void,
        first_anycast: *mut c_void,
        first_multicast: *mut c_void,
        first_dns_server: *mut c_void,
        dns_suffix: *mut u16,            // PWCHAR
        description: *mut u16,           // PWCHAR
        friendly_name: *mut u16,         // PWCHAR
    }

    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetAdaptersAddresses(
            family: ULONG,
            flags: ULONG,
            reserved: *mut c_void,
            addresses: *mut IpAdapterAddresses,
            size: *mut ULONG,
        ) -> ULONG;
    }

    /// Read a NUL-terminated wide (UTF-16) string pointer into a String.
    unsafe fn wide_to_string(mut p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut units = Vec::new();
        unsafe {
            while *p != 0 {
                units.push(*p);
                p = p.add(1);
                if units.len() > 512 {
                    break; // defensive cap
                }
            }
        }
        String::from_utf16_lossy(&units)
    }

    pub fn tun_adapters() -> Vec<String> {
        let mut size: ULONG = 0;
        // Size probe.
        let rc = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC,
                GAA_FLAG_SKIP,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if size == 0 || (rc != ERROR_BUFFER_OVERFLOW && rc != NO_ERROR) {
            return Vec::new();
        }
        // Buffer must be suitably aligned for the struct; over-allocate as u64.
        let mut buf = vec![0u64; (size as usize).div_ceil(8) + 1];
        let head = buf.as_mut_ptr() as *mut IpAdapterAddresses;
        let rc = unsafe {
            GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_SKIP, std::ptr::null_mut(), head, &mut size)
        };
        if rc != NO_ERROR {
            return Vec::new();
        }

        let mut out = Vec::new();
        let mut cur = head;
        let mut guard = 0;
        unsafe {
            while !cur.is_null() && guard < 512 {
                guard += 1;
                let a = &*cur;
                let friendly = wide_to_string(a.friendly_name);
                let desc = wide_to_string(a.description);
                if looks_like_tun(&friendly) || looks_like_tun(&desc) {
                    // Prefer the human-friendly name; fall back to description.
                    let label = if !friendly.is_empty() { friendly } else { desc };
                    if !label.is_empty() && !out.contains(&label) {
                        out.push(label);
                    }
                }
                cur = a.next;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_matching_is_case_insensitive() {
        assert!(looks_like_tun("WinTun Userspace Tunnel"));
        assert!(looks_like_tun("Clash"));
        assert!(looks_like_tun("sing-box tun"));
        assert!(looks_like_tun("TAP-Windows Adapter V9"));
        assert!(looks_like_tun("WireGuard Tunnel"));
        assert!(!looks_like_tun("Intel(R) Ethernet Connection"));
        assert!(!looks_like_tun("Wi-Fi"));
        assert!(!looks_like_tun(""));
    }

    #[test]
    #[cfg(windows)]
    fn detect_runs_without_panicking() {
        // Just exercises the FFI path; result depends on the host.
        let _ = detect_tun_adapters();
    }
}
