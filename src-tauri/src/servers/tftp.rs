//! TFTP server (RFC 1350, octet mode) over `tokio` UDP.
//!
//! Listens on `config.bindAddress:config.port` (default 69) for RRQ (read) and
//! WRQ (write) requests. Per the RFC, each transfer is handled on its own
//! ephemeral UDP socket (a fresh TID) so the main listening socket is free to
//! accept new requests. Files are read from / written into
//! `config.extra["rootDir"]` (falling back to the home directory).
//!
//! Only `octet` (binary) mode is implemented; `netascii`/`mail` are rejected
//! with an error packet. Blocks are the classic fixed 512 bytes, so a transfer
//! ends on the first short (< 512 byte) DATA block.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use tokio::net::UdpSocket;

use super::ServerConfig;
use super::engine::{LogEmitter, ServerCtx, ServerStarted};

const DEFAULT_PORT: u16 = 69;
const BLOCK_SIZE: usize = 512;
const RETRIES: u32 = 5;
const TIMEOUT: Duration = Duration::from_secs(3);

// TFTP opcodes.
const OP_RRQ: u16 = 1;
const OP_WRQ: u16 = 2;
const OP_DATA: u16 = 3;
const OP_ACK: u16 = 4;
const OP_ERROR: u16 = 5;

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 {
        DEFAULT_PORT
    } else {
        config.port
    };
    let bind = config.bind_address.clone();

    let root = resolve_root(&config);
    if !root.is_dir() {
        return Err(format!(
            "root directory does not exist or is not a directory: {}",
            root.display()
        ));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("failed to resolve root {}: {}", root.display(), e))?;

    let addr = format!("{}:{}", bind, port);
    let socket = UdpSocket::bind(&addr)
        .await
        .map_err(|e| format!("failed to bind UDP {}: {}", addr, e))?;

    ctx.log.line(format!(
        "TFTP server listening on {} (octet mode) — root {}",
        addr,
        root.display()
    ));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let bind_ip = bind;
    let task = tokio::spawn(async move {
        let mut buf = vec![0u8; 1024];
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("TFTP server stopping");
                    break;
                }
                recv = socket.recv_from(&mut buf) => {
                    match recv {
                        Ok((n, peer)) => {
                            let packet = buf[..n].to_vec();
                            let root = root.clone();
                            let log = log.clone();
                            let bind_ip = bind_ip.clone();
                            tokio::spawn(async move {
                                handle_request(&packet, peer, &root, &bind_ip, &log).await;
                            });
                        }
                        Err(e) => log.line(format!("recv error: {}", e)),
                    }
                }
            }
        }
    });

    Ok(ServerStarted { pid: None, task })
}

fn resolve_root(config: &ServerConfig) -> PathBuf {
    let raw = config.str_field("rootDir", "");
    if !raw.is_empty() {
        PathBuf::from(raw)
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    }
}

/// Parse and dispatch an initial RRQ/WRQ packet onto a fresh transfer socket.
async fn handle_request(
    packet: &[u8],
    peer: SocketAddr,
    root: &Path,
    bind_ip: &str,
    log: &LogEmitter,
) {
    if packet.len() < 4 {
        return;
    }
    let opcode = u16::from_be_bytes([packet[0], packet[1]]);

    // Parse "<filename>\0<mode>\0".
    let fields: Vec<&[u8]> = packet[2..].split(|&b| b == 0).collect();
    if fields.len() < 2 {
        return;
    }
    let filename = String::from_utf8_lossy(fields[0]).into_owned();
    let mode = String::from_utf8_lossy(fields[1]).to_ascii_lowercase();

    // A transfer gets its own socket (a new TID) bound to an ephemeral port.
    let xfer = match UdpSocket::bind(format!("{}:0", bind_ip)).await {
        Ok(s) => s,
        Err(e) => {
            log.line(format!("{}: failed to open transfer socket: {}", peer, e));
            return;
        }
    };
    if xfer.connect(peer).await.is_err() {
        return;
    }

    if mode != "octet" {
        send_error(&xfer, 0, "Only octet mode is supported").await;
        log.line(format!("{}: rejected mode '{}'", peer, mode));
        return;
    }

    let target = match safe_join(root, &filename) {
        Some(p) => p,
        None => {
            send_error(&xfer, 2, "Access violation").await;
            log.line(format!("{}: rejected path traversal '{}'", peer, filename));
            return;
        }
    };

    match opcode {
        OP_RRQ => {
            log.line(format!("{}: RRQ '{}'", peer, filename));
            if let Err(e) = serve_read(&xfer, &target).await {
                log.line(format!("{}: RRQ '{}' failed: {}", peer, filename, e));
            } else {
                log.line(format!("{}: RRQ '{}' complete", peer, filename));
            }
        }
        OP_WRQ => {
            log.line(format!("{}: WRQ '{}'", peer, filename));
            if let Err(e) = serve_write(&xfer, &target).await {
                log.line(format!("{}: WRQ '{}' failed: {}", peer, filename, e));
            } else {
                log.line(format!("{}: WRQ '{}' complete", peer, filename));
            }
        }
        _ => {
            send_error(&xfer, 4, "Illegal TFTP operation").await;
        }
    }
}

/// Serve a file to the client: send DATA blocks, wait for matching ACKs.
async fn serve_read(xfer: &UdpSocket, path: &Path) -> Result<(), String> {
    let data = match tokio::fs::read(path).await {
        Ok(d) => d,
        Err(_) => {
            send_error(xfer, 1, "File not found").await;
            return Err("file not found".to_string());
        }
    };

    let mut block: u16 = 1;
    let mut offset = 0usize;
    let mut recv_buf = vec![0u8; 1024];

    loop {
        let end = (offset + BLOCK_SIZE).min(data.len());
        let chunk = &data[offset..end];

        // Build DATA packet: opcode(3) | block | payload.
        let mut packet = Vec::with_capacity(4 + chunk.len());
        packet.extend_from_slice(&OP_DATA.to_be_bytes());
        packet.extend_from_slice(&block.to_be_bytes());
        packet.extend_from_slice(chunk);

        // Send with retry until the matching ACK arrives.
        let mut acked = false;
        for _ in 0..RETRIES {
            xfer.send(&packet).await.map_err(|e| e.to_string())?;
            match tokio::time::timeout(TIMEOUT, xfer.recv(&mut recv_buf)).await {
                Ok(Ok(n)) if n >= 4 => {
                    let op = u16::from_be_bytes([recv_buf[0], recv_buf[1]]);
                    let ack_block = u16::from_be_bytes([recv_buf[2], recv_buf[3]]);
                    if op == OP_ACK && ack_block == block {
                        acked = true;
                        break;
                    }
                    if op == OP_ERROR {
                        return Err("client aborted".to_string());
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => continue, // timeout -> retransmit
            }
        }
        if !acked {
            return Err("timed out waiting for ACK".to_string());
        }

        offset = end;
        // The final block is the one shorter than 512 bytes (incl. a 0-byte
        // block when the file length is an exact multiple of 512).
        if chunk.len() < BLOCK_SIZE {
            break;
        }
        block = block.wrapping_add(1);
    }
    Ok(())
}

/// Receive a file from the client: ACK block 0, then store DATA blocks.
async fn serve_write(xfer: &UdpSocket, path: &Path) -> Result<(), String> {
    let mut file_data: Vec<u8> = Vec::new();
    let mut recv_buf = vec![0u8; 1024];

    // Acknowledge the WRQ with ACK block 0 to start the transfer.
    send_ack(xfer, 0).await?;

    let mut expected: u16 = 1;
    loop {
        let n = match tokio::time::timeout(TIMEOUT, xfer.recv(&mut recv_buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("timed out waiting for DATA".to_string()),
        };
        if n < 4 {
            continue;
        }
        let op = u16::from_be_bytes([recv_buf[0], recv_buf[1]]);
        let blk = u16::from_be_bytes([recv_buf[2], recv_buf[3]]);
        if op == OP_ERROR {
            return Err("client aborted".to_string());
        }
        if op != OP_DATA {
            continue;
        }
        if blk == expected {
            let payload = &recv_buf[4..n];
            file_data.extend_from_slice(payload);
            send_ack(xfer, blk).await?;
            expected = expected.wrapping_add(1);
            if payload.len() < BLOCK_SIZE {
                break; // last block
            }
        } else {
            // Duplicate/old block: re-ACK so the sender advances.
            send_ack(xfer, blk).await?;
        }
    }

    tokio::fs::write(path, &file_data)
        .await
        .map_err(|e| format!("failed to write file: {}", e))?;
    Ok(())
}

async fn send_ack(xfer: &UdpSocket, block: u16) -> Result<(), String> {
    let mut packet = Vec::with_capacity(4);
    packet.extend_from_slice(&OP_ACK.to_be_bytes());
    packet.extend_from_slice(&block.to_be_bytes());
    xfer.send(&packet).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn send_error(xfer: &UdpSocket, code: u16, msg: &str) {
    let mut packet = Vec::with_capacity(5 + msg.len());
    packet.extend_from_slice(&OP_ERROR.to_be_bytes());
    packet.extend_from_slice(&code.to_be_bytes());
    packet.extend_from_slice(msg.as_bytes());
    packet.push(0);
    let _ = xfer.send(&packet).await;
}

/// Same containment rules as the HTTP server: only normal path components,
/// no `..`/root/prefix escapes. Filenames may include subdirectories.
fn safe_join(root: &Path, filename: &str) -> Option<PathBuf> {
    let rel = filename.trim_start_matches('/').replace('\\', "/");
    let mut candidate = root.to_path_buf();
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Normal(seg) => candidate.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if candidate == root {
        return None; // a bare/empty filename is not a valid target
    }
    Some(candidate)
}
