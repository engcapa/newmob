//! Self-certifying node identity (phase 1).
//!
//! The node identity is a long-lived key pair whose self-signed X.509
//! certificate is the public credential presented in the mutual-TLS handshake
//! (phase 2). The node id is the SHA-256 fingerprint (lowercase hex) of that
//! certificate DER. Because a peer can only present this certificate if it holds
//! the matching private key — proven by the TLS handshake signature — the id is
//! unforgeable: a peer cannot claim an id it does not own. This replaces the
//! legacy random-UUID node id.
//!
//! The private key (PKCS#8 DER) lives in Taomni's master-password vault; the
//! certificate (public) is cached in the `profile` row. On first launch a fresh
//! key pair + certificate are generated.

use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::store::LanChatStore;

/// Node id = lowercase hex of SHA-256 over the certificate DER.
pub fn fingerprint(cert_der: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(cert_der);
    hex::encode(h.finalize())
}

/// A loaded node identity: the self-signed cert (public) + private key (secret),
/// both as DER, plus the derived node id.
pub struct Identity {
    pub node_id: String,
    pub cert_der: Vec<u8>,
    pub key_der: Zeroizing<Vec<u8>>,
}

impl Identity {
    /// Generate a brand-new identity (key pair + self-signed cert).
    pub fn generate() -> Result<Self, String> {
        let key_pair = KeyPair::generate().map_err(|e| format!("generate keypair: {e}"))?;
        let cert_der = build_cert(&key_pair)?;
        let node_id = fingerprint(&cert_der);
        Ok(Self {
            node_id,
            cert_der,
            key_der: Zeroizing::new(key_pair.serialize_der()),
        })
    }

    /// Rebuild an identity from stored material, validating the private key is
    /// loadable. The node id is recomputed from the cert (never trusted as-is).
    pub fn from_stored(key_der: Zeroizing<Vec<u8>>, cert_der: Vec<u8>) -> Result<Self, String> {
        // Reconstruct the key pair to prove the stored bytes are a usable key.
        KeyPair::try_from(key_der.as_slice()).map_err(|e| format!("load keypair: {e}"))?;
        let node_id = fingerprint(&cert_der);
        Ok(Self {
            node_id,
            cert_der,
            key_der,
        })
    }

    /// The certificate in rustls form (for the TLS config in phase 2).
    pub fn certificate_der(&self) -> CertificateDer<'static> {
        CertificateDer::from(self.cert_der.clone())
    }

    /// The private key in rustls form.
    pub fn private_key_der(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.to_vec()))
    }
}

/// Build a self-signed certificate DER for `key_pair`. The SAN is cosmetic — our
/// pinning model verifies by fingerprint, not by name — but keeps generic TLS
/// tooling happy.
fn build_cert(key_pair: &KeyPair) -> Result<Vec<u8>, String> {
    let params = CertificateParams::new(vec!["taomni-lanchat".to_string()])
        .map_err(|e| format!("cert params: {e}"))?;
    let cert = params
        .self_signed(key_pair)
        .map_err(|e| format!("self-sign cert: {e}"))?;
    Ok(cert.der().to_vec())
}

/// Load this node's stable identity, generating + persisting one on first launch
/// and migrating from a legacy UUID identity when needed.
///
/// Reuse path: a stored private key + cached cert whose fingerprint matches the
/// persisted node id. Otherwise a fresh identity is generated; if a legacy row
/// existed, the local data that referenced the old id is migrated (own messages'
/// `sender_id` rewritten, stale peer cache cleared — peer ids changed network-wide
/// under the hard cutover).
pub fn ensure(
    store: &LanChatStore,
    stored_key: Option<Zeroizing<Vec<u8>>>,
) -> Result<(Identity, bool), String> {
    let existing = store
        .get_profile_id_and_cert()
        .map_err(|e| format!("read identity row: {e}"))?;

    if let (Some((id, Some(cert_der))), Some(key_der)) = (&existing, &stored_key) {
        if fingerprint(cert_der) == *id {
            match Identity::from_stored(key_der.clone(), cert_der.clone()) {
                Ok(identity) => return Ok((identity, false)),
                Err(e) => log::warn!(
                    "lanchat identity: stored private key is invalid ({e}); regenerating"
                ),
            }
        }
        log::warn!("lanchat identity: cached cert no longer matches node id; regenerating");
    }

    // Fresh identity (first launch or inconsistent preview data).
    let identity = Identity::generate()?;
    let old_id = existing.as_ref().map(|(id, _)| id.clone());
    if let Some(old) = &old_id {
        if old != &identity.node_id {
            log::info!("lanchat identity: migrating {old} -> {}", identity.node_id);
            let _ = store.migrate_sender_id(old, &identity.node_id);
            let _ = store.clear_peers();
        }
    }
    store
        .set_identity(&identity.node_id, &identity.cert_der, old_id.as_deref())
        .map_err(|e| format!("persist identity row: {e}"))?;

    Ok((identity, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_yields_stable_fingerprint_id() {
        let id = Identity::generate().expect("generate");
        assert_eq!(id.node_id.len(), 64, "sha256 hex is 64 chars");
        assert!(id.node_id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            id.node_id,
            fingerprint(&id.cert_der),
            "id is cert fingerprint"
        );
    }

    #[test]
    fn round_trips_through_stored_der() {
        let a = Identity::generate().expect("generate");
        let b = Identity::from_stored(a.key_der.clone(), a.cert_der.clone()).expect("reload");
        assert_eq!(a.node_id, b.node_id, "id stable across reload");
    }

    #[test]
    fn distinct_identities_have_distinct_ids() {
        let a = Identity::generate().unwrap();
        let b = Identity::generate().unwrap();
        assert_ne!(a.node_id, b.node_id);
    }
}
