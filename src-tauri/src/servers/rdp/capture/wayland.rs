//! Wayland screen capture and input through one xdg-desktop-portal session.
//!
//! A Wayland compositor does not expose the desktop through XWayland. The RDP
//! server therefore asks the RemoteDesktop portal for a monitor ScreenCast and,
//! for interactive sessions, keyboard/pointer devices in the same consent
//! dialog. Frames arrive through a persistent PipeWire stream instead of one
//! portal screenshot request per frame.

use std::io::Cursor;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use anyhow::{Context as _, bail};
use ashpd::desktop::remote_desktop::{Axis as PortalAxis, DeviceType, KeyState, RemoteDesktop};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::{PersistMode, Session};
use pipewire::channel;
use pipewire::context::ContextRc;
use pipewire::keys::{MEDIA_CATEGORY, MEDIA_ROLE, MEDIA_TYPE};
use pipewire::main_loop::MainLoopRc;
use pipewire::properties;
use pipewire::spa::param::format::FormatProperties;
use pipewire::spa::param::format_utils;
use pipewire::spa::param::video::{VideoFormat, VideoInfoRaw};
use pipewire::spa::param::{ParamType, format::MediaSubtype, format::MediaType};
use pipewire::spa::pod::{self, Pod, serialize::PodSerializer};
use pipewire::spa::utils::{Direction, Fraction, Rectangle, SpaTypes};
use pipewire::stream::{StreamFlags, StreamRc};

use super::{Capturer, Frame, PortalInput};
use crate::servers::engine::LogEmitter;

const FRAME_WAIT: Duration = Duration::from_millis(100);
const INITIAL_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DIMENSION: u32 = 16_384;

/// The environment is authoritative. `DISPLAY` is commonly present in a real
/// Wayland session because XWayland is running, so it must not affect routing.
pub(crate) fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
}

pub(crate) fn try_new(log: &LogEmitter, request_input: bool) -> anyhow::Result<Box<dyn Capturer>> {
    log.line(
        "Wayland session: requesting one RemoteDesktop portal session for persistent \
         PipeWire capture and optional keyboard/pointer control",
    );
    Ok(Box::new(WaylandCapturer::new(log, request_input)?))
}

#[derive(Debug)]
struct RawFrame {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

struct FrameMailbox {
    frame: Mutex<Option<RawFrame>>,
    ready: Condvar,
    closed: AtomicBool,
}

impl Default for FrameMailbox {
    fn default() -> Self {
        Self {
            frame: Mutex::new(None),
            ready: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }
}

impl FrameMailbox {
    fn publish(&self, frame: RawFrame) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut pending) = self.frame.lock() {
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            *pending = Some(frame);
            self.ready.notify_one();
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ready.notify_all();
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn take_timeout(&self, timeout: Duration) -> anyhow::Result<Option<RawFrame>> {
        let mut pending = self
            .frame
            .lock()
            .map_err(|_| anyhow::anyhow!("Wayland frame mailbox poisoned"))?;
        if pending.is_none() {
            let (guard, _) = self
                .ready
                .wait_timeout(pending, timeout)
                .map_err(|_| anyhow::anyhow!("Wayland frame mailbox poisoned"))?;
            pending = guard;
        }
        Ok(pending.take())
    }
}

struct PortalContext {
    runtime: tokio::runtime::Runtime,
    remote_desktop: RemoteDesktop<'static>,
    screencast: Screencast<'static>,
    session: Session<'static, RemoteDesktop<'static>>,
    stream_node: u32,
    logical_size: Option<(u32, u32)>,
    input_enabled: bool,
}

impl PortalContext {
    fn new(request_input: bool) -> anyhow::Result<(Self, OwnedFd)> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create Wayland portal runtime")?;

        let (
            remote_desktop,
            screencast,
            session,
            stream_node,
            logical_size,
            input_enabled,
            pipewire_fd,
        ) = runtime.block_on(async move {
            let remote_desktop = RemoteDesktop::new().await?;
            let screencast = Screencast::new().await?;
            let session = remote_desktop.create_session().await?;

            if request_input {
                remote_desktop
                    .select_devices(
                        &session,
                        DeviceType::Keyboard | DeviceType::Pointer,
                        None,
                        PersistMode::DoNot,
                    )
                    .await?
                    .response()?;
            }
            screencast
                .select_sources(
                    &session,
                    CursorMode::Embedded,
                    SourceType::Monitor.into(),
                    false,
                    None,
                    PersistMode::DoNot,
                )
                .await?
                .response()?;

            let response = remote_desktop.start(&session, None).await?.response()?;
            let stream = response
                .streams()
                .and_then(|streams| streams.first())
                .ok_or_else(|| anyhow::anyhow!("portal did not return a monitor stream"))?;
            let logical_size = stream.size().and_then(|(width, height)| {
                u32::try_from(width).ok().zip(u32::try_from(height).ok())
            });
            let input_enabled = request_input
                && response.devices().contains(DeviceType::Keyboard)
                && response.devices().contains(DeviceType::Pointer);
            let stream_node = stream.pipe_wire_node_id();
            let pipewire_fd = screencast.open_pipe_wire_remote(&session).await?;
            Ok::<_, anyhow::Error>((
                remote_desktop,
                screencast,
                session,
                stream_node,
                logical_size,
                input_enabled,
                pipewire_fd,
            ))
        })?;

        Ok((
            Self {
                runtime,
                remote_desktop,
                screencast,
                session,
                stream_node,
                logical_size,
                input_enabled,
            },
            pipewire_fd,
        ))
    }

    fn inject(&self, input: PortalInput) -> anyhow::Result<()> {
        if !self.input_enabled {
            bail!("Wayland portal did not grant keyboard and pointer control");
        }
        self.runtime.block_on(async {
            match input {
                PortalInput::Keycode { code, pressed } => {
                    self.remote_desktop
                        .notify_keyboard_keycode(&self.session, code, key_state(pressed))
                        .await?
                }
                PortalInput::Keysym { keysym, pressed } => {
                    self.remote_desktop
                        .notify_keyboard_keysym(&self.session, keysym, key_state(pressed))
                        .await?
                }
                PortalInput::Button { button, pressed } => {
                    self.remote_desktop
                        .notify_pointer_button(&self.session, button, key_state(pressed))
                        .await?
                }
                PortalInput::MotionAbsolute { x, y } => {
                    self.remote_desktop
                        .notify_pointer_motion_absolute(&self.session, self.stream_node, x, y)
                        .await?
                }
                PortalInput::MotionRelative { dx, dy } => {
                    self.remote_desktop
                        .notify_pointer_motion(&self.session, dx, dy)
                        .await?
                }
                PortalInput::Scroll { horizontal, steps } => {
                    let axis = if horizontal {
                        PortalAxis::Horizontal
                    } else {
                        PortalAxis::Vertical
                    };
                    self.remote_desktop
                        .notify_pointer_axis_discrete(&self.session, axis, steps)
                        .await?
                }
            }
            Ok::<_, ashpd::Error>(())
        })?;
        Ok(())
    }
}

impl Drop for PortalContext {
    fn drop(&mut self) {
        let _ = self.runtime.block_on(self.session.close());
        let _ = &self.screencast;
    }
}

fn key_state(pressed: bool) -> KeyState {
    if pressed {
        KeyState::Pressed
    } else {
        KeyState::Released
    }
}

pub(crate) struct WaylandCapturer {
    portal: PortalContext,
    mailbox: Arc<FrameMailbox>,
    stop: channel::Sender<()>,
    width: u16,
    height: u16,
    retained: Option<Frame>,
}

impl WaylandCapturer {
    fn new(log: &LogEmitter, request_input: bool) -> anyhow::Result<Self> {
        let (portal, pipewire_fd) = PortalContext::new(request_input).map_err(|error| {
            anyhow::anyhow!(
                "Wayland RemoteDesktop portal authorization failed: {error}. \
                 Approve the monitor and requested input devices in the compositor dialog."
            )
        })?;
        let mailbox = Arc::new(FrameMailbox::default());
        let stop = spawn_pipewire_capture(
            pipewire_fd,
            portal.stream_node,
            mailbox.clone(),
            log.clone(),
        )?;
        let initial = mailbox
            .take_timeout(INITIAL_FRAME_TIMEOUT)?
            .ok_or_else(|| anyhow::anyhow!("PipeWire produced no frame within 10 seconds"))?;
        let frame = raw_to_frame(initial)?;
        let width = frame.width;
        let height = frame.height;
        log.line(format!(
            "Wayland capture ready: {}x{} (RemoteDesktop portal, PipeWire, input={})",
            width,
            height,
            if portal.input_enabled {
                "granted"
            } else {
                "disabled"
            }
        ));
        let mut portal = portal;
        if portal.logical_size.is_none() {
            portal.logical_size = Some((u32::from(width), u32::from(height)));
        }
        Ok(Self {
            portal,
            mailbox,
            stop,
            width,
            height,
            retained: Some(frame),
        })
    }
}

impl Drop for WaylandCapturer {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

impl Capturer for WaylandCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        if let Some(frame) = self.retained.take() {
            return Ok(frame);
        }
        loop {
            if let Some(raw) = self.mailbox.take_timeout(FRAME_WAIT)? {
                let frame = raw_to_frame(raw)?;
                self.width = frame.width;
                self.height = frame.height;
                return Ok(frame);
            }
            if self.mailbox.is_closed() {
                bail!("Wayland PipeWire capture stream closed");
            }
        }
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        if let Some(frame) = self.retained.take() {
            return Ok(Some(frame));
        }
        let Some(raw) = self.mailbox.take_timeout(FRAME_WAIT)? else {
            if self.mailbox.is_closed() {
                bail!("Wayland PipeWire capture stream closed");
            }
            return Ok(None);
        };
        let frame = raw_to_frame(raw)?;
        self.width = frame.width;
        self.height = frame.height;
        Ok(Some(frame))
    }

    fn is_self_paced(&self) -> bool {
        true
    }

    fn needs_frame_deduplication(&self) -> bool {
        false
    }

    fn supports_portal_input(&self) -> bool {
        self.portal.input_enabled
    }

    fn inject_portal_input(&mut self, input: PortalInput) -> anyhow::Result<()> {
        let input = match input {
            PortalInput::MotionAbsolute { x, y } => {
                let (logical_width, logical_height) = self
                    .portal
                    .logical_size
                    .unwrap_or((u32::from(self.width), u32::from(self.height)));
                PortalInput::MotionAbsolute {
                    x: map_absolute_coordinate(x, self.width, logical_width),
                    y: map_absolute_coordinate(y, self.height, logical_height),
                }
            }
            other => other,
        };
        self.portal.inject(input)
    }
}

fn map_absolute_coordinate(value: f64, surface_extent: u16, logical_extent: u32) -> f64 {
    if surface_extent <= 1 || logical_extent == 0 {
        return 0.0;
    }
    let max = f64::from(surface_extent - 1);
    value.clamp(0.0, max) * f64::from(logical_extent) / f64::from(surface_extent)
}

fn raw_to_frame(raw: RawFrame) -> anyhow::Result<Frame> {
    let width = u16::try_from(raw.width).context("Wayland stream width exceeds RDP limits")?;
    let height = u16::try_from(raw.height).context("Wayland stream height exceeds RDP limits")?;
    let stride = usize::from(width)
        .checked_mul(4)
        .context("Wayland frame stride overflow")?;
    let expected = stride
        .checked_mul(usize::from(height))
        .context("Wayland frame size overflow")?;
    if width == 0 || height == 0 || raw.bgra.len() != expected {
        bail!(
            "invalid Wayland frame geometry {}x{} for {} bytes",
            width,
            height,
            raw.bgra.len()
        );
    }
    Ok(Frame::bgra(raw.bgra, 0, 0, width, height, stride))
}

#[derive(Default)]
struct ListenerData {
    format: VideoInfoRaw,
}

fn spawn_pipewire_capture(
    remote_fd: OwnedFd,
    stream_node: u32,
    mailbox: Arc<FrameMailbox>,
    log: LogEmitter,
) -> anyhow::Result<channel::Sender<()>> {
    let (stop_tx, stop_rx) = channel::channel();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("rdp-pipewire".to_string())
        .spawn(move || {
            let worker_mailbox = mailbox.clone();
            let result = run_pipewire(remote_fd, stream_node, worker_mailbox, stop_rx, ready_tx);
            mailbox.close();
            if let Err(error) = result {
                log.line(format!("Wayland PipeWire capture stopped: {error}"));
                tracing::warn!(%error, "Wayland PipeWire capture stopped");
            }
        })
        .context("start PipeWire capture thread")?;
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| anyhow::anyhow!("PipeWire capture initialization timed out"))??;
    Ok(stop_tx)
}

fn run_pipewire(
    remote_fd: OwnedFd,
    stream_node: u32,
    mailbox: Arc<FrameMailbox>,
    stop_rx: channel::Receiver<()>,
    ready_tx: std::sync::mpsc::SyncSender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    pipewire::init();
    let main_loop = MainLoopRc::new(None).context("create PipeWire main loop")?;
    let context = ContextRc::new(&main_loop, None).context("create PipeWire context")?;
    let core = context
        .connect_fd_rc(remote_fd, None)
        .context("connect to portal PipeWire remote")?;
    let stream = StreamRc::new(
        core,
        "Taomni RDP Wayland capture",
        properties::properties! {
            *MEDIA_TYPE => "Video",
            *MEDIA_CATEGORY => "Capture",
            *MEDIA_ROLE => "Screen",
        },
    )
    .context("create PipeWire stream")?;

    let listener = stream
        .add_local_listener_with_user_data(ListenerData::default())
        .param_changed(|_, state, id, param| {
            let Some(param) = param else { return };
            if id != ParamType::Format.as_raw() {
                return;
            }
            if let Ok((MediaType::Video, MediaSubtype::Raw)) = format_utils::parse_format(param) {
                if let Err(error) = state.format.parse(param) {
                    tracing::warn!(?error, "could not parse Wayland PipeWire video format");
                }
            }
        })
        .process(move |stream, state| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let Some(data) = buffer.datas_mut().first_mut() else {
                return;
            };
            let chunk = data.chunk();
            if chunk
                .flags()
                .contains(pipewire::spa::buffer::ChunkFlags::CORRUPTED)
            {
                return;
            }
            let offset = chunk.offset() as usize;
            let size = chunk.size() as usize;
            let stride = chunk.stride();
            let Some(mapped) = data.data() else {
                tracing::warn!("Wayland PipeWire offered an unmapped DMA buffer");
                return;
            };
            let dimensions = state.format.size();
            match copy_pipewire_bgra(
                mapped,
                offset,
                size,
                stride,
                dimensions.width,
                dimensions.height,
                state.format.format(),
            ) {
                Ok(frame) => mailbox.publish(frame),
                Err(error) => tracing::warn!(%error, "discarding invalid PipeWire frame"),
            }
        })
        .register()
        .context("register PipeWire listener")?;

    let format = pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA,
            VideoFormat::BGR,
            VideoFormat::RGB
        ),
        pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: 1920,
                height: 1080
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: MAX_DIMENSION,
                height: MAX_DIMENSION
            }
        ),
        pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 60, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction { num: 60, denom: 1 }
        )
    );
    let bytes = PodSerializer::serialize(Cursor::new(Vec::new()), &pod::Value::Object(format))
        .map_err(|error| anyhow::anyhow!("serialize PipeWire format: {error}"))?
        .0
        .into_inner();
    let mut params =
        [Pod::from_bytes(&bytes).ok_or_else(|| anyhow::anyhow!("build PipeWire format pod"))?];
    stream
        .connect(
            Direction::Input,
            Some(stream_node),
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .context("connect PipeWire stream")?;

    let stop_listener = stop_rx.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |_| main_loop.quit()
    });
    let _ = ready_tx.send(Ok(()));
    main_loop.run();
    drop(stop_listener);
    drop(listener);
    Ok(())
}

fn copy_pipewire_bgra(
    mapped: &[u8],
    offset: usize,
    chunk_size: usize,
    stride: i32,
    width: u32,
    height: u32,
    format: VideoFormat,
) -> anyhow::Result<RawFrame> {
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        bail!("invalid PipeWire dimensions {width}x{height}");
    }
    let bytes_per_pixel = if format == VideoFormat::RGB || format == VideoFormat::BGR {
        3usize
    } else if matches!(
        format,
        VideoFormat::BGRx | VideoFormat::BGRA | VideoFormat::RGBx | VideoFormat::RGBA
    ) {
        4usize
    } else {
        bail!("unsupported PipeWire pixel format {format:?}");
    };
    let row_bytes = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(bytes_per_pixel))
        .context("PipeWire row size overflow")?;
    let source_stride = if stride == 0 {
        row_bytes
    } else {
        usize::try_from(stride.unsigned_abs()).context("PipeWire stride overflow")?
    };
    if source_stride < row_bytes {
        bail!("PipeWire stride {source_stride} is smaller than row size {row_bytes}");
    }
    let required = source_stride
        .checked_mul(usize::try_from(height).unwrap())
        .context("PipeWire frame size overflow")?;
    let available = chunk_size.min(mapped.len().saturating_sub(offset));
    if offset > mapped.len() || available < required {
        bail!("PipeWire buffer has {available} bytes; expected {required}");
    }
    let source = &mapped[offset..offset + required];
    let pixel_count = usize::try_from(width)
        .unwrap()
        .checked_mul(usize::try_from(height).unwrap())
        .context("PipeWire pixel count overflow")?;
    let mut bgra = Vec::with_capacity(pixel_count * 4);
    for output_row in 0..usize::try_from(height).unwrap() {
        let source_row = if stride < 0 {
            usize::try_from(height).unwrap() - 1 - output_row
        } else {
            output_row
        };
        let row = &source[source_row * source_stride..source_row * source_stride + row_bytes];
        for pixel in row.chunks_exact(bytes_per_pixel) {
            if matches!(
                format,
                VideoFormat::BGRx | VideoFormat::BGRA | VideoFormat::BGR
            ) {
                bgra.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0xff]);
            } else {
                bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 0xff]);
            }
        }
    }
    Ok(RawFrame {
        width,
        height,
        bgra,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_detection_prefers_wayland_even_with_xwayland() {
        assert!(session_is_wayland(Some("wayland-0"), Some("wayland")));
        assert!(session_is_wayland(None, Some("WAYLAND")));
        assert!(!session_is_wayland(None, Some("x11")));
    }

    fn session_is_wayland(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
        wayland_display.is_some()
            || session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
    }

    #[test]
    fn pipewire_bgrx_honors_stride_and_discards_padding() {
        let source = [
            1, 2, 3, 0, 4, 5, 6, 0, 99, 99, 99, 99, 7, 8, 9, 0, 10, 11, 12, 0, 88, 88, 88, 88,
        ];
        let frame =
            copy_pipewire_bgra(&source, 0, source.len(), 12, 2, 2, VideoFormat::BGRx).unwrap();
        assert_eq!(
            frame.bgra,
            vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,]
        );
    }

    #[test]
    fn pipewire_rgba_swaps_red_and_blue_and_handles_bottom_up() {
        let source = [1, 2, 3, 4, 5, 6, 7, 8];
        let frame =
            copy_pipewire_bgra(&source, 0, source.len(), -4, 1, 2, VideoFormat::RGBA).unwrap();
        assert_eq!(frame.bgra, vec![7, 6, 5, 255, 3, 2, 1, 255]);
    }

    #[test]
    fn pipewire_rejects_truncated_or_oversized_frames() {
        assert!(copy_pipewire_bgra(&[0; 4], 0, 4, 8, 2, 1, VideoFormat::BGRx).is_err());
        assert!(copy_pipewire_bgra(&[], 0, 0, 0, MAX_DIMENSION + 1, 1, VideoFormat::BGRx).is_err());
    }

    #[test]
    fn mailbox_close_wakes_waiters_and_reports_closed_stream() {
        let mailbox = FrameMailbox::default();
        mailbox.close();
        assert!(mailbox.is_closed());
        assert!(
            mailbox
                .take_timeout(Duration::from_millis(1))
                .unwrap()
                .is_none()
        );
    }
}
