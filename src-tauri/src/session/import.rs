use super::import_secrets::crypto::aes_128_cbc_decrypt_pkcs7;
use super::models::{AuthMethod, SessionConfig, SessionType};
use serde::Serialize;
use serde_json::json;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_LOCAL_SESSION_FILE_BYTES: u64 = 2_000_000;
const DBEAVER_CREDENTIALS_CONFIG_FILE: &str = "credentials-config.json";
const DBEAVER_LOCAL_CREDENTIALS_KEY: [u8; 16] = [
    0xba, 0xbb, 0x4a, 0x9f, 0x77, 0x4a, 0xb8, 0x53, 0xc9, 0x6c, 0x2d, 0x65, 0x3d, 0xfe, 0x54, 0x4a,
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionFile {
    pub source: String,
    pub path: String,
    pub relative_path: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbeaverCredentialEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[tauri::command]
pub fn import_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    platform_putty_sessions()
}

#[tauri::command]
pub fn import_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    platform_wsl_sessions()
}

#[tauri::command]
pub fn import_external_bash_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(platform_external_bash_sessions())
}

#[tauri::command]
pub fn scan_local_session_files(source: String) -> Result<Vec<LocalSessionFile>, String> {
    let key = source.trim().to_ascii_lowercase();
    let mut files = Vec::new();
    match key.as_str() {
        "xshell" => scan_xshell(&mut files),
        "tabby" => scan_tabby(&mut files),
        "windterm" => scan_windterm(&mut files),
        "dbeaver" => scan_dbeaver(&mut files),
        "iterm2" | "iterm" => scan_iterm2(&mut files),
        "terminal" | "terminal.app" => scan_terminal_app(&mut files),
        "termius" => scan_termius_exports(&mut files),
        "mremote" | "mremoteng" => scan_mremote(&mut files),
        "securecrt" | "scrt" => scan_securecrt(&mut files),
        _ => return Err(format!("Unsupported local session source: {}", source)),
    }
    Ok(files)
}

#[tauri::command]
pub fn read_dbeaver_credentials_for_data_sources(
    path: String,
) -> Result<HashMap<String, DbeaverCredentialEntry>, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let data_sources_path = PathBuf::from(&expanded);
    let data_sources_meta = fs::metadata(&data_sources_path)
        .map_err(|e| format!("Failed to read DBeaver data-source metadata: {}", e))?;
    if !data_sources_meta.is_file() {
        return Err("The selected DBeaver data-source path is not a file.".to_string());
    }
    let credentials_path = data_sources_path
        .parent()
        .ok_or_else(|| "The selected DBeaver data-source path has no parent folder.".to_string())?
        .join(DBEAVER_CREDENTIALS_CONFIG_FILE);
    if !credentials_path.exists() {
        return Ok(HashMap::new());
    }

    let credentials_meta = fs::metadata(&credentials_path)
        .map_err(|e| format!("Failed to read DBeaver credentials metadata: {}", e))?;
    if !credentials_meta.is_file() {
        return Err("The DBeaver credentials-config.json path is not a file.".to_string());
    }
    if credentials_meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return Err(
            "The DBeaver credentials-config.json file is too large to import safely.".to_string(),
        );
    }

    let encrypted = fs::read(&credentials_path)
        .map_err(|e| format!("Failed to read DBeaver credentials-config.json: {}", e))?;
    parse_dbeaver_credentials_config(&encrypted)
        .map_err(|e| format!("Failed to decrypt DBeaver credentials-config.json: {}", e))
}

#[tauri::command]
pub fn read_plist_session_file(path: String) -> Result<LocalSessionFile, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let path_buf = PathBuf::from(&expanded);
    let meta =
        fs::metadata(&path_buf).map_err(|e| format!("Failed to read plist metadata: {}", e))?;
    if !meta.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return Err("The selected plist file is too large to import safely.".to_string());
    }

    let value = plist::Value::from_file(&path_buf)
        .map_err(|e| format!("Failed to parse plist file: {}", e))?;
    let mut bytes = Vec::new();
    value
        .to_writer_xml(&mut bytes)
        .map_err(|e| format!("Failed to convert plist file to XML: {}", e))?;
    let text = String::from_utf8(bytes)
        .map_err(|e| format!("Converted plist XML was not UTF-8: {}", e))?;
    let relative_path = path_buf
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("session.plist")
        .to_string();

    Ok(LocalSessionFile {
        source: "plist".to_string(),
        path: path_buf.to_string_lossy().into_owned(),
        relative_path,
        text,
    })
}

fn parse_dbeaver_credentials_config(
    encrypted: &[u8],
) -> Result<HashMap<String, DbeaverCredentialEntry>, String> {
    if encrypted.len() <= 16 {
        return Err("encrypted payload is too short".to_string());
    }
    let iv = &encrypted[..16];
    let ciphertext = &encrypted[16..];
    let plaintext = aes_128_cbc_decrypt_pkcs7(&DBEAVER_LOCAL_CREDENTIALS_KEY, iv, ciphertext)
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(plaintext.as_slice())
        .map_err(|e| format!("decrypted payload is not valid JSON: {}", e))?;
    Ok(extract_dbeaver_credentials(parsed))
}

fn extract_dbeaver_credentials(parsed: Value) -> HashMap<String, DbeaverCredentialEntry> {
    let mut out = HashMap::new();
    let Some(root) = parsed.as_object() else {
        return out;
    };

    for (connection_id, raw_sections) in root {
        let Some(section_object) = raw_sections.as_object() else {
            continue;
        };
        let Some(connection_section) = section_object.get("#connection").and_then(|value| value.as_object()) else {
            continue;
        };
        let mut entry = DbeaverCredentialEntry::default();
        entry.user = first_non_empty_json_field(connection_section, &["user", "username"]);
        entry.password = first_non_empty_json_field(connection_section, &["password"]);
        if entry.user.is_some() || entry.password.is_some() {
            out.insert(connection_id.clone(), entry);
        }
    }

    out
}

fn first_non_empty_json_field(
    fields: &serde_json::Map<String, Value>,
    names: &[&str],
) -> Option<String> {
    for name in names {
        if let Some(value) = fields.get(*name) {
            if let Some(text) = value.as_str() {
                if !text.trim().is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn platform_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let sessions_key = hkcu
        .open_subkey("Software\\SimonTatham\\PuTTY\\Sessions")
        .map_err(|e| format!("PuTTY sessions registry key was not found: {}", e))?;

    let mut out = Vec::new();
    let now = now_seconds();
    for key_name in sessions_key.enum_keys().flatten() {
        let Ok(session_key) = sessions_key.open_subkey(&key_name) else {
            continue;
        };
        let host_name = reg_string(&session_key, "HostName");
        if host_name.trim().is_empty() {
            continue;
        }
        let protocol = reg_string(&session_key, "Protocol").to_ascii_lowercase();
        let session_type = match protocol.as_str() {
            "telnet" => SessionType::Telnet,
            "serial" => SessionType::Serial,
            _ => SessionType::SSH,
        };
        let port =
            reg_u16(&session_key, "PortNumber").unwrap_or_else(|| session_type.default_port());
        let (username, host) = split_user_host(&host_name, reg_string(&session_key, "UserName"));
        if host.trim().is_empty() && session_type != SessionType::Serial {
            continue;
        }
        let key_path = reg_string(&session_key, "PublicKeyFile");
        let auth_method = if !key_path.trim().is_empty() {
            AuthMethod::PrivateKey { key_path }
        } else if session_type == SessionType::SSH {
            AuthMethod::Password
        } else {
            AuthMethod::None
        };

        out.push(SessionConfig {
            id: Uuid::new_v4().to_string(),
            name: percent_decode(&key_name),
            session_type,
            group_path: Some("User sessions / Imported / PuTTY".to_string()),
            host,
            port,
            username,
            auth_method,
            options_json: json!({ "description": "Imported from PuTTY registry" }).to_string(),
            created_at: now,
            updated_at: now,
            last_connected_at: None,
            sort_order: 0,
        });
    }

    Ok(out)
}

#[cfg(not(windows))]
fn platform_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn reg_string(key: &winreg::RegKey, name: &str) -> String {
    key.get_value::<String, _>(name).unwrap_or_default()
}

#[cfg(windows)]
fn reg_u16(key: &winreg::RegKey, name: &str) -> Option<u16> {
    key.get_value::<u32, _>(name)
        .ok()
        .and_then(|value| u16::try_from(value).ok())
}

#[cfg(windows)]
fn platform_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    let distros = crate::wsl::list_distros()?;
    let now = now_seconds();
    let mut sessions = Vec::with_capacity(distros.len());
    for distro in distros {
        sessions.push(local_shell_session(
            format!("WSL: {}", distro.name),
            "User sessions / Imported / WSL",
            "wsl.exe".to_string(),
            vec!["-d".to_string(), distro.name],
            "Imported from WSL",
            now,
        ));
    }
    Ok(sessions)
}

#[cfg(not(windows))]
fn platform_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(Vec::new())
}

fn platform_external_bash_sessions() -> Vec<SessionConfig> {
    let now = now_seconds();
    let mut candidates: Vec<(String, PathBuf, Vec<String>)> = Vec::new();

    #[cfg(windows)]
    {
        candidates.extend(
            [
                (
                    "Git Bash".to_string(),
                    env_join("ProgramFiles", "Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Git Bash".to_string(),
                    env_join("ProgramW6432", "Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Git Bash".to_string(),
                    env_join("ProgramFiles(x86)", "Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Git Bash".to_string(),
                    env_join("LOCALAPPDATA", "Programs\\Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Cygwin Bash".to_string(),
                    Some(PathBuf::from("C:\\cygwin64\\bin\\bash.exe")),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "MSYS2 Bash".to_string(),
                    Some(PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe")),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
            ]
            .into_iter()
            .filter_map(|(name, path, args)| path.map(|p| (name, p, args))),
        );
    }

    #[cfg(unix)]
    {
        candidates.extend([
            (
                "Bash".to_string(),
                PathBuf::from("/bin/bash"),
                vec!["--login".to_string()],
            ),
            ("Zsh".to_string(), PathBuf::from("/bin/zsh"), Vec::new()),
            (
                "Fish".to_string(),
                PathBuf::from("/usr/bin/fish"),
                Vec::new(),
            ),
        ]);
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|(_, path, _)| path.is_file())
        .filter(|(_, path, _)| seen.insert(path.to_string_lossy().to_ascii_lowercase()))
        .map(|(name, path, args)| {
            local_shell_session(
                name,
                "User sessions / Imported / External Bash",
                path.to_string_lossy().into_owned(),
                args,
                "Imported from local shell scan",
                now,
            )
        })
        .collect()
}

fn local_shell_session(
    name: String,
    group_path: &str,
    shell_path: String,
    shell_args: Vec<String>,
    description: &str,
    now: i64,
) -> SessionConfig {
    SessionConfig {
        id: Uuid::new_v4().to_string(),
        name,
        session_type: SessionType::LocalShell,
        group_path: Some(group_path.to_string()),
        host: String::new(),
        port: 0,
        username: None,
        auth_method: AuthMethod::None,
        options_json: json!({
            "localShellPath": shell_path,
            "localShellArgs": shell_args,
            "description": description,
        })
        .to_string(),
        created_at: now,
        updated_at: now,
        last_connected_at: None,
        sort_order: 0,
    }
}

fn scan_xshell(files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    {
        let mut roots: Vec<PathBuf> = Vec::new();

        // Modern Xshell (6/7) stores sessions under the user's Documents folder:
        //   <Documents>\NetSarang Computer\<version>\Xshell\Sessions
        // The Documents folder is frequently redirected (e.g. OneDrive Known
        // Folder Move), so resolve it from the shell-folders registry and probe
        // the common fallbacks before walking the version subdirectories.
        for documents in windows_documents_dirs() {
            collect_xshell_session_dirs(&documents.join("NetSarang Computer"), &mut roots);
        }

        // The user-data folder can be relocated from within Xshell; that path is
        // recorded in the registry. Probe both the bare Sessions folder and the
        // versioned NetSarang Computer layout under it.
        for user_data in xshell_user_data_paths() {
            roots.push(user_data.join("Xshell").join("Sessions"));
            collect_xshell_session_dirs(&user_data.join("NetSarang Computer"), &mut roots);
        }

        // Legacy location used by older builds.
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("NetSarang").join("Xshell").join("Sessions"));
        }

        let mut seen_roots = HashSet::new();
        for root in roots {
            if !seen_roots.insert(root.to_string_lossy().to_ascii_lowercase()) {
                continue;
            }
            scan_dir_for_ext("xshell", &root, "xsh", files);
        }

        dedup_files_by_path(files);
    }
    #[cfg(not(windows))]
    {
        let _ = files;
    }
}

/// Walks a `NetSarang Computer` directory and collects every
/// `<version>\Xshell\Sessions` folder that exists under it.
#[cfg(windows)]
fn collect_xshell_session_dirs(netsarang_computer: &Path, roots: &mut Vec<PathBuf>) {
    if !netsarang_computer.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(netsarang_computer) else {
        return;
    };
    for entry in entries.flatten() {
        let version_dir = entry.path();
        if version_dir.is_dir() {
            let sessions = version_dir.join("Xshell").join("Sessions");
            if sessions.is_dir() {
                roots.push(sessions);
            }
        }
    }
}

/// Candidate Documents directories, accounting for OneDrive folder redirection.
#[cfg(windows)]
fn windows_documents_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(personal) = shell_folder_personal() {
        out.push(personal);
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        out.push(profile.join("Documents"));
        out.push(profile.join("OneDrive").join("Documents"));
    }
    for var in ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] {
        if let Some(onedrive) = std::env::var_os(var).map(PathBuf::from) {
            out.push(onedrive.join("Documents"));
        }
    }
    out
}

/// Reads the (already env-expanded) Documents path from the Shell Folders key.
#[cfg(windows)]
fn shell_folder_personal() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders")
        .ok()?;
    let personal: String = key.get_value("Personal").ok()?;
    if personal.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(personal.trim()))
    }
}

/// User-data paths configured by Xshell, read from `UserDataPath` in the
/// per-version NetSarang registry keys.
#[cfg(windows)]
fn xshell_user_data_paths() -> Vec<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut out = Vec::new();
    for version in ["8", "7", "6", "5"] {
        let subkey = format!("Software\\NetSarang\\Common\\{}\\UserData", version);
        if let Ok(key) = hkcu.open_subkey(&subkey) {
            if let Ok(path) = key.get_value::<String, _>("UserDataPath") {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    out.push(PathBuf::from(trimmed));
                }
            }
        }
    }
    out
}

/// Removes duplicate files that the same `.xsh` resolved to via several roots
/// (Documents, registry user-data, OneDrive mirror), keeping the first hit.
#[cfg(windows)]
fn dedup_files_by_path(files: &mut Vec<LocalSessionFile>) {
    let mut seen = HashSet::new();
    files.retain(|file| seen.insert(file.path.to_ascii_lowercase()));
}

fn scan_tabby(files: &mut Vec<LocalSessionFile>) {
    for path in tabby_config_candidates() {
        push_file(
            "tabby",
            &path,
            path.file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("config.yaml"),
            files,
        );
    }
}

fn scan_windterm(files: &mut Vec<LocalSessionFile>) {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("WINDTERM_PROFILE_DIR").map(PathBuf::from) {
        roots.push(path);
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".wind"));
        roots.push(home.join("WindTerm"));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(local.join("WindTerm"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("WindTerm"));
        }
    }

    for root in roots {
        scan_dir_for_names(
            "windterm",
            &root,
            &["user.sessions", "user.sessions.json"],
            files,
        );
    }
}

fn scan_dbeaver(files: &mut Vec<LocalSessionFile>) {
    let mut roots = Vec::new();
    if let Some(workspace) = std::env::var_os("DBEAVER_WORKSPACE").map(PathBuf::from) {
        roots.push(workspace);
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".dbeaver4"));
        roots.push(home.join(".local").join("share").join("DBeaverData"));
        roots.push(home.join(".config").join("DBeaverData"));
        roots.push(
            home.join("snap")
                .join("dbeaver-ce")
                .join("current")
                .join(".local")
                .join("share")
                .join("DBeaverData"),
        );

        #[cfg(target_os = "macos")]
        {
            roots.push(home.join("Library").join("DBeaverData"));
            roots.push(
                home.join("Library")
                    .join("Application Support")
                    .join("DBeaverData"),
            );
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("DBeaverData"));
            roots.push(appdata.join("DBeaver"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(local.join("DBeaverData"));
            roots.push(local.join("DBeaver"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
            roots.push(profile.join(".dbeaver4"));
        }
    }

    let names = [
        "data-sources.json",
        "data-sources.xml",
        ".dbeaver-data-sources.xml",
    ];
    for root in roots {
        scan_dir_for_names("dbeaver", &root, &names, files);
    }
    dedup_files_by_path_case_insensitive(files);
}

fn scan_iterm2(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let root = home
            .join("Library")
            .join("Application Support")
            .join("iTerm2")
            .join("DynamicProfiles");
        scan_dir_for_ext("iterm2", &root, "json", _files);
        scan_dir_for_ext("iterm2", &root, "plist", _files);
    }
}

fn scan_terminal_app(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let pref = home
            .join("Library")
            .join("Preferences")
            .join("com.apple.Terminal.plist");
        if pref.is_file() {
            if let Ok(output) = Command::new("plutil")
                .args(["-convert", "xml1", "-o", "-", &pref.to_string_lossy()])
                .output()
            {
                if output.status.success() {
                    let text = decode_command_output(&output.stdout);
                    _files.push(LocalSessionFile {
                        source: "terminal".to_string(),
                        path: pref.to_string_lossy().into_owned(),
                        relative_path: "com.apple.Terminal.plist".to_string(),
                        text,
                    });
                }
            }
        }
    }
}

fn scan_termius_exports(files: &mut Vec<LocalSessionFile>) {
    if let Some(home) = home_dir() {
        for rel in [
            ".termius/ssh_config",
            ".termius/exported_ssh_config",
            "termius-ssh-config",
            "Downloads/termius-ssh-config",
        ] {
            push_file("termius", &home.join(rel), rel, files);
        }
    }
}

fn scan_mremote(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        push_file(
            "mremote",
            &appdata.join("mRemoteNG").join("confCons.xml"),
            "confCons.xml",
            _files,
        );
    }
}

fn scan_securecrt(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        scan_dir_for_ext(
            "securecrt",
            &appdata.join("VanDyke").join("Config").join("Sessions"),
            "ini",
            _files,
        );
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        scan_dir_for_ext(
            "securecrt",
            &home
                .join("Library")
                .join("Application Support")
                .join("VanDyke")
                .join("Config")
                .join("Sessions"),
            "ini",
            _files,
        );
    }
}

fn tabby_config_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        out.push(appdata.join("tabby").join("config.yaml"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        out.push(
            home.join("Library")
                .join("Application Support")
                .join("tabby")
                .join("config.yaml"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = home_dir() {
        out.push(home.join(".config").join("tabby").join("config.yaml"));
    }
    if let Some(home) = home_dir() {
        out.push(home.join(".tabby").join("config.yaml"));
    }
    out
}

fn scan_dir_for_ext(source: &str, root: &Path, ext: &str, files: &mut Vec<LocalSessionFile>) {
    scan_dir(source, root, files, &|path| {
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
    });
}

fn scan_dir_for_names(
    source: &str,
    root: &Path,
    names: &[&str],
    files: &mut Vec<LocalSessionFile>,
) {
    scan_dir(source, root, files, &|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(|value| names.iter().any(|name| value.eq_ignore_ascii_case(name)))
            .unwrap_or(false)
    });
}

fn scan_dir<F>(source: &str, root: &Path, files: &mut Vec<LocalSessionFile>, matches: &F)
where
    F: Fn(&Path) -> bool,
{
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(source, &path, files, matches);
        } else if matches(&path) {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            push_file(source, &path, &relative, files);
        }
    }
}

fn dedup_files_by_path_case_insensitive(files: &mut Vec<LocalSessionFile>) {
    let mut seen = HashSet::new();
    files.retain(|file| seen.insert(file.path.to_ascii_lowercase()));
}

fn push_file(source: &str, path: &Path, relative_path: &str, files: &mut Vec<LocalSessionFile>) {
    if !path.is_file() {
        return;
    }
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return;
    }
    if let Ok(bytes) = fs::read(path) {
        files.push(LocalSessionFile {
            source: source.to_string(),
            path: path.to_string_lossy().into_owned(),
            relative_path: relative_path.to_string(),
            text: decode_command_output(&bytes),
        });
    }
}

fn split_user_host(host_name: &str, explicit_user: String) -> (Option<String>, String) {
    if let Some((user, host)) = host_name.split_once('@') {
        if !user.trim().is_empty() && !host.trim().is_empty() {
            return (Some(user.trim().to_string()), host.trim().to_string());
        }
    }
    let user = if explicit_user.trim().is_empty() {
        None
    } else {
        Some(explicit_user.trim().to_string())
    };
    (user, host_name.trim().to_string())
}

pub(crate) fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    if bytes.len() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    if bytes.iter().filter(|byte| **byte == 0).count() > bytes.len() / 8 {
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    String::from_utf8_lossy(bytes).replace('\u{0}', "")
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(windows)]
fn env_join(var: &str, child: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|base| base.join(child))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::Aes128;
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockModeEncrypt, KeyIvInit};
    use serde_json::json;

    type Aes128CbcEnc = cbc::Encryptor<Aes128>;

    fn encrypt_dbeaver_credentials_fixture(plaintext: &[u8]) -> Vec<u8> {
        let iv = [0x42u8; 16];
        let block_size = 16;
        let pad = block_size - (plaintext.len() % block_size);
        let mut buf = vec![0u8; plaintext.len() + pad];
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let ct_len = Aes128CbcEnc::new_from_slices(&DBEAVER_LOCAL_CREDENTIALS_KEY, &iv)
            .expect("key and iv lengths are fixed")
            .encrypt_padded::<Pkcs7>(&mut buf, plaintext.len())
            .expect("encrypt")
            .len();
        buf.truncate(ct_len);

        let mut encrypted = iv.to_vec();
        encrypted.extend_from_slice(&buf);
        encrypted
    }

    #[test]
    fn decrypts_dbeaver_credentials_config() {
        let payload = json!({
            "conn-1": {
                "#connection": {
                    "user": "db_user",
                    "password": "db_pass"
                },
                "#ssh": {
                    "password": "ssh_pass"
                }
            },
            "conn-2": {
                "#connection": {
                    "user": "readonly"
                }
            }
        })
        .to_string();
        let encrypted = encrypt_dbeaver_credentials_fixture(payload.as_bytes());

        let parsed = parse_dbeaver_credentials_config(&encrypted).unwrap();

        let first = parsed.get("conn-1").unwrap();
        assert_eq!(first.user.as_deref(), Some("db_user"));
        assert_eq!(first.password.as_deref(), Some("db_pass"));
        let second = parsed.get("conn-2").unwrap();
        assert_eq!(second.user.as_deref(), Some("readonly"));
        assert_eq!(second.password, None);
    }

    #[test]
    fn rejects_short_dbeaver_credentials_payload() {
        let err = parse_dbeaver_credentials_config(&[0u8; 16]).unwrap_err();
        assert!(err.contains("too short"));
    }
}
