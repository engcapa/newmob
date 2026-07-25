//! Tests for the LlmRouter — verifies fallback, task routing, full-local
//! filtering. None of these tests touch the network.

use std::sync::Arc;
use std::time::Duration;

use crate::support::mock_provider::{MockEvent, MockLlm};
use taomni_lib::llm::router::{provider_group_route_id, FallbackConfig, LlmRouter};
use taomni_lib::llm::{ChatRequest, TaskKind};

fn req() -> ChatRequest {
    ChatRequest::simple("test sys", "ping")
}

#[tokio::test]
async fn complete_returns_active_when_no_routing() {
    let mut r = LlmRouter::new("active-id");
    r.add_provider(
        "active-id",
        Arc::new(MockLlm::new(vec![MockEvent::Token("OK".into())])),
    );

    let resp = r.complete(req(), TaskKind::ChatDrawer).await.unwrap();
    assert_eq!(resp.content, "OK");
}

#[tokio::test]
async fn task_routing_overrides_active() {
    let mut r = LlmRouter::new("active-id");
    r.add_provider(
        "active-id",
        Arc::new(MockLlm::new(vec![MockEvent::Token("FROM-ACTIVE".into())])),
    );
    r.add_provider(
        "local",
        Arc::new(MockLlm::new(vec![MockEvent::Token("FROM-LOCAL".into())])),
    );
    r.set_task_route(TaskKind::TabCompletion, "local");

    let resp = r.complete(req(), TaskKind::TabCompletion).await.unwrap();
    assert_eq!(resp.content, "FROM-LOCAL");
}

#[tokio::test]
async fn fallback_kicks_in_on_timeout() {
    let mut r = LlmRouter::new("primary");
    r.add_provider(
        "primary",
        Arc::new(MockLlm::new(vec![
            MockEvent::Wait(Duration::from_millis(800)),
            MockEvent::Token("TOO-SLOW".into()),
        ])),
    );
    r.add_provider(
        "secondary",
        Arc::new(MockLlm::new(vec![MockEvent::Token("FALLBACK".into())])),
    );
    r.set_fallback(FallbackConfig {
        primary: "primary".into(),
        secondary: "secondary".into(),
        timeout_ms: 100,
    });

    let resp = r.complete(req(), TaskKind::ChatDrawer).await.unwrap();
    assert_eq!(resp.content, "FALLBACK");
}

#[tokio::test]
async fn fallback_kicks_in_on_provider_error() {
    let mut r = LlmRouter::new("primary");
    r.add_provider(
        "primary",
        Arc::new(MockLlm::new(vec![MockEvent::Error("503".into())])),
    );
    r.add_provider(
        "secondary",
        Arc::new(MockLlm::new(vec![MockEvent::Token("FALLBACK".into())])),
    );
    r.set_fallback(FallbackConfig {
        primary: "primary".into(),
        secondary: "secondary".into(),
        timeout_ms: 5_000,
    });

    let resp = r.complete(req(), TaskKind::ChatDrawer).await.unwrap();
    assert_eq!(resp.content, "FALLBACK");
}

#[tokio::test]
async fn provider_variants_rotate_keys_globally() {
    let mut r = LlmRouter::new("multi-key");
    r.add_provider_variants(
        "multi-key",
        vec![
            Arc::new(MockLlm::new(vec![MockEvent::Token("KEY-1".into())])),
            Arc::new(MockLlm::new(vec![MockEvent::Token("KEY-2".into())])),
        ],
    );

    let provider = r.provider("multi-key").unwrap();

    let first = provider.chat(req()).await.unwrap();
    let second = provider.chat(req()).await.unwrap();
    let third = provider.chat(req()).await.unwrap();

    assert_eq!(first.content, "KEY-1");
    assert_eq!(second.content, "KEY-2");
    assert_eq!(third.content, "KEY-1");
}

#[tokio::test]
async fn provider_variants_try_next_key_on_error() {
    let mut r = LlmRouter::new("multi-key");
    r.add_provider_variants(
        "multi-key",
        vec![
            Arc::new(MockLlm::new(vec![MockEvent::Error("bad key".into())])),
            Arc::new(MockLlm::new(vec![MockEvent::Token("KEY-2".into())])),
        ],
    );

    let resp = r.provider("multi-key").unwrap().chat(req()).await.unwrap();

    assert_eq!(resp.content, "KEY-2");
}

#[tokio::test]
async fn provider_group_rotates_members_globally() {
    let mut r = LlmRouter::new("group:main");
    r.add_provider(
        "p1",
        Arc::new(MockLlm::new(vec![MockEvent::Token("P1".into())])),
    );
    r.add_provider(
        "p2",
        Arc::new(MockLlm::new(vec![MockEvent::Token("P2".into())])),
    );
    r.add_provider_group("main", vec!["p1".into(), "p2".into()]);

    let group = r.provider(&provider_group_route_id("main")).unwrap();

    let first = group.chat(req()).await.unwrap();
    let second = group.chat(req()).await.unwrap();
    let third = group.chat(req()).await.unwrap();

    assert_eq!(first.content, "P1");
    assert_eq!(second.content, "P2");
    assert_eq!(third.content, "P1");
}

#[tokio::test]
async fn provider_group_tries_next_provider_on_error() {
    let mut r = LlmRouter::new("group:main");
    r.add_provider(
        "p1",
        Arc::new(MockLlm::new(vec![MockEvent::Error("provider down".into())])),
    );
    r.add_provider(
        "p2",
        Arc::new(MockLlm::new(vec![MockEvent::Token("P2".into())])),
    );
    r.add_provider_group("main", vec!["p1".into(), "p2".into()]);

    let resp = r
        .provider(&provider_group_route_id("main"))
        .unwrap()
        .chat(req())
        .await
        .unwrap();

    assert_eq!(resp.content, "P2");
}

#[tokio::test]
async fn provider_for_task_falls_back_to_active() {
    let r = LlmRouter::new("default-active");
    assert_eq!(r.provider_for_task(TaskKind::ChatDrawer), "default-active");
}

#[tokio::test]
async fn complete_returns_vault_locked_when_active_provider_unresolved() {
    // Simulates the post-restart state: the active provider's API key is a
    // `vault:<id>` ref but the vault is locked, so build_router skipped
    // registration and marked it unresolved. complete() must surface
    // LlmError::VaultLocked, not LlmError::NoProvider — that's how the
    // frontend knows to pop the unlock dialog.
    let mut r = LlmRouter::new("anthropic");
    r.mark_unresolved("anthropic");

    let err = r.complete(req(), TaskKind::ChatDrawer).await.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("VAULT_LOCKED"),
        "expected VAULT_LOCKED in error, got: {msg}"
    );
    assert!(r.needs_vault_unlock("anthropic"));
    assert!(!r.has_provider("anthropic"));
}

#[tokio::test]
async fn complete_returns_vault_locked_when_fallback_secondary_unresolved() {
    // Primary fails, secondary is the unresolved one — the user should still
    // see VAULT_LOCKED so they understand which provider needs an unlock.
    let mut r = LlmRouter::new("primary");
    r.add_provider(
        "primary",
        Arc::new(MockLlm::new(vec![MockEvent::Error("503".into())])),
    );
    r.mark_unresolved("secondary");
    r.set_fallback(FallbackConfig {
        primary: "primary".into(),
        secondary: "secondary".into(),
        timeout_ms: 5_000,
    });

    let err = r.complete(req(), TaskKind::ChatDrawer).await.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("VAULT_LOCKED"),
        "expected VAULT_LOCKED in error, got: {msg}"
    );
}
