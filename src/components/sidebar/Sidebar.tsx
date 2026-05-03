import {
  Search,
  Plus,
  Edit3,
  Copy,
  Trash2,
  RefreshCw,
  Star,
  Clock,
  Terminal as TerminalIcon,
  Wrench,
  Gamepad2,
  Bot,
  FolderTree,
} from "lucide-react";
import { SessionTree } from "./SessionTree";
import { useAppStore, type SideTab } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig } from "../../lib/ipc";

interface SidebarProps {
  onNewSession?: (groupPath?: string | null) => void;
  onNewSftpSession?: () => void;
  onEditSession?: (session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
  compact?: boolean;
}

export function Sidebar({ onNewSession, onNewSftpSession, onEditSession, onConnectSession, compact = false }: SidebarProps) {
  const {
    activeSideTab,
    setActiveSideTab,
    setSidebarCollapsed,
  } = useAppStore();
  const {
    sessions,
    selectedSessionId,
    searchQuery,
    setSearchQuery,
    loadSessions,
    removeSession,
    duplicateSession,
    updateSession,
  } = useSessionStore();
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const recentSessions = sessions
    .filter((session) => session.last_connected_at)
    .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
    .slice(0, 6);

  const handleDelete = () => {
    if (!selectedSession) return;
    if (window.confirm(`Delete session "${selectedSession.name}"?`)) {
      void removeSession(selectedSession.id);
    }
  };

  const handleFavorite = () => {
    if (!selectedSession) return;
    void updateSession({
      ...selectedSession,
      group_path: "User sessions / Favorites",
      updated_at: Math.floor(Date.now() / 1000),
    });
  };

  const handleSideTabClick = (tab: SideTab) => {
    if (compact) {
      setActiveSideTab(tab);
      return;
    }

    if (activeSideTab === tab) {
      setSidebarCollapsed(true);
      return;
    }

    setActiveSideTab(tab);
  };

  const handleSideTabCollapse = (event: React.MouseEvent) => {
    event.preventDefault();
    setSidebarCollapsed(true);
  };

  const handleSideTabContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
  };

  return (
    <div data-testid="sidebar" className="h-full flex">
      <div
        className="w-[26px] flex flex-col shrink-0"
        style={{ background: "var(--moba-tab-inactive)", borderRight: "1px solid var(--moba-sidebar-border)" }}
      >
        {(["sessions", "tools", "macros", "games"] as const).map((t) => (
          <div
            key={t}
            className="moba-side-tab"
            data-active={activeSideTab === t && !compact}
            onClick={() => handleSideTabClick(t)}
            onDoubleClick={handleSideTabCollapse}
            onContextMenu={handleSideTabContextMenu}
            title={compact ? `Show ${labelForSideTab(t)}` : `${labelForSideTab(t)} - click active tab again or double-click to hide`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </div>
        ))}
        <div className="flex-1" />
      </div>
      {compact && null}
      {!compact && (
      <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--moba-sidebar-bg)", borderRight: "1px solid var(--moba-sidebar-border)" }}>
        <div className="h-7 flex items-center gap-1 px-1.5 border-b shrink-0" style={{ borderColor: "var(--moba-divider)" }}>
          <IconBtn testId="session-new" title="New session" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onNewSession?.()} />
          <IconBtn testId="session-edit" title="Edit selected session" icon={<Edit3 className="w-3.5 h-3.5" />} onClick={() => selectedSession && onEditSession?.(selectedSession)} disabled={!selectedSession} />
          <IconBtn testId="session-duplicate" title="Duplicate selected session" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => selectedSession && void duplicateSession(selectedSession.id)} disabled={!selectedSession} />
          <IconBtn testId="session-delete" title="Delete selected session" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleDelete} disabled={!selectedSession} />
          <span className="moba-divider-v h-4 mx-1" />
          <IconBtn title="Refresh sessions" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void loadSessions()} />
          <IconBtn title="Move selected session to Favorites" icon={<Star className="w-3.5 h-3.5" />} onClick={handleFavorite} disabled={!selectedSession} />
          <div className="flex-1" />
          <div className="relative">
            <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--moba-text-muted)]" />
            <input
              data-testid="session-search"
              aria-label="Search sessions"
              className="moba-input pl-6 w-[140px]"
              placeholder="Search sessions…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        </div>
        {activeSideTab === "sessions" ? (
          <SessionTree onNewSession={onNewSession} onConnectSession={onConnectSession} onEditSession={onEditSession} />
        ) : (
          <UtilityPanel tab={activeSideTab} />
        )}
        <div className="h-[160px] border-t flex flex-col shrink-0" style={{ borderColor: "var(--moba-sidebar-border)", background: "var(--moba-panel-bg)" }}>
          <div className="h-6 flex items-center px-2 text-[11px] font-semibold border-b" style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}>
            <Clock className="w-3.5 h-3.5 mr-1 text-[var(--moba-text-muted)]" />
            Recent connections
            <div className="ml-auto flex items-center gap-1">
              {onNewSftpSession && (
                <IconBtn
                  title="Open SFTP browser…"
                  icon={<FolderTree className="w-3 h-3" />}
                  onClick={() => onNewSftpSession()}
                />
              )}
              <IconBtn title="Refresh sessions" icon={<RefreshCw className="w-3 h-3" />} onClick={() => void loadSessions()} />
            </div>
          </div>
          <div className="flex-1 moba-scroll-y text-[12px] py-1">
            {recentSessions.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-[var(--moba-text-muted)]">
                No recent connections yet.
                {onNewSftpSession && (
                  <button
                    type="button"
                    className="block mt-1 underline text-[var(--moba-accent)]"
                    onClick={() => onNewSftpSession()}
                  >
                    Open SFTP browser…
                  </button>
                )}
              </div>
            ) : (
              recentSessions.map((session) => (
                <button
                  key={session.id}
                  className="moba-tree-row w-full text-left"
                  onClick={() => onConnectSession?.(session)}
                  title={`${session.name} (${session.session_type})`}
                  type="button"
                >
                  <TerminalIcon className="w-3 h-3 text-[var(--moba-accent)]" />
                  <span className="flex-1 truncate">{session.name}</span>
                  <span className="text-[10px] text-slate-500">{session.session_type}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

function UtilityPanel({ tab }: { tab: Exclude<SideTab, "sessions"> }) {
  const meta = {
    tools: { icon: <Wrench className="w-4 h-4" />, title: "Tools", body: "Network tools are scheduled after terminal and session management." },
    macros: { icon: <Bot className="w-4 h-4" />, title: "Macros", body: "Macro recording is not active in this phase." },
    games: { icon: <Gamepad2 className="w-4 h-4" />, title: "Games", body: "Game shortcuts are intentionally disabled in the MVP." },
  }[tab];

  return (
    <div className="flex-1 p-3 text-[12px] text-[var(--moba-text-muted)]">
      <div className="flex items-center gap-2 font-semibold text-[var(--moba-text)] mb-2">
        {meta.icon}
        {meta.title}
      </div>
      <div>{meta.body}</div>
    </div>
  );
}

function IconBtn({
  icon,
  title,
  testId,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  testId?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-40 disabled:cursor-default"
      type="button"
    >
      {icon}
    </button>
  );
}

function labelForSideTab(tab: SideTab): string {
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}
