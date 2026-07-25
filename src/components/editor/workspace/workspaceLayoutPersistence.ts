import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo } from "../../../types";
import type {
  BottomDockTabId,
  CodeWorkspaceEditorGroupState,
  EditorGroupId,
  EditorSplitOrientation,
  RightPaneTabId,
} from "../../../stores/codeWorkspaceStore";
import { fileKey } from "./codeWorkspaceModel";

export const WORKSPACE_LAYOUT_STORAGE_PREFIX = "taomni.codeWorkspace.layout.v1.";
export const WORKSPACE_SEARCH_HISTORY_PREFIX = "taomni.codeWorkspace.searchHistory.v1.";
export const MAX_SEARCH_HISTORY = 20;
export const MAX_RESTORED_OPEN_FILES = 24;

export interface PersistedEditorGroup {
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
}

export interface WorkspaceLayoutSnapshot {
  version: 1;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  languagePanelOpen: boolean;
  splitOrientation: EditorSplitOrientation | null;
  activeEditorGroupId: EditorGroupId;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  editorGroups: Record<EditorGroupId, PersistedEditorGroup>;
}

const BOTTOM_DOCK_TABS: BottomDockTabId[] = [
  "problems",
  "search",
  "references",
  "call-hierarchy",
  "type-hierarchy",
  "todos",
  "terminal",
  "run",
  "build",
];
const RIGHT_PANE_TABS: RightPaneTabId[] = ["outline", "documentation"];
const GROUP_IDS: EditorGroupId[] = ["primary", "secondary"];

function storageKey(workspaceInstanceId: string): string {
  return `${WORKSPACE_LAYOUT_STORAGE_PREFIX}${workspaceInstanceId}`;
}

function searchHistoryKey(workspaceInstanceId: string): string {
  return `${WORKSPACE_SEARCH_HISTORY_PREFIX}${workspaceInstanceId}`;
}

function asStringArray(value: unknown, limit = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, limit);
}

function normalizeGroup(value: unknown): PersistedEditorGroup {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const openOrder = asStringArray(source.openOrder, MAX_RESTORED_OPEN_FILES);
  const pinnedKeys = asStringArray(source.pinnedKeys, MAX_RESTORED_OPEN_FILES).filter((key) => openOrder.includes(key));
  const activeKey = typeof source.activeKey === "string" && openOrder.includes(source.activeKey)
    ? source.activeKey
    : openOrder[0] ?? null;
  const previewKey = typeof source.previewKey === "string" && openOrder.includes(source.previewKey)
    ? source.previewKey
    : null;
  return {
    openOrder,
    activeKey,
    previewKey,
    pinnedKeys,
  };
}

export function createEmptyPersistedGroup(): PersistedEditorGroup {
  return {
    openOrder: [],
    activeKey: null,
    previewKey: null,
    pinnedKeys: [],
  };
}

export function defaultWorkspaceLayoutSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    bottomDockOpen: true,
    bottomDockTab: "references",
    rightPaneOpen: false,
    rightPaneTab: "outline",
    languagePanelOpen: true,
    splitOrientation: null,
    activeEditorGroupId: "primary",
    expandedRootIds: [],
    expandedDirKeys: [],
    editorGroups: {
      primary: createEmptyPersistedGroup(),
      secondary: createEmptyPersistedGroup(),
    },
  };
}

export function normalizeWorkspaceLayoutSnapshot(value: unknown): WorkspaceLayoutSnapshot {
  const fallback = defaultWorkspaceLayoutSnapshot();
  if (!value || typeof value !== "object") return fallback;
  const source = value as Record<string, unknown>;
  const bottomDockTab = BOTTOM_DOCK_TABS.includes(source.bottomDockTab as BottomDockTabId)
    ? source.bottomDockTab as BottomDockTabId
    : fallback.bottomDockTab;
  const rightPaneTab = RIGHT_PANE_TABS.includes(source.rightPaneTab as RightPaneTabId)
    ? source.rightPaneTab as RightPaneTabId
    : fallback.rightPaneTab;
  const splitOrientation = source.splitOrientation === "horizontal" || source.splitOrientation === "vertical"
    ? source.splitOrientation
    : null;
  const activeEditorGroupId = source.activeEditorGroupId === "secondary" ? "secondary" : "primary";
  const groupsSource = source.editorGroups && typeof source.editorGroups === "object"
    ? source.editorGroups as Record<string, unknown>
    : {};
  return {
    version: 1,
    bottomDockOpen: source.bottomDockOpen !== false,
    bottomDockTab,
    rightPaneOpen: source.rightPaneOpen === true,
    rightPaneTab,
    languagePanelOpen: source.languagePanelOpen !== false,
    splitOrientation,
    activeEditorGroupId,
    expandedRootIds: asStringArray(source.expandedRootIds, 64),
    expandedDirKeys: asStringArray(source.expandedDirKeys, 256),
    editorGroups: {
      primary: normalizeGroup(groupsSource.primary),
      secondary: normalizeGroup(groupsSource.secondary),
    },
  };
}

export function readWorkspaceLayoutSnapshot(workspaceInstanceId: string): WorkspaceLayoutSnapshot | null {
  if (!workspaceInstanceId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceInstanceId));
    if (!raw) return null;
    return normalizeWorkspaceLayoutSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeWorkspaceLayoutSnapshot(
  workspaceInstanceId: string,
  snapshot: WorkspaceLayoutSnapshot,
): void {
  if (!workspaceInstanceId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(workspaceInstanceId),
      JSON.stringify(normalizeWorkspaceLayoutSnapshot(snapshot)),
    );
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
}

export function readWorkspaceSearchHistory(workspaceInstanceId: string): string[] {
  if (!workspaceInstanceId || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(searchHistoryKey(workspaceInstanceId)) ?? "[]");
    return asStringArray(parsed, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

export function writeWorkspaceSearchHistory(workspaceInstanceId: string, history: string[]): void {
  if (!workspaceInstanceId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      searchHistoryKey(workspaceInstanceId),
      JSON.stringify(asStringArray(history, MAX_SEARCH_HISTORY)),
    );
  } catch {
    // ignore storage failures
  }
}

export function pushWorkspaceSearchHistory(
  workspaceInstanceId: string,
  query: string,
  history: string[] = readWorkspaceSearchHistory(workspaceInstanceId),
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return history;
  const next = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, MAX_SEARCH_HISTORY);
  writeWorkspaceSearchHistory(workspaceInstanceId, next);
  return next;
}

export function fileRefFromFileKey(
  key: string,
  looseFiles: readonly CodeWorkspaceLooseFileInfo[] = [],
): CodeWorkspaceFileRef | null {
  if (key.startsWith("root:")) {
    const rest = key.slice("root:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const rootId = rest.slice(0, separator);
    const path = rest.slice(separator + 1);
    if (!rootId || !path) return null;
    return { kind: "root", rootId, path };
  }
  if (key.startsWith("loose:")) {
    const id = key.slice("loose:".length);
    if (!id) return null;
    const loose = looseFiles.find((file) => file.id === id);
    if (!loose) return null;
    return { kind: "loose", id, path: loose.path };
  }
  return null;
}

export function uniqueOrderedKeys(groups: Record<EditorGroupId, PersistedEditorGroup>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const groupId of GROUP_IDS) {
    for (const key of groups[groupId]?.openOrder ?? []) {
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(key);
      if (ordered.length >= MAX_RESTORED_OPEN_FILES) return ordered;
    }
  }
  return ordered;
}

export function snapshotFromWorkspaceUi(input: {
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  languagePanelOpen: boolean;
  splitOrientation: EditorSplitOrientation | null;
  activeEditorGroupId: EditorGroupId;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  editorGroups: Record<EditorGroupId, CodeWorkspaceEditorGroupState>;
}): WorkspaceLayoutSnapshot {
  const toPersisted = (group: CodeWorkspaceEditorGroupState): PersistedEditorGroup => ({
    openOrder: group.openOrder.slice(0, MAX_RESTORED_OPEN_FILES),
    activeKey: group.activeKey && group.openOrder.includes(group.activeKey) ? group.activeKey : group.openOrder[0] ?? null,
    previewKey: group.previewKey && group.openOrder.includes(group.previewKey) ? group.previewKey : null,
    pinnedKeys: group.pinnedKeys.filter((key) => group.openOrder.includes(key)).slice(0, MAX_RESTORED_OPEN_FILES),
  });
  return normalizeWorkspaceLayoutSnapshot({
    version: 1,
    bottomDockOpen: input.bottomDockOpen,
    bottomDockTab: input.bottomDockTab,
    rightPaneOpen: input.rightPaneOpen,
    rightPaneTab: input.rightPaneTab,
    languagePanelOpen: input.languagePanelOpen,
    splitOrientation: input.splitOrientation,
    activeEditorGroupId: input.activeEditorGroupId,
    expandedRootIds: input.expandedRootIds,
    expandedDirKeys: input.expandedDirKeys,
    editorGroups: {
      primary: toPersisted(input.editorGroups.primary),
      secondary: toPersisted(input.editorGroups.secondary),
    },
  });
}

export function layoutSnapshotHasOpenFiles(snapshot: WorkspaceLayoutSnapshot): boolean {
  return GROUP_IDS.some((id) => (snapshot.editorGroups[id]?.openOrder.length ?? 0) > 0);
}

/** Re-export for callers that already import layout helpers. */
export { fileKey };
