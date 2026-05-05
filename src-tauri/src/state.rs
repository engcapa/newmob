use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::RwLock;

use crate::filebrowser::sftp::ActiveSftp;
use crate::filebrowser::transfer::TransferHandle;
use crate::terminal::ActiveTerminal;
use crate::tunnel::TunnelRegistry;
use crate::vnc::ws::VncSession;

pub struct AppState {
    pub terminals: Arc<RwLock<HashMap<String, ActiveTerminal>>>,
    pub sftp_sessions: Arc<RwLock<HashMap<String, Arc<ActiveSftp>>>>,
    pub transfers: Arc<RwLock<HashMap<String, Arc<TransferHandle>>>>,
    pub tunnels: Arc<TunnelRegistry>,
    pub vnc_sessions: Arc<RwLock<HashMap<String, VncSession>>>,
    pub db: Mutex<rusqlite::Connection>,
}

impl AppState {
    pub fn new(db: rusqlite::Connection) -> Self {
        Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            sftp_sessions: Arc::new(RwLock::new(HashMap::new())),
            transfers: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(TunnelRegistry::new()),
            vnc_sessions: Arc::new(RwLock::new(HashMap::new())),
            db: Mutex::new(db),
        }
    }
}
