//! Native video path for the LanChat A/V stack (Phases 3-4) — `native-av` only.
//!
//! Send: a frame source (X11 screen capturer for screen share; nokhwa camera in
//! Phase 4) → BGRA → I420 → software H.264 (openh264) → `transport::send_media`
//! (TAG_MEDIA, kind=video) to each call peer.
//! Receive: per-peer H.264 decode → RGBA, shipped by the relay to the webview as
//! WS_BIN_VIDEO frames and drawn into a `<canvas>` via `putImageData`.
//!
//! Software H.264 is CPU-heavy; screen capture is rate-limited and the mesh
//! fan-out is O(peers), so multi-party video is bounded (see the plan's perf
//! guardrail). Capture runs on a dedicated thread (the X11 capturer is `!Send`).
#![cfg(feature = "native-av")]

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use openh264::OpenH264API;
use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate};
use openh264::formats::{BgraSliceU8, RgbSliceU8, YUVBuffer, YUVSource};
use tauri::AppHandle;
use tokio::sync::{RwLock, mpsc};

use crate::lanchat::LanChatState;
use crate::lanchat::protocol::wire;

/// Target screen-share frame rate (software H.264 + O(peers) fan-out — keep it
/// modest). Camera uses the device's own rate.
const SCREEN_FPS: u32 = 12;
/// Target encode bitrate for screen content.
const SCREEN_BITRATE_BPS: u32 = 2_500_000;
/// Force a keyframe at least this often so a mid-stream joiner recovers.
const KEYFRAME_INTERVAL: Duration = Duration::from_secs(2);

/// Per-peer H.264 decoder producing RGBA frames. Used by the relay.
pub struct H264StreamDecoder {
    dec: openh264::decoder::Decoder,
}

impl H264StreamDecoder {
    pub fn new() -> Result<Self, String> {
        openh264::decoder::Decoder::new()
            .map(|dec| Self { dec })
            .map_err(|e| e.to_string())
    }

    /// Decode one H.264 access unit to `(width, height, rgba)`. `None` if the
    /// packet yielded no displayable frame (e.g. parameter sets only) or errored.
    pub fn decode(&mut self, data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
        match self.dec.decode(data) {
            Ok(Some(yuv)) => {
                let (w, h) = yuv.dimensions();
                let mut rgba = vec![0u8; w * h * 4];
                yuv.write_rgba8(&mut rgba);
                Some((w as u32, h as u32, rgba))
            }
            _ => None,
        }
    }
}

/// Build an H.264 encoder targeting `(width, height)` at the screen profile.
fn make_encoder(width: u32, height: u32) -> Result<Encoder, String> {
    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(SCREEN_BITRATE_BPS))
        .max_frame_rate(FrameRate::from_hz(SCREEN_FPS as f32));
    let _ = (width, height); // openh264 adapts to the first frame's dimensions
    Encoder::with_api_config(OpenH264API::from_source(), config).map_err(|e| e.to_string())
}

// PLACEHOLDER_VIDEO_SENDER

/// Handle to a running video send path (screen or camera). Dropping/stopping it
/// releases the capturer (thread exits) and aborts the async sender.
pub struct VideoSender {
    stop_tx: std::sync::mpsc::Sender<()>,
    abort: tokio::task::AbortHandle,
    want_keyframe: Arc<AtomicBool>,
}

impl VideoSender {
    /// Ask the encoder to emit a keyframe on its next frame (e.g. a peer joined).
    pub fn request_keyframe(&self) {
        self.want_keyframe.store(true, Ordering::Relaxed);
    }
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
        self.abort.abort();
    }
}

impl Drop for VideoSender {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

/// Start screen-share capture+encode. Resolves once the capturer is initialized
/// so init failures (no X11, Wayland-only, …) surface to the caller.
pub async fn start_screen_sender(
    app: AppHandle,
    state: Arc<LanChatState>,
    call_id: String,
    peers: Arc<RwLock<HashSet<String>>>,
) -> Result<VideoSender, String> {
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<(Vec<u8>, i64)>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (init_tx, init_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let want_keyframe = Arc::new(AtomicBool::new(false));
    let want_kf_thread = want_keyframe.clone();

    std::thread::Builder::new()
        .name("lanchat-screen".into())
        .spawn(move || screen_capture_thread(app, frame_tx, stop_rx, want_kf_thread, init_tx))
        .map_err(|e| e.to_string())?;

    match init_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("screen capture thread exited before init".into()),
    }

    let task = tokio::spawn(send_loop(state, call_id, "screen", peers, frame_rx));
    Ok(VideoSender {
        stop_tx,
        abort: task.abort_handle(),
        want_keyframe,
    })
}

/// Capture+encode loop (own thread; the X11 capturer is `!Send`).
fn screen_capture_thread(
    app: AppHandle,
    frame_tx: mpsc::UnboundedSender<(Vec<u8>, i64)>,
    stop_rx: std::sync::mpsc::Receiver<()>,
    want_keyframe: Arc<AtomicBool>,
    init_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use crate::servers::ServerType;
    use crate::servers::engine::LogEmitter;
    // LogEmitter needs a ServerType for its channel; capture init logs are
    // low-volume. Reuse the Rdp channel rather than threading a new one through.
    let log = LogEmitter::new(app, ServerType::Rdp);
    let mut capturer = match crate::servers::rdp::capture::create_capturer(&log) {
        Ok(c) => {
            let _ = init_tx.send(Ok(()));
            c
        }
        Err(e) => {
            let _ = init_tx.send(Err(format!("screen capture unavailable: {e}")));
            return;
        }
    };

    let frame_interval = Duration::from_millis(1000 / SCREEN_FPS as u64);
    let mut encoder: Option<Encoder> = None;
    let mut enc_dims = (0usize, 0usize);
    let mut last_kf = Instant::now() - KEYFRAME_INTERVAL;
    let mut tight: Vec<u8> = Vec::new();

    loop {
        if !matches!(
            stop_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ) {
            break; // stop signaled or sender dropped
        }
        let t0 = Instant::now();
        let frame = match capturer.capture() {
            Ok(f) => f,
            Err(e) => {
                log::debug!("lanchat: screen capture error: {e}");
                std::thread::sleep(frame_interval);
                continue;
            }
        };
        let w = (frame.width as usize) & !1; // H.264 4:2:0 needs even dims
        let h = (frame.height as usize) & !1;
        if w == 0 || h == 0 {
            std::thread::sleep(frame_interval);
            continue;
        }
        if encoder.is_none() || enc_dims != (w, h) {
            match make_encoder(w as u32, h as u32) {
                Ok(e) => {
                    encoder = Some(e);
                    enc_dims = (w, h);
                    last_kf = Instant::now() - KEYFRAME_INTERVAL;
                }
                Err(e) => {
                    log::warn!("lanchat: h264 encoder init failed: {e}");
                    break;
                }
            }
        }
        // Repack to tight BGRA (the capturer may pad rows to `stride`).
        let row_bytes = w * 4;
        tight.resize(row_bytes * h, 0);
        for row in 0..h {
            let src = row * frame.stride;
            tight[row * row_bytes..(row + 1) * row_bytes]
                .copy_from_slice(&frame.data[src..src + row_bytes]);
        }
        let enc = encoder.as_mut().unwrap();
        if want_keyframe.swap(false, Ordering::Relaxed) || last_kf.elapsed() >= KEYFRAME_INTERVAL {
            enc.force_intra_frame();
            last_kf = Instant::now();
        }
        let yuv = YUVBuffer::from_rgb_source(BgraSliceU8::new(&tight, (w, h)));
        let ts = chrono::Utc::now().timestamp_millis();
        match enc.encode(&yuv) {
            Ok(bitstream) => {
                let nal = bitstream.to_vec();
                if !nal.is_empty() {
                    let _ = frame_tx.send((nal, ts));
                }
            }
            Err(e) => log::debug!("lanchat: h264 encode failed: {e}"),
        }
        let elapsed = t0.elapsed();
        if elapsed < frame_interval {
            std::thread::sleep(frame_interval - elapsed);
        }
    }
    log::info!("lanchat: screen capture stopped");
}

/// Start camera capture+encode (nokhwa v4l2). Resolves once the camera opens.
pub async fn start_camera_sender(
    state: Arc<LanChatState>,
    call_id: String,
    peers: Arc<RwLock<HashSet<String>>>,
) -> Result<VideoSender, String> {
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<(Vec<u8>, i64)>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (init_tx, init_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let want_keyframe = Arc::new(AtomicBool::new(false));
    let want_kf_thread = want_keyframe.clone();

    std::thread::Builder::new()
        .name("lanchat-camera".into())
        .spawn(move || camera_capture_thread(frame_tx, stop_rx, want_kf_thread, init_tx))
        .map_err(|e| e.to_string())?;

    match init_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("camera thread exited before init".into()),
    }

    let task = tokio::spawn(send_loop(state, call_id, "cam", peers, frame_rx));
    Ok(VideoSender {
        stop_tx,
        abort: task.abort_handle(),
        want_keyframe,
    })
}

/// Camera capture+encode loop (own thread; nokhwa `Camera` is `!Send`).
fn camera_capture_thread(
    frame_tx: mpsc::UnboundedSender<(Vec<u8>, i64)>,
    stop_rx: std::sync::mpsc::Receiver<()>,
    want_keyframe: Arc<AtomicBool>,
    init_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType};

    let format = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
    let mut camera = match nokhwa::Camera::new(CameraIndex::Index(0), format) {
        Ok(c) => c,
        Err(e) => {
            let _ = init_tx.send(Err(format!("camera open failed: {e}")));
            return;
        }
    };
    if let Err(e) = camera.open_stream() {
        let _ = init_tx.send(Err(format!("camera stream failed: {e}")));
        return;
    }
    let _ = init_tx.send(Ok(()));

    let mut encoder: Option<Encoder> = None;
    let mut enc_dims = (0usize, 0usize);
    let mut last_kf = Instant::now() - KEYFRAME_INTERVAL;
    let mut tight: Vec<u8> = Vec::new();

    loop {
        if !matches!(
            stop_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ) {
            break;
        }
        let img = match camera.frame().and_then(|b| b.decode_image::<RgbFormat>()) {
            Ok(i) => i,
            Err(e) => {
                log::debug!("lanchat: camera frame error: {e}");
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
        };
        let (ow, oh) = (img.width() as usize, img.height() as usize);
        let w = ow & !1;
        let h = oh & !1;
        if w == 0 || h == 0 {
            continue;
        }
        if encoder.is_none() || enc_dims != (w, h) {
            match make_encoder(w as u32, h as u32) {
                Ok(e) => {
                    encoder = Some(e);
                    enc_dims = (w, h);
                    last_kf = Instant::now() - KEYFRAME_INTERVAL;
                }
                Err(e) => {
                    log::warn!("lanchat: h264 encoder init failed: {e}");
                    break;
                }
            }
        }
        // Tight RGB for the even-cropped region (source row stride is ow*3).
        let raw = img.as_raw();
        let (row, orow) = (w * 3, ow * 3);
        tight.resize(row * h, 0);
        for r in 0..h {
            tight[r * row..(r + 1) * row].copy_from_slice(&raw[r * orow..r * orow + row]);
        }
        let enc = encoder.as_mut().unwrap();
        if want_keyframe.swap(false, Ordering::Relaxed) || last_kf.elapsed() >= KEYFRAME_INTERVAL {
            enc.force_intra_frame();
            last_kf = Instant::now();
        }
        let yuv = YUVBuffer::from_rgb_source(RgbSliceU8::new(&tight, (w, h)));
        let ts = chrono::Utc::now().timestamp_millis();
        match enc.encode(&yuv) {
            Ok(bitstream) => {
                let nal = bitstream.to_vec();
                if !nal.is_empty() {
                    let _ = frame_tx.send((nal, ts));
                }
            }
            Err(e) => log::debug!("lanchat: h264 encode failed: {e}"),
        }
    }
    let _ = camera.stop_stream();
    log::info!("lanchat: camera capture stopped");
}

/// Fan encoded video access units to the call's peers as TAG_MEDIA video frames.
async fn send_loop(
    state: Arc<LanChatState>,
    call_id: String,
    stream: &'static str,
    peers: Arc<RwLock<HashSet<String>>>,
    mut frame_rx: mpsc::UnboundedReceiver<(Vec<u8>, i64)>,
) {
    let mut seq: u32 = 0;
    while let Some((nal, ts)) = frame_rx.recv().await {
        let peer_list: Vec<String> = peers.read().await.iter().cloned().collect();
        if peer_list.is_empty() {
            continue;
        }
        let body = wire::frame_media(&call_id, stream, wire::MEDIA_VIDEO, seq, ts, &nal);
        seq = seq.wrapping_add(1);
        for peer in peer_list {
            let _ = crate::lanchat::transport::send_media(&state, &peer, body.clone()).await;
        }
    }
}
