//! B-path executor (方案4): run a command on the bound session's host in a
//! context *divorced* from the interactive shell, capturing clean stdout/stderr
//! + exit code into a Taomni-local file.
//!
//!   - SSH session  → a fresh `exec` channel on the existing connection handle
//!     (separate from the interactive PTY channel). cwd is bridged with a
//!     `cd …` prefix; interactive aliases/functions/transient env are not
//!     inherited (that is the C path's job).
//!   - Local session → a child process via the platform shell (`pwsh` on
//!     Windows, `sh -lc` elsewhere) with `current_dir` set.
//!
//! Both stream into a [`CaptureWriter`], report progress through a throttled
//! callback, and stop promptly when the cancel `Notify` fires (channel dropped
//! / child killed).

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use super::{CaptureStatus, CaptureWriter};

/// Result of a B-path run.
pub struct ExecOutcome {
    pub status: CaptureStatus,
    pub exit_code: Option<i32>,
}

/// Throttle progress callbacks to ≤ every 500ms or 256 KiB.
struct Progress<F: FnMut(u64, u64)> {
    cb: F,
    last: Instant,
    last_bytes: u64,
}

impl<F: FnMut(u64, u64)> Progress<F> {
    fn new(cb: F) -> Self {
        Self {
            cb,
            last: Instant::now(),
            last_bytes: 0,
        }
    }
    fn maybe(&mut self, lines: u64, bytes: u64) {
        if self.last.elapsed() >= Duration::from_millis(500)
            || bytes.saturating_sub(self.last_bytes) >= 256 * 1024
        {
            (self.cb)(lines, bytes);
            self.last = Instant::now();
            self.last_bytes = bytes;
        }
    }
    fn final_tick(&mut self, lines: u64, bytes: u64) {
        (self.cb)(lines, bytes);
    }
}

/// POSIX single-quote a string for safe interpolation into a `cd '<path>'`.
pub(super) fn posix_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Bridge cwd by prefixing `cd '<cwd>' && ` (POSIX). The captured data is
/// shell-agnostic; only this prefix assumes POSIX, so a PowerShell remote may
/// start in the home dir (acceptable for B — full output is still captured).
fn with_cwd(command: &str, cwd: Option<&str>) -> String {
    match cwd.map(str::trim).filter(|s| !s.is_empty()) {
        Some(cwd) => format!("cd {} && {}", posix_quote(cwd), command),
        None => command.to_string(),
    }
}

/// Run over a fresh SSH `exec` channel on `handle`.
pub async fn run_ssh(
    handle: &russh::client::Handle<crate::terminal::ssh::SshHandler>,
    command: &str,
    cwd: Option<&str>,
    writer: &CaptureWriter,
    cancel: Arc<Notify>,
    on_progress: impl FnMut(u64, u64),
) -> Result<ExecOutcome, String> {
    use russh::ChannelMsg;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("failed to open exec channel: {e}"))?;
    channel
        .exec(true, with_cwd(command, cwd).into_bytes())
        .await
        .map_err(|e| format!("failed to start exec: {e}"))?;

    let (mut read_half, _write_half) = channel.split();
    let mut progress = Progress::new(on_progress);
    let mut exit_code: Option<i32> = None;
    let mut status = CaptureStatus::Done;

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                status = CaptureStatus::Cancelled;
                break;
            }
            msg = read_half.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if !writer.write_chunk(&data) {
                            // Cap tripped — stop reading; capture is truncated.
                            break;
                        }
                        progress.maybe(writer.lines(), writer.bytes());
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }

    writer.flush();
    progress.final_tick(writer.lines(), writer.bytes());
    Ok(ExecOutcome { status, exit_code })
}

/// Run over a local child process using the platform shell.
pub async fn run_local(
    command: &str,
    cwd: Option<&str>,
    writer: &CaptureWriter,
    cancel: Arc<Notify>,
    on_progress: impl FnMut(u64, u64),
) -> Result<ExecOutcome, String> {
    let mut cmd = local_shell_command(command);
    if let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.current_dir(cwd);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::agent::cc_bridge::no_console_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    let mut progress = Progress::new(on_progress);
    let mut buf_out = [0u8; 16 * 1024];
    let mut buf_err = [0u8; 16 * 1024];
    let mut out_open = true;
    let mut err_open = true;
    let mut status = CaptureStatus::Done;

    loop {
        if !out_open && !err_open {
            break;
        }
        tokio::select! {
            _ = cancel.notified() => {
                let _ = child.kill().await;
                status = CaptureStatus::Cancelled;
                break;
            }
            r = stdout.read(&mut buf_out), if out_open => match r {
                Ok(0) | Err(_) => out_open = false,
                Ok(n) => {
                    if !writer.write_chunk(&buf_out[..n]) { break; }
                    progress.maybe(writer.lines(), writer.bytes());
                }
            },
            r = stderr.read(&mut buf_err), if err_open => match r {
                Ok(0) | Err(_) => err_open = false,
                Ok(n) => {
                    if !writer.write_chunk(&buf_err[..n]) { break; }
                    progress.maybe(writer.lines(), writer.bytes());
                }
            },
        }
    }

    let exit_code = match child.wait().await {
        Ok(st) => st.code(),
        Err(_) => None,
    };
    writer.flush();
    progress.final_tick(writer.lines(), writer.bytes());
    Ok(ExecOutcome { status, exit_code })
}

/// Build the platform shell invocation for a local captured run.
fn local_shell_command(command: &str) -> tokio::process::Command {
    if cfg!(windows) {
        // Prefer PowerShell 7 (`pwsh`); the spawn falls back to `powershell`
        // only implicitly via PATH — we pick `pwsh` and let the caller's env
        // resolve it. `-NoProfile` keeps the captured output free of profile
        // banners.
        let mut c = tokio::process::Command::new("pwsh");
        c.arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(command);
        c
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut c = tokio::process::Command::new(shell);
        c.arg("-lc").arg(command);
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quote_escapes_single_quotes() {
        assert_eq!(posix_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(posix_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn with_cwd_prefixes_cd() {
        assert_eq!(with_cwd("ls", Some("/var/log")), "cd '/var/log' && ls");
        assert_eq!(with_cwd("ls", None), "ls");
        assert_eq!(with_cwd("ls", Some("  ")), "ls");
    }

    #[tokio::test]
    async fn local_run_captures_output() {
        if cfg!(windows) {
            return; // POSIX shell assumed in this test
        }
        let dir =
            std::env::temp_dir().join(format!("taomni-execb-{}", uuid::Uuid::new_v4().simple()));
        let w = CaptureWriter::create(&dir, "x").unwrap();
        let cancel = Arc::new(Notify::new());
        let out = run_local("printf 'a\\nb\\nc\\n'", None, &w, cancel, |_, _| {})
            .await
            .unwrap();
        assert_eq!(out.status, CaptureStatus::Done);
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(w.lines(), 3);
        let content = std::fs::read_to_string(w.path()).unwrap();
        assert_eq!(content, "a\nb\nc\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
