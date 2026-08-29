import { create } from "zustand";
import type { SearchEverywhereMode } from "../components/editor/workspace/SearchEverywhere";
import type { QuickDocContent } from "../components/editor/workspace/referenceDocumentation";
import type { LocationPeekState } from "../components/editor/workspace/LocationPeek";
import type { LspDocumentSymbol } from "../lib/editor/lsp";
import type { RecentFileEntry } from "../components/editor/workspace/RecentFilesPopup";
import type {
  LspFileState,
  OpenFileState,
  TreeSelection,
  TreeViewMode,
} from "../components/editor/workspace/codeWorkspaceModel";
import {
  atomicCloseLeaf,
  atomicCloseTabInLeaf,
  atomicMoveTab,
  atomicSetLeafActiveTab,
  atomicSplitLeaf,
  commitLayoutMutation,
  createSingleLeafLayout,
  equalizeLeafParentSplit,
  getAllLeafNodes,
  setLeafTabs,
  remapLayoutTreeKeys,
  stretchLeafInTree,
  unsplitAllLeaves,
  updateSplitNodeRatios,
  validateLayoutTree,
  type LayoutMutationResult,
  type LayoutNode,
} from "../components/editor/workspace/recursiveLayoutTree";
import { readCodeWorkspaceTreeViewMode } from "../components/editor/workspace/codeWorkspaceModel";
import type { AnyWorkspaceTabPolicy } from "../components/editor/workspace/workspaceTabPolicy";

export type BottomDockTabId =
  | "problems"
  | "analysis"
  | "search"
  | "references"
  | "call-hierarchy"
  | "type-hierarchy"
  | "todos"
  | "terminal"
  | "run"
  | "build"
  | "tests"
  | "coverage"
  | "debug";
export type DebugSubTabId = "debugger" | "console" | "breakpoints" | "memory";
export type EditorGroupId = "primary" | "secondary" | string;
export type EditorSplitOrientation = "horizontal" | "vertical";
export type RightPaneTabId = "outline" | "documentation";

export interface CodeWorkspaceEditorGroupState {
  id: EditorGroupId;
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
}

export type CodeWorkspaceFileKeyChanges = Record<string, string | null>;

export interface CodeWorkspaceFileStateReplacement {
  openFiles: Record<string, OpenFileState>;
  lspFiles: Record<string, LspFileState>;
  /** Old key -> new key, or null when a resource operation removed the file. */
  keyChanges: CodeWorkspaceFileKeyChanges;
}

export function createEditorGroup(id: EditorGroupId): CodeWorkspaceEditorGroupState {
  return { id, openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] };
}

/**
 * Per-workspace-instance UI / chrome + open buffers / LSP file map.
 * Keyed by workspaceInstanceId so multiple workspace tabs stay isolated.
 *
 * Directory listing caches (directories/compact/flat) stay in the shell until
 * a later extract; expand keys and buffer text live here.
 */
export interface CodeWorkspaceInstanceUi {
  languagePanelOpen: boolean;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  debugSubTab: DebugSubTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  searchEverywhereOpen: boolean;
  searchEverywhereMode: SearchEverywhereMode;
  recentFilesOpen: boolean;
  recentAdvanceNonce: number;
  recentEntries: RecentFileEntry[];
  structureOpen: boolean;
  structureLoading: boolean;
  structureUnavailable: string | null;
  structureSymbols: LspDocumentSymbol[];
  quickDocOpen: boolean;
  quickDocContent: QuickDocContent | null;
  pinnedDoc: QuickDocContent | null;
  pinnedDocLocked: boolean;
  locationPeek: LocationPeekState | null;
  searchFocusNonce: number;
  searchIncludePreset: { value: string; nonce: number };
  searchQueryPreset: { value: string; nonce: number };
  openOrder: string[];
  activeKey: string | null;
  editorGroups: Record<EditorGroupId, CodeWorkspaceEditorGroupState>;
  activeEditorGroupId: EditorGroupId;
  splitOrientation: EditorSplitOrientation | null;
  /** Recursive layout tree v2 schema (A2); every instance owns a valid tree. */
  layoutTreeV2: LayoutNode;
  markdownModes: Record<string, "edit" | "preview" | "split">;
  /** Project tree chrome */
  treeFilter: string;
  treeViewMode: TreeViewMode;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  treeSelection: TreeSelection | null;
  /** Open editor buffers keyed by fileKey(ref). */
  /** Monotonic layout revision (§8.26.3 AA2 / ED-TABS-001) incremented on every layout mutation. */
  layoutRevision: number;
  openFiles: Record<string, OpenFileState>;
  /** Per-open-file LSP sync/diagnostics map. */
  lspFiles: Record<string, LspFileState>;
}

export function createDefaultCodeWorkspaceUi(): CodeWorkspaceInstanceUi {
  return {
    languagePanelOpen: true,
    bottomDockOpen: true,
    bottomDockTab: "references",
    debugSubTab: "debugger",
    rightPaneOpen: false,
    rightPaneTab: "outline",
    searchEverywhereOpen: false,
    searchEverywhereMode: "files",
    recentFilesOpen: false,
    recentAdvanceNonce: 0,
    recentEntries: [],
    structureOpen: false,
    structureLoading: false,
    structureUnavailable: null,
    structureSymbols: [],
    quickDocOpen: false,
    quickDocContent: null,
    pinnedDoc: null,
    pinnedDocLocked: false,
    locationPeek: null,
    searchFocusNonce: 0,
    searchIncludePreset: { value: "", nonce: 0 },
    searchQueryPreset: { value: "", nonce: 0 },
    openOrder: [],
    activeKey: null,
    editorGroups: {
      primary: createEditorGroup("primary"),
      secondary: createEditorGroup("secondary"),
    },
    activeEditorGroupId: "primary",
    splitOrientation: null,
    layoutTreeV2: createSingleLeafLayout("primary", [], null),
    markdownModes: {},
    layoutRevision: 0,
    treeFilter: "",
    treeViewMode: readCodeWorkspaceTreeViewMode(),
    expandedRootIds: [],
    expandedDirKeys: [],
    treeSelection: null,
    openFiles: {},
    lspFiles: {},
  };
}

/** Stable fallback so React/zustand getSnapshot does not allocate every render. */
const EMPTY_UI: CodeWorkspaceInstanceUi = createDefaultCodeWorkspaceUi();

type Updater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(prev: T, updater: Updater<T>): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
}

function remappedFileKey(
  key: string,
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): string | null {
  const mapped = Object.prototype.hasOwnProperty.call(keyChanges, key) ? keyChanges[key] : key;
  return mapped != null && validKeys.has(mapped) ? mapped : null;
}

function remapFileKeyList(
  keys: readonly string[],
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const key of keys) {
    const mapped = remappedFileKey(key, keyChanges, validKeys);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

function reconcileEditorGroupFiles(
  group: CodeWorkspaceEditorGroupState,
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): CodeWorkspaceEditorGroupState {
  const activeIndex = group.activeKey ? group.openOrder.indexOf(group.activeKey) : -1;
  const openOrder = remapFileKeyList(group.openOrder, keyChanges, validKeys);
  const mappedActive = group.activeKey
    ? remappedFileKey(group.activeKey, keyChanges, validKeys)
    : null;
  const activeKey = mappedActive && openOrder.includes(mappedActive)
    ? mappedActive
    : openOrder[Math.min(Math.max(activeIndex, 0), Math.max(openOrder.length - 1, 0))] ?? null;
  const mappedPreview = group.previewKey
    ? remappedFileKey(group.previewKey, keyChanges, validKeys)
    : null;
  return {
    ...group,
    openOrder,
    activeKey,
    previewKey: mappedPreview && openOrder.includes(mappedPreview) ? mappedPreview : null,
    pinnedKeys: remapFileKeyList(group.pinnedKeys, keyChanges, validKeys)
      .filter((key) => openOrder.includes(key)),
  };
}

function remapMarkdownModes(
  current: CodeWorkspaceInstanceUi["markdownModes"],
  keyChanges: CodeWorkspaceFileKeyChanges,
  validKeys: ReadonlySet<string>,
): CodeWorkspaceInstanceUi["markdownModes"] {
  const next: CodeWorkspaceInstanceUi["markdownModes"] = {};
  for (const [key, mode] of Object.entries(current)) {
    const mapped = remappedFileKey(key, keyChanges, validKeys);
    if (mapped) next[mapped] = mode;
  }
  return next;
}

interface CodeWorkspaceStoreState {
  byInstanceId: Record<string, CodeWorkspaceInstanceUi>;
  ensureInstance: (instanceId: string) => void;
  disposeInstance: (instanceId: string) => void;
  getInstance: (instanceId: string) => CodeWorkspaceInstanceUi;
  patchInstance: (instanceId: string, patch: Partial<CodeWorkspaceInstanceUi>) => void;
  setActiveKey: (instanceId: string, key: string | null) => void;
  setOpenOrder: (instanceId: string, order: string[]) => void;
  updateEditorGroup: (
    instanceId: string,
    groupId: EditorGroupId,
    updater: Updater<CodeWorkspaceEditorGroupState>,
  ) => void;
  setActiveEditorGroup: (instanceId: string, groupId: EditorGroupId) => void;
  setSplitOrientation: (instanceId: string, orientation: EditorSplitOrientation | null) => void;
  setLayoutTreeV2: (instanceId: string, layoutTree: LayoutNode) => void;
  setLayoutNodeRatios: (instanceId: string, splitId: string, ratios: number[]) => void;
  /** §8.19.6: even out the ratios of the split directly containing the leaf. */
  equalizeLayoutRatios: (instanceId: string, leafId: string) => void;
  /** §8.19.6: grow the leaf's share inside its parent split (repeatable, capped). */
  stretchLayoutLeaf: (
    instanceId: string,
    leafId: string,
    options?: { step?: number; max?: number },
  ) => void;
  /** §8.19.6: collapse every split into the first leaf, migrating all tabs. */
  unsplitAllLayout: (instanceId: string) => void;
  splitLayoutLeaf: (
    instanceId: string,
    leafId: string,
    orientation: "horizontal" | "vertical",
    newFileKey?: string,
  ) => void;
  closeLayoutLeaf: (instanceId: string, leafId: string) => void;
  moveLayoutTab: (
    instanceId: string,
    sourceLeafId: string,
    targetLeafId: string,
    fileKey: string,
  ) => void;
  setLeafActiveTab: (instanceId: string, leafId: string, fileKey: string | null) => void;
  closeLayoutTabInLeaf: (
    instanceId: string,
    leafId: string,
    fileKey: string,
    policy?: AnyWorkspaceTabPolicy,
    lastUsedByKey?: ReadonlyMap<string, number>,
  ) => void;
  setMarkdownMode: (instanceId: string, fileKey: string, mode: "edit" | "preview" | "split") => void;
  replaceFileState: (instanceId: string, replacement: CodeWorkspaceFileStateReplacement) => void;
  /** Explicitly increment monotonic layout revision (§8.26.3 AA2 / ED-TABS-001). */
  bumpLayoutRevision: (instanceId: string) => number;
  updateOpenFiles: (instanceId: string, updater: Updater<Record<string, OpenFileState>>) => void;
  updateLspFiles: (instanceId: string, updater: Updater<Record<string, LspFileState>>) => void;
  updateExpandedRootIds: (instanceId: string, updater: Updater<string[]>) => void;
  updateExpandedDirKeys: (instanceId: string, updater: Updater<string[]>) => void;
  seedTreeExpandIfEmpty: (instanceId: string, rootIds: string[], dirKeys: string[]) => void;
}

export const useCodeWorkspaceStore = create<CodeWorkspaceStoreState>((set, get) => ({
  byInstanceId: {},

  ensureInstance: (instanceId) => {
    if (!instanceId) return;
    if (get().byInstanceId[instanceId]) return;
    set((state) => ({
      byInstanceId: {
        ...state.byInstanceId,
        [instanceId]: createDefaultCodeWorkspaceUi(),
      },
    }));
  },

  disposeInstance: (instanceId) => {
    if (!get().byInstanceId[instanceId]) return;
    set((state) => {
      const next = { ...state.byInstanceId };
      delete next[instanceId];
      return { byInstanceId: next };
    });
  },

  getInstance: (instanceId) => {
    return get().byInstanceId[instanceId] ?? EMPTY_UI;
  },

  patchInstance: (instanceId, patch) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      let isLayoutChanged = false;
      if (patch.activeKey !== undefined && patch.activeKey !== current.activeKey) {
        isLayoutChanged = true;
      }
      if (patch.activeEditorGroupId !== undefined && patch.activeEditorGroupId !== current.activeEditorGroupId) {
        isLayoutChanged = true;
      }
      if (patch.splitOrientation !== undefined && patch.splitOrientation !== current.splitOrientation) {
        isLayoutChanged = true;
      }
      if (patch.layoutTreeV2 !== undefined && patch.layoutTreeV2 !== current.layoutTreeV2) {
        isLayoutChanged = true;
      }
      if (patch.editorGroups !== undefined && patch.editorGroups !== current.editorGroups) {
        isLayoutChanged = true;
      }
      if (patch.openOrder !== undefined && (
        patch.openOrder.length !== current.openOrder.length ||
        patch.openOrder.some((k, i) => k !== current.openOrder[i])
      )) {
        isLayoutChanged = true;
      }

      let anyFieldChanged = false;
      for (const [key, val] of Object.entries(patch)) {
        if ((current as unknown as Record<string, unknown>)[key] !== val) {
          anyFieldChanged = true;
          break;
        }
      }
      if (!anyFieldChanged && patch.layoutRevision === undefined) {
        return state;
      }

      const nextRevision =
        patch.layoutRevision !== undefined
          ? patch.layoutRevision
          : isLayoutChanged
            ? current.layoutRevision + 1
            : current.layoutRevision;

      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: { ...current, ...patch, layoutRevision: nextRevision },
        },
      };
    });
  },

  setActiveKey: (instanceId, key) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const groupId = current.activeEditorGroupId;
      const group = current.editorGroups[groupId];
      if (current.activeKey === key && group?.activeKey === key) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            activeKey: key,
            editorGroups: {
              ...current.editorGroups,
              [groupId]: group ? { ...group, activeKey: key } : createEditorGroup(groupId),
            },
          },
        },
      };
    });
  },

  setOpenOrder: (instanceId, order) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const groupId = current.activeEditorGroupId;
      const group = current.editorGroups[groupId];
      const unchanged =
        current.openOrder.length === order.length &&
        current.openOrder.every((k, i) => k === order[i]) &&
        group &&
        group.openOrder.length === order.length &&
        group.openOrder.every((k, i) => k === order[i]);
      if (unchanged) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            openOrder: order,
            editorGroups: {
              ...current.editorGroups,
              [groupId]: group ? { ...group, openOrder: order } : { ...createEditorGroup(groupId), openOrder: order },
            },
          },
        },
      };
    });
  },

  updateEditorGroup: (instanceId, groupId, updater) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const prevGroup = current.editorGroups[groupId];
      const nextGroup = resolveUpdater(prevGroup, updater);
      if (nextGroup === prevGroup) return state;
      if (
        prevGroup &&
        prevGroup.activeKey === nextGroup.activeKey &&
        prevGroup.previewKey === nextGroup.previewKey &&
        prevGroup.openOrder.length === nextGroup.openOrder.length &&
        prevGroup.openOrder.every((k, i) => k === nextGroup.openOrder[i]) &&
        prevGroup.pinnedKeys.length === nextGroup.pinnedKeys.length &&
        prevGroup.pinnedKeys.every((k, i) => k === nextGroup.pinnedKeys[i])
      ) {
        return state;
      }
      const active = current.activeEditorGroupId === groupId;
      // §8.16.4 N6.6: mirror group writes into the recursive tree so the
      // leaf stays the structural truth (same reference when unchanged).
      const nextTree = setLeafTabs(current.layoutTreeV2, groupId, nextGroup.openOrder, nextGroup.activeKey);
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            openOrder: active ? nextGroup.openOrder : current.openOrder,
            activeKey: active ? nextGroup.activeKey : current.activeKey,
            editorGroups: { ...current.editorGroups, [groupId]: nextGroup },
            layoutTreeV2: nextTree,
          },
        },
      };
    });
  },

  setActiveEditorGroup: (instanceId, groupId) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      if (current.activeEditorGroupId === groupId) return state;
      const group = current.editorGroups[groupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            activeEditorGroupId: groupId,
            openOrder: group?.openOrder ?? current.openOrder,
            activeKey: group?.activeKey ?? current.activeKey,
          },
        },
      };
    });
  },

  setSplitOrientation: (instanceId, orientation) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      if (current.splitOrientation === orientation) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            splitOrientation: orientation,
          },
        },
      };
    });
  },

  setLayoutTreeV2: (instanceId, layoutTree) => {
    get().ensureInstance(instanceId);
    if (!validateLayoutTree(layoutTree).valid) return;
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      if (current.layoutTreeV2 === layoutTree) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: layoutTree,
          },
        },
      };
    });
  },

  splitLayoutLeaf: (instanceId, leafId, orientation, newFileKey) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const currentTree = current.layoutTreeV2;
      const rawResult = atomicSplitLeaf(
        currentTree,
        current.editorGroups,
        current.activeEditorGroupId,
        leafId,
        orientation,
        newFileKey,
      );
      const result = commitLayoutMutation(currentTree, current.editorGroups, current.activeEditorGroupId, rawResult);
      if (result.kind !== "changed") {
        return state;
      }
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: result.tree,
            editorGroups: result.groups,
            activeEditorGroupId: result.activeGroupId,
            splitOrientation: orientation,
          },
        },
      };
    });
  },

  closeLayoutLeaf: (instanceId, leafId) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const rawResult = atomicCloseLeaf(
        current.layoutTreeV2,
        current.editorGroups,
        current.activeEditorGroupId,
        leafId,
      );
      const result = commitLayoutMutation(current.layoutTreeV2, current.editorGroups, current.activeEditorGroupId, rawResult);
      if (result.kind !== "changed") {
        return state;
      }
      const activeGroup = result.groups[result.activeGroupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: result.tree,
            editorGroups: result.groups,
            activeEditorGroupId: result.activeGroupId,
            splitOrientation: result.tree.type === "split" ? result.tree.orientation : null,
            openOrder: activeGroup?.openOrder ?? current.openOrder,
            activeKey: activeGroup?.activeKey ?? null,
          },
        },
      };
    });
  },

  moveLayoutTab: (instanceId, sourceLeafId, targetLeafId, fileKey) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const rawResult = atomicMoveTab(
        current.layoutTreeV2,
        current.editorGroups,
        current.activeEditorGroupId,
        sourceLeafId,
        targetLeafId,
        fileKey,
      );
      const result = commitLayoutMutation(current.layoutTreeV2, current.editorGroups, current.activeEditorGroupId, rawResult);
      if (result.kind !== "changed") {
        return state;
      }
      const activeGroup = result.groups[result.activeGroupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: result.tree,
            editorGroups: result.groups,
            activeEditorGroupId: result.activeGroupId,
            openOrder: activeGroup?.openOrder ?? current.openOrder,
            activeKey: activeGroup?.activeKey ?? current.activeKey,
          },
        },
      };
    });
  },

  setLeafActiveTab: (instanceId, leafId, fileKey) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const currentTree = current.layoutTreeV2;
      const rawResult = atomicSetLeafActiveTab(
        currentTree,
        current.editorGroups,
        current.activeEditorGroupId,
        leafId,
        fileKey,
      );
      const result = commitLayoutMutation(currentTree, current.editorGroups, current.activeEditorGroupId, rawResult);
      if (result.kind !== "changed") {
        return state;
      }
      const activeGroup = result.groups[result.activeGroupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: result.tree,
            editorGroups: result.groups,
            activeEditorGroupId: result.activeGroupId,
            openOrder: activeGroup?.openOrder ?? current.openOrder,
            activeKey: activeGroup?.activeKey ?? current.activeKey,
          },
        },
      };
    });
  },

  closeLayoutTabInLeaf: (instanceId, leafId, fileKey, policy, lastUsedByKey) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const currentTree = current.layoutTreeV2;
      const rawResult = atomicCloseTabInLeaf(
        currentTree,
        current.editorGroups,
        current.activeEditorGroupId,
        leafId,
        fileKey,
        policy,
        lastUsedByKey,
      );
      const result = commitLayoutMutation(currentTree, current.editorGroups, current.activeEditorGroupId, rawResult);
      if (result.kind !== "changed") {
        return state;
      }
      const activeGroup = result.groups[result.activeGroupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: result.tree,
            editorGroups: result.groups,
            openOrder: activeGroup?.openOrder ?? current.openOrder,
            activeKey: activeGroup?.activeKey ?? current.activeKey,
          },
        },
      };
    });
  },

  setLayoutNodeRatios: (instanceId, splitId, ratios) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const nextTree = updateSplitNodeRatios(current.layoutTreeV2, splitId, ratios);
      if (nextTree === current.layoutTreeV2) return state;
      const validation = commitLayoutMutation(
        current.layoutTreeV2,
        current.editorGroups,
        current.activeEditorGroupId,
        {
          kind: "changed",
          tree: nextTree,
          groups: current.editorGroups,
          activeGroupId: current.activeEditorGroupId,
        },
      );
      if (validation.kind !== "changed") return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: validation.tree,
          },
        },
      };
    });
  },

  equalizeLayoutRatios: (instanceId, leafId) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const nextTree = equalizeLeafParentSplit(current.layoutTreeV2, leafId);
      if (nextTree === current.layoutTreeV2) return state;
      const validation = commitLayoutMutation(
        current.layoutTreeV2,
        current.editorGroups,
        current.activeEditorGroupId,
        { kind: "changed", tree: nextTree, groups: current.editorGroups, activeGroupId: current.activeEditorGroupId },
      );
      if (validation.kind !== "changed") return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: validation.tree,
          },
        },
      };
    });
  },

  stretchLayoutLeaf: (instanceId, leafId, options) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const nextTree = stretchLeafInTree(current.layoutTreeV2, leafId, options);
      if (nextTree === current.layoutTreeV2) return state;
      const validation = commitLayoutMutation(
        current.layoutTreeV2,
        current.editorGroups,
        current.activeEditorGroupId,
        { kind: "changed", tree: nextTree, groups: current.editorGroups, activeGroupId: current.activeEditorGroupId },
      );
      if (validation.kind !== "changed") return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: validation.tree,
          },
        },
      };
    });
  },

  unsplitAllLayout: (instanceId) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const merged = unsplitAllLeaves(current.layoutTreeV2, current.activeEditorGroupId);
      if (!merged) return state;
      const survivorId = merged.tree.id;
      const openOrder = [...merged.mergedKeys];
      // Union pinned tabs from every absorbed leaf; drop anything not merged.
      const pinnedKeys: string[] = [];
      for (const leaf of getAllLeafNodes(current.layoutTreeV2)) {
        for (const key of current.editorGroups[leaf.id]?.pinnedKeys ?? []) {
          if (openOrder.includes(key) && !pinnedKeys.includes(key)) pinnedKeys.push(key);
        }
      }
      const previewCandidate = current.editorGroups[survivorId]?.previewKey ?? null;
      const previewKey =
        previewCandidate != null && openOrder.includes(previewCandidate)
          ? previewCandidate
          : null;

      const nextGroups: Record<string, CodeWorkspaceEditorGroupState> = {};
      // Dormant empty legacy slots carry no layout truth — keep them as-is.
      for (const [id, group] of Object.entries(current.editorGroups)) {
        if (group && id !== survivorId && group.openOrder.length === 0) nextGroups[id] = group;
      }
      nextGroups[survivorId] = {
        id: survivorId,
        openOrder,
        activeKey: merged.tree.activeKey,
        previewKey,
        pinnedKeys,
      };

      const rawResult: LayoutMutationResult = {
        kind: "changed",
        tree: merged.tree,
        groups: nextGroups,
        activeGroupId: survivorId,
      };
      const result = commitLayoutMutation(current.layoutTreeV2, current.editorGroups, current.activeEditorGroupId, rawResult);
      if (result.kind !== "changed") return state;
      const activeGroup = result.groups[result.activeGroupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            layoutTreeV2: result.tree,
            editorGroups: result.groups,
            activeEditorGroupId: result.activeGroupId,
            splitOrientation: result.tree.type === "split" ? result.tree.orientation : null,
            openOrder: activeGroup?.openOrder ?? current.openOrder,
            activeKey: activeGroup?.activeKey ?? null,
          },
        },
      };
    });
  },

  setMarkdownMode: (instanceId, fileKey, mode) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            markdownModes: { ...current.markdownModes, [fileKey]: mode },
          },
        },
      };
    });
  },

  replaceFileState: (instanceId, replacement) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const validKeys = new Set(Object.keys(replacement.openFiles));
      const editorGroups: CodeWorkspaceInstanceUi["editorGroups"] = {};
      for (const [gid, grp] of Object.entries(current.editorGroups)) {
        if (grp) {
          editorGroups[gid] = reconcileEditorGroupFiles(
            grp,
            replacement.keyChanges,
            validKeys,
          );
        }
      }
      if (!editorGroups.primary) {
        editorGroups.primary = createEditorGroup("primary");
      }
      if (!editorGroups.secondary) {
        editorGroups.secondary = createEditorGroup("secondary");
      }
      const activeGroup = editorGroups[current.activeEditorGroupId] ?? editorGroups.primary;
      const layoutTreeV2 = remapLayoutTreeKeys(current.layoutTreeV2, replacement.keyChanges, validKeys, editorGroups);
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: current.layoutRevision + 1,
            openFiles: replacement.openFiles,
            lspFiles: replacement.lspFiles,
            editorGroups,
            layoutTreeV2,
            openOrder: activeGroup.openOrder,
            activeKey: activeGroup.activeKey,
            markdownModes: remapMarkdownModes(current.markdownModes, replacement.keyChanges, validKeys),
            recentFilesOpen: false,
            recentEntries: [],
            locationPeek: null,
          },
        },
      };
    });
  },

  bumpLayoutRevision: (instanceId: string) => {
    get().ensureInstance(instanceId);
    let nextRev = 1;
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      nextRev = current.layoutRevision + 1;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            layoutRevision: nextRev,
          },
        },
      };
    });
    return nextRev;
  },

  updateOpenFiles: (instanceId, updater) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const openFiles = resolveUpdater(current.openFiles, updater);
      if (openFiles === current.openFiles) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            openFiles,
          },
        },
      };
    });
  },

  updateLspFiles: (instanceId, updater) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const lspFiles = resolveUpdater(current.lspFiles, updater);
      if (lspFiles === current.lspFiles) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            lspFiles,
          },
        },
      };
    });
  },

  updateExpandedRootIds: (instanceId, updater) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            expandedRootIds: resolveUpdater(current.expandedRootIds, updater),
          },
        },
      };
    });
  },

  updateExpandedDirKeys: (instanceId, updater) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            expandedDirKeys: resolveUpdater(current.expandedDirKeys, updater),
          },
        },
      };
    });
  },

  seedTreeExpandIfEmpty: (instanceId, rootIds, dirKeys) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      if (current.expandedRootIds.length > 0 || current.expandedDirKeys.length > 0) {
        return state;
      }
      if (rootIds.length === 0) return state;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            expandedRootIds: rootIds,
            expandedDirKeys: dirKeys,
          },
        },
      };
    });
  },
}));

/** Select one instance UI slice; returns stable defaults when missing. */
export function selectCodeWorkspaceUi(
  state: CodeWorkspaceStoreState,
  instanceId: string,
): CodeWorkspaceInstanceUi {
  return state.byInstanceId[instanceId] ?? EMPTY_UI;
}
