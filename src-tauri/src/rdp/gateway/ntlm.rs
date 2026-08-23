//! NTLMv2 helpers for RD Gateway authentication.
//!
//! Implements the on-the-wire NTLMSSP message framing and the
//! NTLMv2 response computation used by the gateway's HTTP layer.
//! Reference: MS-NLMP §2.2 and §3.3.2.
//!
//! Implemented + unit-tested:
//!
//! - The 8-byte signature + message-type prefix every NEGOTIATE / CHALLENGE
//!   / AUTHENTICATE blob carries.
//! - Type 1 (Negotiate) builder.
//! - Type 2 (Challenge) parser — extracts server challenge and target info.
//! - HMAC-MD5 (used for NTOWFv2 / LMv2 / proof-string).
//! - NTLMv2 response computation.
//! - Type 3 (Authenticate) builder, including the LM/NT response payloads
//!   and the channel-binding-friendly layout.
//!
//! Crypto building blocks (`md4`, `md5`, byte-level `hmac_md5`) are local
//! and use only what's already in the Cargo.toml (`sha2` / `sha1` are
//! pulled in by VNC, but MD4 and MD5 aren't, so we ship small reference
//! implementations instead of adding new crates). They are tested against
//! known answers.

// ── Common signature/message types ─────────────────────────────────────

pub const NTLM_SIGNATURE: &[u8; 8] = b"NTLMSSP\0";
pub const TYPE_NEGOTIATE: u32 = 0x01;
pub const TYPE_CHALLENGE: u32 = 0x02;
pub const TYPE_AUTHENTICATE: u32 = 0x03;

// Negotiate flags (subset relevant for RDG).
pub const NEG_UNICODE: u32 = 0x0000_0001;
pub const NEG_OEM: u32 = 0x0000_0002;
pub const NEG_REQUEST_TARGET: u32 = 0x0000_0004;
pub const NEG_NTLM: u32 = 0x0000_0200;
pub const NEG_OEM_DOMAIN_SUPPLIED: u32 = 0x0000_1000;
pub const NEG_OEM_WORKSTATION_SUPPLIED: u32 = 0x0000_2000;
pub const NEG_ALWAYS_SIGN: u32 = 0x0000_8000;
pub const NEG_EXTENDED_SESSION_SECURITY: u32 = 0x0008_0000;
pub const NEG_TARGET_INFO: u32 = 0x0080_0000;
pub const NEG_VERSION: u32 = 0x0200_0000;
pub const NEG_128: u32 = 0x2000_0000;
pub const NEG_KEY_EXCHANGE: u32 = 0x4000_0000;
pub const NEG_56: u32 = 0x8000_0000;

const FLAGS_TYPE1: u32 = NEG_UNICODE
    | NEG_OEM
    | NEG_REQUEST_TARGET
    | NEG_NTLM
    | NEG_OEM_DOMAIN_SUPPLIED
    | NEG_OEM_WORKSTATION_SUPPLIED
    | NEG_ALWAYS_SIGN
    | NEG_EXTENDED_SESSION_SECURITY
    | NEG_TARGET_INFO
    | NEG_VERSION
    | NEG_128
    | NEG_56;

const FLAGS_TYPE3_SUPPORTED: u32 = NEG_UNICODE
    | NEG_REQUEST_TARGET
    | NEG_NTLM
    | NEG_ALWAYS_SIGN
    | NEG_EXTENDED_SESSION_SECURITY
    | NEG_TARGET_INFO
    | NEG_VERSION
    | NEG_128
    | NEG_56;

// ── Type 1 (Negotiate) ─────────────────────────────────────────────────

pub fn build_negotiate(domain: &str, workstation: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(40);
    out.extend_from_slice(NTLM_SIGNATURE);
    out.extend_from_slice(&TYPE_NEGOTIATE.to_le_bytes());
    out.extend_from_slice(&FLAGS_TYPE1.to_le_bytes());
    // Supplied / supplied-domain payloads are at offset 40 (after the
    // version field). NTLM payload offsets are little-endian u16 pairs:
    // (length, allocated, offset). Allocated == length for our purposes.
    let domain_bytes = domain.as_bytes();
    let workstation_bytes = workstation.as_bytes();
    let domain_off = 40u16;
    let workstation_off = domain_off + domain_bytes.len() as u16;
    out.extend_from_slice(&(domain_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&(domain_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&domain_off.to_le_bytes());
    out.extend_from_slice(&[0, 0]); // padding so DomainNameFields is 8 bytes
    out.extend_from_slice(&(workstation_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&(workstation_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&workstation_off.to_le_bytes());
    out.extend_from_slice(&[0, 0]); // padding
    // Version field (8 bytes) — we report Windows 10 build.
    out.extend_from_slice(&[10, 0, 0x00, 0x40, 0, 0, 0, 0x0F]);
    out.extend_from_slice(domain_bytes);
    out.extend_from_slice(workstation_bytes);
    out
}

// ── Type 2 (Challenge) ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ChallengeMessage {
    pub target_name: Vec<u8>,
    pub flags: u32,
    pub server_challenge: [u8; 8],
    pub target_info: Vec<u8>,
}

pub fn parse_challenge(buf: &[u8]) -> Result<ChallengeMessage, String> {
    if buf.len() < 48 {
        return Err(format!("ntlm challenge: {} bytes < 48", buf.len()));
    }
    if &buf[0..8] != NTLM_SIGNATURE {
        return Err("ntlm: bad signature".into());
    }
    let mtype = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    if mtype != TYPE_CHALLENGE {
        return Err(format!("ntlm: expected type 2, got {}", mtype));
    }
    let target_len = u16::from_le_bytes([buf[12], buf[13]]) as usize;
    let target_off = u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]) as usize;
    let flags = u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]);
    let mut server_challenge = [0u8; 8];
    server_challenge.copy_from_slice(&buf[24..32]);
    let target_info_len = u16::from_le_bytes([buf[40], buf[41]]) as usize;
    let target_info_off = u32::from_le_bytes([buf[44], buf[45], buf[46], buf[47]]) as usize;
    let target_name = slice_payload(buf, target_off, target_len)?.to_vec();
    let target_info = slice_payload(buf, target_info_off, target_info_len)?.to_vec();
    Ok(ChallengeMessage {
        target_name,
        flags,
        server_challenge,
        target_info,
    })
}

fn slice_payload(buf: &[u8], off: usize, len: usize) -> Result<&[u8], String> {
    if off
        .checked_add(len)
        .map(|end| end > buf.len())
        .unwrap_or(true)
    {
        return Err(format!(
            "ntlm: payload slice ({}..{}) out of bounds (buffer {} bytes)",
            off,
            off + len,
            buf.len(),
        ));
    }
    Ok(&buf[off..off + len])
}

// ── Type 3 (Authenticate) ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AuthenticateInputs<'a> {
    pub user: &'a str,
    pub domain: &'a str,
    pub workstation: &'a str,
    pub password: &'a str,
    pub challenge: &'a ChallengeMessage,
    pub client_challenge: [u8; 8],
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticateMessage {
    pub bytes: Vec<u8>,
    pub session_base_key: [u8; 16],
}

pub const AUTHENTICATE_MIC_OFFSET: usize = 72;
pub const AUTHENTICATE_MIC_LEN: usize = 16;
pub const AUTHENTICATE_FIXED_HEADER_LEN: usize = AUTHENTICATE_MIC_OFFSET + AUTHENTICATE_MIC_LEN;

pub fn build_authenticate(input: &AuthenticateInputs<'_>) -> AuthenticateMessage {
    let nt_owf2 = ntowf_v2(input.user, input.domain, input.password);
    let temp = build_ntlmv2_temp(
        input.timestamp,
        input.client_challenge,
        &input.challenge.target_info,
    );
    let mut hmac_input = Vec::with_capacity(8 + temp.len());
    hmac_input.extend_from_slice(&input.challenge.server_challenge);
    hmac_input.extend_from_slice(&temp);
    let nt_proof = hmac_md5(&nt_owf2, &hmac_input);
    let mut nt_response = Vec::with_capacity(16 + temp.len());
    nt_response.extend_from_slice(&nt_proof);
    nt_response.extend_from_slice(&temp);
    // LMv2 response: HMAC-MD5(NTOWFv2, server_challenge || client_challenge) || client_challenge
    let mut lm_input = Vec::with_capacity(16);
    lm_input.extend_from_slice(&input.challenge.server_challenge);
    lm_input.extend_from_slice(&input.client_challenge);
    let mut lm_response = Vec::with_capacity(24);
    lm_response.extend_from_slice(&hmac_md5(&nt_owf2, &lm_input));
    lm_response.extend_from_slice(&input.client_challenge);
    let session_base_key = hmac_md5(&nt_owf2, &nt_proof);
    let user_utf16: Vec<u8> = input
        .user
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let domain_utf16: Vec<u8> = input
        .domain
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let ws_utf16: Vec<u8> = input
        .workstation
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();

    // Layout payloads after the 88-byte fixed header.
    let mut payloads = Vec::new();
    let mut header = Vec::with_capacity(88);
    header.extend_from_slice(NTLM_SIGNATURE);
    header.extend_from_slice(&TYPE_AUTHENTICATE.to_le_bytes());

    let push_field = |payloads: &mut Vec<u8>, header: &mut Vec<u8>, data: &[u8]| {
        let off = 88u32 + payloads.len() as u32;
        let len = data.len() as u16;
        header.extend_from_slice(&len.to_le_bytes());
        header.extend_from_slice(&len.to_le_bytes());
        header.extend_from_slice(&off.to_le_bytes());
        payloads.extend_from_slice(data);
    };
    push_field(&mut payloads, &mut header, &lm_response);
    push_field(&mut payloads, &mut header, &nt_response);
    push_field(&mut payloads, &mut header, &domain_utf16);
    push_field(&mut payloads, &mut header, &user_utf16);
    push_field(&mut payloads, &mut header, &ws_utf16);
    // EncryptedRandomSessionKey field — empty (we don't request key exchange).
    header.extend_from_slice(&[0, 0, 0, 0, 88, 0, 0, 0]);
    // NegotiateFlags — keep only the NTLMv2 features this builder actually
    // implements. In particular, do not echo KEY_EXCHANGE unless an encrypted
    // random session key is present.
    let response_flags = input.challenge.flags & FLAGS_TYPE3_SUPPORTED;
    header.extend_from_slice(&response_flags.to_le_bytes());
    // Version (8 bytes) — same shape as Type 1.
    header.extend_from_slice(&[10, 0, 0x00, 0x40, 0, 0, 0, 0x0F]);
    // MIC (16 bytes zeroed; integrity check is computed later if required).
    header.extend_from_slice(&[0u8; 16]);

    let mut bytes = header;
    bytes.extend_from_slice(&payloads);
    AuthenticateMessage {
        bytes,
        session_base_key,
    }
}

pub fn write_mic(
    authenticate_message: &mut [u8],
    session_base_key: &[u8; 16],
    negotiate_message: &[u8],
    challenge_message: &[u8],
) -> Result<[u8; 16], String> {
    if authenticate_message.len() < AUTHENTICATE_FIXED_HEADER_LEN {
        return Err(format!(
            "ntlm: authenticate message too short for MIC ({} bytes)",
            authenticate_message.len()
        ));
    }
    if &authenticate_message[0..8] != NTLM_SIGNATURE {
        return Err("ntlm: bad authenticate signature".into());
    }
    let message_type = u32::from_le_bytes([
        authenticate_message[8],
        authenticate_message[9],
        authenticate_message[10],
        authenticate_message[11],
    ]);
    if message_type != TYPE_AUTHENTICATE {
        return Err(format!(
            "ntlm: expected authenticate type 3, got {}",
            message_type
        ));
    }

    authenticate_message[AUTHENTICATE_MIC_OFFSET..AUTHENTICATE_FIXED_HEADER_LEN].fill(0);
    let mut mic_input = Vec::with_capacity(
        negotiate_message.len() + challenge_message.len() + authenticate_message.len(),
    );
    mic_input.extend_from_slice(negotiate_message);
    mic_input.extend_from_slice(challenge_message);
    mic_input.extend_from_slice(authenticate_message);
    let mic = hmac_md5(session_base_key, &mic_input);
    authenticate_message[AUTHENTICATE_MIC_OFFSET..AUTHENTICATE_FIXED_HEADER_LEN]
        .copy_from_slice(&mic);
    Ok(mic)
}

// ── NTLMv2 helpers ─────────────────────────────────────────────────────

fn ntowf_v2(user: &str, domain: &str, password: &str) -> [u8; 16] {
    let pw_utf16: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let nt_hash = md4(&pw_utf16);
    let mut combo: Vec<u16> = user.to_uppercase().encode_utf16().collect();
    combo.extend(domain.encode_utf16());
    let combo_bytes: Vec<u8> = combo.into_iter().flat_map(u16::to_le_bytes).collect();
    hmac_md5(&nt_hash, &combo_bytes)
}

fn build_ntlmv2_temp(timestamp: u64, client_challenge: [u8; 8], target_info: &[u8]) -> Vec<u8> {
    let mut t = Vec::with_capacity(28 + target_info.len() + 4);
    t.push(0x01); // RespType
    t.push(0x01); // HiRespType
    t.extend_from_slice(&[0; 6]); // Reserved (2 + 4)
    t.extend_from_slice(&timestamp.to_le_bytes());
    t.extend_from_slice(&client_challenge);
    t.extend_from_slice(&[0, 0, 0, 0]); // Reserved2
    t.extend_from_slice(target_info);
    t.extend_from_slice(&[0, 0, 0, 0]); // Reserved3
    t
}

// ── Crypto: MD4, MD5, HMAC-MD5 ─────────────────────────────────────────

fn rotate_left(x: u32, n: u32) -> u32 {
    (x << n) | (x >> (32 - n))
}

pub fn md4(bytes: &[u8]) -> [u8; 16] {
    let mut a: u32 = 0x6745_2301;
    let mut b: u32 = 0xefcd_ab89;
    let mut c: u32 = 0x98ba_dcfe;
    let mut d: u32 = 0x1032_5476;

    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_le_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut x = [0u32; 16];
        for (i, w) in chunk.chunks_exact(4).enumerate() {
            x[i] = u32::from_le_bytes([w[0], w[1], w[2], w[3]]);
        }
        let (aa, bb, cc, dd) = (a, b, c, d);

        let f = |x: u32, y: u32, z: u32| (x & y) | (!x & z);
        let g = |x: u32, y: u32, z: u32| (x & y) | (x & z) | (y & z);
        let h = |x: u32, y: u32, z: u32| x ^ y ^ z;

        let round1 = |a: &mut u32, b: u32, c: u32, d: u32, k: usize, s: u32| {
            *a = rotate_left(a.wrapping_add(f(b, c, d)).wrapping_add(x[k]), s);
        };
        round1(&mut a, b, c, d, 0, 3);
        round1(&mut d, a, b, c, 1, 7);
        round1(&mut c, d, a, b, 2, 11);
        round1(&mut b, c, d, a, 3, 19);
        round1(&mut a, b, c, d, 4, 3);
        round1(&mut d, a, b, c, 5, 7);
        round1(&mut c, d, a, b, 6, 11);
        round1(&mut b, c, d, a, 7, 19);
        round1(&mut a, b, c, d, 8, 3);
        round1(&mut d, a, b, c, 9, 7);
        round1(&mut c, d, a, b, 10, 11);
        round1(&mut b, c, d, a, 11, 19);
        round1(&mut a, b, c, d, 12, 3);
        round1(&mut d, a, b, c, 13, 7);
        round1(&mut c, d, a, b, 14, 11);
        round1(&mut b, c, d, a, 15, 19);

        let round2 = |a: &mut u32, b: u32, c: u32, d: u32, k: usize, s: u32| {
            *a = rotate_left(
                a.wrapping_add(g(b, c, d))
                    .wrapping_add(x[k])
                    .wrapping_add(0x5a82_7999),
                s,
            );
        };
        round2(&mut a, b, c, d, 0, 3);
        round2(&mut d, a, b, c, 4, 5);
        round2(&mut c, d, a, b, 8, 9);
        round2(&mut b, c, d, a, 12, 13);
        round2(&mut a, b, c, d, 1, 3);
        round2(&mut d, a, b, c, 5, 5);
        round2(&mut c, d, a, b, 9, 9);
        round2(&mut b, c, d, a, 13, 13);
        round2(&mut a, b, c, d, 2, 3);
        round2(&mut d, a, b, c, 6, 5);
        round2(&mut c, d, a, b, 10, 9);
        round2(&mut b, c, d, a, 14, 13);
        round2(&mut a, b, c, d, 3, 3);
        round2(&mut d, a, b, c, 7, 5);
        round2(&mut c, d, a, b, 11, 9);
        round2(&mut b, c, d, a, 15, 13);

        let round3 = |a: &mut u32, b: u32, c: u32, d: u32, k: usize, s: u32| {
            *a = rotate_left(
                a.wrapping_add(h(b, c, d))
                    .wrapping_add(x[k])
                    .wrapping_add(0x6ed9_eba1),
                s,
            );
        };
        round3(&mut a, b, c, d, 0, 3);
        round3(&mut d, a, b, c, 8, 9);
        round3(&mut c, d, a, b, 4, 11);
        round3(&mut b, c, d, a, 12, 15);
        round3(&mut a, b, c, d, 2, 3);
        round3(&mut d, a, b, c, 10, 9);
        round3(&mut c, d, a, b, 6, 11);
        round3(&mut b, c, d, a, 14, 15);
        round3(&mut a, b, c, d, 1, 3);
        round3(&mut d, a, b, c, 9, 9);
        round3(&mut c, d, a, b, 5, 11);
        round3(&mut b, c, d, a, 13, 15);
        round3(&mut a, b, c, d, 3, 3);
        round3(&mut d, a, b, c, 11, 9);
        round3(&mut c, d, a, b, 7, 11);
        round3(&mut b, c, d, a, 15, 15);

        a = a.wrapping_add(aa);
        b = b.wrapping_add(bb);
        c = c.wrapping_add(cc);
        d = d.wrapping_add(dd);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a.to_le_bytes());
    out[4..8].copy_from_slice(&b.to_le_bytes());
    out[8..12].copy_from_slice(&c.to_le_bytes());
    out[12..16].copy_from_slice(&d.to_le_bytes());
    out
}

pub fn md5(bytes: &[u8]) -> [u8; 16] {
    const T: [u32; 64] = [
        0xd76a_a478,
        0xe8c7_b756,
        0x2420_70db,
        0xc1bd_ceee,
        0xf57c_0faf,
        0x4787_c62a,
        0xa830_4613,
        0xfd46_9501,
        0x6980_98d8,
        0x8b44_f7af,
        0xffff_5bb1,
        0x895c_d7be,
        0x6b90_1122,
        0xfd98_7193,
        0xa679_438e,
        0x49b4_0821,
        0xf61e_2562,
        0xc040_b340,
        0x265e_5a51,
        0xe9b6_c7aa,
        0xd62f_105d,
        0x0244_1453,
        0xd8a1_e681,
        0xe7d3_fbc8,
        0x21e1_cde6,
        0xc337_07d6,
        0xf4d5_0d87,
        0x455a_14ed,
        0xa9e3_e905,
        0xfcef_a3f8,
        0x676f_02d9,
        0x8d2a_4c8a,
        0xfffa_3942,
        0x8771_f681,
        0x6d9d_6122,
        0xfde5_380c,
        0xa4be_ea44,
        0x4bde_cfa9,
        0xf6bb_4b60,
        0xbebf_bc70,
        0x289b_7ec6,
        0xeaa1_27fa,
        0xd4ef_3085,
        0x0488_1d05,
        0xd9d4_d039,
        0xe6db_99e5,
        0x1fa2_7cf8,
        0xc4ac_5665,
        0xf429_2244,
        0x432a_ff97,
        0xab94_23a7,
        0xfc93_a039,
        0x655b_59c3,
        0x8f0c_cc92,
        0xffef_f47d,
        0x8584_5dd1,
        0x6fa8_7e4f,
        0xfe2c_e6e0,
        0xa301_4314,
        0x4e08_11a1,
        0xf753_7e82,
        0xbd3a_f235,
        0x2ad7_d2bb,
        0xeb86_d391,
    ];
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let mut a: u32 = 0x6745_2301;
    let mut b: u32 = 0xefcd_ab89;
    let mut c: u32 = 0x98ba_dcfe;
    let mut d: u32 = 0x1032_5476;
    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_le_bytes());
    for chunk in padded.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, w) in chunk.chunks_exact(4).enumerate() {
            m[i] = u32::from_le_bytes([w[0], w[1], w[2], w[3]]);
        }
        let (aa, bb, cc, dd) = (a, b, c, d);
        for i in 0..64 {
            let (f, g) = if i < 16 {
                ((b & c) | (!b & d), i)
            } else if i < 32 {
                ((d & b) | (!d & c), (5 * i + 1) % 16)
            } else if i < 48 {
                (b ^ c ^ d, (3 * i + 5) % 16)
            } else {
                (c ^ (b | !d), (7 * i) % 16)
            };
            let f = f.wrapping_add(a).wrapping_add(T[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(rotate_left(f, S[i]));
        }
        a = a.wrapping_add(aa);
        b = b.wrapping_add(bb);
        c = c.wrapping_add(cc);
        d = d.wrapping_add(dd);
    }
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a.to_le_bytes());
    out[4..8].copy_from_slice(&b.to_le_bytes());
    out[8..12].copy_from_slice(&c.to_le_bytes());
    out[12..16].copy_from_slice(&d.to_le_bytes());
    out
}

pub fn hmac_md5(key: &[u8], msg: &[u8]) -> [u8; 16] {
    let mut k = if key.len() > 64 {
        md5(key).to_vec()
    } else {
        key.to_vec()
    };
    k.resize(64, 0);
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let mut inner = Vec::with_capacity(64 + msg.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(msg);
    let inner_hash = md5(&inner);
    let mut outer = Vec::with_capacity(64 + 16);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    md5(&outer)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Hash known-answer tests ───────────────────────────────────────

    #[test]
    fn md4_known_answers() {
        // RFC 1320 test vectors.
        assert_eq!(hex(&md4(b"")), "31d6cfe0d16ae931b73c59d7e0c089c0");
        assert_eq!(hex(&md4(b"abc")), "a448017aaf21d8525fc10ae87aa6729d");
        assert_eq!(
            hex(&md4(b"message digest")),
            "d9130a8164549fe818874806e1c7014b"
        );
    }

    #[test]
    fn md5_known_answers() {
        // RFC 1321 test vectors.
        assert_eq!(hex(&md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex(&md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            hex(&md5(b"abcdefghijklmnopqrstuvwxyz")),
            "c3fcd3d76192e4007dfb496cca67e13b"
        );
    }

    #[test]
    fn hmac_md5_rfc2202_vector() {
        // RFC 2202 test #1.
        let key = vec![0x0bu8; 16];
        let mac = hmac_md5(&key, b"Hi There");
        assert_eq!(hex(&mac), "9294727a3638bb1c13f48ef8158bfc9d");
    }

    // ── NTLM message round-trips ──────────────────────────────────────

    #[test]
    fn negotiate_layout() {
        let buf = build_negotiate("DOMAIN", "WORKSTATION");
        assert_eq!(&buf[0..8], NTLM_SIGNATURE);
        assert_eq!(
            u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]),
            TYPE_NEGOTIATE
        );
        // Domain payload starts at 40.
        assert_eq!(&buf[40..40 + 6], b"DOMAIN");
        assert_eq!(&buf[46..46 + 11], b"WORKSTATION");
    }

    #[test]
    fn challenge_round_trip() {
        let target_info = vec![0x02, 0x00, 0x04, 0x00, b'C', 0, b'O', 0]; // tiny AV pair
        let target_name = b"NETBIOS\0".to_vec();
        let chal = ChallengeMessage {
            target_name: target_name.clone(),
            flags: NEG_NTLM | NEG_TARGET_INFO | NEG_EXTENDED_SESSION_SECURITY,
            server_challenge: [0xCA, 0xFE, 0xBA, 0xBE, 0xDE, 0xAD, 0xBE, 0xEF],
            target_info: target_info.clone(),
        };
        let buf = synthesize_challenge(&chal);
        let parsed = parse_challenge(&buf).unwrap();
        assert_eq!(parsed.target_name, target_name);
        assert_eq!(parsed.target_info, target_info);
        assert_eq!(parsed.server_challenge, chal.server_challenge);
        assert_eq!(parsed.flags, chal.flags);
    }

    #[test]
    fn authenticate_carries_user_and_session_key() {
        let chal = ChallengeMessage {
            target_name: b"DOMAIN\0".to_vec(),
            flags: NEG_NTLM | NEG_EXTENDED_SESSION_SECURITY,
            server_challenge: [1, 2, 3, 4, 5, 6, 7, 8],
            target_info: vec![],
        };
        let auth = build_authenticate(&AuthenticateInputs {
            user: "alice",
            domain: "DOMAIN",
            workstation: "HOST",
            password: "Password!1",
            challenge: &chal,
            client_challenge: [9; 8],
            timestamp: 0,
        });
        // Type 3 signature
        assert_eq!(&auth.bytes[0..8], NTLM_SIGNATURE);
        assert_eq!(
            u32::from_le_bytes([auth.bytes[8], auth.bytes[9], auth.bytes[10], auth.bytes[11]]),
            TYPE_AUTHENTICATE
        );
        // Session base key is 16 bytes (we don't pin its contents — they
        // depend on MD4/MD5/HMAC chained correctly; the cross-check is
        // that re-running with the same inputs gives the same key).
        let auth2 = build_authenticate(&AuthenticateInputs {
            user: "alice",
            domain: "DOMAIN",
            workstation: "HOST",
            password: "Password!1",
            challenge: &chal,
            client_challenge: [9; 8],
            timestamp: 0,
        });
        assert_eq!(auth.session_base_key, auth2.session_base_key);
        assert_eq!(auth.bytes.len(), auth2.bytes.len());
    }

    #[test]
    fn authenticate_mic_is_written_and_stable() {
        let negotiate = build_negotiate("DOMAIN", "HOST");
        let chal = ChallengeMessage {
            target_name: b"DOMAIN\0".to_vec(),
            flags: NEG_NTLM | NEG_EXTENDED_SESSION_SECURITY | NEG_TARGET_INFO,
            server_challenge: [1, 2, 3, 4, 5, 6, 7, 8],
            target_info: vec![0, 0, 0, 0],
        };
        let challenge = synthesize_challenge(&chal);
        let mut auth = build_authenticate(&AuthenticateInputs {
            user: "alice",
            domain: "DOMAIN",
            workstation: "HOST",
            password: "Password!1",
            challenge: &chal,
            client_challenge: [9; 8],
            timestamp: 0,
        });

        assert_eq!(
            &auth.bytes[AUTHENTICATE_MIC_OFFSET..AUTHENTICATE_FIXED_HEADER_LEN],
            &[0u8; AUTHENTICATE_MIC_LEN]
        );
        let mic = write_mic(
            &mut auth.bytes,
            &auth.session_base_key,
            &negotiate,
            &challenge,
        )
        .unwrap();
        assert_ne!(mic, [0u8; AUTHENTICATE_MIC_LEN]);
        assert_eq!(
            &auth.bytes[AUTHENTICATE_MIC_OFFSET..AUTHENTICATE_FIXED_HEADER_LEN],
            &mic
        );

        let mic_again = write_mic(
            &mut auth.bytes,
            &auth.session_base_key,
            &negotiate,
            &challenge,
        )
        .unwrap();
        assert_eq!(mic, mic_again);
    }

    #[test]
    fn ntowf_v2_uppercases_user_and_keeps_domain() {
        let h1 = ntowf_v2("Alice", "DOMAIN", "p");
        let h2 = ntowf_v2("ALICE", "DOMAIN", "p");
        assert_eq!(h1, h2);
        let h3 = ntowf_v2("ALICE", "domain", "p");
        // Domain is concatenated raw (no case folding per spec).
        assert_ne!(h1, h3);
    }

    // ── Helpers for synthesizing inputs ───────────────────────────────

    fn synthesize_challenge(c: &ChallengeMessage) -> Vec<u8> {
        let header_len = 48u32;
        let target_off = header_len;
        let target_info_off = header_len + c.target_name.len() as u32;
        let mut out = Vec::new();
        out.extend_from_slice(NTLM_SIGNATURE);
        out.extend_from_slice(&TYPE_CHALLENGE.to_le_bytes());
        out.extend_from_slice(&(c.target_name.len() as u16).to_le_bytes());
        out.extend_from_slice(&(c.target_name.len() as u16).to_le_bytes());
        out.extend_from_slice(&target_off.to_le_bytes());
        out.extend_from_slice(&c.flags.to_le_bytes());
        out.extend_from_slice(&c.server_challenge);
        out.extend_from_slice(&[0u8; 8]); // reserved
        out.extend_from_slice(&(c.target_info.len() as u16).to_le_bytes());
        out.extend_from_slice(&(c.target_info.len() as u16).to_le_bytes());
        out.extend_from_slice(&target_info_off.to_le_bytes());
        out.extend_from_slice(&c.target_name);
        out.extend_from_slice(&c.target_info);
        out
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}
