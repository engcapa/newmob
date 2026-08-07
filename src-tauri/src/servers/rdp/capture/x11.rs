//! X11 screen capture using `x11rb`, with an event-driven fast path and safe
//! fallbacks, mirroring how RustDesk/NoMachine keep latency and idle CPU low.
//!
//! Three things stack here:
//!
//! 1. **Grab mechanism** — MIT-SHM (`shm`): a shared memory segment is allocated
//!    once and each grab is a single `shm_get_image` into that buffer, with no
//!    per-frame protocol image transfer. The modern FD-passing
//!    `shm_create_segment` needs MIT-SHM ≥ 1.2, which is not available
//!    everywhere (older Xorg, some remote/forwarded or sandboxed connections),
//!    so when SHM setup fails we fall back to plain `GetImage` (the image travels
//!    over the X connection each frame — slower, but always available on a local
//!    TrueColor display).
//!
//! 2. **Change detection** — the XDamage extension. Instead of polling the whole
//!    screen on a fixed interval and hashing 8 MB to ask "did anything change?",
//!    we let the X server tell us *when* and *where* it changed. A `Damage`
//!    object on the root window (report level `BoundingBox`) delivers a
//!    `DamageNotify` whose `area` is the bounding box of what changed. Idle ⇒ no
//!    events ⇒ zero readback, zero hashing, zero CPU. When DAMAGE is missing we
//!    fall back to the legacy fixed-interval full-frame path (`is_event_driven()`
//!    stays false and the display layer adds its own interval + dedup).
//!
//! 3. **Region cropping** — we read back and send only the damaged bounding box,
//!    not the whole screen. The IronRDP encoder diffs that sub-rectangle against
//!    its framebuffer and RemoteFX-encodes only the changed tiles, so a small
//!    on-screen change costs O(changed area), not O(screen). The first frame of
//!    each connection is always full so the encoder's framebuffer is seeded.
//!
//! Either grab path yields BGRA on a depth-24/32 visual (little-endian
//! Z_PIXMAP), matching `PixelFormat::BgrA32`.

use std::os::unix::io::OwnedFd;
use std::ptr::NonNull;
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};
use x11rb::connection::{Connection, RequestConnection as _};
use x11rb::protocol::Event;
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::randr::{self, ConnectionExt as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xfixes::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, ImageFormat};
use x11rb::rust_connection::RustConnection;

use super::{Capturer, Frame};
use crate::servers::engine::LogEmitter;

/// Upper bound on capture rate under continuous damage (e.g. dragging a window
/// or video playback). 16 ms ≈ 60 fps: responsive without spending the CPU to
/// encode faster than a client can usefully display.
const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(16);

/// How long a single `next_updates` call waits for damage before returning an
/// idle tick. Bounds shutdown latency (the capture thread notices a dropped
/// client within this window) while keeping idle wakeups rare.
const DAMAGE_WAIT_BUDGET: Duration = Duration::from_millis(100);

/// Poll granularity while waiting for damage events. Small enough to feel
/// instant on the first change, large enough that idle polling of the socket is
/// negligible (no pixel readback happens here — just a check of the X socket).
const DAMAGE_POLL_STEP: Duration = Duration::from_millis(2);

/// A mmap'd MIT-SHM segment shared with the X server.
struct ShmBuffer {
    seg: shm::Seg,
    ptr: NonNull<u8>,
    len: usize,
    // Kept alive for the lifetime of the mapping; closed on drop.
    _fd: OwnedFd,
}

impl ShmBuffer {
    fn as_slice(&self) -> &[u8] {
        // SAFETY: `ptr`/`len` come from a successful mmap of a SHM segment of
        // exactly `len` bytes that stays mapped until `Drop`. The X server only
        // writes here during `shm_get_image().reply()`, which we await before
        // reading, so there is no concurrent mutation while this slice lives.
        unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }
}

impl Drop for ShmBuffer {
    fn drop(&mut self) {
        // SAFETY: `ptr`/`len` describe the live mapping created in `new`.
        unsafe {
            libc::munmap(self.ptr.as_ptr().cast(), self.len);
        }
    }
}

/// Which grab mechanism the capturer is using.
enum Backend {
    /// MIT-SHM fast path: one shared segment, no per-frame transfer.
    Shm(ShmBuffer),
    /// Plain `GetImage`: image travels over the X connection each frame.
    Plain,
}

/// XDamage tracking state. Present only when the X server advertises the DAMAGE
/// extension and we successfully created a `Damage` object on the root window.
struct DamageState {
    damage: damage::Damage,
    /// Pre-allocated XFixes region used as the `parts` sink for
    /// `damage_subtract` so the consume-and-read-back is atomic server-side (no
    /// lost-update race between reading a notify and clearing the damage).
    region: xfixes::Region,
    /// When we last read pixels back, to enforce [`MIN_FRAME_INTERVAL`].
    last_capture: Option<Instant>,
}

pub(crate) struct X11Capturer {
    conn: RustConnection,
    root: xproto::Window,
    width: u16,
    height: u16,
    depth: u8,
    backend: Backend,
    /// `Some` when event-driven (XDamage) capture is active; `None` falls back
    /// to fixed-interval full-frame polling driven by the display layer.
    damage: Option<DamageState>,
    randr: bool,
}

impl X11Capturer {
    pub(crate) fn new(log: &LogEmitter) -> anyhow::Result<Self> {
        let (conn, screen_num) =
            x11rb::connect(None).context("cannot connect to X11 display (is DISPLAY set?)")?;

        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let width = screen.width_in_pixels;
        let height = screen.height_in_pixels;
        let depth = screen.root_depth;

        if depth != 24 && depth != 32 {
            log.line(format!(
                "WARNING: X11 root depth is {} (expected 24/32); colors may be wrong",
                depth
            ));
        }

        // Try the MIT-SHM fast path; on any failure fall back to plain GetImage
        // rather than giving up (which would surface the synthetic placeholder).
        let backend = match Self::try_init_shm(&conn, width, height) {
            Ok(shm) => {
                log.line(format!(
                    "X11 capture ready: {}x{} depth {} (MIT-SHM)",
                    width, height, depth
                ));
                tracing::info!(%width, %height, depth, "X11 capture using MIT-SHM");
                Backend::Shm(shm)
            }
            Err(e) => {
                // Mirror to BOTH the UI log panel and tracing/stdout so the
                // reason is visible wherever the operator is looking.
                let msg = format!(
                    "MIT-SHM unavailable ({}); falling back to plain GetImage (slower).",
                    e
                );
                log.line(msg.clone());
                tracing::warn!("X11 capture: {}", msg);
                Backend::Plain
            }
        };

        // Try to set up XDamage so capture can be event-driven and cropped to
        // changed regions. On any failure we log once and fall back to the
        // legacy fixed-interval full-frame path (damage = None).
        let damage = match Self::try_init_damage(&conn, root) {
            Ok(d) => {
                log.line("X11 capture: XDamage active (event-driven, region-cropped)".to_string());
                tracing::info!("X11 capture using XDamage");
                Some(d)
            }
            Err(e) => {
                let msg = format!(
                    "XDamage unavailable ({}); falling back to fixed-interval full-frame capture.",
                    e
                );
                log.line(msg.clone());
                tracing::warn!("X11 capture: {}", msg);
                None
            }
        };
        let randr = match Self::try_init_randr(&conn, root) {
            Ok(()) => {
                log.line("X11 capture: XRandR geometry monitoring active".to_string());
                true
            }
            Err(error) => {
                tracing::warn!(%error, "X11 XRandR monitoring unavailable; geometry is checked during capture");
                false
            }
        };

        Ok(Self {
            conn,
            root,
            width,
            height,
            depth,
            backend,
            damage,
            randr,
        })
    }

    /// Probe the DAMAGE (and XFixes) extensions and, if present, create a
    /// root-window damage object plus a scratch region for race-free subtract.
    /// Returns `Err` (rather than bailing) so the caller can fall back to
    /// interval polling.
    fn try_init_damage(conn: &RustConnection, root: xproto::Window) -> anyhow::Result<DamageState> {
        if conn
            .extension_information(damage::X11_EXTENSION_NAME)
            .context("querying DAMAGE extension")?
            .is_none()
        {
            bail!("X11 server has no DAMAGE extension");
        }
        if conn
            .extension_information(xfixes::X11_EXTENSION_NAME)
            .context("querying XFIXES extension")?
            .is_none()
        {
            bail!("X11 server has no XFIXES extension (needed for damage regions)");
        }
        // Negotiate versions (also verifies the server actually speaks them).
        // XFixes ≥ 2.0 is required before any XFixes request is allowed.
        conn.xfixes_query_version(5, 0)
            .context("XFIXES query_version")?
            .reply()
            .context("XFIXES query_version reply")?;
        conn.damage_query_version(1, 1)
            .context("DAMAGE query_version")?
            .reply()
            .context("DAMAGE query_version reply")?;

        let damage_id = conn.generate_id().context("generate Damage id")?;
        // NON_EMPTY: the server delivers a single notify when the damage region
        // transitions empty→non-empty (least chatty). The precise multi-rect
        // damage is read back via `damage_subtract` into our region regardless
        // of report level, so we get exact changed rectangles, not a coarse box.
        conn.damage_create(damage_id, root, damage::ReportLevel::NON_EMPTY)
            .context("damage_create")?
            .check()
            .context("damage_create check")?;

        let region = conn.generate_id().context("generate Region id")?;
        conn.xfixes_create_region(region, &[])
            .context("xfixes_create_region")?
            .check()
            .context("xfixes_create_region check")?;

        Ok(DamageState {
            damage: damage_id,
            region,
            last_capture: None,
        })
    }

    fn try_init_randr(conn: &RustConnection, root: xproto::Window) -> anyhow::Result<()> {
        if conn
            .extension_information(randr::X11_EXTENSION_NAME)
            .context("querying RANDR extension")?
            .is_none()
        {
            bail!("X11 server has no RANDR extension");
        }
        conn.randr_query_version(1, 5)
            .context("RANDR query_version")?
            .reply()
            .context("RANDR query_version reply")?;
        conn.randr_select_input(
            root,
            randr::NotifyMask::SCREEN_CHANGE
                | randr::NotifyMask::CRTC_CHANGE
                | randr::NotifyMask::OUTPUT_CHANGE
                | randr::NotifyMask::RESOURCE_CHANGE,
        )
        .context("RANDR select_input")?
        .check()
        .context("RANDR select_input check")?;
        Ok(())
    }

    /// Probe MIT-SHM and, if usable, allocate the shared segment. Returns `Err`
    /// (rather than panicking or bailing the whole capturer) so the caller can
    /// fall back to plain `GetImage`.
    fn try_init_shm(conn: &RustConnection, width: u16, height: u16) -> anyhow::Result<ShmBuffer> {
        if conn
            .extension_information(shm::X11_EXTENSION_NAME)
            .context("querying SHM extension")?
            .is_none()
        {
            bail!("X11 server has no MIT-SHM extension");
        }
        // `shm_create_segment` (FD passing) needs MIT-SHM >= 1.2. Check the
        // version so we fail fast on old servers instead of erroring mid-request.
        let ver = conn
            .shm_query_version()
            .context("SHM query_version")?
            .reply()
            .context("SHM query_version reply")?;
        if (ver.major_version, ver.minor_version) < (1, 2) {
            bail!(
                "MIT-SHM {}.{} too old for fd-passing (need >= 1.2)",
                ver.major_version,
                ver.minor_version
            );
        }
        Self::alloc_shm(conn, width, height)
    }

    /// Allocate a SHM segment sized for one BGRA frame and mmap it into our
    /// address space, sharing the same fd with the X server.
    fn alloc_shm(conn: &RustConnection, width: u16, height: u16) -> anyhow::Result<ShmBuffer> {
        let len = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|p| p.checked_mul(4))
            .context("frame size overflow")?;
        let len_u32 = u32::try_from(len).context("X11 SHM frame exceeds request size limit")?;

        let seg = conn.generate_id().context("generate SHM seg id")?;
        let reply = conn
            .shm_create_segment(seg, len_u32, false)
            .context("shm_create_segment")?
            .reply()
            .context("shm_create_segment reply")?;
        let fd = OwnedFd::from(reply.shm_fd);

        // SAFETY: mmap a shared, readable/writable view of the segment fd of
        // exactly `len` bytes. We check for MAP_FAILED before constructing the
        // NonNull. The mapping outlives `fd` (kept in ShmBuffer) and is unmapped
        // in Drop.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                std::os::unix::io::AsRawFd::as_raw_fd(&fd),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            // Detach the segment we just created before bailing.
            let _ = conn.shm_detach(seg);
            bail!(
                "mmap of SHM segment failed: {}",
                std::io::Error::last_os_error()
            );
        }
        let ptr = NonNull::new(ptr.cast::<u8>()).context("mmap returned null")?;

        Ok(ShmBuffer {
            seg,
            ptr,
            len,
            _fd: fd,
        })
    }
}

impl Drop for X11Capturer {
    fn drop(&mut self) {
        // Tear down the damage object first (best effort).
        if let Some(d) = &self.damage {
            let _ = self.conn.damage_destroy(d.damage);
        }
        // Detach the SHM segment from the X server (no-op for the plain backend).
        // The local mapping is freed by ShmBuffer::drop.
        if let Backend::Shm(shm) = &self.backend {
            let _ = self.conn.shm_detach(shm.seg);
        }
        let _ = self.conn.flush();
    }
}

/// A pixel rectangle in desktop coordinates, used to accumulate (union) damaged
/// areas before a single readback. Kept tiny and pure so the union/clamp logic
/// can be unit-tested without an X server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DamageRect {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
}

impl DamageRect {
    /// Build from a raw X `Rectangle`, clamped to the desktop bounds. Returns
    /// `None` if the rectangle is empty or lies fully outside the screen.
    fn from_x_rect(r: xproto::Rectangle, screen_w: u16, screen_h: u16) -> Option<Self> {
        // X rectangles use i16 origins and u16 extents; clamp into the screen.
        let x0 = r.x.max(0) as u16;
        let y0 = r.y.max(0) as u16;
        if x0 >= screen_w || y0 >= screen_h {
            return None;
        }
        let x1 = (i32::from(r.x) + i32::from(r.width)).clamp(0, i32::from(screen_w)) as u16;
        let y1 = (i32::from(r.y) + i32::from(r.height)).clamp(0, i32::from(screen_h)) as u16;
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some(Self {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        })
    }

    /// Smallest rectangle covering both `self` and `other`.
    fn union(self, other: Self) -> Self {
        let x0 = self.x.min(other.x);
        let y0 = self.y.min(other.y);
        let x1 = (self.x + self.w).max(other.x + other.w);
        let y1 = (self.y + self.h).max(other.y + other.h);
        Self {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

impl X11Capturer {
    /// Grab a sub-rectangle of the root window into a tightly-packed BGRA
    /// [`Frame`] at origin `(x, y)`. `capture()` is just the full-screen case.
    ///
    /// GetImage/shm_get_image always pack the reply at the *requested* width
    /// (`bytes_per_line = bpp * width`), so a cropped grab is tightly packed at
    /// `w * 4` regardless of the full-frame stride.
    fn grab_rect(&self, x: u16, y: u16, w: u16, h: u16) -> anyhow::Result<Frame> {
        let mut data = match &self.backend {
            Backend::Shm(shm) => {
                self.conn
                    .shm_get_image(
                        self.root,
                        x as i16,
                        y as i16,
                        w,
                        h,
                        !0,
                        ImageFormat::Z_PIXMAP.into(),
                        shm.seg,
                        0,
                    )
                    .context("shm_get_image")?
                    .reply()
                    .context("shm_get_image reply")?;
                // Copy out only the bytes this region occupies (packed at w*4);
                // the X server may overwrite the segment on the next grab.
                let len = usize::from(w) * usize::from(h) * 4;
                shm.as_slice()[..len].to_vec()
            }
            Backend::Plain => {
                let reply = self
                    .conn
                    .get_image(
                        ImageFormat::Z_PIXMAP,
                        self.root,
                        x as i16,
                        y as i16,
                        w,
                        h,
                        !0,
                    )
                    .context("get_image")?
                    .reply()
                    .context("get_image reply")?;
                reply.data
            }
        };

        let expected = usize::from(w)
            .checked_mul(usize::from(h))
            .and_then(|pixels| pixels.checked_mul(4))
            .context("X11 image size overflow")?;
        if data.len() != expected {
            bail!(
                "X11 image returned {} bytes for {}x{} BGRA pixels (expected {})",
                data.len(),
                w,
                h,
                expected
            );
        }

        // Depth 24 still arrives as 4 bytes/pixel in Z_PIXMAP on 32-bpp visuals;
        // the unused 4th byte is undefined, so force it opaque for BgrA32.
        if self.depth == 24 {
            for px in data.chunks_exact_mut(4) {
                px[3] = 0xff;
            }
        }

        Ok(Frame::bgra(data, x, y, w, h, usize::from(w) * 4))
    }

    /// Drain all currently-queued `DamageNotify` events. Returns true if at
    /// least one arrived (we don't trust their coordinates — the precise region
    /// comes from `subtract_into_region`; the event is just the wakeup signal).
    fn drain_damage_events(&self) -> anyhow::Result<(bool, bool)> {
        let mut damage = false;
        let mut resize = false;
        while let Some(event) = self.conn.poll_for_event().context("poll_for_event")? {
            match event {
                Event::DamageNotify(_) => damage = true,
                Event::RandrScreenChangeNotify(change) if change.root == self.root => {
                    resize = true;
                }
                Event::RandrNotify(_) => resize = true,
                _ => {}
            }
        }
        Ok((damage, resize))
    }

    /// Atomically consume the accumulated damage into our scratch region and
    /// fetch back the exact changed rectangles, clamped to the screen. This is
    /// race-free: any change between the notify and here is folded into the same
    /// subtract, so nothing is cleared without being reported.
    fn subtract_into_rects(&self) -> anyhow::Result<Vec<DamageRect>> {
        let Some(d) = &self.damage else {
            return Ok(vec![]);
        };
        // repair = NONE means "report everything"; parts = our region receives
        // the consumed area, which we then fetch.
        self.conn
            .damage_subtract(d.damage, x11rb::NONE, d.region)
            .context("damage_subtract")?;
        let reply = self
            .conn
            .xfixes_fetch_region(d.region)
            .context("xfixes_fetch_region")?
            .reply()
            .context("xfixes_fetch_region reply")?;
        let rects = reply
            .rectangles
            .into_iter()
            .filter_map(|r| DamageRect::from_x_rect(r, self.width, self.height))
            .collect();
        Ok(rects)
    }

    /// Discard any pending damage without capturing (used to reset state after a
    /// full frame so we don't immediately re-send already-covered regions).
    fn clear_damage(&self) -> anyhow::Result<()> {
        let _ = self.drain_damage_events()?;
        let _ = self.subtract_into_rects()?;
        Ok(())
    }

    fn refresh_geometry(&mut self) -> anyhow::Result<bool> {
        let geometry = self
            .conn
            .get_geometry(self.root)
            .context("get root geometry")?
            .reply()
            .context("get root geometry reply")?;
        let new_width = geometry.width;
        let new_height = geometry.height;
        if !geometry_changed((self.width, self.height), (new_width, new_height)) {
            return Ok(false);
        }
        if new_width == 0 || new_height == 0 {
            bail!("X11 root geometry changed to zero size");
        }
        if let Backend::Shm(shm) = &self.backend {
            let _ = self.conn.shm_detach(shm.seg);
        }
        self.backend = match Self::try_init_shm(&self.conn, new_width, new_height) {
            Ok(shm) => Backend::Shm(shm),
            Err(error) => {
                tracing::warn!(%error, "X11 SHM reallocation failed after resize; using GetImage");
                Backend::Plain
            }
        };
        self.width = new_width;
        self.height = new_height;
        self.depth = geometry.depth;
        if self.damage.is_some() {
            self.clear_damage()?;
        }
        tracing::info!(
            width = new_width,
            height = new_height,
            randr = self.randr,
            "X11 capture geometry changed"
        );
        Ok(true)
    }
}

fn geometry_changed(old: (u16, u16), new: (u16, u16)) -> bool {
    old != new
}

impl Capturer for X11Capturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        if !self.randr {
            let _ = self.refresh_geometry()?;
        }
        self.grab_rect(0, 0, self.width, self.height)
    }

    fn is_event_driven(&self) -> bool {
        self.damage.is_some()
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        if self.randr {
            let (_, resize_event) = self.drain_damage_events()?;
            if resize_event && self.refresh_geometry()? {
                return Ok(Some(self.capture()?));
            }
        }
        self.capture().map(Some)
    }

    fn next_updates(&mut self, first: bool) -> anyhow::Result<Vec<Frame>> {
        if self.randr {
            let (_, resize_event) = self.drain_damage_events()?;
            if resize_event && self.refresh_geometry()? {
                self.clear_damage()?;
                return Ok(vec![self.capture()?]);
            }
        } else if self.refresh_geometry()? {
            self.clear_damage()?;
            return Ok(vec![self.capture()?]);
        }
        // Polling fallback (no DAMAGE): one full frame; the display layer adds
        // its own interval + dedup.
        if self.damage.is_none() {
            return Ok(vec![self.capture()?]);
        }

        // First frame of a connection MUST be full so the encoder seeds its
        // framebuffer before any cropped region is diffed against it. Clear any
        // damage accumulated before the client connected so we don't immediately
        // re-send a region that's already covered by this full frame.
        if first {
            self.conn.flush().context("flush")?;
            self.clear_damage()?;
            self.conn.flush().context("flush")?;
            let frame = self.capture()?;
            if let Some(d) = self.damage.as_mut() {
                d.last_capture = Some(Instant::now());
            }
            return Ok(vec![frame]);
        }

        // Wait (sleeping, no readback) until the X server reports damage or the
        // budget elapses. Idle ⇒ we return an empty vec so the caller can check
        // for shutdown.
        let deadline = Instant::now() + DAMAGE_WAIT_BUDGET;
        loop {
            self.conn.flush().context("flush")?;
            let (damage_event, resize_event) = self.drain_damage_events()?;
            if resize_event && self.refresh_geometry()? {
                self.clear_damage()?;
                return Ok(vec![self.capture()?]);
            }
            if damage_event {
                break;
            }
            if Instant::now() >= deadline {
                return Ok(vec![]);
            }
            std::thread::sleep(DAMAGE_POLL_STEP);
        }

        // Enforce a max capture rate under continuous damage: if we captured
        // very recently, sleep the remainder and let more damage accumulate
        // server-side (free coalescing — it folds into the one subtract below).
        if let Some(last) = self.damage.as_ref().and_then(|d| d.last_capture) {
            if let Some(rem) = MIN_FRAME_INTERVAL.checked_sub(last.elapsed()) {
                std::thread::sleep(rem);
                self.conn.flush().context("flush")?;
                let _ = self.drain_damage_events()?;
            }
        }

        // Atomically consume + read back the exact changed rectangles, then grab
        // only those regions. Many tiny scattered rects (e.g. text carets) would
        // mean many small readbacks; cap the count by falling back to a single
        // bounding box when the server reports a lot of fragments.
        let rects = self.subtract_into_rects()?;
        self.conn.flush().context("flush")?;
        if rects.is_empty() {
            return Ok(vec![]);
        }

        const MAX_RECTS: usize = 8;
        let regions: Vec<DamageRect> = if rects.len() > MAX_RECTS {
            // Coalesce everything into one bounding box: cheaper than dozens of
            // round-trips, and the encoder still tile-diffs it.
            let mut bbox = rects[0];
            for r in &rects[1..] {
                bbox = bbox.union(*r);
            }
            vec![bbox]
        } else {
            rects
        };

        let mut frames = Vec::with_capacity(regions.len());
        for r in regions {
            frames.push(self.grab_rect(r.x, r.y, r.w, r.h)?);
        }
        if let Some(d) = self.damage.as_mut() {
            d.last_capture = Some(Instant::now());
        }
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runtime smoke test: only meaningful with a reachable X11 display. Skips
    /// cleanly (passes) when DISPLAY is unset or the server has no MIT-SHM, so
    /// CI on headless boxes does not fail. When a display IS present it proves
    /// the full SHM grab path end to end and sanity-checks the frame geometry.
    #[test]
    fn x11_capture_produces_a_frame_when_display_present() {
        if std::env::var_os("DISPLAY").is_none() {
            eprintln!("skipping: no DISPLAY");
            return;
        }
        // We need a LogEmitter, which requires an AppHandle we don't have in a
        // unit test. Exercise the connection + SHM path directly instead.
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping: cannot connect to X11: {e}");
                return;
            }
        };
        if conn
            .extension_information(shm::X11_EXTENSION_NAME)
            .ok()
            .flatten()
            .is_none()
        {
            eprintln!("skipping: no MIT-SHM");
            return;
        }
        let screen = &conn.setup().roots[screen_num];
        let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);
        assert!(w > 0 && h > 0, "screen size should be positive");

        let shm = X11Capturer::alloc_shm(&conn, w, h).expect("alloc shm");
        let _reply = shm::get_image(
            &conn,
            screen.root,
            0,
            0,
            w,
            h,
            !0,
            ImageFormat::Z_PIXMAP.into(),
            shm.seg,
            0,
        )
        .expect("shm_get_image request")
        .reply()
        .expect("shm_get_image reply");

        let data = shm.as_slice();
        assert_eq!(
            data.len(),
            usize::from(w) * usize::from(h) * 4,
            "BGRA buffer length matches geometry"
        );
        let _ = conn.shm_detach(shm.seg);
    }

    /// The plain `GetImage` fallback must produce a correctly-sized BGRA frame
    /// on any local TrueColor display, independent of MIT-SHM. This exercises
    /// the path taken when SHM setup fails (the cause of the placeholder
    /// rainbow). Skips when no DISPLAY is reachable.
    #[test]
    fn plain_get_image_fallback_produces_a_frame() {
        if std::env::var_os("DISPLAY").is_none() {
            eprintln!("skipping: no DISPLAY");
            return;
        }
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping: cannot connect to X11: {e}");
                return;
            }
        };
        let screen = &conn.setup().roots[screen_num];
        let mut cap = X11Capturer {
            root: screen.root,
            width: screen.width_in_pixels,
            height: screen.height_in_pixels,
            depth: screen.root_depth,
            backend: Backend::Plain,
            damage: None,
            randr: false,
            conn,
        };
        let frame = cap.capture().expect("plain GetImage capture");
        assert_eq!(frame.width, cap.width);
        assert_eq!(frame.height, cap.height);
        assert_eq!(
            frame.data.len(),
            usize::from(frame.width) * usize::from(frame.height) * 4,
            "BGRA frame length matches geometry"
        );
        assert_eq!(frame.stride, usize::from(frame.width) * 4);
    }

    /// Build a capturer without a `LogEmitter` (which needs a Tauri AppHandle),
    /// wiring up SHM-or-plain and DAMAGE exactly like `new()` does. Returns
    /// `None` (test skips) when no X11 display is reachable.
    fn connect_capturer() -> Option<X11Capturer> {
        if std::env::var_os("DISPLAY").is_none() {
            eprintln!("skipping: no DISPLAY");
            return None;
        }
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping: cannot connect to X11: {e}");
                return None;
            }
        };
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let width = screen.width_in_pixels;
        let height = screen.height_in_pixels;
        let depth = screen.root_depth;
        let backend = match X11Capturer::try_init_shm(&conn, width, height) {
            Ok(shm) => Backend::Shm(shm),
            Err(_) => Backend::Plain,
        };
        let damage = X11Capturer::try_init_damage(&conn, root).ok();
        Some(X11Capturer {
            conn,
            root,
            width,
            height,
            depth,
            backend,
            damage,
            randr: false,
        })
    }

    /// End-to-end check of the event-driven path on a live X11 box: DAMAGE must
    /// initialize, the first `next_updates` must return one full-screen frame
    /// (so the encoder framebuffer is seeded), and an idle tick afterwards must
    /// return promptly (empty or a small region — never the whole screen by
    /// default). Skips cleanly when DISPLAY/DAMAGE are unavailable.
    #[test]
    fn damage_first_update_is_full_then_idle_is_bounded() {
        let Some(mut cap) = connect_capturer() else {
            return;
        };
        if !cap.is_event_driven() {
            eprintln!("skipping: DAMAGE not available on this server");
            return;
        }
        let (w, h) = cap.desktop_size();

        // First update: exactly one full-screen frame at origin (0,0).
        let first = cap.next_updates(true).expect("first next_updates");
        assert_eq!(first.len(), 1, "first update should be a single full frame");
        let f = &first[0];
        assert_eq!((f.x, f.y, f.width, f.height), (0, 0, w, h));
        assert_eq!(f.data.len(), usize::from(w) * usize::from(h) * 4);
        assert_eq!(f.stride, usize::from(w) * 4);

        // A subsequent update returns within ~2x the wait budget. On an idle
        // desktop it's empty; if the desktop happens to change (clock, cursor
        // caret) it's a region that fits within the screen and is tightly
        // packed. Either way it must NOT block indefinitely or exceed bounds.
        let start = Instant::now();
        let next = cap.next_updates(false).expect("second next_updates");
        assert!(
            start.elapsed() < DAMAGE_WAIT_BUDGET * 3,
            "next_updates should return within the wait budget"
        );
        for f in &next {
            assert!(
                f.x + f.width <= w && f.y + f.height <= h,
                "region in bounds"
            );
            assert_eq!(f.stride, usize::from(f.width) * 4, "tightly packed");
            assert_eq!(
                f.data.len(),
                usize::from(f.width) * usize::from(f.height) * 4
            );
        }
    }

    #[test]
    fn damage_rect_clamps_into_screen() {
        // A rect partly off the right/bottom edge is clipped to the screen.
        let r = xproto::Rectangle {
            x: 1900,
            y: 1060,
            width: 200,
            height: 200,
        };
        let d = DamageRect::from_x_rect(r, 1920, 1080).expect("in-bounds after clamp");
        assert_eq!((d.x, d.y, d.w, d.h), (1900, 1060, 20, 20));
    }

    #[test]
    fn damage_rect_negative_origin_clamped() {
        // Negative origins (i16) clamp to 0 and the extent shrinks accordingly.
        let r = xproto::Rectangle {
            x: -10,
            y: -5,
            width: 50,
            height: 50,
        };
        let d = DamageRect::from_x_rect(r, 1920, 1080).expect("in-bounds");
        assert_eq!((d.x, d.y, d.w, d.h), (0, 0, 40, 45));
    }

    #[test]
    fn damage_rect_fully_offscreen_is_none() {
        let r = xproto::Rectangle {
            x: 2000,
            y: 0,
            width: 10,
            height: 10,
        };
        assert!(DamageRect::from_x_rect(r, 1920, 1080).is_none());
    }

    #[test]
    fn damage_rect_union_is_bounding_box() {
        let a = DamageRect {
            x: 10,
            y: 10,
            w: 20,
            h: 20,
        };
        let b = DamageRect {
            x: 100,
            y: 5,
            w: 10,
            h: 10,
        };
        // Union spans x:[10,110), y:[5,30) → (10,5,100,25).
        assert_eq!(
            a.union(b),
            DamageRect {
                x: 10,
                y: 5,
                w: 100,
                h: 25
            }
        );
        // Union is commutative.
        assert_eq!(a.union(b), b.union(a));
    }

    #[test]
    fn geometry_change_detection_is_dimension_only() {
        assert!(!geometry_changed((1920, 1080), (1920, 1080)));
        assert!(geometry_changed((1920, 1080), (2560, 1440)));
        assert!(geometry_changed((2560, 1440), (1920, 1080)));
    }
}
