//! Local persistence over `lanchat.sqlite` (phase 2 onward).
//!
//! Owns the schema (profile / peers / groups / group_members / conversations /
//! messages + indexes) and the CRUD used by discovery, messaging, and the
//! command surface. Uses the bundled `rusqlite`; the connection lives behind a
//! `std::sync::Mutex` (rusqlite `Connection` is not `Sync`), separate from the
//! main `taomni.db`.
//!
//! Phase 2 implements identity bootstrap + profile read/write. Later phases add
//! peers/groups/conversations/messages helpers on the same `LanChatStore`.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::lanchat::protocol::{PeerRecord, PresenceStatus};
use crate::vault::crypto;

/// SQLite-backed LanChat store. Single connection guarded by a mutex.
pub struct LanChatStore {
    conn: Mutex<Connection>,
    /// AES-256-GCM key for at-rest message-body encryption, loaded from the OS
    /// keychain (phase 3). When unset (e.g. store unit tests), bodies are stored
    /// in plaintext (`enc_ver = 0`) for backward compatibility.
    msg_key: OnceLock<Zeroizing<[u8; crypto::KEY_LEN]>>,
}

/// This node's own profile (single row in `profile`). Avatar bytes are carried
/// to/from the frontend as base64 (`avatarBase64`); the fingerprint `avh` is
/// the first 16 hex of the avatar's sha256.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar_base64: Option<String>,
    #[serde(default)]
    pub avatar_hash: Option<String>,
    #[serde(default)]
    pub signature: String,
    pub status: PresenceStatus,
    pub updated_at: i64,
}

/// A conversation (direct with a peer, or a group). For direct chats the id is
/// deterministic (`direct:<otherNodeId>`) so both peers map to a stable thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// "direct" | "group".
    pub kind: String,
    /// Peer node id (direct) or group id (group).
    pub peer_or_group_id: String,
    pub last_msg_at: i64,
    pub unread: i64,
}

/// A chat message. `mentions` is a list of node ids; persisted as a JSON array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanMessage {
    pub id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub body: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at: i64,
    /// "sending" | "sent" | "delivered" | "failed".
    pub state: String,
}

/// Stable conversation id for a direct chat with `peer_id`.
pub fn direct_conv_id(peer_id: &str) -> String {
    format!("direct:{peer_id}")
}

/// Stable conversation id for a group/channel.
pub fn group_conv_id(group_id: &str) -> String {
    format!("group:{group_id}")
}

/// A named group / channel and its current member node ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub members: Vec<String>,
}

/// Message retention policy (single `settings` row). `retention_days` / `max_per_conv`
/// of 0 disable that cap; `cleanup_enabled` gates the periodic sweep entirely.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSettings {
    pub retention_days: i64,
    pub max_per_conv: i64,
    pub cleanup_enabled: bool,
}

/// First 16 hex chars of the avatar's sha256 — the `avh` TXT fingerprint.
pub fn avatar_fingerprint(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex::encode(digest)[..16].to_string()
}

/// Decode a base64 avatar payload, tolerating a `data:<mime>;base64,` prefix.
pub fn decode_avatar_base64(s: &str) -> Result<Vec<u8>, String> {
    let raw = match s.split_once(";base64,") {
        Some((_, b64)) => b64,
        None => s,
    };
    BASE64
        .decode(raw.trim())
        .map_err(|e| format!("invalid avatar base64: {e}"))
}

fn default_display_name() -> String {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Taomni 用户".to_string())
}

/// Create all LanChat tables + indexes. Idempotent (`IF NOT EXISTS`).
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS profile (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            avatar      BLOB,
            avatar_hash TEXT,
            signature   TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'online',
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            avatar_hash TEXT,
            signature   TEXT NOT NULL DEFAULT '',
            last_seen   INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'offline'
        );
        CREATE TABLE IF NOT EXISTS groups (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            node_id  TEXT NOT NULL,
            PRIMARY KEY (group_id, node_id)
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL,
            peer_or_group_id TEXT NOT NULL,
            last_msg_at      INTEGER NOT NULL DEFAULT 0,
            unread           INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id         TEXT PRIMARY KEY,
            conv_id    TEXT NOT NULL,
            sender_id  TEXT NOT NULL,
            body       TEXT NOT NULL DEFAULT '',
            mentions   TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            state      TEXT NOT NULL DEFAULT 'sent'
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv_time
            ON messages (conv_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
            ON conversations (last_msg_at);
        CREATE TABLE IF NOT EXISTS pinned_keys (
            node_id    TEXT PRIMARY KEY,
            cert_der   BLOB NOT NULL,
            first_seen INTEGER NOT NULL,
            last_seen  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            retention_days  INTEGER NOT NULL DEFAULT 90,
            max_per_conv    INTEGER NOT NULL DEFAULT 5000,
            cleanup_enabled INTEGER NOT NULL DEFAULT 1
        );
        INSERT OR IGNORE INTO settings (id) VALUES (1);
        ",
    )
}

/// Run forward-compatible schema migrations. Each ALTER TABLE ADD COLUMN
/// is individually executed and "duplicate column" errors are silently ignored
/// so the migration is safe to re-run on already-migrated databases.
fn migrate_schema(conn: &Connection) {
    // v2: persist peer connection info for startup reconnection.
    // v3: persist this node's self-signed identity certificate (phase 1).
    // v4: at-rest message-body encryption (phase 3).
    // v5: "start LanChat on app launch" policy (single settings row).
    for ddl in [
        "ALTER TABLE peers ADD COLUMN addr TEXT",
        "ALTER TABLE peers ADD COLUMN port INTEGER",
        "ALTER TABLE profile ADD COLUMN cert_der BLOB",
        "ALTER TABLE messages ADD COLUMN body_cipher BLOB",
        "ALTER TABLE messages ADD COLUMN enc_ver INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE settings ADD COLUMN start_on_launch INTEGER NOT NULL DEFAULT 0",
    ] {
        if let Err(e) = conn.execute(ddl, []) {
            let msg = e.to_string();
            // "duplicate column name" is expected on re-runs; anything else is
            // worth logging but not fatal.
            if !msg.contains("duplicate column") {
                log::warn!("lanchat migrate: {ddl}: {e}");
            }
        }
    }
}

impl LanChatStore {
    /// Open (creating if needed) the `lanchat.sqlite` file and ensure schema.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // WAL keeps reads non-blocking during the frequent message writes.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        init_schema(&conn)?;
        migrate_schema(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            msg_key: OnceLock::new(),
        })
    }

    /// Perform a consistent SQLite online hot-backup of the lanchat database.
    pub fn backup_to(&self, dest_path: &Path) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if dest_path.exists() {
            let _ = std::fs::remove_file(dest_path);
        }
        let dest_str = dest_path.to_str().ok_or("invalid destination path")?;
        conn.execute("VACUUM INTO ?1", rusqlite::params![dest_str])
            .map_err(|e| format!("lanchat backup failed: {e}"))?;
        Ok(())
    }

    #[cfg(test)]
    fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        init_schema(&conn)?;
        migrate_schema(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            msg_key: OnceLock::new(),
        })
    }

    /// Return this node's stable id, generating + persisting a default profile
    /// row on first launch. Idempotent: later calls return the same id.
    pub fn ensure_identity(&self) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row("SELECT id FROM profile LIMIT 1", [], |r| r.get(0))
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO profile (id, name, avatar, avatar_hash, signature, status, updated_at)
             VALUES (?1, ?2, NULL, NULL, '', ?3, ?4)",
            params![
                id,
                default_display_name(),
                PresenceStatus::Online.as_txt(),
                now
            ],
        )?;
        Ok(id)
    }

    /// Read the persisted node id and (optional) self-signed cert DER, if the
    /// identity row exists. Used by identity bootstrap (phase 1) to decide
    /// whether to reuse the stored identity or generate a fresh one.
    pub fn get_profile_id_and_cert(&self) -> rusqlite::Result<Option<(String, Option<Vec<u8>>)>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id, cert_der FROM profile LIMIT 1", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
        })
        .optional()
    }

    /// Persist this node's self-certifying identity (node id + cert DER). When a
    /// row already exists under `old_id` it is migrated in place (the PRIMARY KEY
    /// is updated), preserving name/avatar/signature/status; otherwise a fresh
    /// default profile row is created.
    pub fn set_identity(
        &self,
        new_id: &str,
        cert_der: &[u8],
        old_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        match old_id {
            Some(old) if old != new_id => {
                conn.execute(
                    "UPDATE profile SET id = ?1, cert_der = ?2 WHERE id = ?3",
                    params![new_id, cert_der, old],
                )?;
            }
            Some(_) => {
                conn.execute(
                    "UPDATE profile SET cert_der = ?2 WHERE id = ?1",
                    params![new_id, cert_der],
                )?;
            }
            None => {
                let now = chrono::Utc::now().timestamp_millis();
                conn.execute(
                    "INSERT INTO profile (id, name, avatar, avatar_hash, signature, status, updated_at, cert_der)
                     VALUES (?1, ?2, NULL, NULL, '', ?3, ?4, ?5)",
                    params![
                        new_id,
                        default_display_name(),
                        PresenceStatus::Online.as_txt(),
                        now,
                        cert_der
                    ],
                )?;
            }
        }
        Ok(())
    }

    /// Rewrite our own outbound messages' sender id when the node id changes
    /// (legacy UUID -> self-certifying id), so "sent by me" detection survives.
    pub fn migrate_sender_id(&self, old_id: &str, new_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET sender_id = ?2 WHERE sender_id = ?1",
            params![old_id, new_id],
        )?;
        Ok(())
    }

    /// Drop the cached peer roster (used on identity migration: every peer's id
    /// changes network-wide under the hard cutover, so the cache is stale).
    pub fn clear_peers(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM peers", [])?;
        Ok(())
    }

    /// The pinned certificate DER for a peer id (trust-on-first-use record), if
    /// one has been recorded.
    pub fn get_pin(&self, node_id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT cert_der FROM pinned_keys WHERE node_id = ?1",
            params![node_id],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()
    }

    /// Record a peer's certificate on first sight (TOFU). No-op if already pinned.
    pub fn set_pin(&self, node_id: &str, cert_der: &[u8], now: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pinned_keys (node_id, cert_der, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(node_id) DO UPDATE SET last_seen = ?3",
            params![node_id, cert_der, now],
        )?;
        Ok(())
    }

    /// Forget a pinned peer (so the next connection re-pins via TOFU). Used by the
    /// "re-trust" command after a peer legitimately reinstalled.
    pub fn clear_pin(&self, node_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM pinned_keys WHERE node_id = ?1",
            params![node_id],
        )?;
        Ok(())
    }

    /// All pinned peers as `(node_id, first_seen, last_seen)`, newest first. For
    /// the security/identity view in the UI.
    pub fn list_pins(&self) -> rusqlite::Result<Vec<(String, i64, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT node_id, first_seen, last_seen FROM pinned_keys ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    /// Read this node's profile, if the identity row exists.
    pub fn get_profile(&self) -> rusqlite::Result<Option<Profile>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, avatar, avatar_hash, signature, status, updated_at
             FROM profile LIMIT 1",
            [],
            |r| {
                let avatar: Option<Vec<u8>> = r.get(2)?;
                let status: String = r.get(5)?;
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    avatar_base64: avatar.map(|b| BASE64.encode(b)),
                    avatar_hash: r.get(3)?,
                    signature: r.get(4)?,
                    status: PresenceStatus::from_txt(&status),
                    updated_at: r.get(6)?,
                })
            },
        )
        .optional()
    }

    /// Update the local profile. `avatar` of `Some` replaces the image and
    /// recomputes the fingerprint; `None` leaves the existing avatar intact.
    /// Returns the updated profile.
    pub fn update_profile(
        &self,
        name: &str,
        avatar: Option<Vec<u8>>,
        signature: &str,
        status: PresenceStatus,
    ) -> rusqlite::Result<Profile> {
        let id = self.ensure_identity()?;
        let now = chrono::Utc::now().timestamp_millis();
        {
            let conn = self.conn.lock().unwrap();
            match &avatar {
                Some(bytes) => {
                    let hash = avatar_fingerprint(bytes);
                    conn.execute(
                        "UPDATE profile
                         SET name=?1, avatar=?2, avatar_hash=?3, signature=?4, status=?5, updated_at=?6
                         WHERE id=?7",
                        params![name, bytes, hash, signature, status.as_txt(), now, id],
                    )?;
                }
                None => {
                    conn.execute(
                        "UPDATE profile
                         SET name=?1, signature=?2, status=?3, updated_at=?4
                         WHERE id=?5",
                        params![name, signature, status.as_txt(), now, id],
                    )?;
                }
            }
        }
        Ok(self
            .get_profile()?
            .expect("profile row exists immediately after update"))
    }

    /// Upsert a discovered peer into the `peers` cache.
    pub fn store_peer(&self, p: &PeerRecord) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO peers (id, name, avatar_hash, signature, last_seen, status, addr, port)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, avatar_hash=?3, signature=?4, last_seen=?5, status=?6,
               addr=COALESCE(?7, addr), port=COALESCE(?8, port)",
            params![
                p.id,
                p.name,
                p.avatar_hash,
                p.signature,
                p.last_seen,
                p.status.as_txt(),
                p.addr,
                p.port.map(|v| v as i64)
            ],
        )?;
        Ok(())
    }

    /// Mark a cached peer offline (kept in the cache for last-seen history).
    pub fn mark_peer_offline(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE peers SET status = 'offline' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Load every cached peer, including offline peers kept for display names
    /// and last-seen history.
    pub fn list_peers(&self) -> rusqlite::Result<Vec<PeerRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, avatar_hash, signature, last_seen, status, addr, port
             FROM peers
             ORDER BY lower(name), last_seen DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let status_str: String = r.get(5)?;
            let port_val: Option<i64> = r.get(7)?;
            Ok(PeerRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                avatar_hash: r.get(2)?,
                signature: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                last_seen: r.get(4)?,
                status: PresenceStatus::from_txt(&status_str),
                addr: r.get(6)?,
                port: port_val.and_then(|v| u16::try_from(v).ok()),
            })
        })?;
        rows.collect()
    }

    /// Load peers seen within `since_ms` milliseconds, with known addr+port.
    /// Used at startup to attempt reconnection to previously known peers.
    pub fn list_recent_peers(&self, since_ms: i64) -> Vec<PeerRecord> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - since_ms;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, avatar_hash, signature, last_seen, status, addr, port
                 FROM peers
                 WHERE last_seen > ?1 AND addr IS NOT NULL AND port IS NOT NULL
                 ORDER BY last_seen DESC",
            )
            .unwrap();
        stmt.query_map(params![cutoff], |r| {
            let status_str: String = r.get(5)?;
            let port_val: Option<i64> = r.get(7)?;
            Ok(PeerRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                avatar_hash: r.get(2)?,
                signature: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                last_seen: r.get(4)?,
                status: PresenceStatus::from_txt(&status_str),
                addr: r.get(6)?,
                port: port_val.and_then(|v| u16::try_from(v).ok()),
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// Ensure a conversation row exists, returning it. `kind` is "direct" or
    /// "group"; `peer_or_group_id` is the peer node id or group id.
    pub fn ensure_conversation(
        &self,
        id: &str,
        kind: &str,
        peer_or_group_id: &str,
    ) -> rusqlite::Result<Conversation> {
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO conversations (id, kind, peer_or_group_id, last_msg_at, unread)
                 VALUES (?1, ?2, ?3, 0, 0)
                 ON CONFLICT(id) DO NOTHING",
                params![id, kind, peer_or_group_id],
            )?;
        }
        Ok(self
            .get_conversation(id)?
            .expect("conversation exists after ensure"))
    }

    /// Read a conversation by id.
    pub fn get_conversation(&self, id: &str) -> rusqlite::Result<Option<Conversation>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, peer_or_group_id, last_msg_at, unread
             FROM conversations WHERE id = ?1",
            params![id],
            |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    peer_or_group_id: r.get(2)?,
                    last_msg_at: r.get(3)?,
                    unread: r.get(4)?,
                })
            },
        )
        .optional()
    }

    /// All conversations, most-recently-active first.
    pub fn list_conversations(&self) -> rusqlite::Result<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, peer_or_group_id, last_msg_at, unread
             FROM conversations ORDER BY last_msg_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                kind: r.get(1)?,
                peer_or_group_id: r.get(2)?,
                last_msg_at: r.get(3)?,
                unread: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Attach the at-rest message-encryption key (idempotent; first set wins).
    pub fn set_message_key(&self, key: &[u8]) {
        if key.len() != crypto::KEY_LEN {
            log::error!("lanchat: message key has wrong length {}", key.len());
            return;
        }
        let mut arr = [0u8; crypto::KEY_LEN];
        arr.copy_from_slice(key);
        let _ = self.msg_key.set(Zeroizing::new(arr));
    }

    /// Encrypt a body to `nonce || ciphertext`, or `None` when no key is attached
    /// (callers then store plaintext with `enc_ver = 0`).
    fn encrypt_body(&self, plaintext: &str) -> Option<Vec<u8>> {
        let key = self.msg_key.get()?;
        let nonce = crypto::random_nonce();
        let ct = crypto::aead_encrypt(key, &nonce, plaintext.as_bytes()).ok()?;
        let mut out = Vec::with_capacity(crypto::NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Some(out)
    }

    /// Decrypt a `nonce || ciphertext` body blob; empty string on any failure
    /// (missing key, truncated blob, wrong key).
    fn decrypt_body(&self, blob: &[u8]) -> String {
        let Some(key) = self.msg_key.get() else {
            return String::new();
        };
        if blob.len() < crypto::NONCE_LEN {
            return String::new();
        }
        let (nonce, ct) = blob.split_at(crypto::NONCE_LEN);
        let Ok(nonce) = <[u8; crypto::NONCE_LEN]>::try_from(nonce) else {
            return String::new();
        };
        match crypto::aead_decrypt(key, &nonce, ct) {
            Ok(pt) => String::from_utf8_lossy(&pt).to_string(),
            Err(_) => String::new(),
        }
    }

    /// Map a message row to [`LanMessage`], decrypting the body when it was stored
    /// encrypted (`enc_ver >= 1`). Expects columns: id, conv_id, sender_id, body,
    /// mentions, created_at, state, body_cipher, enc_ver.
    fn row_to_message(&self, r: &rusqlite::Row<'_>) -> rusqlite::Result<LanMessage> {
        let mentions_json: String = r.get(4)?;
        let mentions = serde_json::from_str::<Vec<String>>(&mentions_json).unwrap_or_default();
        let enc_ver: i64 = r.get(8)?;
        let body = if enc_ver >= 1 {
            let cipher: Option<Vec<u8>> = r.get(7)?;
            cipher.map(|c| self.decrypt_body(&c)).unwrap_or_default()
        } else {
            r.get::<_, String>(3)?
        };
        Ok(LanMessage {
            id: r.get(0)?,
            conv_id: r.get(1)?,
            sender_id: r.get(2)?,
            body,
            mentions,
            created_at: r.get(5)?,
            state: r.get(6)?,
        })
    }

    /// Insert a message (idempotent on id — duplicate deliveries are ignored).
    /// Returns true if the row was newly inserted.
    pub fn insert_message(&self, msg: &LanMessage) -> rusqlite::Result<bool> {
        let mentions = serde_json::to_string(&msg.mentions).unwrap_or_else(|_| "[]".into());
        // Encrypt the body when a key is attached; otherwise persist plaintext.
        let (body_plain, body_cipher, enc_ver): (String, Option<Vec<u8>>, i64) =
            match self.encrypt_body(&msg.body) {
                Some(ct) => (String::new(), Some(ct), 1),
                None => (msg.body.clone(), None, 0),
            };
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "INSERT INTO messages (id, conv_id, sender_id, body, mentions, created_at, state, body_cipher, enc_ver)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO NOTHING",
            params![
                msg.id,
                msg.conv_id,
                msg.sender_id,
                body_plain,
                mentions,
                msg.created_at,
                msg.state,
                body_cipher,
                enc_ver
            ],
        )?;
        Ok(changed > 0)
    }

    /// Encrypt any legacy plaintext message rows in place (run once after the key
    /// is attached). Returns the number of rows migrated.
    pub fn migrate_message_encryption(&self) -> rusqlite::Result<usize> {
        if self.msg_key.get().is_none() {
            return Ok(0);
        }
        let pending: Vec<(String, String)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt =
                conn.prepare("SELECT id, body FROM messages WHERE enc_ver = 0 AND body <> ''")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut migrated = 0;
        for (id, body) in pending {
            if let Some(ct) = self.encrypt_body(&body) {
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "UPDATE messages SET body_cipher = ?2, enc_ver = 1, body = '' WHERE id = ?1",
                    params![id, ct],
                )?;
                migrated += 1;
            }
        }
        Ok(migrated)
    }

    /// Update a message's delivery state ("sending"/"sent"/"delivered"/"failed").
    pub fn set_message_state(&self, id: &str, state: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET state = ?2 WHERE id = ?1",
            params![id, state],
        )?;
        Ok(())
    }

    /// Read a single message by id.
    pub fn get_message(&self, id: &str) -> rusqlite::Result<Option<LanMessage>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, conv_id, sender_id, body, mentions, created_at, state, body_cipher, enc_ver
             FROM messages WHERE id = ?1",
            params![id],
            |r| self.row_to_message(r),
        )
        .optional()
    }

    /// Recent messages for a conversation, oldest-first (last `limit`).
    pub fn list_messages(&self, conv_id: &str, limit: i64) -> rusqlite::Result<Vec<LanMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conv_id, sender_id, body, mentions, created_at, state, body_cipher, enc_ver FROM (
                 SELECT * FROM messages WHERE conv_id = ?1 ORDER BY created_at DESC LIMIT ?2
             ) ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conv_id, limit], |r| self.row_to_message(r))?;
        rows.collect()
    }

    /// Bump a conversation's last-activity time and optionally its unread count.
    pub fn touch_conversation(
        &self,
        conv_id: &str,
        last_msg_at: i64,
        unread_delta: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations
             SET last_msg_at = MAX(last_msg_at, ?2), unread = MAX(0, unread + ?3)
             WHERE id = ?1",
            params![conv_id, last_msg_at, unread_delta],
        )?;
        Ok(())
    }

    /// Clear a conversation's unread counter (message opened/read).
    pub fn reset_unread(&self, conv_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET unread = 0 WHERE id = ?1",
            params![conv_id],
        )?;
        Ok(())
    }

    /// Read the message-retention policy.
    pub fn get_retention(&self) -> rusqlite::Result<RetentionSettings> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT retention_days, max_per_conv, cleanup_enabled FROM settings WHERE id = 1",
            [],
            |r| {
                Ok(RetentionSettings {
                    retention_days: r.get(0)?,
                    max_per_conv: r.get(1)?,
                    cleanup_enabled: r.get::<_, i64>(2)? != 0,
                })
            },
        )
    }

    /// Update the message-retention policy.
    pub fn set_retention(&self, s: &RetentionSettings) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (id, retention_days, max_per_conv, cleanup_enabled)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
               retention_days = ?1, max_per_conv = ?2, cleanup_enabled = ?3",
            params![
                s.retention_days,
                s.max_per_conv,
                if s.cleanup_enabled { 1 } else { 0 }
            ],
        )?;
        Ok(())
    }

    /// Read the "start LanChat service on app launch" policy.
    pub fn get_start_on_launch(&self) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT start_on_launch FROM settings WHERE id = 1",
            [],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
    }

    /// Update the "start LanChat service on app launch" policy.
    pub fn set_start_on_launch(&self, enabled: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (id, start_on_launch) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET start_on_launch = ?1",
            params![if enabled { 1 } else { 0 }],
        )?;
        Ok(())
    }

    /// Apply the retention policy: delete messages older than `retention_days`
    /// and trim each conversation to its newest `max_per_conv`. A cap of 0
    /// disables that dimension. Returns the number of rows deleted.
    pub fn apply_retention(&self) -> rusqlite::Result<usize> {
        let s = self.get_retention()?;
        if !s.cleanup_enabled {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let mut deleted = 0usize;
        if s.retention_days > 0 {
            let cutoff = chrono::Utc::now().timestamp_millis() - s.retention_days * 86_400_000;
            deleted += conn.execute(
                "DELETE FROM messages WHERE created_at < ?1",
                params![cutoff],
            )?;
        }
        if s.max_per_conv > 0 {
            deleted += conn.execute(
                "DELETE FROM messages WHERE id IN (
                     SELECT id FROM (
                         SELECT id, ROW_NUMBER() OVER (
                             PARTITION BY conv_id ORDER BY created_at DESC
                         ) AS rn FROM messages
                     ) WHERE rn > ?1
                 )",
                params![s.max_per_conv],
            )?;
        }
        Ok(deleted)
    }

    /// Delete a single message by id.
    pub fn delete_message(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete all messages in a conversation and reset its counters.
    pub fn clear_conversation(&self, conv_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE conv_id = ?1", params![conv_id])?;
        conn.execute(
            "UPDATE conversations SET unread = 0, last_msg_at = 0 WHERE id = ?1",
            params![conv_id],
        )?;
        Ok(())
    }

    /// Delete all message history across every conversation.
    pub fn clear_all_history(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("UPDATE conversations SET unread = 0, last_msg_at = 0", [])?;
        Ok(())
    }

    /// Reclaim disk space after large deletions.
    pub fn vacuum(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("VACUUM", [])?;
        Ok(())
    }

    /// Create or rename a group.
    pub fn upsert_group(&self, id: &str, name: &str) -> rusqlite::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO groups (id, name, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = ?2",
            params![id, name, now],
        )?;
        Ok(())
    }

    /// Add a member to a group (idempotent).
    pub fn add_group_member(&self, group_id: &str, node_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO group_members (group_id, node_id) VALUES (?1, ?2)
             ON CONFLICT(group_id, node_id) DO NOTHING",
            params![group_id, node_id],
        )?;
        Ok(())
    }

    /// Remove a member from a group.
    pub fn remove_group_member(&self, group_id: &str, node_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM group_members WHERE group_id = ?1 AND node_id = ?2",
            params![group_id, node_id],
        )?;
        Ok(())
    }

    /// Member node ids of a group.
    pub fn list_group_members(&self, group_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT node_id FROM group_members WHERE group_id = ?1 ORDER BY node_id")?;
        let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    /// Read a group (with its members).
    pub fn get_group(&self, id: &str) -> rusqlite::Result<Option<Group>> {
        let row = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT id, name, created_at FROM groups WHERE id = ?1",
                params![id],
                |r| {
                    Ok(Group {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        created_at: r.get(2)?,
                        members: vec![],
                    })
                },
            )
            .optional()?
        };
        match row {
            Some(mut g) => {
                g.members = self.list_group_members(id)?;
                Ok(Some(g))
            }
            None => Ok(None),
        }
    }

    /// All groups (with members), newest first.
    pub fn list_groups(&self) -> rusqlite::Result<Vec<Group>> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT id FROM groups ORDER BY created_at DESC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(g) = self.get_group(&id)? {
                out.push(g);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_stable_across_calls() {
        let store = LanChatStore::open_in_memory().unwrap();
        let a = store.ensure_identity().unwrap();
        let b = store.ensure_identity().unwrap();
        assert_eq!(a, b, "node id must be stable");
        assert!(!a.is_empty());
    }

    #[test]
    fn default_profile_present_after_ensure() {
        let store = LanChatStore::open_in_memory().unwrap();
        let id = store.ensure_identity().unwrap();
        let p = store.get_profile().unwrap().expect("profile present");
        assert_eq!(p.id, id);
        assert!(!p.name.is_empty());
        assert_eq!(p.status, PresenceStatus::Online);
        assert!(p.avatar_base64.is_none());
    }

    #[test]
    fn update_profile_changes_fields_and_avatar_fingerprint() {
        let store = LanChatStore::open_in_memory().unwrap();
        store.ensure_identity().unwrap();

        let p1 = store
            .update_profile(
                "赵敏",
                Some(b"img-one".to_vec()),
                "设计即沟通",
                PresenceStatus::Busy,
            )
            .unwrap();
        assert_eq!(p1.name, "赵敏");
        assert_eq!(p1.signature, "设计即沟通");
        assert_eq!(p1.status, PresenceStatus::Busy);
        let h1 = p1.avatar_hash.clone().expect("fingerprint set");
        assert_eq!(h1.len(), 16);

        // Different avatar content -> different fingerprint.
        let p2 = store
            .update_profile(
                "赵敏",
                Some(b"img-two".to_vec()),
                "设计即沟通",
                PresenceStatus::Busy,
            )
            .unwrap();
        assert_ne!(h1, p2.avatar_hash.unwrap(), "fingerprint tracks content");

        // None avatar -> keeps existing image + hash.
        let p3 = store
            .update_profile("林开发", None, "摸鱼中", PresenceStatus::Away)
            .unwrap();
        assert_eq!(p3.name, "林开发");
        assert!(
            p3.avatar_base64.is_some(),
            "avatar retained when None passed"
        );
    }

    #[test]
    fn avatar_fingerprint_is_deterministic_16_hex() {
        let h = avatar_fingerprint(b"hello");
        assert_eq!(h.len(), 16);
        assert_eq!(h, avatar_fingerprint(b"hello"));
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    fn msg(id: &str, conv: &str, sender: &str, ts: i64, state: &str) -> LanMessage {
        LanMessage {
            id: id.into(),
            conv_id: conv.into(),
            sender_id: sender.into(),
            body: format!("body-{id}"),
            mentions: vec![],
            created_at: ts,
            state: state.into(),
        }
    }

    #[test]
    fn insert_message_is_idempotent_on_id() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-x");
        store
            .ensure_conversation(&conv, "direct", "peer-x")
            .unwrap();
        assert!(
            store
                .insert_message(&msg("m1", &conv, "peer-x", 100, "delivered"))
                .unwrap()
        );
        // duplicate delivery -> not inserted again
        assert!(
            !store
                .insert_message(&msg("m1", &conv, "peer-x", 100, "delivered"))
                .unwrap()
        );
        assert_eq!(store.list_messages(&conv, 50).unwrap().len(), 1);
    }

    #[test]
    fn messages_listed_oldest_first_within_limit() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-y");
        store
            .ensure_conversation(&conv, "direct", "peer-y")
            .unwrap();
        for (i, ts) in [(1, 300), (2, 100), (3, 200)] {
            store
                .insert_message(&msg(&format!("m{i}"), &conv, "me", ts, "sent"))
                .unwrap();
        }
        let got = store.list_messages(&conv, 2).unwrap();
        // last 2 by time (200, 300), returned oldest-first
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].created_at, 200);
        assert_eq!(got[1].created_at, 300);
    }

    #[test]
    fn conversation_unread_increments_and_resets() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-z");
        store
            .ensure_conversation(&conv, "direct", "peer-z")
            .unwrap();
        store.touch_conversation(&conv, 500, 1).unwrap();
        store.touch_conversation(&conv, 600, 1).unwrap();
        let c = store.get_conversation(&conv).unwrap().unwrap();
        assert_eq!(c.unread, 2);
        assert_eq!(c.last_msg_at, 600);
        store.reset_unread(&conv).unwrap();
        assert_eq!(store.get_conversation(&conv).unwrap().unwrap().unread, 0);
    }

    #[test]
    fn message_state_transitions() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-s");
        store
            .ensure_conversation(&conv, "direct", "peer-s")
            .unwrap();
        store
            .insert_message(&msg("ms", &conv, "me", 1, "sending"))
            .unwrap();
        store.set_message_state("ms", "delivered").unwrap();
        assert_eq!(store.get_message("ms").unwrap().unwrap().state, "delivered");
    }

    #[test]
    fn message_body_encrypted_at_rest_when_key_set() {
        let store = LanChatStore::open_in_memory().unwrap();
        store.set_message_key(&[7u8; 32]);
        let conv = direct_conv_id("peer-e");
        store
            .ensure_conversation(&conv, "direct", "peer-e")
            .unwrap();
        let mut m = msg("me1", &conv, "me", 10, "sent");
        m.body = "secret text".into();
        store.insert_message(&m).unwrap();

        // Round-trips through the decrypting read path.
        assert_eq!(
            store.get_message("me1").unwrap().unwrap().body,
            "secret text"
        );
        assert_eq!(
            store.list_messages(&conv, 10).unwrap()[0].body,
            "secret text"
        );

        // At rest the plaintext column is empty and the ciphertext is present.
        let conn = store.conn.lock().unwrap();
        let (plain, cipher, ev): (String, Option<Vec<u8>>, i64) = conn
            .query_row(
                "SELECT body, body_cipher, enc_ver FROM messages WHERE id = 'me1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(plain, "", "plaintext body not stored");
        assert!(cipher.is_some_and(|c| !c.is_empty()), "ciphertext stored");
        assert_eq!(ev, 1);
    }

    #[test]
    fn migrate_message_encryption_encrypts_legacy_rows() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-m");
        store
            .ensure_conversation(&conv, "direct", "peer-m")
            .unwrap();
        // Insert without a key -> stored plaintext (enc_ver 0).
        let mut m = msg("ml1", &conv, "me", 5, "delivered");
        m.body = "legacy plaintext".into();
        store.insert_message(&m).unwrap();

        store.set_message_key(&[3u8; 32]);
        assert_eq!(store.migrate_message_encryption().unwrap(), 1);
        assert_eq!(
            store.get_message("ml1").unwrap().unwrap().body,
            "legacy plaintext"
        );
        let conn = store.conn.lock().unwrap();
        let (plain, ev): (String, i64) = conn
            .query_row(
                "SELECT body, enc_ver FROM messages WHERE id='ml1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(plain, "");
        assert_eq!(ev, 1);
    }

    #[test]
    fn start_on_launch_defaults_off_and_persists() {
        let store = LanChatStore::open_in_memory().unwrap();
        // Fresh DB: opt-in policy is off by default.
        assert!(!store.get_start_on_launch().unwrap());
        store.set_start_on_launch(true).unwrap();
        assert!(store.get_start_on_launch().unwrap());
        store.set_start_on_launch(false).unwrap();
        assert!(!store.get_start_on_launch().unwrap());
    }

    #[test]
    fn retention_trims_by_age_and_count() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-r");
        store
            .ensure_conversation(&conv, "direct", "peer-r")
            .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let old = now - 100 * 86_400_000; // 100 days ago
        store
            .insert_message(&msg("old1", &conv, "me", old, "delivered"))
            .unwrap();
        for i in 0..5 {
            store
                .insert_message(&msg(&format!("r{i}"), &conv, "me", now - i, "delivered"))
                .unwrap();
        }
        store
            .set_retention(&RetentionSettings {
                retention_days: 90,
                max_per_conv: 3,
                cleanup_enabled: true,
            })
            .unwrap();
        let deleted = store.apply_retention().unwrap();
        assert!(deleted >= 1, "old + overflow rows deleted");
        let remaining = store.list_messages(&conv, 100).unwrap();
        assert!(remaining.len() <= 3, "trimmed to max_per_conv");
        assert!(
            !remaining.iter().any(|m| m.id == "old1"),
            "aged-out row gone"
        );
    }

    #[test]
    fn clear_conversation_and_all_history() {
        let store = LanChatStore::open_in_memory().unwrap();
        let c1 = direct_conv_id("a");
        let c2 = direct_conv_id("b");
        store.ensure_conversation(&c1, "direct", "a").unwrap();
        store.ensure_conversation(&c2, "direct", "b").unwrap();
        store
            .insert_message(&msg("x1", &c1, "me", 1, "sent"))
            .unwrap();
        store
            .insert_message(&msg("y1", &c2, "me", 1, "sent"))
            .unwrap();
        store.clear_conversation(&c1).unwrap();
        assert_eq!(store.list_messages(&c1, 10).unwrap().len(), 0);
        assert_eq!(store.list_messages(&c2, 10).unwrap().len(), 1);
        store.clear_all_history().unwrap();
        assert_eq!(store.list_messages(&c2, 10).unwrap().len(), 0);
    }

    #[test]
    fn group_membership_crud() {
        let store = LanChatStore::open_in_memory().unwrap();
        store.upsert_group("g1", "研发大群").unwrap();
        store.add_group_member("g1", "me").unwrap();
        store.add_group_member("g1", "zhao").unwrap();
        store.add_group_member("g1", "zhao").unwrap(); // idempotent
        let g = store.get_group("g1").unwrap().unwrap();
        assert_eq!(g.name, "研发大群");
        assert_eq!(g.members.len(), 2);
        store.remove_group_member("g1", "zhao").unwrap();
        assert_eq!(store.get_group("g1").unwrap().unwrap().members, vec!["me"]);
        // rename via upsert
        store.upsert_group("g1", "前端小队").unwrap();
        assert_eq!(store.get_group("g1").unwrap().unwrap().name, "前端小队");
        assert_eq!(store.list_groups().unwrap().len(), 1);
    }

    #[test]
    fn list_recent_peers_returns_peers_with_addr_port() {
        let store = LanChatStore::open_in_memory().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        // Peer with addr+port (recent)
        store
            .store_peer(&PeerRecord {
                id: "p1".into(),
                name: "Alice".into(),
                avatar_hash: None,
                signature: String::new(),
                status: PresenceStatus::Online,
                last_seen: now,
                addr: Some("192.168.1.10".into()),
                port: Some(4711),
            })
            .unwrap();
        // Peer without addr (should be excluded)
        store
            .store_peer(&PeerRecord {
                id: "p2".into(),
                name: "Bob".into(),
                avatar_hash: None,
                signature: String::new(),
                status: PresenceStatus::Online,
                last_seen: now,
                addr: None,
                port: None,
            })
            .unwrap();
        let recent = store.list_recent_peers(60_000); // last minute
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "p1");
        assert_eq!(recent[0].addr.as_deref(), Some("192.168.1.10"));
        assert_eq!(recent[0].port, Some(4711));
    }

    #[test]
    fn list_peers_keeps_cached_offline_names() {
        let store = LanChatStore::open_in_memory().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        store
            .store_peer(&PeerRecord {
                id: "peer-offline".into(),
                name: "周哲".into(),
                avatar_hash: None,
                signature: String::new(),
                status: PresenceStatus::Online,
                last_seen: now,
                addr: Some("192.168.1.55".into()),
                port: Some(4711),
            })
            .unwrap();
        store.mark_peer_offline("peer-offline").unwrap();

        let peers = store.list_peers().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].name, "周哲");
        assert_eq!(peers[0].status, PresenceStatus::Offline);
    }
}
