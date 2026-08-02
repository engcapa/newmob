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
}

impl RdpDisplay {
    pub(crate) fn new(
        log: LogEmitter,
        display_id: Option<String>,
        metrics: RdpMetrics,
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
        )))
    }
}

/// Per-client update producer that drains the native capture thread.
pub(crate) struct DisplayUpdatesImpl {
    mailbox: Arc<LatestFrameMailbox>,
    active_damage: VecDeque<Frame>,
    metrics: RdpMetrics,
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
                return Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap));
            }

            match self.mailbox.take().await {
                Some(PendingFrames::Full(frame)) => {
                    self.metrics.record_frame_handoff(frame.captured_at);
                    self.metrics.report_if_due();
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
        let started = std::time::Instant::now();
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
                    metrics.record_capture(started.elapsed(), frame.data.len());
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
fn capture_loop_polling(
    capturer: &mut dyn Capturer,
    mailbox: &LatestFrameMailbox,
    metrics: &RdpMetrics,
) {
    let frame_interval = std::time::Duration::from_millis(33);
    let mut last_hash: Option<u64> = None;
    let mut first = true;
    let mut sequence = 0;
    loop {
        let start = std::time::Instant::now();
        match capturer.capture() {
            Ok(mut frame) => {
                metrics.record_capture(start.elapsed(), frame.data.len());
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
            }
            Err(e) => {
                tracing::warn!("RDP capture (polling): {}", e);
                break;
            }
        }
        if let Some(rem) = frame_interval.checked_sub(start.elapsed()) {
            std::thread::sleep(rem);
        }
        metrics.report_if_due();
    }
}

#[cfg(test)]
mod tests {
    use super::{LatestFrameMailbox, PendingFrames, PublishResult};
    use crate::servers::rdp::capture::Frame;

    fn frame(value: u8) -> Frame {
        Frame::bgra(vec![value, 0, 0, 0], 0, 0, 1, 1, 4)
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
}
