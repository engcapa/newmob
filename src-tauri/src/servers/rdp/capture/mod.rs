//! Platform screen-capture abstraction for the RDP server display side.
//!
//! A [`Capturer`] yields full-frame BGRA images. Backends are `#[cfg]`-gated per
//! platform:
//! - **Linux X11**: MIT-SHM + XDamage via `x11rb` (`x11.rs`)
//! - **Linux Wayland**: `xcap` portal fallback when X11 is unreachable (`wayland.rs`)
//! - **macOS**: persistent native display stream via `xcap` (`mac.rs`)
//! - **Windows**: still a placeholder (DXGI/WGC not in this branch)
//!
//! A captured [`Frame`] is BGRA8888 (`PixelFormat::BgrA32`), top-down, tightly
//! packed at `stride` bytes per row — exactly what `BitmapUpdate` wants, so the
//! display layer can wrap it with zero pixel conversion.

use crate::servers::engine::LogEmitter;
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::fmt;
#[cfg(target_os = "macos")]
use std::slice;
#[cfg(target_os = "macos")]
use std::sync::{Arc, OnceLock};
use std::time::Instant;

#[cfg(target_os = "macos")]
use objc2_core_foundation::CFRetained;
#[cfg(target_os = "macos")]
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVReturnSuccess,
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) mod xcap_backend;

#[cfg(target_os = "linux")]
pub(crate) mod wayland;
#[cfg(target_os = "linux")]
pub(crate) mod x11;

#[cfg(target_os = "macos")]
pub(crate) mod mac;

/// One captured frame or sub-region: BGRA8888, `stride` bytes per row,
/// `height` rows. `x`/`y` are the top-left origin of this region within the
/// desktop (0,0 for a full-screen frame), so the display layer can place a
/// cropped damage rectangle at the right offset in the client's framebuffer.
#[derive(Clone, Debug)]
pub(crate) struct Frame {
    /// Reference-counted pixels make retaining the most recent complete frame
    /// cheap. A newly authenticated client can replay that frame immediately
    /// instead of waiting several seconds for a new native capture stream.
    pub data: bytes::Bytes,
    /// ScreenCaptureKit's retained IOSurface. The regular bitmap path copies it
    /// lazily, while VideoToolbox consumes it directly without a BGRA roundtrip.
    #[cfg(target_os = "macos")]
    native: Option<NativeBgraFrame>,
    /// Monotonic timestamp taken after the backend has produced the pixels.
    /// It lets the display handoff report frame age without relying on wall
    /// clock time or carrying user-visible data into telemetry.
    pub captured_at: Instant,
    /// Assigned by the capture loop immediately before publication.
    pub sequence: u64,
    /// Region origin within the desktop, in pixels.
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// Bytes per row (`>= width * 4`).
    pub stride: usize,
}

impl Frame {
    pub(crate) fn bgra(
        data: Vec<u8>,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        stride: usize,
    ) -> Self {
        Self {
            data: data.into(),
            #[cfg(target_os = "macos")]
            native: None,
            captured_at: Instant::now(),
            sequence: 0,
            x,
            y,
            width,
            height,
            stride,
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn native_bgra(
        pixel_buffer: CFRetained<CVPixelBuffer>,
        width: u16,
        height: u16,
        stride: usize,
    ) -> Self {
        Self {
            data: bytes::Bytes::new(),
            native: Some(NativeBgraFrame::new(pixel_buffer, stride, height)),
            captured_at: Instant::now(),
            sequence: 0,
            x: 0,
            y: 0,
            width,
            height,
            stride,
        }
    }

    /// Logical BGRA payload size without forcing a native IOSurface readback.
    pub(crate) fn byte_len(&self) -> usize {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            return native.byte_len();
        }
        self.data.len()
    }

    /// Return owned BGRA pixels for the compatibility bitmap path. Native
    /// frames are copied at most once across all clones of the retained frame.
    pub(crate) fn bgra_bytes(&self) -> anyhow::Result<bytes::Bytes> {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            return native.bgra_bytes();
        }
        Ok(self.data.clone())
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn native_pixel_buffer(&self) -> Option<CFRetained<CVPixelBuffer>> {
        self.native.as_ref().map(NativeBgraFrame::pixel_buffer)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn copy_bgra_rows_to(
        &self,
        output: &mut [u8],
        output_stride: usize,
    ) -> anyhow::Result<()> {
        let row_bytes = usize::from(self.width)
            .checked_mul(4)
            .ok_or_else(|| anyhow::anyhow!("BGRA row size overflow"))?;
        if self.stride < row_bytes || output_stride < row_bytes {
            anyhow::bail!("BGRA row stride is smaller than the visible row");
        }
        let output_len = output_stride
            .checked_mul(usize::from(self.height))
            .ok_or_else(|| anyhow::anyhow!("BGRA output size overflow"))?;
        if output.len() < output_len {
            anyhow::bail!(
                "BGRA output has {} bytes; expected at least {output_len}",
                output.len()
            );
        }
        if let Some(native) = &self.native {
            return native.copy_rows_to(output, output_stride, self.stride, row_bytes, self.height);
        }
        let source_len = self
            .stride
            .checked_mul(usize::from(self.height))
            .ok_or_else(|| anyhow::anyhow!("BGRA source size overflow"))?;
        if self.data.len() < source_len {
            anyhow::bail!(
                "BGRA source has {} bytes; expected at least {source_len}",
                self.data.len()
            );
        }
        copy_rows(
            &self.data,
            self.stride,
            output,
            output_stride,
            row_bytes,
            self.height,
        );
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct NativeBgraFrame {
    inner: Arc<NativeBgraFrameInner>,
}

#[cfg(target_os = "macos")]
struct NativeBgraFrameInner {
    pixel_buffer: CFRetained<CVPixelBuffer>,
    byte_len: usize,
    copied: OnceLock<Result<bytes::Bytes, String>>,
}

// CVPixelBuffer/IOSurface objects are retainable, lockable CoreVideo buffers
// intended for cross-queue media pipelines. Access to mutable base-address
// state is serialized by CoreVideo's lock API, and the lazy copy is OnceLock.
#[cfg(target_os = "macos")]
unsafe impl Send for NativeBgraFrameInner {}
#[cfg(target_os = "macos")]
unsafe impl Sync for NativeBgraFrameInner {}

#[cfg(target_os = "macos")]
impl NativeBgraFrame {
    fn new(pixel_buffer: CFRetained<CVPixelBuffer>, stride: usize, height: u16) -> Self {
        Self {
            inner: Arc::new(NativeBgraFrameInner {
                pixel_buffer,
                byte_len: stride.saturating_mul(usize::from(height)),
                copied: OnceLock::new(),
            }),
        }
    }

    fn byte_len(&self) -> usize {
        self.inner.byte_len
    }

    fn pixel_buffer(&self) -> CFRetained<CVPixelBuffer> {
        self.inner.pixel_buffer.clone()
    }

    fn bgra_bytes(&self) -> anyhow::Result<bytes::Bytes> {
        self.inner
            .copied
            .get_or_init(|| copy_pixel_buffer(&self.inner.pixel_buffer, self.inner.byte_len))
            .as_ref()
            .cloned()
            .map_err(|error| anyhow::anyhow!(error.clone()))
    }

    fn copy_rows_to(
        &self,
        output: &mut [u8],
        output_stride: usize,
        source_stride: usize,
        row_bytes: usize,
        height: u16,
    ) -> anyhow::Result<()> {
        with_pixel_buffer_bytes(&self.inner.pixel_buffer, self.inner.byte_len, |source| {
            copy_rows(
                source,
                source_stride,
                output,
                output_stride,
                row_bytes,
                height,
            );
            Ok(())
        })
        .map_err(anyhow::Error::msg)
    }
}

#[cfg(target_os = "macos")]
impl fmt::Debug for NativeBgraFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeBgraFrame")
            .field("byte_len", &self.inner.byte_len)
            .field("copied", &self.inner.copied.get().is_some())
            .finish_non_exhaustive()
    }
}

#[cfg(target_os = "macos")]
fn copy_pixel_buffer(
    pixel_buffer: &CVPixelBuffer,
    byte_len: usize,
) -> Result<bytes::Bytes, String> {
    with_pixel_buffer_bytes(pixel_buffer, byte_len, |data| {
        Ok(bytes::Bytes::copy_from_slice(data))
    })
}

#[cfg(target_os = "macos")]
fn with_pixel_buffer_bytes<T>(
    pixel_buffer: &CVPixelBuffer,
    byte_len: usize,
    operation: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Result<T, String> {
    let lock_result =
        unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) };
    if lock_result != kCVReturnSuccess {
        return Err(format!(
            "could not lock ScreenCaptureKit pixel buffer ({lock_result})"
        ));
    }

    let result = (|| {
        let base = CVPixelBufferGetBaseAddress(pixel_buffer);
        if base.is_null() {
            return Err("ScreenCaptureKit returned a null BGRA surface address".to_string());
        }
        let data = unsafe { slice::from_raw_parts(base.cast::<u8>(), byte_len) };
        operation(data)
    })();

    let unlock_result =
        unsafe { CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) };
    if unlock_result != kCVReturnSuccess {
        return Err(format!(
            "could not unlock ScreenCaptureKit pixel buffer ({unlock_result})"
        ));
    }
    result
}

#[cfg(target_os = "macos")]
fn copy_rows(
    source: &[u8],
    source_stride: usize,
    output: &mut [u8],
    output_stride: usize,
    row_bytes: usize,
    height: u16,
) {
    for row in 0..usize::from(height) {
        let source_start = row * source_stride;
        let output_start = row * output_stride;
        output[output_start..output_start + row_bytes]
            .copy_from_slice(&source[source_start..source_start + row_bytes]);
    }
}

/// A platform screen-capture source. Lives on its own OS thread because most
/// native backends hold thread-affine, non-`Send` handles (X11 SHM pointers,
/// DXGI device contexts, …).
pub(crate) trait Capturer {
    /// Current desktop size in pixels `(width, height)`.
    fn desktop_size(&self) -> (u16, u16);

    /// Capture the whole screen into a BGRA full-frame [`Frame`]. Blocking.
    fn capture(&mut self) -> anyhow::Result<Frame>;

    /// Whether this backend can change its output dimensions without changing
    /// the captured desktop. ScreenCaptureKit uses this to scale at the source
    /// to the initial size requested by the RDP client.
    #[cfg(target_os = "macos")]
    fn supports_output_resize(&self) -> bool {
        false
    }

    /// Reconfigure the capture output and return the first frame with the new
    /// dimensions. The default keeps legacy fixed-size capture backends honest.
    #[cfg(target_os = "macos")]
    fn resize_output(&mut self, _width: u16, _height: u16) -> anyhow::Result<Frame> {
        anyhow::bail!("capture backend does not support output resizing")
    }

    /// Poll for the next full frame, distinguishing "nothing changed" from
    /// "capture is broken".
    ///
    /// `Ok(None)` means the backend saw no new content within its own idle
    /// budget. That is the normal state of a static desktop, so the caller MUST
    /// keep polling; treating it as an error terminates the capture thread and
    /// freezes the client on its last frame. `Err` is reserved for a capture
    /// source that has genuinely failed.
    ///
    /// The default implementation preserves the older "every call must yield a
    /// frame" contract used by the X11, Wayland and xcap backends.
    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        self.capture().map(Some)
    }

    /// Whether this backend already caps its own frame rate at the source.
    ///
    /// A self-paced backend blocks inside [`Capturer::poll_frame`] until the
    /// next frame is genuinely available, so the caller must NOT add a poll
    /// interval on top: doing so pages in a frame that is already waiting only
    /// at the next tick, adding up to one whole frame interval of staleness.
    ///
    /// Unlike [`Capturer::is_event_driven`], a self-paced backend still returns
    /// full frames, so the caller keeps its dedup hashing.
    fn is_self_paced(&self) -> bool {
        false
    }

    /// Whether the display loop must scan the complete pixel buffer to suppress
    /// duplicate frames.
    ///
    /// Grab-on-demand sources may return the same desktop on every poll and
    /// therefore need the hash. Native change streams such as ScreenCaptureKit
    /// already distinguish an idle tick from a new frame; hashing those Retina
    /// buffers only adds a full-screen memory pass to every real update.
    fn needs_frame_deduplication(&self) -> bool {
        true
    }

    /// Whether this backend drives itself off change notifications (e.g. X11
    /// XDamage) rather than fixed-interval polling. Event-driven backends sleep
    /// until the screen actually changes and return only the changed regions,
    /// so the caller must NOT add its own poll interval or frame-dedup hashing.
    fn is_event_driven(&self) -> bool {
        false
    }

    /// Drive one update step and return zero or more BGRA regions to send.
    ///
    /// - `first` is true only for the very first call on a fresh connection; an
    ///   event-driven backend MUST return a single full-screen frame then, so
    ///   the encoder's framebuffer is initialized before any cropped region is
    ///   sent (the IronRDP encoder only seeds its framebuffer from a
    ///   full-desktop bitmap; cropped updates diff against it).
    /// - An empty result means "idle tick, nothing changed" — the caller can
    ///   loop again (and check for shutdown) without sending anything.
    ///
    /// The default implementation is the polling path: capture one full frame.
    /// The caller is then responsible for its own interval + dedup. Event-driven
    /// backends override this to block on change notifications and crop.
    fn next_updates(&mut self, first: bool) -> anyhow::Result<Vec<Frame>> {
        let _ = first;
        Ok(vec![self.capture()?])
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureDisplay {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureProbe {
    /// `granted`, `denied`, or `notRequired`.
    pub permission: String,
    /// macOS Accessibility permission used for keyboard and pointer injection.
    pub control_permission: String,
    pub displays: Vec<CaptureDisplay>,
    pub summary: String,
}

/// Human-readable capture capability for this OS / session (used by start logs
/// and the settings UI probe). Does not create a long-lived capturer.
pub(crate) fn capture_capability_summary() -> String {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("DISPLAY").is_some() {
            return "Linux: X11/XWayland capture available when DISPLAY is set; \
                    pure Wayland falls back to xcap portal"
                .into();
        }
        if wayland::is_wayland_session() {
            return "Linux Wayland: capture via xcap/portal (user must accept ScreenCast prompt)"
                .into();
        }
        return "Linux: no DISPLAY and not a Wayland session — capture unavailable".into();
    }
    #[cfg(target_os = "macos")]
    {
        return "macOS: persistent native display capture (requires Screen Recording permission)"
            .into();
    }
    #[cfg(target_os = "windows")]
    {
        return "Windows: DXGI/WGC capture not implemented in this build — placeholder frames only"
            .into();
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        "unsupported platform".into()
    }
}

/// Build the best available capturer for this platform, or `Err` with a clear
/// reason. MUST be called on the thread that will own/drive the capturer, since
/// backends are not `Send`.
pub(crate) fn create_capturer(log: &LogEmitter) -> anyhow::Result<Box<dyn Capturer>> {
    create_capturer_for_display(log, None)
}

/// Build a capturer for an explicitly selected display. The selector is used
/// on macOS; other platforms retain their existing desktop-selection policy.
pub(crate) fn create_capturer_for_display(
    log: &LogEmitter,
    display_id: Option<&str>,
) -> anyhow::Result<Box<dyn Capturer>> {
    #[cfg(target_os = "linux")]
    {
        // Try X11 first whenever an X server is reachable. This is authoritative:
        // on a real Xorg session it captures the desktop directly, and on a
        // Wayland session with XWayland it still captures (XWayland exposes the
        // root window). Only when X11 is genuinely unreachable do we fall back to
        // the Wayland/xcap portal path.
        match x11::X11Capturer::new(log) {
            Ok(cap) => return Ok(Box::new(cap)),
            Err(x11_err) => {
                if wayland::is_wayland_session() {
                    log.line(format!(
                        "X11 capturer unavailable ({x11_err}); trying Wayland/xcap portal fallback"
                    ));
                    return wayland::try_new(log);
                }
                return Err(x11_err);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = log;
        anyhow::bail!(
            "Windows screen capture (DXGI/WGC) is not implemented yet — RDP server will \
             serve a placeholder frame. Desktop sharing on Windows is deferred in this branch."
        )
    }

    #[cfg(target_os = "macos")]
    {
        mac::try_new(log, display_id)
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = log;
        anyhow::bail!("screen capture is not supported on this platform")
    }
}

/// Return the permission/display state surfaced by the RDP Server settings.
/// This probe never prompts. The explicit request action is implemented by
/// [`mac::request_permission`] and run on Tauri's main thread.
pub(crate) fn probe() -> anyhow::Result<CaptureProbe> {
    #[cfg(target_os = "macos")]
    {
        return mac::probe();
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(CaptureProbe {
            permission: "notRequired".to_string(),
            control_permission: "notRequired".to_string(),
            displays: Vec::new(),
            summary: capture_capability_summary(),
        })
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use core::ffi::c_void;
    use std::ptr::{self, NonNull};

    use objc2_core_foundation::CFRetained;
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferCreateWithBytes, kCVPixelFormatType_32BGRA, kCVReturnSuccess,
    };

    use super::Frame;

    fn native_frame(data: &mut [u8], width: u16, height: u16) -> Frame {
        let stride = usize::from(width) * 4;
        let mut raw = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferCreateWithBytes(
                None,
                usize::from(width),
                usize::from(height),
                kCVPixelFormatType_32BGRA,
                NonNull::new(data.as_mut_ptr().cast::<c_void>()).unwrap(),
                stride,
                None,
                ptr::null_mut(),
                None,
                NonNull::from(&mut raw),
            )
        };
        assert_eq!(status, kCVReturnSuccess);
        let pixel_buffer: CFRetained<CVPixelBuffer> =
            unsafe { CFRetained::from_raw(NonNull::new(raw).unwrap()) };
        Frame::native_bgra(pixel_buffer, width, height, stride)
    }

    #[test]
    fn native_padding_copy_does_not_materialize_an_intermediate_frame() {
        let mut source = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let frame = native_frame(&mut source, 2, 1);
        let mut padded = vec![0; 16];

        frame.copy_bgra_rows_to(&mut padded, 16).unwrap();

        assert_eq!(&padded[..8], source.as_slice());
        assert_eq!(&padded[8..], &[0; 8]);
        assert!(
            frame.native.as_ref().unwrap().inner.copied.get().is_none(),
            "VideoToolbox padding must not allocate a second full BGRA frame"
        );
    }

    #[test]
    fn bitmap_readback_is_cached_across_native_frame_clones() {
        let mut source = vec![9, 8, 7, 6];
        let frame = native_frame(&mut source, 1, 1);
        let clone = frame.clone();

        let first = frame.bgra_bytes().unwrap();
        let second = clone.bgra_bytes().unwrap();

        assert_eq!(first.as_ref(), source.as_slice());
        assert_eq!(first.as_ptr(), second.as_ptr());
    }
}
