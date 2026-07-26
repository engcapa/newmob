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
            push(dir.join("resources").join("sockscap").join(platform_dir).join(name));
            push(dir.join("sockscap").join(platform_dir).join(name));
            // Sidecar / externalBin style names.
            push(dir.join("bin").join(name));
            push(dir.join("sockscap").join(name));
        }
    }

    if let Ok(dir) = app.path().resource_dir() {
        push(dir.join("resources").join("sockscap").join(platform_dir).join(name));
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
    push(PathBuf::from(format!("src-tauri/resources/sockscap/{platform_dir}/{name}")));
    push(PathBuf::from(format!("resources/sockscap/{platform_dir}/{name}")));
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
            std::env::current_dir()
                .map(|cwd| cwd.join(&d))
                .unwrap_or(d)
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
