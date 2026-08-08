//! RDP server display handler: produces [`DisplayUpdate`] frames for connected
//! clients.
//!
//! Real screen capture runs on a dedicated OS thread (native capture backends
//! hold non-`Send`, thread-affine handles — see [`super::capture`]). That thread
//! publishes BGRA frames through a latest-frame mailbox;
//! [`DisplayUpdatesImpl::next_update`] awaits that mailbox without allowing a
//! slow encoder or network to make the native capture callback retain stale
//! frames. A production RDP listener does not start when capture is unavailable;
//! serving a synthetic frame would falsely report healthy remote desktop service.
//!
//! Backends that can identify damage regions use the same mailbox. If their
//! partial updates would overlap a queued batch, the capture thread publishes a
//! replacement full refresh instead of risking a corrupt client framebuffer.

use core::num::{NonZeroU16, NonZeroUsize};
use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(target_os = "linux")]
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::time::Duration;

use async_trait::async_trait;
use ironrdp::server::{
    BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServerDisplay,
    RdpServerDisplayUpdates,
};
use tokio::sync::Notify;
#[cfg(target_os = "macos")]
use tokio::sync::oneshot;

#[cfg(target_os = "linux")]
use super::capture::PortalInput;
use super::capture::{Capturer, Frame, create_capturer_for_display};
#[cfg(target_os = "macos")]
use super::gfx::{EncodedFrame, GfxReadiness, GfxSubmit, GfxTransport, H264Encoder};
use super::metrics::RdpMetrics;
use crate::servers::engine::LogEmitter;

/// Display handler handed to the IronRDP builder. Probes the capture backend to
/// learn the real desktop size, falling back to the configured default.
pub(crate) struct RdpDisplay {
    log: LogEmitter,
    metrics: RdpMetrics,
    /// Desktop size reported to the client. Set from the capture backend when
    /// available, else the fallback size passed in at construction.
    size: DesktopSize,
    /// Windows capture is warmed before the listener accepts clients. This
    /// avoids creating a native capture object during post-auth display
    /// activation and guarantees a static desktop has a first frame.
    #[cfg(target_os = "windows")]
    mailbox: Arc<LatestFrameMailbox>,
    /// macOS capture is warmed before the listener becomes ready and remains
    /// alive across client authentication. This removes ScreenCaptureKit setup
    /// from the post-login critical path.
    #[cfg(target_os = "macos")]
    mailbox: Arc<LatestFrameMailbox>,
    #[cfg(target_os = "macos")]
    gfx: GfxTransport,
    #[cfg(target_os = "macos")]
    resize_tx: std::sync::mpsc::Sender<CaptureResizeRequest>,
    #[cfg(target_os = "macos")]
    supports_client_size: bool,
    #[cfg(target_os = "macos")]
    input_surface_size: Arc<AtomicU32>,
    /// Linux capture is also warmed before the listener starts. For Wayland
    /// this keeps the portal grant and PipeWire stream alive across RDP login;
    /// for X11 it avoids opening a second X connection per client.
    #[cfg(target_os = "linux")]
    mailbox: Arc<LatestFrameMailbox>,
    #[cfg(target_os = "linux")]
    portal_input: Option<std::sync::mpsc::SyncSender<PortalInput>>,
}

#[cfg(target_os = "macos")]
const CAPTURE_RESIZE_TIMEOUT: Duration = Duration::from_secs(7);

#[cfg(target_os = "macos")]
struct CaptureResizeRequest {
    size: DesktopSize,
    result: oneshot::Sender<Result<DesktopSize, String>>,
}

impl RdpDisplay {
    pub(crate) fn new(
        log: LogEmitter,
        display_id: Option<String>,
        metrics: RdpMetrics,
        view_only: bool,
        #[cfg(target_os = "macos")] gfx: GfxTransport,
    ) -> anyhow::Result<Self> {
        #[cfg(target_os = "windows")]
        let _ = view_only;

        #[cfg(target_os = "macos")]
        let (size, mailbox, resize_tx, supports_client_size) =
            start_warmed_macos_capture(log.clone(), display_id.clone(), metrics.clone())?;

        #[cfg(target_os = "linux")]
        let (size, mailbox, portal_input) = start_warmed_linux_capture(
            log.clone(),
            display_id.clone(),
            metrics.clone(),
            !view_only,
        )?;

        #[cfg(target_os = "macos")]
        let input_surface_size = Arc::new(AtomicU32::new(pack_desktop_size(size)));

        #[cfg(target_os = "windows")]
        let (size, mailbox) =
            start_warmed_windows_capture(log.clone(), display_id.clone(), metrics.clone())?;

        // Keep size() honest for the client on every native warm-up path.
        Ok(Self {
            log,
            metrics,
            size,
            #[cfg(target_os = "windows")]
            mailbox,
            #[cfg(target_os = "macos")]
            mailbox,
            #[cfg(target_os = "macos")]
            gfx,
            #[cfg(target_os = "macos")]
            resize_tx,
            #[cfg(target_os = "macos")]
            supports_client_size,
            #[cfg(target_os = "macos")]
            input_surface_size,
            #[cfg(target_os = "linux")]
            mailbox,
            #[cfg(target_os = "linux")]
            portal_input,
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn desktop_size(&self) -> DesktopSize {
        self.size
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn input_surface_size(&self) -> Arc<AtomicU32> {
        self.input_surface_size.clone()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn supports_client_size(&self) -> bool {
        self.supports_client_size
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn portal_input(&self) -> Option<std::sync::mpsc::SyncSender<PortalInput>> {
        self.portal_input.clone()
    }
}

#[cfg(target_os = "macos")]
fn pack_desktop_size(size: DesktopSize) -> u32 {
    (u32::from(size.width) << 16) | u32::from(size.height)
}

#[async_trait]
impl RdpServerDisplay for RdpDisplay {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    #[cfg(target_os = "macos")]
    async fn request_initial_size(&mut self, client_size: DesktopSize) -> DesktopSize {
        if !self.supports_client_size || client_size == self.size {
            return self.size;
        }

        let (result_tx, result_rx) = oneshot::channel();
        if self
            .resize_tx
            .send(CaptureResizeRequest {
                size: client_size,
                result: result_tx,
            })
            .is_err()
        {
            self.log
                .line("macOS capture resize channel closed; keeping physical display size");
            return self.size;
        }

        match tokio::time::timeout(CAPTURE_RESIZE_TIMEOUT, result_rx).await {
            Ok(Ok(Ok(size))) => {
                self.size = size;
                self.input_surface_size
                    .store(pack_desktop_size(size), Ordering::Relaxed);
                self.log.line(format!(
                    "macOS capture resized for RDP client: {}x{}",
                    size.width, size.height
                ));
                size
            }
            Ok(Ok(Err(error))) => {
                self.log.line(format!(
                    "macOS capture could not adopt client size; keeping {}x{}: {error}",
                    self.size.width, self.size.height
                ));
                self.size
            }
            Ok(Err(_)) => {
                self.log
                    .line("macOS capture resize response closed; keeping physical display size");
                self.size
            }
            Err(_) => {
                self.log.line(format!(
                    "macOS capture resize exceeded {}ms; keeping physical display size",
                    CAPTURE_RESIZE_TIMEOUT.as_millis()
                ));
                self.size
            }
        }
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        self.log.line("client requested display stream");
        #[cfg(target_os = "macos")]
        {
            // Authentication may finish while the desktop is static and
            // ScreenCaptureKit is emitting only idle markers. Replay the
            // retained complete frame rather than waiting for a future change.
            self.mailbox.replay_latest_full();
            return Ok(Box::new(DisplayUpdatesImpl::from_warmed_capture(
                self.mailbox.clone(),
                self.size,
                self.metrics.clone(),
                self.gfx.clone(),
            )));
        }

        #[cfg(target_os = "linux")]
        {
            self.mailbox.replay_latest_full();
            return Ok(Box::new(DisplayUpdatesImpl::from_warmed_linux_capture(
                self.mailbox.clone(),
                self.size,
                self.metrics.clone(),
            )));
        }

        #[cfg(target_os = "windows")]
        {
            self.mailbox.replay_latest_full();
            Ok(Box::new(DisplayUpdatesImpl::from_warmed_windows_capture(
                self.mailbox.clone(),
                self.size,
                self.metrics.clone(),
            )))
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for RdpDisplay {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}

#[cfg(target_os = "linux")]
impl Drop for RdpDisplay {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}

/// Per-client update producer that drains the native capture thread.
pub(crate) struct DisplayUpdatesImpl {
    mailbox: Arc<LatestFrameMailbox>,
    active_damage: VecDeque<Frame>,
    metrics: RdpMetrics,
    current_size: DesktopSize,
    deferred_full: Option<Frame>,
    #[cfg(target_os = "macos")]
    gfx: GfxTransport,
    #[cfg(target_os = "macos")]
    h264: Option<H264Encoder>,
}

#[cfg(target_os = "macos")]
enum MacUpdateEvent {
    Capture(Option<PendingFrames>),
    Encoded(Option<EncodedFrame>),
    EncodeFlush,
    EncodeTimeout,
}

/// Cross-thread latest-frame mailbox. Unlike `mpsc::channel(1)` plus
/// `blocking_send`, publishing a new full frame replaces the stale pending
/// frame and never makes the native capture callback wait for an encoder.
///
/// Damage batches need stronger guarantees: a dropped rectangle can leave a
/// permanent hole in the client framebuffer. When a damage batch is already
/// pending or being drained we therefore ask the capture loop for one fresh
/// full frame, which safely supersedes all prior partial updates.
struct LatestFrameMailbox {
    state: Mutex<MailboxState>,
    ready: Notify,
}

struct MailboxState {
    pending: Option<PendingFrames>,
    /// Latest complete desktop retained with reference-counted pixel storage.
    /// Partial damage is never stored here because it cannot seed a new client.
    latest_full: Option<Frame>,
    active_damage: bool,
    closed: bool,
}

enum PendingFrames {
    Full(Frame),
    Damage(VecDeque<Frame>),
}

enum PublishResult {
    Published { replaced: bool },
    NeedsFullRefresh,
    Closed,
}

impl LatestFrameMailbox {
    fn new() -> Self {
        Self {
            state: Mutex::new(MailboxState {
                pending: None,
                latest_full: None,
                active_damage: false,
                closed: false,
            }),
            ready: Notify::new(),
        }
    }

    fn publish_full(&self, frame: Frame) -> PublishResult {
        let Ok(mut state) = self.state.lock() else {
            return PublishResult::Closed;
        };
        if state.closed {
            return PublishResult::Closed;
        }
        let replaced = state.pending.is_some() || state.active_damage;
        state.latest_full = Some(frame.clone());
        state.pending = Some(PendingFrames::Full(frame));
        self.ready.notify_one();
        PublishResult::Published { replaced }
    }

    fn publish_damage(&self, frames: Vec<Frame>) -> PublishResult {
        let Ok(mut state) = self.state.lock() else {
            return PublishResult::Closed;
        };
        if state.closed {
            return PublishResult::Closed;
        }
        if frames.is_empty() {
            return PublishResult::Published { replaced: false };
        }
        if state.pending.is_some() || state.active_damage {
            return PublishResult::NeedsFullRefresh;
        }
        state.pending = Some(PendingFrames::Damage(frames.into()));
        self.ready.notify_one();
        PublishResult::Published { replaced: false }
    }

    async fn take(&self) -> Option<PendingFrames> {
        loop {
            // Register interest before inspecting the state. This prevents a
            // producer notification between the empty check and `.await()`
            // from being lost.
            let notified = self.ready.notified();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(pending) = state.pending.take() {
                    state.active_damage = matches!(&pending, PendingFrames::Damage(_));
                    return Some(pending);
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    /// Queue the retained full desktop for a newly authenticated client. The
    /// clone only increments the `Bytes` reference count; pixel memory is not
    /// copied.
    fn replay_latest_full(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        let Some(frame) = state.latest_full.clone() else {
            return;
        };
        state.pending = Some(PendingFrames::Full(frame));
        state.active_damage = false;
        self.ready.notify_one();
    }

    /// An active partial batch becomes obsolete as soon as a new full refresh
    /// is waiting. In that case the remaining rectangles must not be emitted.
    fn full_refresh_waiting(&self) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| matches!(state.pending, Some(PendingFrames::Full(_))))
    }

    fn finish_damage(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active_damage = false;
        }
    }

    /// Whether the consuming client has gone away. The capture loop checks this
    /// on idle ticks, where it has no frame to publish and would otherwise not
    /// notice a disconnect.
    fn is_closed(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.closed)
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.pending = None;
            state.latest_full = None;
        }
        self.ready.notify_waiters();
    }
}

impl DisplayUpdatesImpl {
    #[cfg(target_os = "macos")]
    fn from_warmed_capture(
        mailbox: Arc<LatestFrameMailbox>,
        size: DesktopSize,
        metrics: RdpMetrics,
        gfx: GfxTransport,
    ) -> Self {
        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            current_size: size,
            deferred_full: None,
            gfx,
            h264: None,
        }
    }

    #[cfg(target_os = "linux")]
    fn from_warmed_linux_capture(
        mailbox: Arc<LatestFrameMailbox>,
        size: DesktopSize,
        metrics: RdpMetrics,
    ) -> Self {
        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            current_size: size,
            deferred_full: None,
        }
    }

    #[cfg(target_os = "windows")]
    fn from_warmed_windows_capture(
        mailbox: Arc<LatestFrameMailbox>,
        size: DesktopSize,
        metrics: RdpMetrics,
    ) -> Self {
        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            current_size: size,
            deferred_full: None,
        }
    }

    /// Wrap a captured BGRA frame (full screen or a cropped damage region) into
    /// a [`BitmapUpdate`] placed at the region's origin. The IronRDP encoder
    /// diffs it against its framebuffer at that offset and encodes only the
    /// changed tiles, so a small region costs O(region), not O(screen).
    fn frame_to_bitmap(frame: Frame) -> Option<BitmapUpdate> {
        let width = NonZeroU16::new(frame.width)?;
        let height = NonZeroU16::new(frame.height)?;
        let stride = NonZeroUsize::new(frame.stride)?;
        Some(BitmapUpdate {
            x: frame.x,
            y: frame.y,
            width,
            height,
            format: PixelFormat::BgrA32,
            data: match frame.bgra_bytes() {
                Ok(data) => data,
                Err(error) => {
                    tracing::warn!("RDP bitmap pixel readback failed: {error}");
                    return None;
                }
            },
            stride,
        })
    }

    /// Prefer the negotiated EGFX/AVC420 path on macOS. The decision is made
    /// after capture and before turning pixels into a regular RDP bitmap so a
    /// slow client can drop a current frame instead of queuing stale work.
    #[cfg(target_os = "macos")]
    fn try_queue_gfx(&mut self, frame: &Frame) -> bool {
        match self.gfx.readiness() {
            GfxReadiness::Backpressured => return true,
            GfxReadiness::Unavailable => {
                self.h264 = None;
                return false;
            }
            GfxReadiness::Ready => {}
        }
        let needs_new_encoder = self
            .h264
            .as_ref()
            .is_none_or(|encoder| !encoder.matches(frame));
        if needs_new_encoder {
            match H264Encoder::new(frame.width, frame.height) {
                Ok(encoder) => self.h264 = Some(encoder),
                Err(error) => {
                    tracing::warn!(
                        "RDP EGFX hardware encoder unavailable; using bitmap updates: {error}"
                    );
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    return false;
                }
            }
        }
        let Some(encoder) = self.h264.as_mut() else {
            return false;
        };
        if !encoder.can_submit() {
            return true;
        }
        match encoder.submit(frame) {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!("RDP EGFX hardware submit failed; using bitmap update: {error}");
                self.h264 = None;
                self.gfx.disable_after_failure();
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn finish_gfx_encode(&mut self, encoded: EncodedFrame) -> Option<Frame> {
        let frame = encoded.frame;
        match encoded.result {
            Ok(h264) => {
                let submit = self.gfx.send_avc420(&frame, &h264);
                if matches!(submit, GfxSubmit::Unavailable) {
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    Some(frame)
                } else {
                    None
                }
            }
            Err(error) => {
                tracing::warn!("RDP EGFX hardware frame failed; using bitmap update: {error}");
                self.h264 = None;
                self.gfx.disable_after_failure();
                Some(frame)
            }
        }
    }

    #[cfg(target_os = "macos")]
    async fn next_macos_event(&mut self) -> MacUpdateEvent {
        let Some(encoder) = self.h264.as_mut() else {
            return MacUpdateEvent::Capture(self.mailbox.take().await);
        };
        let deadline = encoder.oldest_deadline();
        let flush_deadline = encoder.flush_deadline();
        let timeout = async move {
            match deadline {
                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                None => std::future::pending().await,
            }
        };
        let flush = async move {
            match flush_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(timeout);
        tokio::pin!(flush);
        tokio::select! {
            encoded = encoder.next_output() => MacUpdateEvent::Encoded(encoded),
            capture = self.mailbox.take() => MacUpdateEvent::Capture(capture),
            () = &mut flush => MacUpdateEvent::EncodeFlush,
            () = &mut timeout => MacUpdateEvent::EncodeTimeout,
        }
    }
}

#[async_trait]
impl RdpServerDisplayUpdates for DisplayUpdatesImpl {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        loop {
            if !self.active_damage.is_empty() && self.mailbox.full_refresh_waiting() {
                self.active_damage.clear();
                self.mailbox.finish_damage();
            }

            if let Some(frame) = self.deferred_full.take() {
                self.metrics.record_frame_handoff(frame.captured_at);
                self.metrics.report_if_due();
                #[cfg(target_os = "macos")]
                {
                    if self.try_queue_gfx(&frame) {
                        continue;
                    }
                }
                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
            }

            if let Some(frame) = self.active_damage.pop_front() {
                if self.active_damage.is_empty() {
                    self.mailbox.finish_damage();
                }
                self.metrics.record_frame_handoff(frame.captured_at);
                self.metrics.report_if_due();
                #[cfg(target_os = "macos")]
                {
                    if self.try_queue_gfx(&frame) {
                        continue;
                    }
                    return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                }
                #[cfg(not(target_os = "macos"))]
                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
            }

            #[cfg(target_os = "macos")]
            let pending = match self.next_macos_event().await {
                MacUpdateEvent::Capture(pending) => pending,
                MacUpdateEvent::Encoded(Some(encoded)) => {
                    if let Some(frame) = self.finish_gfx_encode(encoded) {
                        return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                    }
                    continue;
                }
                MacUpdateEvent::Encoded(None) => {
                    tracing::warn!("RDP EGFX hardware output channel closed; using bitmap updates");
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    self.mailbox.replay_latest_full();
                    continue;
                }
                MacUpdateEvent::EncodeFlush => {
                    let flush_result = self
                        .h264
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("H.264 encoder disappeared before flush"))
                        .and_then(H264Encoder::flush_pending);
                    if let Err(error) = flush_result {
                        tracing::warn!(
                            "RDP EGFX idle hardware flush failed; using bitmap updates: {error}"
                        );
                        self.h264 = None;
                        self.gfx.disable_after_failure();
                        self.mailbox.replay_latest_full();
                    }
                    continue;
                }
                MacUpdateEvent::EncodeTimeout => {
                    tracing::warn!(
                        "RDP EGFX hardware frame exceeded the {}ms latency budget; using bitmap updates",
                        super::gfx::ENCODE_TIMEOUT.as_millis()
                    );
                    self.h264 = None;
                    self.gfx.disable_after_failure();
                    self.mailbox.replay_latest_full();
                    continue;
                }
            };

            #[cfg(not(target_os = "macos"))]
            let pending = self.mailbox.take().await;

            match pending {
                Some(PendingFrames::Full(frame)) => {
                    let frame_size = DesktopSize {
                        width: frame.width,
                        height: frame.height,
                    };
                    if frame_size != self.current_size {
                        self.current_size = frame_size;
                        self.deferred_full = Some(frame);
                        return Ok(Some(DisplayUpdate::Resize(frame_size)));
                    }
                    self.metrics.record_frame_handoff(frame.captured_at);
                    self.metrics.report_if_due();
                    #[cfg(target_os = "macos")]
                    {
                        if self.try_queue_gfx(&frame) {
                            continue;
                        }
                        return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                    }
                    #[cfg(not(target_os = "macos"))]
                    return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                }
                Some(PendingFrames::Damage(frames)) => {
                    self.active_damage = frames;
                }
                None => return Ok(None),
            }
        }
    }
}

/// Drive a warmed capture backend until the client disconnects or capture
/// fails, publishing updates to the display task.
///
/// Two regimes, chosen by the backend:
///
/// - **Event-driven** (X11 XDamage): the backend blocks until the screen
///   actually changes and returns only the changed regions (the first frame is
///   full, to seed the encoder framebuffer). No interval, no hashing — idle
///   costs nothing and a small change sends a small region.
/// - **Polling backend** (X11 without DAMAGE, macOS, or other platforms):
///   capture a full frame on a ~30 fps interval and suppress
///   byte-identical frames with a cheap FNV-1a hash so a static desktop still
///   costs near-zero downstream. The IronRDP encoder diffs the frames we DO
///   send and only encodes changed rectangles.
#[cfg(target_os = "macos")]
fn start_warmed_macos_capture(
    log: LogEmitter,
    display_id: Option<String>,
    metrics: RdpMetrics,
) -> anyhow::Result<(
    DesktopSize,
    Arc<LatestFrameMailbox>,
    std::sync::mpsc::Sender<CaptureResizeRequest>,
    bool,
)> {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (resize_tx, resize_rx) = std::sync::mpsc::channel();

    std::thread::Builder::new()
        .name("rdp-capture".to_string())
        .spawn({
            let worker_mailbox = mailbox.clone();
            move || {
                let result = (|| {
                    let mut capturer =
                        create_capturer_for_display(&log, display_id.as_deref(), false)?;
                    let supports_client_size = capturer.supports_output_resize();

                    // Both ScreenCaptureKit and its legacy fallback retain the
                    // initial frame acquired during construction. Publish it
                    // before declaring the server ready, so authentication can
                    // never race native stream startup or a static desktop.
                    let started = std::time::Instant::now();
                    let mut initial = capturer.capture()?;
                    let width = NonZeroU16::new(initial.width)
                        .ok_or_else(|| anyhow::anyhow!("screen capture reported zero width"))?;
                    let height = NonZeroU16::new(initial.height)
                        .ok_or_else(|| anyhow::anyhow!("screen capture reported zero height"))?;
                    metrics.record_capture(started.elapsed(), initial.byte_len());
                    initial.sequence = 1;
                    if matches!(worker_mailbox.publish_full(initial), PublishResult::Closed) {
                        anyhow::bail!("screen capture mailbox closed during warm-up");
                    }

                    Ok((
                        DesktopSize {
                            width: width.get(),
                            height: height.get(),
                        },
                        capturer,
                        supports_client_size,
                    ))
                })();

                let (size, capturer, supports_client_size) = match result {
                    Ok(ready) => ready,
                    Err(error) => {
                        worker_mailbox.close();
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok((size, supports_client_size))).is_err() {
                    worker_mailbox.close();
                    return;
                }

                log.line(format!(
                    "macOS capture pre-warmed for RDP login ({}x{}); first frame is ready",
                    size.width, size.height
                ));
                drive_capture(log, worker_mailbox, capturer, metrics, Some(resize_rx));
            }
        })
        .map_err(|error| anyhow::anyhow!("spawn macOS capture thread: {error}"))?;

    let (size, supports_client_size) = ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("macOS capture thread stopped during warm-up"))??;
    Ok((size, mailbox, resize_tx, supports_client_size))
}

/// Start one Linux capture owner before the RDP listener accepts clients.
/// Wayland portal permissions and the PipeWire stream are tied to the portal
/// session, so creating this backend per client would trigger repeated consent
/// dialogs and lose the first frame during authentication.
#[cfg(target_os = "linux")]
fn start_warmed_linux_capture(
    log: LogEmitter,
    display_id: Option<String>,
    metrics: RdpMetrics,
    request_input: bool,
) -> anyhow::Result<(
    DesktopSize,
    Arc<LatestFrameMailbox>,
    Option<SyncSender<PortalInput>>,
)> {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (portal_tx, portal_rx) = std::sync::mpsc::sync_channel(256);

    std::thread::Builder::new()
        .name("rdp-capture".to_string())
        .spawn({
            let worker_mailbox = mailbox.clone();
            move || {
                let result = (|| {
                    let mut capturer =
                        create_capturer_for_display(&log, display_id.as_deref(), request_input)?;
                    let supports_input = request_input && capturer.supports_portal_input();
                    let input_rx = supports_input.then_some(portal_rx);
                    let started = std::time::Instant::now();
                    let mut initial = capturer.capture()?;
                    let width = NonZeroU16::new(initial.width)
                        .ok_or_else(|| anyhow::anyhow!("screen capture reported zero width"))?;
                    let height = NonZeroU16::new(initial.height)
                        .ok_or_else(|| anyhow::anyhow!("screen capture reported zero height"))?;
                    metrics.record_capture(started.elapsed(), initial.byte_len());
                    initial.sequence = 1;
                    if matches!(worker_mailbox.publish_full(initial), PublishResult::Closed) {
                        anyhow::bail!("screen capture mailbox closed during warm-up");
                    }
                    Ok((
                        DesktopSize {
                            width: width.get(),
                            height: height.get(),
                        },
                        capturer,
                        input_rx,
                        supports_input,
                    ))
                })();

                let (size, capturer, input_rx, supports_input) = match result {
                    Ok(ready) => ready,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok((size, supports_input))).is_err() {
                    worker_mailbox.close();
                    return;
                }
                log.line(format!(
                    "Linux capture pre-warmed for RDP login ({}x{}; portal_input={})",
                    size.width,
                    size.height,
                    if supports_input {
                        "granted"
                    } else {
                        "native/disabled"
                    }
                ));
                drive_capture(log, worker_mailbox, capturer, metrics, input_rx);
            }
        })
        .map_err(|error| anyhow::anyhow!("spawn Linux capture thread: {error}"))?;

    let (size, supports_input) = ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Linux capture thread stopped during warm-up"))??;
    Ok((size, mailbox, supports_input.then_some(portal_tx)))
}

/// Start one Windows WGC capture owner before the RDP listener accepts clients.
/// Graphics Capture is tied to the interactive console and can be
/// expensive to initialize, so readiness includes a validated first frame.
#[cfg(target_os = "windows")]
fn start_warmed_windows_capture(
    log: LogEmitter,
    display_id: Option<String>,
    metrics: RdpMetrics,
) -> anyhow::Result<(DesktopSize, Arc<LatestFrameMailbox>)> {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);

    std::thread::Builder::new()
        .name("rdp-capture".to_string())
        .spawn({
            let worker_mailbox = mailbox.clone();
            move || {
                let result = (|| {
                    let mut capturer =
                        create_capturer_for_display(&log, display_id.as_deref(), false)?;
                    let started = std::time::Instant::now();
                    let mut initial = capturer.capture()?;
                    let width = NonZeroU16::new(initial.width)
                        .ok_or_else(|| anyhow::anyhow!("Windows capture reported zero width"))?;
                    let height = NonZeroU16::new(initial.height)
                        .ok_or_else(|| anyhow::anyhow!("Windows capture reported zero height"))?;
                    metrics.record_capture(started.elapsed(), initial.byte_len());
                    initial.sequence = 1;
                    if matches!(worker_mailbox.publish_full(initial), PublishResult::Closed) {
                        anyhow::bail!("Windows capture mailbox closed during warm-up");
                    }
                    Ok((
                        DesktopSize {
                            width: width.get(),
                            height: height.get(),
                        },
                        capturer,
                    ))
                })();

                let (size, capturer) = match result {
                    Ok(ready) => ready,
                    Err(error) => {
                        worker_mailbox.close();
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok(size)).is_err() {
                    worker_mailbox.close();
                    return;
                }
                log.line(format!(
                    "Windows capture pre-warmed for RDP login ({}x{}; WGC/GDI)",
                    size.width, size.height
                ));
                drive_capture(log, worker_mailbox, capturer, metrics);
            }
        })
        .map_err(|error| anyhow::anyhow!("spawn Windows capture thread: {error}"))?;

    let size = ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Windows capture thread stopped during warm-up"))??;
    Ok((size, mailbox))
}

#[cfg(target_os = "windows")]
impl Drop for RdpDisplay {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}

fn drive_capture(
    log: LogEmitter,
    mailbox: Arc<LatestFrameMailbox>,
    mut capturer: Box<dyn Capturer>,
    metrics: RdpMetrics,
    #[cfg(target_os = "macos")] resize_rx: Option<std::sync::mpsc::Receiver<CaptureResizeRequest>>,
    #[cfg(target_os = "linux")] input_rx: Option<Receiver<PortalInput>>,
) {
    if capturer.is_event_driven() {
        capture_loop_event_driven(capturer.as_mut(), &mailbox, &metrics);
    } else {
        capture_loop_polling(
            capturer.as_mut(),
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            resize_rx.as_ref(),
            #[cfg(target_os = "linux")]
            input_rx.as_ref(),
        );
    }
    // Every producer exit must wake consumers. This covers native stream
    // errors, malformed frames, and backend failures; otherwise a connected
    // RDP client could wait forever on a mailbox whose producer has died.
    mailbox.close();
    log.line("capture thread stopped");
}

/// Damage-driven loop: forward whatever regions the backend reports. The
/// backend internally blocks on change notifications and caps the frame rate,
/// so this loop adds no interval of its own. An empty result is an idle tick;
/// we use it to notice a disconnected client (closed channel) promptly.
fn capture_loop_event_driven(
    capturer: &mut dyn Capturer,
    mailbox: &LatestFrameMailbox,
    metrics: &RdpMetrics,
) {
    let mut first = true;
    let mut sequence = 0;
    loop {
        match capturer.next_updates(first) {
            Ok(mut frames) => {
                first = false;
                if frames.is_empty() {
                    // Idle tick: nothing changed within the wait budget. Bail
                    // out if the client went away, otherwise keep waiting.
                    if matches!(mailbox.publish_damage(Vec::new()), PublishResult::Closed) {
                        break;
                    }
                    continue;
                }
                for frame in &mut frames {
                    // This backend sleeps until the screen changes and caps its
                    // own rate, so the time since the call started is mostly
                    // deliberate waiting. Report each region's age at handoff.
                    metrics.record_capture(frame.captured_at.elapsed(), frame.byte_len());
                    sequence += 1;
                    frame.sequence = sequence;
                }

                match mailbox.publish_damage(frames) {
                    PublishResult::Published { replaced } => {
                        if replaced {
                            metrics.record_frame_replaced();
                        }
                    }
                    PublishResult::NeedsFullRefresh => {
                        let full_started = std::time::Instant::now();
                        let mut full = match capturer.capture() {
                            Ok(frame) => frame,
                            Err(e) => {
                                tracing::warn!("RDP capture (damage full refresh): {}", e);
                                break;
                            }
                        };
                        metrics.record_capture(full_started.elapsed(), full.byte_len());
                        sequence += 1;
                        full.sequence = sequence;
                        match mailbox.publish_full(full) {
                            PublishResult::Published { replaced } => {
                                if replaced {
                                    metrics.record_frame_replaced();
                                }
                            }
                            PublishResult::Closed => return,
                            PublishResult::NeedsFullRefresh => {
                                unreachable!("full frames always publish")
                            }
                        }
                    }
                    PublishResult::Closed => return,
                }
                metrics.report_if_due();
            }
            Err(e) => {
                tracing::warn!("RDP capture (damage): {}", e);
                break;
            }
        }
    }
}

/// Fixed-interval full-frame loop with FNV-1a dedup (used when the backend is
/// not event-driven). ~30 fps ceiling; identical frames are suppressed so a
/// static desktop costs nothing downstream.
///
/// A backend that reports an idle tick ([`Capturer::poll_frame`] returning
/// `Ok(None)`) has simply seen no change. That is the steady state of an
/// untouched desktop and must never end this loop: the mailbox has no producer
/// once this thread exits, so `next_update` would block forever and freeze the
/// client on its last frame while the connection still looks healthy.
fn capture_loop_polling(
    capturer: &mut dyn Capturer,
    mailbox: &LatestFrameMailbox,
    metrics: &RdpMetrics,
    #[cfg(target_os = "macos")] resize_rx: Option<&std::sync::mpsc::Receiver<CaptureResizeRequest>>,
    #[cfg(target_os = "linux")] input_rx: Option<&Receiver<PortalInput>>,
) {
    // A backend that caps its own frame rate must not be paced again: the extra
    // sleep would hold back a frame that is already sitting in its mailbox.
    let self_paced = capturer.is_self_paced();
    let needs_deduplication = capturer.needs_frame_deduplication();
    let frame_interval = (!self_paced).then(|| std::time::Duration::from_millis(33));
    let mut last_hash: Option<u64> = None;
    let mut first = true;
    let mut sequence = 0;
    #[cfg(target_os = "linux")]
    let mut input_failed = false;
    loop {
        #[cfg(target_os = "linux")]
        if let Some(input_rx) = input_rx {
            while let Ok(input) = input_rx.try_recv() {
                if !input_failed {
                    if let Err(error) = capturer.inject_portal_input(input) {
                        tracing::warn!(%error, "Wayland portal input injection stopped");
                        input_failed = true;
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(resize_rx) = resize_rx {
            while let Ok(request) = resize_rx.try_recv() {
                let result = capturer
                    .resize_output(request.size.width, request.size.height)
                    .and_then(|mut frame| {
                        if frame.width != request.size.width || frame.height != request.size.height
                        {
                            anyhow::bail!(
                                "capture backend returned {}x{} after requesting {}x{}",
                                frame.width,
                                frame.height,
                                request.size.width,
                                request.size.height
                            );
                        }
                        metrics.record_capture(frame.captured_at.elapsed(), frame.byte_len());
                        sequence += 1;
                        frame.sequence = sequence;
                        match mailbox.publish_full(frame) {
                            PublishResult::Published { replaced } => {
                                if replaced {
                                    metrics.record_frame_replaced();
                                }
                                Ok(request.size)
                            }
                            PublishResult::Closed => {
                                anyhow::bail!("RDP display closed during capture resize")
                            }
                            PublishResult::NeedsFullRefresh => {
                                unreachable!("full frames always publish")
                            }
                        }
                    })
                    .map_err(|error| error.to_string());
                if result.is_ok() {
                    first = false;
                    last_hash = None;
                }
                let closed = result
                    .as_ref()
                    .is_err_and(|error| error == "RDP display closed during capture resize");
                let _ = request.result.send(result);
                if closed {
                    return;
                }
            }
        }
        let start = std::time::Instant::now();
        match capturer.poll_frame() {
            Ok(Some(mut frame)) => {
                // Charge only pixel production to "capture". A self-paced poll
                // blocks until the next frame exists, so its elapsed time is the
                // frame interval, not our cost — the frame's age at pickup is.
                // A grab-on-demand poll does the work inline, so there the call
                // duration is the cost and the frame's age is ~zero.
                let capture_cost = if self_paced {
                    frame.captured_at.elapsed()
                } else {
                    start.elapsed()
                };
                metrics.record_capture(capture_cost, frame.byte_len());
                // ScreenCaptureKit already reports an explicit idle tick when
                // nothing changed. Avoid scanning its entire Retina-sized BGRA
                // surface again; polling backends still need the hash to stop
                // unchanged frames before they reach IronRDP.
                let changed = if needs_deduplication {
                    let hash_started = std::time::Instant::now();
                    let hash = super::diff::frame_hash(&frame.data);
                    metrics.record_hash(hash_started.elapsed());
                    let changed = first || last_hash != Some(hash);
                    last_hash = Some(hash);
                    changed
                } else {
                    true
                };
                // Always send the first frame so the client gets an initial
                // image; thereafter suppress byte-identical frames only for
                // sources that cannot report idle explicitly.
                if changed {
                    first = false;
                    sequence += 1;
                    frame.sequence = sequence;
                    match mailbox.publish_full(frame) {
                        PublishResult::Published { replaced } => {
                            if replaced {
                                metrics.record_frame_replaced();
                            }
                        }
                        PublishResult::Closed => break,
                        PublishResult::NeedsFullRefresh => {
                            unreachable!("full frames always publish")
                        }
                    }
                } else {
                    metrics.record_duplicate_frame();
                }
                if let Some(rem) = frame_interval.and_then(|i| i.checked_sub(start.elapsed())) {
                    std::thread::sleep(rem);
                }
            }
            Ok(None) => {
                // Idle tick. The poll already blocked for the backend's idle
                // budget, so pace nothing here; just notice a client that left.
                if mailbox.is_closed() {
                    break;
                }
            }
            Err(e) => {
                tracing::warn!("RDP capture (polling): {}", e);
                break;
            }
        }
        metrics.report_if_due();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::{LatestFrameMailbox, PendingFrames, PublishResult, capture_loop_polling};
    use crate::servers::rdp::capture::{Capturer, Frame};
    use crate::servers::rdp::metrics::RdpMetrics;
    use ironrdp::server::{DesktopSize, DisplayUpdate, RdpServerDisplayUpdates};

    fn frame(value: u8) -> Frame {
        Frame::bgra(vec![value, 0, 0, 0], 0, 0, 1, 1, 4)
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn resize_precedes_the_first_frame_at_the_new_geometry() {
        let mailbox = Arc::new(LatestFrameMailbox::new());
        let metrics = RdpMetrics::silent();
        let mut updates = super::DisplayUpdatesImpl::from_warmed_linux_capture(
            mailbox.clone(),
            DesktopSize {
                width: 1,
                height: 1,
            },
            metrics,
        );
        mailbox.publish_full(Frame::bgra(vec![0; 2 * 2 * 4], 0, 0, 2, 2, 8));

        assert!(matches!(
            updates.next_update().await.unwrap(),
            Some(DisplayUpdate::Resize(DesktopSize {
                width: 2,
                height: 2
            }))
        ));
        assert!(matches!(
            updates.next_update().await.unwrap(),
            Some(DisplayUpdate::Bitmap(bitmap)) if bitmap.width.get() == 2 && bitmap.height.get() == 2
        ));
    }

    /// Capturer that reports idle ticks, mimicking ScreenCaptureKit on a static
    /// desktop, and produces one real frame every `frame_every` polls.
    ///
    /// `disconnect_at` closes the mailbox from inside the poll so the test does
    /// not depend on thread scheduling: the real backends block for their idle
    /// budget on each poll, while this stub returns instantly.
    struct IdleCapturer {
        polls: Arc<AtomicUsize>,
        frame_every: usize,
        stop_after: usize,
        disconnect_at: Option<(usize, Arc<LatestFrameMailbox>)>,
        /// Reported through [`Capturer::is_self_paced`].
        self_paced: bool,
        /// Reported through [`Capturer::needs_frame_deduplication`].
        needs_deduplication: bool,
        /// Time spent inside one producing poll before the pixels exist, standing
        /// in for a backend that blocks until the next frame is available.
        wait: Duration,
    }

    impl IdleCapturer {
        fn new(polls: Arc<AtomicUsize>, frame_every: usize, stop_after: usize) -> Self {
            Self {
                polls,
                frame_every,
                stop_after,
                disconnect_at: None,
                self_paced: false,
                needs_deduplication: true,
                wait: Duration::ZERO,
            }
        }
    }

    impl Capturer for IdleCapturer {
        fn desktop_size(&self) -> (u16, u16) {
            (1, 1)
        }

        fn is_self_paced(&self) -> bool {
            self.self_paced
        }

        fn needs_frame_deduplication(&self) -> bool {
            self.needs_deduplication
        }

        fn capture(&mut self) -> anyhow::Result<Frame> {
            anyhow::bail!("polling loop must use poll_frame")
        }

        fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
            let poll = self.polls.fetch_add(1, Ordering::Relaxed) + 1;
            if poll > self.stop_after {
                anyhow::bail!("capture source failed");
            }
            if let Some((at, mailbox)) = &self.disconnect_at
                && poll == *at
            {
                mailbox.close();
            }
            if self.frame_every > 0 && poll.is_multiple_of(self.frame_every) {
                // Wait first, then build the frame: both regimes hand back
                // pixels that are fresh when the call returns, whatever the
                // call itself spent getting there.
                std::thread::sleep(self.wait);
                #[expect(clippy::cast_possible_truncation, reason = "test frame payload")]
                return Ok(Some(frame(poll as u8)));
            }
            Ok(None)
        }
    }

    #[cfg(target_os = "macos")]
    struct ResizeCapturer {
        requested: Arc<std::sync::Mutex<Option<(u16, u16)>>>,
    }

    #[cfg(target_os = "macos")]
    impl Capturer for ResizeCapturer {
        fn desktop_size(&self) -> (u16, u16) {
            (4, 4)
        }

        fn capture(&mut self) -> anyhow::Result<Frame> {
            anyhow::bail!("polling loop must use poll_frame")
        }

        fn supports_output_resize(&self) -> bool {
            true
        }

        fn resize_output(&mut self, width: u16, height: u16) -> anyhow::Result<Frame> {
            *self.requested.lock().unwrap() = Some((width, height));
            Ok(Frame::bgra(
                vec![0; usize::from(width) * usize::from(height) * 4],
                0,
                0,
                width,
                height,
                usize::from(width) * 4,
            ))
        }

        fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
            anyhow::bail!("capture source stopped after resize")
        }
    }

    #[tokio::test]
    async fn newest_full_frame_replaces_an_unconsumed_frame() {
        let mailbox = LatestFrameMailbox::new();
        assert!(matches!(
            mailbox.publish_full(frame(1)),
            PublishResult::Published { replaced: false }
        ));
        assert!(matches!(
            mailbox.publish_full(frame(2)),
            PublishResult::Published { replaced: true }
        ));

        let PendingFrames::Full(frame) = mailbox.take().await.unwrap() else {
            panic!("expected a full frame");
        };
        assert_eq!(frame.data[0], 2);
    }

    #[tokio::test]
    async fn retained_full_frame_replays_immediately_without_copying_pixels() {
        // ScreenCaptureKit emits idle markers while the desktop is static. A
        // newly authenticated client must still receive the last complete
        // desktop immediately, without waiting for a future screen change.
        let mailbox = LatestFrameMailbox::new();
        let original = frame(7);
        let pixels = original.data.as_ptr();
        assert!(matches!(
            mailbox.publish_full(original),
            PublishResult::Published { replaced: false }
        ));

        let PendingFrames::Full(first) = mailbox.take().await.unwrap() else {
            panic!("expected the first full frame");
        };
        assert_eq!(first.data.as_ptr(), pixels);

        mailbox.replay_latest_full();
        let replay = tokio::time::timeout(Duration::from_millis(50), mailbox.take())
            .await
            .expect("retained frame must not wait for a new capture")
            .expect("mailbox must stay open across client subscriptions");
        let PendingFrames::Full(replay) = replay else {
            panic!("expected the retained full frame");
        };
        assert_eq!(replay.data[0], 7);
        assert_eq!(
            replay.data.as_ptr(),
            pixels,
            "replay should only clone the Bytes handle, not the pixel buffer"
        );
    }

    #[tokio::test]
    async fn damage_backlog_requests_a_safe_full_refresh() {
        let mailbox = LatestFrameMailbox::new();
        assert!(matches!(
            mailbox.publish_damage(vec![frame(1)]),
            PublishResult::Published { replaced: false }
        ));
        assert!(matches!(
            mailbox.take().await,
            Some(PendingFrames::Damage(_))
        ));

        assert!(matches!(
            mailbox.publish_damage(vec![frame(2)]),
            PublishResult::NeedsFullRefresh
        ));
        assert!(matches!(
            mailbox.publish_full(frame(3)),
            PublishResult::Published { replaced: true }
        ));
        assert!(mailbox.full_refresh_waiting());

        mailbox.finish_damage();
        let PendingFrames::Full(frame) = mailbox.take().await.unwrap() else {
            panic!("expected the full refresh");
        };
        assert_eq!(frame.data[0], 3);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_resize_acknowledges_only_after_publishing_the_new_surface() {
        let mailbox = LatestFrameMailbox::new();
        let metrics = RdpMetrics::silent();
        let requested = Arc::new(std::sync::Mutex::new(None));
        let mut capturer = ResizeCapturer {
            requested: requested.clone(),
        };
        let (resize_tx, resize_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        let requested_size = ironrdp::server::DesktopSize {
            width: 2,
            height: 3,
        };
        resize_tx
            .send(super::CaptureResizeRequest {
                size: requested_size,
                result: result_tx,
            })
            .unwrap();

        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            Some(&resize_rx),
            #[cfg(target_os = "linux")]
            None,
        );

        assert_eq!(*requested.lock().unwrap(), Some((2, 3)));
        assert_eq!(result_rx.blocking_recv().unwrap().unwrap(), requested_size);
        let state = mailbox.state.lock().unwrap();
        let Some(PendingFrames::Full(frame)) = state.pending.as_ref() else {
            panic!("resize response must follow publication of a full frame");
        };
        assert_eq!((frame.width, frame.height), (2, 3));
        assert_eq!(frame.sequence, 1);
    }

    #[test]
    fn idle_ticks_do_not_end_the_capture_thread() {
        // Regression: a static macOS desktop yields only idle ticks. Treating
        // one as fatal ended the capture thread, leaving `next_update` awaiting
        // a mailbox with no producer — the client froze on its last frame while
        // the connection stayed up.
        let mailbox = Arc::new(LatestFrameMailbox::new());
        let metrics = RdpMetrics::silent();
        let polls = Arc::new(AtomicUsize::new(0));
        let mut capturer = IdleCapturer {
            disconnect_at: Some((25, mailbox.clone())),
            ..IdleCapturer::new(polls.clone(), 0, 200)
        };

        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
        );

        // 24 idle ticks were survived; the loop ended only once the client left.
        assert_eq!(
            polls.load(Ordering::Relaxed),
            25,
            "loop must ride out idle ticks and stop exactly on disconnect"
        );
    }

    #[test]
    fn capture_failure_still_ends_the_loop() {
        let mailbox = LatestFrameMailbox::new();
        let metrics = RdpMetrics::silent();
        let polls = Arc::new(AtomicUsize::new(0));
        let mut capturer = IdleCapturer {
            self_paced: true,
            ..IdleCapturer::new(polls.clone(), 2, 4)
        };

        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
        );

        assert_eq!(polls.load(Ordering::Relaxed), 5, "loop must stop on error");
    }

    /// Long enough to separate "waited for the next frame" from "produced the
    /// pixels" in a wall-clock assertion, short enough to keep tests quick.
    const WAIT: Duration = Duration::from_millis(40);

    #[test]
    fn a_self_paced_backend_is_not_paced_again() {
        // ScreenCaptureKit already caps itself at its configured frame rate.
        // Sleeping another frame interval per iteration served each frame one
        // interval after it was already sitting in the backend's mailbox.
        let mailbox = LatestFrameMailbox::new();
        let metrics = RdpMetrics::silent();
        let polls = Arc::new(AtomicUsize::new(0));
        let mut capturer = IdleCapturer {
            self_paced: true,
            ..IdleCapturer::new(polls.clone(), 1, 6)
        };

        let started = Instant::now();
        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
        );
        let elapsed = started.elapsed();

        assert_eq!(polls.load(Ordering::Relaxed), 7);
        // Six unpaced polls take microseconds; six paced ones take ~200ms.
        assert!(
            elapsed < Duration::from_millis(100),
            "self-paced backend was paced a second time: {elapsed:?}"
        );
    }

    #[test]
    fn a_change_stream_does_not_hash_full_frames_again() {
        let mailbox = LatestFrameMailbox::new();
        let metrics = RdpMetrics::silent();
        let mut capturer = IdleCapturer {
            self_paced: true,
            needs_deduplication: false,
            ..IdleCapturer::new(Arc::new(AtomicUsize::new(0)), 1, 2)
        };

        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
        );

        assert_eq!(
            metrics.hash_sample_count(),
            0,
            "a native change stream must not pay for a second full-frame scan"
        );
    }

    #[test]
    fn capture_metric_excludes_a_self_paced_backends_wait() {
        // `capture=` has to report what getting pixels costs us. Charging the
        // wait for the next frame to it just restates the frame interval, so a
        // genuinely slow capture becomes indistinguishable from an idle desktop.
        let mailbox = LatestFrameMailbox::new();
        let metrics = RdpMetrics::silent();
        let mut capturer = IdleCapturer {
            self_paced: true,
            wait: WAIT,
            ..IdleCapturer::new(Arc::new(AtomicUsize::new(0)), 1, 1)
        };

        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
        );

        let capture_us = metrics.capture_p50_us().expect("one frame was captured");
        assert!(
            capture_us < u64::try_from(WAIT.as_micros()).unwrap() / 2,
            "the self-paced wait was charged to capture: {capture_us}us"
        );
    }

    #[test]
    fn capture_metric_covers_a_grab_on_demand_backends_work() {
        // The flip side: a backend that produces pixels inline must still have
        // that work measured, so the fix above cannot silently zero the metric
        // on X11-without-DAMAGE or the Wayland/xcap fallback.
        let mailbox = LatestFrameMailbox::new();
        let metrics = RdpMetrics::silent();
        let mut capturer = IdleCapturer {
            wait: WAIT,
            ..IdleCapturer::new(Arc::new(AtomicUsize::new(0)), 1, 1)
        };

        capture_loop_polling(
            &mut capturer,
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
        );

        let capture_us = metrics.capture_p50_us().expect("one frame was captured");
        assert!(
            capture_us >= u64::try_from(WAIT.as_micros()).unwrap() / 2,
            "grab-on-demand capture work was not measured: {capture_us}us"
        );
    }
}
