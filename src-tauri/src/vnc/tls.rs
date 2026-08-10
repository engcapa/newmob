use std::pin::Pin;
use std::time::Duration;

use openssl::ssl::{SslConnector, SslMethod, SslVerifyMode, SslVersion};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_openssl::SslStream;

use crate::vnc::limits::DecodeLimits;
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::rfb::{PendingSecurity, SEC_TYPE_ANONYMOUS_TLS, negotiate_protocol_version};

pub(crate) struct PreparedRfbTransport {
    pub stream: std::net::TcpStream,
    pub proto_minor: u8,
    pub pending_security: Option<PendingSecurity>,
    pub outer_security_type: Option<u8>,
    pub tls_task: Option<tokio::task::JoinHandle<()>>,
}

pub(crate) async fn prepare_rfb_transport(
    socket: TcpStream,
    host: &str,
    policy: VncSecurityPolicy,
    timeout: Duration,
) -> Result<PreparedRfbTransport, String> {
    socket
        .set_nodelay(true)
        .map_err(|e| format!("configure VNC upstream TCP_NODELAY: {e}"))?;
    tokio::time::timeout(timeout, negotiate_outer_security(socket, host, policy))
        .await
        .map_err(|_| "VNC security negotiation timed out".to_string())?
}

async fn negotiate_outer_security(
    mut socket: TcpStream,
    host: &str,
    policy: VncSecurityPolicy,
) -> Result<PreparedRfbTransport, String> {
    let mut banner = [0u8; 12];
    socket
        .read_exact(&mut banner)
        .await
        .map_err(|e| format!("read protocol version: {e}"))?;
    let (reply, proto_minor) = negotiate_protocol_version(&banner)?;
    socket
        .write_all(&reply)
        .await
        .map_err(|e| format!("write protocol version: {e}"))?;
    socket
        .flush()
        .await
        .map_err(|e| format!("flush protocol version: {e}"))?;

    if proto_minor <= 3 {
        let sec_type = socket
            .read_u32()
            .await
            .map_err(|e| format!("read v3.3 security type: {e}"))?;
        if sec_type > u8::MAX as u32 {
            return Err(format!("unsupported v3.3 security type: {sec_type}"));
        }
        let chosen = policy.choose_outer(&[sec_type as u8]).map_err(|e| e.0)?;
        if chosen == SEC_TYPE_ANONYMOUS_TLS {
            return Err("RFB 3.3 anonymous TLS negotiation is not supported".into());
        }
        return plain_transport(socket, proto_minor, Some(PendingSecurity::V33(sec_type)));
    }

    let num_types = socket
        .read_u8()
        .await
        .map_err(|e| format!("read security types count: {e}"))? as usize;
    if num_types == 0 {
        let reason_len = socket
            .read_u32()
            .await
            .map_err(|e| format!("read security rejection length: {e}"))?
            as usize;
        if reason_len > DecodeLimits::default().max_reason_bytes {
            return Err("VNC failure reason exceeds configured limit".into());
        }
        let mut reason = vec![0u8; reason_len];
        socket
            .read_exact(&mut reason)
            .await
            .map_err(|e| format!("read security rejection reason: {e}"))?;
        return Err(format!(
            "server rejected connection: {}",
            String::from_utf8_lossy(&reason)
        ));
    }

    let mut types = vec![0u8; num_types];
    socket
        .read_exact(&mut types)
        .await
        .map_err(|e| format!("read security types: {e}"))?;
    let chosen = policy.choose_outer(&types).map_err(|e| e.0)?;
    socket
        .write_u8(chosen)
        .await
        .map_err(|e| format!("write security type: {e}"))?;
    socket
        .flush()
        .await
        .map_err(|e| format!("flush security type: {e}"))?;

    if chosen == SEC_TYPE_ANONYMOUS_TLS {
        anonymous_tls_transport(socket, host, proto_minor).await
    } else {
        plain_transport(socket, proto_minor, Some(PendingSecurity::Selected(chosen)))
    }
}

fn plain_transport(
    socket: TcpStream,
    proto_minor: u8,
    pending_security: Option<PendingSecurity>,
) -> Result<PreparedRfbTransport, String> {
    let stream = socket
        .into_std()
        .map_err(|e| format!("VNC transport conversion failed: {e}"))?;
    Ok(PreparedRfbTransport {
        stream,
        proto_minor,
        pending_security,
        outer_security_type: None,
        tls_task: None,
    })
}

async fn anonymous_tls_transport(
    socket: TcpStream,
    host: &str,
    proto_minor: u8,
) -> Result<PreparedRfbTransport, String> {
    let mut builder = SslConnector::builder(SslMethod::tls_client())
        .map_err(|e| format!("VNC TLS configuration failed: {e}"))?;
    builder.set_verify(SslVerifyMode::NONE);
    builder
        .set_cipher_list("aNULL:@SECLEVEL=0")
        .map_err(|e| format!("VNC TLS cipher configuration failed: {e}"))?;
    builder
        .set_min_proto_version(Some(SslVersion::TLS1))
        .map_err(|e| format!("VNC TLS minimum version configuration failed: {e}"))?;
    builder
        .set_max_proto_version(Some(SslVersion::TLS1_2))
        .map_err(|e| format!("VNC TLS maximum version configuration failed: {e}"))?;

    let ssl = builder
        .build()
        .configure()
        .and_then(|config| config.into_ssl(host))
        .map_err(|e| format!("VNC TLS client configuration failed: {e}"))?;
    let mut tls = SslStream::new(ssl, socket)
        .map_err(|e| format!("VNC TLS stream initialization failed: {e}"))?;
    Pin::new(&mut tls)
        .connect()
        .await
        .map_err(|e| format!("VNC TLS handshake failed: {e}"))?;

    // The RFB decoder is synchronous and splits its TCP socket into independent
    // read/write handles. Keep TLS asynchronous and expose a loopback plaintext
    // socket so both directions remain full duplex without sharing TLS state.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind VNC TLS bridge: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("read VNC TLS bridge address: {e}"))?;
    let local_client = TcpStream::connect(local_addr)
        .await
        .map_err(|e| format!("connect VNC TLS bridge: {e}"))?;
    let (mut local_bridge, _) = listener
        .accept()
        .await
        .map_err(|e| format!("accept VNC TLS bridge: {e}"))?;
    local_client
        .set_nodelay(true)
        .map_err(|e| format!("configure VNC TLS client bridge TCP_NODELAY: {e}"))?;
    local_bridge
        .set_nodelay(true)
        .map_err(|e| format!("configure VNC TLS relay bridge TCP_NODELAY: {e}"))?;

    let tls_task = tokio::spawn(async move {
        if let Err(error) = tokio::io::copy_bidirectional(&mut local_bridge, &mut tls).await {
            tracing::debug!(%error, "VNC TLS bridge stopped");
        }
    });
    let stream = local_client
        .into_std()
        .map_err(|e| format!("VNC TLS bridge conversion failed: {e}"))?;

    Ok(PreparedRfbTransport {
        stream,
        proto_minor,
        pending_security: None,
        outer_security_type: Some(SEC_TYPE_ANONYMOUS_TLS),
        tls_task: Some(tls_task),
    })
}

#[cfg(test)]
mod tests {
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    use openssl::dh::Dh;
    use openssl::ssl::{Ssl, SslAcceptor};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    use super::*;
    use crate::vnc::encodings::{
        ENCODING_DESKTOP_SIZE, ENCODING_POINTER_POS, ENCODING_RICH_CURSOR, ENCODING_X_CURSOR,
    };
    use crate::vnc::rfb::{RfbConnection, ServerMessage};

    async fn write_server_init<S: AsyncWrite + Unpin>(
        stream: &mut S,
        width: u16,
        height: u16,
        name: &[u8],
    ) {
        let mut init = Vec::with_capacity(24 + name.len());
        init.extend_from_slice(&width.to_be_bytes());
        init.extend_from_slice(&height.to_be_bytes());
        init.extend_from_slice(&[32, 24, 0, 1]);
        init.extend_from_slice(&255u16.to_be_bytes());
        init.extend_from_slice(&255u16.to_be_bytes());
        init.extend_from_slice(&255u16.to_be_bytes());
        init.extend_from_slice(&[0, 8, 16, 0, 0, 0]);
        init.extend_from_slice(&(name.len() as u32).to_be_bytes());
        init.extend_from_slice(name);
        stream.write_all(&init).await.unwrap();
        stream.flush().await.unwrap();
    }

    async fn complete_vncauth<S: AsyncRead + AsyncWrite + Unpin>(
        stream: &mut S,
        delay: Duration,
        name: &[u8],
    ) {
        stream.write_all(&[1, 2]).await.unwrap();
        stream.flush().await.unwrap();
        let mut chosen = [0u8; 1];
        stream.read_exact(&mut chosen).await.unwrap();
        assert_eq!(chosen[0], 2);
        stream.write_all(&[0x5a; 16]).await.unwrap();
        stream.flush().await.unwrap();
        let mut response = [0u8; 16];
        stream.read_exact(&mut response).await.unwrap();
        assert!(response.iter().any(|byte| *byte != 0));
        tokio::time::sleep(delay).await;
        stream.write_all(&0u32.to_be_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        let mut client_init = [0u8; 1];
        stream.read_exact(&mut client_init).await.unwrap();
        assert_eq!(client_init[0], 1);
        write_server_init(stream, 1024, 768, name).await;
    }

    async fn read_version_and_offer_tls(stream: &mut TcpStream) {
        stream.write_all(b"RFB 003.007\n").await.unwrap();
        stream.flush().await.unwrap();
        let mut client_banner = [0u8; 12];
        stream.read_exact(&mut client_banner).await.unwrap();
        assert_eq!(&client_banner, b"RFB 003.007\n");
        stream.write_all(&[2, 18, 2]).await.unwrap();
        stream.flush().await.unwrap();
        let mut selected = [0u8; 1];
        stream.read_exact(&mut selected).await.unwrap();
        assert_eq!(selected[0], 18);
    }

    #[tokio::test]
    async fn delayed_plain_vncauth_succeeds_with_authentication_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"RFB 003.007\n").await.unwrap();
            stream.flush().await.unwrap();
            let mut client_banner = [0u8; 12];
            stream.read_exact(&mut client_banner).await.unwrap();
            stream.write_all(&[1, 2]).await.unwrap();
            stream.flush().await.unwrap();
            let mut selected = [0u8; 1];
            stream.read_exact(&mut selected).await.unwrap();
            assert_eq!(selected[0], 2);
            stream.write_all(&[0x5a; 16]).await.unwrap();
            stream.flush().await.unwrap();
            let mut response = [0u8; 16];
            stream.read_exact(&mut response).await.unwrap();
            tokio::time::sleep(Duration::from_millis(75)).await;
            stream.write_all(&0u32.to_be_bytes()).await.unwrap();
            stream.flush().await.unwrap();
            let mut client_init = [0u8; 1];
            stream.read_exact(&mut client_init).await.unwrap();
            write_server_init(&mut stream, 800, 600, b"delayed fixture").await;
        });

        let socket = TcpStream::connect(address).await.unwrap();
        socket.set_nodelay(false).unwrap();
        let prepared = prepare_rfb_transport(
            socket,
            "127.0.0.1",
            VncSecurityPolicy::LegacyCompatible,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(prepared.stream.nodelay().unwrap());
        let started = Instant::now();
        let init = tokio::task::spawn_blocking(move || {
            let mut connection = RfbConnection::from_negotiated_stream(
                prepared.stream,
                Duration::from_millis(250),
                VncSecurityPolicy::LegacyCompatible,
                DecodeLimits::default(),
                prepared.proto_minor,
                prepared.pending_security,
                prepared.outer_security_type,
            )?;
            connection.authenticate(None, Some("passw0rd"))
        })
        .await
        .unwrap()
        .unwrap();

        assert!(started.elapsed() >= Duration::from_millis(70));
        assert_eq!((init.width, init.height), (800, 600));
        assert_eq!(init.name, "delayed fixture");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn anonymous_tls_wraps_inner_vncauth() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_version_and_offer_tls(&mut stream).await;

            let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls_server()).unwrap();
            builder.set_verify(SslVerifyMode::NONE);
            builder.set_cipher_list("aNULL:@SECLEVEL=0").unwrap();
            builder
                .set_min_proto_version(Some(SslVersion::TLS1_2))
                .unwrap();
            builder
                .set_max_proto_version(Some(SslVersion::TLS1_2))
                .unwrap();
            builder.set_tmp_dh(&Dh::get_2048_256().unwrap()).unwrap();
            let ssl = Ssl::new(builder.build().context()).unwrap();
            let mut tls = SslStream::new(ssl, stream).unwrap();
            Pin::new(&mut tls).accept().await.unwrap();
            complete_vncauth(&mut tls, Duration::ZERO, b"TLS fixture").await;
        });

        let socket = TcpStream::connect(address).await.unwrap();
        let prepared = prepare_rfb_transport(
            socket,
            "127.0.0.1",
            VncSecurityPolicy::PreferEncryption,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(prepared.outer_security_type, Some(18));
        let tls_task = prepared.tls_task;
        let result = tokio::task::spawn_blocking(move || {
            let mut connection = RfbConnection::from_negotiated_stream(
                prepared.stream,
                Duration::from_secs(2),
                VncSecurityPolicy::PreferEncryption,
                DecodeLimits::default(),
                prepared.proto_minor,
                prepared.pending_security,
                prepared.outer_security_type,
            )?;
            let init = connection.authenticate(None, Some("passw0rd"))?;
            Ok::<_, String>((init, connection.security_label(), connection.encrypted()))
        })
        .await
        .unwrap()
        .unwrap();

        assert_eq!((result.0.width, result.0.height), (1024, 768));
        assert_eq!(result.0.name, "TLS fixture");
        assert_eq!(result.1, "TLS (anonymous) + VNCAuth");
        assert!(result.2);
        if let Some(task) = tls_task {
            task.abort();
        }
        server.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires TAOMNI_VNC_LIVE_HOST and TAOMNI_VNC_LIVE_PASSWORD"]
    async fn connects_live_vnc_fixture() {
        let host = std::env::var("TAOMNI_VNC_LIVE_HOST").unwrap();
        let port = std::env::var("TAOMNI_VNC_LIVE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5900);
        let username = std::env::var("TAOMNI_VNC_LIVE_USERNAME").ok();
        let password = std::env::var("TAOMNI_VNC_LIVE_PASSWORD").unwrap();
        let socket = TcpStream::connect((host.as_str(), port)).await.unwrap();
        let prepared = prepare_rfb_transport(
            socket,
            &host,
            VncSecurityPolicy::PreferEncryption,
            Duration::from_secs(45),
        )
        .await
        .unwrap();
        let tls_task = prepared.tls_task;
        let result = tokio::task::spawn_blocking(move || {
            let mut connection = RfbConnection::from_negotiated_stream(
                prepared.stream,
                Duration::from_secs(45),
                VncSecurityPolicy::PreferEncryption,
                DecodeLimits::default(),
                prepared.proto_minor,
                prepared.pending_security,
                prepared.outer_security_type,
            )?;
            let init = connection.authenticate(username.as_deref(), Some(&password))?;
            let security = connection.security_label();
            let encrypted = connection.encrypted();
            connection.set_pixel_format_rgba()?;
            connection.set_encodings(&[
                16,
                5,
                1,
                0,
                ENCODING_DESKTOP_SIZE,
                ENCODING_POINTER_POS,
                ENCODING_X_CURSOR,
                ENCODING_RICH_CURSOR,
            ])?;
            let frame_started = Instant::now();
            connection.request_update(false)?;
            let (rect_count, cursor_shape, pointer_pos) = loop {
                if let ServerMessage::FramebufferUpdate {
                    rects,
                    cursor,
                    pointer_pos,
                } = connection.read_server_message()?
                {
                    break (rects.len(), cursor.is_some(), pointer_pos.is_some());
                }
            };
            let mut writer = connection.take_writer()?;
            let pointer_started = Instant::now();
            let probe_seed = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos();
            let pointer_x = (probe_seed % u32::from(init.width)) as u16;
            let pointer_y = (probe_seed.rotate_left(13) % u32::from(init.height)) as u16;
            writer.send_pointer_event(pointer_x, pointer_y, 0)?;
            writer.request_update(true)?;
            let (pointer_rect_count, pointer_cursor, pointer_position) = loop {
                if let ServerMessage::FramebufferUpdate {
                    rects,
                    cursor,
                    pointer_pos,
                } = connection.read_server_message()?
                {
                    break (rects.len(), cursor.is_some(), pointer_pos);
                }
            };
            Ok::<_, String>((
                init,
                security,
                encrypted,
                rect_count,
                cursor_shape,
                pointer_pos,
                frame_started.elapsed(),
                pointer_rect_count,
                pointer_cursor,
                pointer_position,
                pointer_started.elapsed(),
            ))
        })
        .await
        .unwrap()
        .unwrap();

        println!(
            "connected {}x{} '{}' via {}; first frame rects={} cursor={} pointer_pos={} in {:?}; pointer update rects={} cursor={} pointer_pos={:?} in {:?}",
            result.0.width,
            result.0.height,
            result.0.name,
            result.1,
            result.3,
            result.4,
            result.5,
            result.6,
            result.7,
            result.8,
            result.9,
            result.10,
        );
        assert!(result.2);
        assert!(result.3 > 0 || result.4 || result.5);
        if let Some(task) = tls_task {
            task.abort();
        }
    }
}
