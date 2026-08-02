//! HTTP CONNECT dialer (shared pattern with `terminal::network`).

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Connect to `proxy_host:proxy_port` and CONNECT to `dest_host:dest_port`.
/// Returns the tunnelled stream on success.
pub async fn dial(
    proxy_host: &str,
    proxy_port: u16,
    dest_host: &str,
    dest_port: u16,
    user: &str,
    pass: &str,
) -> Result<TcpStream, String> {
    let mut s = tokio::time::timeout(
        PROXY_CONNECT_TIMEOUT,
        TcpStream::connect((proxy_host, proxy_port)),
    )
    .await
    .map_err(|_| {
        format!(
            "connect proxy {proxy_host}:{proxy_port}: timed out after {}s",
            PROXY_CONNECT_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("connect proxy {proxy_host}:{proxy_port}: {e}"))?;
    handshake(&mut s, dest_host, dest_port, user, pass).await?;
    Ok(s)
}

pub async fn handshake(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    handshake_with_timeout(s, host, port, user, pass, PROXY_HANDSHAKE_TIMEOUT).await
}

async fn handshake_with_timeout(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    timeout: Duration,
) -> Result<(), String> {
    tokio::time::timeout(timeout, handshake_inner(s, host, port, user, pass))
        .await
        .map_err(|_| {
            format!(
                "HTTP proxy CONNECT {host}:{port}: timed out after {}s",
                timeout.as_secs_f64()
            )
        })?
}

async fn handshake_inner(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let authority = match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(ip)) => format!("[{ip}]:{port}"),
        _ => format!("{host}:{port}"),
    };
    let mut req = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: keep-alive\r\n"
    );
    if !user.is_empty() {
        let token = B64.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("proxy write: {e}"))?;

    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = s
            .read(&mut byte)
            .await
            .map_err(|e| format!("proxy read: {e}"))?;
        if n == 0 {
            return Err("Proxy closed connection during CONNECT handshake".into());
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8192 {
            return Err("Proxy CONNECT response exceeded 8KB".into());
        }
    }
    let resp = String::from_utf8_lossy(&buf);
    let status = resp.lines().next().unwrap_or("");
    let parts: Vec<&str> = status.split_whitespace().collect();
    if parts.len() < 2 || parts[1] != "200" {
        return Err(format!("HTTP proxy rejected CONNECT: {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn connect_handshake_times_out_when_proxy_never_replies() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let mut client = TcpStream::connect(address).await.unwrap();

        let error = handshake_with_timeout(
            &mut client,
            "example.com",
            443,
            "",
            "",
            Duration::from_millis(30),
        )
        .await
        .unwrap_err();

        assert!(error.contains("timed out"));
        server.abort();
    }

    #[tokio::test]
    async fn ipv6_connect_authority_is_bracketed() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            String::from_utf8(request).unwrap()
        });
        let mut client = TcpStream::connect(address).await.unwrap();

        handshake(&mut client, "2001:db8::1", 443, "", "")
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(request.starts_with("CONNECT [2001:db8::1]:443 HTTP/1.1\r\n"));
        assert!(request.contains("\r\nHost: [2001:db8::1]:443\r\n"));
    }
}
