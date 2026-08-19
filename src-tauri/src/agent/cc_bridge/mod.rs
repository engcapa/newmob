// ⚠️ This module must NOT use crate::vault::*
// CC authentication is fully delegated to the CC CLI itself.

pub mod commands;
pub mod config;
pub mod mcp_control;
pub mod mcp_http;
pub mod mcp_redis;
pub mod mcp_sql;
pub mod process;
pub mod protocol;
pub mod session_card;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

pub const MIN_VERSION: &str = "1.0.0";

/// Apply `CREATE_NO_WINDOW` so spawning the `claude` CLI — an npm `.cmd`/`.ps1`
/// shim on Windows — doesn't flash a PowerShell/console window. No-op on
/// non-Windows. Call on every `Command` that launches the binary (conversation
/// process, version check, auth probe).
pub(crate) fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        // winapi CREATE_NO_WINDOW.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

pub(crate) fn apply_proxy_env(cmd: &mut Command, proxy_url: Option<&str>) {
    let Some(proxy) = proxy_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    cmd.env("HTTP_PROXY", proxy)
        .env("HTTPS_PROXY", proxy)
        .env("ALL_PROXY", proxy)
        .env("NO_PROXY", "127.0.0.1,localhost");
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CcStatus {
    /// `claude` binary not found in PATH.
    NotFound,
    /// Found but version is below MIN_VERSION.
    VersionTooLow { found: String, required: String },
    /// Found + version OK, but `claude -p "ping"` failed (not logged in).
    NotAuthenticated,
    /// Ready to use.
    Ready { version: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcStatusResult {
    pub status: CcStatus,
    pub message: String,
    pub binary_path: Option<String>,
}

/// Locate the `claude` binary. On Windows tries claude.cmd / claude.exe.
///
/// Resolution order:
///  1. The inherited `PATH` (works for dev / terminal launch, and on Windows
///     where GUI apps inherit the registry PATH).
///  2. The login shell's `PATH`. macOS apps launched from Finder/Dock — and
///     some Linux desktop sessions — are started by `launchd`/the session
///     manager with a minimal PATH that omits user-local dirs like
///     `~/.local/bin`, so step 1 fails even though `which claude` works in a
///     terminal. We recover the real PATH by asking the login shell.
///  3. Well-known absolute install locations, in case the binary lives off any
///     PATH we can recover.
pub fn find_claude_binary() -> Option<String> {
    // Try explicit names in order.
    let candidates: &[&str] = if cfg!(windows) {
        &["claude.cmd", "claude.exe", "claude"]
    } else {
        &["claude"]
    };

    // 1. Standard PATH lookup.
    for name in candidates {
        if let Ok(path) = which::which(name) {
            return Some(path.to_string_lossy().to_string());
        }
    }

    // 2. Recovered login-shell PATH (GUI-launch fallback).
    #[cfg(unix)]
    if let Some(path_var) = login_shell_path() {
        for dir in path_var.split(':') {
            let dir = dir.trim();
            if dir.is_empty() {
                continue;
            }
            let cand = PathBuf::from(dir).join("claude");
            if cand.is_file() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }

    // 3. Well-known install locations.
    for cand in common_install_locations() {
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }

    None
}

/// Candidate absolute paths where `claude` is commonly installed but which may
/// not be on a GUI process's PATH. `Path::is_file` follows symlinks, so the
/// official installer's `~/.local/bin/claude -> versions/x` link resolves fine.
fn common_install_locations() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".local/bin/claude"));
        v.push(home.join(".claude/local/claude"));
        v.push(home.join("bin/claude"));
        v.push(home.join(".bun/bin/claude"));
        v.push(home.join(".npm-global/bin/claude"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin/claude"));
    v.push(PathBuf::from("/usr/local/bin/claude"));
    v.push(PathBuf::from("/usr/bin/claude"));
    v
}

/// Recover the `PATH` an interactive login shell would expose, so GUI-launched
/// processes can see user-local install dirs (e.g. `~/.local/bin` exported from
/// `~/.zshrc`). Cached for the process lifetime: spawning a shell is relatively
/// expensive and PATH is stable within a session. A 3s watchdog guards against
/// a pathological rc file hanging detection.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::process::{Command as StdCommand, Stdio};
    use std::sync::OnceLock;
    use std::sync::mpsc;

    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            // Markers let us extract PATH cleanly even if rc files print
            // banners/prompts to stdout.
            const START: &str = "<<TAOMNI_PATH>>";
            const END: &str = "<</TAOMNI_PATH>>";
            const CMD: &str = "command printf '<<TAOMNI_PATH>>%s<</TAOMNI_PATH>>' \"$PATH\"";

            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                // `-i` sources interactive rc files (e.g. ~/.zshrc) that export
                // PATH; `-c CMD` runs and exits without entering the REPL; stdin
                // is detached so the shell can't block waiting for input.
                let result = StdCommand::new(&shell)
                    .args(["-ilc", CMD])
                    .stdin(Stdio::null())
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
                let _ = tx.send(result);
            });

            let out = rx.recv_timeout(Duration::from_secs(3)).ok()??;
            let start = out.find(START)? + START.len();
            let end = out[start..].find(END)? + start;
            let path = out[start..end].trim().to_string();
            if path.is_empty() { None } else { Some(path) }
        })
        .clone()
}

/// Parse a semver string like "1.2.3" into (major, minor, patch).
fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let parts: Vec<&str> = v.splitn(3, '.').collect();
    if parts.len() < 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].split('-').next()?.parse().ok()?,
    ))
}

fn version_ok(found: &str, required: &str) -> bool {
    let (fmaj, fmin, fpat) = parse_version(found).unwrap_or((0, 0, 0));
    let (rmaj, rmin, rpat) = parse_version(required).unwrap_or((1, 0, 0));
    (fmaj, fmin, fpat) >= (rmaj, rmin, rpat)
}

/// Detect Claude Code CLI status.
pub async fn detect(binary: Option<&str>, proxy_url: Option<&str>) -> CcStatusResult {
    let path = match binary {
        Some(b) if !b.is_empty() && b != "auto" => Some(b.to_string()),
        _ => find_claude_binary(),
    };

    let Some(bin) = path else {
        return CcStatusResult {
            status: CcStatus::NotFound,
            message: "Claude Code CLI not found. Install it to enable this feature.".into(),
            binary_path: None,
        };
    };

    // Run `claude --version`.
    let mut version_cmd = Command::new(&bin);
    version_cmd.arg("--version");
    no_console_window(&mut version_cmd);
    let version_out = timeout(Duration::from_secs(5), version_cmd.output()).await;

    let version_str = match version_out {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => {
            return CcStatusResult {
                status: CcStatus::NotFound,
                message: format!("Failed to run `{} --version`", bin),
                binary_path: Some(bin),
            };
        }
    };

    // Extract version number (output can be like "Claude Code 1.2.3", "2.1.177 (Claude Code)", or "1.2.3").
    let version = version_str
        .split_whitespace()
        .find(|s| {
            let s_trim = s.trim_start_matches('v');
            s_trim.chars().next().map_or(false, |c| c.is_ascii_digit()) && s_trim.contains('.')
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            version_str
                .split_whitespace()
                .last()
                .unwrap_or("")
                .to_string()
        });

    if !version_ok(&version, MIN_VERSION) {
        return CcStatusResult {
            status: CcStatus::VersionTooLow {
                found: version.clone(),
                required: MIN_VERSION.into(),
            },
            message: format!(
                "Claude Code {} found, but v{} or later is required.",
                version, MIN_VERSION
            ),
            binary_path: Some(bin),
        };
    }

    // Probe authentication with a minimal non-interactive call.
    let auth_ok = probe_auth(&bin, proxy_url).await;

    if !auth_ok {
        return CcStatusResult {
            status: CcStatus::NotAuthenticated,
            message:
                "Claude Code is installed but not authenticated. Run `claude login` in a terminal."
                    .into(),
            binary_path: Some(bin),
        };
    }

    CcStatusResult {
        status: CcStatus::Ready {
            version: version.clone(),
        },
        message: format!("Claude Code v{} ready.", version),
        binary_path: Some(bin),
    }
}

/// Run a minimal probe to check authentication.
async fn probe_auth(binary: &str, proxy_url: Option<&str>) -> bool {
    let mut cmd = Command::new(binary);
    cmd.args(["--print", "ping", "--output-format", "json"]);
    apply_proxy_env(&mut cmd, proxy_url);
    no_console_window(&mut cmd);
    let result = timeout(Duration::from_secs(10), cmd.output()).await;

    match result {
        Ok(Ok(out)) => out.status.success(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_decorated_versions() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("v2.1.177"), Some((2, 1, 177)));
        assert_eq!(parse_version("1.0.0-beta.2"), Some((1, 0, 0)));
        assert_eq!(parse_version("not-a-version"), None);
    }

    #[test]
    fn version_comparison_respects_minimum() {
        assert!(version_ok("2.1.177", MIN_VERSION));
        assert!(version_ok("1.0.0", MIN_VERSION));
        assert!(!version_ok("0.9.9", MIN_VERSION));
    }

    #[test]
    fn common_locations_include_user_local_bin() {
        let locs = common_install_locations();
        assert!(!locs.is_empty());
        if let Some(home) = dirs::home_dir() {
            assert!(
                locs.contains(&home.join(".local/bin/claude")),
                "expected ~/.local/bin/claude among fallbacks: {:?}",
                locs
            );
        }
    }
}
