import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo } from "../../../types";
import type {
  BottomDockTabId,
  CodeWorkspaceEditorGroupState,
  EditorGroupId,
  EditorSplitOrientation,
  RightPaneTabId,
} from "../../../stores/codeWorkspaceStore";
import { fileKey } from "./codeWorkspaceModel";
import {
  type LayoutNode,
  validateLayoutTree,
  migrateLayoutV1toV2,
  getAllLeafNodes,
} from "./recursiveLayoutTree";

export const WORKSPACE_LAYOUT_STORAGE_PREFIX_V2 = "taomni.codeWorkspace.layout.v2.";
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

export interface WorkspaceLayoutSnapshotV1 {
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

export interface WorkspaceLayoutSnapshotV2 {
  version: 2;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  languagePanelOpen: boolean;
  splitOrientation: EditorSplitOrientation | null;
  activeEditorGroupId: string;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  layoutTreeV2: LayoutNode;
  editorGroups: Record<string, PersistedEditorGroup>;
}

export type WorkspaceLayoutSnapshot = WorkspaceLayoutSnapshotV2;

const BOTTOM_DOCK_TABS: BottomDockTabId[] = [
  "problems",
  "analysis",
  "search",
  "references",
  "call-hierarchy",
  "type-hierarchy",
  "todos",
  "terminal",
  "run",
  "build",
  "tests",
  "coverage",
  "debug",
];
const RIGHT_PANE_TABS: RightPaneTabId[] = ["outline", "documentation"];

function storageKeyV2(workspaceInstanceId: string): string {
  return `${WORKSPACE_LAYOUT_STORAGE_PREFIX_V2}${workspaceInstanceId}`;
}

function storageKeyV1(workspaceInstanceId: string): string {
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
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const openOrder = asStringArray(source.openOrder, MAX_RESTORED_OPEN_FILES);
  const pinnedKeys = asStringArray(source.pinnedKeys, MAX_RESTORED_OPEN_FILES).filter((key) =>
    openOrder.includes(key),
  );
  const activeKey =
    typeof source.activeKey === "string" && openOrder.includes(source.activeKey)
      ? source.activeKey
      : openOrder[0] ?? null;
  const previewKey =
    typeof source.previewKey === "string" && openOrder.includes(source.previewKey)
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

export function defaultWorkspaceLayoutSnapshot(): WorkspaceLayoutSnapshotV2 {
  return {
    version: 2,
    bottomDockOpen: true,
    bottomDockTab: "references",
    rightPaneOpen: false,
    rightPaneTab: "outline",
    languagePanelOpen: true,
    splitOrientation: null,
    activeEditorGroupId: "primary",
    expandedRootIds: [],
    expandedDirKeys: [],
    layoutTreeV2: {
      type: "leaf",
      id: "primary",
      openFileKeys: [],
      activeKey: null,
    },
    editorGroups: {
      primary: createEmptyPersistedGroup(),
      secondary: createEmptyPersistedGroup(),
    },
  };
}

export function normalizeWorkspaceLayoutSnapshot(value: unknown): WorkspaceLayoutSnapshotV2 {
  const fallback = defaultWorkspaceLayoutSnapshot();
  if (!value || typeof value !== "object") return fallback;
  const source = value as Record<string, unknown>;
  const bottomDockTab = BOTTOM_DOCK_TABS.includes(source.bottomDockTab as BottomDockTabId)
    ? (source.bottomDockTab as BottomDockTabId)
    : fallback.bottomDockTab;
  const rightPaneTab = RIGHT_PANE_TABS.includes(source.rightPaneTab as RightPaneTabId)
    ? (source.rightPaneTab as RightPaneTabId)
    : fallback.rightPaneTab;
  const splitOrientation =
    source.splitOrientation === "horizontal" || source.splitOrientation === "vertical"
      ? source.splitOrientation
      : null;

  const groupsSource =
    source.editorGroups && typeof source.editorGroups === "object"
      ? (source.editorGroups as Record<string, unknown>)
      : {};

  const normalizedGroups: Record<string, PersistedEditorGroup> = {};
  for (const [k, v] of Object.entries(groupsSource)) {
    if (v && typeof v === "object") {
      normalizedGroups[k] = normalizeGroup(v);
    }
  }

  if (!normalizedGroups.primary) {
    normalizedGroups.primary = createEmptyPersistedGroup();
  }
  if (!normalizedGroups.secondary) {
    normalizedGroups.secondary = createEmptyPersistedGroup();
  }

  // Resolve layout tree v2
  let layoutTreeV2: LayoutNode;
  if (source.layoutTreeV2 && typeof source.layoutTreeV2 === "object") {
    const { valid } = validateLayoutTree(source.layoutTreeV2);
    if (valid) {
      layoutTreeV2 = source.layoutTreeV2 as LayoutNode;
    } else {
      layoutTreeV2 = migrateLayoutV1toV2(source.layoutTreeV2);
    }
  } else {
    // Migrate v1 schema
    layoutTreeV2 = migrateLayoutV1toV2({
      orientation: splitOrientation ?? "horizontal",
      groups: Object.entries(normalizedGroups).map(([id, g]) => ({
        id,
        openFileKeys: g.openOrder,
        activeKey: g.activeKey,
      })),
    });
  }

  // Ensure all leaves in layout tree have entries in normalizedGroups
  const leaves = getAllLeafNodes(layoutTreeV2);
  for (const leaf of leaves) {
    if (!normalizedGroups[leaf.id]) {
      normalizedGroups[leaf.id] = {
        openOrder: leaf.openFileKeys,
        activeKey: leaf.activeKey,
        previewKey: null,
        pinnedKeys: [],
      };
    }
  }

  let activeEditorGroupId = typeof source.activeEditorGroupId === "string" ? source.activeEditorGroupId : "primary";
  if (!normalizedGroups[activeEditorGroupId]) {
    activeEditorGroupId = leaves[0]?.id ?? "primary";
  }

  return {
    version: 2,
    bottomDockOpen: source.bottomDockOpen !== false,
    bottomDockTab,
    rightPaneOpen: source.rightPaneOpen === true,
    rightPaneTab,
    languagePanelOpen: source.languagePanelOpen !== false,
    splitOrientation,
    activeEditorGroupId,
    expandedRootIds: asStringArray(source.expandedRootIds, 64),
    expandedDirKeys: asStringArray(source.expandedDirKeys, 256),
    layoutTreeV2,
    editorGroups: normalizedGroups,
  };
}

export function readWorkspaceLayoutSnapshot(workspaceInstanceId: string): WorkspaceLayoutSnapshotV2 | null {
  if (!workspaceInstanceId || typeof window === "undefined") return null;
  try {
    const rawV2 = window.localStorage.getItem(storageKeyV2(workspaceInstanceId));
    if (rawV2) {
      return normalizeWorkspaceLayoutSnapshot(JSON.parse(rawV2));
    }
    const rawV1 = window.localStorage.getItem(storageKeyV1(workspaceInstanceId));
    if (rawV1) {
      return normalizeWorkspaceLayoutSnapshot(JSON.parse(rawV1));
    }
    return null;
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
    const normalized = normalizeWorkspaceLayoutSnapshot(snapshot);
    window.localStorage.setItem(storageKeyV2(workspaceInstanceId), JSON.stringify(normalized));
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

export function uniqueOrderedKeys(groups: Record<string, PersistedEditorGroup>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const group of Object.values(groups)) {
    for (const key of group?.openOrder ?? []) {
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
  activeEditorGroupId: string;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  editorGroups: Record<string, CodeWorkspaceEditorGroupState>;
  layoutTreeV2?: LayoutNode | null;
}): WorkspaceLayoutSnapshotV2 {
  const toPersisted = (group: CodeWorkspaceEditorGroupState): PersistedEditorGroup => ({
    openOrder: group.openOrder.slice(0, MAX_RESTORED_OPEN_FILES),
    activeKey:
      group.activeKey && group.openOrder.includes(group.activeKey)
        ? group.activeKey
        : group.openOrder[0] ?? null,
    previewKey:
      group.previewKey && group.openOrder.includes(group.previewKey) ? group.previewKey : null,
    pinnedKeys: group.pinnedKeys
      .filter((key) => group.openOrder.includes(key))
      .slice(0, MAX_RESTORED_OPEN_FILES),
  });

  const persistedGroups: Record<string, PersistedEditorGroup> = {};
  for (const [k, v] of Object.entries(input.editorGroups)) {
    if (v) {
      persistedGroups[k] = toPersisted(v);
    }
  }

  const layoutTree: LayoutNode = input.layoutTreeV2 ?? {
    type: "leaf",
    id: input.activeEditorGroupId || "primary",
    openFileKeys: input.editorGroups[input.activeEditorGroupId]?.openOrder ?? [],
    activeKey: input.editorGroups[input.activeEditorGroupId]?.activeKey ?? null,
  };

  return normalizeWorkspaceLayoutSnapshot({
    version: 2,
    bottomDockOpen: input.bottomDockOpen,
    bottomDockTab: input.bottomDockTab,
    rightPaneOpen: input.rightPaneOpen,
    rightPaneTab: input.rightPaneTab,
    languagePanelOpen: input.languagePanelOpen,
    splitOrientation: input.splitOrientation,
    activeEditorGroupId: input.activeEditorGroupId,
    expandedRootIds: input.expandedRootIds,
    expandedDirKeys: input.expandedDirKeys,
    layoutTreeV2: layoutTree,
    editorGroups: persistedGroups,
  });
}

export function layoutSnapshotHasOpenFiles(snapshot: WorkspaceLayoutSnapshotV2): boolean {
  return Object.values(snapshot.editorGroups).some((g) => (g?.openOrder.length ?? 0) > 0);
}

/** Re-export for callers that already import layout helpers. */
export { fileKey };
