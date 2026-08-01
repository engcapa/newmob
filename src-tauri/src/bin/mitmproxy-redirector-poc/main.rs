#[cfg(target_os = "macos")]
mod bridge;

#[cfg(target_os = "macos")]
mod macos {

    use std::env;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::Duration;

    use anyhow::{Context, Result, anyhow, bail};
    use tokio::net::UnixListener;
    use tokio::process::Command;
    use tokio::signal;
    use tokio::time::timeout;

    use crate::bridge::{send_intercept_config, serve_flow};

    const DEFAULT_REDIRECTOR: &str =
        "/Applications/Mitmproxy Redirector.app/Contents/MacOS/mitmproxy redirector";
    const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);

    struct Options {
        redirector: PathBuf,
        socket: PathBuf,
        actions: Vec<String>,
        block_udp_443: bool,
    }

    struct SocketCleanup(PathBuf);

    impl Drop for SocketCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[tokio::main]
    pub async fn run() -> Result<()> {
        let options = parse_options()?;
        validate_options(&options)?;
        remove_stale_socket(&options.socket)?;
        let listener = UnixListener::bind(&options.socket)
            .with_context(|| format!("failed to bind IPC socket {}", options.socket.display()))?;
        let _cleanup = SocketCleanup(options.socket.clone());

        eprintln!("[bridge] IPC socket: {}", options.socket.display());
        eprintln!("[bridge] intercept actions: {:?}", options.actions);
        eprintln!("[bridge] UDP/443 block: {}", options.block_udp_443);
        eprintln!("[bridge] launching: {}", options.redirector.display());

        let mut child = Command::new(&options.redirector)
            .arg(&options.socket)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to launch {}", options.redirector.display()))?;

        let (mut control, _) = timeout(CONTROL_CONNECT_TIMEOUT, listener.accept())
        .await
        .context(
            "timed out waiting for Redirector control channel; approve the System Extension in System Settings and retry",
        )?
        .context("failed to accept Redirector control channel")?;

        send_intercept_config(&mut control, options.actions.clone()).await?;
        eprintln!("[bridge] control channel ready; matching processes are now captured");
        eprintln!("[bridge] press Ctrl-C to stop capture and close the provider control channel");

        tokio::spawn(async move {
            match child.wait().await {
                Ok(status) if status.success() => {
                    eprintln!("[redirector] launcher exited successfully; provider remains active")
                }
                Ok(status) => eprintln!("[redirector] launcher exited with {status}"),
                Err(error) => eprintln!("[redirector] failed while waiting for launcher: {error}"),
            }
        });

        let mut terminate = signal::unix::signal(signal::unix::SignalKind::terminate())
            .context("failed to listen for SIGTERM")?;
        let serve_result: Result<()> = loop {
            tokio::select! {
                result = listener.accept() => {
                    let (stream, _) = match result {
                        Ok(accepted) => accepted,
                        Err(error) => break Err(error).context("failed to accept Redirector flow channel"),
                    };
                    let block_udp_443 = options.block_udp_443;
                    tokio::spawn(async move {
                        match serve_flow(stream, block_udp_443).await {
                            Ok(outcome) => eprintln!("[flow] {}", outcome.describe()),
                            Err(error) => eprintln!("[flow] failed: {error:#}"),
                        }
                    });
                }
                result = signal::ctrl_c() => {
                    if let Err(error) = result {
                        break Err(error).context("failed to listen for Ctrl-C");
                    }
                    eprintln!("[bridge] stopping; closing control channel");
                    break Ok(());
                }
                _ = terminate.recv() => {
                    eprintln!("[bridge] received SIGTERM; closing control channel");
                    break Ok(());
                }
            }
        };

        eprintln!("[bridge] disabling interception before closing control channel");
        if let Err(error) = send_intercept_config(&mut control, Vec::new()).await {
            eprintln!("[bridge] warning: failed to send disabled intercept config: {error:#}");
        } else {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        drop(control);
        tokio::time::sleep(Duration::from_millis(500)).await;
        serve_result
    }

    fn parse_options() -> Result<Options> {
        let mut redirector = PathBuf::from(DEFAULT_REDIRECTOR);
        let mut socket = PathBuf::from(format!(
            "/tmp/taomni-mitmproxy-redirector-{}.sock",
            std::process::id()
        ));
        let mut actions = None;
        let mut block_udp_443 = true;
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--redirector" => {
                    redirector = PathBuf::from(next_value(&mut args, "--redirector")?);
                }
                "--socket" => {
                    socket = PathBuf::from(next_value(&mut args, "--socket")?);
                }
                "--intercept" => {
                    let spec = next_value(&mut args, "--intercept")?;
                    let parsed = spec
                        .split(',')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    if parsed.is_empty() {
                        bail!("--intercept must contain at least one process substring or PID");
                    }
                    actions = Some(parsed);
                }
                "--allow-udp-443" => block_udp_443 = false,
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                unknown => bail!("unknown argument {unknown:?}; run with --help"),
            }
        }

        let actions = actions.ok_or_else(|| {
            anyhow!("--intercept is required so the PoC cannot accidentally enable global capture")
        })?;
        Ok(Options {
            redirector,
            socket,
            actions,
            block_udp_443,
        })
    }

    fn next_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String> {
        args.next()
            .ok_or_else(|| anyhow!("{option} requires a value"))
    }

    fn validate_options(options: &Options) -> Result<()> {
        if !options.redirector.is_file() {
            bail!(
                "Redirector executable does not exist: {}",
                options.redirector.display()
            );
        }
        let socket = options
            .socket
            .to_str()
            .ok_or_else(|| anyhow!("IPC socket path is not valid UTF-8"))?;
        if !socket.starts_with("/tmp/") {
            bail!("Redirector requires --socket to be located directly under /tmp");
        }
        if socket.as_bytes().contains(&0) {
            bail!("IPC socket path contains a NUL byte");
        }
        Ok(())
    }

    fn remove_stale_socket(path: &Path) -> Result<()> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::FileTypeExt;
                    if !metadata.file_type().is_socket() {
                        bail!(
                            "refusing to remove non-socket path before bind: {}",
                            path.display()
                        );
                    }
                }
                std::fs::remove_file(path)
                    .with_context(|| format!("failed to remove stale socket {}", path.display()))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect socket path {}", path.display()));
            }
        }
        Ok(())
    }

    fn print_help() {
        println!(
            "mitmproxy-redirector-poc\n\n\
         Usage:\n  cargo run --bin mitmproxy-redirector-poc -- --intercept <SPEC> [OPTIONS]\n\n\
         Options:\n  --intercept <SPEC>    Comma-separated process path substrings or PIDs (required)\n  \
         --redirector <PATH>  Signed Redirector executable [default: {DEFAULT_REDIRECTOR}]\n  \
         --socket <PATH>      IPC socket directly under /tmp\n  \
         --allow-udp-443      Relay UDP/443 instead of closing it\n  \
         -h, --help           Print help\n"
        );
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn stale_cleanup_refuses_regular_files() {
            let path = std::env::temp_dir().join(format!(
                "taomni-redirector-regular-file-test-{}",
                std::process::id()
            ));
            std::fs::write(&path, b"do not delete").unwrap();

            let error = remove_stale_socket(&path).unwrap_err();
            assert!(error.to_string().contains("refusing to remove non-socket"));
            assert_eq!(std::fs::read(&path).unwrap(), b"do not delete");
            std::fs::remove_file(path).unwrap();
        }
    }
}

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    macos::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("mitmproxy Redirector PoC only runs on macOS");
    std::process::exit(1);
}
