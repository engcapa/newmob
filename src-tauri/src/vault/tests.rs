use super::*;
use tempfile::TempDir;

fn fresh_vault() -> (TempDir, Vault) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("vault.db");
    let v = Vault::open(&path).expect("open vault");
    (dir, v)
}

const PW: &str = "correct-horse-battery-staple";

#[test]
fn init_then_status_unlocked() {
    let (_d, v) = fresh_vault();
    assert_eq!(v.status().unwrap().state, VaultStateKind::Empty);
    v.init(PW).unwrap();
    assert_eq!(v.status().unwrap().state, VaultStateKind::Unlocked);
}

#[test]
fn double_init_rejected() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let err = v.init(PW).unwrap_err();
    assert!(err.contains("already"));
}

#[test]
fn lock_then_unlock_roundtrip() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    v.lock().unwrap();
    assert_eq!(v.status().unwrap().state, VaultStateKind::Locked);
    v.unlock(PW).unwrap();
    assert_eq!(v.status().unwrap().state, VaultStateKind::Unlocked);
}

#[test]
fn unlock_with_bad_password_fails() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    v.lock().unwrap();
    let err = v.unlock("wrong-password").unwrap_err();
    assert_eq!(err, ERR_VAULT_BAD_PASSWORD);
    assert_eq!(v.status().unwrap().state, VaultStateKind::Locked);
}

#[test]
fn put_resolve_roundtrip() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let res = v.put("ssh-password", "alice@host", "hunter2").unwrap();
    assert!(res.reference.starts_with(VAULT_REF_PREFIX));
    let resolved = v.resolve(&res.reference).unwrap().unwrap();
    assert_eq!(resolved.as_str(), "hunter2");
}

#[test]
fn fixed_entries_roundtrip_and_update() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    assert!(v.get_fixed("lanchat.message-key-v1").unwrap().is_none());

    v.put_fixed(
        "lanchat.message-key-v1",
        "lanchat_secret",
        "LanChat Message Key",
        "first",
    )
    .unwrap();
    assert_eq!(
        v.get_fixed("lanchat.message-key-v1")
            .unwrap()
            .unwrap()
            .as_str(),
        "first"
    );

    v.put_fixed(
        "lanchat.message-key-v1",
        "lanchat_secret",
        "LanChat Message Key",
        "second",
    )
    .unwrap();
    assert_eq!(
        v.get_fixed("lanchat.message-key-v1")
            .unwrap()
            .unwrap()
            .as_str(),
        "second"
    );
}

#[test]
fn resolve_passes_through_non_references() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    assert!(v.resolve("plain-text-password").unwrap().is_none());
    assert!(v.resolve("").unwrap().is_none());
}

#[test]
fn resolve_returns_locked_when_locked() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let r = v.put("ssh-password", "alice@host", "hunter2").unwrap();
    v.lock().unwrap();
    let err = v.resolve(&r.reference).unwrap_err();
    assert_eq!(err, ERR_VAULT_LOCKED);
}

#[test]
fn nonce_is_unique_per_put() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let a = v.put("ssh-password", "a", "samevalue").unwrap();
    let b = v.put("ssh-password", "b", "samevalue").unwrap();
    let inner = v.inner.lock().unwrap();
    let ea = db::get_entry(&inner.conn, &a.id).unwrap().unwrap();
    let eb = db::get_entry(&inner.conn, &b.id).unwrap().unwrap();
    assert_ne!(ea.nonce, eb.nonce);
    assert_ne!(ea.ciphertext, eb.ciphertext);
}

#[test]
fn change_master_rewraps_existing_entries() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let r = v.put("ssh-password", "alice@host", "secret").unwrap();
    let new_pw = "another-strong-password";
    v.change_master(PW, new_pw).unwrap();
    // Still unlocked under the new password.
    let resolved = v.resolve(&r.reference).unwrap().unwrap();
    assert_eq!(resolved.as_str(), "secret");
    // Old password no longer unlocks.
    v.lock().unwrap();
    let err = v.unlock(PW).unwrap_err();
    assert_eq!(err, ERR_VAULT_BAD_PASSWORD);
    v.unlock(new_pw).unwrap();
    let resolved = v.resolve(&r.reference).unwrap().unwrap();
    assert_eq!(resolved.as_str(), "secret");
}

#[test]
fn tampered_ciphertext_rejected() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let r = v.put("ssh-password", "x", "secret").unwrap();
    {
        let inner = v.inner.lock().unwrap();
        let mut e = db::get_entry(&inner.conn, &r.id).unwrap().unwrap();
        // Flip one byte of the ciphertext.
        e.ciphertext[0] ^= 0x01;
        db::update_entry(&inner.conn, &e.id, &e.ciphertext, &e.nonce, 0).unwrap();
    }
    let err = v.resolve(&r.reference).unwrap_err();
    assert!(err.contains("aead"));
}

#[test]
fn delete_then_resolve_not_found() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let r = v.put("ssh-password", "x", "secret").unwrap();
    v.delete(&r.id).unwrap();
    let err = v.resolve(&r.reference).unwrap_err();
    assert_eq!(err, ERR_VAULT_NOT_FOUND);
}

#[test]
fn update_changes_plaintext() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    let r = v.put("ssh-password", "x", "old").unwrap();
    v.update(&r.id, "new").unwrap();
    let resolved = v.resolve(&r.reference).unwrap().unwrap();
    assert_eq!(resolved.as_str(), "new");
}

#[test]
fn list_does_not_leak_plaintext() {
    let (_d, v) = fresh_vault();
    v.init(PW).unwrap();
    v.put("ssh-password", "alice@host", "secret-value").unwrap();
    let summaries = v.list().unwrap();
    assert_eq!(summaries.len(), 1);
    let s = &summaries[0];
    assert_eq!(s.label, "alice@host");
    assert_eq!(s.kind, "ssh-password");
    let json = serde_json::to_string(&summaries).unwrap();
    assert!(!json.contains("secret-value"));
}

#[test]
fn persistence_across_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.db");
    let reference = {
        let v = Vault::open(&path).unwrap();
        v.init(PW).unwrap();
        v.put("ssh-password", "x", "persist-me").unwrap().reference
    };
    // Reopen.
    let v = Vault::open(&path).unwrap();
    assert_eq!(v.status().unwrap().state, VaultStateKind::Locked);
    v.unlock(PW).unwrap();
    let resolved = v.resolve(&reference).unwrap().unwrap();
    assert_eq!(resolved.as_str(), "persist-me");
}

#[test]
fn min_password_length_enforced() {
    let (_d, v) = fresh_vault();
    let err = v.init("short").unwrap_err();
    assert!(err.contains("at least 8"));
}

#[test]
fn test_verify_master_password_lifecycle() {
    let (_d, v) = fresh_vault();
    // 1. When vault is uninitialized, verify succeeds without password
    assert!(!v.is_initialized().unwrap());
    assert!(v.verify_master_password(None).is_ok());
    assert!(v.verify_master_password(Some("any")).is_ok());

    // 2. Initialize vault
    v.init(PW).unwrap();
    assert!(v.is_initialized().unwrap());

    // 3. Unauthenticated / empty password fails with ERR_VAULT_PASSWORD_REQUIRED
    assert_eq!(
        v.verify_master_password(None).unwrap_err(),
        ERR_VAULT_PASSWORD_REQUIRED
    );
    assert_eq!(
        v.verify_master_password(Some("   ")).unwrap_err(),
        ERR_VAULT_PASSWORD_REQUIRED
    );

    // 4. Bad password fails with ERR_VAULT_BAD_PASSWORD
    assert_eq!(
        v.verify_master_password(Some("wrong-password"))
            .unwrap_err(),
        ERR_VAULT_BAD_PASSWORD
    );

    // 5. Correct password succeeds
    assert!(v.verify_master_password(Some(PW)).is_ok());
    assert_eq!(v.status().unwrap().state, VaultStateKind::Unlocked);
}
