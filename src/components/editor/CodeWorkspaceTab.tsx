import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
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
  ShieldCheck,
  Link2,
  AlignHorizontalJustifyCenter,
  Maximize2,
  Square,
  SlidersHorizontal,
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
  type WorkspaceWriteAck,
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
  lspCancelReferenceRequest,
  lspHover,
  lspImplementation,
  lspInlayHints,
  lspJavaModules,
  javaTestDiscover,
  javaTestResolveLaunch,
  lspPrepareRename,
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
  nextLspRequestSequence,
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
  type LspWorkspaceEdit,
  type LspWorkspaceApplyEditRequest,
  type LspWorkspaceEditOperation,
  type LspExternalFileChange,
} from "../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { selectFilePath } from "../../lib/ipc";
import { loadCodeViewProfile } from "../../lib/codeViewProfile";
import { useAppStore } from "../../stores/appStore";
import {
  createEditorGroup,
  selectCodeWorkspaceUi,
  useCodeWorkspaceStore,
  type BottomDockTabId,
  type CodeWorkspaceEditorGroupState,
  type EditorGroupId,
  type EditorSplitOrientation,
  type RightPaneTabId,
} from "../../stores/codeWorkspaceStore";
import type { OpenFileEol } from "./workspace/editorGroupTypes";
import {
  useCodeWorkspaceStatusStore,
  type WorkspaceEol,
} from "../../stores/codeWorkspaceStatusStore";
import {
  type EffectiveCodeStyle,
  type ExplicitIndentationOverride,
  resolveEffectiveCodeStyle,
} from "./workspace/codeStyleModel";
import type { ResolvedCodeStyle } from "./workspace/editorConfigResolver";
import {
  createWorkspaceStyleController,
  type PreparedSaveCommitter,
  type SaveTransactionV2,
  type WorkspaceStyleController,
} from "./workspace/workspaceStyleController";
import type {
  CompletionAcceptanceDiagnostic,
  CompletionInvocationRequest,
  CompletionRequestIdentity,
  CompletionRequestToken,
} from "./workspace/lspCompletion";
import {
  buildPreparedSave,
  classifySaveWriteback,
  classifyUnknownDiskEffect,
  nextSaveTransactionId,
  resolveUnknownDiskResolution,
  resolveWritePolicy,
  saveCommitResultFromError,
  SaveTransactionRegistry,
  validatePreparedSaveBoundary,
  type DiskResolution,
  type PreparedSave,
  type SaveCommitResult,
} from "./workspace/saveCommit";
import {
  hasBlockingDiskEffectResolution,
  listDiskEffectLedgerEntries,
  recordDiskEffectLedgerEntry,
  resolveDiskEffectLedgerEntry,
  workspaceFileIdentity,
  type WorkspaceDiskEffectLedgerEntryV4,
} from "./workspace/workspaceRecovery";
import {
  applyWorkspaceTabPolicyTransaction,
  enforceTabPolicy,
  pushClosedTab,
  buildReopenTreeRoute,
  resolveReopenLocation,
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  type ClosedTabEntry,
  type WorkspaceTabPolicyV3,
} from "./workspace/workspaceTabPolicy";
import {
  listToolWindowsForCycle,
  syncBottomDockToolWindows,
  unregisterAllToolWindows,
} from "./workspace/toolWindowRegistry";
import { planReformat } from "./workspace/reformatWorkflow";
import { attachWorkspaceMouseDispatcher } from "./workspace/workspaceMouseDispatcher";
import {
  createWorkspaceLocationController,
  isPathContainedInRoot,
  NavigationHistoryFacade,
  workspacePathComparisonKey,
  type BackForwardHistoryBridge,
  type WorkspaceLocationController,
} from "./workspace/navigationHistoryModel";
import {
  WorkspaceSemanticQueryHost,
  type SemanticQueryIdentity,
  type SemanticQueryKind,
  type SemanticQueryLiveGuards,
} from "./workspace/workspaceSemanticQueryHost";
import {
  createSingleLeafLayout,
  findLeafNode,
  getAllLeafNodes,
  navigateLeafOrder,
  panelLayoutToRatios,
  cloneLayoutTree,
  type LayoutNode,
} from "./workspace/recursiveLayoutTree";
import {
  historyList,
  historyRead,
  historySnapshot,
  type LocalHistoryEntry,
} from "../../lib/localHistory";
import {
  defaultWorkspaceLayoutSnapshot,
  layoutSnapshotHasOpenFiles,
  readWorkspaceLayoutSnapshot,
  snapshotFromWorkspaceUi,
  uniqueOrderedKeys,
  writeWorkspaceLayoutSnapshot,
} from "./workspace/workspaceLayoutPersistence";
import { LocalHistoryDialog } from "./workspace/LocalHistoryDialog";
import { CodeStyleSettingsDialog } from "./workspace/CodeStyleSettingsDialog";
import { WorkspaceTabPolicySettingsDialog } from "./workspace/WorkspaceTabPolicySettingsDialog";
import { resolveEffectiveSavePolicy } from "./workspace/workspaceCodeStyleScheme";
import {
  BUILT_IN_SCHEME_ID,
  activeSchemeForLanguage,
  readCodeStyleSchemeStore,
  schemeStyleFields,
  writeCodeStyleSchemeStore,
  type CodeStyleSchemeStoreState,
} from "./workspace/workspaceCodeStyleSchemes";
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
import { readText, readTextResult, writeText } from "../../lib/clipboard";
import { useContextMenu } from "../ContextMenu";
import { useChatStore } from "../../stores/chatStore";
import {
  type EditorCommandId,
  type EditorCommandOptions,
  type EditorCommandPort,
  type EditorCommandPortRegistration,
  type EditorCommandState,
  type EditorCommandTarget,
  type EditorContextMenuRequest,
  type EditorSelectionRange,
} from "./workspace/CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "./workspace/workspaceDocumentTransactionOwner";
import { SurroundWithDialog } from "./workspace/SurroundWithDialog";
import { GenerateCodeDialog } from "./workspace/GenerateCodeDialog";
import {
  applyGenerateSelection,
  type GenerateCandidate,
} from "./workspace/generateCodeWorkflow";
import { filterGenerateCodeActions } from "./workspace/workspaceSemanticEditing";
import { copyReferenceCandidates } from "./workspace/workspaceCopyReference";
import { ClipboardHistoryPopup } from "./workspace/ClipboardHistoryPopup";
import { validateAndApplyOrganizeImportsPlan } from "./workspace/saveOrganizeImportsAdapter";
import {
  acquireClipboardStore,
  createDefaultClipboardPermissionAdapter,
  type EditorClipboardSession,
  WorkspaceClipboardSessionContext,
} from "./workspace/workspaceClipboardSession";
import { buildEditorContextMenuItems } from "./workspace/editorContextMenu";
import { fieldDeclarationAt } from "./workspace/dataBreakpointTarget";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { isTauriRuntime } from "../../lib/runtime";
import { useMountedRef } from "../../hooks/useMountedRef";
import { fallbackWordHighlights, wordAt } from "./workspace/lspIntelligenceChrome";
import {
  inlayHintsEnabledForLanguage,
  readWorkspaceIntelligencePreferences,
  writeWorkspaceIntelligencePreferences,
  type WorkspaceIntelligencePreferences,
} from "./workspace/intelligencePreferences";
import { WorkspaceLspSessionManager } from "./workspace/workspaceLspSessionManager";
import { applyLspTextEditsToString } from "./workspace/lspTextEdits";
import { isLargeFileContent } from "./workspace/largeFile";
import {
  applyWorkspaceEdit,
  buildWorkspaceEditApplyResultV2,
  sliceWorkspaceEditForResume,
  summarizeWorkspaceEditOutcomes,
  workspaceEditApplyResponse,
  type WorkspaceEditApplyHooks,
  type WorkspaceEditApplyOutcome,
} from "./workspace/workspaceEditApply";
import { validateSemanticWorkspaceEditPaths } from "./workspace/semanticWorkspaceEdit";
import {
  formatWorkspaceEditPreview,
  workspaceEditOperations,
  type WorkspaceEditPreview,
} from "./workspace/workspaceEditPreview";
import { RefactoringPreviewDialog } from "./workspace/RefactoringPreviewDialog";
import {
  buildRefactorPlan,
  refactorApplyGate,
  evaluateDestructiveRefactorAvailability,
  type RefactorPlanV3,
} from "./workspace/refactorPlan";
import { KeymapCheatSheetDialog } from "./workspace/KeymapCheatSheetDialog";
import { KeymapSettingsDialog } from "./workspace/KeymapSettingsDialog";
import {
  readKeymapSchemes,
  writeKeymapSchemes,
  type KeymapSchemeV3,
} from "./workspace/workspaceKeymapScheme";
import { TabSwitcher, type TabSwitcherEntry, type TabSwitcherToolWindow } from "./workspace/TabSwitcher";
import { DapAdapterGuideDialog } from "./workspace/DapAdapterGuideDialog";
import {
  buildWorkspacePathSnapshotEdit,
  WorkspaceEditHistory,
  type WorkspaceEditHistoryEntry,
  type WorkspaceEditPathSnapshot,
} from "./workspace/workspaceEditHistory";
import { makeSemanticRequestIdentity } from "./workspace/javaSemanticEvidence";
import {
  buildSafeDeleteWorkspaceEdit,
  safeDeleteFileCount,
} from "./workspace/safeDelete";
import { executeCodeAction } from "./workspace/codeActionExecution";
import { buildCapabilityEvidence, evidencePresentationLine } from "./workspace/capabilityEvidence";
import { toProviderDiagnosticsV3 } from "./workspace/inspectionProviderAdapter";
import {
  INTENTION_RESOLVE_TIMEOUT_MS,
  candidateFromProviderAction,
  IntentionSession,
} from "./workspace/intentionSession";
import {
  CanonicalCodeActionService,
  type CodeActionContextIdentity,
  type CodeActionProviderClient,
} from "./workspace/codeActionProviderAdapter";
import type { MenuItem } from "../ContextMenu";
import {
  transformWorkspaceResourceExpandedDirKeys,
  transformWorkspaceResourceFileKey,
  transformWorkspaceResourceFileRef,
  transformWorkspaceResourceTreeSelection,
  type WorkspaceResourceUiChange,
} from "./workspace/workspaceResourceState";
import {
  WorkspaceResourceRecoveryCoordinator,
} from "./workspace/workspaceResourceRecoveryCoordinator";
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
import { HierarchyPanel } from "./workspace/panels/HierarchyPanel";
import {
  executeHierarchyPrepare,
  type HierarchyRootState,
} from "./workspace/hierarchyQueryModel";
import { TodosBookmarksPanel } from "./workspace/panels/TodosBookmarksPanel";
import { CoveragePanel } from "./workspace/panels/CoveragePanel";
import {
  findFileCoverage,
  parseCoverageReport,
  type WorkspaceCoverageReport,
} from "./workspace/coverageModel";
import {
  findBookmarkByMnemonic,
  isValidMnemonic,
  mergeWorkspaceBookmarkSnapshot,
  normalizeMnemonic,
  readWorkspaceBookmarks,
  renameWorkspaceBookmarkGroup,
  restoreWorkspaceBookmarksForFile,
  setMnemonicBookmark,
  toggleWorkspaceBookmark,
  writeWorkspaceBookmarks,
  type WorkspaceBookmark,
} from "./workspace/todoBookmarks";
import {
  createOccurrenceSession,
  formatOccurrenceStatus,
  isOccurrenceSessionValid,
  stepOccurrence,
  type OccurrenceHighlightSession,
} from "./workspace/occurrenceHighlightModel";
import {
  selectActiveBanners,
  type EditorBannerItem,
} from "./workspace/editorBannerModel";
import {
  readHighlightingLevel,
  writeHighlightingLevel,
  type HighlightingLevel,
} from "./workspace/highlightingLevelModel";
import {
  classifyCompareReadError,
  compareDocumentDescriptor,
  compareTextByteLength,
  createClipboardCompareSession,
  createFileCompareSession,
  createUnavailableCompareSession,
  MAX_COMPARE_SIZE_BYTES,
  normalizeCompareText,
  type CompareDocumentDescriptor,
  type CompareSelection,
  type CompareSource,
  type CompareTarget,
  type EditorCompareSession,
} from "./workspace/editorCompareModel";
import { EditorCompareDialog } from "./workspace/EditorCompareDialog";
import { HighlightingWidget } from "./workspace/HighlightingWidget";
import {
  isDiagnosticScopeCurrent,
  type DiagnosticScope,
} from "./workspace/diagnosticScopeModel";
import {
  isDocCommentRenderingSupported,
  readReaderModePreference,
  writeReaderModePreference,
} from "./workspace/renderedDocCommentsModel";
import { useDeferredOpenFileTodos } from "./workspace/useDeferredOpenFileTodos";
import { type QuickDocContent } from "./workspace/referenceDocumentation";
import {
  extractProviderDocLinks,
  openExternalDocumentation,
  validateExternalDocUrl,
} from "./workspace/referenceDocumentation";
import {
  LEGACY_CONTEXT_INFO_REASON,
  ReferenceInfoController,
  type ReferenceHistorySnapshot,
} from "./workspace/referenceInfoController";
import {
  ParameterInfoSession,
  type ParameterDisplayState,
  type ParameterInvalidateReason,
  type ReferenceSessionContext,
} from "./workspace/referenceInfoSession";
import { useWorkspaceProjectAnalysis } from "./workspace/useWorkspaceProjectAnalysis";
import { useProjectFacts } from "../../hooks/useProjectFacts";
import { useProjectDescriptorDiscovery } from "../../hooks/useProjectDescriptorDiscovery";
import {
  DEFAULT_SCOPE_SELECTION,
  libraryUriClassifierForRoots,
  UsageQuerySession,
  type UsagesScopeSelection,
} from "./workspace/usageQuerySession";
import { UsagesScopeDialog } from "./workspace/UsagesScopeDialog";
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
import { ProjectFactsStatusBadge } from "./workspace/ProjectFactsStatusBadge";
import { WorkspaceBuildRunToolsDialog } from "./workspace/WorkspaceBuildRunToolsDialog";
import { WorkspaceIntelligenceSettingsDialog } from "./workspace/WorkspaceIntelligenceSettingsDialog";
import { WorkspaceEditorAppearanceSettingsDialog } from "./workspace/WorkspaceEditorAppearanceSettingsDialog";
import {
  DEFAULT_EDITOR_APPEARANCE_PROFILE,
  matchesBreadcrumbLanguage,
  matchesSoftWrapPath,
  normalizeEditorAppearanceProfile,
  readEditorAppearanceProfileWithDiagnostics,
  writeEditorAppearanceProfile,
  type EditorAppearanceProfile,
} from "./workspace/editorAppearanceProfile";
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
import { useWorkspaceActionsController } from "./workspace/useWorkspaceActionsController";
import {
  eventLogicalKey,
  type WorkspaceCommand,
  type WorkspaceCommandContext,
  type WorkspaceCommandRegistration,
} from "./workspace/workspaceCommands";
import type { ShellShortcutClaim } from "./workspace/shellShortcutRouter";
import type { WorkspaceFocus } from "./workspace/workspaceActionRegistry";
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

function compareSelectionFromEditorSelection(
  selection: EditorSelectionRange,
): CompareSelection | undefined {
  if (selection.empty || (
    selection.start.line === selection.end.line
    && selection.start.character === selection.end.character
  )) return undefined;
  return {
    start: { ...selection.start },
    end: { ...selection.end },
    text: normalizeCompareText(selection.text),
  };
}

function compareDescriptorForOpenFile(
  file: OpenFileState,
  source: CompareSource,
  path: string,
  text = file.text,
  title = file.title,
): CompareDocumentDescriptor {
  return compareDocumentDescriptor({
    title,
    path,
    text,
    encoding: file.encoding ?? "UTF-8",
    eol: file.eol,
    bom: file.bom ?? false,
    sizeBytes: text === file.text && !file.dirty ? file.size : compareTextByteLength(text),
    source,
    readOnly: false,
  });
}

function compareTargetForOpenFile(
  file: OpenFileState,
  selection?: CompareSelection,
): CompareTarget {
  return {
    fileKey: file.key,
    documentRevision: file.documentRevision ?? 0,
    expectedText: file.text,
    selection,
  };
}

function comparePositionOffset(text: string, position: { line: number; character: number }): number {
  const lines = text.split("\n");
  const line = Math.min(Math.max(0, position.line), Math.max(0, lines.length - 1));
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + Math.min(Math.max(0, position.character), lines[line]?.length ?? 0);
}

function replaceCompareSelection(
  text: string,
  selection: CompareSelection,
  replacement: string,
): string | null {
  const from = comparePositionOffset(text, selection.start);
  const to = comparePositionOffset(text, selection.end);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (text.slice(start, end) !== selection.text) return null;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function compareTargetMatches(file: OpenFileState | null, target: CompareTarget): boolean {
  return !!file
    && file.key === target.fileKey
    && (file.documentRevision ?? 0) === target.documentRevision
    && file.text === target.expectedText;
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
  layoutTreeV2: LayoutNode;
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
const WORKSPACE_BOOKMARK_MNEMONICS = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

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
// Shared empty result so "no diagnostics" is always the same array identity.
const EMPTY_DISPLAY_DIAGNOSTICS: LspDiagnostic[] = [];

export function extractContextSnippet(
  text: string,
  targetLine: number,
  targetOffset?: number,
): { lineText: string; contextSnippet: string } {
  if (targetOffset !== undefined) {
    const offset = Math.max(0, Math.min(targetOffset, text.length));
    const targetLineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
    const targetLineBreak = text.indexOf("\n", offset);
    const targetLineEnd = targetLineBreak === -1 ? text.length : targetLineBreak;
    const contextStart = targetLine <= 0
      ? targetLineStart
      : targetLineStart > 1
        ? text.lastIndexOf("\n", targetLineStart - 2) + 1
        : 0;
    const nextLineBreak = targetLineBreak === -1
      ? -1
      : text.indexOf("\n", targetLineBreak + 1);
    const contextEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
    return {
      lineText: text.slice(targetLineStart, targetLineEnd),
      contextSnippet: text.slice(contextStart, contextEnd),
    };
  }

  const desiredStart = Math.max(0, targetLine - 1);
  const desiredEnd = targetLine + 1;
  let currentLine = 0;
  let lineStart = 0;
  let targetLineStart = 0;
  let targetLineEnd = text.length;
  let startLineOffset = 0;
  let endLineOffset = text.length;

  let pos = 0;
  while (pos <= text.length) {
    const nextNewline = text.indexOf("\n", pos);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    if (currentLine === desiredStart) startLineOffset = lineStart;
    if (currentLine === targetLine) {
      targetLineStart = lineStart;
      targetLineEnd = lineEnd;
    }
    if (currentLine === desiredEnd) {
      endLineOffset = lineEnd;
      break;
    }
    if (nextNewline === -1) {
      if (currentLine < desiredEnd) endLineOffset = text.length;
      break;
    }
    currentLine++;
    lineStart = nextNewline + 1;
    pos = lineStart;
  }

  return {
    lineText: text.slice(targetLineStart, targetLineEnd),
    contextSnippet: text.slice(startLineOffset, endLineOffset),
  };
}

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
  diagnosticInspectionId,
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
import {
  executeBoundedAsyncQueue,
  planWorkspaceRestore,
} from "./workspace/workspaceRestoreModel";
import {
  planCleanup,
  planRearrange,
} from "./workspace/rearrangeCleanupWorkflow";

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
  const referenceInfoController = useMemo(
    () => new ReferenceInfoController(workspaceInstanceId),
    [workspaceInstanceId],
  );
  // §8.20.2 W1: the ONLY Parameter Info request sequence lives in this
  // session; the editor host is a pure display adapter.
  const parameterInfoSession = useMemo(
    () => new ParameterInfoSession(referenceInfoController),
    [referenceInfoController],
  );
  const [parameterPopup, setParameterPopup] = useState<ParameterDisplayState>({ phase: "hidden" });
  const [referenceHistory, setReferenceHistory] = useState<ReferenceHistorySnapshot>(
    () => referenceInfoController.historySnapshot(),
  );
  useEffect(() => {
    referenceInfoController.activate();
    setReferenceHistory(referenceInfoController.historySnapshot());
    return () => referenceInfoController.dispose();
  }, [referenceInfoController]);
  useEffect(() => {
    const unsubscribe = parameterInfoSession.subscribe(setParameterPopup);
    return () => {
      unsubscribe();
      parameterInfoSession.dispose();
    };
  }, [parameterInfoSession]);
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
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const replaceBookmarks = useCallback((next: WorkspaceBookmark[]) => {
    bookmarksRef.current = next;
    setBookmarks(next);
  }, []);
  const restoreBookmarksForFileKey = useCallback((fileKeyValue: string, pathLabel?: string) => {
    const current = bookmarksRef.current;
    if (!current.some((bookmark) => bookmark.fileKey === fileKeyValue && bookmark.state === "missing")) return;
    const next = restoreWorkspaceBookmarksForFile(current, fileKeyValue, pathLabel);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);
  // §8.19.6 per-workspace tab policy: restored from the layout snapshot
  // (migrated/repaired on read) and consumed by open-time limit enforcement.
  // Editing UI is deferred — restored values already govern eviction.
  const [tabPolicy, setTabPolicy] = useState<WorkspaceTabPolicyV3>(() => ({ ...DEFAULT_WORKSPACE_TAB_POLICY_V3 }));
  const tabPolicyRef = useRef(tabPolicy);
  tabPolicyRef.current = tabPolicy;
  const [tabPolicyRevision, setTabPolicyRevision] = useState(0);
  // §8.26.3 AA2: Monotonic layout revision and base revision for tab policy transactions (§ED-TABS-001)
  const layoutRevision = useCodeWorkspaceStore(
    (state) => state.byInstanceId[workspaceInstanceId]?.layoutRevision ?? 0,
  );
  const [baseLayoutRevision, setBaseLayoutRevision] = useState(0);

  const openTabPolicySettings = useCallback(() => {
    setBaseLayoutRevision(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).layoutRevision);
    setTabPolicySettingsOpen(true);
  }, [workspaceInstanceId]);

  // §8.26.2 AA1: Root workspace clipboard session handle with permission adapter (§8.27.2 BB1 / ED-CLIP-002)
  const clipboardHandle = useMemo(() => acquireClipboardStore(workspaceInstanceId), [workspaceInstanceId]);
  const clipboardSnapshot = useSyncExternalStore(
    clipboardHandle.subscribe,
    clipboardHandle.getSnapshot,
    clipboardHandle.getSnapshot,
  );
  useEffect(() => {
    const detachAdapter = clipboardHandle.attachPermissionAdapter(createDefaultClipboardPermissionAdapter());
    return () => {
      detachAdapter();
      clipboardHandle.release();
    };
  }, [clipboardHandle]);
  // §8.19.9 R8-D1: code style schemes — production store with persistence;
  // the active scheme layers into effective-style resolution BELOW EditorConfig.
  const [codeStyleSchemes, setCodeStyleSchemes] = useState<CodeStyleSchemeStoreState>(
    () => readCodeStyleSchemeStore(),
  );
  const codeStyleSchemesRef = useRef(codeStyleSchemes);
  codeStyleSchemesRef.current = codeStyleSchemes;
  const changeCodeStyleSchemes = useCallback((next: CodeStyleSchemeStoreState) => {
    setCodeStyleSchemes(next);
    writeCodeStyleSchemeStore(next);
  }, []);
  const [codeStyleSettingsOpen, setCodeStyleSettingsOpen] = useState(false);
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
  const splitLayoutLeaf = useCodeWorkspaceStore((s) => s.splitLayoutLeaf);
  const closeLayoutLeaf = useCodeWorkspaceStore((s) => s.closeLayoutLeaf);
  const moveLayoutTabStore = useCodeWorkspaceStore((s) => s.moveLayoutTab);
  const equalizeLayoutRatiosStore = useCodeWorkspaceStore((s) => s.equalizeLayoutRatios);
  const stretchLayoutLeafStore = useCodeWorkspaceStore((s) => s.stretchLayoutLeaf);
  const unsplitAllLayoutStore = useCodeWorkspaceStore((s) => s.unsplitAllLayout);
  const setLayoutTreeV2Store = useCodeWorkspaceStore((s) => s.setLayoutTreeV2);
  const closeLayoutTabInLeaf = useCodeWorkspaceStore((s) => s.closeLayoutTabInLeaf);
  const setLeafActiveTab = useCodeWorkspaceStore((s) => s.setLeafActiveTab);
  const setLayoutNodeRatios = useCodeWorkspaceStore((s) => s.setLayoutNodeRatios);
  const seedTreeExpandIfEmpty = useCodeWorkspaceStore((s) => s.seedTreeExpandIfEmpty);
  // Ensure before first read so the selector always hits a real map entry.
  ensureWorkspaceUi(workspaceInstanceId);
  const workspaceUi = useCodeWorkspaceStore((s) => selectCodeWorkspaceUi(s, workspaceInstanceId));

  useEffect(() => {
    ensureWorkspaceUi(workspaceInstanceId);
    replaceBookmarks(readWorkspaceBookmarks(workspaceInstanceId));
  }, [ensureWorkspaceUi, replaceBookmarks, workspaceInstanceId]);

  // Restore chrome/layout once per instance, then seed expand keys only when empty.
  const layoutHydratedRef = useRef<string | null>(null);
  const layoutRestoredOpenFilesRef = useRef(false);
  useEffect(() => {
    if (layoutHydratedRef.current === workspaceInstanceId) return;
    layoutHydratedRef.current = workspaceInstanceId;
    layoutRestoredOpenFilesRef.current = false;
    const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
    if (snapshot) {
      if (snapshot.layoutRecovered) {
        setStatusMessage("Recovered invalid workspace layout into a single editor leaf");
      }
      setTabPolicy(snapshot.tabPolicy ?? { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 });
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
        layoutTreeV2: snapshot.layoutTreeV2,
        editorGroups: Object.fromEntries(
          Object.entries(snapshot.editorGroups).map(([id, g]) => [
            id,
            {
              id,
              openOrder: g.openOrder,
              activeKey: g.activeKey,
              previewKey: g.previewKey,
              pinnedKeys: g.pinnedKeys,
            },
          ]),
        ),
        openOrder: uniqueOrderedKeys(snapshot.editorGroups),
        activeKey: snapshot.editorGroups[snapshot.activeEditorGroupId]?.activeKey
          ?? snapshot.editorGroups.primary?.activeKey
          ?? snapshot.editorGroups.secondary?.activeKey
          ?? null,
      });
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, snapshot);
      layoutRestoredOpenFilesRef.current = layoutSnapshotHasOpenFiles(snapshot);
      return;
    }
    const seedRoots = initialRoots(workspace);
    // §8.16.4 N6.6: fresh mounts materialize a single-leaf v2 tree
    // immediately so the recursive renderer is the only production layout
    // path from first paint; the primary/secondary fallback never renders.
    // The dormant "secondary" group stays present-but-empty: empty legacy
    // slots carry no layout truth (see validateTreeGroupConsistency).
    const uiNow = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    patchWorkspaceUi(workspaceInstanceId, {
      layoutTreeV2: createSingleLeafLayout(
        "primary",
        uiNow.editorGroups.primary?.openOrder ?? [],
        uiNow.editorGroups.primary?.activeKey ?? null,
      ),
      editorGroups: {
        primary: uiNow.editorGroups.primary ?? createEditorGroup("primary"),
        secondary: createEditorGroup("secondary"),
      },
      activeEditorGroupId: "primary",
    });
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, defaultWorkspaceLayoutSnapshot());
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
  const editorCommandPortsRef = useRef(new Map<EditorGroupId, {
    fileKey: string;
    token: object;
    port: EditorCommandPort;
  }>());
  const [editorCommandContextRevision, setEditorCommandContextRevision] = useState(0);
  const registerEditorCommandPort = useCallback((
    groupId: EditorGroupId,
    registration: EditorCommandPortRegistration,
  ) => {
    const current = editorCommandPortsRef.current.get(groupId);
    if (registration.port) {
      editorCommandPortsRef.current.set(groupId, {
        fileKey: registration.fileKey,
        token: registration.token,
        port: registration.port,
      });
      setEditorCommandContextRevision((revision) => revision + 1);
      return;
    }
    if (
      current?.fileKey !== registration.fileKey
      || current.token !== registration.token
    ) {
      return;
    }
    editorCommandPortsRef.current.delete(groupId);
    setEditorCommandContextRevision((revision) => revision + 1);
  }, []);
  const activeEditorCommandOwner = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const groupId = ui.activeEditorGroupId;
    const fileKey = ui.editorGroups[groupId]?.activeKey ?? null;
    const owner = editorCommandPortsRef.current.get(groupId) ?? null;
    return owner && fileKey === owner.fileKey ? owner : null;
  }, [workspaceInstanceId]);
  /**
   * Owner lookup pinned to an explicit recursive leaf. Context menus freeze
   * `{groupId, fileKey}` at open time; this guard keeps a later active-group
   * change from redirecting their execution to a different editor.
   */
  const editorCommandOwnerFor = useCallback((groupId: string, fileKey: string) => {
    const owner = editorCommandPortsRef.current.get(groupId as EditorGroupId) ?? null;
    return owner && owner.fileKey === fileKey ? owner : null;
  }, []);
  const activeEditorCommandState = useCallback((): EditorCommandState | null => {
    return activeEditorCommandOwner()?.port.state() ?? null;
  }, [activeEditorCommandOwner]);
  const executeActiveEditorCommand = useCallback((commandId: EditorCommandId, options?: EditorCommandOptions) => {
    return activeEditorCommandOwner()?.port.execute(commandId, options) ?? false;
  }, [activeEditorCommandOwner]);
  const executeEditorCommandFor = useCallback((
    target: EditorCommandTarget | undefined,
    commandId: EditorCommandId,
    options?: EditorCommandOptions,
  ) => {
    if (target) {
      return editorCommandOwnerFor(target.groupId, target.fileKey)
        ?.port.execute(commandId, options) ?? false;
    }
    return executeActiveEditorCommand(commandId, options);
  }, [editorCommandOwnerFor, executeActiveEditorCommand]);
  const executeEditorCommand = useCallback((commandId: EditorCommandId, context?: WorkspaceCommandContext) => {
    const target = context?.payload as EditorCommandTarget | undefined;
    if (
      target
      && typeof target === "object"
      && typeof target.groupId === "string"
      && typeof target.fileKey === "string"
    ) {
      return executeEditorCommandFor(target, commandId);
    }
    return executeActiveEditorCommand(commandId);
  }, [executeActiveEditorCommand, executeEditorCommandFor]);
  /**
   * Availability state for a command invocation. A context-menu payload pins
   * the owning leaf; without one (keyboard, palette) the active leaf answers.
   */
  const editorCommandStateFor = useCallback((context?: WorkspaceCommandContext): EditorCommandState | null => {
    const target = context?.payload as EditorCommandTarget | undefined;
    if (
      target
      && typeof target === "object"
      && typeof target.groupId === "string"
      && typeof target.fileKey === "string"
    ) {
      return editorCommandOwnerFor(target.groupId, target.fileKey)?.port.state() ?? null;
    }
    return activeEditorCommandState();
  }, [activeEditorCommandState, editorCommandOwnerFor]);
  /**
   * Resolve a provider-action invocation target. Context-menu payloads carry
   * the clicked file and position; keyboard/palette invocations fall back to
   * the active file at the current selection.
   */
  const resolveEditorTarget = useCallback((context?: WorkspaceCommandContext): {
    file: OpenFileState | null;
    position: LspPosition | undefined;
  } => {
    const payload = context?.payload as {
      groupId?: unknown;
      fileKey?: unknown;
      position?: LspPosition;
    } | undefined;
    if (typeof payload === "object" && payload !== null && typeof payload.fileKey === "string") {
      const file = openFilesRef.current[payload.fileKey] ?? null;
      return { file, position: payload.position };
    }
    // activeKeyRef is declared later in the component (keyboard switcher owns
    // it), so read through the store for the fallback active file.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const file = openFilesRef.current[ui.activeKey ?? ""] ?? null;
    return { file, position: editorSelectionRef.current.end };
  }, [workspaceInstanceId]);
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
  const pendingEditorCaretByFileRef = useRef(new Map<string, {
    position: LspPosition;
    offset?: number;
  }>());
  const flushPendingEditLocationsRef = useRef<() => void>(() => {});
  const pendingEditorTextTimerRef = useRef<number | null>(null);
  /** Debounced didChange timers keyed by open-file key (live buffer path). */
  const liveLspSyncTimersRef = useRef<Record<string, number>>({});
  const [externalFileConflicts, setExternalFileConflicts] = useState<PendingExternalFileConflict[]>([]);
  const pendingExternalFileEventsRef = useRef(new Map<string, PendingExternalFileEvent>());
  const [workspaceRecoveryEntries, setWorkspaceRecoveryEntries] = useState<WorkspaceRecoveryEntry[]>([]);
  const [workspaceRecoveryOpen, setWorkspaceRecoveryOpen] = useState(false);
  /** §8.19.1 disk-effect ledger view state; bumped whenever rows are recorded/resolved. */
  const [diskEffectLedgerRevision, setDiskEffectLedgerRevision] = useState(0);
  const bumpDiskEffectLedger = useCallback(() => {
    setDiskEffectLedgerRevision((revision) => revision + 1);
  }, []);
  const diskEffectLedgerEntries = useMemo(
    () => listDiskEffectLedgerEntries(workspaceInstanceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision drives refresh; rows only change through recorded/resolved events or workspace switches
    [workspaceInstanceId, diskEffectLedgerRevision],
  );
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
  const [recentLocationsOpen, setRecentLocationsOpen] = useState(false);
  // §8.19.8 Surround With dialog state (one entry, all kinds).
  const [surroundWithDialogOpen, setSurroundWithDialogOpen] = useState(false);
  // §8.19.8 Generate Code workflow state: provider candidates + phase.
  const [generateCode, setGenerateCode] = useState<{
    open: boolean;
    phase: "loading" | "ready" | "empty" | "running" | "error";
    candidates: GenerateCandidate[];
    error: string | null;
  }>({ open: false, phase: "loading", candidates: [], error: null });
  // §8.19.5 Paste-from-History popup state (session-only ring snapshot).
  const [clipboardHistoryOpen, setClipboardHistoryOpen] = useState(false);
  const [clipboardHistoryEntries, setClipboardHistoryEntries] = useState<EditorClipboardSession[]>([]);
  const generateCodeContextRef = useRef<{
    file: OpenFileState;
    range: LspRange;
    semanticToken: WorkspaceSemanticIndexBuildToken | null;
    actions: LspCodeAction[];
  } | null>(null);
  const [recentLocationsChangedOnly, setRecentLocationsChangedOnly] = useState(false);
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
    flushPendingEditLocationsRef.current();
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

  const initialEditorAppearance = readEditorAppearanceProfileWithDiagnostics(
    workspaceInstanceId,
    loadCodeViewProfile(),
  );
  const [editorAppearanceProfile, setEditorAppearanceProfileState] = useState<EditorAppearanceProfile>(
    () => {
      if (initialEditorAppearance.source === "migrated") {
        return writeEditorAppearanceProfile(workspaceInstanceId, initialEditorAppearance.profile);
      }
      return initialEditorAppearance.profile;
    },
  );
  const [activeEditorFontSizes, setActiveEditorFontSizes] = useState<Record<EditorGroupId, number>>({});
  const [editorAppearanceSettingsOpen, setEditorAppearanceSettingsOpen] = useState(false);
  const [tabPolicySettingsOpen, setTabPolicySettingsOpen] = useState(false);
  const [columnSelectionMode, setColumnSelectionMode] = useState(false);
  const [treeFontSize, setTreeFontSizeState] = useState(() => readCodeWorkspaceTreeFontSize());
  const [roots, setRoots] = useState<CodeWorkspaceRootInfo[]>(() => initialRoots(workspace));
  const projectFactsRoot = roots[0]?.path ?? "";
  const projectFacts = useProjectFacts(projectFactsRoot, {
    autoFetch: visible,
  });
  const projectDescriptorDiscovery = useProjectDescriptorDiscovery(projectFactsRoot, {
    autoRefresh: visible,
  });
  const refreshProjectFacts = useCallback(() => {
    void Promise.allSettled([
      projectFacts.refresh(),
      projectDescriptorDiscovery.refresh(),
    ]);
  }, [projectDescriptorDiscovery.refresh, projectFacts.refresh]);
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
    visible,
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
  const [syncSplitScroll, setSyncSplitScroll] = useState(false);
  const syncScrollOriginGroupIdRef = useRef<EditorGroupId | null>(null);
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
  useEffect(() => {
    setIntelligencePreferencesState(readWorkspaceIntelligencePreferences(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const [parameterInfoRequestNonce, setParameterInfoRequestNonce] = useState(0);
  // 迁移时保留用户现值: persisted auto-popup/delay values flow straight into
  // the session; defaults never overwrite them.
  useEffect(() => {
    parameterInfoSession.setPreferences(intelligencePreferences.parameterInfo);
  }, [intelligencePreferences.parameterInfo, parameterInfoSession]);
  const workspaceLspSessionManagerRef = useRef<WorkspaceLspSessionManager | null>(null);
  if (!workspaceLspSessionManagerRef.current) {
    workspaceLspSessionManagerRef.current = new WorkspaceLspSessionManager(intelligencePreferences.completion);
  }
  useEffect(() => {
    workspaceLspSessionManagerRef.current?.setCompletionPreferences(intelligencePreferences.completion);
  }, [intelligencePreferences.completion]);
  const [intelligenceSettingsOpen, setIntelligenceSettingsOpen] = useState(false);
  const [breadcrumbSymbolsByGroup, setBreadcrumbSymbolsByGroup] = useState<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  const [navigationBarActiveByGroup, setNavigationBarActiveByGroup] = useState<Record<EditorGroupId, boolean>>({
    primary: false,
    secondary: false,
  });
  const [occurrenceSession, setOccurrenceSession] = useState<OccurrenceHighlightSession | null>(null);
  const [dismissedBannerKeys, setDismissedBannerKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDismissedBannerKeys(new Set());
  }, [workspaceInstanceId]);
  const [fileHighlightingLevels, setFileHighlightingLevels] = useState<Record<string, HighlightingLevel>>({});

  const getFileHighlightingLevel = useCallback((fileKey: string): HighlightingLevel => {
    return fileHighlightingLevels[fileKey] ?? readHighlightingLevel(workspaceInstanceId, fileKey);
  }, [fileHighlightingLevels, workspaceInstanceId]);

  const setFileHighlightingLevel = useCallback((fileKey: string, level: HighlightingLevel) => {
    writeHighlightingLevel(workspaceInstanceId, fileKey, level);
    setFileHighlightingLevels((prev) => ({ ...prev, [fileKey]: level }));
  }, [workspaceInstanceId]);
  const [activeCompareSession, setActiveCompareSession] = useState<EditorCompareSession | null>(null);
  const [readerModeByFile, setReaderModeByFile] = useState<Record<string, boolean>>({});
  const [referencesResult, setReferencesResult] = useState<ReferencesResultState>({
    loading: false,
    origin: null,
    locations: [],
    error: null,
  });
  const referencesRequestSequenceRef = useRef(0);
  // §8.20.5 W4: ONE immutable usages session backs the tool window, the
  // lightweight Show Usages popup and the recent-query stack.
  const usageSessionRef = useRef<UsageQuerySession | null>(null);
  if (!usageSessionRef.current) usageSessionRef.current = new UsageQuerySession();
  useEffect(() => () => usageSessionRef.current?.dispose(), []);
  const [usagesScopeSelection, setUsagesScopeSelection] = useState<UsagesScopeSelection>({ ...DEFAULT_SCOPE_SELECTION });
  const [usagesScopeDialog, setUsagesScopeDialog] = useState<{
    open: boolean;
    file: OpenFileState;
    position: LspPosition;
  } | null>(null);
  const [usagesRecentsRevision, setUsagesRecentsRevision] = useState(0);
  // §8.19.7: pin ownership + rerun origin marker live above the panel so a
  // new Find Usages asks before replacing a pinned session and rerun targets
  // the recorded symbol identity instead of the current caret.
  const referencesPinnedRef = useRef(false);
  const [referencesPinned, setReferencesPinned] = useState(false);
  referencesPinnedRef.current = referencesPinned;
  const referencesRerunRef = useRef<{
    fileKey: string;
    uri: string;
    position: LspPosition;
    symbolName: string;
  } | null>(null);
  const findReferencesRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<void>>(async () => {});
  const [callHierarchyRoot, setCallHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const hierarchyRequestSequenceRef = useRef(0);
  // §8.20.5 W4: per-mode provenance for stale detection (provider restart /
  // project fingerprint move) surfaced as a Rerun banner in HierarchyPanel.
  const hierarchyProvenanceRef = useRef<Partial<Record<"call" | "type", {
    generation: number;
    projectFingerprint: string;
  }>>>({});
  const [hierarchyProvenanceRevision, setHierarchyProvenanceRevision] = useState(0);
  const [typeHierarchyRoot, setTypeHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const setIntelligencePreferences = useCallback((
    update: WorkspaceIntelligencePreferences
      | ((current: WorkspaceIntelligencePreferences) => WorkspaceIntelligencePreferences),
  ) => {
    setIntelligencePreferencesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return writeWorkspaceIntelligencePreferences(workspaceInstanceId, next);
    });
  }, [workspaceInstanceId]);
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);
  // Library sources opened from the language server (JDK / dependency classes),
  // keyed by editor key so a closed tab can be re-fetched from history.
  const libraryBuffersRef = useRef<Record<string, LibraryBufferInfo>>({});
  const editorAppearanceProfileRef = useRef(editorAppearanceProfile);
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
  const replayWorkspaceEncodingRef = useRef<Map<string, { encoding: string; bom: boolean; eol?: "lf" | "crlf" | "cr" }> | null>(null);
  const goToDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const peekDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToDeclarationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToTypeDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToImplementationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const renameSymbolRef = useRef<() => Promise<void>>(async () => {});
  const safeDeleteSymbolRef = useRef<() => Promise<void>>(async () => {});
  // Hover enriches the AI prompt with type information. The LSP hover callback
  // is declared further down, so read it through a ref.
  const getLspHoverRef = useRef<(
    file: OpenFileState,
    position: LspPosition,
  ) => Promise<QuickDocContent | null>>(async () => null);
  const breadcrumbSymbolsRef = useRef<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  const activeEditorGroupIdRef = useRef<EditorGroupId>("primary");
  const documentTransactionOwnerRef = useRef(new WorkspaceDocumentTransactionOwner());
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
  const lastTrackedBufferTextRef = useRef<Record<string, string>>({});

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

  const [indentationOverrides, setIndentationOverrides] = useState<Record<string, ExplicitIndentationOverride | null>>({});
  const indentationOverridesRef = useRef(indentationOverrides);
  indentationOverridesRef.current = indentationOverrides;

  const resolvedCodeStylesRef = useRef<Record<string, ResolvedCodeStyle>>({});
  const saveTransactionRegistryRef = useRef<SaveTransactionRegistry>(new SaveTransactionRegistry());
  const resourceRecoveryCoordinatorRef = useRef<WorkspaceResourceRecoveryCoordinator>(
    new WorkspaceResourceRecoveryCoordinator(workspaceInstanceId),
  );
  const workspaceStyleControllerRef = useRef<WorkspaceStyleController>(
    createWorkspaceStyleController({
      workspaceId: workspaceInstanceId,
      roots: rootsRef.current,
      fileProvider: {
        readFile: async () => null,
      },
    }),
  );

  // Unmount drops every live transaction owner so in-flight writers discard
  // their writeback/watcher/LSP side effects instead of resurrecting state.
  useEffect(() => {
    resourceRecoveryCoordinatorRef.current = new WorkspaceResourceRecoveryCoordinator(workspaceInstanceId);
    const registry = saveTransactionRegistryRef.current;
    return () => {
      registry.discardWorkspace(workspaceInstanceId);
      resourceRecoveryCoordinatorRef.current.dispose();
    };
  }, [workspaceInstanceId]);

  const rootsFingerprint = roots.map((r) => `${r.id}:${r.path}`).join("|");

  useEffect(() => {
    const provider = {
      readFile: async (absolutePath: string) => {
        const normalized = normalizeFsPath(absolutePath);
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, normalized);
          if (rel !== null) {
            try {
              const res = await workspaceReadFile(root.path, rel);
              return res.text;
            } catch {
              return null;
            }
          }
        }
        try {
          const res = await workspaceReadLooseFile(normalized);
          return res.text;
        } catch {
          return null;
        }
      },
    };
    workspaceStyleControllerRef.current = createWorkspaceStyleController({
      workspaceId: workspaceInstanceId,
      roots: rootsRef.current,
      fileProvider: provider,
    });

    return () => {
      workspaceStyleControllerRef.current.clearCache();
    };
  }, [rootsFingerprint, workspaceInstanceId]);

  const workspaceLocationControllerRef = useRef<WorkspaceLocationController>(
    createWorkspaceLocationController(workspaceInstanceId),
  );

  useEffect(() => {
    workspaceLocationControllerRef.current = createWorkspaceLocationController(workspaceInstanceId);
    return () => {
      workspaceLocationControllerRef.current.dispose();
    };
  }, [workspaceInstanceId]);

  const getEffectiveCodeStyleForFile = useCallback((file: { key: string; languagePath: string; text: string } | null): EffectiveCodeStyle | undefined => {
    if (!file) return undefined;
    const asyncResolved = resolvedCodeStylesRef.current[file.key];
    if (asyncResolved) return asyncResolved;
    const explicitOverride = indentationOverridesRef.current[file.key];
    // §8.19.9 R8-D1: the active scheme for the file's extension-keyed
    // language participates below EditorConfig.
    const languageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
    const activeScheme = activeSchemeForLanguage(codeStyleSchemesRef.current, languageKey || null);
    return resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride,
      activeSchemeFields: schemeStyleFields(activeScheme),
    });
  }, []);

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
    sessionGeneration: lspSessionGeneration,
    serverStatuses: lspServerStatuses,
    syncDocument: syncLspDocument,
    waitForSyncQueue: waitForLspDocumentSyncQueue,
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
    visible,
  });
  // §8.20.3 W2: provider-owned Project Analysis snapshot (phase/progress/
  // modules/classpath fingerprint). The generation resync rides the statuses
  // identity — a restart refreshes them, which re-probes on the new session.
  const [projectAnalysisGeneration, setProjectAnalysisGeneration] = useState(0);
  useEffect(() => {
    setProjectAnalysisGeneration(lspSessionGeneration());
  }, [lspServerStatuses, lspSessionGeneration]);
  const projectAnalysisRoots = useMemo(
    () => roots.map((root) => root.path),
    [roots],
  );
  const projectAnalysisDescriptorForRoot = useCallback(
    (root: string) => lspDescriptorForPath(root, root),
    [lspDescriptorForPath],
  );
  const javaServerStatus = useMemo(
    () => lspServerStatuses.find((server) => server.presetId === "java") ?? null,
    [lspServerStatuses],
  );
  const {
    snapshot: projectAnalysisSnapshot,
    probing: projectAnalysisProbing,
    refresh: refreshProjectAnalysis,
  } = useWorkspaceProjectAnalysis({
    workspaceInstanceId,
    roots: projectAnalysisRoots,
    provider: {
      configured: !!(javaServerStatus?.available || javaServerStatus?.active),
      active: !!javaServerStatus?.active,
      opening: false,
      lastError: javaServerStatus?.error ?? null,
    },
    progresses: lspProgresses,
    sessionGeneration: projectAnalysisGeneration,
    descriptorForRoot: projectAnalysisDescriptorForRoot,
  });
  const treePaneStyle = useMemo(() => ({
    "--taomni-code-tree-font-size": `${treeFontSize}px`,
    "--taomni-code-tree-small-font-size": `${Math.max(10, treeFontSize - 1)}px`,
    "--taomni-code-tree-row-height": `${Math.max(24, treeFontSize + 15)}px`,
  }) as CSSProperties, [treeFontSize]);
  const editorPaneStyle = useMemo(() => ({
    "--taomni-code-editor-ui-font-size": `${editorAppearanceProfile.fontSizePx}px`,
    "--taomni-code-editor-ui-small-font-size": `${Math.max(10, editorAppearanceProfile.fontSizePx - 2)}px`,
    "--taomni-code-editor-tab-height": `${Math.max(28, editorAppearanceProfile.fontSizePx + 15)}px`,
  }) as CSSProperties, [editorAppearanceProfile.fontSizePx]);

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

  const semanticQueryHostRef = useRef(new WorkspaceSemanticQueryHost());
  const workspaceInstanceIdRef = useRef(workspaceInstanceId);
  workspaceInstanceIdRef.current = workspaceInstanceId;
  const semanticQuerySequenceRef = useRef(0);
  const semanticQueryLatestRequestRef = useRef<Record<string, string>>({});

  const beginSemanticQuery = useCallback((
    kind: SemanticQueryKind,
    file: OpenFileState,
    descriptor: LspDocumentDescriptor,
    position: LspPosition,
  ) => {
    const documentRevision = openFilesRef.current[file.key]?.documentRevision ?? file.documentRevision;
    const capturedLspSessionGeneration = lspSessionGeneration();
    const requestId = `${workspaceInstanceId}:${kind}:${++semanticQuerySequenceRef.current}`;
    semanticQueryLatestRequestRef.current[kind] = requestId;
    const cancelKey = `${workspaceInstanceId}|${file.key}`;
    const requestSeq = nextLspRequestSequence();
    const identity: SemanticQueryIdentity = {
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? descriptor.filePath,
      position,
      documentRevision,
      lspSessionGeneration: capturedLspSessionGeneration,
      requestId,
    };
    const isCurrent = (candidate?: SemanticQueryIdentity): boolean => {
      const current = openFilesRef.current[file.key];
      const currentDescriptor = current ? lspDescriptorForFile(current) : null;
      const currentUri = currentDescriptor?.documentUri ?? currentDescriptor?.filePath;
      return workspaceInstanceIdRef.current === workspaceInstanceId
        && semanticQueryLatestRequestRef.current[kind] === requestId
        && (!candidate || candidate.requestId === requestId)
        && current != null
        && current.documentRevision === documentRevision
        && currentUri === identity.uri
        && lspSessionGeneration() === capturedLspSessionGeneration;
    };
    const guards: SemanticQueryLiveGuards = {
      getLiveDocumentRevision: () => openFilesRef.current[file.key]?.documentRevision ?? -1,
      getLiveLspGeneration: () => lspSessionGeneration(),
      guardDelivery: (candidate) => isCurrent(candidate),
    };
    return {
      identity,
      cancelKey,
      requestSeq,
      guards,
      isCurrent,
      lspOptions: (signal: AbortSignal) => ({ signal, cancelKey, requestSeq }),
    };
  }, [lspDescriptorForFile, lspSessionGeneration, workspaceInstanceId]);

  useEffect(() => {
    const queryHost = semanticQueryHostRef.current;
    return () => queryHost.cancelWorkspace(workspaceInstanceId);
  }, [workspaceInstanceId]);

  useEffect(() => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    pendingWorkspaceRecoveryKeysRef.current = new Set(entries.map((entry) => entry.key));
    setWorkspaceRecoveryEntries(entries);
    // §8.19.1: unresolved disk-effect rows also open the recovery center so a
    // previous session's committed-discarded/unknown writes are surfaced.
    setWorkspaceRecoveryOpen(
      entries.length > 0 || listDiskEffectLedgerEntries(workspaceInstanceId).length > 0,
    );
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
    editorAppearanceProfileRef.current = editorAppearanceProfile;
    clipboardHandle.setHistoryEnabled(editorAppearanceProfile.clipboard.historyEnabled);
    clipboardHandle.setHistoryLimits(
      editorAppearanceProfile.clipboard.historyMaxItems,
      editorAppearanceProfile.clipboard.historyMaxTotalBytes,
    );
  }, [editorAppearanceProfile, clipboardHandle]);

  useEffect(() => {
    const result = readEditorAppearanceProfileWithDiagnostics(
      workspaceInstanceId,
      loadCodeViewProfile(),
    );
    const next = result.source === "migrated"
      ? writeEditorAppearanceProfile(workspaceInstanceId, result.profile)
      : result.profile;
    editorAppearanceProfileRef.current = next;
    setEditorAppearanceProfileState(next);
    setActiveEditorFontSizes({});
    if (result.diagnostic?.kind === "corrupt") {
      setStatusMessage(result.diagnostic.message);
    }
  }, [setStatusMessage, workspaceInstanceId]);

  useEffect(() => {
    treeFontSizeRef.current = treeFontSize;
  }, [treeFontSize]);

  const updateEditorAppearanceProfile = useCallback((
    updater: EditorAppearanceProfile
      | ((current: EditorAppearanceProfile) => EditorAppearanceProfile),
    statusMessage?: (profile: EditorAppearanceProfile) => string,
  ) => {
    const current = editorAppearanceProfileRef.current;
    const next = normalizeEditorAppearanceProfile(
      typeof updater === "function" ? updater(current) : updater,
    );
    editorAppearanceProfileRef.current = next;
    setEditorAppearanceProfileState(next);
    writeEditorAppearanceProfile(workspaceInstanceId, next);
    if (next.zoomScope === "all-editors") setActiveEditorFontSizes({});
    if (statusMessage) setStatusMessage(statusMessage(next));
  }, [setStatusMessage, workspaceInstanceId]);

  const effectiveEditorFontSize = useCallback((groupId: EditorGroupId) => (
    editorAppearanceProfileRef.current.zoomScope === "active-editor"
      ? activeEditorFontSizes[groupId] ?? editorAppearanceProfileRef.current.fontSizePx
      : editorAppearanceProfileRef.current.fontSizePx
  ), [activeEditorFontSizes]);

  const setCodeViewFontSize = useCallback((size: number) => {
    const nextSize = clampCodeWorkspaceFontSize(size);
    if (editorAppearanceProfileRef.current.zoomScope === "active-editor") {
      setActiveEditorFontSizes((current) => ({
        ...current,
        [activeEditorGroupIdRef.current]: nextSize,
      }));
      setStatusMessage(`Active editor zoom ${nextSize}px`);
      return;
    }
    updateEditorAppearanceProfile(
      (current) => ({ ...current, fontSizePx: nextSize }),
      (next) => `Code workspace zoom ${next.fontSizePx}px`,
    );
  }, [setStatusMessage, updateEditorAppearanceProfile]);

  const currentEditorFontSize = effectiveEditorFontSize(activeEditorGroupId);
  const activeAppearancePath = activeKey
    ? openFilesRef.current[activeKey]?.languagePath
    : undefined;
  const activeFileSoftWrap = !!activeAppearancePath && matchesSoftWrapPath(
    activeAppearancePath,
    editorAppearanceProfile.softWrap.patterns,
  );

  const toggleSoftWrap = useCallback(() => {
    const path = activeKey ? openFilesRef.current[activeKey]?.languagePath : undefined;
    if (!path) return;
    updateEditorAppearanceProfile((current) => {
      const enabled = matchesSoftWrapPath(path, current.softWrap.patterns);
      return {
        ...current,
        softWrap: {
          ...current.softWrap,
          patterns: enabled
            ? current.softWrap.patterns.filter((pattern) => !matchesSoftWrapPath(path, [pattern]))
            : [...current.softWrap.patterns, path],
        },
      };
    }, (next) => (
      matchesSoftWrapPath(path, next.softWrap.patterns)
        ? `Soft wrap enabled for ${path}`
        : `Soft wrap disabled for ${path}`
    ));
  }, [activeKey, updateEditorAppearanceProfile]);

  const toggleColumnSelectionMode = useCallback(() => {
    setColumnSelectionMode((current) => {
      const next = !current;
      setStatusMessage(`Column selection mode ${next ? "enabled" : "disabled"}`);
      return next;
    });
  }, [setStatusMessage]);

  const stepCodeViewFontSize = useCallback((delta: number) => {
    setCodeViewFontSize(effectiveEditorFontSize(activeEditorGroupIdRef.current) + delta);
  }, [effectiveEditorFontSize, setCodeViewFontSize]);

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
      const targetElement = event.target instanceof Element ? event.target : null;
      if (targetElement?.closest('[data-testid="code-workspace-todos-panel"]')) return;

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

      // Ctrl+0 is also the IDEA mnemonic-bookmark jump. A live [0] bookmark
      // owns the key; only an unclaimed stroke remains the zoom reset.
      if (reset && findBookmarkByMnemonic(bookmarksRef.current, "0")) return;

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
        setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx);
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

  // §8.18.5: openFile enforces the tab limit through the closer defined
  // later in the component; the ref bridges the declaration order.
  const closeFileRef = useRef<
    ((key: string, groupId?: EditorGroupId, options?: { discard?: boolean }) => Promise<void>) | null
  >(null);

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
        const effectivePreview = options.preview && tabPolicyRef.current.previewMode;
        if (!alreadyOpen) {
          if (effectivePreview && tabPolicyRef.current.reusePreview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
            nextOrder = nextOrder.filter((entry) => entry !== previewKey);
          }
          if (tabPolicyRef.current.openPosition === "after-active") {
            const activeIdx = nextOrder.indexOf(group.activeKey ?? "");
            if (activeIdx >= 0) {
              nextOrder = [
                ...nextOrder.slice(0, activeIdx + 1),
                key,
                ...nextOrder.slice(activeIdx + 1),
              ];
            } else {
              nextOrder = [...nextOrder, key];
            }
          } else {
            nextOrder = [...nextOrder, key];
          }
        }
        if (effectivePreview) {
          previewKey = group.pinnedKeys.includes(key) ? null : key;
        } else if (previewKey === key) {
          previewKey = null;
        }
        return { ...group, openOrder: nextOrder, activeKey: key, previewKey };
      });
      if (groupId !== currentUi.activeEditorGroupId) activateEditorGroup(groupId);
      // §8.18.5 tab limit enforcement: opening beyond the leaf's limit evicts
      // clean preview/least-recent candidates; dirty/pinned tabs are never
      // silently closed (over-limit surfaces a reason instead).
      {
        const groupAfter = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
        if (groupAfter) {
          const meta = new Map(groupAfter.openOrder.map((entryKey) => [
            entryKey,
            {
              key: entryKey,
              dirty: !!openFilesRef.current[entryKey]?.dirty,
              pinned: groupAfter.pinnedKeys.includes(entryKey),
              preview: groupAfter.previewKey === entryKey,
              lastUsedAt: 1_000_000 - mruFileKeysRef.current.indexOf(entryKey),
            },
          ]));
          const eviction = enforceTabPolicy(groupAfter.openOrder, meta, tabPolicyRef.current);
          if (eviction.kind === "evicted") {
            for (const evictedKey of eviction.evictedKeys) {
              if (evictedKey !== key) void closeFileRef.current?.(evictedKey, groupId, { discard: true });
            }
          } else if (eviction.kind === "over-limit-protected") {
            setStatusMessage(eviction.reason);
          }
        }
      }
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
            documentRevision: 0,
            error: null,
          };
          return next;
        });
        restoreBookmarksForFileKey(fileKey(nextRef), meta.subtitle);
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
      restoreBookmarksForFileKey,
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

  /** §8.19.1: Acknowledge clears only the explicitly selected ledger row. */
  const acknowledgeDiskEffectLedgerEntry = useCallback((entry: WorkspaceDiskEffectLedgerEntryV4) => {
    resolveDiskEffectLedgerEntry(entry.workspaceId, entry.transactionId, entry.path);
    bumpDiskEffectLedger();
    setStatusMessage(`Acknowledged disk result for ${entry.path}`);
  }, [bumpDiskEffectLedger, setStatusMessage]);

  /** §8.19.1: Reopen loads the file as it exists on disk right now. */
  const reopenDiskEffectLedgerFile = useCallback((entry: WorkspaceDiskEffectLedgerEntryV4) => {
    // fileIdentity is `root:<rootId>:<path>` / `loose:<id>:<path>`; fall back
    // to a root scan when only the absolute path is known.
    const identity = entry.fileIdentity;
    let ref: CodeWorkspaceFileRef | null = null;
    if (identity.startsWith("root:")) {
      const [, rootId, ...rest] = identity.split(":");
      if (rootId && rest.length > 0) ref = { kind: "root", rootId, path: rest.join(":") };
    } else if (identity.startsWith("loose:")) {
      const [, id, ...rest] = identity.split(":");
      if (id && rest.length > 0) ref = { kind: "loose", id, path: rest.join(":") };
    }
    if (!ref) {
      const matchingRoot = roots.find(
        (root) => entry.path.startsWith(root.path + "/") || entry.path === root.path,
      );
      if (matchingRoot) {
        ref = {
          kind: "root",
          rootId: matchingRoot.id,
          path: entry.path.slice(matchingRoot.path.length).replace(/^\/+/, ""),
        };
      }
    }
    if (!ref) {
      setStatusMessage(`Cannot reopen ${entry.path}: it is outside the workspace roots`);
      return;
    }
    void openFile(ref, { preview: true });
    setStatusMessage(`Opened ${entry.path} from disk; compare it with your editor state before acknowledging`);
  }, [openFile, roots, setStatusMessage]);

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
    removeNavigationLocations,
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

  // Recent Locations is metadata, not part of the live editing contract. Build
  // its line/context snapshot once per settled input burst so a caret near the
  // end of a large source file does not rescan the entire prefix on every key.
  flushPendingEditLocationsRef.current = () => {
    for (const [key, file] of pendingEditorTextByFileRef.current) {
      const caret = pendingEditorCaretByFileRef.current.get(key);
      if (!caret) continue;
      const activeFilePath = file.path ?? file.title;
      const { position, offset } = caret;
      const { lineText, contextSnippet } = extractContextSnippet(file.text, position.line, offset);
      const isInsideAnyRoot = rootsRef.current.some((root) => (
        isPathContainedInRoot(activeFilePath, root.path)
      ));
      workspaceLocationControllerRef.current.recordUserEdit({
        fileKey: file.key,
        filePath: activeFilePath,
        title: file.title,
        line: position.line,
        character: position.character,
        lineText,
        contextSnippet,
        sourceOwnership: file.library ? "library" : isInsideAnyRoot ? "workspace" : "external",
      });
      recordEditLocation(file.ref, position);
    }
    pendingEditorCaretByFileRef.current.clear();
  };

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

  // §8.16.5 N2.6: single facade for Recent Locations + Back/Forward so
  // rename/delete/remove operations keep both histories in sync.
  const navigationPathForRef = useCallback((ref: CodeWorkspaceFileRef): string | null => {
    if (ref.kind === "loose") return ref.path;
    const root = rootsRef.current.find((candidate) => candidate.id === ref.rootId);
    if (!root) return null;
    return `${root.path}/${ref.path}`;
  }, []);

  const navigationHistoryFacade = useMemo(() => {
    const controller = workspaceLocationControllerRef.current;
    const remapRef = (ref: CodeWorkspaceFileRef, fromPath: string, toPath: string): CodeWorkspaceFileRef | null => {
      const refPath = navigationPathForRef(ref);
      if (refPath == null) return ref;
      const fromKey = workspacePathComparisonKey(fromPath);
      if (workspacePathComparisonKey(refPath) !== fromKey) return ref;
      if (ref.kind === "loose") return { ...ref, path: toPath };
      const nextRel = toPath.split("/").slice(-ref.path.split("/").length).join("/");
      return { ...ref, path: nextRel };
    };
    const bridge: BackForwardHistoryBridge = {
      removeLocation: (identity) => {
        removeNavigationLocations((loc) => {
          const locPath = navigationPathForRef(loc.ref);
          return (identity.fileKey !== null && fileKey(loc.ref) === identity.fileKey)
            || (locPath !== null
              && workspacePathComparisonKey(locPath) === workspacePathComparisonKey(identity.canonicalPath));
        });
      },
      relocateFile: (fromPath, toPath) => {
        reconcileNavigationFileReferences((ref) => remapRef(ref, fromPath, toPath));
      },
      removeDirectorySubtree: (dirPath) => {
        removeNavigationLocations((loc) => {
          const locPath = navigationPathForRef(loc.ref);
          return locPath !== null && isPathContainedInRoot(locPath, dirPath);
        });
      },
    };
    return new NavigationHistoryFacade(controller, undefined, bridge);
  }, [
    navigationPathForRef,
    reconcileNavigationFileReferences,
    removeNavigationLocations,
  ]);

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
          const plan = planWorkspaceRestore(snapshot, looseFiles);

          // 1. Immediately open active tabs in each leaf so first screen interactive time (TTI) is minimal
          for (const target of plan.activeTargets) {
            void openFile(target.ref, {
              groupId: target.groupId,
              preview: target.preview,
            });
            updateEditorGroup(target.groupId, (g) => ({ ...g, activeKey: target.key }));
          }

          // Restore active group selection
          if (plan.activeGroupId) {
            activateEditorGroup(plan.activeGroupId);
          }

          // 2. Open background tabs with bounded concurrency (3) to avoid I/O bottlenecks
          if (plan.backgroundTargets.length > 0) {
            void executeBoundedAsyncQueue(
              plan.backgroundTargets,
              (target) => openFile(target.ref, {
                groupId: target.groupId,
                preview: target.preview,
              }),
              3,
            );
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
        layoutTreeV2: workspaceUi.layoutTreeV2,
        tabPolicy: tabPolicyRef.current,
      }), {
        // §8.17.4 step 3: persistence refusals surface as a recovery
        // diagnostic, not only a console line.
        onIssue: (message) => setStatusMessage(message),
      });
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
    workspaceUi.layoutTreeV2,
    tabPolicyRevision,
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
    locationController: workspaceLocationControllerRef.current,
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
      const result = await workspaceListDir(root.path, listPath);
      if (result.state !== "ready") return [];
      return toChildren([...result.entries], (entry) => entry.path);
    }

    // Loose file: list an absolute directory via workspace_list_dir(dir, "").
    const absolute = normalizeFsPath(segment.path);
    const dirToList = segment.kind === "file" ? parentPath(absolute) : absolute;
    if (!dirToList) return [];
    const result = await workspaceListDir(dirToList, "");
    if (result.state !== "ready") return [];
    return toChildren([...result.entries], (entry) =>
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
        // §8.16.4 N6.6: tree Ctrl+Enter splits the active recursive leaf.
        splitLayoutLeaf(workspaceInstanceId, current.activeEditorGroupId, "vertical");
        const next = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
        const targetGroupId: EditorGroupId | undefined = next.activeEditorGroupId !== current.activeEditorGroupId
          ? next.activeEditorGroupId
          : undefined;
        void openFile(selected.ref, targetGroupId ? { groupId: targetGroupId } : undefined);
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
  }, [openFile, selected, workspaceInstanceId]);

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

  type MutationReason =
    | "user-edit"
    | "programmatic"
    | "reload"
    | "workspace-edit"
    | "save-writeback"
    | "save-metadata"
    | "history-replay";

  interface BufferMutationPatch {
    text?: string;
    savedText?: string;
    eol?: OpenFileEol;
    encoding?: string;
    bom?: boolean;
    hash?: string;
    mtime?: number;
    size?: number;
    loading?: boolean;
    saving?: boolean;
    dirty?: boolean;
    error?: string | null;
    documentRevision?: number;
  }

  const mutateOpenBuffer = useCallback((
    key: string,
    patch: BufferMutationPatch,
    reason: MutationReason,
  ): OpenFileState | null => {
    const current = openFilesRef.current[key];
    if (!current) return null;

    const nextText = reason === "save-metadata" ? current.text : (patch.text !== undefined ? patch.text : current.text);
    const nextSavedText = patch.savedText !== undefined ? patch.savedText : current.savedText;
    const isTextChanged = reason !== "save-metadata" && patch.text !== undefined && patch.text !== current.text;

    let nextRevision = current.documentRevision ?? 0;
    if (reason === "save-writeback") {
      nextRevision = patch.documentRevision !== undefined
        ? Math.max(current.documentRevision ?? 0, patch.documentRevision)
        : (current.documentRevision ?? 0);
    } else if (reason === "save-metadata") {
      nextRevision = current.documentRevision ?? 0;
    } else if (isTextChanged || reason === "reload" || reason === "workspace-edit" || reason === "history-replay") {
      nextRevision = (current.documentRevision ?? 0) + 1;
    }

    const calculatedDirty = patch.dirty !== undefined
      ? patch.dirty
      : (nextText !== nextSavedText);

    const next: OpenFileState = {
      ...current,
      ...patch,
      text: nextText,
      savedText: nextSavedText,
      dirty: calculatedDirty,
      documentRevision: nextRevision,
    };

    openFilesRef.current = { ...openFilesRef.current, [key]: next };
    if (reason === "user-edit") {
      pendingEditorTextByFileRef.current.set(key, next);
    } else {
      pendingEditorTextByFileRef.current.delete(key);
      pendingEditorCaretByFileRef.current.delete(key);
      setOpenFiles((prev) => ({ ...prev, [key]: next }));
    }
    return next;
  }, [setOpenFiles]);

  const updateFileText = useCallback((key: string, text: string) => {
    mutateOpenBuffer(key, { text, error: null }, "programmatic");
  }, [mutateOpenBuffer]);

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
    // No active server: do not wait on every completion keystroke.
    if (!isLspFeatureReady(lspFilesRef.current[fileKey])) return null;
    await Promise.race([
      waitForLspDocumentSyncQueue(fileKey),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, LSP_FEATURE_SYNC_WAIT_MS);
      }),
    ]);
    const finalReady = kick();
    if (finalReady) return finalReady;
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
  }, [cancelLiveLspSync, isLspDocumentSynced, syncLspDocument, waitForLspDocumentSyncQueue]);

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

  const queueEditorTextUpdate = useCallback((
    key: string,
    text: string,
    caret?: LspPosition,
    caretOffset?: number,
  ) => {
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
    const next = mutateOpenBuffer(key, { text, error: null }, "user-edit");
    if (!next) return;
    pendingEditorCaretByFileRef.current.set(key, {
      position: caret ?? editorSelectionRef.current.start,
      offset: caretOffset,
    });
    const activeFilePath = next.path ?? next.title;
    semanticIndex.invalidateSilently("document-edited", [activeFilePath]);
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
    setStatusMessage(`Hidden locally (${scope}): ${diagnostic.source ?? "inspection"}:${diagnostic.code ?? "*"}`);
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
        const listing = await workspaceListDir(root.path, parentPath(relative));
        if (listing.state !== "ready") return null;
        const entry = listing.entries.find((candidate) => candidate.path === relative);
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
          eol: open.eol ? (open.eol.toLowerCase() as "lf" | "crlf" | "cr") : undefined,
        };
        const file = await workspaceReadFile(root.path, relative);
        const eol = file.text.includes("\r\n") ? ("crlf" as const) : file.text.includes("\r") && !file.text.includes("\n") ? ("cr" as const) : ("lf" as const);
        return {
          path: normalizedPath,
          exists: true,
          text: file.text,
          encoding: file.encoding ?? "UTF-8",
          bom: file.bom ?? false,
          eol,
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
      eol: open.eol ? (open.eol.toLowerCase() as "lf" | "crlf" | "cr") : undefined,
    };
    try {
      const file = await workspaceReadLooseFile(normalizedPath);
      const eol = file.text.includes("\r\n") ? ("crlf" as const) : file.text.includes("\r") && !file.text.includes("\n") ? ("cr" as const) : ("lf" as const);
      return {
        path: normalizedPath,
        exists: true,
        text: file.text,
        encoding: file.encoding ?? "UTF-8",
        bom: file.bom ?? false,
        eol,
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

  const absolutePathForBookmark = useCallback((bookmark: WorkspaceBookmark): string | null => {
    const open = openFilesRef.current[bookmark.fileKey];
    if (open) return absolutePathForOpenFile(open);
    for (const root of rootsRef.current) {
      const prefix = `root:${root.id}:`;
      if (bookmark.fileKey.startsWith(prefix)) {
        return absoluteWorkspacePath(root, bookmark.fileKey.slice(prefix.length));
      }
    }
    return null;
  }, [absolutePathForOpenFile]);

  const captureWorkspaceEditBookmarkSnapshot = useCallback((paths: readonly string[]): WorkspaceBookmark[] => {
    const affectedPaths = new Set(paths.map((path) => fsPathComparisonKey(path)));
    return bookmarksRef.current.filter((bookmark) => {
      const path = absolutePathForBookmark(bookmark);
      return path !== null && affectedPaths.has(fsPathComparisonKey(path));
    });
  }, [absolutePathForBookmark]);

  const restoreWorkspaceBookmarkSnapshot = useCallback((
    snapshot: readonly WorkspaceBookmark[],
    affectedIds: readonly string[],
  ) => {
    if (affectedIds.length === 0) return;
    const next = mergeWorkspaceBookmarkSnapshot(bookmarksRef.current, snapshot, affectedIds);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);

  const captureWorkspaceEditTabSnapshot = useCallback((
    paths: readonly string[],
  ): WorkspaceEditTabSnapshot => {
    const pathSet = new Set(paths.map(fsPathComparisonKey));
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    // §8.16.4 N6.6: snapshot every leaf at any depth, not just the legacy
    // primary/secondary pair; the full tree (with ratios) is captured so a
    // failed WorkspaceEdit restores the entire layout.
    const groupIds: EditorGroupId[] = getAllLeafNodes(ui.layoutTreeV2).map((leaf) => leaf.id);
    const files = Object.values(openFilesRef.current).flatMap((file) => {
      const absolutePath = absolutePathForOpenFile(file);
      if (!absolutePath || !pathSet.has(fsPathComparisonKey(absolutePath))) return [];
      const groups = groupIds.flatMap((id) => {
        const group = ui.editorGroups[id];
        if (!group || !group.openOrder.includes(file.key)) return [];
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
      layoutTreeV2: cloneLayoutTree(ui.layoutTreeV2),
      files,
    };
  }, [absolutePathForOpenFile, workspaceInstanceId]);

  const restoreWorkspaceEditTabs = useCallback(async (snapshot: WorkspaceEditTabSnapshot) => {
    // §8.16.4 N6.6: restore the entire recursive tree (structure + ratios)
    // before reopening tabs so a failed WorkspaceEdit recovers every leaf,
    // not just the two legacy groups.
    setLayoutTreeV2Store(workspaceInstanceId, cloneLayoutTree(snapshot.layoutTreeV2));
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
  }, [activateEditorGroup, openFile, updateEditorGroup, workspaceInstanceId]);

  /**
   * Persist an open buffer with an explicit text payload.
   * Used by WorkspaceEdit for open-clean files (§5.2.9): apply then save.
   * Unlike `saveFile`, this does not require the buffer to already be dirty.
   */
  const [localHistoryTarget, setLocalHistoryTarget] = useState<{ key: string; path: string } | null>(null);

  const compareLocalHistorySnapshot = useCallback((
    key: string,
    entry: LocalHistoryEntry,
    snapshotText: string,
    options?: {
      file?: OpenFileState;
      selection?: CompareSelection;
      target?: CompareTarget;
    },
  ) => {
    const file = options?.file ?? openFilesRef.current[key];
    if (!file) return;
    const path = absolutePathForOpenFile(file);
    if (!path) {
      setStatusMessage(`${file.title} has no local filesystem path`);
      return;
    }
    const selection = options?.selection ?? compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = options?.target ?? compareTargetForOpenFile(file, selection);
    const result = createFileCompareSession(
      {
        title: `${file.title} @ ${entry.reason} #${entry.id}`,
        path: entry.path,
        text: snapshotText,
        encoding: file.encoding ?? "UTF-8",
        eol: file.eol,
        bom: file.bom ?? false,
        sizeBytes: entry.byteLen,
        source: "local-history",
        readOnly: true,
      },
      compareDescriptorForOpenFile(file, "buffer", path, rightText, rightTitle),
      target,
    );
    if (!result.session) {
      const unavailable = classifyCompareReadError(result.error ?? "Local history snapshot is unavailable");
      setActiveCompareSession(createUnavailableCompareSession({
        source: "local-history",
        title: `Compare ${file.title} with Local History`,
        unavailableTitle: "Local History snapshot",
        reason: unavailable.reason,
        message: unavailable.message,
        right: compareDescriptorForOpenFile(file, "buffer", path, rightText, rightTitle),
        target,
      }));
      return;
    }
    setActiveCompareSession(result.session);
  }, [absolutePathForOpenFile, setStatusMessage]);

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
      hover = (await getLspHoverRef.current(file, selection.start))?.body ?? null;
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
  }, [buildEditorAiContext, buildEditorAiPrompt, defaultAiInstruction, editorAiPreferences.answerLanguage, sendPromptToTabChat, setStatusMessage, t]);

  const writeTextSnapshot = useCallback(async (request: {
    fileKey?: string;
    filePath: string;
    logicalText: string;
    expectedDiskHash: string | null;
    policy: {
      eol: OpenFileEol | "lf" | "crlf" | "cr";
      encoding?: string;
      bom?: boolean;
    };
    bufferVersion?: number;
    styleGeneration?: number;
  }): Promise<WorkspaceWriteAck> => {
    const targetEncoding = request.policy.encoding ?? "UTF-8";
    const targetBom = request.policy.bom ?? false;
    const rawEol = request.policy.eol ?? "LF";
    const eol = (typeof rawEol === "string" ? rawEol.toLowerCase() : "lf") as "lf" | "crlf" | "cr";

    const normalizedText = applyEditorEol(request.logicalText, eol.toUpperCase() as OpenFileEol);

    let rootPath: string | null = null;
    let relPath: string | null = null;

    if (request.fileKey) {
      const file = openFilesRef.current[request.fileKey];
      if (file && file.ref.kind === "root") {
        const root = rootsRef.current.find((r) => r.id === (file.ref as { rootId: string }).rootId);
        if (root) {
          rootPath = root.path;
          relPath = file.ref.path;
        }
      }
    }

    if (!rootPath || !relPath) {
      const matchingRoot = rootsRef.current.find(
        (r) => request.filePath.startsWith(r.path + "/") || request.filePath === r.path,
      );
      if (matchingRoot) {
        rootPath = matchingRoot.path;
        relPath = request.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
      }
    }

    if (rootPath && relPath) {
      return workspaceWriteFileEncoded(
        rootPath,
        relPath,
        normalizedText,
        request.expectedDiskHash,
        targetEncoding,
        targetBom,
      );
    }

    return workspaceWriteLooseFileEncoded(
      request.filePath,
      normalizedText,
      request.expectedDiskHash,
      targetEncoding,
      targetBom,
    );
  }, []);

  /**
   * Re-read verification for an unknown-effect IPC failure (§8.18.1): the
   * native layer could not prove whether bytes landed, so the frontend reads
   * the real file back and classifies against the intended/old hashes.
   * Returns null when even the read fails — that stays `unknown`.
   */
  const readBackDiskSnapshot = useCallback(async (
    prepared: PreparedSave,
  ): Promise<Pick<WorkspaceFile, "hash" | "text" | "encoding" | "bom" | "size" | "mtime"> | null> => {
    try {
      const matchingRoot = rootsRef.current.find(
        (r) => prepared.filePath.startsWith(r.path + "/") || prepared.filePath === r.path,
      );
      if (matchingRoot) {
        const relPath = prepared.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
        const read = await workspaceReadFileWithEncoding(matchingRoot.path, relPath, prepared.policy.encoding);
        return read ?? null;
      }
      return await workspaceReadLooseFileWithEncoding(prepared.filePath, prepared.policy.encoding);
    } catch {
      return null;
    }
  }, []);

  /**
   * Record one unresolved unknown-effect ledger row for the recovery center
   * (§8.19.1): the row carries the native intent hash (non-null whenever the
   * encoded bytes were computed) and its blocking is decided by `resolution`
   * — a foreign observed hash never counts as verified.
   */
  const recordUnknownDiskEffect = useCallback((
    prepared: PreparedSave,
    observedHash: string | null,
    intendedNewHash: string | null,
  ): void => {
    const resolution: DiskResolution = resolveUnknownDiskResolution({
      intendedNewHash,
      expectedOldHash: prepared.expectedDiskHash,
      observedHash,
    });
    recordDiskEffectLedgerEntry({
      schemaVersion: 4,
      workspaceId: prepared.workspaceId,
      transactionId: prepared.transactionId,
      operationId: "save",
      path: prepared.filePath,
      fileIdentity: (() => {
        const file = openFilesRef.current[prepared.fileKey];
        return file ? workspaceFileIdentity(file.ref) : prepared.filePath;
      })(),
      expectedOldHash: prepared.expectedDiskHash,
      intendedNewHash,
      observedHash,
      diskEffect: "unknown",
      memoryEffect: "unchanged",
      providerEffect: "unknown",
      resolution,
      createdAt: Date.now(),
      // Only confirmed resolutions may claim verification; blocked rows keep
      // a null timestamp so no legacy field can act as "unblocked".
      verifiedAt: resolution === "confirmed-committed" || resolution === "confirmed-none"
        ? Date.now()
        : null,
      resolvedAt: null,
    });
    bumpDiskEffectLedger();
  }, [bumpDiskEffectLedger]);

  /**
   * Record the fact that bytes provably landed on disk but every editor
   * writeback was discarded (§8.19.1): the recovery center shows
   * "saved to disk, buffer state discarded" with Reopen/Acknowledge instead
   * of silently dropping a real disk effect.
   */
  const recordCommittedDiscardLedgerEntry = useCallback((
    prepared: PreparedSave,
    writtenHash: string,
  ): void => {
    const now = Date.now();
    const entry: WorkspaceDiskEffectLedgerEntryV4 = {
      schemaVersion: 4,
      workspaceId: prepared.workspaceId,
      transactionId: prepared.transactionId,
      operationId: "save",
      path: prepared.filePath,
      fileIdentity: prepared.fileKey.startsWith("closed:")
        ? prepared.fileKey.slice("closed:".length)
        : (() => {
          const file = openFilesRef.current[prepared.fileKey];
          return file ? workspaceFileIdentity(file.ref) : prepared.filePath;
        })(),
      expectedOldHash: prepared.expectedDiskHash,
      intendedNewHash: writtenHash,
      observedHash: writtenHash,
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      createdAt: now,
      verifiedAt: now,
      resolvedAt: null,
    };
    recordDiskEffectLedgerEntry(entry);
    bumpDiskEffectLedger();
  }, [bumpDiskEffectLedger]);

  /**
   * Shared closed-file committer (§8.19.1). Closed-file WorkspaceEdit writes
   * go through the same PreparedSave identity, byte writer, unknown-effect
   * read-back, recovery ledger and generation-gated watcher effects as
   * open-buffer saves, and return the full typed result — callers must never
   * treat an uncertain write as success.
   */
  const commitClosedFilePreparedSave = useCallback(async (
    prepared: PreparedSave,
  ): Promise<SaveCommitResult> => {
    const registry = saveTransactionRegistryRef.current;
    const owner = registry.begin(prepared.workspaceId, prepared.fileKey, prepared.transactionId);
    try {
      // Snapshot current disk contents before bulk WorkspaceEdit writes.
      try {
        let oldText: string | null = null;
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, prepared.filePath);
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
            oldText = (await workspaceReadLooseFile(prepared.filePath)).text;
          } catch {
            oldText = null;
          }
        }
        if (oldText != null && oldText.length <= 2 * 1024 * 1024) {
          await historySnapshot(prepared.filePath, oldText, "replace").catch(() => null);
        }
      } catch {
        // Best-effort history; never block the edit write.
      }

      let ack: WorkspaceWriteAck;
      try {
        ack = await writeTextSnapshot({
          filePath: prepared.filePath,
          logicalText: prepared.text,
          expectedDiskHash: prepared.expectedDiskHash,
          policy: prepared.policy,
        });
      } catch (writeError) {
        // Same typed classification as open-buffer commits (§8.19.1).
        const mapped = saveCommitResultFromError(prepared.transactionId, writeError);
        if (mapped.diskEffect !== "unknown") {
          return mapped.kind === "conflict"
            ? {
              kind: "conflict",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            }
            : {
              kind: "failed",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
        }
        // The bridge could not prove whether bytes landed: verify against the
        // real on-disk hash before reporting anything.
        const observed = await readBackDiskSnapshot(prepared);
        const verification = classifyUnknownDiskEffect({
          writtenHash: mapped.error.writtenHash,
          expectedOldHash: prepared.expectedDiskHash,
          observedHash: observed?.hash ?? null,
        });
        const intendedHash = mapped.error.intentHash ?? mapped.error.writtenHash ?? null;
        if (verification.outcome === "committed" && observed) {
          // Intended bytes are provably on disk; continue as committed.
          ack = {
            file: {
              path: prepared.filePath,
              text: observed.text,
              encoding: observed.encoding ?? prepared.policy.encoding,
              bom: observed.bom ?? prepared.policy.bom,
              size: observed.size ?? 0,
              mtime: observed.mtime ?? 0,
              hash: observed.hash,
            },
            writtenHash: mapped.error.writtenHash ?? observed.hash,
            writtenByteLength: mapped.error.writtenByteLength ?? 0,
            atomicReplaceUsed: true,
          };
        } else if (verification.outcome === "none") {
          // Verified zero disk effect — clear any stale ledger row for this
          // exact transaction/path only.
          resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
          return {
            kind: mapped.kind,
            transactionId: prepared.transactionId,
            diskEffect: "none",
            memoryEffect: "unchanged",
            providerEffect: "not-sent",
            error: mapped.error,
          } as SaveCommitResult;
        } else {
          recordUnknownDiskEffect(
            prepared,
            verification.outcome === "foreign" ? verification.observedHash : observed?.hash ?? null,
            intendedHash,
          );
          return {
            kind: "failed",
            transactionId: prepared.transactionId,
            diskEffect: "unknown",
            memoryEffect: "unchanged",
            providerEffect: "unknown",
            error: mapped.error,
            recoveryId: prepared.transactionId,
          };
        }
      }

      // Disk acknowledged. Watcher notify is generation-gated like every
      // other writeback side effect.
      if (!registry.check(owner).active) {
        recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
        return {
          kind: "committed-writeback-discarded",
          transactionId: prepared.transactionId,
          diskEffect: "committed",
          memoryEffect: "writeback-discarded",
          providerEffect: "discarded",
          file: ack.file,
          reason: "Closed-file write owner was discarded during the write",
        };
      }
      await lspWorkspaceDidChangeWatchedFiles(prepared.workspaceId, [{
        path: prepared.filePath,
        type: 2,
      }]).catch(() => 0);
      if (!registry.check(owner).active) {
        recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
        return {
          kind: "committed-writeback-discarded",
          transactionId: prepared.transactionId,
          diskEffect: "committed",
          memoryEffect: "writeback-discarded",
          providerEffect: "discarded",
          file: ack.file,
          reason: "Owner lost after watcher notify",
        };
      }
      // A settled closed-file write clears its own ledger row for this path
      // only (§8.19.1).
      resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
      // No open buffer owns this write: no didSave is sent and nothing merges
      // back into memory ("saved-current" reports only the disk fact).
      return {
        kind: "saved-current",
        transactionId: prepared.transactionId,
        diskEffect: "committed",
        memoryEffect: "saved-current",
        providerEffect: "not-sent",
        file: ack.file,
      };
    } finally {
      registry.settle(owner);
    }
  }, [
    readBackDiskSnapshot,
    recordCommittedDiscardLedgerEntry,
    recordUnknownDiskEffect,
    writeTextSnapshot,
  ]);

  /** Typed cancellation with provably zero disk effect (§8.18.1). */
  function cancelledSaveCommit(
    prepared: PreparedSave,
    phase: "prepare" | "pre-write",
    reason: string,
  ): SaveCommitResult {
    return {
      kind: "cancelled",
      transactionId: prepared.transactionId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      phase,
      reason,
    };
  }

  /**
   * Single open-buffer save commit core (§8.18.1). Takes an immutable
   * PreparedSave, registers a transaction owner, runs the synchronous
   * pre-write boundary, invokes the one byte writer in the same turn, then is
   * the ONLY result classifier: it reports disk / memory / provider effects
   * verbatim. Bytes landed can never yield plain `cancelled`;
   * close/rename/unmount after the write yields
   * `committed-writeback-discarded`; an uncertain IPC failure is re-read
   * against hashes instead of pretending zero side effects.
   */
  const commitOpenBufferPreparedSave = useCallback(async (
    prepared: PreparedSave,
  ): Promise<SaveCommitResult> => {
    const key = prepared.fileKey;
    const registry = saveTransactionRegistryRef.current;
    const owner = registry.begin(prepared.workspaceId, key, prepared.transactionId);
    try {
      const fileAtPrepare = openFilesRef.current[key];
      if (!fileAtPrepare) {
        return cancelledSaveCommit(prepared, "pre-write", "Open buffer was closed before write");
      }

      mutateOpenBuffer(key, { saving: true, error: null }, "save-metadata");

      // Prepare-phase await: snapshot the previous on-disk contents before any
      // overwrite. Never mutates buffer text and never bumps a revision.
      if (prepared.filePath && fileAtPrepare.savedText.length <= 2 * 1024 * 1024) {
        const historyText = `${fileAtPrepare.bom ? "\uFEFF" : ""}${applyEditorEol(fileAtPrepare.savedText, fileAtPrepare.eol)}`;
        await historySnapshot(prepared.filePath, historyText, "save").catch(() => null);
      }

      // 2. Pre-write commit boundary (SYNCHRONOUS, NO AWAIT)
      const currentBeforeWrite = openFilesRef.current[key];
      let cancellation: string | null = validatePreparedSaveBoundary(prepared, currentBeforeWrite
        ? {
            filePath: absolutePathForOpenFile(currentBeforeWrite) ?? currentBeforeWrite.path ?? "",
            documentRevision: currentBeforeWrite.documentRevision ?? 0,
            styleGeneration: workspaceStyleControllerRef.current.getGeneration(),
          }
        : null);
      if (!cancellation) {
        const ownerCheck = registry.check(owner);
        if (!ownerCheck.active) cancellation = ownerCheck.reason;
      }
      if (cancellation) {
        mutateOpenBuffer(key, { saving: false }, "save-metadata");
        return cancelledSaveCommit(prepared, "pre-write", cancellation);
      }

      // In the SAME synchronous turn, invoke the byte writer.
      const writerPromise = writeTextSnapshot({
        fileKey: key,
        filePath: prepared.filePath,
        logicalText: prepared.text,
        expectedDiskHash: prepared.expectedDiskHash,
        policy: prepared.policy,
      });

      // 3. Writeback phase (merge, never overwrite text; generation-gated)
      try {
        let ack: WorkspaceWriteAck;
        try {
          ack = await writerPromise;
        } catch (writeError) {
          // §8.18.1: classify the typed IPC error by its native effect fact.
          const mapped = saveCommitResultFromError(prepared.transactionId, writeError);
          mutateOpenBuffer(key, { dirty: true, saving: false, error: mapped.error.message }, "save-metadata");
          if (mapped.diskEffect === "unknown") {
            // The bridge could not prove whether bytes landed: verify against
            // the real on-disk hash before reporting anything.
            const observed = await readBackDiskSnapshot(prepared);
            const verification = classifyUnknownDiskEffect({
              writtenHash: mapped.error.writtenHash,
              expectedOldHash: prepared.expectedDiskHash,
              observedHash: observed?.hash ?? null,
            });
            if (verification.outcome === "committed" && observed) {
              // Intended bytes are provably on disk: continue through the
              // normal committed classification with recovered metadata.
              ack = {
                file: {
                  path: prepared.filePath,
                  text: observed.text,
                  encoding: observed.encoding ?? prepared.policy.encoding,
                  bom: observed.bom ?? prepared.policy.bom,
                  size: observed.size ?? 0,
                  mtime: observed.mtime ?? 0,
                  hash: observed.hash,
                },
                writtenHash: mapped.error.writtenHash ?? observed.hash,
                writtenByteLength: mapped.error.writtenByteLength ?? 0,
                atomicReplaceUsed: true,
              };
            } else if (verification.outcome === "none") {
              // Verified zero disk effect — the write genuinely failed; clear
              // any stale ledger row for this exact transaction/path only.
              resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
              return mapped.kind === "conflict"
                ? {
                  kind: "conflict",
                  transactionId: prepared.transactionId,
                  diskEffect: "none",
                  memoryEffect: "unchanged",
                  providerEffect: "not-sent",
                  error: mapped.error,
                }
                : {
                  kind: "failed",
                  transactionId: prepared.transactionId,
                  diskEffect: "none",
                  memoryEffect: "unchanged",
                  providerEffect: "not-sent",
                  error: mapped.error,
                };
            } else {
              // Foreign content or unreadable: create a recovery entry with
              // the native intent hash and never auto-retry this path until a
              // user resolves it (§8.19.1).
              recordUnknownDiskEffect(
                prepared,
                verification.outcome === "foreign" ? verification.observedHash : observed?.hash ?? null,
                mapped.error.intentHash ?? mapped.error.writtenHash ?? null,
              );
              return {
                kind: "failed",
                transactionId: prepared.transactionId,
                diskEffect: "unknown",
                memoryEffect: "unchanged",
                providerEffect: "unknown",
                error: mapped.error,
                recoveryId: prepared.transactionId,
              };
            }
          } else if (mapped.kind === "conflict") {
            return {
              kind: "conflict",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
          } else {
            return {
              kind: "failed",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
          }
        }

        // Disk acknowledged. From here only committed kinds exist (§8.18.1).
        const ownerAfterWrite = registry.check(owner);
        if (!ownerAfterWrite.active) {
          // Bytes landed on disk, but the owning buffer/tab/workspace is gone:
          // discard writeback, watcher, git/semantic and LSP side effects and
          // leave a recovery row the user can Reopen/Acknowledge (§8.19.1).
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: ownerAfterWrite.reason,
          };
        }

        const liveAfterWrite = openFilesRef.current[key];
        const writeback = classifySaveWriteback(prepared, liveAfterWrite
          ? { documentRevision: liveAfterWrite.documentRevision ?? 0 }
          : null);
        if (writeback.kind === "discarded") {
          // Buffer closed while the writer was in flight: the disk write is
          // real, but no buffer or provider state may be resurrected.
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: writeback.reason,
          };
        }

        const savedPath = absolutePathForOpenFile(fileAtPrepare);
        if (savedPath && registry.check(owner).active) {
          if (savedPath.endsWith(".editorconfig")) {
            workspaceStyleControllerRef.current.invalidate(savedPath);
          }
          await lspWorkspaceDidChangeWatchedFiles(prepared.workspaceId, [{
            path: savedPath,
            type: 2,
          }]).catch(() => 0);
        }
        if (!registry.check(owner).active) {
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: "Owner lost after watcher notify",
          };
        }
        const normalized = normalizeEditorText(ack.file.text);
        const savedBom = ack.file.bom ?? prepared.policy.bom;
        const stale = writeback.kind === "saved-stale-snapshot";

        const latestNow = liveAfterWrite!;

        mutateOpenBuffer(
          key,
          {
            savedText: normalized.text,
            text: latestNow.text,
            eol: (prepared.policy.eol.toUpperCase() as OpenFileEol) ?? normalized.eol,
            encoding: ack.file.encoding ?? prepared.policy.encoding,
            bom: savedBom,
            hash: ack.writtenHash || ack.file.hash,
            mtime: ack.file.mtime,
            size: ack.file.size,
            loading: false,
            saving: false,
            dirty: stale,
            error: null,
            documentRevision: latestNow.documentRevision,
          },
          "save-writeback",
        );

        if (!registry.check(owner).active) {
          // Closed between merge and provider sync; skip didSave/didChange
          // and leave the committed recovery row for Reopen/Acknowledge.
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: "Owner lost after writeback merge",
          };
        }
        if (fileAtPrepare.ref.kind === "root") {
          notifyWorkspacePathGitChanged(fileAtPrepare.ref.rootId, fileAtPrepare.ref.path);
        }
        semanticIndex.invalidate("document-saved", [savedPath ?? fileAtPrepare.path]);

        // A settled save clears its own ledger row for this path only — never
        // other workspaces or paths (§8.18.1).
        resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);

        if (!stale) {
          try {
            await saveLspDocument({ ...fileAtPrepare, text: prepared.text }, prepared.text);
            return {
              kind: "saved-current",
              transactionId: prepared.transactionId,
              diskEffect: "committed",
              memoryEffect: "saved-current",
              providerEffect: "did-save",
              file: ack.file,
            };
          } catch {
            // Provider sync failed after the disk write: do not roll back or
            // downgrade the disk fact; report the failed provider effect.
            return {
              kind: "saved-current",
              transactionId: prepared.transactionId,
              diskEffect: "committed",
              memoryEffect: "saved-current",
              providerEffect: "failed",
              file: ack.file,
            };
          }
        }
        try {
          // Stale-snapshot save: the disk now holds an older revision than the
          // live buffer. Sending didSave(snapshotText) would let the provider
          // observe an old document as the saved one; sync only the current
          // buffer via didChange and let the next explicit save own didSave.
          await syncLspDocument(latestNow, "change");
          return {
            kind: "saved-stale-snapshot",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "kept-dirty",
            providerEffect: "did-change-current",
            file: ack.file,
            savedRevision: prepared.bufferRevision,
            currentRevision: latestNow.documentRevision ?? 0,
          };
        } catch {
          return {
            kind: "saved-stale-snapshot",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "kept-dirty",
            providerEffect: "failed",
            file: ack.file,
            savedRevision: prepared.bufferRevision,
            currentRevision: latestNow.documentRevision ?? 0,
          };
        }
      } catch (err) {
        const message = errorMessage(err);
        mutateOpenBuffer(
          key,
          {
            dirty: true,
            saving: false,
            error: message,
          },
          "save-metadata",
        );
        throw err instanceof Error ? err : new Error(message);
      }
    } finally {
      registry.settle(owner);
    }
  }, [
    absolutePathForOpenFile,
    mutateOpenBuffer,
    notifyWorkspacePathGitChanged,
    readBackDiskSnapshot,
    recordCommittedDiscardLedgerEntry,
    recordUnknownDiskEffect,
    saveLspDocument,
    semanticIndex.invalidate,
    syncLspDocument,
    writeTextSnapshot,
  ]) as PreparedSaveCommitter;

  /** Public open-buffer save: prepares one transaction, then commits it. */
  const saveOpenBufferText = useCallback(async (
    key: string,
    textToSave?: string,
    saveOptions?: {
      eol?: OpenFileEol | "lf" | "crlf" | "cr";
      encoding?: string;
      bom?: boolean;
    },
  ): Promise<WorkspaceFile | null> => {
    const file = openFilesRef.current[key];
    if (!file || file.loading) {
      throw new Error("Open buffer is not available to save");
    }
    if (file.library) {
      throw new Error(`${file.title} is a read-only library source`);
    }

    // §8.19.1: a `pending-readback`/`foreign-blocked` ledger row blocks
    // automatic retries against the same path until a re-read confirms the
    // real bytes or the user resolves the row.
    const pendingUnknownPath = absolutePathForOpenFile(file) ?? file.path ?? file.title;
    if (hasBlockingDiskEffectResolution(workspaceInstanceId, pendingUnknownPath)) {
      throw new Error(
        `A previous save of ${file.subtitle} has an unverified disk result. Confirm the file contents in the recovery center before saving again.`,
      );
    }

    // 1. Prepare phase: capture the immutable PreparedSave through the shared
    // builder so every path (open-dirty, open-clean, replay) shares one shape.
    const prepared = buildPreparedSave({
      transactionId: nextSaveTransactionId(),
      workspaceId: workspaceInstanceId,
      fileKey: key,
      filePath: absolutePathForOpenFile(file) ?? file.path ?? file.title,
      text: textToSave !== undefined ? textToSave : file.text,
      bufferRevision: file.documentRevision ?? 0,
      styleGeneration: workspaceStyleControllerRef.current.getGeneration(),
      expectedDiskHash: file.hash ?? null,
      policy: resolveWritePolicy({
        explicit: {
          eol: saveOptions?.eol,
          encoding: saveOptions?.encoding,
          bom: saveOptions?.bom,
        },
        file,
      }),
    });

    const result = await commitOpenBufferPreparedSave(prepared);
    if (result.diskEffect === "committed") return result.file;
    return null;
  }, [
    absolutePathForOpenFile,
    commitOpenBufferPreparedSave,
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

    const absPath = absolutePathForOpenFile(file) ?? file.languagePath;
    const schemeLanguageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
    const codeStyle = await workspaceStyleControllerRef.current.resolveForFile({
      filePath: absPath,
      explicitOverride: indentationOverridesRef.current[file.key],
      text: file.text,
      activeSchemeFields: schemeStyleFields(
        activeSchemeForLanguage(codeStyleSchemesRef.current, schemeLanguageKey || null),
      ),
    });
    resolvedCodeStylesRef.current[file.key] = codeStyle;

    const result = useRange && selection
      ? await lspRangeFormatting(descriptor, {
        start: selection.start,
        end: selection.end,
      }, {
        tabSize: codeStyle.tabSize,
        insertSpaces: codeStyle.insertSpaces,
      })
      : await lspFormatting(descriptor, {
        tabSize: codeStyle.tabSize,
        insertSpaces: codeStyle.insertSpaces,
      });
    updateLspStatusForFile(file, result.status);
    if (!result.edits.length) return file.text;
    return applyLspTextEditsToString(file.text, result.edits);
  }, [absolutePathForOpenFile, findRoot, lspDescriptorForFile, updateLspStatusForFile, workspaceInstanceId]);

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

      const absPath = absolutePathForOpenFile(file) ?? file.languagePath;
      let formatError: string | null = null;

      const snapshotRevision = file.documentRevision ?? 0;
      const styleGeneration = workspaceStyleControllerRef.current.getGeneration();

      const tx: SaveTransactionV2 = {
        id: `tx-save-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        workspaceId: workspaceInstanceId,
        fileKey: file.key,
        filePath: absPath,
        bufferVersion: snapshotRevision,
        styleGeneration,
        expectedDiskHash: file.hash ?? null,
        explicitOverride: indentationOverridesRef.current[file.key] ?? null,
        policy: {
          eol: (file.eol?.toLowerCase() as "lf" | "crlf" | "cr") ?? "lf",
          encoding: file.encoding ?? "UTF-8",
          bom: file.bom ?? false,
        },
        text: file.text,
      };

      const schemeLanguageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
      const activeScheme = activeSchemeForLanguage(
        codeStyleSchemesRef.current,
        schemeLanguageKey || null,
      );
      const effectiveSavePolicy = resolveEffectiveSavePolicy(
        activeScheme,
        intelligencePreferences.formatOnSave,
        absPath,
      );

      // The controller prepares (style/normalization/policy freeze into one
      // PreparedSave); the commit core is the single byte writer + writeback
      // owner shared with every other save path (§8.17.1).
      const outcome: SaveCommitResult = await workspaceStyleControllerRef.current.executeSaveTransaction(
        tx,
        (prepared) => commitOpenBufferPreparedSave(prepared),
        {
          savePolicy: effectiveSavePolicy,
          formatOnSave: effectiveSavePolicy.format.enabled,
          formatFn: async (currentText) => {
            try {
              return await formatFileText({ ...file, text: currentText });
            } catch (err) {
              formatError = errorMessage(err);
              return null;
            }
          },
          organizeImportsOnSave: effectiveSavePolicy.organizeImports.enabled,
          organizeImportsFn: async (shadowText) => {
            try {
              const textToProcess = shadowText ?? file.text ?? "";
              const wholeFileRange: LspRange = {
                start: { line: 0, character: 0 },
                end: { line: textToProcess.split("\n").length, character: 0 },
              };
              const descriptor = lspDescriptorForFile(file);
              if (!descriptor) return null;

              const context: CodeActionContextIdentity = {
                document: {
                  uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath ?? file.key,
                  revision: file.documentRevision,
                  languageId: lspFilesRef.current[file.key]?.status?.languageId ?? descriptor.languageId ?? "plaintext",
                },
                provider: {
                  id: descriptor.languageId === "java" || !descriptor.languageId ? "jdtls" : descriptor.languageId,
                  version: null,
                  generation: lspSessionGeneration(),
                  projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
                  trusted: true,
                },
                range: wholeFileRange,
                diagnostics: [],
                only: ["source.organizeImports"],
              };

              const client: CodeActionProviderClient = {
                requestCodeActions: async (params) => {
                  const result = await lspCodeActions(
                    descriptor,
                    params.range,
                    [],
                    params.context.only ? [...params.context.only] : undefined,
                  );
                  return result.actions;
                },
                resolveCodeAction: async (act) => {
                  if (!act.raw) return null;
                  const res = await lspCodeActionResolve(descriptor, act.raw);
                  return res.action;
                },
              };

              const planResult = await canonicalCodeActionServiceRef.current!.planAction(context, client, {
                only: ["source.organizeImports"],
              });

              const validation = validateAndApplyOrganizeImportsPlan(
                textToProcess,
                context.document.uri,
                planResult.plan,
              );

              if (validation.valid && validation.transformedText !== null) {
                return validation.transformedText;
              }
              if (!validation.valid && validation.status === "failed") {
                formatError = validation.reason ?? "Organize imports validation failed";
                throw new Error(formatError);
              }
            } catch (err) {
              formatError = errorMessage(err);
              return null;
            }
            return null;
          },
          getLatestBufferVersion: () => openFilesRef.current[key]?.documentRevision ?? file.documentRevision ?? 0,
        },
      );

      if (outcome.kind === "saved-current" || outcome.kind === "saved-stale-snapshot") {
        const latestNow = openFilesRef.current[key];
        const wasStale = outcome.kind === "saved-stale-snapshot"
          || (latestNow?.documentRevision ?? 0) > snapshotRevision;
        if (wasStale) {
          setStatusMessage(`Saved previous snapshot of ${file.subtitle}; current changes remain unsaved`);
        } else {
          setStatusMessage(formatError
            ? `Saved ${file.subtitle}; format on save failed: ${formatError}`
            : `Saved ${file.subtitle}`);
        }
        if (isJavaBuildFile(file.languagePath) && lspFilesRef.current[key]?.status?.active) {
          void promptReloadProject(key, file.subtitle);
        }
      } else if (outcome.kind === "committed-writeback-discarded") {
        // Bytes are on disk but no buffer state was resurrected: never show a
        // success toast; the recovery center holds the disk path/hash.
        setStatusMessage(`${file.subtitle} written to disk after it closed; see recovery center for details`);
      } else if (outcome.kind === "cancelled") {
        setStatusMessage(`Save cancelled (${outcome.phase}): ${outcome.reason}`);
      } else if (outcome.kind === "conflict") {
        setStatusMessage(`Save conflict: ${outcome.error.message}`);
      } else if (outcome.diskEffect === "unknown") {
        // Unknown disk effect blocks automatic retries for this path until a
        // re-read confirms the real bytes (§8.18.1).
        setStatusMessage(`Save result unknown for ${file.subtitle}; verify the file in the recovery center before saving again`);
      } else {
        setStatusMessage(`Save failed: ${outcome.error.message}`);
      }
    },
    [
      activeKey,
      commitOpenBufferPreparedSave,
      formatFileText,
      intelligencePreferences.formatOnSave,
      promptReloadProject,
      setStatusMessage,
      workspaceInstanceId,
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
        mutateOpenBuffer(
          key,
          {
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
          "reload",
        );
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
    [activeKey, findRoot, mutateOpenBuffer, setStatusMessage],
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
    lastTrackedBufferTextRef.current[file.key] = disk.text;
    const next = mutateOpenBuffer(
      file.key,
      {
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
      },
      "reload",
    );
    if (next && latest.text !== next.text && lspFilesRef.current[file.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
  }, [mutateOpenBuffer, syncLspDocument]);

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
    if (normalizedPath.endsWith(".editorconfig")) {
      workspaceStyleControllerRef.current.invalidate(normalizedPath);
    }
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
      const lastUsedMap = new Map(mruFileKeysRef.current.map((k, idx) => [k, 1_000_000 - idx]));
      closeLayoutTabInLeaf(workspaceInstanceId, groupId, key, tabPolicyRef.current, lastUsedMap);
      if (usedByOtherGroup) return;

      const coordinator = resourceRecoveryCoordinatorRef.current;
      const closedTree = currentUi.layoutTreeV2;
      const closedLeaf = findLeafNode(closedTree, groupId);

      const outcome = await coordinator.executeResourceCleanup(key, {
        didClose: () => {
          if (file) closeLspDocument(file);
        },
        watcher: () => {
          const pending = pendingExternalFileEventsRef.current.get(key);
          if (pending) {
            window.clearTimeout(pending.timer);
            pendingExternalFileEventsRef.current.delete(key);
          }
        },
        buffer: () => {
          saveTransactionRegistryRef.current.discardFile(
            workspaceInstanceId,
            key,
            `Buffer ${file?.subtitle ?? key} was closed`,
          );
          setOpenFiles((current) => {
            if (!(key in current)) return current;
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
        history: () => {
          if (file) {
            setClosedTabsStack((stack) =>
              pushClosedTab(stack, {
                fileIdentity: workspaceFileIdentity(file.ref),
                ref: file.ref,
                title: file.title,
                subtitle: file.subtitle,
                leafPath: [groupId],
                closedAt: Date.now(),
                location: {
                  leafId: groupId,
                  treeRoute: buildReopenTreeRoute(closedTree, groupId),
                  siblingFileKeys: (closedLeaf?.openFileKeys ?? []).filter((entryKey) => entryKey !== key),
                },
              }),
            );
          }
        },
      });

      if (outcome.status === "committed-with-recovery") {
        setStatusMessage(outcome.message);
      }
    },
    [activeEditorGroupId, closeLspDocument, closeLayoutTabInLeaf, workspaceInstanceId],
  );
  closeFileRef.current = closeFile;

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
    if (!key || !openFilesRef.current[key]) return;
    splitLayoutLeaf(workspaceInstanceId, sourceGroupId, orientation, key);
  }, [activeEditorGroupId, activeKey, splitLayoutLeaf, workspaceInstanceId]);

  const closeSplit = useCallback(() => {
    closeLayoutLeaf(workspaceInstanceId, activeEditorGroupId);
  }, [activeEditorGroupId, closeLayoutLeaf, workspaceInstanceId]);

  // §8.19.6 R5-b: split management actions — navigation, tab moves between
  // splits, equalize/stretch proportions and unsplit-all. All layout truth
  // flows through the recursive-tree store reducers.
  const goToAdjacentSplit = useCallback((direction: 1 | -1): boolean => {
    const target = navigateLeafOrder(workspaceUi.layoutTreeV2, activeEditorGroupId, direction);
    if (!target || target.id === activeEditorGroupId) return false;
    setStoreActiveEditorGroup(workspaceInstanceId, target.id);
    setStatusMessage(`${direction === 1 ? "Next" : "Previous"} editor: ${target.id}`);
    return true;
  }, [activeEditorGroupId, setStoreActiveEditorGroup, setStatusMessage, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const moveActiveTabToAdjacentSplit = useCallback((direction: 1 | -1): boolean => {
    // Read through the store so a stale closure never moves the wrong tab.
    const liveUi = useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId];
    const sourceId = liveUi?.activeEditorGroupId ?? activeEditorGroupId;
    const key = sourceId ? (liveUi?.editorGroups[sourceId]?.activeKey ?? null) : null;
    if (!key) return false;
    const target = navigateLeafOrder(workspaceUi.layoutTreeV2, sourceId, direction);
    if (!target || target.id === sourceId) return false;
    moveLayoutTabStore(workspaceInstanceId, sourceId, target.id, key);
    setStatusMessage(`Moved ${openFilesRef.current[key]?.title ?? key} to the ${direction === 1 ? "next" : "previous"} split`);
    return true;
  }, [activeEditorGroupId, moveLayoutTabStore, openFilesRef, setStatusMessage, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const moveTabToAdjacentSplitFrom = useCallback((
    sourceLeafId: EditorGroupId,
    key: string,
    direction: 1 | -1,
  ): boolean => {
    const target = navigateLeafOrder(workspaceUi.layoutTreeV2, sourceLeafId, direction);
    if (!target || target.id === sourceLeafId) return false;
    moveLayoutTabStore(workspaceInstanceId, sourceLeafId, target.id, key);
    return true;
  }, [moveLayoutTabStore, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const equalizeActiveSplitRatios = useCallback((): boolean => {
    equalizeLayoutRatiosStore(workspaceInstanceId, activeEditorGroupId);
    setStatusMessage("Split proportions equalized");
    return true;
  }, [activeEditorGroupId, equalizeLayoutRatiosStore, setStatusMessage, workspaceInstanceId]);

  const stretchActiveSplit = useCallback((): boolean => {
    stretchLayoutLeafStore(workspaceInstanceId, activeEditorGroupId);
    return true;
  }, [activeEditorGroupId, stretchLayoutLeafStore, workspaceInstanceId]);

  const unsplitAllWindows = useCallback((): boolean => {
    if (getAllLeafNodes(useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId]?.layoutTreeV2
      ?? workspaceUi.layoutTreeV2).length <= 1) {
      setStatusMessage("No splits to close");
      return false;
    }
    unsplitAllLayoutStore(workspaceInstanceId);
    setStatusMessage("Closed all splits — tabs kept in one editor");
    return true;
  }, [setStatusMessage, unsplitAllLayoutStore, workspaceInstanceId, workspaceUi.layoutTreeV2]);

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
  // The session layer already content-dedupes `lspFiles[key].diagnostics`, so the
  // source array identity is stable between real diagnostic changes. Mapping it
  // through the inspection profile on every render would throw that stability
  // away and defeat CodeMirrorHost's identity-based memo, forcing a full
  // diagnostics-compartment reconfigure per render. Cache per source array so
  // the mapped result keeps the same identity too.
  const displayDiagnosticsCache = useMemo(
    () => new WeakMap<readonly LspDiagnostic[], { path: string | undefined; result: LspDiagnostic[] }>(),
    [inspectionProfile],
  );
  const displayDiagnosticsFor = useCallback(
    (source: LspDiagnostic[] | null | undefined, path: string | undefined): LspDiagnostic[] => {
      if (!source || source.length === 0) return EMPTY_DISPLAY_DIAGNOSTICS;
      const cached = displayDiagnosticsCache.get(source);
      if (cached && cached.path === path) return cached.result;
      const mapped = source.flatMap((diagnostic) => {
        const display = inspectionTransform(diagnostic, path);
        return display ? [display] : [];
      });
      const result = mapped.length === 0 ? EMPTY_DISPLAY_DIAGNOSTICS : mapped;
      displayDiagnosticsCache.set(source, { path, result });
      return result;
    },
    [displayDiagnosticsCache, inspectionTransform],
  );
  const diagnosticScopeForFile = useCallback((
    file: OpenFileState,
    state: LspFileState | null | undefined,
  ): DiagnosticScope => {
    const descriptor = lspDescriptorForFile(file);
    return {
      fileKey: file.key,
      revision: file.documentRevision ?? 0,
      providerId: state?.status?.presetId ?? null,
      providerGeneration: lspSessionGeneration(),
      uri: state?.status?.uri || descriptor?.documentUri || descriptor?.filePath || null,
    };
  }, [lspDescriptorForFile, lspSessionGeneration]);
  const currentDiagnosticsForFile = useCallback((
    file: OpenFileState,
    state: LspFileState | null | undefined,
  ): LspDiagnostic[] | null => {
    if (!state || !isDiagnosticScopeCurrent(state.diagnosticScope, diagnosticScopeForFile(file, state))) {
      return null;
    }
    return state.diagnostics;
  }, [diagnosticScopeForFile]);
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
    let requestSequence = 0;
    try {
      const position = cursorPositions[activeEditorGroupId] ?? editorSelectionRef.current.start;
      const fileKey = file.key;
      const docRevision = openFilesRef.current[fileKey]?.documentRevision ?? 0;
      const lspGen = lspSessionGeneration();
      requestSequence = ++hierarchyRequestSequenceRef.current;
      const requestId = `${workspaceInstanceId}:${mode}:prepare:${requestSequence}`;
      const cancelKey = `${workspaceInstanceId}|${fileKey}`;
      const requestSeq = nextLspRequestSequence();
      const isCurrent = (identity?: SemanticQueryIdentity) => (
        workspaceInstanceIdRef.current === workspaceInstanceId
        && hierarchyRequestSequenceRef.current === requestSequence
        && (!identity || identity.requestId === requestId)
        && openFilesRef.current[fileKey]?.documentRevision === docRevision
        && lspSessionGeneration() === lspGen
      );

      const prepareResult = await executeHierarchyPrepare(
        semanticQueryHostRef.current,
        descriptor,
        position,
        mode,
        {
          workspaceId: workspaceInstanceId,
          fileKey,
          documentRevision: docRevision,
          lspSessionGeneration: lspGen,
          projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
          requestId,
          cancelKey,
          requestSeq,
          guards: {
            getLiveDocumentRevision: () => openFilesRef.current[fileKey]?.documentRevision ?? 0,
            getLiveLspGeneration: () => lspSessionGeneration(),
            guardDelivery: (identity) => isCurrent(identity),
          },
        },
      );

      if (!isCurrent()) return;
      if (prepareResult.cancelled) return;
      updateLspStatusForFile(file, prepareResult.status);

      const root = prepareResult.root;
      if (!root) {
        setStatusMessage(`No ${mode} hierarchy is available at the cursor`);
        return;
      }
      if (!isCurrent()) return;
      hierarchyProvenanceRef.current = {
        ...hierarchyProvenanceRef.current,
        [mode]: {
          generation: lspGen,
          projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
        },
      };
      setHierarchyProvenanceRevision((revision) => revision + 1);
      if (mode === "call") {
        setCallHierarchyRoot(root);
        setBottomDockTab("call-hierarchy");
      } else {
        setTypeHierarchyRoot(root);
        setBottomDockTab("type-hierarchy");
      }
      setBottomDockOpen(true);
    } catch (cause) {
      if (
        requestSequence !== 0
        && (hierarchyRequestSequenceRef.current !== requestSequence
          || workspaceInstanceIdRef.current !== workspaceInstanceId)
      ) return;
      setStatusMessage(errorMessage(cause));
    }
  }, [
    activeEditorGroupId,
    activeFile,
    cursorPositions,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    lspDescriptorForFile,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    updateLspStatusForFile,
    workspaceInstanceId,
  ]);
  const activeLanguageId = activeLspState?.status?.languageId ?? null;
  const activeRenderedDocLanguageId = activeLanguageId
    ?? activeFile?.languagePath.split(".").pop()?.toLowerCase()
    ?? null;
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
    setCodeStyleSchemes((current) => {
      const active = activeSchemeForLanguage(current, activeLanguageId || null);
      if (!active || active.id === BUILT_IN_SCHEME_ID) {
        return current;
      }
      const updatedSchemes = current.schemes.map((scheme) => {
        if (scheme.id === active.id) {
          return {
            ...scheme,
            saveActions: {
              ...scheme.saveActions,
              format: enabled,
            },
          };
        }
        return scheme;
      });
      return { ...current, schemes: updatedSchemes };
    });
    setIntelligencePreferences((current) => ({
      ...current,
      formatOnSave: enabled,
    }));
    setStatusMessage(`Format on save ${enabled ? "enabled" : "disabled"} for this workspace`);
  }, [activeLanguageId, setCodeStyleSchemes, setIntelligencePreferences, setStatusMessage]);

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
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
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
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
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
    if (!occurrenceSession) return;
    const currentRev = activeFile ? (lspDocumentEpochRef.current[activeFile.key] ?? 0) : -1;
    if (!activeFile || !isOccurrenceSessionValid(occurrenceSession, activeFile.key, currentRev)) {
      setOccurrenceSession(null);
    }
  }, [activeFile, occurrenceSession]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeInlayHintsEnabled || !activeCapabilities?.inlayHint) {
      setInlayHintsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setInlayHintsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
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
            (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
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
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setSemanticTokensByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
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
            (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
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
        (current[activeEditorGroupId] ?? []).length === 0
          ? current
          : { ...current, [activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    if (!activeLspDocumentIsSynced) {
      setBreadcrumbSymbolsByGroup((current) => (
        (current[activeEditorGroupId] ?? []).length === 0
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
            (current[activeEditorGroupId] ?? []).length === 0
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
      const next = mutateOpenBuffer(
        key,
        {
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
        },
        "reload",
      );
      setFileEncodingDialogOpen(false);
      if (next) {
        setStatusMessage(`Reloaded ${file.subtitle} as ${next.encoding}${next.bom ? " BOM" : ""}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setOpenFiles((current) => ({
        ...current,
        [key]: { ...(current[key] ?? file), loading: false, saving: false, error: message },
      }));
      setStatusMessage(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [activeKey, findRoot, mutateOpenBuffer, setStatusMessage]);

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

  const activeCodeStyle = useMemo(() => getEffectiveCodeStyleForFile(activeFile), [getEffectiveCodeStyleForFile, activeFile]);
  const activeIndentation = activeCodeStyle?.label ?? "Spaces: 2";

  const cycleActiveFileIndentation = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library) return;
    const currentStyle = resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride: indentationOverridesRef.current[key],
    });
    let nextOverride: ExplicitIndentationOverride | null = null;
    if (currentStyle.insertSpaces && currentStyle.indentSize === 2) {
      nextOverride = { type: "spaces", size: 4 };
    } else if (currentStyle.insertSpaces && currentStyle.indentSize === 4) {
      nextOverride = { type: "spaces", size: 8 };
    } else if (currentStyle.insertSpaces && currentStyle.indentSize === 8) {
      nextOverride = { type: "tabs", size: 4 };
    } else if (!currentStyle.insertSpaces && currentStyle.tabSize === 4) {
      nextOverride = { type: "tabs", size: 2 };
    } else if (!currentStyle.insertSpaces && currentStyle.tabSize === 2) {
      nextOverride = null; // reset to auto/default
    } else {
      nextOverride = { type: "spaces", size: 2 };
    }
    setIndentationOverrides((curr) => ({ ...curr, [key]: nextOverride }));
    const nextStyle = resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride: nextOverride,
    });
    setStatusMessage(`${file.subtitle}: code style set to ${nextStyle.label}`);
  }, [activeKey, setStatusMessage]);

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
      indentation: activeIndentation,
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
      fontSize: currentEditorFontSize,
      largeFile: activeFileIsLarge,
    });
  }, [
    activeEditorGroupId,
    activeFile?.bom,
    activeFile?.encoding,
    activeFile?.eol,
    activeFileIsLarge,
    activeGitRoot,
    activeIndentation,
    activeLanguageId,
    activeLspState,
    activeLspProgress,
    activeLspProgressKey,
    clearWorkspaceStatus,
    currentEditorFontSize,
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
      cycleIndentation: activeFile && !activeFile.library ? cycleActiveFileIndentation : undefined,
      cancelLspProgress: activeLspProgress?.cancellable
        ? () => cancelLspProgress(activeLspProgress)
        : undefined,
    });
  }, [
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    cycleActiveFileEol,
    cycleActiveFileIndentation,
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
    // A root reference is enough to prefetch the immutable HEAD blob while
    // the working-tree buffer is loading. Buffer-dependent consumers still
    // gate on `file.loading` before they render or query.
    if (!file || file.ref.kind !== "root") return null;
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

  // §8.17.4 step 1: every chrome consumer derives its per-leaf inputs from
  // the recursive tree's leaves — no `editorGroups.primary/secondary` enum and
  // no two-group swap fallback. A third split leaf gets the same treatment.
  const layoutLeafActiveEntries = useMemo(
    () => getAllLeafNodes(workspaceUi.layoutTreeV2).map((leaf) => ({
      groupId: leaf.id as EditorGroupId,
      activeKey: (editorGroups[leaf.id]?.activeKey ?? leaf.activeKey ?? null) as string | null,
    })),
    [editorGroups, workspaceUi.layoutTreeV2],
  );

  const activeGitFileStateSignature = useMemo(() => {
    const stateForKey = (key: string | null) => {
      if (!key) return "empty";
      const file = openFiles[key];
      if (!file) return "missing";
      return file.loading ? "loading" : "ready";
    };
    return layoutLeafActiveEntries
      .map(({ groupId, activeKey }) => `${groupId}:${activeKey ?? "empty"}:${stateForKey(activeKey)}`)
      .join("|");
  }, [layoutLeafActiveEntries, openFiles]);

  const gitDiffSources = useMemo(() => {
    const seen = new Set<string>();
    return layoutLeafActiveEntries.flatMap(({ activeKey }) => {
      if (!activeKey || seen.has(activeKey)) return [];
      seen.add(activeKey);
      const file = openFiles[activeKey];
      const target = gitTargetForFile(file ?? null);
      const head = gitHeadTextByFile[activeKey];
      // A repository without a HEAD cannot have a comparable line diff. Keep
      // the hook idle until the snapshot exposes a real HEAD and its blob is
      // read, avoiding a throwaway debounce during Git discovery.
      if (!file || file.loading || !target?.headOid || !head || head.sourceKey !== target.sourceKey) return [];
      return [{
        key: activeKey,
        sourceKey: target.sourceKey,
        headText: head.text,
        bufferText: file.text,
      }];
    });
  }, [
    gitHeadTextByFile,
    gitTargetForFile,
    layoutLeafActiveEntries,
    openFiles,
  ]);
  const gitLineChangesByFile = useDeferredGitLineChanges(gitDiffSources);

  useEffect(() => {
    let cancelled = false;
    const activeKeys = new Set(layoutLeafActiveEntries
      .map(({ activeKey }) => activeKey)
      .filter((key): key is string => !!key));
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

  const gitBlameRequestSignature = useMemo(() => (
    layoutLeafActiveEntries.map(({ groupId, activeKey }) => {
      const key = activeKey;
      // Input batching keeps the store snapshot stable during a typing burst,
      // but the ref is updated immediately.  Use it here so inline blame is
      // disabled from the first dirty keystroke rather than one batch later.
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.loading || file.dirty || !target?.headOid) {
        return `${groupId}:${key ?? "empty"}:disabled`;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      return `${groupId}:${key}:${target.sourceKey}:${file.hash}:${line}`;
    }).join("|")
  ), [
    cursorPositions,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
    layoutLeafActiveEntries,
    openFilesRef,
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
    const leafGroupIds: EditorGroupId[] = (() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      return getAllLeafNodes(ui.layoutTreeV2).map((leaf) => leaf.id);
    })();
    const loadForGroup = (groupId: EditorGroupId) => {
      const groupState = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
        .editorGroups[groupId];
      const key = groupState?.activeKey ?? null;
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.loading || file.dirty || !target?.headOid) {
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
    for (const leafId of leafGroupIds) loadForGroup(leafId);
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
    options: { groupId?: EditorGroupId; preview?: boolean; isCurrent?: () => boolean } = {},
  ) => {
    if (options.isCurrent && !options.isCurrent()) return false;
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
    if (options.isCurrent && !options.isCurrent()) return false;
    revealEditorLocation(key, range);
    if (options.isCurrent && !options.isCurrent()) return false;
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
      options: { groupId?: EditorGroupId; preview?: boolean; isCurrent?: () => boolean } = {},
    ) => {
      const openResolvedPath = async (path: string) => {
        if (options.isCurrent && !options.isCurrent()) return false;
        for (const root of rootsRef.current) {
          const relative = relativePathWithinRoot(root.path, path);
          if (relative === null) continue;
          const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relative };
          if (options.isCurrent && !options.isCurrent()) return false;
          suppressNextHistoryRecord();
          await openFile(ref, options);
          if (options.isCurrent && !options.isCurrent()) return false;
          // openFile reports read failures on the buffer instead of throwing.
          if (openFilesRef.current[fileKey(ref)]?.error) return false;
          if (options.isCurrent && !options.isCurrent()) return false;
          revealEditorLocation(fileKey(ref), location.range);
          if (options.isCurrent && !options.isCurrent()) return false;
          recordNavigationLocation(ref, {
            line: location.range.start.line,
            character: location.range.start.character,
          }, { replaceSameFile: false });
          return true;
        }
        const loose = makeLooseFile(path);
        const ref: CodeWorkspaceFileRef = { kind: "loose", id: loose.id, path: loose.path };
        if (options.isCurrent && !options.isCurrent()) return false;
        setLooseFiles((current) => current.some((item) => item.path === loose.path) ? current : [...current, loose]);
        suppressNextHistoryRecord();
        await openFile(ref, options);
        if (options.isCurrent && !options.isCurrent()) return false;
        // openFile reports read failures on the buffer instead of throwing.
        if (openFilesRef.current[fileKey(ref)]?.error) return false;
        if (options.isCurrent && !options.isCurrent()) return false;
        revealEditorLocation(fileKey(ref), location.range);
        if (options.isCurrent && !options.isCurrent()) return false;
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
        if (options.isCurrent && !options.isCurrent()) return false;
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
          diagnostics: result.diagnostics ?? [],
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
          diagnostics: result.diagnostics ?? [],
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
      splitLayoutLeaf(workspaceInstanceId, current.activeEditorGroupId, "vertical");
      const next = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      if (next.activeEditorGroupId !== current.activeEditorGroupId) {
        groupId = next.activeEditorGroupId;
      }
    }
    await openLspLocation(location, { groupId, preview: !options?.split });
  }, [openLspLocation, setStatusMessage, splitLayoutLeaf, workspaceInstanceId]);

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
    setReferenceHistory(referenceInfoController.pushHistory(content));
    setPinnedDocLocked(true);
    setRightPaneTab("documentation");
    setRightPaneOpen(true);
    setQuickDocOpen(false);
  }, [
    referenceInfoController,
    setPinnedDoc,
    setPinnedDocLocked,
    setQuickDocOpen,
    setRightPaneOpen,
    setRightPaneTab,
  ]);

  const openQuickDocumentation = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const position = editorSelectionRef.current.start;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStatusMessage("No documentation available");
      return;
    }
    const requestRevision = file.documentRevision;
    const requestGeneration = lspSessionGeneration();
    const lines = file.text.split("\n");
    const line = lines[position.line] ?? "";
    const left = line.slice(0, position.character);
    const right = line.slice(position.character);
    const start = left.search(/[A-Za-z0-9_$]+$/);
    const endMatch = right.match(/^[A-Za-z0-9_$]*/);
    const from = start >= 0 ? start : position.character;
    const to = position.character + (endMatch?.[0].length ?? 0);
    const word = line.slice(from, to) || file.title;
    // Display-only facts captured while the provider runs; the V3 payload
    // itself stays exactly {markdown, source}.
    let providerLabel = "Language Server";
    let providerUri: string | null = null;
    const outcome = await referenceInfoController.requestTyped({
      kind: "quick-documentation",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
      languageId: descriptor.languageId ?? "plaintext",
      position,
      documentRevision: requestRevision,
      providerGeneration: requestGeneration,
    }, async ({ signal }) => {
      // §8.18.6 provider cancellation: the abort reaches the native layer via
      // a per-file cancel key + monotonic seq so `$/cancelRequest` is sent
      // and the in-flight hover stops racing.
      const cancelKey = `${workspaceInstanceId}|${file.key}`;
      const requestSeq = nextLspRequestSequence();
      const onAbort = () => {
        void lspCancelReferenceRequest(cancelKey, requestSeq).catch(() => 0);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await lspHover(descriptor, position, { cancelKey, requestSeq });
        if (signal.aborted) return null;
        const current = openFilesRef.current[file.key];
        if (
          !current
          || current.documentRevision !== requestRevision
          || lspSessionGeneration() !== requestGeneration
        ) {
          return null;
        }
        updateLspStatusForFile(file, result.status);
        if (!result.contents) return null;
        providerLabel = result.status.displayName ?? "Language Server";
        providerUri = result.status.uri ?? null;
        return {
          state: "payload" as const,
          payload: {
            kind: "quick-documentation" as const,
            markdown: result.contents,
            source: result.range && result.status.uri
              ? {
                  uri: result.status.uri,
                  path: result.status.path ?? null,
                  range: result.range,
                }
              : null,
          },
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
    if (outcome.state !== "ready") {
      if (outcome.state === "unavailable") setStatusMessage("No documentation available");
      else if (outcome.state === "failed") setStatusMessage(outcome.message);
      return;
    }
    const payload = outcome.payload;
    if (payload.kind !== "quick-documentation") return;
    // History only records ready QuickDoc results; failed/unavailable never
    // enter it (§8.20.2).
    const content: QuickDocContent = {
      title: word,
      body: payload.markdown,
      source: providerLabel,
      uri: providerUri,
      sourceLocation: payload.source,
      revision: requestRevision,
      generation: requestGeneration,
    };
    setQuickDocContent(content);
    setReferenceHistory(referenceInfoController.pushHistory(content));
    if (pinnedDoc && !pinnedDocLocked) setPinnedDoc(content);
    if (intelligencePreferences.quickDoc.defaultTarget === "tool-window") {
      setPinnedDoc(content);
      setPinnedDocLocked(false);
      setRightPaneTab("documentation");
      setRightPaneOpen(true);
      setQuickDocOpen(false);
    } else {
      setQuickDocOpen(true);
    }
  }, [
    activeFile,
    intelligencePreferences.quickDoc.defaultTarget,
    lspDescriptorForFile,
    lspSessionGeneration,
    pinnedDoc,
    pinnedDocLocked,
    referenceInfoController,
    setPinnedDoc,
    setPinnedDocLocked,
    setQuickDocContent,
    setQuickDocOpen,
    setRightPaneOpen,
    setRightPaneTab,
    setStatusMessage,
    updateLspStatusForFile,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 Type Info: ready ONLY when a provider hands back typed
   * content (`source:"provider"`). No standard LSP channel exists today and
   * hover markdown must never be converted into a type, so the honest
   * production result is an explicit per-kind unavailable state.
   */
  const runTypeInfo = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    const serverLabel = lspFilesRef.current[file.key]?.status?.displayName ?? "this language server";
    if (!descriptor) {
      setStatusMessage(`Type Info is not provided by ${serverLabel}`);
      return;
    }
    const position = editorSelectionRef.current.start;
    const outcome = await referenceInfoController.requestTyped({
      kind: "type-info",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
      languageId: descriptor.languageId ?? "plaintext",
      position,
      documentRevision: file.documentRevision,
      providerGeneration: lspSessionGeneration(),
    }, async () => ({ state: "unavailable" as const, reason: "provider-no-type-info-channel" }));
    if (outcome.state === "ready" && outcome.payload.kind === "type-info") {
      setStatusMessage(`Type: ${outcome.payload.display}`);
    } else if (outcome.state === "unavailable") {
      setStatusMessage(outcome.reason === "legacy-context-info-not-expression-static-data"
        ? "Legacy context info is not Expression Static Data"
        : `Type Info is not provided by ${serverLabel}`);
    } else if (outcome.state === "failed") {
      setStatusMessage(outcome.message);
    }
  }, [
    activeFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 Expression Static Data: discoverable action; when jdtls/the
   * current provider exposes no static-data channel the result is an explicit
   * provider-unavailable — never local text guessing. Legacy V2 context-info
   * records migrate through migrateLegacyContextInfoRecord inside the
   * controller and surface under the same unavailable umbrella.
   */
  const runExpressionStaticData = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    const serverLabel = lspFilesRef.current[file.key]?.status?.displayName ?? "this language server";
    if (!descriptor) {
      setStatusMessage(`Expression Static Data is not provided by ${serverLabel}`);
      return;
    }
    const position = editorSelectionRef.current.start;
    const outcome = await referenceInfoController.requestTyped({
      kind: "expression-static-data",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
      languageId: descriptor.languageId ?? "plaintext",
      position,
      documentRevision: file.documentRevision,
      providerGeneration: lspSessionGeneration(),
    }, async () => ({ state: "unavailable" as const, reason: "provider-no-static-data-channel" }));
    if (outcome.state === "ready" && outcome.payload.kind === "expression-static-data") {
      const summary = outcome.payload.facts.map((fact) => `${fact.label}: ${fact.value}`).join(" · ");
      setStatusMessage(summary);
    } else if (outcome.state === "unavailable") {
      setStatusMessage(outcome.reason === LEGACY_CONTEXT_INFO_REASON
        ? "Legacy context info records do not carry Expression Static Data"
        : `Expression Static Data is not provided by ${serverLabel}`);
    } else if (outcome.state === "failed") {
      setStatusMessage(outcome.message);
    }
  }, [
    activeFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 External Documentation: enabled only from a real provider URL
   * found in the last READY quick-documentation payload (extracted, never
   * synthesized from the symbol name); https-only policy stays at the service
   * boundary inside the controller.
   */
  const externalDocTargetFromProvider = useCallback((): { url: string; title: string } | null => {
    const last = referenceInfoController.lastReady("quick-documentation");
    if (!last || last.payload.kind !== "quick-documentation") return null;
    const url = extractProviderDocLinks(last.payload.markdown)
      .find((candidate) => validateExternalDocUrl(candidate).kind === "allowed");
    if (!url) return null;
    return { url, title: quickDocContent?.title ?? last.identity.fileKey };
  }, [quickDocContent?.title, referenceInfoController]);

  const runExternalDocumentation = useCallback(async () => {
    const target = externalDocTargetFromProvider();
    const outcome = await referenceInfoController.requestTyped({
      kind: "external-documentation",
      workspaceId: workspaceInstanceId,
      fileKey: activeFile?.key ?? "",
      uri: "",
      languageId: "",
      position: editorSelectionRef.current.start,
      documentRevision: activeFile?.documentRevision ?? 0,
      providerGeneration: lspSessionGeneration(),
    }, async () => {
      if (!target) return { state: "unavailable" as const, reason: "no-provider-url" };
      return {
        state: "payload" as const,
        payload: { kind: "external-documentation" as const, url: target.url, title: target.title },
      };
    });
    if (outcome.state === "ready" && outcome.payload.kind === "external-documentation") {
      const decision = await openExternalDocumentation(outcome.payload.url);
      if (decision.kind !== "allowed") setStatusMessage("The documentation link could not be opened");
      return;
    }
    if (outcome.state === "failed") setStatusMessage(outcome.message);
  }, [
    activeFile?.documentRevision,
    activeFile?.key,
    externalDocTargetFromProvider,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const openReferenceSource = useCallback((content: QuickDocContent) => {
    if (!content.sourceLocation) {
      setStatusMessage("Documentation source unavailable");
      return;
    }
    void openLspLocation(content.sourceLocation);
  }, [openLspLocation, setStatusMessage]);

  const applyReferenceHistorySnapshot = useCallback((snapshot: ReferenceHistorySnapshot) => {
    setReferenceHistory(snapshot);
    if (!snapshot.content) return;
    if (quickDocOpen) setQuickDocContent(snapshot.content);
    if (pinnedDoc) setPinnedDoc(snapshot.content);
  }, [pinnedDoc, quickDocOpen, setPinnedDoc]);

  const referenceHistoryBack = useCallback(() => {
    applyReferenceHistorySnapshot(referenceInfoController.goBack());
  }, [applyReferenceHistorySnapshot, referenceInfoController]);

  const referenceHistoryForward = useCallback(() => {
    applyReferenceHistorySnapshot(referenceInfoController.goForward());
  }, [applyReferenceHistorySnapshot, referenceInfoController]);

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
        // Rename/DeleteFile invalidate in-flight save owners for the removed buffers.
        saveTransactionRegistryRef.current.discardFile(
          workspaceInstanceId,
          file.key,
          `Buffer ${file.subtitle} was removed by a workspace resource operation`,
        );
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
      options: { preserveRemovedBookmarks?: boolean } = {},
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
      const currentBookmarks = bookmarksRef.current;
      let bookmarksChanged = false;
      const nextBookmarks = currentBookmarks.flatMap((bookmark) => {
        const nextKey = transformWorkspaceResourceFileKey(bookmark.fileKey, change);
        if (!nextKey) {
          if (options.preserveRemovedBookmarks || bookmark.state === "missing") return [bookmark];
          bookmarksChanged = true;
          return [{ ...bookmark, state: "missing" as const }];
        }
        if (nextKey === bookmark.fileKey) return [bookmark];
        bookmarksChanged = true;
        const ref = bookmarkRef(bookmark.fileKey);
        const nextRef = ref ? transformWorkspaceResourceFileRef(ref, change) : null;
        const pathLabel = nextRef
          ? fileMeta(nextRef, rootsRef.current, looseFilesRef.current).subtitle
          : bookmark.pathLabel;
        return [{ ...bookmark, fileKey: nextKey, pathLabel, state: "current" as const }];
      });
      if (bookmarksChanged) {
        writeWorkspaceBookmarks(workspaceInstanceId, nextBookmarks);
        replaceBookmarks(nextBookmarks);
      }
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
      commitResourceState(change, currentOpenFiles, nextOpenFiles, [], {
        preserveRemovedBookmarks: true,
      });
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
    replaceBookmarks,
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
    /** Optional refactoring plan with completeness, conflicts, and required groups. */
    plan?: RefactorPlanV3;
  };

  const applyLspWorkspaceEditNow = useCallback(async (
    edit: LspWorkspaceEdit,
    options: WorkspaceEditApplyOptions = {},
  ) => {
    const orderedOperations = workspaceEditOperations(edit);
    const beforeSnapshots = options.recordHistory !== false && orderedOperations.length > 0
      ? await captureWorkspaceEditPathSnapshots(edit)
      : null;
    const beforeBookmarks = beforeSnapshots
      ? captureWorkspaceEditBookmarkSnapshot(beforeSnapshots.map((snapshot) => snapshot.path))
      : null;
    const beforeTabs = beforeSnapshots
      ? captureWorkspaceEditTabSnapshot(beforeSnapshots.map((snapshot) => snapshot.path))
      : null;
    // §8.19.1: the edit actually applied after preview filtering drives any
    // resume slicing — never the pre-confirmation original.
    let resolvedEdit = edit;
    const buildHooks = (allowPreview: boolean): WorkspaceEditApplyHooks => ({
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
      saveOpenBuffer: async (key, nextText) => {
        await saveOpenBufferText(key, nextText);
      },
      readDisk: async (absolutePath) => {
        // Prefer workspace APIs via root-relative path when possible.
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, absolutePath);
          if (rel === null) continue;
          try {
            const disk = await workspaceReadFile(root.path, rel);
            const eol = disk.text.includes("\r\n") ? ("crlf" as const) : disk.text.includes("\r") && !disk.text.includes("\n") ? ("cr" as const) : ("lf" as const);
            return {
              text: disk.text,
              hash: disk.hash,
              encoding: disk.encoding ?? "UTF-8",
              bom: disk.bom ?? false,
              eol,
            };
          } catch {
            return null;
          }
        }
        try {
          const disk = await workspaceReadLooseFile(absolutePath);
          const eol = disk.text.includes("\r\n") ? ("crlf" as const) : disk.text.includes("\r") && !disk.text.includes("\n") ? ("cr" as const) : ("lf" as const);
          return {
            text: disk.text,
            hash: disk.hash,
            encoding: disk.encoding ?? "UTF-8",
            bom: disk.bom ?? false,
            eol,
          };
        } catch {
          return null;
        }
      },
      writeDisk: async (
        absolutePath,
        text,
        expectedHash,
        encoding = "UTF-8",
        bom = false,
        eol?: "lf" | "crlf" | "cr",
      ) => {
        const replayMetadata = replayWorkspaceEncodingRef.current?.get(fsPathComparisonKey(absolutePath));
        // Replay metadata is the authoritative prior state for undo; it wins
        // over applier defaults but both flow through the single policy
        // resolution shared with open-buffer saves (§8.17.1 step 1). The
        // closed-file path goes through the same shared committer as every
        // other write and returns its full typed result (§8.19.1).
        const prepared = buildPreparedSave({
          transactionId: nextSaveTransactionId(),
          workspaceId: workspaceInstanceId,
          fileKey: `closed:${absolutePath}`,
          filePath: absolutePath,
          text,
          bufferRevision: -1,
          styleGeneration: workspaceStyleControllerRef.current.getGeneration(),
          expectedDiskHash: expectedHash ?? null,
          policy: resolveWritePolicy({
            explicit: {
              encoding: replayMetadata?.encoding ?? encoding,
              bom: replayMetadata?.bom ?? bom,
              eol: replayMetadata?.eol ?? eol ?? "lf",
            },
          }),
        });
        return commitClosedFilePreparedSave(prepared);
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
      confirmWorkspaceEdit: allowPreview && options.preview
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
                  plan: options.plan,
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
    let outcomes = await applyWorkspaceEdit(edit, buildHooks(true));
    // §8.19.1: per-operation effect ledger with an explicit resume boundary.
    // A partial run stops at the failed operation; the user may re-run the
    // unapplied suffix, and every remaining text operation re-validates its
    // disk hash / open-buffer version before writing.
    const applyTransactionId = nextSaveTransactionId("tx-wedit");
    const historySafePaths = new Set(
      (beforeSnapshots ?? [])
        .filter((snapshot) => snapshot.exists && snapshot.text !== null)
        .map((snapshot) => fsPathComparisonKey(snapshot.path)),
    );
    const buildApplyResult = (runs: WorkspaceEditApplyOutcome[]) => buildWorkspaceEditApplyResultV2({
      transactionId: applyTransactionId,
      operations: workspaceEditOperations(resolvedEdit),
      outcomes: runs,
      undoAvailability: beforeSnapshots
        ? (_index, _kind, targetPath) => historySafePaths.has(fsPathComparisonKey(targetPath)) ? "available" : "unavailable"
        : undefined,
    });
    {
      const applyResult = buildApplyResult(outcomes);
      if (
        applyResult.disposition === "partial"
        && applyResult.nextOperationIndex !== null
        && options.recordHistory !== false
      ) {
        // Bounded resume loop; each pass re-applies only the unapplied suffix.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const totalCount = workspaceEditOperations(resolvedEdit).length;
          const resume = await confirmAppDialog({
            title: "Workspace edit partially applied",
            message: `${applyResult.nextOperationIndex} of ${totalCount} changes were applied. `
              + `Retry the remaining ${totalCount - applyResult.nextOperationIndex} from the failed boundary?`,
            confirmLabel: "Retry remaining changes",
          });
          if (!resume) break;
          resolvedEdit = sliceWorkspaceEditForResume(resolvedEdit, applyResult.nextOperationIndex);
          outcomes = await applyWorkspaceEdit(resolvedEdit, buildHooks(false));
          const nextResult = buildApplyResult(outcomes);
          if (nextResult.disposition !== "partial" || nextResult.nextOperationIndex === null) break;
        }
      }
    }
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
      const afterBookmarks = afterSnapshots
        ? captureWorkspaceEditBookmarkSnapshot(afterSnapshots.map((snapshot) => snapshot.path))
        : null;
      const changed = afterSnapshots?.some((snapshot, index) => (
        snapshot.path !== beforeSnapshots[index]?.path
        || snapshot.exists !== beforeSnapshots[index]?.exists
        || snapshot.text !== beforeSnapshots[index]?.text
        || snapshot.encoding !== beforeSnapshots[index]?.encoding
        || snapshot.bom !== beforeSnapshots[index]?.bom
      ));
      if (afterSnapshots && changed) {
        const affectedBookmarkIds = Array.from(new Set([
          ...(beforeBookmarks ?? []).map((bookmark) => bookmark.id),
          ...(afterBookmarks ?? []).map((bookmark) => bookmark.id),
        ]));
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
            restoreWorkspaceBookmarkSnapshot(beforeBookmarks ?? [], affectedBookmarkIds);
            if (beforeTabs) await restoreWorkspaceEditTabs(beforeTabs);
          },
          redo: async () => {
            await replayWorkspacePathSnapshotsRef.current(afterSnapshots);
            restoreWorkspaceBookmarkSnapshot(afterBookmarks ?? [], affectedBookmarkIds);
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
    captureWorkspaceEditBookmarkSnapshot,
    captureWorkspaceEditPathSnapshots,
    captureWorkspaceEditTabSnapshot,
    commitClosedFilePreparedSave,
    formatWorkspaceEditPreview,
    isLspDocumentSynced,
    lspDocumentVersion,
    refreshTree,
    saveOpenBufferText,
    setStatusMessage,
    restoreWorkspaceEditTabs,
    restoreWorkspaceBookmarkSnapshot,
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
          {
            encoding: snapshot.encoding ?? "UTF-8",
            bom: snapshot.bom ?? false,
            eol: snapshot.eol,
          },
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
      const context: CodeActionContextIdentity = {
        document: {
          uri: descriptor.documentUri ?? lspFilesRef.current[live.key]?.status?.uri ?? descriptor.filePath ?? live.key,
          revision: live.documentRevision,
          languageId: lspFilesRef.current[live.key]?.status?.languageId ?? descriptor.languageId ?? "plaintext",
        },
        provider: {
          id: descriptor.languageId === "java" || !descriptor.languageId ? "jdtls" : descriptor.languageId,
          version: null,
          generation: lspSessionGeneration(),
          projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
          trusted: true,
        },
        range,
        diagnostics,
        only: only.length > 0 ? only : undefined,
      };

      const client: CodeActionProviderClient = {
        requestCodeActions: async (params) => {
          const result = await lspCodeActions(
            descriptor,
            params.range,
            params.context.diagnostics.map((item) => ({
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
            params.context.only ? [...params.context.only] : undefined,
          );
          updateLspStatusForFile(live, result.status);
          return result.actions;
        },
      };

      const serviceRes = await canonicalCodeActionServiceRef.current!.requestCandidates(context, client);
      const rawActions: LspCodeAction[] = serviceRes.state === "ready"
        ? serviceRes.actions.map((pa) => pa.action)
        : [];

      const completion = semanticIndex.finishQuery(buildToken, {
        kind: semanticQuery ? "refactor" : "code-action",
        resultCount: rawActions.length,
      });
      return completion.accepted
        ? { actions: rawActions, semanticToken: buildToken }
        : { actions: [], semanticToken: null };
    } catch (error) {
      semanticIndex.failBuild(buildToken, errorMessage(error));
      return { actions: [], semanticToken: null };
    }
  }, [
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    semanticIndex.beginBuild,
    semanticIndex.current,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    setStatusMessage,
    updateLspStatusForFile,
  ]);

  // §8.20.4 W3: ONE frozen Intention session per request, shared by Alt+Enter,
  // the gutter bulb, Problems quick fix and Search Actions. Candidates carry
  // stable ids; resolve state and disabled reasons live here, not in UI copies.
  const intentionSessionRef = useRef<IntentionSession | null>(null);
  if (!intentionSessionRef.current) intentionSessionRef.current = new IntentionSession();
  const canonicalCodeActionServiceRef = useRef<CanonicalCodeActionService | null>(null);
  if (!canonicalCodeActionServiceRef.current) canonicalCodeActionServiceRef.current = new CanonicalCodeActionService();
  useEffect(() => () => intentionSessionRef.current?.dispose(), []);
  // Diagnostics whose provider suppression edit applied successfully
  // ("Suppressed in source"); distinct from local hide (profile suppressions).
  const [suppressedInSourceKeys, setSuppressedInSourceKeys] = useState<Set<string>>(new Set());
  const markProviderSuppressionApplied = useCallback((action: LspCodeAction, file: OpenFileState) => {
    if (!/suppress/i.test(`${action.kind ?? ""} ${action.title}`)) return;
    const path = inspectionPathForFileKey(file.key);
    const diagnostics = lspFilesRef.current[file.key]?.diagnostics ?? [];
    setSuppressedInSourceKeys((current) => {
      const next = new Set(current);
      for (const diagnostic of diagnostics) {
        next.add(`${path}:${diagnosticInspectionId(diagnostic)}:${diagnostic.range.start.line}`);
      }
      return next;
    });
    setStatusMessage("Suppressed in source by the language server");
  }, [inspectionPathForFileKey, setStatusMessage]);

  const runCodeAction = useCallback(async (
    action: LspCodeAction,
    file: OpenFileState,
    semanticToken: WorkspaceSemanticIndexBuildToken | null = null,
    intentionCandidateId?: string,
  ) => {
    // §8.20.4 W3: resolve state lives on the frozen Intention session keyed
    // by stable candidate id; a timeout/failed resolve KEEPS the candidates.
    const markIntentionResolve = (state: "resolving" | "resolved" | "failed", message?: string) => {
      if (!intentionCandidateId) return;
      const session = intentionSessionRef.current;
      if (!session) return;
      if (state === "resolving") session.markResolving(intentionCandidateId);
      else if (state === "resolved") session.markResolved(intentionCandidateId);
      else session.markFailed(intentionCandidateId, message ?? "resolve failed");
    };
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
          markIntentionResolve("resolving");
          const candidate = intentionCandidateId
            ? intentionSessionRef.current?.getCandidate(intentionCandidateId)
            : null;
          const context: CodeActionContextIdentity = {
            document: {
              uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath ?? file.key,
              revision: file.documentRevision,
              languageId: lspFilesRef.current[file.key]?.status?.languageId ?? descriptor.languageId ?? "plaintext",
            },
            provider: {
              id: descriptor.languageId === "java" || !descriptor.languageId ? "jdtls" : descriptor.languageId,
              version: null,
              generation: lspSessionGeneration(),
              projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
              trusted: true,
            },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            diagnostics: [],
          };
          const client: CodeActionProviderClient = {
            requestCodeActions: async () => [action],
            resolveCodeAction: async (act) => {
              if (!descriptor || !act.raw) return null;
              const res = await lspCodeActionResolve(descriptor, act.raw);
              updateLspStatusForFile(file, res.status);
              return res.action;
            },
          };

          if (candidate) {
            const resolveOutcome = await canonicalCodeActionServiceRef.current!.resolvePlan(
              { ...candidate, rawAction: action },
              context,
              client,
              file.documentRevision,
              lspSessionGeneration(),
              { timeoutMs: INTENTION_RESOLVE_TIMEOUT_MS },
            );
            if (resolveOutcome.state === "stale") {
              markIntentionResolve("failed", resolveOutcome.reason);
              const message = `Code action became stale: ${resolveOutcome.reason}`;
              setStatusMessage(message);
              return { ok: false, message };
            }
            if (resolveOutcome.state === "rejected") {
              markIntentionResolve("failed", `Rejected: ${resolveOutcome.reason}`);
              const message = `Code action rejected: ${resolveOutcome.reason}`;
              setStatusMessage(message);
              return { ok: false, message };
            }
            if (resolveOutcome.state === "unresolved") {
              const message = `Code action resolve failed: ${resolveOutcome.reason} — you can retry`;
              markIntentionResolve("failed", resolveOutcome.reason);
              setStatusMessage(message);
            } else if (resolveOutcome.state === "resolved") {
              markIntentionResolve("resolved");
              executableAction = {
                ...action,
                title: resolveOutcome.plan.title,
                kind: resolveOutcome.plan.kind,
                edit: resolveOutcome.plan.edit,
                command: resolveOutcome.plan.command?.command ?? null,
                commandArguments: resolveOutcome.plan.command?.arguments ?? null,
              };
            }
          } else {
            try {
              // §8.20.4: resolve timeout keeps the frozen candidates and marks
              // the failure retryable instead of dropping the popup's options.
              const resolved = await Promise.race([
                lspCodeActionResolve(descriptor, raw),
                new Promise<never>((_, rejectTimeout) => window.setTimeout(
                  () => rejectTimeout(new Error(`resolve timed out after ${INTENTION_RESOLVE_TIMEOUT_MS}ms`)),
                  INTENTION_RESOLVE_TIMEOUT_MS,
                )),
              ]);
              updateLspStatusForFile(file, resolved.status);
              if (resolved.action) executableAction = resolved.action;
              markIntentionResolve("resolved");
            } catch (error) {
              // A server may advertise data but not implement resolve. Keep the
              // original action usable and make the fallback + Retry visible.
              const message = `Code action resolve failed: ${errorMessage(error)} — you can retry`;
              markIntentionResolve("failed", errorMessage(error));
              setStatusMessage(message);
            }
          }
        }
      }
      assertSemanticCurrent();
      let semanticEditApplied = false;
      let semanticCommandRevision: number | null = null;
      const fileDescriptor = lspDescriptorForFile(file);
      const result = await executeCodeAction(
        executableAction,
        {
          languageId: fileDescriptor?.languageId ?? "java",
          resolveAction: async (act) => {
            if (!fileDescriptor || !act.raw) return null;
            const res = await lspCodeActionResolve(fileDescriptor, act.raw);
            return res.action;
          },
          applyEdit: async (edit) => {
            let plan: RefactorPlanV3 | undefined;
            const isRefactorAction =
              executableAction.kind?.startsWith("refactor") ||
              executableAction.title.toLowerCase().includes("refactor");
          if (isRefactorAction) {
            const kindStr = executableAction.kind ?? "";
            const refactorKind = kindStr.includes("extract")
              ? "extract"
              : kindStr.includes("inline")
              ? "inline"
              : kindStr.includes("change-signature")
              ? "change-signature"
              : kindStr.includes("move")
              ? "move"
              : "other";
            const fileDescriptor = lspDescriptorForFile(file);
            const docUri = fileDescriptor?.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? fileDescriptor?.filePath ?? file.path;
            const evidence = buildCapabilityEvidence({
              capabilityId: `refactor.action:${executableAction.kind ?? "custom"}`,
              languageId: fileDescriptor?.languageId ?? "java",
              provider: {
                id: fileDescriptor?.languageId ?? "jdtls",
                version: null,
                generation: semanticToken?.generation ?? lspSessionGeneration(),
              },
              projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
              uri: docUri,
              revision: file.documentRevision ?? 0,
              scope: "project",
              complete: false,
              reason: "provider code action edit",
            });
            plan = buildRefactorPlan({
              actionId: intentionCandidateId ?? executableAction.title,
              kind: refactorKind,
              evidence,
              edit,
              roots: rootsRef.current,
              completeness: {
                value: "partial",
                source: "protocol-bounded",
                proof: "provider code action edit",
              },
            });
            const gate = refactorApplyGate(plan);
            if (!gate.allowed) {
              setStatusMessage(`Refactoring blocked: ${gate.reason}`);
              return [
                {
                  operationIndex: null,
                  path: file.path,
                  status: "failed",
                  reason: gate.reason || "blocked by refactor gate",
                },
              ];
            }
            if (gate.requiresConfirm) {
              const confirmed = await confirmAppDialog({
                title: "Refactoring Warning",
                message: gate.reason ?? "This refactoring produced warnings. Proceed?",
                confirmLabel: "Proceed",
              });
              if (!confirmed) {
                setStatusMessage("Refactoring cancelled");
                return [
                  {
                    operationIndex: null,
                    path: file.path,
                    status: "skipped",
                    reason: "cancelled by user",
                  },
                ];
              }
            }
          }
          const outcomes = await applyLspWorkspaceEdit(edit, {
            // The applier only opens the dialog for multi-file/resource edits;
            // single-file quick fixes remain an immediate action.
            preview: true,
            label: executableAction.title,
            semanticGeneration: semanticToken?.generation,
            semanticRevision: semanticToken?.revision,
            plan,
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
      }, () => {
        if (
          semanticToken
          && !workspaceSemanticIndexBuildIsCurrent(semanticIndex.current(), semanticToken)
        ) {
          return { valid: false, reason: "Refactor result became stale because the workspace changed" };
        }
        return { valid: true };
      });
      if (result.status === "executed-command") {
        markProviderSuppressionApplied(action, file);
        setStatusMessage(`Executed code action: ${executableAction.title}`);
        return { ok: true, message: null };
      } else if (result.status === "empty") {
        const message = "Code action had no edit or command to apply";
        setStatusMessage(message);
        return { ok: false, message };
      }
      if (result.status === "applied-edit") {
        // §8.20.4 naming rule: a provider suppression edit that applied
        // successfully earns "Suppressed in source"; everything else stays
        // "hidden locally".
        markProviderSuppressionApplied(action, file);
      }
      return { ok: true, message: null };
    } catch (error) {
      const message = errorMessage(error);
      setStatusMessage(message);
      return { ok: false, message };
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

  // §8.19.8 Generate Code: request provider source/generate CodeActions for
  // the caret, list exactly what came back, and apply the selection through
  // the existing runCodeAction pipeline (resolve → WorkspaceEdit/command with
  // semantic staleness guards). No local member templates exist anywhere.
  const requestGenerateCandidates = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading || file.library) {
      setStatusMessage("Generate requires an active workspace file");
      setGenerateCode((prev) => ({ ...prev, phase: "empty" }));
      return;
    }
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    setGenerateCode((prev) => ({ ...prev, open: true, phase: "loading", error: null }));
    const requested = await requestCodeActions(file, range, [], ["source"]);
    if (
      requested.semanticToken
      && !workspaceSemanticIndexBuildIsCurrent(semanticIndex.current(), requested.semanticToken)
    ) {
      setGenerateCode({ open: true, phase: "error", candidates: [], error: "Generation actions became stale because the workspace changed; retry to request them again" });
      generateCodeContextRef.current = null;
      return;
    }
    const filtered = filterGenerateCodeActions(requested.actions);
    if (filtered.length === 0) {
      generateCodeContextRef.current = null;
      setGenerateCode({ open: true, phase: "empty", candidates: [], error: null });
      return;
    }
    generateCodeContextRef.current = {
      file,
      range,
      semanticToken: requested.semanticToken,
      actions: filtered.map((entry) => entry.item),
    };
    setGenerateCode({
      open: true,
      phase: "ready",
      candidates: filtered.map((entry, index) => ({
        id: String(index),
        title: entry.title,
        kind: entry.kind,
      })),
      error: null,
    });
  }, [activeFile, requestCodeActions, semanticIndex.current, setStatusMessage]);

  const closeGenerateDialog = useCallback(() => {
    generateCodeContextRef.current = null;
    setGenerateCode((prev) => ({ ...prev, open: false }));
  }, []);

  const applyGenerateCandidates = useCallback(async (ids: readonly string[]) => {
    const context = generateCodeContextRef.current;
    if (!context) return;
    // Only ids that still map onto the captured provider actions.
    const selection: GenerateCandidate[] = ids.flatMap((id) => {
      const action = context.actions[Number(id)];
      return action ? [{ id, title: action.title, kind: action.kind ?? "" }] : [];
    });
    if (selection.length === 0) return;
    setGenerateCode((prev) => ({ ...prev, phase: "running", error: null }));
    const outcome = await applyGenerateSelection(selection, {
      actionFor: (candidate) => context.actions[Number(candidate.id)],
      isStale: () => !!context.semanticToken
        && !workspaceSemanticIndexBuildIsCurrent(semanticIndex.current(), context.semanticToken!),
      run: (action) => runCodeAction(action, context.file, context.semanticToken),
    });
    if (outcome.failedIndex != null) {
      // §8.19.8: resolve/apply failure keeps the dialog on Retry/Cancel and
      // never falls back to inserting a fixed template.
      setGenerateCode((prev) => ({
        ...prev,
        phase: "error",
        error: outcome.message ?? "Generation failed",
      }));
      return;
    }
    setStatusMessage(`Generated via ${outcome.applied} language-server action${outcome.applied === 1 ? "" : "s"}`);
    closeGenerateDialog();
  }, [closeGenerateDialog, runCodeAction, semanticIndex.current, setStatusMessage]);

  // §8.19.5 Copy Reference: workspace-relative `path:line` from real file
  // facts, plus a symbol candidate only when the provider names one via its
  // rename range. Qualified names are never synthesized — without a
  // provider channel they stay an explicit unavailable reason.
  const copyReferenceAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const path = absolutePathForOpenFile(file);
    const outcome = copyReferenceCandidates({
      path,
      isLibrary: !!file.library,
      roots: rootsRef.current.map((root) => root.path),
      line: editorSelectionRef.current.start.line,
      symbolName: null,
    });
    if (outcome.kind === "unavailable") {
      setStatusMessage(`Copy Reference unavailable (${outcome.reason}): ${outcome.detail}`);
      return;
    }
    // Best-effort provider symbol identity; failure degrades to path-only
    // rather than blocking the copy.
    let symbolName: string | null = null;
    if (!file.library) {
      try {
        const live = openFilesRef.current[file.key];
        const descriptor = live ? lspDescriptorForFile(live) : null;
        if (descriptor) {
          const position = editorSelectionRef.current.start;
          const prepared = await lspPrepareRename(descriptor, position);
          const range = prepared.range ?? null;
          const lineText = live?.text.split("\n")[position.line] ?? "";
          symbolName = (range && range.start.line === range.end.line
            ? lineText.slice(range.start.character, range.end.character).trim()
            : "")
            || lineText.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0]
            || null;
        }
      } catch {
        symbolName = null;
      }
    }
    const final = symbolName
      ? copyReferenceCandidates({
        path,
        isLibrary: !!file.library,
        roots: rootsRef.current.map((root) => root.path),
        line: editorSelectionRef.current.start.line,
        symbolName,
      })
      : outcome;
    if (final.kind === "unavailable") {
      setStatusMessage(`Copy Reference unavailable (${final.reason}): ${final.detail}`);
      return;
    }
    if (final.candidates.length === 1) {
      await writeText(final.candidates[0].text);
      setStatusMessage(`Copied reference: ${final.candidates[0].text}`);
      return;
    }
    const rect = editorPaneRef.current?.getBoundingClientRect();
    openTreeContextMenuAt(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      final.candidates.map((candidate) => ({
        label: `${candidate.label}: ${candidate.text}`,
        onClick: () => {
          void writeText(candidate.text).then(() => {
            setStatusMessage(`Copied reference: ${candidate.text}`);
          });
        },
      })),
    );
  }, [
    absolutePathForOpenFile,
    activeFile,
    lspDescriptorForFile,
    openTreeContextMenuAt,
    setStatusMessage,
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
    const actions = [...requested.actions];

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
    // §8.20.4 W3: freeze the candidate list into the shared Intention session
    // with per-candidate evidence; the menu renders the frozen snapshot so all
    // entry points see identical ids, resolve states and disabled reasons.
    const descriptor = lspDescriptorForFile(file);
    const evidence = buildCapabilityEvidence({
      capabilityId: "codeAction.intention",
      languageId: lspFilesRef.current[file.key]?.status?.languageId ?? descriptor?.languageId ?? "plaintext",
      provider: { id: "jdtls", version: null, generation: lspSessionGeneration() },
      projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
      uri: descriptor?.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor?.filePath ?? file.key,
      revision: file.documentRevision,
      scope: "document",
    });
    const intentionSnapshot = intentionSessionRef.current!.open(
      sorted.map((action) => candidateFromProviderAction(action, evidence)),
      {
        fileKey: file.key,
        uri: evidence.document.uri,
        documentRevision: file.documentRevision,
        providerGeneration: lspSessionGeneration(),
        projectFingerprint: evidence.projectFingerprint,
      },
    );
    // Grouped rendering: provider candidates first, then local editor actions
    // (none registered in this funnel yet — the group renders only when present).
    // Candidates were built 1:1 over `sorted`, so index maps back to the action.
    const menuItems: MenuItem[] = [];
    const candidateIndexById = new Map<string, number>();
    sorted.forEach((_action, index) => {
      const candidate = intentionSnapshot.candidates[index];
      if (candidate && !candidateIndexById.has(candidate.id)) {
        candidateIndexById.set(candidate.id, index);
      }
    });
    for (const group of intentionSnapshot.groups) {
      menuItems.push({ label: group.label, disabled: true });
      for (const candidate of group.candidates) {
        const actionIndex = candidateIndexById.get(candidate.id);
        const action = actionIndex !== undefined ? sorted[actionIndex] : undefined;
        if (!action) continue;
        menuItems.push({
          label: candidate.disabledReason
            ? `${candidate.title} (${candidate.disabledReason})`
            : candidate.title,
          disabled: candidate.disabledReason !== null,
          onClick: () => void runCodeAction(
            action,
            file,
            requested.semanticToken,
            candidate.id,
          ),
        });
      }
      if (group.source === "provider-code-action" && intentionSnapshot.groups.length > 1) {
        menuItems.push({ label: "", separator: true });
      }
    }
    openTreeContextMenuAt(clientX, clientY, menuItems);
  }, [
    lspDescriptorForFile,
    lspSessionGeneration,
    openTreeContextMenuAt,
    projectAnalysisSnapshot?.projectFingerprint,
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
    const line = range.start.line;
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
      item.range.start.line <= line && item.range.end.line >= line
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
      (item) => item.range.start.line <= line && item.range.end.line >= line,
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
      if (existing.loading || existing.error) return false;
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
        const opened = openFilesRef.current[key];
        return !!opened && !opened.loading && !opened.error;
      }
    }
    if (key.startsWith("loose:")) {
      const id = key.slice("loose:".length);
      const loose = looseFilesRef.current.find((item) => item.id === id);
      if (loose) {
        await openFile({ kind: "loose", id: loose.id, path: loose.path });
        const opened = openFilesRef.current[key];
        return !!opened && !opened.loading && !opened.error;
      }
    }
    return false;
  }, [activeEditorGroupId, openFile, updateEditorGroup]);

  const openTodoOrBookmark = useCallback(async (
    item: {
      fileKey: string;
      pathLabel?: string;
      line: number;
      character: number;
      state?: WorkspaceBookmark["state"];
    },
  ): Promise<boolean> => {
    if (item.state === "missing") {
      setStatusMessage(`Bookmark target is missing: ${item.pathLabel ?? item.fileKey}`);
      return false;
    }
    const origin = activeKey ? openFilesRef.current[activeKey] : null;
    if (origin) {
      recordNavigationLocation(origin.ref, editorSelectionRef.current.end);
    }
    if (item.fileKey !== activeKey) suppressNextHistoryRecord();
    if (!await openFileByKey(item.fileKey)) {
      setStatusMessage(`Cannot open bookmark target: ${item.pathLabel ?? item.fileKey}`);
      return false;
    }
    const target = openFilesRef.current[item.fileKey];
    if (!target || target.loading || target.error) {
      setStatusMessage(`Cannot open bookmark target: ${item.pathLabel ?? item.fileKey}`);
      return false;
    }
    const position = { line: item.line, character: item.character };
    revealEditorLocation(item.fileKey, {
      start: position,
      end: position,
    });
    recordNavigationLocation(target.ref, position, { replaceSameFile: false });
    return true;
  }, [activeKey, openFileByKey, recordNavigationLocation, revealEditorLocation, setStatusMessage, suppressNextHistoryRecord]);

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
    replaceBookmarks(next);
    setStatusMessage(next.some((item) => item.fileKey === file.key && item.line === position.line)
      ? `Bookmarked line ${position.line + 1}`
      : `Removed bookmark on line ${position.line + 1}`);
    openTodosPane();
  }, [activeKey, bookmarks, openTodosPane, replaceBookmarks, setStatusMessage, workspaceInstanceId]);

  const removeBookmark = useCallback((id: string) => {
    const next = bookmarksRef.current.filter((item) => item.id !== id);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);

  const renameBookmarkGroup = useCallback((oldGroupName: string, newGroupName: string) => {
    const current = bookmarksRef.current;
    const next = renameWorkspaceBookmarkGroup(
      workspaceInstanceId,
      oldGroupName,
      newGroupName,
      current,
    );
    if (next === current) return;
    replaceBookmarks(next);
    setStatusMessage(`Renamed bookmark group to ${newGroupName.trim()}`);
  }, [replaceBookmarks, setStatusMessage, workspaceInstanceId]);

  const jumpToMnemonicBookmark = useCallback((mnemonic: string) => {
    const target = findBookmarkByMnemonic(bookmarks, mnemonic);
    if (!target) {
      setStatusMessage(`No bookmark with mnemonic '${mnemonic}' found`);
      return;
    }
    void openTodoOrBookmark(target).then((opened) => {
      if (opened) setStatusMessage(`Jumped to bookmark [${target.mnemonic}] on line ${target.line + 1}`);
    });
  }, [bookmarks, openTodoOrBookmark, setStatusMessage]);

  const setMnemonicBookmarkAtCursor = useCallback((mnemonic: string) => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file) {
      setStatusMessage("Open a file to toggle mnemonic bookmarks");
      return;
    }
    const position = editorSelectionRef.current.end;
    const lineText = file.text.split("\n")[position.line] ?? "";
    const label = lineText.trim() || `${file.title}:${position.line + 1}`;
    const next = setMnemonicBookmark(
      workspaceInstanceId,
      {
        fileKey: file.key,
        pathLabel: file.subtitle || file.path,
        line: position.line,
        character: position.character,
        label,
        mnemonic,
      },
      bookmarks,
    );
    replaceBookmarks(next);
    const setOnLine = next.some(
      (item) => item.fileKey === file.key && item.line === position.line && item.mnemonic === mnemonic,
    );
    setStatusMessage(
      setOnLine
        ? `Set bookmark [${mnemonic}] on line ${position.line + 1}`
        : `Removed bookmark on line ${position.line + 1}`,
    );
    openTodosPane();
  }, [activeKey, bookmarks, openTodosPane, replaceBookmarks, setStatusMessage, workspaceInstanceId]);

  const chooseMnemonicBookmarkAtCursor = useCallback(async () => {
    const selected = await promptAppDialog({
      title: "Set Bookmark Mnemonic",
      label: "Mnemonic (0-9 or A-Z)",
      placeholder: "A",
      confirmLabel: "Set Bookmark",
    });
    if (selected === null) return;
    const trimmed = selected.trim();
    if (!isValidMnemonic(trimmed)) {
      setStatusMessage("Bookmark mnemonic must be exactly one letter or digit");
      return;
    }
    setMnemonicBookmarkAtCursor(normalizeMnemonic(trimmed));
  }, [setMnemonicBookmarkAtCursor, setStatusMessage]);

  const activateNavigationBar = useCallback(() => {
    setNavigationBarActiveByGroup((prev) => ({
      ...prev,
      [activeEditorGroupId]: true,
    }));
  }, [activeEditorGroupId]);

  const highlightUsagesInFile = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const position = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const descriptor = lspDescriptorForFile(file);
    const rev = lspDocumentEpochRef.current[file.key] ?? 0;
    const lines = file.text.split("\n");
    let offset = 0;
    for (let l = 0; l < Math.min(position.line, lines.length); l += 1) {
      offset += lines[l].length + 1;
    }
    offset += Math.min(position.character, lines[position.line]?.length ?? 0);
    const token = wordAt(file.text, offset);
    const word = token?.word || "symbol";

    let highlights: LspDocumentHighlight[] = [];
    if (activeCapabilities?.documentHighlight && descriptor && activeLspDocumentIsSynced) {
      try {
        const result = await lspDocumentHighlights(descriptor, position);
        highlights = result.highlights;
      } catch {
        highlights = fallbackWordHighlights(file.text, position);
      }
    } else {
      highlights = fallbackWordHighlights(file.text, position);
    }

    if (highlights.length === 0) {
      setStatusMessage(`No occurrences found for "${word}"`);
      setOccurrenceSession(null);
      return;
    }

    const session = createOccurrenceSession(file.key, rev, word, highlights, position);
    setOccurrenceSession(session);
    setHighlightsByGroup((current) => ({
      ...current,
      [activeEditorGroupId]: highlights,
    }));
    setStatusMessage(formatOccurrenceStatus(session));
  }, [
    activeCapabilities?.documentHighlight,
    activeEditorGroupId,
    activeFile,
    activeLspDocumentIsSynced,
    cursorPositions,
    lspDescriptorForFile,
    setStatusMessage,
  ]);

  const navigateOccurrence = useCallback((direction: "next" | "previous") => {
    if (!occurrenceSession || !activeFile || occurrenceSession.fileKey !== activeFile.key) {
      setStatusMessage("No active occurrence highlight session");
      return;
    }
    const { session: nextSession, current } = stepOccurrence(occurrenceSession, direction);
    setOccurrenceSession(nextSession);
    if (current) {
      revealEditorLocation(activeFile.key, current.range);
    }
    setStatusMessage(formatOccurrenceStatus(nextSession));
  }, [activeFile, occurrenceSession, revealEditorLocation, setStatusMessage]);

  const clearHighlightUsages = useCallback(() => {
    if (!occurrenceSession) return false;
    setOccurrenceSession(null);
    setHighlightsByGroup((current) => ({
      ...current,
      [activeEditorGroupId]: [],
    }));
    setStatusMessage("Occurrence highlights cleared");
    return true;
  }, [activeEditorGroupId, occurrenceSession, setStatusMessage]);

  const compareWithClipboard = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const selection = compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = compareTargetForOpenFile(file, selection);
    const rightDescriptor = {
      ...compareDescriptorForOpenFile(file, "buffer", file.path, rightText, rightTitle),
      readOnly: !!file.library,
    };
    try {
      const clipboard = await readTextResult();
      if (!clipboard.ok) {
        setActiveCompareSession(createUnavailableCompareSession({
          source: "clipboard",
          title: `Compare ${rightTitle} with Clipboard`,
          unavailableTitle: "Clipboard",
          reason: "read-failed",
          message: "The system clipboard could not be read.",
          right: rightDescriptor,
          target,
        }));
        return;
      }
      const result = createClipboardCompareSession(
        file.title,
        file.path,
        file.text,
        clipboard.text,
        selection,
        target,
      );
      if (!result.session) {
        const unavailable = classifyCompareReadError(result.error || "Clipboard is unavailable");
        setActiveCompareSession(createUnavailableCompareSession({
          source: "clipboard",
          title: `Compare ${rightTitle} with Clipboard`,
          unavailableTitle: "Clipboard",
          reason: unavailable.reason,
          message: unavailable.message,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      setActiveCompareSession(result.session);
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "clipboard",
        title: `Compare ${rightTitle} with Clipboard`,
        unavailableTitle: "Clipboard",
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  }, [activeFile]);

  const compareWithFile = useCallback(async () => {
    const file = activeFile;
    if (!file || file.library) return;
    const selection = compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = compareTargetForOpenFile(file, selection);
    const activePath = absolutePathForOpenFile(file) ?? file.path;
    const rightDescriptor = compareDescriptorForOpenFile(file, "buffer", activePath, rightText, rightTitle);
    const selectedPath = await selectFilePath();
    if (!selectedPath) {
      setStatusMessage("Compare with file cancelled");
      return;
    }

    const normalizedPath = normalizeFsPath(selectedPath);
    const root = rootsRef.current.find((candidate) => (
      relativePathWithinRoot(candidate.path, normalizedPath) !== null
    ));
    const title = normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;
    try {
      const selected = root
        ? await workspaceReadFile(
          root.path,
          relativePathWithinRoot(root.path, normalizedPath) ?? "",
          MAX_COMPARE_SIZE_BYTES + 1,
        )
        : await workspaceReadLooseFile(normalizedPath, MAX_COMPARE_SIZE_BYTES + 1);
      const result = createFileCompareSession(
        {
          title,
          path: normalizedPath,
          text: selected.text,
          encoding: selected.encoding ?? "UTF-8",
          bom: selected.bom ?? false,
          sizeBytes: selected.size,
          source: "file",
          readOnly: true,
        },
        rightDescriptor,
        target,
      );
      if (!result.session) {
        const unavailable = classifyCompareReadError(result.error || "Selected file is unavailable");
        setActiveCompareSession(createUnavailableCompareSession({
          source: "file",
          title: `Compare ${rightTitle} with ${title}`,
          unavailableTitle: title,
          reason: unavailable.reason,
          message: unavailable.message,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      setActiveCompareSession(result.session);
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "file",
        title: `Compare ${rightTitle} with ${title}`,
        unavailableTitle: title,
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  }, [absolutePathForOpenFile, activeFile, setStatusMessage]);

  const compareWithLocalHistory = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const path = absolutePathForOpenFile(file);
    if (!path) {
      setStatusMessage(file.library
        ? `${file.title} is a library source with no local history`
        : "Cannot resolve path for local history");
      return;
    }
    const selection = compareSelectionFromEditorSelection(editorSelectionRef.current);
    const target = compareTargetForOpenFile(file, selection);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const rightDescriptor = compareDescriptorForOpenFile(file, "buffer", path, rightText, rightTitle);
    try {
      const entries = await historyList(path);
      const entry = entries[0];
      if (!entry) {
        setActiveCompareSession(createUnavailableCompareSession({
          source: "local-history",
          title: `Compare ${rightTitle} with Local History`,
          unavailableTitle: "Local History",
          reason: "no-history",
          message: `No local history snapshots exist for ${path}.`,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      const snapshotText = await historyRead(entry.id);
      compareLocalHistorySnapshot(file.key, entry, snapshotText, { file, selection, target });
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "local-history",
        title: `Compare ${rightTitle} with Local History`,
        unavailableTitle: "Local History",
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  }, [absolutePathForOpenFile, activeFile, compareLocalHistorySnapshot, setStatusMessage]);

  const applyCompareSession = useCallback(async (
    session: EditorCompareSession,
    newText: string,
  ) => {
    const target = session.target;
    if (!target) throw new Error("Comparison target is no longer available");
    if (workspaceResourceOperationLocked) {
      throw new Error("Workspace resource operations are busy");
    }
    flushPendingEditorText();
    let current = openFilesRef.current[target.fileKey] ?? null;
    if (current?.library) throw new Error(`${current.title} is a read-only library source`);
    if (!compareTargetMatches(current, target)) {
      throw new Error("Comparison target is stale; no changes were applied");
    }
    if (!current) throw new Error("Comparison target is no longer open");
    if (current.dirty) {
      const confirmed = await confirmAppDialog({
        title: "Apply comparison",
        message: `Replace unsaved changes in ${current.subtitle} with the comparison result?`,
        confirmLabel: "Apply",
      });
      if (!confirmed) {
        setStatusMessage("Comparison apply cancelled; unsaved changes were kept");
        return;
      }
      flushPendingEditorText();
      current = openFilesRef.current[target.fileKey] ?? null;
      if (current?.library) throw new Error(`${current.title} is a read-only library source`);
      if (!compareTargetMatches(current, target)) {
        throw new Error("Comparison target became stale; no changes were applied");
      }
      if (!current) throw new Error("Comparison target is no longer open");
    }

    const nextText = target.selection
      ? replaceCompareSelection(current.text, target.selection, newText)
      : normalizeCompareText(newText);
    if (nextText === null) {
      throw new Error("Comparison selection is stale; no changes were applied");
    }
    if (nextText === current.text) {
      setStatusMessage("Comparison already matches the current buffer");
      return;
    }

    const beforeText = current.text;
    const next = mutateOpenBuffer(target.fileKey, { text: nextText, error: null }, "workspace-edit");
    if (!next) throw new Error("Comparison target closed before apply");
    const affectedPath = absolutePathForOpenFile(next) ?? next.path;
    semanticIndex.invalidate("document-edited", [affectedPath]);
    workspaceEditHistory.push({
      id: `${workspaceInstanceId}:compare:${Date.now()}`,
      label: `Apply comparison from ${session.left.title}`,
      affectedPaths: [affectedPath],
      undo: async () => {
        const live = openFilesRef.current[target.fileKey] ?? null;
        if (!compareTargetMatches(live, {
          ...target,
          documentRevision: next.documentRevision ?? 0,
          expectedText: next.text,
        })) {
          throw new Error("Cannot undo comparison: the buffer changed after apply");
        }
        const restored = mutateOpenBuffer(target.fileKey, { text: beforeText, error: null }, "history-replay");
        if (!restored) throw new Error("Cannot undo comparison: target is closed");
        semanticIndex.invalidate("document-edited", [affectedPath]);
        await syncLspDocument(restored, "change");
      },
      redo: async () => {
        const live = openFilesRef.current[target.fileKey] ?? null;
        if (!live || live.text !== beforeText) {
          throw new Error("Cannot redo comparison: the buffer changed after undo");
        }
        const redone = mutateOpenBuffer(target.fileKey, { text: nextText, error: null }, "history-replay");
        if (!redone) throw new Error("Cannot redo comparison: target is closed");
        semanticIndex.invalidate("document-edited", [affectedPath]);
        await syncLspDocument(redone, "change");
      },
    });
    setWorkspaceEditHistoryRevision((revision) => revision + 1);
    await syncLspDocument(next, "change");
    setActiveCompareSession(null);
    setStatusMessage(`Applied comparison to ${next.subtitle}; undo is available`);
  }, [
    absolutePathForOpenFile,
    flushPendingEditorText,
    mutateOpenBuffer,
    semanticIndex.invalidate,
    setStatusMessage,
    syncLspDocument,
    workspaceEditHistory,
    workspaceInstanceId,
    workspaceResourceOperationLocked,
  ]);

  const setRenderedDocMode = useCallback((fileKey: string, enabled: boolean) => {
    writeReaderModePreference(workspaceInstanceId, fileKey, enabled);
    setReaderModeByFile((prev) => {
      if (prev[fileKey] === enabled) return prev;
      return { ...prev, [fileKey]: enabled };
    });
  }, [workspaceInstanceId]);

  const toggleRenderedDocComments = useCallback(() => {
    const file = activeFile;
    if (!file) return;
    if (!isDocCommentRenderingSupported(activeRenderedDocLanguageId)) {
      setStatusMessage(`Rendered documentation comments not supported for ${activeRenderedDocLanguageId || "plain text"}`);
      return;
    }
    const current = readerModeByFile[file.key] ?? readReaderModePreference(workspaceInstanceId, file.key);
    const next = !current;
    setRenderedDocMode(file.key, next);
    setStatusMessage(next ? "Rendered documentation enabled (Reader Mode)" : "Rendered documentation disabled");
  }, [activeFile, activeRenderedDocLanguageId, readerModeByFile, setRenderedDocMode, setStatusMessage, workspaceInstanceId]);

  const revealRenderedDocSource = useCallback((fileKey: string) => {
    setRenderedDocMode(fileKey, false);
    if (fileKey === activeFile?.key) setStatusMessage("Rendered documentation disabled");
  }, [activeFile?.key, setRenderedDocMode, setStatusMessage]);

  const navigateDiagnostic = useCallback((direction: 1 | -1) => {
    const file = activeFile;
    if (!file) return;
    const state = lspFilesRef.current[file.key] ?? null;
    const currentDiagnostics = currentDiagnosticsForFile(file, state);
    if (!currentDiagnostics) {
      setStatusMessage(state?.error
        ? `Diagnostics failed: ${state.error}`
        : state?.status?.active
          ? "Diagnostics are still refreshing for the current file"
          : "Diagnostics unavailable without a language server");
      return;
    }
    const requestScope = diagnosticScopeForFile(file, state);
    const diags = displayDiagnosticsFor(
      currentDiagnostics,
      inspectionPathForFileKey(file.key),
    ).filter((item) => item.severity === 1 || item.severity === 2).slice().sort((a, b) => {
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
      void openFile(file.ref).then(() => {
        const latest = openFilesRef.current[file.key];
        const latestState = lspFilesRef.current[file.key] ?? null;
        const latestDiagnostics = latest
          ? currentDiagnosticsForFile(latest, latestState)
          : null;
        if (
          !latest
          || latest.documentRevision !== file.documentRevision
          || !isDiagnosticScopeCurrent(latestState?.diagnosticScope, requestScope)
          || !latestDiagnostics
          || !displayDiagnosticsFor(latestDiagnostics, inspectionPathForFileKey(file.key)).some((candidate) => (
            candidate.severity === target.severity
            && candidate.message === target.message
            && candidate.range.start.line === target.range.start.line
            && candidate.range.start.character === target.range.start.character
          ))
        ) {
          return;
        }
        revealEditorLocation(file.key, target.range);
      });
      setStatusMessage(`${target.severity === 1 ? "Error" : "Warning"}: ${target.message}`);
    }
  }, [
    activeEditorGroupId,
    activeFile,
    currentDiagnosticsForFile,
    cursorPositions,
    diagnosticScopeForFile,
    displayDiagnosticsFor,
    inspectionPathForFileKey,
    openFile,
    openFilesRef,
    revealEditorLocation,
    setStatusMessage,
  ]);

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

  const [coverageReport, setCoverageReport] = useState<WorkspaceCoverageReport | null>(null);
  const [coverageOverlayEnabled, setCoverageOverlayEnabled] = useState(true);
  const [dapGuideOpen, setDapGuideOpen] = useState(false);
  const [keymapCheatSheetOpen, setKeymapCheatSheetOpen] = useState(false);

  const scanWorkspaceCoverage = useCallback(async () => {
    for (const root of rootsRef.current) {
      const candidates = [
        "coverage/lcov.info",
        "lcov.info",
        "target/site/jacoco/jacoco.xml",
        "target/site/jacoco-aggregate/jacoco.xml",
        "build/reports/jacoco/test/jacocoTestReport.xml",
        "coverage.xml",
      ];
      for (const rel of candidates) {
        try {
          const file = await workspaceReadFile(root.path, rel);
          if (file && file.text) {
            const report = parseCoverageReport(file.text);
            setCoverageReport(report);
            setStatusMessage(`Loaded test coverage (${rel}): ${report.totalPercentage}% covered`);
            return;
          }
        } catch {
          // Continue searching candidates
        }
      }
    }
    setStatusMessage("No coverage reports found (run tests with coverage enabled)");
  }, [setStatusMessage]);

  // §8.18.5 closed-tab reopen stack (session-only, max 50, never persisted).
  const [closedTabsStack, setClosedTabsStack] = useState<readonly ClosedTabEntry[]>([]);

  const workspaceCommands = useMemo<WorkspaceCommand[]>(() => [
    {
      id: "editor.completeStatement",
      title: "Complete Statement",
      category: "Edit",
      keybinding: "Ctrl+Shift+Enter",
      keywords: ["semicolon", "finish", "statement"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: (context) => executeEditorCommand("completeStatement", context),
    },
    {
      // §8.19.8: one Surround With entry opens the kind dialog; try/catch is
      // no longer a hard-wired command and every kind shares the same
      // plan builder, single transaction and undo entry.
      id: "editor.surroundWith",
      title: "Surround With…",
      category: "Edit",
      keybinding: "Ctrl+Alt+T",
      keybindings: ["Meta+Alt+T"],
      keywords: ["surround", "wrap", "try", "catch", "if", "while", "runnable"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: () => {
        setSurroundWithDialogOpen(true);
        return true;
      },
    },
    {
      // §8.19.8 Generate Code: the dialog lists exactly what the provider
      // returned; without a provider this stays honestly empty.
      id: "editor.generateCode",
      title: "Generate Code…",
      category: "Code",
      keybinding: "Alt+Insert",
      keybindings: ["Meta+n"],
      keywords: ["generate", "constructor", "getter", "setter", "toString", "override"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: () => {
        void requestGenerateCandidates();
        return true;
      },
    },
    {
      // §8.18.8 Smart completion stays visible but typed-unavailable until a
      // provider advertises expected types; it never relabels Basic results.
      id: "editor.smartCompletion",
      title: "Type-Matching Completion (Smart)",
      category: "Edit",
      provenance: "unsupported",
      keywords: ["smart", "type matching", "completion"],
      when: () => false,
      run: () => false,
    },
    {
      id: "workspace.reopenClosedTab",
      title: "Reopen Closed Tab",
      category: "File",
      keybinding: "Ctrl+Shift+T",
      keywords: ["reopen", "closed", "tab", "undo close"],
      run: () => {
        // §8.18.5: pop the newest entry that still resolves to a real file.
        // §8.19.6: resolve against the LIVE tree — original leaf, then the
        // nearest surviving ancestor along the recorded route, then the leaf
        // owning the most former siblings, then the active editor.
        while (closedTabsStack.length > 0) {
          const [entry, ...rest] = closedTabsStack;
          const resolution = entry?.ref && entry.location
            ? resolveReopenLocation(workspaceUi.layoutTreeV2, entry.location, activeEditorGroupId)
            : null;
          setClosedTabsStack(rest);
          if (entry && entry.ref) {
            void openFile(entry.ref as never, resolution ? { groupId: resolution.leafId } : undefined);
            if (resolution?.kind === "relocated") {
              setStatusMessage(
                resolution.reason === "route"
                  ? `Reopened ${entry.title} in the nearest surviving split`
                  : resolution.reason === "sibling"
                    ? `Reopened ${entry.title} next to its former tab group`
                    : `Reopened ${entry.title} in the active editor`,
              );
            }
            return true;
          }
        }
        setStatusMessage("No recently closed tab to reopen");
        return false;
      },
    },
    {
      id: "workspace.keymapSettings",
      title: "Keymap Settings",
      category: "Help",
      keywords: ["keymap", "shortcut", "scheme", "keybinding"],
      run: () => {
        setKeymapSettingsOpen(true);
        return true;
      },
    },
    {
      // §8.19.9 R8-D1: scheme management surface (copy/rename/delete/reset +
      // provenance); the active scheme feeds effective-style resolution.
      id: "workspace.codeStyleSettings",
      title: "Code Style Settings",
      category: "View",
      keywords: ["code style", "scheme", "indent", "spaces", "end of line"],
      run: () => {
        setCodeStyleSettingsOpen(true);
        return true;
      },
    },
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
      run: () => openSearchEverywhere(seSymbolsAvailable ? "classes" : "files"),
    },
    {
      id: "workspace.goToSymbol",
      title: "Go to Symbol",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Shift+N",
      keywords: ["workspace symbol"],
      run: () => openSearchEverywhere(seSymbolsAvailable ? "symbols" : "files"),
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
      id: "workspace.recentLocations",
      title: "Recent Locations",
      category: "Navigation",
      keybinding: "Ctrl+Shift+E",
      keywords: ["recent", "locations", "snippet", "preview", "history"],
      run: () => {
        setRecentLocationsChangedOnly(false);
        setRecentLocationsOpen(true);
      },
    },
    {
      id: "workspace.recentChangedFiles",
      title: "Recently Changed Files",
      category: "Navigation",
      keywords: ["modified", "changes", "history"],
      run: () => {
        setRecentLocationsChangedOnly(true);
        setRecentLocationsOpen(true);
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
        if (!activeFile) return;
        setParameterInfoRequestNonce((nonce) => nonce + 1);
      },
    },
    {
      id: "workspace.editorAppearanceSettings",
      title: "Editor Appearance Settings",
      category: "View",
      keywords: ["font", "theme", "contrast", "wrap", "breadcrumbs", "virtual space", "zoom"],
      run: () => setEditorAppearanceSettingsOpen(true),
    },
    {
      id: "workspace.editorTabPolicySettings",
      title: "Editor Tab Policy Settings",
      category: "View",
      keywords: ["tab", "policy", "limit", "pinned", "preview", "order", "activate"],
      run: () => openTabPolicySettings(),
    },
    {
      id: "workspace.editor.copy",
      title: "Copy",
      category: "Edit",
      keybinding: "Ctrl+C",
      keybindings: ["Meta+C"],
      keywords: ["clipboard", "selection", "multi-caret"],
      when: (context) => context.focus === "editor"
        && editorCommandStateFor(context)?.hasSelection === true,
      run: (context) => { executeEditorCommand("copy", context); },
    },
    {
      id: "workspace.editor.cut",
      title: "Cut",
      category: "Edit",
      keybinding: "Ctrl+X",
      keybindings: ["Meta+X"],
      keywords: ["clipboard", "selection", "multi-caret"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state
          && state.hasSelection && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("cut", context); },
    },
    {
      id: "workspace.editor.paste",
      title: "Paste",
      category: "Edit",
      keybinding: "Ctrl+V",
      keybindings: ["Meta+V"],
      keywords: ["clipboard", "multi-caret", "distribute"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("paste", context); },
    },
    {
      // §8.19.5 Plain Paste: rectangular/segment metadata is dropped; the
      // plain text replaces the selection like any ordinary paste.
      id: "workspace.editor.pasteAsPlainText",
      title: "Paste as Plain Text",
      category: "Edit",
      keybinding: "Ctrl+Shift+Alt+V",
      keybindings: ["Meta+Shift+Alt+V"],
      keywords: ["clipboard", "plain text", "paste without formatting"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("pasteAsPlainText", context); },
    },
    {
      // §8.19.5 Copy Reference: workspace-relative path:line, with a symbol
      // candidate only when the provider actually names one.
      id: "workspace.editor.copyReference",
      title: "Copy Reference",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+C",
      keybindings: ["Meta+Alt+Shift+C"],
      keywords: ["copy reference", "path line", "qualified name", "symbol"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile,
      run: () => { void copyReferenceAtCursor(); },
    },
    {
      // §8.19.5 Paste from History: session-only ring, searchable popup;
      // Enter dispatches the full segment plan at the caret as one undo.
      id: "editor.pasteFromHistory",
      title: "Paste from History…",
      category: "Edit",
      keybinding: "Ctrl+Shift+V",
      keybindings: ["Meta+Shift+V"],
      keywords: ["clipboard history", "paste history", "recent copies"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile
        && !context.readOnly,
      run: () => {
        const store = clipboardHandle;
        if (!store.isHistoryEnabled() || store.historyEntries().length === 0) {
          setStatusMessage("Clipboard history is empty or disabled");
          return true;
        }
        setClipboardHistoryEntries([...store.historyEntries()]);
        setClipboardHistoryOpen(true);
        return true;
      },
    },
    {
      id: "workspace.editor.moveStatementUp",
      title: "Move Statement Up",
      category: "Edit",
      keybinding: "Ctrl+Shift+ArrowUp",
      keybindings: ["Meta+Shift+ArrowUp"],
      keywords: ["statement", "line", "syntax", "move"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("moveStatementUp", context); },
    },
    {
      id: "workspace.editor.moveStatementDown",
      title: "Move Statement Down",
      category: "Edit",
      keybinding: "Ctrl+Shift+ArrowDown",
      keybindings: ["Meta+Shift+ArrowDown"],
      keywords: ["statement", "line", "syntax", "move"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("moveStatementDown", context); },
    },
    {
      id: "workspace.editor.cloneCaretAbove",
      title: "Clone Caret Above",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+ArrowUp",
      keywords: ["caret", "cursor", "multi-caret", "above"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("cloneCaretAbove", context); },
    },
    {
      id: "workspace.editor.cloneCaretBelow",
      title: "Clone Caret Below",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+ArrowDown",
      keywords: ["caret", "cursor", "multi-caret", "below"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { executeEditorCommand("cloneCaretBelow", context); },
    },
    {
      id: "workspace.editor.collapseCarets",
      title: "Collapse Carets",
      category: "Edit",
      keybinding: "Escape",
      keywords: ["caret", "selection", "occurrence", "escape"],
      when: (context) => {
        const state = editorCommandStateFor(context);
        return context.focus === "editor" && !!state
          && (state.caretCount > 1 || state.occurrenceSessionActive);
      },
      run: (context) => { executeEditorCommand("collapseCarets", context); },
    },
    {
      id: "workspace.editor.selectNextOccurrence",
      title: "Select Next Occurrence",
      category: "Edit",
      keybinding: "Alt+J",
      keywords: ["occurrence", "caret", "selection", "next"],
      when: (context) => context.focus === "editor"
        && !!editorCommandStateFor(context),
      run: (context) => { executeEditorCommand("selectNextOccurrence", context); },
    },
    {
      id: "workspace.editor.selectAllOccurrences",
      title: "Select All Occurrences",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+J",
      keybindings: ["Meta+Alt+Shift+J"],
      keywords: ["occurrence", "caret", "selection", "all"],
      when: (context) => context.focus === "editor"
        && !!editorCommandStateFor(context),
      run: (context) => { executeEditorCommand("selectAllOccurrences", context); },
    },
    {
      id: "workspace.editor.foldSelection",
      title: "Fold Selection",
      category: "Edit",
      keybinding: "Ctrl+Period",
      keybindings: ["Meta+Period"],
      keywords: ["fold", "selection", "collapse"],
      when: (context) => context.focus === "editor"
        && editorCommandStateFor(context)?.hasSelection === true,
      run: (context) => { executeEditorCommand("foldSelection", context); },
    },
    {
      id: "workspace.editor.foldAll",
      title: "Fold All",
      category: "Edit",
      keybinding: "Ctrl+Shift+NumpadSubtract",
      keywords: ["fold", "collapse", "all"],
      when: (context) => context.focus === "editor"
        && !!editorCommandStateFor(context),
      run: (context) => { executeEditorCommand("foldAll", context); },
    },
    {
      id: "workspace.editor.unfoldAll",
      title: "Unfold All",
      category: "Edit",
      keybinding: "Ctrl+Shift+NumpadAdd",
      keywords: ["fold", "expand", "all"],
      when: (context) => context.focus === "editor"
        && !!editorCommandStateFor(context),
      run: (context) => { executeEditorCommand("unfoldAll", context); },
    },
    {
      id: "workspace.intelligenceSettings",
      title: "Editor Intelligence Settings",
      category: "Code",
      keywords: ["hover", "documentation", "parameter info", "signature", "delay"],
      run: () => setIntelligenceSettingsOpen(true),
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
      id: "workspace.rearrangeCode",
      title: "Rearrange Code",
      category: "Code",
      keywords: ["rearrange", "members", "order", "declarations", "structure"],
      when: () => !!activeFile,
      run: () => {
        if (!activeFile) return;
        const decision = planRearrange({
          scope: "file",
          targetPath: activeFile.path ?? activeFile.key,
          languageId: activeFile.languageId ?? null,
          readOnly: !!activeFile.readOnly,
          hasSelection: false,
          capabilities: { rearrangeSupported: false },
        });
        if (decision.kind === "unavailable") {
          setStatusMessage(decision.reason);
        }
      },
    },
    {
      id: "workspace.codeCleanup",
      title: "Code Cleanup...",
      category: "Code",
      keywords: ["cleanup", "inspect", "batch", "optimize", "profile"],
      when: () => !!activeFile,
      run: () => {
        if (!activeFile) return;
        const decision = planCleanup({
          scope: "file",
          targetPath: activeFile.path ?? activeFile.key,
          languageId: activeFile.languageId ?? null,
          readOnly: !!activeFile.readOnly,
          capabilities: { cleanupSupported: false },
        });
        if (decision.kind === "unavailable") {
          setStatusMessage(decision.reason);
        }
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
      keywords: ["format", "prettier", "indent", "reformat"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        if (!activeFile || activeFile.loading) return false;
        // Prefer capability gate when status is known; if LSP has not
        // reported yet, still allow the command so the shortcut is live
        // as soon as the buffer is open (the planner reports a typed reason
        // instead of a silent no-op).
        if (!activeCapabilities) return true;
        return !!(activeCapabilities.formatting || activeCapabilities.rangeFormatting);
      },
      run: () => {
        // §8.19.9 R8-D2: every invocation resolves through the planner —
        // executable scopes delegate to the provider stage; everything else
        // surfaces a typed unavailable reason.
        const selection = editorSelectionRef.current;
        const hasSelection = !!selection && !selection.empty;
        const decision = planReformat({
          scope: hasSelection ? "selection" : "file",
          targetPath: activeFile
            ? (absolutePathForOpenFile(activeFile) ?? activeFile.languagePath)
            : null,
          languageId: activeLanguageId,
          readOnly: !!activeFile?.library || workspaceResourceOperationLocked,
          hasSelection,
          capabilities: {
            formatting: !!activeCapabilities?.formatting,
            rangeFormatting: !!activeCapabilities?.rangeFormatting,
          },
        });
        if (decision.kind === "unavailable") {
          setStatusMessage(decision.reason);
          return false;
        }
        void formatActiveFile();
        return true;
      },
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
      // §8.20.2 W1: IDEA 2026.2 Type Info (Ctrl+Shift+P). Honest unavailable
      // contract until a provider exposes a typed channel.
      id: "workspace.typeInfo",
      title: "Type Info",
      category: "Code",
      keybinding: "Ctrl+Shift+P",
      keybindings: ["Mod-Shift-P"],
      keywords: ["expression type", "reference information"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!activeFile && !activeFile.loading,
      run: () => void runTypeInfo(),
    },
    {
      // §8.20.2 W1: enabled ONLY from a real provider URL in the last ready
      // quick documentation — never synthesized from the symbol name.
      id: "workspace.externalDocumentation",
      title: "External Documentation",
      category: "Code",
      keywords: ["javadoc online", "browser docs", "url"],
      when: (context) => context.focus !== "tree"
        && context.focus !== "terminal"
        && !!activeFile
        && !activeFile.loading
        && externalDocTargetFromProvider() !== null,
      run: () => void runExternalDocumentation(),
    },
    {
      // §8.20.2 W1: discoverable Expression Static Data entry; reports an
      // explicit provider-unavailable instead of local text guessing.
      id: "workspace.expressionStaticData",
      title: "Expression Static Data",
      category: "Code",
      keywords: ["static data", "branch", "nullness", "constant", "reference information"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!activeFile && !activeFile.loading,
      run: () => void runExpressionStaticData(),
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
      keybindings: ["Alt-Delete", "Alt-delete", "Alt+Delete"],
      keywords: ["refactor", "delete", "safe delete", "usages"],
      when: (context) => context.focus !== "tree" && !!activeFile && !activeFile.loading
        && !activeFile.library,
      getState: () => {
        const availability = evaluateDestructiveRefactorAvailability(null);
        if (availability.state === "disabled") {
          return {
            availability: "disabled",
            disabledReason: availability.message,
            source: "provider",
            scope: "workspace",
            freshness: "current",
            completeness: "complete",
          };
        }
        return {
          availability: "available",
          source: "provider",
          scope: "workspace",
          freshness: "current",
          completeness: "complete",
        };
      },
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
      id: "workspace.aiSetAnswerLanguage",
      title: "Set AI Answer Language",
      category: "AI",
      keywords: ["ai", "language", "answer", "语言"],
      run: (context) => {
        const payload = context.payload as { language?: string } | undefined;
        if (!payload || typeof payload.language !== "string") return;
        setAiAnswerLanguage(payload.language as AiAnswerLanguage);
      },
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
      id: "workspace.gotoDefinition",
      title: "Go to Definition",
      category: "Navigation",
      keybinding: "F12",
      keywords: ["declaration", "jump", "navigate"],
      when: (context) => context.focus === "editor"
        && (!!activeCapabilities || !lspFilesRef.current[activeKey ?? ""]?.status)
        && !!activeFile,
      run: (context) => {
        const target = resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void goToDefinition(target.file, target.position);
      },
    },
    {
      id: "workspace.findReferences",
      title: "Find Usages",
      category: "Navigation",
      keybinding: "Shift+F12",
      keywords: ["usages", "references", "callers"],
      when: (context) => context.focus === "editor"
        && (!!activeCapabilities || !lspFilesRef.current[activeKey ?? ""]?.status)
        && !!activeFile,
      run: (context) => {
        const target = resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void findReferencesRef.current(target.file, target.position);
      },
    },
    {
      // §8.20.5 W4: lightweight popup over the SAME immutable session as the
      // tool window. With a live session it just re-presents it; otherwise a
      // fresh scoped Find Usages runs first.
      id: "workspace.showUsages",
      title: "Show Usages",
      category: "Navigation",
      keybinding: "Ctrl+Alt+F7",
      keywords: ["usages", "popup", "lightweight"],
      when: (context) => context.focus === "editor" && !!activeFile,
      run: (context) => {
        const target = resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        const snapshot = usageSessionRef.current?.getCurrent();
        if (snapshot && snapshot.state === "ready" && snapshot.envelope.results.length > 0) {
          setLocationPeek({
            title: `Usages of ${snapshot.symbol.displayName} (${snapshot.envelope.results.length})`,
            locations: snapshot.envelope.results.map(({ role: _role, ...location }) => location),
          });
          return;
        }
        void findReferencesRef.current(target.file, target.position);
      },
    },
    {
      id: "workspace.previousMethod",
      title: "Previous Method",
      category: "Navigation",
      keybinding: "Alt+Up",
      provenance: "unsupported",
      keywords: ["previous", "method", "function", "navigate"],
      when: () => false,
      run: () => {
        setStatusMessage("Previous Method requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.nextMethod",
      title: "Next Method",
      category: "Navigation",
      keybinding: "Alt+Down",
      provenance: "unsupported",
      keywords: ["next", "method", "function", "navigate"],
      when: () => false,
      run: () => {
        setStatusMessage("Next Method requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.previousSibling",
      title: "Previous Sibling",
      category: "Navigation",
      provenance: "unsupported",
      keywords: ["previous", "sibling", "element", "navigate"],
      when: () => false,
      run: () => {
        setStatusMessage("Previous Sibling requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.nextSibling",
      title: "Next Sibling",
      category: "Navigation",
      provenance: "unsupported",
      keywords: ["next", "sibling", "element", "navigate"],
      when: () => false,
      run: () => {
        setStatusMessage("Next Sibling requires a language-specific syntax model (unsupported)");
      },
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
      id: "workspace.toggleBookmarkWithMnemonic",
      title: "Toggle Bookmark with Mnemonic",
      category: "Edit",
      keybinding: "Ctrl+F11",
      keywords: ["bookmark", "mnemonic", "mark", "digit"],
      when: (context) => context.focus === "editor" && !!activeFile && !activeFile.loading,
      run: () => chooseMnemonicBookmarkAtCursor(),
    },
    {
      id: "workspace.showBookmarks",
      title: "Show Bookmarks",
      category: "View",
      keybinding: "Shift+F11",
      keywords: ["bookmark", "list", "show"],
      run: openTodosPane,
    },
    {
      id: "workspace.jumpToMnemonicBookmark",
      title: "Jump to Mnemonic Bookmark",
      category: "View",
      keywords: ["bookmark", "jump", "mnemonic", "go"],
      run: () => {
        const mnemonicBookmarks = bookmarks.filter((b) => b.mnemonic);
        if (mnemonicBookmarks.length === 0) {
          setStatusMessage("No mnemonic bookmarks set");
          return;
        }
        if (mnemonicBookmarks.length === 1 && mnemonicBookmarks[0].mnemonic) {
          jumpToMnemonicBookmark(mnemonicBookmarks[0].mnemonic);
        } else {
          openTodosPane();
        }
      },
    },
    ...WORKSPACE_BOOKMARK_MNEMONICS.map((mnemonic): WorkspaceCommand => ({
      id: `workspace.jumpToBookmark${mnemonic}`,
      title: `Jump to Bookmark [${mnemonic}]`,
      category: "Navigation",
      keybinding: `Ctrl+${mnemonic}`,
      keybindings: [`Meta+${mnemonic}`],
      keywords: ["bookmark", "jump", "mnemonic", mnemonic.toLowerCase()],
      when: () => !!findBookmarkByMnemonic(bookmarks, mnemonic),
      run: () => jumpToMnemonicBookmark(mnemonic),
    })),
    {
      id: "workspace.activateNavigationBar",
      title: "Jump to Navigation Bar",
      category: "Navigate",
      keybinding: "Alt+Home",
      keywords: ["navbar", "navigation", "bar", "breadcrumbs", "jump"],
      when: (context) => context.focus === "editor" && !!activeFile,
      run: activateNavigationBar,
    },
    {
      id: "workspace.highlightUsagesInFile",
      title: "Highlight Usages in File",
      category: "Navigate",
      keybinding: "Ctrl+Shift+F7",
      keywords: ["highlight", "usages", "occurrences", "symbol"],
      when: (context) => context.focus === "editor" && !!activeFile,
      run: highlightUsagesInFile,
    },
    {
      id: "workspace.nextOccurrence",
      title: "Next Highlighted Occurrence",
      category: "Navigate",
      keybinding: "Ctrl+Alt+Down",
      keywords: ["next", "occurrence", "highlight"],
      when: (context) => context.focus === "editor" && !!occurrenceSession,
      run: () => navigateOccurrence("next"),
    },
    {
      id: "workspace.previousOccurrence",
      title: "Previous Highlighted Occurrence",
      category: "Navigate",
      keybinding: "Ctrl+Alt+Up",
      keywords: ["previous", "occurrence", "highlight"],
      when: (context) => context.focus === "editor" && !!occurrenceSession,
      run: () => navigateOccurrence("previous"),
    },
    {
      id: "workspace.clearHighlightUsages",
      title: "Clear Highlight Usages",
      category: "Navigate",
      keybinding: "Escape",
      keywords: ["clear", "highlight", "escape"],
      when: (context) => context.focus === "editor" && !!occurrenceSession,
      run: clearHighlightUsages,
    },
    {
      id: "workspace.compareWithClipboard",
      title: "Compare with Clipboard",
      category: "Diff",
      keywords: ["diff", "compare", "clipboard"],
      when: () => !!activeFile,
      run: compareWithClipboard,
    },
    {
      id: "workspace.compareWithFile",
      title: "Compare with File…",
      category: "Diff",
      keywords: ["diff", "compare", "file"],
      when: () => !!activeFile,
      run: compareWithFile,
    },
    {
      id: "workspace.compareWithLocalHistory",
      title: "Compare with Local History",
      category: "Diff",
      keywords: ["diff", "compare", "local", "history", "snapshot"],
      when: () => !!activeFile,
      run: compareWithLocalHistory,
    },
    {
      id: "workspace.toggleRenderedDocComments",
      title: "Toggle Rendered Documentation",
      category: "View",
      keybinding: "Ctrl+Alt+Q",
      keywords: ["doc", "render", "documentation", "reader", "comment", "jsdoc", "javadoc"],
      when: () => !!activeFile && isDocCommentRenderingSupported(activeRenderedDocLanguageId),
      run: toggleRenderedDocComments,
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
      title: `${activeFileSoftWrap ? "Disable" : "Enable"} Soft Wrap`,
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
      when: () => {
        const file = openFilesRef.current[activeKeyRef.current ?? ""];
        return !!file?.dirty && !file.loading && !file.saving;
      },
      run: () => void saveFile(activeKeyRef.current),
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
      id: "workspace.toggleSyncSplitScroll",
      title: "View: Toggle Synchronized Split Scrolling",
      category: "View",
      when: () => !!splitOrientation,
      run: () => {
        setSyncSplitScroll((v) => {
          const next = !v;
          setStatusMessage(next ? "Synchronized split scrolling enabled" : "Synchronized split scrolling disabled");
          return next;
        });
      },
    },
    // §8.19.6 R5-b split management actions.
    {
      id: "workspace.splitRight",
      title: "Split Editor Right",
      category: "View",
      keywords: ["split", "vertical", "editor"],
      when: () => !!activeKey,
      run: () => {
        splitEditor("vertical");
        return true;
      },
    },
    {
      id: "workspace.splitDown",
      title: "Split Editor Down",
      category: "View",
      keywords: ["split", "horizontal", "editor"],
      when: () => !!activeKey,
      run: () => {
        splitEditor("horizontal");
        return true;
      },
    },
    {
      id: "workspace.goToNextSplit",
      title: "Go to Next Split",
      category: "View",
      keywords: ["next", "splitter", "navigate"],
      run: () => goToAdjacentSplit(1),
    },
    {
      id: "workspace.goToPreviousSplit",
      title: "Go to Previous Split",
      category: "View",
      keywords: ["previous", "splitter", "navigate"],
      run: () => goToAdjacentSplit(-1),
    },
    {
      id: "workspace.moveTabToNextSplit",
      title: "Move Tab to Next Split",
      category: "View",
      keywords: ["move", "tab", "next", "split"],
      when: () => !!activeKey,
      run: () => moveActiveTabToAdjacentSplit(1),
    },
    {
      id: "workspace.moveTabToPreviousSplit",
      title: "Move Tab to Previous Split",
      category: "View",
      keywords: ["move", "tab", "previous", "split"],
      when: () => !!activeKey,
      run: () => moveActiveTabToAdjacentSplit(-1),
    },
    {
      id: "workspace.equalizeSplitProportions",
      title: "Equalize Split Proportions",
      category: "View",
      keywords: ["equalize", "proportions", "ratios", "split"],
      when: () => !!splitOrientation,
      run: equalizeActiveSplitRatios,
    },
    {
      id: "workspace.stretchActiveSplit",
      title: "Stretch Active Split",
      category: "View",
      keywords: ["stretch", "widen", "grow", "split"],
      when: () => !!splitOrientation,
      run: stretchActiveSplit,
    },
    {
      id: "workspace.unsplitAll",
      title: "Unsplit All",
      category: "View",
      keywords: ["unsplit", "close splits", "single editor"],
      when: () => !!splitOrientation,
      run: unsplitAllWindows,
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
    {
      id: "workspace.openKeymapCheatsheet",
      title: "Keyboard Shortcuts (Keymap)",
      category: "Help",
      keybinding: "Ctrl+Alt+/",
      keybindings: ["Mod-Alt-/", "Mod-k Mod-s"],
      keywords: ["keymap", "shortcuts", "hotkeys", "cheat sheet", "intellij"],
      run: () => setKeymapCheatSheetOpen(true),
    },
    {
      id: "workspace.showCoverage",
      title: "Show Code Coverage",
      category: "Analyze",
      keywords: ["coverage", "jacoco", "lcov", "tests", "lines"],
      run: () => {
        setBottomDockTab("coverage");
        setBottomDockOpen(true);
        if (!coverageReport) void scanWorkspaceCoverage();
      },
    },
    {
      id: "workspace.openDapAdapterGuide",
      title: "DAP Debug Adapter Setup Guide",
      category: "Debug",
      keywords: ["dap", "debugpy", "delve", "lldb", "gdb", "js-debug", "adapter", "guide", "setup"],
      run: () => setDapGuideOpen(true),
    },
    {
      id: "workspace.runToCursor",
      title: "Run to Cursor",
      category: "Debug",
      keybinding: "Alt+F9",
      keywords: ["debug", "run", "cursor", "break"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        const session = debugRef.current;
        return !!session?.state && session.state.status === "stopped";
      },
      run: (context) => {
        const session = debugRef.current;
        const target = resolveEditorTarget(context);
        const absolute = target.file ? absolutePathForOpenFile(target.file) : null;
        if (!session?.state || !target.file || !absolute || !target.position) return;
        session.runToCursor(normalizeFsPath(absolute), target.position.line + 1);
      },
    },
    {
      id: "workspace.addDataBreakpoint",
      title: "Add Data Breakpoint",
      category: "Debug",
      keywords: ["debug", "breakpoint", "field", "watch", "data"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        const session = debugRef.current;
        return !!session?.state
          && session.state.status === "stopped"
          && session.capabilities.supportsDataBreakpoints === true;
      },
      run: (context) => {
        const payload = context.payload as { name?: string; frameId?: number } | undefined;
        const name = typeof payload?.name === "string" ? payload.name : null;
        const session = debugRef.current;
        if (!name || !session) return;
        const frameId = payload?.frameId
          ?? session.state?.selectedFrameId
          ?? session.state?.frames[0]?.id
          ?? undefined;
        void session.addDataBreakpoint({ name, frameId }).then((result) => {
          setStatusMessage(result.message);
          if (result.added) {
            setBottomDockTab("debug");
            setBottomDockOpen(true);
          }
        });
      },
    },
  ], [
    activeCapabilities,
    activeEditorCommandState,
    activeEditorGroupId,
    activeFile,
    activeGitRoot,
    activeKey,
    activeInlayHintsEnabled,
    activeLanguageId,
    activeRenderedDocLanguageId,
    addRoot,
    bookmarks,
    closeFile,
    compareWithClipboard,
    compareWithFile,
    compareWithLocalHistory,
    chooseMnemonicBookmarkAtCursor,
    closedTabsStack,
    columnSelectionMode,
    copyTreePath,
    createDir,
    createFile,
    deleteSelected,
    editorCommandStateFor,
    equalizeActiveSplitRatios,
    executeActiveEditorCommand,
    executeEditorCommand,
    findInDirectory,
    formatActiveFile,
    gitRoots.length,
    gitRootsLoading,
    goToAdjacentSplit,
    ignoreWorkspacePath,
    intelligencePreferences.formatOnSave,
    intelligencePreferences.inlayHintsEnabled,
    intelligencePreferences.inlineBlameEnabled,
    activeFileSoftWrap,
    languagePanelOpen,
    moveActiveTabToAdjacentSplit,
    navCan.back,
    navCan.forward,
    navigateDiagnostic,
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
    optimizeImports,
    recentFilesOpen,
    refreshTree,
    reloadFile,
    requestGenerateCandidates,
    revealEditorTabInTree,
    revealRenderedDocSource,
    readerModeByFile,
    renameSelected,
    resolveEditorTarget,
    roots.length,
    runEditorAiActionAtCursor,
    saveFile,
    scanWorkspaceCoverage,
    seSymbolsAvailable,
    selected,
    selectedRootDirectory,
    setBottomDockOpen,
    setBottomDockTab,
    setFormatOnSave,
    setClosedTabsStack,
    setStatusMessage,
    splitOrientation,
    stretchActiveSplit,
    workspaceResourceOperationLocked,
    t,
    toggleBookmarkAtCursor,
    toggleColumnSelectionMode,
    toggleInlayHints,
    toggleInlayHintsForActiveLanguage,
    toggleInlineBlame,
    toggleRenderedDocComments,
    toggleOutlinePane,
    toggleProjectTree,
    toggleSoftWrap,
    toggleTodosPane,
    jumpToMnemonicBookmark,
    undoWorkspaceEdit,
    redoWorkspaceEdit,
    unsplitAllWindows,
    workspaceEditHistoryState,
    workspaceUi.layoutTreeV2,
    coverageReport,
  ]);

  const commandFocusForTarget = useCallback((target: EventTarget | null): WorkspaceFocus => {
    const node = target instanceof Node ? target : null;
    if (!node) return "workspace";
    // Terminal dock marks itself with data-workspace-focus="terminal".
    const el = node instanceof Element ? node : node.parentElement;
    if (el?.closest?.('[data-workspace-focus="terminal"]')) return "terminal";
    if (el?.closest?.('[data-workspace-focus="modal"]') || el?.closest?.('[role="dialog"]') || el?.closest?.('[data-testid$="-popup"]')) return "modal";
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".cm-editor")) return "modal";
    if (treePaneRef.current?.contains(node)) return "tree";
    if (editorPaneRef.current?.contains(node)) return "editor";
    return "workspace";
  }, []);

  const isSurfaceOwnedKeyEvent = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest?.(
      '[data-testid="code-workspace-breadcrumbs"], [data-testid="code-workspace-highlighting-widget"], [data-testid="code-workspace-todos-panel"], [data-taomni-context-menu]',
    ));
  }, []);

  const isEditorSurfaceKeyEvent = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest?.(".cm-editor"));
  }, []);

  // Stable identity unless the active file actually changes, so the action
  // snapshot stays fresh on file switch without re-render feedback loops.
  const actionContextData = useMemo(() => {
    // Port state is intentionally sampled while constructing the immutable host
    // snapshot; registration and selection events bump the revision dependency.
    void editorCommandContextRevision;
    const editorState = activeEditorCommandState();
    return {
      activeFileKey: activeKey ?? undefined,
      activeFilePath: activeFile?.path,
      hasActiveFile: !!editorState,
      hasSelection: editorState?.hasSelection ?? false,
      readOnly: editorState?.readOnly ?? false,
      editorComposing: editorState?.composing ?? false,
      editorCaretCount: editorState?.caretCount ?? 0,
      editorOccurrenceSessionActive: editorState?.occurrenceSessionActive ?? false,
    };
  }, [
    activeEditorCommandState,
    activeFile?.path,
    activeKey,
    editorCommandContextRevision,
  ]);

  const actionsController = useWorkspaceActionsController({
    workspaceId: workspaceInstanceId,
    commands: workspaceCommands,
    resolveFocus: commandFocusForTarget,
    getDefaultFocus: () => activeEditorCommandOwner() ? "editor" : "workspace",
    contextData: actionContextData,
    // §8.16.3 typed-result visibility: surfaced outcomes instead of silent no-ops.
    onCommandExecuted: (commandId, result) => {
      if (!result) return;
      if (result.kind === "failed") {
        setStatusMessage(`Action ${commandId} failed: ${result.message ?? "unknown error"}`);
      } else if (result.kind === "cancelled") {
        setStatusMessage(`Action ${commandId} cancelled`);
      } else if (result.kind === "no-op" && result.reason && result.reason !== "condition-not-met") {
        // §8.18.2 result sink: silent success stays quiet, but a blocked
        // no-op names its reason instead of disappearing.
        setStatusMessage(`Action ${commandId}: ${result.message ?? result.reason}`);
      }
    },
  });

  const executeWorkspaceCommand = useCallback((
    commandId: string,
    context: WorkspaceCommandContext = { focus: "workspace" },
  ) => {
    return actionsController.executeCommand(commandId, context);
  }, [actionsController]);
  workspaceCommandRunnerRef.current = executeWorkspaceCommand;

  // §8.18.2 editable Keymap: per-app-profile scheme store; the active scheme
  // is applied to the live action host so every dispatcher/surface shares it.
  const keymapStore = useMemo(() => readKeymapSchemes(), []);
  const [keymapSchemes, setKeymapSchemes] = useState<KeymapSchemeV3[]>(keymapStore.schemes);
  const [activeKeymapSchemeId, setActiveKeymapSchemeId] = useState<string | null>(keymapStore.activeId);
  const [keymapSettingsOpen, setKeymapSettingsOpen] = useState(false);
  const keymapCorruptDiagnostic = keymapStore.recoveredFromCorrupt
    ? "Stored keymap was corrupted; a backup was kept and defaults are active."
    : null;
  const activeKeymapScheme = useMemo(
    () => keymapSchemes.find((scheme) => scheme.id === activeKeymapSchemeId) ?? null,
    [keymapSchemes, activeKeymapSchemeId],
  );

  useEffect(() => {
    writeKeymapSchemes(keymapSchemes, activeKeymapSchemeId);
  }, [keymapSchemes, activeKeymapSchemeId]);

  useEffect(() => {
    actionsController.host.setKeymapScheme(activeKeymapScheme);
  }, [actionsController.host, activeKeymapScheme]);

  // §8.19.2: one workspace-root mouse dispatcher; unbound gestures (text
  // selection, editing) pass through untouched. Re-attach only when the
  // element or host instance changes.
  const mouseHostRef = useRef(actionsController.host);
  mouseHostRef.current = actionsController.host;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const attached = attachWorkspaceMouseDispatcher(mouseHostRef.current, root);
    return () => attached.dispose();
  }, [visible]);

  const applyKeymapScheme = useCallback((scheme: KeymapSchemeV3) => {
    setKeymapSchemes((schemes) => {
      const exists = schemes.some((entry) => entry.id === scheme.id);
      return exists
        ? schemes.map((entry) => (entry.id === scheme.id ? scheme : entry))
        : [...schemes, scheme];
    });
    if (scheme.id !== activeKeymapSchemeId) setActiveKeymapSchemeId(scheme.id);
  }, [activeKeymapSchemeId]);

  // §8.16.5 N2.6: Ctrl+Tab MRU Switcher state. Hold-to-cycle, release-to-commit,
  // Esc cancels; hovering an entry previews without mutating MRU order.
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [tabSwitcherIndex, setTabSwitcherIndex] = useState(0);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const tabSwitcherOpenRef = useRef(false);
  const tabSwitcherIndexRef = useRef(0);
  tabSwitcherOpenRef.current = tabSwitcherOpen;
  tabSwitcherIndexRef.current = tabSwitcherIndex;
  const mruFileKeysRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeKey) return;
    mruFileKeysRef.current = [
      activeKey,
      ...mruFileKeysRef.current.filter((key) => key !== activeKey),
    ].slice(0, 24);
  }, [activeKey]);

  // §8.19.6: bottom-dock panels mirror their REAL dock state into the
  // workspace-scoped tool-window registry; the Switcher consumes registry
  // snapshots instead of constructing its own list.
  useEffect(() => {
    syncBottomDockToolWindows(workspaceInstanceId, { open: bottomDockOpen, activeTab: bottomDockTab });
  }, [workspaceInstanceId, bottomDockOpen, bottomDockTab]);
  useEffect(() => () => unregisterAllToolWindows(workspaceInstanceId), [workspaceInstanceId]);

  // §8.17.5 step 4 + §8.19.6: the popup cycles over ONE frozen snapshot
  // captured at open time — editor MRU entries plus registry cycle snapshots.
  // Tool windows opened/closed in the background cannot shift the index
  // space or reorder entries mid-cycle; release commits against the snapshot.
  const [switcherSnapshot, setSwitcherSnapshot] = useState<{
    editors: TabSwitcherEntry[];
    tools: TabSwitcherToolWindow[];
  } | null>(null);
  const switcherSnapshotRef = useRef(switcherSnapshot);
  switcherSnapshotRef.current = switcherSnapshot;

  const buildSwitcherSnapshot = useCallback(() => {
    // §8.18.5 leaf identity: resolve which layout leaf currently owns each
    // file so commit reactivates the ORIGINAL view instead of the active one.
    const ownerByFileKey = new Map<string, string>();
    for (const leaf of getAllLeafNodes(workspaceUi.layoutTreeV2)) {
      for (const key of leaf.openFileKeys) {
        if (!ownerByFileKey.has(key)) ownerByFileKey.set(key, leaf.id);
      }
    }
    const editors: TabSwitcherEntry[] = mruFileKeysRef.current
      .map((key) => openFiles[key])
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .map((entry) => {
        const owningGroup = Object.values(editorGroups).find(
          (group) => group.openOrder.includes(entry.key),
        );
        return {
          key: entry.key,
          title: entry.title,
          subtitle: entry.subtitle,
          dirty: entry.dirty,
          active: entry.key === activeKey,
          leafId: ownerByFileKey.get(entry.key) ?? owningGroup?.id ?? null,
          pinned: owningGroup?.pinnedKeys?.includes(entry.key) ?? false,
          preview: owningGroup?.previewKey === entry.key,
        };
      });
    const tools: TabSwitcherToolWindow[] = listToolWindowsForCycle(workspaceInstanceId).map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.title,
      open: snapshot.state === "open",
    }));
    return { editors, tools };
  }, [activeKey, editorGroups, openFiles, workspaceInstanceId, workspaceUi.layoutTreeV2]);
  const buildSwitcherSnapshotRef = useRef(buildSwitcherSnapshot);
  buildSwitcherSnapshotRef.current = buildSwitcherSnapshot;

  const switcherTotalCountRef = useRef(0);
  switcherTotalCountRef.current = switcherSnapshot
    ? switcherSnapshot.editors.length + switcherSnapshot.tools.length
    : 0;

  /**
   * Leaf-aware switcher close, graded per §8.19.6: pinned tabs refuse with a
   * reason (protected work is never silently closed), dirty tabs go through
   * the same confirm path as the tab strip, and tool windows only hide.
   */
  const closeFromTabSwitcher = useCallback(async () => {
    const snapshot = switcherSnapshotRef.current;
    if (!snapshot) return;
    const index = Math.min(
      tabSwitcherIndexRef.current,
      snapshot.editors.length + snapshot.tools.length - 1,
    );
    const editorEntry = snapshot.editors[index];
    if (editorEntry) {
      if (editorEntry.pinned) {
        setStatusMessage(`${editorEntry.title} is pinned — unpin it before closing`);
        return;
      }
      setTabSwitcherOpen(false);
      setSwitcherSnapshot(null);
      await closeFile(editorEntry.key, editorEntry.leafId ?? activeEditorGroupId);
      return;
    }
    setTabSwitcherOpen(false);
    setSwitcherSnapshot(null);
    const toolWindow = snapshot.tools[index - snapshot.editors.length];
    if (toolWindow) {
      // Single-tab dock: hiding the dock IS hiding this window; it stays
      // registered as hidden and reopens through the Switcher.
      setBottomDockOpen(false);
    }
  }, [activeEditorGroupId, closeFile, setBottomDockOpen, setStatusMessage]);

  const commitTabSwitcher = useCallback((index: number) => {
    const snapshot = switcherSnapshotRef.current;
    setTabSwitcherOpen(false);
    setSwitcherSnapshot(null);
    if (!snapshot) return;
    const toolWindow = snapshot.tools[index - snapshot.editors.length];
    if (toolWindow) {
      setBottomDockOpen(true);
      setBottomDockTab(toolWindow.id as BottomDockTabId);
      return;
    }
    const target = snapshot.editors[index];
    if (!target) return;
    const targetRef = openFilesRef.current[target.key]?.ref ?? null;
    if (target.key === activeKeyRef.current && target.leafId) {
      setStoreActiveEditorGroup(workspaceInstanceId, target.leafId as EditorGroupId);
      return;
    }
    if (target.leafId) {
      const leafStillExists = getAllLeafNodes(workspaceUi.layoutTreeV2).some((leaf) => leaf.id === target.leafId);
      if (leafStillExists) {
        // Original leaf activation (§8.18.5): never reroute through the
        // currently active group.
        setStoreActiveEditorGroup(workspaceInstanceId, target.leafId as EditorGroupId);
        setLeafActiveTab(workspaceInstanceId, target.leafId, target.key);
        return;
      }
      setStatusMessage(`${target.title}: its split was closed — reopened in the current editor`);
    }
    if (targetRef) void openFile(targetRef);
  }, [workspaceUi.layoutTreeV2, openFile, setStoreActiveEditorGroup, setLeafActiveTab, setStatusMessage, setBottomDockOpen, setBottomDockTab, workspaceInstanceId]);
  const commitTabSwitcherRef = useRef(commitTabSwitcher);
  commitTabSwitcherRef.current = commitTabSwitcher;
  const closeFromTabSwitcherRef = useRef(closeFromTabSwitcher);
  closeFromTabSwitcherRef.current = closeFromTabSwitcher;

  useEffect(() => {
    if (!visible) return;
    // §8.17.3 step 2: ONE capture keydown listener for the whole workspace.
    // The Ctrl+Tab switcher runs inside this listener through the action
    // host's normalized key identity (`eventLogicalKey`), so macOS Meta+Tab
    // and Windows/Linux Ctrl+Tab share one code path and no second window
    // listener competes with the host dispatch below.
    const handleWorkspaceCommand = (event: KeyboardEvent) => {
      // Navigation bar and popup controls own their keyboard state. They are
      // rendered in the workspace or a portal, so the window capture listener
      // must not turn Home/arrows/Enter/Escape into editor actions first.
      if (isSurfaceOwnedKeyEvent(event.target)) return;
      const logicalKey = eventLogicalKey(event);
      const switcherModifier = event.ctrlKey || event.metaKey;
      if (logicalKey === "tab" && switcherModifier && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!tabSwitcherOpenRef.current) {
          // Openable when there are editor entries OR tool windows to list;
          // the snapshot is frozen here for the whole cycle (§8.19.6).
          const snapshot = buildSwitcherSnapshotRef.current();
          if (snapshot.editors.length + snapshot.tools.length === 0) return;
          setSwitcherSnapshot(snapshot);
          setTabSwitcherIndex(snapshot.editors.length > 1 ? 1 : 0);
          setTabSwitcherOpen(true);
          return;
        }
        setTabSwitcherIndex((index) => {
          const count = switcherTotalCountRef.current;
          if (count === 0) return 0;
          return event.shiftKey
            ? (index - 1 + count) % count
            : (index + 1) % count;
        });
        return;
      }
      if (logicalKey === "escape" && tabSwitcherOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setTabSwitcherOpen(false);
        return;
      }
      // Bare Tab belongs to the focused native control outside the editor.
      // Otherwise the active editor's insertTab action would consume a banner,
      // tree, or settings control's browser focus navigation.
      if (logicalKey === "tab" && !switcherModifier && !isEditorSurfaceKeyEvent(event.target)) return;
      // §8.18.5: Backspace inside the open Switcher closes the selected
      // editor entry (dirty tabs confirm) or hides the selected tool window.
      if (logicalKey === "backspace" && tabSwitcherOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        void closeFromTabSwitcherRef.current();
        return;
      }
      const dispatchResult = actionsController.dispatchKeydownV2({
        event,
        workspaceId: workspaceInstanceId,
        // CodeMirrorHost registers each split by its stable leaf/view id;
        // fileKey is shared by split views and cannot identify a live view.
        // Non-editor surfaces must resolve their own focus from the event
        // target; otherwise a tree Delete is evaluated against the editor
        // context before the tree can consume it.
        targetViewId: isEditorSurfaceKeyEvent(event.target) && activeEditorCommandOwner()
          ? activeEditorGroupIdRef.current
          : null,
      });
      if (
        dispatchResult.kind === "rejected"
        && dispatchResult.reason === "disabled"
        && dispatchResult.disabledReason
      ) {
        setStatusMessage(dispatchResult.disabledReason);
      }
    };
    // Modifier-release commit cannot be a keydown action; it stays a keyup
    // listener and commits on whichever platform modifier started the cycle.
    const release = (event: KeyboardEvent) => {
      if (!tabSwitcherOpenRef.current) return;
      if (event.key !== "Control" && event.key !== "Meta") return;
      commitTabSwitcherRef.current(Math.min(tabSwitcherIndexRef.current, switcherTotalCountRef.current - 1));
    };
    window.addEventListener("keydown", handleWorkspaceCommand, true);
    window.addEventListener("keyup", release, true);
    return () => {
      window.removeEventListener("keydown", handleWorkspaceCommand, true);
      window.removeEventListener("keyup", release, true);
    };
  }, [actionsController, isEditorSurfaceKeyEvent, isSurfaceOwnedKeyEvent, openFile, visible]);

  const runSearchEverywhereCommand = useCallback((commandId: string) => {
    setSearchEverywhereOpen(false);
    // §8.17.3: run the SAME frozen evaluation the list rendered — a stale or
    // disabled entry must not re-evaluate itself into a fresh context.
    const entry = actionsController.snapshot.find((item) => item.id === commandId);
    if (!entry) return;
    void actionsController.host.executePrepared(entry.evaluation);
  }, [actionsController]);

  const commandRegistration = actionsController.commandRegistration;

  // W0 §8.20.1: while this instance is the active workspace tab and its
  // reopen stack is non-empty, claim Ctrl+Shift+T from the shell router so
  // the chord reopens the closed tab instead of creating a local terminal.
  // Empty stack (or inactive tab) = no claim = shell owns the chord.
  const shellShortcutClaims = useMemo((): readonly ShellShortcutClaim[] => (
    visible && closedTabsStack.length > 0
      ? [{
          ownerId: workspaceInstanceId,
          actionId: "workspace.reopenClosedTab",
          scope: "active-workspace",
          priority: 40,
          enabled: true,
          canExecute: true,
          disabledReason: null,
        }]
      : []
  ), [visible, closedTabsStack.length, workspaceInstanceId]);
  const commandRegistrationWithClaims = useMemo(
    () => (
      shellShortcutClaims.length > 0
        ? { ...commandRegistration, shellShortcutClaims }
        : commandRegistration
    ),
    [commandRegistration, shellShortcutClaims],
  );

  useEffect(() => {
    if (!onCommandsChange) return;
    onCommandsChange(tabId, commandRegistrationWithClaims);
  }, [commandRegistrationWithClaims, onCommandsChange, tabId]);

  useEffect(() => {
    if (!onCommandsChange) return;
    return () => onCommandsChange(tabId, null);
  }, [onCommandsChange, tabId]);

  // Track navigation location on tab activation / file switch (I3)
  useEffect(() => {
    if (!visible || !activeFile || activeFileLoading) return;
    const file = openFilesRef.current[activeFile.key] ?? activeFile;
    const text = file.text ?? "";
    const cursor = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const lines = text.split("\n");
    const lineText = lines[cursor.line] ?? "";
    const startLine = Math.max(0, cursor.line - 1);
    const endLine = Math.min(lines.length, cursor.line + 2);
    const contextSnippet = lines.slice(startLine, endLine).join("\n");

    let sourceOwnership: "workspace" | "library" | "external" = "external";
    if (file.library) {
      sourceOwnership = "library";
    } else {
      const activeFilePath = file.path ?? file.title;
      const isInsideAnyRoot = rootsRef.current.some((root) => isPathContainedInRoot(activeFilePath, root.path));
      if (isInsideAnyRoot) {
        sourceOwnership = "workspace";
      }
    }

    workspaceLocationControllerRef.current.recordNavigation({
      fileKey: file.key,
      filePath: file.path ?? file.title,
      title: file.title,
      line: cursor.line,
      character: cursor.character,
      lineText,
      contextSnippet,
      reason: "tab-switch",
      sourceOwnership,
    });
  }, [activeEditorGroupId, activeFile?.key, activeFileLoading, visible]);

  // §8.16.2 completion identity: one live provider of workspace/file/session
  // identity for every completion request minted from this workspace tab.
  const completionIdentityForFile = useCallback(
    (file: OpenFileState): CompletionRequestIdentity | null => {
      const live = openFilesRef.current[file.key];
      if (!live) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      return {
        workspaceId: workspaceInstanceId,
        fileKey: live.key,
        filePath: absolutePathForOpenFile(live) ?? live.path ?? file.path,
        uri: descriptor.documentUri ?? descriptor.filePath,
        languageId: descriptor.languageId ?? live.languagePath,
        documentRevision: live.documentRevision ?? 0,
        lspSessionGeneration: lspSessionGeneration(),
      };
    },
    [absolutePathForOpenFile, lspDescriptorForFile, lspSessionGeneration, workspaceInstanceId],
  );

  const isCompletionTokenCurrent = useCallback(
    (token: CompletionRequestToken): boolean => {
      if (token.workspaceId !== workspaceInstanceId) return false;
      const live = openFilesRef.current[token.fileKey];
      if (!live) return false;
      const identity = completionIdentityForFile(live);
      return !!identity
        && identity.workspaceId === token.workspaceId
        && identity.fileKey === token.fileKey
        && identity.filePath === token.filePath
        && identity.uri === token.uri
        && identity.languageId === token.languageId
        && identity.documentRevision === token.documentRevision
        && identity.lspSessionGeneration === token.lspSessionGeneration;
    },
    [completionIdentityForFile, workspaceInstanceId],
  );

  const reportCompletionDiagnostic = useCallback((
    kind: CompletionAcceptanceDiagnostic,
    detail?: string,
  ) => {
    if (kind === "truncated") {
      setStatusMessage(`Completion list truncated${detail ? ` (${detail})` : ""}; keep typing to refine`);
    } else if (kind === "invalid-additional-edits") {
      setStatusMessage("Completion rejected invalid provider edits");
    } else if (kind === "identity-mismatch") {
      setStatusMessage("Completion discarded because the editor changed");
    } else {
      setStatusMessage(`Completion import unavailable${detail ? ` (${detail})` : ""}`);
    }
  }, [setStatusMessage]);

  const getLspCompletions = useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string | null,
      token: CompletionRequestToken,
      // §8.19.4 repeated-call facts; forwarded to the provider adapter.
      invocation?: CompletionInvocationRequest,
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
      if (openFilesRef.current[live.key]?.text !== live.text) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      const epoch = lspDocumentEpochRef.current[live.key] ?? 0;
      try {
        const result = await lspCompletion(descriptor, position, triggerCharacter, invocation);
        // Drop only when the buffer moved again while IPC was in flight; CM
        // re-queries on the next keystroke / incomplete list.
        if (!openFilesRef.current[live.key]) return null;
        if (openFilesRef.current[live.key]?.text !== live.text) return null;
        if (lspDocumentEpochRef.current[live.key] !== epoch) return null;
        // Token identity must still match the live request origin; a stale
        // request from a switched file/restarted session is dropped here too.
        if (!isCompletionTokenCurrent(token)) return null;
        const currentLsp = lspFilesRef.current[live.key];
        if (
          !currentLsp?.status
          || currentLsp.status.active !== result.status.active
          || currentLsp.status.error !== result.status.error
        ) {
          updateLspStatusForFile(live, result.status);
        }
        return result;
      } catch {
        return null;
      }
    },
    [
      ensureLspDocumentSynced,
      isCompletionTokenCurrent,
      lspDescriptorForFile,
      updateLspStatusForFile,
    ],
  );

  const resolveLspCompletion = useCallback(
    async (
      file: OpenFileState,
      raw: unknown,
      token: CompletionRequestToken,
    ): Promise<LspCompletionItem | null> => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      if (!isCompletionTokenCurrent(token)) return null;
      try {
        const resolved = await lspCompletionResolve(descriptor, raw);
        return isCompletionTokenCurrent(token) ? resolved : null;
      } catch {
        return null;
      }
    },
    [isCompletionTokenCurrent, lspDescriptorForFile],
  );

  // §8.20.2 W1 Parameter single channel: the provider adapter behind the
  // session. The controller owns identity/cancel; this closure only talks to
  // the language server through the §8.18.6 cancel bridge.
  const parameterInfoProvider = useCallback(
    async (
      request: { fileKey: string; uri: string; position: LspPosition; documentRevision: number; providerGeneration: number },
      triggerCharacter: string | null,
      { signal }: { signal: AbortSignal },
    ) => {
      const file = openFilesRef.current[request.fileKey];
      if (!file) return null;
      if (!shouldLiveSyncLsp(file.languagePath, lspFilesRef.current[file.key])) return null;
      const live = await ensureLspDocumentSynced(file.key);
      if (!live) return null;
      if (!isLspFeatureReady(lspFilesRef.current[live.key])) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      const cancelKey = `${workspaceInstanceId}|${file.key}`;
      const requestSeq = nextLspRequestSequence();
      const onAbort = () => {
        void lspCancelReferenceRequest(cancelKey, requestSeq).catch(() => 0);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await lspSignatureHelp(
          descriptor,
          request.position,
          triggerCharacter ?? null,
          { cancelKey, requestSeq },
        );
        if (signal.aborted) return null;
        const current = openFilesRef.current[live.key];
        if (
          !current
          || current.documentRevision !== request.documentRevision
          || lspSessionGeneration() !== request.providerGeneration
        ) {
          return null;
        }
        updateLspStatusForFile(live, result.status);
        if (!result.signatures.length || !result.status.active) return null;
        return {
          state: "payload" as const,
          payload: {
            kind: "parameter-info" as const,
            signatures: result.signatures,
            activeSignature: result.activeSignature,
            activeParameter: result.activeParameter,
          },
        };
      } catch {
        // Request-level failures close the popup quietly; the next explicit
        // action or trigger re-queries.
        return null;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    [
      ensureLspDocumentSynced,
      lspDescriptorForFile,
      lspSessionGeneration,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );

  /** Live file identity snapshot feeding the session's stale/closure checks.
   * Reads through openFilesRef: a typed edit bumps the revision synchronously
   * there, while the rendered OpenFileState can lag one flush behind. */
  const sessionContextForFile = useCallback((file: OpenFileState): ReferenceSessionContext | null => {
    const latest = openFilesRef.current[file.key] ?? file;
    if (latest.loading) return null;
    const descriptor = lspDescriptorForFile(latest);
    return {
      fileKey: latest.key,
      uri: descriptor?.documentUri
        ?? lspFilesRef.current[latest.key]?.status?.uri
        ?? descriptor?.filePath
        ?? latest.languagePath,
      languageId: descriptor?.languageId ?? "plaintext",
      documentRevision: latest.documentRevision,
      providerGeneration: lspSessionGeneration(),
    };
  }, [lspDescriptorForFile, lspSessionGeneration]);

  // File switches (and workspace remounts) close the old tooltip; per-edit
  // closure comes from the host's doc-changed/caret invalidation events.
  const activeParameterFileKey = activeFile?.key ?? null;
  useEffect(() => {
    if (!activeParameterFileKey) {
      parameterInfoSession.setContext(null);
      return;
    }
    const latest = openFilesRef.current[activeParameterFileKey];
    if (!latest) return;
    const context = sessionContextForFile(latest);
    if (context) parameterInfoSession.setContext(context);
  }, [activeParameterFileKey, parameterInfoSession, sessionContextForFile]);

  const handleParameterTrigger = useCallback((file: OpenFileState, event: {
    position: LspPosition;
    anchorOffset: number;
    triggerCharacter: string | null;
    origin: "explicit" | "typing";
  }) => {
    const context = sessionContextForFile(file);
    if (!context) return;
    // The edit that carried the trigger also bumped the identity; publishing
    // it here closes any pre-edit tooltip before the fresh query starts.
    parameterInfoSession.setContext(context);
    parameterInfoSession.request(event, (request, ticket) =>
      parameterInfoProvider(request, event.triggerCharacter, ticket));
  }, [parameterInfoProvider, parameterInfoSession, sessionContextForFile]);

  const handleParameterInvalidate = useCallback((reason: ParameterInvalidateReason) => {
    parameterInfoSession.invalidate(reason);
  }, [parameterInfoSession]);

  const handleParameterEscape = useCallback(() => parameterInfoSession.escape(), [parameterInfoSession]);

  const getLspHover = useCallback(
    async (file: OpenFileState, position: LspPosition): Promise<QuickDocContent | null> => {
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
      const requestRevision = file.documentRevision;
      const requestGeneration = lspSessionGeneration();
      const lines = file.text.split("\n");
      const line = lines[position.line] ?? "";
      const left = line.slice(0, position.character);
      const right = line.slice(position.character);
      const start = left.search(/[A-Za-z0-9_$]+$/);
      const endMatch = right.match(/^[A-Za-z0-9_$]*/);
      const from = start >= 0 ? start : position.character;
      const to = position.character + (endMatch?.[0].length ?? 0);
      let providerLabel = "Language Server";
      let providerUri: string | null = null;
      const outcome = await referenceInfoController.requestTyped({
        kind: "quick-documentation",
        workspaceId: workspaceInstanceId,
        fileKey: file.key,
        uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
        languageId: descriptor.languageId ?? "plaintext",
        position,
        documentRevision: requestRevision,
        providerGeneration: requestGeneration,
      }, async ({ signal }) => {
        // §8.18.6: same provider-cancellation identity as the explicit path.
        const cancelKey = `${workspaceInstanceId}|${file.key}`;
        const requestSeq = nextLspRequestSequence();
        const result = await lspHover(descriptor, position, { cancelKey, requestSeq });
        if (signal.aborted) return null;
        const current = openFilesRef.current[file.key];
        if (
          !current
          || current.documentRevision !== requestRevision
          || lspSessionGeneration() !== requestGeneration
        ) {
          return null;
        }
        updateLspStatusForFile(file, result.status);
        if (!result.contents) return null;
        providerLabel = result.status.displayName ?? "Language Server";
        providerUri = result.status.uri ?? null;
        return {
          state: "payload" as const,
          payload: {
            kind: "quick-documentation" as const,
            markdown: result.contents,
            source: result.range && result.status.uri
              ? {
                  uri: result.status.uri,
                  path: result.status.path ?? null,
                  range: result.range,
                }
              : null,
          },
        };
      });
      if (outcome.state !== "ready" || outcome.payload.kind !== "quick-documentation") {
        if (outcome.state === "failed") {
          setLspFiles((current) => ({
            ...current,
            [file.key]: {
              ...(current[file.key] ?? emptyLspFileState()),
              error: outcome.state === "failed" ? outcome.message : "",
            },
          }));
        }
        return null;
      }
      // Hover refreshes the cursor-linked popup but never writes history —
      // only ready explicit QuickDoc does (§8.20.2).
      return {
        title: line.slice(from, to) || file.title,
        body: outcome.payload.markdown,
        source: providerLabel,
        uri: providerUri,
        sourceLocation: outcome.payload.source,
        revision: requestRevision,
        generation: requestGeneration,
      };
    },
    [
      absolutePathForOpenFile,
      lspDescriptorForFile,
      lspSessionGeneration,
      referenceInfoController,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );
  getLspHoverRef.current = getLspHover;

  const navigateLocations = useCallback(async (
    title: string,
    locations: LspLocation[],
    emptyMessage: string,
    isCurrent?: () => boolean,
  ) => {
    if (!locations.length) {
      setStatusMessage(emptyMessage);
      return false;
    }
    if (isCurrent && !isCurrent()) return false;
    if (locations.length === 1) {
      setLocationPeek(null);
      if (isCurrent && !isCurrent()) return false;
      return openLspLocation(locations[0], { isCurrent });
    }
    if (isCurrent && !isCurrent()) return false;
    setLocationPeek({ title, locations });
    return true;
  }, [openLspLocation, setStatusMessage]);

  const goToDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      try {
        const query = beginSemanticQuery("definitions", file, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "definitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(file, result.status);
            return result.locations;
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No definition found");
          return false;
        }
        if (queryRes.items.length === 1) {
          if (!query.isCurrent()) return false;
          recordNavigationLocation(file.ref, position);
        }
        return navigateLocations("Definitions", queryRes.items, "No definition found", query.isCurrent);
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
  );

  const peekDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      try {
        const query = beginSemanticQuery("definitions", file, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "definitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(file, result.status);
            return result.locations;
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (!queryRes.items.length) {
          setStatusMessage("No definition found");
          return false;
        }
        if (!query.isCurrent()) return false;
        setLocationPeek({ title: "Quick Definition", locations: queryRes.items });
        return true;
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, lspDescriptorForFile, setLocationPeek, setStatusMessage, updateLspStatusForFile],
  );

  const goToDeclaration = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      const caps = lspFilesRef.current[file.key]?.status?.capabilities;
      if (caps && caps.declaration === false) {
        setStatusMessage("Go to declaration is not supported by this language server");
        return false;
      }
      try {
        const query = beginSemanticQuery("declarations", file, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "declarations",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(file, result.status);
            return result.locations;
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No declaration found");
          return false;
        }
        if (queryRes.items.length === 1) {
          if (!query.isCurrent()) return false;
          recordNavigationLocation(file.ref, position);
        }
        return navigateLocations("Declarations", queryRes.items, "No declaration found", query.isCurrent);
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
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
      try {
        const query = beginSemanticQuery("typeDefinitions", file, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "typeDefinitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspTypeDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(file, result.status);
            return result.locations;
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No type definition found");
          return false;
        }
        if (queryRes.items.length === 1) {
          if (!query.isCurrent()) return false;
          recordNavigationLocation(file.ref, position);
        }
        return navigateLocations("Type definitions", queryRes.items, "No type definition found", query.isCurrent);
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
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
      try {
        const query = beginSemanticQuery("implementations", file, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "implementations",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspImplementation(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(file, result.status);
            return result.locations;
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No implementation found");
          return false;
        }
        if (queryRes.items.length === 1) {
          if (!query.isCurrent()) return false;
          recordNavigationLocation(file.ref, position);
        }
        return navigateLocations("Implementations", queryRes.items, "No implementation found", query.isCurrent);
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, lspDescriptorForFile, navigateLocations, recordNavigationLocation, setStatusMessage, updateLspStatusForFile],
  );
  goToDefinitionRef.current = goToDefinition;
  peekDefinitionRef.current = peekDefinition;
  goToDeclarationRef.current = goToDeclaration;
  goToTypeDefinitionRef.current = goToTypeDefinition;
  goToImplementationRef.current = goToImplementation;

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
      const documentUri = descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath;
      const evidence = buildCapabilityEvidence({
        capabilityId: "refactor.rename",
        languageId: descriptor.languageId ?? "java",
        provider: {
          id: descriptor.languageId ?? "jdtls",
          version: null,
          generation: lspSessionGeneration(),
        },
        projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: documentUri,
        revision: live.documentRevision ?? 0,
        position,
        scope: "project",
        complete: false,
        reason: "provider rename response; AST completeness not guaranteed",
      });
      const plan = buildRefactorPlan({
        actionId: `rename:${documentUri}:${position.line}:${position.character}`,
        kind: "rename",
        evidence,
        edit: renamed.edit,
        roots: rootsRef.current,
        openFiles: openFilesRef.current,
        completeness: {
          value: "partial",
          source: "protocol-bounded",
          proof: "provider rename response; AST completeness not guaranteed",
        },
      });
      const gate = refactorApplyGate(plan);
      if (!gate.allowed) {
        semanticIndex.abandonBuild(buildToken);
        setStatusMessage(`Rename blocked: ${gate.reason}`);
        return;
      }
      if (gate.requiresConfirm) {
        const confirmed = await confirmAppDialog({
          title: "Rename Warning",
          message: gate.reason ?? "The rename produced warnings. Proceed anyway?",
          confirmLabel: "Proceed",
        });
        if (!confirmed) {
          semanticIndex.abandonBuild(buildToken);
          setStatusMessage("Rename cancelled");
          return;
        }
      }
      await applyLspWorkspaceEdit(renamed.edit, {
        preview: true,
        label: `Rename symbol to "${nextName}"`,
        semanticGeneration: buildToken.generation,
        semanticRevision: buildToken.revision,
        semanticWorkspaceOnly: true,
        plan,
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
    const availability = evaluateDestructiveRefactorAvailability(null);
    if (availability.state === "disabled") {
      setStatusMessage(availability.message);
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
      const documentUri = descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath;
      const evidence = buildCapabilityEvidence({
        capabilityId: "refactor.safeDelete",
        languageId: descriptor.languageId ?? "java",
        provider: {
          id: descriptor.languageId ?? "jdtls",
          version: null,
          generation: lspSessionGeneration(),
        },
        projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: documentUri,
        revision: live.documentRevision ?? 0,
        position,
        scope: "project",
        complete: deletion.complete,
        reason: deletion.complete
          ? "all references resolved within workspace roots"
          : "references could not be completely resolved",
      });
      const plan = buildRefactorPlan({
        actionId: `safe-delete:${documentUri}:${prepared.range.start.line}:${prepared.range.start.character}`,
        kind: "safe-delete",
        evidence,
        edit: deletion.edit,
        roots: rootsRef.current,
        openFiles: openFilesRef.current,
        completeness: {
          value: deletion.complete ? "complete" : "partial",
          source: "client-observed-bounded",
          proof: deletion.complete
            ? "client-observed references within workspace roots"
            : "references could not be completely resolved",
        },
      });
      const gate = refactorApplyGate(plan);
      if (!gate.allowed) {
        semanticIndex.abandonBuild(buildToken);
        const reason = gate.reason || "Safe Delete blocked by refactor gate";
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
      await applyLspWorkspaceEdit(deletion.edit, {
        label: "Safe delete symbol",
        semanticGeneration: buildToken.generation,
        semanticRevision: buildToken.revision,
        semanticWorkspaceOnly: true,
        plan,
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

  const runFindReferences = useCallback(
    async (file: OpenFileState, position: LspPosition, selection: UsagesScopeSelection) => {
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
      usageSessionRef.current?.startLoading(
        { uri: "", range: { start: position, end: position }, displayName: "", providerSymbolId: null },
        selection,
      );
      const expectedRevision = semanticIndex.current().revision;
      const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
      if (!live) {
        if (referencesRequestSequenceRef.current !== requestId) return;
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
      let query: ReturnType<typeof beginSemanticQuery> | null = null;
      try {
        // §8.19.7 real identity + origin symbol key: name comes from the
        // provider's rename range when available (fallback: word at caret),
        // so rerun targets the same symbol rather than whatever sits under
        // the caret later.
        let symbolRange: LspRange | null = null;
        try {
          const prepared = await lspPrepareRename(descriptor, position);
          symbolRange = prepared.range ?? null;
        } catch {
          symbolRange = null;
        }
        if (referencesRequestSequenceRef.current !== requestId) {
          semanticIndex.abandonBuild(buildToken);
          return;
        }
        const lines = live.text.split("\n");
        const lineText = lines[position.line] ?? "";
        const symbolName = (symbolRange
          && symbolRange.start.line === symbolRange.end.line
          ? lineText.slice(symbolRange.start.character, symbolRange.end.character).trim()
          : "")
          || lineText.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0]
          || "";
        const identity = makeSemanticRequestIdentity({
          workspaceId: workspaceInstanceId,
          fileKey: live.key,
          uri: descriptor.documentUri ?? descriptor.filePath,
          position,
          documentRevision: live.documentRevision ?? 0,
          providerGeneration: lspSessionGeneration(),
          workspaceRoots: rootsRef.current.map((root) => root.path),
        });
        const queryContext = beginSemanticQuery("references", live, descriptor, position);
        query = queryContext;
        // §8.20.5 W4 / §8.26.8 AA7: execute via SemanticQueryHost with cancellation and generation guard
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "references",
          identity: queryContext.identity,
          fetcher: async ({ signal }) => {
            const res = await lspReferences(
              descriptor,
              position,
              selection.includeDeclaration,
              queryContext.lspOptions(signal),
            );
            updateLspStatusForFile(live, res.status);
            return res.locations;
          },
          guards: queryContext.guards,
        });
        if (queryRes.status === "cancelled" || queryRes.status === "stale") {
          semanticIndex.abandonBuild(buildToken);
          return;
        }
        if (referencesRequestSequenceRef.current !== requestId || !queryContext.isCurrent(queryRes.identity)) {
          semanticIndex.abandonBuild(buildToken);
          return;
        }
        const locations: readonly LspLocation[] = queryRes.items ?? [];
        const completion = semanticIndex.finishQuery(buildToken, {
          kind: "references",
          resultCount: locations.length,
        });
        if (!completion.accepted || queryRes.status === "error") {
          if (referencesRequestSequenceRef.current === requestId) {
            setReferencesResult({
              loading: false,
              origin: live.subtitle,
              locations: [],
              error: queryRes.error || "References result became stale because the workspace changed",
              semanticGeneration: null,
              semanticRevision: null,
            });
          }
          return;
        }
        if (referencesRequestSequenceRef.current !== requestId || !queryContext.isCurrent()) return;
        referencesRerunRef.current = { fileKey: live.key, uri: identity.uri, position, symbolName };
        // §8.20.5 W4: freeze the scoped result into the shared session — the
        // tool window rows, the Show Usages popup and recents all read THIS
        // snapshot; nothing copies result truth elsewhere.
        const snapshot = usageSessionRef.current?.start({
          symbol: {
            uri: descriptor.documentUri ?? descriptor.filePath,
            range: symbolRange ?? { start: position, end: position },
            displayName: symbolName,
            providerSymbolId: null,
          },
          selection,
          evidence: {
            languageId: descriptor.languageId ?? "plaintext",
            provider: { id: "jdtls", version: null, generation: lspSessionGeneration() },
            projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? identity.projectFingerprint,
            uri: identity.uri,
            revision: live.documentRevision ?? 0,
            scope: "project",
          },
          locations,
          isLibraryUri: libraryUriClassifierForRoots(rootsRef.current, relativePathWithinRoot),
        }) ?? null;
        if (referencesRequestSequenceRef.current !== requestId || !queryContext.isCurrent()) return;
        const scopedLocations = (snapshot?.envelope.results ?? []).map(({ role: _role, ...location }) => location);
        setUsagesRecentsRevision((revision) => revision + 1);
        setReferencesResult({
          loading: false,
          origin: live.subtitle,
          locations: scopedLocations,
          error: null,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
          symbolName,
          identity,
        });
        setStatusMessage(`${scopedLocations.length} reference${scopedLocations.length === 1 ? "" : "s"} found${scopedLocations.length !== locations.length ? ` (${locations.length} unscoped)` : ""}`);
      } catch (err) {
        if (
          referencesRequestSequenceRef.current !== requestId
          || (query !== null && !query.isCurrent())
        ) {
          semanticIndex.abandonBuild(buildToken);
          return;
        }
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
      beginSemanticQuery,
      ensureWorkspaceSemanticDocumentsSynced,
      lspDescriptorForFile,
      lspSessionGeneration,
      projectAnalysisSnapshot?.projectFingerprint,
      rootsRef,
      semanticIndex.beginBuild,
      semanticIndex.abandonBuild,
      semanticIndex.current,
      semanticIndex.failBuild,
      semanticIndex.finishQuery,
      setStatusMessage,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );

  // §8.20.5: manual Find Usages opens the scope dialog first; the recorded
  // selection then drives the request (rerun reuses it without asking).
  const findReferences = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      if (referencesPinnedRef.current) {
        const replacePinned = await confirmAppDialog({
          title: "Replace Pinned Usages",
          message: "The references result is pinned. Replace it with a new Find Usages session?",
          confirmLabel: "Replace",
        });
        if (!replacePinned) {
          setStatusMessage("Kept the pinned usages result; new request cancelled");
          return;
        }
      }
      setUsagesScopeDialog({ open: true, file, position });
    },
    [setStatusMessage],
  );
  findReferencesRef.current = findReferences;

  const confirmUsagesScope = useCallback((selection: UsagesScopeSelection) => {
    setUsagesScopeSelection(selection);
    const pending = usagesScopeDialog;
    setUsagesScopeDialog(null);
    if (pending) void runFindReferences(pending.file, pending.position, selection);
  }, [runFindReferences, usagesScopeDialog]);

  // §8.19.7 rerun: replay against the recorded origin uri+position marker so
  // the same symbol identity is re-queried even after the caret moved — with
  // the LAST scope selection, no dialog (refresh semantics).
  const rerunFindReferences = useCallback(() => {
    const marker = referencesRerunRef.current;
    if (!marker) return;
    const live = openFilesRef.current[marker.fileKey];
    if (!live) {
      setStatusMessage("The usages session's origin buffer is closed; reopen it to rerun");
      return;
    }
    void runFindReferences(live, marker.position, usagesScopeSelection);
  }, [findReferences, runFindReferences, setStatusMessage, usagesScopeSelection]);

  const showEditorContextMenu = useCallback((
    file: OpenFileState,
    request: EditorContextMenuRequest & { groupId?: string },
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

    // §8.16.3 Gate-R1: the menu is a projection of one fresh host evaluation.
    // The payload freezes the clicked leaf/file/position, so a later active-
    // group change cannot redirect execution to another split editor.
    const targetPayload = {
      groupId: request.groupId ?? activeEditorGroupIdRef.current,
      fileKey: file.key,
      position: request.position,
      selectionStart: request.selectionStart,
      selectionEnd: request.selectionEnd,
      hasSelection: request.hasSelection,
      clientX: request.clientX,
      clientY: request.clientY,
    };
    const invocationContext = {
      focus: "editor" as const,
      hasSelection: request.hasSelection,
    };
    const host = actionsController.host;
    // §8.17.3 step 1: `run` executes the FROZEN evaluation captured at menu
    // build time. Re-entering executeAction would re-derive a fresh context
    // and let a stale/disabled row resurrect itself.
    const prepareBinding = (actionId: string, payload?: unknown) => {
      const prepared = host.prepare(actionId, {
        kind: "context-menu" as const,
        context: invocationContext,
        payload: payload ?? targetPayload,
      });
      return {
        actionId,
        prepare: prepared,
        run: () => {
          void host.executePrepared(prepared);
        },
      };
    };
    // Clipboard rows execute through the pinned editor port (frozen target),
    // not the request closures, so ownership matches the enabled state.
    const portBinding = (actionId: string, commandId: EditorCommandId) => ({
      actionId,
      prepare: host.prepare(actionId, {
        kind: "context-menu" as const,
        context: invocationContext,
        payload: targetPayload,
      }),
      run: () => { executeEditorCommandFor(targetPayload, commandId); },
    });

    const debugSession = debugRef.current;
    const fieldDeclaration = debugSession?.state && debugSession.state.status !== "terminated"
      ? fieldDeclarationAt(
        breadcrumbSymbolsRef.current[targetPayload.groupId as EditorGroupId] ?? [],
        request.position,
      )
      : null;

    openEditorContextMenuAt(
      request.clientX,
      request.clientY,
      buildEditorContextMenuItems({
        capabilities: status?.capabilities ?? null,
        hasSelection: request.hasSelection,
        clientX: request.clientX,
        clientY: request.clientY,
        bindings: {
          "workspace.gotoDefinition": prepareBinding("workspace.gotoDefinition"),
          "workspace.gotoTypeDefinition": prepareBinding("workspace.gotoTypeDefinition"),
          "workspace.gotoImplementation": prepareBinding("workspace.gotoImplementation"),
          "workspace.findReferences": prepareBinding("workspace.findReferences"),
          "workspace.callHierarchy": prepareBinding("workspace.callHierarchy"),
          "workspace.typeHierarchy": prepareBinding("workspace.typeHierarchy"),
          "workspace.renameSymbol": prepareBinding("workspace.renameSymbol"),
          "workspace.safeDeleteSymbol": prepareBinding("workspace.safeDeleteSymbol"),
          "workspace.quickDocumentation": prepareBinding("workspace.quickDocumentation"),
          "workspace.codeActions": prepareBinding("workspace.codeActions", {
            ...targetPayload,
            diagnostics: (lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
              item.range.start.line === request.position.line
              || item.range.end.line === request.position.line
            )),
          }),
          "workspace.format": prepareBinding("workspace.format"),
          "workspace.editor.cut": portBinding("workspace.editor.cut", "cut"),
          "workspace.editor.copy": portBinding("workspace.editor.copy", "copy"),
          "workspace.editor.paste": portBinding("workspace.editor.paste", "paste"),
        },
        debug: debugSession?.state && debugSession.state.status !== "terminated" ? {
          runToCursor: prepareBinding("workspace.runToCursor", {
            ...targetPayload,
            line: request.position.line + 1,
          }),
          ...(fieldDeclaration ? {
            dataBreakpoint: prepareBinding("workspace.addDataBreakpoint", {
              name: fieldDeclaration.name,
              frameId: debugSession.state?.selectedFrameId
                ?? debugSession.state?.frames[0]?.id
                ?? undefined,
            }),
          } : {}),
        } : null,
        ai: {
          explainSyntaxLabel: t("codeWorkspaceAi.contextExplainSyntax"),
          explainCodeLabel: t("codeWorkspaceAi.contextExplainCode"),
          explainSyntax: prepareBinding("workspace.aiExplainSyntax"),
          explainCode: prepareBinding("workspace.aiExplainCode"),
          answerLanguage: {
            label: t("codeWorkspaceAi.answerLanguageMenu"),
            current: editorAiPreferencesRef.current.answerLanguage,
            options: AI_ANSWER_LANGUAGES.map((language) => ({
              value: language,
              label: t(answerLanguageLabelKey(language)),
              binding: prepareBinding("workspace.aiSetAnswerLanguage", { language }),
            })),
          },
        },
      }),
    );
  }, [
    absolutePathForOpenFile,
    actionsController,
    editorCommandStateFor,
    executeEditorCommandFor,
    openEditorContextMenuAt,
    setStatusMessage,
    t,
  ]);

  const deferredActiveFile = activeKey ? deferredOpenFiles[activeKey] ?? activeFile : null;
  const dirtyCount = useMemo(
    () => Object.values(openFiles).filter((file) => file.dirty).length,
    [openFiles],
  );
  const dirtyFiles = useMemo(
    () => openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [openFiles, openOrder],
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

  const problemPathToRef = useCallback((rawPath: string): CodeWorkspaceFileRef | null => {
    if (!rawPath) return null;
    let cleanPath = rawPath.trim();
    if (cleanPath.startsWith("file://")) {
      cleanPath = decodeURIComponent(cleanPath.replace(/^file:\/\/\/?/, "/"));
    }
    cleanPath = cleanPath.replace(/\\/g, "/");

    // 1. Direct absolute / canonical match against roots
    for (const root of rootsRef.current) {
      const rel = relativePathWithinRoot(root.path, cleanPath);
      if (rel !== null && rel !== "") {
        return { kind: "root", rootId: root.id, path: rel };
      }
    }

    // 2. Search currently open files by matching path, languagePath, or path suffix
    const openFiles = Object.values(openFilesRef.current);
    const matchingOpen = openFiles.find(
      (f) =>
        f.ref.path === cleanPath ||
        f.path === cleanPath ||
        f.languagePath === cleanPath ||
        f.ref.path.endsWith(`/${cleanPath}`) ||
        f.path.endsWith(`/${cleanPath}`),
    );
    if (matchingOpen) {
      return matchingOpen.ref;
    }

    // 3. If relative path and not starting with '/' or Windows drive 'C:/'
    const isAbsolute = cleanPath.startsWith("/") || /^[a-zA-Z]:\//.test(cleanPath);
    if (!isAbsolute && rootsRef.current.length > 0) {
      // If single root or active root matches, use it
      const targetRoot = rootsRef.current[0];
      if (targetRoot) {
        return { kind: "root", rootId: targetRoot.id, path: cleanPath.replace(/^\/+/, "") };
      }
    }

    // 4. Check loose files
    const looseMatch = looseFilesRef.current.find(
      (lf) => lf.path === cleanPath || lf.path.endsWith(`/${cleanPath}`),
    );
    if (looseMatch) {
      return { kind: "loose", id: looseMatch.id, path: looseMatch.path };
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
  // §8.20.4 DoD: every diagnostic row shows provider/scope/revision/completeness.
  const problemEvidenceLinesByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of problemsScopeFiles) {
      const state = lspFilesRef.current[file.key];
      if (!state) continue;
      for (const wrapped of toProviderDiagnosticsV3(state.diagnostics ?? [], {
        languageId: state.status?.languageId ?? "plaintext",
        provider: { id: "jdtls", version: state.status?.displayName ?? null, generation: lspSessionGeneration() },
        projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: state.status?.uri ?? file.key,
        revision: openFilesRef.current[file.key]?.documentRevision ?? 0,
      })) {
        map.set(
          `${file.key}:${wrapped.diagnostic.message}:${wrapped.diagnostic.range.start.line}`,
          evidencePresentationLine(wrapped.evidence),
        );
      }
    }
    return map;
  }, [lspSessionGeneration, problemsScopeFiles, projectAnalysisSnapshot?.projectFingerprint]);
  const evidenceLineForProblem = useCallback((fileKey: string, diagnostic: LspDiagnostic) => (
    problemEvidenceLinesByKey.get(`${fileKey}:${diagnostic.message}:${diagnostic.range.start.line}`) ?? null
  ), [problemEvidenceLinesByKey]);
  const suppressedInSourceForProblem = useCallback((fileKey: string, diagnostic: LspDiagnostic) => (
    suppressedInSourceKeys.has(
      `${inspectionPathForFileKey(fileKey)}:${diagnosticInspectionId(diagnostic)}:${diagnostic.range.start.line}`,
    )
  ), [inspectionPathForFileKey, suppressedInSourceKeys]);
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
        await debugRef.current?.startDebug({
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
  const activeDebugCurrentLine = useMemo<number | null>(() => {
    const loc = debug.currentLocation;
    if (!loc || !activeFileAbsPath) return null;
    return fsPathEquals(loc.path, activeFileAbsPath) ? loc.line : null;
  }, [activeFileAbsPath, debug.currentLocation]);
  /** The editor is showing the stopped frame: inline values + hover apply here. */
  const debugStoppedHere = debug.state?.status === "stopped" && activeDebugCurrentLine != null;
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
   * project, wait for the jdtls build barrier, then block the launch when the
   * compiler itself reports errors (`failed` / `withError`) — so the debuggee
   * never runs stale bytecode and source lines match the loaded classes.
   * Returns true when it is safe to launch. jdtls / build being unavailable is
   * NOT a block here (the DAP path surfaces those), and a clean build launches
   * even if stale or foreign-language diagnostics sit in the workspace store:
   * published diagnostics are not a compiler verdict, and sweeping them all
   * used to hijack the bottom dock onto Problems for projects that compile.
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
        // The build itself broke (infrastructure, not a compiler verdict). Say
        // so instead of launching stale bytecode.
        const message = "Cannot start debug: the project build failed";
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return false;
      }
      if (status === "withError") {
        // jdtls compiled and reported errors: the compiler's own verdict. Show
        // them where they live instead of launching broken classes.
        const message = "Cannot start debug: the project compiled with errors";
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        setProblemsScope("project");
        setBottomDockTab("problems");
        setBottomDockOpen(true);
        return false;
      }
    } catch (err) {
      // No jdtls session / build unsupported: don't block. The adapter's own
      // main-class / classpath resolution will report a clear error if needed.
      debug.reportStartupProgress(`Skipping pre-launch build: ${errorMessage(err)}`);
      return true;
    }
    if (!mountedRef.current) return false;
    return true;
  }, [
    debug, findRoot, saveOpenBufferText, saveLspDocument, lspDescriptorForPath,
    setBottomDockOpen, setBottomDockTab, setProblemsScope, setStatusMessage,
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
    plan?: RefactorPlanV3;
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
      if (buildRunTools.stepFilters?.enabled) {
        configured.stepFilters = {
          classNameFilters: buildRunTools.stepFilters.patterns,
          skipSynthetics: buildRunTools.stepFilters.skipSynthetics,
          skipStaticInitializers: buildRunTools.stepFilters.skipStaticInitializers,
          skipConstructors: buildRunTools.stepFilters.skipConstructors,
        };
      }
      if (main) {
        // Resolving the classpath + asking java-debug for a port is another
        // multi-second server round trip: name the target so the panel is not
        // blank while it runs.
        debug.reportStartupProgress(`Launching ${main.mainClass}…`);
      }
      void debug.startDebug(configured).catch((err) => setStatusMessage(errorMessage(err)));
    },
    [activeRunConfiguration, activeRunConfigurationOverride, buildRunTools.stepFilters, debug, setStatusMessage],
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
    frame: Pick<DebugStackFrame, "path" | "line"> & Partial<Pick<DebugStackFrame, "sourceReference" | "sourceName" | "name">> & { column?: number },
  ) => {
    // D11.1: line/column arrive 1-based; convert to 0-based exactly once here
    const line0 = frame.line - 1;
    const char0 = (frame.column ?? 1) - 1;
    const range = { start: { line: line0, character: char0 }, end: { line: line0, character: char0 } };
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
      const text = await debugRef.current?.fetchSource(sourceReference);
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
        const diagnostics = displayDiagnosticsFor(
          lspFiles[file.key]?.diagnostics,
          inspectionPathForFileKey(file.key),
        );
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
    displayDiagnosticsFor,
    inspectionPathForFileKey,
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

  // §8.19.6: move-tab menu entries only make sense with another split target.
  const leafCountForMenu = getAllLeafNodes(workspaceUi.layoutTreeV2).length;

  const renderEditorGroup = (groupId: EditorGroupId) => {
    const group = editorGroups[groupId] ?? createEditorGroup(groupId);
    const groupFile = group.activeKey ? openFiles[group.activeKey] ?? null : null;
    const groupLspState = group.activeKey ? lspFiles[group.activeKey] ?? null : null;
    const groupPath = groupFile ? inspectionPathForFileKey(groupFile.key) : undefined;
    const groupHighlightingLevel = groupFile ? getFileHighlightingLevel(groupFile.key) : "all";
    const groupDiagnosticsCurrent = groupFile
      ? currentDiagnosticsForFile(groupFile, groupLspState)
      : null;
    const groupDiagnosticsReady = groupDiagnosticsCurrent !== null;
    const groupDiagnosticsRaw = displayDiagnosticsFor(groupDiagnosticsCurrent, groupPath);
    const groupDiagnostics = groupHighlightingLevel === "none" || groupHighlightingLevel === "syntax"
      ? []
      : groupDiagnosticsRaw;
    const groupCapabilities = groupLspState?.status?.capabilities ?? null;
    const groupMarkdownMode = groupFile && isMarkdownPath(groupFile.languagePath)
      ? markdownModes[groupFile.key] ?? "edit"
      : "edit";
    const groupLanguageId = groupLspState?.status?.languageId
      ?? groupFile?.languagePath.split(".").pop()?.toLowerCase()
      ?? "plain-text";
    const groupReaderMode = groupFile
      ? readerModeByFile[groupFile.key] ?? readReaderModePreference(workspaceInstanceId, groupFile.key)
      : false;
    const groupSoftWrap = !!groupFile && matchesSoftWrapPath(
      groupFile.languagePath,
      editorAppearanceProfile.softWrap.patterns,
    );
    const groupAppearance = {
      fontFamily: editorAppearanceProfile.fontFamily,
      fontSizePx: editorAppearanceProfile.zoomScope === "active-editor"
        ? activeEditorFontSizes[groupId] ?? editorAppearanceProfile.fontSizePx
        : editorAppearanceProfile.fontSizePx,
      lineHeight: editorAppearanceProfile.lineHeight,
      ligatures: editorAppearanceProfile.ligatures,
      colorSchemeId: editorAppearanceProfile.colorSchemeId,
      highContrast: editorAppearanceProfile.highContrast,
      virtualSpace: editorAppearanceProfile.virtualSpace,
    };
    const showGroupBreadcrumbs = (
      editorAppearanceProfile.breadcrumbs.visible
      && matchesBreadcrumbLanguage(
        groupLanguageId,
        editorAppearanceProfile.breadcrumbs.languages,
      )
    ) || navigationBarActiveByGroup[groupId];
    const groupBreadcrumbSegments = groupId === activeEditorGroupId
      ? breadcrumbPathSegments
      : groupFile ? breadcrumbSegmentsForFile(groupFile, roots) : [];

    const groupFileAbsPath = groupFile ? absolutePathForOpenFile(groupFile) : null;
    const groupDebugBreakpoints = (() => {
      if (!groupFileAbsPath) return undefined;
      const key = normalizeFsPath(groupFileAbsPath);
      const list = debug.breakpoints[key] ?? debug.breakpoints[groupFileAbsPath] ?? [];
      const runtime = debug.breakpointRuntime[key] ?? debug.breakpointRuntime[groupFileAbsPath] ?? {};
      const muted = debug.breakpointsMuted;
      return list.map((bp) => {
        const enabled = bp.enabled !== false && !muted;
        const state = runtime[bp.line];
        const verified = !debugSessionActive || state?.status === "verified";
        return {
          line: bp.line,
          conditional: !!(bp.condition || bp.hitCondition),
          logpoint: !!bp.logMessage,
          enabled,
          verified,
        };
      });
    })();
    const groupDebugCurrentLine = (() => {
      const loc = debug.currentLocation;
      if (!loc || !groupFileAbsPath) return null;
      return fsPathEquals(loc.path, groupFileAbsPath) ? loc.line : null;
    })();
    const groupDebugStoppedHere = debug.state?.status === "stopped" && groupDebugCurrentLine != null;
    const groupDebugInlineValues = groupDebugStoppedHere ? debug.frameVariables : undefined;

    const groupBanners = (() => {
      const list: EditorBannerItem[] = [];
      if (workspaceResourceOperationLocked || !!groupFile?.library) {
        list.push({
          id: `ro:${groupFile?.key ?? "global"}`,
          fileKey: groupFile?.key,
          category: "read-only",
          severity: "info",
          title: "File is read-only",
          description: "Modifications cannot be written directly to disk.",
          priority: 100,
          dismissible: false,
          conditionGeneration: "persistent-read-only",
          createdAt: 0,
        });
      }
      const lspError = groupLspState?.status?.error ?? groupLspState?.error ?? null;
      if (lspError && groupFile) {
        const presetId = groupLspState?.status?.presetId ?? "default";
        list.push({
          id: `lsp-error:${groupFile.key}:${presetId}`,
          fileKey: groupFile.key,
          category: "indexing-degraded",
          severity: "warning",
          title: "Language Server Degraded",
          description: lspError,
          priority: 60,
          conditionGeneration: `session-${lspSessionGeneration()}-error-${groupLspState?.errorGeneration ?? 0}`,
          actions: [
            {
              id: "open-settings",
              label: "Configure",
              primary: true,
              run: () => openLanguageServersSettings(groupLspState?.status?.presetId),
            },
          ],
          createdAt: 0,
        });
      }
      return selectActiveBanners(list, groupFile?.key, dismissedBannerKeys);
    })();

    return (
      <EditorGroup
        onClipboardUnavailable={setStatusMessage}
        groupId={groupId}
        workspaceInstanceId={workspaceInstanceId}
        visible={visible}
        editorBanners={groupBanners}
        onDismissBanner={(key) => setDismissedBannerKeys((prev) => new Set(prev).add(key))}
        workspaceActionHost={actionsController.host}
        transactionOwner={documentTransactionOwnerRef.current}
        readOnly={workspaceResourceOperationLocked}
        softWrap={groupSoftWrap}
        appearance={groupAppearance}
        renderedDocEnabled={groupReaderMode}
        renderedDocLanguageId={groupLanguageId}
        onToggleRenderedDocRaw={() => {
          if (groupFile) revealRenderedDocSource(groupFile.key);
        }}
        columnSelectionMode={columnSelectionMode}
        showHoverDocumentation={
          intelligencePreferences.quickDoc.showOnHover
          && groupCapabilities?.hover === true
        }
        hoverDocumentationDelayMs={intelligencePreferences.quickDoc.hoverDelayMs}
        parameterInfoRequestNonce={groupId === activeEditorGroupId ? parameterInfoRequestNonce : 0}
        parameterInfoShowFullSignatures={intelligencePreferences.parameterInfo.showFullSignatures}
        completionController={workspaceLspSessionManagerRef.current?.getCompletionController()}
        onParameterTrigger={handleParameterTrigger}
        onParameterInvalidate={handleParameterInvalidate}
        onParameterEscape={handleParameterEscape}
        // Only the active leaf renders the session-published tooltip; an
        // inactive split must never show another document's anchor.
        parameterPopup={groupId === activeEditorGroupId && parameterPopup.phase === "shown"
          ? parameterPopup.view
          : null}
        tabPolicy={tabPolicy}
        lastUsedByKey={new Map(mruFileKeysRef.current.map((k, idx) => [k, 1_000_000 - idx]))}
        openOrder={group.openOrder}
        openFiles={openFiles}
        activeKey={group.activeKey}
        previewKey={group.previewKey}
        pinnedKeys={group.pinnedKeys}
        activeFile={groupFile}
        activeMarkdownMode={groupMarkdownMode}
        activeDiagnostics={groupDiagnostics}
        activeHighlights={highlightsByGroup[groupId] ?? []}
        activeInlayHints={inlayHintsByGroup[groupId] ?? []}
        activeSemanticTokens={semanticTokensByGroup[groupId] ?? []}
        activeGitChanges={groupFile ? gitLineChangesByFile[groupFile.key] ?? [] : []}
        activeGitBlame={gitBlameByGroup[groupId] ?? null}
        activeCoverage={groupFile && coverageReport ? findFileCoverage(coverageReport, absolutePathForOpenFile(groupFile) ?? groupFile.languagePath) : null}
        coverageEnabled={coverageOverlayEnabled}
        activeCodeStyle={getEffectiveCodeStyleForFile(groupFile)}
        activeDebugBreakpoints={groupDebugBreakpoints}
        activeDebugCurrentLine={groupDebugCurrentLine}
        activeDebugInlineValues={groupDebugInlineValues}
        onToggleBreakpoint={(line) => {
          if (groupFileAbsPath) debug.toggleBreakpoint(normalizeFsPath(groupFileAbsPath), line);
        }}
        onEditBreakpoint={(line) => {
          if (!groupFileAbsPath) return;
          const key = normalizeFsPath(groupFileAbsPath);
          if (!(debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
            debug.toggleBreakpoint(key, line);
          }
          setEditingBreakpoint({ path: key, line });
          setBottomDockTab("debug");
          setBottomDockOpen(true);
        }}
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
        highlightingWidget={groupFile ? (
          <HighlightingWidget
            fileKey={groupFile.key}
            diagnosticScope={groupDiagnosticsReady ? groupLspState?.diagnosticScope : null}
            diagnostics={groupDiagnosticsRaw}
            diagnosticsReady={groupDiagnosticsReady}
            diagnosticsError={groupLspState?.error ?? groupLspState?.status?.error ?? null}
            level={groupHighlightingLevel}
            onChangeLevel={(lvl) => setFileHighlightingLevel(groupFile.key, lvl)}
            providerName={groupLspState?.status?.displayName}
            providerActive={!!groupLspState?.status?.active}
            onNavigateNextError={() => navigateDiagnostic(1)}
            onNavigatePrevError={() => navigateDiagnostic(-1)}
            onOpenSettings={() => openLanguageServersSettings(groupLspState?.status?.presetId)}
            onRestoreEditorFocus={() => {
              const pane = groupId === activeEditorGroupId
                ? editorPaneRef.current
                : inactiveEditorPaneRef.current;
              pane?.querySelector<HTMLElement>(".cm-content")?.focus();
            }}
          />
        ) : null}
        breadcrumbs={showGroupBreadcrumbs && groupFile ? (
          <Breadcrumbs
            pathSegments={groupBreadcrumbSegments}
            symbols={breadcrumbSymbolsByGroup[groupId] ?? []}
            position={cursorPositions[groupId] ?? { line: 0, character: 0 }}
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
            onSymbolClick={(symbol) => {
              revealEditorLocation(groupFile.key, symbol.selectionRange);
              recordNavigationLocation(groupFile.ref, {
                line: symbol.selectionRange.start.line,
                character: symbol.selectionRange.start.character,
              }, { replaceSameFile: false });
            }}
            activeNavigationBar={navigationBarActiveByGroup[groupId]}
            onCloseNavigationBar={() => setNavigationBarActiveByGroup((prev) => ({ ...prev, [groupId]: false }))}
          />
        ) : null}
        breadcrumbsPlacement={editorAppearanceProfile.breadcrumbs.placement}
        activeSymbols={breadcrumbSymbolsByGroup[groupId] ?? []}
        stickyLinesEnabled={intelligencePreferences.stickyLinesEnabled !== false}
        onRevealTargetLine={(line) => groupFile && setRevealTarget({ key: groupFile.key, line, character: 0, nonce: Date.now() })}
        revealTarget={revealTarget}
        editorPaneRef={groupId === activeEditorGroupId ? editorPaneRef : inactiveEditorPaneRef}
        editorPaneStyle={editorPaneStyle}
        onActivate={(key) => {
          flushPendingEditorText();
          setLeafActiveTab(workspaceInstanceId, groupId, key);
          updateEditorGroup(groupId, (current) => ({ ...current, activeKey: key }));
          activateEditorGroup(groupId);
          if (key) {
            void ensureLspDocumentSynced(key);
          }
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
        onMoveTabToNextSplit={leafCountForMenu > 1 ? (key) => moveTabToAdjacentSplitFrom(groupId, key, 1) : undefined}
        onMoveTabToPreviousSplit={leafCountForMenu > 1 ? (key) => moveTabToAdjacentSplitFrom(groupId, key, -1) : undefined}
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
        onPinHoverDoc={pinQuickDocumentation}
        onDefinition={goToDefinition}
        onReferences={findReferences}
        onComplete={getLspCompletions}
        onCompletionIdentity={completionIdentityForFile}
        onCompletionDiagnostic={reportCompletionDiagnostic}
        onCompleteResolve={resolveLspCompletion}
        onSelectionChange={(selection) => {
          if (groupId === activeEditorGroupId) {
            editorSelectionRef.current = selection;
            setEditorCommandContextRevision((revision) => revision + 1);
            setEditorAiSelection(!selection.empty && selection.text.trim().length >= 2 ? selection : null);
          }
          if (groupFile) {
            noteCaretPosition(groupFile.key, selection.end);
          }
          setCursorPositions((current) => {
            const prev = current[groupId];
            if (prev && prev.line === selection.end.line && prev.character === selection.end.character) {
              return current;
            }
            return { ...current, [groupId]: selection.end };
          });
        }}
        onViewportChange={(range) => {
          setViewportRanges((current) => {
            const prev = current[groupId];
            if (
              prev &&
              prev.start.line === range.start.line &&
              prev.start.character === range.start.character &&
              prev.end.line === range.end.line &&
              prev.end.character === range.end.character
            ) {
              return current;
            }
            return { ...current, [groupId]: range };
          });
          if (syncSplitScroll && splitOrientation) {
            // §8.17.4: sync to every OTHER tree leaf (any depth/count), not a
            // hardcoded primary<->secondary swap.
            const siblingLeaves = getAllLeafNodes(workspaceUi.layoutTreeV2)
              .map((leaf) => leaf.id as EditorGroupId)
              .filter((leafId) => leafId !== groupId);
            for (const siblingId of siblingLeaves) {
              const siblingActiveKey = editorGroups[siblingId]?.activeKey;
              const siblingFile = siblingActiveKey ? openFiles[siblingActiveKey] : null;
              if (!siblingFile || syncScrollOriginGroupIdRef.current === siblingId) continue;
              syncScrollOriginGroupIdRef.current = groupId;
              revealEditorLocation(siblingFile.key, {
                start: { line: range.start.line, character: 0 },
                end: { line: range.start.line, character: 0 },
              });
              setTimeout(() => {
                if (syncScrollOriginGroupIdRef.current === groupId) {
                  syncScrollOriginGroupIdRef.current = null;
                }
              }, 50);
              break;
            }
          }
        }}
        onExpandSelection={getLspSelectionRanges}
        onLightbulb={(line) => void openCodeActionsForLine(line)}
        onEditorContextMenu={showEditorContextMenu}
        onEditorCommandPortChange={registerEditorCommandPort}
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

  const renderRecursiveLayoutNode = (
    node: LayoutNode,
    renderGroup: (groupId: EditorGroupId) => ReactNode,
  ): ReactNode => {
    if (node.type === "leaf") {
      return renderGroup(node.id);
    }
    return (
      <PanelGroup
        key={node.id}
        orientation={node.orientation === "vertical" ? "horizontal" : "vertical"}
        id={`recursive-split-${node.id}`}
        className="h-full min-h-0"
          onLayoutChanged={(layout) => {
            const ratios = panelLayoutToRatios(layout, node.children.map((child) => child.id));
            if (ratios) setLayoutNodeRatios(workspaceInstanceId, node.id, ratios);
          }}
      >
        {node.children.map((child, index) => {
          const pct = node.ratios[index] ? `${Math.round(node.ratios[index] * 100)}%` : `${Math.round(100 / node.children.length)}%`;
          return (
            <Fragment key={child.id}>
              {index > 0 && (
                <PanelResizeHandle
                  className={node.orientation === "vertical"
                    ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"
                    : "h-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"}
                />
              )}
              <Panel id={`panel-${child.id}`} defaultSize={pct} minSize="10%" className="min-h-0 min-w-0">
                {renderRecursiveLayoutNode(child, renderGroup)}
              </Panel>
            </Fragment>
          );
        })}
      </PanelGroup>
    );
  };

  return (
    <WorkspaceClipboardSessionContext.Provider value={clipboardHandle}>
      <div
        ref={rootRef}
        data-testid="code-workspace-tab"
        data-layout-revision={layoutRevision}
        data-clipboard-revision={clipboardSnapshot.revision}
        data-clipboard-history-revision={clipboardSnapshot.historyRevision}
        data-clipboard-consumer-count={clipboardSnapshot.consumerCount}
        data-tab-policy-limit={tabPolicy.limitPerLeaf}
        data-tab-policy-order={tabPolicy.order}
        data-reopen-stack-count={closedTabsStack.length}
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
        {projectFactsRoot && (
          <ProjectFactsStatusBadge
            status={projectFacts.status}
            discoveryStatus={projectDescriptorDiscovery.status}
            discovery={projectDescriptorDiscovery.discovery}
            discoveryReason={projectDescriptorDiscovery.reason}
            reason={projectFacts.reason}
            generation={projectFacts.generation}
            isStale={projectFacts.isStale}
            onRefresh={refreshProjectFacts}
          />
        )}
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
            disabled={currentEditorFontSize <= CODE_WORKSPACE_MIN_FONT_SIZE}
            onClick={() => stepCodeViewFontSize(-1)}
          />
          <button
            type="button"
            data-testid="code-workspace-zoom-reset"
            title="Reset editor zoom"
            aria-label="Reset editor zoom"
            className="h-6 min-w-10 rounded px-1.5 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx)}
          >
            {currentEditorFontSize}px
          </button>
          <IconButton
            label="Editor zoom in"
            testId="code-workspace-zoom-in"
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            disabled={currentEditorFontSize >= CODE_WORKSPACE_MAX_FONT_SIZE}
            onClick={() => stepCodeViewFontSize(1)}
          />
        </div>
        <IconButton
          label={activeFileSoftWrap ? "Disable soft wrap" : "Enable soft wrap"}
          testId="code-workspace-soft-wrap"
          active={activeFileSoftWrap}
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
          <>
            <IconButton
              label={syncSplitScroll ? "Disable synchronized split scrolling" : "Enable synchronized split scrolling"}
              testId="code-workspace-split-sync-scroll"
              icon={<Link2 className="h-3.5 w-3.5" />}
              active={syncSplitScroll}
              onClick={() => {
                setSyncSplitScroll((v) => {
                  const next = !v;
                  setStatusMessage(next ? "Synchronized split scrolling enabled" : "Synchronized split scrolling disabled");
                  return next;
                });
              }}
            />
            <IconButton
              label="Equalize split proportions"
              testId="code-workspace-split-equalize"
              icon={<AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />}
              onClick={() => executeWorkspaceCommand("workspace.equalizeSplitProportions")}
            />
            <IconButton
              label="Stretch active split"
              testId="code-workspace-split-stretch"
              icon={<Maximize2 className="h-3.5 w-3.5" />}
              onClick={() => executeWorkspaceCommand("workspace.stretchActiveSplit")}
            />
            <IconButton
              label="Unsplit all (keep tabs)"
              testId="code-workspace-split-unsplit-all"
              icon={<Square className="h-3.5 w-3.5" />}
              onClick={() => executeWorkspaceCommand("workspace.unsplitAll")}
            />
            <IconButton
              label="Close editor split"
              testId="code-workspace-split-close"
              icon={<X className="h-3.5 w-3.5" />}
              onClick={closeSplit}
            />
          </>
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
        <IconButton
          label="Editor tab policy settings"
          testId="code-workspace-tab-policy-settings"
          icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
          onClick={openTabPolicySettings}
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
          {workspaceUi.layoutTreeV2.type === "split" ? (
            <div data-testid="code-workspace-editor-split" className="h-full min-h-0">
              {renderRecursiveLayoutNode(workspaceUi.layoutTreeV2, renderEditorGroup)}
            </div>
          ) : renderRecursiveLayoutNode(workspaceUi.layoutTreeV2, renderEditorGroup)}
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
                    symbols={breadcrumbSymbolsByGroup[activeEditorGroupId] ?? []}
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
                    onOpenSource={openReferenceSource}
                    canGoBack={referenceHistory.canGoBack}
                    canGoForward={referenceHistory.canGoForward}
                    onBack={referenceHistoryBack}
                    onForward={referenceHistoryForward}
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
                evidenceLine={evidenceLineForProblem}
                suppressedInSource={suppressedInSourceForProblem}
                fullProjectNote={activeCapabilities?.workspaceDiagnostics === true
                  ? null
                  : "On-the-fly diagnostics only — this server does not expose workspace-wide diagnostics."}
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
                projectAnalysis={projectAnalysisSnapshot}
                projectAnalysisProbing={projectAnalysisProbing}
                onRefreshProjectAnalysis={refreshProjectAnalysis}
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
                pinned={referencesPinned}
                onPinChange={(pinned) => {
                  setReferencesPinned(pinned);
                  usageSessionRef.current?.setPinned(pinned);
                }}
                onRerun={rerunFindReferences}
                scopeSelection={usagesScopeSelection}
                recentSessions={usageSessionRef.current?.getRecent().map((snapshot) => ({
                  id: snapshot.id,
                  label: `${snapshot.symbol.displayName || "symbol"} · ${snapshot.envelope.results.length} · ${new Date(snapshot.createdAt).toLocaleTimeString()}`,
                })) ?? []}
                onRestoreRecent={(id) => {
                  usageSessionRef.current?.restore(id);
                  setUsagesRecentsRevision((revision) => revision + 1);
                }}
                recentsRevision={usagesRecentsRevision}
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
                staleReason={(() => {
                  const provenance = hierarchyProvenanceRef.current.call;
                  if (!provenance || !callHierarchyRoot) return null;
                  void hierarchyProvenanceRevision;
                  if (provenance.generation !== lspSessionGeneration()) {
                    return "Provider restarted since this hierarchy was prepared";
                  }
                  const current = projectAnalysisSnapshot?.projectFingerprint ?? "";
                  if (current && provenance.projectFingerprint !== current) {
                    return "Project model changed since this hierarchy was prepared";
                  }
                  return null;
                })()}
                onRerunStale={() => void openHierarchy("call")}
                onOpenLocation={(location) => void openLspLocation(location)}
                queryHost={semanticQueryHostRef.current}
                liveLspGeneration={lspSessionGeneration}
                liveDocumentRevision={() => openFilesRef.current[callHierarchyRoot?.fileKey ?? ""]?.documentRevision ?? -1}
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
                staleReason={(() => {
                  const provenance = hierarchyProvenanceRef.current.type;
                  if (!provenance || !typeHierarchyRoot) return null;
                  void hierarchyProvenanceRevision;
                  if (provenance.generation !== lspSessionGeneration()) {
                    return "Provider restarted since this hierarchy was prepared";
                  }
                  const current = projectAnalysisSnapshot?.projectFingerprint ?? "";
                  if (current && provenance.projectFingerprint !== current) {
                    return "Project model changed since this hierarchy was prepared";
                  }
                  return null;
                })()}
                onRerunStale={() => void openHierarchy("type")}
                onOpenLocation={(location) => void openLspLocation(location)}
                queryHost={semanticQueryHostRef.current}
                liveLspGeneration={lspSessionGeneration}
                liveDocumentRevision={() => openFilesRef.current[typeHierarchyRoot?.fileKey ?? ""]?.documentRevision ?? -1}
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
                onRenameBookmarkGroup={renameBookmarkGroup}
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
            id: "coverage",
            label: "Coverage",
            icon: <ShieldCheck className="h-3.5 w-3.5" />,
            badge: coverageReport ? `${coverageReport.totalPercentage}%` : undefined,
            content: (
              <CoveragePanel
                report={coverageReport}
                coverageEnabled={coverageOverlayEnabled}
                onToggleCoverage={() => setCoverageOverlayEnabled((prev) => !prev)}
                onOpenFile={(path, line) => {
                  const ref = problemPathToRef(path);
                  if (ref) {
                    const targetLine = line && line > 0 ? line - 1 : 0;
                    const range = { start: { line: targetLine, character: 0 }, end: { line: targetLine, character: 0 } };
                    void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
                  }
                }}
                onRefreshCoverage={() => void scanWorkspaceCoverage()}
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
                onOpenBreakpoint={(path, line, column) => openDebugFrame({ path, line, column })}
                onOpenLocation={(path, line, column) => openDebugFrame({ path, line, column })}
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
                workspaceInstanceId={workspaceInstanceId}
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
      <TabSwitcher
        open={tabSwitcherOpen}
        entries={switcherSnapshot?.editors ?? []}
        toolWindows={switcherSnapshot?.tools ?? []}
        selectedIndex={tabSwitcherIndex}
        onHover={setTabSwitcherIndex}
        onCommit={commitTabSwitcher}
        onCancel={() => {
          setTabSwitcherOpen(false);
          setSwitcherSnapshot(null);
        }}
      />
      <WorkspacePopupsHost
        searchEverywhereOpen={searchEverywhereOpen}
        searchEverywhereMode={searchEverywhereMode}
        goToFileItems={goToFileItems}
        goToFileLoading={goToFileLoading}
        goToFileTruncated={goToFileTruncated}
        actionSnapshots={actionsController.snapshot.filter((entry) => entry.id !== "workspace.goToFile")}
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
        recentLocationsOpen={recentLocationsOpen}
        recentLocationsChangedOnly={recentLocationsChangedOnly}
        workspaceId={workspaceInstanceId}
        locationController={workspaceLocationControllerRef.current}
        navigationFacade={navigationHistoryFacade}
        onCloseRecentLocations={() => setRecentLocationsOpen(false)}
        onPickRecentLocation={(loc) => {
          setRecentLocationsOpen(false);
          const targetOpen = openFiles[loc.fileIdentity];
          if (targetOpen) {
            void openFile(targetOpen.ref).then(() => {
              revealEditorLocation(targetOpen.key, {
                start: { line: loc.line, character: loc.character },
                end: { line: loc.line, character: loc.character },
              });
            });
          } else {
            const matchingRoot = roots.find((r) => loc.filePath.startsWith(r.path));
            if (matchingRoot) {
              const relPath = loc.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
              void openFile({ kind: "root", rootId: matchingRoot.id, path: relPath }).then(() => {
                const key = `root:${matchingRoot.id}:${relPath}`;
                revealEditorLocation(key, {
                  start: { line: loc.line, character: loc.character },
                  end: { line: loc.line, character: loc.character },
                });
              });
            } else {
              void openFile({ kind: "loose", id: loc.fileIdentity, path: loc.filePath }).then(() => {
                revealEditorLocation(loc.fileIdentity, {
                  start: { line: loc.line, character: loc.character },
                  end: { line: loc.line, character: loc.character },
                });
              });
            }
          }
        }}
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
        onOpenQuickDocSource={openReferenceSource}
        quickDocCanGoBack={referenceHistory.canGoBack}
        quickDocCanGoForward={referenceHistory.canGoForward}
        onQuickDocBack={referenceHistoryBack}
        onQuickDocForward={referenceHistoryForward}
        locationPeek={locationPeek}
        onCloseLocationPeek={() => setLocationPeek(null)}
        onOpenLocation={(location) => {
          setLocationPeek(null);
          void openLspLocation(location);
        }}
      />
      {treeContextMenu}
      {editorContextMenu}
      <UsagesScopeDialog
        open={!!usagesScopeDialog?.open}
        symbolHint={usagesScopeDialog?.file.subtitle ?? null}
        onConfirm={confirmUsagesScope}
        onCancel={() => {
          setUsagesScopeDialog(null);
          setStatusMessage("Find Usages cancelled");
        }}
      />
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
      {visible && workspaceRecoveryOpen && (workspaceRecoveryEntries.length > 0 || diskEffectLedgerEntries.length > 0) && externalFileConflicts.length === 0 && (
        <WorkspaceRecoveryDialog
          entries={workspaceRecoveryEntries}
          onRecover={(entry) => {
            void recoverWorkspaceEntry(entry);
          }}
          onDiscard={discardWorkspaceRecoveryEntry}
          onRecoverAll={recoverAllWorkspaceEntries}
          onDiscardAll={discardAllWorkspaceRecoveryEntries}
          onClose={() => setWorkspaceRecoveryOpen(false)}
          ledgerEntries={diskEffectLedgerEntries}
          onAcknowledgeLedgerEntry={acknowledgeDiskEffectLedgerEntry}
          onReopenLedgerEntry={reopenDiskEffectLedgerFile}
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
          onClose={() => setLocalHistoryTarget(null)}
          onRestore={(text) => restoreLocalHistoryText(localHistoryTarget.key, text)}
          onCompare={(entry, text) => {
            compareLocalHistorySnapshot(localHistoryTarget.key, entry, text);
          }}
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
      {editorAppearanceSettingsOpen && (
        <WorkspaceEditorAppearanceSettingsDialog
          open={editorAppearanceSettingsOpen}
          profile={editorAppearanceProfile}
          onApply={(next) => {
            updateEditorAppearanceProfile(next);
            setStatusMessage("Saved workspace editor appearance settings");
          }}
          onClearClipboardHistory={() => {
            clipboardHandle.clearHistory();
            setClipboardHistoryEntries([]);
            setStatusMessage("Cleared clipboard history for current workspace session");
          }}
          onClose={() => setEditorAppearanceSettingsOpen(false)}
        />
      )}
      {tabPolicySettingsOpen && (
        <WorkspaceTabPolicySettingsDialog
          open={tabPolicySettingsOpen}
          policy={tabPolicy}
          openTabs={openOrder.map((key) => ({
            key,
            title: openFiles[key]?.title ?? key,
            dirty: !!openFiles[key]?.dirty,
            pinned: (selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[activeEditorGroupId]?.pinnedKeys ?? []).includes(key),
          }))}
          onApply={(nextPolicyRaw) => {
            const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
            void applyWorkspaceTabPolicyTransaction({
              workspaceInstanceId,
              nextPolicyRaw,
              currentPolicy: tabPolicyRef.current,
              currentGroups: currentUi.editorGroups,
              openFiles: openFilesRef.current,
              mruFileKeys: mruFileKeysRef.current,
              baseLayoutRevision: baseLayoutRevision,
              currentLayoutRevision: currentUi.layoutRevision,
              getLiveLayoutRevision: () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).layoutRevision,
              confirmDirtyClose: async (dirtyKeys) => {
                const names = dirtyKeys.map((k) => openFilesRef.current[k]?.title ?? k).join(", ");
                return window.confirm(`The following files have unsaved changes:\n${names}\n\nApply tab limit policy and discard changes?`);
              },
              onEvictClosedFile: async (evictedKey) => {
                const file = openFilesRef.current[evictedKey];
                const coordinator = resourceRecoveryCoordinatorRef.current;
                const currentUiNow = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
                const currentTree = currentUiNow.layoutTreeV2;
                const activeLeaf = findLeafNode(currentTree, activeEditorGroupId);

                await coordinator.executeResourceCleanup(evictedKey, {
                  didClose: () => {
                    if (file) closeLspDocument(file);
                  },
                  watcher: () => {
                    const pending = pendingExternalFileEventsRef.current.get(evictedKey);
                    if (pending) {
                      window.clearTimeout(pending.timer);
                      pendingExternalFileEventsRef.current.delete(evictedKey);
                    }
                  },
                  buffer: () => {
                    saveTransactionRegistryRef.current.discardFile(
                      workspaceInstanceId,
                      evictedKey,
                      `Buffer ${file?.subtitle ?? evictedKey} was evicted`,
                    );
                    setOpenFiles((prev) => {
                      if (!(evictedKey in prev)) return prev;
                      const next = { ...prev };
                      delete next[evictedKey];
                      return next;
                    });
                    setMarkdownModes((prev) => {
                      if (!(evictedKey in prev)) return prev;
                      const next = { ...prev };
                      delete next[evictedKey];
                      return next;
                    });
                    setLspFiles((prev) => {
                      if (!(evictedKey in prev)) return prev;
                      const next = { ...prev };
                      delete next[evictedKey];
                      return next;
                    });
                  },
                  history: () => {
                    if (file) {
                      setClosedTabsStack((stack) =>
                        pushClosedTab(stack, {
                          fileIdentity: workspaceFileIdentity(file.ref),
                          ref: file.ref,
                          title: file.title,
                          subtitle: file.subtitle,
                          leafPath: [activeEditorGroupId],
                          closedAt: Date.now(),
                          location: {
                            leafId: activeEditorGroupId,
                            treeRoute: buildReopenTreeRoute(currentTree, activeEditorGroupId),
                            siblingFileKeys: (activeLeaf?.openFileKeys ?? []).filter((k) => k !== evictedKey),
                          },
                        }),
                      );
                    }
                  },
                });
              },
              commitAtomicUpdate: ({ nextGroups, policy }) => {
                useCodeWorkspaceStore.getState().patchInstance(workspaceInstanceId, {
                  editorGroups: nextGroups as typeof currentUi.editorGroups,
                  layoutRevision: currentUi.layoutRevision + 1,
                });
                setTabPolicy(policy);
                tabPolicyRef.current = policy;
                setTabPolicyRevision((r) => r + 1);

                const persistableGroups = Object.fromEntries(
                  (Object.entries(nextGroups) as Array<[EditorGroupId, typeof currentUi.editorGroups.primary]>)
                    .map(([groupId, group]) => [groupId, {
                      ...group,
                      openOrder: group.openOrder.filter((key) => !libraryBuffersRef.current[key]),
                      pinnedKeys: group.pinnedKeys.filter((key) => !libraryBuffersRef.current[key]),
                      activeKey: group.activeKey && libraryBuffersRef.current[group.activeKey] ? null : group.activeKey,
                      previewKey: group.previewKey && libraryBuffersRef.current[group.previewKey] ? null : group.previewKey,
                    }]),
                ) as typeof currentUi.editorGroups;

                let persistenceIssue: string | null = null;
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
                  layoutTreeV2: currentUi.layoutTreeV2,
                  tabPolicy: policy,
                }), {
                  onIssue: (message) => {
                    persistenceIssue = message;
                    setStatusMessage(message);
                  },
                });
                return {
                  persisted: persistenceIssue === null,
                  persistenceIssue,
                };
              },
            }).then((result) => {
              setStatusMessage(result.message);
            });
          }}
          onClose={() => setTabPolicySettingsOpen(false)}
        />
      )}
      {intelligenceSettingsOpen && (
        <WorkspaceIntelligenceSettingsDialog
          open={intelligenceSettingsOpen}
          preferences={intelligencePreferences}
          onApply={(next) => {
            setIntelligencePreferences(next);
            setStatusMessage("Saved editor intelligence settings");
          }}
          onClose={() => setIntelligenceSettingsOpen(false)}
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
          plan={refactoringPreviewModal.plan}
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
      {activeCompareSession && (
        <EditorCompareDialog
          session={activeCompareSession}
          onClose={() => setActiveCompareSession(null)}
          onApplyRight={(newText) => applyCompareSession(activeCompareSession, newText)}
        />
      )}
      <ClipboardHistoryPopup
        open={clipboardHistoryOpen}
        entries={clipboardHistoryEntries}
        onPaste={(index) => {
          executeActiveEditorCommand("pasteFromHistory", { historyIndex: index });
        }}
        onDelete={(index) => {
          clipboardHandle.removeHistoryEntry(index);
          setClipboardHistoryEntries([...clipboardHandle.historyEntries()]);
        }}
        onClear={() => {
          clipboardHandle.clearHistory();
          setClipboardHistoryEntries([]);
        }}
        onClose={() => setClipboardHistoryOpen(false)}
      />
      <GenerateCodeDialog
        open={generateCode.open}
        phase={generateCode.phase}
        candidates={generateCode.candidates}
        error={generateCode.error}
        onApply={(ids) => void applyGenerateCandidates(ids)}
        onRetry={() => void requestGenerateCandidates()}
        onCancel={closeGenerateDialog}
      />
      <SurroundWithDialog
        open={surroundWithDialogOpen}
        languageId={activeLanguageId}
        onClose={() => setSurroundWithDialogOpen(false)}
        onPick={(kindId) => {
          const dispatched = executeActiveEditorCommand("surroundWith", {
            surroundKindId: kindId,
            onSemanticEditApplied: ({ applied, provenance }) => {
              if (!applied) {
                setStatusMessage("Surround requires a whole-line selection in one range");
                return;
              }
              // §8.19.8 honest provenance surfacing: local templates never
              // masquerade as Semantic in status reporting.
              setStatusMessage(
                provenance?.kind === "syntax-tree"
                  ? `Surround applied (syntax node ${provenance.nodeType})`
                  : "Surround applied (local template)",
              );
            },
          });
          if (!dispatched) setStatusMessage("Surround requires an active editor");
        }}
      />
      {keymapCheatSheetOpen && (
        <KeymapCheatSheetDialog
          open={true}
          actionSnapshots={actionsController.snapshot}
          onClose={() => setKeymapCheatSheetOpen(false)}
          onExecuteCommand={(cmdId) => {
            // §8.17.3: cheatsheet runs the rendered frozen evaluation.
            const entry = actionsController.snapshot.find((item) => item.id === cmdId);
            if (!entry) return;
            void actionsController.host.executePrepared(entry.evaluation);
          }}
        />
      )}
      {keymapSettingsOpen && (
        <KeymapSettingsDialog
          open={true}
          snapshot={actionsController.snapshot}
          schemes={keymapSchemes}
          activeSchemeId={activeKeymapSchemeId}
          defaultSchemeName="IDEA defaults"
          corruptDiagnostic={keymapCorruptDiagnostic}
          onActiveSchemeChange={setActiveKeymapSchemeId}
          onSchemesChange={(schemes) => setKeymapSchemes([...schemes])}
          onApplyScheme={applyKeymapScheme}
          onClose={() => setKeymapSettingsOpen(false)}
        />
      )}
      <CodeStyleSettingsDialog
        open={codeStyleSettingsOpen}
        store={codeStyleSchemes}
        activeLanguageId={(() => {
          const ext = activeFile?.languagePath.split(".").pop()?.toLowerCase() ?? "";
          return ext || null;
        })()}
        provenance={activeFile ? {
          filePath: activeFile.subtitle,
          effectiveLabel: getEffectiveCodeStyleForFile(activeFile)?.label ?? "—",
          source: getEffectiveCodeStyleForFile(activeFile)?.source ?? "fallback",
          schemeName: activeSchemeForLanguage(
            codeStyleSchemes,
            activeFile.languagePath.split(".").pop()?.toLowerCase() || null,
          ).name,
        } : null}
        onChange={changeCodeStyleSchemes}
        onClose={() => setCodeStyleSettingsOpen(false)}
      />
      {dapGuideOpen && (
        <DapAdapterGuideDialog
          open={true}
          onClose={() => setDapGuideOpen(false)}
        />
      )}
      </div>
    </WorkspaceClipboardSessionContext.Provider>
  );
}
