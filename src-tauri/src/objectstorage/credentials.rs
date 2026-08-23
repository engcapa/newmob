//! S3-family credential resolution beyond static keys (P6 cloud identity).
//!
//! Three sources, all dependency-free (no `aws-config`/`aws-sdk` — we keep the
//! lightweight rusty-s3 stack and resolve credentials ourselves):
//!
//! - `keys`        — static access key / secret / optional session token
//!                   (handled by the caller, which also resolves vault refs).
//! - `environment` — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
//!                   `AWS_SESSION_TOKEN`.
//! - `profile`     — the shared config files (`~/.aws/credentials`,
//!                   `~/.aws/config`). A profile may carry static keys, or a
//!                   `credential_process` command we run and parse. When a
//!                   profile has neither (e.g. an SSO or assume-role profile),
//!                   we fall back to running the AWS CLI's
//!                   `aws configure export-credentials --profile P --format process`,
//!                   which resolves SSO / assume-role / instance-role for us.
//!
//! `credential_process` is executed as argv (quote-aware split), never through
//! a shell, and only ever comes from the user's own `~/.aws` files.

use std::collections::BTreeMap;
use std::path::PathBuf;

use rusty_s3::Credentials;
use serde::Deserialize;

/// The JSON shape emitted by a `credential_process` command and by
/// `aws configure export-credentials --format process`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessCreds {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    session_token: Option<String>,
}

impl ProcessCreds {
    fn into_credentials(self) -> Credentials {
        match self.session_token.filter(|t| !t.is_empty()) {
            Some(t) => Credentials::new_with_token(self.access_key_id, self.secret_access_key, t),
            None => Credentials::new(self.access_key_id, self.secret_access_key),
        }
    }
}

/// Build credentials from `AWS_*` environment variables.
pub fn from_environment() -> Result<Credentials, String> {
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or("AWS_ACCESS_KEY_ID is not set in the environment")?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or("AWS_SECRET_ACCESS_KEY is not set in the environment")?;
    let token = std::env::var("AWS_SESSION_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    Ok(match token {
        Some(t) => Credentials::new_with_token(key, secret, t),
        None => Credentials::new(key, secret),
    })
}

/// Resolve credentials from a named profile in the shared AWS config files,
/// falling back to the AWS CLI for SSO / assume-role profiles.
pub async fn from_profile(profile: Option<&str>) -> Result<Credentials, String> {
    let profile = profile
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("AWS_PROFILE").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "default".to_string());

    let merged = load_profile(&profile);

    // 1) credential_process declared on the profile.
    if let Some(cmd) = merged.get("credential_process").filter(|c| !c.is_empty()) {
        return run_credential_process(cmd).await;
    }
    // 2) static keys on the profile.
    if let (Some(key), Some(secret)) = (
        merged.get("aws_access_key_id").filter(|s| !s.is_empty()),
        merged
            .get("aws_secret_access_key")
            .filter(|s| !s.is_empty()),
    ) {
        let token = merged
            .get("aws_session_token")
            .filter(|s| !s.is_empty())
            .cloned();
        return Ok(match token {
            Some(t) => Credentials::new_with_token(key.clone(), secret.clone(), t),
            None => Credentials::new(key.clone(), secret.clone()),
        });
    }
    // 3) SSO / assume-role / instance-role profile: let the AWS CLI resolve it.
    export_credentials(&profile).await
}

/// Region declared on the profile, if any — used to fill an unset config region.
pub fn profile_region(profile: Option<&str>) -> Option<String> {
    let profile = profile
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("AWS_PROFILE").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "default".to_string());
    load_profile(&profile)
        .get("region")
        .filter(|s| !s.is_empty())
        .cloned()
}

/// Merge a profile's settings from both `~/.aws/credentials` and `~/.aws/config`
/// (credentials wins on conflict). Section naming differs between the files:
/// `config` uses `[profile NAME]` (except `[default]`), `credentials` uses
/// `[NAME]`.
fn load_profile(profile: &str) -> BTreeMap<String, String> {
    let mut merged = BTreeMap::new();
    let dir = aws_dir();

    if let Ok(text) = std::fs::read_to_string(dir.join("config")) {
        let key = if profile == "default" {
            "default".to_string()
        } else {
            format!("profile {profile}")
        };
        if let Some(section) = parse_ini(&text).remove(&key) {
            merged.extend(section);
        }
    }
    if let Ok(text) = std::fs::read_to_string(dir.join("credentials")) {
        if let Some(section) = parse_ini(&text).remove(profile) {
            merged.extend(section);
        }
    }
    merged
}

fn aws_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("AWS_CONFIG_FILE") {
        // AWS_CONFIG_FILE points at the config file; its parent is the dir.
        if let Some(parent) = PathBuf::from(p).parent() {
            return parent.to_path_buf();
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aws")
}

/// Minimal INI parser: `[section]` headers and `key = value` lines. Comments
/// (`#`/`;`) and blank lines are ignored; keys are lowercased. Nested/indented
/// sub-settings (e.g. SSO blocks) collapse to flat keys, which is all we read.
fn parse_ini(text: &str) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = Some(name.trim().to_string());
            out.entry(name.trim().to_string()).or_default();
            continue;
        }
        if let (Some(section), Some((k, v))) = (current.as_ref(), line.split_once('=')) {
            out.entry(section.clone())
                .or_default()
                .insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    out
}

/// Run a `credential_process` command (argv, no shell) and parse its JSON.
async fn run_credential_process(command: &str) -> Result<Credentials, String> {
    let argv = split_args(command);
    let (program, args) = argv.split_first().ok_or("credential_process is empty")?;
    let output = tokio::process::Command::new(program)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to run credential_process '{program}': {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "credential_process exited with {}: {}",
            output.status,
            err.trim()
        ));
    }
    parse_process_json(&output.stdout)
}

/// Resolve an SSO / assume-role / instance-role profile by delegating to the
/// installed AWS CLI. Requires `aws` on PATH.
async fn export_credentials(profile: &str) -> Result<Credentials, String> {
    let output = tokio::process::Command::new("aws")
        .args([
            "configure",
            "export-credentials",
            "--profile",
            profile,
            "--format",
            "process",
        ])
        .output()
        .await
        .map_err(|e| {
            format!(
                "profile '{profile}' has no static keys or credential_process, and the AWS CLI \
                 (`aws`) is not available to resolve it: {e}"
            )
        })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "`aws configure export-credentials --profile {profile}` failed: {}",
            err.trim()
        ));
    }
    parse_process_json(&output.stdout)
}

fn parse_process_json(bytes: &[u8]) -> Result<Credentials, String> {
    let parsed: ProcessCreds = serde_json::from_slice(bytes)
        .map_err(|e| format!("could not parse credential JSON: {e}"))?;
    Ok(parsed.into_credentials())
}

/// Split a command line into argv, honoring single/double quotes. Good enough
/// for `credential_process` strings (no shell metacharacter expansion, which is
/// also what the AWS spec calls for).
fn split_args(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for c in command.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '"' | '\'' => {
                    quote = Some(c);
                    has = true;
                }
                c if c.is_whitespace() => {
                    if has {
                        args.push(std::mem::take(&mut cur));
                        has = false;
                    }
                }
                c => {
                    cur.push(c);
                    has = true;
                }
            },
        }
    }
    if has {
        args.push(cur);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_ini_sections() {
        let text = "\
# a comment
[default]
aws_access_key_id = AKIADEFAULT
aws_secret_access_key = secret0

[profile work]
region = eu-west-1
credential_process = /usr/local/bin/cred --profile work
";
        let ini = parse_ini(text);
        assert_eq!(
            ini["default"]["aws_access_key_id"], "AKIADEFAULT",
            "default section keys"
        );
        assert_eq!(ini["profile work"]["region"], "eu-west-1");
        assert_eq!(
            ini["profile work"]["credential_process"],
            "/usr/local/bin/cred --profile work"
        );
    }

    #[test]
    fn split_args_handles_quotes() {
        assert_eq!(split_args("aws foo bar"), vec!["aws", "foo", "bar"]);
        assert_eq!(
            split_args(r#"cred --opt "a b c" tail"#),
            vec!["cred", "--opt", "a b c", "tail"]
        );
        assert_eq!(split_args("'single quoted'"), vec!["single quoted"]);
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn parses_process_json_with_and_without_token() {
        let with =
            br#"{"Version":1,"AccessKeyId":"AKIA","SecretAccessKey":"shh","SessionToken":"tok"}"#;
        let creds = parse_process_json(with).unwrap();
        assert_eq!(creds.key(), "AKIA");
        assert_eq!(creds.token(), Some("tok"));

        let without = br#"{"Version":1,"AccessKeyId":"AKIA","SecretAccessKey":"shh"}"#;
        let creds = parse_process_json(without).unwrap();
        assert_eq!(creds.token(), None);
    }

    #[test]
    fn process_json_parse_error_is_descriptive() {
        let err = parse_process_json(b"not json").unwrap_err();
        assert!(err.contains("could not parse credential JSON"), "{err}");
    }
}
