//! macOS transparent-proxy capture adapter (`NETransparentProxyProvider`).
//!
//! This is the seam ADR-0003 calls "ready for a macOS adapter that speaks the
//! provider control protocol". Two halves:
//!
//! * [`TransparentAdapter::activate`] — the part that needs the Apple Network
//!   Extension entitlement, a Developer ID, an Xcode system-extension target,
//!   and notarization. None of that can be produced by `cargo build`, so this
//!   returns a clear error instead of pretending to succeed. That keeps the
//!   preflight fail-fast contract: the engine never reports Active for a
//!   capture plane that is not actually installed.
//! * [`serve_control`] — the control-protocol server loop over an
//!   `AF_UNIX` socket. This half is real and testable; it drives the pure
//!   [`ControlServer`] from [`super::control`] and speaks the same
//!   newline-delimited JSON as the Windows helper.
//!
//! Compiled only on macOS; other platforms never build the adapter, only the
//! platform-independent [`decision`](super::decision) and
//! [`control`](super::control) modules.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use super::control::{ControlRequest, ControlResponse, ControlServer, decode_line, encode_line};
use super::decision::SelectedApps;

/// Handle to a would-be transparent capture session.
pub struct TransparentAdapter {
    control_socket: PathBuf,
    token: String,
    selected: SelectedApps,
}

impl TransparentAdapter {
    /// Prepare an adapter bound to a control socket path and a freshly minted
    /// auth token. Does not touch the network or the system extension yet.
    pub fn new(control_socket: impl Into<PathBuf>, selected: SelectedApps) -> Self {
        Self {
            control_socket: control_socket.into(),
            token: mint_token(),
            selected,
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn control_socket(&self) -> &Path {
        &self.control_socket
    }

    pub fn selected(&self) -> &SelectedApps {
        &self.selected
    }

    /// Request activation of the Network Extension system extension.
    ///
    /// Always fails today: activating a `NETransparentProxyProvider` requires an
    /// entitlement + signed, notarized system-extension bundle that the Rust
    /// build cannot produce. Wiring `OSSystemExtensionRequest` here is the
    /// remaining Phase 6 step once that infrastructure exists.
    pub fn activate(&self) -> Result<(), String> {
        Err(ENTITLEMENT_UNAVAILABLE.into())
    }
}

/// The exact reason activation is blocked — surfaced to the UI unchanged so the
/// user understands this is an infrastructure gap, not a bug.
pub const ENTITLEMENT_UNAVAILABLE: &str = "macOS transparent capture is unavailable: it needs a Network Extension \
     system extension (com.apple.developer.networking.networkextension), a \
     Developer ID signing identity, and notarization. Until that bundle ships, \
     use the system-proxy backend (Global scope).";

/// A short random token for the loopback control channel. The Unix socket is
/// already filesystem-permission scoped; the token defends against another
/// local process that can reach the socket path.
fn mint_token() -> String {
    format!("sc-ne-{}", uuid::Uuid::new_v4().simple())
}

/// Accept one control connection and serve requests until the peer disconnects
/// or asks to shut down. Blocking; run on a dedicated thread. `token` must be
/// the value handed to the extension via the provider configuration.
///
/// Returns when the connection closes. Any per-line decode error is answered
/// with a [`ControlResponse::Error`] and the loop continues, so a stray byte
/// cannot tear down a healthy channel.
pub fn serve_control(listener: &UnixListener, token: &str) -> Result<(), String> {
    let (stream, _addr) = listener
        .accept()
        .map_err(|e| format!("accept control connection: {e}"))?;
    serve_control_stream(stream, ControlServer::new(token))
}

fn serve_control_stream(stream: UnixStream, mut server: ControlServer) -> Result<(), String> {
    let mut writer = stream
        .try_clone()
        .map_err(|e| format!("clone control stream: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| format!("read control line: {e}"))?;
        if read == 0 {
            // Peer closed: fail-open is the provider's job, nothing to do here.
            return Ok(());
        }
        let response = match decode_line::<ControlRequest>(&line) {
            Ok(req) => {
                let shutting_down = matches!(req, ControlRequest::Shutdown);
                let resp = server.handle_request(req);
                write_response(&mut writer, &resp)?;
                if shutting_down {
                    return Ok(());
                }
                continue;
            }
            Err(reason) => ControlResponse::Error { reason },
        };
        write_response(&mut writer, &response)?;
    }
}

fn write_response(writer: &mut UnixStream, resp: &ControlResponse) -> Result<(), String> {
    let line = encode_line(resp)?;
    writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("write control response: {e}"))?;
    writer.flush().map_err(|e| format!("flush control: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::transparent::control::CONTROL_PROTOCOL_VERSION;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    #[test]
    fn activation_fails_with_infrastructure_reason() {
        let adapter = TransparentAdapter::new("/tmp/sc-test.sock", SelectedApps::default());
        let err = adapter.activate().unwrap_err();
        assert!(err.contains("Network Extension"));
        assert!(err.contains("Developer ID"));
    }

    #[test]
    fn minted_tokens_are_unique_and_prefixed() {
        let a = TransparentAdapter::new("/tmp/a.sock", SelectedApps::default());
        let b = TransparentAdapter::new("/tmp/b.sock", SelectedApps::default());
        assert!(a.token().starts_with("sc-ne-"));
        assert_ne!(a.token(), b.token());
    }

    #[test]
    fn control_stream_serves_handshake_and_shutdown() {
        // A socketpair stands in for an accepted connection; drive the server
        // side on a thread and act as the extension on this side.
        let (client, server_side) = UnixStream::pair().unwrap();
        let handle = std::thread::spawn(move || {
            serve_control_stream(server_side, ControlServer::new("tok"))
        });

        let mut writer = client.try_clone().unwrap();
        let mut reader = BufReader::new(client);

        let hello = format!(
            "{{\"type\":\"hello\",\"protocolVersion\":{CONTROL_PROTOCOL_VERSION},\"token\":\"tok\"}}\n"
        );
        writer.write_all(hello.as_bytes()).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"helloAck\""));
        assert!(line.contains("\"ok\":true"));

        // Garbage line gets an Error but keeps the channel alive.
        writer.write_all(b"garbage\n").unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"error\""));

        writer
            .write_all(b"{\"type\":\"ping\",\"seq\":9}\n")
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"pong\""));
        assert!(line.contains("\"seq\":9"));

        writer.write_all(b"{\"type\":\"shutdown\"}\n").unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"status\""));

        handle.join().unwrap().unwrap();
    }
}
