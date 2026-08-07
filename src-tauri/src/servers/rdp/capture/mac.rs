//! macOS screen capture for the RDP server.
//!
//! The primary backend is ScreenCaptureKit (`sck.rs`), which requests native
//! BGRA frames through a deliberately shallow queue. `MacCapturer` remains as
//! a compatibility fallback for systems where ScreenCaptureKit cannot start.
//!
//! Requires **Screen Recording** permission (System Settings → Privacy & Security).
//! Permission is checked before constructing the stream so the listener fails
//! closed with an actionable error rather than advertising a black desktop.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};

use super::{CaptureDisplay, CaptureProbe, Capturer, Frame};
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::input::control_permission_granted;

mod sck;

const INITIAL_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const FRAME_TIMEOUT: Duration = Duration::from_secs(2);
/// Idle budget for one poll of the fallback stream. See [`Capturer::poll_frame`]:
/// a quiet desktop must not be reported as a capture failure.
const IDLE_POLL: Duration = Duration::from_millis(250);

pub(crate) fn permission_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub(crate) fn request_permission() -> bool {
    CGRequestScreenCaptureAccess()
}

pub(crate) fn probe() -> anyhow::Result<CaptureProbe> {
    let granted = permission_granted();
    let displays = if granted {
        enumerate_displays()?
    } else {
        Vec::new()
    };
    Ok(CaptureProbe {
        permission: if granted { "granted" } else { "denied" }.to_string(),
        control_permission: if control_permission_granted() {
            "granted"
        } else {
            "denied"
        }
        .to_string(),
        displays,
        summary: if granted {
            "Screen Recording permission granted; native display capture is available".to_string()
        } else {
            "Screen Recording permission is required before the RDP server can start".to_string()
        },
    })
}

/// Quartz global display bounds are expressed in logical points with the main
/// display at (0, 0). ScreenCaptureKit frames use physical pixels, so input
/// needs both coordinate spaces to place the pointer on Retina and secondary
/// displays correctly.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DisplayBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn selected_display_bounds(display_id: Option<&str>) -> anyhow::Result<DisplayBounds> {
    let monitor = select_monitor(display_id)?;
    Ok(DisplayBounds {
        x: monitor
            .x()
            .map_err(|e| anyhow::anyhow!("display x coordinate: {e}"))?,
        y: monitor
            .y()
            .map_err(|e| anyhow::anyhow!("display y coordinate: {e}"))?,
        width: monitor
            .width()
            .map_err(|e| anyhow::anyhow!("display logical width: {e}"))?,
        height: monitor
            .height()
            .map_err(|e| anyhow::anyhow!("display logical height: {e}"))?,
    })
}

fn enumerate_displays() -> anyhow::Result<Vec<CaptureDisplay>> {
    let monitors = xcap::Monitor::all().map_err(|e| anyhow::anyhow!("enumerate displays: {e}"))?;
    monitors
        .into_iter()
        .map(|monitor| {
            Ok(CaptureDisplay {
                id: monitor
                    .id()
                    .map_err(|e| anyhow::anyhow!("display id: {e}"))?
                    .to_string(),
                name: monitor
                    .friendly_name()
                    .map_err(|e| anyhow::anyhow!("display name: {e}"))?,
                width: monitor
                    .width()
                    .map_err(|e| anyhow::anyhow!("display width: {e}"))?,
                height: monitor
                    .height()
                    .map_err(|e| anyhow::anyhow!("display height: {e}"))?,
                primary: monitor
                    .is_primary()
                    .map_err(|e| anyhow::anyhow!("display primary state: {e}"))?,
            })
        })
        .collect()
}

fn select_monitor(display_id: Option<&str>) -> anyhow::Result<xcap::Monitor> {
    let requested = display_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| anyhow::anyhow!("invalid macOS display id '{value}'"))
        })
        .transpose()?;
    let monitors = xcap::Monitor::all().map_err(|e| anyhow::anyhow!("enumerate displays: {e}"))?;

    if let Some(id) = requested {
        return monitors
            .into_iter()
            .find(|monitor| monitor.id().ok() == Some(id))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "selected display {id} is no longer available; choose an active display in RDP Server settings"
                )
            });
    }

    monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| anyhow::anyhow!("no active macOS displays found"))
}

struct MacCapturer {
    recorder: xcap::VideoRecorder,
    frames: Receiver<xcap::Frame>,
    pending: Option<xcap::Frame>,
    width: u16,
    height: u16,
}

impl MacCapturer {
    fn new(log: &LogEmitter, display_id: Option<&str>) -> anyhow::Result<Self> {
        if !permission_granted() {
            anyhow::bail!(
                "Screen Recording permission is not granted. Open RDP Server settings, grant permission, then restart Taomni if macOS requests it."
            );
        }

        let monitor = select_monitor(display_id)?;
        let id = monitor
            .id()
            .map_err(|e| anyhow::anyhow!("display id: {e}"))?;
        let name = monitor
            .friendly_name()
            .map_err(|e| anyhow::anyhow!("display name: {e}"))?;
        let (recorder, frames) = monitor
            .video_recorder()
            .map_err(|e| anyhow::anyhow!("create native display stream: {e}"))?;
        recorder
            .start()
            .map_err(|e| anyhow::anyhow!("start native display stream: {e}"))?;
        let first = frames
            .recv_timeout(INITIAL_FRAME_TIMEOUT)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => anyhow::anyhow!(
                    "native display stream produced no frame within {} seconds",
                    INITIAL_FRAME_TIMEOUT.as_secs()
                ),
                RecvTimeoutError::Disconnected => {
                    anyhow::anyhow!("native display stream stopped before its first frame")
                }
            })?;
        let (width, height) = frame_dimensions(&first)?;
        log.line(format!(
            "macOS capture stream ready: {name} (display {id}, {width}x{height})"
        ));
        Ok(Self {
            recorder,
            frames,
            pending: Some(first),
            width,
            height,
        })
    }
}

impl Drop for MacCapturer {
    fn drop(&mut self) {
        let _ = self.recorder.stop();
    }
}

impl Capturer for MacCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    /// The native stream delivers on its own schedule; pacing again here would
    /// only serve frames that already arrived one interval late.
    fn is_self_paced(&self) -> bool {
        true
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        let frame = match self.pending.take() {
            Some(frame) => frame,
            None => self
                .frames
                .recv_timeout(FRAME_TIMEOUT)
                .map_err(|error| match error {
                    RecvTimeoutError::Timeout => anyhow::anyhow!(
                        "native display stream stalled for {} seconds",
                        FRAME_TIMEOUT.as_secs()
                    ),
                    RecvTimeoutError::Disconnected => {
                        anyhow::anyhow!("native display stream disconnected")
                    }
                })?,
        };
        self.accept(frame)
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        let frame = match self.pending.take() {
            Some(frame) => frame,
            None => match self.frames.recv_timeout(IDLE_POLL) {
                Ok(frame) => frame,
                // A quiet interval is not a stalled stream: this backend also
                // only produces frames when the desktop actually changes.
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("native display stream disconnected")
                }
            },
        };
        self.accept(frame).map(Some)
    }
}

impl MacCapturer {
    /// Validate a delivered frame, adopt its dimensions, and convert to BGRA.
    fn accept(&mut self, frame: xcap::Frame) -> anyhow::Result<Frame> {
        let (width, height) = frame_dimensions(&frame)?;
        self.width = width;
        self.height = height;
        rgba_frame(frame)
    }
}

fn frame_dimensions(frame: &xcap::Frame) -> anyhow::Result<(u16, u16)> {
    let width = u16::try_from(frame.width).map_err(|_| {
        anyhow::anyhow!("captured display width {} exceeds RDP limits", frame.width)
    })?;
    let height = u16::try_from(frame.height).map_err(|_| {
        anyhow::anyhow!(
            "captured display height {} exceeds RDP limits",
            frame.height
        )
    })?;
    if width == 0 || height == 0 {
        anyhow::bail!("native display stream returned an empty frame");
    }
    let expected = usize::from(width)
        .checked_mul(usize::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow::anyhow!("captured display dimensions overflow"))?;
    if frame.raw.len() != expected {
        anyhow::bail!(
            "native display frame has {} bytes; expected {expected}",
            frame.raw.len()
        );
    }
    Ok((width, height))
}

fn rgba_frame(frame: xcap::Frame) -> anyhow::Result<Frame> {
    let (width, height) = frame_dimensions(&frame)?;
    let mut bgra = frame.raw;
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(Frame::bgra(
        bgra,
        0,
        0,
        width,
        height,
        usize::from(width) * 4,
    ))
}

pub(crate) fn try_new(
    log: &LogEmitter,
    display_id: Option<&str>,
) -> anyhow::Result<Box<dyn Capturer>> {
    log.line("macOS RDP capture: starting ScreenCaptureKit stream");
    match sck::SckCapturer::new(log, display_id) {
        Ok(capturer) => Ok(Box::new(capturer)),
        Err(sck_error) => {
            // Keep a functional fallback for older macOS deployments and for
            // transient framework failures. The log makes it clear when the
            // lower-latency path was not selected, so production diagnostics
            // never mistake the legacy backend for ScreenCaptureKit.
            log.line(format!(
                "macOS RDP capture: ScreenCaptureKit unavailable ({sck_error}); falling back to legacy AVCapture stream"
            ));
            Ok(Box::new(MacCapturer::new(log, display_id)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{frame_dimensions, rgba_frame};

    #[test]
    fn rejects_malformed_native_frames() {
        let frame = xcap::Frame::new(2, 2, vec![0; 15]);
        assert!(frame_dimensions(&frame).is_err());
    }

    #[test]
    fn converts_native_rgba_to_rdp_bgra() {
        let frame = rgba_frame(xcap::Frame::new(1, 1, vec![10, 20, 30, 255])).unwrap();
        assert_eq!(frame.data, vec![30, 20, 10, 255]);
        assert_eq!((frame.width, frame.height, frame.stride), (1, 1, 4));
    }
}
