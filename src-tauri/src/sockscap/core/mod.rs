//! xray-core sidecar lifecycle for SocksCap upstreams.
//!
//! A core-backed upstream (shadowsocks / trojan / vmess / vless / wireguard) is
//! realized by spawning a bundled `xray` process with a generated config
//! ([`config_gen`]): one loopback SOCKS inbound + one protocol outbound. The
//! relay dials the local SOCKS port through the existing `egress::socks5`
//! dialer, so no protocol/crypto code lives in taomni.
//!
//! Lifecycle mirrors [`crate::sockscap::egress::ssh_pool::SshPool`] (a stateful
//! upstream held on the orchestrator) and the elevated-helper teardown
//! discipline: processes are killed on `shutdown`, on `Drop`, and — as a
//! backstop for a hard parent exit — via `kill_on_drop(true)` on the tokio
//! child. The manager also exposes a synchronous [`XrayManager::shutdown_all`]
//! for the `RunEvent::Exit` hook so a normal quit never leaks an xray process.

pub mod config_gen;
pub mod share_link;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub use config_gen::ResolvedCoreUpstream;

/// How long to wait for the spawned core's SOCKS inbound to accept connections.
const CORE_READY_TIMEOUT: Duration = Duration::from_secs(8);
const CORE_READY_POLL: Duration = Duration::from_millis(100);

/// A single running xray-core process serving one upstream's local SOCKS port.
pub struct XrayCore {
    child: Child,
    /// Loopback SOCKS port the relay dials.
    pub local_port: u16,
    /// Hash of the outbound spec — lets the manager reuse an unchanged core.
    pub config_hash: String,
    /// Temp config file, removed on shutdown/Drop.
    config_file: PathBuf,
}

impl std::fmt::Debug for XrayCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XrayCore")
            .field("local_port", &self.local_port)
            .field("config_hash", &self.config_hash)
            .field("pid", &self.child.id())
            .finish()
    }
}

impl XrayCore {
    /// Spawn xray-core for `spec`, writing config into `work_dir` and returning
    /// once the loopback SOCKS inbound is accepting connections.
    pub async fn spawn(
        exe: &Path,
        work_dir: &Path,
        spec: &ResolvedCoreUpstream,
        config_hash: String,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(work_dir)
            .map_err(|e| format!("create xray work dir: {e}"))?;

        let local_port = pick_free_loopback_port()?;
        let config = spec.to_xray_config(local_port)?;
        let json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("serialize xray config: {e}"))?;

        // Unique per (port, hash) so concurrent profiles don't collide.
        let config_file = work_dir.join(format!("xray-{local_port}-{config_hash}.json"));
        std::fs::write(&config_file, json.as_bytes())
            .map_err(|e| format!("write xray config: {e}"))?;

        let mut cmd = Command::new(exe);
        cmd.arg("run")
            .arg("-c")
            .arg(&config_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Backstop: if taomni dies without calling shutdown, tokio's reaper
            // kills the child on drop rather than leaking it.
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn xray ({}): {e}", exe.display()))?;

        let mut core = Self {
            child,
            local_port,
            config_hash,
            config_file,
        };

        if let Err(e) = core.wait_until_ready().await {
            // Ensure we don't leave a half-started process or its config behind.
            core.shutdown().await;
            return Err(e);
        }
        Ok(core)
    }

    async fn wait_until_ready(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + CORE_READY_TIMEOUT;
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], self.local_port));
        loop {
            // Fail fast if the process already exited (bad config, missing lib).
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!("xray exited early ({status}); check config/protocol params"));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("xray wait: {e}")),
            }
            if tokio::time::timeout(
                Duration::from_millis(300),
                tokio::net::TcpStream::connect(addr),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .is_some()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "xray SOCKS inbound 127.0.0.1:{} not ready after {}s",
                    self.local_port,
                    CORE_READY_TIMEOUT.as_secs()
                ));
            }
            tokio::time::sleep(CORE_READY_POLL).await;
        }
    }

    /// Kill the process (awaits reaping) and remove the temp config.
    pub async fn shutdown(&mut self) {
        if let Err(e) = self.child.start_kill() {
            tracing::warn!("xray core kill (port {}): {e}", self.local_port);
        }
        let _ = self.child.wait().await;
        let _ = std::fs::remove_file(&self.config_file);
    }

    /// Best-effort synchronous kill for the app-exit hook (no async runtime
    /// guaranteed at `RunEvent::Exit`). Does not reap; the OS cleans up on quit.
    pub fn start_kill_blocking(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_file(&self.config_file);
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }
}

/// Stable hash of the outbound-relevant parts of a spec, so the manager can
/// tell whether a profile's core needs restarting on config change. Excludes
/// the local port (assigned per spawn).
pub fn spec_config_hash(spec: &ResolvedCoreUpstream) -> String {
    let mut h = Sha256::new();
    h.update(spec.kind.as_tag().as_bytes());
    h.update([0]);
    h.update(spec.host.as_bytes());
    h.update(spec.port.to_be_bytes());
    h.update(spec.secret.as_bytes());
    h.update(spec.uuid.as_bytes());
    h.update(spec.private_key.as_bytes());
    h.update(spec.pre_shared_key.as_bytes());
    // params: serialize deterministically.
    if let Ok(pj) = serde_json::to_vec(&spec.params) {
        h.update(&pj);
    }
    hex::encode(&h.finalize()[..12])
}

/// Manages one xray-core process per active core-backed profile.
///
/// Held on [`crate::sockscap::SocksCapRuntime`] alongside the elevated helper.
/// Keyed by profile id so multiple profiles with different nodes run
/// side-by-side, exactly like the per-profile `ssh_pool` entries.
pub struct XrayManager {
    inner: Mutex<HashMap<String, XrayCore>>,
    /// xray executable (resolved once at construction; None = not provisioned).
    exe: Option<PathBuf>,
    work_dir: PathBuf,
}

impl XrayManager {
    pub fn new(exe: Option<PathBuf>, work_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            exe,
            work_dir,
        }
    }

    pub fn has_exe(&self) -> bool {
        self.exe.is_some()
    }

    /// Ensure a core is running for `profile_id` matching `spec`, returning its
    /// local SOCKS port. Reuses an existing core when the spec is unchanged;
    /// otherwise (re)spawns. Non-core kinds are rejected.
    pub async fn ensure(
        &self,
        profile_id: &str,
        spec: &ResolvedCoreUpstream,
    ) -> Result<u16, String> {
        if !spec.kind.requires_core() {
            return Err(format!("{} is not core-backed", spec.kind.as_tag()));
        }
        let exe = self
            .exe
            .as_ref()
            .ok_or_else(|| "xray-core binary not found (run scripts/fetch-xray.ps1)".to_string())?;
        let want_hash = spec_config_hash(spec);

        let mut guard = self.inner.lock().await;
        if let Some(existing) = guard.get(profile_id) {
            if existing.config_hash == want_hash {
                return Ok(existing.local_port);
            }
        }
        // Spec changed (or first spawn): tear down any stale core first.
        if let Some(mut old) = guard.remove(profile_id) {
            old.shutdown().await;
        }
        let core = XrayCore::spawn(exe, &self.work_dir, spec, want_hash).await?;
        let port = core.local_port;
        guard.insert(profile_id.to_string(), core);
        Ok(port)
    }

    /// Local SOCKS port for a running profile core, if any.
    pub async fn local_port(&self, profile_id: &str) -> Option<u16> {
        self.inner
            .lock()
            .await
            .get(profile_id)
            .map(|c| c.local_port)
    }

    /// Stop and remove one profile's core.
    pub async fn remove(&self, profile_id: &str) {
        let core = self.inner.lock().await.remove(profile_id);
        if let Some(mut core) = core {
            core.shutdown().await;
        }
    }

    /// Stop and remove every running core (async teardown path).
    pub async fn shutdown_all(&self) {
        let mut guard = self.inner.lock().await;
        for (_, mut core) in guard.drain() {
            core.shutdown().await;
        }
    }

    /// Synchronous best-effort kill of all cores for the app-exit hook.
    pub fn shutdown_all_blocking(&self) {
        if let Ok(mut guard) = self.inner.try_lock() {
            for (_, mut core) in guard.drain() {
                core.start_kill_blocking();
            }
        }
    }

    pub async fn running_count(&self) -> usize {
        self.inner.lock().await.len()
    }

    /// OS PIDs of all running cores. The capture layer must bypass these so the
    /// xray→node connection is not itself re-captured into an infinite loop.
    pub async fn pids(&self) -> Vec<u32> {
        self.inner
            .lock()
            .await
            .values()
            .filter_map(|c| c.pid())
            .collect()
    }
}

/// Pick a free loopback TCP port for a core's SOCKS inbound.
///
/// Small TOCTOU window (port could be taken before xray binds), acceptable and
/// matches the elevated helper's `pick_free_port`.
fn pick_free_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("pick free port: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::config::{UpstreamKind, UpstreamParams};

    fn ss_spec() -> ResolvedCoreUpstream {
        ResolvedCoreUpstream {
            kind: UpstreamKind::Shadowsocks,
            host: "1.2.3.4".into(),
            port: 8388,
            secret: "pw".into(),
            uuid: String::new(),
            private_key: String::new(),
            pre_shared_key: String::new(),
            params: UpstreamParams::default(),
        }
    }

    #[test]
    fn config_hash_is_stable_and_port_independent() {
        let spec = ss_spec();
        let a = spec_config_hash(&spec);
        let b = spec_config_hash(&spec);
        assert_eq!(a, b, "same spec → same hash");
        // Hash feeds reuse detection, so config changes must change it.
        let mut changed = spec.clone();
        changed.secret = "different".into();
        assert_ne!(a, spec_config_hash(&changed));
    }

    #[tokio::test]
    async fn ensure_rejects_non_core_kind() {
        let mgr = XrayManager::new(None, std::env::temp_dir().join("xray-test"));
        let mut spec = ss_spec();
        spec.kind = UpstreamKind::Socks5;
        assert!(mgr.ensure("p", &spec).await.is_err());
    }

    #[tokio::test]
    async fn ensure_without_exe_errors_clearly() {
        let mgr = XrayManager::new(None, std::env::temp_dir().join("xray-test"));
        let err = mgr.ensure("p", &ss_spec()).await.unwrap_err();
        assert!(err.contains("xray-core binary not found"));
    }
}
