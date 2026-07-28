//! Linux transparent-TCP redirect rules.
//!
//! A userspace TUN plus smoltcp does not, by itself, capture host OUTPUT
//! traffic. The production path therefore uses nftables' kernel NAT hook and
//! retrieves the pre-NAT destination with `SO_ORIGINAL_DST` in the relay.
//! Keeping rule rendering here makes all privileged input validated and easily
//! unit-testable before it is handed to `nft -f -`.

use std::net::IpAddr;
use std::path::Path;

use crate::sockscap::capture::linux::cgroup::CgroupV2Match;
use crate::sockscap::capture::linux::exec::run_command_elevated;
use crate::sockscap::config::ScopeMode;

const TABLE_NAME: &str = "taomni_sockscap";
/// Rendered into each terminal redirect rule so Recover can distinguish a
/// residual SocksCap table from an unrelated table that happens to use the
/// same name. The marker is intentionally stable across releases.
const OWNERSHIP_MARKER: &str = "taomni-sockscap-managed-v1";
const NFT_PATHS: &[&str] = &["/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft", "/bin/nft"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CidrFamily {
    Ipv4,
    Ipv6,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCidr {
    family: CidrFamily,
    value: String,
}

impl ValidatedCidr {
    pub fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        let (address, prefix) = value
            .split_once('/')
            .ok_or_else(|| format!("invalid bypass CIDR {value:?}: expected address/prefix"))?;
        let address: IpAddr = address
            .parse()
            .map_err(|_| format!("invalid bypass CIDR address {value:?}"))?;
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| format!("invalid bypass CIDR prefix {value:?}"))?;
        let (family, max_prefix) = match address {
            IpAddr::V4(_) => (CidrFamily::Ipv4, 32),
            IpAddr::V6(_) => (CidrFamily::Ipv6, 128),
        };
        if prefix > max_prefix {
            return Err(format!("invalid bypass CIDR prefix {value:?}"));
        }
        Ok(Self {
            family,
            value: format!("{address}/{prefix}"),
        })
    }

    fn render_return_rule(&self) -> String {
        match self.family {
            CidrFamily::Ipv4 => format!("    ip daddr {} return\n", self.value),
            CidrFamily::Ipv6 => format!("    ip6 daddr {} return\n", self.value),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RedirectPlan {
    pub mode: ScopeMode,
    pub relay_port: u16,
    pub redirect_ipv6: bool,
    pub bypass_cidrs: Vec<ValidatedCidr>,
    pub bypass_cgroup: Option<CgroupV2Match>,
    pub capture_cgroups: Vec<CgroupV2Match>,
    capture_relay_ports: Vec<u16>,
    /// Drop in-scope outbound UDP 443 (QUIC) so it falls back to TCP, which the
    /// redirect path attributes by SNI and proxies. Renders an extra filter-hook
    /// chain in the same table. See claudedocs/sockscap-quic-block-design.md §12.2.
    pub block_quic: bool,
}

impl RedirectPlan {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mode: ScopeMode,
        relay_port: u16,
        redirect_ipv6: bool,
        bypass_cidrs: &[String],
        bypass_cgroup: Option<CgroupV2Match>,
        capture_cgroups: &[CgroupV2Match],
        block_quic: bool,
    ) -> Result<Self, String> {
        if relay_port == 0 {
            return Err("Linux relay port must be non-zero".into());
        }
        let bypass_cidrs = bypass_cidrs
            .iter()
            .map(|cidr| ValidatedCidr::parse(cidr))
            .collect::<Result<Vec<_>, _>>()?;
        let plan = Self {
            mode,
            relay_port,
            redirect_ipv6,
            bypass_cidrs,
            bypass_cgroup,
            capture_cgroups: capture_cgroups.to_vec(),
            capture_relay_ports: vec![relay_port; capture_cgroups.len()],
            block_quic,
        };
        plan.validate()?;
        Ok(plan)
    }

    pub fn new_app_routes(
        redirect_ipv6: bool,
        bypass_cidrs: &[String],
        routes: &[(CgroupV2Match, u16)],
        block_quic: bool,
    ) -> Result<Self, String> {
        let relay_port = routes
            .first()
            .map(|(_, relay_port)| *relay_port)
            .ok_or_else(|| {
                "app-mode Linux capture requires at least one capture route".to_string()
            })?;
        let capture_cgroups = routes.iter().map(|(cgroup, _)| cgroup.clone()).collect();
        let capture_relay_ports = routes.iter().map(|(_, relay_port)| *relay_port).collect();
        let bypass_cidrs = bypass_cidrs
            .iter()
            .map(|cidr| ValidatedCidr::parse(cidr))
            .collect::<Result<Vec<_>, _>>()?;
        let plan = Self {
            mode: ScopeMode::Apps,
            relay_port,
            redirect_ipv6,
            bypass_cidrs,
            bypass_cgroup: None,
            capture_cgroups,
            capture_relay_ports,
            block_quic,
        };
        plan.validate()?;
        Ok(plan)
    }

    fn validate(&self) -> Result<(), String> {
        if self.capture_cgroups.len() != self.capture_relay_ports.len() {
            return Err("Linux app capture cgroup/relay route count mismatch".into());
        }
        if self.capture_relay_ports.contains(&0) {
            return Err("Linux relay port must be non-zero".into());
        }
        match self.mode {
            ScopeMode::Global if self.bypass_cgroup.is_none() => Err(
                "global Linux capture requires a relay bypass cgroup; refusing to install a redirect loop"
                    .into(),
            ),
            ScopeMode::Apps if self.capture_cgroups.is_empty() => {
                Err("app-mode Linux capture requires at least one capture cgroup".into())
            }
            _ => Ok(()),
        }
    }

    pub fn render_nft_script(&self) -> String {
        let mut script = format!("table inet {TABLE_NAME} {{\n  chain output {{\n");
        script.push_str("    type nat hook output priority dstnat; policy accept;\n");
        // Never redirect loopback traffic; this protects the relay's local
        // accept path even if a distribution has unusual cgroup behavior.
        script.push_str("    ip daddr 127.0.0.0/8 return\n");
        script.push_str("    ip6 daddr ::1/128 return\n");
        for cidr in &self.bypass_cidrs {
            script.push_str(&cidr.render_return_rule());
        }

        match self.mode {
            ScopeMode::Global => {
                let cgroup = self
                    .bypass_cgroup
                    .as_ref()
                    .expect("validated global cgroup");
                script.push_str(&format!("    {} return\n", cgroup.nft_expression()));
                self.render_redirect_rule(&mut script, "", self.relay_port);
            }
            ScopeMode::Apps => {
                for (cgroup, relay_port) in
                    self.capture_cgroups.iter().zip(&self.capture_relay_ports)
                {
                    self.render_redirect_rule(
                        &mut script,
                        &format!("{} ", cgroup.nft_expression()),
                        *relay_port,
                    );
                }
            }
        }

        // Close the nat output chain.
        script.push_str("  }\n");

        // QUIC blocking lives in a separate filter-hook chain in the same table:
        // a nat-type chain cannot `drop`. Same table → atomic install/remove and
        // one ownership marker. nat (dstnat) runs before filter, so an in-scope
        // TCP packet is already redirected (dport = relay) and never matches the
        // udp/443 rule; an in-scope UDP 443 datagram passes nat untouched and is
        // dropped here, forcing QUIC→TCP fallback.
        if self.block_quic {
            self.render_quic_block_chain(&mut script);
        }

        script.push_str("}\n");
        script
    }

    /// Render the `quic_block` filter chain. Places the same loopback / bypass
    /// CIDR (and, in global mode, bypass-cgroup) returns as the redirect chain
    /// *before* the drop, so any egress already protected from the redirect loop
    /// (Taomni + its child xray cores) is equally protected here — QUIC blocking
    /// adds no new bypass surface. App mode drops only per capture cgroup, so
    /// out-of-scope apps' QUIC is untouched.
    fn render_quic_block_chain(&self, script: &mut String) {
        script.push_str("  chain quic_block {\n");
        script.push_str("    type filter hook output priority filter; policy accept;\n");
        script.push_str("    ip daddr 127.0.0.0/8 return\n");
        script.push_str("    ip6 daddr ::1/128 return\n");
        for cidr in &self.bypass_cidrs {
            script.push_str(&cidr.render_return_rule());
        }
        match self.mode {
            ScopeMode::Global => {
                if let Some(cgroup) = self.bypass_cgroup.as_ref() {
                    script.push_str(&format!("    {} return\n", cgroup.nft_expression()));
                }
                script.push_str("    udp dport 443 drop\n");
            }
            ScopeMode::Apps => {
                for cgroup in &self.capture_cgroups {
                    script.push_str(&format!(
                        "    {} udp dport 443 drop\n",
                        cgroup.nft_expression()
                    ));
                }
            }
        }
        script.push_str("  }\n");
    }

    fn render_redirect_rule(&self, script: &mut String, prefix: &str, relay_port: u16) {
        let protocol = if self.redirect_ipv6 {
            "meta l4proto tcp"
        } else {
            "ip protocol tcp"
        };
        script.push_str(&format!(
            "    {prefix}{protocol} redirect to :{} comment \"{OWNERSHIP_MARKER}\"\n",
            relay_port
        ));
    }
}

/// Installed nftables state for one Linux SocksCap run.
#[derive(Debug)]
pub struct NftRedirect {
    installed: bool,
}

impl NftRedirect {
    pub fn preflight(sudo_password: Option<&str>) -> Result<(), String> {
        let output = run_command_elevated(nft_binary()?, &["--version"], None, sudo_password)?;
        if !output.status.success() {
            return Err(format!("nft --version failed: {}", command_error(&output)));
        }
        let output = run_command_elevated(nft_binary()?, &["list", "tables"], None, sudo_password)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "nftables is present but unavailable: {}. Linux capture requires CAP_NET_ADMIN",
                command_error(&output)
            ))
        }
    }

    pub fn install(plan: &RedirectPlan, sudo_password: Option<&str>) -> Result<Self, String> {
        plan.validate()?;
        Self::preflight(sudo_password)?;
        match table_state(sudo_password)? {
            TableState::Absent => {}
            TableState::Managed => {
                return Err(
                    "an existing managed taomni_sockscap nftables table was found; use Recover before starting another Linux capture session"
                        .into(),
                );
            }
            TableState::Unmanaged => {
                return Err(
                    "an nftables table named taomni_sockscap is not recognized as SocksCap-owned; refusing to replace it"
                        .into(),
                );
            }
        }
        run_nft_script(&plan.render_nft_script(), sudo_password)?;
        Ok(Self { installed: true })
    }

    pub fn remove(&mut self, sudo_password: Option<&str>) -> Result<(), String> {
        if !self.installed {
            return Ok(());
        }
        delete_managed_table(sudo_password)?;
        self.installed = false;
        Ok(())
    }
}

/// Remove residual capture rules after an unclean shutdown.
pub fn recover_rules(sudo_password: Option<&str>) -> Result<(), String> {
    match table_state(sudo_password)? {
        TableState::Absent => Ok(()),
        TableState::Managed => delete_table(sudo_password),
        TableState::Unmanaged => Err(
            "an nftables table named taomni_sockscap is not recognized as SocksCap-owned; refusing to delete it"
                .into(),
        ),
    }
}

fn nft_binary() -> Result<&'static str, String> {
    NFT_PATHS
        .iter()
        .copied()
        .find(|path| Path::new(path).is_file())
        .ok_or_else(|| "nftables is required for Linux SocksCap; install the nft package".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TableState {
    Absent,
    Managed,
    Unmanaged,
}

fn table_state(sudo_password: Option<&str>) -> Result<TableState, String> {
    let output = run_command_elevated(
        nft_binary()?,
        &["list", "table", "inet", TABLE_NAME],
        None,
        sudo_password,
    )?;
    if output.status.success() {
        return Ok(if managed_table_output(&output.stdout) {
            TableState::Managed
        } else {
            TableState::Unmanaged
        });
    }
    let error = command_error(&output);
    if error.contains("No such file") || error.contains("does not exist") {
        Ok(TableState::Absent)
    } else {
        Err(format!(
            "query nftables table failed: {error}. Linux capture requires CAP_NET_ADMIN"
        ))
    }
}

fn managed_table_output(stdout: &[u8]) -> bool {
    String::from_utf8_lossy(stdout).contains(OWNERSHIP_MARKER)
}

fn delete_managed_table(sudo_password: Option<&str>) -> Result<(), String> {
    match table_state(sudo_password)? {
        TableState::Absent => Ok(()),
        TableState::Managed => delete_table(sudo_password),
        TableState::Unmanaged => Err(
            "an nftables table named taomni_sockscap is not recognized as SocksCap-owned; refusing to delete it"
                .into(),
        ),
    }
}

fn delete_table(sudo_password: Option<&str>) -> Result<(), String> {
    let output = run_command_elevated(
        nft_binary()?,
        &["delete", "table", "inet", TABLE_NAME],
        None,
        sudo_password,
    )?;
    if output.status.success() {
        return Ok(());
    }
    let error = command_error(&output);
    if error.contains("No such file") || error.contains("does not exist") {
        Ok(())
    } else {
        Err(format!("delete nftables table failed: {error}"))
    }
}

fn run_nft_script(script: &str, sudo_password: Option<&str>) -> Result<(), String> {
    let output = run_command_elevated(nft_binary()?, &["-f", "-"], Some(script), sudo_password)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "install nftables redirect failed: {}. Linux capture requires CAP_NET_ADMIN",
            command_error(&output)
        ))
    }
}

fn command_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("exit status {}", output.status)
    } else {
        stderr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_untrusted_cidr_input() {
        assert!(ValidatedCidr::parse("127.0.0.1; flush ruleset").is_err());
        assert!(ValidatedCidr::parse("10.0.0.0/33").is_err());
    }

    #[test]
    fn renders_global_bypass_before_redirect() {
        let bypass = CgroupV2Match::from_relative_path("taomni-sockscap-42/bypass").unwrap();
        let plan = RedirectPlan::new(
            ScopeMode::Global,
            18443,
            true,
            &["10.0.0.0/8".into(), "fd00::/8".into()],
            Some(bypass),
            &[],
            false,
        )
        .unwrap();
        let script = plan.render_nft_script();
        let bypass_rule = "socket cgroupv2 level 2 \"taomni-sockscap-42/bypass\" return";
        assert!(script.contains(bypass_rule));
        assert!(!script.contains("meta cgroup"));
        assert!(script.contains("meta l4proto tcp redirect to :18443"));
        assert!(script.contains(OWNERSHIP_MARKER));
        assert!(
            script.find(bypass_rule).unwrap() < script.find("meta l4proto tcp redirect").unwrap()
        );
        assert!(script.contains("ip daddr 10.0.0.0/8 return"));
        assert!(script.contains("ip6 daddr fd00::/8 return"));
    }

    #[test]
    fn app_mode_only_redirects_selected_cgroups() {
        let captures = [
            CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-11").unwrap(),
            CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-22").unwrap(),
        ];
        let plan =
            RedirectPlan::new(ScopeMode::Apps, 15000, true, &[], None, &captures, false).unwrap();
        let script = plan.render_nft_script();
        assert!(script.contains(
            "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-11\" meta l4proto tcp redirect to :15000"
        ));
        assert!(script.contains(
            "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-22\" meta l4proto tcp redirect to :15000"
        ));
        assert!(!script.contains("meta cgroup"));
        assert!(!script.contains("\n    meta l4proto tcp redirect to :15000\n"));
    }

    #[test]
    fn app_profiles_can_route_to_distinct_relays() {
        let routes = [
            (
                CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-profile-0").unwrap(),
                15000,
            ),
            (
                CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-profile-1").unwrap(),
                16000,
            ),
        ];
        let plan = RedirectPlan::new_app_routes(true, &[], &routes, false).unwrap();
        let script = plan.render_nft_script();
        assert!(script.contains(
            "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-profile-0\" meta l4proto tcp redirect to :15000"
        ));
        assert!(script.contains(
            "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-profile-1\" meta l4proto tcp redirect to :16000"
        ));
    }

    #[test]
    fn recognizes_only_marked_tables_as_managed() {
        assert!(managed_table_output(
            b"table inet taomni_sockscap {\n  comment \"taomni-sockscap-managed-v1\"\n}"
        ));
        assert!(!managed_table_output(b"table inet taomni_sockscap { }"));
    }

    #[test]
    fn avoids_ipv6_redirect_when_the_loopback_listener_is_unavailable() {
        let captures =
            [CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-11").unwrap()];
        let plan =
            RedirectPlan::new(ScopeMode::Apps, 15000, false, &[], None, &captures, false).unwrap();
        assert!(
            plan.render_nft_script()
                .contains(
                    "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-11\" ip protocol tcp redirect to :15000"
                )
        );
    }

    #[test]
    fn no_quic_block_chain_when_block_quic_is_off() {
        // Regression guard: block_quic=false must render exactly as before.
        let bypass = CgroupV2Match::from_relative_path("taomni-sockscap-42/bypass").unwrap();
        let plan =
            RedirectPlan::new(ScopeMode::Global, 18443, true, &[], Some(bypass), &[], false)
                .unwrap();
        let script = plan.render_nft_script();
        assert!(!script.contains("quic_block"));
        assert!(!script.contains("udp dport 443"));
    }

    #[test]
    fn global_quic_block_drops_after_bypass_returns() {
        let bypass = CgroupV2Match::from_relative_path("taomni-sockscap-42/bypass").unwrap();
        let plan = RedirectPlan::new(
            ScopeMode::Global,
            18443,
            true,
            &["10.0.0.0/8".into()],
            Some(bypass),
            &[],
            true,
        )
        .unwrap();
        let script = plan.render_nft_script();
        assert!(script.contains("chain quic_block"));
        assert!(script.contains("type filter hook output priority filter"));
        assert!(script.contains("udp dport 443 drop"));
        // The drop must come after the bypass-cgroup return, or the relay's own
        // (and xray's) UDP egress would be dropped.
        let bypass_return =
            "socket cgroupv2 level 2 \"taomni-sockscap-42/bypass\" return";
        let block_body = &script[script.find("chain quic_block").unwrap()..];
        assert!(block_body.contains(bypass_return));
        assert!(block_body.find(bypass_return).unwrap() < block_body.find("udp dport 443 drop").unwrap());
        // Loopback + bypass CIDR returns are present in the block chain too.
        assert!(block_body.contains("ip daddr 127.0.0.0/8 return"));
        assert!(block_body.contains("ip daddr 10.0.0.0/8 return"));
    }

    #[test]
    fn app_quic_block_drops_only_per_capture_cgroup() {
        // Out-of-scope apps must keep QUIC: no bare `udp dport 443 drop`, only
        // per-capture-cgroup drops.
        let captures = [
            CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-profile-0").unwrap(),
            CgroupV2Match::from_relative_path("taomni-sockscap-42/capture-profile-1").unwrap(),
        ];
        let plan =
            RedirectPlan::new(ScopeMode::Apps, 15000, true, &[], None, &captures, true).unwrap();
        let script = plan.render_nft_script();
        assert!(script.contains(
            "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-profile-0\" udp dport 443 drop"
        ));
        assert!(script.contains(
            "socket cgroupv2 level 2 \"taomni-sockscap-42/capture-profile-1\" udp dport 443 drop"
        ));
        // No unconditional drop that would hit out-of-scope apps.
        assert!(!script.contains("\n    udp dport 443 drop\n"));
    }
}
