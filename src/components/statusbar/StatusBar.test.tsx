import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useCodeWorkspaceStatusStore } from "../../stores/codeWorkspaceStatusStore";

vi.mock("../../lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/i18n")>();
  return {
    ...actual,
    useT: () => (key: string, params?: Record<string, unknown>) => {
      if (key === "statusBar.sessions") return `sessions:${params?.count ?? 0}`;
      if (key === "statusBar.none") return "none";
      if (key === "statusBar.networkOnline") return "online";
      if (key === "statusBar.networkOffline") return "offline";
      if (key === "statusBar.x11Off") return "x11-off";
      if (key === "statusBar.auth") return "auth";
      if (key === "statusBar.llm") return `llm:${params?.provider ?? ""}`;
      if (key === "statusBar.themeLabel") return `theme:${params?.mode ?? ""}`;
      if (key === "statusBar.activeTabNone") return "no-tab";
      if (key === "statusBar.terminalsCount") return `terminals:${params?.count ?? 0}`;
      if (key === "statusBar.versionTag") return `v${params?.version ?? ""}`;
      return key;
    },
  };
});

vi.mock("../../lib/i18n/labels", () => ({
  useAppThemeI18nLabel: () => () => "dark",
}));

vi.mock("../../lib/appTheme", () => ({
  useAppTheme: () => ({ mode: "dark", resolvedTheme: "dark" }),
}));

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: vi.fn(() => ({ sessions: [], selectedSessionId: null })),
}));

vi.mock("../../stores/aiStore", () => ({
  useAiStore: (selector: (state: { config: null }) => unknown) => selector({ config: null }),
}));

describe("StatusBar code-workspace segments", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useAppStore.setState({
      tabs: [{
        id: "ws-tab",
        type: "code-workspace",
        title: "Workspace",
        codeWorkspace: {
          repoRoot: "/repo",
          workspaceId: "ws",
          workspaceInstanceId: "instance",
          name: "Workspace",
          roots: [],
          looseFiles: [],
        },
      } as never],
      activeTabId: "ws-tab",
      xServerEnabled: false,
      xServerStatus: null,
      statusMessage: "",
    } as never);
    useCodeWorkspaceStatusStore.setState({ status: null, actions: null });
  });

  it("renders workspace segments and routes language/git clicks", () => {
    const openLanguagePanel = vi.fn();
    const openGitManager = vi.fn();
    useCodeWorkspaceStatusStore.setState({
      status: {
        tabId: "ws-tab",
        line: 12,
        column: 4,
        encoding: "UTF-8",
        eol: "LF",
        languageId: "typescript",
        lspActive: true,
        lspLabel: "typescript-language-server",
        lspError: false,
        gitBranch: "main",
        gitAhead: 1,
        gitBehind: 2,
        fontSize: 14,
        largeFile: false,
      },
      actions: { openLanguagePanel, openGitManager },
    });

    render(<StatusBar />);

    expect(screen.getByTestId("status-bar-workspace-cursor")).toHaveTextContent("Ln 12, Col 4");
    expect(screen.getByTestId("status-bar-workspace-encoding")).toHaveTextContent("UTF-8");
    expect(screen.getByTestId("status-bar-workspace-eol")).toHaveTextContent("LF");
    expect(screen.getByTestId("status-bar-workspace-language")).toHaveTextContent("typescript");
    expect(screen.getByTestId("status-bar-workspace-lsp")).toHaveTextContent("typescript-language-server");
    expect(screen.getByTestId("status-bar-workspace-git")).toHaveTextContent("main");
    expect(screen.getByTestId("status-bar-workspace-git")).toHaveTextContent("↑1");
    expect(screen.getByTestId("status-bar-workspace-git")).toHaveTextContent("↓2");
    expect(screen.getByTestId("status-bar-workspace-zoom")).toHaveTextContent("14px");
    // Language chip uses primary text tokens so Light theme keeps labels readable.
    expect(screen.getByTestId("status-bar-workspace-language").innerHTML).toContain("var(--taomni-text)");
    expect(screen.getByTestId("status-bar-workspace-lsp").innerHTML).toContain("var(--taomni-text)");

    fireEvent.click(screen.getByTestId("status-bar-workspace-language"));
    fireEvent.click(screen.getByTestId("status-bar-workspace-git"));
    expect(openLanguagePanel).toHaveBeenCalledTimes(1);
    expect(openGitManager).toHaveBeenCalledTimes(1);
    // Normal-size file: no large-file indicator.
    expect(screen.queryByTestId("status-bar-workspace-large-file")).toBeNull();
  });

  it("shows the large-file indicator only in large-file mode", () => {
    useCodeWorkspaceStatusStore.setState({
      status: {
        tabId: "ws-tab",
        line: 1,
        column: 1,
        encoding: "UTF-8",
        eol: "LF",
        languageId: "typescript",
        lspActive: true,
        lspLabel: "tsserver",
        lspError: false,
        gitBranch: null,
        gitAhead: 0,
        gitBehind: 0,
        fontSize: 14,
        largeFile: true,
      },
      actions: null,
    });

    render(<StatusBar />);
    expect(screen.getByTestId("status-bar-workspace-large-file")).toBeInTheDocument();
  });
});

describe("StatusBar copyable/truncated text", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function mockClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  beforeEach(() => {
    useAppStore.setState({
      tabs: [],
      activeTabId: null,
      xServerEnabled: false,
      xServerStatus: null,
      statusMessage: "",
    } as never);
    useCodeWorkspaceStatusStore.setState({ status: null, actions: null });
  });

  it("shows the full status message as tooltip and copies it on click", async () => {
    const writeText = mockClipboard();
    const message = "a long status message that would be ellipsized in a narrow window";
    useAppStore.setState({ statusMessage: message } as never);

    render(<StatusBar />);

    const el = screen.getByTestId("status-bar-message");
    expect(el).toHaveAttribute("title", message);

    fireEvent.click(el);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(message));
  });

  it("does not render the message segment when the status message is empty", () => {
    render(<StatusBar />);
    expect(screen.queryByTestId("status-bar-message")).toBeNull();
  });

  it("copies the selected session name on click", async () => {
    const writeText = mockClipboard();
    vi.mocked(useSessionStore).mockReturnValue({
      sessions: [{ id: "s1", name: "my-very-long-session-name" } as never],
      selectedSessionId: "s1",
    });

    render(<StatusBar />);

    fireEvent.click(screen.getByTestId("status-bar-selected-session"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("my-very-long-session-name"));
  });

  it("copies truncated workspace text on right-click when the segment has a click action", async () => {
    const writeText = mockClipboard();
    const openGitManager = vi.fn();
    useAppStore.setState({
      tabs: [{
        id: "ws-tab",
        type: "code-workspace",
        title: "Workspace",
        codeWorkspace: { repoRoot: "/repo", workspaceId: "ws", workspaceInstanceId: "i", name: "W", roots: [], looseFiles: [] },
      } as never],
      activeTabId: "ws-tab",
    } as never);
    useCodeWorkspaceStatusStore.setState({
      status: {
        tabId: "ws-tab",
        line: 1,
        column: 1,
        encoding: "UTF-8",
        eol: "LF",
        languageId: "typescript",
        lspActive: true,
        lspLabel: "typescript-language-server",
        lspError: false,
        gitBranch: "feature/a-very-long-branch-name",
        gitAhead: 1,
        gitBehind: 0,
        fontSize: 14,
        largeFile: false,
      },
      actions: { openLanguagePanel: vi.fn(), openGitManager },
    });

    render(<StatusBar />);

    fireEvent.contextMenu(screen.getByTestId("status-bar-workspace-git"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("feature/a-very-long-branch-name"));
    // Right-click copies but does not trigger the segment's primary click.
    expect(openGitManager).not.toHaveBeenCalled();
    // The segment's primary click still opens the Git manager.
    fireEvent.click(screen.getByTestId("status-bar-workspace-git"));
    expect(openGitManager).toHaveBeenCalledTimes(1);
  });
});
