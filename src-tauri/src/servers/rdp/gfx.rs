//! Low-latency macOS EGFX/AVC420 path for the in-process RDP server.
//!
//! The regular RDP bitmap path remains the compatibility baseline. When a
//! client advertises the Graphics Pipeline Extension with AVC420, this module
//! sends current ScreenCaptureKit frames through VideoToolbox's real-time H.264
//! encoder instead. The graphics server's frame acknowledgements are used as a
//! hard two-frame backpressure boundary: newest state wins over building a
//! network or decoder backlog.

use core::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ironrdp::dvc::encode_dvc_messages;
use ironrdp::svc::ChannelFlags;
use ironrdp_egfx::pdu::{Avc420Region, CapabilitiesAdvertisePdu, CapabilitySet};
use ironrdp_egfx::server::{GraphicsPipelineHandler, GraphicsPipelineServer};
use ironrdp_server::{
    EgfxServerMessage, GfxDvcBridge, GfxServerFactory, GfxServerHandle, ServerEvent,
    ServerEventSender,
};
use objc2_core_foundation::{CFBoolean, CFRetained};
use objc2_core_media::{
    CMBlockBuffer, CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetH264ParameterSetAtIndex,
    kCMTimeInvalid, kCMVideoCodecType_H264,
};
use objc2_core_video::{
    CVImageBuffer, CVPixelBuffer, CVPixelBufferCreateWithBytes, kCVPixelFormatType_32BGRA,
    kCVReturnSuccess,
};
use objc2_video_toolbox::{
    VTCompressionSession, VTSession, VTSessionSetProperty,
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_RealTime,
};
use tokio::sync::mpsc::UnboundedSender;

use super::capture::Frame;
use crate::servers::engine::LogEmitter;

/// Two outstanding ACKs leave room for one currently-rendering frame without
/// permitting an interactive client to accumulate visibly stale desktop state.
const MAX_FRAMES_IN_FLIGHT: u32 = 2;
const ENCODE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(crate) struct GfxTransport {
    state: Arc<Mutex<GfxState>>,
    log: LogEmitter,
}

struct GfxState {
    sender: Option<UnboundedSender<ServerEvent>>,
    handle: Option<GfxServerHandle>,
    surface: Option<GfxSurface>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct GfxSurface {
    id: u16,
    width: u16,
    height: u16,
}

pub(crate) enum GfxSubmit {
    /// EGFX took ownership of a current frame.
    Sent,
    /// The client has enough in-flight frames. The caller must discard this
    /// frame rather than falling back to a bitmap update, which would only add
    /// stale work to the connection.
    Backpressured,
    /// No negotiated AVC420 graphics path is available; use normal RDP bitmap
    /// updates so older clients remain fully supported.
    Unavailable,
}

pub(crate) enum GfxReadiness {
    Ready,
    Backpressured,
    Unavailable,
}

impl GfxTransport {
    pub(crate) fn new(log: LogEmitter) -> Self {
        Self {
            state: Arc::new(Mutex::new(GfxState {
                sender: None,
                handle: None,
                surface: None,
            })),
            log,
        }
    }

    pub(crate) fn factory(&self) -> EgfxFactory {
        EgfxFactory {
            state: self.state.clone(),
            log: self.log.clone(),
        }
    }

    /// Check before beginning a hardware encode. This inexpensive gate means
    /// no CPU/GPU work is spent for an unready client or one whose ACK window
    /// is already full.
    pub(crate) fn readiness(&self) -> GfxReadiness {
        let Ok(state) = self.state.lock() else {
            return GfxReadiness::Unavailable;
        };
        let Some(handle) = &state.handle else {
            return GfxReadiness::Unavailable;
        };
        let Ok(server) = handle.lock() else {
            return GfxReadiness::Unavailable;
        };
        if !server.is_ready() || !server.supports_avc420() {
            GfxReadiness::Unavailable
        } else if server.should_backpressure() {
            GfxReadiness::Backpressured
        } else {
            GfxReadiness::Ready
        }
    }

    pub(crate) fn send_avc420(&self, frame: &Frame, h264: &[u8]) -> GfxSubmit {
        let (handle, sender, surface) = {
            let Ok(state) = self.state.lock() else {
                return GfxSubmit::Unavailable;
            };
            let (Some(handle), Some(sender)) = (&state.handle, &state.sender) else {
                return GfxSubmit::Unavailable;
            };
            (handle.clone(), sender.clone(), state.surface)
        };

        let Ok(mut server) = handle.lock() else {
            return GfxSubmit::Unavailable;
        };
        if !server.is_ready() || !server.supports_avc420() {
            return GfxSubmit::Unavailable;
        }
        if server.should_backpressure() {
            return GfxSubmit::Backpressured;
        }

        let surface = match surface
            .filter(|surface| surface.width == frame.width && surface.height == frame.height)
        {
            Some(surface) => surface,
            None => {
                if let Some(previous) = surface {
                    // A mode change must not leave an obsolete surface mapped
                    // in the client compositor. Remove it before mapping the
                    // new dimensions so repeated display changes stay bounded.
                    server.delete_surface(previous.id);
                }
                server.set_output_dimensions(frame.width, frame.height);
                let Some(id) = server.create_surface(frame.width, frame.height) else {
                    return GfxSubmit::Unavailable;
                };
                if !server.map_surface_to_output(id, 0, 0) {
                    return GfxSubmit::Unavailable;
                }
                let surface = GfxSurface {
                    id,
                    width: frame.width,
                    height: frame.height,
                };
                if let Ok(mut state) = self.state.lock() {
                    state.surface = Some(surface);
                }
                surface
            }
        };

        let region = Avc420Region::full_frame(frame.width, frame.height, 26);
        let timestamp_ms = frame.captured_at.elapsed().as_millis() as u32;
        if server
            .send_avc420_frame(surface.id, h264, &[region], timestamp_ms)
            .is_none()
        {
            return GfxSubmit::Backpressured;
        }
        let Some(channel_id) = server.channel_id() else {
            return GfxSubmit::Unavailable;
        };
        let messages = match encode_dvc_messages(
            channel_id,
            server.drain_output(),
            ChannelFlags::SHOW_PROTOCOL,
        ) {
            Ok(messages) => messages,
            Err(error) => {
                tracing::warn!("RDP EGFX output encoding failed; using bitmap updates: {error}");
                return GfxSubmit::Unavailable;
            }
        };
        drop(server);

        if sender
            .send(ServerEvent::Egfx(EgfxServerMessage::SendMessages {
                messages,
            }))
            .is_err()
        {
            return GfxSubmit::Unavailable;
        }
        GfxSubmit::Sent
    }
}

/// Factory installed into IronRDP. A fresh graphics server is created for each
/// RDP connection; retaining the previous surface or ACK state across clients
/// would be protocol-invalid and could cause a new session to start stale.
pub(crate) struct EgfxFactory {
    state: Arc<Mutex<GfxState>>,
    log: LogEmitter,
}

impl ServerEventSender for EgfxFactory {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        if let Ok(mut state) = self.state.lock() {
            state.sender = Some(sender);
        }
    }
}

impl GfxServerFactory for EgfxFactory {
    fn build_gfx_handler(&self) -> Box<dyn GraphicsPipelineHandler> {
        Box::new(EgfxHandler {
            log: self.log.clone(),
        })
    }

    fn build_server_with_handle(&self) -> Option<(GfxDvcBridge, GfxServerHandle)> {
        let server = Arc::new(Mutex::new(GraphicsPipelineServer::new(
            self.build_gfx_handler(),
        )));
        if let Ok(mut state) = self.state.lock() {
            state.handle = Some(server.clone());
            state.surface = None;
        }
        Some((GfxDvcBridge::new(server.clone()), server))
    }
}

struct EgfxHandler {
    log: LogEmitter,
}

impl GraphicsPipelineHandler for EgfxHandler {
    fn capabilities_advertise(&mut self, _pdu: &CapabilitiesAdvertisePdu) {}

    fn on_ready(&mut self, _negotiated: &CapabilitySet) {
        self.log
            .line("RDP EGFX channel negotiated; enabling AVC420 hardware video when supported");
    }

    fn on_frame_ack(&mut self, _frame_id: u32, queue_depth: u32) {
        tracing::trace!(queue_depth, "RDP EGFX frame acknowledged");
    }

    fn on_close(&mut self) {
        self.log
            .line("RDP EGFX channel closed; returning to bitmap updates");
    }

    fn max_frames_in_flight(&self) -> u32 {
        MAX_FRAMES_IN_FLIGHT
    }
}

/// Per-client VideoToolbox H.264 encoder. It stays inside the display updater
/// (and its dedicated RDP runtime thread), rather than the capture callback or
/// shared EGFX lock, so the capture source never waits for codec work.
pub(crate) struct H264Encoder {
    session: CFRetained<VTCompressionSession>,
    callback_state: Arc<EncoderCallbackState>,
    width: u16,
    height: u16,
    next_timestamp: i64,
}

struct EncoderCallbackState {
    sender: Mutex<Option<std::sync::mpsc::SyncSender<anyhow::Result<Vec<u8>>>>>,
}

// `RdpServerDisplayUpdates` requires a `Send` future even though Taomni runs
// this server on one dedicated current-thread runtime. VideoToolbox sessions
// are explicitly driven serially by that updater; we never share a session or
// use it concurrently. Moving the owning updater before its first poll is
// therefore safe, while declaring `Sync` would not be.
unsafe impl Send for H264Encoder {}

impl H264Encoder {
    pub(crate) fn new(width: u16, height: u16) -> anyhow::Result<Self> {
        let callback_state = Arc::new(EncoderCallbackState {
            sender: Mutex::new(None),
        });
        let mut raw = ptr::null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                i32::from(width),
                i32::from(height),
                kCMVideoCodecType_H264,
                None,
                None,
                None,
                Some(on_h264_encoded),
                Arc::as_ptr(&callback_state).cast_mut().cast(),
                NonNull::from(&mut raw),
            )
        };
        ensure_status(status, "create VideoToolbox H.264 encoder")?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| anyhow::anyhow!("VideoToolbox returned a null H.264 session"))?;
        let session = unsafe { CFRetained::from_raw(raw) };

        // Disable B-frame reordering and request real-time scheduling. Both
        // properties are essential for remote-control latency, and failure is
        // surfaced so the caller can safely use the regular bitmap channel.
        let vt_session = unsafe { compression_as_vt_session(&session) };
        ensure_status(
            unsafe {
                VTSessionSetProperty(
                    vt_session,
                    kVTCompressionPropertyKey_RealTime,
                    Some(CFBoolean::new(true).as_ref()),
                )
            },
            "enable VideoToolbox real-time encoding",
        )?;
        ensure_status(
            unsafe {
                VTSessionSetProperty(
                    vt_session,
                    kVTCompressionPropertyKey_AllowFrameReordering,
                    Some(CFBoolean::new(false).as_ref()),
                )
            },
            "disable VideoToolbox frame reordering",
        )?;
        ensure_status(
            unsafe { session.prepare_to_encode_frames() },
            "prepare VideoToolbox H.264 encoder",
        )?;

        Ok(Self {
            session,
            callback_state,
            width,
            height,
            next_timestamp: 0,
        })
    }

    pub(crate) fn matches(&self, frame: &Frame) -> bool {
        self.width == frame.width && self.height == frame.height
    }

    pub(crate) fn encode(&mut self, frame: &mut Frame) -> anyhow::Result<Vec<u8>> {
        if !self.matches(frame) {
            anyhow::bail!("H.264 encoder dimensions no longer match captured frame");
        }
        let base_address = NonNull::new(frame.data.as_mut_ptr().cast::<c_void>())
            .ok_or_else(|| anyhow::anyhow!("cannot encode an empty captured frame"))?;
        let mut raw_pixel_buffer = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferCreateWithBytes(
                None,
                usize::from(frame.width),
                usize::from(frame.height),
                kCVPixelFormatType_32BGRA,
                base_address,
                frame.stride,
                None,
                ptr::null_mut(),
                None,
                NonNull::from(&mut raw_pixel_buffer),
            )
        };
        if status != kCVReturnSuccess {
            anyhow::bail!("VideoToolbox input pixel buffer creation failed (status {status})");
        }
        let raw_pixel_buffer = NonNull::new(raw_pixel_buffer)
            .ok_or_else(|| anyhow::anyhow!("CoreVideo returned a null pixel buffer"))?;
        let pixel_buffer = unsafe { CFRetained::from_raw(raw_pixel_buffer) };

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        *self
            .callback_state
            .sender
            .lock()
            .map_err(|_| anyhow::anyhow!("VideoToolbox callback state lock poisoned"))? =
            Some(sender);

        self.next_timestamp = self.next_timestamp.saturating_add(1);
        let timestamp = unsafe { CMTime::new(self.next_timestamp, 30) };
        let image_buffer = unsafe { pixel_buffer_as_image_buffer(&pixel_buffer) };
        let duration = unsafe { kCMTimeInvalid };
        ensure_status(
            unsafe {
                self.session.encode_frame(
                    image_buffer,
                    timestamp,
                    duration,
                    None,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            "submit VideoToolbox H.264 frame",
        )?;
        ensure_status(
            unsafe { self.session.complete_frames(timestamp) },
            "complete VideoToolbox H.264 frame",
        )?;
        let result = receiver
            .recv_timeout(ENCODE_TIMEOUT)
            .map_err(|error| match error {
                std::sync::mpsc::RecvTimeoutError::Timeout => {
                    anyhow::anyhow!("VideoToolbox H.264 frame exceeded the 250ms latency budget")
                }
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    anyhow::anyhow!("VideoToolbox H.264 output callback disconnected")
                }
            });
        if let Ok(mut sender) = self.callback_state.sender.lock() {
            sender.take();
        }
        result?
    }
}

unsafe extern "C-unwind" fn on_h264_encoded(
    output_callback_ref_con: *mut c_void,
    _source_frame_ref_con: *mut c_void,
    status: i32,
    _info_flags: objc2_video_toolbox::VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    if output_callback_ref_con.is_null() {
        return;
    }
    let state = unsafe { &*output_callback_ref_con.cast::<EncoderCallbackState>() };
    let result = if status != 0 {
        Err(anyhow::anyhow!(
            "VideoToolbox H.264 frame encoding failed (status {status})"
        ))
    } else if sample.is_null() {
        Err(anyhow::anyhow!("VideoToolbox dropped an H.264 frame"))
    } else {
        unsafe { sample_to_avcc(&*sample) }
    };
    if let Ok(sender) = state.sender.lock() {
        if let Some(sender) = sender.as_ref() {
            let _ = sender.send(result);
        }
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
    }
}

fn ensure_status(status: i32, operation: &str) -> anyhow::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        anyhow::bail!("{operation} failed (status {status})")
    }
}

/// VideoToolbox's APIs model all session variants as `VTSession` (CFType),
/// while the compression API returns its concrete opaque subtype. The cast is
/// the documented C ABI relationship and does not change ownership.
unsafe fn compression_as_vt_session(session: &CFRetained<VTCompressionSession>) -> &VTSession {
    unsafe { &*(session.as_ref() as *const VTCompressionSession).cast::<VTSession>() }
}

/// CVPixelBuffer is a CVImageBuffer subtype in the CoreVideo C ABI.
unsafe fn pixel_buffer_as_image_buffer(pixel_buffer: &CFRetained<CVPixelBuffer>) -> &CVImageBuffer {
    unsafe { &*(pixel_buffer.as_ref() as *const CVPixelBuffer).cast::<CVImageBuffer>() }
}

unsafe fn sample_to_avcc(sample: &CMSampleBuffer) -> anyhow::Result<Vec<u8>> {
    let block: CFRetained<CMBlockBuffer> = unsafe { sample.data_buffer() }
        .ok_or_else(|| anyhow::anyhow!("VideoToolbox returned H.264 without a data buffer"))?;
    let data_length = unsafe { block.data_length() };
    let mut h264 = vec![0; data_length];
    if data_length > 0 {
        let destination = NonNull::new(h264.as_mut_ptr().cast::<c_void>())
            .ok_or_else(|| anyhow::anyhow!("cannot copy an empty H.264 data buffer"))?;
        ensure_status(
            unsafe { block.copy_data_bytes(0, data_length, destination) },
            "copy VideoToolbox H.264 data",
        )?;
    }

    // VideoToolbox emits AVCC slices but stores SPS/PPS in the sample's format
    // description. Prefix the parameter sets on every frame: the cost is tiny,
    // while it makes each freshly-created RDP EGFX surface independently
    // decodable and avoids a stale decoder after a client reconnect.
    let description = unsafe { sample.format_description() }
        .ok_or_else(|| anyhow::anyhow!("VideoToolbox H.264 sample has no format description"))?;
    let mut count = 0;
    ensure_status(
        unsafe {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                &description,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut count,
                ptr::null_mut(),
            )
        },
        "read VideoToolbox H.264 parameter-set count",
    )?;

    let mut output = Vec::with_capacity(h264.len().saturating_add(128));
    for index in 0..count {
        let mut pointer = ptr::null();
        let mut length = 0;
        ensure_status(
            unsafe {
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    &description,
                    index,
                    &mut pointer,
                    &mut length,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            "read VideoToolbox H.264 parameter set",
        )?;
        let length = u32::try_from(length)
            .map_err(|_| anyhow::anyhow!("VideoToolbox H.264 parameter set is too large"))?;
        let parameter_set = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(parameter_set);
    }
    output.append(&mut h264);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{H264Encoder, MAX_FRAMES_IN_FLIGHT};
    use crate::servers::rdp::capture::Frame;

    #[test]
    fn graphics_path_keeps_only_a_two_frame_ack_window() {
        assert_eq!(MAX_FRAMES_IN_FLIGHT, 2);
    }

    #[test]
    fn video_toolbox_emits_an_avcc_frame() {
        // 16x16 is the smallest broadly-supported H.264 test surface. This
        // exercises the actual macOS hardware/software codec path without
        // requiring Screen Recording permission or a live RDP client.
        let mut frame = Frame::bgra(vec![0x80; 16 * 16 * 4], 0, 0, 16, 16, 16 * 4);
        let mut encoder = H264Encoder::new(16, 16).expect("create VideoToolbox encoder");
        let avcc = encoder
            .encode(&mut frame)
            .expect("encode VideoToolbox frame");

        // Every output begins with a 32-bit AVCC NAL length. Parameter sets
        // are deliberately prefixed by `sample_to_avcc`, making a new EGFX
        // surface independently decodable.
        assert!(avcc.len() > 4);
        let first_nal_length = u32::from_be_bytes(avcc[..4].try_into().unwrap()) as usize;
        assert!(first_nal_length > 0);
        assert!(avcc.len() >= 4 + first_nal_length);
    }
}
