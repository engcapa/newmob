use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientTerminalLaunch {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientTerminalOptions {
    serial_baud: Option<serde_json::Value>,
}

pub fn build_client_terminal_launch(
    kind: &str,
    host: &str,
    port: u16,
    username: Option<&str>,
    options_json: Option<&str>,
) -> Result<ClientTerminalLaunch, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err(match kind {
            "Serial" => "Serial device path is required.".to_string(),
            _ => "Remote host is required.".to_string(),
        });
    }

    let username = username.map(str::trim).filter(|value| !value.is_empty());
    match kind {
        "FTP" => Ok(build_ftp_launch(host, port)),
        "Telnet" => Ok(build_telnet_launch(host, port, username)),
        "Rlogin" => Ok(build_rlogin_launch(host, port, username)),
        "Mosh" => Ok(build_mosh_launch(host, port, username)),
        "Serial" => Ok(build_serial_launch(host, options_json)),
        other => Err(format!("Unsupported terminal client type {}", other)),
    }
}

fn build_ftp_launch(host: &str, port: u16) -> ClientTerminalLaunch {
    let mut args = vec![host.to_string()];
    if port > 0 {
        args.push(port.to_string());
    }

    ClientTerminalLaunch {
        program: "ftp".to_string(),
        args,
    }
}

fn build_telnet_launch(host: &str, port: u16, username: Option<&str>) -> ClientTerminalLaunch {
    let mut args = Vec::new();
    #[cfg(unix)]
    if let Some(username) = username {
        args.push("-l".to_string());
        args.push(username.to_string());
    }
    #[cfg(not(unix))]
    let _ = username;

    args.push(host.to_string());
    if port > 0 {
        args.push(port.to_string());
    }

    ClientTerminalLaunch {
        program: "telnet".to_string(),
        args,
    }
}

fn build_rlogin_launch(host: &str, port: u16, username: Option<&str>) -> ClientTerminalLaunch {
    let mut args = Vec::new();
    if let Some(username) = username {
        args.push("-l".to_string());
        args.push(username.to_string());
    }
    if port > 0 && port != 513 {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(host.to_string());

    ClientTerminalLaunch {
        program: "rlogin".to_string(),
        args,
    }
}

fn build_mosh_launch(host: &str, port: u16, username: Option<&str>) -> ClientTerminalLaunch {
    let mut args = Vec::new();
    if port > 0 {
        args.push(format!("--port={}", port));
    }
    let target = username
        .map(|user| format!("{}@{}", user, host))
        .unwrap_or_else(|| host.to_string());
    args.push(target);

    ClientTerminalLaunch {
        program: "mosh".to_string(),
        args,
    }
}

fn build_serial_launch(device: &str, options_json: Option<&str>) -> ClientTerminalLaunch {
    let baud = serial_baud(options_json).unwrap_or(115_200);

    #[cfg(windows)]
    {
        ClientTerminalLaunch {
            program: "plink.exe".to_string(),
            args: vec![
                "-serial".to_string(),
                device.to_string(),
                "-sercfg".to_string(),
                format!("{},8,n,1,N", baud),
            ],
        }
    }

    #[cfg(not(windows))]
    {
        ClientTerminalLaunch {
            program: "screen".to_string(),
            args: vec![device.to_string(), baud.to_string()],
        }
    }
}

fn serial_baud(options_json: Option<&str>) -> Option<u32> {
    let options =
        serde_json::from_str::<ClientTerminalOptions>(options_json.unwrap_or("{}")).ok()?;
    match options.serial_baud? {
        serde_json::Value::Number(value) => value.as_u64().and_then(|n| u32::try_from(n).ok()),
        serde_json::Value::String(value) => value.trim().parse::<u32>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telnet_launch_uses_host_port_and_unix_username() {
        let launch = build_client_terminal_launch(
            "Telnet",
            "legacy.example.test",
            2323,
            Some("alice"),
            None,
        )
        .expect("telnet launch should build");

        assert_eq!(launch.program, "telnet");
        #[cfg(unix)]
        assert_eq!(launch.args, ["-l", "alice", "legacy.example.test", "2323"]);
        #[cfg(not(unix))]
        assert_eq!(launch.args, ["legacy.example.test", "2323"]);
    }

    #[test]
    fn ftp_launch_uses_host_and_port() {
        let launch =
            build_client_terminal_launch("FTP", "ftp.example.test", 2121, Some("ops"), None)
                .expect("ftp launch should build");

        assert_eq!(launch.program, "ftp");
        assert_eq!(launch.args, ["ftp.example.test", "2121"]);
    }

    #[test]
    fn rlogin_launch_omits_default_port() {
        let launch =
            build_client_terminal_launch("Rlogin", "old.example.test", 513, Some("ops"), None)
                .expect("rlogin launch should build");

        assert_eq!(launch.program, "rlogin");
        assert_eq!(launch.args, ["-l", "ops", "old.example.test"]);
    }

    #[test]
    fn mosh_launch_uses_user_target_and_udp_port() {
        let launch =
            build_client_terminal_launch("Mosh", "edge.example.test", 60001, Some("deploy"), None)
                .expect("mosh launch should build");

        assert_eq!(launch.program, "mosh");
        assert_eq!(launch.args, ["--port=60001", "deploy@edge.example.test"]);
    }

    #[test]
    fn serial_launch_reads_baud_from_options_json() {
        let launch = build_client_terminal_launch(
            "Serial",
            "/dev/ttyUSB0",
            0,
            None,
            Some(r#"{"serialBaud":"57600"}"#),
        )
        .expect("serial launch should build");

        #[cfg(windows)]
        {
            assert_eq!(launch.program, "plink.exe");
            assert_eq!(
                launch.args,
                ["-serial", "/dev/ttyUSB0", "-sercfg", "57600,8,n,1,N"]
            );
        }

        #[cfg(not(windows))]
        {
            assert_eq!(launch.program, "screen");
            assert_eq!(launch.args, ["/dev/ttyUSB0", "57600"]);
        }
    }

    #[test]
    fn client_launch_requires_target() {
        let err = build_client_terminal_launch("Serial", " ", 0, None, None)
            .expect_err("empty serial device should fail");

        assert!(err.contains("Serial device path"));
    }
}
