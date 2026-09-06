//! Welcome run-snapshot persistence (design §4.2.1, D-01 = scheme B).
//!
//! A single-row table stores the last committed *run batch snapshot*: the
//! ordered, recoverable session-tab set of the previous main-window run,
//! including whitelist local terminals (confirmed native cwd) but never whole
//! workspaces. Legacy candidates come from `sessions.last_connected_at` and
//! are always labelled as such — they never become confirmed-use records.

use crate::terminal::local_directories::normalize_path_key;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const SNAPSHOT_SCHEMA_VERSION: i64 = 1;
/// Revision counter survives row deletion (clear + rebuild must not alias an
/// older revision: design §4.3).
const METADATA_REVISION: &str = "welcome_run_snapshot_revision";
const METADATA_RUN_SEQUENCE: &str = "welcome_run_snapshot_sequence";
const METADATA_CLEAR_MARKER: &str = "session_resume_cleared_v1";
const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum SnapshotEntry {
    #[serde(rename = "saved-session")]
    SavedSession {
        #[serde(rename = "identity")]
        identity: String,
        #[serde(rename = "savedSessionId")]
        saved_session_id: String,
        /// Raw persisted type string; never defaulted to another protocol.
        #[serde(rename = "savedSessionType")]
        saved_session_type: String,
        #[serde(rename = "displayName")]
        display_name: String,
    },
    #[serde(rename = "local-terminal")]
    LocalTerminal {
        #[serde(rename = "identity")]
        identity: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "shellId")]
        shell_id: String,
        #[serde(rename = "shellArgs")]
        shell_args: Vec<String>,
        #[serde(rename = "confirmedCwd")]
        confirmed_cwd: String,
    },
}

impl SnapshotEntry {
    pub fn identity(&self) -> &str {
        match self {
            SnapshotEntry::SavedSession { identity, .. } => identity,
            SnapshotEntry::LocalTerminal { identity, .. } => identity,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotRecord {
    pub schema_version: i64,
    pub revision: i64,
    pub run_sequence: i64,
    pub batch_id: String,
    pub committed_at_ms: i64,
    pub entries: Vec<SnapshotEntry>,
    pub active_identity: Option<String>,
}

/// Frontend-facing issue attached to a snapshot read (design §4.2.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIssue {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRunSnapshotResponse {
    pub record: Option<RunSnapshotRecord>,
    pub legacy_candidate: Option<SnapshotEntry>,
    pub issue: Option<SnapshotIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRunSnapshotResponse {
    pub record: Option<RunSnapshotRecord>,
    pub applied: bool,
}

/// Saved-session types the Welcome restore can actually reopen (design
/// §4.2.2). Browser / external files / unknown types are never collected.
pub fn is_recoverable_saved_session_type(session_type: &str) -> bool {
    matches!(
        session_type,
        "LocalShell"
            | "SSH"
            | "SFTP"
            | "RDP"
            | "VNC"
            | "MySQL"
            | "PostgreSQL"
            | "PanWeiDB"
            | "Oracle"
            | "SQLServer"
            | "StarRocks"
            | "ClickHouse"
            | "Presto"
            | "Redis"
            | "HBaseShell"
            | "Proxy"
            | "S3"
            | "AzureBlob"
            | "File"
            | "Mail"
            | "FTP"
            | "Telnet"
            | "Rlogin"
            | "Mosh"
            | "Serial"
    )
}

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS welcome_run_snapshot (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            run_sequence INTEGER NOT NULL,
            batch_id TEXT NOT NULL,
            committed_at_ms INTEGER NOT NULL,
            entries_json TEXT NOT NULL,
            active_identity TEXT
        );",
    )
}

fn metadata_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM welcome_metadata WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

fn metadata_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn metadata_increment(conn: &Connection, key: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        params![key],
    )?;
    Ok(metadata_get(conn, key)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1))
}

fn current_revision(conn: &Connection) -> i64 {
    metadata_get(conn, METADATA_REVISION)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

fn load_record(conn: &Connection) -> Result<Option<RunSnapshotRecord>, String> {
    let row = conn
        .query_row(
            "SELECT schema_version, revision, run_sequence, batch_id, committed_at_ms,
                    entries_json, active_identity
             FROM welcome_run_snapshot WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((schema_version, _revision, run_sequence, batch_id, committed_at_ms, entries_json, active_identity)) =
        row
    else {
        return Ok(None);
    };
    if schema_version > SNAPSHOT_SCHEMA_VERSION {
        return Err(format!(
            "snapshot schema version {schema_version} is not supported"
        ));
    }
    let entries: Vec<SnapshotEntry> =
        serde_json::from_str(&entries_json).map_err(|e| format!("corrupt snapshot entries: {e}"))?;
    Ok(Some(RunSnapshotRecord {
        schema_version,
        revision: current_revision(conn),
        run_sequence,
        batch_id,
        committed_at_ms,
        entries,
        active_identity,
    }))
}

#[tauri::command]
pub async fn get_welcome_run_snapshot(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<GetRunSnapshotResponse, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    get_run_snapshot(&db)
}

pub fn get_run_snapshot(conn: &Connection) -> Result<GetRunSnapshotResponse, String> {
    init_tables(conn).map_err(|e| e.to_string())?;
    match load_record(conn) {
        Ok(record) => {
            if record.is_some() {
                return Ok(GetRunSnapshotResponse {
                    record,
                    legacy_candidate: None,
                    issue: None,
                });
            }
            let cleared =
                metadata_get(conn, METADATA_CLEAR_MARKER).map_err(|e| e.to_string())?.is_some();
            let legacy_candidate = if cleared {
                None
            } else {
                legacy_candidate(conn)
            };
            Ok(GetRunSnapshotResponse {
                record: None,
                legacy_candidate,
                issue: None,
            })
        }
        Err(message) => {
            if message.contains("schema version") && message.contains("not supported") {
                return Ok(GetRunSnapshotResponse {
                    record: None,
                    legacy_candidate: None,
                    issue: Some(SnapshotIssue {
                        code: "unsupported".to_string(),
                        message,
                    }),
                });
            }
            Err(message)
        }
    }
}

/// Legacy single-entry candidate from `sessions.last_connected_at` (design
/// §4.2.1): the most recent positive timestamp, ties by `id` byte order,
/// recoverable types only. This is "the most recently opened *config*",
/// explicitly not a claim of a successful connection.
fn legacy_candidate(conn: &Connection) -> Option<SnapshotEntry> {
    let rows: Vec<(String, String, String, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, session_type, last_connected_at FROM sessions
                 WHERE last_connected_at IS NOT NULL AND last_connected_at > 0
                 ORDER BY last_connected_at DESC, id ASC
                 LIMIT 50",
            )
            .ok()?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .ok()?;
        mapped.collect::<Result<Vec<_>, _>>().ok()?
    };
    for (id, name, session_type, _ts) in rows {
        if !is_recoverable_saved_session_type(&session_type) {
            continue;
        }
        return Some(SnapshotEntry::SavedSession {
            identity: format!("saved:{id}"),
            saved_session_id: id,
            saved_session_type: session_type,
            display_name: name,
        });
    }
    None
}

/// Validate one entry's basic integrity; identity is generated when absent.
fn validate_entry(entry: &mut SnapshotEntry) -> Result<(), String> {
    match entry {
        SnapshotEntry::SavedSession {
            identity,
            saved_session_id,
            saved_session_type,
            display_name,
        } => {
            if saved_session_id.trim().is_empty() {
                return Err("saved-session entry requires savedSessionId".to_string());
            }
            if saved_session_type.trim().is_empty() {
                return Err("saved-session entry requires savedSessionType".to_string());
            }
            if display_name.trim().is_empty() {
                *display_name = saved_session_id.clone();
            }
            if identity.trim().is_empty() {
                *identity = format!("saved:{saved_session_id}");
            }
        }
        SnapshotEntry::LocalTerminal {
            identity,
            display_name,
            shell_id,
            shell_args,
            confirmed_cwd,
        } => {
            if shell_id.trim().is_empty() {
                return Err("local-terminal entry requires shellId".to_string());
            }
            if confirmed_cwd.trim().is_empty() {
                return Err("local-terminal entry requires confirmedCwd".to_string());
            }
            // Only confirmed native cwd values enter the whitelist.
            if normalize_path_key(std::path::Path::new(confirmed_cwd)).is_none() {
                return Err(format!(
                    "local-terminal confirmedCwd is not a valid native absolute path: {confirmed_cwd}"
                ));
            }
            if display_name.trim().is_empty() {
                *display_name = confirmed_cwd.clone();
            }
            if identity.trim().is_empty() {
                *identity = format!("local:{}", uuid::Uuid::new_v4().simple());
            }
            let _ = shell_args;
        }
    }
    Ok(())
}

/// Commit a run snapshot from the main-window collector (design §4.2.1).
/// Time, sequence and revision are produced by Rust; an optional CAS guards
/// against overwriting a newer commit.
#[tauri::command]
pub async fn commit_welcome_run_snapshot(
    batch_id: String,
    entries: Vec<SnapshotEntry>,
    active_identity: Option<String>,
    expected_revision: Option<i64>,
    restored: Option<bool>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<CommitRunSnapshotResponse, String> {
    let mut entries = entries;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut db = db;
    commit_run_snapshot(
        &mut db,
        batch_id,
        &mut entries,
        active_identity,
        expected_revision,
        restored.unwrap_or(false),
    )
}

pub fn commit_run_snapshot(
    conn: &mut Connection,
    batch_id: String,
    entries: &mut Vec<SnapshotEntry>,
    active_identity: Option<String>,
    expected_revision: Option<i64>,
    restored: bool,
) -> Result<CommitRunSnapshotResponse, String> {
    init_tables(conn).map_err(|e| e.to_string())?;
    if entries.is_empty() {
        return Err("snapshot entries must not be empty".to_string());
    }
    if entries.len() > MAX_ENTRIES {
        return Err(format!(
            "snapshot entries exceed the {} item limit",
            MAX_ENTRIES
        ));
    }
    let mut seen_identities: HashSet<String> = HashSet::new();
    for entry in entries.iter_mut() {
        validate_entry(entry)?;
        if !seen_identities.insert(entry.identity().to_string()) {
            return Err(format!(
                "duplicate snapshot entry identity: {}",
                entry.identity()
            ));
        }
    }
    if let Some(active) = &active_identity {
        if !entries.iter().any(|entry| entry.identity() == active) {
            return Err(format!(
                "activeIdentity does not match any snapshot entry: {active}"
            ));
        }
    }

    // Unknown schema is never overwritten.
    let existing_version: Option<i64> = conn
        .query_row(
            "SELECT schema_version FROM welcome_run_snapshot WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(version) = existing_version {
        if version > SNAPSHOT_SCHEMA_VERSION {
            return Err(format!(
                "snapshot schema version {version} is not supported; refusing to overwrite"
            ));
        }
    }

    // CAS: don't clobber a newer commit (design §4.2.5).
    let current_revision = current_revision(conn);
    if let Some(expected) = expected_revision {
        if expected != current_revision {
            return Ok(CommitRunSnapshotResponse {
                record: load_record(conn)?,
                applied: false,
            });
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now_ms = crate::terminal::local_directories::system_now_ms();
    let revision = metadata_increment(&tx, METADATA_REVISION).map_err(|e| e.to_string())?;
    let run_sequence =
        metadata_increment(&tx, METADATA_RUN_SEQUENCE).map_err(|e| e.to_string())?;
    let batch_id = if batch_id.trim().is_empty() {
        uuid::Uuid::new_v4().simple().to_string()
    } else {
        batch_id
    };
    let entries_json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO welcome_run_snapshot
         (singleton, schema_version, revision, run_sequence, batch_id, committed_at_ms,
          entries_json, active_identity)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(singleton) DO UPDATE SET
           schema_version = excluded.schema_version,
           revision = excluded.revision,
           run_sequence = excluded.run_sequence,
           batch_id = excluded.batch_id,
           committed_at_ms = excluded.committed_at_ms,
           entries_json = excluded.entries_json,
           active_identity = excluded.active_identity",
        params![
            SNAPSHOT_SCHEMA_VERSION,
            revision,
            run_sequence,
            batch_id,
            now_ms,
            entries_json,
            active_identity
        ],
    )
    .map_err(|e| e.to_string())?;
    if restored {
        // A confirmed successful restore rebuilds the record and clears the
        // tombstone (design §4.2.5).
        tx.execute(
            "DELETE FROM welcome_metadata WHERE key = ?1",
            params![METADATA_CLEAR_MARKER],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(CommitRunSnapshotResponse {
        record: Some(RunSnapshotRecord {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            revision,
            run_sequence,
            batch_id,
            committed_at_ms: now_ms,
            entries: entries.clone(),
            active_identity,
        }),
        applied: true,
    })
}

/// Atomically delete the snapshot and set the clear tombstone so the next
/// refresh does not resurrect it from the legacy recent list (design §4.2.5).
#[tauri::command]
pub async fn clear_welcome_run_snapshot(
    expected_revision: Option<i64>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut db = db;
    clear_run_snapshot(&mut db, expected_revision)
}

pub fn clear_run_snapshot(conn: &mut Connection, expected_revision: Option<i64>) -> Result<(), String> {
    init_tables(conn).map_err(|e| e.to_string())?;
    let current_revision = current_revision(conn);
    if let Some(expected) = expected_revision {
        if expected != current_revision {
            return Err(format!(
                "snapshot revision mismatch: expected {expected}, current {current_revision}"
            ));
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM welcome_run_snapshot WHERE singleton = 1", [])
        .map_err(|e| e.to_string())?;
    metadata_set(&tx, METADATA_CLEAR_MARKER, "true").map_err(|e| e.to_string())?;
    // Revision keeps advancing in metadata even after deletion (design §4.3).
    metadata_increment(&tx, METADATA_REVISION).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (V-05)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                session_type TEXT NOT NULL,
                group_path TEXT,
                host TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT,
                auth_method TEXT NOT NULL DEFAULT '\"Password\"',
                options_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_connected_at INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS welcome_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
        crate::terminal::local_directories::init_tables(&conn).unwrap();
        init_tables(&conn).unwrap();
        conn
    }

    fn insert_session(
        conn: &Connection,
        id: &str,
        name: &str,
        session_type: &str,
        last_connected_at: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO sessions (id, name, session_type, created_at, updated_at, last_connected_at)
             VALUES (?1, ?2, ?3, 0, 0, ?4)",
            params![id, name, session_type, last_connected_at],
        )
        .unwrap();
    }

    fn saved_entry(id: &str, session_type: &str) -> SnapshotEntry {
        SnapshotEntry::SavedSession {
            identity: format!("saved:{id}"),
            saved_session_id: id.to_string(),
            saved_session_type: session_type.to_string(),
            display_name: format!("session-{id}"),
        }
    }

    /// Legacy candidate: max positive last_connected_at, ties by id byte
    /// order; empty/negative/ineligible entries are skipped in order.
    #[test]
    fn legacy_candidate_picks_latest_positive_and_skips_ineligible() {
        let conn = test_conn();
        insert_session(&conn, "b", "newer-ineligible", "Browser", Some(2000));
        insert_session(&conn, "a", "older", "SSH", Some(1000));
        insert_session(&conn, "z", "tie-loser", "SSH", Some(1500));
        insert_session(&conn, "y", "tie-winner", "SFTP", Some(1500));
        insert_session(&conn, "n", "never-connected", "SSH", None);
        insert_session(&conn, "neg", "negative", "SSH", Some(-5));

        let response = get_run_snapshot(&conn).unwrap();
        let candidate = response.legacy_candidate.expect("legacy candidate");
        match &candidate {
            SnapshotEntry::SavedSession {
                saved_session_id,
                saved_session_type,
                display_name,
                ..
            } => {
                assert_eq!(saved_session_id, "y", "latest positive time; id tie broken ascending");
                assert_eq!(saved_session_type, "SFTP");
                assert_eq!(display_name, "tie-winner");
            }
            other => panic!("unexpected candidate {other:?}"),
        }
    }

    /// A committed snapshot takes precedence; legacy is not consulted.
    #[test]
    fn confirmed_snapshot_beats_legacy_candidate() {
        let mut conn = test_conn();
        insert_session(&conn, "a", "old", "SSH", Some(5000));

        let mut entries = vec![saved_entry("a", "SSH")];
        let response = commit_run_snapshot(&mut conn, "batch-1".into(), &mut entries, None, None, false)
            .unwrap();
        assert!(response.applied);

        let response = get_run_snapshot(&conn).unwrap();
        assert!(response.legacy_candidate.is_none());
        let record = response.record.expect("snapshot record");
        assert_eq!(record.entries.len(), 1);
        assert_eq!(record.revision, 1);
    }

    /// Config deleted: the snapshot keeps the reference; the frontend re-reads
    /// the config and reports missing-session (AC-15).
    #[test]
    fn snapshot_survives_session_deletion_and_replace() {
        let mut conn = test_conn();
        insert_session(&conn, "a", "will-be-deleted", "SSH", None);
        let mut entries = vec![saved_entry("a", "SSH")];
        commit_run_snapshot(&mut conn, "batch".into(), &mut entries, None, None, false).unwrap();

        conn.execute("DELETE FROM sessions WHERE id = 'a'", []).unwrap();
        // INSERT OR REPLACE must not cascade into the snapshot either.
        insert_session(&conn, "a", "replaced", "SSH", None);
        conn.execute(
            "INSERT OR REPLACE INTO sessions
             (id, name, session_type, created_at, updated_at, last_connected_at)
             VALUES ('a', 'replaced2', 'SSH', 0, 0, NULL)",
            [],
        )
        .unwrap();

        let response = get_run_snapshot(&conn).unwrap();
        let record = response.record.expect("record preserved without foreign keys");
        assert_eq!(record.entries.len(), 1);
    }

    /// Clear tombstone: snapshot removed, legacy candidate suppressed, and a
    /// later normal use (restored commit) revives the record.
    #[test]
    fn clear_tombstone_suppresses_legacy_and_revision_advances() {
        let mut conn = test_conn();
        insert_session(&conn, "a", "legacy source", "SSH", Some(1000));
        let mut entries = vec![saved_entry("a", "SSH")];
        commit_run_snapshot(&mut conn, "batch".into(), &mut entries, None, None, false).unwrap();
        clear_run_snapshot(&mut conn, None).unwrap();

        let response = get_run_snapshot(&conn).unwrap();
        assert!(response.record.is_none());
        assert!(
            response.legacy_candidate.is_none(),
            "cleared record must not resurrect from the legacy list"
        );

        // Revision kept advancing across the clear (no ABA).
        let mut entries = vec![saved_entry("a", "SSH")];
        let response = commit_run_snapshot(&mut conn, "batch2".into(), &mut entries, None, None, true)
            .unwrap();
        assert!(response.applied);
        assert!(response.record.as_ref().unwrap().revision >= 3);
        let response = get_run_snapshot(&conn).unwrap();
        assert!(response.record.is_some(), "restored commit revives the record");
    }

    /// CAS: expectedRevision mismatch does not overwrite the newer commit.
    #[test]
    fn cas_mismatch_does_not_overwrite_newer_record() {
        let mut conn = test_conn();
        let mut entries = vec![saved_entry("a", "SSH")];
        let first = commit_run_snapshot(&mut conn, "b1".into(), &mut entries.clone(), None, None, false)
            .unwrap();
        let first_revision = first.record.as_ref().unwrap().revision;

        let mut newer = vec![saved_entry("b", "SFTP")];
        let second = commit_run_snapshot(&mut conn, "b2".into(), &mut newer, None, None, false).unwrap();
        let second_revision = second.record.as_ref().unwrap().revision;
        assert!(second_revision > first_revision);

        // A late writer holding the stale revision must not win.
        let mut stale = vec![saved_entry("c", "VNC")];
        let response = commit_run_snapshot(
            &mut conn,
            "b3".into(),
            &mut stale,
            None,
            Some(first_revision),
            false,
        )
        .unwrap();
        assert!(!response.applied);
        let record = response.record.expect("current record returned on CAS miss");
        match &record.entries[0] {
            SnapshotEntry::SavedSession { saved_session_id, .. } => {
                assert_eq!(saved_session_id, "b", "the newer commit survives");
            }
            other => panic!("unexpected entry {other:?}"),
        }
    }

    /// Unknown schema: reading reports an issue and committing refuses.
    #[test]
    fn unknown_schema_is_protected() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO welcome_run_snapshot
             (singleton, schema_version, revision, run_sequence, batch_id, committed_at_ms,
              entries_json, active_identity)
             VALUES (1, 99, 1, 1, 'future', 0, '[]', NULL)",
            [],
        )
        .unwrap();

        let response = get_run_snapshot(&conn).unwrap();
        assert!(response.record.is_none());
        assert!(response.legacy_candidate.is_none());
        let issue = response.issue.expect("unsupported schema issue");
        assert_eq!(issue.code, "unsupported");

        let mut conn = conn;
        let mut entries = vec![saved_entry("a", "SSH")];
        let result = commit_run_snapshot(&mut conn, "b".into(), &mut entries, None, None, false);
        assert!(result.is_err(), "must refuse to overwrite an unknown schema");
        let version: i64 = conn
            .query_row(
                "SELECT schema_version FROM welcome_run_snapshot WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 99, "foreign schema row untouched");
    }

    /// Entry validation: empty snapshot, invalid local cwd and duplicate
    /// identities are rejected; unknown-but-nonempty types are stored raw
    /// (never defaulted to SSH).
    #[test]
    fn entry_validation_rules() {
        let mut conn = test_conn();

        let mut empty: Vec<SnapshotEntry> = Vec::new();
        assert!(
            commit_run_snapshot(&mut conn, "b".into(), &mut empty, None, None, false).is_err(),
            "empty snapshots are never committed"
        );

        let mut bad_cwd = vec![SnapshotEntry::LocalTerminal {
            identity: String::new(),
            display_name: "wsl-ish".to_string(),
            shell_id: "wsl.exe".to_string(),
            shell_args: vec!["-d".to_string(), "Ubuntu".to_string()],
            confirmed_cwd: "/home/user/linux-only".to_string(),
        }];
        // On a Linux test host "/home/user/linux-only" is lexically absolute,
        // so exercise the real boundary with a relative path instead.
        let mut bad_cwd = vec![SnapshotEntry::LocalTerminal {
            identity: String::new(),
            display_name: "relative".to_string(),
            shell_id: "bash".to_string(),
            shell_args: vec![],
            confirmed_cwd: "relative/path".to_string(),
        }];
        assert!(
            commit_run_snapshot(&mut conn, "b".into(), &mut bad_cwd, None, None, false).is_err(),
            "relative cwd is not a confirmed native cwd"
        );

        let mut dup = vec![saved_entry("a", "SSH"), saved_entry("a", "SSH")];
        assert!(
            commit_run_snapshot(&mut conn, "b".into(), &mut dup, None, None, false).is_err(),
            "duplicate identities are rejected"
        );

        // Unknown raw type is preserved verbatim (no SSH fallback).
        let mut unknown = vec![saved_entry("u", "SomeFutureProtocol")];
        let response = commit_run_snapshot(&mut conn, "b".into(), &mut unknown, None, None, false)
            .unwrap();
        match &response.record.unwrap().entries[0] {
            SnapshotEntry::SavedSession {
                saved_session_type, ..
            } => assert_eq!(saved_session_type, "SomeFutureProtocol"),
            other => panic!("unexpected entry {other:?}"),
        }
    }

    /// Active identity must reference a real entry; reopen keeps data intact.
    #[test]
    fn active_identity_and_reopen_persistence() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("taomni.db");
        {
            let mut conn = Connection::open(&path).unwrap();
            test_schema(&mut conn);
            let mut entries = vec![saved_entry("a", "SSH"), saved_entry("b", "LocalShell")];
            let response = commit_run_snapshot(
                &mut conn,
                "batch".into(),
                &mut entries,
                Some("saved:b".to_string()),
                None,
                false,
            )
            .unwrap();
            assert!(response.applied);
        }
        {
            let conn = Connection::open(&path).unwrap();
            test_schema_readonly(&conn);
            let response = get_run_snapshot(&conn).unwrap();
            let record = response.record.expect("persisted across reopen");
            assert_eq!(record.active_identity.as_deref(), Some("saved:b"));
            assert_eq!(record.entries.len(), 2);
        }
        // Mismatched active identity is rejected.
        let mut conn = Connection::open(&path).unwrap();
        test_schema(&mut conn);
        let mut entries = vec![saved_entry("a", "SSH")];
        assert!(
            commit_run_snapshot(&mut conn, "b".into(), &mut entries, Some("saved:zz".to_string()), None, false)
                .is_err()
        );
    }

    fn test_schema(conn: &mut Connection) {
        crate::terminal::local_directories::init_tables(conn).unwrap();
        init_tables(conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                session_type TEXT NOT NULL,
                group_path TEXT,
                host TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT,
                auth_method TEXT NOT NULL DEFAULT '\"Password\"',
                options_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_connected_at INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS welcome_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
    }

    fn test_schema_readonly(conn: &Connection) {
        init_tables(conn).unwrap();
    }
}
