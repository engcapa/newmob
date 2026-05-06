use std::path::PathBuf;

#[tauri::command]
pub fn select_private_key_file(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_private_key_file(current_path.as_deref())
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
        CommDlgExtendedError, GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_HIDEREADONLY,
        OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
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
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;

    pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(r#"POSIX path of (choose file with prompt "Select private key")"#)
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

        match run_zenity(initial.as_deref()) {
            Ok(result) => return result,
            Err(DialogAttempt::NotFound) => {}
            Err(DialogAttempt::Failed(err)) => return Err(err),
        }

        match run_kdialog(initial.as_deref()) {
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
        initial_dir: Option<&Path>,
    ) -> Result<Result<Option<String>, String>, DialogAttempt> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg("--title=Select private key");
        if let Some(dir) = initial_dir {
            cmd.arg(format!("--filename={}", dir_with_separator(dir)));
        }
        handle_output(cmd.output(), "zenity")
    }

    fn run_kdialog(
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
}

#[cfg(not(any(windows, unix)))]
mod platform {
    pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
        Err("Native file dialog is not supported on this platform".to_string())
    }
}
