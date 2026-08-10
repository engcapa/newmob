use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum VncSecurityPolicy {
    /// Require encrypted RFB payloads. The current RA2 implementation does not
    /// authenticate the server identity; VeNCrypt/TLS is not implemented.
    RequireEncryption,
    /// Prefer the strongest supported method and require explicit opt-in for
    /// unauthenticated connections.
    #[default]
    PreferEncryption,
    /// Permit traditional VNCAuth/RA2 paths, but never silently accept None.
    LegacyCompatible,
    /// Explicitly permit an unauthenticated RFB security type.
    AllowNone,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum VncClipboardPolicy {
    Disabled,
    ClientToServer,
    ServerToClient,
    #[default]
    Bidirectional,
}

impl VncClipboardPolicy {
    pub fn allows_client_to_server(self) -> bool {
        matches!(self, Self::ClientToServer | Self::Bidirectional)
    }

    pub fn allows_server_to_client(self) -> bool {
        matches!(self, Self::ServerToClient | Self::Bidirectional)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VncSecurityType {
    None,
    VncAuth,
    Ra2,
    Ra2ne,
    /// RFB security type 18. It encrypts the transport but does not
    /// authenticate the server certificate.
    AnonymousTls,
}

impl VncSecurityType {
    pub fn encrypted(self) -> bool {
        matches!(self, Self::Ra2 | Self::AnonymousTls)
    }

    pub fn authenticated(self) -> bool {
        !matches!(self, Self::None | Self::AnonymousTls)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::VncAuth => "VNCAuth",
            Self::Ra2 => "RA2",
            Self::Ra2ne => "RA2ne",
            Self::AnonymousTls => "TLS (anonymous)",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityPolicyError(pub String);

impl VncSecurityPolicy {
    pub fn choose(self, offered: &[u8]) -> Result<u8, SecurityPolicyError> {
        // The ordering is deliberate: encrypted RA2, then RA2ne, then VNCAuth.
        // None is considered only for the explicit allow-none policy.
        const NONE: u8 = 1;
        const AUTH: u8 = 2;
        const RA2: [u8; 2] = [5, 129];
        const RA2NE: [u8; 2] = [6, 130];

        if matches!(self, Self::RequireEncryption) {
            return Err(SecurityPolicyError(
                "encrypted VNC policy is unavailable until VeNCrypt/TLS with server identity verification is implemented".into(),
            ));
        }
        if let Some(kind) = RA2.iter().find(|kind| offered.contains(kind)) {
            return Ok(*kind);
        }
        if let Some(kind) = RA2NE.iter().find(|kind| offered.contains(kind)) {
            return Ok(*kind);
        }
        if offered.contains(&AUTH) {
            return Ok(AUTH);
        }
        if offered.contains(&NONE) && matches!(self, Self::AllowNone) {
            return Ok(NONE);
        }
        if offered.contains(&NONE) {
            return Err(SecurityPolicyError(
                "server offers unauthenticated VNC; enable allow-none explicitly to continue"
                    .into(),
            ));
        }
        Err(SecurityPolicyError("no supported VNC security type".into()))
    }

    /// Choose an outer security type when the caller can upgrade type 18 to
    /// TLS before handing the decrypted stream to the RFB engine.
    pub fn choose_outer(self, offered: &[u8]) -> Result<u8, SecurityPolicyError> {
        const ANONYMOUS_TLS: u8 = 18;

        if matches!(self, Self::RequireEncryption) {
            return Err(SecurityPolicyError(
                "encrypted VNC policy requires authenticated TLS; anonymous RFB TLS does not verify server identity".into(),
            ));
        }
        if offered.contains(&ANONYMOUS_TLS) {
            return Ok(ANONYMOUS_TLS);
        }
        self.choose(offered)
    }

    pub fn allows_v33_none(self) -> bool {
        matches!(self, Self::AllowNone)
    }
}

pub fn security_type_kind(value: u8) -> Option<VncSecurityType> {
    match value {
        1 => Some(VncSecurityType::None),
        2 => Some(VncSecurityType::VncAuth),
        5 | 129 => Some(VncSecurityType::Ra2),
        6 | 130 => Some(VncSecurityType::Ra2ne),
        18 => Some(VncSecurityType::AnonymousTls),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_requires_explicit_opt_in() {
        assert!(VncSecurityPolicy::PreferEncryption.choose(&[1, 2]).is_ok());
        assert_eq!(
            VncSecurityPolicy::PreferEncryption.choose(&[1]),
            Err(SecurityPolicyError(
                "server offers unauthenticated VNC; enable allow-none explicitly to continue"
                    .into()
            ))
        );
        assert_eq!(VncSecurityPolicy::AllowNone.choose(&[1]), Ok(1));
    }

    #[test]
    fn encrypted_is_preferred_over_vncauth() {
        assert_eq!(
            VncSecurityPolicy::PreferEncryption.choose(&[2, 6, 5]),
            Ok(5)
        );
    }

    #[test]
    fn anonymous_tls_is_preferred_for_outer_negotiation() {
        assert_eq!(
            VncSecurityPolicy::PreferEncryption.choose_outer(&[2, 18]),
            Ok(18)
        );
        assert_eq!(
            VncSecurityPolicy::LegacyCompatible.choose_outer(&[18, 2]),
            Ok(18)
        );
    }

    #[test]
    fn require_encryption_rejects_anonymous_tls_identity() {
        let error = VncSecurityPolicy::RequireEncryption
            .choose_outer(&[18, 2])
            .unwrap_err();
        assert!(error.0.contains("does not verify server identity"));
    }

    #[test]
    fn require_encryption_fails_closed() {
        assert!(
            VncSecurityPolicy::RequireEncryption
                .choose(&[1, 2, 6])
                .is_err()
        );
        assert!(
            VncSecurityPolicy::RequireEncryption
                .choose(&[5, 129])
                .unwrap_err()
                .0
                .contains("VeNCrypt/TLS")
        );
    }

    #[test]
    fn clipboard_direction_is_enforced() {
        assert!(!VncClipboardPolicy::Disabled.allows_client_to_server());
        assert!(!VncClipboardPolicy::Disabled.allows_server_to_client());
        assert!(VncClipboardPolicy::ClientToServer.allows_client_to_server());
        assert!(!VncClipboardPolicy::ClientToServer.allows_server_to_client());
        assert!(!VncClipboardPolicy::ServerToClient.allows_client_to_server());
        assert!(VncClipboardPolicy::ServerToClient.allows_server_to_client());
        assert!(VncClipboardPolicy::Bidirectional.allows_client_to_server());
        assert!(VncClipboardPolicy::Bidirectional.allows_server_to_client());
    }
}
