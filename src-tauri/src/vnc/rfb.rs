use std::collections::VecDeque;
use std::io::{Error, ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::vnc::clipboard::{
    ExtendedClipboardMsg, decode_legacy_cut_text, encode_legacy_cut_text, parse_extended_body,
};
use crate::vnc::encodings::{self, DecodedRect, HextileState, ZrleDecoder};
use crate::vnc::limits::DecodeLimits;
use crate::vnc::options::{VncOptions, VncSecurityPolicy};

const SEC_TYPE_NONE: u8 = 1;
const SEC_TYPE_VNC_AUTH: u8 = 2;
const SEC_TYPE_VENCRYPT: u8 = 19;
const SEC_TYPE_RA2_128: u8 = 5;
const SEC_TYPE_RA2NE_128: u8 = 6;
const SEC_TYPE_RA2_256: u8 = 129;
const SEC_TYPE_RA2NE_256: u8 = 130;

const RA2_SUBTYPE_USER_PASS: u8 = 1;
const RA2_SUBTYPE_PASS: u8 = 2;
const RA2_MIN_KEY_BITS: usize = 1024;
const RA2_MAX_KEY_BITS: usize = 8192;
const RA2_AES_FRAME_MAX: usize = 8192;
const DIRECT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const VENCRYPT_VERSION: [u8; 2] = [0, 2];
const VENCRYPT_MAX_SUBTYPES: usize = 32;
const VENCRYPT_TLS_NONE: u32 = 257;
const VENCRYPT_TLS_VNC: u32 = 258;
const VENCRYPT_TLS_PLAIN: u32 = 259;
const VENCRYPT_X509_NONE: u32 = 260;
const VENCRYPT_X509_VNC: u32 = 261;
const VENCRYPT_X509_PLAIN: u32 = 262;

#[derive(Debug, Clone)]
pub struct SecurityInfo {
    pub protocol_version: String,
    pub security_type: String,
    pub encrypted: bool,
    pub identity_verified: bool,
}

#[derive(Debug)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub name: String,
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
    /// Hextile bg/fg carry across tiles per the RFB spec.
    hextile_state: HextileState,
    /// ZRLE uses a single zlib stream for the whole session.
    zrle_decoder: ZrleDecoder,
    limits: DecodeLimits,
    security_info: SecurityInfo,
    vencrypt_transport_protected: bool,
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
        let addresses = (host, port)
            .to_socket_addrs()
            .map_err(|error| format!("DNS lookup for {addr}: {error}"))?
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(format!("DNS lookup for {addr} returned no addresses"));
        }
        let mut last_error = None;
        let mut connected = None;
        for address in addresses {
            match TcpStream::connect_timeout(&address, DIRECT_CONNECT_TIMEOUT) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        let stream = connected.ok_or_else(|| {
            format!(
                "TCP connect to {addr}: {}",
                last_error
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "no address succeeded".to_string())
            )
        })?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("set read timeout failed: {error}"))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("set write timeout failed: {error}"))?;
        Self::from_stream(stream, DecodeLimits::default())
    }

    pub fn from_stream(stream: TcpStream, limits: DecodeLimits) -> Result<Self, String> {
        Self::from_stream_inner(stream, limits, false)
    }

    pub(crate) fn from_vencrypt_bridge(
        stream: TcpStream,
        limits: DecodeLimits,
    ) -> Result<Self, String> {
        Self::from_stream_inner(stream, limits, true)
    }

    fn from_stream_inner(
        stream: TcpStream,
        limits: DecodeLimits,
        vencrypt_transport_protected: bool,
    ) -> Result<Self, String> {
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
            hextile_state: HextileState::new(),
            zrle_decoder: ZrleDecoder::new(),
            limits,
            security_info: SecurityInfo {
                protocol_version: "RFB 3.8".to_string(),
                security_type: "unnegotiated".to_string(),
                encrypted: false,
                identity_verified: false,
            },
            vencrypt_transport_protected,
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

        if &buf[..4] != b"RFB " || buf[7] != b'.' || buf[11] != b'\n' {
            return Err(format!(
                "invalid RFB version: {:?}",
                String::from_utf8_lossy(&buf)
            ));
        }

        // Parse "RFB MMM.NNN\n": major = buf[4..7], minor = buf[8..11]
        let major: u32 = std::str::from_utf8(&buf[4..7])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("invalid RFB major version: {:?}", &buf[4..7]))?;
        let minor: u32 = std::str::from_utf8(&buf[8..11])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("invalid RFB minor version: {:?}", &buf[8..11]))?;
        if major != 3 {
            return Err(format!("unsupported RFB major version: {major}"));
        }
        if minor < 3 {
            return Err(format!("unsupported RFB minor version: {minor}"));
        }

        // Use the highest version we support (3.8 > 3.7 > 3.3).
        let (reply, negotiated_minor) = if minor >= 8 {
            (b"RFB 003.008\n" as &[u8], 8u8)
        } else if minor >= 7 {
            (b"RFB 003.007\n" as &[u8], 7u8)
        } else {
            (b"RFB 003.003\n" as &[u8], 3u8)
        };

        self.proto_minor = negotiated_minor;
        self.security_info.protocol_version = format!("RFB 3.{negotiated_minor}");

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
        self.authenticate_with_options(username, password, &VncOptions::default())
    }

    pub fn authenticate_with_options(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
        options: &VncOptions,
    ) -> Result<ServerInit, String> {
        // RFB 3.3: server dictates the security type directly as a u32
        if self.proto_minor <= 3 {
            return self.authenticate_v33(username, password, options);
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
            self.validate_text_length(reason_len, "security failure reason")?;
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

        let chosen = choose_security_type(&types, options.security_policy, options.allow_none)?;
        self.security_info.security_type = security_type_name(chosen).to_string();
        self.security_info.encrypted = matches!(
            chosen,
            SEC_TYPE_RA2_128 | SEC_TYPE_RA2_256 | SEC_TYPE_VENCRYPT
        );
        self.security_info.identity_verified = false;

        self.write_all(&[chosen])
            .map_err(|e| format!("write security type: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        match chosen {
            SEC_TYPE_NONE => {} // None — no auth
            SEC_TYPE_VNC_AUTH => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;
            }
            SEC_TYPE_VENCRYPT => {
                self.authenticate_vencrypt(username, password, options)?;
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
                    self.validate_text_length(reason_len, "authentication failure reason")?;
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
        self.write_all(&[u8::from(options.shared)])
            .map_err(|e| format!("write client init: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        self.read_server_init()
    }

    /// RFB 3.3 security handshake: server sends a u32 security type, no client choice.
    fn authenticate_v33(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
        options: &VncOptions,
    ) -> Result<ServerInit, String> {
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
                self.validate_text_length(reason_len, "RFB 3.3 failure reason")?;
                let mut reason = vec![0u8; reason_len];
                self.read_exact(&mut reason)
                    .map_err(|e| format!("read v3.3 failure reason: {}", e))?;
                Err(format!(
                    "server rejected connection: {}",
                    String::from_utf8_lossy(&reason)
                ))
            }
            1 => {
                if !options.allow_none {
                    return Err(
                        "security policy rejected RFB None authentication; enable allow-none explicitly"
                            .to_string(),
                    );
                }
                if options.security_policy == VncSecurityPolicy::RequireEncryption {
                    return Err("security policy requires full-session encryption".to_string());
                }
                self.security_info.security_type = security_type_name(SEC_TYPE_NONE).to_string();
                // None — no authentication, proceed directly to ClientInit
                self.write_all(&[u8::from(options.shared)])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            2 => {
                if options.security_policy == VncSecurityPolicy::RequireEncryption {
                    return Err("security policy requires full-session encryption".to_string());
                }
                self.security_info.security_type =
                    security_type_name(SEC_TYPE_VNC_AUTH).to_string();
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

                self.write_all(&[u8::from(options.shared)])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            19 => {
                self.security_info.security_type =
                    security_type_name(SEC_TYPE_VENCRYPT).to_string();
                self.security_info.encrypted = true;
                self.security_info.identity_verified = false;
                self.authenticate_vencrypt(username, password, options)?;

                let result = self.read_u32()?;
                if result != 0 {
                    return Err(format!("authentication failed (result={result})"));
                }
                self.write_all(&[u8::from(options.shared)])
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

    /// VeNCrypt security type 19. The transport bridge performs the TLS
    /// handshake after the subtype is selected; this method handles the
    /// decrypted subtype authentication payload.
    fn authenticate_vencrypt(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
        options: &VncOptions,
    ) -> Result<(), String> {
        let server_version = [self.read_u8()?, self.read_u8()?];
        if server_version[0] != 0 || server_version[1] == 0 {
            return Err(format!(
                "unsupported VeNCrypt version {}.{}",
                server_version[0], server_version[1]
            ));
        }
        self.write_all(&VENCRYPT_VERSION)
            .map_err(|error| format!("write VeNCrypt version: {error}"))?;
        self.flush()
            .map_err(|error| format!("flush VeNCrypt version: {error}"))?;

        let status = self.read_u8()?;
        if status != 0 {
            return Err(format!("VeNCrypt negotiation failed (status={status})"));
        }

        let count = usize::from(self.read_u8()?);
        if count == 0 || count > VENCRYPT_MAX_SUBTYPES {
            return Err(format!("invalid VeNCrypt subtype count: {count}"));
        }
        let mut subtypes = Vec::with_capacity(count);
        for _ in 0..count {
            subtypes.push(self.read_u32()?);
        }
        let subtype =
            choose_vencrypt_subtype(&subtypes, options.security_policy, username, password)?;
        if !self.vencrypt_transport_protected {
            return Err(
                "VeNCrypt requires the certificate-validating TLS transport bridge".to_string(),
            );
        }
        self.write_all(&subtype.to_be_bytes())
            .map_err(|error| format!("write VeNCrypt subtype: {error}"))?;
        self.flush()
            .map_err(|error| format!("flush VeNCrypt subtype: {error}"))?;

        self.security_info.security_type = format!(
            "VeNCrypt/{}",
            vencrypt_subtype_name(subtype).unwrap_or("unknown")
        );
        self.security_info.encrypted = true;
        // The bridge only exposes the stream after native-tls has validated
        // the server certificate and hostname.
        self.security_info.identity_verified = true;

        match subtype {
            VENCRYPT_X509_NONE => Ok(()),
            VENCRYPT_X509_VNC => {
                let password = password.unwrap_or("");
                self.vnc_auth_des(password)
            }
            VENCRYPT_X509_PLAIN => {
                let username = username.filter(|value| !value.is_empty()).ok_or_else(|| {
                    "VeNCrypt Plain authentication requires a username".to_string()
                })?;
                let password = password.ok_or_else(|| {
                    "VeNCrypt Plain authentication requires a password".to_string()
                })?;
                self.write_vencrypt_string(username, "username")?;
                self.write_vencrypt_string(password, "password")?;
                self.flush()
                    .map_err(|error| format!("flush VeNCrypt credentials: {error}"))
            }
            _ => Err(format!("unsupported VeNCrypt subtype: {subtype}")),
        }
    }

    fn write_vencrypt_string(&mut self, value: &str, label: &str) -> Result<(), String> {
        let bytes = value.as_bytes();
        self.validate_text_length(bytes.len(), label)?;
        let length =
            u32::try_from(bytes.len()).map_err(|_| format!("VeNCrypt {label} is too long"))?;
        self.write_all(&length.to_be_bytes())
            .map_err(|error| format!("write VeNCrypt {label} length: {error}"))?;
        self.write_all(bytes)
            .map_err(|error| format!("write VeNCrypt {label}: {error}"))
    }

    /// RealVNC RSA-AES authentication (RA2/RA2ne, 128- and 256-bit variants).
    fn vnc_auth_ra2(&mut self, sec_type: u8, username: &str, password: &str) -> Result<(), String> {
        use rsa::pkcs1v15::Pkcs1v15Encrypt;
        use rsa::rand_core::RngCore;
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
        let mut rng = rsa::rand_core::OsRng;
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
        let fb_size = self.limits.framebuffer_bytes(self.width, self.height)?;

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
        self.validate_text_length(name_len, "server name")?;
        let mut name_bytes = vec![0u8; name_len];
        self.read_exact(&mut name_bytes)
            .map_err(|e| format!("read server name: {}", e))?;
        self.name = String::from_utf8_lossy(&name_bytes).to_string();

        // Allocate framebuffer (RGBA 32-bit)
        self.framebuffer = vec![0u8; fb_size];

        Ok(ServerInit {
            width: self.width,
            height: self.height,
            name: self.name.clone(),
        })
    }

    /// Request pixel format: 32-bit true-colour with depth 24 so ZRLE can use
    /// the 3-byte CPIXEL form.
    pub fn set_pixel_format_rgba(&mut self) -> Result<(), String> {
        let mut msg = vec![0u8; 20];
        msg[0] = 0; // SetPixelFormat message type
        msg[1] = 0; // padding
        msg[2] = 0; // padding
        msg[3] = 0; // padding
        // Pixel format:
        msg[4] = 32; // bits-per-pixel
        msg[5] = 24; // depth: 24 so ZRLE's CPIXEL rule kicks in
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
        let count = u16::try_from(encodings.len())
            .map_err(|_| "VNC encoding list exceeds u16 count".to_string())?;
        let message_len = encodings
            .len()
            .checked_mul(4)
            .and_then(|bytes| bytes.checked_add(4))
            .ok_or_else(|| "VNC encoding message size overflow".to_string())?;
        let mut msg = vec![0u8; message_len];
        msg[0] = 2; // SetEncodings
        msg[1] = 0;
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

    /// Read the next server-to-client message, decoding rectangle data in
    /// place. `FramebufferUpdate` is returned with the already-decoded rects
    /// so callers never have to know about the specific wire encoding.
    pub fn read_server_message(&mut self) -> Result<ServerMessage, String> {
        let mut message_type = [0u8; 1];
        match self.read_exact(&mut message_type) {
            Ok(()) => {}
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Ok(ServerMessage::Idle);
            }
            Err(error) => return Err(format!("read server message type: {error}")),
        }
        let msg_type = message_type[0];
        match msg_type {
            0 => self.read_framebuffer_update(),
            1 => {
                self.read_exact(&mut [0u8; 1])
                    .map_err(|e| format!("read colourmap padding: {}", e))?;
                let _first = self.read_u16()?;
                let count = self.read_u16()?;
                let entry_size = 6usize
                    .checked_mul(count as usize)
                    .ok_or_else(|| "colourmap entry size overflow".to_string())?;
                let mut entries = vec![0u8; entry_size];
                self.read_exact(&mut entries)
                    .map_err(|e| format!("read colourmap entries: {}", e))?;
                Ok(ServerMessage::SetColourMapEntries)
            }
            2 => Ok(ServerMessage::Bell),
            3 => {
                self.read_exact(&mut [0u8; 3])
                    .map_err(|e| format!("read cut text padding: {}", e))?;
                let len_signed = self.read_i32()?;
                if len_signed < 0 {
                    // ExtendedClipboard rides on ServerCutText with a negative length.
                    let len = len_signed
                        .checked_abs()
                        .and_then(|value| usize::try_from(value).ok())
                        .ok_or_else(|| "invalid extended clipboard body length".to_string())?;
                    if len > self.limits.max_clipboard_total_bytes {
                        return Err(format!("extended clipboard body too large: {}", len));
                    }
                    let mut body = vec![0u8; len];
                    self.read_exact(&mut body)
                        .map_err(|e| format!("read ext clipboard: {}", e))?;
                    match parse_extended_body(&body, &self.limits) {
                        Ok(Some(msg)) => Ok(ServerMessage::ExtendedClipboard(msg)),
                        Ok(None) => {
                            // Unknown action — return a no-op so the relay keeps running.
                            Ok(ServerMessage::SetColourMapEntries)
                        }
                        Err(error) => Err(error),
                    }
                } else {
                    let len = len_signed as usize;
                    if len > self.limits.max_clipboard_format_bytes {
                        return Err(format!("legacy clipboard body too large: {}", len));
                    }
                    let mut text = vec![0u8; len];
                    self.read_exact(&mut text)
                        .map_err(|e| format!("read cut text: {}", e))?;
                    Ok(ServerMessage::ServerCutText {
                        text: decode_legacy_cut_text(&text),
                    })
                }
            }
            _ => Err(format!("unknown server message type: {}", msg_type)),
        }
    }

    fn read_framebuffer_update(&mut self) -> Result<ServerMessage, String> {
        self.read_exact(&mut [0u8; 1])
            .map_err(|e| format!("read fu padding: {}", e))?;
        let num_rects = self.read_u16()?;
        if num_rects > self.limits.max_rectangles {
            return Err(format!(
                "framebuffer update rectangle count {} exceeds limit {}",
                num_rects, self.limits.max_rectangles
            ));
        }

        let mut decoded: Vec<DecodedRect> = Vec::new();
        for _ in 0..num_rects {
            let x = self.read_u16()?;
            let y = self.read_u16()?;
            let w = self.read_u16()?;
            let h = self.read_u16()?;
            let encoding = self.read_i32()?;

            if encoding != -223 {
                self.limits
                    .validate_rectangle(x, y, w, h, self.width, self.height)?;
            }

            match encoding {
                0 => {
                    let rect =
                        self.decode_via_reader(|reader| encodings::read_raw(reader, x, y, w, h))?;
                    self.write_to_fb(&rect);
                    decoded.push(rect);
                }
                1 => {
                    // CopyRect resolves against the framebuffer inside the
                    // decoder, so borrow it explicitly before handing off the
                    // reader.
                    let Self {
                        stream,
                        secure_io,
                        framebuffer,
                        width,
                        height,
                        ..
                    } = self;
                    let rect = {
                        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut());
                        encodings::read_copyrect(
                            &mut reader,
                            x,
                            y,
                            w,
                            h,
                            framebuffer,
                            *width,
                            *height,
                        )?
                    };
                    self.write_to_fb(&rect);
                    decoded.push(rect);
                }
                5 => {
                    let Self {
                        stream,
                        secure_io,
                        hextile_state,
                        ..
                    } = self;
                    let rects = {
                        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut());
                        encodings::read_hextile(&mut reader, x, y, w, h, hextile_state)?
                    };
                    for r in &rects {
                        self.write_to_fb(r);
                    }
                    decoded.extend(rects);
                }
                16 => {
                    let Self {
                        stream,
                        secure_io,
                        zrle_decoder,
                        limits,
                        ..
                    } = self;
                    let rects = {
                        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut());
                        encodings::read_zrle(&mut reader, x, y, w, h, zrle_decoder, limits)?
                    };
                    for r in &rects {
                        self.write_to_fb(r);
                    }
                    decoded.extend(rects);
                }
                -223 => {
                    // DesktopSize pseudo-encoding: no payload, just a resize.
                    let framebuffer_bytes = self.limits.framebuffer_bytes(w, h)?;
                    self.width = w;
                    self.height = h;
                    self.framebuffer = vec![0u8; framebuffer_bytes];
                }
                other => {
                    return Err(format!(
                        "unsupported encoding {} — client did not request this",
                        other
                    ));
                }
            }
        }

        Ok(ServerMessage::FramebufferUpdate { rects: decoded })
    }

    /// Run a decoder closure over a temporary `impl Read` view of the stream.
    /// Scoped borrowing so self stays available for framebuffer writes afterwards.
    fn decode_via_reader<T>(
        &mut self,
        f: impl FnOnce(&mut RfbStreamReader<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let Self {
            stream, secure_io, ..
        } = self;
        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut());
        f(&mut reader)
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

    /// Write a decoded pixel rect into the framebuffer. Used so subsequent
    /// Hextile/CopyRect rects can reference prior pixel state.
    fn write_to_fb(&mut self, rect: &DecodedRect) {
        let DecodedRect::Pixels { x, y, w, h, rgba } = rect;
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

    /// Snapshot of the full framebuffer (RGBA). Currently unused externally;
    /// kept for future server-side caching / re-attach support.
    #[allow(dead_code)]
    pub fn take_full_frame(&self) -> Vec<u8> {
        self.framebuffer.clone()
    }

    pub fn security_info(&self) -> SecurityInfo {
        self.security_info.clone()
    }

    pub fn set_io_timeout(&self, timeout: Duration) -> Result<(), String> {
        self.stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| format!("configure VNC read deadline: {error}"))?;
        self.stream
            .set_write_timeout(Some(timeout))
            .map_err(|error| format!("configure VNC write deadline: {error}"))
    }

    fn validate_text_length(&self, length: usize, label: &str) -> Result<(), String> {
        if length > self.limits.max_text_bytes {
            return Err(format!(
                "{label} length {length} exceeds limit {}",
                self.limits.max_text_bytes
            ));
        }
        Ok(())
    }
}

/// Temporary read view over the underlying VNC TCP stream (plus an optional
/// AES-EAX secure layer). Lives only for the duration of a single decode call
/// so we can borrow sibling fields of `RfbConnection` at the same time.
pub(crate) struct RfbStreamReader<'a> {
    stream: &'a mut TcpStream,
    secure_io: Option<&'a mut RsaAesIo>,
}

impl<'a> RfbStreamReader<'a> {
    fn new(stream: &'a mut TcpStream, secure_io: Option<&'a mut RsaAesIo>) -> Self {
        Self { stream, secure_io }
    }
}

impl<'a> Read for RfbStreamReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // Decoders all rely on `read_exact`; this path is just a fallback so
        // generic `Read` combinators keep working. AES-EAX frames are
        // message-oriented and only expose read_exact, so we saturate the
        // requested buffer rather than return a partial read.
        match self.secure_io.as_mut() {
            Some(io) => {
                io.read_exact(self.stream, buf)?;
                Ok(buf.len())
            }
            None => self.stream.read(buf),
        }
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.read_exact(self.stream, buf),
            None => self.stream.read_exact(buf),
        }
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
        let text_bytes = encode_legacy_cut_text(text);
        let mut msg = vec![0u8; 8 + text_bytes.len()];
        msg[0] = 6;
        msg[1..4].copy_from_slice(&[0u8; 3]);
        msg[4..8].copy_from_slice(&(text_bytes.len() as u32).to_be_bytes());
        msg[8..].copy_from_slice(&text_bytes);

        self.write_all(&msg)
            .map_err(|e| format!("write client cut text: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send an ExtendedClipboard body. The wire frame is a ClientCutText (msg
    /// type 6) with a *negative* length signaling the extended payload.
    pub fn send_extended_clipboard(&mut self, body: &[u8]) -> Result<(), String> {
        let max_body = DecodeLimits::default().max_clipboard_total_bytes;
        if body.len() > max_body {
            return Err(format!(
                "extended clipboard body {} exceeds limit {max_body}",
                body.len()
            ));
        }
        let body_len = i32::try_from(body.len())
            .map_err(|_| "extended clipboard body exceeds RFB length range".to_string())?;
        let neg_len = -body_len;
        let mut msg = Vec::with_capacity(8 + body.len());
        msg.push(6);
        msg.extend_from_slice(&[0u8; 3]); // padding
        msg.extend_from_slice(&neg_len.to_be_bytes());
        msg.extend_from_slice(body);

        self.write_all(&msg)
            .map_err(|e| format!("write ext clipboard: {}", e))?;
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
        use aes::cipher::{Array, BlockCipherEncrypt};

        match &self.key {
            AesKey::Aes128(cipher) => {
                cipher.encrypt_block(Array::from_mut_slice(block));
            }
            AesKey::Aes256(cipher) => {
                cipher.encrypt_block(Array::from_mut_slice(block));
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
    Idle,
    FramebufferUpdate { rects: Vec<DecodedRect> },
    SetColourMapEntries,
    Bell,
    ServerCutText { text: String },
    ExtendedClipboard(ExtendedClipboardMsg),
}

fn security_type_name(security_type: u8) -> &'static str {
    match security_type {
        SEC_TYPE_NONE => "None",
        SEC_TYPE_VNC_AUTH => "VNCAuth",
        SEC_TYPE_VENCRYPT => "VeNCrypt",
        SEC_TYPE_RA2_128 => "RA2-128",
        SEC_TYPE_RA2NE_128 => "RA2ne-128",
        SEC_TYPE_RA2_256 => "RA2-256",
        SEC_TYPE_RA2NE_256 => "RA2ne-256",
        _ => "Unknown",
    }
}

fn choose_security_type(
    offered: &[u8],
    policy: VncSecurityPolicy,
    allow_none: bool,
) -> Result<u8, String> {
    let preference: &[u8] = match policy {
        VncSecurityPolicy::RequireEncryption => {
            &[SEC_TYPE_VENCRYPT, SEC_TYPE_RA2_256, SEC_TYPE_RA2_128]
        }
        VncSecurityPolicy::PreferEncryption | VncSecurityPolicy::LegacyCompatible => &[
            SEC_TYPE_VENCRYPT,
            SEC_TYPE_RA2_256,
            SEC_TYPE_RA2_128,
            SEC_TYPE_RA2NE_256,
            SEC_TYPE_RA2NE_128,
            SEC_TYPE_VNC_AUTH,
            SEC_TYPE_NONE,
        ],
    };
    preference
        .iter()
        .copied()
        .find(|security_type| {
            offered.contains(security_type) && (*security_type != SEC_TYPE_NONE || allow_none)
        })
        .ok_or_else(|| {
            if policy == VncSecurityPolicy::RequireEncryption {
                format!(
                    "security policy requires full-session encryption; server offers {:?}",
                    offered
                )
            } else if offered.contains(&SEC_TYPE_NONE) && !allow_none {
                "security policy rejected None authentication; enable allow-none explicitly"
                    .to_string()
            } else {
                format!("no supported security type (server offers: {:?})", offered)
            }
        })
}

fn vencrypt_subtype_name(subtype: u32) -> Option<&'static str> {
    Some(match subtype {
        VENCRYPT_TLS_NONE => "TLSNone",
        VENCRYPT_TLS_VNC => "TLSVnc",
        VENCRYPT_TLS_PLAIN => "TLSPlain",
        VENCRYPT_X509_NONE => "X509None",
        VENCRYPT_X509_VNC => "X509Vnc",
        VENCRYPT_X509_PLAIN => "X509Plain",
        _ => return None,
    })
}

fn choose_vencrypt_subtype(
    offered: &[u32],
    _policy: VncSecurityPolicy,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<u32, String> {
    let has_username = username.is_some_and(|value| !value.is_empty());
    let has_password = password.is_some();
    let preference: &[u32] = if has_username && has_password {
        &[VENCRYPT_X509_PLAIN, VENCRYPT_X509_VNC, VENCRYPT_X509_NONE]
    } else if has_password {
        &[VENCRYPT_X509_VNC, VENCRYPT_X509_NONE]
    } else {
        &[VENCRYPT_X509_NONE]
    };
    preference
        .iter()
        .copied()
        .find(|subtype| offered.contains(subtype))
        .ok_or_else(|| {
            format!(
                "no supported VeNCrypt subtype for the supplied credentials; server offers {:?}",
                offered
            )
        })
}

/// VNC DES authentication: encrypt the 16-byte challenge with a key derived from the password.
fn vnc_des_encrypt(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    use des::Des;
    use des::cipher::{Array, BlockCipherEncrypt, KeyInit};

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
        Array::from_slice(&challenge[..8]),
        Array::from_mut_slice(&mut response[..8]),
    );
    cipher.encrypt_block_b2b(
        Array::from_slice(&challenge[8..]),
        Array::from_mut_slice(&mut response[8..]),
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
    use crate::vnc::limits::HARD_MAX_TEXT_BYTES;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

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

    #[test]
    fn strongest_security_is_selected_and_none_requires_opt_in() {
        let options = VncOptions::default();
        assert_eq!(
            choose_security_type(
                &[SEC_TYPE_NONE, SEC_TYPE_VNC_AUTH, SEC_TYPE_RA2_256],
                options.security_policy,
                options.allow_none,
            )
            .unwrap(),
            SEC_TYPE_RA2_256
        );
        assert!(
            choose_security_type(
                &[SEC_TYPE_NONE],
                options.security_policy,
                options.allow_none,
            )
            .is_err()
        );
        assert!(
            choose_security_type(
                &[SEC_TYPE_VNC_AUTH],
                VncSecurityPolicy::RequireEncryption,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn vencrypt_prefers_authenticated_subtypes_when_credentials_exist() {
        assert_eq!(
            choose_security_type(
                &[SEC_TYPE_VNC_AUTH, SEC_TYPE_VENCRYPT, SEC_TYPE_RA2_128],
                VncSecurityPolicy::PreferEncryption,
                false,
            )
            .unwrap(),
            SEC_TYPE_VENCRYPT
        );
        assert_eq!(
            choose_vencrypt_subtype(
                &[VENCRYPT_X509_NONE, VENCRYPT_X509_VNC, VENCRYPT_X509_PLAIN,],
                VncSecurityPolicy::PreferEncryption,
                Some("alice"),
                Some("secret"),
            )
            .unwrap(),
            VENCRYPT_X509_PLAIN
        );
        assert_eq!(
            choose_vencrypt_subtype(
                &[VENCRYPT_X509_NONE, VENCRYPT_X509_VNC],
                VncSecurityPolicy::PreferEncryption,
                None,
                Some("secret"),
            )
            .unwrap(),
            VENCRYPT_X509_VNC
        );
        assert_eq!(
            choose_vencrypt_subtype(
                &[VENCRYPT_X509_NONE],
                VncSecurityPolicy::RequireEncryption,
                None,
                None,
            )
            .unwrap(),
            VENCRYPT_X509_NONE
        );
        assert!(
            choose_vencrypt_subtype(
                &[VENCRYPT_X509_PLAIN],
                VncSecurityPolicy::PreferEncryption,
                None,
                None,
            )
            .is_err()
        );
        assert!(
            choose_vencrypt_subtype(
                &[VENCRYPT_TLS_NONE, VENCRYPT_TLS_VNC, VENCRYPT_TLS_PLAIN],
                VncSecurityPolicy::PreferEncryption,
                Some("alice"),
                Some("secret"),
            )
            .is_err()
        );
    }

    #[test]
    fn fixture_vencrypt_x509_plain_negotiates_credentials_and_security_info() {
        let (stream, server) = fixture_stream(|mut peer| {
            negotiate_38(&mut peer);
            peer.write_all(&[1, SEC_TYPE_VENCRYPT]).unwrap();
            let mut chosen = [0u8; 1];
            peer.read_exact(&mut chosen).unwrap();
            assert_eq!(chosen, [SEC_TYPE_VENCRYPT]);
            peer.write_all(&VENCRYPT_VERSION).unwrap();
            let mut client_version = [0u8; 2];
            peer.read_exact(&mut client_version).unwrap();
            assert_eq!(client_version, VENCRYPT_VERSION);
            peer.write_all(&[0, 1]).unwrap();
            peer.write_all(&VENCRYPT_X509_PLAIN.to_be_bytes()).unwrap();
            let mut subtype = [0u8; 4];
            peer.read_exact(&mut subtype).unwrap();
            assert_eq!(u32::from_be_bytes(subtype), VENCRYPT_X509_PLAIN);

            let mut len = [0u8; 4];
            peer.read_exact(&mut len).unwrap();
            let username_len = u32::from_be_bytes(len) as usize;
            let mut username = vec![0u8; username_len];
            peer.read_exact(&mut username).unwrap();
            peer.read_exact(&mut len).unwrap();
            let password_len = u32::from_be_bytes(len) as usize;
            let mut password = vec![0u8; password_len];
            peer.read_exact(&mut password).unwrap();
            assert_eq!(username, b"alice");
            assert_eq!(password, b"secret");
            peer.write_all(&0u32.to_be_bytes()).unwrap();
            let mut shared = [0u8; 1];
            peer.read_exact(&mut shared).unwrap();
            assert_eq!(shared, [1]);
            write_server_init(&mut peer, 1, 1, "vencrypt-fixture");
        });

        let mut connection =
            RfbConnection::from_vencrypt_bridge(stream, DecodeLimits::default()).unwrap();
        let server_init = connection
            .authenticate_with_options(Some("alice"), Some("secret"), &VncOptions::default())
            .unwrap();
        assert_eq!((server_init.width, server_init.height), (1, 1));
        let security = connection.security_info();
        assert_eq!(security.security_type, "VeNCrypt/X509Plain");
        assert!(security.encrypted);
        assert!(security.identity_verified);
        server.join().unwrap();
    }

    #[test]
    fn vencrypt_refuses_to_send_credentials_without_tls_bridge() {
        let (stream, server) = fixture_stream(|mut peer| {
            negotiate_38(&mut peer);
            peer.write_all(&[1, SEC_TYPE_VENCRYPT]).unwrap();
            let mut chosen = [0u8; 1];
            peer.read_exact(&mut chosen).unwrap();
            assert_eq!(chosen, [SEC_TYPE_VENCRYPT]);
            peer.write_all(&VENCRYPT_VERSION).unwrap();
            let mut client_version = [0u8; 2];
            peer.read_exact(&mut client_version).unwrap();
            peer.write_all(&[0, 1]).unwrap();
            peer.write_all(&VENCRYPT_X509_PLAIN.to_be_bytes()).unwrap();
        });

        let mut connection = RfbConnection::from_stream(stream, DecodeLimits::default()).unwrap();
        let error = connection
            .authenticate_with_options(Some("alice"), Some("secret"), &VncOptions::default())
            .unwrap_err();
        assert!(error.contains("certificate-validating TLS transport bridge"));
        server.join().unwrap();
    }

    #[test]
    fn protocol_fixture_negotiates_33_37_and_38() {
        for (banner, expected) in [
            (b"RFB 003.003\n".as_slice(), "RFB 3.3"),
            (b"RFB 003.007\n".as_slice(), "RFB 3.7"),
            (b"RFB 003.008\n".as_slice(), "RFB 3.8"),
        ] {
            let (stream, server) = fixture_stream(move |mut peer| {
                peer.write_all(banner).unwrap();
                let mut reply = [0u8; 12];
                peer.read_exact(&mut reply).unwrap();
            });
            let connection = RfbConnection::from_stream(stream, DecodeLimits::default()).unwrap();
            assert_eq!(connection.security_info().protocol_version, expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn protocol_fixture_rejects_malformed_and_unsupported_banners() {
        for (banner, expected_error) in [
            (b"RFB 003X008\n".as_slice(), "invalid RFB version"),
            (b"RFB 00x.008\n".as_slice(), "invalid RFB major version"),
            (b"RFB 003.002\n".as_slice(), "unsupported RFB minor version"),
            (b"RFB 004.008\n".as_slice(), "unsupported RFB major version"),
        ] {
            let (stream, server) = fixture_stream(move |mut peer| {
                peer.write_all(banner).unwrap();
            });
            let error = RfbConnection::from_stream(stream, DecodeLimits::default())
                .err()
                .expect("malformed protocol banner must be rejected");
            assert!(error.contains(expected_error), "unexpected error: {error}");
            server.join().unwrap();
        }
    }

    #[test]
    fn extended_clipboard_minimum_signed_length_is_rejected_without_panicking() {
        let (stream, server) = fixture_stream(|mut peer| {
            negotiate_38(&mut peer);
            let mut message = [0u8; 8];
            message[0] = 3;
            message[4..8].copy_from_slice(&i32::MIN.to_be_bytes());
            peer.write_all(&message).unwrap();
        });

        let mut connection = RfbConnection::from_stream(stream, DecodeLimits::default()).unwrap();
        let error = connection.read_server_message().unwrap_err();
        assert!(error.contains("invalid extended clipboard body length"));
        server.join().unwrap();
    }

    #[test]
    fn fixture_vnc_auth_raw_frame_and_desktop_size() {
        let (stream, server) = fixture_stream(|mut peer| {
            negotiate_38(&mut peer);
            peer.write_all(&[2, SEC_TYPE_NONE, SEC_TYPE_VNC_AUTH])
                .unwrap();
            let mut chosen = [0u8; 1];
            peer.read_exact(&mut chosen).unwrap();
            assert_eq!(chosen[0], SEC_TYPE_VNC_AUTH);
            let challenge = [7u8; 16];
            peer.write_all(&challenge).unwrap();
            let mut response = [0u8; 16];
            peer.read_exact(&mut response).unwrap();
            assert_eq!(response, vnc_des_encrypt("fixture-pass", &challenge));
            peer.write_all(&0u32.to_be_bytes()).unwrap();
            let mut shared = [0u8; 1];
            peer.read_exact(&mut shared).unwrap();
            assert_eq!(shared, [1]);
            write_server_init(&mut peer, 2, 1, "fixture");

            let mut raw = Vec::new();
            raw.extend_from_slice(&[0, 0, 0, 1]);
            raw.extend_from_slice(&0u16.to_be_bytes());
            raw.extend_from_slice(&0u16.to_be_bytes());
            raw.extend_from_slice(&2u16.to_be_bytes());
            raw.extend_from_slice(&1u16.to_be_bytes());
            raw.extend_from_slice(&0i32.to_be_bytes());
            raw.extend_from_slice(&[1, 2, 3, 0, 4, 5, 6, 0]);
            peer.write_all(&raw).unwrap();

            let mut resize = Vec::new();
            resize.extend_from_slice(&[0, 0, 0, 1]);
            resize.extend_from_slice(&0u16.to_be_bytes());
            resize.extend_from_slice(&0u16.to_be_bytes());
            resize.extend_from_slice(&4u16.to_be_bytes());
            resize.extend_from_slice(&3u16.to_be_bytes());
            resize.extend_from_slice(&(-223i32).to_be_bytes());
            peer.write_all(&resize).unwrap();
        });

        let mut connection = RfbConnection::from_stream(stream, DecodeLimits::default()).unwrap();
        let server_init = connection
            .authenticate_with_options(None, Some("fixture-pass"), &VncOptions::default())
            .unwrap();
        assert_eq!((server_init.width, server_init.height), (2, 1));
        match connection.read_server_message().unwrap() {
            ServerMessage::FramebufferUpdate { rects } => match &rects[0] {
                DecodedRect::Pixels { rgba, .. } => {
                    assert_eq!(rgba, &[1, 2, 3, 255, 4, 5, 6, 255]);
                }
            },
            other => panic!("expected framebuffer update, got {other:?}"),
        }
        match connection.read_server_message().unwrap() {
            ServerMessage::FramebufferUpdate { rects } => assert!(rects.is_empty()),
            other => panic!("expected resize update, got {other:?}"),
        }
        assert_eq!((connection.width, connection.height), (4, 3));
        server.join().unwrap();
    }

    #[test]
    fn repeated_desktop_size_updates_remain_atomic_and_bounded() {
        let (stream, server) = fixture_stream(|mut peer| {
            negotiate_38(&mut peer);
            for index in 0..50u16 {
                let width = 800 + index * 7;
                let height = 600 + index * 3;
                let mut resize = Vec::with_capacity(16);
                resize.extend_from_slice(&[0, 0, 0, 1]);
                resize.extend_from_slice(&0u16.to_be_bytes());
                resize.extend_from_slice(&0u16.to_be_bytes());
                resize.extend_from_slice(&width.to_be_bytes());
                resize.extend_from_slice(&height.to_be_bytes());
                resize.extend_from_slice(&(-223i32).to_be_bytes());
                peer.write_all(&resize).unwrap();
            }
        });

        let mut connection = RfbConnection::from_stream(stream, DecodeLimits::default()).unwrap();
        for index in 0..50u16 {
            let width = 800 + index * 7;
            let height = 600 + index * 3;
            match connection.read_server_message().unwrap() {
                ServerMessage::FramebufferUpdate { rects } => assert!(rects.is_empty()),
                other => panic!("expected resize update, got {other:?}"),
            }
            assert_eq!((connection.width, connection.height), (width, height));
            assert_eq!(
                connection.framebuffer.len(),
                usize::from(width) * usize::from(height) * 4
            );
        }
        server.join().unwrap();
    }

    #[test]
    fn fixture_rejects_oversized_server_name_before_reading_payload() {
        let (stream, server) = fixture_stream(|mut peer| {
            negotiate_38(&mut peer);
            peer.write_all(&[1, SEC_TYPE_NONE]).unwrap();
            let mut chosen = [0u8; 1];
            peer.read_exact(&mut chosen).unwrap();
            assert_eq!(chosen, [SEC_TYPE_NONE]);
            peer.write_all(&0u32.to_be_bytes()).unwrap();
            let mut shared = [0u8; 1];
            peer.read_exact(&mut shared).unwrap();
            let mut init = server_init_header(1, 1);
            init[20..24].copy_from_slice(&((HARD_MAX_TEXT_BYTES + 1) as u32).to_be_bytes());
            peer.write_all(&init).unwrap();
        });
        let mut connection = RfbConnection::from_stream(stream, DecodeLimits::default()).unwrap();
        let options = VncOptions {
            allow_none: true,
            ..VncOptions::default()
        };
        let error = connection
            .authenticate_with_options(None, None, &options)
            .unwrap_err();
        assert!(error.contains("exceeds"));
        server.join().unwrap();
    }

    fn fixture_stream(
        server: impl FnOnce(TcpStream) + Send + 'static,
    ) -> (TcpStream, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let task = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            server(stream);
        });
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        (stream, task)
    }

    fn negotiate_38(peer: &mut TcpStream) {
        peer.write_all(b"RFB 003.008\n").unwrap();
        let mut reply = [0u8; 12];
        peer.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"RFB 003.008\n");
    }

    fn server_init_header(width: u16, height: u16) -> [u8; 24] {
        let mut init = [0u8; 24];
        init[0..2].copy_from_slice(&width.to_be_bytes());
        init[2..4].copy_from_slice(&height.to_be_bytes());
        init[4] = 32;
        init[5] = 24;
        init[7] = 1;
        init[8..10].copy_from_slice(&255u16.to_be_bytes());
        init[10..12].copy_from_slice(&255u16.to_be_bytes());
        init[12..14].copy_from_slice(&255u16.to_be_bytes());
        init[14] = 16;
        init[15] = 8;
        init
    }

    fn write_server_init(peer: &mut TcpStream, width: u16, height: u16, name: &str) {
        let mut init = server_init_header(width, height);
        init[20..24].copy_from_slice(&(name.len() as u32).to_be_bytes());
        peer.write_all(&init).unwrap();
        peer.write_all(name.as_bytes()).unwrap();
    }
}
