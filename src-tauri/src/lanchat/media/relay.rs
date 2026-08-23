//! Per-call loopback WebSocket relay for the native A/V stack.
//!
//! Mirrors the RDP/VNC viewer pattern (`vnc/ws.rs`): bind `127.0.0.1:0`, hand
//! the port to the webview, accept exactly one WS connection, then push decoded
//! media to it. The webview renders video to a `<canvas>` and plays audio
//! through an AudioWorklet — the proven WebKitGTK-friendly path that needs no
//! `RTCPeerConnection`.
//!
//! Wire toward the webview:
//!   • text JSON control: `ready`, `peer-add`, `peer-remove`, `level`, `video`.
//!   • binary frames: `[u8 kind][u8 peerIdLen][peerId][payload]`, where kind 0 is
//!     interleaved-mono `f32` PCM (48 kHz) and kind 1 is a decoded video frame
//!     `[u32 w][u32 h][RGBA…]`.
//! From the webview we only accept keepalive (`ping`/`ack`) and `close`.
//!
//! Decoding lives behind the `native-av` feature; without it the relay still
//! runs (announcing peers from inbound traffic) but forwards no media payload.

#[cfg(feature = "native-av")]
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_util::sync::CancellationToken;
use tungstenite::Message;

use crate::lanchat::media::InboundMedia;
use crate::lanchat::protocol::wire;

/// Deadline for the webview to complete its WS upgrade after we bind.
const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Max time without a webview ping before we tear the relay down.
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Binary outbound frame kind for audio PCM payloads.
pub const WS_BIN_AUDIO: u8 = 0;
/// Binary outbound frame kind for decoded video payloads.
pub const WS_BIN_VIDEO: u8 = 1;

/// Control messages the session pushes toward the relay (then the webview).
pub enum RelayControl {
    /// A peer's media stream is being torn down — drop its tile.
    PeerRemoved(String),
    /// A peer's media-state (mic/cam/screen) changed; forwarded verbatim.
    PeerState {
        peer_id: String,
        mic: bool,
        cam: bool,
        screen: bool,
    },
}

/// Outbound text control messages (serialized to the webview as JSON).
#[derive(Serialize)]
#[serde(tag = "type")]
enum WsText {
    #[serde(rename = "ready")]
    Ready { sample_rate: u32 },
    #[serde(rename = "peer-add")]
    PeerAdd {
        #[serde(rename = "peerId")]
        peer_id: String,
        #[serde(rename = "hasVideo")]
        has_video: bool,
    },
    #[serde(rename = "peer-remove")]
    PeerRemove {
        #[serde(rename = "peerId")]
        peer_id: String,
    },
    #[serde(rename = "level")]
    Level {
        #[serde(rename = "peerId")]
        peer_id: String,
        level: f32,
    },
    #[serde(rename = "peer-state")]
    PeerState {
        #[serde(rename = "peerId")]
        peer_id: String,
        mic: bool,
        cam: bool,
        screen: bool,
    },
}

/// Handle to a running relay: the port the webview connects to, a control sender,
/// and the cancel token that stops it.
pub struct RelayHandle {
    pub ws_port: u16,
    pub control_tx: UnboundedSender<RelayControl>,
    pub cancel: CancellationToken,
}

/// Sample rate of audio delivered to the webview AudioWorklet.
pub const PLAYBACK_SAMPLE_RATE: u32 = 48_000;

/// Bind the loopback WS, spawn the relay, and return its handle. `inbound_rx` is
/// the per-call media pump (frames arriving from peers over the mesh). Fails
/// only if the loopback bind fails.
pub async fn spawn_relay(
    inbound_rx: UnboundedReceiver<InboundMedia>,
) -> Result<RelayHandle, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind media ws: {e}"))?;
    let ws_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (control_tx, control_rx) = mpsc::unbounded_channel::<RelayControl>();
    let cancel = CancellationToken::new();

    let cancel_run = cancel.clone();
    tokio::spawn(async move {
        if let Err(e) = run_relay(listener, inbound_rx, control_rx, cancel_run).await {
            log::debug!("lanchat: media relay ended: {e}");
        }
    });

    Ok(RelayHandle {
        ws_port,
        control_tx,
        cancel,
    })
}

async fn run_relay(
    listener: TcpListener,
    mut inbound_rx: UnboundedReceiver<InboundMedia>,
    mut control_rx: UnboundedReceiver<RelayControl>,
    cancel: CancellationToken,
) -> Result<(), String> {
    // Accept exactly one webview connection within the deadline.
    let (stream, _) = tokio::select! {
        r = tokio::time::timeout(WS_ACCEPT_TIMEOUT, listener.accept()) => match r {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return Err(format!("accept: {e}")),
            Err(_) => { cancel.cancel(); return Ok(()); }
        },
        _ = cancel.cancelled() => return Ok(()),
    };
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws upgrade: {e}"))?;
    let (mut sink, mut read) = ws.split();

    // Outbound pump: text + binary toward the webview.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let _ = out_tx.send(Message::Text(
        serde_json::to_string(&WsText::Ready {
            sample_rate: PLAYBACK_SAMPLE_RATE,
        })
        .unwrap()
        .into(),
    ));

    let last_seen = Arc::new(AsyncMutex::new(Instant::now()));

    // WS write task.
    let write = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // WS read task: keepalive only (toggles ride IPC, not the socket).
    let last_seen_r = last_seen.clone();
    let cancel_r = cancel.clone();
    let read_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = read.next().await {
            if cancel_r.is_cancelled() {
                break;
            }
            match msg {
                Message::Text(_) | Message::Pong(_) | Message::Ping(_) => {
                    *last_seen_r.lock().await = Instant::now();
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        cancel_r.cancel();
    });

    // Idle watchdog.
    let last_seen_w = last_seen.clone();
    let cancel_w = cancel.clone();
    let watchdog = tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(5));
        loop {
            iv.tick().await;
            if cancel_w.is_cancelled() {
                break;
            }
            if last_seen_w.lock().await.elapsed() > WS_IDLE_TIMEOUT {
                cancel_w.cancel();
                break;
            }
        }
    });

    // Main fan-in: inbound media (decode → binary + level) and session control.
    let mut peers: PeerDecoders = PeerDecoders::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            ctrl = control_rx.recv() => match ctrl {
                Some(RelayControl::PeerRemoved(peer_id)) => {
                    peers.remove(&peer_id);
                    let _ = out_tx.send(text(&WsText::PeerRemove { peer_id }));
                }
                Some(RelayControl::PeerState { peer_id, mic, cam, screen }) => {
                    let _ = out_tx.send(text(&WsText::PeerState { peer_id, mic, cam, screen }));
                }
                None => break,
            },
            frame = inbound_rx.recv() => match frame {
                Some(inbound) => handle_inbound(&mut peers, &out_tx, inbound),
                None => break,
            },
        }
    }

    cancel.cancel();
    write.abort();
    read_task.abort();
    watchdog.abort();
    Ok(())
}

/// Serialize a text control message into a WS frame.
fn text(msg: &WsText) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_default().into())
}

/// Prepend the binary frame header `[kind][peerIdLen][peerId]` to a payload.
fn bin(kind: u8, peer_id: &str, payload: &[u8]) -> Message {
    let id = peer_id.as_bytes();
    let mut out = Vec::with_capacity(2 + id.len() + payload.len());
    out.push(kind);
    out.push(id.len() as u8);
    out.extend_from_slice(id);
    out.extend_from_slice(payload);
    Message::Binary(out.into())
}

/// Per-peer inbound decode state, owned by the relay loop. Tracks which peers
/// we've announced to the webview and (with `native-av`) their Opus decoders.
struct PeerDecoders {
    announced: HashSet<String>,
    /// peer → (Opus decoder, frames since last level report).
    #[cfg(feature = "native-av")]
    audio: HashMap<String, (super::audio::OpusStreamDecoder, u32)>,
    /// peer → H.264 decoder (keyed per logical video stream label).
    #[cfg(feature = "native-av")]
    video: HashMap<String, super::video::H264StreamDecoder>,
}

impl PeerDecoders {
    fn new() -> Self {
        Self {
            announced: HashSet::new(),
            #[cfg(feature = "native-av")]
            audio: HashMap::new(),
            #[cfg(feature = "native-av")]
            video: HashMap::new(),
        }
    }
    fn remove(&mut self, peer_id: &str) {
        self.announced.remove(peer_id);
        #[cfg(feature = "native-av")]
        {
            self.audio.remove(peer_id);
            self.video.remove(peer_id);
        }
    }
}

/// How many decoded audio frames between RMS level reports (~100 ms @ 20 ms).
#[cfg(feature = "native-av")]
const LEVEL_REPORT_EVERY: u32 = 5;

/// Handle one inbound media frame: announce the peer to the webview on first
/// sight, then decode + forward the payload (audio now; video in Phase 3/4).
fn handle_inbound(
    peers: &mut PeerDecoders,
    out_tx: &UnboundedSender<Message>,
    inbound: InboundMedia,
) {
    let InboundMedia { peer_id, frame } = inbound;
    if peers.announced.insert(peer_id.clone()) {
        let _ = out_tx.send(text(&WsText::PeerAdd {
            peer_id: peer_id.clone(),
            has_video: frame.kind == wire::MEDIA_VIDEO,
        }));
    }
    #[cfg(feature = "native-av")]
    {
        if frame.kind == wire::MEDIA_AUDIO {
            decode_audio(peers, out_tx, &peer_id, &frame.data);
        } else if frame.kind == wire::MEDIA_VIDEO {
            decode_video(peers, out_tx, &peer_id, &frame.data);
        }
    }
    #[cfg(not(feature = "native-av"))]
    {
        let _ = &frame.data; // no decoders compiled in
    }
}

/// Decode one Opus packet from `peer_id` and forward PCM (+ periodic level).
#[cfg(feature = "native-av")]
fn decode_audio(
    peers: &mut PeerDecoders,
    out_tx: &UnboundedSender<Message>,
    peer_id: &str,
    data: &[u8],
) {
    if !peers.audio.contains_key(peer_id) {
        match super::audio::OpusStreamDecoder::new() {
            Ok(d) => {
                peers.audio.insert(peer_id.to_string(), (d, 0));
            }
            Err(e) => {
                log::warn!("lanchat: opus decoder init for {peer_id} failed: {e}");
                return;
            }
        }
    }
    let (dec, since) = peers.audio.get_mut(peer_id).unwrap();
    let pcm = dec.decode(data);
    if pcm.is_empty() {
        return;
    }
    let mut buf = Vec::with_capacity(pcm.len() * 4);
    for s in &pcm {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    let _ = out_tx.send(bin(WS_BIN_AUDIO, peer_id, &buf));

    *since += 1;
    if *since >= LEVEL_REPORT_EVERY {
        *since = 0;
        let rms = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();
        let _ = out_tx.send(text(&WsText::Level {
            peer_id: peer_id.to_string(),
            level: rms.min(1.0),
        }));
    }
}

/// Decode one H.264 access unit from `peer_id` and forward the RGBA frame to
/// the webview as `[u32 w][u32 h][RGBA…]`.
#[cfg(feature = "native-av")]
fn decode_video(
    peers: &mut PeerDecoders,
    out_tx: &UnboundedSender<Message>,
    peer_id: &str,
    data: &[u8],
) {
    if !peers.video.contains_key(peer_id) {
        match super::video::H264StreamDecoder::new() {
            Ok(d) => {
                peers.video.insert(peer_id.to_string(), d);
            }
            Err(e) => {
                log::warn!("lanchat: h264 decoder init for {peer_id} failed: {e}");
                return;
            }
        }
    }
    let dec = peers.video.get_mut(peer_id).unwrap();
    if let Some((w, h, rgba)) = dec.decode(data) {
        let mut payload = Vec::with_capacity(8 + rgba.len());
        payload.extend_from_slice(&w.to_le_bytes());
        payload.extend_from_slice(&h.to_le_bytes());
        payload.extend_from_slice(&rgba);
        let _ = out_tx.send(bin(WS_BIN_VIDEO, peer_id, &payload));
    }
}

#[allow(dead_code)] // bin()/kinds are exercised by the decode path (native-av)
fn _relay_decode_seam() {
    let _ = (
        WS_BIN_AUDIO,
        WS_BIN_VIDEO,
        bin as fn(u8, &str, &[u8]) -> Message,
    );
}
