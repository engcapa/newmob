//! Minimal NDR helpers for the MS-TSGU TsProxy RPC interface.
//!
//! MS-TSGU uses ordinary NDR for tunnel/channel setup, but bypasses NDR
//! for `TsProxySetupReceivePipe` and `TsProxySendToServer`. The parent
//! module already owns those data-phase helpers; this module covers the
//! handshake stubs that precede them.

use super::{RDG_CONTEXT_HANDLE_SIZE, build_request_pdu};

pub type ContextHandle = [u8; RDG_CONTEXT_HANDLE_SIZE];

pub const TSPROXY_OPNUM_CREATE_TUNNEL: u16 = 1;
pub const TSPROXY_OPNUM_AUTHORIZE_TUNNEL: u16 = 2;
pub const TSPROXY_OPNUM_MAKE_TUNNEL_CALL: u16 = 3;
pub const TSPROXY_OPNUM_CREATE_CHANNEL: u16 = 4;
pub const TSPROXY_OPNUM_CLOSE_CHANNEL: u16 = 6;
pub const TSPROXY_OPNUM_CLOSE_TUNNEL: u16 = 7;
pub const TSPROXY_OPNUM_SETUP_RECEIVE_PIPE: u16 = 8;
pub const TSPROXY_OPNUM_SEND_TO_SERVER: u16 = 9;

pub const TSG_PACKET_TYPE_HEADER: u32 = 0x0000_4844;
pub const TSG_PACKET_TYPE_VERSIONCAPS: u32 = 0x0000_5643;
pub const TSG_PACKET_TYPE_QUARREQUEST: u32 = 0x0000_5152;
pub const TSG_PACKET_TYPE_RESPONSE: u32 = 0x0000_5052;
pub const TSG_PACKET_TYPE_QUARENC_RESPONSE: u32 = 0x0000_4552;
pub const TSG_PACKET_TYPE_CAPS_RESPONSE: u32 = 0x0000_4350;
pub const TSG_PACKET_TYPE_MSGREQUEST_PACKET: u32 = 0x0000_4752;
pub const TSG_PACKET_TYPE_MESSAGE_PACKET: u32 = 0x0000_4750;

pub const TSG_CAPABILITY_TYPE_NAP: u32 = 0x0000_0001;
pub const TSG_NAP_CAPABILITY_QUAR_SOH: u32 = 0x0000_0001;
pub const TSG_NAP_CAPABILITY_IDLE_TIMEOUT: u32 = 0x0000_0002;
pub const TSG_MESSAGING_CAP_CONSENT_SIGN: u32 = 0x0000_0004;
pub const TSG_MESSAGING_CAP_SERVICE_MSG: u32 = 0x0000_0008;
pub const TSG_MESSAGING_CAP_REAUTH: u32 = 0x0000_0010;

pub const TSG_TUNNEL_CALL_ASYNC_MSG_REQUEST: u32 = 0x0000_0001;
pub const TS_GATEWAY_TRANSPORT: u16 = 0x5452;

pub const DEFAULT_CLIENT_CAPABILITIES: u32 = TSG_NAP_CAPABILITY_IDLE_TIMEOUT
    | TSG_MESSAGING_CAP_CONSENT_SIGN
    | TSG_MESSAGING_CAP_SERVICE_MSG
    | TSG_MESSAGING_CAP_REAUTH;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateTunnelResponse {
    pub packet_id: u32,
    pub capabilities: Option<u32>,
    pub nonce: Option<[u8; 16]>,
    pub tunnel_context: ContextHandle,
    pub tunnel_id: u32,
    pub return_value: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizeTunnelResponse {
    pub flags: u32,
    pub reserved: u32,
    pub response_data_len: u32,
    pub redirection_flags: [u32; 8],
    pub return_value: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateChannelResponse {
    pub channel_context: ContextHandle,
    pub channel_id: u32,
    pub return_value: i32,
}

struct NdrWriter {
    out: Vec<u8>,
    next_ref: u32,
}

impl NdrWriter {
    fn new() -> Self {
        Self {
            out: Vec::new(),
            next_ref: 0,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.out
    }

    fn u16(&mut self, v: u16) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }

    fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }

    fn bytes(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    fn unique_ptr(&mut self, present: bool) {
        if present {
            self.u32(0x0002_0000 + self.next_ref * 4);
            self.next_ref += 1;
        } else {
            self.u32(0);
        }
    }

    fn reset_pointer_index(&mut self) {
        self.next_ref = 0;
    }

    fn wide_string(&mut self, value: &str) -> Result<(), String> {
        let units: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        self.wide_units(&units)
    }

    fn wide_units(&mut self, units: &[u16]) -> Result<(), String> {
        let len =
            u32::try_from(units.len()).map_err(|_| "rdg ndr: wide string too long".to_string())?;
        self.u32(len);
        self.u32(0);
        self.u32(len);
        for unit in units {
            self.u16(*unit);
        }
        if units.len() % 2 != 0 {
            self.u16(0);
        }
        Ok(())
    }

    fn conformant_byte_array(&mut self, bytes: &[u8]) -> Result<(), String> {
        let len =
            u32::try_from(bytes.len()).map_err(|_| "rdg ndr: byte array too long".to_string())?;
        self.u32(len);
        self.bytes(bytes);
        let pad = (4 - (bytes.len() % 4)) % 4;
        self.out.extend(std::iter::repeat(0).take(pad));
        Ok(())
    }
}

struct NdrReader<'a> {
    buf: &'a [u8],
    pos: usize,
    next_ref: u32,
}

impl<'a> NdrReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self {
            buf,
            pos: 0,
            next_ref: 0,
        }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn exact(&mut self, len: usize) -> Result<&'a [u8], String> {
        if self.remaining() < len {
            return Err(format!(
                "rdg ndr: truncated stub, need {} bytes at {}, remaining {}",
                len,
                self.pos,
                self.remaining()
            ));
        }
        let start = self.pos;
        self.pos += len;
        Ok(&self.buf[start..self.pos])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let b = self.exact(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.exact(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn i32(&mut self) -> Result<i32, String> {
        let b = self.exact(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn align(&mut self, align: usize) -> Result<(), String> {
        if align == 0 {
            return Ok(());
        }
        let pad = (align - (self.pos % align)) % align;
        self.exact(pad)?;
        Ok(())
    }

    fn context_handle(&mut self) -> Result<ContextHandle, String> {
        let b = self.exact(RDG_CONTEXT_HANDLE_SIZE)?;
        let mut ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
        ctx.copy_from_slice(b);
        Ok(ctx)
    }

    fn pointer(&mut self, required: bool) -> Result<u32, String> {
        let value = self.u32()?;
        if value == 0 {
            if required {
                return Err("rdg ndr: required pointer is null".into());
            }
            return Ok(0);
        }
        let expected = 0x0002_0000 + self.next_ref * 4;
        self.next_ref += 1;
        if (value & 0xffff_0000) != (expected & 0xffff_0000) {
            return Err(format!(
                "rdg ndr: pointer referent 0x{value:08x} is outside expected NDR namespace"
            ));
        }
        Ok(value)
    }

    fn wide_string_units(&mut self) -> Result<Vec<u16>, String> {
        let max_count = self.u32()? as usize;
        let offset = self.u32()?;
        let actual_count = self.u32()? as usize;
        if offset != 0 {
            return Err(format!("rdg ndr: non-zero string offset {}", offset));
        }
        if actual_count > max_count {
            return Err(format!(
                "rdg ndr: string actual_count {} > max_count {}",
                actual_count, max_count
            ));
        }
        let mut out = Vec::with_capacity(actual_count);
        for _ in 0..actual_count {
            out.push(self.u16()?);
        }
        if actual_count % 2 != 0 {
            self.u16()?;
        }
        Ok(out)
    }

    fn conformant_byte_array(&mut self) -> Result<Vec<u8>, String> {
        let max_count = self.u32()? as usize;
        let bytes = self.exact(max_count)?.to_vec();
        let pad = (4 - (max_count % 4)) % 4;
        self.exact(pad)?;
        Ok(bytes)
    }
}

pub fn build_create_tunnel_stub(capabilities: u32) -> Vec<u8> {
    let mut w = NdrWriter::new();
    w.u32(TSG_PACKET_TYPE_VERSIONCAPS);
    w.u32(TSG_PACKET_TYPE_VERSIONCAPS);
    w.unique_ptr(true);
    write_version_caps(&mut w, capabilities);
    w.into_inner()
}

pub fn build_create_tunnel_request(call_id: u32) -> Vec<u8> {
    build_request_pdu(
        call_id,
        TSPROXY_OPNUM_CREATE_TUNNEL,
        &build_create_tunnel_stub(DEFAULT_CLIENT_CAPABILITIES),
    )
}

pub fn build_authorize_tunnel_stub(
    tunnel_context: &ContextHandle,
    machine_name: &str,
    statement_of_health: &[u8],
) -> Result<Vec<u8>, String> {
    let name_units: Vec<u16> = machine_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    if name_units.len() > 513 {
        return Err("rdg ndr: machine name is too long".into());
    }
    if statement_of_health.len() > 8000 {
        return Err("rdg ndr: statement of health is too large".into());
    }

    let mut w = NdrWriter::new();
    w.bytes(tunnel_context);
    w.u32(TSG_PACKET_TYPE_QUARREQUEST);
    w.u32(TSG_PACKET_TYPE_QUARREQUEST);
    w.unique_ptr(true);
    w.u32(0); // flags
    w.unique_ptr(true);
    w.u32(name_units.len() as u32);
    w.unique_ptr(true);
    w.u32(statement_of_health.len() as u32);
    w.wide_units(&name_units)?;
    w.conformant_byte_array(statement_of_health)?;
    Ok(w.into_inner())
}

pub fn build_authorize_tunnel_request(
    call_id: u32,
    tunnel_context: &ContextHandle,
    machine_name: &str,
    statement_of_health: &[u8],
) -> Result<Vec<u8>, String> {
    let stub = build_authorize_tunnel_stub(tunnel_context, machine_name, statement_of_health)?;
    Ok(build_request_pdu(
        call_id,
        TSPROXY_OPNUM_AUTHORIZE_TUNNEL,
        &stub,
    ))
}

pub fn build_make_tunnel_call_stub(tunnel_context: &ContextHandle, proc_id: u32) -> Vec<u8> {
    let mut w = NdrWriter::new();
    w.bytes(tunnel_context);
    w.u32(proc_id);
    w.u32(TSG_PACKET_TYPE_MSGREQUEST_PACKET);
    w.u32(TSG_PACKET_TYPE_MSGREQUEST_PACKET);
    w.unique_ptr(true);
    w.u32(1); // maxMessagesPerBatch
    w.into_inner()
}

pub fn build_make_tunnel_call_request(call_id: u32, tunnel_context: &ContextHandle) -> Vec<u8> {
    build_request_pdu(
        call_id,
        TSPROXY_OPNUM_MAKE_TUNNEL_CALL,
        &build_make_tunnel_call_stub(tunnel_context, TSG_TUNNEL_CALL_ASYNC_MSG_REQUEST),
    )
}

pub fn build_create_channel_stub(
    tunnel_context: &ContextHandle,
    target_host: &str,
    target_port: u16,
) -> Result<Vec<u8>, String> {
    if target_host.trim().is_empty() {
        return Err("rdg ndr: target host is empty".into());
    }
    if target_port == 0 {
        return Err("rdg ndr: target port must be > 0".into());
    }

    let mut w = NdrWriter::new();
    w.bytes(tunnel_context);

    w.unique_ptr(true); // TSENDPOINTINFO.resourceName
    w.u32(1); // numResourceNames
    w.unique_ptr(false); // alternateResourceNames
    w.u16(0); // numAlternateResourceNames
    w.u16(0); // pad to Port
    w.u16(3); // protocolId: RDP
    w.u16(target_port);

    w.u32(1); // conformant array max count for resourceName
    w.reset_pointer_index();
    w.unique_ptr(true); // resourceName[0]
    w.wide_string(target_host)?;
    Ok(w.into_inner())
}

pub fn build_create_channel_request(
    call_id: u32,
    tunnel_context: &ContextHandle,
    target_host: &str,
    target_port: u16,
) -> Result<Vec<u8>, String> {
    let stub = build_create_channel_stub(tunnel_context, target_host, target_port)?;
    Ok(build_request_pdu(
        call_id,
        TSPROXY_OPNUM_CREATE_CHANNEL,
        &stub,
    ))
}

pub fn build_close_channel_request(call_id: u32, channel_context: &ContextHandle) -> Vec<u8> {
    build_request_pdu(call_id, TSPROXY_OPNUM_CLOSE_CHANNEL, channel_context)
}

pub fn build_close_tunnel_request(call_id: u32, tunnel_context: &ContextHandle) -> Vec<u8> {
    build_request_pdu(call_id, TSPROXY_OPNUM_CLOSE_TUNNEL, tunnel_context)
}

pub fn parse_create_tunnel_response_stub(stub: &[u8]) -> Result<CreateTunnelResponse, String> {
    let mut r = NdrReader::new(stub);
    r.pointer(true)?;
    let packet_id = r.u32()?;
    let switch_value = r.u32()?;
    if packet_id != switch_value {
        return Err(format!(
            "rdg ndr: packet_id 0x{packet_id:08x} != switch 0x{switch_value:08x}"
        ));
    }

    match packet_id {
        TSG_PACKET_TYPE_QUARENC_RESPONSE => {
            r.pointer(true)?;
            let quar = read_quarenc_response(&mut r)?;
            let capabilities = read_quarenc_deferred(&mut r, &quar)?;
            let (tunnel_context, tunnel_id, return_value) = read_context_id_return(&mut r)?;
            Ok(CreateTunnelResponse {
                packet_id,
                capabilities,
                nonce: Some(quar.nonce),
                tunnel_context,
                tunnel_id,
                return_value,
            })
        }
        TSG_PACKET_TYPE_CAPS_RESPONSE => {
            r.pointer(true)?;
            let quar = read_quarenc_response(&mut r)?;
            let _msg_id = r.u32()?;
            let msg_type = r.u32()?;
            let is_msg_present = r.i32()?;
            let msg_switch = r.u32()?;
            if msg_type != msg_switch {
                return Err(format!(
                    "rdg ndr: message type 0x{msg_type:08x} != switch 0x{msg_switch:08x}"
                ));
            }
            let msg_ptr = r.pointer(is_msg_present != 0)?;
            let capabilities = read_quarenc_deferred(&mut r, &quar)?;
            if msg_ptr != 0 {
                skip_message_response(&mut r, msg_type)?;
            }
            let (tunnel_context, tunnel_id, return_value) = read_context_id_return(&mut r)?;
            Ok(CreateTunnelResponse {
                packet_id,
                capabilities,
                nonce: Some(quar.nonce),
                tunnel_context,
                tunnel_id,
                return_value,
            })
        }
        other => Err(format!(
            "rdg ndr: unexpected create-tunnel packet id 0x{other:08x}"
        )),
    }
}

pub fn parse_authorize_tunnel_response_stub(
    stub: &[u8],
) -> Result<AuthorizeTunnelResponse, String> {
    let mut r = NdrReader::new(stub);
    r.pointer(true)?;
    let packet_id = r.u32()?;
    let switch_value = r.u32()?;
    if packet_id != TSG_PACKET_TYPE_RESPONSE || switch_value != TSG_PACKET_TYPE_RESPONSE {
        return Err(format!(
            "rdg ndr: unexpected authorize response packet 0x{packet_id:08x}/0x{switch_value:08x}"
        ));
    }
    r.pointer(true)?;
    let flags = r.u32()?;
    let reserved = r.u32()?;
    let data_ptr = r.pointer(false)?;
    let response_data_len = r.u32()?;
    let mut redirection_flags = [0u32; 8];
    for flag in &mut redirection_flags {
        *flag = r.u32()?;
    }
    if data_ptr != 0 {
        let data = r.conformant_byte_array()?;
        if data.len() != response_data_len as usize {
            return Err(format!(
                "rdg ndr: responseData length {} != declared {}",
                data.len(),
                response_data_len
            ));
        }
    } else if response_data_len != 0 {
        return Err("rdg ndr: responseDataLen is non-zero but pointer is null".into());
    }
    let return_value = if r.remaining() >= 4 {
        Some(r.i32()?)
    } else {
        None
    };
    Ok(AuthorizeTunnelResponse {
        flags,
        reserved,
        response_data_len,
        redirection_flags,
        return_value,
    })
}

pub fn parse_create_channel_response_stub(stub: &[u8]) -> Result<CreateChannelResponse, String> {
    let mut r = NdrReader::new(stub);
    let channel_context = r.context_handle()?;
    let channel_id = r.u32()?;
    let return_value = r.i32()?;
    Ok(CreateChannelResponse {
        channel_context,
        channel_id,
        return_value,
    })
}

fn write_version_caps(w: &mut NdrWriter, capabilities: u32) {
    w.u16(TS_GATEWAY_TRANSPORT);
    w.u16(TSG_PACKET_TYPE_VERSIONCAPS as u16);
    w.unique_ptr(true);
    w.u32(1); // numCapabilities
    w.u16(1); // majorVersion
    w.u16(1); // minorVersion
    w.u16(0); // quarantineCapabilities
    w.u16(0); // pad
    w.u32(1); // conformant array max count
    w.u32(TSG_CAPABILITY_TYPE_NAP);
    w.u32(TSG_CAPABILITY_TYPE_NAP);
    w.u32(capabilities);
}

struct QuarEncHeader {
    cert_chain_len: u32,
    cert_chain_ptr: u32,
    nonce: [u8; 16],
    version_caps_ptr: u32,
}

fn read_quarenc_response(r: &mut NdrReader<'_>) -> Result<QuarEncHeader, String> {
    let _flags = r.u32()?;
    let cert_chain_len = r.u32()?;
    let cert_chain_ptr = r.pointer(cert_chain_len != 0)?;
    let nonce_bytes = r.exact(16)?;
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(nonce_bytes);
    let version_caps_ptr = r.pointer(true)?;
    Ok(QuarEncHeader {
        cert_chain_len,
        cert_chain_ptr,
        nonce,
        version_caps_ptr,
    })
}

fn read_quarenc_deferred(
    r: &mut NdrReader<'_>,
    quar: &QuarEncHeader,
) -> Result<Option<u32>, String> {
    if quar.cert_chain_ptr != 0 {
        let units = r.wide_string_units()?;
        if quar.cert_chain_len as usize > units.len() {
            return Err(format!(
                "rdg ndr: certChainLen {} exceeds encoded string units {}",
                quar.cert_chain_len,
                units.len()
            ));
        }
    }
    if quar.version_caps_ptr == 0 {
        return Ok(None);
    }
    read_version_caps(r)
}

fn read_version_caps(r: &mut NdrReader<'_>) -> Result<Option<u32>, String> {
    let _component_id = r.u16()?;
    let _packet_id = r.u16()?;
    r.pointer(true)?;
    let num_capabilities = r.u32()?;
    let _major = r.u16()?;
    let _minor = r.u16()?;
    let _quarantine = r.u16()?;
    r.align(4)?;
    if num_capabilities == 0 {
        return Ok(None);
    }
    let max_count = r.u32()?;
    if max_count == 0 {
        return Ok(None);
    }
    let capability_type = r.u32()?;
    let switch_value = r.u32()?;
    if capability_type != switch_value {
        return Err(format!(
            "rdg ndr: capability type 0x{capability_type:08x} != switch 0x{switch_value:08x}"
        ));
    }
    if capability_type != TSG_CAPABILITY_TYPE_NAP {
        return Err(format!(
            "rdg ndr: unsupported capability type 0x{capability_type:08x}"
        ));
    }
    Ok(Some(r.u32()?))
}

fn read_context_id_return(r: &mut NdrReader<'_>) -> Result<(ContextHandle, u32, i32), String> {
    r.align(4)?;
    let context = r.context_handle()?;
    let id = r.u32()?;
    let return_value = r.i32()?;
    Ok((context, id, return_value))
}

fn skip_message_response(r: &mut NdrReader<'_>, msg_type: u32) -> Result<(), String> {
    match msg_type {
        1 | 2 => {
            let _display_mandatory = r.i32()?;
            let _consent_mandatory = r.i32()?;
            let msg_bytes = r.u32()?;
            let msg_ptr = r.pointer(msg_bytes != 0)?;
            if msg_ptr != 0 {
                r.wide_string_units()?;
            }
            Ok(())
        }
        3 => {
            r.exact(8)?;
            Ok(())
        }
        other => Err(format!(
            "rdg ndr: unsupported async message type 0x{other:08x}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_tunnel_stub_matches_tsproxy_ndr_layout() {
        let stub = build_create_tunnel_stub(DEFAULT_CLIENT_CAPABILITIES);
        assert_eq!(stub.len(), 48);
        assert_eq!(&stub[0..4], &TSG_PACKET_TYPE_VERSIONCAPS.to_le_bytes());
        assert_eq!(&stub[4..8], &TSG_PACKET_TYPE_VERSIONCAPS.to_le_bytes());
        assert_eq!(&stub[8..12], &0x0002_0000u32.to_le_bytes());
        assert_eq!(&stub[12..14], &TS_GATEWAY_TRANSPORT.to_le_bytes());
        assert_eq!(
            &stub[14..16],
            &(TSG_PACKET_TYPE_VERSIONCAPS as u16).to_le_bytes()
        );
        assert_eq!(&stub[16..20], &0x0002_0004u32.to_le_bytes());
        assert_eq!(&stub[20..24], &1u32.to_le_bytes());
        assert_eq!(&stub[24..26], &1u16.to_le_bytes());
        assert_eq!(&stub[26..28], &1u16.to_le_bytes());
        assert_eq!(&stub[28..30], &0u16.to_le_bytes());
        assert_eq!(&stub[32..36], &1u32.to_le_bytes());
        assert_eq!(&stub[36..40], &TSG_CAPABILITY_TYPE_NAP.to_le_bytes());
        assert_eq!(&stub[40..44], &TSG_CAPABILITY_TYPE_NAP.to_le_bytes());
        assert_eq!(&stub[44..48], &DEFAULT_CLIENT_CAPABILITIES.to_le_bytes());
    }

    #[test]
    fn create_tunnel_request_uses_opnum_1() {
        let pdu = build_create_tunnel_request(7);
        assert_eq!(u16::from_le_bytes([pdu[22], pdu[23]]), 1);
        assert!(pdu.ends_with(&DEFAULT_CLIENT_CAPABILITIES.to_le_bytes()));
    }

    #[test]
    fn authorize_tunnel_stub_encodes_quarrequest() {
        let ctx = [0x44u8; RDG_CONTEXT_HANDLE_SIZE];
        let stub = build_authorize_tunnel_stub(&ctx, "CLIENT", &[]).unwrap();
        assert_eq!(&stub[..RDG_CONTEXT_HANDLE_SIZE], &ctx);
        assert_eq!(
            u32::from_le_bytes([stub[20], stub[21], stub[22], stub[23]]),
            TSG_PACKET_TYPE_QUARREQUEST
        );
        assert_eq!(
            u32::from_le_bytes([stub[28], stub[29], stub[30], stub[31]]),
            0x0002_0000
        );
        assert_eq!(
            u32::from_le_bytes([stub[36], stub[37], stub[38], stub[39]]),
            0x0002_0004
        );
        assert_eq!(
            u32::from_le_bytes([stub[40], stub[41], stub[42], stub[43]]),
            7
        );
        assert_eq!(&stub[52..56], &7u32.to_le_bytes());
        assert_eq!(&stub[56..60], &0u32.to_le_bytes());
        assert_eq!(&stub[60..64], &7u32.to_le_bytes());
    }

    #[test]
    fn create_channel_stub_matches_freerdp_layout() {
        let mut ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
        ctx[4] = 0x36;
        let stub = build_create_channel_stub(&ctx, "win10", 3389).unwrap();
        assert_eq!(&stub[..RDG_CONTEXT_HANDLE_SIZE], &ctx);
        assert_eq!(&stub[20..24], &0x0002_0000u32.to_le_bytes());
        assert_eq!(&stub[24..28], &1u32.to_le_bytes());
        assert_eq!(&stub[28..32], &0u32.to_le_bytes());
        assert_eq!(&stub[32..34], &0u16.to_le_bytes());
        assert_eq!(&stub[36..38], &3u16.to_le_bytes());
        assert_eq!(&stub[38..40], &3389u16.to_le_bytes());
        assert_eq!(&stub[40..44], &1u32.to_le_bytes());
        assert_eq!(&stub[44..48], &0x0002_0000u32.to_le_bytes());
        assert_eq!(&stub[48..52], &6u32.to_le_bytes());
        assert_eq!(&stub[52..56], &0u32.to_le_bytes());
        assert_eq!(&stub[56..60], &6u32.to_le_bytes());
    }

    #[test]
    fn close_requests_use_expected_opnums_and_contexts() {
        let channel_context = [0x22u8; RDG_CONTEXT_HANDLE_SIZE];
        let tunnel_context = [0x33u8; RDG_CONTEXT_HANDLE_SIZE];

        let close_channel = build_close_channel_request(11, &channel_context);
        assert_eq!(
            u16::from_le_bytes([close_channel[22], close_channel[23]]),
            TSPROXY_OPNUM_CLOSE_CHANNEL
        );
        assert_eq!(&close_channel[24..44], &channel_context);

        let close_tunnel = build_close_tunnel_request(12, &tunnel_context);
        assert_eq!(
            u16::from_le_bytes([close_tunnel[22], close_tunnel[23]]),
            TSPROXY_OPNUM_CLOSE_TUNNEL
        );
        assert_eq!(&close_tunnel[24..44], &tunnel_context);
    }

    #[test]
    fn parses_create_channel_response_stub() {
        let mut ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
        ctx[7] = 0xaa;
        let mut stub = ctx.to_vec();
        stub.extend_from_slice(&9u32.to_le_bytes());
        stub.extend_from_slice(&0i32.to_le_bytes());
        let parsed = parse_create_channel_response_stub(&stub).unwrap();
        assert_eq!(parsed.channel_context, ctx);
        assert_eq!(parsed.channel_id, 9);
        assert_eq!(parsed.return_value, 0);
    }

    #[test]
    fn parses_authorize_response_stub_without_response_data() {
        let mut stub = Vec::new();
        stub.extend_from_slice(&0x0002_0000u32.to_le_bytes());
        stub.extend_from_slice(&TSG_PACKET_TYPE_RESPONSE.to_le_bytes());
        stub.extend_from_slice(&TSG_PACKET_TYPE_RESPONSE.to_le_bytes());
        stub.extend_from_slice(&0x0002_0004u32.to_le_bytes());
        stub.extend_from_slice(&TSG_PACKET_TYPE_QUARREQUEST.to_le_bytes());
        stub.extend_from_slice(&0u32.to_le_bytes());
        stub.extend_from_slice(&0u32.to_le_bytes());
        stub.extend_from_slice(&0u32.to_le_bytes());
        for _ in 0..8 {
            stub.extend_from_slice(&0u32.to_le_bytes());
        }
        stub.extend_from_slice(&0i32.to_le_bytes());

        let parsed = parse_authorize_tunnel_response_stub(&stub).unwrap();
        assert_eq!(parsed.flags, TSG_PACKET_TYPE_QUARREQUEST);
        assert_eq!(parsed.response_data_len, 0);
        assert_eq!(parsed.return_value, Some(0));
    }

    #[test]
    fn parses_quarenc_create_tunnel_response_stub() {
        let mut ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
        ctx[4] = 0x36;
        let nonce = [0xabu8; 16];

        let mut stub = Vec::new();
        stub.extend_from_slice(&0x0002_0000u32.to_le_bytes());
        stub.extend_from_slice(&TSG_PACKET_TYPE_QUARENC_RESPONSE.to_le_bytes());
        stub.extend_from_slice(&TSG_PACKET_TYPE_QUARENC_RESPONSE.to_le_bytes());
        stub.extend_from_slice(&0x0002_0004u32.to_le_bytes());
        stub.extend_from_slice(&0u32.to_le_bytes()); // flags
        stub.extend_from_slice(&0u32.to_le_bytes()); // certChainLen
        stub.extend_from_slice(&0u32.to_le_bytes()); // certChainData
        stub.extend_from_slice(&nonce);
        stub.extend_from_slice(&0x0002_0008u32.to_le_bytes()); // versionCaps
        stub.extend_from_slice(&build_version_caps_for_test(0x12));
        stub.extend_from_slice(&ctx);
        stub.extend_from_slice(&123u32.to_le_bytes());
        stub.extend_from_slice(&0i32.to_le_bytes());

        let parsed = parse_create_tunnel_response_stub(&stub).unwrap();
        assert_eq!(parsed.packet_id, TSG_PACKET_TYPE_QUARENC_RESPONSE);
        assert_eq!(parsed.capabilities, Some(0x12));
        assert_eq!(parsed.nonce, Some(nonce));
        assert_eq!(parsed.tunnel_context, ctx);
        assert_eq!(parsed.tunnel_id, 123);
        assert_eq!(parsed.return_value, 0);
    }

    fn build_version_caps_for_test(capabilities: u32) -> Vec<u8> {
        let mut w = NdrWriter::new();
        write_version_caps(&mut w, capabilities);
        w.into_inner()
    }
}
