use crate::state::AppState;
use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbBookmark {
    pub id: String,
    pub name: String,
    pub sql_content: String,
    pub remarks: Option<String>,
    pub tags: Vec<String>,
    pub engine: String,
    pub database_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn list_bookmarks(conn: &Connection, engine: Option<&str>) -> SqlResult<Vec<DbBookmark>> {
    if let Some(eng) = engine {
        let mut stmt = conn.prepare(
            "SELECT id, name, sql_content, remarks, tags_json, engine, database_name, created_at, updated_at
             FROM sql_bookmarks WHERE engine = ?1 ORDER BY name ASC"
        )?;
        let rows = stmt.query_map(params![eng], |row| {
            let tags_json: String = row.get(4)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            Ok(DbBookmark {
                id: row.get(0)?,
                name: row.get(1)?,
                sql_content: row.get(2)?,
                remarks: row.get(3)?,
                tags,
                engine: row.get(5)?,
                database_name: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, name, sql_content, remarks, tags_json, engine, database_name, created_at, updated_at
             FROM sql_bookmarks ORDER BY name ASC"
        )?;
        let rows = stmt.query_map(params![], |row| {
            let tags_json: String = row.get(4)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            Ok(DbBookmark {
                id: row.get(0)?,
                name: row.get(1)?,
                sql_content: row.get(2)?,
                remarks: row.get(3)?,
                tags,
                engine: row.get(5)?,
                database_name: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }
}

pub fn save_bookmark(conn: &Connection, bookmark: &DbBookmark) -> SqlResult<()> {
    let tags_json = serde_json::to_string(&bookmark.tags).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT OR REPLACE INTO sql_bookmarks
         (id, name, sql_content, remarks, tags_json, engine, database_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            bookmark.id,
            bookmark.name,
            bookmark.sql_content,
            bookmark.remarks,
            tags_json,
            bookmark.engine,
            bookmark.database_name,
            bookmark.created_at,
            bookmark.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_bookmark(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM sql_bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub async fn db_list_bookmarks(
    engine: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<DbBookmark>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    list_bookmarks(&db, engine.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_save_bookmark(
    bookmark: DbBookmark,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    save_bookmark(&db, &bookmark).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_delete_bookmark(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    delete_bookmark(&db, &id).map_err(|e| e.to_string())
}
