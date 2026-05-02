//! Wrapper around `russh-sftp` that exposes the operations the JS layer needs.
//!
//! Each `ActiveSftp` keeps the parent `client::Handle<SshHandler>` alive so
//! the SSH connection task is not dropped while the SFTP subsystem is in use.

use crate::filebrowser::transfer::{self, ProgressPayload, TransferHandle};
use crate::terminal::ssh::{connect_ssh_authenticated, SshAuth, SshHandler};
use russh::client;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType as SftpFileType, OpenFlags};
use serde::Serialize;
use std::path::Path;
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
        let mut entries = Vec::with_capacity(dir_entries.len());
        for item in dir_entries {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let attrs = item.metadata();
            let full = join_remote(path, &name);
            entries.push(entry_from_attrs(name, full, attrs));
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
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
