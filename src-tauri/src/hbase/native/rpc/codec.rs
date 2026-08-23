//! HBase RPC frame encoding/decoding.
//!
//! Wire layout (HBase 0.95+, all integer prefixes big-endian; see
//! <https://hbase.apache.org/docs/rpc>):
//!
//! Connection preamble (once per TCP connection):
//! ```text
//! "HBas" (4B magic) | 0x00 (RPC version) | auth byte (0x50 simple / 0x51 kerberos)
//! | u32 BE len | ConnectionHeader protobuf
//! ```
//! The server sends no reply on success.
//!
//! Request frame:
//! ```text
//! u32 BE total_len | varint+RequestHeader | [varint+param] | [cell_block]
//! ```
//! Response frame:
//! ```text
//! u32 BE total_len | varint+ResponseHeader | [varint+response] | [cell_block]
//! ```
//! where `total_len` covers everything after the 4-byte length field, and the
//! trailing cell block length (when present) is carried in
//! `*.cell_block_meta.length`.

use bytes::{Buf, BufMut, Bytes, BytesMut};
use prost::Message;

use super::super::proto::pb;

/// 6-byte connection preamble magic + RPC format version (auth byte appended).
pub const RPC_MAGIC: &[u8; 4] = b"HBas";
pub const RPC_VERSION: u8 = 0;
pub const AUTH_SIMPLE: u8 = 80; // 0x50
pub const AUTH_KERBEROS: u8 = 81; // 0x51

pub const KEYVALUE_CODEC_CLASS: &str = "org.apache.hadoop.hbase.codec.KeyValueCodec";
pub const CLIENT_SERVICE: &str = "ClientService";
pub const MASTER_SERVICE: &str = "MasterService";

/// Errors surfaced by the frame codec.
#[derive(Debug)]
pub enum CodecError {
    /// The buffer does not yet hold a full frame; caller should read more.
    Incomplete,
    /// A protobuf message failed to decode.
    Decode(String),
    /// The frame was structurally invalid (bad varint, truncated, oversized).
    Malformed(String),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::Incomplete => write!(f, "incomplete frame"),
            CodecError::Decode(e) => write!(f, "protobuf decode failed: {e}"),
            CodecError::Malformed(e) => write!(f, "malformed frame: {e}"),
        }
    }
}

impl std::error::Error for CodecError {}

/// Build the 6-byte connection preamble for the given auth method.
pub fn connection_preamble(auth: u8) -> [u8; 6] {
    [
        RPC_MAGIC[0],
        RPC_MAGIC[1],
        RPC_MAGIC[2],
        RPC_MAGIC[3],
        RPC_VERSION,
        auth,
    ]
}

/// Serialize a `ConnectionHeader` as `u32 BE len | bytes`, ready to write right
/// after the preamble.
pub fn encode_connection_header(header: &pb::ConnectionHeader) -> Bytes {
    let body = header.encode_to_vec();
    let mut out = BytesMut::with_capacity(4 + body.len());
    out.put_u32(body.len() as u32);
    out.extend_from_slice(&body);
    out.freeze()
}

/// Construct the standard client `ConnectionHeader`.
pub fn make_connection_header(effective_user: &str, service_name: &str) -> pb::ConnectionHeader {
    pb::ConnectionHeader {
        user_info: Some(pb::UserInformation {
            effective_user: effective_user.to_string(),
            real_user: None,
        }),
        service_name: Some(service_name.to_string()),
        cell_block_codec_class: Some(KEYVALUE_CODEC_CLASS.to_string()),
        cell_block_compressor_class: None,
        version_info: None,
        rpc_crypto_cipher_transformation: None,
        attribute: Vec::new(),
    }
}

/// Encode one request frame. `param` is the already-serialized request protobuf
/// (e.g. a `GetRequest`); pass `None` for parameterless calls. `cell_block` is
/// the raw KeyValueCodec bytes (already built), appended verbatim.
pub fn encode_request(
    header: &pb::RequestHeader,
    param: Option<&[u8]>,
    cell_block: Option<&[u8]>,
) -> Bytes {
    let header_bytes = header.encode_to_vec();

    // Compute the body length: delimited(header) + delimited(param) + cellblock.
    let mut body = BytesMut::new();
    put_delimited(&mut body, &header_bytes);
    if let Some(p) = param {
        put_delimited(&mut body, p);
    }
    if let Some(cb) = cell_block {
        body.extend_from_slice(cb);
    }

    let mut out = BytesMut::with_capacity(4 + body.len());
    out.put_u32(body.len() as u32);
    out.extend_from_slice(&body);
    out.freeze()
}

/// A decoded response frame: the header plus the still-undecoded response
/// param bytes and trailing cell block (sliced out by length).
#[derive(Debug)]
pub struct ResponseFrame {
    pub header: pb::ResponseHeader,
    /// Serialized response protobuf (decode into the expected type by caller).
    pub param: Bytes,
    /// Raw cell block bytes (KeyValueCodec), empty when none present.
    pub cell_block: Bytes,
}

/// Try to decode a single response frame from `buf`. On success the consumed
/// bytes are removed from `buf` and the frame returned. Returns
/// `Err(CodecError::Incomplete)` (leaving `buf` untouched) when more bytes are
/// needed.
pub fn try_decode_response(buf: &mut BytesMut) -> Result<ResponseFrame, CodecError> {
    if buf.len() < 4 {
        return Err(CodecError::Incomplete);
    }
    // Peek total length without consuming, so an incomplete frame is retryable.
    let total_len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + total_len {
        return Err(CodecError::Incomplete);
    }
    buf.advance(4);
    let mut frame = buf.split_to(total_len);

    // ResponseHeader (length-delimited).
    let header_bytes = take_delimited(&mut frame)?;
    let header =
        pb::ResponseHeader::decode(header_bytes).map_err(|e| CodecError::Decode(e.to_string()))?;

    // The cell block length lives in the header; whatever is not header/param.
    let cell_len = header
        .cell_block_meta
        .as_ref()
        .and_then(|m| m.length)
        .unwrap_or(0) as usize;

    // If the server threw, there is no response param — only the header.
    let (param, cell_block) = if header.exception.is_some() {
        (Bytes::new(), Bytes::new())
    } else if frame.is_empty() {
        (Bytes::new(), Bytes::new())
    } else {
        // Remaining = delimited(param) + cell_block(cell_len).
        if frame.len() < cell_len {
            return Err(CodecError::Malformed(format!(
                "cell block length {cell_len} exceeds remaining {} bytes",
                frame.len()
            )));
        }
        let param_region_len = frame.len() - cell_len;
        let mut param_region = frame.split_to(param_region_len);
        let cell_block = frame.split_to(cell_len).freeze();
        let param = if param_region.is_empty() {
            Bytes::new()
        } else {
            take_delimited(&mut param_region)?
        };
        (param, cell_block)
    };

    Ok(ResponseFrame {
        header,
        param,
        cell_block,
    })
}

/// Append `bytes` to `out` as a protobuf length-delimited field (varint len +
/// payload), matching Java's `writeDelimitedTo`.
fn put_delimited(out: &mut BytesMut, bytes: &[u8]) {
    let mut tmp = [0u8; 10];
    let n = encode_varint(bytes.len() as u64, &mut tmp);
    out.extend_from_slice(&tmp[..n]);
    out.extend_from_slice(bytes);
}

/// Read one length-delimited chunk (varint len + payload) from the front of
/// `buf`, advancing it past the chunk and returning the payload.
fn take_delimited(buf: &mut BytesMut) -> Result<Bytes, CodecError> {
    let (len, consumed) = decode_varint(buf)?;
    let len = len as usize;
    if buf.len() < consumed + len {
        return Err(CodecError::Malformed(format!(
            "delimited chunk wants {len} bytes, only {} available",
            buf.len().saturating_sub(consumed)
        )));
    }
    buf.advance(consumed);
    Ok(buf.split_to(len).freeze())
}

/// Encode a u64 as a protobuf base-128 varint into `out`, returning byte count.
fn encode_varint(mut value: u64, out: &mut [u8; 10]) -> usize {
    let mut i = 0;
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out[i] = byte;
        i += 1;
        if value == 0 {
            break;
        }
    }
    i
}

/// Decode a base-128 varint from the front of `buf` (without consuming).
/// Returns `(value, bytes_consumed)`.
fn decode_varint(buf: &[u8]) -> Result<(u64, usize), CodecError> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for (i, &byte) in buf.iter().enumerate() {
        if shift >= 64 {
            return Err(CodecError::Malformed("varint overflow".into()));
        }
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok((result, i + 1));
        }
        shift += 7;
    }
    Err(CodecError::Incomplete)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_simple_and_kerberos() {
        assert_eq!(connection_preamble(AUTH_SIMPLE), *b"HBas\x00\x50");
        assert_eq!(connection_preamble(AUTH_KERBEROS), *b"HBas\x00\x51");
    }

    #[test]
    fn varint_roundtrip() {
        for v in [0u64, 1, 127, 128, 300, 16384, u32::MAX as u64, u64::MAX] {
            let mut buf = [0u8; 10];
            let n = encode_varint(v, &mut buf);
            let (decoded, consumed) = decode_varint(&buf[..n]).unwrap();
            assert_eq!(decoded, v);
            assert_eq!(consumed, n);
        }
    }

    #[test]
    fn decode_varint_incomplete() {
        // 0x80 means "more bytes follow" but none do.
        assert!(matches!(
            decode_varint(&[0x80]),
            Err(CodecError::Incomplete)
        ));
    }

    #[test]
    fn connection_header_has_codec_and_user() {
        let h = make_connection_header("alice", CLIENT_SERVICE);
        assert_eq!(h.user_info.as_ref().unwrap().effective_user, "alice");
        assert_eq!(h.service_name.as_deref(), Some(CLIENT_SERVICE));
        assert_eq!(
            h.cell_block_codec_class.as_deref(),
            Some(KEYVALUE_CODEC_CLASS)
        );
        let framed = encode_connection_header(&h);
        // First 4 bytes are the BE length of the remainder.
        let len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        assert_eq!(len, framed.len() - 4);
    }

    #[test]
    fn request_response_frame_roundtrip() {
        // Build a request frame, then feed an analogous response back through
        // the decoder to verify framing/delimiting are symmetric.
        let header = pb::RequestHeader {
            call_id: Some(7),
            trace_info: None,
            method_name: Some("Get".to_string()),
            request_param: Some(true),
            cell_block_meta: None,
            priority: None,
            timeout: None,
            attribute: Vec::new(),
        };
        let param = b"hello-param";
        let frame = encode_request(&header, Some(param), None);
        // total_len prefix is correct.
        let total = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(total, frame.len() - 4);

        // Now craft a response with the same shape and decode it.
        let resp_header = pb::ResponseHeader {
            call_id: Some(7),
            exception: None,
            cell_block_meta: None,
        };
        let rh_bytes = resp_header.encode_to_vec();
        let mut body = BytesMut::new();
        put_delimited(&mut body, &rh_bytes);
        put_delimited(&mut body, param);
        let mut full = BytesMut::new();
        full.put_u32(body.len() as u32);
        full.extend_from_slice(&body);

        let decoded = try_decode_response(&mut full).unwrap();
        assert_eq!(decoded.header.call_id, Some(7));
        assert_eq!(&decoded.param[..], param);
        assert!(decoded.cell_block.is_empty());
        assert!(full.is_empty(), "decoder must consume the whole frame");
    }

    #[test]
    fn try_decode_incomplete_is_retryable() {
        let mut buf = BytesMut::new();
        buf.put_u32(100); // claims 100 bytes follow, but none do
        assert!(matches!(
            try_decode_response(&mut buf),
            Err(CodecError::Incomplete)
        ));
        // Buffer must be left intact for a retry.
        assert_eq!(buf.len(), 4);
    }

    #[test]
    fn response_with_cell_block_splits_correctly() {
        let resp_header = pb::ResponseHeader {
            call_id: Some(1),
            exception: None,
            cell_block_meta: Some(pb::CellBlockMeta { length: Some(5) }),
        };
        let rh = resp_header.encode_to_vec();
        let param = b"P";
        let cells = b"CELLS";
        let mut body = BytesMut::new();
        put_delimited(&mut body, &rh);
        put_delimited(&mut body, param);
        body.extend_from_slice(cells);
        let mut full = BytesMut::new();
        full.put_u32(body.len() as u32);
        full.extend_from_slice(&body);

        let decoded = try_decode_response(&mut full).unwrap();
        assert_eq!(&decoded.param[..], param);
        assert_eq!(&decoded.cell_block[..], cells);
    }
}
