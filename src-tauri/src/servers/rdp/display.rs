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
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ironrdp::server::{
    BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServerDisplay,
    RdpServerDisplayUpdates,
};
use tokio::sync::Notify;

use super::capture::{Capturer, Frame, create_capturer_for_display};
#[cfg(target_os = "macos")]
use super::gfx::{GfxReadiness, GfxSubmit, GfxTransport, H264Encoder};
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
    display_id: Option<String>,
    #[cfg(target_os = "macos")]
    gfx: GfxTransport,
}

impl RdpDisplay {
    pub(crate) fn new(
        log: LogEmitter,
        display_id: Option<String>,
        metrics: RdpMetrics,
        #[cfg(target_os = "macos")] gfx: GfxTransport,
    ) -> anyhow::Result<Self> {
        // Probe once up front (on this caller's thread) only to learn the size;
        // the real capturer is created again inside the capture thread, which is
        // where it must live. Probing here keeps `size()` honest for the client.
        let size = match create_capturer_for_display(&log, display_id.as_deref()) {
            Ok(cap) => {
                let (w, h) = cap.desktop_size();
                match (NonZeroU16::new(w), NonZeroU16::new(h)) {
                    (Some(_), Some(_)) => DesktopSize {
                        width: w,
                        height: h,
                    },
                    _ => anyhow::bail!("screen capture reported an invalid desktop size"),
                }
            }
            Err(e) => anyhow::bail!("screen capture unavailable: {e}"),
        };

        Ok(Self {
            log,
            metrics,
            size,
            display_id,
            #[cfg(target_os = "macos")]
            gfx,
        })
    }
}

#[async_trait]
impl RdpServerDisplay for RdpDisplay {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        self.log.line("client requested display stream");
        Ok(Box::new(DisplayUpdatesImpl::with_capture(
            self.log.clone(),
            self.size,
            self.display_id.clone(),
            self.metrics.clone(),
            #[cfg(target_os = "macos")]
            self.gfx.clone(),
        )))
    }
}

/// Per-client update producer that drains the native capture thread.
pub(crate) struct DisplayUpdatesImpl {
    mailbox: Arc<LatestFrameMailbox>,
    active_damage: VecDeque<Frame>,
    metrics: RdpMetrics,
    #[cfg(target_os = "macos")]
    gfx: GfxTransport,
    #[cfg(target_os = "macos")]
    h264: Option<H264Encoder>,
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
        }
        self.ready.notify_waiters();
    }
}

impl DisplayUpdatesImpl {
    /// Spawn the capture thread and return an updater draining its frames.
    fn with_capture(
        log: LogEmitter,
        _size: DesktopSize,
        display_id: Option<String>,
        metrics: RdpMetrics,
        #[cfg(target_os = "macos")] gfx: GfxTransport,
    ) -> Self {
        let mailbox = Arc::new(LatestFrameMailbox::new());

        std::thread::Builder::new()
            .name("rdp-capture".to_string())
            .spawn({
                let metrics = metrics.clone();
                let mailbox = mailbox.clone();
                move || capture_loop(log, mailbox, display_id, metrics)
            })
            .ok();

        Self {
            mailbox,
            active_damage: VecDeque::new(),
            metrics,
            #[cfg(target_os = "macos")]
            gfx,
            #[cfg(target_os = "macos")]
            h264: None,
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
            data: frame.data.into(),
            stride,
        })
    }

    /// Prefer the negotiated EGFX/AVC420 path on macOS. The decision is made
    /// after capture and before turning pixels into a regular RDP bitmap so a
    /// slow client can drop a current frame instead of queuing stale work.
    #[cfg(target_os = "macos")]
    fn try_send_gfx(&mut self, frame: &mut Frame) -> Option<GfxSubmit> {
        match self.gfx.readiness() {
            GfxReadiness::Backpressured => return Some(GfxSubmit::Backpressured),
            GfxReadiness::Unavailable => return None,
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
                    return None;
                }
            }
        }
        let encoder = self.h264.as_mut()?;
        match encoder.encode(frame) {
            Ok(h264) => Some(self.gfx.send_avc420(frame, &h264)),
            Err(error) => {
                // Encoding failure is isolated to this client/update. The
                // next update may recreate VideoToolbox, while this frame is
                // still delivered through the reliable bitmap fallback.
                tracing::warn!("RDP EGFX hardware frame failed; using bitmap update: {error}");
                self.h264 = None;
                None
            }
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

            if let Some(frame) = self.active_damage.pop_front() {
                if self.active_damage.is_empty() {
                    self.mailbox.finish_damage();
                }
                self.metrics.record_frame_handoff(frame.captured_at);
                self.metrics.report_if_due();
                #[cfg(target_os = "macos")]
                {
                    let mut frame = frame;
                    match self.try_send_gfx(&mut frame) {
                        Some(GfxSubmit::Sent) | Some(GfxSubmit::Backpressured) => continue,
                        Some(GfxSubmit::Unavailable) | None => {
                            return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
            }

            match self.mailbox.take().await {
                Some(PendingFrames::Full(frame)) => {
                    self.metrics.record_frame_handoff(frame.captured_at);
                    self.metrics.report_if_due();
                    #[cfg(target_os = "macos")]
                    {
                        let mut frame = frame;
                        match self.try_send_gfx(&mut frame) {
                            Some(GfxSubmit::Sent) | Some(GfxSubmit::Backpressured) => continue,
                            Some(GfxSubmit::Unavailable) | None => {
                                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
                            }
                        }
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

impl Drop for DisplayUpdatesImpl {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}

/// Capture-thread body: create the backend on this thread, then loop producing
/// updates and sending them to the display task. Exits when the receiver is
/// dropped (client disconnected) or capture errors out.
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
fn capture_loop(
    log: LogEmitter,
    mailbox: Arc<LatestFrameMailbox>,
    display_id: Option<String>,
    metrics: RdpMetrics,
) {
    let mut capturer = match create_capturer_for_display(&log, display_id.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            log.line(format!("capture thread: {}", e));
            return;
        }
    };

    if capturer.is_event_driven() {
        capture_loop_event_driven(capturer.as_mut(), &mailbox, &metrics);
    } else {
        capture_loop_polling(capturer.as_mut(), &mailbox, &metrics);
    }
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
                    metrics.record_capture(frame.captured_at.elapsed(), frame.data.len());
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
                        metrics.record_capture(full_started.elapsed(), full.data.len());
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
) {
    // A backend that caps its own frame rate must not be paced again: the extra
    // sleep would hold back a frame that is already sitting in its mailbox.
    let self_paced = capturer.is_self_paced();
    let frame_interval = (!self_paced).then(|| std::time::Duration::from_millis(33));
    let mut last_hash: Option<u64> = None;
    let mut first = true;
    let mut sequence = 0;
    loop {
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
                metrics.record_capture(capture_cost, frame.data.len());
                let hash_started = std::time::Instant::now();
                let hash = super::diff::frame_hash(&frame.data);
                metrics.record_hash(hash_started.elapsed());
                // Always send the first frame so the client gets an initial
                // image; thereafter suppress byte-identical frames.
                if first || last_hash != Some(hash) {
                    first = false;
                    last_hash = Some(hash);
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

    fn frame(value: u8) -> Frame {
        Frame::bgra(vec![value, 0, 0, 0], 0, 0, 1, 1, 4)
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

        capture_loop_polling(&mut capturer, &mailbox, &metrics);

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

        capture_loop_polling(&mut capturer, &mailbox, &metrics);

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
        capture_loop_polling(&mut capturer, &mailbox, &metrics);
        let elapsed = started.elapsed();

        assert_eq!(polls.load(Ordering::Relaxed), 7);
        // Six unpaced polls take microseconds; six paced ones take ~200ms.
        assert!(
            elapsed < Duration::from_millis(100),
            "self-paced backend was paced a second time: {elapsed:?}"
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

        capture_loop_polling(&mut capturer, &mailbox, &metrics);

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

        capture_loop_polling(&mut capturer, &mailbox, &metrics);

        let capture_us = metrics.capture_p50_us().expect("one frame was captured");
        assert!(
            capture_us >= u64::try_from(WAIT.as_micros()).unwrap() / 2,
            "grab-on-demand capture work was not measured: {capture_us}us"
        );
    }
}
