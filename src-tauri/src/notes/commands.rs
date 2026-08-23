//! Tauri command surface for Tao Notes. Each command locks the dedicated
//! `notes.db` connection held on [`AppState`] and delegates to [`super::db`].

use std::collections::HashMap;

use tauri::State;

use super::db::{
    self, CreateNoteInput, NoteAlert, NoteItem, NoteQuery, NoteStep, NoteTag, StepInput, TagInput,
    UpdateNoteInput,
};
use crate::state::AppState;

/// Lock the dedicated notes.db connection, mapping poison errors to a string.
macro_rules! notes_conn {
    ($state:expr) => {
        $state.notes_db.lock().map_err(|e| e.to_string())?
    };
}

#[tauri::command]
pub async fn notes_list(
    query: NoteQuery,
    state: State<'_, AppState>,
) -> Result<Vec<NoteItem>, String> {
    let conn = notes_conn!(state);
    db::list_notes(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_get(id: String, state: State<'_, AppState>) -> Result<Option<NoteItem>, String> {
    let conn = notes_conn!(state);
    db::get_note(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_create(
    input: CreateNoteInput,
    state: State<'_, AppState>,
) -> Result<NoteItem, String> {
    let conn = notes_conn!(state);
    db::create_note(&conn, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_update(
    id: String,
    patch: UpdateNoteInput,
    state: State<'_, AppState>,
) -> Result<Option<NoteItem>, String> {
    let conn = notes_conn!(state);
    db::update_note(&conn, &id, &patch).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = notes_conn!(state);
    db::delete_note(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_toggle_complete(
    id: String,
    completed: bool,
    state: State<'_, AppState>,
) -> Result<Option<NoteItem>, String> {
    let conn = notes_conn!(state);
    db::toggle_complete(&conn, &id, completed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_archive(
    id: String,
    archived: bool,
    state: State<'_, AppState>,
) -> Result<Option<NoteItem>, String> {
    let conn = notes_conn!(state);
    db::archive_note(&conn, &id, archived).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_list_tags(state: State<'_, AppState>) -> Result<Vec<NoteTag>, String> {
    let conn = notes_conn!(state);
    db::list_tags(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_upsert_tags(
    tags: Vec<TagInput>,
    state: State<'_, AppState>,
) -> Result<Vec<NoteTag>, String> {
    let conn = notes_conn!(state);
    db::upsert_tags(&conn, &tags).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_set_steps(
    note_id: String,
    steps: Vec<StepInput>,
    state: State<'_, AppState>,
) -> Result<Vec<NoteStep>, String> {
    let conn = notes_conn!(state);
    db::set_steps(&conn, &note_id, &steps).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_get_prefs(
    state: State<'_, AppState>,
) -> Result<HashMap<String, String>, String> {
    let conn = notes_conn!(state);
    db::get_prefs(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_set_prefs(
    prefs: HashMap<String, String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = notes_conn!(state);
    db::set_prefs(&conn, &prefs).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_list_alerts(
    now: Option<i64>,
    due_soon_secs: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<NoteAlert>, String> {
    let conn = notes_conn!(state);
    let now_ts = now.unwrap_or_else(db::now);
    let window = due_soon_secs.unwrap_or(db::DEFAULT_DUE_SOON_SECS);
    db::list_alerts(&conn, now_ts, window).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_ack_alert(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = notes_conn!(state);
    db::ack_alert(&conn, &id).map_err(|e| e.to_string())
}
