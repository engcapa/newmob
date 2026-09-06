use super::crypto::{ERR_BACKUP_PASSWORD_REQUIRED, decrypt_payload, is_encrypted_bytes};
use super::manifest::{BackupManifest, MANIFEST_FILE_NAME, file_sha256};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use zip::ZipArchive;

pub const RESTORE_INTENT_FILE: &str = "restore_intent.json";
pub const PENDING_RESTORE_DIR: &str = ".pending_restore";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRestoreResult {
    pub manifest: BackupManifest,
    pub restart_required: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RestoreIntent {
    staged_at: i64,
    manifest: BackupManifest,
}

/// Extract and read bytes from archive, decrypting if necessary.
fn read_archive_zip_bytes(archive_path: &Path, password: Option<&str>) -> Result<Vec<u8>, String> {
    let mut file = File::open(archive_path)
        .map_err(|e| format!("open archive file {}: {e}", archive_path.display()))?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|e| format!("read archive file: {e}"))?;

    if is_encrypted_bytes(&data) {
        let pw = password.unwrap_or_default().trim();
        if pw.is_empty() {
            return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
        }
        decrypt_payload(&data, pw)
    } else {
        Ok(data)
    }
}

/// Inspect a backup archive and return its manifest without modifying any local state.
pub fn inspect_archive(
    archive_path: &Path,
    password: Option<&str>,
) -> Result<BackupManifest, String> {
    let zip_bytes = read_archive_zip_bytes(archive_path, password)?;
    let mut archive =
        ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("invalid zip archive: {e}"))?;

    let mut manifest_file = archive
        .by_name(MANIFEST_FILE_NAME)
        .map_err(|_| "backup archive is missing manifest.json".to_string())?;

    let mut manifest_bytes = Vec::new();
    manifest_file
        .read_to_end(&mut manifest_bytes)
        .map_err(|e| format!("failed to read manifest.json: {e}"))?;

    BackupManifest::from_json_bytes(&manifest_bytes)
        .map_err(|e| format!("failed to parse manifest.json: {e}"))
}

pub fn stage_restore(
    app: &AppHandle,
    archive_path: &Path,
    password: Option<&str>,
) -> Result<StageRestoreResult, String> {
    let app_data = crate::resolved_app_data_dir(app)?;
    stage_restore_to_dir(&app_data, archive_path, password)
}

/// Stage all files from the archive into `app_data/.pending_restore/`
/// and record `restore_intent.json`.
pub fn stage_restore_to_dir(
    app_data: &Path,
    archive_path: &Path,
    password: Option<&str>,
) -> Result<StageRestoreResult, String> {
    let manifest = inspect_archive(archive_path, password)?;
    let zip_bytes = read_archive_zip_bytes(archive_path, password)?;
    let mut archive =
        ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("invalid zip archive: {e}"))?;

    let pending_dir = app_data.join(PENDING_RESTORE_DIR);
    if pending_dir.exists() {
        let _ = std::fs::remove_dir_all(&pending_dir);
    }
    std::fs::create_dir_all(&pending_dir)
        .map_err(|e| format!("create pending restore directory: {e}"))?;

    // Extract files into pending_dir
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let name = file.name().to_string();

        // Skip directories and manifest
        if file.is_dir() || name == MANIFEST_FILE_NAME {
            continue;
        }

        let out_path = pending_dir.join(&name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create directory {}: {e}", parent.display()))?;
        }

        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("create staged file {}: {e}", out_path.display()))?;
        std::io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("extract file to {}: {e}", out_path.display()))?;
    }

    // Verify file checksums
    for entry in &manifest.files {
        let staged_file_path = pending_dir.join(&entry.path);
        if !staged_file_path.is_file() {
            let _ = std::fs::remove_dir_all(&pending_dir);
            return Err(format!(
                "Staged archive missing expected file: {}",
                entry.path
            ));
        }
        let actual_hash = file_sha256(&staged_file_path)
            .map_err(|e| format!("compute hash for {}: {e}", entry.path))?;
        if actual_hash != entry.sha256 {
            let _ = std::fs::remove_dir_all(&pending_dir);
            return Err(format!(
                "Checksum mismatch for file {}: expected {}, got {}",
                entry.path, entry.sha256, actual_hash
            ));
        }
    }

    // Write restore_intent.json
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let intent = RestoreIntent {
        staged_at: now_ms,
        manifest: manifest.clone(),
    };
    let intent_json = serde_json::to_string_pretty(&intent)
        .map_err(|e| format!("serialize restore intent: {e}"))?;

    let intent_path = app_data.join(RESTORE_INTENT_FILE);
    std::fs::write(&intent_path, intent_json)
        .map_err(|e| format!("write restore intent file: {e}"))?;

    Ok(StageRestoreResult {
        manifest,
        restart_required: true,
        message:
            "Backup verified and staged successfully. Restart application to complete restore."
                .into(),
    })
}

/// Helper to remove WAL / SHM auxiliary files alongside a database file.
fn remove_wal_shm(db_path: &Path) {
    let wal = db_path.with_extension("db-wal");
    let shm = db_path.with_extension("db-shm");
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(shm);

    let sqlite_wal = PathBuf::from(format!("{}-wal", db_path.display()));
    let sqlite_shm = PathBuf::from(format!("{}-shm", db_path.display()));
    let _ = std::fs::remove_file(sqlite_wal);
    let _ = std::fs::remove_file(sqlite_shm);
}

/// Safely copy or replace a file from `src` to `dst`, creating parent directory if needed.
fn replace_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if dst.exists() {
        let _ = std::fs::remove_file(dst);
    }
    std::fs::copy(src, dst)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))?;
    Ok(())
}

/// Invoked at app launch in `lib.rs` setup, BEFORE any SQLite connections are opened.
///
/// If `restore_intent.json` and `.pending_restore/` exist:
/// 1. Backs up current files to `app_data/backups/pre_restore_safety_copy/`.
/// 2. Overwrites databases and configuration files.
/// 3. Cleans up `.pending_restore/` and removes `restore_intent.json`.
pub fn apply_pending_restore(app_data: &Path) {
    let intent_path = app_data.join(RESTORE_INTENT_FILE);
    let pending_dir = app_data.join(PENDING_RESTORE_DIR);

    if !intent_path.is_file() || !pending_dir.is_dir() {
        return;
    }

    tracing::info!(target: "backup", "Detected pending backup restore intent, applying...");

    // 1. Make a safety rollback copy of existing database files
    let safety_dir = app_data.join("backups").join("pre_restore_safety_copy");
    let _ = std::fs::create_dir_all(&safety_dir);
    for db_name in &["taomni.db", "notes.db", "vault.db", "lanchat.sqlite"] {
        let curr = app_data.join(db_name);
        if curr.is_file() {
            let _ = std::fs::copy(&curr, safety_dir.join(db_name));
        }
    }

    // 2. Overwrite databases
    let staged_taomni = pending_dir.join("databases").join("taomni.db");
    if staged_taomni.is_file() {
        let dest = app_data.join("taomni.db");
        remove_wal_shm(&dest);
        let _ = replace_file(&staged_taomni, &dest);
    }

    let staged_notes = pending_dir.join("databases").join("notes.db");
    if staged_notes.is_file() {
        let dest = app_data.join("notes.db");
        remove_wal_shm(&dest);
        let _ = replace_file(&staged_notes, &dest);
    }

    let staged_vault = pending_dir.join("databases").join("vault.db");
    if staged_vault.is_file() {
        let dest = app_data.join("vault.db");
        remove_wal_shm(&dest);
        let _ = replace_file(&staged_vault, &dest);
    }

    let staged_lanchat = pending_dir.join("databases").join("lanchat.sqlite");
    if staged_lanchat.is_file() {
        let dest = app_data.join("lanchat.sqlite");
        remove_wal_shm(&dest);
        let _ = replace_file(&staged_lanchat, &dest);
    }

    // 3. Overwrite config files
    let staged_configs = pending_dir.join("configs");
    if staged_configs.is_dir() {
        if let Some(cfg_base) = dirs::config_dir() {
            let taomni_cfg_dir = cfg_base.join("taomni");
            let _ = std::fs::create_dir_all(&taomni_cfg_dir);
            for cfg_name in &["ai.json", "proxy.json", "mirror.json", "sdk.json"] {
                let staged_cfg = staged_configs.join(cfg_name);
                if staged_cfg.is_file() {
                    let _ = replace_file(&staged_cfg, &taomni_cfg_dir.join(cfg_name));
                }
            }
        }
        let staged_tunnels = staged_configs.join("tunnels.json");
        if staged_tunnels.is_file() {
            let _ = replace_file(&staged_tunnels, &app_data.join("tunnels.json"));
        }
    }

    // 4. Overwrite mail-cache
    let staged_mail = pending_dir.join("mail-cache");
    if staged_mail.is_dir() {
        let mail_dest = app_data.join("mail-cache");
        let _ = std::fs::create_dir_all(&mail_dest);
        if let Ok(entries) = std::fs::read_dir(&staged_mail) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(file_name) = path.file_name() {
                        let _ = replace_file(&path, &mail_dest.join(file_name));
                    }
                }
            }
        }
    }

    // 5. Overwrite server certs
    let staged_servers = pending_dir.join("servers");
    if staged_servers.is_dir() {
        let ssh_dest = app_data.join("ssh-server");
        let staged_ssh = staged_servers.join("ssh_host_ed25519");
        if staged_ssh.is_file() {
            let _ = replace_file(&staged_ssh, &ssh_dest.join("host_ed25519"));
        }
        let rdp_dest = app_data.join("rdp-server");
        let staged_cert = staged_servers.join("rdp_cert.pem");
        if staged_cert.is_file() {
            let _ = replace_file(&staged_cert, &rdp_dest.join("cert.pem"));
        }
        let staged_key = staged_servers.join("rdp_key.pem");
        if staged_key.is_file() {
            let _ = replace_file(&staged_key, &rdp_dest.join("key.pem"));
        }
    }

    // 6. Clean up pending staging and intent file
    let _ = std::fs::remove_dir_all(&pending_dir);
    let _ = std::fs::remove_file(&intent_path);

    tracing::info!(target: "backup", "Pending backup restore successfully applied!");
}
