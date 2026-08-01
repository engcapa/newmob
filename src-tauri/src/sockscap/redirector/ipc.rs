//! Pinned mitmproxy Redirector protobuf/framing contract (v0.12.11).

use std::io::{self, ErrorKind};

use prost::Message;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_LEN: usize = 1024 * 1024;

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
    use prost::Oneof;

    use super::{TcpFlow, UdpFlow};

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

pub async fn write_frame<W, M>(writer: &mut W, message: &M) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    M: Message,
{
    let payload = message.encode_to_vec();
    if payload.len() > MAX_FRAME_LEN {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("Redirector frame is too large: {} bytes", payload.len()),
        ));
    }
    writer.write_u32(payload.len() as u32).await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

pub async fn read_optional_frame<R, M>(reader: &mut R) -> io::Result<Option<M>>
where
    R: AsyncRead + Unpin,
    M: Message + Default,
{
    let len = match reader.read_u32().await {
        Ok(len) => len as usize,
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    };
    if len > MAX_FRAME_LEN {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("Redirector frame length {len} exceeds {MAX_FRAME_LEN}"),
        ));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    M::decode(payload.as_slice())
        .map(Some)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

pub async fn read_required_frame<R, M>(reader: &mut R) -> io::Result<M>
where
    R: AsyncRead + Unpin,
    M: Message + Default,
{
    read_optional_frame(reader).await?.ok_or_else(|| {
        io::Error::new(
            ErrorKind::UnexpectedEof,
            "Redirector connection closed before the required frame",
        )
    })
}

pub async fn send_intercept_config<W>(writer: &mut W, actions: &[String]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    if actions.is_empty() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "Redirector InterceptConf actions must not be empty",
        ));
    }
    write_frame(
        writer,
        &InterceptConf {
            actions: actions.to_vec(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip_matches_length_prefixed_protobuf() {
        let (mut writer, mut reader) = tokio::io::duplex(256);
        let expected = InterceptConf {
            actions: vec!["curl".into(), "!xray".into()],
        };
        let write = tokio::spawn(async move { write_frame(&mut writer, &expected).await });

        let decoded: InterceptConf = read_required_frame(&mut reader).await.unwrap();
        write.await.unwrap().unwrap();
        assert_eq!(decoded.actions, vec!["curl", "!xray"]);
    }

    #[tokio::test]
    async fn empty_intercept_config_is_rejected_before_swift_can_index_it() {
        let (mut writer, _reader) = tokio::io::duplex(64);
        let error = send_intercept_config(&mut writer, &[]).await.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn oversized_frame_is_rejected_without_allocating_payload() {
        let (mut writer, mut reader) = tokio::io::duplex(64);
        let task = tokio::spawn(async move {
            writer.write_u32((MAX_FRAME_LEN + 1) as u32).await.unwrap();
        });
        let error = read_optional_frame::<_, InterceptConf>(&mut reader)
            .await
            .unwrap_err();
        task.await.unwrap();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }
}
