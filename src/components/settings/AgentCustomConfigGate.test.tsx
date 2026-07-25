import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_ACP_PROFILE,
  useAiStore,
  type AiConfig,
} from "../../stores/aiStore";
import { ClaudeCodePanel } from "./ClaudeCodePanel";
import { CodexCodePanel } from "./CodexCodePanel";

const invokeMock = vi.hoisted(() => vi.fn());
const ensureVaultReadyMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("../../lib/vaultGate", () => ({
  useVaultGate: () => ensureVaultReadyMock,
}));

function makeConfig(): AiConfig {
  return {
    asr: {
      active: "sherpa-zipformer-zh-en",
      providers: {
        "sherpa-zipformer-zh-en": {
          engine: "sherpa-onnx",
          model: "streaming-zipformer-bilingual-zh-en-small",
        },
      },
      warm_on_startup: true,
      vad: "silero",
    },
    llm: {
      active: "deepseek",
      providers: {
        deepseek: {
          base_url: "https://api.deepseek.com/v1",
          api_key: "",
          model: "deepseek-chat",
          runtime: "openai-compat",
        },
      },
      provider_groups: {},
      fallback: { enabled: true, primary: "deepseek", secondary: "deepseek", timeout_ms: 8000 },
      task_routing: { chat_drawer: "deepseek" },
    },
    web_search: {
      client_provider: "searxng",
      client_enabled: false,
      confirm_mode: "per_call",
      byok_key: "",
    },
    cc_bridge: {
      enabled: true,
      binary: "auto",
      min_version: "1.0.0",
      default_model: DEFAULT_CLAUDE_CODE_MODEL,
      permission_mode: "default",
      max_turns: 20,
      confirm_readonly: false,
      terminal_echo_enabled: true,
      custom_settings_profiles: [],
    },
    codex_bridge: {
      enabled: true,
      binary: "auto",
      min_version: "0.100.0",
      default_model: DEFAULT_CODEX_MODEL,
      sandbox: "read-only",
      approval_policy: "never",
      network_access: false,
      proxy_mode: "none",
      confirm_readonly: false,
      terminal_echo_enabled: true,
      custom_config_profiles: [],
    },
    acp_bridge: {
      enabled: false,
      active_profile_id: "grok",
      proxy_mode: "direct",
      request_timeout_seconds: 120,
      profiles: [{ ...DEFAULT_GROK_ACP_PROFILE, args: [...DEFAULT_GROK_ACP_PROFILE.args] }],
    },
    full_local_mode: false,
    fully_disabled: false,
    chat_output_format: "md",
    chat_send_shortcut: "ctrl_enter",
  };
}

describe("agent custom config vault gate", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    ensureVaultReadyMock.mockReset();
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not open Claude Code custom settings when the vault gate is cancelled", async () => {
    const user = userEvent.setup();
    ensureVaultReadyMock.mockResolvedValue(false);

    render(<ClaudeCodePanel />);

    await user.click(screen.getByRole("button", { name: /Manage Profiles/i }));

    await waitFor(() => expect(ensureVaultReadyMock).toHaveBeenCalled());
    expect(screen.queryByText("Claude Code Settings Profiles")).not.toBeInTheDocument();
  });

  it("opens Claude Code custom settings after the vault gate succeeds", async () => {
    const user = userEvent.setup();
    ensureVaultReadyMock.mockResolvedValue(true);

    render(<ClaudeCodePanel />);

    await user.click(screen.getByRole("button", { name: /Manage Profiles/i }));

    expect(await screen.findByText("Claude Code Settings Profiles")).toBeInTheDocument();
  });

  it("does not open Codex custom config when the vault gate is cancelled", async () => {
    const user = userEvent.setup();
    ensureVaultReadyMock.mockResolvedValue(false);

    render(<CodexCodePanel />);

    await user.click(screen.getByRole("button", { name: /Manage Profiles/i }));

    await waitFor(() => expect(ensureVaultReadyMock).toHaveBeenCalled());
    expect(screen.queryByText("Codex Config Profiles")).not.toBeInTheDocument();
  });

  it("opens Codex custom config after the vault gate succeeds", async () => {
    const user = userEvent.setup();
    ensureVaultReadyMock.mockResolvedValue(true);

    render(<CodexCodePanel />);

    await user.click(screen.getByRole("button", { name: /Manage Profiles/i }));

    expect(await screen.findByText("Codex Config Profiles")).toBeInTheDocument();
  });
});
