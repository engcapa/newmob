//! Welcome recents + run-batch integration (V-09B, D-01=B).
//!
//! Real tempfile SQLite + real temp directories: init → legacy import →
//! confirmed writes → close + reopen → same ordering/snapshot. No Tauri
//! WebView involved; the service-layer functions are exercised directly.

use rusqlite::Connection;
use std::path::PathBuf;
use taomni_lib::session::run_snapshot::{self, RunEntryInput, TempShell};
use taomni_lib::terminal::local_directories;

fn test_db() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let conn = Connection::open(dir.path().join("taomni.db")).expect("open db");
    taomni_lib::session::db::init_db(&conn).expect("init db");
    (dir, conn)
}

fn make_dirs(root: &std::path::Path) -> (PathBuf, PathBuf) {
    let a = root.join("workspace").join("A");
    let b = root.join("workspace").join("B");
    std::fs::create_dir_all(&a).expect("mkdir A");
    std::fs::create_dir_all(&b).expect("mkdir B");
    (a, b)
}

fn saved_entry(key: &str, order: i64, session_id: &str, kind: &str) -> RunEntryInput {
    RunEntryInput {
        entry_key: key.to_string(),
        order_index: order,
        kind: kind.to_string(),
        saved_session_id: Some(session_id.to_string()),
        saved_session_type: Some("SSH".to_string()),
        display_name: format!("entry {key}"),
        local_cwd: None,
        temp_shell: None,
        profile_ref: None,
    }
}

#[test]
fn directory_order_survives_reopen_and_uncommitted_rollback() {
    let (tmp, conn) = test_db();
    let (a, b) = make_dirs(tmp.path());
    let a_str = a.to_string_lossy().to_string();
    let b_str = b.to_string_lossy().to_string();

    local_directories::record_successful_use(&conn, &b_str, "local-start", 1000).expect("record B");
    local_directories::record_successful_use(&conn, &a_str, "local-start", 3000).expect("record A");
    // Stale response must not move A backwards.
    local_directories::record_successful_use(&conn, &a_str, "local-cwd", 500)
        .expect("stale record");

    let first = local_directories::list_directory_shortcuts(&conn).expect("list");
    let pos = |path: &str| {
        first
            .directories
            .iter()
            .position(|d| d.path == path)
            .expect("directory listed")
    };
    assert!(pos(&a_str) < pos(&b_str));
    let a_row = first.directories.iter().find(|d| d.path == a_str).unwrap();
    assert_eq!(a_row.last_used_at_ms, Some(3000));

    // Uncommitted transaction rolls back without a migration marker change.
    {
        let tx = conn.unchecked_transaction().expect("tx");
        tx.execute(
            "INSERT INTO welcome_directory_usage
             (directory_id, display_path, last_used_at_ms) VALUES ('ephemeral', '/tmp/ephemeral', 9999)",
            [],
        )
        .expect("insert");
        tx.rollback().expect("rollback");
    }

    drop(conn);
    let reopened = Connection::open(tmp.path().join("taomni.db")).expect("reopen");
    let second = local_directories::list_directory_shortcuts(&reopened).expect("re-list");
    let pos2 = |path: &str| {
        second
            .directories
            .iter()
            .position(|d| d.path == path)
            .expect("directory listed")
    };
    assert!(pos2(&a_str) < pos2(&b_str));
    assert!(
        second
            .directories
            .iter()
            .all(|d| d.path != "/tmp/ephemeral")
    );
}

#[test]
fn run_batch_order_active_and_clear_cas() {
    let (_tmp, conn) = test_db();
    let entries = vec![
        saved_entry("saved:ssh-b", 0, "ssh-b", "terminal"),
        saved_entry("saved:sftp-a", 1, "sftp-a", "sftp"),
        RunEntryInput {
            entry_key: "temp:local-1".to_string(),
            order_index: 2,
            kind: "terminal".to_string(),
            saved_session_id: None,
            saved_session_type: None,
            display_name: "temp".to_string(),
            local_cwd: Some("/tmp".to_string()),
            temp_shell: Some(TempShell {
                id: "bash".to_string(),
                name: "bash".to_string(),
                args: vec![],
            }),
            profile_ref: None,
        },
    ];
    let recorded = run_snapshot::record_snapshot(
        &conn,
        "run-1",
        &entries,
        Some("saved:sftp-a"),
        None,
        "0.4.22",
    )
    .expect("record");
    assert!(recorded.applied);
    assert_eq!(
        recorded
            .snapshot
            .entries
            .iter()
            .map(|e| e.entry_key.as_str())
            .collect::<Vec<_>>(),
        vec!["saved:ssh-b", "saved:sftp-a", "temp:local-1"]
    );
    assert_eq!(
        recorded.snapshot.active_entry_key.as_deref(),
        Some("saved:sftp-a")
    );

    // Empty snapshot never overwrites.
    let kept = run_snapshot::record_snapshot(&conn, "run-1", &[], None, None, "0.4.22")
        .expect("empty record");
    assert!(!kept.applied);
    assert_eq!(kept.snapshot.entries.len(), 3);

    // CAS conflict on clear protects the newer batch.
    assert!(run_snapshot::clear_snapshot(&conn, Some(9999)).is_err());
    assert!(run_snapshot::clear_snapshot(&conn, Some(recorded.snapshot.revision)).is_ok());
    let got = run_snapshot::get_snapshot(&conn).expect("get");
    assert!(got.snapshot.is_none());
}

#[test]
fn legacy_history_import_marks_observed_not_confirmed() {
    let (_tmp, conn) = test_db();
    conn.execute(
        "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', 'cd /tmp', 42)",
        [],
    )
    .expect("seed history");
    let migrated = local_directories::migrate_legacy_history(&conn).expect("migrate");
    assert!(migrated);
    let list = local_directories::list_directory_shortcuts(&conn).expect("list");
    let row = list
        .directories
        .iter()
        .find(|d| d.path == "/tmp")
        .expect("/tmp row");
    assert_eq!(row.last_used_at_ms, None);
    assert!(row.legacy_rank.is_some());
    // Second init does not re-import.
    assert!(!local_directories::migrate_legacy_history(&conn).expect("re-migrate"));
}
