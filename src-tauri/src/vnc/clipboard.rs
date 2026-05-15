// ExtendedClipboard pseudo-encoding (0xc0a1e5ce) helpers.
//
// Wire format follows the de-facto RFB community extension implemented by
// TigerVNC / TightVNC / RealVNC / TurboVNC. The encoding rides on top of the
// existing ClientCutText (msg type 6) and ServerCutText (msg type 3) frames,
// but signals an extended payload by encoding a *negative* 32-bit length:
//
//     length = -N    (N = absolute size of the body that follows)
//     body[0..4]     = flags (action mask in top byte | format mask in low 16 bits)
//     body[4..]      = action-specific payload
//
// Actions:
//   caps     0x01000000  body = u32-per-supported-format with max byte sizes
//   request  0x02000000  body = empty (request the formats marked in flags)
//   peek     0x04000000  body = empty (peek what formats are available)
//   notify   0x08000000  body = empty (advertise which formats are available)
//   provide  0x10000000  body = concatenated per-format (u32 length + zlib data)
//
// Formats (low 16 bits, set bits indicate supported/requested):
//   text  0x01   plain UTF-8
//   rtf   0x02
//   html  0x04
//   dib   0x08   (we don't support — image clipboard runs through the
//                 screenshot/clipboard PNG path instead)
//   files 0x10   (not used; file transfer uses TightVNC/UltraVNC FT)

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::{Read, Write};

pub const ENCODING_EXTENDED_CLIPBOARD: i32 = 0xC0A1_E5CEu32 as i32;
// Older NewMob builds advertised this incorrect value. Keeping it in the
// SetEncodings list is harmless for conforming servers and lets us keep
// talking to any test servers that copied the old draft value.
pub const ENCODING_EXTENDED_CLIPBOARD_LEGACY: i32 = -1063;

pub const ACTION_CAPS: u32 = 0x01_00_00_00;
pub const ACTION_REQUEST: u32 = 0x02_00_00_00;
pub const ACTION_PEEK: u32 = 0x04_00_00_00;
pub const ACTION_NOTIFY: u32 = 0x08_00_00_00;
pub const ACTION_PROVIDE: u32 = 0x10_00_00_00;
pub const ACTION_MASK: u32 = 0xFF_00_00_00;
pub const SUPPORTED_ACTIONS: u32 =
    ACTION_CAPS | ACTION_REQUEST | ACTION_PEEK | ACTION_NOTIFY | ACTION_PROVIDE;

pub const FORMAT_TEXT: u32 = 0x00_00_00_01;
pub const FORMAT_RTF: u32 = 0x00_00_00_02;
pub const FORMAT_HTML: u32 = 0x00_00_00_04;
pub const FORMAT_MASK: u32 = 0x00_00_FF_FF;

#[derive(Debug, Clone, Default)]
pub struct ClipboardFormats {
    pub text: Option<String>,
    pub html: Option<String>,
    pub rtf: Option<String>,
}

impl ClipboardFormats {
    pub fn format_mask(&self) -> u32 {
        let mut m = 0u32;
        if self.text.is_some() {
            m |= FORMAT_TEXT;
        }
        if self.rtf.is_some() {
            m |= FORMAT_RTF;
        }
        if self.html.is_some() {
            m |= FORMAT_HTML;
        }
        m
    }
}

/// Decode an ExtendedClipboard message body (everything after the negative length).
#[derive(Debug)]
pub enum ExtendedClipboardMsg {
    Caps {
        formats: u32,
        actions: u32,
        sizes: Vec<u32>,
    },
    Request {
        formats: u32,
    },
    Peek,
    Notify {
        formats: u32,
    },
    Provide {
        formats: u32,
        formats_data: ClipboardFormats,
    },
}

/// Try to parse an extended-clipboard body. Returns None if the action byte is unknown
/// (which means we should silently drop the message — not abort the connection).
pub fn parse_extended_body(body: &[u8]) -> Option<ExtendedClipboardMsg> {
    if body.len() < 4 {
        return None;
    }
    let flags = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    let action = flags & ACTION_MASK;
    let formats = flags & FORMAT_MASK;
    let payload = &body[4..];

    if action & ACTION_CAPS != 0 {
        // For each set bit in `formats`, read one u32 (max size).
        let mut sizes = Vec::new();
        let mut cursor = 0;
        let mut bit = 1u32;
        while bit & FORMAT_MASK != 0 {
            if formats & bit != 0 {
                if payload.len() < cursor + 4 {
                    break;
                }
                let size = u32::from_be_bytes([
                    payload[cursor],
                    payload[cursor + 1],
                    payload[cursor + 2],
                    payload[cursor + 3],
                ]);
                sizes.push(size);
                cursor += 4;
            }
            bit <<= 1;
        }
        return Some(ExtendedClipboardMsg::Caps {
            formats,
            actions: action,
            sizes,
        });
    }

    match action {
        ACTION_REQUEST => Some(ExtendedClipboardMsg::Request { formats }),
        ACTION_PEEK => Some(ExtendedClipboardMsg::Peek),
        ACTION_NOTIFY => Some(ExtendedClipboardMsg::Notify { formats }),
        ACTION_PROVIDE => {
            // Body is one zlib stream containing concatenated per-format chunks
            // in low-bit-first order: [u32 length][bytes...] for each format
            // bit set in `formats`.
            let mut decoder = ZlibDecoder::new(payload);
            let mut decoded = Vec::new();
            if decoder.read_to_end(&mut decoded).is_err() {
                return Some(ExtendedClipboardMsg::Provide {
                    formats,
                    formats_data: ClipboardFormats::default(),
                });
            }
            let mut data = ClipboardFormats::default();
            let mut cursor = 0;
            let mut bit = 1u32;
            while bit & FORMAT_MASK != 0 {
                if formats & bit != 0 {
                    if decoded.len() < cursor + 4 {
                        break;
                    }
                    let len = u32::from_be_bytes([
                        decoded[cursor],
                        decoded[cursor + 1],
                        decoded[cursor + 2],
                        decoded[cursor + 3],
                    ]) as usize;
                    cursor += 4;
                    if decoded.len() < cursor + len {
                        break;
                    }
                    let raw = &decoded[cursor..cursor + len];
                    // Trim trailing NUL — the extended text format requires it.
                    let trimmed = raw.strip_suffix(&[0]).unwrap_or(raw);
                    let mut s = String::from_utf8_lossy(trimmed).to_string();
                    if bit == FORMAT_TEXT {
                        s = denormalize_text_newlines(&s);
                    }
                    cursor += len;
                    match bit {
                        FORMAT_TEXT => data.text = Some(s),
                        FORMAT_RTF => data.rtf = Some(s),
                        FORMAT_HTML => data.html = Some(s),
                        _ => {}
                    }
                }
                bit <<= 1;
            }
            Some(ExtendedClipboardMsg::Provide {
                formats,
                formats_data: data,
            })
        }
        _ => None,
    }
}

/// Build the body for a caps message advertising the formats we support.
pub fn build_caps_body(supported_formats: u32, max_size_per_format: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&(SUPPORTED_ACTIONS | supported_formats).to_be_bytes());
    let mut bit = 1u32;
    while bit & FORMAT_MASK != 0 {
        if supported_formats & bit != 0 {
            body.extend_from_slice(&max_size_per_format.to_be_bytes());
        }
        bit <<= 1;
    }
    body
}

/// Build a notify body — advertises which formats the client can deliver.
pub fn build_notify_body(formats: u32) -> Vec<u8> {
    (ACTION_NOTIFY | formats).to_be_bytes().to_vec()
}

/// Build a request body — asks the peer to provide the requested formats.
pub fn build_request_body(formats: u32) -> Vec<u8> {
    (ACTION_REQUEST | formats).to_be_bytes().to_vec()
}

/// Build a provide body delivering the data for the given formats (the bits that are
/// non-empty in `data`).
pub fn build_provide_body(data: &ClipboardFormats) -> Result<Vec<u8>, String> {
    let formats = data.format_mask();
    let mut payload = Vec::new();
    let mut bit = 1u32;
    while bit & FORMAT_MASK != 0 {
        let chunk: Option<&str> = match bit {
            FORMAT_TEXT => data.text.as_deref(),
            FORMAT_RTF => data.rtf.as_deref(),
            FORMAT_HTML => data.html.as_deref(),
            _ => None,
        };
        if let Some(s) = chunk {
            // TigerVNC convention: NUL-terminated UTF-8 + 4-byte big-endian length.
            let text;
            let value = if bit == FORMAT_TEXT {
                text = normalize_text_newlines(s);
                text.as_str()
            } else {
                s
            };
            let mut buf = value.as_bytes().to_vec();
            buf.push(0);
            payload.extend_from_slice(&(buf.len() as u32).to_be_bytes());
            payload.extend_from_slice(&buf);
        }
        bit <<= 1;
    }

    let mut compressed = Vec::new();
    {
        let mut encoder = ZlibEncoder::new(&mut compressed, Compression::default());
        encoder
            .write_all(&payload)
            .map_err(|e| format!("zlib write: {}", e))?;
        encoder
            .finish()
            .map_err(|e| format!("zlib finish: {}", e))?;
    }
    let mut body = Vec::with_capacity(4 + compressed.len());
    body.extend_from_slice(&(ACTION_PROVIDE | formats).to_be_bytes());
    body.extend_from_slice(&compressed);
    Ok(body)
}

pub fn decode_legacy_cut_text(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    bytes.iter().map(|b| char::from(*b)).collect()
}

// RFC 6143 nominally specifies Latin-1 for legacy ClientCutText. Some modern
// VNC servers accept UTF-8 bytes here, while stricter X11-backed servers expose
// the payload as Latin-1/STRING and will mojibake CJK. Keep the bytes intact so
// ASCII and UTF-8-friendly servers work; callers that know the peer lacks
// ExtendedClipboard should avoid sending non-ASCII through this path.
pub fn encode_legacy_cut_text(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

fn normalize_text_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    let _ = chars.next();
                }
                out.push_str("\r\n");
            }
            '\n' => out.push_str("\r\n"),
            _ => out.push(ch),
        }
    }
    out
}

fn denormalize_text_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    let _ = chars.next();
                }
                out.push('\n');
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_roundtrip_advertises_supported_formats() {
        let body = build_caps_body(FORMAT_TEXT | FORMAT_HTML, 4096);
        match parse_extended_body(&body) {
            Some(ExtendedClipboardMsg::Caps {
                formats,
                actions,
                sizes,
            }) => {
                assert_eq!(formats, FORMAT_TEXT | FORMAT_HTML);
                assert_eq!(actions, SUPPORTED_ACTIONS);
                assert_eq!(sizes, vec![4096, 4096]);
            }
            other => panic!("expected Caps, got {:?}", other),
        }
    }

    #[test]
    fn caps_parses_multi_action_server_flags() {
        let mut body = Vec::new();
        body.extend_from_slice(
            &(ACTION_CAPS | ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE | FORMAT_TEXT)
                .to_be_bytes(),
        );
        body.extend_from_slice(&0u32.to_be_bytes());

        match parse_extended_body(&body) {
            Some(ExtendedClipboardMsg::Caps {
                formats,
                actions,
                sizes,
            }) => {
                assert_eq!(formats, FORMAT_TEXT);
                assert_eq!(
                    actions,
                    ACTION_CAPS | ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE
                );
                assert_eq!(sizes, vec![0]);
            }
            other => panic!("expected Caps, got {:?}", other),
        }
    }

    #[test]
    fn provide_roundtrips_html_and_text() {
        let data = ClipboardFormats {
            text: Some("hi\n中文".into()),
            html: Some("<b>hi</b>".into()),
            rtf: None,
        };
        let body = build_provide_body(&data).unwrap();
        match parse_extended_body(&body) {
            Some(ExtendedClipboardMsg::Provide { formats_data, .. }) => {
                assert_eq!(formats_data.text.as_deref(), Some("hi\n中文"));
                assert_eq!(formats_data.html.as_deref(), Some("<b>hi</b>"));
                assert!(formats_data.rtf.is_none());
            }
            other => panic!("expected Provide, got {:?}", other),
        }
    }

    #[test]
    fn notify_decodes_format_mask() {
        let body = build_notify_body(FORMAT_HTML);
        match parse_extended_body(&body) {
            Some(ExtendedClipboardMsg::Notify { formats }) => {
                assert_eq!(formats, FORMAT_HTML);
            }
            other => panic!("expected Notify, got {:?}", other),
        }
    }

    #[test]
    fn unknown_action_returns_none() {
        let mut body = vec![0u8; 4];
        body[0] = 0x80; // unknown high bit
        assert!(parse_extended_body(&body).is_none());
    }

    #[test]
    fn truncated_body_returns_none() {
        assert!(parse_extended_body(&[1, 2]).is_none());
    }

    #[test]
    fn legacy_cut_text_roundtrips_utf8_and_decodes_latin1() {
        // Modern servers send UTF-8 in legacy ClientCutText; we must roundtrip it.
        let bytes = encode_legacy_cut_text("中文");
        assert_eq!(bytes, "中文".as_bytes());
        assert_eq!(decode_legacy_cut_text(&bytes), "中文");
        // Pre-UTF-8 servers may still send Latin-1 — accept it on read.
        assert_eq!(decode_legacy_cut_text(&[0x63, 0x61, 0x66, 0xe9]), "café");
    }
}
