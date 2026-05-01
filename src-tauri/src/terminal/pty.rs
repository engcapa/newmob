use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::Read;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;

pub struct PtyHandle {
    pub writer: Box<dyn std::io::Write + Send>,
    pub reader_thread: Option<std::thread::JoinHandle<()>>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellOption {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    pub is_default: bool,
    pub can_elevate: bool,
}

#[derive(Clone, Debug)]
pub struct ShellLaunch {
    pub program: String,
    pub args: Vec<String>,
}

pub fn list_local_shells() -> Vec<LocalShellOption> {
    let mut shells = platform_local_shells();

    if shells.is_empty() {
        let fallback = fallback_shell_launch();
        shells.push(LocalShellOption {
            id: "default".to_string(),
            name: "Default shell".to_string(),
            path: fallback.program,
            args: fallback.args,
            is_default: true,
            can_elevate: cfg!(windows),
        });
    }

    if !shells.iter().any(|shell| shell.is_default) {
        if let Some(first) = shells.first_mut() {
            first.is_default = true;
        }
    }

    shells
}

pub fn resolve_shell(shell: Option<String>) -> ShellLaunch {
    if let Some(raw) = shell {
        let requested = raw.trim();
        if !requested.is_empty() {
            if let Some(option) = list_local_shells()
                .into_iter()
                .find(|option| option.id == requested)
            {
                return ShellLaunch {
                    program: option.path,
                    args: option.args,
                };
            }

            return ShellLaunch {
                program: requested.to_string(),
                args: Vec::new(),
            };
        }
    }

    list_local_shells()
        .into_iter()
        .find(|option| option.is_default)
        .map(|option| ShellLaunch {
            program: option.path,
            args: option.args,
        })
        .unwrap_or_else(fallback_shell_launch)
}

pub fn open_shell_as_administrator(shell: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let shell_launch = resolve_shell(shell);
        return open_elevated_with_powershell(&shell_launch);
    }

    #[cfg(not(windows))]
    {
        let _ = shell;
        Err("Administrator local terminals are only supported on Windows".to_string())
    }
}

fn fallback_shell_launch() -> ShellLaunch {
    #[cfg(unix)]
    {
        ShellLaunch {
            program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
            args: Vec::new(),
        }
    }
    #[cfg(windows)]
    {
        ShellLaunch {
            program: std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string()),
            args: Vec::new(),
        }
    }
}

#[cfg(windows)]
fn platform_local_shells() -> Vec<LocalShellOption> {
    let windows_powershell = find_windows_powershell();
    let command_prompt = find_command_prompt();
    let powershell = find_powershell_7();
    let git_bash = find_git_bash();

    let default_id = if powershell.is_some() {
        "powershell"
    } else if windows_powershell.is_some() {
        "windows-powershell"
    } else if command_prompt.is_some() {
        "command-prompt"
    } else {
        "git-bash"
    };

    let mut shells = Vec::new();
    if let Some(path) = windows_powershell {
        shells.push(shell_option(
            "windows-powershell",
            "Windows PowerShell",
            path,
            vec!["-NoLogo".to_string()],
            default_id,
        ));
    }
    if let Some(path) = command_prompt {
        shells.push(shell_option(
            "command-prompt",
            "Command Prompt",
            path,
            Vec::new(),
            default_id,
        ));
    }
    if let Some(path) = powershell {
        shells.push(shell_option(
            "powershell",
            "PowerShell",
            path,
            vec!["-NoLogo".to_string()],
            default_id,
        ));
    }
    if let Some(path) = git_bash {
        shells.push(shell_option(
            "git-bash",
            "Git Bash",
            path,
            vec!["--login".to_string(), "-i".to_string()],
            default_id,
        ));
    }

    shells
}

#[cfg(unix)]
fn platform_local_shells() -> Vec<LocalShellOption> {
    let shell = std::env::var("SHELL")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| first_existing(["/bin/zsh", "/bin/bash", "/bin/sh"].map(PathBuf::from)));

    shell
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Default shell")
                .to_string();
            LocalShellOption {
                id: "default".to_string(),
                name,
                path: path_to_string(path),
                args: Vec::new(),
                is_default: true,
                can_elevate: false,
            }
        })
        .into_iter()
        .collect()
}

#[cfg(windows)]
fn shell_option(
    id: &str,
    name: &str,
    path: PathBuf,
    args: Vec<String>,
    default_id: &str,
) -> LocalShellOption {
    LocalShellOption {
        id: id.to_string(),
        name: name.to_string(),
        path: path_to_string(path),
        args,
        is_default: id == default_id,
        can_elevate: true,
    }
}

#[cfg(windows)]
fn open_elevated_with_powershell(shell: &ShellLaunch) -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let launcher = find_windows_powershell().unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let script = if shell.args.is_empty() {
        format!(
            "Start-Process -FilePath {} -Verb RunAs",
            quote_powershell_string(&shell.program)
        )
    } else {
        let args = shell
            .args
            .iter()
            .map(|arg| quote_powershell_string(arg))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "Start-Process -FilePath {} -ArgumentList @({}) -Verb RunAs",
            quote_powershell_string(&shell.program),
            args,
        )
    };

    let output = std::process::Command::new(launcher)
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(script)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to request administrator shell: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!(
                "Administrator shell request failed with exit code {:?}",
                output.status.code()
            ))
        } else {
            Err(stderr)
        }
    }
}

#[cfg(windows)]
fn quote_powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn find_powershell_7() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = find_in_path("pwsh.exe") {
        candidates.push(path);
    }
    candidates.extend(
        [
            env_join("ProgramFiles", "PowerShell\\7\\pwsh.exe"),
            env_join("ProgramW6432", "PowerShell\\7\\pwsh.exe"),
            env_join("ProgramFiles(x86)", "PowerShell\\7\\pwsh.exe"),
            env_join("LOCALAPPDATA", "Microsoft\\powershell\\7\\pwsh.exe"),
            env_join("LOCALAPPDATA", "Programs\\PowerShell\\7\\pwsh.exe"),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn find_windows_powershell() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = find_in_path("powershell.exe") {
        candidates.push(path);
    }
    candidates.extend(
        [
            env_join(
                "SystemRoot",
                "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ),
            env_join(
                "WINDIR",
                "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn find_command_prompt() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(comspec) = std::env::var_os("COMSPEC").map(PathBuf::from) {
        candidates.push(comspec);
    }
    if let Some(path) = find_in_path("cmd.exe") {
        candidates.push(path);
    }
    candidates.extend(
        [
            env_join("SystemRoot", "System32\\cmd.exe"),
            env_join("WINDIR", "System32\\cmd.exe"),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = find_in_path("bash.exe").filter(|path| is_git_bash_path(path)) {
        candidates.push(path);
    }
    if let Some(git) = find_in_path("git.exe") {
        if let Some(parent) = git.parent() {
            let dir_name = parent
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();

            if dir_name == "cmd" {
                if let Some(root) = parent.parent() {
                    candidates.push(root.join("bin\\bash.exe"));
                }
            } else if dir_name == "bin" {
                candidates.push(parent.join("bash.exe"));
            }
        }
    }
    candidates.extend(
        [
            env_join("ProgramFiles", "Git\\bin\\bash.exe"),
            env_join("ProgramW6432", "Git\\bin\\bash.exe"),
            env_join("ProgramFiles(x86)", "Git\\bin\\bash.exe"),
            env_join("LOCALAPPDATA", "Programs\\Git\\bin\\bash.exe"),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn is_git_bash_path(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\git\\")
}

#[cfg(windows)]
fn env_join(var: &str, child: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|base| base.join(child))
}

#[cfg(windows)]
fn find_in_path(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
}

fn first_existing<I>(paths: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    paths.into_iter().find(|path| path.is_file())
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

pub fn create_pty(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<(PtyHandle, Box<dyn Read + Send>), String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell_launch = resolve_shell(shell);
    let mut cmd = CommandBuilder::new(&shell_launch.program);
    for arg in &shell_launch.args {
        cmd.arg(arg);
    }

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Must drop slave so master reads work properly
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let handle = PtyHandle {
        writer,
        reader_thread: None,
        child,
        master: pair.master,
    };

    Ok((handle, reader))
}

pub fn resize_pty(master: &dyn portable_pty::MasterPty, cols: u16, rows: u16) -> Result<(), String> {
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))
}
