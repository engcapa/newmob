use crate::agent::search::brave::BraveProvider;
use crate::agent::search::exa::ExaProvider;
use crate::agent::search::google_cse::GoogleCseProvider;
use crate::agent::search::searxng::SearXngProvider;
use crate::agent::search::serper::SerperProvider;
use crate::agent::search::tavily::TavilyProvider;
use crate::agent::search::{SearchHit, SearchOptions, SearchProvider, key_storage};
use crate::agent::tools::Tool;
use crate::agent::tools::web_fetch::WebFetchTool;
use crate::ai::config::{AiConfig, default_ai_config_path};
use crate::state::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

fn build_search_provider(config: &AiConfig) -> Result<Arc<dyn SearchProvider>, String> {
    let ws = &config.web_search;
    // Prefer the OS keyring; fall back to the legacy ai.json byok_key field
    // for users who haven't migrated yet.
    let key_from_keyring = key_storage::get("ai_api_key", &ws.client_provider)
        .ok()
        .flatten();
    let api_key = key_from_keyring.unwrap_or_else(|| ws.byok_key.clone());

    match ws.client_provider.as_str() {
        "tavily" if !api_key.is_empty() => Ok(Arc::new(TavilyProvider::new(&api_key))),
        "serper" if !api_key.is_empty() => Ok(Arc::new(SerperProvider::new(&api_key))),
        "brave" if !api_key.is_empty() => Ok(Arc::new(BraveProvider::new(&api_key))),
        "exa" if !api_key.is_empty() => Ok(Arc::new(ExaProvider::new(&api_key))),
        "google_cse" if !api_key.is_empty() => Ok(Arc::new(GoogleCseProvider::new(&api_key)?)),
        // Default / fallback: SearXNG public instance (no key required).
        _ => Ok(Arc::new(SearXngProvider::new(
            ws.searxng_url
                .as_deref()
                .unwrap_or(crate::agent::search::instances::PUBLIC_INSTANCES[0]),
        ))),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub hits: Vec<SearchHit>,
    pub provider: String,
    pub query: String,
}

/// Execute a web search (called after user confirms the WebSearchConfirmCard).
///
/// Three-tier confirmation contract — the frontend shows the confirm card by
/// default; this command does NOT decide whether to confirm. Instead it
/// trusts that the frontend already gated according to the user's setting
/// (`per_call` | `per_thread` | `always` | `disabled`). We do still enforce
/// the global gates (`fully_disabled`, `full_local_mode`, `client_enabled`,
/// `confirm_mode == disabled`) here as a defense-in-depth.
///
/// Audit log: a row is written to `voice_audit` recording **only** the
/// provider id + result count, never the query text. This aligns with the
/// plan's privacy guarantee (§9.7) — the local DB must not become a
/// secondary leak surface.
#[tauri::command]
pub async fn web_search_execute(
    query: String,
    freshness: Option<String>,
    max_results: Option<u32>,
    state: State<'_, AppState>,
) -> Result<WebSearchResult, String> {
    let config = AiConfig::load(&default_ai_config_path());
    if config.fully_disabled {
        return Err("AI is fully disabled.".into());
    }
    if config.full_local_mode {
        return Err("FULL_LOCAL_MODE: web search is blocked when full-local mode is on.".into());
    }
    if !config.web_search.client_enabled {
        return Err("Web search is disabled. Enable it in Settings → AI → Web Search.".into());
    }
    if config.web_search.confirm_mode == "disabled" {
        return Err("Web search confirmation mode is 'disabled' — no searches allowed.".into());
    }

    let provider = build_search_provider(&config)?;
    let provider_id = provider.provider_id().to_string();
    let opts = SearchOptions {
        freshness,
        max_results: max_results.unwrap_or(5).min(10),
    };

    let search_result = provider.search(&query, &opts).await;

    // Audit log: do NOT record the query text. Only provider + result count
    // + outcome. The plan calls this out explicitly (§9.7).
    let now = chrono::Utc::now().timestamp();
    let (outcome, count) = match &search_result {
        Ok(hits) => ("search_allowed", hits.len()),
        Err(_) => ("search_denied", 0),
    };
    if let Ok(db) = state.db.lock() {
        let _ = db.execute(
            "INSERT INTO voice_audit (created_at, session_id, transcript, intent_json, outcome, command, risk)
             VALUES (?1, NULL, NULL, ?2, ?3, NULL, NULL)",
            params![
                now,
                serde_json::json!({ "provider": provider_id, "result_count": count }).to_string(),
                outcome,
            ],
        );
    }

    let hits = search_result?;
    Ok(WebSearchResult {
        hits,
        provider: provider_id,
        query,
    })
}

/// Same as `web_search_execute` but used when the active LLM provider has its
/// OWN native web search (OpenAI / Claude / Gemini / Grok / Mistral / GLM /
/// Qwen / Perplexity). The frontend renames the "extra" client search button
/// to "Deep search" so the user can still trigger an explicit second-pass
/// search via Taomni's mirror — clearly distinguished from the provider's
/// implicit/tool search.
#[tauri::command]
pub async fn deep_search_execute(
    query: String,
    freshness: Option<String>,
    max_results: Option<u32>,
    state: State<'_, AppState>,
) -> Result<WebSearchResult, String> {
    web_search_execute(query, freshness, max_results, state).await
}

/// Snapshot of SearXNG public-instance availability (rolling 30-day window).
/// Frontend uses this in WebSearchPanel to surface flaky instances.
#[tauri::command]
pub async fn searxng_availability() -> Result<Vec<(String, f64, u64)>, String> {
    Ok(crate::agent::search::instances::availability_snapshot())
}

/// Fetch a URL's readable content (called after user confirms).
#[tauri::command]
pub async fn web_fetch_execute(url: String) -> Result<String, String> {
    let config = AiConfig::load(&default_ai_config_path());
    if config.fully_disabled {
        return Err("AI is fully disabled.".into());
    }
    crate::ai::network_policy::reject_if_remote(config.full_local_mode, &url)?;

    let tool = WebFetchTool::new();
    let args = serde_json::json!({ "url": url });
    let result = tool.execute(&args).await;
    if result.ok {
        Ok(result.output)
    } else {
        Err(result.output)
    }
}

/// Probe SearXNG public instances and return the fastest one.
#[tauri::command]
pub async fn probe_searxng_instances() -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(crate::agent::search::instances::probe_best_instance(&client).await)
}

/// Returns the capabilities of the currently active LLM provider.
/// The frontend uses this to decide whether to surface
/// `web_search` (when the provider lacks native) or `deep_search`
/// (when it has native and the user asks for a manual extra search).
#[tauri::command]
pub async fn provider_caps(
    state: State<'_, AppState>,
) -> Result<crate::llm::openai_compat::ProviderCaps, String> {
    let ai_ctx = state.ai_ctx.read().await;
    Ok(crate::llm::openai_compat::ProviderCaps::for_provider(
        &ai_ctx.config.llm.active,
    ))
}
