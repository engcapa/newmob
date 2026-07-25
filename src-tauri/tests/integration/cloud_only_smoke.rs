//! Cloud-only smoke (Layer 2 §16.5): ensure a fresh AiConfig exposes the
//! 5 default providers + ASR provider list, and that build_router is willing
//! to register them all when neither full_local_mode nor fully_disabled is on.

use taomni_lib::ai::config::AiConfig;
use taomni_lib::llm::router::build_router;

#[test]
fn default_config_lists_canonical_providers() {
    let cfg = AiConfig::default();
    assert!(cfg.llm.providers.contains_key("deepseek"));
    assert!(cfg.llm.providers.contains_key("glm"));
    assert!(cfg.llm.providers.contains_key("siliconflow"));
    assert!(cfg.llm.providers.contains_key("groq"));
    assert!(cfg.llm.providers.contains_key("local"));
    assert!(cfg.llm.providers.contains_key("anthropic"));
    assert!(cfg.asr.providers.contains_key("sherpa-zipformer-zh-en"));
}

#[test]
fn build_router_registers_all_when_not_locked_down() {
    let cfg = AiConfig::default();
    let router = build_router(&cfg.llm, None, false);
    assert!(router.has_provider("deepseek"));
    assert!(router.has_provider("glm"));
    assert!(router.has_provider("siliconflow"));
    assert!(router.has_provider("groq"));
    assert!(router.has_provider("local"));
}

#[test]
fn full_local_mode_filters_cloud_providers() {
    let cfg = AiConfig::default();
    let router = build_router(&cfg.llm, None, true);
    assert!(
        router.has_provider("local"),
        "local must survive full-local mode"
    );
    assert!(
        !router.has_provider("deepseek"),
        "deepseek should be filtered"
    );
    assert!(!router.has_provider("groq"), "groq should be filtered");
}
