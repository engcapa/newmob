pub mod crypto;
pub mod db;

#[cfg(test)]
mod tests;

use crate::state::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const VAULT_REF_PREFIX: &str = "vault:";
pub const ERR_VAULT_LOCKED: &str = "VAULT_LOCKED";
pub const ERR_VAULT_EMPTY: &str = "VAULT_EMPTY";
pub const ERR_VAULT_BAD_PASSWORD: &str = "VAULT_BAD_PASSWORD";
pub const ERR_VAULT_PASSWORD_REQUIRED: &str = "VAULT_PASSWORD_REQUIRED";
pub const ERR_VAULT_NOT_FOUND: &str = "VAULT_NOT_FOUND";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultStateKind {
    Empty,
    Locked,
    Unlocked,
}

#[derive(Debug, Serialize)]
pub struct VaultStatus {
    pub state: VaultStateKind,
    pub entry_count: i64,
}

#[derive(Debug, Serialize)]
pub struct VaultPutResult {
    pub id: String,
    pub reference: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredKdfParams {
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
}

/// Owns the on-disk vault SQLite connection plus the in-memory unlock state.
/// Wrapped in a `Mutex` so all access is serialized; the operations are
/// already cheap (single-row reads, AEAD on small payloads).
pub struct Vault {
    inner: Mutex<VaultInner>,
}

struct VaultInner {
    conn: Connection,
    /// `Some` when unlocked. The key is zeroized on drop.
    root_key: Option<Zeroizing<[u8; crypto::KEY_LEN]>>,
}

impl Vault {
    pub fn open(path: &PathBuf) -> Result<Self, String> {
        let conn = db::open(path).map_err(|e| format!("vault db open: {}", e))?;
        Ok(Self {
            inner: Mutex::new(VaultInner {
                conn,
                root_key: None,
            }),
        })
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn state_kind(inner: &VaultInner) -> Result<VaultStateKind, String> {
        if inner.root_key.is_some() {
            return Ok(VaultStateKind::Unlocked);
        }
        match db::get_meta(&inner.conn).map_err(|e| e.to_string())? {
            Some(_) => Ok(VaultStateKind::Locked),
            None => Ok(VaultStateKind::Empty),
        }
    }

    pub fn status(&self) -> Result<VaultStatus, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let state = Self::state_kind(&inner)?;
        let entry_count = db::count_entries(&inner.conn).map_err(|e| e.to_string())?;
        Ok(VaultStatus { state, entry_count })
    }

    pub fn init(&self, master_password: &str) -> Result<(), String> {
        if master_password.len() < 8 {
            return Err("master password must be at least 8 characters".into());
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("vault already initialized".into());
        }

        let salt = crypto::random_salt();
        let root_key = crypto::derive_root_key(
            master_password,
            &salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )
        .map_err(|e| e.to_string())?;

        let verifier_nonce = crypto::random_nonce();
        let verifier_ciphertext =
            crypto::aead_encrypt(&root_key, &verifier_nonce, crypto::VERIFIER_PLAINTEXT)
                .map_err(|e| e.to_string())?;

        let params_json = serde_json::to_string(&StoredKdfParams {
            m_cost: crypto::ARGON2_M_COST,
            t_cost: crypto::ARGON2_T_COST,
            p_cost: crypto::ARGON2_P_COST,
        })
        .map_err(|e| e.to_string())?;

        db::put_meta(
            &inner.conn,
            "argon2id",
            &salt,
            &params_json,
            &verifier_ciphertext,
            &verifier_nonce,
            Self::now(),
        )
        .map_err(|e| e.to_string())?;

        inner.root_key = Some(root_key);
        let _ = db::touch_unlocked(&inner.conn, Self::now());
        Ok(())
    }

    /// Perform a consistent SQLite online hot-backup of the vault database.
    pub fn backup_to(&self, dest_path: &std::path::Path) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if dest_path.exists() {
            let _ = std::fs::remove_file(dest_path);
        }
        let dest_str = dest_path.to_str().ok_or("invalid destination path")?;
        inner
            .conn
            .execute("VACUUM INTO ?1", rusqlite::params![dest_str])
            .map_err(|e| format!("vault backup failed: {e}"))?;
        Ok(())
    }

    /// Check if the vault has been initialized (i.e. master password has been set).
    pub fn is_initialized(&self) -> Result<bool, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let meta = db::get_meta(&inner.conn).map_err(|e| e.to_string())?;
        Ok(meta.is_some())
    }

    /// Verify whether the provided master password is valid.
    /// - If vault is uninitialized (empty), returns `Ok(())` without checking.
    /// - If vault is initialized, requires a non-empty password and verifies it against the argon2id verifier.
    /// - On success, keeps the vault unlocked.
    pub fn verify_master_password(&self, password: Option<&str>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let meta = match db::get_meta(&inner.conn).map_err(|e| e.to_string())? {
            Some(m) => m,
            None => return Ok(()),
        };

        let pw = password.unwrap_or_default().trim();
        if pw.is_empty() {
            return Err(ERR_VAULT_PASSWORD_REQUIRED.to_string());
        }

        if meta.kdf != "argon2id" {
            return Err(format!("unsupported kdf: {}", meta.kdf));
        }
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;

        let root_key = crypto::derive_root_key(
            pw,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;

        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape".to_string())?;

        let plaintext = crypto::aead_decrypt(&root_key, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| ERR_VAULT_BAD_PASSWORD.to_string())?;

        if plaintext.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(ERR_VAULT_BAD_PASSWORD.to_string());
        }

        inner.root_key = Some(root_key);
        let _ = db::touch_unlocked(&inner.conn, Self::now());
        Ok(())
    }

    pub fn unlock(&self, master_password: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let meta = db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| ERR_VAULT_EMPTY.to_string())?;

        if meta.kdf != "argon2id" {
            return Err(format!("unsupported kdf: {}", meta.kdf));
        }
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;

        let root_key = crypto::derive_root_key(
            master_password,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;

        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape".to_string())?;

        let plaintext = crypto::aead_decrypt(&root_key, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| ERR_VAULT_BAD_PASSWORD.to_string())?;

        if plaintext.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(ERR_VAULT_BAD_PASSWORD.to_string());
        }

        inner.root_key = Some(root_key);
        let _ = db::touch_unlocked(&inner.conn, Self::now());
        Ok(())
    }

    pub fn lock(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.root_key = None;
        Ok(())
    }

    pub fn put(&self, kind: &str, label: &str, plaintext: &str) -> Result<VaultPutResult, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let key = inner
            .root_key
            .as_ref()
            .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;

        let id = Uuid::new_v4().to_string();
        let nonce = crypto::random_nonce();
        let ciphertext =
            crypto::aead_encrypt(key, &nonce, plaintext.as_bytes()).map_err(|e| e.to_string())?;
        db::insert_entry(
            &inner.conn,
            &id,
            label,
            kind,
            &ciphertext,
            &nonce,
            Self::now(),
        )
        .map_err(|e| e.to_string())?;

        Ok(VaultPutResult {
            reference: format!("{}{}", VAULT_REF_PREFIX, id),
            id,
        })
    }

    pub fn update(&self, id: &str, plaintext: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let key = inner
            .root_key
            .as_ref()
            .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;
        let nonce = crypto::random_nonce();
        let ciphertext =
            crypto::aead_encrypt(key, &nonce, plaintext.as_bytes()).map_err(|e| e.to_string())?;
        let updated = db::update_entry(&inner.conn, id, &ciphertext, &nonce, Self::now())
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err(ERR_VAULT_NOT_FOUND.to_string());
        }
        Ok(())
    }

    pub fn put_fixed(
        &self,
        id: &str,
        kind: &str,
        label: &str,
        plaintext: &str,
    ) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let key = inner
            .root_key
            .as_ref()
            .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;

        let nonce = crypto::random_nonce();
        let ciphertext =
            crypto::aead_encrypt(key, &nonce, plaintext.as_bytes()).map_err(|e| e.to_string())?;
        db::upsert_entry(
            &inner.conn,
            id,
            label,
            kind,
            &ciphertext,
            &nonce,
            Self::now(),
        )
        .map_err(|e| e.to_string())
    }

    pub fn get_fixed(&self, id: &str) -> Result<Option<Zeroizing<String>>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let key = inner
            .root_key
            .as_ref()
            .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;
        let Some(entry) = db::get_entry(&inner.conn, id).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let nonce: [u8; crypto::NONCE_LEN] = entry
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| "stored nonce shape".to_string())?;
        let plaintext_bytes =
            crypto::aead_decrypt(key, &nonce, &entry.ciphertext).map_err(|e| e.to_string())?;
        let plaintext_str = std::str::from_utf8(plaintext_bytes.as_slice())
            .map_err(|_| "stored plaintext is not utf-8".to_string())?
            .to_string();
        Ok(Some(Zeroizing::new(plaintext_str)))
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let removed = db::delete_entry(&inner.conn, id).map_err(|e| e.to_string())?;
        if removed == 0 {
            return Err(ERR_VAULT_NOT_FOUND.to_string());
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<db::EntrySummary>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        db::list_entries(&inner.conn).map_err(|e| e.to_string())
    }

    /// Resolve a `vault:<id>` reference to its plaintext. Used by the SSH /
    /// SFTP / VNC / tunnel / proxy connection paths. Returns:
    /// - `Ok(Some(plaintext))` when the reference resolves successfully.
    /// - `Ok(None)` when the input is *not* a vault reference (caller should
    ///   treat the original string as plaintext for backwards compat).
    /// - `Err(ERR_VAULT_LOCKED)` when the value is a reference but the vault
    ///   is locked (caller bubbles up so the UI can prompt for unlock).
    /// - other `Err(_)` for missing entries / decryption failures.
    pub fn resolve(&self, value: &str) -> Result<Option<Zeroizing<String>>, String> {
        let id = match value.strip_prefix(VAULT_REF_PREFIX) {
            Some(s) => s,
            None => return Ok(None),
        };
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let key = inner
            .root_key
            .as_ref()
            .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;
        let entry = db::get_entry(&inner.conn, id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| ERR_VAULT_NOT_FOUND.to_string())?;
        let nonce: [u8; crypto::NONCE_LEN] = entry
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| "stored nonce shape".to_string())?;
        let plaintext_bytes =
            crypto::aead_decrypt(key, &nonce, &entry.ciphertext).map_err(|e| e.to_string())?;
        let plaintext_str = std::str::from_utf8(plaintext_bytes.as_slice())
            .map_err(|_| "stored plaintext is not utf-8".to_string())?
            .to_string();
        Ok(Some(Zeroizing::new(plaintext_str)))
    }

    pub fn change_master(&self, old: &str, new: &str) -> Result<(), String> {
        if new.len() < 8 {
            return Err("new master password must be at least 8 characters".into());
        }

        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;

        let meta = db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| ERR_VAULT_EMPTY.to_string())?;
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;

        let old_key = crypto::derive_root_key(
            old,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;

        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape".to_string())?;
        let probe = crypto::aead_decrypt(&old_key, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| ERR_VAULT_BAD_PASSWORD.to_string())?;
        if probe.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(ERR_VAULT_BAD_PASSWORD.to_string());
        }

        // Derive a fresh new salt + key.
        let new_salt = crypto::random_salt();
        let new_key = crypto::derive_root_key(
            new,
            &new_salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )
        .map_err(|e| e.to_string())?;

        // Rewrap every entry under the new key in a single transaction so a
        // crash mid-rekey does not leave the DB inconsistent.
        let entries = db::list_all_for_rekey(&inner.conn).map_err(|e| e.to_string())?;
        let tx = inner
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for e in entries {
            let entry_nonce: [u8; crypto::NONCE_LEN] = e
                .nonce
                .as_slice()
                .try_into()
                .map_err(|_| "stored nonce shape".to_string())?;
            let plain = crypto::aead_decrypt(&old_key, &entry_nonce, &e.ciphertext)
                .map_err(|e| e.to_string())?;
            let new_nonce = crypto::random_nonce();
            let new_ct = crypto::aead_encrypt(&new_key, &new_nonce, plain.as_slice())
                .map_err(|e| e.to_string())?;
            db::update_entry(&tx, &e.id, &new_ct, &new_nonce, Self::now())
                .map_err(|e| e.to_string())?;
        }

        // Rewrap the verifier and rewrite meta.
        let new_verifier_nonce = crypto::random_nonce();
        let new_verifier_ct =
            crypto::aead_encrypt(&new_key, &new_verifier_nonce, crypto::VERIFIER_PLAINTEXT)
                .map_err(|e| e.to_string())?;
        let new_params_json = serde_json::to_string(&StoredKdfParams {
            m_cost: crypto::ARGON2_M_COST,
            t_cost: crypto::ARGON2_T_COST,
            p_cost: crypto::ARGON2_P_COST,
        })
        .map_err(|e| e.to_string())?;
        db::put_meta(
            &tx,
            "argon2id",
            &new_salt,
            &new_params_json,
            &new_verifier_ct,
            &new_verifier_nonce,
            Self::now(),
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;
        inner.root_key = Some(new_key);
        Ok(())
    }
}

// ---------- Tauri command handlers ----------

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    state.vault.status()
}

#[tauri::command]
pub async fn vault_init(master_password: String, state: State<'_, AppState>) -> Result<(), String> {
    state.vault.init(&master_password)
}

#[tauri::command]
pub async fn vault_unlock(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.vault.unlock(&master_password)?;
    // Vault transitioned to unlocked — rebuild the LLM router so providers
    // whose api_key is `vault:<id>` start working immediately. Without this
    // the user has to click Save in AI Settings to trigger a rebuild.
    let cfg = {
        let ai_ctx = state.ai_ctx.read().await;
        ai_ctx.config.clone()
    };
    let llm = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::llm::router::build_router_from_ai_with_proxy_db(
            &cfg,
            Some(state.vault.as_ref()),
            Some(&db),
        )
    };
    let mut ai_ctx = state.ai_ctx.write().await;
    ai_ctx.replace_router(llm);
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<(), String> {
    state.vault.lock()?;
    // After lock, providers backed by vault refs can no longer authenticate;
    // rebuild so calls fail closed with VAULT_LOCKED instead of using stale
    // plaintext that was decrypted earlier.
    let cfg = {
        let ai_ctx = state.ai_ctx.read().await;
        ai_ctx.config.clone()
    };
    let llm = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::llm::router::build_router_from_ai_with_proxy_db(
            &cfg,
            Some(state.vault.as_ref()),
            Some(&db),
        )
    };
    let mut ai_ctx = state.ai_ctx.write().await;
    ai_ctx.replace_router(llm);
    Ok(())
}

#[tauri::command]
pub async fn vault_change_master(
    old_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.vault.change_master(&old_password, &new_password)?;
    let cfg = {
        let ai_ctx = state.ai_ctx.read().await;
        ai_ctx.config.clone()
    };
    let llm = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::llm::router::build_router_from_ai_with_proxy_db(
            &cfg,
            Some(state.vault.as_ref()),
            Some(&db),
        )
    };
    let mut ai_ctx = state.ai_ctx.write().await;
    ai_ctx.replace_router(llm);
    Ok(())
}

#[tauri::command]
pub async fn vault_put(
    kind: String,
    label: String,
    plaintext: String,
    state: State<'_, AppState>,
) -> Result<VaultPutResult, String> {
    state.vault.put(&kind, &label, &plaintext)
}

#[tauri::command]
pub async fn vault_update(
    id: String,
    plaintext: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.vault.update(&id, &plaintext)
}

#[tauri::command]
pub async fn vault_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.vault.delete(&id)
}

#[tauri::command]
pub async fn vault_list(state: State<'_, AppState>) -> Result<Vec<db::EntrySummary>, String> {
    state.vault.list()
}

/// Helper used by setup() to choose the on-disk vault path.
pub fn default_vault_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let mut p = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    p.push("vault.db");
    p
}
