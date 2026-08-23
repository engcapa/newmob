//! Shared SSH client for SocksCap upstream (one hop, direct-tcpip per flow).

use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, RwLock};

use crate::terminal::ssh::{SshAuth, SshHandler, connect_ssh_authenticated};

/// Backoff bounds for re-establishing a dead transport. The first retry is
/// nearly immediate so a brief blip costs one failed flow; repeated failures
/// back off so an upstream that is genuinely down is not hammered once per
/// captured connection.
const RECONNECT_BACKOFF_MIN: Duration = Duration::from_secs(1);
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Long-lived SSH session used as an upstream for many TCP flows.
///
/// The transport is re-established on demand. Previously it was connected once
/// at capture start and never checked: when it died — a server restart, a NAT
/// idle timeout, a laptop suspending, any network blip — every subsequent
/// proxied flow failed for the rest of the session, with no way back short of
/// stopping and restarting capture. Over a multi-hour run that is close to
/// inevitable.
///
/// Credentials are retained for exactly that reason; they are already resident
/// in the relay context for the lifetime of the capture session.
pub struct SshPool {
    /// Current authenticated transport, or `None` once known to be dead.
    handle: RwLock<Option<Arc<client::Handle<SshHandler>>>>,
    /// Serialises reconnects so a burst of failing flows makes one attempt.
    reconnect: Mutex<ReconnectState>,
    pub host: String,
    pub port: u16,
    username: String,
    auth: SshAuth,
}

#[derive(Default)]
struct ReconnectState {
    /// Earliest time a further attempt is allowed.
    next_attempt: Option<Instant>,
    backoff: Option<Duration>,
}

impl std::fmt::Debug for SshPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshPool")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish()
    }
}

impl SshPool {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        auth: SshAuth,
    ) -> Result<Self, String> {
        let handle = connect_ssh_authenticated(host, port, username, auth.clone()).await?;
        Ok(Self {
            handle: RwLock::new(Some(Arc::new(handle))),
            reconnect: Mutex::new(ReconnectState::default()),
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth,
        })
    }

    /// Open a `direct-tcpip` channel to `dest_host:dest_port` and return an
    /// async stream suitable for bidirectional bridging.
    ///
    /// One reconnect-and-retry: a channel open that fails because the transport
    /// died should not surface to the user as a failed connection when the
    /// upstream is reachable again.
    pub async fn dial(
        &self,
        dest_host: &str,
        dest_port: u16,
        originator: &str,
        originator_port: u16,
    ) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send, String> {
        let first_error = match self.live_handle().await {
            Some(handle) => {
                match open_channel(&handle, dest_host, dest_port, originator, originator_port).await
                {
                    Ok(stream) => return Ok(stream),
                    Err(e) => {
                        self.retire(&handle).await;
                        e
                    }
                }
            }
            None => format!("ssh upstream {}:{} not connected", self.host, self.port),
        };

        let handle = self
            .reconnect()
            .await
            .map_err(|e| format!("{first_error}; {e}"))?;
        match open_channel(&handle, dest_host, dest_port, originator, originator_port).await {
            Ok(stream) => Ok(stream),
            Err(e) => {
                self.retire(&handle).await;
                Err(e)
            }
        }
    }

    /// The current transport, if there is one and it has not closed.
    async fn live_handle(&self) -> Option<Arc<client::Handle<SshHandler>>> {
        let guard = self.handle.read().await;
        let handle = guard.as_ref()?;
        if handle.is_closed() {
            return None;
        }
        Some(Arc::clone(handle))
    }

    /// Forget a transport that failed — but only if it is still the current one,
    /// so a concurrent reconnect's fresh handle is never discarded.
    async fn retire(&self, dead: &Arc<client::Handle<SshHandler>>) {
        let mut guard = self.handle.write().await;
        if guard.as_ref().is_some_and(|h| Arc::ptr_eq(h, dead)) {
            *guard = None;
        }
    }

    async fn reconnect(&self) -> Result<Arc<client::Handle<SshHandler>>, String> {
        let mut state = self.reconnect.lock().await;

        // Another flow may have reconnected while this one waited for the lock.
        if let Some(handle) = self.live_handle().await {
            return Ok(handle);
        }
        if let Some(at) = state.next_attempt {
            let now = Instant::now();
            if now < at {
                return Err(format!(
                    "ssh upstream {}:{} is down; next reconnect attempt in {:?}",
                    self.host,
                    self.port,
                    at - now
                ));
            }
        }

        match connect_ssh_authenticated(&self.host, self.port, &self.username, self.auth.clone())
            .await
        {
            Ok(handle) => {
                let handle = Arc::new(handle);
                *self.handle.write().await = Some(Arc::clone(&handle));
                state.backoff = None;
                state.next_attempt = None;
                tracing::info!(
                    "sockscap: reconnected SSH upstream {}:{}",
                    self.host,
                    self.port
                );
                Ok(handle)
            }
            Err(e) => {
                let next = state
                    .backoff
                    .map(|b| (b * 2).min(RECONNECT_BACKOFF_MAX))
                    .unwrap_or(RECONNECT_BACKOFF_MIN);
                state.backoff = Some(next);
                state.next_attempt = Some(Instant::now() + next);
                Err(format!(
                    "ssh upstream {}:{} reconnect failed ({e}); retrying in {next:?}",
                    self.host, self.port
                ))
            }
        }
    }
}

/// `use<>`: the returned channel stream is owned and borrows nothing. Without
/// it, Rust 2024's capture rules tie the opaque type to the handle reference,
/// which the caller only holds locally.
async fn open_channel(
    handle: &client::Handle<SshHandler>,
    dest_host: &str,
    dest_port: u16,
    originator: &str,
    originator_port: u16,
) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send + use<>, String> {
    let channel = handle
        .channel_open_direct_tcpip(
            dest_host,
            dest_port as u32,
            originator,
            originator_port as u32,
        )
        .await
        .map_err(|e| format!("ssh direct-tcpip {dest_host}:{dest_port}: {e}"))?;
    Ok(channel.into_stream())
}
