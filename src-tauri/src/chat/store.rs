use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatThread {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub linked_session_id: Option<String>,
    pub source: String,
    #[serde(default = "default_thread_mode")]
    pub mode: String,
    /// Claude Code session ID for --resume (v2.6).
    #[serde(default)]
    pub cc_session_id: Option<String>,
    /// ACP session ID for session/load continuity. This is intentionally not
    /// shared with the legacy Claude Code/Codex bridge column.
    #[serde(default)]
    pub acp_session_id: Option<String>,
    /// Per-thread Claude Code model override.
    /// `None` means "inherit AiConfig.cc_bridge.default_model". Baked into the
    /// child's `--model` at spawn, so changing it recycles the CC process.
    #[serde(default)]
    pub cc_model: Option<String>,
    /// Per-thread output format override: "md" | "html" | "plain".
    /// `None` means "inherit AiConfig.chat_output_format".
    #[serde(default)]
    pub output_format: Option<String>,
}

fn default_thread_mode() -> String {
    "chat".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    pub redacted: bool,
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAttachment {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub preview_url: Option<String>,
}

pub fn init_chat_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_chat_threads (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            provider_id TEXT NOT NULL DEFAULT 'deepseek',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            linked_session_id TEXT,
            source TEXT NOT NULL DEFAULT 'drawer'
        );

        CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            redacted INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (thread_id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ai_chat_message_attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            mime TEXT,
            preview_url TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (message_id) REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
            FOREIGN KEY (thread_id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
            ON ai_chat_messages(thread_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_threads_updated
            ON ai_chat_threads(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chat_attachments_message
            ON ai_chat_message_attachments(message_id);",
    )?;

    // Idempotent column add for older installs that pre-date the v2.6 CC bridge.
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN cc_session_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN acp_session_id TEXT",
        [],
    );
    // Idempotent column add for the per-thread chat output-format override.
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN output_format TEXT",
        [],
    );
    // Idempotent column add for the per-thread Claude Code model override.
    let _ = conn.execute("ALTER TABLE ai_chat_threads ADD COLUMN cc_model TEXT", []);
    // Idempotent column add for media-generation chat drawer modes.
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_chat_message_attachments ADD COLUMN preview_url TEXT",
        [],
    );
    Ok(())
}

pub fn create_thread(conn: &Connection, thread: &ChatThread) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO ai_chat_threads (id, title, provider_id, created_at, updated_at, linked_session_id, source, output_format, cc_model, mode, acp_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            thread.id, thread.title, thread.provider_id,
            thread.created_at, thread.updated_at,
            thread.linked_session_id, thread.source,
            thread.output_format, thread.cc_model, thread.mode,
            thread.acp_session_id,
        ],
    )?;
    Ok(())
}

pub fn get_thread(conn: &Connection, id: &str) -> SqlResult<Option<ChatThread>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, provider_id, created_at, updated_at, linked_session_id, source, cc_session_id, output_format, cc_model, mode, acp_session_id
         FROM ai_chat_threads WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(ChatThread {
        id: row.get(0)?,
        title: row.get(1)?,
        provider_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        linked_session_id: row.get(5)?,
        source: row.get(6)?,
        cc_session_id: row.get(7).ok(),
        acp_session_id: row.get(11).ok(),
        output_format: row.get(8).ok(),
        cc_model: row.get(9).ok(),
        mode: row
            .get::<_, Option<String>>(10)?
            .unwrap_or_else(default_thread_mode),
    }))
}

pub fn list_threads(conn: &Connection, limit: usize) -> SqlResult<Vec<ChatThread>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, provider_id, created_at, updated_at, linked_session_id, source, cc_session_id, output_format, cc_model, mode, acp_session_id
         FROM ai_chat_threads ORDER BY updated_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(ChatThread {
            id: row.get(0)?,
            title: row.get(1)?,
            provider_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            linked_session_id: row.get(5)?,
            source: row.get(6)?,
            cc_session_id: row.get(7).ok(),
            acp_session_id: row.get(11).ok(),
            output_format: row.get(8).ok(),
            cc_model: row.get(9).ok(),
            mode: row
                .get::<_, Option<String>>(10)?
                .unwrap_or_else(default_thread_mode),
        })
    })?;
    rows.collect()
}

pub fn set_cc_session_id(conn: &Connection, thread_id: &str, session_id: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads SET cc_session_id = ?1 WHERE id = ?2",
        params![session_id, thread_id],
    )?;
    Ok(())
}

pub fn set_acp_session_id(conn: &Connection, thread_id: &str, session_id: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads SET acp_session_id = ?1 WHERE id = ?2",
        params![session_id, thread_id],
    )?;
    Ok(())
}

pub fn delete_thread(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM ai_chat_message_attachments WHERE thread_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM ai_chat_threads WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn insert_message(conn: &Connection, msg: &ChatMessage) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO ai_chat_messages (id, thread_id, role, content, created_at, redacted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            msg.id,
            msg.thread_id,
            msg.role,
            msg.content,
            msg.created_at,
            msg.redacted as i64
        ],
    )?;
    for att in &msg.attachments {
        conn.execute(
            "INSERT OR REPLACE INTO ai_chat_message_attachments
             (id, message_id, thread_id, kind, path, name, size, mime, preview_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &att.id,
                &msg.id,
                &msg.thread_id,
                &att.kind,
                &att.path,
                &att.name,
                att.size as i64,
                att.mime.as_deref(),
                att.preview_url.as_deref(),
                msg.created_at,
            ],
        )?;
    }
    // Update thread updated_at.
    conn.execute(
        "UPDATE ai_chat_threads SET updated_at = ?1 WHERE id = ?2",
        params![msg.created_at, msg.thread_id],
    )?;
    Ok(())
}

pub fn list_messages(conn: &Connection, thread_id: &str) -> SqlResult<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, thread_id, role, content, created_at, redacted
         FROM ai_chat_messages WHERE thread_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![thread_id], |row| {
        Ok(ChatMessage {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            redacted: row.get::<_, i64>(5)? != 0,
            attachments: Vec::new(),
        })
    })?;
    let mut messages: Vec<ChatMessage> = rows.collect::<SqlResult<Vec<_>>>()?;
    if messages.is_empty() {
        return Ok(messages);
    }

    let mut att_stmt = conn.prepare(
        "SELECT message_id, id, kind, path, name, size, mime, preview_url
         FROM ai_chat_message_attachments WHERE thread_id = ?1 ORDER BY created_at ASC",
    )?;
    let att_rows = att_stmt.query_map(params![thread_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ChatAttachment {
                id: row.get(1)?,
                kind: row.get(2)?,
                path: row.get(3)?,
                name: row.get(4)?,
                size: row.get::<_, i64>(5)?.max(0) as u64,
                mime: row.get(6).ok(),
                preview_url: row.get(7).ok(),
            },
        ))
    })?;
    let mut by_message: HashMap<String, Vec<ChatAttachment>> = HashMap::new();
    for row in att_rows {
        let (message_id, att) = row?;
        by_message.entry(message_id).or_default().push(att);
    }
    for message in &mut messages {
        if let Some(attachments) = by_message.remove(&message.id) {
            message.attachments = attachments;
        }
    }
    Ok(messages)
}

pub fn update_thread_title(conn: &Connection, id: &str, title: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

pub fn update_thread_provider(conn: &Connection, id: &str, provider_id: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads
         SET acp_session_id = CASE WHEN provider_id = ?1 THEN acp_session_id ELSE NULL END,
             provider_id = ?1
         WHERE id = ?2",
        params![provider_id, id],
    )?;
    Ok(())
}

/// Set or clear the per-thread Claude Code model override.
/// `None` (or `Some("")`) clears it so the thread inherits the configured
/// `cc_bridge.default_model`.
pub fn update_thread_cc_model(conn: &Connection, id: &str, model: Option<&str>) -> SqlResult<()> {
    let normalized = model.filter(|s| !s.trim().is_empty());
    conn.execute(
        "UPDATE ai_chat_threads SET cc_model = ?1 WHERE id = ?2",
        params![normalized, id],
    )?;
    Ok(())
}

/// Set or clear the per-thread output-format override.
/// `None` (or `Some("")`) clears it so the thread inherits AiConfig.chat_output_format.
pub fn update_thread_output_format(
    conn: &Connection,
    id: &str,
    output_format: Option<&str>,
) -> SqlResult<()> {
    let normalized = output_format.filter(|s| !s.is_empty());
    conn.execute(
        "UPDATE ai_chat_threads SET output_format = ?1 WHERE id = ?2",
        params![normalized, id],
    )?;
    Ok(())
}

/// Delete every thread whose `updated_at` is older than `cutoff_ts` (Unix
/// seconds). Returns the number of threads deleted; messages are removed via
/// the FK cascade. Used by the retention sweeper.
pub fn delete_threads_older_than(conn: &Connection, cutoff_ts: i64) -> SqlResult<usize> {
    conn.execute(
        "DELETE FROM ai_chat_message_attachments WHERE thread_id IN (
            SELECT id FROM ai_chat_threads WHERE updated_at < ?1
        )",
        params![cutoff_ts],
    )?;
    let count = conn.execute(
        "DELETE FROM ai_chat_threads WHERE updated_at < ?1",
        params![cutoff_ts],
    )?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_attachments_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        init_chat_tables(&conn).unwrap();
        let thread = ChatThread {
            id: "thread-1".into(),
            title: "New chat".into(),
            provider_id: "deepseek".into(),
            created_at: 1,
            updated_at: 1,
            linked_session_id: None,
            source: "drawer".into(),
            mode: "chat".into(),
            cc_session_id: None,
            acp_session_id: None,
            cc_model: None,
            output_format: None,
        };
        create_thread(&conn, &thread).unwrap();
        let message = ChatMessage {
            id: "msg-1".into(),
            thread_id: "thread-1".into(),
            role: "user".into(),
            content: "Please review the attached files.".into(),
            created_at: 2,
            redacted: false,
            attachments: vec![ChatAttachment {
                id: "att-1".into(),
                kind: "image".into(),
                path: "C:\\tmp\\diagram.png".into(),
                name: "diagram.png".into(),
                size: 2048,
                mime: Some("image/png".into()),
                preview_url: Some("https://example.test/diagram.png".into()),
            }],
        };
        insert_message(&conn, &message).unwrap();

        let messages = list_messages(&conn, "thread-1").unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].attachments.len(), 1);
        assert_eq!(messages[0].attachments[0].name, "diagram.png");
        assert_eq!(
            messages[0].attachments[0].preview_url.as_deref(),
            Some("https://example.test/diagram.png")
        );
        let loaded_thread = get_thread(&conn, "thread-1").unwrap().unwrap();
        assert_eq!(loaded_thread.mode, "chat");
    }

    #[test]
    fn acp_session_is_separate_and_clears_when_provider_changes() {
        let conn = Connection::open_in_memory().unwrap();
        init_chat_tables(&conn).unwrap();
        let thread = ChatThread {
            id: "acp-thread".into(),
            title: "ACP chat".into(),
            provider_id: "acp:grok".into(),
            created_at: 1,
            updated_at: 1,
            linked_session_id: None,
            source: "drawer".into(),
            mode: "chat".into(),
            cc_session_id: None,
            acp_session_id: None,
            cc_model: None,
            output_format: None,
        };
        create_thread(&conn, &thread).unwrap();
        set_acp_session_id(&conn, &thread.id, "grok-session").unwrap();

        let loaded = get_thread(&conn, &thread.id).unwrap().unwrap();
        assert_eq!(loaded.acp_session_id.as_deref(), Some("grok-session"));
        assert!(loaded.cc_session_id.is_none());

        update_thread_provider(&conn, &thread.id, "acp:grok").unwrap();
        assert_eq!(
            get_thread(&conn, &thread.id)
                .unwrap()
                .unwrap()
                .acp_session_id
                .as_deref(),
            Some("grok-session")
        );

        update_thread_provider(&conn, &thread.id, "codex").unwrap();
        assert!(
            get_thread(&conn, &thread.id)
                .unwrap()
                .unwrap()
                .acp_session_id
                .is_none()
        );
    }
}
