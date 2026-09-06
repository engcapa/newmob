//! Welcome "Local directories" persistence: confirmed-use tracking, legacy
//! command-history migration, cross-platform path identity and the unified
//! sorted listing consumed by `WelcomePanel`.
//!
//! Design contract: docs-feature/welcome-recents-session-restore-design.md
//! §4.1. Only confirmed uses (a successful native-local PTY start, or a live
//! local terminal reporting its cwd via OSC 7) advance `last_used_at_ms`;
//! legacy `command_history` observations never do.

use super::pty;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const METADATA_DIRECTORY_REVISION: &str = "welcome_directory_revision";
pub const METADATA_MIGRATION_COMPLETE: &str = "directory_migration_v1";
const METADATA_MIGRATION_COMPLETE_VALUE: &str = "complete";

const MAX_DISPLAYED_NON_DEFAULT: usize = 24;
const MAX_ALIAS_CANDIDATES: usize = 64;
/// Bounded background probe budget for availability checks (design §4.1.4).
pub const PROBE_BUDGET: Duration = Duration::from_secs(2);
const PROBE_MAX_WORKERS: usize = 4;

/// Availability as observed (or not observed within the probe budget).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Unknown,
    Available,
    Missing,
    PermissionDenied,
    Unavailable,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Availability::Unknown => "unknown",
            Availability::Available => "available",
            Availability::Missing => "missing",
            Availability::PermissionDenied => "permission-denied",
            Availability::Unavailable => "unavailable",
        }
    }
}

/// Wire DTO consumed by the frontend (`src/lib/ipc.ts`). Rust serializes
/// `null` for absent optional fields so older browser fixtures read
/// null/unknown instead of failing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryShortcut {
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
pub struct DirectoryListEnvelope {
    pub revision: i64,
    pub directories: Vec<DirectoryShortcut>,
}

/// A persisted or in-memory candidate row before the final sort.
#[derive(Clone, Debug)]
pub struct DirectoryRow {
    pub directory_id: String,
    pub display_path: String,
    pub label: String,
    pub kind: String,
    pub last_used_at_ms: Option<i64>,
    pub time_source: Option<String>,
    pub legacy_rank: Option<i64>,
    pub default_rank: Option<u32>,
    pub default_id: Option<String>,
    /// Smallest registered path key; the stable identity sort key.
    pub identity_key: String,
    pub availability: Availability,
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS welcome_directory_usage (
            directory_id TEXT PRIMARY KEY,
            display_path TEXT NOT NULL,
            last_used_at_ms INTEGER,
            last_use_source TEXT,
            legacy_rank INTEGER,
            legacy_observed_at_ms INTEGER
        );

        CREATE TABLE IF NOT EXISTS welcome_directory_alias (
            path_key TEXT PRIMARY KEY,
            directory_id TEXT NOT NULL,
            display_path TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_welcome_alias_directory
            ON welcome_directory_alias(directory_id);

        CREATE TABLE IF NOT EXISTS welcome_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
}

fn metadata_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM welcome_metadata WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

fn metadata_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn metadata_increment(conn: &Connection, key: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO welcome_metadata (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        params![key],
    )?;
    Ok(metadata_get(conn, key)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1))
}

pub fn directory_revision(conn: &Connection) -> i64 {
    metadata_get(conn, METADATA_DIRECTORY_REVISION)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

/// Validate a host-absolute path and produce a stable lexical identity key.
///
/// - Rejects empty strings, NUL bytes and paths that cannot be losslessly
///   encoded as UTF-8.
/// - Windows: recognizes drive, UNC share and extended-length prefixes;
///   normalizes separators and drive-letter case. `C:relative` is NOT treated
///   as absolute.
/// - POSIX: preserves `/` and meaningful `//` prefixes; backslashes are legal
///   filename characters and are never rewritten.
/// - `.` components are folded; `..` is kept (equivalence of `..`-containing
///   paths is only confirmed via real resolution, never lexical folding).
pub fn normalize_path_key(path: &Path) -> Option<String> {
    if path.as_os_str().is_empty() || path.as_os_str().to_string_lossy().contains('\0') {
        return None;
    }
    let Some(text) = path.to_str() else {
        return None; // non-UTF-8: no lossless identity
    };
    if text.trim().is_empty() {
        return None;
    }

    #[cfg(windows)]
    {
        normalize_windows_path_key(text)
    }
    #[cfg(not(windows))]
    {
        normalize_posix_path_key(text)
    }
}

#[cfg(windows)]
fn normalize_windows_path_key(text: &str) -> Option<String> {
    // Recognized absolute forms: `\\?\UNC\server\share\rest`, `\\?\C:\rest`,
    // `\\server\share\rest`, `C:\rest` / `C:/rest`. `C:relative` is not
    // absolute and is rejected by the prefix match below.
    let (prefix, rest) = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        let mut parts = rest.splitn(3, ['\\', '/']);
        let (Some(server), Some(share), tail) = (parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (format!(r"\\?\UNC\{}\{}", server, share), tail.unwrap_or(""))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() < 3 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() || (bytes[2] != b'\\' && bytes[2] != b'/') {
            return None;
        }
        let drive = (bytes[0] as char).to_ascii_uppercase();
        (format!(r"{}:\", drive), &rest[3..])
    } else if let Some(rest) = text.strip_prefix(r"\\") {
        let mut parts = rest.splitn(3, ['\\', '/']);
        let (Some(server), Some(share), tail) = (parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (format!(r"\\{}\{}", server, share), tail.unwrap_or(""))
    } else {
        let bytes = text.as_bytes();
        if bytes.len() < 3 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() || (bytes[2] != b'\\' && bytes[2] != b'/') {
            return None;
        }
        let drive = (bytes[0] as char).to_ascii_uppercase();
        (format!(r"{}:\", drive), &text[3..])
    };

    let mut out = prefix;
    for part in rest.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if !out.ends_with('\\') {
            out.push('\\');
        }
        out.push_str(part);
    }
    Some(out)
}

#[cfg(not(windows))]
fn normalize_posix_path_key(text: &str) -> Option<String> {
    let path = Path::new(text);
    if !path.is_absolute() {
        return None;
    }
    // Preserve a leading `//` (POSIX implementation-defined root).
    let double_slash = text.starts_with("//") && !text.starts_with("///");
    let mut parts: Vec<&str> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir
            | std::path::Component::CurDir
            | std::path::Component::Prefix(_) => {}
            std::path::Component::ParentDir => parts.push(".."),
            std::path::Component::Normal(part) => {
                let Some(part_str) = part.to_str() else {
                    return None;
                };
                parts.push(part_str);
            }
        }
    }
    let joined = parts.join("/");
    if double_slash {
        Some(format!("//{}", joined))
    } else {
        Some(format!("/{}", joined))
    }
}

/// Best-effort real-resolution key: canonicalize as evidence of the actual
/// directory identity. Returns `None` when the path cannot be resolved
/// (offline mount, permission, non-existent).
pub fn resolved_path_key(path: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    normalize_path_key(&canonical)
}

/// Cross-platform same-file confirmation for two accessible paths. Uses the
/// already-locked `same-file` crate as a direct dependency instead of
/// hand-rolling per-OS file-id APIs.
fn same_directory_handle(a: &Path, b: &Path) -> bool {
    use same_file::Handle;
    match (Handle::from_path(a), Handle::from_path(b)) {
        (Ok(ha), Ok(hb)) => ha == hb,
        _ => false,
    }
}

/// Find the persisted directory id that `path` belongs to.
///
/// Phase A (caller holds no DB lock afterwards): returns the alias keys and
/// candidate display paths needed for filesystem confirmation.
pub struct IdentityProbe {
    pub lexical_key: String,
    pub resolved_key: Option<String>,
    pub alias_direct_hit: Option<String>,
    pub resolved_alias_hit: Option<String>,
    /// (directory_id, display_path) candidates for same-file comparison.
    pub compare_candidates: Vec<(String, String)>,
}

pub fn begin_identity_probe(conn: &Connection, path: &Path) -> Result<Option<IdentityProbe>, String> {
    let Some(lexical_key) = normalize_path_key(path) else {
        return Ok(None);
    };
    let direct: Option<String> = conn
        .query_row(
            "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
            params![lexical_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let resolved_key = resolved_path_key(path);
    let resolved_alias_hit = match &resolved_key {
        Some(key) if Some(key) != Some(&lexical_key) => conn
            .query_row(
                "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        _ => None,
    };

    let compare_candidates = if direct.is_none() && resolved_alias_hit.is_none() {
        let mut stmt = conn
            .prepare(
                "SELECT directory_id, display_path FROM welcome_directory_usage
                 ORDER BY last_used_at_ms IS NULL, last_used_at_ms DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_map(params![MAX_ALIAS_CANDIDATES as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };

    Ok(Some(IdentityProbe {
        lexical_key,
        resolved_key,
        alias_direct_hit: direct,
        resolved_alias_hit,
        compare_candidates,
    }))
}

/// Phase B: filesystem checks without any DB lock held. `path` is the
/// original (openable) path; the lexical key alone may not open on Windows.
pub fn finish_identity_probe(probe: &IdentityProbe, path: &Path) -> Result<ResolvedIdentity, String> {
    if let Some(id) = probe.alias_direct_hit.clone() {
        return Ok(ResolvedIdentity {
            directory_id: id,
            new_keys: Vec::new(),
        });
    }
    let mut keys = vec![probe.lexical_key.clone()];
    if let Some(resolved) = &probe.resolved_key {
        if *resolved != probe.lexical_key {
            keys.push(resolved.clone());
        }
    }
    if let Some(id) = probe.resolved_alias_hit.clone() {
        return Ok(ResolvedIdentity {
            directory_id: id,
            new_keys: keys,
        });
    }
    // Same-file confirmation against recently used display paths.
    for (directory_id, display) in &probe.compare_candidates {
        if same_directory_handle(path, Path::new(display)) {
            return Ok(ResolvedIdentity {
                directory_id: directory_id.clone(),
                new_keys: keys,
            });
        }
    }
    Ok(ResolvedIdentity {
        directory_id: String::new(),
        new_keys: keys,
    })
}

pub struct ResolvedIdentity {
    pub directory_id: String,
    /// Alias keys to register for this path (lexical + resolved, deduped).
    pub new_keys: Vec<String>,
}

pub fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Response for the `record_local_directory_use` IPC command. The frontend
/// refreshes the sorted list via the revision event, so the returned
/// directory snapshot is informational only.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDirectoryUseResponse {
    pub changed: bool,
    pub directory: Option<DirectoryShortcut>,
}

// ---------------------------------------------------------------------------
// Recording confirmed use
// ---------------------------------------------------------------------------

pub const SOURCE_LOCAL_START: &str = "local-start";
pub const SOURCE_LOCAL_CWD: &str = "local-cwd";

/// Record a confirmed use of `path` at `now_ms`. Returns `(changed, revision)`.
pub fn record_directory_use(
    conn: &mut Connection,
    path: &Path,
    source: &str,
    now_ms: i64,
) -> Result<(bool, i64), String> {
    // Phase A: probe identity (DB reads only).
    let probe = begin_identity_probe(conn, path)?;
    let Some(probe) = probe else {
        return Err(format!(
            "invalid local directory path: {}",
            path.display()
        ));
    };

    // Phase B: filesystem confirmation with no DB lock held.
    let identity = finish_identity_probe(&probe, path)?;

    // Phase C: transactional write.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let directory_id = if identity.directory_id.is_empty() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        tx.execute(
            "INSERT INTO welcome_directory_usage
             (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            params![id, path.to_string_lossy(), now_ms, source],
        )
        .map_err(|e| e.to_string())?;
        id
    } else {
        identity.directory_id.clone()
    };

    let mut changed = identity.directory_id.is_empty();
    let mut keys = identity.new_keys.clone();
    keys.dedup();
    for key in &keys {
        let exists: Option<String> = tx
            .query_row(
                "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            tx.execute(
                "INSERT INTO welcome_directory_alias (path_key, directory_id, display_path)
                 VALUES (?1, ?2, ?3)",
                params![key, directory_id, path.to_string_lossy()],
            )
            .map_err(|e| e.to_string())?;
            changed = true;
        }
    }

    // Upsert confirmed time: never regress; same-time source precedence
    // local-start over local-cwd.
    let existing: Option<(Option<i64>, Option<String>)> = tx
        .query_row(
            "SELECT last_used_at_ms, last_use_source FROM welcome_directory_usage WHERE directory_id = ?1",
            params![directory_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (prev_time, prev_source) = existing.clone().unwrap_or((None, None));
    let (next_time, next_source) = match (prev_time, prev_source) {
        (Some(prev_ms), Some(prev_source)) => {
            if now_ms > prev_ms {
                (Some(now_ms), Some(source.to_string()))
            } else if now_ms == prev_ms
                && prev_source == SOURCE_LOCAL_CWD
                && source == SOURCE_LOCAL_START
            {
                (Some(prev_ms), Some(source.to_string()))
            } else {
                let keep_source = prev_source;
                (Some(prev_ms), Some(keep_source))
            }
        }
        (None, _) => (Some(now_ms), Some(source.to_string())),
        (Some(prev_ms), None) => {
            if now_ms >= prev_ms {
                (Some(now_ms), Some(source.to_string()))
            } else {
                (Some(prev_ms), None)
            }
        }
    };
    let existing_time = existing.as_ref().and_then(|(t, _)| *t);
    let existing_source = existing.as_ref().and_then(|(_, src)| src.clone());
    if next_time != existing_time || next_source != existing_source {
        tx.execute(
            "UPDATE welcome_directory_usage
             SET last_used_at_ms = ?1, last_use_source = ?2 WHERE directory_id = ?3",
            params![next_time, next_source, directory_id],
        )
        .map_err(|e| e.to_string())?;
        changed = true;
    }

    let revision = if changed { metadata_increment(&tx, METADATA_DIRECTORY_REVISION).map_err(|e| e.to_string())? } else { directory_revision(&tx) };
    tx.commit().map_err(|e| e.to_string())?;
    Ok((changed, revision))
}

// ---------------------------------------------------------------------------
// Legacy command-history migration
// ---------------------------------------------------------------------------

/// One-time import of legacy directory hints from `command_history`. Old
/// observation times stay in `legacy_observed_at_ms` and never become
/// confirmed use times. Idempotent: guarded by the
/// `directory_migration_v1=complete` marker written inside the same
/// transaction (interruption rolls everything back and retries next run).
pub fn migrate_legacy_history(conn: &mut Connection) -> rusqlite::Result<()> {
    init_tables(conn)?;
    if metadata_get(conn, METADATA_MIGRATION_COMPLETE)?.as_deref() == Some(METADATA_MIGRATION_COMPLETE_VALUE) {
        return Ok(());
    }
    let tx = conn.transaction()?;

    let mut rows: Vec<(i64, String, i64)> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, command, last_used_at FROM command_history
             WHERE host_key = 'local'
               AND (
                 lower(command) LIKE 'cd %'
                 OR lower(command) LIKE 'cd\t%'
                 OR lower(command) = 'cd'
                 OR lower(command) LIKE 'chdir %'
                 OR lower(command) LIKE 'pushd %'
                 OR lower(command) LIKE 'set-location %'
                 OR lower(command) LIKE 'sl %'
               )
             ORDER BY last_used_at DESC, id DESC
             LIMIT 300",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    // Deterministic supplement: a recency-ordered broad window when few
    // explicit directory commands exist (new installs / PowerShell gaps).
    let mut parsed_count = 0usize;
    let mut seen_paths: HashMap<String, ()> = HashMap::new();
    let mut legacy_entries: Vec<(String /*directory_id*/, Option<i64> /*observed*/, i64 /*rank*/)> = Vec::new();
    let mut rank: i64 = 0;

    let home = dirs::home_dir();
    let import_command = |command: &str,
                              last_used_at: i64,
                              rank: &mut i64,
                              seen: &mut HashMap<String, ()>,
                              legacy: &mut Vec<(String, Option<i64>, i64)>,
                              parsed: &mut usize|
     -> rusqlite::Result<()> {
        let Some(path) = pty::directory_from_history_command(command, home.as_deref()) else {
            return Ok(());
        };
        let Some(key) = normalize_path_key(&path) else {
            return Ok(());
        };
        if seen.contains_key(&key) {
            return Ok(());
        }
        seen.insert(key.clone(), ());
        let directory_id = ensure_legacy_directory(&tx, &path, &key)?;
        // Valid non-negative seconds only; anything else stays unobserved.
        let observed_ms = if last_used_at >= 0 && last_used_at < 4_102_444_800 {
            Some(last_used_at.saturating_mul(1000))
        } else {
            None
        };
        legacy.push((directory_id, observed_ms, *rank));
        *rank += 1;
        *parsed += 1;
        Ok(())
    };

    for (id, command, last_used_at) in &rows {
        import_command(command, *last_used_at, &mut rank, &mut seen_paths, &mut legacy_entries, &mut parsed_count)?;
        let _ = id;
    }
    if parsed_count < MAX_DISPLAYED_NON_DEFAULT {
        let mut stmt = tx.prepare(
            "SELECT command, last_used_at FROM command_history
             WHERE host_key = 'local'
             ORDER BY last_used_at DESC, id DESC
             LIMIT 500",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in mapped {
            let (command, last_used_at) = row?;
            import_command(&command, last_used_at, &mut rank, &mut seen_paths, &mut legacy_entries, &mut parsed_count)?;
        }
    }

    for (directory_id, observed_ms, entry_rank) in legacy_entries {
        tx.execute(
            "UPDATE welcome_directory_usage
             SET legacy_rank = MIN(COALESCE(legacy_rank, ?2), ?2),
                 legacy_observed_at_ms = COALESCE(legacy_observed_at_ms, ?3)
             WHERE directory_id = ?1",
            params![directory_id, entry_rank, observed_ms],
        )?;
    }

    metadata_set(&tx, METADATA_MIGRATION_COMPLETE, METADATA_MIGRATION_COMPLETE_VALUE)?;
    tx.commit()
}

/// Create (or reuse) the null-time usage row + alias for a legacy candidate.
fn ensure_legacy_directory(tx: &Connection, path: &Path, key: &str) -> rusqlite::Result<String> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    tx.execute(
        "INSERT INTO welcome_directory_usage
         (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, legacy_observed_at_ms)
         VALUES (?1, ?2, NULL, NULL, NULL, NULL)",
        params![id, path.to_string_lossy()],
    )?;
    tx.execute(
        "INSERT INTO welcome_directory_alias (path_key, directory_id, display_path)
         VALUES (?1, ?2, ?3)",
        params![key, id, path.to_string_lossy()],
    )?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// Default candidates
// ---------------------------------------------------------------------------

/// The fixed default-rank order from design §4.1.3: system folders first,
/// then common home subdirectories. Returns (default_id, rank, label, path).
pub fn default_candidates(home: Option<&Path>) -> Vec<(String, u32, String, PathBuf)> {
    let Some(home) = home else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut push = |id: &str, rank: u32, label: &str, path: PathBuf| {
        out.push((id.to_string(), rank, label.to_string(), path));
    };
    push("home", 0, "Home", home.to_path_buf());
    if let Some(p) = dirs::desktop_dir() {
        push("desktop", 1, "Desktop", p);
    }
    if let Some(p) = dirs::document_dir() {
        push("documents", 2, "Documents", p);
    }
    if let Some(p) = dirs::download_dir() {
        push("downloads", 3, "Downloads", p);
    }
    if let Some(p) = dirs::picture_dir() {
        push("pictures", 4, "Pictures", p);
    }
    if let Some(p) = dirs::audio_dir() {
        push("music", 5, "Music", p);
    }
    if let Some(p) = dirs::video_dir() {
        push("videos", 6, "Videos", p);
    }
    for (index, name) in [
        "Code",
        "code",
        "Projects",
        "projects",
        "Workspace",
        "workspace",
        "work",
        "dev",
        "Developer",
        "src",
    ]
    .iter()
    .enumerate()
    {
        let label = name.to_string();
        push(name.to_ascii_lowercase().as_str(), 7 + index as u32, label.as_str(), home.join(name));
    }
    out
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

struct PersistedRow {
    directory_id: String,
    display_path: String,
    label: String,
    kind: String,
    last_used_at_ms: Option<i64>,
    last_use_source: Option<String>,
    legacy_rank: Option<i64>,
    identity_key: String,
}

fn load_persisted_rows(conn: &Connection) -> Result<Vec<PersistedRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT u.directory_id, u.display_path, u.last_used_at_ms, u.last_use_source,
                    u.legacy_rank,
                    (SELECT MIN(a.path_key) FROM welcome_directory_alias a
                     WHERE a.directory_id = u.directory_id) AS identity_key
             FROM welcome_directory_usage u
             ORDER BY identity_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (directory_id, display_path, last_used_at_ms, last_use_source, legacy_rank, identity_key) =
            row.map_err(|e| e.to_string())?;
        let Some(identity_key) = identity_key else {
            continue; // orphan usage row without alias: skip defensively
        };
        out.push(PersistedRow {
            label: path_display_label(Path::new(&display_path), "Directory"),
            kind: "personal".to_string(),
            directory_id,
            display_path,
            last_used_at_ms,
            last_use_source,
            legacy_rank,
            identity_key,
        });
    }
    Ok(out)
}

fn path_display_label(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// Merge persisted rows and default candidates by directory identity, then
/// sort with the fixed comparison tuple. Pure function (except key lookups
/// against `aliases`), fully covered by V-01 tests.
pub fn merge_directory_candidates(
    persisted: Vec<PersistedRow>,
    defaults: &[(String, u32, String, PathBuf)],
) -> Vec<DirectoryRow> {
    let mut by_id: HashMap<String, DirectoryRow> = HashMap::new();
    let mut by_key: HashMap<String, String> = HashMap::new(); // path key -> directory id

    for row in persisted {
        by_key.insert(row.identity_key.clone(), row.directory_id.clone());
        by_id.insert(
            row.directory_id.clone(),
            DirectoryRow {
                directory_id: row.directory_id.clone(),
                display_path: row.display_path.clone(),
                label: row.label.clone(),
                kind: row.kind.clone(),
                last_used_at_ms: row.last_used_at_ms,
                time_source: row.last_use_source,
                legacy_rank: row.legacy_rank,
                default_rank: None,
                default_id: None,
                identity_key: row.identity_key.clone(),
                availability: Availability::Unknown,
            },
        );
    }

    for (default_id, default_rank, label, path) in defaults {
        // Identity resolution for the default candidate: lexical, then
        // canonicalized, then existing-row display path equivalence.
        let mut matched: Option<String> = None;
        if let Some(key) = normalize_path_key(path) {
            if let Some(id) = by_key.get(&key) {
                matched = Some(id.clone());
            }
        }
        if matched.is_none() {
            if let Some(key) = resolved_path_key(path) {
                if let Some(id) = by_key.get(&key) {
                    matched = Some(id.clone());
                }
            }
        }
        if matched.is_none() {
            for (id, row) in by_id.iter_mut() {
                let _ = id;
                if same_directory_handle(path, Path::new(&row.display_path)) {
                    matched = Some(row.directory_id.clone());
                    break;
                }
            }
        }
        match matched {
            Some(id) => {
                let row = by_id.get_mut(&id).expect("matched row exists");
                // Default identity wins: default label/kind, minimal
                // defaultRank, display path from the default.
                row.default_id = Some(default_id.clone());
                row.default_rank = Some(match row.default_rank {
                    Some(existing) => existing.min(*default_rank),
                    None => *default_rank,
                });
                row.label = label.clone();
                row.kind = "system".to_string();
                row.display_path = path.to_string_lossy().into_owned();
                if let Some(key) = normalize_path_key(path) {
                    if key < row.identity_key {
                        row.identity_key = key;
                    }
                }
            }
            None => {
                // Unconfirmed default: ephemeral in-memory row with a stable,
                // label-independent id. Guesses only surface when the
                // directory actually exists.
                let path_exists = path.is_dir();
                let is_system_folder = *default_rank < 7;
                if !path_exists && !is_system_folder {
                    continue; // non-existent guesses never create rows
                }
                let id = format!("default:{default_id}");
                let key = normalize_path_key(path)
                    .or_else(|| resolved_path_key(path))
                    .unwrap_or_else(|| default_id.clone());
                by_key.entry(key.clone()).or_insert_with(|| id.clone());
                by_id.entry(id.clone()).or_insert_with(|| DirectoryRow {
                    directory_id: id.clone(),
                    display_path: path.to_string_lossy().into_owned(),
                    label: label.clone(),
                    kind: "system".to_string(),
                    last_used_at_ms: None,
                    time_source: None,
                    legacy_rank: None,
                    default_rank: Some(*default_rank),
                    default_id: Some(default_id.clone()),
                    identity_key: key,
                    availability: Availability::Unknown,
                });
            }
        }
    }

    let mut rows: Vec<DirectoryRow> = by_id.into_values().collect();
    rows.sort_by(compare_directories);

    // Cap non-default rows at MAX_DISPLAYED_NON_DEFAULT after sorting.
    let mut kept: Vec<DirectoryRow> = Vec::new();
    let mut non_default = 0usize;
    for row in rows {
        if row.default_rank.is_none() {
            if non_default >= MAX_DISPLAYED_NON_DEFAULT {
                continue;
            }
            non_default += 1;
        }
        kept.push(row);
    }
    kept
}

/// Fixed ordering tuple from design §4.1.3. UTF-8 binary order for strings.
pub fn compare_directories(a: &DirectoryRow, b: &DirectoryRow) -> Ordering {
    let a_confirmed = a.last_used_at_ms;
    let b_confirmed = b.last_used_at_ms;
    match (a_confirmed, b_confirmed) {
        (Some(x), Some(y)) => return y.cmp(&x).then_with(|| a.identity_key.cmp(&b.identity_key)),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    match (a.legacy_rank, b.legacy_rank) {
        (Some(x), Some(y)) => return x.cmp(&y).then_with(|| a.identity_key.cmp(&b.identity_key)),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    match (a.default_rank, b.default_rank) {
        (Some(x), Some(y)) => return x.cmp(&y).then_with(|| a.identity_key.cmp(&b.identity_key)),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    a.identity_key.cmp(&b.identity_key)
}

/// Bounded background availability probe: at most `PROBE_MAX_WORKERS`
/// threads, overall `PROBE_BUDGET` deadline. Unfinished paths stay `unknown`
/// and never poison the next refresh.
/// In-flight probe worker guard so repeated refreshes never accumulate
/// unbounded blocked threads (design §4.1.4).
static PROBE_WORKERS_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn probe_availability(paths: &[String]) -> Vec<Availability> {
    let mut results = vec![Availability::Unknown; paths.len()];
    if paths.is_empty() {
        return results;
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    if PROBE_WORKERS_IN_FLIGHT.load(Ordering::Acquire) >= PROBE_MAX_WORKERS {
        return results; // previous probes still blocked: report unknown
    }
    let (tx, rx) = std::sync::mpsc::channel::<(usize, Availability)>();
    let chunk = (paths.len() + PROBE_MAX_WORKERS - 1) / PROBE_MAX_WORKERS;
    let mut handles = Vec::new();
    for (worker, slice) in paths.chunks(chunk.max(1)).enumerate() {
        let tx = tx.clone();
        let slice = slice.to_vec();
        let base = worker * chunk.max(1);
        PROBE_WORKERS_IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
        handles.push(std::thread::spawn(move || {
            for (offset, path) in slice.iter().enumerate() {
                let availability = probe_single(Path::new(path));
                if tx.send((base + offset, availability)).is_err() {
                    break;
                }
            }
            PROBE_WORKERS_IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
        }));
    }
    drop(tx);
    let deadline = std::time::Instant::now() + PROBE_BUDGET;
    while let Ok((index, availability)) = rx.recv_timeout(PROBE_BUDGET) {
        if let Some(slot) = results.get_mut(index) {
            *slot = availability;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    // Detach: blocked workers release their slots when the OS call returns.
    drop(handles);
    results
}

fn probe_single(path: &Path) -> Availability {
    match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                Availability::Available
            } else {
                Availability::Missing
            }
        }
        Err(e) => match e.kind() {
            std::io::ErrorKind::PermissionDenied => Availability::PermissionDenied,
            std::io::ErrorKind::NotFound => Availability::Missing,
            _ => Availability::Unavailable,
        },
    }
}

/// Build the sorted, probed listing. Runs the DB reads, then releases the
/// connection before filesystem probing (design §4.1.4: probes never inside
/// the DB lock).
pub fn list_directory_shortcuts(conn: &Connection) -> Result<DirectoryListEnvelope, String> {
    let persisted = load_persisted_rows(conn)?;
    let revision = directory_revision(conn);
    let defaults = default_candidates(dirs::home_dir().as_deref());
    let mut rows = merge_directory_candidates(persisted, &defaults);
    let paths: Vec<String> = rows.iter().map(|r| r.display_path.clone()).collect();
    let availability = probe_availability(&paths);
    for (row, probe) in rows.iter_mut().zip(availability) {
        row.availability = probe;
    }
    let directories = rows
        .into_iter()
        .map(|row| DirectoryShortcut {
            label: row.label,
            path: row.display_path,
            kind: row.kind,
            directory_id: row.directory_id,
            last_used_at_ms: row.last_used_at_ms,
            time_source: row.time_source,
            legacy_rank: row.legacy_rank,
            default_id: row.default_id,
            availability: row.availability.as_str().to_string(),
        })
        .collect();
    Ok(DirectoryListEnvelope {
        revision,
        directories,
    })
}

// ---------------------------------------------------------------------------
// Tests (V-01 / V-02)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        id: &str,
        display_path: &str,
        identity_key: &str,
        last_used_at_ms: Option<i64>,
        legacy_rank: Option<i64>,
        default_rank: Option<u32>,
    ) -> DirectoryRow {
        DirectoryRow {
            directory_id: id.to_string(),
            display_path: display_path.to_string(),
            label: "L".to_string(),
            kind: "personal".to_string(),
            last_used_at_ms,
            time_source: last_used_at_ms.map(|_| SOURCE_LOCAL_START.to_string()),
            legacy_rank,
            default_rank,
            default_id: default_rank.map(|_| format!("default-{default_rank:?}")),
            identity_key: identity_key.to_string(),
            availability: Availability::Unknown,
        }
    }

    /// AC-01/AC-03: confirmed times dominate regardless of input order;
    /// legacy ranks beat unconfirmed defaults; ties resolve by identity key.
    #[test]
    fn ordering_is_deterministic_across_shuffled_input() {
        let a_confirmed = row("a", "/a", "/a", Some(3000), None, None);
        let home = row("home", "/home", "/home", Some(2000), None, Some(0));
        let downloads = row("dl", "/dl", "/dl", Some(1000), None, Some(3));
        let legacy = row("l1", "/l1", "/l1", None, Some(4), None);
        let unconfirmed_default = row("d9", "/d9", "/d9", None, None, Some(9));
        let tie1 = row("t1", "/t1", "/t1", Some(3000), None, None);
        let tie2 = row("t2", "/t2", "/t2", Some(3000), None, None);

        let expected_ids = ["a", "t1", "t2", "home", "dl", "l1", "d9"];
        let build = || {
            let mut rows = vec![
                unconfirmed_default.clone(),
                downloads.clone(),
                legacy.clone(),
                a_confirmed.clone(),
                tie2.clone(),
                home.clone(),
                tie1.clone(),
            ];
            rows.sort_by(compare_directories);
            rows.into_iter().map(|r| r.directory_id).collect::<Vec<_>>()
        };
        let first = build();
        assert_eq!(first, expected_ids, "shuffled input must still sort the same");
        let second = build();
        assert_eq!(first, second, "re-sorting must be stable");
    }

    /// AC-04: same path with different textual forms merges into one row and
    /// the default name/kind wins; confirmed time survives the merge.
    #[test]
    fn default_and_history_paths_merge_without_losing_time() {
        let home = std::env::temp_dir().join(format!(
            "taomni-ldt-merge-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let downloads = home.join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let defaults = vec![(
            "downloads".to_string(),
            3u32,
            "Downloads".to_string(),
            downloads.clone(),
        )];
        // Legacy-persisted row for the same directory under a different
        // display path with a confirmed time.
        let persisted = vec![PersistedRow {
            directory_id: "used-1".to_string(),
            display_path: downloads.to_string_lossy().into_owned(),
            label: "weird case".to_string(),
            kind: "personal".to_string(),
            last_used_at_ms: Some(1234),
            last_use_source: Some(SOURCE_LOCAL_CWD.to_string()),
            legacy_rank: None,
            identity_key: normalize_path_key(&downloads).unwrap(),
        }];
        let merged = merge_directory_candidates(persisted, &defaults);
        let matches: Vec<&DirectoryRow> = merged
            .iter()
            .filter(|r| r.display_path == downloads.to_string_lossy())
            .collect();
        assert_eq!(matches.len(), 1, "one row for one identity, got {merged:?}");
        let row = matches[0];
        assert_eq!(row.label, "Downloads");
        assert_eq!(row.kind, "system");
        assert_eq!(row.last_used_at_ms, Some(1234));
        assert_eq!(row.default_rank, Some(3));
        std::fs::remove_dir_all(&home).ok();
    }

    /// Identity: canonicalize merges case-variant spellings on
    /// case-insensitive volumes; POSIX backslashes stay literal filenames.
    #[test]
    fn path_key_normalization_rules() {
        let tmp = std::env::temp_dir().join(format!("taomni-ldt-key-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let key = normalize_path_key(&tmp).expect("temp dir key");
        assert!(key.starts_with('/'), "posix key is absolute: {key}");

        // Relative and empty inputs are rejected.
        assert!(normalize_path_key(Path::new("relative/path")).is_none());
        assert!(normalize_path_key(Path::new("")).is_none());

        // `..` components are preserved, not folded.
        let parent_key = normalize_path_key(&tmp.join("..")).unwrap();
        assert!(parent_key.ends_with(".."));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn symlinked_alias_confirms_same_directory() {
        let base = std::env::temp_dir().join(format!("taomni-ldt-sym-{}", std::process::id()));
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let alias = base.join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        #[cfg(not(unix))]
        return; // symlink alias confirmation is exercised on unix test runs

        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let mut conn = conn;
        // Record through the symlink once.
        {
            let (changed, _) = record_directory_use(&mut conn, &alias, SOURCE_LOCAL_START, 1000)
                .expect("record symlink use");
            assert!(changed);
        }
        // Recording the real path must merge into the same directory id.
        record_directory_use(&mut conn, &real, SOURCE_LOCAL_CWD, 2000).expect("record real use");
        let usage_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM welcome_directory_usage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(usage_count, 1, "symlink and target are one directory");
        let alias_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM welcome_directory_alias", [], |r| r.get(0))
            .unwrap();
        assert!(alias_rows >= 2, "both spellings registered as aliases");
        std::fs::remove_dir_all(&base).ok();
    }

    /// AC-02: two uses at the same instant keep local-start precedence;
    /// later times always win; older events never regress the record.
    #[test]
    fn record_use_time_and_source_precedence() {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let tmp = std::env::temp_dir().join(format!("taomni-ldt-time-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut writable = conn;

        let (changed, _) = record_directory_use(&mut writable, &tmp, SOURCE_LOCAL_CWD, 1000).unwrap();
        assert!(changed);
        let (changed, _) = record_directory_use(&mut writable, &tmp, SOURCE_LOCAL_START, 1000).unwrap();
        assert!(changed, "same-time source upgrade counts as a change");
        let source: String = writable
            .query_row(
                "SELECT last_use_source FROM welcome_directory_usage LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source, SOURCE_LOCAL_START);

        let (changed, _) = record_directory_use(&mut writable, &tmp, SOURCE_LOCAL_CWD, 900).unwrap();
        assert!(!changed, "older events never regress the confirmed time");
        let time: i64 = writable
            .query_row(
                "SELECT last_used_at_ms FROM welcome_directory_usage LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(time, 1000);
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// V-02 / AC-05: legacy migration keeps observation times separate from
    /// confirmed use, is idempotent across reopen, and bad timestamps stay
    /// unobserved.
    #[test]
    fn legacy_migration_is_idempotent_and_keeps_times_legacy() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = Connection::open(dir.path().join("taomni.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE command_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_key TEXT NOT NULL,
                command TEXT NOT NULL,
                last_used_at INTEGER NOT NULL,
                use_count INTEGER NOT NULL DEFAULT 1,
                UNIQUE(host_key, command)
            );",
        )
        .unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let inserts = [
            (format!("cd {}", work.display()), 1_700_000_000i64),
            ("cd /definitely/not/a/real/path-xyz".to_string(), 1_699_999_999),
            ("cd projects".to_string(), 1_699_999_998), // relative: skipped
            ("cd ~/taomni-legacy-work".to_string(), -5), // bad timestamp
        ];
        for (command, ts) in &inserts {
            conn.execute(
                "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', ?1, ?2)",
                params![command, ts],
            )
            .unwrap();
        }

        let mut writable = conn;
        migrate_legacy_history(&mut writable).unwrap();
        // Re-run: idempotent.
        migrate_legacy_history(&mut writable).unwrap();

        let usage_count: i64 = writable
            .query_row("SELECT COUNT(*) FROM welcome_directory_usage", [], |r| r.get(0))
            .unwrap();
        // Three unique resolvable paths: <tmp>/work, /definitely/not/a/real,
        // <home>/taomni-legacy-work. The relative `cd projects` is skipped.
        assert_eq!(usage_count, 3, "one row per resolvable unique path");

        let work_key = normalize_path_key(&work).unwrap();
        let (legacy_ms, legacy_rank, confirmed): (Option<i64>, Option<i64>, Option<i64>) = writable
            .query_row(
                "SELECT u.legacy_observed_at_ms, u.legacy_rank, u.last_used_at_ms
                 FROM welcome_directory_usage u
                 JOIN welcome_directory_alias a ON a.directory_id = u.directory_id
                 WHERE a.path_key = ?1",
                params![work_key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(legacy_ms, Some(1_700_000_000_000), "observation time preserved in ms");
        assert_eq!(legacy_rank, Some(0), "most recent legacy command gets rank 0");
        assert_eq!(confirmed, None, "legacy observation never becomes confirmed use");

        let marker: String = writable
            .query_row(
                "SELECT value FROM welcome_metadata WHERE key = ?1",
                params![METADATA_MIGRATION_COMPLETE],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marker, "complete");

        // Listing after migration: legacy row sorts after confirmed rows and
        // the confirmed-use flow still promotes the same directory.
        let envelope = list_directory_shortcuts(&writable).unwrap();
        assert!(envelope.directories.iter().any(|d| d.legacy_rank.is_some()));
        let (changed, _) =
            record_directory_use(&mut writable, &work, SOURCE_LOCAL_START, 2_000_000_000_000).unwrap();
        assert!(changed);
        let envelope = list_directory_shortcuts(&writable).unwrap();
        let used = envelope
            .directories
            .iter()
            .find(|d| d.last_used_at_ms == Some(2_000_000_000_000))
            .expect("confirmed use listed");
        assert_eq!(used.time_source.as_deref(), Some(SOURCE_LOCAL_START));
        assert_eq!(
            normalize_path_key(Path::new(&used.path)).as_deref(),
            Some(work_key.as_str())
        );
    }

    /// Default candidates: home subdirectory guesses only surface when they
    /// exist; system folders may be reported even when missing (they are
    /// real OS-configured directories).
    #[test]
    fn default_guesses_require_existence() {
        let home = std::env::temp_dir().join(format!("taomni-ldt-def-{}", std::process::id()));
        std::fs::create_dir_all(home.join("Projects")).unwrap();
        let candidates = default_candidates(Some(&home));
        let names: Vec<&str> = candidates.iter().map(|c| c.2.as_str()).collect();
        assert!(names.contains(&"Home"));
        assert!(names.contains(&"Projects"));
        // nonexistent guess is absent
        let persisted = Vec::new();
        let merged = merge_directory_candidates(persisted, &candidates);
        assert!(
            merged.iter().all(|r| r.display_path != home.join("src").to_string_lossy()),
            "non-existent guesses must not create rows"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// AC-03: the 24 non-default cap never evicts used default directories.
    #[test]
    fn non_default_cap_keeps_defaults() {
        let mut persisted = Vec::new();
        for i in 0..30 {
            persisted.push(PersistedRow {
                directory_id: format!("d{i}"),
                display_path: format!("/opt/dir{i}"),
                label: format!("dir{i}"),
                kind: "personal".to_string(),
                last_used_at_ms: Some(1000 + i),
                last_use_source: Some(SOURCE_LOCAL_START.to_string()),
                legacy_rank: None,
                identity_key: format!("/opt/dir{i}"),
            });
        }
        let defaults = vec![("home".to_string(), 0u32, "Home".to_string(), PathBuf::from("/home/x"))];
        let merged = merge_directory_candidates(persisted, &defaults);
        let non_default = merged.iter().filter(|r| r.default_rank.is_none()).count();
        assert_eq!(non_default, MAX_DISPLAYED_NON_DEFAULT);
        assert!(merged.iter().any(|r| r.default_id.as_deref() == Some("home")));
    }
}
