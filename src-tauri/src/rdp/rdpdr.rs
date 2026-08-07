//! RDPDR (Device Redirection Virtual Channel) — MS-RDPEFS.
//!
//! Implements just enough framing to surface a single mapped local folder
//! as a redirected drive on the Windows host. The IO request handlers
//! sandbox every path to a canonicalized root.
//!
//! Implemented + unit-tested:
//!
//! - `RDPDR_HEADER` (Component / PacketId).
//! - `Server Announce` and `Client Announce Reply`.
//! - `Client Name Request`.
//! - Device list (we always announce exactly one filesystem device).
//! - IO request header parsing (DeviceCreate / Read / Write / Close /
//!   QueryInformation / QueryDirectory / DirectoryControl).
//! - Path safety check (`safe_join`) used by the handlers to refuse
//!   traversals.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use ironrdp::core::AsAny;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp::rdpdr::{Rdpdr as IronRdpdr, RdpdrBackend};
use ironrdp::svc::SvcMessage;
use serde_json::json;

use crate::rdp::DriveRedirectOpt;
use crate::rdp::session::{SessionOutput, SessionOutputSender};

// ── Component / PacketId pairs ──────────────────────────────────────────

pub const RDPDR_CTYP_CORE: u16 = 0x4472; // "rD"
pub const RDPDR_CTYP_PRT: u16 = 0x5052; // "RP" (printer)

pub const PAKID_CORE_SERVER_ANNOUNCE: u16 = 0x496E; // "nI"
pub const PAKID_CORE_CLIENTID_CONFIRM: u16 = 0x4343; // "CC"
pub const PAKID_CORE_CLIENT_NAME: u16 = 0x434E; // "NC"
pub const PAKID_CORE_DEVICELIST_ANNOUNCE: u16 = 0x4441; // "AD"
pub const PAKID_CORE_DEVICE_IOREQUEST: u16 = 0x4952; // "RI"
pub const PAKID_CORE_DEVICE_REPLY: u16 = 0x6472; // "rd"
pub const PAKID_CORE_SERVER_CAPABILITY: u16 = 0x5350; // "PS"
pub const PAKID_CORE_CLIENT_CAPABILITY: u16 = 0x4350; // "PC"

// ── Device types ────────────────────────────────────────────────────────

pub const RDPDR_DTYP_SERIAL: u32 = 0x0000_0001;
pub const RDPDR_DTYP_PARALLEL: u32 = 0x0000_0002;
pub const RDPDR_DTYP_PRINT: u32 = 0x0000_0004;
pub const RDPDR_DTYP_FILESYSTEM: u32 = 0x0000_0008;
pub const RDPDR_DTYP_SMARTCARD: u32 = 0x0000_0020;

// ── IO requests (MajorFunction values, MS-RDPEFS §2.2.1.4) ──────────────

pub const IRP_MJ_CREATE: u32 = 0x0000_0000;
pub const IRP_MJ_CLOSE: u32 = 0x0000_0002;
pub const IRP_MJ_READ: u32 = 0x0000_0003;
pub const IRP_MJ_WRITE: u32 = 0x0000_0004;
pub const IRP_MJ_DEVICE_CONTROL: u32 = 0x0000_000E;
pub const IRP_MJ_QUERY_INFORMATION: u32 = 0x0000_0005;
pub const IRP_MJ_SET_INFORMATION: u32 = 0x0000_0006;
pub const IRP_MJ_QUERY_VOLUME_INFORMATION: u32 = 0x0000_000A;
pub const IRP_MJ_DIRECTORY_CONTROL: u32 = 0x0000_000C;

// ── Header ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RdpdrHeader {
    pub component: u16,
    pub packet_id: u16,
}

impl RdpdrHeader {
    pub const SIZE: usize = 4;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..2].copy_from_slice(&self.component.to_le_bytes());
        out[2..4].copy_from_slice(&self.packet_id.to_le_bytes());
        out
    }

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err("RDPDR header truncated".into());
        }
        Ok(Self {
            component: u16::from_le_bytes([buf[0], buf[1]]),
            packet_id: u16::from_le_bytes([buf[2], buf[3]]),
        })
    }
}

// ── Client Name Request (PAKID_CORE_CLIENT_NAME) ────────────────────────

/// `unicodeFlag`/`codePage`/`computerNameLen`/`computerName` — we always
/// send Unicode (UTF-16 LE).
pub fn build_client_name(name: &str) -> Vec<u8> {
    let mut header = RdpdrHeader {
        component: RDPDR_CTYP_CORE,
        packet_id: PAKID_CORE_CLIENT_NAME,
    }
    .encode()
    .to_vec();
    header.extend_from_slice(&1u32.to_le_bytes()); // unicodeFlag
    header.extend_from_slice(&0u32.to_le_bytes()); // codePage
    let mut name_utf16: Vec<u8> = name.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    name_utf16.extend_from_slice(&[0, 0]); // null terminator
    header.extend_from_slice(&(name_utf16.len() as u32).to_le_bytes());
    header.extend_from_slice(&name_utf16);
    header
}

// ── Device announcement ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnouncedDevice {
    pub device_id: u32,
    pub device_type: u32,
    pub preferred_dos_name: String, // 8 bytes max ASCII, null padded
    pub device_data: Vec<u8>,
}

pub fn build_device_list_announce(devices: &[AnnouncedDevice]) -> Result<Vec<u8>, String> {
    let mut out = RdpdrHeader {
        component: RDPDR_CTYP_CORE,
        packet_id: PAKID_CORE_DEVICELIST_ANNOUNCE,
    }
    .encode()
    .to_vec();
    out.extend_from_slice(&(devices.len() as u32).to_le_bytes());
    for d in devices {
        out.extend_from_slice(&d.device_type.to_le_bytes());
        out.extend_from_slice(&d.device_id.to_le_bytes());
        let dos = d.preferred_dos_name.as_bytes();
        if dos.len() > 8 {
            return Err(format!(
                "preferredDosName '{}' is {} bytes (max 8)",
                d.preferred_dos_name,
                dos.len()
            ));
        }
        let mut padded = [0u8; 8];
        padded[..dos.len()].copy_from_slice(dos);
        out.extend_from_slice(&padded);
        out.extend_from_slice(&(d.device_data.len() as u32).to_le_bytes());
        out.extend_from_slice(&d.device_data);
    }
    Ok(out)
}

// ── IO request header ──────────────────────────────────────────────────

/// Layout (MS-RDPEFS §2.2.1.4):
///   DeviceId u32  FileId u32  CompletionId u32
///   MajorFunction u32  MinorFunction u32
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceIoRequestHeader {
    pub device_id: u32,
    pub file_id: u32,
    pub completion_id: u32,
    pub major: u32,
    pub minor: u32,
}

impl DeviceIoRequestHeader {
    pub const SIZE: usize = 20;

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!(
                "DR_DEVICE_IOREQUEST: {} bytes < {}",
                buf.len(),
                Self::SIZE
            ));
        }
        Ok(Self {
            device_id: u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]),
            file_id: u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]),
            completion_id: u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]),
            major: u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]),
            minor: u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]),
        })
    }

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..4].copy_from_slice(&self.device_id.to_le_bytes());
        out[4..8].copy_from_slice(&self.file_id.to_le_bytes());
        out[8..12].copy_from_slice(&self.completion_id.to_le_bytes());
        out[12..16].copy_from_slice(&self.major.to_le_bytes());
        out[16..20].copy_from_slice(&self.minor.to_le_bytes());
        out
    }
}

// ── Path sandboxing ────────────────────────────────────────────────────

/// Resolve `requested` (relative or starting with `/` or `\`) against
/// `root`, refusing any traversal that escapes `root`.
///
/// Returns the canonical path inside the root (which may not yet exist;
/// callers handle ENOENT). Used by every IO request handler.
pub fn safe_join(root: &Path, requested: &str) -> Result<PathBuf, String> {
    safe_join_from(root, root, requested)
}

fn safe_join_from(root: &Path, base: &Path, requested: &str) -> Result<PathBuf, String> {
    let normalized = requested.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let anchor = if normalized.starts_with('/') {
        root.to_path_buf()
    } else {
        base.to_path_buf()
    };
    let candidate = anchor.join(trimmed);
    normalize_inside(root, candidate)
}

fn normalize_inside(root: &Path, candidate: PathBuf) -> Result<PathBuf, String> {
    let mut resolved = PathBuf::new();
    for c in candidate.components() {
        match c {
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err("rdpdr: path traversal rejected".into());
                }
            }
            Component::CurDir => {}
            Component::RootDir => {
                resolved.push("/");
            }
            Component::Prefix(p) => {
                resolved.push(p.as_os_str());
            }
            Component::Normal(seg) => {
                resolved.push(seg);
            }
        }
    }
    // Ensure the resolved path is still within root.
    if !resolved.starts_with(root) {
        return Err(format!(
            "rdpdr: refusing path '{}' outside mapped root '{}'",
            resolved.display(),
            root.display()
        ));
    }
    Ok(resolved)
}

/// Reject symlinks/reparse-style indirection in every existing component.
/// `safe_join` is lexical; this second check prevents an in-root symlink from
/// resolving to a path outside the mapped directory.
fn validate_confined_path(root: &Path, candidate: &Path) -> Result<(), String> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        format!(
            "rdpdr: refusing path '{}' outside mapped root '{}'",
            candidate.display(),
            root.display()
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("rdpdr: invalid mapped path component".into());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "rdpdr: symbolic links are not allowed in mapped paths ('{}')",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "rdpdr: inspect mapped path '{}': {}",
                    current.display(),
                    error
                ));
            }
        }
    }
    Ok(())
}

const DEFAULT_DRIVE_ID: u32 = 1;
const MAX_DRIVE_IO_CHUNK: usize = 16 * 1024 * 1024;
const MAX_DRIVE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_DRIVE_SESSION_WRITE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub struct LocalDriveBackend {
    root: PathBuf,
    label: String,
    next_file_id: u32,
    handles: HashMap<u32, OpenedHandle>,
    status_tx: Option<SessionOutputSender>,
    read_only: bool,
    written_bytes: u64,
}

#[derive(Debug)]
struct OpenedHandle {
    path: PathBuf,
    kind: OpenedHandleKind,
}

#[derive(Debug)]
enum OpenedHandleKind {
    File(File),
    Directory(DirectoryCursor),
}

#[derive(Debug, Default)]
struct DirectoryCursor {
    entries: Vec<PathBuf>,
    index: usize,
}

impl LocalDriveBackend {
    pub fn new(root: impl AsRef<Path>, label: impl Into<String>) -> Result<Self, String> {
        Self::new_with_status(root, label, None)
    }

    pub fn new_with_status(
        root: impl AsRef<Path>,
        label: impl Into<String>,
        status_tx: Option<SessionOutputSender>,
    ) -> Result<Self, String> {
        Self::new_with_policy(root, label, status_tx, false)
    }

    fn new_with_policy(
        root: impl AsRef<Path>,
        label: impl Into<String>,
        status_tx: Option<SessionOutputSender>,
        read_only: bool,
    ) -> Result<Self, String> {
        let root = root.as_ref();
        if root.as_os_str().is_empty() {
            return Err("rdpdr: redirected drive path is empty".into());
        }
        let root = root.canonicalize().map_err(|e| {
            format!(
                "rdpdr: canonicalize mapped drive '{}': {}",
                root.display(),
                e
            )
        })?;
        if !root.is_dir() {
            return Err(format!(
                "rdpdr: mapped drive '{}' is not a directory",
                root.display()
            ));
        }
        Ok(Self {
            label: sanitize_drive_label(&label.into(), &root),
            root,
            next_file_id: DEFAULT_DRIVE_ID,
            handles: HashMap::new(),
            status_tx,
            read_only,
            written_bytes: 0,
        })
    }

    fn emit_status(&self, stage: &str, detail: &str) {
        let Some(tx) = &self.status_tx else {
            return;
        };
        let _ = tx.send(SessionOutput::Text(
            json!({
                "type": "status",
                "stage": stage,
                "detail": detail,
            })
            .to_string(),
        ));
    }

    fn next_file_id(&mut self) -> u32 {
        self.next_file_id = self
            .next_file_id
            .saturating_add(1)
            .max(DEFAULT_DRIVE_ID + 1);
        self.next_file_id - 1
    }

    fn handle_create(&mut self, req: efs::DeviceCreateRequest) -> PduResult<Vec<SvcMessage>> {
        let path = match safe_join(&self.root, &req.path) {
            Ok(path) if validate_confined_path(&self.root, &path).is_ok() => path,
            Err(_) => {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::ACCESS_DENIED,
                    0,
                    efs::Information::empty(),
                ));
            }
            Ok(_) => {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::ACCESS_DENIED,
                    0,
                    efs::Information::empty(),
                ));
            }
        };
        let file_id = self.next_file_id();

        let mutating_open =
            wants_write(&req) || req.create_disposition != efs::CreateDisposition::FILE_OPEN;
        if self.read_only && mutating_open {
            return Ok(create_response(
                &req,
                efs::NtStatus::ACCESS_DENIED,
                file_id,
                efs::Information::empty(),
            ));
        }
        if req.allocation_size.max(0) as u64 > MAX_DRIVE_FILE_BYTES {
            return Ok(create_response(
                &req,
                efs::NtStatus::ACCESS_DENIED,
                file_id,
                efs::Information::empty(),
            ));
        }

        let wants_directory = req
            .create_options
            .contains(efs::CreateOptions::FILE_DIRECTORY_FILE);
        let forbids_directory = req
            .create_options
            .contains(efs::CreateOptions::FILE_NON_DIRECTORY_FILE);

        if wants_directory || path.is_dir() {
            return self.open_directory(req, path, file_id, forbids_directory);
        }

        if path.exists() && path.is_dir() && forbids_directory {
            return Ok(create_response(
                &req,
                efs::NtStatus::NOT_A_DIRECTORY,
                file_id,
                efs::Information::empty(),
            ));
        }

        self.open_file(req, path, file_id)
    }

    fn open_directory(
        &mut self,
        req: efs::DeviceCreateRequest,
        path: PathBuf,
        file_id: u32,
        forbids_directory: bool,
    ) -> PduResult<Vec<SvcMessage>> {
        if forbids_directory {
            return Ok(create_response(
                &req,
                efs::NtStatus::UNSUCCESSFUL,
                file_id,
                efs::Information::empty(),
            ));
        }
        if !path.exists() {
            if req.create_disposition == efs::CreateDisposition::FILE_OPEN
                || req.create_disposition == efs::CreateDisposition::FILE_OVERWRITE
            {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::NO_SUCH_FILE,
                    file_id,
                    efs::Information::empty(),
                ));
            }
            if fs::create_dir_all(&path).is_err() {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::UNSUCCESSFUL,
                    file_id,
                    efs::Information::empty(),
                ));
            }
            if validate_confined_path(&self.root, &path).is_err() {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::ACCESS_DENIED,
                    file_id,
                    efs::Information::empty(),
                ));
            }
        }
        if !path.is_dir() {
            return Ok(create_response(
                &req,
                efs::NtStatus::NOT_A_DIRECTORY,
                file_id,
                efs::Information::empty(),
            ));
        }
        self.handles.insert(
            file_id,
            OpenedHandle {
                path,
                kind: OpenedHandleKind::Directory(DirectoryCursor::default()),
            },
        );
        Ok(create_response(
            &req,
            efs::NtStatus::SUCCESS,
            file_id,
            create_information(&req.create_disposition),
        ))
    }

    fn open_file(
        &mut self,
        req: efs::DeviceCreateRequest,
        path: PathBuf,
        file_id: u32,
    ) -> PduResult<Vec<SvcMessage>> {
        let existed = path.exists();
        let mut options = OpenOptions::new();
        options.read(true);
        if wants_write(&req) || req.create_disposition != efs::CreateDisposition::FILE_OPEN {
            options.write(true);
        }
        apply_disposition(&mut options, &req.create_disposition);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);

        match options.open(&path) {
            Ok(file) => {
                if file.metadata().map(|metadata| metadata.len()).unwrap_or(0)
                    > MAX_DRIVE_FILE_BYTES
                {
                    return Ok(create_response(
                        &req,
                        efs::NtStatus::ACCESS_DENIED,
                        file_id,
                        efs::Information::empty(),
                    ));
                }
                self.handles.insert(
                    file_id,
                    OpenedHandle {
                        path,
                        kind: OpenedHandleKind::File(file),
                    },
                );
                let information = if existed {
                    create_information(&req.create_disposition)
                } else {
                    efs::Information::FILE_SUPERSEDED
                };
                Ok(create_response(
                    &req,
                    efs::NtStatus::SUCCESS,
                    file_id,
                    information,
                ))
            }
            Err(e) => Ok(create_response(
                &req,
                io_status(&e),
                file_id,
                efs::Information::empty(),
            )),
        }
    }

    fn handle_read(&mut self, req: efs::DeviceReadRequest) -> PduResult<Vec<SvcMessage>> {
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Ok(read_response(&req, efs::NtStatus::NO_SUCH_FILE, Vec::new()));
        };
        let OpenedHandleKind::File(file) = &mut handle.kind else {
            return Ok(read_response(&req, efs::NtStatus::UNSUCCESSFUL, Vec::new()));
        };
        let requested = usize::try_from(req.length)
            .unwrap_or(usize::MAX)
            .min(MAX_DRIVE_IO_CHUNK);
        let mut data = vec![0; requested];
        let status = match file
            .seek(SeekFrom::Start(req.offset))
            .and_then(|_| file.read(&mut data))
        {
            Ok(len) => {
                data.truncate(len);
                efs::NtStatus::SUCCESS
            }
            Err(e) => {
                data.clear();
                io_status(&e)
            }
        };
        Ok(read_response(&req, status, data))
    }

    fn handle_write(&mut self, req: efs::DeviceWriteRequest) -> PduResult<Vec<SvcMessage>> {
        let write_len = u64::try_from(req.write_data.len()).unwrap_or(u64::MAX);
        if self.read_only
            || req.write_data.len() > MAX_DRIVE_IO_CHUNK
            || req.offset.saturating_add(write_len) > MAX_DRIVE_FILE_BYTES
            || self.written_bytes.saturating_add(write_len) > MAX_DRIVE_SESSION_WRITE_BYTES
        {
            return Ok(write_response(&req, efs::NtStatus::ACCESS_DENIED, 0));
        }
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Ok(write_response(&req, efs::NtStatus::NO_SUCH_FILE, 0));
        };
        let OpenedHandleKind::File(file) = &mut handle.kind else {
            return Ok(write_response(&req, efs::NtStatus::UNSUCCESSFUL, 0));
        };
        let mut length = 0u32;
        let status = match file
            .seek(SeekFrom::Start(req.offset))
            .and_then(|_| file.write_all(&req.write_data))
            .and_then(|_| file.flush())
        {
            Ok(()) => {
                length = u32::try_from(req.write_data.len()).unwrap_or(u32::MAX);
                self.written_bytes = self.written_bytes.saturating_add(write_len);
                efs::NtStatus::SUCCESS
            }
            Err(e) => io_status(&e),
        };
        Ok(write_response(&req, status, length))
    }

    fn handle_close(&mut self, req: efs::DeviceCloseRequest) -> PduResult<Vec<SvcMessage>> {
        self.handles.remove(&req.device_io_request.file_id);
        Ok(vec![SvcMessage::from(RdpdrPdu::DeviceCloseResponse(
            efs::DeviceCloseResponse {
                device_io_response: efs::DeviceIoResponse::new(
                    req.device_io_request,
                    efs::NtStatus::SUCCESS,
                ),
            },
        ))])
    }

    fn handle_query_information(
        &mut self,
        req: efs::ServerDriveQueryInformationRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let Some(handle) = self.handles.get(&req.device_io_request.file_id) else {
            return Ok(query_info_response(&req, efs::NtStatus::NO_SUCH_FILE, None));
        };
        if validate_confined_path(&self.root, &handle.path).is_err() {
            return Ok(query_info_response(
                &req,
                efs::NtStatus::ACCESS_DENIED,
                None,
            ));
        }
        let metadata = match fs::metadata(&handle.path) {
            Ok(metadata) => metadata,
            Err(e) => return Ok(query_info_response(&req, io_status(&e), None)),
        };
        let attrs = file_attributes(&metadata, &display_name(&handle.path, &self.label));
        let times = metadata_times(&metadata);
        let size = metadata.len().min(i64::MAX as u64) as i64;
        let buffer = match req.file_info_class_lvl {
            efs::FileInformationClassLevel::FILE_BASIC_INFORMATION => Some(
                efs::FileInformationClass::Basic(efs::FileBasicInformation {
                    creation_time: times.creation,
                    last_access_time: times.access,
                    last_write_time: times.write,
                    change_time: times.change,
                    file_attributes: attrs,
                }),
            ),
            efs::FileInformationClassLevel::FILE_STANDARD_INFORMATION => Some(
                efs::FileInformationClass::Standard(efs::FileStandardInformation {
                    allocation_size: size,
                    end_of_file: size,
                    number_of_links: 1,
                    delete_pending: efs::Boolean::False,
                    directory: if metadata.is_dir() {
                        efs::Boolean::True
                    } else {
                        efs::Boolean::False
                    },
                }),
            ),
            efs::FileInformationClassLevel::FILE_ATTRIBUTE_TAG_INFORMATION => Some(
                efs::FileInformationClass::AttributeTag(efs::FileAttributeTagInformation {
                    file_attributes: attrs,
                    reparse_tag: 0,
                }),
            ),
            _ => {
                return Ok(query_info_response(
                    &req,
                    efs::NtStatus::NOT_SUPPORTED,
                    None,
                ));
            }
        };
        Ok(query_info_response(&req, efs::NtStatus::SUCCESS, buffer))
    }

    fn handle_query_directory(
        &mut self,
        req: efs::ServerDriveQueryDirectoryRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Ok(query_dir_response(&req, efs::NtStatus::NO_SUCH_FILE, None));
        };
        let OpenedHandleKind::Directory(cursor) = &mut handle.kind else {
            return Ok(query_dir_response(
                &req,
                efs::NtStatus::NOT_A_DIRECTORY,
                None,
            ));
        };

        if req.initial_query > 0 {
            match query_entries(&self.root, &handle.path, &req.path) {
                Ok(entries) => {
                    cursor.entries = entries;
                    cursor.index = 0;
                }
                Err(_) => return Ok(query_dir_response(&req, efs::NtStatus::NO_SUCH_FILE, None)),
            }
        }

        let Some(path) = cursor.entries.get(cursor.index).cloned() else {
            let status = if req.initial_query > 0 {
                efs::NtStatus::NO_SUCH_FILE
            } else {
                efs::NtStatus::NO_MORE_FILES
            };
            return Ok(query_dir_response(&req, status, None));
        };
        cursor.index += 1;

        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(e) => return Ok(query_dir_response(&req, io_status(&e), None)),
        };
        let name = display_name(&path, &self.label);
        let info = directory_info(&req.file_info_class_lvl, &metadata, name);
        match info {
            Some(info) => Ok(query_dir_response(&req, efs::NtStatus::SUCCESS, Some(info))),
            None => Ok(query_dir_response(&req, efs::NtStatus::NOT_SUPPORTED, None)),
        }
    }

    fn handle_query_volume_information(
        &mut self,
        req: efs::ServerDriveQueryVolumeInformationRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let metadata = match fs::metadata(&self.root) {
            Ok(metadata) => metadata,
            Err(e) => return Ok(query_volume_response(&req, io_status(&e), None)),
        };
        let time = metadata_time(metadata.created().ok());
        let buffer = match req.fs_info_class_lvl {
            efs::FileSystemInformationClassLevel::FILE_FS_VOLUME_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsVolumeInformation(
                    efs::FileFsVolumeInformation {
                        volume_creation_time: time,
                        volume_serial_number: volume_serial(&self.root),
                        supports_objects: efs::Boolean::False,
                        volume_label: self.label.clone(),
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_SIZE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsSizeInformation(
                    efs::FileFsSizeInformation {
                        total_alloc_units: 1024 * 1024,
                        available_alloc_units: 1024 * 1024,
                        sectors_per_alloc_unit: 8,
                        bytes_per_sector: 512,
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsFullSizeInformation(
                    efs::FileFsFullSizeInformation {
                        total_alloc_units: 1024 * 1024,
                        caller_available_alloc_units: 1024 * 1024,
                        actual_available_alloc_units: 1024 * 1024,
                        sectors_per_alloc_unit: 8,
                        bytes_per_sector: 512,
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_ATTRIBUTE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsAttributeInformation(
                    efs::FileFsAttributeInformation {
                        file_system_attributes: efs::FileSystemAttributes::FILE_CASE_PRESERVED_NAMES
                            | efs::FileSystemAttributes::FILE_UNICODE_ON_DISK,
                        max_component_name_len: 255,
                        file_system_name: "TAOMNI".to_owned(),
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_DEVICE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsDeviceInformation(
                    efs::FileFsDeviceInformation {
                        device_type: 0x0000_0007,
                        characteristics: efs::Characteristics::FILE_REMOTE_DEVICE
                            | efs::Characteristics::FILE_DEVICE_IS_MOUNTED
                            | efs::Characteristics::FILE_VIRTUAL_VOLUME,
                    },
                ))
            }
            _ => {
                return Ok(query_volume_response(
                    &req,
                    efs::NtStatus::NOT_SUPPORTED,
                    None,
                ));
            }
        };
        Ok(query_volume_response(&req, efs::NtStatus::SUCCESS, buffer))
    }

    fn handle_set_information(
        &mut self,
        req: efs::ServerDriveSetInformationRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let status = match self.set_information_inner(&req) {
            Ok(()) => efs::NtStatus::SUCCESS,
            Err(status) => status,
        };
        let response = efs::ClientDriveSetInformationResponse::new(&req, status)
            .expect("RDPDR set-information response length fits in u32");
        Ok(vec![SvcMessage::from(
            RdpdrPdu::ClientDriveSetInformationResponse(response),
        )])
    }

    fn set_information_inner(
        &mut self,
        req: &efs::ServerDriveSetInformationRequest,
    ) -> Result<(), efs::NtStatus> {
        if self.read_only {
            return Err(efs::NtStatus::ACCESS_DENIED);
        }
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Err(efs::NtStatus::NO_SUCH_FILE);
        };
        match &req.set_buffer {
            efs::FileInformationClass::Disposition(info) if info.delete_pending != 0 => {
                let status = if handle.path.is_dir() {
                    fs::remove_dir(&handle.path)
                } else {
                    fs::remove_file(&handle.path)
                };
                status.map_err(|e| io_status(&e))
            }
            efs::FileInformationClass::Rename(info) => {
                let target = safe_join(&self.root, &info.file_name)
                    .map_err(|_| efs::NtStatus::ACCESS_DENIED)?;
                validate_confined_path(&self.root, &target)
                    .map_err(|_| efs::NtStatus::ACCESS_DENIED)?;
                fs::rename(&handle.path, &target).map_err(|e| io_status(&e))?;
                handle.path = target;
                Ok(())
            }
            efs::FileInformationClass::EndOfFile(info) => {
                let OpenedHandleKind::File(file) = &mut handle.kind else {
                    return Err(efs::NtStatus::UNSUCCESSFUL);
                };
                let target_len = info.end_of_file.max(0) as u64;
                if target_len > MAX_DRIVE_FILE_BYTES {
                    return Err(efs::NtStatus::ACCESS_DENIED);
                }
                file.set_len(target_len).map_err(|e| io_status(&e))
            }
            efs::FileInformationClass::Allocation(_) | efs::FileInformationClass::Basic(_) => {
                Ok(())
            }
            _ => Err(efs::NtStatus::NOT_SUPPORTED),
        }
    }
}

impl AsAny for LocalDriveBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl RdpdrBackend for LocalDriveBackend {
    fn handle_server_device_announce_response(
        &mut self,
        pdu: efs::ServerDeviceAnnounceResponse,
    ) -> PduResult<()> {
        if pdu.result_code == efs::NtStatus::SUCCESS {
            self.emit_status(
                "drive-ready",
                &format!(
                    "RDP drive redirection accepted by server for device {}.",
                    pdu.device_id
                ),
            );
        } else {
            self.emit_status(
                "drive-rejected",
                &format!(
                    "RDP drive redirection rejected by server for device {}: {:?}.",
                    pdu.device_id, pdu.result_code
                ),
            );
        }
        Ok(())
    }

    fn handle_scard_call(
        &mut self,
        _req: efs::DeviceControlRequest<ScardIoCtlCode>,
        _call: ScardCall,
    ) -> PduResult<()> {
        Ok(())
    }

    fn handle_drive_io_request(
        &mut self,
        req: efs::ServerDriveIoRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        match req {
            efs::ServerDriveIoRequest::ServerCreateDriveRequest(req) => self.handle_create(req),
            efs::ServerDriveIoRequest::DeviceReadRequest(req) => self.handle_read(req),
            efs::ServerDriveIoRequest::DeviceWriteRequest(req) => self.handle_write(req),
            efs::ServerDriveIoRequest::DeviceCloseRequest(req) => self.handle_close(req),
            efs::ServerDriveIoRequest::ServerDriveQueryInformationRequest(req) => {
                self.handle_query_information(req)
            }
            efs::ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(req) => {
                self.handle_query_directory(req)
            }
            efs::ServerDriveIoRequest::ServerDriveQueryVolumeInformationRequest(req) => {
                self.handle_query_volume_information(req)
            }
            efs::ServerDriveIoRequest::ServerDriveSetInformationRequest(req) => {
                self.handle_set_information(req)
            }
            efs::ServerDriveIoRequest::DeviceControlRequest(req) => Ok(vec![SvcMessage::from(
                RdpdrPdu::DeviceControlResponse(efs::DeviceControlResponse {
                    device_io_reply: efs::DeviceIoResponse::new(req.header, efs::NtStatus::SUCCESS),
                    output_buffer: None,
                }),
            )]),
            efs::ServerDriveIoRequest::ServerDriveNotifyChangeDirectoryRequest(_)
            | efs::ServerDriveIoRequest::ServerDriveLockControlRequest(_) => Ok(Vec::new()),
        }
    }
}

pub fn build_drive_channel(
    options: &DriveRedirectOpt,
    status_tx: Option<SessionOutputSender>,
) -> Result<Option<IronRdpdr>, String> {
    if !options.enabled {
        return Ok(None);
    }
    let backend = LocalDriveBackend::new_with_policy(
        &options.path,
        &options.label,
        status_tx,
        options.read_only,
    )?;
    let label = backend.label.clone();
    let computer_name = local_computer_name();
    Ok(Some(
        IronRdpdr::new(Box::new(backend), computer_name)
            .with_drives(Some(vec![(DEFAULT_DRIVE_ID, label)])),
    ))
}

fn local_computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "taomni".to_owned())
}

fn sanitize_drive_label(label: &str, root: &Path) -> String {
    let raw = label.trim();
    let fallback = root
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("taomni");
    let source = if raw.is_empty() { fallback } else { raw };
    let sanitized: String = source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(32)
        .collect();
    if sanitized.is_empty() {
        "taomni".to_owned()
    } else {
        sanitized
    }
}

fn wants_write(req: &efs::DeviceCreateRequest) -> bool {
    req.desired_access.intersects(
        efs::DesiredAccess::FILE_WRITE_DATA_OR_FILE_ADD_FILE
            | efs::DesiredAccess::FILE_APPEND_DATA_OR_FILE_ADD_SUBDIRECTORY
            | efs::DesiredAccess::FILE_WRITE_EA
            | efs::DesiredAccess::FILE_WRITE_ATTRIBUTES
            | efs::DesiredAccess::DELETE
            | efs::DesiredAccess::GENERIC_WRITE
            | efs::DesiredAccess::GENERIC_ALL,
    )
}

fn apply_disposition(options: &mut OpenOptions, disposition: &efs::CreateDisposition) {
    if *disposition == efs::CreateDisposition::FILE_CREATE {
        options.create_new(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_OPEN_IF {
        options.create(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_SUPERSEDE {
        options.create(true).truncate(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_OVERWRITE {
        options.truncate(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_OVERWRITE_IF {
        options.create(true).truncate(true).write(true);
    }
}

fn create_information(disposition: &efs::CreateDisposition) -> efs::Information {
    if *disposition == efs::CreateDisposition::FILE_OPEN
        || *disposition == efs::CreateDisposition::FILE_OPEN_IF
    {
        efs::Information::FILE_OPENED
    } else if *disposition == efs::CreateDisposition::FILE_OVERWRITE
        || *disposition == efs::CreateDisposition::FILE_OVERWRITE_IF
    {
        efs::Information::FILE_OVERWRITTEN
    } else {
        efs::Information::FILE_SUPERSEDED
    }
}

fn create_response(
    req: &efs::DeviceCreateRequest,
    status: efs::NtStatus,
    file_id: u32,
    information: efs::Information,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(RdpdrPdu::DeviceCreateResponse(
        efs::DeviceCreateResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            file_id,
            information,
        },
    ))]
}

fn read_response(
    req: &efs::DeviceReadRequest,
    status: efs::NtStatus,
    read_data: Vec<u8>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(RdpdrPdu::DeviceReadResponse(
        efs::DeviceReadResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            read_data,
        },
    ))]
}

fn write_response(
    req: &efs::DeviceWriteRequest,
    status: efs::NtStatus,
    length: u32,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(RdpdrPdu::DeviceWriteResponse(
        efs::DeviceWriteResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            length,
        },
    ))]
}

fn query_info_response(
    req: &efs::ServerDriveQueryInformationRequest,
    status: efs::NtStatus,
    buffer: Option<efs::FileInformationClass>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(
        RdpdrPdu::ClientDriveQueryInformationResponse(efs::ClientDriveQueryInformationResponse {
            device_io_response: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            buffer,
        }),
    )]
}

fn query_dir_response(
    req: &efs::ServerDriveQueryDirectoryRequest,
    status: efs::NtStatus,
    buffer: Option<efs::FileInformationClass>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(
        RdpdrPdu::ClientDriveQueryDirectoryResponse(efs::ClientDriveQueryDirectoryResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            buffer,
        }),
    )]
}

fn query_volume_response(
    req: &efs::ServerDriveQueryVolumeInformationRequest,
    status: efs::NtStatus,
    buffer: Option<efs::FileSystemInformationClass>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(
        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
            efs::ClientDriveQueryVolumeInformationResponse {
                device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
                buffer,
            },
        ),
    )]
}

fn io_status(error: &std::io::Error) -> efs::NtStatus {
    match error.kind() {
        std::io::ErrorKind::NotFound => efs::NtStatus::NO_SUCH_FILE,
        std::io::ErrorKind::PermissionDenied => efs::NtStatus::ACCESS_DENIED,
        _ => efs::NtStatus::UNSUCCESSFUL,
    }
}

#[derive(Clone, Copy)]
struct FileTimes {
    creation: i64,
    access: i64,
    write: i64,
    change: i64,
}

fn metadata_times(metadata: &fs::Metadata) -> FileTimes {
    let creation = metadata_time(metadata.created().ok());
    let access = metadata_time(metadata.accessed().ok());
    let write = metadata_time(metadata.modified().ok());
    FileTimes {
        creation,
        access,
        write,
        change: write.max(creation),
    }
}

fn metadata_time(time: Option<SystemTime>) -> i64 {
    let Some(time) = time else { return 0 };
    let Ok(duration) = time.duration_since(UNIX_EPOCH) else {
        return 0;
    };
    let ticks = (duration.as_secs().saturating_add(11_644_473_600)).saturating_mul(10_000_000)
        + u64::from(duration.subsec_nanos() / 100);
    ticks.min(i64::MAX as u64) as i64
}

fn file_attributes(metadata: &fs::Metadata, name: &str) -> efs::FileAttributes {
    let mut attrs = efs::FileAttributes::empty();
    if metadata.is_dir() {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_DIRECTORY;
    } else {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_ARCHIVE;
    }
    if metadata.permissions().readonly() {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_READONLY;
    }
    if name.starts_with('.') && name.len() > 1 {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_HIDDEN;
    }
    attrs
}

fn display_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn directory_info(
    class: &efs::FileInformationClassLevel,
    metadata: &fs::Metadata,
    name: String,
) -> Option<efs::FileInformationClass> {
    let attrs = file_attributes(metadata, &name);
    let times = metadata_times(metadata);
    let size = metadata.len().min(i64::MAX as u64) as i64;
    if *class == efs::FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION {
        Some(efs::FileInformationClass::BothDirectory(
            efs::FileBothDirectoryInformation::new(
                times.creation,
                times.access,
                times.write,
                times.change,
                size,
                attrs,
                name,
            ),
        ))
    } else if *class == efs::FileInformationClassLevel::FILE_FULL_DIRECTORY_INFORMATION {
        Some(efs::FileInformationClass::FullDirectory(
            efs::FileFullDirectoryInformation::new(
                times.creation,
                times.access,
                times.write,
                times.change,
                size,
                attrs,
                name,
            ),
        ))
    } else if *class == efs::FileInformationClassLevel::FILE_NAMES_INFORMATION {
        Some(efs::FileInformationClass::Names(
            efs::FileNamesInformation::new(name),
        ))
    } else if *class == efs::FileInformationClassLevel::FILE_DIRECTORY_INFORMATION {
        Some(efs::FileInformationClass::Directory(
            efs::FileDirectoryInformation::new(
                times.creation,
                times.access,
                times.write,
                times.change,
                size,
                attrs,
                name,
            ),
        ))
    } else {
        None
    }
}

fn query_entries(root: &Path, base: &Path, query: &str) -> Result<Vec<PathBuf>, String> {
    let query = query.trim_end_matches('\0').replace('\\', "/");
    if query.is_empty() || query == "*" {
        return list_directory(root, base);
    }
    if query.contains('*') {
        let (parent, pattern) = split_query_pattern(&query);
        let dir = safe_join_from(root, base, parent)?;
        validate_confined_path(root, &dir)?;
        let mut entries = list_directory(root, &dir)?;
        if pattern != "*" {
            let prefix = pattern.trim_end_matches('*');
            entries.retain(|entry| display_name(entry, "").starts_with(prefix));
        }
        return Ok(entries);
    }
    let path = safe_join_from(root, base, &query)?;
    validate_confined_path(root, &path)?;
    if path.exists() {
        Ok(vec![path])
    } else {
        Ok(Vec::new())
    }
}

fn split_query_pattern(query: &str) -> (&str, &str) {
    match query.rfind('/') {
        Some(index) => (&query[..index], &query[index + 1..]),
        None => ("", query),
    }
}

fn list_directory(root: &Path, dir: &Path) -> Result<Vec<PathBuf>, String> {
    validate_confined_path(root, dir)?;
    let mut entries = fs::read_dir(dir)
        .map_err(|e| format!("rdpdr: read directory '{}': {}", dir.display(), e))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| validate_confined_path(root, path).is_ok())
        .collect::<Vec<_>>();
    entries.sort_by_key(|path| display_name(path, ""));
    Ok(entries)
}

fn volume_serial(root: &Path) -> u32 {
    root.to_string_lossy()
        .bytes()
        .fold(0x4e4d_5244u32, |acc, b| acc.rotate_left(5) ^ u32::from(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let h = RdpdrHeader {
            component: RDPDR_CTYP_CORE,
            packet_id: PAKID_CORE_DEVICE_IOREQUEST,
        };
        let buf = h.encode();
        let h2 = RdpdrHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn client_name_carries_utf16() {
        let buf = build_client_name("HostName");
        // Unicode flag = 1
        assert_eq!(u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]), 1);
        // Length includes null terminator (HostName == 8 chars + NUL == 18 bytes).
        let name_len = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        assert_eq!(name_len as usize, "HostName".chars().count() * 2 + 2);
    }

    #[test]
    fn device_list_round_trip_one_filesystem() {
        let dev = AnnouncedDevice {
            device_id: 1,
            device_type: RDPDR_DTYP_FILESYSTEM,
            preferred_dos_name: "TAOMNI".into(),
            device_data: b"shared\0".to_vec(),
        };
        let buf = build_device_list_announce(&[dev.clone()]).unwrap();
        let header = RdpdrHeader::parse(&buf).unwrap();
        assert_eq!(header.packet_id, PAKID_CORE_DEVICELIST_ANNOUNCE);
        let count = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        assert_eq!(count, 1);
        let dtype = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        assert_eq!(dtype, RDPDR_DTYP_FILESYSTEM);
    }

    #[test]
    fn device_list_rejects_long_dos_name() {
        let dev = AnnouncedDevice {
            device_id: 1,
            device_type: RDPDR_DTYP_FILESYSTEM,
            preferred_dos_name: "TOOLONGNAME".into(),
            device_data: vec![],
        };
        assert!(build_device_list_announce(&[dev]).is_err());
    }

    #[test]
    fn io_request_header_round_trip() {
        let h = DeviceIoRequestHeader {
            device_id: 1,
            file_id: 0xCAFE,
            completion_id: 99,
            major: IRP_MJ_READ,
            minor: 0,
        };
        let buf = h.encode();
        let h2 = DeviceIoRequestHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn io_request_header_rejects_truncated() {
        assert!(DeviceIoRequestHeader::parse(&[0u8; 10]).is_err());
    }

    #[test]
    fn safe_join_blocks_dot_dot() {
        let root = Path::new("/var/lib/taomni");
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "/../etc/passwd").is_err());
        assert!(safe_join(root, "subdir/../../escape").is_err());
    }

    #[test]
    fn safe_join_allows_internal_traversal() {
        let root = Path::new("/data");
        let p = safe_join(root, "/sub/dir/file.txt").unwrap();
        assert_eq!(p, PathBuf::from("/data/sub/dir/file.txt"));
        let p2 = safe_join(root, "sub/../sub/x").unwrap();
        assert_eq!(p2, PathBuf::from("/data/sub/x"));
    }

    #[test]
    fn safe_join_normalizes_backslashes() {
        let root = Path::new("/data");
        let p = safe_join(root, r"sub\dir\file").unwrap();
        assert_eq!(p, PathBuf::from("/data/sub/dir/file"));
    }

    fn io_request(
        file_id: u32,
        completion_id: u32,
        major_function: efs::MajorFunction,
    ) -> efs::DeviceIoRequest {
        efs::DeviceIoRequest {
            device_id: DEFAULT_DRIVE_ID,
            file_id,
            completion_id,
            major_function,
            minor_function: efs::MinorFunction::from(0),
        }
    }

    fn create_request(path: &str) -> efs::DeviceCreateRequest {
        efs::DeviceCreateRequest {
            device_io_request: io_request(0, 1, efs::MajorFunction::Create),
            desired_access: efs::DesiredAccess::GENERIC_READ | efs::DesiredAccess::GENERIC_WRITE,
            allocation_size: 0,
            file_attributes: efs::FileAttributes::empty(),
            shared_access: efs::SharedAccess::FILE_SHARE_READ
                | efs::SharedAccess::FILE_SHARE_WRITE
                | efs::SharedAccess::FILE_SHARE_DELETE,
            create_disposition: efs::CreateDisposition::FILE_OPEN_IF,
            create_options: efs::CreateOptions::FILE_NON_DIRECTORY_FILE,
            path: path.to_owned(),
        }
    }

    #[test]
    fn local_drive_backend_writes_inside_mapped_root() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = LocalDriveBackend::new(dir.path(), "shared").unwrap();

        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
                create_request("hello.txt"),
            ))
            .unwrap();
        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::DeviceWriteRequest(
                efs::DeviceWriteRequest {
                    device_io_request: io_request(DEFAULT_DRIVE_ID, 2, efs::MajorFunction::Write),
                    offset: 0,
                    write_data: b"abc".to_vec(),
                },
            ))
            .unwrap();

        assert_eq!(fs::read(dir.path().join("hello.txt")).unwrap(), b"abc");
    }

    #[test]
    fn local_drive_backend_rejects_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = LocalDriveBackend::new(dir.path(), "shared").unwrap();

        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
                create_request("../escape.txt"),
            ))
            .unwrap();

        assert!(backend.handles.is_empty());
        assert!(!dir.path().parent().unwrap().join("escape.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn local_drive_backend_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("outside")).unwrap();
        let mut backend = LocalDriveBackend::new(root.path(), "shared").unwrap();

        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
                create_request("outside/escape.txt"),
            ))
            .unwrap();

        assert!(backend.handles.is_empty());
        assert!(!outside.path().join("escape.txt").exists());
    }

    #[test]
    fn local_drive_backend_read_only_policy_denies_mutating_open() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend =
            LocalDriveBackend::new_with_policy(dir.path(), "shared", None, true).unwrap();

        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
                create_request("blocked.txt"),
            ))
            .unwrap();

        assert!(backend.handles.is_empty());
        assert!(!dir.path().join("blocked.txt").exists());
    }

    #[test]
    fn local_drive_backend_enforces_session_write_quota() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = LocalDriveBackend::new(dir.path(), "shared").unwrap();
        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
                create_request("quota.txt"),
            ))
            .unwrap();
        backend.written_bytes = MAX_DRIVE_SESSION_WRITE_BYTES;

        backend
            .handle_drive_io_request(efs::ServerDriveIoRequest::DeviceWriteRequest(
                efs::DeviceWriteRequest {
                    device_io_request: io_request(DEFAULT_DRIVE_ID, 2, efs::MajorFunction::Write),
                    offset: 0,
                    write_data: b"blocked".to_vec(),
                },
            ))
            .unwrap();

        assert_eq!(fs::read(dir.path().join("quota.txt")).unwrap(), b"");
    }

    #[test]
    fn build_drive_channel_ignores_disabled_option() {
        let options = DriveRedirectOpt {
            enabled: false,
            label: "shared".into(),
            path: String::new(),
            read_only: true,
        };
        assert!(build_drive_channel(&options, None).unwrap().is_none());
    }

    #[tokio::test]
    async fn local_drive_backend_reports_server_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let (mut handle, tx, _ctrl_rx) = crate::rdp::session::RdpSessionHandle::new();
        let mut backend =
            LocalDriveBackend::new_with_status(dir.path(), "shared", Some(tx)).unwrap();

        backend
            .handle_server_device_announce_response(efs::ServerDeviceAnnounceResponse {
                device_id: DEFAULT_DRIVE_ID,
                result_code: efs::NtStatus::SUCCESS,
            })
            .unwrap();

        match handle.next_outgoing().await.unwrap() {
            SessionOutput::Text(text) => {
                assert!(text.contains(r#""stage":"drive-ready""#));
                assert!(text.contains("accepted by server"));
            }
            SessionOutput::Channel { .. } => panic!("expected drive status text"),
        }
    }
}
