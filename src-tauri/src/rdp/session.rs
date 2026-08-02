//! IronRDP-backed active RDP session driver.
//!
//! This replaces the earlier post-negotiation placeholder with the real
//! IronRDP connection sequence: X.224 negotiation, TLS upgrade, CredSSP/NLA,
//! MCS/channel/capability exchange, active-stage display decoding, and
//! fast-path keyboard/mouse input.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Once};

use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, ClipboardPdu, FileContentsFlags, FileContentsRequest,
    FileContentsResponse, FileDescriptor as IronClipboardFileDescriptor, FormatDataRequest,
    FormatDataResponse, LockDataId, OwnedFormatDataResponse, PackedFileList,
};
use ironrdp::connector::connection_activation::{
    ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::{self, Credentials, Sequence};
use ironrdp::core::{AsAny, IntoOwned, WriteBuf};
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{
    Database as InputDatabase, MouseButton, MousePosition, Operation, Scancode, WheelRotations,
};
use ironrdp::pdu::Action;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags as IronPerformanceFlags, TimezoneInfo};
use ironrdp::pdu::rdp::headers::ShareDataPdu;
use ironrdp::pdu::rdp::refresh_rectangle::RefreshRectanglePdu;
use ironrdp::rdpsnd::client::{Rdpsnd, RdpsndClientHandler};
use ironrdp::rdpsnd::pdu::{
    AudioFormat as IronAudioFormat, PitchPdu, VolumePdu, WaveFormat as IronWaveFormat,
};
use ironrdp::session::image::DecodedImage as IronDecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput};
use ironrdp::svc::{ChannelFlags, SvcMessage, SvcProcessorMessages};
use ironrdp_tokio::{Framed, FramedRead, FramedWrite};
use serde_json::json;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::rdp::RdpOptions;
use crate::rdp::frame::{DecodedTile, TileHeader};
use crate::rdp::input::{KeyEvent, PointerEvent, PointerWheelEvent};
use crate::rdp::transport::{RdpStream, open_transport};
use crate::rdp::ws::{RdpControl, channel, frame_payload_with_header};
use crate::terminal::network::NetworkSettings;

/// Output yielded from the session toward the WS layer.
pub enum SessionOutput {
    Channel { tag: u8, payload: Vec<u8> },
    Text(String),
}

enum ActiveOutputFlow {
    Continue,
    Terminate,
    Reactivate(ConnectionActivationSequence),
}

pub struct RdpSessionHandle {
    /// Receives outgoing frames produced by the session worker.
    out_rx: UnboundedReceiver<SessionOutput>,
    /// Sends control input from the relay into the session worker.
    ctrl_tx: UnboundedSender<RdpControl>,
}

pub struct RdpSessionConfig {
    pub stream: RdpStream,
    pub local_addr: std::net::SocketAddr,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub options: RdpOptions,
    pub network: Option<NetworkSettings>,
}

struct RdpConnectionSettings {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options: RdpOptions,
    network: Option<NetworkSettings>,
}

struct RdpSessionTransport {
    stream: RdpStream,
    local_addr: std::net::SocketAddr,
}

enum SessionRunOutcome {
    Closed,
    Reconnect { width: u16, height: u16 },
}

enum ControlOutcome {
    Continue,
    Disconnect,
    Reconnect { width: u16, height: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RdpConnectionTestResult {
    pub width: u16,
    pub height: u16,
    pub protocol: String,
    pub server_name: String,
}

const AUDIO_SAMPLE_RATE: u32 = 44_100;
const AUDIO_CHANNELS: u16 = 2;
const AUDIO_BITS_PER_SAMPLE: u16 = 16;
const CLIPRDR_FILE_LIST_FORMAT_VALUE: u32 = 0x0000_C006;
const MAX_CLIPBOARD_FILE_ITEMS: usize = 4096;
const REMOTE_FILE_CHUNK_SIZE: u32 = 1024 * 1024;

impl RdpSessionHandle {
    pub fn new() -> (
        Self,
        UnboundedSender<SessionOutput>,
        UnboundedReceiver<RdpControl>,
    ) {
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
        (Self { out_rx, ctrl_tx }, out_tx, ctrl_rx)
    }

    pub async fn next_outgoing(&mut self) -> Option<SessionOutput> {
        self.out_rx.recv().await
    }

    pub async fn dispatch_control(&self, ctrl: RdpControl) -> Result<(), String> {
        self.ctrl_tx
            .send(ctrl)
            .map_err(|_| "rdp session: ctrl channel closed".to_string())
    }
}

pub fn start_ironrdp_session(cfg: RdpSessionConfig) -> RdpSessionHandle {
    let (handle, out_tx, ctrl_rx) = RdpSessionHandle::new();
    tokio::spawn(async move {
        if let Err(e) = drive_ironrdp_session(cfg, out_tx.clone(), ctrl_rx).await {
            send_error(&out_tx, "rdp-session", &e);
        }
    });
    handle
}

pub async fn test_ironrdp_connection(
    cfg: RdpSessionConfig,
    timeout: std::time::Duration,
) -> Result<RdpConnectionTestResult, String> {
    let mut handle = start_ironrdp_session(cfg);
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let _ = handle.dispatch_control(RdpControl::Disconnect).await;
            return Err("RDP test timed out before the session reached connected state".into());
        }

        let output = tokio::time::timeout(remaining, handle.next_outgoing())
            .await
            .map_err(|_| {
                "RDP test timed out before the session reached connected state".to_string()
            })?
            .ok_or_else(|| {
                "RDP test ended before the session reached connected state".to_string()
            })?;

        match output {
            SessionOutput::Text(text) => {
                if let Some(result) = parse_connected_event(&text)? {
                    let _ = handle.dispatch_control(RdpControl::Disconnect).await;
                    return Ok(result);
                }
            }
            SessionOutput::Channel { .. } => {}
        }
    }
}

#[derive(Clone)]
struct ClipboardBridge {
    state: Arc<Mutex<ClipboardBridgeState>>,
    out_tx: UnboundedSender<SessionOutput>,
}

struct ClipboardBridgeState {
    local_text: Option<String>,
    local_files: Vec<LocalClipboardFile>,
    pending_remote_format: Option<ClipboardFormatId>,
    remote_file_transfer: Option<RemoteFileTransfer>,
    actions: VecDeque<ClipboardAction>,
    ready: bool,
    negotiated_capabilities: ClipboardGeneralCapabilityFlags,
}

enum ClipboardAction {
    AdvertiseFormats(Vec<ClipboardFormat>),
    RequestRemoteData(ClipboardFormatId),
    RequestRemoteFileContents(Vec<FileContentsRequest>),
    SubmitFormatData(OwnedFormatDataResponse),
    SubmitFileContents(FileContentsResponse<'static>),
}

#[derive(Clone, Debug)]
struct LocalClipboardFile {
    path: PathBuf,
    name: String,
    size: u64,
    is_directory: bool,
    attributes: ClipboardFileAttributes,
}

#[derive(Clone, Debug)]
struct RemoteClipboardFile {
    path: PathBuf,
    size: u64,
    is_directory: bool,
}

#[derive(Clone, Debug)]
struct RemoteFileStream {
    index: usize,
    position: u64,
}

#[derive(Debug)]
struct RemoteFileTransfer {
    files: Vec<RemoteClipboardFile>,
    top_level_paths: Vec<PathBuf>,
    streams: HashMap<u32, RemoteFileStream>,
    next_stream_id: u32,
}

struct TaomniCliprdrBackend {
    bridge: ClipboardBridge,
    temporary_directory: String,
}

struct RdpsndWsBackend {
    out_tx: UnboundedSender<SessionOutput>,
    formats: Vec<IronAudioFormat>,
}

impl ClipboardBridge {
    fn new(out_tx: UnboundedSender<SessionOutput>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ClipboardBridgeState {
                local_text: None,
                local_files: Vec::new(),
                pending_remote_format: None,
                remote_file_transfer: None,
                actions: VecDeque::new(),
                ready: false,
                negotiated_capabilities: ClipboardGeneralCapabilityFlags::empty(),
            })),
            out_tx,
        }
    }

    fn backend(&self) -> TaomniCliprdrBackend {
        let temporary_directory = std::env::temp_dir()
            .join("taomni-rdp-cliprdr")
            .to_string_lossy()
            .into_owned();
        TaomniCliprdrBackend {
            bridge: self.clone(),
            temporary_directory,
        }
    }

    fn set_local_text(&self, text: String) {
        if let Ok(mut state) = self.state.lock() {
            state.local_text = Some(text);
            state.local_files.clear();
        }
    }

    fn set_local_files(&self, files: Vec<LocalClipboardFile>) {
        if let Ok(mut state) = self.state.lock() {
            state.local_text = None;
            state.local_files = files;
        }
    }

    fn local_formats(&self) -> Vec<ClipboardFormat> {
        match self.state.lock() {
            Ok(state)
                if state
                    .local_text
                    .as_ref()
                    .is_some_and(|text| !text.is_empty()) =>
            {
                vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]
            }
            Ok(state) if !state.local_files.is_empty() => vec![file_list_clipboard_format()],
            _ => Vec::new(),
        }
    }

    fn drain_actions(&self) -> Vec<ClipboardAction> {
        match self.state.lock() {
            Ok(mut state) => state.actions.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn queue_action(&self, action: ClipboardAction) {
        if let Ok(mut state) = self.state.lock() {
            state.actions.push_back(action);
        }
    }

    fn local_text(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.local_text.clone())
    }

    fn local_file_list_response(&self) -> OwnedFormatDataResponse {
        let files = match self.state.lock() {
            Ok(state) => state.local_files.clone(),
            Err(_) => Vec::new(),
        };
        if files.is_empty() {
            return FormatDataResponse::new_error().into_owned();
        }
        let list = PackedFileList {
            files: files
                .into_iter()
                .map(|file| {
                    let descriptor = IronClipboardFileDescriptor::new(file.name)
                        .with_attributes(file.attributes);
                    if file.is_directory {
                        descriptor
                    } else {
                        descriptor.with_file_size(file.size)
                    }
                })
                .collect(),
        };
        FormatDataResponse::new_file_list(&list)
            .map(IntoOwned::into_owned)
            .unwrap_or_else(|_| FormatDataResponse::new_error().into_owned())
    }

    fn local_file_contents_response(
        &self,
        request: &FileContentsRequest,
    ) -> FileContentsResponse<'static> {
        let file = match self.state.lock() {
            Ok(state) => state.local_files.get(request.index as usize).cloned(),
            Err(_) => None,
        };
        let Some(file) = file else {
            return FileContentsResponse::new_error(request.stream_id);
        };
        if request.flags.contains(FileContentsFlags::SIZE) {
            return FileContentsResponse::new_size_response(request.stream_id, file.size);
        }
        if !request.flags.contains(FileContentsFlags::RANGE) || file.is_directory {
            return FileContentsResponse::new_error(request.stream_id);
        }
        read_clipboard_file_range(&file.path, request.position, request.requested_size)
            .map(|data| FileContentsResponse::new_data_response(request.stream_id, data))
            .unwrap_or_else(|_| FileContentsResponse::new_error(request.stream_id))
    }

    fn start_remote_file_receive(&self, list: PackedFileList) {
        match build_remote_file_transfer(list) {
            Ok((transfer, requests)) => {
                if requests.is_empty() {
                    let completed_paths = transfer.top_level_paths.clone();
                    if completed_paths.is_empty() {
                        self.send_clipboard_status(
                            "clipboard-remote-files-empty",
                            "Remote clipboard did not contain any file paths.",
                        );
                    } else {
                        self.finish_remote_file_receive(completed_paths);
                    }
                    return;
                }
                if let Ok(mut state) = self.state.lock() {
                    state
                        .actions
                        .push_back(ClipboardAction::RequestRemoteFileContents(requests));
                    state.remote_file_transfer = Some(transfer);
                }
            }
            Err(e) => self.send_clipboard_status(
                "clipboard-remote-files-error",
                &format!("Remote file clipboard could not be staged: {}", e),
            ),
        }
    }

    fn handle_remote_file_contents_response(&self, response: FileContentsResponse<'_>) {
        let stream_id = response.stream_id();
        let data = response.data().to_vec();
        let mut next_request = None;
        let mut completed_paths = None;
        let mut error = None;

        if let Ok(mut state) = self.state.lock() {
            let Some(transfer) = state.remote_file_transfer.as_mut() else {
                error = Some(format!("unexpected remote file stream {}", stream_id));
                drop(state);
                self.send_clipboard_status("clipboard-remote-files-error", &error.unwrap());
                return;
            };
            let Some(stream) = transfer.streams.remove(&stream_id) else {
                error = Some(format!("unknown remote file stream {}", stream_id));
                drop(state);
                self.send_clipboard_status("clipboard-remote-files-error", &error.unwrap());
                return;
            };
            let Some(file) = transfer.files.get(stream.index).cloned() else {
                error = Some(format!("remote file index {} is unavailable", stream.index));
                drop(state);
                self.send_clipboard_status("clipboard-remote-files-error", &error.unwrap());
                return;
            };

            if !file.is_directory && !data.is_empty() {
                if let Err(e) = write_remote_file_chunk(&file.path, stream.position, &data) {
                    error = Some(e);
                }
            }

            let new_position = stream.position.saturating_add(data.len() as u64);
            if error.is_none() && !file.is_directory && new_position < file.size && !data.is_empty()
            {
                let request = next_remote_file_request(transfer, stream.index, new_position);
                next_request = Some(request);
            }

            if let Some(request) = next_request.clone() {
                state
                    .actions
                    .push_back(ClipboardAction::RequestRemoteFileContents(vec![request]));
            } else if transfer.streams.is_empty() {
                completed_paths = Some(transfer.top_level_paths.clone());
                state.remote_file_transfer = None;
            }
        }

        if let Some(e) = error {
            self.send_clipboard_status(
                "clipboard-remote-files-error",
                &format!("Remote file clipboard transfer failed: {}", e),
            );
            return;
        }
        if let Some(paths) = completed_paths {
            self.finish_remote_file_receive(paths);
        }
    }

    fn finish_remote_file_receive(&self, paths: Vec<PathBuf>) {
        let text = crate::rdp::cliprdr::paths_to_uri_list(&paths);
        let string_paths: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        send_text(
            &self.out_tx,
            json!({
                "type": "clipboard_files",
                "paths": string_paths,
                "text": text,
            })
            .to_string(),
        );
        self.send_clipboard_status(
            "clipboard-remote-files-ready",
            "Remote clipboard files were staged locally.",
        );
    }

    fn queue_remote_request(&self, format: ClipboardFormatId) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_remote_format = Some(format);
            state
                .actions
                .push_back(ClipboardAction::RequestRemoteData(format));
        }
    }

    fn take_pending_remote_format(&self) -> Option<ClipboardFormatId> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_remote_format.take())
    }

    fn send_clipboard_text(&self, text: String) {
        send_text(
            &self.out_tx,
            json!({
                "type": "clipboard",
                "text": text,
            })
            .to_string(),
        );
    }

    fn send_clipboard_status(&self, stage: &str, detail: &str) {
        send_status(&self.out_tx, stage, detail);
    }
}

impl RdpsndWsBackend {
    fn new(out_tx: UnboundedSender<SessionOutput>) -> Self {
        Self {
            out_tx,
            formats: vec![IronAudioFormat {
                format: IronWaveFormat::PCM,
                n_channels: AUDIO_CHANNELS,
                n_samples_per_sec: AUDIO_SAMPLE_RATE,
                n_avg_bytes_per_sec: AUDIO_SAMPLE_RATE
                    * u32::from(AUDIO_CHANNELS)
                    * u32::from(AUDIO_BITS_PER_SAMPLE / 8),
                n_block_align: AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8),
                bits_per_sample: AUDIO_BITS_PER_SAMPLE,
                data: None,
            }],
        }
    }
}

impl std::fmt::Debug for ClipboardBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClipboardBridge").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for TaomniCliprdrBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaomniCliprdrBackend")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for RdpsndWsBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RdpsndWsBackend")
            .field("formats", &self.formats)
            .finish_non_exhaustive()
    }
}

impl AsAny for TaomniCliprdrBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl CliprdrBackend for TaomniCliprdrBackend {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
    }

    fn on_ready(&mut self) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state.ready = true;
        }
        self.bridge
            .send_clipboard_status("clipboard-ready", "RDP clipboard channel is ready.");
    }

    fn on_request_format_list(&mut self) {
        self.bridge.queue_action(ClipboardAction::AdvertiseFormats(
            self.bridge.local_formats(),
        ));
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state.negotiated_capabilities = capabilities;
        }
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if let Some(format) = available_formats
            .iter()
            .map(ClipboardFormat::id)
            .find(|id| *id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.bridge.queue_remote_request(format);
            return;
        }

        if let Some(format) = available_formats
            .iter()
            .find(|format| {
                format
                    .name()
                    .is_some_and(|name| name.value().eq_ignore_ascii_case("FileGroupDescriptorW"))
            })
            .map(ClipboardFormat::id)
        {
            self.bridge.queue_remote_request(format);
            return;
        }

        self.bridge.send_clipboard_status(
            "clipboard-unsupported-format",
            "Remote clipboard changed, but no Unicode text or file-list format was advertised.",
        );
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
            self.bridge
                .local_text()
                .map(|text| FormatDataResponse::new_unicode_string(&text).into_owned())
                .unwrap_or_else(|| FormatDataResponse::new_error().into_owned())
        } else if request.format == file_list_clipboard_format_id() {
            self.bridge.local_file_list_response()
        } else {
            FormatDataResponse::new_error().into_owned()
        };
        self.bridge
            .queue_action(ClipboardAction::SubmitFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            self.bridge.send_clipboard_status(
                "clipboard-read-failed",
                "Remote clipboard data request failed.",
            );
            return;
        }
        match self.bridge.take_pending_remote_format() {
            Some(format) if format == ClipboardFormatId::CF_UNICODETEXT => {
                match response.to_unicode_string() {
                    Ok(text) => self.bridge.send_clipboard_text(text),
                    Err(e) => self.bridge.send_clipboard_status(
                        "clipboard-decode-failed",
                        &format!("Remote clipboard text could not be decoded: {}", e),
                    ),
                }
            }
            Some(_) => match response.to_file_list() {
                Ok(list) => self.bridge.start_remote_file_receive(list),
                Err(e) => self.bridge.send_clipboard_status(
                    "clipboard-decode-failed",
                    &format!("Remote clipboard file list could not be decoded: {}", e),
                ),
            },
            None => self.bridge.send_clipboard_status(
                "clipboard-decode-failed",
                "Remote clipboard response arrived without a tracked requested format.",
            ),
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = self.bridge.local_file_contents_response(&request);
        self.bridge
            .queue_action(ClipboardAction::SubmitFileContents(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        self.bridge.handle_remote_file_contents_response(response);
    }

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

impl RdpsndClientHandler for RdpsndWsBackend {
    fn get_formats(&self) -> &[IronAudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format_no: usize, ts: u32, data: Cow<'_, [u8]>) {
        let payload = audio_payload_with_header(format_no, ts, data.as_ref());
        let _ = self.out_tx.send(SessionOutput::Channel {
            tag: channel::AUDIO,
            payload,
        });
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {
        send_status(&self.out_tx, "audio-closed", "RDP audio channel closed.");
    }
}

async fn drive_ironrdp_session(
    cfg: RdpSessionConfig,
    out_tx: UnboundedSender<SessionOutput>,
    mut ctrl_rx: UnboundedReceiver<RdpControl>,
) -> Result<(), String> {
    install_rustls_crypto_provider();

    let RdpSessionConfig {
        stream,
        local_addr,
        host,
        port,
        username,
        password,
        options,
        network,
    } = cfg;
    let mut settings = RdpConnectionSettings {
        host,
        port,
        username,
        password,
        options,
        network,
    };
    let mut next_transport = Some(RdpSessionTransport { stream, local_addr });

    loop {
        let transport = match next_transport.take() {
            Some(transport) => transport,
            None => {
                let transport = open_transport(
                    &settings.host,
                    settings.port,
                    settings.network.as_ref(),
                    settings.options.gateway.as_ref(),
                )
                .await?;
                RdpSessionTransport {
                    stream: transport.stream,
                    local_addr: transport.local_addr,
                }
            }
        };

        match drive_ironrdp_connection(&settings, transport, out_tx.clone(), &mut ctrl_rx).await? {
            SessionRunOutcome::Closed => {
                send_text(
                    &out_tx,
                    json!({
                        "type": "disconnected",
                        "reason": "RDP session closed",
                    })
                    .to_string(),
                );
                return Ok(());
            }
            SessionRunOutcome::Reconnect { width, height } => {
                settings.options.screen_w = width;
                settings.options.screen_h = height;
                send_status(
                    &out_tx,
                    "reconnecting",
                    "Reconnecting the RDP session at the requested desktop size.",
                );
            }
        }
    }
}

async fn drive_ironrdp_connection(
    cfg: &RdpConnectionSettings,
    transport: RdpSessionTransport,
    out_tx: UnboundedSender<SessionOutput>,
    ctrl_rx: &mut UnboundedReceiver<RdpControl>,
) -> Result<SessionRunOutcome, String> {
    send_status(
        &out_tx,
        "tcp-connected",
        "TCP/proxy tunnel established; starting IronRDP connector.",
    );

    let config = build_ironrdp_config(cfg);

    let clipboard = cfg
        .options
        .redirect_clipboard
        .then(|| ClipboardBridge::new(out_tx.clone()));
    let mut connector = connector::ClientConnector::new(config, transport.local_addr);
    if let Some(clipboard) = &clipboard {
        connector.attach_static_channel(CliprdrClient::new(Box::new(clipboard.backend())));
    }
    let drive_channel =
        crate::rdp::rdpdr::build_drive_channel(&cfg.options.redirect_drive, Some(out_tx.clone()))?;
    let display_control_out = out_tx.clone();
    connector.attach_static_channel(DrdynvcClient::new().with_dynamic_channel(
        DisplayControlClient::new(move |caps| {
            tracing::debug!(?caps, "RDP display control capabilities received");
            send_status(
                &display_control_out,
                "display-control-ready",
                "RDP display control virtual channel is ready.",
            );
            Ok(Vec::new())
        }),
    ));
    let needs_rdpsnd_channel = cfg.options.redirect_audio == "play" || drive_channel.is_some();
    if needs_rdpsnd_channel {
        connector
            .attach_static_channel(Rdpsnd::new(Box::new(RdpsndWsBackend::new(out_tx.clone()))));
        if cfg.options.redirect_audio == "play" {
            send_status(
                &out_tx,
                "audio-enabled",
                "RDP audio playback channel requested.",
            );
        } else {
            send_status(
                &out_tx,
                "audio-helper-enabled",
                "RDPSND helper channel enabled for drive redirection.",
            );
        }
    }
    if let Some(rdpdr) = drive_channel {
        connector.attach_static_channel(rdpdr);
        send_status(
            &out_tx,
            "drive-enabled",
            "RDP drive redirection channel requested.",
        );
    }
    let mut framed = ironrdp_tokio::TokioFramed::new(transport.stream);

    send_status(&out_tx, "negotiating", "Negotiating RDP security protocol.");
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|e| format!("rdp negotiation failed: {}", e))?;

    send_status(&out_tx, "tls", "Upgrading the transport to TLS.");
    let stream = framed.into_inner_no_leftover();
    let verified = crate::rdp::tls::upgrade(
        stream,
        &cfg.host,
        cfg.port,
        cfg.options.certificate_fingerprint.as_deref(),
    )
    .await
    .map_err(|e| format!("rdp TLS upgrade failed: {}", e))?;
    send_status(
        &out_tx,
        if verified.used_pin {
            "tls-pinned"
        } else {
            "tls-verified"
        },
        &format!(
            "RDP certificate verified (SHA-256 {}).",
            crate::rdp::tls::format_fingerprint(&verified.fingerprint)
        ),
    );
    let server_public_key = verified.server_public_key;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = ironrdp_tokio::TokioFramed::new(verified.stream);
    let mut network_client = ironrdp_tokio::reqwest::ReqwestNetworkClient::new();

    send_status(&out_tx, "credssp", "Authenticating with CredSSP/NLA.");
    let connection_result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut network_client,
        cfg.host.clone().into(),
        server_public_key,
        None,
    )
    .await
    .map_err(|e| format!("rdp connection finalization failed: {}", e))?;

    let protocol = if cfg.options.nla {
        "CredSSP/NLA"
    } else {
        "TLS"
    };
    let server_name = cfg.host.clone();
    let width = connection_result.desktop_size.width;
    let height = connection_result.desktop_size.height;
    send_connected_event(&out_tx, width, height, protocol, &server_name);

    let mut image = IronDecodedImage::new(PixelFormat::RgbA32, width, height);
    let mut active_stage = ActiveStage::new(connection_result);
    let mut input_db = InputDatabase::new();
    let mut last_buttons = 0u8;
    let mut reactivation: Option<ConnectionActivationSequence> = None;

    loop {
        tokio::select! {
            ctrl = ctrl_rx.recv() => {
                let Some(ctrl) = ctrl else { break; };
                if reactivation.is_some() {
                    match ctrl {
                        RdpControl::Disconnect => break,
                        RdpControl::Ack => {}
                        _ => send_status(
                            &out_tx,
                            "reactivating",
                            "RDP session is reactivating after a desktop resize.",
                        ),
                    }
                    continue;
                }
                match handle_control(
                    ctrl,
                    &mut active_stage,
                    &mut image,
                    &mut input_db,
                    &mut last_buttons,
                    &mut framed,
                    &out_tx,
                    clipboard.as_ref(),
                    &mut reactivation,
                ).await? {
                    ControlOutcome::Continue => {}
                    ControlOutcome::Disconnect => break,
                    ControlOutcome::Reconnect { width, height } => {
                        return Ok(SessionRunOutcome::Reconnect { width, height });
                    }
                }
                if reactivation.is_none() {
                    if let Some(clipboard) = &clipboard {
                    drain_clipboard_actions(&mut active_stage, clipboard, &mut framed, &out_tx).await?;
                    }
                }
            }
            read = framed.read_pdu() => {
                let (action, payload) = read.map_err(|e| format!("rdp read frame: {}", e))?;
                if let Some(sequence) = reactivation.as_mut() {
                    if matches!(action, Action::X224) {
                        if process_reactivation_frame(
                            sequence,
                            &payload,
                            &mut active_stage,
                            &mut image,
                            &mut framed,
                            &out_tx,
                            protocol,
                            &server_name,
                        )
                        .await?
                        {
                            reactivation = None;
                            if let Some(clipboard) = &clipboard {
                                drain_clipboard_actions(&mut active_stage, clipboard, &mut framed, &out_tx).await?;
                            }
                        }
                    } else {
                        tracing::debug!("ignoring fast-path frame while RDP session reactivates");
                    }
                    continue;
                }
                let outputs = active_stage
                    .process(&mut image, action, &payload)
                    .map_err(|e| format!("rdp active stage: {}", e))?;
                match handle_active_outputs(&mut framed, &image, outputs, &out_tx).await? {
                    ActiveOutputFlow::Continue => {}
                    ActiveOutputFlow::Terminate => break,
                    ActiveOutputFlow::Reactivate(sequence) => {
                        reactivation = Some(sequence);
                    }
                }
                if reactivation.is_none() {
                    if let Some(clipboard) = &clipboard {
                        drain_clipboard_actions(&mut active_stage, clipboard, &mut framed, &out_tx).await?;
                    }
                }
            }
        }
    }

    Ok(SessionRunOutcome::Closed)
}

async fn handle_control<S>(
    ctrl: RdpControl,
    active_stage: &mut ActiveStage,
    image: &mut IronDecodedImage,
    input_db: &mut InputDatabase,
    last_buttons: &mut u8,
    framed: &mut Framed<S>,
    out_tx: &UnboundedSender<SessionOutput>,
    clipboard: Option<&ClipboardBridge>,
    reactivation: &mut Option<ConnectionActivationSequence>,
) -> Result<ControlOutcome, String>
where
    S: FramedRead + FramedWrite,
{
    match ctrl {
        RdpControl::Disconnect => return Ok(ControlOutcome::Disconnect),
        RdpControl::Ack => return Ok(ControlOutcome::Continue),
        RdpControl::Key(key) => {
            let events = input_db.apply(key_operations(key));
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp key input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate(sequence) => *reactivation = Some(sequence),
            }
        }
        RdpControl::Pointer(pointer) => {
            let ops = pointer_operations(pointer, last_buttons);
            let events = input_db.apply(ops);
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp pointer input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate(sequence) => *reactivation = Some(sequence),
            }
        }
        RdpControl::Wheel(wheel) => {
            let events = input_db.apply(wheel_operations(wheel));
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp wheel input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate(sequence) => *reactivation = Some(sequence),
            }
        }
        RdpControl::Resize { width, height } => {
            let width = normalize_width(width);
            let height = height.clamp(200, 8192);
            if width == image.width() && height == image.height() {
                return Ok(ControlOutcome::Continue);
            }
            match active_stage.encode_resize(u32::from(width), u32::from(height), None, None) {
                Some(Ok(frame)) => {
                    framed
                        .write_all(&frame)
                        .await
                        .map_err(|e| format!("rdp resize write: {}", e))?;
                }
                Some(Err(e)) => return Err(format!("rdp resize: {}", e)),
                None => {
                    send_status(
                        out_tx,
                        "resize-reconnect",
                        "Display Control is unavailable; reconnecting at the requested desktop size.",
                    );
                    return Ok(ControlOutcome::Reconnect { width, height });
                }
            }
        }
        RdpControl::Refresh => {
            request_full_refresh(active_stage, image, framed, out_tx).await?;
        }
        RdpControl::ClipboardOffer { .. } => {
            send_status(
                out_tx,
                "clipboard-offer-ignored",
                "Clipboard offers are driven by text data.",
            );
        }
        RdpControl::ClipboardData { format, data } => {
            let Some(clipboard) = clipboard else {
                send_status(
                    out_tx,
                    "clipboard-disabled",
                    "RDP clipboard redirection is disabled.",
                );
                return Ok(ControlOutcome::Continue);
            };
            if format != ClipboardFormatId::CF_UNICODETEXT.value() {
                send_status(
                    out_tx,
                    "clipboard-unsupported-format",
                    "Only Unicode text clipboard is wired.",
                );
                return Ok(ControlOutcome::Continue);
            }
            let text =
                String::from_utf8(data).map_err(|e| format!("rdp clipboard text utf8: {}", e))?;
            clipboard.set_local_text(text);
            advertise_clipboard_formats(
                active_stage,
                clipboard.local_formats(),
                framed,
                out_tx,
                "clipboard-local-copy",
            )
            .await?;
        }
        RdpControl::ClipboardFiles { paths } => {
            let Some(clipboard) = clipboard else {
                send_status(
                    out_tx,
                    "clipboard-disabled",
                    "RDP clipboard redirection is disabled.",
                );
                return Ok(ControlOutcome::Continue);
            };
            match collect_local_clipboard_files(&paths) {
                Ok(files) if !files.is_empty() => {
                    let count = files.len();
                    clipboard.set_local_files(files);
                    advertise_clipboard_formats(
                        active_stage,
                        clipboard.local_formats(),
                        framed,
                        out_tx,
                        "clipboard-local-files",
                    )
                    .await?;
                    send_status(
                        out_tx,
                        "clipboard-local-files",
                        &format!("{} local file item(s) are ready for RDP paste.", count),
                    );
                }
                Ok(_) => send_status(
                    out_tx,
                    "clipboard-local-files-empty",
                    "No existing local files were found in the clipboard.",
                ),
                Err(e) => send_status(
                    out_tx,
                    "clipboard-local-files-error",
                    &format!("Local file clipboard could not be prepared: {}", e),
                ),
            }
        }
    }
    Ok(ControlOutcome::Continue)
}

/// Ask the server to redraw the entire desktop via a Refresh Rect PDU
/// (MS-RDPBCGR 2.2.11.2). Windows occasionally leaves the client showing a
/// stale framebuffer after a session transition (e.g. the move from the
/// logon/credential screen to the interactive desktop, which arrives as a
/// Deactivate-All → reactivation). Re-requesting the full rectangle forces a
/// fresh paint so the canvas is not stuck on the pre-login image.
async fn request_full_refresh<S>(
    active_stage: &mut ActiveStage,
    image: &IronDecodedImage,
    framed: &mut Framed<S>,
    out_tx: &UnboundedSender<SessionOutput>,
) -> Result<(), String>
where
    S: FramedWrite,
{
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Ok(());
    }
    let pdu = ShareDataPdu::RefreshRectangle(RefreshRectanglePdu {
        areas_to_refresh: vec![InclusiveRectangle {
            left: 0,
            top: 0,
            right: width - 1,
            bottom: height - 1,
        }],
    });
    let mut output = WriteBuf::new();
    active_stage
        .encode_static(&mut output, pdu)
        .map_err(|e| format!("rdp refresh encode: {}", e))?;
    if !output.filled().is_empty() {
        framed
            .write_all(output.filled())
            .await
            .map_err(|e| format!("rdp refresh write: {}", e))?;
    }
    send_status(
        out_tx,
        "refresh-requested",
        "Requested a full desktop redraw from the RDP server.",
    );
    Ok(())
}

async fn drain_clipboard_actions<S>(
    active_stage: &mut ActiveStage,
    clipboard: &ClipboardBridge,
    framed: &mut Framed<S>,
    out_tx: &UnboundedSender<SessionOutput>,
) -> Result<(), String>
where
    S: FramedWrite,
{
    for action in clipboard.drain_actions() {
        match action {
            ClipboardAction::AdvertiseFormats(formats) => {
                advertise_clipboard_formats(
                    active_stage,
                    formats,
                    framed,
                    out_tx,
                    "clipboard-initial-formats",
                )
                .await?;
            }
            ClipboardAction::RequestRemoteData(format) => {
                let messages = {
                    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>()
                    else {
                        send_status(
                            out_tx,
                            "clipboard-unavailable",
                            "CLIPRDR channel was not negotiated.",
                        );
                        continue;
                    };
                    cliprdr
                        .initiate_paste(format)
                        .map_err(|e| format!("rdp clipboard request remote data: {}", e))?
                };
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
            ClipboardAction::RequestRemoteFileContents(requests) => {
                if active_stage.get_svc_processor::<CliprdrClient>().is_none() {
                    send_status(
                        out_tx,
                        "clipboard-unavailable",
                        "CLIPRDR channel was not negotiated.",
                    );
                    continue;
                }
                let messages = SvcProcessorMessages::<CliprdrClient>::new(
                    requests
                        .into_iter()
                        .map(file_contents_request_message)
                        .collect(),
                );
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
            ClipboardAction::SubmitFormatData(response) => {
                let messages = {
                    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>()
                    else {
                        send_status(
                            out_tx,
                            "clipboard-unavailable",
                            "CLIPRDR channel was not negotiated.",
                        );
                        continue;
                    };
                    cliprdr
                        .submit_format_data(response)
                        .map_err(|e| format!("rdp clipboard submit data: {}", e))?
                };
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
            ClipboardAction::SubmitFileContents(response) => {
                let messages = {
                    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>()
                    else {
                        send_status(
                            out_tx,
                            "clipboard-unavailable",
                            "CLIPRDR channel was not negotiated.",
                        );
                        continue;
                    };
                    cliprdr
                        .submit_file_contents(response)
                        .map_err(|e| format!("rdp clipboard submit file contents: {}", e))?
                };
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
        }
    }
    Ok(())
}

async fn advertise_clipboard_formats<S>(
    active_stage: &mut ActiveStage,
    formats: Vec<ClipboardFormat>,
    framed: &mut Framed<S>,
    out_tx: &UnboundedSender<SessionOutput>,
    stage: &str,
) -> Result<(), String>
where
    S: FramedWrite,
{
    let messages = {
        let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
            send_status(
                out_tx,
                "clipboard-unavailable",
                "CLIPRDR channel was not negotiated.",
            );
            return Ok(());
        };
        cliprdr
            .initiate_copy(&formats)
            .map_err(|e| format!("rdp clipboard advertise formats: {}", e))?
    };
    write_cliprdr_messages(active_stage, messages, framed).await?;
    send_status(
        out_tx,
        stage,
        "Local clipboard formats were advertised to the RDP server.",
    );
    Ok(())
}

async fn write_cliprdr_messages<S>(
    active_stage: &mut ActiveStage,
    messages: ironrdp::cliprdr::CliprdrSvcMessages<ironrdp::cliprdr::Client>,
    framed: &mut Framed<S>,
) -> Result<(), String>
where
    S: FramedWrite,
{
    let frame = active_stage
        .process_svc_processor_messages(messages)
        .map_err(|e| format!("rdp clipboard encode: {}", e))?;
    if !frame.is_empty() {
        framed
            .write_all(&frame)
            .await
            .map_err(|e| format!("rdp clipboard write: {}", e))?;
    }
    Ok(())
}

async fn handle_active_outputs<S>(
    framed: &mut Framed<S>,
    image: &IronDecodedImage,
    outputs: Vec<ActiveStageOutput>,
    out_tx: &UnboundedSender<SessionOutput>,
) -> Result<ActiveOutputFlow, String>
where
    S: FramedWrite,
{
    for out in outputs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => {
                if !frame.is_empty() {
                    framed
                        .write_all(&frame)
                        .await
                        .map_err(|e| format!("rdp write response: {}", e))?;
                }
            }
            ActiveStageOutput::GraphicsUpdate(rect) => {
                if let Some(tile) = tile_from_image(image, rect) {
                    tile.validate()?;
                    let payload = frame_payload_with_header(tile.header, &tile.rgba);
                    let _ = out_tx.send(SessionOutput::Channel {
                        tag: channel::FRAME,
                        payload,
                    });
                }
            }
            ActiveStageOutput::PointerDefault
            | ActiveStageOutput::PointerHidden
            | ActiveStageOutput::PointerPosition { .. }
            | ActiveStageOutput::PointerBitmap(_) => {
                // Pointer changes are software-rendered into the framebuffer by
                // IronRDP when pointer_software_rendering is enabled.
            }
            ActiveStageOutput::Terminate(reason) => {
                send_text(
                    out_tx,
                    json!({
                        "type": "disconnected",
                        "reason": reason.description(),
                    })
                    .to_string(),
                );
                return Ok(ActiveOutputFlow::Terminate);
            }
            ActiveStageOutput::DeactivateAll(sequence) => {
                send_status(
                    out_tx,
                    "reactivating",
                    "Server deactivated the RDP session; reactivation is in progress.",
                );
                return Ok(ActiveOutputFlow::Reactivate(*sequence));
            }
            ActiveStageOutput::MultitransportRequest(_) | ActiveStageOutput::AutoDetect(_) => {
                // Optional RDP transports are not established by this client.
            }
        }
    }
    Ok(ActiveOutputFlow::Continue)
}

async fn process_reactivation_frame<S>(
    sequence: &mut ConnectionActivationSequence,
    frame: &[u8],
    active_stage: &mut ActiveStage,
    image: &mut IronDecodedImage,
    framed: &mut Framed<S>,
    out_tx: &UnboundedSender<SessionOutput>,
    protocol: &str,
    server_name: &str,
) -> Result<bool, String>
where
    S: FramedWrite,
{
    // Step once with the server PDU the current state was waiting for, then
    // keep draining any send-only states without waiting for more input. The
    // Deactivation-Reactivation Sequence (MS-RDPBCGR 1.3.1.3) runs
    // Capabilities Exchange → Synchronize → Control Cooperate → Request
    // Control → Font List before the server sends its Font Map. Those middle
    // states report `next_pdu_hint() == None`: they only emit a PDU and must
    // be advanced with `step_no_input`. The server withholds the Font Map
    // until it receives our Font List, so if we stop after a single `step`
    // (as the old code did) both sides wait on each other forever and the
    // canvas freezes after a maximize/restore until the user reconnects.
    let mut output = WriteBuf::new();
    sequence
        .step(frame, &mut output)
        .map_err(|e| format!("rdp reactivation: {}", e))?;
    flush_reactivation_output(framed, &output).await?;

    loop {
        if let ConnectionActivationState::Finalized {
            desktop_size,
            enable_server_pointer,
            ..
        } = sequence.connection_activation_state()
        {
            active_stage.set_enable_server_pointer(enable_server_pointer);
            *image =
                IronDecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            send_connected_event(
                out_tx,
                desktop_size.width,
                desktop_size.height,
                protocol,
                server_name,
            );
            send_status(
                out_tx,
                "reactivated",
                "RDP session reactivated after desktop resize.",
            );
            // The desktop that arrives after a reactivation (notably the
            // post-logon interactive desktop when NLA is off) is frequently not
            // fully repainted by the server on its own. Force a full redraw so
            // the canvas does not stay stuck on the pre-transition image.
            request_full_refresh(active_stage, image, framed, out_tx).await?;
            return Ok(true);
        }

        // A `Some` hint means the next transition needs another server PDU;
        // hand control back to the read loop to fetch it.
        if sequence.next_pdu_hint().is_some() {
            return Ok(false);
        }

        // Send-only state: advance without input and flush the produced PDU.
        output.clear();
        sequence
            .step_no_input(&mut output)
            .map_err(|e| format!("rdp reactivation step: {}", e))?;
        flush_reactivation_output(framed, &output).await?;
    }
}

/// Write any bytes a reactivation step produced to the framed transport.
/// Reactivation states may legitimately emit nothing (e.g. the Font Map
/// `WaitForResponse` transition), so an empty buffer is not an error.
async fn flush_reactivation_output<S>(
    framed: &mut Framed<S>,
    output: &WriteBuf,
) -> Result<(), String>
where
    S: FramedWrite,
{
    if !output.filled().is_empty() {
        framed
            .write_all(output.filled())
            .await
            .map_err(|e| format!("rdp reactivation write: {}", e))?;
    }
    Ok(())
}

fn tile_from_image(image: &IronDecodedImage, rect: InclusiveRectangle) -> Option<DecodedTile> {
    let left = rect.left.min(image.width().saturating_sub(1));
    let top = rect.top.min(image.height().saturating_sub(1));
    let right = rect.right.min(image.width().saturating_sub(1));
    let bottom = rect.bottom.min(image.height().saturating_sub(1));
    if right < left || bottom < top {
        return None;
    }
    let w = right - left + 1;
    let h = bottom - top + 1;
    let bpp = image.bytes_per_pixel();
    if bpp != 4 {
        return None;
    }

    let mut rgba = Vec::with_capacity(usize::from(w) * usize::from(h) * bpp);
    let framebuffer = image.data();
    let stride = image.stride();
    for row in top..=bottom {
        let start = usize::from(row) * stride + usize::from(left) * bpp;
        let end = start + usize::from(w) * bpp;
        if end > framebuffer.len() {
            return None;
        }
        rgba.extend_from_slice(&framebuffer[start..end]);
    }

    Some(DecodedTile {
        header: TileHeader {
            x: left,
            y: top,
            w,
            h,
        },
        rgba,
    })
}

fn parse_connected_event(text: &str) -> Result<Option<RdpConnectionTestResult>, String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(None);
    };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("connected") => {
            let width = value
                .get("width")
                .and_then(|v| v.as_u64())
                .and_then(|v| u16::try_from(v).ok())
                .ok_or_else(|| "RDP connected event did not include a valid width".to_string())?;
            let height = value
                .get("height")
                .and_then(|v| v.as_u64())
                .and_then(|v| u16::try_from(v).ok())
                .ok_or_else(|| "RDP connected event did not include a valid height".to_string())?;
            let protocol = value
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_owned();
            let server_name = value
                .get("server_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            Ok(Some(RdpConnectionTestResult {
                width,
                height,
                protocol,
                server_name,
            }))
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("RDP connection test failed");
            Err(message.to_owned())
        }
        Some("disconnected") => {
            let reason = value
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("RDP session disconnected before it reached connected state");
            Err(reason.to_owned())
        }
        _ => Ok(None),
    }
}

fn file_list_clipboard_format_id() -> ClipboardFormatId {
    ClipboardFormatId::new(CLIPRDR_FILE_LIST_FORMAT_VALUE)
}

fn file_list_clipboard_format() -> ClipboardFormat {
    ClipboardFormat::new(file_list_clipboard_format_id()).with_name(ClipboardFormatName::FILE_LIST)
}

fn file_contents_request_message(request: FileContentsRequest) -> SvcMessage {
    SvcMessage::from(ClipboardPdu::FileContentsRequest(request))
        .with_flags(ChannelFlags::SHOW_PROTOCOL)
}

fn build_remote_file_transfer(
    list: PackedFileList,
) -> Result<(RemoteFileTransfer, Vec<FileContentsRequest>), String> {
    let staging_dir = std::env::temp_dir()
        .join("taomni-rdp-cliprdr")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&staging_dir).map_err(|e| {
        format!(
            "create staging directory '{}': {}",
            staging_dir.display(),
            e
        )
    })?;

    let mut files = Vec::with_capacity(list.files.len());
    let mut top_level_names = HashSet::new();
    let mut top_level_paths = Vec::new();
    for file in list.files {
        let is_directory = file
            .attributes
            .unwrap_or_else(ClipboardFileAttributes::empty)
            .contains(ClipboardFileAttributes::DIRECTORY);
        let path = remote_clipboard_safe_path(&staging_dir, &file.name)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create directory '{}': {}", parent.display(), e))?;
        }
        if is_directory {
            fs::create_dir_all(&path)
                .map_err(|e| format!("create directory '{}': {}", path.display(), e))?;
        } else if file.file_size.unwrap_or_default() == 0 {
            File::create(&path).map_err(|e| format!("create '{}': {}", path.display(), e))?;
        }

        if let Some(name) = remote_top_level_name(&file.name) {
            if top_level_names.insert(name.clone()) {
                top_level_paths.push(staging_dir.join(name));
            }
        }

        files.push(RemoteClipboardFile {
            path,
            size: file.file_size.unwrap_or_default(),
            is_directory,
        });
        if files.len() > MAX_CLIPBOARD_FILE_ITEMS {
            return Err(format!(
                "remote file clipboard contains more than {} items",
                MAX_CLIPBOARD_FILE_ITEMS
            ));
        }
    }

    let mut transfer = RemoteFileTransfer {
        files,
        top_level_paths,
        streams: HashMap::new(),
        next_stream_id: 1,
    };
    let mut requests = Vec::new();
    for index in 0..transfer.files.len() {
        let file = &transfer.files[index];
        if !file.is_directory && file.size > 0 {
            requests.push(next_remote_file_request(&mut transfer, index, 0));
        }
    }

    Ok((transfer, requests))
}

fn next_remote_file_request(
    transfer: &mut RemoteFileTransfer,
    index: usize,
    position: u64,
) -> FileContentsRequest {
    let file = &transfer.files[index];
    let remaining = file.size.saturating_sub(position);
    let requested_size = remaining.min(u64::from(REMOTE_FILE_CHUNK_SIZE)) as u32;
    let stream_id = transfer.next_stream_id;
    transfer.next_stream_id = transfer.next_stream_id.wrapping_add(1).max(1);
    transfer
        .streams
        .insert(stream_id, RemoteFileStream { index, position });
    FileContentsRequest {
        stream_id,
        index: index as i32,
        flags: FileContentsFlags::RANGE,
        position,
        requested_size,
        data_id: None,
    }
}

fn remote_clipboard_safe_path(root: &Path, remote_name: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    let mut saw_part = false;
    for part in remote_name.split(['\\', '/']) {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("remote clipboard path '{}' is unsafe", remote_name));
        }
        saw_part = true;
        path.push(part);
    }
    if !saw_part {
        return Err("remote clipboard file has an empty name".to_string());
    }
    Ok(path)
}

fn remote_top_level_name(remote_name: &str) -> Option<PathBuf> {
    remote_name
        .split(['\\', '/'])
        .find(|part| !part.trim().is_empty() && *part != "." && *part != "..")
        .map(PathBuf::from)
}

fn write_remote_file_chunk(path: &Path, position: u64, data: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    file.write_all(data)
        .map_err(|e| format!("write '{}': {}", path.display(), e))
}

fn collect_local_clipboard_files(paths: &[String]) -> Result<Vec<LocalClipboardFile>, String> {
    let mut files = Vec::new();
    for raw in paths {
        if raw.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(raw);
        let path = path
            .canonicalize()
            .map_err(|e| format!("canonicalize '{}': {}", raw, e))?;
        let root = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        collect_clipboard_path(&root, &path, &mut files)?;
        if files.len() > MAX_CLIPBOARD_FILE_ITEMS {
            return Err(format!(
                "file clipboard contains more than {} items",
                MAX_CLIPBOARD_FILE_ITEMS
            ));
        }
    }
    Ok(files)
}

fn collect_clipboard_path(
    root: &Path,
    path: &Path,
    out: &mut Vec<LocalClipboardFile>,
) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("metadata '{}': {}", path.display(), e))?;
    let is_directory = metadata.is_dir();
    let name = clipboard_relative_name(root, path)?;
    out.push(LocalClipboardFile {
        path: path.to_path_buf(),
        name,
        size: if is_directory { 0 } else { metadata.len() },
        is_directory,
        attributes: if is_directory {
            ClipboardFileAttributes::DIRECTORY
        } else {
            ClipboardFileAttributes::NORMAL
        },
    });

    if is_directory {
        let mut entries = fs::read_dir(path)
            .map_err(|e| format!("read directory '{}': {}", path.display(), e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read directory '{}': {}", path.display(), e))?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect_clipboard_path(root, &entry.path(), out)?;
            if out.len() > MAX_CLIPBOARD_FILE_ITEMS {
                return Err(format!(
                    "file clipboard contains more than {} items",
                    MAX_CLIPBOARD_FILE_ITEMS
                ));
            }
        }
    }
    Ok(())
}

fn clipboard_relative_name(root: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let name = rel
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("\\");
    if name.is_empty() {
        return Err(format!(
            "clipboard path '{}' has no file name",
            path.display()
        ));
    }
    if name.encode_utf16().count() >= 260 {
        return Err(format!(
            "clipboard file name '{}' exceeds 259 UTF-16 code units",
            name
        ));
    }
    Ok(name)
}

fn read_clipboard_file_range(
    path: &Path,
    position: u64,
    requested_size: u32,
) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    let max_chunk = 16 * 1024 * 1024;
    let size = usize::try_from(requested_size)
        .unwrap_or(usize::MAX)
        .min(max_chunk);
    let mut data = Vec::with_capacity(size);
    file.take(size as u64)
        .read_to_end(&mut data)
        .map_err(|e| format!("read '{}': {}", path.display(), e))?;
    Ok(data)
}

fn audio_payload_with_header(format_no: usize, timestamp: u32, pcm: &[u8]) -> Vec<u8> {
    let format_no = u16::try_from(format_no).unwrap_or(u16::MAX);
    let mut payload = Vec::with_capacity(16 + pcm.len());
    payload.extend_from_slice(&AUDIO_SAMPLE_RATE.to_be_bytes());
    payload.extend_from_slice(&AUDIO_CHANNELS.to_be_bytes());
    payload.extend_from_slice(&AUDIO_BITS_PER_SAMPLE.to_be_bytes());
    payload.extend_from_slice(&timestamp.to_be_bytes());
    payload.extend_from_slice(&format_no.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(pcm);
    payload
}

fn key_operations(key: KeyEvent) -> Vec<Operation> {
    let extended = key.scancode & 0x0100 != 0;
    let code = (key.scancode & 0x00ff) as u8;
    let scancode = Scancode::from_u8(extended, code);
    if key.down {
        vec![Operation::KeyPressed(scancode)]
    } else {
        vec![Operation::KeyReleased(scancode)]
    }
}

fn pointer_operations(pointer: PointerEvent, last_buttons: &mut u8) -> Vec<Operation> {
    let mut ops = Vec::with_capacity(4);
    ops.push(Operation::MouseMove(MousePosition {
        x: pointer.x,
        y: pointer.y,
    }));

    let changed = *last_buttons ^ pointer.buttons;
    for (mask, button) in [
        (0x01, MouseButton::Left),
        (0x02, MouseButton::Right),
        (0x04, MouseButton::Middle),
    ] {
        if changed & mask == 0 {
            continue;
        }
        if pointer.buttons & mask != 0 {
            ops.push(Operation::MouseButtonPressed(button));
        } else {
            ops.push(Operation::MouseButtonReleased(button));
        }
    }
    *last_buttons = pointer.buttons;
    ops
}

fn wheel_operations(wheel: PointerWheelEvent) -> Vec<Operation> {
    vec![
        Operation::MouseMove(MousePosition {
            x: wheel.x,
            y: wheel.y,
        }),
        Operation::WheelRotations(WheelRotations {
            is_vertical: wheel.is_vertical,
            rotation_units: wheel.rotation_units,
        }),
    ]
}

fn build_ironrdp_config(cfg: &RdpConnectionSettings) -> connector::Config {
    let mut performance_flags = IronPerformanceFlags::empty();
    if !cfg.options.performance.wallpaper {
        performance_flags |= IronPerformanceFlags::DISABLE_WALLPAPER;
    }
    if cfg.options.performance.disable_full_window_drag {
        performance_flags |= IronPerformanceFlags::DISABLE_FULLWINDOWDRAG;
    }
    if cfg.options.performance.disable_menu_animations {
        performance_flags |= IronPerformanceFlags::DISABLE_MENUANIMATIONS;
    }
    if !cfg.options.performance.themes {
        performance_flags |= IronPerformanceFlags::DISABLE_THEMING;
    }
    if cfg.options.performance.disable_cursor_shadow {
        performance_flags |= IronPerformanceFlags::DISABLE_CURSOR_SHADOW;
    }
    if cfg.options.performance.font_smooth {
        performance_flags |= IronPerformanceFlags::ENABLE_FONT_SMOOTHING;
    }

    let width = normalize_width(cfg.options.screen_w);
    let height = cfg.options.screen_h.clamp(200, 8192);
    let color_depth = match cfg.options.color_depth {
        15 | 16 | 24 | 32 => u32::from(cfg.options.color_depth),
        _ => 32,
    };
    let codecs = ironrdp::pdu::rdp::capability_sets::client_codecs_capabilities(&["remotefx"])
        .unwrap_or_default();

    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: cfg.username.clone().unwrap_or_default(),
            password: cfg.password.clone().unwrap_or_default(),
        },
        domain: cfg.options.domain.clone().filter(|s| !s.trim().is_empty()),
        enable_tls: !cfg.options.nla,
        enable_credssp: cfg.options.nla,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        desktop_size: connector::DesktopSize { width, height },
        desktop_scale_factor: 0,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: false,
            color_depth,
            codecs,
        }),
        client_build: 0,
        client_name: "taomni".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: platform_type(),
        enable_server_pointer: true,
        request_data: None,
        autologon: !cfg.options.nla && (cfg.username.is_some() || cfg.password.is_some()),
        enable_audio_playback: cfg.options.redirect_audio == "play",
        pointer_software_rendering: true,
        performance_flags,
        hardware_id: None,
        license_cache: None::<Arc<dyn connector::LicenseCache>>,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        multitransport_flags: None,
    }
}

fn normalize_width(width: u16) -> u16 {
    let clamped = width.clamp(200, 8192);
    if clamped % 2 == 0 {
        clamped
    } else {
        clamped - 1
    }
}

fn platform_type() -> MajorPlatformType {
    #[cfg(windows)]
    {
        MajorPlatformType::WINDOWS
    }
    #[cfg(target_os = "macos")]
    {
        MajorPlatformType::MACINTOSH
    }
    #[cfg(target_os = "ios")]
    {
        MajorPlatformType::IOS
    }
    #[cfg(target_os = "android")]
    {
        MajorPlatformType::ANDROID
    }
    #[cfg(all(
        not(windows),
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    {
        MajorPlatformType::UNIX
    }
}

fn send_connected_event(
    out_tx: &UnboundedSender<SessionOutput>,
    width: u16,
    height: u16,
    protocol: &str,
    server_name: &str,
) {
    send_text(
        out_tx,
        json!({
            "type": "connected",
            "width": width,
            "height": height,
            "protocol": protocol,
            "server_name": server_name,
        })
        .to_string(),
    );
}

fn install_rustls_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn send_status(out_tx: &UnboundedSender<SessionOutput>, stage: &str, detail: &str) {
    send_text(
        out_tx,
        json!({
            "type": "status",
            "stage": stage,
            "detail": detail,
        })
        .to_string(),
    );
}

fn send_error(out_tx: &UnboundedSender<SessionOutput>, code: &str, message: &str) {
    send_text(
        out_tx,
        json!({
            "type": "error",
            "code": code,
            "message": message,
        })
        .to_string(),
    );
}

fn send_text(out_tx: &UnboundedSender<SessionOutput>, text: String) {
    let _ = out_tx.send(SessionOutput::Text(text));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpStream;

    #[tokio::test]
    async fn handle_round_trip_via_channels() {
        let (mut handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
        let _ = out_tx.send(SessionOutput::Channel {
            tag: 1,
            payload: vec![1, 2, 3],
        });
        match handle.next_outgoing().await.unwrap() {
            SessionOutput::Channel { tag, payload } => {
                assert_eq!(tag, 1);
                assert_eq!(payload, vec![1, 2, 3]);
            }
            SessionOutput::Text(_) => panic!("expected channel output"),
        }
    }

    #[tokio::test]
    async fn dispatch_control_returns_err_when_dropped() {
        let (handle, _out_tx, ctrl_rx) = RdpSessionHandle::new();
        drop(ctrl_rx);
        let res = handle
            .dispatch_control(RdpControl::Resize {
                width: 1,
                height: 1,
            })
            .await;
        assert!(res.is_err());
    }

    #[test]
    fn pointer_operations_track_button_edges() {
        let mut last = 0;
        let ops = pointer_operations(
            PointerEvent {
                x: 10,
                y: 20,
                buttons: 0x01,
            },
            &mut last,
        );
        assert!(matches!(
            ops[0],
            Operation::MouseMove(MousePosition { x: 10, y: 20 })
        ));
        assert!(matches!(
            ops[1],
            Operation::MouseButtonPressed(MouseButton::Left)
        ));
        assert_eq!(last, 0x01);

        let ops = pointer_operations(
            PointerEvent {
                x: 11,
                y: 21,
                buttons: 0x00,
            },
            &mut last,
        );
        assert!(matches!(
            ops[1],
            Operation::MouseButtonReleased(MouseButton::Left)
        ));
        assert_eq!(last, 0x00);
    }

    #[test]
    fn wheel_operations_preserve_position_axis_and_units() {
        let ops = wheel_operations(PointerWheelEvent {
            x: 25,
            y: 40,
            is_vertical: false,
            rotation_units: -120,
        });

        assert!(matches!(
            ops[0],
            Operation::MouseMove(MousePosition { x: 25, y: 40 })
        ));
        match ops[1] {
            Operation::WheelRotations(rotations) => {
                assert!(!rotations.is_vertical);
                assert_eq!(rotations.rotation_units, -120);
            }
            _ => panic!("expected wheel rotation"),
        }
    }

    #[test]
    fn key_operations_preserve_frontend_extended_flag() {
        let ops = key_operations(KeyEvent {
            down: true,
            scancode: 0x0148,
        });
        match &ops[0] {
            Operation::KeyPressed(scancode) => assert_eq!(scancode.as_u8(), (true, 0x48)),
            _ => panic!("expected key press"),
        }
    }

    #[test]
    fn normalize_width_is_even_and_in_range() {
        assert_eq!(normalize_width(199), 200);
        assert_eq!(normalize_width(201), 200);
        assert_eq!(normalize_width(8191), 8190);
        assert_eq!(normalize_width(8193), 8192);
    }

    #[test]
    fn rdpsnd_backend_advertises_pcm_44100_stereo() {
        let (_handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
        let backend = RdpsndWsBackend::new(out_tx);
        let formats = backend.get_formats();
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].format, IronWaveFormat::PCM);
        assert_eq!(formats[0].n_channels, 2);
        assert_eq!(formats[0].n_samples_per_sec, 44_100);
        assert_eq!(formats[0].bits_per_sample, 16);
        assert_eq!(formats[0].n_block_align, 4);
    }

    #[test]
    fn audio_payload_layout() {
        let payload = audio_payload_with_header(7, 0x1234_5678, &[0xaa, 0xbb, 0xcc]);
        assert_eq!(&payload[0..4], &44_100u32.to_be_bytes());
        assert_eq!(&payload[4..6], &2u16.to_be_bytes());
        assert_eq!(&payload[6..8], &16u16.to_be_bytes());
        assert_eq!(&payload[8..12], &0x1234_5678u32.to_be_bytes());
        assert_eq!(&payload[12..14], &7u16.to_be_bytes());
        assert_eq!(&payload[14..16], &0u16.to_be_bytes());
        assert_eq!(&payload[16..], &[0xaa, 0xbb, 0xcc]);
    }

    #[test]
    fn local_clipboard_files_build_relative_descriptors() {
        let dir = tempfile::tempdir().unwrap();
        let root_file = dir.path().join("note.txt");
        std::fs::write(&root_file, b"hello").unwrap();
        let folder = dir.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("child.txt"), b"child").unwrap();

        let files = collect_local_clipboard_files(&[
            root_file.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
        ])
        .unwrap();

        let names: Vec<_> = files.iter().map(|file| file.name.as_str()).collect();
        assert!(names.contains(&"note.txt"));
        assert!(names.contains(&"folder"));
        assert!(names.contains(&"folder\\child.txt"));
        assert!(
            files
                .iter()
                .any(|file| file.name == "folder" && file.is_directory)
        );
    }

    #[test]
    fn local_file_contents_response_reads_size_and_range() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("payload.bin");
        std::fs::write(&file, b"abcdef").unwrap();
        let files = collect_local_clipboard_files(&[file.to_string_lossy().into_owned()]).unwrap();
        let (_handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
        let bridge = ClipboardBridge::new(out_tx);
        bridge.set_local_files(files);

        let size = bridge.local_file_contents_response(&FileContentsRequest {
            stream_id: 7,
            index: 0,
            flags: FileContentsFlags::SIZE,
            position: 0,
            requested_size: 8,
            data_id: None,
        });
        assert_eq!(size.stream_id(), 7);
        assert_eq!(size.data_as_size().unwrap(), 6);

        let data = bridge.local_file_contents_response(&FileContentsRequest {
            stream_id: 8,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 2,
            requested_size: 3,
            data_id: None,
        });
        assert_eq!(data.stream_id(), 8);
        assert_eq!(data.data(), b"cde");
    }

    #[tokio::test]
    async fn remote_file_contents_response_stages_files_and_notifies_frontend() {
        let (mut handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
        let bridge = ClipboardBridge::new(out_tx);
        bridge.start_remote_file_receive(PackedFileList {
            files: vec![
                IronClipboardFileDescriptor::new("remote.txt")
                    .with_attributes(ClipboardFileAttributes::NORMAL)
                    .with_file_size(3),
            ],
        });

        let actions = bridge.drain_actions();
        let request = match actions.as_slice() {
            [ClipboardAction::RequestRemoteFileContents(requests)] => requests[0].clone(),
            _ => panic!("expected remote file contents request"),
        };
        assert_eq!(request.index, 0);
        assert_eq!(request.position, 0);
        assert_eq!(request.requested_size, 3);

        bridge.handle_remote_file_contents_response(FileContentsResponse::new_data_response(
            request.stream_id,
            b"abc".to_vec(),
        ));

        let output = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(SessionOutput::Text(text)) = handle.next_outgoing().await {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if value.get("type").and_then(|v| v.as_str()) == Some("clipboard_files") {
                        return value;
                    }
                }
            }
        })
        .await
        .expect("clipboard_files notification");
        let path = output["paths"][0].as_str().unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"abc");
    }

    #[test]
    fn parse_connected_event_extracts_desktop_metadata() {
        let result = parse_connected_event(
            r#"{"type":"connected","width":1280,"height":720,"protocol":"CredSSP/NLA","server_name":"win10"}"#,
        )
        .expect("connected event parses")
        .expect("connected event yields result");

        assert_eq!(
            result,
            RdpConnectionTestResult {
                width: 1280,
                height: 720,
                protocol: "CredSSP/NLA".to_owned(),
                server_name: "win10".to_owned(),
            }
        );
    }

    #[test]
    fn parse_connected_event_ignores_non_terminal_status() {
        assert_eq!(
            parse_connected_event(r#"{"type":"status","stage":"credssp"}"#)
                .expect("status event parses"),
            None
        );
        assert_eq!(
            parse_connected_event("not-json").expect("invalid json is ignored"),
            None
        );
    }

    #[test]
    fn parse_connected_event_maps_terminal_failures() {
        assert_eq!(
            parse_connected_event(r#"{"type":"error","message":"bad credentials"}"#)
                .expect_err("error event aborts"),
            "bad credentials"
        );
        assert_eq!(
            parse_connected_event(r#"{"type":"disconnected","reason":"server closed"}"#)
                .expect_err("disconnect event aborts"),
            "server closed"
        );
    }

    #[test]
    fn parse_connected_event_rejects_invalid_desktop_size() {
        assert!(
            parse_connected_event(r#"{"type":"connected","width":70000,"height":720}"#).is_err()
        );
        assert!(
            parse_connected_event(r#"{"type":"connected","width":1280,"height":"720"}"#).is_err()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
    async fn live_credssp_session_emits_first_frame() {
        let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
        let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(3389);
        let username =
            std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
        let password =
            std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .expect("connect live RDP TCP stream");
        let local_addr = stream.local_addr().expect("read live RDP local address");
        let mut options = RdpOptions::default();
        options.screen_w = 1280;
        options.screen_h = 720;
        options.nla = true;
        options.redirect_audio = "play".to_owned();
        if let Ok(path) = std::env::var("TAOMNI_RDP_LIVE_DRIVE_PATH") {
            options.redirect_drive.enabled = true;
            options.redirect_drive.label = "taomni".to_owned();
            options.redirect_drive.path = path;
        }

        let mut handle = start_ironrdp_session(RdpSessionConfig {
            stream: RdpStream::Tcp(stream),
            local_addr,
            host,
            port,
            username: Some(username),
            password: Some(password),
            options,
            network: None,
        });

        let mut connected = false;
        let mut frame_tiles = 0usize;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for live RDP frame");

            let output = tokio::time::timeout(remaining, handle.next_outgoing())
                .await
                .expect("timed out waiting for live RDP output")
                .expect("live RDP session ended before first frame");

            match output {
                SessionOutput::Text(text) => {
                    eprintln!("rdp live event: {}", text);
                    assert!(
                        !text.contains("\"type\":\"error\""),
                        "live RDP session failed: {}",
                        text
                    );
                    if text.contains("\"type\":\"connected\"") {
                        connected = true;
                    }
                }
                SessionOutput::Channel { tag, payload } if tag == channel::FRAME => {
                    assert!(payload.len() >= 8, "frame payload missing tile header");
                    frame_tiles += 1;
                    if connected && frame_tiles > 0 {
                        break;
                    }
                }
                SessionOutput::Channel { .. } => {}
            }
        }

        let _ = handle.dispatch_control(RdpControl::Disconnect).await;
        assert!(connected, "live RDP session did not report connected");
        assert!(frame_tiles > 0, "live RDP session did not emit a frame");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
    async fn live_credssp_clipboard_text_channel_accepts_local_copy() {
        let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
        let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(3389);
        let username =
            std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
        let password =
            std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .expect("connect live RDP TCP stream");
        let local_addr = stream.local_addr().expect("read live RDP local address");
        let mut options = RdpOptions::default();
        options.screen_w = 1280;
        options.screen_h = 720;
        options.nla = true;
        options.redirect_clipboard = true;

        let mut handle = start_ironrdp_session(RdpSessionConfig {
            stream: RdpStream::Tcp(stream),
            local_addr,
            host,
            port,
            username: Some(username),
            password: Some(password),
            options,
            network: None,
        });

        let mut connected = false;
        let mut clipboard_ready = false;
        let mut copy_sent = false;
        let mut copy_advertised = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for live RDP clipboard channel"
            );

            let output = tokio::time::timeout(remaining, handle.next_outgoing())
                .await
                .expect("timed out waiting for live RDP output")
                .expect("live RDP session ended before clipboard channel proof");

            match output {
                SessionOutput::Text(text) => {
                    eprintln!("rdp live clipboard event: {}", text);
                    let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                    match value.get("type").and_then(|v| v.as_str()) {
                        Some("connected") => connected = true,
                        Some("status") => match value.get("stage").and_then(|v| v.as_str()) {
                            Some("clipboard-ready") => clipboard_ready = true,
                            Some("clipboard-local-copy") => copy_advertised = true,
                            Some("clipboard-unavailable") => {
                                panic!("live RDP CLIPRDR channel was not negotiated: {}", text)
                            }
                            _ => {}
                        },
                        Some("error") => panic!("live RDP clipboard session failed: {}", text),
                        _ => {}
                    }

                    if connected && clipboard_ready && !copy_sent {
                        handle
                            .dispatch_control(RdpControl::ClipboardData {
                                format: ClipboardFormatId::CF_UNICODETEXT.value(),
                                data: b"taomni live clipboard text".to_vec(),
                            })
                            .await
                            .expect("send live clipboard control");
                        copy_sent = true;
                    }

                    if copy_advertised {
                        break;
                    }
                }
                SessionOutput::Channel { .. } => {}
            }
        }

        let _ = handle.dispatch_control(RdpControl::Disconnect).await;
        assert!(connected, "live RDP session did not report connected");
        assert!(
            clipboard_ready,
            "live RDP CLIPRDR channel did not become ready"
        );
        assert!(copy_sent, "live RDP clipboard copy control was not sent");
        assert!(
            copy_advertised,
            "live RDP clipboard formats were not advertised"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
    async fn live_credssp_drive_channel_is_accepted() {
        let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
        let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(3389);
        let username =
            std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
        let password =
            std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");
        let drive_dir = tempfile::tempdir().expect("create live redirected drive directory");

        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .expect("connect live RDP TCP stream");
        let local_addr = stream.local_addr().expect("read live RDP local address");
        let mut options = RdpOptions::default();
        options.screen_w = 1280;
        options.screen_h = 720;
        options.nla = true;
        options.redirect_clipboard = false;
        options.redirect_audio = "off".to_owned();
        options.redirect_drive.enabled = true;
        options.redirect_drive.label = "taomni".to_owned();
        options.redirect_drive.path = drive_dir.path().to_string_lossy().into_owned();

        let mut handle = start_ironrdp_session(RdpSessionConfig {
            stream: RdpStream::Tcp(stream),
            local_addr,
            host,
            port,
            username: Some(username),
            password: Some(password),
            options,
            network: None,
        });

        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        let mut connected = false;
        let mut drive_requested = false;
        let mut drive_ready = false;
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, handle.next_outgoing()).await {
                Ok(Some(SessionOutput::Text(text))) => {
                    let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let ty = parsed
                        .as_ref()
                        .and_then(|v| v.get("type"))
                        .and_then(|s| s.as_str());
                    let stage = parsed
                        .as_ref()
                        .and_then(|v| v.get("stage"))
                        .and_then(|s| s.as_str());
                    match (ty, stage) {
                        (Some("connected"), _) => connected = true,
                        (Some("status"), Some("drive-enabled")) => drive_requested = true,
                        (Some("status"), Some("drive-ready")) => {
                            drive_ready = true;
                        }
                        (Some("status"), Some("drive-rejected")) => {
                            panic!("live RDP drive redirection was rejected: {}", text)
                        }
                        (Some("error"), _) => panic!("live RDP drive session failed: {}", text),
                        _ => {}
                    }
                    if connected && drive_requested && drive_ready {
                        break;
                    }
                }
                Ok(Some(SessionOutput::Channel { .. })) => {}
                Ok(None) | Err(_) => break,
            }
        }

        let _ = handle.dispatch_control(RdpControl::Disconnect).await;
        assert!(connected, "live RDP drive session did not report connected");
        assert!(drive_requested, "live RDP drive channel was not requested");
        assert!(drive_ready, "live RDP drive channel was not accepted");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
    async fn live_credssp_session_resizes_and_reactivates() {
        let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
        let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(3389);
        let username =
            std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
        let password =
            std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .expect("connect live RDP TCP stream");
        let local_addr = stream.local_addr().expect("read live RDP local address");
        let mut options = RdpOptions::default();
        options.screen_w = 1280;
        options.screen_h = 720;
        options.nla = true;

        let mut handle = start_ironrdp_session(RdpSessionConfig {
            stream: RdpStream::Tcp(stream),
            local_addr,
            host,
            port,
            username: Some(username),
            password: Some(password),
            options,
            network: None,
        });

        let resize_width = 1024;
        let resize_height = 768;
        let mut connected = false;
        let mut resize_sent = false;
        let mut resized = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for live RDP resize reactivation"
            );

            let output = tokio::time::timeout(remaining, handle.next_outgoing())
                .await
                .expect("timed out waiting for live RDP output")
                .expect("live RDP session ended before resize reactivation");

            match output {
                SessionOutput::Text(text) => {
                    eprintln!("rdp live resize event: {}", text);
                    let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                    match value.get("type").and_then(|v| v.as_str()) {
                        Some("connected") => {
                            connected = true;
                            let width = value.get("width").and_then(|v| v.as_u64()).unwrap();
                            let height = value.get("height").and_then(|v| v.as_u64()).unwrap();
                            if resize_sent
                                && width == u64::from(resize_width)
                                && height == u64::from(resize_height)
                            {
                                resized = true;
                            }
                        }
                        Some("error") => panic!("live RDP resize session failed: {}", text),
                        _ => {}
                    }
                    if connected && !resize_sent {
                        handle
                            .dispatch_control(RdpControl::Resize {
                                width: resize_width,
                                height: resize_height,
                            })
                            .await
                            .expect("send live resize control");
                        resize_sent = true;
                    }
                }
                SessionOutput::Channel { tag, payload } if tag == channel::FRAME => {
                    assert!(payload.len() >= 8, "frame payload missing tile header");
                    if resized {
                        break;
                    }
                }
                SessionOutput::Channel { .. } => {}
            }
        }

        let _ = handle.dispatch_control(RdpControl::Disconnect).await;
        assert!(resize_sent, "live RDP resize request was not sent");
        assert!(
            resized,
            "live RDP session did not reactivate at the resized desktop size"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
    async fn live_credssp_connection_test_reaches_connected() {
        let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
        let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(3389);
        let username =
            std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
        let password =
            std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .expect("connect live RDP TCP stream");
        let local_addr = stream.local_addr().expect("read live RDP local address");
        let mut options = RdpOptions::default();
        options.screen_w = 1280;
        options.screen_h = 720;
        options.nla = true;

        let result = test_ironrdp_connection(
            RdpSessionConfig {
                stream: RdpStream::Tcp(stream),
                local_addr,
                host: host.clone(),
                port,
                username: Some(username),
                password: Some(password),
                options,
                network: None,
            },
            Duration::from_secs(45),
        )
        .await
        .expect("live RDP connection test should reach connected");

        assert_eq!(result.width, 1280);
        assert_eq!(result.height, 720);
        assert_eq!(result.protocol, "CredSSP/NLA");
        assert_eq!(result.server_name, host);
    }
}
