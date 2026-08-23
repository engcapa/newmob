//! VNC server: supervises a system VNC daemon. A VNC server must capture the
//! real desktop framebuffer, which we cannot do in pure Rust, so this leaf
//! locates and runs the platform's VNC tool via [`process::spawn_supervised`].
//!
//! Server-specific config (`config.extra`):
//!   - `password`       (string)  optional VNC password (Linux x11vnc only)
//!   - `viewOnly`       (bool)    disallow client input (default false)
//!   - `sharedDesktop`  (bool)    allow multiple simultaneous clients (default true)
//!
//! Platform support:
//!   - Linux:   x11vnc (must be installed; needs a running X display)
//!   - macOS:   built-in Screen Sharing is not CLI-startable — we return clear
//!              guidance instead of pretending to start.
//!   - Windows: tvnserver / winvnc if installed, otherwise guidance.

use super::ServerConfig;
use super::engine::{ServerCtx, ServerStarted};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use super::process;

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 5900 } else { config.port };
    let _ = &config; // used per-platform below

    #[cfg(target_os = "linux")]
    {
        start_linux(ctx, config, port).await
    }

    #[cfg(target_os = "macos")]
    {
        start_macos(ctx, port).await
    }

    #[cfg(target_os = "windows")]
    {
        start_windows(ctx, config, port).await
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (ctx, port);
        Err("VNC server is not supported on this platform".to_string())
    }
}

#[cfg(target_os = "linux")]
async fn start_linux(
    ctx: ServerCtx,
    config: ServerConfig,
    port: u16,
) -> Result<ServerStarted, String> {
    if which::which("x11vnc").is_err() {
        return Err(
            "x11vnc not found in PATH — install it to share this desktop over VNC \
             (e.g. `apt install x11vnc`). x11vnc also requires a running X display."
                .to_string(),
        );
    }

    let view_only = config.bool_field("viewOnly", false);
    let shared = config.bool_field("sharedDesktop", true);
    let password = config.str_field("password", "").to_string();
    let bind = config.bind_address.clone();

    let mut args: Vec<String> = vec![
        "-rfbport".into(),
        port.to_string(),
        // Keep serving after the first client disconnects.
        "-forever".into(),
    ];
    // Restrict the listening interface when the user picked a specific address.
    if !bind.is_empty() && bind != "0.0.0.0" && bind != "::" {
        args.push("-listen".into());
        args.push(bind.clone());
    }
    if shared {
        args.push("-shared".into());
    }
    if view_only {
        args.push("-viewonly".into());
    }
    if !password.is_empty() {
        // `-passwd` sets a plaintext runtime password (not stored to disk).
        args.push("-passwd".into());
        args.push(password);
    } else {
        // No password configured: x11vnc refuses some setups without this, and
        // it makes the "no auth" decision explicit rather than accidental.
        args.push("-nopw".into());
        ctx.log
            .line("WARNING: starting x11vnc with no password — anyone who can reach this port can view/control the desktop");
    }

    ctx.log
        .line(format!("starting x11vnc on {}:{}", bind, port));
    process::spawn_supervised(ctx, "x11vnc", args).await
}

#[cfg(target_os = "macos")]
async fn start_macos(ctx: ServerCtx, port: u16) -> Result<ServerStarted, String> {
    // The built-in ARDAgent / Screen Sharing service cannot be started from the
    // CLI in a way we can supervise. Be honest about it.
    let _ = port;
    let msg = "macOS VNC must be enabled via System Settings > General > Sharing > \
               Screen Sharing (or Remote Management). Taomni cannot start it for you.";
    ctx.log.line(msg);
    Err(msg.to_string())
}

#[cfg(target_os = "windows")]
async fn start_windows(
    ctx: ServerCtx,
    config: ServerConfig,
    port: u16,
) -> Result<ServerStarted, String> {
    let _ = &config;
    // Try common standalone VNC servers that expose a CLI.
    let program = if which::which("winvnc").is_ok() {
        "winvnc"
    } else if which::which("tvnserver").is_ok() {
        "tvnserver"
    } else {
        return Err(
            "No VNC server found in PATH. Install a VNC server such as TightVNC \
             (tvnserver) or UltraVNC (winvnc), or enable it via its own settings."
                .to_string(),
        );
    };

    // tvnserver runs as a foreground app with -run; winvnc launches its tray app.
    let args: Vec<String> = match program {
        "tvnserver" => vec!["-run".into()],
        _ => Vec::new(),
    };
    ctx.log.line(format!(
        "starting {} (VNC) — listening port is configured in the server's own settings \
         (requested {}:{})",
        program, config.bind_address, port
    ));
    process::spawn_supervised(ctx, program, args).await
}
