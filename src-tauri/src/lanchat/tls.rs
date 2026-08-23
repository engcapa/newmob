//! Mutual-TLS for the LanChat control channel (phase 2).
//!
//! Both peers present their self-signed identity certificate (phase 1) and
//! require one from the other (mutual auth). There is no CA: the custom
//! verifiers accept any structurally-valid self-signed certificate but still
//! validate the TLS handshake signature, which proves the peer holds the private
//! key for the certificate it presented. The certificate is then bound to the
//! peer's claimed identity at the application layer by checking
//! `node_id == SHA-256(peer certificate)` (see [`super::transport`]). Because the
//! id *is* the certificate fingerprint, a peer cannot present a certificate for
//! an id it does not own, and an active MITM cannot impersonate a known id
//! without its private key.

use std::sync::{Arc, Once};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    ClientConfig, DigitallySignedStruct, DistinguishedName, ServerConfig, SignatureScheme,
};

use super::identity::Identity;

/// SNI used when dialing. Our verifier ignores names (identity is by
/// fingerprint), so any stable value works.
pub const SNI: &str = "taomni-lanchat";

fn ensure_crypto_provider() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn ring_provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Client-side verifier: accept any self-signed server cert (no CA / hostname /
/// expiry checks) but validate the handshake signature so key possession is
/// proven. Identity binding happens at the app layer via the cert fingerprint.
#[derive(Debug)]
struct AnyServerCert {
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for AnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// Server-side verifier: same posture for the client cert, with client auth
/// mandatory (mutual TLS).
#[derive(Debug)]
struct AnyClientCert {
    algs: WebPkiSupportedAlgorithms,
}

impl ClientCertVerifier for AnyClientCert {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// Build the server TLS config presenting our identity and requiring a client
/// cert (mutual auth).
pub fn server_config(identity: &Identity) -> Result<Arc<ServerConfig>, String> {
    ensure_crypto_provider();
    let provider = ring_provider();
    let algs = provider.signature_verification_algorithms;
    let cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("server tls versions: {e}"))?
        .with_client_cert_verifier(Arc::new(AnyClientCert { algs }))
        .with_single_cert(vec![identity.certificate_der()], identity.private_key_der())
        .map_err(|e| format!("server tls cert: {e}"))?;
    Ok(Arc::new(cfg))
}

/// Build the client TLS config presenting our identity and pinning the peer by
/// fingerprint at the app layer.
pub fn client_config(identity: &Identity) -> Result<Arc<ClientConfig>, String> {
    ensure_crypto_provider();
    let provider = ring_provider();
    let algs = provider.signature_verification_algorithms;
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("client tls versions: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyServerCert { algs }))
        .with_client_auth_cert(vec![identity.certificate_der()], identity.private_key_der())
        .map_err(|e| format!("client tls cert: {e}"))?;
    Ok(Arc::new(cfg))
}

/// Extract the peer's leaf certificate DER from a completed TLS connection.
pub fn peer_cert_der(conn: &rustls::CommonState) -> Option<Vec<u8>> {
    conn.peer_certificates()
        .and_then(|certs| certs.first())
        .map(|c| c.as_ref().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lanchat::identity::Identity;

    #[test]
    fn builds_server_and_client_configs_from_identity() {
        let id = Identity::generate().expect("identity");
        assert!(server_config(&id).is_ok(), "server config builds");
        assert!(client_config(&id).is_ok(), "client config builds");
    }
}
