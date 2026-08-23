use super::{
    ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, Llm, LlmError, LlmResult, TaskKind,
};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::time::timeout;

pub const PROVIDER_GROUP_PREFIX: &str = "group:";

pub fn provider_group_route_id(group_id: &str) -> String {
    if group_id.starts_with(PROVIDER_GROUP_PREFIX) {
        group_id.to_string()
    } else {
        format!("{PROVIDER_GROUP_PREFIX}{group_id}")
    }
}

pub fn provider_group_id_from_route(route_id: &str) -> Option<&str> {
    route_id.strip_prefix(PROVIDER_GROUP_PREFIX)
}

struct KeyRotatingLlm {
    provider_id: String,
    model: String,
    variants: Vec<Arc<dyn Llm>>,
    key_state: Arc<KeyRotationState>,
}

impl KeyRotatingLlm {
    fn new(
        provider_id: impl Into<String>,
        variants: Vec<Arc<dyn Llm>>,
        key_state: Arc<KeyRotationState>,
    ) -> Self {
        let model = variants
            .first()
            .map(|provider| provider.model().to_string())
            .unwrap_or_default();
        Self {
            provider_id: provider_id.into(),
            model,
            variants,
            key_state,
        }
    }

    fn next_variant(&self) -> Option<Arc<dyn Llm>> {
        if self.variants.is_empty() {
            return None;
        }
        let idx = self.key_state.next_key_index(self.variants.len());
        self.variants.get(idx).cloned()
    }
}

struct KeyRotationState {
    next_key: AtomicUsize,
}

impl KeyRotationState {
    fn new() -> Self {
        Self {
            next_key: AtomicUsize::new(0),
        }
    }

    fn next_key_index(&self, key_count: usize) -> usize {
        if key_count <= 1 {
            0
        } else {
            self.next_key.fetch_add(1, Ordering::Relaxed) % key_count
        }
    }
}

#[async_trait]
impl Llm for KeyRotatingLlm {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.variants.len() {
            let Some(provider) = self.next_variant() else {
                break;
            };
            match provider.chat(req.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        provider = %self.provider_id,
                        key_model = %provider.model(),
                        error = %err,
                        "LLM provider key failed, trying next key"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    async fn chat_with_tools(
        &self,
        req: ChatRequest,
        tools: Vec<ChatTool>,
    ) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.variants.len() {
            let Some(provider) = self.next_variant() else {
                break;
            };
            match provider.chat_with_tools(req.clone(), tools.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        provider = %self.provider_id,
                        key_model = %provider.model(),
                        error = %err,
                        "LLM provider key failed during tool call, trying next key"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    fn supports_tools(&self) -> bool {
        self.variants
            .iter()
            .any(|provider| provider.supports_tools())
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<futures::stream::BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let mut last_err = None;
        for _ in 0..self.variants.len() {
            let Some(provider) = self.next_variant() else {
                break;
            };
            match provider.chat_stream(req.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(err) => {
                    tracing::warn!(
                        provider = %self.provider_id,
                        key_model = %provider.model(),
                        error = %err,
                        "LLM provider key failed before stream started, trying next key"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn model(&self) -> &str {
        &self.model
    }
}

struct ProviderGroupState {
    provider_ids: Vec<String>,
    next_provider: AtomicUsize,
}

impl ProviderGroupState {
    fn new(provider_ids: Vec<String>) -> Self {
        Self {
            provider_ids,
            next_provider: AtomicUsize::new(0),
        }
    }

    fn len(&self) -> usize {
        self.provider_ids.len()
    }

    fn next_provider_id(&self) -> Option<String> {
        if self.provider_ids.is_empty() {
            return None;
        }
        let idx = self.next_provider.fetch_add(1, Ordering::Relaxed) % self.provider_ids.len();
        self.provider_ids.get(idx).cloned()
    }
}

struct ProviderGroupLlm {
    route_id: String,
    state: Arc<ProviderGroupState>,
    providers: HashMap<String, Arc<dyn Llm>>,
}

impl ProviderGroupLlm {
    fn new(
        route_id: impl Into<String>,
        state: Arc<ProviderGroupState>,
        providers: HashMap<String, Arc<dyn Llm>>,
    ) -> Self {
        Self {
            route_id: route_id.into(),
            state,
            providers,
        }
    }
}

#[async_trait]
impl Llm for ProviderGroupLlm {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.state.len() {
            let Some(provider_id) = self.state.next_provider_id() else {
                break;
            };
            let Some(provider) = self.providers.get(&provider_id).cloned() else {
                continue;
            };
            match provider.chat(req.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        group = %self.route_id,
                        provider = %provider_id,
                        error = %err,
                        "LLM provider group member failed, trying next provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    async fn chat_with_tools(
        &self,
        req: ChatRequest,
        tools: Vec<ChatTool>,
    ) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.state.len() {
            let Some(provider_id) = self.state.next_provider_id() else {
                break;
            };
            let Some(provider) = self.providers.get(&provider_id).cloned() else {
                continue;
            };
            if !provider.supports_tools() {
                continue;
            }
            match provider.chat_with_tools(req.clone(), tools.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        group = %self.route_id,
                        provider = %provider_id,
                        error = %err,
                        "LLM provider group member failed during tool call, trying next provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::Provider {
            status: 400,
            message: format!(
                "provider group '{}' has no tool-capable providers",
                self.route_id
            ),
        }))
    }

    fn supports_tools(&self) -> bool {
        self.providers
            .values()
            .any(|provider| provider.supports_tools())
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<futures::stream::BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let mut last_err = None;
        for _ in 0..self.state.len() {
            let Some(provider_id) = self.state.next_provider_id() else {
                break;
            };
            let Some(provider) = self.providers.get(&provider_id).cloned() else {
                continue;
            };
            match provider.chat_stream(req.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(err) => {
                    tracing::warn!(
                        group = %self.route_id,
                        provider = %provider_id,
                        error = %err,
                        "LLM provider group member failed before stream started, trying next provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    fn provider_id(&self) -> &str {
        &self.route_id
    }

    fn model(&self) -> &str {
        "provider-group"
    }
}

/// Routes a chat request to the appropriate provider based on task kind,
/// with optional timeout + fallback to a secondary provider.
pub struct LlmRouter {
    providers: HashMap<String, Arc<dyn Llm>>,
    provider_key_states: HashMap<String, Arc<KeyRotationState>>,
    provider_groups: HashMap<String, Arc<ProviderGroupState>>,
    task_routing: HashMap<TaskKind, String>,
    active: String,
    fallback: Option<FallbackConfig>,
    /// Provider ids whose api_key is a `vault:<id>` reference that could not
    /// be resolved when the router was built (vault locked / entry missing).
    /// They are intentionally NOT registered in `providers` so calls fail
    /// closed with [`LlmError::VaultLocked`] instead of silently sending the
    /// literal `vault:<uuid>` string as the bearer token (which produced 401s).
    unresolved: HashSet<String>,
}

pub struct FallbackConfig {
    pub primary: String,
    pub secondary: String,
    pub timeout_ms: u64,
}

impl LlmRouter {
    pub fn new(active: impl Into<String>) -> Self {
        Self {
            providers: HashMap::new(),
            provider_key_states: HashMap::new(),
            provider_groups: HashMap::new(),
            task_routing: HashMap::new(),
            active: active.into(),
            fallback: None,
            unresolved: HashSet::new(),
        }
    }

    pub fn add_provider(&mut self, id: impl Into<String>, provider: Arc<dyn Llm>) {
        self.providers.insert(id.into(), provider);
    }

    pub fn add_provider_variants(&mut self, id: impl Into<String>, variants: Vec<Arc<dyn Llm>>) {
        let id = id.into();
        let key_state = self
            .provider_key_states
            .entry(id.clone())
            .or_insert_with(|| Arc::new(KeyRotationState::new()))
            .clone();
        match variants.len() {
            0 => {}
            1 => {
                let provider = variants.into_iter().next().expect("checked len");
                self.add_provider(id, provider);
            }
            _ => {
                self.providers.insert(
                    id.clone(),
                    Arc::new(KeyRotatingLlm::new(id, variants, key_state)),
                );
            }
        }
    }

    pub fn add_provider_group(&mut self, group_id: impl Into<String>, provider_ids: Vec<String>) {
        let route_id = provider_group_route_id(&group_id.into());
        let provider_ids = provider_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        if provider_ids.is_empty() {
            return;
        }

        let state = Arc::new(ProviderGroupState::new(provider_ids.clone()));
        let providers = provider_ids
            .iter()
            .filter_map(|id| {
                self.providers
                    .get(id)
                    .cloned()
                    .map(|provider| (id.clone(), provider))
            })
            .collect::<HashMap<_, _>>();
        if !providers.is_empty() {
            self.providers.insert(
                route_id.clone(),
                Arc::new(ProviderGroupLlm::new(
                    route_id.clone(),
                    state.clone(),
                    providers,
                )),
            );
        }
        self.provider_groups.insert(route_id, state);
    }

    pub fn provider_group_len(&self, route_id: &str) -> Option<usize> {
        self.provider_groups.get(route_id).map(|group| group.len())
    }

    pub fn next_provider_in_group(&self, route_id: &str) -> Option<String> {
        self.provider_groups
            .get(route_id)
            .and_then(|group| group.next_provider_id())
    }

    pub fn next_key_index(&self, provider_id: &str, key_count: usize) -> usize {
        self.provider_key_states
            .get(provider_id)
            .map(|state| state.next_key_index(key_count))
            .unwrap_or(0)
    }

    /// Mark a provider id as blocked on a locked vault. The frontend can call
    /// `needs_vault_unlock(id)` to decide whether to surface the unlock
    /// dialog before invoking a chat command.
    pub fn mark_unresolved(&mut self, id: impl Into<String>) {
        self.unresolved.insert(id.into());
    }

    pub fn set_task_route(&mut self, task: TaskKind, provider_id: impl Into<String>) {
        self.task_routing.insert(task, provider_id.into());
    }

    pub fn set_fallback(&mut self, config: FallbackConfig) {
        self.fallback = Some(config);
    }

    /// True if a provider with this id is registered.
    pub fn has_provider(&self, id: &str) -> bool {
        self.providers.contains_key(id)
    }

    /// True if this provider is known to need a vault unlock to be usable.
    pub fn needs_vault_unlock(&self, id: &str) -> bool {
        self.unresolved.contains(id)
    }

    /// Returns the active default provider id.
    pub fn active(&self) -> &str {
        &self.active
    }

    /// Returns the provider id that this task would actually route to.
    pub fn provider_for_task(&self, task: TaskKind) -> String {
        self.task_routing
            .get(&task)
            .cloned()
            .unwrap_or_else(|| self.active.clone())
    }

    /// Get a direct reference to a provider by id (used by chat streaming etc).
    pub fn provider(&self, id: &str) -> Option<Arc<dyn Llm>> {
        self.providers.get(id).cloned()
    }

    pub async fn complete(&self, req: ChatRequest, task: TaskKind) -> LlmResult<ChatResponse> {
        let primary_id = self.task_routing.get(&task).unwrap_or(&self.active).clone();

        let primary = match self.providers.get(&primary_id) {
            Some(p) => p,
            None => {
                if self.unresolved.contains(&primary_id) {
                    return Err(LlmError::VaultLocked {
                        provider: primary_id,
                    });
                }
                return Err(LlmError::NoProvider(task));
            }
        };

        // If fallback is configured and primary matches the fallback primary, apply timeout.
        if let Some(fb) = &self.fallback {
            if primary_id == fb.primary {
                let result = timeout(
                    Duration::from_millis(fb.timeout_ms),
                    primary.chat(req.clone()),
                )
                .await;

                match result {
                    Ok(Ok(resp)) => return Ok(resp),
                    Ok(Err(e)) => {
                        tracing::warn!(provider = %primary_id, error = %e, "primary LLM failed, falling back");
                    }
                    Err(_) => {
                        tracing::warn!(provider = %primary_id, timeout_ms = fb.timeout_ms, "primary LLM timed out, falling back");
                    }
                }

                let secondary = match self.providers.get(&fb.secondary) {
                    Some(p) => p,
                    None => {
                        if self.unresolved.contains(&fb.secondary) {
                            return Err(LlmError::VaultLocked {
                                provider: fb.secondary.clone(),
                            });
                        }
                        return Err(LlmError::NoProvider(task));
                    }
                };
                return secondary.chat(req).await;
            }
        }

        primary.chat(req).await
    }

    /// Test connectivity to a provider by sending a minimal ping request.
    pub async fn test_connection(&self, provider_id: &str) -> LlmResult<String> {
        let provider = self
            .providers
            .get(provider_id)
            .ok_or_else(|| LlmError::NoProvider(TaskKind::ChatDrawer))?;

        let req = ChatRequest::simple("You are a test assistant.", "Reply with exactly: pong");
        let resp = timeout(Duration::from_secs(10), provider.chat(req))
            .await
            .map_err(|_| LlmError::Timeout { ms: 10_000 })??;

        Ok(resp.content)
    }
}

// ── Build helpers ─────────────────────────────────────────────────────────────

use super::anthropic::AnthropicProvider;
use super::openai_compat::OpenAiCompatProvider;
use crate::ai::config::{AiConfig, LlmConfig, resolve_provider_proxy_url};

fn task_kind_from_str(s: &str) -> Option<TaskKind> {
    Some(match s {
        "voice_intent" => TaskKind::VoiceIntent,
        "voice_to_shell" => TaskKind::VoiceToShell,
        "tab_completion" => TaskKind::TabCompletion,
        "command_rewrite" => TaskKind::CommandRewrite,
        "chat_drawer" => TaskKind::ChatDrawer,
        "inline_qq" => TaskKind::InlineQq,
        "agent_default" => TaskKind::AgentDefault,
        "web_search" => TaskKind::WebSearch,
        "code_mode" => TaskKind::CodeMode,
        _ => return None,
    })
}

/// Resolve a possibly `vault:<id>`-prefixed value to plaintext.
///
/// Returns:
/// - `Ok(plaintext)` when the value is plaintext, or a vault ref that
///   resolves cleanly.
/// - `Err(())` when the value IS a vault ref but the vault is locked, the
///   entry is missing, or decryption failed. The caller must NOT fall back
///   to using the literal `vault:<id>` string as a credential — that's how
///   we end up with bogus 401s on app start.
fn resolve_api_key(value: &str, vault: Option<&crate::vault::Vault>) -> Result<String, ()> {
    let is_ref = value.starts_with(crate::vault::VAULT_REF_PREFIX);
    if !is_ref {
        return Ok(value.to_string());
    }
    let v = match vault {
        Some(v) => v,
        // We have a vault ref but no Vault handle — treat as unresolved.
        None => return Err(()),
    };
    match v.resolve(value) {
        Ok(Some(plaintext)) => Ok(plaintext.to_string()),
        // Plaintext path — `resolve` returns Ok(None) only when the input is
        // not a vault ref, which we already excluded above. Belt-and-braces.
        Ok(None) => Ok(value.to_string()),
        Err(_) => Err(()),
    }
}

/// Build an `LlmRouter` from the persisted `LlmConfig`.
///
/// All `runtime in {openai-compat, llama-server, ollama}` providers are wired
/// through `OpenAiCompatProvider`. Providers with empty `api_key` AND non-local
/// runtime are still registered (so the user can fill the key later without a
/// restart) but they will fail at call-time.
///
/// Anthropic (`runtime=anthropic`) and Claude Code (`runtime=claude-cli`) are
/// not registered here — they are handled by their own modules.
///
/// `full_local_mode` filters out cloud providers entirely and forces task
/// routing to only fall through to local providers.
pub fn build_router(
    cfg: &LlmConfig,
    vault: Option<&crate::vault::Vault>,
    full_local_mode: bool,
) -> LlmRouter {
    build_router_with_proxy_db(cfg, vault, full_local_mode, None)
}

pub fn build_router_with_proxy_db(
    cfg: &LlmConfig,
    vault: Option<&crate::vault::Vault>,
    full_local_mode: bool,
    proxy_db: Option<&rusqlite::Connection>,
) -> LlmRouter {
    let mut router = LlmRouter::new(&cfg.active);

    for (id, p) in &cfg.providers {
        if !p.capabilities.chat {
            tracing::info!(provider = %id, "skipping provider without chat capability in LLM router");
            continue;
        }
        if full_local_mode && !crate::ai::network_policy::is_local_runtime(&p.runtime) {
            tracing::info!(provider = %id, runtime = %p.runtime, "skipping cloud provider in full-local mode");
            continue;
        }

        if !matches!(
            p.runtime.as_str(),
            "openai-compat" | "llama-server" | "ollama" | "anthropic"
        ) {
            tracing::info!(provider = %id, runtime = %p.runtime, "skipping non-openai-compat provider in router");
            continue;
        }

        let proxy_url = match resolve_provider_proxy_url(p, proxy_db, vault) {
            Ok(proxy_url) => proxy_url,
            Err(e) => {
                tracing::warn!(
                    provider = %id,
                    error = %e,
                    "provider proxy could not be resolved; using direct connection"
                );
                None
            }
        };

        let mut variants: Vec<Arc<dyn Llm>> = Vec::new();
        let mut unresolved_key = false;
        for api_key in p.effective_api_keys() {
            let resolved_key = match resolve_api_key(api_key, vault) {
                Ok(k) => k,
                Err(()) => {
                    unresolved_key = true;
                    tracing::warn!(
                        provider = %id,
                        "api key vault reference could not be resolved (vault locked?) — key skipped"
                    );
                    continue;
                }
            };

            let provider: Arc<dyn Llm> = match p.runtime.as_str() {
                "openai-compat" | "llama-server" | "ollama" => {
                    Arc::new(OpenAiCompatProvider::new_with_proxy_url(
                        id.as_str(),
                        p.base_url.clone(),
                        resolved_key,
                        p.model.clone(),
                        proxy_url.clone(),
                    ))
                }
                "anthropic" => {
                    let base_url = if p.base_url.is_empty() {
                        "https://api.anthropic.com/v1".to_string()
                    } else {
                        p.base_url.clone()
                    };
                    Arc::new(AnthropicProvider::new_with_proxy_url(
                        id.as_str(),
                        base_url,
                        resolved_key,
                        p.model.clone(),
                        proxy_url.clone(),
                    ))
                }
                _ => unreachable!("runtime was checked above"),
            };
            variants.push(provider);
        }

        if variants.is_empty() {
            if unresolved_key {
                tracing::warn!(
                    provider = %id,
                    "all api keys were unresolved — provider not registered"
                );
                router.mark_unresolved(id);
            }
        } else {
            router.add_provider_variants(id.clone(), variants);
        }
    }

    for (group_id, group) in &cfg.provider_groups {
        if !group.enabled {
            continue;
        }
        router.add_provider_group(group_id.clone(), group.provider_ids.clone());
        let route_id = provider_group_route_id(group_id);
        if !router.has_provider(&route_id)
            && group
                .provider_ids
                .iter()
                .any(|provider_id| router.needs_vault_unlock(provider_id))
        {
            router.mark_unresolved(route_id);
        }
    }

    for (task_str, provider_id) in &cfg.task_routing {
        if let Some(task) = task_kind_from_str(task_str) {
            // Only set the route if the target provider was actually registered.
            // (full_local_mode might have skipped it.)
            if router.has_provider(provider_id) {
                router.set_task_route(task, provider_id.clone());
            }
        }
    }

    if cfg.fallback.enabled
        && router.has_provider(&cfg.fallback.primary)
        && router.has_provider(&cfg.fallback.secondary)
    {
        router.set_fallback(FallbackConfig {
            primary: cfg.fallback.primary.clone(),
            secondary: cfg.fallback.secondary.clone(),
            timeout_ms: cfg.fallback.timeout_ms,
        });
    }

    router
}

/// Build a router from a full AiConfig (currently only forwards llm).
pub fn build_router_from_ai(cfg: &AiConfig, vault: Option<&crate::vault::Vault>) -> LlmRouter {
    build_router(&cfg.llm, vault, cfg.full_local_mode)
}

pub fn build_router_from_ai_with_proxy_db(
    cfg: &AiConfig,
    vault: Option<&crate::vault::Vault>,
    proxy_db: Option<&rusqlite::Connection>,
) -> LlmRouter {
    build_router_with_proxy_db(&cfg.llm, vault, cfg.full_local_mode, proxy_db)
}
