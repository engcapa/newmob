// SecureCRT saved-password decryptor.
//
// SecureCRT session files store remembered passwords inline in each `.ini`.
// Historical `S:"Password"=u...` values use VanDyke's legacy two-pass
// Blowfish-CBC format. SecureCRT 7.3.3+ introduced `S:"Password V2"=02:...`
// and later `03:...`; both require the user's SecureCRT configuration
// passphrase when one was configured. We only decrypt with the empty
// passphrase or a passphrase explicitly entered by the user.

use aes::Aes256;
use blowfish::Blowfish;
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const V1_KEY_1: [u8; 16] = [
    0x24, 0xa6, 0x3d, 0xde, 0x5b, 0xd3, 0xb3, 0x82, 0x9c, 0x7e, 0x06, 0xf4, 0x08, 0x16, 0xaa, 0x07,
];
const V1_KEY_2: [u8; 16] = [
    0x5f, 0xb0, 0x45, 0xa2, 0x94, 0x17, 0xd9, 0x16, 0xc6, 0xc6, 0xa2, 0xff, 0x06, 0x41, 0x82, 0xb7,
];
const BLOWFISH_BLOCK: usize = 8;
const AES_BLOCK: usize = 16;
const V2_SHA256_PREFIX: &str = "02";
const V2_BCRYPT_PREFIX: &str = "03";
const V2_BCRYPT_SALT_LEN: usize = 16;
const V2_BCRYPT_ROUNDS: u32 = 16;

type Aes256CbcDec = cbc::Decryptor<Aes256>;
type BlowfishCbcDec = cbc::Decryptor<Blowfish>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureCrtPasswordError {
    EmptyValue,
    UnsupportedFormat,
    UnsupportedV2Prefix(String),
    MalformedCiphertext(String),
    BadPassphrase,
    MalformedPlaintext(String),
}

impl SecureCrtPasswordError {
    fn needs_passphrase(&self) -> bool {
        matches!(self, SecureCrtPasswordError::BadPassphrase)
    }
}

impl std::fmt::Display for SecureCrtPasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecureCrtPasswordError::EmptyValue => write!(f, "securecrt_password_empty"),
            SecureCrtPasswordError::UnsupportedFormat => {
                write!(f, "securecrt_password_unsupported_format")
            }
            SecureCrtPasswordError::UnsupportedV2Prefix(prefix) => {
                write!(f, "securecrt_password_unsupported_v2_prefix:{prefix}")
            }
            SecureCrtPasswordError::MalformedCiphertext(reason) => {
                write!(f, "securecrt_password_malformed_ciphertext:{reason}")
            }
            SecureCrtPasswordError::BadPassphrase => write!(f, "securecrt_password_bad_passphrase"),
            SecureCrtPasswordError::MalformedPlaintext(reason) => {
                write!(f, "securecrt_password_malformed_plaintext:{reason}")
            }
        }
    }
}

impl std::error::Error for SecureCrtPasswordError {}

pub fn decrypt_password(
    encrypted: &str,
    passphrase: &str,
) -> Result<String, SecureCrtPasswordError> {
    let value = encrypted.trim();
    if value.is_empty() {
        return Err(SecureCrtPasswordError::EmptyValue);
    }

    if value.starts_with('u') || value.starts_with('U') {
        return decrypt_v1_password(&value[1..]);
    }

    let Some((prefix, payload)) = value.split_once(':') else {
        return Err(SecureCrtPasswordError::UnsupportedFormat);
    };
    decrypt_v2_password(prefix, payload, passphrase)
}

fn decrypt_v1_password(hex_payload: &str) -> Result<String, SecureCrtPasswordError> {
    let ciphertext = decode_hex(hex_payload)?;
    let first = blowfish_cbc_decrypt_no_padding(&V1_KEY_1, &ciphertext)?;
    if first.len() < 8 {
        return Err(SecureCrtPasswordError::MalformedCiphertext(
            "legacy inner block too short".into(),
        ));
    }
    let second = blowfish_cbc_decrypt_no_padding(&V1_KEY_2, &first[4..first.len() - 4])?;
    decode_legacy_utf16_password(&second)
}

fn decrypt_v2_password(
    prefix: &str,
    hex_payload: &str,
    passphrase: &str,
) -> Result<String, SecureCrtPasswordError> {
    let payload = decode_hex(hex_payload)?;
    let plaintext = match prefix {
        V2_SHA256_PREFIX => {
            let key = Sha256::digest(passphrase.as_bytes());
            let iv = [0u8; AES_BLOCK];
            aes_256_cbc_decrypt_no_padding(&key, &iv, &payload)?
        }
        V2_BCRYPT_PREFIX => {
            if payload.len() <= V2_BCRYPT_SALT_LEN {
                return Err(SecureCrtPasswordError::MalformedCiphertext(
                    "v2 bcrypt payload is missing ciphertext".into(),
                ));
            }
            let salt = &payload[..V2_BCRYPT_SALT_LEN];
            let ciphertext = &payload[V2_BCRYPT_SALT_LEN..];
            let mut derived = Zeroizing::new([0u8; 48]);
            bcrypt_pbkdf::bcrypt_pbkdf(
                passphrase.as_bytes(),
                salt,
                V2_BCRYPT_ROUNDS,
                derived.as_mut_slice(),
            )
            .map_err(|_| SecureCrtPasswordError::BadPassphrase)?;
            aes_256_cbc_decrypt_no_padding(&derived[..32], &derived[32..], ciphertext)?
        }
        other => return Err(SecureCrtPasswordError::UnsupportedV2Prefix(other.into())),
    };

    decode_v2_plaintext(&plaintext)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, SecureCrtPasswordError> {
    hex::decode(value).map_err(|e| SecureCrtPasswordError::MalformedCiphertext(e.to_string()))
}

fn aes_256_cbc_decrypt_no_padding(
    key: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SecureCrtPasswordError> {
    if ciphertext.is_empty() || ciphertext.len() % AES_BLOCK != 0 {
        return Err(SecureCrtPasswordError::MalformedCiphertext(
            "aes ciphertext length is not a full block".into(),
        ));
    }
    let mut buf = Zeroizing::new(ciphertext.to_vec());
    Aes256CbcDec::new_from_slices(key, iv)
        .map_err(|e| SecureCrtPasswordError::MalformedCiphertext(e.to_string()))?
        .decrypt_padded::<NoPadding>(buf.as_mut_slice())
        .map_err(|_| SecureCrtPasswordError::MalformedCiphertext("aes decrypt failed".into()))?;
    Ok(buf)
}

fn blowfish_cbc_decrypt_no_padding(
    key: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SecureCrtPasswordError> {
    if ciphertext.is_empty() || ciphertext.len() % BLOWFISH_BLOCK != 0 {
        return Err(SecureCrtPasswordError::MalformedCiphertext(
            "blowfish ciphertext length is not a full block".into(),
        ));
    }
    let iv = [0u8; BLOWFISH_BLOCK];
    let mut buf = Zeroizing::new(ciphertext.to_vec());
    BlowfishCbcDec::new_from_slices(key, &iv)
        .map_err(|e| SecureCrtPasswordError::MalformedCiphertext(e.to_string()))?
        .decrypt_padded::<NoPadding>(buf.as_mut_slice())
        .map_err(|_| {
            SecureCrtPasswordError::MalformedCiphertext("blowfish decrypt failed".into())
        })?;
    Ok(buf)
}

fn decode_legacy_utf16_password(bytes: &[u8]) -> Result<String, SecureCrtPasswordError> {
    let terminator = (0..bytes.len().saturating_sub(1))
        .step_by(2)
        .find(|&i| bytes[i] == 0 && bytes[i + 1] == 0)
        .ok_or_else(|| {
            SecureCrtPasswordError::MalformedPlaintext("legacy plaintext has no terminator".into())
        })?;
    let end = terminator + 2;
    let expected_padding = BLOWFISH_BLOCK - (end % BLOWFISH_BLOCK);
    let expected_padding = if expected_padding == 0 {
        BLOWFISH_BLOCK
    } else {
        expected_padding
    };
    if end + expected_padding != bytes.len() {
        return Err(SecureCrtPasswordError::MalformedPlaintext(
            "legacy plaintext padding is invalid".into(),
        ));
    }

    let units: Vec<u16> = bytes[..terminator]
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16(&units)
        .map_err(|e| SecureCrtPasswordError::MalformedPlaintext(e.to_string()))
}

fn decode_v2_plaintext(bytes: &[u8]) -> Result<String, SecureCrtPasswordError> {
    if bytes.len() < 4 + 32 {
        return Err(SecureCrtPasswordError::BadPassphrase);
    }
    let payload_len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let digest_start = 4usize
        .checked_add(payload_len)
        .ok_or(SecureCrtPasswordError::BadPassphrase)?;
    let digest_end = digest_start
        .checked_add(32)
        .ok_or(SecureCrtPasswordError::BadPassphrase)?;
    if digest_end > bytes.len() {
        return Err(SecureCrtPasswordError::BadPassphrase);
    }

    let payload = &bytes[4..digest_start];
    let actual_digest = &bytes[digest_start..digest_end];
    let expected_digest = Sha256::digest(payload);
    if actual_digest != expected_digest.as_slice() {
        return Err(SecureCrtPasswordError::BadPassphrase);
    }

    let padding_len = v2_padding_len(digest_end);
    if digest_end + padding_len != bytes.len() {
        return Err(SecureCrtPasswordError::BadPassphrase);
    }

    String::from_utf8(payload.to_vec())
        .map_err(|e| SecureCrtPasswordError::MalformedPlaintext(e.to_string()))
}

fn v2_padding_len(len_before_padding: usize) -> usize {
    let mut padding_len = AES_BLOCK - (len_before_padding % AES_BLOCK);
    if padding_len < AES_BLOCK / 2 {
        padding_len += AES_BLOCK;
    }
    padding_len
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureCrtPasswordRequest {
    pub session_id: String,
    pub encrypted: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureCrtDecryptArgs {
    pub passwords: Vec<SecureCrtPasswordRequest>,
    pub passphrase: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureCrtPasswordHit {
    pub session_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureCrtPasswordFailure {
    pub session_id: String,
    pub error: String,
    pub needs_passphrase: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureCrtDecryptResponse {
    pub secrets: Vec<SecureCrtPasswordHit>,
    pub failures: Vec<SecureCrtPasswordFailure>,
}

#[tauri::command]
pub async fn securecrt_decrypt_passwords(
    args: SecureCrtDecryptArgs,
) -> Result<SecureCrtDecryptResponse, String> {
    let pw = Zeroizing::new(args.passphrase);
    let mut secrets = Vec::new();
    let mut failures = Vec::new();

    for item in args.passwords {
        match decrypt_password(&item.encrypted, pw.as_str()) {
            Ok(value) => secrets.push(SecureCrtPasswordHit {
                session_id: item.session_id,
                value,
            }),
            Err(error) => failures.push(SecureCrtPasswordFailure {
                session_id: item.session_id,
                needs_passphrase: error.needs_passphrase(),
                error: error.to_string(),
            }),
        }
    }

    Ok(SecureCrtDecryptResponse { secrets, failures })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::{BlockModeEncrypt, KeyIvInit};

    type Aes256CbcEnc = cbc::Encryptor<Aes256>;
    type BlowfishCbcEnc = cbc::Encryptor<Blowfish>;

    fn encrypt_aes_256_no_padding(key: &[u8], iv: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let mut buf = plaintext.to_vec();
        let len = Aes256CbcEnc::new_from_slices(key, iv)
            .expect("valid aes key and iv")
            .encrypt_padded::<NoPadding>(&mut buf, plaintext.len())
            .expect("no padding encrypt")
            .len();
        buf.truncate(len);
        buf
    }

    fn encrypt_blowfish_no_padding(key: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let iv = [0u8; BLOWFISH_BLOCK];
        let mut buf = plaintext.to_vec();
        let len = BlowfishCbcEnc::new_from_slices(key, &iv)
            .expect("valid blowfish key and iv")
            .encrypt_padded::<NoPadding>(&mut buf, plaintext.len())
            .expect("no padding encrypt")
            .len();
        buf.truncate(len);
        buf
    }

    fn v2_plaintext(password: &str) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(password.len() as u32).to_le_bytes());
        out.extend_from_slice(password.as_bytes());
        out.extend_from_slice(Sha256::digest(password.as_bytes()).as_slice());
        out.extend(std::iter::repeat(0xa5).take(v2_padding_len(out.len())));
        out
    }

    fn encrypt_v2_sha256(password: &str, passphrase: &str) -> String {
        let key = Sha256::digest(passphrase.as_bytes());
        let iv = [0u8; AES_BLOCK];
        let ciphertext = encrypt_aes_256_no_padding(&key, &iv, &v2_plaintext(password));
        format!("02:{}", hex::encode(ciphertext))
    }

    fn encrypt_v2_bcrypt(password: &str, passphrase: &str) -> String {
        let salt = [0x4du8; V2_BCRYPT_SALT_LEN];
        let mut derived = [0u8; 48];
        bcrypt_pbkdf::bcrypt_pbkdf(passphrase.as_bytes(), &salt, V2_BCRYPT_ROUNDS, &mut derived)
            .expect("bcrypt pbkdf");
        let ciphertext =
            encrypt_aes_256_no_padding(&derived[..32], &derived[32..], &v2_plaintext(password));
        let mut payload = salt.to_vec();
        payload.extend_from_slice(&ciphertext);
        format!("03:{}", hex::encode(payload))
    }

    fn encrypt_v1(password: &str) -> String {
        let mut utf16 = Vec::new();
        for unit in password.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        utf16.extend_from_slice(&[0, 0]);
        let padding_len = BLOWFISH_BLOCK - (utf16.len() % BLOWFISH_BLOCK);
        let padding_len = if padding_len == 0 {
            BLOWFISH_BLOCK
        } else {
            padding_len
        };
        utf16.extend(std::iter::repeat(0xa7).take(padding_len));

        let inner = encrypt_blowfish_no_padding(&V1_KEY_2, &utf16);
        let mut wrapped = vec![0x11, 0x22, 0x33, 0x44];
        wrapped.extend_from_slice(&inner);
        wrapped.extend_from_slice(&[0x55, 0x66, 0x77, 0x88]);
        let outer = encrypt_blowfish_no_padding(&V1_KEY_1, &wrapped);
        format!("u{}", hex::encode(outer))
    }

    #[test]
    fn decrypts_legacy_password() {
        let encrypted = encrypt_v1("legacy-pass");
        assert_eq!(decrypt_password(&encrypted, "").unwrap(), "legacy-pass");
    }

    #[test]
    fn decrypts_v2_sha256_with_empty_passphrase() {
        let encrypted = encrypt_v2_sha256("secret", "");
        assert_eq!(decrypt_password(&encrypted, "").unwrap(), "secret");
    }

    #[test]
    fn decrypts_v2_sha256_with_user_passphrase() {
        let encrypted = encrypt_v2_sha256("secret", "config phrase");
        assert_eq!(
            decrypt_password(&encrypted, "config phrase").unwrap(),
            "secret"
        );
        assert!(matches!(
            decrypt_password(&encrypted, ""),
            Err(SecureCrtPasswordError::BadPassphrase),
        ));
    }

    #[test]
    fn decrypts_v2_bcrypt_with_user_passphrase() {
        let encrypted = encrypt_v2_bcrypt("secret-03", "phrase");
        assert_eq!(decrypt_password(&encrypted, "phrase").unwrap(), "secret-03");
        assert!(matches!(
            decrypt_password(&encrypted, "wrong"),
            Err(SecureCrtPasswordError::BadPassphrase),
        ));
    }

    #[test]
    fn command_returns_partial_successes() {
        let ok = encrypt_v2_sha256("one", "");
        let needs_passphrase = encrypt_v2_sha256("two", "phrase");
        let response =
            futures::executor::block_on(securecrt_decrypt_passwords(SecureCrtDecryptArgs {
                passphrase: "".into(),
                passwords: vec![
                    SecureCrtPasswordRequest {
                        session_id: "a".into(),
                        encrypted: ok,
                    },
                    SecureCrtPasswordRequest {
                        session_id: "b".into(),
                        encrypted: needs_passphrase,
                    },
                    SecureCrtPasswordRequest {
                        session_id: "c".into(),
                        encrypted: "04:00".into(),
                    },
                ],
            }))
            .unwrap();

        assert_eq!(response.secrets.len(), 1);
        assert_eq!(response.secrets[0].session_id, "a");
        assert_eq!(response.secrets[0].value, "one");
        assert_eq!(response.failures.len(), 2);
        assert!(
            response
                .failures
                .iter()
                .any(|f| f.session_id == "b" && f.needs_passphrase)
        );
        assert!(
            response
                .failures
                .iter()
                .any(|f| f.session_id == "c" && !f.needs_passphrase)
        );
    }
}
