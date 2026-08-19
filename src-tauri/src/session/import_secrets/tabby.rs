// Tabby Terminal vault decryptor.
//
// Reference: https://github.com/Eugeny/tabby — `tabby-core/src/services/vault.service.ts`.
// When the user enables a master password, Tabby writes the vault as a YAML
// node in `config.yaml`:
//
//   vault:
//     version: 1
//     contents: <base64>           # AES-256-CBC ciphertext, PKCS#7 padding
//     keySalt: <hex of 8 bytes>    # PBKDF2 salt
//     iv: <hex of 16 bytes>        # CBC IV
//
// Key derivation: PBKDF2-HMAC-SHA512, 100_000 iterations, 32-byte key.
// The plaintext is JSON of shape:
//
//   { config?: {...},
//     secrets: [
//       { type: "ssh:password",       key: { user, host, port }, value: "..." },
//       { type: "ssh:key-passphrase", key: { hash: "..." },      value: "..." },
//       ...
//     ]
//   }
//
// We do not enable Tabby's "encrypt config" mode — only the secrets — so
// `config` is ignored.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_yml::Value as YamlValue;
use zeroize::Zeroizing;

use super::crypto::{SecretCryptoError, aes_256_cbc_decrypt_pkcs7, pbkdf2_sha512};

const TABBY_PBKDF2_ITERATIONS: u32 = 100_000;
const TABBY_KEY_LEN: usize = 32;
const TABBY_IV_LEN: usize = 16;
const TABBY_VAULT_VERSION: u64 = 1;

#[derive(Debug)]
pub enum TabbyVaultError {
    MissingVaultBlock,
    UnsupportedVersion(u64),
    MalformedHeader(String),
    BadPassword,
    MalformedPlaintext(String),
}

impl std::fmt::Display for TabbyVaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TabbyVaultError::MissingVaultBlock => write!(f, "tabby_vault_missing"),
            TabbyVaultError::UnsupportedVersion(v) => {
                write!(f, "tabby_vault_unsupported_version:{v}")
            }
            TabbyVaultError::MalformedHeader(reason) => {
                write!(f, "tabby_vault_malformed_header:{reason}")
            }
            TabbyVaultError::BadPassword => write!(f, "tabby_vault_bad_password"),
            TabbyVaultError::MalformedPlaintext(reason) => {
                write!(f, "tabby_vault_malformed_plaintext:{reason}")
            }
        }
    }
}

impl std::error::Error for TabbyVaultError {}

/// Public shape returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TabbySecret {
    #[serde(rename = "password")]
    Password {
        host: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        value: String,
    },
    #[serde(rename = "key-passphrase")]
    KeyPassphrase { id: String, value: String },
}

/// Decrypt `vault:` block in a Tabby `config.yaml` and extract the
/// secrets we know how to map onto Taomni sessions.
pub fn decrypt_vault_yaml(yaml: &str, password: &str) -> Result<Vec<TabbySecret>, TabbyVaultError> {
    let doc: YamlValue = serde_yml::from_str(yaml)
        .map_err(|e| TabbyVaultError::MalformedHeader(format!("yaml parse: {e}")))?;

    let vault = doc
        .as_mapping()
        .and_then(|m| m.get("vault"))
        .ok_or(TabbyVaultError::MissingVaultBlock)?;

    let vault_map = vault
        .as_mapping()
        .ok_or_else(|| TabbyVaultError::MalformedHeader("vault is not a mapping".into()))?;

    let version = vault_map
        .get("version")
        .and_then(YamlValue::as_u64)
        .ok_or_else(|| TabbyVaultError::MalformedHeader("missing vault.version".into()))?;
    if version != TABBY_VAULT_VERSION {
        return Err(TabbyVaultError::UnsupportedVersion(version));
    }

    let contents_b64 = vault_map
        .get("contents")
        .and_then(YamlValue::as_str)
        .ok_or_else(|| TabbyVaultError::MalformedHeader("missing vault.contents".into()))?;
    let key_salt_hex = vault_map
        .get("keySalt")
        .and_then(YamlValue::as_str)
        .ok_or_else(|| TabbyVaultError::MalformedHeader("missing vault.keySalt".into()))?;
    let iv_hex = vault_map
        .get("iv")
        .and_then(YamlValue::as_str)
        .ok_or_else(|| TabbyVaultError::MalformedHeader("missing vault.iv".into()))?;

    let salt = hex::decode(key_salt_hex)
        .map_err(|e| TabbyVaultError::MalformedHeader(format!("keySalt hex: {e}")))?;
    let iv = hex::decode(iv_hex)
        .map_err(|e| TabbyVaultError::MalformedHeader(format!("iv hex: {e}")))?;
    if iv.len() != TABBY_IV_LEN {
        return Err(TabbyVaultError::MalformedHeader(format!(
            "iv length {} != 16",
            iv.len()
        )));
    }
    let ciphertext = B64
        .decode(contents_b64.as_bytes())
        .map_err(|e| TabbyVaultError::MalformedHeader(format!("contents base64: {e}")))?;

    let key = pbkdf2_sha512(
        password.as_bytes(),
        &salt,
        TABBY_PBKDF2_ITERATIONS,
        TABBY_KEY_LEN,
    );

    let plaintext = match aes_256_cbc_decrypt_pkcs7(&key, &iv, &ciphertext) {
        Ok(pt) => pt,
        Err(SecretCryptoError::BadPadding) => return Err(TabbyVaultError::BadPassword),
        Err(e) => return Err(TabbyVaultError::MalformedHeader(e.to_string())),
    };

    extract_secrets(&plaintext)
}

#[derive(Debug, Deserialize)]
struct PlaintextEnvelope {
    #[serde(default)]
    secrets: Vec<RawSecret>,
}

#[derive(Debug, Deserialize)]
struct RawSecret {
    #[serde(rename = "type")]
    kind: String,
    key: serde_json::Value,
    value: String,
}

#[derive(Debug, Deserialize)]
struct PasswordKey {
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<serde_json::Value>,
    #[serde(default)]
    user: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KeyPassphraseKey {
    #[serde(default)]
    hash: Option<String>,
}

fn extract_secrets(plaintext: &Zeroizing<Vec<u8>>) -> Result<Vec<TabbySecret>, TabbyVaultError> {
    let envelope: PlaintextEnvelope = serde_json::from_slice(plaintext.as_slice())
        .map_err(|e| TabbyVaultError::MalformedPlaintext(format!("json: {e}")))?;

    let mut out = Vec::new();
    for raw in envelope.secrets {
        match raw.kind.as_str() {
            "ssh:password" => {
                let key: PasswordKey = serde_json::from_value(raw.key).map_err(|e| {
                    TabbyVaultError::MalformedPlaintext(format!("password key: {e}"))
                })?;
                let host = match key.host {
                    Some(h) if !h.is_empty() => h,
                    _ => continue,
                };
                let port = key.port.and_then(coerce_port);
                out.push(TabbySecret::Password {
                    host,
                    port,
                    user: key.user.filter(|u| !u.is_empty()),
                    value: raw.value,
                });
            }
            "ssh:key-passphrase" => {
                let key: KeyPassphraseKey = serde_json::from_value(raw.key).map_err(|e| {
                    TabbyVaultError::MalformedPlaintext(format!("key-passphrase key: {e}"))
                })?;
                let id = match key.hash {
                    Some(h) if !h.is_empty() => h,
                    _ => continue,
                };
                out.push(TabbySecret::KeyPassphrase {
                    id,
                    value: raw.value,
                });
            }
            // Tabby also stores `file` secrets and other types we don't import.
            _ => continue,
        }
    }
    Ok(out)
}

fn coerce_port(value: serde_json::Value) -> Option<u16> {
    match value {
        serde_json::Value::Number(n) => n.as_u64().and_then(|v| u16::try_from(v).ok()),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptVaultArgs {
    pub yaml_text: String,
    pub master_password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptVaultResponse {
    pub secrets: Vec<TabbySecret>,
}

#[tauri::command]
pub async fn tabby_decrypt_vault(args: DecryptVaultArgs) -> Result<DecryptVaultResponse, String> {
    let DecryptVaultArgs {
        yaml_text,
        master_password,
    } = args;
    // Wrap the password to ensure it's zeroed on drop even if the command
    // returns early. The `master_password` field above moves out of `args`.
    let pw = Zeroizing::new(master_password);
    match decrypt_vault_yaml(&yaml_text, pw.as_str()) {
        Ok(secrets) => Ok(DecryptVaultResponse { secrets }),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::Aes256;
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockModeEncrypt, KeyIvInit};

    type Aes256CbcEnc = cbc::Encryptor<Aes256>;

    fn build_vault_yaml(plaintext_json: &str, password: &str) -> String {
        let salt = [0xa1u8; 8];
        let iv = [0xb2u8; 16];
        let key = pbkdf2_sha512(password.as_bytes(), &salt, TABBY_PBKDF2_ITERATIONS, 32);
        let block_size = 16;
        let pt_len = plaintext_json.len();
        let pad = block_size - (pt_len % block_size);
        let mut buf = vec![0u8; pt_len + pad];
        buf[..pt_len].copy_from_slice(plaintext_json.as_bytes());
        let ct_len = Aes256CbcEnc::new_from_slices(key.as_slice(), &iv)
            .expect("key and iv lengths are fixed")
            .encrypt_padded::<Pkcs7>(&mut buf, pt_len)
            .expect("encrypt")
            .len();
        buf.truncate(ct_len);
        format!(
            "vault:\n  version: 1\n  contents: {}\n  keySalt: {}\n  iv: {}\n",
            B64.encode(&buf),
            hex::encode(salt),
            hex::encode(iv),
        )
    }

    #[test]
    fn decrypts_password_and_passphrase_secrets() {
        let plaintext = serde_json::json!({
            "config": {},
            "secrets": [
                {
                    "type": "ssh:password",
                    "key": { "host": "example.com", "port": 22, "user": "alice" },
                    "value": "hunter2",
                },
                {
                    "type": "ssh:key-passphrase",
                    "key": { "hash": "abcd1234" },
                    "value": "phrase",
                },
                {
                    "type": "file",
                    "key": { "id": "x", "description": "ignored" },
                    "value": "AAAA",
                },
            ],
        })
        .to_string();
        let yaml = build_vault_yaml(&plaintext, "correct horse");
        let out = decrypt_vault_yaml(&yaml, "correct horse").unwrap();
        assert_eq!(out.len(), 2);
        match &out[0] {
            TabbySecret::Password {
                host,
                port,
                user,
                value,
            } => {
                assert_eq!(host, "example.com");
                assert_eq!(*port, Some(22));
                assert_eq!(user.as_deref(), Some("alice"));
                assert_eq!(value, "hunter2");
            }
            _ => panic!("expected password first"),
        }
        match &out[1] {
            TabbySecret::KeyPassphrase { id, value } => {
                assert_eq!(id, "abcd1234");
                assert_eq!(value, "phrase");
            }
            _ => panic!("expected passphrase second"),
        }
    }

    #[test]
    fn wrong_password_returns_bad_password() {
        let yaml = build_vault_yaml(r#"{"secrets":[]}"#, "right");
        let err = decrypt_vault_yaml(&yaml, "wrong").unwrap_err();
        assert!(matches!(err, TabbyVaultError::BadPassword));
    }

    #[test]
    fn unsupported_version_rejected() {
        let yaml = "vault:\n  version: 2\n  contents: AA==\n  keySalt: 0102\n  iv: 01020304050607080102030405060708\n";
        let err = decrypt_vault_yaml(yaml, "x").unwrap_err();
        assert!(matches!(err, TabbyVaultError::UnsupportedVersion(2)));
    }

    #[test]
    fn missing_vault_returns_missing() {
        let yaml = "profiles: []\ngroups: []\n";
        let err = decrypt_vault_yaml(yaml, "x").unwrap_err();
        assert!(matches!(err, TabbyVaultError::MissingVaultBlock));
    }

    #[test]
    fn coerces_string_port() {
        let plaintext = serde_json::json!({
            "secrets": [
                { "type": "ssh:password",
                  "key": { "host": "h", "port": "2200", "user": "u" },
                  "value": "p" }
            ]
        })
        .to_string();
        let yaml = build_vault_yaml(&plaintext, "x");
        let out = decrypt_vault_yaml(&yaml, "x").unwrap();
        match &out[0] {
            TabbySecret::Password { port, .. } => assert_eq!(*port, Some(2200)),
            _ => panic!("expected password"),
        }
    }
}
