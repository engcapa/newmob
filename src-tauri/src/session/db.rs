use super::models::{AuthMethod, SessionConfig, SessionGroup, SessionType};
use rusqlite::{params, Connection, Result as SqlResult};

pub fn init_db(conn: &Connection) -> SqlResult<()> {
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

        CREATE TABLE IF NOT EXISTS session_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            icon TEXT,
            FOREIGN KEY (parent_id) REFERENCES session_groups(id)
        );

        CREATE TABLE IF NOT EXISTS command_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_key TEXT NOT NULL,
            command TEXT NOT NULL,
            last_used_at INTEGER NOT NULL,
            use_count INTEGER NOT NULL DEFAULT 1,
            UNIQUE(host_key, command)
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_path);
        CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(session_type);
        CREATE INDEX IF NOT EXISTS idx_history_host_time
            ON command_history(host_key, last_used_at DESC);",
    )
}

pub fn list_sessions(conn: &Connection, group: Option<&str>) -> SqlResult<Vec<SessionConfig>> {
    let results = if let Some(g) = group {
        let mut s = conn.prepare(
            "SELECT id, name, session_type, group_path, host, port, username,
                    auth_method, options_json, created_at, updated_at,
                    last_connected_at, sort_order
             FROM sessions WHERE group_path = ?1 ORDER BY sort_order, name",
        )?;
        let rows = s.query_map(params![g], row_to_session)?;
        rows.collect::<SqlResult<Vec<_>>>()?
    } else {
        let mut s = conn.prepare(
            "SELECT id, name, session_type, group_path, host, port, username,
                    auth_method, options_json, created_at, updated_at,
                    last_connected_at, sort_order
             FROM sessions ORDER BY sort_order, name",
        )?;
        let rows = s.query_map([], row_to_session)?;
        rows.collect::<SqlResult<Vec<_>>>()?
    };
    Ok(results)
}

fn row_to_session(row: &rusqlite::Row) -> SqlResult<SessionConfig> {
    Ok(SessionConfig {
        id: row.get(0)?,
        name: row.get(1)?,
        session_type: SessionType::from_str(&row.get::<_, String>(2)?),
        group_path: row.get(3)?,
        host: row.get(4)?,
        port: row.get(5)?,
        username: row.get(6)?,
        auth_method: AuthMethod::from_json(&row.get::<_, String>(7)?),
        options_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_connected_at: row.get(11)?,
        sort_order: row.get(12)?,
    })
}

pub fn get_session(conn: &Connection, id: &str) -> SqlResult<SessionConfig> {
    conn.query_row(
        "SELECT id, name, session_type, group_path, host, port, username,
                auth_method, options_json, created_at, updated_at,
                last_connected_at, sort_order
         FROM sessions WHERE id = ?1",
        params![id],
        row_to_session,
    )
}

pub fn save_session(conn: &Connection, config: &SessionConfig) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sessions
         (id, name, session_type, group_path, host, port, username,
          auth_method, options_json, created_at, updated_at,
          last_connected_at, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            config.id,
            config.name,
            config.session_type.as_str(),
            config.group_path,
            config.host,
            config.port,
            config.username,
            config.auth_method.to_json(),
            config.options_json,
            config.created_at,
            config.updated_at,
            config.last_connected_at,
            config.sort_order,
        ],
    )?;
    Ok(())
}

pub fn delete_session(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_last_connected(conn: &Connection, id: &str, ts: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE sessions SET last_connected_at = ?1 WHERE id = ?2",
        params![ts, id],
    )?;
    Ok(())
}

pub fn list_groups(conn: &Connection) -> SqlResult<Vec<SessionGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, sort_order, icon
         FROM session_groups ORDER BY sort_order, name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SessionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: row.get(2)?,
            sort_order: row.get(3)?,
            icon: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn save_group(conn: &Connection, group: &SessionGroup) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO session_groups (id, name, parent_id, sort_order, icon)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            group.id,
            group.name,
            group.parent_id,
            group.sort_order,
            group.icon
        ],
    )?;
    Ok(())
}

pub fn delete_group(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM session_groups WHERE id = ?1", params![id])?;
    Ok(())
}
