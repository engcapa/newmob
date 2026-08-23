//! Screenshot / clipboard-image / open-path helpers for LanChat.
//!
//! The file-transfer engine now lives in [`crate::lanchat::swarm`]; this module
//! keeps the platform media helpers it relied on: screen capture, encoding
//! clipboard/webview images to a temp PNG, and opening a received path with the
//! OS default handler. Captured/encoded files are then handed to `swarm::send`.

use std::path::PathBuf;

use crate::servers::engine::LogEmitter;

fn temp_image_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "taomni-lanchat-{prefix}-{}.png",
        uuid::Uuid::new_v4()
    ))
}

/// Open a path with the platform's default handler (file or folder).
pub fn open_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    result.map(|_| ()).map_err(|e| format!("open {path}: {e}"))
}

/// Capture the primary monitor to a temp PNG and return its path. Blocking —
/// call via `spawn_blocking` (the X11 backend holds a thread-affine connection).
///
/// On **Linux** this reuses the RDP server's X11/XWayland capturer (MIT-SHM,
/// with a plain `GetImage` fallback), which grabs the root window directly with
/// **no xdg-desktop-portal ScreenCast backend**. That matters because WebKitGTK's
/// `getDisplayMedia` (the webview fallback) needs the ScreenCast portal, which is
/// absent on minimal desktops — e.g. Cinnamon/X11 with no `xdg-desktop-portal`
/// running, where it fails with `org.freedesktop.portal.ScreenCast … UnknownMethod`.
/// The native X11 grab sidesteps the portal entirely and works in the default
/// build (no `screen-capture`/xcap feature needed).
#[cfg(target_os = "linux")]
pub fn capture_screenshot(log: &LogEmitter) -> Result<PathBuf, String> {
    let mut capturer = crate::servers::rdp::capture::create_capturer(log)
        .map_err(|e| format!("屏幕截图失败（无法初始化 X11 捕获）：{e}"))?;
    let frame = capturer
        .capture()
        .map_err(|e| format!("屏幕截图失败（抓帧失败）：{e}"))?;
    save_bgra_frame_png(
        &frame.data,
        u32::from(frame.width),
        u32::from(frame.height),
        frame.stride,
    )
}

/// Non-Linux capture via xcap (Windows DXGI / macOS CGDisplay), gated on the
/// `screen-capture` feature. xcap on those platforms does not depend on a portal.
#[cfg(all(not(target_os = "linux"), feature = "screen-capture"))]
pub fn capture_screenshot(_log: &LogEmitter) -> Result<PathBuf, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("enumerate monitors: {e}"))?;
    let monitor = monitors.into_iter().next().ok_or("no monitor found")?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("capture: {e}"))?;
    let path = temp_image_path("shot");
    image
        .save(&path)
        .map_err(|e| format!("save screenshot: {e}"))?;
    Ok(path)
}

/// Stub for non-Linux builds without the `screen-capture` feature: the caller
/// falls back to a webview `getDisplayMedia` capture.
#[cfg(all(not(target_os = "linux"), not(feature = "screen-capture")))]
pub fn capture_screenshot(_log: &LogEmitter) -> Result<PathBuf, String> {
    Err("此版本未启用屏幕截图（需 screen-capture 构建特性）".into())
}

/// Save raw RGBA8 pixels (e.g. from the clipboard) to a temp PNG; return path.
/// Uses the pure-Rust `image` crate (no system dependencies).
pub fn save_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<PathBuf, String> {
    let buf =
        image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("invalid image buffer")?;
    let path = temp_image_path("clip");
    buf.save(&path)
        .map_err(|e| format!("save clipboard image: {e}"))?;
    Ok(path)
}

/// Convert a BGRA8888 frame (top-down, `stride` bytes per row, possibly padded)
/// to a tightly-packed RGBA PNG on disk; return its path. Used by the Linux X11
/// screenshot path, whose [`crate::servers::rdp::capture::Frame`] is BGRA.
#[cfg(target_os = "linux")]
fn save_bgra_frame_png(
    bgra: &[u8],
    width: u32,
    height: u32,
    stride: usize,
) -> Result<PathBuf, String> {
    let w = width as usize;
    let h = height as usize;
    let row_bytes = w.checked_mul(4).ok_or("frame size overflow")?;
    let mut rgba = Vec::with_capacity(row_bytes.checked_mul(h).ok_or("frame size overflow")?);
    for row in 0..h {
        let start = row * stride;
        let line = bgra
            .get(start..start + row_bytes)
            .ok_or("frame row out of bounds")?;
        for px in line.chunks_exact(4) {
            // BGRA (B,G,R,A) → RGBA (R,G,B,A).
            rgba.push(px[2]);
            rgba.push(px[1]);
            rgba.push(px[0]);
            rgba.push(px[3]);
        }
    }
    save_rgba_png(width, height, &rgba)
}

/// Write a pre-encoded PNG blob (e.g. a webview getDisplayMedia capture) to a
/// temp file and return its path. Used by the screenshot fallback when native
/// capture (the `screen-capture` build feature) is unavailable.
pub fn save_png_bytes(bytes: &[u8]) -> Result<PathBuf, String> {
    let path = temp_image_path("shot");
    std::fs::write(&path, bytes).map_err(|e| format!("save image: {e}"))?;
    Ok(path)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// The Linux screenshot path feeds the RDP capturer's BGRA frame (which may
    /// carry row padding via `stride`) through `save_bgra_frame_png`. Verify the
    /// channel swap (BGRA→RGBA) and that padding bytes are dropped, by reading
    /// the PNG back and checking exact pixel values.
    #[test]
    fn bgra_frame_png_swaps_channels_and_honors_stride() {
        // 2x2 image, 4 bytes/row of padding after each 2px (8B) row → stride 12.
        let w = 2u32;
        let h = 2u32;
        let stride = 12usize;
        // Pixels in BGRA: (B,G,R,A). Pick distinct channels so a swap is visible.
        let px = |b, g, r, a: u8| [b, g, r, a];
        let mut bgra = Vec::new();
        // row 0: red, green  + padding
        bgra.extend_from_slice(&px(0, 0, 255, 255)); // red
        bgra.extend_from_slice(&px(0, 255, 0, 255)); // green
        bgra.extend_from_slice(&[0xAA; 4]); // padding (must be ignored)
        // row 1: blue, white + padding
        bgra.extend_from_slice(&px(255, 0, 0, 255)); // blue
        bgra.extend_from_slice(&px(255, 255, 255, 255)); // white
        bgra.extend_from_slice(&[0xAA; 4]); // padding

        let path = save_bgra_frame_png(&bgra, w, h, stride).expect("encode png");
        let img = image::open(&path).expect("reopen png").to_rgba8();
        let _ = std::fs::remove_file(&path);

        assert_eq!(img.dimensions(), (2, 2));
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]); // red
        assert_eq!(img.get_pixel(1, 0).0, [0, 255, 0, 255]); // green
        assert_eq!(img.get_pixel(0, 1).0, [0, 0, 255, 255]); // blue
        assert_eq!(img.get_pixel(1, 1).0, [255, 255, 255, 255]); // white
    }
}
