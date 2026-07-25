import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_ACP_PROFILE,
  useAiStore,
  type AiConfig,
} from "../../stores/aiStore";
import { AcpAgentsPanel } from "./AcpAgentsPanel";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function makeConfig(): AiConfig {
  return {
    asr: {
      active: "local",
      providers: { local: { engine: "sherpa-onnx", model: "local" } },
      warm_on_startup: false,
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
      fallback: { enabled: false, primary: "deepseek", secondary: "deepseek", timeout_ms: 8000 },
      task_routing: { chat_drawer: "deepseek" },
    },
    web_search: {
      client_provider: "searxng",
      client_enabled: false,
      confirm_mode: "per_call",
      byok_key: "",
    },
    cc_bridge: {
      enabled: false,
      binary: "auto",
      min_version: "1.0.0",
      default_model: DEFAULT_CLAUDE_CODE_MODEL,
      permission_mode: "default",
      max_turns: 20,
    },
    codex_bridge: {
      enabled: false,
      binary: "auto",
      min_version: "0.100.0",
      default_model: DEFAULT_CODEX_MODEL,
      sandbox: "read-only",
      approval_policy: "never",
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

describe("AcpAgentsPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_sessions") return Promise.resolve([]);
      if (command === "save_ai_config") return Promise.resolve(null);
      if (command === "acp_probe_profile") {
        return Promise.resolve({
          profileId: "grok",
          ok: true,
          message: "ACP handshake succeeded: Grok CLI 0.2.101 (protocol v1).",
          agent: {
            protocolVersion: 1,
            name: "grok",
            title: "Grok CLI",
            version: "0.2.101",
            supportsSessionLoad: true,
            supportsMcpHttp: true,
            supportsMcpSse: false,
            authMethods: [],
          },
        });
      }
      return Promise.resolve(null);
    });
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

  it("saves Grok as a generic ACP profile with explicit proxy policy", async () => {
    const user = userEvent.setup();
    render(<AcpAgentsPanel />);

    await user.click(screen.getByTestId("acp-bridge-enabled"));
    expect(screen.getByTestId("acp-profile-grok-enabled")).toBeChecked();
    await user.click(screen.getByTestId("acp-global-proxy-app"));
    await user.click(screen.getByTestId("acp-save"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "save_ai_config",
      expect.objectContaining({
        config: expect.objectContaining({
          acp_bridge: expect.objectContaining({
            enabled: true,
            proxy_mode: "app",
            profiles: [expect.objectContaining({
              id: "grok",
              command: "grok",
              args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
              enabled: true,
            })],
          }),
        }),
      }),
    ));

    const savedConfig = useAiStore.getState().config;
    expect(savedConfig?.llm.providers).not.toHaveProperty("grok");
    expect(savedConfig?.llm.providers).not.toHaveProperty("xai");
  });

  it("keeps the bridge and profile enable switches consistent", async () => {
    const user = userEvent.setup();
    render(<AcpAgentsPanel />);

    const bridge = screen.getByTestId("acp-bridge-enabled");
    const profile = screen.getByTestId("acp-profile-grok-enabled");

    await user.click(profile);
    expect(profile).toBeChecked();
    expect(bridge).toHaveAttribute("aria-pressed", "true");

    await user.click(profile);
    expect(profile).not.toBeChecked();
    expect(bridge).toHaveAttribute("aria-pressed", "false");
  });

  it("shows negotiated ACP capabilities from the bounded profile probe", async () => {
    render(<AcpAgentsPanel />);

    fireEvent.click(screen.getByTestId("acp-profile-grok-probe"));

    expect(await screen.findByTestId("acp-profile-grok-probe-result"))
      .toHaveTextContent("ACP handshake succeeded: Grok CLI 0.2.101");
    expect(screen.getByTestId("acp-profile-grok-probe-result"))
      .toHaveTextContent("Session load: Yes · HTTP MCP: Yes");
    expect(invokeMock).toHaveBeenCalledWith("acp_probe_profile", { profileId: "grok" });
  });
});
