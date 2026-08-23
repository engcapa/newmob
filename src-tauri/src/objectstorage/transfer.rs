//! Shared streaming-transfer plumbing for the object-storage engines:
//! progress/paused event emission and a response→file streamer used by both
//! the S3 and Azure download paths. Reuses `filebrowser::transfer`'s
//! `TransferHandle`/`ProgressPayload` so the frontend's `FileTransferQueue`
//! treats object-storage transfers exactly like SFTP ones (events are just
//! named `storage-*` instead of `sftp-*`).

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use futures::StreamExt;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::AsyncWriteExt;

use crate::filebrowser::transfer::{ProgressPayload, TransferHandle};

/// Part/buffer size for multipart uploads and chunked reads (8 MiB). Above the
/// S3 5 MiB minimum part size, and a reasonable block size for Azure.
pub const PART_SIZE: usize = 8 * 1024 * 1024;

/// Files at or below this size upload in a single request; larger files use the
/// engine's chunked path (S3 multipart / Azure block list).
pub const MULTIPART_THRESHOLD: u64 = PART_SIZE as u64;

pub fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    transfer_id: &str,
    bytes: u64,
    total: u64,
    started: Instant,
) {
    let secs = started.elapsed().as_secs_f64().max(0.001);
    let rate = bytes as f64 / secs;
    let remaining = total.saturating_sub(bytes) as f64;
    let eta = if rate > 0.0 { remaining / rate } else { 0.0 };
    let _ = app.emit(
        &format!("storage-progress-{}", transfer_id),
        ProgressPayload {
            bytes,
            total,
            rate,
            eta,
        },
    );
}

pub fn emit_paused<R: Runtime>(app: &AppHandle<R>, transfer_id: &str, bytes: u64, total: u64) {
    let _ = app.emit(
        &format!("storage-paused-{}", transfer_id),
        ProgressPayload {
            bytes,
            total,
            rate: 0.0,
            eta: 0.0,
        },
    );
}

/// Stream a checked HTTP response body to `dest`, emitting progress and honoring
/// pause/cancel. `total` is the expected byte count (0 when unknown).
pub async fn stream_to_file<R: Runtime>(
    resp: reqwest::Response,
    total: u64,
    dest: &Path,
    transfer_id: &str,
    handle: &Arc<TransferHandle>,
    app: &AppHandle<R>,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let started = Instant::now();
    emit_progress(app, transfer_id, 0, total, started);
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if handle.is_cancelled() {
            return Err("transfer cancelled".to_string());
        }
        if handle.is_paused() {
            emit_paused(app, transfer_id, written, total);
            handle.wait_while_paused().await;
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
        }
        let chunk = chunk.map_err(|e| format!("download stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {}: {e}", dest.display()))?;
        written += chunk.len() as u64;
        emit_progress(app, transfer_id, written, total, started);
    }
    file.flush()
        .await
        .map_err(|e| format!("flush {}: {e}", dest.display()))?;
    Ok(())
}

/// Read up to `buf.len()` bytes, looping until the buffer is full or EOF. The
/// chunked-upload paths need full parts (except the last), which a single
/// `read` does not guarantee.
pub async fn read_full(file: &mut tokio::fs::File, buf: &mut [u8]) -> Result<usize, String> {
    use tokio::io::AsyncReadExt;
    let mut filled = 0;
    while filled < buf.len() {
        let n = file
            .read(&mut buf[filled..])
            .await
            .map_err(|e| format!("read local file: {e}"))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}
