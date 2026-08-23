use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHistoryEntry {
    pub id: String,
    pub saved_session_id: Option<String>,
    pub engine: String,
    pub host: String,
    pub port: i64,
    pub catalog: Option<String>,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub sql_content: String,
    pub started_at: i64,
    pub duration_ms: Option<i64>,
    pub rows_affected: Option<i64>,
    pub row_count: Option<i64>,
    pub has_result_set: bool,
    pub error: Option<String>,
    pub created_at: i64,
}

fn row_to_history(row: &rusqlite::Row<'_>) -> SqlResult<DbHistoryEntry> {
    Ok(DbHistoryEntry {
        id: row.get(0)?,
        saved_session_id: row.get(1)?,
        engine: row.get(2)?,
        host: row.get(3)?,
        port: row.get(4)?,
        catalog: row.get(5)?,
        database_name: row.get(6)?,
        schema_name: row.get(7)?,
        sql_content: row.get(8)?,
        started_at: row.get(9)?,
        duration_ms: row.get(10)?,
        rows_affected: row.get(11)?,
        row_count: row.get(12)?,
        has_result_set: row.get::<_, i64>(13)? != 0,
        error: row.get(14)?,
        created_at: row.get(15)?,
    })
}

pub fn init_history_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sql_history (
            id TEXT PRIMARY KEY,
            saved_session_id TEXT,
            engine TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            catalog TEXT,
            database_name TEXT,
            schema_name TEXT,
            sql_content TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            duration_ms INTEGER,
            rows_affected INTEGER,
            row_count INTEGER,
            has_result_set INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sql_history_session_time
            ON sql_history(saved_session_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sql_history_engine_time
            ON sql_history(engine, started_at DESC);",
    )
}

pub fn append_history(conn: &Connection, entry: &DbHistoryEntry) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sql_history
         (id, saved_session_id, engine, host, port, catalog, database_name, schema_name,
          sql_content, started_at, duration_ms, rows_affected, row_count, has_result_set,
          error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            entry.id,
            entry.saved_session_id,
            entry.engine,
            entry.host,
            entry.port,
            entry.catalog,
            entry.database_name,
            entry.schema_name,
            entry.sql_content,
            entry.started_at,
            entry.duration_ms,
            entry.rows_affected,
            entry.row_count,
            if entry.has_result_set { 1 } else { 0 },
            entry.error,
            entry.created_at,
        ],
    )?;
    Ok(())
}

pub fn list_history(
    conn: &Connection,
    saved_session_id: Option<&str>,
    engine: Option<&str>,
    limit: i64,
) -> SqlResult<Vec<DbHistoryEntry>> {
    let capped = limit.clamp(1, 1000);
    let select = "SELECT id, saved_session_id, engine, host, port, catalog, database_name,
                         schema_name, sql_content, started_at, duration_ms, rows_affected,
                         row_count, has_result_set, error, created_at
                  FROM sql_history";
    let order = " ORDER BY started_at DESC, created_at DESC LIMIT ?";
    let rows = if let (Some(session_id), Some(engine)) = (saved_session_id, engine) {
        let mut stmt = conn.prepare(&format!(
            "{select} WHERE saved_session_id = ? AND engine = ? {order}"
        ))?;
        let rows = stmt
            .query_map(params![session_id, engine, capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    } else if let Some(session_id) = saved_session_id {
        let mut stmt = conn.prepare(&format!("{select} WHERE saved_session_id = ? {order}"))?;
        let rows = stmt
            .query_map(params![session_id, capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    } else if let Some(engine) = engine {
        let mut stmt = conn.prepare(&format!("{select} WHERE engine = ? {order}"))?;
        let rows = stmt
            .query_map(params![engine, capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    } else {
        let mut stmt = conn.prepare(&format!("{select}{order}"))?;
        let rows = stmt
            .query_map(params![capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    };
    Ok(rows)
}

pub fn delete_history(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM sql_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_history(conn: &Connection, saved_session_id: Option<&str>) -> SqlResult<()> {
    if let Some(session_id) = saved_session_id {
        conn.execute(
            "DELETE FROM sql_history WHERE saved_session_id = ?1",
            params![session_id],
        )?;
    } else {
        conn.execute("DELETE FROM sql_history", [])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn db_append_history(
    entry: DbHistoryEntry,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    append_history(&db, &entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_list_history(
    saved_session_id: Option<String>,
    engine: Option<String>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<DbHistoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    list_history(
        &db,
        saved_session_id.as_deref(),
        engine.as_deref(),
        limit.unwrap_or(200),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_delete_history(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    delete_history(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_clear_history(
    saved_session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    clear_history(&db, saved_session_id.as_deref()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_history_tables(&conn).unwrap();
        conn
    }

    fn entry(id: &str, session: &str, started_at: i64) -> DbHistoryEntry {
        DbHistoryEntry {
            id: id.to_string(),
            saved_session_id: Some(session.to_string()),
            engine: "PostgreSQL".to_string(),
            host: "localhost".to_string(),
            port: 5432,
            catalog: None,
            database_name: Some("app".to_string()),
            schema_name: Some("public".to_string()),
            sql_content: format!("select {started_at}"),
            started_at,
            duration_ms: Some(12),
            rows_affected: Some(0),
            row_count: Some(1),
            has_result_set: true,
            error: None,
            created_at: started_at,
        }
    }

    #[test]
    fn lists_history_by_session_newest_first() {
        let conn = memory_db();
        append_history(&conn, &entry("old", "s1", 10)).unwrap();
        append_history(&conn, &entry("new", "s1", 20)).unwrap();
        append_history(&conn, &entry("other", "s2", 30)).unwrap();

        let rows = list_history(&conn, Some("s1"), None, 10).unwrap();

        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old"]
        );
    }

    #[test]
    fn list_history_can_filter_session_and_engine() {
        let conn = memory_db();
        let mut postgres = entry("postgres", "s1", 10);
        postgres.engine = "PostgreSQL".to_string();
        let mut mysql = entry("mysql", "s1", 20);
        mysql.engine = "MySQL".to_string();
        append_history(&conn, &postgres).unwrap();
        append_history(&conn, &mysql).unwrap();

        let rows = list_history(&conn, Some("s1"), Some("PostgreSQL"), 10).unwrap();

        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["postgres"]
        );
    }

    #[test]
    fn clear_history_can_scope_to_one_session() {
        let conn = memory_db();
        append_history(&conn, &entry("one", "s1", 10)).unwrap();
        append_history(&conn, &entry("two", "s2", 20)).unwrap();

        clear_history(&conn, Some("s1")).unwrap();

        let rows = list_history(&conn, None, None, 10).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["two"]
        );
    }
}
