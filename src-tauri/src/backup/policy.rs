use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_MAX_COPIES: u32 = 7;
pub const DEFAULT_FREQUENCY: &str = "weekly";
pub const DEFAULT_SCOPE: &str = "core";
pub const POLICY_FILE_NAME: &str = "backup_policy.json";

fn default_auto_backup() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPolicy {
    /// Whether automatic background rolling backup is enabled.
    #[serde(default = "default_auto_backup")]
    pub auto_backup_enabled: bool,
    /// Backup frequency: "daily" | "weekly" | "on_exit".
    #[serde(default = "default_frequency")]
    pub frequency: String,
    /// User-configured custom backup directory path.
    /// If None or empty, falls back to the system default path (`app_data/backups`).
    #[serde(default)]
    pub custom_backup_dir: Option<String>,
    /// Maximum number of automatic backups to retain (FIFO rolling cleanup, defaults to 7).
    #[serde(default = "default_max_copies")]
    pub max_retained_copies: u32,
    /// Default backup scope: "core" | "full".
    #[serde(default = "default_scope")]
    pub default_scope: String,
    /// Timestamp (ms) of the last successful backup.
    #[serde(default)]
    pub last_backup_at: Option<i64>,
}

fn default_frequency() -> String {
    DEFAULT_FREQUENCY.to_string()
}

fn default_max_copies() -> u32 {
    DEFAULT_MAX_COPIES
}

fn default_scope() -> String {
    DEFAULT_SCOPE.to_string()
}

impl Default for BackupPolicy {
    fn default() -> Self {
        Self {
            auto_backup_enabled: true,
            frequency: default_frequency(),
            custom_backup_dir: None,
            max_retained_copies: default_max_copies(),
            default_scope: default_scope(),
            last_backup_at: None,
        }
    }
}

/// Returns the system default backup directory under `app_data/backups`.
pub fn default_backup_dir(app: &AppHandle) -> PathBuf {
    let app_data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    app_data.join("backups")
}

/// Checks whether a given directory is writable.
fn is_writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let test_file = dir.join(format!(".write_test_{}", uuid::Uuid::new_v4().simple()));
    if std::fs::write(&test_file, b"ok").is_ok() {
        let _ = std::fs::remove_file(test_file);
        true
    } else {
        false
    }
}

/// Resolve the effective backup directory based on the user policy.
///
/// Priority:
/// 1. Custom directory configured by the user (if non-empty and writable).
/// 2. If the custom directory cannot be written (e.g. external disk unmounted),
///    logs a warning and gracefully falls back to the default app data backup dir.
/// 3. Default backup directory under `app_data/backups`.
pub fn resolve_backup_dir(app: &AppHandle, policy: &BackupPolicy) -> PathBuf {
    if let Some(ref custom) = policy.custom_backup_dir {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let custom_path = PathBuf::from(trimmed);
            if is_writable_dir(&custom_path) {
                return custom_path;
            }
            tracing::warn!(
                target: "backup",
                "Configured custom backup directory {:?} is not writable or unavailable, falling back to default.",
                custom_path
            );
        }
    }

    let def = default_backup_dir(app);
    let _ = std::fs::create_dir_all(&def);
    def
}

/// Load the backup policy from disk, or return default if not present or corrupt.
pub fn load_policy(app: &AppHandle) -> BackupPolicy {
    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return BackupPolicy::default(),
    };
    let file_path = app_data.join(POLICY_FILE_NAME);
    if !file_path.exists() {
        return BackupPolicy::default();
    }
    match std::fs::read_to_string(&file_path) {
        Ok(text) => serde_json::from_str::<BackupPolicy>(&text).unwrap_or_default(),
        Err(_) => BackupPolicy::default(),
    }
}

/// Persist the backup policy to disk.
pub fn save_policy(app: &AppHandle, policy: &BackupPolicy) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("create app data dir: {e}"))?;
    let file_path = app_data.join(POLICY_FILE_NAME);
    let json = serde_json::to_string_pretty(policy)
        .map_err(|e| format!("serialize backup policy: {e}"))?;
    std::fs::write(&file_path, json).map_err(|e| format!("save backup policy: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_policy() {
        let policy = BackupPolicy::default();
        assert!(!policy.auto_backup_enabled);
        assert_eq!(policy.frequency, "weekly");
        assert_eq!(policy.max_retained_copies, 7);
        assert_eq!(policy.default_scope, "core");
        assert!(policy.custom_backup_dir.is_none());
    }

    #[test]
    fn test_policy_json_roundtrip() {
        let policy = BackupPolicy {
            auto_backup_enabled: true,
            frequency: "daily".into(),
            custom_backup_dir: Some("/tmp/my_backups".into()),
            max_retained_copies: 10,
            default_scope: "full".into(),
            last_backup_at: Some(1730000000),
        };
        let json = serde_json::to_string(&policy).unwrap();
        let deserialized: BackupPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(policy, deserialized);
    }
}
