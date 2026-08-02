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
use std::time::Instant;

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
pub(crate) struct Frame {
    pub data: Vec<u8>,
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
            data,
            captured_at: Instant::now(),
            sequence: 0,
            x,
            y,
            width,
            height,
            stride,
        }
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
            displays: Vec::new(),
            summary: capture_capability_summary(),
        })
    }
}
