use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_util::sync::CancellationToken;
use tungstenite::Message;

use crate::vnc::encodings::DecodedRect;
use crate::vnc::rfb::{RfbConnection, RfbWriter, ServerMessage};

// ── Messages for internal channels ──────────────────────────────────

/// Outgoing messages from the event loop toward the WebSocket client.
pub enum WsOutgoing {
    Frame(Vec<u8>),
    Text(String),
}

/// Control messages from the WebSocket client toward the VNC event loop.
#[derive(Debug)]
pub enum VncControl {
    Key { down: bool, keysym: u32 },
    Pointer { x: u16, y: u16, buttons: u8 },
    Clipboard(String),
    Resize,
    Ack,
    Disconnect,
}

// ── JSON messages on the wire ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsIncoming {
    #[serde(rename = "ack")]
    Ack,
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
}

// ── Public session handle ───────────────────────────────────────────

pub struct VncSession {
    pub control_tx: UnboundedSender<VncControl>,
    pub ws_port: u16,
    pub cancel: CancellationToken,
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
    // Keep the first working path conservative. The Tight/Hextile readers in
    // this client are not stream-accurate yet, while Raw has an exact length.
    rfb.set_encodings(&[
        0,    // Raw
        -223, // DesktopSize pseudo
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
    // Accept one WS connection
    let (stream, _) = tokio::select! {
        r = listener.accept() => r.map_err(|e| format!("accept: {}", e))?,
        _ = cancel.cancelled() => return Ok(()),
    };
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("WS upgrade: {}", e))?;

    let (mut ws_sink, ws_reader) = ws_stream.split();

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
    let ws_read = tokio::spawn(async move {
        let mut reader = ws_reader;
        while let Some(Ok(msg)) = reader.next().await {
            if cancel_read.is_cancelled() {
                break;
            }
            match msg {
                Message::Text(text) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIncoming>(&text) {
                        let ctrl_msg = match incoming {
                            WsIncoming::Ack => VncControl::Ack,
                            WsIncoming::Key { down, keysym } => VncControl::Key { down, keysym },
                            WsIncoming::Pointer { x, y, buttons } => {
                                VncControl::Pointer { x, y, buttons }
                            }
                            WsIncoming::Clipboard { text } => VncControl::Clipboard(text),
                            WsIncoming::Resize { width, height } => {
                                let _requested_size = (width, height);
                                VncControl::Resize
                            }
                        };
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
    let vnc_read = tokio::spawn(async move {
        loop {
            if cancel_vnc.is_cancelled() {
                break;
            }
            let msg = {
                let mut conn = rfb_read.lock().await;
                match conn.read_message() {
                    Ok(m) => m,
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
                ServerMessage::FramebufferUpdate(update) => {
                    let (decoded, fb_width, fb_height) = {
                        let mut conn = rfb_read.lock().await;
                        match conn.decode_update(&update) {
                            Ok(d) => (d, conn.width, conn.height),
                            Err(e) => {
                                tracing::error!("Decode error: {}", e);
                                continue;
                            }
                        }
                    };
                    {
                        let mut writer = rfb_writer_for_read.lock().await;
                        writer.set_framebuffer_size(fb_width, fb_height);
                    }
                    for rect in decoded {
                        if let DecodedRect::Pixels { x, y, w, h, rgba } = rect {
                            let mut frame = Vec::with_capacity(12 + rgba.len());
                            frame.extend_from_slice(&make_frame_header(x, y, w, h));
                            frame.extend_from_slice(&rgba);
                            let _ = ws_out.send(WsOutgoing::Frame(frame));
                        }
                    }
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json));
                }
                ServerMessage::ServerCutText { text } => {
                    let json = serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                    let _ = ws_out.send(WsOutgoing::Text(json));
                }
                ServerMessage::SetColourMapEntries => {}
            }
        }
    });

    // Task: control loop — process commands from WS client
    let rfb_ctrl = writer.clone();
    let cl_cancel = cancel.clone();
    let vnc_ctrl = tokio::spawn(async move {
        while let Some(ctrl) = control_rx.recv().await {
            if cl_cancel.is_cancelled() {
                break;
            }
            let mut conn = rfb_ctrl.lock().await;
            let result = match ctrl {
                VncControl::Ack => conn.request_update(true),
                VncControl::Key { down, keysym } => conn.send_key_event(down, keysym),
                VncControl::Pointer { x, y, buttons } => conn.send_pointer_event(x, y, buttons),
                VncControl::Clipboard(text) => conn.send_client_cut_text(&text),
                VncControl::Resize => conn.request_update(false),
                VncControl::Disconnect => {
                    cl_cancel.cancel();
                    Ok(())
                }
            };
            drop(conn);
            if let Err(e) = result {
                tracing::error!("VNC control error: {}", e);
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
    }

    cancel.cancel();
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

fn make_frame_header(x: u16, y: u16, w: u16, h: u16) -> [u8; 12] {
    let mut hdr = [0u8; 12];
    hdr[0..2].copy_from_slice(&x.to_be_bytes());
    hdr[2..4].copy_from_slice(&y.to_be_bytes());
    hdr[4..6].copy_from_slice(&w.to_be_bytes());
    hdr[6..8].copy_from_slice(&h.to_be_bytes());
    // bytes 8-11 reserved (zero)
    hdr
}
