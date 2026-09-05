mod acp;
pub mod inline_qq;
pub mod redact;
pub mod run;
pub mod store;

use crate::ai::config::{AiConfig, default_ai_config_path};
use crate::llm::router::provider_group_id_from_route;
use crate::llm::{
    ChatContentPart, ChatMessage as LlmMessage, ChatRequest, ChatStreamEvent, ChatTool,
    ChatToolCall, Llm, TaskKind,
};
use crate::state::AppState;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn normalize_thread_mode(mode: Option<String>) -> Result<String, String> {
    let mode = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("chat");
    match mode {
        "chat" | "image" | "video" => Ok(mode.to_string()),
        _ => Err(format!(
            "Invalid chat thread mode '{mode}': expected 'chat', 'image', or 'video'."
        )),
    }
}

const CHAT_MAX_ATTACHMENTS: usize = 10;
const CHAT_MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const TEXT_ATTACHMENT_PREVIEW_BYTES: u64 = 64 * 1024;
const AGNES_DEFAULT_IMAGE_MODEL: &str = "agnes-image-2.1-flash";
const AGNES_DEFAULT_VIDEO_MODEL: &str = "agnes-video-v2.0";
const DEFAULT_IMAGE_SIZE: &str = "1024x768";
const DEFAULT_VIDEO_WIDTH: u32 = 1152;
const DEFAULT_VIDEO_HEIGHT: u32 = 768;
const DEFAULT_VIDEO_NUM_FRAMES: u32 = 121;
const DEFAULT_VIDEO_FRAME_RATE: u32 = 24;
const VIDEO_POLL_ATTEMPTS: usize = 90;
const VIDEO_POLL_INTERVAL_SECS: u64 = 4;
#[tauri::command]
pub async fn chat_stat_attachment_paths(
    paths: Vec<String>,
) -> Result<Vec<store::ChatAttachment>, String> {
    stat_attachment_paths(paths)
}

#[tauri::command]
pub fn chat_read_clipboard_image_attachment(
    state: State<'_, AppState>,
) -> Result<store::ChatAttachment, String> {
    let (width, height, bytes) = {
        let mut guard = state
            .clipboard
            .lock()
            .map_err(|e| format!("clipboard lock: {}", e))?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| format!("clipboard init: {}", e))?);
        }
        let clipboard = guard
            .as_mut()
            .ok_or_else(|| "clipboard unavailable".to_string())?;
        let image = clipboard
            .get_image()
            .map_err(|_| "Clipboard does not contain an image.".to_string())?;
        (
            image.width as u32,
            image.height as u32,
            image.bytes.to_vec(),
        )
    };
    clipboard_image_attachment_from_rgba(width, height, &bytes)
}

fn stat_attachment_paths(paths: Vec<String>) -> Result<Vec<store::ChatAttachment>, String> {
    if paths.len() > CHAT_MAX_ATTACHMENTS {
        return Err(format!("Attach up to {CHAT_MAX_ATTACHMENTS} files."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        let clean = path.trim();
        if clean.is_empty() {
            continue;
        }
        let attachment = stat_attachment_path(clean, None)?;
        if seen.insert(attachment.path.clone()) {
            out.push(attachment);
        }
    }
    validate_attachment_limits(&out)?;
    Ok(out)
}

fn validate_chat_attachments(
    input: &[store::ChatAttachment],
) -> Result<Vec<store::ChatAttachment>, String> {
    if input.len() > CHAT_MAX_ATTACHMENTS {
        return Err(format!("Attach up to {CHAT_MAX_ATTACHMENTS} files."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for att in input {
        let clean = att.path.trim();
        if clean.is_empty() {
            continue;
        }
        let id = att
            .id
            .trim()
            .is_empty()
            .then(|| Uuid::new_v4().to_string())
            .unwrap_or_else(|| att.id.clone());
        let attachment = stat_attachment_path(clean, Some(id))?;
        if seen.insert(attachment.path.clone()) {
            out.push(attachment);
        }
    }
    validate_attachment_limits(&out)?;
    Ok(out)
}

fn validate_attachment_limits(attachments: &[store::ChatAttachment]) -> Result<(), String> {
    if attachments.len() > CHAT_MAX_ATTACHMENTS {
        return Err(format!("Attach up to {CHAT_MAX_ATTACHMENTS} files."));
    }
    let total = attachments
        .iter()
        .try_fold(0_u64, |sum, att| sum.checked_add(att.size))
        .ok_or_else(|| "Attached files are too large.".to_string())?;
    if total > CHAT_MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attached files can total at most {} MiB.",
            CHAT_MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn stat_attachment_path(path: &str, id: Option<String>) -> Result<store::ChatAttachment, String> {
    let original = Path::new(path);
    let metadata = std::fs::metadata(original)
        .map_err(|e| format!("Cannot read attachment metadata for '{path}': {e}"))?;
    if !metadata.is_file() {
        return Err(format!("Attachment is not a file: {path}"));
    }
    let canonical = std::fs::canonicalize(original)
        .map_err(|e| format!("Cannot resolve attachment path '{path}': {e}"))?;
    let display_path = normalize_path_for_display(canonical.to_string_lossy().to_string());
    let name = canonical
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            original
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| display_path.clone());
    let mime = infer_mime(&name);
    let kind = if is_supported_image_mime(&mime) {
        "image"
    } else {
        "file"
    };
    Ok(store::ChatAttachment {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        kind: kind.into(),
        path: display_path,
        name,
        size: metadata.len(),
        mime: Some(mime),
        preview_url: None,
    })
}

fn clipboard_image_attachment_from_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<store::ChatAttachment, String> {
    let buf =
        image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("invalid image buffer")?;
    let path = std::env::temp_dir().join(format!("taomni-chat-clipboard-{}.png", Uuid::new_v4()));
    buf.save(&path)
        .map_err(|e| format!("save clipboard image: {e}"))?;
    let mut attachment = stat_attachment_path(&path.to_string_lossy(), None)?;
    attachment.name = "Pasted image".into();
    attachment.mime = Some("image/png".into());
    attachment.kind = "image".into();
    Ok(attachment)
}

fn normalize_path_for_display(path: String) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path
}

fn infer_mime(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "css" | "toml" | "sql" | "sh" | "ps1" | "py"
        | "go" | "java" | "kt" | "c" | "cc" | "cpp" | "h" | "hpp" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn is_supported_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json" | "application/xml" | "application/yaml"
        )
}

fn render_agent_attachment_prefix(attachments: &[store::ChatAttachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "[Attached files]\nThese files are local to this Taomni machine. Read them from the listed paths when relevant.\n",
    );
    for (idx, att) in attachments.iter().enumerate() {
        out.push_str(&format!(
            "{}. {} ({}, {} bytes)\n   path: {}\n",
            idx + 1,
            att.name,
            att.mime.as_deref().unwrap_or("application/octet-stream"),
            att.size,
            att.path
        ));
    }
    out.push('\n');
    out
}

fn build_llm_attachment_message(
    attachments: &[store::ChatAttachment],
) -> Result<Option<LlmMessage>, String> {
    if attachments.is_empty() {
        return Ok(None);
    }

    let mut text = String::from(
        "[Attached files]\nLocal filesystem paths are intentionally omitted for privacy. Use the attached contents below.\n",
    );
    let mut parts = Vec::new();
    for (idx, att) in attachments.iter().enumerate() {
        let mime = att
            .mime
            .as_deref()
            .unwrap_or("application/octet-stream")
            .to_string();
        text.push_str(&format!(
            "\n{}. {} ({}, {} bytes)",
            idx + 1,
            att.name,
            mime,
            att.size
        ));
        if att.kind == "image" && is_supported_image_mime(&mime) {
            let bytes = std::fs::read(&att.path)
                .map_err(|e| format!("Cannot read image attachment '{}': {e}", att.name))?;
            let data_base64 = BASE64_STANDARD.encode(bytes);
            parts.push(ChatContentPart::Image {
                mime_type: mime,
                data_base64,
            });
            text.push_str("\n   image data is attached as a multimodal input.");
        } else if is_text_mime(&mime) {
            let (preview, truncated) = read_text_attachment_preview(&att.path)?;
            let (clean, _) = redact::redact(&preview);
            text.push_str("\n```text\n");
            text.push_str(&clean);
            if truncated {
                text.push_str("\n[truncated]");
            }
            text.push_str("\n```");
        } else {
            text.push_str("\n   binary contents were not sent to this cloud/local LLM provider.");
        }
    }
    parts.insert(0, ChatContentPart::Text { text });
    Ok(Some(LlmMessage::user_parts(parts)))
}

fn read_text_attachment_preview(path: &str) -> Result<(String, bool), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot read text attachment '{path}': {e}"))?;
    let mut limited = file.take(TEXT_ATTACHMENT_PREVIEW_BYTES + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read text attachment '{path}': {e}"))?;
    let truncated = bytes.len() as u64 > TEXT_ATTACHMENT_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(TEXT_ATTACHMENT_PREVIEW_BYTES as usize);
    }
    Ok((String::from_utf8_lossy(&bytes).to_string(), truncated))
}

/// Resolve the effective output format for a thread, falling back to the
/// global default. Returns one of "md" | "html" | "plain".
fn resolve_output_format(thread: &store::ChatThread, config: &AiConfig) -> String {
    let candidate = thread
        .output_format
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| config.chat_output_format.clone());
    match candidate.as_str() {
        "md" | "html" | "plain" => candidate,
        _ => "md".into(),
    }
}

/// Build the assistant system prompt. The base prompt explains the role; an
/// extra paragraph instructs the assistant to format its replies as Markdown,
/// raw HTML, or plain text — matching what the renderer is expecting.
fn build_system_prompt(format: &str) -> String {
    let base = "You are the AI assistant inside the Taomni terminal manager. \
                Help the user manage SSH sessions, analyse terminal output, and craft shell commands. \
                Reply in the same language the user writes in (default Chinese), and stay concise.";
    let format_clause = match format {
        "html" => {
            "Render your reply as a self-contained HTML fragment. \
                   Use semantic tags such as <p>, <ul>/<ol>, <li>, <h2>/<h3>, <code>, and <pre><code class=\"language-…\"> for code blocks. \
                   Do NOT wrap the answer in <html>, <body>, <head>, <script>, <style>, or include event handlers — the host sanitises everything else."
        }
        "plain" => {
            "Reply in plain text only — no Markdown syntax, no HTML tags. \
                    Keep paragraphs short and use blank lines for separation."
        }
        // "md" is the default.
        _ => {
            "Format your reply as GitHub-flavoured Markdown. \
              Use ```language fenced blocks for code, `inline code` for symbols/commands, \
              tables / bullet lists / headings (##, ###) when they help readability. \
              Do NOT wrap the entire answer in a single fenced block."
        }
    };
    format!("{}\n\n{}", base, format_clause)
}

/// Create a new chat thread.
#[tauri::command]
pub async fn chat_new_thread(
    provider_id: Option<String>,
    linked_session_id: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<store::ChatThread, String> {
    let config = AiConfig::load(&default_ai_config_path());
    let pid = provider_id.unwrap_or_else(|| config.llm.active.clone());
    let mode = normalize_thread_mode(mode)?;
    let thread = store::ChatThread {
        id: Uuid::new_v4().to_string(),
        title: "New chat".into(),
        provider_id: pid,
        created_at: now(),
        updated_at: now(),
        linked_session_id,
        source: "drawer".into(),
        mode,
        cc_session_id: None,
        acp_session_id: None,
        // New threads inherit the global default; the user can override per-thread later.
        output_format: None,
        cc_model: None,
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::create_thread(&db, &thread).map_err(|e| e.to_string())?;
    Ok(thread)
}

/// List recent chat threads.
#[tauri::command]
pub async fn chat_list_threads(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatThread>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::list_threads(&db, limit.unwrap_or(50)).map_err(|e| e.to_string())
}

/// List messages in a thread.
#[tauri::command]
pub async fn chat_list_messages(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatMessage>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::list_messages(&db, &thread_id).map_err(|e| e.to_string())
}

/// Delete a thread and all its messages.
#[tauri::command]
pub async fn chat_delete_thread(
    thread_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::delete_thread(&db, &thread_id).map_err(|e| e.to_string())?;
    }
    stop_thread_runtime(&thread_id, &app, state.inner()).await;
    Ok(())
}

/// Change the provider (LLM) bound to an existing thread. Subsequent
/// chat_send / chat_stream calls on this thread will use the new provider.
#[tauri::command]
pub async fn chat_set_thread_provider(
    thread_id: String,
    provider_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_provider(&db, &thread_id, &provider_id).map_err(|e| e.to_string())?;
    }
    // Switching away from a local agent provider orphans its per-thread child;
    // recycle so we don't leak the process / MCP token / temp dir.
    if provider_id != "claude-code" {
        crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    }
    if provider_id != "codex" {
        crate::agent::codex_bridge::commands::recycle_thread_process(state.inner(), &thread_id)
            .await;
    }
    acp::recycle_if_profile_changed(state.inner(), &thread_id, &provider_id).await;
    acp::recycle_media_process(state.inner(), &app, &thread_id).await;
    Ok(())
}

/// Set or clear the per-thread Claude Code model override. Pass `None`/empty
/// to inherit `cc_bridge.default_model`. The model
/// is a spawn-time `--model` arg the live process can't adopt, so we recycle
/// the thread's CC process — the next message respawns it with the new model.
#[tauri::command]
pub async fn chat_set_thread_cc_model(
    thread_id: String,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_cc_model(&db, &thread_id, model.as_deref())
            .map_err(|e| e.to_string())?;
    }
    crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    crate::agent::codex_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    Ok(())
}

/// Set or clear the per-thread output-format override ("md" | "html" | "plain").
/// Pass `None` (or an empty string) to clear and inherit `AiConfig.chat_output_format`.
#[tauri::command]
pub async fn chat_set_thread_output_format(
    thread_id: String,
    output_format: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let normalized = output_format
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if let Some(fmt) = normalized {
        if !matches!(fmt, "md" | "html" | "plain") {
            return Err(format!(
                "Invalid output_format '{}': expected 'md', 'html', or 'plain'.",
                fmt
            ));
        }
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::update_thread_output_format(&db, &thread_id, normalized).map_err(|e| e.to_string())
}

/// Sweep retention: delete threads older than `keep_days`. Returns the number
/// of threads deleted. Frontend invokes this at startup and on a 24h timer.
#[tauri::command]
pub async fn chat_purge_old(keep_days: u32, state: State<'_, AppState>) -> Result<usize, String> {
    let cutoff = chrono::Utc::now().timestamp() - (keep_days as i64) * 86_400;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::delete_threads_older_than(&db, cutoff).map_err(|e| e.to_string())
}

/// Export every thread + message into a single JSON file at `out_path`.
/// We write JSON (not zip) for portability — the user can compress externally.
/// Sensitive content already passed through `redact::redact` before persistence.
#[tauri::command]
pub async fn chat_export_archive(
    out_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    use serde_json::json;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let threads = store::list_threads(&db, 100_000).map_err(|e| e.to_string())?;
    let mut total = 0;
    let mut payload = Vec::with_capacity(threads.len());
    for t in &threads {
        let messages = store::list_messages(&db, &t.id).map_err(|e| e.to_string())?;
        total += messages.len();
        payload.push(json!({
            "thread": t,
            "messages": messages,
        }));
    }
    let json_text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&out_path, json_text).map_err(|e| e.to_string())?;
    Ok(total)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSendRequest {
    pub thread_id: String,
    pub content: String,
    /// Local files/images attached to this turn. The backend re-stats and
    /// canonicalizes paths before persisting or sending to providers.
    #[serde(default)]
    pub attachments: Vec<store::ChatAttachment>,
    /// Optional terminal content to attach as @terminal context.
    pub terminal_context: Option<String>,
    /// Phase 3.S — the `SessionConfig.id` of the saved session this CC thread
    /// is bound to, resolved by the frontend from the linked terminal tab's
    /// registry entry (`thread.linked_session_id` is a *tab* id, not a
    /// `SessionConfig.id`, so the backend cannot derive this on its own). Used
    /// to build the session-identity card injected into Claude Code. `None` for
    /// unbound / local / unsaved-tab threads.
    #[serde(default)]
    pub bound_session_id: Option<String>,
    /// Phase 3.3 — the bound terminal's live working directory (from the
    /// frontend's OSC-7 tracking). Unlike the session-identity card, cwd is
    /// volatile (the user `cd`s around), so it is injected *per turn* as a
    /// message prefix rather than baked into the spawn-time card. Informational
    /// only — it does not set the CC child's `current_dir` or grant `--add-dir`
    /// access (that is 3.2, deliberately out of scope). `None` when unknown.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Live local-terminal facts (platform / shell id / shell args / cwd) for
    /// Claude Code's appended system prompt. Only present for local terminal
    /// tabs; SSH/remote tabs leave this absent so their saved session card stays
    /// the source of truth.
    #[serde(default)]
    pub local_terminal_env: Option<crate::agent::cc_bridge::session_card::LocalTerminalEnv>,
    /// Phase 6 — the live `db_connections` runtime id this CC thread is bound to,
    /// for SQL/Redis DB sessions. Like `cwd`, it is volatile (the frontend
    /// regenerates it on each (re)connect and the backend can't derive it), so
    /// it is bridged *per turn* and stored into `AppState.agent_db_bindings` so the
    /// DB MCP handlers can resolve their bound connection. `None` for non-DB
    /// threads or a DB tab that isn't connected.
    #[serde(default)]
    pub bound_db_connection_id: Option<String>,
    /// Current objects selected in the bound DB tab's object tree. Bridged per
    /// turn so SQL MCP tools can answer prompts containing "selected tables".
    #[serde(default)]
    pub bound_db_selected_objects: Vec<crate::agent::context::AgentDbSelectedObject>,
    /// Backward-compatible single-table field accepted from older frontends.
    #[serde(default)]
    pub bound_db_selected_table: Option<crate::agent::context::AgentDbSelectedObject>,
    /// Current code-workspace editor context for local repo agent turns.
    #[serde(default)]
    pub code_workspace: Option<crate::agent::context::AgentCodeWorkspace>,
}

#[derive(Debug, Serialize)]
pub struct ChatSendResponse {
    pub user_message: store::ChatMessage,
    pub assistant_message: store::ChatMessage,
    pub redacted_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct ChatGenerateMediaRequest {
    pub thread_id: String,
    pub prompt: String,
    /// "image" or "video". Must match the thread mode.
    pub kind: String,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub num_frames: Option<u32>,
    #[serde(default)]
    pub frame_rate: Option<u32>,
    /// Reference attachments for providers that support image-guided media
    /// generation. The Grok CLI adapter receives image attachments as local
    /// ACP resource links.
    #[serde(default)]
    pub attachments: Vec<store::ChatAttachment>,
}

#[derive(Debug, Serialize)]
pub struct ChatGenerateMediaResponse {
    pub user_message: store::ChatMessage,
    pub assistant_message: store::ChatMessage,
    pub redacted_count: usize,
    pub saved_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaGenerationKind {
    Image,
    Video,
}

impl MediaGenerationKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "image" => Ok(Self::Image),
            "video" => Ok(Self::Video),
            other => Err(format!(
                "Invalid media generation kind '{other}': expected 'image' or 'video'."
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

struct GeneratedMediaFile {
    path: PathBuf,
    name: String,
    size: u64,
    mime: String,
    remote_url: Option<String>,
    video_id: Option<String>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct AgnesImageResponse {
    data: Vec<AgnesImageData>,
}

#[derive(Debug, Deserialize)]
struct AgnesImageData {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    b64_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgnesVideoCreateResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    video_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgnesVideoResultResponse {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    progress: Option<u32>,
    #[serde(default)]
    remixed_from_video_id: Option<String>,
    #[serde(default)]
    video_url: Option<String>,
    #[serde(default)]
    error: Option<Value>,
}

fn resolve_ai_api_key(
    provider_id: &str,
    api_key: &str,
    state: &AppState,
) -> Result<String, String> {
    if !api_key.starts_with(crate::vault::VAULT_REF_PREFIX) {
        if api_key.trim().is_empty() {
            return Err(format!("Provider '{provider_id}' is missing an API key."));
        }
        return Ok(api_key.to_string());
    }
    match state.vault.resolve(api_key) {
        Ok(Some(plaintext)) => Ok(plaintext.to_string()),
        Ok(None) => Ok(api_key.to_string()),
        Err(e) => {
            if e.contains(crate::vault::ERR_VAULT_LOCKED) {
                Err(format!(
                    "VAULT_LOCKED: provider '{provider_id}' needs the vault unlocked to load its API key"
                ))
            } else {
                Err(e)
            }
        }
    }
}

fn provider_api_url(provider_base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        provider_base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn provider_gateway_root(provider_base_url: &str) -> String {
    provider_base_url
        .trim_end_matches('/')
        .strip_suffix("/v1")
        .unwrap_or_else(|| provider_base_url.trim_end_matches('/'))
        .to_string()
}

fn provider_error(status: u16, body: String) -> String {
    let parsed: Result<Value, _> = serde_json::from_str(&body);
    let message = parsed
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                })
                .map(str::to_string)
        })
        .unwrap_or(body);
    format!("Provider error {status}: {message}")
}

fn decode_base64_image(value: &str) -> Result<(Vec<u8>, String), String> {
    let trimmed = value.trim();
    let (mime, data) = if let Some(rest) = trimmed.strip_prefix("data:") {
        let Some((mime, b64)) = rest.split_once(";base64,") else {
            return Err("Invalid Data URI image response.".into());
        };
        (mime.to_string(), b64)
    } else {
        ("image/png".to_string(), trimmed)
    };
    let bytes = BASE64_STANDARD
        .decode(data)
        .map_err(|e| format!("Decode generated image: {e}"))?;
    let inferred = infer_image_mime(&bytes).unwrap_or(mime);
    Ok((bytes, inferred))
}

fn infer_image_mime(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png".into())
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg".into())
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp".into())
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif".into())
    } else {
        None
    }
}

fn extension_for_mime(mime: &str, fallback: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => match fallback {
            "image" => "png",
            "video" => "mp4",
            _ => "bin",
        },
    }
}

fn generation_output_path(app: &AppHandle, kind: &str, ext: &str) -> Result<PathBuf, String> {
    let base = crate::resolved_app_data_dir(app)?
        .join("ai-generations")
        .join(chrono::Local::now().format("%Y-%m-%d").to_string());
    std::fs::create_dir_all(&base).map_err(|e| format!("Create generation output dir: {e}"))?;
    Ok(base.join(format!(
        "{}-{}-{}.{}",
        kind,
        chrono::Local::now().format("%H%M%S"),
        Uuid::new_v4().simple(),
        ext
    )))
}

async fn save_generated_bytes(
    app: &AppHandle,
    kind: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<PathBuf, String> {
    let ext = extension_for_mime(mime, kind);
    let path = generation_output_path(app, kind, ext)?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Save generated {kind}: {e}"))?;
    Ok(path)
}

async fn download_url_to_file(
    client: &Client,
    app: &AppHandle,
    kind: &str,
    url: &str,
    default_mime: &str,
) -> Result<(PathBuf, String, u64), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download generated {kind}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_mime)
        .to_string();
    let ext = extension_for_mime(&mime, kind);
    let path = generation_output_path(app, kind, ext)?;
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Create generated {kind} file: {e}"))?;
    let mut total = 0_u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download generated {kind}: {e}"))?;
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("Generated {kind} is too large."))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write generated {kind}: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Flush generated {kind}: {e}"))?;
    Ok((path, mime, total))
}

async fn generate_image_file(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    prompt: &str,
    size: &str,
) -> Result<GeneratedMediaFile, String> {
    let model = provider
        .image_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(AGNES_DEFAULT_IMAGE_MODEL)
        .to_string();
    let body = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "return_base64": true,
    });
    let resp = client
        .post(provider_api_url(&provider.base_url, "images/generations"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Generate image: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let api_resp: AgnesImageResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse image response: {e}"))?;
    let first = api_resp
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "Image generation returned no data.".to_string())?;
    let remote_url = first.url.clone();
    let (path, mime, size) = if let Some(b64) = first.b64_json {
        let (bytes, mime) = decode_base64_image(&b64)?;
        let path = save_generated_bytes(app, "image", &bytes, &mime).await?;
        let size = bytes.len() as u64;
        (path, mime, size)
    } else if let Some(url) = &first.url {
        download_url_to_file(client, app, "image", url, "image/png").await?
    } else {
        return Err("Image generation response contained neither b64_json nor url.".into());
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-image.png")
        .to_string();
    Ok(GeneratedMediaFile {
        path,
        name,
        size,
        mime,
        remote_url,
        video_id: None,
        model,
    })
}

fn validate_video_num_frames(num_frames: u32) -> Result<u32, String> {
    if num_frames == 0 || num_frames > 441 {
        return Err("num_frames must be between 1 and 441.".into());
    }
    if (num_frames + 7) % 8 != 0 {
        return Err("num_frames must follow the 8n + 1 rule, for example 81 or 121.".into());
    }
    Ok(num_frames)
}

async fn generate_video_file(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    req: &ChatGenerateMediaRequest,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    let model = provider
        .video_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(AGNES_DEFAULT_VIDEO_MODEL)
        .to_string();
    let num_frames = validate_video_num_frames(req.num_frames.unwrap_or(DEFAULT_VIDEO_NUM_FRAMES))?;
    let frame_rate = req
        .frame_rate
        .unwrap_or(DEFAULT_VIDEO_FRAME_RATE)
        .clamp(1, 60);
    let body = json!({
        "model": model,
        "prompt": prompt,
        "height": req.height.unwrap_or(DEFAULT_VIDEO_HEIGHT),
        "width": req.width.unwrap_or(DEFAULT_VIDEO_WIDTH),
        "num_frames": num_frames,
        "frame_rate": frame_rate,
    });
    let resp = client
        .post(provider_api_url(&provider.base_url, "videos"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Create video task: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let create_resp: AgnesVideoCreateResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse video task response: {e}"))?;
    let video_id = create_resp
        .video_id
        .clone()
        .or(create_resp.id.clone())
        .or(create_resp.task_id.clone())
        .ok_or_else(|| "Video task response did not include video_id or task_id.".to_string())?;
    let gateway_root = provider_gateway_root(&provider.base_url);
    let mut last_status = create_resp.status.unwrap_or_else(|| "queued".into());
    let mut last_progress = 0_u32;
    let mut final_url: Option<String> = None;
    for _ in 0..VIDEO_POLL_ATTEMPTS {
        let resp = client
            .get(format!("{gateway_root}/agnesapi"))
            .bearer_auth(api_key)
            .query(&[
                ("video_id", video_id.as_str()),
                ("model_name", model.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Poll video task: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(provider_error(status.as_u16(), body));
        }
        let result: AgnesVideoResultResponse = resp
            .json()
            .await
            .map_err(|e| format!("Parse video result response: {e}"))?;
        last_status = result.status.unwrap_or(last_status);
        last_progress = result.progress.unwrap_or(last_progress);
        if last_status == "completed" {
            final_url = result.remixed_from_video_id.or(result.video_url);
            break;
        }
        if last_status == "failed" {
            return Err(format!(
                "Video generation failed: {}",
                result
                    .error
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown error".into())
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(VIDEO_POLL_INTERVAL_SECS)).await;
    }
    let Some(remote_url) = final_url else {
        return Err(format!(
            "Video generation timed out while status was '{last_status}' ({last_progress}%)."
        ));
    };
    let (path, mime, size) =
        download_url_to_file(client, app, "video", &remote_url, "video/mp4").await?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-video.mp4")
        .to_string();
    Ok(GeneratedMediaFile {
        path,
        name,
        size,
        mime,
        remote_url: Some(remote_url),
        video_id: Some(video_id),
        model,
    })
}

fn provider_supports_media_generation(
    provider: &crate::ai::config::LlmProviderConfig,
    kind: MediaGenerationKind,
) -> bool {
    match kind {
        MediaGenerationKind::Image => provider.capabilities.image_generation,
        MediaGenerationKind::Video => provider.capabilities.video_generation,
    }
}

async fn generate_media_with_provider_key(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    req: &ChatGenerateMediaRequest,
    kind: MediaGenerationKind,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    match kind {
        MediaGenerationKind::Image => {
            let size = req
                .size
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_IMAGE_SIZE);
            generate_image_file(client, app, provider, api_key, prompt, size).await
        }
        MediaGenerationKind::Video => {
            generate_video_file(client, app, provider, api_key, req, prompt).await
        }
    }
}

fn build_provider_http_client(
    state: &AppState,
    provider: &crate::ai::config::LlmProviderConfig,
    timeout: std::time::Duration,
) -> Result<Client, String> {
    let proxy_url = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::ai::config::resolve_provider_proxy_url(provider, Some(&db), Some(&state.vault))?
    };
    let mut builder = Client::builder().timeout(timeout);
    if let Some(proxy_url) = proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("Create provider HTTP client: {e}"))
}

async fn generate_media_with_provider_keys(
    state: &AppState,
    app: &AppHandle,
    provider_id: &str,
    provider: &crate::ai::config::LlmProviderConfig,
    req: &ChatGenerateMediaRequest,
    kind: MediaGenerationKind,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    let api_keys = provider.effective_api_keys();
    let key_count = api_keys.len();
    let mut last_err: Option<String> = None;
    let client = build_provider_http_client(state, provider, std::time::Duration::from_secs(360))?;

    for _ in 0..key_count {
        let key_index = {
            let ai_ctx = state.ai_ctx.read().await;
            ai_ctx.llm.next_key_index(provider_id, key_count)
        };
        let Some(api_key_ref) = api_keys.get(key_index).copied() else {
            continue;
        };
        let api_key = match resolve_ai_api_key(provider_id, api_key_ref, state) {
            Ok(api_key) => api_key,
            Err(err) => {
                last_err = Some(err);
                continue;
            }
        };
        match generate_media_with_provider_key(&client, app, provider, &api_key, req, kind, prompt)
            .await
        {
            Ok(file) => return Ok(file),
            Err(err) => {
                tracing::warn!(
                    provider = %provider_id,
                    kind = kind.as_str(),
                    error = %err,
                    "media generation key failed, trying next key"
                );
                last_err = Some(err);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| format!("Provider '{provider_id}' has no API keys.")))
}

#[tauri::command]
pub async fn chat_generate_media(
    req: ChatGenerateMediaRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ChatGenerateMediaResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }
    let kind = MediaGenerationKind::parse(&req.kind)?;
    let attachments = validate_chat_attachments(&req.attachments)?;
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != kind.as_str() {
        return Err(format!(
            "Thread '{}' is a {} thread, not a {} generation thread.",
            thread.id,
            thread.mode,
            kind.as_str()
        ));
    }

    let (clean_prompt, redacted_count) = redact::redact(&req.prompt);
    let ai_config = AiConfig::load(&default_ai_config_path());

    let generated = if let Some(profile_id) =
        crate::agent::acp_bridge::profile_id_from_provider_id(&thread.provider_id)
    {
        let bridge = &ai_config.acp_bridge;
        let profile = bridge
            .profile(profile_id)
            .cloned()
            .ok_or_else(|| format!("ACP profile '{profile_id}' is not configured."))?;
        if !bridge.enabled
            || !profile.enabled
            || ai_config.fully_disabled
            || ai_config.full_local_mode
        {
            return Err("Grok CLI is unavailable in full-local / fully-disabled mode or its ACP profile is disabled.".into());
        }
        let supports_media = match kind {
            MediaGenerationKind::Image => profile.supports_image_generation(),
            MediaGenerationKind::Video => profile.supports_video_generation(),
        };
        if !supports_media {
            return Err(format!(
                "ACP profile '{profile_id}' does not support {} generation.",
                kind.as_str()
            ));
        }
        acp::generate_grok_media(
            &app,
            state.inner(),
            &req.thread_id,
            bridge,
            &profile,
            kind,
            &clean_prompt,
            &attachments,
        )
        .await?
    } else if let Some(group_id) = provider_group_id_from_route(&thread.provider_id) {
        let route_id = thread.provider_id.clone();
        let attempt_count = {
            let ai_ctx = state.ai_ctx.read().await;
            ai_ctx.llm.provider_group_len(&route_id).unwrap_or(0)
        };
        if attempt_count == 0 {
            return Err(format!(
                "Provider group '{group_id}' is not configured or has no providers."
            ));
        }

        let mut saw_supported_provider = false;
        let mut last_err: Option<String> = None;
        let mut generated: Option<GeneratedMediaFile> = None;
        for _ in 0..attempt_count {
            let provider_id = {
                let ai_ctx = state.ai_ctx.read().await;
                ai_ctx.llm.next_provider_in_group(&route_id)
            };
            let Some(provider_id) = provider_id else {
                continue;
            };
            let Some(provider) = ai_config.llm.providers.get(&provider_id).cloned() else {
                continue;
            };
            if !provider_supports_media_generation(&provider, kind) {
                continue;
            }
            saw_supported_provider = true;
            match generate_media_with_provider_keys(
                state.inner(),
                &app,
                &provider_id,
                &provider,
                &req,
                kind,
                &clean_prompt,
            )
            .await
            {
                Ok(file) => {
                    generated = Some(file);
                    break;
                }
                Err(err) => {
                    tracing::warn!(
                        group = %route_id,
                        provider = %provider_id,
                        kind = kind.as_str(),
                        error = %err,
                        "media generation provider failed, trying next group provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        if let Some(file) = generated {
            file
        } else if !saw_supported_provider {
            return Err(format!(
                "Provider group '{group_id}' does not support {} generation.",
                kind.as_str()
            ));
        } else {
            return Err(last_err.unwrap_or_else(|| {
                format!(
                    "Provider group '{group_id}' failed to generate {}.",
                    kind.as_str()
                )
            }));
        }
    } else {
        let provider = ai_config
            .llm
            .providers
            .get(&thread.provider_id)
            .cloned()
            .ok_or_else(|| format!("Provider '{}' is not configured.", thread.provider_id))?;
        if !provider_supports_media_generation(&provider, kind) {
            return Err(format!(
                "Provider '{}' does not support {} generation.",
                thread.provider_id,
                kind.as_str()
            ));
        }
        generate_media_with_provider_keys(
            state.inner(),
            &app,
            &thread.provider_id,
            &provider,
            &req,
            kind,
            &clean_prompt,
        )
        .await?
    };
    let display_path = normalize_path_for_display(generated.path.to_string_lossy().to_string());
    let mut assistant_content = match kind {
        MediaGenerationKind::Image => format!("Generated image saved to:\n{display_path}"),
        MediaGenerationKind::Video => format!("Generated video saved to:\n{display_path}"),
    };
    if let Some(remote_url) = &generated.remote_url {
        assistant_content.push_str("\n\nRemote URL:\n");
        assistant_content.push_str(remote_url);
    }
    if let Some(video_id) = &generated.video_id {
        assistant_content.push_str("\n\nVideo ID: ");
        assistant_content.push_str(video_id);
    }
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_prompt,
        created_at: ts,
        redacted: redacted_count > 0,
        attachments,
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: assistant_content,
        created_at: ts + 1,
        redacted: false,
        attachments: vec![store::ChatAttachment {
            id: Uuid::new_v4().to_string(),
            kind: kind.as_str().into(),
            path: display_path.clone(),
            name: generated.name,
            size: generated.size,
            mime: Some(generated.mime),
            preview_url: generated.remote_url.clone(),
        }],
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if history.is_empty() {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    Ok(ChatGenerateMediaResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
        saved_path: display_path,
        remote_url: generated.remote_url,
        video_id: generated.video_id,
        model: generated.model,
    })
}

/// Send a message and get a response (non-streaming for v2.4 static shell).
#[tauri::command]
pub async fn chat_send(
    req: ChatSendRequest,
    state: State<'_, AppState>,
) -> Result<ChatSendResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }
    let attachments = validate_chat_attachments(&req.attachments)?;

    // Load thread to get provider.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != "chat" {
        return Err(format!(
            "Thread '{}' is a {} generation thread; use media generation.",
            thread.id, thread.mode
        ));
    }

    // Redact user content.
    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Resolve the effective output format and build the system prompt around it.
    let ai_config = AiConfig::load(&default_ai_config_path());
    let output_format = resolve_output_format(&thread, &ai_config);
    let system_prompt = build_system_prompt(&output_format);

    // Build LLM messages from history + new user message.
    let mut llm_messages: Vec<LlmMessage> = vec![LlmMessage::system(system_prompt)];

    // Add terminal context if provided.
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!(
            "[Terminal context]\n```\n{}\n```",
            clean_ctx
        )));
        llm_messages.push(LlmMessage::assistant(
            "Acknowledged — I have read the terminal output.",
        ));
    }

    // Add conversation history.
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: crate::llm::ChatContent::text(msg.content.clone()),
        });
    }
    if let Some(attachment_message) = build_llm_attachment_message(&attachments)? {
        llm_messages.push(attachment_message);
    }
    llm_messages.push(LlmMessage::user(clean_content.clone()));

    // Route through LlmRouter — respects task routing + fallback + active provider.
    // The thread's provider_id picks the route: if it equals the configured
    // chat_drawer route, we go through ChatDrawer task; otherwise we ask the
    // router for that specific provider directly.
    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: false,
    };

    let resp = {
        let ai_ctx = state.ai_ctx.read().await;
        // Prefer the thread's pinned provider when available.
        if let Some(provider) = ai_ctx.llm.provider(&thread.provider_id) {
            provider.chat(llm_req).await.map_err(|e| e.to_string())?
        } else if ai_ctx.llm.needs_vault_unlock(&thread.provider_id) {
            // Pinned provider is blocked on a locked vault. Fail closed with
            // a VAULT_LOCKED error so the frontend can prompt for unlock
            // instead of routing the request through some other provider the
            // user did not intend to use.
            return Err(format!(
                "VAULT_LOCKED: provider '{}' needs the vault unlocked to load its API key",
                thread.provider_id
            ));
        } else if let Some(group_id) = provider_group_id_from_route(&thread.provider_id) {
            return Err(format!(
                "Provider group '{group_id}' has no available chat providers."
            ));
        } else {
            // Fall back to the task-routed provider with timeout/fallback.
            ai_ctx
                .llm
                .complete(llm_req, TaskKind::ChatDrawer)
                .await
                .map_err(|e| e.to_string())?
        }
    };

    // Persist both messages.
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_content,
        created_at: ts,
        redacted: redacted_count > 0,
        attachments,
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: resp.content,
        created_at: ts + 1,
        redacted: false,
        attachments: Vec::new(),
    };

    // Auto-title thread from first user message.
    let is_first = history.is_empty();

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if is_first {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    Ok(ChatSendResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEventOut {
    /// User message persisted; frontend can render it immediately.
    UserMessage { message: store::ChatMessage },
    /// Assistant message id allocated; tokens will follow under this id.
    AssistantStart {
        id: String,
        thread_id: String,
        created_at: i64,
    },
    /// One token (or token group) of the assistant response.
    Token { id: String, content: String },
    /// Stream ended cleanly; assistant message persisted.
    End {
        id: String,
        thread_id: String,
        content: String,
        redacted_count: usize,
    },
    /// Stream ended with an error (assistant message NOT persisted).
    Error { id: String, message: String },
    /// Claude Code tool activity for live, display-only cards (3.5). Carries NO
    /// re-executable payload — confirmation already happened via the MCP
    /// permission prompt; this is purely for rendering. The persisted message
    /// still contains the compact text transcript line (history durability), so
    /// the frontend shows these cards only while the message is streaming.
    CcToolActivity {
        /// Assistant message id these cards group under.
        id: String,
        /// CC tool_use id, pairing a "use" with its later "result".
        call_id: String,
        /// "use" | "result".
        phase: String,
        tool: String,
        detail: String,
    },
    /// Claude Code token/cost/timing rollup for the assistant message footer
    /// (3.5). Live-only (not persisted), emitted once on the final result.
    Usage {
        id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
}

/// Preferred scalar keys when summarizing a tool call for the chat transcript.
/// Ordered by usefulness for humans scanning a collapsed tool card.
const TOOL_ARG_SUMMARY_KEYS: &[&str] = &[
    "command",
    "cmd",
    "query",
    "pattern",
    "file_path",
    "target_file",
    "notebook_path",
    "path",
    "url",
    "uri",
    "prompt",
    "description",
    "glob",
    "directory",
    "cwd",
    "working_directory",
    "name",
    "tool",
    "tool_name",
    "toolName",
    "server",
    "server_name",
    "message",
    "content",
    "old_string",
    "new_string",
    "text",
    "search",
    "replace",
];

/// Keys that almost always carry secrets — never surface their values in the UI.
fn tool_arg_key_looks_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("credential")
        || lower.contains("cookie")
        || lower.contains("private_key")
        || lower == "key"
        || lower.ends_with("_key")
        || lower.ends_with("key") && lower.contains("auth")
}

/// Flatten a JSON value into a short, single-line display string.
fn tool_arg_value_preview(value: &serde_json::Value, max_chars: usize) -> Option<String> {
    let raw = match value {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Array(items) if !items.is_empty() && items.len() <= 6 => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| tool_arg_value_preview(item, max_chars / items.len().max(1)))
                .collect();
            if parts.is_empty() {
                return None;
            }
            parts.join(", ")
        }
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    Some(truncate_display_chars(&raw, max_chars))
}

fn truncate_display_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// The one-line argument summary for a tool call ("ls -la", query text, path…).
///
/// Returns an owned string so nested / multi-key summaries can be composed.
/// Only allowlisted, non-secret scalar fields are considered — never dump the
/// whole JSON object (which may contain credentials).
fn cc_tool_arg_summary(input: &serde_json::Value) -> Option<String> {
    let obj = input.as_object()?;
    if obj.is_empty() {
        return None;
    }

    // Prefer a single high-signal field when present.
    for key in TOOL_ARG_SUMMARY_KEYS {
        if tool_arg_key_looks_secret(key) {
            continue;
        }
        if let Some(preview) = obj.get(*key).and_then(|v| tool_arg_value_preview(v, 160)) {
            // For nested MCP dispatchers, also surface the nested tool name.
            if matches!(*key, "tool" | "tool_name" | "toolName" | "name") {
                if let Some(nested) = obj
                    .get("arguments")
                    .or_else(|| obj.get("input"))
                    .or_else(|| obj.get("params"))
                    .and_then(cc_tool_arg_summary)
                {
                    return Some(format!("{preview} · {nested}"));
                }
            }
            return Some(preview);
        }
    }

    // Nested wrappers: use_tool / CallMcpTool often put real args one level down.
    for nest_key in ["arguments", "input", "params", "rawInput", "raw_input"] {
        if let Some(nested) = obj.get(nest_key).and_then(cc_tool_arg_summary) {
            return Some(nested);
        }
    }

    // Fallback: join up to three allowlisted non-secret fields as `k=v`.
    let mut parts = Vec::new();
    for (key, value) in obj {
        if tool_arg_key_looks_secret(key) {
            continue;
        }
        if !TOOL_ARG_SUMMARY_KEYS
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(key))
        {
            continue;
        }
        if let Some(preview) = tool_arg_value_preview(value, 80) {
            parts.push(format!("{key}={preview}"));
        }
        if parts.len() >= 3 {
            break;
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

/// Render a CC tool-use event as a compact, human-readable transcript line.
///
/// This is *not* a `[TOOL_CALL]` marker — it carries no machine-parseable JSON,
/// so MessageBubble never turns it into an ActionCard or re-executes it. It
/// exists purely so the chat keeps a record of what Claude Code did (the real
/// confirmation happens live via the in-app MCP server's permission prompt).
fn format_cc_tool_use(name: &str, input: &serde_json::Value) -> String {
    match cc_tool_arg_summary(input) {
        Some(s) => format!("\n> 🔧 `{}` — {}\n", name, s),
        None => format!("\n> 🔧 `{}`\n", name),
    }
}

/// A short, single-line preview of a tool result for the transcript /
/// display card (collapses whitespace, truncates).
fn cc_tool_result_preview(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    // Status-only strings from ACP ("completed"/"failed") are low signal —
    // keep them short; richer tool output gets a longer preview.
    let max = if flat.eq_ignore_ascii_case("completed")
        || flat.eq_ignore_ascii_case("failed")
        || flat.eq_ignore_ascii_case("ok")
    {
        32
    } else {
        240
    };
    truncate_display_chars(&flat, max)
}

fn append_agent_context_to_system_prompt(
    mut system_prompt: String,
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> String {
    let mut block = String::new();
    if !agent_ctx.session_card.trim().is_empty() {
        block.push_str(agent_ctx.session_card.trim());
        block.push('\n');
    }
    if let Some(cwd) = agent_ctx
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (clean_cwd, _) = redact::redact(cwd);
        block.push_str(&format!("Current working directory: {clean_cwd}\n"));
    }
    if let Some(code_block) = code_workspace_context_block(agent_ctx) {
        block.push_str(code_block.trim_end());
        block.push('\n');
    }
    if agent_ctx.bound_db_connection_id.is_some() {
        block.push_str("Database binding: active for SQL/Redis tools.\n");
    }
    if let Some(line) = selected_objects_context_line(agent_ctx) {
        block.push_str(&line);
    }
    if block.trim().is_empty() {
        return system_prompt;
    }
    system_prompt.push_str("\n\n[Taomni runtime context]\n");
    system_prompt.push_str(block.trim_end());
    system_prompt
}

fn selected_objects_context_line(
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Option<String> {
    let objects =
        crate::agent::context::normalize_selected_objects(&agent_ctx.bound_db_selected_objects);
    if objects.is_empty() {
        return None;
    }
    let selected = objects
        .iter()
        .take(10)
        .map(|object| format!("{} [{}]", object.display_name(), object.kind))
        .collect::<Vec<_>>()
        .join(", ");
    let selectable = objects
        .iter()
        .filter(|object| object.is_selectable())
        .take(10)
        .map(|object| format!("{} [{}]", object.display_name(), object.kind))
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if objects.len() > 10 { ", ..." } else { "" };
    let mut line = format!("Database selected objects: {selected}{suffix}\n");
    if selectable.is_empty() {
        line.push_str("Database selected queryable objects: (none)\n");
    } else {
        line.push_str(&format!(
            "Database selected queryable objects: {selectable}{suffix}\n"
        ));
    }
    Some(line)
}

fn code_workspace_context_block(
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Option<String> {
    let workspace = agent_ctx
        .code_workspace
        .as_ref()
        .and_then(crate::agent::context::AgentCodeWorkspace::normalized)?;
    let mut lines = vec!["Code workspace:".to_string()];
    if !workspace.roots.is_empty() {
        lines.push("Roots:".into());
        for root in &workspace.roots {
            let (path, _) = redact::redact(&root.path);
            lines.push(format!(
                "- {} [{}]: {}",
                root.name,
                root.kind.as_deref().unwrap_or("folder"),
                path
            ));
        }
    } else if !workspace.repo_root.is_empty() {
        let (repo_root, _) = redact::redact(&workspace.repo_root);
        lines.push(format!("Root: {repo_root}"));
    }
    if !workspace.loose_files.is_empty() {
        lines.push("Loose files:".into());
        for file in &workspace.loose_files {
            let (path, _) = redact::redact(&file.path);
            let name = file.name.as_deref().unwrap_or(&file.id);
            lines.push(format!("- {name}: {path}"));
        }
    }
    if let Some(active_file) = workspace.active_file.as_ref() {
        lines.push(format!(
            "Code active file: {}",
            format_code_workspace_file(active_file)
        ));
    } else if let Some(active_path) = workspace.active_path.as_deref() {
        lines.push(format!("Code active file: {active_path}"));
    }
    if !workspace.open_files.is_empty() {
        lines.push(format!(
            "Code open files: {}",
            format_code_workspace_files(&workspace.open_files)
        ));
    } else if !workspace.open_paths.is_empty() {
        lines.push(format!(
            "Code open files: {}",
            format_code_workspace_paths(&workspace.open_paths)
        ));
    }
    if !workspace.dirty_files.is_empty() {
        lines.push(format!(
            "Code unsaved files: {}",
            format_code_workspace_files(&workspace.dirty_files)
        ));
    } else if !workspace.dirty_paths.is_empty() {
        lines.push(format!(
            "Code unsaved files: {}",
            format_code_workspace_paths(&workspace.dirty_paths)
        ));
    }
    if let Some(lsp) = workspace.lsp.as_ref() {
        if let Some(status) = lsp.active_status.as_ref() {
            let name = status
                .display_name
                .as_deref()
                .or(status.language_id.as_deref())
                .unwrap_or("language server");
            let state = if status.active {
                "active"
            } else if status.available {
                "available"
            } else {
                "missing"
            };
            let command = status
                .selected_command
                .as_deref()
                .map(|cmd| format!(" via {cmd}"))
                .unwrap_or_default();
            lines.push(format!("Code LSP: {name} {state}{command}"));
            if !status.active {
                if let Some(hint) = status.install_hint.as_deref() {
                    lines.push(format!("Code LSP install hint: {hint}"));
                } else if let Some(error) = status.error.as_deref() {
                    lines.push(format!("Code LSP issue: {error}"));
                }
            }
        }
        if !lsp.diagnostics.is_empty() {
            lines.push("Code diagnostics:".into());
            for diagnostic in lsp.diagnostics.iter().take(12) {
                let file = format_code_workspace_file(&diagnostic.file);
                let mut counts = Vec::new();
                if diagnostic.error_count > 0 {
                    counts.push(format!("{} error(s)", diagnostic.error_count));
                }
                if diagnostic.warning_count > 0 {
                    counts.push(format!("{} warning(s)", diagnostic.warning_count));
                }
                if diagnostic.info_count > 0 {
                    counts.push(format!("{} info/hint", diagnostic.info_count));
                }
                let counts = if counts.is_empty() {
                    "diagnostics".to_string()
                } else {
                    counts.join(", ")
                };
                let messages = if diagnostic.messages.is_empty() {
                    String::new()
                } else {
                    format!(" - {}", diagnostic.messages.join("; "))
                };
                lines.push(format!("- {file}: {counts}{messages}"));
            }
        }
    }
    Some(format!("{}\n", lines.join("\n")))
}

fn format_code_workspace_file(file: &crate::agent::context::AgentCodeWorkspaceFile) -> String {
    match file.kind.as_str() {
        "root" => {
            let root = file
                .root_name
                .as_deref()
                .or(file.root_id.as_deref())
                .unwrap_or("root");
            let path = file.path.as_deref().unwrap_or("");
            format!("{root}/{path}")
        }
        "loose" => {
            let path = file.path.as_deref().unwrap_or("");
            let (clean, _) = redact::redact(path);
            clean
        }
        _ => file.path.as_deref().unwrap_or("").to_string(),
    }
}

fn format_code_workspace_files(files: &[crate::agent::context::AgentCodeWorkspaceFile]) -> String {
    const MAX_DISPLAY_PATHS: usize = 12;
    let shown = files
        .iter()
        .take(MAX_DISPLAY_PATHS)
        .map(format_code_workspace_file)
        .collect::<Vec<_>>()
        .join(", ");
    if files.len() > MAX_DISPLAY_PATHS {
        format!("{shown}, ...")
    } else {
        shown
    }
}

fn format_code_workspace_paths(paths: &[String]) -> String {
    const MAX_DISPLAY_PATHS: usize = 12;
    let shown = paths
        .iter()
        .take(MAX_DISPLAY_PATHS)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > MAX_DISPLAY_PATHS {
        format!("{shown}, ...")
    } else {
        shown
    }
}

fn llm_tools_from_mcp(tools: Vec<rmcp::model::Tool>) -> Vec<ChatTool> {
    tools
        .into_iter()
        .map(|tool| ChatTool {
            name: tool.name.to_string(),
            description: tool.description.map(|description| description.to_string()),
            input_schema: serde_json::Value::Object(tool.input_schema.as_ref().clone()),
        })
        .collect()
}

fn assistant_tool_message(content: &str, tool_calls: &[ChatToolCall]) -> LlmMessage {
    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(ChatContentPart::Text {
            text: content.to_string(),
        });
    }
    parts.extend(tool_calls.iter().map(|call| ChatContentPart::ToolUse {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    }));
    LlmMessage {
        role: "assistant".into(),
        content: crate::llm::ChatContent::Parts(parts),
    }
}

#[tauri::command]
pub async fn chat_stop_stream(
    thread_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    stop_thread_runtime(&thread_id, &app, state.inner()).await;
    Ok(())
}

/// Stop every process and pending native permission tied to one thread. This
/// is used both for an explicit Stop action and when deleting a thread so an
/// already-visible confirmation card cannot approve work for a removed chat.
async fn stop_thread_runtime(thread_id: &str, app: &AppHandle, state: &AppState) {
    // Stop the in-flight turn regardless of provider/runtime. Claude Code also
    // and Codex keep persistent per-thread process registries for reuse; remove
    // those entries on explicit stop so the next turn starts from clean bridge
    // processes.
    let run = { state.chat_runs.lock().await.remove(thread_id) };
    let cc_process = { state.cc_processes.lock().await.remove(thread_id) };
    let codex_process = { state.codex_processes.lock().await.remove(thread_id) };
    let acp_process = { state.acp_processes.lock().await.remove(thread_id) };
    let acp_media_process = { state.acp_media_processes.lock().await.remove(thread_id) };

    if let Some(run) = run {
        run.stop().await;
    }
    if let Some(process) = cc_process {
        if !process.is_stopped() {
            process.stop().await;
        }
    }
    if let Some(process) = codex_process {
        process.stop().await;
    }
    if let Some(process) = acp_process {
        process.stop().await;
    }
    if let Some(process) = acp_media_process {
        process.stop().await;
    }
    // Clear a visible native-tool gate immediately even when its subprocess
    // has just been stopped and cannot deliver its own runtime event.
    let _ = app.emit(
        "agent-acp-permission-dismissed",
        json!({ "threadId": thread_id, "permissionOwnerId": null, "callId": null }),
    );
}

/// Streaming variant of `chat_send`. Emits events on
/// `chat-stream:{thread_id}` and resolves once the stream finishes (or errors).
#[tauri::command]
pub async fn chat_stream(
    req: ChatSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }

    let event_name = format!("chat-stream:{}", req.thread_id);
    let emit = |evt: &StreamEventOut| {
        let _ = app.emit(&event_name, evt.clone());
    };
    let attachments = validate_chat_attachments(&req.attachments)?;

    // Load thread + history.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != "chat" {
        return Err(format!(
            "Thread '{}' is a {} generation thread; use media generation.",
            thread.id, thread.mode
        ));
    }

    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Persist user message immediately.
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_content.clone(),
        created_at: ts,
        redacted: redacted_count > 0,
        attachments: attachments.clone(),
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
    }
    emit(&StreamEventOut::UserMessage {
        message: user_msg.clone(),
    });

    let agent_ctx = crate::agent::context::build_agent_thread_context(
        state.inner(),
        crate::agent::context::AgentThreadContextInput {
            thread_id: req.thread_id.clone(),
            linked_session_id: thread.linked_session_id.clone(),
            bound_session_id: req.bound_session_id.clone(),
            cwd: req.cwd.clone(),
            local_terminal_env: req.local_terminal_env.clone(),
            bound_db_connection_id: req.bound_db_connection_id.clone(),
            bound_db_selected_objects: req.bound_db_selected_objects.clone(),
            bound_db_selected_table: req.bound_db_selected_table.clone(),
            code_workspace: req.code_workspace.clone(),
        },
    )?;

    if crate::agent::acp_bridge::profile_id_from_provider_id(&thread.provider_id).is_some() {
        return acp::stream(
            &req,
            &app,
            state.inner(),
            &event_name,
            &thread,
            &history,
            &attachments,
            &clean_content,
            redacted_count,
            &agent_ctx,
        )
        .await;
    }

    if thread.provider_id == "claude-code" {
        // Allocate the assistant message id and begin streaming.
        let assistant_id = Uuid::new_v4().to_string();
        let assistant_ts = now() + 1;
        emit(&StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        });

        // 1. Verify Claude Code is enabled
        let ai_config = AiConfig::load(&default_ai_config_path());
        if !ai_config.cc_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message:
                    "Claude Code is unavailable in full-local / fully-disabled mode or is disabled."
                        .into(),
            });
            return Ok(());
        }

        // 2. Find Claude Code CLI binary path
        let binary = if ai_config.cc_bridge.binary == "auto" {
            crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
        } else {
            ai_config.cc_bridge.binary.clone()
        };

        // 3. Resolve session id for --resume continuity.
        let resume_session = thread.cc_session_id.clone();

        // 4. Get or create the per-thread CC process. Only a *new* process
        //    materialises temp config files — a reused process keeps the
        //    obscure settings file it was launched with (and which is scrubbed
        //    when the session stops).
        let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
        let process = match existing {
            Some(p) => p,
            None => {
                let effective_proxy =
                    match crate::agent::cc_bridge::config::resolve_effective_proxy_url(
                        state.inner(),
                        &ai_config.cc_bridge,
                    ) {
                        Ok(proxy) => proxy,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                // Phase 6 — pick the MCP flavor from the shared agent context so
                // the thread loads only the right tool surface: SQL, Redis, or shell.
                let flavor = agent_ctx.flavor;

                // Provision the in-app rmcp MCP server + a per-thread scoped
                // token (trust inferred from whether the thread is linked to a
                // remote session). Injected into the thread's .mcp.json.
                let (cc_server_url, cc_token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread(
                        &app,
                        &req.thread_id,
                        agent_ctx.linked_session_id.clone(),
                        agent_ctx.bound_session_id.clone(),
                        flavor,
                        ai_config.cc_bridge.confirm_readonly,
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                let control_server_url =
                    match crate::agent::cc_bridge::mcp_http::control_server_url() {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                // Resolve the user's custom settings.json from the vault (when
                // configured). A locked vault means we can't read the token, so
                // surface it as a stream error and let the UI prompt to unlock.
                let custom = match crate::agent::cc_bridge::config::resolve_custom_settings(
                    &ai_config.cc_bridge,
                    &state.vault,
                ) {
                    Ok(c) => c,
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };
                let files = match crate::agent::cc_bridge::config::create_session_files(
                    custom.as_deref(),
                    flavor.server_name(),
                    &cc_server_url,
                    &cc_token,
                    &control_server_url,
                ) {
                    Ok(f) => f,
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };

                // Phase 3.S — assemble the session-identity card so CC knows
                // which saved session this thread is bound to, then inject it
                // as CC's appended system prompt. Written into the process temp
                // dir (scrubbed on stop/drop) and passed via the *file* flag so
                // the bound host/user never appear in argv (which other local
                // users can read via `ps`).
                let session_card = agent_ctx.session_card.clone();
                let card_path = files.dir.join("system-prompt.txt");
                let card_file: Option<String> = match std::fs::write(&card_path, &session_card) {
                    Ok(()) => Some(card_path.to_string_lossy().to_string()),
                    Err(e) => {
                        eprintln!("[cc] session card write failed, continuing without it: {e}");
                        None
                    }
                };

                // Build extra args. The model is per-thread (3.4) when set,
                // else the configured default. Baked into argv at spawn, so a
                // model change recycles the process (chat_set_thread_cc_model).
                let model = thread
                    .cc_model
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| ai_config.cc_bridge.default_model.clone());
                let mut extra_args = vec![
                    "--model".into(),
                    model,
                    "--max-turns".into(),
                    ai_config.cc_bridge.max_turns.to_string(),
                    "--settings".into(),
                    files.settings_path.to_string_lossy().to_string(),
                    "--mcp-config".into(),
                    files.mcp_path.to_string_lossy().to_string(),
                    // Use *only* our MCP config; ignore any user ~/.claude MCP
                    // that could bypass the permission pipeline.
                    "--strict-mcp-config".into(),
                    "--permission-prompt-tool".into(),
                    flavor.permission_prompt_tool().into(),
                ];
                // Phase 3.S — inject the session-identity card (file variant
                // keeps host/user out of argv).
                if let Some(path) = card_file {
                    extra_args.push("--append-system-prompt-file".into());
                    extra_args.push(path);
                }
                if let Some(sid) = &resume_session {
                    extra_args.push("--resume".into());
                    extra_args.push(sid.clone());
                }

                let p = std::sync::Arc::new(
                    crate::agent::cc_bridge::process::CcProcess::new(
                        &binary,
                        extra_args,
                        Some(files.dir),
                    )
                    .with_proxy_url(effective_proxy)
                    .with_token(cc_token.clone()),
                );
                // Re-check under the lock in case a concurrent send for the
                // same thread created one first; if so, our `p` is dropped and
                // its temp dir cleaned by the Drop impl.
                let mut registry = state.cc_processes.lock().await;
                match registry.get(&req.thread_id) {
                    Some(existing) => existing.clone(),
                    None => {
                        registry.insert(req.thread_id.clone(), p.clone());
                        p
                    }
                }
            }
        };

        // Start the liveness watchdog on the chosen Arc (idempotent). It holds
        // only a Weak<CcProcess>, so it exits cleanly once the registry drops
        // the process (provider switch / model change → recycle_thread_process).
        process.start_watchdog();
        state.chat_runs.lock().await.insert(
            req.thread_id.clone(),
            run::ChatRunHandle::bridge_process("claude-code", process.clone()),
        );

        // 7. Run process with callback to stream
        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        // Refresh volatile per-turn bindings for backend-side tools: cwd for
        // run_captured and DB connection id for SQL/Redis MCP handlers.
        agent_ctx.refresh_runtime_bindings(state.inner()).await;

        // Build the per-turn context prefix CC sees: the live working
        // directory (3.3 — volatile, so injected each turn rather than in the
        // spawn-time identity card) followed by any attached terminal context,
        // mirroring how the native LLM path injects context as a leading user
        // turn. Both are redacted. Without this the CC branch silently dropped
        // fields the frontend already sends.
        let cc_message = {
            let mut prefix = String::new();
            if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let (clean_cwd, _) = redact::redact(cwd);
                prefix.push_str(&format!("当前工作目录：{}\n\n", clean_cwd));
            }
            if let Some(block) = code_workspace_context_block(&agent_ctx) {
                let (clean_block, _) = redact::redact(block.trim_end());
                prefix.push_str(&format!("{clean_block}\n\n"));
            }
            if let Some(line) = selected_objects_context_line(&agent_ctx) {
                let (clean_line, _) = redact::redact(line.trim_end());
                prefix.push_str(&format!("{clean_line}\n\n"));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            prefix.push_str(&render_agent_attachment_prefix(&attachments));
            format!("{}{}", prefix, clean_content)
        };
        let events = process
            .send_with_callback(&cc_message, move |evt| {
                use crate::agent::cc_bridge::protocol::CcEvent;
                match evt {
                    CcEvent::Partial { content } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::Token {
                                id: assistant_id_clone.clone(),
                                content: content.clone(),
                            },
                        );
                    }
                    // 3.5 — emit a structured, display-only card for tool use. It
                    // carries no machine-parseable payload, so the frontend never
                    // re-executes it (confirmation already happened live via the
                    // MCP permission prompt). The compact text record is persisted
                    // separately below, so reload still shows the activity as text.
                    CcEvent::ToolUse { id, name, input } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::CcToolActivity {
                                id: assistant_id_clone.clone(),
                                call_id: id.clone(),
                                phase: "use".into(),
                                tool: name.clone(),
                                detail: cc_tool_arg_summary(input).unwrap_or_default(),
                            },
                        );
                    }
                    CcEvent::ToolResult {
                        tool_use_id,
                        content,
                    } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::CcToolActivity {
                                id: assistant_id_clone.clone(),
                                call_id: tool_use_id.clone(),
                                phase: "result".into(),
                                tool: String::new(),
                                detail: cc_tool_result_preview(content),
                            },
                        );
                    }
                    CcEvent::Done { usage: Some(u) } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::Usage {
                                id: assistant_id_clone.clone(),
                                input_tokens: u.input_tokens,
                                output_tokens: u.output_tokens,
                                cost_usd: u.total_cost_usd,
                                duration_ms: u.duration_ms,
                            },
                        );
                    }
                    _ => {}
                }
            })
            .await;
        state.chat_runs.lock().await.remove(&req.thread_id);

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                let msg = if process.is_stopped() {
                    "Stream stopped by user".to_string()
                } else {
                    e
                };
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: msg,
                });
                return Ok(());
            }
        };

        // 8. Extract final answer and persist. The persisted content keeps a
        // compact *text* transcript of tool activity (history durability); the
        // live structured cards (above) are ephemeral, so on reload the message
        // still shows what CC did, as text.
        let mut final_content = String::new();
        for event in &events {
            use crate::agent::cc_bridge::protocol::CcEvent;
            match event {
                CcEvent::AssistantMessage { content } => {
                    final_content.push_str(content);
                }
                CcEvent::ToolUse { name, input, .. } => {
                    final_content.push_str(&format_cc_tool_use(name, input));
                }
                CcEvent::ToolResult { content, .. } => {
                    let preview = cc_tool_result_preview(content);
                    if !preview.is_empty() {
                        final_content.push_str(&format!("> ↳ {}\n", preview));
                    }
                }
                _ => {}
            }
        }

        let session_id =
            crate::agent::cc_bridge::protocol::extract_session_id(&events).or(resume_session);
        if let Some(sid) = &session_id {
            if let Ok(db) = state.db.lock() {
                let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
            }
        }

        let assistant_msg = store::ChatMessage {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            role: "assistant".into(),
            content: final_content.clone(),
            created_at: assistant_ts,
            redacted: false,
            attachments: Vec::new(),
        };

        let is_first = history.is_empty();
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
            if is_first {
                let title = user_msg.content.chars().take(40).collect::<String>();
                store::update_thread_title(&db, &req.thread_id, &title)
                    .map_err(|e| e.to_string())?;
            }
        }

        emit(&StreamEventOut::End {
            id: assistant_id,
            thread_id: req.thread_id,
            content: final_content,
            redacted_count,
        });

        return Ok(());
    }

    if thread.provider_id == "codex" {
        let assistant_id = Uuid::new_v4().to_string();
        let assistant_ts = now() + 1;
        emit(&StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        });

        let ai_config = AiConfig::load(&default_ai_config_path());
        if !ai_config.codex_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode
        {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: "Codex is unavailable in full-local / fully-disabled mode or is disabled."
                    .into(),
            });
            return Ok(());
        }

        let binary = if ai_config.codex_bridge.binary == "auto" {
            crate::agent::codex_bridge::find_codex_binary().ok_or("Codex CLI not found")?
        } else {
            ai_config.codex_bridge.binary.clone()
        };
        let resume_session = thread.cc_session_id.clone();
        let runtime = match crate::agent::codex_bridge::config::resolve_custom_runtime(
            &ai_config.codex_bridge,
            &state.vault,
        ) {
            Ok(c) => c,
            Err(e) => {
                emit(&StreamEventOut::Error {
                    id: assistant_id.clone(),
                    message: e,
                });
                return Ok(());
            }
        };

        let existing = {
            state
                .codex_processes
                .lock()
                .await
                .get(&req.thread_id)
                .cloned()
        };
        let process = match existing {
            Some(p) => p,
            None => {
                let flavor = agent_ctx.flavor;

                let (server_url, token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread_with_inline_permission(
                        &app,
                        &req.thread_id,
                        agent_ctx.linked_session_id.clone(),
                        agent_ctx.bound_session_id.clone(),
                        flavor,
                        ai_config.codex_bridge.confirm_readonly,
                        true,
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                };
                let control_server_url =
                    match crate::agent::cc_bridge::mcp_http::control_server_url() {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };

                let thread_config =
                    crate::agent::codex_bridge::config::build_thread_config_from_config(
                        runtime.config.clone(),
                        flavor.server_name(),
                        &server_url,
                        &token,
                        &control_server_url,
                    );

                let output_format = resolve_output_format(&thread, &ai_config);
                let base_instructions = format!(
                    "{}\n\nYou are connected through Codex app-server inside Taomni. Use the domain Taomni MCP tools only for the bound terminal/database session described in the developer instructions. The separate taomni_control MCP server is the UI/session/tab control plane: when the user asks to open or switch to a saved Taomni session, open the session editor, or manage tabs, call taomni_control tools instead of telling the user to do it manually.",
                    build_system_prompt(&output_format)
                );
                let developer_instructions = agent_ctx.session_card.clone();

                let temp_dir =
                    std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
                if let Err(e) = std::fs::create_dir_all(&temp_dir) {
                    crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                    emit(&StreamEventOut::Error {
                        id: assistant_id.clone(),
                        message: format!("Failed to create Codex temp dir: {e}"),
                    });
                    return Ok(());
                }

                let model = thread
                    .cc_model
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .or_else(|| {
                        if runtime.config.contains_key("model") {
                            None
                        } else {
                            Some(ai_config.codex_bridge.default_model.clone())
                        }
                    });
                let effective_proxy =
                    match crate::agent::codex_bridge::config::resolve_effective_proxy_url(
                        state.inner(),
                        &ai_config.codex_bridge,
                    ) {
                        Ok(proxy) => proxy,
                        Err(e) => {
                            crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                            let _ = std::fs::remove_dir_all(&temp_dir);
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                let p = match crate::agent::codex_bridge::process::CodexAppServer::spawn(
                    &binary,
                    effective_proxy,
                    Some(temp_dir.clone()),
                    Some(token.clone()),
                    Some(runtime.env.clone()),
                    runtime.isolated_home,
                )
                .await
                {
                    Ok(p) => std::sync::Arc::new(p),
                    Err(e) => {
                        crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                        let _ = std::fs::remove_dir_all(&temp_dir);
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };

                if let Err(e) = p
                    .start_or_resume_thread(
                        crate::agent::codex_bridge::process::CodexThreadOptions {
                            resume_thread_id: resume_session.clone(),
                            model,
                            cwd: req.cwd.clone(),
                            approval_policy: ai_config.codex_bridge.approval_policy.clone(),
                            sandbox: ai_config.codex_bridge.sandbox.clone(),
                            network_access: ai_config.codex_bridge.network_access,
                            config: thread_config,
                            base_instructions: Some(base_instructions),
                            developer_instructions: Some(developer_instructions),
                            ephemeral: false,
                        },
                    )
                    .await
                {
                    emit(&StreamEventOut::Error {
                        id: assistant_id.clone(),
                        message: e,
                    });
                    p.stop().await;
                    return Ok(());
                }

                let mut registry = state.codex_processes.lock().await;
                match registry.get(&req.thread_id) {
                    Some(existing) => existing.clone(),
                    None => {
                        registry.insert(req.thread_id.clone(), p.clone());
                        p
                    }
                }
            }
        };

        agent_ctx.refresh_runtime_bindings(state.inner()).await;

        let codex_message = {
            let mut prefix = String::new();
            if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let (clean_cwd, _) = redact::redact(cwd);
                prefix.push_str(&format!("当前工作目录：{}\n\n", clean_cwd));
            }
            if let Some(block) = code_workspace_context_block(&agent_ctx) {
                let (clean_block, _) = redact::redact(block.trim_end());
                prefix.push_str(&format!("{clean_block}\n\n"));
            }
            if let Some(line) = selected_objects_context_line(&agent_ctx) {
                let (clean_line, _) = redact::redact(line.trim_end());
                prefix.push_str(&format!("{clean_line}\n\n"));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            prefix.push_str(&render_agent_attachment_prefix(&attachments));
            format!("{}{}", prefix, clean_content)
        };

        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        let model = thread
            .cc_model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| {
                if runtime.config.contains_key("model") {
                    None
                } else {
                    Some(ai_config.codex_bridge.default_model.clone())
                }
            });
        let events = process
            .send_turn_with_callback(
                &codex_message,
                crate::agent::codex_bridge::process::CodexTurnOptions {
                    cwd: req.cwd.clone(),
                    approval_policy: ai_config.codex_bridge.approval_policy.clone(),
                    sandbox: ai_config.codex_bridge.sandbox.clone(),
                    network_access: ai_config.codex_bridge.network_access,
                    model,
                },
                move |evt| {
                    use crate::agent::codex_bridge::protocol::CodexEvent;
                    match evt {
                        CodexEvent::Partial { content } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::Token {
                                    id: assistant_id_clone.clone(),
                                    content: content.clone(),
                                },
                            );
                        }
                        CodexEvent::ToolUse { id, name, input } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::CcToolActivity {
                                    id: assistant_id_clone.clone(),
                                    call_id: id.clone(),
                                    phase: "use".into(),
                                    tool: name.clone(),
                                    detail: cc_tool_arg_summary(input).unwrap_or_default(),
                                },
                            );
                        }
                        CodexEvent::ToolResult {
                            tool_use_id,
                            content,
                        } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::CcToolActivity {
                                    id: assistant_id_clone.clone(),
                                    call_id: tool_use_id.clone(),
                                    phase: "result".into(),
                                    tool: String::new(),
                                    detail: cc_tool_result_preview(content),
                                },
                            );
                        }
                        CodexEvent::Done { usage: Some(u) } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::Usage {
                                    id: assistant_id_clone.clone(),
                                    input_tokens: u.input_tokens,
                                    output_tokens: u.output_tokens,
                                    cost_usd: None,
                                    duration_ms: u.duration_ms,
                                },
                            );
                        }
                        _ => {}
                    }
                },
            )
            .await;

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                let msg = if process.is_stopped() {
                    "Stream stopped by user".to_string()
                } else {
                    e
                };
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: msg,
                });
                return Ok(());
            }
        };

        let mut final_content = String::new();
        for event in &events {
            use crate::agent::codex_bridge::protocol::CodexEvent;
            match event {
                CodexEvent::AssistantMessage { content } => {
                    final_content.push_str(content);
                }
                CodexEvent::ToolUse { name, input, .. } => {
                    final_content.push_str(&format_cc_tool_use(name, input));
                }
                CodexEvent::ToolResult { content, .. } => {
                    let preview = cc_tool_result_preview(content);
                    if !preview.is_empty() {
                        final_content.push_str(&format!("> ↳ {}\n", preview));
                    }
                }
                _ => {}
            }
        }

        let session_id = crate::agent::codex_bridge::protocol::extract_session_id(&events)
            .or_else(|| process.current_thread_id())
            .or(resume_session);
        if let Some(sid) = &session_id {
            if let Ok(db) = state.db.lock() {
                let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
            }
        }

        let assistant_msg = store::ChatMessage {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            role: "assistant".into(),
            content: final_content.clone(),
            created_at: assistant_ts,
            redacted: false,
            attachments: Vec::new(),
        };

        let is_first = history.is_empty();
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
            if is_first {
                let title = user_msg.content.chars().take(40).collect::<String>();
                store::update_thread_title(&db, &req.thread_id, &title)
                    .map_err(|e| e.to_string())?;
            }
        }

        emit(&StreamEventOut::End {
            id: assistant_id,
            thread_id: req.thread_id,
            content: final_content,
            redacted_count,
        });

        return Ok(());
    }

    // Build the LLM request.
    let ai_config = AiConfig::load(&default_ai_config_path());
    let output_format = resolve_output_format(&thread, &ai_config);
    let system_prompt =
        append_agent_context_to_system_prompt(build_system_prompt(&output_format), &agent_ctx);
    let mut llm_messages: Vec<LlmMessage> = vec![LlmMessage::system(system_prompt)];
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!(
            "[Terminal context]\n```\n{}\n```",
            clean_ctx
        )));
        llm_messages.push(LlmMessage::assistant(
            "Acknowledged — I have read the terminal output.",
        ));
    }
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: crate::llm::ChatContent::text(msg.content.clone()),
        });
    }
    if let Some(attachment_message) = build_llm_attachment_message(&attachments)? {
        llm_messages.push(attachment_message);
    }
    llm_messages.push(LlmMessage::user(clean_content));

    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: true,
    };

    // Allocate the assistant message id and begin streaming.
    let assistant_id = Uuid::new_v4().to_string();
    let assistant_ts = now() + 1;
    emit(&StreamEventOut::AssistantStart {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        created_at: assistant_ts,
    });

    // Pull the provider via the router so we don't hold the read lock across
    // the long stream/tool lifetime.
    let provider_result: Result<Arc<dyn Llm>, crate::llm::LlmError> = {
        let ai_ctx = state.ai_ctx.read().await;
        let pinned = ai_ctx.llm.provider(&thread.provider_id);
        let pinned_blocked = pinned.is_none() && ai_ctx.llm.needs_vault_unlock(&thread.provider_id);

        let provider = pinned.or_else(|| {
            // Don't fall back when the pinned provider is just locked — the
            // user wants that specific provider, and we should prompt for
            // unlock rather than silently rerouting.
            if pinned_blocked {
                None
            } else {
                ai_ctx
                    .llm
                    .provider(&ai_ctx.llm.provider_for_task(TaskKind::ChatDrawer))
            }
        });
        match provider {
            Some(p) => Ok(p),
            None => {
                if pinned_blocked {
                    Err(crate::llm::LlmError::VaultLocked {
                        provider: thread.provider_id.clone(),
                    })
                } else if let Some(group_id) = provider_group_id_from_route(&thread.provider_id) {
                    Err(crate::llm::LlmError::Provider {
                        status: 0,
                        message: format!(
                            "Provider group '{group_id}' has no available chat providers."
                        ),
                    })
                } else {
                    Err(crate::llm::LlmError::Provider {
                        status: 0,
                        message: "No provider available".into(),
                    })
                }
            }
        }
    };

    let provider = match provider_result {
        Ok(provider) => provider,
        Err(e) => {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: e.to_string(),
            });
            return Ok(());
        }
    };

    // Create a provider-agnostic cancellation handle for this in-flight turn.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    state.chat_runs.lock().await.insert(
        req.thread_id.clone(),
        run::ChatRunHandle::direct_llm(cancel_token.clone()),
    );

    let mut accumulated = String::new();
    let mut is_cancelled = false;

    let mut ran_with_tools = false;
    if provider.supports_tools() {
        agent_ctx.refresh_runtime_bindings(state.inner()).await;

        let runtime_result = tokio::select! {
            _ = cancel_token.cancelled() => {
                is_cancelled = true;
                None
            }
            result = crate::agent::tool_runtime::AgentToolRuntime::provision(
                &app,
                &agent_ctx,
                ai_config.cc_bridge.confirm_readonly,
            ) => Some(result),
        };

        if let Some(runtime_result) = runtime_result {
            let runtime = match runtime_result {
                Ok(runtime) => runtime,
                Err(e) => {
                    emit(&StreamEventOut::Error {
                        id: assistant_id,
                        message: e,
                    });
                    state.chat_runs.lock().await.remove(&req.thread_id);
                    return Ok(());
                }
            };

            let mcp_tools = tokio::select! {
                _ = cancel_token.cancelled() => {
                    is_cancelled = true;
                    None
                }
                result = runtime.list_tools() => Some(result),
            };

            if let Some(mcp_tools) = mcp_tools {
                let llm_tools = match mcp_tools {
                    Ok(tools) => llm_tools_from_mcp(tools),
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id,
                            message: e,
                        });
                        state.chat_runs.lock().await.remove(&req.thread_id);
                        return Ok(());
                    }
                };

                if !llm_tools.is_empty() {
                    ran_with_tools = true;
                    let mut messages = llm_req.messages.clone();
                    let mut completed = false;

                    // No hard tool-round cap: keep calling tools until the model
                    // returns a final answer (empty tool_calls) or the user cancels.
                    'tool_rounds: loop {
                        let turn_req = ChatRequest {
                            messages: messages.clone(),
                            max_tokens: llm_req.max_tokens,
                            temperature: llm_req.temperature,
                            stream: false,
                        };
                        let resp = tokio::select! {
                            _ = cancel_token.cancelled() => {
                                is_cancelled = true;
                                break 'tool_rounds;
                            }
                            result = provider.chat_with_tools(turn_req, llm_tools.clone()) => result,
                        };
                        let resp = match resp {
                            Ok(resp) => resp,
                            Err(e) => {
                                emit(&StreamEventOut::Error {
                                    id: assistant_id,
                                    message: e.to_string(),
                                });
                                state.chat_runs.lock().await.remove(&req.thread_id);
                                return Ok(());
                            }
                        };

                        if !resp.content.is_empty() {
                            accumulated.push_str(&resp.content);
                            emit(&StreamEventOut::Token {
                                id: assistant_id.clone(),
                                content: resp.content.clone(),
                            });
                        }

                        if resp.tool_calls.is_empty() {
                            completed = true;
                            break;
                        }

                        messages.push(assistant_tool_message(&resp.content, &resp.tool_calls));
                        for call in resp.tool_calls {
                            accumulated.push_str(&format_cc_tool_use(&call.name, &call.arguments));
                            emit(&StreamEventOut::CcToolActivity {
                                id: assistant_id.clone(),
                                call_id: call.id.clone(),
                                phase: "use".into(),
                                tool: call.name.clone(),
                                detail: cc_tool_arg_summary(&call.arguments).unwrap_or_default(),
                            });

                            let tool_result = tokio::select! {
                                _ = cancel_token.cancelled() => {
                                    is_cancelled = true;
                                    break 'tool_rounds;
                                }
                                result = runtime.call_tool(&call.name, call.arguments.clone()) => result,
                            };

                            let (tool_text, is_error) = match tool_result {
                                Ok(result) => (
                                    crate::agent::tool_runtime::call_tool_result_text(&result),
                                    false,
                                ),
                                Err(e) => (format!("Tool error: {e}"), true),
                            };
                            let preview = cc_tool_result_preview(&tool_text);
                            emit(&StreamEventOut::CcToolActivity {
                                id: assistant_id.clone(),
                                call_id: call.id.clone(),
                                phase: "result".into(),
                                tool: String::new(),
                                detail: preview.clone(),
                            });
                            if !preview.is_empty() {
                                accumulated.push_str(&format!("> ↳ {}\n", preview));
                            }

                            if is_error {
                                messages.push(LlmMessage::tool_error(call.id, tool_text));
                            } else {
                                messages.push(LlmMessage::tool_result(call.id, tool_text));
                            }
                        }
                    }

                    if !completed && !is_cancelled {
                        emit(&StreamEventOut::Error {
                            id: assistant_id,
                            message: "Tool loop ended before the provider returned a final answer"
                                .into(),
                        });
                        state.chat_runs.lock().await.remove(&req.thread_id);
                        return Ok(());
                    }
                }
            }
        }
    }

    if !ran_with_tools && !is_cancelled {
        let stream_result = tokio::select! {
            _ = cancel_token.cancelled() => {
                is_cancelled = true;
                None
            }
            result = provider.chat_stream(llm_req) => Some(result),
        };

        if let Some(stream_result) = stream_result {
            let mut stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    emit(&StreamEventOut::Error {
                        id: assistant_id,
                        message: e.to_string(),
                    });
                    state.chat_runs.lock().await.remove(&req.thread_id);
                    return Ok(());
                }
            };

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        is_cancelled = true;
                        break;
                    }
                    evt_opt = stream.next() => {
                        match evt_opt {
                            Some(evt) => {
                                match evt {
                                    Ok(ChatStreamEvent::Token { content }) => {
                                        accumulated.push_str(&content);
                                        emit(&StreamEventOut::Token {
                                            id: assistant_id.clone(),
                                            content,
                                        });
                                    }
                                    Ok(ChatStreamEvent::End { .. }) => break,
                                    Ok(ChatStreamEvent::Error { message }) => {
                                        emit(&StreamEventOut::Error {
                                            id: assistant_id,
                                            message,
                                        });
                                        state.chat_runs.lock().await.remove(&req.thread_id);
                                        return Ok(());
                                    }
                                    Err(e) => {
                                        emit(&StreamEventOut::Error {
                                            id: assistant_id,
                                            message: e.to_string(),
                                        });
                                        state.chat_runs.lock().await.remove(&req.thread_id);
                                        return Ok(());
                                    }
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
        }
    }

    state.chat_runs.lock().await.remove(&req.thread_id);

    if is_cancelled {
        emit(&StreamEventOut::Error {
            id: assistant_id,
            message: "Stream stopped by user".into(),
        });
        return Ok(());
    }

    // Persist the assistant message and auto-title on first turn.
    let assistant_msg = store::ChatMessage {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: accumulated.clone(),
        created_at: assistant_ts,
        redacted: false,
        attachments: Vec::new(),
    };

    let is_first = history.is_empty();
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if is_first {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    emit(&StreamEventOut::End {
        id: assistant_id,
        thread_id: req.thread_id,
        content: accumulated,
        redacted_count,
    });

    Ok(())
}

#[cfg(test)]
mod cc_tool_use_tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn renders_command_without_tool_call_marker() {
        let line = format_cc_tool_use("run_in_terminal", &json!({ "command": "ls -la" }));
        assert!(line.contains("run_in_terminal"));
        assert!(line.contains("ls -la"));
        // Must NOT be a parseable marker (would trigger native re-execution).
        assert!(!line.contains("[TOOL_CALL]"));
    }

    #[test]
    fn renders_file_path_and_bare_tool() {
        let edit = format_cc_tool_use("Edit", &json!({ "file_path": "/tmp/x.rs" }));
        assert!(edit.contains("/tmp/x.rs"));
        assert!(!edit.contains("[TOOL_CALL]"));
        let bare = format_cc_tool_use("list_sessions", &json!({}));
        assert!(bare.contains("list_sessions"));
        assert!(!bare.contains("[TOOL_CALL]"));
    }

    #[test]
    fn summarizes_query_and_nested_tool_args() {
        let search =
            format_cc_tool_use("search_tool", &json!({ "query": "welcome recent folders" }));
        assert!(search.contains("search_tool"));
        assert!(search.contains("welcome recent folders"));

        let nested = format_cc_tool_use(
            "use_tool",
            &json!({
                "tool_name": "web_search",
                "arguments": { "query": "taomni acp" },
            }),
        );
        assert!(nested.contains("web_search"));
        assert!(nested.contains("taomni acp"));

        // Secrets must never appear in the transcript summary.
        let secret = format_cc_tool_use(
            "auth",
            &json!({ "token": "super-secret", "path": "/tmp/ok" }),
        );
        assert!(secret.contains("/tmp/ok"));
        assert!(!secret.contains("super-secret"));
    }

    #[test]
    fn cloud_attachment_message_omits_local_path_but_includes_text_preview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "hello from attachment").unwrap();
        let att = stat_attachment_path(path.to_str().unwrap(), None).unwrap();

        let message = build_llm_attachment_message(&[att.clone()])
            .unwrap()
            .unwrap();
        let text = message.content.as_text_lossy();

        assert!(text.contains("notes.txt"));
        assert!(text.contains("hello from attachment"));
        assert!(!text.contains(&att.path));
    }

    #[test]
    fn agent_attachment_prefix_includes_readable_path() {
        let att = store::ChatAttachment {
            id: "a1".into(),
            kind: "file".into(),
            path: "/tmp/notes.txt".into(),
            name: "notes.txt".into(),
            size: 12,
            mime: Some("text/plain".into()),
            preview_url: None,
        };

        let prefix = render_agent_attachment_prefix(&[att]);

        assert!(prefix.contains("notes.txt"));
        assert!(prefix.contains("path: /tmp/notes.txt"));
    }

    #[test]
    fn validates_attachment_count_and_total_size() {
        let oversized = store::ChatAttachment {
            id: "a1".into(),
            kind: "file".into(),
            path: "/tmp/large.bin".into(),
            name: "large.bin".into(),
            size: CHAT_MAX_ATTACHMENT_BYTES + 1,
            mime: Some("application/octet-stream".into()),
            preview_url: None,
        };
        assert!(validate_attachment_limits(&[oversized]).is_err());

        let many: Vec<_> = (0..=CHAT_MAX_ATTACHMENTS)
            .map(|i| store::ChatAttachment {
                id: format!("a{i}"),
                kind: "file".into(),
                path: format!("/tmp/{i}.txt"),
                name: format!("{i}.txt"),
                size: 1,
                mime: Some("text/plain".into()),
                preview_url: None,
            })
            .collect();
        assert!(validate_attachment_limits(&many).is_err());
    }

    #[test]
    fn image_attachment_message_contains_multimodal_part() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pixel.png");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&[137, 80, 78, 71]).unwrap();
        let att = stat_attachment_path(path.to_str().unwrap(), None).unwrap();

        let message = build_llm_attachment_message(&[att]).unwrap().unwrap();
        match message.content {
            crate::llm::ChatContent::Parts(parts) => {
                assert!(parts.iter().any(|part| matches!(
                    part,
                    ChatContentPart::Image {
                        mime_type,
                        data_base64
                    } if mime_type == "image/png" && !data_base64.is_empty()
                )));
            }
            _ => panic!("expected multimodal content parts"),
        }
    }

    #[test]
    fn clipboard_rgba_image_becomes_pasted_image_attachment() {
        let rgba = [255_u8, 0, 0, 255];
        let att = clipboard_image_attachment_from_rgba(1, 1, &rgba).unwrap();

        assert_eq!(att.kind, "image");
        assert_eq!(att.name, "Pasted image");
        assert_eq!(att.mime.as_deref(), Some("image/png"));
        assert!(att.path.ends_with(".png"));
        assert!(std::path::Path::new(&att.path).exists());

        let _ = std::fs::remove_file(&att.path);
    }

    #[test]
    fn decodes_base64_image_data_uri() {
        let data = "data:image/png;base64,iVBORw0KGgo=";
        let (bytes, mime) = decode_base64_image(data).unwrap();

        assert_eq!(mime, "image/png");
        assert_eq!(bytes, vec![137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[test]
    fn validates_video_num_frames_rule() {
        assert_eq!(validate_video_num_frames(121).unwrap(), 121);
        assert!(validate_video_num_frames(120).is_err());
        assert!(validate_video_num_frames(442).is_err());
    }
}
