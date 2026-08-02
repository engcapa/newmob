//! Minimal, read-only DNS response parsing for transparent hostname attribution.
//!
//! macOS Redirector exposes the resolved socket address, not the hostname that
//! produced it. Observing ordinary DNS replies lets the relay recover that
//! association without changing DNS servers or performing TLS interception.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

const DNS_HEADER_LEN: usize = 12;
const MAX_NAME_POINTERS: usize = 32;
const MAX_CACHE_TTL: u32 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsIpAnswer {
    pub host: String,
    pub ip: IpAddr,
    pub ttl: Duration,
}

/// Extract A/AAAA answers from a successful DNS response.
///
/// Answers are associated with the echoed question name rather than a CDN's
/// terminal CNAME. That is the name policy rules and the client actually used.
/// Malformed or unrelated packets simply produce no entries.
pub fn extract_ip_answers(packet: &[u8]) -> Vec<DnsIpAnswer> {
    if packet.len() < DNS_HEADER_LEN {
        return Vec::new();
    }
    let flags = u16::from_be_bytes([packet[2], packet[3]]);
    let is_response = flags & 0x8000 != 0;
    let truncated = flags & 0x0200 != 0;
    let response_code = flags & 0x000f;
    if !is_response || truncated || response_code != 0 {
        return Vec::new();
    }

    let question_count = u16::from_be_bytes([packet[4], packet[5]]) as usize;
    let answer_count = u16::from_be_bytes([packet[6], packet[7]]) as usize;
    if question_count == 0 || answer_count == 0 {
        return Vec::new();
    }

    let mut offset = DNS_HEADER_LEN;
    let mut question_host = None;
    for question_index in 0..question_count {
        let Some(name) = read_name(packet, &mut offset) else {
            return Vec::new();
        };
        if offset.checked_add(4).is_none_or(|end| end > packet.len()) {
            return Vec::new();
        }
        offset += 4; // QTYPE + QCLASS
        if question_index == 0 && !name.is_empty() {
            question_host = Some(name);
        }
    }
    let Some(question_host) = question_host else {
        return Vec::new();
    };

    let mut answers = Vec::new();
    for _ in 0..answer_count {
        if read_name(packet, &mut offset).is_none() {
            return answers;
        }
        if offset.checked_add(10).is_none_or(|end| end > packet.len()) {
            return answers;
        }
        let record_type = u16::from_be_bytes([packet[offset], packet[offset + 1]]);
        let class = u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]);
        let ttl = u32::from_be_bytes([
            packet[offset + 4],
            packet[offset + 5],
            packet[offset + 6],
            packet[offset + 7],
        ]);
        let data_len = u16::from_be_bytes([packet[offset + 8], packet[offset + 9]]) as usize;
        offset += 10;
        let Some(data_end) = offset.checked_add(data_len) else {
            return answers;
        };
        if data_end > packet.len() {
            return answers;
        }

        let ip = match (class, record_type, data_len) {
            (1, 1, 4) => Some(IpAddr::V4(Ipv4Addr::new(
                packet[offset],
                packet[offset + 1],
                packet[offset + 2],
                packet[offset + 3],
            ))),
            (1, 28, 16) => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&packet[offset..data_end]);
                Some(IpAddr::V6(Ipv6Addr::from(octets)))
            }
            _ => None,
        };
        if let Some(ip) = ip {
            answers.push(DnsIpAnswer {
                host: question_host.clone(),
                ip,
                ttl: Duration::from_secs(u64::from(ttl.clamp(1, MAX_CACHE_TTL))),
            });
        }
        offset = data_end;
    }
    answers
}

fn read_name(packet: &[u8], offset: &mut usize) -> Option<String> {
    let mut cursor = *offset;
    let mut resume = None;
    let mut labels = Vec::new();
    let mut pointers = 0usize;

    loop {
        let length = *packet.get(cursor)?;
        if length & 0xc0 == 0xc0 {
            let next = *packet.get(cursor + 1)?;
            let pointer = (((length & 0x3f) as usize) << 8) | next as usize;
            if pointer >= packet.len() || pointers >= MAX_NAME_POINTERS {
                return None;
            }
            resume.get_or_insert(cursor + 2);
            cursor = pointer;
            pointers += 1;
            continue;
        }
        if length & 0xc0 != 0 || length > 63 {
            return None;
        }
        cursor += 1;
        if length == 0 {
            *offset = resume.unwrap_or(cursor);
            return Some(labels.join(".").to_ascii_lowercase());
        }
        let end = cursor.checked_add(length as usize)?;
        let label = std::str::from_utf8(packet.get(cursor..end)?).ok()?;
        if label.is_empty() || label.bytes().any(|byte| byte == b'.' || byte == 0) {
            return None;
        }
        labels.push(label);
        cursor = end;
        if labels.iter().map(|label| label.len() + 1).sum::<usize>() > 255 {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response_with_a_and_aaaa() -> Vec<u8> {
        let mut packet = vec![
            0x12, 0x34, 0x81, 0x80, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x03, b'w',
            b'w', b'w', 0x06, b'g', b'o', b'o', b'g', b'l', b'e', 0x03, b'c', b'o', b'm', 0x00,
            0x00, 0x01, 0x00, 0x01,
        ];
        // Compressed owner name, A, IN, TTL 300, 1.2.3.4.
        packet.extend_from_slice(&[
            0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x04, 1, 2, 3, 4,
        ]);
        // Compressed owner name, AAAA, IN, TTL 60, 2001:db8::1.
        packet.extend_from_slice(&[
            0xc0, 0x0c, 0x00, 0x1c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x10, 0x20, 0x01,
            0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
        ]);
        packet
    }

    #[test]
    fn extracts_ipv4_and_ipv6_for_the_question_name() {
        let answers = extract_ip_answers(&response_with_a_and_aaaa());
        assert_eq!(answers.len(), 2);
        assert!(answers.iter().all(|answer| answer.host == "www.google.com"));
        assert_eq!(answers[0].ip, "1.2.3.4".parse::<IpAddr>().unwrap());
        assert_eq!(answers[0].ttl, Duration::from_secs(300));
        assert_eq!(answers[1].ip, "2001:db8::1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn rejects_queries_truncated_responses_and_pointer_loops() {
        let mut query = response_with_a_and_aaaa();
        query[2] &= 0x7f;
        assert!(extract_ip_answers(&query).is_empty());

        let mut truncated = response_with_a_and_aaaa();
        truncated[2] |= 0x02;
        assert!(extract_ip_answers(&truncated).is_empty());

        let mut looped = response_with_a_and_aaaa();
        looped[12] = 0xc0;
        looped[13] = 0x0c;
        assert!(extract_ip_answers(&looped).is_empty());
    }

    #[test]
    fn malformed_packets_fail_closed() {
        for len in 0..DNS_HEADER_LEN {
            assert!(extract_ip_answers(&vec![0; len]).is_empty());
        }
        let mut cut = response_with_a_and_aaaa();
        cut.truncate(cut.len() - 3);
        assert_eq!(extract_ip_answers(&cut).len(), 1);
    }
}
