//! MS-RPCH RTS helpers used before the TsProxy MS-TSGU calls.
//!
//! RD Gateway is not just DCE/RPC request/response over two HTTPS
//! streams. The RPC-over-HTTP layer first establishes a virtual connection
//! with RTS PDUs; TsProxy binding and method calls happen after that.

use uuid::Uuid;

use super::{PFC_FIRST_FRAG, PFC_LAST_FRAG, RPC_VERSION, RPC_VERSION_MINOR, RpcPduHeader};

pub const RPC_PT_RTS: u8 = 0x14;

pub const RTS_FLAG_NONE: u16 = 0x0000;
pub const RTS_FLAG_PING: u16 = 0x0001;
pub const RTS_FLAG_OTHER_CMD: u16 = 0x0002;
pub const RTS_FLAG_RECYCLE_CHANNEL: u16 = 0x0004;
pub const RTS_FLAG_IN_CHANNEL: u16 = 0x0008;
pub const RTS_FLAG_OUT_CHANNEL: u16 = 0x0010;
pub const RTS_FLAG_EOF: u16 = 0x0020;
pub const RTS_FLAG_ECHO: u16 = 0x0040;

pub const RTS_CMD_RECEIVE_WINDOW_SIZE: u32 = 0x0000_0000;
pub const RTS_CMD_FLOW_CONTROL_ACK: u32 = 0x0000_0001;
pub const RTS_CMD_CONNECTION_TIMEOUT: u32 = 0x0000_0002;
pub const RTS_CMD_COOKIE: u32 = 0x0000_0003;
pub const RTS_CMD_CHANNEL_LIFETIME: u32 = 0x0000_0004;
pub const RTS_CMD_CLIENT_KEEPALIVE: u32 = 0x0000_0005;
pub const RTS_CMD_VERSION: u32 = 0x0000_0006;
pub const RTS_CMD_EMPTY: u32 = 0x0000_0007;
pub const RTS_CMD_PADDING: u32 = 0x0000_0008;
pub const RTS_CMD_NEGATIVE_ANCE: u32 = 0x0000_0009;
pub const RTS_CMD_ANCE: u32 = 0x0000_000a;
pub const RTS_CMD_CLIENT_ADDRESS: u32 = 0x0000_000b;
pub const RTS_CMD_ASSOCIATION_GROUP_ID: u32 = 0x0000_000c;
pub const RTS_CMD_DESTINATION: u32 = 0x0000_000d;
pub const RTS_CMD_PING_TRAFFIC_SENT_NOTIFY: u32 = 0x0000_000e;

pub const RPCH_VERSION: u32 = 1;
pub const DEFAULT_RECEIVE_WINDOW: u32 = 0x0001_0000;
pub const DEFAULT_CHANNEL_LIFETIME: u32 = 0x4000_0000;
pub const DEFAULT_CLIENT_KEEPALIVE_MS: u32 = 300_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtsPduHeader {
    pub frag_length: u16,
    pub flags: u16,
    pub number_of_commands: u16,
}

impl RtsPduHeader {
    pub const SIZE: usize = RpcPduHeader::SIZE + 4;

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!("RPCH RTS header truncated ({} bytes)", buf.len()));
        }
        let common = RpcPduHeader::parse(buf)?;
        if common.pdu_type != RPC_PT_RTS {
            return Err(format!(
                "RPCH RTS: expected pdu_type=0x14, got 0x{:02x}",
                common.pdu_type
            ));
        }
        if common.auth_length != 0 {
            return Err(format!(
                "RPCH RTS: auth_length must be 0, got {}",
                common.auth_length
            ));
        }
        if common.call_id != 0 {
            return Err(format!(
                "RPCH RTS: call_id must be 0, got {}",
                common.call_id
            ));
        }
        Ok(Self {
            frag_length: common.frag_length,
            flags: u16::from_le_bytes([buf[16], buf[17]]),
            number_of_commands: u16::from_le_bytes([buf[18], buf[19]]),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtsCookies {
    pub virtual_connection: [u8; 16],
    pub in_channel: [u8; 16],
    pub out_channel: [u8; 16],
    pub association_group: [u8; 16],
}

impl RtsCookies {
    pub fn new_random() -> Self {
        Self {
            virtual_connection: *Uuid::new_v4().as_bytes(),
            in_channel: *Uuid::new_v4().as_bytes(),
            out_channel: *Uuid::new_v4().as_bytes(),
            association_group: *Uuid::new_v4().as_bytes(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnA3 {
    pub connection_timeout: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnC2 {
    pub version: u32,
    pub receive_window_size: u32,
    pub connection_timeout: u32,
}

pub fn build_conn_a1_pdu(cookies: &RtsCookies, receive_window: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(76);
    write_rts_header(&mut out, 76, RTS_FLAG_NONE, 4);
    write_version(&mut out);
    write_cookie(&mut out, &cookies.virtual_connection);
    write_cookie(&mut out, &cookies.out_channel);
    write_u32_command(&mut out, RTS_CMD_RECEIVE_WINDOW_SIZE, receive_window);
    out
}

pub fn build_conn_b1_pdu(
    cookies: &RtsCookies,
    channel_lifetime: u32,
    client_keepalive_ms: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(104);
    write_rts_header(&mut out, 104, RTS_FLAG_NONE, 6);
    write_version(&mut out);
    write_cookie(&mut out, &cookies.virtual_connection);
    write_cookie(&mut out, &cookies.in_channel);
    write_u32_command(&mut out, RTS_CMD_CHANNEL_LIFETIME, channel_lifetime);
    write_u32_command(&mut out, RTS_CMD_CLIENT_KEEPALIVE, client_keepalive_ms);
    write_association_group_id(&mut out, &cookies.association_group);
    out
}

pub fn parse_conn_a3_pdu(buf: &[u8]) -> Result<ConnA3, String> {
    let header = RtsPduHeader::parse(buf)?;
    if header.flags != RTS_FLAG_NONE || header.number_of_commands != 1 {
        return Err(format!(
            "RPCH CONN/A3: unexpected flags=0x{:04x} command_count={}",
            header.flags, header.number_of_commands
        ));
    }
    let mut r = RtsReader::new(&buf[RtsPduHeader::SIZE..header.frag_length as usize])?;
    let connection_timeout = r.read_u32_command(RTS_CMD_CONNECTION_TIMEOUT)?;
    r.expect_end()?;
    Ok(ConnA3 { connection_timeout })
}

pub fn parse_conn_c2_pdu(buf: &[u8]) -> Result<ConnC2, String> {
    let header = RtsPduHeader::parse(buf)?;
    if header.flags != RTS_FLAG_NONE || header.number_of_commands != 3 {
        return Err(format!(
            "RPCH CONN/C2: unexpected flags=0x{:04x} command_count={}",
            header.flags, header.number_of_commands
        ));
    }
    let mut r = RtsReader::new(&buf[RtsPduHeader::SIZE..header.frag_length as usize])?;
    let version = r.read_u32_command(RTS_CMD_VERSION)?;
    let receive_window_size = r.read_u32_command(RTS_CMD_RECEIVE_WINDOW_SIZE)?;
    let connection_timeout = r.read_u32_command(RTS_CMD_CONNECTION_TIMEOUT)?;
    r.expect_end()?;
    Ok(ConnC2 {
        version,
        receive_window_size,
        connection_timeout,
    })
}

fn write_rts_header(out: &mut Vec<u8>, frag_length: u16, flags: u16, number_of_commands: u16) {
    out.push(RPC_VERSION);
    out.push(RPC_VERSION_MINOR);
    out.push(RPC_PT_RTS);
    out.push(PFC_FIRST_FRAG | PFC_LAST_FRAG);
    out.extend_from_slice(&[0x10, 0, 0, 0]);
    out.extend_from_slice(&frag_length.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&number_of_commands.to_le_bytes());
}

fn write_version(out: &mut Vec<u8>) {
    write_u32_command(out, RTS_CMD_VERSION, RPCH_VERSION);
}

fn write_cookie(out: &mut Vec<u8>, cookie: &[u8; 16]) {
    out.extend_from_slice(&RTS_CMD_COOKIE.to_le_bytes());
    out.extend_from_slice(cookie);
}

fn write_association_group_id(out: &mut Vec<u8>, association_group_id: &[u8; 16]) {
    out.extend_from_slice(&RTS_CMD_ASSOCIATION_GROUP_ID.to_le_bytes());
    out.extend_from_slice(association_group_id);
}

fn write_u32_command(out: &mut Vec<u8>, command: u32, value: u32) {
    out.extend_from_slice(&command.to_le_bytes());
    out.extend_from_slice(&value.to_le_bytes());
}

struct RtsReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> RtsReader<'a> {
    fn new(buf: &'a [u8]) -> Result<Self, String> {
        Ok(Self { buf, pos: 0 })
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        if self.buf.len().saturating_sub(self.pos) < 4 {
            return Err("RPCH RTS command truncated".into());
        }
        let value = u32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(value)
    }

    fn read_u32_command(&mut self, expected_command: u32) -> Result<u32, String> {
        let command = self.read_u32()?;
        if command != expected_command {
            return Err(format!(
                "RPCH RTS: expected command 0x{expected_command:08x}, got 0x{command:08x}"
            ));
        }
        self.read_u32()
    }

    fn expect_end(&self) -> Result<(), String> {
        if self.pos == self.buf.len() {
            Ok(())
        } else {
            Err(format!(
                "RPCH RTS: {} trailing bytes after commands",
                self.buf.len() - self.pos
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_cookies() -> RtsCookies {
        RtsCookies {
            virtual_connection: [0x11; 16],
            in_channel: [0x22; 16],
            out_channel: [0x33; 16],
            association_group: [0x44; 16],
        }
    }

    #[test]
    fn conn_a1_matches_rpch_layout() {
        let pdu = build_conn_a1_pdu(&fixed_cookies(), DEFAULT_RECEIVE_WINDOW);
        assert_eq!(pdu.len(), 76);
        let h = RtsPduHeader::parse(&pdu).unwrap();
        assert_eq!(h.frag_length as usize, pdu.len());
        assert_eq!(h.flags, RTS_FLAG_NONE);
        assert_eq!(h.number_of_commands, 4);
        assert_eq!(&pdu[20..24], &RTS_CMD_VERSION.to_le_bytes());
        assert_eq!(&pdu[24..28], &RPCH_VERSION.to_le_bytes());
        assert_eq!(&pdu[28..32], &RTS_CMD_COOKIE.to_le_bytes());
        assert_eq!(&pdu[32..48], &[0x11; 16]);
        assert_eq!(&pdu[48..52], &RTS_CMD_COOKIE.to_le_bytes());
        assert_eq!(&pdu[52..68], &[0x33; 16]);
        assert_eq!(&pdu[68..72], &RTS_CMD_RECEIVE_WINDOW_SIZE.to_le_bytes());
        assert_eq!(&pdu[72..76], &DEFAULT_RECEIVE_WINDOW.to_le_bytes());
    }

    #[test]
    fn conn_b1_matches_rpch_layout() {
        let pdu = build_conn_b1_pdu(
            &fixed_cookies(),
            DEFAULT_CHANNEL_LIFETIME,
            DEFAULT_CLIENT_KEEPALIVE_MS,
        );
        assert_eq!(pdu.len(), 104);
        let h = RtsPduHeader::parse(&pdu).unwrap();
        assert_eq!(h.flags, RTS_FLAG_NONE);
        assert_eq!(h.number_of_commands, 6);
        assert_eq!(&pdu[28..32], &RTS_CMD_COOKIE.to_le_bytes());
        assert_eq!(&pdu[32..48], &[0x11; 16]);
        assert_eq!(&pdu[48..52], &RTS_CMD_COOKIE.to_le_bytes());
        assert_eq!(&pdu[52..68], &[0x22; 16]);
        assert_eq!(&pdu[68..72], &RTS_CMD_CHANNEL_LIFETIME.to_le_bytes());
        assert_eq!(&pdu[72..76], &DEFAULT_CHANNEL_LIFETIME.to_le_bytes());
        assert_eq!(&pdu[76..80], &RTS_CMD_CLIENT_KEEPALIVE.to_le_bytes());
        assert_eq!(&pdu[80..84], &DEFAULT_CLIENT_KEEPALIVE_MS.to_le_bytes());
        assert_eq!(&pdu[84..88], &RTS_CMD_ASSOCIATION_GROUP_ID.to_le_bytes());
        assert_eq!(&pdu[88..104], &[0x44; 16]);
    }

    #[test]
    fn parses_conn_a3_and_conn_c2() {
        let mut a3 = Vec::new();
        write_rts_header(&mut a3, 28, RTS_FLAG_NONE, 1);
        write_u32_command(&mut a3, RTS_CMD_CONNECTION_TIMEOUT, 120_000);
        assert_eq!(
            parse_conn_a3_pdu(&a3).unwrap(),
            ConnA3 {
                connection_timeout: 120_000
            }
        );

        let mut c2 = Vec::new();
        write_rts_header(&mut c2, 44, RTS_FLAG_NONE, 3);
        write_version(&mut c2);
        write_u32_command(&mut c2, RTS_CMD_RECEIVE_WINDOW_SIZE, 65_536);
        write_u32_command(&mut c2, RTS_CMD_CONNECTION_TIMEOUT, 120_000);
        assert_eq!(
            parse_conn_c2_pdu(&c2).unwrap(),
            ConnC2 {
                version: 1,
                receive_window_size: 65_536,
                connection_timeout: 120_000
            }
        );
    }
}
