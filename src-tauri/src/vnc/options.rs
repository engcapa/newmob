use serde::{Deserialize, Serialize};

use super::limits::HARD_MAX_CLIPBOARD_FORMAT_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VncSecurityPolicy {
    RequireEncryption,
    PreferEncryption,
    LegacyCompatible,
}

impl Default for VncSecurityPolicy {
    fn default() -> Self {
        Self::PreferEncryption
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VncClipboardPolicy {
    Disabled,
    ClientToServer,
    ServerToClient,
    Bidirectional,
}

impl Default for VncClipboardPolicy {
    fn default() -> Self {
        Self::Bidirectional
    }
}

impl VncClipboardPolicy {
    pub fn sends_to_server(self) -> bool {
        matches!(self, Self::ClientToServer | Self::Bidirectional)
    }

    pub fn receives_from_server(self) -> bool {
        matches!(self, Self::ServerToClient | Self::Bidirectional)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncOptions {
    #[serde(default)]
    pub security_policy: VncSecurityPolicy,
    #[serde(default)]
    pub allow_none: bool,
    #[serde(default = "default_true")]
    pub shared: bool,
    #[serde(default)]
    pub view_only: bool,
    #[serde(default)]
    pub clipboard_policy: VncClipboardPolicy,
    #[serde(default = "default_true")]
    pub clipboard_text_only: bool,
    #[serde(default)]
    pub allow_html_clipboard: bool,
    #[serde(default)]
    pub allow_rtf_clipboard: bool,
    #[serde(default = "default_clipboard_max_bytes")]
    pub clipboard_max_bytes: usize,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(default = "default_reconnect_attempts")]
    pub reconnect_max_attempts: u8,
    #[serde(default = "default_command_key_mode")]
    pub command_key_mode: String,
}

impl Default for VncOptions {
    fn default() -> Self {
        Self {
            security_policy: VncSecurityPolicy::default(),
            allow_none: false,
            shared: true,
            view_only: false,
            clipboard_policy: VncClipboardPolicy::default(),
            clipboard_text_only: true,
            allow_html_clipboard: false,
            allow_rtf_clipboard: false,
            clipboard_max_bytes: default_clipboard_max_bytes(),
            auto_reconnect: true,
            reconnect_max_attempts: default_reconnect_attempts(),
            command_key_mode: default_command_key_mode(),
        }
    }
}

impl VncOptions {
    pub fn from_json(raw: Option<&str>) -> Result<Self, String> {
        let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
            return Ok(Self::default());
        };
        let mut options = serde_json::from_str::<Self>(raw)
            .map_err(|error| format!("invalid VNC options: {error}"))?;
        options.clipboard_max_bytes = options
            .clipboard_max_bytes
            .clamp(1, HARD_MAX_CLIPBOARD_FORMAT_BYTES);
        options.reconnect_max_attempts = options.reconnect_max_attempts.min(10);
        if !matches!(
            options.command_key_mode.as_str(),
            "remote-meta" | "local-shortcuts"
        ) {
            options.command_key_mode = default_command_key_mode();
        }
        if options.clipboard_text_only {
            options.allow_html_clipboard = false;
            options.allow_rtf_clipboard = false;
        }
        Ok(options)
    }
}

fn default_true() -> bool {
    true
}

fn default_clipboard_max_bytes() -> usize {
    HARD_MAX_CLIPBOARD_FORMAT_BYTES
}

fn default_reconnect_attempts() -> u8 {
    5
}

fn default_command_key_mode() -> String {
    "remote-meta".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_defaults_reject_none_and_limit_clipboard_to_text() {
        let options = VncOptions::default();
        assert_eq!(options.security_policy, VncSecurityPolicy::PreferEncryption);
        assert!(!options.allow_none);
        assert!(options.clipboard_text_only);
        assert!(!options.allow_html_clipboard);
        assert!(!options.allow_rtf_clipboard);
    }

    #[test]
    fn parsing_clamps_user_controlled_limits() {
        let options = VncOptions::from_json(Some(
            r#"{"clipboardMaxBytes":999999999,"reconnectMaxAttempts":255,"commandKeyMode":"bad"}"#,
        ))
        .unwrap();
        assert_eq!(options.clipboard_max_bytes, HARD_MAX_CLIPBOARD_FORMAT_BYTES);
        assert_eq!(options.reconnect_max_attempts, 10);
        assert_eq!(options.command_key_mode, "remote-meta");
    }
}
