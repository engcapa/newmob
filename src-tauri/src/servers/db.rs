//! SQLite persistence for per-server configuration.
//!
//! Mirrors the `state.db.lock()` pattern used elsewhere (see
//! `session/db.rs`): functions here take a `&Connection` and return
//! `rusqlite::Result`; the command layer in `mod.rs` owns the lock and maps
//! errors to `String`.

use std::collections::HashMap;

use rusqlite::{Connection, Result as SqlResult, params};

/// Create the `server_configs` table if it does not exist. Called from
/// `lib.rs` `setup()` right after `session::db::init_db`.
pub fn init_server_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS server_configs (
            server_type TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

/// Upsert the JSON config blob for one server type.
pub fn save_server_config(
    conn: &Connection,
    server_type: &str,
    config_json: &str,
) -> SqlResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT OR REPLACE INTO server_configs (server_type, config_json, updated_at)
         VALUES (?1, ?2, ?3)",
        params![server_type, config_json, now],
    )?;
    Ok(())
}

/// Load every persisted server config as a `serverType -> json` map. Rows whose
/// stored JSON fails to parse are skipped rather than failing the whole load.
pub fn load_server_configs(conn: &Connection) -> SqlResult<HashMap<String, serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT server_type, config_json FROM server_configs")?;
    let rows = stmt.query_map([], |row| {
        let server_type: String = row.get(0)?;
        let config_json: String = row.get(1)?;
        Ok((server_type, config_json))
    })?;

    let mut out = HashMap::new();
    for row in rows {
        let (server_type, config_json) = row?;
        match serde_json::from_str::<serde_json::Value>(&config_json) {
            Ok(value) => {
                out.insert(server_type, value);
            }
            Err(e) => {
                tracing::warn!("server_configs: bad JSON for {}: {}", server_type, e);
            }
        }
    }
    Ok(out)
}

/// Load one persisted config. Malformed JSON is treated as missing so callers
/// never accidentally reuse a partially parsed credential record.
pub fn load_server_config(
    conn: &Connection,
    server_type: &str,
) -> SqlResult<Option<serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT config_json FROM server_configs WHERE server_type = ?1")?;
    let mut rows = stmt.query(params![server_type])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let config_json: String = row.get(0)?;
    Ok(serde_json::from_str(&config_json).ok())
}
