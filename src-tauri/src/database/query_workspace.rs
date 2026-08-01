use std::collections::HashSet;

use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

const CLOSED_TAB_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryWorkspaceTab {
    pub workspace_id: String,
    pub panel_id: String,
    pub tab_order: i64,
    pub content: String,
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    pub saved_query_id: Option<String>,
    pub dirty: bool,
    pub is_open: bool,
    pub closed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryWorkspace {
    pub workspace_id: String,
    pub active_panel_id: Option<String>,
    pub tabs: Vec<DbQueryWorkspaceTab>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSaveQueryWorkspaceRequest {
    pub workspace_id: String,
    pub active_panel_id: Option<String>,
    pub tabs: Vec<DbQueryWorkspaceTab>,
    pub updated_at: i64,
}

fn row_to_workspace_tab(row: &rusqlite::Row<'_>) -> SqlResult<DbQueryWorkspaceTab> {
    Ok(DbQueryWorkspaceTab {
        workspace_id: row.get(0)?,
        panel_id: row.get(1)?,
        tab_order: row.get(2)?,
        content: row.get(3)?,
        file_path: row.get(4)?,
        file_name: row.get(5)?,
        saved_query_id: row.get(11)?,
        dirty: row.get::<_, i64>(6)? != 0,
        is_open: row.get::<_, i64>(7)? != 0,
        closed_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn init_query_workspace_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sql_query_workspace_state (
            workspace_id TEXT PRIMARY KEY,
            active_panel_id TEXT,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sql_query_workspace_tabs (
            workspace_id TEXT NOT NULL,
            panel_id TEXT NOT NULL,
            tab_order INTEGER NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            file_path TEXT,
            file_name TEXT,
            saved_query_id TEXT,
            dirty INTEGER NOT NULL DEFAULT 1,
            is_open INTEGER NOT NULL DEFAULT 1,
            closed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, panel_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sql_query_workspace_tabs_open
            ON sql_query_workspace_tabs(workspace_id, is_open, tab_order);
        CREATE INDEX IF NOT EXISTS idx_sql_query_workspace_tabs_closed
            ON sql_query_workspace_tabs(workspace_id, is_open, closed_at DESC);",
    )?;
    let has_saved_query_id = {
        let mut stmt = conn.prepare("PRAGMA table_info(sql_query_workspace_tabs)")?;
        stmt.query_map([], |row| row.get::<_, String>(1))?
            .collect::<SqlResult<Vec<_>>>()?
            .iter()
            .any(|column| column == "saved_query_id")
    };
    if !has_saved_query_id {
        conn.execute(
            "ALTER TABLE sql_query_workspace_tabs ADD COLUMN saved_query_id TEXT",
            [],
        )?;
    }
    Ok(())
}

pub fn load_query_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> SqlResult<Option<DbQueryWorkspace>> {
    let state = conn.query_row(
        "SELECT active_panel_id, updated_at
         FROM sql_query_workspace_state WHERE workspace_id = ?1",
        params![workspace_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
    );
    let (active_panel_id, updated_at) = match state {
        Ok(state) => state,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error),
    };

    let mut stmt = conn.prepare(
        "SELECT workspace_id, panel_id, tab_order, content, file_path, file_name,
                dirty, is_open, closed_at, created_at, updated_at, saved_query_id
         FROM sql_query_workspace_tabs
         WHERE workspace_id = ?1 AND is_open = 1
         ORDER BY tab_order ASC, created_at ASC",
    )?;
    let tabs = stmt
        .query_map(params![workspace_id], row_to_workspace_tab)?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(Some(DbQueryWorkspace {
        workspace_id: workspace_id.to_string(),
        active_panel_id,
        tabs,
        updated_at,
    }))
}

pub fn save_query_workspace(
    conn: &mut Connection,
    request: &DbSaveQueryWorkspaceRequest,
) -> SqlResult<()> {
    let transaction = conn.transaction()?;
    transaction.execute(
        "INSERT INTO sql_query_workspace_state (workspace_id, active_panel_id, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_id) DO UPDATE SET
             active_panel_id = excluded.active_panel_id,
             updated_at = excluded.updated_at",
        params![
            request.workspace_id,
            request.active_panel_id,
            request.updated_at
        ],
    )?;

    let mut panel_ids = HashSet::new();
    for tab in &request.tabs {
        if tab.workspace_id != request.workspace_id || !panel_ids.insert(tab.panel_id.as_str()) {
            return Err(rusqlite::Error::InvalidParameterName(
                "workspace tabs must use the request workspaceId and unique panelIds".to_string(),
            ));
        }
        transaction.execute(
            "INSERT INTO sql_query_workspace_tabs
             (workspace_id, panel_id, tab_order, content, file_path, file_name, saved_query_id,
              dirty, is_open, closed_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, NULL, ?9, ?10)
             ON CONFLICT(workspace_id, panel_id) DO UPDATE SET
                 tab_order = excluded.tab_order,
                 content = excluded.content,
                 file_path = excluded.file_path,
                 file_name = excluded.file_name,
                 saved_query_id = excluded.saved_query_id,
                 dirty = excluded.dirty,
                 is_open = 1,
                 closed_at = NULL,
                 updated_at = excluded.updated_at",
            params![
                request.workspace_id,
                tab.panel_id,
                tab.tab_order,
                tab.content,
                tab.file_path,
                tab.file_name,
                tab.saved_query_id,
                if tab.dirty { 1 } else { 0 },
                tab.created_at,
                tab.updated_at,
            ],
        )?;
    }

    prune_closed_query_workspace_tabs(&transaction, request.updated_at)?;

    transaction.commit()
}

pub fn close_query_workspace_tabs(
    conn: &Connection,
    workspace_id: &str,
    panel_ids: &[String],
    closed_at: i64,
) -> SqlResult<()> {
    for panel_id in panel_ids {
        conn.execute(
            "UPDATE sql_query_workspace_tabs
             SET is_open = 0, closed_at = ?3, updated_at = ?3
             WHERE workspace_id = ?1 AND panel_id = ?2",
            params![workspace_id, panel_id, closed_at],
        )?;
    }
    conn.execute(
        "UPDATE sql_query_workspace_state
         SET active_panel_id = NULL, updated_at = ?2
         WHERE workspace_id = ?1 AND active_panel_id IN (
             SELECT panel_id FROM sql_query_workspace_tabs
             WHERE workspace_id = ?1 AND is_open = 0
         )",
        params![workspace_id, closed_at],
    )?;
    Ok(())
}

pub fn list_closed_query_workspace_tabs(
    conn: &Connection,
    workspace_id: &str,
    limit: i64,
) -> SqlResult<Vec<DbQueryWorkspaceTab>> {
    let mut stmt = conn.prepare(
        "SELECT workspace_id, panel_id, tab_order, content, file_path, file_name,
                dirty, is_open, closed_at, created_at, updated_at, saved_query_id
         FROM sql_query_workspace_tabs
         WHERE workspace_id = ?1 AND is_open = 0
         ORDER BY closed_at DESC, updated_at DESC
         LIMIT ?2",
    )?;
    stmt.query_map(
        params![workspace_id, limit.clamp(1, 200)],
        row_to_workspace_tab,
    )?
    .collect::<SqlResult<Vec<_>>>()
}

pub fn reopen_query_workspace_tab(
    conn: &Connection,
    workspace_id: &str,
    panel_id: &str,
    tab_order: i64,
    updated_at: i64,
) -> SqlResult<bool> {
    let changed = conn.execute(
        "UPDATE sql_query_workspace_tabs
         SET is_open = 1, closed_at = NULL, tab_order = ?3, updated_at = ?4
         WHERE workspace_id = ?1 AND panel_id = ?2",
        params![workspace_id, panel_id, tab_order, updated_at],
    )?;
    Ok(changed > 0)
}

pub fn prune_closed_query_workspace_tabs(conn: &Connection, now: i64) -> SqlResult<usize> {
    conn.execute(
        "DELETE FROM sql_query_workspace_tabs
         WHERE is_open = 0 AND closed_at IS NOT NULL AND closed_at < ?1",
        params![now - CLOSED_TAB_RETENTION_MS],
    )
}

#[tauri::command]
pub async fn db_load_query_workspace(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Option<DbQueryWorkspace>, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    load_query_workspace(&db, &workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_save_query_workspace(
    request: DbSaveQueryWorkspaceRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|error| error.to_string())?;
    save_query_workspace(&mut db, &request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_close_query_workspace_tabs(
    workspace_id: String,
    panel_ids: Vec<String>,
    closed_at: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    close_query_workspace_tabs(&db, &workspace_id, &panel_ids, closed_at)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_list_closed_query_workspace_tabs(
    workspace_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<DbQueryWorkspaceTab>, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    list_closed_query_workspace_tabs(&db, &workspace_id, limit.unwrap_or(50))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_reopen_query_workspace_tab(
    workspace_id: String,
    panel_id: String,
    tab_order: i64,
    updated_at: i64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    reopen_query_workspace_tab(&db, &workspace_id, &panel_id, tab_order, updated_at)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_query_workspace_tables(&conn).unwrap();
        conn
    }

    fn tab(workspace_id: &str, panel_id: &str, tab_order: i64) -> DbQueryWorkspaceTab {
        DbQueryWorkspaceTab {
            workspace_id: workspace_id.to_string(),
            panel_id: panel_id.to_string(),
            tab_order,
            content: format!("select {tab_order}"),
            file_path: None,
            file_name: None,
            saved_query_id: None,
            dirty: true,
            is_open: true,
            closed_at: None,
            created_at: 100 + tab_order,
            updated_at: 200 + tab_order,
        }
    }

    #[test]
    fn saves_and_loads_workspace_tabs_in_order() {
        let mut conn = memory_db();
        save_query_workspace(
            &mut conn,
            &DbSaveQueryWorkspaceRequest {
                workspace_id: "saved-session".to_string(),
                active_panel_id: Some("second".to_string()),
                tabs: vec![
                    tab("saved-session", "second", 1),
                    tab("saved-session", "first", 0),
                ],
                updated_at: 300,
            },
        )
        .unwrap();

        let workspace = load_query_workspace(&conn, "saved-session")
            .unwrap()
            .unwrap();
        assert_eq!(workspace.active_panel_id.as_deref(), Some("second"));
        assert_eq!(
            workspace
                .tabs
                .iter()
                .map(|tab| tab.panel_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn adds_saved_query_link_to_existing_workspace_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sql_query_workspace_state (
                workspace_id TEXT PRIMARY KEY,
                active_panel_id TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE sql_query_workspace_tabs (
                workspace_id TEXT NOT NULL,
                panel_id TEXT NOT NULL,
                tab_order INTEGER NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                file_path TEXT,
                file_name TEXT,
                dirty INTEGER NOT NULL DEFAULT 1,
                is_open INTEGER NOT NULL DEFAULT 1,
                closed_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (workspace_id, panel_id)
            );",
        )
        .unwrap();

        init_query_workspace_tables(&conn).unwrap();

        let columns = conn
            .prepare("PRAGMA table_info(sql_query_workspace_tabs)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<SqlResult<Vec<_>>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "saved_query_id"));
    }

    #[test]
    fn updates_existing_tab_without_replacing_created_at() {
        let mut conn = memory_db();
        let mut original = tab("saved-session", "panel", 0);
        original.created_at = 10;
        save_query_workspace(
            &mut conn,
            &DbSaveQueryWorkspaceRequest {
                workspace_id: "saved-session".to_string(),
                active_panel_id: Some("panel".to_string()),
                tabs: vec![original],
                updated_at: 20,
            },
        )
        .unwrap();
        let mut updated = tab("saved-session", "panel", 0);
        updated.content = "select updated".to_string();
        updated.created_at = 999;
        updated.updated_at = 30;
        save_query_workspace(
            &mut conn,
            &DbSaveQueryWorkspaceRequest {
                workspace_id: "saved-session".to_string(),
                active_panel_id: Some("panel".to_string()),
                tabs: vec![updated],
                updated_at: 30,
            },
        )
        .unwrap();

        let workspace = load_query_workspace(&conn, "saved-session")
            .unwrap()
            .unwrap();
        assert_eq!(workspace.tabs[0].content, "select updated");
        assert_eq!(workspace.tabs[0].created_at, 10);
    }

    #[test]
    fn closes_and_reopens_recoverable_tabs() {
        let mut conn = memory_db();
        save_query_workspace(
            &mut conn,
            &DbSaveQueryWorkspaceRequest {
                workspace_id: "saved-session".to_string(),
                active_panel_id: Some("panel".to_string()),
                tabs: vec![tab("saved-session", "panel", 0)],
                updated_at: 300,
            },
        )
        .unwrap();

        close_query_workspace_tabs(&conn, "saved-session", &["panel".to_string()], 400).unwrap();
        let open = load_query_workspace(&conn, "saved-session")
            .unwrap()
            .unwrap();
        assert!(open.tabs.is_empty());
        let closed = list_closed_query_workspace_tabs(&conn, "saved-session", 50).unwrap();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].closed_at, Some(400));

        assert!(reopen_query_workspace_tab(&conn, "saved-session", "panel", 2, 500).unwrap());
        let reopened = load_query_workspace(&conn, "saved-session")
            .unwrap()
            .unwrap();
        assert_eq!(reopened.tabs[0].panel_id, "panel");
        assert_eq!(reopened.tabs[0].tab_order, 2);
    }

    #[test]
    fn rejects_mixed_workspace_tabs() {
        let mut conn = memory_db();
        let result = save_query_workspace(
            &mut conn,
            &DbSaveQueryWorkspaceRequest {
                workspace_id: "saved-session".to_string(),
                active_panel_id: None,
                tabs: vec![tab("other-session", "panel", 0)],
                updated_at: 300,
            },
        );
        assert!(result.is_err());
    }
}
