use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

const SCOPE_CONNECTION: &str = "connection";
const SCOPE_ENGINE: &str = "engine";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbSavedQuery {
    pub id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub engine: String,
    pub catalog_name: Option<String>,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub namespace_key: String,
    pub name: String,
    pub content: String,
    pub remarks: Option<String>,
    pub tags: Vec<String>,
    pub revision: i64,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbListSavedQueriesRequest {
    pub connection_id: Option<String>,
    pub engine: Option<String>,
    pub catalog_name: Option<String>,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub include_all_namespaces: bool,
    pub include_archived: bool,
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn saved_query_namespace_key(
    catalog_name: Option<&str>,
    database_name: Option<&str>,
    schema_name: Option<&str>,
) -> String {
    let values = [
        clean_optional(catalog_name).unwrap_or_default(),
        clean_optional(database_name).unwrap_or_default(),
        clean_optional(schema_name).unwrap_or_default(),
    ];
    if values.iter().all(String::is_empty) {
        String::new()
    } else {
        serde_json::to_string(&values).unwrap_or_default()
    }
}

fn row_to_saved_query(row: &rusqlite::Row<'_>) -> SqlResult<DbSavedQuery> {
    let tags_json: String = row.get(11)?;
    Ok(DbSavedQuery {
        id: row.get(0)?,
        scope_type: row.get(1)?,
        scope_id: row.get(2)?,
        engine: row.get(3)?,
        catalog_name: row.get(4)?,
        database_name: row.get(5)?,
        schema_name: row.get(6)?,
        namespace_key: row.get(7)?,
        name: row.get(8)?,
        content: row.get(9)?,
        remarks: row.get(10)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        revision: row.get(12)?,
        archived_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

const SAVED_QUERY_SELECT: &str =
    "SELECT id, scope_type, scope_id, engine, catalog_name, database_name,
            schema_name, namespace_key, name, content, remarks, tags_json,
            revision, archived_at, created_at, updated_at
     FROM sql_queries";

pub fn init_saved_query_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sql_queries (
            id TEXT PRIMARY KEY,
            scope_type TEXT NOT NULL CHECK(scope_type IN ('connection', 'engine')),
            scope_id TEXT NOT NULL,
            engine TEXT NOT NULL,
            catalog_name TEXT,
            database_name TEXT,
            schema_name TEXT,
            namespace_key TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            remarks TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            revision INTEGER NOT NULL DEFAULT 1,
            archived_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sql_queries_unique_name
            ON sql_queries(scope_type, scope_id, namespace_key, name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_sql_queries_scope
            ON sql_queries(scope_type, scope_id, namespace_key, archived_at);
        CREATE INDEX IF NOT EXISTS idx_sql_queries_updated
            ON sql_queries(updated_at DESC);",
    )?;
    migrate_bookmarks_to_saved_queries(conn)
}

fn query_name_exists(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
    namespace_key: &str,
    name: &str,
    excluding_id: Option<&str>,
) -> SqlResult<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sql_queries
            WHERE scope_type = ?1 AND scope_id = ?2 AND namespace_key = ?3
              AND name = ?4 COLLATE NOCASE
              AND (?5 IS NULL OR id <> ?5)
        )",
        params![scope_type, scope_id, namespace_key, name, excluding_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
}

fn available_query_name(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
    namespace_key: &str,
    desired_name: &str,
    excluding_id: Option<&str>,
) -> SqlResult<String> {
    let base = if desired_name.trim().is_empty() {
        "Query"
    } else {
        desired_name.trim()
    };
    if !query_name_exists(
        conn,
        scope_type,
        scope_id,
        namespace_key,
        base,
        excluding_id,
    )? {
        return Ok(base.to_string());
    }
    for ordinal in 2..=100_000 {
        let candidate = if base == "Query" {
            format!("Query-{ordinal}")
        } else {
            format!("{base} ({ordinal})")
        };
        if !query_name_exists(
            conn,
            scope_type,
            scope_id,
            namespace_key,
            &candidate,
            excluding_id,
        )? {
            return Ok(candidate);
        }
    }
    Err(rusqlite::Error::InvalidParameterName(
        "unable to allocate a unique saved query name".to_string(),
    ))
}

pub fn next_saved_query_name(
    conn: &Connection,
    scope_type: &str,
    scope_id: &str,
    namespace_key: &str,
) -> SqlResult<String> {
    for ordinal in 1..=100_000 {
        let candidate = format!("Query-{ordinal}");
        if !query_name_exists(conn, scope_type, scope_id, namespace_key, &candidate, None)? {
            return Ok(candidate);
        }
    }
    Err(rusqlite::Error::InvalidParameterName(
        "unable to allocate the next saved query name".to_string(),
    ))
}

pub fn migrate_bookmarks_to_saved_queries(conn: &Connection) -> SqlResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, name, sql_content, remarks, tags_json, engine,
                database_name, created_at, updated_at
         FROM sql_bookmarks ORDER BY created_at ASC, id ASC",
    )?;
    let bookmarks = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?
        .collect::<SqlResult<Vec<_>>>()?;
    drop(stmt);

    for (id, name, content, remarks, tags_json, engine, database_name, created_at, updated_at) in
        bookmarks
    {
        let exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sql_queries WHERE id = ?1)",
            params![id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if exists {
            continue;
        }
        let migrated_name = available_query_name(conn, SCOPE_ENGINE, &engine, "", &name, None)?;
        conn.execute(
            "INSERT INTO sql_queries
             (id, scope_type, scope_id, engine, catalog_name, database_name,
              schema_name, namespace_key, name, content, remarks, tags_json,
              revision, archived_at, created_at, updated_at)
             VALUES (?1, 'engine', ?2, ?2, NULL, ?3, NULL, '', ?4, ?5, ?6, ?7,
                     1, NULL, ?8, ?9)",
            params![
                id,
                engine,
                database_name,
                migrated_name,
                content,
                remarks,
                tags_json,
                created_at,
                updated_at,
            ],
        )?;
    }
    Ok(())
}

pub fn list_saved_queries(
    conn: &Connection,
    request: &DbListSavedQueriesRequest,
) -> SqlResult<Vec<DbSavedQuery>> {
    let namespace_key = saved_query_namespace_key(
        request.catalog_name.as_deref(),
        request.database_name.as_deref(),
        request.schema_name.as_deref(),
    );
    let mut stmt = conn.prepare(&format!(
        "{SAVED_QUERY_SELECT}
         WHERE (?1 = 1 OR archived_at IS NULL)
           AND (
             (?2 IS NOT NULL AND scope_type = 'connection' AND scope_id = ?2)
             OR (?3 IS NOT NULL AND scope_type = 'engine' AND scope_id = ?3)
             OR (?2 IS NULL AND ?3 IS NULL)
           )
           AND (?4 = 1 OR namespace_key = '' OR namespace_key = ?5)
         ORDER BY archived_at IS NOT NULL ASC, name COLLATE NOCASE ASC, updated_at DESC"
    ))?;
    stmt.query_map(
        params![
            if request.include_archived { 1 } else { 0 },
            request.connection_id,
            request.engine,
            if request.include_all_namespaces { 1 } else { 0 },
            namespace_key,
        ],
        row_to_saved_query,
    )?
    .collect::<SqlResult<Vec<_>>>()
}

pub fn get_saved_query(conn: &Connection, id: &str) -> SqlResult<Option<DbSavedQuery>> {
    conn.query_row(
        &format!("{SAVED_QUERY_SELECT} WHERE id = ?1"),
        params![id],
        row_to_saved_query,
    )
    .optional()
}

pub fn save_saved_query(
    conn: &mut Connection,
    query: &DbSavedQuery,
) -> Result<DbSavedQuery, String> {
    let scope_type = query.scope_type.trim();
    if scope_type != SCOPE_CONNECTION && scope_type != SCOPE_ENGINE {
        return Err("saved query scopeType must be connection or engine".to_string());
    }
    let scope_id = query.scope_id.trim();
    let engine = query.engine.trim();
    if query.id.trim().is_empty() || scope_id.is_empty() || engine.is_empty() {
        return Err("saved query id, scopeId, and engine are required".to_string());
    }
    let catalog_name = clean_optional(query.catalog_name.as_deref());
    let database_name = clean_optional(query.database_name.as_deref());
    let schema_name = clean_optional(query.schema_name.as_deref());
    let namespace_key = saved_query_namespace_key(
        catalog_name.as_deref(),
        database_name.as_deref(),
        schema_name.as_deref(),
    );
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let current_revision = transaction
        .query_row(
            "SELECT revision FROM sql_queries WHERE id = ?1",
            params![query.id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let desired_name = if query.name.trim().is_empty() {
        next_saved_query_name(&transaction, scope_type, scope_id, &namespace_key)
            .map_err(|error| error.to_string())?
    } else {
        query.name.trim().to_string()
    };
    if query_name_exists(
        &transaction,
        scope_type,
        scope_id,
        &namespace_key,
        &desired_name,
        current_revision.map(|_| query.id.as_str()),
    )
    .map_err(|error| error.to_string())?
    {
        return Err(format!("saved_query_name_conflict:{desired_name}"));
    }
    let tags_json = serde_json::to_string(&query.tags).unwrap_or_else(|_| "[]".to_string());
    let revision = if let Some(current_revision) = current_revision {
        if current_revision != query.revision {
            return Err(format!(
                "saved_query_revision_conflict:{}:{}:{}",
                query.id, query.revision, current_revision
            ));
        }
        let next_revision = current_revision + 1;
        transaction
            .execute(
                "UPDATE sql_queries SET
                    scope_type = ?2, scope_id = ?3, engine = ?4, catalog_name = ?5,
                    database_name = ?6, schema_name = ?7, namespace_key = ?8,
                    name = ?9, content = ?10, remarks = ?11, tags_json = ?12,
                    revision = ?13, archived_at = ?14, updated_at = ?15
                 WHERE id = ?1",
                params![
                    query.id,
                    scope_type,
                    scope_id,
                    engine,
                    catalog_name,
                    database_name,
                    schema_name,
                    namespace_key,
                    desired_name,
                    query.content,
                    query.remarks,
                    tags_json,
                    next_revision,
                    query.archived_at,
                    query.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        next_revision
    } else {
        transaction
            .execute(
                "INSERT INTO sql_queries
                 (id, scope_type, scope_id, engine, catalog_name, database_name,
                  schema_name, namespace_key, name, content, remarks, tags_json,
                  revision, archived_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                         1, ?13, ?14, ?15)",
                params![
                    query.id,
                    scope_type,
                    scope_id,
                    engine,
                    catalog_name,
                    database_name,
                    schema_name,
                    namespace_key,
                    desired_name,
                    query.content,
                    query.remarks,
                    tags_json,
                    query.archived_at,
                    query.created_at,
                    query.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        1
    };

    let saved = transaction
        .query_row(
            &format!("{SAVED_QUERY_SELECT} WHERE id = ?1"),
            params![query.id],
            row_to_saved_query,
        )
        .map_err(|error| error.to_string())?;
    debug_assert_eq!(saved.revision, revision);
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(saved)
}

pub fn archive_saved_query(
    conn: &Connection,
    id: &str,
    revision: i64,
    archived_at: Option<i64>,
    updated_at: i64,
) -> Result<i64, String> {
    let changed = conn
        .execute(
            "UPDATE sql_queries
             SET archived_at = ?3, updated_at = ?4, revision = revision + 1
             WHERE id = ?1 AND revision = ?2",
            params![id, revision, archived_at, updated_at],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("saved_query_revision_conflict:{id}:{revision}"));
    }
    Ok(revision + 1)
}

pub fn delete_saved_query(conn: &Connection, id: &str) -> SqlResult<bool> {
    conn.execute("DELETE FROM sql_queries WHERE id = ?1", params![id])
        .map(|changed| changed > 0)
}

#[tauri::command]
pub async fn db_list_saved_queries(
    request: DbListSavedQueriesRequest,
    state: State<'_, AppState>,
) -> Result<Vec<DbSavedQuery>, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    list_saved_queries(&db, &request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_get_saved_query(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<DbSavedQuery>, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    get_saved_query(&db, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_save_saved_query(
    query: DbSavedQuery,
    state: State<'_, AppState>,
) -> Result<DbSavedQuery, String> {
    let mut db = state.db.lock().map_err(|error| error.to_string())?;
    save_saved_query(&mut db, &query)
}

#[tauri::command]
pub async fn db_archive_saved_query(
    id: String,
    revision: i64,
    archived_at: Option<i64>,
    updated_at: i64,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    archive_saved_query(&db, &id, revision, archived_at, updated_at)
}

#[tauri::command]
pub async fn db_delete_saved_query(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    delete_saved_query(&db, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sql_bookmarks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sql_content TEXT NOT NULL,
                remarks TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                engine TEXT NOT NULL,
                database_name TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        init_saved_query_tables(&conn).unwrap();
        conn
    }

    fn query(id: &str, engine: &str, scope_id: &str, name: &str) -> DbSavedQuery {
        DbSavedQuery {
            id: id.to_string(),
            scope_type: SCOPE_CONNECTION.to_string(),
            scope_id: scope_id.to_string(),
            engine: engine.to_string(),
            catalog_name: None,
            database_name: Some("app".to_string()),
            schema_name: Some("public".to_string()),
            namespace_key: String::new(),
            name: name.to_string(),
            content: "select 1".to_string(),
            remarks: None,
            tags: vec!["report".to_string()],
            revision: 1,
            archived_at: None,
            created_at: 100,
            updated_at: 100,
        }
    }

    fn list_request(connection_id: &str, engine: &str) -> DbListSavedQueriesRequest {
        DbListSavedQueriesRequest {
            connection_id: Some(connection_id.to_string()),
            engine: Some(engine.to_string()),
            catalog_name: None,
            database_name: Some("app".to_string()),
            schema_name: Some("public".to_string()),
            include_all_namespaces: false,
            include_archived: false,
        }
    }

    #[test]
    fn saves_connection_query_and_increments_revision() {
        let mut conn = memory_db();
        let saved = save_saved_query(&mut conn, &query("q1", "PostgreSQL", "s1", "Users")).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(get_saved_query(&conn, "q1").unwrap(), Some(saved.clone()));
        let mut edited = saved.clone();
        edited.content = "select * from users".to_string();
        edited.updated_at = 200;
        let edited = save_saved_query(&mut conn, &edited).unwrap();
        assert_eq!(edited.revision, 2);
        assert_eq!(edited.content, "select * from users");
    }

    #[test]
    fn rejects_stale_revision_and_duplicate_name() {
        let mut conn = memory_db();
        let original = save_saved_query(&mut conn, &query("q1", "MySQL", "s1", "Users")).unwrap();
        let duplicate = save_saved_query(&mut conn, &query("q2", "MySQL", "s1", "users"));
        assert!(
            duplicate
                .unwrap_err()
                .starts_with("saved_query_name_conflict:")
        );

        let mut current = original.clone();
        current.content = "select current".to_string();
        save_saved_query(&mut conn, &current).unwrap();
        let stale = save_saved_query(&mut conn, &original);
        assert!(
            stale
                .unwrap_err()
                .starts_with("saved_query_revision_conflict:")
        );
    }

    #[test]
    fn lists_connection_and_engine_queries_for_the_active_namespace() {
        let mut conn = memory_db();
        save_saved_query(
            &mut conn,
            &query("connection", "Oracle", "s1", "Connection"),
        )
        .unwrap();
        let mut engine_query = query("engine", "Oracle", "Oracle", "Shared");
        engine_query.scope_type = SCOPE_ENGINE.to_string();
        engine_query.database_name = None;
        engine_query.schema_name = None;
        save_saved_query(&mut conn, &engine_query).unwrap();
        save_saved_query(&mut conn, &query("other", "Oracle", "s2", "Other")).unwrap();

        let rows = list_saved_queries(&conn, &list_request("s1", "Oracle")).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["connection", "engine"]
        );
    }

    #[test]
    fn migrates_bookmarks_idempotently_without_losing_duplicate_names() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO sql_bookmarks
             (id, name, sql_content, remarks, tags_json, engine, database_name, created_at, updated_at)
             VALUES ('b1', 'Health', 'select 1', NULL, '[]', 'PostgreSQL', 'app', 10, 10),
                    ('b2', 'health', 'select 2', NULL, '[\"ops\"]', 'PostgreSQL', 'app', 20, 20)",
            [],
        )
        .unwrap();

        migrate_bookmarks_to_saved_queries(&conn).unwrap();
        migrate_bookmarks_to_saved_queries(&conn).unwrap();
        let rows = list_saved_queries(
            &conn,
            &DbListSavedQueriesRequest {
                connection_id: None,
                engine: Some("PostgreSQL".to_string()),
                catalog_name: None,
                database_name: None,
                schema_name: None,
                include_all_namespaces: true,
                include_archived: false,
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "Health");
        assert_eq!(rows[1].name, "health (2)");
        assert_eq!(rows[1].tags, vec!["ops"]);
    }

    #[test]
    fn allocates_query_names_per_scope_and_namespace() {
        let mut conn = memory_db();
        let mut first = query("q1", "ClickHouse", "s1", "Query-1");
        first.schema_name = None;
        save_saved_query(&mut conn, &first).unwrap();
        let namespace = saved_query_namespace_key(None, Some("app"), None);
        assert_eq!(
            next_saved_query_name(&conn, SCOPE_CONNECTION, "s1", &namespace).unwrap(),
            "Query-2"
        );
    }
}
