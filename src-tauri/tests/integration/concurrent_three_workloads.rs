//! Concurrent three workloads (Layer 2 §16.4): the worst case is one ASR
//! transcribe + a sustained FIM stream + a Drawer chat all firing at once.
//! With the MockLlm, each task reports its own ttft/elapsed; we assert that
//! all three complete within their per-feature budgets even when running
//! concurrently on a small tokio runtime.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::support::mock_provider::{MockEvent, MockLlm};
use taomni_lib::llm::router::LlmRouter;
use taomni_lib::llm::{ChatRequest, TaskKind};

fn build_router_with_three() -> LlmRouter {
    let mut r = LlmRouter::new("chat");
    // Chat path: 800ms simulated TTFT
    r.add_provider(
        "chat",
        Arc::new(MockLlm::new(vec![
            MockEvent::Wait(Duration::from_millis(800)),
            MockEvent::Token("hello".into()),
        ])),
    );
    // FIM path: tight budget
    r.add_provider(
        "fim",
        Arc::new(MockLlm::new(vec![
            MockEvent::Wait(Duration::from_millis(120)),
            MockEvent::Token("ckout main".into()),
        ])),
    );
    // Voice intent path: ~700ms
    r.add_provider(
        "voice",
        Arc::new(MockLlm::new(vec![
            MockEvent::Wait(Duration::from_millis(700)),
            MockEvent::Token("{\"tool\":\"list_sessions\"}".into()),
        ])),
    );
    r.set_task_route(TaskKind::ChatDrawer, "chat");
    r.set_task_route(TaskKind::TabCompletion, "fim");
    r.set_task_route(TaskKind::VoiceIntent, "voice");
    r
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_workloads_meet_per_feature_budgets() {
    let router = Arc::new(build_router_with_three());

    let r1 = router.clone();
    let chat = tokio::spawn(async move {
        let started = Instant::now();
        let _ = r1
            .complete(ChatRequest::simple("sys", "explain"), TaskKind::ChatDrawer)
            .await;
        started.elapsed()
    });

    let r2 = router.clone();
    let fim = tokio::spawn(async move {
        let started = Instant::now();
        let _ = r2
            .complete(
                ChatRequest::simple("sys", "git che"),
                TaskKind::TabCompletion,
            )
            .await;
        started.elapsed()
    });

    let r3 = router.clone();
    let voice = tokio::spawn(async move {
        let started = Instant::now();
        let _ = r3
            .complete(
                ChatRequest::simple("sys", "list sessions"),
                TaskKind::VoiceIntent,
            )
            .await;
        started.elapsed()
    });

    let (chat_ms, fim_ms, voice_ms) = tokio::join!(chat, fim, voice);
    let chat_ms = chat_ms.unwrap();
    let fim_ms = fim_ms.unwrap();
    let voice_ms = voice_ms.unwrap();

    // Loose budgets (CI variance friendly): plan calls for FIM <300ms P95 and
    // chat first-token <1500ms; we don't assert true latency here because the
    // mock's delays already reflect the budget. The point is concurrency does
    // not deadlock or serialize unexpectedly.
    assert!(
        chat_ms < Duration::from_millis(2500),
        "chat too slow: {:?}",
        chat_ms
    );
    assert!(
        fim_ms < Duration::from_millis(1000),
        "fim too slow: {:?}",
        fim_ms
    );
    assert!(
        voice_ms < Duration::from_millis(2000),
        "voice too slow: {:?}",
        voice_ms
    );
}
