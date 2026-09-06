pub mod db;
pub mod import;
pub mod import_secrets;
pub mod models;
pub mod run_snapshot;

use crate::state::AppState;
use models::{SessionConfig, SessionGroup};
use tauri::State;

#[tauri::command]
pub async fn list_sessions(
    group: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SessionConfig>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::list_sessions(&db, group.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_session(id: String, state: State<'_, AppState>) -> Result<SessionConfig, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::get_session(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_session(config: SessionConfig, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::save_session(&db, &config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_session(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_session_connected(id: String, state: State<'_, AppState>) -> Result<i64, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::update_last_connected(&db, &id, ts).map_err(|e| e.to_string())?;
    Ok(ts)
}

#[tauri::command]
pub async fn list_session_groups(state: State<'_, AppState>) -> Result<Vec<SessionGroup>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::list_groups(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_session_group(
    group: SessionGroup,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::save_group(&db, &group).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session_group(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_group(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_welcome_run_snapshot(
    state: State<'_, AppState>,
) -> Result<run_snapshot::GetSnapshotResponse, String> {
    let db = state.db.lock().map_err(|e| format!("storage: {e}"))?;
    run_snapshot::get_snapshot(&db)
}

#[tauri::command]
pub async fn record_welcome_run_snapshot(
    run_id: String,
    entries: Vec<run_snapshot::RunEntryInput>,
    active_entry_key: Option<String>,
    expected_revision: Option<i64>,
    state: State<'_, AppState>,
) -> Result<run_snapshot::RecordSnapshotResponse, String> {
    // App version is informational for debugging downgrades; fall back safely.
    let app_version = "0.4.22".to_string();
    let db = state.db.lock().map_err(|e| format!("storage: {e}"))?;
    run_snapshot::record_snapshot(
        &db,
        &run_id,
        &entries,
        active_entry_key.as_deref(),
        expected_revision,
        &app_version,
    )
}

#[tauri::command]
pub async fn update_welcome_run_context(
    run_id: String,
    entry_key: String,
    local_cwd: String,
    expected_revision: i64,
    state: State<'_, AppState>,
) -> Result<run_snapshot::RecordSnapshotResponse, String> {
    let db = state.db.lock().map_err(|e| format!("storage: {e}"))?;
    run_snapshot::update_entry_context(&db, &run_id, &entry_key, &local_cwd, expected_revision)
}

#[tauri::command]
pub async fn clear_welcome_run_snapshot(
    expected_revision: Option<i64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| format!("storage: {e}"))?;
    run_snapshot::clear_snapshot(&db, expected_revision)
}
