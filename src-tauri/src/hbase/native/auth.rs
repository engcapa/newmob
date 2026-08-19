//! HBase RPC authentication: simple (no negotiation) and Kerberos/GSSAPI.
//!
//! Simple auth (the default) writes the preamble with auth byte `0x50` and then
//! the ConnectionHeader directly; the server stays silent on success.
//!
//! Kerberos (`0x51`) inserts a SASL/GSSAPI token negotiation between the
//! preamble and the ConnectionHeader. The wire framing, transcribed from
//! HBase's `HBaseSaslRpcClient.saslConnect` (rel/2.6.1):
//! - client → server: `i32 BE token_len | token bytes` (initial response)
//! - server → client: `i32 BE status` (0 = SUCCESS), then `i32 BE len | token`
//!   where `len == -88` (`SWITCH_TO_SIMPLE_AUTH`) asks the client to downgrade.
//! - repeat until the SASL client reports complete.
//!
//! The Kerberos path is compiled only with the `hbase-kerberos` feature so the
//! default build pulls in no GSSAPI system libraries.

/// SASL status sentinel: success.
#[allow(dead_code)]
pub const SASL_SUCCESS: i32 = 0;
/// SASL length sentinel asking the client to fall back to simple auth.
#[allow(dead_code)]
pub const SWITCH_TO_SIMPLE_AUTH: i32 = -88;

/// Selected authentication method for a connection.
#[derive(Debug, Clone)]
pub enum AuthMethod {
    /// Simple auth (effective user only); preamble byte 0x50.
    Simple,
    /// Kerberos/GSSAPI; preamble byte 0x51. Carries the service principal name
    /// (SPN), e.g. `hbase/host@REALM`, and the optional client principal name.
    Kerberos {
        service_principal: String,
        client_principal: Option<String>,
    },
}

impl AuthMethod {
    /// The preamble auth byte for this method.
    pub fn preamble_byte(&self) -> u8 {
        match self {
            AuthMethod::Simple => super::rpc::codec::AUTH_SIMPLE,
            AuthMethod::Kerberos { .. } => super::rpc::codec::AUTH_KERBEROS,
        }
    }
}

#[cfg(feature = "hbase-kerberos")]
pub mod kerberos {
    //! GSSAPI SASL negotiation over a tokio TCP connection.
    use cross_krb5::{ClientCtx, InitiateFlags, K5Ctx, Step};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Perform the HBase SASL/GSSAPI handshake on the raw socket halves, right
    /// after the preamble and before the ConnectionHeader. Returns `Ok(true)`
    /// when SASL completed, `Ok(false)` if the server asked to fall back to
    /// simple auth.
    ///
    /// `service_principal` is the server SPN, e.g. `hbase/rs1.example.com@REALM`.
    pub async fn sasl_connect<R, W>(
        read: &mut R,
        write: &mut W,
        service_principal: &str,
        client_principal: Option<&str>,
    ) -> Result<bool, String>
    where
        R: AsyncReadExt + Unpin,
        W: AsyncWriteExt + Unpin,
    {
        // Initial token.
        let (mut pending, token) = ClientCtx::new(
            InitiateFlags::empty(),
            client_principal,
            service_principal,
            None,
        )
        .map_err(|e| format!("GSSAPI init failed: {e}"))?;
        write_token(write, &token).await?;

        // First server reply: status + (challenge | switch-to-simple).
        read_status(read).await?;
        let len = read.read_i32().await.map_err(ioerr)?;
        if len == super::SWITCH_TO_SIMPLE_AUTH {
            return Ok(false);
        }
        let mut challenge = read_n(read, len).await?;

        // Negotiation loop.
        loop {
            match pending
                .step(&challenge)
                .map_err(|e| format!("GSSAPI step failed: {e}"))?
            {
                Step::Finished((ctx, last)) => {
                    // The GSSAPI security context is established, but HBase's
                    // SaslServer follows the SASL/GSSAPI mechanism (RFC 4752),
                    // which requires a security-layer negotiation *after* context
                    // establishment. Skipping it makes the server reject the
                    // subsequent plaintext ConnectionHeader ("Handshake expecting
                    // no response data from server") and drop the connection.
                    finish_sasl_security_layer(read, write, ctx, last.as_deref()).await?;
                    return Ok(true);
                }
                Step::Continue((next, tok)) => {
                    write_token(write, &tok).await?;
                    read_status(read).await?;
                    let len = read.read_i32().await.map_err(ioerr)?;
                    challenge = read_n(read, len).await?;
                    pending = next;
                }
            }
        }
    }

    /// Perform the RFC 4752 SASL/GSSAPI security-layer negotiation that follows
    /// context establishment, mirroring Java `GssKrb5Client`:
    ///   1. client sends its final context token (empty for Kerberos);
    ///   2. server replies with a `gss_wrap`-protected offer: 1 byte QOP bitmask
    ///      + 3 bytes (big-endian) max server message size;
    ///   3. client replies with a `gss_wrap`-protected choice: 1 byte selected
    ///      QOP + 3 bytes max client message size + optional authzid.
    ///
    /// We support only `auth` (no integrity/privacy security layer), so we pick
    /// QOP `0x01`, advertise a zero max buffer, and send an empty authzid — after
    /// which the plaintext ConnectionHeader and RPCs flow unwrapped.
    async fn finish_sasl_security_layer<R, W>(
        read: &mut R,
        write: &mut W,
        mut ctx: ClientCtx,
        last_token: Option<&[u8]>,
    ) -> Result<(), String>
    where
        R: AsyncReadExt + Unpin,
        W: AsyncWriteExt + Unpin,
    {
        // 1. Send the final context token (empty for Kerberos mutual auth).
        write_token(write, last_token.unwrap_or(&[])).await?;

        // 2. Read the server's wrapped QOP offer.
        read_status(read).await?;
        let len = read.read_i32().await.map_err(ioerr)?;
        let wrapped_offer = read_n(read, len).await?;
        let offer = ctx
            .unwrap(&wrapped_offer)
            .map_err(|e| format!("SASL unwrap of server QOP offer failed: {e}"))?;
        let qop_mask = offer.first().copied().unwrap_or(0);

        // SASL QOP bits: 0x01 = auth (no layer), 0x02 = integrity, 0x04 = privacy.
        if qop_mask & 0x01 == 0 {
            return Err(format!(
                "server requires a SASL security layer (QOP offer 0x{qop_mask:02x}); \
                 only authentication (no integrity/privacy) is supported"
            ));
        }

        // 3. Reply: QOP=auth, zero max buffer (no security layer), empty authzid.
        let reply = [0x01u8, 0x00, 0x00, 0x00];
        let wrapped_reply = ctx
            .wrap(false, &reply)
            .map_err(|e| format!("SASL wrap of QOP choice failed: {e}"))?;
        write_token(write, &wrapped_reply).await?;
        Ok(())
    }

    async fn write_token<W: AsyncWriteExt + Unpin>(
        write: &mut W,
        token: &[u8],
    ) -> Result<(), String> {
        write.write_i32(token.len() as i32).await.map_err(ioerr)?;
        write.write_all(token).await.map_err(ioerr)?;
        write.flush().await.map_err(ioerr)?;
        Ok(())
    }

    async fn read_status<R: AsyncReadExt + Unpin>(read: &mut R) -> Result<(), String> {
        let status = read.read_i32().await.map_err(ioerr)?;
        if status != super::SASL_SUCCESS {
            // On error the server sends two writable strings (class, message).
            let class = read_writable_string(read).await.unwrap_or_default();
            let msg = read_writable_string(read).await.unwrap_or_default();
            return Err(format!("SASL negotiation failed: {class}: {msg}"));
        }
        Ok(())
    }

    async fn read_n<R: AsyncReadExt + Unpin>(read: &mut R, len: i32) -> Result<Vec<u8>, String> {
        if len < 0 {
            return Err(format!("negative SASL token length {len}"));
        }
        let mut buf = vec![0u8; len as usize];
        read.read_exact(&mut buf).await.map_err(ioerr)?;
        Ok(buf)
    }

    /// Hadoop `WritableUtils.readString`: a vint length prefix + UTF-8 bytes.
    /// We approximate with a 4-byte length (sufficient for error text framing
    /// in practice; on parse trouble we just return what we read).
    async fn read_writable_string<R: AsyncReadExt + Unpin>(read: &mut R) -> Result<String, String> {
        let len = read.read_i32().await.map_err(ioerr)?;
        if !(0..=1_000_000).contains(&len) {
            return Ok(String::new());
        }
        let mut buf = vec![0u8; len as usize];
        read.read_exact(&mut buf).await.map_err(ioerr)?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn ioerr(e: std::io::Error) -> String {
        format!("SASL io error: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_bytes() {
        assert_eq!(AuthMethod::Simple.preamble_byte(), 0x50);
        assert_eq!(
            AuthMethod::Kerberos {
                service_principal: "hbase/h@R".into(),
                client_principal: None,
            }
            .preamble_byte(),
            0x51
        );
    }

    #[test]
    fn sasl_constants() {
        assert_eq!(SASL_SUCCESS, 0);
        assert_eq!(SWITCH_TO_SIMPLE_AUTH, -88);
    }
}
