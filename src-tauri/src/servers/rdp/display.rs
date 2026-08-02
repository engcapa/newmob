//! RDP server display handler: produces [`DisplayUpdate`] frames for connected
//! clients.
//!
//! Real screen capture runs on a dedicated OS thread (native capture backends
//! hold non-`Send`, thread-affine handles — see [`super::capture`]). That thread
//! pushes BGRA frames over an `mpsc` channel; [`DisplayUpdatesImpl::next_update`]
//! awaits the channel, keeping the protocol runtime free and the await point
//! cancel-safe. A production RDP listener does not start when capture is
//! unavailable; serving a synthetic frame would falsely report healthy remote
//! desktop service.
//!
//! Phase 3 will add dirty-rect diffing on top of the full frames produced here.

use core::num::{NonZeroU16, NonZeroUsize};

use async_trait::async_trait;
use ironrdp::server::{
    BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServerDisplay,
    RdpServerDisplayUpdates,
};
use tokio::sync::mpsc;

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
    rx: mpsc::Receiver<Frame>,
    metrics: RdpMetrics,
}

impl DisplayUpdatesImpl {
    /// Spawn the capture thread and return an updater draining its frames.
    fn with_capture(
        log: LogEmitter,
        _size: DesktopSize,
        display_id: Option<String>,
        metrics: RdpMetrics,
    ) -> Self {
        // Bounded channel: capacity 1 keeps only the freshest frame in flight,
        // applying natural backpressure (slow client → capture thread blocks on
        // send rather than building an unbounded backlog of stale frames).
        let (tx, rx) = mpsc::channel::<Frame>(1);

        std::thread::Builder::new()
            .name("rdp-capture".to_string())
            .spawn({
                let metrics = metrics.clone();
                move || capture_loop(log, tx, display_id, metrics)
            })
            .ok();

        Self { rx, metrics }
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
        // Await the next captured frame. `recv` is cancel-safe; if the capture
        // thread ends (channel closed) we end the stream.
        match self.rx.recv().await {
            Some(frame) => {
                self.metrics.record_frame_handoff(frame.captured_at);
                self.metrics.report_if_due();
                Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap))
            }
            None => Ok(None),
        }
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
    tx: mpsc::Sender<Frame>,
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
        capture_loop_event_driven(capturer.as_mut(), &tx, &metrics);
    } else {
        capture_loop_polling(capturer.as_mut(), &tx, &metrics);
    }
    log.line("capture thread stopped");
}

/// Damage-driven loop: forward whatever regions the backend reports. The
/// backend internally blocks on change notifications and caps the frame rate,
/// so this loop adds no interval of its own. An empty result is an idle tick;
/// we use it to notice a disconnected client (closed channel) promptly.
fn capture_loop_event_driven(
    capturer: &mut dyn Capturer,
    tx: &mpsc::Sender<Frame>,
    metrics: &RdpMetrics,
) {
    let mut first = true;
    let mut sequence = 0;
    loop {
        let started = std::time::Instant::now();
        match capturer.next_updates(first) {
            Ok(frames) => {
                first = false;
                if frames.is_empty() {
                    // Idle tick: nothing changed within the wait budget. Bail
                    // out if the client went away, otherwise keep waiting.
                    if tx.is_closed() {
                        break;
                    }
                    continue;
                }
                for mut frame in frames {
                    metrics.record_capture(started.elapsed(), frame.data.len());
                    sequence += 1;
                    frame.sequence = sequence;
                    if tx.blocking_send(frame).is_err() {
                        return;
                    }
                    metrics.report_if_due();
                }
            }
            Err(e) => {
                let _ = tx; // nothing to send; surface and stop
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
    tx: &mpsc::Sender<Frame>,
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
                    if tx.blocking_send(frame).is_err() {
                        break;
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
