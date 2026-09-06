import {
  Terminal as TerminalIcon,
  Plus,
  Shield,
  FolderOpen,
  Folder,
  Mail as MailIcon,
  MessageCircle,
  History,
  ArrowUpDown,
  Search,
  X,
  Server,
  Play,
  Edit3,
  Copy,
  Trash2,
  CheckSquare,
  Square,
  Settings,
  ListTree,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  listLocalShells,
  listWslDistros,
  openLocalShellAsAdministrator,
  type LocalDirectoryShortcut,
  type LocalLaunchOutcome,
  type LocalShellOption,
  type RunSnapshot,
  type SessionConfig,
  type WslDistro,
} from "../lib/ipc";
import { useWelcomeDirectories } from "../hooks/useWelcomeDirectories";
import type { RestoreViewState } from "../hooks/useWelcomeRunRestore";
import { getAppPlatform } from "../lib/runtime";
import { sftpLocalHome } from "../lib/sftp";
import { writeText } from "../lib/clipboard";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import type { LocalShellSelection, RecentWorkspace } from "../types";
import { useT, type TranslateFn } from "../lib/i18n";
import { sessionTypeLabel } from "../lib/terminalProfile";
import { SESSION_ROOT_LABEL, collectFolderPaths, folderOptionLabel } from "../lib/sessionPaths";
import type { SessionTerminalAppearancePatch } from "../lib/sessionTerminalTheme";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { useConfirmDialog } from "./sidebar/ConfirmDialog";
import { buildSessionTerminalThemeMenuItem } from "./session/SessionTerminalThemeMenu";
import { buildSessionConnectionCommandMenuItem } from "./session/SessionConnectionCommandMenu";

interface WelcomePanelProps {
  onStartLocalTerminal: (
    shell?: LocalShellSelection,
    cwd?: string,
  ) => void | Promise<LocalLaunchOutcome>;
  onNewSession: () => void;
  onOpenLocalPath?: (path: string, opts?: { embedFolder?: boolean }) => void;
  onOpenLanChat?: () => void;
  recentSessions?: SessionConfig[];
  recentWorkspaces?: RecentWorkspace[];
  mailSessions?: SessionConfig[];
  onOpenMailSession?: (session: SessionConfig) => void;
  onOpenRecentSession?: (session: SessionConfig) => void;
  onOpenRecentSessions?: (sessions: SessionConfig[]) => void;
  onEditRecentSession?: (session: SessionConfig) => void;
  onRevealRecentSession?: (session: SessionConfig) => void;
  onOpenRecentWorkspace?: (workspace: RecentWorkspace) => void;
  onRemoveRecentWorkspace?: (workspace: RecentWorkspace) => void;
  onClearRecentWorkspaces?: () => void;
  onRevealRecentWorkspace?: (workspace: RecentWorkspace) => void;
  onOpenNewWorkspace?: () => void;
  onOpenSettings?: () => void;
  runRestoreView?: RestoreViewState;
  onRestoreBatch?: () => void;
  onRetryFailedRestore?: () => void;
  onCancelRestore?: () => void;
  onClearRunSnapshot?: () => void;
  /**
   * Whether the Welcome tab is currently visible. The panel stays mounted so
   * shell/filter state survives tab switches; when it becomes active we
   * refresh recent local directories from command history / shell cwd.
   */
  active?: boolean;
}

const EMPTY_RECENT_SESSIONS: SessionConfig[] = [];
const EMPTY_RECENT_WORKSPACES: RecentWorkspace[] = [];
type RecentSessionSort =
  | "last-desc"
  | "last-asc"
  | "name-asc"
  | "name-desc"
  | "type-asc"
  | "type-desc"
  | "host-asc"
  | "host-desc";
type WelcomeHistoryTab = "directories" | "workspaces" | "sessions";

export function WelcomePanel({
  onStartLocalTerminal,
  onNewSession,
  onOpenLocalPath,
  onOpenLanChat,
  recentSessions = EMPTY_RECENT_SESSIONS,
  recentWorkspaces = EMPTY_RECENT_WORKSPACES,
  mailSessions = EMPTY_RECENT_SESSIONS,
  onOpenMailSession,
  onOpenRecentSession,
  onOpenRecentSessions,
  onEditRecentSession,
  onRevealRecentSession,
  onOpenRecentWorkspace,
  onRemoveRecentWorkspace,
  onClearRecentWorkspaces,
  onRevealRecentWorkspace,
  onOpenNewWorkspace,
  onOpenSettings,
  runRestoreView,
  onRestoreBatch,
  onRetryFailedRestore,
  onCancelRestore,
  onClearRunSnapshot,
  active = true,
}: WelcomePanelProps) {
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [selectedShellId, setSelectedShellId] = useState("");
  const [shellStatus, setShellStatus] = useState<"loading" | "ready" | "error">("loading");
  const {
    directories: localDirectories,
    loading: directoriesLoading,
    error: directoriesError,
    reload: reloadDirectories,
  } = useWelcomeDirectories(active);
  const [pendingDirectoryIds, setPendingDirectoryIds] = useState<string[]>([]);
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [selectedDistro, setSelectedDistro] = useState("");
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [recentQuery, setRecentQuery] = useState("");
  const [recentType, setRecentType] = useState("all");
  const [recentSort, setRecentSort] = useState<RecentSessionSort>("last-desc");
  const [selectedRecentIds, setSelectedRecentIds] = useState<string[]>([]);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [historyTab, setHistoryTab] = useState<WelcomeHistoryTab>("sessions");
  const { setStatusMessage } = useAppStore();
  const t = useT();

  useEffect(() => {
    let cancelled = false;

    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        const list = Array.isArray(shells) ? shells : [];
        setLocalShells(list);
        setSelectedShellId(list.find((shell) => shell.isDefault)?.id ?? list[0]?.id ?? "");
        setShellStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setShellStatus("error");
        setStatusMessage(t("status.localShellDetectionFailed", { error: String(error) }));
      });

    if (getAppPlatform() === "windows") {
      listWslDistros()
        .then((distros) => {
          if (cancelled) return;
          const list = Array.isArray(distros) ? distros : [];
          setWslDistros(list);
          setSelectedDistro(list.find((d) => d.isDefault)?.name ?? list[0]?.name ?? "");
          setWslStatus("ready");
        })
        .catch((error) => {
          if (cancelled) return;
          setWslStatus("error");
          setStatusMessage(t("welcome.wslDetectFailed", { error: String(error) }));
        });
    } else {
      setWslStatus("unsupported");
    }

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, t]);

  const mergedShells = useMemo<LocalShellOption[]>(() => {
    if (wslDistros.length === 0) return localShells;
    const virtual: LocalShellOption[] = wslDistros.map((d) => ({
      id: `wsl:${d.name}`,
      name: `WSL: ${d.name}`,
      path: "wsl.exe",
      args: ["-d", d.name],
      isDefault: false,
      canElevate: true,
    }));
    return [...localShells, ...virtual];
  }, [localShells, wslDistros]);

  const selectedShell = useMemo(
    () => mergedShells.find((shell) => shell.id === selectedShellId),
    [mergedShells, selectedShellId],
  );

  const recentTypeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of recentSessions) {
      const label = sessionTypeLabel(session.session_type, session.options_json);
      if (!seen.has(label)) seen.set(label, label);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [recentSessions]);

  const filteredRecentSessions = useMemo(() => {
    const q = recentQuery.trim().toLowerCase();
    const filtered = recentSessions.filter((session) => {
      const label = sessionTypeLabel(session.session_type, session.options_json);
      if (recentType !== "all" && label !== recentType) return false;
      if (!q) return true;
      return [
        session.name,
        session.host,
        session.username ?? "",
        session.group_path ?? "",
        session.session_type,
        label,
        String(session.port ?? ""),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    return filtered.sort((a, b) => compareRecentSessions(a, b, recentSort));
  }, [recentQuery, recentSessions, recentSort, recentType]);

  const filteredRecentWorkspaces = useMemo(() => {
    const q = workspaceQuery.trim().toLowerCase();
    return recentWorkspaces
      .filter((workspace) => {
        if (!q) return true;
        return [
          workspace.name,
          ...workspace.roots.flatMap((root) => [root.name, root.path, root.kind]),
          ...workspace.looseFiles.flatMap((file) => [file.name, file.path]),
          workspace.isGitRepo ? "git" : "folder",
        ]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .slice()
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }, [recentWorkspaces, workspaceQuery]);

  useEffect(() => {
    const known = new Set(recentSessions.map((session) => session.id));
    setSelectedRecentIds((ids) => {
      const next = ids.filter((id) => known.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [recentSessions]);

  useEffect(() => {
    if (recentType === "all") return;
    if (!recentTypeOptions.some((option) => option.value === recentType)) {
      setRecentType("all");
    }
  }, [recentType, recentTypeOptions]);

  const selectedRecentSet = useMemo(() => new Set(selectedRecentIds), [selectedRecentIds]);
  const selectedRecentSessions = useMemo(
    () => {
      const byId = new Map(recentSessions.map((session) => [session.id, session]));
      return selectedRecentIds.flatMap((id) => {
        const session = byId.get(id);
        return session ? [session] : [];
      });
    },
    [recentSessions, selectedRecentIds],
  );

  const handleStartAsAdministrator = async () => {
    try {
      await openLocalShellAsAdministrator(selectedShell?.id);
      setStatusMessage(t("status.administratorRequested", {
        shell: selectedShell?.name ?? t("welcome.defaultShell"),
      }));
    } catch (error) {
      setStatusMessage(t("status.administratorFailed", { error: String(error) }));
    }
  };

  const handleOpenHomeFolder = async () => {
    if (!onOpenLocalPath) return;
    try {
      const home = await sftpLocalHome();
      if (home) onOpenLocalPath(home, { embedFolder: true });
    } catch (error) {
      setStatusMessage(t("status.homeLookupFailed", { error: String(error) }));
    }
  };

  const handleStartInDirectory = (directory: LocalDirectoryShortcut) => {
    const key = directory.directoryId ?? `${directory.kind}:${directory.path}`;
    if (pendingDirectoryIds.includes(key)) return;
    // Frontend requires a lossless native normalization; never silently fall
    // back to the default cwd via `?? undefined`.
    if (!directory.path || directory.path.includes("\0")) {
      setStatusMessage(t("welcome.localDirectoriesLoadFailed", { error: "invalid path" }));
      return;
    }
    const shell = localShellSelectionFromOption(selectedShell, directory.path);
    const cwd = selectedShell?.id.startsWith("wsl:") ? undefined : directory.path;
    setPendingDirectoryIds((prev) => [...prev, key]);
    try {
      const outcome = onStartLocalTerminal(shell, cwd);
      if (outcome && typeof (outcome as Promise<LocalLaunchOutcome>).then === "function") {
        void (outcome as Promise<LocalLaunchOutcome>)
          .catch((error) => {
            setStatusMessage(
              t("welcome.localDirectoriesLoadFailed", { error: String(error) }),
            );
          })
          .finally(() => {
            setPendingDirectoryIds((prev) => prev.filter((id) => id !== key));
          });
      } else {
        setPendingDirectoryIds((prev) => prev.filter((id) => id !== key));
      }
    } catch (error) {
      setPendingDirectoryIds((prev) => prev.filter((id) => id !== key));
      setStatusMessage(t("welcome.localDirectoriesLoadFailed", { error: String(error) }));
    }
  };

  return (
    <div data-testid="welcome-panel" className="w-full h-full min-w-0 overflow-auto" style={{ background: "var(--taomni-bg)" }}>
      <div className="w-full max-w-[1320px] mx-auto px-6 sm:px-8 lg:px-10 py-8">
        <div className="flex items-center gap-3 mb-5">
          <div
            data-testid="welcome-brand-mark"
            className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl"
            style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
          >
            T
          </div>
          <div>
            <div className="text-xl font-semibold">{t("app.welcomeTitle")}</div>
            <div className="text-[12px] text-[var(--taomni-text-muted)]">
              {t("app.tagline")}
            </div>
            <div
              data-testid="welcome-version"
              className="text-[11px] mt-0.5 taomni-mono"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {t("welcome.versionLabel", { version: __APP_VERSION__ })}
            </div>
          </div>
        </div>

        <RunRestoreRow
          translate={t}
          view={runRestoreView}
          onRestore={onRestoreBatch}
          onRetryFailed={onRetryFailedRestore}
          onCancel={onCancelRestore}
          onClear={onClearRunSnapshot}
        />

        <div
          className="grid gap-4 items-stretch"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}
        >
          <LocalTerminalCard
            translate={t}
            shells={mergedShells}
            selectedShell={selectedShell}
            selectedShellId={selectedShellId}
            shellStatus={shellStatus}
            onSelectShell={setSelectedShellId}
            kbd="Ctrl+Shift+T"
            onStart={() => {
              onStartLocalTerminal(localShellSelectionFromOption(selectedShell));
            }}
            onStartAsAdministrator={handleStartAsAdministrator}
            onOpenHomeFolder={onOpenLocalPath ? () => void handleOpenHomeFolder() : undefined}
          />
          {wslStatus === "ready" && wslDistros.length > 0 && (
            <WslCard
              translate={t}
              distros={wslDistros}
              selectedDistro={selectedDistro}
              onSelectDistro={setSelectedDistro}
              onStart={() => {
                if (!selectedDistro) return;
                onStartLocalTerminal({
                  id: "wsl.exe",
                  name: `WSL: ${selectedDistro}`,
                  args: ["-d", selectedDistro],
                });
              }}
            />
          )}
          <ActionCard
            testId="welcome-new-session"
            icon={<Plus className="w-5 h-5" />}
            title={t("welcome.newSessionTitle")}
            desc={t("welcome.newSessionDesc")}
            kbd="Ctrl+Shift+N"
            onClick={() => onNewSession()}
          />
          {onOpenLanChat ? (
            <ActionCard
              testId="welcome-open-lanchat"
              icon={<MessageCircle className="w-5 h-5" />}
              title={t("welcome.lanChatTitle")}
              desc={t("welcome.lanChatDesc")}
              kbd=""
              onClick={onOpenLanChat}
            />
          ) : null}
          {mailSessions.length > 0 ? (
            <MailSessionsCard
              translate={t}
              sessions={mailSessions}
              onOpen={onOpenMailSession}
            />
          ) : null}
        </div>

        <WelcomeHistoryPanel
          translate={t}
          activeTab={historyTab}
          directoryCount={localDirectories.length}
          workspaceCount={filteredRecentWorkspaces.length}
          sessionCount={filteredRecentSessions.length}
          onActiveTabChange={setHistoryTab}
          directoriesPanel={(
            <LocalDirectoriesPanel
              translate={t}
              directories={localDirectories}
              loading={directoriesLoading}
              error={directoriesError}
              pendingIds={pendingDirectoryIds}
              onRetry={reloadDirectories}
              onStartInDirectory={handleStartInDirectory}
            />
          )}
          workspacesPanel={(
            <RecentWorkspacesPanel
              translate={t}
              workspaces={recentWorkspaces}
              filteredWorkspaces={filteredRecentWorkspaces}
              query={workspaceQuery}
              onQueryChange={setWorkspaceQuery}
              onClearFilter={() => setWorkspaceQuery("")}
              onOpenWorkspace={onOpenRecentWorkspace}
              onRemoveWorkspace={onRemoveRecentWorkspace}
              onClearWorkspaces={onClearRecentWorkspaces}
              onRevealWorkspace={onRevealRecentWorkspace}
              onOpenNewWorkspace={onOpenNewWorkspace}
            />
          )}
          sessionsPanel={(
            <RecentSessionsPanel
              translate={t}
              sessions={recentSessions}
              filteredSessions={filteredRecentSessions}
              typeOptions={recentTypeOptions}
              query={recentQuery}
              typeFilter={recentType}
              sort={recentSort}
              selectedIds={selectedRecentSet}
              selectedCount={selectedRecentIds.length}
              onQueryChange={setRecentQuery}
              onTypeFilterChange={setRecentType}
              onSortChange={setRecentSort}
              onToggleSession={(id) => {
                setSelectedRecentIds((ids) =>
                  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
                );
              }}
              onClearFilter={() => {
                setRecentQuery("");
                setRecentType("all");
              }}
              onSelectFiltered={() => setSelectedRecentIds(filteredRecentSessions.map((session) => session.id))}
              onClearSelection={() => setSelectedRecentIds([])}
              onOpenSession={onOpenRecentSession}
              onOpenSessions={onOpenRecentSessions}
              onEditSession={onEditRecentSession}
              onRevealSession={onRevealRecentSession}
              selectedSessions={selectedRecentSessions}
              onSetSelectedSessions={setSelectedRecentIds}
              onOpenSettings={onOpenSettings}
            />
          )}
        />

        <div className="mt-7 text-[12px] text-[var(--taomni-text-muted)]">
          <div className="font-semibold text-[var(--taomni-text)] mb-1">{t("welcome.tipsHeading")}</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li
              dangerouslySetInnerHTML={{
                __html: t("welcome.tipQuickConnect", {
                  example: '<span class="taomni-mono px-1 border rounded" style="background: var(--taomni-input-bg); border-color: var(--taomni-divider);">ssh user@host:22</span>',
                }),
              }}
            />
            <li>{t("welcome.tipRightClick")}</li>
            <li>{t("welcome.tipDrag")}</li>
          </ul>
        </div>

        <div
          data-testid="welcome-version-footer"
          className="mt-7 pt-3 flex items-center justify-between text-[11px] taomni-mono"
          style={{
            borderTop: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <span>{t("app.name")}</span>
          <span>v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}

function localShellSelectionFromOption(
  shell: LocalShellOption | undefined,
  cwd?: string,
): LocalShellSelection | undefined {
  if (!shell) return undefined;
  const args = shell.args && shell.args.length > 0 ? [...shell.args] : [];
  if (cwd && shell.id.startsWith("wsl:") && !args.includes("--cd")) {
    args.push("--cd", cwd);
  }
  return {
    // Real shells have id === path; virtual WSL entries map id="wsl:<distro>"
    // to path="wsl.exe" — pass the executable path so the backend can resolve it.
    id: shell.path,
    name: shell.name,
    ...(args.length > 0 ? { args } : {}),
  };
}

function WelcomeHistoryPanel({
  translate: t,
  activeTab,
  directoryCount,
  workspaceCount,
  sessionCount,
  directoriesPanel,
  workspacesPanel,
  sessionsPanel,
  onActiveTabChange,
}: {
  translate: TranslateFn;
  activeTab: WelcomeHistoryTab;
  directoryCount: number;
  workspaceCount: number;
  sessionCount: number;
  directoriesPanel: React.ReactNode;
  workspacesPanel: React.ReactNode;
  sessionsPanel: React.ReactNode;
  onActiveTabChange: (tab: WelcomeHistoryTab) => void;
}) {
  const tabs: Array<{
    id: WelcomeHistoryTab;
    label: string;
    count: number;
    icon: React.ReactNode;
  }> = [
    {
      id: "sessions",
      label: t("welcome.recentSessionsHeading"),
      count: sessionCount,
      icon: <History className="w-3.5 h-3.5" />,
    },
    {
      id: "workspaces",
      label: t("welcome.recentWorkspacesHeading"),
      count: workspaceCount,
      icon: <Folder className="w-3.5 h-3.5" />,
    },
    {
      id: "directories",
      label: t("welcome.localDirectoriesHeading"),
      count: directoryCount,
      icon: <FolderOpen className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <section
      data-testid="welcome-history-panel"
      className="mt-6 overflow-hidden rounded-md border"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-2" style={{ borderColor: "var(--taomni-divider)" }}>
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          role="tablist"
          aria-label={t("welcome.historyTabsLabel")}
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`welcome-history-tab-${tab.id}`}
                data-testid={`welcome-history-tab-${tab.id}`}
                className="h-8 min-w-0 rounded px-3 inline-flex items-center gap-1.5 text-[12px] font-medium"
                style={{
                  background: selected ? "var(--taomni-selected)" : "transparent",
                  color: selected ? "var(--taomni-text)" : "var(--taomni-text-muted)",
                  border: `1px solid ${selected ? "var(--taomni-selected-border)" : "transparent"}`,
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`welcome-history-tabpanel-${tab.id}`}
                onClick={() => onActiveTabChange(tab.id)}
              >
                <span className="shrink-0 text-[var(--taomni-accent)]">{tab.icon}</span>
                <span className="truncate">{tab.label}</span>
                <span className="shrink-0 text-[11px] taomni-mono text-[var(--taomni-text-muted)]">
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        id={`welcome-history-tabpanel-${activeTab}`}
        className="p-4"
        role="tabpanel"
        aria-labelledby={`welcome-history-tab-${activeTab}`}
      >
        {activeTab === "directories" ? directoriesPanel : null}
        {activeTab === "workspaces" ? workspacesPanel : null}
        {activeTab === "sessions" ? sessionsPanel : null}
      </div>
    </section>
  );
}

function LocalDirectoriesPanel({
  translate: t,
  directories,
  loading,
  error,
  pendingIds,
  onRetry,
  onStartInDirectory,
}: {
  translate: TranslateFn;
  directories: LocalDirectoryShortcut[];
  loading: boolean;
  error: string | null;
  pendingIds: string[];
  onRetry: () => void;
  onStartInDirectory: (directory: LocalDirectoryShortcut) => void;
}) {
  const [query, setQuery] = useState("");
  // Backend order is authoritative; filtering preserves relative order.
  const filteredDirectories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return directories;
    return directories.filter((directory) =>
      [directory.label, directory.path, directory.kind]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [directories, query]);
  const hasFilter = query.trim().length > 0;

  const formatTime = (ms: number | null | undefined): string => {
    if (ms == null) return t("welcome.directoryTimeUnknown");
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return t("welcome.directoryTimeUnknown");
    }
  };

  if (error && directories.length === 0) {
    return (
      <section data-testid="welcome-local-directories" className="min-w-0">
        <div className="py-4 text-[12px] text-[var(--taomni-text-muted)]">
          {t("welcome.localDirectoriesLoadFailed", { error })}
        </div>
        <button
          data-testid="welcome-directory-retry"
          className="taomni-btn h-8 px-3 text-[12px]"
          type="button"
          onClick={onRetry}
        >
          {t("welcome.retry")}
        </button>
      </section>
    );
  }

  return (
    <section data-testid="welcome-local-directories" className="min-w-0">
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,240px)] flex-[1_1_240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            data-testid="welcome-local-directory-filter"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            type="search"
            aria-label={t("welcome.localDirectoriesSearch")}
            placeholder={t("welcome.localDirectoriesSearch")}
            value={query}
            disabled={directories.length === 0}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {loading ? <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("welcome.loading")}</span> : null}
        {error ? (
          <button
            data-testid="welcome-directory-retry"
            className="taomni-btn h-8 px-3 text-[12px]"
            type="button"
            onClick={onRetry}
          >
            {t("welcome.retry")}
          </button>
        ) : null}
      </div>
      <div className="max-h-[320px] overflow-auto pr-1">
        {directories.length === 0 ? (
          <div className="py-4 text-[12px] text-[var(--taomni-text-muted)]">
            {t("welcome.localDirectoriesEmpty")}
          </div>
        ) : filteredDirectories.length === 0 ? (
          <div className="py-4 text-[12px] text-[var(--taomni-text-muted)]" data-testid="welcome-local-directories-no-matches">
            {t("welcome.localDirectoriesNoMatches")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredDirectories.map((directory) => {
              const stableId = directory.directoryId ?? `${directory.kind}:${directory.path}`;
              const pending = pendingIds.includes(stableId);
              const unavailable = directory.availability && directory.availability !== "available" && directory.availability !== "unknown";
              const timeText = directory.lastUsedAtMs != null
                ? formatTime(directory.lastUsedAtMs)
                : t("welcome.directoryTimeUnknown");
              return (
              <button
                key={stableId}
                data-testid="welcome-local-directory"
                data-directory-path={directory.path}
                data-directory-id={directory.directoryId ?? ""}
                data-last-used-at-ms={directory.lastUsedAtMs ?? ""}
                className="w-full min-w-0 rounded border bg-[var(--taomni-input-bg)] px-2 py-1.5 text-left hover:bg-[var(--taomni-control-hover)] focus-visible:bg-[var(--taomni-control-hover)]"
                style={{ borderColor: "var(--taomni-divider)" }}
                type="button"
                title={directory.lastUsedAtMs != null
                  ? new Date(directory.lastUsedAtMs).toISOString()
                  : directory.path}
                aria-label={t("welcome.localDirectoryOpenAria", { label: directory.label, path: directory.path })}
                disabled={pending}
                onClick={() => onStartInDirectory(directory)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--taomni-text)]">
                    {directory.label}
                  </span>
                  {directory.lastUsedAtMs != null ? (
                    <span className="shrink-0 text-[10px] taomni-mono text-[var(--taomni-text-muted)]">
                      {timeText}
                    </span>
                  ) : null}
                  {unavailable ? (
                    <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] taomni-mono text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                      {directory.availability}
                    </span>
                  ) : null}
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] taomni-mono text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                    {directory.kind === "personal" ? t("welcome.localDirectoryPersonal") : t("welcome.localDirectorySystem")}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] taomni-mono text-[var(--taomni-text-muted)]">
                  {directory.path}
                </span>
              </button>
              );
            })}
          </div>
        )}
      </div>
      {hasFilter && filteredDirectories.length > 0 ? (
        <div className="mt-2 text-[11px] text-[var(--taomni-text-muted)]" data-testid="welcome-local-directories-filter-count">
          {t("welcome.localDirectoriesFilterCount", {
            visible: filteredDirectories.length,
            total: directories.length,
          })}
        </div>
      ) : null}
    </section>
  );
}

function RunRestoreRow({
  translate: t,
  view,
  onRestore,
  onRetryFailed,
  onCancel,
  onClear,
}: {
  translate: TranslateFn;
  view: RestoreViewState | undefined;
  onRestore: (() => void) | undefined;
  onRetryFailed: (() => void) | undefined;
  onCancel: (() => void) | undefined;
  onClear: (() => void) | undefined;
}) {
  if (!view) return null;
  const statusForTest = view.state === "available" && view.snapshot.entries.length === 0
    ? "empty"
    : view.state;
  let title = "";
  let detail: string | null = null;
  if (view.state === "available") {
    const names = view.snapshot.entries.slice(0, 3).map((e) => e.displayName).join("、");
    title = t("welcome.restoreLastTabs", { count: view.snapshot.entries.length });
    detail = names;
  } else if (view.state === "empty" || view.state === "loading") {
    title = t("welcome.restoreEmpty");
  } else if (view.state === "restoring" || view.state === "awaiting-auth") {
    title = t("welcome.restoreRestoring", { done: view.done, total: view.total });
  } else if (view.state === "succeeded" || view.state === "partial" || view.state === "failed") {
    const ok = view.results.filter((r) => r.status === "ready" || r.status === "partial").length;
    title = t("welcome.restoreResult", { ok, total: view.results.length });
    const failed = view.results.filter((r) => r.status === "failed" || r.status === "cancelled");
    detail = failed.length > 0 ? failed.map((r) => r.entryKey).join("、") : null;
  } else if (view.state === "unavailable") {
    title = view.message;
  } else {
    title = t("welcome.restoreEmpty");
  }
  const busy = view.state === "restoring" || view.state === "awaiting-auth";
  const canRestore =
    (view.state === "available" ||
      view.state === "succeeded" ||
      view.state === "partial" ||
      view.state === "failed") &&
    !!onRestore &&
    !busy;
  const showRetry = (view.state === "partial" || view.state === "failed") && !!onRetryFailed;
  return (
    <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2" data-testid="welcome-restore-status" data-state={statusForTest}>
      <button
        data-testid="welcome-restore-last-session"
        className="taomni-btn h-8 px-3 text-[12px]"
        type="button"
        disabled={!canRestore}
        aria-busy={busy}
        onClick={onRestore}
      >
        {t("welcome.restoreLastTabsButton")}
      </button>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--taomni-text-muted)]" title={detail ?? title}>
        {title}
        {detail ? ` — ${detail}` : ""}
      </span>
      {busy && onCancel ? (
        <button data-testid="welcome-restore-cancel" className="taomni-btn h-8 px-3 text-[12px]" type="button" onClick={onCancel}>
          {t("welcome.cancel")}
        </button>
      ) : null}
      {showRetry ? (
        <button data-testid="welcome-restore-retry" className="taomni-btn h-8 px-3 text-[12px]" type="button" onClick={onRetryFailed}>
          {t("welcome.retryFailed")}
        </button>
      ) : null}
      {(view.state === "available" || view.state === "succeeded" || view.state === "partial" || view.state === "failed") && onClear ? (
        <button data-testid="welcome-restore-clear" className="taomni-btn h-8 px-3 text-[12px]" type="button" onClick={onClear}>
          {t("welcome.clear")}
        </button>
      ) : null}
    </div>
  );
}

export type { RunSnapshot };

function RecentWorkspacesPanel({
  translate: t,
  workspaces,
  filteredWorkspaces,
  query,
  onQueryChange,
  onClearFilter,
  onOpenWorkspace,
  onRemoveWorkspace,
  onClearWorkspaces,
  onRevealWorkspace,
  onOpenNewWorkspace,
}: {
  translate: TranslateFn;
  workspaces: RecentWorkspace[];
  filteredWorkspaces: RecentWorkspace[];
  query: string;
  onQueryChange: (value: string) => void;
  onClearFilter: () => void;
  onOpenWorkspace?: (workspace: RecentWorkspace) => void;
  onRemoveWorkspace?: (workspace: RecentWorkspace) => void;
  onClearWorkspaces?: () => void;
  onRevealWorkspace?: (workspace: RecentWorkspace) => void;
  onOpenNewWorkspace?: () => void;
}) {
  const hasFilter = query.trim().length > 0;
  const ctx = useContextMenu();
  const clearConfirm = useConfirmDialog();
  const { setStatusMessage } = useAppStore();

  const copyWorkspacePath = (workspace: RecentWorkspace) => {
    const path = recentWorkspacePrimaryPath(workspace);
    if (!path) return;
    void writeText(path)
      .then(() => setStatusMessage(t("welcome.recentWorkspacesPathCopied")))
      .catch((error) => setStatusMessage(t("welcome.recentWorkspacesPathCopyFailed", { error: String(error) })));
  };

  const confirmClearWorkspaces = async () => {
    if (!onClearWorkspaces || workspaces.length === 0) return;
    const confirmed = await clearConfirm.confirm({
      title: t("welcome.recentWorkspacesClearTitle"),
      message: t("welcome.recentWorkspacesClearMessage"),
      confirmLabel: t("welcome.recentWorkspacesClearConfirm"),
      danger: true,
    });
    if (confirmed) onClearWorkspaces();
  };

  return (
    <section
      data-testid="welcome-recent-workspaces"
      className="min-w-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,240px)] flex-[1_1_240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            data-testid="welcome-recent-workspace-filter"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            type="search"
            aria-label={t("welcome.recentWorkspacesSearch")}
            placeholder={t("welcome.recentWorkspacesSearch")}
            value={query}
            disabled={workspaces.length === 0}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <button
          data-testid="welcome-recent-workspace-clear-filter"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={!hasFilter}
          onClick={onClearFilter}
        >
          <X className="w-3.5 h-3.5" />
          <span>{t("welcome.recentWorkspacesClearFilter")}</span>
        </button>
        <div className="h-6 w-px" style={{ background: "var(--taomni-divider)" }} />
        <button
          data-testid="welcome-recent-workspace-open-new"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!onOpenNewWorkspace}
          onClick={onOpenNewWorkspace}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t("welcome.recentWorkspacesOpenNew")}</span>
        </button>
        <button
          data-testid="welcome-recent-workspace-clear-all"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!onClearWorkspaces || workspaces.length === 0}
          onClick={() => void confirmClearWorkspaces()}
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t("welcome.recentWorkspacesClearAll")}</span>
        </button>
      </div>

      <div className="mt-3 max-h-[220px] overflow-auto">
        {workspaces.length === 0 ? (
          <div
            data-testid="welcome-recent-workspace-empty"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentWorkspacesEmpty")}
          </div>
        ) : filteredWorkspaces.length === 0 ? (
          <div
            data-testid="welcome-recent-workspace-no-matches"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentWorkspacesNoMatches")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredWorkspaces.map((workspace) => {
              const primaryPath = recentWorkspacePrimaryPath(workspace);
              const meta = recentWorkspaceMeta(workspace, t);
              return (
                <div
                  key={workspace.id}
                  data-testid="welcome-recent-workspace-row"
                  data-workspace-id={workspace.id}
                  data-workspace-name={workspace.name}
                  data-workspace-path={primaryPath}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded border px-2 py-1.5"
                  style={{
                    borderColor: "var(--taomni-divider)",
                    background: "var(--taomni-input-bg)",
                  }}
                  role={onOpenWorkspace ? "button" : undefined}
                  tabIndex={onOpenWorkspace ? 0 : undefined}
                  onClick={() => onOpenWorkspace?.(workspace)}
                  onKeyDown={(event) => {
                    if (!onOpenWorkspace) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenWorkspace(workspace);
                    }
                  }}
                  onContextMenu={(event) => {
                    ctx.show(event, recentWorkspaceMenuItems({
                      t,
                      workspace,
                      onOpenWorkspace,
                      onRevealWorkspace,
                      onRemoveWorkspace,
                      onCopyPath: copyWorkspacePath,
                    }));
                  }}
                >
                  <div className="min-w-0 text-left">
                    <div className="min-w-0 flex items-center gap-2">
                      <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                      <span className="min-w-0 truncate text-[12px] font-medium text-[var(--taomni-accent)]">
                        {workspace.name}
                      </span>
                      <span className="shrink-0 text-[10px] taomni-mono px-1.5 py-0.5 rounded border text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                        {workspace.isGitRepo ? t("welcome.recentWorkspacesGit") : t("welcome.recentWorkspacesFolder")}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--taomni-text-muted)]">
                      {primaryPath} · {meta} · {t("welcome.recentWorkspacesUpdated", { time: formatRecentSessionTime(workspace.lastOpenedAt, t) })}
                    </div>
                  </div>
                  <button
                    data-testid="welcome-recent-workspace-copy-path"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    title={t("welcome.recentWorkspacesCopyPath")}
                    aria-label={t("welcome.recentWorkspacesCopyPath")}
                    onClick={(event) => {
                      event.stopPropagation();
                      copyWorkspacePath(workspace);
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="welcome-recent-workspace-reveal"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    disabled={!onRevealWorkspace}
                    title={t("welcome.recentWorkspacesReveal")}
                    aria-label={t("welcome.recentWorkspacesRevealAria", { name: workspace.name })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRevealWorkspace?.(workspace);
                    }}
                  >
                    <ListTree className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="welcome-recent-workspace-remove"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    disabled={!onRemoveWorkspace}
                    title={t("welcome.recentWorkspacesRemove")}
                    aria-label={t("welcome.recentWorkspacesRemoveAria", { name: workspace.name })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveWorkspace?.(workspace);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {ctx.render}
      {clearConfirm.render}
    </section>
  );
}

function recentWorkspacePrimaryPath(workspace: RecentWorkspace): string {
  return workspace.roots[0]?.path ?? workspace.looseFiles[0]?.path ?? "";
}

function recentWorkspaceMeta(workspace: RecentWorkspace, t: TranslateFn): string {
  const parts = [
    workspace.roots.length > 0 ? t("welcome.recentWorkspacesRoots", { count: workspace.roots.length }) : "",
    workspace.looseFiles.length > 0 ? t("welcome.recentWorkspacesLooseFiles", { count: workspace.looseFiles.length }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("welcome.recentWorkspacesNoRoots");
}

function recentWorkspaceMenuItems({
  t,
  workspace,
  onOpenWorkspace,
  onRevealWorkspace,
  onRemoveWorkspace,
  onCopyPath,
}: {
  t: TranslateFn;
  workspace: RecentWorkspace;
  onOpenWorkspace?: (workspace: RecentWorkspace) => void;
  onRevealWorkspace?: (workspace: RecentWorkspace) => void;
  onRemoveWorkspace?: (workspace: RecentWorkspace) => void;
  onCopyPath: (workspace: RecentWorkspace) => void;
}): MenuItem[] {
  return [
    {
      label: t("welcome.recentWorkspacesOpen"),
      testId: "context-menu-item-open-workspace",
      icon: <FolderOpen className="w-3 h-3" />,
      disabled: !onOpenWorkspace,
      onClick: () => onOpenWorkspace?.(workspace),
    },
    {
      label: t("welcome.recentWorkspacesReveal"),
      testId: "context-menu-item-reveal-workspace",
      icon: <ListTree className="w-3 h-3" />,
      disabled: !onRevealWorkspace,
      onClick: () => onRevealWorkspace?.(workspace),
    },
    {
      label: t("welcome.recentWorkspacesCopyPath"),
      testId: "context-menu-item-copy-workspace-path",
      icon: <Copy className="w-3 h-3" />,
      disabled: !recentWorkspacePrimaryPath(workspace),
      onClick: () => onCopyPath(workspace),
    },
    { label: "", separator: true },
    {
      label: t("welcome.recentWorkspacesRemove"),
      testId: "context-menu-item-remove-workspace",
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      disabled: !onRemoveWorkspace,
      onClick: () => onRemoveWorkspace?.(workspace),
    },
  ];
}

function RecentSessionsPanel({
  translate: t,
  sessions,
  filteredSessions,
  typeOptions,
  query,
  typeFilter,
  sort,
  selectedIds,
  selectedCount,
  selectedSessions,
  onQueryChange,
  onTypeFilterChange,
  onSortChange,
  onToggleSession,
  onClearFilter,
  onSelectFiltered,
  onClearSelection,
  onOpenSession,
  onOpenSessions,
  onEditSession,
  onRevealSession,
  onSetSelectedSessions,
  onOpenSettings,
}: {
  translate: TranslateFn;
  sessions: SessionConfig[];
  filteredSessions: SessionConfig[];
  typeOptions: Array<{ value: string; label: string }>;
  query: string;
  typeFilter: string;
  sort: RecentSessionSort;
  selectedIds: Set<string>;
  selectedCount: number;
  selectedSessions: SessionConfig[];
  onQueryChange: (value: string) => void;
  onTypeFilterChange: (value: string) => void;
  onSortChange: (value: RecentSessionSort) => void;
  onToggleSession: (id: string) => void;
  onClearFilter: () => void;
  onSelectFiltered: () => void;
  onClearSelection: () => void;
  onOpenSession?: (session: SessionConfig) => void;
  onOpenSessions?: (sessions: SessionConfig[]) => void;
  onEditSession?: (session: SessionConfig) => void;
  onRevealSession?: (session: SessionConfig) => void;
  onSetSelectedSessions: (ids: string[]) => void;
  onOpenSettings?: () => void;
}) {
  const hasFilter = query.trim().length > 0 || typeFilter !== "all";
  const canOpen = Boolean(onOpenSessions);
  const ctx = useContextMenu();
  const deleteConfirm = useConfirmDialog();
  const {
    sessions: allSessions,
    groups,
    duplicateSessions,
    moveSessionsToGroup,
    removeSessions,
    updateSessionsTerminalAppearance,
  } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const folderPaths = useMemo(
    () => collectFolderPaths(allSessions, groups),
    [allSessions, groups],
  );

  const connectMenuSessions = (targetSessions: readonly SessionConfig[], sourceLabel: string) => {
    const uniqueSessions = uniqueRecentSessionsById(targetSessions);
    if (uniqueSessions.length === 0) return;
    onOpenSessions?.(uniqueSessions);
    setStatusMessage(t("sessionTree.sessionsStarted", {
      count: uniqueSessions.length,
      plural: uniqueSessions.length === 1 ? "" : "s",
      source: sourceLabel,
    }));
  };

  const confirmDeleteSessions = async (targetSessions: readonly SessionConfig[]) => {
    const uniqueSessions = uniqueRecentSessionsById(targetSessions);
    if (uniqueSessions.length === 0) return;
    const confirmed = await deleteConfirm.confirm(
      uniqueSessions.length > 1
        ? {
          title: t("sessionTree.confirmDeleteSelectedTitle"),
          message: t("sessionTree.confirmDeleteSelected", { count: uniqueSessions.length }),
          confirmLabel: t("sessionTree.deleteAction"),
          danger: true,
        }
        : {
          title: t("sessionTree.confirmDeleteTitle"),
          message: t("sessionTree.confirmDelete", { name: uniqueSessions[0].name }),
          confirmLabel: t("sessionTree.deleteAction"),
          danger: true,
        },
    );
    if (!confirmed) return;
    await removeSessions(uniqueSessions.map((session) => session.id));
  };

  const setTerminalAppearance = async (
    patch: SessionTerminalAppearancePatch,
    targetSessions: readonly SessionConfig[],
  ) => {
    const updatedCount = await updateSessionsTerminalAppearance(
      uniqueRecentSessionsById(targetSessions).map((session) => session.id),
      patch,
    );
    setStatusMessage(t("sessionTree.terminalAppearanceUpdated", { count: updatedCount }));
  };

  return (
    <section
      data-testid="welcome-recent-sessions"
      className="min-w-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,220px)] flex-[1_1_220px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            data-testid="welcome-recent-filter"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            type="search"
            aria-label={t("welcome.recentSessionsSearch")}
            placeholder={t("welcome.recentSessionsSearch")}
            value={query}
            disabled={sessions.length === 0}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <select
          data-testid="welcome-recent-type-filter"
          className="taomni-input h-8 w-[132px] max-w-full"
          aria-label={t("welcome.recentSessionsType")}
          value={typeFilter}
          disabled={sessions.length === 0}
          onChange={(event) => onTypeFilterChange(event.target.value)}
        >
          <option value="all">{t("welcome.recentSessionsAllTypes")}</option>
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="relative w-[172px] max-w-full">
          <ArrowUpDown className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <select
            data-testid="welcome-recent-sort"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            aria-label={t("welcome.recentSessionsSort")}
            title={t("welcome.recentSessionsSort")}
            value={sort}
            disabled={sessions.length === 0}
            onChange={(event) => onSortChange(event.target.value as RecentSessionSort)}
          >
            <option value="last-desc">{t("welcome.recentSessionsSortLastDesc")}</option>
            <option value="last-asc">{t("welcome.recentSessionsSortLastAsc")}</option>
            <option value="name-asc">{t("welcome.recentSessionsSortNameAsc")}</option>
            <option value="name-desc">{t("welcome.recentSessionsSortNameDesc")}</option>
            <option value="type-asc">{t("welcome.recentSessionsSortTypeAsc")}</option>
            <option value="type-desc">{t("welcome.recentSessionsSortTypeDesc")}</option>
            <option value="host-asc">{t("welcome.recentSessionsSortHostAsc")}</option>
            <option value="host-desc">{t("welcome.recentSessionsSortHostDesc")}</option>
          </select>
        </div>
        <button
          data-testid="welcome-recent-clear-filter"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={!hasFilter}
          onClick={onClearFilter}
        >
          <X className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsClearFilter")}</span>
        </button>
        <div className="h-6 w-px" style={{ background: "var(--taomni-divider)" }} />
        <button
          data-testid="welcome-recent-select-filtered"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={filteredSessions.length === 0}
          onClick={onSelectFiltered}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsSelectFiltered")}</span>
        </button>
        <button
          data-testid="welcome-recent-open-all"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!canOpen || sessions.length === 0}
          onClick={() => onOpenSessions?.(sessions)}
        >
          <Play className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsOpenAll")}</span>
        </button>
        <button
          data-testid="welcome-recent-open-filtered"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!canOpen || filteredSessions.length === 0}
          onClick={() => onOpenSessions?.(filteredSessions)}
        >
          <Play className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsOpenFiltered")}</span>
        </button>
        <button
          data-testid="welcome-recent-open-selected"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!canOpen || selectedSessions.length === 0}
          onClick={() => onOpenSessions?.(selectedSessions)}
        >
          <Play className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsOpenSelected")}</span>
        </button>
        {onOpenSettings ? (
          <button
            data-testid="welcome-recent-settings"
            className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
            type="button"
            title={t("welcome.recentSessionsSettings")}
            aria-label={t("welcome.recentSessionsSettings")}
            onClick={onOpenSettings}
          >
            <Settings className="w-[18px] h-[18px]" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="mt-2 min-h-[26px] flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
        <span>{t("welcome.recentSessionsSelectedCount", { count: selectedCount })}</span>
        {selectedCount > 0 ? (
          <button
            data-testid="welcome-recent-clear-selection"
            className="taomni-btn h-6 px-2"
            type="button"
            onClick={onClearSelection}
          >
            {t("welcome.recentSessionsClearSelection")}
          </button>
        ) : null}
      </div>

      <div className="mt-2 max-h-[260px] overflow-auto">
        {sessions.length === 0 ? (
          <div
            data-testid="welcome-recent-empty"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentSessionsEmpty")}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div
            data-testid="welcome-recent-no-matches"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentSessionsNoMatches")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredSessions.map((session) => {
              const typeLabel = sessionTypeLabel(session.session_type, session.options_json);
              const title = session.name || session.host || typeLabel;
              const selected = selectedIds.has(session.id);
              return (
                <div
                  key={session.id}
                  data-testid="welcome-recent-session-row"
                  data-session-id={session.id}
                  data-session-name={title}
                  data-session-type={typeLabel}
                  className="grid grid-cols-[32px_minmax(0,1fr)_32px] items-center gap-2 rounded border px-2 py-1.5"
                  style={{
                    borderColor: selected ? "var(--taomni-accent)" : "var(--taomni-divider)",
                    background: selected ? "var(--taomni-selected)" : "var(--taomni-input-bg)",
                  }}
                  onContextMenu={(event) => {
                    const targetSessions = selected ? selectedSessions : [session];
                    if (!selected) onSetSelectedSessions([session.id]);
                    ctx.show(event, recentSessionMenuItems({
                      t,
                      session,
                      targetSessions,
                      allSessions,
                      folderPaths,
                      setStatusMessage,
                      onOpenSession,
                      onOpenSessions,
                      onEditSession,
                      onDuplicateSessions: duplicateSessions,
                      onMoveSessionsToGroup: moveSessionsToGroup,
                      onSetTerminalAppearance: setTerminalAppearance,
                      onDeleteSessions: confirmDeleteSessions,
                      onConnectMenuSessions: connectMenuSessions,
                    }));
                  }}
                >
                  <button
                    data-testid="welcome-recent-select"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    aria-label={t("welcome.recentSessionsSelectAria", { name: title })}
                    onClick={() => onToggleSession(session.id)}
                  >
                    {selected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  </button>
                  <div className="min-w-0 text-left">
                    <div className="min-w-0 flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                      <button
                        data-testid="welcome-recent-open"
                        className="min-w-0 truncate text-left text-[12px] font-medium text-[var(--taomni-accent)] hover:underline focus-visible:underline"
                        type="button"
                        aria-label={t("welcome.recentSessionsOpenAria", { name: title })}
                        onClick={() => onOpenSession?.(session)}
                      >
                        {title}
                      </button>
                      <span className="shrink-0 text-[10px] taomni-mono px-1.5 py-0.5 rounded border text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                        {typeLabel}
                      </span>
                    </div>
                    <div data-testid="welcome-recent-details" className="mt-0.5 truncate text-[11px] text-[var(--taomni-text-muted)]">
                      {recentSessionTarget(session)} · {t("welcome.recentSessionsUpdated", { time: formatRecentSessionTime(session.last_connected_at, t) })}
                    </div>
                  </div>
                  <button
                    data-testid="welcome-recent-reveal"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    disabled={!onRevealSession}
                    title={t("welcome.recentSessionsReveal")}
                    aria-label={t("welcome.recentSessionsRevealAria", { name: title })}
                    onClick={() => onRevealSession?.(session)}
                  >
                    <ListTree className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {ctx.render}
      {deleteConfirm.render}
    </section>
  );
}

function recentSessionMenuItems({
  t,
  session,
  targetSessions,
  allSessions,
  folderPaths,
  setStatusMessage,
  onOpenSession,
  onOpenSessions,
  onEditSession,
  onDuplicateSessions,
  onMoveSessionsToGroup,
  onSetTerminalAppearance,
  onDeleteSessions,
  onConnectMenuSessions,
}: {
  t: TranslateFn;
  session: SessionConfig;
  targetSessions: readonly SessionConfig[];
  allSessions: readonly SessionConfig[];
  folderPaths: string[];
  setStatusMessage: (message: string) => void;
  onOpenSession?: (session: SessionConfig) => void;
  onOpenSessions?: (sessions: SessionConfig[]) => void;
  onEditSession?: (session: SessionConfig) => void;
  onDuplicateSessions: (ids: string[]) => Promise<void>;
  onMoveSessionsToGroup: (ids: string[], groupPath: string | null) => Promise<void>;
  onSetTerminalAppearance: (patch: SessionTerminalAppearancePatch, sessions: readonly SessionConfig[]) => Promise<void>;
  onDeleteSessions: (sessions: readonly SessionConfig[]) => Promise<void>;
  onConnectMenuSessions: (sessions: readonly SessionConfig[], sourceLabel: string) => void;
}): MenuItem[] {
  const uniqueSessions = uniqueRecentSessionsById(targetSessions);
  const targetIds = uniqueSessions.map((candidate) => candidate.id);
  const hasMultiSelection = uniqueSessions.length > 1;
  const moveChildren: MenuItem[] = [
    {
      label: SESSION_ROOT_LABEL,
      icon: <FolderOpen className="w-3 h-3" />,
      onClick: () => void onMoveSessionsToGroup(targetIds, null),
    },
    ...folderPaths.map((path) => ({
      label: folderOptionLabel(path),
      icon: <Folder className="w-3 h-3" />,
      onClick: () => void onMoveSessionsToGroup(targetIds, path),
    })),
  ];
  const copyCommandItem = buildSessionConnectionCommandMenuItem({
    session,
    allSessions,
    t,
    setStatusMessage,
  });

  return [
    ...(hasMultiSelection ? [
      {
        label: t("sessionTree.contextConnectSelected", { count: uniqueSessions.length }),
        testId: `context-menu-item-connect-selected-sessions-${uniqueSessions.length}`,
        icon: <Play className="w-3 h-3" />,
        onClick: () => onConnectMenuSessions(uniqueSessions, t("sessionTree.fromSelected")),
        disabled: !onOpenSessions,
      },
      { label: "", separator: true },
    ] satisfies MenuItem[] : []),
    {
      label: t("sessionTree.contextConnect"),
      icon: <Play className="w-3 h-3" />,
      disabled: !onOpenSession,
      onClick: () => onOpenSession?.(session),
    },
    ...(copyCommandItem ? [copyCommandItem] : []),
    {
      label: t("sessionTree.contextEdit"),
      icon: <Edit3 className="w-3 h-3" />,
      disabled: !onEditSession,
      onClick: () => onEditSession?.(session),
    },
    {
      label: hasMultiSelection
        ? t("sessionTree.contextDuplicateCount", { count: targetIds.length })
        : t("sessionTree.contextDuplicate"),
      testId: hasMultiSelection ? `context-menu-item-duplicate-selected-sessions-${targetIds.length}` : undefined,
      icon: <Copy className="w-3 h-3" />,
      onClick: () => void onDuplicateSessions(targetIds),
    },
    {
      label: t("sessionTree.contextMoveToFolder"),
      icon: <Folder className="w-3 h-3" />,
      children: moveChildren,
    },
    buildSessionTerminalThemeMenuItem({
      sessions: uniqueSessions,
      t,
      onSelectAppearance: onSetTerminalAppearance,
    }),
    { label: "", separator: true },
    {
      label: hasMultiSelection
        ? t("sessionTree.contextDeleteCount", { count: targetIds.length })
        : t("sessionTree.contextDelete"),
      testId: hasMultiSelection ? `context-menu-item-delete-selected-sessions-${targetIds.length}` : undefined,
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      onClick: () => void onDeleteSessions(uniqueSessions),
    },
  ];
}

function uniqueRecentSessionsById(sessions: readonly SessionConfig[]): SessionConfig[] {
  const seen = new Set<string>();
  const unique: SessionConfig[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  return unique;
}

function compareRecentSessions(a: SessionConfig, b: SessionConfig, sort: RecentSessionSort): number {
  const labelA = sessionTypeLabel(a.session_type, a.options_json);
  const labelB = sessionTypeLabel(b.session_type, b.options_json);
  const nameA = (a.name || a.host || labelA).toLowerCase();
  const nameB = (b.name || b.host || labelB).toLowerCase();
  if (sort === "last-asc") return (a.last_connected_at ?? 0) - (b.last_connected_at ?? 0);
  if (sort === "name-asc") return nameA.localeCompare(nameB);
  if (sort === "name-desc") return nameB.localeCompare(nameA);
  if (sort === "type-asc") return labelA.localeCompare(labelB) || nameA.localeCompare(nameB);
  if (sort === "type-desc") return labelB.localeCompare(labelA) || nameA.localeCompare(nameB);
  if (sort === "host-asc") return (a.host || "").localeCompare(b.host || "") || nameA.localeCompare(nameB);
  if (sort === "host-desc") return (b.host || "").localeCompare(a.host || "") || nameA.localeCompare(nameB);
  return (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0);
}

function recentSessionTarget(session: SessionConfig): string {
  const host = session.host?.trim();
  if (session.session_type === "File") return host || session.name || "File";
  if (session.session_type === "LocalShell") return host || session.name || "Local shell";
  if (!host) return session.group_path || session.session_type;
  const user = session.username ? `${session.username}@` : "";
  const port = session.port ? `:${session.port}` : "";
  return `${user}${host}${port}`;
}

function formatRecentSessionTime(value: number | null | undefined, t: TranslateFn): string {
  if (!value) return t("welcome.recentSessionsNever");
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function LocalTerminalCard({
  translate: t,
  shells,
  selectedShell,
  selectedShellId,
  shellStatus,
  onSelectShell,
  kbd,
  onStart,
  onStartAsAdministrator,
  onOpenHomeFolder,
}: {
  translate: TranslateFn;
  shells: LocalShellOption[];
  selectedShell?: LocalShellOption;
  selectedShellId: string;
  shellStatus: "loading" | "ready" | "error";
  onSelectShell: (id: string) => void;
  kbd: string;
  onStart: () => void;
  onStartAsAdministrator: () => void;
  onOpenHomeFolder?: () => void;
}) {
  const hasChoices = shells.length > 1;
  const canElevate = selectedShell?.canElevate ?? false;
  const detail = selectedShell?.path ?? (
    shellStatus === "loading" ? t("welcome.detectingShells") : t("welcome.useDefault")
  );

  return (
    <div
      className="text-left p-4 min-h-[170px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}><TerminalIcon className="w-5 h-5" /></span>
        <span className="font-semibold">{t("welcome.localTerminal")}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] taomni-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--taomni-input-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">
        {selectedShell ? t("welcome.openShell", { shell: selectedShell.name }) : t("welcome.openLocalShell")}
      </div>

      <div className="mt-3 space-y-3">
        {hasChoices ? (
          <select
            className="taomni-input h-8 w-full"
            aria-label={t("welcome.terminalShellAria")}
            value={selectedShellId}
            title={selectedShell?.path}
            onChange={(event) => onSelectShell(event.target.value)}
          >
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.name}{shell.isDefault ? t("welcome.defaultLabel") : ""}
              </option>
            ))}
          </select>
        ) : (
          <div
            className="taomni-input h-8 w-full flex items-center truncate"
            title={detail}
            style={{ color: selectedShell ? "var(--taomni-text)" : "var(--taomni-text-muted)" }}
          >
            {selectedShell?.name ?? (shellStatus === "loading" ? t("welcome.detectingShellsShort") : t("welcome.defaultShell"))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button data-testid="welcome-open-local-terminal" className="taomni-btn h-8 px-3" onClick={onStart} type="button">
            {t("welcome.open")}
          </button>
          {canElevate && (
            <button
              className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onStartAsAdministrator}
              title={t("welcome.adminTitle")}
              aria-label={t("welcome.adminTitle")}
              type="button"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>{t("welcome.admin")}</span>
            </button>
          )}
          {onOpenHomeFolder && (
            <button
              data-testid="welcome-open-home-folder"
              className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onOpenHomeFolder}
              title={t("welcome.homeFolderTitle")}
              type="button"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t("welcome.homeFolder")}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WslCard({
  translate: t,
  distros,
  selectedDistro,
  onSelectDistro,
  onStart,
}: {
  translate: TranslateFn;
  distros: WslDistro[];
  selectedDistro: string;
  onSelectDistro: (name: string) => void;
  onStart: () => void;
}) {
  const current = distros.find((d) => d.name === selectedDistro);
  const detail = current
    ? t("welcome.wslDetail", {
        state: current.state,
        version: current.version != null ? String(current.version) : "?",
      })
    : t("welcome.wslOpenDesc");

  return (
    <div
      data-testid="welcome-wsl-card"
      className="text-left p-4 min-h-[170px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "#0078d4" }}>
          <TerminalIcon className="w-5 h-5" />
        </span>
        <span className="font-semibold">{t("welcome.openWsl")}</span>
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{detail}</div>

      <div className="mt-3 space-y-3">
        <select
          data-testid="welcome-wsl-distro"
          className="taomni-input h-8 w-full"
          aria-label={t("welcome.wslDistroAria")}
          value={selectedDistro}
          onChange={(event) => onSelectDistro(event.target.value)}
        >
          {distros.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}{d.isDefault ? t("welcome.defaultLabel") : ""}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button
            data-testid="welcome-wsl-open"
            className="taomni-btn h-8 px-3"
            onClick={onStart}
            type="button"
          >
            {t("welcome.openWslButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

function MailSessionsCard({
  translate: t,
  sessions,
  onOpen,
}: {
  translate: TranslateFn;
  sessions: SessionConfig[];
  onOpen?: (session: SessionConfig) => void;
}) {
  return (
    <div
      data-testid="welcome-mail-card"
      className="text-left p-4 min-h-[138px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}><MailIcon className="w-5 h-5" /></span>
        <span className="font-semibold">{t("welcome.mailTitle")}</span>
        <span className="ml-auto text-[11px] taomni-mono text-[var(--taomni-text-muted)]">{sessions.length}</span>
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("welcome.mailDesc")}</div>
      <div className="mt-3 flex-1 min-h-0 max-h-[132px] overflow-auto space-y-1">
        {sessions.map((session) => {
          const title = session.name || session.username || session.host || "Mailbox";
          const detail = session.username || session.host || "";
          return (
            <button
              key={session.id}
              data-testid="welcome-mail-session"
              className="w-full text-left rounded border px-2 py-1.5 flex items-center gap-2 hover:bg-[var(--taomni-control-hover)]"
              style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-input-bg)" }}
              type="button"
              disabled={!onOpen}
              aria-label={t("welcome.mailOpenAria", { name: title })}
              onClick={() => onOpen?.(session)}
            >
              <MailIcon className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[var(--taomni-accent)]">{title}</span>
                {detail && detail !== title ? (
                  <span className="block truncate text-[11px] text-[var(--taomni-text-muted)]">{detail}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ActionCard({
  testId,
  icon,
  title,
  desc,
  kbd,
  onClick,
}: {
  testId?: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={testId}
      className="text-left p-4 min-h-[138px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}>{icon}</span>
        <span className="font-semibold">{title}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] taomni-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--taomni-input-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{desc}</div>
    </button>
  );
}
