//! HTTP CONNECT **server** handshake for the local ingress listener.
//!
//! The mirror image of [`crate::sockscap::egress::http_connect`]. Only the
//! CONNECT tunnel form is handled: an HTTP proxy is also expected to serve
//! absolute-form requests (`GET http://host/path`), which would require
//! rewriting and re-framing every request rather than bridging bytes. macOS
//! Phase 1 therefore points the system **SOCKS** proxy at the ingress, and
//! absolute-form arrivals get an explicit, actionable refusal.

use std::net::IpAddr;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::IngressTarget;

/// Request-header budget before we assume the peer is not really a proxy client.
const MAX_HEADER_BYTES: usize = 8192;

pub async fn accept_handshake<S>(stream: &mut S) -> Result<IngressTarget, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let head = read_head(stream).await?;
    let request_line = head
        .lines()
        .next()
        .ok_or_else(|| "HTTP request had no request line".to_string())?
        .trim();

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let authority = parts.next().unwrap_or_default();

    if !method.eq_ignore_ascii_case("CONNECT") {
        let _ = stream
            .write_all(
                b"HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await;
        return Err(format!(
            "HTTP ingress only tunnels CONNECT; received {method:?}. \
             Point the client at the SOCKS proxy for plain HTTP."
        ));
    }
    if authority.is_empty() {
        return Err("HTTP CONNECT request had no target authority".into());
    }

    let (host, port) = split_authority(authority)?;
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(|error| format!("HTTP CONNECT reply write: {error}"))?;

    // A literal address must stay an IP so CIDR bypass and IP rules still apply.
    match host.parse::<IpAddr>() {
        Ok(address) => Ok(IngressTarget {
            host: None,
            ip: Some(address),
            port,
        }),
        Err(_) => Ok(IngressTarget {
            host: Some(host),
            ip: None,
            port,
        }),
    }
}

/// Read up to the end of the header block. Byte-at-a-time keeps the tunnel
/// payload that follows the blank line in the socket, where the shared relay
/// expects to peek it for SNI.
async fn read_head<S>(stream: &mut S) -> Result<String, String>
where
    S: AsyncRead + Unpin,
{
    let mut buffer: Vec<u8> = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let read = stream
            .read(&mut byte)
            .await
            .map_err(|error| format!("HTTP request read: {error}"))?;
        if read == 0 {
            return Err("client closed the connection during the CONNECT request".into());
        }
        buffer.push(byte[0]);
        if buffer.ends_with(b"\r\n\r\n") || buffer.ends_with(b"\n\n") {
            break;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(format!(
                "HTTP CONNECT request exceeded {MAX_HEADER_BYTES} bytes"
            ));
        }
    }
    String::from_utf8(buffer).map_err(|_| "HTTP CONNECT request was not valid UTF-8".to_string())
}

/// Split `host:port`, honouring the bracket form for IPv6 literals.
fn split_authority(authority: &str) -> Result<(String, u16), String> {
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| format!("unterminated IPv6 literal in {authority:?}"))?;
        let port = tail
            .strip_prefix(':')
            .ok_or_else(|| format!("CONNECT target {authority:?} is missing a port"))?;
        (host.to_string(), port)
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .ok_or_else(|| format!("CONNECT target {authority:?} is missing a port"))?;
        (host.to_string(), port)
    };

    if host.is_empty() {
        return Err(format!("CONNECT target {authority:?} has an empty host"));
    }
    let port: u16 = port
        .parse()
        .map_err(|_| format!("CONNECT target {authority:?} has an invalid port"))?;
    if port == 0 {
        return Err(format!("CONNECT target {authority:?} asked for port 0"));
    }
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn exchange(request: &[u8]) -> (Result<IngressTarget, String>, String) {
        let (mut server, mut client) = tokio::io::duplex(4096);
        client.write_all(request).await.unwrap();
        let parsed = accept_handshake(&mut server).await;
        drop(server);
        let mut written = Vec::new();
        client.read_to_end(&mut written).await.unwrap();
        (parsed, String::from_utf8_lossy(&written).into_owned())
    }

    #[tokio::test]
    async fn connect_tunnel_is_established_and_keeps_the_hostname() {
        let (parsed, written) =
            exchange(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n").await;

        let target = parsed.expect("CONNECT should be accepted");
        assert_eq!(target.host.as_deref(), Some("example.com"));
        assert_eq!(target.ip, None);
        assert_eq!(target.port, 443);
        assert!(written.starts_with("HTTP/1.1 200 "));
    }

    #[tokio::test]
    async fn the_tunnel_payload_after_the_blank_line_is_left_in_the_stream() {
        // The shared relay peeks this for SNI, so the handshake must not swallow it.
        let (mut server, mut client) = tokio::io::duplex(4096);
        client
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n\x16\x03\x01payload")
            .await
            .unwrap();

        accept_handshake(&mut server).await.expect("CONNECT");

        let mut rest = [0u8; 3];
        server.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"\x16\x03\x01");
    }

    #[tokio::test]
    async fn absolute_form_requests_are_refused_with_guidance() {
        let (parsed, written) =
            exchange(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n").await;

        let error = parsed.unwrap_err();
        assert!(error.contains("only tunnels CONNECT"));
        assert!(error.contains("SOCKS"));
        assert!(written.starts_with("HTTP/1.1 501 "));
    }

    #[tokio::test]
    async fn ipv6_literals_use_the_bracket_form() {
        let target = exchange(b"CONNECT [2001:db8::1]:8443 HTTP/1.1\r\n\r\n")
            .await
            .0
            .expect("IPv6 CONNECT");

        assert_eq!(target.host, None);
        assert_eq!(target.ip, Some("2001:db8::1".parse::<IpAddr>().unwrap()));
        assert_eq!(target.port, 8443);
    }

    #[test]
    fn a_missing_port_is_rejected() {
        let error = split_authority("example.com").unwrap_err();
        assert!(error.contains("missing a port"));
    }

    #[test]
    fn an_ipv4_literal_is_reported_as_an_ip() {
        let (host, port) = split_authority("93.184.216.34:443").unwrap();
        assert_eq!(host, "93.184.216.34");
        assert_eq!(port, 443);
    }
}
