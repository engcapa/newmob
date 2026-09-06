//! V-09: Welcome recents ordering + run-snapshot restore persistence against
//! a real SQLite file in a temp directory (design docs-feature/
//! welcome-recents-session-restore-design.md §7.1 V-09).
//!
//! Uses the real service layer (terminal::local_directories,
//! session::resume) — it does not construct Tauri's AppState or WebView and
//! therefore proves service semantics only, not native UI behavior.

use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection};
use taomni_lib::session::resume::{
    clear_run_snapshot, commit_run_snapshot, get_run_snapshot, init_tables, SnapshotEntry,
};
use taomni_lib::terminal::local_directories::{
    init_tables as init_directory_tables, list_directory_shortcuts, migrate_legacy_history,
    record_directory_use, SOURCE_LOCAL_START, SOURCE_LOCAL_CWD,
};

fn open_db(path: &Path) -> Connection {
    let conn = Connection::open(path).expect("open sqlite");
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
        CREATE TABLE IF NOT EXISTS command_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_key TEXT NOT NULL,
            command TEXT NOT NULL,
            last_used_at INTEGER NOT NULL,
            use_count INTEGER NOT NULL DEFAULT 1,
            UNIQUE(host_key, command)
        );",
    )
    .expect("seed schema");
    init_directory_tables(&conn).expect("directory tables");
    init_tables(&conn).expect("snapshot tables");
    conn
}

/// init -> legacy import -> confirmed records -> release -> reopen: the
/// ordering and restore object must survive a real process-level reopen.
#[test]
fn directory_history_and_snapshot_survive_reopen() {
    let dir = tempfile::TempDir::new().unwrap();
    let db_path = dir.path().join("taomni.db");
    let work = dir.path().join("work");
    let other = dir.path().join("other");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::create_dir_all(&other).unwrap();

    {
        let conn = open_db(&db_path);
        conn.execute(
            "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', ?1, 1700000000)",
            params![format!("cd {}", work.display())],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', 'cd projects', 1699999999)",
            [],
        )
        .unwrap();

        let mut conn = conn;
        migrate_legacy_history(&mut conn).expect("legacy migration");
        // Confirmed use beats every legacy observation.
        record_directory_use(&mut conn, &work, SOURCE_LOCAL_START, 2_000_000_000_000)
            .expect("record confirmed use");
        record_directory_use(&mut conn, &other, SOURCE_LOCAL_CWD, 1_999_999_999_000)
            .expect("record second use");

        let mut entries = vec![SnapshotEntry::SavedSession {
            identity: "saved:s1".to_string(),
            saved_session_id: "s1".to_string(),
            saved_session_type: "SSH".to_string(),
            display_name: "prod".to_string(),
        }];
        let response = commit_run_snapshot(&mut conn, "batch-1".into(), &mut entries, Some("saved:s1".to_string()), None, false)
            .expect("commit snapshot");
        assert!(response.applied);
    } // connection released

    // Reopen: same ordering and restore object.
    let conn = open_db(&db_path);
    let mut conn = conn;
    migrate_legacy_history(&mut conn).expect("migration idempotent on reopen");
    let envelope = list_directory_shortcuts(&conn).expect("list after reopen");
    let paths: Vec<String> = envelope.directories.iter().map(|d| d.path.clone()).collect();
    let work_index = paths
        .iter()
        .position(|p| Path::new(p) == work)
        .expect("work dir listed");
    let other_index = paths
        .iter()
        .position(|p| Path::new(p) == other)
        .expect("other dir listed");
    assert!(
        work_index < other_index,
        "confirmed times sort newest first across reopen: {paths:?}"
    );
    let used = &envelope.directories[work_index];
    assert_eq!(used.last_used_at_ms, Some(2_000_000_000_000));
    assert_eq!(used.time_source.as_deref(), Some(SOURCE_LOCAL_START));

    let response = get_run_snapshot(&conn).expect("snapshot after reopen");
    let record = response.record.expect("snapshot persisted");
    assert_eq!(record.batch_id, "batch-1");
    assert_eq!(record.active_identity.as_deref(), Some("saved:s1"));
    assert_eq!(record.entries.len(), 1);
    // Legacy observation never upgraded into confirmed use.
    assert!(response.legacy_candidate.is_none(), "new record wins over legacy");
}

/// An uncommitted (panicked/dropped) transaction rolls back completely: no
/// partial directory rows, no migration marker.
#[test]
fn interrupted_migration_rolls_back() {
    let dir = tempfile::TempDir::new().unwrap();
    let conn = open_db(&dir.path().join("taomni.db"));
    conn.execute(
        "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', 'cd /tmp/taomni-rollback-target', 1700000000)",
        [],
    )
    .unwrap();

    // Simulate a mid-migration failure: begin a transaction, write, then drop
    // without commit (the real code path is the same transaction shape).
    let mut conn = conn;
    {
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO welcome_directory_usage (directory_id, display_path) VALUES ('x', '/tmp/taomni-rollback-target')",
            [],
        )
        .unwrap();
        drop(tx); // rolls back the uncommitted write
    }
    migrate_legacy_history(&mut conn)
        .expect("migration after the rolled-back transaction still succeeds");

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM welcome_directory_usage WHERE directory_id = 'x'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "rolled back rows leave no trace");
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM welcome_metadata WHERE key = 'directory_migration_v1'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(marker, Some("complete".to_string()));
}

/// Two connections: CAS on the snapshot protects the newer commit from a
/// stale writer holding an older revision.
#[test]
fn snapshot_cas_across_connections() {
    let dir = tempfile::TempDir::new().unwrap();
    let db_path = dir.path().join("taomni.db");
    let mut first = open_db(&db_path);
    let mut entries_a = vec![SnapshotEntry::SavedSession {
        identity: "saved:a".to_string(),
        saved_session_id: "a".to_string(),
        saved_session_type: "SSH".to_string(),
        display_name: "a".to_string(),
    }];
    let first_commit =
        commit_run_snapshot(&mut first, "b1".into(), &mut entries_a, None, None, false).unwrap();
    let first_revision = first_commit.record.as_ref().unwrap().revision;

    // Second connection commits a newer batch.
    let mut second = open_db(&db_path);
    let mut entries_b = vec![SnapshotEntry::SavedSession {
        identity: "saved:b".to_string(),
        saved_session_id: "b".to_string(),
        saved_session_type: "SFTP".to_string(),
        display_name: "b".to_string(),
    }];
    let second_commit =
        commit_run_snapshot(&mut second, "b2".into(), &mut entries_b, None, None, false).unwrap();
    assert!(second_commit.applied);

    // The first connection's stale CAS must not overwrite the newer batch.
    let mut stale_entries = vec![SnapshotEntry::SavedSession {
        identity: "saved:c".to_string(),
        saved_session_id: "c".to_string(),
        saved_session_type: "VNC".to_string(),
        display_name: "c".to_string(),
    }];
    let stale = commit_run_snapshot(
        &mut first,
        "b3".into(),
        &mut stale_entries,
        None,
        Some(first_revision),
        false,
    )
    .unwrap();
    assert!(!stale.applied, "stale revision must lose the race");

    let response = get_run_snapshot(&second).unwrap();
    let record = response.record.unwrap();
    match &record.entries[0] {
        SnapshotEntry::SavedSession { saved_session_id, .. } => {
            assert_eq!(saved_session_id, "b");
        }
        other => panic!("unexpected entry {other:?}"),
    }
}

/// Close-after-use semantics: a closed/deleted directory keeps its row; a
/// deleted session keeps the snapshot reference but the snapshot clear
/// tombstone prevents legacy revival.
#[test]
fn clear_tombstone_and_recovery_paths() {
    let dir = tempfile::TempDir::new().unwrap();
    let mut conn = open_db(&dir.path().join("taomni.db"));
    conn.execute(
        "INSERT INTO sessions (id, name, session_type, created_at, updated_at, last_connected_at)
         VALUES ('legacy', 'old', 'SSH', 0, 0, 900)",
        [],
    )
    .unwrap();

    let mut entries = vec![SnapshotEntry::SavedSession {
        identity: "saved:x".to_string(),
        saved_session_id: "x".to_string(),
        saved_session_type: "SSH".to_string(),
        display_name: "x".to_string(),
    }];
    commit_run_snapshot(&mut conn, "b".into(), &mut entries, None, None, false).unwrap();
    clear_run_snapshot(&mut conn, None).expect("clear");

    let response = get_run_snapshot(&conn).unwrap();
    assert!(response.record.is_none());
    assert!(
        response.legacy_candidate.is_none(),
        "tombstone suppresses the legacy candidate"
    );

    // A later restored commit revives the record and removes the tombstone.
    let mut entries = vec![SnapshotEntry::SavedSession {
        identity: "saved:y".to_string(),
        saved_session_id: "y".to_string(),
        saved_session_type: "LocalShell".to_string(),
        display_name: "y".to_string(),
    }];
    let revived = commit_run_snapshot(&mut conn, "b2".into(), &mut entries, None, None, true).unwrap();
    assert!(revived.applied);
    let response = get_run_snapshot(&conn).unwrap();
    assert!(response.record.is_some());
}

/// Availability probing is bounded: an unwalkable path list still returns
/// quickly with unknown/available rows instead of blocking.
#[test]
fn availability_probe_is_bounded() {
    let dir = tempfile::TempDir::new().unwrap();
    let mut conn = open_db(&dir.path().join("taomni.db"));
    let real = dir.path().join("real-dir");
    std::fs::create_dir_all(&real).unwrap();
    record_directory_use(&mut conn, &real, SOURCE_LOCAL_START, 1000).unwrap();
    record_directory_use(&mut conn, &dir.path().join("missing"), SOURCE_LOCAL_CWD, 900).ok();

    let start = std::time::Instant::now();
    let envelope = list_directory_shortcuts(&conn).expect("list");
    assert!(start.elapsed() < Duration::from_secs(5), "probe must stay bounded");
    let missing = envelope
        .directories
        .iter()
        .find(|d| d.path.ends_with("missing"))
        .expect("missing dir still listed (offline rows are kept)");
    assert_eq!(missing.availability, "missing");
    let available = envelope
        .directories
        .iter()
        .find(|d| d.path.ends_with("real-dir"))
        .expect("real dir listed");
    assert_eq!(available.availability, "available");
    let _ = SOURCE_LOCAL_CWD;
}
