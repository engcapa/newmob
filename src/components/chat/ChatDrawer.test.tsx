import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDrawer, ChatDrawerRibbon } from "./ChatDrawer";
import { useAppStore } from "../../stores/appStore";
import { useChatStore, type ChatThread } from "../../stores/chatStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { useNotesStore } from "../../stores/notesStore";
import { DEFAULT_TAO_ALERT_HISTORY_LIMIT, useTaoAlertStore } from "../../stores/taoAlertStore";
import {
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_ACP_PROFILE,
  useAiStore,
  type AiConfig,
} from "../../stores/aiStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

function resetTaoAlertStore() {
  useTaoAlertStore.setState({
    aiDone: [],
    mailNew: [],
    history: [],
    historyLimit: DEFAULT_TAO_ALERT_HISTORY_LIMIT,
  });
}

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
        local: {
          base_url: "http://127.0.0.1:8080/v1",
          api_key: "local",
          model: "qwen3",
          runtime: "llama-server",
        },
        deepseek: {
          base_url: "https://api.deepseek.com/v1",
          api_key: "",
          model: "deepseek-chat",
          runtime: "openai-compat",
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
  };
}

describe("ChatDrawer provider and echo controls", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      if (command === "get_ai_config") return Promise.resolve(makeConfig());
      if (command === "save_ai_config") return Promise.resolve(null);
      if (command === "notes_list") return Promise.resolve([]);
      if (command === "notes_get_prefs") return Promise.resolve({});
      if (command === "notes_list_alerts") return Promise.resolve([]);
      if (command === "notes_list_tags") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const thread: ChatThread = {
      id: "thread-1",
      title: "New chat",
      provider_id: "claude-code",
      created_at: 1,
      updated_at: 1,
      linked_session_id: "term-1",
      source: "drawer",
      mode: "chat",
      output_format: null,
      cc_model: null,
    };
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
      activeTabId: "term-1",
      sqlEcho: false,
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
      drawerTabId: "term-1",
      tabDrawerOpenByTabId: { "term-1": true },
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
    cleanup();
    window.localStorage.clear();
    vi.clearAllMocks();
    useTaoHubStore.setState({ hubTab: "chat" });
    resetTaoAlertStore();
    useNotesStore.setState({ alerts: [] });
  });

  it("puts the active LLM provider before local agents", () => {
    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual([
      "deepseek",
      "local",
      "claude-code",
    ]);
  });

  it("includes provider groups in the manual provider picker", () => {
    const config = makeConfig();
    config.llm.provider_groups = {
      balanced: {
        label: "Balanced",
        provider_ids: ["deepseek", "local"],
        enabled: true,
      },
    };
    useAiStore.setState({ config });

    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual([
      "deepseek",
      "local",
      "group:balanced",
      "claude-code",
    ]);
    expect(Array.from(provider.options).map((option) => option.textContent)).toContain("Group: Balanced");
  });

  it("lists enabled ACP profiles by display name without adding an xAI provider", () => {
    const config = makeConfig();
    config.acp_bridge.enabled = true;
    config.acp_bridge.profiles[0].enabled = true;
    useAiStore.setState({ config });

    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toContain("acp:grok");
    expect(Array.from(provider.options).map((option) => option.textContent)).toContain("Grok CLI (ACP)");
    expect(config.llm.providers).not.toHaveProperty("grok");
    expect(config.llm.providers).not.toHaveProperty("xai");
  });

  it("migrates bridge-only ACP enablement into a visible preferred profile", async () => {
    const config = makeConfig();
    config.acp_bridge.enabled = true;
    config.acp_bridge.profiles[0].enabled = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_ai_config") return Promise.resolve(config);
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      return Promise.resolve(null);
    });

    await act(async () => {
      await useAiStore.getState().loadConfig();
    });
    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toContain("acp:grok");
    expect(useAiStore.getState().config?.acp_bridge.profiles[0].enabled).toBe(true);
  });

  it("remembers provider changes from the thread picker", () => {
    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "deepseek" } });

    expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.provider.v1") ?? "{}")).toMatchObject({
      chat: "deepseek",
    });
    expect(invokeMock).toHaveBeenCalledWith("chat_set_thread_provider", {
      threadId: "thread-1",
      providerId: "deepseek",
    });
  });

  it("renders terminal echo as the same compact button style as echo toggles", () => {
    render(<ChatDrawer />);

    const echo = screen.getByTestId("chat-cc-terminal-echo-toggle");
    expect(echo).toHaveClass("taomni-btn");
    expect(echo).toHaveAttribute("aria-pressed", "true");
    expect(echo).toHaveTextContent("Terminal echo: on");
  });

  it("offers Grok CLI and its reference-image attachment control in media modes", () => {
    const config = makeConfig();
    config.llm.providers.agnes = {
      base_url: "https://apihub.agnes-ai.com/v1",
      api_key: "",
      model: "agnes-2.0-flash",
      runtime: "openai-compat",
      capabilities: { chat: true, image_generation: true, video_generation: true },
      image_model: "agnes-image-2.1-flash",
      video_model: "agnes-video-v2.0",
    };
    config.acp_bridge.enabled = true;
    config.acp_bridge.profiles[0].enabled = true;
    invokeMock.mockImplementation((command: string) => {
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      if (command === "get_ai_config") return Promise.resolve(config);
      if (command === "save_ai_config") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const imageThread: ChatThread = {
      ...useChatStore.getState().threads[0],
      provider_id: "acp:grok",
      mode: "image",
    };
    useAiStore.setState({ config });
    useChatStore.setState({
      threads: [imageThread],
      activeThreadId: imageThread.id,
      messages: { [imageThread.id]: [] },
    });

    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual(["agnes", "acp:grok"]);
    expect(screen.getByTestId("chat-mode-image")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ai-chat-attach-button")).toBeVisible();
  });
});

describe("ChatDrawer layout resizing", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      if (command === "get_ai_config") return Promise.resolve(makeConfig());
      return Promise.resolve(null);
    });

    const thread: ChatThread = {
      id: "thread-1",
      title: "New chat",
      provider_id: "claude-code",
      created_at: 1,
      updated_at: 1,
      linked_session_id: "term-1",
      source: "drawer",
      mode: "chat",
      output_format: null,
      cc_model: null,
    };
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
      activeTabId: "term-1",
      sqlEcho: false,
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
      drawerTabId: "term-1",
      tabDrawerOpenByTabId: { "term-1": true },
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPinned: false,
      drawerFloatingOpacity: 1,
      pendingComposerText: "",
      composerDrafts: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useTaoHubStore.setState({ hubTab: "chat" });
    resetTaoAlertStore();
    useNotesStore.setState({ alerts: [] });
  });

  it("dismisses a floating drawer on outside pointer down", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
    render(<ChatDrawer />);

    fireEvent.pointerDown(document.body);

    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      tabDrawerOpenByTabId: { "term-1": false },
    });
  });

  it("keeps the drawer mounted while closed and does not re-animate scroll on reopen", async () => {
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    useChatStore.setState({
      drawerPosition: "right",
      drawerPinned: true,
      messages: {
        "thread-1": [
          {
            id: "m1",
            thread_id: "thread-1",
            role: "user",
            content: "hello",
            created_at: 1,
            redacted: false,
          },
          {
            id: "m2",
            thread_id: "thread-1",
            role: "assistant",
            content: "world",
            created_at: 2,
            redacted: false,
          },
        ],
      },
    });

    render(<ChatDrawer />);
    const drawer = screen.getByTestId("ai-chat-drawer");
    expect(drawer).not.toHaveStyle({ display: "none" });

    // Initial open + thread align uses instant scroll, never smooth.
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
    expect(scrollIntoView.mock.calls.every((call) => call[0]?.behavior !== "smooth")).toBe(true);
    scrollIntoView.mockClear();

    act(() => {
      useChatStore.setState({ drawerOpen: false });
    });
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveStyle({ display: "none" });
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState({ drawerOpen: true });
    });
    expect(drawer).not.toHaveStyle({ display: "none" });
    // Same thread re-shown: preserve scroll, do not jump/animate again.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a floating drawer open when the AI safety gate is clicked", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
    render(
      <>
        <ChatDrawer />
        <div data-testid="ai-chat-safety-gate">Safety gate</div>
      </>,
    );

    fireEvent.pointerDown(screen.getByTestId("ai-chat-safety-gate"));

    expect(useChatStore.getState().drawerOpen).toBe(true);
  });

  it("keeps a floating drawer open when a Tao portal popover is clicked", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
    render(
      <>
        <ChatDrawer />
        <div data-testid="notes-date-popover" data-tao-floating-portal="notes-date-time">Date picker</div>
      </>,
    );

    fireEvent.pointerDown(screen.getByTestId("notes-date-popover"));

    expect(useChatStore.getState().drawerOpen).toBe(true);
  });

  it("resizes a top drawer by dragging its bottom edge", () => {
    useChatStore.setState({ drawerPosition: "top" });
    render(<ChatDrawer />);

    const handle = screen.getByTestId("ai-chat-drawer-height-resize");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400, clientY: 420 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 520 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 520 });

    expect(useChatStore.getState().drawerHeight).toBe(520);
  });

  it("resizes a bottom drawer by dragging its top edge", () => {
    useChatStore.setState({ drawerPosition: "bottom" });
    render(<ChatDrawer />);

    const handle = screen.getByTestId("ai-chat-drawer-height-resize");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400, clientY: 420 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 320 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 320 });

    expect(useChatStore.getState().drawerHeight).toBe(520);
  });

  it("pins the drawer to the top edge as a full-width inline band", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: true });
    render(<ChatDrawer />);
    const drawer = screen.getByTestId("ai-chat-drawer");
    expect(drawer).toHaveAttribute("data-position", "top");
    expect(drawer).toHaveAttribute("data-pinned", "true");
    expect(drawer.className).toContain("w-full");
    const pin = screen.getByTestId("ai-chat-drawer-pin");
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin).not.toBeDisabled();
  });

  it("does not dismiss a pinned top drawer on outside pointer down", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: true });
    render(<ChatDrawer />);
    fireEvent.pointerDown(document.body);
    expect(useChatStore.getState().drawerOpen).toBe(true);
  });

  it("keeps left/right pin as a side column (no regression)", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    useChatStore.setState({ drawerPosition: "right", drawerPinned: true });
    render(<ChatDrawer />);
    const drawer = screen.getByTestId("ai-chat-drawer");
    expect(drawer.className).toContain("relative");
    expect(drawer.className).not.toContain("w-full");
    expect(screen.getByTestId("ai-chat-drawer-pin")).toHaveAttribute("aria-pressed", "true");
  });

  it("adjusts opacity only for top or bottom floating drawers", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    useChatStore.setState({
      drawerPosition: "top",
      drawerPinned: false,
      drawerFloatingOpacity: 0.8,
    });
    render(<ChatDrawer />);

    expect(screen.getByTestId("ai-chat-drawer")).toHaveStyle("opacity: 0.8");
    fireEvent.click(screen.getByTestId("ai-chat-drawer-opacity"));
    const slider = screen.getByTestId("ai-chat-drawer-opacity-slider") as HTMLInputElement;
    expect(slider.value).toBe("0.8");

    fireEvent.change(slider, { target: { value: "0.7" } });

    expect(useChatStore.getState().drawerFloatingOpacity).toBe(0.7);
    expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.layout.v1") ?? "{}"))
      .toMatchObject({ floatingOpacity: 0.7 });
  });

  it("does not show opacity controls for left or right floating drawers", () => {
    useChatStore.setState({
      drawerPosition: "left",
      drawerPinned: false,
      drawerFloatingOpacity: 0.75,
    });
    render(<ChatDrawer />);

    expect(screen.getByTestId("ai-chat-drawer")).not.toHaveStyle("opacity: 0.75");
    expect(screen.queryByTestId("ai-chat-drawer-opacity")).not.toBeInTheDocument();
  });

  it("shows the Tao Hub tab strip with Chat and Notes tabs", () => {
    useTaoHubStore.setState({ hubTab: "chat" });
    render(<ChatDrawer />);
    expect(screen.getByTestId("tao-hub-tab-chat")).toBeInTheDocument();
    expect(screen.getByTestId("tao-hub-tab-notes")).toBeInTheDocument();
    expect(screen.getByTestId("tao-hub-tab-notifications")).toBeInTheDocument();
    // Chat tab active by default → composer present, notes panel absent.
    expect(screen.queryByTestId("notes-panel")).not.toBeInTheDocument();
  });

  it("switches to the Notes tab and back without losing the chat view", () => {
    useTaoHubStore.setState({ hubTab: "chat" });
    render(<ChatDrawer />);

    fireEvent.click(screen.getByTestId("tao-hub-tab-notes"));
    expect(useTaoHubStore.getState().hubTab).toBe("notes");
    expect(screen.getByTestId("notes-panel")).toBeInTheDocument();
    expect(screen.getByTestId("notes-new")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tao-hub-tab-chat"));
    expect(useTaoHubStore.getState().hubTab).toBe("chat");
    expect(screen.queryByTestId("notes-panel")).not.toBeInTheDocument();
  });

  it("opens mail notifications as a Tao Hub tab and clears only the clicked mail tab", () => {
    useTaoHubStore.setState({ hubTab: "chat" });
    useAppStore.setState({
      tabs: [
        { id: "term-1", type: "terminal", title: "Terminal 1", closable: true },
        { id: "mail-1", type: "mail", title: "Work mail", closable: true },
        { id: "mail-2", type: "mail", title: "Ops mail", closable: true },
      ],
      activeTabId: "term-1",
    });
    useTaoAlertStore.setState({
      mailNew: [
        {
          id: "mail:mail-1",
          source: "mail",
          kind: "mail_new",
          title: "Work mail",
          count: 3,
          mailTabId: "mail-1",
          mailAccountId: "acct-1",
          fireAt: 1,
        },
        {
          id: "mail:mail-2",
          source: "mail",
          kind: "mail_new",
          title: "Ops mail",
          count: 1,
          mailTabId: "mail-2",
          mailAccountId: "acct-2",
          fireAt: 2,
        },
      ],
    });

    render(<ChatDrawer />);

    fireEvent.click(screen.getByTestId("tao-hub-tab-notifications"));
    expect(screen.getByTestId("tao-alert-inbox")).toBeInTheDocument();
    expect(screen.getAllByTestId("tao-alert-inbox-item")).toHaveLength(2);
    expect(screen.getByTestId("tao-hub-notifications-badge")).toHaveTextContent("4");

    fireEvent.click(screen.getAllByTestId("tao-alert-jump")[0]);

    expect(useAppStore.getState().activeTabId).toBe("mail-1");
    expect(useTaoAlertStore.getState().mailNew.map((alert) => alert.mailTabId)).toEqual(["mail-2"]);
  });

  it("keeps dismissed notifications hidden until history is searched and supports clearing history", async () => {
    useTaoHubStore.setState({ hubTab: "notifications" });
    useTaoAlertStore.setState({
      mailNew: [
        {
          id: "mail:mail-1",
          source: "mail",
          kind: "mail_new",
          title: "Work mail",
          count: 2,
          mailTabId: "mail-1",
          mailAccountId: "acct-1",
          fireAt: 10,
        },
      ],
    });

    render(<ChatDrawer />);

    expect(screen.getByTestId("tao-alert-inbox-item")).toBeInTheDocument();
    expect(screen.queryByTestId("tao-alert-history-result")).not.toBeInTheDocument();
    await waitFor(() => expect(useTaoAlertStore.getState().history).toHaveLength(1));

    fireEvent.click(screen.getByTestId("tao-alert-ack"));
    expect(screen.queryByTestId("tao-alert-inbox-item")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("tao-alert-history-search"), { target: { value: "Work" } });
    expect(screen.getByTestId("tao-alert-history-result")).toHaveTextContent("Work mail");

    fireEvent.click(screen.getByTestId("tao-alert-history-clear"));
    expect(screen.queryByTestId("tao-alert-history-result")).not.toBeInTheDocument();
    expect(useTaoAlertStore.getState().history).toHaveLength(0);
  });
});

describe("ChatDrawerRibbon", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useNotesStore.setState({ alerts: [] });
    resetTaoAlertStore();
  });

  it("shows only Tao and opens the stable chat tab id", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{
        id: "visual-tab",
        chatTabId: "stable-chat-tab",
        type: "terminal",
        title: "Terminal",
        closable: true,
      }],
      activeTabId: "visual-tab",
    });
    useChatStore.setState({
      drawerOpen: false,
      drawerPosition: "left",
      drawerPinned: true,
      openTabChat,
    });

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
    expect(ribbon).toHaveTextContent(/^Tao$/);
    expect(ribbon).toHaveClass("rounded-r-full");
    fireEvent.click(ribbon);
    expect(openTabChat).toHaveBeenCalledWith("stable-chat-tab");
  });

  it("shows Tao for git tabs and opens the git tab chat", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{
        id: "git-tab",
        type: "git",
        title: "Git taomni",
        closable: true,
        git: { repoRoot: "/repo/taomni" },
      }],
      activeTabId: "git-tab",
    });
    useChatStore.setState({
      drawerOpen: false,
      drawerPosition: "left",
      drawerPinned: true,
      openTabChat,
    });

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
    expect(ribbon).toHaveTextContent(/^Tao$/);
    fireEvent.click(ribbon);
    expect(openTabChat).toHaveBeenCalledWith("git-tab");
  });

  it.each([
    ["left", 4, 300],
    ["right", 796, 300],
    ["top", 400, 4],
    ["bottom", 400, 596],
  ] as const)("docks the ribbon to the nearest %s edge when dragged", (expected, clientX, clientY) => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal", closable: true }],
      activeTabId: "term-1",
    });
    useChatStore.setState({
      drawerOpen: false,
      drawerPosition: "left",
      drawerPinned: true,
    });

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
    fireEvent.pointerDown(ribbon, { button: 0, pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(ribbon, { pointerId: 1, clientX, clientY });
    fireEvent.pointerUp(ribbon, { pointerId: 1, clientX, clientY });

    expect(useChatStore.getState().drawerPosition).toBe(expected);
  });

  it("delays top and bottom hover-open long enough for drag to start", () => {
    vi.useFakeTimers();
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    try {
      useAppStore.setState({
        tabs: [{ id: "term-1", type: "terminal", title: "Terminal", closable: true }],
        activeTabId: "term-1",
      });
      useChatStore.setState({
        drawerOpen: false,
        drawerPosition: "top",
        drawerPinned: false,
        openTabChat,
      });

      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );

      const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
      fireEvent.mouseEnter(ribbon);
      vi.advanceTimersByTime(300);
      expect(openTabChat).not.toHaveBeenCalled();

      fireEvent.pointerDown(ribbon, { button: 0, pointerId: 1, clientX: 400, clientY: 4 });
      vi.advanceTimersByTime(1000);
      expect(openTabChat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("badges pending alerts and opens the Notifications hub tab on click", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    const setActiveNote = vi.fn();
    const ackAlert = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{ id: "term-1", chatTabId: "stable-chat", type: "terminal", title: "T", closable: true }],
      activeTabId: "term-1",
    });
    useChatStore.setState({ drawerOpen: false, drawerPosition: "left", drawerPinned: true, openTabChat });
    useTaoHubStore.setState({ hubTab: "chat" });
    useNotesStore.setState({
      alerts: [
        {
          id: "evt-1",
          note_id: "note-7",
          kind: "overdue",
          state: "pending",
          fire_at: 1,
          acknowledged_at: null,
          note_title: "Pay invoice",
          due_at: 1,
          reminder_at: null,
        },
      ],
      setActiveNote,
      ackAlert,
    });
    resetTaoAlertStore();

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    expect(screen.getByTestId("tao-ribbon-badge")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("ai-chat-drawer-ribbon"));
    expect(openTabChat).toHaveBeenCalledWith("stable-chat");
    expect(setActiveNote).not.toHaveBeenCalled();
    expect(ackAlert).not.toHaveBeenCalled();
    expect(useTaoHubStore.getState().hubTab).toBe("notifications");
  });

  it("opens the Notifications hub tab when multiple alerts are pending", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{ id: "term-1", chatTabId: "stable-chat", type: "terminal", title: "T", closable: true }],
      activeTabId: "term-1",
    });
    useChatStore.setState({ drawerOpen: false, drawerPosition: "left", drawerPinned: true, openTabChat });
    useNotesStore.setState({
      alerts: [
        { id: "a", note_id: "n1", kind: "overdue", state: "pending", fire_at: 1, acknowledged_at: null, note_title: "A", due_at: 1, reminder_at: null },
        { id: "b", note_id: "n2", kind: "due_soon", state: "pending", fire_at: 2, acknowledged_at: null, note_title: "B", due_at: 2, reminder_at: null },
      ],
    });
    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );
    expect(screen.getByTestId("tao-ribbon-badge")).toHaveTextContent("2");
    fireEvent.click(screen.getByTestId("ai-chat-drawer-ribbon"));
    expect(openTabChat).toHaveBeenCalledWith("stable-chat");
    expect(useTaoHubStore.getState().hubTab).toBe("notifications");
  });
});
