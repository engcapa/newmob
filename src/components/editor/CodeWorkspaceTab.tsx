import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import {
  AlertTriangle,
  Activity,
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
  WrapText,
  Columns3,
} from "lucide-react";
import {
  workspaceListDir,
  workspaceReadFile,
  workspaceReadLooseFile,
  workspaceReadFileWithEncoding,
  workspaceReadLooseFileWithEncoding,
  workspaceJavaRunTarget,
  workspaceExecutionModel,
  workspaceTaskTree,
  workspaceTestResults,
  workspaceApplyResourceOperation,
  workspaceWriteFile,
  workspaceWriteLooseFile,
  workspaceWriteFileEncoded,
  workspaceWriteLooseFileEncoded,
  type WorkspaceFile,
  type WorkspaceGitRoot,
  type WorkspaceExecutionModel,
  type ExecutionRunConfiguration,
  type ExecutionDebugConfiguration,
  type ExecutionBuildTarget,
  type WorkspaceToolConfig,
  type StructuredTestResult,
  type StructuredTestResults,
} from "../../lib/editor/workspace";
import {
  gitBlameLines,
  gitBlobPair,
  type GitBlameLine,
  type GitChange,
} from "../../lib/git";
import {
  lspCodeActions,
  lspCodeActionResolve,
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
  lspExecuteCommand,
  lspResolveWorkspaceEdit,
  lspDownloadSources,
  lspWorkspaceDidChangeWatchedFiles,
  lspStartWorkspaceWatcher,
  lspStopWorkspaceWatcher,
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
  lspWorkspaceSymbolResolve,
  lspWorkspaceSymbols,
  type LspCodeAction,
  type JavaTestItem,
  type LspCompletionItem,
  type LspCompletionResult,
  type LspDiagnostic,
  type LspDocumentDescriptor,
  type LspDocumentSymbol,
  type LspDocumentHighlight,
  type LspInlayHint,
  type LspSemanticToken,
  type LspLocation,
  type LspPosition,
  type LspRange,
  type LspSignatureHelpResult,
  type LspWorkspaceEdit,
  type LspWorkspaceApplyEditRequest,
  type LspWorkspaceEditOperation,
  type LspExternalFileChange,
} from "../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  type WorkspaceEol,
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
import { EditorSelectionAiToolbar } from "./workspace/EditorSelectionAiToolbar";
import {
  CONTEXT_LINE_RADIUS,
  MAX_DIAGNOSTICS,
  buildEditorAiPrompt,
  describeScopeChain,
  extractImports,
  fenceLanguageFor,
  languageLabelFor,
  surroundingLines,
  truncateSelection,
  type EditorAiAction,
  type EditorAiContext,
} from "./workspace/editorAiPrompts";
import {
  nextAnswerLanguage,
  readEditorAiPreferences,
  writeEditorAiPreferences,
} from "./workspace/editorAiPreferences";
import {
  AI_ANSWER_LANGUAGES,
  answerLanguageLabelKey,
  type AiAnswerLanguage,
} from "../../lib/ai/answerLanguage";
import { EditorAiRewriteDialog } from "./workspace/EditorAiRewriteDialog";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { readText, writeText } from "../../lib/clipboard";
import { useContextMenu } from "../ContextMenu";
import { useChatStore } from "../../stores/chatStore";
import {
  type EditorContextMenuRequest,
  type EditorSelectionRange,
} from "./workspace/CodeMirrorHost";
import { buildEditorContextMenuItems } from "./workspace/editorContextMenu";
import { fieldDeclarationAt } from "./workspace/dataBreakpointTarget";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { isTauriRuntime } from "../../lib/runtime";
import { useMountedRef } from "../../hooks/useMountedRef";
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
  workspaceEditApplyResponse,
} from "./workspace/workspaceEditApply";
import { validateSemanticWorkspaceEditPaths } from "./workspace/semanticWorkspaceEdit";
import {
  formatWorkspaceEditPreview,
  workspaceEditOperations,
  type WorkspaceEditPreview,
} from "./workspace/workspaceEditPreview";
import { RefactoringPreviewDialog } from "./workspace/RefactoringPreviewDialog";
import {
  buildWorkspacePathSnapshotEdit,
  WorkspaceEditHistory,
  type WorkspaceEditHistoryEntry,
  type WorkspaceEditPathSnapshot,
} from "./workspace/workspaceEditHistory";
import {
  buildSafeDeleteWorkspaceEdit,
  safeDeleteFileCount,
} from "./workspace/safeDelete";
import { executeCodeAction } from "./workspace/codeActionExecution";
import {
  transformWorkspaceResourceExpandedDirKeys,
  transformWorkspaceResourceFileKey,
  transformWorkspaceResourceFileRef,
  transformWorkspaceResourceTreeSelection,
  type WorkspaceResourceUiChange,
} from "./workspace/workspaceResourceState";
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
  type GoToSymbolQueryResult,
  type GoToSymbolItem,
  type SearchEverywhereMode,
} from "./workspace/SearchEverywhere";
import { type RecentFileEntry } from "./workspace/RecentFilesPopup";
import { EditorGroup } from "./workspace/EditorGroup";
import { WorkspacePopupsHost } from "./workspace/WorkspacePopupsHost";
import { WorkspaceSdkStatus } from "./workspace/WorkspaceSdkStatus";
import { WorkspaceBuildRunToolsDialog } from "./workspace/WorkspaceBuildRunToolsDialog";
import {
  applyRunConfigurationOverride,
  applyRunOverrideToDebugConfiguration,
  applyRunOverrideToJavaLaunch,
  javaRunTargetToExecutionRunConfiguration,
  materializeRunConfigurations,
  mergeDebugEnvironment,
  parseDotEnv,
  readActiveRunConfigurationSelection,
  readRunConfigurationOverrides,
  resolveEnvironmentFilePath,
  RUN_CONFIGURATION_CHANGED_EVENT,
  writeActiveRunConfigurationSelection,
} from "./workspace/runConfigurationPersistence";
import {
  executeTaskPlan,
  resolveBuildTargetPlan,
  validateCompoundExecutionGraph,
} from "./workspace/executionPlan";
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

function encodingSupportsBom(encoding: string): boolean {
  const normalized = encoding.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "utf-8" || normalized === "utf-16le" || normalized === "utf-16be";
}

interface ExternalDiskSnapshot {
  text: string;
  eol: OpenFileState["eol"];
  encoding: string;
  bom: boolean;
  hash: string;
  mtime: number;
  size: number;
}

interface PendingExternalFileConflict {
  key: string;
  path: string;
  baseText: string;
  localText: string;
  disk: ExternalDiskSnapshot | null;
}

interface PendingExternalFileEvent {
  change: LspExternalFileChange;
  timer: number;
}

interface WorkspaceEditTabSnapshot {
  activeGroupId: EditorGroupId;
  splitOrientation: EditorSplitOrientation | null;
  files: Array<{
    path: string;
    ref: CodeWorkspaceFileRef;
    groups: Array<{
      id: EditorGroupId;
      active: boolean;
      preview: boolean;
      pinned: boolean;
    }>;
  }>;
}

const EXTERNAL_FILE_EVENT_SETTLE_MS = 140;

function coalesceExternalFileChange(
  previous: LspExternalFileChange,
  next: LspExternalFileChange,
): LspExternalFileChange {
  // Atomic replacement commonly arrives as Remove followed by Create for the
  // same path. The editor should treat that sequence as one content change.
  if (previous.type === 3 && next.type === 1) {
    return { ...next, type: 2 };
  }
  return next;
}

function externalDiskSnapshot(file: WorkspaceFile): ExternalDiskSnapshot {
  const normalized = normalizeEditorText(file.text);
  return {
    text: normalized.text,
    eol: normalized.eol,
    encoding: file.encoding ?? "UTF-8",
    bom: file.bom ?? file.text.startsWith("\uFEFF"),
    hash: file.hash,
    mtime: file.mtime,
    size: file.size,
  };
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
  type WorkspaceBuildRunTools,
  type WorkspaceTreeCommandPayload,
  readWorkspaceBuildRunTools,
  writeWorkspaceBuildRunTools,
  workspaceToolConfig,
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
  fileRefUnder,
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
  fsPathComparisonKey,
  fsPathEquals,
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
import {
  LSP_DIAGNOSTICS_REFRESH_EVENT,
  useWorkspaceLspSession,
} from "./workspace/useWorkspaceLspSession";
import { useWorkspaceGitSnapshots } from "./workspace/useWorkspaceGitSnapshots";
import { useWorkspaceNavigation } from "./workspace/useWorkspaceNavigation";
import { useWorkspaceFileActions } from "./workspace/useWorkspaceFileActions";
import {
  Breadcrumbs,
  symbolChainAtPosition,
  type BreadcrumbPathAction,
  type BreadcrumbPathChild,
  type BreadcrumbPathSegment,
} from "./workspace/Breadcrumbs";
import { useT } from "../../lib/i18n";
import {
  TerminalDockPanel,
  type TerminalDockHandle,
} from "./workspace/panels/TerminalDockPanel";
import { RunPanel, type RunPanelHandle, type WorkspaceTaskItem } from "./workspace/panels/RunPanel";
import { BuildPanel } from "./workspace/panels/BuildPanel";
import { AnalysisPanel } from "./workspace/panels/AnalysisPanel";
import { TestsPanel } from "./workspace/panels/TestsPanel";
import { javaTestRunCommand, type JavaTestBuildTool } from "./workspace/panels/javaTestRun";
import { DebugPanel } from "./workspace/panels/DebugPanel";
import { JavaMainClassPicker } from "./workspace/JavaMainClassPicker";
import {
  useCodeDebugSession,
  type DebugLaunchGroup,
  type DebugLaunchNode,
} from "./workspace/useCodeDebugSession";
import {
  dapResolveJavaMainClasses,
  type JavaMainClassOption,
  type JavaMainClassResolution,
} from "../../lib/editor/dap";
import type { DebugStackFrame } from "./workspace/dapDebugModel";
import type { DebugBreakpointMarker } from "./workspace/debugEditorChrome";
import type { EditorRevealTarget } from "./workspace/EditorGroup";
import { LspMessageRequestDialog } from "./workspace/LspMessageRequestDialog";
import { useWorkspaceLspClientEvents } from "./workspace/useWorkspaceLspClientEvents";
import {
  addDiagnosticToInspectionBaseline,
  addInspectionSuppression,
  applyInspectionProfile,
  clearInspectionBaseline,
  importInspectionBaseline,
  readInspectionProfile,
  removeInspectionBaselineEntry,
  removeInspectionSuppression,
  replaceInspectionBaseline,
  serializeInspectionBaseline,
  updateInspectionRule,
  writeInspectionProfile,
  type InspectionProfile,
  type InspectionRule,
  type InspectionSuppressionScope,
} from "./workspace/inspectionProfile";
import { ExternalFileConflictDialog } from "./workspace/ExternalFileConflictDialog";
import { WorkspaceRecoveryDialog } from "./workspace/WorkspaceRecoveryDialog";
import { FileEncodingDialog } from "./workspace/FileEncodingDialog";
import {
  readWorkspaceRecoveryEntries,
  reconcileWorkspaceRecoveryEntries,
  removeWorkspaceRecoveryEntry,
  writeWorkspaceRecoveryEntries,
  type WorkspaceRecoveryEntry,
} from "./workspace/workspaceRecovery";
import {
  changedWorkspaceSemanticBufferPaths,
  workspaceSemanticIndexBuildIsCurrent,
  type WorkspaceSemanticIndexBuildToken,
} from "./workspace/workspaceSemanticIndex";
import { useWorkspaceSemanticIndex } from "./workspace/useWorkspaceSemanticIndex";

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
  const sendPromptToTabChat = useChatStore((s) => s.sendPromptToTabChat);
  const t = useT();
  const workspaceInstanceId = useMemo(
    () => workspace.workspaceInstanceId ?? workspace.workspaceId ?? workspace.repoRoot?.trim() ?? tabId,
    [tabId, workspace.repoRoot, workspace.workspaceId, workspace.workspaceInstanceId],
  );
  const semanticIndex = useWorkspaceSemanticIndex(workspaceInstanceId);
  const {
    messageRequest: lspMessageRequest,
    progresses: lspProgresses,
    resolveMessageRequest: resolveLspMessageRequest,
    cancelProgress: cancelLspProgress,
  } = useWorkspaceLspClientEvents({
    workspaceId: workspaceInstanceId,
    visible,
    onStatus: setStatusMessage,
  });
  const activeSemanticProviders = useMemo(
    () => lspProgresses.map((progress) => `${progress.serverLabel}:${progress.rootUri}`),
    [lspProgresses],
  );
  useEffect(() => {
    semanticIndex.setActiveProviders(activeSemanticProviders);
  }, [activeSemanticProviders, semanticIndex.setActiveProviders]);
  const [editorAiPreferences, setEditorAiPreferences] = useState(
    () => readEditorAiPreferences(workspaceInstanceId),
  );
  // Read through a ref inside the context-menu builder so a language change
  // does not have to rebuild that callback.
  const editorAiPreferencesRef = useRef(editorAiPreferences);
  editorAiPreferencesRef.current = editorAiPreferences;
  const setAiAnswerLanguage = useCallback((answerLanguage: AiAnswerLanguage) => {
    setEditorAiPreferences((current) => {
      const next = { ...current, answerLanguage };
      writeEditorAiPreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  /** Keyboard/command path — steps through the options without opening a menu. */
  const cycleAiAnswerLanguage = useCallback(() => {
    setEditorAiPreferences((current) => {
      const next = { ...current, answerLanguage: nextAnswerLanguage(current.answerLanguage) };
      writeEditorAiPreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
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
  const replaceStoreFileState = useCodeWorkspaceStore((s) => s.replaceFileState);
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
  /**
   * False after unmount so async callbacks skip setState. MUST come from
   * `useMountedRef`: the inline `useEffect(() => () => { ref.current = false })`
   * spelling stays false forever under StrictMode's dev double-invoke, which
   * silently aborted the Java debug launch right after main-class resolution.
   */
  const mountedRef = useMountedRef();
  const [workspaceResourceOperationLocked, setWorkspaceResourceOperationLocked] = useState(false);
  const workspaceEditQueueRef = useRef<Promise<void>>(Promise.resolve());
  const providerCommandSemanticGuardRef = useRef<{
    generation: number;
    revision: number;
    requireReady: boolean;
  } | null>(null);
  const providerCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fileActionResourceOperationRef = useRef<((
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => Promise<void>) | null>(null);
  const pendingEditorTextByFileRef = useRef(new Map<string, OpenFileState>());
  const pendingEditorTextTimerRef = useRef<number | null>(null);
  /** Debounced didChange timers keyed by open-file key (live buffer path). */
  const liveLspSyncTimersRef = useRef<Record<string, number>>({});
  const [externalFileConflicts, setExternalFileConflicts] = useState<PendingExternalFileConflict[]>([]);
  const pendingExternalFileEventsRef = useRef(new Map<string, PendingExternalFileEvent>());
  const [workspaceRecoveryEntries, setWorkspaceRecoveryEntries] = useState<WorkspaceRecoveryEntry[]>([]);
  const [workspaceRecoveryOpen, setWorkspaceRecoveryOpen] = useState(false);
  const [fileEncodingDialogOpen, setFileEncodingDialogOpen] = useState(false);
  const pendingWorkspaceRecoveryKeysRef = useRef(new Set<string>());
  const invalidateSemanticAfterLspRestart = useCallback(() => {
    semanticIndex.invalidate("language-server-restarted");
  }, [semanticIndex.invalidate]);

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
    semanticIndex.publishCurrent();
  }, [semanticIndex.publishCurrent, updateStoreOpenFiles, workspaceInstanceId]);
  const setOpenFiles = useCallback((
    updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>),
  ) => {
    // External operations (save, reload, rename, close, WorkspaceEdit) need
    // a coherent current buffer, so they flush any in-progress typing first.
    flushPendingEditorText();
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    const changedPaths = changedWorkspaceSemanticBufferPaths(prev, next);
    if (changedPaths.length > 0) {
      semanticIndex.invalidate("document-edited", changedPaths);
    }
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
  }, [
    flushPendingEditorText,
    semanticIndex.invalidate,
    updateStoreOpenFiles,
    workspaceInstanceId,
  ]);

  /** Pending store teardown, so a StrictMode remount can cancel it (below). */
  const disposeTimerRef = useRef<{ timer: number; instanceId: string } | null>(null);
  useEffect(() => {
    // A remount of the SAME workspace cancels a teardown scheduled by the
    // previous cleanup. React StrictMode runs mount → cleanup → mount in
    // development, and disposing the store instance is NOT idempotent: it
    // deletes openOrder / activeKey / editorGroups outright. Running it
    // mid-mount dropped the writes the first pass had already made, so the
    // restored initial file sat in `openFiles` but in no editor group — the tab
    // rendered with no editor at all (and with no active file the Java Debug
    // button stays disabled). Deferring the teardown by a macrotask lets the
    // remount cancel it; a real unmount has no remount to cancel, so the
    // instance is still released a tick later.
    //
    // Only a matching instance id may cancel: a tab can be rebound to a
    // different workspace without unmounting, and cancelling there would leak
    // the previous instance's entry forever.
    const pending = disposeTimerRef.current;
    if (pending != null && pending.instanceId === workspaceInstanceId) {
      window.clearTimeout(pending.timer);
      disposeTimerRef.current = null;
    }
    return () => {
      // Capture this workspace's flush callback in the effect closure. A tab can
      // be rebound to a different workspace without unmounting, and a ref read
      // during cleanup would then point at the new instance.
      const instanceId = workspaceInstanceId;
      flushPendingEditorText();
      // Persist the final live buffer synchronously on teardown; the debounced
      // effect may not have fired yet when the app is closed or the renderer
      // is being replaced.
      reconcileWorkspaceRecoveryEntries(
        instanceId,
        openFilesRef.current,
        pendingWorkspaceRecoveryKeysRef.current,
      );
      for (const timer of Object.values(liveLspSyncTimersRef.current)) {
        window.clearTimeout(timer);
      }
      liveLspSyncTimersRef.current = {};
      const timer = window.setTimeout(() => {
        if (disposeTimerRef.current?.timer === timer) disposeTimerRef.current = null;
        disposeWorkspaceUi(instanceId);
      }, 0);
      disposeTimerRef.current = { timer, instanceId };
    };
  }, [disposeWorkspaceUi, flushPendingEditorText, workspaceInstanceId]);

  const setLspFiles = useCallback((
    updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).lspFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    lspFilesRef.current = next;
    updateStoreLspFiles(workspaceInstanceId, next);
  }, [updateStoreLspFiles, workspaceInstanceId]);

  const replaceWorkspaceFileState = useCallback((
    nextOpenFiles: Record<string, OpenFileState>,
    nextLspFiles: Record<string, LspFileState>,
    keyChanges: Record<string, string | null>,
  ) => {
    openFilesRef.current = nextOpenFiles;
    lspFilesRef.current = nextLspFiles;
    replaceStoreFileState(workspaceInstanceId, {
      openFiles: nextOpenFiles,
      lspFiles: nextLspFiles,
      keyChanges,
    });
  }, [replaceStoreFileState, workspaceInstanceId]);

  const [codeViewProfile, setCodeViewProfileState] = useState<CodeViewProfile>(() => loadCodeViewProfile());
  const [columnSelectionMode, setColumnSelectionMode] = useState(false);
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
  const [inspectionProfile, setInspectionProfile] = useState<InspectionProfile>(
    () => readInspectionProfile(workspaceInstanceId),
  );
  useEffect(() => {
    setInspectionProfile(readInspectionProfile(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const persistInspectionProfile = useCallback((
    update: (current: InspectionProfile) => InspectionProfile,
  ) => {
    setInspectionProfile((current) => {
      return writeInspectionProfile(workspaceInstanceId, update(current));
    });
  }, [workspaceInstanceId]);
  const updateInspectionProfileRule = useCallback((id: string, patch: Partial<InspectionRule>) => {
    persistInspectionProfile((current) => updateInspectionRule(current, id, patch));
  }, [persistInspectionProfile]);
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
  const referencesRequestSequenceRef = useRef(0);
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
  // Read by the dialog's Restage action, which re-asks with the edited instruction.
  const aiRewriteStateRef = useRef(aiRewriteState);
  aiRewriteStateRef.current = aiRewriteState;
  const workspaceCommandRunnerRef = useRef<(commandId: string, context?: WorkspaceCommandContext) => boolean>(() => false);
  // CodeMirror owns character-level history. This separate stack groups a
  // multi-file WorkspaceEdit into one IDEA-style transaction.
  const workspaceEditHistoryRef = useRef<WorkspaceEditHistory | null>(null);
  if (workspaceEditHistoryRef.current === null) {
    workspaceEditHistoryRef.current = new WorkspaceEditHistory();
  }
  const [workspaceEditHistoryRevision, setWorkspaceEditHistoryRevision] = useState(0);
  const workspaceEditHistory = workspaceEditHistoryRef.current;
  const workspaceEditHistorySequenceRef = useRef(0);
  const replayWorkspacePathSnapshotsRef = useRef<(
    snapshots: readonly WorkspaceEditPathSnapshot[],
  ) => Promise<void>>(async () => {
    throw new Error("Workspace resource history is not ready");
  });
  const replayWorkspaceEncodingRef = useRef<Map<string, { encoding: string; bom: boolean }> | null>(null);
  const goToDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const peekDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToTypeDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToImplementationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const getLspSignatureHelpRef = useRef<(file: OpenFileState, position: LspPosition, triggerCharacter?: string | null) => Promise<LspSignatureHelpResult | null>>(async () => null);
  const renameSymbolRef = useRef<() => Promise<void>>(async () => {});
  const safeDeleteSymbolRef = useRef<() => Promise<void>>(async () => {});
  // Hover enriches the AI prompt with type information. The LSP hover callback
  // is declared further down, so read it through a ref.
  const getLspHoverRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<string | null>>(
    async () => null,
  );
  const breadcrumbSymbolsRef = useRef<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  const activeEditorGroupIdRef = useRef<EditorGroupId>("primary");
  const initialOpenedKeyRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLElement | null>(null);
  const editorPaneRef = useRef<HTMLElement | null>(null);
  const inactiveEditorPaneRef = useRef<HTMLElement | null>(null);
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);
  const runPanelRef = useRef<RunPanelHandle | null>(null);
  const runActiveJavaFileRef = useRef<() => void>(() => {});
  const buildActiveProjectRef = useRef<(rebuild?: boolean) => void>(() => {});
  const recompileActiveFileRef = useRef<() => void>(() => {});
  const toggleActiveBreakpointRef = useRef<(line: number) => void>(() => {});
  const editActiveBreakpointRef = useRef<(line: number) => void>(() => {});
  const debugRef = useRef<ReturnType<typeof useCodeDebugSession> | null>(null);

  useEffect(() => {
    workspaceEditHistory.clear();
    setWorkspaceEditHistoryRevision((revision) => revision + 1);
  }, [workspaceEditHistory, workspaceInstanceId]);

  // Per-workspace Maven/Gradle executable overrides (project wrapper still wins;
  // this is the "configured" tier between wrapper and PATH). Persisted per
  // workspace instance and threaded into every task/dependency detector.
  const [buildRunTools, setBuildRunTools] = useState<WorkspaceBuildRunTools>(
    () => readWorkspaceBuildRunTools(workspaceInstanceId),
  );
  const [buildRunToolsOpen, setBuildRunToolsOpen] = useState(false);
  useEffect(() => {
    setBuildRunTools(readWorkspaceBuildRunTools(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const toolConfig = useMemo<WorkspaceToolConfig | undefined>(
    () => workspaceToolConfig(buildRunTools),
    [buildRunTools],
  );
  const toolConfigRef = useRef(toolConfig);
  toolConfigRef.current = toolConfig;

  /** Run a workspace task in the integrated terminal (shared by Run + Build panels). */
  const runWorkspaceTask = useCallback(
    (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => {
      terminalDockRef.current?.runCommand(
        task.command,
        task.cwd,
        `Run: ${task.label}`,
        onExit,
        task.environment,
        task.execution,
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
    documentVersion: lspDocumentVersion,
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
    onRestart: invalidateSemanticAfterLspRestart,
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

  const semanticRootsFingerprint = useMemo(
    () => roots.map((root) => `${root.id}:${fsPathComparisonKey(root.path)}`).sort().join("\u0000"),
    [roots],
  );
  const previousSemanticRootsFingerprintRef = useRef(semanticRootsFingerprint);
  useEffect(() => {
    if (previousSemanticRootsFingerprintRef.current === semanticRootsFingerprint) return;
    previousSemanticRootsFingerprintRef.current = semanticRootsFingerprint;
    semanticIndex.invalidate("roots-changed", roots.map((root) => root.path));
  }, [roots, semanticIndex.invalidate, semanticRootsFingerprint]);

  useEffect(() => {
    setExternalFileConflicts([]);
  }, [workspaceInstanceId]);

  useEffect(() => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    pendingWorkspaceRecoveryKeysRef.current = new Set(entries.map((entry) => entry.key));
    setWorkspaceRecoveryEntries(entries);
    setWorkspaceRecoveryOpen(entries.length > 0);
  }, [workspaceInstanceId]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const watchPaths = [
      ...roots.map((root) => root.path),
      ...looseFiles.map((file) => file.path),
    ];
    let disposed = false;
    void lspStartWorkspaceWatcher(workspaceInstanceId, watchPaths).catch((error) => {
      if (!disposed) {
        setStatusMessage(`File watcher unavailable: ${errorMessage(error)}`);
      }
    });
    return () => {
      disposed = true;
      void lspStopWorkspaceWatcher(workspaceInstanceId).catch(() => undefined);
    };
  }, [looseFiles, roots, setStatusMessage, workspaceInstanceId]);

  useEffect(() => {
    looseFilesRef.current = looseFiles;
  }, [looseFiles]);

  // Keep a bounded copy of unsaved buffers so a renderer/process crash can be
  // repaired on the next workspace open. Debouncing avoids a storage write for
  // every keystroke while retaining the latest edit within a short window.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const entries = reconcileWorkspaceRecoveryEntries(
        workspaceInstanceId,
        openFilesRef.current,
        pendingWorkspaceRecoveryKeysRef.current,
      );
      setWorkspaceRecoveryEntries(entries);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [openFiles, workspaceInstanceId]);

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

  // Mirrored for the AI prompt builders, which run from callbacks declared
  // before these values are in scope.
  useEffect(() => {
    breadcrumbSymbolsRef.current = breadcrumbSymbolsByGroup;
  }, [breadcrumbSymbolsByGroup]);

  useEffect(() => {
    activeEditorGroupIdRef.current = activeEditorGroupId;
  }, [activeEditorGroupId]);

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

  const toggleSoftWrap = useCallback(() => {
    updateCodeViewProfile(
      (current) => ({ ...current, softWrap: !current.softWrap }),
      (next) => `Soft wrap ${next.softWrap ? "enabled" : "disabled"}`,
    );
  }, [updateCodeViewProfile]);

  const toggleColumnSelectionMode = useCallback(() => {
    setColumnSelectionMode((current) => {
      const next = !current;
      setStatusMessage(`Column selection mode ${next ? "enabled" : "disabled"}`);
      return next;
    });
  }, [setStatusMessage]);

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
            encoding: file.encoding ?? "UTF-8",
            bom: file.bom ?? file.text.startsWith("\uFEFF"),
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

  const removeRecoveryEntry = useCallback((entry: WorkspaceRecoveryEntry) => {
    pendingWorkspaceRecoveryKeysRef.current.delete(entry.key);
    const next = removeWorkspaceRecoveryEntry(workspaceInstanceId, entry.key);
    setWorkspaceRecoveryEntries(next);
    if (next.length === 0) setWorkspaceRecoveryOpen(false);
  }, [workspaceInstanceId]);

  const discardWorkspaceRecoveryEntry = useCallback((entry: WorkspaceRecoveryEntry) => {
    removeRecoveryEntry(entry);
    setStatusMessage(`Discarded recovery snapshot for ${entry.path}`);
  }, [removeRecoveryEntry, setStatusMessage]);

  const discardAllWorkspaceRecoveryEntries = useCallback(() => {
    pendingWorkspaceRecoveryKeysRef.current.clear();
    writeWorkspaceRecoveryEntries(workspaceInstanceId, []);
    setWorkspaceRecoveryEntries([]);
    setWorkspaceRecoveryOpen(false);
    setStatusMessage("Discarded workspace recovery snapshots");
  }, [setStatusMessage, workspaceInstanceId]);

  const recoverWorkspaceEntry = useCallback(async (entry: WorkspaceRecoveryEntry): Promise<boolean> => {
    try {
      await openFile(entry.ref, { preview: false });
      const latest = openFilesRef.current[entry.key]
        ?? Object.values(openFilesRef.current).find((candidate) => (
          candidate.ref.kind === entry.ref.kind
          && candidate.ref.path === entry.ref.path
          && (candidate.ref.kind === "root"
            ? entry.ref.kind === "root" && candidate.ref.rootId === entry.ref.rootId
            : entry.ref.kind === "loose" && candidate.ref.id === entry.ref.id)
        ));
      if (!latest || latest.loading || latest.error) {
        throw new Error(latest?.error ?? `Cannot open ${entry.path}`);
      }
      const recovered = normalizeEditorText(entry.text).text;
      const next: OpenFileState = {
        ...latest,
        text: recovered,
        eol: entry.eol,
        encoding: entry.encoding ?? latest.encoding ?? "UTF-8",
        bom: entry.bom ?? latest.bom ?? false,
        dirty: recovered !== latest.savedText,
        error: null,
      };
      setOpenFiles((current) => ({ ...current, [latest.key]: next }));
      if (latest.text !== next.text && lspFilesRef.current[latest.key]?.status?.active) {
        void syncLspDocument(next, "change");
      }
      removeRecoveryEntry(entry);
      setStatusMessage(`Recovered unsaved changes for ${latest.subtitle}`);
      return true;
    } catch (error) {
      setStatusMessage(`Cannot recover ${entry.path}: ${errorMessage(error)}`);
      return false;
    }
  }, [openFile, removeRecoveryEntry, setOpenFiles, setStatusMessage, syncLspDocument]);

  const recoverAllWorkspaceEntries = useCallback(async () => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    let recovered = 0;
    for (const entry of entries) {
      if (await recoverWorkspaceEntry(entry)) recovered += 1;
    }
    const remaining = readWorkspaceRecoveryEntries(workspaceInstanceId);
    setWorkspaceRecoveryEntries(remaining);
    setWorkspaceRecoveryOpen(remaining.length > 0);
    if (recovered > 1) setStatusMessage(`Recovered ${recovered} unsaved files`);
  }, [recoverWorkspaceEntry, setStatusMessage, workspaceInstanceId]);

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
    reconcileFileReferences: reconcileNavigationFileReferences,
    openRecentFiles,
    recentChangedOnly,
    recordEditLocation,
    navigateLastEditLocation,
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

  const applyFileActionResourceOperation = useCallback((
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => {
    const apply = fileActionResourceOperationRef.current;
    if (!apply) {
      return Promise.reject(new Error("Workspace resource operations are not ready"));
    }
    return apply(operation);
  }, []);

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
    workspaceId: workspaceInstanceId,
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
    applyResourceOperation: applyFileActionResourceOperation,
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
    setLanguagePanelOpen(true);
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
  }, [loadDir, setLanguagePanelOpen]);

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
      const clipboardItems = (
        rootId: string,
        path: string,
        directory: { rootId: string; path: string },
        isDirectory: boolean,
      ) => [
        {
          label: "Cut",
          onClick: () => stageTreeClipboard("cut", rootId, path, isDirectory),
        },
        {
          label: "Copy",
          onClick: () => stageTreeClipboard("copy", rootId, path, isDirectory),
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
          ...clipboardItems(ref.rootId, ref.path, { rootId: ref.rootId, path: dir }, false),
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
          ...clipboardItems(
            selection.rootId,
            selection.path,
            { rootId: selection.rootId, path: selection.path },
            true,
          ),
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
  const ensureLspDocumentSynced = useCallback(async (
    fileKey: string,
    requireSynchronized = false,
  ): Promise<OpenFileState | null> => {
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
    if (
      latest
      && isLspFeatureReady(lspFilesRef.current[fileKey])
      && (!requireSynchronized || isLspDocumentSynced(fileKey, latest.text))
    ) return latest;
    return null;
  }, [cancelLiveLspSync, isLspDocumentSynced, syncLspDocument]);

  /**
   * Semantic mutations are stricter than completion/signature help: every
   * active provider buffer must be acknowledged before the query is sent.
   * If the user edits during the barrier, the original action is abandoned.
   */
  const ensureWorkspaceSemanticDocumentsSynced = useCallback(async (
    requiredFileKey: string,
    expectedRevision: number,
  ): Promise<OpenFileState | null> => {
    const candidates = Object.values(openFilesRef.current).filter((candidate) => (
      !candidate.library
      && shouldLiveSyncLsp(candidate.languagePath, lspFilesRef.current[candidate.key])
    ));
    if (!candidates.some((candidate) => candidate.key === requiredFileKey)) return null;
    const synchronized = await Promise.all(candidates.map(async (candidate) => {
      const latest = await ensureLspDocumentSynced(candidate.key, true);
      const current = openFilesRef.current[candidate.key];
      return !!latest
        && !!current
        && latest.text === current.text
        && isLspDocumentSynced(candidate.key, current.text);
    }));
    if (!synchronized.every(Boolean)) return null;
    if (semanticIndex.current().revision !== expectedRevision) return null;
    const required = openFilesRef.current[requiredFileKey];
    return required && isLspDocumentSynced(requiredFileKey, required.text) ? required : null;
  }, [ensureLspDocumentSynced, isLspDocumentSynced, semanticIndex.current]);

  const queueEditorTextUpdate = useCallback((key: string, text: string) => {
    const file = openFilesRef.current[key];
    if (!file || file.text === text) return;
    // Once the user starts a new character-level edit, CodeMirror becomes the
    // active undo owner. Retaining an older cross-file transaction here would
    // make Ctrl/Cmd+Z skip over the fresh typing and surprise the user.
    const historyState = workspaceEditHistory.state();
    if (historyState.canUndo || historyState.canRedo) {
      workspaceEditHistory.clear();
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
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
    recordEditLocation(file.ref, { line: 0, character: 0 });
    semanticIndex.invalidateSilently("document-edited", [file.path]);
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
  }, [
    flushPendingEditorText,
    scheduleLiveLspSync,
    semanticIndex.invalidateSilently,
    workspaceEditHistory,
  ]);

  const absolutePathForOpenFile = useCallback((file: OpenFileState): string | null => {
    // Library sources live inside a JAR / the language server, not on disk.
    if (file.library) return null;
    if (file.ref.kind === "loose") return normalizeFsPath(file.ref.path);
    const root = findRoot(file.ref.rootId);
    if (!root) return null;
    return absoluteWorkspacePath(root, file.ref.path);
  }, [findRoot]);
  const inspectionPathForFileKey = useCallback((fileKeyValue: string): string => {
    const open = openFilesRef.current[fileKeyValue];
    const ref = open?.ref;
    if (ref?.kind === "root") {
      return `root:${ref.rootId}:${normalizeFsPath(ref.path).replace(/^\/+/, "")}`;
    }
    if (ref) return `loose:${normalizeFsPath(ref.path)}`;
    for (const root of rootsRef.current) {
      const relative = relativePathWithinRoot(root.path, fileKeyValue);
      if (relative !== null) return `root:${root.id}:${normalizeFsPath(relative).replace(/^\/+/, "")}`;
    }
    return normalizeFsPath(fileKeyValue);
  }, []);
  const suppressInspection = useCallback((
    fileKeyValue: string,
    diagnostic: LspDiagnostic,
    scope: InspectionSuppressionScope,
  ) => {
    const path = inspectionPathForFileKey(fileKeyValue);
    persistInspectionProfile((current) => addInspectionSuppression(current, diagnostic, path, scope));
    setStatusMessage(`Suppressed ${diagnostic.source ?? "inspection"}:${diagnostic.code ?? "*"} for ${scope}`);
  }, [inspectionPathForFileKey, persistInspectionProfile, setStatusMessage]);
  const addInspectionBaseline = useCallback((fileKeyValue: string, diagnostic: LspDiagnostic) => {
    const path = inspectionPathForFileKey(fileKeyValue);
    persistInspectionProfile((current) => addDiagnosticToInspectionBaseline(current, diagnostic, path));
    setStatusMessage("Added diagnostic to inspection baseline");
  }, [inspectionPathForFileKey, persistInspectionProfile, setStatusMessage]);
  const clearInspectionBaselineEntries = useCallback(() => {
    persistInspectionProfile(clearInspectionBaseline);
    setStatusMessage("Inspection baseline cleared");
  }, [persistInspectionProfile, setStatusMessage]);
  const removeInspectionBaseline = useCallback((key: string) => {
    persistInspectionProfile((current) => removeInspectionBaselineEntry(current, key));
  }, [persistInspectionProfile]);
  const removeInspectionSuppressionEntry = useCallback((key: string) => {
    persistInspectionProfile((current) => removeInspectionSuppression(current, key));
  }, [persistInspectionProfile]);
  const exportInspectionBaseline = useCallback(async () => {
    const text = serializeInspectionBaseline(inspectionProfile);
    await writeText(text);
    setStatusMessage("Inspection baseline copied to clipboard");
  }, [inspectionProfile, setStatusMessage]);
  const importInspectionBaselineFromClipboard = useCallback(async () => {
    try {
      const text = await readText();
      persistInspectionProfile((current) => importInspectionBaseline(current, text));
      setStatusMessage("Inspection baseline imported");
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  }, [persistInspectionProfile, setStatusMessage]);

  const readWorkspaceEditPathSnapshot = useCallback(async (
    absolutePath: string,
  ): Promise<WorkspaceEditPathSnapshot | null> => {
    const normalizedPath = normalizeFsPath(absolutePath);
    for (const root of rootsRef.current) {
      const relative = relativePathWithinRoot(root.path, normalizedPath);
      if (relative === null) continue;
      if (!relative) return null;
      try {
        const entries = await workspaceListDir(root.path, parentPath(relative));
        const entry = entries.find((candidate) => candidate.path === relative);
        if (!entry) return { path: normalizedPath, exists: false, text: null };
        // Restoring a directory, symlink, or special node as a regular file
        // would be data loss. Those transactions remain deliberately ineligible.
        if (entry.fileType !== "file") return null;
        const open = Object.values(openFilesRef.current).find((file) => {
          const path = absolutePathForOpenFile(file);
          return path != null && fsPathEquals(path, normalizedPath);
        });
        if (open) return {
          path: normalizedPath,
          exists: true,
          text: open.text,
          encoding: open.encoding ?? "UTF-8",
          bom: open.bom ?? false,
        };
        const file = await workspaceReadFile(root.path, relative);
        return {
          path: normalizedPath,
          exists: true,
          text: file.text,
          encoding: file.encoding ?? "UTF-8",
          bom: file.bom ?? false,
        };
      } catch {
        return null;
      }
    }
    const open = Object.values(openFilesRef.current).find((file) => {
      const path = absolutePathForOpenFile(file);
      return path != null && fsPathEquals(path, normalizedPath);
    });
    if (open) return {
      path: normalizedPath,
      exists: true,
      text: open.text,
      encoding: open.encoding ?? "UTF-8",
      bom: open.bom ?? false,
    };
    try {
      const file = await workspaceReadLooseFile(normalizedPath);
      return {
        path: normalizedPath,
        exists: true,
        text: file.text,
        encoding: file.encoding ?? "UTF-8",
        bom: file.bom ?? false,
      };
    } catch {
      return { path: normalizedPath, exists: false, text: null };
    }
  }, [absolutePathForOpenFile]);

  const captureWorkspaceEditPathSnapshots = useCallback(async (
    edit: LspWorkspaceEdit,
  ): Promise<WorkspaceEditPathSnapshot[] | null> => {
    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (path: string | null) => {
      if (!path) return false;
      const normalized = normalizeFsPath(path);
      const comparisonKey = fsPathComparisonKey(normalized);
      if (!seen.has(comparisonKey)) {
        seen.add(comparisonKey);
        paths.push(normalized);
      }
      return true;
    };
    for (const operation of workspaceEditOperations(edit)) {
      if (operation.kind === "text") {
        if (!add(operation.document.path)) return null;
      } else if (operation.kind === "rename") {
        if (!add(operation.oldPath) || !add(operation.newPath)) return null;
      } else if (!add(operation.path)) {
        return null;
      }
    }
    const snapshots = await Promise.all(paths.map(readWorkspaceEditPathSnapshot));
    return snapshots.every((snapshot): snapshot is WorkspaceEditPathSnapshot => snapshot !== null)
      ? snapshots
      : null;
  }, [readWorkspaceEditPathSnapshot]);

  const captureWorkspaceEditTabSnapshot = useCallback((
    paths: readonly string[],
  ): WorkspaceEditTabSnapshot => {
    const pathSet = new Set(paths.map(fsPathComparisonKey));
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const files = Object.values(openFilesRef.current).flatMap((file) => {
      const absolutePath = absolutePathForOpenFile(file);
      if (!absolutePath || !pathSet.has(fsPathComparisonKey(absolutePath))) return [];
      const groups = (["primary", "secondary"] as const).flatMap((id) => {
        const group = ui.editorGroups[id];
        if (!group.openOrder.includes(file.key)) return [];
        return [{
          id,
          active: group.activeKey === file.key,
          preview: group.previewKey === file.key,
          pinned: group.pinnedKeys.includes(file.key),
        }];
      });
      return groups.length > 0 ? [{ path: normalizeFsPath(absolutePath), ref: file.ref, groups }] : [];
    });
    return {
      activeGroupId: ui.activeEditorGroupId,
      splitOrientation: ui.splitOrientation,
      files,
    };
  }, [absolutePathForOpenFile, workspaceInstanceId]);

  const restoreWorkspaceEditTabs = useCallback(async (snapshot: WorkspaceEditTabSnapshot) => {
    if (snapshot.files.some((file) => file.groups.some((group) => group.id === "secondary"))) {
      setStoreSplitOrientation(workspaceInstanceId, snapshot.splitOrientation ?? "vertical");
    }
    for (const file of snapshot.files) {
      for (const group of file.groups) {
        await openFile(file.ref, { preview: group.preview, groupId: group.id });
        const key = fileKey(file.ref);
        updateEditorGroup(group.id, (current) => ({
          ...current,
          activeKey: group.active ? key : current.activeKey,
          previewKey: group.preview ? key : current.previewKey === key ? null : current.previewKey,
          pinnedKeys: group.pinned
            ? [...new Set([...current.pinnedKeys, key])]
            : current.pinnedKeys.filter((candidate) => candidate !== key),
        }));
      }
    }
    activateEditorGroup(snapshot.activeGroupId);
  }, [activateEditorGroup, openFile, setStoreSplitOrientation, updateEditorGroup, workspaceInstanceId]);

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

  /**
   * Gather everything the AI prompt builder needs for a selection: language,
   * enclosing scope, imports, neighbouring lines, diagnostics, and LSP type
   * info. A bare selection is often only a fragment (an `impl` header, a
   * signature), so the surrounding facts are what make the answer accurate.
   */
  const buildEditorAiContext = useCallback(async (
    action: EditorAiAction,
    file: OpenFileState,
    selection: EditorSelectionRange,
    text: string,
    instruction?: string,
  ): Promise<EditorAiContext> => {
    const pathLabel = file.subtitle || file.path;
    const languageId = lspFilesRef.current[file.key]?.status?.languageId ?? null;
    const fenceLanguage = fenceLanguageFor(languageId, file.languagePath);
    const { text: selectionText, truncated } = truncateSelection(text);
    // LSP positions are 0-based; the prompt reports 1-based lines to match the
    // gutter the user is looking at.
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    const scopeChain = describeScopeChain(
      symbolChainAtPosition(
        breadcrumbSymbolsRef.current[activeEditorGroupIdRef.current] ?? [],
        selection.start,
      ),
    );

    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? [])
      .filter((item) => (
        item.range.end.line >= selection.start.line
        && item.range.start.line <= selection.end.line
      ))
      .slice(0, MAX_DIAGNOSTICS)
      .map((item) => {
        const where = `L${item.range.start.line + 1}`;
        const code = item.code ? ` [${item.code}]` : "";
        const source = item.source ? `${item.source}: ` : "";
        return `${where} ${source}${item.message}${code}`;
      });

    const { before, after } = surroundingLines(file.text, startLine, endLine, CONTEXT_LINE_RADIUS);

    // Hover is best-effort: a cold or unsupported server must not block the ask.
    let hover: string | null = null;
    try {
      hover = await getLspHoverRef.current(file, selection.start);
    } catch {
      hover = null;
    }

    return {
      action,
      filePath: pathLabel,
      languageLabel: languageLabelFor(languageId, file.languagePath),
      fenceLanguage,
      selection: selectionText,
      selectionStartLine: startLine,
      selectionEndLine: endLine,
      scopeChain,
      imports: extractImports(file.text, fenceLanguage),
      linesBefore: before,
      linesAfter: after,
      hover,
      diagnostics,
      instruction,
      truncated,
    };
  }, []);

  /** Default rewrite/fix instruction shown in the proposal dialog. */
  const defaultAiInstruction = useCallback((action: EditorAiAction): string | undefined => (
    action === "fix"
      ? "Fix issues in the selected code"
      : action === "rewrite"
        ? "Rewrite the selected code"
        : undefined
  ), []);

  const aiSentStatusKey = useCallback((action: EditorAiAction): string => (
    action === "explain"
      ? "codeWorkspaceAi.sentExplain"
      : action === "syntax"
        ? "codeWorkspaceAi.sentSyntax"
        : action === "fix"
          ? "codeWorkspaceAi.sentFix"
          : "codeWorkspaceAi.sentRewrite"
  ), []);

  /**
   * Shared tail for every AI selection action: build the prompt, send it, and —
   * for the code-producing actions — open the proposal dialog so the answer can
   * be diffed against the selection before it is applied.
   */
  const dispatchEditorAiAction = useCallback(async (
    action: EditorAiAction,
    file: OpenFileState,
    selection: EditorSelectionRange,
    text: string,
  ) => {
    const instruction = defaultAiInstruction(action);
    const context = await buildEditorAiContext(action, file, selection, text, instruction);
    const prompt = buildEditorAiPrompt(context, editorAiPreferences.answerLanguage);
    await sendPromptToTabChat(prompt);

    if (action === "fix" || action === "rewrite") {
      setAiRewriteState({
        key: file.key,
        path: file.subtitle || file.path,
        original: text,
        proposal: text,
        instruction: instruction ?? "",
        range: selection,
      });
    }

    setEditorAiSelection(null);
    setStatusMessage(t(aiSentStatusKey(action)));
  }, [
    aiSentStatusKey,
    buildEditorAiContext,
    defaultAiInstruction,
    editorAiPreferences.answerLanguage,
    sendPromptToTabChat,
    setStatusMessage,
    t,
  ]);

  /** Selection-toolbar entry point: the user has already highlighted the code. */
  const handleEditorAiAction = useCallback(async (action: EditorAiAction, text: string) => {
    const selection = editorSelectionRef.current;
    const file = activeKey ? openFilesRef.current[activeKey] ?? null : null;
    if (!file || selection.empty || !text.trim()) return;
    await dispatchEditorAiAction(action, file, selection, text);
  }, [activeKey, dispatchEditorAiAction]);

  /**
   * Command-palette / context-menu entry point, where there may be no selection.
   * Falls back to the enclosing symbol at the caret, then to the current line, so
   * "put the caret on it and ask" works without selecting anything by hand.
   */
  const runEditorAiActionAtCursor = useCallback(async (action: EditorAiAction) => {
    const file = activeKey ? openFilesRef.current[activeKey] ?? null : null;
    if (!file) return;
    const selection = editorSelectionRef.current;
    if (!selection.empty && selection.text.trim().length >= 2) {
      await dispatchEditorAiAction(action, file, selection, selection.text);
      return;
    }

    const lines = file.text.split("\n");
    const chain = symbolChainAtPosition(
      breadcrumbSymbolsRef.current[activeEditorGroupIdRef.current] ?? [],
      selection.start,
    );
    const enclosing = chain[chain.length - 1]?.range;
    const startLine = enclosing ? enclosing.start.line : selection.start.line;
    const endLine = enclosing ? enclosing.end.line : selection.start.line;
    const text = lines.slice(startLine, endLine + 1).join("\n");
    if (text.trim().length < 2) {
      setStatusMessage(t("codeWorkspaceAi.noSelection"));
      return;
    }

    // Synthesize the range so the prompt reports the lines it actually sent.
    const synthetic: EditorSelectionRange = {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: (lines[endLine] ?? "").length },
      empty: false,
      text,
      rect: null,
    };
    await dispatchEditorAiAction(action, file, synthetic, text);
  }, [activeKey, dispatchEditorAiAction, setStatusMessage, t]);

  /** Re-ask with the instruction the user edited in the proposal dialog. */
  const regenerateAiRewrite = useCallback(async () => {
    const state = aiRewriteStateRef.current;
    if (!state) return;
    const file = openFilesRef.current[state.key] ?? null;
    if (!file) return;
    const instruction = state.instruction.trim() || defaultAiInstruction("rewrite");
    const context = await buildEditorAiContext(
      "rewrite",
      file,
      state.range,
      state.original,
      instruction,
    );
    const prompt = buildEditorAiPrompt(context, editorAiPreferences.answerLanguage);
    await sendPromptToTabChat(prompt);
    setStatusMessage(t("codeWorkspaceAi.resentRewrite"));
  }, [
    buildEditorAiContext,
    defaultAiInstruction,
    editorAiPreferences.answerLanguage,
    sendPromptToTabChat,
    setStatusMessage,
    t,
  ]);

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
        const historyText = `${file.bom ? "\uFEFF" : ""}${applyEditorEol(file.savedText, file.eol)}`;
        await historySnapshot(historyPath, historyText, "save").catch(() => null);
      }
      // BOM is a byte-level concern. Keep it out of the JavaScript buffer and
      // let the backend encode it together with the selected charset.
      const diskText = applyEditorEol(textToSave.replace(/^\uFEFF/, ""), file.eol);
      const encoding = file.encoding ?? "UTF-8";
      // Keep the established UTF-8 path compatible with browser/test shims;
      // non-UTF-8 files must use the byte-aware desktop command.
      const encodedWriter = encoding.toLowerCase() !== "utf-8"
        && typeof workspaceWriteFileEncoded === "function"
        && typeof workspaceWriteLooseFileEncoded === "function";
      const saved = file.ref.kind === "root"
        ? encodedWriter
          ? await workspaceWriteFileEncoded(
            findRoot(file.ref.rootId)?.path ?? "",
            file.ref.path,
            diskText,
            file.hash,
            encoding,
            file.bom ?? false,
          )
          : await workspaceWriteFile(
            findRoot(file.ref.rootId)?.path ?? "",
            file.ref.path,
            `${file.bom ? "\uFEFF" : ""}${diskText}`,
            file.hash,
          )
        : encodedWriter
          ? await workspaceWriteLooseFileEncoded(
            file.ref.path,
            diskText,
            file.hash,
            encoding,
            file.bom ?? false,
          )
          : await workspaceWriteLooseFile(
            file.ref.path,
            `${file.bom ? "\uFEFF" : ""}${diskText}`,
            file.hash,
          );
      const savedPath = absolutePathForOpenFile(file);
      if (savedPath) {
        await lspWorkspaceDidChangeWatchedFiles(workspaceInstanceId, [{
          path: savedPath,
          type: 2,
        }]).catch(() => 0);
      }
      const normalized = normalizeEditorText(saved.text);
      const savedBom = saved.bom ?? saved.text.startsWith("\uFEFF");
      const cleaned: OpenFileState = {
        ...file,
        text: normalized.text,
        savedText: normalized.text,
        eol: normalized.eol,
        encoding: saved.encoding ?? file.encoding ?? "UTF-8",
        bom: savedBom,
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
          encoding: saved.encoding ?? file.encoding ?? "UTF-8",
          bom: savedBom,
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
      semanticIndex.invalidate("document-saved", [savedPath ?? file.path]);
      await saveLspDocument({ ...file, text: textToSave }, textToSave);
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
  }, [
    absolutePathForOpenFile,
    findRoot,
    notifyWorkspacePathGitChanged,
    saveLspDocument,
    semanticIndex.invalidate,
    workspaceInstanceId,
  ]);

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
            encoding: reloaded.encoding ?? file.encoding ?? "UTF-8",
            bom: reloaded.bom ?? reloaded.text.startsWith("\uFEFF"),
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

  const readDiskSnapshot = useCallback(async (file: OpenFileState): Promise<ExternalDiskSnapshot> => {
    const preferredEncoding = file.encoding ?? "UTF-8";
    const disk = file.ref.kind === "root"
      ? preferredEncoding !== "UTF-8" && typeof workspaceReadFileWithEncoding === "function"
        ? await workspaceReadFileWithEncoding(
          findRoot(file.ref.rootId)?.path ?? "",
          file.ref.path,
          preferredEncoding,
        )
        : await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
      : preferredEncoding !== "UTF-8" && typeof workspaceReadLooseFileWithEncoding === "function"
        ? await workspaceReadLooseFileWithEncoding(file.ref.path, preferredEncoding)
        : await workspaceReadLooseFile(file.ref.path);
    return externalDiskSnapshot(disk);
  }, [findRoot]);

  const applyDiskSnapshot = useCallback((file: OpenFileState, disk: ExternalDiskSnapshot) => {
    const latest = openFilesRef.current[file.key] ?? file;
    const next: OpenFileState = {
      ...latest,
      text: disk.text,
      savedText: disk.text,
      eol: disk.eol,
      encoding: disk.encoding,
      bom: disk.bom,
      hash: disk.hash,
      mtime: disk.mtime,
      size: disk.size,
      loading: false,
      saving: false,
      dirty: false,
      error: null,
    };
    setOpenFiles((current) => ({ ...current, [file.key]: next }));
    if (latest.text !== next.text && lspFilesRef.current[file.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
  }, [setOpenFiles, syncLspDocument]);

  const enqueueExternalFileConflict = useCallback((
    file: OpenFileState,
    disk: ExternalDiskSnapshot | null,
  ) => {
    const conflict: PendingExternalFileConflict = {
      key: file.key,
      path: absolutePathForOpenFile(file) ?? file.path,
      baseText: file.savedText,
      localText: file.text,
      disk,
    };
    setExternalFileConflicts((current) => (
      current.some((item) => item.key === conflict.key) ? current : [...current, conflict]
    ));
  }, [absolutePathForOpenFile]);

  const handleExternalFileChange = useCallback(async (change: LspExternalFileChange) => {
    const normalizedPath = normalizeFsPath(change.path);
    semanticIndex.invalidate("external-file-change", [normalizedPath]);
    const file = Object.values(openFilesRef.current).find((candidate) => {
      const absolute = absolutePathForOpenFile(candidate);
      return absolute !== null && fsPathEquals(absolute, normalizedPath);
    });
    refreshTree();
    if (!file) {
      setStatusMessage(`File changed on disk: ${change.path}`);
      return;
    }
    if (file.library || file.saving) return;
    if (change.type === 3) {
      if (file.dirty) {
        enqueueExternalFileConflict(file, null);
        setStatusMessage(`${file.subtitle} was deleted on disk; choose how to recover the local buffer`);
      } else {
        setOpenFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? file),
            error: "File deleted on disk; the open buffer is preserved",
          },
        }));
        setStatusMessage(`${file.subtitle} was deleted on disk`);
      }
      return;
    }

    let disk: ExternalDiskSnapshot;
    try {
      disk = await readDiskSnapshot(file);
    } catch (error) {
      setStatusMessage(`Cannot read external change for ${file.subtitle}: ${errorMessage(error)}`);
      return;
    }
    const latest = openFilesRef.current[file.key] ?? file;
    if (disk.text === latest.text) {
      // Another process wrote exactly the buffer we already have. Accept the
      // new hash and clear dirty without repainting the editor document.
      setOpenFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? latest),
          savedText: disk.text,
          eol: disk.eol,
          encoding: disk.encoding,
          bom: disk.bom,
          hash: disk.hash,
          mtime: disk.mtime,
          size: disk.size,
          dirty: false,
          error: null,
        },
      }));
      return;
    }
    if (disk.text === latest.savedText) {
      // Metadata-only/atomic-replace notification: the logical content did not
      // change, so preserve a dirty buffer and just refresh its write guard.
      setOpenFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? latest),
          eol: disk.eol,
          encoding: disk.encoding,
          bom: disk.bom,
          hash: disk.hash,
          mtime: disk.mtime,
          size: disk.size,
          error: null,
        },
      }));
      return;
    }
    if (!latest.dirty) {
      applyDiskSnapshot(latest, disk);
      setStatusMessage(`Reloaded ${latest.subtitle} from disk`);
      return;
    }
    enqueueExternalFileConflict(latest, disk);
    setStatusMessage(`${latest.subtitle} changed on disk; choose Keep Local, Load Disk, or Merge`);
  }, [
    absolutePathForOpenFile,
    applyDiskSnapshot,
    enqueueExternalFileConflict,
    readDiskSnapshot,
    refreshTree,
    semanticIndex.invalidate,
    setOpenFiles,
    setStatusMessage,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<LspExternalFileChange>("lsp://external-file-change", (event) => {
      const change = event.payload;
      if (change.workspaceId !== workspaceInstanceId) return;
      const pathKey = normalizeFsPath(change.path);
      const pending = pendingExternalFileEventsRef.current.get(pathKey);
      if (pending) window.clearTimeout(pending.timer);
      const merged = pending
        ? coalesceExternalFileChange(pending.change, change)
        : change;
      const timer = window.setTimeout(() => {
        pendingExternalFileEventsRef.current.delete(pathKey);
        if (!disposed) void handleExternalFileChange(merged);
      }, EXTERNAL_FILE_EVENT_SETTLE_MS);
      pendingExternalFileEventsRef.current.set(pathKey, { change: merged, timer });
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      for (const pending of pendingExternalFileEventsRef.current.values()) {
        window.clearTimeout(pending.timer);
      }
      pendingExternalFileEventsRef.current.clear();
    };
  }, [handleExternalFileChange, workspaceInstanceId]);

  const closeFile = useCallback(
    async (
      key: string,
      groupId: EditorGroupId = activeEditorGroupId,
      options: { discard?: boolean } = {},
    ) => {
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const group = currentUi.editorGroups[groupId];
      if (!group.openOrder.includes(key)) return;
      const file = openFilesRef.current[key];
      const usedByOtherGroup = Object.values(currentUi.editorGroups).some(
        (candidate) => candidate.id !== groupId && candidate.openOrder.includes(key),
      );
      if (file?.dirty && !usedByOtherGroup && !options.discard) {
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

  const dismissExternalFileConflict = useCallback((key: string) => {
    setExternalFileConflicts((current) => current.filter((item) => item.key !== key));
  }, []);

  const keepLocalExternalFileConflict = useCallback((conflict: PendingExternalFileConflict) => {
    const latest = openFilesRef.current[conflict.key];
    if (latest) {
      const next: OpenFileState = conflict.disk
        ? {
            ...latest,
            savedText: conflict.disk.text,
            eol: conflict.disk.eol,
            encoding: conflict.disk.encoding,
            bom: conflict.disk.bom,
            hash: conflict.disk.hash,
            mtime: conflict.disk.mtime,
            size: conflict.disk.size,
            dirty: latest.text !== conflict.disk.text,
            error: null,
          }
        : {
            ...latest,
            dirty: true,
            error: "File deleted on disk; local changes are preserved",
          };
      setOpenFiles((current) => ({ ...current, [conflict.key]: next }));
      setStatusMessage(conflict.disk
        ? `Kept local changes for ${latest.subtitle}; the next save will replace the disk version`
        : `Kept local changes for deleted file ${latest.subtitle}`);
    }
    dismissExternalFileConflict(conflict.key);
  }, [dismissExternalFileConflict, setOpenFiles, setStatusMessage]);

  const loadDiskExternalFileConflict = useCallback(async (conflict: PendingExternalFileConflict) => {
    const latest = openFilesRef.current[conflict.key];
    if (!latest) {
      dismissExternalFileConflict(conflict.key);
      return;
    }
    if (conflict.disk) {
      applyDiskSnapshot(latest, conflict.disk);
      setStatusMessage(`Loaded disk version of ${latest.subtitle}`);
      dismissExternalFileConflict(conflict.key);
      return;
    }

    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    for (const group of Object.values(currentUi.editorGroups)) {
      if (group.openOrder.includes(conflict.key)) {
        await closeFile(conflict.key, group.id, { discard: true });
      }
    }
    dismissExternalFileConflict(conflict.key);
    setStatusMessage(`Closed deleted file ${latest.subtitle}`);
  }, [
    applyDiskSnapshot,
    closeFile,
    dismissExternalFileConflict,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const mergeExternalFileConflict = useCallback((
    conflict: PendingExternalFileConflict,
    mergedText: string,
  ) => {
    const latest = openFilesRef.current[conflict.key];
    const disk = conflict.disk;
    if (!latest || !disk) {
      dismissExternalFileConflict(conflict.key);
      return;
    }
    const normalized = normalizeEditorText(mergedText);
    const next: OpenFileState = {
      ...latest,
      text: normalized.text,
      savedText: disk.text,
      eol: disk.eol,
      encoding: disk.encoding,
      bom: disk.bom,
      hash: disk.hash,
      mtime: disk.mtime,
      size: disk.size,
      dirty: normalized.text !== disk.text,
      error: null,
    };
    setOpenFiles((current) => ({ ...current, [conflict.key]: next }));
    if (latest.text !== next.text && lspFilesRef.current[conflict.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
    dismissExternalFileConflict(conflict.key);
    setStatusMessage(`Applied merged changes to ${latest.subtitle}`);
  }, [dismissExternalFileConflict, setOpenFiles, setStatusMessage, syncLspDocument]);

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
  const inspectionTransform = useCallback(
    (diagnostic: LspDiagnostic, path?: string): LspDiagnostic | null => (
      applyInspectionProfile(diagnostic, inspectionProfile, { path })
    ),
    [inspectionProfile],
  );
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

  const activeLspProgress = lspProgresses.length > 0
    ? lspProgresses[lspProgresses.length - 1]!
    : null;
  const activeLspProgressKey = activeLspProgress
    ? `${activeLspProgress.presetId}\u0000${activeLspProgress.rootUri}\u0000${typeof activeLspProgress.token}:${String(activeLspProgress.token)}`
    : null;

  const openGitManager = useCallback(() => {
    if (!onOpenGitManager || gitManagerPayload.roots.length === 0) return;
    onOpenGitManager(gitManagerPayload);
  }, [gitManagerPayload, onOpenGitManager]);

  const reloadActiveFileWithEncoding = useCallback(async (encoding: string) => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    if (file.dirty) {
      const confirmed = await confirmAppDialog({
        title: "Reload file with encoding",
        message: `Discard unsaved changes in ${file.subtitle} and decode it as ${encoding}?`,
        confirmLabel: "Reload",
        danger: true,
      });
      if (!confirmed) return;
    }
    if (typeof workspaceReadFileWithEncoding !== "function"
      || typeof workspaceReadLooseFileWithEncoding !== "function") {
      throw new Error("Explicit file encoding is available in the desktop workspace only");
    }
    setOpenFiles((current) => ({
      ...current,
      [key]: { ...(current[key] ?? file), loading: true, error: null },
    }));
    try {
      const reloaded = file.ref.kind === "root"
        ? await workspaceReadFileWithEncoding(findRoot(file.ref.rootId)?.path ?? "", file.ref.path, encoding)
        : await workspaceReadLooseFileWithEncoding(file.ref.path, encoding);
      const normalized = normalizeEditorText(reloaded.text);
      const next: OpenFileState = {
        ...file,
        text: normalized.text,
        savedText: normalized.text,
        eol: normalized.eol,
        encoding: reloaded.encoding ?? encoding,
        bom: reloaded.bom ?? false,
        hash: reloaded.hash,
        mtime: reloaded.mtime,
        size: reloaded.size,
        loading: false,
        saving: false,
        dirty: false,
        error: null,
      };
      openFilesRef.current = { ...openFilesRef.current, [key]: next };
      setOpenFiles((current) => ({ ...current, [key]: next }));
      setFileEncodingDialogOpen(false);
      setStatusMessage(`Reloaded ${file.subtitle} as ${next.encoding}${next.bom ? " BOM" : ""}`);
    } catch (error) {
      const message = errorMessage(error);
      setOpenFiles((current) => ({
        ...current,
        [key]: { ...(current[key] ?? file), loading: false, saving: false, error: message },
      }));
      setStatusMessage(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [activeKey, findRoot, setStatusMessage]);

  const convertActiveFileEncoding = useCallback((encoding: string, bom: boolean) => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    const effectiveBom = encodingSupportsBom(encoding) && bom;
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? file),
        encoding,
        bom: effectiveBom,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: save as ${encoding}${effectiveBom ? " BOM" : ""}`);
  }, [activeKey, setStatusMessage]);

  const openFileEncodingDialog = useCallback(() => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file || file.library || file.loading || file.saving) return;
    setFileEncodingDialogOpen(true);
  }, [activeKey]);

  const cycleActiveFileEol = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    const nextEol: WorkspaceEol = file.eol === "LF"
      ? "CRLF"
      : file.eol === "CRLF"
        ? "CR"
        : "LF";
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? file),
        eol: nextEol,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: line endings set to ${nextEol}; save to apply`);
  }, [activeKey, setOpenFiles, setStatusMessage]);

  const toggleActiveFileBom = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    if (!encodingSupportsBom(file.encoding ?? "UTF-8")) {
      setStatusMessage(`${file.subtitle}: BOM is only available for UTF-8 and UTF-16 encodings`);
      return;
    }
    const nextBom = !(file.bom ?? false);
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? file),
        bom: nextBom,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: ${file.encoding ?? "UTF-8"} ${nextBom ? "BOM enabled" : "BOM disabled"}; save to apply`);
  }, [activeKey, setOpenFiles, setStatusMessage]);

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
      encoding: activeFile
        ? `${activeFile.encoding ?? "UTF-8"}${activeFile.bom ? " BOM" : ""}`
        : "UTF-8",
      eol: activeFile?.eol ?? "LF",
      languageId: status?.languageId ?? activeLanguageId,
      lspActive: !!status?.active,
      lspLabel: status?.displayName ?? (status?.active ? "LSP" : null),
      lspError: !!activeLspState?.error || (!!status && !status.active && !!status.error),
      lspProgress: activeLspProgress
        ? {
            key: activeLspProgressKey ?? "lsp-progress",
            label: activeLspProgress.title ?? activeLspProgress.serverLabel,
            message: activeLspProgress.message,
            percentage: activeLspProgress.percentage,
            cancellable: activeLspProgress.cancellable,
          }
        : null,
      gitBranch: gitSnapshot?.currentBranch ?? null,
      gitAhead: gitSnapshot?.ahead ?? 0,
      gitBehind: gitSnapshot?.behind ?? 0,
      fontSize: codeViewProfile.fontSize,
      largeFile: activeFileIsLarge,
    });
  }, [
    activeEditorGroupId,
    activeFile?.bom,
    activeFile?.encoding,
    activeFile?.eol,
    activeFileIsLarge,
    activeGitRoot,
    activeLanguageId,
    activeLspState,
    activeLspProgress,
    activeLspProgressKey,
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
      cycleEol: activeFile && !activeFile.library ? cycleActiveFileEol : undefined,
      toggleBom: activeFile && !activeFile.library ? toggleActiveFileBom : undefined,
      chooseEncoding: activeFile && !activeFile.library ? openFileEncodingDialog : undefined,
      cancelLspProgress: activeLspProgress?.cancellable
        ? () => cancelLspProgress(activeLspProgress)
        : undefined,
    });
  }, [
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    cycleActiveFileEol,
    openFileEncodingDialog,
    toggleActiveFileBom,
    activeFile,
    openLanguageServersSettings,
    activeLspProgress,
    cancelLspProgress,
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

  const fetchWorkspaceSymbols = useCallback(async (query: string): Promise<GoToSymbolQueryResult> => {
    const file = activeFile ?? Object.values(openFilesRef.current).find((item) => !item.loading) ?? null;
    const unavailable = (): GoToSymbolQueryResult => {
      return {
        symbols: [],
        semanticGeneration: null,
        semanticRevision: null,
        sessionCount: 0,
        providerCount: 0,
        skippedProviderCount: 0,
        failedProviderCount: 0,
        complete: false,
        truncated: false,
        diagnostics: [],
      };
    };
    if (!file) return unavailable();
    const expectedRevision = semanticIndex.current().revision;
    const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) return unavailable();
    const descriptor = lspDescriptorForFile(live);
    if (!descriptor) return unavailable();
    const buildToken = semanticIndex.beginBuild("language-server");
    try {
      const result = await lspWorkspaceSymbols(descriptor, query);
      updateLspStatusForFile(live, result.status);
      const symbols = result.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        containerName: symbol.containerName,
        path: symbol.path ?? symbol.uri,
        uri: symbol.uri,
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
        resolved: symbol.resolved,
        resolveToken: symbol.resolveToken ?? null,
      }));
      const completion = semanticIndex.finishQuery(buildToken, {
        kind: "symbols",
        resultCount: symbols.length,
        coverage: {
          scope: "workspace",
          sessionCount: result.sessionCount,
          providerCount: result.providerCount,
          skippedProviderCount: result.skippedProviderCount,
          failedProviderCount: result.failedProviderCount,
          complete: result.complete,
          truncated: result.truncated,
          diagnostics: result.diagnostics,
        },
      });
      return completion.accepted
        ? {
          symbols,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
          sessionCount: result.sessionCount,
          providerCount: result.providerCount,
          skippedProviderCount: result.skippedProviderCount,
          failedProviderCount: result.failedProviderCount,
          complete: result.complete,
          truncated: result.truncated,
          diagnostics: result.diagnostics,
        }
        : unavailable();
    } catch (error) {
      semanticIndex.failBuild(buildToken, errorMessage(error));
      return unavailable();
    }
  }, [
    activeFile,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    updateLspStatusForFile,
  ]);

  const openWorkspaceSymbol = useCallback(async (
    symbol: GoToSymbolItem,
    options?: { split: boolean },
  ) => {
    setSearchEverywhereOpen(false);
    let location: LspLocation;
    if (!symbol.resolved) {
      if (!symbol.resolveToken) {
        setStatusMessage(`Cannot open ${symbol.name}: the language server did not provide a source location`);
        return;
      }
      try {
        const resolved = await lspWorkspaceSymbolResolve(workspaceInstanceId, symbol.resolveToken);
        if (!resolved.resolved) {
          setStatusMessage(`Cannot open ${symbol.name}: workspace symbol resolution returned no source range`);
          return;
        }
        location = {
          uri: resolved.uri,
          path: resolved.path,
          range: resolved.selectionRange,
        };
      } catch (error) {
        setStatusMessage(`Cannot open ${symbol.name}: ${errorMessage(error)}`);
        return;
      }
    } else {
      location = {
        uri: symbol.uri,
        path: symbol.path,
        range: {
          start: { line: symbol.line, character: symbol.character },
          end: { line: symbol.line, character: symbol.character },
        },
      };
    }
    let groupId: EditorGroupId | undefined;
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      groupId = current.activeEditorGroupId === "primary" ? "secondary" : "primary";
      setStoreSplitOrientation(workspaceInstanceId, "vertical");
    }
    await openLspLocation(location, { groupId, preview: !options?.split });
  }, [openLspLocation, setStatusMessage, setStoreSplitOrientation, workspaceInstanceId]);

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

  const applyLspResourceOperationUnlocked = useCallback(async (
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => {
    flushPendingEditorText();
    const targetForPath = (absolutePath: string | null) => {
      if (!absolutePath) throw new Error("Language server resource URI is not a local file");
      const normalized = normalizeFsPath(absolutePath);
      const candidates = rootsRef.current.flatMap((root) => {
        const path = relativePathWithinRoot(root.path, normalized);
        return path !== null && path !== ""
          ? [{ root, path, rootLength: normalizeFsPath(root.path).length }]
          : [];
      }).sort((left, right) => right.rootLength - left.rootLength);
      const target = candidates[0];
      if (target) return { root: target.root, path: target.path };
      throw new Error(`Language server resource is outside the workspace: ${normalized}`);
    };
    const initialOpenFiles = openFilesRef.current;
    const initialFiles = Object.values(initialOpenFiles);
    const closeFiles = (files: OpenFileState[]) => {
      for (const file of files) {
        closeLspDocument(file);
      }
    };
    const bookmarkRef = (key: string): CodeWorkspaceFileRef | null => {
      for (const root of rootsRef.current) {
        const prefix = `root:${root.id}:`;
        if (key.startsWith(prefix)) {
          return { kind: "root", rootId: root.id, path: key.slice(prefix.length) };
        }
      }
      return null;
    };
    const commitResourceState = (
      change: WorkspaceResourceUiChange,
      previousOpenFiles: Record<string, OpenFileState>,
      nextOpenFiles: Record<string, OpenFileState>,
      reopenedFiles: OpenFileState[],
    ) => {
      const keyChanges: Record<string, string | null> = {};
      for (const key of Object.keys(previousOpenFiles)) {
        const nextKey = transformWorkspaceResourceFileKey(key, change);
        if (nextKey !== key) keyChanges[key] = nextKey;
      }
      const nextLspFiles: Record<string, LspFileState> = {};
      for (const [key, state] of Object.entries(lspFilesRef.current)) {
        if (transformWorkspaceResourceFileKey(key, change) === key && key in nextOpenFiles) {
          nextLspFiles[key] = state;
        }
      }
      reconcileNavigationFileReferences((ref) => transformWorkspaceResourceFileRef(ref, change));
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      setExpandedDirs((current) => transformWorkspaceResourceExpandedDirKeys(current, change));
      setSelected(transformWorkspaceResourceTreeSelection(currentUi.treeSelection, change));
      replaceWorkspaceFileState(nextOpenFiles, nextLspFiles, keyChanges);
      setRevealTarget(null);
      setBookmarks((current) => {
        let changed = false;
        const next = current.flatMap((bookmark) => {
          const nextKey = transformWorkspaceResourceFileKey(bookmark.fileKey, change);
          if (!nextKey) {
            changed = true;
            return [];
          }
          if (nextKey === bookmark.fileKey) return [bookmark];
          changed = true;
          const ref = bookmarkRef(bookmark.fileKey);
          const nextRef = ref ? transformWorkspaceResourceFileRef(ref, change) : null;
          const pathLabel = nextRef
            ? fileMeta(nextRef, rootsRef.current, looseFilesRef.current).subtitle
            : bookmark.pathLabel;
          return [{ ...bookmark, fileKey: nextKey, pathLabel }];
        });
        if (changed) writeWorkspaceBookmarks(workspaceInstanceId, next);
        return changed ? next : current;
      });
      for (const file of reopenedFiles) void syncLspDocument(file, "open");
    };

    if (operation.kind === "create") {
      const target = targetForPath(operation.path);
      const existingBefore = initialFiles.filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      if (
        operation.overwrite
        && existingBefore.some((file) => file.dirty)
      ) {
        throw new Error("CreateFile would overwrite an unsaved editor buffer");
      }
      const result = await workspaceApplyResourceOperation(target.root.path, {
        kind: "create",
        path: target.path,
        overwrite: operation.overwrite,
        ignoreIfExists: operation.ignoreIfExists,
      });
      if (result.ignored) return;
      notifyWorkspacePathGitChanged(target.root.id, target.path);
      if (!operation.overwrite) return;
      flushPendingEditorText();
      const currentOpenFiles = openFilesRef.current;
      const existing = Object.values(currentOpenFiles).filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      closeFiles(existing);
      const change: WorkspaceResourceUiChange = {
        kind: "remove",
        target: { rootId: target.root.id, path: target.path },
      };
      const nextOpenFiles = Object.fromEntries(Object.entries(currentOpenFiles).filter(([key]) => (
        transformWorkspaceResourceFileKey(key, change) !== null
      )));
      commitResourceState(change, currentOpenFiles, nextOpenFiles, []);
      return;
    }

    if (operation.kind === "delete") {
      const target = targetForPath(operation.path);
      const affectedBefore = initialFiles.filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      if (affectedBefore.some((file) => file.dirty)) {
        throw new Error("DeleteFile would discard an unsaved editor buffer");
      }
      const result = await workspaceApplyResourceOperation(target.root.path, {
        kind: "delete",
        path: target.path,
        recursive: operation.recursive,
        ignoreIfNotExists: operation.ignoreIfNotExists,
      });
      if (result.ignored) return;
      flushPendingEditorText();
      const currentOpenFiles = openFilesRef.current;
      const affected = Object.values(currentOpenFiles).filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      closeFiles(affected);
      const change: WorkspaceResourceUiChange = {
        kind: "remove",
        target: { rootId: target.root.id, path: target.path },
      };
      const nextOpenFiles = Object.fromEntries(Object.entries(currentOpenFiles).filter(([key]) => (
        transformWorkspaceResourceFileKey(key, change) !== null
      )));
      commitResourceState(change, currentOpenFiles, nextOpenFiles, []);
      notifyWorkspacePathGitChanged(target.root.id, target.path);
      return;
    }

    const source = targetForPath(operation.oldPath);
    const destination = targetForPath(operation.newPath);
    const destinationFilesBefore = initialFiles.filter((file) => (
      fileRefUnder(file.ref, destination.root.id, destination.path)
      && !fileRefUnder(file.ref, source.root.id, source.path)
    ));
    if (
      operation.overwrite
      && destinationFilesBefore.some((file) => file.dirty)
    ) {
      throw new Error("RenameFile would overwrite an unsaved editor buffer");
    }
    const result = await workspaceApplyResourceOperation(source.root.path, {
      kind: "rename",
      fromPath: source.path,
      toPath: destination.path,
      toRepoRoot: destination.root.path,
      overwrite: operation.overwrite,
      ignoreIfExists: operation.ignoreIfExists,
    });
    if (result.ignored) return;
    flushPendingEditorText();
    const currentOpenFiles = openFilesRef.current;
    const currentFiles = Object.values(currentOpenFiles);
    const sourceFiles = currentFiles.filter((file) => (
      fileRefUnder(file.ref, source.root.id, source.path)
    ));
    const destinationFiles = currentFiles.filter((file) => (
      fileRefUnder(file.ref, destination.root.id, destination.path)
      && !fileRefUnder(file.ref, source.root.id, source.path)
    ));
    closeFiles([...sourceFiles, ...destinationFiles]);
    const change: WorkspaceResourceUiChange = {
      kind: "move",
      source: { rootId: source.root.id, path: source.path },
      destination: { rootId: destination.root.id, path: destination.path },
    };
    const remappedFiles: Record<string, OpenFileState> = {};
    const reopenedFiles: OpenFileState[] = [];
    for (const [key, file] of Object.entries(currentOpenFiles)) {
      const ref = transformWorkspaceResourceFileRef(file.ref, change);
      if (!ref) continue;
      const nextKey = fileKey(ref);
      if (nextKey === key) {
        remappedFiles[key] = file;
        continue;
      }
      const meta = fileMeta(ref, rootsRef.current, looseFilesRef.current);
      const nextFile = {
        ...file,
        ref,
        key: nextKey,
        path: meta.path,
        title: meta.title,
        subtitle: meta.subtitle,
        languagePath: meta.languagePath,
      };
      remappedFiles[nextKey] = nextFile;
      reopenedFiles.push(nextFile);
    }
    commitResourceState(change, currentOpenFiles, remappedFiles, reopenedFiles);
    notifyWorkspacePathGitChanged(source.root.id, source.path);
    notifyWorkspacePathGitChanged(destination.root.id, destination.path);
  }, [
    closeLspDocument,
    flushPendingEditorText,
    notifyWorkspacePathGitChanged,
    reconcileNavigationFileReferences,
    replaceWorkspaceFileState,
    setExpandedDirs,
    setSelected,
    syncLspDocument,
    workspaceInstanceId,
  ]);

  const applyLspResourceOperation = useCallback(async (
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => {
    if (mountedRef.current) {
      flushSync(() => setWorkspaceResourceOperationLocked(true));
    }
    try {
      const result = await applyLspResourceOperationUnlocked(operation);
      const paths = operation.kind === "rename"
        ? [operation.oldPath, operation.newPath]
        : [operation.path];
      semanticIndex.invalidate(
        "resource-operation",
        paths.filter((path): path is string => !!path),
      );
      return result;
    } finally {
      if (mountedRef.current) {
        flushSync(() => setWorkspaceResourceOperationLocked(false));
      }
    }
  }, [applyLspResourceOperationUnlocked, mountedRef, semanticIndex.invalidate]);

  useEffect(() => {
    fileActionResourceOperationRef.current = applyLspResourceOperation;
    return () => {
      if (fileActionResourceOperationRef.current === applyLspResourceOperation) {
        fileActionResourceOperationRef.current = null;
      }
    };
  }, [applyLspResourceOperation]);

  type WorkspaceEditApplyOptions = {
    preview?: boolean;
    label?: string | null;
    semanticGeneration?: number;
    semanticRevision?: number;
    /** Provider command continuations are exact-revision guarded after their first edit. */
    semanticRequireReady?: boolean;
    /** Internal history replay must not create another history entry. */
    recordHistory?: boolean;
    /** Restrict provider edits to the opened workspace roots. */
    semanticWorkspaceOnly?: boolean;
  };

  const applyLspWorkspaceEditNow = useCallback(async (
    edit: LspWorkspaceEdit,
    options: WorkspaceEditApplyOptions = {},
  ) => {
    const orderedOperations = workspaceEditOperations(edit);
    const beforeSnapshots = options.recordHistory !== false && orderedOperations.length > 0
      ? await captureWorkspaceEditPathSnapshots(edit)
      : null;
    const beforeTabs = beforeSnapshots
      ? captureWorkspaceEditTabSnapshot(beforeSnapshots.map((snapshot) => snapshot.path))
      : null;
    const outcomes = await applyWorkspaceEdit(edit, {
      resolvePath: (file) => {
        if (file.path) return normalizeFsPath(file.path);
        return null;
      },
      getOpenBuffer: (absolutePath) => {
        const normalized = normalizeFsPath(absolutePath);
        for (const file of Object.values(openFilesRef.current)) {
          const path = absolutePathForOpenFile(file);
          if (path && fsPathEquals(path, normalized)) {
            return {
              text: file.text,
              dirty: file.dirty,
              key: file.key,
              version: lspDocumentVersion(file.key),
              lspSynced: isLspDocumentSynced(file.key, file.text),
            };
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
            return {
              text: disk.text,
              hash: disk.hash,
              encoding: disk.encoding ?? "UTF-8",
              bom: disk.bom ?? false,
            };
          } catch {
            return null;
          }
        }
        try {
          const disk = await workspaceReadLooseFile(absolutePath);
          return {
            text: disk.text,
            hash: disk.hash,
            encoding: disk.encoding ?? "UTF-8",
            bom: disk.bom ?? false,
          };
        } catch {
          return null;
        }
      },
      writeDisk: async (absolutePath, text, expectedHash, encoding = "UTF-8", bom = false) => {
        const replayMetadata = replayWorkspaceEncodingRef.current?.get(fsPathComparisonKey(absolutePath));
        const effectiveEncoding = replayMetadata?.encoding ?? encoding;
        const effectiveBom = replayMetadata?.bom ?? bom;
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
          if (effectiveEncoding.toLowerCase() !== "utf-8" && typeof workspaceWriteFileEncoded === "function") {
            await workspaceWriteFileEncoded(root.path, rel, text, expectedHash, effectiveEncoding, effectiveBom);
          } else {
            await workspaceWriteFile(root.path, rel, `${effectiveBom ? "\uFEFF" : ""}${text}`, expectedHash);
          }
          await lspWorkspaceDidChangeWatchedFiles(workspaceInstanceId, [{
            path: absolutePath,
            type: 2,
          }]).catch(() => 0);
          return;
        }
        if (effectiveEncoding.toLowerCase() !== "utf-8" && typeof workspaceWriteLooseFileEncoded === "function") {
          await workspaceWriteLooseFileEncoded(absolutePath, text, expectedHash, effectiveEncoding, effectiveBom);
        } else {
          await workspaceWriteLooseFile(absolutePath, `${effectiveBom ? "\uFEFF" : ""}${text}`, expectedHash);
        }
        await lspWorkspaceDidChangeWatchedFiles(workspaceInstanceId, [{
          path: absolutePath,
          type: 2,
        }]).catch(() => 0);
      },
      confirmChangeAnnotations: async (annotations) => {
        const visible = annotations.slice(0, 8);
        const details = visible.map((annotation) => (
          annotation.description
            ? `${annotation.label}: ${annotation.description}`
            : annotation.label
        ));
        if (annotations.length > visible.length) {
          details.push(`And ${annotations.length - visible.length} more changes`);
        }
        return confirmAppDialog({
          title: "Apply language server changes",
          message: details.join("\n"),
          confirmLabel: "Apply",
        });
      },
      confirmWorkspaceEdit: options.preview
        ? (preview: WorkspaceEditPreview, edit: LspWorkspaceEdit) => {
            if (preview.usages.length > 0) {
              return new Promise<boolean | LspWorkspaceEdit>((resolve) => {
                setRefactoringPreviewModal({
                  title: options.label?.trim() || preview.label || "Review workspace changes",
                  preview: {
                    ...preview,
                    label: options.label?.trim() || preview.label,
                  },
                  originalEdit: edit,
                  resolve,
                });
              });
            }
            return confirmAppDialog({
              title: options.label?.trim() || "Review workspace changes",
              message: formatWorkspaceEditPreview({
                ...preview,
                label: options.label?.trim() || preview.label,
              }),
              confirmLabel: "Apply changes",
            });
          }
        : undefined,
      preflightMutation: options.semanticGeneration == null || options.semanticRevision == null
        ? undefined
        : () => {
          const current = semanticIndex.current();
          const semanticToken = {
            generation: options.semanticGeneration!,
            revision: options.semanticRevision!,
          };
          const valid = options.semanticRequireReady === false
            ? current.revision === semanticToken.revision
            : workspaceSemanticIndexBuildIsCurrent(current, semanticToken);
          if (!valid) {
            throw new Error("Semantic result became stale before changes were applied; run the action again");
          }
        },
      validateOperationPaths: options.semanticWorkspaceOnly || (options.semanticGeneration != null && options.semanticRevision != null)
        ? (operations) => validateSemanticWorkspaceEditPaths(
          operations,
          rootsRef.current.map((root) => root.path),
        )
        : undefined,
      createFile: (operation) => applyLspResourceOperation(operation),
      renameFile: (operation) => applyLspResourceOperation(operation),
      deleteFile: (operation) => applyLspResourceOperation(operation),
    });
    if (outcomes.some((outcome) => (
      outcome.status === "applied-create"
      || outcome.status === "applied-rename"
      || outcome.status === "applied-delete"
    ))) {
      refreshTree();
    }
    const mutated = outcomes.some((outcome) => outcome.status.startsWith("applied"));
    if (mutated) {
      semanticIndex.invalidate(
        "workspace-edit",
        outcomes.flatMap((outcome) => outcome.status.startsWith("applied") ? [outcome.path] : []),
      );
    }
    let historyUnavailable = options.recordHistory !== false
      && orderedOperations.length > 0
      && beforeSnapshots === null
      && mutated;
    if (beforeSnapshots && mutated) {
      const afterSnapshots = await captureWorkspaceEditPathSnapshots(edit);
      if (!afterSnapshots) historyUnavailable = true;
      const changed = afterSnapshots?.some((snapshot, index) => (
        snapshot.path !== beforeSnapshots[index]?.path
        || snapshot.exists !== beforeSnapshots[index]?.exists
        || snapshot.text !== beforeSnapshots[index]?.text
        || snapshot.encoding !== beforeSnapshots[index]?.encoding
        || snapshot.bom !== beforeSnapshots[index]?.bom
      ));
      if (afterSnapshots && changed) {
        const afterTabs = captureWorkspaceEditTabSnapshot(
          afterSnapshots.map((snapshot) => snapshot.path),
        );
        workspaceEditHistorySequenceRef.current += 1;
        const label = options.label?.trim() || "Workspace edit";
        const entry: WorkspaceEditHistoryEntry = {
          id: `${workspaceInstanceId}:${workspaceEditHistorySequenceRef.current}`,
          label,
          affectedPaths: beforeSnapshots.map((snapshot) => snapshot.path),
          undo: async () => {
            await replayWorkspacePathSnapshotsRef.current(beforeSnapshots);
            if (beforeTabs) await restoreWorkspaceEditTabs(beforeTabs);
          },
          redo: async () => {
            await replayWorkspacePathSnapshotsRef.current(afterSnapshots);
            await restoreWorkspaceEditTabs(afterTabs);
          },
        };
        workspaceEditHistory.push(entry);
        setWorkspaceEditHistoryRevision((revision) => revision + 1);
      }
    }
    setStatusMessage([
      summarizeWorkspaceEditOutcomes(outcomes),
      historyUnavailable ? "Undo unavailable: workspace resource snapshot is incomplete" : null,
    ].filter(Boolean).join("; "));
    return outcomes;
  }, [
    absolutePathForOpenFile,
    applyLspResourceOperation,
    captureWorkspaceEditPathSnapshots,
    captureWorkspaceEditTabSnapshot,
    formatWorkspaceEditPreview,
    isLspDocumentSynced,
    lspDocumentVersion,
    refreshTree,
    saveOpenBufferText,
    setStatusMessage,
    restoreWorkspaceEditTabs,
    semanticIndex.invalidate,
    semanticIndex.current,
    updateFileText,
    workspaceEditHistory,
    workspaceInstanceId,
  ]);

  replayWorkspacePathSnapshotsRef.current = async (snapshots) => {
    const currentSnapshots = await Promise.all(
      snapshots.map((snapshot) => readWorkspaceEditPathSnapshot(snapshot.path)),
    );
    if (!currentSnapshots.every(
      (snapshot): snapshot is WorkspaceEditPathSnapshot => snapshot !== null,
    )) {
      throw new Error("A workspace history path is not a regular file");
    }
    replayWorkspaceEncodingRef.current = new Map(
      snapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => [
          fsPathComparisonKey(snapshot.path),
          { encoding: snapshot.encoding ?? "UTF-8", bom: snapshot.bom ?? false },
        ]),
    );
    try {
      const outcomes = await applyLspWorkspaceEditNow(
        buildWorkspacePathSnapshotEdit(currentSnapshots, snapshots),
        { recordHistory: false },
      );
      const response = workspaceEditApplyResponse(outcomes);
      if (!response.applied) {
        throw new Error(response.failureReason ?? "Workspace history replay failed");
      }
    } finally {
      replayWorkspaceEncodingRef.current = null;
    }
  };

  const applyLspWorkspaceEdit = useCallback((
    edit: LspWorkspaceEdit,
    options: WorkspaceEditApplyOptions = {},
  ) => {
    const pending = workspaceEditQueueRef.current.then(() => applyLspWorkspaceEditNow(edit, options));
    workspaceEditQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, [applyLspWorkspaceEditNow]);

  const workspaceEditHistoryState = useMemo(
    () => workspaceEditHistory.state(),
    [workspaceEditHistory, workspaceEditHistoryRevision],
  );

  const undoWorkspaceEdit = useCallback(async () => {
    try {
      const result = await workspaceEditHistory.undo();
      if (result) {
        setStatusMessage(`Undid ${result.entry.label} (${result.entry.affectedPaths.length} files)`);
      }
    } catch (error) {
      setStatusMessage(`Cannot undo workspace edit: ${errorMessage(error)}`);
    } finally {
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
  }, [setStatusMessage, workspaceEditHistory]);

  const redoWorkspaceEdit = useCallback(async () => {
    try {
      const result = await workspaceEditHistory.redo();
      if (result) {
        setStatusMessage(`Redid ${result.entry.label} (${result.entry.affectedPaths.length} files)`);
      }
    } catch (error) {
      setStatusMessage(`Cannot redo workspace edit: ${errorMessage(error)}`);
    } finally {
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
  }, [setStatusMessage, workspaceEditHistory]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<LspWorkspaceApplyEditRequest>("lsp://workspace-apply-edit", (event) => {
      const request = event.payload;
      if (request.workspaceId !== workspaceInstanceId) return;
      void (async () => {
        try {
          const semanticGuard = providerCommandSemanticGuardRef.current;
          const outcomes = await applyLspWorkspaceEdit(request.edit, {
            preview: true,
            label: request.label ?? "Language server changes",
            semanticGeneration: semanticGuard?.generation,
            semanticRevision: semanticGuard?.revision,
            semanticRequireReady: semanticGuard?.requireReady,
          });
          const response = workspaceEditApplyResponse(outcomes);
          await lspResolveWorkspaceEdit(
            request.requestId,
            workspaceInstanceId,
            response.applied,
            response.failureReason,
            response.failedChange,
          );
        } catch (error) {
          const message = errorMessage(error);
          setStatusMessage(message);
          await lspResolveWorkspaceEdit(
            request.requestId,
            workspaceInstanceId,
            false,
            message,
          ).catch(() => undefined);
        }
      })();
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyLspWorkspaceEdit, setStatusMessage, workspaceInstanceId]);

  const requestCodeActions = useCallback(async (
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
    only: string[] = [],
  ): Promise<{
    actions: LspCodeAction[];
    semanticToken: WorkspaceSemanticIndexBuildToken | null;
  }> => {
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.codeAction) return { actions: [], semanticToken: null };
    const semanticQuery = only.some((kind) => kind === "refactor" || kind.startsWith("refactor."));
    const expectedRevision = semanticIndex.current().revision;
    const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) {
      setStatusMessage(`${semanticQuery ? "Refactor" : "Code actions"} require the language server to finish synchronizing current editor buffers`);
      return { actions: [], semanticToken: null };
    }
    const descriptor = lspDescriptorForFile(live);
    if (!descriptor) return { actions: [], semanticToken: null };
    const buildToken = semanticIndex.beginBuild("language-server");
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
          tags: item.tags,
          relatedInformation: item.relatedInformation,
          codeDescription: item.codeDescription ? { href: item.codeDescription } : undefined,
          data: item.data,
        })),
        only,
      );
      updateLspStatusForFile(live, result.status);
      const completion = semanticIndex.finishQuery(buildToken, {
        kind: semanticQuery ? "refactor" : "code-action",
        resultCount: result.actions.length,
      });
      return completion.accepted
        ? { actions: result.actions, semanticToken: buildToken }
        : { actions: [], semanticToken: null };
    } catch (error) {
      semanticIndex.failBuild(buildToken, errorMessage(error));
      return { actions: [], semanticToken: null };
    }
  }, [
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.current,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    setStatusMessage,
    updateLspStatusForFile,
  ]);

  const runCodeAction = useCallback(async (
    action: LspCodeAction,
    file: OpenFileState,
    semanticToken: WorkspaceSemanticIndexBuildToken | null = null,
  ) => {
    try {
      const assertSemanticCurrent = () => {
        if (
          semanticToken
          && !workspaceSemanticIndexBuildIsCurrent(semanticIndex.current(), semanticToken)
        ) {
          throw new Error("Refactor result became stale because the workspace changed; request it again");
        }
      };
      assertSemanticCurrent();
      let executableAction = action;
      const raw = action.raw;
      const hasDeferredData = raw != null
        && typeof raw === "object"
        && !Array.isArray(raw)
        && "data" in raw;
      if (hasDeferredData) {
        const descriptor = lspDescriptorForFile(file);
        if (descriptor) {
          try {
            const resolved = await lspCodeActionResolve(descriptor, raw);
            updateLspStatusForFile(file, resolved.status);
            if (resolved.action) executableAction = resolved.action;
          } catch (error) {
            // A server may advertise data but not implement resolve. Keep the
            // original action usable and make the fallback visible.
            setStatusMessage(`Code action resolve failed: ${errorMessage(error)}`);
          }
        }
      }
      assertSemanticCurrent();
      let semanticEditApplied = false;
      let semanticCommandRevision: number | null = null;
      const result = await executeCodeAction(executableAction, {
        applyEdit: async (edit) => {
          const outcomes = await applyLspWorkspaceEdit(edit, {
            // The applier only opens the dialog for multi-file/resource edits;
            // single-file quick fixes remain an immediate action.
            preview: true,
            label: executableAction.title,
            semanticGeneration: semanticToken?.generation,
            semanticRevision: semanticToken?.revision,
          });
          semanticEditApplied = !outcomes.some((outcome) => (
            outcome.status === "failed" || outcome.status === "skipped"
          ));
          if (semanticToken && semanticEditApplied) {
            semanticCommandRevision = semanticIndex.current().revision;
          }
          return outcomes;
        },
        executeCommand: async (command, argumentsValue) => {
          const descriptor = lspDescriptorForFile(file);
          if (!descriptor) throw new Error("Cannot resolve the language server for this code action");
          const execute = async () => {
            if (semanticToken) {
              const current = semanticIndex.current();
              if (semanticEditApplied) {
                if (semanticCommandRevision == null || current.revision !== semanticCommandRevision) {
                  throw new Error("Refactor command continuation became stale because the workspace changed");
                }
              } else {
                assertSemanticCurrent();
              }
              providerCommandSemanticGuardRef.current = {
                generation: current.generation,
                revision: semanticEditApplied ? semanticCommandRevision! : semanticToken.revision,
                requireReady: !semanticEditApplied,
              };
            }
            try {
              return await lspExecuteCommand(descriptor, command, argumentsValue);
            } finally {
              if (semanticToken) {
                providerCommandSemanticGuardRef.current = null;
                semanticIndex.invalidate("provider-command");
              }
            }
          };
          if (!semanticToken) return execute();
          const pending = providerCommandQueueRef.current.then(execute);
          providerCommandQueueRef.current = pending.then(() => undefined, () => undefined);
          return pending;
        },
      });
      if (result.status === "executed-command") {
        setStatusMessage(`Executed code action: ${executableAction.title}`);
      } else if (result.status === "empty") {
        setStatusMessage("Code action had no edit or command to apply");
      }
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  }, [
    applyLspWorkspaceEdit,
    lspCodeActionResolve,
    lspDescriptorForFile,
    semanticIndex.current,
    semanticIndex.invalidate,
    setStatusMessage,
    updateLspStatusForFile,
  ]);

  const showCodeActionsMenu = useCallback(async (
    clientX: number,
    clientY: number,
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
    only: string[] = [],
    sectionLabel = "code actions",
  ) => {
    const requested = await requestCodeActions(file, range, diagnostics, only);
    const actions = requested.actions;
    if (requested.semanticToken && !workspaceSemanticIndexBuildIsCurrent(
      semanticIndex.current(),
      requested.semanticToken,
    )) {
      setStatusMessage("Refactor actions became stale because the workspace changed; request them again");
      return;
    }
    const filtered = only.length === 0
      ? actions
      : actions.filter((action) => only.some((kind) => (
        action.kind === kind || action.kind?.startsWith(`${kind}.`)
      )));
    if (!filtered.length) {
      setStatusMessage(`No ${sectionLabel} provided by the language server`);
      return;
    }
    const sorted = [...filtered].sort((a, b) => {
      const aQuick = a.kind?.includes("quickfix") ? 0 : 1;
      const bQuick = b.kind?.includes("quickfix") ? 0 : 1;
      if (aQuick !== bQuick) return aQuick - bQuick;
      if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    openTreeContextMenuAt(clientX, clientY, sorted.map((action) => ({
      label: action.title,
      onClick: () => void runCodeAction(action, file, requested.semanticToken),
    })));
  }, [
    openTreeContextMenuAt,
    requestCodeActions,
    runCodeAction,
    semanticIndex.current,
    setStatusMessage,
  ]);

  const openRefactorActions = useCallback(async (only: string[], sectionLabel: string) => {
    const file = activeFile;
    if (!file || file.loading || file.library) return;
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      file,
      range,
      [],
      only,
      sectionLabel,
    );
  }, [activeFile, showCodeActionsMenu]);

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

  const navigateDiagnostic = useCallback((direction: 1 | -1) => {
    const file = activeFile;
    if (!file) return;
    const diags = (lspFilesRef.current[file.key]?.diagnostics ?? []).slice().sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return a.range.start.line - b.range.start.line;
      }
      return a.range.start.character - b.range.start.character;
    });
    if (diags.length === 0) {
      setStatusMessage("No errors or warnings in current file");
      return;
    }

    const cursor = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const currentLine = cursor.line + 1;
    const currentColumn = cursor.character + 1;

    let targetIndex = -1;
    if (direction === 1) {
      targetIndex = diags.findIndex(
        (d) =>
          d.range.start.line + 1 > currentLine ||
          (d.range.start.line + 1 === currentLine && d.range.start.character + 1 > currentColumn),
      );
      if (targetIndex === -1) {
        targetIndex = 0;
      }
    } else {
      for (let i = diags.length - 1; i >= 0; i--) {
        const d = diags[i];
        if (
          d.range.start.line + 1 < currentLine ||
          (d.range.start.line + 1 === currentLine && d.range.start.character + 1 < currentColumn)
        ) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === -1) {
        targetIndex = diags.length - 1;
      }
    }

    const target = diags[targetIndex];
    if (target) {
      void openFile(file.ref, {
        location: {
          line: target.range.start.line + 1,
          column: target.range.start.character + 1,
        },
      });
      setStatusMessage(`${target.severity === 1 ? "Error" : "Warning"}: ${target.message}`);
    }
  }, [activeEditorGroupId, activeFile, cursorPositions, openFile, setStatusMessage]);

  const optimizeImports = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const wholeFileRange: LspRange = {
      start: { line: 0, character: 0 },
      end: { line: file.text.split("\n").length, character: 0 },
    };
    const { actions, semanticToken } = await requestCodeActions(
      file,
      wholeFileRange,
      [],
      ["source.organizeImports"],
    );
    if (!actions.length) {
      setStatusMessage("No import optimization available from language server");
      return;
    }
    await runCodeAction(actions[0], file, semanticToken);
    setStatusMessage("Imports organized");
  }, [activeFile, requestCodeActions, runCodeAction, setStatusMessage]);

  const workspaceCommands = useMemo<WorkspaceCommand[]>(() => [
    {
      id: "workspace.goToFile",
      title: "Go to File",
      category: "Navigation",
      keybinding: "Ctrl+Shift+N",
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
        if (recentFilesOpen && !recentChangedOnly) setRecentAdvanceNonce((nonce) => nonce + 1);
        else openRecentFiles();
      },
    },
    {
      id: "workspace.recentChangedFiles",
      title: "Recently Changed Files",
      category: "Navigation",
      keybinding: "Ctrl+Shift+E",
      keywords: ["modified", "changes", "history"],
      run: () => {
        if (recentFilesOpen && recentChangedOnly) setRecentAdvanceNonce((nonce) => nonce + 1);
        else openRecentFiles({ changedOnly: true });
      },
    },
    {
      id: "workspace.lastEditLocation",
      title: "Last Edit Location",
      category: "Navigation",
      keybinding: "Ctrl+Shift+Backspace",
      keywords: ["edit", "history", "previous", "back"],
      run: () => {
        navigateLastEditLocation();
      },
    },
    {
      id: "workspace.nextError",
      title: "Next Highlighted Error / Warning",
      category: "Navigation",
      keybinding: "F2",
      keywords: ["error", "warning", "diagnostic", "problem", "next"],
      when: (context) => context.focus !== "tree" && !!activeFile,
      run: () => navigateDiagnostic(1),
    },
    {
      id: "workspace.prevError",
      title: "Previous Highlighted Error / Warning",
      category: "Navigation",
      keybinding: "Shift+F2",
      keywords: ["error", "warning", "diagnostic", "problem", "previous"],
      when: (context) => context.focus !== "tree" && !!activeFile,
      run: () => navigateDiagnostic(-1),
    },
    {
      id: "workspace.quickDefinition",
      title: "Quick Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+I",
      keybindings: ["Mod-Shift-I"],
      keywords: ["peek definition", "implementation", "quick"],
      when: () => !!activeFile,
      run: () => {
        const file = activeFile;
        if (!file) return;
        const pos = editorSelectionRef.current.end;
        void peekDefinitionRef.current(file, { line: pos.line, character: pos.character });
      },
    },
    {
      id: "workspace.parameterInfo",
      title: "Parameter Info",
      category: "Code",
      keybinding: "Ctrl+P",
      keybindings: ["Mod-P"],
      keywords: ["signature", "parameters", "arguments"],
      when: () => !!activeFile,
      run: () => {
        const file = activeFile;
        if (!file) return;
        const pos = editorSelectionRef.current.end;
        void getLspSignatureHelpRef.current(file, { line: pos.line, character: pos.character });
      },
    },
    {
      id: "workspace.optimizeImports",
      title: "Optimize Imports",
      category: "Code",
      keybinding: "Ctrl+Alt+O",
      keybindings: ["Mod-Alt-O"],
      keywords: ["organize imports", "clean imports", "sort imports"],
      when: () => !!activeFile,
      run: () => void optimizeImports(),
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
      id: "workspace.safeDeleteSymbol",
      title: "Safe Delete Symbol",
      category: "Refactor",
      keybinding: "Alt+Delete",
      keywords: ["refactor", "delete", "safe delete", "usages"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library
        && (!activeCapabilities || (!!activeCapabilities.references && !!activeCapabilities.rename)),
      run: () => void safeDeleteSymbolRef.current(),
    },
    {
      id: "workspace.refactorThis",
      title: "Refactor This…",
      category: "Refactor",
      keybinding: "Ctrl+Alt+Shift+T",
      keybindings: ["Mod-Alt-Shift-T", "Mod-Alt-Shift-t", "Ctrl+T"],
      keywords: ["refactor", "refactor this", "extract", "inline", "rename", "move"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library && !!activeCapabilities?.codeAction,
      run: () => void openRefactorActions(["refactor"], "Refactor actions"),
    },
    {
      id: "workspace.extractMethod",
      title: "Extract Method",
      category: "Refactor",
      keybinding: "Ctrl+Alt+M",
      keybindings: ["Mod-Alt-M", "Mod-Alt-m"],
      keywords: ["refactor", "extract", "method", "function"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library && !!activeCapabilities?.codeAction,
      run: () => void openRefactorActions(["refactor.extract", "refactor.extract.function", "refactor.extract.method"], "Extract Method/Function actions"),
    },
    {
      id: "workspace.extractVariable",
      title: "Extract Variable",
      category: "Refactor",
      keybinding: "Ctrl+Alt+V",
      keybindings: ["Mod-Alt-V", "Mod-Alt-v"],
      keywords: ["refactor", "extract", "variable", "local"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library && !!activeCapabilities?.codeAction,
      run: () => void openRefactorActions(["refactor.extract.variable", "refactor.extract.constant"], "Extract Variable/Constant actions"),
    },
    {
      id: "workspace.inline",
      title: "Inline",
      category: "Refactor",
      keybinding: "Ctrl+Alt+N",
      keybindings: ["Mod-Alt-N", "Mod-Alt-n"],
      keywords: ["refactor", "inline", "variable", "method", "function"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library && !!activeCapabilities?.codeAction,
      run: () => void openRefactorActions(["refactor.inline"], "Inline actions"),
    },
    {
      id: "workspace.changeSignature",
      title: "Change Signature",
      category: "Refactor",
      keybinding: "Ctrl+F6",
      keybindings: ["Mod-F6"],
      keywords: ["refactor", "signature", "parameters", "arguments"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library && !!activeCapabilities?.codeAction,
      run: () => void openRefactorActions(["refactor.rewrite.changeSignature", "refactor.changeSignature"], "Change Signature actions"),
    },
    {
      id: "workspace.moveRefactor",
      title: "Move",
      category: "Refactor",
      keybinding: "F6",
      keywords: ["refactor", "move", "symbol", "class"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library && !!activeCapabilities?.codeAction,
      run: () => void openRefactorActions(["refactor.move", "refactor.rewrite"], "Move actions"),
    },
    {
      id: "workspace.aiExplainSyntax",
      title: t("codeWorkspaceAi.commandExplainSyntax"),
      category: "AI",
      keybinding: "Ctrl+Alt+S",
      keywords: ["ai", "syntax", "grammar", "teach", "learn", "explain", "语法", "讲解"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading,
      run: () => void runEditorAiActionAtCursor("syntax"),
    },
    {
      id: "workspace.aiExplainCode",
      title: t("codeWorkspaceAi.commandExplainCode"),
      category: "AI",
      keybinding: "Ctrl+Alt+E",
      keywords: ["ai", "explain", "describe", "解释"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading,
      run: () => void runEditorAiActionAtCursor("explain"),
    },
    {
      id: "workspace.aiFixSelection",
      title: t("codeWorkspaceAi.commandFix"),
      category: "AI",
      keywords: ["ai", "fix", "repair", "修复"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading,
      run: () => void runEditorAiActionAtCursor("fix"),
    },
    {
      id: "workspace.aiAskSelection",
      title: t("codeWorkspaceAi.commandAsk"),
      category: "AI",
      keywords: ["ai", "ask", "rewrite", "改写", "询问"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading,
      run: () => void runEditorAiActionAtCursor("rewrite"),
    },
    {
      // The keyboard path to the explain actions bypasses the selection
      // toolbar, so without this there is no way to change the answer language
      // without reaching for the mouse.
      id: "workspace.aiCycleAnswerLanguage",
      title: t("codeWorkspaceAi.commandCycleAnswerLanguage", {
        current: t(answerLanguageLabelKey(editorAiPreferences.answerLanguage)),
      }),
      category: "AI",
      keywords: ["ai", "language", "answer", "chinese", "english", "语言", "回答", "中文", "英文"],
      run: cycleAiAnswerLanguage,
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
      id: "workspace.toggleSoftWrap",
      title: `${codeViewProfile.softWrap ? "Disable" : "Enable"} Soft Wrap`,
      category: "View",
      keywords: ["wrap", "long lines", "line wrapping"],
      when: (context) => context.focus === "editor" || context.focus === "workspace",
      run: toggleSoftWrap,
    },
    {
      id: "workspace.toggleColumnSelection",
      title: `${columnSelectionMode ? "Disable" : "Enable"} Column Selection Mode`,
      category: "Edit",
      keybinding: "Alt+Shift+Insert",
      keywords: ["rectangular", "block selection", "column mode"],
      when: (context) => context.focus === "editor" || context.focus === "workspace",
      run: toggleColumnSelectionMode,
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
      id: "workspace.runActiveJavaFile",
      title: "Run Current Target",
      category: "Run",
      keybinding: "Shift+F10",
      keybindings: ["Ctrl+Shift+F10"],
      keywords: ["target", "main", "run", "application"],
      when: () => !!activeFile
        && activeFile.ref.kind === "root"
        && !activeFile.library,
      run: () => runActiveJavaFileRef.current(),
    },
    {
      id: "workspace.runContextConfiguration",
      title: "Run Context Configuration",
      category: "Run",
      keybinding: "Ctrl+Shift+F10",
      keybindings: ["Mod-Shift-F10"],
      keywords: ["run context", "run file", "main", "test", "target"],
      when: () => !!activeFile
        && activeFile.ref.kind === "root"
        && !activeFile.library,
      run: () => runActiveJavaFileRef.current(),
    },
    {
      id: "workspace.buildProject",
      title: "Build Project",
      category: "Build",
      keybinding: "Ctrl+F9",
      keywords: ["build", "compile", "maven", "gradle"],
      when: () => roots.length > 0,
      run: () => buildActiveProjectRef.current(false),
    },
    {
      id: "workspace.recompileActiveFile",
      title: activeFile ? `Recompile '${activeFile.title}'` : "Recompile Active File",
      category: "Build",
      keybinding: "Ctrl+Shift+F9",
      keybindings: ["Mod-Shift-F9"],
      keywords: ["compile", "recompile", "single file", "build", "javac"],
      when: () => !!activeFile && !activeFile.library,
      run: () => recompileActiveFileRef.current(),
    },
    {
      id: "workspace.toggleBreakpoint",
      title: "Toggle Line Breakpoint",
      category: "Debug",
      keybinding: "Ctrl+F8",
      keybindings: ["Mod-F8"],
      keywords: ["breakpoint", "toggle breakpoint", "debug"],
      when: () => !!activeFile && !activeFile.library,
      run: () => {
        const cursor = cursorPositions[activeEditorGroupId];
        const line = (cursor?.line ?? editorSelectionRef.current.start.line) + 1;
        toggleActiveBreakpointRef.current(line);
      },
    },
    {
      id: "workspace.viewBreakpoints",
      title: "View Breakpoints",
      category: "Debug",
      keybinding: "Ctrl+Shift+F8",
      keybindings: ["Mod-Shift-F8"],
      keywords: ["breakpoint", "manage breakpoints", "condition", "log", "debug"],
      run: () => {
        const cursor = cursorPositions[activeEditorGroupId];
        const line = (cursor?.line ?? editorSelectionRef.current.start.line) + 1;
        editActiveBreakpointRef.current(line);
      },
    },
    {
      id: "workspace.toggleMuteBreakpoints",
      title: "Mute / Unmute Breakpoints",
      category: "Debug",
      keywords: ["debug", "breakpoint", "mute", "disable", "pause"],
      run: () => {
        const debugSession = debugRef.current;
        if (!debugSession) return;
        const next = !debugSession.breakpointsMuted;
        debugSession.setBreakpointsMuted(next);
        setStatusMessage(next ? "Breakpoints muted" : "Breakpoints unmuted");
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
      id: "workspace.showAnalysis",
      title: "Show Code Analysis",
      category: "Analyze",
      keywords: ["inspection", "data flow", "diagnostics", "lsp", "psi"],
      run: () => {
        setBottomDockTab("analysis");
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
      id: "workspace.undoWorkspaceEdit",
      title: workspaceEditHistoryState.undoLabel
        ? `Undo ${workspaceEditHistoryState.undoLabel}`
        : "Undo Workspace Edit",
      category: "Edit",
      keybinding: "Ctrl+Z",
      keybindings: ["Cmd+Z"],
      keywords: ["undo", "workspace edit", "refactor"],
      when: (context) => context.focus !== "tree"
        && context.focus !== "terminal"
        && workspaceEditHistoryState.canUndo
        && !workspaceEditHistoryState.busy,
      run: () => void undoWorkspaceEdit(),
    },
    {
      id: "workspace.redoWorkspaceEdit",
      title: workspaceEditHistoryState.redoLabel
        ? `Redo ${workspaceEditHistoryState.redoLabel}`
        : "Redo Workspace Edit",
      category: "Edit",
      keybinding: "Ctrl+Shift+Z",
      keybindings: ["Cmd+Shift+Z"],
      keywords: ["redo", "workspace edit", "refactor"],
      when: (context) => context.focus !== "tree"
        && context.focus !== "terminal"
        && workspaceEditHistoryState.canRedo
        && !workspaceEditHistoryState.busy,
      run: () => void redoWorkspaceEdit(),
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
    openRefactorActions,
    openRecentFiles,
    openSearchEverywhere,
    openStructurePopup,
    recentFilesOpen,
    refreshTree,
    reloadFile,
    revealEditorTabInTree,
    renameSelected,
    roots.length,
    saveFile,
    seSymbolsAvailable,
    selected,
    selectedRootDirectory,
    intelligencePreferences.inlayHintsEnabled,
    intelligencePreferences.inlineBlameEnabled,
    codeViewProfile.softWrap,
    columnSelectionMode,
    intelligencePreferences.formatOnSave,
    setFormatOnSave,
    toggleInlayHints,
    toggleInlayHintsForActiveLanguage,
    toggleInlineBlame,
    toggleSoftWrap,
    toggleColumnSelectionMode,
    toggleBookmarkAtCursor,
    languagePanelOpen,
    runEditorAiActionAtCursor,
    t,
    toggleProjectTree,
    toggleOutlinePane,
    toggleTodosPane,
    navigateDiagnostic,
    optimizeImports,
    undoWorkspaceEdit,
    redoWorkspaceEdit,
    workspaceEditHistoryState,
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
      // While the debugger is stopped in this file, the hover belongs to the
      // debugger (IDEA shows the value, not the javadoc). Read through the ref:
      // the debug hook is declared later in this component.
      const session = debugRef.current;
      if (session?.state?.status === "stopped") {
        const stoppedPath = session.currentLocation?.path;
        const filePath = absolutePathForOpenFile(file);
        if (stoppedPath && filePath && fsPathEquals(stoppedPath, filePath)) {
          return null;
        }
      }
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
    [absolutePathForOpenFile, lspDescriptorForFile, updateLspStatusForFile],
  );
  getLspHoverRef.current = getLspHover;

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

  const peekDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      try {
        const result = await lspDefinition(descriptor, position);
        updateLspStatusForFile(file, result.status);
        if (!result.locations.length) {
          setStatusMessage("No definition found");
          return false;
        }
        setLocationPeek({ title: "Quick Definition", locations: result.locations });
        return true;
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, setLocationPeek, setStatusMessage, updateLspStatusForFile],
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
  goToDefinitionRef.current = goToDefinition;
  peekDefinitionRef.current = peekDefinition;
  goToTypeDefinitionRef.current = goToTypeDefinition;
  goToImplementationRef.current = goToImplementation;
  getLspSignatureHelpRef.current = getLspSignatureHelp;

  const renameSymbolAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.rename) {
      setStatusMessage("Rename is not supported by this language server");
      return;
    }
    const expectedRevision = semanticIndex.current().revision;
    const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) {
      setStatusMessage("Rename requires the language server to finish synchronizing current editor buffers");
      return;
    }
    const descriptor = lspDescriptorForFile(live);
    if (!descriptor) return;
    const position = editorSelectionRef.current.start;
    const buildToken = semanticIndex.beginBuild("language-server");
    try {
      const prepared = await lspPrepareRename(descriptor, position);
      updateLspStatusForFile(live, prepared.status);
      if (!prepared.allowed && prepared.range == null && !prepared.placeholder) {
        semanticIndex.abandonBuild(buildToken);
        setStatusMessage(prepared.message ?? "Cannot rename symbol here");
        return;
      }
      const defaultName = prepared.placeholder
        ?? (() => {
          const lines = live.text.split("\n");
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
      if (!nextName || nextName === defaultName) {
        semanticIndex.abandonBuild(buildToken);
        return;
      }
      const beforeRename = semanticIndex.current();
      if (
        beforeRename.revision !== buildToken.revision
        || beforeRename.activeProviders.length > 0
      ) {
        semanticIndex.abandonBuild(buildToken);
        setStatusMessage("Rename was cancelled because the workspace changed while the dialog was open");
        return;
      }
      const renamed = await lspRename(descriptor, position, nextName);
      updateLspStatusForFile(live, renamed.status);
      const operationCount = workspaceEditOperations(renamed.edit).length;
      if (operationCount === 0) {
        semanticIndex.finishQuery(buildToken, { kind: "rename", resultCount: 0 });
        setStatusMessage("Rename produced no edits");
        return;
      }
      const completion = semanticIndex.finishQuery(buildToken, {
        kind: "rename",
        resultCount: operationCount,
      });
      if (
        !completion.accepted
        || !workspaceSemanticIndexBuildIsCurrent(completion.snapshot, buildToken)
      ) {
        setStatusMessage("Rename result became stale because the workspace changed; run Rename again");
        return;
      }
      await applyLspWorkspaceEdit(renamed.edit, {
        preview: true,
        label: "Rename symbol",
        semanticGeneration: buildToken.generation,
        semanticRevision: buildToken.revision,
        semanticWorkspaceOnly: true,
      });
    } catch (err) {
      semanticIndex.failBuild(buildToken, errorMessage(err));
      setStatusMessage(errorMessage(err));
    }
  }, [
    activeFile,
    applyLspWorkspaceEdit,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.abandonBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
  ]);
  renameSymbolRef.current = renameSymbolAtCursor;

  const safeDeleteSymbolAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a read-only library source`);
      return;
    }
    const caps = lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && (!caps.references || !caps.rename)) {
      setStatusMessage("Safe Delete requires references and rename support from the language server");
      return;
    }
    const expectedRevision = semanticIndex.current().revision;
    const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) {
      referencesRequestSequenceRef.current += 1;
      setStatusMessage("Safe Delete requires the language server to finish synchronizing current editor buffers");
      return;
    }
    const descriptor = lspDescriptorForFile(live);
    if (!descriptor) return;
    const position = editorSelectionRef.current.start;
    referencesRequestSequenceRef.current += 1;
    const referencesRequestId = referencesRequestSequenceRef.current;
    setBottomDockOpen(true);
    setBottomDockTab("references");
    setReferencesResult({
      loading: true,
      origin: `Safe Delete · ${live.subtitle}`,
      locations: [],
      error: null,
      semanticGeneration: null,
      semanticRevision: null,
    });
    const buildToken = semanticIndex.beginBuild("language-server");
    try {
      const prepared = await lspPrepareRename(descriptor, position);
      updateLspStatusForFile(live, prepared.status);
      if (!prepared.range) {
        semanticIndex.abandonBuild(buildToken);
        if (referencesRequestSequenceRef.current === referencesRequestId) {
          setReferencesResult({
            loading: false,
            origin: `Safe Delete · ${live.subtitle}`,
            locations: [],
            error: prepared.message ?? "Cannot determine a safe symbol range here",
            semanticGeneration: null,
            semanticRevision: null,
          });
        }
        setStatusMessage(prepared.message ?? "Cannot determine a safe symbol range here");
        return;
      }
      const [references, definition] = await Promise.all([
        lspReferences(descriptor, position, true),
        lspDefinition(descriptor, position).catch(() => null),
      ]);
      updateLspStatusForFile(live, references.status);
      if (definition) updateLspStatusForFile(live, definition.status);
      const completion = semanticIndex.finishQuery(buildToken, {
        kind: "safe-delete",
        resultCount: references.locations.length,
      });
      if (completion.accepted && referencesRequestSequenceRef.current === referencesRequestId) {
        setReferencesResult({
          loading: false,
          origin: `Safe Delete · ${live.subtitle}`,
          locations: references.locations,
          error: null,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
        });
      }
      if (
        !completion.accepted
        || !workspaceSemanticIndexBuildIsCurrent(completion.snapshot, buildToken)
      ) {
        if (referencesRequestSequenceRef.current === referencesRequestId) {
          setReferencesResult({
            loading: false,
            origin: `Safe Delete · ${live.subtitle}`,
            locations: [],
            error: "Safe Delete references became stale because the workspace changed",
            semanticGeneration: null,
            semanticRevision: null,
          });
        }
        setStatusMessage("Safe Delete references became stale because the workspace changed; run Safe Delete again");
        return;
      }

      const currentPath = absolutePathForOpenFile(live);
      if (!currentPath) {
        setStatusMessage("Safe Delete cannot resolve the active file path");
        return;
      }
      const declarationLocation = definition?.locations.find((location) => location.path) ?? null;
      const declaration = declarationLocation?.path
        ? {
          uri: declarationLocation.uri,
          path: declarationLocation.path,
          range: declarationLocation.range,
        }
        : {
          uri: "",
          path: currentPath,
          range: prepared.range,
        };
      const deletion = buildSafeDeleteWorkspaceEdit(declaration, references.locations, {
        workspaceRoots: rootsRef.current.map((root) => root.path),
      });
      if (!deletion.complete) {
        const reason = deletion.diagnostics.join("; ") || "Safe Delete references are incomplete";
        if (referencesRequestSequenceRef.current === referencesRequestId) {
          setReferencesResult((current) => ({
            ...current,
            loading: false,
            error: reason,
          }));
        }
        setStatusMessage(`Safe Delete blocked: ${reason}`);
        return;
      }
      const line = live.text.split("\n")[prepared.range.start.line] ?? "";
      const symbol = prepared.range.start.line === prepared.range.end.line
        ? line.slice(prepared.range.start.character, prepared.range.end.character).trim()
        : "";
      const fileCount = safeDeleteFileCount(deletion.locations);
      const confirmed = await confirmAppDialog({
        title: "Safe Delete Symbol",
        message: [
          `Delete ${symbol ? `"${symbol}"` : "the selected symbol"} and ${deletion.usageCount} reference${deletion.usageCount === 1 ? "" : "s"}?`,
          `${deletion.locations.length} occurrence${deletion.locations.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"} will be changed.`,
          "The complete operation can be undone as one workspace edit.",
        ].join("\n"),
        confirmLabel: "Delete Symbol",
        danger: true,
      });
      if (!confirmed) {
        setStatusMessage("Safe Delete cancelled; references remain open for review");
        return;
      }
      await applyLspWorkspaceEdit(deletion.edit, {
        label: "Safe delete symbol",
        semanticGeneration: buildToken.generation,
        semanticRevision: buildToken.revision,
        semanticWorkspaceOnly: true,
      });
    } catch (error) {
      semanticIndex.failBuild(buildToken, errorMessage(error));
      if (referencesRequestSequenceRef.current === referencesRequestId) {
        setReferencesResult({
          loading: false,
          origin: `Safe Delete · ${live.subtitle}`,
          locations: [],
          error: errorMessage(error),
          semanticGeneration: null,
          semanticRevision: null,
        });
      }
      setStatusMessage(`Cannot safely delete symbol: ${errorMessage(error)}`);
    }
  }, [
    absolutePathForOpenFile,
    activeFile,
    applyLspWorkspaceEdit,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.abandonBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
  ]);
  safeDeleteSymbolRef.current = safeDeleteSymbolAtCursor;

  const findReferences = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      referencesRequestSequenceRef.current += 1;
      const requestId = referencesRequestSequenceRef.current;
      setBottomDockOpen(true);
      setBottomDockTab("references");
      setReferencesResult({
        loading: true,
        origin: file.subtitle,
        locations: [],
        error: null,
        semanticGeneration: null,
        semanticRevision: null,
      });
      const expectedRevision = semanticIndex.current().revision;
      const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
      if (!live) {
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: "References require the language server to finish synchronizing current editor buffers",
          semanticGeneration: null,
          semanticRevision: null,
        });
        return;
      }
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) {
        if (referencesRequestSequenceRef.current === requestId) {
          setReferencesResult({
            loading: false,
            origin: file.subtitle,
            locations: [],
            error: "No language server is available for references",
            semanticGeneration: null,
            semanticRevision: null,
          });
        }
        return;
      }
      const buildToken = semanticIndex.beginBuild("language-server");
      try {
        const result = await lspReferences(descriptor, position, true);
        updateLspStatusForFile(live, result.status);
        const completion = semanticIndex.finishQuery(buildToken, {
          kind: "references",
          resultCount: result.locations.length,
        });
        if (!completion.accepted) {
          if (referencesRequestSequenceRef.current === requestId) {
            setReferencesResult({
              loading: false,
              origin: live.subtitle,
              locations: [],
              error: "References result became stale because the workspace changed",
              semanticGeneration: null,
              semanticRevision: null,
            });
          }
          return;
        }
        if (referencesRequestSequenceRef.current !== requestId) return;
        setReferencesResult({
          loading: false,
          origin: live.subtitle,
          locations: result.locations,
          error: null,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
        });
        setStatusMessage(`${result.locations.length} reference${result.locations.length === 1 ? "" : "s"} found`);
      } catch (err) {
        semanticIndex.failBuild(buildToken, errorMessage(err));
        if (referencesRequestSequenceRef.current !== requestId) return;
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: errorMessage(err),
          semanticGeneration: null,
          semanticRevision: null,
        });
      }
    },
    [
      ensureWorkspaceSemanticDocumentsSynced,
      lspDescriptorForFile,
      semanticIndex.beginBuild,
      semanticIndex.current,
      semanticIndex.failBuild,
      semanticIndex.finishQuery,
      setStatusMessage,
      updateLspStatusForFile,
    ],
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
          const field = fieldDeclarationAt(
            breadcrumbSymbolsRef.current[activeEditorGroupIdRef.current] ?? [],
            request.position,
          );
          return {
            canRunToCursor: session.state.status === "stopped",
            runToCursor: () => {
              const absolute = absolutePathForOpenFile(file);
              if (absolute) session.runToCursor(normalizeFsPath(absolute), request.position.line + 1);
            },
            ...(field ? {
              dataBreakpoint: {
                canAdd: session.state.status === "stopped"
                  && session.capabilities.supportsDataBreakpoints === true,
                add: () => {
                  const frameId = session.state?.selectedFrameId
                    ?? session.state?.frames[0]?.id
                    ?? undefined;
                  void session.addDataBreakpoint({ name: field.name, frameId }).then((result) => {
                    setStatusMessage(result.message);
                    if (result.added) {
                      setBottomDockTab("debug");
                      setBottomDockOpen(true);
                    }
                  });
                },
              },
            } : {}),
          };
        })(),
        ai: {
          explainSyntaxLabel: t("codeWorkspaceAi.contextExplainSyntax"),
          explainCodeLabel: t("codeWorkspaceAi.contextExplainCode"),
          explainSyntax: () => { void runEditorAiActionAtCursor("syntax"); },
          explainCode: () => { void runEditorAiActionAtCursor("explain"); },
          answerLanguage: {
            label: t("codeWorkspaceAi.answerLanguageMenu"),
            current: editorAiPreferencesRef.current.answerLanguage,
            options: AI_ANSWER_LANGUAGES.map((language) => ({
              value: language,
              label: t(answerLanguageLabelKey(language)),
            })),
            onSelect: (value) => setAiAnswerLanguage(value as AiAnswerLanguage),
          },
        },
        actions: {
          goToDefinition: () => { void goToDefinition(file, request.position); },
          goToTypeDefinition: () => { void goToTypeDefinition(file, request.position); },
          goToImplementation: () => { void goToImplementation(file, request.position); },
          findReferences: () => { void findReferences(file, request.position); },
          callHierarchy: () => { void openHierarchy("call"); },
          typeHierarchy: () => { void openHierarchy("type"); },
          rename: () => { void renameSymbolAtCursor(); },
          safeDelete: () => { void safeDeleteSymbolAtCursor(); },
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
    setBottomDockOpen,
    setBottomDockTab,
    findReferences,
    formatActiveFile,
    goToDefinition,
    goToImplementation,
    goToTypeDefinition,
    openEditorContextMenuAt,
    openHierarchy,
    openQuickDocumentation,
    renameSymbolAtCursor,
    safeDeleteSymbolAtCursor,
    setStatusMessage,
    runEditorAiActionAtCursor,
    showCodeActionsMenu,
    t,
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
        ? [{ key, title: file.title, subtitle: file.subtitle, path: inspectionPathForFileKey(key), diagnostics }]
        : [];
    }),
    [deferredOpenFiles, inspectionPathForFileKey, lspFiles, openOrder],
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
          path: inspectionPathForFileKey(entry.path),
          diagnostics: entry.diagnostics,
        };
      }));
    } catch {
      // No active jdtls session / command unsupported: leave the list as-is.
    }
  }, [findRoot, inspectionPathForFileKey, problemPathToRef, workspaceInstanceId]);

  // A pull-capable server may invalidate workspace diagnostics between polling
  // ticks. Refresh the aggregate immediately when the backend forwards the
  // standard `workspace/diagnostic/refresh` request.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<{ workspaceId?: unknown }>(LSP_DIAGNOSTICS_REFRESH_EVENT, (event) => {
      if (disposed || event.payload?.workspaceId !== workspaceInstanceId) return;
      void refreshProjectProblems();
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshProjectProblems, workspaceInstanceId]);

  // Poll project diagnostics while the Problems panel is open in project scope.
  useEffect(() => {
    if (!(bottomDockOpen
      && (bottomDockTab === "problems" || bottomDockTab === "analysis")
      && problemsScope === "project")) return;
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
  const analysisFiles = problemsScopeFiles;
  const createInspectionBaselineFromScope = useCallback(() => {
    const sources = problemsScopeFiles.flatMap((file) => file.diagnostics.map((diagnostic) => ({
      diagnostic,
      path: inspectionPathForFileKey(file.key),
    })));
    persistInspectionProfile((current) => replaceInspectionBaseline(current, sources));
    setStatusMessage(`Inspection baseline replaced with ${sources.length} provider diagnostic${sources.length === 1 ? "" : "s"}`);
  }, [inspectionPathForFileKey, persistInspectionProfile, problemsScopeFiles, setStatusMessage]);
  const activeProblemCounts = useMemo(
    () => problemsScopeFiles.reduce(
      (counts, file) => {
        for (const diagnostic of file.diagnostics) {
          const display = inspectionTransform(diagnostic, file.path ?? file.subtitle);
          if (display?.severity === 1) counts.errors += 1;
          else if (display?.severity === 2) counts.warnings += 1;
        }
        return counts;
      },
      { errors: 0, warnings: 0 },
    ),
    [inspectionTransform, problemsScopeFiles],
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

  const openRelatedDiagnostic = useCallback((diagnostic: LspDiagnostic) => {
    const location = diagnostic.relatedInformation?.[0]?.location;
    if (location) void openLspLocation(location);
  }, [openLspLocation]);

  // M8 E: Java test discovery + terminal run. Discovery targets the active .java
  // file; running builds a Maven/Gradle command and reuses the terminal runner.
  const activeFileIsJava = !!activeFile
    && !activeFile.library
    && activeFile.languagePath.toLowerCase().endsWith(".java");
  const [javaRunBusy, setJavaRunBusy] = useState(false);
  const [projectBuildBusy, setProjectBuildBusy] = useState(false);
  const [testResultsByRoot, setTestResultsByRoot] = useState<Record<string, StructuredTestResults>>({});
  const testResultsWorkspaceRef = useRef(workspaceInstanceId);
  testResultsWorkspaceRef.current = workspaceInstanceId;
  const [activeExecutionModel, setActiveExecutionModel] = useState<WorkspaceExecutionModel | null>(null);
  const [javaFallbackConfiguration, setJavaFallbackConfiguration] = useState<ExecutionRunConfiguration | null>(null);
  const [runConfigurationRevision, setRunConfigurationRevision] = useState(0);

  useEffect(() => {
    setTestResultsByRoot({});
  }, [workspaceInstanceId]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceInstanceId?: string }>).detail;
      if (detail?.workspaceInstanceId === workspaceInstanceId) {
        setRunConfigurationRevision((revision) => revision + 1);
      }
    };
    window.addEventListener(RUN_CONFIGURATION_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RUN_CONFIGURATION_CHANGED_EVENT, onChanged);
  }, [workspaceInstanceId]);

  useEffect(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || file.library) {
      setActiveExecutionModel(null);
      setJavaFallbackConfiguration(null);
      return;
    }
    const root = findRoot(file.ref.rootId);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !absolute) {
      setActiveExecutionModel(null);
      setJavaFallbackConfiguration(null);
      return;
    }
    let cancelled = false;
    setActiveExecutionModel(null);
    setJavaFallbackConfiguration(null);
    void workspaceExecutionModel(root.path, absolute, toolConfigRef.current)
      .then((model) => {
        if (cancelled) return;
        setActiveExecutionModel(model);
        if (activeFileIsJava) {
          void workspaceJavaRunTarget(root.path, file.ref.path, toolConfigRef.current)
            .then((target) => {
              if (!cancelled) setJavaFallbackConfiguration(javaRunTargetToExecutionRunConfiguration(target));
            })
            .catch(() => {
              if (!cancelled) setJavaFallbackConfiguration(null);
            });
        }
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`Run target discovery failed: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [absolutePathForOpenFile, activeFileIsJava, activeKey, findRoot, setStatusMessage, toolConfig]);

  const activeRunConfigurations = useMemo<ExecutionRunConfiguration[]>(() => {
    if (!activeExecutionModel || !activeFile || activeFile.ref.kind !== "root") return [];
    const absolute = absolutePathForOpenFile(activeFile);
    if (!absolute) return [];
    const normalized = normalizeFsPath(absolute);
    const activeRootId = activeFile.ref.kind === "root" ? activeFile.ref.rootId : null;
    const activeRoot = activeRootId ? roots.find((root) => root.id === activeRootId) : undefined;
    if (!activeRoot) return [];
    const projectRoots = new Map(
      activeExecutionModel.projects.map((project) => [project.id, normalizeFsPath(project.root)]),
    );
    const configurations = javaFallbackConfiguration
      ? [
          ...activeExecutionModel.runConfigurations.filter((configuration) => (
            configuration.configurationSource === "shared"
            || !configuration.sourceFile
            || !fsPathEquals(configuration.sourceFile, javaFallbackConfiguration.sourceFile ?? "")
          )),
          javaFallbackConfiguration,
        ]
      : activeExecutionModel.runConfigurations;
    const matches = configurations.filter((configuration) => {
      const sourceFile = configuration.sourceFile && normalizeFsPath(configuration.sourceFile);
      if (sourceFile) {
        return fsPathEquals(sourceFile, normalized)
          && relativePathWithinRoot(activeRoot.path, sourceFile) !== null;
      }
      const projectRoot = projectRoots.get(configuration.projectId);
      // A project-level configuration belongs to the active file only when its
      // project is rooted below the active workspace root. This keeps multiple
      // workspace roots and nested Maven/Gradle modules isolated.
      return !!projectRoot
        && relativePathWithinRoot(activeRoot.path, projectRoot) !== null
        && relativePathWithinRoot(projectRoot, normalized) !== null;
    });
    return materializeRunConfigurations(
      matches,
      readRunConfigurationOverrides(workspaceInstanceId, activeRoot.id),
    );
  }, [absolutePathForOpenFile, activeExecutionModel, activeFile, javaFallbackConfiguration, roots, runConfigurationRevision, workspaceInstanceId]);

  const activeRunConfiguration = useMemo<ExecutionRunConfiguration | null>(() => {
    const candidates = activeRunConfigurations.filter((configuration) => configuration.kind !== "module");
    if (candidates.length === 0) return null;
    const selectedId = activeFile
      ? readActiveRunConfigurationSelection(workspaceInstanceId, absolutePathForOpenFile(activeFile) ?? "")
      : null;
    return candidates.find((configuration) => configuration.id === selectedId) ?? candidates[0];
  }, [absolutePathForOpenFile, activeFile, activeRunConfigurations, runConfigurationRevision, workspaceInstanceId]);

  const activeDebugConfiguration = useMemo<ExecutionDebugConfiguration | null>(() => {
    const id = activeRunConfiguration?.debugConfigurationId;
    if (!id || !activeExecutionModel) return null;
    const detected = activeExecutionModel.debugConfigurations.find((configuration) => configuration.id === id) ?? null;
    if (!detected) return null;
    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
    const override = readRunConfigurationOverrides(workspaceInstanceId, rootId)[activeRunConfiguration.id];
    return applyRunOverrideToDebugConfiguration(
      detected,
      override,
      activeRunConfiguration.runtimeOptions,
      activeRunConfiguration.envFile,
    );
  }, [activeExecutionModel, activeFile, activeRunConfiguration, runConfigurationRevision, workspaceInstanceId]);

  const activeDebugConfigurationCatalog = useMemo<ExecutionDebugConfiguration[]>(() => {
    if (!activeExecutionModel || !activeFile || activeFile.ref.kind !== "root") return [];
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, activeFile.ref.rootId);
    const runByDebugId = new Map<string, ExecutionRunConfiguration>();
    for (const run of activeRunConfigurations) {
      if (run.debugConfigurationId && !runByDebugId.has(run.debugConfigurationId)) {
        runByDebugId.set(run.debugConfigurationId, run);
      }
    }
    return activeExecutionModel.debugConfigurations.map((configuration) => {
      const run = runByDebugId.get(configuration.id);
      const override = run
        ? overrides[run.id] ?? (run.baseConfigurationId ? overrides[run.baseConfigurationId] : undefined)
        : undefined;
      return applyRunOverrideToDebugConfiguration(
        configuration,
        override,
        run?.runtimeOptions,
        run?.envFile,
      );
    });
  }, [activeExecutionModel, activeFile, activeRunConfigurations, runConfigurationRevision, workspaceInstanceId]);

  const activeRunConfigurationOverride = useMemo(() => {
    if (!activeRunConfiguration) return undefined;
    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, rootId);
    return overrides[activeRunConfiguration.id]
      ?? (activeRunConfiguration.baseConfigurationId
        ? overrides[activeRunConfiguration.baseConfigurationId]
        : undefined);
  }, [activeFile, activeRunConfiguration, runConfigurationRevision, workspaceInstanceId]);

  const launchWorkspaceTask = useCallback((task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => {
    if (runPanelRef.current) {
      runPanelRef.current.run(task, onExit);
    } else {
      runWorkspaceTask(task, onExit);
    }
  }, [runWorkspaceTask]);

  const runTaskAndWait = useCallback(async (task: WorkspaceTaskItem): Promise<void> => {
    const result = await executeTaskPlan([task], (next, onExit) => launchWorkspaceTask(next, onExit));
    if (result.exitCode !== 0) {
      throw new Error(`${result.failed?.label ?? task.label} exited with ${result.exitCode}`);
    }
  }, [launchWorkspaceTask]);

  const taskForRunConfiguration = useCallback((
    configuration: ExecutionRunConfiguration,
    root: CodeWorkspaceRootInfo,
    source: string,
  ): WorkspaceTaskItem => {
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, root.id);
    return {
      id: configuration.id,
      label: configuration.label,
      command: configuration.command.display,
      cwd: configuration.command.cwd,
      source,
      rootId: root.id,
      rootName: root.name,
      configuration: true,
      runConfiguration: configuration,
      execution: {
        executable: configuration.command.executable,
        args: configuration.command.args,
        source: configuration.command.source,
        error: configuration.command.error,
      },
      environment: Object.fromEntries(Object.entries(configuration.command.env).map(([name, value]) => [
        name,
        { value, mode: configuration.environmentModes?.[name] ?? "replace" },
      ])),
      dependsOn: configuration.preLaunchTargets,
      buildTargets: activeExecutionModel?.buildTargets,
      configurationCatalog: activeExecutionModel
        ? materializeRunConfigurations(activeExecutionModel.runConfigurations, overrides)
        : undefined,
    };
  }, [activeExecutionModel, runConfigurationRevision, workspaceInstanceId]);

  const executeBeforeLaunch = useCallback(async (
    targetIds: readonly string[],
    targets: readonly ExecutionBuildTarget[],
    root: CodeWorkspaceRootInfo,
  ): Promise<void> => {
    if (targetIds.length === 0) return;
    const plan = resolveBuildTargetPlan(targetIds, targets);
    const tasks = plan.map((target): WorkspaceTaskItem => ({
      id: target.id,
      label: target.label,
      command: target.command.display,
      cwd: target.command.cwd,
      source: "Before launch",
      rootId: root.id,
      rootName: root.name,
      execution: {
        executable: target.command.executable,
        args: target.command.args,
        source: target.command.source,
        error: target.command.error,
      },
      environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
        name,
        { value, mode: "replace" as const },
      ])),
    }));
    const result = await executeTaskPlan(tasks, (task, onExit) => runWorkspaceTask(task, onExit));
    if (result.exitCode !== 0) {
      throw new Error(`Before launch failed: ${result.failed?.label ?? "build target"} exited with ${result.exitCode}`);
    }
  }, [runWorkspaceTask]);

  const readEnvironmentFile = useCallback(async (
    cwd: string,
    envFile: string | undefined,
  ): Promise<Record<string, string>> => {
    if (!envFile?.trim()) return {};
    const path = resolveEnvironmentFilePath(cwd, envFile);
    const file = await workspaceReadLooseFile(path, 1024 * 1024);
    return parseDotEnv(file.text);
  }, []);

  /** Compatibility fallback for a Java source file without a structured provider configuration. */
  const runActiveJavaFile = useCallback(() => {
    if (javaRunBusy) return;
    void (async () => {
      const file = openFilesRef.current[activeKey ?? ""];
      if (!file || file.ref.kind !== "root" || file.library) return;
      const root = findRoot(file.ref.rootId);
      if (!root) return;
      setJavaRunBusy(true);
      try {
        // Java launch discovery intentionally reads the on-disk source so a
        // dirty new main method must be persisted before resolving it.
        if (file.dirty) {
          await saveOpenBufferText(file.key, file.text);
        }
        const detected = javaRunTargetToExecutionRunConfiguration(
          await workspaceJavaRunTarget(root.path, file.ref.path, toolConfigRef.current),
        );
        const override = readRunConfigurationOverrides(workspaceInstanceId, root.id)[detected.id];
        const configuration = applyRunConfigurationOverride(detected, override);
        const task = taskForRunConfiguration(configuration, root, "Java · compatibility");
        await runTaskAndWait(task);
        setStatusMessage(`Running ${configuration.label}`);
      } catch (error) {
        setStatusMessage(errorMessage(error));
        setBottomDockTab("run");
        setBottomDockOpen(true);
      } finally {
        setJavaRunBusy(false);
      }
    })();
  }, [
    activeKey,
    findRoot,
    javaRunBusy,
    runTaskAndWait,
    saveOpenBufferText,
    taskForRunConfiguration,
    workspaceInstanceId,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  const runActiveTarget = useCallback(() => {
    if (activeRunConfiguration?.kind === "debug-only" || activeRunConfiguration?.command.error) {
      setStatusMessage(
        activeRunConfiguration.command.error
          ?? `${activeRunConfiguration.label} cannot be started with Run`,
      );
      return;
    }
    if (activeFileIsJava && !activeRunConfiguration) {
      runActiveJavaFile();
      return;
    }
    if (javaRunBusy || !activeRunConfiguration) return;
    void (async () => {
      const file = openFilesRef.current[activeKey ?? ""];
      if (!file || file.ref.kind !== "root" || file.library) return;
      const root = findRoot(file.ref.rootId);
      if (!root) return;
      setJavaRunBusy(true);
      try {
        if (file.dirty) await saveOpenBufferText(file.key, file.text);
        const project = activeExecutionModel?.projects.find((item) => item.id === activeRunConfiguration.projectId);
        await runTaskAndWait(taskForRunConfiguration(
          activeRunConfiguration,
          root,
          project ? `${project.languages.join("/")} · ${project.provider}` : "Run configuration",
        ));
        setStatusMessage(`Running ${activeRunConfiguration.label}`);
      } catch (error) {
        setStatusMessage(errorMessage(error));
        setBottomDockTab("run");
        setBottomDockOpen(true);
      } finally {
        setJavaRunBusy(false);
      }
    })();
  }, [
    activeExecutionModel,
    activeFileIsJava,
    activeKey,
    activeRunConfiguration,
    findRoot,
    javaRunBusy,
    runActiveJavaFile,
    runTaskAndWait,
    taskForRunConfiguration,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  /** IDEA-style Ctrl+F9: compile the active root using its real build tool. */
  const buildActiveProject = useCallback(async (rebuild = false) => {
    if (projectBuildBusy) return;
    const file = openFilesRef.current[activeKey ?? ""];
    const root = file?.ref.kind === "root"
      ? findRoot(file.ref.rootId)
      : rootsRef.current[0] ?? null;
    if (!root) return;
    setProjectBuildBusy(true);
    try {
      const absolute = file ? absolutePathForOpenFile(file) : undefined;
      const executionModel = await workspaceExecutionModel(root.path, absolute ?? undefined, toolConfigRef.current);
      const normalizedActive = absolute ? normalizeFsPath(absolute) : null;
      const project = executionModel.projects
        .filter((candidate) => !normalizedActive
          || relativePathWithinRoot(candidate.root, normalizedActive) !== null)
        .sort((left, right) => right.root.length - left.root.length)[0];
      const buildTarget = project
        ? executionModel.buildTargets.find((target) => target.projectId === project.id && target.kind === "build")
        : null;
      const cleanTarget = project
        ? executionModel.buildTargets.find((target) => target.projectId === project.id && target.kind === "clean")
        : null;
      if (buildTarget && (!rebuild || cleanTarget)) {
        const toTask = (target: ExecutionBuildTarget): WorkspaceTaskItem => ({
          id: target.id,
          label: target.label,
          command: target.command.display,
          cwd: target.command.cwd,
          source: project ? `${project.languages.join("/")} · ${project.provider}` : "Build target",
          rootId: root.id,
          rootName: root.name,
          execution: {
            executable: target.command.executable,
            args: target.command.args,
            source: target.command.source,
            error: target.command.error,
          },
          environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
            name,
            { value, mode: "replace" as const },
          ])),
          dependsOn: target.dependsOn,
        });
        const requestedIds = rebuild && cleanTarget
          ? [cleanTarget.id, buildTarget.id]
          : [buildTarget.id];
        const plan = resolveBuildTargetPlan(requestedIds, executionModel.buildTargets)
          .map(toTask);
        const result = await executeTaskPlan(plan, (task, onExit) => launchWorkspaceTask(task, onExit));
        if (result.exitCode !== 0) {
          throw new Error(`Build stopped at ${result.failed?.label ?? "a prerequisite"} (exit ${result.exitCode})`);
        }
        setStatusMessage(`${rebuild ? "Rebuilt" : "Built"} ${project?.module ?? root.name}`);
        return;
      }
      const groups = await workspaceTaskTree(root.path, toolConfigRef.current);
      const preferred = rebuild
        ? [["Maven", "rebuild"], ["Gradle", "rebuild"], ["Cargo.toml", "rebuild"]]
        : [
            ["Maven", "compile"],
            ["Gradle", "classes"],
            ["Gradle", "build"],
            ["Cargo.toml", "build"],
            ["package.json", "build"],
            ["Makefile", "build"],
          ];
      let selected: WorkspaceTaskItem | null = null;
      for (const [source, label] of preferred) {
        const task = groups
          .find((group) => group.source === source)
          ?.tasks.find((candidate) => candidate.label === label);
        if (task) {
          selected = { ...task, rootId: root.id, rootName: root.name };
          break;
        }
      }
      if (!selected) {
        setStatusMessage(rebuild
          ? "No rebuild task was detected for this project"
          : "No build task was detected for this project");
        setBottomDockTab("build");
        setBottomDockOpen(true);
        return;
      }
      await runTaskAndWait(selected);
      setStatusMessage(`${rebuild ? "Rebuilt" : "Built"} ${root.name}`);
    } catch (error) {
      setStatusMessage(errorMessage(error));
      setBottomDockTab("build");
      setBottomDockOpen(true);
    } finally {
      setProjectBuildBusy(false);
    }
  }, [
    activeKey,
    absolutePathForOpenFile,
    findRoot,
    launchWorkspaceTask,
    projectBuildBusy,
    runTaskAndWait,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  /** IDEA-style Ctrl+Shift+F9: Recompile active file (save if dirty, then compile target). */
  const recompileActiveFile = useCallback(async () => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.library) return;
    if (file.dirty) {
      await saveFile();
    }
    await buildActiveProject(false);
  }, [activeKey, saveFile, buildActiveProject]);

  runActiveJavaFileRef.current = runActiveTarget;
  buildActiveProjectRef.current = buildActiveProject;
  recompileActiveFileRef.current = recompileActiveFile;
  const [javaTestBuildTool, setJavaTestBuildTool] = useState<JavaTestBuildTool | null>(null);
  const [javaTestCommand, setJavaTestCommand] = useState<string | null>(null);

  const discoverActiveJavaTests = useCallback(async () => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file) return [];
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    return javaTestDiscover(descriptor);
  }, [activeKey, lspDescriptorForFile]);

  const loadTestResultsForRoot = useCallback(async (
    root: CodeWorkspaceRootInfo,
    notBeforeMs?: number,
  ): Promise<StructuredTestResults> => {
    const results = await workspaceTestResults(root.path, notBeforeMs);
    const currentRoot = findRoot(root.id);
    if (
      mountedRef.current
      && testResultsWorkspaceRef.current === workspaceInstanceId
      && currentRoot?.path === root.path
    ) {
      setTestResultsByRoot((current) => ({ ...current, [root.id]: results }));
    }
    return results;
  }, [findRoot, mountedRef, workspaceInstanceId]);

  const loadActiveJavaTestResults = useCallback(async (): Promise<StructuredTestResults | null> => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return null;
    const root = findRoot(file.ref.rootId);
    return root ? loadTestResultsForRoot(root) : null;
  }, [activeKey, findRoot, loadTestResultsForRoot]);

  // Detect the active file's build tool (Maven/Gradle) for the run command; only
  // while the Tests tab is open for a Java file. Cached per detection.
  useEffect(() => {
    if (!(bottomDockOpen && bottomDockTab === "tests" && activeFileIsJava && activeFile)) return;
    if (activeFile.ref.kind !== "root") {
      setJavaTestBuildTool(null);
      setJavaTestCommand(null);
      return;
    }
    const root = findRoot(activeFile.ref.rootId);
    if (!root) return;
    let cancelled = false;
    void workspaceTaskTree(root.path, toolConfigRef.current)
      .then((groups) => {
        if (cancelled) return;
        const mavenTask = groups
          .find((group) => group.source === "Maven")
          ?.tasks.find((task) => task.label === "test");
        const gradleTask = groups
          .find((group) => group.source === "Gradle")
          ?.tasks.find((task) => task.label === "test");
        const task = mavenTask ?? gradleTask;
        setJavaTestBuildTool(mavenTask ? "maven" : gradleTask ? "gradle" : null);
        setJavaTestCommand(task?.command ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setJavaTestBuildTool(null);
          setJavaTestCommand(null);
        }
      });
    return () => { cancelled = true; };
  }, [activeFile, activeFileIsJava, bottomDockOpen, bottomDockTab, findRoot]);

  const runJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || !javaTestBuildTool || !javaTestCommand) return;
    const root = findRoot(file.ref.rootId);
    if (!root) return;
    const command = javaTestRunCommand(javaTestBuildTool, item, javaTestCommand);
    const startedAt = Date.now();
    runWorkspaceTask({
      id: `java-test:${item.fullName}`,
      label: `Test ${item.name}`,
      command,
      cwd: root.path,
      source: "Test",
      rootId: root.id,
      rootName: root.name,
    }, (exitCode) => {
      // The terminal exit code is only execution status; the JUnit report is
      // the durable test protocol and remains authoritative for individual
      // cases, skips, errors, and stack traces.
      // Filesystems with coarse timestamp resolution can report a freshly
      // written XML file a few milliseconds before the PTY start marker.
      void loadTestResultsForRoot(root, Math.max(0, startedAt - 2000)).catch((error) => {
        if (testResultsWorkspaceRef.current !== workspaceInstanceId) return;
        setStatusMessage(`Test results unavailable after exit ${exitCode}: ${errorMessage(error)}`);
      });
    });
  }, [
    activeKey,
    findRoot,
    javaTestBuildTool,
    javaTestCommand,
    loadTestResultsForRoot,
    runWorkspaceTask,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const rerunStructuredTest = useCallback((result: StructuredTestResult) => {
    runJavaTest({
      name: result.name,
      fullName: result.selector,
      kind: result.selector.includes("#") ? "method" : "class",
      uri: null,
      range: null,
      children: [],
    });
  }, [runJavaTest]);

  const openStructuredTestFailure = useCallback((result: StructuredTestResult) => {
    if (!result.filePath || result.line == null) {
      setStatusMessage("This test result has no source location");
      return;
    }
    const file = openFilesRef.current[activeKey ?? ""];
    const root = file?.ref.kind === "root" ? findRoot(file.ref.rootId) : null;
    if (!root) {
      setStatusMessage("Cannot locate the test result outside an active workspace root");
      return;
    }
    const rawPath = normalizeFsPath(result.filePath);
    const relativePath = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)
      ? null
      : rawPath.replace(/^\/+/, "");
    if (relativePath?.split("/").some((segment) => segment === "..")) {
      setStatusMessage(`Test source is outside the workspace: ${result.filePath}`);
      return;
    }
    const absolute = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)
      ? rawPath
      : absoluteWorkspacePath(root, rawPath);
    const ref = problemPathToRef(absolute);
    if (!ref) {
      setStatusMessage(`Test source is outside the workspace: ${result.filePath}`);
      return;
    }
    const range: LspRange = {
      start: { line: Math.max(0, result.line - 1), character: 0 },
      end: { line: Math.max(0, result.line - 1), character: 0 },
    };
    void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
  }, [activeKey, findRoot, openFile, problemPathToRef, revealEditorLocation, setStatusMessage]);

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
        setBottomDockTab("debug");
        setBottomDockOpen(true);
        // Make-before-launch: save + build + block on compile errors.
        if (!(await prepareJavaLaunchRef.current(root.id, descriptor))) return;
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
          serverCommandId: descriptor.serverCommandId ?? null,
          customServerCommand: descriptor.customServerCommand ?? null,
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
  // Ref so callbacks declared above the hook (debug-test, commands) can reach it.
  debugRef.current = debug;
  // Ref so debug-test (declared above prepareJavaLaunch) can reach the pre-launch
  // save+build gate without a forward reference.
  const prepareJavaLaunchRef = useRef<
    (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>
  >(() => Promise.resolve(true));
  /** Breakpoint whose editor is open in the Debug panel's breakpoints view. */
  const [editingBreakpoint, setEditingBreakpoint] = useState<{ path: string; line: number } | null>(null);
  const activeFileAbsPath = activeFile ? absolutePathForOpenFile(activeFile) : null;
  const debugSessionActive = !!debug.state && debug.state.status !== "terminated";
  const activeDebugBreakpoints = useMemo<DebugBreakpointMarker[]>(() => {
    if (!activeFileAbsPath) return [];
    const key = normalizeFsPath(activeFileAbsPath);
    const list = debug.breakpoints[key] ?? debug.breakpoints[activeFileAbsPath] ?? [];
    const runtime = debug.breakpointRuntime[key] ?? debug.breakpointRuntime[activeFileAbsPath] ?? {};
    const muted = debug.breakpointsMuted;
    return list.map((bp) => {
      const enabled = bp.enabled !== false && !muted;
      const state = runtime[bp.line];
      // Design-time (no session) shows solid. In-session: only a confirmed
      // `verified` binding is solid; pending/failed/not-yet-reported render as
      // "not bound" so a red dot never implies a breakpoint that cannot hit.
      const verified = !debugSessionActive || state?.status === "verified";
      return {
        line: bp.line,
        conditional: !!(bp.condition || bp.hitCondition),
        logpoint: !!bp.logMessage,
        enabled,
        verified,
      };
    });
  }, [activeFileAbsPath, debug.breakpoints, debug.breakpointRuntime, debug.breakpointsMuted, debugSessionActive]);
  const activeDebugCurrentLine = useMemo<number | null>(() => {
    const loc = debug.currentLocation;
    if (!loc || !activeFileAbsPath) return null;
    return fsPathEquals(loc.path, activeFileAbsPath) ? loc.line : null;
  }, [activeFileAbsPath, debug.currentLocation]);
  /** The editor is showing the stopped frame: inline values + hover apply here. */
  const debugStoppedHere = debug.state?.status === "stopped" && activeDebugCurrentLine != null;
  const activeDebugInlineValues = debugStoppedHere ? debug.frameVariables : undefined;
  const debugRunToCursorLine = useCallback((line: number) => {
    if (activeFileAbsPath) debug.runToCursor(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);
  const toggleActiveBreakpoint = useCallback((line: number) => {
    if (activeFileAbsPath) debug.toggleBreakpoint(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);

  /**
   * Right-click a breakpoint gutter (or Ctrl+Shift+F8): create the breakpoint if
   * needed and open the Debug panel's breakpoints view, where condition, hit
   * count and log message are edited in one place — IDEA's breakpoint dialog,
   * rather than a chain of modal prompts.
   */
  const editActiveBreakpoint = useCallback((line: number) => {
    if (!activeFileAbsPath) return;
    const key = normalizeFsPath(activeFileAbsPath);
    if (!(debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
      debug.toggleBreakpoint(key, line);
    }
    setEditingBreakpoint({ path: key, line });
    setBottomDockTab("debug");
    setBottomDockOpen(true);
  }, [activeFileAbsPath, debug, setBottomDockOpen, setBottomDockTab]);
  toggleActiveBreakpointRef.current = toggleActiveBreakpoint;
  editActiveBreakpointRef.current = editActiveBreakpoint;

  /**
   * Make-before-launch (Phase 3): save every dirty Java / build file in the
   * project, wait for the jdtls build barrier, then block the launch if the
   * project has compile errors — so the debuggee never runs stale bytecode and
   * source lines match the loaded classes. Returns true when it is safe to
   * launch. jdtls / build being unavailable is NOT a block here (the DAP path
   * surfaces those); only real compiler errors stop the launch.
   */
  const prepareJavaLaunch = useCallback(async (
    rootId: string,
    launchDescriptor?: LspDocumentDescriptor | null,
  ): Promise<boolean> => {
    const root = findRoot(rootId);
    if (!root) return true;
    // Save every dirty file in this root that jdtls builds from: .java sources
    // and Maven/Gradle build descriptors. saveOpenBufferText awaits didSave so
    // jdtls receives it before the build barrier below.
    const dirty = Object.values(openFilesRef.current).filter((f) =>
      f.ref.kind === "root"
      && f.ref.rootId === rootId
      && f.dirty
      && !f.library
      && (f.languagePath.toLowerCase().endsWith(".java") || isJavaBuildFile(f.languagePath)),
    );
    for (const f of dirty) {
      try {
        await saveOpenBufferText(f.key, f.text);
      } catch (err) {
        const message = `Cannot start debug: failed to save ${f.subtitle}: ${errorMessage(err)}`;
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return false;
      }
    }
    // Build barrier. Use the descriptor of the file being launched, NOT a
    // synthetic path at the root: the jdtls session key includes the SDK
    // resolver's `project_scope_path` (the nearest module walking up from the
    // file), so in a multi-module build a root-level path keys the aggregator
    // and misses the module session the launch itself uses — the build then
    // reports "no language server session is active" and gets skipped.
    // Incremental (full = false): jdtls autobuilds on save, so a clean rebuild
    // would add minutes to every debug start for no benefit.
    const descriptor = launchDescriptor
      ?? lspDescriptorForPath(root.path, "__taomni_debug_build__.java");
    debug.reportStartupProgress("Building project…");
    try {
      const status = await lspBuildWorkspace(descriptor, false);
      if (status === "failed") {
        // The build itself broke (not "compiled with errors" — that is the
        // diagnostics check below). Say so instead of launching stale bytecode.
        const message = "Cannot start debug: the project build failed";
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return false;
      }
    } catch (err) {
      // No jdtls session / build unsupported: don't block. The adapter's own
      // main-class / classpath resolution will report a clear error if needed.
      debug.reportStartupProgress(`Skipping pre-launch build: ${errorMessage(err)}`);
      return true;
    }
    if (!mountedRef.current) return false;
    // After the build, check project-wide diagnostics for compile errors.
    try {
      const files = await lspWorkspaceDiagnostics(workspaceInstanceId);
      const errorFiles = files.filter((entry) =>
        entry.diagnostics.some((d) => d.severity === 1),
      );
      if (errorFiles.length > 0) {
        const errorCount = errorFiles.reduce(
          (n, entry) => n + entry.diagnostics.filter((d) => d.severity === 1).length,
          0,
        );
        setStatusMessage(
          `Debug blocked: ${errorCount} compile error${errorCount === 1 ? "" : "s"} in ${errorFiles.length} file${errorFiles.length === 1 ? "" : "s"}. Fix them, then debug again.`,
        );
        setProblemsScope("project");
        setBottomDockTab("problems");
        setBottomDockOpen(true);
        return false;
      }
    } catch {
      // Diagnostics unavailable: proceed rather than block on an unknown state.
    }
    return true;
  }, [
    debug, findRoot, saveOpenBufferText, saveLspDocument, lspDescriptorForPath,
    setBottomDockOpen, setBottomDockTab, setProblemsScope, setStatusMessage,
    workspaceInstanceId,
  ]);
  prepareJavaLaunchRef.current = prepareJavaLaunch;

  /** Pending main-class choice when the active file resolves to several mains. */
  const [javaMainCandidates, setJavaMainCandidates] = useState<{
    candidates: JavaMainClassOption[];
    launch: Record<string, unknown>;
    override?: ReturnType<typeof readRunConfigurationOverrides>[string];
    environment: Record<string, string>;
    runtimeOptions: string[];
  } | null>(null);

  /** Interactive refactoring usages preview modal state. */
  const [refactoringPreviewModal, setRefactoringPreviewModal] = useState<{
    title: string;
    preview: WorkspaceEditPreview;
    originalEdit: LspWorkspaceEdit;
    resolve: (filtered: LspWorkspaceEdit | boolean) => void;
  } | null>(null);

  /** Start a Java debug session, optionally pinned to an explicit main class. */
  const launchJavaDebug = useCallback(
    (
      launch: Record<string, unknown>,
      main?: JavaMainClassOption,
      override = activeRunConfigurationOverride,
      environment: Record<string, string> = {},
      runtimeOptions: readonly string[] = activeRunConfiguration?.runtimeOptions ?? [],
    ) => {
      const config = main
        ? { ...launch, mainClass: main.mainClass, projectName: main.projectName }
        : launch;
      const configured = applyRunOverrideToJavaLaunch(config, override, environment, runtimeOptions);
      if (main) {
        // Resolving the classpath + asking java-debug for a port is another
        // multi-second server round trip: name the target so the panel is not
        // blank while it runs.
        debug.reportStartupProgress(`Launching ${main.mainClass}…`);
      }
      void debug.startDebug(configured).catch((err) => setStatusMessage(errorMessage(err)));
    },
    [activeRunConfiguration, activeRunConfigurationOverride, debug, setStatusMessage],
  );

  /** Build a Java launch config for the active file and start debugging. */
  const startDebugActiveFile = useCallback(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    if (!root) return;
    const absolute = absolutePathForOpenFile(file);
    if (!absolute) return;
    const descriptor = lspDescriptorForFile(file);
    const rootId = file.ref.rootId;
    const launch: Record<string, unknown> = {
      workspaceId: descriptor?.workspaceId ?? workspaceInstanceId,
      rootPath: root.path,
      filePath: absolute,
      cwd: root.path,
      // Bind the debug session to the same jdtls the editor uses (custom command).
      serverCommandId: descriptor?.serverCommandId ?? null,
      customServerCommand: descriptor?.customServerCommand ?? null,
    };
    setBottomDockTab("debug");
    setBottomDockOpen(true);
    // Show the session console from the first click: everything below (save,
    // build, main-class resolution) happens before an adapter exists and can
    // take tens of seconds on a cold project.
    debug.reportStartupProgress(`Starting debug for ${file.title}`);
    void (async () => {
      try {
        if (file.dirty) await saveOpenBufferText(file.key, file.text);
        await executeBeforeLaunch(
          activeRunConfiguration?.preLaunchTargets ?? [],
          activeExecutionModel?.buildTargets ?? [],
          root,
        );
      } catch (error) {
        const message = `Cannot start debug: ${errorMessage(error)}`;
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return;
      }
      // jdtls remains the Java-specific compiler/diagnostic barrier. When a
      // structured Before launch build already ran, do not compile twice.
      if (!(activeRunConfiguration?.preLaunchTargets.length)
        && !(await prepareJavaLaunch(rootId, descriptor))) return;
      // Resolve the runnable main up front: launch the active-file / sole main
      // directly, or prompt when several mains exist (never run an arbitrary one).
      debug.reportStartupProgress("Resolving main class…");
      let resolution: JavaMainClassResolution;
      try {
        resolution = await dapResolveJavaMainClasses(launch);
      } catch (err) {
        // Surface in the Debug panel (not just the status bar): a rejected
        // resolve is the common "no active jdtls session / no debug bundle"
        // failure, and the transient status message is easy to miss.
        const message = errorMessage(err);
        setStatusMessage(message);
        debug.reportStartupFailure(`Debug failed to start: ${message}`);
        return;
      }
      if (!mountedRef.current) return;
      if (resolution.kind === "none") {
        const message = "No runnable main class found in this Java project";
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return;
      }
      if (resolution.kind === "choose") {
        let dotenv: Record<string, string> = {};
        try {
          dotenv = await readEnvironmentFile(
            activeRunConfiguration?.command.cwd ?? root.path,
            activeRunConfiguration?.envFile,
          );
        } catch (error) {
          const message = `Cannot start debug: ${errorMessage(error)}`;
          setStatusMessage(message);
          debug.reportStartupFailure(message);
          return;
        }
        debug.reportStartupProgress("Waiting for a main class to be picked…");
        setJavaMainCandidates({
          candidates: resolution.candidates,
          launch,
          override: activeRunConfigurationOverride,
          environment: dotenv,
          runtimeOptions: [...(activeRunConfiguration?.runtimeOptions ?? [])],
        });
        return;
      }
      let dotenv: Record<string, string> = {};
      try {
        dotenv = await readEnvironmentFile(
          activeRunConfiguration?.command.cwd ?? root.path,
          activeRunConfiguration?.envFile,
        );
      } catch (error) {
        const message = `Cannot start debug: ${errorMessage(error)}`;
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return;
      }
      launchJavaDebug(
        launch,
        resolution.main,
        activeRunConfigurationOverride,
        dotenv,
        activeRunConfiguration?.runtimeOptions,
      );
    })();
  }, [
    activeExecutionModel,
    activeKey,
    activeRunConfiguration,
    activeRunConfigurationOverride,
    debug,
    executeBeforeLaunch,
    findRoot,
    lspDescriptorForFile,
    absolutePathForOpenFile,
    launchJavaDebug,
    prepareJavaLaunch,
    readEnvironmentFile,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const startDebugActiveTarget = useCallback(() => {
    // A Java source without a selected structured debug configuration uses the
    // compatibility jdtls launch path. Once a configuration supplies a debug
    // entry, honor its availability first so compound/debug-only entries cannot
    // silently fall through to the compatibility launcher.
    const canUseJavaCompatibilityDebug = activeFileIsJava
      && !activeRunConfiguration?.debugConfigurationId
      && activeRunConfiguration?.kind !== "debug-only";
    if (canUseJavaCompatibilityDebug && !activeDebugConfiguration) {
      startDebugActiveFile();
      return;
    }
    if (activeFileIsJava && !activeDebugConfiguration) {
      setStatusMessage("No available debug configuration is associated with the selected Run configuration");
      return;
    }
    const configuration = activeDebugConfiguration;
    if (!configuration?.available) {
      if (configuration?.diagnostic) setStatusMessage(configuration.diagnostic);
      return;
    }
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || file.library) return;
    const rootId = file.ref.rootId;
    setBottomDockTab("debug");
    setBottomDockOpen(true);
    debug.reportStartupProgress(`Starting ${configuration.label}`);
    void (async () => {
      try {
        if (file.dirty) await saveOpenBufferText(file.key, file.text);
        const root = findRoot(rootId);
        if (!root) throw new Error("Cannot resolve the active workspace root");
        const catalog = activeDebugConfigurationCatalog;
        const buildTargets = activeExecutionModel?.buildTargets ?? [];
        const resolveRoot = (candidate: ExecutionDebugConfiguration): CodeWorkspaceRootInfo => {
          const project = activeExecutionModel?.projects.find((item) => item.id === candidate.projectId);
          const projectRoot = project && roots.find((item) => (
            relativePathWithinRoot(item.path, project.root) !== null
          ));
          if (!projectRoot || projectRoot.id !== root.id) {
            throw new Error(`Compound Debug child belongs to another workspace root: ${candidate.label}`);
          }
          return projectRoot;
        };
        const nodes = validateCompoundExecutionGraph(
          configuration,
          catalog.filter((candidate) => candidate.id !== configuration.id),
        );
        const validated = new Map<string, ExecutionDebugConfiguration>();
        const collectReachable = (candidate: ExecutionDebugConfiguration) => {
          if (validated.has(candidate.id)) return;
          if (!candidate.available) {
            throw new Error(candidate.diagnostic || `Debug configuration is unavailable: ${candidate.label}`);
          }
          resolveRoot(candidate);
          resolveBuildTargetPlan(candidate.preLaunchTargets, buildTargets);
          validated.set(candidate.id, candidate);
          for (const childId of candidate.compoundConfigurationIds ?? []) {
            const child = nodes.get(childId);
            if (!child) throw new Error(`Compound Debug child is missing: ${childId}`);
            collectReachable(child);
          }
        };
        collectReachable(configuration);
        // Resolve every dotenv before any build or adapter process starts. A
        // malformed/missing later child must never leave a half-launched group.
        const launches = new Map<string, ExecutionDebugConfiguration>();
        await Promise.all(Array.from(validated.values()).map(async (candidate) => {
          if (candidate.compoundConfigurationIds !== undefined) return;
          const candidateRoot = resolveRoot(candidate);
          const cwdValue = candidate.launchConfig.adapterCwd;
          const cwd = typeof cwdValue === "string" && cwdValue.trim() ? cwdValue : candidateRoot.path;
          const dotenv = await readEnvironmentFile(cwd, candidate.envFile);
          launches.set(candidate.id, mergeDebugEnvironment(candidate, dotenv));
        }));
        const buildPlan = (candidate: ExecutionDebugConfiguration): DebugLaunchNode => {
          const childIds = candidate.compoundConfigurationIds;
          if (childIds === undefined) {
            const launch = launches.get(candidate.id);
            if (!launch) throw new Error(`Compound Debug launch was not resolved: ${candidate.label}`);
            return {
              id: launch.id,
              label: launch.label,
              adapterId: launch.adapterId,
              launchConfig: launch.launchConfig,
            };
          }
          return {
            id: candidate.id,
            label: candidate.label,
            parallel: candidate.compoundParallel,
            stopOnFailure: candidate.compoundStopOnFailure,
            children: childIds.map((childId) => {
              const child = validated.get(childId);
              if (!child) throw new Error(`Compound Debug child is missing: ${childId}`);
              return buildPlan(child);
            }),
          } satisfies DebugLaunchGroup;
        };
        // Before-launch tasks are completed for the validated graph before DAP
        // startup. Resolve the union once so shared dependencies execute once.
        await executeBeforeLaunch(
          Array.from(validated.values()).flatMap((candidate) => candidate.preLaunchTargets),
          buildTargets,
          root,
        );
        const plan = buildPlan(configuration);
        if ("children" in plan) await debug.startDebugGroup(plan);
        else await debug.startDebug(plan.launchConfig, plan.adapterId);
      } catch (error) {
        const message = `Debug failed to start: ${errorMessage(error)}`;
        setStatusMessage(message);
        debug.reportStartupFailure(message);
      }
    })();
  }, [
    activeDebugConfiguration,
    activeDebugConfigurationCatalog,
    activeExecutionModel,
    activeFileIsJava,
    activeKey,
    debug,
    executeBeforeLaunch,
    findRoot,
    readEnvironmentFile,
    roots,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    startDebugActiveFile,
  ]);

  /**
   * Attach to a JVM already running with `-agentlib:jdwp=...,server=y,address=…`
   * (IDEA's "Remote JVM Debug"). The active file still selects the jdtls session
   * so breakpoints resolve against this project's sources.
   */
  const attachRemoteDebug = useCallback(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !absolute) return;
    const descriptor = lspDescriptorForFile(file);
    void (async () => {
      const target = await promptAppDialog({
        title: "Attach to remote JVM",
        label: "Debug address — host:port, or just the port for localhost",
        initialValue: "localhost:5005",
      });
      if (target === null) return;
      const trimmed = target.trim();
      if (!trimmed) return;
      const [hostPart, portPart] = trimmed.includes(":")
        ? [trimmed.slice(0, trimmed.lastIndexOf(":")), trimmed.slice(trimmed.lastIndexOf(":") + 1)]
        : ["localhost", trimmed];
      const port = Number.parseInt(portPart, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        setStatusMessage(`Not a valid debug address: ${trimmed}`);
        return;
      }
      try {
        await debug.startDebug({
          workspaceId: descriptor?.workspaceId ?? workspaceInstanceId,
          rootPath: root.path,
          filePath: absolute,
          request: "attach",
          hostName: hostPart || "localhost",
          port,
          serverCommandId: descriptor?.serverCommandId ?? null,
          customServerCommand: descriptor?.customServerCommand ?? null,
        });
        setBottomDockTab("debug");
        setBottomDockOpen(true);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    })();
  }, [
    activeKey, debug, findRoot, lspDescriptorForFile, absolutePathForOpenFile,
    setBottomDockOpen, setBottomDockTab, setStatusMessage, workspaceInstanceId,
  ]);

  const openDebugFrame = useCallback((
    frame: Pick<DebugStackFrame, "path" | "line"> & Partial<Pick<DebugStackFrame, "sourceReference" | "sourceName" | "name">>,
  ) => {
    const range = { start: { line: frame.line - 1, character: 0 }, end: { line: frame.line - 1, character: 0 } };
    const ref = frame.path ? problemPathToRef(frame.path) : null;
    if (ref) {
      void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
      return;
    }
    // Outside the workspace (JDK / a dependency JAR): ask the adapter for the
    // attached or decompiled source and show it read-only, like IDEA does.
    const sourceReference = frame.sourceReference ?? 0;
    if (sourceReference <= 0) return;
    const origin = openFilesRef.current[activeKey ?? ""]
      ?? Object.values(openFilesRef.current).find((item) => !item.loading)
      ?? null;
    const descriptor = origin ? lspDescriptorForFile(origin) : null;
    if (!descriptor) return;
    void (async () => {
      const text = await debugRef.current.fetchSource(sourceReference);
      if (!text) {
        setStatusMessage("No source available for this frame");
        return;
      }
      const title = frame.sourceName ?? `${frame.name ?? "frame"}.java`;
      await openLibraryBuffer(
        {
          uri: `dap-source:${sourceReference}/${title}`,
          title,
          container: frame.name ?? null,
          languageId: "java",
          originRootPath: descriptor.rootPath ?? null,
          originFilePath: descriptor.filePath,
          decompiled: true,
        },
        text,
        range,
      );
    })();
  }, [
    activeKey, lspDescriptorForFile, openFile, openLibraryBuffer, problemPathToRef,
    revealEditorLocation, setStatusMessage,
  ]);

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

  // Real Java debugging drives the DAP kernel over Tauri IPC, which the browser
  // dev-preview stubs cannot provide (there is no JVM / java-debug adapter). Gate
  // the debug entry points on the desktop runtime so preview shows a clear reason
  // instead of crashing on an undefined `dap_start_session` result. Plain Java Run
  // uses the PTY and stays available, so it is deliberately not gated here.
  const debugRuntimeAvailable = isTauriRuntime();
  const activeFileJavaRoot = !!activeFileIsJava && !!activeFile && activeFile.ref.kind === "root";
  const activeFileRunnable = activeRunConfiguration
    ? activeRunConfiguration.kind !== "debug-only" && !activeRunConfiguration.command.error
    : activeFileJavaRoot && activeExecutionModel !== null;
  const activeFileDebuggable = debugRuntimeAvailable && (
    activeDebugConfiguration
      ? activeDebugConfiguration.available === true
      : activeFileJavaRoot
        && !activeRunConfiguration?.debugConfigurationId
        && activeRunConfiguration?.kind !== "debug-only"
  );

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
        const diagnostics = (lspFiles[file.key]?.diagnostics ?? []).flatMap((diagnostic) => {
          const display = inspectionTransform(diagnostic, inspectionPathForFileKey(file.key));
          return display ? [display] : [];
        });
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
    inspectionPathForFileKey,
    inspectionTransform,
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
    const groupPath = groupFile ? inspectionPathForFileKey(groupFile.key) : undefined;
    const groupDiagnostics = (groupLspState?.diagnostics ?? []).flatMap((diagnostic) => {
      const display = inspectionTransform(diagnostic, groupPath);
      return display ? [display] : [];
    });
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
        readOnly={workspaceResourceOperationLocked}
        softWrap={codeViewProfile.softWrap ?? false}
        columnSelectionMode={columnSelectionMode}
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
        activeDebugInlineValues={groupId === activeEditorGroupId ? activeDebugInlineValues : undefined}
        onToggleBreakpoint={groupId === activeEditorGroupId ? toggleActiveBreakpoint : undefined}
        onEditBreakpoint={groupId === activeEditorGroupId ? editActiveBreakpoint : undefined}
        debugStep={groupId === activeEditorGroupId && debugSessionActive ? debug.step : null}
        debugRunToCursor={groupId === activeEditorGroupId && debugSessionActive ? debugRunToCursorLine : null}
        debugStop={groupId === activeEditorGroupId && debugSessionActive ? debug.terminate : null}
        debugEvaluate={groupId === activeEditorGroupId && debugStoppedHere ? debug.hoverEvaluate : null}
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
        activeSymbols={breadcrumbSymbolsByGroup[groupId]}
        stickyLinesEnabled={intelligencePreferences.stickyLinesEnabled !== false}
        onRevealTargetLine={(line) => groupFile && setRevealTarget({ key: groupFile.key, line, character: 0, nonce: Date.now() })}
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
          label={codeViewProfile.softWrap ? "Disable soft wrap" : "Enable soft wrap"}
          testId="code-workspace-soft-wrap"
          active={codeViewProfile.softWrap}
          icon={<WrapText className="w-3.5 h-3.5" />}
          onClick={toggleSoftWrap}
        />
        <IconButton
          label={columnSelectionMode ? "Disable column selection mode" : "Enable column selection mode"}
          testId="code-workspace-column-selection"
          active={columnSelectionMode}
          icon={<Columns3 className="w-3.5 h-3.5" />}
          onClick={toggleColumnSelectionMode}
        />
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
          label="Build project (Ctrl+F9)"
          testId="code-workspace-build-project"
          icon={projectBuildBusy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Hammer className="w-3.5 h-3.5" />}
          disabled={roots.length === 0 || projectBuildBusy}
          onClick={() => buildActiveProject(false)}
        />
        <IconButton
          label={activeRunConfiguration ? `Run ${activeRunConfiguration.label} (Shift+F10)` : "Run current target (Shift+F10)"}
          testId="code-workspace-run-target"
          icon={javaRunBusy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Play className="w-3.5 h-3.5" />}
          disabled={!activeFileRunnable || javaRunBusy}
          onClick={runActiveTarget}
        />
        {activeRunConfigurations.length > 1 && activeFile && (() => {
          const sourceFile = absolutePathForOpenFile(activeFile);
          if (!sourceFile) return null;
          return (
            <select
              data-testid="code-workspace-active-run-configuration"
              aria-label="Active run configuration"
              title="Select active Run/Debug configuration"
              value={activeRunConfiguration?.id ?? ""}
              onChange={(event) => writeActiveRunConfigurationSelection(
                workspaceInstanceId,
                sourceFile,
                event.target.value || null,
              )}
              className="h-6 max-w-44 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            >
              {activeRunConfigurations.map((configuration) => (
                <option key={configuration.id} value={configuration.id}>{configuration.label}</option>
              ))}
            </select>
          );
        })()}
        <IconButton
          label={
            activeFileRunnable && !debugRuntimeAvailable
              ? "Debugging requires the desktop app (run: pnpm tauri dev)"
              : activeDebugConfiguration?.diagnostic ?? "Debug current target"
          }
          testId="code-workspace-debug-target"
          icon={<Bug className="w-3.5 h-3.5" />}
          disabled={!activeFileDebuggable || debugSessionActive}
          onClick={startDebugActiveTarget}
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
                onSuppress={suppressInspection}
                onAddToBaseline={addInspectionBaseline}
                scope={problemsScope}
                onScopeChange={setProblemsScope}
                onRebuild={() => void rebuildProject()}
                rebuilding={rebuildingProject}
                loading={problemsScope === "project" && projectProblemsLoading}
                diagnosticTransform={inspectionTransform}
                onOpenRelatedInformation={openRelatedDiagnostic}
              />
            ),
          },
          {
            id: "analysis",
            label: "Analysis",
            icon: <Activity className="h-3.5 w-3.5" />,
            badge: activeProblemCounts.errors + activeProblemCounts.warnings || undefined,
            content: (
              <AnalysisPanel
                files={analysisFiles}
                status={activeLspState?.status ?? null}
                semanticTokenCount={semanticTokensByGroup[activeEditorGroupId]?.length ?? 0}
                semanticIndex={semanticIndex.snapshot}
                profile={inspectionProfile}
                onUpdateRule={updateInspectionProfileRule}
                onCreateBaseline={createInspectionBaselineFromScope}
                onClearBaseline={clearInspectionBaselineEntries}
                onRemoveBaselineEntry={removeInspectionBaseline}
                onRemoveSuppression={removeInspectionSuppressionEntry}
                onExportBaseline={() => void exportInspectionBaseline()}
                onImportBaseline={() => void importInspectionBaselineFromClipboard()}
                onOpenLocation={(location) => void openLspLocation(location)}
                onOpenDiagnostic={openProblem}
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
                semanticIndex={semanticIndex.snapshot}
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
                toolConfig={toolConfig}
                onConfigureTools={() => setBuildRunToolsOpen(true)}
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
                onRunTask={(task, onExit) => runWorkspaceTask(task, onExit)}
                toolConfig={toolConfig}
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
                onRerun={rerunStructuredTest}
                onLoadResults={activeFile?.ref.kind === "root" ? loadActiveJavaTestResults : undefined}
                results={activeFile?.ref.kind === "root" ? testResultsByRoot[activeFile.ref.rootId] ?? null : null}
                onOpenFailure={openStructuredTestFailure}
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
                onStart={activeFileDebuggable ? startDebugActiveTarget : null}
                onAttach={activeFileJavaRoot && debugRuntimeAvailable ? attachRemoteDebug : null}
                onOpenFrame={openDebugFrame}
                onOpenBreakpoint={(path, line) => openDebugFrame({ path, line })}
                editingBreakpoint={editingBreakpoint}
                onEditingBreakpointChange={setEditingBreakpoint}
                runtimeAvailable={debugRuntimeAvailable}
                configurations={activeRunConfigurations
                  .filter((configuration) => configuration.kind !== "module")
                  .map((configuration) => {
                    const detectedDebug = configuration.debugConfigurationId
                      ? activeExecutionModel?.debugConfigurations.find((candidate) => (
                        candidate.id === configuration.debugConfigurationId
                      ))
                      : undefined;
                    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
                    const override = readRunConfigurationOverrides(workspaceInstanceId, rootId)[configuration.id];
                    const debugConfiguration = detectedDebug
                      ? applyRunOverrideToDebugConfiguration(
                          detectedDebug,
                          override,
                          configuration.runtimeOptions,
                          configuration.envFile,
                        )
                      : undefined;
                    const canUseJavaCompatibilityDebug = activeFileJavaRoot
                      && !configuration.debugConfigurationId
                      && configuration.kind !== "debug-only";
                    const available = debugRuntimeAvailable
                      && (debugConfiguration
                        ? debugConfiguration.available === true
                        : canUseJavaCompatibilityDebug);
                    const diagnostic = !debugRuntimeAvailable
                      ? "Debugging is available in the desktop app only"
                      : debugConfiguration?.diagnostic
                        ?? (!debugConfiguration && canUseJavaCompatibilityDebug
                          ? undefined
                          : "No available debug configuration is associated with this run target");
                    return {
                      id: configuration.id,
                      label: configuration.label,
                      source: configuration.configurationSource,
                      available,
                      diagnostic: available ? undefined : diagnostic,
                    };
                  })}
                activeConfigurationId={activeRunConfiguration?.id ?? null}
                onActiveConfigurationChange={(configurationId) => {
                  if (!activeFile) return;
                  const sourceFile = absolutePathForOpenFile(activeFile);
                  if (sourceFile) writeActiveRunConfigurationSelection(
                    workspaceInstanceId,
                    sourceFile,
                    configurationId,
                  );
                }}
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
        semanticIndex={semanticIndex.snapshot}
        fetchWorkspaceSymbols={fetchWorkspaceSymbols}
        onCloseSearchEverywhere={() => setSearchEverywhereOpen(false)}
        onOpenFileItem={openGoToFileItem}
        onOpenSymbol={(symbol, options) => void openWorkspaceSymbol(symbol, options)}
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
        recentChangedOnly={recentChangedOnly}
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
      {visible && lspMessageRequest && (
        <LspMessageRequestDialog
          request={lspMessageRequest}
          onSelect={resolveLspMessageRequest}
        />
      )}
      {visible && externalFileConflicts[0] && (
        <ExternalFileConflictDialog
          path={externalFileConflicts[0].path}
          baseText={externalFileConflicts[0].baseText}
          localText={externalFileConflicts[0].localText}
          diskText={externalFileConflicts[0].disk?.text ?? null}
          onKeepLocal={() => keepLocalExternalFileConflict(externalFileConflicts[0]!)}
          onLoadDisk={() => {
            void loadDiskExternalFileConflict(externalFileConflicts[0]!);
          }}
          onApplyMerge={(text) => mergeExternalFileConflict(externalFileConflicts[0]!, text)}
          onCancel={() => dismissExternalFileConflict(externalFileConflicts[0]!.key)}
        />
      )}
      {visible && workspaceRecoveryOpen && workspaceRecoveryEntries.length > 0 && externalFileConflicts.length === 0 && (
        <WorkspaceRecoveryDialog
          entries={workspaceRecoveryEntries}
          onRecover={(entry) => {
            void recoverWorkspaceEntry(entry);
          }}
          onDiscard={discardWorkspaceRecoveryEntry}
          onRecoverAll={recoverAllWorkspaceEntries}
          onDiscardAll={discardAllWorkspaceRecoveryEntries}
          onClose={() => setWorkspaceRecoveryOpen(false)}
        />
      )}
      {visible && fileEncodingDialogOpen && activeFile && !activeFile.library && (
        <FileEncodingDialog
          path={activeFile.path}
          currentEncoding={activeFile.encoding ?? "UTF-8"}
          currentBom={activeFile.bom ?? false}
          dirty={activeFile.dirty}
          onReload={(encoding) => reloadActiveFileWithEncoding(encoding)}
          onConvert={convertActiveFileEncoding}
          onClose={() => setFileEncodingDialogOpen(false)}
        />
      )}
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
        answerLanguage={editorAiPreferences.answerLanguage}
        onAction={(action, text) => {
          void handleEditorAiAction(action, text);
        }}
        onSetAnswerLanguage={setAiAnswerLanguage}
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
          onRegenerate={() => void regenerateAiRewrite()}
          onApply={() => {
            applySelectionReplacement(aiRewriteState.key, aiRewriteState.range, aiRewriteState.proposal);
            setAiRewriteState(null);
            setStatusMessage("Applied AI proposal to the selection");
          }}
        />
      )}
      {buildRunToolsOpen && (
        <WorkspaceBuildRunToolsDialog
          config={buildRunTools}
          onSave={(next) => {
            setBuildRunTools(writeWorkspaceBuildRunTools(workspaceInstanceId, next));
            setBuildRunToolsOpen(false);
            setStatusMessage("Saved build and run tool settings");
          }}
          onClose={() => setBuildRunToolsOpen(false)}
        />
      )}
      <JavaMainClassPicker
        open={!!javaMainCandidates}
        candidates={javaMainCandidates?.candidates ?? []}
        onClose={() => setJavaMainCandidates(null)}
        onPick={(main) => {
          const pending = javaMainCandidates;
          setJavaMainCandidates(null);
          if (pending) launchJavaDebug(
            pending.launch,
            main,
            pending.override,
            pending.environment,
            pending.runtimeOptions,
          );
        }}
      />
      {refactoringPreviewModal && (
        <RefactoringPreviewDialog
          open={true}
          title={refactoringPreviewModal.title}
          preview={refactoringPreviewModal.preview}
          originalEdit={refactoringPreviewModal.originalEdit}
          onConfirm={(filteredEdit) => {
            refactoringPreviewModal.resolve(filteredEdit);
            setRefactoringPreviewModal(null);
          }}
          onCancel={() => {
            refactoringPreviewModal.resolve(false);
            setRefactoringPreviewModal(null);
          }}
        />
      )}
    </div>
  );
}
