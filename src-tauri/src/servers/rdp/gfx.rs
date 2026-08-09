//! Low-latency macOS EGFX/AVC420 path for the in-process RDP server.
//!
//! The regular RDP bitmap path remains the compatibility baseline. When a
//! client advertises the Graphics Pipeline Extension with AVC420, this module
//! sends current ScreenCaptureKit frames through VideoToolbox's real-time H.264
//! encoder instead. The graphics server's frame acknowledgements are used as a
//! hard two-frame backpressure boundary: newest state wins over building a
//! network or decoder backlog.
//!
//! ACK receipt and decoded-frame progress are tracked separately. A client that
//! keeps acknowledging transport frames without advancing `totalFramesDecoded`
//! is downgraded to bitmap updates, preventing an undecodable mapped surface
//! from permanently hiding the reliable compatibility path.

use core::ffi::c_void;
use std::collections::VecDeque;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ironrdp::dvc::encode_dvc_messages;
use ironrdp::pdu::gcc::{Monitor, MonitorFlags};
use ironrdp::svc::{ChannelFlags, SvcMessage};
use ironrdp_egfx::pdu::{Avc420Region, CapabilitiesAdvertisePdu, CapabilitySet};
use ironrdp_egfx::server::{GraphicsPipelineHandler, GraphicsPipelineServer};
use ironrdp_server::{
    EgfxServerMessage, GfxDvcBridge, GfxServerFactory, GfxServerHandle, ServerEvent,
    ServerEventSender,
};
use objc2_core_foundation::{CFBoolean, CFNumber, CFRetained};
use objc2_core_media::{
    CMBlockBuffer, CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetH264ParameterSetAtIndex,
    kCMTimeInvalid, kCMVideoCodecType_H264,
};
use objc2_core_video::{
    CVImageBuffer, CVPixelBuffer, CVPixelBufferCreateWithBytes, kCVPixelFormatType_32BGRA,
    kCVReturnSuccess,
};
use objc2_video_toolbox::{
    VTCompressionSession, VTSession, VTSessionSetProperty,
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_MaxFrameDelayCount,
    kVTCompressionPropertyKey_RealTime,
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::capture::Frame;
use crate::servers::engine::LogEmitter;

/// Two outstanding ACKs leave room for one currently-rendering frame without
/// permitting an interactive client to accumulate visibly stale desktop state.
const MAX_FRAMES_IN_FLIGHT: u32 = 2;
/// Bound VideoToolbox independently of the later EGFX acknowledgement window.
/// One frame may be encoding while one newer frame waits behind it.
const MAX_ENCODER_FRAMES_IN_FLIGHT: usize = 2;
pub(crate) const ENCODE_TIMEOUT: Duration = Duration::from_millis(250);
/// VideoToolbox may retain the tail of a compression window until another
/// frame arrives. Flush only after two normal capture intervals have elapsed,
/// preserving pipelining during motion while bounding a static first frame.
const ENCODE_FLUSH_DELAY: Duration = Duration::from_millis(75);
/// How long the ACK window may stay full without a single acknowledgement
/// arriving before the client is treated as no longer consuming EGFX.
///
/// Backpressure drops frames by design, so a client that stops acknowledging
/// would otherwise freeze the desktop indefinitely while capture stays healthy.
/// This bound converts that permanent stall into a one-time downgrade to the
/// bitmap path, which every client supports.
const ACK_STALL_TIMEOUT: Duration = Duration::from_millis(1500);
/// Maximum time acknowledged AVC420 frames may fail to increase the client's
/// decoded-frame counter before the mapped surface is considered unusable.
const DECODE_STALL_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone)]
pub(crate) struct GfxTransport {
    state: Arc<Mutex<GfxState>>,
    /// Incremented by the graphics handler on every client frame acknowledgement.
    /// Shared with the per-connection handler so the display side can tell a
    /// slow-but-live client from one that has stopped consuming EGFX entirely.
    acks: Arc<AtomicU64>,
    /// Latest `totalFramesDecoded` value published by the client. Unlike an ACK
    /// count, progress here confirms that AVC420 payloads are actually usable.
    decoded: Arc<AtomicU32>,
    log: LogEmitter,
}

struct GfxState {
    sender: Option<UnboundedSender<ServerEvent>>,
    handle: Option<GfxServerHandle>,
    surface: Option<GfxSurface>,
    /// Set once the ACK window has been full past [`ACK_STALL_TIMEOUT`] with no
    /// progress. Cleared when a new connection builds a fresh graphics server.
    disabled: bool,
    stall: Option<AckStall>,
    decode_watch: Option<DecodeWatch>,
    decode_confirmed: bool,
    session_started: Instant,
}

/// Start of the current uninterrupted backpressure window.
#[derive(Clone, Copy)]
struct AckStall {
    since: Instant,
    acks: u64,
}

/// Decoded-frame counter observed at the beginning of the current validation
/// window. This window starts only after an AVC420 frame is submitted.
#[derive(Clone, Copy)]
struct DecodeWatch {
    since: Instant,
    decoded: u32,
}

/// What to do about a full ACK window.
#[derive(Debug, PartialEq, Eq)]
enum StallVerdict {
    /// Begin (or restart) the stall window against the current ACK count.
    Restart,
    /// Client is behind but still acknowledging. Drop this frame.
    Wait,
    /// Client has not acknowledged anything for [`ACK_STALL_TIMEOUT`]. Stop
    /// using EGFX so the desktop keeps updating over the bitmap path.
    Disable,
}

/// Decide the fate of a full ACK window from the stall record and the current
/// acknowledgement count. Pure so the timing policy is directly testable.
fn stall_verdict(stall: Option<AckStall>, acks: u64, now: Instant) -> StallVerdict {
    match stall {
        // Acknowledgements advanced during the window: the client is consuming.
        Some(stall) if stall.acks != acks => StallVerdict::Restart,
        Some(stall) if now.duration_since(stall.since) >= ACK_STALL_TIMEOUT => {
            StallVerdict::Disable
        }
        Some(_) => StallVerdict::Wait,
        None => StallVerdict::Restart,
    }
}

fn decode_verdict(watch: DecodeWatch, decoded: u32, now: Instant) -> StallVerdict {
    if watch.decoded != decoded {
        StallVerdict::Restart
    } else if now.duration_since(watch.since) >= DECODE_STALL_TIMEOUT {
        StallVerdict::Disable
    } else {
        StallVerdict::Wait
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct GfxSurface {
    id: u16,
    width: u16,
    height: u16,
}

pub(crate) enum GfxSubmit {
    /// EGFX took ownership of a current frame.
    Sent,
    /// The client has enough in-flight frames. The caller must discard this
    /// frame rather than falling back to a bitmap update, which would only add
    /// stale work to the connection.
    Backpressured,
    /// No negotiated AVC420 graphics path is available; use normal RDP bitmap
    /// updates so older clients remain fully supported.
    Unavailable,
}

pub(crate) enum GfxReadiness {
    Ready,
    Backpressured,
    Unavailable,
}

impl GfxTransport {
    pub(crate) fn new(log: LogEmitter) -> Self {
        Self {
            state: Arc::new(Mutex::new(GfxState {
                sender: None,
                handle: None,
                surface: None,
                disabled: false,
                stall: None,
                decode_watch: None,
                decode_confirmed: false,
                session_started: Instant::now(),
            })),
            acks: Arc::new(AtomicU64::new(0)),
            decoded: Arc::new(AtomicU32::new(0)),
            log,
        }
    }

    pub(crate) fn factory(&self) -> EgfxFactory {
        EgfxFactory {
            state: self.state.clone(),
            acks: self.acks.clone(),
            decoded: self.decoded.clone(),
            log: self.log.clone(),
        }
    }

    /// Snapshot the connection-scoped state. Taking this before locking the
    /// graphics server keeps one consistent lock order (state, then server)
    /// everywhere in this module.
    fn snapshot(&self) -> Option<GfxSnapshot> {
        let state = self.state.lock().ok()?;
        if state.disabled {
            return None;
        }
        Some(GfxSnapshot {
            handle: state.handle.clone()?,
            sender: state.sender.clone()?,
            surface: state.surface,
            stall: state.stall,
            decode_watch: state.decode_watch,
            session_started: state.session_started,
        })
    }

    /// Check before beginning a hardware encode. This inexpensive gate means
    /// no CPU/GPU work is spent for an unready client or one whose ACK window
    /// is already full.
    pub(crate) fn readiness(&self) -> GfxReadiness {
        let Some(snapshot) = self.snapshot() else {
            return GfxReadiness::Unavailable;
        };
        let Ok(server) = snapshot.handle.lock() else {
            return GfxReadiness::Unavailable;
        };
        if !server.is_ready() || !server.supports_avc420() {
            return GfxReadiness::Unavailable;
        }
        let backpressured = server.should_backpressure();
        drop(server);

        if backpressured {
            // The ACK window is full. Decide whether this client is merely a
            // frame behind or has stopped acknowledging altogether.
            let acks = self.acks.load(Ordering::Relaxed);
            return match stall_verdict(snapshot.stall, acks, Instant::now()) {
                StallVerdict::Restart => {
                    self.begin_stall(acks);
                    GfxReadiness::Backpressured
                }
                StallVerdict::Wait => GfxReadiness::Backpressured,
                StallVerdict::Disable => {
                    self.disable_after_stall();
                    GfxReadiness::Unavailable
                }
            };
        }

        self.clear_stall();
        let Some(watch) = snapshot.decode_watch else {
            return GfxReadiness::Ready;
        };
        let decoded = self.decoded.load(Ordering::Relaxed);
        match decode_verdict(watch, decoded, Instant::now()) {
            StallVerdict::Restart => {
                self.record_decode_progress(decoded);
                GfxReadiness::Ready
            }
            StallVerdict::Wait => GfxReadiness::Ready,
            StallVerdict::Disable => {
                self.disable_after_decode_stall();
                GfxReadiness::Unavailable
            }
        }
    }

    /// Record the beginning of a backpressure window against the current ACK
    /// count, so progress can be detected on the next check.
    fn begin_stall(&self, acks: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.stall = Some(AckStall {
                since: Instant::now(),
                acks,
            });
        }
    }

    fn clear_stall(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.stall = None;
        }
    }

    fn note_frame_submitted(&self, reset_watch: bool) {
        let decoded = self.decoded.load(Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock()
            && (reset_watch || state.decode_watch.is_none())
        {
            state.decode_watch = Some(DecodeWatch {
                since: Instant::now(),
                decoded,
            });
        }
    }

    fn record_decode_progress(&self, decoded: u32) {
        let first_confirmation = if let Ok(mut state) = self.state.lock() {
            state.decode_watch = Some(DecodeWatch {
                since: Instant::now(),
                decoded,
            });
            let first = !state.decode_confirmed;
            state.decode_confirmed = true;
            first
        } else {
            false
        };
        if first_confirmation {
            self.log
                .line("RDP EGFX client confirmed AVC420 decoded-frame progress");
        }
    }

    /// Give up on EGFX for this connection and return it to bitmap updates.
    ///
    /// The mapped surface is removed first: leaving it in place would let the
    /// client keep compositing a frozen surface over the graphics output and
    /// hide the bitmap updates that are about to take over.
    fn disable_after_stall(&self) {
        self.disable_after_failure_with_reason(format!(
            "client stopped acknowledging frames for {}ms",
            ACK_STALL_TIMEOUT.as_millis()
        ));
    }

    fn disable_after_decode_stall(&self) {
        self.disable_after_failure_with_reason(format!(
            "client acknowledged graphics frames without decoded-frame progress for {}ms",
            DECODE_STALL_TIMEOUT.as_millis()
        ));
    }

    /// Disable EGFX after a protocol, encoder, or transport failure. A stale
    /// mapped surface can continue to cover bitmap output on the client, so it
    /// is deleted before the display path falls back.
    pub(crate) fn disable_after_failure(&self) {
        self.disable_after_failure_with_reason("graphics pipeline failed".to_string());
    }

    fn disable_after_failure_with_reason(&self, reason: String) {
        let (handle, sender, surface) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.disabled {
                return;
            }
            state.disabled = true;
            state.stall = None;
            state.decode_watch = None;
            let surface = state.surface.take();
            let (Some(handle), Some(sender)) = (state.handle.clone(), state.sender.clone()) else {
                return;
            };
            (handle, sender, surface)
        };

        self.log
            .line(format!("RDP EGFX {reason}; returning to bitmap updates"));

        let Some(surface) = surface else {
            return;
        };
        let Ok(mut server) = handle.lock() else {
            return;
        };
        server.delete_surface(surface.id);
        let Some(channel_id) = server.channel_id() else {
            return;
        };
        let output = server.drain_output();
        drop(server);
        if let Some(messages) = encode_output(channel_id, output) {
            let _ = sender.send(ServerEvent::Egfx(EgfxServerMessage::SendMessages {
                messages,
            }));
        }
    }

    pub(crate) fn send_avc420(&self, frame: &Frame, h264: &[u8]) -> GfxSubmit {
        let Some(snapshot) = self.snapshot() else {
            return GfxSubmit::Unavailable;
        };

        let Ok(mut server) = snapshot.handle.lock() else {
            return GfxSubmit::Unavailable;
        };
        if !server.is_ready() || !server.supports_avc420() {
            return GfxSubmit::Unavailable;
        }
        if server.should_backpressure() {
            return GfxSubmit::Backpressured;
        }

        let reuse = snapshot
            .surface
            .filter(|surface| surface.width == frame.width && surface.height == frame.height);
        let (surface, created) = match reuse {
            Some(surface) => (surface, false),
            None => {
                // First frame, or the captured display changed mode. Resizing
                // publishes the new graphics output, drops the obsolete surface
                // so the client stops compositing it, and clears the ACK window
                // that referred to it.
                server.resize_with_monitors(
                    frame.width,
                    frame.height,
                    vec![desktop_monitor(frame.width, frame.height)],
                );
                let Some(id) = server.create_surface(frame.width, frame.height) else {
                    return GfxSubmit::Unavailable;
                };
                if !server.map_surface_to_output(id, 0, 0) {
                    return GfxSubmit::Unavailable;
                }
                (
                    GfxSurface {
                        id,
                        width: frame.width,
                        height: frame.height,
                    },
                    true,
                )
            }
        };

        let region = Avc420Region::full_frame(frame.width, frame.height, 26);
        let timestamp_ms = frame_timestamp_ms(snapshot.session_started, frame.captured_at);
        let queued = server
            .send_avc420_frame(surface.id, h264, &[region], timestamp_ms)
            .is_some();
        let channel_id = server.channel_id();
        let output = server.drain_output();
        drop(server);

        // The state lock is only taken after the server lock is released, so
        // this module always acquires the two in the same order.
        if created && let Ok(mut state) = self.state.lock() {
            state.surface = Some(surface);
        }
        if !queued {
            return GfxSubmit::Backpressured;
        }
        let Some(channel_id) = channel_id else {
            return GfxSubmit::Unavailable;
        };
        let Some(messages) = encode_output(channel_id, output) else {
            return GfxSubmit::Unavailable;
        };

        // Capture the decoded counter before the event can be processed and
        // acknowledged on the connection task. This makes the first decoded
        // frame observable even on a very low-latency local connection.
        self.note_frame_submitted(created);
        if snapshot
            .sender
            .send(ServerEvent::Egfx(EgfxServerMessage::SendMessages {
                messages,
            }))
            .is_err()
        {
            return GfxSubmit::Unavailable;
        }
        GfxSubmit::Sent
    }
}

/// Connection-scoped state read under the state lock, before the graphics
/// server lock is taken.
struct GfxSnapshot {
    handle: GfxServerHandle,
    sender: UnboundedSender<ServerEvent>,
    surface: Option<GfxSurface>,
    stall: Option<AckStall>,
    decode_watch: Option<DecodeWatch>,
    session_started: Instant,
}

fn frame_timestamp_ms(session_started: Instant, captured_at: Instant) -> u32 {
    let millis = captured_at
        .checked_duration_since(session_started)
        .unwrap_or_default()
        .as_millis();
    let modulus = u128::from(u32::MAX) + 1;
    u32::try_from(millis % modulus).expect("timestamp is reduced to the u32 range")
}

/// Single primary monitor covering the whole captured desktop. MS-RDPEGFX
/// allows an empty monitor array, but real servers always describe the layout,
/// and clients use it to place the graphics output buffer.
fn desktop_monitor(width: u16, height: u16) -> Monitor {
    Monitor {
        left: 0,
        top: 0,
        // TS_MONITOR_DEF uses inclusive lower-right coordinates. Using width
        // and height here describes a monitor one pixel larger in each axis
        // than the ResetGraphics output buffer, which Win11 may reject.
        right: i32::from(width.saturating_sub(1)),
        bottom: i32::from(height.saturating_sub(1)),
        flags: MonitorFlags::PRIMARY,
    }
}

fn encode_output(
    channel_id: u32,
    output: Vec<ironrdp::dvc::DvcMessage>,
) -> Option<Vec<SvcMessage>> {
    match encode_dvc_messages(channel_id, output, ChannelFlags::SHOW_PROTOCOL) {
        Ok(messages) => Some(messages),
        Err(error) => {
            tracing::warn!("RDP EGFX output encoding failed; using bitmap updates: {error}");
            None
        }
    }
}

/// Factory installed into IronRDP. A fresh graphics server is created for each
/// RDP connection; retaining the previous surface or ACK state across clients
/// would be protocol-invalid and could cause a new session to start stale.
pub(crate) struct EgfxFactory {
    state: Arc<Mutex<GfxState>>,
    acks: Arc<AtomicU64>,
    decoded: Arc<AtomicU32>,
    log: LogEmitter,
}

impl ServerEventSender for EgfxFactory {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        if let Ok(mut state) = self.state.lock() {
            state.sender = Some(sender);
        }
    }
}

impl GfxServerFactory for EgfxFactory {
    fn build_gfx_handler(&self) -> Box<dyn GraphicsPipelineHandler> {
        Box::new(EgfxHandler {
            acks: self.acks.clone(),
            decoded: self.decoded.clone(),
            log: self.log.clone(),
        })
    }

    fn build_server_with_handle(&self) -> Option<(GfxDvcBridge, GfxServerHandle)> {
        let server = Arc::new(Mutex::new(GraphicsPipelineServer::new(
            self.build_gfx_handler(),
        )));
        self.acks.store(0, Ordering::Relaxed);
        self.decoded.store(0, Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock() {
            state.handle = Some(server.clone());
            state.surface = None;
            // A fresh client gets a fresh verdict: an earlier client that
            // stopped acknowledging must not keep EGFX switched off.
            state.disabled = false;
            state.stall = None;
            state.decode_watch = None;
            state.decode_confirmed = false;
            state.session_started = Instant::now();
        }
        Some((GfxDvcBridge::new(server.clone()), server))
    }
}

struct EgfxHandler {
    acks: Arc<AtomicU64>,
    decoded: Arc<AtomicU32>,
    log: LogEmitter,
}

impl GraphicsPipelineHandler for EgfxHandler {
    fn capabilities_advertise(&mut self, _pdu: &CapabilitiesAdvertisePdu) {}

    fn on_ready(&mut self, _negotiated: &CapabilitySet) {
        self.log.line(
            "RDP EGFX channel negotiated; enabling AVC420 hardware video with decoded-frame validation",
        );
    }

    fn on_frame_ack(&mut self, _frame_id: u32, queue_depth: u32, total_frames_decoded: u32) {
        // Publishes liveness to the display side, which uses it to tell a
        // client that is one frame behind from one that has stopped consuming.
        self.acks.fetch_add(1, Ordering::Relaxed);
        self.decoded.store(total_frames_decoded, Ordering::Relaxed);
        tracing::trace!(
            queue_depth,
            total_frames_decoded,
            "RDP EGFX frame acknowledged"
        );
    }

    fn on_close(&mut self) {
        self.log
            .line("RDP EGFX channel closed; returning to bitmap updates");
    }

    fn max_frames_in_flight(&self) -> u32 {
        MAX_FRAMES_IN_FLIGHT
    }
}

/// Per-client VideoToolbox H.264 encoder. It stays inside the display updater
/// (and its dedicated RDP runtime thread), rather than the capture callback or
/// shared EGFX lock, so the capture source never waits for codec work.
pub(crate) struct H264Encoder {
    session: CFRetained<VTCompressionSession>,
    callback_state: Arc<EncoderCallbackState>,
    output: UnboundedReceiver<EncodedFrame>,
    width: u16,
    height: u16,
    encoded_width: u16,
    encoded_height: u16,
    next_timestamp: i64,
    next_frame_id: usize,
}

struct EncoderCallbackState {
    sender: UnboundedSender<EncodedFrame>,
    pending: Mutex<VecDeque<(usize, PendingInput)>>,
    in_flight: AtomicUsize,
}

struct PendingInput {
    _pixel_buffer: CFRetained<CVPixelBuffer>,
    _padded_input: Option<Vec<u8>>,
    frame: Frame,
    submitted_at: Instant,
    flushed: bool,
}

pub(crate) struct EncodedFrame {
    pub(crate) frame: Frame,
    pub(crate) result: anyhow::Result<Vec<u8>>,
}

// `RdpServerDisplayUpdates` requires a `Send` future even though Taomni runs
// this server on one dedicated current-thread runtime. VideoToolbox sessions
// are explicitly driven serially by that updater; we never share a session or
// use it concurrently. Moving the owning updater before its first poll is
// therefore safe, while declaring `Sync` would not be.
unsafe impl Send for H264Encoder {}

impl H264Encoder {
    pub(crate) fn new(width: u16, height: u16) -> anyhow::Result<Self> {
        let encoded_width = align_dimension(width)?;
        let encoded_height = align_dimension(height)?;
        let (output_tx, output) = tokio::sync::mpsc::unbounded_channel();
        let callback_state = Arc::new(EncoderCallbackState {
            sender: output_tx,
            pending: Mutex::new(VecDeque::new()),
            in_flight: AtomicUsize::new(0),
        });
        let mut raw = ptr::null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                i32::from(encoded_width),
                i32::from(encoded_height),
                kCMVideoCodecType_H264,
                None,
                None,
                None,
                Some(on_h264_encoded),
                Arc::as_ptr(&callback_state).cast_mut().cast(),
                NonNull::from(&mut raw),
            )
        };
        ensure_status(status, "create VideoToolbox H.264 encoder")?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| anyhow::anyhow!("VideoToolbox returned a null H.264 session"))?;
        let session = unsafe { CFRetained::from_raw(raw) };

        // Disable B-frame reordering and request real-time scheduling. Both
        // properties are essential for remote-control latency, and failure is
        // surfaced so the caller can safely use the regular bitmap channel.
        let vt_session = unsafe { compression_as_vt_session(&session) };
        ensure_status(
            unsafe {
                VTSessionSetProperty(
                    vt_session,
                    kVTCompressionPropertyKey_RealTime,
                    Some(CFBoolean::new(true).as_ref()),
                )
            },
            "enable VideoToolbox real-time encoding",
        )?;
        ensure_status(
            unsafe {
                VTSessionSetProperty(
                    vt_session,
                    kVTCompressionPropertyKey_AllowFrameReordering,
                    Some(CFBoolean::new(false).as_ref()),
                )
            },
            "disable VideoToolbox frame reordering",
        )?;
        let max_frame_delay = CFNumber::new_i32(1);
        let delay_status = unsafe {
            VTSessionSetProperty(
                vt_session,
                kVTCompressionPropertyKey_MaxFrameDelayCount,
                Some(max_frame_delay.as_ref()),
            )
        };
        if delay_status != 0 {
            tracing::debug!(
                status = delay_status,
                "VideoToolbox encoder does not support an explicit frame-delay window"
            );
        }
        ensure_status(
            unsafe { session.prepare_to_encode_frames() },
            "prepare VideoToolbox H.264 encoder",
        )?;

        Ok(Self {
            session,
            callback_state,
            output,
            width,
            height,
            encoded_width,
            encoded_height,
            next_timestamp: 0,
            next_frame_id: 0,
        })
    }

    pub(crate) fn matches(&self, frame: &Frame) -> bool {
        self.width == frame.width && self.height == frame.height
    }

    pub(crate) fn can_submit(&self) -> bool {
        self.callback_state.in_flight.load(Ordering::Relaxed) < MAX_ENCODER_FRAMES_IN_FLIGHT
    }

    pub(crate) fn oldest_deadline(&self) -> Option<Instant> {
        self.callback_state
            .pending
            .lock()
            .ok()?
            .front()
            .map(|(_, input)| input.submitted_at + ENCODE_TIMEOUT)
    }

    pub(crate) fn flush_deadline(&self) -> Option<Instant> {
        self.callback_state
            .pending
            .lock()
            .ok()?
            .iter()
            .find(|(_, input)| !input.flushed)
            .map(|(_, input)| input.submitted_at + ENCODE_FLUSH_DELAY)
    }

    pub(crate) fn flush_pending(&self) -> anyhow::Result<()> {
        {
            let mut pending = self
                .callback_state
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("VideoToolbox pending-frame lock poisoned"))?;
            for (_, input) in pending.iter_mut() {
                input.flushed = true;
            }
        }
        ensure_status(
            unsafe { self.session.complete_frames(kCMTimeInvalid) },
            "flush idle VideoToolbox H.264 frames",
        )
    }

    pub(crate) async fn next_output(&mut self) -> Option<EncodedFrame> {
        let output = self.output.recv().await;
        if output.is_some() {
            self.callback_state
                .in_flight
                .fetch_sub(1, Ordering::Relaxed);
        }
        output
    }

    /// Queue one frame and return immediately. The callback owns the retained
    /// input until VideoToolbox has finished reading it, so ScreenCaptureKit's
    /// IOSurface and any temporary macroblock padding outlive asynchronous
    /// encoding without blocking the display updater.
    pub(crate) fn submit(&mut self, frame: &Frame) -> anyhow::Result<()> {
        if !self.matches(frame) {
            anyhow::bail!("H.264 encoder dimensions no longer match captured frame");
        }
        if !self.can_submit() {
            anyhow::bail!("VideoToolbox H.264 queue is full");
        }

        let prepared = self.prepare_input(frame)?;
        let image_buffer =
            unsafe { pixel_buffer_as_image_buffer(&prepared.pixel_buffer) } as *const CVImageBuffer;
        self.next_frame_id = self.next_frame_id.wrapping_add(1).max(1);
        let frame_id = self.next_frame_id;
        self.callback_state
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("VideoToolbox pending-frame lock poisoned"))?
            .push_back((
                frame_id,
                PendingInput {
                    frame: frame.clone(),
                    submitted_at: Instant::now(),
                    flushed: false,
                    _pixel_buffer: prepared.pixel_buffer,
                    _padded_input: prepared.padded_input,
                },
            ));
        self.callback_state
            .in_flight
            .fetch_add(1, Ordering::Relaxed);

        self.next_timestamp = self.next_timestamp.saturating_add(1);
        let timestamp = unsafe { CMTime::new(self.next_timestamp, 30) };
        let duration = unsafe { kCMTimeInvalid };
        let status = unsafe {
            self.session.encode_frame(
                &*image_buffer,
                timestamp,
                duration,
                None,
                ptr::without_provenance_mut(frame_id),
                ptr::null_mut(),
            )
        };
        if status != 0 {
            if self.callback_state.take_pending(frame_id).is_some() {
                self.callback_state
                    .in_flight
                    .fetch_sub(1, Ordering::Relaxed);
            }
            ensure_status(status, "submit VideoToolbox H.264 frame")?;
        }
        Ok(())
    }

    fn prepare_input(&self, frame: &Frame) -> anyhow::Result<PreparedInput> {
        let aligned = (self.encoded_width, self.encoded_height) == (frame.width, frame.height);
        if aligned && let Some(pixel_buffer) = frame.native_pixel_buffer() {
            return Ok(PreparedInput {
                pixel_buffer,
                padded_input: None,
            });
        }

        let row_bytes = usize::from(frame.width)
            .checked_mul(4)
            .ok_or_else(|| anyhow::anyhow!("H.264 source row size overflow"))?;
        if frame.stride < row_bytes {
            anyhow::bail!("H.264 source stride is smaller than its visible row");
        }
        let source_length = frame
            .stride
            .checked_mul(usize::from(frame.height))
            .ok_or_else(|| anyhow::anyhow!("H.264 source frame size overflow"))?;
        if frame.byte_len() < source_length {
            anyhow::bail!(
                "H.264 source has {} bytes; expected at least {source_length}",
                frame.byte_len()
            );
        }

        let (base_address, input_stride, padded_input) = if aligned {
            let source = frame.bgra_bytes()?;
            let address = NonNull::new(source.as_ptr().cast_mut().cast::<c_void>())
                .ok_or_else(|| anyhow::anyhow!("cannot encode an empty captured frame"))?;
            (address, frame.stride, None)
        } else {
            let padded_stride = usize::from(self.encoded_width)
                .checked_mul(4)
                .ok_or_else(|| anyhow::anyhow!("aligned H.264 row size overflow"))?;
            let padded_length = padded_stride
                .checked_mul(usize::from(self.encoded_height))
                .ok_or_else(|| anyhow::anyhow!("aligned H.264 frame size overflow"))?;
            let mut padded = vec![0; padded_length];
            frame.copy_bgra_rows_to(&mut padded, padded_stride)?;
            let address = NonNull::new(padded.as_mut_ptr().cast::<c_void>())
                .ok_or_else(|| anyhow::anyhow!("cannot encode an empty padded frame"))?;
            (address, padded_stride, Some(padded))
        };

        let mut raw_pixel_buffer = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferCreateWithBytes(
                None,
                usize::from(self.encoded_width),
                usize::from(self.encoded_height),
                kCVPixelFormatType_32BGRA,
                base_address,
                input_stride,
                None,
                ptr::null_mut(),
                None,
                NonNull::from(&mut raw_pixel_buffer),
            )
        };
        if status != kCVReturnSuccess {
            anyhow::bail!("VideoToolbox input pixel buffer creation failed (status {status})");
        }
        let raw_pixel_buffer = NonNull::new(raw_pixel_buffer)
            .ok_or_else(|| anyhow::anyhow!("CoreVideo returned a null pixel buffer"))?;
        let pixel_buffer = unsafe { CFRetained::from_raw(raw_pixel_buffer) };
        Ok(PreparedInput {
            pixel_buffer,
            padded_input,
        })
    }
}

struct PreparedInput {
    pixel_buffer: CFRetained<CVPixelBuffer>,
    padded_input: Option<Vec<u8>>,
}

impl EncoderCallbackState {
    fn take_pending(&self, frame_id: usize) -> Option<PendingInput> {
        let mut pending = self.pending.lock().ok()?;
        let index = pending.iter().position(|(id, _)| *id == frame_id)?;
        pending.remove(index).map(|(_, input)| input)
    }
}

fn align_dimension(value: u16) -> anyhow::Result<u16> {
    if value == 0 {
        anyhow::bail!("cannot create an H.264 encoder with a zero dimension");
    }
    value
        .checked_add(15)
        .map(|padded| padded & !15)
        .ok_or_else(|| anyhow::anyhow!("H.264 dimension {value} cannot be aligned to 16 pixels"))
}

unsafe extern "C-unwind" fn on_h264_encoded(
    output_callback_ref_con: *mut c_void,
    source_frame_ref_con: *mut c_void,
    status: i32,
    _info_flags: objc2_video_toolbox::VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    if output_callback_ref_con.is_null() || source_frame_ref_con.is_null() {
        return;
    }
    let state = unsafe { &*output_callback_ref_con.cast::<EncoderCallbackState>() };
    let frame_id = source_frame_ref_con.addr();
    let Some(pending) = state.take_pending(frame_id) else {
        tracing::warn!(frame_id, "VideoToolbox returned an unknown H.264 frame");
        return;
    };
    let result = if status != 0 {
        Err(anyhow::anyhow!(
            "VideoToolbox H.264 frame encoding failed (status {status})"
        ))
    } else if sample.is_null() {
        Err(anyhow::anyhow!("VideoToolbox dropped an H.264 frame"))
    } else {
        unsafe { sample_to_avc(&*sample) }
    };
    if state
        .sender
        .send(EncodedFrame {
            frame: pending.frame,
            result,
        })
        .is_err()
    {
        state.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
        if let Ok(mut pending) = self.callback_state.pending.lock() {
            pending.clear();
        }
        self.callback_state.in_flight.store(0, Ordering::Relaxed);
    }
}

fn ensure_status(status: i32, operation: &str) -> anyhow::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        anyhow::bail!("{operation} failed (status {status})")
    }
}

/// VideoToolbox's APIs model all session variants as `VTSession` (CFType),
/// while the compression API returns its concrete opaque subtype. The cast is
/// the documented C ABI relationship and does not change ownership.
unsafe fn compression_as_vt_session(session: &CFRetained<VTCompressionSession>) -> &VTSession {
    unsafe { &*(session.as_ref() as *const VTCompressionSession).cast::<VTSession>() }
}

/// CVPixelBuffer is a CVImageBuffer subtype in the CoreVideo C ABI.
unsafe fn pixel_buffer_as_image_buffer(pixel_buffer: &CFRetained<CVPixelBuffer>) -> &CVImageBuffer {
    unsafe { &*(pixel_buffer.as_ref() as *const CVPixelBuffer).cast::<CVImageBuffer>() }
}

/// Convert one VideoToolbox sample into the AVC byte-stream form required by
/// `RFX_AVC420_BITMAP_STREAM`. CoreMedia stores encoded samples as AVCC, but
/// the NAL length prefix is allowed to vary with the encoder configuration;
/// MS-RDPEGFX requires every NAL in the wire payload to use a four-byte
/// big-endian length prefix. SPS/PPS live in the format description, so they
/// are prepended to every frame to make a newly-created surface independently
/// decodable.
unsafe fn sample_to_avc(sample: &CMSampleBuffer) -> anyhow::Result<Vec<u8>> {
    let block: CFRetained<CMBlockBuffer> = unsafe { sample.data_buffer() }
        .ok_or_else(|| anyhow::anyhow!("VideoToolbox returned H.264 without a data buffer"))?;
    let data_length = unsafe { block.data_length() };
    let mut h264 = vec![0; data_length];
    if data_length > 0 {
        let destination = NonNull::new(h264.as_mut_ptr().cast::<c_void>())
            .ok_or_else(|| anyhow::anyhow!("cannot copy an empty H.264 data buffer"))?;
        ensure_status(
            unsafe { block.copy_data_bytes(0, data_length, destination) },
            "copy VideoToolbox H.264 data",
        )?;
    }

    // VideoToolbox emits AVCC slices but stores SPS/PPS in the sample's format
    // description. Prefix the parameter sets on every frame: the cost is tiny,
    // while it makes each freshly-created RDP EGFX surface independently
    // decodable and avoids a stale decoder after a client reconnect.
    let description = unsafe { sample.format_description() }
        .ok_or_else(|| anyhow::anyhow!("VideoToolbox H.264 sample has no format description"))?;
    let mut count = 0;
    let mut nal_header_length = 0;
    ensure_status(
        unsafe {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                &description,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut count,
                &mut nal_header_length,
            )
        },
        "read VideoToolbox H.264 parameter-set count",
    )?;
    let nal_header_length = usize::try_from(nal_header_length)
        .ok()
        .filter(|length| (1..=4).contains(length))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "VideoToolbox returned invalid H.264 NAL header length {nal_header_length}"
            )
        })?;

    let mut output = Vec::with_capacity(h264.len().saturating_add(128));
    for index in 0..count {
        let mut pointer = ptr::null();
        let mut length = 0;
        ensure_status(
            unsafe {
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    &description,
                    index,
                    &mut pointer,
                    &mut length,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            "read VideoToolbox H.264 parameter set",
        )?;
        let length = u32::try_from(length)
            .map_err(|_| anyhow::anyhow!("VideoToolbox H.264 parameter set is too large"))?;
        if pointer.is_null() || length == 0 {
            anyhow::bail!("VideoToolbox returned an empty H.264 parameter set");
        }
        let parameter_set = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
        append_avc_nal(&mut output, parameter_set)?;
    }
    avcc_to_four_byte(&h264, nal_header_length, &mut output)?;
    Ok(output)
}

fn append_avc_nal(output: &mut Vec<u8>, nal: &[u8]) -> anyhow::Result<()> {
    let length = u32::try_from(nal.len())
        .map_err(|_| anyhow::anyhow!("H.264 NAL unit is too large for AVC wire format"))?;
    if length == 0 {
        anyhow::bail!("AVC stream contains an empty NAL unit");
    }
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(nal);
    Ok(())
}

fn avcc_to_four_byte(
    avcc: &[u8],
    nal_header_length: usize,
    output: &mut Vec<u8>,
) -> anyhow::Result<()> {
    if !(1..=4).contains(&nal_header_length) {
        anyhow::bail!("invalid AVCC NAL header length {nal_header_length}");
    }

    let mut offset = 0usize;
    let mut nal_count = 0usize;
    while offset < avcc.len() {
        let header_end = offset
            .checked_add(nal_header_length)
            .filter(|end| *end <= avcc.len())
            .ok_or_else(|| anyhow::anyhow!("truncated AVCC NAL length at byte {offset}"))?;
        let nal_length = avcc[offset..header_end]
            .iter()
            .fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
        if nal_length == 0 {
            anyhow::bail!("AVCC sample contains an empty NAL unit at byte {offset}");
        }
        let nal_end = header_end
            .checked_add(nal_length)
            .filter(|end| *end <= avcc.len())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "AVCC NAL at byte {offset} declares {nal_length} bytes beyond the sample"
                )
            })?;
        append_avc_nal(output, &avcc[header_end..nal_end])?;
        offset = nal_end;
        nal_count += 1;
    }

    if nal_count == 0 {
        anyhow::bail!("VideoToolbox returned an empty H.264 sample");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        ACK_STALL_TIMEOUT, AckStall, DECODE_STALL_TIMEOUT, DecodeWatch, ENCODE_TIMEOUT,
        H264Encoder, MAX_FRAMES_IN_FLIGHT, StallVerdict, align_dimension, avcc_to_four_byte,
        decode_verdict, desktop_monitor, frame_timestamp_ms, stall_verdict,
    };
    use crate::servers::rdp::capture::Frame;
    use ironrdp::pdu::gcc::MonitorFlags;

    #[test]
    fn graphics_path_keeps_only_a_two_frame_ack_window() {
        assert_eq!(MAX_FRAMES_IN_FLIGHT, 2);
    }

    #[test]
    fn a_live_but_slow_client_keeps_the_graphics_path() {
        // Backpressure has been active past the timeout, but acknowledgements
        // advanced in the meantime: the client is consuming, just one frame
        // behind. Dropping frames is correct here; disabling EGFX is not.
        let started = Instant::now();
        let stall = AckStall {
            since: started,
            acks: 4,
        };
        let now = started + ACK_STALL_TIMEOUT + Duration::from_millis(500);
        assert_eq!(stall_verdict(Some(stall), 5, now), StallVerdict::Restart);
    }

    #[test]
    fn a_client_that_stops_acknowledging_falls_back_to_bitmaps() {
        // Same elapsed time, no ACK progress. Without this bound the desktop
        // would stay frozen for as long as the client stayed connected.
        let started = Instant::now();
        let stall = AckStall {
            since: started,
            acks: 4,
        };
        let now = started + ACK_STALL_TIMEOUT + Duration::from_millis(500);
        assert_eq!(stall_verdict(Some(stall), 4, now), StallVerdict::Disable);
    }

    #[test]
    fn brief_backpressure_is_not_treated_as_a_stall() {
        let started = Instant::now();
        let stall = AckStall {
            since: started,
            acks: 4,
        };
        let now = started + ACK_STALL_TIMEOUT - Duration::from_millis(1);
        assert_eq!(stall_verdict(Some(stall), 4, now), StallVerdict::Wait);
        // No window recorded yet: open one against the current ACK count.
        assert_eq!(stall_verdict(None, 4, now), StallVerdict::Restart);
    }

    #[test]
    fn reset_graphics_describes_one_primary_desktop_monitor() {
        let monitor = desktop_monitor(1920, 1080);
        assert_eq!((monitor.left, monitor.top), (0, 0));
        assert_eq!((monitor.right, monitor.bottom), (1919, 1079));
        assert!(monitor.flags.contains(MonitorFlags::PRIMARY));
    }

    #[test]
    fn acknowledged_frames_without_decode_progress_fall_back_to_bitmaps() {
        let started = Instant::now();
        let watch = DecodeWatch {
            since: started,
            decoded: 7,
        };
        let now = started + DECODE_STALL_TIMEOUT + Duration::from_millis(1);
        assert_eq!(decode_verdict(watch, 7, now), StallVerdict::Disable);
    }

    #[test]
    fn decoded_frame_progress_keeps_accelerated_graphics_enabled() {
        let started = Instant::now();
        let watch = DecodeWatch {
            since: started,
            decoded: 7,
        };
        let now = started + DECODE_STALL_TIMEOUT + Duration::from_millis(1);
        assert_eq!(decode_verdict(watch, 8, now), StallVerdict::Restart);
    }

    #[test]
    fn first_decoded_frame_gets_a_bounded_validation_window() {
        let started = Instant::now();
        let watch = DecodeWatch {
            since: started,
            decoded: 0,
        };
        let now = started + DECODE_STALL_TIMEOUT - Duration::from_millis(1);
        assert_eq!(decode_verdict(watch, 0, now), StallVerdict::Wait);
    }

    #[test]
    fn aligns_avc420_dimensions_to_macroblocks() {
        assert_eq!(align_dimension(16).unwrap(), 16);
        assert_eq!(align_dimension(1918).unwrap(), 1920);
        assert_eq!(align_dimension(970).unwrap(), 976);
        assert!(align_dimension(0).is_err());
        assert!(align_dimension(u16::MAX).is_err());
    }

    async fn encode_test_frame(encoder: &mut H264Encoder, frame: &Frame) -> Vec<u8> {
        encoder.submit(frame).expect("submit VideoToolbox frame");
        encoder
            .flush_pending()
            .expect("flush VideoToolbox test frame");
        tokio::time::timeout(ENCODE_TIMEOUT, encoder.next_output())
            .await
            .expect("VideoToolbox callback timed out")
            .expect("VideoToolbox callback channel closed")
            .result
            .expect("encode VideoToolbox frame")
    }

    #[tokio::test]
    async fn video_toolbox_emits_an_avc_frame_for_rdpegfx() {
        // 16x16 is the smallest broadly-supported H.264 test surface. This
        // exercises the actual macOS hardware/software codec path without
        // requiring Screen Recording permission or a live RDP client.
        let frame = Frame::bgra(vec![0x80; 16 * 16 * 4], 0, 0, 16, 16, 16 * 4);
        let mut encoder = H264Encoder::new(16, 16).expect("create VideoToolbox encoder");
        let avc = encode_test_frame(&mut encoder, &frame).await;
        let nal_types = parse_avc_nal_types(&avc);

        assert!(nal_types.contains(&7), "frame must include an SPS");
        assert!(nal_types.contains(&8), "frame must include a PPS");
        assert!(
            nal_types.iter().any(|kind| matches!(kind, 1 | 5)),
            "frame must include a coded slice"
        );
    }

    #[tokio::test]
    async fn video_toolbox_encodes_non_aligned_desktops_through_a_padded_surface() {
        let frame = Frame::bgra(vec![0x80; 18 * 18 * 4], 0, 0, 18, 18, 18 * 4);
        let mut encoder = H264Encoder::new(18, 18).expect("create padded VideoToolbox encoder");
        let avc = encode_test_frame(&mut encoder, &frame).await;

        assert_eq!((encoder.encoded_width, encoder.encoded_height), (32, 32));
        assert!(!avc.is_empty());
    }

    #[test]
    fn graphics_timestamp_uses_the_session_clock() {
        let started = Instant::now();
        assert_eq!(
            frame_timestamp_ms(started, started + Duration::from_millis(1234)),
            1234
        );
    }

    #[test]
    fn normalizes_avcc_nal_lengths_to_four_byte_prefixes() {
        let avcc = [0, 0, 0, 2, 0x67, 0xaa, 0, 0, 0, 3, 0x65, 0xbb, 0xcc];
        let mut normalized = Vec::new();
        avcc_to_four_byte(&avcc, 4, &mut normalized).unwrap();

        assert_eq!(
            normalized,
            [
                [0, 0, 0, 2].as_slice(),
                [0x67, 0xaa].as_slice(),
                [0, 0, 0, 3].as_slice(),
                [0x65, 0xbb, 0xcc].as_slice(),
            ]
            .concat()
        );
    }

    #[test]
    fn rejects_truncated_avcc_nal_units() {
        let mut normalized = Vec::new();
        let error = avcc_to_four_byte(&[0, 0, 0, 4, 0x65], 4, &mut normalized).unwrap_err();
        assert!(error.to_string().contains("declares 4 bytes beyond"));
    }

    #[test]
    fn normalizes_short_avcc_length_prefixes() {
        let avcc = [0, 2, 0x67, 0xaa, 0, 3, 0x65, 0xbb, 0xcc];
        let mut normalized = Vec::new();
        avcc_to_four_byte(&avcc, 2, &mut normalized).unwrap();

        assert_eq!(
            normalized,
            [
                [0, 0, 0, 2].as_slice(),
                [0x67, 0xaa].as_slice(),
                [0, 0, 0, 3].as_slice(),
                [0x65, 0xbb, 0xcc].as_slice(),
            ]
            .concat()
        );
    }

    fn parse_avc_nal_types(avc: &[u8]) -> Vec<u8> {
        let mut offset = 0;
        let mut types = Vec::new();
        while offset + 4 <= avc.len() {
            let length = u32::from_be_bytes([
                avc[offset],
                avc[offset + 1],
                avc[offset + 2],
                avc[offset + 3],
            ]) as usize;
            offset += 4;
            if length == 0 || offset + length > avc.len() {
                break;
            }
            types.push(avc[offset] & 0x1f);
            offset += length;
        }
        types
    }
}
