//! Wrapper around `russh-sftp` that exposes the operations the JS layer needs.
//!
//! Each `ActiveSftp` keeps the parent `client::Handle<SshHandler>` alive so
//! the SSH connection task is not dropped while the SFTP subsystem is in use.

use crate::filebrowser::local;
use crate::filebrowser::transfer::{self, ProgressPayload, TransferHandle};
use crate::terminal::ssh::{connect_ssh_authenticated, SshAuth, SshHandler};
use russh::client;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType as SftpFileType, OpenFlags};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const CHUNK_SIZE: usize = 64 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct FileEntryDto {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub mode: u32,
    #[serde(rename = "fileType")]
    pub file_type: String,
    #[serde(rename = "isHidden")]
    pub is_hidden: bool,
    #[serde(rename = "symlinkTarget")]
    pub symlink_target: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

pub struct ActiveSftp {
    pub sftp: Arc<Mutex<SftpSession>>,
    pub home: String,
    /// The parent SSH handle is kept alive for the lifetime of the SFTP
    /// session: dropping it would close the underlying connection.
    pub _handle: client::Handle<SshHandler>,
}

pub async fn open_sftp(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
) -> Result<ActiveSftp, String> {
    let handle = connect_ssh_authenticated(host, port, username, auth).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open SFTP channel: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Failed to request sftp subsystem: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP handshake failed: {}", e))?;

    let home = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());

    Ok(ActiveSftp {
        sftp: Arc::new(Mutex::new(sftp)),
        home,
        _handle: handle,
    })
}

impl ActiveSftp {
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntryDto>, String> {
        let dir_entries = {
            let sftp = self.sftp.lock().await;
            sftp.read_dir(path.to_string())
                .await
                .map_err(|e| format!("Failed to read {}: {}", path, e))?
        };
        let mut entries: Vec<FileEntryDto> = Vec::new();
        for item in dir_entries {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let attrs = item.metadata();
            let full = join_remote(path, &name);
            let mut dto = entry_from_attrs(name, full.clone(), attrs);
            // Resolve symlink targets for display. Best-effort: failures
            // (broken links, permission denied) leave the field empty.
            if dto.file_type == "symlink" {
                let sftp = self.sftp.lock().await;
                if let Ok(target) = sftp.read_link(full.clone()).await {
                    dto.symlink_target = Some(target);
                }
            }
            entries.push(dto);
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
    }

    pub async fn read_link(&self, path: &str) -> Result<String, String> {
        let sftp = self.sftp.lock().await;
        sftp.read_link(path.to_string())
            .await
            .map_err(|e| format!("readlink {}: {}", path, e))
    }

    pub async fn stat(&self, path: &str) -> Result<FileEntryDto, String> {
        let sftp = self.sftp.lock().await;
        let attrs = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("stat {}: {}", path, e))?;
        let name = remote_basename(path).to_string();
        Ok(entry_from_attrs(name, path.to_string(), attrs))
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        sftp.create_dir(path.to_string())
            .await
            .map_err(|e| format!("mkdir {}: {}", path, e))
    }

    pub async fn remove(&self, path: &str, recursive: bool) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        let attrs = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("stat {}: {}", path, e))?;
        if attrs.is_dir() {
            if recursive {
                drop(sftp);
                self.remove_dir_recursive(path).await
            } else {
                sftp.remove_dir(path.to_string())
                    .await
                    .map_err(|e| format!("rmdir {}: {}", path, e))
            }
        } else {
            sftp.remove_file(path.to_string())
                .await
                .map_err(|e| format!("unlink {}: {}", path, e))
        }
    }

    async fn remove_dir_recursive(&self, path: &str) -> Result<(), String> {
        let entries = self.list_dir(path).await?;
        for entry in entries {
            if entry.file_type == "dir" {
                Box::pin(self.remove_dir_recursive(&entry.path)).await?;
            } else {
                let sftp = self.sftp.lock().await;
                sftp.remove_file(entry.path.clone())
                    .await
                    .map_err(|e| format!("unlink {}: {}", entry.path, e))?;
            }
        }
        let sftp = self.sftp.lock().await;
        sftp.remove_dir(path.to_string())
            .await
            .map_err(|e| format!("rmdir {}: {}", path, e))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        sftp.rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| format!("rename {} -> {}: {}", from, to, e))
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        let mut attrs = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("stat {}: {}", path, e))?;
        attrs.permissions = Some(mode);
        sftp.set_metadata(path.to_string(), attrs)
            .await
            .map_err(|e| format!("chmod {}: {}", path, e))
    }

    pub async fn realpath(&self, path: &str) -> Result<String, String> {
        let sftp = self.sftp.lock().await;
        sftp.canonicalize(path.to_string())
            .await
            .map_err(|e| format!("realpath {}: {}", path, e))
    }

    pub async fn read_bytes(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        let (size, mut file) = {
            let sftp = self.sftp.lock().await;
            let attrs = sftp
                .metadata(path.to_string())
                .await
                .map_err(|e| format!("stat {}: {}", path, e))?;
            if attrs.size.unwrap_or(0) > max_bytes {
                return Err(format!(
                    "File is {} bytes, exceeds preview limit of {} bytes",
                    attrs.size.unwrap_or(0),
                    max_bytes
                ));
            }
            let file = sftp
                .open(path.to_string())
                .await
                .map_err(|e| format!("open {}: {}", path, e))?;
            (attrs.size.unwrap_or(0), file)
        };
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| format!("read {}: {}", path, e))?;
        Ok(buf)
    }

    pub async fn write_bytes(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let mut file = {
            let sftp = self.sftp.lock().await;
            sftp.open_with_flags(
                path.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("open {} for write: {}", path, e))?
        };
        file.write_all(data)
            .await
            .map_err(|e| format!("write {}: {}", path, e))?;
        file.shutdown()
            .await
            .map_err(|e| format!("close {}: {}", path, e))
    }

    pub async fn upload_file(
        &self,
        local: &Path,
        remote: &str,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        use tokio::io::AsyncReadExt as _;

        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {}", local.display(), e))?;
        let total = file
            .metadata()
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        // Open the remote file under the session lock, then release the lock
        // so other ops (list, stat) can interleave with the chunked transfer.
        let mut remote_file = {
            let sftp = self.sftp.lock().await;
            sftp.open_with_flags(
                remote.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("open remote {} for write: {}", remote, e))?
        };

        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut written: u64 = 0;
        let started = Instant::now();
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(&app, &transfer_id, written, total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", local.display(), e))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", remote, e))?;
            written += n as u64;
            emit_progress(&app, &transfer_id, written, total, started);
        }
        remote_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", remote, e))?;
        Ok(())
    }

    /// Recursively sum the byte size of every regular file under `path`.
    /// Mirrors `local::dir_size` so callers can pre-compute a "total bytes"
    /// figure for download progress reporting before any data is transferred.
    pub async fn dir_size(&self, path: &str) -> Result<u64, String> {
        let entries = self.list_dir(path).await?;
        let mut total: u64 = 0;
        for entry in entries {
            if entry.file_type == "dir" {
                total =
                    total.saturating_add(Box::pin(self.dir_size(&entry.path)).await?);
            } else if entry.file_type == "file" {
                total = total.saturating_add(entry.size);
            }
        }
        Ok(total)
    }

    /// Idempotent mkdir: succeed if the directory already exists. Used by
    /// recursive folder transfers where intermediate dirs may have been
    /// created by a prior partial run. The original `create_dir` error is
    /// preserved when the path also fails to stat as a directory, so the
    /// caller still sees the actionable cause (permission denied, read-only
    /// filesystem, etc.) instead of a generic message.
    async fn mkdir_idempotent(&self, path: &str) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        let create_err = match sftp.create_dir(path.to_string()).await {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        match sftp.metadata(path.to_string()).await {
            Ok(attrs) if attrs.is_dir() => Ok(()),
            _ => Err(format!("mkdir {}: {}", path, create_err)),
        }
    }

    /// Recursively upload `local_dir` into `remote_dir`. The remote directory
    /// is created if it does not already exist. Progress is emitted as a
    /// single aggregate stream covering every file copied in the tree, using
    /// the byte total computed by `local::dir_size` so the percentage stays
    /// accurate as files complete.
    pub async fn upload_dir(
        &self,
        local_dir: &Path,
        remote_dir: &str,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        let total = local::dir_size(local_dir)?;
        self.mkdir_idempotent(remote_dir).await?;
        let completed = Arc::new(AtomicU64::new(0));
        let started = Instant::now();
        // Emit an initial 0/total frame so the UI immediately shows the
        // expected size instead of "0 / 0".
        emit_progress(&app, &transfer_id, 0, total, started);
        self.upload_dir_walk(
            local_dir,
            remote_dir,
            &transfer_id,
            &handle,
            &app,
            total,
            &completed,
            started,
        )
        .await
    }

    async fn upload_dir_walk(
        &self,
        local_dir: &Path,
        remote_dir: &str,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let mut read = tokio::fs::read_dir(local_dir)
            .await
            .map_err(|e| format!("read {}: {}", local_dir.display(), e))?;
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            // Honour pauses at each iteration so a folder full of small files
            // (or empty subdirs) still suspends promptly — chunk-loop checks
            // alone would never trigger between mkdirs.
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let next = read
                .next_entry()
                .await
                .map_err(|e| format!("read entry in {}: {}", local_dir.display(), e))?;
            let Some(entry) = next else { break };
            let name = entry.file_name().to_string_lossy().to_string();
            let child_local = entry.path();
            let child_remote = join_remote(remote_dir, &name);
            let meta = tokio::fs::symlink_metadata(&child_local)
                .await
                .map_err(|e| format!("stat {}: {}", child_local.display(), e))?;
            if meta.file_type().is_dir() {
                self.mkdir_idempotent(&child_remote).await?;
                Box::pin(self.upload_dir_walk(
                    &child_local,
                    &child_remote,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                ))
                .await?;
            } else if meta.file_type().is_file() {
                self.upload_file_aggregated(
                    &child_local,
                    &child_remote,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                )
                .await?;
            }
            // Symlinks and special files are intentionally skipped to keep
            // the transfer semantics simple and predictable.
        }
        Ok(())
    }

    async fn upload_file_aggregated(
        &self,
        local: &Path,
        remote: &str,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {}", local.display(), e))?;
        let mut remote_file = {
            let sftp = self.sftp.lock().await;
            sftp.open_with_flags(
                remote.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("open remote {} for write: {}", remote, e))?
        };

        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", local.display(), e))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", remote, e))?;
            let now = completed.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            emit_progress(app, transfer_id, now, total, started);
        }
        remote_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", remote, e))?;
        Ok(())
    }

    /// Recursively download `remote_dir` into `local_dir`. The local
    /// directory is created (with parents) if it does not exist. Progress is
    /// emitted as a single aggregate stream — `dir_size` pre-walks the remote
    /// tree to give the UI a stable "total" up front.
    pub async fn download_dir(
        &self,
        remote_dir: &str,
        local_dir: &Path,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        let total = self.dir_size(remote_dir).await?;
        tokio::fs::create_dir_all(local_dir)
            .await
            .map_err(|e| format!("mkdir {}: {}", local_dir.display(), e))?;
        let completed = Arc::new(AtomicU64::new(0));
        let started = Instant::now();
        emit_progress(&app, &transfer_id, 0, total, started);
        self.download_dir_walk(
            remote_dir,
            local_dir,
            &transfer_id,
            &handle,
            &app,
            total,
            &completed,
            started,
        )
        .await
    }

    async fn download_dir_walk(
        &self,
        remote_dir: &str,
        local_dir: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let entries = self.list_dir(remote_dir).await?;
        for entry in entries {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            // Mirror upload_dir_walk: surface pauses between entries so the
            // walk suspends even when the current entry is just a subdirectory
            // (no chunk-loop pause check would fire).
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let local_target = local_dir.join(&entry.name);
            if entry.file_type == "dir" {
                tokio::fs::create_dir_all(&local_target)
                    .await
                    .map_err(|e| format!("mkdir {}: {}", local_target.display(), e))?;
                Box::pin(self.download_dir_walk(
                    &entry.path,
                    &local_target,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                ))
                .await?;
            } else if entry.file_type == "file" {
                self.download_file_aggregated(
                    &entry.path,
                    &local_target,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn download_file_aggregated(
        &self,
        remote: &str,
        local: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let mut remote_file = {
            let sftp = self.sftp.lock().await;
            sftp.open(remote.to_string())
                .await
                .map_err(|e| format!("open {}: {}", remote, e))?
        };
        let mut local_file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(local)
            .await
            .map_err(|e| format!("open {} for write: {}", local.display(), e))?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = remote_file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", remote, e))?;
            if n == 0 {
                break;
            }
            local_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", local.display(), e))?;
            let now = completed.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            emit_progress(app, transfer_id, now, total, started);
        }
        local_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", local.display(), e))?;
        Ok(())
    }

    pub async fn download_file(
        &self,
        remote: &str,
        local: &Path,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        // Stat + open under the session lock, then release it.
        let (total, mut remote_file) = {
            let sftp = self.sftp.lock().await;
            let attrs = sftp
                .metadata(remote.to_string())
                .await
                .map_err(|e| format!("stat {}: {}", remote, e))?;
            let file = sftp
                .open(remote.to_string())
                .await
                .map_err(|e| format!("open {}: {}", remote, e))?;
            (attrs.size.unwrap_or(0), file)
        };

        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        let mut local_file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(local)
            .await
            .map_err(|e| format!("open {} for write: {}", local.display(), e))?;

        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut read_total: u64 = 0;
        let started = Instant::now();
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(&app, &transfer_id, read_total, total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = remote_file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", remote, e))?;
            if n == 0 {
                break;
            }
            local_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", local.display(), e))?;
            read_total += n as u64;
            emit_progress(&app, &transfer_id, read_total, total, started);
        }
        local_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", local.display(), e))?;
        Ok(())
    }
}

fn emit_progress(app: &AppHandle, transfer_id: &str, bytes: u64, total: u64, started: Instant) {
    let elapsed = started.elapsed().as_secs_f64().max(1e-3);
    let rate = (bytes as f64) / elapsed;
    let remaining = total.saturating_sub(bytes) as f64;
    let eta = if rate > 0.0 { remaining / rate } else { 0.0 };
    let _ = app.emit(
        &format!("sftp-progress-{}", transfer_id),
        ProgressPayload {
            bytes,
            total,
            rate,
            eta,
        },
    );
    transfer::touch();
}

fn emit_paused(app: &AppHandle, transfer_id: &str, bytes: u64, total: u64) {
    // Send a zero-rate frame so the UI flips into the "paused" badge.
    let _ = app.emit(
        &format!("sftp-paused-{}", transfer_id),
        ProgressPayload {
            bytes,
            total,
            rate: 0.0,
            eta: 0.0,
        },
    );
}

fn entry_from_attrs(
    name: String,
    path: String,
    attrs: FileAttributes,
) -> FileEntryDto {
    let file_type = match attrs.file_type() {
        SftpFileType::Dir => "dir",
        SftpFileType::File => "file",
        SftpFileType::Symlink => "symlink",
        SftpFileType::Other => "unknown",
    };
    let mode = attrs.permissions.unwrap_or(0);
    let mtime = attrs.mtime.map(|t| t as i64).unwrap_or(0);
    FileEntryDto {
        is_hidden: name.starts_with('.'),
        name,
        path,
        size: attrs.size.unwrap_or(0),
        mtime,
        mode,
        file_type: file_type.into(),
        symlink_target: None,
        owner: attrs.uid.map(|u| u.to_string()),
        group: attrs.gid.map(|g| g.to_string()),
    }
}

pub fn join_remote(base: &str, name: &str) -> String {
    if base.is_empty() {
        return name.to_string();
    }
    if base == "/" {
        return format!("/{}", name);
    }
    if base.ends_with('/') {
        format!("{}{}", base, name)
    } else {
        format!("{}/{}", base, name)
    }
}

fn remote_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) => name,
        None => trimmed,
    }
}
