use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use tungstenite::Message;

use crate::vnc::clipboard::{
    build_caps_body, build_notify_body, build_provide_body, build_request_body, ClipboardFormats,
    ExtendedClipboardMsg, ACTION_NOTIFY, ACTION_PROVIDE, ACTION_REQUEST,
    ENCODING_EXTENDED_CLIPBOARD, ENCODING_EXTENDED_CLIPBOARD_LEGACY, FORMAT_HTML, FORMAT_RTF,
    FORMAT_TEXT, SUPPORTED_ACTIONS,
};
use crate::vnc::encodings::DecodedRect;
use crate::vnc::rfb::{RfbConnection, RfbWriter, ServerMessage};

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
    Text(String),
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
    },
    #[serde(rename = "disconnected")]
    Disconnected { reason: String },
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
    pub control_tx: UnboundedSender<VncControl>,
    pub ws_port: u16,
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
) -> Result<VncSession, String> {
    let cancel = CancellationToken::new();

    // 1. Connect + handshake + auth
    let mut rfb = RfbConnection::connect(&host, port)?;
    let server_init = rfb.authenticate(username.as_deref(), password.as_deref())?;

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
    let writer = rfb.take_writer()?;

    // 2. Bind WS listener on dynamic port
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind WS: {}", e))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {}", e))?
        .port();
    // 3. Channel setup
    let (control_tx, control_rx) = mpsc::unbounded_channel::<VncControl>();
    let (ws_out_tx, ws_out_rx) = mpsc::unbounded_channel::<WsOutgoing>();

    let rfb = Arc::new(tokio::sync::Mutex::new(rfb));
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // Send connected notification
    let connected = serde_json::to_string(&WsOutgoingText::Connected {
        width: server_init.width,
        height: server_init.height,
        name: server_init.name.clone(),
    })
    .unwrap();
    let _ = ws_out_tx.send(WsOutgoing::Text(connected));

    // 4. Spawn the relay
    let cancel_clone = cancel.clone();
    let control_tx_for_relay = control_tx.clone();
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
        )
        .await
        {
            tracing::error!("VNC relay error: {}", e);
        }
    });

    Ok(VncSession {
        control_tx,
        ws_port,
        cancel,
    })
}

// ── Relay orchestration ─────────────────────────────────────────────

async fn run_relay(
    listener: TcpListener,
    rfb: Arc<tokio::sync::Mutex<RfbConnection>>,
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out_tx: UnboundedSender<WsOutgoing>,
    mut ws_out_rx: UnboundedReceiver<WsOutgoing>,
    control_tx: UnboundedSender<VncControl>,
    mut control_rx: UnboundedReceiver<VncControl>,
    cancel: CancellationToken,
) -> Result<(), String> {
    // Accept one WS connection with a bounded deadline so a webview that never
    // comes up doesn't leave the relay and its TCP connection hanging forever.
    let (stream, _) = tokio::select! {
        r = tokio::time::timeout(WS_ACCEPT_TIMEOUT, listener.accept()) => match r {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return Err(format!("accept: {}", e)),
            Err(_) => {
                tracing::warn!("VNC WS accept timed out after {:?}", WS_ACCEPT_TIMEOUT);
                cancel.cancel();
                return Ok(());
            }
        },
        _ = cancel.cancelled() => return Ok(()),
    };
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("WS upgrade: {}", e))?;

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
    let ws_write = tokio::spawn(async move {
        while let Some(out) = ws_out_rx.recv().await {
            let msg = match out {
                WsOutgoing::Frame(data) => Message::Binary(data.into()),
                WsOutgoing::Text(json) => Message::Text(json.into()),
            };
            if ws_sink.send(msg).await.is_err() {
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
                                    "vnc.clip: ws→relay legacy clipboard, len={} preview={:?}",
                                    text.len(),
                                    truncate_preview(&text, 32),
                                );
                                Some(VncControl::Clipboard(text))
                            }
                            WsIncoming::ExtClipboard { text, html, rtf } => {
                                log::info!(
                                    "vnc.clip: ws→relay ext clipboard text_len={} html_len={} rtf_len={} preview={:?}",
                                    text.as_deref().map(str::len).unwrap_or(0),
                                    html.as_deref().map(str::len).unwrap_or(0),
                                    rtf.as_deref().map(str::len).unwrap_or(0),
                                    text.as_deref().map(|t| truncate_preview(t, 32)).unwrap_or_default(),
                                );
                                Some(VncControl::ExtendedClipboard(ClipboardFormats {
                                    text,
                                    html,
                                    rtf,
                                }))
                            }
                            WsIncoming::Resize { width, height } => {
                                Some(VncControl::Resize { width, height })
                            }
                        };
                        if let Some(m) = ctrl_msg {
                            let _ = ctrl.send(m);
                        }
                    }
                }
                Message::Binary(bytes) => {
                    if let Some(ctrl_msg) = parse_binary_control(&bytes) {
                        let _ = ctrl.send(ctrl_msg);
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.send(VncControl::Disconnect);
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
    let vnc_read = tokio::spawn(async move {
        loop {
            if cancel_vnc.is_cancelled() {
                break;
            }
            let (msg, fb_width, fb_height) = {
                let mut conn = rfb_read.lock().await;
                match conn.read_server_message() {
                    Ok(m) => (m, conn.width, conn.height),
                    Err(e) => {
                        let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                            reason: e.clone(),
                        })
                        .unwrap();
                        let _ = ws_out.send(WsOutgoing::Text(json));
                        break;
                    }
                }
            };
            match msg {
                ServerMessage::FramebufferUpdate { rects } => {
                    {
                        let mut writer = rfb_writer_for_read.lock().await;
                        writer.set_framebuffer_size(fb_width, fb_height);
                    }
                    for rect in rects {
                        let DecodedRect::Pixels { x, y, w, h, rgba } = rect;
                        let mut frame = Vec::with_capacity(12 + rgba.len());
                        frame.extend_from_slice(&make_frame_header(x, y, w, h));
                        frame.extend_from_slice(&rgba);
                        let _ = ws_out.send(WsOutgoing::Frame(frame));
                    }
                    let _ = ws_out.send(WsOutgoing::Frame(Vec::new()));
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json));
                }
                ServerMessage::ServerCutText { text } => {
                    log::info!(
                        "vnc.clip: server→client legacy cut text len={} preview={:?}",
                        text.len(),
                        truncate_preview(&text, 32),
                    );
                    let json = serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json));
                }
                ServerMessage::ExtendedClipboard(ext) => {
                    log::info!("vnc.clip: server→client ext clipboard {:?}", &ext);
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
    let vnc_ctrl = tokio::spawn(async move {
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
                VncControl::Resize { .. } => rfb_ctrl.lock().await.request_update(false),
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
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Drive the ExtendedClipboard handshake on receipt of a server message.
async fn handle_server_ext_clipboard(
    msg: ExtendedClipboardMsg,
    server_caps: &Arc<AsyncMutex<ServerClipboardCaps>>,
    latest_local_clipboard: &Arc<AsyncMutex<Option<ClipboardFormats>>>,
    writer: &Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out: &UnboundedSender<WsOutgoing>,
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
                let _ = ws_out.send(WsOutgoing::Text(json));
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
                "vnc.clip: ← Provide from server text_len={} html_len={} rtf_len={} preview={:?}",
                formats_data.text.as_deref().map(str::len).unwrap_or(0),
                formats_data.html.as_deref().map(str::len).unwrap_or(0),
                formats_data.rtf.as_deref().map(str::len).unwrap_or(0),
                formats_data
                    .text
                    .as_deref()
                    .map(|t| truncate_preview(t, 32))
                    .unwrap_or_default(),
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
        4 if bytes.len() == 5 => Some(VncControl::Resize {
            width: u16::from_be_bytes([bytes[1], bytes[2]]),
            height: u16::from_be_bytes([bytes[3], bytes[4]]),
        }),
        _ => None,
    }
}

fn coalesce_pointer_control(
    ctrl: VncControl,
    control_rx: &mut UnboundedReceiver<VncControl>,
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
        assert!(matches!(parse_binary_control(&[0]), Some(VncControl::Ack)));
        assert!(parse_binary_control(&[1]).is_none());
        assert!(parse_binary_control(&[3, 0]).is_none());
    }
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

/// Trim a string to at most `max_chars` characters for log output without
/// breaking grapheme boundaries.
fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let mut out: String = (&mut chars).take(max_chars).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}
