//! Perf baseline persistence smoke test (§16.9).
//!
//! Records two metrics, reads back the recent list, and verifies both land
//! in the file with the right shape. Ordering between two same-second writes
//! is not asserted because `recorded_at` is a Unix-second timestamp; the
//! production caller cares only about "is this new entry retrievable".

use taomni_lib::perf::{baseline_path, read_recent, record_now};

#[test]
fn record_and_read_back_round_trips() {
    let path = baseline_path();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }

    record_now("test_feature", "mock", 123, Some(45), "trace-1");
    record_now("test_feature_2", "mock", 200, Some(80), "trace-2");

    let recent = read_recent(10);
    assert!(
        recent.len() >= 2,
        "expected at least 2 entries, got {}",
        recent.len()
    );

    let features: Vec<&str> = recent.iter().map(|m| m.feature.as_str()).collect();
    assert!(
        features.contains(&"test_feature"),
        "missing test_feature in {:?}",
        features
    );
    assert!(
        features.contains(&"test_feature_2"),
        "missing test_feature_2 in {:?}",
        features
    );

    let two = recent
        .iter()
        .find(|m| m.feature == "test_feature_2")
        .unwrap();
    assert_eq!(two.e2e_ms, 200);
    assert_eq!(two.ttft_ms, Some(80));
    assert_eq!(two.provider, "mock");
}
