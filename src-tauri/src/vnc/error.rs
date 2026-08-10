use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VncStage {
    Resolving,
    Connecting,
    Proxy,
    Tls,
    Negotiating,
    Authenticating,
    Initializing,
    Relay,
    Runtime,
    Clipboard,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncError {
    pub code: String,
    pub stage: VncStage,
    pub retryable: bool,
    pub sanitized_message: String,
}

impl VncError {
    pub fn new(
        code: impl Into<String>,
        stage: VncStage,
        retryable: bool,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            stage,
            retryable,
            sanitized_message: message.into(),
        }
    }

    pub fn from_transport(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let (code, stage, retryable) =
            if lower.contains("tls") || lower.contains("certificate") || lower.contains("hostname")
            {
                ("VNC_TLS_FAILED", VncStage::Tls, false)
            } else if lower.contains("dns") || lower.contains("resolve") {
                ("VNC_DNS_FAILED", VncStage::Resolving, true)
            } else if lower.contains("proxy") || lower.contains("socks") || lower.contains("jump") {
                ("VNC_ROUTE_FAILED", VncStage::Proxy, true)
            } else if lower.contains("timed out") || lower.contains("timeout") {
                ("VNC_CONNECT_TIMEOUT", VncStage::Connecting, true)
            } else {
                ("VNC_CONNECT_FAILED", VncStage::Connecting, true)
            };
        Self::new(code, stage, retryable, message)
    }

    pub fn from_protocol(stage: VncStage, message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let (code, retryable) =
            if lower.contains("authentication failed") || lower.contains("password") {
                ("VNC_AUTH_FAILED", false)
            } else if lower.contains("security") || lower.contains("policy") {
                ("VNC_SECURITY_POLICY", false)
            } else if lower.contains("too large")
                || lower.contains("exceeds")
                || lower.contains("overflow")
            {
                ("VNC_RESOURCE_LIMIT", false)
            } else if lower.contains("unsupported") {
                ("VNC_UNSUPPORTED", false)
            } else if lower.contains("timed out") || lower.contains("timeout") {
                ("VNC_STAGE_TIMEOUT", true)
            } else if lower.contains("connection closed")
                || lower.contains("connection reset")
                || lower.contains("connection aborted")
                || lower.contains("broken pipe")
                || lower.contains("unexpected eof")
                || lower.contains("failed to fill whole buffer")
                || lower.contains("reached eof")
            {
                ("VNC_CONNECTION_LOST", true)
            } else {
                ("VNC_PROTOCOL_ERROR", false)
            };
        Self::new(code, stage, retryable, message)
    }
}

impl fmt::Display for VncError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.sanitized_message)
    }
}

impl std::error::Error for VncError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_loss_is_retryable_but_protocol_corruption_is_not() {
        let lost = VncError::from_protocol(
            VncStage::Runtime,
            "read server message type: failed to fill whole buffer".to_string(),
        );
        assert_eq!(lost.code, "VNC_CONNECTION_LOST");
        assert!(lost.retryable);

        let corrupt = VncError::from_protocol(
            VncStage::Runtime,
            "unknown server message type: 99".to_string(),
        );
        assert_eq!(corrupt.code, "VNC_PROTOCOL_ERROR");
        assert!(!corrupt.retryable);

        let certificate = VncError::from_transport("TLS certificate validation failed".to_string());
        assert_eq!(certificate.code, "VNC_TLS_FAILED");
        assert_eq!(certificate.stage, VncStage::Tls);
        assert!(!certificate.retryable);
    }
}
