use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use std::path::Path;

pub const VAULT_SCHEMA_VERSION: i64 = 1;

pub fn open(path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            schema_version INTEGER NOT NULL,
            kdf TEXT NOT NULL,
            kdf_salt BLOB NOT NULL,
            kdf_params TEXT NOT NULL,
            verifier_ciphertext BLOB NOT NULL,
            verifier_nonce BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            last_unlocked_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS vault_entries (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            nonce BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_vault_entries_kind
            ON vault_entries(kind);",
    )
}

#[derive(Debug, Clone)]
pub struct MetaRow {
    pub schema_version: i64,
    pub kdf: String,
    pub kdf_salt: Vec<u8>,
    pub kdf_params: String,
    pub verifier_ciphertext: Vec<u8>,
    pub verifier_nonce: Vec<u8>,
}

pub fn get_meta(conn: &Connection) -> SqlResult<Option<MetaRow>> {
    conn.query_row(
        "SELECT schema_version, kdf, kdf_salt, kdf_params, verifier_ciphertext, verifier_nonce
         FROM vault_meta WHERE id = 1",
        [],
        |row| {
            Ok(MetaRow {
                schema_version: row.get(0)?,
                kdf: row.get(1)?,
                kdf_salt: row.get(2)?,
                kdf_params: row.get(3)?,
                verifier_ciphertext: row.get(4)?,
                verifier_nonce: row.get(5)?,
            })
        },
    )
    .optional()
}

pub fn put_meta(
    conn: &Connection,
    kdf: &str,
    kdf_salt: &[u8],
    kdf_params: &str,
    verifier_ciphertext: &[u8],
    verifier_nonce: &[u8],
    created_at: i64,
) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO vault_meta
            (id, schema_version, kdf, kdf_salt, kdf_params,
             verifier_ciphertext, verifier_nonce, created_at, last_unlocked_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![
            VAULT_SCHEMA_VERSION,
            kdf,
            kdf_salt,
            kdf_params,
            verifier_ciphertext,
            verifier_nonce,
            created_at
        ],
    )?;
    Ok(())
}

pub fn touch_unlocked(conn: &Connection, ts: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE vault_meta SET last_unlocked_at = ?1 WHERE id = 1",
        params![ts],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct EntryRow {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EntrySummary {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn list_entries(conn: &Connection) -> SqlResult<Vec<EntrySummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, kind, created_at, updated_at
         FROM vault_entries ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(EntrySummary {
            id: row.get(0)?,
            label: row.get(1)?,
            kind: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn count_entries(conn: &Connection) -> SqlResult<i64> {
    conn.query_row("SELECT COUNT(*) FROM vault_entries", [], |row| row.get(0))
}

pub fn get_entry(conn: &Connection, id: &str) -> SqlResult<Option<EntryRow>> {
    conn.query_row(
        "SELECT id, label, kind, ciphertext, nonce, created_at, updated_at
         FROM vault_entries WHERE id = ?1",
        params![id],
        |row| {
            Ok(EntryRow {
                id: row.get(0)?,
                label: row.get(1)?,
                kind: row.get(2)?,
                ciphertext: row.get(3)?,
                nonce: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .optional()
}

pub fn insert_entry(
    conn: &Connection,
    id: &str,
    label: &str,
    kind: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    now: i64,
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO vault_entries
            (id, label, kind, ciphertext, nonce, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, label, kind, ciphertext, nonce, now],
    )?;
    Ok(())
}

pub fn upsert_entry(
    conn: &Connection,
    id: &str,
    label: &str,
    kind: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    now: i64,
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO vault_entries
            (id, label, kind, ciphertext, nonce, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            kind = excluded.kind,
            ciphertext = excluded.ciphertext,
            nonce = excluded.nonce,
            updated_at = excluded.updated_at",
        params![id, label, kind, ciphertext, nonce, now],
    )?;
    Ok(())
}

pub fn update_entry(
    conn: &Connection,
    id: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    now: i64,
) -> SqlResult<usize> {
    conn.execute(
        "UPDATE vault_entries
         SET ciphertext = ?2, nonce = ?3, updated_at = ?4
         WHERE id = ?1",
        params![id, ciphertext, nonce, now],
    )
}

pub fn delete_entry(conn: &Connection, id: &str) -> SqlResult<usize> {
    conn.execute("DELETE FROM vault_entries WHERE id = ?1", params![id])
}

pub fn list_all_for_rekey(conn: &Connection) -> SqlResult<Vec<EntryRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, kind, ciphertext, nonce, created_at, updated_at
         FROM vault_entries",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(EntryRow {
            id: row.get(0)?,
            label: row.get(1)?,
            kind: row.get(2)?,
            ciphertext: row.get(3)?,
            nonce: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}
