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
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  migrateWorkspaceTabPolicy,
  type WorkspaceTabPolicyV3,
} from "./workspaceTabPolicy";
import {
  type LayoutNode,
  createSingleLeafLayout,
  validateLayoutTree,
  validateTreeGroupConsistency,
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
  /**
   * §8.19.6 per-workspace tab policy (schema v3). Optional on raw input;
   * normalization always materializes it: corrupt/v2 payloads migrate
   * field-by-field to defaults.
   */
  tabPolicy?: WorkspaceTabPolicyV3;
  /**
   * Raw pre-repair `tabPolicy` payload, archived whenever this normalization
   * repaired anything so the original stays inspectable until the next clean
   * write overwrites the snapshot.
   */
  tabPolicyBackup?: unknown;
  layoutRecovered?: boolean;
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

function cloneLayoutTree(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") {
    return { ...node, openFileKeys: [...node.openFileKeys] };
  }
  return {
    ...node,
    ratios: [...(node.ratios ?? [])],
    children: node.children.map(cloneLayoutTree),
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
    layoutTreeV2: createSingleLeafLayout("primary", [], null),
    tabPolicy: { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 },
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

  const rawGroups: Record<string, PersistedEditorGroup> = {};
  for (const [k, v] of Object.entries(groupsSource)) {
    if (v && typeof v === "object") {
      rawGroups[k] = normalizeGroup(v);
    }
  }

  // Resolve layout tree v2
  let layoutTreeV2: LayoutNode;
  let layoutRecovered = false;

  if (source.layoutTreeV2 && typeof source.layoutTreeV2 === "object") {
    const { valid } = validateLayoutTree(source.layoutTreeV2 as LayoutNode);
    if (valid) {
      // Clone before any normalization writes: the caller may pass the live
      // zustand tree object, and in-place leaf mutation would break
      // structural sharing outside `set` (§8.16.4 step 4).
      layoutTreeV2 = cloneLayoutTree(source.layoutTreeV2 as LayoutNode);
    } else {
      layoutTreeV2 = migrateLayoutV1toV2(source.layoutTreeV2);
      layoutRecovered = true;
    }
  } else {
    // Only synthesize primary/secondary when v2 tree is absent
    const groupsForMigration = Object.keys(rawGroups).length > 0 ? rawGroups : {
      primary: createEmptyPersistedGroup(),
      secondary: createEmptyPersistedGroup(),
    };
    layoutTreeV2 = migrateLayoutV1toV2({
      orientation: splitOrientation ?? "horizontal",
      groups: Object.entries(groupsForMigration).map(([id, g]) => ({
        id,
        openFileKeys: g.openOrder,
        activeKey: g.activeKey,
      })),
    });
  }

  // Ensure bidirectional consistency:
  // 1. Drop groups that do not have a corresponding leaf in the tree (orphan groups)
  // 2. Align openOrder/activeKey with tree leaf as truth
  const leaves = getAllLeafNodes(layoutTreeV2);
  const normalizedGroups: Record<string, PersistedEditorGroup> = {};

  for (const leaf of leaves) {
    const existing = rawGroups[leaf.id];
    const baseOpen = leaf.openFileKeys.length > 0 ? leaf.openFileKeys : existing?.openOrder ?? [];
    const openOrder = asStringArray(baseOpen, MAX_RESTORED_OPEN_FILES);
    const pinnedKeys = existing ? existing.pinnedKeys.filter((k) => openOrder.includes(k)) : [];
    const previewKey = existing && existing.previewKey && openOrder.includes(existing.previewKey)
      ? existing.previewKey
      : null;
    const activeKey = (existing?.activeKey && openOrder.includes(existing.activeKey))
      ? existing.activeKey
      : (leaf.activeKey && openOrder.includes(leaf.activeKey))
      ? leaf.activeKey
      : (openOrder[0] ?? null);

    // Sync back to leaf
    leaf.openFileKeys = [...openOrder];
    leaf.activeKey = activeKey;

    normalizedGroups[leaf.id] = {
      openOrder,
      activeKey,
      previewKey,
      pinnedKeys,
    };
  }

  let activeEditorGroupId = typeof source.activeEditorGroupId === "string" ? source.activeEditorGroupId : "primary";
  if (!normalizedGroups[activeEditorGroupId]) {
    activeEditorGroupId = leaves[0]?.id ?? "primary";
  }

  // §8.19.6: per-workspace tab policy migrates field-by-field; any repair
  // archives the raw payload as `tabPolicyBackup`. An archived backup from an
  // earlier generation carries forward through re-normalization until the
  // next clean live write (which sends no backup field) drops it.
  const policyMigration = migrateWorkspaceTabPolicy(source.tabPolicy);
  const policyBackup = policyMigration.backup ?? source.tabPolicyBackup ?? null;

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
    tabPolicy: policyMigration.policy,
    ...(policyBackup != null ? { tabPolicyBackup: policyBackup } : {}),
    editorGroups: normalizedGroups,
    layoutRecovered,
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
  options?: { onIssue?: (message: string) => void },
): void {
  if (!workspaceInstanceId || typeof window === "undefined") return;
  try {
    const normalized = normalizeWorkspaceLayoutSnapshot(snapshot);
    const treeValid = validateLayoutTree(normalized.layoutTreeV2);
    if (!treeValid.valid) {
      // §8.17.4 step 3: refusal is a user-visible recovery diagnostic, not a
      // silent console line — the previous valid snapshot keeps restoring.
      console.error("[LayoutPersistence] Refusing to persist invalid layout tree:", treeValid.errors);
      options?.onIssue?.(
        "Current editor layout could not be saved (invalid split structure); the last valid layout will be restored next launch",
      );
      return;
    }
    const consistency = validateTreeGroupConsistency(normalized.layoutTreeV2, normalized.editorGroups as any);
    if (!consistency.consistent) {
      console.error("[LayoutPersistence] Refusing to persist inconsistent tree/groups:", consistency.errors);
      options?.onIssue?.(
        "Editor tabs and split layout disagreed; the last consistent layout was kept for next launch",
      );
      return;
    }
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
    layoutTreeV2: LayoutNode;
  /** §8.19.6 per-workspace tab policy (v3); normalized on write. */
  tabPolicy?: WorkspaceTabPolicyV3;

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

  const layoutTree = input.layoutTreeV2;

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
    tabPolicy: input.tabPolicy ?? { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 },
    editorGroups: persistedGroups,
  });
}

export function layoutSnapshotHasOpenFiles(snapshot: WorkspaceLayoutSnapshotV2): boolean {
  return Object.values(snapshot.editorGroups).some((g) => (g?.openOrder.length ?? 0) > 0);
}

/** Re-export for callers that already import layout helpers. */
export { fileKey };
