use crate::vault::crypto::{
    ARGON2_M_COST, ARGON2_P_COST, ARGON2_T_COST, NONCE_LEN, SALT_LEN, aead_decrypt, aead_encrypt,
    derive_root_key, random_nonce, random_salt,
};
use std::io::Read;

pub const BACKUP_ENC_MAGIC: &[u8; 13] = b"TAOBAK_ENC_V1";
pub const ERR_BACKUP_BAD_PASSWORD: &str = "BACKUP_BAD_PASSWORD";
pub const ERR_BACKUP_PASSWORD_REQUIRED: &str = "BACKUP_PASSWORD_REQUIRED";

/// Check if the stream starts with our encrypted archive magic header.
pub fn is_encrypted_stream<R: Read>(mut reader: R) -> bool {
    let mut magic = [0u8; 13];
    if reader.read_exact(&mut magic).is_ok() {
        &magic == BACKUP_ENC_MAGIC
    } else {
        false
    }
}

/// Check if byte slice starts with our encrypted archive magic header.
pub fn is_encrypted_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(BACKUP_ENC_MAGIC)
}

/// Encrypt arbitrary payload bytes with password-derived AES-256-GCM.
///
/// Output format:
/// `[13 bytes magic][16 bytes salt][12 bytes nonce][ciphertext + tag]`
pub fn encrypt_payload(payload: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        return Err("Password cannot be empty for encrypted backup".into());
    }
    let salt = random_salt();
    let nonce = random_nonce();
    let root_key = derive_root_key(password, &salt, ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)
        .map_err(|e| format!("key derivation error: {e}"))?;

    let ciphertext =
        aead_encrypt(&root_key, &nonce, payload).map_err(|e| format!("encryption failed: {e}"))?;

    let mut out = Vec::with_capacity(13 + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(BACKUP_ENC_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt an encrypted archive payload using the user-provided password.
pub fn decrypt_payload(data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let header_len = 13 + SALT_LEN + NONCE_LEN;
    if data.len() < header_len {
        return Err("corrupt or truncated encrypted backup file".into());
    }
    if !data.starts_with(BACKUP_ENC_MAGIC) {
        return Err("not an encrypted taobak archive".into());
    }
    if password.is_empty() {
        return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
    }

    let salt_slice = &data[13..13 + SALT_LEN];
    let nonce_slice = &data[13 + SALT_LEN..header_len];
    let ciphertext = &data[header_len..];

    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(nonce_slice);

    let root_key = derive_root_key(
        password,
        salt_slice,
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )
    .map_err(|e| format!("key derivation error: {e}"))?;

    let decrypted = aead_decrypt(&root_key, &nonce, ciphertext)
        .map_err(|_| ERR_BACKUP_BAD_PASSWORD.to_string())?;

    Ok(decrypted.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = b"Hello Taomni Backup World! SQLite Consistent Snapshot.";
        let password = "SuperSecretPassword123!";

        let encrypted = encrypt_payload(plaintext, password).expect("encrypt");
        assert!(is_encrypted_bytes(&encrypted));

        let wrong_pw_res = decrypt_payload(&encrypted, "wrong_pw");
        assert_eq!(wrong_pw_res.err().unwrap(), ERR_BACKUP_BAD_PASSWORD);

        let decrypted = decrypt_payload(&encrypted, password).expect("decrypt");
        assert_eq!(&decrypted, plaintext);
    }
}
