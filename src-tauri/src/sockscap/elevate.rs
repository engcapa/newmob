//! Elevated command execution shared by the Unix capture backends.
//!
//! Linux needs it for `nft` and cgroup writes; macOS needs it for
//! `networksetup`. The delicate part is keeping sudo's password and the target
//! command's stdin on separate pipes, so this lives in one place rather than
//! being reimplemented per platform.

use std::io::Write;
use std::process::{Command, Output, Stdio};

pub fn is_effective_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

pub fn run_command_elevated(
    program: &str,
    args: &[&str],
    input_data: Option<&str>,
    sudo_password: Option<&str>,
) -> Result<Output, String> {
    run_command_elevated_with(
        program,
        args,
        input_data,
        sudo_password,
        "sudo",
        is_effective_root(),
    )
}

fn run_command_elevated_with(
    program: &str,
    args: &[&str],
    input_data: Option<&str>,
    sudo_password: Option<&str>,
    sudo_program: &str,
    effective_root: bool,
) -> Result<Output, String> {
    if effective_root || sudo_password.is_none() {
        return run_command(program, args, input_data);
    }

    let password = sudo_password.expect("checked above");
    authenticate_sudo(sudo_program, password)?;

    // Never put sudo's password and the target command's stdin in the same
    // pipe. sudo may buffer more than the password line and pass those bytes
    // to the child, which can both disclose the password (for example through
    // `tee`) and corrupt cgroup/nftables input.
    let mut command = Command::new(sudo_program);
    command.args(["-n", "--", program]).args(args);
    run_spawned_command(command, input_data, &format!("sudo {program}"))
}

fn authenticate_sudo(sudo_program: &str, password: &str) -> Result<(), String> {
    let mut command = Command::new(sudo_program);
    command
        .args(["-S", "-p", "", "-v"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("start sudo authentication: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "sudo authentication stdin unavailable".to_string())
        .and_then(|mut stdin| {
            stdin
                .write_all(password.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|error| format!("write sudo credentials: {error}"))
        });
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait for sudo authentication: {error}"))?;

    if output.status.success() {
        // With NOPASSWD or an already-valid sudo timestamp, sudo may exit
        // without reading stdin. A concurrent BrokenPipe is harmless because
        // the successful status already proves authorization is available.
        Ok(())
    } else {
        write_result?;
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = redact_secret(detail.trim(), password);
        if detail.is_empty() {
            Err(format!(
                "sudo authentication failed with exit status {}",
                output.status
            ))
        } else {
            Err(format!("sudo authentication failed: {detail}"))
        }
    }
}

fn redact_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[redacted]")
    }
}

fn run_command(program: &str, args: &[&str], input_data: Option<&str>) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    run_spawned_command(command, input_data, program)
}

fn run_spawned_command(
    mut command: Command,
    input_data: Option<&str>,
    description: &str,
) -> Result<Output, String> {
    if input_data.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("start {description}: {error}"))?;
    let write_result = input_data.map(|input| {
        child
            .stdin
            .take()
            .ok_or_else(|| format!("{description} stdin unavailable"))
            .and_then(|mut stdin| {
                stdin
                    .write_all(input.as_bytes())
                    .map_err(|error| format!("write {description} stdin: {error}"))
            })
    });
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait for {description}: {error}"))?;
    if let Some(write_result) = write_result {
        write_result?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn keeps_sudo_password_out_of_target_stdin_and_output() {
        let directory = tempfile::tempdir().unwrap();
        let sudo = directory.path().join("fake-sudo");
        let auth_log = directory.path().join("auth.log");
        let target_log = directory.path().join("target.log");
        fs::write(
            &sudo,
            format!(
                "#!/bin/sh\n\
                 case \"$1\" in\n\
                   -S)\n\
                     IFS= read -r password\n\
                     printf '%s' \"$password\" > '{}'\n\
                     exit 0\n\
                     ;;\n\
                   -n)\n\
                     shift\n\
                     [ \"$1\" = \"--\" ] && shift\n\
                     exec \"$@\"\n\
                     ;;\n\
                 esac\n\
                 exit 2\n",
                auth_log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&sudo, fs::Permissions::from_mode(0o700)).unwrap();

        let sudo_path = sudo.to_string_lossy();
        let target_path = target_log.to_string_lossy();
        let output = run_command_elevated_with(
            "/usr/bin/tee",
            &[target_path.as_ref()],
            Some("2015458\n"),
            Some("root-secret"),
            sudo_path.as_ref(),
            false,
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(fs::read_to_string(auth_log).unwrap(), "root-secret");
        assert_eq!(fs::read_to_string(target_log).unwrap(), "2015458\n");
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "2015458\n");
    }

    #[test]
    fn redacts_password_from_sudo_authentication_errors() {
        let directory = tempfile::tempdir().unwrap();
        let sudo = directory.path().join("fake-sudo");
        fs::write(
            &sudo,
            "#!/bin/sh\n\
             IFS= read -r password\n\
             printf 'authentication rejected for %s\\n' \"$password\" >&2\n\
             exit 1\n",
        )
        .unwrap();
        fs::set_permissions(&sudo, fs::Permissions::from_mode(0o700)).unwrap();

        let error = run_command_elevated_with(
            "/usr/bin/true",
            &[],
            None,
            Some("root-secret"),
            sudo.to_string_lossy().as_ref(),
            false,
        )
        .unwrap_err();

        assert!(error.contains("sudo authentication failed"));
        assert!(error.contains("[redacted]"));
        assert!(!error.contains("root-secret"));
    }
}
