//! Per-flow capture gate — re-exported from [`sockscap_core`].
//!
//! The rule itself lives in the `sockscap-core` crate so the macOS Network
//! Extension can link it and call it over the C-ABI (one implementation, no
//! Swift copy). This module only adds the engine-side glue that builds a
//! [`SelectedApps`] from Taomni's [`SocksCapConfig`] — the crate boundary keeps
//! `sockscap-core` free of the app's config types.

pub use sockscap_core::decision::{
    ProviderFlowDecision, SELF_BUNDLE_ID, SelectedApps, macos_provider_decision,
};

use crate::sockscap::config::{ScopeMode, SocksCapConfig};

/// Derive the provider's capture selection from the active profiles.
///
/// If any active profile is Global, the whole capture plane is global (matching
/// [`PolicyEngine`](crate::sockscap::policy::PolicyEngine), where a Global
/// profile matches every flow). Otherwise the macOS signing identifiers
/// (`AppSelector.bundle_id`, which on macOS holds the signing identifier — for
/// most apps the bundle id) of every App-scoped profile are unioned.
///
/// An App-scoped profile whose selectors carry no macOS identity contributes
/// nothing: it must capture *nothing*, never fall open to everything.
pub fn selected_from_config(cfg: &SocksCapConfig) -> SelectedApps {
    let active = cfg.active_profiles();
    let global = active.iter().any(|p| matches!(p.mode, ScopeMode::Global));
    if global {
        return SelectedApps::new(true, std::iter::empty());
    }
    let ids = active
        .iter()
        .filter(|p| matches!(p.mode, ScopeMode::Apps))
        .flat_map(|p| p.apps.iter())
        .map(|app| app.bundle_id.trim().to_string())
        .filter(|id| !id.is_empty());
    SelectedApps::new(false, ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::config::{AppSelector, ScopeMode, SocksCapProfile};
    use ProviderFlowDecision::{Handle, PassThrough};

    fn profile(id: &str, mode: ScopeMode, apps: Vec<AppSelector>) -> SocksCapProfile {
        SocksCapProfile {
            id: id.into(),
            name: id.into(),
            icon: None,
            color: None,
            enabled: true,
            priority: 0,
            mode,
            apps,
            upstream: Default::default(),
            rule_mode: Default::default(),
            user_rules: vec![],
            default_action: Default::default(),
        }
    }

    fn selector(bundle_id: &str) -> AppSelector {
        AppSelector {
            path: String::new(),
            bundle_id: bundle_id.into(),
            name: bundle_id.into(),
        }
    }

    #[test]
    fn unions_app_profile_signing_ids() {
        let mut cfg = SocksCapConfig::default();
        cfg.profiles = vec![
            profile("game", ScopeMode::Apps, vec![selector("com.valve.steam")]),
            profile(
                "dev",
                ScopeMode::Apps,
                vec![selector("com.microsoft.VSCode")],
            ),
        ];
        cfg.active_profile_ids = vec!["game".into(), "dev".into()];

        let selected = selected_from_config(&cfg);
        assert!(!selected.is_global());
        assert!(selected.signing_ids().contains("com.valve.steam"));
        assert!(selected.signing_ids().contains("com.microsoft.VSCode"));
        assert_eq!(
            macos_provider_decision("com.valve.steam", &selected),
            Handle
        );
        assert_eq!(
            macos_provider_decision("com.apple.Safari", &selected),
            PassThrough
        );
    }

    #[test]
    fn any_global_profile_makes_the_plane_global() {
        let mut cfg = SocksCapConfig::default();
        cfg.profiles = vec![
            profile("game", ScopeMode::Apps, vec![selector("com.valve.steam")]),
            profile("all", ScopeMode::Global, vec![]),
        ];
        cfg.active_profile_ids = vec!["game".into(), "all".into()];

        let selected = selected_from_config(&cfg);
        assert!(selected.is_global());
        assert!(selected.signing_ids().is_empty());
        assert_eq!(
            macos_provider_decision("com.apple.Safari", &selected),
            Handle
        );
    }

    #[test]
    fn ignores_app_profiles_without_a_macos_identity() {
        let mut cfg = SocksCapConfig::default();
        let mut sel = selector("");
        sel.path = "/Applications/Foo.app/Contents/MacOS/Foo".into();
        cfg.profiles = vec![profile("foo", ScopeMode::Apps, vec![sel])];
        cfg.active_profile_ids = vec!["foo".into()];

        let selected = selected_from_config(&cfg);
        assert!(!selected.is_global());
        assert!(selected.signing_ids().is_empty());
    }
}
