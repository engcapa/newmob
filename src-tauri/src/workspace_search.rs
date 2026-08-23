use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, SearcherBuilder, sinks::UTF8};
use ignore::{WalkBuilder, overrides::OverrideBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, State};

const DEFAULT_TOTAL_MATCH_LIMIT: usize = 10_000;
const DEFAULT_FILE_MATCH_LIMIT: usize = 1_000;
const MAX_TOTAL_MATCH_LIMIT: usize = 100_000;
const MAX_FILE_MATCH_LIMIT: usize = 10_000;
const EVENT_BATCH_SIZE: usize = 200;

#[derive(Default)]
pub struct WorkspaceSearchState {
    searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchRoot {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regexp: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub search_ignored: bool,
    pub max_matches_per_file: Option<usize>,
    pub max_total_matches: Option<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchMatch {
    pub root_id: String,
    pub root_name: String,
    pub root_path: String,
    pub path: String,
    pub line_number: u64,
    pub column: usize,
    pub match_start: usize,
    pub match_end: usize,
    pub line_text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchEvent {
    search_id: String,
    kind: &'static str,
    matches: Vec<WorkspaceSearchMatch>,
    truncated: bool,
    cancelled: bool,
    files_scanned: usize,
    total_matches: usize,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SearchSummary {
    files_scanned: usize,
    total_matches: usize,
    truncated: bool,
    cancelled: bool,
}

fn normalized_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn matcher_for(query: &str, options: &WorkspaceSearchOptions) -> Result<RegexMatcher, String> {
    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    let pattern = if options.regexp {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .build(&pattern)
        .map_err(|error| format!("Invalid search pattern: {error}"))
}

fn build_overrides(
    root: &Path,
    options: &WorkspaceSearchOptions,
) -> Result<ignore::overrides::Override, String> {
    let mut builder = OverrideBuilder::new(root);
    for pattern in &options.include_globs {
        let pattern = pattern.trim();
        if !pattern.is_empty() {
            builder
                .add(pattern)
                .map_err(|error| format!("Invalid include glob '{pattern}': {error}"))?;
        }
    }
    for pattern in &options.exclude_globs {
        let pattern = pattern.trim();
        if !pattern.is_empty() {
            builder
                .add(&format!("!{pattern}"))
                .map_err(|error| format!("Invalid exclude glob '{pattern}': {error}"))?;
        }
    }
    builder
        .build()
        .map_err(|error| format!("Build search globs: {error}"))
}

fn char_offset(text: &str, byte_offset: usize) -> usize {
    text.get(..byte_offset)
        .map(|prefix| prefix.chars().count())
        .unwrap_or_else(|| text.len())
}

fn run_workspace_search(
    roots: &[WorkspaceSearchRoot],
    query: &str,
    options: &WorkspaceSearchOptions,
    cancelled: &AtomicBool,
    mut emit_batch: impl FnMut(Vec<WorkspaceSearchMatch>) -> Result<(), String>,
) -> Result<SearchSummary, String> {
    let matcher = matcher_for(query, options)?;
    let total_limit = options
        .max_total_matches
        .unwrap_or(DEFAULT_TOTAL_MATCH_LIMIT)
        .clamp(1, MAX_TOTAL_MATCH_LIMIT);
    let file_limit = options
        .max_matches_per_file
        .unwrap_or(DEFAULT_FILE_MATCH_LIMIT)
        .clamp(1, MAX_FILE_MATCH_LIMIT);
    let mut summary = SearchSummary::default();
    let mut batch = Vec::with_capacity(EVENT_BATCH_SIZE);

    for root in roots {
        if cancelled.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let root_path = std::fs::canonicalize(&root.path)
            .map_err(|error| format!("Resolve search root {}: {error}", root.path))?;
        if !root_path.is_dir() {
            return Err(format!("Search root is not a directory: {}", root.path));
        }
        let overrides = build_overrides(&root_path, options)?;
        let mut walk = WalkBuilder::new(&root_path);
        // Honor .gitignore even when the root is a plain folder rather than a
        // git checkout — workspace roots are not required to be repositories.
        walk.follow_links(false)
            .require_git(false)
            .overrides(overrides);
        if options.search_ignored {
            walk.hidden(false)
                .ignore(false)
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .parents(false);
        }

        for entry in walk.build() {
            if cancelled.load(Ordering::Relaxed) {
                summary.cancelled = true;
                break;
            }
            let entry =
                entry.map_err(|error| format!("Walk search root {}: {error}", root.path))?;
            let Some(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            summary.files_scanned += 1;
            let path = entry.into_path();
            let relative_path = normalized_relative_path(&root_path, &path);
            let mut file_matches = 0usize;
            let mut searcher = SearcherBuilder::new()
                .line_number(true)
                .binary_detection(BinaryDetection::quit(b'\0'))
                .build();
            searcher
                .search_path(
                    &matcher,
                    &path,
                    UTF8(|line_number, line| {
                        if cancelled.load(Ordering::Relaxed)
                            || file_matches >= file_limit
                            || summary.total_matches >= total_limit
                        {
                            return Ok(false);
                        }
                        let line_text = line.trim_end_matches(['\r', '\n']).to_string();
                        let mut keep_searching = true;
                        matcher.find_iter(line_text.as_bytes(), |matched| {
                            if cancelled.load(Ordering::Relaxed)
                                || file_matches >= file_limit
                                || summary.total_matches >= total_limit
                            {
                                keep_searching = false;
                                return false;
                            }
                            let start = char_offset(&line_text, matched.start());
                            let end = char_offset(&line_text, matched.end());
                            batch.push(WorkspaceSearchMatch {
                                root_id: root.id.clone(),
                                root_name: root.name.clone(),
                                root_path: root_path.to_string_lossy().to_string(),
                                path: relative_path.clone(),
                                line_number,
                                column: start + 1,
                                match_start: start,
                                match_end: end,
                                line_text: line_text.clone(),
                            });
                            file_matches += 1;
                            summary.total_matches += 1;
                            if batch.len() >= EVENT_BATCH_SIZE {
                                let next = Vec::with_capacity(EVENT_BATCH_SIZE);
                                let ready = std::mem::replace(&mut batch, next);
                                if emit_batch(ready).is_err() {
                                    keep_searching = false;
                                    return false;
                                }
                            }
                            true
                        })?;
                        Ok(keep_searching)
                    }),
                )
                .map_err(|error| format!("Search {}: {error}", path.display()))?;

            if file_matches >= file_limit || summary.total_matches >= total_limit {
                summary.truncated = true;
            }
            if summary.total_matches >= total_limit {
                break;
            }
        }
        if summary.cancelled || summary.total_matches >= total_limit {
            break;
        }
    }

    if !batch.is_empty() {
        emit_batch(batch)?;
    }
    if cancelled.load(Ordering::Relaxed) {
        summary.cancelled = true;
    }
    Ok(summary)
}

fn event_name(search_id: &str) -> String {
    format!("workspace-search-{search_id}")
}

fn emit_event(app: &AppHandle, search_id: &str, event: WorkspaceSearchEvent) -> Result<(), String> {
    app.emit(&event_name(search_id), event)
        .map_err(|error| format!("Emit workspace search event: {error}"))
}

fn validate_search_id(search_id: &str) -> Result<(), String> {
    let valid = !search_id.is_empty()
        && search_id.len() <= 64
        && search_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if valid {
        Ok(())
    } else {
        Err("Invalid search id".to_string())
    }
}

/// The caller supplies `search_id` so it can subscribe to the result event
/// channel *before* the search starts — a server-generated id would race the
/// first result batches against the frontend `listen()` registration.
#[tauri::command]
pub fn workspace_search_start(
    app: AppHandle,
    state: State<'_, WorkspaceSearchState>,
    search_id: String,
    roots: Vec<WorkspaceSearchRoot>,
    query: String,
    options: Option<WorkspaceSearchOptions>,
) -> Result<String, String> {
    if roots.is_empty() {
        return Err("At least one search root is required".to_string());
    }
    validate_search_id(&search_id)?;
    matcher_for(
        &query,
        options
            .as_ref()
            .unwrap_or(&WorkspaceSearchOptions::default()),
    )?;
    let cancel = Arc::new(AtomicBool::new(false));
    let searches = state.searches.clone();
    {
        let mut active = searches
            .lock()
            .map_err(|_| "Workspace search state is unavailable".to_string())?;
        if active.contains_key(&search_id) {
            return Err("A search with this id is already running".to_string());
        }
        active.insert(search_id.clone(), cancel.clone());
    }
    let task_id = search_id.clone();
    let task_options = options.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let result = run_workspace_search(&roots, &query, &task_options, &cancel, |matches| {
            emit_event(
                &app,
                &task_id,
                WorkspaceSearchEvent {
                    search_id: task_id.clone(),
                    kind: "batch",
                    matches,
                    truncated: false,
                    cancelled: false,
                    files_scanned: 0,
                    total_matches: 0,
                    error: None,
                },
            )
        });
        match result {
            Ok(summary) => {
                let _ = emit_event(
                    &app,
                    &task_id,
                    WorkspaceSearchEvent {
                        search_id: task_id.clone(),
                        kind: "done",
                        matches: Vec::new(),
                        truncated: summary.truncated,
                        cancelled: summary.cancelled,
                        files_scanned: summary.files_scanned,
                        total_matches: summary.total_matches,
                        error: None,
                    },
                );
            }
            Err(error) => {
                let _ = emit_event(
                    &app,
                    &task_id,
                    WorkspaceSearchEvent {
                        search_id: task_id.clone(),
                        kind: "error",
                        matches: Vec::new(),
                        truncated: false,
                        cancelled: false,
                        files_scanned: 0,
                        total_matches: 0,
                        error: Some(error),
                    },
                );
            }
        }
        if let Ok(mut active) = searches.lock() {
            active.remove(&task_id);
        }
    });

    Ok(search_id)
}

#[tauri::command]
pub fn workspace_search_cancel(
    state: State<'_, WorkspaceSearchState>,
    search_id: String,
) -> Result<bool, String> {
    let active = state
        .searches
        .lock()
        .map_err(|_| "Workspace search state is unavailable".to_string())?;
    let Some(cancel) = active.get(&search_id) else {
        return Ok(false);
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn root(path: &Path) -> WorkspaceSearchRoot {
        WorkspaceSearchRoot {
            id: "root".to_string(),
            name: "repo".to_string(),
            path: path.to_string_lossy().to_string(),
        }
    }

    fn search(
        path: &Path,
        query: &str,
        options: WorkspaceSearchOptions,
    ) -> (Vec<WorkspaceSearchMatch>, SearchSummary) {
        let mut matches = Vec::new();
        let summary = run_workspace_search(
            &[root(path)],
            query,
            &options,
            &AtomicBool::new(false),
            |batch| {
                matches.extend(batch);
                Ok(())
            },
        )
        .unwrap();
        (matches, summary)
    }

    #[test]
    fn searches_text_and_reports_unicode_character_offsets() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("main.rs"),
            "fn main() {\n    let 名称 = target;\n}\n",
        )
        .unwrap();

        let (matches, summary) = search(dir.path(), "target", WorkspaceSearchOptions::default());

        assert_eq!(summary.total_matches, 1);
        assert_eq!(matches[0].path, "main.rs");
        assert_eq!(matches[0].line_number, 2);
        assert_eq!(matches[0].column, 14);
        let matched: String = matches[0]
            .line_text
            .chars()
            .skip(matches[0].match_start)
            .take(matches[0].match_end - matches[0].match_start)
            .collect();
        assert_eq!(matched, "target");
    }

    #[test]
    fn honors_ignore_files_and_explicit_globs() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("ignored")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        fs::write(dir.path().join("keep.ts"), "needle\n").unwrap();
        fs::write(dir.path().join("skip.rs"), "needle\n").unwrap();
        fs::write(dir.path().join("ignored/hidden.ts"), "needle\n").unwrap();
        let options = WorkspaceSearchOptions {
            include_globs: vec!["*.ts".to_string()],
            ..Default::default()
        };

        let (matches, _) = search(dir.path(), "needle", options);

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "keep.ts");
    }

    #[test]
    fn supports_case_word_regex_and_match_limits() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("one.txt"),
            "Needle needle needles\nneedle-1 needle-2\n",
        )
        .unwrap();
        let options = WorkspaceSearchOptions {
            case_sensitive: true,
            whole_word: true,
            regexp: true,
            max_total_matches: Some(2),
            ..Default::default()
        };

        let (matches, summary) = search(dir.path(), r"needle(?:-[0-9])?", options);

        assert_eq!(matches.len(), 2);
        assert!(summary.truncated);
        assert!(matches.iter().all(|item| {
            item.line_text.as_bytes()[item.match_start..item.match_end].starts_with(b"needle")
        }));
    }

    #[test]
    fn validates_client_supplied_search_ids() {
        assert!(validate_search_id("a1B2-c3").is_ok());
        assert!(validate_search_id(&"x".repeat(64)).is_ok());
        assert!(validate_search_id("").is_err());
        assert!(validate_search_id(&"x".repeat(65)).is_err());
        assert!(validate_search_id("bad/id").is_err());
        assert!(validate_search_id("bad id").is_err());
    }

    #[test]
    fn stops_before_walking_when_cancelled() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("one.txt"), "needle\n").unwrap();
        let cancelled = AtomicBool::new(true);
        let summary = run_workspace_search(
            &[root(dir.path())],
            "needle",
            &WorkspaceSearchOptions::default(),
            &cancelled,
            |_| Ok(()),
        )
        .unwrap();

        assert!(summary.cancelled);
        assert_eq!(summary.files_scanned, 0);
        assert_eq!(summary.total_matches, 0);
    }
}
