//! Native audio path for the LanChat A/V stack (Phase 2) — `native-av` only.
//!
//! Send: cpal mic capture → downmix to mono + linear-resample to 48 kHz → 20 ms
//! Opus frames → `transport::send_media` (TAG_MEDIA) to each call peer.
//! Receive: per-peer Opus decode back to 48 kHz mono f32 PCM, handed to the
//! relay which ships it to the webview AudioWorklet (see `relay.rs`).
//!
//! No AEC/NS in v1 (the plan flags this high-risk) — use headphones to avoid
//! echo. Capture runs on a dedicated thread because cpal `Stream` is `!Send`.
#![cfg(feature = "native-av")]

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use audiopus::coder::{Decoder, Encoder};
use audiopus::packet::Packet;
use audiopus::{Application, Channels, MutSignals, SampleRate};
use cpal::SampleFormat;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::{RwLock, mpsc};

use crate::lanchat::LanChatState;
use crate::lanchat::protocol::wire;

/// Opus operating sample rate (also the rate delivered to the webview).
pub const SAMPLE_RATE: u32 = 48_000;
/// Samples per 20 ms mono frame at 48 kHz — Opus's sweet-spot frame size.
pub const FRAME_SAMPLES: usize = 960;
/// Max bytes an Opus frame can encode to (well above 20 ms VoIP frames).
const MAX_PACKET: usize = 4_000;
/// Decoder scratch: 120 ms at 48 kHz mono, the largest Opus frame.
const MAX_DECODE_SAMPLES: usize = 5_760;

/// Stateful linear resampler (mono) that carries its fractional read position
/// across callback buffers. `ratio` = source_rate / dest_rate.
struct Resampler {
    ratio: f64,
    pos: f64,
}

impl Resampler {
    fn new(src_rate: u32) -> Self {
        Self {
            ratio: src_rate as f64 / SAMPLE_RATE as f64,
            pos: 0.0,
        }
    }

    /// Resample `input` (mono) into `out`, appending the produced 48 kHz samples.
    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let n = input.len();
        if n == 0 {
            return;
        }
        while self.pos < n as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = input[i];
            let b = if i + 1 < n { input[i + 1] } else { input[i] };
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        // Carry the fractional remainder into the next buffer.
        self.pos -= n as f64;
    }
}

/// Per-peer Opus decoder producing 48 kHz mono f32 PCM. Used by the relay.
pub struct OpusStreamDecoder {
    dec: Decoder,
    scratch: Vec<f32>,
}

impl OpusStreamDecoder {
    pub fn new() -> Result<Self, String> {
        let dec = Decoder::new(SampleRate::Hz48000, Channels::Mono).map_err(|e| e.to_string())?;
        Ok(Self {
            dec,
            scratch: vec![0.0; MAX_DECODE_SAMPLES],
        })
    }

    /// Decode one Opus packet to mono f32 PCM (empty on error / empty input).
    pub fn decode(&mut self, data: &[u8]) -> Vec<f32> {
        if data.is_empty() {
            return Vec::new();
        }
        let packet = match Packet::try_from(data) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        let signals = match MutSignals::try_from(&mut self.scratch[..]) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        match self.dec.decode_float(Some(packet), signals, false) {
            Ok(n) => self.scratch[..n].to_vec(),
            Err(_) => Vec::new(),
        }
    }
}

/// Mutable per-stream capture state, owned by the cpal data callback. Downmixes
/// to mono, resamples to 48 kHz, and emits fixed 960-sample frames.
struct CaptureState {
    resampler: Resampler,
    channels: usize,
    acc: Vec<f32>,
    mono: Vec<f32>,
    frame_tx: mpsc::UnboundedSender<Box<[f32]>>,
}

impl CaptureState {
    fn new(src_rate: u32, channels: usize, frame_tx: mpsc::UnboundedSender<Box<[f32]>>) -> Self {
        Self {
            resampler: Resampler::new(src_rate),
            channels: channels.max(1),
            acc: Vec::with_capacity(FRAME_SAMPLES * 4),
            mono: Vec::new(),
            frame_tx,
        }
    }

    fn push(&mut self, samples: &[f32]) {
        self.mono.clear();
        if self.channels <= 1 {
            self.mono.extend_from_slice(samples);
        } else {
            for f in samples.chunks_exact(self.channels) {
                self.mono
                    .push(f.iter().copied().sum::<f32>() / self.channels as f32);
            }
        }
        let mono = std::mem::take(&mut self.mono);
        self.resampler.process(&mono, &mut self.acc);
        self.mono = mono;
        while self.acc.len() >= FRAME_SAMPLES {
            let frame: Box<[f32]> = self.acc.drain(..FRAME_SAMPLES).collect();
            let _ = self.frame_tx.send(frame);
        }
    }
}

/// Build (but do not start) the cpal input stream feeding `frame_tx`.
fn build_capture_stream(
    frame_tx: mpsc::UnboundedSender<Box<[f32]>>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("no input device")?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let src_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.clone().into();
    let err_fn = |e| log::warn!("lanchat: mic stream error: {e}");
    let stream = match supported.sample_format() {
        SampleFormat::F32 => {
            let mut st = CaptureState::new(src_rate, channels, frame_tx.clone());
            device.build_input_stream(&config, move |d: &[f32], _| st.push(d), err_fn, None)
        }
        SampleFormat::I16 => {
            let mut st = CaptureState::new(src_rate, channels, frame_tx.clone());
            device.build_input_stream(
                &config,
                move |d: &[i16], _| {
                    let f: Vec<f32> = d.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                    st.push(&f);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let mut st = CaptureState::new(src_rate, channels, frame_tx.clone());
            device.build_input_stream(
                &config,
                move |d: &[u16], _| {
                    let f: Vec<f32> = d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                    st.push(&f);
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("unsupported sample format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(stream)
}

// PLACEHOLDER_SENDER2

/// Handle to the running audio send path. Dropping it stops capture (the cpal
/// stream is released when the capture thread's stop channel closes) and the
/// encode task is aborted.
pub struct AudioSender {
    stop_tx: std::sync::mpsc::Sender<()>,
    abort: tokio::task::AbortHandle,
}

impl AudioSender {
    /// Stop capture and encoding (idempotent).
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
        self.abort.abort();
    }
}

impl Drop for AudioSender {
    fn drop(&mut self) {
        self.abort.abort();
        // Dropping stop_tx also closes the capture thread's stop channel.
    }
}

/// Start the audio send path: a dedicated thread owns the cpal stream (`!Send`),
/// an async task Opus-encodes 20 ms frames and fans them to the call's peers.
pub fn start_audio_sender(
    state: Arc<LanChatState>,
    call_id: String,
    peers: Arc<RwLock<HashSet<String>>>,
    mic_on: Arc<AtomicBool>,
) -> Result<AudioSender, String> {
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Box<[f32]>>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();

    std::thread::Builder::new()
        .name("lanchat-mic".into())
        .spawn(move || match build_capture_stream(frame_tx) {
            Ok(stream) => {
                if let Err(e) = stream.play() {
                    log::warn!("lanchat: mic play failed: {e}");
                    return;
                }
                log::info!("lanchat: native mic capture started");
                let _ = stop_rx.recv(); // block until stop signaled / sender dropped
                drop(stream);
                log::info!("lanchat: native mic capture stopped");
            }
            Err(e) => log::warn!("lanchat: mic capture init failed: {e}"),
        })
        .map_err(|e| e.to_string())?;

    let task = tokio::spawn(encode_loop(state, call_id, peers, mic_on, frame_rx));
    Ok(AudioSender {
        stop_tx,
        abort: task.abort_handle(),
    })
}

/// Opus-encode each 960-sample frame and send it to every current peer.
async fn encode_loop(
    state: Arc<LanChatState>,
    call_id: String,
    peers: Arc<RwLock<HashSet<String>>>,
    mic_on: Arc<AtomicBool>,
    mut frame_rx: mpsc::UnboundedReceiver<Box<[f32]>>,
) {
    let encoder = match Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip) {
        Ok(e) => e,
        Err(e) => {
            log::error!("lanchat: opus encoder init failed: {e}");
            return;
        }
    };
    let mut out = vec![0u8; MAX_PACKET];
    let mut seq: u32 = 0;
    while let Some(frame) = frame_rx.recv().await {
        if !mic_on.load(Ordering::Relaxed) {
            continue; // muted — drop frames so the queue can't back up
        }
        let n = match encoder.encode_float(&frame, &mut out) {
            Ok(n) => n,
            Err(e) => {
                log::debug!("lanchat: opus encode failed: {e}");
                continue;
            }
        };
        let peer_list: Vec<String> = peers.read().await.iter().cloned().collect();
        if peer_list.is_empty() {
            continue;
        }
        let ts = chrono::Utc::now().timestamp_millis();
        let body = wire::frame_media(&call_id, "mic", wire::MEDIA_AUDIO, seq, ts, &out[..n]);
        seq = seq.wrapping_add(1);
        for peer in peer_list {
            let _ = crate::lanchat::transport::send_media(&state, &peer, body.clone()).await;
        }
    }
}
