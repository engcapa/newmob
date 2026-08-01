use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use prost::Message;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket, UnixStream, lookup_host};
use tokio::time::timeout;

const MAX_FRAME_LEN: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, PartialEq, Message)]
pub struct TunnelInfo {
    #[prost(uint32, optional, tag = "1")]
    pub pid: Option<u32>,
    #[prost(string, optional, tag = "2")]
    pub process_name: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct InterceptConf {
    #[prost(string, repeated, tag = "1")]
    pub actions: Vec<String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct NewFlow {
    #[prost(oneof = "new_flow::Message", tags = "1, 2")]
    pub message: Option<new_flow::Message>,
}

pub mod new_flow {
    use super::{TcpFlow, UdpFlow};
    use prost::Oneof;

    #[derive(Clone, PartialEq, Oneof)]
    pub enum Message {
        #[prost(message, tag = "1")]
        Tcp(TcpFlow),
        #[prost(message, tag = "2")]
        Udp(UdpFlow),
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct TcpFlow {
    #[prost(message, optional, tag = "1")]
    pub remote_address: Option<Address>,
    #[prost(message, optional, tag = "2")]
    pub tunnel_info: Option<TunnelInfo>,
}

#[derive(Clone, PartialEq, Message)]
pub struct UdpFlow {
    #[prost(message, optional, tag = "1")]
    pub local_address: Option<Address>,
    #[prost(message, optional, tag = "3")]
    pub tunnel_info: Option<TunnelInfo>,
}

#[derive(Clone, PartialEq, Message)]
pub struct UdpPacket {
    #[prost(bytes = "bytes", tag = "1")]
    pub data: bytes::Bytes,
    #[prost(message, optional, tag = "2")]
    pub remote_address: Option<Address>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Address {
    #[prost(string, tag = "1")]
    pub host: String,
    #[prost(uint32, tag = "2")]
    pub port: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FlowOutcome {
    TcpRelayed {
        remote: SocketAddr,
        client_to_remote: u64,
        remote_to_client: u64,
    },
    UdpRelayed {
        remote: SocketAddr,
        client_to_remote: u64,
        remote_to_client: u64,
    },
    Udp443Blocked {
        remote: SocketAddr,
    },
    UdpClosedBeforePacket,
}

impl FlowOutcome {
    pub fn describe(&self) -> String {
        match self {
            Self::TcpRelayed {
                remote,
                client_to_remote,
                remote_to_client,
            } => format!(
                "TCP {remote} complete: client→remote={client_to_remote} B, remote→client={remote_to_client} B"
            ),
            Self::UdpRelayed {
                remote,
                client_to_remote,
                remote_to_client,
            } => format!(
                "UDP {remote} complete: client→remote={client_to_remote} datagrams, remote→client={remote_to_client} datagrams"
            ),
            Self::Udp443Blocked { remote } => {
                format!("UDP {remote} blocked (QUIC fallback policy)")
            }
            Self::UdpClosedBeforePacket => "UDP flow closed before its first datagram".to_string(),
        }
    }
}

pub async fn send_intercept_config(stream: &mut UnixStream, actions: Vec<String>) -> Result<()> {
    write_frame(stream, &InterceptConf { actions })
        .await
        .context("failed to send intercept configuration")
}

pub async fn serve_flow(mut stream: UnixStream, block_udp_443: bool) -> Result<FlowOutcome> {
    let flow = read_required_frame::<_, NewFlow>(&mut stream)
        .await
        .context("failed to read NewFlow handshake")?;

    match flow.message {
        Some(new_flow::Message::Tcp(flow)) => relay_tcp(stream, flow).await,
        Some(new_flow::Message::Udp(flow)) => relay_udp(stream, flow, block_udp_443).await,
        None => bail!("NewFlow handshake has no TCP or UDP payload"),
    }
}

async fn relay_tcp(ipc: UnixStream, flow: TcpFlow) -> Result<FlowOutcome> {
    let remote = resolve_address(required_address(
        flow.remote_address.as_ref(),
        "TCP remote",
    )?)
    .await?;
    log_flow("TCP", flow.tunnel_info.as_ref(), remote);

    let upstream = timeout(CONNECT_TIMEOUT, TcpStream::connect(remote))
        .await
        .with_context(|| format!("timed out connecting to TCP target {remote}"))?
        .with_context(|| format!("failed to connect to TCP target {remote}"))?;
    let (ipc_reader, ipc_writer) = ipc.into_split();
    let (upstream_reader, upstream_writer) = upstream.into_split();
    let (client_to_remote, remote_to_client) = tokio::join!(
        copy_until_flow_closed(ipc_reader, upstream_writer),
        copy_until_flow_closed(upstream_reader, ipc_writer),
    );
    let client_to_remote =
        client_to_remote.with_context(|| format!("TCP upload relay failed for {remote}"))?;
    let remote_to_client =
        remote_to_client.with_context(|| format!("TCP download relay failed for {remote}"))?;

    Ok(FlowOutcome::TcpRelayed {
        remote,
        client_to_remote,
        remote_to_client,
    })
}

async fn copy_until_flow_closed<R, W>(mut reader: R, mut writer: W) -> Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = [0u8; 16 * 1024];
    let mut copied = 0u64;
    loop {
        let size = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(size) => size,
            Err(error) if is_normal_flow_teardown(&error) => break,
            Err(error) => return Err(error).context("failed to read relayed TCP bytes"),
        };
        match writer.write_all(&buffer[..size]).await {
            Ok(()) => copied += size as u64,
            Err(error) if is_normal_flow_teardown(&error) => break,
            Err(error) => return Err(error).context("failed to write relayed TCP bytes"),
        }
    }
    match writer.shutdown().await {
        Ok(()) => {}
        Err(error) if is_normal_flow_teardown(&error) => {}
        Err(error) => return Err(error).context("failed to half-close relayed TCP stream"),
    }
    Ok(copied)
}

fn is_normal_flow_teardown(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::BrokenPipe
            | ErrorKind::ConnectionAborted
            | ErrorKind::ConnectionReset
            | ErrorKind::NotConnected
            | ErrorKind::UnexpectedEof
    )
}

async fn relay_udp(mut ipc: UnixStream, flow: UdpFlow, block_udp_443: bool) -> Result<FlowOutcome> {
    let Some(first) = read_optional_frame::<_, UdpPacket>(&mut ipc)
        .await
        .context("failed to read first UDP packet")?
    else {
        return Ok(FlowOutcome::UdpClosedBeforePacket);
    };
    let remote_address = required_address(first.remote_address.as_ref(), "UDP remote")?;
    let remote = resolve_address(remote_address).await?;
    log_flow("UDP", flow.tunnel_info.as_ref(), remote);

    if block_udp_443 && remote.port() == 443 {
        ipc.shutdown().await.ok();
        return Ok(FlowOutcome::Udp443Blocked { remote });
    }

    let bind_address = match remote.ip() {
        IpAddr::V4(_) => "0.0.0.0:0",
        IpAddr::V6(_) => "[::]:0",
    };
    let udp = UdpSocket::bind(bind_address)
        .await
        .with_context(|| format!("failed to bind UDP relay socket on {bind_address}"))?;
    udp.send_to(&first.data, remote)
        .await
        .with_context(|| format!("failed to send first UDP datagram to {remote}"))?;
    let mut client_to_remote = 1;
    let mut remote_to_client = 0;
    let (mut reader, mut writer) = ipc.into_split();
    let mut receive_buf = vec![0u8; 65_535];

    loop {
        tokio::select! {
            packet = read_optional_frame::<_, UdpPacket>(&mut reader) => {
                let Some(packet) = packet.context("failed to read UDP packet from Redirector")? else {
                    break;
                };
                let packet_remote = required_address(packet.remote_address.as_ref(), "UDP remote")?;
                let packet_remote = resolve_address(packet_remote).await?;
                if block_udp_443 && packet_remote.port() == 443 {
                    writer.shutdown().await.ok();
                    return Ok(FlowOutcome::Udp443Blocked { remote: packet_remote });
                }
                udp.send_to(&packet.data, packet_remote)
                    .await
                    .with_context(|| format!("failed to relay UDP datagram to {packet_remote}"))?;
                client_to_remote += 1;
            }
            received = udp.recv_from(&mut receive_buf) => {
                let (size, peer) = received.with_context(|| format!("failed to receive UDP datagram for {remote}"))?;
                let response = UdpPacket {
                    data: bytes::Bytes::copy_from_slice(&receive_buf[..size]),
                    remote_address: Some(address_from_socket(peer)),
                };
                write_frame(&mut writer, &response)
                    .await
                    .context("failed to send UDP response to Redirector")?;
                remote_to_client += 1;
            }
        }
    }

    Ok(FlowOutcome::UdpRelayed {
        remote,
        client_to_remote,
        remote_to_client,
    })
}

fn address_from_socket(address: SocketAddr) -> Address {
    Address {
        host: address.ip().to_string(),
        port: u32::from(address.port()),
    }
}

fn log_flow(protocol: &str, tunnel: Option<&TunnelInfo>, remote: SocketAddr) {
    let pid = tunnel.and_then(|info| info.pid);
    let process = tunnel
        .and_then(|info| info.process_name.as_deref())
        .unwrap_or("<unknown>");
    eprintln!("[flow] {protocol} pid={pid:?} process={process} remote={remote}");
}

fn required_address<'a>(address: Option<&'a Address>, label: &str) -> Result<&'a Address> {
    address.ok_or_else(|| anyhow!("{label} address is missing"))
}

async fn resolve_address(address: &Address) -> Result<SocketAddr> {
    let port = u16::try_from(address.port)
        .with_context(|| format!("port {} does not fit in u16", address.port))?;
    if port == 0 {
        bail!("destination port must not be zero");
    }

    let host = address.host.split('%').next().unwrap_or(&address.host);
    if host.is_empty() {
        bail!("destination host must not be empty");
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }

    lookup_host((host, port))
        .await
        .with_context(|| format!("failed to resolve destination {host}:{port}"))?
        .next()
        .ok_or_else(|| anyhow!("destination {host}:{port} resolved to no addresses"))
}

async fn read_required_frame<R, M>(reader: &mut R) -> Result<M>
where
    R: AsyncRead + Unpin,
    M: Message + Default,
{
    read_optional_frame(reader)
        .await?
        .ok_or_else(|| anyhow!("IPC stream closed before a complete frame"))
}

async fn read_optional_frame<R, M>(reader: &mut R) -> Result<Option<M>>
where
    R: AsyncRead + Unpin,
    M: Message + Default,
{
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error).context("failed to read IPC frame length"),
    }
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_LEN {
        bail!("IPC frame length {length} exceeds {MAX_FRAME_LEN} byte limit");
    }
    let mut bytes = vec![0u8; length];
    reader
        .read_exact(&mut bytes)
        .await
        .context("failed to read IPC frame payload")?;
    M::decode(bytes.as_slice())
        .map(Some)
        .context("failed to decode IPC protobuf frame")
}

async fn write_frame<W, M>(writer: &mut W, message: &M) -> Result<()>
where
    W: AsyncWrite + Unpin,
    M: Message,
{
    let bytes = message.encode_to_vec();
    if bytes.len() > MAX_FRAME_LEN {
        bail!(
            "IPC protobuf payload {} exceeds {MAX_FRAME_LEN} byte limit",
            bytes.len()
        );
    }
    let length = u32::try_from(bytes.len()).context("IPC payload length does not fit in u32")?;
    writer
        .write_all(&length.to_be_bytes())
        .await
        .context("failed to write IPC frame length")?;
    writer
        .write_all(&bytes)
        .await
        .context("failed to write IPC frame payload")?;
    writer.flush().await.context("failed to flush IPC frame")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::{TcpListener, UdpSocket};

    fn address(address: SocketAddr) -> Address {
        address_from_socket(address)
    }

    fn tunnel() -> TunnelInfo {
        TunnelInfo {
            pid: Some(12_345),
            process_name: Some("/tmp/taomni-redirector-probe".to_string()),
        }
    }

    #[test]
    fn intercept_config_matches_upstream_protobuf_wire_format() {
        let conf = InterceptConf {
            actions: vec!["curl".to_string()],
        };
        assert_eq!(conf.encode_to_vec(), b"\x0a\x04curl");
    }

    #[tokio::test]
    async fn tcp_flow_switches_from_framed_handshake_to_raw_relay() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_address = target.local_addr().unwrap();
        let echo = tokio::spawn(async move {
            let (mut stream, _) = target.accept().await.unwrap();
            let mut bytes = [0u8; 4];
            stream.read_exact(&mut bytes).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });

        let (mut client, server) = UnixStream::pair().unwrap();
        let relay = tokio::spawn(serve_flow(server, true));
        let flow = NewFlow {
            message: Some(new_flow::Message::Tcp(TcpFlow {
                remote_address: Some(address(target_address)),
                tunnel_info: Some(tunnel()),
            })),
        };
        write_frame(&mut client, &flow).await.unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut response = [0u8; 4];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"ping");
        client.shutdown().await.unwrap();

        let outcome = relay.await.unwrap().unwrap();
        assert_eq!(
            outcome,
            FlowOutcome::TcpRelayed {
                remote: target_address,
                client_to_remote: 4,
                remote_to_client: 4,
            }
        );
        echo.await.unwrap();
    }

    #[tokio::test]
    async fn udp_flow_relays_framed_datagrams_in_both_directions() {
        let target = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let target_address = target.local_addr().unwrap();
        let echo = tokio::spawn(async move {
            let mut bytes = [0u8; 64];
            let (size, peer) = target.recv_from(&mut bytes).await.unwrap();
            target.send_to(&bytes[..size], peer).await.unwrap();
        });

        let (mut client, server) = UnixStream::pair().unwrap();
        let relay = tokio::spawn(serve_flow(server, true));
        let flow = NewFlow {
            message: Some(new_flow::Message::Udp(UdpFlow {
                local_address: Some(Address {
                    host: "127.0.0.1".to_string(),
                    port: 51_234,
                }),
                tunnel_info: Some(tunnel()),
            })),
        };
        write_frame(&mut client, &flow).await.unwrap();
        write_frame(
            &mut client,
            &UdpPacket {
                data: bytes::Bytes::from_static(b"dns"),
                remote_address: Some(address(target_address)),
            },
        )
        .await
        .unwrap();

        let response = timeout(
            Duration::from_secs(2),
            read_required_frame::<_, UdpPacket>(&mut client),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&response.data[..], b"dns");
        assert_eq!(response.remote_address, Some(address(target_address)));
        client.shutdown().await.unwrap();

        let outcome = relay.await.unwrap().unwrap();
        assert_eq!(
            outcome,
            FlowOutcome::UdpRelayed {
                remote: target_address,
                client_to_remote: 1,
                remote_to_client: 1,
            }
        );
        echo.await.unwrap();
    }

    #[tokio::test]
    async fn udp_443_is_closed_without_opening_an_upstream_socket() {
        let (mut client, server) = UnixStream::pair().unwrap();
        let relay = tokio::spawn(serve_flow(server, true));
        let remote: SocketAddr = "127.0.0.1:443".parse().unwrap();
        let flow = NewFlow {
            message: Some(new_flow::Message::Udp(UdpFlow {
                local_address: None,
                tunnel_info: Some(tunnel()),
            })),
        };
        write_frame(&mut client, &flow).await.unwrap();
        write_frame(
            &mut client,
            &UdpPacket {
                data: bytes::Bytes::from_static(b"quic"),
                remote_address: Some(address(remote)),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            relay.await.unwrap().unwrap(),
            FlowOutcome::Udp443Blocked { remote }
        );
        let mut byte = [0u8; 1];
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn udp_443_is_blocked_when_a_flow_changes_destination() {
        let first_target = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let first_target_address = first_target.local_addr().unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let relay = tokio::spawn(serve_flow(server, true));
        let flow = NewFlow {
            message: Some(new_flow::Message::Udp(UdpFlow {
                local_address: None,
                tunnel_info: Some(tunnel()),
            })),
        };
        write_frame(&mut client, &flow).await.unwrap();
        write_frame(
            &mut client,
            &UdpPacket {
                data: bytes::Bytes::from_static(b"dns-like"),
                remote_address: Some(address(first_target_address)),
            },
        )
        .await
        .unwrap();
        let blocked: SocketAddr = "127.0.0.1:443".parse().unwrap();
        write_frame(
            &mut client,
            &UdpPacket {
                data: bytes::Bytes::from_static(b"quic"),
                remote_address: Some(address(blocked)),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            timeout(Duration::from_secs(2), relay)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            FlowOutcome::Udp443Blocked { remote: blocked }
        );
    }
}
