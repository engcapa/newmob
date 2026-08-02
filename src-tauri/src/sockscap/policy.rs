use serde::Serialize;
use std::net::IpAddr;

use crate::sockscap::Decision;
use crate::sockscap::config::{RuleMode, ScopeMode, SocksCapConfig, UserRule, UserRuleAction};
use crate::sockscap::paths::{normalize_exe_path, paths_match_exe};
use crate::sockscap::rules::{CompiledRules, RuleMatch};

#[derive(Debug, Clone)]
pub struct PolicyInput {
    pub host: Option<String>,
    pub ip: Option<IpAddr>,
    pub port: u16,
    pub process_path: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchTrace {
    pub decision: Decision,
    pub reason: String,
    pub matched_rule: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ActiveProfileEngine {
    pub id: String,
    pub name: String,
    pub mode: ScopeMode,
    pub apps: Vec<String>,
    pub rule_mode: RuleMode,
    pub user_rules: Vec<UserRule>,
    pub default_action: Decision,
}

pub struct PolicyEngine {
    profiles: Vec<ActiveProfileEngine>,
    bypass_cidrs: Vec<IpNetwork>,
    rules: Option<CompiledRules>,
}

#[derive(Debug, Clone)]
struct IpNetwork {
    addr: IpAddr,
    prefix: u8,
}

impl IpNetwork {
    fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if let Some((a, p)) = s.split_once('/') {
            let addr: IpAddr = a.parse().ok()?;
            let prefix: u8 = p.parse().ok()?;
            Some(Self { addr, prefix })
        } else {
            let addr: IpAddr = s.parse().ok()?;
            let prefix = match addr {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            Some(Self { addr, prefix })
        }
    }

    fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                let shift = 32u32.saturating_sub(self.prefix as u32);
                let mask = if shift >= 32 { 0 } else { u32::MAX << shift };
                (u32::from(n) & mask) == (u32::from(a) & mask)
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => {
                let n = u128::from(n);
                let a = u128::from(a);
                let shift = 128u32.saturating_sub(self.prefix as u32);
                let mask = if shift >= 128 { 0 } else { u128::MAX << shift };
                (n & mask) == (a & mask)
            }
            _ => false,
        }
    }
}

impl PolicyEngine {
    pub fn from_config(cfg: &SocksCapConfig, rules: Option<&CompiledRules>) -> Self {
        let bypass_cidrs = cfg
            .bypass_cidrs
            .iter()
            .filter_map(|s| IpNetwork::parse(s))
            .collect();
        let profiles = cfg
            .active_profiles()
            .into_iter()
            .map(|p| {
                let apps = p
                    .apps
                    .iter()
                    .map(|a| normalize_exe_path(&a.path))
                    .filter(|s| !s.is_empty())
                    .collect();
                ActiveProfileEngine {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    mode: p.mode,
                    apps,
                    rule_mode: p.rule_mode,
                    user_rules: p.user_rules.clone(),
                    default_action: p.default_action,
                }
            })
            .collect();
        Self {
            profiles,
            bypass_cidrs,
            rules: rules.cloned(),
        }
    }

    /// Whether this process is in scope for capture across any active profile.
    pub fn process_in_scope(&self, process_path: Option<&str>) -> bool {
        if self.profiles.is_empty() {
            return false;
        }
        if self
            .profiles
            .iter()
            .any(|p| matches!(p.mode, ScopeMode::Global))
        {
            return true;
        }
        let Some(p) = process_path else {
            return false;
        };
        let norm = normalize_path(p);
        self.profiles
            .iter()
            .any(|prof| prof.apps.iter().any(|a| paths_match(&norm, a)))
    }

    pub fn decide(&self, input: &PolicyInput) -> MatchTrace {
        self.decide_with_profile_hint(input, None)
    }

    /// Return a final decision when hostname attribution cannot affect it.
    ///
    /// Transparent capture receives an IP before any application bytes. Global
    /// ProxyAll profiles and hard bypasses can be routed immediately instead of
    /// holding every connection open for the hostname sniff budget. A profile
    /// with a domain user rule or GFWList still returns `None` and waits for SNI,
    /// HTTP Host, or the DNS observation cache.
    pub(crate) fn decide_without_hostname(
        &self,
        input: &PolicyInput,
        profile_id_hint: Option<&str>,
    ) -> Option<MatchTrace> {
        if input.host.is_some() {
            return Some(self.decide_with_profile_hint(input, profile_id_hint));
        }

        if let Some(ip) = input.ip
            && self.bypass_cidrs.iter().any(|network| network.contains(ip))
        {
            return Some(self.decide_with_profile_hint(input, profile_id_hint));
        }

        for profile in &self.profiles {
            if matches!(profile.mode, ScopeMode::Apps) {
                let in_scope = profile_id_hint
                    .map(|profile_id| profile_id == profile.id)
                    .unwrap_or_else(|| match input.process_path.as_deref() {
                        Some(path) => {
                            let normalized = normalize_path(path);
                            profile.apps.iter().any(|app| paths_match(&normalized, app))
                        }
                        None => false,
                    });
                if !in_scope {
                    continue;
                }
            }

            let has_domain_rule = profile.user_rules.iter().any(|rule| {
                let pattern = rule.pattern.trim();
                !pattern.is_empty() && IpNetwork::parse(pattern).is_none()
            });
            if has_domain_rule || matches!(profile.rule_mode, RuleMode::GfwList) {
                return None;
            }
            return Some(self.decide_with_profile_hint(input, profile_id_hint));
        }

        Some(self.decide_with_profile_hint(input, profile_id_hint))
    }

    /// Evaluate a flow already scoped by an OS capture backend to one app
    /// profile. Linux uses a dedicated cgroup + relay port per profile, so it
    /// can preserve profile identity without an expensive per-flow `/proc`
    /// socket-owner lookup.
    pub(crate) fn decide_with_profile_hint(
        &self,
        input: &PolicyInput,
        profile_id_hint: Option<&str>,
    ) -> MatchTrace {
        let host = input
            .host
            .as_deref()
            .map(|h| h.trim_end_matches('.').to_ascii_lowercase())
            .filter(|h| !h.is_empty());

        // Bypass CIDR
        if let Some(ip) = input.ip {
            for net in &self.bypass_cidrs {
                if net.contains(ip) {
                    return MatchTrace {
                        decision: Decision::Direct,
                        reason: format!("bypass CIDR ({ip})"),
                        matched_rule: Some(format!("{}/{}", net.addr, net.prefix)),
                        profile_id: None,
                        profile_name: None,
                    };
                }
            }
        }

        // Iterate active profiles in priority order
        for prof in &self.profiles {
            if matches!(prof.mode, ScopeMode::Apps) {
                let in_scope = profile_id_hint
                    .map(|profile_id| profile_id == prof.id)
                    .unwrap_or_else(|| match input.process_path.as_deref() {
                        Some(p) => {
                            let norm = normalize_path(p);
                            prof.apps.iter().any(|a| paths_match(&norm, a))
                        }
                        None => false,
                    });
                if !in_scope {
                    continue;
                }
            }

            // User rules in this profile — Block > Proxy > Direct
            if let Some(mut t) =
                self.match_user_rules(prof, host.as_deref(), input.ip, UserRuleAction::Block)
            {
                t.profile_id = Some(prof.id.clone());
                t.profile_name = Some(prof.name.clone());
                return t;
            }
            if let Some(mut t) =
                self.match_user_rules(prof, host.as_deref(), input.ip, UserRuleAction::Proxy)
            {
                t.profile_id = Some(prof.id.clone());
                t.profile_name = Some(prof.name.clone());
                return t;
            }
            if let Some(mut t) =
                self.match_user_rules(prof, host.as_deref(), input.ip, UserRuleAction::Direct)
            {
                t.profile_id = Some(prof.id.clone());
                t.profile_name = Some(prof.name.clone());
                return t;
            }

            match prof.rule_mode {
                RuleMode::Off => {
                    return MatchTrace {
                        decision: Decision::Direct,
                        reason: format!("profile '{}' rule_mode=off", prof.name),
                        matched_rule: None,
                        profile_id: Some(prof.id.clone()),
                        profile_name: Some(prof.name.clone()),
                    };
                }
                RuleMode::ProxyAll => {
                    return MatchTrace {
                        decision: Decision::Proxy,
                        reason: format!("profile '{}' rule_mode=proxyAll", prof.name),
                        matched_rule: None,
                        profile_id: Some(prof.id.clone()),
                        profile_name: Some(prof.name.clone()),
                    };
                }
                RuleMode::GfwList => {
                    let Some(h) = host.as_deref() else {
                        return MatchTrace {
                            decision: prof.default_action,
                            reason: format!("profile '{}' no hostname; default_action", prof.name),
                            matched_rule: None,
                            profile_id: Some(prof.id.clone()),
                            profile_name: Some(prof.name.clone()),
                        };
                    };
                    match self.rules.as_ref().map(|r| r.match_host(h)) {
                        Some(RuleMatch::Proxy { rule }) => {
                            return MatchTrace {
                                decision: Decision::Proxy,
                                reason: format!("profile '{}' gfwlist proxy", prof.name),
                                matched_rule: Some(rule),
                                profile_id: Some(prof.id.clone()),
                                profile_name: Some(prof.name.clone()),
                            };
                        }
                        Some(RuleMatch::Direct { rule }) => {
                            return MatchTrace {
                                decision: Decision::Direct,
                                reason: format!("profile '{}' gfwlist whitelist", prof.name),
                                matched_rule: Some(rule),
                                profile_id: Some(prof.id.clone()),
                                profile_name: Some(prof.name.clone()),
                            };
                        }
                        Some(RuleMatch::Miss) | None => {
                            return MatchTrace {
                                decision: prof.default_action,
                                reason: format!(
                                    "profile '{}' gfwlist miss; default_action",
                                    prof.name
                                ),
                                matched_rule: None,
                                profile_id: Some(prof.id.clone()),
                                profile_name: Some(prof.name.clone()),
                            };
                        }
                    }
                }
            }
        }

        MatchTrace {
            decision: Decision::Direct,
            reason: "no matching active profile".into(),
            matched_rule: None,
            profile_id: None,
            profile_name: None,
        }
    }

    fn match_user_rules(
        &self,
        prof: &ActiveProfileEngine,
        host: Option<&str>,
        ip: Option<IpAddr>,
        action: UserRuleAction,
    ) -> Option<MatchTrace> {
        for r in &prof.user_rules {
            if r.action != action {
                continue;
            }
            if user_rule_matches(r, host, ip) {
                let decision = match r.action {
                    UserRuleAction::Direct => Decision::Direct,
                    UserRuleAction::Proxy => Decision::Proxy,
                    UserRuleAction::Block => Decision::Block,
                };
                return Some(MatchTrace {
                    decision,
                    reason: format!("profile '{}' user rule ({:?})", prof.name, r.action),
                    matched_rule: Some(r.pattern.clone()),
                    profile_id: Some(prof.id.clone()),
                    profile_name: Some(prof.name.clone()),
                });
            }
        }
        None
    }
}

fn user_rule_matches(r: &UserRule, host: Option<&str>, ip: Option<IpAddr>) -> bool {
    let pat = r.pattern.trim();
    if pat.is_empty() {
        return false;
    }
    if let Some(net) = IpNetwork::parse(pat) {
        if let Some(ip) = ip {
            return net.contains(ip);
        }
        // pattern is CIDR/IP but we only have a hostname — no match
        if host.is_none() {
            return false;
        }
    }
    if let Some(h) = host {
        let p = pat.trim_start_matches('.').to_ascii_lowercase();
        if h == p || h.ends_with(&format!(".{p}")) || h.contains(&p) {
            return true;
        }
    }
    false
}

fn normalize_path(p: &str) -> String {
    normalize_exe_path(p)
}

fn paths_match(process: &str, selector: &str) -> bool {
    paths_match_exe(process, selector)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::Decision;
    use crate::sockscap::config::{
        AppSelector, RuleMode, ScopeMode, SocksCapConfig, SocksCapProfile, UserRule,
    };
    use crate::sockscap::rules::CompiledRules;

    fn cfg_gfw() -> SocksCapConfig {
        let mut c = SocksCapConfig::default();
        c.profiles[0].upstream.host = "127.0.0.1".into();
        c.profiles[0].upstream.port = 1080;
        c
    }

    #[test]
    fn bypass_private() {
        let eng = PolicyEngine::from_config(&cfg_gfw(), None);
        let t = eng.decide(&PolicyInput {
            host: None,
            ip: Some("192.168.1.1".parse().unwrap()),
            port: 80,
            process_path: None,
            pid: None,
        });
        assert!(matches!(t.decision, Decision::Direct));
    }

    #[test]
    fn gfwlist_proxy_and_default() {
        let sample = "||google.com\n";
        let rules = CompiledRules::compile(sample, "t").unwrap();
        let eng = PolicyEngine::from_config(&cfg_gfw(), Some(&rules));
        let hit = eng.decide(&PolicyInput {
            host: Some("www.google.com".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        });
        assert!(matches!(hit.decision, Decision::Proxy));
        assert_eq!(hit.profile_id.as_deref(), Some("default"));
        let miss = eng.decide(&PolicyInput {
            host: Some("example.cn".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        });
        assert!(matches!(miss.decision, Decision::Direct));
    }

    #[test]
    fn hostname_free_decisions_skip_sniff_only_when_safe() {
        let mut config = cfg_gfw();
        let input = PolicyInput {
            host: None,
            ip: Some("8.8.8.8".parse().unwrap()),
            port: 443,
            process_path: None,
            pid: None,
        };
        let gfw = PolicyEngine::from_config(&config, None);
        assert!(gfw.decide_without_hostname(&input, None).is_none());

        config.profiles[0].rule_mode = RuleMode::ProxyAll;
        let proxy_all = PolicyEngine::from_config(&config, None);
        assert!(matches!(
            proxy_all
                .decide_without_hostname(&input, None)
                .unwrap()
                .decision,
            Decision::Proxy
        ));

        config.profiles[0].user_rules.push(UserRule {
            pattern: "example.com".into(),
            action: UserRuleAction::Direct,
            comment: String::new(),
        });
        let domain_override = PolicyEngine::from_config(&config, None);
        assert!(
            domain_override
                .decide_without_hostname(&input, None)
                .is_none()
        );
    }

    #[test]
    fn bypass_ip_never_waits_for_a_hostname() {
        let engine = PolicyEngine::from_config(&cfg_gfw(), None);
        let trace = engine
            .decide_without_hostname(
                &PolicyInput {
                    host: None,
                    ip: Some("192.168.0.110".parse().unwrap()),
                    port: 31028,
                    process_path: None,
                    pid: None,
                },
                None,
            )
            .unwrap();
        assert!(matches!(trace.decision, Decision::Direct));
    }

    #[test]
    fn multi_profile_priority() {
        let mut c = SocksCapConfig::default();
        let p1 = SocksCapProfile {
            id: "game".into(),
            name: "Game".into(),
            icon: None,
            color: None,
            enabled: true,
            priority: 0,
            mode: ScopeMode::Apps,
            apps: vec![AppSelector {
                path: "C:\\Apex.exe".into(),
                bundle_id: "".into(),
                name: "Apex".into(),
                macos_identity: None,
            }],
            upstream: Default::default(),
            rule_mode: RuleMode::ProxyAll,
            user_rules: vec![],
            default_action: Decision::Proxy,
        };
        let p2 = SocksCapProfile {
            id: "dev".into(),
            name: "Dev".into(),
            icon: None,
            color: None,
            enabled: true,
            priority: 1,
            mode: ScopeMode::Apps,
            apps: vec![AppSelector {
                path: "C:\\VSCode.exe".into(),
                bundle_id: "".into(),
                name: "VSCode".into(),
                macos_identity: None,
            }],
            upstream: Default::default(),
            rule_mode: RuleMode::Off,
            user_rules: vec![],
            default_action: Decision::Direct,
        };
        c.profiles = vec![p1, p2];
        c.active_profile_ids = vec!["game".into(), "dev".into()];

        let eng = PolicyEngine::from_config(&c, None);

        // Apex.exe should match Game profile
        let t1 = eng.decide(&PolicyInput {
            host: Some("apex.com".into()),
            ip: None,
            port: 443,
            process_path: Some("C:\\Apex.exe".into()),
            pid: None,
        });
        assert!(matches!(t1.decision, Decision::Proxy));
        assert_eq!(t1.profile_name.as_deref(), Some("Game"));

        // VSCode.exe should match Dev profile
        let t2 = eng.decide(&PolicyInput {
            host: Some("github.com".into()),
            ip: None,
            port: 443,
            process_path: Some("C:\\VSCode.exe".into()),
            pid: None,
        });
        assert!(matches!(t2.decision, Decision::Direct));
        assert_eq!(t2.profile_name.as_deref(), Some("Dev"));

        // Unmatched process should be Direct
        let t3 = eng.decide(&PolicyInput {
            host: Some("baidu.com".into()),
            ip: None,
            port: 443,
            process_path: Some("C:\\Notepad.exe".into()),
            pid: None,
        });
        assert!(matches!(t3.decision, Decision::Direct));
        assert_eq!(t3.profile_name, None);
    }

    #[test]
    fn linux_profile_hint_scopes_app_flow_without_process_path() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![AppSelector {
            path: "/opt/example/example".into(),
            bundle_id: String::new(),
            name: "Example".into(),
            macos_identity: None,
        }];
        config.profiles[0].rule_mode = RuleMode::ProxyAll;
        let engine = PolicyEngine::from_config(&config, None);
        let trace = engine.decide_with_profile_hint(
            &PolicyInput {
                host: Some("example.com".into()),
                ip: None,
                port: 443,
                process_path: None,
                pid: None,
            },
            Some("default"),
        );
        assert_eq!(trace.decision, Decision::Proxy);
        assert_eq!(trace.profile_id.as_deref(), Some("default"));
    }

    #[test]
    fn linux_mixed_relays_preserve_app_priority_and_global_fallback() {
        let mut config = SocksCapConfig::default();
        config.profiles[0].id = "agy".into();
        config.profiles[0].name = "agy".into();
        config.profiles[0].mode = ScopeMode::Apps;
        config.profiles[0].apps = vec![AppSelector {
            path: "/opt/agy/agy".into(),
            bundle_id: String::new(),
            name: "agy".into(),
            macos_identity: None,
        }];
        config.profiles[0].rule_mode = RuleMode::ProxyAll;

        let mut global = config.profiles[0].clone();
        global.id = "global".into();
        global.name = "Global GFWList".into();
        global.priority = 1;
        global.mode = ScopeMode::Global;
        global.apps.clear();
        global.rule_mode = RuleMode::GfwList;
        config.profiles.push(global);
        config.active_profile_ids = vec!["agy".into(), "global".into()];

        let rules = CompiledRules::compile("||wikipedia.org\n", "test").unwrap();
        let engine = PolicyEngine::from_config(&config, Some(&rules));
        let input = PolicyInput {
            host: Some("en.wikipedia.org".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        };

        let app = engine.decide_with_profile_hint(&input, Some("agy"));
        assert_eq!(app.decision, Decision::Proxy);
        assert_eq!(app.profile_id.as_deref(), Some("agy"));

        let fallback = engine.decide_with_profile_hint(&input, None);
        assert_eq!(fallback.decision, Decision::Proxy);
        assert_eq!(fallback.profile_id.as_deref(), Some("global"));
    }
}
