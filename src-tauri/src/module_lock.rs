//! Cross-process ownership locks for runtime modules that cannot safely run in
//! two Taomni processes at once.
//!
//! Lock files are stable and never deleted: ownership is the OS lock held on
//! the open file handle, not the file's existence. Dropping [`ModuleLock`]
//! releases ownership automatically, including when the process exits.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::AppHandle;

const LOCK_DIR: &str = "module-locks";

#[derive(Debug)]
pub struct ModuleLock {
    file: File,
    #[cfg_attr(not(test), allow(dead_code))]
    path: PathBuf,
}

impl ModuleLock {
    pub fn try_acquire_for_app(
        app: &AppHandle,
        scope: &str,
        resource: &str,
        label: &str,
    ) -> Result<Self, String> {
        let app_data = crate::resolved_app_data_dir(app)
            .map_err(|error| format!("resolve app data directory for {label}: {error}"))?;
        Self::try_acquire(&app_data, scope, resource, label)
    }

    pub fn try_acquire(
        app_data_dir: &Path,
        scope: &str,
        resource: &str,
        label: &str,
    ) -> Result<Self, String> {
        let lock_dir = app_data_dir.join(LOCK_DIR);
        std::fs::create_dir_all(&lock_dir)
            .map_err(|error| format!("create module lock directory: {error}"))?;
        let path = lock_path(&lock_dir, scope, resource);
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| format!("open {label} lock: {error}"))?;

        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                let owner = read_owner(&mut file);
                let owner = if owner.is_empty() {
                    "another Taomni process".to_string()
                } else {
                    owner
                };
                return Err(format!("{label} is already active in {owner}"));
            }
            Err(TryLockError::Error(error)) => {
                return Err(format!("acquire {label} lock: {error}"));
            }
        }

        if let Err(error) = write_owner(&mut file, label) {
            let _ = file.unlock();
            return Err(format!("write {label} lock owner: {error}"));
        }
        Ok(Self { file, path })
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ModuleLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn lock_path(lock_dir: &Path, scope: &str, resource: &str) -> PathBuf {
    let digest = Sha256::digest(format!("{scope}\0{resource}").as_bytes());
    let readable_scope: String = scope
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .take(32)
        .collect();
    lock_dir.join(format!(
        "{readable_scope}-{}.lock",
        &hex::encode(digest)[..24]
    ))
}

fn read_owner(file: &mut File) -> String {
    let _ = file.seek(SeekFrom::Start(0));
    let mut owner = String::new();
    if file.read_to_string(&mut owner).is_err() {
        return String::new();
    }
    owner.lines().next().unwrap_or_default().trim().to_string()
}

fn write_owner(file: &mut File, label: &str) -> std::io::Result<()> {
    let safe_label = label.replace(['\r', '\n'], " ");
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    writeln!(file, "Taomni pid {} ({safe_label})", std::process::id())?;
    file.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_resource_is_exclusive_until_guard_drops() {
        let dir = tempfile::tempdir().unwrap();
        let first = ModuleLock::try_acquire(dir.path(), "sockscap", "global", "SocksCap")
            .expect("first lock");
        let error = ModuleLock::try_acquire(dir.path(), "sockscap", "global", "SocksCap")
            .expect_err("second lock must be rejected");
        assert!(error.contains("already active"));

        let path = first.path().to_path_buf();
        drop(first);
        let reacquired =
            ModuleLock::try_acquire(dir.path(), "sockscap", "global", "SocksCap").unwrap();
        assert_eq!(reacquired.path(), path);
    }

    #[test]
    fn different_resources_do_not_contend() {
        let dir = tempfile::tempdir().unwrap();
        let _first = ModuleLock::try_acquire(dir.path(), "tunnel", "one", "Tunnel one").unwrap();
        let _second = ModuleLock::try_acquire(dir.path(), "tunnel", "two", "Tunnel two").unwrap();
    }
}
