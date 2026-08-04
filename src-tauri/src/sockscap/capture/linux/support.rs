//! Whether this Linux environment can support transparent capture *at all*.
//!
//! The distinction that matters is "impossible here" versus "needs elevation".
//! Getting it wrong in either direction is harmful: treating a normal desktop as
//! unsupported would silently downgrade users who only needed to type a sudo
//! password, while treating a locked-down container as merely unelevated makes
//! the UI ask for a password that cannot possibly work.
//!
//! The reliable signal is the **capability bounding set**. A capability absent
//! from `CapBnd` can never be acquired by any process in this namespace — not by
//! sudo, not by setuid, not by uid 0 — because the kernel caps what the
//! namespace may ever hold. Containers routinely drop `CAP_NET_ADMIN` from it.
//! Checking `CapBnd` (plus the cgroup v2 mount and the `nft` binary) is both
//! precise and cheap: three file reads, no subprocess.

use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// `CAP_NET_ADMIN` bit position in the capability bitmask.
const CAP_NET_ADMIN: u32 = 12;

const CGROUP_CONTROLLERS: &str = "/sys/fs/cgroup/cgroup.controllers";
const NFT_PATHS: &[&str] = &["/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft", "/bin/nft"];

static SUPPORT: OnceLock<Result<(), String>> = OnceLock::new();

/// Can transparent capture work here, given any amount of elevation?
///
/// Cached: a container's capability bounding set and cgroup mount are fixed for
/// the lifetime of the process, and this is consulted from status polling paths
/// that must not pay for repeated probing.
pub fn transparent_support() -> Result<(), String> {
    SUPPORT
        .get_or_init(|| {
            probe(
                Path::new(CGROUP_CONTROLLERS).is_file(),
                read_bounding_set(),
                first_existing_nft().is_some(),
            )
        })
        .clone()
}

pub fn transparent_supported() -> bool {
    transparent_support().is_ok()
}

fn first_existing_nft() -> Option<&'static str> {
    NFT_PATHS
        .iter()
        .copied()
        .find(|path| Path::new(path).is_file())
}

/// Parse `CapBnd` from `/proc/self/status`. `None` when it cannot be read, which
/// is treated as "do not claim unsupported" by [`probe`].
fn read_bounding_set() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    parse_bounding_set(&status)
}

fn parse_bounding_set(status: &str) -> Option<u64> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("CapBnd:"))
        .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
}

/// Pure decision so every branch is testable without a container.
fn probe(
    cgroup_v2_mounted: bool,
    bounding_set: Option<u64>,
    nft_present: bool,
) -> Result<(), String> {
    let mut reasons = Vec::new();

    if !cgroup_v2_mounted {
        reasons.push(
            "the cgroup v2 unified hierarchy is not mounted at /sys/fs/cgroup (cgroup v1 only)"
                .to_string(),
        );
    }
    // Only a *readable* bounding set can prove absence. If /proc is unavailable,
    // stay optimistic and let the real preflight report the actual failure
    // rather than downgrading a capable host on a guess.
    if let Some(bounding_set) = bounding_set {
        if bounding_set & (1 << CAP_NET_ADMIN) == 0 {
            reasons.push(
                "CAP_NET_ADMIN is not in this process's capability bounding set, so no elevation \
                 (including root inside a container) can obtain it"
                    .to_string(),
            );
        }
    }
    if !nft_present {
        reasons.push("the nft binary is not installed".to_string());
    }

    if reasons.is_empty() {
        Ok(())
    } else {
        Err(reasons.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WITH_NET_ADMIN: u64 = 0x0000_003f_ffff_ffff;
    /// Docker's default bounding set: CAP_NET_ADMIN (bit 12) cleared.
    const DOCKER_DEFAULT: u64 = 0xa804_25fb;

    #[test]
    fn a_capable_host_supports_transparent_capture() {
        assert!(probe(true, Some(WITH_NET_ADMIN), true).is_ok());
    }

    #[test]
    fn an_unelevated_capable_host_is_still_supported() {
        // Lacking CAP_NET_ADMIN in the *effective* set is a sudo prompt, not an
        // unsupported environment. Only the bounding set is consulted here.
        assert!(probe(true, Some(WITH_NET_ADMIN), true).is_ok());
    }

    #[test]
    fn a_container_without_net_admin_in_the_bounding_set_is_unsupported() {
        let error = probe(true, Some(DOCKER_DEFAULT), true).unwrap_err();
        assert!(error.contains("CAP_NET_ADMIN"));
        assert!(error.contains("bounding set"));
    }

    #[test]
    fn cgroup_v1_only_is_unsupported() {
        let error = probe(false, Some(WITH_NET_ADMIN), true).unwrap_err();
        assert!(error.contains("cgroup v2"));
    }

    #[test]
    fn missing_nft_is_unsupported() {
        let error = probe(true, Some(WITH_NET_ADMIN), false).unwrap_err();
        assert!(error.contains("nft"));
    }

    #[test]
    fn every_blocking_reason_is_reported_together() {
        // A user fixing one problem should already know about the others.
        let error = probe(false, Some(DOCKER_DEFAULT), false).unwrap_err();
        assert!(error.contains("cgroup v2"));
        assert!(error.contains("CAP_NET_ADMIN"));
        assert!(error.contains("nft"));
    }

    #[test]
    fn an_unreadable_bounding_set_does_not_claim_unsupported() {
        assert!(probe(true, None, true).is_ok());
    }

    #[test]
    fn parses_the_bounding_set_from_proc_status() {
        let status = "Name:\ttaomni\nUid:\t1000\t1000\t1000\t1000\nCapBnd:\t00000000a80425fb\nCapEff:\t0000000000000000\n";
        assert_eq!(parse_bounding_set(status), Some(DOCKER_DEFAULT));
    }

    #[test]
    fn a_status_without_a_bounding_set_line_is_none() {
        assert_eq!(parse_bounding_set("Name:\ttaomni\n"), None);
    }

    #[test]
    fn the_real_environment_probe_is_consistent() {
        // Whatever this machine is, the cached probe must agree with itself and
        // report a reason whenever it says unsupported.
        let first = transparent_support();
        assert_eq!(first.is_ok(), transparent_supported());
        if let Err(reason) = first {
            assert!(!reason.is_empty());
        }
    }
}
