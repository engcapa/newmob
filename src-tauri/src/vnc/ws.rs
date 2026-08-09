use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode, header};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use uuid::Uuid;

use crate::terminal::network::NetworkSettings;
use crate::vnc::clipboard::{
    ACTION_NOTIFY, ACTION_PROVIDE, ACTION_REQUEST, ClipboardFormats, ENCODING_EXTENDED_CLIPBOARD,
    ENCODING_EXTENDED_CLIPBOARD_LEGACY, ExtendedClipboardMsg, FORMAT_HTML, FORMAT_RTF, FORMAT_TEXT,
    SUPPORTED_ACTIONS, build_caps_body, build_notify_body, build_provide_body, build_request_body,
};
use crate::vnc::encodings::DecodedRect;
use crate::vnc::policy::{VncClipboardPolicy, VncSecurityPolicy, security_type_kind};
use crate::vnc::queue::{FrameQueueReceiver, FrameQueueSender, QueuedWsOutgoing};
use crate::vnc::rfb::{RfbConnection, RfbWriter, ServerMessage};

/// Deadline for the frontend to complete its WebSocket upgrade after we bind.
const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum time without a ping from the frontend before we tear down.
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the idle watchdog checks the last-seen timestamp.
const WS_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const VNC_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const VNC_WS_PATH: &str = "/vnc";

// ── Messages for internal channels ──────────────────────────────────

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
    Refresh,
    Ack,
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
    #[serde(rename = "refresh")]
    Refresh,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum WsOutgoingText {
    #[serde(rename = "connected")]
    Connected {
        width: u16,
        height: u16,
        name: String,
        protocol: String,
        security: String,
        encrypted: bool,
    },
    #[serde(rename = "desktop_size")]
    DesktopSize {
        width: u16,
        height: u16,
        generation: u64,
    },
    #[serde(rename = "disconnected")]
    Disconnected {
        code: &'static str,
        stage: crate::vnc::error::VncStage,
        retryable: bool,
        reason: String,
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
    pub network_forward_task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for VncSession {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.network_forward_task.as_ref() {
            task.abort();
        }
    }
}

pub(crate) struct VncDialedTransport {
    pub stream: std::net::TcpStream,
    pub network_forward_task: Option<tokio::task::JoinHandle<()>>,
}

struct ForwardTaskGuard(Option<tokio::task::JoinHandle<()>>);

impl Drop for ForwardTaskGuard {
    fn drop(&mut self) {
        if let Some(task) = self.0.as_ref() {
            task.abort();
        }
    }
}

pub(crate) async fn dial_vnc_transport(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<VncDialedTransport, String> {
    tokio::time::timeout(VNC_CONNECT_TIMEOUT, async move {
        let network_forward = match network.as_ref() {
            Some(settings) if settings.proxy_kind != "none" && !settings.proxy_kind.is_empty() => {
                Some(crate::database::forward::start(host.clone(), port, settings.clone()).await?)
            }
            _ => None,
        };
        let local_port = network_forward.as_ref().map(|forward| forward.local_port);
        let mut forward_guard = ForwardTaskGuard(network_forward.map(|forward| forward.task));
        let socket = match local_port {
            Some(local_port) => TcpStream::connect(("127.0.0.1", local_port))
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
            None => crate::terminal::network::establish_transport(&host, port, network.as_ref())
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
        };
        let stream = socket
            .into_std()
            .map_err(|e| format!("VNC transport conversion failed: {e}"))?;
        Ok(VncDialedTransport {
            stream,
            network_forward_task: forward_guard.0.take(),
        })
    })
    .await
    .map_err(|_| "VNC TCP connection timed out after 15 seconds".to_string())?
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
    security_policy: VncSecurityPolicy,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
) -> Result<VncSession, String> {
    let cancel = CancellationToken::new();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    // 1. Connect + handshake + auth. Route proxy and SSH-jump connections
    // through the shared loopback forwarder, allowing the synchronous RA2
    // framing code to keep its tested std::net transport while the upstream
    // network path remains fully asynchronous and cancellable.
    let transport = dial_vnc_transport(host, port, network).await?;
    let mut network_forward_guard = ForwardTaskGuard(transport.network_forward_task);
    let std_stream = transport.stream;
    let (rfb, writer, server_init) = tokio::task::spawn_blocking(move || {
        let mut rfb = RfbConnection::from_stream(
            std_stream,
            Duration::from_secs(15),
            security_policy,
            crate::vnc::limits::DecodeLimits::default(),
        )?;
        let server_init = rfb.authenticate_with_policy(
            username.as_deref(),
            password.as_deref(),
            security_policy,
        )?;
        rfb.set_pixel_format_rgba()?;
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
        let writer = rfb.take_writer()?;
        Ok::<_, String>((rfb, writer, server_init))
    })
    .await
    .map_err(|e| format!("VNC handshake worker failed: {e}"))??;

    // Encoding preference: ZRLE (bandwidth) > Hextile (tile cache) > CopyRect
    // (scroll) > Raw (fallback). DesktopSize must be listed so server-driven
    // resolution changes keep working. Tight is intentionally omitted — the
    // decoder in encodings.rs is not RFC-compliant and would desync the stream.
    // ExtendedClipboard is a pseudo-encoding advertising support for
    // multi-format clipboard exchange (HTML/RTF/UTF-8); the server only sends
    // extended ClientCutText when both sides have advertised it.
    // 2. Bind WS listener on dynamic port
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind WS: {}", e))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {}", e))?
        .port();
    // 3. Channel setup
    let limits = crate::vnc::limits::DecodeLimits::default();
    let (control_tx, control_rx) = mpsc::channel::<VncControl>(limits.max_control_queue);
    let (ws_out_tx, ws_out_rx) = FrameQueueSender::new(limits);

    // Send connected notification with the actual negotiated security, never
    // just the requested policy.
    let negotiated = rfb.security_type.and_then(security_type_kind);
    let connected = serde_json::to_string(&WsOutgoingText::Connected {
        width: server_init.width,
        height: server_init.height,
        name: server_init.name.clone(),
        protocol: rfb.protocol_version(),
        security: negotiated
            .map(|kind| kind.label())
            .unwrap_or("Unknown")
            .to_string(),
        encrypted: negotiated.is_some_and(|kind| kind.encrypted()),
    })
    .unwrap();
    let _ = ws_out_tx.send_critical_control(connected);
    let shutdown_stream = rfb.shutdown_handle()?;
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

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
            shutdown_stream,
            view_only,
            clipboard_policy,
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
        network_forward_task: network_forward_guard.0.take(),
    })
}

// ── Relay orchestration ─────────────────────────────────────────────

async fn run_relay(
    listener: TcpListener,
    mut rfb: RfbConnection,
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out_tx: FrameQueueSender,
    ws_out_rx: FrameQueueReceiver,
    control_tx: Sender<VncControl>,
    mut control_rx: Receiver<VncControl>,
    cancel: CancellationToken,
    ws_token: String,
    shutdown_stream: std::net::TcpStream,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
) -> Result<(), String> {
    let ws_stream = accept_authorized_ws(listener, &ws_token, &cancel).await?;

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
    let mut ws_write = tokio::spawn(async move {
        while let Some(out) = ws_out_rx.recv().await {
            match out {
                QueuedWsOutgoing::Control(json) => {
                    if ws_sink.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                QueuedWsOutgoing::Frame(rects) => {
                    let mut failed = false;
                    for data in rects {
                        if ws_sink.send(Message::Binary(data.into())).await.is_err() {
                            failed = true;
                            break;
                        }
                    }
                    if failed
                        || ws_sink
                            .send(Message::Binary(Vec::new().into()))
                            .await
                            .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    // Task: read WS messages → control_tx
    let ctrl = control_tx.clone();
    let cancel_read = cancel.clone();
    let last_seen_read = last_seen.clone();
    let control_limits = crate::vnc::limits::DecodeLimits::default();
    let mut ws_read = tokio::spawn(async move {
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
                            WsIncoming::Ack => Some(VncControl::Ack),
                            WsIncoming::Ping => None, // already refreshed last_seen
                            WsIncoming::Key { down, keysym } => {
                                Some(VncControl::Key { down, keysym })
                            }
                            WsIncoming::Pointer { x, y, buttons } => {
                                Some(VncControl::Pointer { x, y, buttons })
                            }
                            WsIncoming::Clipboard { text } => {
                                log::info!(
                                    "vnc.clip: ws→relay legacy clipboard, len={}",
                                    text.len()
                                );
                                Some(VncControl::Clipboard(text))
                            }
                            WsIncoming::ExtClipboard { text, html, rtf } => {
                                log::info!(
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
                            WsIncoming::Refresh => Some(VncControl::Refresh),
                        };
                        if let Some(m) = ctrl_msg
                            && control_allowed(&m, view_only, clipboard_policy, &control_limits)
                            && ctrl.send(m).await.is_err()
                        {
                            break;
                        }
                    }
                }
                Message::Binary(bytes) => {
                    if let Some(ctrl_msg) = parse_binary_control(&bytes)
                        && control_allowed(&ctrl_msg, view_only, clipboard_policy, &control_limits)
                        && ctrl.send(ctrl_msg).await.is_err()
                    {
                        break;
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

    // The RFB decoder is synchronous and may wait on a socket. Keep it on a
    // dedicated blocking worker and bridge decoded messages through a bounded
    // channel so no Tokio executor thread is stalled by a slow server.
    let initial_framebuffer_size = (rfb.width, rfb.height);
    let (server_message_tx, mut server_message_rx) =
        mpsc::channel::<Result<(ServerMessage, u16, u16), String>>(2);
    let cancel_reader = cancel.clone();
    let rfb_reader = tokio::task::spawn_blocking(move || {
        while !cancel_reader.is_cancelled() {
            let result = rfb
                .read_server_message()
                .map(|message| (message, rfb.width, rfb.height));
            let should_stop = result.is_err();
            if server_message_tx.blocking_send(result).is_err() || should_stop {
                break;
            }
        }
    });

    // Task: process decoded server messages and push them to the WS queue.
    let rfb_writer_for_read = writer.clone();
    let ws_out = ws_out_tx.clone();
    let server_caps_read = server_clip_caps.clone();
    let latest_clipboard_read = latest_local_clipboard.clone();
    let writer_for_caps = writer.clone();
    let mut vnc_read = tokio::spawn(async move {
        let mut published_framebuffer_size = initial_framebuffer_size;
        let mut framebuffer_generation = 0u64;
        while let Some(result) = server_message_rx.recv().await {
            let (msg, fb_width, fb_height) = match result {
                Ok(value) => value,
                Err(message) => {
                    let error = crate::vnc::error::VncError::classify(message);
                    let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                        code: error.code,
                        stage: error.stage,
                        retryable: error.retryable,
                        reason: error.message,
                    })
                    .unwrap();
                    let _ = ws_out.send_critical_control(json);
                    break;
                }
            };
            match msg {
                ServerMessage::FramebufferUpdate { rects } => {
                    if (fb_width, fb_height) != published_framebuffer_size {
                        framebuffer_generation = framebuffer_generation.saturating_add(1);
                        published_framebuffer_size = (fb_width, fb_height);
                        let json = serde_json::to_string(&WsOutgoingText::DesktopSize {
                            width: fb_width,
                            height: fb_height,
                            generation: framebuffer_generation,
                        })
                        .unwrap();
                        let _ = ws_out.send_critical_control(json);
                    }
                    {
                        let mut writer = rfb_writer_for_read.lock().await;
                        writer.set_framebuffer_size(fb_width, fb_height);
                    }
                    for rect in rects {
                        let DecodedRect::Pixels { x, y, w, h, rgba } = rect;
                        let mut frame = Vec::with_capacity(12 + rgba.len());
                        frame.extend_from_slice(&make_frame_header(x, y, w, h));
                        frame.extend_from_slice(&rgba);
                        let _ = ws_out.push_rect(frame);
                    }
                    if ws_out.finish_frame().unwrap_or(false) {
                        let _ = rfb_writer_for_read.lock().await.request_update(false);
                    }
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send_control(json);
                }
                ServerMessage::ServerCutText { text } => {
                    if !clipboard_policy.allows_server_to_client() {
                        continue;
                    }
                    log::info!("vnc.clip: server→client legacy cut text len={}", text.len());
                    let json = serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                    let _ = ws_out.send_control(json);
                }
                ServerMessage::ExtendedClipboard(ext) => {
                    if !server_clipboard_message_allowed(&ext, clipboard_policy) {
                        continue;
                    }
                    log::info!("vnc.clip: server→client ext clipboard message");
                    handle_server_ext_clipboard(
                        ext,
                        &server_caps_read,
                        &latest_clipboard_read,
                        &writer_for_caps,
                        &ws_out,
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
    let dispatch_limits = crate::vnc::limits::DecodeLimits::default();
    let mut vnc_ctrl = tokio::spawn(async move {
        let mut deferred_ctrl: Option<VncControl> = None;
        let mut last_pointer_buttons = 0u8;
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
            if !control_allowed(&ctrl, view_only, clipboard_policy, &dispatch_limits) {
                continue;
            }
            let result = match ctrl {
                VncControl::Ack => rfb_ctrl.lock().await.request_update(true),
                VncControl::Key { down, keysym } => {
                    rfb_ctrl.lock().await.send_key_event(down, keysym)
                }
                VncControl::Pointer { x, y, buttons } => {
                    rfb_ctrl.lock().await.send_pointer_event(x, y, buttons)
                }
                VncControl::Clipboard(text) => {
                    log::debug!("vnc.clip: relay→server legacy cut text len={}", text.len());
                    rfb_ctrl.lock().await.send_client_cut_text(&text)
                }
                VncControl::ExtendedClipboard(formats) => {
                    let server_caps = *server_caps_ctrl.lock().await;
                    *latest_clipboard_ctrl.lock().await = Some(formats.clone());
                    let mut conn = rfb_ctrl.lock().await;
                    if server_caps.formats == 0 {
                        // No caps received — server doesn't support ExtendedClipboard.
                        // Send UTF-8 bytes via legacy ClientCutText. RFC 6143 nominally
                        // specifies Latin-1, but vino and most modern servers accept UTF-8
                        // and write it directly into the X11 selection (which is UTF-8).
                        if let Some(text) = formats.text.as_deref() {
                            log::info!(
                                "vnc.clip: relay→server FALLBACK (no ext caps), sending legacy cut text (UTF-8) len={}",
                                text.len(),
                            );
                            conn.send_client_cut_text(text)
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
                                conn.send_extended_clipboard(&build_notify_body(
                                    filtered.format_mask(),
                                ))
                            } else if can_send_provide(server_caps) {
                                match build_provide_body(&filtered) {
                                    Ok(body) => conn.send_extended_clipboard(&body),
                                    Err(e) => Err(e),
                                }
                            } else {
                                Ok(())
                            }
                        }
                    }
                }
                VncControl::Refresh => rfb_ctrl.lock().await.request_update(false),
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
    tokio::select! {
        _ = cancel.cancelled() => {},
        _ = tokio::signal::ctrl_c() => {},
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
    // Closing the underlying socket interrupts any blocking read immediately;
    // the read timeout remains a backstop for broken platform shutdowns.
    let _ = shutdown_stream.shutdown(std::net::Shutdown::Both);
    rfb_reader.abort();
    ws_write.abort();
    ws_read.abort();
    vnc_read.abort();
    vnc_ctrl.abort();
    idle_watch.abort();
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Drive the ExtendedClipboard handshake on receipt of a server message.
async fn handle_server_ext_clipboard(
    msg: ExtendedClipboardMsg,
    server_caps: &Arc<AsyncMutex<ServerClipboardCaps>>,
    latest_local_clipboard: &Arc<AsyncMutex<Option<ClipboardFormats>>>,
    writer: &Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out: &FrameQueueSender,
) {
    // We support UTF-8 text, RTF, and HTML — call out our caps with a generous
    // 16 MiB ceiling per format.
    const OUR_CAPS: u32 = FORMAT_TEXT | FORMAT_RTF | FORMAT_HTML;
    const MAX_SIZE: u32 = 16 * 1024 * 1024;

    match msg {
        ExtendedClipboardMsg::Caps {
            formats, actions, ..
        } => {
            log::info!(
                "vnc.clip: ← Caps from server formats={:b} actions={:b} (negotiated {:b})",
                formats,
                actions,
                formats & OUR_CAPS,
            );
            *server_caps.lock().await = ServerClipboardCaps {
                formats: formats & OUR_CAPS,
                actions,
            };
            // Reply with our caps so the server knows what to deliver.
            let body = build_caps_body(OUR_CAPS, MAX_SIZE);
            log::info!(
                "vnc.clip: → Caps to server formats={:b} actions={:b}",
                OUR_CAPS,
                SUPPORTED_ACTIONS,
            );
            let mut w = writer.lock().await;
            let _ = w.send_extended_clipboard(&body);
            // Tell the frontend which clipboard path is active so diagnostics
            // can distinguish ExtendedClipboard from the legacy fallback.
            let support = WsOutgoingText::ExtClipboardSupport {
                available: (formats & OUR_CAPS) != 0
                    && (actions & (ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE)) != 0,
            };
            if let Ok(json) = serde_json::to_string(&support) {
                let _ = ws_out.send_control(json);
            }
        }
        ExtendedClipboardMsg::Notify { formats } => {
            let want = formats & OUR_CAPS;
            let caps = *server_caps.lock().await;
            log::info!(
                "vnc.clip: ← Notify from server formats={:b}, requesting={:b}",
                formats,
                want,
            );
            if want != 0 && can_send_request(caps) {
                let body = build_request_body(want);
                let mut w = writer.lock().await;
                let _ = w.send_extended_clipboard(&body);
            }
        }
        ExtendedClipboardMsg::Provide {
            formats: _,
            formats_data,
        } => {
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
            let _ = ws_out.send_control(json);
        }
        ExtendedClipboardMsg::Request { formats } => {
            log::info!("vnc.clip: ← Request from server formats={:b}", formats);
            let cached = latest_local_clipboard.lock().await.clone();
            if let Some(data) = cached {
                let filtered = filter_clipboard_formats(data, formats & OUR_CAPS);
                if filtered.format_mask() != 0 {
                    if let Ok(body) = build_provide_body(&filtered) {
                        let mut w = writer.lock().await;
                        let _ = w.send_extended_clipboard(&body);
                    }
                }
            }
        }
        ExtendedClipboardMsg::Peek => {
            log::info!("vnc.clip: ← Peek from server");
            let formats = latest_local_clipboard
                .lock()
                .await
                .as_ref()
                .map(|data| data.format_mask() & OUR_CAPS)
                .unwrap_or(0);
            let body = build_notify_body(formats);
            let mut w = writer.lock().await;
            let _ = w.send_extended_clipboard(&body);
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
        0 if bytes.len() == 1 => Some(VncControl::Ack),
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
        4 if bytes.len() == 1 => Some(VncControl::Refresh),
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

fn control_allowed(
    control: &VncControl,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    limits: &crate::vnc::limits::DecodeLimits,
) -> bool {
    match control {
        VncControl::Key { .. } | VncControl::Pointer { .. } => !view_only,
        VncControl::Clipboard(text) => {
            clipboard_policy.allows_client_to_server() && limits.clipboard_bytes(text.len()).is_ok()
        }
        VncControl::ExtendedClipboard(formats) => {
            clipboard_policy.allows_client_to_server()
                && [
                    formats.text.as_deref(),
                    formats.html.as_deref(),
                    formats.rtf.as_deref(),
                ]
                .into_iter()
                .flatten()
                .try_fold(0usize, |total, value| {
                    limits.clipboard_bytes(value.len()).ok()?;
                    total.checked_add(value.len())
                })
                .is_some_and(|total| total <= limits.max_clipboard_decompressed_bytes)
        }
        VncControl::Refresh | VncControl::Ack | VncControl::Disconnect => true,
    }
}

fn server_clipboard_message_allowed(
    message: &ExtendedClipboardMsg,
    policy: VncClipboardPolicy,
) -> bool {
    match message {
        ExtendedClipboardMsg::Caps { .. } => true,
        ExtendedClipboardMsg::Request { .. } | ExtendedClipboardMsg::Peek => {
            policy.allows_client_to_server()
        }
        ExtendedClipboardMsg::Notify { .. } | ExtendedClipboardMsg::Provide { .. } => {
            policy.allows_server_to_client()
        }
    }
}

async fn accept_authorized_ws(
    listener: TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-vnc.{ws_token}");
    let relay_limits = crate::vnc::limits::DecodeLimits::default();
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(error)) => return Err(format!("VNC WebSocket accept failed: {error}")),
                Err(_) => {
                    tracing::warn!("VNC WS authorization timed out after {:?}", WS_ACCEPT_TIMEOUT);
                    return Err("VNC WebSocket authorization timed out".into());
                }
            },
            _ = cancel.cancelled() => return Err("VNC relay cancelled".into()),
        };

        let protocol = expected_protocol.clone();
        let callback = move |request: &Request, mut response: Response| {
            let has_protocol = request
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.split(',').any(|item| item.trim() == protocol));
            let origin_ok = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .is_some_and(is_authorized_origin);
            let path_ok = request.uri().path() == VNC_WS_PATH;
            if !has_protocol || !origin_ok || !path_ok {
                let mut rejection = ErrorResponse::new(Some("forbidden".to_string()));
                *rejection.status_mut() = StatusCode::FORBIDDEN;
                return Err(rejection);
            }
            response.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocol).expect("generated VNC protocol is valid"),
            );
            Ok(response)
        };
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(relay_limits.max_relay_message_bytes))
            .max_frame_size(Some(relay_limits.max_relay_message_bytes))
            .max_write_buffer_size(relay_limits.max_frame_queue_bytes);
        match tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config))
            .await
        {
            Ok(socket) => return Ok(socket),
            Err(error) => tracing::warn!("rejected unauthorized VNC WebSocket attempt: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;
    use tokio_tungstenite::connect_async;
    use tungstenite::client::IntoClientRequest;

    fn ws_request(
        port: u16,
        path: &str,
        protocol: &str,
        origin: &'static str,
    ) -> tungstenite::handshake::client::Request {
        let mut request = format!("ws://127.0.0.1:{port}{path}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, HeaderValue::from_static(origin));
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(protocol).unwrap(),
        );
        request
    }

    #[test]
    fn binary_control_decodes_key_pointer_and_refresh() {
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

        assert!(matches!(
            parse_binary_control(&[4]),
            Some(VncControl::Refresh)
        ));
        assert!(parse_binary_control(&[4, 0]).is_none());
    }

    #[test]
    fn binary_control_decodes_ack_and_ignores_ping() {
        assert!(matches!(parse_binary_control(&[0]), Some(VncControl::Ack)));
        assert!(parse_binary_control(&[1]).is_none());
        assert!(parse_binary_control(&[3, 0]).is_none());
    }

    #[test]
    fn backend_enforces_view_only_and_clipboard_direction() {
        let limits = crate::vnc::limits::DecodeLimits::default();
        let key = VncControl::Key {
            down: true,
            keysym: 0x41,
        };
        assert!(!control_allowed(
            &key,
            true,
            VncClipboardPolicy::Bidirectional,
            &limits,
        ));
        assert!(control_allowed(
            &VncControl::Ack,
            true,
            VncClipboardPolicy::Disabled,
            &limits,
        ));
        assert!(!control_allowed(
            &VncControl::Clipboard("secret".into()),
            false,
            VncClipboardPolicy::ServerToClient,
            &limits,
        ));
        assert!(control_allowed(
            &VncControl::Clipboard("ok".into()),
            false,
            VncClipboardPolicy::ClientToServer,
            &limits,
        ));
    }

    #[test]
    fn backend_rejects_oversized_clipboard_controls() {
        let mut limits = crate::vnc::limits::DecodeLimits::default();
        limits.max_clipboard_format_bytes = 4;
        limits.max_clipboard_decompressed_bytes = 6;
        assert!(!control_allowed(
            &VncControl::Clipboard("12345".into()),
            false,
            VncClipboardPolicy::Bidirectional,
            &limits,
        ));
        assert!(!control_allowed(
            &VncControl::ExtendedClipboard(ClipboardFormats {
                text: Some("1234".into()),
                html: Some("5678".into()),
                rtf: None,
            }),
            false,
            VncClipboardPolicy::Bidirectional,
            &limits,
        ));
    }

    #[test]
    fn clipboard_caps_remain_available_for_one_way_client_sync() {
        let caps = ExtendedClipboardMsg::Caps {
            formats: FORMAT_TEXT,
            actions: SUPPORTED_ACTIONS,
            sizes: vec![1024],
        };
        assert!(server_clipboard_message_allowed(
            &caps,
            VncClipboardPolicy::ClientToServer,
        ));
        assert!(!server_clipboard_message_allowed(
            &ExtendedClipboardMsg::Notify {
                formats: FORMAT_TEXT,
            },
            VncClipboardPolicy::ClientToServer,
        ));
    }

    #[test]
    fn relay_origin_allowlist_rejects_untrusted_pages() {
        assert!(is_authorized_origin("tauri://localhost"));
        assert!(!is_authorized_origin("https://attacker.example"));
    }

    #[test]
    fn desktop_size_notification_carries_a_monotonic_generation() {
        let json = serde_json::to_string(&WsOutgoingText::DesktopSize {
            width: 2560,
            height: 1440,
            generation: 3,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"desktop_size","width":2560,"height":1440,"generation":3}"#
        );
    }

    #[tokio::test]
    async fn authenticated_websocket_rejects_bad_requests_and_is_single_use() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = CancellationToken::new();
        let server_cancel = cancel.clone();
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let socket = accept_authorized_ws(listener, "single-use", &server_cancel)
                .await
                .unwrap();
            let _ = accepted_tx.send(());
            let _ = release_rx.await;
            drop(socket);
        });

        assert!(
            connect_async(ws_request(
                port,
                "/vnc",
                "taomni-vnc.wrong",
                "tauri://localhost",
            ))
            .await
            .is_err()
        );
        assert!(
            connect_async(ws_request(
                port,
                "/vnc",
                "taomni-vnc.single-use",
                "https://attacker.example",
            ))
            .await
            .is_err()
        );
        assert!(
            connect_async(ws_request(
                port,
                "/wrong",
                "taomni-vnc.single-use",
                "tauri://localhost",
            ))
            .await
            .is_err()
        );

        let (mut client, response) = connect_async(ws_request(
            port,
            "/vnc",
            "taomni-vnc.single-use",
            "tauri://localhost",
        ))
        .await
        .unwrap();
        assert_eq!(
            response
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok()),
            Some("taomni-vnc.single-use")
        );
        accepted_rx.await.unwrap();

        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            connect_async(ws_request(
                port,
                "/vnc",
                "taomni-vnc.single-use",
                "tauri://localhost",
            )),
        )
        .await;
        assert!(!matches!(second, Ok(Ok(_))));

        let _ = client.close(None).await;
        let _ = release_tx.send(());
        server.await.unwrap();
    }
}

fn is_authorized_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    if cfg!(debug_assertions) {
        return matches!(
            origin,
            "http://localhost:1980"
                | "http://127.0.0.1:1980"
                | "http://localhost:5000"
                | "http://127.0.0.1:5000"
        );
    }
    false
}

fn make_frame_header(x: u16, y: u16, w: u16, h: u16) -> [u8; 12] {
    let mut hdr = [0u8; 12];
    hdr[0..2].copy_from_slice(&x.to_be_bytes());
    hdr[2..4].copy_from_slice(&y.to_be_bytes());
    hdr[4..6].copy_from_slice(&w.to_be_bytes());
    hdr[6..8].copy_from_slice(&h.to_be_bytes());
    // bytes 8-11 reserved (zero)
    hdr
}
