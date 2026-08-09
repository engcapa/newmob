use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::net::TcpStream as TokioTcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::{HeaderValue, StatusCode, header};
use tungstenite::protocol::WebSocketConfig;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::terminal::network::{NetworkSettings, establish_transport};
use crate::terminal::ssh::build_ssh_transport;
use crate::vnc::clipboard::{
    ACTION_NOTIFY, ACTION_PROVIDE, ACTION_REQUEST, ClipboardFormats, ENCODING_EXTENDED_CLIPBOARD,
    ENCODING_EXTENDED_CLIPBOARD_LEGACY, ExtendedClipboardMsg, FORMAT_HTML, FORMAT_RTF, FORMAT_TEXT,
    SUPPORTED_ACTIONS, build_caps_body, build_notify_body, build_provide_body, build_request_body,
};
use crate::vnc::encodings::DecodedRect;
use crate::vnc::rfb::{
    MAX_CLIPBOARD_BYTES, RfbConnection, RfbHandshakeOptions, RfbWriter, ServerMessage,
    VncSecurityPolicy,
};

/// Deadline for the frontend to complete its WebSocket upgrade after we bind.
const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum time without a ping from the frontend before we tear down.
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the idle watchdog checks the last-seen timestamp.
const WS_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

// ── Messages for internal channels ──────────────────────────────────

/// Outgoing messages from the event loop toward the WebSocket client.
pub enum WsOutgoing {
    Frame(Vec<u8>),
    FrameEnd(u32),
    Text(String),
}

const MAX_PENDING_WS_CONTROL: usize = 256;
const MAX_WS_FRAME_BATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_WS_INCOMING_MESSAGE_BYTES: usize = MAX_CLIPBOARD_BYTES + 64 * 1024;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClipboardPolicy {
    Disabled,
    ClientToServer,
    ServerToClient,
    #[default]
    Bidirectional,
}

impl ClipboardPolicy {
    fn allows_client_to_server(self) -> bool {
        matches!(self, Self::ClientToServer | Self::Bidirectional)
    }

    fn allows_server_to_client(self) -> bool {
        matches!(self, Self::ServerToClient | Self::Bidirectional)
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct VncClientOptions {
    pub security_policy: VncSecurityPolicy,
    pub shared: bool,
    pub view_only: bool,
    pub clipboard_policy: ClipboardPolicy,
    pub allow_html_clipboard: bool,
    pub allow_rtf_clipboard: bool,
    pub max_clipboard_bytes: usize,
}

impl Default for VncClientOptions {
    fn default() -> Self {
        Self {
            security_policy: VncSecurityPolicy::default(),
            shared: true,
            view_only: false,
            clipboard_policy: ClipboardPolicy::default(),
            allow_html_clipboard: false,
            allow_rtf_clipboard: false,
            max_clipboard_bytes: MAX_CLIPBOARD_BYTES,
        }
    }
}

impl VncClientOptions {
    pub fn normalized(mut self) -> Self {
        self.max_clipboard_bytes = self.max_clipboard_bytes.clamp(1, MAX_CLIPBOARD_BYTES);
        self
    }
}

enum QueuedWsOutgoing {
    Control(WsOutgoing),
    FrameBatch { frame_id: u32, frames: Vec<Vec<u8>> },
}

struct WsOutgoingState {
    control: VecDeque<WsOutgoing>,
    building_frame: Vec<Vec<u8>>,
    building_bytes: usize,
    drop_building_frame: bool,
    latest_frame: Option<(u32, Vec<Vec<u8>>)>,
    frame_dropped: bool,
    closed: bool,
}

struct WsOutgoingQueue {
    state: Mutex<WsOutgoingState>,
    wake: Notify,
}

#[derive(Clone)]
struct WsOutgoingSender(Arc<WsOutgoingQueue>);

struct WsOutgoingReceiver {
    queue: Arc<WsOutgoingQueue>,
    active_frame: VecDeque<WsOutgoing>,
}

impl WsOutgoingQueue {
    fn new() -> (WsOutgoingSender, WsOutgoingReceiver) {
        let queue = Arc::new(Self {
            state: Mutex::new(WsOutgoingState {
                control: VecDeque::new(),
                building_frame: Vec::new(),
                building_bytes: 0,
                drop_building_frame: false,
                latest_frame: None,
                frame_dropped: false,
                closed: false,
            }),
            wake: Notify::new(),
        });
        (
            WsOutgoingSender(queue.clone()),
            WsOutgoingReceiver {
                queue,
                active_frame: VecDeque::new(),
            },
        )
    }

    fn send(&self, output: WsOutgoing) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "VNC WebSocket output queue poisoned".to_string())?;
        match output {
            WsOutgoing::Frame(bytes) => {
                if bytes.is_empty() {
                    return Err("VNC frame payload must not be empty".to_string());
                }
                if !state.drop_building_frame {
                    let next_bytes = state.building_bytes.saturating_add(bytes.len());
                    if next_bytes <= MAX_WS_FRAME_BATCH_BYTES {
                        state.building_bytes = next_bytes;
                        state.building_frame.push(bytes);
                    } else {
                        state.drop_building_frame = true;
                        state.building_frame.clear();
                    }
                }
                Ok(())
            }
            WsOutgoing::FrameEnd(frame_id) => {
                let frames = if state.drop_building_frame {
                    state.frame_dropped = true;
                    state.building_frame.clear();
                    Vec::new()
                } else {
                    std::mem::take(&mut state.building_frame)
                };
                if state.latest_frame.replace((frame_id, frames)).is_some() {
                    state.frame_dropped = true;
                }
                state.building_bytes = 0;
                state.drop_building_frame = false;
                self.wake.notify_one();
                Ok(())
            }
            other => {
                if state.control.len() >= MAX_PENDING_WS_CONTROL {
                    state.closed = true;
                    state.control.clear();
                    state.latest_frame = None;
                    state.building_frame.clear();
                    self.wake.notify_waiters();
                    return Err("VNC WebSocket control queue overflow".to_string());
                }
                if state.closed {
                    return Err("VNC WebSocket output queue closed".to_string());
                }
                state.control.push_back(other);
                self.wake.notify_one();
                Ok(())
            }
        }
    }

    async fn recv(&self) -> Option<QueuedWsOutgoing> {
        loop {
            let notified = self.wake.notified();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(output) = state.control.pop_front() {
                    return Some(QueuedWsOutgoing::Control(output));
                }
                if let Some((frame_id, frames)) = state.latest_frame.take() {
                    return Some(QueuedWsOutgoing::FrameBatch { frame_id, frames });
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.control.clear();
            state.latest_frame = None;
            state.building_frame.clear();
        }
        self.wake.notify_waiters();
    }

    fn take_frame_drop(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return true;
        };
        std::mem::take(&mut state.frame_dropped)
    }
}

impl WsOutgoingSender {
    fn send(&self, output: WsOutgoing) -> Result<(), String> {
        self.0.send(output)
    }

    fn take_frame_drop(&self) -> bool {
        self.0.take_frame_drop()
    }
}

impl WsOutgoingReceiver {
    async fn recv(&mut self) -> Option<WsOutgoing> {
        if let Some(output) = self.active_frame.pop_front() {
            return Some(output);
        }
        match self.queue.recv().await? {
            QueuedWsOutgoing::Control(output) => Some(output),
            QueuedWsOutgoing::FrameBatch { frame_id, frames } => {
                self.active_frame = frames.into_iter().map(WsOutgoing::Frame).collect();
                self.active_frame.push_back(WsOutgoing::FrameEnd(frame_id));
                self.active_frame.pop_front()
            }
        }
    }
}

impl Drop for WsOutgoingReceiver {
    fn drop(&mut self) {
        self.queue.close();
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
    Resize {
        width: u16,
        height: u16,
    },
    Ack {
        frame_id: u32,
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
    #[serde(rename = "resize")]
    Resize { width: u16, height: u16 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum WsOutgoingText {
    #[serde(rename = "connected")]
    Connected {
        width: u16,
        height: u16,
        name: String,
        security: String,
        protocol: String,
        encrypted: bool,
        view_only: bool,
        clipboard_policy: ClipboardPolicy,
    },
    #[serde(rename = "resize")]
    Resize {
        frame_id: u32,
        width: u16,
        height: u16,
    },
    #[serde(rename = "disconnected")]
    Disconnected {
        reason: String,
        code: &'static str,
        retryable: bool,
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
}

#[derive(Debug, Clone, Copy, Default)]
struct ServerClipboardCaps {
    formats: u32,
    actions: u32,
}

// ── Main entry point ────────────────────────────────────────────────

/// Connect to a VNC server and spawn the relay. Returns a session handle.
pub async fn spawn_vnc_relay(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    network: Option<NetworkSettings>,
    options: VncClientOptions,
) -> Result<VncSession, String> {
    let options = options.normalized();
    let password = password.map(Zeroizing::new);
    let cancel = CancellationToken::new();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    let (transport, transport_bridge) =
        establish_vnc_transport(&host, port, network.as_ref(), &cancel).await?;

    // Keep all sync RFB setup off the Tokio worker. The protocol implementation
    // uses std::net::TcpStream and is deliberately isolated until it is
    // replaced by a fully async transport.
    let handshake_options = RfbHandshakeOptions {
        security_policy: options.security_policy,
        shared: options.shared,
    };
    let (rfb, writer, server_init, security_label, protocol_label, encrypted) =
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let mut rfb = RfbConnection::from_stream(transport)?;
            let server_init = rfb.authenticate(
                username.as_deref(),
                password.as_deref().map(|value| value.as_str()),
                handshake_options,
            )?;
            rfb.set_steady_state_timeouts()?;
            rfb.set_pixel_format_rgba()?;
            // Encoding preference: ZRLE > Hextile > CopyRect > Raw. DesktopSize
            // keeps server-driven resolution changes observable to the UI.
            rfb.set_encodings(&[
                16,
                5,
                1,
                0,
                -223,
                ENCODING_EXTENDED_CLIPBOARD,
                ENCODING_EXTENDED_CLIPBOARD_LEGACY,
            ])?;
            rfb.request_update(false)?;
            let security_label = rfb.security_type_label().to_string();
            let protocol_label = rfb.protocol_version_label().to_string();
            let encrypted = rfb.transport_encrypted();
            let writer = rfb.take_writer()?;
            Ok((
                rfb,
                writer,
                server_init,
                security_label,
                protocol_label,
                encrypted,
            ))
        })
        .await
        .map_err(|e| format!("VNC setup worker failed: {}", e))??;

    // 2. Bind WS listener on dynamic port
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind WS: {}", e))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {}", e))?
        .port();
    // 3. Channel setup
    let (control_tx, control_rx) = mpsc::channel::<VncControl>(256);
    let (ws_out_tx, ws_out_rx) = WsOutgoingQueue::new();

    let rfb = Arc::new(tokio::sync::Mutex::new(rfb));
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // Send connected notification
    let connected = serde_json::to_string(&WsOutgoingText::Connected {
        width: server_init.width,
        height: server_init.height,
        name: server_init.name.clone(),
        security: security_label,
        protocol: protocol_label,
        encrypted,
        view_only: options.view_only,
        clipboard_policy: options.clipboard_policy,
    })
    .unwrap();
    let _ = ws_out_tx.send(WsOutgoing::Text(connected));

    // 4. Spawn the relay
    let cancel_clone = cancel.clone();
    let cancel_guard = cancel.clone();
    let control_tx_for_relay = control_tx.clone();
    let ws_token_for_relay = ws_token.clone();
    tokio::spawn(async move {
        if let Err(e) = run_relay(
            listener,
            rfb,
            writer,
            ws_out_tx,
            ws_out_rx,
            control_tx_for_relay,
            control_rx,
            cancel_clone,
            ws_token_for_relay,
            transport_bridge,
            options,
        )
        .await
        {
            tracing::error!("VNC relay error: {}", e);
        }
        cancel_guard.cancel();
    });

    Ok(VncSession {
        control_tx,
        ws_port,
        ws_token,
        cancel,
    })
}

// ── Relay orchestration ─────────────────────────────────────────────

async fn run_relay(
    listener: TcpListener,
    rfb: Arc<tokio::sync::Mutex<RfbConnection>>,
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out_tx: WsOutgoingSender,
    mut ws_out_rx: WsOutgoingReceiver,
    control_tx: Sender<VncControl>,
    mut control_rx: Receiver<VncControl>,
    cancel: CancellationToken,
    ws_token: String,
    mut transport_bridge: Option<tokio::task::JoinHandle<()>>,
    options: VncClientOptions,
) -> Result<(), String> {
    // Accept one WS connection with a bounded deadline so a webview that never
    // comes up doesn't leave the relay and its TCP connection hanging forever.
    let ws_stream = accept_authorized_ws(&listener, &ws_token, &cancel).await?;

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
    let last_delivered_frame = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let delivered_frame_write = last_delivered_frame.clone();
    let ws_write = tokio::spawn(async move {
        while let Some(out) = ws_out_rx.recv().await {
            let delivered_frame_id = match &out {
                WsOutgoing::FrameEnd(frame_id) => Some(*frame_id),
                _ => None,
            };
            let msg = match out {
                WsOutgoing::Frame(data) => Message::Binary(data.into()),
                WsOutgoing::FrameEnd(frame_id) => {
                    Message::Binary(frame_id.to_be_bytes().to_vec().into())
                }
                WsOutgoing::Text(json) => Message::Text(json.into()),
            };
            if ws_sink.send(msg).await.is_err() {
                break;
            }
            if let Some(frame_id) = delivered_frame_id {
                delivered_frame_write.store(frame_id, std::sync::atomic::Ordering::Release);
            }
        }
    });

    // Task: read WS messages → control_tx
    let ctrl = control_tx.clone();
    let cancel_read = cancel.clone();
    let last_seen_read = last_seen.clone();
    let ws_input_options = options;
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
                            WsIncoming::Key { down, keysym } => (!ws_input_options.view_only)
                                .then_some(VncControl::Key { down, keysym }),
                            WsIncoming::Pointer { x, y, buttons } => (!ws_input_options.view_only)
                                .then_some(VncControl::Pointer { x, y, buttons }),
                            WsIncoming::Clipboard { text } => {
                                if ws_input_options.clipboard_policy.allows_client_to_server()
                                    && text.len() <= ws_input_options.max_clipboard_bytes
                                {
                                    log::info!(
                                        "vnc.clip: ws→relay legacy clipboard len={}",
                                        text.len(),
                                    );
                                    Some(VncControl::Clipboard(text))
                                } else {
                                    None
                                }
                            }
                            WsIncoming::ExtClipboard { text, html, rtf } => {
                                let formats = filter_configured_clipboard_formats(
                                    ClipboardFormats { text, html, rtf },
                                    ws_input_options,
                                );
                                if ws_input_options.clipboard_policy.allows_client_to_server()
                                    && clipboard_formats_within_limit(
                                        &formats,
                                        ws_input_options.max_clipboard_bytes,
                                    )
                                {
                                    log::info!(
                                        "vnc.clip: ws→relay ext clipboard text_len={} html_len={} rtf_len={}",
                                        formats.text.as_deref().map(str::len).unwrap_or(0),
                                        formats.html.as_deref().map(str::len).unwrap_or(0),
                                        formats.rtf.as_deref().map(str::len).unwrap_or(0),
                                    );
                                    Some(VncControl::ExtendedClipboard(formats))
                                } else {
                                    None
                                }
                            }
                            WsIncoming::Resize { width, height } => {
                                Some(VncControl::Resize { width, height })
                            }
                        };
                        if let Some(m) = ctrl_msg {
                            let _ = ctrl.send(m).await;
                        }
                    }
                }
                Message::Binary(bytes) => {
                    if let Some(ctrl_msg) = parse_binary_control(&bytes)
                        && control_allowed(&ctrl_msg, ws_input_options)
                    {
                        let _ = ctrl.send(ctrl_msg).await;
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.send(VncControl::Disconnect).await;
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
    let server_output_options = options;
    let vnc_read = tokio::spawn(async move {
        let mut next_frame_id = 1u32;
        loop {
            if cancel_vnc.is_cancelled() {
                break;
            }
            let read_result = tokio::task::spawn_blocking({
                let rfb_read = rfb_read.clone();
                move || {
                    let mut conn = rfb_read.blocking_lock();
                    let previous_size = (conn.width, conn.height);
                    conn.read_server_message().map(|message| {
                        (
                            message,
                            conn.width,
                            conn.height,
                            previous_size != (conn.width, conn.height),
                        )
                    })
                }
            })
            .await;
            let (msg, fb_width, fb_height, resized) = match read_result {
                Ok(Ok(value)) => value,
                Ok(Err(e)) if RfbConnection::is_timeout_error(&e) => continue,
                Ok(Err(e)) => {
                    let (code, retryable) = classify_vnc_runtime_error(&e);
                    let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                        reason: e.clone(),
                        code,
                        retryable,
                    })
                    .unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json));
                    break;
                }
                Err(e) => {
                    let _ = ws_out.send(WsOutgoing::Text(
                        serde_json::to_string(&WsOutgoingText::Disconnected {
                            reason: format!("VNC reader worker failed: {}", e),
                            code: "runtime-worker",
                            retryable: true,
                        })
                        .unwrap(),
                    ));
                    break;
                }
            };
            match msg {
                ServerMessage::FramebufferUpdate { rects } => {
                    let frame_id = next_frame_id;
                    next_frame_id = next_frame_id.wrapping_add(1).max(1);
                    if resized {
                        let resize = WsOutgoingText::Resize {
                            frame_id,
                            width: fb_width,
                            height: fb_height,
                        };
                        if let Ok(json) = serde_json::to_string(&resize) {
                            let _ = ws_out.send(WsOutgoing::Text(json));
                        }
                    }
                    {
                        let mut writer = rfb_writer_for_read.lock().await;
                        writer.set_framebuffer_size(fb_width, fb_height);
                    }
                    for rect in rects {
                        let DecodedRect::Pixels { x, y, w, h, rgba } = rect;
                        let mut frame = Vec::with_capacity(12 + rgba.len());
                        frame.extend_from_slice(&make_frame_header(x, y, w, h, frame_id));
                        frame.extend_from_slice(&rgba);
                        let _ = ws_out.send(WsOutgoing::Frame(frame));
                    }
                    let _ = ws_out.send(WsOutgoing::FrameEnd(frame_id));
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json));
                }
                ServerMessage::ServerCutText { text } => {
                    if server_output_options
                        .clipboard_policy
                        .allows_server_to_client()
                        && text.len() <= server_output_options.max_clipboard_bytes
                    {
                        log::info!("vnc.clip: server→client legacy cut text len={}", text.len(),);
                        let json =
                            serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                        let _ = ws_out.send(WsOutgoing::Text(json));
                    }
                }
                ServerMessage::ExtendedClipboard(ext) => {
                    log::info!("vnc.clip: server→client ext clipboard event");
                    handle_server_ext_clipboard(
                        ext,
                        &server_caps_read,
                        &latest_clipboard_read,
                        &writer_for_caps,
                        &ws_out,
                        server_output_options,
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
    let control_options = options;
    let frame_queue_ctrl = ws_out_tx.clone();
    let delivered_frame_ctrl = last_delivered_frame.clone();
    let vnc_ctrl = tokio::spawn(async move {
        let mut deferred_ctrl: Option<VncControl> = None;
        let mut last_pointer_buttons = 0u8;
        let mut last_acked_frame = 0u32;
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
            if let VncControl::Pointer { buttons, .. } = &ctrl {
                last_pointer_buttons = *buttons;
            }
            let result = match ctrl {
                VncControl::Ack { frame_id } => {
                    let delivered = delivered_frame_ctrl.load(std::sync::atomic::Ordering::Acquire);
                    if frame_id != 0 && (frame_id != delivered || frame_id == last_acked_frame) {
                        Ok(())
                    } else {
                        last_acked_frame = frame_id;
                        let incremental = !frame_queue_ctrl.take_frame_drop();
                        with_writer(rfb_ctrl.clone(), move |w| w.request_update(incremental)).await
                    }
                }
                VncControl::Key { .. } if control_options.view_only => Ok(()),
                VncControl::Key { down, keysym } => {
                    with_writer(rfb_ctrl.clone(), move |w| w.send_key_event(down, keysym)).await
                }
                VncControl::Pointer { .. } if control_options.view_only => Ok(()),
                VncControl::Pointer { x, y, buttons } => {
                    with_writer(rfb_ctrl.clone(), move |w| {
                        w.send_pointer_event(x, y, buttons)
                    })
                    .await
                }
                VncControl::Clipboard(_)
                    if !control_options.clipboard_policy.allows_client_to_server() =>
                {
                    Ok(())
                }
                VncControl::Clipboard(text) => {
                    log::debug!("vnc.clip: relay→server legacy cut text len={}", text.len());
                    with_writer(rfb_ctrl.clone(), move |w| w.send_client_cut_text(&text)).await
                }
                VncControl::ExtendedClipboard(_)
                    if !control_options.clipboard_policy.allows_client_to_server() =>
                {
                    Ok(())
                }
                VncControl::ExtendedClipboard(formats) => {
                    let server_caps = *server_caps_ctrl.lock().await;
                    *latest_clipboard_ctrl.lock().await = Some(formats.clone());
                    if server_caps.formats == 0 {
                        // No caps received — server doesn't support ExtendedClipboard.
                        // Send UTF-8 bytes via legacy ClientCutText. RFC 6143 nominally
                        // specifies Latin-1, but vino and most modern servers accept UTF-8
                        // and write it directly into the X11 selection (which is UTF-8).
                        if let Some(text) = formats.text {
                            log::info!(
                                "vnc.clip: relay→server FALLBACK (no ext caps), sending legacy cut text (UTF-8) len={}",
                                text.len(),
                            );
                            with_writer(rfb_ctrl.clone(), move |w| w.send_client_cut_text(&text))
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
                        if filtered.format_mask() == 0 {
                            log::info!(
                                "vnc.clip: relay→server skip — server caps {:b} don't overlap with our payload",
                                server_caps.formats,
                            );
                            Ok(())
                        } else {
                            log::info!(
                                "vnc.clip: relay→server ext (server caps fmt={:b} actions={:b}) text_len={}",
                                server_caps.formats,
                                server_caps.actions,
                                filtered.text.as_deref().map(str::len).unwrap_or(0),
                            );
                            if can_send_notify(server_caps) {
                                let body = build_notify_body(filtered.format_mask());
                                with_writer(rfb_ctrl.clone(), move |w| {
                                    w.send_extended_clipboard(&body)
                                })
                                .await
                            } else if can_send_provide(server_caps) {
                                match build_provide_body(&filtered) {
                                    Ok(body) => {
                                        with_writer(rfb_ctrl.clone(), move |w| {
                                            w.send_extended_clipboard(&body)
                                        })
                                        .await
                                    }
                                    Err(e) => Err(e),
                                }
                            } else {
                                Ok(())
                            }
                        }
                    }
                }
                VncControl::Resize { .. } => {
                    with_writer(rfb_ctrl.clone(), |w| w.request_update(false)).await
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
    let idle_watch = tokio::spawn(async move {
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
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        r = ws_write => {
            if let Err(e) = r { tracing::error!("ws_write: {}", e); }
        }
        r = ws_read => {
            if let Err(e) = r { tracing::error!("ws_read: {}", e); }
        }
        r = vnc_read => {
            if let Err(e) = r { tracing::error!("vnc_read: {}", e); }
        }
        r = vnc_ctrl => {
            if let Err(e) = r { tracing::error!("vnc_ctrl: {}", e); }
        }
        r = idle_watch => {
            if let Err(e) = r { tracing::error!("idle_watch: {}", e); }
        }
    }

    cancel.cancel();
    if let Some(bridge) = transport_bridge.take() {
        bridge.abort();
    }
    Ok(())
}

/// Establish the same transport used by the other clients before handing the
/// socket to the synchronous RFB protocol worker. HTTP CONNECT and SOCKS5 can
/// be converted directly to a std stream. SSH jump hosts are bridged through a
/// private loopback listener so the existing async russh transport remains
/// isolated from the blocking decoder.
pub(crate) async fn establish_vnc_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
    cancel: &CancellationToken,
) -> Result<(std::net::TcpStream, Option<tokio::task::JoinHandle<()>>), String> {
    let proxy_kind = network.map(|n| n.proxy_kind.as_str()).unwrap_or("none");
    if proxy_kind != "ssh-tunnel" {
        let routed = tokio::time::timeout(
            crate::vnc::rfb::VNC_CONNECT_TIMEOUT,
            establish_transport(host, port, network),
        )
        .await
        .map_err(|_| {
            format!(
                "VNC transport timed out after {} seconds",
                crate::vnc::rfb::VNC_CONNECT_TIMEOUT.as_secs()
            )
        })??;
        let std_stream = routed
            .into_std()
            .map_err(|e| format!("convert VNC transport to blocking stream: {}", e))?;
        return Ok((std_stream, None));
    }

    let network = network.ok_or_else(|| "SSH tunnel settings are missing".to_string())?;
    let ssh = tokio::time::timeout(
        Duration::from_secs(30),
        build_ssh_transport(host, port, Some(network)),
    )
    .await
    .map_err(|_| "VNC SSH jump transport timed out after 30 seconds".to_string())??;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind VNC SSH bridge: {}", e))?;
    let bridge_addr = listener
        .local_addr()
        .map_err(|e| format!("VNC SSH bridge address: {}", e))?;
    let bridge_cancel = cancel.clone();
    let bridge = tokio::spawn(async move {
        let accepted = tokio::select! {
            result = listener.accept() => result,
            _ = bridge_cancel.cancelled() => return,
        };
        let Ok((mut local, _)) = accepted else {
            return;
        };
        let mut remote = ssh;
        let _ = copy_bidirectional(&mut local, &mut remote).await;
    });
    let local = tokio::time::timeout(
        crate::vnc::rfb::VNC_CONNECT_TIMEOUT,
        TokioTcpStream::connect(bridge_addr),
    )
    .await
    .map_err(|_| "VNC SSH bridge connect timed out".to_string())?
    .map_err(|e| format!("connect VNC SSH bridge: {}", e))?;
    let std_stream = local
        .into_std()
        .map_err(|e| format!("convert VNC SSH bridge to blocking stream: {}", e))?;
    Ok((std_stream, Some(bridge)))
}

// ── Helpers ─────────────────────────────────────────────────────────

async fn with_writer<T, F>(writer: Arc<AsyncMutex<RfbWriter>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut RfbWriter) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut writer = writer.blocking_lock();
        operation(&mut writer)
    })
    .await
    .map_err(|e| format!("VNC writer worker failed: {}", e))?
}

async fn accept_authorized_ws(
    listener: &TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-vnc.{ws_token}");
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return Err(format!("VNC accept: {e}")),
                Err(_) => {
                    tracing::warn!("VNC WS accept timed out after {:?}", WS_ACCEPT_TIMEOUT);
                    return Err("VNC WebSocket authorization timed out".to_string());
                }
            },
            _ = cancel.cancelled() => return Err("VNC relay cancelled".to_string()),
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
                HeaderValue::from_str(&protocol).expect("generated VNC WS protocol is valid"),
            );
            Ok(response)
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_WS_INCOMING_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_WS_INCOMING_MESSAGE_BYTES));
        match tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config)).await
        {
            Ok(ws) => return Ok(ws),
            Err(e) => tracing::warn!("rejected unauthorized VNC WebSocket attempt: {e}"),
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
            "http://localhost:1980",
            "http://127.0.0.1:1980",
            "http://localhost:5000",
            "http://127.0.0.1:5000",
        ]
        .contains(&origin);
    }
    false
}

/// Drive the ExtendedClipboard handshake on receipt of a server message.
async fn handle_server_ext_clipboard(
    msg: ExtendedClipboardMsg,
    server_caps: &Arc<AsyncMutex<ServerClipboardCaps>>,
    latest_local_clipboard: &Arc<AsyncMutex<Option<ClipboardFormats>>>,
    writer: &Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out: &WsOutgoingSender,
    options: VncClientOptions,
) {
    let mut our_caps = FORMAT_TEXT;
    if options.allow_html_clipboard {
        our_caps |= FORMAT_HTML;
    }
    if options.allow_rtf_clipboard {
        our_caps |= FORMAT_RTF;
    }
    if options.clipboard_policy == ClipboardPolicy::Disabled {
        our_caps = 0;
    }
    let max_size = options.max_clipboard_bytes as u32;

    match msg {
        ExtendedClipboardMsg::Caps {
            formats, actions, ..
        } => {
            log::info!(
                "vnc.clip: ← Caps from server formats={:b} actions={:b} (negotiated {:b})",
                formats,
                actions,
                formats & our_caps,
            );
            *server_caps.lock().await = ServerClipboardCaps {
                formats: formats & our_caps,
                actions,
            };
            // Reply with our caps so the server knows what to deliver.
            let body = build_caps_body(our_caps, max_size);
            log::info!(
                "vnc.clip: → Caps to server formats={:b} actions={:b}",
                our_caps,
                SUPPORTED_ACTIONS,
            );
            let _ = with_writer(writer.clone(), move |w| w.send_extended_clipboard(&body)).await;
            // Tell the frontend which clipboard path is active so diagnostics
            // can distinguish ExtendedClipboard from the legacy fallback.
            let support = WsOutgoingText::ExtClipboardSupport {
                available: (formats & our_caps) != 0
                    && (actions & (ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE)) != 0,
            };
            if let Ok(json) = serde_json::to_string(&support) {
                let _ = ws_out.send(WsOutgoing::Text(json));
            }
        }
        ExtendedClipboardMsg::Notify { formats } => {
            if !options.clipboard_policy.allows_server_to_client() {
                return;
            }
            let want = formats & our_caps;
            let caps = *server_caps.lock().await;
            log::info!(
                "vnc.clip: ← Notify from server formats={:b}, requesting={:b}",
                formats,
                want,
            );
            if want != 0 && can_send_request(caps) {
                let body = build_request_body(want);
                let _ =
                    with_writer(writer.clone(), move |w| w.send_extended_clipboard(&body)).await;
            }
        }
        ExtendedClipboardMsg::Provide {
            formats: _,
            formats_data,
        } => {
            if !options.clipboard_policy.allows_server_to_client() {
                return;
            }
            let formats_data = filter_configured_clipboard_formats(formats_data, options);
            if !clipboard_formats_within_limit(&formats_data, options.max_clipboard_bytes) {
                log::warn!(
                    "vnc.clip: server clipboard payload exceeds configured {} byte limit",
                    options.max_clipboard_bytes
                );
                return;
            }
            log::info!(
                "vnc.clip: ← Provide from server text_len={} html_len={} rtf_len={}",
                formats_data.text.as_deref().map(str::len).unwrap_or(0),
                formats_data.html.as_deref().map(str::len).unwrap_or(0),
                formats_data.rtf.as_deref().map(str::len).unwrap_or(0),
            );
            let json = serde_json::to_string(&WsOutgoingText::ExtClipboard {
                text: formats_data.text,
                html: formats_data.html,
                rtf: formats_data.rtf,
            })
            .unwrap();
            let _ = ws_out.send(WsOutgoing::Text(json));
        }
        ExtendedClipboardMsg::Request { formats } => {
            if !options.clipboard_policy.allows_client_to_server() {
                return;
            }
            log::info!("vnc.clip: ← Request from server formats={:b}", formats);
            let cached = latest_local_clipboard.lock().await.clone();
            if let Some(data) = cached {
                let filtered = filter_clipboard_formats(data, formats & our_caps);
                if filtered.format_mask() != 0 {
                    if let Ok(body) = build_provide_body(&filtered) {
                        let _ =
                            with_writer(writer.clone(), move |w| w.send_extended_clipboard(&body))
                                .await;
                    }
                }
            }
        }
        ExtendedClipboardMsg::Peek => {
            if !options.clipboard_policy.allows_client_to_server() {
                return;
            }
            log::info!("vnc.clip: ← Peek from server");
            let formats = latest_local_clipboard
                .lock()
                .await
                .as_ref()
                .map(|data| data.format_mask() & our_caps)
                .unwrap_or(0);
            let body = build_notify_body(formats);
            let _ = with_writer(writer.clone(), move |w| w.send_extended_clipboard(&body)).await;
        }
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

fn filter_configured_clipboard_formats(
    data: ClipboardFormats,
    options: VncClientOptions,
) -> ClipboardFormats {
    ClipboardFormats {
        text: data.text,
        html: options.allow_html_clipboard.then_some(data.html).flatten(),
        rtf: options.allow_rtf_clipboard.then_some(data.rtf).flatten(),
    }
}

fn clipboard_formats_within_limit(data: &ClipboardFormats, max_bytes: usize) -> bool {
    [
        data.text.as_deref(),
        data.html.as_deref(),
        data.rtf.as_deref(),
    ]
    .into_iter()
    .flatten()
    .all(|value| value.len() <= max_bytes)
}

fn control_allowed(control: &VncControl, options: VncClientOptions) -> bool {
    match control {
        VncControl::Key { .. } | VncControl::Pointer { .. } => !options.view_only,
        VncControl::Clipboard(text) => {
            options.clipboard_policy.allows_client_to_server()
                && text.len() <= options.max_clipboard_bytes
        }
        VncControl::ExtendedClipboard(formats) => {
            options.clipboard_policy.allows_client_to_server()
                && clipboard_formats_within_limit(formats, options.max_clipboard_bytes)
        }
        VncControl::Resize { .. } | VncControl::Ack { .. } | VncControl::Disconnect => true,
    }
}

fn classify_vnc_runtime_error(error: &str) -> (&'static str, bool) {
    let lower = error.to_ascii_lowercase();
    if lower.contains("authentication") || lower.contains("security policy") {
        return ("authentication", false);
    }
    if lower.contains("invalid")
        || lower.contains("unsupported")
        || lower.contains("exceed")
        || lower.contains("overflow")
        || lower.contains("decode")
        || lower.contains("encoding")
    {
        return ("protocol", false);
    }
    if RfbConnection::is_timeout_error(error) {
        return ("runtime-timeout", true);
    }
    ("runtime-network", true)
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
        0 if bytes.len() == 5 => Some(VncControl::Ack {
            frame_id: u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]),
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
        4 if bytes.len() == 5 => Some(VncControl::Resize {
            width: u16::from_be_bytes([bytes[1], bytes[2]]),
            height: u16::from_be_bytes([bytes[3], bytes[4]]),
        }),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_control_decodes_key_pointer_and_resize() {
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

        match parse_binary_control(&[4, 0x05, 0x00, 0x03, 0x20]) {
            Some(VncControl::Resize { width, height }) => {
                assert_eq!(width, 1280);
                assert_eq!(height, 800);
            }
            other => panic!("expected resize control, got {:?}", other),
        }
    }

    #[test]
    fn binary_control_decodes_ack_and_ignores_ping() {
        assert!(matches!(
            parse_binary_control(&[0]),
            Some(VncControl::Ack { frame_id: 0 })
        ));
        assert!(matches!(
            parse_binary_control(&[0, 0x12, 0x34, 0x56, 0x78]),
            Some(VncControl::Ack {
                frame_id: 0x1234_5678
            })
        ));
        assert!(parse_binary_control(&[1]).is_none());
        assert!(parse_binary_control(&[3, 0]).is_none());
    }

    #[tokio::test]
    async fn output_queue_replaces_stale_frame_with_latest_frame() {
        let (sender, mut receiver) = WsOutgoingQueue::new();
        sender.send(WsOutgoing::Frame(vec![1])).unwrap();
        sender.send(WsOutgoing::FrameEnd(1)).unwrap();
        sender.send(WsOutgoing::Frame(vec![2])).unwrap();
        sender.send(WsOutgoing::FrameEnd(2)).unwrap();

        assert!(
            matches!(receiver.recv().await, Some(WsOutgoing::Frame(bytes)) if bytes == vec![2])
        );
        assert!(matches!(
            receiver.recv().await,
            Some(WsOutgoing::FrameEnd(2))
        ));
        assert!(sender.take_frame_drop());
    }

    #[tokio::test]
    async fn output_queue_prioritizes_control_messages_over_frames() {
        let (sender, mut receiver) = WsOutgoingQueue::new();
        sender
            .send(WsOutgoing::Frame(vec![1, 2, 3]))
            .expect("frame enqueue");
        sender.send(WsOutgoing::FrameEnd(7)).expect("frame commit");
        sender
            .send(WsOutgoing::Text("control".to_string()))
            .expect("control enqueue");

        assert!(matches!(receiver.recv().await, Some(WsOutgoing::Text(text)) if text == "control"));
        assert!(
            matches!(receiver.recv().await, Some(WsOutgoing::Frame(bytes)) if bytes == vec![1, 2, 3])
        );
        assert!(matches!(
            receiver.recv().await,
            Some(WsOutgoing::FrameEnd(7))
        ));
    }

    #[tokio::test]
    async fn output_queue_commits_an_empty_frame_after_oversize_drop() {
        let (sender, mut receiver) = WsOutgoingQueue::new();
        sender
            .send(WsOutgoing::Frame(vec![0; MAX_WS_FRAME_BATCH_BYTES + 1]))
            .unwrap();
        sender.send(WsOutgoing::FrameEnd(9)).unwrap();

        assert!(matches!(
            receiver.recv().await,
            Some(WsOutgoing::FrameEnd(9))
        ));
        assert!(sender.take_frame_drop());
    }

    #[tokio::test]
    async fn output_queue_fails_closed_without_blocking_on_control_overflow() {
        let (sender, receiver) = WsOutgoingQueue::new();
        for index in 0..MAX_PENDING_WS_CONTROL {
            sender.send(WsOutgoing::Text(index.to_string())).unwrap();
        }
        assert!(
            sender
                .send(WsOutgoing::Text("overflow".to_string()))
                .is_err()
        );
        assert!(receiver.queue.recv().await.is_none());
    }

    #[test]
    fn control_policy_enforces_view_only_clipboard_direction_and_size() {
        let view_only = VncClientOptions {
            view_only: true,
            ..VncClientOptions::default()
        };
        assert!(!control_allowed(
            &VncControl::Key {
                down: true,
                keysym: 0xff0d,
            },
            view_only,
        ));
        assert!(!control_allowed(
            &VncControl::Pointer {
                x: 1,
                y: 2,
                buttons: 1,
            },
            view_only,
        ));

        let receive_only = VncClientOptions {
            clipboard_policy: ClipboardPolicy::ServerToClient,
            ..VncClientOptions::default()
        };
        assert!(!control_allowed(
            &VncControl::Clipboard("allowed-size".to_string()),
            receive_only,
        ));

        let limited = VncClientOptions {
            max_clipboard_bytes: 4,
            ..VncClientOptions::default()
        };
        assert!(control_allowed(
            &VncControl::Clipboard("four".to_string()),
            limited,
        ));
        assert!(!control_allowed(
            &VncControl::Clipboard("five!".to_string()),
            limited,
        ));
        assert!(!control_allowed(
            &VncControl::ExtendedClipboard(ClipboardFormats {
                text: Some("ok".to_string()),
                html: Some("12345".to_string()),
                rtf: None,
            }),
            limited,
        ));
    }

    #[test]
    fn clipboard_format_filter_requires_explicit_html_and_rtf_options() {
        let data = ClipboardFormats {
            text: Some("text".to_string()),
            html: Some("<b>html</b>".to_string()),
            rtf: Some("{\\rtf1}".to_string()),
        };
        let text_only =
            filter_configured_clipboard_formats(data.clone(), VncClientOptions::default());
        assert_eq!(text_only.text.as_deref(), Some("text"));
        assert!(text_only.html.is_none());
        assert!(text_only.rtf.is_none());

        let rich = filter_configured_clipboard_formats(
            data,
            VncClientOptions {
                allow_html_clipboard: true,
                allow_rtf_clipboard: true,
                ..VncClientOptions::default()
            },
        );
        assert!(rich.html.is_some());
        assert!(rich.rtf.is_some());
    }

    #[test]
    fn resize_message_carries_the_frame_id_atomically() {
        let json = serde_json::to_string(&WsOutgoingText::Resize {
            frame_id: 41,
            width: 1920,
            height: 1080,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"resize","frame_id":41,"width":1920,"height":1080}"#
        );
        assert_eq!(
            &make_frame_header(1, 2, 3, 4, 41)[8..12],
            &41u32.to_be_bytes()
        );
    }

    #[test]
    fn websocket_origin_policy_rejects_untrusted_origins() {
        assert!(is_authorized_origin("tauri://localhost"));
        assert!(is_authorized_origin("http://localhost:5000"));
        assert!(!is_authorized_origin("http://evil.example"));
    }
}

fn make_frame_header(x: u16, y: u16, w: u16, h: u16, frame_id: u32) -> [u8; 12] {
    let mut hdr = [0u8; 12];
    hdr[0..2].copy_from_slice(&x.to_be_bytes());
    hdr[2..4].copy_from_slice(&y.to_be_bytes());
    hdr[4..6].copy_from_slice(&w.to_be_bytes());
    hdr[6..8].copy_from_slice(&h.to_be_bytes());
    hdr[8..12].copy_from_slice(&frame_id.to_be_bytes());
    hdr
}
