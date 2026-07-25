//! Voice intent latency (Layer 2 §16.3): assert that the dispatch path from
//! a fixture transcript through the LLM is bounded. Real ASR is not exercised
//! here — that's covered by the Layer 3 nightly job. We measure only the
//! LLM portion.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::support::mock_provider::{MockEvent, MockLlm};
use taomni_lib::llm::router::LlmRouter;
use taomni_lib::llm::{ChatRequest, TaskKind};

#[tokio::test(flavor = "current_thread")]
async fn voice_intent_completes_within_budget() {
    let mut r = LlmRouter::new("voice");
    r.add_provider(
        "voice",
        Arc::new(MockLlm::new(vec![
            MockEvent::Wait(Duration::from_millis(700)),
            MockEvent::Token("{\"tool\":\"list_sessions\"}".into()),
        ])),
    );
    r.set_task_route(TaskKind::VoiceIntent, "voice");

    let started = Instant::now();
    let resp = r
        .complete(
            ChatRequest::simple("voice classifier sys", "list my sessions"),
            TaskKind::VoiceIntent,
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();

    assert!(resp.content.contains("list_sessions"));
    // Plan: <1500ms PTT-release → ActionCard. We allow 2x headroom in CI.
    assert!(
        elapsed < Duration::from_millis(1500),
        "voice intent too slow: {:?}",
        elapsed
    );
}
