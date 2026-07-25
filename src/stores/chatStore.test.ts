import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./appStore";
import { useChatStore, type ChatThread } from "./chatStore";
import {
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_ACP_PROFILE,
  rememberChatDrawerProviderPreference,
  useAiStore,
  type AiConfig,
} from "./aiStore";
import type { Tab } from "../types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
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
        local: {
          base_url: "http://127.0.0.1:8080/v1",
          api_key: "local",
          model: "qwen3",
          runtime: "llama-server",
        },
      },
      provider_groups: {},
      fallback: { enabled: true, primary: "deepseek", secondary: "local", timeout_ms: 8000 },
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
    },
    codex_bridge: {
      enabled: false,
      binary: "auto",
      min_version: "0.100.0",
      default_model: DEFAULT_CODEX_MODEL,
      sandbox: "read-only",
      approval_policy: "never",
      network_access: false,
      proxy_url: undefined,
      confirm_readonly: false,
      terminal_echo_enabled: true,
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
    ...overrides,
  };
}

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    title: "New chat",
    provider_id: "claude-code",
    created_at: 1,
    updated_at: 1,
    linked_session_id: null,
    source: "drawer",
    mode: "chat",
    output_format: null,
    cc_model: null,
    ...overrides,
  };
}

describe("chatStore new thread provider selection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    window.localStorage.clear();
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useChatStore.setState({
      threads: [],
      threadsLoaded: true,
      activeThreadId: null,
      messages: {},
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: false,
      drawerScope: null,
      drawerTabId: null,
      tabDrawerOpenByTabId: {},
      activeThreadIdByTabId: {},
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPosition: "right",
      drawerPinned: true,
      drawerFloatingOpacity: 1,
      pendingComposerText: "",
      composerDrafts: {},
    });
    invokeMock.mockImplementation((command: string, args: { providerId?: string | null; linkedSessionId?: string | null; mode?: string | null }) => {
      if (command !== "chat_new_thread") throw new Error(`unexpected command: ${command}`);
      const thread = makeThread({
        provider_id: args.providerId ?? "deepseek",
        linked_session_id: args.linkedSessionId ?? null,
        mode: args.mode ?? "chat",
      });
      return Promise.resolve(thread);
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("uses the active LLM provider as the default even when Claude Code is enabled", async () => {
    await useChatStore.getState().newThread(undefined, "term-1");

    expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
      providerId: "deepseek",
      linkedSessionId: "term-1",
      mode: "chat",
    });
  });

  it("uses the remembered chat provider before the active LLM provider", async () => {
    rememberChatDrawerProviderPreference("local", "chat");

    await useChatStore.getState().newThread(undefined, "term-1");

    expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
      providerId: "local",
      linkedSessionId: "term-1",
      mode: "chat",
    });
  });

  it("keeps an explicitly selected provider even when Claude Code is enabled", async () => {
    await useChatStore.getState().newThread("local", undefined);

    expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
      providerId: "local",
      linkedSessionId: null,
      mode: "chat",
    });
  });

  it("reuses an existing tab thread instead of creating one for the default provider", async () => {
    useChatStore.setState({
      threads: [
        makeThread({
          id: "old-thread",
          title: "Old chat",
          provider_id: "deepseek",
          linked_session_id: "term-1",
        }),
      ],
    });

    await useChatStore.getState().openTabChat("term-1");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useChatStore.getState()).toMatchObject({
      activeThreadId: "old-thread",
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-1",
      activeThreadIdByTabId: { "term-1": "old-thread" },
    });
  });

  it("clamps and persists the floating drawer opacity preference", () => {
    useChatStore.getState().setDrawerFloatingOpacity(0.2);

    expect(useChatStore.getState().drawerFloatingOpacity).toBe(0.65);
    expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.layout.v1") ?? "{}"))
      .toMatchObject({ floatingOpacity: 0.65 });

    useChatStore.getState().setDrawerFloatingOpacity(1.2);

    expect(useChatStore.getState().drawerFloatingOpacity).toBe(1);
    expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.layout.v1") ?? "{}"))
      .toMatchObject({ floatingOpacity: 1 });
  });
});

describe("chatStore media generation", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    const thread = makeThread({
      id: "image-thread",
      provider_id: "agnes",
      mode: "image",
    });
    useChatStore.setState({
      threads: [thread],
      threadsLoaded: true,
      activeThreadId: thread.id,
      messages: { [thread.id]: [] },
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: true,
      drawerScope: null,
      drawerTabId: null,
      tabDrawerOpenByTabId: {},
      activeThreadIdByTabId: {},
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPosition: "right",
      drawerPinned: true,
      drawerFloatingOpacity: 1,
      pendingComposerText: "",
      composerDrafts: {},
    });
    invokeMock.mockImplementation((command: string) => {
      if (command !== "chat_generate_media") throw new Error(`unexpected command: ${command}`);
      return Promise.resolve({
        user_message: {
          id: "user-1",
          thread_id: "image-thread",
          role: "user",
          content: "a blue terminal window",
          created_at: 1,
          redacted: false,
          attachments: [],
        },
        assistant_message: {
          id: "assistant-1",
          thread_id: "image-thread",
          role: "assistant",
          content: "Generated image saved to:\n/tmp/image.png",
          created_at: 2,
          redacted: false,
          attachments: [{
            id: "media-1",
            kind: "image",
            path: "/tmp/image.png",
            name: "image.png",
            size: 123,
            mime: "image/png",
          }],
        },
        redacted_count: 0,
        saved_path: "/tmp/image.png",
        remote_url: null,
        video_id: null,
        model: "agnes-image-2.1-flash",
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes image threads to the media generation command", async () => {
    await useChatStore.getState().sendMessage("image-thread", "a blue terminal window");

    expect(invokeMock).toHaveBeenCalledWith("chat_generate_media", {
      req: {
        thread_id: "image-thread",
        prompt: "a blue terminal window",
        kind: "image",
        attachments: [],
      },
    });
    expect(useChatStore.getState().messages["image-thread"]).toHaveLength(2);
    expect(useChatStore.getState().messages["image-thread"][1].attachments?.[0]).toMatchObject({
      kind: "image",
      path: "/tmp/image.png",
    });
    expect(useChatStore.getState().sending).toBe(false);
  });

  it("forwards Grok reference images to video generation", async () => {
    const thread = makeThread({
      id: "grok-video-thread",
      provider_id: "acp:grok",
      mode: "video",
    });
    const reference = {
      id: "reference-1",
      kind: "image" as const,
      path: "/tmp/reference.png",
      name: "reference.png",
      size: 456,
      mime: "image/png",
    };
    useChatStore.setState({
      threads: [thread],
      activeThreadId: thread.id,
      messages: { [thread.id]: [] },
    });

    await useChatStore.getState().sendMessage(
      thread.id,
      "Animate this terminal glow",
      undefined,
      [reference],
    );

    expect(invokeMock).toHaveBeenCalledWith("chat_generate_media", {
      req: {
        thread_id: "grok-video-thread",
        prompt: "Animate this terminal glow",
        kind: "video",
        attachments: [reference],
      },
    });
  });
});

describe("chatStore DB MCP context bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(listen).mockResolvedValue(() => undefined);
    const thread = makeThread({
      id: "thread-db",
      provider_id: "claude-code",
      linked_session_id: "db-tab",
    });
    useChatStore.setState({
      threads: [thread],
      threadsLoaded: true,
      activeThreadId: thread.id,
      messages: { [thread.id]: [] },
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "db-tab",
      tabDrawerOpenByTabId: { "db-tab": true },
      activeThreadIdByTabId: { "db-tab": thread.id },
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPosition: "right",
      drawerPinned: true,
      drawerFloatingOpacity: 1,
      pendingComposerText: "",
      composerDrafts: {},
    });
    useAppStore.setState({
      tabs: [
        {
          id: "db-tab",
          type: "database",
          title: "MySQL",
          closable: true,
          sessionId: "saved-db",
        } as Tab,
      ],
      activeTabId: "db-tab",
      cwdByTab: {},
      dbConnByTab: { "db-tab": "saved-db::runtime" },
      dbSelectedObjectsByTab: {
        "db-tab": [
          {
            catalog: null,
            schema: "shop",
            name: "orders",
            kind: "table",
          },
          {
            catalog: null,
            schema: "shop",
            name: "sp_sync",
            kind: "procedure",
          },
        ],
      },
    });
    invokeMock.mockImplementation((command: string) => {
      if (command !== "chat_stream") throw new Error(`unexpected command: ${command}`);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends the live DB connection and selected objects with each turn", async () => {
    await useChatStore.getState().sendMessage("thread-db", "select 多选表前10条记录");

    expect(invokeMock).toHaveBeenCalledWith("chat_stream", {
      req: expect.objectContaining({
        thread_id: "thread-db",
        bound_session_id: "saved-db",
        bound_db_connection_id: "saved-db::runtime",
        bound_db_selected_objects: [
          {
            catalog: null,
            schema: "shop",
            name: "orders",
            kind: "table",
          },
          {
            catalog: null,
            schema: "shop",
            name: "sp_sync",
            kind: "procedure",
          },
        ],
      }),
    });
  });
});

describe("chatStore code workspace context bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(listen).mockResolvedValue(() => undefined);
    const thread = makeThread({
      id: "thread-code",
      provider_id: "codex",
      linked_session_id: "code-tab",
    });
    useChatStore.setState({
      threads: [thread],
      threadsLoaded: true,
      activeThreadId: thread.id,
      messages: { [thread.id]: [] },
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "code-tab",
      tabDrawerOpenByTabId: { "code-tab": true },
      activeThreadIdByTabId: { "code-tab": thread.id },
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPosition: "right",
      drawerPinned: true,
      drawerFloatingOpacity: 1,
      pendingComposerText: "",
      composerDrafts: {},
    });
    useAppStore.setState({
      tabs: [
        {
          id: "code-tab",
          type: "code-workspace",
          title: "Code · app",
          closable: true,
          codeWorkspace: { repoRoot: "/repo/app" },
        } as Tab,
      ],
      activeTabId: "code-tab",
      codeWorkspaceByTab: {
        "code-tab": {
          repoRoot: "/repo/app",
          activePath: "src/main.ts",
          openPaths: ["src/main.ts", "src/lib.ts"],
          dirtyPaths: ["src/main.ts"],
        },
      },
    });
    invokeMock.mockImplementation((command: string) => {
      if (command !== "chat_stream") throw new Error(`unexpected command: ${command}`);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends the active code workspace with each bound turn", async () => {
    await useChatStore.getState().sendMessage("thread-code", "review current edits");

    expect(invokeMock).toHaveBeenCalledWith("chat_stream", {
      req: expect.objectContaining({
        thread_id: "thread-code",
        code_workspace: {
          repoRoot: "/repo/app",
          activePath: "src/main.ts",
          openPaths: ["src/main.ts", "src/lib.ts"],
          dirtyPaths: ["src/main.ts"],
        },
      }),
    });
  });
});

describe("chatStore drawer lifecycle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useChatStore.setState({
      threads: [
        makeThread({ id: "thread-a", linked_session_id: "term-a" }),
        makeThread({ id: "thread-b", linked_session_id: "term-b" }),
        makeThread({ id: "global-thread", linked_session_id: null }),
      ],
      threadsLoaded: true,
      activeThreadId: "thread-a",
      messages: {},
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: { "thread-a": true },
      sending: true,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-a",
      tabDrawerOpenByTabId: { "term-a": true },
      activeThreadIdByTabId: { "term-a": "thread-a" },
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPosition: "right",
      drawerPinned: true,
      drawerFloatingOpacity: 1,
      pendingComposerText: "",
      composerDrafts: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hides a tab-bound drawer on active-tab sync without stopping the running thread", async () => {
    await useChatStore.getState().syncTabChatWithActiveTab("term-b");

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerScope: "tab",
      drawerTabId: "term-b",
      sending: true,
      sendingByThreadId: { "thread-a": true },
      tabDrawerOpenByTabId: { "term-a": true },
    });
  });

  it("hides a tab-bound drawer when switching to a non-chat tab without stopping", async () => {
    await useChatStore.getState().syncTabChatWithActiveTab(null);

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerTabId: null,
      sending: true,
      sendingByThreadId: { "thread-a": true },
      tabDrawerOpenByTabId: { "term-a": true },
    });
  });

  it("lets automatic visibility changes hide the drawer without stopping", () => {
    useChatStore.getState().setDrawerOpen(false);

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      sending: true,
      sendingByThreadId: { "thread-a": true },
    });
  });

  it("dismisses the active tab drawer and prevents tab sync from reopening it", async () => {
    useChatStore.getState().dismissDrawer();

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      sending: true,
      sendingByThreadId: { "thread-a": true },
      tabDrawerOpenByTabId: { "term-a": false },
    });

    await useChatStore.getState().syncTabChatWithActiveTab("term-a");

    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      tabDrawerOpenByTabId: { "term-a": false },
    });
  });

  it("hides the active tab drawer without stopping the running thread", async () => {
    await useChatStore.getState().toggleTabChat("term-a");

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      sending: true,
      sendingByThreadId: { "thread-a": true },
      tabDrawerOpenByTabId: { "term-a": false },
    });
  });

  it("restores each tab's remembered current thread without creating a new one", async () => {
    useChatStore.setState({
      threads: [
        makeThread({ id: "thread-a-latest", linked_session_id: "term-a", updated_at: 3 }),
        makeThread({ id: "thread-a-current", linked_session_id: "term-a", updated_at: 2 }),
        makeThread({ id: "thread-b", linked_session_id: "term-b", updated_at: 1 }),
      ],
      activeThreadId: "thread-a-current",
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-a",
      tabDrawerOpenByTabId: { "term-a": true, "term-b": true },
      activeThreadIdByTabId: {
        "term-a": "thread-a-current",
        "term-b": "thread-b",
      },
    });

    await useChatStore.getState().syncTabChatWithActiveTab("term-b");

    expect(useChatStore.getState()).toMatchObject({
      activeThreadId: "thread-b",
      drawerOpen: true,
      drawerTabId: "term-b",
    });

    await useChatStore.getState().syncTabChatWithActiveTab("term-a");

    expect(invokeMock).not.toHaveBeenCalledWith("chat_new_thread", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      activeThreadId: "thread-a-current",
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-a",
      activeThreadIdByTabId: {
        "term-a": "thread-a-current",
        "term-b": "thread-b",
      },
    });
  });
});
