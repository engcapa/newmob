use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const DEFAULT_MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_RECURSIVE_MAX_DEPTH: usize = 25;
const DEFAULT_RECURSIVE_MAX_FILES: usize = 2_000;
const HARD_RECURSIVE_MAX_DEPTH: usize = 100;
const HARD_RECURSIVE_MAX_FILES: usize = 10_000;
const GIT_ROOT_SCAN_MAX_DEPTH: usize = 4;
const GIT_ROOT_SCAN_MAX_DIRS: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
    pub mtime: u64,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub text: String,
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCompactChain {
    pub path: String,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRootCandidate {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub repo_root: String,
    pub root_ids: Vec<String>,
    pub is_submodule: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTask {
    pub id: String,
    pub label: String,
    pub command: String,
    pub cwd: String,
    pub source: String,
}

fn push_task(
    tasks: &mut Vec<WorkspaceTask>,
    source: &str,
    label: impl Into<String>,
    command: impl Into<String>,
    cwd: &Path,
) {
    let label = label.into();
    tasks.push(WorkspaceTask {
        id: format!("{}:{}", source, label.to_lowercase().replace(' ', "-")),
        label,
        command: command.into(),
        cwd: path_to_string(cwd),
        source: source.to_string(),
    });
}

fn parse_named_targets(contents: &str) -> Vec<String> {
    let mut targets = Vec::new();
    for line in contents.lines() {
        if line.starts_with(char::is_whitespace) || line.starts_with('#') {
            continue;
        }
        let Some((candidate, _)) = line.split_once(':') else {
            continue;
        };
        let candidate = candidate.trim();
        if candidate.is_empty()
            || candidate.contains(['=', '%', '$'])
            || candidate.split_whitespace().count() != 1
        {
            continue;
        }
        if !targets.iter().any(|target| target == candidate) {
            targets.push(candidate.to_string());
        }
        if targets.len() >= 50 {
            break;
        }
    }
    targets
}

/// Grouped task view for the Build panel task tree (M7 F-2). Unlike the flat
/// `workspace_detect_tasks`, tasks are bucketed by source and Maven/Gradle carry
/// their full lifecycle / common tasks rather than the two-entry Run-tab subset.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskGroup {
    /// Source key (also the group label), e.g. "Maven", "Gradle", "package.json".
    pub source: String,
    pub tasks: Vec<WorkspaceTask>,
}

/// Wrapper-aware Gradle invocation for `root` (`./gradlew`, `gradlew.bat`, or `gradle`).
fn gradle_runner(root: &Path) -> &'static str {
    if cfg!(windows) && root.join("gradlew.bat").is_file() {
        "gradlew.bat"
    } else if root.join("gradlew").is_file() {
        "./gradlew"
    } else {
        "gradle"
    }
}

/// Wrapper-aware Maven invocation for `root` (`mvnw.cmd`, `./mvnw`, or `mvn`).
fn maven_runner(root: &Path) -> &'static str {
    if cfg!(windows) && root.join("mvnw.cmd").is_file() {
        "mvnw.cmd"
    } else if root.join("mvnw").is_file() {
        "./mvnw"
    } else {
        "mvn"
    }
}

/// Maven's default lifecycle phases most people run, in lifecycle order.
const MAVEN_LIFECYCLE_PHASES: &[&str] = &[
    "clean", "validate", "compile", "test", "package", "verify", "install",
];

/// Gradle tasks common to the base/Java plugins (a fixed set — a live
/// `gradle tasks --all` enumeration would require spawning Gradle and is left as
/// a follow-up so this stays a pure, fast, offline function).
const GRADLE_COMMON_TASKS: &[&str] = &["clean", "build", "assemble", "check", "test", "jar"];

/// Build the grouped task tree: detected tasks bucketed by source (first-seen
/// order preserved), with Maven/Gradle enriched to their full lifecycle / common
/// tasks. Pure and offline — no build tool is spawned.
fn build_workspace_task_tree(root: &Path) -> Result<Vec<WorkspaceTaskGroup>, String> {
    let detected = detect_workspace_tasks(root)?;
    let mut groups: Vec<WorkspaceTaskGroup> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut push = |groups: &mut Vec<WorkspaceTaskGroup>,
                    index: &mut std::collections::HashMap<String, usize>,
                    task: WorkspaceTask| {
        // Skip duplicate labels within a source (enrichment may overlap detection).
        if let Some(&i) = index.get(&task.source) {
            let group: &mut WorkspaceTaskGroup = &mut groups[i];
            if group.tasks.iter().any(|existing| existing.label == task.label) {
                return;
            }
            group.tasks.push(task);
        } else {
            index.insert(task.source.clone(), groups.len());
            groups.push(WorkspaceTaskGroup {
                source: task.source.clone(),
                tasks: vec![task],
            });
        }
    };

    // Maven / Gradle full lifecycle first (before the detected subset merges in),
    // so lifecycle order is preserved in the tree.
    if root.join("pom.xml").is_file() {
        let runner = maven_runner(root);
        for phase in MAVEN_LIFECYCLE_PHASES {
            push(&mut groups, &mut index, WorkspaceTask {
                id: format!("Maven:{phase}"),
                label: (*phase).to_string(),
                command: format!("{runner} {phase}"),
                cwd: path_to_string(root),
                source: "Maven".to_string(),
            });
        }
    }
    if root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file() {
        let runner = gradle_runner(root);
        for task in GRADLE_COMMON_TASKS {
            push(&mut groups, &mut index, WorkspaceTask {
                id: format!("Gradle:{task}"),
                label: (*task).to_string(),
                command: format!("{runner} {task}"),
                cwd: path_to_string(root),
                source: "Gradle".to_string(),
            });
        }
    }

    for task in detected {
        push(&mut groups, &mut index, task);
    }
    Ok(groups)
}

fn detect_workspace_tasks(root: &Path) -> Result<Vec<WorkspaceTask>, String> {
    let mut tasks = Vec::new();

    let package_json = root.join("package.json");
    if package_json.is_file() {
        let contents = fs::read_to_string(&package_json)
            .map_err(|e| format!("read {}: {e}", package_json.display()))?;
        let package: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| format!("parse {}: {e}", package_json.display()))?;
        let manager = if root.join("pnpm-lock.yaml").is_file() {
            "pnpm"
        } else if root.join("yarn.lock").is_file() {
            "yarn"
        } else {
            "npm"
        };
        if let Some(scripts) = package
            .get("scripts")
            .and_then(serde_json::Value::as_object)
        {
            let mut names: Vec<_> = scripts.keys().cloned().collect();
            names.sort();
            for name in names {
                push_task(
                    &mut tasks,
                    "package.json",
                    name.clone(),
                    format!("{manager} run {name}"),
                    root,
                );
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        for (label, command) in [
            ("build", "cargo build"),
            ("test", "cargo test"),
            ("run", "cargo run"),
            ("clippy", "cargo clippy"),
        ] {
            push_task(&mut tasks, "Cargo.toml", label, command, root);
        }
    }

    for (file_name, runner) in [
        ("Makefile", "make"),
        ("makefile", "make"),
        ("justfile", "just"),
    ] {
        let path = root.join(file_name);
        if !path.is_file() {
            continue;
        }
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        for target in parse_named_targets(&contents) {
            push_task(
                &mut tasks,
                file_name,
                target.clone(),
                format!("{runner} {target}"),
                root,
            );
        }
        if file_name.eq_ignore_ascii_case("makefile") {
            break;
        }
    }

    if root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file() {
        let runner = if cfg!(windows) && root.join("gradlew.bat").is_file() {
            "gradlew.bat"
        } else if root.join("gradlew").is_file() {
            "./gradlew"
        } else {
            "gradle"
        };
        for target in ["build", "test"] {
            push_task(
                &mut tasks,
                "Gradle",
                target,
                format!("{runner} {target}"),
                root,
            );
        }
    }

    if root.join("pom.xml").is_file() {
        let runner = if cfg!(windows) && root.join("mvnw.cmd").is_file() {
            "mvnw.cmd"
        } else if root.join("mvnw").is_file() {
            "./mvnw"
        } else {
            "mvn"
        };
        for target in ["package", "test"] {
            push_task(
                &mut tasks,
                "Maven",
                target,
                format!("{runner} {target}"),
                root,
            );
        }
    }

    if root.join("go.mod").is_file() {
        for (label, command) in [
            ("build", "go build ./..."),
            ("test", "go test ./..."),
            ("vet", "go vet ./..."),
        ] {
            push_task(&mut tasks, "go.mod", label, command, root);
        }
    }

    let pyproject = root.join("pyproject.toml");
    if pyproject.is_file() {
        let contents = fs::read_to_string(&pyproject)
            .map_err(|e| format!("read {}: {e}", pyproject.display()))?;
        let project: toml::Value =
            toml::from_str(&contents).map_err(|e| format!("parse {}: {e}", pyproject.display()))?;
        let runner = if root.join("uv.lock").is_file() {
            "uv run"
        } else if project
            .get("tool")
            .and_then(|value| value.get("poetry"))
            .is_some()
        {
            "poetry run"
        } else {
            ""
        };
        let script_tables = [
            project
                .get("project")
                .and_then(|value| value.get("scripts")),
            project
                .get("tool")
                .and_then(|value| value.get("poetry"))
                .and_then(|value| value.get("scripts")),
        ];
        for table in script_tables.into_iter().flatten() {
            let Some(table) = table.as_table() else {
                continue;
            };
            let mut names: Vec<_> = table.keys().cloned().collect();
            names.sort();
            for name in names {
                if tasks
                    .iter()
                    .any(|task| task.source == "pyproject.toml" && task.label == name)
                {
                    continue;
                }
                let command = if runner.is_empty() {
                    name.clone()
                } else {
                    format!("{runner} {name}")
                };
                push_task(&mut tasks, "pyproject.toml", name, command, root);
            }
        }
    }

    Ok(tasks)
}

#[tauri::command]
pub fn workspace_detect_tasks(repo_root: String) -> Result<Vec<WorkspaceTask>, String> {
    let root = canonical_repo_root(&repo_root)?;
    detect_workspace_tasks(&root)
}

/// Grouped task tree for the Build panel (M7 F-2). Maven/Gradle carry their full
/// lifecycle / common tasks; other ecosystems group their detected tasks by source.
#[tauri::command]
pub fn workspace_task_tree(repo_root: String) -> Result<Vec<WorkspaceTaskGroup>, String> {
    let root = canonical_repo_root(&repo_root)?;
    build_workspace_task_tree(&root)
}

#[tauri::command]
pub fn workspace_list_dir(
    repo_root: String,
    path: Option<String>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", target.display()));
    }

    list_workspace_entries(&root, &target)
}

#[tauri::command]
pub fn workspace_compact_chain(
    repo_root: String,
    path: String,
    max_depth: Option<usize>,
) -> Result<WorkspaceCompactChain, String> {
    let root = canonical_repo_root(&repo_root)?;
    let mut current = resolve_existing_path(&root, &path)?;
    let limit = max_depth.unwrap_or(16).min(HARD_RECURSIVE_MAX_DEPTH);

    for _ in 0..limit {
        let entries = list_workspace_entries(&root, &current)?;
        if entries.len() != 1 || entries[0].file_type != "dir" {
            return Ok(WorkspaceCompactChain {
                path: relative_path(&root, &current)?,
                entries,
            });
        }
        current = resolve_existing_path(&root, &entries[0].path)?;
    }

    Ok(WorkspaceCompactChain {
        path: relative_path(&root, &current)?,
        entries: list_workspace_entries(&root, &current)?,
    })
}

#[tauri::command]
pub fn workspace_list_files_recursive(
    repo_root: String,
    path: Option<String>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let start = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
    let meta = fs::metadata(&start).map_err(|e| format!("stat {}: {e}", start.display()))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", start.display()));
    }

    let max_depth = max_depth
        .unwrap_or(DEFAULT_RECURSIVE_MAX_DEPTH)
        .min(HARD_RECURSIVE_MAX_DEPTH);
    let max_files = max_files
        .unwrap_or(DEFAULT_RECURSIVE_MAX_FILES)
        .min(HARD_RECURSIVE_MAX_FILES);
    let mut files = Vec::new();
    collect_workspace_files(&root, &start, 0, max_depth, max_files, &mut files)?;
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub fn workspace_detect_git_roots(
    roots: Vec<WorkspaceGitRootCandidate>,
) -> Result<Vec<WorkspaceGitRoot>, String> {
    let mut repos: Vec<WorkspaceGitRoot> = Vec::new();
    for root in roots {
        let Ok(path) = fs::canonicalize(&root.path) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mut found = Vec::new();
        if let Some(repo_root) = find_git_repo_root(&path) {
            found.push(repo_root);
        }
        let mut remaining_dirs = GIT_ROOT_SCAN_MAX_DIRS;
        collect_nested_git_roots(
            &path,
            0,
            GIT_ROOT_SCAN_MAX_DEPTH,
            &mut remaining_dirs,
            &mut found,
        )?;

        for repo_root in found {
            upsert_workspace_git_root(&mut repos, &root, &path, &repo_root);
        }
    }
    repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(repos)
}

#[tauri::command]
pub fn workspace_read_file(
    repo_root: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    file_from_bytes(&root, &target, bytes, meta)
}

#[tauri::command]
pub fn workspace_read_loose_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let target = resolve_existing_loose_file_path(&path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    loose_file_from_bytes(&target, bytes, meta)
}

#[tauri::command]
pub fn workspace_write_file(
    repo_root: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;

    if let Some(expected) = expected_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let current = fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Cannot compare expected hash; file does not exist: {}",
                    target.display()
                )
            } else {
                format!("read {}: {e}", target.display())
            }
        })?;
        let current_hash = sha256_hex(&current);
        if !current_hash.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "File changed on disk; expected hash {expected}, found {current_hash}"
            ));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    if let Err(e) = replace_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    workspace_read_file(repo_root, path, None)
}

#[tauri::command]
pub fn workspace_write_loose_file(
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    let target = resolve_writable_loose_file_path(&path)?;
    reject_protected_loose_write(&target)?;

    if let Some(expected) = expected_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let current = fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Cannot compare expected hash; file does not exist: {}",
                    target.display()
                )
            } else {
                format!("read {}: {e}", target.display())
            }
        })?;
        let current_hash = sha256_hex(&current);
        if !current_hash.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "File changed on disk; expected hash {expected}, found {current_hash}"
            ));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    if let Err(e) = replace_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    workspace_read_loose_file(path, None)
}

#[tauri::command]
pub fn workspace_create_file(
    repo_root: String,
    path: String,
    contents: Option<String>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;
    if target.exists() {
        return Err(format!("Path already exists: {}", target.display()));
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("create {}: {e}", target.display()))?;
    {
        use std::io::Write;
        file.write_all(contents.unwrap_or_default().as_bytes())
            .map_err(|e| format!("write {}: {e}", target.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", target.display()))?;
    }
    workspace_read_file(repo_root, path, None)
}

#[tauri::command]
pub fn workspace_create_dir(repo_root: String, path: String) -> Result<WorkspaceEntry, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;
    if target.exists() {
        return Err(format!("Path already exists: {}", target.display()));
    }
    fs::create_dir(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
    workspace_entry(&root, &target)
}

#[tauri::command]
pub fn workspace_delete_path(
    repo_root: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    reject_workspace_root_target(&root, &target, "delete")?;
    reject_protected_write(&root, &target)?;
    let meta =
        fs::symlink_metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(&target).map_err(|e| format!("rmdir {}: {e}", target.display()))?;
        } else {
            fs::remove_dir(&target).map_err(|e| format!("rmdir {}: {e}", target.display()))?;
        }
    } else {
        fs::remove_file(&target).map_err(|e| format!("remove {}: {e}", target.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_rename_path(
    repo_root: String,
    from_path: String,
    to_path: String,
) -> Result<WorkspaceEntry, String> {
    let root = canonical_repo_root(&repo_root)?;
    let from = resolve_existing_path(&root, &from_path)?;
    reject_workspace_root_target(&root, &from, "rename")?;
    reject_protected_write(&root, &from)?;
    let to = resolve_writable_path(&root, &to_path)?;
    reject_protected_write(&root, &to)?;
    if to.exists() {
        return Err(format!("Path already exists: {}", to.display()));
    }
    fs::rename(&from, &to)
        .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
    workspace_entry(&root, &to)
}

fn canonical_repo_root(repo_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(repo_root);
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("resolve repo root {}: {e}", root.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Repo root is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn resolve_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    let target = root.join(requested);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))?;
    ensure_inside(root, &canonical)?;
    Ok(canonical)
}

fn resolve_writable_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    if requested.as_os_str().is_empty() {
        return Err("Cannot write the workspace root".to_string());
    }
    let target = root.join(&requested);
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    ensure_inside(root, &parent_canonical)?;
    Ok(target)
}

fn resolve_existing_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))
}

fn resolve_writable_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    Ok(target)
}

fn loose_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Loose file path cannot be empty".into());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err("Loose file path must be absolute".into());
    }
    Ok(target)
}

fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => return Err("Workspace paths cannot contain '..'".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Workspace paths must be relative".into());
            }
        }
    }
    Ok(out)
}

fn ensure_inside(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err(format!(
            "Path escapes workspace root: {} is outside {}",
            target.display(),
            root.display()
        ))
    }
}

fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if target.exists() {
            fs::remove_file(target)?;
        }
    }
    fs::rename(tmp, target)
}

fn reject_workspace_root_target(root: &Path, target: &Path, operation: &str) -> Result<(), String> {
    if target == root {
        Err(format!("Cannot {operation} the workspace root"))
    } else {
        Ok(())
    }
}

fn reject_protected_write(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

fn reject_protected_loose_write(target: &Path) -> Result<(), String> {
    if target
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

fn list_workspace_entries(root: &Path, target: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(target).map_err(|e| format!("read {}: {e}", target.display()))?;
    for item in read {
        let Ok(item) = item else {
            continue;
        };
        let path = item.path();
        if let Ok(entry) = workspace_entry(root, &path) {
            entries.push(entry);
        }
    }
    entries.sort_by(
        |a, b| match (a.file_type.as_str() == "dir", b.file_type.as_str() == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        },
    );
    Ok(entries)
}

fn find_git_repo_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn upsert_workspace_git_root(
    repos: &mut Vec<WorkspaceGitRoot>,
    workspace_root: &WorkspaceGitRootCandidate,
    workspace_path: &Path,
    repo_root: &Path,
) {
    let repo_root = path_to_string(repo_root);
    if let Some(existing) = repos.iter_mut().find(|item| item.repo_root == repo_root) {
        if !existing.root_ids.contains(&workspace_root.id) {
            existing.root_ids.push(workspace_root.id.clone());
        }
        return;
    }
    repos.push(WorkspaceGitRoot {
        id: format!("{}:{}", workspace_root.id, repo_root),
        name: repo_display_name(repo_root.as_str(), &workspace_root.name),
        path: path_to_string(workspace_path),
        is_submodule: is_git_file(repo_root.as_str()),
        repo_root,
        root_ids: vec![workspace_root.id.clone()],
    });
}

fn is_git_file(repo_root: &str) -> bool {
    fs::symlink_metadata(Path::new(repo_root).join(".git"))
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

fn collect_nested_git_roots(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    remaining_dirs: &mut usize,
    repos: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > max_depth || *remaining_dirs == 0 {
        return Ok(());
    }
    if depth > 0 && should_skip_git_root_scan_dir(dir) {
        return Ok(());
    }
    *remaining_dirs = (*remaining_dirs).saturating_sub(1);
    if dir.join(".git").exists() && !repos.iter().any(|repo| repo == dir) {
        repos.push(dir.to_path_buf());
    }
    if depth == max_depth {
        return Ok(());
    }
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in read {
        if *remaining_dirs == 0 {
            return Ok(());
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        if should_skip_git_root_scan_dir(&path) {
            continue;
        }
        collect_nested_git_roots(&path, depth + 1, max_depth, remaining_dirs, repos)?;
    }
    Ok(())
}

fn should_skip_git_root_scan_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

fn repo_display_name(repo_root: &str, fallback: &str) -> String {
    Path::new(repo_root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn path_to_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    // Windows canonicalize() yields `\\?\C:\...`; strip the verbatim prefix so
    // repo roots compare equal to non-canonical paths from callers/tests.
    let stripped = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw.as_ref());
    stripped.to_string()
}

fn collect_workspace_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    max_files: usize,
    files: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > max_depth || files.len() >= max_files {
        return Ok(());
    }
    // Skip dependency / build trees on every platform; walking `node_modules`
    // or `target` is a common Windows CPU spike when the flat index builds.
    if depth > 0 && should_skip_git_root_scan_dir(dir) {
        return Ok(());
    }
    for entry in list_workspace_entries(root, dir)? {
        if entry.path == ".git" || entry.path.starts_with(".git/") {
            continue;
        }
        if should_skip_workspace_entry_path(&entry.path) {
            continue;
        }
        match entry.file_type.as_str() {
            "file" => {
                files.push(entry);
                if files.len() >= max_files {
                    return Ok(());
                }
            }
            "dir" if depth < max_depth => {
                let child = resolve_existing_path(root, &entry.path)?;
                collect_workspace_files(root, &child, depth + 1, max_depth, max_files, files)?;
                if files.len() >= max_files {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn should_skip_workspace_entry_path(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| {
        matches!(
            segment,
            ".git"
                | ".hg"
                | ".svn"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".turbo"
                | ".cache"
                | "__pycache__"
                | ".venv"
                | "venv"
        )
    })
}

fn workspace_entry(root: &Path, path: &Path) -> Result<WorkspaceEntry, String> {
    let symlink_meta =
        fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let file_type = if symlink_meta.file_type().is_symlink() {
        "symlink"
    } else if symlink_meta.is_dir() {
        "dir"
    } else if symlink_meta.is_file() {
        "file"
    } else {
        "other"
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(WorkspaceEntry {
        name: name.clone(),
        path: relative_path(root, path)?,
        file_type: file_type.to_string(),
        size: symlink_meta.len(),
        mtime: mtime_secs(&symlink_meta),
        is_hidden: name.starts_with('.'),
    })
}

fn file_from_bytes(
    root: &Path,
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let text =
        String::from_utf8(bytes.clone()).map_err(|e| format!("File is not valid UTF-8: {e}"))?;
    Ok(WorkspaceFile {
        path: relative_path(root, target)?,
        text,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

fn loose_file_from_bytes(
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let text =
        String::from_utf8(bytes.clone()).map_err(|e| format!("File is not valid UTF-8: {e}"))?;
    Ok(WorkspaceFile {
        path: path_for_display(target),
        text,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

fn path_for_display(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value
}

fn relative_path(root: &Path, target: &Path) -> Result<String, String> {
    let rel = target
        .strip_prefix(root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let err = workspace_list_dir(dir.path().to_string_lossy().to_string(), Some("../".into()))
            .unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn rejects_dot_git_writes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let err = workspace_write_file(
            dir.path().to_string_lossy().to_string(),
            ".git/config".into(),
            "x".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn detects_expected_hash_conflict() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "one").unwrap();
        let file = workspace_read_file(
            dir.path().to_string_lossy().to_string(),
            "a.txt".into(),
            None,
        )
        .unwrap();
        fs::write(dir.path().join("a.txt"), "two").unwrap();
        let err = workspace_write_file(
            dir.path().to_string_lossy().to_string(),
            "a.txt".into(),
            "three".into(),
            Some(file.hash),
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn reads_and_writes_loose_file_with_hash_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "one").unwrap();
        let path_string = path.to_string_lossy().to_string();

        let file = workspace_read_loose_file(path_string.clone(), None).unwrap();
        assert_eq!(file.path, path_string);
        assert_eq!(file.text, "one");

        let saved =
            workspace_write_loose_file(path_string.clone(), "two".into(), Some(file.hash)).unwrap();
        assert_eq!(saved.text, "two");

        let err = workspace_write_loose_file(path_string, "three".into(), Some("bad".into()))
            .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn rejects_dot_git_loose_writes() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        let path = git_dir.join("config");
        fs::write(&path, "x").unwrap();

        let err = workspace_write_loose_file(path.to_string_lossy().to_string(), "y".into(), None)
            .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn creates_renames_and_deletes_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        workspace_create_dir(root.clone(), "src".into()).unwrap();
        let file =
            workspace_create_file(root.clone(), "src/main.ts".into(), Some("one".into())).unwrap();
        assert_eq!(file.path, "src/main.ts");
        assert_eq!(file.text, "one");

        let renamed =
            workspace_rename_path(root.clone(), "src/main.ts".into(), "src/app.ts".into()).unwrap();
        assert_eq!(renamed.path, "src/app.ts");
        assert!(!dir.path().join("src/main.ts").exists());
        assert!(dir.path().join("src/app.ts").exists());

        workspace_delete_path(root, "src/app.ts".into(), None).unwrap();
        assert!(!dir.path().join("src/app.ts").exists());
    }

    #[test]
    fn creates_and_deletes_directory_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let entry = workspace_create_dir(root.clone(), "src".into()).unwrap();
        assert_eq!(entry.file_type, "dir");
        workspace_create_file(root.clone(), "src/main.ts".into(), None).unwrap();

        let err = workspace_delete_path(root.clone(), "src".into(), Some(false)).unwrap_err();
        assert!(err.contains("rmdir"));

        workspace_delete_path(root, "src".into(), Some(true)).unwrap();
        assert!(!dir.path().join("src").exists());
    }

    #[test]
    fn returns_compact_chain_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("src/main/java/com/example/service")).unwrap();
        fs::write(
            dir.path()
                .join("src/main/java/com/example/service/UserService.java"),
            "class UserService {}",
        )
        .unwrap();

        let chain = workspace_compact_chain(root, "src".into(), Some(16)).unwrap();

        assert_eq!(chain.path, "src/main/java/com/example/service");
        assert_eq!(chain.entries.len(), 1);
        assert_eq!(
            chain.entries[0].path,
            "src/main/java/com/example/service/UserService.java"
        );
    }

    #[test]
    fn recursively_lists_files_with_limits_and_skips_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("src/a")).unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("src/a/one.ts"), "one").unwrap();
        fs::write(dir.path().join("src/two.ts"), "two").unwrap();
        fs::write(dir.path().join(".git/config"), "hidden").unwrap();

        let files = workspace_list_files_recursive(root.clone(), None, Some(10), Some(10)).unwrap();
        let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["src/a/one.ts", "src/two.ts"]);

        let limited = workspace_list_files_recursive(root, None, Some(10), Some(1)).unwrap();
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn recursive_listing_skips_dependency_and_build_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("target/debug")).unwrap();
        fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(dir.path().join("node_modules/pkg/index.js"), "module.exports=1").unwrap();
        fs::write(dir.path().join("target/debug/app"), "bin").unwrap();

        let files = workspace_list_files_recursive(root, None, Some(10), Some(100)).unwrap();
        let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["src/main.rs"]);
    }

    #[test]
    fn detects_git_roots_and_deduplicates_nested_roots() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let nested = repo.join("packages/app");
        let plain = dir.path().join("plain");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&plain).unwrap();

        let repos = workspace_detect_git_roots(vec![
            WorkspaceGitRootCandidate {
                id: "repo".into(),
                name: "repo".into(),
                path: repo.to_string_lossy().to_string(),
            },
            WorkspaceGitRootCandidate {
                id: "app".into(),
                name: "app".into(),
                path: nested.to_string_lossy().to_string(),
            },
            WorkspaceGitRootCandidate {
                id: "plain".into(),
                name: "plain".into(),
                path: plain.to_string_lossy().to_string(),
            },
        ])
        .unwrap();

        let repo_root = path_to_string(&fs::canonicalize(&repo).unwrap_or(repo.clone()));
        let detected = repos
            .iter()
            .find(|item| item.repo_root == repo_root || Path::new(&item.repo_root) == repo)
            .expect("target repo should be detected");
        assert!(detected.root_ids.contains(&"repo".to_string()));
        assert!(detected.root_ids.contains(&"app".to_string()));
    }

    #[test]
    fn detects_child_git_roots_under_plain_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let app = workspace.join("app");
        let service = workspace.join("service");
        fs::create_dir_all(app.join(".git")).unwrap();
        fs::create_dir_all(service.join(".git")).unwrap();
        fs::create_dir_all(workspace.join("node_modules/ignored/.git")).unwrap();

        let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
            id: "workspace".into(),
            name: "workspace".into(),
            path: workspace.to_string_lossy().to_string(),
        }])
        .unwrap();

        let app_canon = fs::canonicalize(&app).unwrap_or(app.clone());
        let service_canon = fs::canonicalize(&service).unwrap_or(service.clone());
        let workspace_canon = fs::canonicalize(&workspace).unwrap_or(workspace.clone());
        let repo_roots: Vec<_> = repos
            .iter()
            .map(|item| PathBuf::from(&item.repo_root))
            .collect();
        assert!(repo_roots.iter().any(|root| {
            root == &app || root == &app_canon || path_to_string(root) == path_to_string(&app_canon)
        }));
        assert!(repo_roots.iter().any(|root| {
            root == &service
                || root == &service_canon
                || path_to_string(root) == path_to_string(&service_canon)
        }));
        assert!(
            !repos
                .iter()
                .any(|item| item.repo_root.contains("node_modules"))
        );
        assert_eq!(
            repo_roots
                .iter()
                .filter(|root| root.starts_with(&workspace) || root.starts_with(&workspace_canon))
                .count(),
            2
        );
    }

    #[test]
    fn marks_git_file_roots_as_submodules() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let submodule = workspace.join("vendor/lib");
        fs::create_dir_all(&submodule).unwrap();
        fs::write(
            submodule.join(".git"),
            "gitdir: ../../.git/modules/vendor/lib\n",
        )
        .unwrap();

        let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
            id: "workspace".into(),
            name: "workspace".into(),
            path: workspace.to_string_lossy().to_string(),
        }])
        .unwrap();

        let submodule_canon = fs::canonicalize(&submodule).unwrap_or(submodule.clone());
        let detected = repos
            .iter()
            .find(|item| {
                let root = Path::new(&item.repo_root);
                root == submodule
                    || root == submodule_canon
                    || item.repo_root == path_to_string(&submodule_canon)
            })
            .expect("submodule should be detected");
        assert!(detected.is_submodule);
    }

    #[test]
    fn rejects_dot_git_deletes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "x").unwrap();

        let err = workspace_delete_path(
            dir.path().to_string_lossy().to_string(),
            ".git/config".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn detects_package_cargo_and_make_tasks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        fs::write(dir.path().join("Cargo.toml"), "[package]\nname='demo'").unwrap();
        fs::write(
            dir.path().join("Makefile"),
            "build:\n\t@echo build\n.PHONY: build\ninvalid target: ignored\n",
        )
        .unwrap();

        let tasks = detect_workspace_tasks(dir.path()).unwrap();
        assert!(tasks.iter().any(|task| {
            task.source == "package.json" && task.label == "dev" && task.command == "pnpm run dev"
        }));
        assert!(tasks.iter().any(|task| {
            task.source == "Cargo.toml" && task.label == "clippy" && task.command == "cargo clippy"
        }));
        assert!(tasks.iter().any(|task| {
            task.source == "Makefile" && task.label == "build" && task.command == "make build"
        }));
        assert!(!tasks.iter().any(|task| task.label == "invalid target"));
    }

    #[test]
    fn detects_go_gradle_maven_and_python_tasks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("go.mod"), "module example.com/demo").unwrap();
        fs::write(dir.path().join("build.gradle.kts"), "plugins {}").unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        fs::write(
            dir.path().join("pyproject.toml"),
            "[project.scripts]\nserve = 'demo:main'\n[tool.poetry.scripts]\nworker = 'demo:worker'\n",
        )
        .unwrap();
        fs::write(dir.path().join("uv.lock"), "version = 1").unwrap();

        let tasks = detect_workspace_tasks(dir.path()).unwrap();
        for command in [
            "go test ./...",
            "gradle build",
            "mvn package",
            "uv run serve",
            "uv run worker",
        ] {
            assert!(
                tasks.iter().any(|task| task.command == command),
                "missing {command}"
            );
        }
    }

    #[test]
    fn task_tree_groups_by_source_with_full_maven_and_gradle_lifecycles() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
        fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();

        let groups = build_workspace_task_tree(dir.path()).unwrap();
        let find = |source: &str| groups.iter().find(|group| group.source == source);

        // Maven carries the full lifecycle (not just the Run-tab package/test subset).
        let maven = find("Maven").expect("Maven group");
        for phase in ["clean", "compile", "package", "verify", "install"] {
            assert!(
                maven.tasks.iter().any(|task| task.label == phase),
                "Maven lifecycle missing {phase}"
            );
        }
        // Gradle carries the common tasks.
        let gradle = find("Gradle").expect("Gradle group");
        for task in ["clean", "build", "assemble", "check"] {
            assert!(
                gradle.tasks.iter().any(|entry| entry.label == task),
                "Gradle tasks missing {task}"
            );
        }
        // Other ecosystems still group their detected tasks.
        let npm = find("package.json").expect("package.json group");
        assert!(npm.tasks.iter().any(|task| task.label == "dev"));
        assert!(npm.tasks.iter().any(|task| task.label == "test"));

        // No duplicate labels within a group (enrichment vs detection overlap).
        for group in &groups {
            let mut labels: Vec<&str> = group.tasks.iter().map(|task| task.label.as_str()).collect();
            let count = labels.len();
            labels.sort_unstable();
            labels.dedup();
            assert_eq!(labels.len(), count, "duplicate label in {}", group.source);
        }
    }
}
