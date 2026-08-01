//! Elevated command execution for Linux capture operations (nftables & cgroup).
//!
//! The implementation is centralized in [`crate::sockscap::elevate`] so sudo
//! handling is consistent across nftables and cgroup operations.

pub use crate::sockscap::elevate::{is_effective_root, run_command_elevated};
