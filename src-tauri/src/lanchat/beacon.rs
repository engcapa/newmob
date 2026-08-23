//! UDP broadcast beacon — fallback peer discovery for mDNS-hostile networks.
//!
//! Many WiFi access points suppress multicast frames (IGMP snooping, power-save
//! proxy, or AP isolation). This breaks mDNS-based discovery. UDP broadcast to
//! `255.255.255.255` uses L2 broadcast which APs cannot filter without also
//! breaking DHCP and ARP — making it a reliable fallback channel.
//!
//! The beacon periodically transmits a compact JSON payload containing this
//! node's identity and control-channel port. Peers parse incoming beacons,
//! filter their own, and merge discovered nodes into the shared roster. Roster
//! emission is debounced through the same `emit_roster` path used by mDNS
//! discovery.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::lanchat::LanChatState;
use crate::lanchat::protocol::{self, PeerRecord, PresenceStatus};

/// Fixed UDP port for beacon traffic.
const BEACON_PORT: u16 = 19816;

/// How often each node broadcasts its beacon.
const BEACON_INTERVAL: Duration = Duration::from_secs(5);

/// Maximum datagram size we expect (beacons are small JSON, well under 1 KiB).
const MAX_BEACON_SIZE: usize = 2048;

/// Compact beacon payload broadcast over UDP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BeaconPayload {
    /// Node identity (same uuid used everywhere in LanChat).
    pub id: String,
    /// Display name from the profile.
    pub name: String,
    /// TCP control-channel port the node is listening on.
    pub port: u16,
    /// Protocol version (see [`protocol::PROTOCOL_VERSION`]).
    pub pv: u32,
}

/// Create a `tokio::net::UdpSocket` bound to `0.0.0.0:BEACON_PORT` with
/// `SO_REUSEADDR` + `SO_BROADCAST` set *before* binding. We use `socket2` for
/// the pre-bind option dance, then convert via std → tokio.
fn make_socket() -> std::io::Result<tokio::net::UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};

    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    sock.set_broadcast(true)?;
    sock.set_nonblocking(true)?;

    let bind_addr: SocketAddr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, BEACON_PORT).into();
    sock.bind(&bind_addr.into())?;

    let std_sock: std::net::UdpSocket = sock.into();
    tokio::net::UdpSocket::from_std(std_sock)
}

/// Build a [`BeaconPayload`] from the current profile stored in `state`.
fn build_payload(state: &LanChatState, control_port: u16) -> Option<BeaconPayload> {
    let profile = match state.store.get_profile() {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::warn!("beacon: profile not initialized, skipping beacon");
            return None;
        }
        Err(e) => {
            log::warn!("beacon: failed to read profile: {e}");
            return None;
        }
    };
    Some(BeaconPayload {
        id: profile.id,
        name: profile.name,
        port: control_port,
        pv: protocol::PROTOCOL_VERSION,
    })
}

/// Run the UDP beacon: broadcasts this node's presence and listens for peers.
///
/// Spawns two cooperating tasks (sender + receiver) and runs until cancelled.
/// If the beacon socket cannot be opened the function logs an error and returns
/// without crashing the app.
pub async fn run(app: AppHandle, state: Arc<LanChatState>, control_port: u16) {
    let socket = match make_socket() {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log::error!("beacon: failed to bind UDP port {BEACON_PORT}: {e}");
            return;
        }
    };
    log::info!("beacon: listening on 0.0.0.0:{BEACON_PORT}");

    let my_id = state.node_id().await;

    // --- sender task ---
    let send_socket = socket.clone();
    let send_state = state.clone();
    let sender = tokio::spawn(async move {
        let broadcast_dest: SocketAddr = SocketAddrV4::new(Ipv4Addr::BROADCAST, BEACON_PORT).into();
        let mut interval = tokio::time::interval(BEACON_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            interval.tick().await;

            let payload = match build_payload(&send_state, control_port) {
                Some(p) => p,
                None => continue,
            };
            let bytes = match serde_json::to_vec(&payload) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("beacon: failed to serialize payload: {e}");
                    continue;
                }
            };

            // Primary: limited broadcast (crosses all local subnets).
            if let Err(e) = send_socket.send_to(&bytes, broadcast_dest).await {
                log::debug!("beacon: send to 255.255.255.255 failed: {e}");
            }

            // Directed broadcasts per NIC (some OS / firewall configs block
            // limited broadcast but allow directed subnet broadcast).
            for dest in subnet_broadcasts() {
                let addr: SocketAddr = SocketAddrV4::new(dest, BEACON_PORT).into();
                if let Err(e) = send_socket.send_to(&bytes, addr).await {
                    log::debug!("beacon: send to {dest} failed: {e}");
                }
            }
        }
    });

    // --- receiver task ---
    let recv_socket = socket.clone();
    let recv_state = state.clone();
    let recv_app = app.clone();
    let recv_my_id = my_id.clone();
    let receiver = tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_BEACON_SIZE];
        let mut dirty = false;
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                result = recv_socket.recv_from(&mut buf) => {
                    match result {
                        Ok((len, src)) => {
                            if let Err(e) = handle_beacon(
                                &buf[..len],
                                src,
                                &recv_my_id,
                                &recv_state,
                                &mut dirty,
                            ).await {
                                log::debug!("beacon: bad datagram from {src}: {e}");
                            }
                        }
                        Err(e) => {
                            log::warn!("beacon: recv error: {e}");
                        }
                    }
                }
                _ = ticker.tick() => {
                    if dirty {
                        crate::lanchat::discovery::emit_roster(&recv_app, &recv_state).await;
                        dirty = false;
                    }
                }
            }
        }
    });

    // Run both tasks; if either exits the other is cancelled.
    tokio::select! {
        _ = sender => { log::info!("beacon: sender task exited"); }
        _ = receiver => { log::info!("beacon: receiver task exited"); }
    }
}

/// Process one received beacon datagram.
async fn handle_beacon(
    data: &[u8],
    src: SocketAddr,
    my_id: &str,
    state: &LanChatState,
    dirty: &mut bool,
) -> Result<(), String> {
    let payload: BeaconPayload =
        serde_json::from_slice(data).map_err(|e| format!("json parse: {e}"))?;

    // Ignore our own beacons.
    if payload.id == my_id {
        return Ok(());
    }

    let src_ip = match src {
        SocketAddr::V4(v4) => v4.ip().to_string(),
        SocketAddr::V6(v6) => v6.ip().to_string(),
    };

    let peer = PeerRecord {
        id: payload.id.clone(),
        name: payload.name,
        avatar_hash: None,
        signature: String::new(),
        status: PresenceStatus::Online,
        last_seen: chrono::Utc::now().timestamp_millis(),
        addr: Some(src_ip),
        port: Some(payload.port),
    };

    let _ = state.store.store_peer(&peer);
    state.peers.write().await.insert(peer.id.clone(), peer);
    *dirty = true;

    Ok(())
}

/// Compute the directed broadcast address for each non-loopback IPv4 interface.
///
/// Falls back to an empty list if `if-addrs` fails — the limited broadcast
/// (`255.255.255.255`) is always sent regardless.
fn subnet_broadcasts() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|iface| {
            match iface.addr {
                if_addrs::IfAddr::V4(ref v4) => {
                    let ip: u32 = u32::from(v4.ip);
                    let mask: u32 = u32::from(v4.netmask);
                    // Broadcast = ip | !mask
                    let bcast = ip | !mask;
                    Some(Ipv4Addr::from(bcast))
                }
                _ => None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beacon_payload_round_trip() {
        let payload = BeaconPayload {
            id: "9f28a22a-1dea-35f0-93b0-aa84762457bb".into(),
            name: "赵敏".into(),
            port: 4711,
            pv: protocol::PROTOCOL_VERSION,
        };
        let bytes = serde_json::to_vec(&payload).expect("serialize");
        let back: BeaconPayload = serde_json::from_slice(&bytes).expect("deserialize");
        assert_eq!(payload, back);
    }

    #[test]
    fn beacon_payload_json_fields() {
        let payload = BeaconPayload {
            id: "node-1".into(),
            name: "Alice".into(),
            port: 12345,
            pv: 1,
        };
        let json: serde_json::Value = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["id"], "node-1");
        assert_eq!(json["name"], "Alice");
        assert_eq!(json["port"], 12345);
        assert_eq!(json["pv"], 1);
        // Ensure no extra fields leak.
        assert_eq!(json.as_object().unwrap().len(), 4);
    }

    #[test]
    fn beacon_payload_ignores_unknown_fields() {
        let json = r#"{"id":"x","name":"Y","port":80,"pv":1,"extra":"ignored"}"#;
        let p: Result<BeaconPayload, _> = serde_json::from_str(json);
        // With default serde settings unknown fields are silently ignored.
        assert!(p.is_ok());
        assert_eq!(p.unwrap().id, "x");
    }

    #[test]
    fn subnet_broadcasts_does_not_panic() {
        // Smoke test: should not panic regardless of host network config.
        let addrs = subnet_broadcasts();
        // On CI / containers there may be zero non-loopback interfaces.
        for addr in &addrs {
            // Broadcast addresses should not be 0.0.0.0 or loopback.
            assert_ne!(*addr, Ipv4Addr::UNSPECIFIED);
            assert!(!addr.is_loopback());
        }
    }
}
