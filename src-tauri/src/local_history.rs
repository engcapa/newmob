//! Local History for Code Workspace: content-addressed snapshots with SQLite metadata.
//!
//! Snapshots are taken before buffer saves / bulk replacements so users can recover
//! earlier versions without Git. Content is stored under `app_data/local-history/blobs`
//! keyed by SHA-256; metadata lives in `app_data/local-history/history.db`.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const MAX_VERSIONS_PER_FILE: i64 = 50;
const MAX_AGE_SECS: i64 = 7 * 24 * 60 * 60;
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalHistoryEntry {
    pub id: i64,
    pub path: String,
    pub content_hash: String,
    pub created_at: i64,
    pub reason: String,
    pub byte_len: i64,
}

pub struct LocalHistoryState {
    db: Mutex<Connection>,
    root: PathBuf,
}

impl LocalHistoryState {
    pub fn open(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("local-history");
        let blobs = root.join("blobs");
        fs::create_dir_all(&blobs).map_err(|e| format!("create local-history dir: {e}"))?;
        let db_path = root.join("history.db");
        let conn = Connection::open(&db_path).map_err(|e| format!("open local-history db: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                reason TEXT NOT NULL,
                byte_len INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_local_history_path_time
                ON local_history(path, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_local_history_hash
                ON local_history(content_hash);",
        )
        .map_err(|e| format!("init local-history tables: {e}"))?;
        Ok(Self {
            db: Mutex::new(conn),
            root,
        })
    }

    fn blobs_dir(&self) -> PathBuf {
        self.root.join("blobs")
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        let prefix = hash.get(0..2).unwrap_or("00");
        self.blobs_dir().join(prefix).join(hash)
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hash_text(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn normalize_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Local history path is required".into());
    }
    Ok(trimmed.replace('\\', "/"))
}

fn write_blob(state: &LocalHistoryState, hash: &str, text: &str) -> Result<(), String> {
    let path = state.blob_path(hash);
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create blob dir: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("write blob tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("commit blob: {e}"))?;
    Ok(())
}

fn prune_path_locked(
    conn: &Connection,
    state: &LocalHistoryState,
    path: &str,
) -> Result<(), String> {
    let cutoff = now_secs() - MAX_AGE_SECS;
    conn.execute(
        "DELETE FROM local_history WHERE path = ?1 AND created_at < ?2",
        params![path, cutoff],
    )
    .map_err(|e| format!("prune old local history: {e}"))?;

    let ids: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, content_hash FROM local_history
                 WHERE path = ?1
                 ORDER BY created_at DESC, id DESC",
            )
            .map_err(|e| format!("prepare prune query: {e}"))?;
        let rows = stmt
            .query_map(params![path], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("query prune rows: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect prune rows: {e}"))?
    };
    if ids.len() as i64 > MAX_VERSIONS_PER_FILE {
        for (id, _) in ids.into_iter().skip(MAX_VERSIONS_PER_FILE as usize) {
            conn.execute("DELETE FROM local_history WHERE id = ?1", params![id])
                .map_err(|e| format!("delete excess local history: {e}"))?;
        }
    }
    gc_orphaned_blobs(conn, state)?;
    Ok(())
}

fn gc_orphaned_blobs(conn: &Connection, state: &LocalHistoryState) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT content_hash FROM local_history")
        .map_err(|e| format!("prepare hash list: {e}"))?;
    let live: std::collections::HashSet<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("query hashes: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("collect hashes: {e}"))?;
    let blobs = state.blobs_dir();
    if !blobs.exists() {
        return Ok(());
    }
    for prefix_entry in fs::read_dir(&blobs).map_err(|e| format!("read blobs: {e}"))? {
        let prefix_entry = prefix_entry.map_err(|e| format!("read blob prefix: {e}"))?;
        let prefix_path = prefix_entry.path();
        if !prefix_path.is_dir() {
            continue;
        }
        for blob_entry in
            fs::read_dir(&prefix_path).map_err(|e| format!("read blob bucket: {e}"))?
        {
            let blob_entry = blob_entry.map_err(|e| format!("read blob entry: {e}"))?;
            let path = blob_entry.path();
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if name.ends_with(".tmp") {
                let _ = fs::remove_file(&path);
                continue;
            }
            if !live.contains(&name) {
                let _ = fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn history_snapshot(
    state: State<'_, LocalHistoryState>,
    path: String,
    text: String,
    reason: Option<String>,
) -> Result<Option<LocalHistoryEntry>, String> {
    let path = normalize_path(&path)?;
    if text.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "Local history snapshot exceeds {} bytes",
            MAX_SNAPSHOT_BYTES
        ));
    }
    let reason = reason
        .unwrap_or_else(|| "save".into())
        .trim()
        .chars()
        .take(64)
        .collect::<String>();
    let reason = if reason.is_empty() {
        "save".into()
    } else {
        reason
    };
    let hash = hash_text(&text);
    let created_at = now_secs();
    let byte_len = text.len() as i64;

    {
        let conn = state
            .db
            .lock()
            .map_err(|_| "local history db lock poisoned")?;
        // Skip consecutive identical snapshots for the same path.
        let latest_hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM local_history
                 WHERE path = ?1
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("read latest hash: {e}"))?;
        if latest_hash.as_deref() == Some(hash.as_str()) {
            return Ok(None);
        }
        write_blob(&state, &hash, &text)?;
        conn.execute(
            "INSERT INTO local_history (path, content_hash, created_at, reason, byte_len)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, hash, created_at, reason, byte_len],
        )
        .map_err(|e| format!("insert local history: {e}"))?;
        prune_path_locked(&conn, &state, &path)?;
        let id = conn.last_insert_rowid();
        Ok(Some(LocalHistoryEntry {
            id,
            path,
            content_hash: hash,
            created_at,
            reason,
            byte_len,
        }))
    }
}

#[tauri::command]
pub fn history_list(
    state: State<'_, LocalHistoryState>,
    path: String,
    limit: Option<u32>,
) -> Result<Vec<LocalHistoryEntry>, String> {
    let path = normalize_path(&path)?;
    let limit = limit.unwrap_or(50).clamp(1, 200) as i64;
    let conn = state
        .db
        .lock()
        .map_err(|_| "local history db lock poisoned")?;
    let mut stmt = conn
        .prepare(
            "SELECT id, path, content_hash, created_at, reason, byte_len
             FROM local_history
             WHERE path = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare history list: {e}"))?;
    let rows = stmt
        .query_map(params![path, limit], |row| {
            Ok(LocalHistoryEntry {
                id: row.get(0)?,
                path: row.get(1)?,
                content_hash: row.get(2)?,
                created_at: row.get(3)?,
                reason: row.get(4)?,
                byte_len: row.get(5)?,
            })
        })
        .map_err(|e| format!("query history list: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect history list: {e}"))
}

#[tauri::command]
pub fn history_read(state: State<'_, LocalHistoryState>, id: i64) -> Result<String, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "local history db lock poisoned")?;
    let hash: String = conn
        .query_row(
            "SELECT content_hash FROM local_history WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Local history entry {id} not found"))?;
    let path = state.blob_path(&hash);
    fs::read_to_string(&path).map_err(|e| format!("read local history blob: {e}"))
}

#[tauri::command]
pub fn history_prune(state: State<'_, LocalHistoryState>) -> Result<u32, String> {
    let cutoff = now_secs() - MAX_AGE_SECS;
    let conn = state
        .db
        .lock()
        .map_err(|_| "local history db lock poisoned")?;
    let deleted = conn
        .execute(
            "DELETE FROM local_history WHERE created_at < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("prune local history: {e}"))? as u32;

    // Also enforce per-path caps for any remaining paths.
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT path FROM local_history")
            .map_err(|e| format!("prepare path list: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("query paths: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect paths: {e}"))?
    };
    for path in paths {
        prune_path_locked(&conn, &state, &path)?;
    }
    Ok(deleted)
}

pub fn init_local_history(app: &AppHandle) -> Result<LocalHistoryState, String> {
    let app_data = crate::resolved_app_data_dir(app)?;
    fs::create_dir_all(&app_data).map_err(|e| format!("create app data dir: {e}"))?;
    LocalHistoryState::open(&app_data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn snapshots_list_and_restore_blobs() {
        let dir = tempdir().unwrap();
        let state = LocalHistoryState::open(dir.path()).unwrap();
        let path = "/repo/app/src/main.ts";
        let hash1 = hash_text("one");
        write_blob(&state, &hash1, "one").unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO local_history (path, content_hash, created_at, reason, byte_len)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![path, hash1, 100, "save", 3],
            )
            .unwrap();
        }
        let hash2 = hash_text("two");
        write_blob(&state, &hash2, "two").unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO local_history (path, content_hash, created_at, reason, byte_len)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![path, hash2, 200, "save", 3],
            )
            .unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT content_hash FROM local_history WHERE path = ?1 ORDER BY created_at DESC",
                )
                .unwrap();
            let hashes: Vec<String> = stmt
                .query_map(params![path], |row| row.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            assert_eq!(hashes, vec![hash2.clone(), hash1.clone()]);
            assert_eq!(fs::read_to_string(state.blob_path(&hash2)).unwrap(), "two");
        }
    }

    #[test]
    fn prunes_excess_versions() {
        let dir = tempdir().unwrap();
        let state = LocalHistoryState::open(dir.path()).unwrap();
        let path = "/repo/app/src/main.ts";
        let base = now_secs();
        {
            let conn = state.db.lock().unwrap();
            for index in 0..55 {
                let text = format!("v{index}");
                let hash = hash_text(&text);
                write_blob(&state, &hash, &text).unwrap();
                // Keep timestamps recent so age-based prune does not wipe the set first.
                conn.execute(
                    "INSERT INTO local_history (path, content_hash, created_at, reason, byte_len)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![path, hash, base + index, "save", text.len() as i64],
                )
                .unwrap();
            }
            prune_path_locked(&conn, &state, path).unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_history WHERE path = ?1",
                    params![path],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, MAX_VERSIONS_PER_FILE);
        }
    }
}
