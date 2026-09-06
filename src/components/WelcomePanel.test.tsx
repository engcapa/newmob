import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePanel } from "./WelcomePanel";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import type { SessionConfig } from "../lib/ipc";
import type { RecentWorkspace } from "../types";

const ipcMocks = vi.hoisted(() => ({
  listCommonLocalDirectories: vi.fn(),
  listLocalShells: vi.fn(),
  listSessionGroups: vi.fn(),
  listSessions: vi.fn(),
  listSystemFonts: vi.fn(),
  listWslDistros: vi.fn(),
  openLocalShellAsAdministrator: vi.fn(),
  saveSession: vi.fn(),
  listenWelcomeDirectoriesChanged: vi.fn(),
  directoryEventListeners: [] as Array<(revision: number) => void>,
}));

vi.mock("../lib/ipc", () => ({
  listCommonLocalDirectories: ipcMocks.listCommonLocalDirectories,
  listLocalShells: ipcMocks.listLocalShells,
  listSessionGroups: ipcMocks.listSessionGroups,
  listSessions: ipcMocks.listSessions,
  listSystemFonts: ipcMocks.listSystemFonts,
  listWslDistros: ipcMocks.listWslDistros,
  openLocalShellAsAdministrator: ipcMocks.openLocalShellAsAdministrator,
  saveSession: ipcMocks.saveSession,
  listenWelcomeDirectoriesChanged: ipcMocks.listenWelcomeDirectoriesChanged,
}));

function emitWelcomeDirectoriesChanged(revision: number): void {
  for (const listener of ipcMocks.directoryEventListeners) listener(revision);
}

vi.mock("../lib/runtime", () => ({
  getAppPlatform: () => "linux",
}));

vi.mock("../lib/sftp", () => ({
  sftpLocalHome: vi.fn(async () => "/home/test"),
}));

vi.mock("../lib/clipboard", () => ({
  writeText: vi.fn(async () => undefined),
}));

describe("WelcomePanel", () => {
  beforeEach(() => {
    ipcMocks.listLocalShells.mockResolvedValue([
      {
        id: "powershell",
        name: "PowerShell",
        path: "powershell.exe",
        isDefault: true,
        canElevate: true,
      },
    ]);
    ipcMocks.listCommonLocalDirectories.mockResolvedValue([
      { label: "Home", path: "/home/test", kind: "system" },
      { label: "Projects", path: "/home/test/projects", kind: "personal" },
    ]);
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.listSystemFonts.mockResolvedValue(["monospace", "JetBrains Mono"]);
    ipcMocks.listWslDistros.mockResolvedValue([]);
    ipcMocks.openLocalShellAsAdministrator.mockResolvedValue(undefined);
    ipcMocks.saveSession.mockResolvedValue(undefined);
    ipcMocks.listenWelcomeDirectoriesChanged.mockImplementation(
      async (callback: (revision: number) => void) => {
        ipcMocks.directoryEventListeners.push(callback);
        return () => {
          ipcMocks.directoryEventListeners = ipcMocks.directoryEventListeners.filter(
            (cb) => cb !== callback,
          );
        };
      },
    );
    ipcMocks.directoryEventListeners.length = 0;
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      statusMessage: "Ready",
    });
    useSessionStore.setState({
      sessions: [],
      groups: [],
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the Taomni brand mark as T while keeping the header version", async () => {
    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
      />,
    );

    const brandMark = screen.getByTestId("welcome-brand-mark");
    expect(brandMark).toHaveTextContent("T");
    expect(brandMark).not.toHaveTextContent("N");
    expect(brandMark).toHaveClass("w-12", "h-12");

    expect(screen.getByTestId("welcome-version")).toHaveTextContent(`Version ${__APP_VERSION__}`);
    expect(screen.getByTestId("welcome-version-footer")).toHaveTextContent(`v${__APP_VERSION__}`);
    expect(screen.queryByTestId("welcome-activity-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("welcome-open-chat-tao")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    const historyTabs = within(screen.getByRole("tablist", { name: "Welcome shortcuts and history" })).getAllByRole("tab");
    expect(historyTabs.map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "welcome-history-tab-sessions",
      "welcome-history-tab-workspaces",
      "welcome-history-tab-directories",
    ]);
    expect(historyTabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("welcome-recent-sessions")).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-local-directories")).not.toBeInTheDocument();
  });

  it("shows local directory shortcuts and starts a terminal in the clicked directory", async () => {
    const startLocalTerminal = vi.fn();

    render(
      <WelcomePanel
        onStartLocalTerminal={startLocalTerminal}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    expect(screen.getByTestId("welcome-local-directories")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-local-directory-filter")).toBeInTheDocument();

    const rows = screen.getAllByTestId("welcome-local-directory");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveAttribute("data-directory-path", "/home/test/projects");

    fireEvent.click(within(rows[1]).getByText("Projects"));
    expect(startLocalTerminal).toHaveBeenCalledWith(
      { id: "powershell.exe", name: "PowerShell" },
      "/home/test/projects",
    );
  });

  it("filters local directory shortcuts by name and path", async () => {
    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));

    const filter = screen.getByTestId("welcome-local-directory-filter");
    fireEvent.change(filter, { target: { value: "projects" } });
    expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(screen.getByTestId("welcome-local-directories-filter-count")).toHaveTextContent("1 of 2");

    fireEvent.change(filter, { target: { value: "no-such-dir" } });
    expect(screen.queryAllByTestId("welcome-local-directory")).toHaveLength(0);
    expect(screen.getByTestId("welcome-local-directories-no-matches")).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(2);
  });

  it("shows recent sessions with filter, select, bulk open, and single open actions", async () => {
    const recentSessions: SessionConfig[] = [
      session("ssh-prod", "Prod SSH", "SSH", "prod.example.com", 22, 300),
      session("sftp-prod", "Prod SFTP", "SFTP", "files.example.com", 22, 200),
      session("redis-dev", "Redis Dev", "Redis", "redis.local", 6379, 100),
    ];
    const openSession = vi.fn();
    const openSessions = vi.fn();
    const editSession = vi.fn();

    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
        recentSessions={recentSessions}
        onOpenRecentSession={openSession}
        onOpenRecentSessions={openSessions}
        onEditRecentSession={editSession}
        onRevealRecentSession={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    expect(screen.getByTestId("welcome-recent-sessions")).toBeInTheDocument();
    expect(screen.getAllByTestId("welcome-recent-session-row")).toHaveLength(3);

    fireEvent.change(screen.getByTestId("welcome-recent-filter"), {
      target: { value: "prod" },
    });
    expect(screen.getAllByTestId("welcome-recent-session-row")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("welcome-recent-sort"), {
      target: { value: "name-asc" },
    });
    expect(screen.getAllByTestId("welcome-recent-session-row")[0]).toHaveAttribute("data-session-name", "Prod SFTP");
    expect(screen.getByTestId("welcome-recent-settings").querySelector("svg")).toBeTruthy();

    fireEvent.click(screen.getByTestId("welcome-recent-open-filtered"));
    expect(openSessions).toHaveBeenLastCalledWith([recentSessions[1], recentSessions[0]]);

    fireEvent.click(screen.getByTestId("welcome-recent-select-filtered"));
    fireEvent.click(screen.getByTestId("welcome-recent-open-selected"));
    expect(openSessions).toHaveBeenLastCalledWith([recentSessions[1], recentSessions[0]]);

    const firstRow = screen.getAllByTestId("welcome-recent-session-row")[0];
    fireEvent.click(within(firstRow).getByTestId("welcome-recent-open"));
    expect(openSession).toHaveBeenCalledWith(recentSessions[1]);
    expect(openSession).toHaveBeenCalledTimes(1);
    fireEvent.click(within(firstRow).getByTestId("welcome-recent-details"));
    fireEvent.click(firstRow);
    expect(openSession).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(firstRow);
    expect(screen.getByTestId("context-menu-item-connect-selected-sessions-2")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-connect")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-edit")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-duplicate-selected-sessions-2")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-move-to-folder")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-delete-selected-sessions-2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("context-menu-item-connect"));
    expect(openSession).toHaveBeenLastCalledWith(recentSessions[1]);

    fireEvent.contextMenu(firstRow);
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    expect(editSession).toHaveBeenCalledWith(recentSessions[1]);
  });

  it("shows recent workspaces with filter, open, reveal, copy, remove, and context actions", async () => {
    const recentWorkspaces: RecentWorkspace[] = [
      workspace("workspace-taomni", "taomni", "/work/taomni", 300, "git"),
      workspace("workspace-docs", "docs", "/work/docs", 100, "folder"),
    ];
    const openWorkspace = vi.fn();
    const removeWorkspace = vi.fn();
    const revealWorkspace = vi.fn();
    const openNewWorkspace = vi.fn();

    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
        recentWorkspaces={recentWorkspaces}
        onOpenRecentWorkspace={openWorkspace}
        onRemoveRecentWorkspace={removeWorkspace}
        onRevealRecentWorkspace={revealWorkspace}
        onOpenNewWorkspace={openNewWorkspace}
        onClearRecentWorkspaces={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("welcome-history-tab-workspaces"));
    expect(screen.getByTestId("welcome-recent-workspaces")).toBeInTheDocument();
    expect(screen.getAllByTestId("welcome-recent-workspace-row")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("welcome-recent-workspace-filter"), {
      target: { value: "docs" },
    });
    const filteredRow = screen.getByTestId("welcome-recent-workspace-row");
    expect(filteredRow).toHaveAttribute("data-workspace-name", "docs");

    fireEvent.click(filteredRow);
    expect(openWorkspace).toHaveBeenCalledWith(recentWorkspaces[1]);

    fireEvent.click(within(filteredRow).getByTestId("welcome-recent-workspace-copy-path"));
    await waitFor(() => {
      expect(useAppStore.getState().statusMessage).toBe("Workspace path copied to clipboard");
    });

    fireEvent.click(within(filteredRow).getByTestId("welcome-recent-workspace-reveal"));
    expect(revealWorkspace).toHaveBeenCalledWith(recentWorkspaces[1]);

    fireEvent.click(within(filteredRow).getByTestId("welcome-recent-workspace-remove"));
    expect(removeWorkspace).toHaveBeenCalledWith(recentWorkspaces[1]);

    fireEvent.contextMenu(filteredRow);
    expect(screen.getByTestId("context-menu-item-open-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-reveal-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-workspace-path")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-remove-workspace")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("welcome-recent-workspace-open-new"));
    expect(openNewWorkspace).toHaveBeenCalled();
  });

  it("sets a terminal theme for selected recent sessions from the context menu", async () => {
    const recentSessions: SessionConfig[] = [
      session("ssh-prod", "Prod SSH", "SSH", "prod.example.com", 22, 300),
      session("ftp-prod", "Prod FTP", "FTP", "files.example.com", 21, 200),
      session("mail-work", "Work Mail", "Mail", "imap.example.com", 993, 100),
    ];
    useSessionStore.setState({
      sessions: recentSessions,
      groups: [],
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
    ipcMocks.listSessions.mockResolvedValue(recentSessions);

    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
        recentSessions={recentSessions}
        onOpenRecentSession={vi.fn()}
        onOpenRecentSessions={vi.fn()}
        onEditRecentSession={vi.fn()}
        onRevealRecentSession={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    expect(screen.getByTestId("welcome-recent-sessions")).toBeInTheDocument();

    const rows = screen.getAllByTestId("welcome-recent-session-row");
    fireEvent.click(within(rows[0]).getByTestId("welcome-recent-select"));
    const updatedRows = screen.getAllByTestId("welcome-recent-session-row");
    fireEvent.click(within(updatedRows[1]).getByTestId("welcome-recent-select"));
    await waitFor(() => expect(screen.getByText("2 selected")).toBeInTheDocument());
    fireEvent.contextMenu(screen.getAllByTestId("welcome-recent-session-row")[0]);
    const item = screen.getByTestId("context-menu-item-set-terminal-theme");
    fireEvent.mouseEnter(item.parentElement!);
    expect(await screen.findByTestId("session-terminal-font-select")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("session-terminal-theme-option-kanagawa-wave"));

    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(2));
    expect(ipcMocks.saveSession.mock.calls.map(([cfg]) => cfg.id).sort()).toEqual([
      "ftp-prod",
      "ssh-prod",
    ]);
    const themes = ipcMocks.saveSession.mock.calls.map(([cfg]) =>
      JSON.parse(cfg.options_json).terminalProfile.theme,
    );
    expect(themes).toEqual(["kanagawa-wave", "kanagawa-wave"]);
  });

  it("hides the mail card when there are no mail sessions", async () => {
    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("welcome-mail-card")).not.toBeInTheDocument();
  });

  it("shows configured mailboxes in the mail card and opens the clicked one", async () => {
    const mailSessions: SessionConfig[] = [
      { ...session("mail-work", "Work Mail", "Mail", "imap.example.com", 993, 0), username: "me@example.com" },
      { ...session("mail-personal", "Personal", "Mail", "imap.personal.com", 993, 0), username: "me@personal.com" },
    ];
    const openMail = vi.fn();

    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
        mailSessions={mailSessions}
        onOpenMailSession={openMail}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    const card = screen.getByTestId("welcome-mail-card");
    expect(within(card).getAllByTestId("welcome-mail-session")).toHaveLength(2);

    fireEvent.click(within(card).getByRole("button", { name: "Open mailbox Work Mail" }));
    expect(openMail).toHaveBeenCalledWith(mailSessions[0]);
  });
});

function session(
  id: string,
  name: string,
  sessionType: string,
  host: string,
  port: number,
  lastConnectedAt: number,
): SessionConfig {
  return {
    id,
    name,
    session_type: sessionType,
    group_path: null,
    host,
    port,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: lastConnectedAt,
    sort_order: 0,
  };
}

function workspace(
  id: string,
  name: string,
  path: string,
  lastOpenedAt: number,
  kind: "git" | "folder",
): RecentWorkspace {
  return {
    id,
    name,
    roots: [{ id: `root-${id}`, name, path, kind }],
    looseFiles: [],
    lastOpenedAt,
    lastActiveFile: null,
    isGitRepo: kind === "git",
  };
}

describe("WelcomePanel directory ordering, time and errors (V-04)", () => {
  beforeEach(() => {
    ipcMocks.listLocalShells.mockResolvedValue([
      { id: "powershell", name: "PowerShell", path: "powershell.exe", isDefault: true, canElevate: true },
    ]);
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.listWslDistros.mockResolvedValue([]);
    ipcMocks.openLocalShellAsAdministrator.mockResolvedValue(undefined);
    ipcMocks.saveSession.mockResolvedValue(undefined);
    ipcMocks.listenWelcomeDirectoriesChanged.mockImplementation(
      async (callback: (revision: number) => void) => {
        ipcMocks.directoryEventListeners.push(callback);
        return () => {
          ipcMocks.directoryEventListeners = ipcMocks.directoryEventListeners.filter(
            (cb) => cb !== callback,
          );
        };
      },
    );
    ipcMocks.directoryEventListeners.length = 0;
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      statusMessage: "Ready",
    });
    useSessionStore.setState({ sessions: [], groups: [], loading: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const usedRow = (path: string, ms: number, label: string) => ({
    label,
    path,
    kind: "personal",
    directoryId: `id-${path}`,
    lastUsedAtMs: ms,
    timeSource: "local-start",
    legacyRank: null,
    defaultId: null,
    availability: "available",
  });

  it("keeps the backend mixed order and exposes time attributes", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 3,
      directories: [
        usedRow("/work/A", 3000, "A"),
        { label: "Downloads", path: "/x/Downloads", kind: "system", directoryId: "id-dl", lastUsedAtMs: 1000, timeSource: "local-cwd", legacyRank: null, defaultId: "downloads", availability: "available" },
        { label: "Home", path: "/home/test", kind: "system", directoryId: "id-home", lastUsedAtMs: null, timeSource: null, legacyRank: 2, defaultId: "home", availability: "available" },
        { label: "Fresh", path: "/x/Fresh", kind: "personal", directoryId: "id-fresh", lastUsedAtMs: null, timeSource: null, legacyRank: null, defaultId: null, availability: "unknown" },
      ],
    });
    render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));

    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(4);
    });
    const rows = screen.getAllByTestId("welcome-local-directory");
    expect(rows.map((row) => row.getAttribute("data-directory-path"))).toEqual([
      "/work/A",
      "/x/Downloads",
      "/home/test",
      "/x/Fresh",
    ]);
    expect(rows[0].getAttribute("data-last-used-at-ms")).toBe("3000");
    expect(rows[1].getAttribute("data-last-used-at-ms")).toBe("1000");
    // Legacy observation: null confirmed time, tooltip says time unknown.
    expect(rows[2].getAttribute("data-last-used-at-ms")).toBe("");
    expect(rows[2].getAttribute("title")).toMatch(/unknown|未知/);
    // Fresh default: never used.
    expect(rows[3].getAttribute("title")).toMatch(/Not used|尚未使用/);
    expect(rows[0].querySelector('[data-testid="welcome-local-directory-last-used"]')).not.toBeNull();
    expect(rows[2].textContent).toMatch(/unknown|未知/);
    expect(rows[3].textContent).not.toMatch(/unknown|未知/);
  });

  it("preserves relative order after filtering and clearing", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 1,
      directories: [
        usedRow("/work/A", 3000, "A"),
        usedRow("/work/B", 2000, "B"),
        usedRow("/x/Downloads", 1000, "Downloads"),
      ],
    });
    render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(3);
    });

    const filter = screen.getByTestId("welcome-local-directory-filter");
    fireEvent.change(filter, { target: { value: "work" } });
    const rows = screen.getAllByTestId("welcome-local-directory");
    expect(rows.map((row) => row.getAttribute("data-directory-path"))).toEqual(["/work/A", "/work/B"]);

    fireEvent.change(filter, { target: { value: "" } });
    const restored = screen.getAllByTestId("welcome-local-directory");
    expect(restored.map((row) => row.getAttribute("data-directory-path"))).toEqual([
      "/work/A",
      "/work/B",
      "/x/Downloads",
    ]);
  });

  it("keeps the last list when a refresh fails and offers retry", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValueOnce({
      revision: 1,
      directories: [usedRow("/work/A", 3000, "A")],
    });
    ipcMocks.listCommonLocalDirectories.mockRejectedValueOnce(new Error("db busy"));
    ipcMocks.listCommonLocalDirectories.mockRejectedValue(new Error("db busy"));

    render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
    });

    // A backend revision event triggers the failing refresh.
    act(() => {
      emitWelcomeDirectoriesChanged(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("welcome-directory-retry")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("welcome-directory-retry"));
    await waitFor(() => {
      // Initial load + failed event refresh + the explicit retry.
      expect(ipcMocks.listCommonLocalDirectories).toHaveBeenCalledTimes(3);
    });
    // The previous array is preserved; a retry control is still offered.
    expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
    expect(screen.getByTestId("welcome-directory-retry")).toBeInTheDocument();
  });

  it("shows the error state (not an empty list) on first-load failure", async () => {
    ipcMocks.listCommonLocalDirectories.mockRejectedValue(new Error("storage unavailable"));
    render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    await waitFor(() => {
      expect(screen.getByTestId("welcome-local-directories-error")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("welcome-local-directory")).not.toBeInTheDocument();
    expect(screen.getByTestId("welcome-directory-retry")).toBeInTheDocument();
  });

  it("marks the directory row pending and does not double-dispatch", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 1,
      directories: [usedRow("/work/A", 3000, "A")],
    });
    let release!: (value: unknown) => void;
    const startLocalTerminal = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(
      <WelcomePanel onStartLocalTerminal={startLocalTerminal as never} onNewSession={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
    });

    const row = screen.getAllByTestId("welcome-local-directory")[0];
    fireEvent.click(row);
    expect(startLocalTerminal).toHaveBeenCalledTimes(1);
    // Row is disabled while pending; a second click dispatches nothing.
    expect(screen.getAllByTestId("welcome-local-directory")[0]).toBeDisabled();
    fireEvent.click(screen.getAllByTestId("welcome-local-directory")[0]);
    expect(startLocalTerminal).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ tabId: "tab-1", status: "started" });
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")[0]).toBeEnabled();
    });
  });

  it("reports a failed launch without changing the directory list", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 1,
      directories: [usedRow("/work/A", 3000, "A")],
    });
    const { setStatusMessage: _unused } = useAppStore.getState();
    const startLocalTerminal = vi.fn(async () => ({
      tabId: "tab-1",
      status: "failed" as const,
      error: "pty spawn failed",
    }));
    render(
      <WelcomePanel onStartLocalTerminal={startLocalTerminal as never} onNewSession={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
    });
    fireEvent.click(screen.getAllByTestId("welcome-local-directory")[0]);
    await waitFor(() => {
      expect(useAppStore.getState().statusMessage).toMatch(/pty spawn failed|启动终端失败/);
    });
    // List order and time unchanged by the failed launch.
    const rows = screen.getAllByTestId("welcome-local-directory");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-last-used-at-ms")).toBe("3000");
  });

  it("marks unavailable directories and keeps them clickable for retry", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 1,
      directories: [
        usedRow("/offline/mount", 5000, "Offline mount"),
      ].map((row) => ({ ...row, availability: "missing" })),
    });
    const startLocalTerminal = vi.fn();
    render(<WelcomePanel onStartLocalTerminal={startLocalTerminal as never} onNewSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
    await waitFor(() => {
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
    });
    const row = screen.getAllByTestId("welcome-local-directory")[0];
    expect(row.getAttribute("data-availability")).toBe("missing");
    expect(screen.getByTestId("welcome-local-directory-unavailable")).toBeInTheDocument();

    fireEvent.click(row);
    await waitFor(() => {
      expect(startLocalTerminal).toHaveBeenCalledTimes(1);
    });
    // The row and its (unchanged) time remain listed.
    const after = screen.getAllByTestId("welcome-local-directory");
    expect(after[0].getAttribute("data-last-used-at-ms")).toBe("5000");
  });
});

const restoreRecord = (entries: unknown[] = [], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  revision: 2,
  runSequence: 1,
  batchId: "batch-1",
  committedAtMs: 1000,
  entries,
  activeIdentity: null,
  ...overrides,
});

const savedRestoreEntry = (id: string) => ({
  kind: "saved-session",
  identity: `saved:${id}`,
  savedSessionId: id,
  savedSessionType: "SSH",
  displayName: `session-${id}`,
});

describe("WelcomePanel restore row (V-07 UI)", () => {
  const setup = (props: Record<string, unknown>) => {
    ipcMocks.listLocalShells.mockResolvedValue([
      { id: "powershell", name: "PowerShell", path: "powershell.exe", isDefault: true, canElevate: true },
    ]);
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.listWslDistros.mockResolvedValue([]);
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({ revision: 1, directories: [] });
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      statusMessage: "Ready",
    });
    useSessionStore.setState({ sessions: [], groups: [], loading: false });
    return render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        restore={props as never}
      />,
    );
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows an empty disabled state", () => {
    setup({
      view: { state: "empty" },
      outcomes: [],
      onStartRestore: vi.fn(),
      onRetryFailed: vi.fn(),
      onCancelRestore: vi.fn(),
      onClearRecord: vi.fn(),
    });
    const status = screen.getByTestId("welcome-restore-status");
    expect(status).toHaveAttribute("data-state", "empty");
    expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
  });

  it("shows the available state with entry summary and enables restore", async () => {
    const onStartRestore = vi.fn();
    setup({
      view: { state: "available", record: restoreRecord([savedRestoreEntry("a"), savedRestoreEntry("b")]), legacy: false },
      outcomes: [],
      onStartRestore,
      onRetryFailed: vi.fn(),
      onCancelRestore: vi.fn(),
      onClearRecord: vi.fn(),
    });
    const status = screen.getByTestId("welcome-restore-status");
    expect(status).toHaveAttribute("data-state", "available");
    const button = screen.getByTestId("welcome-restore-last-session");
    expect(button).toBeEnabled();
    expect(status.textContent).toContain("2");
    fireEvent.click(button);
    expect(onStartRestore).toHaveBeenCalledTimes(1);
  });

  it("marks a legacy candidate source", () => {
    setup({
      view: { state: "available", record: restoreRecord([savedRestoreEntry("legacy")]), legacy: true },
      outcomes: [],
      onStartRestore: vi.fn(),
      onRetryFailed: vi.fn(),
      onCancelRestore: vi.fn(),
      onClearRecord: vi.fn(),
    });
    expect(screen.getByTestId("welcome-restore-status").getAttribute("data-state")).toBe("available");
    expect(screen.getByTestId("welcome-restore-status").textContent).toMatch(/legacy|历史|来源/);
  });

  it("disables the button and shows cancel while restoring", () => {
    const onCancelRestore = vi.fn();
    setup({
      view: {
        state: "restoring",
        record: restoreRecord([savedRestoreEntry("a"), savedRestoreEntry("b")]),
        operationId: "op-1",
        completed: 1,
        total: 2,
        awaitingEntry: null,
      },
      outcomes: [],
      onStartRestore: vi.fn(),
      onRetryFailed: vi.fn(),
      onCancelRestore,
      onClearRecord: vi.fn(),
    });
    const status = screen.getByTestId("welcome-restore-status");
    expect(status).toHaveAttribute("data-state", "restoring");
    expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
    expect(screen.getByTestId("welcome-restore-last-session")).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByTestId("welcome-restore-cancel"));
    expect(onCancelRestore).toHaveBeenCalledTimes(1);
  });

  it("lists failed entries under partial and offers retry only for failures", () => {
    const onRetryFailed = vi.fn();
    setup({
      view: {
        state: "partial",
        record: restoreRecord([savedRestoreEntry("a"), savedRestoreEntry("b")]),
        operationId: "op-1",
      },
      outcomes: [
        { identity: "saved:a", kind: "saved-session", displayName: "session-a", status: "ready", readiness: "connected", tabId: "t1", issue: null },
        { identity: "saved:b", kind: "saved-session", displayName: "session-b", status: "failed", readiness: null, tabId: null, issue: { code: "connect", message: "refused" } },
      ],
      onStartRestore: vi.fn(),
      onRetryFailed,
      onCancelRestore: vi.fn(),
      onClearRecord: vi.fn(),
    });
    expect(screen.getByTestId("welcome-restore-status").getAttribute("data-state")).toBe("partial");
    expect(screen.getByTestId("welcome-restore-status").textContent).toContain("session-b");
    expect(screen.getByTestId("welcome-restore-status").textContent).toContain("connect");
    fireEvent.click(screen.getByTestId("welcome-restore-retry"));
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
  });

  it("reports an incompatible snapshot as unavailable without pretending empty", () => {
    setup({
      view: { state: "unavailable", reason: "schema", message: "schema version 99 is not supported" },
      outcomes: [],
      onStartRestore: vi.fn(),
      onRetryFailed: vi.fn(),
      onCancelRestore: vi.fn(),
      onClearRecord: vi.fn(),
    });
    expect(screen.getByTestId("welcome-restore-status").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
  });

  it("clears the record through the confirm dialog", async () => {
    const onClearRecord = vi.fn();
    setup({
      view: { state: "available", record: restoreRecord([savedRestoreEntry("a")]), legacy: false },
      outcomes: [],
      onStartRestore: vi.fn(),
      onRetryFailed: vi.fn(),
      onCancelRestore: vi.fn(),
      onClearRecord,
    });
    fireEvent.click(screen.getByTestId("welcome-restore-clear"));
    // ConfirmDialog appears; click its confirm action.
    await waitFor(() => {
      expect(screen.getByRole("dialog", { hidden: true }) || screen.getByText(/Clear restore record|清除恢复记录/)).toBeTruthy();
    });
    const confirmButton = screen.getAllByRole("button").find((button) =>
      /Clear$|清除/.test(button.textContent ?? ""),
    );
    if (confirmButton) fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(onClearRecord).toHaveBeenCalled();
    });
  });
});
