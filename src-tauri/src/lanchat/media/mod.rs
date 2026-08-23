//! LanChat native A/V media engine (v4) — the Linux / no-WebRTC media stack.
//!
//! On webviews without `RTCPeerConnection` (WebKitGTK) the webview-WebRTC path
//! is unavailable, so capture / encode / transport / decode all happen here in
//! Rust and decoded media is delivered to the webview over a per-call loopback
//! WebSocket (video → `<canvas>`, audio → AudioWorklet) — the same direct-render
//! pattern the RDP/VNC viewers already use on WebKitGTK.
//!
//! Wire: real-time frames ride the existing mTLS mesh as `TAG_MEDIA` frames
//! (see `protocol::wire`), on a dedicated drop-oldest queue isolated from file
//! transfer (`transport::send_media`). Negotiation uses the `nmedia-*` control
//! frames relayed through `lanchat://signal`.
//!
//! Build-out is phased (see claudedocs/lanchat-linux-native-av-transport.md):
//! the relay + per-call session + command surface are always compiled; capture
//! and the codecs (Opus / H.264) live behind the `native-av` feature and land in
//! later phases. Forward-declared items carry `#![allow(dead_code)]`, narrowed
//! as phases start using them.
#![allow(dead_code)]

#[cfg(feature = "native-av")]
pub mod audio;
pub mod relay;
#[cfg(feature = "native-av")]
pub mod video;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;
use tokio::sync::{RwLock, mpsc};

use crate::lanchat::LanChatState;
use crate::lanchat::protocol::wire::MediaFrame;

/// An inbound media frame tagged with the peer it came from, for routing inside
/// a call's relay (which fans multiple peers into one webview).
pub struct InboundMedia {
    pub peer_id: String,
    pub frame: MediaFrame,
}

/// Per-call native media session state. Created when a native call starts and
/// stored in `LanChatState.media_sessions` keyed by call id. Owns the loopback
/// WS relay (decoded media → webview) and the set of peers this call exchanges
/// media with; per-peer capture/encode state attaches in later phases.
pub struct NativeMediaSession {
    pub call_id: String,
    /// Inbound media pump: frames arriving over the mesh are forwarded here and
    /// drained by the relay toward the webview.
    inbound_tx: mpsc::UnboundedSender<InboundMedia>,
    /// The loopback WS relay for this call.
    relay: relay::RelayHandle,
    /// Peers we are currently exchanging media with (shared with the audio
    /// encode task so it fans frames to the live set).
    peers: Arc<RwLock<HashSet<String>>>,
    /// Local mic on/off (read by the audio encode task).
    mic_on: Arc<AtomicBool>,
    /// Audio send path (cpal capture + Opus encode); `None` if it failed to
    /// start. Only present with the `native-av` feature.
    #[cfg(feature = "native-av")]
    audio: std::sync::Mutex<Option<audio::AudioSender>>,
    /// Screen-share send path (X11 capture + H.264); `None` when not sharing.
    #[cfg(feature = "native-av")]
    screen: std::sync::Mutex<Option<video::VideoSender>>,
    /// Camera send path (nokhwa + H.264); `None` when the camera is off.
    #[cfg(feature = "native-av")]
    cam: std::sync::Mutex<Option<video::VideoSender>>,
}

impl NativeMediaSession {
    /// Start a session: spawn the loopback WS relay, the audio send path, and
    /// wire the inbound pump into the relay. `state` drives outbound media frames.
    pub async fn start(state: Arc<LanChatState>, call_id: String) -> Result<Arc<Self>, String> {
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let relay = relay::spawn_relay(inbound_rx).await?;
        let peers = Arc::new(RwLock::new(HashSet::new()));
        let mic_on = Arc::new(AtomicBool::new(true));

        #[cfg(feature = "native-av")]
        let audio = match audio::start_audio_sender(
            state.clone(),
            call_id.clone(),
            peers.clone(),
            mic_on.clone(),
        ) {
            Ok(s) => std::sync::Mutex::new(Some(s)),
            Err(e) => {
                log::warn!("lanchat: native audio sender failed to start: {e}");
                std::sync::Mutex::new(None)
            }
        };
        #[cfg(not(feature = "native-av"))]
        let _ = &state; // state is only needed to drive the audio sender

        Ok(Arc::new(Self {
            call_id,
            inbound_tx,
            relay,
            peers,
            mic_on,
            #[cfg(feature = "native-av")]
            audio,
            #[cfg(feature = "native-av")]
            screen: std::sync::Mutex::new(None),
            #[cfg(feature = "native-av")]
            cam: std::sync::Mutex::new(None),
        }))
    }

    /// The loopback WS port the webview connects to for this call.
    pub fn ws_port(&self) -> u16 {
        self.relay.ws_port
    }

    /// Forward an inbound media frame into the relay pump. Cheap and lock-free;
    /// called from the transport read loop hot path.
    pub fn forward_inbound(&self, peer_id: &str, frame: MediaFrame) {
        let _ = self.inbound_tx.send(InboundMedia {
            peer_id: peer_id.to_string(),
            frame,
        });
    }

    /// Register a peer we now exchange media with (the audio task starts fanning
    /// encoded frames to it immediately; an active screen share is nudged to emit
    /// a keyframe so the joiner can decode right away).
    pub async fn add_peer(&self, peer_id: &str) {
        self.peers.write().await.insert(peer_id.to_string());
        #[cfg(feature = "native-av")]
        {
            if let Some(s) = self.screen.lock().unwrap().as_ref() {
                s.request_keyframe();
            }
            if let Some(c) = self.cam.lock().unwrap().as_ref() {
                c.request_keyframe();
            }
        }
    }

    /// Stop exchanging media with a peer and drop its tile in the webview.
    pub async fn remove_peer(&self, peer_id: &str) {
        if self.peers.write().await.remove(peer_id) {
            let _ = self
                .relay
                .control_tx
                .send(relay::RelayControl::PeerRemoved(peer_id.to_string()));
        }
    }

    /// Toggle the local microphone (mutes the outgoing Opus stream).
    pub fn set_mic(&self, on: bool) {
        self.mic_on.store(on, Ordering::Relaxed);
    }

    /// Start or stop screen sharing. `app`/`state` drive the X11 capturer and
    /// the outbound media frames.
    #[cfg(feature = "native-av")]
    pub async fn set_screen(
        &self,
        app: AppHandle,
        state: Arc<LanChatState>,
        on: bool,
    ) -> Result<(), String> {
        if on {
            if self.screen.lock().unwrap().is_some() {
                return Ok(());
            }
            // start_screen_sender is async; do not hold the std mutex across it.
            let sender =
                video::start_screen_sender(app, state, self.call_id.clone(), self.peers.clone())
                    .await?;
            let mut g = self.screen.lock().unwrap();
            if g.is_some() {
                sender.stop(); // lost a race — keep the existing one
            } else {
                *g = Some(sender);
            }
        } else if let Some(s) = self.screen.lock().unwrap().take() {
            s.stop();
        }
        Ok(())
    }

    /// Without the codec feature, native screen share is unavailable.
    #[cfg(not(feature = "native-av"))]
    pub async fn set_screen(
        &self,
        _app: AppHandle,
        _state: Arc<LanChatState>,
        on: bool,
    ) -> Result<(), String> {
        if on {
            Err("native screen share not built in (enable the native-av feature)".into())
        } else {
            Ok(())
        }
    }

    /// Start or stop the camera (nokhwa capture + H.264 to peers).
    #[cfg(feature = "native-av")]
    pub async fn set_cam(&self, state: Arc<LanChatState>, on: bool) -> Result<(), String> {
        if on {
            if self.cam.lock().unwrap().is_some() {
                return Ok(());
            }
            let sender =
                video::start_camera_sender(state, self.call_id.clone(), self.peers.clone()).await?;
            let mut g = self.cam.lock().unwrap();
            if g.is_some() {
                sender.stop();
            } else {
                *g = Some(sender);
            }
        } else if let Some(c) = self.cam.lock().unwrap().take() {
            c.stop();
        }
        Ok(())
    }

    /// Without the codec feature, the native camera is unavailable.
    #[cfg(not(feature = "native-av"))]
    pub async fn set_cam(&self, _state: Arc<LanChatState>, on: bool) -> Result<(), String> {
        if on {
            Err("native camera not built in (enable the native-av feature)".into())
        } else {
            Ok(())
        }
    }

    /// Forward a peer's mic/cam/screen state to the webview.
    pub fn peer_state(&self, peer_id: &str, mic: bool, cam: bool, screen: bool) {
        let _ = self.relay.control_tx.send(relay::RelayControl::PeerState {
            peer_id: peer_id.to_string(),
            mic,
            cam,
            screen,
        });
    }

    /// Tear the session down: stop capture/encoding and cancel the relay.
    pub fn stop(&self) {
        #[cfg(feature = "native-av")]
        {
            if let Some(sender) = self.audio.lock().unwrap().take() {
                sender.stop();
            }
            if let Some(screen) = self.screen.lock().unwrap().take() {
                screen.stop();
            }
            if let Some(cam) = self.cam.lock().unwrap().take() {
                cam.stop();
            }
        }
        self.relay.cancel.cancel();
    }
}

/// Route an inbound `TAG_MEDIA` frame to its call's native media session. No-op
/// (trace log) if no session is registered for the frame's call id — e.g. a
/// late frame after hangup, or a frame for a call this node isn't in.
pub async fn handle_media_frame(
    _app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    frame: MediaFrame,
) {
    let session = state
        .media_sessions
        .read()
        .await
        .get(&frame.session)
        .cloned();
    match session {
        Some(s) => s.forward_inbound(peer_id, frame),
        None => log::trace!(
            "lanchat: media frame for unknown session {} from {peer_id}",
            frame.session
        ),
    }
}
