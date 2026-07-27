//! macOS system SOCKS proxy configuration via `networksetup`.
//!
//! Phase 1 has no transparent capture, so the OS proxy setting is what steers
//! applications into SocksCap's loopback ingress. Only the **SOCKS** proxy is
//! set: an HTTP proxy would also have to serve absolute-form requests
//! (`GET http://host/path`), which needs request rewriting rather than byte
//! bridging. Pointing SOCKS at the ingress covers plain HTTP too.
//!
//! Every mutation is paired with the previous value so [`SystemProxyScope`] can
//! put the machine back exactly as it found it.

use std::process::Output;

use crate::sockscap::elevate::{is_effective_root, run_command_elevated};

/// Absolute path: an elevated call must never resolve through a mutable `PATH`.
const NETWORKSETUP: &str = "/usr/sbin/networksetup";

/// The previous SOCKS proxy configuration of one network service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySnapshot {
    pub service: String,
    pub enabled: bool,
    pub server: String,
    pub port: u16,
}

/// Owns the system-proxy mutations for a capture session.
#[derive(Debug, Default)]
pub struct SystemProxyScope {
    saved: Vec<ProxySnapshot>,
}

/// Fail before touching anything if we cannot possibly succeed.
pub fn preflight(sudo_password: Option<&str>) -> Result<(), String> {
    if !std::path::Path::new(NETWORKSETUP).is_file() {
        return Err(format!(
            "{NETWORKSETUP} is missing; cannot set the system proxy"
        ));
    }
    if !is_effective_root() && sudo_password.is_none() {
        return Err(
            "macOS capture requires administrator rights to change the system proxy".into(),
        );
    }
    Ok(())
}

impl SystemProxyScope {
    /// Point every enabled network service's SOCKS proxy at `127.0.0.1:port`.
    ///
    /// A partial failure is rolled back: leaving some services aimed at a port
    /// we are about to abandon would black-hole the user's network.
    pub fn apply(port: u16, sudo_password: Option<&str>) -> Result<Self, String> {
        preflight(sudo_password)?;
        let services = list_network_services(sudo_password)?;
        if services.is_empty() {
            return Err("no enabled macOS network services to configure".into());
        }

        let mut scope = Self::default();
        for service in services {
            let snapshot = read_socks_proxy(&service, sudo_password)?;
            match set_socks_proxy(&service, port, sudo_password) {
                Ok(()) => scope.saved.push(snapshot),
                Err(error) => {
                    if let Err(rollback) = scope.restore(sudo_password) {
                        return Err(format!(
                            "set system proxy for {service} failed: {error}; \
                             rolling back earlier services also failed: {rollback}"
                        ));
                    }
                    return Err(format!("set system proxy for {service} failed: {error}"));
                }
            }
        }
        Ok(scope)
    }

    /// Restore every service this scope changed. Successfully restored services
    /// are dropped as we go, so a retry only reattempts what is still dirty.
    pub fn restore(&mut self, sudo_password: Option<&str>) -> Result<(), String> {
        let mut errors = Vec::new();
        let mut still_dirty = Vec::new();
        for snapshot in self.saved.drain(..) {
            match restore_socks_proxy(&snapshot, sudo_password) {
                Ok(()) => {}
                Err(error) => {
                    errors.push(format!("{}: {error}", snapshot.service));
                    still_dirty.push(snapshot);
                }
            }
        }
        self.saved = still_dirty;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "restore system proxy failed for {}",
                errors.join("; ")
            ))
        }
    }

    /// Services still pointing at our ingress.
    pub fn is_dirty(&self) -> bool {
        !self.saved.is_empty()
    }
}

/// Turn off any SOCKS proxy still aimed at loopback.
///
/// After an unclean shutdown there is no snapshot to restore from, and leaving
/// the machine pointed at a dead port would break its networking. Only loopback
/// servers are cleared, so a proxy the user configured themselves survives.
pub fn clear_loopback_proxies(sudo_password: Option<&str>) -> Result<(), String> {
    if !std::path::Path::new(NETWORKSETUP).is_file() {
        return Ok(());
    }
    let services = list_network_services(sudo_password)?;
    let mut errors = Vec::new();
    for service in services {
        let snapshot = match read_socks_proxy(&service, sudo_password) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                errors.push(format!("{service}: {error}"));
                continue;
            }
        };
        if !snapshot.enabled || !is_loopback_server(&snapshot.server) {
            continue;
        }
        if let Err(error) = networksetup(
            &["-setsocksfirewallproxystate", &service, "off"],
            sudo_password,
        ) {
            errors.push(format!("{service}: {error}"));
        } else {
            tracing::info!(service = %service, "sockscap cleared a stale loopback system proxy");
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "clear stale system proxy failed for {}",
            errors.join("; ")
        ))
    }
}

fn is_loopback_server(server: &str) -> bool {
    let server = server.trim();
    match server.parse::<std::net::IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => server.eq_ignore_ascii_case("localhost"),
    }
}

fn list_network_services(sudo_password: Option<&str>) -> Result<Vec<String>, String> {
    let stdout = networksetup(&["-listallnetworkservices"], sudo_password)?;
    Ok(parse_network_services(&stdout))
}

fn read_socks_proxy(service: &str, sudo_password: Option<&str>) -> Result<ProxySnapshot, String> {
    let stdout = networksetup(&["-getsocksfirewallproxy", service], sudo_password)?;
    Ok(parse_socks_proxy(service, &stdout))
}

fn set_socks_proxy(service: &str, port: u16, sudo_password: Option<&str>) -> Result<(), String> {
    let port = port.to_string();
    networksetup(
        &["-setsocksfirewallproxy", service, "127.0.0.1", &port],
        sudo_password,
    )?;
    networksetup(
        &["-setsocksfirewallproxystate", service, "on"],
        sudo_password,
    )?;
    Ok(())
}

fn restore_socks_proxy(
    snapshot: &ProxySnapshot,
    sudo_password: Option<&str>,
) -> Result<(), String> {
    // Nothing usable was configured before us, so clearing the state is enough;
    // networksetup rejects an empty server argument.
    if snapshot.server.is_empty() || snapshot.port == 0 {
        networksetup(
            &["-setsocksfirewallproxystate", &snapshot.service, "off"],
            sudo_password,
        )?;
        return Ok(());
    }
    let port = snapshot.port.to_string();
    networksetup(
        &[
            "-setsocksfirewallproxy",
            &snapshot.service,
            &snapshot.server,
            &port,
        ],
        sudo_password,
    )?;
    networksetup(
        &[
            "-setsocksfirewallproxystate",
            &snapshot.service,
            if snapshot.enabled { "on" } else { "off" },
        ],
        sudo_password,
    )?;
    Ok(())
}

fn networksetup(args: &[&str], sudo_password: Option<&str>) -> Result<String, String> {
    let output = run_command_elevated(NETWORKSETUP, args, None, sudo_password)?;
    check_networksetup_output(args.first().copied().unwrap_or("networksetup"), &output)
}

/// `networksetup` reports some failures on stdout with a zero exit status, so
/// the payload is inspected as well as the status.
fn check_networksetup_output(operation: &str, output: &Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("networksetup {operation} failed: {detail}"));
    }
    if let Some(problem) = networksetup_stdout_error(&stdout) {
        return Err(format!("networksetup {operation} failed: {problem}"));
    }
    Ok(stdout)
}

fn networksetup_stdout_error(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| {
            let lowered = line.to_ascii_lowercase();
            lowered.contains("you cannot")
                || lowered.contains("permission denied")
                || lowered.starts_with("** error")
        })
        .map(str::to_string)
}

/// Parse `-listallnetworkservices`, keeping only enabled services.
pub fn parse_network_services(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // Leading explanatory sentence about the asterisk convention.
        .filter(|line| !line.starts_with("An asterisk"))
        // A leading asterisk marks a disabled service; configuring it is moot.
        .filter(|line| !line.starts_with('*'))
        .map(str::to_string)
        .collect()
}

/// Parse `-getsocksfirewallproxy` key/value output.
pub fn parse_socks_proxy(service: &str, stdout: &str) -> ProxySnapshot {
    let mut snapshot = ProxySnapshot {
        service: service.to_string(),
        enabled: false,
        server: String::new(),
        port: 0,
    };
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Enabled" => snapshot.enabled = value.eq_ignore_ascii_case("yes"),
            "Server" => snapshot.server = value.to_string(),
            "Port" => snapshot.port = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn disabled_services_and_the_header_are_skipped() {
        let listing = "An asterisk (*) denotes that a network service is disabled.\n\
                       Wi-Fi\n\
                       *Thunderbolt Bridge\n\
                       USB 10/100/1000 LAN\n";

        assert_eq!(
            parse_network_services(listing),
            vec!["Wi-Fi".to_string(), "USB 10/100/1000 LAN".to_string()]
        );
    }

    #[test]
    fn an_unconfigured_proxy_is_read_as_disabled() {
        let snapshot = parse_socks_proxy(
            "Wi-Fi",
            "Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n",
        );

        assert_eq!(
            snapshot,
            ProxySnapshot {
                service: "Wi-Fi".into(),
                enabled: false,
                server: String::new(),
                port: 0,
            }
        );
    }

    #[test]
    fn an_existing_proxy_is_captured_for_restore() {
        let snapshot = parse_socks_proxy(
            "Wi-Fi",
            "Enabled: Yes\nServer: 10.0.0.9\nPort: 1080\nAuthenticated Proxy Enabled: 0\n",
        );

        assert!(snapshot.enabled);
        assert_eq!(snapshot.server, "10.0.0.9");
        assert_eq!(snapshot.port, 1080);
    }

    #[test]
    fn a_nonzero_exit_status_is_an_error() {
        let error = check_networksetup_output(
            "-setsocksfirewallproxy",
            &output(1, "", "You cannot do that without administrator access."),
        )
        .unwrap_err();

        assert!(error.contains("administrator access"));
    }

    #[test]
    fn a_permission_failure_reported_on_stdout_is_still_an_error() {
        // networksetup exits 0 for some refusals, so stdout has to be inspected.
        let error = check_networksetup_output(
            "-setsocksfirewallproxy",
            &output(0, "You cannot do that without administrator access.\n", ""),
        )
        .unwrap_err();

        assert!(error.contains("administrator access"));
    }

    #[test]
    fn ordinary_output_passes_through() {
        let stdout =
            check_networksetup_output("-getsocksfirewallproxy", &output(0, "Enabled: No\n", ""))
                .unwrap();

        assert_eq!(stdout, "Enabled: No\n");
    }

    #[test]
    fn only_loopback_servers_are_treated_as_ours_to_clear() {
        assert!(is_loopback_server("127.0.0.1"));
        assert!(is_loopback_server("::1"));
        assert!(is_loopback_server(" localhost "));
        // A proxy the user configured themselves must survive recovery.
        assert!(!is_loopback_server("10.0.0.9"));
        assert!(!is_loopback_server("proxy.corp.example"));
        assert!(!is_loopback_server(""));
    }

    #[test]
    fn preflight_without_root_or_a_password_explains_the_requirement() {
        if is_effective_root() {
            return;
        }
        let error = preflight(None).unwrap_err();
        assert!(error.contains("administrator rights"));
    }
}
