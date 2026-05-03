import { useEffect, useMemo, useState } from "react";
import {
  Terminal as TerminalIcon,
  Monitor,
  Folder,
  Wifi,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Play,
  Edit3,
  Copy,
  Trash2,
  Plus,
  FolderPlus,
  Upload,
  Download,
  FileText,
  Share2,
  Star,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import type { SessionConfig, SessionGroup } from "../../lib/ipc";
import {
  parseCsvSessions,
  parseMobaXtermSessions,
  parseNewMobSessions,
  serializeMobaXtermSessions,
  serializeNewMobSessions,
  type SessionExportResult,
  type SessionImportResult,
} from "../../lib/sessionImportExport";
import {
  SESSION_ROOT_LABEL,
  ancestorGroupPaths,
  collectFolderPaths,
  folderOptionLabel,
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  parentGroupPath,
  splitGroupPath,
  toStoredGroupPath,
} from "../../lib/sessionPaths";

interface SessionTreeProps {
  onNewSession?: (groupPath?: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onEditSession?: (session: SessionConfig) => void;
}

interface FolderNode {
  name: string;
  path: string | null;
  folders: FolderNode[];
  sessions: SessionConfig[];
}

export function SessionTree({ onNewSession, onConnectSession, onEditSession }: SessionTreeProps) {
  const {
    sessions,
    groups,
    searchQuery,
    selectedSessionId,
    loadSessions,
    removeSession,
    duplicateSession,
    moveSessionToGroup,
    createFolderPath,
    renameFolderPath,
    deleteFolderPath,
    importSessions,
    setSelectedSession,
    loading,
  } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ root: true });
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const filteredSessions = useMemo(
    () => filterSessions(sessions, searchQuery),
    [sessions, searchQuery],
  );
  const tree = useMemo(
    () => buildSessionTree(filteredSessions, searchQuery ? [] : groups),
    [filteredSessions, groups, searchQuery],
  );
  const folderPaths = useMemo(
    () => collectFolderPaths(sessions, groups),
    [sessions, groups],
  );

  const toggle = (key: string) =>
    setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const expandPath = (path: string | null | undefined) => {
    setExpanded((state) => {
      const next: Record<string, boolean> = { ...state, root: true };
      for (const ancestor of ancestorGroupPaths(path)) {
        next[folderKey(ancestor)] = true;
      }
      return next;
    });
  };

  const handleDrop = (event: React.DragEvent, groupPath: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const sessionId = event.dataTransfer.getData("application/x-newmob-session");
    setDragOverGroup(null);
    if (sessionId) {
      void moveSessionToGroup(sessionId, groupPath);
      expandPath(groupPath);
    }
  };

  const handleDragOver = (event: React.DragEvent, groupPath: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverGroup(folderKey(groupPath));
  };

  const createFolder = async (parentPath: string | null) => {
    const base = folderOptionLabel(parentPath);
    const next = window.prompt("New folder", `${base} / New folder`);
    const normalized = normalizeGroupPath(next);
    if (!normalized) return;

    await createFolderPath(normalized);
    expandPath(normalized);
    setStatusMessage(`Created folder ${folderOptionLabel(normalized)}`);
  };

  const renameFolder = async (folderPath: string) => {
    const next = window.prompt("Edit folder", folderOptionLabel(folderPath));
    const normalized = normalizeGroupPath(next);
    if (!normalized || normalized === normalizeGroupPath(folderPath)) return;
    if (groupPathContains(folderPath, normalized)) {
      window.alert("A folder cannot be moved inside itself.");
      return;
    }

    await renameFolderPath(folderPath, normalized);
    expandPath(normalized);
    setStatusMessage(`Renamed folder to ${folderOptionLabel(normalized)}`);
  };

  const deleteFolder = async (folderPath: string) => {
    const affected = sessionsInFolder(sessions, folderPath);
    const suffix = affected.length > 0
      ? ` and ${affected.length} session${affected.length === 1 ? "" : "s"} inside it`
      : "";
    if (!window.confirm(`Delete folder "${folderOptionLabel(folderPath)}"${suffix}?`)) return;

    await deleteFolderPath(folderPath);
    setStatusMessage(`Deleted folder ${folderOptionLabel(folderPath)}`);
  };

  const exportFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeNewMobSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("NewMob", result, folderSessions.length, label);
  };

  const exportMobaFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeMobaXtermSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("MobaXterm", result, folderSessions.length - result.skipped, label);
  };

  const generateHtml = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const rows = folderSessions.map((session) => `
      <tr>
        <td>${escapeHtml(session.name)}</td>
        <td>${escapeHtml(session.session_type)}</td>
        <td>${escapeHtml(session.host)}</td>
        <td>${session.port}</td>
        <td>${escapeHtml(session.username ?? "")}</td>
      </tr>`).join("");
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(label)}</title>
  <style>
    body { font: 13px system-ui, sans-serif; margin: 24px; color: #1d2330; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #c8cdd4; padding: 6px 8px; text-align: left; }
    th { background: #eaf1fa; }
  </style>
</head>
<body>
  <h1>${escapeHtml(label)}</h1>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Host</th><th>Port</th><th>User</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

    downloadTextFile(`${slugify(label)}.html`, html, "text/html");
    setStatusMessage(`Generated HTML page for ${label}`);
  };

  const importJson = (folderPath: string | null) => {
    openTextFile(".json,.newmob-sessions.json,application/json", async (text) => {
      const result = parseNewMobSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      await applyImportResult(result, folderPath, "NewMob");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importMoba = (folderPath: string | null) => {
    openBinaryFile(".mxtsessions,.moba,text/plain,application/octet-stream", async (bytes) => {
      const result = parseMobaXtermSessions(bytes, { targetFolder: folderPath, existingSessions: sessions });
      await applyImportResult(result, folderPath, "MobaXterm");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importCsv = (folderPath: string | null) => {
    openTextFile(".csv,text/csv", async (text) => {
      const result = parseCsvSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      await applyImportResult(result, folderPath, "CSV");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const applyImportResult = async (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
  ) => {
    if (result.sessions.length > 0) {
      await importSessions(result.sessions);
      expandPath(folderPath);
    }
    reportImportResult(source, result, folderPath);
  };

  const reportImportResult = (
    source: string,
    result: SessionImportResult,
    folderPath: string | null,
  ) => {
    const target = folderOptionLabel(folderPath);
    const count = result.sessions.length;
    const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
    const warningSuffix = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
    setStatusMessage(`Imported ${count} ${source} session${count === 1 ? "" : "s"} into ${target}${skipped}${warningSuffix}`);
    reportWarnings(result.warnings);
  };

  const reportExportResult = (
    format: string,
    result: SessionExportResult,
    count: number,
    label: string,
  ) => {
    const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
    const warningSuffix = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
    setStatusMessage(`Exported ${count} ${format} session${count === 1 ? "" : "s"} from ${label}${skipped}${warningSuffix}`);
    reportWarnings(result.warnings);
  };

  const reportWarnings = (warnings: string[]) => {
    if (warnings.length === 0) return;
    const shown = warnings.slice(0, 8);
    const more = warnings.length > shown.length ? `\n...and ${warnings.length - shown.length} more warning${warnings.length - shown.length === 1 ? "" : "s"}.` : "";
    window.alert(`${shown.join("\n")}${more}`);
  };

  const executeFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    for (const session of folderSessions) {
      onConnectSession?.(session);
    }
    setStatusMessage(`Started ${folderSessions.length} session${folderSessions.length === 1 ? "" : "s"} from ${folderOptionLabel(folderPath)}`);
  };

  const unavailable = (label: string) => {
    setStatusMessage(`${label} is not implemented yet`);
  };

  const folderContextMenu = (e: React.MouseEvent, folderPath: string | null) => {
    const normalized = normalizeGroupPath(folderPath);
    const isRoot = !normalized;
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const importChildren: MenuItem[] = [
      "WSL sessions",
      "External Bash sessions",
      "PuTTY sessions",
      "PuTTYCM sessions",
      "SuperPuTTY sessions",
      "MRemote sessions",
      "Exceed sessions",
      "SCRT sessions",
      "RDM sessions",
    ].map((label) => ({
      label: `Import ${label}`,
      icon: <TerminalIcon className="w-3 h-3" />,
      onClick: () => unavailable(`Import ${label}`),
    }));
    importChildren.unshift({
      label: "Import MobaXterm sessions",
      icon: <Upload className="w-3 h-3" />,
      onClick: () => importMoba(folderPath),
    });
    importChildren.push(
      {
        label: "Import sessions from a CSV file",
        icon: <FileText className="w-3 h-3" />,
        onClick: () => importCsv(folderPath),
      },
    );

    ctx.show(e, [
      { label: "New session", icon: <Plus className="w-3 h-3" />, onClick: () => onNewSession?.(toStoredGroupPath(folderPath)) },
      { label: "New folder", icon: <FolderPlus className="w-3 h-3" />, onClick: () => void createFolder(folderPath) },
      { label: "Edit folder", icon: <Edit3 className="w-3 h-3" />, disabled: isRoot, onClick: () => normalized && void renameFolder(normalized) },
      { label: "Delete folder", icon: <Trash2 className="w-3 h-3" />, danger: true, disabled: isRoot, onClick: () => normalized && void deleteFolder(normalized) },
      { label: "Create a desktop shortcut", icon: <Star className="w-3 h-3" />, onClick: () => unavailable("Create a desktop shortcut") },
      { label: "", separator: true },
      { label: "Import NewMob sessions", icon: <Upload className="w-3 h-3" />, onClick: () => importJson(folderPath) },
      { label: "Export NewMob sessions", icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportFolder(folderPath) },
      { label: "Export MobaXterm sessions", icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportMobaFolder(folderPath) },
      { label: "Import sessions from third-party programs", icon: <Upload className="w-3 h-3" />, children: importChildren },
      { label: "Generate HTML web page", icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => generateHtml(folderPath) },
      { label: "", separator: true },
      { label: "Execute all sessions from this folder", icon: <Play className="w-3 h-3" />, disabled: folderSessions.length === 0 || !onConnectSession, onClick: () => executeFolder(folderPath) },
      { label: "", separator: true },
      { label: "Share these sessions with my team", icon: <Share2 className="w-3 h-3" />, onClick: () => unavailable("Share these sessions with my team") },
    ]);
  };

  const sessionContextMenu = (e: React.MouseEvent, session: SessionConfig) => {
    setSelectedSession(session.id);
    const moveChildren: MenuItem[] = [
      { label: SESSION_ROOT_LABEL, icon: <FolderOpen className="w-3 h-3" />, onClick: () => void moveSessionToGroup(session.id, null) },
      ...folderPaths.map((path) => ({
        label: folderOptionLabel(path),
        icon: <Folder className="w-3 h-3" />,
        onClick: () => {
          void moveSessionToGroup(session.id, path);
          expandPath(path);
        },
      })),
    ];

    ctx.show(e, [
      { label: "Connect", icon: <Play className="w-3 h-3" />, onClick: () => onConnectSession?.(session), disabled: !onConnectSession },
      { label: "Edit...", icon: <Edit3 className="w-3 h-3" />, onClick: () => onEditSession?.(session), disabled: !onEditSession },
      { label: "Duplicate", icon: <Copy className="w-3 h-3" />, onClick: () => void duplicateSession(session.id) },
      { label: "Move to folder", icon: <Folder className="w-3 h-3" />, children: moveChildren },
      { label: "", separator: true },
      { label: "Delete", icon: <Trash2 className="w-3 h-3" />, danger: true, onClick: () => void removeSession(session.id) },
    ]);
  };

  return (
    <div
      data-testid="session-tree"
      className="flex-1 moba-scroll-y text-[12px]"
      onContextMenu={(event) => folderContextMenu(event, null)}
    >
      {ctx.render}
      <TreeFolder
        node={tree}
        count={countNodeSessions(tree)}
        open={expanded.root !== false}
        onToggle={() => toggle("root")}
        onContextMenu={(event) => folderContextMenu(event, null)}
        onDrop={(event) => handleDrop(event, null)}
        onDragOver={(event) => handleDragOver(event, null)}
        onDragLeave={() => setDragOverGroup(null)}
        dragOver={dragOverGroup === "root"}
      >
        <FolderContents
          node={tree}
          expanded={expanded}
          searchQuery={searchQuery}
          selectedSessionId={selectedSessionId}
          dragOverGroup={dragOverGroup}
          onToggle={toggle}
          onFolderContextMenu={folderContextMenu}
          onSessionContextMenu={sessionContextMenu}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragOverGroup(null)}
          onSelectSession={setSelectedSession}
          onConnectSession={onConnectSession}
        />
        {filteredSessions.length === 0 && !loading && (
          <div className="pl-6 py-2 text-[11px] text-[var(--moba-text-muted)]">
            {searchQuery ? "No matching sessions." : "No sessions yet. Right-click User sessions to create one."}
          </div>
        )}
      </TreeFolder>

    </div>
  );
}

function FolderContents({
  node,
  expanded,
  searchQuery,
  selectedSessionId,
  dragOverGroup,
  onToggle,
  onFolderContextMenu,
  onSessionContextMenu,
  onDrop,
  onDragOver,
  onDragLeave,
  onSelectSession,
  onConnectSession,
}: {
  node: FolderNode;
  expanded: Record<string, boolean>;
  searchQuery: string;
  selectedSessionId: string | null;
  dragOverGroup: string | null;
  onToggle: (key: string) => void;
  onFolderContextMenu: (event: React.MouseEvent, path: string | null) => void;
  onSessionContextMenu: (event: React.MouseEvent, session: SessionConfig) => void;
  onDrop: (event: React.DragEvent, groupPath: string | null) => void;
  onDragOver: (event: React.DragEvent, groupPath: string | null) => void;
  onDragLeave: () => void;
  onSelectSession: (id: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
}) {
  return (
    <>
      {node.folders.map((folder) => {
        const key = folderKey(folder.path);
        const isOpen = searchQuery ? true : !!expanded[key];

        return (
          <TreeFolder
            key={key}
            node={folder}
            count={countNodeSessions(folder)}
            open={isOpen}
            onToggle={() => onToggle(key)}
            onContextMenu={(event) => onFolderContextMenu(event, folder.path)}
            onDrop={(event) => onDrop(event, folder.path)}
            onDragOver={(event) => onDragOver(event, folder.path)}
            onDragLeave={onDragLeave}
            dragOver={dragOverGroup === key}
          >
            <FolderContents
              node={folder}
              expanded={expanded}
              searchQuery={searchQuery}
              selectedSessionId={selectedSessionId}
              dragOverGroup={dragOverGroup}
              onToggle={onToggle}
              onFolderContextMenu={onFolderContextMenu}
              onSessionContextMenu={onSessionContextMenu}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onSelectSession={onSelectSession}
              onConnectSession={onConnectSession}
            />
          </TreeFolder>
        );
      })}

      {node.sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          selected={selectedSessionId === session.id}
          onClick={() => onSelectSession(session.id)}
          onDoubleClick={() => onConnectSession?.(session)}
          onContextMenu={(event) => onSessionContextMenu(event, session)}
        />
      ))}
    </>
  );
}

function TreeFolder({
  node,
  count,
  open,
  onToggle,
  children,
  onContextMenu,
  onDrop,
  onDragOver,
  onDragLeave,
  dragOver,
}: {
  node: FolderNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDrop?: (event: React.DragEvent) => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDragLeave?: () => void;
  dragOver?: boolean;
}) {
  const isRoot = node.path === null;
  const hasChildren = node.folders.length > 0 || node.sessions.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:bg-[var(--moba-hover)]"
        data-drag-over={dragOver}
        style={dragOver ? { background: "var(--moba-selected)" } : undefined}
        onClick={onToggle}
        onContextMenu={onContextMenu}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-slate-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-slate-500" />
        )}
        {open || isRoot ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-600" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-600" />
        )}
        <span className="flex-1 font-medium truncate">{node.name}</span>
        {count !== undefined && hasChildren && (
          <span className="text-[10px] text-slate-500">({count})</span>
        )}
      </div>
      {open && <div className="pl-4">{children}</div>}
    </div>
  );
}

function SessionItem({
  session,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  session: SessionConfig;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const icon = sessionIcon(session.session_type);

  return (
    <div
      data-testid="session-tree-item"
      data-session-name={session.name}
      data-session-type={session.session_type}
      className="flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:bg-[var(--moba-hover)] group"
      data-selected={selected}
      style={selected ? { background: "var(--moba-selected)" } : undefined}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-newmob-session", session.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span className="w-3" />
      {icon}
      <span className="flex-1 truncate">
        {session.name}
        {session.username && session.host && (
          <span className="text-[var(--moba-text-muted)]">
            {" "}({session.username}@{session.host})
          </span>
        )}
      </span>
      <span
        className="text-[10px] px-1 rounded"
        style={{ background: "#e1ecfa", color: "#1e3a5f" }}
      >
        {session.session_type}
      </span>
    </div>
  );
}

function sessionIcon(type: string) {
  switch (type) {
    case "SSH":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
    case "RDP":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#a04b9c" }} />;
    case "VNC":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />;
    case "SFTP":
    case "FTP":
      return <Folder className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />;
    case "Serial":
      return <Wifi className="w-3.5 h-3.5" style={{ color: "#236a98" }} />;
    case "LocalShell":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#62d36f" }} />;
    default:
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
  }
}

function buildSessionTree(sessions: SessionConfig[], groups: SessionGroup[]): FolderNode {
  const root: FolderNode = {
    name: SESSION_ROOT_LABEL,
    path: null,
    folders: [],
    sessions: [],
  };

  const nodes = new Map<string, FolderNode>();

  const ensureFolder = (path: string): FolderNode => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return root;
    const existing = nodes.get(normalized);
    if (existing) return existing;

    const parentPath = parentGroupPath(normalized);
    const parent = parentPath ? ensureFolder(parentPath) : root;
    const node: FolderNode = {
      name: leafGroupName(normalized),
      path: normalized,
      folders: [],
      sessions: [],
    };
    nodes.set(normalized, node);
    parent.folders.push(node);
    return node;
  };

  for (const path of collectFolderPaths(sessions, groups)) {
    ensureFolder(path);
  }

  for (const session of sessions) {
    const path = normalizeGroupPath(session.group_path);
    if (path) ensureFolder(path).sessions.push(session);
    else root.sessions.push(session);
  }

  sortFolder(root);
  return root;
}

function sortFolder(node: FolderNode) {
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.sessions.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  for (const folder of node.folders) sortFolder(folder);
}

function countNodeSessions(node: FolderNode): number {
  return node.sessions.length + node.folders.reduce((sum, folder) => sum + countNodeSessions(folder), 0);
}

function folderKey(path: string | null | undefined): string {
  return normalizeGroupPath(path) ?? "root";
}

function sessionsInFolder(sessions: SessionConfig[], folderPath: string | null | undefined): SessionConfig[] {
  const normalized = normalizeGroupPath(folderPath);
  if (!normalized) return sessions;
  return sessions.filter((session) => groupPathContains(normalized, session.group_path));
}

function filterSessions(sessions: SessionConfig[], query: string): SessionConfig[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((session) => {
    const haystack = [
      session.name,
      session.session_type,
      folderOptionLabel(session.group_path),
      session.host,
      session.username ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

function openTextFile(accept: string, onText: (text: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve();
        return;
      }

      file.text()
        .then(onText)
        .then(resolve)
        .catch(reject);
    };
    input.click();
  });
}

function openBinaryFile(accept: string, onBytes: (bytes: ArrayBuffer) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve();
        return;
      }

      file.arrayBuffer()
        .then(onBytes)
        .then(resolve)
        .catch(reject);
    };
    input.click();
  });
}

function downloadTextFile(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value: string): string {
  return splitGroupPath(value).join("-").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "user-sessions";
}
