use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;
use tokio::sync::Notify;

pub struct TransferHandle {
    cancelled: AtomicBool,
    paused: AtomicBool,
    resume: Notify,
}

impl TransferHandle {
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            resume: Notify::new(),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        // wake any waiter so it can observe the cancel.
        self.resume.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.resume.notify_waiters();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Suspends the calling task while the transfer is paused. Returns
    /// immediately if the transfer is cancelled or not paused.
    pub async fn wait_while_paused(&self) {
        while self.is_paused() && !self.is_cancelled() {
            self.resume.notified().await;
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ProgressPayload {
    pub bytes: u64,
    pub total: u64,
    pub rate: f64,
    pub eta: f64,
}

#[derive(Serialize, Clone)]
pub struct CompletePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "finalPath", skip_serializing_if = "Option::is_none")]
    pub final_path: Option<String>,
}

impl CompletePayload {
    pub fn ok(final_path: Option<String>) -> Self {
        Self {
            success: true,
            error: None,
            final_path,
        }
    }
    pub fn err(message: &str) -> Self {
        Self {
            success: false,
            error: Some(message.to_string()),
            final_path: None,
        }
    }
}

pub async fn register(state: &State<'_, AppState>, transfer_id: &str) -> Arc<TransferHandle> {
    let handle = Arc::new(TransferHandle::new());
    let mut transfers = state.transfers.write().await;
    transfers.insert(transfer_id.to_string(), handle.clone());
    handle
}

pub async fn unregister(state: &State<'_, AppState>, transfer_id: &str) {
    let mut transfers = state.transfers.write().await;
    transfers.remove(transfer_id);
}

pub async fn cancel(state: &State<'_, AppState>, transfer_id: &str) {
    let transfers = state.transfers.read().await;
    if let Some(handle) = transfers.get(transfer_id) {
        handle.cancel();
    }
}

pub async fn pause(state: &State<'_, AppState>, transfer_id: &str) {
    let transfers = state.transfers.read().await;
    if let Some(handle) = transfers.get(transfer_id) {
        handle.pause();
    }
}

pub async fn resume(state: &State<'_, AppState>, transfer_id: &str) {
    let transfers = state.transfers.read().await;
    if let Some(handle) = transfers.get(transfer_id) {
        handle.resume();
    }
}

/// Yield to the runtime so a long-running synchronous I/O loop has a chance
/// to interleave with progress emissions. Cheap no-op placeholder.
pub fn touch() {}
