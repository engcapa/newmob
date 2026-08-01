//! Compile Taomni profiles into mitmproxy Redirector process actions.

use std::path::{Path, PathBuf};

use crate::sockscap::config::{ScopeMode, SocksCapConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirectorScopeMode {
    Global,
    Applications,
}

#[derive(Debug, Clone)]
struct ProfileScope {
    id: String,
    global: bool,
    patterns: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ScopeSnapshot {
    mode: RedirectorScopeMode,
    actions: Vec<String>,
    includes: Vec<String>,
    excludes: Vec<String>,
    profiles: Vec<ProfileScope>,
}

impl ScopeSnapshot {
    pub fn compile(
        config: &SocksCapConfig,
        mandatory_exclusions: impl IntoIterator<Item = PathBuf>,
    ) -> Result<Self, String> {
        let active = config.active_profiles();
        if active.is_empty() {
            return Err("Redirector capture requires at least one active profile".into());
        }

        let mut excludes = Vec::new();
        for path in mandatory_exclusions {
            // Keep both spellings when a symlink/case-normalized canonical path
            // differs. Redirector matching is case-sensitive string contains,
            // while process metadata and caller paths can use either spelling.
            let lexical = absolute_pattern(&path, false)?;
            push_unique(&mut excludes, lexical);
            let canonical = canonical_absolute_pattern(&path, false)?;
            push_unique(&mut excludes, canonical);
        }
        if excludes.is_empty() {
            return Err("Redirector capture requires at least one self-exclusion".into());
        }

        let global = active
            .iter()
            .any(|profile| matches!(profile.mode, ScopeMode::Global));
        let mode = if global {
            RedirectorScopeMode::Global
        } else {
            RedirectorScopeMode::Applications
        };

        let mut includes = Vec::new();
        let mut profiles = Vec::new();
        for profile in active {
            let is_global = matches!(profile.mode, ScopeMode::Global);
            let mut patterns = Vec::new();
            if !is_global {
                for app in &profile.apps {
                    let raw = app.path.trim();
                    if raw.is_empty() {
                        return Err(format!(
                            "macOS application profile '{}' has an empty executable path",
                            profile.name
                        ));
                    }
                    let pattern = application_family_pattern(Path::new(raw))?;
                    push_unique(&mut patterns, pattern.clone());
                    push_unique(&mut includes, pattern);
                }
                if patterns.is_empty() {
                    return Err(format!(
                        "macOS application profile '{}' has no usable application paths",
                        profile.name
                    ));
                }
            }
            profiles.push(ProfileScope {
                id: profile.id.clone(),
                global: is_global,
                patterns,
            });
        }

        let actions = match mode {
            RedirectorScopeMode::Global => excludes
                .iter()
                .map(|path| format!("!{path}"))
                .collect::<Vec<_>>(),
            RedirectorScopeMode::Applications => {
                if includes.is_empty() {
                    return Err("Redirector application scope compiled no include actions".into());
                }
                let mut actions = includes.clone();
                actions.extend(excludes.iter().map(|path| format!("!{path}")));
                actions
            }
        };
        debug_assert!(!actions.is_empty());

        Ok(Self {
            mode,
            actions,
            includes,
            excludes,
            profiles,
        })
    }

    pub fn mode(&self) -> RedirectorScopeMode {
        self.mode
    }

    pub fn actions(&self) -> &[String] {
        &self.actions
    }

    pub fn matches_process(&self, process_path: Option<&str>) -> bool {
        if let Some(path) = process_path {
            if self.excludes.iter().any(|pattern| path.contains(pattern)) {
                return false;
            }
        }
        match self.mode {
            // The Redirector itself already applied the global include rule.
            // Missing process metadata must not bypass policy or QUIC blocking.
            RedirectorScopeMode::Global => true,
            RedirectorScopeMode::Applications => process_path
                .is_some_and(|path| self.includes.iter().any(|pattern| path.contains(pattern))),
        }
    }

    /// Active profiles are already in stable priority order. Return the first
    /// matching profile so relay policy and Redirector scope resolve overlaps
    /// deterministically.
    pub fn profile_id_hint(&self, process_path: Option<&str>) -> Option<&str> {
        if !self.matches_process(process_path) {
            return None;
        }
        let path = process_path?;
        self.profiles
            .iter()
            .find(|profile| {
                profile.global
                    || profile
                        .patterns
                        .iter()
                        .any(|pattern| path.contains(pattern))
            })
            .map(|profile| profile.id.as_str())
    }
}

pub fn inert_actions() -> Vec<String> {
    vec![format!(
        "/__taomni_no_process__/{}/",
        uuid::Uuid::new_v4().simple()
    )]
}

fn canonical_absolute_pattern(path: &Path, app_family: bool) -> Result<String, String> {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    absolute_pattern(&resolved, app_family)
}

fn absolute_pattern(path: &Path, app_family: bool) -> Result<String, String> {
    if !path.is_absolute() {
        return Err(format!(
            "Redirector process selector must be an absolute path: {}",
            path.display()
        ));
    }
    let text = path
        .to_str()
        .ok_or_else(|| format!("Redirector path is not valid UTF-8: {}", path.display()))?;
    if text.is_empty() || text.starts_with('!') || text.parse::<u32>().is_ok() {
        return Err(format!("unsafe Redirector process selector: {text:?}"));
    }
    let mut text = text.to_string();
    if app_family && !text.ends_with('/') {
        text.push('/');
    }
    Ok(text)
}

fn application_family_pattern(path: &Path) -> Result<String, String> {
    let absolute = canonical_absolute_pattern(path, false)?;
    if let Some(index) = absolute.find(".app/") {
        return Ok(absolute[..index + ".app/".len()].to_string());
    }
    if absolute.ends_with(".app") {
        return Ok(format!("{absolute}/"));
    }
    Ok(absolute)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::config::{AppSelector, SocksCapProfile};

    fn app(path: &str) -> AppSelector {
        AppSelector {
            path: path.into(),
            bundle_id: String::new(),
            name: path.into(),
        }
    }

    fn profile(
        id: &str,
        priority: i32,
        mode: ScopeMode,
        apps: Vec<AppSelector>,
    ) -> SocksCapProfile {
        SocksCapProfile {
            id: id.into(),
            name: id.into(),
            icon: None,
            color: None,
            enabled: true,
            priority,
            mode,
            apps,
            upstream: Default::default(),
            rule_mode: Default::default(),
            user_rules: vec![],
            default_action: Default::default(),
        }
    }

    #[test]
    fn global_starts_with_exclusion_and_never_emits_empty_actions() {
        let cfg = SocksCapConfig::default();
        let scope = ScopeSnapshot::compile(
            &cfg,
            [PathBuf::from(
                "/Applications/Taomni.app/Contents/MacOS/Taomni",
            )],
        )
        .unwrap();
        assert_eq!(scope.mode(), RedirectorScopeMode::Global);
        assert!(scope.actions()[0].starts_with('!'));
        assert!(scope.matches_process(Some(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        )));
        assert!(scope.matches_process(None));
        assert!(!scope.matches_process(Some("/Applications/Taomni.app/Contents/MacOS/Taomni")));
    }

    #[test]
    fn application_scope_collapses_helpers_to_bundle_family() {
        let mut cfg = SocksCapConfig::default();
        cfg.profiles = vec![profile(
            "browser",
            10,
            ScopeMode::Apps,
            vec![app(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )],
        )];
        cfg.active_profile_ids = vec!["browser".into()];
        let scope =
            ScopeSnapshot::compile(&cfg, [PathBuf::from("/Applications/Taomni.app/")]).unwrap();

        assert_eq!(scope.actions()[0], "/Applications/Google Chrome.app/");
        assert!(scope.matches_process(Some(
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
        )));
        assert!(!scope.matches_process(Some("/Applications/Firefox.app/Contents/MacOS/firefox")));
        assert!(!scope.matches_process(None));
        assert_eq!(
            scope.profile_id_hint(Some(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            )),
            Some("browser")
        );
    }

    #[test]
    fn profile_hint_uses_existing_stable_priority_order() {
        let mut cfg = SocksCapConfig::default();
        cfg.profiles = vec![
            profile(
                "low",
                20,
                ScopeMode::Apps,
                vec![app("/Applications/Browser.app/")],
            ),
            profile(
                "high",
                1,
                ScopeMode::Apps,
                vec![app("/Applications/Browser.app/")],
            ),
        ];
        cfg.active_profile_ids = vec!["low".into(), "high".into()];
        let scope =
            ScopeSnapshot::compile(&cfg, [PathBuf::from("/Applications/Taomni.app/")]).unwrap();
        assert_eq!(
            scope.profile_id_hint(Some("/Applications/Browser.app/Contents/MacOS/Browser")),
            Some("high")
        );
    }

    #[test]
    fn relative_and_empty_app_selectors_fail_closed() {
        let mut cfg = SocksCapConfig::default();
        cfg.profiles = vec![profile("bad", 0, ScopeMode::Apps, vec![app("Chrome")])];
        cfg.active_profile_ids = vec!["bad".into()];
        let error =
            ScopeSnapshot::compile(&cfg, [PathBuf::from("/Applications/Taomni.app/")]).unwrap_err();
        assert!(error.contains("absolute path"));
    }

    #[test]
    fn inert_action_is_nonempty_include_with_unpredictable_component() {
        let first = inert_actions();
        let second = inert_actions();
        assert_eq!(first.len(), 1);
        assert!(!first[0].starts_with('!'));
        assert_ne!(first, second);
        assert!(first[0].starts_with("/__taomni_no_process__/"));
    }
}
