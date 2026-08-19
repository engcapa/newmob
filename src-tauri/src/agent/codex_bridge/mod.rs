//! Codex app-server bridge.
//!
//! Authentication is delegated to the `codex` CLI. This module intentionally
//! does not read OpenAI credentials from Taomni's vault; it only starts the
//! local CLI, configures per-thread app-server sessions, and routes Taomni MCP
//! tools through the same loopback bridge used by `cc_bridge`.

pub mod commands;
pub mod config;
pub mod process;
pub mod protocol;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

pub const MIN_VERSION: &str = "0.100.0";

pub(crate) fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

pub(crate) fn apply_proxy_env(cmd: &mut Command, proxy_url: Option<&str>) {
    let Some(proxy) = proxy_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    cmd.env("HTTP_PROXY", proxy)
        .env("HTTPS_PROXY", proxy)
        .env("ALL_PROXY", proxy)
        .env("NO_PROXY", "127.0.0.1,localhost");
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodexStatus {
    NotFound,
    VersionTooLow { found: String, required: String },
    NotAuthenticated,
    Ready { version: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexStatusResult {
    pub status: CodexStatus,
    pub message: String,
    pub binary_path: Option<String>,
}

pub fn find_codex_binary() -> Option<String> {
    let candidates: &[&str] = if cfg!(windows) {
        &["codex.cmd", "codex.exe", "codex"]
    } else {
        &["codex"]
    };

    for name in candidates {
        if let Ok(path) = which::which(name) {
            return Some(path.to_string_lossy().to_string());
        }
    }

    #[cfg(unix)]
    if let Some(path_var) = login_shell_path() {
        for dir in path_var.split(':') {
            let dir = dir.trim();
            if dir.is_empty() {
                continue;
            }
            let cand = PathBuf::from(dir).join("codex");
            if cand.is_file() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }

    for cand in common_install_locations() {
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }

    None
}

fn common_install_locations() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".local/bin/codex"));
        v.push(home.join(".codex/local/codex"));
        v.push(home.join("bin/codex"));
        v.push(home.join(".bun/bin/codex"));
        v.push(home.join(".npm-global/bin/codex"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin/codex"));
    v.push(PathBuf::from("/usr/local/bin/codex"));
    v.push(PathBuf::from("/usr/bin/codex"));
    v
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::process::{Command as StdCommand, Stdio};
    use std::sync::OnceLock;
    use std::sync::mpsc;

    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            const START: &str = "<<TAOMNI_PATH>>";
            const END: &str = "<</TAOMNI_PATH>>";
            const CMD: &str = "command printf '<<TAOMNI_PATH>>%s<</TAOMNI_PATH>>' \"$PATH\"";

            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                let result = StdCommand::new(&shell)
                    .args(["-ilc", CMD])
                    .stdin(Stdio::null())
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
                let _ = tx.send(result);
            });

            let out = rx.recv_timeout(Duration::from_secs(3)).ok()??;
            let start = out.find(START)? + START.len();
            let end = out[start..].find(END)? + start;
            let path = out[start..end].trim().to_string();
            if path.is_empty() { None } else { Some(path) }
        })
        .clone()
}

fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let parts: Vec<&str> = v.splitn(3, '.').collect();
    if parts.len() < 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].split('-').next()?.parse().ok()?,
    ))
}

fn version_ok(found: &str, required: &str) -> bool {
    let (fmaj, fmin, fpat) = parse_version(found).unwrap_or((0, 0, 0));
    let (rmaj, rmin, rpat) = parse_version(required).unwrap_or((0, 100, 0));
    (fmaj, fmin, fpat) >= (rmaj, rmin, rpat)
}

fn extract_version(out: &str) -> String {
    out.split_whitespace()
        .find(|s| {
            let s = s.trim_start_matches('v');
            s.chars().next().map_or(false, |c| c.is_ascii_digit()) && s.contains('.')
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| out.split_whitespace().last().unwrap_or("").to_string())
}

pub async fn detect(binary: Option<&str>, proxy_url: Option<&str>) -> CodexStatusResult {
    let (bin, version) = match detect_binary_version(binary).await {
        Ok(v) => v,
        Err(status) => return status,
    };

    if !probe_auth(&bin, proxy_url).await {
        return CodexStatusResult {
            status: CodexStatus::NotAuthenticated,
            message:
                "Codex CLI is installed but the auth probe failed. Run `codex login` and retry."
                    .into(),
            binary_path: Some(bin),
        };
    }

    CodexStatusResult {
        status: CodexStatus::Ready {
            version: version.clone(),
        },
        message: format!("Codex {} is ready.", version),
        binary_path: Some(bin),
    }
}

pub async fn detect_with_profile_runtime(
    binary: Option<&str>,
    proxy_url: Option<&str>,
    runtime: config::CodexProfileRuntime,
) -> CodexStatusResult {
    let (bin, version) = match detect_binary_version(binary).await {
        Ok(v) => v,
        Err(status) => return status,
    };

    if !probe_auth_with_app_server(&bin, proxy_url, runtime).await {
        return CodexStatusResult {
            status: CodexStatus::NotAuthenticated,
            message: "Codex CLI is installed, but the active Codex profile auth probe failed. Check the profile TOML [env] credentials and provider config.".into(),
            binary_path: Some(bin),
        };
    }

    CodexStatusResult {
        status: CodexStatus::Ready {
            version: version.clone(),
        },
        message: format!("Codex {} is ready with the active profile.", version),
        binary_path: Some(bin),
    }
}

async fn detect_binary_version(
    binary: Option<&str>,
) -> Result<(String, String), CodexStatusResult> {
    let path = match binary {
        Some(b) if !b.is_empty() && b != "auto" => Some(b.to_string()),
        _ => find_codex_binary(),
    };

    let Some(bin) = path else {
        return Err(binary_not_found(binary));
    };

    let mut version_cmd = Command::new(&bin);
    version_cmd.arg("--version");
    no_console_window(&mut version_cmd);
    let version_out = timeout(Duration::from_secs(5), version_cmd.output()).await;

    let version_str = match version_out {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return Err(binary_not_found(Some(&bin))),
    };

    let version = extract_version(&version_str);
    if !version_ok(&version, MIN_VERSION) {
        return Err(version_too_low(bin, version));
    }

    Ok((bin, version))
}

fn binary_not_found(binary: Option<&str>) -> CodexStatusResult {
    let binary_path = binary
        .filter(|b| !b.is_empty() && *b != "auto")
        .map(str::to_string);
    CodexStatusResult {
        status: CodexStatus::NotFound,
        message: match binary_path.as_deref() {
            Some(bin) => format!("Failed to run `{bin} --version`"),
            None => "Codex CLI not found. Install it to enable this feature.".into(),
        },
        binary_path,
    }
}

fn version_too_low(bin: String, version: String) -> CodexStatusResult {
    CodexStatusResult {
        status: CodexStatus::VersionTooLow {
            found: version.clone(),
            required: MIN_VERSION.into(),
        },
        message: format!(
            "Codex {} found, but v{} or later is required.",
            version, MIN_VERSION
        ),
        binary_path: Some(bin),
    }
}

async fn probe_auth(bin: &str, proxy_url: Option<&str>) -> bool {
    let mut cmd = Command::new(bin);
    cmd.args([
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "Reply exactly with TAOMNI_CODEX_OK and nothing else.",
    ]);
    apply_proxy_env(&mut cmd, proxy_url);
    no_console_window(&mut cmd);

    match timeout(Duration::from_secs(60), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains("TAOMNI_CODEX_OK")
        }
        _ => false,
    }
}

async fn probe_auth_with_app_server(
    bin: &str,
    proxy_url: Option<&str>,
    mut runtime: config::CodexProfileRuntime,
) -> bool {
    let temp_dir = std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
    if std::fs::create_dir_all(&temp_dir).is_err() {
        return false;
    }
    runtime.isolated_home = true;

    let process = match process::CodexAppServer::spawn(
        bin,
        proxy_url.map(str::to_string),
        Some(temp_dir.clone()),
        None,
        Some(runtime.env.clone()),
        runtime.isolated_home,
    )
    .await
    {
        Ok(process) => process,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return false;
        }
    };

    let start = process
        .start_or_resume_thread(process::CodexThreadOptions {
            resume_thread_id: None,
            model: if runtime.config.contains_key("model") {
                None
            } else {
                Some(config::DEFAULT_CODEX_MODEL.into())
            },
            cwd: std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string()),
            approval_policy: "never".into(),
            sandbox: "read-only".into(),
            network_access: false,
            config: runtime.config.clone(),
            base_instructions: Some("Reply exactly with TAOMNI_CODEX_OK and nothing else.".into()),
            developer_instructions: None,
            ephemeral: true,
        })
        .await;
    if start.is_err() {
        process.stop().await;
        return false;
    }

    let events = process
        .send_turn_with_callback(
            "Reply exactly with TAOMNI_CODEX_OK and nothing else.",
            process::CodexTurnOptions {
                cwd: std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string()),
                approval_policy: "never".into(),
                sandbox: "read-only".into(),
                network_access: false,
                model: None,
            },
            |_| {},
        )
        .await;
    let ok = events
        .ok()
        .map(|events| protocol::extract_answer(&events).contains("TAOMNI_CODEX_OK"))
        .unwrap_or(false);
    process.stop().await;
    ok
}
