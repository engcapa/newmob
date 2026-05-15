use crate::state::{AppState, ReadStreamHandle, WriteStreamHandle};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

const MAX_READ_STREAM_CHUNK: usize = 1_048_576;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadStreamOpenResult {
    handle_id: String,
    size: u64,
    mtime: u64,
}

#[tauri::command]
pub fn select_private_key_file(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_private_key_file(current_path.as_deref())
}

#[tauri::command]
pub fn select_upload_file() -> Result<Vec<String>, String> {
    platform::select_upload_file()
}

#[tauri::command]
pub fn select_save_directory(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_save_directory(current_path.as_deref())
}

#[tauri::command]
pub fn select_save_file_path(
    default_name: Option<String>,
    current_path: Option<String>,
) -> Result<Option<String>, String> {
    platform::select_save_file_path(default_name.as_deref(), current_path.as_deref())
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Response, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let bytes = std::fs::read(&expanded)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn read_stream_open(
    path: String,
    state: State<'_, AppState>,
) -> Result<ReadStreamOpenResult, String> {
    let expanded = expanded_path(&path);
    let file = OpenOptions::new()
        .read(true)
        .open(&expanded)
        .map_err(|e| format!("Failed to open read stream: {}", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to stat read stream: {}", e))?;
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let handle_id = uuid::Uuid::new_v4().to_string();
    let mut handles = state
        .read_handles
        .lock()
        .map_err(|e| format!("Read stream lock failed: {}", e))?;
    handles.insert(handle_id.clone(), ReadStreamHandle { file });
    Ok(ReadStreamOpenResult {
        handle_id,
        size,
        mtime,
    })
}

#[tauri::command]
pub fn read_stream_read(
    handle_id: String,
    max_bytes: usize,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    if !(1..=MAX_READ_STREAM_CHUNK).contains(&max_bytes) {
        return Err(format!(
            "read_stream_read maxBytes must be between 1 and {}",
            MAX_READ_STREAM_CHUNK
        ));
    }

    let mut handles = state
        .read_handles
        .lock()
        .map_err(|e| format!("Read stream lock failed: {}", e))?;
    let handle = handles
        .get_mut(&handle_id)
        .ok_or_else(|| format!("Read stream handle {} not found", handle_id))?;
    let mut bytes = vec![0_u8; max_bytes];
    let count = handle
        .file
        .read(&mut bytes)
        .map_err(|e| format!("Failed to read stream: {}", e))?;
    bytes.truncate(count);
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn read_stream_close(handle_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut handles = state
        .read_handles
        .lock()
        .map_err(|e| format!("Read stream lock failed: {}", e))?;
    handles
        .remove(&handle_id)
        .ok_or_else(|| format!("Read stream handle {} not found", handle_id))?;
    Ok(())
}

#[tauri::command]
pub fn write_stream_open(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let expanded = expanded_path(&path);
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&expanded)
        .map_err(|e| format!("Failed to open write stream: {}", e))?;
    let handle_id = uuid::Uuid::new_v4().to_string();
    let mut handles = state
        .write_handles
        .lock()
        .map_err(|e| format!("Write stream lock failed: {}", e))?;
    handles.insert(handle_id.clone(), WriteStreamHandle { path: expanded, file });
    Ok(handle_id)
}

#[tauri::command]
pub fn write_stream_append(
    request: Request<'_>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle_id = request
        .headers()
        .get("x-handle-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing x-handle-id header".to_string())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("write_stream_append expects raw bytes".to_string()),
    };

    let mut handles = state
        .write_handles
        .lock()
        .map_err(|e| format!("Write stream lock failed: {}", e))?;
    let handle = handles
        .get_mut(handle_id)
        .ok_or_else(|| format!("Write stream handle {} not found", handle_id))?;
    handle
        .file
        .write_all(bytes)
        .map_err(|e| format!("Failed to append write stream: {}", e))
}

#[tauri::command]
pub fn write_stream_close(handle_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut handles = state
        .write_handles
        .lock()
        .map_err(|e| format!("Write stream lock failed: {}", e))?;
    let mut handle = handles
        .remove(&handle_id)
        .ok_or_else(|| format!("Write stream handle {} not found", handle_id))?;
    handle
        .file
        .flush()
        .map_err(|e| format!("Failed to flush write stream: {}", e))
}

#[tauri::command]
pub fn write_stream_abort(handle_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let handle = {
        let mut handles = state
            .write_handles
            .lock()
            .map_err(|e| format!("Write stream lock failed: {}", e))?;
        handles.remove(&handle_id)
    };
    if let Some(handle) = handle {
        drop(handle.file);
        let _ = std::fs::remove_file(handle.path);
    }
    Ok(())
}

#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    expanded_path(&path).exists()
}

#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard init: {}", e))?;
    clipboard
        .get_text()
        .map_err(|e| format!("clipboard read: {}", e))
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard init: {}", e))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("clipboard write: {}", e))
}

fn expanded_path(value: &str) -> PathBuf {
    PathBuf::from(shellexpand::tilde(value).to_string())
}

fn initial_dir_from(current_path: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = current_path {
        let expanded = expanded_path(raw);
        if expanded.is_dir() {
            return Some(expanded);
        }
        if let Some(parent) = expanded.parent() {
            if parent.is_dir() {
                return Some(parent.to_path_buf());
            }
        }
    }

    dirs::home_dir()
        .map(|home| home.join(".ssh"))
        .filter(|path| path.is_dir())
        .or_else(dirs::home_dir)
}

fn existing_file_from(current_path: Option<&str>) -> Option<PathBuf> {
    let path = expanded_path(current_path?);
    path.is_file().then_some(path)
}

#[cfg(windows)]
mod platform {
    use super::{existing_file_from, initial_dir_from};
    use std::ffi::OsStr;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use winapi::um::commdlg::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_ALLOWMULTISELECT, OFN_EXPLORER,
        OFN_FILEMUSTEXIST, OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    pub fn select_private_key_file(current_path: Option<&str>) -> Result<Option<String>, String> {
        let mut file_buf = [0u16; 32768];
        if let Some(file) = existing_file_from(current_path) {
            let wide = wide_os(file.as_os_str());
            let len = wide.len().saturating_sub(1).min(file_buf.len() - 1);
            file_buf[..len].copy_from_slice(&wide[..len]);
        }
        let filter = wide_filter(&[
            ("Private key files", "*.pem;*.key;id_*;*.ppk;*"),
            ("All files", "*"),
        ]);
        let title = wide("Select private key");
        let initial_dir = initial_dir_from(current_path).map(|path| wide_os(path.as_os_str()));
        open_file_dialog(&mut file_buf, &filter, &title, initial_dir.as_ref())
    }

    pub fn select_upload_file() -> Result<Vec<String>, String> {
        // Use a large buffer: Windows multi-select format is
        // "dir\0file1\0file2\0\0" so we need plenty of space.
        let mut file_buf = [0u16; 65536];
        let filter = wide_filter(&[("All files", "*")]);
        let title = wide("Select files to send");
        let initial_dir = dirs::home_dir().map(|p| wide_os(p.as_os_str()));

        let mut ofn: OPENFILENAMEW = unsafe { zeroed() };
        ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = file_buf.as_mut_ptr();
        ofn.nMaxFile = file_buf.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.lpstrInitialDir = initial_dir
            .as_ref()
            .map(|dir| dir.as_ptr())
            .unwrap_or(ptr::null());
        ofn.Flags = OFN_EXPLORER
            | OFN_FILEMUSTEXIST
            | OFN_PATHMUSTEXIST
            | OFN_HIDEREADONLY
            | OFN_NOCHANGEDIR
            | OFN_ALLOWMULTISELECT;

        let ok = unsafe { GetOpenFileNameW(&mut ofn) };
        if ok == 0 {
            let err = unsafe { CommDlgExtendedError() };
            return if err == 0 { Ok(vec![]) } else { Err(format!("Windows file dialog failed: 0x{err:04x}")) };
        }

        // Parse the result buffer.
        // Single file: one null-terminated string.
        // Multiple files: "dir\0file1\0file2\0\0"
        let segments: Vec<String> = file_buf
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf16_lossy(s))
            .collect();

        Ok(match segments.as_slice() {
            [] => vec![],
            [single] => vec![single.clone()],
            [dir, files @ ..] => files
                .iter()
                .map(|f| format!("{}\\{}", dir, f))
                .collect(),
        })
    }

    fn open_file_dialog(
        file_buf: &mut [u16; 32768],
        filter: &[u16],
        title: &[u16],
        initial_dir: Option<&Vec<u16>>,
    ) -> Result<Option<String>, String> {
        let mut ofn: OPENFILENAMEW = unsafe { zeroed() };
        ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = file_buf.as_mut_ptr();
        ofn.nMaxFile = file_buf.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.lpstrInitialDir = initial_dir
            .map(|dir| dir.as_ptr())
            .unwrap_or(ptr::null());
        ofn.Flags = OFN_EXPLORER
            | OFN_FILEMUSTEXIST
            | OFN_PATHMUSTEXIST
            | OFN_HIDEREADONLY
            | OFN_NOCHANGEDIR;

        let ok = unsafe { GetOpenFileNameW(&mut ofn) };
        if ok != 0 {
            let len = file_buf
                .iter()
                .position(|&ch| ch == 0)
                .unwrap_or(file_buf.len());
            return Ok(Some(String::from_utf16_lossy(&file_buf[..len])));
        }

        let err = unsafe { CommDlgExtendedError() };
        if err == 0 {
            Ok(None)
        } else {
            Err(format!("Windows file dialog failed: 0x{err:04x}"))
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        wide_os(OsStr::new(value))
    }

    fn wide_os(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wide_filter(filters: &[(&str, &str)]) -> Vec<u16> {
        let mut out = Vec::new();
        for (name, pattern) in filters {
            out.extend(OsStr::new(name).encode_wide());
            out.push(0);
            out.extend(OsStr::new(pattern).encode_wide());
            out.push(0);
        }
        out.push(0);
        out
    }

    pub fn select_save_directory(current_path: Option<&str>) -> Result<Option<String>, String> {
        use std::process::Command;
        let initial = super::initial_dir_from(current_path)
            .or_else(dirs::download_dir)
            .or_else(dirs::home_dir)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let script = format!(
            r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select save directory'; $d.SelectedPath = '{}'; if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }} else {{ '' }}"#,
            initial.replace('\'', "''")
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("powershell: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("powershell: {}", stderr.trim()));
        }
        let path = String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(&['\r', '\n'][..])
            .to_string();
        Ok((!path.is_empty()).then_some(path))
    }

    pub fn select_save_file_path(
        default_name: Option<&str>,
        current_path: Option<&str>,
    ) -> Result<Option<String>, String> {
        use winapi::um::commdlg::{GetSaveFileNameW, OFN_OVERWRITEPROMPT};

        let mut file_buf = [0u16; 32768];
        if let Some(name) = default_name {
            let wide = wide(name);
            let len = wide.len().saturating_sub(1).min(file_buf.len() - 1);
            file_buf[..len].copy_from_slice(&wide[..len]);
        }
        let filter = wide_filter(&[("All files", "*")]);
        let title = wide("Save as");
        let initial_dir = super::initial_dir_from(current_path)
            .or_else(dirs::download_dir)
            .or_else(dirs::home_dir)
            .map(|p| wide_os(p.as_os_str()));

        let mut ofn: OPENFILENAMEW = unsafe { zeroed() };
        ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = file_buf.as_mut_ptr();
        ofn.nMaxFile = file_buf.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.lpstrInitialDir = initial_dir
            .as_ref()
            .map(|dir| dir.as_ptr())
            .unwrap_or(ptr::null());
        ofn.Flags = OFN_EXPLORER
            | OFN_PATHMUSTEXIST
            | OFN_HIDEREADONLY
            | OFN_NOCHANGEDIR
            | OFN_OVERWRITEPROMPT;

        let ok = unsafe { GetSaveFileNameW(&mut ofn) };
        if ok != 0 {
            let len = file_buf
                .iter()
                .position(|&ch| ch == 0)
                .unwrap_or(file_buf.len());
            return Ok(Some(String::from_utf16_lossy(&file_buf[..len])));
        }

        let err = unsafe { CommDlgExtendedError() };
        if err == 0 {
            Ok(None)
        } else {
            Err(format!("Windows save dialog failed: 0x{err:04x}"))
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;

    pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
        run_osascript(r#"POSIX path of (choose file with prompt "Select private key")"#)
    }

    pub fn select_upload_file() -> Result<Vec<String>, String> {
        run_osascript_multi(r#"POSIX path of (choose file with prompt "Select files to send" with multiple selections allowed)"#)
    }

    pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
        run_osascript(r#"POSIX path of (choose folder with prompt "Select save directory")"#)
    }

    pub fn select_save_file_path(
        default_name: Option<&str>,
        _current_path: Option<&str>,
    ) -> Result<Option<String>, String> {
        let default = default_name.unwrap_or("capture.png");
        let escaped = default.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"POSIX path of (choose file name with prompt "Save as" default name "{}")"#,
            escaped
        );
        run_osascript(&script)
    }

    fn run_osascript_multi(script: &str) -> Result<Vec<String>, String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("open file dialog: {e}"))?;

        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout);
            // osascript returns comma-separated paths for multiple selections
            let paths: Vec<String> = raw
                .trim_end_matches(&['\r', '\n'][..])
                .split(", ")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            return Ok(paths);
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-128") || stderr.to_ascii_lowercase().contains("cancel") {
            Ok(vec![])
        } else {
            Err(format!("open file dialog: {}", stderr.trim()))
        }
    }

    fn run_osascript(script: &str) -> Result<Option<String>, String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("open file dialog: {e}"))?;

        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(&['\r', '\n'][..])
                .to_string();
            return Ok((!path.is_empty()).then_some(path));
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-128") || stderr.to_ascii_lowercase().contains("cancel") {
            Ok(None)
        } else {
            Err(format!("open file dialog: {}", stderr.trim()))
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::initial_dir_from;
    use std::path::Path;
    use std::process::{Command, Output};

    pub fn select_private_key_file(current_path: Option<&str>) -> Result<Option<String>, String> {
        let initial = initial_dir_from(current_path);
        open_file_dialog("Select private key", initial.as_deref())
    }

    pub fn select_upload_file() -> Result<Vec<String>, String> {
        open_file_dialog_multi("Select files to send", dirs::home_dir().as_deref())
    }

    pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
        let initial = dirs::download_dir().or_else(dirs::home_dir);
        open_dir_dialog("Select save directory", initial.as_deref())
    }

    pub fn select_save_file_path(
        default_name: Option<&str>,
        current_path: Option<&str>,
    ) -> Result<Option<String>, String> {
        let initial_dir = initial_dir_from(current_path)
            .or_else(dirs::download_dir)
            .or_else(dirs::home_dir);
        let initial_path = initial_dir.map(|dir| {
            let mut path = dir;
            if let Some(name) = default_name {
                path.push(name);
            }
            path
        });
        open_save_dialog("Save as", initial_path.as_deref())
    }

    fn open_file_dialog_multi(title: &str, initial_dir: Option<&Path>) -> Result<Vec<String>, String> {
        match run_zenity_multi(title, initial_dir) {
            Ok(result) => return result,
            Err(DialogAttempt::NotFound) => {}
            Err(DialogAttempt::Failed(err)) => return Err(err),
        }

        match run_kdialog_multi(title, initial_dir) {
            Ok(result) => result,
            Err(DialogAttempt::NotFound) => {
                Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
            }
            Err(DialogAttempt::Failed(err)) => Err(err),
        }
    }

    fn run_zenity_multi(
        title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Result<Vec<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg("--multiple")
            .arg("--separator=\n")
            .arg(format!("--title={}", title));
        if let Some(dir) = initial_dir {
            cmd.arg(format!("--filename={}", dir_with_separator(dir)));
        }
        handle_output_multi(cmd.output(), "zenity")
    }

    fn run_kdialog_multi(
        _title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Result<Vec<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("kdialog");
        cmd.arg("--getopenfilenames")
            .arg(initial_dir.unwrap_or_else(|| Path::new("~")));
        handle_output_multi(cmd.output(), "kdialog")
    }

    fn handle_output_multi(
        result: std::io::Result<Output>,
        helper: &str,
    ) -> Result<Result<Vec<String>, String>, DialogAttempt> {
        match result {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(DialogAttempt::NotFound),
            Err(err) => Err(DialogAttempt::Failed(format!("{helper}: {err}"))),
            Ok(output) if output.status.success() => {
                let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                Ok(Ok(paths))
            }
            Ok(output) if output.status.code() == Some(1) => Ok(Ok(vec![])),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(DialogAttempt::Failed(format!("{helper}: {}", stderr.trim())))
            }
        }
    }

    fn open_file_dialog(title: &str, initial_dir: Option<&Path>) -> Result<Option<String>, String> {
        match run_zenity(title, initial_dir) {
            Ok(result) => return result,
            Err(DialogAttempt::NotFound) => {}
            Err(DialogAttempt::Failed(err)) => return Err(err),
        }

        match run_kdialog(title, initial_dir) {
            Ok(result) => result,
            Err(DialogAttempt::NotFound) => {
                Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
            }
            Err(DialogAttempt::Failed(err)) => Err(err),
        }
    }

    enum DialogAttempt {
        NotFound,
        Failed(String),
    }

    fn run_zenity(
        title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg(format!("--title={}", title));
        if let Some(dir) = initial_dir {
            cmd.arg(format!("--filename={}", dir_with_separator(dir)));
        }
        handle_output(cmd.output(), "zenity")
    }

    fn run_kdialog(
        _title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("kdialog");
        cmd.arg("--getopenfilename")
            .arg(initial_dir.unwrap_or_else(|| Path::new("~")));
        handle_output(cmd.output(), "kdialog")
    }

    fn handle_output(
        result: std::io::Result<Output>,
        helper: &str,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        match result {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(DialogAttempt::NotFound),
            Err(err) => Err(DialogAttempt::Failed(format!("{helper}: {err}"))),
            Ok(output) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout)
                    .trim_end_matches(&['\r', '\n'][..])
                    .to_string();
                Ok(Ok((!path.is_empty()).then_some(path)))
            }
            Ok(output) if output.status.code() == Some(1) => Ok(Ok(None)),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(DialogAttempt::Failed(format!(
                    "{helper}: {}",
                    stderr.trim()
                )))
            }
        }
    }

    fn dir_with_separator(path: &Path) -> String {
        let mut value = path.to_string_lossy().into_owned();
        if !value.ends_with(std::path::MAIN_SEPARATOR) {
            value.push(std::path::MAIN_SEPARATOR);
        }
        value
    }

    fn open_dir_dialog(title: &str, initial_dir: Option<&Path>) -> Result<Option<String>, String> {
        match run_zenity_dir(title, initial_dir) {
            Ok(result) => return result,
            Err(DialogAttempt::NotFound) => {}
            Err(DialogAttempt::Failed(err)) => return Err(err),
        }

        match run_kdialog_dir(title, initial_dir) {
            Ok(result) => result,
            Err(DialogAttempt::NotFound) => {
                Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
            }
            Err(DialogAttempt::Failed(err)) => Err(err),
        }
    }

    fn run_zenity_dir(
        title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg("--directory")
            .arg(format!("--title={}", title));
        if let Some(dir) = initial_dir {
            cmd.arg(format!("--filename={}", dir_with_separator(dir)));
        }
        handle_output(cmd.output(), "zenity")
    }

    fn run_kdialog_dir(
        _title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("kdialog");
        cmd.arg("--getexistingdirectory")
            .arg(initial_dir.unwrap_or_else(|| Path::new("~")));
        handle_output(cmd.output(), "kdialog")
    }

    fn open_save_dialog(
        title: &str,
        initial_path: Option<&Path>,
    ) -> Result<Option<String>, String> {
        match run_zenity_save(title, initial_path) {
            Ok(result) => return result,
            Err(DialogAttempt::NotFound) => {}
            Err(DialogAttempt::Failed(err)) => return Err(err),
        }

        match run_kdialog_save(title, initial_path) {
            Ok(result) => result,
            Err(DialogAttempt::NotFound) => {
                Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
            }
            Err(DialogAttempt::Failed(err)) => Err(err),
        }
    }

    fn run_zenity_save(
        title: &str,
        initial_path: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg("--save")
            .arg("--confirm-overwrite")
            .arg(format!("--title={}", title));
        if let Some(path) = initial_path {
            cmd.arg(format!("--filename={}", path.to_string_lossy()));
        }
        handle_output(cmd.output(), "zenity")
    }

    fn run_kdialog_save(
        _title: &str,
        initial_path: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("kdialog");
        cmd.arg("--getsavefilename")
            .arg(initial_path.unwrap_or_else(|| Path::new("~")));
        handle_output(cmd.output(), "kdialog")
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }

    pub fn select_upload_file() -> Result<Vec<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }

    pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }

    pub fn select_save_file_path(
        _default_name: Option<&str>,
        _current_path: Option<&str>,
    ) -> Result<Option<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }
}
