//! NFS server: supervises the operating system's NFS facility. There is no
//! pure-Rust NFS server here, and exporting a filesystem over NFS requires
//! root privileges plus OS configuration (e.g. `/etc/exports`) that a desktop
//! app cannot safely take over. So this leaf stays honest: it detects the OS
//! NFS tooling and returns clear, actionable setup guidance rather than
//! pretending to run a server it cannot.
//!
//! Server-specific config (`config.extra`):
//!   - `exportDir` (string) the directory the user intends to export (used only
//!                          to make the guidance concrete; default: home dir).

use super::ServerConfig;
use super::engine::{ServerCtx, ServerStarted};

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let _port = if config.port == 0 { 2049 } else { config.port };
    let default_dir = dirs::home_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "/srv/nfs/share".to_string());
    let export_dir = config.str_field("exportDir", &default_dir).to_string();

    #[cfg(target_os = "linux")]
    {
        let has_exportfs = which::which("exportfs").is_ok();
        let has_nfsd =
            which::which("rpc.nfsd").is_ok() || std::path::Path::new("/proc/fs/nfsd").exists();

        if has_exportfs || has_nfsd {
            for line in [
                "NFS export requires root and OS configuration; Taomni cannot start it directly."
                    .to_string(),
                "To export a directory over NFS on Linux:".to_string(),
                format!(
                    "  1. Add to /etc/exports:  {} *(rw,sync,no_subtree_check)",
                    export_dir
                ),
                "  2. Apply exports:        sudo exportfs -ra".to_string(),
                "  3. Ensure the server is running:  sudo systemctl start nfs-server".to_string(),
                "  4. Verify:               showmount -e localhost".to_string(),
            ] {
                ctx.log.line(line);
            }
            return Err(
                "NFS needs root + /etc/exports configuration — see the log for the exact steps."
                    .to_string(),
            );
        }

        return Err(
            "NFS tools not found. Install the NFS server package (e.g. `apt install nfs-kernel-server`) \
             and export a directory via /etc/exports — root is required."
                .to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        for line in [
            "NFS export on macOS requires root and OS configuration; Taomni cannot start it directly.".to_string(),
            "To export a directory over NFS on macOS:".to_string(),
            format!("  1. Add to /etc/exports:  {} -network 0.0.0.0 -mask 0.0.0.0", export_dir),
            "  2. Restart nfsd:          sudo nfsd restart".to_string(),
            "  3. Verify:               showmount -e localhost".to_string(),
        ] {
            ctx.log.line(line);
        }
        return Err(
            "NFS needs root + /etc/exports configuration — see the log for the exact steps."
                .to_string(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        let _ = export_dir;
        for line in [
            "Windows does not ship an NFS server in most editions.",
            "Enable it via: Settings > Optional Features, or 'Services for NFS' on Windows Server,",
            "then configure an NFS share through Server Manager. Taomni cannot start it directly.",
        ] {
            ctx.log.line(line.to_string());
        }
        return Err(
            "NFS server must be enabled and configured through Windows 'Services for NFS'."
                .to_string(),
        );
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (ctx, export_dir);
        Err("NFS server is not supported on this platform".to_string())
    }
}
