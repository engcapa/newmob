//! Swarm file & folder transfer (v3).
//!
//! Replaces the old base64-over-JSON `file-*` engine. A file is described by a
//! content-addressed [`Manifest`] (per-piece SHA-256). The origin seeds; every
//! accepting peer leeches *and* re-seeds the pieces it already holds, so members
//! of a group trade pieces with each other and the origin's uplink is shared.
//!
//! Memory is bounded by design: leechers cap outstanding requests (a window),
//! seeders serve one piece per request via positioned reads, and piece bytes
//! ride a *bounded* binary data channel (see `transport`), so a fast disk can
//! never outrun the network into an unbounded queue. Each received piece is
//! verified against its manifest hash before it is written.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

use crate::lanchat::protocol::{Envelope, PIECE_SIZE, frame, wire};
use crate::lanchat::{LanChatState, events, transport};

/// Max pieces requested but not yet received, across all peers, per transfer.
const MAX_INFLIGHT: usize = 32;
/// Max outstanding requests to a single peer (load-spreads across sources).
const PER_PEER_WINDOW: usize = 8;
/// How long a requested piece may be outstanding before we re-request it.
const PIECE_TIMEOUT: Duration = Duration::from_secs(10);
/// Drive-loop wakeup ceiling so timeouts are reaped even with no events.
const DRIVE_TICK: Duration = Duration::from_millis(500);

/// Progress / state update sent to the UI on `lanchat://transfer`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    /// "send" | "recv".
    pub direction: String,
    pub name: String,
    pub size: u64,
    pub transferred: u64,
    pub rate: f64,
    pub eta: f64,
    /// "offering" | "active" | "paused" | "done" | "failed" | "cancelled" | "rejected".
    pub state: String,
    pub conv_id: String,
}

fn emit_progress(app: &AppHandle, p: &TransferProgress) {
    if let Err(e) = app.emit(events::TRANSFER, p) {
        log::warn!("lanchat: emit transfer progress failed: {e}");
    }
}

fn rate_eta(transferred: u64, size: u64, started: Instant) -> (f64, f64) {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let rate = transferred as f64 / elapsed;
    let eta = if rate > 0.0 && size > transferred {
        (size - transferred) as f64 / rate
    } else {
        0.0
    };
    (rate, eta)
}

/* ------------------------------- bitfield -------------------------------- */

/// Which pieces of a file a node holds. Packed MSB-first for the wire.
#[derive(Clone)]
pub struct Bitfield {
    bits: Vec<bool>,
}

impl Bitfield {
    fn empty(n: usize) -> Self {
        Self {
            bits: vec![false; n],
        }
    }
    fn full(n: usize) -> Self {
        Self {
            bits: vec![true; n],
        }
    }
    fn set(&mut self, i: usize) {
        if let Some(b) = self.bits.get_mut(i) {
            *b = true;
        }
    }
    fn get(&self, i: usize) -> bool {
        self.bits.get(i).copied().unwrap_or(false)
    }
    fn count(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }
    fn is_complete(&self) -> bool {
        !self.bits.is_empty() && self.bits.iter().all(|b| *b)
    }
    /// Packed bytes (MSB-first), base64-encoded for `swarm-bitfield`.
    fn to_base64(&self) -> String {
        let mut bytes = vec![0u8; self.bits.len().div_ceil(8)];
        for (i, b) in self.bits.iter().enumerate() {
            if *b {
                bytes[i / 8] |= 0x80 >> (i % 8);
            }
        }
        BASE64.encode(bytes)
    }
    fn from_base64(s: &str, n: usize) -> Self {
        let mut bf = Self::empty(n);
        if let Ok(bytes) = BASE64.decode(s) {
            for i in 0..n {
                if bytes
                    .get(i / 8)
                    .map(|b| b & (0x80 >> (i % 8)) != 0)
                    .unwrap_or(false)
                {
                    bf.bits[i] = true;
                }
            }
        }
        bf
    }
}

/* ------------------------------- manifest -------------------------------- */

/// Content-addressed description of a file: a per-piece SHA-256 list whose own
/// hash is the stable `file_id` (so the same bytes always map to the same id).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub piece_size: u32,
    /// Lowercase-hex SHA-256 of each piece, in order.
    pub pieces: Vec<String>,
}

impl Manifest {
    fn piece_count(&self) -> usize {
        self.pieces.len()
    }
    /// Byte length of piece `i` (the last piece may be short).
    fn piece_len(&self, i: usize) -> usize {
        let ps = self.piece_size as u64;
        let start = i as u64 * ps;
        if start >= self.size {
            0
        } else {
            (self.size - start).min(ps) as usize
        }
    }
    fn to_json(&self) -> serde_json::Value {
        json!({
            "fileId": self.file_id, "name": self.name, "size": self.size,
            "pieceSize": self.piece_size, "pieces": self.pieces,
        })
    }
    fn from_json(v: &serde_json::Value) -> Option<Self> {
        let pieces: Vec<String> = v
            .get("pieces")?
            .as_array()?
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
        Some(Self {
            file_id: v.get("fileId")?.as_str()?.to_string(),
            name: v.get("name")?.as_str()?.to_string(),
            size: v.get("size")?.as_u64()?,
            piece_size: v.get("pieceSize")?.as_u64()? as u32,
            pieces,
        })
    }
}

/// Read `path` and build its manifest (blocking — call via `spawn_blocking`).
fn build_manifest(
    path: &std::path::Path,
    name: String,
    piece_size: usize,
) -> Result<Manifest, String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut pieces = Vec::new();
    let mut id_hasher = Sha256::new();
    let mut buf = vec![0u8; piece_size];
    loop {
        let mut filled = 0;
        while filled < piece_size {
            let n = file
                .read(&mut buf[filled..])
                .map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        let mut h = Sha256::new();
        h.update(&buf[..filled]);
        let hex = hex::encode(h.finalize());
        id_hasher.update(hex.as_bytes());
        pieces.push(hex);
        if filled < piece_size {
            break;
        }
    }
    // Empty file: one zero-length piece so there is always something to "have".
    if pieces.is_empty() {
        let mut h = Sha256::new();
        h.update(b"");
        let hex = hex::encode(h.finalize());
        id_hasher.update(hex.as_bytes());
        pieces.push(hex);
    }
    let file_id = hex::encode(id_hasher.finalize());
    Ok(Manifest {
        file_id,
        name,
        size,
        piece_size: piece_size as u32,
        pieces,
    })
}

/* ------------------------------ swarm state ------------------------------ */

/// Inbound offer awaiting the local user's accept/reject.
#[derive(Clone)]
pub struct OfferInfo {
    pub manifest: Manifest,
    pub from: String,
    pub conv_id: String,
    pub group_id: Option<String>,
    /// "file" | "dir".
    pub kind: String,
    /// Other swarm peers (group members); empty for a 1:1 offer.
    pub members: Vec<String>,
    pub mime: String,
}

/// Mutable scheduling state, behind one async mutex to avoid lock ordering.
struct SwarmInner {
    have: Bitfield,
    /// What each swarm peer holds (origin starts full).
    peers: HashMap<String, Bitfield>,
    /// piece -> (peer we asked, deadline).
    inflight: HashMap<u32, (String, Instant)>,
}

/// One active transfer on this node (origin seed or leecher), keyed by file id.
pub struct SwarmFile {
    pub manifest: Manifest,
    pub conv_id: String,
    pub group_id: Option<String>,
    /// "send" = we originated (seed only); "recv" = we are leeching.
    pub direction: String,
    pub save_path: PathBuf,
    pub temp_path: PathBuf,
    /// The origin we leech from (`None` when this node *is* the origin). Used to
    /// tell a global abort (origin cancelled) from a peer merely leaving.
    origin: Option<String>,
    file: std::sync::Mutex<Option<Arc<std::fs::File>>>,
    inner: Mutex<SwarmInner>,
    cancelled: AtomicBool,
    paused: AtomicBool,
    resume: Notify,
    /// Wakes the leecher drive loop on piece / have / new-peer events.
    wake: Notify,
    started: Instant,
    finalized: AtomicBool,
}

impl SwarmFile {
    fn file_handle(&self) -> Option<Arc<std::fs::File>> {
        self.file.lock().unwrap().clone()
    }
    fn set_file(&self, f: Arc<std::fs::File>) {
        *self.file.lock().unwrap() = Some(f);
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    async fn wait_while_paused(&self) {
        while self.is_paused() && !self.is_cancelled() {
            self.resume.notified().await;
        }
    }
    /// Bytes "transferred" for the progress card: for a leecher this is what we
    /// hold; for an origin it is the slowest accepted peer (so it reads 100%
    /// only when every member finished).
    async fn transferred_bytes(&self) -> u64 {
        let inner = self.inner.lock().await;
        let ps = self.manifest.piece_size as u64;
        let pieces = if self.direction == "recv" {
            inner.have.count() as u64
        } else if inner.peers.is_empty() {
            0
        } else {
            inner
                .peers
                .values()
                .map(|b| b.count() as u64)
                .min()
                .unwrap_or(0)
        };
        (pieces * ps).min(self.manifest.size)
    }
    fn progress_state(&self, transferred: u64) -> &'static str {
        if self.is_cancelled() {
            "cancelled"
        } else if self.is_paused() {
            "paused"
        } else if self.direction == "send" && transferred == 0 {
            "offering"
        } else {
            "active"
        }
    }
    async fn emit(&self, app: &AppHandle, state_override: Option<&str>) {
        let transferred = self.transferred_bytes().await;
        let (rate, eta) = rate_eta(transferred, self.manifest.size, self.started);
        let state = state_override.unwrap_or_else(|| self.progress_state(transferred));
        emit_progress(
            app,
            &TransferProgress {
                transfer_id: self.manifest.file_id.clone(),
                direction: self.direction.clone(),
                name: self.manifest.name.clone(),
                size: self.manifest.size,
                transferred,
                rate,
                eta,
                state: state.to_string(),
                conv_id: self.conv_id.clone(),
            },
        );
    }
}

/* --------------------------- positioned file IO --------------------------- */
// Positioned reads/writes (no shared cursor) so a node can serve already-held
// pieces while still writing newly received ones. Blocking — run via
// `spawn_blocking`.

#[cfg(unix)]
fn pread_exact(f: &std::fs::File, off: u64, len: usize) -> std::io::Result<Vec<u8>> {
    use std::os::unix::fs::FileExt;
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        let n = f.read_at(&mut buf[done..], off + done as u64)?;
        if n == 0 {
            break;
        }
        done += n;
    }
    buf.truncate(done);
    Ok(buf)
}

#[cfg(windows)]
fn pread_exact(f: &std::fs::File, off: u64, len: usize) -> std::io::Result<Vec<u8>> {
    use std::os::windows::fs::FileExt;
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        let n = f.seek_read(&mut buf[done..], off + done as u64)?;
        if n == 0 {
            break;
        }
        done += n;
    }
    buf.truncate(done);
    Ok(buf)
}

#[cfg(unix)]
fn pwrite_all(f: &std::fs::File, off: u64, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    let mut done = 0;
    while done < data.len() {
        let n = f.write_at(&data[done..], off + done as u64)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "write_at returned 0",
            ));
        }
        done += n;
    }
    Ok(())
}

#[cfg(windows)]
fn pwrite_all(f: &std::fs::File, off: u64, data: &[u8]) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < data.len() {
        let n = f.seek_write(&data[done..], off + done as u64)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "seek_write returned 0",
            ));
        }
        done += n;
    }
    Ok(())
}

/* -------------------------------- sending -------------------------------- */

fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Offer a single file to `targets` and become its seeder. `members` is the full
/// swarm peer set leechers should trade with (for a group); pass the same as
/// `targets` for 1:1. Returns the content-addressed file id (the transfer id).
pub async fn send(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    targets: Vec<String>,
    members: Vec<String>,
    path: PathBuf,
    conv_id: String,
    group_id: Option<String>,
) -> Result<String, String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err("only single files are supported here".into());
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mime = mime_for(&name);
    let manifest = {
        let path = path.clone();
        let name = name.clone();
        tokio::task::spawn_blocking(move || build_manifest(&path, name, PIECE_SIZE))
            .await
            .map_err(|e| e.to_string())??
    };
    let file_id = manifest.file_id.clone();
    let src = std::fs::File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let n = manifest.piece_count();

    let sf = Arc::new(SwarmFile {
        manifest: manifest.clone(),
        conv_id: conv_id.clone(),
        group_id: group_id.clone(),
        direction: "send".into(),
        save_path: path.clone(),
        temp_path: path.clone(),
        origin: None,
        file: std::sync::Mutex::new(Some(Arc::new(src))),
        inner: Mutex::new(SwarmInner {
            have: Bitfield::full(n),
            peers: HashMap::new(),
            inflight: HashMap::new(),
        }),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        resume: Notify::new(),
        wake: Notify::new(),
        started: Instant::now(),
        finalized: AtomicBool::new(false),
    });
    state
        .swarms
        .write()
        .await
        .insert(file_id.clone(), sf.clone());

    let my_id = state.node_id().await;
    let payload = json!({
        "manifest": manifest.to_json(), "kind": "file", "mime": mime,
        "convId": conv_id, "groupId": group_id, "members": members,
    });
    let mut delivered = 0usize;
    for target in &targets {
        let env = Envelope::new(
            frame::SWARM_OFFER,
            &my_id,
            Some(target.clone()),
            payload.clone(),
        );
        match transport::send_to_peer(app, state, target, env).await {
            Ok(()) => delivered += 1,
            Err(e) => log::warn!("lanchat: swarm offer for {file_id} to {target} failed: {e}"),
        }
    }
    // If the offer reached no one (peer offline / unreachable address / firewall),
    // surface a terminal failure instead of leaving the sender stuck on a silent
    // "offering" card, and drop the dead seed so it does not leak.
    if delivered == 0 && !targets.is_empty() {
        sf.emit(app, Some("failed")).await;
        state.swarms.write().await.remove(&file_id);
        return Err("could not reach any recipient (peer offline or unreachable)".into());
    }
    sf.emit(app, Some("offering")).await;
    Ok(file_id)
}

/* ----------------------------- receiving side ----------------------------- */

/// Inbound `swarm-offer`: stash it and surface a prompt to the UI. The
/// conversation id is derived locally (group id, or the sender for a direct
/// chat) — never trusted from the payload, which carries the *sender's* view
/// (`direct:<us>`) and would never match our `direct:<them>` key.
pub async fn handle_offer(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(manifest) = env.payload.get("manifest").and_then(Manifest::from_json) else {
        return;
    };
    let kind = env
        .payload
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string();
    let mime = env
        .payload
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();
    let group_id = env
        .payload
        .get("groupId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let members: Vec<String> = env
        .payload
        .get("members")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let conv_id = match &group_id {
        Some(g) => crate::lanchat::store::group_conv_id(g),
        None => crate::lanchat::store::direct_conv_id(from),
    };
    let file_id = manifest.file_id.clone();
    let (name, size) = (manifest.name.clone(), manifest.size);
    state.swarm_offers.write().await.insert(
        file_id.clone(),
        OfferInfo {
            manifest,
            from: from.to_string(),
            conv_id: conv_id.clone(),
            group_id: group_id.clone(),
            kind: kind.clone(),
            members,
            mime: mime.clone(),
        },
    );
    let _ = app.emit(
        events::FILE_OFFER,
        &json!({ "transferId": file_id, "from": from, "name": name, "size": size, "mime": mime, "kind": kind, "convId": conv_id, "groupId": group_id }),
    );
}

/// Accept an inbound offer: allocate the temp file, join the swarm, and start
/// leeching. Empty `save_path` defaults to the OS downloads dir + offer name.
/// Returns the resolved save path.
pub async fn accept_offer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    file_id: &str,
    save_path: PathBuf,
) -> Result<String, String> {
    let offer = state
        .swarm_offers
        .write()
        .await
        .remove(file_id)
        .ok_or("offer not found or already handled")?;
    if let Some(existing) = state.swarms.read().await.get(file_id) {
        return Ok(existing.save_path.to_string_lossy().to_string());
    }
    let save_path = if save_path.as_os_str().is_empty() {
        let base = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir);
        base.join(&offer.manifest.name)
    } else {
        save_path
    };
    if let Some(parent) = save_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let temp_path = save_path.with_extension(format!(
        "{}.part",
        save_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    let std_file = {
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&temp_path)
            .map_err(|e| format!("create {}: {e}", temp_path.display()))?;
        f.set_len(offer.manifest.size)
            .map_err(|e| format!("allocate: {e}"))?;
        Arc::new(f)
    };
    let n = offer.manifest.piece_count();
    let my_id = state.node_id().await;
    let mut peers = HashMap::new();
    peers.insert(offer.from.clone(), Bitfield::full(n)); // origin has everything
    for m in &offer.members {
        if *m != my_id && *m != offer.from {
            peers.insert(m.clone(), Bitfield::empty(n));
        }
    }
    let sf = Arc::new(SwarmFile {
        manifest: offer.manifest.clone(),
        conv_id: offer.conv_id.clone(),
        group_id: offer.group_id.clone(),
        direction: "recv".into(),
        save_path: save_path.clone(),
        temp_path,
        origin: Some(offer.from.clone()),
        file: std::sync::Mutex::new(Some(std_file)),
        inner: Mutex::new(SwarmInner {
            have: Bitfield::empty(n),
            peers,
            inflight: HashMap::new(),
        }),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        resume: Notify::new(),
        wake: Notify::new(),
        started: Instant::now(),
        finalized: AtomicBool::new(false),
    });
    state
        .swarms
        .write()
        .await
        .insert(file_id.to_string(), sf.clone());

    let accept = Envelope::new(
        frame::SWARM_ACCEPT,
        &my_id,
        Some(offer.from.clone()),
        json!({ "fileId": file_id }),
    );
    let _ = transport::send_to_peer(app, state, &offer.from, accept).await;
    // Announce participation to the other members so the swarm can mesh.
    let bits = sf.inner.lock().await.have.to_base64();
    for m in &offer.members {
        if *m != my_id && *m != offer.from {
            let bf = Envelope::new(
                frame::SWARM_BITFIELD,
                &my_id,
                Some(m.clone()),
                json!({ "fileId": file_id, "bits": bits }),
            );
            let _ = transport::send_to_peer(app, state, m, bf).await;
        }
    }
    sf.emit(app, Some("active")).await;
    spawn_leecher(app.clone(), state.clone(), file_id.to_string());
    Ok(save_path.to_string_lossy().to_string())
}

/// Reject an inbound offer and tell the origin.
pub async fn reject_offer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    file_id: &str,
) -> Result<(), String> {
    if let Some(offer) = state.swarm_offers.write().await.remove(file_id) {
        let my_id = state.node_id().await;
        let env = Envelope::new(
            frame::SWARM_REJECT,
            &my_id,
            Some(offer.from.clone()),
            json!({ "fileId": file_id }),
        );
        let _ = transport::send_to_peer(app, state, &offer.from, env).await;
    }
    Ok(())
}

/* --------------------------- inbound swarm frames ------------------------- */

fn payload_file_id(env: &Envelope) -> Option<String> {
    env.payload
        .get("fileId")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Origin: a peer accepted — start tracking it as a leecher we serve.
pub async fn handle_accept(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let n = sf.manifest.piece_count();
    sf.inner
        .lock()
        .await
        .peers
        .entry(from.to_string())
        .or_insert_with(|| Bitfield::empty(n));
    sf.emit(app, None).await;
}

/// Origin: a peer declined. For a 1:1 transfer this ends it; in a group one
/// decline is ignored (other members still receive).
pub async fn handle_reject(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    _from: &str,
    env: &Envelope,
) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    if sf.group_id.is_none() {
        sf.emit(app, Some("rejected")).await;
        state.swarms.write().await.remove(&file_id);
    }
}

/// A peer announced it now holds a piece — record it as a potential source.
pub async fn handle_have(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(piece) = env.payload.get("piece").and_then(|v| v.as_u64()) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let n = sf.manifest.piece_count();
    sf.inner
        .lock()
        .await
        .peers
        .entry(from.to_string())
        .or_insert_with(|| Bitfield::empty(n))
        .set(piece as usize);
    sf.wake.notify_waiters();
    sf.emit(app, None).await;
    maybe_finalize_origin(app, state, &sf, &file_id).await;
}

/// A peer sent its full bitfield (on join) — record what it can serve.
pub async fn handle_bitfield(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    from: &str,
    env: &Envelope,
) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(bits) = env.payload.get("bits").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let n = sf.manifest.piece_count();
    sf.inner
        .lock()
        .await
        .peers
        .insert(from.to_string(), Bitfield::from_base64(bits, n));
    sf.wake.notify_waiters();
    sf.emit(app, None).await;
    maybe_finalize_origin(app, state, &sf, &file_id).await;
}

/// Origin send completes when every accepted peer holds the whole file.
async fn maybe_finalize_origin(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    sf: &Arc<SwarmFile>,
    file_id: &str,
) {
    if sf.direction != "send" || sf.finalized.load(Ordering::SeqCst) {
        return;
    }
    let done = {
        let inner = sf.inner.lock().await;
        !inner.peers.is_empty() && inner.peers.values().all(|b| b.is_complete())
    };
    if done {
        sf.finalized.store(true, Ordering::SeqCst);
        sf.emit(app, Some("done")).await;
        state.swarms.write().await.remove(file_id);
    }
}

/// Broadcast a `swarm-have` for `piece` to every known swarm peer.
async fn broadcast_have(state: &Arc<LanChatState>, sf: &Arc<SwarmFile>, my_id: &str, piece: usize) {
    let peers: Vec<String> = sf.inner.lock().await.peers.keys().cloned().collect();
    for p in peers {
        let env = Envelope::new(
            frame::SWARM_HAVE,
            my_id,
            Some(p.clone()),
            json!({ "fileId": sf.manifest.file_id, "piece": piece }),
        );
        let _ = transport::try_send(state, &p, env).await;
    }
}

/// A peer asked for a piece: read it (positioned, O(piece)) and ship it on the
/// bounded binary channel. `send_data` awaits channel capacity, so a fast disk
/// can never outrun the network — this is the backpressure guarantee.
pub async fn handle_request(state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(piece) = env.payload.get("piece").and_then(|v| v.as_u64()) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    if sf.is_paused() {
        return;
    }
    let idx = piece as usize;
    if !sf.inner.lock().await.have.get(idx) {
        return;
    }
    let Some(f) = sf.file_handle() else { return };
    let off = idx as u64 * sf.manifest.piece_size as u64;
    let len = sf.manifest.piece_len(idx);
    let data = match tokio::task::spawn_blocking(move || pread_exact(&f, off, len)).await {
        Ok(Ok(d)) => d,
        _ => return,
    };
    transport::send_data(
        state,
        from,
        wire::frame_piece(&file_id, piece as u32, &data),
    )
    .await;
}

/// A binary piece arrived: verify its SHA-256, write it at the right offset,
/// advertise it, and finalize when the file is whole.
pub async fn handle_piece(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    _from: &str,
    file_id: &str,
    piece: u32,
    data: bytes::Bytes,
) {
    let Some(sf) = state.swarms.read().await.get(file_id).cloned() else {
        return;
    };
    let idx = piece as usize;
    if sf.inner.lock().await.have.get(idx) {
        return; // duplicate
    }
    let mut h = Sha256::new();
    h.update(&data);
    let got = hex::encode(h.finalize());
    if sf.manifest.pieces.get(idx) != Some(&got) {
        log::debug!("lanchat: piece {idx} of {file_id} failed hash check, re-requesting");
        sf.inner.lock().await.inflight.remove(&piece);
        sf.wake.notify_waiters();
        return;
    }
    let Some(f) = sf.file_handle() else { return };
    let off = idx as u64 * sf.manifest.piece_size as u64;
    let dvec = data.to_vec();
    let wrote = tokio::task::spawn_blocking(move || pwrite_all(&f, off, &dvec))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false);
    if !wrote {
        return;
    }
    {
        let mut inner = sf.inner.lock().await;
        inner.have.set(idx);
        inner.inflight.remove(&piece);
    }
    let my_id = state.node_id().await;
    broadcast_have(state, &sf, &my_id, idx).await;
    sf.wake.notify_waiters();
    sf.emit(app, None).await;
    if sf.inner.lock().await.have.is_complete() {
        finalize_leecher(app, state, &sf).await;
    }
}

/// Leecher reached 100%: fsync, atomically rename `.part` → final, then reopen
/// read-only so this node keeps seeding the file to the rest of the swarm. For a
/// 1:1 transfer there is no one left to seed to, so the entry is dropped (frees
/// the open file handle) rather than retained.
async fn finalize_leecher(app: &AppHandle, state: &Arc<LanChatState>, sf: &Arc<SwarmFile>) {
    if sf.finalized.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(f) = sf.file_handle() {
        let _ = tokio::task::spawn_blocking(move || f.sync_all()).await;
    }
    *sf.file.lock().unwrap() = None;
    let ok = tokio::fs::rename(&sf.temp_path, &sf.save_path)
        .await
        .is_ok();
    if ok && sf.group_id.is_some() {
        // Group: keep seeding to the rest of the swarm.
        if let Ok(rf) = std::fs::File::open(&sf.save_path) {
            sf.set_file(Arc::new(rf));
        }
    } else {
        // 1:1 (or rename failed): nothing more to serve — release the entry.
        state.swarms.write().await.remove(&sf.manifest.file_id);
    }
    sf.emit(app, Some(if ok { "done" } else { "failed" })).await;
}

/* ------------------------------ leecher loop ------------------------------ */

fn spawn_leecher(app: AppHandle, state: Arc<LanChatState>, file_id: String) {
    tokio::spawn(async move {
        run_leecher(&app, &state, &file_id).await;
    });
}

/// Drive a leech to completion: schedule piece requests under a bounded window
/// (rarest-source-balanced, random scan), reap timeouts, and sleep until a
/// piece/have/new-peer event or the drive tick. The window is what keeps memory
/// flat regardless of file size.
async fn run_leecher(_app: &AppHandle, state: &Arc<LanChatState>, file_id: &str) {
    let Some(sf) = state.swarms.read().await.get(file_id).cloned() else {
        return;
    };
    let my_id = state.node_id().await;
    let n = sf.manifest.piece_count();
    loop {
        if sf.is_cancelled() {
            break;
        }
        sf.wait_while_paused().await;
        if sf.is_cancelled() {
            break;
        }
        let requests = schedule_requests(&sf, n).await;
        for (peer, idx) in &requests {
            let env = Envelope::new(
                frame::SWARM_REQUEST,
                &my_id,
                Some(peer.clone()),
                json!({ "fileId": file_id, "piece": idx }),
            );
            let _ = transport::try_send(state, peer, env).await;
        }
        if sf.inner.lock().await.have.is_complete() {
            break;
        }
        tokio::select! {
            _ = sf.wake.notified() => {}
            _ = tokio::time::sleep(DRIVE_TICK) => {}
        }
    }
}

/// Pick which pieces to request from which peers, respecting the global and
/// per-peer in-flight windows. Reaps expired requests so they can be retried
/// (possibly from a different source).
async fn schedule_requests(sf: &Arc<SwarmFile>, n: usize) -> Vec<(String, u32)> {
    let mut inner = sf.inner.lock().await;
    let now = Instant::now();
    let expired: Vec<u32> = inner
        .inflight
        .iter()
        .filter(|(_, (_, dl))| *dl <= now)
        .map(|(p, _)| *p)
        .collect();
    for p in expired {
        inner.inflight.remove(&p);
    }
    let mut per_peer: HashMap<String, usize> = HashMap::new();
    for (peer, _) in inner.inflight.values() {
        *per_peer.entry(peer.clone()).or_default() += 1;
    }
    let mut total = inner.inflight.len();
    let mut reqs = Vec::new();
    for idx in 0..n {
        if total >= MAX_INFLIGHT {
            break;
        }
        if inner.have.get(idx) || inner.inflight.contains_key(&(idx as u32)) {
            continue;
        }
        let mut best: Option<(String, usize)> = None;
        for (peer, bf) in inner.peers.iter() {
            if !bf.get(idx) {
                continue;
            }
            let c = *per_peer.get(peer).unwrap_or(&0);
            if c >= PER_PEER_WINDOW {
                continue;
            }
            if best.as_ref().map(|(_, bc)| c < *bc).unwrap_or(true) {
                best = Some((peer.clone(), c));
            }
        }
        if let Some((peer, _)) = best {
            inner
                .inflight
                .insert(idx as u32, (peer.clone(), now + PIECE_TIMEOUT));
            *per_peer.entry(peer.clone()).or_default() += 1;
            total += 1;
            reqs.push((peer, idx as u32));
        }
    }
    reqs
}

/* --------------------------- pause / resume / cancel ---------------------- */

/// Local pause/resume/cancel from the UI. Cancelling a transfer that is still
/// only "offering" (peer not yet accepted) now emits a terminal `cancelled`
/// progress and tears down state — fixing the stuck "等待对方接收…" card.
pub async fn control(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    file_id: &str,
    action: &str,
) -> Result<(), String> {
    if let Some(sf) = state.swarms.read().await.get(file_id).cloned() {
        match action {
            "pause" => {
                sf.paused.store(true, Ordering::SeqCst);
                sf.emit(app, Some("paused")).await;
            }
            "resume" => {
                sf.paused.store(false, Ordering::SeqCst);
                sf.resume.notify_waiters();
                sf.wake.notify_waiters();
                sf.emit(app, None).await;
            }
            "cancel" => {
                sf.cancelled.store(true, Ordering::SeqCst);
                sf.resume.notify_waiters();
                sf.wake.notify_waiters();
                let peers: Vec<String> = sf.inner.lock().await.peers.keys().cloned().collect();
                let my_id = state.node_id().await;
                for p in &peers {
                    let env = Envelope::new(
                        frame::SWARM_CANCEL,
                        &my_id,
                        Some(p.clone()),
                        json!({ "fileId": file_id }),
                    );
                    let _ = transport::try_send(state, p, env).await;
                }
                if sf.direction == "recv" {
                    *sf.file.lock().unwrap() = None;
                    let _ = tokio::fs::remove_file(&sf.temp_path).await;
                }
                sf.emit(app, Some("cancelled")).await;
                state.swarms.write().await.remove(file_id);
            }
            _ => return Err(format!("unknown action {action}")),
        }
        return Ok(());
    }
    // Not active: a still-pending inbound offer — cancel == reject + clear card.
    if action == "cancel" {
        let conv = state
            .swarm_offers
            .read()
            .await
            .get(file_id)
            .map(|o| (o.conv_id.clone(), o.manifest.name.clone(), o.manifest.size));
        reject_offer(app, state, file_id).await?;
        if let Some((conv_id, name, size)) = conv {
            emit_progress(
                app,
                &TransferProgress {
                    transfer_id: file_id.to_string(),
                    direction: "recv".into(),
                    name,
                    size,
                    transferred: 0,
                    rate: 0.0,
                    eta: 0.0,
                    state: "cancelled".into(),
                    conv_id,
                },
            );
        }
    }
    Ok(())
}

/// Inbound `swarm-cancel`. If our origin cancelled, abort locally and drop the
/// partial file; if a mere peer left the swarm, just stop using it as a source.
pub async fn handle_cancel(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    // Sender rescinded a still-pending offer: clear the receiver's prompt.
    if let Some(offer) = state.swarm_offers.write().await.remove(&file_id) {
        emit_progress(
            app,
            &TransferProgress {
                transfer_id: file_id.clone(),
                direction: "recv".into(),
                name: offer.manifest.name,
                size: offer.manifest.size,
                transferred: 0,
                rate: 0.0,
                eta: 0.0,
                state: "cancelled".into(),
                conv_id: offer.conv_id,
            },
        );
    }
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let from_origin = sf.origin.as_deref() == Some(from);
    if from_origin {
        sf.cancelled.store(true, Ordering::SeqCst);
        sf.resume.notify_waiters();
        sf.wake.notify_waiters();
        *sf.file.lock().unwrap() = None;
        let _ = tokio::fs::remove_file(&sf.temp_path).await;
        sf.emit(app, Some("cancelled")).await;
        state.swarms.write().await.remove(&file_id);
    } else {
        let mut inner = sf.inner.lock().await;
        inner.peers.remove(from);
        let drop_pieces: Vec<u32> = inner
            .inflight
            .iter()
            .filter(|(_, (p, _))| p == from)
            .map(|(i, _)| *i)
            .collect();
        for i in drop_pieces {
            inner.inflight.remove(&i);
        }
        drop(inner);
        sf.wake.notify_waiters();
    }
}

/* --------------------------------- group --------------------------------- */

/// Offer a single file to every member of a group. Every member that accepts
/// leeches from the origin and trades pieces with the other members.
pub async fn send_to_group(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    group_id: &str,
    path: PathBuf,
) -> Result<String, String> {
    let my_id = state.node_id().await;
    let members: Vec<String> = state
        .store
        .list_group_members(group_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|m| *m != my_id)
        .collect();
    if members.is_empty() {
        return Err("群里没有其他在线成员".into());
    }
    let conv_id = crate::lanchat::store::group_conv_id(group_id);
    send(
        app,
        state,
        members.clone(),
        members,
        path,
        conv_id,
        Some(group_id.to_string()),
    )
    .await
}

/// Offer a whole folder (recursive). Implemented as a one-accept decomposition
/// into per-file swarms (see `send_dir` impl, added after the single-file path
/// is verified).
pub async fn send_dir(
    _app: &AppHandle,
    _state: &Arc<LanChatState>,
    _targets: Vec<String>,
    _root: PathBuf,
    _conv_id: String,
    _group_id: Option<String>,
) -> Result<String, String> {
    Err("文件夹传输正在适配 swarm 引擎（即将恢复）".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitfield_pack_round_trips() {
        let mut bf = Bitfield::empty(20);
        for i in [0usize, 3, 7, 8, 19] {
            bf.set(i);
        }
        assert_eq!(bf.count(), 5);
        assert!(!bf.is_complete());
        let restored = Bitfield::from_base64(&bf.to_base64(), 20);
        for i in 0..20 {
            assert_eq!(restored.get(i), bf.get(i), "bit {i}");
        }
    }

    #[test]
    fn bitfield_full_is_complete() {
        assert!(Bitfield::full(4).is_complete());
        assert!(!Bitfield::empty(0).is_complete());
    }

    #[test]
    fn manifest_build_and_piece_len() {
        let dir = std::env::temp_dir().join(format!("lanchat-swarm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.bin");
        // 2.5 pieces worth so the last piece is short.
        let size = PIECE_SIZE * 2 + 123;
        std::fs::write(&path, vec![0xABu8; size]).unwrap();

        let m = build_manifest(&path, "data.bin".into(), PIECE_SIZE).unwrap();
        assert_eq!(m.size as usize, size);
        assert_eq!(m.piece_count(), 3);
        assert_eq!(m.piece_len(0), PIECE_SIZE);
        assert_eq!(m.piece_len(1), PIECE_SIZE);
        assert_eq!(m.piece_len(2), 123);
        assert_eq!(m.piece_len(3), 0);
        assert_eq!(m.file_id.len(), 64);

        // Deterministic + content-addressed: same bytes → same id.
        let m2 = build_manifest(&path, "renamed.bin".into(), PIECE_SIZE).unwrap();
        assert_eq!(m.file_id, m2.file_id);
        // Round-trips through JSON.
        let back = Manifest::from_json(&m.to_json()).unwrap();
        assert_eq!(back.file_id, m.file_id);
        assert_eq!(back.pieces, m.pieces);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn positioned_io_round_trips() {
        let dir = std::env::temp_dir().join(format!("lanchat-pio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.bin");
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        f.set_len(1000).unwrap();
        pwrite_all(&f, 500, &[1, 2, 3, 4]).unwrap();
        let got = pread_exact(&f, 500, 4).unwrap();
        assert_eq!(got, vec![1, 2, 3, 4]);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn test_leecher(n: usize, peers: HashMap<String, Bitfield>) -> Arc<SwarmFile> {
        Arc::new(SwarmFile {
            manifest: Manifest {
                file_id: "f".repeat(64),
                name: "x".into(),
                size: (n * 1024) as u64,
                piece_size: 1024,
                pieces: vec!["00".into(); n],
            },
            conv_id: "direct:peer".into(),
            group_id: None,
            direction: "recv".into(),
            save_path: PathBuf::from("/tmp/x"),
            temp_path: PathBuf::from("/tmp/x.part"),
            origin: Some("origin".into()),
            file: std::sync::Mutex::new(None),
            inner: Mutex::new(SwarmInner {
                have: Bitfield::empty(n),
                peers,
                inflight: HashMap::new(),
            }),
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            resume: Notify::new(),
            wake: Notify::new(),
            started: Instant::now(),
            finalized: AtomicBool::new(false),
        })
    }

    #[tokio::test]
    async fn scheduler_respects_per_peer_window() {
        // Only one source for 20 pieces → capped at the per-peer window.
        let mut peers = HashMap::new();
        peers.insert("origin".to_string(), Bitfield::full(20));
        let sf = test_leecher(20, peers);
        let reqs = schedule_requests(&sf, 20).await;
        assert_eq!(reqs.len(), PER_PEER_WINDOW);
        assert!(reqs.iter().all(|(p, _)| p == "origin"));
        assert_eq!(sf.inner.lock().await.inflight.len(), PER_PEER_WINDOW);
    }

    #[tokio::test]
    async fn scheduler_only_requests_pieces_a_peer_has() {
        // origin has all; peer B has only piece 2. Two sources → 2*window slots.
        let mut peers = HashMap::new();
        peers.insert("origin".to_string(), Bitfield::full(4));
        let mut b = Bitfield::empty(4);
        b.set(2);
        peers.insert("B".to_string(), b);
        let sf = test_leecher(4, peers);
        let reqs = schedule_requests(&sf, 4).await;
        // All 4 pieces get scheduled (origin can serve every one).
        let mut idxs: Vec<u32> = reqs.iter().map(|(_, i)| *i).collect();
        idxs.sort_unstable();
        assert_eq!(idxs, vec![0, 1, 2, 3]);
        // Whoever was asked for piece 2 must actually hold it.
        for (peer, idx) in &reqs {
            if *idx == 2 {
                assert!(peer == "origin" || peer == "B");
            } else {
                assert_eq!(peer, "origin");
            }
        }
    }

    // End-to-end data plane (no network/AppHandle): rebuild a real multi-piece
    // file by applying its pieces OUT OF ORDER through the exact read → verify →
    // write path the swarm uses, and confirm the result is byte-identical and a
    // tampered piece is rejected.
    #[test]
    fn reconstruct_file_from_out_of_order_verified_pieces() {
        let dir = std::env::temp_dir().join(format!("lanchat-recon-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dst = dir.join("dst.part");

        // 3 pieces + a short tail, with varied bytes so piece hashes differ.
        let size = PIECE_SIZE * 3 + 777;
        let mut content = vec![0u8; size];
        for (i, b) in content.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        std::fs::write(&src, &content).unwrap();

        let manifest = build_manifest(&src, "src.bin".into(), PIECE_SIZE).unwrap();
        let n = manifest.piece_count();
        assert_eq!(n, 4);

        let seed = std::fs::File::open(&src).unwrap();
        let sink = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&dst)
            .unwrap();
        sink.set_len(size as u64).unwrap();

        // Apply pieces in a deliberately non-sequential order.
        let mut have = Bitfield::empty(n);
        for &idx in &[2usize, 0, 3, 1] {
            let off = idx as u64 * PIECE_SIZE as u64;
            let data = pread_exact(&seed, off, manifest.piece_len(idx)).unwrap();
            // Verify exactly as handle_piece does.
            let mut h = Sha256::new();
            h.update(&data);
            assert_eq!(
                hex::encode(h.finalize()),
                manifest.pieces[idx],
                "piece {idx} hash"
            );
            pwrite_all(&sink, off, &data).unwrap();
            have.set(idx);
        }
        assert!(have.is_complete());
        drop(sink);

        let got = std::fs::read(&dst).unwrap();
        assert_eq!(
            got, content,
            "reconstructed file matches source byte-for-byte"
        );

        // A tampered piece must fail the hash check.
        let mut bad = pread_exact(&seed, 0, manifest.piece_len(0)).unwrap();
        bad[0] ^= 0xFF;
        let mut h = Sha256::new();
        h.update(&bad);
        assert_ne!(
            hex::encode(h.finalize()),
            manifest.pieces[0],
            "tampered piece rejected"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
