import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  ListTree,
  GitFork,
  Network,
  ListTodo,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  BookOpen,
  PanelRight,
  Columns2,
  Rows2,
  TerminalSquare,
  Play,
  Hammer,
  FlaskConical,
  Bug,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  workspaceListDir,
  workspaceReadFile,
  workspaceReadLooseFile,
  workspaceTaskTree,
  workspaceWriteFile,
  workspaceWriteLooseFile,
  type WorkspaceGitRoot,
} from "../../lib/editor/workspace";
import {
  gitBlameLines,
  gitBlobPair,
  type GitBlameLine,
  type GitChange,
} from "../../lib/git";
import {
  lspCodeActions,
  lspCompletion,
  lspCompletionResolve,
  lspDocumentSymbols,
  lspDocumentHighlights,
  lspFormatting,
  lspDefinition,
  lspHover,
  lspImplementation,
  lspInlayHints,
  lspJavaModules,
  javaTestDiscover,
  javaTestResolveLaunch,
  lspPrepareCallHierarchy,
  lspPrepareRename,
  lspPrepareTypeHierarchy,
  lspRangeFormatting,
  lspDownloadSources,
  lspReloadProject,
  lspBuildWorkspace,
  lspWorkspaceDiagnostics,
  lspReadUriContents,
  lspReferences,
  lspRename,
  lspSelectionRanges,
  lspSemanticTokens,
  lspSignatureHelp,
  lspTypeDefinition,
  lspWorkspaceSymbols,
  type LspCodeAction,
  type JavaTestItem,
  type LspCompletionItem,
  type LspCompletionResult,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspDocumentHighlight,
  type LspInlayHint,
  type LspSemanticToken,
  type LspLocation,
  type LspPosition,
  type LspRange,
  type LspSignatureHelpResult,
  type LspWorkspaceEdit,
} from "../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_CODE_VIEW_PROFILE,
  applyCodeViewProfile,
  loadCodeViewProfile,
  normalizeCodeViewProfile,
  sameCodeViewProfile,
  saveCodeViewProfile,
  subscribeCodeViewProfile,
  type CodeViewProfile,
} from "../../lib/codeViewProfile";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { useAppStore } from "../../stores/appStore";
import {
  selectCodeWorkspaceUi,
  useCodeWorkspaceStore,
  type BottomDockTabId,
  type CodeWorkspaceEditorGroupState,
  type EditorGroupId,
  type EditorSplitOrientation,
  type RightPaneTabId,
} from "../../stores/codeWorkspaceStore";
import {
  useCodeWorkspaceStatusStore,
} from "../../stores/codeWorkspaceStatusStore";
import { historySnapshot } from "../../lib/localHistory";
import {
  fileRefFromFileKey,
  layoutSnapshotHasOpenFiles,
  readWorkspaceLayoutSnapshot,
  snapshotFromWorkspaceUi,
  uniqueOrderedKeys,
  writeWorkspaceLayoutSnapshot,
} from "./workspace/workspaceLayoutPersistence";
import { LocalHistoryDialog } from "./workspace/LocalHistoryDialog";
import { EditorSelectionAiToolbar, type EditorAiAction } from "./workspace/EditorSelectionAiToolbar";
import { EditorAiRewriteDialog } from "./workspace/EditorAiRewriteDialog";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { writeText } from "../../lib/clipboard";
import { useContextMenu } from "../ContextMenu";
import { useChatStore } from "../../stores/chatStore";
import {
  type EditorContextMenuRequest,
  type EditorSelectionRange,
} from "./workspace/CodeMirrorHost";
import { buildEditorContextMenuItems } from "./workspace/editorContextMenu";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { fallbackWordHighlights } from "./workspace/lspIntelligenceChrome";
import {
  inlayHintsEnabledForLanguage,
  readWorkspaceIntelligencePreferences,
  writeWorkspaceIntelligencePreferences,
  type WorkspaceIntelligencePreferences,
} from "./workspace/intelligencePreferences";
import { applyLspTextEditsToString } from "./workspace/lspTextEdits";
import { isLargeFileContent } from "./workspace/largeFile";
import {
  applyWorkspaceEdit,
  summarizeWorkspaceEditOutcomes,
} from "./workspace/workspaceEditApply";
import { buildReplaceWorkspaceEdit } from "./workspace/buildReplaceEdits";
import { BottomDock } from "./workspace/panels/BottomDock";
import {
  ReferencesPanel,
  type ReferencesResultState,
} from "./workspace/panels/ReferencesPanel";
import {
  ProblemsPanel,
  type ProblemFileGroup,
  type ProblemsScope,
} from "./workspace/panels/ProblemsPanel";
import { FindInFilesPanel } from "./workspace/panels/FindInFilesPanel";
import { DocumentationPane } from "./workspace/panels/DocumentationPane";
import {
  HierarchyPanel,
  type HierarchyRootState,
} from "./workspace/panels/HierarchyPanel";
import { TodosBookmarksPanel } from "./workspace/panels/TodosBookmarksPanel";
import {
  readWorkspaceBookmarks,
  toggleWorkspaceBookmark,
  writeWorkspaceBookmarks,
  type WorkspaceBookmark,
} from "./workspace/todoBookmarks";
import { useDeferredOpenFileTodos } from "./workspace/useDeferredOpenFileTodos";
import { type QuickDocContent } from "./workspace/QuickDocPopup";
import { type LocationPeekState } from "./workspace/LocationPeek";
import {
  type GoToSymbolItem,
  type SearchEverywhereMode,
} from "./workspace/SearchEverywhere";
import { type RecentFileEntry } from "./workspace/RecentFilesPopup";
import { EditorGroup } from "./workspace/EditorGroup";
import { WorkspacePopupsHost } from "./workspace/WorkspacePopupsHost";
import { WorkspaceSdkStatus } from "./workspace/WorkspaceSdkStatus";
import { FileTreePane } from "./workspace/FileTreePane";
import { ProjectTree } from "./workspace/ProjectTree";
import { MarkdownPreview } from "./workspace/MarkdownPreview";
import { IconButton, LspStatusPill } from "./workspace/workspaceChrome";
import { OutlinePane } from "./workspace/OutlinePane";
import { useDeferredGitLineChanges } from "./workspace/useDeferredGitLineChanges";
import {
  dispatchWorkspaceCommandKeydown,
  runWorkspaceCommand,
  workspaceCommandEnabled,
  workspaceCommandMenuItems,
  type WorkspaceCommand,
  type WorkspaceCommandContext,
  type WorkspaceCommandFocus,
  type WorkspaceCommandRegistration,
} from "./workspace/workspaceCommands";
import type { WorkspaceSearchMatch } from "../../lib/editor/workspaceSearch";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceLooseFileInfo,
  CodeWorkspaceRootInfo,
  CodeWorkspaceTabInfo,
} from "../../types";

interface CodeWorkspaceTabProps {
  tabId: string;
  workspace: CodeWorkspaceTabInfo;
  visible?: boolean;
  onOpenGitManager?: (payload: CodeWorkspaceGitManagerPayload) => void;
  onSyncGitManager?: (payload: CodeWorkspaceGitManagerPayload) => void;
  onCommandsChange?: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
}

export interface CodeWorkspaceGitManagerPayload {
    workspaceName: string;
    workspaceInstanceId?: string;
    workspaceId?: string;
    roots: WorkspaceGitRoot[];
    activeRepoRoot: string | null;
}

function breadcrumbSegmentsForFile(
  file: OpenFileState,
  roots: CodeWorkspaceRootInfo[],
): BreadcrumbPathSegment[] {
  // Library sources have no directory trail — show where the class came from.
  if (file.library) {
    const trail: BreadcrumbPathSegment[] = [];
    if (file.library.container) {
      trail.push({ label: file.library.container, path: "", kind: "root" });
    }
    trail.push({ label: file.title, path: file.path, kind: "file" });
    return trail;
  }
  if (file.ref.kind === "root") {
    const rootId = file.ref.rootId;
    const root = roots.find((candidate) => candidate.id === rootId);
    if (!root) return [{ label: file.title, path: file.ref.path, kind: "file" }];
    const parts = file.ref.path.split("/").filter(Boolean);
    let path = "";
    return [
      { label: root.name, path: "", kind: "root" },
      ...parts.map((part, index): BreadcrumbPathSegment => {
        path = path ? `${path}/${part}` : part;
        return { label: part, path, kind: index === parts.length - 1 ? "file" : "directory" };
      }),
    ];
  }
  const normalized = normalizeFsPath(file.ref.path);
  const parts = normalized.split("/").filter(Boolean);
  let path = normalized.startsWith("/") ? "/" : "";
  return parts.map((part, index): BreadcrumbPathSegment => {
    path = path === "/" ? `/${part}` : path ? `${path}/${part}` : part;
    return { label: part, path, kind: index === parts.length - 1 ? "file" : "directory" };
  });
}

function initialInlayHintRange(text: string): LspRange {
  const lines = text.split("\n");
  const endLine = Math.min(Math.max(lines.length - 1, 0), 199);
  return {
    start: { line: 0, character: 0 },
    end: { line: endLine, character: lines[endLine]?.length ?? 0 },
  };
}

/** Maven / Gradle build descriptors that warrant a jdtls project reload on save. */
function isJavaBuildFile(languagePath: string): boolean {
  const name = languagePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return name === "pom.xml"
    || name === "build.gradle"
    || name === "build.gradle.kts"
    || name === "settings.gradle"
    || name === "settings.gradle.kts";
}

// Keep document synchronization ahead of the comparatively expensive derived
// LSP features.  In particular, rust-analyzer semantic tokens can be large
// enough that applying them while somebody is still typing is noticeable.
// Background typing coalesces didChange at this interval; completion/signature
// force-flush immediately so the server is not one keystroke behind.
// Slightly longer than a single keystroke so jdtls is not flooded while still
// feeling immediate once ensureLspDocumentSynced force-flushes for completion.
const LSP_CHANGE_SYNC_DELAY_MS = 140;
const LSP_FEATURE_SYNC_WAIT_MS = 400;
const LSP_HIGHLIGHT_IDLE_DELAY_MS = 500;
const LSP_INLAY_HINT_IDLE_DELAY_MS = 650;
const LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS = 900;
const LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS = 650;
// CodeMirror owns the live text while the user is typing. Publishing every
// keypress into the workspace-wide Zustand object redraws the file tree,
// panels, and command chrome, so commit an editing burst as one update.
const EDITOR_TEXT_COMMIT_IDLE_DELAY_MS = 220;

import {
  type LibraryBufferInfo,
  type LspFileState,
  type MarkdownViewMode,
  type OpenFileState,
  type TreeSelection,
  type TreeViewMode,
  type WorkspaceTreeCommandPayload,
  CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE,
  CODE_WORKSPACE_MAX_FONT_SIZE,
  CODE_WORKSPACE_MAX_TREE_FONT_SIZE,
  CODE_WORKSPACE_MIN_FONT_SIZE,
  CODE_WORKSPACE_MIN_TREE_FONT_SIZE,
  absoluteWorkspacePath,
  basename,
  clampCodeWorkspaceFontSize,
  clampCodeWorkspaceTreeFontSize,
  emptyLspFileState,
  errorMessage,
  fileKey,
  fileMeta,
  formatBytes,
  formatMtime,
  gitRootForWorkspacePath,
  gitPathForWorkspacePath,
  gitRootsForWorkspaceRoot,
  initialFileRef,
  initialLooseFiles,
  initialRoots,
  isExternalHref,
  isLspFeatureReady,
  isMarkdownPath,
  applyEditorEol,
  looksLikeDocumentUri,
  shouldLiveSyncLsp,
  shouldProbeLsp,
  makeLibraryFile,
  makeLoadingFile,
  makeLooseFile,
  normalizeEditorText,
  normalizeFsPath,
  parentPath,
  readCodeWorkspaceTreeFontSize,
  relativePathWithinRoot,
  resolveLooseMarkdownLink,
  resolveRootMarkdownLink,
  rootDirKey,
  shouldHideEntry,
  workspacePathForGitPath,
  workspaceTitle,
  writeCodeWorkspaceTreeFontSize,
  writeCodeWorkspaceTreeViewMode,
} from "./workspace/codeWorkspaceModel";
import { useWorkspaceTreeData } from "./workspace/useWorkspaceTreeData";
import { useWorkspaceLspSession } from "./workspace/useWorkspaceLspSession";
import { useWorkspaceGitSnapshots } from "./workspace/useWorkspaceGitSnapshots";
import { useWorkspaceNavigation } from "./workspace/useWorkspaceNavigation";
import { useWorkspaceFileActions } from "./workspace/useWorkspaceFileActions";
import {
  Breadcrumbs,
  type BreadcrumbPathAction,
  type BreadcrumbPathChild,
  type BreadcrumbPathSegment,
} from "./workspace/Breadcrumbs";
import {
  TerminalDockPanel,
  type TerminalDockHandle,
} from "./workspace/panels/TerminalDockPanel";
import { RunPanel, type RunPanelHandle, type WorkspaceTaskItem } from "./workspace/panels/RunPanel";
import { BuildPanel } from "./workspace/panels/BuildPanel";
import { TestsPanel } from "./workspace/panels/TestsPanel";
import { defaultRunner, javaTestRunCommand, type JavaTestBuildTool } from "./workspace/panels/javaTestRun";
import { DebugPanel } from "./workspace/panels/DebugPanel";
import { useCodeDebugSession } from "./workspace/useCodeDebugSession";
import type { DebugStackFrame } from "./workspace/dapDebugModel";
import type { DebugBreakpointMarker } from "./workspace/debugEditorChrome";
import type { EditorRevealTarget } from "./workspace/EditorGroup";

export function CodeWorkspaceTab({
  tabId,
  workspace,
  visible = true,
  onOpenGitManager,
  onSyncGitManager,
  onCommandsChange,
}: CodeWorkspaceTabProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabCodeWorkspaceContext = useAppStore((s) => s.setTabCodeWorkspaceContext);
  const setWorkspaceStatusSegments = useCodeWorkspaceStatusStore((s) => s.setStatus);
  const setWorkspaceStatusActions = useCodeWorkspaceStatusStore((s) => s.setActions);
  const clearWorkspaceStatus = useCodeWorkspaceStatusStore((s) => s.clearForTab);
  const attachToComposer = useChatStore((s) => s.attachToComposer);
  const workspaceInstanceId = useMemo(
    () => workspace.workspaceInstanceId ?? workspace.workspaceId ?? workspace.repoRoot?.trim() ?? tabId,
    [tabId, workspace.repoRoot, workspace.workspaceId, workspace.workspaceInstanceId],
  );
  const [bookmarks, setBookmarks] = useState<WorkspaceBookmark[]>(
    () => readWorkspaceBookmarks(workspaceInstanceId),
  );
  const ensureWorkspaceUi = useCodeWorkspaceStore((s) => s.ensureInstance);
  const disposeWorkspaceUi = useCodeWorkspaceStore((s) => s.disposeInstance);
  const patchWorkspaceUi = useCodeWorkspaceStore((s) => s.patchInstance);
  const setStoreActiveKey = useCodeWorkspaceStore((s) => s.setActiveKey);
  const setStoreOpenOrder = useCodeWorkspaceStore((s) => s.setOpenOrder);
  const updateStoreOpenFiles = useCodeWorkspaceStore((s) => s.updateOpenFiles);
  const updateStoreLspFiles = useCodeWorkspaceStore((s) => s.updateLspFiles);
  const updateStoreExpandedRootIds = useCodeWorkspaceStore((s) => s.updateExpandedRootIds);
  const updateStoreExpandedDirKeys = useCodeWorkspaceStore((s) => s.updateExpandedDirKeys);
  const updateStoreEditorGroup = useCodeWorkspaceStore((s) => s.updateEditorGroup);
  const setStoreActiveEditorGroup = useCodeWorkspaceStore((s) => s.setActiveEditorGroup);
  const setStoreSplitOrientation = useCodeWorkspaceStore((s) => s.setSplitOrientation);
  const seedTreeExpandIfEmpty = useCodeWorkspaceStore((s) => s.seedTreeExpandIfEmpty);
  // Ensure before first read so the selector always hits a real map entry.
  ensureWorkspaceUi(workspaceInstanceId);
  const workspaceUi = useCodeWorkspaceStore((s) => selectCodeWorkspaceUi(s, workspaceInstanceId));

  useEffect(() => {
    ensureWorkspaceUi(workspaceInstanceId);
    setBookmarks(readWorkspaceBookmarks(workspaceInstanceId));
  }, [ensureWorkspaceUi, workspaceInstanceId]);

  // Restore chrome/layout once per instance, then seed expand keys only when empty.
  const layoutHydratedRef = useRef<string | null>(null);
  const layoutRestoredOpenFilesRef = useRef(false);
  useEffect(() => {
    if (layoutHydratedRef.current === workspaceInstanceId) return;
    layoutHydratedRef.current = workspaceInstanceId;
    layoutRestoredOpenFilesRef.current = false;
    const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
    if (snapshot) {
      patchWorkspaceUi(workspaceInstanceId, {
        bottomDockOpen: snapshot.bottomDockOpen,
        bottomDockTab: snapshot.bottomDockTab,
        rightPaneOpen: snapshot.rightPaneOpen,
        rightPaneTab: snapshot.rightPaneTab,
        languagePanelOpen: snapshot.languagePanelOpen,
        splitOrientation: snapshot.splitOrientation,
        activeEditorGroupId: snapshot.activeEditorGroupId,
        expandedRootIds: snapshot.expandedRootIds,
        expandedDirKeys: snapshot.expandedDirKeys,
        editorGroups: {
          primary: {
            id: "primary",
            openOrder: snapshot.editorGroups.primary.openOrder,
            activeKey: snapshot.editorGroups.primary.activeKey,
            previewKey: snapshot.editorGroups.primary.previewKey,
            pinnedKeys: snapshot.editorGroups.primary.pinnedKeys,
          },
          secondary: {
            id: "secondary",
            openOrder: snapshot.editorGroups.secondary.openOrder,
            activeKey: snapshot.editorGroups.secondary.activeKey,
            previewKey: snapshot.editorGroups.secondary.previewKey,
            pinnedKeys: snapshot.editorGroups.secondary.pinnedKeys,
          },
        },
        openOrder: uniqueOrderedKeys(snapshot.editorGroups),
        activeKey: snapshot.editorGroups[snapshot.activeEditorGroupId]?.activeKey
          ?? snapshot.editorGroups.primary.activeKey
          ?? snapshot.editorGroups.secondary.activeKey,
      });
      layoutRestoredOpenFilesRef.current = layoutSnapshotHasOpenFiles(snapshot);
      return;
    }
    const seedRoots = initialRoots(workspace);
    if (seedRoots.length === 0) return;
    seedTreeExpandIfEmpty(
      workspaceInstanceId,
      seedRoots.map((root) => root.id),
      seedRoots.map((root) => rootDirKey(root.id, "")),
    );
  }, [patchWorkspaceUi, seedTreeExpandIfEmpty, workspace, workspaceInstanceId]);

  const {
    languagePanelOpen,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen,
    rightPaneTab,
    searchEverywhereOpen,
    searchEverywhereMode,
    recentFilesOpen,
    recentAdvanceNonce,
    recentEntries,
    structureOpen,
    structureLoading,
    structureUnavailable,
    structureSymbols,
    quickDocOpen,
    quickDocContent,
    pinnedDoc,
    pinnedDocLocked,
    locationPeek,
    searchFocusNonce,
    searchIncludePreset,
    searchQueryPreset,
    openOrder,
    activeKey,
    editorGroups,
    activeEditorGroupId,
    splitOrientation,
    markdownModes,
    treeFilter,
    treeViewMode,
    expandedRootIds,
    expandedDirKeys,
    treeSelection: selected,
    openFiles,
    lspFiles,
  } = workspaceUi;

  const expandedRoots = useMemo(() => new Set(expandedRootIds), [expandedRootIds]);
  const expandedDirs = useMemo(() => new Set(expandedDirKeys), [expandedDirKeys]);
  // Refs declared early so store-backed setters can dual-write latest maps synchronously.
  const openFilesRef = useRef(openFiles);
  const openOrderRef = useRef(openOrder);
  const lspFilesRef = useRef(lspFiles);
  /** False after unmount so async project-diagnostics callbacks skip setState. */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const pendingEditorTextByFileRef = useRef(new Map<string, OpenFileState>());
  const pendingEditorTextTimerRef = useRef<number | null>(null);
  /** Debounced didChange timers keyed by open-file key (live buffer path). */
  const liveLspSyncTimersRef = useRef<Record<string, number>>({});

  const setBottomDockOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).bottomDockOpen;
    patchWorkspaceUi(workspaceInstanceId, { bottomDockOpen: typeof open === "function" ? open(prev) : open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setBottomDockTab = useCallback((tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).bottomDockTab;
    patchWorkspaceUi(workspaceInstanceId, { bottomDockTab: typeof tab === "function" ? tab(prev) : tab });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setLanguagePanelOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).languagePanelOpen;
    patchWorkspaceUi(workspaceInstanceId, {
      languagePanelOpen: typeof open === "function" ? open(prev) : open,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const projectPanelRef = useRef<PanelImperativeHandle>(null);
  const lastProjectPanelSizeRef = useRef(24);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const lastRightPanelSizeRef = useRef(20);
  const setRightPaneOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).rightPaneOpen;
    patchWorkspaceUi(workspaceInstanceId, { rightPaneOpen: typeof open === "function" ? open(prev) : open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRightPaneTab = useCallback((tab: RightPaneTabId) => {
    patchWorkspaceUi(workspaceInstanceId, { rightPaneTab: tab });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchEverywhereOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchEverywhereMode = useCallback((mode: SearchEverywhereMode) => {
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereMode: mode });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentFilesOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { recentFilesOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentAdvanceNonce = useCallback((updater: number | ((prev: number) => number)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).recentAdvanceNonce;
    patchWorkspaceUi(workspaceInstanceId, {
      recentAdvanceNonce: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentEntries = useCallback((entries: RecentFileEntry[]) => {
    patchWorkspaceUi(workspaceInstanceId, { recentEntries: entries });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { structureOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureLoading = useCallback((loading: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { structureLoading: loading });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureUnavailable = useCallback((reason: string | null) => {
    patchWorkspaceUi(workspaceInstanceId, { structureUnavailable: reason });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureSymbols = useCallback((symbols: LspDocumentSymbol[]) => {
    patchWorkspaceUi(workspaceInstanceId, { structureSymbols: symbols });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setQuickDocOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { quickDocOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setQuickDocContent = useCallback((content: QuickDocContent | null) => {
    patchWorkspaceUi(workspaceInstanceId, { quickDocContent: content });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setPinnedDoc = useCallback((content: QuickDocContent | null) => {
    patchWorkspaceUi(workspaceInstanceId, { pinnedDoc: content });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setPinnedDocLocked = useCallback((locked: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { pinnedDocLocked: locked });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setLocationPeek = useCallback((peek: LocationPeekState | null) => {
    patchWorkspaceUi(workspaceInstanceId, { locationPeek: peek });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchFocusNonce = useCallback((updater: number | ((prev: number) => number)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchFocusNonce;
    patchWorkspaceUi(workspaceInstanceId, {
      searchFocusNonce: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchIncludePreset = useCallback((
    updater: { value: string; nonce: number } | ((prev: { value: string; nonce: number }) => { value: string; nonce: number }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchIncludePreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchIncludePreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchQueryPreset = useCallback((
    updater: { value: string; nonce: number } | ((prev: { value: string; nonce: number }) => { value: string; nonce: number }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchQueryPreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchQueryPreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setOpenOrder = useCallback((order: string[] | ((prev: string[]) => string[])) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openOrder;
    setStoreOpenOrder(workspaceInstanceId, typeof order === "function" ? order(prev) : order);
  }, [setStoreOpenOrder, workspaceInstanceId]);
  const setActiveKey = useCallback((key: string | null | ((prev: string | null) => string | null)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).activeKey;
    setStoreActiveKey(workspaceInstanceId, typeof key === "function" ? key(prev) : key);
  }, [setStoreActiveKey, workspaceInstanceId]);
  const updateEditorGroup = useCallback((
    groupId: EditorGroupId,
    updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState),
  ) => {
    updateStoreEditorGroup(workspaceInstanceId, groupId, updater);
  }, [updateStoreEditorGroup, workspaceInstanceId]);
  const activateEditorGroup = useCallback((groupId: EditorGroupId) => {
    setStoreActiveEditorGroup(workspaceInstanceId, groupId);
  }, [setStoreActiveEditorGroup, workspaceInstanceId]);
  const setMarkdownModes = useCallback((
    updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).markdownModes;
    const next = typeof updater === "function" ? updater(prev) : updater;
    patchWorkspaceUi(workspaceInstanceId, { markdownModes: next });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setTreeFilter = useCallback((value: string) => {
    patchWorkspaceUi(workspaceInstanceId, { treeFilter: value });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setSelected = useCallback((selection: TreeSelection | null) => {
    patchWorkspaceUi(workspaceInstanceId, { treeSelection: selection });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setExpandedRoots = useCallback((
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).expandedRootIds);
    const next = typeof updater === "function" ? updater(prev) : updater;
    updateStoreExpandedRootIds(workspaceInstanceId, [...next]);
  }, [updateStoreExpandedRootIds, workspaceInstanceId]);

  const setExpandedDirs = useCallback((
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).expandedDirKeys);
    const next = typeof updater === "function" ? updater(prev) : updater;
    updateStoreExpandedDirKeys(workspaceInstanceId, [...next]);
  }, [updateStoreExpandedDirKeys, workspaceInstanceId]);

  const flushPendingEditorText = useCallback(() => {
    if (pendingEditorTextTimerRef.current !== null) {
      window.clearTimeout(pendingEditorTextTimerRef.current);
      pendingEditorTextTimerRef.current = null;
    }
    const pending = pendingEditorTextByFileRef.current;
    if (pending.size === 0) return;
    const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    let next = current;
    for (const [key, file] of pending) {
      // A close/reload may have removed the buffer while its input callback
      // was queued. Do not resurrect it.
      if (!(key in current) || current[key] === file) continue;
      if (next === current) next = { ...current };
      next[key] = file;
    }
    pending.clear();
    if (next === current) return;
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
  }, [updateStoreOpenFiles, workspaceInstanceId]);
  const setOpenFiles = useCallback((
    updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>),
  ) => {
    // External operations (save, reload, rename, close, WorkspaceEdit) need
    // a coherent current buffer, so they flush any in-progress typing first.
    flushPendingEditorText();
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
  }, [flushPendingEditorText, updateStoreOpenFiles, workspaceInstanceId]);

  useEffect(() => () => {
    // Capture this workspace's flush callback in the effect closure. A tab can
    // be rebound to a different workspace without unmounting, and a ref read
    // during cleanup would then point at the new instance.
    flushPendingEditorText();
    for (const timer of Object.values(liveLspSyncTimersRef.current)) {
      window.clearTimeout(timer);
    }
    liveLspSyncTimersRef.current = {};
    disposeWorkspaceUi(workspaceInstanceId);
  }, [disposeWorkspaceUi, flushPendingEditorText, workspaceInstanceId]);

  const setLspFiles = useCallback((
    updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).lspFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    lspFilesRef.current = next;
    updateStoreLspFiles(workspaceInstanceId, next);
  }, [updateStoreLspFiles, workspaceInstanceId]);

  const [codeViewProfile, setCodeViewProfileState] = useState<CodeViewProfile>(() => loadCodeViewProfile());
  const [treeFontSize, setTreeFontSizeState] = useState(() => readCodeWorkspaceTreeFontSize());
  const [roots, setRoots] = useState<CodeWorkspaceRootInfo[]>(() => initialRoots(workspace));
  const [looseFiles, setLooseFiles] = useState<CodeWorkspaceLooseFileInfo[]>(() => initialLooseFiles(workspace));
  const {
    directories,
    compactChains,
    flatFiles,
    loadDir,
    loadFlatFiles,
    reset: resetTreeData,
    removeRoot: removeTreeDataRoot,
  } = useWorkspaceTreeData({
    roots,
    expandedRootIds: expandedRoots,
    treeViewMode,
    treeFilter,
    onError: setStatusMessage,
  });
  const {
    gitRoots,
    gitRootsLoading,
    gitSnapshots,
    notifyWorkspacePathGitChanged,
  } = useWorkspaceGitSnapshots({
    roots,
    onError: setStatusMessage,
  });
  const [revealTarget, setRevealTarget] = useState<EditorRevealTarget | null>(null);
  // Editor keys whose library sources are being fetched (drives the button spinner).
  const [downloadingSourcesKeys, setDownloadingSourcesKeys] = useState<string[]>([]);
  const [cursorPositions, setCursorPositions] = useState<Record<EditorGroupId, LspPosition>>({
    primary: { line: 0, character: 0 },
    secondary: { line: 0, character: 0 },
  });
  const [viewportRanges, setViewportRanges] = useState<Record<EditorGroupId, LspRange | null>>({
    primary: null,
    secondary: null,
  });
  const [highlightsByGroup, setHighlightsByGroup] = useState<Record<EditorGroupId, LspDocumentHighlight[]>>({
    primary: [],
    secondary: [],
  });
  const [inlayHintsByGroup, setInlayHintsByGroup] = useState<Record<EditorGroupId, LspInlayHint[]>>({
    primary: [],
    secondary: [],
  });
  const [semanticTokensByGroup, setSemanticTokensByGroup] = useState<Record<EditorGroupId, LspSemanticToken[]>>({
    primary: [],
    secondary: [],
  });
  const [gitHeadTextByFile, setGitHeadTextByFile] = useState<Record<string, { sourceKey: string; text: string | null }>>({});
  const [gitBlameByGroup, setGitBlameByGroup] = useState<Record<EditorGroupId, GitBlameLine | null>>({
    primary: null,
    secondary: null,
  });
  const [intelligencePreferences, setIntelligencePreferencesState] = useState<WorkspaceIntelligencePreferences>(
    () => readWorkspaceIntelligencePreferences(workspaceInstanceId),
  );
  const [breadcrumbSymbolsByGroup, setBreadcrumbSymbolsByGroup] = useState<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  const [referencesResult, setReferencesResult] = useState<ReferencesResultState>({
    loading: false,
    origin: null,
    locations: [],
    error: null,
  });
  const [callHierarchyRoot, setCallHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const [typeHierarchyRoot, setTypeHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const setIntelligencePreferences = useCallback((
    update: WorkspaceIntelligencePreferences
      | ((current: WorkspaceIntelligencePreferences) => WorkspaceIntelligencePreferences),
  ) => {
    setIntelligencePreferencesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      writeWorkspaceIntelligencePreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);
  // Library sources opened from the language server (JDK / dependency classes),
  // keyed by editor key so a closed tab can be re-fetched from history.
  const libraryBuffersRef = useRef<Record<string, LibraryBufferInfo>>({});
  const codeViewProfileRef = useRef(codeViewProfile);
  const treeFontSizeRef = useRef(treeFontSize);
  const gitHeadRequestsRef = useRef(new Set<string>());
  const gitBlameCacheRef = useRef(new Map<string, GitBlameLine | null>());
  // Incremented for each active-buffer revision.  Async LSP responses capture
  // this value so an older response can never repaint a newer buffer.
  const lspDocumentEpochRef = useRef<Record<string, number>>({});
  const revealNonceRef = useRef(0);
  const editorSelectionRef = useRef<EditorSelectionRange>({
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
    empty: true,
    text: "",
    rect: null,
  });
  const [editorAiSelection, setEditorAiSelection] = useState<EditorSelectionRange | null>(null);
  const [aiRewriteState, setAiRewriteState] = useState<{
    key: string;
    path: string;
    original: string;
    proposal: string;
    instruction: string;
    range: EditorSelectionRange;
  } | null>(null);
  const workspaceCommandRunnerRef = useRef<(commandId: string, context?: WorkspaceCommandContext) => boolean>(() => false);
  const goToTypeDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToImplementationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const renameSymbolRef = useRef<() => Promise<void>>(async () => {});
  const initialOpenedKeyRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLElement | null>(null);
  const editorPaneRef = useRef<HTMLElement | null>(null);
  const inactiveEditorPaneRef = useRef<HTMLElement | null>(null);
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);
  const runPanelRef = useRef<RunPanelHandle | null>(null);

  /** Run a workspace task in the integrated terminal (shared by Run + Build panels). */
  const runWorkspaceTask = useCallback(
    (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => {
      terminalDockRef.current?.runCommand(
        task.command,
        task.cwd,
        `Run: ${task.label}`,
        onExit,
      );
      setBottomDockTab("terminal");
      setBottomDockOpen(true);
    },
    [setBottomDockOpen, setBottomDockTab],
  );
  const {
    descriptorForFile: lspDescriptorForFile,
    descriptorForPath: lspDescriptorForPath,
    isDocumentSynced: isLspDocumentSynced,
    syncDocument: syncLspDocument,
    saveDocument: saveLspDocument,
    closeDocument: closeLspDocument,
    updateStatus: updateLspStatusForFile,
  } = useWorkspaceLspSession({
    workspaceInstanceId,
    roots,
    openFilesRef,
    updateLspFiles: setLspFiles,
    onError: setStatusMessage,
  });
  const treePaneStyle = useMemo(() => ({
    "--taomni-code-tree-font-size": `${treeFontSize}px`,
    "--taomni-code-tree-small-font-size": `${Math.max(10, treeFontSize - 1)}px`,
    "--taomni-code-tree-row-height": `${Math.max(24, treeFontSize + 15)}px`,
  }) as CSSProperties, [treeFontSize]);
  const editorPaneStyle = useMemo(() => ({
    "--taomni-code-editor-ui-font-size": `${codeViewProfile.fontSize}px`,
    "--taomni-code-editor-ui-small-font-size": `${Math.max(10, codeViewProfile.fontSize - 2)}px`,
    "--taomni-code-editor-tab-height": `${Math.max(28, codeViewProfile.fontSize + 15)}px`,
  }) as CSSProperties, [codeViewProfile.fontSize]);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    looseFilesRef.current = looseFiles;
  }, [looseFiles]);

  useEffect(() => {
    // Store-backed openFiles can lag the live editor buffer while typing is
    // batched. Never clobber pending keystrokes with a stale store snapshot —
    // that used to drop mid-edit text right as completion asked for a sync.
    if (pendingEditorTextByFileRef.current.size === 0) {
      openFilesRef.current = openFiles;
      return;
    }
    const merged = { ...openFiles };
    for (const [key, file] of pendingEditorTextByFileRef.current) {
      if (key in merged) merged[key] = file;
    }
    openFilesRef.current = merged;
  }, [openFiles]);

  useEffect(() => {
    openOrderRef.current = openOrder;
  }, [openOrder]);

  useEffect(() => {
    lspFilesRef.current = lspFiles;
  }, [lspFiles]);

  useEffect(() => {
    codeViewProfileRef.current = codeViewProfile;
  }, [codeViewProfile]);

  useEffect(() => {
    treeFontSizeRef.current = treeFontSize;
  }, [treeFontSize]);

  const updateCodeViewProfile = useCallback(
    (
      updater: CodeViewProfile | ((current: CodeViewProfile) => CodeViewProfile),
      statusMessage?: (profile: CodeViewProfile) => string,
    ) => {
      // Base the change on the freshly-persisted profile rather than local state
      // so a zoom here never clobbers a theme/font the user just picked in
      // Settings → Code View Appearance.
      const current = loadCodeViewProfile();
      const next = normalizeCodeViewProfile(
        typeof updater === "function" ? updater(current) : updater,
      );
      codeViewProfileRef.current = next;
      setCodeViewProfileState(next);
      saveCodeViewProfile(next);
      applyCodeViewProfile(next, DEFAULT_TERMINAL_PROFILE);
      if (statusMessage) setStatusMessage(statusMessage(next));
    },
    [setStatusMessage],
  );

  // Follow code-view appearance edits made elsewhere (Settings, another window)
  // so the workspace shares one theme/font with the Git diff view instead of
  // owning its own copy.
  useEffect(() => {
    return subscribeCodeViewProfile((incoming) => {
      if (sameCodeViewProfile(incoming, codeViewProfileRef.current)) return;
      codeViewProfileRef.current = incoming;
      setCodeViewProfileState(incoming);
      applyCodeViewProfile(incoming, DEFAULT_TERMINAL_PROFILE);
    });
  }, []);

  const setCodeViewFontSize = useCallback(
    (size: number) => {
      updateCodeViewProfile(
        (current) => ({ ...current, fontSize: clampCodeWorkspaceFontSize(size) }),
        (next) => `Code workspace zoom ${next.fontSize}px`,
      );
    },
    [updateCodeViewProfile],
  );

  const stepCodeViewFontSize = useCallback(
    (delta: number) => {
      setCodeViewFontSize(codeViewProfileRef.current.fontSize + delta);
    },
    [setCodeViewFontSize],
  );

  const setTreeFontSize = useCallback(
    (size: number) => {
      const next = clampCodeWorkspaceTreeFontSize(size);
      treeFontSizeRef.current = next;
      setTreeFontSizeState(next);
      writeCodeWorkspaceTreeFontSize(next);
      setStatusMessage(`File tree zoom ${next}px`);
    },
    [setStatusMessage],
  );

  const stepTreeFontSize = useCallback(
    (delta: number) => {
      setTreeFontSize(treeFontSizeRef.current + delta);
    },
    [setTreeFontSize],
  );

  const setTreeViewMode = useCallback((mode: TreeViewMode) => {
    patchWorkspaceUi(workspaceInstanceId, { treeViewMode: mode });
    writeCodeWorkspaceTreeViewMode(mode);
    setStatusMessage(`File tree view: ${mode}`);
  }, [patchWorkspaceUi, setStatusMessage, workspaceInstanceId]);

  const zoomTargetForNode = useCallback((target: EventTarget | null): "tree" | "editor" => {
    const node = target instanceof Node ? target : null;
    if (node && treePaneRef.current?.contains(node)) return "tree";
    return "editor";
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const increase =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      const reset =
        event.key === "0" ||
        event.code === "Digit0" ||
        event.code === "Numpad0";

      if (!increase && !decrease && !reset) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (increase) {
          stepTreeFontSize(1);
        } else if (decrease) {
          stepTreeFontSize(-1);
        } else {
          setTreeFontSize(CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE);
        }
      } else if (increase) {
        stepCodeViewFontSize(1);
      } else if (decrease) {
        stepCodeViewFontSize(-1);
      } else {
        setCodeViewFontSize(DEFAULT_CODE_VIEW_PROFILE.fontSize);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [setCodeViewFontSize, setTreeFontSize, stepCodeViewFontSize, stepTreeFontSize, visible, zoomTargetForNode]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (event.deltaY < 0) {
          stepTreeFontSize(1);
        } else if (event.deltaY > 0) {
          stepTreeFontSize(-1);
        }
      } else if (event.deltaY < 0) {
        stepCodeViewFontSize(1);
      } else if (event.deltaY > 0) {
        stepCodeViewFontSize(-1);
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [stepCodeViewFontSize, stepTreeFontSize, visible, zoomTargetForNode]);

  const findRoot = useCallback((rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null, []);

  const openFile = useCallback(
    async (ref: CodeWorkspaceFileRef, options: { preview?: boolean; groupId?: EditorGroupId } = {}) => {
      // Switching tabs before the input idle timer fires must never show an
      // older buffer snapshot in the newly activated editor.
      flushPendingEditorText();
      const key = fileKey(ref);
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const groupId = options.groupId ?? currentUi.activeEditorGroupId;
      updateEditorGroup(groupId, (group) => {
        const alreadyOpen = group.openOrder.includes(key);
        let nextOrder = group.openOrder;
        let previewKey = group.previewKey;
        if (!alreadyOpen) {
          if (options.preview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
            nextOrder = nextOrder.filter((entry) => entry !== previewKey);
          }
          nextOrder = [...nextOrder, key];
        }
        if (options.preview) {
          previewKey = group.pinnedKeys.includes(key) ? null : key;
        } else if (previewKey === key) {
          previewKey = null;
        }
        return { ...group, openOrder: nextOrder, activeKey: key, previewKey };
      });
      if (groupId !== currentUi.activeEditorGroupId) activateEditorGroup(groupId);
      if (openFilesRef.current[key] && !openFilesRef.current[key].loading) return;
      // Library sources (JDK / dependency classes) have no file to read: ask the
      // language server again so history and Recent Files can reopen them.
      const library = libraryBuffersRef.current[key];
      if (library) {
        setOpenFiles((current) => ({
          ...current,
          [key]: current[key] ?? { ...makeLibraryFile(library, ""), loading: true },
        }));
        try {
          const contents = await lspReadUriContents(
            lspDescriptorForPath(library.originRootPath, library.originFilePath),
            library.uri,
          );
          const info: LibraryBufferInfo = {
            ...library,
            title: contents.title || library.title,
            container: contents.container ?? library.container,
            languageId: contents.languageId || library.languageId,
            decompiled: contents.decompiled,
          };
          libraryBuffersRef.current[key] = info;
          setOpenFiles((current) => ({ ...current, [key]: makeLibraryFile(info, contents.text) }));
          setStatusMessage(`Opened ${info.title}`);
        } catch (err) {
          const message = errorMessage(err);
          setOpenFiles((current) => ({
            ...current,
            [key]: {
              ...(current[key] ?? makeLibraryFile(library, "")),
              loading: false,
              error: message,
            },
          }));
          setStatusMessage(message);
        }
        return;
      }
      setOpenFiles((current) => ({
        ...current,
        [key]: current[key] ?? makeLoadingFile(ref, rootsRef.current, looseFilesRef.current),
      }));
      try {
        const file = ref.kind === "root"
          ? await workspaceReadFile(findRoot(ref.rootId)?.path ?? "", ref.path)
          : await workspaceReadLooseFile(ref.path);
        const nextRef = ref.kind === "root" ? { ...ref, path: file.path } : { ...ref, path: file.path };
        const meta = fileMeta(nextRef, rootsRef.current, looseFilesRef.current);
        // CodeMirror normalizes to LF; keep buffer + dirty compare on LF and
        // remember original EOL so save restores CRLF/CR on Windows files.
        const normalized = normalizeEditorText(file.text);
        setOpenFiles((current) => {
          const next = { ...current };
          if (fileKey(nextRef) !== key) delete next[key];
          next[fileKey(nextRef)] = {
            ref: nextRef,
            key: fileKey(nextRef),
            path: meta.path,
            title: meta.title,
            subtitle: meta.subtitle,
            languagePath: meta.languagePath,
            text: normalized.text,
            savedText: normalized.text,
            eol: normalized.eol,
            hash: file.hash,
            mtime: file.mtime,
            size: file.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          };
          return next;
        });
        updateEditorGroup(groupId, (group) => ({
          ...group,
          openOrder: group.openOrder.map((item) => (item === key ? fileKey(nextRef) : item)),
          activeKey: group.activeKey === key ? fileKey(nextRef) : group.activeKey,
          previewKey: group.previewKey === key ? fileKey(nextRef) : group.previewKey,
          pinnedKeys: group.pinnedKeys.map((item) => (item === key ? fileKey(nextRef) : item)),
        }));
        setStatusMessage(`Opened ${meta.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? makeLoadingFile(ref, rootsRef.current, looseFilesRef.current)),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [
      activateEditorGroup,
      findRoot,
      flushPendingEditorText,
      lspDescriptorForPath,
      setStatusMessage,
      updateEditorGroup,
      workspaceInstanceId,
    ],
  );

  const revealNavLocation = useCallback((key: string, position: { line: number; character: number }) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: position.line,
      character: position.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  const {
    navCan,
    goToFileItems,
    goToFileLoading,
    goToFileTruncated,
    openSearchEverywhere,
    openGoToFileItem,
    navigateHistory,
    recordNavigationLocation,
    suppressNextHistoryRecord,
    noteCaretPosition,
    openRecentFiles,
    pickRecentFile,
  } = useWorkspaceNavigation({
    workspaceInstanceId,
    activeKey,
    roots,
    flatFiles,
    visible,
    rootsRef,
    looseFilesRef,
    openFilesRef,
    loadFlatFiles,
    openFile,
    revealLocation: revealNavLocation,
    setSearchEverywhereMode,
    setSearchEverywhereOpen,
    setRecentEntries,
    setRecentFilesOpen,
  });

  const openFindInFiles = useCallback(() => {
    setBottomDockOpen(true);
    setBottomDockTab("search");
    setSearchFocusNonce((nonce) => nonce + 1);
  }, []);

  const findInDirectory = useCallback((path: string) => {
    setBottomDockOpen(true);
    setBottomDockTab("search");
    setSearchIncludePreset((current) => ({
      value: path ? `${path}/**` : "",
      nonce: current.nonce + 1,
    }));
  }, []);

  const openTerminalAt = useCallback((rootId: string, path: string, pathIsFile = false) => {
    const root = findRoot(rootId);
    if (!root) return;
    const relativeDirectory = pathIsFile ? parentPath(path) : path;
    const cwd = absoluteWorkspacePath(root, relativeDirectory);
    setBottomDockTab("terminal");
    setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, relativeDirectory ? basename(relativeDirectory) : root.name);
  }, [findRoot]);

  useEffect(() => {
    if (layoutRestoredOpenFilesRef.current) {
      const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
      if (!snapshot) {
        layoutRestoredOpenFilesRef.current = false;
      } else {
        const keys = uniqueOrderedKeys(snapshot.editorGroups);
        if (keys.length === 0) {
          layoutRestoredOpenFilesRef.current = false;
        } else {
          if (initialOpenedKeyRef.current === `restored:${workspaceInstanceId}`) return;
          initialOpenedKeyRef.current = `restored:${workspaceInstanceId}`;
          for (const groupId of ["primary", "secondary"] as const) {
            const group = snapshot.editorGroups[groupId];
            for (const key of group.openOrder) {
              const ref = fileRefFromFileKey(key, looseFiles);
              if (!ref) continue;
              void openFile(ref, {
                groupId,
                preview: group.previewKey === key,
              });
            }
          }
          return;
        }
      }
    }
    const ref = initialFileRef(workspace, roots, looseFiles);
    if (!ref) return;
    const key = fileKey(ref);
    if (initialOpenedKeyRef.current === key) return;
    initialOpenedKeyRef.current = key;
    void openFile(ref);
  }, [looseFiles, openFile, roots, workspace, workspaceInstanceId]);

  useEffect(() => {
    if (!workspaceInstanceId) return;
    const timer = window.setTimeout(() => {
      // Library buffers come from a live language server, so they cannot be
      // restored on the next launch — keep them out of the persisted layout.
      const persistableGroups = Object.fromEntries(
        (Object.entries(editorGroups) as Array<[EditorGroupId, typeof editorGroups.primary]>)
          .map(([groupId, group]) => [groupId, {
            ...group,
            openOrder: group.openOrder.filter((key) => !libraryBuffersRef.current[key]),
            pinnedKeys: group.pinnedKeys.filter((key) => !libraryBuffersRef.current[key]),
            activeKey: group.activeKey && libraryBuffersRef.current[group.activeKey]
              ? null
              : group.activeKey,
            previewKey: group.previewKey && libraryBuffersRef.current[group.previewKey]
              ? null
              : group.previewKey,
          }]),
      ) as typeof editorGroups;
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, snapshotFromWorkspaceUi({
        bottomDockOpen,
        bottomDockTab,
        rightPaneOpen,
        rightPaneTab,
        languagePanelOpen,
        splitOrientation,
        activeEditorGroupId,
        expandedRootIds,
        expandedDirKeys,
        editorGroups: persistableGroups,
      }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeEditorGroupId,
    bottomDockOpen,
    bottomDockTab,
    editorGroups,
    expandedDirKeys,
    expandedRootIds,
    languagePanelOpen,
    rightPaneOpen,
    rightPaneTab,
    splitOrientation,
    workspaceInstanceId,
  ]);

  const {
    selectedRootDirectory,
    copyTreePath,
    addRoot,
    addLooseFilePath,
    openLooseFile,
    refreshTree,
    toggleRoot,
    toggleDir,
    createFile,
    createDir,
    renameSelected,
    deleteSelected,
    revealInExplorer,
    stageTreeClipboard,
    canPasteTreeClipboard,
    pasteTreeClipboard,
    ignoreWorkspacePath,
  } = useWorkspaceFileActions({
    roots,
    gitRoots,
    selected,
    activeKey,
    openFiles,
    directories,
    expandedRoots,
    expandedDirs,
    treeViewMode,
    rootsRef,
    looseFilesRef,
    openFilesRef,
    openOrderRef,
    setRoots,
    setLooseFiles,
    setSelected,
    setExpandedRoots,
    setExpandedDirs,
    setOpenFiles,
    setOpenOrder,
    setActiveKey,
    loadDir,
    loadFlatFiles,
    resetTreeData,
    removeTreeDataRoot,
    openFile,
    notifyWorkspacePathGitChanged,
    onStatus: setStatusMessage,
  });

  const {
    show: openTreeContextMenu,
    showAt: openTreeContextMenuAt,
    render: treeContextMenu,
  } = useContextMenu();
  const {
    showAt: openEditorContextMenuAt,
    render: editorContextMenu,
  } = useContextMenu();

  const copyEditorTabPath = useCallback(async (key: string, absolute: boolean) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.ref.kind === "root") {
      await copyTreePath(file.ref.rootId, file.ref.path, absolute);
      return;
    }
    const text = absolute ? normalizeFsPath(file.ref.path) : basename(file.ref.path);
    try {
      await writeText(text);
      setStatusMessage(`Copied ${text}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [copyTreePath, setStatusMessage]);

  const revealEditorTabInTree = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    setSelected({ kind: "file", ref: file.ref });
    if (file.ref.kind !== "root") return;
    const rootId = file.ref.rootId;
    setExpandedRoots((current) => new Set(current).add(rootId));
    const directories = file.ref.path.split("/").filter(Boolean).slice(0, -1);
    setExpandedDirs((current) => {
      const next = new Set(current);
      let path = "";
      for (const directory of directories) {
        path = path ? `${path}/${directory}` : directory;
        next.add(rootDirKey(rootId, path));
        void loadDir(rootId, path);
      }
      return next;
    });
    treePaneRef.current?.focus();
  }, [loadDir]);

  const revealEditorTabInExplorer = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a library source with no file on disk`);
      return;
    }
    if (file.ref.kind === "root") {
      void revealInExplorer(file.ref.rootId, file.ref.path);
      return;
    }
    const absolute = normalizeFsPath(file.ref.path);
    void invoke("sftp_open_path", { path: absolute })
      .then(() => setStatusMessage(`Opened ${absolute}`))
      .catch((err) => setStatusMessage(errorMessage(err)));
  }, [revealInExplorer, setStatusMessage]);

  /**
   * IDEA-style breadcrumb: list children of a directory/root segment, or siblings
   * when the file segment is clicked. Marks the trail's next segment as active.
   */
  const loadBreadcrumbPathChildren = useCallback(async (
    segment: BreadcrumbPathSegment,
    file: OpenFileState,
    trail: BreadcrumbPathSegment[],
  ): Promise<BreadcrumbPathChild[]> => {
    const segmentIndex = trail.findIndex((item) =>
      item.path === segment.path && item.kind === segment.kind && item.label === segment.label
    );
    // Nothing to browse inside a JAR / decompiled class.
    if (file.library) return [];
    const nextSegment = segmentIndex >= 0 ? trail[segmentIndex + 1] ?? null : null;
    const activeChildPath = nextSegment && nextSegment.kind !== "root" ? nextSegment.path : null;

    const toChildren = (
      entries: Array<{ name: string; path: string; fileType: string; isHidden?: boolean }>,
      pathOf: (entry: { name: string; path: string }) => string,
    ): BreadcrumbPathChild[] => entries
      .filter((entry) => entry.fileType === "file" || entry.fileType === "dir")
      .filter((entry) => !shouldHideEntry({
        name: entry.name,
        path: entry.path,
        fileType: entry.fileType as "file" | "dir" | "symlink" | "other",
        size: 0,
        mtime: 0,
        isHidden: entry.isHidden ?? false,
      }))
      .map((entry) => {
        const path = pathOf(entry);
        const kind = entry.fileType === "dir" ? "directory" as const : "file" as const;
        return {
          label: entry.name,
          path,
          kind,
          active: activeChildPath === path,
        };
      });

    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      const root = rootsRef.current.find((item) => item.id === rootId);
      if (!root) return [];
      // File segment → siblings in parent; directory/root → children of that path.
      const listPath = segment.kind === "file" ? parentPath(segment.path) : segment.path;
      void loadDir(rootId, listPath);
      const entries = await workspaceListDir(root.path, listPath);
      return toChildren(entries, (entry) => entry.path);
    }

    // Loose file: list an absolute directory via workspace_list_dir(dir, "").
    const absolute = normalizeFsPath(segment.path);
    const dirToList = segment.kind === "file" ? parentPath(absolute) : absolute;
    if (!dirToList) return [];
    const entries = await workspaceListDir(dirToList, "");
    return toChildren(entries, (entry) =>
      normalizeFsPath(`${dirToList.replace(/[/\\]+$/, "")}/${entry.name}`)
    );
  }, [loadDir]);

  const navigateBreadcrumbPathChild = useCallback((
    child: BreadcrumbPathChild,
    file: OpenFileState,
  ) => {
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      if (child.kind === "directory") {
        setSelected({ kind: "dir", rootId, path: child.path });
        setExpandedRoots((current) => new Set(current).add(rootId));
        setExpandedDirs((current) => {
          const next = new Set(current);
          let acc = "";
          for (const part of child.path.split("/").filter(Boolean)) {
            acc = acc ? `${acc}/${part}` : part;
            next.add(rootDirKey(rootId, acc));
          }
          return next;
        });
        void loadDir(rootId, child.path);
        treePaneRef.current?.focus();
        return;
      }
      void openFile({ kind: "root", rootId, path: child.path });
      return;
    }
    // Loose file sibling/parent navigation: open absolute path as a loose file.
    if (child.kind === "file") {
      void addLooseFilePath(child.path);
      return;
    }
    setStatusMessage(`Folder: ${child.path}`);
  }, [addLooseFilePath, loadDir, openFile, setStatusMessage]);

  const breadcrumbPathActions = useCallback((
    segment: BreadcrumbPathSegment,
    file: OpenFileState,
  ): BreadcrumbPathAction[] => {
    // Copy path / reveal / open-in-terminal make no sense for a class inside a JAR.
    if (file.library) return [];
    const actions: BreadcrumbPathAction[] = [];
    actions.push({
      id: "reveal-tree",
      label: "Select in Project Tree",
      onSelect: () => {
        if (file.ref.kind !== "root") {
          setSelected({ kind: "file", ref: file.ref });
          treePaneRef.current?.focus();
          return;
        }
        const rootId = file.ref.rootId;
        if (segment.kind === "root") {
          setSelected({ kind: "root", rootId });
          setExpandedRoots((current) => new Set(current).add(rootId));
        } else if (segment.kind === "directory") {
          setSelected({ kind: "dir", rootId, path: segment.path });
          setExpandedRoots((current) => new Set(current).add(rootId));
          setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
          void loadDir(rootId, segment.path);
        } else {
          setSelected({ kind: "file", ref: file.ref });
          revealEditorTabInTree(file.key);
          return;
        }
        treePaneRef.current?.focus();
      },
    });
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      actions.push({
        id: "copy-path",
        label: "Copy Path",
        onSelect: () => { void copyTreePath(rootId, segment.path, true); },
      });
      actions.push({
        id: "copy-relative",
        label: "Copy Relative Path",
        onSelect: () => { void copyTreePath(rootId, segment.path, false); },
      });
      actions.push({
        id: "reveal-explorer",
        label: "Reveal in Explorer",
        onSelect: () => { void revealInExplorer(rootId, segment.path); },
      });
    } else {
      const absolute = normalizeFsPath(segment.path);
      actions.push({
        id: "copy-path",
        label: "Copy Path",
        onSelect: () => {
          void writeText(absolute)
            .then(() => setStatusMessage(`Copied ${absolute}`))
            .catch((err) => setStatusMessage(errorMessage(err)));
        },
      });
      actions.push({
        id: "reveal-explorer",
        label: "Reveal in Explorer",
        onSelect: () => {
          void invoke("sftp_open_path", { path: absolute })
            .then(() => setStatusMessage(`Opened ${absolute}`))
            .catch((err) => setStatusMessage(errorMessage(err)));
        },
      });
    }
    return actions;
  }, [copyTreePath, loadDir, revealEditorTabInTree, revealInExplorer, setStatusMessage]);

  const openEditorTabInTerminal = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a library source with no directory on disk`);
      return;
    }
    if (file.ref.kind === "root") {
      openTerminalAt(file.ref.rootId, file.ref.path, true);
      return;
    }
    const cwd = parentPath(normalizeFsPath(file.ref.path));
    setBottomDockTab("terminal");
    setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, basename(cwd));
  }, [openTerminalAt, setStatusMessage]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const pane = treePaneRef.current;
    if (!pane) return;
    // Ignore when typing in the filter input.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const rows = Array.from(pane.querySelectorAll<HTMLElement>(
      "[data-testid='code-workspace-tree-root'], [data-testid='code-workspace-tree-dir'], [data-testid='code-workspace-tree-file'], [data-testid='code-workspace-flat-file']",
    ));
    if (rows.length === 0) return;
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.dataset.selected === "true"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? Math.min(rows.length - 1, selectedIndex + 1)
        : Math.max(0, selectedIndex - 1);
      rows[next]?.click();
      rows[next]?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (selected?.kind === "file" && (event.ctrlKey || event.metaKey)) {
        const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
        const targetGroupId: EditorGroupId = current.activeEditorGroupId === "primary"
          ? "secondary"
          : "primary";
        setStoreSplitOrientation(workspaceInstanceId, "vertical");
        void openFile(selected.ref, { groupId: targetGroupId });
      } else if (selected?.kind === "file") void openFile(selected.ref);
      else rows[selectedIndex]?.click();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.rename", { focus: "tree", payload: { selection: selected ?? undefined } });
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.delete", { focus: "tree", payload: { selection: selected ?? undefined } });
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Expand/collapse by re-clicking directory/root rows.
      const row = rows[selectedIndex];
      if (!row) return;
      if (row.dataset.testid === "code-workspace-tree-dir" || row.dataset.testid === "code-workspace-tree-root") {
        event.preventDefault();
        row.click();
      }
    }
  }, [openFile, selected, setStoreSplitOrientation, workspaceInstanceId]);

  const showTreeContextMenu = useCallback(
    (event: React.MouseEvent, selection: TreeSelection) => {
      setSelected(selection);
      const run = (commandId: string, payload: WorkspaceTreeCommandPayload) => () => {
        workspaceCommandRunnerRef.current(commandId, { focus: "tree", payload });
      };
      const clipboardItems = (rootId: string, path: string, directory: { rootId: string; path: string }) => [
        {
          label: "Cut",
          onClick: () => stageTreeClipboard("cut", rootId, path),
        },
        {
          label: "Copy",
          onClick: () => stageTreeClipboard("copy", rootId, path),
        },
        {
          label: "Paste",
          disabled: !canPasteTreeClipboard(),
          onClick: () => void pasteTreeClipboard(directory),
        },
      ];
      if (selection.kind === "file" && selection.ref.kind === "root") {
        const ref = selection.ref;
        const dir = parentPath(ref.path);
        openTreeContextMenu(event, [
          { label: "Open", onClick: run("workspace.tree.open", { selection }) },
          { separator: true, label: "" },
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { label: "Add to .gitignore", onClick: run("workspace.tree.addToGitignore", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(ref.rootId, ref.path, { rootId: ref.rootId, path: dir }),
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: ref.rootId, path: ref.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: ref.rootId, path: ref.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(ref.rootId, ref.path),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(ref.rootId, ref.path, true) },
        ]);
        return;
      }
      if (selection.kind === "dir") {
        openTreeContextMenu(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { label: "Add to .gitignore", onClick: run("workspace.tree.addToGitignore", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(selection.rootId, selection.path, { rootId: selection.rootId, path: selection.path }),
          { separator: true, label: "" },
          { label: "Find in Directory...", onClick: run("workspace.tree.findInDirectory", { path: selection.path }) },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: selection.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: selection.rootId, path: selection.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(selection.rootId, selection.path),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(selection.rootId, selection.path) },
        ]);
        return;
      }
      if (selection.kind === "root") {
        openTreeContextMenu(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "Rename Root...", onClick: run("workspace.tree.rename", { selection }) },
          { separator: true, label: "" },
          {
            label: "Paste",
            disabled: !canPasteTreeClipboard(),
            onClick: () => void pasteTreeClipboard({ rootId: selection.rootId, path: "" }),
          },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: "" }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(selection.rootId, ""),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(selection.rootId, "") },
          { separator: true, label: "" },
          { label: "Remove from Workspace", danger: true, onClick: run("workspace.tree.delete", { selection }) },
        ]);
      }
    },
    [
      canPasteTreeClipboard,
      openTerminalAt,
      openTreeContextMenu,
      pasteTreeClipboard,
      revealInExplorer,
      stageTreeClipboard,
    ],
  );

  const updateFileText = useCallback((key: string, text: string) => {
    const file = openFilesRef.current[key];
    if (!file || file.text === text) return;
    const next: OpenFileState = {
      ...file,
      text,
      dirty: text !== file.savedText,
      error: null,
    };
    // Non-editor callers need the updated model immediately (formatting,
    // WorkspaceEdit, reload), so they intentionally bypass the input batch.
    setOpenFiles((current) => ({ ...current, [key]: next }));
  }, [setOpenFiles]);

  const scheduleLiveLspSync = useCallback((key: string) => {
    const existing = liveLspSyncTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    const latestNow = openFilesRef.current[key];
    // Typing only drives didChange for an *already active* session. Missing
    // LSP / failed jdtls never schedules idle open probes from keystrokes.
    if (!latestNow || !shouldLiveSyncLsp(latestNow.languagePath, lspFilesRef.current[key])) {
      return;
    }
    liveLspSyncTimersRef.current[key] = window.setTimeout(() => {
      delete liveLspSyncTimersRef.current[key];
      const latest = openFilesRef.current[key];
      if (!latest || latest.loading) return;
      const lspState = lspFilesRef.current[key];
      if (!shouldLiveSyncLsp(latest.languagePath, lspState)) return;
      if (lspState?.status?.active && isLspDocumentSynced(key, latest.text)) return;
      // Active → change; still-opening → open (coalesced as pending change once active).
      const mode: "open" | "change" = lspState?.status?.active ? "change" : "open";
      void syncLspDocument(latest, mode);
    }, LSP_CHANGE_SYNC_DELAY_MS);
  }, [isLspDocumentSynced, syncLspDocument]);

  const cancelLiveLspSync = useCallback((key: string) => {
    const existing = liveLspSyncTimersRef.current[key];
    if (!existing) return;
    window.clearTimeout(existing);
    delete liveLspSyncTimersRef.current[key];
  }, []);

  /**
   * Bring the language server up to the live editor buffer before a latency-
   * sensitive feature (completion / signature). Bypasses the typing debounce
   * and waits for the in-flight sync queue to drain for this file.
   */
  const ensureLspDocumentSynced = useCallback(async (fileKey: string): Promise<OpenFileState | null> => {
    cancelLiveLspSync(fileKey);
    const kick = () => {
      const latest = openFilesRef.current[fileKey];
      if (!latest || latest.loading) return null;
      const state = lspFilesRef.current[fileKey];
      // Features require an active session; do not open-from-completion on plain text.
      if (!isLspFeatureReady(state)) return null;
      if (isLspDocumentSynced(fileKey, latest.text)) return latest;
      void syncLspDocument(latest, "change");
      return null;
    };
    const ready = kick();
    if (ready) return ready;
    // No active server: do not spin-wait 400ms on every completion keystroke.
    if (!isLspFeatureReady(lspFilesRef.current[fileKey])) return null;
    const deadline = performance.now() + LSP_FEATURE_SYNC_WAIT_MS;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 8);
      });
      const readyAgain = kick();
      if (readyAgain) return readyAgain;
    }
    // Best effort: if the server is active but still catching up, still return
    // the live buffer so the feature request can race (CM will re-query on the
    // next keystroke via isIncomplete / abort-on-doc-change).
    const latest = openFilesRef.current[fileKey];
    if (latest && isLspFeatureReady(lspFilesRef.current[fileKey])) return latest;
    return null;
  }, [cancelLiveLspSync, isLspDocumentSynced, syncLspDocument]);

  const queueEditorTextUpdate = useCallback((key: string, text: string) => {
    const file = openFilesRef.current[key];
    if (!file || file.text === text) return;
    const next: OpenFileState = {
      ...file,
      text,
      dirty: text !== file.savedText,
      error: null,
    };
    // Keep every command/save/LSP call correct immediately, but delay the
    // store publication that causes the surrounding workspace to re-render.
    openFilesRef.current = { ...openFilesRef.current, [key]: next };
    pendingEditorTextByFileRef.current.set(key, next);
    // Drive didChange from the live buffer only when a language server can
    // actually use it — plain text / missing LSP must not pay IPC cost.
    scheduleLiveLspSync(key);
    if (pendingEditorTextTimerRef.current !== null) {
      window.clearTimeout(pendingEditorTextTimerRef.current);
    }
    pendingEditorTextTimerRef.current = window.setTimeout(
      flushPendingEditorText,
      EDITOR_TEXT_COMMIT_IDLE_DELAY_MS,
    );
  }, [flushPendingEditorText, scheduleLiveLspSync]);

  const absolutePathForOpenFile = useCallback((file: OpenFileState): string | null => {
    // Library sources live inside a JAR / the language server, not on disk.
    if (file.library) return null;
    if (file.ref.kind === "loose") return normalizeFsPath(file.ref.path);
    const root = findRoot(file.ref.rootId);
    if (!root) return null;
    return absoluteWorkspacePath(root, file.ref.path);
  }, [findRoot]);

  /**
   * Persist an open buffer with an explicit text payload.
   * Used by WorkspaceEdit for open-clean files (§5.2.9): apply then save.
   * Unlike `saveFile`, this does not require the buffer to already be dirty.
   */
  const [localHistoryTarget, setLocalHistoryTarget] = useState<{ key: string; path: string } | null>(null);

  const openLocalHistoryForKey = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    const absolute = absolutePathForOpenFile(file);
    if (!absolute) {
      setStatusMessage(file.library
        ? `${file.title} is a library source with no local history`
        : "Cannot resolve path for local history");
      return;
    }
    setLocalHistoryTarget({ key, path: absolute });
  }, [absolutePathForOpenFile, setStatusMessage]);

  const restoreLocalHistoryText = useCallback((key: string, text: string) => {
    updateFileText(key, text);
    setStatusMessage("Restored local history snapshot into the editor buffer");
  }, [setStatusMessage, updateFileText]);

  const applySelectionReplacement = useCallback((key: string, range: EditorSelectionRange, nextText: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    const lines = file.text.split("\n");
    const offsetAt = (position: { line: number; character: number }) => {
      let offset = 0;
      for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
        offset += (lines[line]?.length ?? 0) + 1;
      }
      const lineText = lines[Math.min(position.line, Math.max(0, lines.length - 1))] ?? "";
      return offset + Math.min(Math.max(0, position.character), lineText.length);
    };
    const from = offsetAt(range.start);
    const to = offsetAt(range.end);
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const replaced = `${file.text.slice(0, start)}${nextText}${file.text.slice(end)}`;
    updateFileText(key, replaced);
  }, [updateFileText]);

  const handleEditorAiAction = useCallback(async (action: EditorAiAction, text: string) => {
    const selection = editorSelectionRef.current;
    const file = activeKey ? openFilesRef.current[activeKey] ?? null : null;
    if (!file || selection.empty || !text.trim()) return;
    const pathLabel = file.subtitle || file.path;
    if (action === "explain") {
      // explainSelection wraps the payload as terminal output; stage a code-specific prompt instead.
      await attachToComposer([
        `请解释下面这段代码的作用、关键逻辑和潜在问题：`,
        `文件: ${pathLabel}`,
        "",
        "```",
        text,
        "```",
      ].join("\n"));
      setEditorAiSelection(null);
      setStatusMessage("Staged explain request in AI chat");
      return;
    }
    if (action === "fix") {
      const prompt = [
        `请修复下面这段代码中的问题，保持原有意图，并只返回修复后的完整代码块。`,
        `文件: ${pathLabel}`,
        "",
        "```",
        text,
        "```",
      ].join("\n");
      await attachToComposer(prompt);
      setAiRewriteState({
        key: file.key,
        path: pathLabel,
        original: text,
        proposal: text,
        instruction: "Fix issues in the selected code",
        range: selection,
      });
      setEditorAiSelection(null);
      setStatusMessage("Staged fix request in AI chat — paste the result into the proposal or apply after editing");
      return;
    }
    const instruction = "Rewrite the selected code";
    const prompt = [
      `请按指令改写下面的代码，只返回改写后的完整代码块。`,
      `文件: ${pathLabel}`,
      `指令: ${instruction}`,
      "",
      "```",
      text,
      "```",
    ].join("\n");
    await attachToComposer(prompt);
    setAiRewriteState({
      key: file.key,
      path: pathLabel,
      original: text,
      proposal: text,
      instruction,
      range: selection,
    });
    setEditorAiSelection(null);
    setStatusMessage("Staged rewrite request in AI chat");
  }, [activeKey, attachToComposer, setStatusMessage]);

  const saveOpenBufferText = useCallback(async (key: string, textToSave: string) => {
    const file = openFilesRef.current[key];
    if (!file || file.loading) {
      throw new Error("Open buffer is not available to save");
    }
    if (file.library) {
      throw new Error(`${file.title} is a read-only library source`);
    }
    setOpenFiles((current) => ({
      ...current,
      [key]: { ...current[key], text: textToSave, saving: true, error: null },
    }));
    openFilesRef.current = {
      ...openFilesRef.current,
      [key]: { ...file, text: textToSave, saving: true, error: null },
    };
    try {
      // Snapshot the previous on-disk contents before overwrite when available.
      const historyPath = absolutePathForOpenFile(file);
      if (historyPath && file.savedText.length <= 2 * 1024 * 1024) {
        const historyText = applyEditorEol(file.savedText, file.eol);
        await historySnapshot(historyPath, historyText, "save").catch(() => null);
      }
      const diskText = applyEditorEol(textToSave, file.eol);
      const saved = file.ref.kind === "root"
        ? await workspaceWriteFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path, diskText, file.hash)
        : await workspaceWriteLooseFile(file.ref.path, diskText, file.hash);
      const normalized = normalizeEditorText(saved.text);
      const cleaned: OpenFileState = {
        ...file,
        text: normalized.text,
        savedText: normalized.text,
        eol: normalized.eol,
        hash: saved.hash,
        mtime: saved.mtime,
        size: saved.size,
        loading: false,
        saving: false,
        dirty: false,
        error: null,
      };
      openFilesRef.current = { ...openFilesRef.current, [key]: cleaned };
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? cleaned),
          ...cleaned,
          // If the user typed while we saved, keep their newer text dirty.
          text: (current[key]?.text ?? normalized.text) !== textToSave && current[key]
            ? current[key].text
            : normalized.text,
          dirty: (current[key]?.text ?? normalized.text) !== textToSave
            && (current[key]?.text ?? normalized.text) !== normalized.text
            ? true
            : false,
          savedText: normalized.text,
          eol: normalized.eol,
          hash: saved.hash,
          mtime: saved.mtime,
          size: saved.size,
          saving: false,
          error: null,
        },
      }));
      if (file.ref.kind === "root") {
        notifyWorkspacePathGitChanged(file.ref.rootId, file.ref.path);
      }
      void saveLspDocument(file, textToSave);
    } catch (err) {
      const message = errorMessage(err);
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...current[key],
          text: textToSave,
          dirty: true,
          saving: false,
          error: message,
        },
      }));
      throw err instanceof Error ? err : new Error(message);
    }
  }, [absolutePathForOpenFile, findRoot, notifyWorkspacePathGitChanged, saveLspDocument]);

  const formatFileText = useCallback(async (
    file: OpenFileState,
    selection: EditorSelectionRange | null = null,
  ): Promise<string | null> => {
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return null;
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities ?? null;
    const hasSelection = !!selection && !selection.empty
      && (selection.start.line !== selection.end.line
        || selection.start.character !== selection.end.character);
    const useRange = hasSelection && (capabilities?.rangeFormatting ?? false);
    if (capabilities && !useRange && !capabilities.formatting) return null;
    if (capabilities && useRange && !capabilities.rangeFormatting) return null;

    const result = useRange && selection
      ? await lspRangeFormatting(descriptor, {
        start: selection.start,
        end: selection.end,
      })
      : await lspFormatting(descriptor);
    updateLspStatusForFile(file, result.status);
    if (!result.edits.length) return file.text;
    return applyLspTextEditsToString(file.text, result.edits);
  }, [lspDescriptorForFile, updateLspStatusForFile]);

  const promptReloadProject = useCallback(
    async (key: string, subtitle: string) => {
      const file = openFilesRef.current[key];
      if (!file) return;
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      const confirmed = await confirmAppDialog({
        title: "Reload Java project",
        message: `${subtitle} changed. Reload the project so the language server picks up dependency and classpath changes?`,
        confirmLabel: "Reload",
      });
      if (!confirmed) return;
      try {
        await lspReloadProject(descriptor);
        setStatusMessage("Reloading Java project…");
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    },
    [lspDescriptorForFile, setStatusMessage],
  );

  const saveFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file || file.loading || file.saving || !file.dirty) return;
      let textToSave = file.text;
      let formatError: string | null = null;
      if (intelligencePreferences.formatOnSave) {
        try {
          const formatted = await formatFileText(file);
          const current = openFilesRef.current[key];
          // Do not overwrite keystrokes entered while the formatter was running.
          textToSave = current?.text === file.text
            ? formatted ?? file.text
            : current?.text ?? file.text;
        } catch (error) {
          formatError = errorMessage(error);
          textToSave = openFilesRef.current[key]?.text ?? file.text;
        }
      }
      try {
        await saveOpenBufferText(key, textToSave);
        setStatusMessage(formatError
          ? `Saved ${file.subtitle}; format on save failed: ${formatError}`
          : `Saved ${file.subtitle}`);
        // A Maven/Gradle build file changed on disk: offer to re-import the
        // project model so jdtls picks up dependency/classpath edits. Only when
        // a jdtls session is actually up for this project (no prompt otherwise).
        if (isJavaBuildFile(file.languagePath) && lspFilesRef.current[key]?.status?.active) {
          void promptReloadProject(key, file.subtitle);
        }
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    },
    [
      activeKey,
      formatFileText,
      intelligencePreferences.formatOnSave,
      promptReloadProject,
      saveOpenBufferText,
      setStatusMessage,
    ],
  );

  const reloadFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file) return;
      if (file.library) {
        setStatusMessage(`${file.title} is a read-only library source`);
        return;
      }
      if (file.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Reload file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!confirmed) return;
      }
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? file),
          loading: true,
          error: null,
        },
      }));
      try {
        const reloaded = file.ref.kind === "root"
          ? await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
          : await workspaceReadLooseFile(file.ref.path);
        const normalized = normalizeEditorText(reloaded.text);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...file,
            text: normalized.text,
            savedText: normalized.text,
            eol: normalized.eol,
            hash: reloaded.hash,
            mtime: reloaded.mtime,
            size: reloaded.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
        }));
        setStatusMessage(`Reloaded ${file.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? file),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activeKey, findRoot, setStatusMessage],
  );

  const closeFile = useCallback(
    async (key: string, groupId: EditorGroupId = activeEditorGroupId) => {
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const group = currentUi.editorGroups[groupId];
      if (!group.openOrder.includes(key)) return;
      const file = openFilesRef.current[key];
      const usedByOtherGroup = Object.values(currentUi.editorGroups).some(
        (candidate) => candidate.id !== groupId && candidate.openOrder.includes(key),
      );
      if (file?.dirty && !usedByOtherGroup) {
        const confirmed = await confirmAppDialog({
          title: "Close file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Close",
          danger: true,
        });
        if (!confirmed) return;
      }
      const index = group.openOrder.indexOf(key);
      const nextOrder = group.openOrder.filter((entry) => entry !== key);
      updateEditorGroup(groupId, (current) => ({
        ...current,
        openOrder: nextOrder,
        activeKey: current.activeKey === key
          ? nextOrder[Math.min(index, nextOrder.length - 1)] ?? null
          : current.activeKey,
        previewKey: current.previewKey === key ? null : current.previewKey,
        pinnedKeys: current.pinnedKeys.filter((entry) => entry !== key),
      }));
      if (usedByOtherGroup) return;
      if (file) closeLspDocument(file);
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setMarkdownModes((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setLspFiles((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [activeEditorGroupId, closeLspDocument, updateEditorGroup, workspaceInstanceId],
  );

  const promotePreviewTab = useCallback((groupId: EditorGroupId, key: string) => {
    updateEditorGroup(groupId, (group) => ({
      ...group,
      previewKey: group.previewKey === key ? null : group.previewKey,
    }));
  }, [updateEditorGroup]);

  const setTabPinned = useCallback((groupId: EditorGroupId, key: string, pinned: boolean) => {
    updateEditorGroup(groupId, (group) => ({
      ...group,
      previewKey: pinned && group.previewKey === key ? null : group.previewKey,
      pinnedKeys: pinned
        ? [...group.pinnedKeys.filter((entry) => entry !== key), key]
        : group.pinnedKeys.filter((entry) => entry !== key),
    }));
  }, [updateEditorGroup]);

  const closeGroupFiles = useCallback(async (groupId: EditorGroupId, keys: string[]) => {
    for (const key of keys) await closeFile(key, groupId);
  }, [closeFile]);

  const splitEditor = useCallback((
    orientation: EditorSplitOrientation,
    key = activeKey,
    sourceGroupId = activeEditorGroupId,
  ) => {
    if (!key) return;
    const file = openFilesRef.current[key];
    if (!file) return;
    const targetGroupId: EditorGroupId = sourceGroupId === "primary" ? "secondary" : "primary";
    void openFile(file.ref, { groupId: targetGroupId });
    setStoreSplitOrientation(workspaceInstanceId, orientation);
  }, [activeEditorGroupId, activeKey, openFile, setStoreSplitOrientation, workspaceInstanceId]);

  const closeSplit = useCallback(() => {
    const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const primary = current.editorGroups.primary;
    const secondary = current.editorGroups.secondary;
    const mergedOrder = [...primary.openOrder];
    for (const key of secondary.openOrder) {
      if (!mergedOrder.includes(key)) mergedOrder.push(key);
    }
    updateEditorGroup("primary", {
      ...primary,
      openOrder: mergedOrder,
      activeKey: current.activeEditorGroupId === "secondary"
        ? secondary.activeKey ?? primary.activeKey
        : primary.activeKey,
      pinnedKeys: [...new Set([...primary.pinnedKeys, ...secondary.pinnedKeys])],
      previewKey: primary.previewKey ?? secondary.previewKey,
    });
    updateEditorGroup("secondary", {
      id: "secondary",
      openOrder: [],
      activeKey: null,
      previewKey: null,
      pinnedKeys: [],
    });
    setStoreSplitOrientation(workspaceInstanceId, null);
    activateEditorGroup("primary");
  }, [activateEditorGroup, setStoreSplitOrientation, updateEditorGroup, workspaceInstanceId]);

  useEffect(() => {
    if (!splitOrientation) return;
    const primary = editorGroups.primary;
    const secondary = editorGroups.secondary;
    if (primary.openOrder.length > 0 && secondary.openOrder.length > 0) return;
    if (primary.openOrder.length === 0 && secondary.openOrder.length > 0) {
      updateEditorGroup("primary", { ...secondary, id: "primary" });
      updateEditorGroup("secondary", {
        id: "secondary",
        openOrder: [],
        activeKey: null,
        previewKey: null,
        pinnedKeys: [],
      });
    }
    setStoreSplitOrientation(workspaceInstanceId, null);
    activateEditorGroup("primary");
  }, [activateEditorGroup, editorGroups, setStoreSplitOrientation, splitOrientation, updateEditorGroup, workspaceInstanceId]);

  const activeFile = activeKey ? openFiles[activeKey] ?? null : null;
  // Large-file mode (M6-B): above the size/line threshold, skip the per-edit
  // semantic-tokens / inlay-hint / document-highlight storm and their decoration
  // rebuilds. Lezer highlighting and on-demand features stay available.
  const activeFileIsLarge = useMemo(
    () => (activeFile && !activeFile.loading ? isLargeFileContent(activeFile.text) : false),
    [activeFile],
  );
  // Metadata panels and AI workspace context do not need a new snapshot for
  // every character.  Let React publish that non-interactive work after the
  // input update has painted.
  const deferredOpenFiles = useDeferredValue(openFiles);
  const activeLspState = activeKey ? lspFiles[activeKey] ?? null : null;
  const activeCapabilities = activeLspState?.status?.capabilities ?? null;
  const activeLspDocumentIsSynced = Boolean(
    activeFile
    && !activeFile.loading
    && activeLspState?.status
    // Store-backed fields re-render after the didChange queue drains; the
    // session helper also covers the silent mid-burst path.
    && !activeLspState.syncing
    && (activeLspState.syncedText === activeFile.text
      || isLspDocumentSynced(activeFile.key, activeFile.text)),
  );

  // The backend is responsible for serializing didOpen/didChange calls, but
  // the view also needs a revision token so a slow feature response cannot
  // paint a document revision that has already been replaced locally.
  useEffect(() => {
    if (!activeFile) return;
    lspDocumentEpochRef.current[activeFile.key] =
      (lspDocumentEpochRef.current[activeFile.key] ?? 0) + 1;
  }, [activeFile?.key, activeFile?.text]);

  const isCurrentLspDocumentRequest = useCallback((file: OpenFileState, epoch: number) => {
    const latestFile = openFilesRef.current[file.key];
    return latestFile?.text === file.text
      && lspDocumentEpochRef.current[file.key] === epoch
      && isLspDocumentSynced(file.key, file.text);
  }, [isLspDocumentSynced]);

  const openHierarchy = useCallback(async (mode: "call" | "type") => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStatusMessage("No language service for this file");
      return;
    }
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities;
    const supported = mode === "call" ? capabilities?.callHierarchy : capabilities?.typeHierarchy;
    if (!supported) {
      setStatusMessage(`${mode === "call" ? "Call" : "Type"} hierarchy is not supported by this language server`);
      return;
    }
    try {
      const position = cursorPositions[activeEditorGroupId] ?? editorSelectionRef.current.start;
      const result = mode === "call"
        ? await lspPrepareCallHierarchy(descriptor, position)
        : await lspPrepareTypeHierarchy(descriptor, position);
      updateLspStatusForFile(file, result.status);
      const item = result.items[0];
      if (!item) {
        setStatusMessage(`No ${mode} hierarchy is available at the cursor`);
        return;
      }
      const root: HierarchyRootState = { descriptor, item };
      if (mode === "call") {
        setCallHierarchyRoot(root);
        setBottomDockTab("call-hierarchy");
      } else {
        setTypeHierarchyRoot(root);
        setBottomDockTab("type-hierarchy");
      }
      setBottomDockOpen(true);
    } catch (cause) {
      setStatusMessage(errorMessage(cause));
    }
  }, [
    activeEditorGroupId,
    activeFile,
    cursorPositions,
    lspDescriptorForFile,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    updateLspStatusForFile,
  ]);
  const activeLanguageId = activeLspState?.status?.languageId ?? null;
  const activeInlayHintsEnabled = inlayHintsEnabledForLanguage(
    intelligencePreferences,
    activeLanguageId,
  );
  const toggleInlayHints = useCallback(() => {
    setIntelligencePreferences((current) => ({
      ...current,
      inlayHintsEnabled: !current.inlayHintsEnabled,
    }));
  }, [setIntelligencePreferences]);
  const toggleInlayHintsForActiveLanguage = useCallback(() => {
    const languageId = activeLanguageId;
    setIntelligencePreferences((current) => {
      if (!languageId) return { ...current, inlayHintsEnabled: !current.inlayHintsEnabled };
      const currentlyEnabled = inlayHintsEnabledForLanguage(current, languageId);
      return {
        ...current,
        inlayHintsEnabled: true,
        inlayHintLanguages: {
          ...current.inlayHintLanguages,
          [languageId]: !currentlyEnabled,
        },
      };
    });
  }, [activeLanguageId, setIntelligencePreferences]);
  const toggleInlineBlame = useCallback(() => {
    setIntelligencePreferences((current) => ({
      ...current,
      inlineBlameEnabled: !current.inlineBlameEnabled,
    }));
  }, [setIntelligencePreferences]);
  const setFormatOnSave = useCallback((enabled: boolean) => {
    setIntelligencePreferences((current) => ({
      ...current,
      formatOnSave: enabled,
    }));
    setStatusMessage(`Format on save ${enabled ? "enabled" : "disabled"} for this workspace`);
  }, [setIntelligencePreferences, setStatusMessage]);

  // Probe / re-open when the active buffer *identity* changes — not on every
  // text commit. Typing drives didChange through scheduleLiveLspSync only.
  // Depending on the whole activeFile object used to re-fire open/change IPC
  // after each EDITOR_TEXT_COMMIT_IDLE flush and made non-LSP files feel laggy.
  const activeFileKey = activeFile?.key ?? null;
  const activeFileLoading = activeFile?.loading ?? false;
  const activeFileLanguagePath = activeFile?.languagePath ?? null;
  // Library buffers are served by the origin project's session and never opened as
  // documents, so they must not start a server of their own.
  const activeFileIsLibrary = !!activeFile?.library;
  useEffect(() => {
    if (!visible || !activeFileKey || activeFileLoading || !activeFileLanguagePath) return;
    if (activeFileIsLibrary) return;
    const lspState = lspFilesRef.current[activeFileKey];
    if (!shouldProbeLsp(activeFileLanguagePath, lspState)) return;
    if (lspState?.status?.active) {
      // Active session: typing / store-text effects own didChange.
      return;
    }
    const timer = window.setTimeout(() => {
      const latest = openFilesRef.current[activeFileKey];
      if (!latest || !shouldProbeLsp(latest.languagePath, lspFilesRef.current[activeFileKey])) return;
      void syncLspDocument(latest, "open");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeFileIsLibrary,
    activeFileKey,
    activeFileLanguagePath,
    activeFileLoading,
    syncLspDocument,
    visible,
  ]);

  // Non-CodeMirror text updates (format, AI rewrite, store patches in tests)
  // still need didChange once the server is active. Gated so plain-text /
  // unavailable presets never schedule IPC from store flushes.
  const activeFileText = activeFile?.text;
  useEffect(() => {
    if (!visible || !activeFileKey || activeFileLoading || activeFileText == null) return;
    const lspState = lspFilesRef.current[activeFileKey];
    if (!shouldLiveSyncLsp(activeFileLanguagePath ?? "", lspState)) return;
    if (isLspDocumentSynced(activeFileKey, activeFileText)) return;
    scheduleLiveLspSync(activeFileKey);
  }, [
    activeFileKey,
    activeFileLanguagePath,
    activeFileLoading,
    activeFileText,
    isLspDocumentSynced,
    scheduleLiveLspSync,
    visible,
  ]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    // Large-file mode: no per-cursor highlight (LSP request nor text-scan fallback).
    if (!file || file.loading || activeFileIsLarge) {
      setHighlightsByGroup((current) => (
        current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    let cancelled = false;
    const position = cursorPositions[groupId] ?? { line: 0, character: 0 };
    const descriptor = lspDescriptorForFile(file);
    if (!activeCapabilities?.documentHighlight || !descriptor) {
      const timer = window.setTimeout(() => {
        if (!cancelled && openFilesRef.current[file.key]?.text === file.text) {
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: fallbackWordHighlights(file.text, position),
          }));
        }
      }, LSP_HIGHLIGHT_IDLE_DELAY_MS);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    if (!activeLspDocumentIsSynced) {
      setHighlightsByGroup((current) => (
        current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspDocumentHighlights(descriptor, position)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setHighlightsByGroup((current) => ({ ...current, [groupId]: result.highlights }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: fallbackWordHighlights(file.text, position),
          }));
        });
    }, LSP_HIGHLIGHT_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentHighlight,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeLspDocumentIsSynced,
    cursorPositions,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeInlayHintsEnabled || !activeCapabilities?.inlayHint) {
      setInlayHintsByGroup((current) => (
        current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setInlayHintsByGroup((current) => (
        current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    const range = viewportRanges[groupId] ?? initialInlayHintRange(file.text);
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspInlayHints(descriptor, range)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setInlayHintsByGroup((current) => ({ ...current, [groupId]: result.hints }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setInlayHintsByGroup((current) => (
            current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
          ));
        });
    }, LSP_INLAY_HINT_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.inlayHint,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeInlayHintsEnabled,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
    viewportRanges,
  ]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeCapabilities?.semanticTokens) {
      setSemanticTokensByGroup((current) => (
        current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setSemanticTokensByGroup((current) => (
        current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspSemanticTokens(descriptor)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setSemanticTokensByGroup((current) => ({ ...current, [groupId]: result.tokens }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setSemanticTokensByGroup((current) => (
            current[groupId].length === 0 ? current : { ...current, [groupId]: [] }
          ));
        });
    }, LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.semanticTokens,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);

  const getLspSelectionRanges = useCallback(async (
    file: OpenFileState,
    selection: EditorSelectionRange,
  ): Promise<LspRange[] | null> => {
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities;
    if (!capabilities?.selectionRange) return null;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return null;
    try {
      const result = await lspSelectionRanges(descriptor, selection.end);
      updateLspStatusForFile(file, result.status);
      return result.ranges.length > 0 ? result.ranges : null;
    } catch {
      return null;
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);
  const breadcrumbPathSegments = useMemo<BreadcrumbPathSegment[]>(() => {
    return activeFile ? breadcrumbSegmentsForFile(activeFile, roots) : [];
  }, [activeFile, roots]);

  const openFileTodos = useDeferredOpenFileTodos(openFiles);

  useEffect(() => {
    let cancelled = false;
    if (!activeFile || activeFile.loading || !activeCapabilities?.documentSymbol) {
      setBreadcrumbSymbolsByGroup((current) => (
        current[activeEditorGroupId].length === 0
          ? current
          : { ...current, [activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    if (!activeLspDocumentIsSynced) {
      setBreadcrumbSymbolsByGroup((current) => (
        current[activeEditorGroupId].length === 0
          ? current
          : { ...current, [activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    const descriptor = lspDescriptorForFile(activeFile);
    if (!descriptor) return () => { cancelled = true; };
    const epoch = lspDocumentEpochRef.current[activeFile.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(activeFile, epoch)) return;
      void lspDocumentSymbols(descriptor).then((result) => {
        if (!cancelled && isCurrentLspDocumentRequest(activeFile, epoch)) {
          updateLspStatusForFile(activeFile, result.status);
          setBreadcrumbSymbolsByGroup((current) => ({
            ...current,
            [activeEditorGroupId]: result.symbols,
          }));
        }
      }).catch(() => {
        if (!cancelled && isCurrentLspDocumentRequest(activeFile, epoch)) {
          setBreadcrumbSymbolsByGroup((current) => (
            current[activeEditorGroupId].length === 0
              ? current
              : { ...current, [activeEditorGroupId]: [] }
          ));
        }
      });
    }, LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentSymbol,
    activeEditorGroupId,
    activeFile,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);
  const activeRootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : null;
  const activeRoot = activeRootId ? roots.find((root) => root.id === activeRootId) ?? null : null;
  const activeGitRoot = activeRoot && activeFile?.ref.kind === "root"
    ? gitRootForWorkspacePath(activeRoot, activeFile.ref.path, gitRoots)
    : null;
  const title = workspaceTitle(workspace, roots, looseFiles);
  const gitManagerPayload = useMemo<CodeWorkspaceGitManagerPayload>(() => ({
    workspaceName: title,
    workspaceInstanceId,
    workspaceId: workspace.workspaceId,
    roots: gitRoots,
    // Empty roots still emit a payload so the linked Git manager can close
    // instead of snapshotting stale paths (issue #324 B1).
    activeRepoRoot: activeGitRoot?.repoRoot ?? gitRoots[0]?.repoRoot ?? null,
  }), [activeGitRoot, gitRoots, title, workspace.workspaceId, workspaceInstanceId]);

  const openGitManager = useCallback(() => {
    if (!onOpenGitManager || gitManagerPayload.roots.length === 0) return;
    onOpenGitManager(gitManagerPayload);
  }, [gitManagerPayload, onOpenGitManager]);

  useEffect(() => {
    if (!visible) {
      clearWorkspaceStatus(tabId);
      return;
    }
    const cursor = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const status = activeLspState?.status ?? null;
    const gitSnapshot = activeGitRoot ? gitSnapshots[activeGitRoot.repoRoot] : null;
    setWorkspaceStatusSegments({
      tabId,
      line: cursor.line + 1,
      column: cursor.character + 1,
      encoding: "UTF-8",
      eol: activeFile?.eol ?? "LF",
      languageId: status?.languageId ?? activeLanguageId,
      lspActive: !!status?.active,
      lspLabel: status?.displayName ?? (status?.active ? "LSP" : null),
      lspError: !!activeLspState?.error || (!!status && !status.active && !!status.error),
      gitBranch: gitSnapshot?.currentBranch ?? null,
      gitAhead: gitSnapshot?.ahead ?? 0,
      gitBehind: gitSnapshot?.behind ?? 0,
      fontSize: codeViewProfile.fontSize,
      largeFile: activeFileIsLarge,
    });
  }, [
    activeEditorGroupId,
    activeFile?.eol,
    activeFileIsLarge,
    activeGitRoot,
    activeLanguageId,
    activeLspState,
    clearWorkspaceStatus,
    codeViewProfile.fontSize,
    cursorPositions,
    gitSnapshots,
    setWorkspaceStatusSegments,
    tabId,
    visible,
  ]);

  const activeLspPresetIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeLspPresetIdRef.current = activeLspState?.status?.presetId ?? null;
  }, [activeLspState?.status?.presetId]);

  const openLanguageServersSettings = useCallback((presetId?: string | null) => {
    openSettingsSection("language-servers", { presetId: presetId ?? null });
  }, []);

  useEffect(() => {
    if (!visible) return;
    setWorkspaceStatusActions(tabId, {
      // Language server install / binary selection lives in Settings (global).
      openLanguagePanel: () => openLanguageServersSettings(activeLspPresetIdRef.current),
      openGitManager: gitManagerPayload.roots.length > 0 && onOpenGitManager ? openGitManager : undefined,
    });
  }, [
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    openLanguageServersSettings,
    setWorkspaceStatusActions,
    tabId,
    visible,
  ]);

  useEffect(() => {
    return () => clearWorkspaceStatus(tabId);
  }, [clearWorkspaceStatus, tabId]);

  const gitChangeByRootPath = useMemo(() => {
    const map = new Map<string, GitChange>();
    for (const root of roots) {
      for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
        const snapshot = gitSnapshots[repo.repoRoot];
        if (!snapshot?.changes.length) continue;
        for (const change of snapshot.changes) {
          const workspacePath = workspacePathForGitPath(root, repo, change.path);
          if (workspacePath === null) continue;
          map.set(`${root.id}:${workspacePath}`, change);
        }
      }
    }
    return map;
  }, [gitRoots, gitSnapshots, roots]);

  const gitTargetForFile = useCallback((file: OpenFileState | null) => {
    if (!file || file.loading || file.ref.kind !== "root") return null;
    const ref = file.ref;
    const root = roots.find((candidate) => candidate.id === ref.rootId);
    if (!root) return null;
    const repo = gitRootForWorkspacePath(root, ref.path, gitRoots);
    if (!repo) return null;
    const path = gitPathForWorkspacePath(root, repo, ref.path);
    if (!path) return null;
    const snapshot = gitSnapshots[repo.repoRoot];
    return {
      repoRoot: repo.repoRoot,
      path,
      headOid: snapshot?.headOid ?? null,
      sourceKey: `${repo.repoRoot}:${snapshot?.headOid ?? "no-head"}:${path}`,
    };
  }, [gitRoots, gitSnapshots, roots]);

  const activeGitFileStateSignature = useMemo(() => {
    const stateForKey = (key: string | null) => {
      if (!key) return "empty";
      const file = openFiles[key];
      if (!file) return "missing";
      return file.loading ? "loading" : "ready";
    };
    return [
      editorGroups.primary.activeKey,
      stateForKey(editorGroups.primary.activeKey),
      editorGroups.secondary.activeKey,
      stateForKey(editorGroups.secondary.activeKey),
    ].join(":");
  }, [editorGroups.primary.activeKey, editorGroups.secondary.activeKey, openFiles]);

  const gitDiffSources = useMemo(() => {
    const seen = new Set<string>();
    return [editorGroups.primary.activeKey, editorGroups.secondary.activeKey].flatMap((key) => {
      if (!key || seen.has(key)) return [];
      seen.add(key);
      const file = openFiles[key];
      const target = gitTargetForFile(file ?? null);
      const head = gitHeadTextByFile[key];
      if (!file || !target || !head || head.sourceKey !== target.sourceKey) return [];
      return [{
        key,
        sourceKey: target.sourceKey,
        headText: head.text,
        bufferText: file.text,
      }];
    });
  }, [
    editorGroups.primary.activeKey,
    editorGroups.secondary.activeKey,
    gitHeadTextByFile,
    gitTargetForFile,
    openFiles,
  ]);
  const gitLineChangesByFile = useDeferredGitLineChanges(gitDiffSources);

  useEffect(() => {
    let cancelled = false;
    const activeKeys = new Set([
      editorGroups.primary.activeKey,
      editorGroups.secondary.activeKey,
    ].filter((key): key is string => !!key));
    for (const key of activeKeys) {
      const file = openFilesRef.current[key];
      const target = gitTargetForFile(file ?? null);
      if (!file || !target || gitHeadTextByFile[key]?.sourceKey === target.sourceKey) continue;
      if (!target.headOid) {
        setGitHeadTextByFile((current) => ({
          ...current,
          [key]: { sourceKey: target.sourceKey, text: "" },
        }));
        continue;
      }
      if (gitHeadRequestsRef.current.has(target.sourceKey)) continue;
      gitHeadRequestsRef.current.add(target.sourceKey);
      void gitBlobPair(target.repoRoot, target.path, "HEAD", "")
        .then((pair) => {
          if (cancelled) return;
          setGitHeadTextByFile((current) => ({
            ...current,
            [key]: {
              sourceKey: target.sourceKey,
              text: pair.binary || pair.oversize ? null : pair.oldText ?? "",
            },
          }));
        })
        .catch(() => {
          if (!cancelled) {
            setGitHeadTextByFile((current) => ({
              ...current,
              [key]: { sourceKey: target.sourceKey, text: null },
            }));
          }
        })
        .finally(() => gitHeadRequestsRef.current.delete(target.sourceKey));
    }
    return () => { cancelled = true; };
  }, [activeGitFileStateSignature, gitHeadTextByFile, gitTargetForFile]);

  const gitBlameRequestSignature = useMemo(() => {
    const signatureForGroup = (groupId: EditorGroupId) => {
      const key = editorGroups[groupId].activeKey;
      // Input batching keeps the store snapshot stable during a typing burst,
      // but the ref is updated immediately.  Use it here so inline blame is
      // disabled from the first dirty keystroke rather than one batch later.
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.dirty || !target?.headOid) {
        return `${groupId}:${key ?? "empty"}:disabled`;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      return `${groupId}:${key}:${target.sourceKey}:${file.hash}:${line}`;
    };
    return `${signatureForGroup("primary")}|${signatureForGroup("secondary")}`;
  }, [
    cursorPositions,
    editorGroups.primary.activeKey,
    editorGroups.secondary.activeKey,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
    openFiles,
  ]);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const cacheBlame = (cacheKey: string, blame: GitBlameLine | null) => {
      const cache = gitBlameCacheRef.current;
      cache.delete(cacheKey);
      cache.set(cacheKey, blame);
      if (cache.size > 256) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
    };
    const loadForGroup = (groupId: EditorGroupId) => {
      const key = editorGroups[groupId].activeKey;
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.dirty || !target?.headOid) {
        setGitBlameByGroup((current) => current[groupId] === null ? current : { ...current, [groupId]: null });
        return;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      const cacheKey = `${target.sourceKey}:${file.hash}:${line}`;
      if (gitBlameCacheRef.current.has(cacheKey)) {
        const cached = gitBlameCacheRef.current.get(cacheKey) ?? null;
        cacheBlame(cacheKey, cached);
        setGitBlameByGroup((current) => current[groupId] === cached ? current : { ...current, [groupId]: cached });
        return;
      }
      timers.push(window.setTimeout(() => {
        void gitBlameLines(target.repoRoot, target.path, line, line)
          .then((lines) => {
            const blame = lines[0] ?? null;
            cacheBlame(cacheKey, blame);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: blame }));
          })
          .catch(() => {
            cacheBlame(cacheKey, null);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: null }));
          });
      }, 500));
    };
    loadForGroup("primary");
    loadForGroup("secondary");
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    gitBlameRequestSignature,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
  ]);

  const openMarkdownHref = useCallback(
    (href: string) => {
      if (!activeFile || isExternalHref(href)) return false;
      const target = href.split("#", 1)[0].split("?", 1)[0];
      if (!target) return false;
      if (activeFile.ref.kind === "root") {
        const path = resolveRootMarkdownLink(activeFile.ref.path, target);
        void openFile({ kind: "root", rootId: activeFile.ref.rootId, path });
        return true;
      }
      const path = resolveLooseMarkdownLink(activeFile.ref.path, target);
      void addLooseFilePath(path);
      return true;
    },
    [activeFile, addLooseFilePath, openFile],
  );

  const revealEditorLocation = useCallback((key: string, range: LspLocation["range"]) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: range.start.line,
      character: range.start.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  /**
   * Open a language-server library source (JDK class, dependency JAR) as a
   * read-only buffer. Nothing is read from or written to disk, and the buffer is
   * not registered as a loose workspace file — it only exists while open (plus in
   * the library registry so history can reopen it).
   */
  const openLibraryBuffer = useCallback(async (
    info: LibraryBufferInfo,
    text: string,
    range: LspLocation["range"],
    options: { groupId?: EditorGroupId; preview?: boolean } = {},
  ) => {
    const file = makeLibraryFile(info, text);
    const ref = file.ref;
    const key = file.key;
    libraryBuffersRef.current[key] = info;
    suppressNextHistoryRecord();
    setOpenFiles((current) => ({ ...current, [key]: file }));
    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const groupId = options.groupId ?? currentUi.activeEditorGroupId;
    updateEditorGroup(groupId, (group) => {
      const alreadyOpen = group.openOrder.includes(key);
      let nextOrder = group.openOrder;
      let previewKey = group.previewKey;
      if (!alreadyOpen) {
        if (options.preview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
          nextOrder = nextOrder.filter((entry) => entry !== previewKey);
        }
        nextOrder = [...nextOrder, key];
      }
      if (options.preview) {
        previewKey = group.pinnedKeys.includes(key) ? null : key;
      } else if (previewKey === key) {
        previewKey = null;
      }
      return { ...group, openOrder: nextOrder, activeKey: key, previewKey };
    });
    if (groupId !== currentUi.activeEditorGroupId) activateEditorGroup(groupId);
    revealEditorLocation(key, range);
    recordNavigationLocation(ref, {
      line: range.start.line,
      character: range.start.character,
    }, { replaceSameFile: false });
    setStatusMessage(`Opened ${file.subtitle} (read-only)`);
    return true;
  }, [
    activateEditorGroup,
    recordNavigationLocation,
    revealEditorLocation,
    setStatusMessage,
    suppressNextHistoryRecord,
    updateEditorGroup,
    workspaceInstanceId,
  ]);

  /**
   * IDEA-style on-demand "Download sources" for a decompiled library buffer:
   * ask jdtls to fetch the sources JAR, then swap the buffer's decompiled bytecode
   * for the attached source in place (keeping the same tab / caret).
   */
  const downloadLibrarySources = useCallback(async (key: string) => {
    const info = libraryBuffersRef.current[key];
    const file = openFilesRef.current[key];
    if (!info || !file?.library) return;
    if (downloadingSourcesKeys.includes(key)) return;
    setDownloadingSourcesKeys((current) => [...current, key]);
    setStatusMessage(`Downloading sources for ${info.title}…`);
    try {
      const descriptor = lspDescriptorForPath(info.originRootPath, info.originFilePath);
      const result = await lspDownloadSources(descriptor, info.uri);
      if (!openFilesRef.current[key]) return; // tab closed mid-download
      if (result.attached && !result.decompiled) {
        const nextInfo: LibraryBufferInfo = { ...info, decompiled: false };
        libraryBuffersRef.current[key] = nextInfo;
        // Preserve caret/scroll: only the text + decompiled flag change.
        setOpenFiles((current) => {
          const existing = current[key];
          if (!existing) return current;
          const rebuilt = makeLibraryFile(nextInfo, result.text);
          return { ...current, [key]: { ...rebuilt, key: existing.key } };
        });
        setStatusMessage(`Attached sources for ${info.title}`);
      } else {
        setStatusMessage(result.message ?? `No sources published for ${info.title}`);
      }
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      setDownloadingSourcesKeys((current) => current.filter((entry) => entry !== key));
    }
  }, [downloadingSourcesKeys, lspDescriptorForPath, setStatusMessage]);

  const openLspLocation = useCallback(
    async (
      location: LspLocation,
      options: { groupId?: EditorGroupId; preview?: boolean } = {},
    ) => {
      const openResolvedPath = async (path: string) => {
        for (const root of rootsRef.current) {
          const relative = relativePathWithinRoot(root.path, path);
          if (relative === null) continue;
          const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relative };
          suppressNextHistoryRecord();
          revealEditorLocation(fileKey(ref), location.range);
          await openFile(ref, options);
          // openFile reports read failures on the buffer instead of throwing.
          if (openFilesRef.current[fileKey(ref)]?.error) return false;
          recordNavigationLocation(ref, {
            line: location.range.start.line,
            character: location.range.start.character,
          }, { replaceSameFile: false });
          return true;
        }
        const loose = makeLooseFile(path);
        const ref: CodeWorkspaceFileRef = { kind: "loose", id: loose.id, path: loose.path };
        setLooseFiles((current) => current.some((item) => item.path === loose.path) ? current : [...current, loose]);
        suppressNextHistoryRecord();
        revealEditorLocation(fileKey(ref), location.range);
        await openFile(ref, options);
        // openFile reports read failures on the buffer instead of throwing.
        if (openFilesRef.current[fileKey(ref)]?.error) return false;
        recordNavigationLocation(ref, {
          line: location.range.start.line,
          character: location.range.start.character,
        }, { replaceSameFile: false });
        return true;
      };

      // Workspace-symbol hits fall back to the URI when the server reports no path,
      // and a URI string is never readable from disk.
      const diskPath = location.path && !looksLikeDocumentUri(location.path) ? location.path : null;
      if (diskPath) {
        try {
          if (await openResolvedPath(diskPath)) return true;
        } catch (err) {
          if (!location.uri) {
            setStatusMessage(errorMessage(err));
            return false;
          }
        }
        // Path unreadable (missing source attachment, JAR entry): try the URI below.
        if (!location.uri) return false;
      }

      // JDK / third-party JAR / other virtual URIs (jdt://, jar:file:…).
      if (!location.uri) {
        setStatusMessage("No definition found");
        return false;
      }
      // Library sources ride the origin project's language-server session: prefer the
      // active buffer, and fall back to the origin project of a library buffer.
      const origin = activeFile
        ?? Object.values(openFilesRef.current).find((item) => !item.loading)
        ?? null;
      const descriptor = origin ? lspDescriptorForFile(origin) : null;
      if (!origin || !descriptor) {
        setStatusMessage("Cannot open library source without an active language server document");
        return false;
      }
      try {
        const contents = await lspReadUriContents(descriptor, location.uri);
        updateLspStatusForFile(origin, contents.status);
        // Attached sources that exist on disk open as a normal editable-looking file.
        if (contents.path) {
          try {
            if (await openResolvedPath(contents.path)) return true;
          } catch {
            // Keep going and inject the text we already fetched.
          }
        }
        return openLibraryBuffer(
          {
            uri: contents.uri || location.uri,
            title: contents.title,
            container: contents.container,
            languageId: contents.languageId,
            originRootPath: descriptor.rootPath ?? null,
            originFilePath: descriptor.filePath,
            decompiled: contents.decompiled,
          },
          contents.text,
          location.range,
          options,
        );
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [
      activeFile,
      lspDescriptorForFile,
      openFile,
      openLibraryBuffer,
      recordNavigationLocation,
      revealEditorLocation,
      setStatusMessage,
      suppressNextHistoryRecord,
      updateLspStatusForFile,
    ],
  );

  const fetchWorkspaceSymbols = useCallback(async (query: string): Promise<GoToSymbolItem[]> => {
    const file = activeFile ?? Object.values(openFilesRef.current).find((item) => !item.loading) ?? null;
    if (!file) return [];
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    try {
      const result = await lspWorkspaceSymbols(descriptor, query);
      updateLspStatusForFile(file, result.status);
      return result.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        containerName: symbol.containerName,
        path: symbol.path ?? symbol.uri,
        uri: symbol.uri,
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
      }));
    } catch {
      return [];
    }
  }, [activeFile, lspDescriptorForFile, updateLspStatusForFile]);

  const openWorkspaceSymbol = useCallback(async (
    symbol: GoToSymbolItem,
    options?: { split: boolean },
  ) => {
    setSearchEverywhereOpen(false);
    let groupId: EditorGroupId | undefined;
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      groupId = current.activeEditorGroupId === "primary" ? "secondary" : "primary";
      setStoreSplitOrientation(workspaceInstanceId, "vertical");
    }
    await openLspLocation({
      uri: symbol.uri,
      path: symbol.path,
      range: {
        start: { line: symbol.line, character: symbol.character },
        end: { line: symbol.line, character: symbol.character },
      },
    }, { groupId, preview: !options?.split });
  }, [openLspLocation, setStoreSplitOrientation, workspaceInstanceId]);

  const seSymbolsAvailable = !!(
    activeCapabilities?.workspaceSymbol
    || Object.values(lspFiles).some((state) => state.status?.capabilities?.workspaceSymbol)
  );

  const openSearchMatch = useCallback(
    (match: WorkspaceSearchMatch, options: { preview: boolean }) => {
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: match.rootId, path: match.path };
      // Backend line numbers are 1-based; reveal targets follow LSP 0-based.
      const line = Math.max(0, match.lineNumber - 1);
      revealEditorLocation(fileKey(ref), {
        start: { line, character: match.matchStart },
        end: { line, character: match.matchEnd },
      });
      void openFile(ref, { preview: options.preview });
    },
    [openFile, revealEditorLocation],
  );

  const structureFileRef = useRef<string | null>(null);

  const pinQuickDocumentation = useCallback((content: QuickDocContent) => {
    setPinnedDoc(content);
    setPinnedDocLocked(true);
    setRightPaneTab("documentation");
    setRightPaneOpen(true);
    setQuickDocOpen(false);
  }, [setPinnedDoc, setPinnedDocLocked, setQuickDocOpen, setRightPaneOpen, setRightPaneTab]);

  const openQuickDocumentation = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const position = editorSelectionRef.current.start;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStatusMessage("No documentation available");
      return;
    }
    let body: string | null = null;
    try {
      const result = await lspHover(descriptor, position);
      updateLspStatusForFile(file, result.status);
      body = result.contents;
    } catch (err) {
      setStatusMessage(errorMessage(err));
      return;
    }
    if (!body) {
      setStatusMessage("No documentation available");
      return;
    }
    const lines = file.text.split("\n");
    const line = lines[position.line] ?? "";
    const left = line.slice(0, position.character);
    const right = line.slice(position.character);
    const start = left.search(/[A-Za-z0-9_$]+$/);
    const endMatch = right.match(/^[A-Za-z0-9_$]*/);
    const from = start >= 0 ? start : position.character;
    const to = position.character + (endMatch?.[0].length ?? 0);
    const word = line.slice(from, to) || file.title;
    setQuickDocContent({ title: word, body });
    setQuickDocOpen(true);
  }, [activeFile, lspDescriptorForFile, setStatusMessage, updateLspStatusForFile]);

  const formatActiveFile = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    try {
      const next = await formatFileText(file, editorSelectionRef.current);
      if (next === null) return;
      if (next !== file.text) updateFileText(file.key, next);
    } catch (error) {
      console.error("Format document failed", error);
    }
  }, [activeFile, formatFileText, updateFileText]);

  const applyLspWorkspaceEdit = useCallback(async (edit: LspWorkspaceEdit) => {
    const outcomes = await applyWorkspaceEdit(edit, {
      resolvePath: (file) => {
        if (file.path) return normalizeFsPath(file.path);
        return null;
      },
      getOpenBuffer: (absolutePath) => {
        const normalized = normalizeFsPath(absolutePath);
        for (const file of Object.values(openFilesRef.current)) {
          const path = absolutePathForOpenFile(file);
          if (path && normalizeFsPath(path) === normalized) {
            return { text: file.text, dirty: file.dirty, key: file.key };
          }
        }
        return null;
      },
      applyToOpenBuffer: (key, nextText) => updateFileText(key, nextText),
      // §5.2.9 open-clean: apply then save so the buffer is not left dirty.
      saveOpenBuffer: (key, nextText) => saveOpenBufferText(key, nextText),
      readDisk: async (absolutePath) => {
        // Prefer workspace APIs via root-relative path when possible.
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, absolutePath);
          if (rel === null) continue;
          try {
            const disk = await workspaceReadFile(root.path, rel);
            return { text: disk.text, hash: disk.hash };
          } catch {
            return null;
          }
        }
        try {
          const disk = await workspaceReadLooseFile(absolutePath);
          return { text: disk.text, hash: disk.hash };
        } catch {
          return null;
        }
      },
      writeDisk: async (absolutePath, text, expectedHash) => {
        // Snapshot current disk contents before bulk WorkspaceEdit writes.
        try {
          let oldText: string | null = null;
          for (const root of rootsRef.current) {
            const rel = relativePathWithinRoot(root.path, absolutePath);
            if (rel === null) continue;
            try {
              oldText = (await workspaceReadFile(root.path, rel)).text;
            } catch {
              oldText = null;
            }
            break;
          }
          if (oldText == null) {
            try {
              oldText = (await workspaceReadLooseFile(absolutePath)).text;
            } catch {
              oldText = null;
            }
          }
          if (oldText != null && oldText.length <= 2 * 1024 * 1024) {
            await historySnapshot(absolutePath, oldText, "replace").catch(() => null);
          }
        } catch {
          // Best-effort history; never block the edit write.
        }
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, absolutePath);
          if (rel === null) continue;
          await workspaceWriteFile(root.path, rel, text, expectedHash);
          return;
        }
        await workspaceWriteLooseFile(absolutePath, text, expectedHash);
      },
    });
    setStatusMessage(summarizeWorkspaceEditOutcomes(outcomes));
    return outcomes;
  }, [absolutePathForOpenFile, saveOpenBufferText, setStatusMessage, updateFileText]);

  const requestCodeActions = useCallback(async (
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
  ): Promise<LspCodeAction[]> => {
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.codeAction) return [];
    try {
      const result = await lspCodeActions(
        descriptor,
        range,
        diagnostics.map((item) => ({
          range: item.range,
          severity: item.severity,
          code: item.code,
          source: item.source,
          message: item.message,
        })),
      );
      updateLspStatusForFile(file, result.status);
      return result.actions;
    } catch {
      return [];
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);

  const runCodeAction = useCallback(async (action: LspCodeAction) => {
    if (action.edit) {
      await applyLspWorkspaceEdit(action.edit);
      return;
    }
    if (action.command) {
      setStatusMessage(`Code action command not yet executed: ${action.command}`);
      return;
    }
    setStatusMessage("Code action had no edit to apply");
  }, [applyLspWorkspaceEdit, setStatusMessage]);

  const showCodeActionsMenu = useCallback(async (
    clientX: number,
    clientY: number,
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
  ) => {
    const actions = await requestCodeActions(file, range, diagnostics);
    if (!actions.length) {
      setStatusMessage("No code actions available");
      return;
    }
    const sorted = [...actions].sort((a, b) => {
      const aQuick = a.kind?.includes("quickfix") ? 0 : 1;
      const bQuick = b.kind?.includes("quickfix") ? 0 : 1;
      if (aQuick !== bQuick) return aQuick - bQuick;
      if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    openTreeContextMenuAt(clientX, clientY, sorted.map((action) => ({
      label: action.title,
      onClick: () => void runCodeAction(action),
    })));
  }, [openTreeContextMenuAt, requestCodeActions, runCodeAction, setStatusMessage]);

  const openCodeActionsAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
      item.range.start.line === range.start.line
      || item.range.end.line === range.start.line
    ));
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      file,
      range,
      diagnostics,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openCodeActionsForLine = useCallback(async (line: number) => {
    const file = activeFile;
    if (!file || file.loading) return;
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter(
      (item) => item.range.start.line === line || item.range.end.line === line,
    );
    const range: LspRange = diagnostics[0]?.range ?? {
      start: { line, character: 0 },
      end: { line, character: 0 },
    };
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 48,
      (rect?.top ?? 0) + 48 + line * 16,
      file,
      range,
      diagnostics,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openQuickFixForProblem = useCallback(async (fileKey: string, diagnostic: LspDiagnostic) => {
    const file = openFilesRef.current[fileKey];
    if (!file) return;
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 120,
      file,
      diagnostic.range,
      [diagnostic],
    );
  }, [showCodeActionsMenu]);

  const openStructurePopup = useCallback(async () => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file || file.loading) return;
    structureFileRef.current = file.key;
    setStructureSymbols([]);
    setStructureUnavailable(null);
    setStructureLoading(true);
    setStructureOpen(true);
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStructureLoading(false);
      setStructureUnavailable("No language service for this file");
      return;
    }
    try {
      const result = await lspDocumentSymbols(descriptor);
      updateLspStatusForFile(file, result.status);
      if (structureFileRef.current !== file.key) return;
      setStructureSymbols(result.symbols);
      setStructureUnavailable(
        result.symbols.length === 0 && !result.status.active
          ? result.status.error ?? "Language server is not running for this file"
          : null,
      );
    } catch (err) {
      if (structureFileRef.current === file.key) setStructureUnavailable(errorMessage(err));
    } finally {
      if (structureFileRef.current === file.key) setStructureLoading(false);
    }
  }, [activeKey, lspDescriptorForFile, updateLspStatusForFile]);

  const pickStructureSymbol = useCallback(
    (symbol: LspDocumentSymbol) => {
      setStructureOpen(false);
      const key = structureFileRef.current;
      if (key) revealEditorLocation(key, symbol.selectionRange);
    },
    [revealEditorLocation],
  );

  const pickOutlineSymbol = useCallback((symbol: LspDocumentSymbol) => {
    if (activeKey) revealEditorLocation(activeKey, symbol.selectionRange);
  }, [activeKey, revealEditorLocation]);

  const openFileByKey = useCallback(async (key: string): Promise<boolean> => {
    const existing = openFilesRef.current[key];
    if (existing) {
      updateEditorGroup(activeEditorGroupId, (group) => (
        group.openOrder.includes(key)
          ? { ...group, activeKey: key }
          : { ...group, openOrder: [...group.openOrder, key], activeKey: key, previewKey: group.previewKey === key ? null : group.previewKey }
      ));
      return true;
    }
    if (key.startsWith("root:")) {
      const rest = key.slice("root:".length);
      const sep = rest.indexOf(":");
      if (sep > 0) {
        const rootId = rest.slice(0, sep);
        const path = rest.slice(sep + 1);
        await openFile({ kind: "root", rootId, path });
        return true;
      }
    }
    if (key.startsWith("loose:")) {
      const id = key.slice("loose:".length);
      const loose = looseFilesRef.current.find((item) => item.id === id);
      if (loose) {
        await openFile({ kind: "loose", id: loose.id, path: loose.path });
        return true;
      }
    }
    return false;
  }, [activeEditorGroupId, openFile, updateEditorGroup]);

  const openTodoOrBookmark = useCallback(async (
    item: { fileKey: string; line: number; character: number },
  ) => {
    if (!await openFileByKey(item.fileKey)) {
      setStatusMessage("The bookmarked file is no longer part of this workspace");
      return;
    }
    revealEditorLocation(item.fileKey, {
      start: { line: item.line, character: item.character },
      end: { line: item.line, character: item.character },
    });
  }, [openFileByKey, revealEditorLocation, setStatusMessage]);

  const toggleProjectTree = useCallback(() => {
    setLanguagePanelOpen((open) => !open);
  }, [setLanguagePanelOpen]);

  // Keep the resizable project panel in sync with the persisted open flag.
  // Drag-to-min collapses via onResize; toolbar / Alt+1 toggles go through this effect.
  useEffect(() => {
    const panel = projectPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      if (!languagePanelOpen) {
        panel.collapse();
      } else {
        panel.resize(`${lastProjectPanelSizeRef.current}%`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [languagePanelOpen]);

  const handleProjectPanelResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 2) {
      lastProjectPanelSizeRef.current = percentage;
    }
    // Avoid store churn when the panel is already in the desired open/collapsed state.
    setLanguagePanelOpen((open) => {
      const next = percentage > 2;
      return open === next ? open : next;
    });
  }, [setLanguagePanelOpen]);

  const toggleOutlinePane = useCallback(() => {
    if (rightPaneOpen && rightPaneTab === "outline") {
      setRightPaneOpen(false);
      return;
    }
    setRightPaneTab("outline");
    setRightPaneOpen(true);
  }, [rightPaneOpen, rightPaneTab, setRightPaneOpen, setRightPaneTab]);

  // Keep the resizable right pane panel in sync with the persisted open flag.
  // Follows the same collapse/expand pattern as the project tree panel.
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      if (!rightPaneOpen) {
        panel.collapse();
      } else {
        panel.resize(`${lastRightPanelSizeRef.current}%`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [rightPaneOpen]);

  const handleRightPanelResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 2) {
      lastRightPanelSizeRef.current = percentage;
    }
    setRightPaneOpen((open) => {
      const next = percentage > 2;
      return open === next ? open : next;
    });
  }, [setRightPaneOpen]);

  const openTodosPane = useCallback(() => {
    setBottomDockTab("todos");
    setBottomDockOpen(true);
  }, [setBottomDockOpen, setBottomDockTab]);

  const toggleTodosPane = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    if (ui.bottomDockOpen && ui.bottomDockTab === "todos") {
      setBottomDockOpen(false);
      return;
    }
    openTodosPane();
  }, [openTodosPane, setBottomDockOpen, workspaceInstanceId]);

  const toggleBookmarkAtCursor = useCallback(() => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file) {
      setStatusMessage("Open a file to toggle bookmarks");
      return;
    }
    const position = editorSelectionRef.current.end;
    const lineText = file.text.split("\n")[position.line] ?? "";
    const label = lineText.trim() || `${file.title}:${position.line + 1}`;
    const next = toggleWorkspaceBookmark(workspaceInstanceId, {
      fileKey: file.key,
      pathLabel: file.subtitle || file.path,
      line: position.line,
      character: position.character,
      label,
    }, bookmarks);
    setBookmarks(next);
    setStatusMessage(next.some((item) => item.fileKey === file.key && item.line === position.line)
      ? `Bookmarked line ${position.line + 1}`
      : `Removed bookmark on line ${position.line + 1}`);
    openTodosPane();
  }, [activeKey, openTodosPane, setStatusMessage, bookmarks, workspaceInstanceId]);

  const removeBookmark = useCallback((id: string) => {
    const next = bookmarks.filter((item) => item.id !== id);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    setBookmarks(next);
  }, [bookmarks, workspaceInstanceId]);


  const workspaceCommands = useMemo<WorkspaceCommand[]>(() => [
    {
      id: "workspace.goToFile",
      title: "Go to File",
      category: "Navigation",
      keybinding: "Ctrl+Shift+N",
      keybindings: ["Ctrl+P"],
      keywords: ["search everywhere", "file", "open"],
      run: () => openSearchEverywhere("files"),
    },
    {
      id: "workspace.goToClass",
      title: "Go to Class",
      category: "Navigation",
      keybinding: "Ctrl+N",
      keywords: ["type", "interface", "struct"],
      when: () => seSymbolsAvailable,
      run: () => openSearchEverywhere("classes"),
    },
    {
      id: "workspace.goToSymbol",
      title: "Go to Symbol",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Shift+N",
      keywords: ["workspace symbol"],
      when: () => seSymbolsAvailable,
      run: () => openSearchEverywhere("symbols"),
    },
    {
      id: "workspace.searchEverywhere",
      title: "Search Everywhere",
      category: "Navigation",
      keywords: ["double shift", "all"],
      run: () => openSearchEverywhere("all"),
    },
    {
      id: "workspace.recentFiles",
      title: "Recent Files",
      category: "Navigation",
      keybinding: "Ctrl+E",
      keywords: ["previous", "history"],
      run: () => {
        if (recentFilesOpen) setRecentAdvanceNonce((nonce) => nonce + 1);
        else openRecentFiles();
      },
    },
    {
      id: "workspace.navigateBack",
      title: "Navigate Back",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Left",
      // Also accept Alt+Left (common IDEA keymap variant) when history is available.
      keybindings: ["Alt+Left"],
      when: () => navCan.back,
      run: () => navigateHistory(-1),
    },
    {
      id: "workspace.navigateForward",
      title: "Navigate Forward",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Right",
      keybindings: ["Alt+Right"],
      when: () => navCan.forward,
      run: () => navigateHistory(1),
    },
    {
      id: "workspace.findInFiles",
      title: "Find in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+F",
      keywords: ["text", "content", "grep"],
      run: openFindInFiles,
    },
    {
      id: "workspace.replaceInFiles",
      title: "Replace in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+R",
      keywords: ["bulk replace"],
      run: () => {
        openFindInFiles();
        setStatusMessage("Enter a replace string and use Replace All in Find in Files");
      },
    },
    {
      id: "workspace.fileStructure",
      title: "File Structure",
      category: "Navigation",
      keybinding: "Ctrl+F12",
      keywords: ["outline", "symbol"],
      when: () => !!activeFile,
      run: () => void openStructurePopup(),
    },
    {
      id: "workspace.format",
      title: "Format Document",
      category: "Code",
      keybinding: "Ctrl+Alt+L",
      keywords: ["format", "prettier", "indent"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        if (!activeFile || activeFile.loading) return false;
        // Prefer capability gate when status is known; if LSP has not
        // reported yet, still allow the command so the shortcut is live
        // as soon as the buffer is open (formatActiveFile no-ops without a formatter).
        if (!activeCapabilities) return true;
        return !!(activeCapabilities.formatting || activeCapabilities.rangeFormatting);
      },
      run: () => void formatActiveFile(),
    },
    {
      id: "workspace.toggleFormatOnSave",
      title: `${intelligencePreferences.formatOnSave ? "Disable" : "Enable"} Format on Save`,
      category: "Code",
      keywords: ["format", "save", "workspace"],
      run: () => setFormatOnSave(!intelligencePreferences.formatOnSave),
    },
    {
      id: "workspace.quickDocumentation",
      title: "Quick Documentation",
      category: "Code",
      keybinding: "Ctrl+Q",
      keybindings: ["F1"],
      keywords: ["docs", "hover", "javadoc"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!activeFile && !activeFile.loading,
      run: () => void openQuickDocumentation(),
    },
    {
      id: "workspace.codeActions",
      title: "Show Code Actions / Quick Fix",
      category: "Code",
      keybinding: "Alt+Enter",
      keywords: ["quickfix", "bulb", "intention"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!activeFile && !activeFile.loading,
      run: () => void openCodeActionsAtCursor(),
    },
    {
      id: "workspace.gotoTypeDefinition",
      title: "Go to Type Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+B",
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && (!activeCapabilities || !!activeCapabilities.typeDefinition),
      run: () => {
        const file = activeFile;
        if (!file) return;
        void goToTypeDefinitionRef.current(file, editorSelectionRef.current.start);
      },
    },
    {
      id: "workspace.gotoImplementation",
      title: "Go to Implementation",
      category: "Navigation",
      keybinding: "Ctrl+Alt+B",
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && (!activeCapabilities || !!activeCapabilities.implementation),
      run: () => {
        const file = activeFile;
        if (!file) return;
        void goToImplementationRef.current(file, editorSelectionRef.current.start);
      },
    },
    {
      id: "workspace.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      keybinding: "Shift+F6",
      keywords: ["refactor", "rename"],
      when: (context) => context.focus === "editor" && !!activeFile && !activeFile.loading
        && (!activeCapabilities || !!activeCapabilities.rename),
      run: () => void renameSymbolRef.current(),
    },
    {
      id: "workspace.toggleProjectTree",
      title: languagePanelOpen ? "Hide Project Tree" : "Show Project Tree",
      category: "View",
      keybinding: "Alt+1",
      keywords: ["project", "explorer", "files", "tree", "sidebar", "collapse"],
      run: toggleProjectTree,
    },
    {
      id: "workspace.toggleDocumentationPane",
      title: "Toggle Outline Pane",
      category: "View",
      keywords: ["right", "outline", "structure", "symbols"],
      run: toggleOutlinePane,
    },
    {
      id: "workspace.callHierarchy",
      title: "Call Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+Alt+H",
      keywords: ["callers", "callees", "calls"],
      when: (context) => context.focus === "editor" && !!activeFile
        && !!activeCapabilities?.callHierarchy,
      run: () => void openHierarchy("call"),
    },
    {
      id: "workspace.typeHierarchy",
      title: "Type Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+H",
      keywords: ["supertypes", "subtypes", "inheritance"],
      when: (context) => context.focus === "editor" && !!activeFile
        && !!activeCapabilities?.typeHierarchy,
      run: () => void openHierarchy("type"),
    },
    {
      id: "workspace.toggleTodosPane",
      title: "Toggle TODOs / Bookmarks",
      category: "View",
      keywords: ["todo", "fixme", "bookmark", "markers"],
      run: toggleTodosPane,
    },
    {
      id: "workspace.toggleBookmark",
      title: "Toggle Bookmark",
      category: "Edit",
      keybinding: "F11",
      keywords: ["bookmark", "mark", "line"],
      when: (context) => context.focus === "editor" && !!activeFile && !activeFile.loading,
      run: toggleBookmarkAtCursor,
    },
    {
      id: "workspace.toggleInlayHints",
      title: `${intelligencePreferences.inlayHintsEnabled ? "Disable" : "Enable"} Inlay Hints`,
      category: "View",
      keywords: ["inlay", "hints", "types", "parameters"],
      run: toggleInlayHints,
    },
    {
      id: "workspace.toggleLanguageInlayHints",
      title: `${activeInlayHintsEnabled ? "Disable" : "Enable"} Inlay Hints for ${activeLanguageId ?? "Current Language"}`,
      category: "View",
      keywords: ["inlay", "language", "hints"],
      when: () => !!activeCapabilities?.inlayHint,
      run: toggleInlayHintsForActiveLanguage,
    },
    {
      id: "workspace.toggleInlineBlame",
      title: `${intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} Inline Git Blame`,
      category: "Git",
      keywords: ["git", "blame", "author", "line"],
      when: () => !!activeGitRoot,
      run: toggleInlineBlame,
    },
    {
      id: "workspace.toggleTerminal",
      title: "Toggle Workspace Terminal",
      category: "View",
      keybinding: "Alt+F12",
      keywords: ["terminal", "shell", "bottom"],
      run: () => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
        if (ui.bottomDockOpen && ui.bottomDockTab === "terminal") {
          setBottomDockOpen(false);
        } else {
          setBottomDockTab("terminal");
          setBottomDockOpen(true);
          terminalDockRef.current?.focus();
        }
      },
    },
    {
      id: "workspace.showRunTasks",
      title: "Show Run Tasks",
      category: "Run",
      keywords: ["run", "task", "script"],
      run: () => {
        setBottomDockTab("run");
        setBottomDockOpen(true);
      },
    },
    {
      id: "workspace.rerunLastTask",
      title: "Rerun Last Task",
      category: "Run",
      keybinding: "Ctrl+F5",
      keywords: ["run", "rerun", "repeat"],
      run: () => {
        if (!runPanelRef.current?.rerunLast()) setStatusMessage("No workspace task has run yet");
      },
    },
    {
      id: "workspace.save",
      title: "Save Active File",
      category: "File",
      keybinding: "Ctrl+S",
      when: () => !!activeFile?.dirty && !activeFile.loading && !activeFile.saving,
      run: () => void saveFile(),
    },
    {
      id: "workspace.closeActiveEditorTab",
      title: "Close Active Editor Tab",
      category: "File",
      keybinding: "Ctrl+F4",
      when: () => !!activeKey,
      run: () => {
        if (activeKey) void closeFile(activeKey, activeEditorGroupId);
      },
    },
    {
      id: "workspace.revealActiveFileInTree",
      title: "Reveal Active File in Project Tree",
      category: "Navigation",
      keybinding: "Alt+F1",
      when: () => !!activeKey,
      run: () => {
        if (activeKey) revealEditorTabInTree(activeKey);
      },
    },
    {
      id: "workspace.reload",
      title: "Reload Active File",
      category: "File",
      when: () => !!activeFile && !activeFile.loading,
      run: () => void reloadFile(),
    },
    {
      id: "workspace.refreshTree",
      title: "Refresh Project Tree",
      category: "File",
      run: refreshTree,
    },
    {
      id: "workspace.openGit",
      title: "Open Git Manager",
      category: "Git",
      when: () => !gitRootsLoading && !!onOpenGitManager && gitRoots.length > 0,
      run: openGitManager,
    },
    {
      id: "workspace.tree.openLooseFile",
      title: "Open Loose File",
      category: "File",
      run: () => void openLooseFile(),
    },
    {
      id: "workspace.tree.addFolder",
      title: "Add Folder to Workspace",
      category: "File",
      run: () => void addRoot(),
    },
    {
      id: "workspace.tree.open",
      title: "Open Selected File",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        const selection = payload?.selection ?? selected;
        if (selection?.kind === "file") void openFile(selection.ref);
      },
    },
    {
      id: "workspace.tree.newFile",
      title: "New File",
      category: "File",
      when: (context) => context.focus !== "tree" || !!selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void createFile(payload?.directory);
      },
    },
    {
      id: "workspace.tree.newDirectory",
      title: "New Directory",
      category: "File",
      when: (context) => context.focus !== "tree" || !!selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void createDir(payload?.directory);
      },
    },
    {
      id: "workspace.tree.rename",
      title: "Rename Tree Selection",
      category: "Refactor",
      keybinding: "F2",
      when: (context) => context.focus === "tree" && !!((context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? selected),
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void renameSelected(payload?.selection);
      },
    },
    {
      id: "workspace.tree.delete",
      title: "Delete or Remove Tree Selection",
      category: "File",
      keybinding: "Delete",
      when: (context) => context.focus === "tree" && !!((context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? selected),
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void deleteSelected(payload?.selection);
      },
    },
    {
      id: "workspace.tree.addToGitignore",
      title: "Add Tree Selection to .gitignore",
      category: "Git",
      keywords: ["git", "ignore", "exclude"],
      when: (context) => {
        const selection = (context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? selected;
        return context.focus === "tree" && (
          selection?.kind === "dir"
          || (selection?.kind === "file" && selection.ref.kind === "root")
        );
      },
      run: (context) => {
        const selection = (context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? selected;
        if (selection?.kind === "dir") {
          void ignoreWorkspacePath(selection.rootId, selection.path, true);
        } else if (selection?.kind === "file" && selection.ref.kind === "root") {
          void ignoreWorkspacePath(selection.ref.rootId, selection.ref.path, false);
        }
      },
    },
    {
      id: "workspace.tree.findInDirectory",
      title: "Find in Selected Directory",
      category: "Search",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        findInDirectory(payload?.path ?? "");
      },
    },
    {
      id: "workspace.tree.copyPath",
      title: "Copy Absolute Path",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        if (payload?.rootId !== undefined && payload.path !== undefined) {
          void copyTreePath(payload.rootId, payload.path, true);
        }
      },
    },
    {
      id: "workspace.tree.copyRelativePath",
      title: "Copy Relative Path",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        if (payload?.rootId !== undefined && payload.path !== undefined) {
          void copyTreePath(payload.rootId, payload.path, false);
        }
      },
    },
  ], [
    activeCapabilities,
    activeEditorGroupId,
    activeFile,
    activeGitRoot,
    activeKey,
    activeInlayHintsEnabled,
    activeLanguageId,
    addRoot,
    closeFile,
    copyTreePath,
    createDir,
    createFile,
    deleteSelected,
    findInDirectory,
    formatActiveFile,
    gitRoots.length,
    gitRootsLoading,
    ignoreWorkspacePath,
    navCan.back,
    navCan.forward,
    navigateHistory,
    onOpenGitManager,
    openCodeActionsAtCursor,
    openFile,
    openFindInFiles,
    openGitManager,
    openHierarchy,
    openLooseFile,
    openQuickDocumentation,
    openRecentFiles,
    openSearchEverywhere,
    openStructurePopup,
    recentFilesOpen,
    refreshTree,
    reloadFile,
    revealEditorTabInTree,
    renameSelected,
    saveFile,
    seSymbolsAvailable,
    selected,
    selectedRootDirectory,
    intelligencePreferences.inlayHintsEnabled,
    intelligencePreferences.inlineBlameEnabled,
    intelligencePreferences.formatOnSave,
    setFormatOnSave,
    toggleInlayHints,
    toggleInlayHintsForActiveLanguage,
    toggleInlineBlame,
    toggleBookmarkAtCursor,
    languagePanelOpen,
    toggleProjectTree,
    toggleOutlinePane,
    toggleTodosPane,
  ]);

  const executeWorkspaceCommand = useCallback((
    commandId: string,
    context: WorkspaceCommandContext = { focus: "workspace" },
  ) => runWorkspaceCommand(workspaceCommands, commandId, context), [workspaceCommands]);
  workspaceCommandRunnerRef.current = executeWorkspaceCommand;

  const commandFocusForTarget = useCallback((target: EventTarget | null): WorkspaceCommandFocus => {
    const node = target instanceof Node ? target : null;
    if (!node) return "workspace";
    // Terminal dock (M3) marks itself with data-workspace-focus="terminal".
    const el = node instanceof Element ? node : node.parentElement;
    if (el?.closest('[data-workspace-focus="terminal"]')) return "terminal";
    if (treePaneRef.current?.contains(node)) return "tree";
    if (editorPaneRef.current?.contains(node)) return "editor";
    return "workspace";
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleWorkspaceCommand = (event: KeyboardEvent) => {
      dispatchWorkspaceCommandKeydown(
        workspaceCommands,
        { focus: commandFocusForTarget(event.target) },
        event,
      );
    };
    window.addEventListener("keydown", handleWorkspaceCommand, true);
    return () => window.removeEventListener("keydown", handleWorkspaceCommand, true);
  }, [commandFocusForTarget, visible, workspaceCommands]);

  const searchableWorkspaceCommands = useMemo(
    () => workspaceCommands.filter((command) => (
      command.id !== "workspace.goToFile"
      && workspaceCommandEnabled(command, { focus: "workspace" })
    )),
    [workspaceCommands],
  );

  const runSearchEverywhereCommand = useCallback((commandId: string) => {
    setSearchEverywhereOpen(false);
    executeWorkspaceCommand(commandId);
  }, [executeWorkspaceCommand]);

  const commandRegistration = useMemo<WorkspaceCommandRegistration>(() => ({
    items: workspaceCommandMenuItems(workspaceCommands, { focus: "workspace" }),
    execute: (commandId) => executeWorkspaceCommand(commandId),
  }), [executeWorkspaceCommand, workspaceCommands]);

  useEffect(() => {
    if (!onCommandsChange) return;
    onCommandsChange(tabId, commandRegistration);
  }, [commandRegistration, onCommandsChange, tabId]);

  useEffect(() => {
    if (!onCommandsChange) return;
    return () => onCommandsChange(tabId, null);
  }, [onCommandsChange, tabId]);

  const getLspCompletions = useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string | null,
    ): Promise<LspCompletionResult | null> => {
      // Always resolve against the live buffer (openFilesRef), not the React
      // prop — typing is batched into the store and the prop is often one
      // burst behind CodeMirror. Force-flush didChange so the server sees the
      // same text the caret is in (IDEA-like: no empty popup mid-edit).
      // Bail before any wait loop when this buffer has no usable language server.
      if (!shouldLiveSyncLsp(file.languagePath, lspFilesRef.current[file.key])) return null;
      const live = await ensureLspDocumentSynced(file.key);
      if (!live) return null;
      if (!isLspFeatureReady(lspFilesRef.current[live.key])) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      const epoch = lspDocumentEpochRef.current[live.key] ?? 0;
      try {
        const result = await lspCompletion(descriptor, position, triggerCharacter);
        // Drop only when the buffer moved again while IPC was in flight; CM
        // re-queries on the next keystroke / incomplete list.
        if (!openFilesRef.current[live.key]) return null;
        if (openFilesRef.current[live.key]?.text !== live.text) return null;
        if (lspDocumentEpochRef.current[live.key] !== epoch) return null;
        updateLspStatusForFile(live, result.status);
        return result;
      } catch {
        return null;
      }
    },
    [
      ensureLspDocumentSynced,
      lspDescriptorForFile,
      updateLspStatusForFile,
    ],
  );

  const resolveLspCompletion = useCallback(
    async (file: OpenFileState, raw: unknown): Promise<LspCompletionItem | null> => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        return await lspCompletionResolve(descriptor, raw);
      } catch {
        return null;
      }
    },
    [lspDescriptorForFile],
  );

  const getLspSignatureHelp = useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string | null,
    ): Promise<LspSignatureHelpResult | null> => {
      if (!shouldLiveSyncLsp(file.languagePath, lspFilesRef.current[file.key])) return null;
      const live = await ensureLspDocumentSynced(file.key);
      if (!live) return null;
      if (!isLspFeatureReady(lspFilesRef.current[live.key])) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      try {
        const result = await lspSignatureHelp(descriptor, position, triggerCharacter);
        if (!openFilesRef.current[live.key] || openFilesRef.current[live.key]?.text !== live.text) {
          return null;
        }
        updateLspStatusForFile(live, result.status);
        return result;
      } catch {
        return null;
      }
    },
    [ensureLspDocumentSynced, lspDescriptorForFile, updateLspStatusForFile],
  );

  const getLspHover = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        const result = await lspHover(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return result.contents;
      } catch (err) {
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            error: errorMessage(err),
          },
        }));
        return null;
      }
    },
    [lspDescriptorForFile, updateLspStatusForFile],
  );

  const navigateLocations = useCallback(async (
    title: string,
    locations: LspLocation[],
    emptyMessage: string,
  ) => {
    if (!locations.length) {
      setStatusMessage(emptyMessage);
      return false;
    }
    if (locations.length === 1) {
      setLocationPeek(null);
      return openLspLocation(locations[0]);
    }
    setLocationPeek({ title, locations });
    return true;
  }, [openLspLocation, setStatusMessage]);

  const goToDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      // Record the origin code focus before jumping (IDEA Navigate Back).
      recordNavigationLocation(file.ref, position);
      try {
        const result = await lspDefinition(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return navigateLocations("Definitions", result.locations, "No definition found");
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
  );

  const goToTypeDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      const caps = lspFilesRef.current[file.key]?.status?.capabilities;
      if (caps && !caps.typeDefinition) {
        setStatusMessage("Type definition is not supported by this language server");
        return false;
      }
      recordNavigationLocation(file.ref, position);
      try {
        const result = await lspTypeDefinition(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return navigateLocations("Type definitions", result.locations, "No type definition found");
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
  );

  const goToImplementation = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      const caps = lspFilesRef.current[file.key]?.status?.capabilities;
      if (caps && !caps.implementation) {
        setStatusMessage("Go to implementation is not supported by this language server");
        return false;
      }
      recordNavigationLocation(file.ref, position);
      try {
        const result = await lspImplementation(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return navigateLocations("Implementations", result.locations, "No implementation found");
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
  );
  goToTypeDefinitionRef.current = goToTypeDefinition;
  goToImplementationRef.current = goToImplementation;

  const renameSymbolAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.rename) {
      setStatusMessage("Rename is not supported by this language server");
      return;
    }
    const position = editorSelectionRef.current.start;
    try {
      const prepared = await lspPrepareRename(descriptor, position);
      updateLspStatusForFile(file, prepared.status);
      if (!prepared.allowed && prepared.range == null && !prepared.placeholder) {
        setStatusMessage(prepared.message ?? "Cannot rename symbol here");
        return;
      }
      const defaultName = prepared.placeholder
        ?? (() => {
          const lines = file.text.split("\n");
          const line = lines[position.line] ?? "";
          if (prepared.range) {
            return line.slice(prepared.range.start.character, prepared.range.end.character);
          }
          return line.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0] ?? "";
        })();
      const nextName = await promptAppDialog({
        title: "Rename Symbol",
        label: "New name",
        initialValue: defaultName,
        confirmLabel: "Rename",
      });
      if (!nextName || nextName === defaultName) return;
      const renamed = await lspRename(descriptor, position, nextName);
      updateLspStatusForFile(file, renamed.status);
      if (!renamed.edit.documentEdits.length) {
        setStatusMessage("Rename produced no edits");
        return;
      }
      const fileCount = renamed.edit.documentEdits.length;
      if (fileCount > 1) {
        const confirmed = await confirmAppDialog({
          title: "Rename across files",
          message: `This rename touches ${fileCount} files. Apply non-atomic WorkspaceEdit?`,
          confirmLabel: "Apply",
        });
        if (!confirmed) return;
      }
      await applyLspWorkspaceEdit(renamed.edit);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [activeFile, applyLspWorkspaceEdit, lspDescriptorForFile, setStatusMessage, updateLspStatusForFile]);
  renameSymbolRef.current = renameSymbolAtCursor;

  const findReferences = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      setBottomDockOpen(true);
      setBottomDockTab("references");
      setReferencesResult({
        loading: true,
        origin: file.subtitle,
        locations: [],
        error: null,
      });
      try {
        const result = await lspReferences(descriptor, position, true);
        updateLspStatusForFile(file, result.status);
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: result.locations,
          error: null,
        });
        setStatusMessage(`${result.locations.length} reference${result.locations.length === 1 ? "" : "s"} found`);
      } catch (err) {
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: errorMessage(err),
        });
      }
    },
    [lspDescriptorForFile, setStatusMessage, updateLspStatusForFile],
  );

  const showEditorContextMenu = useCallback((
    file: OpenFileState,
    request: EditorContextMenuRequest,
  ) => {
    // Keep selection/cursor in sync for commands that read editorSelectionRef.
    editorSelectionRef.current = {
      start: request.selectionStart,
      end: request.selectionEnd,
      empty: !request.hasSelection,
      text: request.selectedText,
      rect: null,
    };
    const status = lspFilesRef.current[file.key]?.status;
    const capabilities = status?.capabilities ?? null;
    const lspAvailable = !!(status?.active || status?.available);
    const range: LspRange = {
      start: request.selectionStart,
      end: request.selectionEnd,
    };

    openEditorContextMenuAt(
      request.clientX,
      request.clientY,
      buildEditorContextMenuItems({
        capabilities,
        hasSelection: request.hasSelection,
        clientX: request.clientX,
        clientY: request.clientY,
        lspAvailable,
        // Read through the ref: the debug hook is declared later in this
        // component, and menu construction happens at click time.
        debug: (() => {
          const session = debugRef.current;
          if (!session?.state || session.state.status === "terminated") return null;
          return {
            canRunToCursor: session.state.status === "stopped",
            runToCursor: () => {
              const absolute = absolutePathForOpenFile(file);
              if (absolute) session.runToCursor(normalizeFsPath(absolute), request.position.line + 1);
            },
          };
        })(),
        actions: {
          goToDefinition: () => { void goToDefinition(file, request.position); },
          goToTypeDefinition: () => { void goToTypeDefinition(file, request.position); },
          goToImplementation: () => { void goToImplementation(file, request.position); },
          findReferences: () => { void findReferences(file, request.position); },
          callHierarchy: () => { void openHierarchy("call"); },
          typeHierarchy: () => { void openHierarchy("type"); },
          rename: () => { void renameSymbolAtCursor(); },
          quickDocumentation: () => { void openQuickDocumentation(); },
          codeActions: (x, y) => {
            const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
              item.range.start.line === request.position.line
              || item.range.end.line === request.position.line
            ));
            void showCodeActionsMenu(x, y, file, range, diagnostics);
          },
          format: () => { void formatActiveFile(); },
          cut: request.cut,
          copy: request.copy,
          paste: request.paste,
        },
      }),
    );
  }, [
    absolutePathForOpenFile,
    findReferences,
    formatActiveFile,
    goToDefinition,
    goToImplementation,
    goToTypeDefinition,
    openEditorContextMenuAt,
    openHierarchy,
    openQuickDocumentation,
    renameSymbolAtCursor,
    showCodeActionsMenu,
  ]);

  const deferredActiveFile = activeKey ? deferredOpenFiles[activeKey] ?? activeFile : null;
  const dirtyCount = useMemo(
    () => Object.values(deferredOpenFiles).filter((file) => file.dirty).length,
    [deferredOpenFiles],
  );
  const dirtyFiles = useMemo(
    () => openOrder.map((key) => deferredOpenFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [deferredOpenFiles, openOrder],
  );
  const problemFiles = useMemo<ProblemFileGroup[]>(
    () => openOrder.flatMap((key) => {
      const file = deferredOpenFiles[key];
      const diagnostics = lspFiles[key]?.diagnostics ?? [];
      return file && diagnostics.length > 0
        ? [{ key, title: file.title, subtitle: file.subtitle, diagnostics }]
        : [];
    }),
    [deferredOpenFiles, lspFiles, openOrder],
  );
  // M7-C: whole-project Problems. jdtls stores diagnostics for unopened files
  // after a build; we poll the aggregate while the panel is in "project" scope
  // (push events were dropped — see lsp.rs C-1). `key` is the absolute path.
  const [problemsScope, setProblemsScope] = useState<ProblemsScope>("open");
  const [projectProblemFiles, setProjectProblemFiles] = useState<ProblemFileGroup[]>([]);
  const [projectProblemsLoading, setProjectProblemsLoading] = useState(false);
  const [rebuildingProject, setRebuildingProject] = useState(false);

  const problemPathToRef = useCallback((absPath: string): CodeWorkspaceFileRef | null => {
    for (const root of rootsRef.current) {
      const rel = relativePathWithinRoot(root.path, absPath);
      if (rel !== null && rel !== "") {
        return { kind: "root", rootId: root.id, path: rel };
      }
    }
    return null;
  }, []);

  const refreshProjectProblems = useCallback(async () => {
    try {
      const files = await lspWorkspaceDiagnostics(workspaceInstanceId);
      if (!mountedRef.current) return;
      setProjectProblemFiles(files.map((entry): ProblemFileGroup => {
        const ref = problemPathToRef(entry.path);
        const rootName = ref?.kind === "root" ? findRoot(ref.rootId)?.name : undefined;
        const subtitle = ref?.kind === "root"
          ? (rootName ? `${rootName} / ${ref.path}` : ref.path)
          : entry.path;
        return {
          key: entry.path,
          title: basename(entry.path),
          subtitle,
          diagnostics: entry.diagnostics,
        };
      }));
    } catch {
      // No active jdtls session / command unsupported: leave the list as-is.
    }
  }, [findRoot, problemPathToRef, workspaceInstanceId]);

  // Poll project diagnostics while the Problems panel is open in project scope.
  useEffect(() => {
    if (!(bottomDockOpen && bottomDockTab === "problems" && problemsScope === "project")) return;
    let cancelled = false;
    setProjectProblemsLoading(true);
    void refreshProjectProblems().finally(() => {
      if (!cancelled && mountedRef.current) setProjectProblemsLoading(false);
    });
    const timer = window.setInterval(() => void refreshProjectProblems(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bottomDockOpen, bottomDockTab, problemsScope, refreshProjectProblems]);

  const rebuildProject = useCallback(async () => {
    const root = rootsRef.current[0];
    if (!root) return;
    // A synthetic .java path selects the root's jdtls session (keyed on scope).
    const descriptor = lspDescriptorForPath(root.path, "__taomni_build__.java");
    setRebuildingProject(true);
    try {
      await lspBuildWorkspace(descriptor);
      setStatusMessage("Rebuilding project…");
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      if (mountedRef.current) setRebuildingProject(false);
    }
    // Give jdtls a beat to publish, then refresh.
    window.setTimeout(() => void refreshProjectProblems(), 1200);
  }, [lspDescriptorForPath, refreshProjectProblems, setStatusMessage]);

  const problemsScopeFiles = problemsScope === "project" ? projectProblemFiles : problemFiles;
  const activeProblemCounts = useMemo(
    () => problemsScopeFiles.reduce(
      (counts, file) => {
        for (const diagnostic of file.diagnostics) {
          if (diagnostic.severity === 1) counts.errors += 1;
          else if (diagnostic.severity === 2) counts.warnings += 1;
        }
        return counts;
      },
      { errors: 0, warnings: 0 },
    ),
    [problemsScopeFiles],
  );

  const openProblem = useCallback(
    (fileKeyValue: string, diagnostic: LspDiagnostic) => {
      // Open-file key (open scope) → reveal in place.
      const openState = openFilesRef.current[fileKeyValue];
      if (openState) {
        revealEditorLocation(openState.key, diagnostic.range);
        void openFile(openState.ref);
        return;
      }
      // Project scope: the key is an absolute path to a (possibly unopened) file.
      const ref = problemPathToRef(fileKeyValue);
      if (!ref) return;
      void openFile(ref).then(() => revealEditorLocation(fileKey(ref), diagnostic.range));
    },
    [openFile, problemPathToRef, revealEditorLocation],
  );

  // M8 E: Java test discovery + terminal run. Discovery targets the active .java
  // file; running builds a Maven/Gradle command and reuses the terminal runner.
  const activeFileIsJava = !!activeFile
    && !activeFile.library
    && activeFile.languagePath.toLowerCase().endsWith(".java");
  const [javaTestBuildTool, setJavaTestBuildTool] = useState<JavaTestBuildTool | null>(null);

  const discoverActiveJavaTests = useCallback(async () => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file) return [];
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    return javaTestDiscover(descriptor);
  }, [activeKey, lspDescriptorForFile]);

  // Detect the active file's build tool (Maven/Gradle) for the run command; only
  // while the Tests tab is open for a Java file. Cached per detection.
  useEffect(() => {
    if (!(bottomDockOpen && bottomDockTab === "tests" && activeFileIsJava && activeFile)) return;
    if (activeFile.ref.kind !== "root") {
      setJavaTestBuildTool(null);
      return;
    }
    const root = findRoot(activeFile.ref.rootId);
    if (!root) return;
    let cancelled = false;
    void workspaceTaskTree(root.path)
      .then((groups) => {
        if (cancelled) return;
        const sources = new Set(groups.map((group) => group.source));
        setJavaTestBuildTool(sources.has("Maven") ? "maven" : sources.has("Gradle") ? "gradle" : null);
      })
      .catch(() => {
        if (!cancelled) setJavaTestBuildTool(null);
      });
    return () => { cancelled = true; };
  }, [activeFile, activeFileIsJava, bottomDockOpen, bottomDockTab, findRoot]);

  const runJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || !javaTestBuildTool) return;
    const root = findRoot(file.ref.rootId);
    if (!root) return;
    const command = javaTestRunCommand(javaTestBuildTool, item, defaultRunner(javaTestBuildTool));
    runWorkspaceTask({
      id: `java-test:${item.fullName}`,
      label: `Test ${item.name}`,
      command,
      cwd: root.path,
      source: "Test",
      rootId: root.id,
      rootName: root.name,
    });
  }, [activeKey, findRoot, javaTestBuildTool, runWorkspaceTask]);

  // M9 debug-test: resolve the test's JUnit launch config (java-test) and start
  // a debug session through the DAP path.
  const debugJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    const descriptor = lspDescriptorForFile(file);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !descriptor || !absolute) return;
    void (async () => {
      try {
        const launch = await javaTestResolveLaunch(descriptor, item);
        await debugRef.current.startDebug({
          workspaceId: descriptor.workspaceId,
          rootPath: root.path,
          filePath: absolute,
          cwd: root.path,
          mainClass: launch.mainClass,
          projectName: launch.projectName,
          classPaths: launch.classPaths,
          modulePaths: launch.modulePaths,
          args: launch.args,
          vmArgs: launch.vmArgs,
        });
        setBottomDockTab("debug");
        setBottomDockOpen(true);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    })();
  }, [activeKey, findRoot, lspDescriptorForFile, absolutePathForOpenFile, setBottomDockOpen, setBottomDockTab, setStatusMessage]);

  // M9: debug session (breakpoints, stepping, variables, watch, console).
  const debug = useCodeDebugSession(workspaceInstanceId);
  // Ref so callbacks declared above the hook (debug-test) can reach it.
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const activeFileAbsPath = activeFile ? absolutePathForOpenFile(activeFile) : null;
  const debugSessionActive = !!debug.state && debug.state.status !== "terminated";
  const activeDebugBreakpoints = useMemo<DebugBreakpointMarker[]>(() => {
    if (!activeFileAbsPath) return [];
    const key = normalizeFsPath(activeFileAbsPath);
    const list = debug.breakpoints[key] ?? debug.breakpoints[activeFileAbsPath] ?? [];
    const runtime = debug.breakpointRuntime[key] ?? debug.breakpointRuntime[activeFileAbsPath] ?? {};
    return list.map((bp) => ({
      line: bp.line,
      conditional: !!(bp.condition || bp.hitCondition),
      logpoint: !!bp.logMessage,
      // Grey out breakpoints the adapter could not bind (only meaningful in-session).
      verified: !debugSessionActive || runtime[bp.line] !== false,
    }));
  }, [activeFileAbsPath, debug.breakpoints, debug.breakpointRuntime, debugSessionActive]);
  const activeDebugCurrentLine = useMemo<number | null>(() => {
    const loc = debug.currentLocation;
    if (!loc || !activeFileAbsPath) return null;
    return normalizeFsPath(loc.path) === normalizeFsPath(activeFileAbsPath) ? loc.line : null;
  }, [activeFileAbsPath, debug.currentLocation]);
  const toggleActiveBreakpoint = useCallback((line: number) => {
    if (activeFileAbsPath) debug.toggleBreakpoint(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);

  /** Right-click a breakpoint (D5): set a condition or a logpoint message. */
  const editActiveBreakpoint = useCallback((line: number) => {
    if (!activeFileAbsPath) return;
    const key = normalizeFsPath(activeFileAbsPath);
    const existing = (debug.breakpoints[key] ?? []).find((bp) => bp.line === line);
    if (!existing) debug.toggleBreakpoint(key, line); // ensure the breakpoint exists first
    void (async () => {
      const condition = await promptAppDialog({
        title: `Breakpoint at line ${line}`,
        label: "Condition (break only when true) — blank for none",
        initialValue: existing?.condition ?? "",
        allowEmpty: true,
      });
      if (condition === null) return; // cancelled
      const hitCondition = await promptAppDialog({
        title: `Breakpoint at line ${line}`,
        label: "Hit count (e.g. 5 breaks on the 5th hit) — blank for none",
        initialValue: existing?.hitCondition ?? "",
        allowEmpty: true,
      });
      if (hitCondition === null) return;
      const logMessage = await promptAppDialog({
        title: `Breakpoint at line ${line}`,
        label: "Logpoint message (logs instead of breaking; {expr} interpolates) — blank for none",
        initialValue: existing?.logMessage ?? "",
        allowEmpty: true,
      });
      if (logMessage === null) return;
      debug.setBreakpointOptions(key, line, {
        condition: condition.trim() || undefined,
        hitCondition: hitCondition.trim() || undefined,
        logMessage: logMessage.trim() || undefined,
      });
    })();
  }, [activeFileAbsPath, debug]);

  /** Build a Java launch config for the active file and start debugging. */
  const startDebugActiveFile = useCallback(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    if (!root) return;
    const absolute = absolutePathForOpenFile(file);
    if (!absolute) return;
    const descriptor = lspDescriptorForFile(file);
    void debug.startDebug({
      workspaceId: descriptor?.workspaceId ?? workspaceInstanceId,
      rootPath: root.path,
      filePath: absolute,
      cwd: root.path,
    }).catch((err) => setStatusMessage(errorMessage(err)));
    setBottomDockTab("debug");
    setBottomDockOpen(true);
  }, [activeKey, debug, findRoot, lspDescriptorForFile, absolutePathForOpenFile, setBottomDockOpen, setBottomDockTab, workspaceInstanceId]);

  const openDebugFrame = useCallback((frame: Pick<DebugStackFrame, "path" | "line">) => {
    if (!frame.path) return;
    const ref = problemPathToRef(frame.path);
    if (!ref) return;
    const range = { start: { line: frame.line - 1, character: 0 }, end: { line: frame.line - 1, character: 0 } };
    void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
  }, [openFile, problemPathToRef, revealEditorLocation]);

  // IDEA-style: jump to the stopped location (breakpoint hit / step landing)
  // automatically, once per distinct location.
  const debugRevealRef = useRef<string | null>(null);
  useEffect(() => {
    const loc = debug.currentLocation;
    if (!loc || debug.state?.status !== "stopped") {
      debugRevealRef.current = null;
      return;
    }
    const key = `${loc.path}:${loc.line}`;
    if (debugRevealRef.current === key) return;
    debugRevealRef.current = key;
    openDebugFrame({ path: loc.path, line: loc.line });
  }, [debug.currentLocation, debug.state?.status, openDebugFrame]);

  const activeFileDebuggable = !!activeFileIsJava && !!activeFile && activeFile.ref.kind === "root";

  useEffect(() => {
    if (!onSyncGitManager) return;
    onSyncGitManager(gitManagerPayload);
  }, [gitManagerPayload, onSyncGitManager]);

  useEffect(() => {
    const firstRoot = roots[0] ?? null;
    const openStates = openOrder.map((key) => deferredOpenFiles[key]).filter((file): file is OpenFileState => !!file);
    const toContextFile = (file: OpenFileState) => {
      const ref = file.ref;
      if (ref.kind === "root") {
        const root = roots.find((item) => item.id === ref.rootId);
        return {
          kind: "root" as const,
          rootId: ref.rootId,
          rootName: root?.name,
          rootPath: root?.path,
          path: ref.path,
        };
      }
      const loose = looseFiles.find((item) => item.id === ref.id);
      return {
        kind: "loose" as const,
        id: ref.id,
        name: loose?.name,
        path: ref.path,
      };
    };
    const lspDiagnostics = openStates
      .map((file) => {
        const diagnostics = lspFiles[file.key]?.diagnostics ?? [];
        if (diagnostics.length === 0) return null;
        return {
          file: toContextFile(file),
          errorCount: diagnostics.filter((item) => item.severity === 1).length,
          warningCount: diagnostics.filter((item) => item.severity === 2).length,
          infoCount: diagnostics.filter((item) => item.severity !== 1 && item.severity !== 2).length,
          messages: diagnostics
            .slice()
            .sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99))
            .slice(0, 5)
            .map((item) => item.message),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const activeStatus = activeLspState?.status
      ? {
          displayName: activeLspState.status.displayName,
          languageId: activeLspState.status.languageId,
          active: activeLspState.status.active,
          available: activeLspState.status.available,
          selectedCommand: activeLspState.status.selectedCommand,
          installHint: activeLspState.status.installHint,
          error: activeLspState.status.error ?? activeLspState.error,
        }
      : null;
    const lspContext = activeStatus || lspDiagnostics.length > 0
      ? {
          activeStatus,
          diagnostics: lspDiagnostics,
        }
      : null;
    setTabCodeWorkspaceContext(tabId, {
      repoRoot: firstRoot?.path ?? workspace.repoRoot ?? "",
      activePath: deferredActiveFile?.ref.kind === "root" && deferredActiveFile.ref.rootId === firstRoot?.id ? deferredActiveFile.ref.path : null,
      openPaths: firstRoot ? openStates.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      dirtyPaths: firstRoot ? dirtyFiles.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      roots,
      looseFiles,
      activeFile: deferredActiveFile ? toContextFile(deferredActiveFile) : null,
      openFiles: openStates.map(toContextFile),
      dirtyFiles: dirtyFiles.map(toContextFile),
      lsp: lspContext,
    });
  }, [
    activeLspState,
    deferredActiveFile,
    deferredOpenFiles,
    dirtyFiles,
    looseFiles,
    lspFiles,
    openOrder,
    roots,
    setTabCodeWorkspaceContext,
    tabId,
    workspace.repoRoot,
  ]);

  useEffect(() => {
    return () => setTabCodeWorkspaceContext(tabId, null);
  }, [setTabCodeWorkspaceContext, tabId]);

  const renderEditorGroup = (groupId: EditorGroupId) => {
    const group = editorGroups[groupId];
    const groupFile = group.activeKey ? openFiles[group.activeKey] ?? null : null;
    const groupLspState = group.activeKey ? lspFiles[group.activeKey] ?? null : null;
    const groupDiagnostics = groupLspState?.diagnostics ?? [];
    const groupCapabilities = groupLspState?.status?.capabilities ?? null;
    const groupMarkdownMode = groupFile && isMarkdownPath(groupFile.languagePath)
      ? markdownModes[groupFile.key] ?? "edit"
      : "edit";
    const groupBreadcrumbSegments = groupId === activeEditorGroupId
      ? breadcrumbPathSegments
      : groupFile ? breadcrumbSegmentsForFile(groupFile, roots) : [];

    return (
      <EditorGroup
        groupId={groupId}
        workspaceInstanceId={`${workspaceInstanceId}-${groupId}`}
        visible={visible}
        openOrder={group.openOrder}
        openFiles={openFiles}
        activeKey={group.activeKey}
        previewKey={group.previewKey}
        pinnedKeys={group.pinnedKeys}
        activeFile={groupFile}
        activeMarkdownMode={groupMarkdownMode}
        activeDiagnostics={groupDiagnostics}
        activeHighlights={highlightsByGroup[groupId]}
        activeInlayHints={inlayHintsByGroup[groupId]}
        activeSemanticTokens={semanticTokensByGroup[groupId]}
        activeGitChanges={groupFile ? gitLineChangesByFile[groupFile.key] ?? [] : []}
        activeGitBlame={gitBlameByGroup[groupId]}
        activeDebugBreakpoints={groupId === activeEditorGroupId ? activeDebugBreakpoints : undefined}
        activeDebugCurrentLine={groupId === activeEditorGroupId ? activeDebugCurrentLine : null}
        onToggleBreakpoint={groupId === activeEditorGroupId ? toggleActiveBreakpoint : undefined}
        onEditBreakpoint={groupId === activeEditorGroupId ? editActiveBreakpoint : undefined}
        activeCapabilities={groupCapabilities}
        activeLspSyncing={!!groupLspState?.syncing}
        lspStatusPill={(
          <LspStatusPill
            state={groupLspState}
            diagnostics={groupDiagnostics}
            onOpenSettings={() => openLanguageServersSettings(groupLspState?.status?.presetId)}
          />
        )}
        breadcrumbs={groupFile ? (
          <Breadcrumbs
            pathSegments={groupBreadcrumbSegments}
            symbols={breadcrumbSymbolsByGroup[groupId]}
            position={cursorPositions[groupId]}
            loadPathChildren={(segment) =>
              loadBreadcrumbPathChildren(segment, groupFile, groupBreadcrumbSegments)
            }
            onPathNavigate={(child) => navigateBreadcrumbPathChild(child, groupFile)}
            pathActionsForSegment={(segment) => breadcrumbPathActions(segment, groupFile)}
            onPathClick={(segment) => {
              // Fallback when listing is unavailable: reveal the segment in the tree.
              if (groupFile.ref.kind !== "root") return;
              const rootId = groupFile.ref.rootId;
              if (segment.kind === "root") {
                setSelected({ kind: "root", rootId });
              } else if (segment.kind === "directory") {
                setSelected({ kind: "dir", rootId, path: segment.path });
                setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
                void loadDir(rootId, segment.path);
              } else {
                setSelected({ kind: "file", ref: groupFile.ref });
              }
            }}
            onSymbolClick={(symbol) => revealEditorLocation(groupFile.key, symbol.selectionRange)}
          />
        ) : null}
        revealTarget={revealTarget}
        editorPaneRef={groupId === activeEditorGroupId ? editorPaneRef : inactiveEditorPaneRef}
        editorPaneStyle={editorPaneStyle}
        onActivate={(key) => {
          flushPendingEditorText();
          updateEditorGroup(groupId, (current) => ({ ...current, activeKey: key }));
          activateEditorGroup(groupId);
        }}
        onActivateGroup={() => activateEditorGroup(groupId)}
        onClose={(key) => void closeFile(key, groupId)}
        onPin={(key, pinned) => setTabPinned(groupId, key, pinned)}
        onPromotePreview={(key) => promotePreviewTab(groupId, key)}
        onCloseOthers={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => entry !== key && !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseRight={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          const index = latest.openOrder.indexOf(key);
          void closeGroupFiles(groupId, latest.openOrder.slice(index + 1).filter(
            (entry) => !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseUnmodified={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => !openFilesRef.current[entry]?.dirty,
          ));
        }}
        onCloseAll={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder);
        }}
        onSplitRight={(key) => splitEditor("vertical", key, groupId)}
        onSplitDown={(key) => splitEditor("horizontal", key, groupId)}
        onCopyPath={(key, absolute) => void copyEditorTabPath(key, absolute)}
        onRevealInTree={revealEditorTabInTree}
        onRevealInSystem={revealEditorTabInExplorer}
        onOpenInTerminal={openEditorTabInTerminal}
        onLocalHistory={openLocalHistoryForKey}
        onDownloadSources={(key) => void downloadLibrarySources(key)}
        downloadingSourcesKeys={downloadingSourcesKeys}
        onMarkdownModeChange={(mode) => {
          if (!groupFile) return;
          setMarkdownModes((current) => ({ ...current, [groupFile.key]: mode }));
        }}
        onChangeText={queueEditorTextUpdate}
        onSave={(key) => void saveFile(key)}
        onHover={getLspHover}
        onDefinition={goToDefinition}
        onReferences={findReferences}
        onComplete={getLspCompletions}
        onCompleteResolve={resolveLspCompletion}
        onSignatureHelp={getLspSignatureHelp}
        onSelectionChange={(selection) => {
          if (groupId === activeEditorGroupId) {
            editorSelectionRef.current = selection;
            setEditorAiSelection(!selection.empty && selection.text.trim().length >= 2 ? selection : null);
          }
          if (groupFile) {
            noteCaretPosition(groupFile.key, selection.end);
          }
          setCursorPositions((current) => ({ ...current, [groupId]: selection.end }));
        }}
        onViewportChange={(range) => {
          setViewportRanges((current) => ({ ...current, [groupId]: range }));
        }}
        onExpandSelection={getLspSelectionRanges}
        onLightbulb={(line) => void openCodeActionsForLine(line)}
        onEditorContextMenu={showEditorContextMenu}
        onOpenMarkdownHref={openMarkdownHref}
        formatBytes={formatBytes}
        formatMtime={formatMtime}
        isMarkdownPath={isMarkdownPath}
        renderMarkdownPreview={(file, onOpenHref) => (
          <MarkdownPreview file={file} onOpenHref={onOpenHref} />
        )}
      />
    );
  };

  return (
    <div
      ref={rootRef}
      data-testid="code-workspace-tab"
      className="relative h-full w-full min-h-0 flex flex-col overflow-hidden bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]"
    >
      <header className="h-10 shrink-0 flex items-center gap-2 overflow-x-auto px-3 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
        <Braces className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Code · {title}</div>
          <div className="text-[11px] text-[var(--taomni-code-muted)] truncate max-w-[620px]">
            {roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}` : "No project roots"}
            {looseFiles.length > 0 ? ` · ${looseFiles.length} loose file${looseFiles.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-accent)]">
            {dirtyCount} unsaved
          </span>
        )}
        <WorkspaceSdkStatus roots={roots} />
        <div className="flex-1" />
        {/* Project tree collapse lives on the tree toolbar / collapsed rail — avoid a
            second top-bar toggle that duplicates the panel-local control. */}
        <IconButton
          label="Back"
          testId="code-workspace-nav-back"
          icon={<ArrowLeft className="w-3.5 h-3.5" />}
          disabled={!navCan.back}
          onClick={() => executeWorkspaceCommand("workspace.navigateBack")}
        />
        <IconButton
          label="Forward"
          testId="code-workspace-nav-forward"
          icon={<ArrowRight className="w-3.5 h-3.5" />}
          disabled={!navCan.forward}
          onClick={() => executeWorkspaceCommand("workspace.navigateForward")}
        />
        <div className="flex items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1">
          <IconButton
            label="Editor zoom out"
            testId="code-workspace-zoom-out"
            icon={<ZoomOut className="w-3.5 h-3.5" />}
            disabled={codeViewProfile.fontSize <= CODE_WORKSPACE_MIN_FONT_SIZE}
            onClick={() => stepCodeViewFontSize(-1)}
          />
          <button
            type="button"
            data-testid="code-workspace-zoom-reset"
            title="Reset editor zoom"
            aria-label="Reset editor zoom"
            className="h-6 min-w-10 rounded px-1.5 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => setCodeViewFontSize(DEFAULT_CODE_VIEW_PROFILE.fontSize)}
          >
            {codeViewProfile.fontSize}px
          </button>
          <IconButton
            label="Editor zoom in"
            testId="code-workspace-zoom-in"
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            disabled={codeViewProfile.fontSize >= CODE_WORKSPACE_MAX_FONT_SIZE}
            onClick={() => stepCodeViewFontSize(1)}
          />
        </div>
        <IconButton
          label="Save"
          icon={activeFile?.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          disabled={!activeFile || !activeFile.dirty || activeFile.saving || activeFile.loading}
          onClick={() => executeWorkspaceCommand("workspace.save", { focus: "editor" })}
        />
        <IconButton
          label="Reload"
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          disabled={!activeFile || activeFile.loading}
          onClick={() => executeWorkspaceCommand("workspace.reload", { focus: "editor" })}
        />
        <IconButton
          label="Refresh tree"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={() => executeWorkspaceCommand("workspace.refreshTree")}
        />
        <IconButton
          label="Open Git tab"
          testId="code-workspace-git-panel-toggle"
          icon={gitRootsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
          disabled={gitRootsLoading || !onOpenGitManager || gitRoots.length === 0}
          onClick={() => executeWorkspaceCommand("workspace.openGit")}
        />
        <IconButton
          label="Split editor right"
          testId="code-workspace-split-right"
          icon={<Columns2 className="h-3.5 w-3.5" />}
          active={splitOrientation === "vertical"}
          disabled={!activeFile}
          onClick={() => splitEditor("vertical")}
        />
        <IconButton
          label="Split editor down"
          testId="code-workspace-split-down"
          icon={<Rows2 className="h-3.5 w-3.5" />}
          active={splitOrientation === "horizontal"}
          disabled={!activeFile}
          onClick={() => splitEditor("horizontal")}
        />
        {splitOrientation && (
          <IconButton
            label="Close editor split"
            testId="code-workspace-split-close"
            icon={<X className="h-3.5 w-3.5" />}
            onClick={closeSplit}
          />
        )}
        <IconButton
          label={`${activeInlayHintsEnabled ? "Disable" : "Enable"} inlay hints${activeLanguageId ? ` for ${activeLanguageId}` : ""}`}
          testId="code-workspace-inlay-hints-toggle"
          icon={<Braces className="h-3.5 w-3.5" />}
          active={activeInlayHintsEnabled}
          disabled={!activeCapabilities?.inlayHint}
          onClick={toggleInlayHintsForActiveLanguage}
        />
        <IconButton
          label={`${intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} inline Git blame`}
          testId="code-workspace-inline-blame-toggle"
          icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
          active={intelligencePreferences.inlineBlameEnabled}
          disabled={!activeGitRoot}
          onClick={toggleInlineBlame}
        />
        <IconButton
          label="Toggle outline pane"
          testId="code-workspace-right-pane-toggle"
          icon={<PanelRight className="w-3.5 h-3.5" />}
          active={rightPaneOpen && rightPaneTab === "outline"}
          onClick={() => executeWorkspaceCommand("workspace.toggleDocumentationPane")}
        />
      </header>

      <div className="flex-1 min-h-0 flex">
        {!languagePanelOpen && (
          <div
            data-testid="code-workspace-project-collapsed-rail"
            className="h-full w-7 shrink-0 flex flex-col items-center border-r border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
          >
            <button
              type="button"
              data-testid="code-workspace-project-expand"
              title="Show project tree"
              aria-label="Show project tree"
              className="mt-1 h-7 w-7 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
              onClick={toggleProjectTree}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <span
              className="mt-2 text-[10px] font-medium tracking-wide text-[var(--taomni-code-muted)]"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              Explorer
            </span>
          </div>
        )}
        <PanelGroup
          orientation="horizontal"
          id={`code-workspace-${workspaceInstanceId}`}
          className="flex-1 min-h-0 min-w-0"
        >
          <Panel
            panelRef={projectPanelRef}
            id="project"
            defaultSize="24%"
            minSize="12%"
            maxSize="45%"
            collapsible
            collapsedSize={0}
            onResize={handleProjectPanelResize}
            className="min-w-0"
          >
            <div
              className="h-full min-h-0 overflow-hidden"
              style={languagePanelOpen ? undefined : { display: "none" }}
            >
              <FileTreePane
                paneRef={treePaneRef}
                style={treePaneStyle}
                onKeyDown={handleTreeKeyDown}
                filter={treeFilter}
                onFilterChange={setTreeFilter}
                viewMode={treeViewMode}
                onViewModeChange={setTreeViewMode}
                fontSize={treeFontSize}
                minFontSize={CODE_WORKSPACE_MIN_TREE_FONT_SIZE}
                maxFontSize={CODE_WORKSPACE_MAX_TREE_FONT_SIZE}
                defaultFontSize={CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE}
                onFontSizeChange={setTreeFontSize}
                collapsed={!languagePanelOpen}
                onToggleCollapse={toggleProjectTree}
                onOpenFile={() => executeWorkspaceCommand("workspace.tree.openLooseFile", { focus: "tree" })}
                onAddFolder={() => executeWorkspaceCommand("workspace.tree.addFolder", { focus: "tree" })}
                canCreate={!!selectedRootDirectory}
                canMutateSelection={!!selected}
                onCreateFile={() => executeWorkspaceCommand("workspace.tree.newFile", { focus: "tree" })}
                onCreateDirectory={() => executeWorkspaceCommand("workspace.tree.newDirectory", { focus: "tree" })}
                onRename={() => executeWorkspaceCommand("workspace.tree.rename", { focus: "tree" })}
                onDelete={() => executeWorkspaceCommand("workspace.tree.delete", { focus: "tree" })}
              >
                <ProjectTree
                  roots={roots}
                  looseFiles={looseFiles}
                  directories={directories}
                  compactChains={compactChains}
                  flatFiles={flatFiles}
                  treeViewMode={treeViewMode}
                  treeFilter={treeFilter}
                  expandedRoots={expandedRoots}
                  expandedDirs={expandedDirs}
                  selected={selected}
                  activeKey={activeKey}
                  openFiles={openFiles}
                  gitChangeByRootPath={gitChangeByRootPath}
                  onToggleRoot={toggleRoot}
                  onToggleDir={toggleDir}
                  onSelect={setSelected}
                  onOpenFile={(ref, options) => { void openFile(ref, options); }}
                  onContextMenu={showTreeContextMenu}
                />
              </FileTreePane>
            </div>
          </Panel>
          <PanelResizeHandle
            data-testid="code-workspace-project-resize-handle"
            className={languagePanelOpen
              ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"
              : "hidden"}
          />
          <Panel
            id="editor"
            defaultSize={languagePanelOpen ? "56%" : "80%"}
            minSize={languagePanelOpen ? "30%" : "40%"}
            className="min-w-0"
          >
          {splitOrientation ? (
            <div data-testid="code-workspace-editor-split" className="h-full min-h-0">
              <PanelGroup
                orientation={splitOrientation === "vertical" ? "horizontal" : "vertical"}
                id={`code-workspace-editor-split-${workspaceInstanceId}`}
                className="h-full min-h-0"
              >
                <Panel id="editor-primary" defaultSize="50%" minSize="20%" className="min-h-0 min-w-0">
                  {renderEditorGroup("primary")}
                </Panel>
                <PanelResizeHandle
                  className={splitOrientation === "vertical"
                    ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"
                    : "h-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"}
                />
                <Panel id="editor-secondary" defaultSize="50%" minSize="20%" className="min-h-0 min-w-0">
                  {renderEditorGroup("secondary")}
                </Panel>
              </PanelGroup>
            </div>
          ) : renderEditorGroup("primary")}
        </Panel>
          <PanelResizeHandle
            className={rightPaneOpen
              ? "w-1 bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"
              : "hidden"}
          />
          <Panel
            panelRef={rightPanelRef}
            id="documentation"
            defaultSize="20%"
            minSize="12%"
            maxSize="40%"
            collapsible
            collapsedSize={0}
            onResize={handleRightPanelResize}
            className="min-w-0"
          >
            <aside
              data-testid="code-workspace-right-pane"
              className="h-full min-h-0 flex flex-col border-l border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
              style={rightPaneOpen ? undefined : { display: "none" }}
            >
              <div role="tablist" aria-label="Right tool window" className="flex h-8 shrink-0 items-center border-b border-[var(--taomni-code-border)] px-1">
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightPaneTab === "outline"}
                  className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10px] text-[var(--taomni-code-muted)] aria-selected:bg-[var(--taomni-code-active-line-bg)] aria-selected:text-[var(--taomni-code-text)]"
                  onClick={() => setRightPaneTab("outline")}
                >
                  <ListTree className="h-3.5 w-3.5" />
                  Outline
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightPaneTab === "documentation"}
                  className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10px] text-[var(--taomni-code-muted)] aria-selected:bg-[var(--taomni-code-active-line-bg)] aria-selected:text-[var(--taomni-code-text)]"
                  onClick={() => setRightPaneTab("documentation")}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Documentation
                </button>
                <button
                  type="button"
                  aria-label="Close right pane"
                  className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                  onClick={() => setRightPaneOpen(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div role="tabpanel" className="min-h-0 flex-1">
                {rightPaneTab === "outline" ? (
                  <OutlinePane
                    symbols={breadcrumbSymbolsByGroup[activeEditorGroupId]}
                    position={cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 }}
                    loading={!!activeFile && (!!activeLspState?.syncing || (activeCapabilities?.documentSymbol === true && !activeLspState?.status))}
                    unavailableReason={!activeFile
                      ? "Open a file to view its outline"
                      : activeCapabilities?.documentSymbol === false
                        ? "Document symbols are not supported by this language server"
                        : null}
                    onPick={pickOutlineSymbol}
                  />
                ) : (
                  <DocumentationPane
                    content={pinnedDoc}
                    locked={pinnedDocLocked}
                    onUnlock={() => setPinnedDocLocked(false)}
                    onClear={() => {
                      setPinnedDoc(null);
                      setPinnedDocLocked(false);
                    }}
                  />
                )}
              </div>
            </aside>
          </Panel>
      </PanelGroup>
      </div>
      <BottomDock
        open={bottomDockOpen}
        activeTab={bottomDockTab}
        tabs={[
          {
            id: "problems",
            label: "Problems",
            icon: <AlertTriangle className="h-3.5 w-3.5" />,
            badge: activeProblemCounts.errors > 0 || activeProblemCounts.warnings > 0 ? (
              <span className="inline-flex items-center gap-1">
                {activeProblemCounts.errors > 0 && <span className="text-red-500">{activeProblemCounts.errors}</span>}
                {activeProblemCounts.warnings > 0 && <span className="text-amber-500">{activeProblemCounts.warnings}</span>}
              </span>
            ) : undefined,
            content: (
              <ProblemsPanel
                files={problemsScopeFiles}
                onOpenProblem={openProblem}
                onQuickFix={(fileKey, diagnostic) => void openQuickFixForProblem(fileKey, diagnostic)}
                scope={problemsScope}
                onScopeChange={setProblemsScope}
                onRebuild={() => void rebuildProject()}
                rebuilding={rebuildingProject}
                loading={problemsScope === "project" && projectProblemsLoading}
              />
            ),
          },
          {
            id: "search",
            label: "Search",
            icon: <Search className="h-3.5 w-3.5" />,
            content: (
              <FindInFilesPanel
                roots={roots}
                workspaceInstanceId={workspaceInstanceId}
                focusNonce={searchFocusNonce}
                includePreset={searchIncludePreset}
                queryPreset={searchQueryPreset}
                onOpenMatch={openSearchMatch}
                onReplaceMatches={async (matches, replacement) => {
                  const edit = buildReplaceWorkspaceEdit(matches, replacement);
                  await applyLspWorkspaceEdit(edit);
                }}
              />
            ),
          },
          {
            id: "references",
            label: "References",
            icon: <ListTree className="h-3.5 w-3.5" />,
            badge: referencesResult.locations.length,
            content: (
              <ReferencesPanel
                result={referencesResult}
                roots={roots}
                onOpenLocation={(location) => void openLspLocation(location)}
              />
            ),
          },
          {
            id: "call-hierarchy",
            label: "Call Hierarchy",
            icon: <GitFork className="h-3.5 w-3.5" />,
            content: (
              <HierarchyPanel
                mode="call"
                root={callHierarchyRoot}
                active={bottomDockOpen && bottomDockTab === "call-hierarchy"}
                onOpenLocation={(location) => void openLspLocation(location)}
                onStatus={(status) => {
                  if (activeFile) updateLspStatusForFile(activeFile, status);
                }}
              />
            ),
          },
          {
            id: "type-hierarchy",
            label: "Type Hierarchy",
            icon: <Network className="h-3.5 w-3.5" />,
            content: (
              <HierarchyPanel
                mode="type"
                root={typeHierarchyRoot}
                active={bottomDockOpen && bottomDockTab === "type-hierarchy"}
                onOpenLocation={(location) => void openLspLocation(location)}
                onStatus={(status) => {
                  if (activeFile) updateLspStatusForFile(activeFile, status);
                }}
              />
            ),
          },
          {
            id: "todos",
            label: "TODOs",
            icon: <ListTodo className="h-3.5 w-3.5" />,
            badge: (openFileTodos.length + bookmarks.length) > 0 ? (openFileTodos.length + bookmarks.length) : undefined,
            content: (
              <TodosBookmarksPanel
                todos={openFileTodos}
                bookmarks={bookmarks}
                onOpenTodo={(item) => void openTodoOrBookmark(item)}
                onOpenBookmark={(item) => void openTodoOrBookmark(item)}
                onRemoveBookmark={removeBookmark}
              />
            ),
          },
          {
            id: "terminal",
            label: "Terminal",
            icon: <TerminalSquare className="h-3.5 w-3.5" />,
            badge: undefined,
            content: (
              <TerminalDockPanel
                ref={terminalDockRef}
                workspaceInstanceId={workspaceInstanceId}
                roots={roots}
                defaultCwd={activeRoot?.path ?? roots[0]?.path ?? ""}
                active={bottomDockOpen && bottomDockTab === "terminal"}
              />
            ),
          },
          {
            id: "run",
            label: "Run",
            icon: <Play className="h-3.5 w-3.5" />,
            content: (
              <RunPanel
                ref={runPanelRef}
                workspaceInstanceId={workspaceInstanceId}
                roots={roots}
                active={bottomDockOpen && bottomDockTab === "run"}
                onRun={runWorkspaceTask}
              />
            ),
          },
          {
            id: "build",
            label: "Build",
            icon: <Hammer className="h-3.5 w-3.5" />,
            content: (
              <BuildPanel
                workspaceInstanceId={workspaceInstanceId}
                roots={roots}
                active={bottomDockOpen && bottomDockTab === "build"}
                onRunTask={(task) => runWorkspaceTask(task)}
                onLoadModules={(rootPath) =>
                  // A synthetic .java path selects the root's jdtls session
                  // (session keys on project scope, not on the file existing).
                  lspJavaModules(lspDescriptorForPath(rootPath, "__taomni_modules__.java"))}
              />
            ),
          },
          {
            id: "tests",
            label: "Tests",
            icon: <FlaskConical className="h-3.5 w-3.5" />,
            content: (
              <TestsPanel
                activeFileTitle={activeFileIsJava ? activeFile?.title ?? null : null}
                canDiscover={activeFileIsJava}
                active={bottomDockOpen && bottomDockTab === "tests"}
                onDiscover={discoverActiveJavaTests}
                onRun={runJavaTest}
                onDebug={debugJavaTest}
                runDisabled={javaTestBuildTool === null}
              />
            ),
          },
          {
            id: "debug",
            label: "Debug",
            icon: <Bug className="h-3.5 w-3.5" />,
            content: (
              <DebugPanel
                debug={debug}
                onStart={activeFileDebuggable ? startDebugActiveFile : null}
                onOpenFrame={openDebugFrame}
              />
            ),
          },
        ]}
        onOpenChange={setBottomDockOpen}
        onActiveTabChange={(tab) => setBottomDockTab(tab as BottomDockTabId)}
      />
      <WorkspacePopupsHost
        searchEverywhereOpen={searchEverywhereOpen}
        searchEverywhereMode={searchEverywhereMode}
        goToFileItems={goToFileItems}
        goToFileLoading={goToFileLoading}
        goToFileTruncated={goToFileTruncated}
        searchableCommands={searchableWorkspaceCommands}
        symbolsAvailable={seSymbolsAvailable}
        fetchWorkspaceSymbols={fetchWorkspaceSymbols}
        onCloseSearchEverywhere={() => setSearchEverywhereOpen(false)}
        onOpenFileItem={openGoToFileItem}
        onOpenSymbol={(symbol) => void openWorkspaceSymbol(symbol)}
        onRunCommand={runSearchEverywhereCommand}
        onSearchText={(query) => {
          setSearchEverywhereOpen(false);
          setBottomDockOpen(true);
          setBottomDockTab("search");
          setSearchFocusNonce((nonce) => nonce + 1);
          setSearchQueryPreset((current) => ({ value: query, nonce: current.nonce + 1 }));
        }}
        recentFilesOpen={recentFilesOpen}
        recentEntries={recentEntries}
        recentAdvanceNonce={recentAdvanceNonce}
        onCloseRecent={() => setRecentFilesOpen(false)}
        onPickRecent={pickRecentFile}
        structureOpen={structureOpen}
        structureFileTitle={activeFile?.title ?? null}
        structureSymbols={structureSymbols}
        structureLoading={structureLoading}
        structureUnavailable={structureUnavailable}
        onCloseStructure={() => setStructureOpen(false)}
        onPickStructure={pickStructureSymbol}
        quickDocOpen={quickDocOpen}
        quickDocContent={quickDocContent}
        onCloseQuickDoc={() => setQuickDocOpen(false)}
        onPinQuickDoc={pinQuickDocumentation}
        locationPeek={locationPeek}
        onCloseLocationPeek={() => setLocationPeek(null)}
        onOpenLocation={(location) => {
          setLocationPeek(null);
          void openLspLocation(location);
        }}
      />
      {treeContextMenu}
      {editorContextMenu}
      {localHistoryTarget && openFiles[localHistoryTarget.key] && (
        <LocalHistoryDialog
          path={localHistoryTarget.path}
          currentText={openFiles[localHistoryTarget.key].text}
          onClose={() => setLocalHistoryTarget(null)}
          onRestore={(text) => restoreLocalHistoryText(localHistoryTarget.key, text)}
        />
      )}
      <EditorSelectionAiToolbar
        visible={!!editorAiSelection && !aiRewriteState}
        rect={editorAiSelection?.rect ?? null}
        selectionText={editorAiSelection?.text ?? ""}
        onAction={(action, text) => {
          void handleEditorAiAction(action, text);
        }}
        onDismiss={() => setEditorAiSelection(null)}
      />
      {aiRewriteState && (
        <EditorAiRewriteDialog
          path={aiRewriteState.path}
          original={aiRewriteState.original}
          proposal={aiRewriteState.proposal}
          instruction={aiRewriteState.instruction}
          onInstructionChange={(value) => setAiRewriteState((current) => (
            current ? { ...current, instruction: value } : current
          ))}
          onProposalChange={(value) => setAiRewriteState((current) => (
            current ? { ...current, proposal: value } : current
          ))}
          onClose={() => setAiRewriteState(null)}
          onRegenerate={() => {
            const prompt = [
              `请按指令改写下面的代码，只返回改写后的完整代码块。`,
              `文件: ${aiRewriteState.path}`,
              `指令: ${aiRewriteState.instruction || "Rewrite the selected code"}`,
              "",
              "```",
              aiRewriteState.original,
              "```",
            ].join("\n");
            void attachToComposer(prompt);
            setStatusMessage("Re-staged rewrite prompt in AI chat");
          }}
          onApply={() => {
            applySelectionReplacement(aiRewriteState.key, aiRewriteState.range, aiRewriteState.proposal);
            setAiRewriteState(null);
            setStatusMessage("Applied AI proposal to the selection");
          }}
        />
      )}
    </div>
  );
}
