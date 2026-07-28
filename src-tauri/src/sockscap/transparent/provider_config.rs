//! The configuration the engine hands the Network Extension provider.
//!
//! When capture starts the app delivers the provider four things: the loopback
//! SOCKS port to relay handled flows into (dynamic — never a hardcoded 1080),
//! the control-socket path + auth token for the heartbeat channel, and the
//! capture selection as the exact JSON [`sockscap_selection_from_json`] parses.
//! All of it is built here, purely, so it is unit-tested on any host; the macOS
//! wiring only serializes and ships it.
//!
//! [`sockscap_selection_from_json`]: sockscap_core::ffi

use serde::Serialize;

use super::activation::EXTENSION_IDENTIFIER;
use super::decision::{SELF_BUNDLE_ID, SelectedApps};

/// The `{global, selectedAppIds, bypassIds}` JSON the provider feeds to
/// `sockscap_selection_from_json`. `selectedAppIds` is sorted so the value is
/// deterministic (stable config versions, stable tests).
///
/// `SELF_BUNDLE_ID` (the app) is added to the provider's self-bypass by the core
/// automatically; the **extension's own** signing identity is added here so the
/// provider never re-captures its own relay dial into a loop.
pub fn build_selection_json(selected: &SelectedApps) -> String {
    let mut ids: Vec<&str> = selected.signing_ids().iter().map(String::as_str).collect();
    ids.sort_unstable();
    let bypass = vec![EXTENSION_IDENTIFIER, SELF_BUNDLE_ID];
    let value = serde_json::json!({
        "global": selected.is_global(),
        "selectedAppIds": ids,
        "bypassIds": bypass,
    });
    value.to_string()
}

/// Everything the provider needs at start, delivered through the provider
/// configuration / `sendProviderMessage`. Serialized camelCase for the Swift
/// side; field names are locked by the test below.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Loopback SOCKS port the provider relays handled flows into.
    pub socks_port: u16,
    /// Path of the `AF_UNIX` control socket the provider connects back on.
    pub control_socket_path: String,
    /// Auth token the provider presents in its `Hello`.
    pub token: String,
    /// Capture selection JSON (see [`build_selection_json`]).
    pub selection_json: String,
}

impl ProviderConfig {
    pub fn new(
        socks_port: u16,
        control_socket_path: impl Into<String>,
        token: impl Into<String>,
        selected: &SelectedApps,
    ) -> Self {
        Self {
            socks_port,
            control_socket_path: control_socket_path.into(),
            token: token.into(),
            selection_json: build_selection_json(selected),
        }
    }

    /// Serialize for delivery to the extension.
    pub fn to_json(&self) -> String {
        // Infallible for these plain fields; fall back rather than panic.
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_json_is_sorted_and_self_bypasses_extension_and_app() {
        let selected = SelectedApps::new(
            false,
            [
                "com.valve.steam".to_string(),
                "com.apple.Safari".to_string(),
            ],
        );
        let json = build_selection_json(&selected);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["global"], false);
        assert_eq!(
            parsed["selectedAppIds"],
            serde_json::json!(["com.apple.Safari", "com.valve.steam"])
        );
        let bypass = parsed["bypassIds"].as_array().unwrap();
        assert!(bypass.iter().any(|v| v == EXTENSION_IDENTIFIER));
        assert!(bypass.iter().any(|v| v == SELF_BUNDLE_ID));
    }

    #[test]
    fn global_selection_serializes_global_true() {
        let selected = SelectedApps::new(true, std::iter::empty());
        let parsed: serde_json::Value =
            serde_json::from_str(&build_selection_json(&selected)).unwrap();
        assert_eq!(parsed["global"], true);
        assert_eq!(parsed["selectedAppIds"], serde_json::json!([]));
    }

    #[test]
    fn provider_config_wire_names_are_camel_case_for_swift() {
        let selected = SelectedApps::new(true, std::iter::empty());
        let cfg = ProviderConfig::new(51820, "/tmp/sc.sock", "sc-ne-abc", &selected);
        let json = cfg.to_json();
        assert!(json.contains("\"socksPort\":51820"));
        assert!(json.contains("\"controlSocketPath\":\"/tmp/sc.sock\""));
        assert!(json.contains("\"token\":\"sc-ne-abc\""));
        assert!(json.contains("\"selectionJson\""));
    }
}
