//! Dirty-shutdown recovery journal + automated repair helpers.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryPhase {
    Preparing,
    Active,
    Stopping,
    Clean,
}

impl Default for RecoveryPhase {
    fn default() -> Self {
        // Old journals had no phase and were only written after capture became
        // active. Treat them as Active for backward-compatible diagnostics.
        Self::Active
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub platform: String,
    pub capture_backend: String,
    pub config_hash: String,
    pub pid: u32,
    /// When true, the previous run stopped cleanly (journal should be absent).
    pub clean: bool,
    /// Write-ahead lifecycle state. `clean` remains for compatibility with old
    /// journals; a clean journal is removed immediately after it is synced.
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub phase: RecoveryPhase,
    /// Random per-start identifier; never a credential.
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub session_id: String,
    /// Pinned capture runtime version, when the backend has one.
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub backend_version: Option<String>,
    /// Hash of immutable Redirector actions for the session; paths/actions are
    /// deliberately not persisted in the recovery record.
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub scope_hash: Option<String>,
    /// Lifecycle diagnostics only. Recovery never kills these PIDs without
    /// separately verifying process ownership and executable identity.
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub bridge_pid: Option<u32>,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub provider_pid: Option<u32>,
    /// Optional: last relay port (for diagnostics).
    #[serde(default)]
    pub relay_port: Option<u16>,
    /// Optional: helper control port (diagnostics only; token never stored).
    #[serde(default)]
    pub helper_port: Option<u16>,
}

pub fn write_journal(path: &Path, j: &RecoveryJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(j).map_err(|e| e.to_string())?;
    // Atomic-ish replace.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Durable macOS write-ahead journal update. The capture scope must never be
/// installed unless its dirty Preparing record has reached disk first.
#[cfg(target_os = "macos")]
pub fn write_journal_durable(path: &Path, journal: &RecoveryJournal) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let parent = path
        .parent()
        .ok_or_else(|| format!("recovery journal has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn update_phase_durable(path: &Path, phase: RecoveryPhase) -> Result<(), String> {
    let mut journal = read_journal(path).ok_or_else(|| {
        format!(
            "macOS recovery journal is missing or unreadable: {}",
            path.display()
        )
    })?;
    journal.phase = phase;
    journal.clean = matches!(phase, RecoveryPhase::Clean);
    write_journal_durable(path, &journal)
}

pub fn clear_journal(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn read_journal(path: &Path) -> Option<RecoveryJournal> {
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn needs_repair(path: &Path) -> bool {
    match read_journal(path) {
        Some(j) => !j.clean,
        None => path.exists(), // corrupt / unreadable file still needs cleanup
    }
}

/// Mark a clean stop: write clean=true then remove (so crash mid-stop still has a journal).
pub fn mark_clean_and_clear(path: &Path) -> Result<(), String> {
    if let Some(mut j) = read_journal(path) {
        j.clean = true;
        j.phase = RecoveryPhase::Clean;
        #[cfg(target_os = "macos")]
        write_journal_durable(path, &j)?;
        #[cfg(not(target_os = "macos"))]
        let _ = write_journal(path, &j);
    }
    clear_journal(path)?;
    #[cfg(target_os = "macos")]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Journal path under app data sockscap dir.
pub fn journal_path(sockscap_dir: &Path) -> PathBuf {
    sockscap_dir.join("recovery.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("sockscap-recovery-test-{n}"));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn journal_roundtrip() {
        let path = temp_path("recovery.json");
        write_journal(
            &path,
            &RecoveryJournal {
                platform: "test".into(),
                capture_backend: "none".into(),
                config_hash: "abc".into(),
                pid: 1,
                clean: false,
                phase: RecoveryPhase::Active,
                session_id: "session-a".into(),
                backend_version: None,
                scope_hash: None,
                bridge_pid: None,
                provider_pid: None,
                relay_port: Some(1234),
                helper_port: Some(9999),
            },
        )
        .unwrap();
        assert!(needs_repair(&path));
        let j = read_journal(&path).unwrap();
        assert_eq!(j.relay_port, Some(1234));
        clear_journal(&path).unwrap();
        assert!(!needs_repair(&path));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn clean_flag_skips_repair() {
        let path = temp_path("recovery-clean.json");
        write_journal(
            &path,
            &RecoveryJournal {
                platform: "test".into(),
                capture_backend: "windivert".into(),
                config_hash: "x".into(),
                pid: 2,
                clean: true,
                phase: RecoveryPhase::Clean,
                session_id: "session-b".into(),
                backend_version: None,
                scope_hash: None,
                bridge_pid: None,
                provider_pid: None,
                relay_port: None,
                helper_port: None,
            },
        )
        .unwrap();
        assert!(!needs_repair(&path));
        mark_clean_and_clear(&path).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_journal_needs_repair() {
        let path = temp_path("recovery-bad.json");
        std::fs::write(&path, b"not-json{{{").unwrap();
        assert!(needs_repair(&path));
        clear_journal(&path).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
