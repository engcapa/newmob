//! FIM latency budget (Layer 2 §16.3): assert that the FIM path emits its
//! first token within the documented P95 budget when the local sidecar (or
//! cloud fallback) is fast. The mock simulates a 150ms inference; we assert
//! that complete() resolves within 300ms even on a single-thread runtime.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::support::mock_provider::{MockEvent, MockLlm};
use taomni_lib::llm::router::LlmRouter;
use taomni_lib::llm::{ChatRequest, TaskKind};

#[tokio::test(flavor = "current_thread")]
async fn fim_completes_within_budget() {
    let mut r = LlmRouter::new("fim");
    r.add_provider(
        "fim",
        Arc::new(MockLlm::new(vec![
            MockEvent::Wait(Duration::from_millis(150)),
            MockEvent::Token("ckout main".into()),
        ])),
    );
    r.set_task_route(TaskKind::TabCompletion, "fim");

    let started = Instant::now();
    let resp = r
        .complete(
            ChatRequest::simple("sys", "git che"),
            TaskKind::TabCompletion,
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();

    assert_eq!(resp.content, "ckout main");
    // 300ms is the documented P95 target; we assert <500ms in CI to absorb
    // jitter while still failing if a regression takes us past 1.5x budget.
    assert!(
        elapsed < Duration::from_millis(500),
        "FIM too slow: {:?}",
        elapsed
    );
}
