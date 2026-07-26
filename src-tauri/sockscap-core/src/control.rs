//! Versioned control protocol between the Rust engine and the macOS
//! transparent-proxy system extension.
//!
//! ADR-0003 requires more than "the Unix socket exists": caller authentication,
//! a heartbeat, atomic config versioning, and an explicit recovery/degraded
//! state. This module defines the wire messages and the pure request handler
//! ([`ControlServer::handle_request`]) that enforces those properties.
//!
//! The message types and `handle_request` are **transport-agnostic**: they are
//! the authoritative protocol definition. The engine drives them over an
//! `AF_UNIX` socket; the extension can carry the same JSON frames over whatever
//! IPC the Network Extension actually exposes (`sendProviderMessage` /
//! `handleAppMessage`, or a shared-container UDS). Wire format mirrors the
//! Windows helper: one JSON object per line, terminated by `\n`.
//!
//! ## Fail-open contract
//!
//! If the control channel drops, the provider is expected to fall back to
//! DIRECT for every flow. The engine reflects channel health through
//! [`ControlState`] so the provider degrades deterministically rather than
//! guessing.

use serde::{Deserialize, Serialize};

/// Bumped whenever the message shape changes incompatibly. The handshake
/// rejects any peer that does not match, so a stale extension fails fast instead
/// of misinterpreting fields.
pub const CONTROL_PROTOCOL_VERSION: u32 = 1;

/// A request from the extension (client) to the engine (server).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ControlRequest {
    /// First message: negotiate version and authenticate.
    Hello {
        protocol_version: u32,
        token: String,
    },
    /// Apply a new configuration snapshot. Only accepted when strictly newer
    /// than the active version (atomic, monotonic).
    ApplyConfig {
        config_version: u64,
        global: bool,
        selected_app_ids: Vec<String>,
    },
    /// Liveness probe; the server echoes `seq` back in a [`ControlResponse::Pong`].
    Ping { seq: u64 },
    /// Ask for the current engine state.
    Report,
    /// Graceful teardown request.
    Shutdown,
}

/// A response from the engine (server) to the extension (client).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ControlResponse {
    /// Handshake result. `ok=false` carries a human-readable `reason`.
    HelloAck {
        ok: bool,
        protocol_version: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Config accepted; `active_version` is the version now in force.
    ConfigApplied { active_version: u64 },
    /// Liveness reply.
    Pong { seq: u64 },
    /// Current engine state (answer to [`ControlRequest::Report`]).
    Status {
        state: ControlState,
        active_config_version: u64,
        degraded: bool,
    },
    /// A request was rejected (unauthenticated, stale config, wrong version…).
    Error { reason: String },
}

/// Lifecycle of the control connection, surfaced to the provider so it can
/// degrade to DIRECT deterministically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlState {
    /// No successful `Hello` yet — every non-Hello request is rejected.
    Handshaking,
    /// Authenticated, no config applied yet.
    Authenticated,
    /// At least one config version is in force.
    Active,
    /// Channel is up but the engine flagged a problem (heartbeat miss upstream,
    /// pending recovery). Provider should fail open to DIRECT.
    Degraded,
}

/// Serialize a message to a single newline-terminated line.
pub fn encode_line<T: Serialize>(message: &T) -> Result<String, String> {
    let mut line = serde_json::to_string(message).map_err(|e| format!("encode control: {e}"))?;
    line.push('\n');
    Ok(line)
}

/// Parse one line into a message. Blank lines and malformed input return `Err`
/// rather than panicking, so a garbage byte on the socket cannot crash the loop.
pub fn decode_line<T: for<'de> Deserialize<'de>>(line: &str) -> Result<T, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("empty control line".into());
    }
    serde_json::from_str(trimmed).map_err(|e| format!("decode control: {e}"))
}

/// Server side of the control protocol: authenticates the peer, versions
/// config, and answers heartbeats. Holds no sockets — feed it decoded
/// [`ControlRequest`]s and forward its [`ControlResponse`]s.
#[derive(Debug)]
pub struct ControlServer {
    token: String,
    state: ControlState,
    active_config_version: u64,
    global: bool,
    selected_app_ids: Vec<String>,
    degraded: bool,
}

impl ControlServer {
    /// Create a server that will accept a peer presenting `token`.
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            state: ControlState::Handshaking,
            active_config_version: 0,
            global: false,
            selected_app_ids: Vec::new(),
            degraded: false,
        }
    }

    pub fn state(&self) -> ControlState {
        self.state
    }

    pub fn active_config_version(&self) -> u64 {
        self.active_config_version
    }

    /// The selection currently in force (global flag + signing ids).
    pub fn active_selection(&self) -> (bool, &[String]) {
        (self.global, &self.selected_app_ids)
    }

    /// Flag or clear a degraded condition (e.g. a missed upstream heartbeat).
    /// Only meaningful once authenticated; ignored while still handshaking.
    pub fn set_degraded(&mut self, degraded: bool) {
        self.degraded = degraded;
        if self.state == ControlState::Handshaking {
            return;
        }
        self.state = if degraded {
            ControlState::Degraded
        } else if self.active_config_version > 0 {
            ControlState::Active
        } else {
            ControlState::Authenticated
        };
    }

    fn authenticated(&self) -> bool {
        !matches!(self.state, ControlState::Handshaking)
    }

    /// Pure request handler — the heart of the protocol. Deterministic and
    /// side-effect free beyond mutating `self`, so it is exhaustively unit
    /// tested without any I/O.
    pub fn handle_request(&mut self, req: ControlRequest) -> ControlResponse {
        match req {
            ControlRequest::Hello {
                protocol_version,
                token,
            } => self.handle_hello(protocol_version, token),

            // Every other request requires a completed handshake.
            _ if !self.authenticated() => ControlResponse::Error {
                reason: "not authenticated: send Hello first".into(),
            },

            ControlRequest::ApplyConfig {
                config_version,
                global,
                selected_app_ids,
            } => self.handle_apply_config(config_version, global, selected_app_ids),

            ControlRequest::Ping { seq } => ControlResponse::Pong { seq },

            ControlRequest::Report | ControlRequest::Shutdown => ControlResponse::Status {
                state: self.state,
                active_config_version: self.active_config_version,
                degraded: self.degraded,
            },
        }
    }

    fn handle_hello(&mut self, protocol_version: u32, token: String) -> ControlResponse {
        if protocol_version != CONTROL_PROTOCOL_VERSION {
            return ControlResponse::HelloAck {
                ok: false,
                protocol_version: CONTROL_PROTOCOL_VERSION,
                reason: Some(format!(
                    "protocol version mismatch: engine {CONTROL_PROTOCOL_VERSION}, extension {protocol_version}"
                )),
            };
        }
        if token != self.token {
            return ControlResponse::HelloAck {
                ok: false,
                protocol_version: CONTROL_PROTOCOL_VERSION,
                reason: Some("authentication failed".into()),
            };
        }
        // A successful re-Hello is idempotent: keep any config already applied.
        if self.state == ControlState::Handshaking {
            self.state = ControlState::Authenticated;
        }
        ControlResponse::HelloAck {
            ok: true,
            protocol_version: CONTROL_PROTOCOL_VERSION,
            reason: None,
        }
    }

    fn handle_apply_config(
        &mut self,
        config_version: u64,
        global: bool,
        selected_app_ids: Vec<String>,
    ) -> ControlResponse {
        // Monotonic: a stale or replayed version is rejected, and the config
        // already in force is left untouched.
        if config_version <= self.active_config_version {
            return ControlResponse::Error {
                reason: format!(
                    "stale config version {config_version}; active is {}",
                    self.active_config_version
                ),
            };
        }
        self.active_config_version = config_version;
        self.global = global;
        self.selected_app_ids = selected_app_ids;
        if !self.degraded {
            self.state = ControlState::Active;
        }
        ControlResponse::ConfigApplied {
            active_version: self.active_config_version,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "sc-test-token";

    fn hello(server: &mut ControlServer) -> ControlResponse {
        server.handle_request(ControlRequest::Hello {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            token: TOKEN.into(),
        })
    }

    #[test]
    fn handshake_succeeds_with_matching_version_and_token() {
        let mut server = ControlServer::new(TOKEN);
        assert_eq!(server.state(), ControlState::Handshaking);
        let ack = hello(&mut server);
        assert_eq!(
            ack,
            ControlResponse::HelloAck {
                ok: true,
                protocol_version: CONTROL_PROTOCOL_VERSION,
                reason: None,
            }
        );
        assert_eq!(server.state(), ControlState::Authenticated);
    }

    #[test]
    fn handshake_rejects_version_mismatch() {
        let mut server = ControlServer::new(TOKEN);
        let ack = server.handle_request(ControlRequest::Hello {
            protocol_version: CONTROL_PROTOCOL_VERSION + 1,
            token: TOKEN.into(),
        });
        match ack {
            ControlResponse::HelloAck { ok, reason, .. } => {
                assert!(!ok);
                assert!(reason.unwrap().contains("protocol version mismatch"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(server.state(), ControlState::Handshaking);
    }

    #[test]
    fn handshake_rejects_bad_token() {
        let mut server = ControlServer::new(TOKEN);
        let ack = server.handle_request(ControlRequest::Hello {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            token: "wrong".into(),
        });
        match ack {
            ControlResponse::HelloAck { ok, reason, .. } => {
                assert!(!ok);
                assert_eq!(reason.as_deref(), Some("authentication failed"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(server.state(), ControlState::Handshaking);
    }

    #[test]
    fn requests_before_handshake_are_rejected() {
        let mut server = ControlServer::new(TOKEN);
        for req in [
            ControlRequest::Ping { seq: 1 },
            ControlRequest::Report,
            ControlRequest::ApplyConfig {
                config_version: 1,
                global: true,
                selected_app_ids: vec![],
            },
        ] {
            match server.handle_request(req) {
                ControlResponse::Error { reason } => assert!(reason.contains("not authenticated")),
                other => panic!("expected Error, got {other:?}"),
            }
        }
    }

    #[test]
    fn config_versions_are_monotonic() {
        let mut server = ControlServer::new(TOKEN);
        hello(&mut server);

        let applied = server.handle_request(ControlRequest::ApplyConfig {
            config_version: 5,
            global: false,
            selected_app_ids: vec!["com.apple.Safari".into()],
        });
        assert_eq!(
            applied,
            ControlResponse::ConfigApplied { active_version: 5 }
        );
        assert_eq!(server.state(), ControlState::Active);
        assert_eq!(server.active_config_version(), 5);
        assert_eq!(
            server.active_selection(),
            (false, &["com.apple.Safari".to_string()][..])
        );

        let stale = server.handle_request(ControlRequest::ApplyConfig {
            config_version: 5,
            global: true,
            selected_app_ids: vec![],
        });
        match stale {
            ControlResponse::Error { reason } => assert!(reason.contains("stale config version 5")),
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(server.active_config_version(), 5);
        assert_eq!(server.active_selection().0, false);

        let newer = server.handle_request(ControlRequest::ApplyConfig {
            config_version: 6,
            global: true,
            selected_app_ids: vec![],
        });
        assert_eq!(newer, ControlResponse::ConfigApplied { active_version: 6 });
        assert_eq!(server.active_selection().0, true);
    }

    #[test]
    fn ping_echoes_seq() {
        let mut server = ControlServer::new(TOKEN);
        hello(&mut server);
        assert_eq!(
            server.handle_request(ControlRequest::Ping { seq: 42 }),
            ControlResponse::Pong { seq: 42 }
        );
    }

    #[test]
    fn report_reflects_degraded_state() {
        let mut server = ControlServer::new(TOKEN);
        hello(&mut server);
        server.handle_request(ControlRequest::ApplyConfig {
            config_version: 1,
            global: true,
            selected_app_ids: vec![],
        });

        server.set_degraded(true);
        match server.handle_request(ControlRequest::Report) {
            ControlResponse::Status {
                state,
                degraded,
                active_config_version,
            } => {
                assert_eq!(state, ControlState::Degraded);
                assert!(degraded);
                assert_eq!(active_config_version, 1);
            }
            other => panic!("unexpected: {other:?}"),
        }

        server.set_degraded(false);
        assert_eq!(server.state(), ControlState::Active);
    }

    #[test]
    fn degraded_before_config_returns_to_authenticated() {
        let mut server = ControlServer::new(TOKEN);
        hello(&mut server);
        server.set_degraded(true);
        assert_eq!(server.state(), ControlState::Degraded);
        server.set_degraded(false);
        assert_eq!(server.state(), ControlState::Authenticated);
    }

    #[test]
    fn degraded_ignored_while_handshaking() {
        let mut server = ControlServer::new(TOKEN);
        server.set_degraded(true);
        assert_eq!(server.state(), ControlState::Handshaking);
    }

    #[test]
    fn full_handshake_apply_heartbeat_sequence() {
        let mut server = ControlServer::new(TOKEN);
        assert!(matches!(
            hello(&mut server),
            ControlResponse::HelloAck { ok: true, .. }
        ));
        assert!(matches!(
            server.handle_request(ControlRequest::ApplyConfig {
                config_version: 1,
                global: false,
                selected_app_ids: vec!["com.valve.steam".into()],
            }),
            ControlResponse::ConfigApplied { active_version: 1 }
        ));
        for seq in 1..=3 {
            assert_eq!(
                server.handle_request(ControlRequest::Ping { seq }),
                ControlResponse::Pong { seq }
            );
        }
        assert_eq!(server.state(), ControlState::Active);
    }

    #[test]
    fn codec_roundtrips_and_rejects_garbage() {
        let msg = ControlRequest::Hello {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            token: "abc".into(),
        };
        let line = encode_line(&msg).unwrap();
        assert!(line.ends_with('\n'));
        let back: ControlRequest = decode_line(&line).unwrap();
        assert_eq!(back, msg);

        let resp = ControlResponse::Pong { seq: 7 };
        let encoded = encode_line(&resp).unwrap();
        let decoded: ControlResponse = decode_line(encoded.trim_end()).unwrap();
        assert_eq!(decoded, resp);

        assert!(decode_line::<ControlRequest>("").is_err());
        assert!(decode_line::<ControlRequest>("   \n").is_err());
        assert!(decode_line::<ControlRequest>("{not json").is_err());
        assert!(decode_line::<ControlRequest>(r#"{"type":"bogus"}"#).is_err());
    }

    #[test]
    fn wire_format_is_camelcase_for_swift() {
        // The Swift side hand-encodes these; lock the field names so a rename
        // here fails a test rather than silently breaking the extension.
        let line = encode_line(&ControlRequest::Hello {
            protocol_version: 1,
            token: "t".into(),
        })
        .unwrap();
        assert!(line.contains("\"type\":\"hello\""));
        assert!(line.contains("\"protocolVersion\":1"));

        let applied = encode_line(&ControlResponse::ConfigApplied { active_version: 3 }).unwrap();
        assert!(applied.contains("\"type\":\"configApplied\""));
        assert!(applied.contains("\"activeVersion\":3"));
    }
}
