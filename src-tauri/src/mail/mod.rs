//! Generic IMAP/SMTP mail backend.
//!
//! IMAP operations reuse a per-account live session (and its session-level
//! proxy forwarder) for a short idle TTL. SMTP remains short-lived. Network
//! routing uses only the mail session's `networkSettings` — never the app
//! global proxy.
//!
//! Session proxy forwarding uses an explicit `tokio::runtime::Handle` with
//! `Handle::block_on` from `spawn_blocking` workers (no long-lived
//! `handle.enter()`). OAuth token HTTP uses `reqwest::blocking` and is isolated
//! onto a plain OS thread when a Tokio runtime is already current, to avoid
//! nested-runtime drop panics in debug builds.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
};
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use mail_parser::{Address as ParsedAddress, MessageParser, MimeHeaders, PartType};
use native_tls::TlsConnector;
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;
use tokio::task::JoinHandle;

use crate::state::AppState;
use crate::terminal::network::NetworkSettings;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MESSAGE_LIMIT: usize = 200;
const DEFAULT_BODY_MAX_BYTES: usize = 256 * 1024;
/// Cap for HTML bodies after embedding inline CID images as data URLs for display.
const MAX_EMBEDDED_BODY_BYTES: usize = 5 * 1024 * 1024;
/// Skip individual CID parts larger than this when rewriting for display.
const MAX_INLINE_CID_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const OAUTH_REFRESH_SKEW_SECS: i64 = 300;
const OAUTH_REAUTHORIZE_REQUIRED: &str = "OAuth2 authorization expired or was revoked. Reauthorize this mail account in session settings.";
const IMAP_LOGIN_RETRY_DELAYS_MS: [u64; 2] = [500, 1500];
/// How long an idle live IMAP session (and its proxy forwarder) is kept.
const IMAP_LIVE_IDLE_TTL: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailConnectionSecurity {
    #[serde(rename = "tls", alias = "TLS", alias = "Tls")]
    Tls,
    #[serde(rename = "starttls", alias = "STARTTLS", alias = "StartTls")]
    Starttls,
    #[serde(rename = "none", alias = "None", alias = "NONE")]
    None,
}

impl Default for MailConnectionSecurity {
    fn default() -> Self {
        Self::Tls
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailProvider {
    #[serde(rename = "custom", alias = "Custom")]
    Custom,
    #[serde(rename = "gmail", alias = "Gmail")]
    Gmail,
    #[serde(rename = "outlook", alias = "Outlook", alias = "outlook.com")]
    Outlook,
}

impl Default for MailProvider {
    fn default() -> Self {
        Self::Custom
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailAuthMode {
    #[serde(rename = "password", alias = "Password")]
    Password,
    #[serde(rename = "oauth2", alias = "OAuth2", alias = "oauth")]
    OAuth2,
}

impl Default for MailAuthMode {
    fn default() -> Self {
        Self::Password
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub security: MailConnectionSecurity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSmtpConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub security: MailConnectionSecurity,
    #[serde(default = "default_true")]
    pub use_imap_auth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthSettings {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub token_ref: Option<String>,
    #[serde(default)]
    pub refresh_token_ref: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailOAuthTokenBundle {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthDeviceCodeResponse {
    #[serde(default)]
    device_code: String,
    #[serde(default)]
    user_code: String,
    #[serde(default, alias = "verification_url")]
    verification_uri: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    interval: Option<i64>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthAuthorizeRequest {
    pub session_id: String,
    pub provider: MailProvider,
    pub email_address: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceStartRequest {
    pub provider: MailProvider,
    pub client_id: String,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceStartResult {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub message: String,
    pub expires_in: i64,
    pub interval: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceCompleteRequest {
    pub session_id: String,
    pub provider: MailProvider,
    pub email_address: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub device_code: String,
    #[serde(default)]
    pub interval: Option<i64>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthAuthorizeResult {
    pub token_ref: String,
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
    pub token_type: Option<String>,
}

struct OAuthCallback {
    code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCacheSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_header_retention_days")]
    pub header_retention_days: u32,
    #[serde(default = "default_header_limit_per_folder")]
    pub header_limit_per_folder: u32,
    #[serde(default = "default_body_recent_limit")]
    pub body_recent_limit: u32,
    #[serde(default = "default_body_max_bytes")]
    pub body_max_bytes: u32,
    #[serde(default)]
    pub attachment_cache: bool,
    #[serde(default)]
    pub save_directory: Option<String>,
}

impl Default for MailCacheSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            header_retention_days: default_header_retention_days(),
            header_limit_per_folder: default_header_limit_per_folder(),
            body_recent_limit: default_body_recent_limit(),
            body_max_bytes: default_body_max_bytes(),
            attachment_cache: false,
            save_directory: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAiSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub skip_body_confirm: bool,
}

impl Default for MailAiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            skip_body_confirm: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSyncSettings {
    #[serde(default = "default_true")]
    pub on_open: bool,
    #[serde(default = "default_sync_interval_minutes")]
    pub interval_minutes: u32,
    #[serde(default = "default_max_fetch_per_sync")]
    pub max_fetch_per_sync: u32,
}

impl Default for MailSyncSettings {
    fn default() -> Self {
        Self {
            on_open: true,
            interval_minutes: default_sync_interval_minutes(),
            max_fetch_per_sync: default_max_fetch_per_sync(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccountConfig {
    pub session_id: String,
    pub email_address: String,
    #[serde(default)]
    pub provider: MailProvider,
    #[serde(default)]
    pub auth_mode: MailAuthMode,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    pub imap: MailServerConfig,
    pub smtp: MailSmtpConfig,
    #[serde(default)]
    pub oauth: MailOAuthSettings,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
    #[serde(default)]
    pub sync: MailSyncSettings,
    #[serde(default)]
    pub cache: MailCacheSettings,
    #[serde(default)]
    pub ai: MailAiSettings,
}

#[derive(Debug, Clone)]
struct ResolvedMailAccount {
    config: MailAccountConfig,
    auth_mode: MailAuthMode,
    network_settings: Option<NetworkSettings>,
    imap_username: String,
    imap_password: String,
    smtp_username: String,
    smtp_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachmentInfo {
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolder {
    pub account_id: String,
    pub name: String,
    pub display_name: String,
    pub delimiter: Option<String>,
    pub flags: Vec<String>,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub total: Option<u32>,
    pub unread: Option<u32>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageHeader {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub from: Option<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub date_ts: Option<i64>,
    pub flags: Vec<String>,
    pub has_attachments: bool,
    pub attachment_count: usize,
    pub attachments: Vec<MailAttachmentInfo>,
    pub snippet: Option<String>,
    pub raw_size: Option<u32>,
    pub body_cached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageBody {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub snippet: Option<String>,
    pub attachments: Vec<MailAttachmentInfo>,
    pub raw_size: Option<u32>,
    pub cached_at: Option<i64>,
    pub source: String,
}

#[derive(Debug, Clone)]
struct MailMessageCached {
    header: MailMessageHeader,
    body_text: Option<String>,
    body_html: Option<String>,
    body_cached_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default)]
struct FolderSyncState {
    max_uid: u32,
    uid_validity: Option<u32>,
}

#[derive(Debug)]
struct DownloadedMailAttachment {
    name: Option<String>,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSyncResult {
    pub account_id: String,
    pub folder: String,
    pub folders: Vec<MailFolder>,
    pub messages: Vec<MailMessageHeader>,
    pub fetched_messages: usize,
    pub cached_bodies: usize,
    pub synced_at: i64,
    pub offset: u32,
    pub limit: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSyncAllResult {
    pub account_id: String,
    pub folders: Vec<MailFolder>,
    pub fetched_messages: usize,
    pub new_messages: usize,
    pub cached_bodies: usize,
    pub synced_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMarkReadResult {
    pub folder: String,
    pub marked: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailTestConnectionResult {
    pub imap_ok: bool,
    pub smtp_ok: bool,
    pub folder_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendRequest {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    #[serde(default)]
    pub text_body: Option<String>,
    #[serde(default)]
    pub html_body: Option<String>,
    #[serde(default)]
    pub attachments: Vec<MailSendAttachment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSendResult {
    pub accepted: bool,
    pub response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftAttachment {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub inline: bool,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftContext {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub uid: Option<u32>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraft {
    pub id: String,
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: String,
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub text_body: String,
    #[serde(default)]
    pub html_body: String,
    #[serde(default)]
    pub attachments: Vec<MailDraftAttachment>,
    #[serde(default)]
    pub reply_context: Option<MailDraftContext>,
    #[serde(default)]
    pub remote_draft_folder: Option<String>,
    #[serde(default)]
    pub remote_draft_uid: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailContactSuggestion {
    pub name: Option<String>,
    pub email: String,
    pub source: String,
    pub score: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDownloadAttachmentResult {
    pub path: String,
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFlagResult {
    pub folder: String,
    pub updated: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMoveResult {
    pub folder: String,
    pub target: String,
    pub count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDeleteResult {
    pub folder: String,
    pub deleted: usize,
}

enum ActiveImapSession {
    Tls {
        session: imap::Session<native_tls::TlsStream<TcpStream>>,
        forward_task: Option<JoinHandle<()>>,
    },
    Plain {
        session: imap::Session<TcpStream>,
        forward_task: Option<JoinHandle<()>>,
    },
}

impl ActiveImapSession {
    fn list_folders(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        match self {
            Self::Tls { session, .. } => imap_list_folders(session, account_id),
            Self::Plain { session, .. } => imap_list_folders(session, account_id),
        }
    }

    fn sync_folder(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        offset: u32,
        limit: u32,
        include_bodies: bool,
    ) -> Result<(MailFolder, Vec<MailMessageCached>, bool), String> {
        match self {
            Self::Tls { session, .. } => {
                imap_sync_folder(session, account, folder, offset, limit, include_bodies)
            }
            Self::Plain { session, .. } => {
                imap_sync_folder(session, account, folder, offset, limit, include_bodies)
            }
        }
    }

    fn sync_folder_incremental(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        state: FolderSyncState,
        limit: u32,
        include_bodies: bool,
    ) -> Result<(MailFolder, Vec<MailMessageCached>), String> {
        match self {
            Self::Tls { session, .. } => {
                imap_sync_folder_incremental(session, account, folder, state, limit, include_bodies)
            }
            Self::Plain { session, .. } => {
                imap_sync_folder_incremental(session, account, folder, state, limit, include_bodies)
            }
        }
    }

    fn fetch_body(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        uid: u32,
    ) -> Result<MailMessageCached, String> {
        match self {
            Self::Tls { session, .. } => imap_fetch_body(session, account, folder, uid),
            Self::Plain { session, .. } => imap_fetch_body(session, account, folder, uid),
        }
    }

    fn mark_read(&mut self, folder: &str, uids: &[u32]) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_mark_read(session, folder, uids),
            Self::Plain { session, .. } => imap_mark_read(session, folder, uids),
        }
    }

    fn download_attachment(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        uid: u32,
        attachment_index: usize,
        target_path: &str,
    ) -> Result<MailDownloadAttachmentResult, String> {
        match self {
            Self::Tls { session, .. } => imap_download_attachment(
                session,
                account,
                folder,
                uid,
                attachment_index,
                target_path,
            ),
            Self::Plain { session, .. } => imap_download_attachment(
                session,
                account,
                folder,
                uid,
                attachment_index,
                target_path,
            ),
        }
    }

    fn set_flags(
        &mut self,
        folder: &str,
        uids: &[u32],
        add: &[String],
        remove: &[String],
    ) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_set_flags(session, folder, uids, add, remove),
            Self::Plain { session, .. } => imap_set_flags(session, folder, uids, add, remove),
        }
    }

    fn move_messages(&mut self, folder: &str, uids: &[u32], target: &str) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_move_messages(session, folder, uids, target),
            Self::Plain { session, .. } => imap_move_messages(session, folder, uids, target),
        }
    }

    fn copy_messages(&mut self, folder: &str, uids: &[u32], target: &str) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_copy_messages(session, folder, uids, target),
            Self::Plain { session, .. } => imap_copy_messages(session, folder, uids, target),
        }
    }

    fn delete_messages(&mut self, folder: &str, uids: &[u32], all: bool) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_delete_messages(session, folder, uids, all),
            Self::Plain { session, .. } => imap_delete_messages(session, folder, uids, all),
        }
    }

    fn fetch_raw(&mut self, folder: &str, uid: u32) -> Result<Vec<u8>, String> {
        match self {
            Self::Tls { session, .. } => imap_fetch_raw(session, folder, uid),
            Self::Plain { session, .. } => imap_fetch_raw(session, folder, uid),
        }
    }

    fn create_folder(&mut self, name: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => session
                .create(name)
                .map_err(|e| format!("IMAP CREATE {name} failed: {e}")),
            Self::Plain { session, .. } => session
                .create(name)
                .map_err(|e| format!("IMAP CREATE {name} failed: {e}")),
        }
    }

    fn rename_folder(&mut self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => session
                .rename(from, to)
                .map_err(|e| format!("IMAP RENAME {from} -> {to} failed: {e}")),
            Self::Plain { session, .. } => session
                .rename(from, to)
                .map_err(|e| format!("IMAP RENAME {from} -> {to} failed: {e}")),
        }
    }

    fn delete_folder(&mut self, name: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => session
                .delete(name)
                .map_err(|e| format!("IMAP DELETE {name} failed: {e}")),
            Self::Plain { session, .. } => session
                .delete(name)
                .map_err(|e| format!("IMAP DELETE {name} failed: {e}")),
        }
    }

    fn logout(&mut self) {
        // The imap 2.4 crate uses `assert_eq!` on command tags. A desynced
        // stream (common after proxy half-close or OAuth fingerprint churn)
        // panics instead of returning Err — never let that tear down the
        // Tokio worker.
        let result = catch_unwind(AssertUnwindSafe(|| match self {
            Self::Tls { session, .. } => session.logout(),
            Self::Plain { session, .. } => session.logout(),
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::debug!("mail imap logout failed: {e}"),
            Err(_) => {
                tracing::debug!("mail imap logout panicked (protocol desync); dropping connection")
            }
        }
    }
}

impl Drop for ActiveImapSession {
    fn drop(&mut self) {
        let task = match self {
            Self::Tls { forward_task, .. } | Self::Plain { forward_task, .. } => {
                forward_task.take()
            }
        };
        if let Some(task) = task {
            task.abort();
        }
    }
}

impl ActiveImapSession {
    fn noop(&mut self) -> Result<(), String> {
        match catch_unwind(AssertUnwindSafe(|| match self {
            Self::Tls { session, .. } => session.noop(),
            Self::Plain { session, .. } => session.noop(),
        })) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("IMAP NOOP failed: {e}")),
            Err(_) => Err("IMAP NOOP failed: protocol desync".into()),
        }
    }
}

/// Discard a live session without risking an imap-crate tag assert panic.
fn retire_imap_session(mut session: ActiveImapSession) {
    session.logout();
    // Drop aborts the optional proxy forwarder task.
}

/// Per-account live IMAP session pool. Reuses TCP/TLS/auth and the optional
/// session-level proxy forwarder across mail commands. Does not consult the
/// app global proxy.
pub struct MailImapPool {
    entries: std::sync::Mutex<HashMap<String, LiveImapEntry>>,
    /// Serialize all IMAP work for a given account (pool checkout + op + put).
    /// Prevents dual live connections for the same account racing through a
    /// session proxy and desyncing Outlook's tag stream.
    account_gates: std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<()>>>>,
}

struct LiveImapEntry {
    fingerprint: String,
    session: ActiveImapSession,
    last_used: Instant,
}

#[derive(Debug, Clone, Copy)]
struct ImapSessionOpts {
    /// When true, never reuse a pooled session and do not return the session
    /// to the pool (used by connection tests).
    force_fresh: bool,
    /// When the first attempt fails with a transport-like error, drop the
    /// live session and retry once with a fresh connect.
    retry_on_error: bool,
}

impl Default for ImapSessionOpts {
    fn default() -> Self {
        Self {
            force_fresh: false,
            retry_on_error: true,
        }
    }
}

impl MailImapPool {
    pub fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(HashMap::new()),
            account_gates: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn account_gate(&self, account_id: &str) -> Arc<std::sync::Mutex<()>> {
        let mut gates = self
            .account_gates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        gates
            .entry(account_id.to_string())
            .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
            .clone()
    }

    fn take(&self, account_id: &str, fingerprint: &str) -> Option<ActiveImapSession> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.remove(account_id)?;
        if entry.fingerprint != fingerprint || entry.last_used.elapsed() > IMAP_LIVE_IDLE_TTL {
            // OAuth refresh changes the credential fingerprint. Never call bare
            // imap logout without panic protection — desynced pools panic here.
            retire_imap_session(entry.session);
            return None;
        }
        Some(entry.session)
    }

    fn put(&self, account_id: String, fingerprint: String, session: ActiveImapSession) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(old) = entries.remove(&account_id) {
                retire_imap_session(old.session);
            }
            entries.insert(
                account_id,
                LiveImapEntry {
                    fingerprint,
                    session,
                    last_used: Instant::now(),
                },
            );
        } else {
            retire_imap_session(session);
        }
    }

    fn invalidate(&self, account_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.remove(account_id) {
                retire_imap_session(entry.session);
            }
        }
    }
}

impl Default for MailImapPool {
    fn default() -> Self {
        Self::new()
    }
}

fn mail_imap_fingerprint(account: &ResolvedMailAccount) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account.config.session_id.as_bytes());
    hasher.update(b"|");
    hasher.update(account.config.imap.host.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(account.config.imap.port.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(format!("{:?}", account.config.imap.security).as_bytes());
    hasher.update(b"|");
    hasher.update(account.imap_username.as_bytes());
    hasher.update(b"|");
    hasher.update(format!("{:?}", account.auth_mode).as_bytes());
    hasher.update(b"|");
    hasher.update(account.imap_password.as_bytes());
    hasher.update(b"|");
    hasher.update(network_fingerprint(account.network_settings.as_ref()).as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn network_fingerprint(network: Option<&NetworkSettings>) -> String {
    let Some(net) = network else {
        return "direct".into();
    };
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        net.proxy_kind,
        net.proxy_host,
        net.proxy_port,
        net.proxy_user,
        net.proxy_session_id,
        net.jump_session_id,
        net.jump_host,
        net.jump_port,
        net.jump_user,
    )
}

fn is_imap_transport_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("connection")
        || message.contains("broken pipe")
        || message.contains("reset")
        || message.contains("timed out")
        || message.contains("timeout")
        || message.contains("eof")
        || message.contains("not connected")
        || message.contains("noop failed")
        || message.contains("tls")
        || message.contains("i/o")
        || message.contains("io error")
        || message.contains("protocol desync")
        || message.contains("desync")
}

/// Run an IMAP operation that may panic inside the imap crate (tag asserts)
/// and convert panics into transport errors so the pool can reconnect.
fn imap_catch_result<R>(op: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
    match catch_unwind(AssertUnwindSafe(op)) {
        Ok(result) => result,
        Err(_) => Err("IMAP protocol desync".into()),
    }
}

/// Checkout or connect an IMAP session, run `f`, then return the session to
/// the pool on success (unless `force_fresh`).
///
/// `runtime` is used only when starting a session-level proxy loopback
/// forwarder (`Handle::block_on`). Callers should pass `Handle::current()`
/// from the async side into `spawn_blocking` — do **not** call
/// `handle.enter()` for the whole blocking scope. Entering the runtime for the
/// entire IMAP op makes `reqwest::blocking` (OAuth refresh) panic in debug
/// builds when nested runtimes are dropped.
///
/// Emits lightweight timing diagnostics: whether the live session was reused,
/// checkout/connect ms, op ms, and whether a session-level proxy is in use.
/// Never consults the app global proxy.
fn with_imap_session<R>(
    pool: &MailImapPool,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    opts: ImapSessionOpts,
    mut f: impl FnMut(&mut ActiveImapSession) -> Result<R, String>,
) -> Result<R, String> {
    let account_id = account.config.session_id.clone();
    let fingerprint = mail_imap_fingerprint(account);
    let session_proxy = account.network_settings.is_some();
    let total_start = Instant::now();

    // One live IMAP op (and its proxy forwarder) per account at a time.
    let gate = pool.account_gate(&account_id);
    let _gate = gate
        .lock()
        .map_err(|_| "mail imap account lock poisoned".to_string())?;

    let mut attempt =
        |force_connect: bool| -> Result<(R, ActiveImapSession, bool, u128, u128), String> {
            let checkout_start = Instant::now();
            let mut reused = false;
            let mut session = if force_connect || opts.force_fresh {
                if opts.force_fresh {
                    pool.invalidate(&account_id);
                }
                imap_catch_result(|| connect_imap(account, runtime))?
            } else if let Some(mut session) = pool.take(&account_id, &fingerprint) {
                match session.noop() {
                    Ok(()) => {
                        reused = true;
                        session
                    }
                    Err(e) => {
                        tracing::debug!(
                            account_id = %account_id,
                            "mail imap live session probe failed; reconnecting: {e}"
                        );
                        retire_imap_session(session);
                        imap_catch_result(|| connect_imap(account, runtime))?
                    }
                }
            } else {
                imap_catch_result(|| connect_imap(account, runtime))?
            };
            let checkout_ms = checkout_start.elapsed().as_millis();

            let op_start = Instant::now();
            // `f` may panic on imap tag asserts; convert to Err and drop session.
            let op_result = catch_unwind(AssertUnwindSafe(|| f(&mut session)));
            match op_result {
                Ok(Ok(value)) => {
                    let op_ms = op_start.elapsed().as_millis();
                    Ok((value, session, reused, checkout_ms, op_ms))
                }
                Ok(Err(e)) => {
                    retire_imap_session(session);
                    Err(e)
                }
                Err(_) => {
                    drop(session);
                    Err("IMAP protocol desync".into())
                }
            }
        };

    let finish = |value: R,
                  session: ActiveImapSession,
                  reused: bool,
                  checkout_ms: u128,
                  op_ms: u128|
     -> R {
        if opts.force_fresh {
            retire_imap_session(session);
        } else {
            pool.put(account_id.clone(), fingerprint.clone(), session);
        }
        tracing::info!(
            account_id = %account_id,
            session_proxy,
            reused,
            checkout_ms,
            op_ms,
            total_ms = total_start.elapsed().as_millis(),
            force_fresh = opts.force_fresh,
            "mail imap op"
        );
        value
    };

    match attempt(false) {
        Ok((value, session, reused, checkout_ms, op_ms)) => {
            Ok(finish(value, session, reused, checkout_ms, op_ms))
        }
        Err(e) if opts.retry_on_error && is_imap_transport_error(&e) => {
            tracing::debug!(
                account_id = %account_id,
                "mail imap op failed on live/new session; retrying once: {e}"
            );
            pool.invalidate(&account_id);
            let (value, session, reused, checkout_ms, op_ms) = attempt(true)?;
            Ok(finish(value, session, reused, checkout_ms, op_ms))
        }
        Err(e) => {
            tracing::info!(
                account_id = %account_id,
                session_proxy,
                total_ms = total_start.elapsed().as_millis(),
                error = %e,
                "mail imap op failed"
            );
            Err(e)
        }
    }
}

/// Whether header sync should issue a remote IMAP LIST.
/// Refresh requests always list; otherwise list only when the local folder
/// cache is empty so the UI still gets a usable folder set.
fn should_list_remote_folders(refresh_folders: bool, cached_folder_count: usize) -> bool {
    refresh_folders || cached_folder_count == 0
}

/// Build the folder list returned by header sync: remote LIST (or cache) plus
/// the just-synced selected folder metadata.
fn folders_for_header_sync(
    base_folders: Vec<MailFolder>,
    selected: MailFolder,
) -> Vec<MailFolder> {
    let mut folders = base_folders;
    merge_selected_folder(&mut folders, selected);
    folders
}

struct MailSmtpTransport {
    mailer: SmtpTransport,
    forward_task: Option<JoinHandle<()>>,
}

impl Drop for MailSmtpTransport {
    fn drop(&mut self) {
        if let Some(task) = self.forward_task.take() {
            task.abort();
        }
    }
}

struct Xoauth2Authenticator {
    username: String,
    access_token: String,
}

impl imap::Authenticator for Xoauth2Authenticator {
    type Response = String;

    fn process(&self, _challenge: &[u8]) -> Self::Response {
        xoauth2_sasl_response(&self.username, &self.access_token)
    }
}

pub fn init_mail_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_folders (
            account_id TEXT NOT NULL,
            name TEXT NOT NULL,
            delimiter TEXT,
            flags_json TEXT NOT NULL DEFAULT '[]',
            uid_validity INTEGER,
            uid_next INTEGER,
            total INTEGER,
            unread INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, name)
        );

        CREATE TABLE IF NOT EXISTS mail_messages (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid INTEGER NOT NULL,
            message_id TEXT,
            subject TEXT NOT NULL DEFAULT '',
            from_name TEXT,
            from_addr TEXT,
            to_json TEXT NOT NULL DEFAULT '[]',
            cc_json TEXT NOT NULL DEFAULT '[]',
            date_ts INTEGER,
            flags_json TEXT NOT NULL DEFAULT '[]',
            has_attachments INTEGER NOT NULL DEFAULT 0,
            attachment_count INTEGER NOT NULL DEFAULT 0,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            snippet TEXT,
            body_text TEXT,
            body_html TEXT,
            body_cached_at INTEGER,
            raw_size INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_messages_folder_date
            ON mail_messages(account_id, folder, date_ts DESC, uid DESC);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_message_id
            ON mail_messages(account_id, message_id);

        CREATE TABLE IF NOT EXISTS mail_contacts (
            account_id TEXT NOT NULL,
            email TEXT NOT NULL COLLATE NOCASE,
            name TEXT,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            sent_count INTEGER NOT NULL DEFAULT 0,
            received_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, email)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_contacts_search
            ON mail_contacts(account_id, email, name);

        CREATE TABLE IF NOT EXISTS mail_drafts (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            to_json TEXT NOT NULL DEFAULT '[]',
            cc_json TEXT NOT NULL DEFAULT '[]',
            bcc_json TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '',
            text_body TEXT NOT NULL DEFAULT '',
            html_body TEXT NOT NULL DEFAULT '',
            attachments_json TEXT NOT NULL DEFAULT '[]',
            reply_context_json TEXT,
            remote_draft_folder TEXT,
            remote_draft_uid INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, id)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_drafts_updated
            ON mail_drafts(account_id, updated_at DESC);",
    )
}

fn with_mail_db<T>(
    state: &State<'_, AppState>,
    account_id: &str,
    f: impl FnOnce(&Connection) -> SqlResult<T>,
) -> Result<T, String> {
    let db = state.mail_db(account_id)?;
    let db = db.lock().map_err(|e| e.to_string())?;
    init_mail_tables(&db).map_err(|e| e.to_string())?;
    f(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mail_test_connection(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<MailTestConnectionResult, String> {
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let folders = with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts {
                force_fresh: true,
                retry_on_error: false,
            },
            |imap| imap.list_folders(&account.config.session_id),
        )?;
        test_smtp(&account, &handle)?;
        Ok(MailTestConnectionResult {
            imap_ok: true,
            smtp_ok: true,
            folder_count: folders.len(),
        })
    })
    .await
    .map_err(|e| format!("mail test task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_oauth_authorize(
    request: MailOAuthAuthorizeRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MailOAuthAuthorizeResult, String> {
    let client_id = request.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("OAuth2 client ID is required".into());
    }
    if request.provider == MailProvider::Custom {
        return Err("OAuth2 mail auth requires Gmail or Outlook provider".into());
    }

    let bind_host = oauth_loopback_bind_host(request.provider)?;
    let listener = std::net::TcpListener::bind((bind_host, 0))
        .map_err(|e| format!("OAuth callback listener failed: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("OAuth callback timeout setup failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("OAuth callback address failed: {e}"))?
        .port();
    let redirect_uri = oauth_loopback_redirect_uri(request.provider, port)?;
    let state_token = random_urlsafe_token(32);
    let verifier = random_urlsafe_token(48);
    let challenge = pkce_challenge(&verifier);
    let auth_url = build_oauth_authorize_url(
        request.provider,
        &client_id,
        &redirect_uri,
        &state_token,
        &challenge,
    )?;

    #[allow(deprecated)]
    app.shell()
        .open(auth_url, None)
        .map_err(|e| format!("failed to open OAuth authorization URL: {e}"))?;

    let callback_state = state_token.clone();
    let callback =
        tokio::task::spawn_blocking(move || wait_for_oauth_callback(listener, &callback_state))
            .await
            .map_err(|e| format!("OAuth callback task failed: {e}"))??;

    let provider = request.provider;
    let client_secret =
        resolve_secret(&state, request.client_secret.as_deref())?.and_then(non_empty);
    let network_settings = prepare_mail_network(&state, request.network_settings.clone())?;
    let token = tokio::task::spawn_blocking(move || {
        exchange_oauth_code_blocking(
            provider,
            &client_id,
            client_secret.as_deref(),
            &redirect_uri,
            &callback.code,
            &verifier,
            network_settings.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("OAuth token exchange task failed: {e}"))??;

    persist_new_oauth_token(
        &state,
        provider,
        &request.email_address,
        &request.session_id,
        token,
    )
}

#[tauri::command]
pub async fn mail_oauth_device_start(
    request: MailOAuthDeviceStartRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MailOAuthDeviceStartResult, String> {
    let client_id = request.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("OAuth2 client ID is required".into());
    }
    if request.provider == MailProvider::Custom {
        return Err("Device code authorization requires Gmail or Outlook provider".into());
    }
    let network_settings = prepare_mail_network(&state, request.network_settings.clone())?;
    let provider = request.provider;
    let device = tokio::task::spawn_blocking(move || {
        start_oauth_device_code_blocking(provider, &client_id, network_settings.as_ref())
    })
    .await
    .map_err(|e| format!("OAuth device code task failed: {e}"))??;

    #[allow(deprecated)]
    app.shell()
        .open(device.verification_uri.clone(), None)
        .map_err(|e| format!("failed to open OAuth device login URL: {e}"))?;

    Ok(MailOAuthDeviceStartResult {
        device_code: device.device_code,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        message: device.message.unwrap_or_else(|| {
            "Open the verification URL and enter the device code to authorize this mail account."
                .into()
        }),
        expires_in: device.expires_in.unwrap_or(900),
        interval: device.interval.unwrap_or(5).max(1),
    })
}

#[tauri::command]
pub async fn mail_oauth_device_complete(
    request: MailOAuthDeviceCompleteRequest,
    state: State<'_, AppState>,
) -> Result<MailOAuthAuthorizeResult, String> {
    let client_id = request.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("OAuth2 client ID is required".into());
    }
    if request.provider == MailProvider::Custom {
        return Err("Device code authorization requires Gmail or Outlook provider".into());
    }
    let device_code = request.device_code.trim().to_string();
    if device_code.is_empty() {
        return Err("OAuth2 device code is required".into());
    }
    let client_secret =
        resolve_secret(&state, request.client_secret.as_deref())?.and_then(non_empty);
    let network_settings = prepare_mail_network(&state, request.network_settings.clone())?;
    let provider = request.provider;
    let interval = request.interval.unwrap_or(5).max(1);
    let expires_in = request.expires_in.unwrap_or(900).max(1);
    let token = tokio::task::spawn_blocking(move || {
        complete_oauth_device_code_blocking(
            provider,
            &client_id,
            client_secret.as_deref(),
            &device_code,
            interval,
            expires_in,
            network_settings.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("OAuth device polling task failed: {e}"))??;

    persist_new_oauth_token(
        &state,
        provider,
        &request.email_address,
        &request.session_id,
        token,
    )
}

/// Sync headers for one folder.
///
/// `refresh_folders`: when true (default), run IMAP LIST so the folder tree is
/// refreshed. Quiet/background polls pass false to skip LIST when the SQLite
/// cache already has folders; selected-folder headers still sync.
#[tauri::command]
pub async fn mail_sync_headers(
    config: MailAccountConfig,
    folder: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    include_bodies: Option<bool>,
    refresh_folders: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailSyncResult, String> {
    let account = resolve_config(&state, config)?;
    let folder = folder
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "INBOX".to_string());
    let cache_enabled = account.config.cache.enabled;
    let cache_settings = account.config.cache.clone();
    let account_id = account.config.session_id.clone();
    let offset = offset.unwrap_or(0);
    let limit = limit
        .unwrap_or(account.config.sync.max_fetch_per_sync)
        .max(1)
        .min(2000);
    let include_bodies = include_bodies.unwrap_or(false);
    let refresh_folders = refresh_folders.unwrap_or(true);

    let cached_folders = if cache_enabled {
        with_mail_db(&state, &account_id, |db| list_cached_folders(db, &account_id))?
    } else {
        Vec::new()
    };
    let do_list = should_list_remote_folders(refresh_folders, cached_folders.len());

    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let mut result = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            let base_folders = if do_list {
                imap.list_folders(&account.config.session_id)?
            } else {
                // Clone: with_imap_session may invoke this FnMut twice on retry.
                cached_folders.clone()
            };
            let (selected_folder, cached, has_more) =
                imap.sync_folder(&account, &folder, offset, limit, include_bodies)?;
            let folders = folders_for_header_sync(base_folders, selected_folder.clone());
            let cached_bodies = cached.iter().filter(|m| m.body_cached_at.is_some()).count();
            Ok((folders, selected_folder, cached, cached_bodies, has_more, do_list))
        })
    })
    .await
    .map_err(|e| format!("mail sync task failed: {e}"))??;

    if cache_enabled {
        with_mail_db(&state, &account_id, |db| {
            cache_sync_result(
                db,
                &account_id,
                &result.0,
                &result.2,
                &result.1.name,
                &cache_settings,
            )
        })?;
    }

    tracing::debug!(
        account_id = %account_id,
        folder = %result.1.name,
        listed_remote = result.5,
        refresh_folders,
        "mail sync headers folders source"
    );

    let synced_at = now_ts();
    let messages = result.2.drain(..).map(|m| m.header).collect::<Vec<_>>();
    Ok(MailSyncResult {
        account_id,
        folder: result.1.name,
        folders: result.0,
        fetched_messages: messages.len(),
        cached_bodies: result.3,
        messages,
        synced_at,
        offset,
        limit,
        has_more: result.4,
    })
}

#[tauri::command]
pub async fn mail_sync_all_folders(
    config: MailAccountConfig,
    limit: Option<u32>,
    include_bodies: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailSyncAllResult, String> {
    let account = resolve_config(&state, config)?;
    let cache_enabled = account.config.cache.enabled;
    let cache_settings = account.config.cache.clone();
    let account_id = account.config.session_id.clone();
    let limit = limit
        .unwrap_or(account.config.sync.max_fetch_per_sync)
        .max(1)
        .min(2000);
    let include_bodies = include_bodies.unwrap_or(false);
    let sync_states = if cache_enabled {
        with_mail_db(&state, &account_id, |db| {
            cached_folder_sync_states(db, &account_id)
        })?
    } else {
        HashMap::new()
    };

    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let result = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            let mut folders = imap.list_folders(&account.config.session_id)?;
            let mut messages = Vec::new();
            let mut new_messages = 0usize;
            for listed in folders.clone() {
                let folder_name = listed.name;
                let state = sync_states.get(&folder_name).copied().unwrap_or_default();
                match imap.sync_folder_incremental(
                    &account,
                    &folder_name,
                    state,
                    limit,
                    include_bodies,
                ) {
                    Ok((synced_folder, mut synced_messages)) => {
                        let same_uid_validity = state.max_uid > 0
                            && (state.uid_validity.is_none()
                                || synced_folder.uid_validity.is_none()
                                || state.uid_validity == synced_folder.uid_validity);
                        if same_uid_validity {
                            new_messages += synced_messages.len();
                        }
                        merge_selected_folder(&mut folders, synced_folder);
                        messages.append(&mut synced_messages);
                    }
                    Err(e) => {
                        tracing::debug!(
                            "mail incremental sync skipped folder {folder_name}: {e}"
                        );
                    }
                }
            }
            let cached_bodies = messages
                .iter()
                .filter(|m| m.body_cached_at.is_some())
                .count();
            Ok((folders, messages, cached_bodies, new_messages))
        })
    })
    .await
    .map_err(|e| format!("mail sync all task failed: {e}"))??;

    if cache_enabled {
        with_mail_db(&state, &account_id, |db| {
            cache_sync_all_result(db, &account_id, &result.0, &result.1, &cache_settings)
        })?;
    }

    let fetched_messages = result.1.len();
    Ok(MailSyncAllResult {
        account_id,
        folders: result.0,
        fetched_messages,
        new_messages: result.3,
        cached_bodies: result.2,
        synced_at: now_ts(),
    })
}

#[tauri::command]
pub async fn mail_list_cached_folders(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    with_mail_db(&state, &account_id, |db| {
        list_cached_folders(db, &account_id)
    })
}

#[tauri::command]
pub async fn mail_list_cached_messages(
    account_id: String,
    folder: String,
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    with_mail_db(&state, &account_id, |db| {
        list_cached_messages(
            db,
            &account_id,
            &folder,
            limit.unwrap_or(DEFAULT_MESSAGE_LIMIT as u32).min(1000),
            offset.unwrap_or(0),
        )
    })
}

#[tauri::command]
pub async fn mail_get_message_body(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
    let account_id = config.session_id.clone();
    if config.cache.enabled {
        let cached = with_mail_db(&state, &account_id, |db| {
            get_cached_body(db, &account_id, &folder, uid)
        })?;
        if let Some(body) = cached {
            return Ok(body);
        }
    }

    let account = resolve_config(&state, config)?;
    let cache_enabled = account.config.cache.enabled;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let message = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.fetch_body(&account, &folder, uid)
        })
    })
    .await
    .map_err(|e| format!("mail body task failed: {e}"))??;

    if cache_enabled {
        with_mail_db(&state, &account_id, |db| upsert_message(db, &message))?;
    }

    Ok(cached_to_body(message, "remote"))
}

#[tauri::command]
pub async fn mail_download_attachment(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    attachment_index: usize,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<MailDownloadAttachmentResult, String> {
    let target_path = target_path.trim().to_string();
    if target_path.is_empty() {
        return Err("attachment download path is required".into());
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.download_attachment(&account, &folder, uid, attachment_index, &target_path)
        })
    })
    .await
    .map_err(|e| format!("mail attachment download task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_send_message(
    config: MailAccountConfig,
    request: MailSendRequest,
    state: State<'_, AppState>,
) -> Result<MailSendResult, String> {
    let account = resolve_config(&state, config)?;
    validate_send_request(&request)?;
    let account_id = account.config.session_id.clone();
    let sent_request = request.clone();
    let handle = tokio::runtime::Handle::current();
    let result = tokio::task::spawn_blocking(move || send_smtp(&account, &request, &handle))
        .await
        .map_err(|e| format!("mail send task failed: {e}"))??;
    if result.accepted {
        with_mail_db(&state, &account_id, |db| {
            upsert_sent_contacts(db, &account_id, &sent_request)
        })?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn mail_list_drafts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailDraft>, String> {
    with_mail_db(&state, &account_id, |db| list_mail_drafts(db, &account_id))
}

#[tauri::command]
pub async fn mail_save_draft(
    account_id: String,
    draft: MailDraftSaveRequest,
    state: State<'_, AppState>,
) -> Result<MailDraft, String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Err("mail account id is required".into());
    }
    with_mail_db(&state, account_id, |db| {
        save_mail_draft(db, account_id, draft)
    })
}

#[tauri::command]
pub async fn mail_delete_draft(
    account_id: String,
    draft_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let account_id = account_id.trim();
    let draft_id = draft_id.trim();
    if account_id.is_empty() {
        return Err("mail account id is required".into());
    }
    if draft_id.is_empty() {
        return Err("mail draft id is required".into());
    }
    with_mail_db(&state, account_id, |db| {
        delete_mail_draft(db, account_id, draft_id)
    })
}

#[tauri::command]
pub async fn mail_index_cached_contacts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    with_mail_db(&state, &account_id, |db| {
        reindex_cached_contacts(db, &account_id)
    })
}

#[tauri::command]
pub async fn mail_search_contacts(
    account_id: String,
    query: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<MailContactSuggestion>, String> {
    with_mail_db(&state, &account_id, |db| {
        search_contacts(db, &account_id, &query, limit.unwrap_or(8).clamp(1, 20))
    })
}

#[tauri::command]
pub async fn mail_mark_read(
    config: MailAccountConfig,
    folder: String,
    uids: Option<Vec<u32>>,
    all: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailMarkReadResult, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let account_id = config.session_id.clone();
    let target_uids = if all.unwrap_or(false) {
        with_mail_db(&state, &account_id, |db| {
            unread_cached_uids(db, &account_id, &folder)
        })?
    } else {
        uids.unwrap_or_default()
            .into_iter()
            .filter(|uid| *uid > 0)
            .collect::<Vec<_>>()
    };
    if target_uids.is_empty() {
        return Ok(MailMarkReadResult { folder, marked: 0 });
    }

    let account = resolve_config(&state, config)?;
    let marked = target_uids.len();
    let folder_for_task = folder.clone();
    let uids_for_task = target_uids.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.mark_read(&folder_for_task, &uids_for_task)
        })
    })
    .await
    .map_err(|e| format!("mail mark read task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        mark_cached_messages_read(db, &account_id, &folder, &target_uids)
    })?;
    Ok(MailMarkReadResult { folder, marked })
}

#[tauri::command]
pub async fn mail_clear_cache(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.mail_imap_pool.invalidate(&account_id);
    with_mail_db(&state, &account_id, |db| {
        db.execute(
            "DELETE FROM mail_messages WHERE account_id = ?1",
            params![account_id],
        )?;
        db.execute(
            "DELETE FROM mail_folders WHERE account_id = ?1",
            params![account_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub async fn mail_set_flags(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<MailFlagResult, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let add = add.unwrap_or_default();
    let remove = remove.unwrap_or_default();
    let target_uids = uids.into_iter().filter(|uid| *uid > 0).collect::<Vec<_>>();
    if target_uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(MailFlagResult { folder, updated: 0 });
    }

    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let folder_for_task = folder.clone();
    let uids_for_task = target_uids.clone();
    let add_for_task = add.clone();
    let remove_for_task = remove.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.set_flags(
                &folder_for_task,
                &uids_for_task,
                &add_for_task,
                &remove_for_task,
            )
        })
    })
    .await
    .map_err(|e| format!("mail set flags task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        update_cached_flags(db, &account_id, &folder, &target_uids, &add, &remove)
    })?;
    Ok(MailFlagResult {
        folder,
        updated: target_uids.len(),
    })
}

#[tauri::command]
pub async fn mail_move_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    target_folder: String,
    state: State<'_, AppState>,
) -> Result<MailMoveResult, String> {
    let folder = folder.trim().to_string();
    let target_folder = target_folder.trim().to_string();
    if folder.is_empty() || target_folder.is_empty() {
        return Err("source and target folders are required".into());
    }
    if folder == target_folder {
        return Err("source and target folders must differ".into());
    }
    let target_uids = uids.into_iter().filter(|uid| *uid > 0).collect::<Vec<_>>();
    if target_uids.is_empty() {
        return Ok(MailMoveResult {
            folder,
            target: target_folder,
            count: 0,
        });
    }

    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let folder_for_task = folder.clone();
    let target_for_task = target_folder.clone();
    let uids_for_task = target_uids.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.move_messages(&folder_for_task, &uids_for_task, &target_for_task)
        })
    })
    .await
    .map_err(|e| format!("mail move task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        remove_cached_messages(db, &account_id, &folder, &target_uids)
    })?;
    Ok(MailMoveResult {
        folder,
        target: target_folder,
        count: target_uids.len(),
    })
}

#[tauri::command]
pub async fn mail_copy_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    target_folder: String,
    state: State<'_, AppState>,
) -> Result<MailMoveResult, String> {
    let folder = folder.trim().to_string();
    let target_folder = target_folder.trim().to_string();
    if folder.is_empty() || target_folder.is_empty() {
        return Err("source and target folders are required".into());
    }
    let target_uids = uids.into_iter().filter(|uid| *uid > 0).collect::<Vec<_>>();
    if target_uids.is_empty() {
        return Ok(MailMoveResult {
            folder,
            target: target_folder,
            count: 0,
        });
    }

    let account = resolve_config(&state, config)?;
    let folder_for_task = folder.clone();
    let target_for_task = target_folder.clone();
    let uids_for_task = target_uids.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.copy_messages(&folder_for_task, &uids_for_task, &target_for_task)
        })
    })
    .await
    .map_err(|e| format!("mail copy task failed: {e}"))??;

    Ok(MailMoveResult {
        folder,
        target: target_folder,
        count: target_uids.len(),
    })
}

#[tauri::command]
pub async fn mail_delete_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Option<Vec<u32>>,
    all: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailDeleteResult, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let all = all.unwrap_or(false);
    let target_uids = uids
        .unwrap_or_default()
        .into_iter()
        .filter(|uid| *uid > 0)
        .collect::<Vec<_>>();
    if !all && target_uids.is_empty() {
        return Ok(MailDeleteResult { folder, deleted: 0 });
    }

    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let folder_for_task = folder.clone();
    let uids_for_task = target_uids.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let deleted = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.delete_messages(&folder_for_task, &uids_for_task, all)
        })
    })
    .await
    .map_err(|e| format!("mail delete task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        if all {
            db.execute(
                "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
                params![account_id, folder],
            )?;
        } else {
            remove_cached_messages(db, &account_id, &folder, &target_uids)?;
        }
        Ok(())
    })?;
    Ok(MailDeleteResult { folder, deleted })
}

#[tauri::command]
pub async fn mail_fetch_raw(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let raw = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.fetch_raw(&folder, uid)
        })
    })
    .await
    .map_err(|e| format!("mail fetch raw task failed: {e}"))??;
    Ok(String::from_utf8_lossy(&raw).to_string())
}

#[tauri::command]
pub async fn mail_save_raw(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<MailDownloadAttachmentResult, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    if target_path.trim().is_empty() {
        return Err("target path is required".into());
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            let raw = imap.fetch_raw(&folder, uid)?;
            let path = std::path::PathBuf::from(&target_path);
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create folder: {e}"))?;
            }
            std::fs::write(&path, &raw).map_err(|e| format!("failed to write .eml file: {e}"))?;
            Ok(MailDownloadAttachmentResult {
                path: path.to_string_lossy().to_string(),
                name: path.file_name().map(|n| n.to_string_lossy().to_string()),
                content_type: Some("message/rfc822".to_string()),
                size: raw.len(),
            })
        })
    })
    .await
    .map_err(|e| format!("mail save raw task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_create_folder(
    config: MailAccountConfig,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("folder name is required".into());
    }
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let name_for_task = name.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let folders = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.create_folder(&name_for_task)?;
            imap.list_folders(&account.config.session_id)
        })
    })
    .await
    .map_err(|e| format!("mail create folder task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        for folder in &folders {
            upsert_folder(db, folder)?;
        }
        Ok(())
    })?;
    Ok(folders)
}

#[tauri::command]
pub async fn mail_rename_folder(
    config: MailAccountConfig,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let from = from.trim().to_string();
    let to = to.trim().to_string();
    if from.is_empty() || to.is_empty() {
        return Err("current and new folder names are required".into());
    }
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let from_for_task = from.clone();
    let to_for_task = to.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let folders = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.rename_folder(&from_for_task, &to_for_task)?;
            imap.list_folders(&account.config.session_id)
        })
    })
    .await
    .map_err(|e| format!("mail rename folder task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        purge_cached_folder(db, &account_id, &from)?;
        for folder in &folders {
            upsert_folder(db, folder)?;
        }
        Ok(())
    })?;
    Ok(folders)
}

#[tauri::command]
pub async fn mail_delete_folder(
    config: MailAccountConfig,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("folder name is required".into());
    }
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let name_for_task = name.clone();
    let pool = Arc::clone(&state.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let folders = tokio::task::spawn_blocking(move || {
        with_imap_session(&pool, &account, &handle, ImapSessionOpts::default(), |imap| {
            imap.delete_folder(&name_for_task)?;
            imap.list_folders(&account.config.session_id)
        })
    })
    .await
    .map_err(|e| format!("mail delete folder task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        purge_cached_folder(db, &account_id, &name)?;
        for folder in &folders {
            upsert_folder(db, folder)?;
        }
        Ok(())
    })?;
    Ok(folders)
}

fn resolve_config(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<ResolvedMailAccount, String> {
    let network_settings = prepare_mail_network(state, config.network_settings.clone())?;
    let imap_host = config.imap.host.trim();
    if imap_host.is_empty() {
        return Err("IMAP host is required".into());
    }
    if config.smtp.host.trim().is_empty() {
        return Err("SMTP host is required".into());
    }
    let imap_username = config
        .imap
        .username
        .clone()
        .and_then(non_empty)
        .or_else(|| non_empty(config.email_address.clone()))
        .ok_or_else(|| "IMAP username is required".to_string())?;
    let (imap_password, smtp_username, smtp_password) = match config.auth_mode {
        MailAuthMode::Password => {
            let imap_password = resolve_secret(state, config.imap.password.as_deref())?
                .ok_or_else(|| "IMAP password or app password token is required".to_string())?;

            let (smtp_username, smtp_password) = if config.smtp.use_imap_auth {
                (imap_username.clone(), imap_password.clone())
            } else {
                let username = config
                    .smtp
                    .username
                    .clone()
                    .and_then(non_empty)
                    .or_else(|| non_empty(config.email_address.clone()))
                    .ok_or_else(|| "SMTP username is required".to_string())?;
                let password = resolve_secret(state, config.smtp.password.as_deref())?
                    .ok_or_else(|| "SMTP password or app password token is required".to_string())?;
                (username, password)
            };
            (imap_password, smtp_username, smtp_password)
        }
        MailAuthMode::OAuth2 => {
            let access_token =
                resolve_oauth_access_token(state, &config, network_settings.as_ref())?;
            let smtp_username = if config.smtp.use_imap_auth {
                imap_username.clone()
            } else {
                config
                    .smtp
                    .username
                    .clone()
                    .and_then(non_empty)
                    .or_else(|| non_empty(config.email_address.clone()))
                    .ok_or_else(|| "SMTP username is required".to_string())?
            };
            (access_token.clone(), smtp_username, access_token)
        }
    };

    Ok(ResolvedMailAccount {
        auth_mode: config.auth_mode,
        network_settings,
        config,
        imap_username,
        imap_password,
        smtp_username,
        smtp_password,
    })
}

fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => match state.vault.resolve(v)? {
            Some(plain) => Ok(Some((*plain).clone())),
            None => Ok(Some(v.to_string())),
        },
        None => Ok(None),
    }
}

/// Resolve mail session network settings for IMAP/SMTP/OAuth.
///
/// Important: this uses **only** the mail session's own `networkSettings`.
/// It never falls back to the app global proxy (`proxy::AppProxyConfig`).
/// Missing settings or `proxy_kind` empty/`none` means a direct connection.
fn prepare_mail_network(
    state: &State<'_, AppState>,
    network: Option<NetworkSettings>,
) -> Result<Option<NetworkSettings>, String> {
    let Some(mut net) = network else {
        return Ok(None);
    };
    if matches!(net.proxy_kind.as_str(), "" | "none") {
        return Ok(None);
    }
    crate::terminal::resolve_proxy_session(state, &mut net)?;
    net.resolve_proxy_pass(&state.vault)?;
    crate::terminal::resolve_jump_credentials(state, &mut net)?;
    Ok(Some(net))
}

fn resolve_oauth_access_token(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    network: Option<&NetworkSettings>,
) -> Result<String, String> {
    if config.provider == MailProvider::Custom {
        return Err("OAuth2 mail auth requires Gmail or Outlook provider".into());
    }

    let token_ref = config
        .oauth
        .token_ref
        .as_deref()
        .and_then(non_empty_str)
        .ok_or_else(|| "OAuth2 token is required. Reconnect this mail account.".to_string())?;
    let mut bundle = read_oauth_token_bundle(state, token_ref, config)?;
    if !oauth_token_expired(bundle.expires_at) {
        return Ok(bundle.access_token);
    }

    let refresh_token = match bundle.refresh_token.clone().and_then(non_empty) {
        Some(value) => value,
        None => match config
            .oauth
            .refresh_token_ref
            .as_deref()
            .and_then(non_empty_str)
        {
            Some(value) => resolve_secret(state, Some(value))?
                .and_then(non_empty)
                .ok_or_else(oauth_reauthorize_required_message)?,
            None => {
                return Err(oauth_reauthorize_required_message());
            }
        },
    };
    let client_id = config
        .oauth
        .client_id
        .as_deref()
        .and_then(non_empty_str)
        .ok_or_else(|| "OAuth2 client ID is required to refresh this mail account".to_string())?
        .to_string();
    let client_secret = resolve_secret(state, config.oauth.client_secret.as_deref())?;
    let refresh_scope = oauth_refresh_scope(config.provider, &bundle, &config.oauth);
    // resolve_config runs on the async command worker. reqwest::blocking builds a
    // nested Runtime and panics in debug if the calling thread has already entered
    // Tokio ("Cannot drop a runtime..."). Always refresh on a plain OS thread.
    let provider = config.provider;
    let network = network.cloned();
    let refreshed = run_outside_tokio_context({
        let refresh_token = refresh_token.clone();
        let refresh_scope = refresh_scope.clone();
        move || {
            refresh_oauth_token_blocking(
                provider,
                &client_id,
                client_secret.as_deref(),
                &refresh_token,
                refresh_scope.as_deref(),
                network.as_ref(),
            )
        }
    })?
    .map_err(|e| oauth_refresh_error_message(&e))?;
    bundle.access_token = refreshed.access_token;
    if let Some(refresh_token) = refreshed.refresh_token.and_then(non_empty) {
        bundle.refresh_token = Some(refresh_token);
    }
    bundle.expires_at = refreshed
        .expires_in
        .map(|seconds| now_ts() + seconds.max(0));
    bundle.token_type = refreshed.token_type.and_then(non_empty);
    bundle.scope = refreshed.scope.and_then(non_empty).or(refresh_scope);
    persist_oauth_token_bundle(state, token_ref, &bundle)?;
    tracing::info!(
        provider = ?config.provider,
        session_id = %config.session_id,
        "refreshed mail OAuth2 access token"
    );
    Ok(bundle.access_token)
}

fn persist_new_oauth_token(
    state: &State<'_, AppState>,
    provider: MailProvider,
    email_address: &str,
    session_id: &str,
    token: OAuthTokenResponse,
) -> Result<MailOAuthAuthorizeResult, String> {
    if let Some(error) = token.error.as_deref() {
        let detail = token.error_description.as_deref().unwrap_or("");
        return Err(format!("OAuth token exchange failed: {error} {detail}"));
    }
    if token.access_token.trim().is_empty() {
        return Err("OAuth token response did not include an access token".into());
    }
    let refresh_token = token
        .refresh_token
        .clone()
        .and_then(non_empty)
        .ok_or_else(|| {
            "OAuth token response did not include a refresh token. Ensure offline access is allowed and reconnect.".to_string()
        })?;
    let expires_at = token.expires_in.map(|seconds| now_ts() + seconds.max(0));
    let scope = token
        .scope
        .clone()
        .and_then(non_empty)
        .or_else(|| oauth_scope(provider).ok().map(str::to_string));
    let token_type = token.token_type.clone().and_then(non_empty);
    let bundle = MailOAuthTokenBundle {
        access_token: token.access_token,
        refresh_token: Some(refresh_token),
        expires_at,
        token_type: token_type.clone(),
        scope: scope.clone(),
    };
    let json = serde_json::to_string(&bundle).map_err(|e| e.to_string())?;
    let label_owner =
        non_empty(email_address.to_string()).unwrap_or_else(|| session_id.to_string());
    let saved = state.vault.put(
        "mail-oauth-token",
        &format!("{label_owner} OAuth2 token"),
        &json,
    )?;
    Ok(MailOAuthAuthorizeResult {
        token_ref: saved.reference,
        expires_at,
        scope,
        token_type,
    })
}

fn read_oauth_token_bundle(
    state: &State<'_, AppState>,
    token_ref: &str,
    config: &MailAccountConfig,
) -> Result<MailOAuthTokenBundle, String> {
    let raw = resolve_secret(state, Some(token_ref))?
        .ok_or_else(|| "OAuth2 token is required. Reconnect this mail account.".to_string())?;
    if let Ok(bundle) = serde_json::from_str::<MailOAuthTokenBundle>(&raw) {
        if !bundle.access_token.trim().is_empty() {
            return Ok(bundle);
        }
    }

    // Backwards-compatible fallback: treat a non-JSON token entry as an access
    // token and use the separate refresh ref / expiresAt fields if present.
    let refresh_token = match config
        .oauth
        .refresh_token_ref
        .as_deref()
        .and_then(non_empty_str)
    {
        Some(value) => resolve_secret(state, Some(value))?.and_then(non_empty),
        None => None,
    };
    Ok(MailOAuthTokenBundle {
        access_token: raw,
        refresh_token,
        expires_at: config.oauth.expires_at,
        token_type: Some("Bearer".into()),
        scope: config.oauth.scope.clone(),
    })
}

fn persist_oauth_token_bundle(
    state: &State<'_, AppState>,
    token_ref: &str,
    bundle: &MailOAuthTokenBundle,
) -> Result<(), String> {
    let id = token_ref
        .strip_prefix(crate::vault::VAULT_REF_PREFIX)
        .ok_or_else(|| "OAuth2 token must be stored in the credential vault".to_string())?;
    let json = serde_json::to_string(bundle).map_err(|e| e.to_string())?;
    state.vault.update(id, &json)
}

fn oauth_refresh_scope(
    provider: MailProvider,
    bundle: &MailOAuthTokenBundle,
    settings: &MailOAuthSettings,
) -> Option<String> {
    bundle
        .scope
        .clone()
        .and_then(non_empty)
        .or_else(|| settings.scope.clone().and_then(non_empty))
        .or_else(|| oauth_scope(provider).ok().map(str::to_string))
}

fn oauth_reauthorize_required_message() -> String {
    OAUTH_REAUTHORIZE_REQUIRED.to_string()
}

fn oauth_refresh_error_message(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("invalid_grant")
        || lower.contains("interaction_required")
        || lower.contains("consent_required")
        || lower.contains("unauthorized_client")
        || lower.contains("aadsts70008")
        || lower.contains("aadsts700082")
    {
        format!("{OAUTH_REAUTHORIZE_REQUIRED} Detail: {error}")
    } else {
        format!(
            "OAuth2 access token expired and refresh failed: {error}. Reauthorize this mail account if the refresh token has expired."
        )
    }
}

fn oauth_token_expired(expires_at: Option<i64>) -> bool {
    match expires_at {
        Some(ts) => ts <= now_ts() + OAUTH_REFRESH_SKEW_SECS,
        None => false,
    }
}

/// Run `f` on a thread that has **not** entered a Tokio runtime.
///
/// `reqwest::blocking` creates a temporary Runtime in debug builds to detect
/// nested use; dropping that Runtime while the current thread is already inside
/// Tokio panics with "Cannot drop a runtime in a context where blocking is not
/// allowed". OAuth refresh is often invoked from async Tauri commands, so isolate
/// the blocking HTTP client onto a plain OS thread when needed.
fn run_outside_tokio_context<R: Send + 'static>(
    f: impl FnOnce() -> R + Send + 'static,
) -> Result<R, String> {
    if tokio::runtime::Handle::try_current().is_err() {
        return Ok(f());
    }
    std::thread::Builder::new()
        .name("mail-oauth-http".into())
        .spawn(f)
        .map_err(|e| format!("failed to spawn mail HTTP worker: {e}"))?
        .join()
        .map_err(|_| "mail HTTP worker thread panicked".to_string())
}

fn refresh_oauth_token_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    scope: Option<&str>,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = client_secret.and_then(non_empty_str) {
        params.push(("client_secret", secret.to_string()));
    }
    if let Some(scope) = scope.and_then(non_empty_str) {
        params.push(("scope", scope.to_string()));
    }

    let client = build_oauth_http_client_blocking(network)?;
    let response = client
        .post(token_url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth token refresh failed: {e}"))?;
    parse_oauth_token_response(response, "refresh")
}

fn exchange_oauth_code_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", verifier.to_string()),
    ];
    if let Some(secret) = client_secret.and_then(non_empty_str) {
        params.push(("client_secret", secret.to_string()));
    }

    let client = build_oauth_http_client_blocking(network)?;
    let response = client
        .post(token_url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth token exchange failed: {e}"))?;
    parse_oauth_token_response(response, "exchange")
}

fn start_oauth_device_code_blocking(
    provider: MailProvider,
    client_id: &str,
    network: Option<&NetworkSettings>,
) -> Result<OAuthDeviceCodeResponse, String> {
    let device_url = oauth_device_code_url(provider)?;
    let params = vec![
        ("client_id", client_id.to_string()),
        ("scope", oauth_scope(provider)?.to_string()),
    ];

    let client = build_oauth_http_client_blocking(network)?;
    let response = client
        .post(device_url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth device code request failed: {e}"))?;
    parse_oauth_device_code_response(response)
}

fn complete_oauth_device_code_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    device_code: &str,
    interval: i64,
    expires_in: i64,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let client_secret = client_secret.and_then(non_empty_str);
    if provider == MailProvider::Gmail && client_secret.is_none() {
        return Err(
            "Gmail device code authorization requires the OAuth client secret from a Google TV and Limited Input OAuth client"
                .into(),
        );
    }
    let client = build_oauth_http_client_blocking(network)?;
    let deadline = Instant::now() + Duration::from_secs(expires_in.clamp(1, 3600) as u64);
    let mut poll_interval = Duration::from_secs(interval.clamp(1, 30) as u64);

    loop {
        if Instant::now() >= deadline {
            return Err("OAuth device code expired before authorization completed".into());
        }

        let mut params = vec![
            ("client_id", client_id.to_string()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
            ("device_code", device_code.to_string()),
        ];
        if let Some(secret) = client_secret {
            params.push(("client_secret", secret.to_string()));
        }
        let response = client
            .post(token_url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(oauth_form_body(&params))
            .send()
            .map_err(|e| format!("OAuth device token polling failed: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|e| format!("OAuth device token response read failed: {e}"))?;
        let token = serde_json::from_str::<OAuthTokenResponse>(&text).map_err(|e| {
            format!("OAuth device token response parse failed ({status}): {e}; {text}")
        })?;

        if status.is_success() && token.error.is_none() {
            if token.access_token.trim().is_empty() {
                return Err("OAuth device token response did not include an access token".into());
            }
            return Ok(token);
        }

        let error = token.error.as_deref().unwrap_or(if status.is_success() {
            "invalid_response"
        } else {
            "http_error"
        });
        let detail = token.error_description.as_deref().unwrap_or("");
        match error {
            "authorization_pending" => {
                std::thread::sleep(poll_interval);
            }
            "slow_down" => {
                poll_interval =
                    (poll_interval + Duration::from_secs(5)).min(Duration::from_secs(30));
                std::thread::sleep(poll_interval);
            }
            "authorization_declined" => {
                return Err("OAuth device authorization was declined".into());
            }
            "bad_verification_code" => {
                return Err("OAuth device authorization failed: bad verification code".into());
            }
            "expired_token" => {
                return Err("OAuth device code expired before authorization completed".into());
            }
            _ => {
                return Err(format!(
                    "OAuth device authorization failed ({status}): {error} {detail}"
                ));
            }
        }
    }
}

fn build_oauth_http_client_blocking(
    network: Option<&NetworkSettings>,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder =
        reqwest::blocking::Client::builder().timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    if let Some(net) = network {
        match net.proxy_kind.as_str() {
            "" | "none" => {}
            "http" => {
                let url = format!("http://{}:{}", net.proxy_host, net.proxy_port);
                let mut proxy = reqwest::Proxy::all(&url)
                    .map_err(|e| format!("OAuth HTTP proxy config failed: {e}"))?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "socks5" => {
                let url = format!("socks5h://{}:{}", net.proxy_host, net.proxy_port);
                let mut proxy = reqwest::Proxy::all(&url)
                    .map_err(|e| format!("OAuth SOCKS5 proxy config failed: {e}"))?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "ssh-tunnel" => {
                return Err("OAuth2 token requests through SSH tunnel are not supported yet; use HTTP or SOCKS5 proxy for this Mail session.".into());
            }
            "system" => {
                return Err("System proxy is not supported for Mail OAuth yet; use HTTP or SOCKS5 proxy in this session's Network tab.".into());
            }
            other => return Err(format!("Unsupported Mail OAuth proxy type: {other}")),
        }
    }
    builder
        .build()
        .map_err(|e| format!("failed to build OAuth client: {e}"))
}

fn parse_oauth_token_response(
    response: reqwest::blocking::Response,
    action: &str,
) -> Result<OAuthTokenResponse, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("OAuth token {action} response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("OAuth token {action} failed ({status}): {text}"));
    }
    let token = serde_json::from_str::<OAuthTokenResponse>(&text)
        .map_err(|e| format!("OAuth token {action} response parse failed: {e}"))?;
    if let Some(error) = token.error.as_deref() {
        let detail = token.error_description.as_deref().unwrap_or("");
        return Err(format!("OAuth token {action} failed: {error} {detail}"));
    }
    if token.access_token.trim().is_empty() {
        return Err(format!(
            "OAuth token {action} response did not include an access token"
        ));
    }
    Ok(token)
}

fn parse_oauth_device_code_response(
    response: reqwest::blocking::Response,
) -> Result<OAuthDeviceCodeResponse, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("OAuth device code response read failed: {e}"))?;
    let device = serde_json::from_str::<OAuthDeviceCodeResponse>(&text)
        .map_err(|e| format!("OAuth device code response parse failed ({status}): {e}; {text}"))?;
    if !status.is_success() {
        let error = device.error.as_deref().unwrap_or("request_failed");
        let detail = device.error_description.as_deref().unwrap_or("");
        return Err(format!(
            "OAuth device code request failed ({status}): {error} {detail}"
        ));
    }
    if let Some(error) = device.error.as_deref() {
        let detail = device.error_description.as_deref().unwrap_or("");
        return Err(format!(
            "OAuth device code request failed: {error} {detail}"
        ));
    }
    if device.device_code.trim().is_empty()
        || device.user_code.trim().is_empty()
        || device.verification_uri.trim().is_empty()
    {
        return Err("OAuth device code response was missing required fields".into());
    }
    Ok(device)
}

fn oauth_form_body(params: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn oauth_loopback_bind_host(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("127.0.0.1"),
        MailProvider::Outlook => Ok("localhost"),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

fn oauth_loopback_redirect_uri(provider: MailProvider, port: u16) -> Result<String, String> {
    match provider {
        MailProvider::Gmail => Ok(format!("http://127.0.0.1:{port}")),
        MailProvider::Outlook => Ok(format!("http://localhost:{port}")),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

fn build_oauth_authorize_url(
    provider: MailProvider,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(oauth_authorize_url(provider)?)
        .map_err(|e| format!("OAuth authorize URL parse failed: {e}"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", oauth_scope(provider)?)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        if provider == MailProvider::Gmail {
            query
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
    }
    Ok(url.to_string())
}

fn wait_for_oauth_callback(
    listener: std::net::TcpListener,
    expected_state: &str,
) -> Result<OAuthCallback, String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("OAuth callback timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("OAuth callback failed: {e}")),
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = [0u8; 8192];
    let n = stream
        .read(&mut buf)
        .map_err(|e| format!("OAuth callback read failed: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let line = request
        .lines()
        .next()
        .ok_or_else(|| "OAuth callback request was empty".to_string())?;
    let path = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "OAuth callback request was malformed".to_string())?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}"))
        .map_err(|e| format!("OAuth callback URL parse failed: {e}"))?;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    let result = if let Some(error) = error {
        let detail = error_description.unwrap_or_default();
        Err(format!("OAuth authorization failed: {error} {detail}"))
    } else if state.as_deref() != Some(expected_state) {
        Err("OAuth callback state did not match; authorization was rejected".into())
    } else {
        let code = code.ok_or_else(|| "OAuth callback did not include a code".to_string())?;
        Ok(OAuthCallback { code })
    };

    let body = if result.is_ok() {
        "Taomni Mail authorization complete. You can close this window."
    } else {
        "Taomni Mail authorization failed. You can close this window and retry."
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    result
}

fn oauth_authorize_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://accounts.google.com/o/oauth2/v2/auth"),
        MailProvider::Outlook => {
            Ok("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")
        }
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

fn oauth_token_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://oauth2.googleapis.com/token"),
        MailProvider::Outlook => Ok("https://login.microsoftonline.com/common/oauth2/v2.0/token"),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

fn oauth_device_code_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://oauth2.googleapis.com/device/code"),
        MailProvider::Outlook => {
            Ok("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode")
        }
        MailProvider::Custom => {
            Err("Device code authorization requires Gmail or Outlook provider".into())
        }
    }
}

fn oauth_scope(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://mail.google.com/"),
        MailProvider::Outlook => Ok(
            "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
        ),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

fn non_empty_str(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() { None } else { Some(value) }
}

fn xoauth2_sasl_response(username: &str, access_token: &str) -> String {
    format!("user={username}\x01auth=Bearer {access_token}\x01\x01")
}

fn random_urlsafe_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::fill(buf.as_mut_slice());
    URL_SAFE_NO_PAD.encode(buf)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn connect_imap(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<ActiveImapSession, String> {
    let host = account.config.imap.host.trim();
    let port = account.config.imap.port;
    let (connect_host, connect_port, forward_task) =
        mail_effective_endpoint(account, host, port, runtime)?;
    match account.config.imap.security {
        MailConnectionSecurity::Tls => {
            let stream = tcp_connect(&connect_host, connect_port)?;
            let connector = TlsConnector::builder()
                .build()
                .map_err(|e| format!("failed to build IMAP TLS connector: {e}"))?;
            let tls_stream = connector
                .connect(host, stream)
                .map_err(|e| format!("IMAP TLS handshake failed: {e}"))?;
            let mut client = imap::Client::new(tls_stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            Ok(ActiveImapSession::Tls {
                session: authenticate_imap_client(client, account)?,
                forward_task,
            })
        }
        MailConnectionSecurity::Starttls => {
            let stream = tcp_connect(&connect_host, connect_port)?;
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            let connector = TlsConnector::builder()
                .build()
                .map_err(|e| format!("failed to build IMAP STARTTLS connector: {e}"))?;
            let client = client
                .secure(host, &connector)
                .map_err(|e| format!("IMAP STARTTLS failed: {e}"))?;
            Ok(ActiveImapSession::Tls {
                session: authenticate_imap_client(client, account)?,
                forward_task,
            })
        }
        MailConnectionSecurity::None => {
            let stream = tcp_connect(&connect_host, connect_port)?;
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            Ok(ActiveImapSession::Plain {
                session: authenticate_imap_client(client, account)?,
                forward_task,
            })
        }
    }
}

fn mail_effective_endpoint(
    account: &ResolvedMailAccount,
    host: &str,
    port: u16,
    runtime: &tokio::runtime::Handle,
) -> Result<(String, u16, Option<JoinHandle<()>>), String> {
    let Some(network) = account.network_settings.clone() else {
        return Ok((host.to_string(), port, None));
    };
    // Use the caller's Handle without entering the runtime on this thread for
    // the whole IMAP/SMTP lifetime. `block_on` only needs the Handle; keeping
    // `enter()` active breaks `reqwest::blocking` (nested Runtime drop panic).
    let forward = runtime.block_on(crate::database::forward::start(
        host.to_string(),
        port,
        network,
    ))?;
    Ok((
        "127.0.0.1".to_string(),
        forward.local_port,
        Some(forward.task),
    ))
}

fn authenticate_imap_client<T: Read + Write>(
    client: imap::Client<T>,
    account: &ResolvedMailAccount,
) -> Result<imap::Session<T>, String> {
    match account.auth_mode {
        MailAuthMode::Password => {
            login_imap_client(client, &account.imap_username, &account.imap_password)
        }
        MailAuthMode::OAuth2 => {
            let auth = Xoauth2Authenticator {
                username: account.imap_username.clone(),
                access_token: account.imap_password.clone(),
            };
            if account.config.provider == MailProvider::Outlook {
                let initial_response = BASE64_STANDARD
                    .encode(xoauth2_sasl_response(&auth.username, &auth.access_token));
                client
                    .authenticate(format!("XOAUTH2 {initial_response}"), &auth)
                    .map_err(|(e, _)| imap_xoauth2_auth_error(account.config.provider, e))
            } else {
                client
                    .authenticate("XOAUTH2", &auth)
                    .map_err(|(e, _)| imap_xoauth2_auth_error(account.config.provider, e))
            }
        }
    }
}

fn imap_xoauth2_auth_error(provider: MailProvider, error: imap::Error) -> String {
    let detail = error.to_string();
    if provider == MailProvider::Outlook
        && detail.contains("User is authenticated but not connected")
    {
        format!(
            "IMAP XOAUTH2 authentication failed: {detail}. Outlook accepted the OAuth token, but the mailbox was not connected. Enable IMAP in Outlook.com Settings > Mail > Forwarding and IMAP, then retry. If it still fails, approve the recent IMAP sign-in activity at account.live.com/activity."
        )
    } else {
        format!("IMAP XOAUTH2 authentication failed: {detail}")
    }
}

fn login_imap_client<T: Read + Write>(
    mut client: imap::Client<T>,
    username: &str,
    password: &str,
) -> Result<imap::Session<T>, String> {
    for attempt in 0..=IMAP_LOGIN_RETRY_DELAYS_MS.len() {
        match client.login(username, password) {
            Ok(session) => return Ok(session),
            Err((e, next_client)) => {
                let message = e.to_string();
                client = next_client;
                let retry_limit_reached = attempt >= IMAP_LOGIN_RETRY_DELAYS_MS.len();
                let retryable = should_retry_imap_login(&message);
                if retry_limit_reached || !retryable {
                    return Err(format!("IMAP login failed: {message}"));
                }

                let delay_ms = IMAP_LOGIN_RETRY_DELAYS_MS[attempt];
                tracing::debug!(
                    "transient IMAP login failure; retrying in {delay_ms}ms: {message}"
                );
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }

    Err("IMAP login failed".into())
}

fn should_retry_imap_login(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    if message.contains("authenticationfailed")
        || message.contains("authentication failed")
        || message.contains("invalid credentials")
        || message.contains("invalid login")
        || message.contains("bad credentials")
        || (message.contains("password") && message.contains("incorrect"))
    {
        return false;
    }

    message.contains("login error")
        || message.contains("no response")
        || message.contains("temporar")
        || message.contains("try again")
        || message.contains("rate")
        || message.contains("throttl")
        || message.contains("too many")
        || message.contains("timeout")
}

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECS);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("failed to resolve {host}:{port}: {e}"))?;
    let mut last_error = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                return Ok(stream);
            }
            Err(e) => last_error = Some(e),
        }
    }
    Err(format!(
        "failed to connect to {host}:{port}: {}",
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no resolved address".into())
    ))
}

fn imap_list_folders<T: Read + Write>(
    session: &mut imap::Session<T>,
    account_id: &str,
) -> Result<Vec<MailFolder>, String> {
    let names = session
        .list(None, Some("*"))
        .map_err(|e| format!("IMAP LIST failed: {e}"))?;
    let now = now_ts();
    Ok(names
        .iter()
        .map(|name| {
            let raw_name = name.name().to_string();
            MailFolder {
                account_id: account_id.to_string(),
                display_name: decode_imap_modified_utf7(&raw_name),
                name: raw_name,
                delimiter: name.delimiter().map(ToOwned::to_owned),
                flags: name
                    .attributes()
                    .iter()
                    .map(|attr| format!("{attr:?}"))
                    .collect(),
                uid_validity: None,
                uid_next: None,
                total: None,
                unread: None,
                updated_at: now,
            }
        })
        .collect())
}

fn imap_unread_count<T: Read + Write>(
    session: &mut imap::Session<T>,
    _folder: &str,
) -> Option<u32> {
    // Use UID SEARCH UNSEEN for the unread *count* of the currently
    // selected/examined mailbox (caller always EXAMINEs first).
    //
    // STATUS (UNSEEN) via the imap 2.4 crate routes attributes through the
    // unsolicited mpsc channel rather than the returned Mailbox. On some
    // Outlook + proxy paths that left the stream desynced (tag assert panics
    // on the next command). SEARCH is slightly chattier but protocol-stable.
    session
        .uid_search("UNSEEN")
        .ok()
        .map(|ids| ids.len() as u32)
}

/// Select the newest `limit` UIDs at `offset` without a full-folder `SEARCH ALL`
/// when possible. Uses a high UID window near `uid_next`, expanding as needed,
/// and only falls back to `SEARCH ALL` for sparse UID spaces or deep offsets.
fn imap_page_uids_newest_first<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid_next: Option<u32>,
    exists: u32,
    offset: usize,
    limit: usize,
) -> Result<(Vec<u32>, bool), String> {
    if exists == 0 || limit == 0 {
        return Ok((Vec::new(), false));
    }
    let need = offset.saturating_add(limit);

    if let Some(uid_next) = uid_next.filter(|u| *u > 1) {
        // Request a generous high-UID window first (gaps mean we may need more).
        let mut window = need.saturating_mul(4).max(need + 64).min(10_000);
        for _ in 0..4 {
            let start = uid_next.saturating_sub(window as u32).max(1);
            let mut uids = session
                .uid_search(format!("UID {start}:*"))
                .map_err(|e| format!("IMAP UID SEARCH range failed: {e}"))?
                .into_iter()
                .collect::<Vec<_>>();
            uids.sort_unstable();
            if uids.len() >= need || start == 1 {
                let total_in_window = uids.len();
                let page: Vec<u32> = uids
                    .iter()
                    .rev()
                    .skip(offset)
                    .take(limit)
                    .copied()
                    .collect();
                // When start==1 the window covers the whole mailbox UID space
                // from 1..uid_next. Otherwise older UIDs may still exist.
                let has_more = if page.is_empty() {
                    false
                } else if start == 1 {
                    offset.saturating_add(page.len()) < total_in_window
                } else {
                    offset.saturating_add(page.len()) < total_in_window
                        || (exists as usize) > offset.saturating_add(page.len())
                };
                let mut page = page;
                page.sort_unstable();
                return Ok((page, has_more));
            }
            // Expand window and retry.
            window = window.saturating_mul(2).min(50_000);
        }
    }

    // Fallback: full SEARCH ALL (slow on large folders).
    let mut uids = session
        .uid_search("ALL")
        .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
        .into_iter()
        .collect::<Vec<_>>();
    uids.sort_unstable();
    let total_uids = uids.len();
    let mut fetch_uids = uids
        .iter()
        .rev()
        .skip(offset)
        .take(limit)
        .copied()
        .collect::<Vec<_>>();
    let has_more = offset.saturating_add(fetch_uids.len()) < total_uids;
    fetch_uids.sort_unstable();
    Ok((fetch_uids, has_more))
}

fn imap_recent_uids_for_limit<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid_next: Option<u32>,
    exists: u32,
    limit: usize,
) -> Result<Vec<u32>, String> {
    let (uids, _) = imap_page_uids_newest_first(session, uid_next, exists, 0, limit)?;
    Ok(uids)
}

fn imap_sync_folder<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    offset: u32,
    limit: u32,
    include_bodies: bool,
) -> Result<(MailFolder, Vec<MailMessageCached>, bool), String> {
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let unread = imap_unread_count(session, folder);
    let account_id = &account.config.session_id;
    let mut folder_info = MailFolder {
        account_id: account_id.clone(),
        name: folder.to_string(),
        display_name: decode_imap_modified_utf7(folder),
        delimiter: None,
        flags: mailbox.flags.iter().map(|flag| flag.to_string()).collect(),
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        total: Some(mailbox.exists),
        unread,
        updated_at: now_ts(),
    };

    let offset = offset as usize;
    let limit = limit.max(1).min(2000) as usize;
    let (fetch_uids, has_more) =
        imap_page_uids_newest_first(session, mailbox.uid_next, mailbox.exists, offset, limit)?;
    if fetch_uids.is_empty() {
        folder_info.updated_at = now_ts();
        return Ok((folder_info, Vec::new(), false));
    }

    let mut messages =
        imap_fetch_messages_for_uids(session, account, folder, &fetch_uids, include_bodies)?;
    messages.sort_by(|a, b| {
        b.header
            .date_ts
            .cmp(&a.header.date_ts)
            .then(b.header.uid.cmp(&a.header.uid))
    });
    Ok((folder_info, messages, has_more))
}

fn imap_sync_folder_incremental<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    state: FolderSyncState,
    limit: u32,
    include_bodies: bool,
) -> Result<(MailFolder, Vec<MailMessageCached>), String> {
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let unread = imap_unread_count(session, folder);
    let account_id = &account.config.session_id;
    let folder_info = MailFolder {
        account_id: account_id.clone(),
        name: folder.to_string(),
        display_name: decode_imap_modified_utf7(folder),
        delimiter: None,
        flags: mailbox.flags.iter().map(|flag| flag.to_string()).collect(),
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        total: Some(mailbox.exists),
        unread,
        updated_at: now_ts(),
    };

    let limit = limit.max(1).min(2000) as usize;
    let same_uid_validity = state.max_uid > 0
        && (state.uid_validity.is_none()
            || mailbox.uid_validity.is_none()
            || state.uid_validity == mailbox.uid_validity);
    let mut fetch_uids = if same_uid_validity {
        let start_uid = state.max_uid.saturating_add(1);
        let mut uids = session
            .uid_search(format!("UID {start_uid}:*"))
            .map_err(|e| format!("IMAP UID SEARCH incremental failed: {e}"))?
            .into_iter()
            .filter(|uid| *uid > state.max_uid)
            .collect::<Vec<_>>();
        uids.sort_unstable();
        uids.into_iter().take(limit).collect::<Vec<_>>()
    } else {
        imap_recent_uids_for_limit(session, mailbox.uid_next, mailbox.exists, limit)?
    };
    fetch_uids.sort_unstable();
    if fetch_uids.is_empty() {
        return Ok((folder_info, Vec::new()));
    }

    let mut messages =
        imap_fetch_messages_for_uids(session, account, folder, &fetch_uids, include_bodies)?;
    messages.sort_by(|a, b| {
        b.header
            .date_ts
            .cmp(&a.header.date_ts)
            .then(b.header.uid.cmp(&a.header.uid))
    });
    Ok((folder_info, messages))
}

fn imap_fetch_messages_for_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    fetch_uids: &[u32],
    include_bodies: bool,
) -> Result<Vec<MailMessageCached>, String> {
    if fetch_uids.is_empty() {
        return Ok(Vec::new());
    }
    let account_id = &account.config.session_id;
    let uid_set = uid_set_string(fetch_uids);
    let fetches = session
        .uid_fetch(
            &uid_set,
            "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])",
        )
        .map_err(|e| format!("IMAP UID FETCH headers failed: {e}"))?;
    let mut messages = Vec::new();
    for fetch in fetches.iter() {
        if let Some(message) = parse_fetch_header(account_id, folder, fetch) {
            messages.push(message);
        }
    }
    messages.sort_by(|a, b| {
        a.header
            .date_ts
            .cmp(&b.header.date_ts)
            .then(a.header.uid.cmp(&b.header.uid))
    });

    let body_limit = account.config.cache.body_recent_limit as usize;
    if include_bodies && account.config.cache.enabled && body_limit > 0 {
        let body_uids = fetch_uids
            .iter()
            .rev()
            .take(body_limit.min(fetch_uids.len()))
            .copied()
            .collect::<Vec<_>>();
        let mut body_uids = body_uids;
        body_uids.sort_unstable();
        let body_uid_set = uid_set_string(&body_uids);
        let raw_limit = account
            .config
            .cache
            .body_max_bytes
            .max(1024)
            .min(10 * 1024 * 1024) as usize;
        let body_query = format!("(UID RFC822.SIZE BODY.PEEK[]<0.{raw_limit}>)");
        let body_fetches = session
            .uid_fetch(&body_uid_set, &body_query)
            .map_err(|e| format!("IMAP UID FETCH bodies failed: {e}"))?;
        let mut bodies = HashMap::new();
        for fetch in body_fetches.iter() {
            if let Some(uid) = fetch.uid {
                if let Some(body) = fetch.body() {
                    save_raw_message(account, folder, uid, body)?;
                    bodies.insert(
                        uid,
                        parse_body_message(account_id, folder, uid, fetch.size, body, raw_limit),
                    );
                }
            }
        }
        for message in &mut messages {
            if let Some(body) = bodies.remove(&message.header.uid) {
                merge_body(message, body);
            }
        }
    }

    Ok(messages)
}

fn imap_fetch_body<T: Read + Write>(
    session: &mut imap::Session<T>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
) -> Result<MailMessageCached, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let raw_limit = account
        .config
        .cache
        .body_max_bytes
        .max(1024)
        .min(10 * 1024 * 1024) as usize;
    let query = format!(
        "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER] BODY.PEEK[]<0.{raw_limit}>)"
    );
    let fetches = session
        .uid_fetch(uid.to_string(), query)
        .map_err(|e| format!("IMAP UID FETCH body failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let mut message = parse_fetch_header(&account.config.session_id, folder, fetch)
        .unwrap_or_else(|| empty_cached_message(&account.config.session_id, folder, uid));
    if let Some(body) = fetch.body() {
        save_raw_message(account, folder, uid, body)?;
        let parsed = parse_body_message(
            &account.config.session_id,
            folder,
            uid,
            fetch.size,
            body,
            raw_limit,
        );
        merge_body(&mut message, parsed);
    }
    Ok(message)
}

fn save_raw_message(
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    body: &[u8],
) -> Result<(), String> {
    let Some(root) = account
        .config
        .cache
        .save_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let folder_component = sanitize_path_component(folder);
    let account_component = sanitize_path_component(&account.config.session_id);
    let dir = Path::new(root)
        .join(account_component)
        .join(folder_component);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create mail save directory: {e}"))?;
    let path = dir.join(format!("{uid}.eml"));
    if path.exists() {
        return Ok(());
    }
    write_new_file(&path, body).map_err(|e| format!("failed to save fetched email: {e}"))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)
}

fn sanitize_path_component(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() {
        "_".into()
    } else {
        cleaned
    }
}

fn imap_mark_read<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
) -> Result<usize, String> {
    if uids.is_empty() {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_set = uid_set_string(uids);
    session
        .uid_store(uid_set, "+FLAGS.SILENT (\\Seen)")
        .map_err(|e| format!("IMAP UID STORE \\Seen failed: {e}"))?;
    Ok(uids.len())
}

fn imap_set_flags<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<usize, String> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_set = uid_set_string(uids);
    if !add.is_empty() {
        let query = format!("+FLAGS.SILENT ({})", add.join(" "));
        session
            .uid_store(&uid_set, &query)
            .map_err(|e| format!("IMAP UID STORE +FLAGS failed: {e}"))?;
    }
    if !remove.is_empty() {
        let query = format!("-FLAGS.SILENT ({})", remove.join(" "));
        session
            .uid_store(&uid_set, &query)
            .map_err(|e| format!("IMAP UID STORE -FLAGS failed: {e}"))?;
    }
    Ok(uids.len())
}

fn imap_move_messages<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    target: &str,
) -> Result<usize, String> {
    if uids.is_empty() {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_set = uid_set_string(uids);
    // Prefer server-side MOVE (RFC 6851). Servers without the MOVE capability
    // fall back to COPY + \Deleted + EXPUNGE. uid_expunge (UIDPLUS) only removes
    // the copied UIDs; plain EXPUNGE is the last resort and clears every
    // \Deleted message in the mailbox.
    if let Err(move_err) = session.uid_mv(&uid_set, target) {
        session.uid_copy(&uid_set, target).map_err(|e| {
            format!("IMAP UID COPY to {target} failed: {e} (after MOVE error: {move_err})")
        })?;
        session
            .uid_store(&uid_set, "+FLAGS.SILENT (\\Deleted)")
            .map_err(|e| format!("IMAP UID STORE \\Deleted failed: {e}"))?;
        if session.uid_expunge(&uid_set).is_err() {
            session
                .expunge()
                .map_err(|e| format!("IMAP EXPUNGE failed: {e}"))?;
        }
    }
    Ok(uids.len())
}

fn imap_copy_messages<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    target: &str,
) -> Result<usize, String> {
    if uids.is_empty() {
        return Ok(0);
    }
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_set = uid_set_string(uids);
    session
        .uid_copy(&uid_set, target)
        .map_err(|e| format!("IMAP UID COPY to {target} failed: {e}"))?;
    Ok(uids.len())
}

fn imap_delete_messages<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uids: &[u32],
    all: bool,
) -> Result<usize, String> {
    session
        .select(folder)
        .map_err(|e| format!("IMAP SELECT {folder} failed: {e}"))?;
    let uid_list: Vec<u32> = if all {
        session
            .uid_search("ALL")
            .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
            .into_iter()
            .collect()
    } else {
        uids.to_vec()
    };
    if uid_list.is_empty() {
        return Ok(0);
    }
    let uid_set = uid_set_string(&uid_list);
    session
        .uid_store(&uid_set, "+FLAGS.SILENT (\\Deleted)")
        .map_err(|e| format!("IMAP UID STORE \\Deleted failed: {e}"))?;
    if session.uid_expunge(&uid_set).is_err() {
        session
            .expunge()
            .map_err(|e| format!("IMAP EXPUNGE failed: {e}"))?;
    }
    Ok(uid_list.len())
}

fn imap_fetch_raw<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|e| format!("IMAP UID FETCH raw failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let body = fetch
        .body()
        .ok_or_else(|| format!("message UID {uid} did not include a body"))?;
    Ok(body.to_vec())
}

fn imap_download_attachment<T: Read + Write>(
    session: &mut imap::Session<T>,
    _account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    attachment_index: usize,
    target_path: &str,
) -> Result<MailDownloadAttachmentResult, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|e| format!("IMAP UID FETCH attachment failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found in {folder}"))?;
    let body = fetch
        .body()
        .ok_or_else(|| format!("message UID {uid} did not include a body"))?;
    let attachment = extract_attachment(body, attachment_index)?;
    let path = std::path::PathBuf::from(target_path);
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create attachment folder: {e}"))?;
    }
    std::fs::write(&path, &attachment.bytes)
        .map_err(|e| format!("failed to write attachment: {e}"))?;
    Ok(MailDownloadAttachmentResult {
        path: path.to_string_lossy().to_string(),
        name: attachment.name,
        content_type: attachment.content_type,
        size: attachment.bytes.len(),
    })
}

fn parse_fetch_header(
    account_id: &str,
    folder: &str,
    fetch: &imap::types::Fetch,
) -> Option<MailMessageCached> {
    let uid = fetch.uid?;
    let header = fetch.header().unwrap_or_default();
    let parsed = MessageParser::default().parse(header);
    let flags = fetch.flags().iter().map(|flag| flag.to_string()).collect();
    let fallback_date = fetch.internal_date().map(|d| d.timestamp());
    let (message_id, subject, from, to, cc, date_ts) = match parsed {
        Some(message) => (
            message.message_id().map(clean_message_id),
            message.subject().unwrap_or("").to_string(),
            address_list(message.from()).into_iter().next(),
            address_list(message.to()),
            address_list(message.cc()),
            message.date().map(|d| d.to_timestamp()).or(fallback_date),
        ),
        None => (
            None,
            String::new(),
            None,
            Vec::new(),
            Vec::new(),
            fallback_date,
        ),
    };
    Some(MailMessageCached {
        header: MailMessageHeader {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            uid,
            message_id,
            subject,
            from,
            to,
            cc,
            date_ts,
            flags,
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: fetch.size,
            body_cached: false,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
    })
}

fn parse_body_message(
    account_id: &str,
    folder: &str,
    uid: u32,
    raw_size: Option<u32>,
    body: &[u8],
    max_bytes: usize,
) -> MailMessageCached {
    match MessageParser::default().parse(body) {
        Some(message) => {
            let attachments = message
                .attachments()
                .map(|part| attachment_info(part))
                .collect::<Vec<_>>();
            let text = message
                .body_text(0)
                .map(|s| truncate_utf8_bytes(s.as_ref(), max_bytes));
            let html = message.body_html(0).map(|s| {
                // Thunderbird-style: rewrite embedded cid: images to data: URLs so
                // the reader can show them without a network fetch. Remote http(s)
                // images stay as-is and are gated by the frontend privacy toggle.
                let rewritten = rewrite_cid_images_in_html(&message, s.as_ref());
                let limit = rewritten
                    .len()
                    .max(max_bytes)
                    .min(MAX_EMBEDDED_BODY_BYTES);
                truncate_utf8_bytes(&rewritten, limit)
            });
            MailMessageCached {
                header: MailMessageHeader {
                    account_id: account_id.to_string(),
                    folder: folder.to_string(),
                    uid,
                    message_id: message.message_id().map(clean_message_id),
                    subject: message.subject().unwrap_or("").to_string(),
                    from: address_list(message.from()).into_iter().next(),
                    to: address_list(message.to()),
                    cc: address_list(message.cc()),
                    date_ts: message.date().map(|d| d.to_timestamp()),
                    flags: Vec::new(),
                    has_attachments: !attachments.is_empty(),
                    attachment_count: attachments.len(),
                    attachments,
                    snippet: message
                        .body_preview(240)
                        .map(|s| normalize_preview(s.as_ref())),
                    raw_size,
                    body_cached: true,
                },
                body_text: text,
                body_html: html,
                body_cached_at: Some(now_ts()),
            }
        }
        None => {
            let text = truncate_utf8_bytes(&String::from_utf8_lossy(body), max_bytes);
            MailMessageCached {
                header: MailMessageHeader {
                    account_id: account_id.to_string(),
                    folder: folder.to_string(),
                    uid,
                    message_id: None,
                    subject: String::new(),
                    from: None,
                    to: Vec::new(),
                    cc: Vec::new(),
                    date_ts: None,
                    flags: Vec::new(),
                    has_attachments: false,
                    attachment_count: 0,
                    attachments: Vec::new(),
                    snippet: Some(normalize_preview(&text)),
                    raw_size,
                    body_cached: true,
                },
                body_text: Some(text),
                body_html: None,
                body_cached_at: Some(now_ts()),
            }
        }
    }
}

fn merge_body(target: &mut MailMessageCached, body: MailMessageCached) {
    if target.header.message_id.is_none() {
        target.header.message_id = body.header.message_id;
    }
    if target.header.subject.is_empty() {
        target.header.subject = body.header.subject;
    }
    if target.header.from.is_none() {
        target.header.from = body.header.from;
    }
    if target.header.to.is_empty() {
        target.header.to = body.header.to;
    }
    if target.header.cc.is_empty() {
        target.header.cc = body.header.cc;
    }
    if target.header.date_ts.is_none() {
        target.header.date_ts = body.header.date_ts;
    }
    target.header.has_attachments = body.header.has_attachments;
    target.header.attachment_count = body.header.attachment_count;
    target.header.attachments = body.header.attachments;
    target.header.snippet = body.header.snippet;
    target.header.raw_size = body.header.raw_size.or(target.header.raw_size);
    target.header.body_cached = true;
    target.body_text = body.body_text;
    target.body_html = body.body_html;
    target.body_cached_at = body.body_cached_at;
}

fn empty_cached_message(account_id: &str, folder: &str, uid: u32) -> MailMessageCached {
    MailMessageCached {
        header: MailMessageHeader {
            account_id: account_id.to_string(),
            folder: folder.to_string(),
            uid,
            message_id: None,
            subject: String::new(),
            from: None,
            to: Vec::new(),
            cc: Vec::new(),
            date_ts: None,
            flags: Vec::new(),
            has_attachments: false,
            attachment_count: 0,
            attachments: Vec::new(),
            snippet: None,
            raw_size: None,
            body_cached: false,
        },
        body_text: None,
        body_html: None,
        body_cached_at: None,
    }
}

fn send_smtp(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<MailSendResult, String> {
    let message = build_send_message(account, request)?;
    let transport = build_smtp_transport(account, runtime)?;
    let response = transport
        .mailer
        .send(&message)
        .map_err(|e| format!("SMTP send failed: {e}"))?;
    Ok(MailSendResult {
        accepted: true,
        response: format!("{response:?}"),
    })
}

fn test_smtp(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<(), String> {
    let transport = build_smtp_transport(account, runtime)?;
    let connected = transport
        .mailer
        .test_connection()
        .map_err(|e| format!("SMTP test failed: {e}"))?;
    if connected {
        Ok(())
    } else {
        Err("SMTP test did not establish a connection".into())
    }
}

fn build_smtp_transport(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<MailSmtpTransport, String> {
    let host = account.config.smtp.host.trim();
    let (connect_host, connect_port, forward_task) =
        mail_effective_endpoint(account, host, account.config.smtp.port, runtime)?;
    let mut builder = SmtpTransport::builder_dangerous(connect_host)
        .port(connect_port)
        .timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .credentials(Credentials::new(
            account.smtp_username.clone(),
            account.smtp_password.clone(),
        ));
    if account.auth_mode == MailAuthMode::OAuth2 {
        builder = builder.authentication(vec![Mechanism::Xoauth2]);
    }
    builder = match account.config.smtp.security {
        MailConnectionSecurity::Tls => {
            let params = TlsParameters::new(host.to_string())
                .map_err(|e| format!("SMTP TLS parameters failed: {e}"))?;
            builder.tls(Tls::Wrapper(params))
        }
        MailConnectionSecurity::Starttls => {
            let params = TlsParameters::new(host.to_string())
                .map_err(|e| format!("SMTP STARTTLS parameters failed: {e}"))?;
            builder.tls(Tls::Required(params))
        }
        MailConnectionSecurity::None => builder.tls(Tls::None),
    };
    Ok(MailSmtpTransport {
        mailer: builder.build(),
        forward_task,
    })
}

fn build_send_message(
    account: &ResolvedMailAccount,
    request: &MailSendRequest,
) -> Result<Message, String> {
    let from = Mailbox::new(
        account.config.display_name.clone().and_then(non_empty),
        account
            .config
            .email_address
            .parse()
            .map_err(|e| format!("invalid from address: {e}"))?,
    );
    let mut builder = Message::builder()
        .from(from)
        .subject(request.subject.trim());
    if let Some(reply_to) = account
        .config
        .reply_to
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder = builder.reply_to(parse_mailbox(reply_to)?);
    }
    for to in &request.to {
        builder = builder.to(parse_mailbox(to)?);
    }
    for cc in &request.cc {
        builder = builder.cc(parse_mailbox(cc)?);
    }
    for bcc in &request.bcc {
        builder = builder.bcc(parse_mailbox(bcc)?);
    }

    let body = build_send_body_part(request)?;
    let attachments = read_send_attachments(&request.attachments)?;
    let has_inline = attachments.iter().any(|attachment| attachment.inline);
    let has_regular = attachments.iter().any(|attachment| !attachment.inline);

    if has_inline {
        let related = build_related_body(
            body,
            attachments.iter().filter(|attachment| attachment.inline),
        )?;
        if has_regular {
            let mut mixed = MultiPart::mixed().multipart(related);
            for attachment in attachments.iter().filter(|attachment| !attachment.inline) {
                mixed = mixed.singlepart(regular_attachment_part(attachment));
            }
            builder
                .multipart(mixed)
                .map_err(|e| format!("failed to build email body: {e}"))
        } else {
            builder
                .multipart(related)
                .map_err(|e| format!("failed to build email body: {e}"))
        }
    } else if has_regular {
        let mut mixed = add_body_part_to_multipart(MultiPart::mixed().build(), body);
        for attachment in &attachments {
            mixed = mixed.singlepart(regular_attachment_part(attachment));
        }
        builder
            .multipart(mixed)
            .map_err(|e| format!("failed to build email body: {e}"))
    } else {
        match body {
            SendBodyPart::Single(part) => builder
                .singlepart(part)
                .map_err(|e| format!("failed to build email body: {e}")),
            SendBodyPart::Multi(part) => builder
                .multipart(part)
                .map_err(|e| format!("failed to build email body: {e}")),
        }
    }
}

struct ResolvedSendAttachment {
    name: String,
    content_type: ContentType,
    bytes: Vec<u8>,
    inline: bool,
    content_id: Option<String>,
}

enum SendBodyPart {
    Single(SinglePart),
    Multi(MultiPart),
}

fn build_send_body_part(request: &MailSendRequest) -> Result<SendBodyPart, String> {
    match (&request.text_body, &request.html_body) {
        (Some(text), Some(html)) => Ok(SendBodyPart::Multi(MultiPart::alternative_plain_html(
            text.clone(),
            html.clone(),
        ))),
        (Some(text), None) => Ok(SendBodyPart::Single(SinglePart::plain(text.clone()))),
        (None, Some(html)) => Ok(SendBodyPart::Single(SinglePart::html(html.clone()))),
        (None, None) => Err("email body is required".into()),
    }
}

fn add_body_part_to_multipart(multipart: MultiPart, body: SendBodyPart) -> MultiPart {
    match body {
        SendBodyPart::Single(part) => multipart.singlepart(part),
        SendBodyPart::Multi(part) => multipart.multipart(part),
    }
}

fn build_related_body<'a>(
    body: SendBodyPart,
    inline_attachments: impl Iterator<Item = &'a ResolvedSendAttachment>,
) -> Result<MultiPart, String> {
    let mut related = add_body_part_to_multipart(MultiPart::related().build(), body);
    for attachment in inline_attachments {
        let content_id = attachment.content_id.as_deref().ok_or_else(|| {
            format!(
                "inline attachment {} is missing a Content-ID",
                attachment.name
            )
        })?;
        related = related.singlepart(
            Attachment::new_inline_with_name(content_id.to_string(), attachment.name.clone())
                .body(attachment.bytes.clone(), attachment.content_type.clone()),
        );
    }
    Ok(related)
}

fn regular_attachment_part(attachment: &ResolvedSendAttachment) -> SinglePart {
    Attachment::new(attachment.name.clone())
        .body(attachment.bytes.clone(), attachment.content_type.clone())
}

fn read_send_attachments(
    attachments: &[MailSendAttachment],
) -> Result<Vec<ResolvedSendAttachment>, String> {
    attachments
        .iter()
        .enumerate()
        .map(|(index, attachment)| {
            let raw_path = attachment.path.trim();
            if raw_path.is_empty() {
                return Err(format!("attachment #{} path is required", index + 1));
            }
            let path = Path::new(raw_path);
            let bytes = std::fs::read(path)
                .map_err(|e| format!("failed to read attachment {}: {e}", path.display()))?;
            let name = attachment
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| format!("attachment-{}", index + 1));
            Ok(ResolvedSendAttachment {
                name,
                content_type: attachment_content_type(attachment.content_type.as_deref()),
                bytes,
                inline: attachment.inline,
                content_id: attachment
                    .content_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned),
            })
        })
        .collect()
}

fn attachment_content_type(value: Option<&str>) -> ContentType {
    let fallback = "application/octet-stream";
    let candidate = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    ContentType::parse(candidate).unwrap_or_else(|_| {
        ContentType::parse(fallback).expect("application/octet-stream content type is valid")
    })
}

fn parse_mailbox(input: &str) -> Result<Mailbox, String> {
    input
        .trim()
        .parse()
        .map_err(|e| format!("invalid email address '{input}': {e}"))
}

fn validate_send_request(request: &MailSendRequest) -> Result<(), String> {
    if request.to.is_empty() && request.cc.is_empty() && request.bcc.is_empty() {
        return Err("at least one recipient is required".into());
    }
    if request.subject.trim().is_empty() {
        return Err("email subject is required".into());
    }
    if request
        .text_body
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
        && request
            .html_body
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err("email body is required".into());
    }
    for (index, attachment) in request.attachments.iter().enumerate() {
        if attachment.path.trim().is_empty() {
            return Err(format!("attachment #{} path is required", index + 1));
        }
        if attachment.inline {
            let content_id = attachment
                .content_id
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if content_id.is_empty() {
                return Err(format!(
                    "inline attachment #{} Content-ID is required",
                    index + 1
                ));
            }
            if content_id
                .chars()
                .any(|ch| matches!(ch, '<' | '>' | '\r' | '\n' | '\0'))
            {
                return Err(format!(
                    "inline attachment #{} Content-ID contains invalid characters",
                    index + 1
                ));
            }
            let content_type = attachment
                .content_type
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if !content_type
                .get(..content_type.len().min(6))
                .unwrap_or("")
                .eq_ignore_ascii_case("image/")
            {
                return Err(format!(
                    "inline attachment #{} must have an image/* content type",
                    index + 1
                ));
            }
        }
    }
    Ok(())
}

fn cache_sync_result(
    conn: &Connection,
    account_id: &str,
    folders: &[MailFolder],
    messages: &[MailMessageCached],
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in folders {
        reset_folder_if_uid_validity_changed(&tx, folder)?;
        upsert_folder(&tx, folder)?;
    }
    for message in messages {
        upsert_message(&tx, message)?;
    }
    prune_mail_cache(&tx, account_id, folder, cache)?;
    reindex_cached_contacts(&tx, account_id)?;
    tx.commit()
}

fn cache_sync_all_result(
    conn: &Connection,
    account_id: &str,
    folders: &[MailFolder],
    messages: &[MailMessageCached],
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in folders {
        reset_folder_if_uid_validity_changed(&tx, folder)?;
        upsert_folder(&tx, folder)?;
    }
    for message in messages {
        upsert_message(&tx, message)?;
    }
    for folder in folders {
        prune_mail_cache(&tx, account_id, &folder.name, cache)?;
    }
    reindex_cached_contacts(&tx, account_id)?;
    tx.commit()
}

fn reset_folder_if_uid_validity_changed(conn: &Connection, folder: &MailFolder) -> SqlResult<()> {
    let Some(next_uid_validity) = folder.uid_validity else {
        return Ok(());
    };
    let current: Option<Option<i64>> = conn
        .query_row(
            "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
            params![folder.account_id, folder.name],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(Some(current_uid_validity)) = current {
        if current_uid_validity as u32 != next_uid_validity {
            conn.execute(
                "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
                params![folder.account_id, folder.name],
            )?;
        }
    }
    Ok(())
}

fn upsert_folder(conn: &Connection, folder: &MailFolder) -> SqlResult<()> {
    let flags_json = serde_json::to_string(&folder.flags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_folders
         (account_id, name, delimiter, flags_json, uid_validity, uid_next, total, unread, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(account_id, name) DO UPDATE SET
            delimiter = excluded.delimiter,
            flags_json = excluded.flags_json,
            uid_validity = COALESCE(excluded.uid_validity, mail_folders.uid_validity),
            uid_next = COALESCE(excluded.uid_next, mail_folders.uid_next),
            total = COALESCE(excluded.total, mail_folders.total),
            unread = COALESCE(excluded.unread, mail_folders.unread),
            updated_at = excluded.updated_at",
        params![
            folder.account_id,
            folder.name,
            folder.delimiter,
            flags_json,
            folder.uid_validity,
            folder.uid_next,
            folder.total,
            folder.unread,
            folder.updated_at,
        ],
    )?;
    Ok(())
}

fn upsert_message(conn: &Connection, message: &MailMessageCached) -> SqlResult<()> {
    let header = &message.header;
    let to_json = serde_json::to_string(&header.to).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&header.cc).unwrap_or_else(|_| "[]".into());
    let flags_json = serde_json::to_string(&header.flags).unwrap_or_else(|_| "[]".into());
    let attachments_json =
        serde_json::to_string(&header.attachments).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_messages
         (account_id, folder, uid, message_id, subject, from_name, from_addr,
          to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
          attachments_json, snippet, body_text, body_html, body_cached_at, raw_size, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
            message_id = COALESCE(excluded.message_id, mail_messages.message_id),
            subject = CASE WHEN excluded.subject != '' THEN excluded.subject ELSE mail_messages.subject END,
            from_name = COALESCE(excluded.from_name, mail_messages.from_name),
            from_addr = COALESCE(excluded.from_addr, mail_messages.from_addr),
            to_json = CASE WHEN excluded.to_json != '[]' THEN excluded.to_json ELSE mail_messages.to_json END,
            cc_json = CASE WHEN excluded.cc_json != '[]' THEN excluded.cc_json ELSE mail_messages.cc_json END,
            date_ts = COALESCE(excluded.date_ts, mail_messages.date_ts),
            flags_json = CASE WHEN excluded.flags_json != '[]' THEN excluded.flags_json ELSE mail_messages.flags_json END,
            has_attachments = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.has_attachments = 1
                THEN excluded.has_attachments
                ELSE mail_messages.has_attachments
            END,
            attachment_count = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.attachment_count > 0
                THEN excluded.attachment_count
                ELSE mail_messages.attachment_count
            END,
            attachments_json = CASE WHEN excluded.attachments_json != '[]' THEN excluded.attachments_json ELSE mail_messages.attachments_json END,
            snippet = COALESCE(excluded.snippet, mail_messages.snippet),
            body_text = COALESCE(excluded.body_text, mail_messages.body_text),
            body_html = COALESCE(excluded.body_html, mail_messages.body_html),
            body_cached_at = COALESCE(excluded.body_cached_at, mail_messages.body_cached_at),
            raw_size = COALESCE(excluded.raw_size, mail_messages.raw_size),
            updated_at = excluded.updated_at",
        params![
            header.account_id,
            header.folder,
            header.uid,
            header.message_id,
            header.subject,
            header.from.as_ref().and_then(|a| a.name.clone()),
            header.from.as_ref().and_then(|a| a.address.clone()),
            to_json,
            cc_json,
            header.date_ts,
            flags_json,
            header.has_attachments as i64,
            header.attachment_count as i64,
            attachments_json,
            header.snippet,
            message.body_text,
            message.body_html,
            message.body_cached_at,
            header.raw_size,
            now_ts(),
        ],
    )?;
    Ok(())
}

fn contact_email(address: &MailAddress) -> Option<String> {
    let email = address.address.as_deref()?.trim().to_lowercase();
    if email.contains('@')
        && !email
            .chars()
            .any(|ch| matches!(ch, ' ' | '<' | '>' | ',' | ';'))
    {
        Some(email)
    } else {
        None
    }
}

fn clean_contact_name(address: &MailAddress) -> Option<String> {
    address
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
}

fn upsert_contact(
    conn: &Connection,
    account_id: &str,
    address: &MailAddress,
    seen_at: i64,
    message_count: i64,
    sent_count: i64,
    received_count: i64,
) -> SqlResult<bool> {
    let Some(email) = contact_email(address) else {
        return Ok(false);
    };
    let name = clean_contact_name(address);
    let now = now_ts();
    conn.execute(
        "INSERT INTO mail_contacts
         (account_id, email, name, first_seen_at, last_seen_at, message_count,
          sent_count, received_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account_id, email) DO UPDATE SET
            name = CASE
              WHEN excluded.name IS NOT NULL AND excluded.name != '' THEN excluded.name
              ELSE mail_contacts.name
            END,
            first_seen_at = MIN(mail_contacts.first_seen_at, excluded.first_seen_at),
            last_seen_at = MAX(mail_contacts.last_seen_at, excluded.last_seen_at),
            message_count = mail_contacts.message_count + excluded.message_count,
            sent_count = mail_contacts.sent_count + excluded.sent_count,
            received_count = mail_contacts.received_count + excluded.received_count,
            updated_at = excluded.updated_at",
        params![
            account_id,
            email,
            name,
            seen_at,
            message_count,
            sent_count,
            received_count,
            now,
        ],
    )?;
    Ok(true)
}

fn reindex_cached_contacts(conn: &Connection, account_id: &str) -> SqlResult<usize> {
    conn.execute(
        "DELETE FROM mail_contacts WHERE account_id = ?1",
        params![account_id],
    )?;

    let rows = {
        let mut stmt = conn.prepare(
            "SELECT from_name, from_addr, to_json, cc_json, date_ts
             FROM mail_messages
             WHERE account_id = ?1",
        )?;
        let mapped = stmt.query_map(params![account_id], |row| {
            let from_name: Option<String> = row.get(0)?;
            let from_addr: Option<String> = row.get(1)?;
            let from = if from_name.is_some() || from_addr.is_some() {
                Some(MailAddress {
                    name: from_name,
                    address: from_addr,
                })
            } else {
                None
            };
            let to_json: String = row.get(2)?;
            let cc_json: String = row.get(3)?;
            let date_ts: Option<i64> = row.get(4)?;
            Ok((
                from,
                serde_json::from_str::<Vec<MailAddress>>(&to_json).unwrap_or_default(),
                serde_json::from_str::<Vec<MailAddress>>(&cc_json).unwrap_or_default(),
                date_ts,
            ))
        })?;
        mapped.collect::<SqlResult<Vec<_>>>()?
    };

    for (from, to, cc, date_ts) in rows {
        let seen_at = date_ts.unwrap_or_else(now_ts);
        let mut seen = HashSet::new();
        for address in from.into_iter().chain(to.into_iter()).chain(cc.into_iter()) {
            let Some(email) = contact_email(&address) else {
                continue;
            };
            if !seen.insert(email) {
                continue;
            }
            upsert_contact(conn, account_id, &address, seen_at, 1, 0, 1)?;
        }
    }

    conn.query_row(
        "SELECT COUNT(*) FROM mail_contacts WHERE account_id = ?1",
        params![account_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
}

fn mailbox_to_contact(mailbox: Mailbox) -> MailAddress {
    MailAddress {
        name: mailbox.name,
        address: Some(mailbox.email.to_string()),
    }
}

fn upsert_sent_contacts(
    conn: &Connection,
    account_id: &str,
    request: &MailSendRequest,
) -> SqlResult<usize> {
    let mut changed = 0;
    let now = now_ts();
    let mut seen = HashSet::new();
    for raw in request
        .to
        .iter()
        .chain(request.cc.iter())
        .chain(request.bcc.iter())
    {
        let Ok(mailbox) = parse_mailbox(raw) else {
            continue;
        };
        let address = mailbox_to_contact(mailbox);
        let Some(email) = contact_email(&address) else {
            continue;
        };
        if !seen.insert(email) {
            continue;
        }
        if upsert_contact(conn, account_id, &address, now, 1, 1, 0)? {
            changed += 1;
        }
    }
    Ok(changed)
}

fn list_mail_drafts(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailDraft>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, id, to_json, cc_json, bcc_json, subject, text_body, html_body,
                attachments_json, reply_context_json, remote_draft_folder, remote_draft_uid,
                created_at, updated_at
         FROM mail_drafts
         WHERE account_id = ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![account_id], mail_draft_from_row)?;
    rows.collect()
}

fn save_mail_draft(
    conn: &Connection,
    account_id: &str,
    draft: MailDraftSaveRequest,
) -> SqlResult<MailDraft> {
    let id = draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_ts();
    let created_at = conn
        .query_row(
            "SELECT created_at FROM mail_drafts WHERE account_id = ?1 AND id = ?2",
            params![account_id, id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(now);
    let saved = MailDraft {
        id,
        account_id: account_id.to_string(),
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text_body: draft.text_body,
        html_body: draft.html_body,
        attachments: draft.attachments,
        reply_context: draft.reply_context,
        remote_draft_folder: draft.remote_draft_folder,
        remote_draft_uid: draft.remote_draft_uid,
        created_at,
        updated_at: now,
    };
    let to_json = serde_json::to_string(&saved.to).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&saved.cc).unwrap_or_else(|_| "[]".into());
    let bcc_json = serde_json::to_string(&saved.bcc).unwrap_or_else(|_| "[]".into());
    let attachments_json =
        serde_json::to_string(&saved.attachments).unwrap_or_else(|_| "[]".into());
    let reply_context_json = saved
        .reply_context
        .as_ref()
        .and_then(|context| serde_json::to_string(context).ok());
    conn.execute(
        "INSERT INTO mail_drafts
         (account_id, id, to_json, cc_json, bcc_json, subject, text_body, html_body,
          attachments_json, reply_context_json, remote_draft_folder, remote_draft_uid,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(account_id, id) DO UPDATE SET
            to_json = excluded.to_json,
            cc_json = excluded.cc_json,
            bcc_json = excluded.bcc_json,
            subject = excluded.subject,
            text_body = excluded.text_body,
            html_body = excluded.html_body,
            attachments_json = excluded.attachments_json,
            reply_context_json = excluded.reply_context_json,
            remote_draft_folder = excluded.remote_draft_folder,
            remote_draft_uid = excluded.remote_draft_uid,
            updated_at = excluded.updated_at",
        params![
            saved.account_id,
            saved.id,
            to_json,
            cc_json,
            bcc_json,
            saved.subject,
            saved.text_body,
            saved.html_body,
            attachments_json,
            reply_context_json,
            saved.remote_draft_folder,
            saved.remote_draft_uid,
            saved.created_at,
            saved.updated_at,
        ],
    )?;
    Ok(saved)
}

fn delete_mail_draft(conn: &Connection, account_id: &str, draft_id: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_drafts WHERE account_id = ?1 AND id = ?2",
        params![account_id, draft_id],
    )?;
    Ok(())
}

fn mail_draft_from_row(row: &rusqlite::Row<'_>) -> SqlResult<MailDraft> {
    let to_json: String = row.get(2)?;
    let cc_json: String = row.get(3)?;
    let bcc_json: String = row.get(4)?;
    let attachments_json: String = row.get(8)?;
    let reply_context_json: Option<String> = row.get(9)?;
    let remote_draft_uid: Option<i64> = row.get(11)?;
    Ok(MailDraft {
        account_id: row.get(0)?,
        id: row.get(1)?,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        cc: serde_json::from_str(&cc_json).unwrap_or_default(),
        bcc: serde_json::from_str(&bcc_json).unwrap_or_default(),
        subject: row.get(5)?,
        text_body: row.get(6)?,
        html_body: row.get(7)?,
        attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
        reply_context: reply_context_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok()),
        remote_draft_folder: row.get(10)?,
        remote_draft_uid: remote_draft_uid.map(|value| value.max(0) as u32),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn search_contacts(
    conn: &Connection,
    account_id: &str,
    query: &str,
    limit: u32,
) -> SqlResult<Vec<MailContactSuggestion>> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("%{}%", escape_like(&normalized));
    let prefix = format!("{}%", escape_like(&normalized));
    let recent_cutoff = now_ts() - 90 * 86_400;
    let mut stmt = conn.prepare(
        "SELECT name, email, last_seen_at, sent_count, received_count, message_count,
                (CASE WHEN lower(email) = ?3 THEN 400 ELSE 0 END
                 + CASE WHEN lower(email) LIKE ?4 ESCAPE '\\' THEN 260 ELSE 0 END
                 + CASE WHEN lower(COALESCE(name, '')) LIKE ?4 ESCAPE '\\' THEN 180 ELSE 0 END
                 + CASE WHEN last_seen_at >= ?5 THEN 40 ELSE 0 END
                 + sent_count * 20
                 + received_count * 6
                 + message_count * 4) AS score
         FROM mail_contacts
         WHERE account_id = ?1
           AND (lower(email) LIKE ?2 ESCAPE '\\'
                OR lower(COALESCE(name, '')) LIKE ?2 ESCAPE '\\')
         ORDER BY score DESC, last_seen_at DESC, email ASC
         LIMIT ?6",
    )?;
    let rows = stmt.query_map(
        params![
            account_id,
            like,
            normalized,
            prefix,
            recent_cutoff,
            limit as i64,
        ],
        |row| {
            let sent_count: i64 = row.get(3)?;
            Ok(MailContactSuggestion {
                name: row.get(0)?,
                email: row.get(1)?,
                last_seen_at: row.get(2)?,
                source: if sent_count > 0 { "sent" } else { "history" }.into(),
                score: row.get(6)?,
            })
        },
    )?;
    rows.collect()
}

fn prune_mail_cache(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    if cache.header_retention_days > 0 {
        let cutoff = now_ts() - (cache.header_retention_days as i64 * 86_400);
        conn.execute(
            "DELETE FROM mail_messages
             WHERE account_id = ?1 AND folder = ?2 AND date_ts IS NOT NULL AND date_ts < ?3",
            params![account_id, folder, cutoff],
        )?;
    }
    if cache.header_limit_per_folder > 0 {
        conn.execute(
            "DELETE FROM mail_messages
             WHERE rowid IN (
                SELECT rowid FROM mail_messages
                WHERE account_id = ?1 AND folder = ?2
                ORDER BY uid DESC
                LIMIT -1 OFFSET ?3
             )",
            params![account_id, folder, cache.header_limit_per_folder],
        )?;
    }
    if cache.body_recent_limit == 0 {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
        )?;
    } else {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2
               AND rowid NOT IN (
                 SELECT rowid FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2 AND body_cached_at IS NOT NULL
                 ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
                 LIMIT ?3
               )",
            params![account_id, folder, cache.body_recent_limit],
        )?;
    }
    Ok(())
}

fn list_cached_folders(conn: &Connection, account_id: &str) -> SqlResult<Vec<MailFolder>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, name, delimiter, flags_json, uid_validity, uid_next,
                total, unread, updated_at
         FROM mail_folders
         WHERE account_id = ?1
         ORDER BY CASE WHEN name = 'INBOX' THEN 0 ELSE 1 END, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let flags_json: String = row.get(3)?;
        let name: String = row.get(1)?;
        Ok(MailFolder {
            account_id: row.get(0)?,
            display_name: decode_imap_modified_utf7(&name),
            name,
            delimiter: row.get(2)?,
            flags: serde_json::from_str(&flags_json).unwrap_or_default(),
            uid_validity: row.get(4)?,
            uid_next: row.get(5)?,
            total: row.get(6)?,
            unread: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

fn cached_folder_sync_states(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<HashMap<String, FolderSyncState>> {
    let mut stmt = conn.prepare(
        "SELECT f.name, f.uid_validity, COALESCE(MAX(m.uid), 0)
         FROM mail_folders f
         LEFT JOIN mail_messages m
           ON m.account_id = f.account_id AND m.folder = f.name
         WHERE f.account_id = ?1
         GROUP BY f.name, f.uid_validity",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let name: String = row.get(0)?;
        let uid_validity: Option<i64> = row.get(1)?;
        let max_uid: i64 = row.get(2)?;
        Ok((
            name,
            FolderSyncState {
                max_uid: max_uid.max(0) as u32,
                uid_validity: uid_validity.map(|value| value as u32),
            },
        ))
    })?;
    let mut states = HashMap::new();
    for row in rows {
        let (name, state) = row?;
        states.insert(name, state);
    }
    Ok(states)
}

fn list_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    limit: u32,
    offset: u32,
) -> SqlResult<Vec<MailMessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2
         ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
         LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt.query_map(params![account_id, folder, limit, offset], row_to_header)?;
    rows.collect()
}

fn unread_cached_uids(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid, flags_json
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2",
    )?;
    let rows = stmt.query_map(params![account_id, folder], |row| {
        Ok((row.get::<_, i64>(0)? as u32, row.get::<_, String>(1)?))
    })?;
    let mut uids = Vec::new();
    for row in rows {
        let (uid, flags_json) = row?;
        let flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        if !flags_include_seen(&flags) {
            uids.push(uid);
        }
    }
    Ok(uids)
}

fn mark_cached_messages_read(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> SqlResult<()> {
    let mut changed = 0usize;
    for uid in uids {
        let flags_json: Option<String> = conn
            .query_row(
                "SELECT flags_json
                 FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params![account_id, folder, *uid as i64],
                |row| row.get(0),
            )
            .optional()?;
        let Some(flags_json) = flags_json else {
            continue;
        };
        let mut flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        if flags_include_seen(&flags) {
            continue;
        }
        flags.push("\\Seen".into());
        let next_flags_json = serde_json::to_string(&flags).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "UPDATE mail_messages
             SET flags_json = ?4, updated_at = ?5
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
            params![account_id, folder, *uid as i64, next_flags_json, now_ts()],
        )?;
        changed += 1;
    }
    if changed > 0 {
        conn.execute(
            "UPDATE mail_folders
             SET unread = CASE
               WHEN unread IS NULL THEN NULL
               WHEN unread <= ?3 THEN 0
               ELSE unread - ?3
             END,
             updated_at = ?4
             WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, changed as i64, now_ts()],
        )?;
    }
    Ok(())
}

fn flags_include_seen(flags: &[String]) -> bool {
    flags.iter().any(|flag| flag.eq_ignore_ascii_case("\\Seen"))
}

fn update_cached_flags(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> SqlResult<()> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(());
    }
    for uid in uids {
        let flags_json: Option<String> = conn
            .query_row(
                "SELECT flags_json
                 FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params![account_id, folder, *uid as i64],
                |row| row.get(0),
            )
            .optional()?;
        let Some(flags_json) = flags_json else {
            continue;
        };
        let mut flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        flags.retain(|flag| !remove.iter().any(|r| flag.eq_ignore_ascii_case(r)));
        for flag in add {
            if !flags
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(flag))
            {
                flags.push(flag.clone());
            }
        }
        let next_flags_json = serde_json::to_string(&flags).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "UPDATE mail_messages
             SET flags_json = ?4, updated_at = ?5
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
            params![account_id, folder, *uid as i64, next_flags_json, now_ts()],
        )?;
    }
    Ok(())
}

fn remove_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> SqlResult<()> {
    for uid in uids {
        conn.execute(
            "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
            params![account_id, folder, *uid as i64],
        )?;
    }
    Ok(())
}

fn purge_cached_folder(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<()> {
    // Remove the folder and its messages, plus any nested subfolders addressed
    // with the common IMAP hierarchy delimiters.
    conn.execute(
        "DELETE FROM mail_messages
         WHERE account_id = ?1 AND (folder = ?2 OR folder LIKE ?3 OR folder LIKE ?4)",
        params![
            account_id,
            folder,
            format!("{folder}/%"),
            format!("{folder}.%")
        ],
    )?;
    conn.execute(
        "DELETE FROM mail_folders
         WHERE account_id = ?1 AND (name = ?2 OR name LIKE ?3 OR name LIKE ?4)",
        params![
            account_id,
            folder,
            format!("{folder}/%"),
            format!("{folder}.%")
        ],
    )?;
    Ok(())
}

fn get_cached_body(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<MailMessageBody>> {
    conn.query_row(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, body_text, body_html
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
           AND body_cached_at IS NOT NULL
           AND (body_text IS NOT NULL OR body_html IS NOT NULL)",
        params![account_id, folder, uid],
        |row| {
            let mut header = row_to_header(row)?;
            let body_text: Option<String> = row.get(17)?;
            let body_html: Option<String> = row.get(18)?;
            header.body_cached = true;
            Ok(MailMessageBody {
                account_id: header.account_id,
                folder: header.folder,
                uid: header.uid,
                message_id: header.message_id,
                subject: header.subject,
                text: body_text,
                html: body_html,
                snippet: header.snippet,
                attachments: header.attachments,
                raw_size: header.raw_size,
                cached_at: row.get(16)?,
                source: "cache".into(),
            })
        },
    )
    .optional()
}

fn row_to_header(row: &rusqlite::Row<'_>) -> SqlResult<MailMessageHeader> {
    let to_json: String = row.get(7)?;
    let cc_json: String = row.get(8)?;
    let flags_json: String = row.get(10)?;
    let attachments_json: String = row.get(13)?;
    let from_name: Option<String> = row.get(5)?;
    let from_addr: Option<String> = row.get(6)?;
    let from = if from_name.is_some() || from_addr.is_some() {
        Some(MailAddress {
            name: from_name,
            address: from_addr,
        })
    } else {
        None
    };
    let body_cached_at: Option<i64> = row.get(16)?;
    Ok(MailMessageHeader {
        account_id: row.get(0)?,
        folder: row.get(1)?,
        uid: row.get::<_, i64>(2)? as u32,
        message_id: row.get(3)?,
        subject: row.get(4)?,
        from,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        cc: serde_json::from_str(&cc_json).unwrap_or_default(),
        date_ts: row.get(9)?,
        flags: serde_json::from_str(&flags_json).unwrap_or_default(),
        has_attachments: row.get::<_, i64>(11)? != 0,
        attachment_count: row.get::<_, i64>(12)? as usize,
        attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
        snippet: row.get(14)?,
        raw_size: row.get(15)?,
        body_cached: body_cached_at.is_some(),
    })
}

fn cached_to_body(message: MailMessageCached, source: &str) -> MailMessageBody {
    MailMessageBody {
        account_id: message.header.account_id,
        folder: message.header.folder,
        uid: message.header.uid,
        message_id: message.header.message_id,
        subject: message.header.subject,
        text: message.body_text,
        html: message.body_html,
        snippet: message.header.snippet,
        attachments: message.header.attachments,
        raw_size: message.header.raw_size,
        cached_at: message.body_cached_at,
        source: source.into(),
    }
}

fn merge_selected_folder(folders: &mut Vec<MailFolder>, selected: MailFolder) {
    if let Some(existing) = folders.iter_mut().find(|f| f.name == selected.name) {
        *existing = selected;
    } else {
        folders.push(selected);
    }
}

fn address_list(addr: Option<&ParsedAddress<'_>>) -> Vec<MailAddress> {
    addr.map(|addr| {
        addr.iter()
            .map(|item| MailAddress {
                name: item.name.as_ref().map(|v| v.to_string()),
                address: item.address.as_ref().map(|v| v.to_string()),
            })
            .collect()
    })
    .unwrap_or_default()
}

fn attachment_info(part: &mail_parser::MessagePart<'_>) -> MailAttachmentInfo {
    let size = match &part.body {
        PartType::Text(s) | PartType::Html(s) => Some(s.len()),
        PartType::Binary(b) | PartType::InlineBinary(b) => Some(b.len()),
        PartType::Message(message) => Some(message.raw_message.len()),
        PartType::Multipart(_) => None,
    };
    let content_type = part.content_type().map(|ct| match ct.c_subtype.as_ref() {
        Some(subtype) => format!("{}/{}", ct.c_type, subtype),
        None => ct.c_type.to_string(),
    });
    MailAttachmentInfo {
        name: part.attachment_name().map(ToOwned::to_owned),
        content_type,
        size,
    }
}

fn extract_attachment(
    body: &[u8],
    attachment_index: usize,
) -> Result<DownloadedMailAttachment, String> {
    let message = MessageParser::default()
        .parse(body)
        .ok_or_else(|| "failed to parse message attachments".to_string())?;
    let mut attachments = message.attachments();
    let part = attachments
        .nth(attachment_index)
        .ok_or_else(|| format!("attachment #{} not found", attachment_index + 1))?;
    let info = attachment_info(part);
    let bytes = match &part.body {
        PartType::Text(s) | PartType::Html(s) => s.as_ref().as_bytes().to_vec(),
        PartType::Binary(b) | PartType::InlineBinary(b) => b.as_ref().to_vec(),
        PartType::Message(message) => message.raw_message.to_vec(),
        PartType::Multipart(_) => {
            return Err("selected attachment is a multipart container".into());
        }
    };
    Ok(DownloadedMailAttachment {
        name: info.name,
        content_type: info.content_type,
        bytes,
    })
}

fn decode_imap_modified_utf7(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let rest = &input[index..];
        if !rest.starts_with('&') {
            let ch = rest.chars().next().unwrap_or_default();
            out.push(ch);
            index += ch.len_utf8();
            continue;
        }

        let after_amp = index + 1;
        let Some(relative_end) = input[after_amp..].find('-') else {
            out.push_str(rest);
            break;
        };
        let end = after_amp + relative_end;
        let encoded = &input[after_amp..end];
        if encoded.is_empty() {
            out.push('&');
            index = end + 1;
            continue;
        }

        match decode_imap_modified_utf7_segment(encoded) {
            Some(decoded) => out.push_str(&decoded),
            None => out.push_str(&input[index..=end]),
        }
        index = end + 1;
    }
    out
}

fn decode_imap_modified_utf7_segment(encoded: &str) -> Option<String> {
    let mut b64 = encoded.replace(',', "/");
    while b64.len() % 4 != 0 {
        b64.push('=');
    }
    let bytes = BASE64_STANDARD.decode(b64.as_bytes()).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).ok()
}

fn uid_set_string(uids: &[u32]) -> String {
    uids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn clean_message_id(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string()
}

/// Rewrite `src="cid:..."` / `src='cid:...'` references to data URLs using matching
/// MIME parts (Content-ID). Enables embedded images in the HTML reader without
/// requiring a separate attachment download round-trip.
fn rewrite_cid_images_in_html(message: &mail_parser::Message<'_>, html: &str) -> String {
    if !html.to_ascii_lowercase().contains("cid:") {
        return html.to_string();
    }

    let mut by_cid: HashMap<String, (String, Vec<u8>)> = HashMap::new();
    for part in &message.parts {
        let Some(raw_cid) = part.content_id() else {
            continue;
        };
        let cid = clean_message_id(raw_cid);
        if cid.is_empty() {
            continue;
        }
        let content_type = part
            .content_type()
            .map(|ct| match ct.c_subtype.as_ref() {
                Some(subtype) => format!("{}/{}", ct.c_type, subtype),
                None => ct.c_type.to_string(),
            })
            .unwrap_or_else(|| "application/octet-stream".into());
        // Only embed image/* parts — other cid targets (e.g. calendar) stay as cid:.
        if !content_type.to_ascii_lowercase().starts_with("image/") {
            continue;
        }
        let bytes = match &part.body {
            PartType::Binary(b) | PartType::InlineBinary(b) => b.as_ref().to_vec(),
            PartType::Text(s) | PartType::Html(s) => s.as_ref().as_bytes().to_vec(),
            PartType::Message(nested) => nested.raw_message.to_vec(),
            PartType::Multipart(_) => continue,
        };
        if bytes.is_empty() || bytes.len() > MAX_INLINE_CID_IMAGE_BYTES {
            continue;
        }
        by_cid.insert(cid.to_ascii_lowercase(), (content_type, bytes));
    }
    if by_cid.is_empty() {
        return html.to_string();
    }

    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let rest = &html[index..];
        let lower = rest.to_ascii_lowercase();
        let Some(rel_src) = lower.find("src=") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..rel_src + 4]);
        index += rel_src + 4;
        if index >= bytes.len() {
            break;
        }
        let quote = html.as_bytes()[index];
        let (quote_char, value_start) = if quote == b'"' || quote == b'\'' {
            (Some(quote as char), index + 1)
        } else {
            (None, index)
        };
        let value_end = match quote_char {
            Some(q) => html[value_start..]
                .find(q)
                .map(|n| value_start + n)
                .unwrap_or(html.len()),
            None => {
                let end_rel = html[value_start..]
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .unwrap_or(html[value_start..].len());
                value_start + end_rel
            }
        };
        let raw_src = &html[value_start..value_end];
        let cid_key = raw_src
            .trim()
            .strip_prefix("cid:")
            .or_else(|| raw_src.trim().strip_prefix("CID:"))
            .map(|v| clean_message_id(v).to_ascii_lowercase());
        if let Some(cid) = cid_key.as_ref() {
            if let Some((content_type, data)) = by_cid.get(cid) {
                let encoded = BASE64_STANDARD.encode(data);
                if let Some(q) = quote_char {
                    out.push(q);
                    out.push_str("data:");
                    out.push_str(content_type);
                    out.push_str(";base64,");
                    out.push_str(&encoded);
                    out.push(q);
                } else {
                    out.push_str("data:");
                    out.push_str(content_type);
                    out.push_str(";base64,");
                    out.push_str(&encoded);
                }
                index = if quote_char.is_some() {
                    value_end + 1
                } else {
                    value_end
                };
                continue;
            }
        }
        // Unmatched cid or non-cid src: copy through unchanged.
        if let Some(q) = quote_char {
            out.push(q);
            out.push_str(raw_src);
            out.push(q);
            index = value_end + 1;
        } else {
            out.push_str(raw_src);
            index = value_end;
        }
    }
    out
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn normalize_preview(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn default_true() -> bool {
    true
}

fn default_header_retention_days() -> u32 {
    30
}

fn default_header_limit_per_folder() -> u32 {
    2000
}

fn default_body_recent_limit() -> u32 {
    200
}

fn default_body_max_bytes() -> u32 {
    DEFAULT_BODY_MAX_BYTES as u32
}

fn default_sync_interval_minutes() -> u32 {
    5
}

fn default_max_fetch_per_sync() -> u32 {
    DEFAULT_MESSAGE_LIMIT as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_message() -> Vec<u8> {
        b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nDate: Tue, 30 Jun 2026 08:00:00 +0800\r\nMessage-ID: <sample@example.com>\r\nSubject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Taomni Mail.\r\n"
            .to_vec()
    }

    fn sample_attachment_message() -> Vec<u8> {
        b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nSubject: Attachment sample\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text.\r\n--b\r\nContent-Type: text/plain; name=\"report.txt\"\r\nContent-Disposition: attachment; filename=\"report.txt\"\r\n\r\nAttachment content.\r\n--b--\r\n"
            .to_vec()
    }

    fn sample_inline_image_message() -> Vec<u8> {
        // 1x1 PNG (68 bytes raw) base64-encoded for a multipart/related sample.
        b"From: Example Sender <sender@example.com>\r\n\
To: Receiver <receiver@example.com>\r\n\
Subject: Inline image sample\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"rel\"\r\n\
\r\n\
--rel\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Logo: <img src=\"cid:logo@inline.local\" alt=\"logo\"></p>\r\n\
--rel\r\n\
Content-Type: image/png; name=\"logo.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-ID: <logo@inline.local>\r\n\
Content-Disposition: inline; filename=\"logo.png\"\r\n\
\r\n\
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==\r\n\
--rel--\r\n"
            .to_vec()
    }

    #[test]
    fn should_list_remote_folders_only_when_refresh_or_cache_empty() {
        assert!(should_list_remote_folders(true, 0));
        assert!(should_list_remote_folders(true, 12));
        assert!(should_list_remote_folders(false, 0));
        assert!(!should_list_remote_folders(false, 3));
    }

    #[test]
    fn folders_for_header_sync_merges_selected_into_cached_base() {
        let base = vec![
            MailFolder {
                account_id: "acct".into(),
                name: "INBOX".into(),
                display_name: "INBOX".into(),
                delimiter: Some("/".into()),
                flags: vec![],
                uid_validity: Some(1),
                uid_next: Some(10),
                total: Some(9),
                unread: Some(2),
                updated_at: 1,
            },
            MailFolder {
                account_id: "acct".into(),
                name: "Sent".into(),
                display_name: "Sent".into(),
                delimiter: Some("/".into()),
                flags: vec![],
                uid_validity: Some(1),
                uid_next: Some(3),
                total: Some(2),
                unread: Some(0),
                updated_at: 1,
            },
        ];
        let selected = MailFolder {
            account_id: "acct".into(),
            name: "INBOX".into(),
            display_name: "INBOX".into(),
            delimiter: Some("/".into()),
            flags: vec!["\\HasNoChildren".into()],
            uid_validity: Some(1),
            uid_next: Some(15),
            total: Some(14),
            unread: Some(4),
            updated_at: 99,
        };
        let merged = folders_for_header_sync(base, selected);
        assert_eq!(merged.len(), 2);
        let inbox = merged.iter().find(|f| f.name == "INBOX").unwrap();
        assert_eq!(inbox.total, Some(14));
        assert_eq!(inbox.unread, Some(4));
        assert_eq!(inbox.updated_at, 99);
        assert!(merged.iter().any(|f| f.name == "Sent"));
    }

    #[test]
    fn network_fingerprint_is_direct_without_session_proxy() {
        assert_eq!(network_fingerprint(None), "direct");
        let none_kind = NetworkSettings {
            proxy_kind: "none".into(),
            ..NetworkSettings::default()
        };
        // Fingerprint still records kind=none (prepare_mail_network maps this to
        // direct routing); the important policy is prepare_mail_network never
        // loads AppProxyConfig.
        assert!(network_fingerprint(Some(&none_kind)).starts_with("none|"));
    }

    /// Regression: OAuth refresh used to call `reqwest::blocking` on the async
    /// command worker. In debug builds that panics when dropping a nested
    /// Runtime. Isolation must succeed while a Tokio runtime is current.
    #[tokio::test]
    async fn run_outside_tokio_context_avoids_nested_runtime_panic() {
        let value = run_outside_tokio_context(|| {
            // Mimic reqwest::blocking's debug enter probe: build+drop a shell
            // runtime on the worker thread. Must not see an outer enter().
            let _shell = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("shell runtime");
            42
        })
        .expect("isolated worker");
        assert_eq!(value, 42);
    }

    #[test]
    fn mail_imap_fingerprint_changes_when_session_proxy_changes() {
        let mut account = sample_resolved_account();
        let direct = mail_imap_fingerprint(&account);
        account.network_settings = Some(NetworkSettings {
            proxy_kind: "socks5".into(),
            proxy_host: "127.0.0.1".into(),
            proxy_port: 1080,
            ..NetworkSettings::default()
        });
        let proxied = mail_imap_fingerprint(&account);
        assert_ne!(direct, proxied);
        // Unrelated display fields are not part of the connection fingerprint.
        account.config.display_name = Some("Other".into());
        assert_eq!(proxied, mail_imap_fingerprint(&account));
    }

    #[test]
    fn mail_imap_fingerprint_changes_when_credentials_change() {
        let mut account = sample_resolved_account();
        let before = mail_imap_fingerprint(&account);
        account.imap_password = "rotated-token".into();
        assert_ne!(before, mail_imap_fingerprint(&account));
    }

    #[test]
    fn is_imap_transport_error_detects_reconnectable_failures() {
        assert!(is_imap_transport_error("connection reset by peer"));
        assert!(is_imap_transport_error("IMAP NOOP failed: timed out"));
        assert!(is_imap_transport_error("IMAP protocol desync"));
        assert!(!is_imap_transport_error("IMAP login failed: authenticationfailed"));
    }

    #[test]
    fn imap_catch_result_converts_panic_to_transport_error() {
        let err = imap_catch_result(|| -> Result<(), String> {
            panic!("assertion left == right failed");
        })
        .expect_err("panic becomes Err");
        assert!(is_imap_transport_error(&err));
    }

    #[test]
    fn oauth_token_expired_refreshes_before_expiry() {
        let now = now_ts();
        assert!(oauth_token_expired(Some(now - 1)));
        assert!(oauth_token_expired(Some(
            now + OAUTH_REFRESH_SKEW_SECS.saturating_sub(1)
        )));
        assert!(!oauth_token_expired(Some(
            now + OAUTH_REFRESH_SKEW_SECS + 60
        )));
        assert!(!oauth_token_expired(None));
    }

    #[test]
    fn oauth_refresh_scope_prefers_saved_scope_then_provider_default() {
        let bundle = MailOAuthTokenBundle {
            access_token: "access".into(),
            refresh_token: Some("refresh".into()),
            expires_at: None,
            token_type: None,
            scope: Some(" saved.scope ".into()),
        };
        let settings = MailOAuthSettings {
            scope: Some("settings.scope".into()),
            ..MailOAuthSettings::default()
        };
        assert_eq!(
            oauth_refresh_scope(MailProvider::Outlook, &bundle, &settings).as_deref(),
            Some("saved.scope")
        );

        let bundle_without_scope = MailOAuthTokenBundle {
            scope: None,
            ..bundle
        };
        assert_eq!(
            oauth_refresh_scope(MailProvider::Outlook, &bundle_without_scope, &settings).as_deref(),
            Some("settings.scope")
        );

        let settings_without_scope = MailOAuthSettings::default();
        assert_eq!(
            oauth_refresh_scope(
                MailProvider::Outlook,
                &bundle_without_scope,
                &settings_without_scope,
            )
            .as_deref(),
            Some(
                "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
            )
        );
    }

    #[test]
    fn oauth_refresh_invalid_grant_prompts_reauthorization() {
        let message = oauth_refresh_error_message(
            "OAuth token refresh failed: invalid_grant refresh token expired",
        );
        assert!(message.starts_with(OAUTH_REAUTHORIZE_REQUIRED));
        assert!(message.contains("invalid_grant"));
    }

    #[test]
    fn oauth_loopback_redirect_uri_is_provider_specific() {
        assert_eq!(
            oauth_loopback_redirect_uri(MailProvider::Gmail, 49152).as_deref(),
            Ok("http://127.0.0.1:49152")
        );
        assert_eq!(
            oauth_loopback_redirect_uri(MailProvider::Outlook, 49152).as_deref(),
            Ok("http://localhost:49152")
        );
    }

    #[test]
    fn oauth_device_code_response_accepts_google_verification_url() {
        let device = serde_json::from_str::<OAuthDeviceCodeResponse>(
            r#"{
                "device_code": "device",
                "user_code": "ABCD-EFGH",
                "verification_url": "https://www.google.com/device",
                "expires_in": 900,
                "interval": 5
            }"#,
        )
        .expect("parse Google device code response");

        assert_eq!(device.verification_uri, "https://www.google.com/device");
    }

    fn sample_resolved_account() -> ResolvedMailAccount {
        ResolvedMailAccount {
            config: MailAccountConfig {
                session_id: "acct".into(),
                email_address: "sender@example.com".into(),
                provider: MailProvider::Custom,
                auth_mode: MailAuthMode::Password,
                display_name: Some("Sender".into()),
                reply_to: None,
                signature: None,
                imap: MailServerConfig {
                    host: "imap.example.com".into(),
                    port: 993,
                    username: Some("sender@example.com".into()),
                    password: Some("secret".into()),
                    security: MailConnectionSecurity::Tls,
                },
                smtp: MailSmtpConfig {
                    host: "smtp.example.com".into(),
                    port: 465,
                    username: Some("sender@example.com".into()),
                    password: Some("secret".into()),
                    security: MailConnectionSecurity::Tls,
                    use_imap_auth: true,
                },
                oauth: MailOAuthSettings::default(),
                network_settings: None,
                sync: MailSyncSettings::default(),
                cache: MailCacheSettings::default(),
                ai: MailAiSettings::default(),
            },
            auth_mode: MailAuthMode::Password,
            network_settings: None,
            imap_username: "sender@example.com".into(),
            imap_password: "secret".into(),
            smtp_username: "sender@example.com".into(),
            smtp_password: "secret".into(),
        }
    }

    #[test]
    #[ignore = "requires TAOMNI_VAULT_PASSWORD and live Outlook network access"]
    fn live_saved_outlook_oauth2_probe() {
        let session_name = std::env::var("TAOMNI_LIVE_MAIL_SESSION")
            .expect("TAOMNI_LIVE_MAIL_SESSION must name the saved mail session to probe");
        let vault_password = std::env::var("TAOMNI_VAULT_PASSWORD")
            .expect("TAOMNI_VAULT_PASSWORD must be set for this ignored live test");
        let app_data = live_app_data_dir();
        let db_path = app_data.join("taomni.db");
        let vault_path = app_data.join("vault.db");
        println!("appData={}", app_data.display());

        let db = Connection::open(&db_path).expect("open taomni.db");
        let sessions = crate::session::db::list_sessions(&db, None).expect("list sessions");
        let session = sessions
            .into_iter()
            .find(|candidate| candidate.name == session_name || candidate.id == session_name)
            .unwrap_or_else(|| panic!("saved mail session `{session_name}` not found"));
        let options = serde_json::from_str::<serde_json::Value>(&session.options_json)
            .expect("parse session options");
        let email = session
            .username
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| session.name.clone());
        let token_ref = options
            .get("mailOauthTokenRef")
            .and_then(serde_json::Value::as_str)
            .expect("mailOauthTokenRef missing");
        let client_id = options
            .get("mailOauthClientId")
            .and_then(serde_json::Value::as_str)
            .expect("mailOauthClientId missing");
        let imap_host = session.host.clone();
        let imap_port = session.port;
        let smtp_host = options
            .get("mailSmtpHost")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("smtp-mail.outlook.com")
            .to_string();
        let smtp_port = options
            .get("mailSmtpPort")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(587);

        println!("sessionId={}", session.id);
        println!("email={email}");
        println!("clientId={client_id}");
        println!("imap={imap_host}:{imap_port}");
        println!("smtp={smtp_host}:{smtp_port}");

        let vault = crate::vault::Vault::open(&vault_path).expect("open vault.db");
        vault.unlock(&vault_password).expect("unlock vault");
        let token_json = vault
            .resolve(token_ref)
            .expect("resolve OAuth token ref")
            .expect("OAuth token ref not found");
        let mut bundle =
            serde_json::from_str::<MailOAuthTokenBundle>(&token_json).expect("parse token bundle");
        println!("storedExpiresAt={:?}", bundle.expires_at);
        println!("storedScope={:?}", bundle.scope);

        if oauth_token_expired(bundle.expires_at) {
            let refresh_token = bundle
                .refresh_token
                .as_deref()
                .and_then(non_empty_str)
                .expect("refresh token missing");
            let refresh_scope = oauth_refresh_scope(
                MailProvider::Outlook,
                &bundle,
                &MailOAuthSettings {
                    client_id: Some(client_id.into()),
                    client_secret: None,
                    token_ref: Some(token_ref.into()),
                    refresh_token_ref: None,
                    expires_at: bundle.expires_at,
                    scope: bundle.scope.clone(),
                },
            );
            let refreshed = refresh_oauth_token_blocking(
                MailProvider::Outlook,
                client_id,
                None,
                refresh_token,
                refresh_scope.as_deref(),
                None,
            )
            .expect("refresh OAuth token");
            bundle.access_token = refreshed.access_token;
            bundle.expires_at = refreshed
                .expires_in
                .map(|seconds| now_ts() + seconds.max(0));
            bundle.scope = refreshed.scope.and_then(non_empty).or(refresh_scope);
            println!("tokenRefreshedInMemory=true");
            println!("refreshedExpiresAt={:?}", bundle.expires_at);
            println!("refreshedScope={:?}", bundle.scope);
        }

        match jwt_claims_summary(&bundle.access_token) {
            Ok(claims) => println!(
                "jwtClaims={}",
                serde_json::to_string_pretty(&claims).expect("format claims")
            ),
            Err(error) => println!("jwtClaims=unavailable:{error}"),
        }

        let account = live_oauth_account(
            &session.id,
            &email,
            &imap_host,
            imap_port,
            &smtp_host,
            smtp_port,
            client_id,
            token_ref,
            &bundle,
        );
        match connect_imap(&account, &tokio::runtime::Handle::current()) {
            Ok(mut session) => {
                println!("imapCrateAuth=ok");
                let folders = session
                    .list_folders(&account.config.session_id)
                    .unwrap_or_default();
                println!("imapCrateFolderCount={}", folders.len());
                session.logout();
            }
            Err(error) => {
                println!("imapCrateAuth=err:{error}");
            }
        }

        let raw_initial =
            raw_imap_xoauth2_probe(&imap_host, imap_port, &email, &bundle.access_token, true)
                .expect("raw IMAP initial-response probe");
        println!("rawImapInitial={}", raw_initial.join(" | "));

        let raw_challenge =
            raw_imap_xoauth2_probe(&imap_host, imap_port, &email, &bundle.access_token, false)
                .expect("raw IMAP challenge-response probe");
        println!("rawImapChallenge={}", raw_challenge.join(" | "));

        let raw_smtp = raw_smtp_xoauth2_probe(&smtp_host, smtp_port, &email, &bundle.access_token)
            .expect("raw SMTP XOAUTH2 probe");
        println!("rawSmtp={}", raw_smtp.join(" | "));
    }

    fn live_app_data_dir() -> std::path::PathBuf {
        std::env::var("TAOMNI_APP_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::data_dir()
                    .expect("resolve data dir")
                    .join("com.taomni.app")
            })
    }

    fn live_oauth_account(
        session_id: &str,
        email: &str,
        imap_host: &str,
        imap_port: u16,
        smtp_host: &str,
        smtp_port: u16,
        client_id: &str,
        token_ref: &str,
        bundle: &MailOAuthTokenBundle,
    ) -> ResolvedMailAccount {
        ResolvedMailAccount {
            config: MailAccountConfig {
                session_id: session_id.into(),
                email_address: email.into(),
                provider: MailProvider::Outlook,
                auth_mode: MailAuthMode::OAuth2,
                display_name: None,
                reply_to: None,
                signature: None,
                imap: MailServerConfig {
                    host: imap_host.into(),
                    port: imap_port,
                    username: Some(email.into()),
                    password: None,
                    security: MailConnectionSecurity::Tls,
                },
                smtp: MailSmtpConfig {
                    host: smtp_host.into(),
                    port: smtp_port,
                    username: Some(email.into()),
                    password: None,
                    security: MailConnectionSecurity::Starttls,
                    use_imap_auth: true,
                },
                oauth: MailOAuthSettings {
                    client_id: Some(client_id.into()),
                    client_secret: None,
                    token_ref: Some(token_ref.into()),
                    refresh_token_ref: None,
                    expires_at: bundle.expires_at,
                    scope: bundle.scope.clone(),
                },
                network_settings: None,
                sync: MailSyncSettings::default(),
                cache: MailCacheSettings::default(),
                ai: MailAiSettings::default(),
            },
            auth_mode: MailAuthMode::OAuth2,
            network_settings: None,
            imap_username: email.into(),
            imap_password: bundle.access_token.clone(),
            smtp_username: email.into(),
            smtp_password: bundle.access_token.clone(),
        }
    }

    fn jwt_claims_summary(access_token: &str) -> Result<serde_json::Value, String> {
        let parts = access_token.split('.').collect::<Vec<_>>();
        if parts.len() < 2 {
            return Err("access token is opaque, not a JWT".into());
        }
        let claims_bytes = URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|e| format!("decode JWT claims: {e}"))?;
        let claims = serde_json::from_slice::<serde_json::Value>(&claims_bytes)
            .map_err(|e| format!("parse JWT claims: {e}"))?;
        let mut summary = serde_json::Map::new();
        for key in [
            "aud",
            "iss",
            "tid",
            "azp",
            "appid",
            "scp",
            "upn",
            "preferred_username",
            "email",
            "unique_name",
            "exp",
            "nbf",
            "iat",
        ] {
            if let Some(value) = claims.get(key) {
                summary.insert(key.into(), value.clone());
            }
        }
        Ok(serde_json::Value::Object(summary))
    }

    fn raw_imap_xoauth2_probe(
        host: &str,
        port: u16,
        username: &str,
        access_token: &str,
        initial_response: bool,
    ) -> Result<Vec<String>, String> {
        let mut stream = tls_connect(host, port)?;
        let mut transcript = Vec::new();
        transcript.push(format!("S: {}", read_protocol_line(&mut stream)?));
        write_protocol_line(&mut stream, "A001 CAPABILITY")?;
        transcript.extend(tagged_response(&mut stream, "A001")?);
        let sasl = BASE64_STANDARD.encode(xoauth2_sasl_response(username, access_token));
        if initial_response {
            write_protocol_line(&mut stream, &format!("A002 AUTHENTICATE XOAUTH2 {sasl}"))?;
            transcript.extend(tagged_response(&mut stream, "A002")?);
        } else {
            write_protocol_line(&mut stream, "A002 AUTHENTICATE XOAUTH2")?;
            let line = read_protocol_line(&mut stream)?;
            transcript.push(format!("S: {line}"));
            if line.starts_with('+') {
                write_protocol_line(&mut stream, &sasl)?;
                transcript.extend(tagged_response(&mut stream, "A002")?);
            }
        }
        if transcript
            .iter()
            .any(|line| line.starts_with("S: A002 OK") || line.contains(" A002 OK "))
        {
            write_protocol_line(&mut stream, "A003 SELECT INBOX")?;
            transcript.extend(tagged_response(&mut stream, "A003")?);
        }
        let _ = write_protocol_line(&mut stream, "A004 LOGOUT");
        Ok(transcript)
    }

    fn raw_smtp_xoauth2_probe(
        host: &str,
        port: u16,
        username: &str,
        access_token: &str,
    ) -> Result<Vec<String>, String> {
        let tcp = std::net::TcpStream::connect((host, port))
            .map_err(|e| format!("SMTP TCP connect {host}:{port}: {e}"))?;
        tcp.set_read_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
            .map_err(|e| format!("SMTP read timeout setup: {e}"))?;
        tcp.set_write_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
            .map_err(|e| format!("SMTP write timeout setup: {e}"))?;
        let mut tcp = tcp;
        let mut transcript = Vec::new();
        transcript.extend(smtp_response(&mut tcp)?);
        write_protocol_line(&mut tcp, "EHLO taomni.local")?;
        transcript.extend(smtp_response(&mut tcp)?);
        write_protocol_line(&mut tcp, "STARTTLS")?;
        transcript.extend(smtp_response(&mut tcp)?);
        let connector = TlsConnector::builder()
            .build()
            .map_err(|e| format!("SMTP TLS connector: {e}"))?;
        let mut tls = connector
            .connect(host, tcp)
            .map_err(|e| format!("SMTP STARTTLS handshake: {e}"))?;
        write_protocol_line(&mut tls, "EHLO taomni.local")?;
        transcript.extend(smtp_response(&mut tls)?);
        let sasl = BASE64_STANDARD.encode(xoauth2_sasl_response(username, access_token));
        write_protocol_line(&mut tls, &format!("AUTH XOAUTH2 {sasl}"))?;
        transcript.extend(smtp_response(&mut tls)?);
        let _ = write_protocol_line(&mut tls, "QUIT");
        Ok(transcript)
    }

    fn tls_connect(
        host: &str,
        port: u16,
    ) -> Result<native_tls::TlsStream<std::net::TcpStream>, String> {
        let tcp = std::net::TcpStream::connect((host, port))
            .map_err(|e| format!("TCP connect {host}:{port}: {e}"))?;
        tcp.set_read_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
            .map_err(|e| format!("read timeout setup: {e}"))?;
        tcp.set_write_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
            .map_err(|e| format!("write timeout setup: {e}"))?;
        let connector = TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS connector: {e}"))?;
        connector
            .connect(host, tcp)
            .map_err(|e| format!("TLS handshake {host}:{port}: {e}"))
    }

    fn write_protocol_line(stream: &mut impl Write, line: &str) -> Result<(), String> {
        stream
            .write_all(format!("{line}\r\n").as_bytes())
            .map_err(|e| format!("write protocol line: {e}"))?;
        stream
            .flush()
            .map_err(|e| format!("flush protocol line: {e}"))
    }

    fn read_protocol_line(stream: &mut impl Read) -> Result<String, String> {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            stream
                .read_exact(&mut byte)
                .map_err(|e| format!("read protocol line: {e}"))?;
            buf.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        Ok(String::from_utf8_lossy(&buf)
            .trim_end_matches(['\r', '\n'])
            .to_string())
    }

    fn tagged_response(stream: &mut impl Read, tag: &str) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        loop {
            let line = read_protocol_line(stream)?;
            let done = line.starts_with(&format!("{tag} "));
            lines.push(format!("S: {line}"));
            if done {
                return Ok(lines);
            }
        }
    }

    fn smtp_response(stream: &mut impl Read) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        loop {
            let line = read_protocol_line(stream)?;
            let complete = line.len() >= 4 && line.as_bytes().get(3) == Some(&b' ');
            lines.push(format!("S: {line}"));
            if complete {
                return Ok(lines);
            }
        }
    }

    #[test]
    fn decode_imap_modified_utf7_mailbox_names() {
        assert_eq!(decode_imap_modified_utf7("INBOX"), "INBOX");
        assert_eq!(decode_imap_modified_utf7("A &- B"), "A & B");
        assert_eq!(
            decode_imap_modified_utf7("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
            "~peter/mail/台北/日本語"
        );
    }

    #[test]
    fn imap_login_retry_classifies_transient_and_auth_errors() {
        assert!(should_retry_imap_login("No Response: LOGIN Login error"));
        assert!(should_retry_imap_login(
            "temporary rate limit, try again later"
        ));
        assert!(!should_retry_imap_login(
            "NO [AUTHENTICATIONFAILED] Invalid credentials"
        ));
        assert!(!should_retry_imap_login(
            "NO invalid login or password incorrect"
        ));
    }

    #[test]
    fn parse_body_decodes_headers_and_preview() {
        let parsed = parse_body_message("acct", "INBOX", 7, Some(512), &sample_message(), 4096);
        assert_eq!(parsed.header.subject, "测试邮件");
        assert_eq!(
            parsed.header.message_id.as_deref(),
            Some("sample@example.com")
        );
        assert_eq!(
            parsed
                .header
                .from
                .as_ref()
                .and_then(|a| a.address.as_deref()),
            Some("sender@example.com")
        );
        assert_eq!(
            parsed.header.snippet.as_deref(),
            Some("Hello from Taomni Mail.")
        );
        assert!(parsed.body_text.as_deref().unwrap().contains("Taomni Mail"));
    }

    #[test]
    fn parse_and_extract_attachment() {
        let raw = sample_attachment_message();
        let parsed = parse_body_message("acct", "INBOX", 8, Some(raw.len() as u32), &raw, 4096);
        assert!(parsed.header.has_attachments);
        assert_eq!(parsed.header.attachment_count, 1);
        assert_eq!(
            parsed.header.attachments[0].name.as_deref(),
            Some("report.txt")
        );

        let attachment = extract_attachment(&raw, 0).unwrap();
        assert_eq!(attachment.name.as_deref(), Some("report.txt"));
        assert_eq!(attachment.content_type.as_deref(), Some("text/plain"));
        assert_eq!(attachment.bytes, b"Attachment content.");
    }

    #[test]
    fn parse_body_rewrites_cid_images_to_data_urls() {
        let raw = sample_inline_image_message();
        let parsed = parse_body_message("acct", "INBOX", 9, Some(raw.len() as u32), &raw, 4096);
        let html = parsed.body_html.as_deref().expect("html body");
        assert!(
            html.contains("data:image/png;base64,"),
            "expected embedded data URL, got: {html}"
        );
        assert!(
            !html.to_ascii_lowercase().contains("cid:logo@inline.local"),
            "cid reference should be rewritten for display"
        );
        assert!(html.contains("alt=\"logo\""));
    }

    #[test]
    fn cache_roundtrips_folders_messages_and_body() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        let mut message =
            parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
        message.header.flags = vec!["\\Seen".into()];
        let folder = MailFolder {
            account_id: "acct".into(),
            name: "INBOX".into(),
            display_name: "INBOX".into(),
            delimiter: Some("/".into()),
            flags: vec![],
            uid_validity: Some(1),
            uid_next: Some(11),
            total: Some(1),
            unread: Some(0),
            updated_at: now_ts(),
        };
        cache_sync_result(
            &conn,
            "acct",
            &[folder],
            &[message],
            "INBOX",
            &MailCacheSettings {
                header_retention_days: 0,
                ..MailCacheSettings::default()
            },
        )
        .unwrap();

        let folders = list_cached_folders(&conn, "acct").unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].uid_next, Some(11));

        let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].subject, "测试邮件");
        assert!(messages[0].body_cached);

        let body = get_cached_body(&conn, "acct", "INBOX", 10)
            .unwrap()
            .unwrap();
        assert_eq!(body.source, "cache");
        assert!(body.text.unwrap().contains("Taomni Mail"));
    }

    #[test]
    fn contact_index_searches_cached_headers() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        let message = parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
        upsert_message(&conn, &message).unwrap();

        assert_eq!(reindex_cached_contacts(&conn, "acct").unwrap(), 2);
        let contacts = search_contacts(&conn, "acct", "sender", 8).unwrap();

        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].email, "sender@example.com");
        assert_eq!(contacts[0].source, "history");
    }

    #[test]
    fn sent_contacts_raise_sent_source() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        let request = MailSendRequest {
            to: vec!["Receiver <receiver@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            text_body: Some("Body".into()),
            html_body: None,
            attachments: vec![],
        };

        assert_eq!(upsert_sent_contacts(&conn, "acct", &request).unwrap(), 1);
        let contacts = search_contacts(&conn, "acct", "receiver", 8).unwrap();

        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].name.as_deref(), Some("Receiver"));
        assert_eq!(contacts[0].source, "sent");
    }

    #[test]
    fn build_send_message_wraps_attachments_in_mixed_mime() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.txt");
        std::fs::write(&path, b"attachment body").unwrap();
        let request = MailSendRequest {
            to: vec!["Receiver <receiver@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            text_body: Some("Plain body".into()),
            html_body: Some("<p><strong>HTML body</strong></p>".into()),
            attachments: vec![MailSendAttachment {
                path: path.to_string_lossy().into_owned(),
                name: Some("report.txt".into()),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
            }],
        };

        let message = build_send_message(&sample_resolved_account(), &request).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();

        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("filename=\"report.txt\""));
    }

    #[test]
    fn build_send_message_embeds_inline_images_in_related_mime() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logo.png");
        std::fs::write(&path, b"png body").unwrap();
        let request = MailSendRequest {
            to: vec!["Receiver <receiver@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            text_body: Some("Plain body".into()),
            html_body: Some("<p><img src=\"cid:logo-1@inline.local\"></p>".into()),
            attachments: vec![MailSendAttachment {
                path: path.to_string_lossy().into_owned(),
                name: Some("logo.png".into()),
                content_type: Some("image/png".into()),
                inline: true,
                content_id: Some("logo-1@inline.local".into()),
            }],
        };

        let message = build_send_message(&sample_resolved_account(), &request).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();

        assert!(raw.contains("multipart/related"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("Content-ID: <logo-1@inline.local>"));
        assert!(raw.contains("Content-Disposition: inline; filename=\"logo.png\""));
    }

    #[test]
    fn build_send_message_nests_related_body_inside_mixed() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("logo.png");
        let report_path = dir.path().join("report.txt");
        std::fs::write(&image_path, b"png body").unwrap();
        std::fs::write(&report_path, b"report body").unwrap();
        let request = MailSendRequest {
            to: vec!["Receiver <receiver@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            text_body: Some("Plain body".into()),
            html_body: Some("<p><img src=\"cid:logo-1@inline.local\"></p>".into()),
            attachments: vec![
                MailSendAttachment {
                    path: image_path.to_string_lossy().into_owned(),
                    name: Some("logo.png".into()),
                    content_type: Some("image/png".into()),
                    inline: true,
                    content_id: Some("logo-1@inline.local".into()),
                },
                MailSendAttachment {
                    path: report_path.to_string_lossy().into_owned(),
                    name: Some("report.txt".into()),
                    content_type: Some("text/plain".into()),
                    inline: false,
                    content_id: None,
                },
            ],
        };

        let message = build_send_message(&sample_resolved_account(), &request).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();

        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("multipart/related"));
        assert!(raw.contains("Content-ID: <logo-1@inline.local>"));
        assert!(raw.contains("filename=\"report.txt\""));
    }

    #[test]
    fn local_drafts_roundtrip_and_delete() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        let saved = save_mail_draft(
            &conn,
            "acct",
            MailDraftSaveRequest {
                id: None,
                to: vec!["Receiver <receiver@example.com>".into()],
                cc: vec![],
                bcc: vec![],
                subject: "Draft subject".into(),
                text_body: "Plain".into(),
                html_body: "<p>Plain</p>".into(),
                attachments: vec![MailDraftAttachment {
                    path: "/tmp/report.txt".into(),
                    name: Some("report.txt".into()),
                    content_type: Some("text/plain".into()),
                    inline: false,
                    content_id: None,
                    size: Some(12),
                    modified_at: Some(123),
                }],
                reply_context: Some(MailDraftContext {
                    kind: Some("reply".into()),
                    folder: Some("INBOX".into()),
                    uid: Some(42),
                    message_id: Some("msg@example.com".into()),
                    subject: Some("Original".into()),
                }),
                remote_draft_folder: None,
                remote_draft_uid: None,
            },
        )
        .unwrap();

        let drafts = list_mail_drafts(&conn, "acct").unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].id, saved.id);
        assert_eq!(drafts[0].attachments[0].name.as_deref(), Some("report.txt"));
        assert_eq!(
            drafts[0].reply_context.as_ref().and_then(|ctx| ctx.uid),
            Some(42)
        );

        delete_mail_draft(&conn, "acct", &saved.id).unwrap();
        assert!(list_mail_drafts(&conn, "acct").unwrap().is_empty());
    }

    #[test]
    fn update_and_remove_cache_helpers_mutate_rows() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        let mut first = parse_body_message("acct", "INBOX", 1, Some(10), &sample_message(), 4096);
        first.header.flags = vec!["\\Seen".into()];
        let mut second = parse_body_message("acct", "INBOX", 2, Some(10), &sample_message(), 4096);
        second.header.flags = vec!["\\Seen".into()];
        upsert_message(&conn, &first).unwrap();
        upsert_message(&conn, &second).unwrap();

        update_cached_flags(
            &conn,
            "acct",
            "INBOX",
            &[1],
            &["\\Flagged".into()],
            &["\\Seen".into()],
        )
        .unwrap();
        let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
        let one = messages.iter().find(|m| m.uid == 1).unwrap();
        assert!(
            one.flags
                .iter()
                .any(|f| f.eq_ignore_ascii_case("\\Flagged"))
        );
        assert!(!one.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));
        let two = messages.iter().find(|m| m.uid == 2).unwrap();
        assert!(two.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));

        remove_cached_messages(&conn, "acct", "INBOX", &[1]).unwrap();
        let after = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].uid, 2);
    }

    #[test]
    fn purge_cached_folder_removes_folder_and_subfolders_only() {
        let conn = Connection::open_in_memory().unwrap();
        init_mail_tables(&conn).unwrap();
        for name in ["Parent", "Parent/Child", "ParentX"] {
            upsert_message(
                &conn,
                &parse_body_message("acct", name, 1, Some(10), &sample_message(), 4096),
            )
            .unwrap();
            upsert_folder(
                &conn,
                &MailFolder {
                    account_id: "acct".into(),
                    name: name.into(),
                    display_name: name.into(),
                    delimiter: Some("/".into()),
                    flags: vec![],
                    uid_validity: None,
                    uid_next: None,
                    total: None,
                    unread: None,
                    updated_at: now_ts(),
                },
            )
            .unwrap();
        }

        purge_cached_folder(&conn, "acct", "Parent").unwrap();

        let names = list_cached_folders(&conn, "acct")
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"ParentX".to_string()));
        assert!(!names.contains(&"Parent".to_string()));
        assert!(!names.contains(&"Parent/Child".to_string()));
        assert_eq!(
            list_cached_messages(&conn, "acct", "Parent", 20, 0)
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            list_cached_messages(&conn, "acct", "Parent/Child", 20, 0)
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            list_cached_messages(&conn, "acct", "ParentX", 20, 0)
                .unwrap()
                .len(),
            1
        );
    }
}
