//! CLIPRDR clipboard bridge for the RDP server (text only).
//!
//! Bridges the host OS clipboard (`arboard`) with the RDP client's clipboard in
//! both directions, for `CF_UNICODETEXT`:
//!
//! - **host → client**: a background thread polls the host clipboard; when its
//!   text changes we push [`ClipboardMessage::SendInitiateCopy`] advertising
//!   `CF_UNICODETEXT`. When the client then asks for the data
//!   ([`CliprdrBackend::on_format_data_request`]) we answer with
//!   [`ClipboardMessage::SendFormatData`] carrying the UTF-16 text.
//! - **client → host**: when the client copies
//!   ([`CliprdrBackend::on_remote_copy`] advertising `CF_UNICODETEXT`) we ask for
//!   it via [`ClipboardMessage::SendInitiatePaste`]; the data arrives in
//!   [`CliprdrBackend::on_format_data_response`] and we set the host clipboard.
//!
//! Images and files are out of scope; only Unicode text crosses the bridge.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ironrdp::cliprdr::backend::{
    ClipboardMessage, ClipboardMessageProxy, CliprdrBackend, CliprdrBackendFactory,
};
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp::core::{AsAny, IntoOwned as _};
use ironrdp::server::tokio::sync::mpsc::UnboundedSender;
use ironrdp::server::{CliprdrServerFactory, ServerEvent, ServerEventSender};

use crate::servers::engine::LogEmitter;

/// Shared host-clipboard text, guarded so the poll thread and the backend agree
/// on "what the host currently holds" without re-reading arboard on every event.
#[derive(Default)]
struct Shared {
    /// Last text we know the host clipboard holds (set by the poller, and by us
    /// after applying a client paste so we don't echo it back).
    host_text: Mutex<Option<String>>,
    /// At most one host poller belongs to the current CLIPRDR connection.
    active_poller: Mutex<Option<Arc<AtomicBool>>>,
}

/// Factory: the server rebuilds a backend per connection, so the factory holds
/// the event sender (set by the server) and the shared state.
pub(crate) struct ClipboardFactory {
    log: LogEmitter,
    sender: Option<UnboundedSender<ServerEvent>>,
    shared: Arc<Shared>,
}

impl ClipboardFactory {
    pub(crate) fn new(log: LogEmitter) -> Self {
        Self {
            log,
            sender: None,
            shared: Arc::new(Shared::default()),
        }
    }
}

impl ServerEventSender for ClipboardFactory {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        self.sender = Some(sender);
    }
}

impl CliprdrBackendFactory for ClipboardFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        let proxy = EventProxy {
            sender: self.sender.clone(),
        };
        Box::new(ClipboardBackend::new(
            self.log.clone(),
            proxy,
            Arc::clone(&self.shared),
        ))
    }
}

impl CliprdrServerFactory for ClipboardFactory {}

/// Wraps the server event sender so the backend (and its poll thread) can emit
/// [`ClipboardMessage`]s without holding the sender type directly.
#[derive(Clone, Debug)]
struct EventProxy {
    sender: Option<UnboundedSender<ServerEvent>>,
}

impl ClipboardMessageProxy for EventProxy {
    fn send_clipboard_message(&self, message: ClipboardMessage) {
        if let Some(tx) = &self.sender {
            let _ = tx.send(ServerEvent::Clipboard(message));
        }
    }
}

const CF_UNICODETEXT: ClipboardFormatId = ClipboardFormatId::CF_UNICODETEXT;
const MAX_CLIPBOARD_TEXT_BYTES: usize = 4 * 1024 * 1024;

fn unicode_payload_within_limit(text: &str) -> bool {
    text.encode_utf16()
        .count()
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(2))
        .is_some_and(|bytes| bytes <= MAX_CLIPBOARD_TEXT_BYTES)
}

struct ClipboardBackend {
    log: LogEmitter,
    proxy: EventProxy,
    shared: Arc<Shared>,
    temp_dir: String,
    /// Whether the remote currently advertises text (drives paste requests).
    remote_has_text: bool,
    /// Guards against spawning more than one host-clipboard poll thread.
    poller_started: bool,
    poller_cancel: Arc<AtomicBool>,
}

// `CliprdrBackend` requires `Debug`; the backend holds non-`Debug` handles
// (LogEmitter, arboard state behind the proxy), so provide a minimal impl.
impl core::fmt::Debug for ClipboardBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ClipboardBackend")
            .field("remote_has_text", &self.remote_has_text)
            .finish()
    }
}

// `CliprdrBackend: AsAny`; we don't use the downcast, so a direct impl suffices.
impl AsAny for ClipboardBackend {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl ClipboardBackend {
    fn new(log: LogEmitter, proxy: EventProxy, shared: Arc<Shared>) -> Self {
        Self {
            log,
            proxy,
            shared,
            temp_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            remote_has_text: false,
            poller_started: false,
            poller_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start polling the host clipboard for text changes, emitting an
    /// `initiate_copy` whenever it changes so the client knows fresh text is
    /// available. Idempotent.
    fn start_host_poller(&mut self) {
        if self.poller_started {
            return;
        }
        self.poller_started = true;

        if let Ok(mut active) = self.shared.active_poller.lock() {
            if let Some(previous) = active.replace(Arc::clone(&self.poller_cancel)) {
                previous.store(true, Ordering::Release);
            }
        }

        let proxy = self.proxy.clone();
        let shared = Arc::clone(&self.shared);
        let log = self.log.clone();
        let cancel = Arc::clone(&self.poller_cancel);
        std::thread::Builder::new()
            .name("rdp-cliprdr-poll".to_string())
            .spawn(move || {
                let mut clipboard = match arboard::Clipboard::new() {
                    Ok(c) => c,
                    Err(e) => {
                        log.line(format!("clipboard: host access unavailable: {}", e));
                        return;
                    }
                };
                let mut warned_oversized = false;
                while !cancel.load(Ordering::Acquire) {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if cancel.load(Ordering::Acquire) {
                        break;
                    }
                    let current = clipboard.get_text().ok();
                    let mut guard = match shared.host_text.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    if current
                        .as_deref()
                        .is_some_and(|text| !unicode_payload_within_limit(text))
                    {
                        *guard = None;
                        drop(guard);
                        proxy
                            .send_clipboard_message(ClipboardMessage::SendInitiateCopy(Vec::new()));
                        if !warned_oversized {
                            warned_oversized = true;
                            log.line(format!(
                                "clipboard: local text exceeds {} MiB and will not be shared",
                                MAX_CLIPBOARD_TEXT_BYTES / (1024 * 1024)
                            ));
                        }
                        continue;
                    }
                    warned_oversized = false;
                    if current.is_some() && *guard != current {
                        *guard = current;
                        drop(guard);
                        proxy.send_clipboard_message(ClipboardMessage::SendInitiateCopy(vec![
                            ClipboardFormat::new(CF_UNICODETEXT),
                        ]));
                    }
                }
            })
            .ok();
    }

    fn set_host_text(&self, text: String) {
        if !unicode_payload_within_limit(&text) {
            self.log.line(format!(
                "clipboard: rejected remote text larger than {} MiB",
                MAX_CLIPBOARD_TEXT_BYTES / (1024 * 1024)
            ));
            return;
        }
        // Remember it first so the poller doesn't bounce it back to the client.
        if let Ok(mut guard) = self.shared.host_text.lock() {
            *guard = Some(text.clone());
        }
        match arboard::Clipboard::new().and_then(|mut c| c.set_text(text)) {
            Ok(()) => {}
            Err(e) => self
                .log
                .line(format!("clipboard: failed to set host text: {}", e)),
        }
    }
}

impl Drop for ClipboardBackend {
    fn drop(&mut self) {
        self.poller_cancel.store(true, Ordering::Release);
        if let Ok(mut active) = self.shared.active_poller.lock()
            && active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &self.poller_cancel))
        {
            *active = None;
        }
        self.log.line("clipboard channel stopped");
    }
}

impl CliprdrBackend for ClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        // Long format names only; no file transfer.
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {
        self.log.line("clipboard channel ready");
        self.start_host_poller();
    }

    fn on_request_format_list(&mut self) {
        // Advertise current host text (if any) at startup so an already-populated
        // host clipboard is immediately pasteable on the client.
        let has_text = self
            .shared
            .host_text
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if has_text {
            self.proxy
                .send_clipboard_message(ClipboardMessage::SendInitiateCopy(vec![
                    ClipboardFormat::new(CF_UNICODETEXT),
                ]));
        }
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        // The client copied something. If it offers Unicode text, pull it.
        self.remote_has_text = available_formats.iter().any(|f| f.id == CF_UNICODETEXT);
        if self.remote_has_text {
            self.proxy
                .send_clipboard_message(ClipboardMessage::SendInitiatePaste(CF_UNICODETEXT));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        // The client wants the host's clipboard data in `request.format`.
        let response = if request.format == CF_UNICODETEXT {
            let text = self
                .shared
                .host_text
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .filter(|text| unicode_payload_within_limit(text))
                .unwrap_or_default();
            FormatDataResponse::new_unicode_string(&text).into_owned()
        } else {
            FormatDataResponse::new_error().into_owned()
        };
        self.proxy
            .send_clipboard_message(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        // The client sent us the text it had copied — set it on the host.
        if response.is_error() {
            return;
        }
        if response.data().len() > MAX_CLIPBOARD_TEXT_BYTES {
            self.log.line(format!(
                "clipboard: rejected remote payload larger than {} MiB",
                MAX_CLIPBOARD_TEXT_BYTES / (1024 * 1024)
            ));
            return;
        }
        match response.to_unicode_string() {
            Ok(text) => self.set_host_text(text),
            Err(e) => self
                .log
                .line(format!("clipboard: bad unicode from client: {}", e)),
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {
        // File transfer is out of scope (text only).
    }

    fn on_file_contents_response(
        &mut self,
        _response: ironrdp::cliprdr::pdu::FileContentsResponse<'_>,
    ) {
    }

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

#[cfg(test)]
mod tests {
    use super::{MAX_CLIPBOARD_TEXT_BYTES, unicode_payload_within_limit};

    #[test]
    fn clipboard_limit_counts_encoded_unicode_payload() {
        let max_ascii_chars = (MAX_CLIPBOARD_TEXT_BYTES - 2) / 2;
        assert!(unicode_payload_within_limit(&"a".repeat(max_ascii_chars)));
        assert!(!unicode_payload_within_limit(
            &"a".repeat(max_ascii_chars + 1)
        ));
        // A supplementary character occupies a UTF-16 surrogate pair.
        assert!(!unicode_payload_within_limit(&"😀".repeat(max_ascii_chars)));
    }
}
