import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  vaultStatus,
  VAULT_LOCKED_EVENT,
  VAULT_LOCKED_ERROR,
} from "../lib/ipc";

export const DEFAULT_CLAUDE_CODE_MODEL = "claude-sonnet-4-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const ACP_PROVIDER_PREFIX = "acp:";

export interface AsrProviderConfig {
  engine: string;
  model: string;
}

export interface AsrConfig {
  active: string;
  providers: Record<string, AsrProviderConfig>;
  warm_on_startup: boolean;
  vad: string;
}

export interface LlmProviderConfig {
  base_url: string;
  api_key: string;
  api_keys?: string[];
  model: string;
  runtime: string;
  capabilities?: LlmProviderCapabilities;
  image_model?: string | null;
  video_model?: string | null;
  proxy_mode?: "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface LlmProviderCapabilities {
  chat?: boolean;
  image_generation?: boolean;
  video_generation?: boolean;
}

export interface FallbackConfig {
  enabled: boolean;
  primary: string;
  secondary: string;
  timeout_ms: number;
}

export interface LlmProviderGroupConfig {
  label: string;
  provider_ids: string[];
  enabled?: boolean;
}

export interface LlmConfig {
  active: string;
  providers: Record<string, LlmProviderConfig>;
  provider_groups: Record<string, LlmProviderGroupConfig>;
  fallback: FallbackConfig;
  task_routing: Record<string, string>;
}

export interface AiConfig {
  asr: AsrConfig;
  llm: LlmConfig;
  web_search: WebSearchConfig;
  cc_bridge: CcBridgeConfig;
  codex_bridge: CodexBridgeConfig;
  acp_bridge: AcpBridgeConfig;
  full_local_mode?: boolean;
  fully_disabled?: boolean;
  /** Default output format for chat replies: "md" | "html" | "plain". */
  chat_output_format?: string;
  /** Composer send shortcut: "ctrl_enter" (default) | "enter". */
  chat_send_shortcut?: string;
}

export interface CcCustomSettingsProfile {
  id: string;
  name: string;
  enabled: boolean;
  vault_ref: string;
  created_at: number;
  proxy_mode?: "inherit" | "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface CcBridgeConfig {
  enabled: boolean;
  binary: string;
  min_version: string;
  default_model: string;
  permission_mode: string;
  max_turns: number;
  /** When true, read-only Bash/run_in_terminal commands still need a confirmation (3.6). */
  confirm_readonly?: boolean;
  /** Mirror finished captured runs into the bound terminal as display-only traces. */
  terminal_echo_enabled?: boolean;
  proxy_mode?: "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
  custom_settings_profiles?: CcCustomSettingsProfile[];
  active_profile_id?: string;
}

export interface CodexCustomConfigProfile {
  id: string;
  name: string;
  enabled: boolean;
  vault_ref: string;
  created_at: number;
  proxy_mode?: "inherit" | "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface CodexBridgeConfig {
  enabled: boolean;
  binary: string;
  min_version: string;
  default_model: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access" | string;
  approval_policy: "never" | "on-request" | "on-failure" | "untrusted" | string;
  network_access?: boolean;
  proxy_mode?: "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
  confirm_readonly?: boolean;
  terminal_echo_enabled?: boolean;
  custom_config_profiles?: CodexCustomConfigProfile[];
  active_profile_id?: string;
}

export interface AcpProfileConfig {
  id: string;
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  /**
   * Optional media features for the built-in Grok ACP profile. Other ACP
   * profiles remain chat-only until they have a dedicated media adapter.
   */
  capabilities?: AcpProfileCapabilities;
  auth_method_id?: string | null;
  proxy_mode: "inherit" | "direct" | "app" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface AcpProfileCapabilities {
  image_generation?: boolean;
  video_generation?: boolean;
}

export interface AcpBridgeConfig {
  enabled: boolean;
  active_profile_id?: string | null;
  proxy_mode: "direct" | "app" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
  request_timeout_seconds: number;
  profiles: AcpProfileConfig[];
}

export const DEFAULT_GROK_ACP_PROFILE: AcpProfileConfig = {
  id: "grok",
  name: "Grok CLI",
  enabled: false,
  command: "grok",
  args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
  capabilities: {
    image_generation: true,
    video_generation: true,
  },
  auth_method_id: null,
  proxy_mode: "inherit",
  proxy_session_id: null,
  proxy_url: null,
};

export interface WebSearchConfig {
  client_provider: string;
  client_enabled: boolean;
  confirm_mode: string;
  byok_key: string;
  searxng_url?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  latency_ms: number;
}

export function isClaudeCodeAvailableForChat(config: AiConfig | null | undefined): boolean {
  return (
    config?.cc_bridge.enabled === true &&
    config.full_local_mode !== true &&
    config.fully_disabled !== true
  );
}

export function isCodexAvailableForChat(config: AiConfig | null | undefined): boolean {
  return (
    config?.codex_bridge.enabled === true &&
    config.full_local_mode !== true &&
    config.fully_disabled !== true
  );
}

export function acpProviderId(profileId: string): string {
  return profileId.startsWith(ACP_PROVIDER_PREFIX) ? profileId : `${ACP_PROVIDER_PREFIX}${profileId}`;
}

export function acpProfileIdFromProvider(providerId: string): string | null {
  if (!providerId.startsWith(ACP_PROVIDER_PREFIX)) return null;
  const profileId = providerId.slice(ACP_PROVIDER_PREFIX.length);
  return profileId || null;
}

export function isAcpAvailableForChat(config: AiConfig | null | undefined): boolean {
  return (
    config?.acp_bridge.enabled === true &&
    config.full_local_mode !== true &&
    config.fully_disabled !== true
  );
}

export function defaultChatProviderId(config: AiConfig | null | undefined): string | undefined {
  return chatDrawerProviderIds(config, "chat")[0];
}

export const PROVIDER_GROUP_PREFIX = "group:";
const CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY = "taomni.chatDrawer.provider.v1";

export function providerGroupRouteId(groupId: string): string {
  return groupId.startsWith(PROVIDER_GROUP_PREFIX) ? groupId : `${PROVIDER_GROUP_PREFIX}${groupId}`;
}

export function providerGroupIdFromRoute(routeId: string): string | null {
  return routeId.startsWith(PROVIDER_GROUP_PREFIX)
    ? routeId.slice(PROVIDER_GROUP_PREFIX.length)
    : null;
}

export type LlmProviderCapability = "chat" | "image_generation" | "video_generation";

type ChatDrawerProviderPreference = Partial<Record<LlmProviderCapability, string>>;

export function readChatDrawerProviderPreference(
  capability: LlmProviderCapability = "chat",
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatDrawerProviderPreference;
    const providerId = parsed?.[capability];
    return typeof providerId === "string" && providerId.trim() ? providerId : null;
  } catch {
    return null;
  }
}

export function rememberChatDrawerProviderPreference(
  providerId: string,
  capability: LlmProviderCapability = "chat",
) {
  if (typeof window === "undefined" || !providerId.trim()) return;
  try {
    const raw = window.localStorage.getItem(CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as ChatDrawerProviderPreference : {};
    window.localStorage.setItem(
      CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY,
      JSON.stringify({ ...parsed, [capability]: providerId }),
    );
  } catch {
    // Best-effort UI preference persistence.
  }
}

export function llmProviderSupports(provider: LlmProviderConfig | null | undefined, capability: LlmProviderCapability): boolean {
  if (!provider) return false;
  if (capability === "chat") return provider.capabilities?.chat !== false;
  return provider.capabilities?.[capability] === true;
}

function acpProfileSupports(profile: AcpProfileConfig, capability: LlmProviderCapability): boolean {
  if (capability === "chat") return true;
  if (profile.id.trim() !== DEFAULT_GROK_ACP_PROFILE.id) return false;
  if (profile.capabilities?.[capability] === true) return true;
  // Grok profiles saved before media capabilities were added retain the
  // built-in preset's support. An explicit false remains an opt-out.
  return profile.id.trim() === DEFAULT_GROK_ACP_PROFILE.id && profile.capabilities?.[capability] === undefined;
}

export function chatDrawerProviderIds(
  config: AiConfig | null | undefined,
  capability: LlmProviderCapability = "chat",
): string[] {
  const groups = Object.entries(config?.llm.provider_groups ?? {})
    .filter(([, group]) => group.enabled !== false)
    .filter(([, group]) =>
      group.provider_ids.some((providerId) =>
        llmProviderSupports(config?.llm.providers[providerId], capability),
      ),
    )
    .map(([groupId]) => providerGroupRouteId(groupId));
  const ids = Object.entries(config?.llm.providers ?? {})
    .filter(([id, provider]) => id !== "claude-code" && id !== "codex" && llmProviderSupports(provider, capability))
    .map(([id]) => id);
  const active = config?.llm.active;
  const orderedLlmIds = active && ids.includes(active)
    ? [active, ...ids.filter((id) => id !== active)]
    : ids;
  const localAgentIds: string[] = [];
  if (capability === "chat" && isClaudeCodeAvailableForChat(config)) localAgentIds.push("claude-code");
  if (capability === "chat" && isCodexAvailableForChat(config)) localAgentIds.push("codex");
  if (isAcpAvailableForChat(config)) {
    const activeProfileId = config?.acp_bridge.active_profile_id;
    const profiles = [...(config?.acp_bridge.profiles ?? [])]
      .filter((profile) => profile.enabled && profile.command.trim() && acpProfileSupports(profile, capability))
      .sort((left, right) => Number(right.id === activeProfileId) - Number(left.id === activeProfileId));
    localAgentIds.push(...profiles.map((profile) => acpProviderId(profile.id)));
  }
  const orderedIds = [...orderedLlmIds, ...groups, ...localAgentIds];
  const preferred = readChatDrawerProviderPreference(capability);
  return Array.from(new Set(
    preferred && orderedIds.includes(preferred)
      ? [preferred, ...orderedIds]
      : orderedIds,
  ));
}

interface AiStore {
  config: AiConfig | null;
  loading: boolean;
  saving: boolean;
  testResults: Record<string, TestConnectionResult | null>;
  voiceShellEnabled: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: (config: AiConfig) => Promise<void>;
  updateLlmProvider: (id: string, provider: LlmProviderConfig) => void;
  updateLlmProviderGroup: (id: string, group: LlmProviderGroupConfig) => void;
  removeLlmProviderGroup: (id: string) => void;
  setActiveLlmProvider: (id: string) => void;
  testConnection: (providerId: string, provider: LlmProviderConfig) => Promise<void>;
  toggleVoiceShell: () => void;
}

const DEFAULT_CONFIG: AiConfig = {
  asr: {
    active: "sherpa-zipformer-zh-en",
    providers: {
      "sherpa-zipformer-zh-en": { engine: "sherpa-onnx", model: "streaming-zipformer-bilingual-zh-en-small" },
      "whisper-base": { engine: "whisper-rs", model: "ggml-base-q5_1" },
    },
    warm_on_startup: true,
    vad: "silero",
  },
  llm: {
    active: "deepseek",
    providers: {
      deepseek:    { base_url: "https://api.deepseek.com/v1",                    api_key: "", model: "deepseek-chat",                        runtime: "openai-compat", capabilities: { chat: true } },
      agnes:       { base_url: "https://apihub.agnes-ai.com/v1",                 api_key: "", model: "agnes-2.0-flash",                     runtime: "openai-compat", capabilities: { chat: true, image_generation: true, video_generation: true }, image_model: "agnes-image-2.1-flash", video_model: "agnes-video-v2.0" },
      glm:         { base_url: "https://open.bigmodel.cn/api/paas/v4",           api_key: "", model: "glm-4-flash",                          runtime: "openai-compat", capabilities: { chat: true } },
      siliconflow: { base_url: "https://api.siliconflow.cn/v1",                  api_key: "", model: "Qwen/Qwen2.5-Coder-7B-Instruct",       runtime: "openai-compat", capabilities: { chat: true } },
      groq:        { base_url: "https://api.groq.com/openai/v1",                 api_key: "", model: "llama-3.3-70b-versatile",              runtime: "openai-compat", capabilities: { chat: true } },
      local:       { base_url: "http://127.0.0.1:8080/v1",                       api_key: "local", model: "qwen3-1.7b-q4_k_m",             runtime: "llama-server", capabilities: { chat: true } },
    },
    provider_groups: {},
    fallback: { enabled: true, primary: "deepseek", secondary: "local", timeout_ms: 8000 },
    task_routing: {
      voice_intent: "deepseek",
      voice_to_shell: "deepseek",
      tab_completion: "local",
      command_rewrite: "deepseek",
      chat_drawer: "deepseek",
      inline_qq: "deepseek",
      agent_default: "deepseek",
    },
  },
  web_search: {
    client_provider: "searxng",
    client_enabled: false,
    confirm_mode: "per_call",
    byok_key: "",
    searxng_url: undefined,
  },
  cc_bridge: {
    enabled: false,
    binary: "auto",
    min_version: "1.0.0",
    default_model: DEFAULT_CLAUDE_CODE_MODEL,
    permission_mode: "default",
    max_turns: 20,
    confirm_readonly: false,
    terminal_echo_enabled: true,
    proxy_mode: "none",
    proxy_session_id: undefined,
    proxy_url: undefined,
  },
  codex_bridge: {
    enabled: false,
    binary: "auto",
    min_version: "0.100.0",
    default_model: DEFAULT_CODEX_MODEL,
    sandbox: "read-only",
    approval_policy: "never",
    network_access: false,
    proxy_mode: "none",
    proxy_session_id: undefined,
    proxy_url: undefined,
    confirm_readonly: false,
    terminal_echo_enabled: true,
  },
  acp_bridge: {
    enabled: false,
    active_profile_id: "grok",
    proxy_mode: "direct",
    proxy_session_id: null,
    proxy_url: null,
    request_timeout_seconds: 120,
    profiles: [{ ...DEFAULT_GROK_ACP_PROFILE, args: [...DEFAULT_GROK_ACP_PROFILE.args] }],
  },
  full_local_mode: false,
  fully_disabled: false,
  chat_output_format: "md",
  chat_send_shortcut: "ctrl_enter",
};

function normalizeModelName(model: string | undefined | null): string {
  const trimmed = (model ?? "").trim();
  return trimmed === "" || trimmed === "sonnet" ? DEFAULT_CLAUDE_CODE_MODEL : trimmed;
}

function normalizeCodexModelName(model: string | undefined | null): string {
  const trimmed = (model ?? "").trim();
  return trimmed === "" ? DEFAULT_CODEX_MODEL : trimmed;
}

function normalizeCodexGlobalProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "none";
}

function normalizeCodexProfileProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "none" || trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "inherit";
}

function normalizeNoProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "none";
}

function normalizeCcProfileProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "inherit" || trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "none";
}

function normalizeAcpGlobalProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "app" || trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "direct";
}

function normalizeAcpProfileProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "direct" || trimmed === "app" || trimmed === "session" || trimmed === "manual") {
    return trimmed;
  }
  return proxyUrl?.trim() ? "manual" : "inherit";
}

function normalizeAcpProfileCapabilities(
  profile: AcpProfileConfig,
  profileId: string,
): AcpProfileCapabilities | undefined {
  const source = profile.capabilities;
  const builtInGrok = profileId === DEFAULT_GROK_ACP_PROFILE.id;
  if (!source && !builtInGrok) return undefined;
  return {
    ...(source?.image_generation !== undefined || builtInGrok
      ? { image_generation: source?.image_generation ?? builtInGrok }
      : {}),
    ...(source?.video_generation !== undefined || builtInGrok
      ? { video_generation: source?.video_generation ?? builtInGrok }
      : {}),
  };
}

function normalizeGrokAcpArgs(profileId: string, args: string[]): string[] {
  // Migrate only the exact old built-in default. Custom Grok arguments remain
  // visible and editable here; the Rust launch layer still enforces the
  // permission policy at process start.
  if (
    profileId === DEFAULT_GROK_ACP_PROFILE.id &&
    args.length === 2 &&
    args[0] === "agent" &&
    args[1] === "stdio"
  ) {
    return [...DEFAULT_GROK_ACP_PROFILE.args];
  }
  return args;
}

function normalizeAcpBridge(bridge: AcpBridgeConfig | undefined): AcpBridgeConfig {
  const source = bridge ?? DEFAULT_CONFIG.acp_bridge;
  let profiles = (source.profiles ?? []).map((profile, index) => {
    const id = profile.id?.trim() || `profile-${index + 1}`;
    const args = (profile.args ?? []).map((arg) => arg.trim()).filter(Boolean);
    return {
      ...profile,
      id,
      name: profile.name?.trim() || profile.id?.trim() || `ACP Agent ${index + 1}`,
      command: profile.command?.trim() || "",
      args: normalizeGrokAcpArgs(id, args),
      capabilities: normalizeAcpProfileCapabilities(profile, id),
      auth_method_id: profile.auth_method_id?.trim() || null,
      proxy_mode: normalizeAcpProfileProxyMode(profile.proxy_mode, profile.proxy_url),
      proxy_session_id: profile.proxy_session_id?.trim() || null,
      proxy_url: profile.proxy_url?.trim() || null,
    };
  });
  const requestedActiveProfileId = source.active_profile_id?.trim();
  let activeProfileId = requestedActiveProfileId && profiles.some((profile) => profile.id === requestedActiveProfileId)
    ? requestedActiveProfileId
    : profiles[0]?.id ?? null;
  if (source.enabled === true && !profiles.some((profile) => profile.enabled)) {
    const fallbackProfile = profiles.find((profile) =>
      profile.id === activeProfileId && profile.command.length > 0
    ) ?? profiles.find((profile) => profile.command.length > 0);
    if (fallbackProfile) {
      activeProfileId = fallbackProfile.id;
      profiles = profiles.map((profile) =>
        profile.id === fallbackProfile.id ? { ...profile, enabled: true } : profile
      );
    }
  }
  return {
    ...DEFAULT_CONFIG.acp_bridge,
    ...source,
    active_profile_id: activeProfileId,
    proxy_mode: normalizeAcpGlobalProxyMode(source.proxy_mode, source.proxy_url),
    proxy_session_id: source.proxy_session_id?.trim() || null,
    proxy_url: source.proxy_url?.trim() || null,
    request_timeout_seconds: Math.min(600, Math.max(1, Math.round(source.request_timeout_seconds || 120))),
    profiles,
  };
}

function normalizeLlmProvider(provider: LlmProviderConfig): LlmProviderConfig {
  const configuredKeys = (provider.api_keys ?? [])
    .map((key) => key ?? "")
    .filter((key) => key.trim() !== "");
  const apiKeys = configuredKeys.length > 0 ? configuredKeys : [provider.api_key ?? ""];
  return {
    ...provider,
    api_key: apiKeys[0] ?? "",
    api_keys: apiKeys,
    capabilities: {
      chat: provider.capabilities?.chat !== false,
      image_generation: provider.capabilities?.image_generation === true,
      video_generation: provider.capabilities?.video_generation === true,
    },
    image_model: provider.image_model ?? null,
    video_model: provider.video_model ?? null,
    proxy_mode: normalizeNoProxyMode(provider.proxy_mode, provider.proxy_url),
    proxy_session_id: provider.proxy_session_id?.trim() || undefined,
    proxy_url: provider.proxy_url?.trim() || undefined,
  };
}

function normalizeProviderGroup(id: string, group: LlmProviderGroupConfig): LlmProviderGroupConfig {
  const providerIds = Array.from(
    new Set(
      (group.provider_ids ?? [])
        .map((providerId) => providerId.trim())
        .filter(Boolean),
    ),
  );
  return {
    label: group.label?.trim() || id,
    provider_ids: providerIds,
    enabled: group.enabled !== false,
  };
}

function configuredProviderApiKeys(provider: LlmProviderConfig): string[] {
  const keys = (provider.api_keys ?? [])
    .map((key) => key ?? "")
    .filter((key) => key.trim() !== "");
  return keys.length > 0 ? keys : [provider.api_key ?? ""];
}

function isPlaintextVaultableKey(provider: LlmProviderConfig, key: string): boolean {
  return (
    key.length > 0 &&
    !key.startsWith("vault:") &&
    provider.runtime !== "llama-server" &&
    key !== "local"
  );
}

function normalizeAiConfig(config: AiConfig): AiConfig {
  const providers = config.llm.providers.agnes
    ? config.llm.providers
    : { ...config.llm.providers, agnes: DEFAULT_CONFIG.llm.providers.agnes };
  const providerGroups = Object.fromEntries(
    Object.entries(config.llm.provider_groups ?? {}).map(([id, group]) => [
      id,
      normalizeProviderGroup(id, group),
    ]),
  );
  return {
    ...config,
    llm: {
      ...config.llm,
      providers: Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => [id, normalizeLlmProvider(provider)]),
      ),
      provider_groups: providerGroups,
    },
    cc_bridge: {
      ...DEFAULT_CONFIG.cc_bridge,
      ...config.cc_bridge,
      default_model: normalizeModelName(config.cc_bridge.default_model),
      proxy_mode: normalizeNoProxyMode(config.cc_bridge?.proxy_mode, config.cc_bridge?.proxy_url),
      proxy_session_id: config.cc_bridge?.proxy_session_id?.trim() || undefined,
      proxy_url: config.cc_bridge?.proxy_url?.trim() || undefined,
      custom_settings_profiles: (config.cc_bridge?.custom_settings_profiles ?? []).map((profile) => ({
        ...profile,
        proxy_mode: normalizeCcProfileProxyMode(profile.proxy_mode, profile.proxy_url),
        proxy_session_id: profile.proxy_session_id?.trim() || undefined,
        proxy_url: profile.proxy_url?.trim() || undefined,
      })),
    },
    codex_bridge: {
      ...DEFAULT_CONFIG.codex_bridge,
      ...config.codex_bridge,
      default_model: normalizeCodexModelName(config.codex_bridge?.default_model),
      proxy_mode: normalizeCodexGlobalProxyMode(config.codex_bridge?.proxy_mode, config.codex_bridge?.proxy_url),
      proxy_session_id: config.codex_bridge?.proxy_session_id?.trim() || undefined,
      proxy_url: config.codex_bridge?.proxy_url?.trim() || undefined,
      custom_config_profiles: (config.codex_bridge?.custom_config_profiles ?? []).map((profile) => ({
        ...profile,
        proxy_mode: normalizeCodexProfileProxyMode(profile.proxy_mode, profile.proxy_url),
        proxy_session_id: profile.proxy_session_id?.trim() || undefined,
        proxy_url: profile.proxy_url?.trim() || undefined,
      })),
    },
    acp_bridge: normalizeAcpBridge(config.acp_bridge),
  };
}

export const useAiStore = create<AiStore>((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  testResults: {},
  voiceShellEnabled: false,

  toggleVoiceShell: () => set((s) => ({ voiceShellEnabled: !s.voiceShellEnabled })),

  loadConfig: async () => {
    set({ loading: true });
    try {
      const config = await invoke<AiConfig>("get_ai_config");
      set({ config: normalizeAiConfig(config), loading: false });
    } catch {
      set({ config: DEFAULT_CONFIG, loading: false });
    }
  },

  saveConfig: async (config: AiConfig) => {
    config = normalizeAiConfig(config);
    set({ saving: true });
    try {
      // Identify providers carrying fresh plaintext API keys — those are the
      // ones we want to push into the vault. (Providers with existing
      // `vault:<id>` refs or the local sidecar's literal "local" are skipped.)
      const providersNeedingVault = Object.entries(config.llm.providers).filter(
        ([, p]) => configuredProviderApiKeys(p).some((key) => isPlaintextVaultableKey(p, key)),
      );

      // If we have plaintext keys to encrypt but the vault is locked or
      // uninitialized, we MUST NOT fall back to writing plaintext to ai.json
      // — the user thought they were saving into the encrypted vault, and a
      // future restart would silently use a plaintext key. Instead, surface
      // the unlock dialog and abort the save so the user can retry.
      if (providersNeedingVault.length > 0) {
        const status = await vaultStatus().catch(() => null);
        if (status && status.state !== "unlocked") {
          set({ saving: false });
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "Unlock the credential vault so the AI provider's API key can be encrypted before saving.",
              },
            }),
          );
          throw new Error(
            `${VAULT_LOCKED_ERROR}: unlock the credential vault before saving the AI provider's API key.`,
          );
        }
      }

      // For each provider key whose value is plaintext (not already a vault: ref),
      // store it in the vault and replace it with the returned `vault:<id>` reference.
      const providers: Record<string, LlmProviderConfig> = {};
      for (const [id, p] of Object.entries(config.llm.providers)) {
        const apiKeys = configuredProviderApiKeys(p);
        const storedKeys: string[] = [];
        for (let index = 0; index < apiKeys.length; index += 1) {
          const key = apiKeys[index];
          if (!isPlaintextVaultableKey(p, key)) {
            storedKeys.push(key);
            continue;
          }
          try {
            const ref = await invoke<string>("save_ai_api_key", {
              kind: index === 0 ? `ai_api_key:${id}` : `ai_api_key:${id}:${index + 1}`,
              label: index === 0 ? `LLM Provider: ${id}` : `LLM Provider: ${id} #${index + 1}`,
              plaintext: key,
            });
            storedKeys.push(ref);
          } catch (err) {
            // Should be unreachable — we guarded above. But if the vault
            // got re-locked between the check and the put, surface it.
            const msg = String(err);
            if (msg.includes(VAULT_LOCKED_ERROR)) {
              set({ saving: false });
              window.dispatchEvent(
                new CustomEvent(VAULT_LOCKED_EVENT, {
                  detail: {
                    reason:
                      "Unlock the credential vault so the AI provider's API key can be encrypted before saving.",
                  },
                }),
              );
              throw err;
            }
            storedKeys.push(key);
          }
        }
        providers[id] = {
          ...p,
          api_key: storedKeys[0] ?? "",
          api_keys: storedKeys,
        };
      }

      const safeConfig: AiConfig = {
        ...config,
        llm: { ...config.llm, providers },
      };

      await invoke("save_ai_config", { config: safeConfig });
      set({ config: safeConfig, saving: false });
    } catch (e) {
      set({ saving: false });
      throw e;
    }
  },

  updateLlmProvider: (id: string, provider: LlmProviderConfig) => {
    const config = get().config;
    if (!config) return;
    set({
      config: {
        ...config,
        llm: {
          ...config.llm,
          providers: { ...config.llm.providers, [id]: provider },
        },
      },
    });
  },

  updateLlmProviderGroup: (id: string, group: LlmProviderGroupConfig) => {
    const config = get().config;
    if (!config) return;
    set({
      config: {
        ...config,
        llm: {
          ...config.llm,
          provider_groups: {
            ...config.llm.provider_groups,
            [id]: normalizeProviderGroup(id, group),
          },
        },
      },
    });
  },

  removeLlmProviderGroup: (id: string) => {
    const config = get().config;
    if (!config) return;
    const providerGroups = { ...config.llm.provider_groups };
    delete providerGroups[id];
    set({
      config: {
        ...config,
        llm: {
          ...config.llm,
          provider_groups: providerGroups,
        },
      },
    });
  },

  setActiveLlmProvider: (id: string) => {
    const config = get().config;
    if (!config) return;
    set({ config: { ...config, llm: { ...config.llm, active: id } } });
  },

  testConnection: async (providerId: string, provider: LlmProviderConfig) => {
    set((s) => ({ testResults: { ...s.testResults, [providerId]: null } }));
    try {
      const firstKey = configuredProviderApiKeys(provider)[0] ?? "";
      const result = await invoke<TestConnectionResult>("test_llm_connection", {
        provider: {
          ...provider,
          api_key: firstKey,
          api_keys: [firstKey],
        },
      });
      set((s) => ({ testResults: { ...s.testResults, [providerId]: result } }));
    } catch (e) {
      set((s) => ({
        testResults: {
          ...s.testResults,
          [providerId]: { ok: false, message: String(e), latency_ms: 0 },
        },
      }));
    }
  },
}));
