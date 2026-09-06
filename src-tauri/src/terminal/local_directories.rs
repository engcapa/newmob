//! Welcome local-directory usage store: authoritative recency source.
//!
//! Design: `docs-feature/welcome-recents-session-restore-design.md` 4.1 + 11.x
//! (directory parts unaffected by D-01=B). Command history is only a legacy
//! migration input; live "use" events are successful native-local PTY starts
//! and confirmed host cwd reports.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const METADATA_MIGRATION_KEY: &str = "directory_migration_v1";
pub const METADATA_MIGRATION_DONE: &str = "complete";
pub const METADATA_REVISION_KEY: &str = "directory_revision";
const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS welcome_directory_usage (
      directory_id TEXT PRIMARY KEY,
      display_path TEXT NOT NULL,
      last_used_at_ms INTEGER,
      last_use_source TEXT,
      legacy_rank INTEGER,
      legacy_observed_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS welcome_directory_alias (
      path_key TEXT PRIMARY KEY,
      directory_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS welcome_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirectoryShortcut {
    pub label: String,
    pub path: String,
    pub kind: String,
    pub directory_id: String,
    pub last_used_at_ms: Option<i64>,
    pub time_source: Option<String>,
    pub legacy_rank: Option<i64>,
    pub default_id: Option<String>,
    pub availability: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListResponse {
    pub revision: i64,
    pub directories: Vec<LocalDirectoryShortcut>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDirectoryResponse {
    pub changed: bool,
    pub directory: Option<LocalDirectoryShortcut>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    let rev: Option<String> = conn
        .query_row(
            "SELECT value FROM welcome_metadata WHERE key = ?1",
            params![METADATA_REVISION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if rev.is_none() {
        conn.execute(
            "INSERT OR IGNORE INTO welcome_metadata (key, value) VALUES (?1, '0')",
            params![METADATA_REVISION_KEY],
        )?;
    }
    Ok(())
}

fn get_revision_tx(tx: &rusqlite::Transaction) -> rusqlite::Result<i64> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM welcome_metadata WHERE key = ?1",
            params![METADATA_REVISION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0))
}

fn bump_revision_tx(tx: &rusqlite::Transaction) -> rusqlite::Result<i64> {
    let next = get_revision_tx(tx)? + 1;
    tx.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![METADATA_REVISION_KEY, next.to_string()],
    )?;
    Ok(next)
}

pub fn current_revision(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT value FROM welcome_metadata WHERE key = ?1",
        params![METADATA_REVISION_KEY],
        |row| {
            let v: String = row.get(0)?;
            Ok(v.parse::<i64>().unwrap_or(0))
        },
    )
    .unwrap_or(0)
}

/// Lexical path key without touching the filesystem.
///
/// - Rejects empty strings and NUL bytes; requires a host-absolute path.
/// - Windows (`is_windows=true`): `/` + `\` unified to `/`, drive letter
///   upper-cased, `C:relative` refused (not equivalent to `C:\relative`).
/// - Unix: backslashes are ordinary filename characters; leading/trailing
///   spaces preserved; only redundant trailing `/` stripped (root kept).
pub fn normalize_lexical_key(path_str: &str, is_windows: bool) -> Result<String, String> {
    if path_str.is_empty() {
        return Err("empty path".to_string());
    }
    if path_str.contains('\0') {
        return Err("path contains NUL".to_string());
    }
    if is_windows {
        let unified = path_str.replace('\\', "/");
        // Extended-length / UNC prefixes: keep share/root semantics, unify case.
        if unified.starts_with("//?/UNC/") || unified.starts_with("//./UNC/") {
            let prefix_len = 8;
            let (prefix, rest) = unified.split_at(prefix_len);
            let _ = prefix;
            let mut parts = rest.splitn(3, '/');
            let server = parts.next().unwrap_or("");
            let share = parts.next().unwrap_or("");
            let tail = parts.next().unwrap_or("");
            let mut key = format!("//UNC/{server}/{share}");
            if !tail.is_empty() {
                key.push('/');
                key.push_str(tail.trim_end_matches('/'));
            }
            return Ok(key);
        }
        if unified.starts_with("//?/") || unified.starts_with("//./") {
            let tail = unified[4..].to_string();
            if tail.len() >= 2 && tail.as_bytes()[1] == b':' {
                let mut chars = tail.chars();
                let drive = chars.next().unwrap_or('C').to_ascii_uppercase();
                let rest: String = chars.collect();
                let rest = rest.trim_end_matches('/');
                return Ok(format!("//?/{drive}{rest}"));
            }
            return Ok(format!("//?/{}", tail.trim_end_matches('/')));
        }
        if unified.starts_with("//") {
            let trimmed = unified.trim_end_matches('/');
            return Ok(trimmed.to_string());
        }
        if unified.len() >= 2 && unified.as_bytes()[1] == b':' {
            let drive = unified.as_bytes()[0] as char;
            if !drive.is_ascii_alphabetic() {
                return Err("invalid drive letter".to_string());
            }
            if unified.len() == 2 || unified.as_bytes()[2] != b'/' {
                return Err("drive-relative path is not absolute".to_string());
            }
            let rest = unified[2..].trim_end_matches('/');
            if rest.is_empty() {
                return Ok(format!("{}:/", drive.to_ascii_uppercase()));
            }
            return Ok(format!("{}:{rest}", drive.to_ascii_uppercase()));
        }
        return Err("Windows path must be absolute".to_string());
    }
    if !unified_is_absolute_posix(path_str) {
        return Err("path must be absolute".to_string());
    }
    if path_str != "/" {
        let trimmed = path_str.trim_end_matches('/');
        if trimmed.is_empty() {
            return Ok("/".to_string());
        }
        return Ok(trimmed.to_string());
    }
    Ok("/".to_string())
}

fn unified_is_absolute_posix(s: &str) -> bool {
    s.starts_with('/')
}

pub fn normalize_path_key(path: &Path) -> Result<String, String> {
    let raw = path.to_str().ok_or_else(|| "non-UTF8 path".to_string())?;
    normalize_lexical_key(raw, cfg!(windows))
}

fn strip_trailing_sep(mut s: String) -> String {
    if s.len() > 1 {
        s = s.trim_end_matches('/').to_string();
        if s.is_empty() {
            s = "/".to_string();
        }
    }
    s
}

/// Availability probe (synchronous, no DB lock held by callers).
/// `unknown` is reserved for future background probing; current sync checks
/// map OS errors directly so missing/permission problems stay visible.
pub fn availability_for(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(md) => {
            if md.is_dir() {
                "available".to_string()
            } else {
                "missing".to_string()
            }
        }
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => "missing".to_string(),
            std::io::ErrorKind::PermissionDenied => "permission-denied".to_string(),
            _ => "unavailable".to_string(),
        },
    }
}

fn same_file_equal(a: &Path, b: &Path) -> bool {
    match (
        same_file::Handle::from_path(a),
        same_file::Handle::from_path(b),
    ) {
        (Ok(ha), Ok(hb)) => ha == hb,
        _ => false,
    }
}

#[derive(Clone, Debug)]
struct MergedEntry {
    directory_id: String,
    display_path: String,
    label: String,
    kind: String,
    last_used_at_ms: Option<i64>,
    time_source: Option<String>,
    legacy_rank: Option<i64>,
    default_id: Option<String>,
    default_rank: Option<i64>,
    path_keys: HashSet<String>,
    probe_path: PathBuf,
}

fn identity_sort_key(keys: &HashSet<String>) -> String {
    keys.iter().min().cloned().unwrap_or_default()
}

fn source_priority(source: Option<&str>) -> i64 {
    match source {
        Some("local-start") => 0,
        Some("local-cwd") => 1,
        _ => 2,
    }
}

/// Ordering tuple (design 4.1.3): confirmed time DESC, then legacy rank ASC,
/// then default rank ASC, then identity key ASC. Byte-wise string ordering;
/// never locale-sensitive.
pub fn compare_merged(a: &MergedEntry, b: &MergedEntry) -> Ordering {
    match (&a.last_used_at_ms, &b.last_used_at_ms) {
        (Some(x), Some(y)) => match y.cmp(x) {
            Ordering::Equal => {}
            ord => return ord,
        },
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    if a.last_used_at_ms.is_some() && b.last_used_at_ms.is_some() {
        match source_priority(a.time_source.as_deref())
            .cmp(&source_priority(b.time_source.as_deref()))
        {
            Ordering::Equal => {}
            ord => return ord,
        }
    }
    match (&a.legacy_rank, &b.legacy_rank) {
        (Some(x), Some(y)) => match x.cmp(y) {
            Ordering::Equal => {}
            ord => return ord,
        },
        (Some(_), None) => {
            if a.last_used_at_ms.is_none() && b.last_used_at_ms.is_none() {
                return Ordering::Less;
            }
        }
        (None, Some(_)) => {
            if a.last_used_at_ms.is_none() && b.last_used_at_ms.is_none() {
                return Ordering::Greater;
            }
        }
        (None, None) => {}
    }
    match (&a.default_rank, &b.default_rank) {
        (Some(x), Some(y)) => match x.cmp(y) {
            Ordering::Equal => {}
            ord => return ord,
        },
        (Some(_), None) => {
            if a.last_used_at_ms.is_none()
                && b.last_used_at_ms.is_none()
                && a.legacy_rank.is_none()
                && b.legacy_rank.is_none()
            {
                return Ordering::Less;
            }
        }
        (None, Some(_)) => {
            if a.last_used_at_ms.is_none()
                && b.last_used_at_ms.is_none()
                && a.legacy_rank.is_none()
                && b.legacy_rank.is_none()
            {
                return Ordering::Greater;
            }
        }
        (None, None) => {}
    }
    identity_sort_key(&a.path_keys).cmp(&identity_sort_key(&b.path_keys))
}

pub fn compare_directories(a: &LocalDirectoryShortcut, b: &LocalDirectoryShortcut) -> Ordering {
    let rank_of = |d: &LocalDirectoryShortcut| default_rank_for_id(d.default_id.as_deref());
    let ma = MergedEntry {
        directory_id: a.directory_id.clone(),
        display_path: a.path.clone(),
        label: a.label.clone(),
        kind: a.kind.clone(),
        last_used_at_ms: a.last_used_at_ms,
        time_source: a.time_source.clone(),
        legacy_rank: a.legacy_rank,
        default_id: a.default_id.clone(),
        default_rank: rank_of(a),
        path_keys: HashSet::new(),
        probe_path: PathBuf::from(&a.path),
    };
    let mb = MergedEntry {
        directory_id: b.directory_id.clone(),
        display_path: b.path.clone(),
        label: b.label.clone(),
        kind: b.kind.clone(),
        last_used_at_ms: b.last_used_at_ms,
        time_source: b.time_source.clone(),
        legacy_rank: b.legacy_rank,
        default_id: b.default_id.clone(),
        default_rank: rank_of(b),
        path_keys: HashSet::new(),
        probe_path: PathBuf::from(&b.path),
    };
    compare_merged(&ma, &mb)
}

fn default_rank_for_id(default_id: Option<&str>) -> Option<i64> {
    match default_id {
        Some("home") => Some(0),
        Some("desktop") => Some(1),
        Some("documents") => Some(2),
        Some("downloads") => Some(3),
        Some("pictures") => Some(4),
        Some("music") => Some(5),
        Some("videos") => Some(6),
        Some("guess-Code") => Some(7),
        Some("guess-code") => Some(8),
        Some("guess-Projects") => Some(9),
        Some("guess-projects") => Some(10),
        Some("guess-Workspace") => Some(11),
        Some("guess-workspace") => Some(12),
        Some("guess-work") => Some(13),
        Some("guess-dev") => Some(14),
        Some("guess-Developer") => Some(15),
        Some("guess-src") => Some(16),
        _ => None,
    }
}

/// Legacy migration: structured `id/command/last_used_at` window, deterministic
/// `time DESC, id DESC`. Parsed paths become null-`last_used` rows with
/// continuous `legacy_rank`; valid non-negative second timestamps convert to
/// `legacy_observed_at_ms` only (never upgraded to confirmed use).
pub fn migrate_legacy_history(conn: &Connection) -> rusqlite::Result<bool> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM welcome_metadata WHERE key = ?1",
            params![METADATA_MIGRATION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if done.as_deref() == Some(METADATA_MIGRATION_DONE) {
        return Ok(false);
    }
    let home = dirs::home_dir();
    let mut legacy: Vec<(i64, i64, String)> = Vec::new();
    let collect = |sql: &str, out: &mut Vec<(i64, i64, String)>| -> rusqlite::Result<()> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let command: String = row.get(1)?;
            let last_used: Option<i64> = row.get(2)?;
            Ok((id, command, last_used.unwrap_or(-1)))
        })?;
        for row in rows {
            let (id, command, last_used) = row?;
            out.push((last_used, id, command));
        }
        Ok(())
    };
    collect(
        "SELECT id, command, last_used_at FROM command_history
         WHERE host_key = 'local'
           AND (lower(command) LIKE 'cd %' OR lower(command) LIKE 'cd\t%'
                OR lower(command) = 'cd' OR lower(command) LIKE 'chdir %'
                OR lower(command) LIKE 'pushd %' OR lower(command) LIKE 'set-location %'
                OR lower(command) LIKE 'sl %')
         ORDER BY last_used_at DESC, id DESC LIMIT 300",
        &mut legacy,
    )?;
    if legacy.len() < 24 {
        let mut broad: Vec<(i64, i64, String)> = Vec::new();
        collect(
            "SELECT id, command, last_used_at FROM command_history
             WHERE host_key = 'local' ORDER BY last_used_at DESC, id DESC LIMIT 500",
            &mut broad,
        )?;
        let mut seen_cmd = HashSet::new();
        for (_, _, cmd) in &legacy {
            seen_cmd.insert(cmd.clone());
        }
        for row in broad {
            if seen_cmd.insert(row.2.clone()) {
                legacy.push(row);
            }
        }
    }
    legacy.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(SCHEMA_SQL)?;
    // Deterministic rank: first distinct parsed directory wins earliest rank.
    let mut rank_counter: i64 = 0;
    let mut ranked: HashMap<String, (i64, Option<i64>, String)> = HashMap::new();
    for (last_used, _id, command) in &legacy {
        let parsed = super::pty::directory_from_history_command(command, home.as_deref());
        let Some(path) = parsed else { continue };
        let path_str = path.to_string_lossy().to_string();
        let key = match normalize_path_key(&path) {
            Ok(k) => k,
            Err(_) => continue,
        };
        if ranked.contains_key(&key) {
            continue;
        }
        let observed = if *last_used >= 0 {
            last_used.checked_mul(1000).filter(|v| *v <= i64::MAX / 2)
        } else {
            None
        };
        ranked.insert(key, (rank_counter, observed, path_str));
        rank_counter += 1;
    }
    // Missing-time entries sort after observed ones with stable byte order.
    let mut ordered: Vec<(String, i64, Option<i64>, String)> = ranked
        .into_iter()
        .map(|(k, (r, o, p))| (k, r, o, p))
        .collect();
    ordered.sort_by(|a, b| match (&a.2, &b.2) {
        (Some(x), Some(y)) => y.cmp(x).then(a.1.cmp(&b.1)).then(a.0.cmp(&b.0)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.1.cmp(&b.1).then(a.0.cmp(&b.0)),
    });
    let mut final_rank: i64 = 0;
    for (key, _old_rank, observed, display) in ordered {
        let directory_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT OR IGNORE INTO welcome_directory_usage
             (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
             VALUES (?1, ?2, NULL, NULL, ?3, ?4)",
            params![directory_id, display, final_rank, observed],
        )?;
        let row_id: String = tx.query_row(
            "SELECT directory_id FROM welcome_directory_usage
             WHERE legacy_rank = ?1 AND display_path = ?2",
            params![final_rank, display],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO welcome_directory_alias (path_key, directory_id) VALUES (?1, ?2)",
            params![key, row_id],
        )?;
        final_rank += 1;
    }
    tx.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![METADATA_MIGRATION_KEY, METADATA_MIGRATION_DONE],
    )?;
    tx.commit()?;
    Ok(true)
}

struct UsageRow {
    directory_id: String,
    display_path: String,
    last_used_at_ms: Option<i64>,
    last_use_source: Option<String>,
    legacy_rank: Option<i64>,
}

fn load_usage(conn: &Connection) -> rusqlite::Result<Vec<UsageRow>> {
    let mut stmt = conn.prepare(
        "SELECT directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank
         FROM welcome_directory_usage",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UsageRow {
            directory_id: row.get(0)?,
            display_path: row.get(1)?,
            last_used_at_ms: row.get(2)?,
            last_use_source: row.get(3)?,
            legacy_rank: row.get(4)?,
        })
    })?;
    rows.collect()
}

fn load_aliases(conn: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT path_key, directory_id FROM welcome_directory_alias")?;
    let rows = stmt.query_map([], |row| {
        let k: String = row.get(0)?;
        let v: String = row.get(1)?;
        Ok((k, v))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

fn merge_better_time(
    existing: (Option<i64>, Option<String>),
    incoming: (Option<i64>, Option<String>),
) -> (Option<i64>, Option<String>) {
    match (existing.0, incoming.0) {
        (Some(a), Some(b)) => {
            if b > a {
                (Some(b), incoming.1)
            } else if b < a {
                (Some(a), existing.1)
            } else if source_priority(existing.1.as_deref())
                <= source_priority(incoming.1.as_deref())
            {
                (Some(a), existing.1)
            } else {
                (Some(b), incoming.1)
            }
        }
        (None, Some(_)) => incoming,
        (Some(_), None) => existing,
        (None, None) => (None, None),
    }
}

/// Record a confirmed use. `source` is `local-start` or `local-cwd`.
/// Takes the max of existing/new confirmed time so stale responses never move
/// the record backwards. Returns the merged directory row.
pub fn record_successful_use(
    conn: &Connection,
    path_str: &str,
    source: &str,
    at_ms: i64,
) -> Result<RecordDirectoryResponse, String> {
    if source != "local-start" && source != "local-cwd" {
        return Err("invalid source".to_string());
    }
    let path = PathBuf::from(path_str);
    if path_str.is_empty() || path_str.contains('\0') {
        return Err("invalid path".to_string());
    }
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    if path.to_str().is_none() {
        return Err("non-UTF8 path".to_string());
    }
    let key = normalize_path_key(&path).map_err(|e| format!("invalid path: {e}"))?;
    // FS identity confirmations happen before the DB transaction body below;
    // only alias/key maintenance runs inside the transaction.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    let aliases: HashMap<String, String> = {
        let mut stmt = tx
            .prepare("SELECT path_key, directory_id FROM welcome_directory_alias")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let k: String = row.get(0)?;
                let v: String = row.get(1)?;
                Ok((k, v))
            })
            .map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            map.insert(k, v);
        }
        map
    };
    // Resolve identity: lexical alias hit, else same-file handle match against
    // known alias targets that are still accessible.
    let mut directory_id = aliases.get(&key).cloned();
    if directory_id.is_none() {
        let mut stmt = tx
            .prepare("SELECT path_key, directory_id FROM welcome_directory_alias")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let k: String = row.get(0)?;
                let v: String = row.get(1)?;
                Ok((k, v))
            })
            .map_err(|e| e.to_string())?;
        let mut candidates: Vec<(String, String)> = Vec::new();
        for row in rows {
            candidates.push(row.map_err(|e| e.to_string())?);
        }
        for (other_key, other_id) in candidates {
            let other_path = PathBuf::from(&other_key);
            if same_file_equal(&path, &other_path) {
                directory_id = Some(other_id);
                break;
            }
        }
    }
    let directory_id = directory_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing: Option<(Option<i64>, Option<String>, Option<i64>)> = tx
        .query_row(
            "SELECT last_used_at_ms, last_use_source, legacy_rank FROM welcome_directory_usage WHERE directory_id = ?1",
            params![directory_id],
            |row| {
                let t: Option<i64> = row.get(0)?;
                let s: Option<String> = row.get(1)?;
                let r: Option<i64> = row.get(2)?;
                Ok((t, s, r))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (merged_time, merged_source) = match &existing {
        Some((t, s, _)) => merge_better_time(
            (t.clone(), s.clone()),
            (Some(at_ms), Some(source.to_string())),
        ),
        None => (Some(at_ms), Some(source.to_string())),
    };
    let display = path_str.to_string();
    if existing.is_some() {
        tx.execute(
            "UPDATE welcome_directory_usage SET display_path = ?1, last_used_at_ms = ?2, last_use_source = ?3 WHERE directory_id = ?4",
            params![display, merged_time, merged_source, directory_id],
        ).map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "INSERT INTO welcome_directory_usage (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            params![directory_id, display, merged_time, merged_source],
        ).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO welcome_directory_alias (path_key, directory_id) VALUES (?1, ?2)",
        params![key, directory_id],
    )
    .map_err(|e| e.to_string())?;
    let revision = bump_revision_tx(&tx).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = revision;
    let directory = get_directory_by_id(conn, &directory_id).map_err(|e| e.to_string())?;
    Ok(RecordDirectoryResponse {
        changed: true,
        directory,
    })
}

fn get_directory_by_id(
    conn: &Connection,
    directory_id: &str,
) -> rusqlite::Result<Option<LocalDirectoryShortcut>> {
    let row: Option<UsageRow> = conn
        .query_row(
            "SELECT directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank
             FROM welcome_directory_usage WHERE directory_id = ?1",
            params![directory_id],
            |row| {
                Ok(UsageRow {
                    directory_id: row.get(0)?,
                    display_path: row.get(1)?,
                    last_used_at_ms: row.get(2)?,
                    last_use_source: row.get(3)?,
                    legacy_rank: row.get(4)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else { return Ok(None) };
    let path = PathBuf::from(&row.display_path);
    Ok(Some(LocalDirectoryShortcut {
        label: path
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("Directory")
            .to_string(),
        path: row.display_path,
        kind: "personal".to_string(),
        directory_id: row.directory_id,
        last_used_at_ms: row.last_used_at_ms,
        time_source: row.last_use_source.map(|s| {
            if s == "local-start" {
                "local-start".to_string()
            } else {
                "local-cwd".to_string()
            }
        }),
        legacy_rank: row.legacy_rank,
        default_id: None,
        availability: availability_for(&path),
    }))
}

/// Full list: persisted usage + default candidates merged by identity, then
/// unified recency sort. Persists first-seen default null-time rows + aliases
/// only when the discovered set changes; plain lists never rewrite times.
pub fn list_directory_shortcuts(conn: &Connection) -> Result<DirectoryListResponse, String> {
    // Phase 1 (no DB lock expectations here; caller holds no guard across
    // probing): enumerate + probe default candidates.
    let candidates = super::pty::default_directory_candidates();
    let mut probed: Vec<(String, String, String, Option<String>, i64, PathBuf, String)> =
        Vec::new();
    for c in candidates {
        let key = match normalize_path_key(&c.path) {
            Ok(k) => k,
            Err(_) => continue,
        };
        // Guesses only join when they exist; system dirs join when the OS
        // reports them (missing ones simply have no row).
        if !c.path.is_dir() {
            continue;
        }
        probed.push((
            c.default_id.to_string(),
            c.label,
            c.kind.to_string(),
            Some(c.default_id.to_string()),
            c.default_rank,
            c.path,
            key,
        ));
    }

    init_tables(conn).map_err(|e| format!("storage: {e}"))?;
    // Best-effort legacy import; a corrupt history must not break listing.
    let _ = migrate_legacy_history(conn);
    let usage = load_usage(conn).map_err(|e| format!("storage: {e}"))?;
    let aliases = load_aliases(conn).map_err(|e| format!("storage: {e}"))?;
    let mut by_id: HashMap<String, MergedEntry> = HashMap::new();
    let mut alias_to_id: HashMap<String, String> = aliases;
    for row in usage {
        let probe = PathBuf::from(&row.display_path);
        let mut keys = HashSet::new();
        for (k, v) in alias_to_id.iter() {
            if v == &row.directory_id {
                keys.insert(k.clone());
            }
        }
        if keys.is_empty() {
            if let Ok(k) = normalize_path_key(&probe) {
                keys.insert(k);
            }
        }
        by_id.insert(
            row.directory_id.clone(),
            MergedEntry {
                directory_id: row.directory_id,
                display_path: row.display_path,
                label: String::new(),
                kind: "personal".to_string(),
                last_used_at_ms: row.last_used_at_ms,
                time_source: row.last_use_source,
                legacy_rank: row.legacy_rank,
                default_id: None,
                default_rank: None,
                path_keys: keys,
                probe_path: probe,
            },
        );
    }

    // Phase 2: merge defaults by lexical alias, else confirmed same-file.
    let mut dirty = false;
    // Snapshot existing (id, probe_path) for same-file checks without borrow issues.
    let existing_pairs: Vec<(String, PathBuf)> = by_id
        .values()
        .map(|e| (e.directory_id.clone(), e.probe_path.clone()))
        .collect();
    for (default_id, label, kind, _opt, default_rank, path, key) in probed {
        if let Some(id) = alias_to_id.get(&key).cloned() {
            if let Some(entry) = by_id.get_mut(&id) {
                entry.path_keys.insert(key.clone());
                if entry.default_rank.is_none()
                    || default_rank < entry.default_rank.unwrap_or(i64::MAX)
                {
                    entry.default_id = Some(default_id.clone());
                    entry.default_rank = Some(default_rank);
                    entry.label = label.clone();
                    entry.kind = kind.clone();
                }
                if entry.display_path.is_empty() {
                    entry.display_path = path.to_string_lossy().to_string();
                }
                continue;
            }
        }
        let mut matched: Option<String> = None;
        for (id, probe) in &existing_pairs {
            if same_file_equal(&path, probe) {
                matched = Some(id.clone());
                break;
            }
        }
        if let Some(id) = matched {
            if let Some(entry) = by_id.get_mut(&id) {
                entry.path_keys.insert(key.clone());
                alias_to_id.insert(key, id.clone());
                dirty = true;
                if entry.default_rank.is_none()
                    || default_rank < entry.default_rank.unwrap_or(i64::MAX)
                {
                    entry.default_id = Some(default_id.clone());
                    entry.default_rank = Some(default_rank);
                    entry.label = label.clone();
                    entry.kind = kind.clone();
                }
                continue;
            }
        }
        let new_id = uuid::Uuid::new_v4().to_string();
        let mut keys = HashSet::new();
        keys.insert(key.clone());
        alias_to_id.insert(key, new_id.clone());
        by_id.insert(
            new_id.clone(),
            MergedEntry {
                directory_id: new_id,
                display_path: path.to_string_lossy().to_string(),
                label: label.clone(),
                kind: kind.clone(),
                last_used_at_ms: None,
                time_source: None,
                legacy_rank: None,
                default_id: Some(default_id),
                default_rank: Some(default_rank),
                path_keys: keys,
                probe_path: path,
            },
        );
        dirty = true;
    }

    // Persist first-seen defaults + new aliases only when the set changed.
    if dirty {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("storage: {e}"))?;
        tx.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("storage: {e}"))?;
        for entry in by_id.values() {
            tx.execute(
                "INSERT OR IGNORE INTO welcome_directory_usage
                 (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                params![
                    entry.directory_id,
                    entry.display_path,
                    entry.last_used_at_ms,
                    entry.time_source,
                    entry.legacy_rank
                ],
            ).map_err(|e| format!("storage: {e}"))?;
            for k in &entry.path_keys {
                tx.execute(
                    "INSERT OR IGNORE INTO welcome_directory_alias (path_key, directory_id) VALUES (?1, ?2)",
                    params![k, entry.directory_id],
                ).map_err(|e| format!("storage: {e}"))?;
            }
        }
        bump_revision_tx(&tx).map_err(|e| format!("storage: {e}"))?;
        tx.commit().map_err(|e| format!("storage: {e}"))?;
    }

    let revision = current_revision(conn);
    let mut entries: Vec<MergedEntry> = by_id.into_values().collect();
    // Fill labels for usage-only rows.
    for e in entries.iter_mut() {
        if e.label.is_empty() {
            let p = PathBuf::from(&e.display_path);
            e.label = p
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or("Directory")
                .to_string();
        }
        if e.default_id.is_some() && e.kind.is_empty() {
            e.kind = "system".to_string();
        }
        if e.kind.is_empty() {
            e.kind = "personal".to_string();
        }
    }
    entries.sort_by(compare_merged);
    // Cap: all defaults + at most 24 non-default recents, then unified order.
    let mut defaults: Vec<MergedEntry> = Vec::new();
    let mut recents: Vec<MergedEntry> = Vec::new();
    for e in entries {
        if e.default_id.is_some() {
            defaults.push(e);
        } else {
            recents.push(e);
        }
    }
    // `recents` already sorted; keep the first 24 by unified order. To honor
    // "defaults plus recents, unified sort", merge then re-sort the union.
    if recents.len() > 24 {
        recents.truncate(24);
    }
    let mut combined = defaults;
    combined.extend(recents);
    combined.sort_by(compare_merged);

    let directories = combined
        .into_iter()
        .map(|e| {
            let availability = availability_for(&e.probe_path);
            let time_source = e.time_source.as_deref().map(|s| {
                if s == "local-start" {
                    "local-start".to_string()
                } else {
                    "local-cwd".to_string()
                }
            });
            let kind = if e.kind == "system" {
                "system".to_string()
            } else {
                "personal".to_string()
            };
            LocalDirectoryShortcut {
                label: e.label,
                path: e.display_path,
                kind,
                directory_id: e.directory_id,
                last_used_at_ms: e.last_used_at_ms,
                time_source,
                legacy_rank: e.legacy_rank,
                default_id: e.default_id,
                availability,
            }
        })
        .collect();
    Ok(DirectoryListResponse {
        revision,
        directories,
    })
}

pub fn strip_trailing_sep_pub(s: String) -> String {
    strip_trailing_sep(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(
        id: &str,
        time: Option<i64>,
        source: Option<&str>,
        legacy: Option<i64>,
        default_id: Option<&str>,
    ) -> MergedEntry {
        MergedEntry {
            directory_id: id.to_string(),
            display_path: format!("/{id}"),
            label: id.to_string(),
            kind: "personal".to_string(),
            last_used_at_ms: time,
            time_source: source.map(|s| s.to_string()),
            legacy_rank: legacy,
            default_id: default_id.map(|s| s.to_string()),
            default_rank: default_rank_for_id(default_id),
            path_keys: HashSet::from([format!("/{id}")]),
            probe_path: PathBuf::from(format!("/{id}")),
        }
    }

    #[test]
    fn confirmed_times_sort_desc_with_stable_identity_tiebreak() {
        let mut entries = vec![
            shortcut("b", Some(2000), Some("local-start"), None, None),
            shortcut("a", Some(3000), Some("local-start"), None, None),
            shortcut("c", Some(1000), Some("local-cwd"), None, None),
        ];
        entries.sort_by(compare_merged);
        let ids: Vec<_> = entries.iter().map(|e| e.directory_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn same_time_prefers_start_source_then_identity() {
        let mut entries = vec![
            shortcut("b", Some(1000), Some("local-cwd"), None, None),
            shortcut("a", Some(1000), Some("local-start"), None, None),
        ];
        entries.sort_by(compare_merged);
        assert_eq!(entries[0].directory_id, "a");
    }

    #[test]
    fn legacy_default_and_compat_buckets_order() {
        let mut entries = vec![
            shortcut("compat", None, None, None, None),
            shortcut("default", None, None, None, Some("home")),
            shortcut("legacy", None, None, Some(0), None),
            shortcut("used", Some(5), Some("local-cwd"), None, None),
        ];
        entries.sort_by(compare_merged);
        let ids: Vec<_> = entries.iter().map(|e| e.directory_id.as_str()).collect();
        assert_eq!(ids, vec!["used", "legacy", "default", "compat"]);
    }

    #[test]
    fn unix_backslash_and_spaces_are_literal() {
        assert_eq!(
            normalize_lexical_key("/tmp/my app", false).unwrap(),
            "/tmp/my app"
        );
        assert_eq!(
            normalize_lexical_key("/tmp/a\\b", false).unwrap(),
            "/tmp/a\\b"
        );
        assert!(normalize_lexical_key("relative/path", false).is_err());
        assert!(normalize_lexical_key("", false).is_err());
    }

    #[test]
    fn windows_drive_and_unc_keys() {
        assert_eq!(
            normalize_lexical_key("c:\\Users\\Ada", true).unwrap(),
            "C:/Users/Ada"
        );
        assert_eq!(normalize_lexical_key("C:/", true).unwrap(), "C:/");
        assert!(normalize_lexical_key("C:relative", true).is_err());
    }

    #[test]
    fn stale_response_never_moves_time_backwards() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!("taomni-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();
        record_successful_use(&conn, &path, "local-start", 3000).unwrap();
        record_successful_use(&conn, &path, "local-cwd", 1000).unwrap();
        let list = list_directory_shortcuts(&conn).unwrap();
        let found = list.directories.iter().find(|d| d.path == path).unwrap();
        assert_eq!(found.last_used_at_ms, Some(3000));
        assert_eq!(found.time_source.as_deref(), Some("local-start"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_is_idempotent_and_keeps_null_confirmed_time() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE command_history (id INTEGER PRIMARY KEY AUTOINCREMENT, host_key TEXT NOT NULL, command TEXT NOT NULL, last_used_at INTEGER NOT NULL, use_count INTEGER NOT NULL DEFAULT 1, UNIQUE(host_key, command));
             CREATE TABLE welcome_directory_usage (directory_id TEXT PRIMARY KEY, display_path TEXT NOT NULL, last_used_at_ms INTEGER, last_use_source TEXT, legacy_rank INTEGER, legacy_observed_at_ms INTEGER);
             CREATE TABLE welcome_directory_alias (path_key TEXT PRIMARY KEY, directory_id TEXT NOT NULL);
             CREATE TABLE welcome_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', 'cd /tmp', 100), ('local', 'not a dir command', 200), ('local', 'cd /var', -5)",
            [],
        )
        .unwrap();
        assert!(migrate_legacy_history(&conn).unwrap());
        assert!(!migrate_legacy_history(&conn).unwrap());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM welcome_directory_usage", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(count >= 1);
        let nulls: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM welcome_directory_usage WHERE last_used_at_ms IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(nulls, count);
    }
}
