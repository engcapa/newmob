//! End-to-end test for the bug "AI returns 401 on first launch when
//! api_key is `vault:<id>` and the vault is still locked".
//!
//! Reproduces the scenario:
//! 1. User saves an Anthropic key. It's stored as `vault:<id>` in ai.json.
//! 2. App restarts. Vault is locked. Old behavior: build_router used the
//!    literal "vault:<id>" as the bearer token → Anthropic returned 401.
//! 3. New behavior: build_router marks the provider unresolved, the
//!    router returns LlmError::VaultLocked, the frontend surfaces the
//!    unlock dialog. After unlock, AppAiCtx::rebuild_router resolves the
//!    key cleanly and the provider becomes usable — no Save click needed.

use std::collections::HashMap;
use taomni_lib::ai::config::{
    AiConfig, FallbackConfig, LlmConfig, LlmProviderCapabilities, LlmProviderConfig,
};
use taomni_lib::llm::router::build_router_from_ai;
use taomni_lib::vault::Vault;
use tempfile::TempDir;

const MASTER_PASSWORD: &str = "correct horse battery";

fn make_config(api_key: String) -> AiConfig {
    let mut providers = HashMap::new();
    providers.insert(
        "anthropic".into(),
        LlmProviderConfig {
            base_url: "https://api.anthropic.com/v1".into(),
            api_key,
            api_keys: Vec::new(),
            model: "claude-sonnet-4-5".into(),
            runtime: "anthropic".into(),
            capabilities: LlmProviderCapabilities::default(),
            image_model: None,
            video_model: None,
            proxy_mode: "none".into(),
            proxy_session_id: None,
            proxy_url: None,
        },
    );
    providers.insert(
        "local".into(),
        LlmProviderConfig {
            base_url: "http://127.0.0.1:8080/v1".into(),
            api_key: "local".into(),
            api_keys: Vec::new(),
            model: "qwen3-1.7b-q4_k_m".into(),
            runtime: "llama-server".into(),
            capabilities: LlmProviderCapabilities::default(),
            image_model: None,
            video_model: None,
            proxy_mode: "none".into(),
            proxy_session_id: None,
            proxy_url: None,
        },
    );

    AiConfig {
        asr: Default::default(),
        llm: LlmConfig {
            active: "anthropic".into(),
            providers,
            provider_groups: HashMap::new(),
            fallback: FallbackConfig {
                enabled: false,
                primary: "anthropic".into(),
                secondary: "local".into(),
                timeout_ms: 8000,
            },
            task_routing: HashMap::new(),
        },
        web_search: Default::default(),
        cc_bridge: Default::default(),
        codex_bridge: Default::default(),
        acp_bridge: Default::default(),
        full_local_mode: false,
        fully_disabled: false,
        chat_output_format: "md".into(),
        chat_send_shortcut: "ctrl_enter".into(),
    }
}

#[test]
fn router_marks_provider_unresolved_when_vault_locked() {
    let tmp = TempDir::new().unwrap();
    let vault_path = tmp.path().join("vault.db");
    let vault = Vault::open(&vault_path).expect("open vault");
    vault.init(MASTER_PASSWORD).expect("init vault");

    let put = vault
        .put("ai_api_key:anthropic", "Anthropic", "sk-ant-real-key-value")
        .expect("put api key");
    let vault_ref = put.reference;
    assert!(vault_ref.starts_with("vault:"));

    // Simulate an app restart: lock the vault before the router rebuild.
    vault.lock().expect("lock vault");

    let cfg = make_config(vault_ref.clone());
    let router = build_router_from_ai(&cfg, Some(&vault));

    // The locked vault path used to silently inject the literal `vault:<id>`
    // string as the bearer token (→ 401 from Anthropic). The fix marks it
    // unresolved instead so the call site can surface VAULT_LOCKED.
    assert!(
        !router.has_provider("anthropic"),
        "anthropic provider must NOT be registered when its vault key is unresolved"
    );
    assert!(
        router.needs_vault_unlock("anthropic"),
        "router should flag anthropic as needing vault unlock"
    );

    // The local provider has a plaintext key — unaffected by the lock.
    assert!(
        router.has_provider("local"),
        "local provider should still be registered (plaintext key)"
    );
    assert!(!router.needs_vault_unlock("local"));
}

#[test]
fn rebuilding_router_after_unlock_registers_the_provider() {
    let tmp = TempDir::new().unwrap();
    let vault_path = tmp.path().join("vault.db");
    let vault = Vault::open(&vault_path).expect("open vault");
    vault.init(MASTER_PASSWORD).expect("init vault");
    let put = vault
        .put("ai_api_key:anthropic", "Anthropic", "sk-ant-real-key-value")
        .expect("put api key");
    vault.lock().expect("lock vault");

    let cfg = make_config(put.reference);

    // Locked → unresolved.
    let router_locked = build_router_from_ai(&cfg, Some(&vault));
    assert!(router_locked.needs_vault_unlock("anthropic"));
    assert!(!router_locked.has_provider("anthropic"));

    // Simulate the user typing the master password.
    vault.unlock(MASTER_PASSWORD).expect("unlock vault");

    // AppAiCtx::rebuild_router calls build_router_from_ai with the same
    // config — the provider is now resolvable.
    let router_unlocked = build_router_from_ai(&cfg, Some(&vault));
    assert!(
        router_unlocked.has_provider("anthropic"),
        "after unlock + rebuild, anthropic provider should be registered"
    );
    assert!(!router_unlocked.needs_vault_unlock("anthropic"));
}

#[test]
fn missing_vault_entry_also_marks_unresolved() {
    // Edge case: vault is unlocked, but the entry was deleted. We still
    // shouldn't fall back to the literal `vault:<id>` — that would always
    // 401. Mark unresolved so the user sees a clear error.
    let tmp = TempDir::new().unwrap();
    let vault_path = tmp.path().join("vault.db");
    let vault = Vault::open(&vault_path).expect("open vault");
    vault.init(MASTER_PASSWORD).expect("init vault");
    // Vault is unlocked but has no entry with this id.
    let cfg = make_config("vault:00000000-0000-0000-0000-000000000000".into());

    let router = build_router_from_ai(&cfg, Some(&vault));
    assert!(!router.has_provider("anthropic"));
    assert!(router.needs_vault_unlock("anthropic"));
}
