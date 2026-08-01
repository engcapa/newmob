//! Versioned local management protocol between Taomni and its macOS Redirector
//! bridge process. The transport is newline-delimited JSON over child stdio;
//! Redirector's own protobuf IPC remains isolated inside the bridge.

use serde::{Deserialize, Serialize};

pub const BRIDGE_PROTOCOL_VERSION: u32 = 1;
pub const MAX_MANAGEMENT_LINE: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum BridgeCommand {
    Apply {
        version: u32,
        request_id: u64,
        session_id: String,
        generation: u64,
        actions: Vec<String>,
    },
    Ping {
        version: u32,
        request_id: u64,
        session_id: String,
        generation: u64,
    },
    Stop {
        version: u32,
        request_id: u64,
        session_id: String,
        generation: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum BridgeEvent {
    ControlReady {
        version: u32,
        provider_pid: u32,
    },
    Applied {
        version: u32,
        request_id: u64,
        session_id: String,
        generation: u64,
    },
    Pong {
        version: u32,
        request_id: u64,
        session_id: String,
        generation: u64,
    },
    Stopped {
        version: u32,
        request_id: u64,
        session_id: String,
        generation: u64,
    },
    Error {
        version: u32,
        request_id: Option<u64>,
        message: String,
    },
}

impl BridgeCommand {
    pub fn version(&self) -> u32 {
        match self {
            Self::Apply { version, .. }
            | Self::Ping { version, .. }
            | Self::Stop { version, .. } => *version,
        }
    }
}

pub fn encode_line<T: Serialize>(value: &T) -> Result<String, String> {
    let mut encoded = serde_json::to_string(value).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_MANAGEMENT_LINE {
        return Err(format!(
            "Redirector bridge management message exceeds {MAX_MANAGEMENT_LINE} bytes"
        ));
    }
    encoded.push('\n');
    Ok(encoded)
}

pub fn decode_line<T: for<'de> Deserialize<'de>>(line: &str) -> Result<T, String> {
    if line.len() > MAX_MANAGEMENT_LINE {
        return Err(format!(
            "Redirector bridge management message exceeds {MAX_MANAGEMENT_LINE} bytes"
        ));
    }
    serde_json::from_str(line.trim_end()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_round_trip_is_versioned() {
        let command = BridgeCommand::Apply {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: 42,
            session_id: "session-1".into(),
            generation: 1,
            actions: vec!["!/Applications/Taomni.app/".into()],
        };
        let line = encode_line(&command).unwrap();
        let decoded: BridgeCommand = decode_line(&line).unwrap();
        assert_eq!(decoded, command);
        assert_eq!(decoded.version(), BRIDGE_PROTOCOL_VERSION);
    }

    #[test]
    fn oversized_management_message_is_rejected() {
        let line = "x".repeat(MAX_MANAGEMENT_LINE + 1);
        assert!(decode_line::<BridgeCommand>(&line).is_err());
    }
}
