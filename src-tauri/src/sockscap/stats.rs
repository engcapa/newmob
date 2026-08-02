//! In-memory traffic counters.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct StatsCounters {
    pub flows_total: AtomicU64,
    pub flows_proxy: AtomicU64,
    pub flows_direct: AtomicU64,
    pub flows_block: AtomicU64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
    pub last_flow_at: AtomicU64,
    pub quic_flows_dropped: AtomicU64,
    pub udp_direct_datagrams: AtomicU64,
    pub last_quic_drop_at: AtomicU64,
    pub scope_mismatch_flows: AtomicU64,
    pub last_scope_mismatch_at: AtomicU64,
    pub flow_failures: AtomicU64,
    pub dns_answers_learned: AtomicU64,
}

impl StatsCounters {
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            flows_total: self.flows_total.load(Ordering::Relaxed),
            flows_proxy: self.flows_proxy.load(Ordering::Relaxed),
            flows_direct: self.flows_direct.load(Ordering::Relaxed),
            flows_block: self.flows_block.load(Ordering::Relaxed),
            bytes_up: self.bytes_up.load(Ordering::Relaxed),
            bytes_down: self.bytes_down.load(Ordering::Relaxed),
            last_flow_at: nonzero_timestamp(self.last_flow_at.load(Ordering::Relaxed)),
            quic_flows_dropped: self.quic_flows_dropped.load(Ordering::Relaxed),
            udp_direct_datagrams: self.udp_direct_datagrams.load(Ordering::Relaxed),
            last_quic_drop_at: nonzero_timestamp(self.last_quic_drop_at.load(Ordering::Relaxed)),
            scope_mismatch_flows: self.scope_mismatch_flows.load(Ordering::Relaxed),
            last_scope_mismatch_at: nonzero_timestamp(
                self.last_scope_mismatch_at.load(Ordering::Relaxed),
            ),
            flow_failures: self.flow_failures.load(Ordering::Relaxed),
            dns_answers_learned: self.dns_answers_learned.load(Ordering::Relaxed),
        }
    }

    pub fn record_decision(&self, proxy: bool, block: bool) {
        self.flows_total.fetch_add(1, Ordering::Relaxed);
        if block {
            self.flows_block.fetch_add(1, Ordering::Relaxed);
        } else if proxy {
            self.flows_proxy.fetch_add(1, Ordering::Relaxed);
        } else {
            self.flows_direct.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn add_bytes(&self, up: u64, down: u64) {
        if up > 0 {
            self.bytes_up.fetch_add(up, Ordering::Relaxed);
        }
        if down > 0 {
            self.bytes_down.fetch_add(down, Ordering::Relaxed);
        }
    }

    pub fn record_flow_seen(&self) {
        self.last_flow_at.store(now_unix(), Ordering::Relaxed);
    }

    pub fn record_quic_drop(&self) {
        self.quic_flows_dropped.fetch_add(1, Ordering::Relaxed);
        self.last_quic_drop_at.store(now_unix(), Ordering::Relaxed);
    }

    pub fn record_udp_direct_datagram(&self) {
        self.udp_direct_datagrams.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_scope_mismatch(&self) {
        self.scope_mismatch_flows.fetch_add(1, Ordering::Relaxed);
        self.last_scope_mismatch_at
            .store(now_unix(), Ordering::Relaxed);
    }

    pub fn record_flow_failure(&self) {
        self.flow_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_dns_answers(&self, count: u64) {
        self.dns_answers_learned.fetch_add(count, Ordering::Relaxed);
    }

    pub fn reset(&self) {
        self.flows_total.store(0, Ordering::Relaxed);
        self.flows_proxy.store(0, Ordering::Relaxed);
        self.flows_direct.store(0, Ordering::Relaxed);
        self.flows_block.store(0, Ordering::Relaxed);
        self.bytes_up.store(0, Ordering::Relaxed);
        self.bytes_down.store(0, Ordering::Relaxed);
        self.last_flow_at.store(0, Ordering::Relaxed);
        self.quic_flows_dropped.store(0, Ordering::Relaxed);
        self.udp_direct_datagrams.store(0, Ordering::Relaxed);
        self.last_quic_drop_at.store(0, Ordering::Relaxed);
        self.scope_mismatch_flows.store(0, Ordering::Relaxed);
        self.last_scope_mismatch_at.store(0, Ordering::Relaxed);
        self.flow_failures.store(0, Ordering::Relaxed);
        self.dns_answers_learned.store(0, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub flows_total: u64,
    pub flows_proxy: u64,
    pub flows_direct: u64,
    pub flows_block: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub last_flow_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub quic_flows_dropped: u64,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub udp_direct_datagrams: u64,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub last_quic_drop_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub scope_mismatch_flows: u64,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), serde(skip_serializing))]
    pub last_scope_mismatch_at: Option<u64>,
    #[serde(default)]
    pub flow_failures: u64,
    #[serde(default)]
    pub dns_answers_learned: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn nonzero_timestamp(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

use crate::sockscap::config::Decision;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRecord {
    pub key: String,
    pub domain_or_ip: String,
    pub decision: Decision,
    pub matched_rule: Option<String>,
    #[serde(default)]
    pub profile_name: Option<String>,
    pub process_name: Option<String>,
    pub pid: Option<u32>,
    pub hit_count: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub last_seen_unix: u64,
}

#[derive(Debug)]
pub struct DomainTracker {
    records: HashMap<String, DomainRecord>,
    max_capacity: usize,
}

impl DomainTracker {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            records: HashMap::new(),
            max_capacity,
        }
    }

    pub fn record(
        &mut self,
        domain_or_ip: String,
        decision: Decision,
        matched_rule: Option<String>,
        profile_name: Option<String>,
        process_path: Option<String>,
        pid: Option<u32>,
        bytes_up: u64,
        bytes_down: u64,
    ) {
        let key = format!("{domain_or_ip}:{:?}", decision);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let process_name = process_path.as_ref().and_then(|p| {
            std::path::Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        });

        if let Some(entry) = self.records.get_mut(&key) {
            entry.hit_count += 1;
            entry.bytes_up += bytes_up;
            entry.bytes_down += bytes_down;
            entry.last_seen_unix = now;
            if matched_rule.is_some() {
                entry.matched_rule = matched_rule;
            }
            if profile_name.is_some() {
                entry.profile_name = profile_name;
            }
            if process_name.is_some() {
                entry.process_name = process_name;
            }
            if pid.is_some() {
                entry.pid = pid;
            }
        } else {
            if self.records.len() >= self.max_capacity {
                if let Some(oldest_key) = self
                    .records
                    .iter()
                    .min_by_key(|(_, v)| v.last_seen_unix)
                    .map(|(k, _)| k.clone())
                {
                    self.records.remove(&oldest_key);
                }
            }

            self.records.insert(
                key.clone(),
                DomainRecord {
                    key,
                    domain_or_ip,
                    decision,
                    matched_rule,
                    profile_name,
                    process_name,
                    pid,
                    hit_count: 1,
                    bytes_up,
                    bytes_down,
                    last_seen_unix: now,
                },
            );
        }
    }

    pub fn add_traffic(
        &mut self,
        domain_or_ip: &str,
        decision: Decision,
        bytes_up: u64,
        bytes_down: u64,
    ) {
        let key = format!("{domain_or_ip}:{:?}", decision);
        if let Some(entry) = self.records.get_mut(&key) {
            entry.bytes_up += bytes_up;
            entry.bytes_down += bytes_down;
        }
    }

    pub fn snapshot(&self) -> Vec<DomainRecord> {
        let mut list: Vec<_> = self.records.values().cloned().collect();
        list.sort_by(|a, b| b.last_seen_unix.cmp(&a.last_seen_unix));
        list
    }

    pub fn clear(&mut self) {
        self.records.clear();
    }
}
