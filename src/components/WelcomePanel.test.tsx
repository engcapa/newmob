import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePanel } from "./WelcomePanel";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import type { SessionConfig } from "../lib/ipc";
import type { RecentWorkspace } from "../types";

const ipcMocks = vi.hoisted(() => ({
  listCommonLocalDirectories: vi.fn(),
  listCommonLocalDirectoriesWithRevision: vi.fn(),
  listenWelcomeDirectoriesChanged: vi.fn(),
  recordLocalDirectoryUse: vi.fn(),
  listLocalShells: vi.fn(),
  listSessionGroups: vi.fn(),
  listSessions: vi.fn(),
  listSystemFonts: vi.fn(),
  listWslDistros: vi.fn(),
  openLocalShellAsAdministrator: vi.fn(),
  saveSession: vi.fn(),
  getWelcomeRunSnapshot: vi.fn(),
  recordWelcomeRunSnapshot: vi.fn(),
  clearWelcomeRunSnapshot: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  listCommonLocalDirectories: ipcMocks.listCommonLocalDirectories,
  listCommonLocalDirectoriesWithRevision: ipcMocks.listCommonLocalDirectoriesWithRevision,
  listenWelcomeDirectoriesChanged: ipcMocks.listenWelcomeDirectoriesChanged,
  recordLocalDirectoryUse: ipcMocks.recordLocalDirectoryUse,
  listLocalShells: ipcMocks.listLocalShells,
  listSessionGroups: ipcMocks.listSessionGroups,
  listSessions: ipcMocks.listSessions,
  listSystemFonts: ipcMocks.listSystemFonts,
  listWslDistros: ipcMocks.listWslDistros,
  openLocalShellAsAdministrator: ipcMocks.openLocalShellAsAdministrator,
  saveSession: ipcMocks.saveSession,
  getWelcomeRunSnapshot: ipcMocks.getWelcomeRunSnapshot,
  recordWelcomeRunSnapshot: ipcMocks.recordWelcomeRunSnapshot,
  clearWelcomeRunSnapshot: ipcMocks.clearWelcomeRunSnapshot,
}));

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
    ipcMocks.listCommonLocalDirectoriesWithRevision.mockResolvedValue({
      revision: 1,
      directories: [
        { label: "Home", path: "/home/test", kind: "system" },
        { label: "Projects", path: "/home/test/projects", kind: "personal" },
      ],
    });
    ipcMocks.listenWelcomeDirectoriesChanged.mockResolvedValue(() => undefined);
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.listSystemFonts.mockResolvedValue(["monospace", "JetBrains Mono"]);
    ipcMocks.listWslDistros.mockResolvedValue([]);
    ipcMocks.openLocalShellAsAdministrator.mockResolvedValue(undefined);
    ipcMocks.saveSession.mockResolvedValue(undefined);
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
