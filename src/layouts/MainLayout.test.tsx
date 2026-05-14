import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { MainLayout } from "./MainLayout";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { listSessions, type SessionConfig } from "../lib/ipc";
import { DEFAULT_TERMINAL_PROFILE, type TerminalProfile } from "../lib/terminalProfile";

const terminalLifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => vi.fn()),
  }),
}));

vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  ),
  Panel: forwardRef<unknown, { children: React.ReactNode }>(({ children }, ref) => {
    useImperativeHandle(ref, () => ({
      collapse: vi.fn(),
      resize: vi.fn(),
    }));
    return <div data-testid="panel">{children}</div>;
  }),
  PanelResizeHandle: ({ className, "data-testid": testId }: React.HTMLAttributes<HTMLDivElement> & { "data-testid"?: string }) => (
    <div className={className} data-testid={testId ?? "panel-resize-handle"} />
  ),
}));

vi.mock("../components/menubar/MenuBar", () => ({
  MenuBar: () => <div data-testid="menu-bar" />,
}));

vi.mock("../components/menubar/Ribbon", () => ({
  Ribbon: () => <div data-testid="ribbon" />,
}));

vi.mock("../components/quickconnect/QuickConnect", () => ({
  QuickConnect: () => <div data-testid="quick-connect" />,
}));

vi.mock("../components/sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("../components/statusbar/StatusBar", () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));

vi.mock("../components/terminal/TerminalPanel", () => ({
  TerminalPanel: ({
    terminalProfile,
    sftpToggle,
  }: {
    terminalProfile?: TerminalProfile;
    sftpToggle?: { open: boolean; onToggle: () => void };
  }) => {
    useEffect(() => {
      terminalLifecycle.mounted();
      return () => terminalLifecycle.unmounted();
    }, []);
    return (
      <div
        data-testid="terminal-panel"
        data-terminal-font-size={terminalProfile?.fontSize ?? ""}
        data-terminal-theme={terminalProfile?.theme ?? ""}
      >
        {sftpToggle && (
          <button
            type="button"
            data-testid="attached-sftp-toggle"
            onClick={sftpToggle.onToggle}
          >
            SFTP
          </button>
        )}
      </div>
    );
  },
}));

vi.mock("../components/filebrowser/SftpSidebar", () => ({
  SftpSidebar: () => <div data-testid="sftp-sidebar" />,
}));

vi.mock("../lib/ipc", () => ({
  encodeBase64: (value: string) => btoa(value),
  exitApp: vi.fn(async () => undefined),
  listSessionGroups: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  markSessionConnected: vi.fn(async () => 0),
  writeTerminal: vi.fn(async () => undefined),
}));

describe("MainLayout attached SFTP sidebar", () => {
  beforeEach(() => {
    terminalLifecycle.mounted.mockClear();
    terminalLifecycle.unmounted.mockClear();
    vi.mocked(listSessions).mockResolvedValue([]);
    useSessionStore.setState({
      sessions: [],
      groups: [],
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          closable: true,
          ssh: {
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: undefined,
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      compactMode: false,
      statusMessage: "Ready",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the attached SFTP sidebar without remounting the terminal", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /sftp/i }));

    expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("hides outer chrome in compact mode without remounting the terminal", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
    expect(screen.getByTestId("ribbon")).toBeInTheDocument();
    expect(screen.getByTestId("quick-connect")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /enter compact mode/i }));

    expect(screen.queryByTestId("menu-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ribbon")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quick-connect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("compact-titlebar")).toBeInTheDocument();
    expect(screen.getByTestId("tab-bar")).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /exit compact mode/i }));

    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
    expect(screen.getByTestId("ribbon")).toBeInTheDocument();
    expect(screen.getByTestId("quick-connect")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("opens compact main menu and sessions drawer from the titlebar", () => {
    render(<MainLayout />);

    fireEvent.click(screen.getByRole("button", { name: /enter compact mode/i }));

    fireEvent.click(screen.getByRole("button", { name: /main menu/i }));
    expect(screen.getByTestId("context-menu-item-new-local-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-sessions")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /show sessions drawer/i }));
    expect(screen.getByTestId("compact-sidebar-drawer")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: /close sessions drawer/i })[0]);
    expect(screen.queryByTestId("compact-sidebar-drawer")).not.toBeInTheDocument();
  });

  it("collapses the main sidebar to a fixed rail without leaving the panel gap", () => {
    useAppStore.setState({
      sidebarCollapsed: true,
      compactMode: false,
    });

    render(<MainLayout />);

    expect(screen.getByTestId("collapsed-sidebar-rail")).toBeInTheDocument();
    expect(screen.getByTestId("main-sidebar-resize-handle")).toHaveClass("hidden");
  });

  it("passes edited session terminal profiles to already-open terminal tabs", async () => {
    const initialSession = makeSessionWithProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 13,
      theme: "classic",
    });
    const updatedSession = makeSessionWithProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 19,
      theme: "termius-dark",
    });
    vi.mocked(listSessions).mockResolvedValue([initialSession]);
    useSessionStore.setState({ sessions: [initialSession], groups: [] });
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          sessionId: initialSession.id,
          closable: true,
          ssh: {
            sessionId: initialSession.id,
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: initialSession.options_json,
          },
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            fontSize: 11,
            theme: "classic",
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      compactMode: false,
      statusMessage: "Ready",
    });

    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "13");
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "classic");

    act(() => {
      useSessionStore.setState({ sessions: [updatedSession] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "19");
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "termius-dark");
    });
  });
});

function makeSessionWithProfile(profile: TerminalProfile): SessionConfig {
  return {
    id: "session-with-profile",
    name: "profiled-session",
    session_type: "SSH",
    group_path: null,
    host: "example.test",
    port: 22,
    username: "root",
    auth_method: "Password",
    options_json: JSON.stringify({ terminalProfile: profile }),
    created_at: 10,
    updated_at: 10,
    last_connected_at: null,
    sort_order: 0,
  };
}
