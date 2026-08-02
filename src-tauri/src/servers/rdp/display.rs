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

use super::capture::{Capturer, Frame, create_capturer};
use crate::servers::engine::LogEmitter;

/// Display handler handed to the IronRDP builder. Probes the capture backend to
/// learn the real desktop size, falling back to the configured default.
pub(crate) struct RdpDisplay {
    log: LogEmitter,
    /// Desktop size reported to the client. Set from the capture backend when
    /// available, else the fallback size passed in at construction.
    size: DesktopSize,
}

impl RdpDisplay {
    pub(crate) fn new(log: LogEmitter) -> anyhow::Result<Self> {
        // Probe once up front (on this caller's thread) only to learn the size;
        // the real capturer is created again inside the capture thread, which is
        // where it must live. Probing here keeps `size()` honest for the client.
        let size = match create_capturer(&log) {
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

        Ok(Self { log, size })
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
        )))
    }
}

/// Per-client update producer that drains the native capture thread.
pub(crate) struct DisplayUpdatesImpl {
    rx: mpsc::Receiver<Frame>,
}

impl DisplayUpdatesImpl {
    /// Spawn the capture thread and return an updater draining its frames.
    fn with_capture(log: LogEmitter, _size: DesktopSize) -> Self {
        // Bounded channel: capacity 1 keeps only the freshest frame in flight,
        // applying natural backpressure (slow client → capture thread blocks on
        // send rather than building an unbounded backlog of stale frames).
        let (tx, rx) = mpsc::channel::<Frame>(1);

        std::thread::Builder::new()
            .name("rdp-capture".to_string())
            .spawn(move || capture_loop(log, tx))
            .ok();

        Self { rx }
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
            Some(frame) => Ok(Self::frame_to_bitmap(frame).map(DisplayUpdate::Bitmap)),
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
fn capture_loop(log: LogEmitter, tx: mpsc::Sender<Frame>) {
    let mut capturer = match create_capturer(&log) {
        Ok(c) => c,
        Err(e) => {
            log.line(format!("capture thread: {}", e));
            return;
        }
    };

    if capturer.is_event_driven() {
        capture_loop_event_driven(capturer.as_mut(), &tx);
    } else {
        capture_loop_polling(capturer.as_mut(), &tx);
    }
    log.line("capture thread stopped");
}

/// Damage-driven loop: forward whatever regions the backend reports. The
/// backend internally blocks on change notifications and caps the frame rate,
/// so this loop adds no interval of its own. An empty result is an idle tick;
/// we use it to notice a disconnected client (closed channel) promptly.
fn capture_loop_event_driven(capturer: &mut dyn Capturer, tx: &mpsc::Sender<Frame>) {
    let mut first = true;
    loop {
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
                for frame in frames {
                    if tx.blocking_send(frame).is_err() {
                        return;
                    }
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
fn capture_loop_polling(capturer: &mut dyn Capturer, tx: &mpsc::Sender<Frame>) {
    let frame_interval = std::time::Duration::from_millis(33);
    let mut last_hash: Option<u64> = None;
    let mut first = true;
    loop {
        let start = std::time::Instant::now();
        match capturer.capture() {
            Ok(frame) => {
                let hash = super::diff::frame_hash(&frame.data);
                // Always send the first frame so the client gets an initial
                // image; thereafter suppress byte-identical frames.
                if first || last_hash != Some(hash) {
                    first = false;
                    last_hash = Some(hash);
                    if tx.blocking_send(frame).is_err() {
                        break;
                    }
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
    }
}
