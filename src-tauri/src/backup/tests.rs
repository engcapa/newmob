use super::crypto::{
    ERR_BACKUP_BAD_PASSWORD, decrypt_payload, encrypt_payload, is_encrypted_bytes,
};
use super::engine::{delete_backup_item, hot_backup_conn, list_backups, rotate_backups};
use super::manifest::BackupManifest;
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn test_hot_backup_vacuum_into() {
    let dir = tempdir().unwrap();
    let src_db = dir.path().join("source.db");
    let conn = Connection::open(&src_db).unwrap();

    conn.execute_batch(
        "CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT);
         INSERT INTO test_items (name) VALUES ('item1'), ('item2');",
    )
    .unwrap();

    let backup_db = dir.path().join("backup.db");
    hot_backup_conn(&conn, &backup_db).unwrap();
    assert!(backup_db.is_file());

    let backup_conn = Connection::open(&backup_db).unwrap();
    let count: i64 = backup_conn
        .query_row("SELECT count(*) FROM test_items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn test_manifest_roundtrip() {
    let mut manifest = BackupManifest::new("0.3.0".into(), "core".into(), false);
    manifest.add_file("databases/taomni.db".into(), "abc123sha".into(), 4096);

    let json = manifest.to_json_bytes().unwrap();
    let parsed = BackupManifest::from_json_bytes(&json).unwrap();
    assert_eq!(parsed.app_name, "Taomni");
    assert_eq!(parsed.app_version, "0.3.0");
    assert_eq!(parsed.files.len(), 1);
    assert_eq!(parsed.files[0].path, "databases/taomni.db");
}

#[test]
fn test_crypto_encryption_and_tamper_detection() {
    let data = b"Sensitive SQLite Database Bytes";
    let password = "CorrectPassword123#";

    let encrypted = encrypt_payload(data, password).unwrap();
    assert!(is_encrypted_bytes(&encrypted));

    // Wrong password
    let bad_pw_res = decrypt_payload(&encrypted, "WrongPassword");
    assert_eq!(bad_pw_res.unwrap_err(), ERR_BACKUP_BAD_PASSWORD);

    // Correct password
    let decrypted = decrypt_payload(&encrypted, password).unwrap();
    assert_eq!(&decrypted, data);
}

#[test]
fn test_rotate_and_delete_backups() {
    let dir = tempdir().unwrap();
    let backup_dir = dir.path().join("backups");
    std::fs::create_dir_all(&backup_dir).unwrap();

    // Create 5 fake backup files with distinct timestamps
    for i in 1..=5 {
        let file_path = backup_dir.join(format!("taomni_backup_2026090{i}_120000.taobak"));
        std::fs::write(&file_path, format!("backup content {i}")).unwrap();
    }

    let list = list_backups(&backup_dir).unwrap();
    assert_eq!(list.len(), 5);

    // Rotate to keep only 3
    rotate_backups(&backup_dir, 3).unwrap();
    let list_after = list_backups(&backup_dir).unwrap();
    assert_eq!(list_after.len(), 3);

    // Delete one item
    let first = list_after[0].file_name.clone();
    delete_backup_item(&backup_dir, &first).unwrap();
    let list_final = list_backups(&backup_dir).unwrap();
    assert_eq!(list_final.len(), 2);
}

#[test]
fn test_backup_restore_full_lifecycle_unencrypted() {
    use super::engine::{StagedFile, pack_staged_archive};
    use super::restore::{
        PENDING_RESTORE_DIR, RESTORE_INTENT_FILE, apply_pending_restore, inspect_archive,
        stage_restore_to_dir,
    };

    let dir = tempdir().unwrap();
    let app_data = dir.path().to_path_buf();

    // 1. Prepare mock databases in app_data
    let taomni_db_path = app_data.join("taomni.db");
    let notes_db_path = app_data.join("notes.db");
    let tunnels_path = app_data.join("tunnels.json");

    {
        let conn_taomni = Connection::open(&taomni_db_path).unwrap();
        conn_taomni
            .execute(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)",
                [],
            )
            .unwrap();
        conn_taomni
            .execute(
                "INSERT INTO sessions VALUES ('s1', 'Session 1'), ('s2', 'Session 2')",
                [],
            )
            .unwrap();

        let conn_notes = Connection::open(&notes_db_path).unwrap();
        conn_notes
            .execute("CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT)", [])
            .unwrap();
        conn_notes
            .execute("INSERT INTO notes VALUES ('n1', 'Note 1')", [])
            .unwrap();

        std::fs::write(&tunnels_path, r#"{"version": 1, "tunnels": []}"#).unwrap();
    }

    // 2. Perform hot backups using VACUUM INTO into temporary staging files
    let staging_dir = dir.path().join("staging");
    std::fs::create_dir_all(&staging_dir).unwrap();

    let staged_taomni = staging_dir.join("taomni.db");
    let staged_notes = staging_dir.join("notes.db");

    {
        let conn_taomni = Connection::open(&taomni_db_path).unwrap();
        hot_backup_conn(&conn_taomni, &staged_taomni).unwrap();
        let conn_notes = Connection::open(&notes_db_path).unwrap();
        hot_backup_conn(&conn_notes, &staged_notes).unwrap();
    }

    let staged_files = vec![
        StagedFile {
            archive_path: "databases/taomni.db".into(),
            disk_path: staged_taomni,
        },
        StagedFile {
            archive_path: "databases/notes.db".into(),
            disk_path: staged_notes,
        },
        StagedFile {
            archive_path: "configs/tunnels.json".into(),
            disk_path: tunnels_path.clone(),
        },
    ];

    let archive_path = dir.path().join("backup_test.taobak");
    let (manifest, size) =
        pack_staged_archive(&staged_files, "0.3.0", "core", None, &archive_path).unwrap();
    assert!(archive_path.is_file());
    assert!(size > 0);
    assert_eq!(manifest.files.len(), 3);

    // 3. Inspect archive
    let inspected = inspect_archive(&archive_path, None).unwrap();
    assert_eq!(inspected.app_version, "0.3.0");
    assert!(!inspected.encrypted);
    assert_eq!(inspected.files.len(), 3);

    // 4. Mutate live databases in app_data so we can verify restore rollback / replace
    {
        let conn_taomni = Connection::open(&taomni_db_path).unwrap();
        conn_taomni
            .execute("INSERT INTO sessions VALUES ('s3', 'Mutated Session')", [])
            .unwrap();
        let count: i64 = conn_taomni
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);

        std::fs::write(&tunnels_path, r#"{"version": 999}"#).unwrap();
    }

    // 5. Stage restore
    let stage_res = stage_restore_to_dir(&app_data, &archive_path, None).unwrap();
    assert!(stage_res.restart_required);
    assert!(app_data.join(RESTORE_INTENT_FILE).is_file());
    assert!(app_data.join(PENDING_RESTORE_DIR).is_dir());

    // 6. Apply pending restore
    apply_pending_restore(&app_data);

    // 7. Verify restore cleanup and safety copy
    assert!(!app_data.join(RESTORE_INTENT_FILE).exists());
    assert!(!app_data.join(PENDING_RESTORE_DIR).exists());

    let safety_copy = app_data
        .join("backups")
        .join("pre_restore_safety_copy")
        .join("taomni.db");
    assert!(safety_copy.is_file());
    let safety_conn = Connection::open(&safety_copy).unwrap();
    let safety_count: i64 = safety_conn
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        safety_count, 3,
        "Safety backup should preserve pre-restore state with 3 records"
    );

    // 8. Verify restored database has original 2 records
    let restored_conn = Connection::open(&taomni_db_path).unwrap();
    let restored_count: i64 = restored_conn
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        restored_count, 2,
        "Restored database should have original 2 records"
    );

    // Verify config restored
    let tunnels_content = std::fs::read_to_string(&tunnels_path).unwrap();
    assert!(tunnels_content.contains(r#""tunnels": []"#));
}

#[test]
fn test_backup_restore_full_lifecycle_encrypted() {
    use super::engine::{StagedFile, pack_staged_archive};
    use super::restore::{apply_pending_restore, inspect_archive, stage_restore_to_dir};

    let dir = tempdir().unwrap();
    let app_data = dir.path().to_path_buf();

    let taomni_db_path = app_data.join("taomni.db");
    {
        let conn = Connection::open(&taomni_db_path).unwrap();
        conn.execute("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)", [])
            .unwrap();
        conn.execute("INSERT INTO users VALUES ('u1', 'Alice')", [])
            .unwrap();
    }

    let staging_dir = dir.path().join("staging_enc");
    std::fs::create_dir_all(&staging_dir).unwrap();
    let staged_taomni = staging_dir.join("taomni.db");

    {
        let conn = Connection::open(&taomni_db_path).unwrap();
        hot_backup_conn(&conn, &staged_taomni).unwrap();
    }

    let staged_files = vec![StagedFile {
        archive_path: "databases/taomni.db".into(),
        disk_path: staged_taomni,
    }];

    let password = "SuperSecretPassword123!";
    let archive_path = dir.path().join("backup_enc.taobak");
    let (manifest, _) = pack_staged_archive(
        &staged_files,
        "0.3.0",
        "core",
        Some(password),
        &archive_path,
    )
    .unwrap();
    assert!(manifest.encrypted);

    // Inspect without password fails
    let err_no_pw = inspect_archive(&archive_path, None).unwrap_err();
    assert_eq!(err_no_pw, super::crypto::ERR_BACKUP_PASSWORD_REQUIRED);

    // Inspect with wrong password fails
    let err_bad_pw = inspect_archive(&archive_path, Some("WrongPassword")).unwrap_err();
    assert_eq!(err_bad_pw, super::crypto::ERR_BACKUP_BAD_PASSWORD);

    // Inspect with correct password succeeds
    let inspected = inspect_archive(&archive_path, Some(password)).unwrap();
    assert_eq!(inspected.files.len(), 1);
    assert!(inspected.encrypted);

    // Mutate live database
    {
        let conn = Connection::open(&taomni_db_path).unwrap();
        conn.execute("INSERT INTO users VALUES ('u2', 'Bob')", [])
            .unwrap();
    }

    // Stage restore with wrong password fails
    let stage_bad = stage_restore_to_dir(&app_data, &archive_path, Some("WrongPassword"));
    assert!(stage_bad.is_err());

    // Stage restore with correct password succeeds
    let stage_ok = stage_restore_to_dir(&app_data, &archive_path, Some(password)).unwrap();
    assert!(stage_ok.restart_required);

    // Apply restore
    apply_pending_restore(&app_data);

    // Verify restored database has only Alice
    let restored_conn = Connection::open(&taomni_db_path).unwrap();
    let count: i64 = restored_conn
        .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn test_backup_restore_vault_password_verification() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault.db");
    let vault = crate::vault::Vault::open(&vault_path).unwrap();

    // 1. Vault not initialized -> verify succeeds with or without password
    assert!(vault.verify_master_password(None).is_ok());

    // 2. Initialize vault with password
    let vault_pw = "MasterVaultPassword123#";
    vault.init(vault_pw).unwrap();

    // 3. Trying to verify without password yields ERR_VAULT_PASSWORD_REQUIRED
    let err_req = vault.verify_master_password(None).unwrap_err();
    assert_eq!(err_req, crate::vault::ERR_VAULT_PASSWORD_REQUIRED);

    // 4. Trying to verify with bad password yields ERR_VAULT_BAD_PASSWORD
    let err_bad = vault
        .verify_master_password(Some("wrong-password"))
        .unwrap_err();
    assert_eq!(err_bad, crate::vault::ERR_VAULT_BAD_PASSWORD);

    // 5. Correct password succeeds
    assert!(vault.verify_master_password(Some(vault_pw)).is_ok());
}
