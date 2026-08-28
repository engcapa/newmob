use crate::filebrowser::sftp::FileEntryDto;
use std::fs;
use std::io;
use std::path::Path;

const MAX_LIST_DIAGNOSTICS: usize = 20;

#[derive(Debug, serde::Serialize, Clone)]
pub struct FileEntryDiagnosticDto {
    pub name: Option<String>,
    pub path: Option<String>,
    pub error: String,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct DirectoryListingDto {
    pub entries: Vec<FileEntryDto>,
    #[serde(rename = "skippedCount")]
    pub skipped_count: usize,
    pub diagnostics: Vec<FileEntryDiagnosticDto>,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct DriveDto {
    pub id: String,
    pub label: String,
    pub path: String,
}

pub fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not resolve user home directory".to_string())
}

#[cfg(windows)]
pub fn list_drives() -> Vec<DriveDto> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    let mut drives = Vec::new();
    let bitmask = unsafe { winapi::um::fileapi::GetLogicalDrives() };
    if bitmask == 0 {
        return drives;
    }
    for i in 0..26u32 {
        if bitmask & (1 << i) != 0 {
            let letter = (b'A' + i as u8) as char;
            let path = format!("{}:\\", letter);
            drives.push(DriveDto {
                id: format!("drive-{}", letter),
                label: format!("{}:", letter),
                path,
            });
        }
    }
    drives
}

#[cfg(not(windows))]
pub fn list_drives() -> Vec<DriveDto> {
    let mut drives = vec![DriveDto {
        id: "root".into(),
        label: "/".into(),
        path: "/".into(),
    }];
    if let Ok(home) = home_dir() {
        drives.push(DriveDto {
            id: "home".into(),
            label: "Home".into(),
            path: home,
        });
    }
    drives
}

pub fn list_dir(path: &Path) -> Result<Vec<FileEntryDto>, String> {
    let listing = list_dir_detailed(path)?;
    if listing.skipped_count > 0 {
        let first_error = listing
            .diagnostics
            .first()
            .map(|diagnostic| diagnostic.error.as_str())
            .unwrap_or("unknown directory entry error");
        return Err(format!(
            "Failed to fully list {}: {} entr{} could not be read. First error: {}",
            path.display(),
            listing.skipped_count,
            if listing.skipped_count == 1 {
                "y"
            } else {
                "ies"
            },
            first_error,
        ));
    }
    Ok(listing.entries)
}

pub fn list_dir_detailed(path: &Path) -> Result<DirectoryListingDto, String> {
    let mut entries = Vec::new();
    let mut skipped_count = 0;
    let mut diagnostics = Vec::new();
    let read = fs::read_dir(path).map_err(|error| list_error(path, &error))?;
    for item in read {
        match item {
            Ok(item) => {
                let entry_path = item.path();
                match entry_for(&entry_path) {
                    Ok(entry) => entries.push(entry),
                    Err(error) => {
                        skipped_count += 1;
                        if diagnostics.len() < MAX_LIST_DIAGNOSTICS {
                            diagnostics.push(FileEntryDiagnosticDto {
                                name: Some(item.file_name().to_string_lossy().to_string()),
                                path: Some(entry_path.to_string_lossy().to_string()),
                                error,
                            });
                        }
                    }
                }
            }
            Err(error) => {
                skipped_count += 1;
                if diagnostics.len() < MAX_LIST_DIAGNOSTICS {
                    diagnostics.push(FileEntryDiagnosticDto {
                        name: None,
                        path: None,
                        error: format!("Failed to read a directory entry: {error}"),
                    });
                }
            }
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if skipped_count > 0 {
        tracing::warn!(
            path = %path.display(),
            skipped_count,
            "local directory listing omitted unreadable entries"
        );
    }
    Ok(DirectoryListingDto {
        entries,
        skipped_count,
        diagnostics,
    })
}

fn list_error(path: &Path, error: &io::Error) -> String {
    let hint = if error.kind() == io::ErrorKind::PermissionDenied {
        permission_hint()
    } else {
        ""
    };
    format!("Failed to list {}: {}{}", path.display(), error, hint)
}

fn stat_error(path: &Path, error: &io::Error) -> String {
    let hint = if error.kind() == io::ErrorKind::PermissionDenied {
        permission_hint()
    } else {
        ""
    };
    format!("stat {}: {}{}", path.display(), error, hint)
}

#[cfg(target_os = "macos")]
fn permission_hint() -> &'static str {
    " Allow Taomni access in System Settings > Privacy & Security > Files and Folders, or Full Disk Access."
}

#[cfg(target_os = "windows")]
fn permission_hint() -> &'static str {
    " Check the folder's Windows security permissions and security-software policy."
}

#[cfg(all(unix, not(target_os = "macos")))]
fn permission_hint() -> &'static str {
    " Check the directory permissions and mount access."
}

#[cfg(not(any(unix, target_os = "windows")))]
fn permission_hint() -> &'static str {
    " Check the directory permissions."
}

pub fn stat(path: &Path) -> Result<FileEntryDto, String> {
    entry_for(path)
}

pub fn mkdir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("mkdir {}: {}", path.display(), e))
}

pub fn remove(path: &Path, recursive: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("stat {}: {}", path.display(), e))?;
    if meta.is_dir() {
        if recursive {
            fs::remove_dir_all(path).map_err(|e| format!("rmdir {}: {}", path.display(), e))
        } else {
            fs::remove_dir(path).map_err(|e| format!("rmdir {}: {}", path.display(), e))
        }
    } else {
        fs::remove_file(path).map_err(|e| format!("unlink {}: {}", path.display(), e))
    }
}

pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to)
        .map_err(|e| format!("rename {} -> {}: {}", from.display(), to.display(), e))
}

pub fn read_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("stat {}: {}", path.display(), e))?;
    if meta.len() > max_bytes {
        return Err(format!(
            "File is {} bytes, exceeds preview limit of {} bytes",
            meta.len(),
            max_bytes
        ));
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    Ok(buf)
}

pub fn write_bytes(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    file.write_all(data)
        .map_err(|e| format!("write {}: {}", path.display(), e))
}

#[cfg(unix)]
pub fn chmod(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(mode);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod {}: {}", path.display(), e))
}

#[cfg(not(unix))]
pub fn chmod(_path: &Path, _mode: u32) -> Result<(), String> {
    // POSIX permission bits don't map cleanly to Windows ACLs; expose the
    // limitation to the caller instead of silently lying about success.
    Err("chmod is only supported on Unix-like systems".to_string())
}

/// Recursively sum the byte size of every regular file under `path`.
/// Symlinks and special files contribute 0 bytes. Used to give folder
/// transfers an accurate "total bytes" up front for progress reporting.
pub fn dir_size(path: &Path) -> Result<u64, String> {
    let mut total: u64 = 0;
    let read = fs::read_dir(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    for item in read {
        let entry = item.map_err(|e| format!("read entry: {}", e))?;
        let p = entry.path();
        let meta = fs::symlink_metadata(&p).map_err(|e| format!("stat {}: {}", p.display(), e))?;
        if meta.file_type().is_dir() {
            total = total.saturating_add(dir_size(&p)?);
        } else if meta.file_type().is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

pub fn open_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    open_target_platform(&path.to_string_lossy(), &path.display().to_string())
}

#[cfg(target_os = "windows")]
fn open_target_platform(target: &str, display: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use winapi::um::shellapi::ShellExecuteW;
    use winapi::um::winuser::SW_SHOWNORMAL;

    let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
    let file: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if result <= 32 {
        return Err(format!(
            "No default application could open {display} (ShellExecute error {result})"
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn open_target_platform(target: &str, display: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = "xdg-open";

    let status = std::process::Command::new(cmd)
        .arg(target)
        .status()
        .map_err(|e| format!("Failed to open {display}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "No default application could open {display} ({cmd} exited with {status})"
        ))
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Only http:// and https:// URLs can be opened.".into());
    }
    open_target_platform(trimmed, trimmed)
}

fn entry_for(path: &Path) -> Result<FileEntryDto, String> {
    let meta = fs::symlink_metadata(path).map_err(|error| stat_error(path, &error))?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let path_str = path.to_string_lossy().to_string();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let file_type = if meta.file_type().is_dir() {
        "dir"
    } else if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.file_type().is_file() {
        "file"
    } else {
        "unknown"
    };

    let mode = mode_for(&meta);
    let symlink_target = if meta.file_type().is_symlink() {
        fs::read_link(path)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    // For symlinks, follow one level to record the *target*'s type so that
    // callers can route a "symlink → dir" double-click into a directory
    // navigation instead of handing it to the OS file manager via xdg-open.
    let target_file_type = if meta.file_type().is_symlink() {
        fs::metadata(path).ok().map(|m| {
            if m.is_dir() {
                "dir".to_string()
            } else if m.is_file() {
                "file".to_string()
            } else {
                "unknown".to_string()
            }
        })
    } else {
        None
    };

    Ok(FileEntryDto {
        name: name.clone(),
        path: path_str,
        size: meta.len(),
        mtime,
        mode,
        file_type: file_type.into(),
        target_file_type,
        is_hidden: is_hidden(&name, &meta),
        symlink_target,
        owner: None,
        group: None,
    })
}

#[cfg(windows)]
fn is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    name.starts_with('.') || meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _meta: &fs::Metadata) -> bool {
    name.starts_with('.')
}

#[cfg(unix)]
fn mode_for(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode()
}

#[cfg(not(unix))]
fn mode_for(meta: &fs::Metadata) -> u32 {
    if meta.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

#[cfg(test)]
mod tests {
    use super::{list_dir, list_dir_detailed, open_url, permission_hint};
    use std::fs;

    #[test]
    fn open_url_rejects_non_http_schemes() {
        let err = open_url("file:///tmp/demo").expect_err("file URLs should be rejected");
        assert!(err.contains("Only http:// and https:// URLs"));
    }

    #[test]
    fn detailed_listing_reports_entries_without_diagnostics() {
        let dir = tempfile::tempdir().expect("create temp directory");
        fs::write(dir.path().join("visible.txt"), b"visible").expect("write visible file");
        fs::write(dir.path().join(".hidden"), b"hidden").expect("write hidden file");

        let listing = list_dir_detailed(dir.path()).expect("list temp directory");

        assert_eq!(listing.skipped_count, 0);
        assert!(listing.diagnostics.is_empty());
        assert_eq!(listing.entries.len(), 2);
        assert!(
            listing
                .entries
                .iter()
                .any(|entry| entry.name == ".hidden" && entry.is_hidden)
        );
        assert!(listing.entries.iter().any(|entry| {
            entry.name == "visible.txt" && !entry.is_hidden && entry.file_type == "file"
        }));
    }

    #[test]
    fn strict_listing_preserves_top_level_errors() {
        let dir = tempfile::tempdir().expect("create temp directory");
        let missing = dir.path().join("missing");

        let error = list_dir(&missing).expect_err("missing directory should fail");

        assert!(error.contains("Failed to list"));
        assert!(error.contains("missing"));
    }

    #[cfg(unix)]
    #[test]
    fn partial_stat_failures_are_reported_and_strict_listing_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("create temp directory");
        fs::write(dir.path().join("private.txt"), b"private").expect("write private file");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o400))
            .expect("remove directory search permission");

        let detailed = list_dir_detailed(dir.path());
        let strict = list_dir(dir.path());

        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700))
            .expect("restore directory permissions");

        let listing = detailed.expect("reading names should remain possible");
        assert!(listing.entries.is_empty());
        assert_eq!(listing.skipped_count, 1);
        assert_eq!(listing.diagnostics.len(), 1);
        assert_eq!(listing.diagnostics[0].name.as_deref(), Some("private.txt"));
        assert!(
            listing.diagnostics[0]
                .error
                .contains(permission_hint().trim())
        );

        let error = strict.expect_err("strict listing must not omit unreadable entries");
        assert!(error.contains("1 entry could not be read"));
        assert!(error.contains("private.txt"));
    }
}
