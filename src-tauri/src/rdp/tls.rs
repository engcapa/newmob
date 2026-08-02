//! Certificate-verifying TLS for the RDP client and RD Gateway.
//!
//! IronRDP's convenience TLS adapter intentionally disables certificate
//! verification. Taomni instead validates against the operating-system trust
//! store and supports an explicit SHA-256 leaf-certificate pin for self-signed
//! or private-CA deployments. A missing/mismatched pin is reported with the
//! observed fingerprint so the frontend can ask for informed user consent.

use std::io;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use x509_cert::der::Decode;

pub type TlsStream<S> = tokio_rustls::client::TlsStream<S>;

const TRUST_TABLE: &str = "rdp_certificate_pins";

pub struct VerifiedTls<S> {
    pub stream: TlsStream<S>,
    pub server_public_key: Vec<u8>,
    pub fingerprint: String,
    pub used_pin: bool,
}

pub fn init_trust_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rdp_certificate_pins (
            endpoint TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
}

pub fn load_pin(conn: &Connection, host: &str, port: u16) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!("SELECT fingerprint FROM {TRUST_TABLE} WHERE endpoint = ?1"),
        params![endpoint_key(host, port)],
        |row| row.get(0),
    )
    .optional()
}

pub fn save_pin(
    conn: &Connection,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<String, String> {
    let fingerprint = normalize_fingerprint(fingerprint)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {TRUST_TABLE} (endpoint, fingerprint, updated_at) \
             VALUES (?1, ?2, ?3)"
        ),
        params![endpoint_key(host, port), fingerprint, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(fingerprint)
}

pub fn normalize_fingerprint(value: &str) -> Result<String, String> {
    let normalized: String = value
        .chars()
        .filter(|ch| !matches!(ch, ':' | '-' | ' ' | '\t' | '\r' | '\n'))
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "RDP certificate fingerprint must contain exactly 64 SHA-256 hex digits".to_string(),
        );
    }
    Ok(normalized)
}

pub fn format_fingerprint(value: &str) -> String {
    value
        .as_bytes()
        .chunks(2)
        .filter_map(|chunk| std::str::from_utf8(chunk).ok())
        .collect::<Vec<_>>()
        .join(":")
        .to_ascii_uppercase()
}

pub async fn upgrade<S>(
    stream: S,
    server_name: &str,
    port: u16,
    pinned_fingerprint: Option<&str>,
) -> io::Result<VerifiedTls<S>>
where
    S: Unpin + AsyncRead + AsyncWrite,
{
    install_crypto_provider();
    let pin = pinned_fingerprint
        .map(normalize_fingerprint)
        .transpose()
        .map_err(io::Error::other)?;

    let native = rustls_native_certs::load_native_certs();
    if !native.errors.is_empty() {
        tracing::warn!(
            errors = native.errors.len(),
            "some operating-system root certificates could not be loaded"
        );
    }
    let mut roots = RootCertStore::empty();
    let (valid, invalid) = roots.add_parsable_certificates(native.certs);
    if invalid > 0 {
        tracing::warn!(
            invalid,
            "ignored malformed operating-system root certificates"
        );
    }
    if valid == 0 {
        return Err(io::Error::other(
            "operating-system certificate store did not provide any usable roots",
        ));
    }

    let webpki = WebPkiServerVerifier::builder(Arc::new(roots))
        .build()
        .map_err(io::Error::other)?;
    let verifier = Arc::new(PinnedServerVerifier {
        webpki,
        pin,
        host: server_name.to_string(),
        port,
    });
    let used_pin = verifier.pin.is_some();

    let mut config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();

    let domain = ServerName::try_from(server_name.to_owned()).map_err(io::Error::other)?;
    let mut tls_stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(domain, stream)
        .await?;
    tls_stream.flush().await?;

    let cert_der = tls_stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .ok_or_else(|| io::Error::other("peer certificate is missing"))?;
    let cert = x509_cert::Certificate::from_der(cert_der.as_ref()).map_err(io::Error::other)?;
    let server_public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| io::Error::other("RDP TLS certificate public key is not byte-aligned"))?
        .to_vec();
    let fingerprint = certificate_fingerprint(cert_der);

    Ok(VerifiedTls {
        stream: tls_stream,
        server_public_key,
        fingerprint,
        used_pin,
    })
}

fn endpoint_key(host: &str, port: u16) -> String {
    format!(
        "{}:{port}",
        host.trim().trim_end_matches('.').to_ascii_lowercase()
    )
}

fn certificate_fingerprint(cert: &CertificateDer<'_>) -> String {
    hex::encode(Sha256::digest(cert.as_ref()))
}

fn install_crypto_provider() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Debug)]
struct PinnedServerVerifier {
    webpki: Arc<WebPkiServerVerifier>,
    pin: Option<String>,
    host: String,
    port: u16,
}

impl PinnedServerVerifier {
    fn verify_pin(
        &self,
        cert: &CertificateDer<'_>,
        system_error: rustls::Error,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let observed = certificate_fingerprint(cert);
        let Some(expected) = self.pin.as_deref() else {
            return Err(rustls::Error::General(format!(
                "RDP_CERTIFICATE_UNTRUSTED host={} port={} observed={} system_error={system_error}",
                self.host, self.port, observed
            )));
        };
        if expected != observed {
            return Err(rustls::Error::General(format!(
                "RDP_CERTIFICATE_CHANGED host={} port={} expected={} observed={}",
                self.host, self.port, expected, observed
            )));
        }

        let parsed = x509_cert::Certificate::from_der(cert.as_ref()).map_err(|e| {
            rustls::Error::General(format!("pinned RDP certificate could not be parsed: {e}"))
        })?;
        let now = std::time::SystemTime::now();
        if now < parsed.tbs_certificate.validity.not_before.to_system_time() {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidYet,
            ));
        }
        if now > parsed.tbs_certificate.validity.not_after.to_system_time() {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::Expired,
            ));
        }

        match system_error {
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
            | rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName) => {
                Ok(ServerCertVerified::assertion())
            }
            other => Err(other),
        }
    }
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.webpki.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(verified) => Ok(verified),
            Err(error) => self.verify_pin(end_entity, error),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

    use super::{
        certificate_fingerprint, format_fingerprint, load_pin, normalize_fingerprint, save_pin,
    };

    #[test]
    fn fingerprints_are_normalized_and_formatted() {
        let raw = "AA:BB-CC dd".to_string() + &"11".repeat(28);
        let normalized = normalize_fingerprint(&raw).unwrap();
        assert_eq!(normalized.len(), 64);
        assert!(normalized.starts_with("aabbccdd"));
        assert_eq!(format_fingerprint(&normalized).len(), 95);
        assert!(normalize_fingerprint("abcd").is_err());
    }

    #[test]
    fn trust_store_keys_are_host_case_insensitive() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::init_trust_table(&conn).unwrap();
        let fingerprint = "ab".repeat(32);
        save_pin(&conn, "RDP.EXAMPLE.COM.", 3389, &fingerprint).unwrap();
        assert_eq!(
            load_pin(&conn, "rdp.example.com", 3389).unwrap().as_deref(),
            Some(fingerprint.as_str())
        );
    }

    #[tokio::test]
    async fn self_signed_certificate_requires_and_honors_exact_pin() {
        super::install_crypto_provider();
        let generated = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let cert = CertificateDer::from(generated.cert.der().to_vec());
        let fingerprint = certificate_fingerprint(&cert);
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            generated.signing_key.serialize_der(),
        ));
        let server = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key)
                .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let acceptor = tokio_rustls::TlsAcceptor::from(server.clone());
                let _ = acceptor.accept(stream).await;
            }
        });

        let first = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let error = super::upgrade(first, "localhost", port, None)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("RDP_CERTIFICATE_UNTRUSTED"));
        assert!(error.contains(&fingerprint));

        let second = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let verified = super::upgrade(second, "localhost", port, Some(&fingerprint))
            .await
            .unwrap();
        assert_eq!(verified.fingerprint, fingerprint);
        assert!(verified.used_pin);
        server_task.await.unwrap();
    }
}
