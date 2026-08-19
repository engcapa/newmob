//! LanChat — decentralized LAN messenger module (飞鸽传书-style, modernized).
//!
//! Peer-to-peer, no central server: nodes discover each other on the LAN via
//! mDNS/DNS-SD and connect directly over a length-prefixed JSON TCP control
//! channel. This module owns discovery, transport, the wire protocol, local
//! SQLite persistence, and the Tauri command surface.
//!
//! Naming is deliberately kept distinct from the AI-assistant `chat`/`voice`
//! modules: backend `lanchat`, command prefix `lanchat_*`, events `lanchat://*`,
//! SQLite file `lanchat.sqlite`.
//!
//! Build-out is phased; each submodule's doc notes which phase fills it in.

pub mod beacon;
pub mod commands;
pub mod discovery;
pub mod identity;
pub mod media;
pub mod messaging;
pub mod protocol;
pub mod store;
pub mod swarm;
pub mod tls;
pub mod transfer;
pub mod transport;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU16};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use mdns_sd::ServiceDaemon;
use tauri::AppHandle;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::module_lock::ModuleLock;
use protocol::PeerRecord;

const MSG_KEY_VAULT_ID: &str = "lanchat.message-key-v1";
const IDENTITY_KEY_VAULT_ID: &str = "lanchat.identity-key-v1";

pub struct LanChatCrypto {
    pub tls_server: Arc<rustls::ServerConfig>,
    pub tls_client: Arc<rustls::ClientConfig>,
}

/// Tauri event channel names emitted to the frontend (all windows).
pub mod events {
    /// Full roster snapshot (`Vec<PeerRecord>`) after a debounced change.
    pub const ROSTER: &str = "lanchat://roster";
    /// A new or updated message (`LanMessage`); the UI upserts by id.
    pub const MESSAGE: &str = "lanchat://message";
    /// A conversation whose unread count / last activity changed.
    pub const CONVERSATION: &str = "lanchat://conversation";
    /// A group whose membership/name changed (`Group`).
    pub const GROUP: &str = "lanchat://group";
    /// An inbound file offer awaiting accept/reject.
    pub const FILE_OFFER: &str = "lanchat://file-offer";
    /// A transfer progress / state update (`TransferProgress`).
    pub const TRANSFER: &str = "lanchat://transfer";
    /// A WebRTC signaling frame from a peer (`{from,type,payload}`).
    pub const SIGNAL: &str = "lanchat://signal";
    /// A whiteboard frame from a peer (`{from,type,payload}`).
    pub const WB: &str = "lanchat://wb";
    /// A security event: a peer's presented identity was rejected (spoofed id or
    /// a changed pinned key). Payload `{ peerId, addr, kind }`.
    pub const SECURITY: &str = "lanchat://security";
    /// Service lifecycle change. Payload `{ running: bool }`. Emitted when the
    /// background service starts (boot autostart or manual enable) so every
    /// window can switch the panel from "not enabled" to live.
    pub const SERVICE: &str = "lanchat://service";
}

/// Shared LanChat runtime state, held by `AppState.lanchat`.
///
/// The backend owns all live P2P state here; frontend windows (main or
/// detached) are pure views that subscribe to `lanchat://*` events and call
/// `lanchat_*` commands. Fields are populated as later phases land.
pub struct LanChatState {
    /// Path to the per-app `lanchat.sqlite` (schema created on open).
    pub db_path: PathBuf,
    /// SQLite-backed persistence (profile / peers / groups / messages).
    pub store: store::LanChatStore,
    /// Master-password-backed crypto state. This is initialized lazily after the
    /// vault is unlocked so app startup never touches macOS Keychain.
    pub crypto: RwLock<Option<Arc<LanChatCrypto>>>,
    init_lock: AsyncMutex<()>,
    /// This node's stable identity. Empty until the vault-backed identity is
    /// initialized; may be prefilled from the cached profile row for status UI.
    pub node_id: RwLock<String>,
    /// Whether the background service (discovery + transport + beacon) has been
    /// started. A one-way latch: set true on first `start_service`, never
    /// cleared while the app runs (there is no runtime "stop"). Guards against
    /// double-start when both boot-autostart and a manual enable race.
    pub running: AtomicBool,
    /// Cross-process ownership of the stable LanChat node identity, discovery
    /// advertisements, listeners, and SQLite-backed message service.
    _service_lock: StdMutex<Option<ModuleLock>>,
    /// Peers discovered via mDNS, keyed by node id.
    pub peers: RwLock<HashMap<String, PeerRecord>>,
    /// Live control-channel connections, keyed by remote node id.
    pub connections: RwLock<HashMap<String, transport::ConnHandle>>,
    /// mDNS service daemon handle (set when discovery starts). Cloneable; kept
    /// so profile edits can re-announce the TXT record.
    pub daemon: StdMutex<Option<ServiceDaemon>>,
    /// TCP control-channel port (reserved at startup, advertised in mDNS TXT).
    pub control_port: AtomicU16,
    /// Reserved control listener, handed to the transport accept loop (phase 4).
    pub control_listener: AsyncMutex<Option<TcpListener>>,
    /// Active swarm transfers (origin seeds + leeches), keyed by content file id.
    pub swarms: RwLock<HashMap<String, std::sync::Arc<swarm::SwarmFile>>>,
    /// Inbound offers awaiting the local user's accept/reject, by file id.
    pub swarm_offers: RwLock<HashMap<String, swarm::OfferInfo>>,
    /// Active native A/V media sessions (Linux / no-WebRTC stack), keyed by call
    /// id. Empty on the WebRTC stack (Win/mac route media through the webview).
    pub media_sessions: RwLock<HashMap<String, std::sync::Arc<media::NativeMediaSession>>>,
}

impl LanChatState {
    /// Build state, opening `lanchat.sqlite` without loading any secret material.
    /// The SQLite file lives alongside the main `taomni.db` but is separate.
    pub fn new(app_data_dir: &Path) -> Self {
        let db_path = app_data_dir.join("lanchat.sqlite");
        let store = store::LanChatStore::open(&db_path).expect("failed to open lanchat.sqlite");
        let node_id = store
            .get_profile_id_and_cert()
            .ok()
            .flatten()
            .map(|(id, _)| id)
            .unwrap_or_default();
        Self {
            db_path,
            store,
            crypto: RwLock::new(None),
            init_lock: AsyncMutex::new(()),
            node_id: RwLock::new(node_id),
            running: AtomicBool::new(false),
            _service_lock: StdMutex::new(None),
            peers: RwLock::new(HashMap::new()),
            connections: RwLock::new(HashMap::new()),
            daemon: StdMutex::new(None),
            control_port: AtomicU16::new(0),
            control_listener: AsyncMutex::new(None),
            swarms: RwLock::new(HashMap::new()),
            swarm_offers: RwLock::new(HashMap::new()),
            media_sessions: RwLock::new(HashMap::new()),
        }
    }

    /// This node's stable id.
    pub async fn node_id(&self) -> String {
        self.node_id.read().await.clone()
    }

    pub async fn crypto(&self) -> Result<Arc<LanChatCrypto>, String> {
        self.crypto
            .read()
            .await
            .clone()
            .ok_or_else(|| crate::vault::ERR_VAULT_LOCKED.to_string())
    }

    pub async fn ensure_unlocked(&self, vault: &crate::vault::Vault) -> Result<(), String> {
        if self.crypto.read().await.is_some() {
            return Ok(());
        }

        let _guard = self.init_lock.lock().await;
        if self.crypto.read().await.is_some() {
            return Ok(());
        }

        let message_key = match self.load_vault_bytes(vault, MSG_KEY_VAULT_ID)? {
            Some(key) => key,
            None => {
                let mut key = vec![0u8; crate::vault::crypto::KEY_LEN];
                rand::fill(key.as_mut_slice());
                self.save_vault_bytes(
                    vault,
                    MSG_KEY_VAULT_ID,
                    "lanchat_secret",
                    "LanChat Message Key",
                    &key,
                )?;
                Zeroizing::new(key)
            }
        };
        self.store.set_message_key(message_key.as_slice());
        match self.store.migrate_message_encryption() {
            Ok(n) if n > 0 => log::info!("lanchat: encrypted {n} legacy message(s) at rest"),
            Ok(_) => {}
            Err(e) => log::warn!("lanchat: message encryption migration failed: {e}"),
        }

        let stored_identity_key = self.load_vault_bytes(vault, IDENTITY_KEY_VAULT_ID)?;
        let (identity, generated) = identity::ensure(&self.store, stored_identity_key)
            .map_err(|e| format!("initialize lanchat identity: {e}"))?;
        if generated {
            self.save_vault_bytes(
                vault,
                IDENTITY_KEY_VAULT_ID,
                "lanchat_secret",
                "LanChat Identity Key",
                identity.key_der.as_slice(),
            )?;
        }

        let node_id = identity.node_id.clone();
        let tls_server = tls::server_config(&identity).expect("build lanchat server TLS config");
        let tls_client = tls::client_config(&identity).expect("build lanchat client TLS config");
        log::info!("lanchat: node identity {}", node_id);
        *self.node_id.write().await = node_id;
        *self.crypto.write().await = Some(Arc::new(LanChatCrypto {
            tls_server,
            tls_client,
        }));
        Ok(())
    }

    fn load_vault_bytes(
        &self,
        vault: &crate::vault::Vault,
        id: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let Some(encoded) = vault.get_fixed(id)? else {
            return Ok(None);
        };
        BASE64
            .decode(encoded.trim())
            .map(Zeroizing::new)
            .map(Some)
            .map_err(|e| format!("decode lanchat vault secret: {e}"))
    }

    fn save_vault_bytes(
        &self,
        vault: &crate::vault::Vault,
        id: &str,
        kind: &str,
        label: &str,
        secret: &[u8],
    ) -> Result<(), String> {
        vault.put_fixed(id, kind, label, &BASE64.encode(secret))
    }

    /// Number of peers currently in the live roster.
    pub async fn peer_count(&self) -> usize {
        self.peers.read().await.len()
    }
}

/// Launch the LanChat background service (idempotent, one-way).
///
/// Reserves the TCP control port, starts the transport accept loop over that
/// listener, then starts mDNS discovery. Discovery + transport run concurrently
/// for the lifetime of the app — there is no runtime "stop"; the only way to
/// go dark is to not start (see the `start_on_launch` policy) or quit the app.
///
/// Safe to call more than once: the first call latches `running` and proceeds;
/// later calls return immediately. This lets boot-autostart and a manual
/// `lanchat_start_service` from the UI race without double-binding the port.
pub async fn start_service(app: AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::{Emitter, Manager};

    let app_state = app.state::<crate::state::AppState>();
    let lanchat = app_state.lanchat.clone();
    let vault = app_state.vault.clone();
    let app_data_dir = lanchat
        .db_path
        .parent()
        .ok_or_else(|| "resolve LanChat app data directory".to_string())?;

    // One-way latch: if already started, do nothing.
    if lanchat.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let process_lock =
        match ModuleLock::try_acquire(app_data_dir, "lanchat", "service", "LanChat service") {
            Ok(lock) => lock,
            Err(error) => {
                lanchat.running.store(false, Ordering::SeqCst);
                let _ = app.emit(
                    events::SERVICE,
                    serde_json::json!({ "running": false, "error": error.clone() }),
                );
                return Err(error);
            }
        };

    // Initialize the stable identity only while this process owns the service.
    // This avoids two fresh instances racing to generate different node keys.
    if let Err(e) = lanchat.ensure_unlocked(&vault).await {
        log::warn!("lanchat: service start skipped; vault is not ready ({e})");
        let error = format!("LanChat vault is not ready: {e}");
        lanchat.running.store(false, Ordering::SeqCst);
        let _ = app.emit(
            events::SERVICE,
            serde_json::json!({ "running": false, "error": error.clone() }),
        );
        return Err(error);
    }

    // Reserve an ephemeral control port now so the mDNS TXT can advertise it;
    // the transport accept loop takes over this listener below.
    match TcpListener::bind(("0.0.0.0", 0)).await {
        Ok(listener) => {
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            lanchat.control_port.store(port, Ordering::SeqCst);
            *lanchat.control_listener.lock().await = Some(listener);
            *lanchat
                ._service_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(process_lock);
            log::info!("lanchat: reserved control port {}", port);

            // Announce the service is now live to every window.
            let _ = app.emit(events::SERVICE, serde_json::json!({ "running": true }));

            // Transport accept loop (takes the reserved listener).
            let app_t = app.clone();
            let state_t = lanchat.clone();
            tokio::spawn(async move {
                transport::run_listener(app_t, state_t).await;
            });

            // UDP broadcast beacon discovery (fallback for WiFi multicast suppression).
            let app_b = app.clone();
            let state_b = lanchat.clone();
            tokio::spawn(async move {
                beacon::run(app_b, state_b, port).await;
            });

            // Historic peer reconnection (in background, delayed slightly).
            let app_r = app.clone();
            let state_r = lanchat.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                // 7 days in ms
                let recent = state_r.store.list_recent_peers(7 * 24 * 3600 * 1000);
                for peer in recent {
                    if state_r.connections.read().await.contains_key(&peer.id) {
                        continue;
                    }
                    if let (Some(addr), Some(p)) = (&peer.addr, peer.port) {
                        log::info!(
                            "lanchat: reconnecting to historic peer {} ({}:{})",
                            peer.name,
                            addr,
                            p
                        );
                        if let Err(e) =
                            transport::ensure_connection(&app_r, &state_r, &peer.id).await
                        {
                            log::debug!("lanchat: historic reconnect to {} failed: {}", peer.id, e);
                        }
                    }
                }
            });

            // Periodic retention cleanup: sweep on startup and every 6 hours.
            let state_c = lanchat.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
                loop {
                    interval.tick().await; // fires immediately on the first iteration
                    match state_c.store.apply_retention() {
                        Ok(n) if n > 0 => {
                            log::info!("lanchat: retention removed {n} message(s)");
                            let _ = state_c.store.vacuum();
                        }
                        Ok(_) => {}
                        Err(e) => log::warn!("lanchat: retention sweep failed: {e}"),
                    }
                }
            });

            // mDNS discovery (runs for the app lifetime).
            tokio::spawn(async move {
                discovery::run(app, lanchat, port).await;
            });
            Ok(())
        }
        Err(e) => {
            let error = format!("LanChat failed to reserve control port: {e}");
            log::error!("lanchat: {error}");
            // Roll back the latch so a later manual enable can retry.
            lanchat.running.store(false, Ordering::SeqCst);
            let _ = app.emit(
                events::SERVICE,
                serde_json::json!({ "running": false, "error": error.clone() }),
            );
            Err(error)
        }
    }
}
