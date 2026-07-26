//! SOCKS5 **server** handshake for the local ingress listener.
//!
//! [`crate::sockscap::egress::socks5`] is the client half: it dials *out* to an
//! upstream SOCKS5 proxy. This is the mirror image — macOS points the system
//! proxy at our loopback listener, so we speak the server half and recover the
//! target the application asked for.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::IngressTarget;

pub(crate) const VERSION: u8 = 0x05;
const METHOD_NONE: u8 = 0x00;
const METHOD_UNACCEPTABLE: u8 = 0xff;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;
const REP_SUCCESS: u8 = 0x00;
const REP_CMD_NOT_SUPPORTED: u8 = 0x07;
const REP_ATYP_NOT_SUPPORTED: u8 = 0x08;

/// Parse a SOCKS5 CONNECT request and accept it.
///
/// Only CONNECT is supported: SocksCap's upstreams are stream tunnels
/// (HTTP CONNECT / SOCKS5 / SSH direct-tcpip), so BIND and UDP ASSOCIATE have
/// nowhere to go. They are refused with the protocol's own reply code rather
/// than a silent close so clients report something actionable.
pub async fn accept_handshake<S>(stream: &mut S) -> Result<IngressTarget, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|error| format!("SOCKS5 greeting read: {error}"))?;
    if greeting[0] != VERSION {
        return Err(format!("SOCKS5 unexpected version 0x{:02x}", greeting[0]));
    }
    let method_count = greeting[1] as usize;
    if method_count == 0 {
        return Err("SOCKS5 client offered no authentication methods".into());
    }
    let mut methods = vec![0u8; method_count];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|error| format!("SOCKS5 methods read: {error}"))?;
    // The listener is loopback-only, so the OS peer-credential boundary is the
    // access control; we advertise "no authentication" and nothing else.
    if !methods.contains(&METHOD_NONE) {
        let _ = stream.write_all(&[VERSION, METHOD_UNACCEPTABLE]).await;
        return Err("SOCKS5 client demanded an authentication method we do not offer".into());
    }
    stream
        .write_all(&[VERSION, METHOD_NONE])
        .await
        .map_err(|error| format!("SOCKS5 method reply write: {error}"))?;

    let mut request = [0u8; 4];
    stream
        .read_exact(&mut request)
        .await
        .map_err(|error| format!("SOCKS5 request read: {error}"))?;
    if request[0] != VERSION {
        return Err(format!(
            "SOCKS5 unexpected version 0x{:02x} in request",
            request[0]
        ));
    }
    if request[1] != CMD_CONNECT {
        let _ = reply(stream, REP_CMD_NOT_SUPPORTED).await;
        return Err(format!(
            "SOCKS5 unsupported command 0x{:02x} (only CONNECT is proxied)",
            request[1]
        ));
    }

    let (host, ip) = match request[3] {
        ATYP_IPV4 => {
            let mut octets = [0u8; 4];
            stream
                .read_exact(&mut octets)
                .await
                .map_err(|error| format!("SOCKS5 IPv4 address read: {error}"))?;
            (None, Some(IpAddr::V4(Ipv4Addr::from(octets))))
        }
        ATYP_IPV6 => {
            let mut octets = [0u8; 16];
            stream
                .read_exact(&mut octets)
                .await
                .map_err(|error| format!("SOCKS5 IPv6 address read: {error}"))?;
            (None, Some(IpAddr::V6(Ipv6Addr::from(octets))))
        }
        ATYP_DOMAIN => {
            let mut length = [0u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|error| format!("SOCKS5 domain length read: {error}"))?;
            if length[0] == 0 {
                return Err("SOCKS5 request carried an empty domain".into());
            }
            let mut domain = vec![0u8; length[0] as usize];
            stream
                .read_exact(&mut domain)
                .await
                .map_err(|error| format!("SOCKS5 domain read: {error}"))?;
            let domain = String::from_utf8(domain)
                .map_err(|_| "SOCKS5 domain was not valid UTF-8".to_string())?;
            // Clients are allowed to put a literal address in the domain field.
            // Normalizing it to an IP keeps CIDR bypass and IP rules working.
            match domain.parse::<IpAddr>() {
                Ok(address) => (None, Some(address)),
                Err(_) => (Some(domain), None),
            }
        }
        other => {
            let _ = reply(stream, REP_ATYP_NOT_SUPPORTED).await;
            return Err(format!("SOCKS5 unsupported address type 0x{other:02x}"));
        }
    };

    let mut port = [0u8; 2];
    stream
        .read_exact(&mut port)
        .await
        .map_err(|error| format!("SOCKS5 port read: {error}"))?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        return Err("SOCKS5 request asked for port 0".into());
    }

    reply(stream, REP_SUCCESS).await?;
    Ok(IngressTarget { host, ip, port })
}

/// Send a reply frame. `BND.ADDR`/`BND.PORT` are meaningless for a CONNECT that
/// we tunnel ourselves, so report the unspecified address as curl/Chrome do.
async fn reply<S>(stream: &mut S, code: u8) -> Result<(), String>
where
    S: AsyncWrite + Unpin,
{
    let frame = [VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0];
    stream
        .write_all(&frame)
        .await
        .map_err(|error| format!("SOCKS5 reply write: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// Drive the server handshake against a scripted client byte stream and
    /// return both the parsed target and whatever the server wrote back.
    async fn exchange(request: &[u8]) -> (Result<IngressTarget, String>, Vec<u8>) {
        let (mut server, mut client) = tokio::io::duplex(4096);
        client.write_all(request).await.unwrap();
        let parsed = accept_handshake(&mut server).await;
        drop(server);
        let mut written = Vec::new();
        client.read_to_end(&mut written).await.unwrap();
        (parsed, written)
    }

    fn connect_domain(domain: &str, port: u16) -> Vec<u8> {
        let mut request = vec![
            VERSION,
            0x01,
            METHOD_NONE,
            VERSION,
            CMD_CONNECT,
            0x00,
            ATYP_DOMAIN,
        ];
        request.push(domain.len() as u8);
        request.extend_from_slice(domain.as_bytes());
        request.extend_from_slice(&port.to_be_bytes());
        request
    }

    #[tokio::test]
    async fn connect_to_a_domain_keeps_the_hostname_for_proxy_side_dns() {
        let (parsed, written) = exchange(&connect_domain("example.com", 443)).await;

        let target = parsed.expect("domain CONNECT should be accepted");
        assert_eq!(target.host.as_deref(), Some("example.com"));
        assert_eq!(target.ip, None);
        assert_eq!(target.port, 443);
        // Method selection then a success reply.
        assert_eq!(&written[..2], &[VERSION, METHOD_NONE]);
        assert_eq!(written[2], VERSION);
        assert_eq!(written[3], REP_SUCCESS);
    }

    #[tokio::test]
    async fn connect_to_an_ipv4_literal_reports_an_ip_target() {
        let request = vec![
            VERSION,
            0x01,
            METHOD_NONE,
            VERSION,
            CMD_CONNECT,
            0x00,
            ATYP_IPV4,
            93,
            184,
            216,
            34,
            0x01,
            0xbb,
        ];

        let target = exchange(&request).await.0.expect("IPv4 CONNECT");
        assert_eq!(target.host, None);
        assert_eq!(target.ip, Some(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))));
        assert_eq!(target.port, 443);
    }

    #[tokio::test]
    async fn a_literal_address_in_the_domain_field_is_normalized_to_an_ip() {
        // Some clients send addresses as ATYP_DOMAIN. Treating the value as a
        // hostname would hide it from CIDR bypass and IP rules.
        let target = exchange(&connect_domain("10.1.2.3", 8080))
            .await
            .0
            .expect("literal address in domain field");

        assert_eq!(target.host, None);
        assert_eq!(target.ip, Some("10.1.2.3".parse::<IpAddr>().unwrap()));
        assert_eq!(target.port, 8080);
    }

    #[tokio::test]
    async fn udp_associate_is_refused_with_the_protocol_reply_code() {
        let request = vec![
            VERSION,
            0x01,
            METHOD_NONE,
            VERSION,
            0x03,
            0x00,
            ATYP_IPV4,
            127,
            0,
            0,
            1,
            0x00,
            0x35,
        ];

        let (parsed, written) = exchange(&request).await;

        assert!(parsed.unwrap_err().contains("only CONNECT"));
        assert_eq!(written[3], REP_CMD_NOT_SUPPORTED);
    }

    #[tokio::test]
    async fn a_client_without_the_no_auth_method_is_rejected() {
        let request = vec![VERSION, 0x01, 0x02];

        let (parsed, written) = exchange(&request).await;

        assert!(parsed.unwrap_err().contains("authentication"));
        assert_eq!(written, vec![VERSION, METHOD_UNACCEPTABLE]);
    }

    #[tokio::test]
    async fn port_zero_is_rejected() {
        let error = exchange(&connect_domain("example.com", 0))
            .await
            .0
            .unwrap_err();

        assert!(error.contains("port 0"));
    }
}
