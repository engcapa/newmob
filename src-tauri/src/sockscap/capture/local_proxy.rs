//! Privilege-free capture plane: a loopback SOCKS5 / HTTP-CONNECT ingress.
//!
//! Transparent capture needs kernel privileges that some environments cannot
//! grant at all. In a container, `CAP_NET_ADMIN` is frequently missing from the
//! *bounding* set, so even uid 0 inside the container cannot acquire it and no
//! elevation flow can succeed; a cgroup v1-only host likewise cannot provide the
//! cgroup v2 socket match the nftables rules depend on. This backend keeps
//! SocksCap useful there by having clients opt in explicitly — they point at a
//! loopback proxy port instead of being intercepted.
//!
//! Everything downstream is shared with the transparent backends: the ingress
//! hands each flow to [`crate::sockscap::relay::handle_captured_client`], which
//! owns policy, GFWList, SNI attribution, egress dialing, and accounting.
//!
//! # Scope semantics
//!
//! A proxy handshake carries no process identity (`process_path` / `pid` are
//! `None`), so app selectors that match an executable path cannot apply. Profile
//! selection is therefore expressed as **one port per profile**: a client
//! reaches a profile's upstream by connecting to that profile's port. The
//! configured port belongs to the global/catch-all profile when one is active,
//! since that is the address users put in `ALL_PROXY`.

use std::net::IpAddr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::sockscap::config::{ScopeMode, SocksCapConfig, SocksCapProfile};
use crate::sockscap::ingress;
use crate::sockscap::relay::{RelayContext, RelayHandle};

/// One listening port and the profile whose upstream it routes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPortInfo {
    pub profile_id: String,
    pub profile_name: String,
    pub port: u16,
    /// True for the port a client should use by default — the global/catch-all
    /// profile's port, or the first profile's port when no global profile is
    /// active.
    pub is_default: bool,
    /// True when this port also accepts IPv6 (`[::1]`).
    pub ipv6_ready: bool,
}

/// A running local-proxy session.
pub struct LocalProxyHandle {
    listeners: Vec<RelayHandle>,
    ports: Vec<ProxyPortInfo>,
}

// `RelayHandle` holds a JoinHandle and is not Debug; report the ports instead,
// which is the part worth seeing in a failure message.
impl std::fmt::Debug for LocalProxyHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalProxyHandle")
            .field("ports", &self.ports)
            .finish()
    }
}

impl LocalProxyHandle {
    pub fn ports(&self) -> &[ProxyPortInfo] {
        &self.ports
    }

    /// Port a client should use unless it deliberately targets one profile.
    pub fn default_port(&self) -> Option<u16> {
        self.ports
            .iter()
            .find(|port| port.is_default)
            .or_else(|| self.ports.first())
            .map(|port| port.port)
    }

    pub async fn stop(mut self) {
        for listener in self.listeners.drain(..) {
            listener.stop().await;
        }
        self.ports.clear();
    }
}

/// Plan which profile owns which port before any socket is bound.
///
/// Only the fixed port is assigned here; `0` entries are filled in by the OS at
/// bind time. Keeping the assignment pure makes the ordering rules testable
/// without binding real sockets.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PortAssignment {
    profile_id: String,
    profile_name: String,
    requested_port: u16,
    is_default: bool,
}

fn plan_port_assignments(config: &SocksCapConfig) -> Result<Vec<PortAssignment>, String> {
    let active = config.active_profiles();
    if active.is_empty() {
        return Err("At least one profile must be enabled and active".into());
    }

    // The configured port is the one users write into client configuration, so it
    // belongs to the catch-all profile when there is one. Everything else gets an
    // ephemeral port; only one listener can own a given port.
    let default_index = active
        .iter()
        .position(|profile| matches!(profile.mode, ScopeMode::Global))
        .unwrap_or(0);

    let assignments: Vec<PortAssignment> = active
        .iter()
        .enumerate()
        .map(|(index, profile)| PortAssignment {
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            // A per-profile pin wins, so a client configured for one profile keeps
            // working across restarts.
            requested_port: match profile.local_proxy_port {
                0 if index == default_index => config.local_proxy_port,
                0 => 0,
                pinned => pinned,
            },
            is_default: index == default_index,
        })
        .collect();

    // Two listeners cannot share a port, and the second bind would fail with a
    // confusing OS error. Reject the conflict with the profiles named.
    for (index, assignment) in assignments.iter().enumerate() {
        if assignment.requested_port == 0 {
            continue;
        }
        if let Some(other) = assignments
            .iter()
            .take(index)
            .find(|earlier| earlier.requested_port == assignment.requested_port)
        {
            return Err(format!(
                "profiles '{}' and '{}' both request local proxy port {}; give one of them a different port",
                other.profile_name, assignment.profile_name, assignment.requested_port
            ));
        }
    }

    Ok(assignments)
}

/// A host string the relay would dial back to this machine.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

/// The active profile that dials `port` on loopback as its upstream, if any.
///
/// Listening on such a port creates a loop rather than a failed connection: the
/// relay's own outbound connection lands back on its listener, which proxies it
/// again, and so on until the process runs out of descriptors. Stock settings
/// reach this — the default upstream is `socks5 127.0.0.1:1080`, a port a user
/// picking a "normal" SOCKS port would plausibly choose for the ingress too.
///
/// Two kinds are exempt because the configured endpoint is not what gets dialed:
/// core-backed upstreams (Shadowsocks/Trojan/VMess/VLESS/WireGuard) go to the
/// xray sidecar's own inbound port, and session-backed upstreams resolve their
/// endpoint from the saved session at dial time, which is not known here.
fn loopback_upstream_owner(config: &SocksCapConfig, port: u16) -> Option<&SocksCapProfile> {
    config.active_profiles().into_iter().find(|profile| {
        let upstream = &profile.upstream;
        !upstream.kind.requires_core()
            && upstream.session_id.trim().is_empty()
            && upstream.port == port
            && is_loopback_host(&upstream.host)
    })
}

fn self_loop_error(listener_profile: &str, port: u16, upstream_profile: &str) -> String {
    format!(
        "local proxy port {port} for profile '{listener_profile}' is also profile \
         '{upstream_profile}'s upstream endpoint on loopback, so every proxied flow would be \
         fed back into this listener. Change the local proxy port or the upstream endpoint"
    )
}

/// Bind one profile's listener, rejecting a port that loops back on an upstream.
async fn start_one(
    config: &SocksCapConfig,
    ctx: &Arc<RwLock<RelayContext>>,
    assignment: &PortAssignment,
) -> Result<(RelayHandle, ProxyPortInfo), String> {
    let started = ingress::start_ingress(
        Arc::clone(ctx),
        Some(assignment.profile_id.clone()),
        assignment.requested_port,
    )
    .await?;

    // Checked on the *bound* port so an ephemeral assignment that lands on an
    // upstream endpoint by chance is caught as well as a configured one.
    if let Some(owner) = loopback_upstream_owner(config, started.handle.port) {
        let error = self_loop_error(&assignment.profile_name, started.handle.port, &owner.name);
        started.handle.stop().await;
        return Err(error);
    }

    let info = ProxyPortInfo {
        profile_id: assignment.profile_id.clone(),
        profile_name: assignment.profile_name.clone(),
        port: started.handle.port,
        is_default: assignment.is_default,
        ipv6_ready: started.ipv6_ready,
    };
    Ok((started.handle, info))
}

/// Start one loopback listener per active profile.
pub async fn start(
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<LocalProxyHandle, String> {
    let assignments = plan_port_assignments(config)?;

    let mut listeners = Vec::new();
    let mut ports = Vec::new();
    for assignment in &assignments {
        match start_one(config, &ctx, assignment).await {
            Ok((handle, info)) => {
                listeners.push(handle);
                ports.push(info);
            }
            Err(error) => {
                // Roll back so a partial start cannot leave orphaned listeners
                // holding ports the next attempt needs.
                for listener in listeners {
                    listener.stop().await;
                }
                return Err(error);
            }
        }
    }

    tracing::info!(
        ports = ?ports.iter().map(|port| port.port).collect::<Vec<_>>(),
        "sockscap local proxy ingress started"
    );
    Ok(LocalProxyHandle { listeners, ports })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::config::{
        AppSelector, DEFAULT_LOCAL_PROXY_PORT, Decision, RuleMode, ScopeMode as _ScopeMode,
        UpstreamKind,
    };
    use crate::sockscap::helper::HelperRegistry;
    use crate::sockscap::relay::RelayContext;
    use crate::sockscap::stats::{DomainTracker, StatsCounters};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Context that sends every flow straight out with no upstream, which is what
    /// lets this exercise the real ingress → policy → egress chain with no
    /// privileges and no external proxy.
    fn direct_context(config: SocksCapConfig) -> Arc<RwLock<RelayContext>> {
        let engine = RelayContext::build_engine(&config, None);
        Arc::new(RwLock::new(RelayContext {
            config,
            rules: None,
            engine,
            helper: Arc::new(HelperRegistry::default()),
            helper_client: None,
            stats: Arc::new(StatsCounters::default()),
            upstream_host: String::new(),
            upstream_port: 0,
            upstream_user: String::new(),
            upstream_pass: String::new(),
            self_pid: std::process::id(),
            ssh_pool: None,
            xray_port: None,
            profile_upstreams: HashMap::new(),
            dns_map: Arc::new(Mutex::new(Default::default())),
            domains: Arc::new(Mutex::new(DomainTracker::new(16))),
        }))
    }

    fn direct_config() -> SocksCapConfig {
        let mut config = SocksCapConfig::default();
        config.rule_mode = RuleMode::Off;
        config.default_action = Decision::Direct;
        config.local_proxy_port = 0;
        config.profiles[0].rule_mode = RuleMode::Off;
        config.profiles[0].default_action = Decision::Direct;
        config
    }

    /// Echo server standing in for a real destination.
    async fn spawn_echo() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 1024];
                    while let Ok(read) = socket.read(&mut buffer).await {
                        if read == 0 || socket.write_all(&buffer[..read]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn a_socks5_client_reaches_its_target_through_the_local_proxy() {
        let echo_port = spawn_echo().await;
        let ctx = direct_context(direct_config());
        let proxy = start(&direct_config(), ctx).await.unwrap();
        let proxy_port = proxy.default_port().unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        // Greeting: SOCKS5, one method, no authentication.
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut greeting = [0u8; 2];
        client.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [0x05, 0x00]);

        // CONNECT to 127.0.0.1:echo_port as an IPv4 literal.
        let mut request = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1];
        request.extend_from_slice(&echo_port.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[0], 0x05);
        assert_eq!(reply[1], 0x00, "SOCKS5 CONNECT should succeed");

        client.write_all(b"taomni").await.unwrap();
        let mut echoed = [0u8; 6];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"taomni");

        proxy.stop().await;
    }

    #[tokio::test]
    async fn an_http_connect_client_reaches_its_target_through_the_same_port() {
        let echo_port = spawn_echo().await;
        let ctx = direct_context(direct_config());
        let proxy = start(&direct_config(), ctx).await.unwrap();
        let proxy_port = proxy.default_port().unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        client
            .write_all(
                format!("CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();

        // Read just the status line; the ingress replies 200 before tunnelling.
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            let read = client.read(&mut byte).await.unwrap();
            assert_ne!(read, 0, "proxy closed before completing the CONNECT reply");
            response.extend_from_slice(&byte[..read]);
        }
        let response = String::from_utf8_lossy(&response);
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "unexpected CONNECT reply: {response}"
        );

        client.write_all(b"taomni").await.unwrap();
        let mut echoed = [0u8; 6];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"taomni");

        proxy.stop().await;
    }

    #[tokio::test]
    async fn stop_releases_the_port_so_a_restart_can_rebind_it() {
        // A fixed port is only stable if Stop actually frees it; a leaked
        // listener would make the next Start fail to bind.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut config = direct_config();
        config.local_proxy_port = port;

        let first = start(&config, direct_context(config.clone()))
            .await
            .unwrap();
        assert_eq!(first.default_port(), Some(port));
        first.stop().await;

        let second = start(&config, direct_context(config.clone()))
            .await
            .unwrap();
        assert_eq!(second.default_port(), Some(port));
        second.stop().await;
    }

    #[tokio::test]
    async fn a_taken_fixed_port_is_reported_rather_than_silently_replaced() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = occupied.local_addr().unwrap().port();

        let mut config = direct_config();
        config.local_proxy_port = port;

        let error = start(&config, direct_context(config.clone()))
            .await
            .unwrap_err();

        assert!(
            error.contains(&port.to_string()),
            "error should name the port"
        );
    }

    #[tokio::test]
    async fn each_active_profile_gets_its_own_distinct_port() {
        let mut config = direct_config();
        config.profiles[0].id = "apps".into();
        config.profiles[0].mode = _ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/example/example")];
        let mut second = config.profiles[0].clone();
        second.id = "second".into();
        second.priority = 1;
        config.profiles.push(second);
        config.active_profile_ids = vec!["apps".into(), "second".into()];

        let proxy = start(&config, direct_context(config.clone()))
            .await
            .unwrap();

        let ports = proxy.ports();
        assert_eq!(ports.len(), 2);
        assert_ne!(
            ports[0].port, ports[1].port,
            "profiles must not share a port"
        );
        assert!(ports.iter().all(|port| port.port != 0));
        proxy.stop().await;
    }

    fn app_selector(path: &str) -> AppSelector {
        AppSelector {
            path: path.into(),
            bundle_id: String::new(),
            name: "Example".into(),
            macos_identity: None,
        }
    }

    #[test]
    fn a_single_global_profile_owns_the_configured_port() {
        let config = SocksCapConfig::default();

        let assignments = plan_port_assignments(&config).unwrap();

        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0].requested_port, DEFAULT_LOCAL_PROXY_PORT);
        assert!(assignments[0].is_default);
    }

    #[test]
    fn the_global_profile_keeps_the_configured_port_even_at_lower_priority() {
        // Users put the configured port in ALL_PROXY, so the catch-all profile
        // must own it regardless of where it sorts among app profiles.
        let mut config = SocksCapConfig::default();
        config.local_proxy_port = 8080;
        config.profiles[0].id = "apps".into();
        config.profiles[0].name = "Apps".into();
        config.profiles[0].priority = 1;
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/example/example")];

        let mut global = config.profiles[0].clone();
        global.id = "global".into();
        global.name = "Global".into();
        global.priority = 2;
        global.mode = ScopeMode::Global;
        global.apps.clear();
        config.profiles.push(global);
        config.active_profile_ids = vec!["apps".into(), "global".into()];

        let assignments = plan_port_assignments(&config).unwrap();

        assert_eq!(assignments.len(), 2);
        let global = assignments
            .iter()
            .find(|assignment| assignment.profile_id == "global")
            .unwrap();
        assert_eq!(global.requested_port, 8080);
        assert!(global.is_default);
        let apps = assignments
            .iter()
            .find(|assignment| assignment.profile_id == "apps")
            .unwrap();
        assert_eq!(apps.requested_port, 0, "only one listener can own a port");
        assert!(!apps.is_default);
    }

    #[test]
    fn app_only_configs_give_the_configured_port_to_the_first_profile() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/example/example")];

        let assignments = plan_port_assignments(&config).unwrap();

        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0].requested_port, DEFAULT_LOCAL_PROXY_PORT);
        assert!(assignments[0].is_default);
    }

    #[test]
    fn exactly_one_assignment_is_the_default() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/a/a")];
        for index in 0..2 {
            let mut extra = config.profiles[0].clone();
            extra.id = format!("extra-{index}");
            extra.priority = index + 1;
            config.profiles.push(extra);
            config.active_profile_ids.push(format!("extra-{index}"));
        }

        let assignments = plan_port_assignments(&config).unwrap();

        assert_eq!(assignments.len(), 3);
        assert_eq!(
            assignments
                .iter()
                .filter(|assignment| assignment.is_default)
                .count(),
            1
        );
    }

    #[test]
    fn no_active_profile_is_rejected() {
        let mut config = SocksCapConfig::default();
        config.active_profile_ids.clear();

        assert!(plan_port_assignments(&config).is_err());
    }

    #[test]
    fn a_pinned_profile_port_overrides_the_assigned_one() {
        // Lets a client configured for one profile survive a restart.
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = _ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/a/a")];
        config.profiles[0].local_proxy_port = 9050;

        let assignments = plan_port_assignments(&config).unwrap();

        assert_eq!(assignments[0].requested_port, 9050);
    }

    #[test]
    fn a_pin_wins_over_the_global_configured_port() {
        let mut config = SocksCapConfig::default();
        config.local_proxy_port = 7890;
        config.profiles[0].local_proxy_port = 9050;

        let assignments = plan_port_assignments(&config).unwrap();

        assert!(assignments[0].is_default);
        assert_eq!(assignments[0].requested_port, 9050);
    }

    #[test]
    fn two_profiles_pinned_to_the_same_port_are_rejected_by_name() {
        // The second bind would otherwise fail with an opaque OS error.
        let mut config = SocksCapConfig::default();
        config.profiles[0].id = "a".into();
        config.profiles[0].name = "Alpha".into();
        config.profiles[0].mode = _ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/a/a")];
        config.profiles[0].local_proxy_port = 9050;
        let mut second = config.profiles[0].clone();
        second.id = "b".into();
        second.name = "Beta".into();
        second.priority = 1;
        config.profiles.push(second);
        config.active_profile_ids = vec!["a".into(), "b".into()];

        let error = plan_port_assignments(&config).unwrap_err();

        assert!(error.contains("Alpha"));
        assert!(error.contains("Beta"));
        assert!(error.contains("9050"));
    }

    #[test]
    fn loopback_hosts_are_recognized_in_every_form_a_user_may_type() {
        for host in [
            "127.0.0.1",
            "127.1.2.3",
            "localhost",
            "LocalHost",
            "::1",
            "[::1]",
        ] {
            assert!(is_loopback_host(host), "{host} should count as loopback");
        }
        for host in ["", "0.0.0.0", "192.168.1.10", "example.com", "proxy.local"] {
            assert!(
                !is_loopback_host(host),
                "{host} should not count as loopback"
            );
        }
    }

    /// Free port to hand out without holding it, so a later bind can take it.
    async fn free_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    fn with_upstream(config: &mut SocksCapConfig, kind: UpstreamKind, host: &str, port: u16) {
        config.profiles[0].upstream.kind = kind;
        config.profiles[0].upstream.host = host.into();
        config.profiles[0].upstream.port = port;
    }

    #[tokio::test]
    async fn a_port_that_is_also_a_loopback_upstream_is_rejected() {
        // Reachable from stock settings: the default upstream is
        // socks5 127.0.0.1:1080, and 1080 is a port a user may well pick for the
        // ingress. Listening there would proxy the relay's own upstream
        // connection back into itself, without bound.
        let port = free_port().await;
        let mut config = direct_config();
        config.local_proxy_port = port;
        with_upstream(&mut config, UpstreamKind::Socks5, "127.0.0.1", port);

        let error = start(&config, direct_context(config.clone()))
            .await
            .unwrap_err();

        assert!(
            error.contains(&port.to_string()),
            "error should name the port"
        );
        assert!(error.contains("fed back into this listener"));
    }

    #[tokio::test]
    async fn a_rejected_self_loop_leaves_no_listener_behind() {
        // The conflicting profile is the second one, so the first has already
        // bound. Its port must be free again once the error is returned.
        let first_port = free_port().await;
        let looping_port = free_port().await;
        let mut config = direct_config();
        config.local_proxy_port = 0;
        config.profiles[0].id = "first".into();
        config.profiles[0].name = "First".into();
        config.profiles[0].mode = _ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/a/a")];
        config.profiles[0].local_proxy_port = first_port;
        let mut second = config.profiles[0].clone();
        second.id = "second".into();
        second.name = "Second".into();
        second.priority = 1;
        second.local_proxy_port = looping_port;
        second.upstream.kind = UpstreamKind::Socks5;
        second.upstream.host = "127.0.0.1".into();
        second.upstream.port = looping_port;
        config.profiles.push(second);
        config.active_profile_ids = vec!["first".into(), "second".into()];

        let error = start(&config, direct_context(config.clone()))
            .await
            .unwrap_err();
        assert!(error.contains("Second"));

        // Nothing is holding the first listener's port anymore.
        assert!(
            TcpListener::bind(("127.0.0.1", first_port)).await.is_ok(),
            "the already-bound listener should have been rolled back"
        );
    }

    #[tokio::test]
    async fn a_loopback_upstream_on_a_different_port_is_fine() {
        let upstream_port = free_port().await;
        let listen_port = free_port().await;
        assert_ne!(upstream_port, listen_port);
        let mut config = direct_config();
        config.local_proxy_port = listen_port;
        with_upstream(
            &mut config,
            UpstreamKind::Socks5,
            "127.0.0.1",
            upstream_port,
        );

        let proxy = start(&config, direct_context(config.clone()))
            .await
            .unwrap();

        assert_eq!(proxy.default_port(), Some(listen_port));
        proxy.stop().await;
    }

    #[tokio::test]
    async fn a_remote_upstream_sharing_the_port_number_is_fine() {
        // Only a loopback endpoint can loop back; the same port number on a
        // remote host is an unrelated address.
        let port = free_port().await;
        let mut config = direct_config();
        config.local_proxy_port = port;
        with_upstream(&mut config, UpstreamKind::Socks5, "203.0.113.5", port);

        let proxy = start(&config, direct_context(config.clone()))
            .await
            .unwrap();

        assert_eq!(proxy.default_port(), Some(port));
        proxy.stop().await;
    }

    #[tokio::test]
    async fn a_core_backed_upstream_endpoint_does_not_block_the_port() {
        // Core protocols are dialed through the xray sidecar's own inbound port,
        // so the configured endpoint is never dialed directly and cannot loop.
        let port = free_port().await;
        let mut config = direct_config();
        config.local_proxy_port = port;
        with_upstream(&mut config, UpstreamKind::Shadowsocks, "127.0.0.1", port);

        let proxy = start(&config, direct_context(config.clone()))
            .await
            .unwrap();

        assert_eq!(proxy.default_port(), Some(port));
        proxy.stop().await;
    }

    #[test]
    fn unpinned_profiles_do_not_collide_on_zero() {
        // Several profiles requesting "assign one" is normal, not a conflict.
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = _ScopeMode::Apps;
        config.profiles[0].apps = vec![app_selector("/opt/a/a")];
        for index in 0..2 {
            let mut extra = config.profiles[0].clone();
            extra.id = format!("extra-{index}");
            extra.priority = index + 1;
            config.profiles.push(extra);
            config.active_profile_ids.push(format!("extra-{index}"));
        }

        assert!(plan_port_assignments(&config).is_ok());
    }
}
