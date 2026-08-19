//! MS-RDPBCGR §2.2.1.1 RDP Negotiation Request / Response / Failure.
//!
//! These small fixed-format structures ride inside the X.224 Connection
//! Request and Connection Confirm TPDUs (`x224.rs`) and tell the server
//! which security protocol the client wants to negotiate (Standard RDP
//! Security, TLS, NLA / CredSSP, RDSTLS, …) and the server's selection.

use tokio::io::{AsyncRead, AsyncWrite};

use crate::rdp::RdpOptions;
use crate::rdp::pdu::{tpkt, x224};

/// Negotiation message types.
pub const TYPE_NEG_REQ: u8 = 0x01;
pub const TYPE_NEG_RSP: u8 = 0x02;
pub const TYPE_NEG_FAIL: u8 = 0x03;

/// Security protocol bits (MS-RDPBCGR §2.2.1.1.1).
pub const PROTOCOL_RDP: u32 = 0x0000_0000;
pub const PROTOCOL_SSL: u32 = 0x0000_0001;
pub const PROTOCOL_HYBRID: u32 = 0x0000_0002; // CredSSP / NLA
pub const PROTOCOL_RDSTLS: u32 = 0x0000_0004;
pub const PROTOCOL_HYBRID_EX: u32 = 0x0000_0008;
pub const PROTOCOL_RDSAAD: u32 = 0x0000_0010;

/// Request flags (most are restricted-admin / redirected-auth markers).
pub const REQ_FLAG_RESTRICTED_ADMIN: u8 = 0x01;
pub const REQ_FLAG_REDIRECTED_AUTH: u8 = 0x02;
pub const REQ_FLAG_CORRELATION_INFO: u8 = 0x08;

/// The request body. Encoded big-endian header, little-endian length and
/// payload (per MS-RDPBCGR — note the mixed endianness is part of the
/// spec, not a bug).
#[derive(Debug, Clone, Copy)]
pub struct NegotiationRequest {
    pub flags: u8,
    pub requested_protocols: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct NegotiationResponse {
    pub flags: u8,
    pub selected_protocol: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct NegotiationFailure {
    pub flags: u8,
    pub failure_code: u32,
}

#[derive(Debug)]
pub enum NegotiationOutcome {
    Response(NegotiationResponse),
    Failure(NegotiationFailure),
}

impl NegotiationResponse {
    pub fn selected_protocol_label(&self) -> &'static str {
        match self.selected_protocol {
            PROTOCOL_RDP => "Standard RDP Security",
            PROTOCOL_SSL => "TLS",
            PROTOCOL_HYBRID => "CredSSP (NLA)",
            PROTOCOL_RDSTLS => "RDSTLS",
            PROTOCOL_HYBRID_EX => "CredSSP-EX",
            PROTOCOL_RDSAAD => "RDSAAD",
            _ => "Unknown",
        }
    }
}

/// Build the 8-byte negotiation request body.
pub fn encode_negotiation_request(req: &NegotiationRequest) -> [u8; 8] {
    let mut out = [0u8; 8];
    out[0] = TYPE_NEG_REQ;
    out[1] = req.flags;
    out[2..4].copy_from_slice(&8u16.to_le_bytes()); // length = 8
    out[4..8].copy_from_slice(&req.requested_protocols.to_le_bytes());
    out
}

/// Pick a sensible negotiation request from an [`RdpOptions`].
pub fn negotiate_request(opts: &RdpOptions) -> NegotiationRequest {
    let mut requested = PROTOCOL_SSL;
    if opts.nla {
        requested |= PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX;
    }
    NegotiationRequest {
        flags: 0,
        requested_protocols: requested,
    }
}

/// Build a routing cookie of the form `mstshash=<user>`. RDP brokers (RDS
/// Connection Broker, KEMP, F5) use this to redirect the connection. The
/// caller may supply just the user, or a full `username@domain` string.
pub fn build_cookie(user: Option<&str>) -> Option<String> {
    let u = user?.trim();
    if u.is_empty() {
        return None;
    }
    // ASCII only; truncate at 9 characters per spec recommendation.
    let safe: String = u.chars().filter(|c| c.is_ascii_graphic()).take(9).collect();
    if safe.is_empty() {
        None
    } else {
        Some(format!("mstshash={}", safe))
    }
}

/// Parse a 8-byte negotiation response or failure body.
pub fn parse_negotiation(buf: &[u8]) -> Result<NegotiationOutcome, String> {
    if buf.len() < 8 {
        return Err(format!("nego: response too short ({} bytes)", buf.len()));
    }
    let typ = buf[0];
    let flags = buf[1];
    let length = u16::from_le_bytes([buf[2], buf[3]]);
    if length != 8 {
        return Err(format!("nego: unexpected length {}", length));
    }
    let payload = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    match typ {
        TYPE_NEG_RSP => Ok(NegotiationOutcome::Response(NegotiationResponse {
            flags,
            selected_protocol: payload,
        })),
        TYPE_NEG_FAIL => Ok(NegotiationOutcome::Failure(NegotiationFailure {
            flags,
            failure_code: payload,
        })),
        other => Err(format!("nego: unknown message type 0x{:02x}", other)),
    }
}

/// High-level: send an X.224 Connection Request carrying the negotiation
/// request. The cookie is taken from the request flags / caller-supplied
/// user — pick `None` to omit it.
pub async fn send_negotiation<W: AsyncWrite + Unpin>(
    stream: &mut W,
    req: &NegotiationRequest,
) -> Result<(), String> {
    send_negotiation_with_cookie(stream, req, None).await
}

pub async fn send_negotiation_with_cookie<W: AsyncWrite + Unpin>(
    stream: &mut W,
    req: &NegotiationRequest,
    cookie_user: Option<&str>,
) -> Result<(), String> {
    let nego = encode_negotiation_request(req);
    let cookie = build_cookie(cookie_user);
    let cr = x224::build_connection_request(cookie.as_deref(), &nego);
    tpkt::write_message(stream, &cr).await
}

/// High-level: read the Connection Confirm and parse the negotiation outcome.
pub async fn recv_negotiation<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<NegotiationResponse, String> {
    let payload = tpkt::read_message(stream).await?;
    if x224::is_error_tpdu(&payload) {
        return Err("server returned X.224 disconnect (likely TLS / NLA mismatch)".into());
    }
    let cc = x224::parse_connection_confirm(&payload)?;
    if cc.variable.is_empty() {
        // Server accepted plain RDP without echoing a negotiation response.
        return Ok(NegotiationResponse {
            flags: 0,
            selected_protocol: PROTOCOL_RDP,
        });
    }
    match parse_negotiation(cc.variable)? {
        NegotiationOutcome::Response(r) => Ok(r),
        NegotiationOutcome::Failure(f) => Err(format!(
            "server rejected negotiation: code=0x{:08x} flags=0x{:02x}",
            f.failure_code, f.flags
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn request_encoding_is_canonical() {
        let req = NegotiationRequest {
            flags: REQ_FLAG_RESTRICTED_ADMIN,
            requested_protocols: PROTOCOL_SSL | PROTOCOL_HYBRID,
        };
        let bytes = encode_negotiation_request(&req);
        assert_eq!(bytes[0], TYPE_NEG_REQ);
        assert_eq!(bytes[1], REQ_FLAG_RESTRICTED_ADMIN);
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 8);
        assert_eq!(
            u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
            PROTOCOL_SSL | PROTOCOL_HYBRID
        );
    }

    #[test]
    fn response_round_trip() {
        let body = [
            TYPE_NEG_RSP,
            0x00,
            0x08,
            0x00,
            PROTOCOL_HYBRID as u8,
            0,
            0,
            0,
        ];
        match parse_negotiation(&body).unwrap() {
            NegotiationOutcome::Response(r) => {
                assert_eq!(r.selected_protocol, PROTOCOL_HYBRID);
                assert_eq!(r.selected_protocol_label(), "CredSSP (NLA)");
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn failure_round_trip() {
        let body = [TYPE_NEG_FAIL, 0x00, 0x08, 0x00, 0x05, 0, 0, 0];
        match parse_negotiation(&body).unwrap() {
            NegotiationOutcome::Failure(f) => assert_eq!(f.failure_code, 0x0000_0005),
            _ => panic!("expected failure"),
        }
    }

    #[test]
    fn parse_rejects_short_body() {
        assert!(parse_negotiation(&[1, 0, 0, 0]).is_err());
    }

    #[test]
    fn cookie_truncates_long_user() {
        assert_eq!(
            build_cookie(Some("alice")).as_deref(),
            Some("mstshash=alice")
        );
        assert_eq!(
            build_cookie(Some("AVeryLongUserNameThatExceeds")).as_deref(),
            Some("mstshash=AVeryLong")
        );
        assert_eq!(build_cookie(Some("")), None);
        assert_eq!(build_cookie(None), None);
    }

    #[tokio::test]
    async fn negotiate_request_picks_nla_when_enabled() {
        let mut opts = RdpOptions::default();
        opts.nla = true;
        let req = negotiate_request(&opts);
        assert!(req.requested_protocols & PROTOCOL_HYBRID != 0);
        assert!(req.requested_protocols & PROTOCOL_SSL != 0);
    }

    #[tokio::test]
    async fn negotiate_request_omits_nla_when_disabled() {
        let mut opts = RdpOptions::default();
        opts.nla = false;
        let req = negotiate_request(&opts);
        assert_eq!(req.requested_protocols & PROTOCOL_HYBRID, 0);
        assert!(req.requested_protocols & PROTOCOL_SSL != 0);
    }

    #[tokio::test]
    async fn round_trip_through_cursor() {
        let req = negotiate_request(&RdpOptions::default());
        let mut sent = Vec::new();
        send_negotiation_with_cookie(&mut sent, &req, Some("bob"))
            .await
            .unwrap();
        // Verify TPKT framing
        let total = u16::from_be_bytes([sent[2], sent[3]]) as usize;
        assert_eq!(total, sent.len());
        // CR TPDU code at offset 5 (TPKT 4 + LI 1)
        assert_eq!(sent[5], 0xE0);

        // Build a valid CC carrying a negotiation response and feed it back.
        // 7-byte fixed header + 8-byte negotiation response → LI = 14.
        let nego_body = [TYPE_NEG_RSP, 0x00, 0x08, 0x00, PROTOCOL_SSL as u8, 0, 0, 0];
        let mut cc = vec![0x0Eu8, 0xD0, 0, 0, 0x12, 0x34, 0];
        cc.extend_from_slice(&nego_body);
        let framed = tpkt::encode(&cc).unwrap();
        let mut rdr = Cursor::new(framed);
        let resp = recv_negotiation(&mut rdr).await.unwrap();
        assert_eq!(resp.selected_protocol, PROTOCOL_SSL);
    }
}
