//! RDP ↔ WebSocket relay.
//!
//! Mirror of `crate::vnc::ws`: bind a loopback listener on a dynamic port,
//! accept one WebSocket from the React canvas, then drive an RDP session in
//! the background. Bytes flow over a binary WS protocol with a one-byte
//! channel tag in front of every frame so display, audio, cursor,
//! clipboard, and drive-redirect events share the same socket.
//!
//! ```text
//! 0           1                                              N
//! +-----------+----------------------------------------------+
//! | tag (u8)  | payload (channel-specific)                   |
//! +-----------+----------------------------------------------+
//! ```
//!
//! See [`channel`] constants for the tag values.
//!
//! The connection itself is a three-step state machine:
//!
//! 1. Open a direct TCP, HTTP/SOCKS5 proxy, or RD Gateway tunnel via
//!    [`crate::rdp::transport::open_transport`].
//! 2. Bind the loopback WebSocket listener so the frontend can receive
//!    status updates while RDP authentication continues.
//! 3. Hand the TCP stream to [`crate::rdp::session::start_ironrdp_session`],
//!    which owns X.224 negotiation, TLS, CredSSP/NLA, active-stage display
//!    decoding, and input encoding.

use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::{HeaderValue, StatusCode, header};
use uuid::Uuid;

use crate::rdp::RdpOptions;
use crate::rdp::frame::TileHeader;
use crate::rdp::input::{KeyEvent, PointerEvent, PointerWheelEvent};
use crate::rdp::session::{
    RdpSessionConfig, RdpSessionHandle, SessionOutput, start_ironrdp_session,
};
use crate::rdp::transport::open_transport;
use crate::terminal::network::NetworkSettings;

const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const WS_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Wire-protocol channel tags for the binary WS frames.
pub mod channel {
    pub const FRAME: u8 = 0; // bitmap tile (display)
    pub const AUDIO: u8 = 1; // PCM audio
    pub const CURSOR: u8 = 2; // cursor shape change
    pub const CLIPBOARD_OFFER: u8 = 3; // text/file offer metadata
    pub const CLIPBOARD_DATA: u8 = 4; // requested clipboard contents
    pub const STATUS: u8 = 5; // text status / error JSON

    pub const FRAME_END: u8 = 6; // sentinel: server flushed a batch

    /// Inbound (browser → relay) tags.
    pub const IN_PING: u8 = 0;
    pub const IN_ACK: u8 = 1;
    pub const IN_KEY: u8 = 2;
    pub const IN_POINTER: u8 = 3;
    pub const IN_RESIZE: u8 = 4;
    pub const IN_WHEEL: u8 = 5;
    pub const IN_REFRESH: u8 = 6; // request a full-desktop redraw
}

#[derive(Debug)]
pub enum RdpControl {
    Key(KeyEvent),
    Pointer(PointerEvent),
    Wheel(PointerWheelEvent),
    Resize {
        width: u16,
        height: u16,
    },
    /// Ask the server to redraw the whole desktop (TS_REFRESH_RECT_PDU).
    Refresh,
    ClipboardOffer {
        formats: u32,
    },
    ClipboardData {
        format: u32,
        data: Vec<u8>,
    },
    ClipboardFiles {
        paths: Vec<String>,
    },
    Ack,
    Disconnect,
}

pub enum WsOutgoing {
    Frame(Vec<u8>),
    Text(String),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsIncomingText {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "ack")]
    Ack,
    #[serde(rename = "clipboard")]
    Clipboard { text: String },
    #[serde(rename = "clipboard_files")]
    ClipboardFiles { paths: Vec<String> },
    #[serde(rename = "resize")]
    Resize { width: u16, height: u16 },
    #[serde(rename = "refresh")]
    Refresh,
    #[serde(rename = "disconnect")]
    Disconnect,
}

pub struct RdpSession {
    pub control_tx: UnboundedSender<RdpControl>,
    pub ws_port: u16,
    pub ws_token: String,
    pub cancel: CancellationToken,
}

pub struct RdpSpawnConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub options: RdpOptions,
    pub network: Option<NetworkSettings>,
}

pub async fn spawn_rdp_relay(cfg: RdpSpawnConfig) -> Result<RdpSession, String> {
    let cancel = CancellationToken::new();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    // 1. Transport. Direct TCP, HTTP/SOCKS5 proxy, and RD Gateway all
    // converge on the same async stream abstraction; IronRDP owns all
    // RDP-layer negotiation after this point.
    let transport = open_transport(
        &cfg.host,
        cfg.port,
        cfg.network.as_ref(),
        cfg.options.gateway.as_ref(),
    )
    .await?;

    // 2. Bind WS listener before the IronRDP worker finishes authentication so
    // the frontend can show granular status updates.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("rdp: bind WS listener: {}", e))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| format!("rdp: local_addr: {}", e))?
        .port();

    let (control_tx, control_rx) = mpsc::unbounded_channel::<RdpControl>();
    let (ws_out_tx, ws_out_rx) = mpsc::unbounded_channel::<WsOutgoing>();

    // 3. Hand off to IronRDP: connector, TLS, CredSSP, active-stage display
    //    decoding, and input all run behind this handle.
    let session = start_ironrdp_session(RdpSessionConfig {
        stream: transport.stream,
        local_addr: transport.local_addr,
        host: cfg.host.clone(),
        port: cfg.port,
        username: cfg.username.clone(),
        password: cfg.password.clone(),
        options: cfg.options.clone(),
        network: cfg.network.clone(),
    });

    let cancel_clone = cancel.clone();
    let cancel_guard = cancel.clone();
    let control_tx_for_relay = control_tx.clone();
    let ws_token_for_relay = ws_token.clone();
    tokio::spawn(async move {
        if let Err(e) = run_relay(
            listener,
            session,
            ws_out_tx,
            ws_out_rx,
            control_tx_for_relay,
            control_rx,
            cancel_clone,
            ws_token_for_relay,
        )
        .await
        {
            tracing::error!("RDP relay error: {}", e);
        }
        // Always fire the cancellation token once the relay loop ends — even
        // on the early-return error paths — so the session-map reaper in
        // `rdp_connect` wakes up and drops the now-dead `RdpSession` entry.
        cancel_guard.cancel();
    });

    Ok(RdpSession {
        control_tx,
        ws_port,
        ws_token,
        cancel,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_relay(
    listener: TcpListener,
    mut session: RdpSessionHandle,
    ws_out_tx: UnboundedSender<WsOutgoing>,
    mut ws_out_rx: UnboundedReceiver<WsOutgoing>,
    _control_tx: UnboundedSender<RdpControl>,
    mut control_rx: UnboundedReceiver<RdpControl>,
    cancel: CancellationToken,
    ws_token: String,
) -> Result<(), String> {
    let ws_stream = accept_authorized_ws(&listener, &ws_token, &cancel).await?;
    let (mut ws_sink, ws_reader) = ws_stream.split();
    let last_seen = std::sync::Arc::new(AsyncMutex::new(Instant::now()));

    // Pump outgoing → WS sink.
    let ws_write = tokio::spawn(async move {
        while let Some(out) = ws_out_rx.recv().await {
            let msg = match out {
                WsOutgoing::Frame(b) => Message::Binary(b.into()),
                WsOutgoing::Text(t) => Message::Text(t.into()),
            };
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Read WS → control_tx.
    let last_seen_read = last_seen.clone();
    let cancel_read = cancel.clone();
    let ctrl = _control_tx.clone();
    let ws_read = tokio::spawn(async move {
        let mut reader = ws_reader;
        while let Some(Ok(msg)) = reader.next().await {
            if cancel_read.is_cancelled() {
                break;
            }
            *last_seen_read.lock().await = Instant::now();
            match msg {
                Message::Binary(bytes) => {
                    if let Some(c) = parse_binary_control(&bytes) {
                        let _ = ctrl.send(c);
                    }
                }
                Message::Text(text) => {
                    if let Ok(parsed) = serde_json::from_str::<WsIncomingText>(&text) {
                        match parsed {
                            WsIncomingText::Ping | WsIncomingText::Ack => {
                                let _ = ctrl.send(RdpControl::Ack);
                            }
                            WsIncomingText::Clipboard { text } => {
                                let _ = ctrl.send(RdpControl::ClipboardData {
                                    format: 13, // CF_UNICODETEXT
                                    data: text.into_bytes(),
                                });
                            }
                            WsIncomingText::ClipboardFiles { paths } => {
                                let _ = ctrl.send(RdpControl::ClipboardFiles { paths });
                            }
                            WsIncomingText::Resize { width, height } => {
                                let _ = ctrl.send(RdpControl::Resize { width, height });
                            }
                            WsIncomingText::Refresh => {
                                let _ = ctrl.send(RdpControl::Refresh);
                            }
                            WsIncomingText::Disconnect => {
                                let _ = ctrl.send(RdpControl::Disconnect);
                                break;
                            }
                        }
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.send(RdpControl::Disconnect);
                    break;
                }
                _ => {}
            }
        }
    });

    // Drive the session: forward display/status output to the WebSocket and
    // pass browser controls into IronRDP.
    let session_drive = tokio::spawn({
        let cancel = cancel.clone();
        let ws_out_clone = ws_out_tx.clone();
        async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    msg = control_rx.recv() => match msg {
                        Some(RdpControl::Disconnect) => { cancel.cancel(); break; }
                        Some(other) => {
                            if let Err(e) = session.dispatch_control(other).await {
                                let json = serde_json::json!({
                                    "type": "error",
                                    "code": "control-failed",
                                    "message": e,
                                })
                                .to_string();
                                let _ = ws_out_clone.send(WsOutgoing::Text(json));
                            }
                        }
                        None => break,
                    },
                    out = session.next_outgoing() => match out {
                        Some(SessionOutput::Channel { tag, payload }) => {
                            let mut frame = Vec::with_capacity(1 + payload.len());
                            frame.push(tag);
                            frame.extend_from_slice(&payload);
                            let _ = ws_out_clone.send(WsOutgoing::Frame(frame));
                        }
                        Some(SessionOutput::Text(text)) => {
                            let _ = ws_out_clone.send(WsOutgoing::Text(text));
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Idle watchdog.
    let watchdog_cancel = cancel.clone();
    let watchdog_last_seen = last_seen.clone();
    let idle_watch = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(WS_IDLE_CHECK_INTERVAL);
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let elapsed = watchdog_last_seen.lock().await.elapsed();
                    if elapsed > WS_IDLE_TIMEOUT {
                        tracing::warn!(
                            "RDP relay idle for {:?} (> {:?}); disconnecting",
                            elapsed, WS_IDLE_TIMEOUT
                        );
                        watchdog_cancel.cancel();
                        break;
                    }
                }
                _ = watchdog_cancel.cancelled() => break,
            }
        }
    });

    tokio::select! {
        r = ws_write => { if let Err(e) = r { tracing::error!("ws_write: {}", e); } }
        r = ws_read => { if let Err(e) = r { tracing::error!("ws_read: {}", e); } }
        r = session_drive => { if let Err(e) = r { tracing::error!("session_drive: {}", e); } }
        r = idle_watch => { if let Err(e) = r { tracing::error!("idle_watch: {}", e); } }
    }
    cancel.cancel();
    Ok(())
}

async fn accept_authorized_ws(
    listener: &TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-rdp.{ws_token}");
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return Err(format!("rdp accept: {e}")),
                Err(_) => {
                    tracing::warn!("RDP WS accept timed out after {:?}", WS_ACCEPT_TIMEOUT);
                    return Err("RDP WebSocket authorization timed out".to_string());
                }
            },
            _ = cancel.cancelled() => return Err("RDP relay cancelled".to_string()),
        };
        let protocol = expected_protocol.clone();
        let callback = move |request: &Request, mut response: Response| {
            if !request_has_authorized_origin(request) || !request_has_protocol(request, &protocol)
            {
                let mut rejection = ErrorResponse::new(Some("forbidden".to_string()));
                *rejection.status_mut() = StatusCode::FORBIDDEN;
                return Err(rejection);
            }
            response.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocol).expect("generated WS protocol is valid"),
            );
            Ok(response)
        };
        match tokio_tungstenite::accept_hdr_async(stream, callback).await {
            Ok(ws) => return Ok(ws),
            Err(e) => tracing::warn!("rejected unauthorized RDP WebSocket attempt: {e}"),
        }
    }
}

fn request_has_protocol(request: &Request, expected: &str) -> bool {
    request
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|item| item.trim() == expected))
}

fn request_has_authorized_origin(request: &Request) -> bool {
    request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_authorized_origin)
}

fn is_authorized_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    if cfg!(debug_assertions) {
        return [
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://localhost:5000",
            "http://127.0.0.1:5000",
        ]
        .contains(&origin);
    }
    false
}

/// Decode a binary control frame from the canvas. Layout:
///
/// ```text
/// tag=IN_KEY:    [tag, down, scan_lo, scan_hi]
/// tag=IN_POINTER:[tag, buttons, x_hi, x_lo, y_hi, y_lo]
/// tag=IN_RESIZE: [tag, w_hi, w_lo, h_hi, h_lo]
/// tag=IN_WHEEL:  [tag, orientation, x_hi, x_lo, y_hi, y_lo, units_hi, units_lo]
/// tag=IN_PING:   [tag]
/// tag=IN_ACK:    [tag]
/// tag=IN_REFRESH:[tag]
/// ```
pub fn parse_binary_control(bytes: &[u8]) -> Option<RdpControl> {
    if bytes.is_empty() {
        return None;
    }
    match bytes[0] {
        channel::IN_PING | channel::IN_ACK => Some(RdpControl::Ack),
        channel::IN_REFRESH => Some(RdpControl::Refresh),
        channel::IN_KEY if bytes.len() >= 4 => {
            let down = bytes[1] != 0;
            let scancode = u16::from_be_bytes([bytes[2], bytes[3]]);
            Some(RdpControl::Key(KeyEvent { down, scancode }))
        }
        channel::IN_POINTER if bytes.len() >= 6 => {
            let buttons = bytes[1];
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            Some(RdpControl::Pointer(PointerEvent { x, y, buttons }))
        }
        channel::IN_RESIZE if bytes.len() >= 5 => {
            let w = u16::from_be_bytes([bytes[1], bytes[2]]);
            let h = u16::from_be_bytes([bytes[3], bytes[4]]);
            Some(RdpControl::Resize {
                width: w,
                height: h,
            })
        }
        channel::IN_WHEEL if bytes.len() >= 8 => {
            let is_vertical = bytes[1] == 0;
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            let rotation_units = i16::from_be_bytes([bytes[6], bytes[7]]);
            (rotation_units != 0).then_some(RdpControl::Wheel(PointerWheelEvent {
                x,
                y,
                is_vertical,
                rotation_units,
            }))
        }
        _ => None,
    }
}

/// Helper for callers that want to embed a tile header in an outgoing
/// FRAME-channel message. Header layout (big-endian): x, y, w, h.
pub fn frame_payload_with_header(header: TileHeader, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + rgba.len());
    out.extend_from_slice(&header.x.to_be_bytes());
    out.extend_from_slice(&header.y.to_be_bytes());
    out.extend_from_slice(&header.w.to_be_bytes());
    out.extend_from_slice(&header.h.to_be_bytes());
    out.extend_from_slice(rgba);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_key_event() {
        let buf = [channel::IN_KEY, 1, 0x00, 0x1c]; // Enter
        match parse_binary_control(&buf).unwrap() {
            RdpControl::Key(k) => {
                assert!(k.down);
                assert_eq!(k.scancode, 0x001c);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_pointer_event() {
        let buf = [channel::IN_POINTER, 0x01, 0x01, 0x90, 0x01, 0x2c];
        match parse_binary_control(&buf).unwrap() {
            RdpControl::Pointer(p) => {
                assert_eq!(p.buttons, 1);
                assert_eq!(p.x, 0x0190);
                assert_eq!(p.y, 0x012c);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_resize() {
        let buf = [channel::IN_RESIZE, 0x07, 0x80, 0x04, 0x38];
        match parse_binary_control(&buf).unwrap() {
            RdpControl::Resize { width, height } => {
                assert_eq!(width, 1920);
                assert_eq!(height, 1080);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_wheel() {
        let buf = [channel::IN_WHEEL, 0x00, 0x01, 0x90, 0x01, 0x2c, 0xff, 0x88];
        match parse_binary_control(&buf).unwrap() {
            RdpControl::Wheel(w) => {
                assert!(w.is_vertical);
                assert_eq!(w.x, 0x0190);
                assert_eq!(w.y, 0x012c);
                assert_eq!(w.rotation_units, -120);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_ping_and_ack_are_ack() {
        assert!(matches!(
            parse_binary_control(&[channel::IN_PING]),
            Some(RdpControl::Ack)
        ));
        assert!(matches!(
            parse_binary_control(&[channel::IN_ACK]),
            Some(RdpControl::Ack)
        ));
    }

    #[test]
    fn parse_refresh() {
        assert!(matches!(
            parse_binary_control(&[channel::IN_REFRESH]),
            Some(RdpControl::Refresh)
        ));
    }

    #[test]
    fn parse_truncated_returns_none() {
        assert!(parse_binary_control(&[channel::IN_KEY]).is_none());
        assert!(parse_binary_control(&[channel::IN_POINTER, 1]).is_none());
        assert!(parse_binary_control(&[channel::IN_WHEEL, 0]).is_none());
        assert!(parse_binary_control(&[channel::IN_WHEEL, 0, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(parse_binary_control(&[]).is_none());
    }

    #[test]
    fn frame_payload_layout() {
        let h = TileHeader {
            x: 10,
            y: 20,
            w: 30,
            h: 40,
        };
        let rgba = vec![0xff, 0x00, 0x00, 0xff];
        let p = frame_payload_with_header(h, &rgba);
        assert_eq!(&p[0..2], &10u16.to_be_bytes());
        assert_eq!(&p[2..4], &20u16.to_be_bytes());
        assert_eq!(&p[4..6], &30u16.to_be_bytes());
        assert_eq!(&p[6..8], &40u16.to_be_bytes());
        assert_eq!(&p[8..], &rgba[..]);
    }

    #[test]
    fn relay_origin_allowlist_rejects_unrelated_pages() {
        assert!(is_authorized_origin("tauri://localhost"));
        assert!(is_authorized_origin("https://tauri.localhost"));
        assert!(!is_authorized_origin("https://attacker.example"));
        assert!(!is_authorized_origin("null"));
    }
}
