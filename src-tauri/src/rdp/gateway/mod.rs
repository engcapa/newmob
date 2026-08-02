//! RD Gateway (MS-TSGU) RPC-over-HTTPS transport.
//!
//! Wire architecture (MS-TSGU §3.7):
//!
//! ```text
//!  Client ── HTTPS RPC_IN_DATA  ─▶ RDG ── inner TCP ─▶ RDP server
//!         ◀ HTTPS RPC_OUT_DATA ─       (after TsProxy* RPC handshake)
//! ```
//!
//! Two parallel HTTPS connections form a virtual full-duplex pipe. The
//! payloads are DCE/RPC PDUs (call/req/resp) carrying TsProxy* methods.
//! After `TsProxyCreateChannel`, every byte the client sends to the
//! gateway is forwarded verbatim to the inner RDP server.
//!
//! What lives in this file (with unit tests):
//!
//! - The public [`GatewayOpt`] config + thin re-export from `crate::rdp`.
//! - DCE/RPC common header (`rpc_pdu_header`), used by every TsProxy call.
//! - PDU constructors for Bind, BindAck, AlterContext, Request, Response.
//! - HTTP request line builders for RPC_IN_DATA and RPC_OUT_DATA.
//! - HTTP response parsing and gateway auth header helpers.
//! - NDR-bypass data packet builders for TsProxySendToServer and
//!   TsProxySetupReceivePipe.
//! - The NTLMv2 helper module (`ntlm`) — type 1/2/3 message framing
//!   plus HMAC-MD5 compute.
//! - The [`GatewayStream`] type implementing `AsyncRead + AsyncWrite`.
//! - The high-level [`open_tunnel`] entry that opens the authenticated
//!   HTTPS pair, completes the RTS bootstrap, runs the TsProxy handshake,
//!   and exposes the resulting channel as a byte stream.

pub mod ndr;
pub mod ntlm;
pub mod rpch;

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use tokio::io::{
    AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, DuplexStream, ReadBuf,
};
use tokio::net::TcpStream;
use tokio::sync::watch;

pub use crate::rdp::GatewayOpt;

// ── DCE/RPC common header (MS-RPCE §2.2.2.6) ────────────────────────────

pub const RPC_VERSION: u8 = 5;
pub const RPC_VERSION_MINOR: u8 = 0;

// PDU types we encode/decode.
pub const RPC_PT_REQUEST: u8 = 0x00;
pub const RPC_PT_RESPONSE: u8 = 0x02;
pub const RPC_PT_FAULT: u8 = 0x03;
pub const RPC_PT_BIND: u8 = 0x0B;
pub const RPC_PT_BIND_ACK: u8 = 0x0C;
pub const RPC_PT_BIND_NAK: u8 = 0x0D;
pub const RPC_PT_ALTER_CONTEXT: u8 = 0x0E;
pub const RPC_PT_ALTER_CONTEXT_RESP: u8 = 0x0F;

// PFC flags.
pub const PFC_FIRST_FRAG: u8 = 0x01;
pub const PFC_LAST_FRAG: u8 = 0x02;
pub const PFC_PENDING_CANCEL: u8 = 0x04;
pub const PFC_SUPPORT_HEADER_SIGN: u8 = 0x04;
pub const PFC_OBJECT_UUID: u8 = 0x80;

pub const TSPROXY_RPC_INTERFACE_UUID: [u8; 16] = [
    0xdd, 0x65, 0xe2, 0x44, 0xaf, 0x7d, 0xcd, 0x42, 0x85, 0x60, 0x3c, 0xdb, 0x6e, 0x7a, 0x27, 0x29,
];
pub const TSPROXY_RPC_INTERFACE_VERSION: u32 = 0x0003_0001;
pub const NDR_TRANSFER_SYNTAX_UUID: [u8; 16] = [
    0x04, 0x5d, 0x88, 0x8a, 0xeb, 0x1c, 0xc9, 0x11, 0x9f, 0xe8, 0x08, 0x00, 0x2b, 0x10, 0x48, 0x60,
];
pub const NDR_TRANSFER_SYNTAX_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcPduHeader {
    pub pdu_type: u8,
    pub pfc_flags: u8,
    pub frag_length: u16,
    pub auth_length: u16,
    pub call_id: u32,
}

impl RpcPduHeader {
    pub const SIZE: usize = 16;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0] = RPC_VERSION;
        out[1] = RPC_VERSION_MINOR;
        out[2] = self.pdu_type;
        out[3] = self.pfc_flags;
        // packed_drep: little-endian + ASCII + IEEE.
        out[4] = 0x10;
        out[5] = 0x00;
        out[6] = 0x00;
        out[7] = 0x00;
        out[8..10].copy_from_slice(&self.frag_length.to_le_bytes());
        out[10..12].copy_from_slice(&self.auth_length.to_le_bytes());
        out[12..16].copy_from_slice(&self.call_id.to_le_bytes());
        out
    }

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!("RPC PDU header truncated ({} bytes)", buf.len()));
        }
        if buf[0] != RPC_VERSION {
            return Err(format!("RPC PDU bad version: {}", buf[0]));
        }
        Ok(Self {
            pdu_type: buf[2],
            pfc_flags: buf[3],
            frag_length: u16::from_le_bytes([buf[8], buf[9]]),
            auth_length: u16::from_le_bytes([buf[10], buf[11]]),
            call_id: u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]),
        })
    }
}

// ── Bind PDU (TsProxy* uses a single context) ──────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct BindParams {
    pub max_xmit_frag: u16,
    pub max_recv_frag: u16,
    pub assoc_group_id: u32,
    pub call_id: u32,
}

pub const DEFAULT_RPC_FRAG_SIZE: u16 = 4280;

/// Build a Bind PDU body (everything after the common header). Single
/// context_elem with the TsProxyRpcInterface UUID. We don't insist on
/// a particular UUID here — the caller passes it so the same encoder
/// works for the various TsProxy interfaces.
pub fn build_bind_body(
    p: BindParams,
    interface_uuid: [u8; 16],
    interface_version: u32,
    transfer_syntax_uuid: [u8; 16],
    transfer_syntax_version: u32,
) -> Vec<u8> {
    let mut body = Vec::with_capacity(72);
    body.extend_from_slice(&p.max_xmit_frag.to_le_bytes());
    body.extend_from_slice(&p.max_recv_frag.to_le_bytes());
    body.extend_from_slice(&p.assoc_group_id.to_le_bytes());
    // p_context_elem
    body.push(1); // n_context_elem
    body.push(0); // reserved
    body.push(0); // reserved2
    body.push(0); // reserved2 padding

    // Single context: id=0, n_transfer_syn=1
    body.extend_from_slice(&0u16.to_le_bytes()); // p_cont_id
    body.push(1); // n_transfer_syn
    body.push(0); // reserved
    body.extend_from_slice(&interface_uuid);
    body.extend_from_slice(&interface_version.to_le_bytes());
    // Transfer syntax
    body.extend_from_slice(&transfer_syntax_uuid);
    body.extend_from_slice(&transfer_syntax_version.to_le_bytes());
    body
}

pub fn build_bind_pdu(
    p: BindParams,
    interface_uuid: [u8; 16],
    interface_version: u32,
    transfer_syntax_uuid: [u8; 16],
    transfer_syntax_version: u32,
    auth: &[u8],
) -> Vec<u8> {
    let body = build_bind_body(
        p,
        interface_uuid,
        interface_version,
        transfer_syntax_uuid,
        transfer_syntax_version,
    );
    let auth_len = auth.len() as u16;
    let frag_length = (RpcPduHeader::SIZE + body.len() + auth.len()) as u16;
    let header = RpcPduHeader {
        pdu_type: RPC_PT_BIND,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length,
        auth_length: auth_len,
        call_id: p.call_id,
    };
    let mut out = Vec::with_capacity(frag_length as usize);
    out.extend_from_slice(&header.encode());
    out.extend_from_slice(&body);
    out.extend_from_slice(auth);
    out
}

pub fn build_tsproxy_bind_pdu(call_id: u32) -> Vec<u8> {
    build_bind_pdu(
        BindParams {
            max_xmit_frag: DEFAULT_RPC_FRAG_SIZE,
            max_recv_frag: DEFAULT_RPC_FRAG_SIZE,
            assoc_group_id: 0,
            call_id,
        },
        TSPROXY_RPC_INTERFACE_UUID,
        TSPROXY_RPC_INTERFACE_VERSION,
        NDR_TRANSFER_SYNTAX_UUID,
        NDR_TRANSFER_SYNTAX_VERSION,
        &[],
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindAckResult {
    pub result: u16,
    pub reason: u16,
    pub transfer_syntax_uuid: [u8; 16],
    pub transfer_syntax_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindAckPdu {
    pub header: RpcPduHeader,
    pub max_xmit_frag: u16,
    pub max_recv_frag: u16,
    pub assoc_group_id: u32,
    pub secondary_address: String,
    pub results: Vec<BindAckResult>,
}

pub fn parse_bind_ack_pdu(buf: &[u8]) -> Result<BindAckPdu, String> {
    let header = RpcPduHeader::parse(buf)?;
    if header.pdu_type != RPC_PT_BIND_ACK {
        return Err(format!(
            "RPC: expected BIND_ACK, got pdu_type=0x{:02x}",
            header.pdu_type
        ));
    }
    let frag_length = header.frag_length as usize;
    if buf.len() < frag_length {
        return Err(format!(
            "RPC: bind_ack truncated, expected {} bytes, got {}",
            frag_length,
            buf.len()
        ));
    }
    let body = &buf[RpcPduHeader::SIZE..frag_length];
    if body.len() < 10 {
        return Err("RPC: bind_ack body too small".into());
    }
    let max_xmit_frag = u16::from_le_bytes([body[0], body[1]]);
    let max_recv_frag = u16::from_le_bytes([body[2], body[3]]);
    let assoc_group_id = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let sec_len = u16::from_le_bytes([body[8], body[9]]) as usize;
    if body.len() < 10 + sec_len {
        return Err("RPC: bind_ack secondary address truncated".into());
    }
    let sec_addr_bytes = &body[10..10 + sec_len];
    let secondary_address = String::from_utf8_lossy(sec_addr_bytes)
        .trim_end_matches('\0')
        .to_string();
    let mut pos = 10 + sec_len;
    pos += (4 - ((RpcPduHeader::SIZE + pos) % 4)) % 4;
    if body.len() < pos + 4 {
        return Err("RPC: bind_ack result list truncated".into());
    }
    let n_results = body[pos] as usize;
    pos += 4; // n_results, reserved, reserved2
    let mut results = Vec::with_capacity(n_results);
    for _ in 0..n_results {
        if body.len() < pos + 24 {
            return Err("RPC: bind_ack context result truncated".into());
        }
        let result = u16::from_le_bytes([body[pos], body[pos + 1]]);
        let reason = u16::from_le_bytes([body[pos + 2], body[pos + 3]]);
        let mut transfer_syntax_uuid = [0u8; 16];
        transfer_syntax_uuid.copy_from_slice(&body[pos + 4..pos + 20]);
        let transfer_syntax_version = u32::from_le_bytes([
            body[pos + 20],
            body[pos + 21],
            body[pos + 22],
            body[pos + 23],
        ]);
        results.push(BindAckResult {
            result,
            reason,
            transfer_syntax_uuid,
            transfer_syntax_version,
        });
        pos += 24;
    }
    Ok(BindAckPdu {
        header,
        max_xmit_frag,
        max_recv_frag,
        assoc_group_id,
        secondary_address,
        results,
    })
}

// ── Request / Response PDUs ────────────────────────────────────────────

pub fn build_request_pdu(call_id: u32, opnum: u16, stub: &[u8]) -> Vec<u8> {
    // Body: alloc_hint u32, p_cont_id u16, opnum u16, then stub data.
    let body_len = 4 + 2 + 2 + stub.len();
    let frag_length = (RpcPduHeader::SIZE + body_len) as u16;
    let header = RpcPduHeader {
        pdu_type: RPC_PT_REQUEST,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length,
        auth_length: 0,
        call_id,
    };
    let mut out = Vec::with_capacity(frag_length as usize);
    out.extend_from_slice(&header.encode());
    out.extend_from_slice(&(stub.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // p_cont_id
    out.extend_from_slice(&opnum.to_le_bytes());
    out.extend_from_slice(stub);
    out
}

#[derive(Debug, Clone)]
pub struct ResponsePdu<'a> {
    pub header: RpcPduHeader,
    pub alloc_hint: u32,
    pub p_cont_id: u16,
    pub cancel_count: u8,
    pub stub: &'a [u8],
}

pub fn parse_response_pdu(buf: &[u8]) -> Result<ResponsePdu<'_>, String> {
    let header = RpcPduHeader::parse(buf)?;
    if header.pdu_type != RPC_PT_RESPONSE {
        return Err(format!(
            "RPC: expected RESPONSE, got pdu_type=0x{:02x}",
            header.pdu_type
        ));
    }
    let frag_length = header.frag_length as usize;
    if buf.len() < frag_length {
        return Err(format!(
            "RPC: response truncated, expected {} bytes, got {}",
            frag_length,
            buf.len()
        ));
    }
    let body = &buf[RpcPduHeader::SIZE..frag_length];
    if body.len() < 8 {
        return Err("RPC: response body too small".into());
    }
    let alloc_hint = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let p_cont_id = u16::from_le_bytes([body[4], body[5]]);
    let cancel_count = body[6];
    // body[7] is reserved.
    let auth_len = header.auth_length as usize;
    let stub_end = body.len().saturating_sub(auth_len);
    Ok(ResponsePdu {
        header,
        alloc_hint,
        p_cont_id,
        cancel_count,
        stub: &body[8..stub_end],
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaultPdu {
    pub header: RpcPduHeader,
    pub alloc_hint: u32,
    pub p_cont_id: u16,
    pub cancel_count: u8,
    pub status: u32,
}

pub fn parse_fault_pdu(buf: &[u8]) -> Result<FaultPdu, String> {
    let header = RpcPduHeader::parse(buf)?;
    if header.pdu_type != RPC_PT_FAULT {
        return Err(format!(
            "RPC: expected FAULT, got pdu_type=0x{:02x}",
            header.pdu_type
        ));
    }
    let frag_length = header.frag_length as usize;
    if buf.len() < frag_length {
        return Err(format!(
            "RPC: fault truncated, expected {} bytes, got {}",
            frag_length,
            buf.len()
        ));
    }
    let body = &buf[RpcPduHeader::SIZE..frag_length];
    if body.len() < 12 {
        return Err("RPC: fault body too small".into());
    }
    Ok(FaultPdu {
        header,
        alloc_hint: u32::from_le_bytes([body[0], body[1], body[2], body[3]]),
        p_cont_id: u16::from_le_bytes([body[4], body[5]]),
        cancel_count: body[6],
        status: u32::from_le_bytes([body[8], body[9], body[10], body[11]]),
    })
}

// ── HTTP request line builders ─────────────────────────────────────────

/// Build the HTTP/1.1 request line + minimum headers for an RPC_IN_DATA
/// channel. Returns the bytes ready to append to a TLS stream.
pub fn build_rpc_in_request(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_IN_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization: None,
        session_id: None,
    })
}

pub fn build_rpc_out_request(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_OUT_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization: None,
        session_id: None,
    })
}

pub fn build_rpc_in_request_with_auth(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
    authorization: Option<&str>,
    session_id: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_IN_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization,
        session_id,
    })
}

pub fn build_rpc_out_request_with_auth(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
    authorization: Option<&str>,
    session_id: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_OUT_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization,
        session_id,
    })
}

#[derive(Debug, Clone, Copy)]
struct RpcHttpRequest<'a> {
    method: &'a str,
    host: &'a str,
    rdg_path: &'a str,
    content_length: u64,
    cookie: Option<&'a str>,
    authorization: Option<&'a str>,
    session_id: Option<&'a str>,
}

fn build_rpc_request_line(req: RpcHttpRequest<'_>) -> Vec<u8> {
    let mut s = String::new();
    s.push_str(&format!("{} {} HTTP/1.1\r\n", req.method, req.rdg_path));
    s.push_str(&format!("Host: {}\r\n", req.host));
    s.push_str("Cache-Control: no-cache\r\n");
    s.push_str("Connection: Keep-Alive\r\n");
    s.push_str("Pragma: no-cache\r\n");
    if let Some(session_id) = req.session_id {
        s.push_str(&format!(
            "Pragma: ResourceTypeUuid=44e265dd-7daf-42cd-8560-3cdb6e7a2729, SessionId={}\r\n",
            session_id
        ));
    }
    s.push_str("Accept: application/rpc\r\n");
    s.push_str("Content-Type: application/rpc\r\n");
    s.push_str("User-Agent: MSRPC\r\n");
    s.push_str("Protocol: 1.0\r\n");
    s.push_str(&format!("Content-Length: {}\r\n", req.content_length));
    if let Some(a) = req.authorization {
        s.push_str(&format!("Authorization: {}\r\n", a));
    }
    if let Some(c) = req.cookie {
        s.push_str(&format!("Cookie: {}\r\n", c));
    }
    s.push_str("\r\n");
    s.into_bytes()
}

pub fn build_basic_authorization(username: &str, password: &str) -> String {
    format!("Basic {}", B64.encode(format!("{}:{}", username, password)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponseHead {
    pub status_code: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
}

impl HttpResponseHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn headers_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers
            .iter()
            .filter(move |(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub fn parse_http_response_head(buf: &[u8]) -> Result<(HttpResponseHead, usize), String> {
    let end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| "rdg http: response headers are incomplete".to_string())?;
    let text = std::str::from_utf8(&buf[..end])
        .map_err(|e| format!("rdg http: response headers are not UTF-8: {}", e))?;
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .ok_or_else(|| "rdg http: missing status line".to_string())?;
    let mut parts = status.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/") {
        return Err(format!("rdg http: invalid status line '{}'", status));
    }
    let code = parts
        .next()
        .ok_or_else(|| format!("rdg http: missing status code in '{}'", status))?
        .parse::<u16>()
        .map_err(|e| format!("rdg http: invalid status code in '{}': {}", status, e))?;
    let reason = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(format!("rdg http: malformed header '{}'", line));
        };
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Ok((
        HttpResponseHead {
            status_code: code,
            reason,
            headers,
        },
        end,
    ))
}

pub fn www_authenticate_token(head: &HttpResponseHead, scheme: &str) -> Option<String> {
    for value in head.headers_named("WWW-Authenticate") {
        for part in value.split(',') {
            let trimmed = part.trim();
            if trimmed.eq_ignore_ascii_case(scheme) {
                return Some(String::new());
            }
            if trimmed.len() > scheme.len()
                && trimmed[..scheme.len()].eq_ignore_ascii_case(scheme)
                && trimmed.as_bytes().get(scheme.len()) == Some(&b' ')
            {
                return Some(trimmed[scheme.len() + 1..].trim().to_string());
            }
        }
    }
    None
}

// ── RDG data-phase packet helpers (MS-TSGU §2.2.9.3 / §2.2.9.4) ───────

pub const RDG_CONTEXT_HANDLE_SIZE: usize = 20;
pub const TSPROXY_OPNUM_SETUP_RECEIVE_PIPE: u16 = ndr::TSPROXY_OPNUM_SETUP_RECEIVE_PIPE;
pub const TSPROXY_OPNUM_SEND_TO_SERVER: u16 = ndr::TSPROXY_OPNUM_SEND_TO_SERVER;
pub const RPC_HTTP_CONTENT_LENGTH: u64 = 0x4000_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayInitialPackets {
    pub http_host: String,
    pub rdg_path: String,
    pub session_id: String,
    pub rts_cookies: rpch::RtsCookies,
    pub rpc_in_headers: Vec<u8>,
    pub rpc_out_headers: Vec<u8>,
    pub conn_a1_pdu: Vec<u8>,
    pub conn_b1_pdu: Vec<u8>,
    pub bind_pdu: Vec<u8>,
    pub create_tunnel_pdu: Vec<u8>,
}

pub fn gateway_rpc_path(gateway_host: &str) -> String {
    format!("/rpc/rpcproxy.dll?{}:3388", gateway_host.trim())
}

pub fn build_gateway_initial_packets(g: &GatewayOpt) -> Result<GatewayInitialPackets, String> {
    validate_gateway_base(g, "placeholder", 3389)?;
    let http_host = gateway_http_host(&g.host, g.port);
    let rdg_path = gateway_rpc_path(&g.host);
    let authorization = build_gateway_authorization(g)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let rts_cookies = rpch::RtsCookies::new_random();
    let conn_a1_pdu = rpch::build_conn_a1_pdu(&rts_cookies, rpch::DEFAULT_RECEIVE_WINDOW);
    let conn_b1_pdu = rpch::build_conn_b1_pdu(
        &rts_cookies,
        rpch::DEFAULT_CHANNEL_LIFETIME,
        rpch::DEFAULT_CLIENT_KEEPALIVE_MS,
    );
    let rpc_in_headers = build_rpc_in_request_with_auth(
        &http_host,
        &rdg_path,
        RPC_HTTP_CONTENT_LENGTH,
        None,
        Some(&authorization),
        Some(&session_id),
    );
    let rpc_out_headers = build_rpc_out_request_with_auth(
        &http_host,
        &rdg_path,
        conn_a1_pdu.len() as u64,
        None,
        Some(&authorization),
        Some(&session_id),
    );
    Ok(GatewayInitialPackets {
        http_host,
        rdg_path,
        session_id,
        rts_cookies,
        rpc_in_headers,
        rpc_out_headers,
        conn_a1_pdu,
        conn_b1_pdu,
        bind_pdu: build_tsproxy_bind_pdu(1),
        create_tunnel_pdu: ndr::build_create_tunnel_request(2),
    })
}

fn gateway_http_host(host: &str, port: u16) -> String {
    if port == 443 {
        host.trim().to_string()
    } else {
        format!("{}:{}", host.trim(), port)
    }
}

fn build_gateway_authorization(g: &GatewayOpt) -> Result<String, String> {
    match g.auth.as_str() {
        "basic" => Ok(build_basic_authorization(
            &g.username,
            g.password.as_deref().unwrap_or_default(),
        )),
        "ntlm" => Ok(build_ntlm_negotiate_authorization(&g.username)),
        other => Err(format!(
            "rdg: auth '{}' not supported (basic | ntlm)",
            other
        )),
    }
}

fn build_ntlm_negotiate_authorization(username: &str) -> String {
    format!(
        "NTLM {}",
        B64.encode(build_ntlm_negotiate_message(username))
    )
}

fn build_ntlm_negotiate_message(username: &str) -> Vec<u8> {
    let (domain, _user) = split_ntlm_domain_user(username);
    ntlm::build_negotiate(domain, "TAOMNI")
}

fn build_ntlm_authenticate_authorization(
    g: &GatewayOpt,
    negotiate_message: &[u8],
    challenge_message: &[u8],
    challenge: &ntlm::ChallengeMessage,
    client_challenge: [u8; 8],
    timestamp: u64,
) -> Result<String, String> {
    let (domain, user) = split_ntlm_domain_user(&g.username);
    let password = g.password.as_deref().unwrap_or_default();
    let mut auth = ntlm::build_authenticate(&ntlm::AuthenticateInputs {
        user,
        domain,
        workstation: "TAOMNI",
        password,
        challenge,
        client_challenge,
        timestamp,
    });
    ntlm::write_mic(
        &mut auth.bytes,
        &auth.session_base_key,
        negotiate_message,
        challenge_message,
    )?;
    Ok(format!("NTLM {}", B64.encode(auth.bytes)))
}

fn random_client_challenge() -> [u8; 8] {
    let mut challenge = [0u8; 8];
    rand::fill(&mut challenge);
    challenge
}

fn current_ntlm_filetime() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("ntlm: system clock is before Unix epoch: {}", e))?;
    Ok(ntlm_filetime_from_unix_duration(elapsed))
}

fn ntlm_filetime_from_unix_duration(d: Duration) -> u64 {
    const WINDOWS_TO_UNIX_EPOCH_SECS: u64 = 11_644_473_600;
    (d.as_secs() + WINDOWS_TO_UNIX_EPOCH_SECS) * 10_000_000 + u64::from(d.subsec_nanos() / 100)
}

fn split_ntlm_domain_user(username: &str) -> (&str, &str) {
    username
        .split_once('\\')
        .map(|(domain, user)| (domain, user))
        .unwrap_or(("", username))
}

pub fn build_receive_pipe_message(channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE]) -> Vec<u8> {
    channel_context.to_vec()
}

pub fn build_send_data_message(
    channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE],
    buffers: &[&[u8]],
) -> Result<Vec<u8>, String> {
    if buffers.is_empty() || buffers.len() > 3 {
        return Err("rdg send: expected 1..=3 data buffers".into());
    }
    if buffers[0].is_empty() {
        return Err("rdg send: first data buffer must not be empty".into());
    }
    let mut total_data_bytes = 4usize * buffers.len();
    for b in buffers {
        if b.len() > u32::MAX as usize {
            return Err("rdg send: buffer is too large".into());
        }
        total_data_bytes = total_data_bytes
            .checked_add(b.len())
            .ok_or_else(|| "rdg send: data length overflow".to_string())?;
    }
    let message_len = RDG_CONTEXT_HANDLE_SIZE + 8 + total_data_bytes;
    if message_len > 32767 {
        return Err(format!(
            "rdg send: RPC message is {} bytes; maximum is 32767",
            message_len
        ));
    }

    let mut out = Vec::with_capacity(message_len);
    out.extend_from_slice(channel_context);
    out.extend_from_slice(&(total_data_bytes as u32).to_be_bytes());
    out.extend_from_slice(&(buffers.len() as u32).to_be_bytes());
    for b in buffers {
        out.extend_from_slice(&(b.len() as u32).to_be_bytes());
    }
    for b in buffers {
        out.extend_from_slice(b);
    }
    Ok(out)
}

pub fn build_setup_receive_pipe_request(
    call_id: u32,
    channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE],
) -> Vec<u8> {
    build_request_pdu(
        call_id,
        TSPROXY_OPNUM_SETUP_RECEIVE_PIPE,
        &build_receive_pipe_message(channel_context),
    )
}

pub fn build_send_to_server_request(
    call_id: u32,
    channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE],
    data: &[u8],
) -> Result<Vec<u8>, String> {
    let stub = build_send_data_message(channel_context, &[data])?;
    Ok(build_request_pdu(
        call_id,
        TSPROXY_OPNUM_SEND_TO_SERVER,
        &stub,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceivePipePayload {
    Data(Vec<u8>),
    FinalReturn(u32),
}

pub fn decode_receive_pipe_response(resp: &ResponsePdu<'_>) -> Result<ReceivePipePayload, String> {
    if resp.header.pfc_flags & PFC_LAST_FRAG != 0 {
        if resp.stub.len() != 4 {
            return Err(format!(
                "rdg receive: final response should contain 4-byte return code, got {} bytes",
                resp.stub.len()
            ));
        }
        return Ok(ReceivePipePayload::FinalReturn(u32::from_le_bytes([
            resp.stub[0],
            resp.stub[1],
            resp.stub[2],
            resp.stub[3],
        ])));
    }
    Ok(ReceivePipePayload::Data(resp.stub.to_vec()))
}

// ── GatewayStream ──────────────────────────────────────────────────────

/// Bidirectional pipe abstraction over the IN/OUT HTTPS channels.
///
/// Reads are delivered by the RPC_OUT_DATA receive-pipe task; writes are
/// serialized through TsProxySendToServer on RPC_IN_DATA.
pub struct GatewayStream {
    reader: Pin<Box<dyn AsyncRead + Send + Sync>>,
    writer: Pin<Box<dyn AsyncWrite + Send + Sync>>,
    cancel_tx: Option<watch::Sender<()>>,
}

impl GatewayStream {
    pub fn new<R: AsyncRead + Send + Sync + 'static, W: AsyncWrite + Send + Sync + 'static>(
        reader: R,
        writer: W,
    ) -> Self {
        Self {
            reader: Box::pin(reader),
            writer: Box::pin(writer),
            cancel_tx: None,
        }
    }

    fn with_cancel(mut self, cancel_tx: watch::Sender<()>) -> Self {
        self.cancel_tx = Some(cancel_tx);
        self
    }
}

impl Drop for GatewayStream {
    fn drop(&mut self) {
        self.cancel_tx.take();
    }
}

impl AsyncRead for GatewayStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buf)
    }
}

impl AsyncWrite for GatewayStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.writer).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}

/// Open an RD Gateway tunnel to `target_host:target_port` through the
/// gateway described by `g`.
pub async fn open_tunnel(
    g: &GatewayOpt,
    target_host: &str,
    target_port: u16,
) -> Result<GatewayStream, String> {
    validate_gateway_base(g, target_host, target_port)?;
    let initial_packets = build_gateway_initial_packets(g)?;

    let mut in_stream =
        connect_authenticated_rpc_channel(g, &initial_packets, RpcHttpChannel::In).await?;
    in_stream
        .write_all(&initial_packets.conn_b1_pdu)
        .await
        .map_err(|e| format!("rdg: write CONN/B1: {}", e))?;

    let mut out_stream =
        connect_authenticated_rpc_channel(g, &initial_packets, RpcHttpChannel::Out).await?;
    out_stream
        .write_all(&initial_packets.conn_a1_pdu)
        .await
        .map_err(|e| format!("rdg: write CONN/A1: {}", e))?;

    let a3 = read_rpc_pdu(&mut out_stream).await?;
    let _a3 = rpch::parse_conn_a3_pdu(&a3)?;
    let c2 = read_rpc_pdu(&mut out_stream).await?;
    let _c2 = rpch::parse_conn_c2_pdu(&c2)?;

    in_stream
        .write_all(&initial_packets.bind_pdu)
        .await
        .map_err(|e| format!("rdg: write TsProxy bind PDU: {}", e))?;
    let bind_ack = read_non_rts_pdu(&mut out_stream).await?;
    let bind = parse_bind_ack_pdu(&bind_ack)?;
    if !bind.results.iter().any(|r| r.result == 0) {
        return Err(format!(
            "rdg: TsProxy bind was rejected: {:?}",
            bind.results
        ));
    }

    in_stream
        .write_all(&initial_packets.create_tunnel_pdu)
        .await
        .map_err(|e| format!("rdg: write TsProxyCreateTunnel: {}", e))?;
    let create_tunnel = read_response_for_call(&mut out_stream, 2, "TsProxyCreateTunnel").await?;
    let tunnel = ndr::parse_create_tunnel_response_stub(&create_tunnel)?;
    ensure_rpc_return_zero(tunnel.return_value, "TsProxyCreateTunnel")?;

    let authorize = ndr::build_authorize_tunnel_request(3, &tunnel.tunnel_context, "TAOMNI", &[])?;
    in_stream
        .write_all(&authorize)
        .await
        .map_err(|e| format!("rdg: write TsProxyAuthorizeTunnel: {}", e))?;
    let authorize = read_response_for_call(&mut out_stream, 3, "TsProxyAuthorizeTunnel").await?;
    let authorize = ndr::parse_authorize_tunnel_response_stub(&authorize)?;
    if let Some(rv) = authorize.return_value {
        ensure_rpc_return_zero(rv, "TsProxyAuthorizeTunnel")?;
    }

    let make_tunnel_call = ndr::build_make_tunnel_call_request(4, &tunnel.tunnel_context);
    in_stream
        .write_all(&make_tunnel_call)
        .await
        .map_err(|e| format!("rdg: write TsProxyMakeTunnelCall: {}", e))?;
    let create_channel =
        ndr::build_create_channel_request(5, &tunnel.tunnel_context, target_host, target_port)?;
    in_stream
        .write_all(&create_channel)
        .await
        .map_err(|e| format!("rdg: write TsProxyCreateChannel: {}", e))?;
    let create_channel = read_response_for_call(&mut out_stream, 5, "TsProxyCreateChannel").await?;
    let channel = ndr::parse_create_channel_response_stub(&create_channel)?;
    ensure_rpc_return_zero(channel.return_value, "TsProxyCreateChannel")?;

    let receive_call_id = 6;
    let setup_receive_pipe =
        build_setup_receive_pipe_request(receive_call_id, &channel.channel_context);
    in_stream
        .write_all(&setup_receive_pipe)
        .await
        .map_err(|e| format!("rdg: write TsProxySetupReceivePipe: {}", e))?;

    Ok(spawn_gateway_stream(
        in_stream,
        out_stream,
        tunnel.tunnel_context,
        channel.channel_context,
        receive_call_id,
    ))
}

type GatewayTlsStream = crate::rdp::tls::TlsStream<TcpStream>;

#[derive(Clone, Copy, Debug)]
enum RpcHttpChannel {
    In,
    Out,
}

impl RpcHttpChannel {
    fn label(self) -> &'static str {
        match self {
            Self::In => "RPC_IN_DATA",
            Self::Out => "RPC_OUT_DATA",
        }
    }

    fn content_length(self, initial_packets: &GatewayInitialPackets) -> u64 {
        match self {
            Self::In => RPC_HTTP_CONTENT_LENGTH,
            Self::Out => initial_packets.conn_a1_pdu.len() as u64,
        }
    }

    fn headers(
        self,
        initial_packets: &GatewayInitialPackets,
        authorization: Option<&str>,
    ) -> Vec<u8> {
        match self {
            Self::In => build_rpc_in_request_with_auth(
                &initial_packets.http_host,
                &initial_packets.rdg_path,
                self.content_length(initial_packets),
                None,
                authorization,
                Some(&initial_packets.session_id),
            ),
            Self::Out => build_rpc_out_request_with_auth(
                &initial_packets.http_host,
                &initial_packets.rdg_path,
                self.content_length(initial_packets),
                None,
                authorization,
                Some(&initial_packets.session_id),
            ),
        }
    }
}

async fn connect_authenticated_rpc_channel(
    g: &GatewayOpt,
    initial_packets: &GatewayInitialPackets,
    channel: RpcHttpChannel,
) -> Result<GatewayTlsStream, String> {
    let mut stream = connect_gateway_tls(g).await?;
    match g.auth.as_str() {
        "basic" => {
            let authorization =
                build_basic_authorization(&g.username, g.password.as_deref().unwrap_or_default());
            write_rpc_http_headers(
                &mut stream,
                &channel.headers(initial_packets, Some(&authorization)),
                channel,
            )
            .await?;
            let head = read_final_http_response_head_async(&mut stream).await?;
            ensure_http_success(&head, channel.label())?;
            Ok(stream)
        }
        "ntlm" => {
            let type1_message = build_ntlm_negotiate_message(&g.username);
            let type1 = format!("NTLM {}", B64.encode(&type1_message));
            write_rpc_http_headers(
                &mut stream,
                &channel.headers(initial_packets, Some(&type1)),
                channel,
            )
            .await?;
            let mut head = read_final_http_response_head_async(&mut stream).await?;
            if (200..300).contains(&head.status_code) {
                return Ok(stream);
            }
            if head.status_code != 401 {
                ensure_http_success(&head, channel.label())?;
                return Ok(stream);
            }

            let mut challenge_token = www_authenticate_token(&head, "NTLM");
            drain_http_response_body(&mut stream, &head, channel.label()).await?;
            if challenge_token.as_deref().unwrap_or_default().is_empty() {
                write_rpc_http_headers(
                    &mut stream,
                    &channel.headers(initial_packets, Some(&type1)),
                    channel,
                )
                .await?;
                head = read_final_http_response_head_async(&mut stream).await?;
                if head.status_code != 401 {
                    ensure_http_success(&head, channel.label())?;
                    return Ok(stream);
                }
                challenge_token = www_authenticate_token(&head, "NTLM");
                drain_http_response_body(&mut stream, &head, channel.label()).await?;
            }

            let token = challenge_token.filter(|s| !s.is_empty()).ok_or_else(|| {
                format!(
                    "rdg http: {} 401 response did not include an NTLM challenge",
                    channel.label()
                )
            })?;
            let challenge_bytes = B64.decode(token.as_bytes()).map_err(|e| {
                format!(
                    "rdg http: {} NTLM challenge is not valid base64: {}",
                    channel.label(),
                    e
                )
            })?;
            let challenge = ntlm::parse_challenge(&challenge_bytes).map_err(|e| {
                format!(
                    "rdg http: {} NTLM challenge parse failed: {}",
                    channel.label(),
                    e
                )
            })?;
            let type3 = build_ntlm_authenticate_authorization(
                g,
                &type1_message,
                &challenge_bytes,
                &challenge,
                random_client_challenge(),
                current_ntlm_filetime()?,
            )?;
            write_rpc_http_headers(
                &mut stream,
                &channel.headers(initial_packets, Some(&type3)),
                channel,
            )
            .await?;
            let head = read_final_http_response_head_async(&mut stream).await?;
            ensure_http_success(&head, channel.label())?;
            Ok(stream)
        }
        other => Err(format!(
            "rdg: auth '{}' not supported (basic | ntlm)",
            other
        )),
    }
}

async fn write_rpc_http_headers<S>(
    stream: &mut S,
    headers: &[u8],
    channel: RpcHttpChannel,
) -> Result<(), String>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(headers)
        .await
        .map_err(|e| format!("rdg: write {} headers: {}", channel.label(), e))
}

async fn connect_gateway_tls(g: &GatewayOpt) -> Result<GatewayTlsStream, String> {
    let addr = format!("{}:{}", g.host.trim(), g.port);
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("rdg: connect {}: {}", addr, e))?;
    tcp.set_nodelay(true)
        .map_err(|e| format!("rdg: set TCP_NODELAY: {}", e))?;
    let verified = crate::rdp::tls::upgrade(
        tcp,
        g.host.trim(),
        g.port,
        g.certificate_fingerprint.as_deref(),
    )
    .await
    .map_err(|e| format!("rdg: TLS handshake with {}: {}", g.host.trim(), e))?;
    tracing::debug!(
        fingerprint = %verified.fingerprint,
        pinned = verified.used_pin,
        "RD Gateway certificate verified"
    );
    Ok(verified.stream)
}

async fn read_final_http_response_head_async<S>(stream: &mut S) -> Result<HttpResponseHead, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let head = read_http_response_head_async(stream).await?;
        if head.status_code != 100 {
            return Ok(head);
        }
    }
}

async fn read_http_response_head_async<S>(stream: &mut S) -> Result<HttpResponseHead, String>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(1024);
    let mut one = [0u8; 1];
    loop {
        stream
            .read_exact(&mut one)
            .await
            .map_err(|e| format!("rdg http: read response head: {}", e))?;
        buf.push(one[0]);
        if buf.ends_with(b"\r\n\r\n") {
            let (head, _) = parse_http_response_head(&buf)?;
            return Ok(head);
        }
        if buf.len() > 64 * 1024 {
            return Err("rdg http: response head exceeds 64 KiB".into());
        }
    }
}

fn ensure_http_success(head: &HttpResponseHead, channel: &str) -> Result<(), String> {
    if (200..300).contains(&head.status_code) {
        Ok(())
    } else {
        Err(format!(
            "rdg http: {} failed with HTTP {} {}",
            channel, head.status_code, head.reason
        ))
    }
}

async fn drain_http_response_body<S>(
    stream: &mut S,
    head: &HttpResponseHead,
    channel: &str,
) -> Result<(), String>
where
    S: AsyncRead + Unpin,
{
    if head
        .header("Transfer-Encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        return drain_chunked_http_body(stream, channel).await;
    }

    let len = match head.header("Content-Length") {
        Some(raw) => raw.parse::<usize>().map_err(|e| {
            format!(
                "rdg http: {} invalid Content-Length '{}': {}",
                channel, raw, e
            )
        })?,
        None => 0,
    };

    let mut remaining = len;
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let n = remaining.min(buf.len());
        stream
            .read_exact(&mut buf[..n])
            .await
            .map_err(|e| format!("rdg http: {} drain response body: {}", channel, e))?;
        remaining -= n;
    }
    Ok(())
}

async fn drain_chunked_http_body<S>(stream: &mut S, channel: &str) -> Result<(), String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let line = read_http_line_async(stream).await?;
        let size_text = line
            .split_once(';')
            .map(|(size, _)| size)
            .unwrap_or(line.as_str())
            .trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|e| {
            format!(
                "rdg http: {} invalid chunk size '{}': {}",
                channel, size_text, e
            )
        })?;
        if size == 0 {
            loop {
                let trailer = read_http_line_async(stream).await?;
                if trailer.is_empty() {
                    return Ok(());
                }
            }
        }
        let mut remaining = size + 2; // chunk data plus trailing CRLF.
        let mut buf = [0u8; 4096];
        while remaining > 0 {
            let n = remaining.min(buf.len());
            stream
                .read_exact(&mut buf[..n])
                .await
                .map_err(|e| format!("rdg http: {} drain chunked body: {}", channel, e))?;
            remaining -= n;
        }
    }
}

async fn read_http_line_async<S>(stream: &mut S) -> Result<String, String>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(128);
    let mut one = [0u8; 1];
    loop {
        stream
            .read_exact(&mut one)
            .await
            .map_err(|e| format!("rdg http: read line: {}", e))?;
        buf.push(one[0]);
        if buf.ends_with(b"\r\n") {
            buf.truncate(buf.len() - 2);
            return String::from_utf8(buf)
                .map_err(|e| format!("rdg http: line is not UTF-8: {}", e));
        }
        if buf.len() > 8192 {
            return Err("rdg http: line exceeds 8 KiB".into());
        }
    }
}

async fn read_rpc_pdu<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    let mut header = [0u8; RpcPduHeader::SIZE];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("rdg rpc: read PDU header: {}", e))?;
    let parsed = RpcPduHeader::parse(&header)?;
    let frag_length = parsed.frag_length as usize;
    if frag_length < RpcPduHeader::SIZE {
        return Err(format!("rdg rpc: invalid frag_length {}", frag_length));
    }
    let mut pdu = Vec::with_capacity(frag_length);
    pdu.extend_from_slice(&header);
    pdu.resize(frag_length, 0);
    stream
        .read_exact(&mut pdu[RpcPduHeader::SIZE..])
        .await
        .map_err(|e| format!("rdg rpc: read PDU body: {}", e))?;
    Ok(pdu)
}

async fn read_non_rts_pdu<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let pdu = read_rpc_pdu(stream).await?;
        let header = RpcPduHeader::parse(&pdu)?;
        if header.pdu_type != rpch::RPC_PT_RTS {
            return Ok(pdu);
        }
    }
}

async fn read_response_for_call<S>(
    stream: &mut S,
    call_id: u32,
    label: &str,
) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let pdu = read_non_rts_pdu(stream).await?;
        let header = RpcPduHeader::parse(&pdu)?;
        if header.pdu_type == RPC_PT_FAULT {
            let fault = parse_fault_pdu(&pdu)?;
            return Err(format!(
                "rdg rpc: {} fault status=0x{:08x}",
                label, fault.status
            ));
        }
        let resp = parse_response_pdu(&pdu)?;
        if resp.header.call_id == call_id {
            return Ok(resp.stub.to_vec());
        }
    }
}

fn ensure_rpc_return_zero(return_value: i32, label: &str) -> Result<(), String> {
    if return_value == 0 {
        Ok(())
    } else {
        Err(format!(
            "rdg rpc: {} returned 0x{:08x}",
            label, return_value as u32
        ))
    }
}

fn spawn_gateway_stream(
    in_stream: GatewayTlsStream,
    out_stream: GatewayTlsStream,
    tunnel_context: ndr::ContextHandle,
    channel_context: ndr::ContextHandle,
    receive_call_id: u32,
) -> GatewayStream {
    let (reader_tx, reader_rx) = tokio::io::duplex(64 * 1024);
    let (writer_tx, writer_rx) = tokio::io::duplex(64 * 1024);
    let next_call_id = Arc::new(AtomicU32::new(100));
    let (cancel_tx, cancel_rx) = watch::channel(());

    tokio::spawn(gateway_reader_task(
        out_stream,
        reader_tx,
        receive_call_id,
        cancel_rx,
    ));
    tokio::spawn(gateway_writer_task(
        in_stream,
        writer_rx,
        tunnel_context,
        channel_context,
        next_call_id,
    ));

    GatewayStream::new(reader_rx, writer_tx).with_cancel(cancel_tx)
}

async fn gateway_reader_task(
    mut out_stream: GatewayTlsStream,
    mut reader_tx: DuplexStream,
    receive_call_id: u32,
    mut cancel_rx: watch::Receiver<()>,
) {
    loop {
        let pdu = tokio::select! {
            pdu = read_non_rts_pdu(&mut out_stream) => match pdu {
                Ok(pdu) => pdu,
                Err(e) => {
                    tracing::debug!("rdg reader stopped: {}", e);
                    let _ = reader_tx.shutdown().await;
                    return;
                }
            },
            changed = cancel_rx.changed() => {
                if changed.is_err() {
                    tracing::debug!("rdg reader cancelled");
                    let _ = reader_tx.shutdown().await;
                    return;
                }
                continue;
            }
        };
        let resp = match parse_response_pdu(&pdu) {
            Ok(resp) => resp,
            Err(_) => continue,
        };
        if resp.header.call_id != receive_call_id {
            continue;
        }
        match decode_receive_pipe_response(&resp) {
            Ok(ReceivePipePayload::Data(data)) => {
                if reader_tx.write_all(&data).await.is_err() {
                    return;
                }
            }
            Ok(ReceivePipePayload::FinalReturn(_)) | Err(_) => {
                let _ = reader_tx.shutdown().await;
                return;
            }
        }
    }
}

async fn gateway_writer_task(
    mut in_stream: GatewayTlsStream,
    mut writer_rx: DuplexStream,
    tunnel_context: ndr::ContextHandle,
    channel_context: ndr::ContextHandle,
    next_call_id: Arc<AtomicU32>,
) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = match writer_rx.read(&mut buf).await {
            Ok(0) => {
                close_gateway_contexts(
                    &mut in_stream,
                    &channel_context,
                    &tunnel_context,
                    &next_call_id,
                )
                .await;
                return;
            }
            Ok(n) => n,
            Err(e) => {
                tracing::debug!("rdg writer stopped: {}", e);
                close_gateway_contexts(
                    &mut in_stream,
                    &channel_context,
                    &tunnel_context,
                    &next_call_id,
                )
                .await;
                return;
            }
        };
        let call_id = next_call_id.fetch_add(1, Ordering::Relaxed);
        let pdu = match build_send_to_server_request(call_id, &channel_context, &buf[..n]) {
            Ok(pdu) => pdu,
            Err(e) => {
                tracing::debug!("rdg writer stopped: {}", e);
                return;
            }
        };
        if let Err(e) = in_stream.write_all(&pdu).await {
            tracing::debug!("rdg writer write failed: {}", e);
            close_gateway_contexts(
                &mut in_stream,
                &channel_context,
                &tunnel_context,
                &next_call_id,
            )
            .await;
            return;
        }
    }
}

async fn close_gateway_contexts<S>(
    in_stream: &mut S,
    channel_context: &ndr::ContextHandle,
    tunnel_context: &ndr::ContextHandle,
    next_call_id: &AtomicU32,
) where
    S: AsyncWrite + Unpin,
{
    let close_channel_id = next_call_id.fetch_add(1, Ordering::Relaxed);
    let close_channel = ndr::build_close_channel_request(close_channel_id, channel_context);
    if let Err(e) = in_stream.write_all(&close_channel).await {
        tracing::debug!("rdg close channel write failed: {}", e);
        let _ = in_stream.shutdown().await;
        return;
    }

    let close_tunnel_id = next_call_id.fetch_add(1, Ordering::Relaxed);
    let close_tunnel = ndr::build_close_tunnel_request(close_tunnel_id, tunnel_context);
    if let Err(e) = in_stream.write_all(&close_tunnel).await {
        tracing::debug!("rdg close tunnel write failed: {}", e);
    }
    let _ = in_stream.shutdown().await;
}

fn validate_gateway_base(
    g: &GatewayOpt,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    if g.host.trim().is_empty() {
        return Err("rdg: gateway host is empty".into());
    }
    if g.port == 0 {
        return Err("rdg: gateway port must be > 0".into());
    }
    match g.auth.as_str() {
        "basic" | "ntlm" => {}
        other => {
            return Err(format!(
                "rdg: auth '{}' not supported (basic | ntlm)",
                other
            ));
        }
    }
    if g.username.trim().is_empty() {
        return Err("rdg: gateway username is empty".into());
    }
    if g.password.as_deref().unwrap_or("").is_empty() {
        return Err("rdg: gateway password is empty".into());
    }
    if target_host.trim().is_empty() {
        return Err("rdg: target host is empty".into());
    }
    if target_port == 0 {
        return Err("rdg: target port must be > 0".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_header_round_trip() {
        let h = RpcPduHeader {
            pdu_type: RPC_PT_BIND,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: 256,
            auth_length: 16,
            call_id: 42,
        };
        let buf = h.encode();
        let h2 = RpcPduHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn rpc_header_rejects_bad_version() {
        let mut buf = RpcPduHeader {
            pdu_type: 0,
            pfc_flags: 0,
            frag_length: 16,
            auth_length: 0,
            call_id: 0,
        }
        .encode();
        buf[0] = 4;
        assert!(RpcPduHeader::parse(&buf).is_err());
    }

    #[test]
    fn bind_pdu_layout() {
        let p = BindParams {
            max_xmit_frag: 4280,
            max_recv_frag: 4280,
            assoc_group_id: 0,
            call_id: 1,
        };
        let interface = [0u8; 16];
        let xfer = [1u8; 16];
        let buf = build_bind_pdu(p, interface, 1, xfer, 2, &[]);
        let h = RpcPduHeader::parse(&buf).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_BIND);
        assert_eq!(h.frag_length as usize, buf.len());
        // body starts at offset 16. max_xmit_frag = 4280 little-endian.
        assert_eq!(u16::from_le_bytes([buf[16], buf[17]]), 4280);
    }

    #[test]
    fn tsproxy_bind_uses_official_interface_and_ndr_syntax() {
        let buf = build_tsproxy_bind_pdu(1);
        let h = RpcPduHeader::parse(&buf).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_BIND);
        assert_eq!(h.call_id, 1);
        assert_eq!(&buf[32..48], &TSPROXY_RPC_INTERFACE_UUID);
        assert_eq!(
            u32::from_le_bytes([buf[48], buf[49], buf[50], buf[51]]),
            TSPROXY_RPC_INTERFACE_VERSION
        );
        assert_eq!(&buf[52..68], &NDR_TRANSFER_SYNTAX_UUID);
        assert_eq!(
            u32::from_le_bytes([buf[68], buf[69], buf[70], buf[71]]),
            NDR_TRANSFER_SYNTAX_VERSION
        );
    }

    #[test]
    fn parses_bind_ack_result_list() {
        let mut body = Vec::new();
        body.extend_from_slice(&4280u16.to_le_bytes());
        body.extend_from_slice(&4280u16.to_le_bytes());
        body.extend_from_slice(&0x1234u32.to_le_bytes());
        body.extend_from_slice(&5u16.to_le_bytes());
        body.extend_from_slice(b"3388\0");
        while (RpcPduHeader::SIZE + body.len()) % 4 != 0 {
            body.push(0);
        }
        body.push(1); // n_results
        body.push(0);
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes()); // acceptance
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&NDR_TRANSFER_SYNTAX_UUID);
        body.extend_from_slice(&NDR_TRANSFER_SYNTAX_VERSION.to_le_bytes());

        let mut pdu = RpcPduHeader {
            pdu_type: RPC_PT_BIND_ACK,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: (RpcPduHeader::SIZE + body.len()) as u16,
            auth_length: 0,
            call_id: 1,
        }
        .encode()
        .to_vec();
        pdu.extend_from_slice(&body);

        let parsed = parse_bind_ack_pdu(&pdu).unwrap();
        assert_eq!(parsed.max_xmit_frag, 4280);
        assert_eq!(parsed.max_recv_frag, 4280);
        assert_eq!(parsed.assoc_group_id, 0x1234);
        assert_eq!(parsed.secondary_address, "3388");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].result, 0);
        assert_eq!(
            parsed.results[0].transfer_syntax_uuid,
            NDR_TRANSFER_SYNTAX_UUID
        );
    }

    #[test]
    fn request_response_round_trip() {
        let req = build_request_pdu(7, 5, &[1, 2, 3, 4]);
        let h = RpcPduHeader::parse(&req).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_REQUEST);
        assert_eq!(h.call_id, 7);
        assert_eq!(h.frag_length as usize, req.len());

        // Synthesize a fake response header + body to exercise the parser.
        let stub = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let body_len = 8 + stub.len();
        let mut resp = RpcPduHeader {
            pdu_type: RPC_PT_RESPONSE,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: (RpcPduHeader::SIZE + body_len) as u16,
            auth_length: 0,
            call_id: 7,
        }
        .encode()
        .to_vec();
        resp.extend_from_slice(&(stub.len() as u32).to_le_bytes());
        resp.extend_from_slice(&0u16.to_le_bytes());
        resp.push(0);
        resp.push(0);
        resp.extend_from_slice(&stub);
        let parsed = parse_response_pdu(&resp).unwrap();
        assert_eq!(parsed.alloc_hint, stub.len() as u32);
        assert_eq!(parsed.cancel_count, 0);
        assert_eq!(parsed.stub, &stub[..]);
    }

    #[test]
    fn parses_fault_pdu_status() {
        let mut fault = RpcPduHeader {
            pdu_type: RPC_PT_FAULT,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: 16 + 16,
            auth_length: 0,
            call_id: 99,
        }
        .encode()
        .to_vec();
        fault.extend_from_slice(&4u32.to_le_bytes());
        fault.extend_from_slice(&0u16.to_le_bytes());
        fault.push(0);
        fault.push(0);
        fault.extend_from_slice(&0x0000_59ddu32.to_le_bytes());
        fault.extend_from_slice(&0u32.to_le_bytes());

        let parsed = parse_fault_pdu(&fault).unwrap();
        assert_eq!(parsed.header.call_id, 99);
        assert_eq!(parsed.status, 0x0000_59dd);
    }

    #[test]
    fn http_in_request_includes_required_headers() {
        let bytes = build_rpc_in_request("rdg.example.com", "/rpc/rpcproxy.dll", 1024, Some("k=v"));
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.starts_with("RPC_IN_DATA /rpc/rpcproxy.dll HTTP/1.1\r\n"));
        assert!(s.contains("Host: rdg.example.com\r\n"));
        assert!(s.contains("Content-Type: application/rpc\r\n"));
        assert!(s.contains("Content-Length: 1024\r\n"));
        assert!(s.contains("Cookie: k=v\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }

    #[test]
    fn http_out_request_changes_method() {
        let bytes = build_rpc_out_request("rdg.example.com", "/rpc/rpcproxy.dll", 0, None);
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.starts_with("RPC_OUT_DATA "));
        assert!(!s.contains("Cookie:"));
    }

    #[test]
    fn http_request_can_include_authorization() {
        let auth = build_basic_authorization("alice", "secret");
        assert_eq!(auth, "Basic YWxpY2U6c2VjcmV0");
        let bytes = build_rpc_in_request_with_auth(
            "rdg.example.com",
            "/rpc/rpcproxy.dll",
            1,
            None,
            Some(&auth),
            None,
        );
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.contains("Authorization: Basic YWxpY2U6c2VjcmV0\r\n"));
    }

    #[test]
    fn gateway_initial_packets_include_http_auth_and_rpc_seed_pdus() {
        let g = GatewayOpt {
            host: "rdg.example.com".into(),
            port: 443,
            username: "alice".into(),
            password: Some("secret".into()),
            auth: "basic".into(),
            use_session_creds: false,
            certificate_fingerprint: None,
        };
        let packets = build_gateway_initial_packets(&g).unwrap();
        assert_eq!(packets.http_host, "rdg.example.com");
        assert_eq!(packets.rdg_path, "/rpc/rpcproxy.dll?rdg.example.com:3388");
        let in_headers = std::str::from_utf8(&packets.rpc_in_headers).unwrap();
        assert!(
            in_headers.starts_with("RPC_IN_DATA /rpc/rpcproxy.dll?rdg.example.com:3388 HTTP/1.1")
        );
        assert!(in_headers.contains("Authorization: Basic YWxpY2U6c2VjcmV0\r\n"));
        assert!(
            in_headers.contains(
                "Pragma: ResourceTypeUuid=44e265dd-7daf-42cd-8560-3cdb6e7a2729, SessionId="
            )
        );
        assert!(in_headers.contains("Content-Length: 1073741824\r\n"));
        let out_headers = std::str::from_utf8(&packets.rpc_out_headers).unwrap();
        assert!(out_headers.contains("Content-Length: 76\r\n"));
        assert_eq!(
            rpch::RtsPduHeader::parse(&packets.conn_a1_pdu)
                .unwrap()
                .number_of_commands,
            4
        );
        assert_eq!(
            rpch::RtsPduHeader::parse(&packets.conn_b1_pdu)
                .unwrap()
                .number_of_commands,
            6
        );
        assert_eq!(
            RpcPduHeader::parse(&packets.bind_pdu).unwrap().pdu_type,
            RPC_PT_BIND
        );
        assert_eq!(
            u16::from_le_bytes([packets.create_tunnel_pdu[22], packets.create_tunnel_pdu[23]]),
            ndr::TSPROXY_OPNUM_CREATE_TUNNEL
        );
    }

    #[test]
    fn gateway_initial_packets_support_ntlm_type1_seed() {
        let g = GatewayOpt {
            host: "rdg.example.com".into(),
            port: 8443,
            username: "CORP\\alice".into(),
            password: Some("secret".into()),
            auth: "ntlm".into(),
            use_session_creds: false,
            certificate_fingerprint: None,
        };
        let packets = build_gateway_initial_packets(&g).unwrap();
        assert_eq!(packets.http_host, "rdg.example.com:8443");
        let in_headers = std::str::from_utf8(&packets.rpc_in_headers).unwrap();
        assert!(in_headers.contains("Host: rdg.example.com:8443\r\n"));
        assert!(in_headers.contains("Authorization: NTLM "));
        assert_eq!(split_ntlm_domain_user("CORP\\alice"), ("CORP", "alice"));
        assert_eq!(split_ntlm_domain_user("alice"), ("", "alice"));
    }

    #[test]
    fn ntlm_filetime_uses_windows_epoch() {
        assert_eq!(
            ntlm_filetime_from_unix_duration(Duration::ZERO),
            116_444_736_000_000_000
        );
        assert_eq!(
            ntlm_filetime_from_unix_duration(Duration::from_millis(1)),
            116_444_736_000_010_000
        );
    }

    #[test]
    fn ntlm_authenticate_header_decodes_as_type3() {
        let g = GatewayOpt {
            host: "rdg.example.com".into(),
            port: 443,
            username: "CORP\\alice".into(),
            password: Some("secret".into()),
            auth: "ntlm".into(),
            use_session_creds: false,
            certificate_fingerprint: None,
        };
        let challenge = ntlm::ChallengeMessage {
            target_name: b"CORP".to_vec(),
            flags: ntlm::NEG_UNICODE
                | ntlm::NEG_NTLM
                | ntlm::NEG_EXTENDED_SESSION_SECURITY
                | ntlm::NEG_TARGET_INFO
                | ntlm::NEG_KEY_EXCHANGE,
            server_challenge: [1, 2, 3, 4, 5, 6, 7, 8],
            target_info: vec![0, 0, 0, 0],
        };
        let type1 = build_ntlm_negotiate_message(&g.username);
        let type2 = b"synthetic-type2-for-mic";
        let header = build_ntlm_authenticate_authorization(
            &g,
            &type1,
            type2,
            &challenge,
            [9, 9, 9, 9, 9, 9, 9, 9],
            116_444_736_000_000_000,
        )
        .unwrap();
        let token = header.strip_prefix("NTLM ").unwrap();
        let bytes = B64.decode(token).unwrap();
        assert_eq!(&bytes[0..8], ntlm::NTLM_SIGNATURE);
        assert_eq!(
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            ntlm::TYPE_AUTHENTICATE
        );
        let flags = u32::from_le_bytes([bytes[60], bytes[61], bytes[62], bytes[63]]);
        assert_eq!(flags & ntlm::NEG_KEY_EXCHANGE, 0);
        assert_ne!(
            &bytes[ntlm::AUTHENTICATE_MIC_OFFSET..ntlm::AUTHENTICATE_FIXED_HEADER_LEN],
            &[0u8; ntlm::AUTHENTICATE_MIC_LEN]
        );
    }

    #[test]
    fn parses_http_response_head_and_authenticate_headers() {
        let raw = b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM TlRMTVNTUAAC\r\nContent-Length: 0\r\n\r\nignored";
        let (head, used) = parse_http_response_head(raw).unwrap();
        assert_eq!(used, raw.len() - b"ignored".len());
        assert_eq!(head.status_code, 401);
        assert_eq!(head.reason, "Unauthorized");
        assert_eq!(head.header("content-length"), Some("0"));
        assert_eq!(
            www_authenticate_token(&head, "Negotiate"),
            Some(String::new())
        );
        assert_eq!(
            www_authenticate_token(&head, "NTLM"),
            Some("TlRMTVNTUAAC".into())
        );
    }

    #[test]
    fn builds_receive_pipe_message_from_context() {
        let ctx = [0x11u8; RDG_CONTEXT_HANDLE_SIZE];
        let msg = build_receive_pipe_message(&ctx);
        assert_eq!(msg, ctx);
        let req = build_setup_receive_pipe_request(10, &ctx);
        let h = RpcPduHeader::parse(&req).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_REQUEST);
        assert_eq!(h.call_id, 10);
        assert_eq!(
            u16::from_le_bytes([req[22], req[23]]),
            TSPROXY_OPNUM_SETUP_RECEIVE_PIPE
        );
    }

    #[test]
    fn builds_generic_send_data_message() {
        let mut ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
        ctx[4] = 0x36;
        let msg = build_send_data_message(&ctx, &[&[0x04, 0x00, 0x00, 0x03]]).unwrap();
        assert_eq!(&msg[..RDG_CONTEXT_HANDLE_SIZE], &ctx);
        assert_eq!(
            u32::from_be_bytes([
                msg[RDG_CONTEXT_HANDLE_SIZE],
                msg[RDG_CONTEXT_HANDLE_SIZE + 1],
                msg[RDG_CONTEXT_HANDLE_SIZE + 2],
                msg[RDG_CONTEXT_HANDLE_SIZE + 3],
            ]),
            8
        );
        assert_eq!(
            u32::from_be_bytes([
                msg[RDG_CONTEXT_HANDLE_SIZE + 4],
                msg[RDG_CONTEXT_HANDLE_SIZE + 5],
                msg[RDG_CONTEXT_HANDLE_SIZE + 6],
                msg[RDG_CONTEXT_HANDLE_SIZE + 7],
            ]),
            1
        );
        assert_eq!(
            u32::from_be_bytes([
                msg[RDG_CONTEXT_HANDLE_SIZE + 8],
                msg[RDG_CONTEXT_HANDLE_SIZE + 9],
                msg[RDG_CONTEXT_HANDLE_SIZE + 10],
                msg[RDG_CONTEXT_HANDLE_SIZE + 11],
            ]),
            4
        );
        assert_eq!(
            &msg[RDG_CONTEXT_HANDLE_SIZE + 12..],
            &[0x04, 0x00, 0x00, 0x03]
        );
    }

    #[test]
    fn send_data_message_enforces_rpc_message_limit() {
        let ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
        let too_large = vec![0u8; 32767 - RDG_CONTEXT_HANDLE_SIZE - 8 - 4 + 1];
        let err = build_send_data_message(&ctx, &[&too_large]).unwrap_err();
        assert!(err.contains("maximum is 32767"));
    }

    #[test]
    fn builds_send_to_server_request() {
        let ctx = [0x22u8; RDG_CONTEXT_HANDLE_SIZE];
        let req = build_send_to_server_request(11, &ctx, b"rdp").unwrap();
        let h = RpcPduHeader::parse(&req).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_REQUEST);
        assert_eq!(h.call_id, 11);
        assert_eq!(
            u16::from_le_bytes([req[22], req[23]]),
            TSPROXY_OPNUM_SEND_TO_SERVER
        );
        assert!(req.ends_with(b"rdp"));
    }

    #[tokio::test]
    async fn close_gateway_contexts_writes_channel_then_tunnel_close() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let channel_context = [0x22u8; RDG_CONTEXT_HANDLE_SIZE];
        let tunnel_context = [0x33u8; RDG_CONTEXT_HANDLE_SIZE];
        let next_call_id = AtomicU32::new(200);

        close_gateway_contexts(
            &mut client,
            &channel_context,
            &tunnel_context,
            &next_call_id,
        )
        .await;

        let mut written = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut server, &mut written)
            .await
            .unwrap();
        let first = RpcPduHeader::parse(&written).unwrap();
        assert_eq!(first.call_id, 200);
        assert_eq!(
            u16::from_le_bytes([written[22], written[23]]),
            ndr::TSPROXY_OPNUM_CLOSE_CHANNEL
        );

        let second_offset = first.frag_length as usize;
        let second = RpcPduHeader::parse(&written[second_offset..]).unwrap();
        assert_eq!(second.call_id, 201);
        assert_eq!(
            u16::from_le_bytes([written[second_offset + 22], written[second_offset + 23]]),
            ndr::TSPROXY_OPNUM_CLOSE_TUNNEL
        );
        assert_eq!(next_call_id.load(Ordering::Relaxed), 202);
    }

    #[test]
    fn decode_receive_pipe_response_distinguishes_data_and_final_return() {
        let mut data_resp = RpcPduHeader {
            pdu_type: RPC_PT_RESPONSE,
            pfc_flags: PFC_FIRST_FRAG,
            frag_length: 16 + 8 + 3,
            auth_length: 0,
            call_id: 12,
        }
        .encode()
        .to_vec();
        data_resp.extend_from_slice(&3u32.to_le_bytes());
        data_resp.extend_from_slice(&0u16.to_le_bytes());
        data_resp.extend_from_slice(&[0, 0]);
        data_resp.extend_from_slice(b"abc");
        let parsed = parse_response_pdu(&data_resp).unwrap();
        assert_eq!(
            decode_receive_pipe_response(&parsed).unwrap(),
            ReceivePipePayload::Data(b"abc".to_vec())
        );

        let mut final_resp = RpcPduHeader {
            pdu_type: RPC_PT_RESPONSE,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: 16 + 8 + 4,
            auth_length: 0,
            call_id: 12,
        }
        .encode()
        .to_vec();
        final_resp.extend_from_slice(&4u32.to_le_bytes());
        final_resp.extend_from_slice(&0u16.to_le_bytes());
        final_resp.extend_from_slice(&[0, 0]);
        final_resp.extend_from_slice(&0x000004CAu32.to_le_bytes());
        let parsed = parse_response_pdu(&final_resp).unwrap();
        assert_eq!(
            decode_receive_pipe_response(&parsed).unwrap(),
            ReceivePipePayload::FinalReturn(0x000004CA)
        );
    }

    #[tokio::test]
    async fn open_tunnel_rejects_invalid_config() {
        let g = GatewayOpt {
            host: "".into(),
            port: 443,
            username: "".into(),
            password: None,
            auth: "ntlm".into(),
            use_session_creds: true,
            certificate_fingerprint: None,
        };
        assert!(open_tunnel(&g, "host", 3389).await.is_err());
    }

    #[tokio::test]
    async fn open_tunnel_rejects_unsupported_auth() {
        let g = GatewayOpt {
            host: "rdg".into(),
            port: 443,
            username: "u".into(),
            password: Some("p".into()),
            auth: "kerberos".into(),
            use_session_creds: true,
            certificate_fingerprint: None,
        };
        let err = match open_tunnel(&g, "host", 3389).await {
            Ok(_) => panic!("should reject"),
            Err(e) => e,
        };
        assert!(err.contains("auth"));
    }

    #[tokio::test]
    async fn open_tunnel_rejects_missing_credentials() {
        let g = GatewayOpt {
            host: "rdg".into(),
            port: 443,
            username: "".into(),
            password: Some("p".into()),
            auth: "ntlm".into(),
            use_session_creds: true,
            certificate_fingerprint: None,
        };
        let err = match open_tunnel(&g, "host", 3389).await {
            Ok(_) => panic!("should reject missing username"),
            Err(e) => e,
        };
        assert!(err.contains("username"));

        let g = GatewayOpt {
            username: "u".into(),
            password: None,
            ..g
        };
        let err = match open_tunnel(&g, "host", 3389).await {
            Ok(_) => panic!("should reject missing password"),
            Err(e) => e,
        };
        assert!(err.contains("password"));
    }

    #[tokio::test]
    #[ignore = "requires TAOMNI_RDP_GATEWAY_LIVE_* env vars and a reachable Windows RD Gateway"]
    async fn live_rdg_tunnel_opens() {
        let Some(host) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_HOST") else {
            eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_HOST is not set");
            return;
        };
        let Some(username) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_USER") else {
            eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_USER is not set");
            return;
        };
        let Some(password) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_PASS") else {
            eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_PASS is not set");
            return;
        };
        let Some(target_host) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_TARGET_HOST") else {
            eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_TARGET_HOST is not set");
            return;
        };
        let gateway = GatewayOpt {
            host,
            port: env_u16("TAOMNI_RDP_GATEWAY_LIVE_PORT", 443),
            username,
            password: Some(password),
            auth: env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_AUTH").unwrap_or_else(|| "ntlm".into()),
            use_session_creds: false,
            certificate_fingerprint: env_nonempty(
                "TAOMNI_RDP_GATEWAY_LIVE_CERTIFICATE_FINGERPRINT",
            ),
        };
        let target_port = env_u16("TAOMNI_RDP_GATEWAY_LIVE_TARGET_PORT", 3389);

        let _stream = open_tunnel(&gateway, &target_host, target_port)
            .await
            .unwrap();
    }

    fn env_nonempty(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn env_u16(name: &str, default: u16) -> u16 {
        match std::env::var(name) {
            Ok(value) if !value.is_empty() => value.parse().unwrap(),
            _ => default,
        }
    }
}
