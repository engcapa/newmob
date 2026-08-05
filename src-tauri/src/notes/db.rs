//! Storage layer for the unified Tao Notes feature.
//!
//! Notes live in their own SQLite file (`notes.db`), deliberately kept separate
//! from `taomni.db` so the note data model, backup, and future encryption can
//! evolve independently (see `tao-notes-feature-plan.md`).
//!
//! All timestamps are Unix **seconds** (matching the chat module's `now()`), so
//! the frontend divides `Date.now()` by 1000 before sending times over IPC.

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Window (seconds) within which an upcoming `due_at` counts as "due soon".
pub const DEFAULT_DUE_SOON_SECS: i64 = 30 * 60;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NoteItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub completed_at: Option<i64>,
    pub pinned: bool,
    pub archived_at: Option<i64>,
    pub color: Option<String>,
    pub priority: i64,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub repeat_rule: Option<String>,
    pub source_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub source_uri: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub steps: Vec<NoteStep>,
    #[serde(default)]
    pub tags: Vec<NoteTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteStep {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub completed_at: Option<i64>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A live alert derived from a note's `due_at` / `reminder_at`, reconciled into
/// the `note_alert_events` table so acknowledgements persist across polls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteAlert {
    pub id: String,
    pub note_id: String,
    /// "overdue" | "due_soon" | "reminder"
    pub kind: String,
    /// "pending" | "acknowledged"
    pub state: String,
    pub fire_at: i64,
    pub acknowledged_at: Option<i64>,
    pub note_title: String,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NoteQuery {
    /// "recent_incomplete" (default) | "all" | "pinned" | "today" | "due_soon"
    /// | "overdue" | "completed" | "archived" | "tag"
    pub filter: Option<String>,
    /// Multi-select status filters. When present, filters are OR-combined.
    #[serde(default)]
    pub filters: Option<Vec<String>>,
    pub search: Option<String>,
    pub tag_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// Reference "now" (seconds) for time-based filters; defaults to server now.
    pub now: Option<i64>,
    /// Override the due-soon window in seconds.
    pub due_soon_secs: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreateNoteInput {
    pub title: Option<String>,
    pub body: Option<String>,
    pub pinned: Option<bool>,
    pub color: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub repeat_rule: Option<String>,
    pub source_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub source_uri: Option<String>,
    pub tag_ids: Option<Vec<String>>,
}

/// Full-replace patch: the editor sends the complete editable state on save, so
/// nullable fields (`due_at`, `color`, …) are cleared simply by sending null.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct UpdateNoteInput {
    pub title: String,
    pub body: String,
    pub pinned: Option<bool>,
    pub color: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub repeat_rule: Option<String>,
    pub source_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub source_uri: Option<String>,
    pub tag_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StepInput {
    pub id: Option<String>,
    pub title: String,
    pub completed_at: Option<i64>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TagInput {
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub fn init_db(conn: &Connection) -> SqlResult<()> {
    // Enforce ON DELETE CASCADE for steps / tag-links / alert events.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            completed_at INTEGER,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            color TEXT,
            priority INTEGER NOT NULL DEFAULT 0,
            due_at INTEGER,
            reminder_at INTEGER,
            repeat_rule TEXT,
            source_tab_id TEXT,
            source_session_id TEXT,
            source_title TEXT,
            source_uri TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_steps (
            id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL,
            title TEXT NOT NULL,
            completed_at INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS note_tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_tag_links (
            note_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (note_id, tag_id),
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES note_tags(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS note_prefs (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_alert_events (
            id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            fire_at INTEGER NOT NULL,
            acknowledged_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_notes_active
            ON notes(completed_at, archived_at, pinned, due_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_notes_due
            ON notes(due_at);
        CREATE INDEX IF NOT EXISTS idx_notes_reminder
            ON notes(reminder_at);
        CREATE INDEX IF NOT EXISTS idx_note_steps_note
            ON note_steps(note_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_note_alert_events_state
            ON note_alert_events(state, fire_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_note_alert_events_note_kind
            ON note_alert_events(note_id, kind);",
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const NOTE_COLUMNS: &str = "id, title, body, completed_at, pinned, archived_at, color, priority, \
     due_at, reminder_at, repeat_rule, source_tab_id, source_session_id, source_title, \
     source_uri, created_at, updated_at";

fn row_to_note(row: &rusqlite::Row) -> SqlResult<NoteItem> {
    Ok(NoteItem {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        completed_at: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        archived_at: row.get(5)?,
        color: row.get(6)?,
        priority: row.get(7)?,
        due_at: row.get(8)?,
        reminder_at: row.get(9)?,
        repeat_rule: row.get(10)?,
        source_tab_id: row.get(11)?,
        source_session_id: row.get(12)?,
        source_title: row.get(13)?,
        source_uri: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        steps: Vec::new(),
        tags: Vec::new(),
    })
}

fn row_to_step(row: &rusqlite::Row) -> SqlResult<NoteStep> {
    Ok(NoteStep {
        id: row.get(0)?,
        note_id: row.get(1)?,
        title: row.get(2)?,
        completed_at: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn row_to_tag(row: &rusqlite::Row) -> SqlResult<NoteTag> {
    Ok(NoteTag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

// ---------------------------------------------------------------------------
// Note CRUD
// ---------------------------------------------------------------------------

pub fn create_note(conn: &Connection, input: &CreateNoteInput) -> SqlResult<NoteItem> {
    let ts = now();
    let id = new_id();
    conn.execute(
        "INSERT INTO notes
         (id, title, body, completed_at, pinned, archived_at, color, priority,
          due_at, reminder_at, repeat_rule, source_tab_id, source_session_id,
          source_title, source_uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            input.title.clone().unwrap_or_default(),
            input.body.clone().unwrap_or_default(),
            input.pinned.unwrap_or(false) as i64,
            input.color,
            input.priority.unwrap_or(0),
            input.due_at,
            input.reminder_at,
            input.repeat_rule,
            input.source_tab_id,
            input.source_session_id,
            input.source_title,
            input.source_uri,
            ts,
            ts,
        ],
    )?;
    if let Some(tag_ids) = &input.tag_ids {
        set_note_tags(conn, &id, tag_ids)?;
    }
    get_note(conn, &id).map(|n| n.expect("note just inserted"))
}

pub fn get_note(conn: &Connection, id: &str) -> SqlResult<Option<NoteItem>> {
    let sql = format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1");
    let mut note = match conn
        .query_row(&sql, params![id], row_to_note)
        .optional()?
    {
        Some(n) => n,
        None => return Ok(None),
    };
    note.steps = load_steps_for(conn, id)?;
    note.tags = load_tags_for(conn, id)?;
    Ok(Some(note))
}

pub fn delete_note(conn: &Connection, id: &str) -> SqlResult<()> {
    // Steps / tag-links / alert events cascade via FK.
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn toggle_complete(conn: &Connection, id: &str, completed: bool) -> SqlResult<Option<NoteItem>> {
    let ts = now();
    let completed_at = if completed { Some(ts) } else { None };
    conn.execute(
        "UPDATE notes SET completed_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![completed_at, ts, id],
    )?;
    // Completing/uncompleting changes alert qualification; clear stale events.
    conn.execute("DELETE FROM note_alert_events WHERE note_id = ?1", params![id])?;
    get_note(conn, id)
}

pub fn archive_note(conn: &Connection, id: &str, archived: bool) -> SqlResult<Option<NoteItem>> {
    let ts = now();
    let archived_at = if archived { Some(ts) } else { None };
    conn.execute(
        "UPDATE notes SET archived_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![archived_at, ts, id],
    )?;
    conn.execute("DELETE FROM note_alert_events WHERE note_id = ?1", params![id])?;
    get_note(conn, id)
}

pub fn update_note(
    conn: &Connection,
    id: &str,
    patch: &UpdateNoteInput,
) -> SqlResult<Option<NoteItem>> {
    let ts = now();
    // Capture the prior schedule so we only invalidate acknowledgements when the
    // fields that drive alert qualification actually change (a plain title/body
    // edit must not resurface an alert the user already acknowledged).
    let prev_schedule: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT due_at, reminder_at FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let affected = conn.execute(
        "UPDATE notes SET
            title = ?1, body = ?2, pinned = ?3, color = ?4, priority = ?5,
            due_at = ?6, reminder_at = ?7, repeat_rule = ?8, source_tab_id = ?9,
            source_session_id = ?10, source_title = ?11, source_uri = ?12,
            updated_at = ?13
         WHERE id = ?14",
        params![
            patch.title,
            patch.body,
            patch.pinned.unwrap_or(false) as i64,
            patch.color,
            patch.priority.unwrap_or(0),
            patch.due_at,
            patch.reminder_at,
            patch.repeat_rule,
            patch.source_tab_id,
            patch.source_session_id,
            patch.source_title,
            patch.source_uri,
            ts,
            id,
        ],
    )?;
    if affected == 0 {
        return Ok(None);
    }
    if let Some(tag_ids) = &patch.tag_ids {
        set_note_tags(conn, id, tag_ids)?;
    }
    // Only editing due/reminder invalidates prior alert acknowledgements; other
    // edits keep them so the same alert stays acknowledged (list_alerts then
    // re-derives fresh pending events from the new schedule).
    let schedule_changed = prev_schedule
        .map(|(prev_due, prev_reminder)| {
            prev_due != patch.due_at || prev_reminder != patch.reminder_at
        })
        .unwrap_or(true);
    if schedule_changed {
        conn.execute("DELETE FROM note_alert_events WHERE note_id = ?1", params![id])?;
    }
    get_note(conn, id)
}

// ---------------------------------------------------------------------------
// Listing / search / filter
// ---------------------------------------------------------------------------

/// Local calendar-day bounds (start inclusive, end exclusive) around `ts`.
fn local_day_bounds(ts: i64) -> (i64, i64) {
    use chrono::{Local, TimeZone};
    let dt = Local
        .timestamp_opt(ts, 0)
        .single()
        .unwrap_or_else(Local::now);
    let start_date = dt.date_naive();
    let start = start_date
        .and_hms_opt(0, 0, 0)
        .and_then(|nd| Local.from_local_datetime(&nd).single())
        .map(|d| d.timestamp())
        .unwrap_or(ts);
    (start, start + 86_400)
}

fn note_filter_condition(
    filter: &str,
    now_ts: i64,
    due_soon: i64,
    sql_params: &mut Vec<Box<dyn rusqlite::ToSql>>,
) -> String {
    match filter {
        "all" => "archived_at IS NULL".into(),
        "pinned" => "archived_at IS NULL AND pinned = 1".into(),
        "completed" => "archived_at IS NULL AND completed_at IS NOT NULL".into(),
        "archived" => "archived_at IS NOT NULL".into(),
        "today" => {
            let (start, end) = local_day_bounds(now_ts);
            sql_params.push(Box::new(start));
            sql_params.push(Box::new(end));
            "archived_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL \
             AND due_at >= ?p AND due_at < ?p"
                .into()
        }
        "due_soon" => {
            sql_params.push(Box::new(now_ts));
            sql_params.push(Box::new(now_ts + due_soon));
            "archived_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL \
             AND due_at > ?p AND due_at <= ?p"
                .into()
        }
        "overdue" => {
            sql_params.push(Box::new(now_ts));
            "archived_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL \
             AND due_at <= ?p"
                .into()
        }
        // "recent_incomplete" (default), and the legacy "tag" pseudo-filter.
        _ => "archived_at IS NULL AND completed_at IS NULL".into(),
    }
}

pub fn list_notes(conn: &Connection, query: &NoteQuery) -> SqlResult<Vec<NoteItem>> {
    let filters = query
        .filters
        .as_ref()
        .filter(|values| !values.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![query.filter.clone().unwrap_or_else(|| "recent_incomplete".into())]);
    let now_ts = query.now.unwrap_or_else(now);
    let due_soon = query.due_soon_secs.unwrap_or(DEFAULT_DUE_SOON_SECS);

    let mut where_parts: Vec<String> = Vec::new();
    let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let filter_parts = filters
        .iter()
        .map(|filter| format!("({})", note_filter_condition(filter, now_ts, due_soon, &mut sql_params)))
        .collect::<Vec<_>>();
    where_parts.push(format!("({})", filter_parts.join(" OR ")));

    if let Some(tag_id) = query.tag_id.as_deref().filter(|s| !s.is_empty()) {
        where_parts.push(
            "id IN (SELECT note_id FROM note_tag_links WHERE tag_id = ?p)".into(),
        );
        sql_params.push(Box::new(tag_id.to_string()));
    }

    if let Some(search) = query.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let like = format!("%{}%", search.replace('%', "\\%").replace('_', "\\_"));
        where_parts.push(
            "(title LIKE ?p ESCAPE '\\' OR body LIKE ?p ESCAPE '\\' OR id IN (\
                SELECT l.note_id FROM note_tag_links l JOIN note_tags t ON t.id = l.tag_id \
                WHERE t.name LIKE ?p ESCAPE '\\'))"
                .into(),
        );
        sql_params.push(Box::new(like.clone()));
        sql_params.push(Box::new(like.clone()));
        sql_params.push(Box::new(like));
    }

    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    // Sort: pinned desc, due_at asc (nulls last), updated_at desc.
    let order_sql =
        "ORDER BY pinned DESC, (due_at IS NULL) ASC, due_at ASC, updated_at DESC";
    let limit_sql = match query.limit {
        Some(l) if l >= 0 => format!("LIMIT {} OFFSET {}", l, query.offset.unwrap_or(0).max(0)),
        _ => String::new(),
    };

    // Bind positional params in order by replacing sequential "?p" markers.
    let mut sql = format!("SELECT {NOTE_COLUMNS} FROM notes {where_sql} {order_sql} {limit_sql}");
    let mut idx = 0;
    while let Some(pos) = sql.find("?p") {
        idx += 1;
        sql.replace_range(pos..pos + 2, &format!("?{idx}"));
    }

    let param_refs: Vec<&dyn rusqlite::ToSql> = sql_params.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(param_refs.as_slice(), row_to_note)?;
    let mut notes: Vec<NoteItem> = rows.collect::<SqlResult<Vec<_>>>()?;

    // Batch-load steps and tags for the returned notes.
    for note in &mut notes {
        note.steps = load_steps_for(conn, &note.id)?;
        note.tags = load_tags_for(conn, &note.id)?;
    }
    Ok(notes)
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

pub fn load_steps_for(conn: &Connection, note_id: &str) -> SqlResult<Vec<NoteStep>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, title, completed_at, sort_order, created_at, updated_at
         FROM note_steps WHERE note_id = ?1 ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = stmt.query_map(params![note_id], row_to_step)?;
    rows.collect()
}

/// Replace the full ordered step list for a note.
pub fn set_steps(conn: &Connection, note_id: &str, steps: &[StepInput]) -> SqlResult<Vec<NoteStep>> {
    let ts = now();
    conn.execute("DELETE FROM note_steps WHERE note_id = ?1", params![note_id])?;
    for (i, step) in steps.iter().enumerate() {
        let id = step.id.clone().unwrap_or_else(new_id);
        conn.execute(
            "INSERT INTO note_steps (id, note_id, title, completed_at, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                note_id,
                step.title,
                step.completed_at,
                step.sort_order.unwrap_or(i as i64),
                ts,
                ts,
            ],
        )?;
    }
    conn.execute(
        "UPDATE notes SET updated_at = ?1 WHERE id = ?2",
        params![ts, note_id],
    )?;
    load_steps_for(conn, note_id)
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

pub fn load_tags_for(conn: &Connection, note_id: &str) -> SqlResult<Vec<NoteTag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.created_at, t.updated_at
         FROM note_tags t JOIN note_tag_links l ON l.tag_id = t.id
         WHERE l.note_id = ?1 ORDER BY t.name ASC",
    )?;
    let rows = stmt.query_map(params![note_id], row_to_tag)?;
    rows.collect()
}

pub fn list_tags(conn: &Connection) -> SqlResult<Vec<NoteTag>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, created_at, updated_at FROM note_tags ORDER BY name ASC",
    )?;
    let rows = stmt.query_map([], row_to_tag)?;
    rows.collect()
}

/// Create or update tags by id (update) or name (create-if-absent). Returns the
/// resolved tags with their canonical ids.
pub fn upsert_tags(conn: &Connection, tags: &[TagInput]) -> SqlResult<Vec<NoteTag>> {
    let ts = now();
    let mut out = Vec::new();
    for tag in tags {
        let name = tag.name.trim();
        if name.is_empty() {
            continue;
        }
        // Prefer an explicit id, else match an existing tag by name.
        let existing_id: Option<String> = if let Some(id) = tag.id.clone().filter(|s| !s.is_empty())
        {
            Some(id)
        } else {
            conn.query_row(
                "SELECT id FROM note_tags WHERE name = ?1",
                params![name],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        };
        let id = match existing_id {
            Some(id) => {
                conn.execute(
                    "UPDATE note_tags SET name = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
                    params![name, tag.color, ts, id],
                )?;
                id
            }
            None => {
                let id = new_id();
                conn.execute(
                    "INSERT INTO note_tags (id, name, color, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, name, tag.color, ts],
                )?;
                id
            }
        };
        if let Some(tag) = conn
            .query_row(
                "SELECT id, name, color, created_at, updated_at FROM note_tags WHERE id = ?1",
                params![id],
                row_to_tag,
            )
            .optional()?
        {
            out.push(tag);
        }
    }
    Ok(out)
}

/// Replace a note's tag links with `tag_ids`.
pub fn set_note_tags(conn: &Connection, note_id: &str, tag_ids: &[String]) -> SqlResult<()> {
    conn.execute("DELETE FROM note_tag_links WHERE note_id = ?1", params![note_id])?;
    for tag_id in tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO note_tag_links (note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Prefs
// ---------------------------------------------------------------------------

pub fn get_prefs(conn: &Connection) -> SqlResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value_json FROM note_prefs")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

pub fn set_prefs(conn: &Connection, prefs: &HashMap<String, String>) -> SqlResult<()> {
    let ts = now();
    for (k, v) in prefs {
        conn.execute(
            "INSERT INTO note_prefs (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = ?2, updated_at = ?3",
            params![k, v, ts],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

fn kind_rank(kind: &str) -> i64 {
    match kind {
        "overdue" => 0,
        "reminder" => 1,
        "due_soon" => 2,
        _ => 3,
    }
}

/// Recompute the live alert set from note due/reminder times, reconcile it with
/// the persisted `note_alert_events` (so acknowledgements survive polling), and
/// return the current alerts ordered by severity then fire time.
pub fn list_alerts(conn: &Connection, now_ts: i64, due_soon_secs: i64) -> SqlResult<Vec<NoteAlert>> {
    // Desired = (note_id, kind, fire_at) tuples that currently qualify.
    let mut desired: Vec<(String, String, i64)> = Vec::new();

    // Overdue: past-due, incomplete, not archived.
    {
        let mut stmt = conn.prepare(
            "SELECT id, due_at FROM notes
             WHERE completed_at IS NULL AND archived_at IS NULL
               AND due_at IS NOT NULL AND due_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now_ts], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, due) = row?;
            desired.push((id, "overdue".into(), due));
        }
    }
    // Due soon: within the window, still in the future.
    {
        let mut stmt = conn.prepare(
            "SELECT id, due_at FROM notes
             WHERE completed_at IS NULL AND archived_at IS NULL
               AND due_at IS NOT NULL AND due_at > ?1 AND due_at <= ?2",
        )?;
        let rows = stmt.query_map(params![now_ts, now_ts + due_soon_secs], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, due) = row?;
            desired.push((id, "due_soon".into(), due));
        }
    }
    // Reminder fired.
    {
        let mut stmt = conn.prepare(
            "SELECT id, reminder_at FROM notes
             WHERE completed_at IS NULL AND archived_at IS NULL
               AND reminder_at IS NOT NULL AND reminder_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now_ts], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, rem) = row?;
            desired.push((id, "reminder".into(), rem));
        }
    }

    // Reconcile: drop events that no longer qualify, insert new pending ones,
    // refresh fire_at on the rest.
    let ts = now();
    let existing: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT note_id, kind FROM note_alert_events")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<SqlResult<Vec<_>>>()?
    };
    for (note_id, kind) in &existing {
        if !desired.iter().any(|(n, k, _)| n == note_id && k == kind) {
            conn.execute(
                "DELETE FROM note_alert_events WHERE note_id = ?1 AND kind = ?2",
                params![note_id, kind],
            )?;
        }
    }
    for (note_id, kind, fire_at) in &desired {
        conn.execute(
            "INSERT INTO note_alert_events
                (id, note_id, kind, state, fire_at, acknowledged_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, NULL, ?5, ?5)
             ON CONFLICT(note_id, kind) DO UPDATE SET fire_at = ?4, updated_at = ?5",
            params![new_id(), note_id, kind, fire_at, ts],
        )?;
    }

    // Return joined with note info.
    let mut stmt = conn.prepare(
        "SELECT e.id, e.note_id, e.kind, e.state, e.fire_at, e.acknowledged_at,
                n.title, n.due_at, n.reminder_at
         FROM note_alert_events e JOIN notes n ON n.id = e.note_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(NoteAlert {
            id: r.get(0)?,
            note_id: r.get(1)?,
            kind: r.get(2)?,
            state: r.get(3)?,
            fire_at: r.get(4)?,
            acknowledged_at: r.get(5)?,
            note_title: r.get(6)?,
            due_at: r.get(7)?,
            reminder_at: r.get(8)?,
        })
    })?;
    let mut alerts: Vec<NoteAlert> = rows.collect::<SqlResult<Vec<_>>>()?;
    alerts.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then(a.fire_at.cmp(&b.fire_at))
    });
    Ok(alerts)
}

/// Mark an alert event acknowledged (so it stops badging the Tao Ribbon).
pub fn ack_alert(conn: &Connection, id: &str) -> SqlResult<()> {
    let ts = now();
    conn.execute(
        "UPDATE note_alert_events SET state = 'acknowledged', acknowledged_at = ?1, updated_at = ?1
         WHERE id = ?2",
        params![ts, id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    fn create(conn: &Connection, title: &str) -> NoteItem {
        create_note(
            conn,
            &CreateNoteInput {
                title: Some(title.into()),
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn schema_init_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        // Running again must not error.
        init_db(&conn).unwrap();
    }

    #[test]
    fn create_defaults_to_incomplete() {
        let conn = mem();
        let note = create(&conn, "Buy milk");
        assert!(note.completed_at.is_none());
        assert!(!note.pinned);
        assert!(note.archived_at.is_none());
        assert_eq!(note.priority, 0);
        assert_eq!(note.body, "");
    }

    #[test]
    fn toggle_complete_round_trip() {
        let conn = mem();
        let note = create(&conn, "Task");
        let done = toggle_complete(&conn, &note.id, true).unwrap().unwrap();
        assert!(done.completed_at.is_some());
        let reopened = toggle_complete(&conn, &note.id, false).unwrap().unwrap();
        assert!(reopened.completed_at.is_none());
    }

    #[test]
    fn recent_incomplete_excludes_completed_and_archived() {
        let conn = mem();
        let a = create(&conn, "A");
        let b = create(&conn, "B");
        let c = create(&conn, "C");
        toggle_complete(&conn, &b.id, true).unwrap();
        archive_note(&conn, &c.id, true).unwrap();
        let notes = list_notes(&conn, &NoteQuery::default()).unwrap();
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec![a.id.as_str()]);
    }

    #[test]
    fn multi_status_filter_unions_completed_and_archived() {
        let conn = mem();
        let active = create(&conn, "A");
        let completed = create(&conn, "B");
        let archived = create(&conn, "C");
        toggle_complete(&conn, &completed.id, true).unwrap();
        archive_note(&conn, &archived.id, true).unwrap();
        let notes = list_notes(
            &conn,
            &NoteQuery {
                filters: Some(vec!["completed".into(), "archived".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&completed.id.as_str()));
        assert!(ids.contains(&archived.id.as_str()));
        assert!(!ids.contains(&active.id.as_str()));
    }

    #[test]
    fn sort_pinned_then_due_then_updated() {
        let conn = mem();
        let plain = create(&conn, "plain");
        let due_soon = create(&conn, "due");
        let pinned = create(&conn, "pinned");
        update_note(
            &conn,
            &due_soon.id,
            &UpdateNoteInput {
                title: "due".into(),
                due_at: Some(now() + 60),
                ..Default::default()
            },
        )
        .unwrap();
        update_note(
            &conn,
            &pinned.id,
            &UpdateNoteInput {
                title: "pinned".into(),
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let notes = list_notes(&conn, &NoteQuery::default()).unwrap();
        assert_eq!(notes[0].id, pinned.id, "pinned first");
        assert_eq!(notes[1].id, due_soon.id, "then earliest due");
        assert_eq!(notes[2].id, plain.id, "null due last");
    }

    #[test]
    fn search_matches_title_body_and_tags() {
        let conn = mem();
        let by_title = create(&conn, "deployment plan");
        let by_body = create_note(
            &conn,
            &CreateNoteInput {
                title: Some("misc".into()),
                body: Some("remember the deployment steps".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let tags = upsert_tags(
            &conn,
            &[TagInput {
                id: None,
                name: "deployment".into(),
                color: None,
            }],
        )
        .unwrap();
        let by_tag = create(&conn, "tagged");
        set_note_tags(&conn, &by_tag.id, &[tags[0].id.clone()]).unwrap();

        let hits = list_notes(
            &conn,
            &NoteQuery {
                search: Some("deployment".into()),
                filter: Some("all".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let ids: std::collections::HashSet<&str> = hits.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(by_title.id.as_str()));
        assert!(ids.contains(by_body.id.as_str()));
        assert!(ids.contains(by_tag.id.as_str()));
    }

    #[test]
    fn steps_are_ordered_and_replaced() {
        let conn = mem();
        let note = create(&conn, "chores");
        set_steps(
            &conn,
            &note.id,
            &[
                StepInput { id: None, title: "second".into(), completed_at: None, sort_order: Some(1) },
                StepInput { id: None, title: "first".into(), completed_at: None, sort_order: Some(0) },
            ],
        )
        .unwrap();
        let loaded = get_note(&conn, &note.id).unwrap().unwrap();
        assert_eq!(loaded.steps.len(), 2);
        assert_eq!(loaded.steps[0].title, "first");
        assert_eq!(loaded.steps[1].title, "second");
        // Replace with a single step.
        set_steps(
            &conn,
            &note.id,
            &[StepInput { id: None, title: "only".into(), completed_at: None, sort_order: None }],
        )
        .unwrap();
        let loaded = get_note(&conn, &note.id).unwrap().unwrap();
        assert_eq!(loaded.steps.len(), 1);
        assert_eq!(loaded.steps[0].title, "only");
    }

    #[test]
    fn tags_upsert_dedupes_by_name() {
        let conn = mem();
        let first = upsert_tags(
            &conn,
            &[TagInput { id: None, name: "urgent".into(), color: Some("#f00".into()) }],
        )
        .unwrap();
        let second = upsert_tags(
            &conn,
            &[TagInput { id: None, name: "urgent".into(), color: Some("#0f0".into()) }],
        )
        .unwrap();
        assert_eq!(first[0].id, second[0].id, "same name reuses tag");
        assert_eq!(second[0].color.as_deref(), Some("#0f0"), "color updated");
        assert_eq!(list_tags(&conn).unwrap().len(), 1);
    }

    #[test]
    fn prefs_round_trip() {
        let conn = mem();
        let mut prefs = HashMap::new();
        prefs.insert("notes.panel.mode".into(), "\"floating\"".into());
        set_prefs(&conn, &prefs).unwrap();
        prefs.insert("notes.panel.mode".into(), "\"hub\"".into());
        set_prefs(&conn, &prefs).unwrap();
        let loaded = get_prefs(&conn).unwrap();
        assert_eq!(loaded.get("notes.panel.mode").map(String::as_str), Some("\"hub\""));
    }

    #[test]
    fn alerts_detect_overdue_due_soon_and_ack() {
        let conn = mem();
        let base = now();
        let overdue = create(&conn, "overdue");
        update_note(
            &conn,
            &overdue.id,
            &UpdateNoteInput { title: "overdue".into(), due_at: Some(base - 100), ..Default::default() },
        )
        .unwrap();
        let soon = create(&conn, "soon");
        update_note(
            &conn,
            &soon.id,
            &UpdateNoteInput { title: "soon".into(), due_at: Some(base + 60), ..Default::default() },
        )
        .unwrap();
        let far = create(&conn, "far");
        update_note(
            &conn,
            &far.id,
            &UpdateNoteInput { title: "far".into(), due_at: Some(base + 86_400), ..Default::default() },
        )
        .unwrap();

        let alerts = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
        let kinds: HashMap<&str, &str> =
            alerts.iter().map(|a| (a.note_id.as_str(), a.kind.as_str())).collect();
        assert_eq!(kinds.get(overdue.id.as_str()), Some(&"overdue"));
        assert_eq!(kinds.get(soon.id.as_str()), Some(&"due_soon"));
        assert!(!kinds.contains_key(far.id.as_str()), "far-future not alerted");
        // Overdue sorts before due_soon.
        assert_eq!(alerts[0].kind, "overdue");

        // Ack the overdue alert; it stays but flips to acknowledged.
        let overdue_alert = alerts.iter().find(|a| a.note_id == overdue.id).unwrap();
        ack_alert(&conn, &overdue_alert.id).unwrap();
        let again = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
        let acked = again.iter().find(|a| a.note_id == overdue.id).unwrap();
        assert_eq!(acked.state, "acknowledged");

        // Completing the note clears its alert.
        toggle_complete(&conn, &overdue.id, true).unwrap();
        let after = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
        assert!(after.iter().all(|a| a.note_id != overdue.id));
    }

    #[test]
    fn edit_preserves_ack_but_reschedule_clears_it() {
        let conn = mem();
        let base = now();
        let note = create(&conn, "pay rent");
        update_note(
            &conn,
            &note.id,
            &UpdateNoteInput { title: "pay rent".into(), due_at: Some(base - 100), ..Default::default() },
        )
        .unwrap();

        // Fire + acknowledge the overdue alert.
        let alerts = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
        let alert = alerts.iter().find(|a| a.note_id == note.id).unwrap();
        ack_alert(&conn, &alert.id).unwrap();

        // A plain title/body edit (same schedule) must keep the acknowledgement.
        update_note(
            &conn,
            &note.id,
            &UpdateNoteInput {
                title: "pay the rent".into(),
                body: "before the 1st".into(),
                due_at: Some(base - 100),
                ..Default::default()
            },
        )
        .unwrap();
        let after_edit = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
        let still = after_edit.iter().find(|a| a.note_id == note.id).unwrap();
        assert_eq!(still.state, "acknowledged", "plain edit keeps the ack");

        // Changing due_at re-qualifies the alert as pending.
        update_note(
            &conn,
            &note.id,
            &UpdateNoteInput {
                title: "pay the rent".into(),
                body: "before the 1st".into(),
                due_at: Some(base - 50),
                ..Default::default()
            },
        )
        .unwrap();
        let after_reschedule = list_alerts(&conn, base, DEFAULT_DUE_SOON_SECS).unwrap();
        let repending = after_reschedule.iter().find(|a| a.note_id == note.id).unwrap();
        assert_eq!(repending.state, "pending", "rescheduling clears the ack");
    }

    #[test]
    fn deleting_note_cascades_steps_tags_alerts() {
        let conn = mem();
        let note = create(&conn, "temp");
        set_steps(
            &conn,
            &note.id,
            &[StepInput { id: None, title: "s".into(), completed_at: None, sort_order: None }],
        )
        .unwrap();
        let tags = upsert_tags(&conn, &[TagInput { id: None, name: "t".into(), color: None }]).unwrap();
        set_note_tags(&conn, &note.id, &[tags[0].id.clone()]).unwrap();
        delete_note(&conn, &note.id).unwrap();
        assert!(get_note(&conn, &note.id).unwrap().is_none());
        let orphan_steps: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_steps", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphan_steps, 0);
        let orphan_links: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_tag_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphan_links, 0);
    }
}






