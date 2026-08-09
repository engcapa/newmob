use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VncStage {
    Dns,
    Tcp,
    Proxy,
    Rfb,
    Security,
    Authentication,
    Initialization,
    Runtime,
    Relay,
}

#[derive(Debug, Clone, Serialize)]
pub struct VncError {
    pub code: &'static str,
    pub stage: VncStage,
    pub retryable: bool,
    pub message: String,
}

impl VncError {
    pub fn classify(message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.len() > 2048 {
            let mut boundary = 2048;
            while !message.is_char_boundary(boundary) {
                boundary -= 1;
            }
            message.truncate(boundary);
            message.push_str("...");
        }
        let lower = message.to_ascii_lowercase();
        let (code, stage, retryable) = if lower.contains("dns") {
            ("dns-failed", VncStage::Dns, true)
        } else if lower.contains("proxy") || lower.contains("jump host") {
            ("network-route-failed", VncStage::Proxy, true)
        } else if lower.contains("vencrypt/tls")
            || (lower.contains("security policy") && lower.contains("unavailable"))
        {
            ("security-policy-unsupported", VncStage::Security, false)
        } else if lower.contains("unauthenticated")
            || lower.contains("security")
            || lower.contains("encrypted")
        {
            ("security-policy-rejected", VncStage::Security, false)
        } else if lower.contains("authentication")
            || lower.contains("password")
            || lower.contains("ra2")
        {
            ("authentication-failed", VncStage::Authentication, false)
        } else if lower.contains("server init") || lower.contains("framebuffer") {
            ("initialization-failed", VncStage::Initialization, false)
        } else if lower.contains("websocket") || lower.contains("relay") || lower.contains("origin")
        {
            ("relay-failed", VncStage::Relay, true)
        } else if lower.contains("connection reset")
            || lower.contains("connection aborted")
            || lower.contains("broken pipe")
            || lower.contains("unexpected eof")
            || lower.contains("unexpected end of file")
        {
            ("connection-lost", VncStage::Runtime, true)
        } else if lower.contains("tcp") || lower.contains("connect") || lower.contains("timed out")
        {
            ("tcp-failed", VncStage::Tcp, true)
        } else {
            ("rfb-failed", VncStage::Rfb, false)
        };
        Self {
            code,
            stage,
            retryable,
            message,
        }
    }

    pub fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"code":"vnc-error","stage":"runtime","retryable":false,"message":"VNC error"}"#
                .into()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_retryable_and_terminal_failures() {
        assert!(VncError::classify("TCP connection timed out").retryable);
        assert!(!VncError::classify("authentication failed").retryable);
        assert_eq!(
            VncError::classify("server offers unauthenticated VNC").stage,
            VncStage::Security
        );
        assert_eq!(
            VncError::classify(
                "encrypted VNC policy is unavailable until VeNCrypt/TLS is implemented"
            )
            .code,
            "security-policy-unsupported"
        );
        assert!(VncError::classify("read failed: unexpected EOF").retryable);
        assert!(!VncError::classify("server rejected connection: authentication failed").retryable);
    }

    #[test]
    fn bounds_error_messages() {
        assert!(VncError::classify("x".repeat(3000)).message.len() <= 2051);
        assert!(VncError::classify("中".repeat(1000)).message.len() <= 2051);
    }
}
