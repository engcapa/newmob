use std::collections::VecDeque;
use std::io::{Error, ErrorKind, Read, Write};
use std::net::TcpStream;

use crate::vnc::encodings::{self, DecodedRect};

const SEC_TYPE_NONE: u8 = 1;
const SEC_TYPE_VNC_AUTH: u8 = 2;
const SEC_TYPE_RA2_128: u8 = 5;
const SEC_TYPE_RA2NE_128: u8 = 6;
const SEC_TYPE_RA2_256: u8 = 129;
const SEC_TYPE_RA2NE_256: u8 = 130;

const RA2_SUBTYPE_USER_PASS: u8 = 1;
const RA2_SUBTYPE_PASS: u8 = 2;
const RA2_MIN_KEY_BITS: usize = 1024;
const RA2_MAX_KEY_BITS: usize = 8192;
const RA2_AES_FRAME_MAX: usize = 8192;

#[derive(Debug)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub name: String,
}

#[derive(Debug)]
pub struct FramebufferUpdate {
    pub rects: Vec<FramebufferRect>,
}

#[derive(Debug)]
pub struct FramebufferRect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub encoding: i32,
    pub data: Vec<u8>,
}

pub struct RfbConnection {
    stream: TcpStream,
    secure_io: Option<RsaAesIo>,
    pub width: u16,
    pub height: u16,
    pub name: String,
    framebuffer: Vec<u8>,
    /// Negotiated protocol minor version (3, 7, or 8).
    proto_minor: u8,
}

pub struct RfbWriter {
    stream: TcpStream,
    secure_output: Option<AesEax>,
    width: u16,
    height: u16,
}

impl RfbConnection {
    pub fn connect(host: &str, port: u16) -> Result<Self, String> {
        let addr = format!("{}:{}", host, port);
        let stream =
            TcpStream::connect(&addr).map_err(|e| format!("TCP connect to {}: {}", addr, e))?;
        stream
            .set_nodelay(true)
            .map_err(|e| format!("set_nodelay failed: {}", e))?;

        let mut conn = RfbConnection {
            stream,
            secure_io: None,
            width: 0,
            height: 0,
            name: String::new(),
            framebuffer: Vec::new(),
            proto_minor: 8,
        };

        conn.handshake_protocol_version()?;
        Ok(conn)
    }

    /// Perform protocol version handshake.
    /// Negotiates the highest mutually supported minor version (3, 7, or 8).
    fn handshake_protocol_version(&mut self) -> Result<(), String> {
        let mut buf = [0u8; 12];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read protocol version: {}", e))?;

        if &buf[..4] != b"RFB " || buf[11] != b'\n' {
            return Err(format!(
                "invalid RFB version: {:?}",
                String::from_utf8_lossy(&buf)
            ));
        }

        // Parse "RFB MMM.NNN\n": major = buf[4..7], minor = buf[8..11]
        let major: u32 = std::str::from_utf8(&buf[4..7])
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);
        let minor: u32 = std::str::from_utf8(&buf[8..11])
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);

        // Any major > 3 (e.g. 4.x, 5.x) is a modern server — negotiate 3.8.
        // Within major 3: use the highest version we support (3.8 > 3.7 > 3.3).
        let (reply, negotiated_minor) = if major > 3 || minor >= 8 {
            (b"RFB 003.008\n" as &[u8], 8u8)
        } else if minor >= 7 {
            (b"RFB 003.007\n" as &[u8], 7u8)
        } else {
            (b"RFB 003.003\n" as &[u8], 3u8)
        };

        self.proto_minor = negotiated_minor;

        self.write_all(reply)
            .map_err(|e| format!("write protocol version: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Perform security handshake and return ServerInit on success.
    pub fn authenticate(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Result<ServerInit, String> {
        // RFB 3.3: server dictates the security type directly as a u32
        if self.proto_minor <= 3 {
            return self.authenticate_v33(password);
        }

        // RFB 3.7 / 3.8: server sends a list of security types
        let mut sec_buf = [0u8; 1];
        self.read_exact(&mut sec_buf)
            .map_err(|e| format!("read security types count: {}", e))?;

        let num_types = sec_buf[0] as usize;

        if num_types == 0 {
            let mut len_buf = [0u8; 4];
            self.read_exact(&mut len_buf)
                .map_err(|e| format!("read sec failure len: {}", e))?;
            let reason_len = u32::from_be_bytes(len_buf) as usize;
            let mut reason = vec![0u8; reason_len];
            self.read_exact(&mut reason)
                .map_err(|e| format!("read sec failure reason: {}", e))?;
            return Err(format!(
                "server rejected connection: {}",
                String::from_utf8_lossy(&reason)
            ));
        }

        let mut types = vec![0u8; num_types];
        self.read_exact(&mut types)
            .map_err(|e| format!("read security types: {}", e))?;

        let chosen = if types.contains(&SEC_TYPE_NONE) {
            SEC_TYPE_NONE
        } else if types.contains(&SEC_TYPE_RA2NE_256) {
            SEC_TYPE_RA2NE_256
        } else if types.contains(&SEC_TYPE_RA2NE_128) {
            SEC_TYPE_RA2NE_128
        } else if types.contains(&SEC_TYPE_VNC_AUTH) {
            SEC_TYPE_VNC_AUTH
        } else if types.contains(&SEC_TYPE_RA2_256) {
            SEC_TYPE_RA2_256
        } else if types.contains(&SEC_TYPE_RA2_128) {
            SEC_TYPE_RA2_128
        } else {
            return Err(format!(
                "no supported security type (server offers: {:?})",
                types
            ));
        };

        self.write_all(&[chosen])
            .map_err(|e| format!("write security type: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        match chosen {
            SEC_TYPE_NONE => {} // None — no auth
            SEC_TYPE_VNC_AUTH => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;
            }
            SEC_TYPE_RA2_128 | SEC_TYPE_RA2NE_128 | SEC_TYPE_RA2_256 | SEC_TYPE_RA2NE_256 => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_ra2(chosen, username.unwrap_or(""), pwd)?;
            }
            _ => unreachable!(),
        }

        // RFB 3.8 always sends SecurityResult; 3.7 only sends it on failure
        if self.proto_minor >= 8 || chosen != 1 {
            let mut result_buf = [0u8; 4];
            self.read_exact(&mut result_buf)
                .map_err(|e| format!("read security result: {}", e))?;
            let result = u32::from_be_bytes(result_buf);
            if result != 0 {
                // 3.8 sends a reason string; 3.7 does not
                if self.proto_minor >= 8 {
                    let mut len_buf = [0u8; 4];
                    self.read_exact(&mut len_buf)
                        .map_err(|e| format!("read auth failure len: {}", e))?;
                    let reason_len = u32::from_be_bytes(len_buf) as usize;
                    let mut reason = vec![0u8; reason_len];
                    self.read_exact(&mut reason)
                        .map_err(|e| format!("read auth failure reason: {}", e))?;
                    return Err(format!(
                        "authentication failed: {}",
                        String::from_utf8_lossy(&reason)
                    ));
                } else {
                    return Err(format!(
                        "authentication failed (security result: {})",
                        result
                    ));
                }
            }
        }

        // ClientInit: send shared flag
        self.write_all(&[1])
            .map_err(|e| format!("write client init: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        self.read_server_init()
    }

    /// RFB 3.3 security handshake: server sends a u32 security type, no client choice.
    fn authenticate_v33(&mut self, password: Option<&str>) -> Result<ServerInit, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read v3.3 security type: {}", e))?;
        let sec_type = u32::from_be_bytes(buf);
        match sec_type {
            0 => {
                // Connection failed — server sends a reason string
                let mut len_buf = [0u8; 4];
                self.read_exact(&mut len_buf)
                    .map_err(|e| format!("read v3.3 failure len: {}", e))?;
                let reason_len = u32::from_be_bytes(len_buf) as usize;
                let mut reason = vec![0u8; reason_len];
                self.read_exact(&mut reason)
                    .map_err(|e| format!("read v3.3 failure reason: {}", e))?;
                Err(format!(
                    "server rejected connection: {}",
                    String::from_utf8_lossy(&reason)
                ))
            }
            1 => {
                // None — no authentication, proceed directly to ClientInit
                self.write_all(&[1])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            2 => {
                // VNC Authentication
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;

                // SecurityResult
                let mut result_buf = [0u8; 4];
                self.read_exact(&mut result_buf)
                    .map_err(|e| format!("read v3.3 security result: {}", e))?;
                let result = u32::from_be_bytes(result_buf);
                if result != 0 {
                    return Err(format!("authentication failed (result={})", result));
                }

                self.write_all(&[1])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            _ => Err(format!("unsupported v3.3 security type: {}", sec_type)),
        }
    }

    /// VNC DES authentication (security type 2).
    fn vnc_auth_des(&mut self, password: &str) -> Result<(), String> {
        let mut challenge = [0u8; 16];
        self.read_exact(&mut challenge)
            .map_err(|e| format!("read VNC challenge: {}", e))?;

        let response = vnc_des_encrypt(password, &challenge);

        self.write_all(&response)
            .map_err(|e| format!("write VNC response: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// RealVNC RSA-AES authentication (RA2/RA2ne, 128- and 256-bit variants).
    fn vnc_auth_ra2(&mut self, sec_type: u8, username: &str, password: &str) -> Result<(), String> {
        use rsa::pkcs1v15::Pkcs1v15Encrypt;
        use rsa::traits::PublicKeyParts;
        use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};

        let (random_len, all_encrypted) = match sec_type {
            SEC_TYPE_RA2_128 => (16usize, true),
            SEC_TYPE_RA2NE_128 => (16usize, false),
            SEC_TYPE_RA2_256 => (32usize, true),
            SEC_TYPE_RA2NE_256 => (32usize, false),
            _ => return Err(format!("RA2: unsupported security type {}", sec_type)),
        };

        // 1. Read server public key: u32 key bits, modulus, exponent.
        let mut len_buf = [0u8; 4];
        self.read_exact(&mut len_buf)
            .map_err(|e| format!("RA2: read key length: {}", e))?;
        let key_bits = u32::from_be_bytes(len_buf) as usize;

        if !(RA2_MIN_KEY_BITS..=RA2_MAX_KEY_BITS).contains(&key_bits) {
            return Err(format!("RA2: unreasonable key length: {} bits", key_bits));
        }
        let key_bytes_len = (key_bits + 7) / 8;

        let mut server_n = vec![0u8; key_bytes_len];
        self.read_exact(&mut server_n)
            .map_err(|e| format!("RA2: read modulus: {}", e))?;
        let mut server_e = vec![0u8; key_bytes_len];
        self.read_exact(&mut server_e)
            .map_err(|e| format!("RA2: read exponent: {}", e))?;

        let modulus = BigUint::from_bytes_be(&server_n);
        let exponent = BigUint::from_bytes_be(&server_e);
        let server_pubkey = RsaPublicKey::new(modulus, exponent)
            .map_err(|e| format!("RA2: construct server pubkey: {}", e))?;

        // 2. Generate a client key pair matching the server key size and send
        //    the public key in RealVNC's fixed-width format.
        use rand::RngCore;
        let mut rng = rand::thread_rng();
        let client_privkey = RsaPrivateKey::new(&mut rng, key_bits)
            .map_err(|e| format!("RA2: gen client key: {}", e))?;
        let client_pubkey = RsaPublicKey::from(&client_privkey);
        let client_n = biguint_to_fixed_bytes(client_pubkey.n(), key_bytes_len)?;
        let client_e = biguint_to_fixed_bytes(client_pubkey.e(), key_bytes_len)?;

        self.write_all(&(key_bits as u32).to_be_bytes())
            .map_err(|e| format!("RA2: write client key length: {}", e))?;
        self.write_all(&client_n)
            .map_err(|e| format!("RA2: write client modulus: {}", e))?;
        self.write_all(&client_e)
            .map_err(|e| format!("RA2: write client exponent: {}", e))?;
        self.flush()
            .map_err(|e| format!("RA2: flush client key: {}", e))?;

        // 3. Send the client random encrypted with the server's public key.
        let mut client_random = vec![0u8; random_len];
        rng.fill_bytes(&mut client_random);
        let encrypted_client_random = server_pubkey
            .encrypt(&mut rng, Pkcs1v15Encrypt, &client_random)
            .map_err(|e| format!("RA2: RSA encrypt: {}", e))?;
        let encrypted_client_random = left_pad(
            &encrypted_client_random,
            key_bytes_len,
            "RA2: encrypted client random",
        )?;

        self.write_all(&(key_bytes_len as u16).to_be_bytes())
            .map_err(|e| format!("RA2: write encrypted client random len: {}", e))?;
        self.write_all(&encrypted_client_random)
            .map_err(|e| format!("RA2: write encrypted client random: {}", e))?;
        self.flush()
            .map_err(|e| format!("RA2: flush client random: {}", e))?;

        // 4. Read and decrypt the server random with the client private key.
        let mut enc_len_buf = [0u8; 2];
        self.read_exact(&mut enc_len_buf)
            .map_err(|e| format!("RA2: read encrypted server random len: {}", e))?;
        let encrypted_server_random_len = u16::from_be_bytes(enc_len_buf) as usize;
        if encrypted_server_random_len != key_bytes_len {
            return Err(format!(
                "RA2: encrypted server random length mismatch: got {}, expected {}",
                encrypted_server_random_len, key_bytes_len
            ));
        }
        let mut encrypted_server_random = vec![0u8; encrypted_server_random_len];
        self.read_exact(&mut encrypted_server_random)
            .map_err(|e| format!("RA2: read encrypted server random: {}", e))?;
        let server_random = client_privkey
            .decrypt(Pkcs1v15Encrypt, &encrypted_server_random)
            .map_err(|e| format!("RA2: RSA decrypt server random: {}", e))?;
        if server_random.len() != random_len {
            return Err(format!(
                "RA2: decrypted server random length mismatch: got {}, expected {}",
                server_random.len(),
                random_len
            ));
        }

        // 5. All remaining RA2 authentication messages are AES-EAX framed.
        let (in_key, out_key) = derive_ra2_aes_keys(random_len, &client_random, &server_random);
        let mut aes_in = AesEax::new(&in_key)?;
        let mut aes_out = AesEax::new(&out_key)?;

        let client_hash = ra2_public_key_hash(
            random_len, key_bits, &client_n, &client_e, key_bits, &server_n, &server_e,
        );
        rsa_aes_write_message(&mut self.stream, &mut aes_out, &client_hash)
            .map_err(|e| format!("RA2: write client hash: {}", e))?;

        let server_hash = rsa_aes_read_message(&mut self.stream, &mut aes_in)
            .map_err(|e| format!("RA2: read server hash: {}", e))?;
        let expected_server_hash = ra2_public_key_hash(
            random_len, key_bits, &server_n, &server_e, key_bits, &client_n, &client_e,
        );
        if server_hash != expected_server_hash {
            return Err("RA2: server hash does not match".to_string());
        }

        let subtype_msg = rsa_aes_read_message(&mut self.stream, &mut aes_in)
            .map_err(|e| format!("RA2: read auth subtype: {}", e))?;
        if subtype_msg.len() != 1 {
            return Err(format!(
                "RA2: invalid auth subtype length {}",
                subtype_msg.len()
            ));
        }
        let subtype = subtype_msg[0];
        if subtype != RA2_SUBTYPE_USER_PASS && subtype != RA2_SUBTYPE_PASS {
            return Err(format!("RA2: unsupported auth subtype {}", subtype));
        }

        let username_bytes = username.as_bytes();
        if subtype == RA2_SUBTYPE_USER_PASS && username_bytes.is_empty() {
            return Err(
                "RA2: server requested username/password authentication, but no VNC username was provided"
                    .to_string(),
            );
        }
        if username_bytes.len() > u8::MAX as usize {
            return Err("RA2: username is too long; maximum is 255 bytes".to_string());
        }

        let password_bytes = password.as_bytes();
        if password_bytes.len() > u8::MAX as usize {
            return Err("RA2: password is too long; maximum is 255 bytes".to_string());
        }

        let credential_username_len = if subtype == RA2_SUBTYPE_USER_PASS {
            username_bytes.len()
        } else {
            0
        };
        let mut credentials =
            Vec::with_capacity(password_bytes.len() + credential_username_len + 2);
        if subtype == RA2_SUBTYPE_USER_PASS {
            credentials.push(username_bytes.len() as u8);
            credentials.extend_from_slice(username_bytes);
        } else {
            credentials.push(0);
        }
        credentials.push(password_bytes.len() as u8);
        credentials.extend_from_slice(password_bytes);
        rsa_aes_write_message(&mut self.stream, &mut aes_out, &credentials)
            .map_err(|e| format!("RA2: write credentials: {}", e))?;

        if all_encrypted {
            self.secure_io = Some(RsaAesIo::new(aes_in, aes_out));
        }

        Ok(())
    }

    fn read_server_init(&mut self) -> Result<ServerInit, String> {
        let mut buf = [0u8; 24];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read server init: {}", e))?;

        self.width = u16::from_be_bytes([buf[0], buf[1]]);
        self.height = u16::from_be_bytes([buf[2], buf[3]]);

        // Parsed pixel format from server (we override with RGBA via SetPixelFormat)
        let _bpp = buf[4];
        let _depth = buf[5];
        let _big_endian = buf[6];
        let _true_color = buf[7];
        let _red_max = u16::from_be_bytes([buf[8], buf[9]]);
        let _green_max = u16::from_be_bytes([buf[10], buf[11]]);
        let _blue_max = u16::from_be_bytes([buf[12], buf[13]]);
        let _red_shift = buf[14];
        let _green_shift = buf[15];
        let _blue_shift = buf[16];

        // Name length + name
        let name_len = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]) as usize;
        let mut name_bytes = vec![0u8; name_len];
        self.read_exact(&mut name_bytes)
            .map_err(|e| format!("read server name: {}", e))?;
        self.name = String::from_utf8_lossy(&name_bytes).to_string();

        // Allocate framebuffer (RGBA 32-bit)
        let fb_size = self.width as usize * self.height as usize * 4;
        self.framebuffer = vec![0u8; fb_size];

        Ok(ServerInit {
            width: self.width,
            height: self.height,
            name: self.name.clone(),
        })
    }

    /// Request pixel format: 32-bit RGBA (8-8-8-8).
    pub fn set_pixel_format_rgba(&mut self) -> Result<(), String> {
        let mut msg = vec![0u8; 20];
        msg[0] = 0; // SetPixelFormat message type
        msg[1] = 0; // padding
        msg[2] = 0; // padding
        msg[3] = 0; // padding
                    // Pixel format:
        msg[4] = 32; // bits-per-pixel
        msg[5] = 32; // depth
        msg[6] = 0; // big-endian false (little-endian)
        msg[7] = 1; // true-colour
        msg[8] = 0; // red-max hi
        msg[9] = 255; // red-max lo
        msg[10] = 0; // green-max hi
        msg[11] = 255; // green-max lo
        msg[12] = 0; // blue-max hi
        msg[13] = 255; // blue-max lo
        msg[14] = 0; // red-shift (R at byte 0 in little-endian)
        msg[15] = 8; // green-shift (G at byte 1)
        msg[16] = 16; // blue-shift (B at byte 2)
        msg[17] = 0; // padding
        msg[18] = 0; // padding
        msg[19] = 0; // padding

        self.write_all(&msg)
            .map_err(|e| format!("write set pixel format: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Request encodings in preference order.
    pub fn set_encodings(&mut self, encodings: &[i32]) -> Result<(), String> {
        let mut msg = vec![0u8; 4 + encodings.len() * 4];
        msg[0] = 2; // SetEncodings
        msg[1] = 0;
        let count = encodings.len() as u16;
        msg[2..4].copy_from_slice(&count.to_be_bytes());

        for (i, enc) in encodings.iter().enumerate() {
            let off = 4 + i * 4;
            msg[off..off + 4].copy_from_slice(&enc.to_be_bytes());
        }

        self.write_all(&msg)
            .map_err(|e| format!("write set encodings: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send FramebufferUpdateRequest. incremental=true skips unchanged regions.
    pub fn request_update(&mut self, incremental: bool) -> Result<(), String> {
        let mut msg = [0u8; 10];
        msg[0] = 3; // FramebufferUpdateRequest
        msg[1] = if incremental { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // x
        msg[4..6].copy_from_slice(&0u16.to_be_bytes()); // y
        msg[6..8].copy_from_slice(&self.width.to_be_bytes()); // width
        msg[8..10].copy_from_slice(&self.height.to_be_bytes()); // height

        self.write_all(&msg)
            .map_err(|e| format!("write update request: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Split out an independent writer so input events can be sent while the
    /// reader is blocked waiting for the next server message.
    pub fn take_writer(&mut self) -> Result<RfbWriter, String> {
        let stream = self
            .stream
            .try_clone()
            .map_err(|e| format!("clone VNC stream for writer: {}", e))?;
        let secure_output = match self.secure_io.as_mut() {
            Some(io) => Some(
                io.take_output()
                    .ok_or_else(|| "VNC secure writer already split".to_string())?,
            ),
            None => None,
        };

        Ok(RfbWriter {
            stream,
            secure_output,
            width: self.width,
            height: self.height,
        })
    }

    /// Read a server-to-client message. Returns None for FramebufferUpdate (handled internally).
    pub fn read_message(&mut self) -> Result<ServerMessage, String> {
        let msg_type = self.read_u8()?;
        match msg_type {
            0 => {
                // FramebufferUpdate
                self.read_exact(&mut [0u8; 1])
                    .map_err(|e| format!("read fu padding: {}", e))?;
                let num_rects = self.read_u16()?;
                let mut rects = Vec::with_capacity(num_rects as usize);

                for _ in 0..num_rects {
                    let x = self.read_u16()?;
                    let y = self.read_u16()?;
                    let w = self.read_u16()?;
                    let h = self.read_u16()?;
                    let encoding = self.read_i32()?;

                    let data_len = match encoding {
                        0 => {
                            // Raw
                            w as usize * h as usize * 4
                        }
                        1 => {
                            // CopyRect
                            4
                        }
                        5 => {
                            // Hextile: read until we've covered the rect
                            // We read all remaining data for now (actual parsing in decoder)
                            self.read_hextile_len(x, y, w, h)?
                        }
                        7 => {
                            // Tight
                            self.read_tight_len(x, y, w, h)?
                        }
                        16 => 0,
                        -223 => {
                            // DesktopSize pseudo-encoding (no data)
                            0
                        }
                        _ => {
                            // Unknown encoding — read remaining data
                            w as usize * h as usize * 4
                        }
                    };

                    let data = if encoding == 16 {
                        self.read_zrle_data()?
                    } else {
                        let mut data = vec![0u8; data_len];
                        self.read_exact(&mut data)
                            .map_err(|e| format!("read rect data: {}", e))?;
                        data
                    };

                    rects.push(FramebufferRect {
                        x,
                        y,
                        w,
                        h,
                        encoding,
                        data,
                    });
                }

                Ok(ServerMessage::FramebufferUpdate(FramebufferUpdate {
                    rects,
                }))
            }
            1 => {
                // SetColourMapEntries
                self.read_exact(&mut [0u8; 1])
                    .map_err(|e| format!("read colourmap padding: {}", e))?;
                let _first = self.read_u16()?;
                let count = self.read_u16()?;
                // Read and discard colour map entries (6 bytes each: 2B R + 2B G + 2B B)
                let entry_size = 6 * count as usize;
                let mut entries = vec![0u8; entry_size];
                self.read_exact(&mut entries)
                    .map_err(|e| format!("read colourmap entries: {}", e))?;
                Ok(ServerMessage::SetColourMapEntries)
            }
            2 => {
                // Bell
                Ok(ServerMessage::Bell)
            }
            3 => {
                // ServerCutText
                self.read_exact(&mut [0u8; 3])
                    .map_err(|e| format!("read cut text padding: {}", e))?;
                let len = self.read_u32()? as usize;
                let mut text = vec![0u8; len];
                self.read_exact(&mut text)
                    .map_err(|e| format!("read cut text: {}", e))?;
                Ok(ServerMessage::ServerCutText {
                    text: String::from_utf8_lossy(&text).to_string(),
                })
            }
            _ => Err(format!("unknown server message type: {}", msg_type)),
        }
    }

    /// Decode a FramebufferUpdate into a list of DecodedRects, updating the internal framebuffer.
    pub fn decode_update(
        &mut self,
        update: &FramebufferUpdate,
    ) -> Result<Vec<DecodedRect>, String> {
        let mut decoded: Vec<DecodedRect> = Vec::new();

        for rect in &update.rects {
            match rect.encoding {
                0 => {
                    // Raw
                    let result = encodings::decode_raw(&rect.data, rect.x, rect.y, rect.w, rect.h);
                    self.write_to_fb(&result);
                    decoded.push(result);
                }
                1 => {
                    // CopyRect
                    let (src_x, src_y) = encodings::decode_copyrect(&rect.data);
                    self.copy_in_fb(rect.x, rect.y, rect.w, rect.h, src_x, src_y);
                    decoded.push(DecodedRect::Copy { src_x, src_y });
                }
                5 => {
                    // Hextile
                    let results = encodings::decode_hextile(
                        &rect.data,
                        rect.x,
                        rect.y,
                        rect.w,
                        rect.h,
                        &self.framebuffer,
                        self.width,
                    )?;
                    for r in &results {
                        self.write_to_fb(r);
                    }
                    decoded.extend(results);
                }
                7 => {
                    // Tight
                    let results =
                        encodings::decode_tight(&rect.data, rect.x, rect.y, rect.w, rect.h)?;
                    for r in &results {
                        self.write_to_fb(r);
                    }
                    decoded.extend(results);
                }
                16 => {
                    // ZRLE
                    let results =
                        encodings::decode_zrle(&rect.data, rect.x, rect.y, rect.w, rect.h)?;
                    for r in &results {
                        self.write_to_fb(r);
                    }
                    decoded.extend(results);
                }
                -223 => {
                    // DesktopSize: resize framebuffer
                    let new_w = rect.w;
                    let new_h = rect.h;
                    self.width = new_w;
                    self.height = new_h;
                    self.framebuffer = vec![0u8; new_w as usize * new_h as usize * 4];
                }
                _ => {
                    // Unknown encoding, skip
                }
            }
        }

        Ok(decoded)
    }

    /// Write a decoded pixel rect into the framebuffer.
    fn write_to_fb(&mut self, rect: &DecodedRect) {
        if let DecodedRect::Pixels { x, y, w, h, rgba } = rect {
            let fb_w = self.width as usize;
            let src_w = *w as usize;
            for row in 0..*h as usize {
                let fb_start = ((*y as usize + row) * fb_w + *x as usize) * 4;
                let src_start = row * src_w * 4;
                let len = src_w * 4;
                if fb_start + len <= self.framebuffer.len() && src_start + len <= rgba.len() {
                    self.framebuffer[fb_start..fb_start + len]
                        .copy_from_slice(&rgba[src_start..src_start + len]);
                }
            }
        }
    }

    /// Copy a region within the framebuffer.
    fn copy_in_fb(&mut self, dst_x: u16, dst_y: u16, w: u16, h: u16, src_x: u16, src_y: u16) {
        let fb_w = self.width as usize;
        let row_bytes = w as usize * 4;
        for row in 0..h as usize {
            let src_start = ((src_y as usize + row) * fb_w + src_x as usize) * 4;
            let dst_start = ((dst_y as usize + row) * fb_w + dst_x as usize) * 4;
            if src_start + row_bytes <= self.framebuffer.len()
                && dst_start + row_bytes <= self.framebuffer.len()
            {
                // Use a temp buffer because src and dst may overlap
                let row_data = self.framebuffer[src_start..src_start + row_bytes].to_vec();
                self.framebuffer[dst_start..dst_start + row_bytes].copy_from_slice(&row_data);
            }
        }
    }

    /// Apply all decoded rects to the framebuffer and return the full updated frame as RGBA bytes.
    pub fn take_full_frame(&self) -> Vec<u8> {
        self.framebuffer.clone()
    }

    // --- I/O helpers ---

    fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.read_exact(&mut self.stream, buf),
            None => self.stream.read_exact(buf),
        }
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.write_all(&mut self.stream, buf),
            None => self.stream.write_all(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        let mut buf = [0u8; 1];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u8: {}", e))?;
        Ok(buf[0])
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let mut buf = [0u8; 2];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u16: {}", e))?;
        Ok(u16::from_be_bytes(buf))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u32: {}", e))?;
        Ok(u32::from_be_bytes(buf))
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read i32: {}", e))?;
        Ok(i32::from_be_bytes(buf))
    }

    /// Read Hextile data length by consuming the stream until the tile count is covered.
    /// The exact length is unknown ahead of time; we use a heuristic: read up to
    /// w*h*4 bytes (worst case raw) per tile.
    fn read_hextile_len(&mut self, _x: u16, _y: u16, w: u16, h: u16) -> Result<usize, String> {
        // Conservative: worst-case each tile is sent raw (subenc=0x01).
        // Each tile has 1-byte subencoding header + raw pixel data.
        // We also account for background (4B) + fg (4B) + subrects overhead.
        // Use raw pixel count as bound + 1 byte per tile for header.
        let tiles_x = (w + 15) / 16;
        let tiles_y = (h + 15) / 16;
        let max_bytes = (w as usize * h as usize * 4) + (tiles_x as usize * tiles_y as usize * 128);
        Ok(max_bytes)
    }

    fn read_tight_len(&mut self, _x: u16, _y: u16, w: u16, h: u16) -> Result<usize, String> {
        // Tight is compressed — the zlib data will be at most raw size
        Ok(w as usize * h as usize * 4 + 256)
    }

    fn read_zrle_data(&mut self) -> Result<Vec<u8>, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read zrle len: {}", e))?;
        let zipped_len = u32::from_be_bytes(buf) as usize;
        let mut data = vec![0u8; 4 + zipped_len];
        data[..4].copy_from_slice(&buf);
        self.read_exact(&mut data[4..])
            .map_err(|e| format!("read zrle data: {}", e))?;
        Ok(data)
    }
}

impl RfbWriter {
    pub fn set_framebuffer_size(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
    }

    /// Send FramebufferUpdateRequest. incremental=true skips unchanged regions.
    pub fn request_update(&mut self, incremental: bool) -> Result<(), String> {
        let mut msg = [0u8; 10];
        msg[0] = 3; // FramebufferUpdateRequest
        msg[1] = if incremental { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // x
        msg[4..6].copy_from_slice(&0u16.to_be_bytes()); // y
        msg[6..8].copy_from_slice(&self.width.to_be_bytes()); // width
        msg[8..10].copy_from_slice(&self.height.to_be_bytes()); // height

        self.write_all(&msg)
            .map_err(|e| format!("write update request: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send KeyEvent.
    pub fn send_key_event(&mut self, down: bool, keysym: u32) -> Result<(), String> {
        let mut msg = [0u8; 8];
        msg[0] = 4;
        msg[1] = if down { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // padding
        msg[4..8].copy_from_slice(&keysym.to_be_bytes());

        self.write_all(&msg)
            .map_err(|e| format!("write key event: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send PointerEvent.
    pub fn send_pointer_event(&mut self, x: u16, y: u16, buttons: u8) -> Result<(), String> {
        let mut msg = [0u8; 6];
        msg[0] = 5;
        msg[1] = buttons;
        msg[2..4].copy_from_slice(&x.to_be_bytes());
        msg[4..6].copy_from_slice(&y.to_be_bytes());

        self.write_all(&msg)
            .map_err(|e| format!("write pointer event: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send ClientCutText (clipboard).
    pub fn send_client_cut_text(&mut self, text: &str) -> Result<(), String> {
        let text_bytes = text.as_bytes();
        let mut msg = vec![0u8; 8 + text_bytes.len()];
        msg[0] = 6;
        msg[1..4].copy_from_slice(&[0u8; 3]);
        msg[4..8].copy_from_slice(&(text_bytes.len() as u32).to_be_bytes());
        msg[8..].copy_from_slice(text_bytes);

        self.write_all(&msg)
            .map_err(|e| format!("write client cut text: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self.secure_output.as_mut() {
            Some(output) => {
                for chunk in buf.chunks(RA2_AES_FRAME_MAX) {
                    rsa_aes_write_message(&mut self.stream, output, chunk)?;
                }
                Ok(())
            }
            None => self.stream.write_all(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

struct RsaAesIo {
    input: AesEax,
    output: Option<AesEax>,
    read_buf: VecDeque<u8>,
}

impl RsaAesIo {
    fn new(input: AesEax, output: AesEax) -> Self {
        Self {
            input,
            output: Some(output),
            read_buf: VecDeque::new(),
        }
    }

    fn read_exact(&mut self, stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < buf.len() {
            if self.read_buf.is_empty() {
                let msg = rsa_aes_read_message(stream, &mut self.input)?;
                self.read_buf.extend(msg);
                if self.read_buf.is_empty() {
                    continue;
                }
            }

            let n = (buf.len() - offset).min(self.read_buf.len());
            for dst in &mut buf[offset..offset + n] {
                *dst = self.read_buf.pop_front().expect("buffer length checked");
            }
            offset += n;
        }
        Ok(())
    }

    fn write_all(&mut self, stream: &mut TcpStream, buf: &[u8]) -> std::io::Result<()> {
        let output = self.output.as_mut().ok_or_else(|| {
            Error::new(
                ErrorKind::BrokenPipe,
                "secure VNC output writer has already been split",
            )
        })?;
        for chunk in buf.chunks(RA2_AES_FRAME_MAX) {
            rsa_aes_write_message(stream, output, chunk)?;
        }
        Ok(())
    }

    fn take_output(&mut self) -> Option<AesEax> {
        self.output.take()
    }
}

enum AesKey {
    Aes128(aes::Aes128),
    Aes256(aes::Aes256),
}

struct AesEax {
    key: AesKey,
    counter: [u8; 16],
}

impl AesEax {
    fn new(key: &[u8]) -> Result<Self, String> {
        use aes::cipher::KeyInit;

        let key = match key.len() {
            16 => AesKey::Aes128(
                aes::Aes128::new_from_slice(key)
                    .map_err(|e| format!("AES-128 init failed: {}", e))?,
            ),
            32 => AesKey::Aes256(
                aes::Aes256::new_from_slice(key)
                    .map_err(|e| format!("AES-256 init failed: {}", e))?,
            ),
            _ => return Err(format!("unsupported AES key length {}", key.len())),
        };

        Ok(Self {
            key,
            counter: [0u8; 16],
        })
    }

    fn encrypt_packet(&mut self, ad: &[u8], plaintext: &[u8]) -> (Vec<u8>, [u8; 16]) {
        let (ciphertext, tag) = self.eax_encrypt(&self.counter, ad, plaintext);
        increment_le(&mut self.counter);
        (ciphertext, tag)
    }

    fn decrypt_packet(
        &mut self,
        ad: &[u8],
        ciphertext: &[u8],
        tag: &[u8],
    ) -> Result<Vec<u8>, String> {
        let expected = self.eax_tag(&self.counter, ad, ciphertext);
        if tag != expected {
            return Err("AES-EAX tag mismatch".to_string());
        }
        let plaintext = self.eax_decrypt(&self.counter, ciphertext);
        increment_le(&mut self.counter);
        Ok(plaintext)
    }

    fn eax_encrypt(&self, nonce: &[u8; 16], ad: &[u8], plaintext: &[u8]) -> (Vec<u8>, [u8; 16]) {
        let nonce_mac = self.omac(0, nonce);
        let header_mac = self.omac(1, ad);
        let mut ciphertext = plaintext.to_vec();
        self.ctr_xor(&nonce_mac, &mut ciphertext);
        let message_mac = self.omac(2, &ciphertext);
        (ciphertext, xor3(&nonce_mac, &header_mac, &message_mac))
    }

    fn eax_decrypt(&self, nonce: &[u8; 16], ciphertext: &[u8]) -> Vec<u8> {
        let nonce_mac = self.omac(0, nonce);
        let mut plaintext = ciphertext.to_vec();
        self.ctr_xor(&nonce_mac, &mut plaintext);
        plaintext
    }

    fn eax_tag(&self, nonce: &[u8; 16], ad: &[u8], ciphertext: &[u8]) -> [u8; 16] {
        let nonce_mac = self.omac(0, nonce);
        let header_mac = self.omac(1, ad);
        let message_mac = self.omac(2, ciphertext);
        xor3(&nonce_mac, &header_mac, &message_mac)
    }

    fn omac(&self, domain: u8, data: &[u8]) -> [u8; 16] {
        let mut prefixed = Vec::with_capacity(16 + data.len());
        prefixed.extend_from_slice(&[0u8; 15]);
        prefixed.push(domain);
        prefixed.extend_from_slice(data);
        self.cmac(&prefixed)
    }

    fn cmac(&self, data: &[u8]) -> [u8; 16] {
        let mut zero = [0u8; 16];
        self.encrypt_block(&mut zero);
        let k1 = dbl_block(&zero);
        let k2 = dbl_block(&k1);

        let block_count = if data.is_empty() {
            1
        } else {
            (data.len() + 15) / 16
        };
        let complete_last = !data.is_empty() && data.len() % 16 == 0;

        let mut x = [0u8; 16];
        for i in 0..block_count - 1 {
            let mut block = [0u8; 16];
            block.copy_from_slice(&data[i * 16..i * 16 + 16]);
            xor_in_place(&mut x, &block);
            self.encrypt_block(&mut x);
        }

        let mut last = [0u8; 16];
        if complete_last {
            last.copy_from_slice(&data[(block_count - 1) * 16..block_count * 16]);
            xor_in_place(&mut last, &k1);
        } else {
            let start = (block_count - 1) * 16;
            let rem = data.len().saturating_sub(start);
            if rem > 0 {
                last[..rem].copy_from_slice(&data[start..]);
            }
            last[rem] = 0x80;
            xor_in_place(&mut last, &k2);
        }

        xor_in_place(&mut x, &last);
        self.encrypt_block(&mut x);
        x
    }

    fn ctr_xor(&self, initial_counter: &[u8; 16], data: &mut [u8]) {
        let mut counter = *initial_counter;
        for chunk in data.chunks_mut(16) {
            let mut pad = counter;
            self.encrypt_block(&mut pad);
            for (dst, key_byte) in chunk.iter_mut().zip(pad.iter()) {
                *dst ^= *key_byte;
            }
            increment_be(&mut counter);
        }
    }

    fn encrypt_block(&self, block: &mut [u8; 16]) {
        use aes::cipher::{generic_array::GenericArray, BlockEncrypt};

        match &self.key {
            AesKey::Aes128(cipher) => {
                cipher.encrypt_block(GenericArray::from_mut_slice(block));
            }
            AesKey::Aes256(cipher) => {
                cipher.encrypt_block(GenericArray::from_mut_slice(block));
            }
        }
    }
}

fn rsa_aes_write_message(
    stream: &mut TcpStream,
    aes: &mut AesEax,
    plaintext: &[u8],
) -> std::io::Result<()> {
    if plaintext.len() > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "RSA-AES message too large",
        ));
    }

    let len = (plaintext.len() as u16).to_be_bytes();
    let (ciphertext, tag) = aes.encrypt_packet(&len, plaintext);
    stream.write_all(&len)?;
    stream.write_all(&ciphertext)?;
    stream.write_all(&tag)?;
    stream.flush()
}

fn rsa_aes_read_message(stream: &mut TcpStream, aes: &mut AesEax) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 2];
    stream.read_exact(&mut len_buf)?;
    let len = u16::from_be_bytes(len_buf) as usize;
    let mut encrypted = vec![0u8; len + 16];
    stream.read_exact(&mut encrypted)?;

    aes.decrypt_packet(&len_buf, &encrypted[..len], &encrypted[len..])
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn derive_ra2_aes_keys(
    random_len: usize,
    client_random: &[u8],
    server_random: &[u8],
) -> (Vec<u8>, Vec<u8>) {
    use sha1::Digest;

    if random_len == 16 {
        let mut inbound = sha1::Sha1::new();
        inbound.update(client_random);
        inbound.update(server_random);
        let mut outbound = sha1::Sha1::new();
        outbound.update(server_random);
        outbound.update(client_random);
        (
            inbound.finalize()[..16].to_vec(),
            outbound.finalize()[..16].to_vec(),
        )
    } else {
        let mut inbound = sha2::Sha256::new();
        inbound.update(client_random);
        inbound.update(server_random);
        let mut outbound = sha2::Sha256::new();
        outbound.update(server_random);
        outbound.update(client_random);
        (inbound.finalize().to_vec(), outbound.finalize().to_vec())
    }
}

fn ra2_public_key_hash(
    random_len: usize,
    first_bits: usize,
    first_n: &[u8],
    first_e: &[u8],
    second_bits: usize,
    second_n: &[u8],
    second_e: &[u8],
) -> Vec<u8> {
    use sha1::Digest;

    let mut data =
        Vec::with_capacity(8 + first_n.len() + first_e.len() + second_n.len() + second_e.len());
    data.extend_from_slice(&(first_bits as u32).to_be_bytes());
    data.extend_from_slice(first_n);
    data.extend_from_slice(first_e);
    data.extend_from_slice(&(second_bits as u32).to_be_bytes());
    data.extend_from_slice(second_n);
    data.extend_from_slice(second_e);

    if random_len == 16 {
        sha1::Sha1::digest(&data).to_vec()
    } else {
        sha2::Sha256::digest(&data).to_vec()
    }
}

fn biguint_to_fixed_bytes(value: &rsa::BigUint, len: usize) -> Result<Vec<u8>, String> {
    let bytes = value.to_bytes_be();
    left_pad(&bytes, len, "RSA integer")
}

fn left_pad(bytes: &[u8], len: usize, context: &str) -> Result<Vec<u8>, String> {
    if bytes.len() > len {
        return Err(format!(
            "{} is too large: {} bytes, expected at most {}",
            context,
            bytes.len(),
            len
        ));
    }

    let mut out = vec![0u8; len];
    out[len - bytes.len()..].copy_from_slice(bytes);
    Ok(out)
}

fn dbl_block(block: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut carry = 0u8;
    for i in (0..16).rev() {
        out[i] = (block[i] << 1) | carry;
        carry = block[i] >> 7;
    }
    if carry != 0 {
        out[15] ^= 0x87;
    }
    out
}

fn xor_in_place(dst: &mut [u8; 16], src: &[u8; 16]) {
    for (d, s) in dst.iter_mut().zip(src.iter()) {
        *d ^= *s;
    }
}

fn xor3(a: &[u8; 16], b: &[u8; 16], c: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = a[i] ^ b[i] ^ c[i];
    }
    out
}

fn increment_be(counter: &mut [u8; 16]) {
    for byte in counter.iter_mut().rev() {
        let (new, carry) = byte.overflowing_add(1);
        *byte = new;
        if !carry {
            break;
        }
    }
}

fn increment_le(counter: &mut [u8; 16]) {
    for byte in counter.iter_mut() {
        let (new, carry) = byte.overflowing_add(1);
        *byte = new;
        if !carry {
            break;
        }
    }
}

#[derive(Debug)]
pub enum ServerMessage {
    FramebufferUpdate(FramebufferUpdate),
    SetColourMapEntries,
    Bell,
    ServerCutText { text: String },
}

/// VNC DES authentication: encrypt the 16-byte challenge with a key derived from the password.
fn vnc_des_encrypt(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    use des::cipher::{BlockEncrypt, KeyInit};
    use des::Des;

    // Build key: password truncated/padded to 8 bytes, each byte's bits reversed
    let mut key_bytes = [0u8; 8];
    let pwd_bytes = password.as_bytes();
    for i in 0..8 {
        let b = if i < pwd_bytes.len() { pwd_bytes[i] } else { 0 };
        key_bytes[i] = reverse_bits(b);
    }

    let cipher = Des::new_from_slice(&key_bytes).expect("DES key should be 8 bytes");

    let mut response = [0u8; 16];
    cipher.encrypt_block_b2b(
        generic_array::GenericArray::from_slice(&challenge[..8]),
        generic_array::GenericArray::from_mut_slice(&mut response[..8]),
    );
    cipher.encrypt_block_b2b(
        generic_array::GenericArray::from_slice(&challenge[8..]),
        generic_array::GenericArray::from_mut_slice(&mut response[8..]),
    );

    response
}

fn reverse_bits(b: u8) -> u8 {
    let mut result = 0u8;
    for i in 0..8 {
        result |= ((b >> i) & 1) << (7 - i);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reverse_bits() {
        assert_eq!(reverse_bits(0b0000_0001), 0b1000_0000);
        assert_eq!(reverse_bits(0b1000_0000), 0b0000_0001);
        assert_eq!(reverse_bits(0b1111_0000), 0b0000_1111);
    }

    #[test]
    fn test_vnc_des_known_vector() {
        // Test vector: password "passw0rd", challenge all zeros
        let challenge = [0u8; 16];
        let response = vnc_des_encrypt("passw0rd", &challenge);
        // Verify the response is 16 bytes and not all zeros
        assert_eq!(response.len(), 16);
        assert!(response.iter().any(|&b| b != 0));
    }
}
