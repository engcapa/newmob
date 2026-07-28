//! Engine-side control channel for the macOS transparent-proxy backend.
//!
//! Two halves:
//!
//! * [`TransparentAdapter`] — mints the loopback control token, remembers the
//!   control-socket path and the app selection, and submits system-extension
//!   activation via [`super::activation`]. Activation is macOS-gated and stays
//!   fail-fast: no bundle ⇒ [`activation::ENTITLEMENT_UNAVAILABLE`].
//! * [`ControlServerHandle`] — an `AF_UNIX` server loop that drives the pure
//!   [`ControlServer`] from [`super::control`], speaking the same
//!   newline-delimited JSON as the Windows helper. It exposes a readiness signal
//!   that flips once a provider authenticates, so the engine can wait for the
//!   extension to actually connect before reporting the plane Active (and fall
//!   back to system-proxy on timeout).
//!
//! Built on **all Unix** (needs only tokio Unix sockets), so the protocol loop
//! is exercised by the tests below on this host; only activation is macOS-only.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::activation;
use super::control::{ControlRequest, ControlResponse, ControlServer, decode_line, encode_line};
use super::decision::SelectedApps;

/// Re-exported for callers that branch on the infrastructure gap.
pub use super::activation::ENTITLEMENT_UNAVAILABLE;

/// Handle to a would-be transparent capture session: identity + control config.
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

    /// Submit activation of the Network Extension system extension.
    ///
    /// macOS with a bundled extension: submits `OSSystemExtensionRequest` (the
    /// provider then connects to [`control_socket`](Self::control_socket) and
    /// authenticates with [`token`](Self::token)). No bundle / other OS: returns
    /// [`ENTITLEMENT_UNAVAILABLE`], keeping the preflight fail-fast contract.
    pub fn activate(&self) -> Result<(), String> {
        activation::request_activation(activation::EXTENSION_IDENTIFIER)
    }
}

/// A short random token for the loopback control channel. The Unix socket is
/// already filesystem-permission scoped; the token defends against another local
/// process that can reach the socket path.
fn mint_token() -> String {
    format!("sc-ne-{}", uuid::Uuid::new_v4().simple())
}

/// A running control-channel server. Dropping it is inert; call [`Self::stop`]
/// so the listener and its socket file are cleaned up deterministically.
pub struct ControlServerHandle {
    socket_path: PathBuf,
    stop_tx: watch::Sender<bool>,
    ready_rx: watch::Receiver<bool>,
    task: JoinHandle<()>,
}

impl ControlServerHandle {
    /// Bind `socket_path` and serve the control protocol until [`Self::stop`].
    ///
    /// A stale socket file (unclean shutdown) is removed first so the bind
    /// succeeds. Each accepted connection gets a fresh [`ControlServer`] seeded
    /// with `token`; the shared readiness flag flips to `true` the first time any
    /// connection authenticates.
    pub fn bind(socket_path: impl Into<PathBuf>, token: impl Into<String>) -> Result<Self, String> {
        let socket_path = socket_path.into();
        let token = token.into();
        // Best-effort: a leftover socket file would make bind fail with EADDRINUSE.
        let _ = std::fs::remove_file(&socket_path);
        if let Some(parent) = socket_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create control socket dir {}: {e}", parent.display()))?;
        }
        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("bind control socket {}: {e}", socket_path.display()))?;

        let (stop_tx, stop_rx) = watch::channel(false);
        let (ready_tx, ready_rx) = watch::channel(false);
        let token = Arc::new(token);
        let task = tokio::spawn(accept_loop(listener, token, stop_rx, ready_tx));

        Ok(Self {
            socket_path,
            stop_tx,
            ready_rx,
            task,
        })
    }

    /// A receiver that is `true` once a provider has authenticated. Callers await
    /// `changed()` with a timeout to bound how long they wait for the extension.
    pub fn ready_rx(&self) -> watch::Receiver<bool> {
        self.ready_rx.clone()
    }

    /// Whether a provider has authenticated at least once.
    pub fn is_ready(&self) -> bool {
        *self.ready_rx.borrow()
    }

    /// Stop the server loop and remove the socket file. Idempotent.
    pub async fn stop(self) {
        let _ = self.stop_tx.send(true);
        // Wake the blocked `accept()` by connecting to ourselves; ignore errors
        // (the loop may already be exiting).
        let _ = UnixStream::connect(&self.socket_path).await;
        let mut task = self.task;
        tokio::select! {
            _ = &mut task => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                task.abort();
                let _ = task.await;
            }
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

async fn accept_loop(
    listener: UnixListener,
    token: Arc<String>,
    mut stop_rx: watch::Receiver<bool>,
    ready_tx: watch::Sender<bool>,
) {
    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        if *stop_rx.borrow() {
                            break;
                        }
                        let server = ControlServer::new(token.as_str());
                        let ready_tx = ready_tx.clone();
                        // One provider connection at a time is expected, but serve
                        // each on its own task so a slow peer cannot wedge accept.
                        tokio::spawn(async move {
                            if let Err(error) = serve_connection(stream, server, ready_tx).await {
                                tracing::warn!("sockscap control connection: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        if *stop_rx.borrow() {
                            break;
                        }
                        tracing::warn!("sockscap control accept failed: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

/// Serve one control connection: decode a line, drive the pure state machine,
/// write the response. A decode error is answered with [`ControlResponse::Error`]
/// and the channel stays alive; `Shutdown` ends the connection after replying.
///
/// After each handled request the connection's authentication state is checked
/// and `ready_tx` is set once it becomes authenticated, so the engine learns the
/// extension is live the moment the handshake completes.
async fn serve_connection(
    stream: UnixStream,
    mut server: ControlServer,
    ready_tx: watch::Sender<bool>,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read control line: {e}"))?;
        if read == 0 {
            // Peer closed: fail-open is the provider's job, nothing to do here.
            return Ok(());
        }
        let (response, shutting_down) = match decode_line::<ControlRequest>(&line) {
            Ok(req) => {
                let shutting_down = matches!(req, ControlRequest::Shutdown);
                (server.handle_request(req), shutting_down)
            }
            Err(reason) => (ControlResponse::Error { reason }, false),
        };
        write_response(&mut writer, &response).await?;
        // Announce readiness as soon as the peer is past the handshake.
        if !matches!(server.state(), super::control::ControlState::Handshaking)
            && !*ready_tx.borrow()
        {
            let _ = ready_tx.send(true);
        }
        if shutting_down {
            return Ok(());
        }
    }
}

async fn write_response(
    writer: &mut (impl AsyncWriteExt + Unpin),
    resp: &ControlResponse,
) -> Result<(), String> {
    let line = encode_line(resp)?;
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write control response: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("flush control: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::transparent::control::CONTROL_PROTOCOL_VERSION;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn minted_tokens_are_unique_and_prefixed() {
        let a = TransparentAdapter::new("/tmp/a.sock", SelectedApps::default());
        let b = TransparentAdapter::new("/tmp/b.sock", SelectedApps::default());
        assert!(a.token().starts_with("sc-ne-"));
        assert_ne!(a.token(), b.token());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn activation_without_a_bundle_reports_the_infra_gap() {
        let adapter = TransparentAdapter::new("/tmp/sc.sock", SelectedApps::default());
        let err = adapter.activate().unwrap_err();
        assert!(err.contains("Network Extension"));
    }

    /// Connect to a bound control server as the extension would, and return the
    /// reader/writer split so a test can drive the protocol.
    async fn connect(
        path: &Path,
    ) -> (
        BufReader<tokio::net::unix::OwnedReadHalf>,
        tokio::net::unix::OwnedWriteHalf,
    ) {
        let stream = UnixStream::connect(path).await.unwrap();
        let (r, w) = stream.into_split();
        (BufReader::new(r), w)
    }

    #[tokio::test]
    async fn handshake_flips_readiness_and_shutdown_closes() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let handle = ControlServerHandle::bind(&sock, "tok").unwrap();
        let mut ready = handle.ready_rx();
        assert!(!*ready.borrow());

        let (mut reader, mut writer) = connect(&sock).await;
        let hello = format!(
            "{{\"type\":\"hello\",\"protocolVersion\":{CONTROL_PROTOCOL_VERSION},\"token\":\"tok\"}}\n"
        );
        writer.write_all(hello.as_bytes()).await.unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"helloAck\""));
        assert!(line.contains("\"ok\":true"));

        // Readiness becomes true once authenticated.
        ready.changed().await.unwrap();
        assert!(*ready.borrow());
        assert!(handle.is_ready());

        // A garbage line is answered with an error but keeps the channel alive.
        writer.write_all(b"garbage\n").await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"error\""));

        // ApplyConfig is accepted and versioned.
        writer
            .write_all(b"{\"type\":\"applyConfig\",\"configVersion\":1,\"global\":true,\"selectedAppIds\":[]}\n")
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"configApplied\""));

        writer
            .write_all(b"{\"type\":\"shutdown\"}\n")
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"status\""));

        handle.stop().await;
        // Socket file is removed on stop.
        assert!(!sock.exists());
    }

    #[tokio::test]
    async fn a_bad_token_never_flips_readiness() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let handle = ControlServerHandle::bind(&sock, "right-token").unwrap();

        let (mut reader, mut writer) = connect(&sock).await;
        let hello = format!(
            "{{\"type\":\"hello\",\"protocolVersion\":{CONTROL_PROTOCOL_VERSION},\"token\":\"wrong\"}}\n"
        );
        writer.write_all(hello.as_bytes()).await.unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"ok\":false"));
        assert!(!handle.is_ready());

        handle.stop().await;
    }

    #[tokio::test]
    async fn a_stale_socket_file_is_replaced_on_bind() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        // Simulate an unclean shutdown leaving a socket file behind.
        std::fs::write(&sock, b"stale").unwrap();
        let handle = ControlServerHandle::bind(&sock, "tok").unwrap();
        // Bind succeeded and the server is reachable.
        let _ = connect(&sock).await;
        handle.stop().await;
    }
}
