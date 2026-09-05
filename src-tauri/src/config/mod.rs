use crate::state::{AppState, ReadStreamHandle, WriteStreamHandle};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

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
pub fn select_file_path(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_file_path(current_path.as_deref())
}

#[tauri::command]
pub fn select_folder_path(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_folder_path(current_path.as_deref())
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
pub fn get_home_dir() -> Option<String> {
    dirs::home_dir().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Response, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let bytes = std::fs::read(&expanded).map_err(|e| format!("Failed to read file: {}", e))?;
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
    handles.insert(
        handle_id.clone(),
        WriteStreamHandle {
            path: expanded,
            file,
        },
    );
    Ok(handle_id)
}

#[tauri::command]
pub fn write_stream_append(request: Request<'_>, state: State<'_, AppState>) -> Result<(), String> {
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
pub fn temporary_file_path(default_name: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("taomni");
    dir.push("query-results");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create temporary export directory: {}", e))?;

    let safe_name = default_name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();
    let name = if safe_name.trim().is_empty() {
        "query-results.dat".to_string()
    } else {
        safe_name
    };
    dir.push(format!("{}-{}", uuid::Uuid::new_v4(), name));
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clipboard_read_text(state: State<'_, AppState>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    if let Some(text) = platform::clipboard_read_text_fallback()? {
        return Ok(text);
    }

    let mut guard = state
        .clipboard
        .lock()
        .map_err(|e| format!("clipboard lock: {}", e))?;
    if guard.is_none() {
        *guard = arboard::Clipboard::new().ok();
    }
    let Some(clipboard) = guard.as_mut() else {
        #[cfg(target_os = "linux")]
        if let Some(text) = platform::clipboard_read_text_fallback()? {
            return Ok(text);
        }
        return Err("clipboard unavailable".to_string());
    };
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(error) => {
            #[cfg(target_os = "linux")]
            if let Some(text) = platform::clipboard_read_text_fallback()? {
                return Ok(text);
            }
            Err(format!("clipboard read: {}", error))
        }
    }
}

#[tauri::command]
pub fn clipboard_write_text(text: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .clipboard
        .lock()
        .map_err(|e| format!("clipboard lock: {}", e))?;
    if guard.is_none() {
        *guard = arboard::Clipboard::new().ok();
    }
    let Some(clipboard) = guard.as_mut() else {
        #[cfg(target_os = "linux")]
        if platform::clipboard_write_text_fallback(&text).is_ok() {
            return Ok(());
        }
        return Err("clipboard unavailable".to_string());
    };
    match clipboard.set_text(text.clone()) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(target_os = "linux")]
            if platform::clipboard_write_text_fallback(&text).is_ok() {
                return Ok(());
            }
            Err(format!("clipboard write: {}", error))
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCapabilities {
    pub platform: String,
    pub display_backend: String,
    pub webkit_api_expected: bool,
    pub native_backend: String,
    pub wl_paste: bool,
    pub wl_copy: bool,
    pub xclip: bool,
    pub xsel: bool,
    pub html_rtf_native: bool,
}

/// Read-only diagnostics for the Linux WebKitGTK clipboard path. Helper
/// presence is reported separately from the current selection owner, because
/// probing ownership would change or block on user clipboard state.
#[tauri::command]
pub fn clipboard_capabilities() -> ClipboardCapabilities {
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let x11 = std::env::var_os("DISPLAY").is_some();
        return ClipboardCapabilities {
            platform: "linux".into(),
            display_backend: if wayland && x11 {
                "wayland+x11".into()
            } else if wayland {
                "wayland".into()
            } else if x11 {
                "x11".into()
            } else {
                "headless".into()
            },
            webkit_api_expected: true,
            native_backend: "arboard".into(),
            wl_paste: which::which("wl-paste").is_ok(),
            wl_copy: which::which("wl-copy").is_ok(),
            xclip: which::which("xclip").is_ok(),
            xsel: which::which("xsel").is_ok(),
            html_rtf_native: false,
        };
    }

    #[cfg(target_os = "windows")]
    {
        ClipboardCapabilities {
            platform: "windows".into(),
            display_backend: "win32".into(),
            webkit_api_expected: true,
            native_backend: "arboard".into(),
            wl_paste: false,
            wl_copy: false,
            xclip: false,
            xsel: false,
            html_rtf_native: false,
        }
    }

    #[cfg(target_os = "macos")]
    {
        ClipboardCapabilities {
            platform: "macos".into(),
            display_backend: "appkit".into(),
            webkit_api_expected: true,
            native_backend: "arboard".into(),
            wl_paste: false,
            wl_copy: false,
            xclip: false,
            xsel: false,
            html_rtf_native: false,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        ClipboardCapabilities {
            platform: "unknown".into(),
            display_backend: "unknown".into(),
            webkit_api_expected: false,
            native_backend: "unknown".into(),
            wl_paste: false,
            wl_copy: false,
            xclip: false,
            xsel: false,
            html_rtf_native: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardMultiFormat {
    pub text: String,
    pub html: Option<String>,
    pub rtf: Option<String>,
}

#[tauri::command]
pub fn clipboard_read_multi_format() -> Result<ClipboardMultiFormat, String> {
    #[cfg(target_os = "macos")]
    {
        platform::clipboard_read_multi_format()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("native multi-format clipboard is only available on macOS".to_string())
    }
}

#[tauri::command]
pub fn clipboard_write_multi_format(payload: ClipboardMultiFormat) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::clipboard_write_multi_format(&payload)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = payload;
        Err("native multi-format clipboard is only available on macOS".to_string())
    }
}

#[tauri::command]
pub fn clipboard_read_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _ = state;
    let native = platform::clipboard_read_files().unwrap_or_default();
    Ok(native)
}

#[tauri::command]
pub fn clipboard_parse_file_paths(text: String) -> Result<Vec<String>, String> {
    let files = clipboard_paths_from_uri_text(&text)
        .into_iter()
        .filter(|path| PathBuf::from(path.as_str()).exists())
        .collect();
    Ok(files)
}

#[tauri::command]
pub fn clipboard_write_files(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if platform::clipboard_write_files(&paths).is_ok() {
        return Ok(());
    }

    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    clipboard_write_text(crate::rdp::cliprdr::paths_to_uri_list(&path_bufs), state)
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

fn clipboard_paths_from_uri_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for path in crate::rdp::cliprdr::uri_list_to_paths(text) {
        let value = path.to_string_lossy().into_owned();
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    for line in text.lines() {
        let mut value = line.trim();
        if (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            || (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
        {
            value = &value[1..value.len() - 1];
        }
        let value = value.trim();
        if value.is_empty()
            || value.starts_with('#')
            || value.eq_ignore_ascii_case("copy")
            || value.eq_ignore_ascii_case("cut")
            || value.starts_with("file://")
        {
            continue;
        }
        // Treat Unix absolute paths as absolute even on Windows (clipboard
        // content from remote/WSL/file managers often uses /home/... form).
        let is_abs = PathBuf::from(value).is_absolute()
            || value.starts_with('/')
            || (value.len() >= 3
                && value.as_bytes()[1] == b':'
                && value.as_bytes()[0].is_ascii_alphabetic());
        if is_abs && !out.iter().any(|path| path == value) {
            out.push(value.to_string());
        }
    }
    out
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
    use winapi::um::shellapi::DragQueryFileW;
    use winapi::um::winbase::{
        GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalFree, GlobalLock, GlobalUnlock,
    };
    use winapi::um::winuser::{
        CF_HDROP, CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, SetClipboardData,
    };

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        x: i32,
        y: i32,
        f_nc: i32,
        f_wide: i32,
    }

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
            return if err == 0 {
                Ok(vec![])
            } else {
                Err(format!("Windows file dialog failed: 0x{err:04x}"))
            };
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
            [dir, files @ ..] => files.iter().map(|f| format!("{}\\{}", dir, f)).collect(),
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
        ofn.lpstrInitialDir = initial_dir.map(|dir| dir.as_ptr()).unwrap_or(ptr::null());
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

    pub fn select_folder_path(current_path: Option<&str>) -> Result<Option<String>, String> {
        // Folder pickers reuse the same PowerShell FolderBrowserDialog as
        // select_save_directory; only the dialog title differs.
        use std::process::Command;
        let initial = super::initial_dir_from(current_path)
            .or_else(dirs::home_dir)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let script = format!(
            r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select folder to open'; $d.SelectedPath = '{}'; if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }} else {{ '' }}"#,
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

    pub fn select_file_path(current_path: Option<&str>) -> Result<Option<String>, String> {
        let mut file_buf = [0u16; 32768];
        if let Some(file) = existing_file_from(current_path) {
            let wide = wide_os(file.as_os_str());
            let len = wide.len().saturating_sub(1).min(file_buf.len() - 1);
            file_buf[..len].copy_from_slice(&wide[..len]);
        }
        let filter = wide_filter(&[("All files", "*")]);
        let title = wide("Select file to open");
        let initial_dir = initial_dir_from(current_path).map(|path| wide_os(path.as_os_str()));
        open_file_dialog(&mut file_buf, &filter, &title, initial_dir.as_ref())
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

    pub fn clipboard_read_files() -> Result<Vec<String>, String> {
        struct ClipboardGuard;
        impl Drop for ClipboardGuard {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }

        let opened = unsafe { OpenClipboard(ptr::null_mut()) };
        if opened == 0 {
            return Err("clipboard open failed".to_string());
        }
        let _guard = ClipboardGuard;

        if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
            return Ok(Vec::new());
        }
        let handle = unsafe { GetClipboardData(CF_HDROP) };
        if handle.is_null() {
            return Ok(Vec::new());
        }

        let count = unsafe { DragQueryFileW(handle as _, u32::MAX, ptr::null_mut(), 0) };
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = unsafe { DragQueryFileW(handle as _, i, ptr::null_mut(), 0) };
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let written = unsafe { DragQueryFileW(handle as _, i, buf.as_mut_ptr(), len + 1) };
            if written == 0 {
                continue;
            }
            out.push(String::from_utf16_lossy(&buf[..written as usize]));
        }
        Ok(out)
    }

    pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }

        let mut wide_paths = Vec::new();
        for path in paths {
            wide_paths.extend(OsStr::new(path).encode_wide());
            wide_paths.push(0);
        }
        wide_paths.push(0);

        let header_size = size_of::<DropFiles>();
        let total_bytes = header_size + wide_paths.len() * size_of::<u16>();
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes) };
        if handle.is_null() {
            return Err("clipboard file drop allocation failed".to_string());
        }

        let memory = unsafe { GlobalLock(handle) };
        if memory.is_null() {
            unsafe {
                GlobalFree(handle);
            }
            return Err("clipboard file drop lock failed".to_string());
        }

        let mut drop_files: DropFiles = unsafe { zeroed() };
        drop_files.p_files = header_size as u32;
        drop_files.f_wide = 1;
        unsafe {
            ptr::copy_nonoverlapping(
                &drop_files as *const DropFiles as *const u8,
                memory as *mut u8,
                header_size,
            );
            ptr::copy_nonoverlapping(
                wide_paths.as_ptr(),
                (memory as *mut u8).add(header_size) as *mut u16,
                wide_paths.len(),
            );
            GlobalUnlock(handle);
        }

        struct ClipboardGuard;
        impl Drop for ClipboardGuard {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }

        let opened = unsafe { OpenClipboard(ptr::null_mut()) };
        if opened == 0 {
            unsafe {
                GlobalFree(handle);
            }
            return Err("clipboard open failed".to_string());
        }
        let _guard = ClipboardGuard;

        if unsafe { EmptyClipboard() } == 0 {
            unsafe {
                GlobalFree(handle);
            }
            return Err("clipboard empty failed".to_string());
        }
        if unsafe { SetClipboardData(CF_HDROP, handle) }.is_null() {
            unsafe {
                GlobalFree(handle);
            }
            return Err("clipboard set file drop failed".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::clipboard_paths_from_uri_text;

    #[test]
    fn clipboard_uri_text_parses_uri_list() {
        let parsed = clipboard_paths_from_uri_text(
            "# copied from a file manager\nfile:///tmp/alpha%20one.txt\r\nfile:///tmp/beta\n",
        );

        assert_eq!(
            parsed,
            vec!["/tmp/alpha one.txt".to_string(), "/tmp/beta".to_string()]
        );
    }

    #[test]
    fn clipboard_uri_text_parses_gnome_copied_files() {
        let parsed = clipboard_paths_from_uri_text(
            "copy\nfile:///home/me/project\nfile:///home/me/project/src\n",
        );

        assert_eq!(
            parsed,
            vec![
                "/home/me/project".to_string(),
                "/home/me/project/src".to_string()
            ]
        );
    }

    #[test]
    fn clipboard_uri_text_deduplicates_paths() {
        let parsed = clipboard_paths_from_uri_text(
            "file:///tmp/same\nfile:///tmp/same\nfile:///tmp/other\n",
        );

        assert_eq!(
            parsed,
            vec!["/tmp/same".to_string(), "/tmp/other".to_string()]
        );
    }

    #[test]
    fn clipboard_uri_text_parses_plain_absolute_paths() {
        let parsed = clipboard_paths_from_uri_text(
            "copy\n/home/me/plain file.txt\n/home/me/plain file.txt\n/home/me/dir\n",
        );

        assert_eq!(
            parsed,
            vec![
                "/home/me/plain file.txt".to_string(),
                "/home/me/dir".to_string()
            ]
        );
    }

    #[test]
    fn clipboard_uri_text_parses_quoted_paths() {
        let single_quoted =
            clipboard_paths_from_uri_text("'/home/zhyhang/图片/2026-08-27_23-08.png'");
        assert_eq!(
            single_quoted,
            vec!["/home/zhyhang/图片/2026-08-27_23-08.png".to_string()]
        );

        let double_quoted = clipboard_paths_from_uri_text("\"/tmp/screenshot.png\"");
        assert_eq!(double_quoted, vec!["/tmp/screenshot.png".to_string()]);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeRTF, NSPasteboardTypeString,
    };
    use objc2_foundation::{NSData, NSString};
    use std::process::Command;

    use super::ClipboardMultiFormat;

    const MAX_FORMAT_BYTES: usize = 16 * 1024 * 1024;
    const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

    pub fn clipboard_read_multi_format() -> Result<ClipboardMultiFormat, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let text = pasteboard
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|value| value.to_string())
            .unwrap_or_default();
        let html = pasteboard
            .stringForType(unsafe { NSPasteboardTypeHTML })
            .map(|value| value.to_string());
        let rtf = match pasteboard.dataForType(unsafe { NSPasteboardTypeRTF }) {
            Some(value) => {
                // NSData is immutable here and retained for the duration of the copy.
                let bytes = unsafe { value.as_bytes_unchecked() }.to_vec();
                Some(String::from_utf8(bytes).map_err(|_| {
                    "macOS clipboard RTF is not valid UTF-8 and cannot be sent losslessly"
                        .to_string()
                })?)
            }
            None => None,
        };
        let payload = ClipboardMultiFormat { text, html, rtf };
        validate_multi_format(&payload)?;
        Ok(payload)
    }

    pub fn clipboard_write_multi_format(payload: &ClipboardMultiFormat) -> Result<(), String> {
        validate_multi_format(payload)?;
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if !pasteboard.setString_forType(&NSString::from_str(&payload.text), unsafe {
            NSPasteboardTypeString
        }) {
            return Err("macOS clipboard rejected plain text".to_string());
        }
        if let Some(html) = payload.html.as_deref() {
            if !pasteboard
                .setString_forType(&NSString::from_str(html), unsafe { NSPasteboardTypeHTML })
            {
                return Err("macOS clipboard rejected HTML".to_string());
            }
        }
        if let Some(rtf) = payload.rtf.as_deref() {
            let data = NSData::with_bytes(rtf.as_bytes());
            if !pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypeRTF }) {
                return Err("macOS clipboard rejected RTF".to_string());
            }
        }
        Ok(())
    }

    fn validate_multi_format(payload: &ClipboardMultiFormat) -> Result<(), String> {
        let mut total = 0usize;
        for value in [
            Some(payload.text.as_str()),
            payload.html.as_deref(),
            payload.rtf.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > MAX_FORMAT_BYTES {
                return Err(format!(
                    "macOS clipboard format exceeds {MAX_FORMAT_BYTES} byte limit"
                ));
            }
            total = total
                .checked_add(value.len())
                .ok_or_else(|| "macOS clipboard total size overflow".to_string())?;
        }
        if total > MAX_TOTAL_BYTES {
            return Err(format!(
                "macOS clipboard payload exceeds {MAX_TOTAL_BYTES} byte limit"
            ));
        }
        Ok(())
    }

    pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
        run_osascript(r#"POSIX path of (choose file with prompt "Select private key")"#)
    }

    pub fn select_upload_file() -> Result<Vec<String>, String> {
        run_osascript_multi(
            r#"POSIX path of (choose file with prompt "Select files to send" with multiple selections allowed)"#,
        )
    }

    pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
        run_osascript(r#"POSIX path of (choose folder with prompt "Select save directory")"#)
    }

    pub fn select_folder_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
        run_osascript(r#"POSIX path of (choose folder with prompt "Select folder to open")"#)
    }

    pub fn select_file_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
        run_osascript(r#"POSIX path of (choose file with prompt "Select file to open")"#)
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

    pub fn clipboard_read_files() -> Result<Vec<String>, String> {
        let script = r#"
use framework "Foundation"
use framework "AppKit"
use scripting additions

set pb to current application's NSPasteboard's generalPasteboard()
set urls to pb's readObjectsForClasses:{current application's NSURL} options:(missing value)
set paths to {}
repeat with u in urls
    if (u's isFileURL()) as boolean then
        set end of paths to (u's |path|()) as text
    end if
end repeat
set AppleScript's text item delimiters to linefeed
return paths as text
"#;
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("macOS clipboard: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("macOS clipboard: {}", stderr.trim()));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        if paths.len() > 256 {
            return Err("macOS file clipboard accepts at most 256 paths".to_string());
        }

        let canonical = paths
            .iter()
            .map(|path| {
                std::fs::canonicalize(path)
                    .map_err(|error| format!("macOS file clipboard '{}': {error}", path))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| format!("macOS file clipboard init: {error}"))?;
        clipboard
            .set()
            .file_list(&canonical)
            .map_err(|error| format!("macOS file clipboard write: {error}"))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn file_clipboard_rejects_missing_and_oversized_path_lists_before_writing() {
            let missing = vec!["/definitely/not/a/taomni/clipboard/file".to_string()];
            assert!(
                super::clipboard_write_files(&missing)
                    .unwrap_err()
                    .contains("clipboard")
            );

            let oversized = vec!["/tmp/unused".to_string(); 257];
            assert!(
                super::clipboard_write_files(&oversized)
                    .unwrap_err()
                    .contains("at most 256")
            );
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::initial_dir_from;
    use std::path::Path;
    use std::process::{Command, Output, Stdio};

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

    pub fn select_folder_path(current_path: Option<&str>) -> Result<Option<String>, String> {
        let initial = initial_dir_from(current_path).or_else(dirs::home_dir);
        open_dir_dialog("Select folder to open", initial.as_deref())
    }

    pub fn select_file_path(current_path: Option<&str>) -> Result<Option<String>, String> {
        let initial = initial_dir_from(current_path);
        open_file_dialog("Select file to open", initial.as_deref())
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

    /// Best-effort text fallback for environments where arboard cannot answer
    /// an X11 selection request (or where only a Wayland helper is available).
    /// A missing owner is reported as `None`, allowing the WebKit clipboard
    /// API or the caller's normal empty-clipboard handling to decide next.
    pub fn clipboard_read_text_fallback() -> Result<Option<String>, String> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            if let Ok(Some(text)) = run_clipboard_reader("wl-paste", &["--no-newline"]) {
                return Ok(Some(text));
            }
        }
        if std::env::var_os("DISPLAY").is_some() {
            if let Ok(Some(text)) =
                run_clipboard_reader("xclip", &["-selection", "clipboard", "-o"])
            {
                return Ok(Some(text));
            }
            if let Ok(Some(text)) = run_clipboard_reader("xsel", &["--clipboard", "--output"]) {
                return Ok(Some(text));
            }
        }
        Ok(None)
    }

    /// `wl-copy` exits after handing ownership to the compositor. X11 owners
    /// are deliberately not spawned here: a synchronous xclip/xsel fallback
    /// would either block forever or lose ownership as soon as the helper is
    /// killed. arboard remains the authoritative X11 writer.
    pub fn clipboard_write_text_fallback(text: &str) -> Result<(), String> {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err("no Wayland clipboard helper available".into());
        }
        let mut child = Command::new("wl-copy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("wl-copy: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            std::io::Write::write_all(&mut stdin, text.as_bytes())
                .map_err(|e| format!("wl-copy stdin: {}", e))?;
        }
        let status = child.wait().map_err(|e| format!("wl-copy: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("wl-copy exited with {}", status))
        }
    }

    fn open_file_dialog_multi(
        title: &str,
        initial_dir: Option<&Path>,
    ) -> Result<Vec<String>, String> {
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
                Err(DialogAttempt::Failed(format!(
                    "{helper}: {}",
                    stderr.trim()
                )))
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

    pub fn clipboard_read_files() -> Result<Vec<String>, String> {
        const MIME_TYPES: &[&str] = &["x-special/gnome-copied-files", "text/uri-list"];
        for mime in MIME_TYPES {
            if let Some(payload) =
                run_clipboard_reader("wl-paste", &["--no-newline", "--type", mime])?
            {
                let paths = super::clipboard_paths_from_uri_text(&payload);
                if !paths.is_empty() {
                    return Ok(paths);
                }
            }
        }
        for mime in MIME_TYPES {
            if let Some(payload) =
                run_clipboard_reader("xclip", &["-selection", "clipboard", "-t", mime, "-o"])?
            {
                let paths = super::clipboard_paths_from_uri_text(&payload);
                if !paths.is_empty() {
                    return Ok(paths);
                }
            }
        }
        if let Some(payload) = run_clipboard_reader("xsel", &["--clipboard", "--output"])? {
            let paths = super::clipboard_paths_from_uri_text(&payload);
            if !paths.is_empty() {
                return Ok(paths);
            }
        }
        Ok(Vec::new())
    }

    fn run_clipboard_reader(program: &str, args: &[&str]) -> Result<Option<String>, String> {
        match Command::new(program).args(args).output() {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("{program}: {err}")),
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout).to_string();
                Ok((!text.trim().is_empty()).then_some(text))
            }
            Ok(_) => Ok(None),
        }
    }

    pub fn clipboard_write_files(_paths: &[String]) -> Result<(), String> {
        Err("native file clipboard is not implemented on this Linux desktop".to_string())
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

    pub fn select_folder_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }

    pub fn select_file_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }

    pub fn clipboard_read_files() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    pub fn clipboard_write_files(_paths: &[String]) -> Result<(), String> {
        Err("Native file clipboard is not supported on this platform".to_string())
    }
}
