use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

pub const MANIFEST_FORMAT_VERSION: u32 = 1;
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileEntry {
    /// Relative path within the archive, e.g. "databases/taomni.db" or "configs/ai.json"
    pub path: String,
    /// Hex-encoded SHA-256 digest of the file content
    pub sha256: String,
    /// Uncompressed size in bytes
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format_version: u32,
    pub app_name: String,
    pub app_version: String,
    pub created_at: i64,
    pub backup_scope: String,
    pub encrypted: bool,
    pub files: Vec<BackupFileEntry>,
}

impl BackupManifest {
    pub fn new(app_version: String, backup_scope: String, encrypted: bool) -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Self {
            format_version: MANIFEST_FORMAT_VERSION,
            app_name: "Taomni".into(),
            app_version,
            created_at: now_ms,
            backup_scope,
            encrypted,
            files: Vec::new(),
        }
    }

    pub fn add_file(&mut self, path: String, sha256: String, size_bytes: u64) {
        self.files.push(BackupFileEntry {
            path,
            sha256,
            size_bytes,
        });
    }

    pub fn to_json_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec_pretty(self)
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }
}

/// Compute SHA-256 hex string for a given file on disk.
pub fn file_sha256(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Compute SHA-256 hex string for raw bytes in memory.
pub fn bytes_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}
