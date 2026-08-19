//! KeyValueCodec CellBlock encoding/decoding.
//!
//! HBase ferries the bulk of cell data outside protobuf, in a "cell block": a
//! length-prefixed concatenation of KeyValue cells appended after the protobuf
//! portion of a frame. The codec class advertised in the ConnectionHeader is
//! `org.apache.hadoop.hbase.codec.KeyValueCodec`. The number of cells is carried
//! out-of-band (ScanResponse.cells_per_result / Result.associated_cell_count),
//! not in the block itself.
//!
//! One cell on the wire (all integers big-endian):
//! ```text
//! u32 kv_len      // length of everything after this field
//! u32 key_len     // length of the Key section
//! u32 value_len   // length of the value
//! ── Key section (key_len bytes) ──
//! u16 row_len | row | u8 family_len | family | qualifier
//!   | u64 timestamp | u8 cell_type
//! ── Value (value_len bytes) ──
//! ```
//! `qualifier_len` is derived: key_len - (2 + row_len + 1 + family_len + 8 + 1).

use bytes::{Buf, BufMut, Bytes, BytesMut};

/// KeyValue.Type byte codes (HBase `KeyValue.Type`); see Cell.proto CellType.
pub mod cell_type {
    pub const MINIMUM: u8 = 0;
    pub const PUT: u8 = 4;
    pub const DELETE: u8 = 8;
    pub const DELETE_FAMILY_VERSION: u8 = 10;
    pub const DELETE_COLUMN: u8 = 12;
    pub const DELETE_FAMILY: u8 = 14;
    pub const MAXIMUM: u8 = 255;
}

/// HBase's "latest timestamp" sentinel (`HConstants.LATEST_TIMESTAMP`): the
/// server stamps the current time when it sees `i64::MAX`.
pub const LATEST_TIMESTAMP: u64 = i64::MAX as u64;

/// A decoded cell. Backed by a single `Bytes` buffer with the four variable
/// fields exposed as zero-copy slices.
#[derive(Clone)]
pub struct Cell {
    pub row: Bytes,
    pub family: Bytes,
    pub qualifier: Bytes,
    pub timestamp: u64,
    pub cell_type: u8,
    pub value: Bytes,
}

impl std::fmt::Debug for Cell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cell")
            .field("row", &String::from_utf8_lossy(&self.row))
            .field("family", &String::from_utf8_lossy(&self.family))
            .field("qualifier", &String::from_utf8_lossy(&self.qualifier))
            .field("timestamp", &self.timestamp)
            .field("cell_type", &self.cell_type)
            .field("value", &String::from_utf8_lossy(&self.value))
            .finish()
    }
}

#[derive(Debug)]
pub enum CellError {
    Truncated(String),
    Invalid(String),
}

impl std::fmt::Display for CellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CellError::Truncated(s) => write!(f, "truncated cell block: {s}"),
            CellError::Invalid(s) => write!(f, "invalid cell: {s}"),
        }
    }
}

impl std::error::Error for CellError {}

impl Cell {
    /// Encode this cell into a fresh `Bytes` (`u32 kv_len | ... | value`).
    pub fn encode(&self) -> Bytes {
        let row_len = self.row.len();
        let family_len = self.family.len();
        let qualifier_len = self.qualifier.len();
        let value_len = self.value.len();
        // Key = 2 + row + 1 + family + qualifier + 8 (ts) + 1 (type)
        let key_len = 2 + row_len + 1 + family_len + qualifier_len + 8 + 1;
        // kv_len = key_len field + value_len field + key + value
        let kv_len = 4 + 4 + key_len + value_len;

        let mut buf = BytesMut::with_capacity(4 + kv_len);
        buf.put_u32(kv_len as u32);
        buf.put_u32(key_len as u32);
        buf.put_u32(value_len as u32);
        buf.put_u16(row_len as u16);
        buf.extend_from_slice(&self.row);
        buf.put_u8(family_len as u8);
        buf.extend_from_slice(&self.family);
        buf.extend_from_slice(&self.qualifier);
        buf.put_u64(self.timestamp);
        buf.put_u8(self.cell_type);
        buf.extend_from_slice(&self.value);
        buf.freeze()
    }

    /// Decode exactly one cell from the front of `buf`, advancing it past the
    /// consumed bytes. The buffer must own its memory as `Bytes` so slices are
    /// zero-copy; we take `&mut Bytes`.
    pub fn decode(buf: &mut Bytes) -> Result<Cell, CellError> {
        if buf.len() < 4 {
            return Err(CellError::Truncated("missing kv_len".into()));
        }
        let kv_len = buf.get_u32() as usize; // advances 4
        if buf.len() < kv_len {
            return Err(CellError::Truncated(format!(
                "kv_len {kv_len} exceeds remaining {}",
                buf.len()
            )));
        }
        // Work within exactly kv_len bytes.
        let mut body = buf.split_to(kv_len);
        if body.len() < 8 {
            return Err(CellError::Truncated("missing key/value lengths".into()));
        }
        let key_len = body.get_u32() as usize;
        let value_len = body.get_u32() as usize;
        if body.len() != key_len + value_len {
            return Err(CellError::Invalid(format!(
                "key_len {key_len} + value_len {value_len} != body {}",
                body.len()
            )));
        }
        let mut key = body.split_to(key_len);
        let value = body; // remaining value_len bytes

        // Parse the key section.
        if key.len() < 2 {
            return Err(CellError::Truncated("missing row_len".into()));
        }
        let row_len = key.get_u16() as usize;
        if key.len() < row_len + 1 {
            return Err(CellError::Truncated("row/family_len".into()));
        }
        let row = key.split_to(row_len);
        let family_len = key.get_u8() as usize;
        // Remaining must hold: family + qualifier + 8 (ts) + 1 (type)
        if key.len() < family_len + 9 {
            return Err(CellError::Truncated("family/qualifier/ts/type".into()));
        }
        let family = key.split_to(family_len);
        let qualifier_len = key.len() - 9; // 8 ts + 1 type
        let qualifier = key.split_to(qualifier_len);
        let timestamp = key.get_u64();
        let cell_type = key.get_u8();
        debug_assert!(key.is_empty(), "key section fully consumed");

        Ok(Cell {
            row,
            family,
            qualifier,
            timestamp,
            cell_type,
            value,
        })
    }
}

/// Encode a sequence of cells into one cell block.
pub fn encode_cell_block(cells: &[Cell]) -> Bytes {
    let mut out = BytesMut::new();
    for cell in cells {
        out.extend_from_slice(&cell.encode());
    }
    out.freeze()
}

/// Decode `count` cells from `block`. Stops early if the block is exhausted
/// (returning what was parsed) only when `count` is `None`; when `count` is
/// given, it is an error to run short.
pub fn decode_cell_block(block: Bytes, count: Option<usize>) -> Result<Vec<Cell>, CellError> {
    let mut buf = block;
    let mut cells = Vec::new();
    match count {
        Some(n) => {
            for _ in 0..n {
                cells.push(Cell::decode(&mut buf)?);
            }
        }
        None => {
            while !buf.is_empty() {
                cells.push(Cell::decode(&mut buf)?);
            }
        }
    }
    Ok(cells)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Cell {
        Cell {
            row: Bytes::from_static(b"row-key-1"),
            family: Bytes::from_static(b"cf"),
            qualifier: Bytes::from_static(b"q1"),
            timestamp: 1234567890,
            cell_type: cell_type::PUT,
            value: Bytes::from_static(b"the-value"),
        }
    }

    #[test]
    fn cell_roundtrip() {
        let c = sample();
        let mut encoded = c.encode();
        let decoded = Cell::decode(&mut encoded).unwrap();
        assert_eq!(&decoded.row[..], b"row-key-1");
        assert_eq!(&decoded.family[..], b"cf");
        assert_eq!(&decoded.qualifier[..], b"q1");
        assert_eq!(decoded.timestamp, 1234567890);
        assert_eq!(decoded.cell_type, cell_type::PUT);
        assert_eq!(&decoded.value[..], b"the-value");
        assert!(encoded.is_empty(), "decode consumes exactly one cell");
    }

    #[test]
    fn empty_qualifier_and_value() {
        let c = Cell {
            row: Bytes::from_static(b"r"),
            family: Bytes::from_static(b"f"),
            qualifier: Bytes::new(),
            timestamp: LATEST_TIMESTAMP,
            cell_type: cell_type::DELETE_FAMILY,
            value: Bytes::new(),
        };
        let mut e = c.encode();
        let d = Cell::decode(&mut e).unwrap();
        assert!(d.qualifier.is_empty());
        assert!(d.value.is_empty());
        assert_eq!(d.timestamp, LATEST_TIMESTAMP);
        assert_eq!(d.cell_type, cell_type::DELETE_FAMILY);
    }

    #[test]
    fn multi_cell_block_with_count() {
        let cells = vec![sample(), sample(), sample()];
        let block = encode_cell_block(&cells);
        let decoded = decode_cell_block(block, Some(3)).unwrap();
        assert_eq!(decoded.len(), 3);
        for d in &decoded {
            assert_eq!(&d.value[..], b"the-value");
        }
    }

    #[test]
    fn multi_cell_block_no_count() {
        let cells = vec![sample(), sample()];
        let block = encode_cell_block(&cells);
        let decoded = decode_cell_block(block, None).unwrap();
        assert_eq!(decoded.len(), 2);
    }

    #[test]
    fn truncated_block_errors() {
        let mut e = sample().encode();
        // Lop off the last byte to truncate the value.
        let truncated = e.split_to(e.len() - 1);
        let mut b = truncated;
        assert!(matches!(Cell::decode(&mut b), Err(CellError::Truncated(_))));
    }

    #[test]
    fn count_short_errors() {
        let block = encode_cell_block(&[sample()]);
        // Ask for 2 when only 1 is present.
        assert!(decode_cell_block(block, Some(2)).is_err());
    }

    #[test]
    fn known_byte_layout() {
        // Verify exact wire bytes for a tiny cell so we catch layout drift.
        let c = Cell {
            row: Bytes::from_static(b"r"),       // row_len=1
            family: Bytes::from_static(b"f"),    // family_len=1
            qualifier: Bytes::from_static(b"q"), // qualifier_len=1
            timestamp: 0x0102030405060708,
            cell_type: cell_type::PUT,
            value: Bytes::from_static(b"v"), // value_len=1
        };
        let e = c.encode();
        // key_len = 2 + 1 + 1 + 1 + 1 + 8 + 1 = 15
        // kv_len  = 4 + 4 + 15 + 1 = 24
        let expected: Vec<u8> = [
            &[0, 0, 0, 24][..], // kv_len
            &[0, 0, 0, 15][..], // key_len
            &[0, 0, 0, 1][..],  // value_len
            &[0, 1][..],        // row_len = 1
            b"r",
            &[1][..], // family_len = 1
            b"f",
            b"q",                          // qualifier (len derived)
            &[1, 2, 3, 4, 5, 6, 7, 8][..], // timestamp BE
            &[cell_type::PUT][..],
            b"v",
        ]
        .concat();
        assert_eq!(&e[..], &expected[..]);
    }
}
