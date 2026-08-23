//! Resolve sockscap-helper and WinDivert resource directories across dev/install layouts.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Base filename of the elevated helper per platform.
pub fn helper_exe_name() -> &'static str {
    if cfg!(windows) {
        "sockscap-helper.exe"
    } else {
        "sockscap-helper"
    }
}

/// All candidate paths for the elevated helper binary (first existing wins).
///
/// `scripts/stage-sockscap-windows.ps1` stages the helper into
/// `src-tauri/resources/sockscap/windows/`, and `tauri.conf.json` bundles
/// `resources/sockscap/**/*` — so an installed build has it at
/// `<install dir>\resources\sockscap\windows\sockscap-helper.exe`. Note that on
/// Windows `resource_dir()` *is* the exe directory, so the `resources/` segment
/// is part of the path and must be searched explicitly (this mirrors what
/// [`windivert_dir_candidates`] and [`xray_exe_candidates`] already do).
pub fn helper_exe_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };
    let name = helper_exe_name();
    let platform_dir = xray_platform_subdir();

    // Explicit override (tests / CI / bespoke deployments).
    if let Ok(exe) = std::env::var("SOCKSCAP_HELPER_EXE") {
        push(PathBuf::from(exe));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Same directory as Taomni, and the cargo target dir under
            // `tauri dev` (the exe lives in target/<profile> there too).
            push(dir.join(name));
            // Bundled resource layout (NSIS/MSI install, macOS Resources).
            push(
                dir.join("resources")
                    .join("sockscap")
                    .join(platform_dir)
                    .join(name),
            );
            push(dir.join("sockscap").join(platform_dir).join(name));
            // Sidecar / externalBin style names.
            push(dir.join("bin").join(name));
            push(dir.join("sockscap").join(name));
        }
    }

    if let Ok(dir) = app.path().resource_dir() {
        push(
            dir.join("resources")
                .join("sockscap")
                .join(platform_dir)
                .join(name),
        );
        push(dir.join("sockscap").join(platform_dir).join(name));
        push(dir.join(name));
        push(dir.join("bin").join(name));
    }

    // CWD-relative (dev from repo root or src-tauri).
    push(PathBuf::from(format!(
        "src-tauri/resources/sockscap/{platform_dir}/{name}"
    )));
    push(PathBuf::from(format!(
        "resources/sockscap/{platform_dir}/{name}"
    )));
    for base in [
        PathBuf::from("target/debug"),
        PathBuf::from("target/release"),
        PathBuf::from("src-tauri/target/debug"),
        PathBuf::from("src-tauri/target/release"),
    ] {
        push(base.join(name));
    }

    out
}

pub fn resolve_helper_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let candidates = helper_exe_candidates(app);
    for c in &candidates {
        if c.is_file() {
            // Absolute path is required: elevated helper cwd is often System32.
            return Ok(std::fs::canonicalize(c).unwrap_or_else(|_| {
                if c.is_absolute() {
                    c.clone()
                } else {
                    std::env::current_dir()
                        .map(|cwd| cwd.join(c))
                        .unwrap_or_else(|_| c.clone())
                }
            }));
        }
    }
    // List every candidate: truncating hid the install-layout paths that
    // matter most when diagnosing "helper not found" on a packaged build.
    let listed = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join("\n  ");
    Err(format!(
        "sockscap-helper not found. Build with:\n  cd src-tauri && cargo build --bin sockscap-helper\n\
         Searched:\n  {listed}"
    ))
}

/// Base filename of the bundled xray-core executable per platform.
pub fn xray_exe_name() -> &'static str {
    if cfg!(windows) { "xray.exe" } else { "xray" }
}

/// All candidate paths for the bundled xray-core binary (first existing wins).
///
/// Mirrors [`helper_exe_candidates`]: install layout (next to the app / under
/// `sockscap/<platform>/`), dev `target/` dirs, the Tauri resource dir, and a
/// `SOCKSCAP_XRAY_DIR` / `SOCKSCAP_XRAY_EXE` override (used by tests/CI).
pub fn xray_exe_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };
    let name = xray_exe_name();
    let platform_dir = xray_platform_subdir();

    // Explicit overrides win.
    if let Ok(exe) = std::env::var("SOCKSCAP_XRAY_EXE") {
        push(PathBuf::from(exe));
    }
    if let Ok(dir) = std::env::var("SOCKSCAP_XRAY_DIR") {
        push(PathBuf::from(&dir).join(name));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push(dir.join(name));
            push(dir.join("sockscap").join(platform_dir).join(name));
            push(
                dir.join("resources")
                    .join("sockscap")
                    .join(platform_dir)
                    .join(name),
            );
        }
    }

    if let Ok(dir) = app.path().resource_dir() {
        push(dir.join("sockscap").join(platform_dir).join(name));
        push(dir.join(name));
    }

    // Dev / CWD-relative.
    push(PathBuf::from(format!(
        "src-tauri/resources/sockscap/{platform_dir}/{name}"
    )));
    push(PathBuf::from(format!(
        "resources/sockscap/{platform_dir}/{name}"
    )));
    push(PathBuf::from("src-tauri/target/debug").join(name));
    push(PathBuf::from("target/debug").join(name));

    out
}

/// Resource subdirectory holding the platform's xray binary.
pub fn xray_platform_subdir() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// First existing xray executable, or None if not provisioned.
pub fn resolve_xray_exe(app: &AppHandle) -> Option<PathBuf> {
    for c in xray_exe_candidates(app) {
        if c.is_file() {
            return Some(std::fs::canonicalize(&c).unwrap_or(c));
        }
    }
    // Last resort: a system-installed xray on PATH (dev convenience).
    which::which("xray").ok()
}

/// Directories that may contain WinDivert.dll / WinDivert64.sys.
pub fn windivert_dir_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };

    if let Ok(d) = std::env::var("SOCKSCAP_WINDIVERT_DIR") {
        push(PathBuf::from(d));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push(dir.to_path_buf());
            push(dir.join("sockscap").join("windows"));
            push(dir.join("resources").join("sockscap").join("windows"));
        }
    }

    if let Ok(dir) = app.path().resource_dir() {
        push(dir.join("sockscap").join("windows"));
        push(dir.clone());
    }

    push(PathBuf::from("src-tauri/resources/sockscap/windows"));
    push(PathBuf::from("resources/sockscap/windows"));
    push(PathBuf::from("src-tauri/target/debug"));
    push(PathBuf::from("target/debug"));

    out
}

fn to_absolute_dir(d: PathBuf) -> PathBuf {
    std::fs::canonicalize(&d).unwrap_or_else(|_| {
        if d.is_absolute() {
            d
        } else {
            std::env::current_dir().map(|cwd| cwd.join(&d)).unwrap_or(d)
        }
    })
}

/// First directory that actually contains WinDivert.dll (always absolute).
pub fn resolve_windivert_dir(app: &AppHandle) -> Option<PathBuf> {
    for d in windivert_dir_candidates(app) {
        if d.join("WinDivert.dll").is_file() {
            return Some(to_absolute_dir(d));
        }
        // Also accept nested x64/
        if d.join("x64").join("WinDivert.dll").is_file() {
            return Some(to_absolute_dir(d.join("x64")));
        }
    }
    None
}

pub fn windivert_missing_hint(app: &AppHandle) -> String {
    let dirs = windivert_dir_candidates(app)
        .into_iter()
        .take(6)
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join("\n  ");
    format!(
        "WinDivert.dll not found. Download WinDivert and place WinDivert.dll + WinDivert64.sys in one of:\n  {dirs}\n\
         Or set SOCKSCAP_WINDIVERT_DIR. See src-tauri/resources/sockscap/windows/README.md"
    )
}

/* --------------------------- runtime staging ----------------------------- */

/// Per-version directory the privileged binaries are actually run from.
fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let version = app.package_info().version.to_string();
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("sockscap")
        .join("bin")
        .join(version))
}

/// Copy `src` to `dest` unless an identical-size copy is already there.
///
/// A same-size file is treated as current because the staging directory is
/// keyed by app version: same version means same bytes. That matters when the
/// destination is locked by a running helper — recopying would fail, and the
/// existing copy is the right one anyway.
fn stage_file(src: &Path, dest: &Path) -> Result<(), String> {
    let src_len = std::fs::metadata(src)
        .map_err(|e| format!("stat {}: {e}", src.display()))?
        .len();
    if let Ok(meta) = std::fs::metadata(dest) {
        if meta.len() == src_len {
            return Ok(());
        }
    }
    std::fs::copy(src, dest)
        .map(|_| ())
        .map_err(|e| format!("copy {} → {}: {e}", src.display(), dest.display()))
}

/// Stage the elevated helper and WinDivert into a per-version app-data
/// directory and return `(helper_exe, windivert_dir)` inside it.
///
/// Running them straight out of the install directory is what makes upgrades
/// fail. A live `sockscap-helper.exe` locks its own image, and the WinDivert
/// kernel driver locks `WinDivert64.sys` until it unloads — so the installer
/// cannot overwrite either, which surfaces as "dll overwrite file failure".
/// Copies under app data are never touched by the installer, and keying the
/// directory by version means a new build stages beside the old one instead of
/// fighting it for a filename.
///
/// Returns `Err` if staging fails for any reason; callers fall back to running
/// in place, which is no worse than the previous behaviour.
pub fn stage_privileged_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let helper_src = resolve_helper_exe(app)?;
    let windivert_src = resolve_windivert_dir(app).ok_or_else(|| windivert_missing_hint(app))?;

    let dir = staging_dir(app)?;
    // Already staged and running from here? Nothing to do.
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let helper_dest = dir.join(helper_exe_name());
    stage_file(&helper_src, &helper_dest)?;

    // WinDivert.dll and its .sys must sit together: the DLL loads the driver
    // from its own directory.
    let mut staged_dll = false;
    for entry in std::fs::read_dir(&windivert_src)
        .map_err(|e| format!("read {}: {e}", windivert_src.display()))?
        .flatten()
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if !lower.starts_with("windivert") || !(lower.ends_with(".dll") || lower.ends_with(".sys"))
        {
            continue;
        }
        stage_file(&path, &dir.join(name))?;
        staged_dll |= lower == "windivert.dll";
    }
    if !staged_dll {
        return Err(format!(
            "WinDivert.dll not found in {}",
            windivert_src.display()
        ));
    }

    prune_old_staging(app, &dir);
    Ok((helper_dest, dir))
}

/// Remove staging directories from other versions. Best effort: one still in
/// use by a running helper simply fails to delete and is left for next time.
fn prune_old_staging(app: &AppHandle, keep: &Path) {
    let Some(parent) = keep.parent() else {
        return;
    };
    let _ = app;
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_dir() {
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            tracing::info!("sockscap: removed stale staging dir {}", path.display());
        }
    }
}

/// Normalize an executable path for app-list matching (lowercase, backslashes, no trailing slash).
pub fn normalize_exe_path(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\").to_ascii_lowercase();
    while s.ends_with('\\') {
        s.pop();
    }
    // Collapse \\?\ prefix
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }
    s
}

pub fn paths_match_exe(process_path: &str, selector: &str) -> bool {
    let p = normalize_exe_path(process_path);
    let s = normalize_exe_path(selector);
    if p.is_empty() || s.is_empty() {
        return false;
    }
    p == s || p.ends_with(&s) || Path::new(&p).ends_with(Path::new(&s))
}
