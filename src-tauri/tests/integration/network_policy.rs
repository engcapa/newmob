//! Verifies the network-policy gate (full-local mode).

use taomni_lib::ai::network_policy::{is_local_runtime, is_local_url, reject_if_remote};

#[test]
fn local_url_recognition() {
    assert!(is_local_url("http://127.0.0.1:8080/v1"));
    assert!(is_local_url("http://localhost:11434"));
    assert!(is_local_url("http://[::1]:8080"));
    assert!(!is_local_url("https://api.deepseek.com/v1"));
    assert!(!is_local_url("https://10.0.0.1"));
}

#[test]
fn local_runtime_recognition() {
    assert!(is_local_runtime("llama-server"));
    assert!(is_local_runtime("ollama"));
    assert!(is_local_runtime("in-process"));
    assert!(!is_local_runtime("openai-compat"));
    assert!(!is_local_runtime("anthropic"));
}

#[test]
fn reject_remote_when_full_local_on() {
    assert!(reject_if_remote(true, "https://example.com").is_err());
    assert!(reject_if_remote(true, "http://127.0.0.1").is_ok());
    assert!(reject_if_remote(false, "https://example.com").is_ok());
}
