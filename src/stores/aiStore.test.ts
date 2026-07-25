import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GROK_ACP_PROFILE,
  chatDrawerProviderIds,
  useAiStore,
  type AcpProfileConfig,
  type AiConfig,
} from "./aiStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../lib/ipc", () => ({
  vaultStatus: vi.fn(),
  VAULT_LOCKED_EVENT: "vault-locked",
  VAULT_LOCKED_ERROR: "vault locked",
}));

function makeConfig(profiles: AcpProfileConfig[], bridgeEnabled = true): AiConfig {
  return {
    asr: { active: "local", providers: {}, warm_on_startup: false, vad: "silero" },
    llm: {
      active: "none",
      providers: {},
      provider_groups: {},
      fallback: { enabled: false, primary: "", secondary: "", timeout_ms: 8_000 },
      task_routing: {},
    },
    web_search: { client_provider: "searxng", client_enabled: false, confirm_mode: "per_call", byok_key: "" },
    cc_bridge: {
      enabled: false,
      binary: "auto",
      min_version: "1.0.0",
      default_model: "claude-sonnet-4-5",
      permission_mode: "default",
      max_turns: 20,
    },
    codex_bridge: {
      enabled: false,
      binary: "auto",
      min_version: "0.100.0",
      default_model: "gpt-5.4",
      sandbox: "read-only",
      approval_policy: "never",
    },
    acp_bridge: {
      enabled: bridgeEnabled,
      active_profile_id: "grok",
      proxy_mode: "direct",
      request_timeout_seconds: 120,
      profiles,
    },
    full_local_mode: false,
    fully_disabled: false,
    chat_output_format: "md",
    chat_send_shortcut: "ctrl_enter",
  };
}

function enabledGrok(): AcpProfileConfig {
  return {
    ...DEFAULT_GROK_ACP_PROFILE,
    args: [...DEFAULT_GROK_ACP_PROFILE.args],
    capabilities: { ...DEFAULT_GROK_ACP_PROFILE.capabilities },
    enabled: true,
  };
}

describe("ACP media provider capabilities", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
    useAiStore.setState({
      config: null,
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("defaults the built-in Grok profile to image and video generation", () => {
    expect(DEFAULT_GROK_ACP_PROFILE.capabilities).toEqual({
      image_generation: true,
      video_generation: true,
    });
  });

  it("lists Grok, rather than arbitrary ACP profiles, for image and video modes", () => {
    const genericProfile: AcpProfileConfig = {
      id: "generic",
      name: "Generic ACP",
      enabled: true,
      command: "generic-agent",
      args: ["stdio"],
      proxy_mode: "inherit",
    };
    const config = makeConfig([enabledGrok(), genericProfile]);

    expect(chatDrawerProviderIds(config, "chat")).toEqual([
      "acp:grok",
      "acp:generic",
    ]);
    expect(chatDrawerProviderIds(config, "image_generation")).toEqual(["acp:grok"]);
    expect(chatDrawerProviderIds(config, "video_generation")).toEqual(["acp:grok"]);
  });

  it("keeps legacy Grok profiles media-capable while honoring an explicit opt-out", () => {
    const legacyGrok = enabledGrok();
    delete legacyGrok.capabilities;
    const config = makeConfig([legacyGrok]);

    expect(chatDrawerProviderIds(config, "image_generation")).toEqual(["acp:grok"]);
    expect(chatDrawerProviderIds(config, "video_generation")).toEqual(["acp:grok"]);

    config.acp_bridge.profiles[0].capabilities = {
      image_generation: false,
      video_generation: false,
    };
    expect(chatDrawerProviderIds(config, "image_generation")).toEqual([]);
    expect(chatDrawerProviderIds(config, "video_generation")).toEqual([]);
  });

  it("requires both the ACP bridge and profile to be enabled for media routing", () => {
    const grok = enabledGrok();

    expect(chatDrawerProviderIds(makeConfig([grok], false), "image_generation")).toEqual([]);

    grok.enabled = false;
    expect(chatDrawerProviderIds(makeConfig([grok]), "video_generation")).toEqual([]);
  });

  it("normalizes a saved legacy Grok profile with media capabilities and safe args", async () => {
    const legacyGrok = enabledGrok();
    delete legacyGrok.capabilities;
    legacyGrok.id = " grok ";
    legacyGrok.args = ["agent", "stdio"];
    invokeMock.mockResolvedValue(makeConfig([legacyGrok]));

    await useAiStore.getState().loadConfig();

    expect(useAiStore.getState().config?.acp_bridge.profiles[0].capabilities).toEqual({
      image_generation: true,
      video_generation: true,
    });
    expect(useAiStore.getState().config?.acp_bridge.profiles[0].args).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "stdio",
    ]);
  });
});
