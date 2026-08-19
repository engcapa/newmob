//! C-path executor (方案4): run a command in the *live interactive session*
//! (visible to the user via `tee`), capturing the full output to a remote temp
//! file. Reduction (`read_capture`) runs over a side `exec` channel so the full
//! bytes never have to cross the wire — only distilled slices do.
//!
//! POSIX remote only this round. The command is wrapped so it stays visible,
//! records the exit code inline, and tees to a temp file:
//!
//! ```text
//! { <command>; printf '\n__TAOMNI_END_<nonce> rc=%s\n' "$?"; } 2>&1 | tee <path>
//! ```
//!
//! Completion + progress are observed by polling the remote file over a side
//! channel (`wc -lc` + a grep for the end sentinel); the interactive channel is
//! only written to (the command + a Ctrl-C on cancel). A PowerShell remote is
//! rejected (use `reflect_session=false`, the B path, which is shell-agnostic).

use std::sync::Arc;
use std::time::Duration;

use russh::client::{Handle, Msg};
use russh::{ChannelMsg, ChannelWriteHalf};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::exec_b::posix_quote;
use super::reduce::{MAX_READ_BYTES, ReduceOp, ReduceResult};
use super::{CaptureStatus, ShellFamily};
use crate::terminal::ssh::SshHandler;

/// How much of a remote file we pull to Taomni for a Rust-side reduction
/// fallback (jq when remote `jq` is absent).
const MAX_PULL_BYTES: usize = 8 * 1024 * 1024;

type WriteHalf = Arc<AsyncMutex<ChannelWriteHalf<Msg>>>;

fn end_marker(nonce: &str) -> String {
    format!("__TAOMNI_END_{nonce}")
}

/// Run a one-shot command on a fresh `exec` channel and collect bounded output
/// (stdout+stderr merged) plus the exit status.
async fn exec_collect(
    handle: &Handle<SshHandler>,
    cmd: &str,
    max_bytes: usize,
) -> Result<(String, Option<i32>), String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("exec channel: {e}"))?;
    channel
        .exec(true, cmd.as_bytes().to_vec())
        .await
        .map_err(|e| format!("exec: {e}"))?;
    let (mut read_half, _w) = channel.split();
    let mut out: Vec<u8> = Vec::new();
    let mut code: Option<i32> = None;
    while let Some(msg) = read_half.wait().await {
        match msg {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                if out.len() < max_bytes {
                    let room = max_bytes - out.len();
                    out.extend_from_slice(&data[..data.len().min(room)]);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status as i32),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok((String::from_utf8_lossy(&out).to_string(), code))
}

/// Detect the remote shell family over a side channel (cached by the caller).
pub async fn detect_shell(handle: &Handle<SshHandler>) -> ShellFamily {
    match exec_collect(handle, "uname -s", 256).await {
        Ok((out, Some(0))) if !out.trim().is_empty() => ShellFamily::Posix,
        _ => ShellFamily::PowerShell,
    }
}

/// POSIX remote temp path for a capture nonce.
fn remote_temp_path(nonce: &str) -> String {
    format!("/tmp/taomni-cap-{nonce}")
}

/// Wrap a command so it stays visible (tee), records the command's own exit
/// code inline, and lands the full output in `path`.
fn wrap_posix(command: &str, path: &str, marker: &str) -> String {
    format!(
        "{{ {command}; printf '\\n{marker} rc=%s\\n' \"$?\"; }} 2>&1 | tee {q}",
        q = posix_quote(path)
    )
}

/// Inject the wrapped command into the live interactive session and return the
/// shell family + remote path. POSIX remotes only.
pub async fn start_c_ssh(
    handle: &Handle<SshHandler>,
    write_half: &WriteHalf,
    command: &str,
    nonce: &str,
) -> Result<(ShellFamily, String), String> {
    let family = detect_shell(handle).await;
    if family == ShellFamily::PowerShell {
        return Err(
            "in-session capture (reflect_session=true) supports POSIX remote shells only; \
             use reflect_session=false (independent channel) here"
                .to_string(),
        );
    }
    let path = remote_temp_path(nonce);
    let wrapped = wrap_posix(command, &path, &end_marker(nonce));
    {
        let ch = write_half.lock().await;
        ch.data_bytes(format!("{wrapped}\n").into_bytes())
            .await
            .map_err(|e| format!("inject command failed: {e}"))?;
    }
    Ok((family, path))
}

/// Poll the remote file until the end sentinel appears (or cancel/EOF). Emits
/// progress (lines, bytes) each tick. On cancel, sends Ctrl-C to the
/// interactive session.
pub async fn poll_c_ssh(
    handle: &Handle<SshHandler>,
    write_half: &WriteHalf,
    path: &str,
    marker: &str,
    cancel: Arc<Notify>,
    mut on_progress: impl FnMut(u64, u64),
) -> (CaptureStatus, Option<i32>) {
    let q = posix_quote(path);
    // wc -lc gives "lines bytes"; the RS (\036) separates it from the sentinel
    // grep so one round-trip yields both progress and completion.
    let probe = format!(
        "wc -lc < {q} 2>/dev/null; printf '\\036'; grep -a -m1 '{marker} rc=' {q} 2>/dev/null"
    );
    loop {
        tokio::select! {
            _ = cancel.notified() => {
                let ch = write_half.lock().await;
                let _ = ch.data_bytes(vec![0x03]).await; // Ctrl-C
                return (CaptureStatus::Cancelled, None);
            }
            _ = tokio::time::sleep(Duration::from_millis(700)) => {
                if let Ok((out, _)) = exec_collect(handle, &probe, 8192).await {
                    let (lines, bytes, rc) = parse_probe(&out, marker);
                    on_progress(lines, bytes);
                    if let Some(rc) = rc {
                        return (CaptureStatus::Done, Some(rc));
                    }
                }
            }
        }
    }
}

/// Parse the combined `wc -lc` + sentinel-grep probe output. Returns
/// (lines, bytes, Some(rc) once the end sentinel is present).
fn parse_probe(out: &str, marker: &str) -> (u64, u64, Option<i32>) {
    let mut parts = out.splitn(2, '\u{1e}');
    let wc = parts.next().unwrap_or("");
    let tail = parts.next().unwrap_or("");
    let mut nums = wc.split_whitespace().filter_map(|t| t.parse::<u64>().ok());
    let lines = nums.next().unwrap_or(0);
    let bytes = nums.next().unwrap_or(0);
    let rc = if tail.contains(marker) {
        tail.split("rc=")
            .nth(1)
            .and_then(|s| s.trim().split_whitespace().next())
            .and_then(|s| s.parse::<i32>().ok())
            .or(Some(-1))
    } else {
        None
    };
    (lines, bytes, rc)
}

// reduce + cleanup continue in the second half (appended below).
// __EXEC_C_SPLIT__

/// A `grep -av '<marker> rc='` prefix that filters the trailing sentinel line
/// out of any read, so CC never sees Taomni's bookkeeping line.
fn strip_sentinel(path: &str, marker: &str) -> String {
    format!("grep -av '{marker} rc=' {q}", q = posix_quote(path))
}

/// Reduce a remote (C-path) capture over a side `exec` channel. Numeric ops and
/// grep run remotely (coreutils are always present on POSIX); jq runs remotely
/// if `jq` is installed, else a bounded window is pulled back and reduced with
/// the embedded engine.
pub async fn reduce_remote(
    handle: &Handle<SshHandler>,
    family: ShellFamily,
    path: &str,
    nonce: &str,
    op: &ReduceOp,
) -> Result<ReduceResult, String> {
    if family != ShellFamily::Posix {
        return Err("remote reduction supports POSIX shells only".to_string());
    }
    let marker = end_marker(nonce);
    let base = strip_sentinel(path, &marker);

    let (cmd, note): (String, Option<String>) = match op {
        ReduceOp::Head { n } => (format!("{base} | head -n {n}"), None),
        ReduceOp::Tail { n } => (format!("{base} | tail -n {n}"), None),
        ReduceOp::Range { start, end } => {
            if *start == 0 || end < start {
                return Err("range requires 1-based start ≤ end".into());
            }
            (format!("{base} | sed -n '{start},{end}p'"), None)
        }
        ReduceOp::Stats => (format!("{base} | wc -lc"), None),
        ReduceOp::Grep { pattern, context } => {
            let ctx = (*context).min(10);
            (
                format!(
                    "{base} | grep -nE -C {ctx} -e {pat} | head -n 1000",
                    pat = posix_quote(pattern)
                ),
                None,
            )
        }
        ReduceOp::Jq { filter } => {
            // Prefer remote jq; fall back to pulling a bounded window + jaq.
            let has_jq = exec_collect(handle, "command -v jq >/dev/null 2>&1 && echo y", 16)
                .await
                .map(|(o, _)| o.trim() == "y")
                .unwrap_or(false);
            if has_jq {
                (format!("{base} | jq {f}", f = posix_quote(filter)), None)
            } else {
                // Pull bounded content, reduce locally with the embedded jq.
                let (content, _) = exec_collect(
                    handle,
                    &format!("{base} | head -c {MAX_PULL_BYTES}"),
                    MAX_PULL_BYTES,
                )
                .await?;
                let mut r = super::reduce::reduce_str(&content, op)?;
                r.note = Some("jq via pulled window (remote jq absent)".into());
                return Ok(r);
            }
        }
    };

    let (out, _code) = exec_collect(handle, &cmd, MAX_READ_BYTES).await?;
    let truncated = out.len() >= MAX_READ_BYTES;
    Ok(ReduceResult {
        text: out,
        truncated,
        note,
    })
}

/// Best-effort `rm -f` of a remote capture temp file (called on thread purge).
pub async fn cleanup_remote(handle: &Handle<SshHandler>, path: &str) {
    let _ = exec_collect(handle, &format!("rm -f {q}", q = posix_quote(path)), 16).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_posix_tees_and_records_rc() {
        let w = wrap_posix("ls -la", "/tmp/taomni-cap-x", "__TAOMNI_END_x");
        assert!(w.contains("ls -la"));
        assert!(w.contains("| tee '/tmp/taomni-cap-x'"));
        assert!(w.contains("__TAOMNI_END_x rc=%s"));
        assert!(w.contains("2>&1"));
    }

    #[test]
    fn parse_probe_reads_counts_and_rc() {
        // wc -lc style output, RS, then the sentinel line.
        let out = "  42 1337\u{1e}__TAOMNI_END_x rc=0\n";
        let (lines, bytes, rc) = parse_probe(out, "__TAOMNI_END_x");
        assert_eq!(lines, 42);
        assert_eq!(bytes, 1337);
        assert_eq!(rc, Some(0));
    }

    #[test]
    fn parse_probe_pending_when_no_sentinel() {
        let out = "  10 200\u{1e}";
        let (lines, bytes, rc) = parse_probe(out, "__TAOMNI_END_x");
        assert_eq!((lines, bytes), (10, 200));
        assert_eq!(rc, None);
    }

    #[test]
    fn parse_probe_nonzero_rc() {
        let out = "  5 50\u{1e}__TAOMNI_END_y rc=127\n";
        assert_eq!(parse_probe(out, "__TAOMNI_END_y").2, Some(127));
    }

    #[test]
    fn strip_sentinel_filters_marker_line() {
        let s = strip_sentinel("/tmp/x", "__TAOMNI_END_x");
        assert!(s.starts_with("grep -av '__TAOMNI_END_x rc='"));
        assert!(s.contains("'/tmp/x'"));
    }
}
