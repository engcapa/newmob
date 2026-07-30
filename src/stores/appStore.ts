import { create } from "zustand";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceLooseFileInfo,
  CodeWorkspaceRootInfo,
  CodeWorkspaceRootKind,
  GitTabInfo,
  RecentWorkspace,
  Tab,
} from "../types";
import { t as tr } from "../lib/i18n";
import { detectXServer, type XServerStatus } from "../lib/ipc";
import type { TabFilter } from "../lib/tabFilter";
import { terminalCwdTitlePrefix } from "../lib/terminalCwd";

export type SideTab = "sessions" | "tools";
export type TerminalSplitLayout = "horizontal" | "vertical" | "grid";
export type VaultUnlockMode = "startup" | "on-demand";

export type DbObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "trigger"
  | "event"
  | "sequence"
  | "dictionary";

export interface DbSelectedObject {
  catalog: string | null;
  schema: string | null;
  name: string;
  kind: DbObjectKind;
}

export interface CodeWorkspaceContext {
  /** Legacy primary root context kept for compatibility with existing tabs. */
  repoRoot: string;
  activePath: string | null;
  openPaths: string[];
  dirtyPaths: string[];
  roots?: CodeWorkspaceRootContext[];
  looseFiles?: CodeWorkspaceLooseFileContext[];
  activeFile?: CodeWorkspaceFileContext | null;
  openFiles?: CodeWorkspaceFileContext[];
  dirtyFiles?: CodeWorkspaceFileContext[];
  lsp?: CodeWorkspaceLspContext | null;
}

type DuplicateTabOverrides = {
  terminalInitialCwd?: string;
  terminalProfile?: Tab["terminalProfile"];
  terminalTitlePrefix?: string;
};

export type TerminalActivityState =
  | "connecting"
  | "idle"
  | "running"
  | "disconnected"
  | "unknown";

export interface TerminalRuntimeInfo {
  backendSessionId?: string;
  state: TerminalActivityState;
  program?: string;
  activitySource?: "shell-integration" | "input-heuristic" | "process-probe";
  updatedAt: number;
}

export interface CodeWorkspaceRootContext {
  id: string;
  name: string;
  path: string;
  kind: CodeWorkspaceRootKind;
}

export interface CodeWorkspaceLooseFileContext {
  id: string;
  name: string;
  path: string;
}

export type CodeWorkspaceFileContext =
  | {
      kind: "root";
      rootId: string;
      rootName?: string;
      rootPath?: string;
      path: string;
    }
  | {
      kind: "loose";
      id: string;
      name?: string;
      path: string;
    };

export interface CodeWorkspaceLspContext {
  activeStatus?: CodeWorkspaceLspStatusContext | null;
  diagnostics: CodeWorkspaceLspDiagnosticContext[];
}

export interface CodeWorkspaceLspStatusContext {
  displayName?: string | null;
  languageId?: string | null;
  active: boolean;
  available: boolean;
  selectedCommand?: string | null;
  installHint?: string | null;
  error?: string | null;
}

export interface CodeWorkspaceLspDiagnosticContext {
  file: CodeWorkspaceFileContext;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  messages: string[];
}

const UI_FONT_FAMILY_KEY = "taomni.uiFontFamily";
const UI_FONT_SIZE_KEY = "taomni.uiFontSize";
const TERMINAL_SPLIT_LAYOUT_KEY = "taomni.terminalSplitLayout";
const SQL_ECHO_KEY = "taomni.sqlEcho";
const SIDEBAR_COLLAPSED_KEY = "taomni.sidebarCollapsed";
const WELCOME_RECENT_SESSION_LIMIT_KEY = "taomni.welcomeRecentSessionLimit";
const RECENT_WORKSPACES_KEY = "taomni.recentWorkspaces.v1";
export const VAULT_UNLOCK_MODE_KEY = "taomni.vaultUnlockMode";

const DEFAULT_WELCOME_RECENT_SESSION_LIMIT = 20;
const MIN_WELCOME_RECENT_SESSION_LIMIT = 1;
const MAX_WELCOME_RECENT_SESSION_LIMIT = 100;
const MIN_UI_FONT_SIZE = 10;
const MAX_UI_FONT_SIZE = 18;

interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  activeSideTab: SideTab;
  /**
   * Whether a usable local X server is reachable (Xorg / XQuartz / VcXsrv /
   * WSLg). This is now backed by real backend detection via
   * {@link refreshXServer}, not a manual toggle — the value reflects whether
   * forwarded X11 apps actually have somewhere to display.
   */
  xServerEnabled: boolean;
  /** Full detection result for the local X server (null until first probe). */
  xServerStatus: XServerStatus | null;
  statusMessage: string;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;
  terminalSplitActive: boolean;
  terminalSplitLayout: TerminalSplitLayout;
  terminalSplitInputLockedTabIds: Set<string>;
  uiFontFamily: string;
  uiFontSize: number;
  vaultUnlockMode: VaultUnlockMode;
  welcomeRecentSessionLimit: number;
  recentWorkspaces: RecentWorkspace[];
  recentWorkspaceIdByWorkspaceInstance: Record<string, string>;
  /**
   * Transient focus filter for the open-tab strip (issue #121). When set, the
   * strip only renders tabs matching the filter; the rest are hidden, not
   * closed. Session-scoped — reset on reload and cleared whenever a new tab is
   * opened so the new tab is always visible.
   */
  tabFilter: TabFilter | null;

  /**
   * Latest known working directory per terminal tab id, mirrored from the
   * terminal's OSC-7 cwd reports (MainLayout.handleTerminalCwd). Ephemeral —
   * used by the AI chat store to tell Claude Code the bound terminal's live
   * cwd each turn (Phase 3.3). Keyed by tab id; absent until the shell first
   * reports a cwd, or for shells that can't (e.g. cmd.exe).
   */
  cwdByTab: Record<string, string>;

  /** Live connection/activity facts kept separate from persistent tab data. */
  terminalRuntimeByTab: Record<string, TerminalRuntimeInfo>;

  /**
   * Live DB-client runtime connection id per tab (Phase 6). The DB/Redis tab
   * generates this id when it connects (`createRuntimeDbSessionId`) and the
   * backend can't derive it, so we mirror it here keyed by tab id; the chat
   * store reads it to bridge `bound_db_connection_id` to the CC DB MCP each
   * turn. Absent until the tab connects; cleared on disconnect/unmount.
   */
  dbConnByTab: Record<string, string>;

  /**
   * Current objects selected in a DB tab's left schema tree. Ephemeral and keyed
   * by DB tab id; bridged into AI chat turns so SQL MCP tools can resolve
   * phrases such as "selected tables" without guessing. This can include
   * tables, views, routines, triggers, and other engine-specific object kinds.
   */
  dbSelectedObjectsByTab: Record<string, DbSelectedObject[]>;

  /**
   * Current code-workspace editor state keyed by tab id. Bridged into local
   * agent turns so Claude Code/Codex app-server know the active repo and files.
   */
  codeWorkspaceByTab: Record<string, CodeWorkspaceContext>;

  /**
   * Whether SQL run by the in-app AI/Claude Code agent is echoed into the
   * linked query tab's editor (appended, never auto-run). Toggled from the chat
   * drawer; persisted to localStorage, default on.
   */
  sqlEcho: boolean;

  addTab: (tab: Tab) => void;
  /**
   * Duplicate an existing tab, inserting the copy immediately to the right of
   * the original (not at the end of the strip) and activating it. See issue
   * #120: a duplicated session should sit next to its source for quick
   * switching/comparison.
   *
   * The copy's title gets a `-<n>` suffix that increments across all open tabs
   * sharing the same base name (so duplicating "Server" yields "Server-1",
   * then "Server-2", and duplicating "Server-1" continues the same family).
   * `overrides.terminalInitialCwd`, when provided, is carried onto the copy so
   * a duplicated local/SSH terminal can open in the source terminal's cwd.
   * `overrides.terminalProfile` carries the source tab's live appearance.
   */
  duplicateTab: (id: string, overrides?: DuplicateTabOverrides) => void;
  removeTab: (id: string) => void;
  removeTabs: (ids: string[]) => void;
  updateTabTitle: (id: string, title: string) => void;
  /** Resolve or refresh an automatic terminal title from a valid cwd report. */
  assignTerminalAutoTitle: (tabId: string, cwd: string) => void;
  updateGitTabInfo: (id: string, git: GitTabInfo, title?: string) => void;
  setActiveTab: (id: string) => void;
  moveTab: (fromId: string, targetId: string, position: "before" | "after") => void;
  moveTabToIndex: (id: string, toIndex: number) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveSideTab: (tab: SideTab) => void;
  /** Re-probe the local X server and update {@link xServerStatus}. */
  refreshXServer: () => Promise<void>;
  /** @deprecated X server availability is detected, not toggled. Kept as a
   *  manual re-probe trigger so the existing ribbon/menu command still works. */
  toggleXServer: () => void;
  setStatusMessage: (message: string) => void;
  toggleMultiExec: () => void;
  toggleMultiExecTab: (tabId: string) => void;
  selectAllTerminalTabs: () => void;
  clearMultiExecSelection: () => void;
  setTerminalSplitActive: (active: boolean) => void;
  toggleTerminalSplit: () => void;
  setTerminalSplitLayout: (layout: TerminalSplitLayout) => void;
  toggleTerminalSplitInputLock: (tabId: string) => void;
  clearTerminalSplitInputLocks: () => void;
  setTabHasNewOutput: (tabId: string, hasNewOutput: boolean) => void;
  setUiFontFamily: (font: string) => void;
  setUiFontSize: (size: number) => void;
  setVaultUnlockMode: (mode: VaultUnlockMode) => void;
  setWelcomeRecentSessionLimit: (limit: number) => void;
  upsertRecentWorkspace: (workspace: RecentWorkspace) => void;
  recordCodeWorkspaceTab: (tabId: string) => void;
  removeRecentWorkspace: (id: string) => void;
  clearRecentWorkspaces: () => void;
  setTabFilter: (filter: TabFilter | null) => void;
  clearTabFilter: () => void;
  /** Record a terminal tab's latest OSC-7 cwd (see {@link cwdByTab}). */
  setTabCwd: (tabId: string, cwd: string) => void;
  /** Merge live terminal connection/activity facts, or clear them with null. */
  setTerminalRuntime: (tabId: string, patch: Partial<TerminalRuntimeInfo> | null) => void;
  /**
   * Record (or clear, with `null`) a DB/Redis tab's live runtime connection id
   * (see {@link dbConnByTab}). Called by the DB client on connect/disconnect.
   */
  setTabDbConn: (tabId: string, connId: string | null) => void;
  /** Record or clear a DB tab's current schema-tree object selection. */
  setTabDbSelectedObjects: (tabId: string, selected: DbSelectedObject[] | null) => void;
  /** Record or clear a code workspace tab's current editor context. */
  setTabCodeWorkspaceContext: (tabId: string, context: CodeWorkspaceContext | null) => void;
  /** Toggle SQL echo to the linked query tab (see {@link sqlEcho}). */
  setSqlEcho: (enabled: boolean) => void;
}

function readUiFontFamily(): string {
  try {
    return window.localStorage.getItem(UI_FONT_FAMILY_KEY) || "Inter";
  } catch {
    return "Inter";
  }
}

function writeUiFontFamily(font: string) {
  try {
    window.localStorage.setItem(UI_FONT_FAMILY_KEY, font);
  } catch {
    // Ignore storage failures
  }
}

function readUiFontSize(): number {
  try {
    const val = window.localStorage.getItem(UI_FONT_SIZE_KEY);
    if (val) {
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed >= MIN_UI_FONT_SIZE && parsed <= MAX_UI_FONT_SIZE) {
        return parsed;
      }
    }
    return 12;
  } catch {
    return 12;
  }
}

function writeUiFontSize(size: number) {
  try {
    window.localStorage.setItem(UI_FONT_SIZE_KEY, size.toString());
  } catch {
    // Ignore storage failures
  }
}

function clampUiFontSize(size: number): number {
  if (!Number.isFinite(size)) return 12;
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(size)));
}

function readTerminalSplitLayout(): TerminalSplitLayout {
  try {
    const value = window.localStorage.getItem(TERMINAL_SPLIT_LAYOUT_KEY);
    if (value === "horizontal" || value === "vertical" || value === "grid") {
      return value;
    }
    return "horizontal";
  } catch {
    return "horizontal";
  }
}

function writeTerminalSplitLayout(layout: TerminalSplitLayout) {
  try {
    window.localStorage.setItem(TERMINAL_SPLIT_LAYOUT_KEY, layout);
  } catch {
    // Ignore storage failures; layout changes still apply for this run.
  }
}

function readSqlEcho(): boolean {
  try {
    // Default on: only an explicit "false" disables it.
    return window.localStorage.getItem(SQL_ECHO_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeSqlEcho(enabled: boolean) {
  try {
    window.localStorage.setItem(SQL_ECHO_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures; the toggle still applies for this run.
  }
}

function readVaultUnlockMode(): VaultUnlockMode {
  try {
    const value = window.localStorage.getItem(VAULT_UNLOCK_MODE_KEY);
    if (value === "on-demand") return "on-demand";
    return "startup";
  } catch {
    return "startup";
  }
}

function writeVaultUnlockMode(mode: VaultUnlockMode) {
  try {
    window.localStorage.setItem(VAULT_UNLOCK_MODE_KEY, mode);
  } catch {
    // Ignore storage failures; the current session still reflects the change.
  }
}

function readSidebarCollapsed(): boolean {
  try {
    const value = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (value === "false") return false;
    if (value === "true") return true;
    return true;
  } catch {
    return true;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // Ignore storage failures; the current session still reflects the change.
  }
}

function clampWelcomeRecentSessionLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WELCOME_RECENT_SESSION_LIMIT;
  return Math.max(
    MIN_WELCOME_RECENT_SESSION_LIMIT,
    Math.min(MAX_WELCOME_RECENT_SESSION_LIMIT, Math.round(value)),
  );
}

function readWelcomeRecentSessionLimit(): number {
  try {
    const value = window.localStorage.getItem(WELCOME_RECENT_SESSION_LIMIT_KEY);
    if (!value) return DEFAULT_WELCOME_RECENT_SESSION_LIMIT;
    return clampWelcomeRecentSessionLimit(parseInt(value, 10));
  } catch {
    return DEFAULT_WELCOME_RECENT_SESSION_LIMIT;
  }
}

function writeWelcomeRecentSessionLimit(limit: number) {
  try {
    window.localStorage.setItem(
      WELCOME_RECENT_SESSION_LIMIT_KEY,
      String(clampWelcomeRecentSessionLimit(limit)),
    );
  } catch {
    // Ignore storage failures; the in-memory setting still applies.
  }
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || trimmed;
}

function workspacePathName(path: string, fallback = "Workspace"): string {
  const normalized = normalizeWorkspacePath(path);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || fallback;
}

function rootIdForPath(path: string): string {
  return `root-${hashString(normalizeWorkspacePath(path))}`;
}

function looseIdForPath(path: string): string {
  return `loose-${hashString(normalizeWorkspacePath(path))}`;
}

function normalizeRecentRoot(root: CodeWorkspaceRootInfo): CodeWorkspaceRootInfo | null {
  const path = normalizeWorkspacePath(root.path ?? "");
  if (!path) return null;
  const kind: CodeWorkspaceRootKind = root.kind === "folder" ? "folder" : "git";
  return {
    id: root.id?.trim() || rootIdForPath(path),
    name: root.name?.trim() || workspacePathName(path),
    path,
    kind,
  };
}

function normalizeRecentLooseFile(file: CodeWorkspaceLooseFileInfo): CodeWorkspaceLooseFileInfo | null {
  const path = normalizeWorkspacePath(file.path ?? "");
  if (!path) return null;
  return {
    id: file.id?.trim() || looseIdForPath(path),
    name: file.name?.trim() || workspacePathName(path, "File"),
    path,
  };
}

function normalizeRecentRoots(roots: readonly CodeWorkspaceRootInfo[] | undefined): CodeWorkspaceRootInfo[] {
  const next: CodeWorkspaceRootInfo[] = [];
  for (const root of roots ?? []) {
    const normalized = normalizeRecentRoot(root);
    if (normalized && !next.some((item) => item.path === normalized.path)) {
      next.push(normalized);
    }
  }
  return next;
}

function normalizeRecentLooseFiles(files: readonly CodeWorkspaceLooseFileInfo[] | undefined): CodeWorkspaceLooseFileInfo[] {
  const next: CodeWorkspaceLooseFileInfo[] = [];
  for (const file of files ?? []) {
    const normalized = normalizeRecentLooseFile(file);
    if (normalized && !next.some((item) => item.path === normalized.path)) {
      next.push(normalized);
    }
  }
  return next;
}

function normalizeRecentFileRef(
  ref: CodeWorkspaceFileRef | null | undefined,
  roots: readonly CodeWorkspaceRootInfo[],
  looseFiles: readonly CodeWorkspaceLooseFileInfo[],
): CodeWorkspaceFileRef | null {
  if (!ref) return null;
  if (ref.kind === "root") {
    const root = roots.find((item) => item.id === ref.rootId);
    if (!root) return null;
    return { kind: "root", rootId: root.id, path: ref.path };
  }
  const loose = looseFiles.find((item) => item.id === ref.id);
  if (!loose) return null;
  return { kind: "loose", id: loose.id, path: loose.path };
}

function fileRefFromContext(file: CodeWorkspaceFileContext | null | undefined): CodeWorkspaceFileRef | null {
  if (!file) return null;
  if (file.kind === "root") {
    return { kind: "root", rootId: file.rootId, path: file.path };
  }
  return { kind: "loose", id: file.id, path: file.path };
}

export function recentWorkspaceIdFromParts(
  roots: readonly CodeWorkspaceRootInfo[],
  looseFiles: readonly CodeWorkspaceLooseFileInfo[] = [],
): string {
  const identity = JSON.stringify({
    roots: roots
      .map((root) => ({ path: normalizeWorkspacePath(root.path), kind: root.kind }))
      .sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`)),
    looseFiles: looseFiles
      .map((file) => normalizeWorkspacePath(file.path))
      .sort((a, b) => a.localeCompare(b)),
  });
  return `workspace-${hashString(identity)}`;
}

export function newWorkspaceInstanceId(): string {
  return `workspace-instance-${crypto.randomUUID()}`;
}

function recentWorkspaceName(
  explicitName: string | undefined,
  roots: readonly CodeWorkspaceRootInfo[],
  looseFiles: readonly CodeWorkspaceLooseFileInfo[],
): string {
  const trimmed = explicitName?.trim();
  if (trimmed) return trimmed;
  if (roots.length === 1 && looseFiles.length === 0) return roots[0].name;
  if (roots.length === 0 && looseFiles.length === 1) return looseFiles[0].name;
  if (roots.length === 0 && looseFiles.length > 0) return "Editor Workspace";
  return "Code Workspace";
}

function recentWorkspaceFromTab(
  tab: Tab | undefined,
  context: CodeWorkspaceContext | undefined,
  now: number,
): RecentWorkspace | null {
  if (!tab?.codeWorkspace) return null;
  const contextRoots = context?.roots?.map((root) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    kind: root.kind,
  }));
  let roots = normalizeRecentRoots(contextRoots ?? tab.codeWorkspace.roots);
  if (roots.length === 0 && tab.codeWorkspace.repoRoot.trim()) {
    const path = normalizeWorkspacePath(tab.codeWorkspace.repoRoot);
    roots = [{
      id: rootIdForPath(path),
      name: workspacePathName(path),
      path,
      kind: "git",
    }];
  }
  const contextLooseFiles = context?.looseFiles?.map((file) => ({
    id: file.id,
    name: file.name,
    path: file.path,
  }));
  const looseFiles = normalizeRecentLooseFiles(contextLooseFiles ?? tab.codeWorkspace.looseFiles);
  if (roots.length === 0 && looseFiles.length === 0) return null;

  const activeFile = normalizeRecentFileRef(
    fileRefFromContext(context?.activeFile) ?? tab.codeWorkspace.initialFile ?? null,
    roots,
    looseFiles,
  );
  return {
    id: recentWorkspaceIdFromParts(roots, looseFiles),
    name: recentWorkspaceName(tab.codeWorkspace.name, roots, looseFiles),
    roots,
    looseFiles,
    lastOpenedAt: now,
    lastActiveFile: activeFile,
    isGitRepo: roots.some((root) => root.kind === "git"),
  };
}

function normalizeRecentWorkspace(workspace: RecentWorkspace): RecentWorkspace | null {
  const roots = normalizeRecentRoots(workspace.roots);
  const looseFiles = normalizeRecentLooseFiles(workspace.looseFiles);
  if (roots.length === 0 && looseFiles.length === 0) return null;
  const activeFile = normalizeRecentFileRef(workspace.lastActiveFile ?? null, roots, looseFiles);
  return {
    id: recentWorkspaceIdFromParts(roots, looseFiles),
    name: recentWorkspaceName(workspace.name, roots, looseFiles),
    roots,
    looseFiles,
    lastOpenedAt: Number.isFinite(workspace.lastOpenedAt) ? workspace.lastOpenedAt : Date.now(),
    lastActiveFile: activeFile,
    isGitRepo: workspace.isGitRepo || roots.some((root) => root.kind === "git"),
  };
}

function upsertRecentWorkspaceList(
  current: readonly RecentWorkspace[],
  workspace: RecentWorkspace | null,
  limit: number,
): RecentWorkspace[] {
  if (!workspace) return current as RecentWorkspace[];
  const normalized = normalizeRecentWorkspace(workspace);
  if (!normalized) return current as RecentWorkspace[];
  return [
    normalized,
    ...current.filter((item) => item.id !== normalized.id),
  ]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, clampWelcomeRecentSessionLimit(limit));
}

function codeWorkspaceInstanceId(tab: Tab | undefined): string | null {
  if (tab?.type !== "code-workspace" || !tab.codeWorkspace) return null;
  return tab.codeWorkspace.workspaceInstanceId ?? tab.id;
}

function hasOtherWorkspaceInstanceWithRecentId(
  idsByInstance: Readonly<Record<string, string>>,
  instanceId: string,
  recentId: string,
): boolean {
  return Object.entries(idsByInstance).some(([otherInstanceId, otherRecentId]) => (
    otherInstanceId !== instanceId && otherRecentId === recentId
  ));
}

function recentRootKey(root: CodeWorkspaceRootInfo): string {
  return `${root.kind}:${normalizeWorkspacePath(root.path)}`;
}

function isSupersededRecentWorkspaceDefinition(
  candidate: RecentWorkspace,
  latest: RecentWorkspace,
): boolean {
  if (candidate.id === latest.id) return false;
  const candidateSize = candidate.roots.length + candidate.looseFiles.length;
  const latestSize = latest.roots.length + latest.looseFiles.length;
  if (candidateSize === 0 || candidateSize >= latestSize) return false;
  if (candidate.name !== latest.name && candidate.roots[0]?.path !== latest.roots[0]?.path) {
    return false;
  }
  const latestRoots = new Set(latest.roots.map(recentRootKey));
  const latestLooseFiles = new Set(latest.looseFiles.map((file) => normalizeWorkspacePath(file.path)));
  return (
    candidate.roots.every((root) => latestRoots.has(recentRootKey(root))) &&
    candidate.looseFiles.every((file) => latestLooseFiles.has(normalizeWorkspacePath(file.path)))
  );
}

function upsertRecentWorkspaceForTab(
  current: readonly RecentWorkspace[],
  idsByInstance: Readonly<Record<string, string>>,
  tab: Tab | undefined,
  context: CodeWorkspaceContext | undefined,
  now: number,
  limit: number,
): {
  recentWorkspaces: RecentWorkspace[];
  recentWorkspaceIdByWorkspaceInstance: Record<string, string>;
} {
  const workspace = recentWorkspaceFromTab(tab, context, now);
  const normalized = workspace ? normalizeRecentWorkspace(workspace) : null;
  if (!normalized) {
    return {
      recentWorkspaces: current as RecentWorkspace[],
      recentWorkspaceIdByWorkspaceInstance: idsByInstance as Record<string, string>,
    };
  }

  const instanceId = codeWorkspaceInstanceId(tab);
  let base = current;
  let nextIdsByInstance = idsByInstance as Record<string, string>;
  if (instanceId) {
    const previousId = idsByInstance[instanceId] ?? tab?.codeWorkspace?.workspaceId ?? null;
    if (
      previousId &&
      previousId !== normalized.id &&
      !hasOtherWorkspaceInstanceWithRecentId(idsByInstance, instanceId, previousId)
    ) {
      base = base.filter((item) => item.id !== previousId);
    }
    if (previousId && previousId !== normalized.id) {
      base = base.filter((item) => (
        hasOtherWorkspaceInstanceWithRecentId(idsByInstance, instanceId, item.id) ||
        !isSupersededRecentWorkspaceDefinition(item, normalized)
      ));
    }
    if (idsByInstance[instanceId] !== normalized.id) {
      nextIdsByInstance = { ...idsByInstance, [instanceId]: normalized.id };
    }
  }

  return {
    recentWorkspaces: upsertRecentWorkspaceList(base, normalized, limit),
    recentWorkspaceIdByWorkspaceInstance: nextIdsByInstance,
  };
}

function shouldRecordRecentWorkspaceContext(
  current: CodeWorkspaceContext | undefined,
  next: CodeWorkspaceContext,
): boolean {
  return (
    !current ||
    !jsonEqual(current.roots, next.roots) ||
    !jsonEqual(current.looseFiles, next.looseFiles)
  );
}

function readRecentWorkspaces(limit: number): RecentWorkspace[] {
  try {
    const raw = window.localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const workspaces = parsed
      .map((item) => normalizeRecentWorkspace(item as RecentWorkspace))
      .filter((item): item is RecentWorkspace => !!item)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, clampWelcomeRecentSessionLimit(limit));
    return workspaces;
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(workspaces: readonly RecentWorkspace[]) {
  try {
    window.localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
    // Ignore storage failures; the in-memory list still works.
  }
}

function pruneSet(ids: Set<string>, validIds: Set<string>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    if (validIds.has(id)) next.add(id);
  }
  return next;
}

function omitRecordKeys<T>(record: Record<string, T>, ids: Set<string>): Record<string, T> {
  if (![...ids].some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

function dbSelectedObjectsEqual(a: DbSelectedObject[] | undefined, b: DbSelectedObject[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      other &&
      item.catalog === other.catalog &&
      item.schema === other.schema &&
      item.name === other.name &&
      item.kind === other.kind
    );
  });
}

function arraysEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function activeTabIsTerminal(tabs: Tab[], activeTabId: string | null): boolean {
  return !!activeTabId && tabs.some((tab) => tab.id === activeTabId && tab.type === "terminal");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const initialWelcomeRecentSessionLimit = readWelcomeRecentSessionLimit();

/**
 * Build the title for a duplicated tab. The base name is the source title with
 * any trailing `-<digits>` stripped, so the whole "family" shares one counter.
 * The returned title is `<base>-<n>` where `n` is one past the highest suffix
 * already used by an open tab in that family.
 *
 * Examples (given the open titles in brackets):
 *   "Server"   ["Server"]                       -> "Server-1"
 *   "Server"   ["Server","Server-1"]            -> "Server-2"
 *   "Server-1" ["Server","Server-1","Server-2"] -> "Server-3"
 */
export function computeDuplicateTitle(sourceTitle: string, openTitles: string[]): string {
  return computeSequencedTitle(sourceTitle, openTitles, true);
}

/**
 * Build the title for a newly opened terminal tab. Unlike duplicates, the
 * first terminal in a family keeps its requested title; subsequent matching
 * titles get the same `-<n>` suffix sequence used by duplicates.
 */
export function computeNewTerminalTitle(requestedTitle: string, openTerminalTitles: string[]): string {
  return computeSequencedTitle(requestedTitle, openTerminalTitles, false);
}

/**
 * Keep a duplicate tab's allocated `-N` suffix while updating the cwd prefix.
 * Used after the first auto-title resolution so later OSC 7 reports and `cd`
 * do not re-run the family-wide duplicate counter.
 */
export function updateDuplicateAutoTitle(currentTitle: string, newPrefix: string): string {
  const suffixMatch = /^(.*?)-(\d+)$/.exec(currentTitle);
  if (!suffixMatch) return newPrefix;
  return `${newPrefix}-${suffixMatch[2]}`;
}

function computeSequencedTitle(sourceTitle: string, openTitles: string[], forceSuffix: boolean): string {
  const suffixMatch = /^(.*?)-(\d+)$/.exec(sourceTitle);
  const base = suffixMatch ? suffixMatch[1] : sourceTitle;
  const familyRe = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let maxSuffix = 0;
  let familyExists = false;
  for (const title of openTitles) {
    if (title === base) {
      familyExists = true;
      continue;
    }
    const m = familyRe.exec(title);
    if (m) {
      familyExists = true;
      const n = parseInt(m[1], 10);
      if (n > maxSuffix) maxSuffix = n;
    }
  }
  if (!forceSuffix && !familyExists) return sourceTitle;
  return `${base}-${maxSuffix + 1}`;
}

function terminalAutoTitleBase(tab: Tab, cwdPrefix: string): string {
  const sessionName = tab.terminalTitleSessionName?.trim();
  return sessionName ? `${sessionName} · ${cwdPrefix}` : cwdPrefix;
}

export const useAppStore = create<AppState>((set) => ({
  tabs: [
    {
      id: "welcome",
      type: "welcome",
      title: "Welcome",
      closable: false,
    },
  ],
  activeTabId: "welcome",
  sidebarCollapsed: readSidebarCollapsed(),
  activeSideTab: "sessions",
  cwdByTab: {},
  terminalRuntimeByTab: {},
  dbConnByTab: {},
  dbSelectedObjectsByTab: {},
  codeWorkspaceByTab: {},
  sqlEcho: readSqlEcho(),
  xServerEnabled: false,
  xServerStatus: null,
  statusMessage: tr("status.ready"),
  multiExecActive: false,
  multiExecSelectedTabIds: new Set(),
  terminalSplitActive: false,
  terminalSplitLayout: readTerminalSplitLayout(),
  terminalSplitInputLockedTabIds: new Set(),
  uiFontFamily: readUiFontFamily(),
  uiFontSize: readUiFontSize(),
  vaultUnlockMode: readVaultUnlockMode(),
  welcomeRecentSessionLimit: initialWelcomeRecentSessionLimit,
  recentWorkspaces: readRecentWorkspaces(initialWelcomeRecentSessionLimit),
  recentWorkspaceIdByWorkspaceInstance: {},
  tabFilter: null,

  addTab: (tab) =>
    set((s) => {
      const nextTabs = [...s.tabs, tab];
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        undefined,
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        tabs: nextTabs,
        activeTabId: tab.id,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        // A freshly opened tab must be visible, so drop any active focus filter.
        tabFilter: null,
        terminalSplitActive: tab.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: tab.title }),
      };
    }),

  duplicateTab: (id, overrides) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const source = s.tabs[idx];
      const isTerminal = source.type === "terminal";
      // Explicit renames permanently opt out of cwd-derived titles. A duplicate
      // of a manual tab must keep that choice and sequence the renamed title
      // (`name` -> `name-1`), not replace it with the cwd basename.
      const sourceIsManual = isTerminal && source.terminalTitleMode === "manual";
      const terminalTitlePrefix =
        isTerminal && !sourceIsManual ? overrides?.terminalTitlePrefix?.trim() : undefined;
      const duplicateTitleBase = terminalTitlePrefix
        ? terminalAutoTitleBase(source, terminalTitlePrefix)
        : undefined;
      const duplicateTitle = duplicateTitleBase
        ? computeDuplicateTitle(
            duplicateTitleBase,
            s.tabs.filter((tab) => tab.type === "terminal").map((tab) => tab.title),
          )
        : computeDuplicateTitle(source.title, s.tabs.map((t) => t.title));
      const copy: Tab = {
        ...source,
        id: `dup-${crypto.randomUUID()}`,
        chatTabId: undefined,
        title: duplicateTitle,
        closable: true,
        hasNewOutput: false,
        // Only terminal copies carry an initial cwd; clear any inherited value
        // for other tab kinds (and when none was resolved). Cwd is still used
        // to open the shell in the same directory even when the title is manual.
        terminalInitialCwd:
          isTerminal ? overrides?.terminalInitialCwd : undefined,
        terminalTitleMode: isTerminal
          ? (sourceIsManual ? "manual" : terminalTitlePrefix ? "auto" : "pending-auto")
          : undefined,
        terminalTitleOperation: isTerminal && !sourceIsManual ? "duplicate" : undefined,
        terminalProfile:
          isTerminal ? overrides?.terminalProfile ?? source.terminalProfile : source.terminalProfile,
        codeWorkspace:
          source.type === "code-workspace" && source.codeWorkspace
            ? {
                ...source.codeWorkspace,
                workspaceInstanceId: newWorkspaceInstanceId(),
              }
            : source.codeWorkspace,
      };
      const next = s.tabs.slice();
      next.splice(idx + 1, 0, copy);
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        copy,
        undefined,
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        tabs: next,
        activeTabId: copy.id,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        // A freshly opened tab must be visible, so drop any active focus filter.
        tabFilter: null,
        terminalSplitActive: copy.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: copy.title }),
      };
    }),

  removeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tab = idx >= 0 ? s.tabs[idx] : undefined;
      const next = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeTabId;
      if (activeId === id) {
        activeId = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      const validIds = new Set(next.map((tab) => tab.id));
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        s.codeWorkspaceByTab[id],
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        tabs: next,
        activeTabId: activeId,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        terminalSplitActive: s.terminalSplitActive && activeTabIsTerminal(next, activeId),
        terminalSplitInputLockedTabIds: pruneSet(s.terminalSplitInputLockedTabIds, validIds),
        multiExecSelectedTabIds: pruneSet(s.multiExecSelectedTabIds, validIds),
        cwdByTab: omitRecordKeys(s.cwdByTab, new Set([id])),
        terminalRuntimeByTab: omitRecordKeys(s.terminalRuntimeByTab, new Set([id])),
        statusMessage: tr("status.closedTab"),
      };
    }),

  removeTabs: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const activeIndex = s.tabs.findIndex((t) => t.id === s.activeTabId);
      const closingTabs = s.tabs.filter((tab) => idSet.has(tab.id));
      const next = s.tabs.filter((t) => !idSet.has(t.id));
      let activeId = s.activeTabId;
      if (!activeId || idSet.has(activeId)) {
        activeId = next[Math.min(activeIndex, next.length - 1)]?.id ?? null;
      }
      const validIds = new Set(next.map((tab) => tab.id));
      let recentWorkspaces = s.recentWorkspaces;
      let recentWorkspaceIdByWorkspaceInstance = s.recentWorkspaceIdByWorkspaceInstance;
      const now = Date.now();
      for (const tab of closingTabs) {
        const recentResult = upsertRecentWorkspaceForTab(
          recentWorkspaces,
          recentWorkspaceIdByWorkspaceInstance,
          tab,
          s.codeWorkspaceByTab[tab.id],
          now,
          s.welcomeRecentSessionLimit,
        );
        recentWorkspaces = recentResult.recentWorkspaces;
        recentWorkspaceIdByWorkspaceInstance = recentResult.recentWorkspaceIdByWorkspaceInstance;
      }
      if (recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentWorkspaces);
      }
      return {
        tabs: next,
        activeTabId: activeId,
        recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance,
        terminalSplitActive: s.terminalSplitActive && activeTabIsTerminal(next, activeId),
        terminalSplitInputLockedTabIds: pruneSet(s.terminalSplitInputLockedTabIds, validIds),
        multiExecSelectedTabIds: pruneSet(s.multiExecSelectedTabIds, validIds),
        cwdByTab: omitRecordKeys(s.cwdByTab, idSet),
        terminalRuntimeByTab: omitRecordKeys(s.terminalRuntimeByTab, idSet),
        statusMessage: tr("status.closedTabs"),
      };
    }),

  updateTabTitle: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              title,
              ...(tab.type === "terminal" ? { terminalTitleMode: "manual" as const } : {}),
            }
          : tab,
      ),
      statusMessage: tr("status.renamedTab", { title }),
    })),

  assignTerminalAutoTitle: (tabId, cwd) =>
    set((s) => {
      const target = s.tabs.find((tab) => tab.id === tabId);
      if (
        !target ||
        target.type !== "terminal" ||
        (target.terminalTitleMode !== "pending-auto" && target.terminalTitleMode !== "auto")
      ) {
        return s;
      }
      const cwdPrefix = terminalCwdTitlePrefix(cwd);
      if (!cwdPrefix) return s;
      const prefix = terminalAutoTitleBase(target, cwdPrefix);
      const openTitles = s.tabs
        .filter((tab) => tab.id !== tabId && tab.type === "terminal")
        .map((tab) => tab.title);
      const title = target.terminalTitleOperation === "duplicate"
        ? target.terminalTitleMode === "pending-auto"
          ? computeDuplicateTitle(prefix, openTitles)
          : updateDuplicateAutoTitle(target.title, prefix)
        : computeNewTerminalTitle(prefix, openTitles);
      if (target.title === title && target.terminalTitleMode === "auto") return s;
      return {
        tabs: s.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, title, terminalTitleMode: "auto" as const } : tab,
        ),
      };
    }),

  updateGitTabInfo: (id, git, title) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === id);
      if (!tab || tab.type !== "git") return s;
      return {
        tabs: s.tabs.map((item) => (
          item.id === id
            ? {
                ...item,
                title: title ?? item.title,
                git,
              }
            : item
        )),
      };
    }),

  setActiveTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === id);
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        s.codeWorkspaceByTab[id],
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        activeTabId: id,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        terminalSplitActive: tab?.type === "terminal" ? s.terminalSplitActive : false,
      };
    }),

  moveTab: (fromId, targetId, position) =>
    set((s) => {
      if (fromId === targetId) return s;
      const from = s.tabs.findIndex((t) => t.id === fromId);
      const target = s.tabs.findIndex((t) => t.id === targetId);
      if (from === -1 || target === -1) return s;

      const next = s.tabs.slice();
      const [moved] = next.splice(from, 1);
      const adjustedTarget = target > from ? target - 1 : target;
      const insertAt = position === "after" ? adjustedTarget + 1 : adjustedTarget;
      next.splice(insertAt, 0, moved);
      if (next.every((t, i) => t === s.tabs[i])) return s;
      return { tabs: next };
    }),

  moveTabToIndex: (id, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from === -1) return s;
      const clamped = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
      if (from === clamped) return s;
      const next = s.tabs.slice();
      const [moved] = next.splice(from, 1);
      next.splice(clamped, 0, moved);
      return { tabs: next };
    }),

  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      writeSidebarCollapsed(sidebarCollapsed);
      return { sidebarCollapsed };
    }),
  setSidebarCollapsed: (collapsed) => {
    writeSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  setActiveSideTab: (tab) => {
    writeSidebarCollapsed(false);
    set({ activeSideTab: tab, sidebarCollapsed: false });
  },

  refreshXServer: async () => {
    const status = await detectXServer();
    set({
      xServerStatus: status,
      xServerEnabled: status.available,
    });
  },

  // The "X server" ribbon/menu command now means "re-detect", since whether a
  // local X server exists is a property of the system, not something the app
  // turns on. We re-probe and report the result in the status line.
  toggleXServer: () => {
    void detectXServer().then((status) => {
      set({
        xServerStatus: status,
        xServerEnabled: status.available,
        statusMessage: status.available
          ? tr("status.xServerEnabled")
          : tr("status.xServerDisabled"),
      });
    });
  },

  setStatusMessage: (message) => set({ statusMessage: message }),

  toggleMultiExec: () =>
    set((s) => {
      const next = !s.multiExecActive;
      return {
        multiExecActive: next,
        multiExecSelectedTabIds: new Set(),
        tabs: next ? s.tabs : s.tabs.map((t) => ({ ...t, hasNewOutput: false })),
        statusMessage: next ? tr("status.multiExecEnabled") : tr("status.multiExecDisabled"),
      };
    }),

  toggleMultiExecTab: (tabId) =>
    set((s) => {
      const next = new Set(s.multiExecSelectedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return { multiExecSelectedTabIds: next };
    }),

  selectAllTerminalTabs: () =>
    set((s) => ({
      multiExecSelectedTabIds: new Set(
        s.tabs.filter((t) => t.type === "terminal").map((t) => t.id),
      ),
    })),

  clearMultiExecSelection: () =>
    set({ multiExecSelectedTabIds: new Set() }),

  setTerminalSplitActive: (active) =>
    set((s) => {
      if (!active) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitDisabled"),
        };
      }
      const terminalTabs = s.tabs.filter((tab) => tab.type === "terminal");
      if (terminalTabs.length === 0) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitNoTerminals"),
        };
      }
      const activeTabId = activeTabIsTerminal(s.tabs, s.activeTabId)
        ? s.activeTabId
        : terminalTabs[0].id;
      return {
        terminalSplitActive: true,
        activeTabId,
        statusMessage: tr("status.splitEnabled"),
      };
    }),

  toggleTerminalSplit: () =>
    set((s) => {
      if (s.terminalSplitActive) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitDisabled"),
        };
      }
      const terminalTabs = s.tabs.filter((tab) => tab.type === "terminal");
      if (terminalTabs.length === 0) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitNoTerminals"),
        };
      }
      const activeTabId = activeTabIsTerminal(s.tabs, s.activeTabId)
        ? s.activeTabId
        : terminalTabs[0].id;
      return {
        terminalSplitActive: true,
        activeTabId,
        statusMessage: tr("status.splitEnabled"),
      };
    }),

  setTerminalSplitLayout: (layout) => {
    writeTerminalSplitLayout(layout);
    set({
      terminalSplitLayout: layout,
      statusMessage: tr("status.splitLayout", { layout }),
    });
  },

  toggleTerminalSplitInputLock: (tabId) =>
    set((s) => {
      if (!s.tabs.some((tab) => tab.id === tabId && tab.type === "terminal")) {
        return s;
      }
      const next = new Set(s.terminalSplitInputLockedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return {
        terminalSplitInputLockedTabIds: next,
        statusMessage: next.has(tabId) ? tr("status.paneInputLocked") : tr("status.paneInputUnlocked"),
      };
    }),

  clearTerminalSplitInputLocks: () =>
    set({
      terminalSplitInputLockedTabIds: new Set(),
      statusMessage: tr("status.splitLocksCleared"),
    }),

  setTabHasNewOutput: (tabId, hasNewOutput) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.hasNewOutput === hasNewOutput) return s;
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hasNewOutput } : t)) };
    }),

  setUiFontFamily: (font) =>
    set(() => {
      writeUiFontFamily(font);
      return { uiFontFamily: font };
    }),

  setUiFontSize: (size) =>
    set(() => {
      const next = clampUiFontSize(size);
      writeUiFontSize(next);
      return { uiFontSize: next };
    }),

  setVaultUnlockMode: (mode) =>
    set(() => {
      writeVaultUnlockMode(mode);
      return { vaultUnlockMode: mode };
    }),

  setWelcomeRecentSessionLimit: (limit) =>
    set((s) => {
      const next = clampWelcomeRecentSessionLimit(limit);
      writeWelcomeRecentSessionLimit(next);
      const recentWorkspaces = s.recentWorkspaces.slice(0, next);
      writeRecentWorkspaces(recentWorkspaces);
      return { welcomeRecentSessionLimit: next, recentWorkspaces };
    }),

  upsertRecentWorkspace: (workspace) =>
    set((s) => {
      const recentWorkspaces = upsertRecentWorkspaceList(
        s.recentWorkspaces,
        { ...workspace, lastOpenedAt: workspace.lastOpenedAt || Date.now() },
        s.welcomeRecentSessionLimit,
      );
      writeRecentWorkspaces(recentWorkspaces);
      return { recentWorkspaces };
    }),

  recordCodeWorkspaceTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === tabId);
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        s.codeWorkspaceByTab[tabId],
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return (
        recentResult.recentWorkspaces === s.recentWorkspaces &&
        recentResult.recentWorkspaceIdByWorkspaceInstance === s.recentWorkspaceIdByWorkspaceInstance
      )
        ? s
        : {
            recentWorkspaces: recentResult.recentWorkspaces,
            recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
          };
    }),

  removeRecentWorkspace: (id) =>
    set((s) => {
      const recentWorkspaces = s.recentWorkspaces.filter((workspace) => workspace.id !== id);
      if (recentWorkspaces.length === s.recentWorkspaces.length) return s;
      writeRecentWorkspaces(recentWorkspaces);
      return { recentWorkspaces };
    }),

  clearRecentWorkspaces: () =>
    set((s) => {
      if (s.recentWorkspaces.length === 0) return s;
      writeRecentWorkspaces([]);
      return { recentWorkspaces: [] };
    }),

  setTabFilter: (filter) => set({ tabFilter: filter }),
  clearTabFilter: () => set({ tabFilter: null }),
  setTabCwd: (tabId, cwd) =>
    set((s) => (s.cwdByTab[tabId] === cwd ? s : { cwdByTab: { ...s.cwdByTab, [tabId]: cwd } })),

  setTerminalRuntime: (tabId, patch) =>
    set((s) => {
      if (patch === null) {
        if (!(tabId in s.terminalRuntimeByTab)) return s;
        return { terminalRuntimeByTab: omitRecordKeys(s.terminalRuntimeByTab, new Set([tabId])) };
      }
      const current = s.terminalRuntimeByTab[tabId];
      const merged = {
        ...current,
        ...patch,
        state: patch.state ?? current?.state ?? "unknown",
      };
      if (
        current &&
        current.backendSessionId === merged.backendSessionId &&
        current.state === merged.state &&
        current.program === merged.program &&
        current.activitySource === merged.activitySource
      ) {
        return s;
      }
      const next: TerminalRuntimeInfo = { ...merged, updatedAt: patch.updatedAt ?? Date.now() };
      return { terminalRuntimeByTab: { ...s.terminalRuntimeByTab, [tabId]: next } };
    }),

  setTabDbConn: (tabId, connId) =>
    set((s) => {
      if (connId === null) {
        if (!(tabId in s.dbConnByTab)) return s;
        const next = { ...s.dbConnByTab };
        delete next[tabId];
        return { dbConnByTab: next };
      }
      return s.dbConnByTab[tabId] === connId
        ? s
        : { dbConnByTab: { ...s.dbConnByTab, [tabId]: connId } };
    }),

  setTabDbSelectedObjects: (tabId, selected) =>
    set((s) => {
      if (selected === null || selected.length === 0) {
        if (!(tabId in s.dbSelectedObjectsByTab)) return s;
        const next = { ...s.dbSelectedObjectsByTab };
        delete next[tabId];
        return { dbSelectedObjectsByTab: next };
      }
      if (dbSelectedObjectsEqual(s.dbSelectedObjectsByTab[tabId], selected)) {
        return s;
      }
      return {
        dbSelectedObjectsByTab: {
          ...s.dbSelectedObjectsByTab,
          [tabId]: selected,
        },
      };
    }),

  setTabCodeWorkspaceContext: (tabId, context) =>
    set((s) => {
      if (context === null) {
        if (!(tabId in s.codeWorkspaceByTab)) return s;
        const next = { ...s.codeWorkspaceByTab };
        delete next[tabId];
        return { codeWorkspaceByTab: next };
      }
      const current = s.codeWorkspaceByTab[tabId];
      if (
        current &&
        current.repoRoot === context.repoRoot &&
        current.activePath === context.activePath &&
        arraysEqual(current.openPaths, context.openPaths) &&
        arraysEqual(current.dirtyPaths, context.dirtyPaths) &&
        jsonEqual(current.roots, context.roots) &&
        jsonEqual(current.looseFiles, context.looseFiles) &&
        jsonEqual(current.activeFile, context.activeFile) &&
        jsonEqual(current.openFiles, context.openFiles) &&
        jsonEqual(current.dirtyFiles, context.dirtyFiles) &&
        jsonEqual(current.lsp, context.lsp)
      ) {
        return s;
      }
      const tab = s.tabs.find((item) => item.id === tabId);
      const shouldRecordRecent = shouldRecordRecentWorkspaceContext(current, context);
      const recentResult = shouldRecordRecent
        ? upsertRecentWorkspaceForTab(
            s.recentWorkspaces,
            s.recentWorkspaceIdByWorkspaceInstance,
            tab,
            context,
            Date.now(),
            s.welcomeRecentSessionLimit,
          )
        : {
            recentWorkspaces: s.recentWorkspaces,
            recentWorkspaceIdByWorkspaceInstance: s.recentWorkspaceIdByWorkspaceInstance,
          };
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        codeWorkspaceByTab: {
          ...s.codeWorkspaceByTab,
          [tabId]: context,
        },
      };
    }),

  setSqlEcho: (enabled) =>
    set((s) => {
      if (s.sqlEcho === enabled) return s;
      writeSqlEcho(enabled);
      return { sqlEcho: enabled };
    }),
}));

export function syncUiAppearanceFromStorage(event: Pick<StorageEvent, "key" | "newValue">): void {
  if (event.key === null || event.key === UI_FONT_FAMILY_KEY) {
    const uiFontFamily = event.key === UI_FONT_FAMILY_KEY && event.newValue
      ? event.newValue
      : readUiFontFamily();
    useAppStore.setState({ uiFontFamily });
  }

  if (event.key === null || event.key === UI_FONT_SIZE_KEY) {
    const parsed = event.key === UI_FONT_SIZE_KEY && event.newValue !== null
      ? Number.parseInt(event.newValue, 10)
      : readUiFontSize();
    const uiFontSize = Number.isFinite(parsed)
      ? clampUiFontSize(parsed)
      : readUiFontSize();
    useAppStore.setState({ uiFontSize });
  }
}

export function subscribeUiAppearanceStorage(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => syncUiAppearanceFromStorage(event);
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
