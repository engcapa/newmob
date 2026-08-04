//! ScreenCaptureKit capture backend for macOS 12.3 and later.
//!
//! ScreenCaptureKit delivers the requested BGRA IOSurface on a serial GCD
//! queue. The delegate copies only the current surface into a one-slot mailbox;
//! it never waits for RDP encoding or network I/O. Keeping the native queue at
//! three frames and the Rust handoff at one prevents a slow client from making
//! the cursor and desktop progressively older.

use std::slice;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_graphics::{CGDisplayPixelsHigh, CGDisplayPixelsWide, CGMainDisplayID};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelFormatType_32BGRA,
    kCVReturnSuccess,
};
use objc2_foundation::{NSArray, NSError, NSObject};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType,
};

use super::{Capturer, FRAME_TIMEOUT, Frame, INITIAL_FRAME_TIMEOUT, permission_granted};
use crate::servers::engine::LogEmitter;

/// ScreenCaptureKit's native queue must remain shallow: values above this add
/// whole display frames of latency before the delegate is even called.
const NATIVE_QUEUE_DEPTH: isize = 3;
/// 30 Hz is the best latency/CPU tradeoff for the current bitmap RDP encoder.
/// The latest-frame mailbox still lets interactive updates arrive immediately.
const FRAME_RATE: i32 = 30;
const CONTENT_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_millis(750);
/// How long one poll waits for new desktop content before reporting an idle
/// tick. ScreenCaptureKit delivers no usable frame at all while the desktop is
/// static, so this is the interval at which the capture loop gets a chance to
/// notice a disconnected client. It is deliberately far below
/// [`FRAME_TIMEOUT`], which stays reserved for the initial frame.
const IDLE_POLL: Duration = Duration::from_millis(250);

#[derive(Debug)]
struct FrameSlot {
    state: Mutex<FrameSlotState>,
    wake: Condvar,
}

#[derive(Debug)]
struct FrameSlotState {
    latest: Option<Frame>,
    stopped: Option<String>,
}

impl FrameSlot {
    fn new() -> Self {
        Self {
            state: Mutex::new(FrameSlotState {
                latest: None,
                stopped: None,
            }),
            wake: Condvar::new(),
        }
    }

    fn publish(&self, frame: Frame) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.stopped.is_none() {
            // Replacing the previous frame is intentional: only the newest
            // visual state is useful once RDP falls behind.
            state.latest = Some(frame);
            self.wake.notify_one();
        }
    }

    fn stop(&self, reason: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.stopped.get_or_insert_with(|| reason.into());
            state.latest = None;
        }
        self.wake.notify_all();
    }

    /// Wait up to `timeout` for the next frame. `Ok(None)` means the timeout
    /// elapsed with the desktop unchanged, which is not an error: the stream is
    /// healthy and simply has nothing new to show. Only a stopped stream or a
    /// poisoned lock is reported as `Err`.
    fn take_or_idle(&self, timeout: Duration) -> anyhow::Result<Option<Frame>> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ScreenCaptureKit frame mailbox lock poisoned"))?;
        loop {
            if let Some(frame) = state.latest.take() {
                return Ok(Some(frame));
            }
            if let Some(reason) = &state.stopped {
                anyhow::bail!("ScreenCaptureKit stream stopped: {reason}");
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next, wait) = self
                .wake
                .wait_timeout(state, remaining)
                .map_err(|_| anyhow::anyhow!("ScreenCaptureKit frame mailbox lock poisoned"))?;
            state = next;
            if wait.timed_out() && state.latest.is_none() && state.stopped.is_none() {
                return Ok(None);
            }
        }
    }

    /// Wait for a frame and treat the timeout as a failure. Used where a frame
    /// is genuinely required — starting the stream and probing the desktop size.
    fn take(&self, timeout: Duration) -> anyhow::Result<Frame> {
        self.take_or_idle(timeout)?.ok_or_else(|| {
            anyhow::anyhow!(
                "ScreenCaptureKit stream produced no frame within {} seconds",
                timeout.as_secs()
            )
        })
    }
}

#[derive(Debug)]
struct StreamOutputIvars {
    slot: Arc<FrameSlot>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "TaomniRdpScreenCaptureOutput"]
    #[ivars = StreamOutputIvars]
    #[derive(Debug)]
    struct StreamOutput;

    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_didOutputSampleBuffer_ofType(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            if output_type != SCStreamOutputType::Screen {
                return;
            }
            match copy_bgra_frame(sample_buffer) {
                // `None` is an idle sample: the desktop did not change, so
                // there is nothing to publish and nothing worth logging.
                Ok(Some(frame)) => self.ivars().slot.publish(frame),
                Ok(None) => {}
                // ScreenCaptureKit can emit transient malformed buffers while
                // a display is changing mode. Do not terminate a usable
                // session for one such sample; the timed consumer path will
                // surface a persistent outage with a clear error.
                Err(error) => tracing::debug!("discarding ScreenCaptureKit sample: {error}"),
            }
        }
    }

    unsafe impl SCStreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stream_did_stop_with_error(&self, _stream: &SCStream, _error: &NSError) {
            self.ivars()
                .slot
                .stop("macOS stopped the ScreenCaptureKit stream");
        }
    }
);

unsafe impl NSObjectProtocol for StreamOutput {}

impl StreamOutput {
    fn new(slot: Arc<FrameSlot>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamOutputIvars { slot });
        unsafe { msg_send![super(this), init] }
    }
}

/// Persistent ScreenCaptureKit stream. All Objective-C objects stay on the
/// capture thread that creates this type; it is never sent through Tokio.
#[derive(Debug)]
pub(super) struct SckCapturer {
    stream: Retained<SCStream>,
    _output: Retained<StreamOutput>,
    _queue: DispatchRetained<DispatchQueue>,
    slot: Arc<FrameSlot>,
    pending: Option<Frame>,
    width: u16,
    height: u16,
}

impl SckCapturer {
    pub(super) fn new(log: &LogEmitter, display_id: Option<&str>) -> anyhow::Result<Self> {
        if !permission_granted() {
            anyhow::bail!(
                "Screen Recording permission is not granted. Open RDP Server settings, grant permission, then restart Taomni if macOS requests it."
            );
        }

        let content = shareable_content()?;
        let (display, id) = select_display(&content, display_id)?;
        let width = u16::try_from(CGDisplayPixelsWide(id))
            .map_err(|_| anyhow::anyhow!("captured display width exceeds RDP limits"))?;
        let height = u16::try_from(CGDisplayPixelsHigh(id))
            .map_err(|_| anyhow::anyhow!("captured display height exceeds RDP limits"))?;
        if width == 0 || height == 0 {
            anyhow::bail!("selected display {id} has an invalid pixel size {width}x{height}");
        }

        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            )
        };
        let configuration = unsafe { SCStreamConfiguration::new() };
        configure_stream(&configuration, width, height);

        let slot = Arc::new(FrameSlot::new());
        let output = StreamOutput::new(slot.clone());
        let delegate: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*output);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration,
                Some(delegate),
            )
        };
        let queue = DispatchQueue::new("taomni.rdp.screencapture", None);
        let stream_output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*output);
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                stream_output,
                SCStreamOutputType::Screen,
                Some(&queue),
            )
        }
        .map_err(|_| anyhow::anyhow!("could not attach ScreenCaptureKit display output"))?;
        start_stream(&stream)?;

        let first = slot.take(INITIAL_FRAME_TIMEOUT)?;
        let (frame_width, frame_height) = frame_dimensions(&first)?;
        log.line(format!(
            "macOS capture stream ready: ScreenCaptureKit display {id} ({frame_width}x{frame_height}, BGRA, queue depth {NATIVE_QUEUE_DEPTH})"
        ));

        Ok(Self {
            stream,
            _output: output,
            _queue: queue,
            slot,
            pending: Some(first),
            width: frame_width,
            height: frame_height,
        })
    }
}

fn configure_stream(configuration: &SCStreamConfiguration, width: u16, height: u16) {
    unsafe {
        configuration.setWidth(usize::from(width));
        configuration.setHeight(usize::from(height));
        configuration.setPixelFormat(kCVPixelFormatType_32BGRA);
        configuration.setMinimumFrameInterval(objc2_core_media::CMTime::new(1, FRAME_RATE));
        configuration.setQueueDepth(NATIVE_QUEUE_DEPTH);
        // The RDP client renders its local cursor immediately. Including it in
        // video produces a second, delayed cursor and was the source of the
        // observed overlap on macOS.
        configuration.setShowsCursor(false);
        configuration.setCapturesAudio(false);

        // Do not call `setShowMouseClicks(false)` here. Apple introduced that
        // selector in macOS 15; sending it to SCStreamConfiguration on macOS 14
        // raises an Objective-C exception which cannot unwind through Rust and
        // aborts the entire process. Its documented default is already false.
    }
}

impl Capturer for SckCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    /// ScreenCaptureKit enforces [`FRAME_RATE`] through
    /// `setMinimumFrameInterval`, so the display loop must not pace again.
    fn is_self_paced(&self) -> bool {
        true
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        let frame = match self.pending.take() {
            Some(frame) => frame,
            None => self.slot.take(FRAME_TIMEOUT)?,
        };
        self.accept(frame)
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        let frame = match self.pending.take() {
            Some(frame) => frame,
            None => match self.slot.take_or_idle(IDLE_POLL)? {
                Some(frame) => frame,
                // Static desktop. The stream is healthy and will deliver again
                // as soon as something on screen changes.
                None => return Ok(None),
            },
        };
        self.accept(frame).map(Some)
    }
}

impl SckCapturer {
    /// Validate a delivered frame and adopt its dimensions, which change when
    /// the captured display switches mode.
    fn accept(&mut self, frame: Frame) -> anyhow::Result<Frame> {
        let (width, height) = frame_dimensions(&frame)?;
        self.width = width;
        self.height = height;
        Ok(frame)
    }
}

impl Drop for SckCapturer {
    fn drop(&mut self) {
        self.slot.stop("RDP client disconnected");
        stop_stream(&self.stream);
    }
}

fn shareable_content() -> anyhow::Result<Retained<SCShareableContent>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = if content.is_null() {
                let detail = if error.is_null() {
                    "no content or error returned".to_string()
                } else {
                    "macOS returned an error while enumerating shareable content".to_string()
                };
                Err(anyhow::anyhow!(
                    "ScreenCaptureKit content query failed: {detail}"
                ))
            } else {
                // Apple's completion result is autoreleased. Retain it before the
                // callback returns so display selection remains valid below.
                unsafe { Retained::retain(content) }.ok_or_else(|| {
                    anyhow::anyhow!("ScreenCaptureKit returned a null content object")
                })
            };
            let _ = sender.send(result);
        },
    );
    unsafe {
        SCShareableContent::getShareableContentWithCompletionHandler(&completion);
    }
    receiver
        .recv_timeout(CONTENT_TIMEOUT)
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => anyhow::anyhow!(
                "ScreenCaptureKit did not enumerate displays within {} seconds",
                CONTENT_TIMEOUT.as_secs()
            ),
            RecvTimeoutError::Disconnected => {
                anyhow::anyhow!("ScreenCaptureKit content query disconnected")
            }
        })?
}

fn select_display(
    content: &SCShareableContent,
    display_id: Option<&str>,
) -> anyhow::Result<(Retained<SCDisplay>, u32)> {
    let requested = display_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| anyhow::anyhow!("invalid macOS display id '{value}'"))
        })
        .transpose()?;
    let displays = unsafe { content.displays().to_vec() };
    let selected = match requested {
        Some(id) => displays
            .into_iter()
            .find(|display| unsafe { display.displayID() } == id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "selected display {id} is no longer available; choose an active display in RDP Server settings"
                )
            })?,
        None => {
            let main_display = CGMainDisplayID();
            displays
                .iter()
                .find(|display| unsafe { display.displayID() } == main_display)
                .cloned()
                .or_else(|| displays.into_iter().next())
                .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit found no active macOS displays"))?
        }
    };
    let id = unsafe { selected.displayID() };
    Ok((selected, id))
}

fn start_stream(stream: &SCStream) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "macOS rejected ScreenCaptureKit stream start"
            ))
        };
        let _ = sender.send(result);
    });
    unsafe {
        stream.startCaptureWithCompletionHandler(Some(&completion));
    }
    receiver
        .recv_timeout(CONTENT_TIMEOUT)
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => anyhow::anyhow!(
                "ScreenCaptureKit did not start within {} seconds",
                CONTENT_TIMEOUT.as_secs()
            ),
            RecvTimeoutError::Disconnected => {
                anyhow::anyhow!("ScreenCaptureKit start disconnected")
            }
        })?
}

fn stop_stream(stream: &SCStream) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |_error: *mut NSError| {
        let _ = sender.send(());
    });
    unsafe {
        stream.stopCaptureWithCompletionHandler(Some(&completion));
    }
    let _ = receiver.recv_timeout(STOP_TIMEOUT);
}

/// Copy one ScreenCaptureKit sample into an owned BGRA frame.
///
/// Returns `Ok(None)` for a sample that carries no pixels. ScreenCaptureKit
/// keeps delivering buffers on the configured frame interval even when the
/// desktop is static, and marks them `SCFrameStatusIdle` with no attached image
/// buffer. Those idle markers are the normal steady state of an unchanging
/// desktop, so they must not be mistaken for a capture failure.
fn copy_bgra_frame(sample_buffer: &CMSampleBuffer) -> anyhow::Result<Option<Frame>> {
    let image_buffer = unsafe { sample_buffer.image_buffer() };
    let Some(pixel_buffer) = image_buffer else {
        return Ok(None);
    };
    if CVPixelBufferGetPixelFormatType(&pixel_buffer) != kCVPixelFormatType_32BGRA {
        anyhow::bail!("ScreenCaptureKit sample was not delivered as BGRA");
    }
    let lock_result =
        unsafe { CVPixelBufferLockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly) };
    if lock_result != kCVReturnSuccess {
        anyhow::bail!("could not lock ScreenCaptureKit pixel buffer ({lock_result})");
    }

    let result = (|| {
        let width = u16::try_from(CVPixelBufferGetWidth(&pixel_buffer))
            .map_err(|_| anyhow::anyhow!("captured display width exceeds RDP limits"))?;
        let height = u16::try_from(CVPixelBufferGetHeight(&pixel_buffer))
            .map_err(|_| anyhow::anyhow!("captured display height exceeds RDP limits"))?;
        let stride = CVPixelBufferGetBytesPerRow(&pixel_buffer);
        let row_bytes = usize::from(width)
            .checked_mul(4)
            .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit row width overflow"))?;
        if width == 0 || height == 0 || stride < row_bytes {
            anyhow::bail!("ScreenCaptureKit returned an invalid BGRA surface");
        }
        let total_bytes = stride
            .checked_mul(usize::from(height))
            .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit surface size overflow"))?;
        let base = CVPixelBufferGetBaseAddress(&pixel_buffer);
        if base.is_null() {
            anyhow::bail!("ScreenCaptureKit returned a null BGRA surface address");
        }

        // Preserve the source stride. IronRDP accepts row-aligned BGRA data,
        // avoiding a second full-frame repack on every display refresh.
        let data = unsafe { slice::from_raw_parts(base.cast::<u8>(), total_bytes) }.to_vec();
        Ok(Some(Frame::bgra(data, 0, 0, width, height, stride)))
    })();

    let unlock_result =
        unsafe { CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly) };
    if unlock_result != kCVReturnSuccess {
        return Err(anyhow::anyhow!(
            "could not unlock ScreenCaptureKit pixel buffer ({unlock_result})"
        ));
    }
    result
}

fn frame_dimensions(frame: &Frame) -> anyhow::Result<(u16, u16)> {
    if frame.width == 0 || frame.height == 0 || frame.stride < usize::from(frame.width) * 4 {
        anyhow::bail!("ScreenCaptureKit returned an invalid BGRA frame");
    }
    let expected = frame
        .stride
        .checked_mul(usize::from(frame.height))
        .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit frame size overflow"))?;
    if frame.data.len() != expected {
        anyhow::bail!(
            "ScreenCaptureKit frame has {} bytes; expected {expected}",
            frame.data.len()
        );
    }
    Ok((frame.width, frame.height))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use objc2_core_video::kCVPixelFormatType_32BGRA;
    use objc2_screen_capture_kit::SCStreamConfiguration;

    use super::{Frame, FrameSlot, configure_stream};

    fn frame(value: u8) -> Frame {
        Frame::bgra(vec![value, 0, 0, 0], 0, 0, 1, 1, 4)
    }

    #[test]
    fn frame_slot_retains_only_the_latest_callback_frame() {
        let slot = FrameSlot::new();
        slot.publish(frame(1));
        slot.publish(frame(2));
        assert_eq!(slot.take(Duration::from_millis(1)).unwrap().data[0], 2);
    }

    #[test]
    fn static_desktop_reports_an_idle_tick_instead_of_an_error() {
        // ScreenCaptureKit delivers no usable frame while the desktop is
        // unchanged. Reporting that as an error would end the capture thread and
        // freeze the connected client on its last frame.
        let slot = FrameSlot::new();
        assert!(
            slot.take_or_idle(Duration::from_millis(1))
                .expect("idle is not a failure")
                .is_none()
        );

        slot.publish(frame(7));
        let frame = slot
            .take_or_idle(Duration::from_millis(1))
            .expect("published frame is delivered")
            .expect("frame is present");
        assert_eq!(frame.data[0], 7);
    }

    #[test]
    fn stopped_stream_is_an_error_on_both_paths() {
        let slot = FrameSlot::new();
        slot.stop("display disconnected");

        let idle_error = slot.take_or_idle(Duration::from_millis(1)).unwrap_err();
        assert!(idle_error.to_string().contains("display disconnected"));
        assert!(slot.take(Duration::from_millis(1)).is_err());
    }

    #[test]
    fn required_frame_still_fails_when_none_arrives() {
        // The initial frame and the desktop-size probe genuinely need pixels.
        let slot = FrameSlot::new();
        let error = slot.take(Duration::from_millis(1)).unwrap_err();
        assert!(error.to_string().contains("produced no frame"));
    }

    #[test]
    fn stream_configuration_is_safe_on_the_deployment_target() {
        let configuration = unsafe { SCStreamConfiguration::new() };
        configure_stream(&configuration, 1920, 1080);

        unsafe {
            assert_eq!(configuration.width(), 1920);
            assert_eq!(configuration.height(), 1080);
            assert_eq!(configuration.pixelFormat(), kCVPixelFormatType_32BGRA);
            assert!(!configuration.showsCursor());
            assert!(!configuration.capturesAudio());
        }
    }
}
