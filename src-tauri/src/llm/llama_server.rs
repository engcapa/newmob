// llama-server sidecar manager.
//
// Spawns the locally-installed `llama-server` binary (downloaded via
// models::downloader) as a subprocess, exposes an OpenAI-compatible HTTP
// endpoint at 127.0.0.1:<port>/v1, and watchdogs the process so a crash
// auto-restarts up to MAX_RESTARTS times.

use crate::models::store::sidecars_root;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const MAX_RESTARTS: u32 = 3;
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Sidecar id in the manifest (e.g. `sidecar_llama_server_x86_64_pc_windows_msvc`).
    pub sidecar_id: String,
    /// Path to the GGUF model file passed via -m.
    pub model_path: PathBuf,
    /// 127.0.0.1:port the server should listen on.
    pub port: u16,
    /// Number of GPU layers to offload (0 = CPU). Adjusted by gpu_detect at start.
    pub gpu_layers: u32,
    /// Threads (0 = let llama-server pick).
    pub threads: u32,
    /// Context window size.
    pub ctx_size: u32,
}

impl SidecarConfig {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }
}

pub struct LlamaServer {
    config: SidecarConfig,
    child: Mutex<Option<Child>>,
    restart_count: AtomicU32,
}

impl LlamaServer {
    pub fn new(config: SidecarConfig) -> Self {
        Self {
            config,
            child: Mutex::new(None),
            restart_count: AtomicU32::new(0),
        }
    }

    pub fn config(&self) -> &SidecarConfig {
        &self.config
    }

    /// Resolve the binary path under `<cache>/taomni/binaries/<id>/<filename>`.
    fn binary_path(&self) -> Option<PathBuf> {
        let dir = sidecars_root().join(&self.config.sidecar_id);
        if !dir.exists() {
            return None;
        }
        // The manifest stores the executable as `llama-server` or
        // `llama-server.exe`. Pick whichever exists.
        let candidates = if cfg!(windows) {
            vec!["llama-server.exe"]
        } else {
            vec!["llama-server"]
        };
        for name in candidates {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
        None
    }

    /// Spawn the process if not already running; returns the base URL.
    pub async fn ensure_running(&self) -> Result<String, String> {
        {
            let guard = self.child.lock().await;
            if guard.is_some() {
                return Ok(self.config.base_url());
            }
        }

        if self.restart_count.load(Ordering::SeqCst) >= MAX_RESTARTS {
            return Err(format!(
                "llama-server failed {MAX_RESTARTS} times; refusing to spawn again."
            ));
        }

        let bin = self
            .binary_path()
            .ok_or_else(|| "llama-server binary not installed".to_string())?;

        if !self.config.model_path.exists() {
            return Err(format!(
                "Model file not found: {}",
                self.config.model_path.display()
            ));
        }

        let mut cmd = Command::new(&bin);
        cmd.arg("-m").arg(&self.config.model_path);
        cmd.arg("--port").arg(self.config.port.to_string());
        cmd.arg("--host").arg("127.0.0.1");
        cmd.arg("-c").arg(self.config.ctx_size.to_string());
        if self.config.gpu_layers > 0 {
            cmd.arg("-ngl").arg(self.config.gpu_layers.to_string());
        }
        if self.config.threads > 0 {
            cmd.arg("-t").arg(self.config.threads.to_string());
        }
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        cmd.stdin(Stdio::null());

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn llama-server: {e}"))?;

        *self.child.lock().await = Some(child);
        self.restart_count.fetch_add(1, Ordering::SeqCst);

        // Wait for /health to come up (best effort).
        for _ in 0..30 {
            if self.health_check().await.is_ok() {
                return Ok(self.config.base_url());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err("llama-server did not respond on /health within 15s".into())
    }

    async fn health_check(&self) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{}/health", self.config.port);
        let res = tokio::time::timeout(
            HEALTH_CHECK_TIMEOUT,
            reqwest::Client::new().get(&url).send(),
        )
        .await
        .map_err(|_| "health check timed out".to_string())?
        .map_err(|e| format!("health check error: {e}"))?;

        if res.status().is_success() {
            Ok(())
        } else {
            Err(format!("health HTTP {}", res.status()))
        }
    }

    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut c) = guard.take() {
            let _ = c.kill().await;
        }
    }
}

/// One global sidecar handle per process. Multiple LLM tasks share the same
/// llama-server (its `/v1/chat/completions` endpoint is concurrent-safe).
pub fn shared() -> Arc<tokio::sync::RwLock<Option<Arc<LlamaServer>>>> {
    static INSTANCE: std::sync::OnceLock<Arc<tokio::sync::RwLock<Option<Arc<LlamaServer>>>>> =
        std::sync::OnceLock::new();
    INSTANCE
        .get_or_init(|| Arc::new(tokio::sync::RwLock::new(None)))
        .clone()
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct StartSidecarArgs {
    pub sidecar_id: String,
    pub model_id: String,
    pub port: Option<u16>,
    pub ctx_size: Option<u32>,
    pub gpu_layers: Option<u32>,
    pub threads: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub base_url: Option<String>,
    pub gpu_backend: super::gpu_detect::GpuBackend,
    pub binary_installed: bool,
    pub model_installed: bool,
}

#[tauri::command]
pub async fn sidecar_start(args: StartSidecarArgs) -> Result<String, String> {
    let manifest = crate::models::manifest::load_manifest()?;
    let model_meta = manifest
        .models
        .get(&args.model_id)
        .ok_or_else(|| format!("Unknown model id: {}", args.model_id))?;
    let model_path = crate::models::store::model_path(&args.model_id, model_meta);

    let config = SidecarConfig {
        sidecar_id: args.sidecar_id,
        model_path,
        port: args.port.unwrap_or(8080),
        gpu_layers: args.gpu_layers.unwrap_or(0),
        threads: args.threads.unwrap_or(0),
        ctx_size: args.ctx_size.unwrap_or(4096),
    };

    let server = Arc::new(LlamaServer::new(config));
    let url = server.ensure_running().await?;
    *shared().write().await = Some(server);
    Ok(url)
}

#[tauri::command]
pub async fn sidecar_stop() -> Result<(), String> {
    let handle = shared();
    let mut guard = handle.write().await;
    if let Some(server) = guard.take() {
        server.stop().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sidecar_status() -> Result<SidecarStatus, String> {
    let manifest = crate::models::manifest::load_manifest()?;
    let triple = current_target_triple();
    let sidecar_id = format!("sidecar_llama_server_{}", triple.replace('-', "_"));
    let binary_installed = manifest
        .models
        .get(&sidecar_id)
        .map(|m| crate::models::store::model_path(&sidecar_id, m).exists())
        .unwrap_or(false);

    let handle = shared();
    let guard = handle.read().await;
    let (running, base_url) = match guard.as_ref() {
        Some(s) => (true, Some(s.config().base_url())),
        None => (false, None),
    };
    drop(guard);

    Ok(SidecarStatus {
        running,
        base_url,
        gpu_backend: super::gpu_detect::detect(),
        binary_installed,
        model_installed: false, // determined per-model elsewhere
    })
}

fn current_target_triple() -> &'static str {
    if cfg!(all(target_arch = "x86_64", target_os = "windows")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        "x86_64-apple-darwin"
    } else {
        "unknown"
    }
}
