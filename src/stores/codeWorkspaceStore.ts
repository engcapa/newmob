import { create } from "zustand";
import type { SearchEverywhereMode } from "../components/editor/workspace/SearchEverywhere";
import type { QuickDocContent } from "../components/editor/workspace/QuickDocPopup";
import type { LocationPeekState } from "../components/editor/workspace/LocationPeek";
import type { LspDocumentSymbol } from "../lib/editor/lsp";
import type { RecentFileEntry } from "../components/editor/workspace/RecentFilesPopup";
import type {
  LspFileState,
  OpenFileState,
  TreeSelection,
  TreeViewMode,
} from "../components/editor/workspace/codeWorkspaceModel";
import { readCodeWorkspaceTreeViewMode } from "../components/editor/workspace/codeWorkspaceModel";

export type BottomDockTabId =
  | "problems"
  | "search"
  | "references"
  | "call-hierarchy"
  | "type-hierarchy"
  | "todos"
  | "terminal"
  | "run"
  | "build"
  | "tests"
  | "debug";
export type EditorGroupId = "primary" | "secondary";
export type EditorSplitOrientation = "horizontal" | "vertical";
export type RightPaneTabId = "outline" | "documentation";

export interface CodeWorkspaceEditorGroupState {
  id: EditorGroupId;
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
}

function createEditorGroup(id: EditorGroupId): CodeWorkspaceEditorGroupState {
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
  markdownModes: Record<string, "edit" | "preview" | "split">;
  /** Project tree chrome */
  treeFilter: string;
  treeViewMode: TreeViewMode;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  treeSelection: TreeSelection | null;
  /** Open editor buffers keyed by fileKey(ref). */
  openFiles: Record<string, OpenFileState>;
  /** Per-open-file LSP sync/diagnostics map. */
  lspFiles: Record<string, LspFileState>;
}

export function createDefaultCodeWorkspaceUi(): CodeWorkspaceInstanceUi {
  return {
    languagePanelOpen: true,
    bottomDockOpen: true,
    bottomDockTab: "references",
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
    markdownModes: {},
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
  setMarkdownMode: (instanceId: string, fileKey: string, mode: "edit" | "preview" | "split") => void;
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
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: { ...current, ...patch },
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
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            activeKey: key,
            editorGroups: {
              ...current.editorGroups,
              [groupId]: { ...group, activeKey: key },
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
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            openOrder: order,
            editorGroups: {
              ...current.editorGroups,
              [groupId]: { ...group, openOrder: order },
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
      const nextGroup = resolveUpdater(current.editorGroups[groupId], updater);
      const active = current.activeEditorGroupId === groupId;
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            openOrder: active ? nextGroup.openOrder : current.openOrder,
            activeKey: active ? nextGroup.activeKey : current.activeKey,
            editorGroups: { ...current.editorGroups, [groupId]: nextGroup },
          },
        },
      };
    });
  },

  setActiveEditorGroup: (instanceId, groupId) => {
    get().ensureInstance(instanceId);
    set((state) => {
      const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
      const group = current.editorGroups[groupId];
      return {
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: {
            ...current,
            activeEditorGroupId: groupId,
            openOrder: group.openOrder,
            activeKey: group.activeKey,
          },
        },
      };
    });
  },

  setSplitOrientation: (instanceId, orientation) => {
    get().patchInstance(instanceId, { splitOrientation: orientation });
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
