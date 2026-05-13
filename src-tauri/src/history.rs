use crate::state::AppState;
use rusqlite::params;
use tauri::State;

const MAX_LIMIT: i64 = 50_000;
const MIN_LIMIT: i64 = 100;

fn clamp_cap(cap: i64) -> i64 {
    cap.clamp(MIN_LIMIT, MAX_LIMIT)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn history_append(
    host_key: String,
    command: String,
    max: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let trimmed = command.trim_matches(|c: char| c == '\r' || c == '\n');
    if trimmed.is_empty() {
        return Ok(());
    }

    let cap = clamp_cap(max);
    let ts = now_secs();

    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO command_history (host_key, command, last_used_at, use_count)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(host_key, command)
         DO UPDATE SET last_used_at = excluded.last_used_at,
                       use_count = use_count + 1",
        params![host_key, trimmed, ts],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM command_history
         WHERE host_key = ?1
           AND id NOT IN (
               SELECT id FROM command_history
               WHERE host_key = ?1
               ORDER BY last_used_at DESC
               LIMIT ?2
           )",
        params![host_key, cap],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn history_match_prefix(
    host_key: String,
    prefix: String,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let limit = limit.clamp(1, 500);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT command FROM command_history
             WHERE host_key = ?1 AND substr(command, 1, ?2) = ?3
             ORDER BY last_used_at DESC
             LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;

    let prefix_len = prefix.chars().count() as i64;
    let rows = stmt
        .query_map(params![host_key, prefix_len, prefix, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_list_recent(
    host_key: String,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let limit = limit.clamp(1, 2000);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT command FROM command_history
             WHERE host_key = ?1
             ORDER BY last_used_at DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![host_key, limit], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_clear(
    host_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    match host_key {
        Some(h) => {
            db.execute("DELETE FROM command_history WHERE host_key = ?1", params![h])
                .map_err(|e| e.to_string())?;
        }
        None => {
            db.execute("DELETE FROM command_history", [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
