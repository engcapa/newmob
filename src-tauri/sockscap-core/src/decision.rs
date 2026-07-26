//! Per-flow capture gate for the macOS transparent-proxy backend.
//!
//! A [`NETransparentProxyProvider`] asks, for every new outbound flow, one
//! coarse question: *handle this flow* (relay it into SocksCap's SOCKS backend,
//! where the engine's policy decides PROXY / DIRECT / BLOCK) or *pass it
//! through* (let the OS dial it directly). This module is the single
//! implementation of that gate — the Swift provider calls it over the [`crate::ffi`]
//! C-ABI rather than reimplementing it, so the two can never disagree.
//!
//! Keeping the gate coarse is deliberate: the provider only needs the source
//! app's identity to decide *whether* to capture. All routing stays behind the
//! SOCKS port, so this logic never duplicates rule evaluation.
//!
//! ## Identity: the signing identifier, derived from the audit token
//!
//! The input `source_signing_id` is the identity the provider extracts from the
//! flow's `sourceAppAuditToken` via the OS code-signing machinery (on macOS the
//! audit token is the unspoofable anchor; `sourceAppSigningIdentifier` is *not*
//! guaranteed to equal the bundle id). The selection set is therefore keyed on
//! that signing identifier. For the common Developer-ID / App-Store app it
//! equals the bundle id, but the *authority* is the signing identifier, and the
//! anti-spoofing guarantee is the audit token the provider verifies before
//! calling in.

use std::collections::HashSet;

/// SocksCap's own bundle identifier. Flows from our own process must never be
/// captured, or the provider would relay our upstream dials back into itself.
pub const SELF_BUNDLE_ID: &str = "com.taomni.app";

/// What the provider should do with a single new flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFlowDecision {
    /// Relay the flow into the local SOCKS backend for policy evaluation.
    Handle,
    /// Leave the flow to the OS — a direct connection, never captured.
    PassThrough,
}

/// The set of application identities the provider is configured to capture.
///
/// `global` is tracked explicitly rather than inferred from an empty
/// `signing_ids`: an App-scoped selection that happens to carry no resolvable
/// identity must capture *nothing*, not silently fall open to capturing
/// everything. Only a real Global-mode selection sets `global`.
#[derive(Debug, Clone, Default)]
pub struct SelectedApps {
    global: bool,
    signing_ids: HashSet<String>,
    /// Identities that always pass through, evaluated before everything else.
    self_bypass: HashSet<String>,
}

impl SelectedApps {
    /// Build a selection from the `global` flag and the set of signing
    /// identifiers to capture. The engine builds this from its config; the
    /// extension builds the identical value from the control-protocol JSON.
    pub fn new(global: bool, signing_ids: impl IntoIterator<Item = String>) -> Self {
        Self {
            global,
            signing_ids: signing_ids
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect(),
            self_bypass: default_self_bypass(),
        }
    }

    /// Whether the plane captures every app (subject only to self-bypass).
    pub fn is_global(&self) -> bool {
        self.global
    }

    /// The signing identifiers the provider should capture (empty when global).
    pub fn signing_ids(&self) -> &HashSet<String> {
        &self.signing_ids
    }

    /// Add an identity that must always pass through (e.g. the resolved upstream
    /// proxy's own client). Chainable.
    pub fn with_bypass(mut self, id: impl Into<String>) -> Self {
        let id = id.into();
        let id = id.trim();
        if !id.is_empty() {
            self.self_bypass.insert(id.to_string());
        }
        self
    }
}

fn default_self_bypass() -> HashSet<String> {
    let mut set = HashSet::new();
    set.insert(SELF_BUNDLE_ID.to_string());
    set
}

/// Decide what the provider should do with a flow from `source_signing_id`.
///
/// Order matters: self-bypass is checked first so our own traffic can never be
/// captured even in global mode; then global captures everything; then the
/// explicit selection set.
pub fn macos_provider_decision(
    source_signing_id: &str,
    selected: &SelectedApps,
) -> ProviderFlowDecision {
    let id = source_signing_id.trim();
    if id.is_empty() {
        // No identity at all: capturing an unattributable flow is exactly the
        // "proxy everything" hazard app scope exists to avoid. Follow scope.
        return if selected.is_global() {
            ProviderFlowDecision::Handle
        } else {
            ProviderFlowDecision::PassThrough
        };
    }
    if selected.self_bypass.contains(id) {
        return ProviderFlowDecision::PassThrough;
    }
    if selected.is_global() || selected.signing_ids.contains(id) {
        return ProviderFlowDecision::Handle;
    }
    ProviderFlowDecision::PassThrough
}

#[cfg(test)]
mod tests {
    use super::*;
    use ProviderFlowDecision::{Handle, PassThrough};

    fn apps(ids: &[&str]) -> SelectedApps {
        SelectedApps::new(false, ids.iter().map(|s| s.to_string()))
    }

    #[test]
    fn global_captures_every_identity() {
        let selected = SelectedApps::new(true, std::iter::empty());
        assert_eq!(
            macos_provider_decision("com.apple.Safari", &selected),
            Handle
        );
        assert_eq!(
            macos_provider_decision("org.mozilla.firefox", &selected),
            Handle
        );
    }

    #[test]
    fn app_set_captures_only_listed_identities() {
        let selected = apps(&["com.apple.Safari"]);
        assert_eq!(
            macos_provider_decision("com.apple.Safari", &selected),
            Handle
        );
        assert_eq!(
            macos_provider_decision("org.mozilla.firefox", &selected),
            PassThrough
        );
    }

    #[test]
    fn self_bypass_wins_even_under_global() {
        let selected = SelectedApps::new(true, std::iter::empty());
        assert_eq!(
            macos_provider_decision(SELF_BUNDLE_ID, &selected),
            PassThrough
        );
    }

    #[test]
    fn extra_bypass_identity_passes_through() {
        let selected = apps(&["com.apple.Safari"]).with_bypass("com.acme.upstream");
        assert_eq!(
            macos_provider_decision("com.acme.upstream", &selected),
            PassThrough
        );
        assert_eq!(
            macos_provider_decision("com.apple.Safari", &selected),
            Handle
        );
    }

    #[test]
    fn empty_selection_that_is_not_global_captures_nothing() {
        let selected = apps(&[]);
        assert!(!selected.is_global());
        assert_eq!(
            macos_provider_decision("com.apple.Safari", &selected),
            PassThrough
        );
    }

    #[test]
    fn unattributable_flow_follows_scope() {
        assert_eq!(
            macos_provider_decision("", &SelectedApps::new(true, std::iter::empty())),
            Handle
        );
        assert_eq!(
            macos_provider_decision("   ", &apps(&["com.apple.Safari"])),
            PassThrough
        );
    }

    #[test]
    fn blank_ids_are_dropped_from_the_selection() {
        let selected = SelectedApps::new(false, ["  ".to_string(), "com.apple.Safari".to_string()]);
        assert_eq!(selected.signing_ids().len(), 1);
        assert!(selected.signing_ids().contains("com.apple.Safari"));
    }
}
