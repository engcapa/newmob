use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::vnc::limits::DecodeLimits;

pub enum QueuedWsOutgoing {
    Control(String),
    Frame(Vec<Vec<u8>>),
}

struct QueueState {
    critical_control: VecDeque<String>,
    control: VecDeque<String>,
    building: Vec<Vec<u8>>,
    building_bytes: usize,
    drop_building: bool,
    latest_frame: Option<Vec<Vec<u8>>>,
    closed: bool,
    dropped_frames: u64,
    high_water_bytes: usize,
}

struct QueueInner {
    state: Mutex<QueueState>,
    wake: Notify,
    limits: DecodeLimits,
}

#[derive(Clone)]
pub struct FrameQueueSender(Arc<QueueInner>);

pub struct FrameQueueReceiver {
    inner: Arc<QueueInner>,
}

impl FrameQueueSender {
    pub fn new(limits: DecodeLimits) -> (Self, FrameQueueReceiver) {
        let inner = Arc::new(QueueInner {
            state: Mutex::new(QueueState {
                critical_control: VecDeque::new(),
                control: VecDeque::new(),
                building: Vec::new(),
                building_bytes: 0,
                drop_building: false,
                latest_frame: None,
                closed: false,
                dropped_frames: 0,
                high_water_bytes: 0,
            }),
            wake: Notify::new(),
            limits,
        });
        (Self(inner.clone()), FrameQueueReceiver { inner })
    }

    pub fn send_control(&self, message: String) -> Result<(), String> {
        if message.len() > self.0.limits.max_relay_message_bytes {
            return Err("VNC relay control message exceeds configured limit".into());
        }
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "VNC output queue poisoned")?;
        if state.closed {
            return Err("VNC output queue closed".into());
        }
        if state.control.len() >= self.0.limits.max_control_queue {
            state.control.pop_front();
        }
        state.control.push_back(message);
        self.0.wake.notify_one();
        Ok(())
    }

    /// Queue connection state that must not be displaced by clipboard or bell
    /// traffic while the frontend is still authenticating the relay.
    pub fn send_critical_control(&self, message: String) -> Result<(), String> {
        if message.len() > self.0.limits.max_relay_message_bytes {
            return Err("VNC relay critical message exceeds configured limit".into());
        }
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "VNC output queue poisoned")?;
        if state.closed {
            return Err("VNC output queue closed".into());
        }
        if state.critical_control.len() >= self.0.limits.max_control_queue {
            return Err("VNC relay critical queue is full".into());
        }
        state.critical_control.push_back(message);
        self.0.wake.notify_one();
        Ok(())
    }

    pub fn push_rect(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > self.0.limits.max_relay_frame_bytes {
            return Err("VNC relay rectangle exceeds configured limit".into());
        }
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "VNC output queue poisoned")?;
        let next = state.building_bytes.saturating_add(bytes.len());
        if next > self.0.limits.max_frame_queue_bytes {
            state.drop_building = true;
            state.building.clear();
            state.building_bytes = 0;
            return Ok(());
        }
        if !state.drop_building {
            state.building_bytes = next;
            state.high_water_bytes = state.high_water_bytes.max(next);
            state.building.push(bytes);
        }
        Ok(())
    }

    /// Finish the logical framebuffer update. Returns true when an older frame
    /// was replaced or the current oversized frame was dropped, so the caller
    /// can request a non-incremental refresh and restore visual consistency.
    pub fn finish_frame(&self) -> Result<bool, String> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "VNC output queue poisoned")?;
        let mut dropped = false;
        if !state.drop_building {
            if state.latest_frame.is_some() {
                state.dropped_frames += 1;
                dropped = true;
            }
            state.latest_frame = Some(std::mem::take(&mut state.building));
        } else {
            state.building.clear();
            state.dropped_frames += 1;
            dropped = true;
        }
        state.building_bytes = 0;
        state.drop_building = false;
        self.0.wake.notify_one();
        Ok(dropped)
    }

    #[cfg(test)]
    pub fn stats(&self) -> (u64, usize) {
        self.0
            .state
            .lock()
            .map(|state| (state.dropped_frames, state.high_water_bytes))
            .unwrap_or_default()
    }
}

impl FrameQueueReceiver {
    pub async fn recv(&self) -> Option<QueuedWsOutgoing> {
        loop {
            let notified = self.inner.wake.notified();
            {
                let Ok(mut state) = self.inner.state.lock() else {
                    return None;
                };
                if let Some(message) = state.critical_control.pop_front() {
                    return Some(QueuedWsOutgoing::Control(message));
                }
                if let Some(message) = state.control.pop_front() {
                    return Some(QueuedWsOutgoing::Control(message));
                }
                if let Some(frame) = state.latest_frame.take() {
                    return Some(QueuedWsOutgoing::Frame(frame));
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl Drop for FrameQueueReceiver {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.closed = true;
            state.critical_control.clear();
            state.control.clear();
            state.building.clear();
            state.latest_frame = None;
        }
        self.inner.wake.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replaces_stale_frames_but_preserves_control() {
        let (tx, rx) = FrameQueueSender::new(DecodeLimits::default());
        tx.push_rect(vec![1]).unwrap();
        tx.finish_frame().unwrap();
        tx.push_rect(vec![2]).unwrap();
        tx.finish_frame().unwrap();
        tx.send_control("status".into()).unwrap();
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Control(v)) if v == "status"));
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Frame(v)) if v == vec![vec![2]]));
        assert_eq!(tx.stats().0, 1);
    }

    #[test]
    fn oversized_frame_is_dropped_with_bounded_memory() {
        let mut limits = DecodeLimits::default();
        limits.max_frame_queue_bytes = 4;
        let (tx, _rx) = FrameQueueSender::new(limits);
        tx.push_rect(vec![0; 5]).unwrap();
        tx.finish_frame().unwrap();
        assert_eq!(tx.stats().0, 1);
    }

    #[tokio::test]
    async fn empty_frame_is_a_valid_update_boundary() {
        let (tx, rx) = FrameQueueSender::new(DecodeLimits::default());
        assert!(!tx.finish_frame().unwrap());
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Frame(v)) if v.is_empty()));
        assert_eq!(tx.stats().0, 0);
    }

    #[tokio::test]
    async fn control_queue_keeps_latest_message_without_blocking() {
        let mut limits = DecodeLimits::default();
        limits.max_control_queue = 2;
        let (tx, rx) = FrameQueueSender::new(limits);
        tx.send_control("old".into()).unwrap();
        tx.send_control("middle".into()).unwrap();
        tx.send_control("latest".into()).unwrap();
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Control(v)) if v == "middle"));
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Control(v)) if v == "latest"));
    }

    #[tokio::test]
    async fn critical_control_survives_normal_control_flood() {
        let mut limits = DecodeLimits::default();
        limits.max_control_queue = 2;
        let (tx, rx) = FrameQueueSender::new(limits);
        tx.send_critical_control("connected".into()).unwrap();
        tx.send_control("old".into()).unwrap();
        tx.send_control("middle".into()).unwrap();
        tx.send_control("latest".into()).unwrap();
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Control(v)) if v == "connected"));
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Control(v)) if v == "middle"));
        assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Control(v)) if v == "latest"));
    }
}
