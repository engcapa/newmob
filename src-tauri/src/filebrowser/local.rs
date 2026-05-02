use crate::filebrowser::sftp::FileEntryDto;
use std::fs;
use std::path::Path;

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
    let mut entries = Vec::new();
    let read = fs::read_dir(path).map_err(|e| format!("Failed to list {}: {}", path.display(), e))?;
    for item in read {
        match item {
            Ok(item) => {
                let entry_path = item.path();
                if let Ok(entry) = entry_for(&entry_path) {
                    entries.push(entry);
                }
            }
            Err(_) => continue,
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

pub fn stat(path: &Path) -> Result<FileEntryDto, String> {
    entry_for(path)
}

pub fn mkdir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("mkdir {}: {}", path.display(), e))
}

pub fn remove(path: &Path, recursive: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("stat {}: {}", path.display(), e))?;
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
    fs::rename(from, to).map_err(|e| format!("rename {} -> {}: {}", from.display(), to.display(), e))
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
    fs::set_permissions(path, perms)
        .map_err(|e| format!("chmod {}: {}", path.display(), e))
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
    let read = fs::read_dir(path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    for item in read {
        let entry = item.map_err(|e| format!("read entry: {}", e))?;
        let p = entry.path();
        let meta = fs::symlink_metadata(&p)
            .map_err(|e| format!("stat {}: {}", p.display(), e))?;
        if meta.file_type().is_dir() {
            total = total.saturating_add(dir_size(&p)?);
        } else if meta.file_type().is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

pub fn open_path(path: &Path) -> Result<(), String> {
    let cmd: (&str, Vec<&str>);
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        cmd = ("open", vec![path_str.as_str()]);
    }
    #[cfg(target_os = "windows")]
    {
        cmd = ("cmd", vec!["/c", "start", "", path_str.as_str()]);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        cmd = ("xdg-open", vec![path_str.as_str()]);
    }

    std::process::Command::new(cmd.0)
        .args(&cmd.1)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open {}: {}", path.display(), e))
}

fn entry_for(path: &Path) -> Result<FileEntryDto, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("stat {}: {}", path.display(), e))?;
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
        fs::read_link(path).ok().map(|p| p.to_string_lossy().to_string())
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
        is_hidden: name.starts_with('.'),
        symlink_target,
        owner: None,
        group: None,
    })
}

#[cfg(unix)]
fn mode_for(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode()
}

#[cfg(not(unix))]
fn mode_for(meta: &fs::Metadata) -> u32 {
    if meta.permissions().readonly() { 0o444 } else { 0o644 }
}
