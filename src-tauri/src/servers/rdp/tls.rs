//! TLS identity for the RDP server: a self-signed certificate generated with
//! `rcgen` and cached in the app-data directory, loaded via
//! [`ironrdp::server::TlsIdentityCtx`].
//!
//! The cert/key are written once to `<app-data>/rdp-server/{cert,key}.pem` and
//! reused on subsequent starts. `TlsIdentityCtx::init_from_paths` reads PEM by
//! extension, and also extracts the SPKI public key bytes IronRDP needs for the
//! NLA/CredSSP (`with_hybrid`) handshake.
//!
//! Self-signed means clients see a certificate warning; that is the right
//! default for an internal tool (the dev plan calls for real CA certs only when
//! exposing to the public internet, §10/P1).

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use ironrdp::server::TlsIdentityCtx;
use tauri::AppHandle;

/// Locate (creating if needed) the directory holding the RDP server's TLS files.
fn tls_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = crate::resolved_app_data_dir(app)
        .map_err(anyhow::Error::msg)
        .context("resolving app data dir")?
        .join("rdp-server");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

/// Ensure a self-signed cert+key pair exists on disk and return their paths,
/// generating them on first use. Idempotent: existing files are reused.
fn ensure_cert(app: &AppHandle) -> Result<(PathBuf, PathBuf)> {
    let dir = tls_dir(app)?;
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    if cert_path.is_file() && key_path.is_file() {
        return Ok((cert_path, key_path));
    }

    // Subject alternative names: hostname + loopback. RDP clients don't verify
    // self-signed certs strictly, but populating SANs keeps tools that do happier.
    let mut sans = vec!["localhost".to_string()];
    if let Ok(host) = hostname() {
        if !host.is_empty() {
            sans.push(host);
        }
    }

    let certified =
        rcgen::generate_simple_self_signed(sans).context("generating self-signed certificate")?;
    let cert_pem = certified.cert.pem();
    let key_pem = certified.signing_key.serialize_pem();

    write_private(&cert_path, cert_pem.as_bytes()).context("writing cert.pem")?;
    write_private(&key_path, key_pem.as_bytes()).context("writing key.pem")?;

    Ok((cert_path, key_path))
}

/// Build the IronRDP TLS identity context from the cached self-signed cert,
/// generating it on first use.
pub(crate) fn identity(app: &AppHandle) -> Result<TlsIdentityCtx> {
    ensure_crypto_provider();
    let (cert_path, key_path) = ensure_cert(app)?;
    TlsIdentityCtx::init_from_paths(&cert_path, &key_path)
        .context("loading RDP server TLS identity")
}

/// Ensure a process-wide rustls `CryptoProvider` is installed.
///
/// `TlsIdentityCtx::make_acceptor` builds a `rustls::ServerConfig` via the
/// provider-less builder, which panics if no process default is set. Because the
/// dependency tree pulls in *both* `ring` and `aws-lc-rs`, rustls installs no
/// automatic default, so we install `ring` explicitly. Idempotent: a second call
/// (or another subsystem having already installed one) is ignored.
fn ensure_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Write a file with owner-only permissions where the platform supports it
/// (the private key must not be world-readable).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn hostname() -> Result<String> {
    // Cheap, dependency-free: read the kernel hostname on unix, COMPUTERNAME on
    // Windows. Failure is non-fatal (caller falls back to localhost-only SANs).
    #[cfg(unix)]
    {
        let s = std::fs::read_to_string("/proc/sys/kernel/hostname")
            .or_else(|_| std::env::var("HOSTNAME").map_err(std::io::Error::other))?;
        Ok(s.trim().to_string())
    }
    #[cfg(windows)]
    {
        Ok(std::env::var("COMPUTERNAME").unwrap_or_default())
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercise the full rcgen → PEM → `TlsIdentityCtx` → `make_acceptor` path
    /// without needing a Tauri `AppHandle`, writing into a temp dir. This proves
    /// the self-signed material we generate is actually loadable by IronRDP and
    /// usable as a rustls server acceptor (the crux of phase 4).
    #[test]
    fn self_signed_cert_builds_a_tls_acceptor() {
        super::ensure_crypto_provider();
        let dir = std::env::temp_dir().join(format!("rdp-tls-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert_path = dir.join("cert.pem");
        let key_path = dir.join("key.pem");

        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        write_private(&cert_path, certified.cert.pem().as_bytes()).unwrap();
        write_private(&key_path, certified.signing_key.serialize_pem().as_bytes()).unwrap();

        let identity = TlsIdentityCtx::init_from_paths(&cert_path, &key_path)
            .expect("load self-signed identity");
        assert!(!identity.certs.is_empty(), "at least one cert loaded");
        assert!(
            !identity.pub_key.is_empty(),
            "SPKI public key extracted (needed for NLA)"
        );
        identity.make_acceptor().expect("build rustls TlsAcceptor");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
