//! Region model, `hbase:meta` row parsing, and the region-name comparator.
//!
//! A region is identified by its name: `table,start_key,region_id.encoded_md5.`
//! Region locations are discovered by scanning `hbase:meta`, whose rows carry:
//! - `info:regioninfo` → `'P' + "PBUF" + RegionInfo protobuf`
//! - `info:server`     → ASCII `host:port` of the serving RegionServer
//! - `info:serverstartcode`, `info:seqnumDuringOpen`, etc. (unused here)

use prost::Message;

use super::cell::Cell;
use super::proto::pb;
use super::zk::ServerEndpoint;

const PBUF_MAGIC: &[u8; 4] = b"PBUF";

/// A located region: its protobuf info plus the serving RegionServer.
#[derive(Debug, Clone)]
pub struct RegionLocation {
    pub region: pb::RegionInfo,
    pub server: ServerEndpoint,
    /// The full region name bytes (`table,startkey,id.md5.`) as read from meta.
    pub region_name: Vec<u8>,
}

impl RegionLocation {
    /// Fully-qualified `namespace:table` of this region.
    pub fn table_qualified(&self) -> String {
        let tn = &self.region.table_name;
        let ns = String::from_utf8_lossy(&tn.namespace);
        let q = String::from_utf8_lossy(&tn.qualifier);
        if ns == "default" || ns.is_empty() {
            q.into_owned()
        } else {
            format!("{ns}:{q}")
        }
    }

    pub fn start_key(&self) -> &[u8] {
        self.region.start_key.as_deref().unwrap_or(&[])
    }

    pub fn end_key(&self) -> &[u8] {
        self.region.end_key.as_deref().unwrap_or(&[])
    }

    /// True if `key` falls within this region's `[start_key, end_key)`.
    /// Empty end_key means "last region" (unbounded above).
    pub fn contains(&self, key: &[u8]) -> bool {
        let after_start = self.start_key().is_empty() || key >= self.start_key();
        let before_end = self.end_key().is_empty() || key < self.end_key();
        after_start && before_end
    }
}

#[derive(Debug)]
pub enum RegionError {
    Parse(String),
    Offline,
    NotFound(String),
}

impl std::fmt::Display for RegionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegionError::Parse(e) => write!(f, "meta row parse failed: {e}"),
            RegionError::Offline => write!(f, "region is offline"),
            RegionError::NotFound(e) => write!(f, "region not found: {e}"),
        }
    }
}

impl std::error::Error for RegionError {}

/// Decode the `info:regioninfo` cell value.
///
/// The value is the `PBUF` magic (4 bytes) directly followed by the
/// `RegionInfo` protobuf. (Some references describe a leading version byte
/// before the magic; HBase 2.x writes the magic at offset 0, where its first
/// byte `0x50` is the ASCII `'P'`. We accept both: magic at offset 0, or a
/// single version byte followed by the magic.)
pub fn parse_region_info(value: &[u8]) -> Result<pb::RegionInfo, RegionError> {
    if value.len() < 4 {
        return Err(RegionError::Parse("regioninfo too short".into()));
    }
    let body = if &value[0..4] == PBUF_MAGIC {
        &value[4..]
    } else if value.len() >= 5 && &value[1..5] == PBUF_MAGIC {
        // Tolerate a leading version byte before the magic.
        &value[5..]
    } else {
        return Err(RegionError::Parse(
            "missing PBUF magic in regioninfo".into(),
        ));
    };
    pb::RegionInfo::decode(body).map_err(|e| RegionError::Parse(e.to_string()))
}

/// Build a `RegionLocation` from the cells of a single `hbase:meta` row.
/// `row_key` is the meta row key (== the region name).
pub fn region_from_meta_cells(
    row_key: &[u8],
    cells: &[Cell],
) -> Result<RegionLocation, RegionError> {
    let mut region_info: Option<pb::RegionInfo> = None;
    let mut server: Option<ServerEndpoint> = None;

    for cell in cells {
        if &cell.family[..] != b"info" {
            continue;
        }
        match &cell.qualifier[..] {
            b"regioninfo" => {
                region_info = Some(parse_region_info(&cell.value)?);
            }
            b"server" => {
                // Value is the literal ASCII "host:port"; empty during NSRE.
                if !cell.value.is_empty() {
                    let s = String::from_utf8_lossy(&cell.value);
                    server = parse_host_port(&s);
                }
            }
            _ => {}
        }
    }

    let region =
        region_info.ok_or_else(|| RegionError::NotFound("no info:regioninfo in row".into()))?;
    if region.offline.unwrap_or(false) {
        return Err(RegionError::Offline);
    }
    let server = server
        .ok_or_else(|| RegionError::NotFound("no info:server (region in transition)".into()))?;

    Ok(RegionLocation {
        region,
        server,
        region_name: row_key.to_vec(),
    })
}

fn parse_host_port(s: &str) -> Option<ServerEndpoint> {
    let (host, port) = s.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    Some(ServerEndpoint {
        host: host.to_string(),
        port,
    })
}

/// Build the meta search key for locating the region containing `(table, key)`.
/// HBase meta rows sort by region name; appending `,:` exploits that `:` is the
/// first byte greater than `9`, so a reversed scan from this key lands on the
/// region whose name is the greatest one <= the target.
pub fn meta_search_key(table: &str, row: &[u8]) -> Vec<u8> {
    let mut k = Vec::with_capacity(table.len() + row.len() + 3);
    k.extend_from_slice(table.as_bytes());
    k.push(b',');
    k.extend_from_slice(row);
    k.extend_from_slice(b",:");
    k
}

/// Build the meta key that stops a forward scan of all regions of `table`:
/// `table,,` is the smallest possible; `table .` (table + first byte > ',') is
/// the smallest key after the table's region range.
pub fn meta_table_start_key(table: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(table.len() + 1);
    k.extend_from_slice(table.as_bytes());
    k.push(b',');
    k
}

pub fn meta_table_stop_key(table: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(table.len() + 1);
    k.extend_from_slice(table.as_bytes());
    // ',' + 1 = '-'? No: the convention uses the table name followed by a byte
    // strictly greater than ',' (0x2c). The next byte value 0x2d works for the
    // standard "all regions of a table" stop key.
    k.push(b',' + 1);
    k
}

/// Compare two region names the way HBase orders them in `hbase:meta`.
///
/// Region name = `table,start_key,timestamp[.encoded.]`. A naive byte compare
/// is wrong because (a) the table delimiter `,` must sort before any real key
/// byte, and (b) within the same table a shorter start key sorts before a
/// longer one with the same prefix. This mirrors gohbase's `region.Compare`.
pub fn compare_region_names(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    // Split each name into (table, rest) on the first comma.
    let (a_table, a_rest) = split_first_comma(a);
    let (b_table, b_rest) = split_first_comma(b);

    match a_table.cmp(b_table) {
        Ordering::Equal => {}
        non_eq => return non_eq,
    }

    // Within the same table, compare the start key, which runs from the first
    // comma up to the last comma (the trailing field is the region id/ts).
    let a_key = key_between_commas(a_rest);
    let b_key = key_between_commas(b_rest);

    // The empty start key (first region) must sort before any non-empty key.
    match (a_key.is_empty(), b_key.is_empty()) {
        (true, true) => return tiebreak(a_rest, b_rest),
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        (false, false) => {}
    }

    match a_key.cmp(b_key) {
        Ordering::Equal => tiebreak(a_rest, b_rest),
        non_eq => non_eq,
    }
}

fn split_first_comma(name: &[u8]) -> (&[u8], &[u8]) {
    match name.iter().position(|&c| c == b',') {
        Some(i) => (&name[..i], &name[i + 1..]),
        None => (name, &[]),
    }
}

/// Given the bytes after the first comma (`start_key,timestamp.md5.`), return
/// the start key (everything up to the last comma).
fn key_between_commas(rest: &[u8]) -> &[u8] {
    match rest.iter().rposition(|&c| c == b',') {
        Some(i) => &rest[..i],
        None => rest,
    }
}

/// Tiebreaker for equal table+startkey: compare the trailing region-id/ts
/// component lexically (newer regions have larger timestamps).
fn tiebreak(a_rest: &[u8], b_rest: &[u8]) -> std::cmp::Ordering {
    let a_tail = a_rest
        .iter()
        .rposition(|&c| c == b',')
        .map(|i| &a_rest[i + 1..])
        .unwrap_or(a_rest);
    let b_tail = b_rest
        .iter()
        .rposition(|&c| c == b',')
        .map(|i| &b_rest[i + 1..])
        .unwrap_or(b_rest);
    a_tail.cmp(b_tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use std::cmp::Ordering;

    fn region_info_value(table: &str, start: &[u8], end: &[u8]) -> Vec<u8> {
        let ri = pb::RegionInfo {
            region_id: 1,
            table_name: pb::TableName {
                namespace: b"default".to_vec(),
                qualifier: table.as_bytes().to_vec(),
            },
            start_key: Some(start.to_vec()),
            end_key: Some(end.to_vec()),
            offline: None,
            split: None,
            replica_id: Some(0),
        };
        let mut v = vec![b'P'];
        v.extend_from_slice(PBUF_MAGIC);
        v.extend_from_slice(&ri.encode_to_vec());
        v
    }

    fn cell(family: &str, qualifier: &str, value: &[u8]) -> Cell {
        Cell {
            row: Bytes::from_static(b"meta-row"),
            family: Bytes::copy_from_slice(family.as_bytes()),
            qualifier: Bytes::copy_from_slice(qualifier.as_bytes()),
            timestamp: 1,
            cell_type: super::super::cell::cell_type::PUT,
            value: Bytes::copy_from_slice(value),
        }
    }

    #[test]
    fn parse_region_info_roundtrip() {
        let v = region_info_value("t1", b"a", b"z");
        let ri = parse_region_info(&v).unwrap();
        assert_eq!(ri.table_name.qualifier, b"t1");
        assert_eq!(ri.start_key.as_deref(), Some(&b"a"[..]));
        assert_eq!(ri.end_key.as_deref(), Some(&b"z"[..]));
    }

    #[test]
    fn region_info_missing_magic() {
        // No PBUF magic at offset 0 or 1 → reject.
        let bad = vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
        assert!(parse_region_info(&bad).is_err());
    }

    #[test]
    fn region_info_magic_at_offset_zero() {
        // HBase 2.x layout: PBUF directly at offset 0.
        let ri = pb::RegionInfo {
            region_id: 9,
            table_name: pb::TableName {
                namespace: b"default".to_vec(),
                qualifier: b"t1".to_vec(),
            },
            start_key: Some(b"a".to_vec()),
            end_key: Some(b"z".to_vec()),
            offline: None,
            split: None,
            replica_id: Some(0),
        };
        let mut v = PBUF_MAGIC.to_vec();
        v.extend_from_slice(&ri.encode_to_vec());
        let parsed = parse_region_info(&v).unwrap();
        assert_eq!(parsed.region_id, 9);
    }

    #[test]
    fn region_from_meta_cells_ok() {
        let cells = vec![
            cell("info", "regioninfo", &region_info_value("t1", b"", b"m")),
            cell("info", "server", b"rs1.example.com:16020"),
        ];
        let loc = region_from_meta_cells(b"t1,,1.abc.", &cells).unwrap();
        assert_eq!(loc.server.host, "rs1.example.com");
        assert_eq!(loc.server.port, 16020);
        assert_eq!(loc.table_qualified(), "t1");
        assert!(loc.contains(b"a"));
        assert!(loc.contains(b"l"));
        assert!(!loc.contains(b"m")); // end exclusive
    }

    #[test]
    fn region_in_transition_has_no_server() {
        let cells = vec![
            cell("info", "regioninfo", &region_info_value("t1", b"", b"")),
            cell("info", "server", b""),
        ];
        assert!(region_from_meta_cells(b"t1,,1.abc.", &cells).is_err());
    }

    #[test]
    fn contains_first_and_last_region() {
        let cells_first = vec![
            cell("info", "regioninfo", &region_info_value("t1", b"", b"m")),
            cell("info", "server", b"h:1"),
        ];
        let first = region_from_meta_cells(b"t1,,1.a.", &cells_first).unwrap();
        assert!(first.contains(b"")); // empty start key
        assert!(first.contains(b"a"));

        let cells_last = vec![
            cell("info", "regioninfo", &region_info_value("t1", b"m", b"")),
            cell("info", "server", b"h:1"),
        ];
        let last = region_from_meta_cells(b"t1,m,1.b.", &cells_last).unwrap();
        assert!(last.contains(b"z")); // empty end key = unbounded
        assert!(!last.contains(b"a"));
    }

    #[test]
    fn meta_search_key_format() {
        assert_eq!(meta_search_key("t1", b"row5"), b"t1,row5,:");
        assert_eq!(meta_search_key("ns:t", b""), b"ns:t,,:");
    }

    #[test]
    fn compare_empty_start_key_sorts_first() {
        // First region of a table (empty start key) must precede any other.
        let first = b"t1,,1.aaa.";
        let second = b"t1,m,2.bbb.";
        assert_eq!(compare_region_names(first, second), Ordering::Less);
        assert_eq!(compare_region_names(second, first), Ordering::Greater);
    }

    #[test]
    fn compare_by_table_first() {
        assert_eq!(
            compare_region_names(b"aaa,,1.x.", b"bbb,,1.x."),
            Ordering::Less
        );
    }

    #[test]
    fn compare_by_start_key_within_table() {
        assert_eq!(
            compare_region_names(b"t1,a,1.x.", b"t1,b,1.x."),
            Ordering::Less
        );
        // Shorter key with same prefix sorts first.
        assert_eq!(
            compare_region_names(b"t1,a,1.x.", b"t1,aa,1.x."),
            Ordering::Less
        );
    }

    #[test]
    fn compare_equal_names() {
        assert_eq!(
            compare_region_names(b"t1,a,1.x.", b"t1,a,1.x."),
            Ordering::Equal
        );
    }
}
