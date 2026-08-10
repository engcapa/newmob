use std::time::Duration;

use futures::FutureExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::terminal::network::NetworkSettings;
use crate::terminal::ssh::{SshTransport, build_ssh_transport};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const ROUTED_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
pub const RFB_HANDSHAKE_IO_TIMEOUT: Duration = Duration::from_secs(10);
pub const RFB_RUNTIME_IO_TIMEOUT: Duration = Duration::from_secs(1);

pub struct VncTransport {
    pub stream: std::net::TcpStream,
    pub bridge_task: Option<JoinHandle<Result<(), String>>>,
}

pub async fn open_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
    cancel: &CancellationToken,
) -> Result<VncTransport, String> {
    if host.trim().is_empty() || port == 0 {
        return Err("VNC target host and port are required".to_string());
    }
    let routed =
        network.is_some_and(|settings| !matches!(settings.proxy_kind.as_str(), "" | "none"));
    let deadline = if routed {
        ROUTED_CONNECT_TIMEOUT
    } else {
        CONNECT_TIMEOUT
    };
    let transport = tokio::select! {
        result = tokio::time::timeout(deadline, build_ssh_transport(host, port, network)) => {
            result
                .map_err(|_| format!("VNC transport timed out after {} seconds", deadline.as_secs()))??
        }
        _ = cancel.cancelled() => return Err("VNC transport cancelled".to_string()),
    };

    let base = match transport {
        SshTransport::Tcp(stream) => {
            let stream = stream
                .into_std()
                .map_err(|error| format!("convert VNC TCP transport: {error}"))?;
            configure_stream(&stream)?;
            Ok(VncTransport {
                stream,
                bridge_task: None,
            })
        }
        jump @ SshTransport::Jump { .. } => bridge_async_transport(jump, cancel.clone()).await,
    }?;

    wrap_vencrypt_transport(base, host, cancel.clone()).await
}

/// Keep the RFB engine's cloneable blocking TCP interface while still allowing
/// VeNCrypt to upgrade the server leg to TLS. The bridge inspects only the RFB
/// banner/security selection; all post-selection bytes are copied transparently.
async fn wrap_vencrypt_transport(
    base: VncTransport,
    host: &str,
    cancel: CancellationToken,
) -> Result<VncTransport, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("VNC TLS bridge bind: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("VNC TLS bridge address: {error}"))?;
    let client = tokio::net::TcpStream::connect(address);
    let (client, accepted) = tokio::try_join!(client, listener.accept())
        .map_err(|error| format!("VNC TLS bridge loopback: {error}"))?;
    let client = client
        .into_std()
        .map_err(|error| format!("convert VNC TLS bridge client: {error}"))?;
    configure_stream(&client)?;

    let remote = base.stream;
    let old_bridge = base.bridge_task;
    let worker_cancel = cancel.clone();
    let host = host.to_string();
    remote
        .set_nonblocking(true)
        .map_err(|error| format!("configure VNC TLS bridge remote: {error}"))?;
    let remote = tokio::net::TcpStream::from_std(remote)
        .map_err(|error| format!("convert VNC TLS bridge remote: {error}"))?;
    let bridge_task = tokio::spawn(async move {
        let result = run_vencrypt_bridge(remote, accepted.0, &host, &worker_cancel).await;
        if let Some(task) = old_bridge {
            task.abort();
        }
        result
    });

    Ok(VncTransport {
        stream: client,
        bridge_task: Some(bridge_task),
    })
}

async fn run_vencrypt_bridge(
    mut remote: tokio::net::TcpStream,
    mut local: tokio::net::TcpStream,
    host: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    remote
        .set_nodelay(true)
        .map_err(|error| format!("configure VNC TLS remote TCP_NODELAY: {error}"))?;
    local
        .set_nodelay(true)
        .map_err(|error| format!("configure VNC TLS local TCP_NODELAY: {error}"))?;

    let mut banner = [0u8; 12];
    read_exact_with_cancel(&mut remote, &mut banner, cancel).await?;
    write_all_with_cancel(&mut local, &banner, cancel, "bridge banner to client").await?;
    let mut client_banner = [0u8; 12];
    read_exact_with_cancel(&mut local, &mut client_banner, cancel).await?;
    write_all_with_cancel(
        &mut remote,
        &client_banner,
        cancel,
        "bridge banner to server",
    )
    .await?;

    let minor = std::str::from_utf8(&banner[8..11])
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(3);
    let security_type = if minor <= 3 {
        let mut bytes = [0u8; 4];
        read_exact_with_cancel(&mut remote, &mut bytes, cancel).await?;
        write_all_with_cancel(&mut local, &bytes, cancel, "bridge security type").await?;
        u32::from_be_bytes(bytes)
    } else {
        let mut count = [0u8; 1];
        read_exact_with_cancel(&mut remote, &mut count, cancel).await?;
        write_all_with_cancel(&mut local, &count, cancel, "bridge security count").await?;
        let mut types = vec![0u8; usize::from(count[0])];
        read_exact_with_cancel(&mut remote, &mut types, cancel).await?;
        write_all_with_cancel(&mut local, &types, cancel, "bridge security list").await?;
        let mut chosen = [0u8; 1];
        read_exact_with_cancel(&mut local, &mut chosen, cancel).await?;
        write_all_with_cancel(&mut remote, &chosen, cancel, "bridge security choice").await?;
        chosen[0] as u32
    };

    if security_type != 19 {
        return copy_plain(&mut local, &mut remote, cancel).await;
    }

    let mut version = [0u8; 2];
    read_exact_with_cancel(&mut remote, &mut version, cancel).await?;
    write_all_with_cancel(&mut local, &version, cancel, "bridge VeNCrypt version").await?;
    let mut client_version = [0u8; 2];
    read_exact_with_cancel(&mut local, &mut client_version, cancel).await?;
    write_all_with_cancel(
        &mut remote,
        &client_version,
        cancel,
        "bridge VeNCrypt client version",
    )
    .await?;
    let mut status = [0u8; 1];
    read_exact_with_cancel(&mut remote, &mut status, cancel).await?;
    write_all_with_cancel(&mut local, &status, cancel, "bridge VeNCrypt status").await?;
    if status[0] != 0 {
        return copy_plain(&mut local, &mut remote, cancel).await;
    }

    let mut subtype_count = [0u8; 1];
    read_exact_with_cancel(&mut remote, &mut subtype_count, cancel).await?;
    if subtype_count[0] > 32 {
        return Err("VeNCrypt subtype list exceeds limit".to_string());
    }
    write_all_with_cancel(
        &mut local,
        &subtype_count,
        cancel,
        "bridge VeNCrypt subtype count",
    )
    .await?;
    let mut subtypes = vec![0u8; usize::from(subtype_count[0]) * 4];
    read_exact_with_cancel(&mut remote, &mut subtypes, cancel).await?;
    write_all_with_cancel(&mut local, &subtypes, cancel, "bridge VeNCrypt subtypes").await?;
    let mut chosen = [0u8; 4];
    read_exact_with_cancel(&mut local, &mut chosen, cancel).await?;
    write_all_with_cancel(
        &mut remote,
        &chosen,
        cancel,
        "bridge VeNCrypt subtype choice",
    )
    .await?;
    let subtype = u32::from_be_bytes(chosen);

    if !(260..=262).contains(&subtype) {
        return Err(format!("unsupported VeNCrypt subtype: {subtype}"));
    }

    let connector = native_tls::TlsConnector::builder()
        .build()
        .map_err(|error| format!("TLS connector: {error}"))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let mut tls = tokio::select! {
        result = tokio::time::timeout(RFB_HANDSHAKE_IO_TIMEOUT, connector.connect(host, remote)) => {
            result
                .map_err(|_| "TLS handshake timed out".to_string())?
                .map_err(|error| format!("TLS certificate validation failed: {error}"))?
        }
        _ = cancel.cancelled() => return Err("VNC TLS bridge cancelled".to_string()),
    };
    copy_tls(&mut local, &mut tls, cancel).await
}

async fn read_exact_with_cancel<R: AsyncRead + Unpin>(
    stream: &mut R,
    buffer: &mut [u8],
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::select! {
        result = tokio::time::timeout(RFB_HANDSHAKE_IO_TIMEOUT, stream.read_exact(buffer)) => {
            result
                .map_err(|_| "VNC TLS bridge read timed out".to_string())?
                .map(|_| ())
                .map_err(|error| format!("VNC TLS bridge read: {error}"))
        }
        _ = cancel.cancelled() => Err("VNC TLS bridge cancelled".to_string()),
    }
}

async fn write_all_with_cancel<W: AsyncWrite + Unpin>(
    stream: &mut W,
    buffer: &[u8],
    cancel: &CancellationToken,
    label: &str,
) -> Result<(), String> {
    tokio::select! {
        result = tokio::time::timeout(RFB_HANDSHAKE_IO_TIMEOUT, stream.write_all(buffer)) => {
            result
                .map_err(|_| format!("{label} timed out"))?
                .map_err(|error| format!("{label}: {error}"))
        }
        _ = cancel.cancelled() => Err("VNC TLS bridge cancelled".to_string()),
    }
}

async fn copy_plain(
    local: &mut tokio::net::TcpStream,
    remote: &mut tokio::net::TcpStream,
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::select! {
        result = tokio::io::copy_bidirectional(local, remote) => {
            result
                .map(|_| ())
                .map_err(|error| format!("VNC plain bridge copy failed: {error}"))
        }
        _ = cancel.cancelled() => Ok(()),
    }
}

async fn copy_tls(
    local: &mut tokio::net::TcpStream,
    tls: &mut tokio_native_tls::TlsStream<tokio::net::TcpStream>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::select! {
        result = tokio::io::copy_bidirectional(local, tls) => {
            result
                .map(|_| ())
                .map_err(|error| format!("VNC TLS bridge copy failed: {error}"))
        }
        _ = cancel.cancelled() => Ok(()),
    }
}

async fn bridge_async_transport(
    mut upstream: SshTransport,
    cancel: CancellationToken,
) -> Result<VncTransport, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("VNC jump bridge bind: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("VNC jump bridge address: {error}"))?;
    let client = tokio::net::TcpStream::connect(address);
    let (client, accepted) = tokio::try_join!(
        client,
        listener.accept().map(|result| {
            result
                .map(|pair| pair.0)
                .map_err(|error| std::io::Error::new(error.kind(), format!("accept: {error}")))
        })
    )
    .map_err(|error| format!("VNC jump bridge loopback: {error}"))?;

    let bridge_cancel = cancel.clone();
    let bridge_task = tokio::spawn(async move {
        let mut accepted = accepted;
        tokio::select! {
            result = tokio::io::copy_bidirectional(&mut accepted, &mut upstream) => {
                result
                    .map(|_| ())
                    .map_err(|error| format!("VNC jump bridge ended: {error}"))
            }
            _ = bridge_cancel.cancelled() => Ok(()),
        }
    });

    let stream = client
        .into_std()
        .map_err(|error| format!("convert VNC jump bridge: {error}"))?;
    configure_stream(&stream)?;
    Ok(VncTransport {
        stream,
        bridge_task: Some(bridge_task),
    })
}

fn configure_stream(stream: &std::net::TcpStream) -> Result<(), String> {
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("configure VNC blocking transport: {error}"))?;
    stream
        .set_nodelay(true)
        .map_err(|error| format!("configure VNC TCP_NODELAY: {error}"))?;
    stream
        .set_read_timeout(Some(RFB_HANDSHAKE_IO_TIMEOUT))
        .map_err(|error| format!("configure VNC read deadline: {error}"))?;
    stream
        .set_write_timeout(Some(RFB_HANDSHAKE_IO_TIMEOUT))
        .map_err(|error| format!("configure VNC write deadline: {error}"))
}

pub async fn wait_for_bridge_end(task: &mut Option<JoinHandle<Result<(), String>>>) -> String {
    let Some(task) = task.as_mut() else {
        return std::future::pending::<String>().await;
    };
    match task.await {
        Ok(Ok(())) => "VNC transport bridge closed during handshake".to_string(),
        Ok(Err(error)) => error,
        Err(error) => format!("VNC transport bridge task failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_transport_returns_without_waiting_for_connect_timeout() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        let result = open_transport("192.0.2.1", 5900, None, &cancel).await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn plain_bridge_copies_both_directions_without_read_timeout_latency() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"RFB 003.008\n").await.unwrap();
            let mut banner = [0u8; 12];
            stream.read_exact(&mut banner).await.unwrap();
            assert_eq!(&banner, b"RFB 003.008\n");
            stream.write_all(&[1, 2]).await.unwrap();
            let mut security = [0u8; 1];
            stream.read_exact(&mut security).await.unwrap();
            assert_eq!(security, [2]);
            stream.write_all(b"server-payload").await.unwrap();
            let mut payload = [0u8; 14];
            stream.read_exact(&mut payload).await.unwrap();
            assert_eq!(&payload, b"client-payload");
        });

        let cancel = CancellationToken::new();
        let mut transport = open_transport("127.0.0.1", port, None, &cancel)
            .await
            .unwrap();
        transport.stream.set_nonblocking(true).unwrap();
        let mut client = tokio::net::TcpStream::from_std(transport.stream).unwrap();
        let mut banner = [0u8; 12];
        client.read_exact(&mut banner).await.unwrap();
        client.write_all(&banner).await.unwrap();
        let mut security_types = [0u8; 2];
        client.read_exact(&mut security_types).await.unwrap();
        assert_eq!(security_types, [1, 2]);
        client.write_all(&[2]).await.unwrap();
        let mut payload = [0u8; 14];
        client.read_exact(&mut payload).await.unwrap();
        assert_eq!(&payload, b"server-payload");
        client.write_all(b"client-payload").await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("bridge added read-timeout latency")
            .unwrap();
        cancel.cancel();
        if let Some(task) = transport.bridge_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
        }
    }
}
