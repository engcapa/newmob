//! Single-connection RPC actor.
//!
//! Owns one TCP connection to a RegionServer or Master. After the preamble +
//! ConnectionHeader handshake, a writer task drains a request channel and a
//! reader task decodes response frames, matching them back to callers by
//! `call_id` via an in-flight `oneshot` map. This is the classic tokio actor
//! pattern: callers hold an `RpcConnection` handle (clonable) and `await` a
//! `oneshot` per call.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use bytes::BytesMut;
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, mpsc, oneshot};

use super::super::auth::AuthMethod;
use super::super::proto::pb;
use super::codec::{
    self, CodecError, ResponseFrame, connection_preamble, encode_connection_header, encode_request,
    make_connection_header, try_decode_response,
};

/// An error from an RPC call.
#[derive(Debug, Clone)]
pub enum RpcError {
    /// Transport-level failure (connect/IO/handshake); the connection is dead.
    Transport(String),
    /// The server returned an ExceptionResponse for this call.
    Remote {
        class: String,
        stack: String,
        do_not_retry: bool,
    },
    /// The connection was closed before this call completed.
    Closed,
    /// Frame/protobuf decode failure.
    Decode(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Transport(e) => write!(f, "HBase RPC transport error: {e}"),
            RpcError::Remote { class, stack, .. } => {
                // Surface the simple class name + first line of the trace.
                let short = class.rsplit('.').next().unwrap_or(class);
                let first_line = stack.lines().next().unwrap_or("").trim();
                if first_line.is_empty() {
                    write!(f, "{short}")
                } else {
                    write!(f, "{short}: {first_line}")
                }
            }
            RpcError::Closed => write!(f, "HBase RPC connection closed"),
            RpcError::Decode(e) => write!(f, "HBase RPC decode error: {e}"),
        }
    }
}

impl std::error::Error for RpcError {}

impl RpcError {
    /// Java exception class name, if this is a remote exception.
    pub fn exception_class(&self) -> Option<&str> {
        match self {
            RpcError::Remote { class, .. } => Some(class),
            _ => None,
        }
    }
}

/// A successfully decoded RPC response: the response param bytes (decode into
/// the expected protobuf) and the trailing cell block.
#[derive(Debug)]
pub struct RpcResponse {
    pub param: bytes::Bytes,
    pub cell_block: bytes::Bytes,
}

/// An outgoing request queued to the writer task.
struct Outbound {
    call_id: u32,
    method: String,
    param: Option<Vec<u8>>,
    cell_block: Option<Vec<u8>>,
    reply: oneshot::Sender<Result<RpcResponse, RpcError>>,
}

type InFlight = Arc<Mutex<HashMap<u32, oneshot::Sender<Result<RpcResponse, RpcError>>>>>;

/// A handle to a live RPC connection. Cheap to clone; all clones share the
/// underlying socket and writer task.
#[derive(Clone)]
pub struct RpcConnection {
    tx: mpsc::Sender<Outbound>,
    next_call_id: Arc<AtomicU32>,
    service: String,
    addr: String,
}

impl RpcConnection {
    /// Establish a connection with simple auth (the common case).
    pub async fn connect(
        addr: &str,
        service: &str,
        effective_user: &str,
        connect_timeout: Duration,
    ) -> Result<Self, RpcError> {
        Self::connect_with_auth(
            addr,
            service,
            effective_user,
            &AuthMethod::Simple,
            connect_timeout,
        )
        .await
    }

    /// Establish a connection to `addr` (`host:port`), perform the preamble +
    /// (optional SASL) + ConnectionHeader handshake for `service`
    /// ("ClientService" / "MasterService") as `effective_user`, and spawn the
    /// reader/writer tasks.
    pub async fn connect_with_auth(
        addr: &str,
        service: &str,
        effective_user: &str,
        auth: &AuthMethod,
        connect_timeout: Duration,
    ) -> Result<Self, RpcError> {
        let stream = tokio::time::timeout(connect_timeout, TcpStream::connect(addr))
            .await
            .map_err(|_| RpcError::Transport(format!("connect to {addr} timed out")))?
            .map_err(|e| RpcError::Transport(format!("connect to {addr}: {e}")))?;
        stream
            .set_nodelay(true)
            .map_err(|e| RpcError::Transport(e.to_string()))?;

        let (mut read_half, mut write_half) = stream.into_split();

        // Handshake: preamble + (SASL for Kerberos) + length-delimited
        // ConnectionHeader. No reply on success — the server stays silent until
        // it rejects us.
        let preamble = connection_preamble(auth.preamble_byte());
        write_half
            .write_all(&preamble)
            .await
            .map_err(|e| RpcError::Transport(format!("write preamble: {e}")))?;
        write_half
            .flush()
            .await
            .map_err(|e| RpcError::Transport(format!("flush preamble: {e}")))?;

        // Kerberos: negotiate SASL/GSSAPI before the ConnectionHeader.
        // HBase Java uses `_HOST` as a placeholder in service principals
        // (e.g. `hbase/_HOST@REALM`) that is automatically replaced with
        // the actual hostname of the server being connected to.
        match auth {
            AuthMethod::Simple => {}
            AuthMethod::Kerberos {
                service_principal,
                client_principal,
            } => {
                let resolved_spn = resolve_host_placeholder(service_principal, addr);
                run_sasl(
                    &mut read_half,
                    &mut write_half,
                    &resolved_spn,
                    client_principal.as_deref(),
                )
                .await?;
            }
        }

        let header = make_connection_header(effective_user, service);
        let header_framed = encode_connection_header(&header);
        write_half
            .write_all(&header_framed)
            .await
            .map_err(|e| RpcError::Transport(format!("write ConnectionHeader: {e}")))?;
        write_half
            .flush()
            .await
            .map_err(|e| RpcError::Transport(format!("flush handshake: {e}")))?;

        let in_flight: InFlight = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::channel::<Outbound>(256);

        // Writer task: drain the request channel, register each call, frame &
        // send it. Registration happens here (before send) so the reader can
        // never see a response for an unregistered call.
        {
            let in_flight = in_flight.clone();
            let addr_w = addr.to_string();
            tokio::spawn(async move {
                while let Some(out) = rx.recv().await {
                    let Outbound {
                        call_id,
                        method,
                        param,
                        cell_block,
                        reply,
                    } = out;

                    let cell_len = cell_block.as_ref().map(|c| c.len()).unwrap_or(0);
                    let req_header = pb::RequestHeader {
                        call_id: Some(call_id),
                        trace_info: None,
                        method_name: Some(method),
                        request_param: Some(param.is_some()),
                        cell_block_meta: if cell_len > 0 {
                            Some(pb::CellBlockMeta {
                                length: Some(cell_len as u32),
                            })
                        } else {
                            None
                        },
                        priority: None,
                        timeout: None,
                        attribute: Vec::new(),
                    };
                    let frame =
                        encode_request(&req_header, param.as_deref(), cell_block.as_deref());

                    in_flight.lock().await.insert(call_id, reply);

                    if let Err(e) = write_half.write_all(&frame).await {
                        // Send failed: fail this call and stop the writer.
                        if let Some(reply) = in_flight.lock().await.remove(&call_id) {
                            let _ = reply
                                .send(Err(RpcError::Transport(format!("write to {addr_w}: {e}"))));
                        }
                        break;
                    }
                    if let Err(e) = write_half.flush().await {
                        if let Some(reply) = in_flight.lock().await.remove(&call_id) {
                            let _ = reply
                                .send(Err(RpcError::Transport(format!("flush to {addr_w}: {e}"))));
                        }
                        break;
                    }
                }
                // Channel closed or write failed: drop write_half (closes the
                // socket write side), which makes the reader see EOF.
            });
        }

        // Reader task: decode frames, match by call_id, deliver to waiters.
        {
            let in_flight = in_flight.clone();
            tokio::spawn(async move {
                let mut buf = BytesMut::with_capacity(8192);
                let mut chunk = [0u8; 8192];
                loop {
                    // Drain any complete frames already buffered.
                    loop {
                        match try_decode_response(&mut buf) {
                            Ok(frame) => deliver(&in_flight, frame).await,
                            Err(CodecError::Incomplete) => break,
                            Err(e) => {
                                // Malformed stream: fail everyone and stop.
                                fail_all(&in_flight, RpcError::Decode(e.to_string())).await;
                                return;
                            }
                        }
                    }
                    match read_half.read(&mut chunk).await {
                        Ok(0) => {
                            fail_all(&in_flight, RpcError::Closed).await;
                            return;
                        }
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(e) => {
                            fail_all(&in_flight, RpcError::Transport(e.to_string())).await;
                            return;
                        }
                    }
                }
            });
        }

        Ok(RpcConnection {
            tx,
            next_call_id: Arc::new(AtomicU32::new(0)),
            service: service.to_string(),
            addr: addr.to_string(),
        })
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn addr(&self) -> &str {
        &self.addr
    }

    /// Issue an RPC and await the response. `param` is the serialized request
    /// protobuf; `cell_block` is raw KeyValueCodec bytes (for Put/Mutate).
    pub async fn call(
        &self,
        method: &str,
        param: Option<Vec<u8>>,
        cell_block: Option<Vec<u8>>,
    ) -> Result<RpcResponse, RpcError> {
        let call_id = self.next_call_id.fetch_add(1, Ordering::SeqCst);
        let (reply_tx, reply_rx) = oneshot::channel();
        let out = Outbound {
            call_id,
            method: method.to_string(),
            param,
            cell_block,
            reply: reply_tx,
        };
        self.tx.send(out).await.map_err(|_| RpcError::Closed)?;
        reply_rx.await.map_err(|_| RpcError::Closed)?
    }

    /// Convenience: issue an RPC whose param is a prost message and decode the
    /// response into `T`.
    pub async fn call_pb<Req: Message, T: Message + Default>(
        &self,
        method: &str,
        req: &Req,
        cell_block: Option<Vec<u8>>,
    ) -> Result<(T, bytes::Bytes), RpcError> {
        let resp = self
            .call(method, Some(req.encode_to_vec()), cell_block)
            .await?;
        let decoded = T::decode(resp.param.clone()).map_err(|e| RpcError::Decode(e.to_string()))?;
        Ok((decoded, resp.cell_block))
    }
}

/// Deliver one decoded response frame to its waiting caller.
async fn deliver(in_flight: &InFlight, frame: ResponseFrame) {
    let Some(call_id) = frame.header.call_id else {
        return; // can't route without a call id
    };
    let reply = in_flight.lock().await.remove(&call_id);
    let Some(reply) = reply else {
        return; // no waiter (already failed/timed out)
    };
    let result = if let Some(exc) = frame.header.exception {
        Err(RpcError::Remote {
            class: exc.exception_class_name.unwrap_or_default(),
            stack: exc.stack_trace.unwrap_or_default(),
            do_not_retry: exc.do_not_retry.unwrap_or(false),
        })
    } else {
        Ok(RpcResponse {
            param: frame.param,
            cell_block: frame.cell_block,
        })
    };
    let _ = reply.send(result);
}

/// Fail every in-flight call with `err` (connection died).
async fn fail_all(in_flight: &InFlight, err: RpcError) {
    let mut map = in_flight.lock().await;
    for (_, reply) in map.drain() {
        let _ = reply.send(Err(err.clone()));
    }
}

// Keep codec helper referenced even if higher layers haven't wired it yet.
#[allow(unused_imports)]
use codec as _codec;

/// Run the SASL/GSSAPI negotiation. Requires the `hbase-kerberos` feature.
#[cfg(feature = "hbase-kerberos")]
async fn run_sasl(
    read: &mut tokio::net::tcp::OwnedReadHalf,
    write: &mut tokio::net::tcp::OwnedWriteHalf,
    service_principal: &str,
    client_principal: Option<&str>,
) -> Result<(), RpcError> {
    let ok = super::super::auth::kerberos::sasl_connect(
        read,
        write,
        service_principal,
        client_principal,
    )
    .await
    .map_err(RpcError::Transport)?;
    if !ok {
        return Err(RpcError::Transport(
            "server requested fallback to simple auth, but Kerberos was configured".into(),
        ));
    }
    Ok(())
}

#[cfg(not(feature = "hbase-kerberos"))]
async fn run_sasl(
    _read: &mut tokio::net::tcp::OwnedReadHalf,
    _write: &mut tokio::net::tcp::OwnedWriteHalf,
    _service_principal: &str,
    _client_principal: Option<&str>,
) -> Result<(), RpcError> {
    Err(RpcError::Transport(
        "Kerberos auth requires building taomni with the `hbase-kerberos` feature".into(),
    ))
}

/// Replace the `_HOST` placeholder in a Kerberos service principal with the
/// actual hostname extracted from `addr` (`host:port`).
///
/// HBase Java uses `_HOST` as a convention in `hbase.regionserver.kerberos.principal`
/// (e.g. `hbase/_HOST@REALM`). At connect time the Java client substitutes the
/// real server hostname. We mirror that behavior here so users can configure
/// `hbase/_HOST@REALM` once and have it work for every RegionServer/Master.
fn resolve_host_placeholder(spn: &str, addr: &str) -> String {
    if !spn.contains("_HOST") {
        return spn.to_string();
    }
    // addr is "host:port"; extract just the host part.
    let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr);
    spn.replace("_HOST", host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_host_replaces_placeholder() {
        assert_eq!(
            resolve_host_placeholder(
                "hbase/_HOST@EMR.367593.COM",
                "emr-header-1.cluster-367593:16000"
            ),
            "hbase/emr-header-1.cluster-367593@EMR.367593.COM"
        );
    }

    #[test]
    fn resolve_host_no_placeholder_unchanged() {
        assert_eq!(
            resolve_host_placeholder("hbase/myhost@REALM", "otherhost:16000"),
            "hbase/myhost@REALM"
        );
    }

    #[test]
    fn resolve_host_bare_addr_no_port() {
        assert_eq!(
            resolve_host_placeholder("hbase/_HOST@R", "myhost"),
            "hbase/myhost@R"
        );
    }
}
