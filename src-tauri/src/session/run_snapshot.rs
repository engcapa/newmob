//! Last-run tab-set snapshot (D-01=B). Stores references + display summaries,
//! never secrets/handles/output. `sessions` stays the config source of truth;
//! this module only snapshots which restorable tabs existed in which order.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: i64 = 2;
const METADATA_CLEAR_KEY: &str = "run_snapshot_cleared_v1";
const METADATA_REVISION_KEY: &str = "run_batch_revision";

/// Tab kinds that must never enter the snapshot (AC-23). The collector also
/// filters, but storage rejects them so a buggy caller cannot persist them.
const EXCLUDED_KINDS: &[&str] = &[
    "welcome",
    "settings",
    "placeholder",
    "code-workspace",
    "git",
    "nettools",
    "sockscap",
    "lan-chat",
    "notes",
    "servers",
    "browser",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempShell {
    pub id: String,
    pub name: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEntryInput {
    pub entry_key: String,
    pub order_index: i64,
    pub kind: String,
    pub saved_session_id: Option<String>,
    pub saved_session_type: Option<String>,
    pub display_name: String,
    pub local_cwd: Option<String>,
    pub temp_shell: Option<TempShell>,
    pub profile_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEntry {
    pub entry_key: String,
    pub order_index: i64,
    pub kind: String,
    pub saved_session_id: Option<String>,
    pub saved_session_type: Option<String>,
    pub display_name: String,
    pub local_cwd: Option<String>,
    pub temp_shell: Option<TempShell>,
    pub profile_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub schema_version: i64,
    pub revision: i64,
    pub run_id: String,
    pub created_at_ms: i64,
    pub active_entry_key: Option<String>,
    pub entries: Vec<RunEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIssue {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSnapshotResponse {
    pub snapshot: Option<RunSnapshot>,
    pub issue: Option<SnapshotIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSnapshotResponse {
    pub snapshot: RunSnapshot,
    pub applied: bool,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS welcome_run_batch (
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
           schema_version INTEGER NOT NULL,
           revision INTEGER NOT NULL,
           run_id TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           app_version TEXT NOT NULL,
           active_entry_key TEXT,
           clear_mark INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS welcome_run_entries (
           batch_revision INTEGER NOT NULL,
           entry_key TEXT NOT NULL,
           order_index INTEGER NOT NULL,
           kind TEXT NOT NULL,
           saved_session_id TEXT,
           saved_session_type TEXT,
           display_name TEXT NOT NULL,
           local_cwd TEXT,
           temp_shell_id TEXT,
           temp_shell_name TEXT,
           temp_shell_args TEXT,
           profile_ref TEXT,
           PRIMARY KEY (batch_revision, entry_key)
         );
         CREATE TABLE IF NOT EXISTS welcome_metadata (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )?;
    Ok(())
}

fn validate_entry(input: &RunEntryInput) -> Result<(), String> {
    if input.entry_key.trim().is_empty() {
        return Err("entry_key required".to_string());
    }
    if input.kind.trim().is_empty() {
        return Err("kind required".to_string());
    }
    if EXCLUDED_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("kind '{}' is excluded from restore", input.kind));
    }
    if input.display_name.trim().is_empty() {
        return Err("display_name required".to_string());
    }
    match (&input.saved_session_id, &input.temp_shell) {
        (Some(id), _) => {
            if id.trim().is_empty() {
                return Err("saved_session_id must not be blank".to_string());
            }
            if input
                .saved_session_type
                .as_deref()
                .is_none_or(|s| s.trim().is_empty())
            {
                return Err("saved_session_type required with saved_session_id".to_string());
            }
        }
        (None, Some(temp)) => {
            if temp.id.trim().is_empty() || temp.name.trim().is_empty() {
                return Err("temp shell id/name required".to_string());
            }
            // Temp whitelist: native-local only. Remote/WSL cwd masquerading is
            // rejected here; the collector must only send host-absolute paths.
            if let Some(cwd) = input.local_cwd.as_deref() {
                if cwd.is_empty() || cwd.contains('\0') {
                    return Err("invalid temp local_cwd".to_string());
                }
                if !std::path::Path::new(cwd).is_absolute() {
                    return Err("temp local_cwd must be absolute".to_string());
                }
            }
        }
        (None, None) => {
            return Err(
                "entry must reference a saved session or whitelisted temp terminal".to_string(),
            );
        }
    }
    if let Some(cwd) = input.local_cwd.as_deref() {
        if cwd.contains('\0') {
            return Err("invalid local_cwd".to_string());
        }
        if !cwd.is_empty() && !std::path::Path::new(cwd).is_absolute() {
            return Err("local_cwd must be absolute".to_string());
        }
    }
    Ok(())
}

fn metadata_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM welcome_metadata WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .unwrap_or(None)
}

fn read_snapshot_inner(conn: &Connection) -> Result<GetSnapshotResponse, String> {
    let batch: Option<(i64, i64, String, i64, Option<String>)> = conn
        .query_row(
            "SELECT schema_version, revision, run_id, created_at_ms, active_entry_key
             FROM welcome_run_batch WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("storage: {e}"))?;
    let Some((schema_version, revision, run_id, created_at_ms, active_entry_key)) = batch else {
        return Ok(GetSnapshotResponse {
            snapshot: None,
            issue: None,
        });
    };
    if schema_version != SCHEMA_VERSION {
        return Ok(GetSnapshotResponse {
            snapshot: None,
            issue: Some(SnapshotIssue {
                code: "schema".to_string(),
                message: format!("unsupported run snapshot schema {schema_version}"),
            }),
        });
    }
    let mut stmt = conn
        .prepare(
            "SELECT entry_key, order_index, kind, saved_session_id, saved_session_type,
                    display_name, local_cwd, temp_shell_id, temp_shell_name,
                    temp_shell_args, profile_ref
             FROM welcome_run_entries WHERE batch_revision = ?1 ORDER BY order_index ASC",
        )
        .map_err(|e| format!("storage: {e}"))?;
    let rows = stmt
        .query_map(params![revision], |row| {
            let args_json: Option<String> = row.get(9)?;
            let args: Vec<String> = args_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let temp_shell_id: Option<String> = row.get(7)?;
            let temp_shell = temp_shell_id.map(|id| TempShell {
                id,
                name: row.get(8).unwrap_or_default(),
                args,
            });
            Ok(RunEntry {
                entry_key: row.get(0)?,
                order_index: row.get(1)?,
                kind: row.get(2)?,
                saved_session_id: row.get(3)?,
                saved_session_type: row.get(4)?,
                display_name: row.get(5)?,
                local_cwd: row.get(6)?,
                temp_shell,
                profile_ref: row.get(10)?,
            })
        })
        .map_err(|e| format!("storage: {e}"))?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| format!("storage: {e}"))?);
    }
    // Entry-level issue surfacing happens in the frontend via get_session;
    // storage keeps the batch intact even when configs were deleted.
    Ok(GetSnapshotResponse {
        snapshot: Some(RunSnapshot {
            schema_version,
            revision,
            run_id,
            created_at_ms,
            active_entry_key,
            entries,
        }),
        issue: None,
    })
}

pub fn get_snapshot(conn: &Connection) -> Result<GetSnapshotResponse, String> {
    init_tables(conn).map_err(|e| format!("storage: {e}"))?;
    read_snapshot_inner(conn)
}

pub fn record_snapshot(
    conn: &Connection,
    run_id: &str,
    entries: &[RunEntryInput],
    active_entry_key: Option<&str>,
    expected_revision: Option<i64>,
    app_version: &str,
) -> Result<RecordSnapshotResponse, String> {
    if run_id.trim().is_empty() {
        return Err("run_id required".to_string());
    }
    init_tables(conn).map_err(|e| format!("storage: {e}"))?;
    // Empty snapshots never overwrite the last non-empty batch.
    if entries.is_empty() {
        let current = read_snapshot_inner(conn)?;
        if let Some(snapshot) = current.snapshot {
            return Ok(RecordSnapshotResponse {
                snapshot,
                applied: false,
            });
        }
        return Err("refusing to persist an empty run snapshot".to_string());
    }
    let mut sorted = entries.to_vec();
    sorted.sort_by_key(|e| e.order_index);
    for entry in &sorted {
        validate_entry(entry)?;
    }
    // Entry keys must be unique within the batch.
    let mut seen = std::collections::HashSet::new();
    for entry in &sorted {
        if !seen.insert(entry.entry_key.clone()) {
            return Err(format!("duplicate entry_key '{}'", entry.entry_key));
        }
    }
    if let Some(active) = active_entry_key {
        if !seen.contains(active) {
            return Err("active_entry_key must reference a batch entry".to_string());
        }
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("storage: {e}"))?;
    let current_revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM welcome_run_batch WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("storage: {e}"))?;
    if let (Some(expected), Some(current)) = (expected_revision, current_revision) {
        if expected != current {
            // CAS conflict: return the current record without overwriting the
            // newer normal use.
            drop(tx);
            let current = read_snapshot_inner(conn)?;
            let snapshot = current.snapshot.ok_or("storage: snapshot vanished")?;
            return Ok(RecordSnapshotResponse {
                snapshot,
                applied: false,
            });
        }
    }
    let next_revision = current_revision.unwrap_or(0) + 1;
    let created_at_ms = now_ms();
    tx.execute(
        "INSERT INTO welcome_run_batch
         (singleton, schema_version, revision, run_id, created_at_ms, app_version, active_entry_key, clear_mark)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, 0)
         ON CONFLICT(singleton) DO UPDATE SET
           schema_version = excluded.schema_version, revision = excluded.revision,
           run_id = excluded.run_id, created_at_ms = excluded.created_at_ms,
           app_version = excluded.app_version, active_entry_key = excluded.active_entry_key,
           clear_mark = 0",
        params![
            SCHEMA_VERSION,
            next_revision,
            run_id,
            created_at_ms,
            app_version,
            active_entry_key
        ],
    )
    .map_err(|e| format!("storage: {e}"))?;
    // Replace only this revision's entries; older revisions are pruned.
    tx.execute(
        "DELETE FROM welcome_run_entries WHERE batch_revision != ?1",
        params![next_revision],
    )
    .map_err(|e| format!("storage: {e}"))?;
    for entry in &sorted {
        let args_json = entry
            .temp_shell
            .as_ref()
            .map(|t| serde_json::to_string(&t.args).unwrap_or_else(|_| "[]".to_string()));
        tx.execute(
            "INSERT OR REPLACE INTO welcome_run_entries
             (batch_revision, entry_key, order_index, kind, saved_session_id,
              saved_session_type, display_name, local_cwd, temp_shell_id,
              temp_shell_name, temp_shell_args, profile_ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                next_revision,
                entry.entry_key,
                entry.order_index,
                entry.kind,
                entry.saved_session_id,
                entry.saved_session_type,
                entry.display_name,
                entry.local_cwd,
                entry.temp_shell.as_ref().map(|t| t.id.clone()),
                entry.temp_shell.as_ref().map(|t| t.name.clone()),
                args_json,
                entry.profile_ref
            ],
        )
        .map_err(|e| format!("storage: {e}"))?;
    }
    tx.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![METADATA_REVISION_KEY, next_revision.to_string()],
    )
    .map_err(|e| format!("storage: {e}"))?;
    tx.execute(
        "DELETE FROM welcome_metadata WHERE key = ?1",
        params![METADATA_CLEAR_KEY],
    )
    .map_err(|e| format!("storage: {e}"))?;
    tx.commit().map_err(|e| format!("storage: {e}"))?;
    let current = read_snapshot_inner(conn)?;
    let snapshot = current
        .snapshot
        .ok_or("storage: snapshot missing after write")?;
    Ok(RecordSnapshotResponse {
        snapshot,
        applied: true,
    })
}

pub fn update_entry_context(
    conn: &Connection,
    run_id: &str,
    entry_key: &str,
    local_cwd: &str,
    expected_revision: i64,
) -> Result<RecordSnapshotResponse, String> {
    if !std::path::Path::new(local_cwd).is_absolute() || local_cwd.contains('\0') {
        return Err("local_cwd must be an absolute native path".to_string());
    }
    init_tables(conn).map_err(|e| format!("storage: {e}"))?;
    let current = read_snapshot_inner(conn)?;
    let Some(snapshot) = current.snapshot else {
        return Err("no run snapshot".to_string());
    };
    if snapshot.run_id != run_id || snapshot.revision != expected_revision {
        return Ok(RecordSnapshotResponse {
            snapshot,
            applied: false,
        });
    }
    if !snapshot.entries.iter().any(|e| e.entry_key == entry_key) {
        return Err("unknown entry_key".to_string());
    }
    conn.execute(
        "UPDATE welcome_run_entries SET local_cwd = ?1
         WHERE batch_revision = ?2 AND entry_key = ?3",
        params![local_cwd, expected_revision, entry_key],
    )
    .map_err(|e| format!("storage: {e}"))?;
    let current = read_snapshot_inner(conn)?;
    let snapshot = current.snapshot.ok_or("storage: snapshot missing")?;
    Ok(RecordSnapshotResponse {
        snapshot,
        applied: true,
    })
}

pub fn clear_snapshot(conn: &Connection, expected_revision: Option<i64>) -> Result<bool, String> {
    init_tables(conn).map_err(|e| format!("storage: {e}"))?;
    let current: Option<i64> = conn
        .query_row(
            "SELECT revision FROM welcome_run_batch WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("storage: {e}"))?;
    if let (Some(expected), Some(current)) = (expected_revision, current) {
        if expected != current {
            return Err(format!(
                "revision conflict: expected {expected}, current {current}"
            ));
        }
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("storage: {e}"))?;
    tx.execute("DELETE FROM welcome_run_entries", [])
        .map_err(|e| format!("storage: {e}"))?;
    tx.execute("DELETE FROM welcome_run_batch WHERE singleton = 1", [])
        .map_err(|e| format!("storage: {e}"))?;
    // Monotonic revision across clear+recreate prevents ABA conflicts.
    let next: i64 = current.unwrap_or(0) + 1;
    tx.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![METADATA_REVISION_KEY, next.to_string()],
    )
    .map_err(|e| format!("storage: {e}"))?;
    tx.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value = 'true'",
        params![METADATA_CLEAR_KEY],
    )
    .map_err(|e| format!("storage: {e}"))?;
    tx.commit().map_err(|e| format!("storage: {e}"))?;
    let _ = metadata_get(conn, METADATA_CLEAR_KEY);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        conn
    }

    fn saved_entry(key: &str, order: i64, session_id: &str) -> RunEntryInput {
        RunEntryInput {
            entry_key: key.to_string(),
            order_index: order,
            kind: "terminal".to_string(),
            saved_session_id: Some(session_id.to_string()),
            saved_session_type: Some("SSH".to_string()),
            display_name: format!("entry {key}"),
            local_cwd: None,
            temp_shell: None,
            profile_ref: None,
        }
    }

    #[test]
    fn empty_snapshot_never_overwrites_non_empty_batch() {
        let conn = memory_db();
        let first = record_snapshot(
            &conn,
            "run-1",
            &[
                saved_entry("saved:a", 0, "a"),
                saved_entry("saved:b", 1, "b"),
            ],
            Some("saved:a"),
            None,
            "0.4.22",
        )
        .unwrap();
        assert!(first.applied);
        let second = record_snapshot(&conn, "run-1", &[], None, None, "0.4.22").unwrap();
        assert!(!second.applied);
        assert_eq!(second.snapshot.entries.len(), 2);
        assert_eq!(second.snapshot.revision, first.snapshot.revision);
    }

    #[test]
    fn cas_conflict_returns_current_without_overwrite() {
        let conn = memory_db();
        let first = record_snapshot(
            &conn,
            "run-1",
            &[saved_entry("saved:a", 0, "a")],
            None,
            None,
            "0.4.22",
        )
        .unwrap();
        let stale = record_snapshot(
            &conn,
            "run-1",
            &[saved_entry("saved:b", 0, "b")],
            None,
            Some(first.snapshot.revision - 1),
            "0.4.22",
        )
        .unwrap();
        assert!(!stale.applied);
        assert_eq!(stale.snapshot.entries[0].entry_key, "saved:a");
    }

    #[test]
    fn excluded_kinds_are_rejected() {
        let conn = memory_db();
        let bad = RunEntryInput {
            kind: "code-workspace".to_string(),
            ..saved_entry("x", 0, "a")
        };
        assert!(record_snapshot(&conn, "run-1", &[bad], None, None, "0.4.22").is_err());
    }

    #[test]
    fn temp_entry_requires_whitelist_shell() {
        let conn = memory_db();
        let bad = RunEntryInput {
            entry_key: "temp:1".to_string(),
            order_index: 0,
            kind: "terminal".to_string(),
            saved_session_id: None,
            saved_session_type: None,
            display_name: "temp".to_string(),
            local_cwd: Some("/tmp".to_string()),
            temp_shell: None,
            profile_ref: None,
        };
        assert!(record_snapshot(&conn, "run-1", &[bad], None, None, "0.4.22").is_err());
    }

    #[test]
    fn clear_uses_revision_cas_and_blocks_revival() {
        let conn = memory_db();
        let first = record_snapshot(
            &conn,
            "run-1",
            &[saved_entry("saved:a", 0, "a")],
            None,
            None,
            "0.4.22",
        )
        .unwrap();
        assert!(clear_snapshot(&conn, Some(first.snapshot.revision + 99)).is_err());
        assert!(clear_snapshot(&conn, Some(first.snapshot.revision)).unwrap());
        let got = get_snapshot(&conn).unwrap();
        assert!(got.snapshot.is_none());
    }

    #[test]
    fn unknown_schema_is_reported_not_clobbered() {
        let conn = memory_db();
        conn.execute(
            "INSERT OR REPLACE INTO welcome_run_batch
             (singleton, schema_version, revision, run_id, created_at_ms, app_version)
             VALUES (1, 99, 1, 'run-x', 1, '0.0.0')",
            [],
        )
        .unwrap();
        let got = get_snapshot(&conn).unwrap();
        assert!(got.snapshot.is_none());
        assert_eq!(got.issue.map(|i| i.code), Some("schema".to_string()));
    }
}
