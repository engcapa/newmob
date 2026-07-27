//! Elevated command execution for Linux capture operations (nftables & cgroup).
//!
//! The implementation is shared with the macOS backend, which needs the same
//! sudo handling for `networksetup`. See [`crate::sockscap::elevate`].

pub use crate::sockscap::elevate::{is_effective_root, run_command_elevated};
