//! One-time on-disk migration from the legacy `Taomni` identity to `Taomni`.
//!
//! The app was renamed NewMob → Taomni. That rename moves three on-disk roots:
//!   1. The Tauri app-data dir, which is derived from the bundle identifier
//!      (`com.newmob.app` → `com.taomni.app`). It holds `*.db` + `vault.db`.
//!   2. `<config_dir>/newmob` → `<config_dir>/taomni` (ai.json, mirror.json, …).
//!   3. `<cache_dir>/newmob` → `<cache_dir>/taomni` (models, sidecars, perf log).
//!
//! Plus the primary DB file rename `newmob.db` → `taomni.db` inside the
//! app-data dir. All steps are best-effort and idempotent: once the new
//! location exists we never touch the old one again, so a user who downgrades
//! and re-upgrades won't lose data. Failures are logged, not fatal — a fresh
//! install simply has nothing to migrate.

use std::path::{Path, PathBuf};

/// Legacy Tauri bundle identifier (pre-rename).
const LEGACY_IDENTIFIER: &str = "com.newmob.app";
/// Legacy hardcoded config/cache directory name.
const LEGACY_DIR_NAME: &str = "newmob";
/// New hardcoded config/cache directory name.
const NEW_DIR_NAME: &str = "taomni";
/// Legacy primary database filename.
const LEGACY_DB_NAME: &str = "newmob.db";
/// New primary database filename.
const NEW_DB_NAME: &str = "taomni.db";

/// Run all migrations. Call once at startup, before the app-data dir is
/// created or the database is opened.
pub fn run(new_app_data: &Path) {
    migrate_app_data_dir(new_app_data);
    migrate_db_file(new_app_data);
    if std::env::var_os("NEWMOB_DATA_DIR").is_some() {
        return;
    }
    migrate_named_dir(dirs::config_dir());
    migrate_named_dir(dirs::cache_dir());
}

/// Move the legacy identifier-derived app-data dir to the new one.
///
/// The legacy dir is the sibling of `new_app_data` named after the old bundle
/// identifier. We only migrate when the new dir does not yet exist (or is
/// empty) and the legacy dir is present.
fn migrate_app_data_dir(new_app_data: &Path) {
    let Some(parent) = new_app_data.parent() else {
        return;
    };
    let legacy = parent.join(LEGACY_IDENTIFIER);
    if legacy == new_app_data || !legacy.is_dir() {
        return;
    }
    if dir_has_entries(new_app_data) {
        // New location already populated — never overwrite it.
        return;
    }
    move_tree(&legacy, new_app_data, "app-data dir");
}

/// Rename the primary DB file `newmob.db` → `taomni.db` inside the (already
/// migrated) app-data dir, if the new name isn't there yet.
fn migrate_db_file(new_app_data: &Path) {
    let new_db = new_app_data.join(NEW_DB_NAME);
    let legacy_db = new_app_data.join(LEGACY_DB_NAME);
    if new_db.exists() || !legacy_db.exists() {
        return;
    }
    if let Err(e) = std::fs::rename(&legacy_db, &new_db) {
        tracing::warn!(?e, "failed to rename {LEGACY_DB_NAME} -> {NEW_DB_NAME}");
    } else {
        tracing::info!("migrated {LEGACY_DB_NAME} -> {NEW_DB_NAME}");
    }
}

/// Migrate `<base>/newmob` → `<base>/taomni` for a config or cache base dir.
fn migrate_named_dir(base: Option<PathBuf>) {
    let Some(base) = base else { return };
    let legacy = base.join(LEGACY_DIR_NAME);
    let new = base.join(NEW_DIR_NAME);
    if !legacy.is_dir() || dir_has_entries(&new) {
        return;
    }
    move_tree(&legacy, &new, "named dir");
}

/// True if `path` exists and contains at least one entry.
fn dir_has_entries(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

/// Move `from` to `to`. Tries a fast rename first; on failure (e.g. across
/// filesystems) falls back to a recursive copy and leaves the original in
/// place so nothing is lost.
fn move_tree(from: &Path, to: &Path, label: &str) {
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(from, to) {
        Ok(()) => {
            tracing::info!("migrated {label}: {} -> {}", from.display(), to.display());
        }
        Err(_) => match copy_tree(from, to) {
            Ok(()) => tracing::info!(
                "migrated {label} (copy): {} -> {}",
                from.display(),
                to.display()
            ),
            Err(e) => tracing::warn!(?e, "failed to migrate {label} from {}", from.display()),
        },
    }
}

/// Recursively copy a directory tree.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn migrates_app_data_dir_and_renames_db() {
        let tmp = std::env::temp_dir().join(format!("taomni-mig-{}", uuid::Uuid::new_v4()));
        let legacy = tmp.join(LEGACY_IDENTIFIER);
        let new = tmp.join("com.taomni.app");
        write(&legacy.join(LEGACY_DB_NAME), "db");
        write(&legacy.join("vault.db"), "vault");

        migrate_app_data_dir(&new);
        migrate_db_file(&new);

        // Old dir moved, db renamed, vault preserved.
        assert!(new.join(NEW_DB_NAME).exists());
        assert!(new.join("vault.db").exists());
        assert!(!new.join(LEGACY_DB_NAME).exists());
        assert!(!legacy.exists());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn does_not_clobber_existing_new_dir() {
        let tmp = std::env::temp_dir().join(format!("taomni-mig-{}", uuid::Uuid::new_v4()));
        let legacy = tmp.join(LEGACY_IDENTIFIER);
        let new = tmp.join("com.taomni.app");
        write(&legacy.join(NEW_DB_NAME), "old-data");
        write(&new.join(NEW_DB_NAME), "current-data");

        migrate_app_data_dir(&new);

        // New dir already populated → legacy left untouched, new data intact.
        assert_eq!(
            std::fs::read_to_string(new.join(NEW_DB_NAME)).unwrap(),
            "current-data"
        );
        assert!(legacy.exists());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
