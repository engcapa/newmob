use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use tungstenite::http::{HeaderValue, StatusCode, header};
use tungstenite::protocol::WebSocketConfig;
use uuid::Uuid;

use crate::terminal::network::NetworkSettings;
use crate::vnc::clipboard::{
    ACTION_NOTIFY, ACTION_PROVIDE, ACTION_REQUEST, ClipboardFormats, ENCODING_EXTENDED_CLIPBOARD,
    ENCODING_EXTENDED_CLIPBOARD_LEGACY, ExtendedClipboardMsg, FORMAT_HTML, FORMAT_RTF, FORMAT_TEXT,
    build_caps_body, build_notify_body, build_provide_body_limited, build_request_body,
};
use crate::vnc::encodings::DecodedRect;
use crate::vnc::error::{VncError, VncStage};
use crate::vnc::limits::DecodeLimits;
use crate::vnc::options::{VncClipboardPolicy, VncOptions};
use crate::vnc::rfb::{RfbConnection, RfbWriter, ServerMessage};
use crate::vnc::transport::{RFB_RUNTIME_IO_TIMEOUT, open_transport, wait_for_bridge_end};

/// Deadline for the frontend to complete its WebSocket upgrade after we bind.
const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum time without a ping from the frontend before we tear down.
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the idle watchdog checks the last-seen timestamp.
const WS_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const WS_CONTROL_CAPACITY: usize = 256;
const WS_TEXT_CAPACITY: usize = 32;
const RELAY_PROTOCOL_VERSION: u8 = 1;
const FRAME_MAGIC: &[u8; 4] = b"TVNC";
const FRAME_BATCH_TYPE: u8 = 1;

// ── Messages for internal channels ──────────────────────────────────

/// Outgoing messages from the event loop toward the WebSocket client.
pub enum WsOutgoing {
    Text(String),
}

#[derive(Clone, Default)]
struct LatestFrameMailbox {
    pending: Arc<AsyncMutex<Option<Vec<u8>>>>,
    notify: Arc<Notify>,
}

impl LatestFrameMailbox {
    async fn replace(&self, frame: Vec<u8>) -> bool {
        let dropped = self.pending.lock().await.replace(frame).is_some();
        self.notify.notify_one();
        dropped
    }

    async fn take(&self) -> Option<Vec<u8>> {
        self.pending.lock().await.take()
    }

    async fn ready(&self) {
        self.notify.notified().await;
    }
}

/// Control messages from the WebSocket client toward the VNC event loop.
#[derive(Debug)]
pub enum VncControl {
    Key {
        down: bool,
        keysym: u32,
    },
    Pointer {
        x: u16,
        y: u16,
        buttons: u8,
    },
    Clipboard(String),
    /// Send an ExtendedClipboard payload using whatever formats the server has
    /// advertised support for. The relay handles caps negotiation and falls
    /// back to plain ClientCutText if the server didn't advertise the encoding.
    ExtendedClipboard(ClipboardFormats),
    Ack {
        frame_id: u64,
    },
    Disconnect,
}

// ── JSON messages on the wire ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsIncoming {
    #[serde(rename = "ack")]
    Ack,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "key")]
    Key { down: bool, keysym: u32 },
    #[serde(rename = "pointer")]
    Pointer {
        x: u16,
        y: u16,
        #[serde(default)]
        buttons: u8,
    },
    #[serde(rename = "clipboard")]
    Clipboard { text: String },
    #[serde(rename = "ext_clipboard")]
    ExtClipboard {
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        html: Option<String>,
        #[serde(default)]
        rtf: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum WsOutgoingText {
    #[serde(rename = "connected")]
    Connected {
        width: u16,
        height: u16,
        name: String,
        protocol_version: String,
        security_type: String,
        encrypted: bool,
        identity_verified: bool,
        view_only: bool,
        clipboard_policy: VncClipboardPolicy,
    },
    #[serde(rename = "disconnected")]
    Disconnected {
        #[serde(flatten)]
        error: VncError,
    },
    #[serde(rename = "bell")]
    Bell,
    #[serde(rename = "clipboard")]
    Clipboard { text: String },
    /// Server delivered an ExtendedClipboard payload. The frontend writes the
    /// matching MIME types to the system clipboard.
    #[serde(rename = "ext_clipboard")]
    ExtClipboard {
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        html: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rtf: Option<String>,
    },
    /// Tells the frontend whether the connected server negotiated the
    /// ExtendedClipboard pseudo-encoding. When false, the frontend types
    /// non-ASCII paste content as Unicode keysyms because the legacy
    /// ClientCutText channel is Latin-1 only and would mojibake CJK.
    #[serde(rename = "ext_clipboard_support")]
    ExtClipboardSupport { available: bool },
}

// ── Public session handle ───────────────────────────────────────────

pub struct VncSession {
    pub control_tx: Sender<VncControl>,
    pub ws_port: u16,
    pub ws_token: String,
    pub cancel: CancellationToken,
    pub diagnostics: Arc<AsyncMutex<VncDiagnostics>>,
}

#[derive(Debug, Clone)]
pub struct VncSpawnConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub options: VncOptions,
    pub network: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncDiagnostics {
    pub correlation_id: String,
    pub state: String,
    pub protocol_version: String,
    pub security_type: String,
    pub encrypted: bool,
    pub identity_verified: bool,
    pub width: u16,
    pub height: u16,
    pub frames_received: u64,
    pub rectangles_received: u64,
    pub frames_rendered: u64,
    pub frames_dropped: u64,
    pub bytes_to_webview: u64,
    pub last_error: Option<VncError>,
}

impl VncDiagnostics {
    fn new(correlation_id: String) -> Self {
        Self {
            correlation_id,
            state: "connecting".to_string(),
            protocol_version: String::new(),
            security_type: String::new(),
            encrypted: false,
            identity_verified: false,
            width: 0,
            height: 0,
            frames_received: 0,
            rectangles_received: 0,
            frames_rendered: 0,
            frames_dropped: 0,
            bytes_to_webview: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ServerClipboardCaps {
    formats: u32,
    actions: u32,
}

// ── Main entry point ────────────────────────────────────────────────

/// Connect to a VNC server and spawn the relay. Returns a session handle.
pub async fn spawn_vnc_relay(config: VncSpawnConfig) -> Result<VncSession, VncError> {
    let cancel = CancellationToken::new();
    let correlation_id = Uuid::new_v4().to_string();
    let diagnostics = Arc::new(AsyncMutex::new(VncDiagnostics::new(correlation_id.clone())));
    let limits = DecodeLimits::default();

    // 1. Connect + handshake + auth
    let transport = open_transport(&config.host, config.port, config.network.as_ref(), &cancel)
        .await
        .map_err(VncError::from_transport)?;
    let crate::vnc::transport::VncTransport {
        stream,
        mut bridge_task,
    } = transport;
    let username = config.username.clone();
    let password = config.password.clone();
    let options_for_handshake = config.options.clone();
    let handshake = tokio::task::spawn_blocking(move || {
        let mut rfb = RfbConnection::from_vencrypt_bridge(stream, limits)?;
        let server_init = rfb.authenticate_with_options(
            username.as_deref(),
            password.as_deref(),
            &options_for_handshake,
        )?;
        rfb.set_pixel_format_rgba()?;
        // Encoding preference: ZRLE (bandwidth) > Hextile (tile cache) > CopyRect
        // (scroll) > Raw (fallback). DesktopSize must be listed so server-driven
        // resolution changes keep working. Tight is intentionally omitted — the
        // decoder in encodings.rs is not RFC-compliant and would desync the stream.
        // ExtendedClipboard is a pseudo-encoding advertising support for
        // multi-format clipboard exchange (HTML/RTF/UTF-8); the server only sends
        // extended ClientCutText when both sides have advertised it.
        rfb.set_encodings(&[
            16,                                 // ZRLE
            5,                                  // Hextile
            1,                                  // CopyRect
            0,                                  // Raw
            -223,                               // DesktopSize pseudo
            ENCODING_EXTENDED_CLIPBOARD,        // ExtendedClipboard pseudo.
            ENCODING_EXTENDED_CLIPBOARD_LEGACY, // Compatibility with old draft value.
        ])?;
        rfb.request_update(false)?;
        rfb.set_io_timeout(RFB_RUNTIME_IO_TIMEOUT)?;
        let writer = rfb.take_writer()?;
        let security = rfb.security_info();
        Ok::<_, String>((rfb, writer, server_init, security))
    });
    let (rfb, writer, server_init, security) = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30), handshake) => {
            match result {
                Ok(Ok(Ok(value))) => value,
                Ok(Ok(Err(error))) => {
                    cancel.cancel();
                    if let Some(task) = bridge_task.take() { task.abort(); }
                    return Err(VncError::from_protocol(VncStage::Negotiating, error));
                }
                Ok(Err(error)) => {
                    cancel.cancel();
                    if let Some(task) = bridge_task.take() { task.abort(); }
                    return Err(VncError::new("VNC_WORKER_FAILED", VncStage::Negotiating, false, error.to_string()));
                }
                Err(_) => {
                    cancel.cancel();
                    if let Some(task) = bridge_task.take() { task.abort(); }
                    return Err(VncError::new("VNC_HANDSHAKE_TIMEOUT", VncStage::Negotiating, true, "VNC handshake timed out after 30 seconds"));
                }
            }
        }
        _ = cancel.cancelled() => {
            cancel.cancel();
            if let Some(task) = bridge_task.take() { task.abort(); }
            return Err(VncError::new("VNC_CANCELLED", VncStage::Closed, false, "VNC connection cancelled"));
        }
        error = wait_for_bridge_end(&mut bridge_task) => {
            cancel.cancel();
            bridge_task.take();
            return Err(VncError::from_transport(error));
        }
    };

    // 2. Bind WS listener on dynamic port
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(error) => {
            cancel.cancel();
            if let Some(task) = bridge_task.take() {
                task.abort();
            }
            return Err(VncError::new(
                "VNC_RELAY_BIND_FAILED",
                VncStage::Relay,
                true,
                format!("bind VNC loopback relay: {error}"),
            ));
        }
    };
    let ws_port = listener
        .local_addr()
        .map_err(|error| {
            cancel.cancel();
            if let Some(task) = bridge_task.take() {
                task.abort();
            }
            VncError::new(
                "VNC_RELAY_ADDRESS_FAILED",
                VncStage::Relay,
                false,
                format!("read VNC relay address: {error}"),
            )
        })?
        .port();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    // 3. Channel setup
    let (control_tx, control_rx) = mpsc::channel::<VncControl>(WS_CONTROL_CAPACITY);
    let (ws_out_tx, ws_out_rx) = mpsc::channel::<WsOutgoing>(WS_TEXT_CAPACITY);
    let frame_mailbox = LatestFrameMailbox::default();

    let rfb = Arc::new(tokio::sync::Mutex::new(rfb));
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // Send connected notification
    let connected = serde_json::to_string(&WsOutgoingText::Connected {
        width: server_init.width,
        height: server_init.height,
        name: server_init.name.clone(),
        protocol_version: security.protocol_version.clone(),
        security_type: security.security_type.clone(),
        encrypted: security.encrypted,
        identity_verified: security.identity_verified,
        view_only: config.options.view_only,
        clipboard_policy: config.options.clipboard_policy,
    })
    .unwrap();
    let _ = ws_out_tx.try_send(WsOutgoing::Text(connected));

    {
        let mut current = diagnostics.lock().await;
        current.state = "connected".to_string();
        current.protocol_version = security.protocol_version.clone();
        current.security_type = security.security_type.clone();
        current.encrypted = security.encrypted;
        current.identity_verified = security.identity_verified;
        current.width = server_init.width;
        current.height = server_init.height;
    }

    // 4. Spawn the relay
    let cancel_clone = cancel.clone();
    let control_tx_for_relay = control_tx.clone();
    let ws_token_for_relay = ws_token.clone();
    let options_for_relay = config.options.clone();
    let diagnostics_for_relay = diagnostics.clone();
    tokio::spawn(async move {
        if let Err(e) = run_relay(
            listener,
            rfb,
            writer,
            ws_out_tx,
            ws_out_rx,
            frame_mailbox,
            control_tx_for_relay,
            control_rx,
            cancel_clone,
            ws_token_for_relay,
            options_for_relay,
            diagnostics_for_relay,
            bridge_task,
        )
        .await
        {
            tracing::error!("VNC relay error: {}", e);
        }
    });

    Ok(VncSession {
        control_tx,
        ws_port,
        ws_token,
        cancel,
        diagnostics,
    })
}

// ── Relay orchestration ─────────────────────────────────────────────

async fn run_relay(
    listener: TcpListener,
    rfb: Arc<tokio::sync::Mutex<RfbConnection>>,
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out_tx: Sender<WsOutgoing>,
    mut ws_out_rx: Receiver<WsOutgoing>,
    frame_mailbox: LatestFrameMailbox,
    control_tx: Sender<VncControl>,
    mut control_rx: Receiver<VncControl>,
    cancel: CancellationToken,
    ws_token: String,
    options: VncOptions,
    diagnostics: Arc<AsyncMutex<VncDiagnostics>>,
    mut bridge_task: Option<JoinHandle<Result<(), String>>>,
) -> Result<(), String> {
    let ws_stream = match accept_authorized_ws(listener, &ws_token, &cancel).await {
        Ok(stream) => stream,
        Err(error) => {
            cancel.cancel();
            if let Some(task) = bridge_task.take() {
                task.abort();
            }
            let mut current = diagnostics.lock().await;
            current.state = "failed".to_string();
            current.last_error = Some(VncError::new(
                "VNC_RELAY_AUTH_FAILED",
                VncStage::Relay,
                true,
                error.clone(),
            ));
            return Err(error);
        }
    };

    let (mut ws_sink, ws_reader) = ws_stream.split();

    // Shared "last time we heard from the frontend" — updated on every ping/control.
    let last_seen = Arc::new(AsyncMutex::new(Instant::now()));

    // Server's advertised ExtendedClipboard formats/actions. Set on receipt of
    // the server's caps message; until then we fall back to plain ClientCutText.
    let server_clip_caps = Arc::new(AsyncMutex::new(ServerClipboardCaps::default()));
    // Cache the latest local clipboard payload so servers that follow the
    // notify/request/provide flow can request it after our paste shortcut.
    let latest_local_clipboard = Arc::new(AsyncMutex::new(None::<ClipboardFormats>));

    // Task: pump outgoing messages → WS sink
    let ws_write_cancel = cancel.clone();
    let frame_mailbox_write = frame_mailbox.clone();
    let ws_write = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                biased;
                _ = ws_write_cancel.cancelled() => break,
                text = ws_out_rx.recv() => match text {
                    Some(WsOutgoing::Text(json)) => Message::Text(json.into()),
                    None => break,
                },
                _ = frame_mailbox_write.ready() => match frame_mailbox_write.take().await {
                    Some(frame) => Message::Binary(frame.into()),
                    None => continue,
                },
            };
            if ws_sink.send(message).await.is_err() {
                break;
            }
        }
    });

    // Task: read WS messages → control_tx
    let ctrl = control_tx.clone();
    let cancel_read = cancel.clone();
    let last_seen_read = last_seen.clone();
    let ws_read = tokio::spawn(async move {
        let mut reader = ws_reader;
        while let Some(Ok(msg)) = reader.next().await {
            if cancel_read.is_cancelled() {
                break;
            }
            // Any inbound message counts as the frontend being alive.
            *last_seen_read.lock().await = Instant::now();
            match msg {
                Message::Text(text) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIncoming>(&text) {
                        let ctrl_msg = match incoming {
                            WsIncoming::Ack => Some(VncControl::Ack { frame_id: 0 }),
                            WsIncoming::Ping => None, // already refreshed last_seen
                            WsIncoming::Key { down, keysym } => {
                                Some(VncControl::Key { down, keysym })
                            }
                            WsIncoming::Pointer { x, y, buttons } => {
                                Some(VncControl::Pointer { x, y, buttons })
                            }
                            WsIncoming::Clipboard { text } => {
                                log::debug!(
                                    "vnc.clip: ws→relay legacy clipboard len={}",
                                    text.len()
                                );
                                Some(VncControl::Clipboard(text))
                            }
                            WsIncoming::ExtClipboard { text, html, rtf } => {
                                log::debug!(
                                    "vnc.clip: ws→relay ext clipboard text_len={} html_len={} rtf_len={}",
                                    text.as_deref().map(str::len).unwrap_or(0),
                                    html.as_deref().map(str::len).unwrap_or(0),
                                    rtf.as_deref().map(str::len).unwrap_or(0),
                                );
                                Some(VncControl::ExtendedClipboard(ClipboardFormats {
                                    text,
                                    html,
                                    rtf,
                                }))
                            }
                        };
                        if let Some(m) = ctrl_msg {
                            if ctrl.send(m).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                Message::Binary(bytes) => {
                    if let Some(ctrl_msg) = parse_binary_control(&bytes) {
                        if ctrl.send(ctrl_msg).await.is_err() {
                            break;
                        }
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.try_send(VncControl::Disconnect);
                    break;
                }
                _ => {}
            }
        }
    });

    // Task: VNC read loop — read server messages, decode, push to ws_out_tx
    let rfb_read = rfb.clone();
    let rfb_writer_for_read = writer.clone();
    let ws_out = ws_out_tx.clone();
    let cancel_vnc = cancel.clone();
    let server_caps_read = server_clip_caps.clone();
    let latest_clipboard_read = latest_local_clipboard.clone();
    let writer_for_caps = writer.clone();
    let frame_sequence = Arc::new(AtomicU64::new(0));
    let frame_sequence_read = frame_sequence.clone();
    let force_full_refresh = Arc::new(AtomicBool::new(false));
    let force_full_refresh_read = force_full_refresh.clone();
    let frame_mailbox_read = frame_mailbox.clone();
    let diagnostics_read = diagnostics.clone();
    let clipboard_policy_read = options.clipboard_policy;
    let options_for_read = options.clone();
    let limits_read = DecodeLimits::default();
    let vnc_read = tokio::spawn(async move {
        loop {
            if cancel_vnc.is_cancelled() {
                break;
            }
            let connection = rfb_read.clone();
            let read_result = tokio::task::spawn_blocking(move || {
                let mut conn = connection.blocking_lock();
                let message = conn.read_server_message();
                (message, conn.width, conn.height)
            })
            .await;
            let (msg, fb_width, fb_height) = match read_result {
                Ok((Ok(message), width, height)) => (message, width, height),
                Ok((Err(error), _, _)) => {
                    let structured = VncError::from_protocol(VncStage::Runtime, error.clone());
                    {
                        let mut current = diagnostics_read.lock().await;
                        current.state = "failed".to_string();
                        current.last_error = Some(structured);
                    }
                    let json =
                        disconnected_message(VncError::from_protocol(VncStage::Runtime, error));
                    let _ = ws_out.send(WsOutgoing::Text(json)).await;
                    break;
                }
                Err(error) => {
                    let _ = ws_out
                        .send(WsOutgoing::Text(disconnected_message(VncError::new(
                            "VNC_WORKER_FAILED",
                            VncStage::Runtime,
                            false,
                            format!("VNC reader worker failed: {error}"),
                        ))))
                        .await;
                    break;
                }
            };
            match msg {
                ServerMessage::Idle => continue,
                ServerMessage::FramebufferUpdate { rects } => {
                    let rectangle_count = rects.len() as u64;
                    let frame_id = frame_sequence_read.fetch_add(1, Ordering::Relaxed) + 1;
                    match make_frame_batch(frame_id, fb_width, fb_height, rects, &limits_read) {
                        Ok(frame) => {
                            {
                                let mut current = diagnostics_read.lock().await;
                                current.frames_received += 1;
                                current.rectangles_received += rectangle_count;
                                current.width = fb_width;
                                current.height = fb_height;
                                current.bytes_to_webview =
                                    current.bytes_to_webview.saturating_add(frame.len() as u64);
                            }
                            if frame_mailbox_read.replace(frame).await {
                                force_full_refresh_read.store(true, Ordering::Release);
                                let mut current = diagnostics_read.lock().await;
                                current.frames_dropped = current.frames_dropped.saturating_add(1);
                            }
                        }
                        Err(error) => {
                            let _ = ws_out
                                .send(WsOutgoing::Text(disconnected_message(
                                    VncError::from_protocol(VncStage::Runtime, error),
                                )))
                                .await;
                            break;
                        }
                    }
                    let _ = with_writer(rfb_writer_for_read.clone(), move |writer| {
                        writer.set_framebuffer_size(fb_width, fb_height);
                        Ok(())
                    })
                    .await;
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json)).await;
                }
                ServerMessage::ServerCutText { text } => {
                    log::debug!("vnc.clip: server→client legacy cut text len={}", text.len());
                    if clipboard_policy_read.receives_from_server() {
                        let json =
                            serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                        let _ = ws_out.send(WsOutgoing::Text(json)).await;
                    }
                }
                ServerMessage::ExtendedClipboard(ext) => {
                    handle_server_ext_clipboard(
                        ext,
                        &server_caps_read,
                        &latest_clipboard_read,
                        &writer_for_caps,
                        &ws_out,
                        &options_for_read,
                    )
                    .await;
                }
                ServerMessage::SetColourMapEntries => {}
            }
        }
    });

    // Task: control loop — process commands from WS client
    let rfb_ctrl = writer.clone();
    let cl_cancel = cancel.clone();
    let server_caps_ctrl = server_clip_caps.clone();
    let latest_clipboard_ctrl = latest_local_clipboard.clone();
    let options_for_control = options.clone();
    let diagnostics_control = diagnostics.clone();
    let frame_sequence_control = frame_sequence.clone();
    let force_full_refresh_control = force_full_refresh.clone();
    let mut vnc_ctrl = tokio::spawn(async move {
        let mut deferred_ctrl: Option<VncControl> = None;
        let mut last_pointer_buttons = 0u8;
        let mut last_rendered_frame = 0u64;
        loop {
            let ctrl = match deferred_ctrl.take() {
                Some(ctrl) => ctrl,
                None => match control_rx.recv().await {
                    Some(ctrl) => ctrl,
                    None => break,
                },
            };
            if cl_cancel.is_cancelled() {
                break;
            }
            let ctrl = coalesce_pointer_control(
                ctrl,
                &mut control_rx,
                &mut deferred_ctrl,
                last_pointer_buttons,
            );
            if control_blocked_by_view_only(&ctrl, options_for_control.view_only) {
                continue;
            }
            if let VncControl::Pointer { buttons, .. } = &ctrl {
                last_pointer_buttons = *buttons;
            }
            let result = match ctrl {
                VncControl::Ack { frame_id } => {
                    let latest_frame = frame_sequence_control.load(Ordering::Relaxed);
                    let acknowledged = if frame_id == 0 {
                        latest_frame
                    } else {
                        frame_id.min(latest_frame)
                    };
                    if acknowledged > last_rendered_frame {
                        let mut current = diagnostics_control.lock().await;
                        current.frames_rendered = current
                            .frames_rendered
                            .saturating_add(acknowledged - last_rendered_frame);
                        last_rendered_frame = acknowledged;
                    }
                    let incremental = !force_full_refresh_control.swap(false, Ordering::AcqRel);
                    with_writer(rfb_ctrl.clone(), move |writer| {
                        writer.request_update(incremental)
                    })
                    .await
                }
                VncControl::Key { down, keysym } => {
                    with_writer(rfb_ctrl.clone(), move |writer| {
                        writer.send_key_event(down, keysym)
                    })
                    .await
                }
                VncControl::Pointer { x, y, buttons } => {
                    with_writer(rfb_ctrl.clone(), move |writer| {
                        writer.send_pointer_event(x, y, buttons)
                    })
                    .await
                }
                VncControl::Clipboard(text) => {
                    if !options_for_control.clipboard_policy.sends_to_server() {
                        Ok(())
                    } else if text.len() > options_for_control.clipboard_max_bytes {
                        Err(format!(
                            "clipboard text payload {} exceeds configured limit {}",
                            text.len(),
                            options_for_control.clipboard_max_bytes
                        ))
                    } else {
                        with_writer(rfb_ctrl.clone(), move |writer| {
                            writer.send_client_cut_text(&text)
                        })
                        .await
                    }
                }
                VncControl::ExtendedClipboard(mut formats) => {
                    if !options_for_control.clipboard_policy.sends_to_server() {
                        continue;
                    }
                    filter_clipboard_options(&mut formats, &options_for_control);
                    if let Err(error) = validate_clipboard_formats(&formats, &options_for_control) {
                        tracing::warn!("VNC clipboard payload rejected: {error}");
                        continue;
                    }
                    let server_caps = *server_caps_ctrl.lock().await;
                    *latest_clipboard_ctrl.lock().await = Some(formats.clone());
                    if server_caps.formats == 0 {
                        if let Some(text) = formats.text {
                            with_writer(rfb_ctrl.clone(), move |writer| {
                                writer.send_client_cut_text(&text)
                            })
                            .await
                        } else {
                            Ok(())
                        }
                    } else {
                        // Filter to formats the server actually supports.
                        let filtered = ClipboardFormats {
                            text: if server_caps.formats & FORMAT_TEXT != 0 {
                                formats.text
                            } else {
                                None
                            },
                            html: if server_caps.formats & FORMAT_HTML != 0 {
                                formats.html
                            } else {
                                None
                            },
                            rtf: if server_caps.formats & FORMAT_RTF != 0 {
                                formats.rtf
                            } else {
                                None
                            },
                        };
                        let format_mask = filtered.format_mask();
                        if format_mask == 0 {
                            Ok(())
                        } else {
                            if can_send_notify(server_caps) {
                                let body = build_notify_body(format_mask);
                                with_writer(rfb_ctrl.clone(), move |writer| {
                                    writer.send_extended_clipboard(&body)
                                })
                                .await
                            } else if can_send_provide(server_caps) {
                                let limits = clipboard_limits(&options_for_control);
                                match build_provide_body_limited(&filtered, &limits) {
                                    Ok(body) => {
                                        with_writer(rfb_ctrl.clone(), move |writer| {
                                            writer.send_extended_clipboard(&body)
                                        })
                                        .await
                                    }
                                    Err(error) => Err(error),
                                }
                            } else {
                                Ok(())
                            }
                        }
                    }
                }
                VncControl::Disconnect => {
                    cl_cancel.cancel();
                    Ok(())
                }
            };
            if let Err(e) = result {
                tracing::error!("VNC control error: {}", e);
            }
        }
    });

    // Task: idle watchdog — if the frontend stops pinging, tear everything down.
    let watchdog_cancel = cancel.clone();
    let watchdog_last_seen = last_seen.clone();
    let mut idle_watch = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(WS_IDLE_CHECK_INTERVAL);
        // The first tick fires immediately; skip it so we don't race the ws_read task.
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let elapsed = watchdog_last_seen.lock().await.elapsed();
                    if elapsed > WS_IDLE_TIMEOUT {
                        tracing::warn!(
                            "VNC relay idle for {:?} (> {:?}); disconnecting",
                            elapsed,
                            WS_IDLE_TIMEOUT
                        );
                        watchdog_cancel.cancel();
                        break;
                    }
                }
                _ = watchdog_cancel.cancelled() => break,
            }
        }
    });

    // Wait for any critical task to finish, then cancel everything
    let mut ws_write = ws_write;
    let mut ws_read = ws_read;
    let mut vnc_read = vnc_read;
    tokio::select! {
        r = &mut ws_write => {
            if let Err(e) = r { tracing::error!("ws_write: {}", e); }
        }
        r = &mut ws_read => {
            if let Err(e) = r { tracing::error!("ws_read: {}", e); }
        }
        r = &mut vnc_read => {
            if let Err(e) = r { tracing::error!("vnc_read: {}", e); }
        }
        r = &mut vnc_ctrl => {
            if let Err(e) = r { tracing::error!("vnc_ctrl: {}", e); }
        }
        r = &mut idle_watch => {
            if let Err(e) = r { tracing::error!("idle_watch: {}", e); }
        }
    }

    cancel.cancel();
    ws_write.abort();
    ws_read.abort();
    vnc_read.abort();
    vnc_ctrl.abort();
    idle_watch.abort();
    if let Some(task) = bridge_task.take() {
        task.abort();
    }
    diagnostics.lock().await.state = "closed".to_string();
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

async fn accept_authorized_ws(
    listener: TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-vnc.{ws_token}");
    let relay_limit = DecodeLimits::default().max_relay_message_bytes;
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(error)) => return Err(format!("VNC relay accept failed: {error}")),
                Err(_) => return Err("VNC WebSocket authorization timed out".to_string()),
            },
            _ = cancel.cancelled() => return Err("VNC relay cancelled".to_string()),
        };
        let protocol = expected_protocol.clone();
        let callback = move |request: &Request, mut response: Response| {
            if request.uri().path() != "/vnc"
                || !request_has_authorized_origin(request)
                || !request_has_protocol(request, &protocol)
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
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(relay_limit);
        config.max_frame_size = Some(relay_limit);
        match tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config)).await
        {
            Ok(websocket) => return Ok(websocket),
            Err(error) => tracing::warn!("rejected unauthorized VNC WebSocket: {error}"),
        }
    }
}

fn disconnected_message(error: VncError) -> String {
    serde_json::to_string(&WsOutgoingText::Disconnected { error })
        .expect("VNC errors are JSON serializable")
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
            "http://localhost:1980",
            "http://127.0.0.1:1980",
            "http://localhost:5000",
            "http://127.0.0.1:5000",
        ]
        .contains(&origin);
    }
    false
}

async fn with_writer<F>(
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    operation: F,
) -> Result<(), String>
where
    F: FnOnce(&mut RfbWriter) -> Result<(), String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut current = writer.blocking_lock();
        operation(&mut current)
    })
    .await
    .map_err(|error| format!("VNC writer worker failed: {error}"))?
}

fn make_frame_batch(
    frame_id: u64,
    framebuffer_width: u16,
    framebuffer_height: u16,
    rects: Vec<DecodedRect>,
    limits: &DecodeLimits,
) -> Result<Vec<u8>, String> {
    limits.framebuffer_bytes(framebuffer_width, framebuffer_height)?;
    if rects.len() > usize::from(limits.max_rectangles) {
        return Err(format!(
            "frame rectangle count {} exceeds limit {}",
            rects.len(),
            limits.max_rectangles
        ));
    }
    let rectangle_count = u16::try_from(rects.len())
        .map_err(|_| "frame rectangle count exceeds protocol range".to_string())?;
    let mut total = 22usize;
    for rect in &rects {
        let DecodedRect::Pixels { x, y, w, h, rgba } = rect;
        let expected =
            limits.validate_rectangle(*x, *y, *w, *h, framebuffer_width, framebuffer_height)?;
        if rgba.len() != expected {
            return Err(format!(
                "rectangle payload has {} bytes, expected {expected}",
                rgba.len()
            ));
        }
        total = total
            .checked_add(12)
            .and_then(|value| value.checked_add(rgba.len()))
            .ok_or_else(|| "frame batch size overflow".to_string())?;
        if total > limits.max_frame_batch_bytes {
            return Err(format!(
                "frame batch requires {total} bytes, limit is {}",
                limits.max_frame_batch_bytes
            ));
        }
    }

    let mut batch = Vec::with_capacity(total);
    batch.extend_from_slice(FRAME_MAGIC);
    batch.push(RELAY_PROTOCOL_VERSION);
    batch.push(FRAME_BATCH_TYPE);
    batch.extend_from_slice(&[0, 0]);
    batch.extend_from_slice(&frame_id.to_be_bytes());
    batch.extend_from_slice(&framebuffer_width.to_be_bytes());
    batch.extend_from_slice(&framebuffer_height.to_be_bytes());
    batch.extend_from_slice(&rectangle_count.to_be_bytes());
    for rect in rects {
        let DecodedRect::Pixels { x, y, w, h, rgba } = rect;
        let payload_len = u32::try_from(rgba.len())
            .map_err(|_| "rectangle payload exceeds protocol range".to_string())?;
        batch.extend_from_slice(&x.to_be_bytes());
        batch.extend_from_slice(&y.to_be_bytes());
        batch.extend_from_slice(&w.to_be_bytes());
        batch.extend_from_slice(&h.to_be_bytes());
        batch.extend_from_slice(&payload_len.to_be_bytes());
        batch.extend_from_slice(&rgba);
    }
    Ok(batch)
}

/// Drive the ExtendedClipboard handshake on receipt of a server message.
async fn handle_server_ext_clipboard(
    msg: ExtendedClipboardMsg,
    server_caps: &Arc<AsyncMutex<ServerClipboardCaps>>,
    latest_local_clipboard: &Arc<AsyncMutex<Option<ClipboardFormats>>>,
    writer: &Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out: &Sender<WsOutgoing>,
    options: &VncOptions,
) {
    let our_caps = clipboard_format_mask(options);
    let max_size = options.clipboard_max_bytes.min(u32::MAX as usize) as u32;

    match msg {
        ExtendedClipboardMsg::Caps {
            formats, actions, ..
        } => {
            *server_caps.lock().await = ServerClipboardCaps {
                formats: formats & our_caps,
                actions,
            };
            let body = build_caps_body(our_caps, max_size);
            let _ = with_writer(writer.clone(), move |current| {
                current.send_extended_clipboard(&body)
            })
            .await;
            // Tell the frontend which clipboard path is active so diagnostics
            // can distinguish ExtendedClipboard from the legacy fallback.
            let support = WsOutgoingText::ExtClipboardSupport {
                available: (formats & our_caps) != 0
                    && (actions & (ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE)) != 0,
            };
            if let Ok(json) = serde_json::to_string(&support) {
                let _ = ws_out.send(WsOutgoing::Text(json)).await;
            }
        }
        ExtendedClipboardMsg::Notify { formats } => {
            if !options.clipboard_policy.receives_from_server() {
                return;
            }
            let want = formats & our_caps;
            let caps = *server_caps.lock().await;
            if want != 0 && can_send_request(caps) {
                let body = build_request_body(want);
                let _ = with_writer(writer.clone(), move |current| {
                    current.send_extended_clipboard(&body)
                })
                .await;
            }
        }
        ExtendedClipboardMsg::Provide {
            formats: _,
            mut formats_data,
        } => {
            if !options.clipboard_policy.receives_from_server() {
                return;
            }
            filter_clipboard_options(&mut formats_data, options);
            if validate_clipboard_formats(&formats_data, options).is_err() {
                tracing::warn!("VNC server clipboard payload exceeded configured limits");
                return;
            }
            let json = serde_json::to_string(&WsOutgoingText::ExtClipboard {
                text: formats_data.text,
                html: formats_data.html,
                rtf: formats_data.rtf,
            })
            .unwrap();
            let _ = ws_out.send(WsOutgoing::Text(json)).await;
        }
        ExtendedClipboardMsg::Request { formats } => {
            if !options.clipboard_policy.sends_to_server() {
                return;
            }
            let cached = latest_local_clipboard.lock().await.clone();
            if let Some(data) = cached {
                let filtered = filter_clipboard_formats(data, formats & our_caps);
                if filtered.format_mask() != 0 {
                    let limits = clipboard_limits(options);
                    if let Ok(body) = build_provide_body_limited(&filtered, &limits) {
                        let _ = with_writer(writer.clone(), move |current| {
                            current.send_extended_clipboard(&body)
                        })
                        .await;
                    }
                }
            }
        }
        ExtendedClipboardMsg::Peek => {
            let formats = latest_local_clipboard
                .lock()
                .await
                .as_ref()
                .map(|data| data.format_mask() & our_caps)
                .unwrap_or(0);
            let body = build_notify_body(formats);
            let _ = with_writer(writer.clone(), move |current| {
                current.send_extended_clipboard(&body)
            })
            .await;
        }
    }
}

fn clipboard_format_mask(options: &VncOptions) -> u32 {
    let mut formats = FORMAT_TEXT;
    if !options.clipboard_text_only && options.allow_html_clipboard {
        formats |= FORMAT_HTML;
    }
    if !options.clipboard_text_only && options.allow_rtf_clipboard {
        formats |= FORMAT_RTF;
    }
    formats
}

fn filter_clipboard_options(data: &mut ClipboardFormats, options: &VncOptions) {
    if options.clipboard_text_only || !options.allow_html_clipboard {
        data.html = None;
    }
    if options.clipboard_text_only || !options.allow_rtf_clipboard {
        data.rtf = None;
    }
}

fn validate_clipboard_formats(data: &ClipboardFormats, options: &VncOptions) -> Result<(), String> {
    let mut total = 0usize;
    for value in [&data.text, &data.html, &data.rtf].into_iter().flatten() {
        if value.len() > options.clipboard_max_bytes {
            return Err(format!(
                "clipboard format payload {} exceeds configured limit {}",
                value.len(),
                options.clipboard_max_bytes
            ));
        }
        total = total
            .checked_add(value.len())
            .ok_or_else(|| "clipboard total size overflow".to_string())?;
    }
    let total_limit = options.clipboard_max_bytes.saturating_mul(3);
    if total > total_limit {
        return Err(format!(
            "clipboard payload {total} exceeds configured total limit {total_limit}"
        ));
    }
    Ok(())
}

fn clipboard_limits(options: &VncOptions) -> DecodeLimits {
    DecodeLimits {
        max_clipboard_format_bytes: options.clipboard_max_bytes,
        max_clipboard_total_bytes: options.clipboard_max_bytes.saturating_mul(3),
        ..DecodeLimits::default()
    }
}

fn filter_clipboard_formats(data: ClipboardFormats, mask: u32) -> ClipboardFormats {
    ClipboardFormats {
        text: if mask & FORMAT_TEXT != 0 {
            data.text
        } else {
            None
        },
        html: if mask & FORMAT_HTML != 0 {
            data.html
        } else {
            None
        },
        rtf: if mask & FORMAT_RTF != 0 {
            data.rtf
        } else {
            None
        },
    }
}

fn can_send_request(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_REQUEST != 0
}

fn can_send_notify(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_NOTIFY != 0
}

fn can_send_provide(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_PROVIDE != 0
}

fn parse_binary_control(bytes: &[u8]) -> Option<VncControl> {
    match bytes.first().copied()? {
        0 if bytes.len() == 1 => Some(VncControl::Ack { frame_id: 0 }),
        0 if bytes.len() == 9 => Some(VncControl::Ack {
            frame_id: u64::from_be_bytes(bytes[1..9].try_into().ok()?),
        }),
        1 if bytes.len() == 1 => None,
        2 if bytes.len() == 6 => {
            let down = bytes[1] != 0;
            let keysym = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
            Some(VncControl::Key { down, keysym })
        }
        3 if bytes.len() == 6 => {
            let buttons = bytes[1];
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            Some(VncControl::Pointer { x, y, buttons })
        }
        // Client-driven SetDesktopSize is intentionally unsupported. The RFB
        // DesktopSize pseudo-encoding is server-to-client only.
        4 if bytes.len() == 5 => None,
        _ => None,
    }
}

fn coalesce_pointer_control(
    ctrl: VncControl,
    control_rx: &mut Receiver<VncControl>,
    deferred_ctrl: &mut Option<VncControl>,
    last_buttons: u8,
) -> VncControl {
    let (mut x, mut y, buttons) = match ctrl {
        VncControl::Pointer { x, y, buttons } => (x, y, buttons),
        other => return other,
    };

    if buttons != last_buttons {
        return VncControl::Pointer { x, y, buttons };
    }

    loop {
        match control_rx.try_recv() {
            Ok(VncControl::Pointer {
                x: next_x,
                y: next_y,
                buttons: next_buttons,
            }) if next_buttons == buttons => {
                x = next_x;
                y = next_y;
            }
            Ok(other @ VncControl::Pointer { .. }) => {
                *deferred_ctrl = Some(other);
                break;
            }
            Ok(other) => {
                *deferred_ctrl = Some(other);
                break;
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }

    VncControl::Pointer { x, y, buttons }
}

fn control_blocked_by_view_only(control: &VncControl, view_only: bool) -> bool {
    view_only
        && matches!(
            control,
            VncControl::Key { .. }
                | VncControl::Pointer { .. }
                | VncControl::Clipboard(_)
                | VncControl::ExtendedClipboard(_)
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    #[test]
    fn binary_control_decodes_key_pointer_and_rejects_resize() {
        match parse_binary_control(&[2, 1, 0, 0, 0xff, 0x0d]) {
            Some(VncControl::Key { down, keysym }) => {
                assert!(down);
                assert_eq!(keysym, 0xff0d);
            }
            other => panic!("expected key control, got {:?}", other),
        }

        match parse_binary_control(&[3, 1, 0x01, 0x02, 0x03, 0x04]) {
            Some(VncControl::Pointer { x, y, buttons }) => {
                assert_eq!(x, 0x0102);
                assert_eq!(y, 0x0304);
                assert_eq!(buttons, 1);
            }
            other => panic!("expected pointer control, got {:?}", other),
        }

        assert!(parse_binary_control(&[4, 0x05, 0x00, 0x03, 0x20]).is_none());
    }

    #[test]
    fn binary_control_decodes_ack_and_ignores_ping() {
        assert!(matches!(
            parse_binary_control(&[0]),
            Some(VncControl::Ack { frame_id: 0 })
        ));
        assert!(matches!(
            parse_binary_control(&[0, 0, 0, 0, 0, 0, 0, 0, 42]),
            Some(VncControl::Ack { frame_id: 42 })
        ));
        assert!(parse_binary_control(&[1]).is_none());
        assert!(parse_binary_control(&[3, 0]).is_none());
    }

    #[test]
    fn view_only_blocks_all_remote_mutation_controls() {
        let controls = [
            VncControl::Key {
                down: true,
                keysym: 0xff0d,
            },
            VncControl::Pointer {
                x: 1,
                y: 2,
                buttons: 1,
            },
            VncControl::Clipboard("text".to_string()),
            VncControl::ExtendedClipboard(ClipboardFormats {
                text: Some("text".to_string()),
                html: None,
                rtf: None,
            }),
        ];
        for control in &controls {
            assert!(control_blocked_by_view_only(control, true));
            assert!(!control_blocked_by_view_only(control, false));
        }
        assert!(!control_blocked_by_view_only(
            &VncControl::Ack { frame_id: 1 },
            true,
        ));
        assert!(!control_blocked_by_view_only(&VncControl::Disconnect, true,));
    }

    #[test]
    fn frame_batch_is_atomic_versioned_and_bounded() {
        let batch = make_frame_batch(
            7,
            2,
            1,
            vec![DecodedRect::Pixels {
                x: 0,
                y: 0,
                w: 2,
                h: 1,
                rgba: vec![1, 2, 3, 255, 4, 5, 6, 255],
            }],
            &DecodeLimits::default(),
        )
        .unwrap();
        assert_eq!(&batch[0..4], b"TVNC");
        assert_eq!(batch[4], RELAY_PROTOCOL_VERSION);
        assert_eq!(u64::from_be_bytes(batch[8..16].try_into().unwrap()), 7);
        assert_eq!(u16::from_be_bytes(batch[20..22].try_into().unwrap()), 1);
        assert_eq!(&batch[34..], &[1, 2, 3, 255, 4, 5, 6, 255]);

        let mut limits = DecodeLimits::default();
        limits.max_frame_batch_bytes = 24;
        assert!(
            make_frame_batch(
                1,
                1,
                1,
                vec![DecodedRect::Pixels {
                    x: 0,
                    y: 0,
                    w: 1,
                    h: 1,
                    rgba: vec![0; 4],
                }],
                &limits,
            )
            .is_err()
        );
    }

    #[test]
    fn frame_batch_1080p_and_4k_payloads_stay_within_release_budget() {
        for (width, height) in [(1_920u16, 1_080u16), (3_840u16, 2_160u16)] {
            let started = Instant::now();
            let pixels = usize::from(width) * usize::from(height) * 4;
            let frame = make_frame_batch(
                1,
                width,
                height,
                vec![DecodedRect::Pixels {
                    x: 0,
                    y: 0,
                    w: width,
                    h: height,
                    rgba: vec![0x7f; pixels],
                }],
                &DecodeLimits::default(),
            )
            .unwrap();
            assert_eq!(frame.len(), 22 + 12 + pixels);
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "frame batch construction regressed for {width}x{height}: {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn production_origin_allowlist_excludes_arbitrary_websites() {
        assert!(is_authorized_origin("tauri://localhost"));
        assert!(!is_authorized_origin("https://example.com"));
    }

    #[tokio::test]
    async fn relay_rejects_wrong_origin_path_and_token_before_accepting_client() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = CancellationToken::new();
        let server_cancel = cancel.clone();
        let server = tokio::spawn(async move {
            accept_authorized_ws(listener, "fixture-token", &server_cancel)
                .await
                .unwrap()
        });

        assert!(
            websocket_client(
                port,
                "/vnc",
                "taomni-vnc.fixture-token",
                "https://example.com"
            )
            .await
            .is_err()
        );
        assert!(
            websocket_client(
                port,
                "/not-vnc",
                "taomni-vnc.fixture-token",
                "tauri://localhost",
            )
            .await
            .is_err()
        );
        assert!(
            websocket_client(port, "/vnc", "taomni-vnc.wrong", "tauri://localhost")
                .await
                .is_err()
        );
        let client = websocket_client(
            port,
            "/vnc",
            "taomni-vnc.fixture-token",
            "tauri://localhost",
        )
        .await
        .unwrap();
        assert_eq!(
            client
                .1
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .unwrap(),
            "taomni-vnc.fixture-token"
        );
        let server_websocket = server.await.unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                websocket_client(
                    port,
                    "/vnc",
                    "taomni-vnc.fixture-token",
                    "tauri://localhost",
                ),
            )
            .await
            .is_ok_and(|result| result.is_err())
        );
        drop(client);
        drop(server_websocket);
        cancel.cancel();
    }

    #[tokio::test]
    async fn latest_frame_mailbox_drops_stale_frames_without_growing() {
        let mailbox = LatestFrameMailbox::default();
        assert!(!mailbox.replace(vec![1]).await);
        for marker in 2..=10u8 {
            assert!(mailbox.replace(vec![marker]).await);
        }
        assert_eq!(mailbox.take().await, Some(vec![10]));
        assert_eq!(mailbox.take().await, None);
    }

    #[tokio::test]
    async fn configurable_mailbox_soak_keeps_only_the_latest_frame() {
        let iterations = std::env::var("TAOMNI_VNC_SOAK_ITERATIONS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(100_000)
            .clamp(1_000, 5_000_000);
        let mailbox = LatestFrameMailbox::default();
        let mut drops = 0usize;
        let mut consumed = 0usize;

        for sequence in 0..iterations {
            if mailbox.replace(sequence.to_be_bytes().to_vec()).await {
                drops += 1;
            }
            // Model a WebView that consumes only one of every 257 frames.
            if sequence + 1 < iterations && sequence % 257 == 0 && mailbox.take().await.is_some() {
                consumed += 1;
            }
        }

        let latest = mailbox
            .take()
            .await
            .expect("latest frame must remain pending");
        assert_eq!(
            usize::from_be_bytes(latest.try_into().unwrap()),
            iterations - 1
        );
        assert_eq!(drops + consumed + 1, iterations);
        assert_eq!(mailbox.take().await, None);
    }

    async fn websocket_client(
        port: u16,
        path: &str,
        protocol: &str,
        origin: &str,
    ) -> Result<
        (
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
            tungstenite::http::Response<Option<Vec<u8>>>,
        ),
        tungstenite::Error,
    > {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(tungstenite::Error::Io)?;
        let mut request = format!("ws://127.0.0.1:{port}{path}")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(protocol).unwrap(),
        );
        request
            .headers_mut()
            .insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        tokio_tungstenite::client_async(request, stream).await
    }
}
