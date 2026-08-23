//! iperf server: supervises the system `iperf3` (or legacy `iperf`) binary in
//! server mode (`-s`). We cannot reimplement the iperf wire protocol in-process,
//! so we locate and run the external tool via [`process::spawn_supervised`],
//! streaming its output to the frontend log.
//!
//! Server-specific config (`config.extra`):
//!   - none required. The standard `port`/`bindAddress` fields are honored.
//!
//! Note: throughput/bandwidth caps (`-b`) and UDP mode (`-u`) are *client-side*
//! options in iperf; an iperf server accepts whatever the client negotiates, so
//! we log that those settings are ignored here rather than passing them through.

use super::engine::{ServerCtx, ServerStarted};
use super::{ServerConfig, process};

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 5201 } else { config.port };
    let bind = config.bind_address.clone();

    // Pick iperf3 first, fall back to legacy iperf. Surface a clear install
    // hint if neither is present, before we attempt to spawn anything.
    let program = if which::which("iperf3").is_ok() {
        "iperf3"
    } else if which::which("iperf").is_ok() {
        "iperf"
    } else {
        return Err(
            "iperf3 not found in PATH — install iperf3 (e.g. `apt install iperf3`, \
             `brew install iperf3`) to use this server"
                .to_string(),
        );
    };

    // Bind-probe the port so "address already in use" surfaces as a startup
    // Error instead of the supervised process dying a moment later. There is a
    // small TOCTOU window between this probe and iperf binding, which is
    // acceptable for a developer tool.
    if let Err(e) = std::net::TcpListener::bind((bind.as_str(), port)) {
        return Err(format!("cannot bind {}:{} for iperf — {}", bind, port, e));
    }

    let mut args: Vec<String> = vec!["-s".into(), "-p".into(), port.to_string()];
    // Only constrain the bind address when the user asked for something other
    // than "all interfaces"; iperf binds to all by default.
    if !bind.is_empty() && bind != "0.0.0.0" && bind != "::" {
        args.push("-B".into());
        args.push(bind.clone());
    }
    // iperf3 supports --forceflush for line-buffered output; harmless if the
    // legacy iperf rejects it would be a problem, so only add for iperf3.
    if program == "iperf3" {
        args.push("--forceflush".into());
    }

    ctx.log
        .line(format!("starting {} server on {}:{}", program, bind, port));
    ctx.log.line(
        "note: bandwidth limit and UDP mode are client-side options; the server \
         accepts whatever each client negotiates",
    );

    process::spawn_supervised(ctx, program, args).await
}
