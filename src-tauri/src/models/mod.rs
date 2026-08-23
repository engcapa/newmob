// Model manifest + downloader.
//
// Bundles the canonical manifest at compile time (resources/models.manifest.json),
// and at runtime tries to fetch a fresher one from https://taomni.app/models.manifest.json
// (best-effort; falls back silently). Each model entry lists 2-3 mirror URLs probed
// in parallel — the first to return 200 wins. Downloads support Range-resume and
// are SHA-256 verified after completion.
//
// Models live under `dirs::cache_dir()/taomni/models/<id>/<filename>`.
// Sidecar binaries live under `.../taomni/binaries/<id>/<filename>`.

pub mod downloader;
pub mod manifest;
pub mod store;

pub use downloader::{DownloadProgress, download_model};
pub use manifest::{ModelKind, ModelManifest, ModelMeta};
pub use store::{model_path, models_root, sidecars_root};

#[tauri::command]
pub async fn models_list() -> Result<Vec<crate::models::manifest::ModelMetaSummary>, String> {
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    Ok(manifest.summaries())
}

#[tauri::command]
pub async fn models_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Emitter;
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let meta = manifest
        .models
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Unknown model id: {id}"))?;

    let target = store::model_path(&id, &meta);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let event_name = format!("model-progress:{id}");
    let app_clone = app.clone();
    download_model(&meta, &target, move |p| {
        let _ = app_clone.emit(&event_name, p);
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn models_delete(id: String) -> Result<(), String> {
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let meta = manifest
        .models
        .get(&id)
        .ok_or_else(|| format!("Unknown model id: {id}"))?;

    let path = store::model_path(&id, meta);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent); // ok if non-empty
    }
    Ok(())
}

#[tauri::command]
pub async fn models_verify(id: String) -> Result<bool, String> {
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let meta = manifest
        .models
        .get(&id)
        .ok_or_else(|| format!("Unknown model id: {id}"))?;

    let path = store::model_path(&id, meta);
    if !path.exists() {
        return Ok(false);
    }
    let placeholder = "0".repeat(64);
    if meta.sha256 == placeholder {
        // Manifest entry is a placeholder — accept presence as "installed"
        // until the real digest is published.
        return Ok(true);
    }
    let digest = downloader::sha256_file(&path).map_err(|e| e.to_string())?;
    Ok(digest.eq_ignore_ascii_case(&meta.sha256))
}

/// Path inside the user cache where the CUDA pack lives once installed.
fn cuda_pack_dir() -> std::path::PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("taomni")
        .join("sidecar-cuda")
}

#[derive(serde::Serialize)]
pub struct CudaPackStatus {
    pub installed: bool,
    pub path: String,
    pub size_mb: u64,
}

/// Status of the on-demand CUDA pack (§11.6).
#[tauri::command]
pub async fn cuda_pack_status() -> Result<CudaPackStatus, String> {
    let dir = cuda_pack_dir();
    let installed = dir.exists();
    let size_mb = if installed {
        let mut total: u64 = 0;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                if let Ok(meta) = e.metadata() {
                    total += meta.len();
                }
            }
        }
        total / (1024 * 1024)
    } else {
        0
    };
    Ok(CudaPackStatus {
        installed,
        path: dir.to_string_lossy().to_string(),
        size_mb,
    })
}

/// Install the optional CUDA pack. Looks up the manifest entry whose id
/// starts with `sidecar_llama_server_cuda_<triple>`; if no such entry is
/// published yet, returns a clear error instructing the user to provide
/// a manual pack path. The pack lands under `<cache>/taomni/sidecar-cuda/`.
#[tauri::command]
pub async fn cuda_pack_install(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let triple = std::env::consts::ARCH.to_string() + "_" + std::env::consts::OS;
    let id = manifest
        .models
        .keys()
        .find(|k| k.starts_with("sidecar_llama_server_cuda") && k.contains(&triple))
        .or_else(|| {
            manifest
                .models
                .keys()
                .find(|k| k.starts_with("sidecar_llama_server_cuda"))
        })
        .cloned()
        .ok_or_else(|| {
            "No CUDA pack published in the manifest yet. Drop a custom build into \
             ~/.cache/taomni/sidecar-cuda/ to enable it manually."
                .to_string()
        })?;

    let meta = manifest
        .models
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Manifest missing entry for {id}"))?;

    let target_dir = cuda_pack_dir();
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target = target_dir.join(&meta.filename);

    let event_name = format!("model-progress:{id}");
    let app_clone = app.clone();
    download_model(&meta, &target, move |p| {
        let _ = app_clone.emit(&event_name, p);
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(target.to_string_lossy().to_string())
}

/// Remove the on-demand CUDA pack from disk. Reverts the user to
/// CPU/Vulkan/Metal (whichever the gpu_detect picks).
#[tauri::command]
pub async fn cuda_pack_uninstall() -> Result<(), String> {
    let dir = cuda_pack_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MirrorPreference {
    Auto,
    Modelscope,
    GhProxy,
    Github,
    Custom,
}

impl Default for MirrorPreference {
    fn default() -> Self {
        Self::Auto
    }
}

/// Persistent mirror preference (§11.4). Stored at
/// `<config_dir>/taomni/mirror.json` so the model downloader can consult it
/// without round-tripping through ai.json.
fn mirror_pref_path() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("taomni")
        .join("mirror.json")
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct MirrorConfig {
    pub preference: String,
    pub custom_base: Option<String>,
}

#[tauri::command]
pub async fn mirror_get_config() -> Result<MirrorConfig, String> {
    let path = mirror_pref_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<MirrorConfig>(&text) {
            return Ok(cfg);
        }
    }
    Ok(MirrorConfig {
        preference: "auto".into(),
        custom_base: None,
    })
}

#[tauri::command]
pub async fn mirror_set_config(config: MirrorConfig) -> Result<(), String> {
    let path = mirror_pref_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}
