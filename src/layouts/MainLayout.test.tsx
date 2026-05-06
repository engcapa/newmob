import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { MainLayout } from "./MainLayout";
import { useAppStore } from "../stores/appStore";

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
  PanelResizeHandle: ({ className }: { className?: string }) => (
    <div className={className} data-testid="panel-resize-handle" />
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
  TerminalPanel: () => {
    useEffect(() => {
      terminalLifecycle.mounted();
      return () => terminalLifecycle.unmounted();
    }, []);
    return <div data-testid="terminal-panel" />;
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
            osc7AutoInject: false,
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
});
