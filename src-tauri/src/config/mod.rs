use crate::state::{AppState, WriteStreamHandle};
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use tauri::http::{self, header, Method, StatusCode};
use tauri::ipc::{InvokeBody, Request, Response as IpcResponse};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeResponder};

const FILE_PROTOCOL_CONTENT_TYPE: &str = "application/octet-stream";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadUrl {
    token: String,
    url: String,
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
pub fn read_file_bytes(path: String) -> Result<IpcResponse, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let bytes = std::fs::read(&expanded).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub fn create_file_read_url(
    path: String,
    state: State<'_, AppState>,
) -> Result<FileReadUrl, String> {
    let expanded = expanded_path(&path);
    if !expanded.is_file() {
        return Err(format!("File not found: {}", expanded.display()));
    }

    let token = uuid::Uuid::new_v4().to_string();
    let mut tokens = state
        .file_read_tokens
        .lock()
        .map_err(|e| format!("File read token lock failed: {}", e))?;
    tokens.insert(token.clone(), expanded);

    Ok(FileReadUrl {
        url: format!("newmob-file://localhost/read?token={token}"),
        token,
    })
}

#[tauri::command]
pub fn release_file_read_url(token: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tokens = state
        .file_read_tokens
        .lock()
        .map_err(|e| format!("File read token lock failed: {}", e))?;
    tokens.remove(&token);
    Ok(())
}

pub fn respond_file_read_request<R: Runtime>(
    app: &AppHandle<R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let response = build_file_read_response(app, &request).unwrap_or_else(error_response);
    responder.respond(response);
}

fn build_file_read_response<R: Runtime>(
    app: &AppHandle<R>,
    request: &http::Request<Vec<u8>>,
) -> Result<http::Response<Vec<u8>>, (StatusCode, String)> {
    if request.method() == Method::OPTIONS {
        return response_builder(StatusCode::NO_CONTENT)
            .body(Vec::new())
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }

    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Err((
            StatusCode::METHOD_NOT_ALLOWED,
            "Only GET, HEAD and OPTIONS are supported".to_string(),
        ));
    }

    let token = query_param(request.uri().query().unwrap_or_default(), "token")
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing token".to_string()))?;
    let state = app.state::<AppState>();
    let path = {
        let tokens = state
            .file_read_tokens
            .lock()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        tokens
            .get(token)
            .cloned()
            .ok_or_else(|| (StatusCode::FORBIDDEN, "Invalid file token".to_string()))?
    };

    let metadata = std::fs::metadata(&path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Failed to stat file: {}", e)))?;
    if !metadata.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Path is not a file".to_string()));
    }

    let total_len = metadata.len();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| parse_range(value, total_len))
        .transpose()?;

    let (status, start, end, body_len) = if let Some((start, end)) = range {
        (
            StatusCode::PARTIAL_CONTENT,
            start,
            end,
            end.saturating_sub(start).saturating_add(1),
        )
    } else if total_len == 0 {
        (StatusCode::OK, 0, 0, 0)
    } else {
        (StatusCode::OK, 0, total_len - 1, total_len)
    };

    let body = if request.method() == Method::HEAD || body_len == 0 {
        Vec::new()
    } else {
        read_file_range(&path, start, body_len)?
    };

    let mut builder = response_builder(status).header(header::CONTENT_LENGTH, body_len.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total_len}"),
        );
    }

    builder
        .body(body)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

fn response_builder(status: StatusCode) -> http::response::Builder {
    http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, FILE_PROTOCOL_CONTENT_TYPE)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "range")
}

fn error_response((status, message): (StatusCode, String)) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.into_bytes())
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}

fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then_some(value)
    })
}

fn parse_range(value: &str, total_len: u64) -> Result<(u64, u64), (StatusCode, String)> {
    if total_len == 0 {
        return Err((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "Cannot range-read an empty file".to_string(),
        ));
    }

    let spec = value
        .strip_prefix("bytes=")
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Invalid Range header".to_string()))?;
    if spec.contains(',') {
        return Err((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "Multiple ranges are not supported".to_string(),
        ));
    }

    let (start_raw, end_raw) = spec
        .split_once('-')
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Invalid Range header".to_string()))?;
    if start_raw.is_empty() {
        let suffix = end_raw
            .parse::<u64>()
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid Range header".to_string()))?;
        if suffix == 0 {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Invalid suffix range".to_string(),
            ));
        }
        let start = total_len.saturating_sub(suffix);
        return Ok((start, total_len - 1));
    }

    let start = start_raw
        .parse::<u64>()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid Range header".to_string()))?;
    if start >= total_len {
        return Err((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "Range start is past end of file".to_string(),
        ));
    }

    let end = if end_raw.is_empty() {
        total_len - 1
    } else {
        end_raw
            .parse::<u64>()
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid Range header".to_string()))?
            .min(total_len - 1)
    };
    if end < start {
        return Err((StatusCode::BAD_REQUEST, "Invalid Range header".to_string()));
    }

    Ok((start, end))
}

fn read_file_range(path: &PathBuf, start: u64, len: u64) -> Result<Vec<u8>, (StatusCode, String)> {
    let mut file = File::open(path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Failed to open file: {}", e)))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut body = Vec::with_capacity(len.min(usize::MAX as u64) as usize);
    file.take(len)
        .read_to_end(&mut body)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(body)
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

#[cfg(windows)]
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
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;

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
}
