import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./appStore";
import {
  MAX_QUEUED_SENDS,
  isChatCapableTabType,
  useChatStore,
  type ChatThread,
} from "./chatStore";
import type { ChatAttachment } from "../lib/chat/attachments";
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

function attachment(path: string): ChatAttachment {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { id: `att-${name}`, kind: "file", name, path, size: 1024, mime: "text/plain" };
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

describe("chatStore sendPromptToTabChat", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(listen).mockResolvedValue(() => undefined);
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    const thread = makeThread({
      id: "thread-code",
      provider_id: "deepseek",
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
      drawerOpen: false,
      drawerScope: "tab",
      drawerTabId: "code-tab",
      tabDrawerOpenByTabId: {},
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
      codeWorkspaceByTab: {},
    });
    invokeMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const PROMPT = [
    "请把下面这段代码当作教学示例，讲解其中用到的语言语法与写法。",
    "",
    "## 上下文",
    "- 文件: src/lib.rs",
    "",
    "```rust",
    "impl Foo {}",
    "```",
  ].join("\n");

  // sendPromptToTabChat routes through enqueueMessage, which hands the prompt to
  // sendMessage without awaiting it (the send owns its own loading state). Spy on
  // that boundary: what reaches sendMessage is this method's contract, and
  // sendMessage's own path to chat_stream is covered by the context-bridge suite
  // above. The trailing two args are the queue's terminalContext/attachments
  // pass-through, undefined for a bare prompt.
  function spyOnSendMessage() {
    const sendMessage = vi.fn(async (_threadId: string, _content: string) => undefined);
    useChatStore.setState({ sendMessage });
    return sendMessage;
  }

  it("sends the prompt verbatim, without blockquote prefixes", async () => {
    const sendMessage = spyOnSendMessage();
    await useChatStore.getState().sendPromptToTabChat(PROMPT);

    expect(sendMessage).toHaveBeenCalledWith("thread-code", PROMPT, undefined, undefined);
    // Regression guard: attachToComposer's "> " prefix would fold the
    // instructions and the code fence into a single quoted block.
    const sent = sendMessage.mock.calls[0]?.[1] ?? "";
    expect(sent.split("\n").some((line) => line.startsWith(">"))).toBe(false);
    expect(sent).toContain("```rust");
  });

  it("auto-sends instead of staging in the composer", async () => {
    const sendMessage = spyOnSendMessage();
    await useChatStore.getState().sendPromptToTabChat(PROMPT);

    expect(useChatStore.getState().pendingComposerText).toBe("");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reuses the tab's thread so follow-ups stay in context", async () => {
    spyOnSendMessage();
    await useChatStore.getState().sendPromptToTabChat(PROMPT);

    expect(invokeMock).not.toHaveBeenCalledWith("chat_new_thread", expect.anything());
    expect(useChatStore.getState().threads).toHaveLength(1);
    expect(useChatStore.getState().activeThreadId).toBe("thread-code");
  });

  it("opens the drawer for the bound tab", async () => {
    spyOnSendMessage();
    await useChatStore.getState().sendPromptToTabChat(PROMPT);

    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "code-tab",
    });
    expect(useChatStore.getState().tabDrawerOpenByTabId["code-tab"]).toBe(true);
  });

  it("ignores a blank prompt", async () => {
    const sendMessage = spyOnSendMessage();
    await useChatStore.getState().sendPromptToTabChat("   \n  ");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().drawerOpen).toBe(false);
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

describe("isChatCapableTabType", () => {
  it("covers every tab kind that offers an AI action", () => {
    for (const type of [
      "welcome",
      "terminal",
      "rdp",
      "database",
      "redis",
      "hbase-shell",
      "mail",
      "git",
      "code-workspace",
    ]) {
      expect(isChatCapableTabType(type)).toBe(true);
    }
  });

  it("includes hbase-shell so its explain prompt binds to the HBase tab", () => {
    // Without this, sendPromptToTabChat falls back to the welcome tab and the
    // prompt lands in an unrelated thread.
    expect(isChatCapableTabType("hbase-shell")).toBe(true);
  });

  it("rejects tab kinds with no chat surface", () => {
    for (const type of ["nettools", "sockscap", "objectstorage", "notes", null, undefined, ""]) {
      expect(isChatCapableTabType(type)).toBe(false);
    }
  });
});

describe("chatStore send queue", () => {
  /**
   * A `sendMessage` stand-in the test controls the timing of: it flips the
   * thread's sending flag the way the real one does, then parks until the test
   * resolves it. That makes "a turn is in flight" a state the test can hold
   * open, which is the only condition under which queueing happens at all.
   */
  function controllableSendMessage(options: { throwOn?: string[] } = {}) {
    const throwOn = new Set(options.throwOn ?? []);
    const calls: string[] = [];
    // One release per in-flight turn, so nested turns started by the queue
    // executor can each be settled in order.
    const releases: Array<() => void> = [];

    const sendMessage = vi.fn(async (threadId: string, content: string) => {
      calls.push(content);
      useChatStore.setState((s) => ({
        sendingByThreadId: { ...s.sendingByThreadId, [threadId]: true },
        sending: true,
      }));
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
      } finally {
        // Mirrors the real sendMessage, which clears its thread's flag in a
        // finally block whether the turn succeeded or threw.
        useChatStore.setState((s) => {
          const next = { ...s.sendingByThreadId };
          delete next[threadId];
          return { sendingByThreadId: next, sending: Object.values(next).some(Boolean) };
        });
      }
      if (throwOn.has(content)) throw new Error(`provider exploded on ${content}`);
    });

    useChatStore.setState({ sendMessage });

    /** Settle the oldest in-flight turn and let the executor pick up the next. */
    const finishTurn = async () => {
      releases.shift()?.();
      // Several microtask hops: the release resolves the awaited promise, the
      // finally block runs, the next item is dequeued, and its sendMessage
      // reaches its own await.
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };
    return { sendMessage, calls, finishTurn };
  }

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    vi.mocked(listen).mockResolvedValue(() => undefined);
    useChatStore.setState({
      threads: [makeThread({ id: "t1" }), makeThread({ id: "t2" })],
      threadsLoaded: true,
      activeThreadId: "t1",
      messages: {},
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sendQueues: {},
      sending: false,
      composerDrafts: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends immediately when the thread is idle", async () => {
    const { calls } = controllableSendMessage();

    const result = await useChatStore.getState().enqueueMessage("t1", "first");

    expect(result).toEqual({ status: "sent" });
    expect(calls).toEqual(["first"]);
    expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
  });

  it("queues a send that arrives while a turn is in flight", async () => {
    const { calls } = controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");

    const result = await useChatStore.getState().enqueueMessage("t1", "second");

    expect(result).toEqual({ status: "queued", position: 1 });
    // Still only the first turn has reached sendMessage.
    expect(calls).toEqual(["first"]);
    expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["second"]);
  });

  it("drains the queue in FIFO order as each turn finishes", async () => {
    const { calls, finishTurn } = controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "second");
    await useChatStore.getState().enqueueMessage("t1", "third");

    expect(calls).toEqual(["first"]);

    await finishTurn();
    expect(calls).toEqual(["first", "second"]);
    expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["third"]);

    await finishTurn();
    expect(calls).toEqual(["first", "second", "third"]);
    expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
  });

  it("rejects the send that would exceed the limit, without storing it", async () => {
    const { calls } = controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "in-flight");
    for (let i = 1; i <= MAX_QUEUED_SENDS; i += 1) {
      const queued = await useChatStore.getState().enqueueMessage("t1", `queued-${i}`);
      expect(queued).toEqual({ status: "queued", position: i });
    }

    const rejected = await useChatStore.getState().enqueueMessage("t1", "one too many");

    expect(rejected).toEqual({ status: "rejected", limit: MAX_QUEUED_SENDS });
    expect(useChatStore.getState().sendQueues.t1).toHaveLength(MAX_QUEUED_SENDS);
    expect(
      useChatStore.getState().sendQueues.t1?.some((i) => i.content === "one too many"),
    ).toBe(false);
    expect(calls).toEqual(["in-flight"]);
  });

  it("keeps queues independent per thread", async () => {
    const { calls } = controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "t1-first");
    await useChatStore.getState().enqueueMessage("t1", "t1-queued");

    // A different thread is idle, so its send goes out rather than queueing
    // behind the unrelated conversation.
    const result = await useChatStore.getState().enqueueMessage("t2", "t2-first");

    expect(result).toEqual({ status: "sent" });
    expect(calls).toEqual(["t1-first", "t2-first"]);
    expect(useChatStore.getState().sendQueues.t2).toBeUndefined();
  });

  it("keeps draining after Stop — stopping skips one answer, not the queue", async () => {
    const { calls, finishTurn } = controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "second");

    await useChatStore.getState().stopSending("t1");

    // Stop must not discard what is parked behind the turn it cancelled.
    expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["second"]);

    // In production `chat_stop_stream` ends the backend stream, so the real
    // sendMessage returns and its executor advances. Settle the stopped turn to
    // stand in for that, and the queued send must actually go out.
    await finishTurn();
    expect(calls).toEqual(["first", "second"]);
    expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
  });

  it("drops one queued send by id", async () => {
    controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "keep");
    await useChatStore.getState().enqueueMessage("t1", "drop");

    const target = useChatStore.getState().sendQueues.t1?.find((i) => i.content === "drop");
    useChatStore.getState().dequeueSend("t1", target!.id);

    expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["keep"]);
  });

  it("removes the queue key once it empties", async () => {
    controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "only");

    const target = useChatStore.getState().sendQueues.t1![0];
    useChatStore.getState().dequeueSend("t1", target.id);

    expect("t1" in useChatStore.getState().sendQueues).toBe(false);
  });

  it("clears a whole queue without touching the running turn", async () => {
    const { calls } = controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "a");
    await useChatStore.getState().enqueueMessage("t1", "b");

    useChatStore.getState().clearQueue("t1");

    expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
    expect(useChatStore.getState().sendingByThreadId.t1).toBe(true);
    expect(calls).toEqual(["first"]);
  });

  it("skips a blank or thread-less send", async () => {
    const { calls } = controllableSendMessage();

    expect(await useChatStore.getState().enqueueMessage("t1", "   \n ")).toEqual({ status: "skipped" });
    expect(await useChatStore.getState().enqueueMessage("", "hello")).toEqual({ status: "skipped" });
    expect(calls).toEqual([]);
  });

  it("trims content before sending", async () => {
    const { calls } = controllableSendMessage();

    await useChatStore.getState().enqueueMessage("t1", "  padded  ");

    expect(calls).toEqual(["padded"]);
  });

  it("carries terminal context and attachments through the queue", async () => {
    const { finishTurn } = controllableSendMessage();
    const attachments = [attachment("C:\\tmp\\a.txt")];
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "second", "term-ctx", attachments);

    await finishTurn();

    expect(useChatStore.getState().sendMessage).toHaveBeenLastCalledWith(
      "t1",
      "second",
      "term-ctx",
      attachments,
    );
  });

  it("keeps draining when a turn throws", async () => {
    const { calls, finishTurn } = controllableSendMessage({ throwOn: ["boom"] });
    await useChatStore.getState().enqueueMessage("t1", "boom");
    await useChatStore.getState().enqueueMessage("t1", "after");

    await finishTurn();

    // A thrown turn must not strand the sends behind it — the executor advances
    // from its finally block, so a provider failure costs one answer, not the
    // rest of the queue.
    expect(calls).toEqual(["boom", "after"]);
    expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
  });

  it("drops queued sends when the thread is deleted", async () => {
    controllableSendMessage();
    await useChatStore.getState().enqueueMessage("t1", "first");
    await useChatStore.getState().enqueueMessage("t1", "queued");
    expect(useChatStore.getState().sendQueues.t1).toHaveLength(1);

    await useChatStore.getState().deleteThread("t1");

    expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
  });
});
