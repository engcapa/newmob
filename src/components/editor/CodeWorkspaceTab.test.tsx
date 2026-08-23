import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { StrictMode, useCallback, useRef, useState, type ComponentProps } from "react";
import { useAppStore } from "../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../stores/codeWorkspaceStore";
import { useCodeWorkspaceStatusStore } from "../../stores/codeWorkspaceStatusStore";
import { DEFAULT_CODE_VIEW_PROFILE, saveCodeViewProfile } from "../../lib/codeViewProfile";
import {
  editorAppearanceProfileStorageKey,
  writeEditorAppearanceProfile,
} from "./workspace/editorAppearanceProfile";
import type { CodeWorkspaceTabInfo } from "../../types";
import type {
  LspCapabilitySummary,
  LspDocumentStatus,
  LspServerStatus,
} from "../../lib/editor/lsp";
import type { StructuredTestResults, WorkspaceEntry, WorkspaceFile, WorkspaceWriteAck } from "../../lib/editor/workspace";
import { CodeWorkspaceTab, extractContextSnippet } from "./CodeWorkspaceTab";
import { emit } from "@tauri-apps/api/event";
import { WORKSPACE_RECOVERY_STORAGE_PREFIX } from "./workspace/workspaceRecovery";
import type { WorkspaceCommandRegistration } from "./workspace/workspaceCommands";
import { confirmAppDialog } from "../../lib/appDialogs";
import { workspaceActionRegistry } from "./workspace/workspaceActionRegistry";
import {
  navigationHistoryTracker,
  WorkspaceLocationController,
} from "./workspace/navigationHistoryModel";
import { globalEditorConfigResolver } from "./workspace/editorConfigResolver";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceCompactChain: vi.fn(),
  workspaceListFilesRecursive: vi.fn(),
  workspaceDetectGitRoots: vi.fn(),
  workspaceDetectTasks: vi.fn(),
  workspaceExecutionModel: vi.fn(),
  workspaceJavaRunTargets: vi.fn(),
  workspaceJavaRunTarget: vi.fn(),
  workspaceTaskTree: vi.fn(),
  workspaceTestResults: vi.fn(),
  workspaceDependencyTree: vi.fn(),
  workspaceReadFile: vi.fn(),
  workspaceReadLooseFile: vi.fn(),
  workspaceReadFileWithEncoding: vi.fn(),
  workspaceReadLooseFileWithEncoding: vi.fn(),
  workspaceWriteFile: vi.fn(),
  workspaceWriteLooseFile: vi.fn(),
  workspaceWriteFileEncoded: vi.fn(),
  workspaceWriteLooseFileEncoded: vi.fn(),
  workspaceCreateFile: vi.fn(),
  workspaceCreateDir: vi.fn(),
  workspaceDeletePath: vi.fn(),
  workspaceRenamePath: vi.fn(),
  workspaceApplyResourceOperation: vi.fn(),
}));

const lspMocks = vi.hoisted(() => ({
  lspDetectServers: vi.fn(),
  lspSetJavaHome: vi.fn(),
  lspSetJavaVmargs: vi.fn(),
  lspSetJavaSettings: vi.fn(),
  lspSetJavaBundles: vi.fn(),
  lspOpenDocument: vi.fn(),
  lspChangeDocument: vi.fn(),
  lspSaveDocument: vi.fn(),
  lspCloseDocument: vi.fn(),
  lspStopWorkspace: vi.fn(),
  lspGetDiagnostics: vi.fn(),
  lspHover: vi.fn(),
  lspDefinition: vi.fn(),
  lspPrepareRename: vi.fn(),
  lspRename: vi.fn(),
  lspReadUriContents: vi.fn(),
  lspDownloadSources: vi.fn(),
  lspReloadProject: vi.fn(),
  lspJavaModules: vi.fn(),
  lspWorkspaceDiagnostics: vi.fn(),
  lspBuildWorkspace: vi.fn(),
  javaTestDiscover: vi.fn(),
  lspReferences: vi.fn(),
  lspPrepareCallHierarchy: vi.fn(),
  lspCallHierarchyIncoming: vi.fn(),
  lspCallHierarchyOutgoing: vi.fn(),
  lspPrepareTypeHierarchy: vi.fn(),
  lspTypeHierarchySupertypes: vi.fn(),
  lspTypeHierarchySubtypes: vi.fn(),
  lspDocumentSymbols: vi.fn(),
  lspDocumentHighlights: vi.fn(),
  lspInlayHints: vi.fn(),
  lspSemanticTokens: vi.fn(),
  lspSelectionRanges: vi.fn(),
  lspCompletion: vi.fn(),
  lspCompletionResolve: vi.fn(),
  lspSignatureHelp: vi.fn(),
  lspFormatting: vi.fn(),
  lspRangeFormatting: vi.fn(),
  lspCodeActions: vi.fn(),
  lspCodeActionResolve: vi.fn(),
  lspWorkspaceSymbols: vi.fn(),
  lspWorkspaceSymbolResolve: vi.fn(),
  lspExecuteCommand: vi.fn(),
  lspResolveWorkspaceEdit: vi.fn(),
  lspResolveShowMessageRequest: vi.fn(),
  lspCancelWorkDoneProgress: vi.fn(),
  lspWorkspaceDidFileOperation: vi.fn(),
  lspWorkspaceDidChangeWatchedFiles: vi.fn(),
  lspStartWorkspaceWatcher: vi.fn(),
  lspStopWorkspaceWatcher: vi.fn(),
  lspWorkspaceWillFileOperation: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  selectFilePath: vi.fn(),
  selectFolderPath: vi.fn(),
}));

const dapMocks = vi.hoisted(() => ({
  dapStartSession: vi.fn(),
  dapSendRequest: vi.fn(),
  dapSend: vi.fn(),
  dapTerminate: vi.fn(),
  listenDapEvents: vi.fn(),
  dapResolveJavaMainClasses: vi.fn(),
}));

vi.mock("../../lib/editor/dap", () => dapMocks);

/**
 * Whether the component sees the desktop runtime. Defaults to false (the value
 * every other test in this file has always run with); the Java debug test opts
 * in, since the Debug button is disabled outside the Tauri webview.
 */
const runtimeState = vi.hoisted(() => ({ tauri: false }));

vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/runtime")>()),
  isTauriRuntime: () => runtimeState.tauri,
}));

const clipboardMocks = vi.hoisted(() => ({
  readText: vi.fn(async () => ""),
  readTextResult: vi.fn(async () => ({ ok: true, text: "" })),
  writeText: vi.fn(async () => {}),
}));

const settingsNavigationMocks = vi.hoisted(() => ({
  openSettingsSection: vi.fn(),
}));

vi.mock("../../lib/clipboard", () => clipboardMocks);

vi.mock("../../lib/settingsNavigation", () => settingsNavigationMocks);

// CodeWorkspaceTab is rendered in isolation (without the app-level dialog
// provider). Auto-confirm preview-only WorkspaceEdits so those tests can
// continue to assert the resource operation lifecycle itself.
vi.mock("../../lib/appDialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/appDialogs")>()),
  confirmAppDialog: vi.fn(async () => true),
}));

const gitMocks = vi.hoisted(() => ({
  gitSnapshot: vi.fn(),
  gitIgnorePath: vi.fn(),
  gitBlobPair: vi.fn(),
  gitBlameLines: vi.fn(),
  gitChangeLabel: vi.fn((change: { conflict?: boolean; status: string }) => (
    change.conflict ? "Conflicted" : change.status[0]?.toUpperCase() + change.status.slice(1)
  )),
}));

vi.mock("../../lib/editor/workspace", () => workspaceMocks);

vi.mock("../../lib/editor/lsp", () => lspMocks);

vi.mock("@tauri-apps/api/event", () => import("../../stubs/tauri-event"));

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../../lib/git", () => gitMocks);

const localHistoryMocks = vi.hoisted(() => ({
  historySnapshot: vi.fn(async () => null),
  historyList: vi.fn(async () => []),
  historyRevert: vi.fn(async () => null),
  historyPurge: vi.fn(async () => null),
}));

vi.mock("../../lib/localHistory", () => localHistoryMocks);

const chatMocks = vi.hoisted(() => ({
  attachToComposer: vi.fn(async () => undefined),
  explainSelection: vi.fn(async () => undefined),
  sendPromptToTabChat: vi.fn(async () => undefined),
}));

vi.mock("../../stores/chatStore", () => ({
  useChatStore: (selector: (state: typeof chatMocks) => unknown) => selector(chatMocks),
}));

vi.mock("../git/diffLanguage", () => ({
  languageForPath: vi.fn(async () => null),
}));

vi.mock("../terminal/TerminalPanel", () => ({
  TerminalPanel: ({
    tabId,
    initialCwd,
    onTaskExit,
  }: {
    tabId?: string;
    initialCwd?: string;
    onTaskExit?: (exitCode: number) => void;
  }) => (
    <div data-testid="mock-workspace-terminal" data-tab-id={tabId} data-initial-cwd={initialCwd}>
      <button
        type="button"
        data-testid="mock-workspace-terminal-task-exit"
        onClick={() => onTaskExit?.(0)}
      >
        task-exit
      </button>
    </div>
  ),
}));

function file(
  path: string,
  text: string,
  overrides: Partial<WorkspaceFile> = {},
): WorkspaceFile {
  return {
    path,
    text,
    size: text.length,
    mtime: 1_788_888_888,
    hash: `hash-${path}`,
    ...overrides,
  };
}

/** Native write ack (§8.18.1): the decoded file plus the written byte identity. */
function writeAck(
  written: WorkspaceFile,
  overrides: Partial<Omit<WorkspaceWriteAck, "file">> = {},
): WorkspaceWriteAck {
  return {
    file: written,
    writtenHash: written.hash,
    writtenByteLength: written.size,
    atomicReplaceUsed: true,
    ...overrides,
  };
}

function entry(
  name: string,
  path: string,
  fileType: WorkspaceEntry["fileType"] = "file",
): WorkspaceEntry {
  return {
    name,
    path,
    fileType,
    size: fileType === "file" ? 42 : 0,
    mtime: 1_788_888_888,
    isHidden: false,
  };
}

function csharpStatus(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    presetId: "csharp",
    displayName: "C#",
    documentLanguageIds: ["csharp"],
    available: false,
    active: false,
    selectedCommandId: "csharp-ls",
    selectedCommand: "csharp-ls",
    installHint: "dotnet tool install -g csharp-ls",
    error: null,
    commands: [
      {
        id: "csharp-ls",
        label: "csharp-ls",
        command: "csharp-ls",
        args: [],
        installHint: "dotnet tool install -g csharp-ls",
        fallback: false,
        available: false,
      },
      {
        id: "omnisharp",
        label: "OmniSharp",
        command: "omnisharp",
        args: ["--languageserver"],
        installHint: "Install OmniSharp and ensure `omnisharp` is on PATH",
        fallback: true,
        available: false,
      },
    ],
    ...overrides,
  };
}

function defaultCapabilities(overrides: Partial<LspCapabilitySummary> = {}): LspCapabilitySummary {
  return {
    completion: false,
    signatureHelp: false,
    hover: false,
    definition: false,
    typeDefinition: false,
    implementation: false,
    references: false,
    documentSymbol: false,
    workspaceSymbol: false,
    rename: false,
    formatting: false,
    rangeFormatting: false,
    codeAction: false,
    documentHighlight: false,
    inlayHint: false,
    selectionRange: false,
    callHierarchy: false,
    typeHierarchy: false,
    semanticTokens: false,
    completionTriggerCharacters: [],
    signatureTriggerCharacters: [],
    ...overrides,
  };
}

function documentStatus(overrides: Partial<LspDocumentStatus> = {}): LspDocumentStatus {
  return {
    path: "/repo/app/src/Program.cs",
    uri: "file:///repo/app/src/Program.cs",
    presetId: "csharp",
    languageId: "csharp",
    displayName: "C#",
    available: false,
    active: false,
    selectedCommandId: "csharp-ls",
    selectedCommand: "csharp-ls",
    installHint: "dotnet tool install -g csharp-ls",
    error: null,
    capabilities: defaultCapabilities(overrides.capabilities ?? undefined),
    ...overrides,
  };
}

function renderWorkspace(
  workspace: CodeWorkspaceTabInfo,
  props: Partial<ComponentProps<typeof CodeWorkspaceTab>> = {},
  options: { strict?: boolean } = {},
) {
  const element = <CodeWorkspaceTab tabId="tab-code" workspace={workspace} visible {...props} />;
  // `strict` reproduces how the app actually mounts (src/main.tsx wraps the tree
  // in React.StrictMode): mount → effect cleanups → effects again. Anything that
  // latches state in an effect cleanup behaves differently there.
  return render(options.strict ? <StrictMode>{element}</StrictMode> : element);
}

describe("extractContextSnippet", () => {
  it("extracts the first line and its following context at offset zero", () => {
    expect(extractContextSnippet("first\nsecond\nthird", 0, 0)).toEqual({
      lineText: "first",
      contextSnippet: "first\nsecond",
    });
  });

  it("preserves an empty first line when the caret is on the second line", () => {
    expect(extractContextSnippet("\nsecond\nthird", 1, 1)).toEqual({
      lineText: "second",
      contextSnippet: "\nsecond\nthird",
    });
  });

  it("returns only the adjacent three-line window for a middle line", () => {
    const text = "zero\none\ntwo\nthree\nfour";
    expect(extractContextSnippet(text, 2, text.indexOf("two"))).toEqual({
      lineText: "two",
      contextSnippet: "one\ntwo\nthree",
    });
  });

  it("extracts the final line and its predecessor at end of file", () => {
    const text = "zero\none\ntwo";
    expect(extractContextSnippet(text, 2, text.length)).toEqual({
      lineText: "two",
      contextSnippet: "one\ntwo",
    });
  });
});

describe("CodeWorkspaceTab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    workspaceActionRegistry.clear();
    navigationHistoryTracker.clear();
    globalEditorConfigResolver.clearAll();
    vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
    useAppStore.setState({
      statusMessage: "Ready",
      codeWorkspaceByTab: {},
    });
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
    localHistoryMocks.historySnapshot.mockReset().mockResolvedValue(null);
    workspaceMocks.workspaceListDir.mockReset();
    workspaceMocks.workspaceCompactChain.mockReset();
    workspaceMocks.workspaceListFilesRecursive.mockReset();
    workspaceMocks.workspaceDetectGitRoots.mockReset();
    workspaceMocks.workspaceDetectTasks.mockReset();
    workspaceMocks.workspaceJavaRunTargets.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceExecutionModel.mockReset().mockResolvedValue({
      projects: [],
      buildTargets: [],
      runConfigurations: [],
      debugConfigurations: [],
      tools: [],
    });
    workspaceMocks.workspaceJavaRunTarget.mockReset();
    workspaceMocks.workspaceTaskTree.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceTestResults.mockReset().mockResolvedValue({
      schema: "taomni.codeWorkspace.testResults",
      version: 1,
      source: "junit-xml",
      generatedAt: 1,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 0 },
      diagnostics: [],
    } satisfies StructuredTestResults);
    workspaceMocks.workspaceDependencyTree.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceReadFile.mockReset();
    workspaceMocks.workspaceReadLooseFile.mockReset();
    workspaceMocks.workspaceReadFileWithEncoding.mockReset();
    workspaceMocks.workspaceReadLooseFileWithEncoding.mockReset();
    workspaceMocks.workspaceWriteFile.mockReset();
    workspaceMocks.workspaceWriteLooseFile.mockReset();
    workspaceMocks.workspaceWriteFileEncoded.mockReset();
    workspaceMocks.workspaceWriteLooseFileEncoded.mockReset();
    workspaceMocks.workspaceCreateFile.mockReset();
    workspaceMocks.workspaceCreateDir.mockReset();
    workspaceMocks.workspaceDeletePath.mockReset();
    workspaceMocks.workspaceRenamePath.mockReset();
    workspaceMocks.workspaceApplyResourceOperation.mockReset();
    lspMocks.lspDetectServers.mockReset();
    lspMocks.lspSetJavaHome.mockReset().mockResolvedValue(undefined);
    lspMocks.lspSetJavaVmargs.mockReset().mockResolvedValue("-Xms1024m -Xmx1024m");
    lspMocks.lspSetJavaSettings.mockReset().mockResolvedValue(0);
    lspMocks.lspSetJavaBundles.mockReset().mockResolvedValue(undefined);
    lspMocks.lspOpenDocument.mockReset();
    lspMocks.lspChangeDocument.mockReset();
    lspMocks.lspSaveDocument.mockReset();
    lspMocks.lspCloseDocument.mockReset();
    lspMocks.lspStopWorkspace.mockReset().mockResolvedValue(0);
    lspMocks.lspGetDiagnostics.mockReset();
    lspMocks.lspWorkspaceDiagnostics.mockReset().mockResolvedValue([]);
    lspMocks.lspBuildWorkspace.mockReset().mockResolvedValue("succeed");
    runtimeState.tauri = false;
    dapMocks.dapStartSession.mockReset();
    dapMocks.dapSendRequest.mockReset().mockResolvedValue({});
    dapMocks.dapSend.mockReset().mockResolvedValue(undefined);
    dapMocks.dapTerminate.mockReset().mockResolvedValue(undefined);
    dapMocks.listenDapEvents.mockReset().mockResolvedValue(() => {});
    dapMocks.dapResolveJavaMainClasses.mockReset();
    lspMocks.lspHover.mockReset();
    lspMocks.lspDefinition.mockReset();
    lspMocks.lspPrepareRename.mockReset();
    lspMocks.lspRename.mockReset();
    lspMocks.lspReadUriContents.mockReset();
    lspMocks.lspDownloadSources.mockReset();
    lspMocks.lspReferences.mockReset();
    lspMocks.lspPrepareCallHierarchy.mockReset();
    lspMocks.lspCallHierarchyIncoming.mockReset();
    lspMocks.lspCallHierarchyOutgoing.mockReset();
    lspMocks.lspPrepareTypeHierarchy.mockReset();
    lspMocks.lspTypeHierarchySupertypes.mockReset();
    lspMocks.lspTypeHierarchySubtypes.mockReset();
    lspMocks.lspDocumentSymbols.mockReset();
    lspMocks.lspDocumentHighlights.mockReset();
    lspMocks.lspInlayHints.mockReset();
    lspMocks.lspSemanticTokens.mockReset();
    lspMocks.lspSelectionRanges.mockReset();
    lspMocks.lspExecuteCommand.mockReset().mockResolvedValue(null);
    lspMocks.lspResolveWorkspaceEdit.mockReset().mockResolvedValue(undefined);
    lspMocks.lspResolveShowMessageRequest.mockReset().mockResolvedValue(undefined);
    lspMocks.lspCancelWorkDoneProgress.mockReset().mockResolvedValue(false);
    lspMocks.lspWorkspaceDidChangeWatchedFiles.mockReset().mockResolvedValue(0);
    lspMocks.lspStartWorkspaceWatcher.mockReset().mockResolvedValue(undefined);
    lspMocks.lspStopWorkspaceWatcher.mockReset().mockResolvedValue(undefined);
    lspMocks.lspWorkspaceDidFileOperation.mockReset().mockResolvedValue(1);
    lspMocks.lspWorkspaceWillFileOperation.mockReset().mockResolvedValue(1);
    lspMocks.lspDocumentSymbols.mockResolvedValue({ status: documentStatus(), symbols: [] });
    lspMocks.lspDocumentHighlights.mockResolvedValue({ status: documentStatus(), highlights: [] });
    lspMocks.lspInlayHints.mockResolvedValue({ status: documentStatus(), hints: [] });
    lspMocks.lspSemanticTokens.mockResolvedValue({ status: documentStatus(), tokens: [] });
    lspMocks.lspSelectionRanges.mockResolvedValue({ status: documentStatus(), ranges: [] });
    lspMocks.lspCompletion.mockReset();
    lspMocks.lspCompletion.mockResolvedValue({ status: documentStatus(), isIncomplete: false, items: [] });
    lspMocks.lspCompletionResolve.mockReset();
    lspMocks.lspCompletionResolve.mockResolvedValue(null);
    lspMocks.lspSignatureHelp.mockReset();
    lspMocks.lspSignatureHelp.mockResolvedValue({
      status: documentStatus(),
      signatures: [],
      activeSignature: 0,
      activeParameter: 0,
    });
    lspMocks.lspFormatting.mockReset();
    lspMocks.lspFormatting.mockResolvedValue({ status: documentStatus(), edits: [] });
    lspMocks.lspRangeFormatting.mockReset();
    lspMocks.lspRangeFormatting.mockResolvedValue({ status: documentStatus(), edits: [] });
    lspMocks.lspCodeActions.mockReset();
    lspMocks.lspCodeActions.mockResolvedValue({ status: documentStatus(), actions: [] });
    lspMocks.lspCodeActionResolve.mockReset();
    lspMocks.lspCodeActionResolve.mockImplementation(async (_descriptor: unknown, raw: unknown) => ({
      status: documentStatus({ available: true, active: true }),
      action: raw,
    }));
    lspMocks.lspWorkspaceSymbols.mockReset();
    lspMocks.lspWorkspaceSymbols.mockResolvedValue({
      status: documentStatus(),
      symbols: [],
      sessionCount: 0,
      providerCount: 0,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: false,
      truncated: false,
      diagnostics: [],
    });
    lspMocks.lspWorkspaceSymbolResolve.mockReset();
    lspMocks.lspPrepareCallHierarchy.mockResolvedValue({ status: documentStatus(), items: [] });
    lspMocks.lspCallHierarchyIncoming.mockResolvedValue({ status: documentStatus(), entries: [] });
    lspMocks.lspCallHierarchyOutgoing.mockResolvedValue({ status: documentStatus(), entries: [] });
    lspMocks.lspPrepareTypeHierarchy.mockResolvedValue({ status: documentStatus(), items: [] });
    lspMocks.lspTypeHierarchySupertypes.mockResolvedValue({ status: documentStatus(), items: [] });
    lspMocks.lspTypeHierarchySubtypes.mockResolvedValue({ status: documentStatus(), items: [] });
    ipcMocks.selectFilePath.mockReset();
    ipcMocks.selectFolderPath.mockReset();
    gitMocks.gitSnapshot.mockReset();
    gitMocks.gitIgnorePath.mockReset();
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitBlameLines.mockReset();
    gitMocks.gitChangeLabel.mockClear();
    vi.mocked(mermaid.initialize).mockClear();
    vi.mocked(mermaid.render).mockClear();
    lspMocks.lspDetectServers.mockResolvedValue([]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());
    lspMocks.lspChangeDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
    lspMocks.lspSaveDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
    lspMocks.lspCloseDocument.mockResolvedValue(documentStatus());
    lspMocks.lspPrepareRename.mockResolvedValue({
      status: documentStatus(),
      allowed: false,
      range: null,
      placeholder: null,
      message: null,
    });
    lspMocks.lspRename.mockResolvedValue({
      status: documentStatus(),
      edit: { documentEdits: [], operations: [] },
    });
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: documentStatus(),
      diagnostics: [],
    });
    workspaceMocks.workspaceListDir.mockResolvedValue([]);
    workspaceMocks.workspaceCompactChain.mockResolvedValue({ path: "", entries: [] });
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([]);
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([]);
    workspaceMocks.workspaceDetectTasks.mockResolvedValue([]);
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });
    gitMocks.gitIgnorePath.mockResolvedValue({
      rule: "/README.md",
      gitignorePath: "/repo/app/.gitignore",
      added: true,
    });
    gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/main.ts",
      oldPath: null,
      oldText: "",
      newText: null,
      oldExists: true,
      newExists: false,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 0,
      newSize: 0,
    });
    gitMocks.gitBlameLines.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    workspaceActionRegistry.clear();
    navigationHistoryTracker.clear();
    globalEditorConfigResolver.clearAll();
  });

  it("keeps command registration stable across unrelated parent rerenders", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration",
      workspaceInstanceId: "instance-registration",
      name: "Registration Workspace",
      roots: [],
      looseFiles: [],
    };
    const onCommandsChange = vi.fn();
    const rendered = renderWorkspace(workspace, { onCommandsChange });

    await waitFor(() => {
      expect(onCommandsChange).toHaveBeenCalledWith(
        "tab-code",
        expect.objectContaining({
          items: expect.any(Array),
          snapshot: expect.any(Array),
          executeAction: expect.any(Function),
          execute: expect.any(Function),
        }),
      );
    });

    onCommandsChange.mockClear();
    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspace}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    expect(onCommandsChange).not.toHaveBeenCalled();

    rendered.unmount();
    expect(onCommandsChange).toHaveBeenCalledTimes(1);
    expect(onCommandsChange).toHaveBeenCalledWith("tab-code", null);
  });

  it("persists editor intelligence settings per workspace and reloads defaults after rebinding", async () => {
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-intelligence-settings-a",
      workspaceInstanceId: "instance-intelligence-settings-a",
      name: "Intelligence Settings A",
      roots: [],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      workspaceId: "ws-intelligence-settings-b",
      workspaceInstanceId: "instance-intelligence-settings-b",
      name: "Intelligence Settings B",
    };
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = renderWorkspace(first, { onCommandsChange });
    await screen.findByText("Code · Intelligence Settings A");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));

    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });
    await screen.findByTestId("workspace-intelligence-settings-dialog");
    fireEvent.click(screen.getByTestId("workspace-quick-doc-hover-enabled"));
    fireEvent.change(screen.getByTestId("workspace-quick-doc-hover-delay"), {
      target: { value: "825" },
    });
    fireEvent.change(screen.getByTestId("workspace-quick-doc-default-target"), {
      target: { value: "tool-window" },
    });
    fireEvent.click(screen.getByTestId("workspace-parameter-info-auto-popup"));
    fireEvent.change(screen.getByTestId("workspace-parameter-info-delay"), {
      target: { value: "275" },
    });
    fireEvent.click(screen.getByTestId("workspace-intelligence-settings-apply"));

    expect(JSON.parse(
      window.localStorage.getItem(
        "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-a",
      ) ?? "null",
    )).toEqual(expect.objectContaining({
      quickDoc: {
        showOnHover: false,
        hoverDelayMs: 825,
        defaultTarget: "tool-window",
      },
      parameterInfo: {
        autoPopup: false,
        delayMs: 275,
        showFullSignatures: false,
      },
    }));
    expect(window.localStorage.getItem(
      "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-b",
    )).toBeNull();

    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={second}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    await screen.findByText("Code · Intelligence Settings B");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });

    await screen.findByTestId("workspace-intelligence-settings-dialog");
    expect(screen.getByTestId("workspace-quick-doc-hover-enabled")).toBeChecked();
    expect(screen.getByTestId("workspace-quick-doc-hover-delay")).toHaveValue(300);
    expect(screen.getByTestId("workspace-quick-doc-default-target")).toHaveValue("popup");
    expect(screen.getByTestId("workspace-parameter-info-auto-popup")).toBeChecked();
    expect(screen.getByTestId("workspace-parameter-info-delay")).toHaveValue(0);
  });

  it("settles when the parent stores command registrations in state", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration-feedback",
      workspaceInstanceId: "instance-registration-feedback",
      name: "Registration Feedback Workspace",
      roots: [],
      looseFiles: [],
    };
    let parentRenderCount = 0;

    function RegistrationHost() {
      const renderCount = useRef(0);
      renderCount.current += 1;
      parentRenderCount = Math.max(parentRenderCount, renderCount.current);
      if (renderCount.current > 20) {
        throw new Error("Command registration feedback did not settle");
      }

      const [, setRegistrations] = useState<Record<string, unknown>>({});
      const handleCommandsChange = useCallback<
        NonNullable<ComponentProps<typeof CodeWorkspaceTab>["onCommandsChange"]>
      >((tabId, registration) => {
        setRegistrations((current) => {
          if (registration) {
            return current[tabId] === registration
              ? current
              : { ...current, [tabId]: registration };
          }
          if (!(tabId in current)) return current;
          const next = { ...current };
          delete next[tabId];
          return next;
        });
      }, []);

      return (
        <CodeWorkspaceTab
          tabId="tab-code-feedback"
          workspace={workspace}
          visible
          onCommandsChange={handleCommandsChange}
        />
      );
    }

    render(<RegistrationHost />);

    expect(await screen.findByText("Code · Registration Feedback Workspace")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(parentRenderCount).toBeGreaterThan(1);
    expect(parentRenderCount).toBeLessThan(20);
  });

  it("opens a multi-root workspace without embedding Language Servers in the tree", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-multi",
      workspaceInstanceId: "instance-multi",
      name: "Multi Repo",
      roots: [
        { id: "app", name: "app", path: "/repo/app", kind: "git" },
        { id: "lib", name: "lib", path: "/repo/lib", kind: "folder" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceListDir.mockImplementation(async (rootPath: string) => (
      rootPath === "/repo/app"
        ? [entry("src", "src", "dir")]
        : [entry("README.md", "README.md")]
    ));
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus()]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Multi Repo")).toBeInTheDocument();
    expect(screen.getByText("2 roots")).toBeInTheDocument();
    expect(screen.getAllByText("app").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("lib").length).toBeGreaterThanOrEqual(1);
    // Language Servers UI moved to Settings — tree should stay free of it.
    expect(screen.queryByText("Language Servers")).toBeNull();
    expect(screen.queryByText("dotnet tool install -g csharp-ls")).toBeNull();

    await waitFor(() => {
      expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(
        {
          workspaceId: "instance-multi",
          rootPath: "/repo/app",
          filePath: "src/Program.cs",
          documentUri: null,
          serverCommandId: null,
          customServerCommand: null,
          javaHome: null,
        },
        "class Program {}",
        1,
      );
    });
  });

  it("offers a settings link when opening a file without an active language server", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-lsp-settings",
      name: "LSP Settings",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus()]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());

    renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });

    const link = await screen.findByTestId("code-workspace-lsp-open-settings");
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
      presetId: "csharp",
    });
  });

  it("renders Mermaid diagrams in markdown preview with SVG and PNG export controls", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-md",
      name: "Editor Workspace",
      roots: [],
      looseFiles: [{ id: "readme", name: "README.md", path: "/tmp/README.md" }],
      initialFile: { kind: "loose", id: "readme", path: "/tmp/README.md" },
    };
    workspaceMocks.workspaceReadLooseFile.mockResolvedValue(file(
      "/tmp/README.md",
      [
        "# Diagram",
        "",
        "```mermaid",
        "graph TD",
        "  A-->B",
        "```",
      ].join("\n"),
    ));

    renderWorkspace(workspace);

    await waitFor(() => expect(screen.getAllByText("README.md").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      const preview = screen.getByTestId("code-workspace-markdown-preview");
      expect(within(preview).getByText("Diagram")).toBeInTheDocument();
      expect(within(preview).getByText("Mermaid 1")).toBeInTheDocument();
      expect(within(preview).getByRole("button", { name: "SVG" })).toBeInTheDocument();
      expect(within(preview).getByRole("button", { name: "PNG" })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringContaining("taomni-mermaid-"),
        expect.stringContaining("graph TD"),
      );
    });
  });

  it("keeps file tree zoom separate from editor zoom", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-appearance",
      name: "Appearance",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const answer = 42;"));

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Appearance")).toBeInTheDocument();

    // The tree's font size must be bound to the zoom variable (not just row
    // height), so zooming the left pane actually resizes its text.
    expect(screen.getByTestId("code-workspace-tree").style.fontSize).toBe(
      "var(--taomni-code-tree-font-size)",
    );

    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-in"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");
    expect(screen.getByTestId("code-workspace-tree-pane").style.getPropertyValue("--taomni-code-tree-font-size")).toBe("13px");
    expect(window.localStorage.getItem("taomni.codeViewProfile.v1")).toBeNull();

    const appearanceKey = editorAppearanceProfileStorageKey("ws-appearance");
    fireEvent.click(screen.getByTestId("code-workspace-zoom-in"));
    let saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);
    expect(document.documentElement.style.getPropertyValue("--taomni-code-font-size")).toBe("");
    expect(window.localStorage.getItem("taomni.codeViewProfile.v1")).toBeNull();
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");

    fireEvent.wheel(screen.getByTestId("code-workspace-tree-pane"), { ctrlKey: true, deltaY: -100 });
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("14");
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);

    fireEvent.wheel(screen.getByTestId("code-workspace-editor-pane"), { ctrlKey: true, deltaY: -100 });
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(15);
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("14");

    fireEvent.click(screen.getByTestId("code-workspace-zoom-out"));
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);

    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-out"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");
  });

  it("persists and renders the flat file view with language src groups only", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-flat",
      name: "Flat",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      entry("README.md", "README.md"),
      entry("App.tsx", "src/App.tsx"),
      entry("lib.rs", "src-tauri/src/lib.rs"),
      entry("guide.md", "docs/guide.md"),
      entry("foo.rs", "target/debug/foo.rs"),
    ]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/App.tsx", "export function App() {}"));

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Flat")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-view-flat"));

    expect(window.localStorage.getItem("taomni.codeWorkspace.treeViewMode.v1")).toBe("flat");
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(await screen.findByText("src-tauri/src")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
    expect(screen.queryByText("(root)")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("code-workspace-flat-file")).toHaveLength(2);
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("lib.rs")).toBeInTheDocument();

    fireEvent.click(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/App.tsx");
    });
  });

  it("opens successive tree files as permanent tabs without closing the previous one", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tabs",
      workspaceInstanceId: "instance-tabs",
      name: "Tabs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("main.ts", "src/main.ts"),
      entry("util.ts", "src/util.ts"),
    ]);
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      file(path, path === "src/main.ts" ? "export const main = 1;" : "export const util = 2;")
    ));

    renderWorkspace(workspace);
    expect(await screen.findByText("Code · Tabs")).toBeInTheDocument();

    const rows = await screen.findAllByTestId("code-workspace-tree-file");
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    });
    fireEvent.click(rows[1]);
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
    });

    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tabs");
      expect(ui.editorGroups.primary.openOrder).toEqual([
        "root:app:src/main.ts",
        "root:app:src/util.ts",
      ]);
      expect(ui.editorGroups.primary.activeKey).toBe("root:app:src/util.ts");
      expect(ui.editorGroups.primary.previewKey).toBeNull();
    });
    expect(screen.getByTitle("app / src/main.ts")).toBeInTheDocument();
    expect(screen.getByTitle("app / src/util.ts")).toBeInTheDocument();
  });

  it("renders compact directory chains and expands the endpoint", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-compact",
      name: "Compact",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceCompactChain.mockResolvedValue({
      path: "src/main/java/com/example",
      entries: [entry("UserService.java", "src/main/java/com/example/UserService.java")],
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/example/UserService.java",
      "class UserService {}",
    ));

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Compact")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-view-compact"));

    const compactDir = await screen.findByText("src/main/java/com/example");
    fireEvent.click(compactDir);
    expect(await screen.findByText("UserService.java")).toBeInTheDocument();

    fireEvent.click(screen.getByText("UserService.java"));
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith(
        "/repo/app",
        "src/main/java/com/example/UserService.java",
      );
    });
  });

  it("detects git roots, decorates file changes, and opens the Git tab from the toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-git",
      name: "Git",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.tsx" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("App.tsx", "src/App.tsx")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/App.tsx", "export function App() {}"));
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([
      {
        id: "app",
        name: "app",
        path: "/repo/app",
        repoRoot: "/repo/app",
        rootIds: ["app"],
      },
    ]);
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [
        {
          path: "src/App.tsx",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        },
      ],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });

    const onOpenGitManager = vi.fn();
    renderWorkspace(workspace, { onOpenGitManager });

    expect(await screen.findByText("Code · Git")).toBeInTheDocument();
    await waitFor(() => {
      expect(workspaceMocks.workspaceDetectGitRoots).toHaveBeenCalledWith([
        { id: "app", name: "app", path: "/repo/app" },
      ]);
      expect(gitMocks.gitSnapshot).toHaveBeenCalledWith("/repo/app");
    });
    expect(await screen.findByTestId("code-workspace-git-status")).toHaveTextContent("M");
    expect(screen.queryByTestId("code-workspace-git-manager-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-git-container")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("code-workspace-git-panel-toggle")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("code-workspace-git-panel-toggle"));

    expect(onOpenGitManager).toHaveBeenCalledWith({
      workspaceName: "Git",
      workspaceInstanceId: "ws-git",
      workspaceId: "ws-git",
      roots: [
        {
          id: "app",
          name: "app",
          path: "/repo/app",
          repoRoot: "/repo/app",
          rootIds: ["app"],
        },
      ],
      activeRepoRoot: "/repo/app",
    });
  });

  it("shows Git gutter diffs and opt-in inline blame for the active line", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-git-editor",
      workspaceInstanceId: "instance-git-editor",
      name: "Git Editor",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: "0123456789abcdef",
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });
    gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/main.ts",
      oldPath: null,
      oldText: "const previous = 1;",
      newText: null,
      oldExists: true,
      newExists: false,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 19,
      newSize: 0,
    });
    gitMocks.gitBlameLines.mockResolvedValue([{
      line: 1,
      commit: "0123456789abcdef",
      author: "Ada",
      authorMail: "ada@example.test",
      authorTime: Math.floor(Date.now() / 1000) - 3_600,
      summary: "feat: seed main",
    }]);

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const marker = await screen.findByLabelText("modified Git change · show diff", {}, { timeout: 3_000 });
    fireEvent.mouseDown(marker);
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("previous");
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("value");

    const blameToggle = screen.getByTestId("code-workspace-inline-blame-toggle");
    expect(blameToggle).not.toBeDisabled();
    fireEvent.click(blameToggle);
    await waitFor(() => expect(gitMocks.gitBlameLines).toHaveBeenCalledWith("/repo/app", "src/main.ts", 1, 1));
    expect(await screen.findByText(/Ada, .* · feat: seed main/)).toBeInTheDocument();
  });

  it("selects the child repository that owns the active file inside a plain workspace root", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/workspace",
      workspaceId: "ws-child-git",
      name: "Child Repos",
      roots: [{ id: "workspace", name: "workspace", path: "/workspace", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "workspace", path: "service/src/api.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("api.ts", "service/src/api.ts")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("service/src/api.ts", "export const api = true;"));
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([
      {
        id: "workspace:/workspace/app",
        name: "app",
        path: "/workspace",
        repoRoot: "/workspace/app",
        rootIds: ["workspace"],
      },
      {
        id: "workspace:/workspace/service",
        name: "service",
        path: "/workspace",
        repoRoot: "/workspace/service",
        rootIds: ["workspace"],
      },
    ]);
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => ({
      repoRoot,
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: repoRoot === "/workspace/service"
        ? [
          {
            path: "src/api.ts",
            oldPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
            conflict: false,
          },
        ]
        : [
          {
            path: "src/App.tsx",
            oldPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
            conflict: false,
          },
        ],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    }));

    const onOpenGitManager = vi.fn();
    renderWorkspace(workspace, { onOpenGitManager });

    expect(await screen.findByText("Code · Child Repos")).toBeInTheDocument();
    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledWith("/workspace/service"));
    expect(await screen.findByTestId("code-workspace-git-status")).toHaveTextContent("M");

    await waitFor(() => expect(screen.getByTestId("code-workspace-git-panel-toggle")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("code-workspace-git-panel-toggle"));

    expect(onOpenGitManager).toHaveBeenCalledWith({
      workspaceName: "Child Repos",
      workspaceInstanceId: "ws-child-git",
      workspaceId: "ws-child-git",
      roots: [
        {
          id: "workspace:/workspace/app",
          name: "app",
          path: "/workspace",
          repoRoot: "/workspace/app",
          rootIds: ["workspace"],
        },
        {
          id: "workspace:/workspace/service",
          name: "service",
          path: "/workspace",
          repoRoot: "/workspace/service",
          rootIds: ["workspace"],
        },
      ],
      activeRepoRoot: "/workspace/service",
    });
  });

  it("keeps workspace editor appearance isolated from the global code-view profile", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-theme-follow",
      name: "Theme",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const answer = 42;"));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });

    expect(await screen.findByText("Code · Theme")).toBeInTheDocument();
    // The workspace no longer owns a theme selector; theme is set in Settings.
    expect(screen.queryByTestId("code-workspace-theme-select")).toBeNull();

    // Global Code View changes no longer mutate the Code Workspace editor.
    act(() => {
      saveCodeViewProfile({ ...DEFAULT_CODE_VIEW_PROFILE, theme: "kanagawa-wave" });
    });
    expect(document.documentElement.style.getPropertyValue("--taomni-code-bg")).toBe("");

    writeEditorAppearanceProfile("ws-theme-follow", {
      fontFamily: DEFAULT_CODE_VIEW_PROFILE.fontFamily,
      fontSizePx: 13,
      lineHeight: 1.5,
      ligatures: true,
      colorSchemeId: "dracula",
      highContrast: false,
      zoomScope: "all-editors",
      softWrap: { patterns: [], useOriginalIndent: true, additionalIndent: 0, showMarkers: false },
      virtualSpace: { afterLineEnd: false, atFileBottom: false },
      breadcrumbs: { visible: true, placement: "top", languages: ["*"] },
    });
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.editorAppearanceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.editorAppearanceSettings")).toBe(true);
    });
    expect(await screen.findByTestId("workspace-editor-appearance-settings-dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-color-scheme-id"), {
      target: { value: "dracula" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-apply"));
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveAttribute(
        "data-editor-color-scheme",
        "dracula",
      );
    });
  });

  it("mirrors active files, loose files, and diagnostics into agent workspace context", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-context",
      name: "Context",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      active: true,
      available: true,
      selectedCommand: "csharp-ls",
      installHint: null,
    }));
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: documentStatus({
        active: true,
        available: true,
        selectedCommand: "csharp-ls",
        installHint: null,
      }),
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 },
          },
          severity: 1,
          code: "CS1001",
          source: "csharp-ls",
          message: "Identifier expected",
        },
      ],
    });

    renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => {
      const context = useAppStore.getState().codeWorkspaceByTab["tab-code"];
      expect(context).toMatchObject({
        repoRoot: "/repo/app",
        activePath: "src/Program.cs",
        openPaths: ["src/Program.cs"],
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        activeFile: {
          kind: "root",
          rootId: "app",
          rootName: "app",
          rootPath: "/repo/app",
          path: "src/Program.cs",
        },
        lsp: {
          activeStatus: {
            displayName: "C#",
            languageId: "csharp",
            active: true,
            available: true,
            selectedCommand: "csharp-ls",
          },
          diagnostics: [
            {
              file: {
                kind: "root",
                rootId: "app",
                rootName: "app",
                rootPath: "/repo/app",
                path: "src/Program.cs",
              },
              errorCount: 1,
              warningCount: 0,
              infoCount: 0,
              messages: ["Identifier expected"],
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: /Problems/ }));
    expect(await screen.findByText("Identifier expected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show error diagnostics" })).toHaveTextContent("1");
  });

  it("tracks navigation history and reopens recent files from Ctrl+E", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-nav",
      workspaceInstanceId: "instance-nav",
      name: "Nav",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("a.ts", "a.ts"),
      entry("b.ts", "b.ts"),
    ]);
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      file(path, `// ${path}`));

    renderWorkspace(workspace);

    const treeFiles = await screen.findAllByTestId("code-workspace-tree-file");
    fireEvent.click(treeFiles[0]);
    await screen.findByTitle("app / a.ts");
    fireEvent.click(treeFiles[1]);
    await screen.findByTitle("app / b.ts");
    await waitFor(() =>
      expect(screen.getByTitle("app / b.ts").closest("div")).toHaveAttribute("data-active"));

    fireEvent.click(screen.getByTestId("code-workspace-nav-back"));
    await waitFor(() =>
      expect(screen.getByTitle("app / a.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.getByTestId("code-workspace-nav-back")).toBeDisabled();

    fireEvent.click(screen.getByTestId("code-workspace-nav-forward"));
    await waitFor(() =>
      expect(screen.getByTitle("app / b.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.getByTestId("code-workspace-nav-forward")).toBeDisabled();

    // Ctrl+E preselects the previously active file; Enter flips back to it.
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-recent-files");
    expect(within(popup).getAllByRole("button")[0]).toHaveTextContent("b.ts");
    fireEvent.keyDown(screen.getByLabelText("Recent files"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTitle("app / a.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.queryByTestId("code-workspace-recent-files")).not.toBeInTheDocument();
  });

  it("resolves URI-only workspace symbols before opening their source range", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-symbol-resolve",
      workspaceInstanceId: "instance-symbol-resolve",
      name: "Symbol Resolve",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: false,
      workspaceSymbol: true,
      workspaceSymbolResolve: true,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const activeStatus = documentStatus({ available: true, active: true, capabilities });
    const lifecycle: string[] = [];
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      if (path === "src/target.ts") lifecycle.push("read-target");
      return file(path, path === "src/target.ts" ? "\n".repeat(8) + "class DeferredType {}" : "const main = true;");
    });
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspWorkspaceSymbols.mockResolvedValue({
      status: activeStatus,
      symbols: [{
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/target.ts",
        path: "/repo/app/src/target.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        resolved: false,
        resolveToken: "0123456789abcdef0123456789abcdef:0",
      }, {
        name: "BrokenType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/broken.ts",
        path: "/repo/app/src/broken.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        resolved: false,
        resolveToken: null,
      }],
      sessionCount: 1,
      providerCount: 1,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: true,
      truncated: false,
      diagnostics: [],
    });
    lspMocks.lspWorkspaceSymbolResolve.mockImplementation(async () => {
      lifecycle.push("resolve");
      return {
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/target.ts",
        path: "/repo/app/src/target.ts",
        range: {
          start: { line: 8, character: 0 },
          end: { line: 8, character: 21 },
        },
        selectionRange: {
          start: { line: 8, character: 6 },
          end: { line: 8, character: 18 },
        },
        resolved: true,
        resolveToken: null,
      };
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => {
      expect(registrationRef.current?.items.find((item) => item.id === "workspace.goToSymbol")?.enabled)
        .toBe(true);
    });
    act(() => {
      expect(registrationRef.current?.execute("workspace.goToSymbol")).toBe(true);
    });
    const input = await screen.findByLabelText("Go to symbol");
    fireEvent.change(input, { target: { value: "Deferred" } });
    expect(await screen.findByText("DeferredType")).toBeInTheDocument();
    expect(screen.queryByText("editor · /repo/app/src/target.ts:1")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledWith(
      "instance-symbol-resolve",
      "0123456789abcdef0123456789abcdef:0",
    ));
    expect(await screen.findByTitle("app / src/target.ts")).toBeInTheDocument();
    expect(lifecycle).toEqual(["resolve", "read-target"]);
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-symbol-resolve",
    ).splitOrientation).toBe("vertical");

    act(() => {
      expect(registrationRef.current?.execute("workspace.goToSymbol")).toBe(true);
    });
    const brokenInput = await screen.findByLabelText("Go to symbol");
    fireEvent.change(brokenInput, { target: { value: "Broken" } });
    expect(await screen.findByText("BrokenType")).toBeInTheDocument();
    fireEvent.keyDown(brokenInput, { key: "Enter" });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "did not provide a source location",
    ));
    expect(lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("app / src/broken.ts")).not.toBeInTheDocument();
  });

  it("opens the file structure popup with Ctrl+F12 and jumps to a symbol", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-structure",
      workspaceInstanceId: "instance-structure",
      name: "Structure",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "a.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("a.ts", "a.ts")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("a.ts", "const x = 1;"));
    lspMocks.lspDocumentSymbols.mockResolvedValue({
      status: documentStatus({ active: true, available: true }),
      symbols: [
        {
          name: "openFile",
          detail: "(path: string) => Promise<void>",
          kind: 12,
          depth: 0,
          range: { start: { line: 13, character: 0 }, end: { line: 16, character: 1 } },
          selectionRange: { start: { line: 13, character: 8 }, end: { line: 13, character: 16 } },
        },
      ],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / a.ts");
    // The tab strip renders while the file is still loading; wait for the
    // loaded file header (size text) before invoking the structure popup.
    await screen.findByText("12 B");

    fireEvent.keyDown(window, { key: "F12", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-structure-popup");
    expect(await within(popup).findByText("openFile")).toBeInTheDocument();
    expect(lspMocks.lspDocumentSymbols).toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("File structure"), { key: "Enter" });
    expect(screen.queryByTestId("code-workspace-structure-popup")).not.toBeInTheDocument();
  });

  it("opens the persistent Outline pane and follows document symbols", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-outline",
      workspaceInstanceId: "instance-outline",
      name: "Outline",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const status = documentStatus({ available: true, active: true, capabilities });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "function render() {}"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    lspMocks.lspDocumentSymbols.mockResolvedValue({
      status,
      symbols: [{
        name: "render",
        detail: "() => void",
        kind: 12,
        depth: 0,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
      }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspDocumentSymbols).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("code-workspace-right-pane-toggle"));

    expect(screen.getByRole("tab", { name: "Outline", selected: true })).toBeInTheDocument();
    const outline = await screen.findByTestId("code-workspace-outline-pane");
    expect(outline).toHaveTextContent("render");
    fireEvent.click(within(outline).getByText("render"));
  });

  it("opens quick documentation with Ctrl+Q, navigates to its exact source, and pins it", async () => {
    const { EditorView } = await import("@codemirror/view");
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-qdoc",
      workspaceInstanceId: "instance-qdoc",
      name: "QuickDoc",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "openFile(path)"));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 13 },
      },
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled());
    const editorContent = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(editorContent).not.toBeNull();
    const view = EditorView.findFromDOM(editorContent!);
    expect(view).not.toBeNull();

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-quick-doc");
    expect(popup).toHaveTextContent("Opens");
    expect(lspMocks.lspHover).toHaveBeenCalled();

    fireEvent.click(within(popup).getByRole("button", { name: "Source" }));
    await waitFor(() => expect(view!.state.selection.main.head).toBe(9));

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    await screen.findByTestId("code-workspace-quick-doc");
    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-right-pane")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-documentation-pane")).toHaveTextContent("Opens");
  });

  it("routes explicit QuickDoc to the unlocked Documentation pane when configured", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-qdoc-tool-window",
      workspaceInstanceId: "instance-qdoc-tool-window",
      name: "QuickDoc tool window",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.intelligence.v1.instance-qdoc-tool-window",
      JSON.stringify({ quickDoc: { defaultTarget: "tool-window" } }),
    );
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "openFile(path)"));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 8 },
      },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    const pane = await screen.findByTestId("code-workspace-documentation-pane");
    expect(pane).toHaveTextContent("Opens");
    expect(screen.getByRole("tab", { name: "Documentation", selected: true })).toBeInTheDocument();
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Pinned")).not.toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Unpin documentation" })).not.toBeInTheDocument();
  });

  it("requests code actions on Alt+Enter and applies workspace edits", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions",
      workspaceInstanceId: "instance-actions",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
        completion: false,
        signatureHelp: false,
        hover: false,
        definition: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false,
        rename: false,
        formatting: false,
        rangeFormatting: false,
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
      semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: {
          title: "Insert space",
          kind: "quickfix",
          data: { fixId: "space" },
        },
      }],
    });
    lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: {
                start: { line: 0, character: 1 },
                end: { line: 0, character: 1 },
              },
              newText: " ",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Insert space", data: { fixId: "space" } },
      },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));
    await waitFor(() => expect(lspMocks.lspCodeActionResolve).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ data: { fixId: "space" } }),
    ));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
  });

  it("applies provider Java import quick fixes on Alt+Enter and inserts the import statement", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-import",
      workspaceInstanceId: "instance-java-import",
      name: "Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/Service.java",
      "class Service { List items; }",
    ));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/Service.java",
      available: true,
      active: true,
      capabilities: {
        completion: true,
        signatureHelp: false,
        hover: false,
        definition: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false,
        rename: false,
        formatting: false,
        rangeFormatting: false,
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Import 'List' (java.util.List)",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/Service.java",
            path: "/repo/app/src/Service.java",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import java.util.List;\n",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Import 'List' (java.util.List)" },
      }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/Service.java");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    const importOption = await screen.findByRole("button", { name: "Import 'List' (java.util.List)" });
    expect(importOption).toBeInTheDocument();

    fireEvent.click(importOption);

    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-java-import",
    ).openFiles["root:app:src/Service.java"]?.text).toContain("import java.util.List;"));
  });

  it("never generates or suggests Java import quick fixes in TypeScript files", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ts-no-java-import",
      workspaceInstanceId: "instance-ts-no-java-import",
      name: "TS No Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/app.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/app.ts",
      "const items: List = [];",
    ));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/app.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({
        completion: true,
        codeAction: true,
      }),
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/app.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter on TypeScript file where LSP has no actions
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    
    // Assert no Java import quick fix is suggested
    expect(screen.queryByRole("button", { name: /import 'List' \(java\.util\.List\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /java\.util/i })).not.toBeInTheDocument();
  });

  it("rejects a provider refactor when the editor changes during preview confirmation", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-stale-refactor",
      workspaceInstanceId: "instance-stale-refactor",
      name: "Stale refactor",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
        completion: false,
        signatureHelp: false,
        hover: false,
        definition: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false,
        rename: false,
        formatting: false,
        rangeFormatting: false,
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspCodeActions.mockResolvedValue({
      status: activeStatus,
      actions: [{
        title: "Extract generated helper",
        kind: "refactor.extract",
        isPreferred: true,
        edit: {
          documentEdits: [],
          operations: [{
            kind: "create",
            uri: "file:///repo/app/src/generated.ts",
            path: "/repo/app/src/generated.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          }],
        },
        command: null,
        commandArguments: null,
        raw: {},
      }],
    });
    let resolvePreview!: (confirmed: boolean) => void;
    vi.mocked(confirmAppDialog).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolvePreview = resolve;
    }));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Extract generated helper" }));
    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalled());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await act(async () => {
      resolvePreview(true);
      await Promise.resolve();
    });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "Semantic result became stale before changes were applied",
    ));
    expect(workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });

  it("keeps provider diagnostics unchanged when inspection severity affects editor chrome", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-profile-actions",
      workspaceInstanceId: "instance-profile-actions",
      name: "Profile actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const providerDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "unused-value",
      source: "typescript",
      message: "Value is never read",
      data: { providerToken: "original" },
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.inspectionProfile.v1.instance-profile-actions",
      JSON.stringify({
        version: 1,
        rules: { "typescript:unused-value": { enabled: true, severity: 1 } },
      }),
    );
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x"));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
        completion: false,
        signatureHelp: false,
        hover: false,
        definition: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false,
        rename: false,
        formatting: false,
        rangeFormatting: false,
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [providerDiagnostic] });

    const rendered = renderWorkspace(workspace);
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(rendered.container.querySelector(".cm-lsp-diagnostic-error")).toBeTruthy());
    const bulb = rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]');
    expect(bulb).toBeTruthy();
    fireEvent.mouseDown(bulb!);

    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalled());
    expect(lspMocks.lspCodeActions.mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({
        severity: 2,
        code: "unused-value",
        data: { providerToken: "original" },
      }),
    ]);
  });

  it("makes the active editor read-only while a resource WorkspaceEdit is in flight", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-resource-action",
      workspaceInstanceId: "instance-resource-action",
      name: "Resource action",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
        completion: false,
        signatureHelp: false,
        hover: false,
        definition: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false,
        rename: false,
        formatting: false,
        rangeFormatting: false,
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Rename file",
        kind: "refactor.rename",
        isPreferred: true,
        edit: {
          documentEdits: [],
          operations: [{
            kind: "rename",
            oldUri: "file:///repo/app/src/main.ts",
            oldPath: "/repo/app/src/main.ts",
            newUri: "file:///repo/app/src/renamed.ts",
            newPath: "/repo/app/src/renamed.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          }],
        },
        command: null,
        commandArguments: null,
        raw: {},
      }],
    });
    let finishResourceOperation!: (value: { ignored: boolean }) => void;
    workspaceMocks.workspaceApplyResourceOperation.mockReturnValue(new Promise((resolve) => {
      finishResourceOperation = resolve;
    }));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Rename file" }));

    await waitFor(() => expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).toHaveAttribute("aria-readonly", "true"));

    await act(async () => finishResourceOperation({ ignored: false }));
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).not.toHaveAttribute("aria-readonly"));
    expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith("/repo/app", {
      kind: "rename",
      fromPath: "src/main.ts",
      toPath: "src/renamed.ts",
      toRepoRoot: "/repo/app",
      overwrite: false,
      ignoreIfExists: false,
    });
    expect(Object.keys(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-resource-action").openFiles,
    )).toContain("root:app:src/renamed.ts");
  });

  it("formats the active document through LSP when formatting is advertised", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format",
      workspaceInstanceId: "instance-format",
      name: "Format",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: {
        completion: true,
        signatureHelp: true,
        hover: true,
        definition: true,
        typeDefinition: false,
        implementation: false,
        references: true,
        documentSymbol: true,
        workspaceSymbol: false,
        rename: false,
        formatting: true,
        rangeFormatting: true,
        codeAction: false,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
      semanticTokens: false,
        completionTriggerCharacters: ["."],
        signatureTriggerCharacters: ["(", ","],
      },
    }));
    lspMocks.lspFormatting.mockResolvedValue({
      status: documentStatus({ active: true, available: true }),
      edits: [{
        range: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 7 },
        },
        newText: " ",
      }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await screen.findByText("9 B");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled());
    // Wait until the LSP status is no longer idle so capabilities are in state.
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false });
    await waitFor(() => expect(lspMocks.lspFormatting).toHaveBeenCalled());
    // Formatting inserts a space into "const x=1" → dirty buffer.
    await waitFor(() => {
      expect(screen.getByText(/unsaved/)).toBeInTheDocument();
    });
    expect(lspMocks.lspFormatting).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "instance-format",
        filePath: "src/main.ts",
      }),
      expect.objectContaining({
        tabSize: 2,
        insertSpaces: true,
      }),
    );
  });

  it("persists the workspace format-on-save switch and saves formatted text", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-on-save",
      workspaceInstanceId: "instance-format-on-save",
      name: "Format on save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: true,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: true,
      rangeFormatting: true,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities,
    }));
    lspMocks.lspFormatting
      .mockResolvedValueOnce({
        status: documentStatus({ active: true, available: true, capabilities }),
        edits: [{
          range: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 7 },
          },
          newText: " ",
        }],
      })
      .mockResolvedValueOnce({
        status: documentStatus({ active: true, available: true, capabilities }),
        edits: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "// formatted\n",
        }],
      });
    workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(writeAck(file(
      "src/main.ts",
      "// formatted\nconst x =1",
      { hash: "hash-formatted" },
    )));

    // Format-on-save is a workspace intelligence preference (command / Settings path).
    // Pref-seed before mount so save applies formatting without the old tree checkbox.
    window.localStorage.setItem(
      "taomni.codeWorkspace.intelligence.v1.instance-format-on-save",
      JSON.stringify({ formatOnSave: true }),
    );

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Make the buffer dirty through the existing manual formatting path.
    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });
    await waitFor(() => expect(lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/unsaved/)).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "// formatted\nconst x =1",
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    expect(lspMocks.lspFormatting).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText(/unsaved/)).not.toBeInTheDocument());
    expect(lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalledWith(
      "instance-format-on-save",
      [{ path: "/repo/app/src/main.ts", type: 2 }],
    );
  });

  it("queues an external dirty-buffer conflict and applies a merge against the latest disk hash", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-external-conflict",
      workspaceInstanceId: "instance-external-conflict",
      name: "External conflict",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    let disk = file("src/main.ts", "const value = 1;", { hash: "hash-base" });
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockImplementation(async () => disk);

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const key = "root:app:src/main.ts";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-external-conflict")
        .openFiles[key]?.text,
    ).toBe("const value = 1;"));

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles(
        "instance-external-conflict",
        (current) => ({
          ...current,
          [key]: {
            ...current[key]!,
            text: "const value = 2;",
            dirty: true,
          },
        }),
      );
    });
    disk = file("src/main.ts", "const value = 3;", { hash: "hash-external" });
    await act(async () => {
      await emit("lsp://external-file-change", {
        workspaceId: "instance-external-conflict",
        path: "/repo/app/src/main.ts",
        type: 2,
      });
    });

    expect(await screen.findByTestId("external-file-conflict-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Merge result" }, { timeout: 5000 }), {
      target: { value: "const value = 4;" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Merge" }));

    await waitFor(() => {
      const merged = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-external-conflict",
      ).openFiles[key];
      expect(merged?.text).toBe("const value = 4;");
      expect(merged?.savedText).toBe("const value = 3;");
      expect(merged?.hash).toBe("hash-external");
      expect(merged?.dirty).toBe(true);
    });
    expect(screen.queryByTestId("external-file-conflict-dialog")).not.toBeInTheDocument();
  });

  it("restores a crash snapshot into the live editor without replacing the disk baseline", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-recovery",
      workspaceInstanceId: "instance-recovery",
      name: "Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;", { hash: "disk-hash" }));
    window.localStorage.setItem(
      `${WORKSPACE_RECOVERY_STORAGE_PREFIX}:instance-recovery`,
      JSON.stringify([{
        workspaceId: "instance-recovery",
        key: "root:app:src/main.ts",
        ref: { kind: "root", rootId: "app", path: "src/main.ts" },
        path: "src/main.ts",
        text: "const value = 2;",
        savedText: "const value = 1;",
        eol: "LF",
        hash: "disk-hash",
        mtime: 1,
        size: 16,
        capturedAt: Date.now(),
      }]),
    );

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.getByTestId("workspace-recovery-dialog")).toBeInTheDocument());
    expect(await screen.findByTestId("workspace-recovery-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover selected" }));
    await waitFor(() => {
      const recovered = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery",
      ).openFiles["root:app:src/main.ts"];
      expect(recovered?.text).toBe("const value = 2;");
      expect(recovered?.savedText).toBe("const value = 1;");
      expect(recovered?.hash).toBe("disk-hash");
      expect(recovered?.dirty).toBe(true);
    });
    expect(screen.queryByTestId("workspace-recovery-dialog")).not.toBeInTheDocument();
  });

  it("opens call and type hierarchy from capability-gated shortcuts", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-hierarchy",
      workspaceInstanceId: "instance-hierarchy",
      name: "Hierarchy",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: false,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: true,
      typeHierarchy: true,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const hierarchyItem = {
      name: "main",
      detail: "module",
      kind: 12,
      uri: "file:///repo/app/src/main.ts",
      path: "/repo/app/src/main.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
      raw: { name: "main", data: "opaque" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "function main() {}"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    }));
    lspMocks.lspPrepareCallHierarchy.mockResolvedValue({
      status: documentStatus({ available: true, active: true, capabilities }),
      items: [hierarchyItem],
    });
    lspMocks.lspPrepareTypeHierarchy.mockResolvedValue({
      status: documentStatus({ available: true, active: true, capabilities }),
      items: [{ ...hierarchyItem, name: "Base", raw: { name: "Base" } }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const editor = screen.getByTestId("code-workspace-editor-pane");

    fireEvent.keyDown(editor, { key: "h", ctrlKey: true, altKey: true });
    await waitFor(() => expect(lspMocks.lspPrepareCallHierarchy).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Call Hierarchy", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-call-hierarchy-panel")).toHaveTextContent("main");

    fireEvent.keyDown(editor, { key: "h", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspPrepareTypeHierarchy).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Type Hierarchy", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-type-hierarchy-panel")).toHaveTextContent("Base");
  });

  it("opens a JDK / dependency class as a read-only library buffer", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-library-goto",
      workspaceInstanceId: "instance-library-goto",
      name: "Library goto",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const classUri = "jdt://contents/java.base/java.lang/String.class?=java.base";
    workspaceMocks.workspaceReadFile.mockResolvedValue(
      file("src/Main.java", "class Main { String value; }"),
    );
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    // jdtls answers binary targets with a jdt:// URI and no filesystem path.
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: {
          start: { line: 3, character: 13 },
          end: { line: 3, character: 19 },
        },
      }],
    });
    const charSequenceUri = "jdt://contents/java.base/java.lang/CharSequence.class?=java.base";
    lspMocks.lspReadUriContents.mockImplementation(async (_descriptor: unknown, uri: string) => (
      uri === charSequenceUri
        ? {
          status: activeStatus,
          uri,
          path: null,
          title: "CharSequence.java",
          container: "java.lang · java.base",
          languageId: "java",
          text: "package java.lang;\n\npublic interface CharSequence {}\n",
          readOnly: true,
        }
        : {
          status: activeStatus,
          uri,
          path: null,
          title: "String.java",
          container: "java.lang · java.base",
          languageId: "java",
          text: "package java.lang;\n\npublic final class String implements CharSequence {}\n",
          readOnly: true,
        }
    ));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/Main.java");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    fireEvent.keyDown(content!, { key: "F12" });

    await waitFor(() => expect(lspMocks.lspReadUriContents).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/app", filePath: "src/Main.java" }),
      classUri,
    ));
    const libraryTab = await screen.findByTitle("java.lang · java.base · String.java");
    expect(libraryTab).toBeInTheDocument();
    // Library sources never touch the file system, and never open a server document.
    expect(workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    expect(lspMocks.lspOpenDocument).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: classUri }),
      expect.anything(),
      expect.anything(),
    );

    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toBe("Opened java.lang · java.base · String.java (read-only)"));

    // Jumping again from inside the library buffer rides the origin project's
    // session, and a URI reported as a "path" is never read from disk.
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: charSequenceUri,
        path: charSequenceUri,
        range: {
          start: { line: 2, character: 17 },
          end: { line: 2, character: 29 },
        },
      }],
    });
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "F12" });

    await waitFor(() => expect(lspMocks.lspReadUriContents).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/Main.java", documentUri: classUri }),
      charSequenceUri,
    ));
    expect(await screen.findByTitle("java.lang · java.base · CharSequence.java")).toBeInTheDocument();
    expect(workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });

  it("offers Download sources on a decompiled class and swaps in attached source", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-download-sources",
      workspaceInstanceId: "instance-download-sources",
      name: "Download sources",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const classUri = "jdt://contents/guava-33.jar/com.google.common.base/Strings.class?=guava";
    workspaceMocks.workspaceReadFile.mockResolvedValue(
      file("src/Main.java", "class Main { Strings s; }"),
    );
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
      }],
    });
    // First open returns decompiled bytecode (marked decompiled: true).
    lspMocks.lspReadUriContents.mockResolvedValue({
      status: activeStatus,
      uri: classUri,
      path: null,
      title: "Strings.java",
      container: "com.google.common.base · guava-33.jar",
      languageId: "java",
      text: "// Source code is decompiled…\npublic final class Strings {}\n",
      readOnly: true,
      decompiled: true,
    });
    lspMocks.lspDownloadSources.mockResolvedValue({
      attached: true,
      text: "package com.google.common.base;\n\npublic final class Strings { /* real */ }\n",
      decompiled: false,
      message: null,
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/Main.java");
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "F12" });

    // Decompiled banner + Download sources button appear for the library buffer.
    const downloadBtn = await screen.findByTestId("code-workspace-download-sources");
    expect(screen.getByTestId("code-workspace-decompiled-banner")).toBeInTheDocument();

    fireEvent.click(downloadBtn);

    await waitFor(() => expect(lspMocks.lspDownloadSources).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/app", filePath: "src/Main.java" }),
      classUri,
    ));
    // Attached source arrives → banner disappears and status reports success.
    await waitFor(() => expect(screen.queryByTestId("code-workspace-decompiled-banner")).toBeNull());
    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toBe("Attached sources for Strings.java"));
    // Never written back to disk.
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
  });

  it("keeps the Download sources banner when no sources are published", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-download-none",
      workspaceInstanceId: "instance-download-none",
      name: "Download none",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const classUri = "jdt://contents/legacy.jar/com.legacy/Widget.class?=legacy";
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Main.java", "class Main { Widget w; }"));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
      }],
    });
    lspMocks.lspReadUriContents.mockResolvedValue({
      status: activeStatus,
      uri: classUri,
      path: null,
      title: "Widget.java",
      container: "com.legacy · legacy.jar",
      languageId: "java",
      text: "// Source code is decompiled…\npublic class Widget {}\n",
      readOnly: true,
      decompiled: true,
    });
    lspMocks.lspDownloadSources.mockResolvedValue({
      attached: false,
      text: "// Source code is decompiled…\npublic class Widget {}\n",
      decompiled: true,
      message: "No sources published for this artifact (still showing decompiled bytecode).",
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/Main.java");
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "F12" });

    const downloadBtn = await screen.findByTestId("code-workspace-download-sources");
    fireEvent.click(downloadBtn);

    await waitFor(() => expect(lspMocks.lspDownloadSources).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toContain("No sources published"));
    // Still decompiled → banner stays so the user can retry.
    expect(screen.getByTestId("code-workspace-decompiled-banner")).toBeInTheDocument();
  });

  it("requests usage highlights, viewport inlay hints, and semantic selection ranges", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-intelligence",
      workspaceInstanceId: "instance-intelligence",
      name: "Intelligence",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: false,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: true,
      selectionRange: true,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = value;"));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDocumentHighlights.mockResolvedValue({
      status: activeStatus,
      highlights: [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        kind: 2,
      }],
    });
    lspMocks.lspInlayHints.mockResolvedValue({
      status: activeStatus,
      hints: [{
        position: { line: 0, character: 11 },
        label: ": number",
        kind: 1,
        tooltip: null,
        paddingLeft: true,
        paddingRight: false,
      }],
    });
    lspMocks.lspSelectionRanges.mockResolvedValue({
      status: activeStatus,
      ranges: [{
        start: { line: 0, character: 0 },
        end: { line: 0, character: 20 },
      }],
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspDocumentHighlights).toHaveBeenCalled());

    const inlayHintsToggle = screen.getByTestId("code-workspace-inlay-hints-toggle");
    expect(inlayHintsToggle).not.toBeDisabled();
    fireEvent.click(inlayHintsToggle);
    await waitFor(() => expect(inlayHintsToggle).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(lspMocks.lspInlayHints).toHaveBeenCalled());
    expect(window.localStorage.getItem("taomni.codeWorkspace.intelligence.v1.instance-intelligence"))
      .toContain('"inlayHintsEnabled":true');

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "w", code: "KeyW", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspSelectionRanges).toHaveBeenCalled());
  });

  it("syncs edits before idle intelligence work and ignores an older semantic-token response", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-lsp-scheduler",
      workspaceInstanceId: "instance-lsp-scheduler",
      name: "LSP scheduler",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: true,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const alpha = 1;"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    lspMocks.lspDocumentHighlights.mockResolvedValue({ status, highlights: [] });
    lspMocks.lspDocumentSymbols.mockResolvedValue({ status, symbols: [] });

    const rendered = renderWorkspace(workspace);
    const fileKey = "root:app:src/main.ts";
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-lsp-scheduler")
        .lspFiles[fileKey]?.syncedText,
    ).toBe("const alpha = 1;"));

    lspMocks.lspChangeDocument.mockClear();
    lspMocks.lspDocumentHighlights.mockClear();
    lspMocks.lspDocumentSymbols.mockClear();
    lspMocks.lspSemanticTokens.mockClear();
    let resolveOldSemantic: ((value: { status: LspDocumentStatus; tokens: unknown[] }) => void) | null = null;
    lspMocks.lspSemanticTokens.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldSemantic = resolve;
    }));

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles("instance-lsp-scheduler", (current) => ({
        ...current,
        [fileKey]: {
          ...current[fileKey]!,
          text: "const beta = 2;",
          dirty: true,
        },
      }));
    });

    await waitFor(() => expect(lspMocks.lspChangeDocument).toHaveBeenCalledOnce());
    await waitFor(() => expect(lspMocks.lspDocumentHighlights).toHaveBeenCalledOnce());
    await waitFor(() => expect(lspMocks.lspDocumentSymbols).toHaveBeenCalledOnce());
    await waitFor(() => expect(lspMocks.lspSemanticTokens).toHaveBeenCalledOnce());
    const changeOrder = lspMocks.lspChangeDocument.mock.invocationCallOrder[0]!;
    expect(changeOrder).toBeLessThan(lspMocks.lspDocumentHighlights.mock.invocationCallOrder[0]!);
    expect(changeOrder).toBeLessThan(lspMocks.lspDocumentSymbols.mock.invocationCallOrder[0]!);
    expect(changeOrder).toBeLessThan(lspMocks.lspSemanticTokens.mock.invocationCallOrder[0]!);

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles("instance-lsp-scheduler", (current) => ({
        ...current,
        [fileKey]: {
          ...current[fileKey]!,
          text: "const gamma = 3;",
          dirty: true,
        },
      }));
    });
    await waitFor(() => expect(lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2));

    expect(resolveOldSemantic).not.toBeNull();
    await act(async () => {
      resolveOldSemantic!({
        status,
        tokens: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          tokenType: "function",
          modifiers: [],
        }],
      });
      await Promise.resolve();
    });
    expect(rendered.container.querySelector(".cm-lsp-sem-function")).toBeNull();
  });

  it("coalesces editor text publications until the input burst is idle", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-text-batch",
      workspaceInstanceId: "instance-editor-text-batch",
      name: "Editor text batch",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "one\ntwo"));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const fileKey = "root:app:src/main.ts";
    const getBufferText = () => selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-editor-text-batch",
    ).openFiles[fileKey]?.text;
    const recordUserEdit = vi.spyOn(WorkspaceLocationController.prototype, "recordUserEdit");

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      expect(getBufferText()).toBe("one\ntwo");
      expect(recordUserEdit).not.toHaveBeenCalled();

      // EDITOR_TEXT_COMMIT_IDLE_DELAY_MS is 220ms — stay under it first.
      act(() => vi.advanceTimersByTime(219));
      expect(getBufferText()).toBe("one\ntwo");
      expect(recordUserEdit).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1));
      expect(getBufferText()).toBe("one\none\ntwo");
      expect(recordUserEdit).toHaveBeenCalledOnce();
      expect(recordUserEdit).toHaveBeenLastCalledWith(expect.objectContaining({
        line: 1,
        character: 0,
        lineText: "one",
        contextSnippet: "one\none\ntwo",
      }));
    } finally {
      recordUserEdit.mockRestore();
      vi.useRealTimers();
    }
  });

  it("offers tree context menu actions: copy path and scoped search", async () => {
    clipboardMocks.writeText.mockClear();
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-menu",
      workspaceInstanceId: "instance-menu",
      name: "Menu",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("src", "src", "dir"),
      entry("README.md", "README.md"),
    ]);
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "git-app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);

    renderWorkspace(workspace);

    const fileRow = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Relative Path" }));
    await waitFor(() => expect(clipboardMocks.writeText).toHaveBeenCalledWith("README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Path" }));
    await waitFor(() => expect(clipboardMocks.writeText).toHaveBeenCalledWith("/repo/app/README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    await waitFor(() => expect(gitMocks.gitIgnorePath).toHaveBeenCalledWith(
      "/repo/app",
      "README.md",
      false,
    ));

    const dirRow = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.contextMenu(dirRow);
    fireEvent.click(await screen.findByRole("button", { name: "Find in Directory..." }));
    expect(screen.getByRole("tab", { name: /Search/, selected: true })).toBeInTheDocument();
    expect(screen.getByLabelText("Include globs")).toHaveValue("src/**");

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Terminal" }));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");
  });

  it("detects workspace tasks and launches them in the integrated terminal", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-run",
      workspaceInstanceId: "instance-run",
      name: "Run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceDetectTasks.mockResolvedValue([{
      id: "package.json:test",
      label: "test",
      command: "pnpm run test",
      cwd: "/repo/app",
      source: "package.json",
    }]);

    renderWorkspace(workspace);
    fireEvent.click(await screen.findByRole("tab", { name: /Run/ }));
    fireEvent.click(await screen.findByTitle("pnpm run test — /repo/app"));

    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });

  it("resolves and runs the active Java main class from the workspace toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-run",
      workspaceInstanceId: "instance-java-run",
      name: "Java run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: "/repo/app/src/main/java/com/acme/App.java",
      command: "./mvnw -q -Dexec.mainClass='com.acme.App' compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));

    await waitFor(() => expect(workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalledWith(
      "/repo/app",
      "src/main/java/com/acme/App.java",
      undefined,
    ));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });

  it("ingests structured test results after the Java test terminal exits", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-test-results",
      workspaceInstanceId: "instance-java-test-results",
      name: "Java test results",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/test/java/com/acme/CalcTest.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/test/java/com/acme/CalcTest.java",
      uri: "file:///repo/app/src/test/java/com/acme/CalcTest.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const testItem = {
      name: "fails",
      fullName: "com.acme.CalcTest#fails",
      kind: "method",
      uri: null,
      range: null,
      children: [],
    };
    const report: StructuredTestResults = {
      schema: "taomni.codeWorkspace.testResults",
      version: 1,
      source: "junit-xml",
      generatedAt: 2,
      results: [{
        id: "target/surefire-reports/TEST.xml::com.acme.CalcTest#fails",
        selector: testItem.fullName,
        name: "fails",
        className: "com.acme.CalcTest",
        status: "failed",
        durationMs: 30,
        message: "expected 2",
        details: "stack",
        filePath: "src/test/java/com/acme/CalcTest.java",
        line: 12,
      }],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, errors: 0, durationMs: 30 },
      diagnostics: [],
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/test/java/com/acme/CalcTest.java",
      "package com.acme; class CalcTest {}",
    ));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceMocks.workspaceTaskTree.mockResolvedValue([{
      source: "Maven",
      tasks: [{
        id: "Maven:test",
        label: "test",
        command: "mvn test",
        cwd: "/repo/app",
        source: "Maven",
      }],
    }]);
    lspMocks.javaTestDiscover.mockResolvedValue([testItem]);
    workspaceMocks.workspaceTestResults.mockResolvedValue(report);

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/test/java/com/acme/CalcTest.java");
    fireEvent.click(screen.getByRole("tab", { name: /Tests/ }));
    const runButton = await screen.findByTestId(`tests-run-${testItem.fullName}`);
    fireEvent.click(runButton);
    await screen.findByTestId("mock-workspace-terminal");
    fireEvent.click(screen.getByTestId("mock-workspace-terminal-task-exit"));

    await waitFor(() => expect(workspaceMocks.workspaceTestResults).toHaveBeenCalledWith(
      "/repo/app",
      expect.any(Number),
    ));
    expect(workspaceMocks.workspaceTestResults.mock.calls[0][1]).toBeLessThanOrEqual(Date.now());
  });

  it("keeps a shared Java debug-only configuration ahead of compatibility discovery", async () => {
    runtimeState.tauri = true;
    const sourcePath = "/repo/app/src/main/java/com/acme/App.java";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-shared-debug",
      workspaceInstanceId: "instance-java-shared-debug",
      name: "Java shared debug",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: sourcePath,
      command: "./mvnw compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:maven",
        provider: "maven",
        root: "/repo/app",
        manifest: "/repo/app/pom.xml",
        module: "app",
        languages: ["java"],
        toolchain: "maven",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "shared-run:remote",
        projectId: "project:maven",
        label: "Remote JVM",
        kind: "debug-only",
        configurationSource: "shared",
        sourceFile: sourcePath,
        preLaunchTargets: [],
        debugConfigurationId: "shared-debug:remote",
        command: {
          executable: "__taomni_debug_only__",
          args: [],
          cwd: "/repo/app",
          env: {},
          display: "Debug only",
          source: "configured",
          error: "This configuration is debug-only; choose Debug to launch it",
        },
      }],
      debugConfigurations: [{
        id: "shared-debug:remote",
        projectId: "project:maven",
        label: "Remote JVM",
        adapterId: "java",
        request: "attach",
        available: true,
        preLaunchTargets: [],
        sourceFile: sourcePath,
        configurationSource: "shared",
        launchConfig: { request: "attach", arguments: { hostName: "127.0.0.1", port: 5005 } },
      }],
      tools: [],
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "shared-java-session",
      capabilities: {},
      request: "attach",
      arguments: { hostName: "127.0.0.1", port: 5005 },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    await waitFor(() => expect(screen.getByTestId("code-workspace-active-run-configuration")).toHaveValue("shared-run:remote"));
    expect(screen.getByTestId("code-workspace-run-target")).toBeDisabled();
    expect(screen.getByTestId("code-workspace-debug-target")).toBeEnabled();

    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));
    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({ request: "attach" }),
    ));
    expect(workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalled();
  });

  it("uses provider capabilities to run and debug an active non-Java target", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-go-run",
      workspaceInstanceId: "instance-go-run",
      name: "Go run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "cmd/demo/main.go" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "cmd/demo/main.go",
      "package main\nfunc main() {}\n",
    ));
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:go",
        provider: "go",
        root: "/repo/app",
        manifest: "/repo/app/go.mod",
        module: "app",
        languages: ["go"],
        toolchain: "go",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "run:go",
        projectId: "project:go",
        label: "Run ./cmd/demo",
        kind: "main-package",
        sourceFile: "/repo/app/cmd/demo/main.go",
        preLaunchTargets: [],
        debugConfigurationId: "debug:go",
        command: {
          executable: "go",
          args: ["run", "./cmd/demo", "--"],
          cwd: "/repo/app",
          env: {},
          display: "go run ./cmd/demo --",
          source: "path",
        },
      }],
      debugConfigurations: [{
        id: "debug:go",
        projectId: "project:go",
        label: "Debug ./cmd/demo",
        adapterId: "delve",
        request: "launch",
        available: true,
        preLaunchTargets: [],
        sourceFile: "/repo/app/cmd/demo/main.go",
        launchConfig: {
          adapterCommand: "dlv",
          adapterCwd: "/repo/app",
          mode: { kind: "managedTcp", args: ["dap", "--listen=127.0.0.1:${port}"] },
          arguments: { mode: "debug", program: "/repo/app/cmd/demo" },
        },
      }],
      tools: [],
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "go-session",
      capabilities: {},
      request: "launch",
      arguments: { mode: "debug", program: "/repo/app/cmd/demo" },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / cmd/demo/main.go");
    await waitFor(() => expect(screen.getByTestId("code-workspace-run-target")).toBeEnabled());
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");

    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));
    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "delve",
      expect.objectContaining({ adapterCommand: "dlv", adapterCwd: "/repo/app" }),
    ));
  });

  it("keeps project-level configurations scoped to the active workspace root", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-multi-root-config",
      workspaceInstanceId: "instance-multi-root-config",
      name: "Multi-root configurations",
      roots: [
        { id: "one", name: "one", path: "/repo/one", kind: "git" },
        { id: "two", name: "two", path: "/repo/two", kind: "git" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "one", path: "src/main.go" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.go",
      "package main\nfunc main() {}\n",
    ));
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [
        {
          id: "project:one",
          provider: "go",
          root: "/repo/one",
          manifest: "/repo/one/go.mod",
          module: "one",
          languages: ["go"],
          toolchain: "go",
          diagnostics: [],
        },
        {
          id: "project:two",
          provider: "go",
          root: "/repo/two",
          manifest: "/repo/two/go.mod",
          module: "two",
          languages: ["go"],
          toolchain: "go",
          diagnostics: [],
        },
      ],
      buildTargets: [],
      runConfigurations: [
        {
          id: "shared-run:one",
          projectId: "project:one",
          label: "One project launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "."],
            cwd: "/repo/one",
            env: {},
            display: "go run .",
            source: "path",
          },
        },
        {
          id: "shared-run:two",
          projectId: "project:two",
          label: "Two project launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "."],
            cwd: "/repo/two",
            env: {},
            display: "go run .",
            source: "path",
          },
        },
        {
          id: "shared-run:one-alt",
          projectId: "project:one",
          label: "One alternate launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "./cmd/alternate"],
            cwd: "/repo/one",
            env: {},
            display: "go run ./cmd/alternate",
            source: "path",
          },
        },
      ],
      debugConfigurations: [],
      tools: [],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("one / src/main.go");
    await waitFor(() => expect(screen.getByTestId("code-workspace-active-run-configuration")).toBeInTheDocument());
    const selector = screen.getByTestId("code-workspace-active-run-configuration");
    expect(selector).toHaveTextContent("One project launch");
    expect(selector).not.toHaveTextContent("Two project launch");
  });

  it("starts a Java debug session from the toolbar under StrictMode", async () => {
    // Regression: the tab's mounted-guard ref was cleared by StrictMode's dev
    // double-invoke and never re-armed, so `if (!mountedRef.current) return`
    // aborted the launch right after the main class was resolved — the click
    // resolved the class, then silently did nothing (no session, no message).
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug",
      workspaceInstanceId: "instance-java-debug",
      name: "Java debug",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({
        rootPath: "/repo/app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
        mainClass: "com.acme.App",
        projectName: "app",
      }),
    ));
    // Make-before-launch must run as an incremental build (jdtls autobuilds on
    // save; a clean rebuild would add minutes to every debug start) and must
    // target the file being launched: the jdtls session key includes the
    // nearest module walking up from the path, so a synthetic root-level path
    // misses the module session in a multi-module build and the build is
    // skipped with "no language server session is active".
    expect(lspMocks.lspBuildWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/repo/app",
        filePath: "src/main/java/com/acme/App.java",
      }),
      false,
    );
    // The panel reports each pre-launch step, so a slow start is never blank.
    const consoleOutput = await screen.findByTestId("debug-console-output");
    expect(consoleOutput.textContent).toContain("Starting debug for App.java");
    expect(consoleOutput.textContent).toContain("Building project…");
    expect(consoleOutput.textContent).toContain("Launching com.acme.App…");
  });

  it("releases a workspace's store instance when the tab is rebound to another", async () => {
    // The StrictMode-safe teardown defers disposal by a macrotask so a remount
    // can cancel it. Only a remount of the SAME workspace may cancel: rebinding
    // the tab to a different workspace must still release the old instance, or
    // its entry (open files, editor groups, LSP state) leaks for the session.
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-rebind-1",
      workspaceInstanceId: "instance-rebind-1",
      name: "One",
      roots: [{ id: "one", name: "one", path: "/repo/one", kind: "git" }],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      repoRoot: "/repo/two",
      workspaceId: "ws-rebind-2",
      workspaceInstanceId: "instance-rebind-2",
      name: "Two",
      roots: [{ id: "two", name: "two", path: "/repo/two", kind: "git" }],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([]);

    const view = render(<CodeWorkspaceTab tabId="tab-code" workspace={first} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeTruthy());

    view.rerender(<CodeWorkspaceTab tabId="tab-code" workspace={second} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeUndefined());
    expect(useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-2"]).toBeTruthy();
  });

  it("blocks a Java debug launch when the pre-launch build fails", async () => {
    // A failed build must say so rather than launching stale bytecode.
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-build-fail",
      workspaceInstanceId: "instance-java-debug-build-fail",
      name: "Java debug build fail",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    lspMocks.lspBuildWorkspace.mockResolvedValue("failed");

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain(
      "Cannot start debug: the project build failed",
    ));
    expect(dapMocks.dapResolveJavaMainClasses).not.toHaveBeenCalled();
    expect(dapMocks.dapStartSession).not.toHaveBeenCalled();
  });

  it("opens a shared buffer in a resizable editor split and collapses it", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-split",
      workspaceInstanceId: "instance-split",
      name: "Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const value = 1;"));

    renderWorkspace(workspace);
    await screen.findAllByText("main.ts");
    fireEvent.click(screen.getByTestId("code-workspace-split-right"));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").splitOrientation,
    ).toBe("vertical"));
    expect(await screen.findByTestId("code-workspace-editor-split")).toBeInTheDocument();
    expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2);
    // §8.16.4 N6.6: a split materializes two recursive leaves sharing one buffer.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split");
    const tree = ui.layoutTreeV2;
    expect(tree?.type).toBe("split");
    if (tree?.type === "split") {
      const leafActiveKeys = tree.children
        .filter((child) => child.type === "leaf")
        .map((child) => child.activeKey);
      expect(leafActiveKeys).toHaveLength(2);
      expect(leafActiveKeys[0]).toBe(leafActiveKeys[1]);
    }
    expect(Object.keys(ui.openFiles)).toHaveLength(1);

    fireEvent.click(screen.getByTestId("code-workspace-split-close"));
    await waitFor(() => expect(screen.queryByTestId("code-workspace-editor-split")).not.toBeInTheDocument());
    expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(1);
  });

  it("closes the active editor tab with Ctrl+F4", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-tab",
      workspaceInstanceId: "instance-close-tab",
      name: "Close Tab",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const value = 1;"));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-tab")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
  });

  it("opens the selected tree file in a split with Ctrl+Enter", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-split",
      workspaceInstanceId: "instance-tree-split",
      name: "Tree Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("README.md", "README.md")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("README.md", "# Readme"));

    renderWorkspace(workspace);
    const row = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.click(row);
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(await screen.findByTestId("code-workspace-editor-split")).toBeInTheDocument();
    // §8.16.4 N6.6: Ctrl+Enter opens the tree file in a new recursive leaf.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-split");
    const tree = ui.layoutTreeV2;
    expect(tree?.type).toBe("split");
    const leafKeys = tree?.type === "split"
      ? tree.children.flatMap((child) => (child.type === "leaf" ? [child.activeKey] : []))
      : [];
    expect(leafKeys).toContain("root:app:README.md");
  });

  it("scans open-file TODOs and toggles persistent bookmarks with F11", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-todos",
      workspaceInstanceId: "instance-todos",
      name: "TODOs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.ts",
      "const value = 1; // TODO: replace fixture",
    ));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });

    const panel = await screen.findByTestId("code-workspace-todos-panel");
    expect(screen.getByRole("tab", { name: /TODOs/, selected: true })).toBeInTheDocument();
    expect(panel).toHaveTextContent("replace fixture");
    expect(panel).toHaveTextContent("const value = 1");
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-todos"))
      .toContain("root:app:src/main.ts");

    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await waitFor(() => expect(panel).toHaveTextContent("No bookmarks yet"));
  });

  it("restores open editor tabs and dock chrome from the layout snapshot", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-layout-restore",
      workspaceInstanceId: "instance-layout-restore",
      name: "Layout Restore",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? file("src/util.ts", "export const util = 1;")
        : file("src/main.ts", "export const main = 1;")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-layout-restore", JSON.stringify({
      version: 1,
      bottomDockOpen: false,
      bottomDockTab: "search",
      rightPaneOpen: true,
      rightPaneTab: "outline",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      expandedRootIds: ["app"],
      expandedDirKeys: ["app:"],
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: ["root:app:src/main.ts"],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    renderWorkspace(workspace);

    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-layout-restore");
      expect(ui.bottomDockOpen).toBe(false);
      expect(ui.bottomDockTab).toBe("search");
      expect(ui.rightPaneOpen).toBe(true);
      expect(ui.languagePanelOpen).toBe(false);
      expect(ui.splitOrientation).toBe("vertical");
      expect(ui.editorGroups.primary.openOrder).toContain("root:app:src/main.ts");
      expect(ui.editorGroups.secondary.openOrder).toContain("root:app:src/util.ts");
    });
    expect(screen.getByTestId("code-workspace-project-collapsed-rail")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-expand")).toBeInTheDocument();
    expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
  });

  it("routes editor actions through ActionHost to the active recursive leaf", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-actions",
      workspaceInstanceId: "instance-editor-actions",
      name: "Editor Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? file("src/util.ts", "alpha\nbeta")
        : file("src/main.ts", "first\nsecond")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-editor-actions", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    const { EditorView } = await import("@codemirror/view");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "secondary");
    const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
    const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");
    expect(primaryEditor).not.toBeNull();
    expect(secondaryEditor).not.toBeNull();
    const primaryView = EditorView.findFromDOM(primaryEditor!);
    const secondaryView = EditorView.findFromDOM(secondaryEditor!);
    expect(primaryView).not.toBeNull();
    expect(secondaryView).not.toBeNull();

    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("primary"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.cloneCaretBelow")?.enabled,
    ).toBe(true));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(1);

    fireEvent.mouseDown(secondaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("secondary"));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(2);
  });

  it("toggles the project tree from the panel-local collapse control and collapsed rail", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-collapse",
      workspaceInstanceId: "instance-tree-collapse",
      name: "Tree Collapse",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    renderWorkspace(workspace);

    await screen.findByTestId("code-workspace-tree-pane");
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-resize-handle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-tree-collapse"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(false);
    });
    expect(screen.getByTestId("code-workspace-project-collapsed-rail")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-expand")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-project-expand"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(true);
    });
    expect(screen.queryByTestId("code-workspace-project-collapsed-rail")).toBeNull();
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
  });

  it("opens the encoding chooser from workspace status and saves through the encoded writer", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-save",
      workspaceInstanceId: "instance-encoding-save",
      name: "Encoding Save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.txt" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.txt",
      "你好",
      { encoding: "UTF-8", bom: false },
    ));
    workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(writeAck(file(
      "src/main.txt",
      "你好",
      { encoding: "GBK", bom: false, hash: "hash-gbk" },
    )));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.txt");
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding)
      .toBeTypeOf("function"));

    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    expect(await screen.findByTestId("file-encoding-dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "GBK" } });
    fireEvent.click(screen.getByRole("button", { name: "Convert on Save" }));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.dirty,
    ).toBe(true));
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.txt",
      "你好",
      "hash-src/main.txt",
      "GBK",
      false,
    ));
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.dirty,
    ).toBe(false));
  });

  it("reloads the active file with an explicit encoding from the status action", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-reload",
      workspaceInstanceId: "instance-encoding-reload",
      name: "Encoding Reload",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/legacy.txt" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/legacy.txt",
      "caf\u00E9",
      { encoding: "windows-1252", bom: false },
    ));
    workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(file(
      "src/legacy.txt",
      "caf\u00E9",
      { encoding: "UTF-16LE", bom: true, hash: "hash-utf16" },
    ));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/legacy.txt");
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding)
      .toBeTypeOf("function"));
    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    await screen.findByTestId("file-encoding-dialog");

    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "UTF-16LE" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload from Disk" }));

    await waitFor(() => expect(workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
      "/repo/app",
      "src/legacy.txt",
      "UTF-16LE",
    ));
    await waitFor(() => {
      const open = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-encoding-reload",
      ).openFiles["root:app:src/legacy.txt"];
      expect(open?.encoding).toBe("UTF-16LE");
      expect(open?.bom).toBe(true);
      expect(open?.dirty).toBe(false);
    });
    expect(screen.queryByTestId("file-encoding-dialog")).toBeNull();
  });

  it("applies Safe Delete across files as one undoable workspace transaction", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-safe-delete",
      workspaceInstanceId: "instance-safe-delete",
      name: "Safe Delete",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const disk = new Map([
      ["src/main.ts", "const answer = 42;"],
      ["src/use.ts", "use(answer);"],
    ]);
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path = "") => (
      path === "src"
        ? [entry("main.ts", "src/main.ts"), entry("use.ts", "src/use.ts")]
        : []
    ));
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return file(path, text, { hash: `hash-${path}` });
    });
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _root: string,
      path: string,
      text: string,
    ) => {
      disk.set(path, text);
      return writeAck(file(path, text, { hash: `hash-${path}-${text}` }));
    });
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: false,
      workspaceSymbol: false,
      rename: true,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    const declarationRange = {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    };
    lspMocks.lspPrepareRename.mockResolvedValue({
      status: activeStatus,
      allowed: true,
      range: declarationRange,
      placeholder: "answer",
      message: null,
    });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/main.ts",
        path: "/repo/app/src/main.ts",
        range: declarationRange,
      }],
    });
    lspMocks.lspReferences.mockResolvedValue({
      status: activeStatus,
      locations: [
        {
          uri: "file:///repo/app/src/main.ts",
          path: "/repo/app/src/main.ts",
          range: declarationRange,
        },
        {
          uri: "file:///repo/app/src/use.ts",
          path: "/repo/app/src/use.ts",
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 10 },
          },
        },
      ],
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    const rendered = renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(content!, { key: "Delete", code: "Delete", altKey: true });

    await waitFor(() => expect(lspMocks.lspPrepareRename).toHaveBeenCalled());
    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "const  = 42;",
      expect.any(String),
      "UTF-8",
      false,
    ));
    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/use.ts",
      "use();",
      "hash-src/use.ts",
      "UTF-8",
      false,
    ));
    await waitFor(() => expect(registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled)
      .toBe(true));
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.title)
      .toBe("Undo Safe delete symbol");
    expect(disk.get("src/main.ts")).toBe("const  = 42;");
    expect(disk.get("src/use.ts")).toBe("use();");

    await act(async () => {
      registrationRef.current?.execute("workspace.undoWorkspaceEdit");
    });
    await waitFor(() => expect(disk.get("src/main.ts")).toBe("const answer = 42;"));
    expect(disk.get("src/use.ts")).toBe("use(answer);");
  });

  it("navigates diagnostics with F2 / Shift+F2 and executes parameter info, quick definition, and optimize imports commands", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity",
      workspaceInstanceId: "instance-parity",
      name: "Parity commands",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/Program.cs",
      "using System;\nclass Program { static void Main() {} }\n",
    ));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    const activeStatus = documentStatus({
      available: true,
      active: true,
      selectedCommand: "csharp-ls",
      capabilities: defaultCapabilities({
        codeAction: true,
        definition: true,
        typeDefinition: true,
        implementation: true,
        signatureHelp: true,
      }),
    });
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: activeStatus,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
          severity: 2,
          message: "Unnecessary using directive",
        },
        {
          range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
          severity: 1,
          message: "Type error on Program",
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          severity: 1,
          message: "Missing return statement",
        },
      ],
    });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/Lib.cs",
        path: "/repo/app/src/Lib.cs",
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 10 } },
      }],
    });
    lspMocks.lspSignatureHelp.mockResolvedValue({
      status: activeStatus,
      signatures: [{
        label: "Main(): void",
        parameters: [],
      }],
      activeSignature: 0,
      activeParameter: 0,
    });
    lspMocks.lspCodeActions.mockResolvedValue({
      status: activeStatus,
      actions: [{
        title: "Organize Imports",
        kind: "source.organizeImports",
        edit: {
          changes: {
            "file:///repo/app/src/Program.cs": [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } }, newText: "" },
            ],
          },
        },
      }],
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });

    // 1. F2 Next error & Shift+F2 Prev error (wrapping)
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.nextError")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.nextError");
    });
    expect(useAppStore.getState().statusMessage).toBe("Error: Type error on Program");

    expect(registrationRef.current?.items.find((item) => item.id === "workspace.prevError")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.prevError");
    });
    expect(useAppStore.getState().statusMessage).toBe("Warning: Unnecessary using directive");

    // 2. Ctrl+P Parameter Info
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.parameterInfo")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.parameterInfo");
    });
    await waitFor(() => expect(lspMocks.lspSignatureHelp).toHaveBeenCalled());
    expect(await screen.findByRole("dialog", { name: "Parameter info" })).toHaveTextContent("Main(): void");

    // 3. Ctrl+Shift+I Quick Definition Peek
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.quickDefinition")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.quickDefinition");
    });
    await waitFor(() => expect(lspMocks.lspDefinition).toHaveBeenCalled());

    // 4. Ctrl+Alt+O Optimize Imports
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.optimizeImports")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.optimizeImports");
    });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      ["source.organizeImports"],
    ));
    expect(useAppStore.getState().statusMessage).toBe("Imports organized");

    // 5. Ctrl+Shift+F10 Run Context Configuration
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.runContextConfiguration")?.enabled).toBe(true);

    // 6. Ctrl+Alt+Shift+T Refactor This
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.refactorThis")?.enabled).toBe(true);

    // 7. Breakpoints: Ctrl+F8, Ctrl+Shift+F8, Mute
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleBreakpoint")?.enabled).toBe(true);
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.viewBreakpoints")?.enabled).toBe(true);
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleMuteBreakpoints")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.toggleMuteBreakpoints");
    });
    expect(useAppStore.getState().statusMessage).toBe("Breakpoints muted");

    // 8. Ctrl+Shift+F9 Recompile Active File
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.recompileActiveFile")?.enabled).toBe(true);
  });

  it("ingests workspace test coverage report and renders coverage dock panel", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-coverage",
      workspaceInstanceId: "instance-coverage",
      name: "Coverage test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };

    const lcovContent = `
SF:src/Program.cs
DA:1,3
DA:2,0
LF:2
LH:1
end_of_record
`;

    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, rel: string) => {
      if (rel === "coverage/lcov.info") {
        return file("coverage/lcov.info", lcovContent);
      }
      return file("src/Program.cs", "class Program {\n  void Main() {}\n}\n");
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Execute workspace.showCoverage command
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.showCoverage")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.showCoverage");
    });

    await waitFor(() => {
      expect(screen.getByTestId("coverage-overall-badge")).toBeInTheDocument();
      expect(screen.getByTestId("coverage-overall-badge")).toHaveTextContent("50%");
    });
  });

  it("toggles synchronized split scrolling when editor is split", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-split",
      workspaceInstanceId: "instance-split",
      name: "Split test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "line1\nline2\nline3\nline4\nline5\n"));

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Split editor right
    const splitRightBtn = screen.getByTestId("code-workspace-split-right");
    fireEvent.click(splitRightBtn);

    // Sync scroll button should appear
    const syncScrollBtn = await screen.findByTestId("code-workspace-split-sync-scroll");
    expect(syncScrollBtn).toBeInTheDocument();
    expect(syncScrollBtn).toHaveAttribute("aria-pressed", "false");

    // Click to enable synchronized scrolling
    fireEvent.click(syncScrollBtn);
    expect(syncScrollBtn).toHaveAttribute("aria-pressed", "true");
    expect(useAppStore.getState().statusMessage).toBe("Synchronized split scrolling enabled");

    // Toggle via command
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleSyncSplitScroll")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.toggleSyncSplitScroll");
    });
    expect(useAppStore.getState().statusMessage).toBe("Synchronized split scrolling disabled");
  });

  it("opens Search Everywhere with Ctrl+N and Ctrl+Shift+N when viewing a Java file", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-shortcuts-test",
      workspaceInstanceId: "instance-shortcuts-test",
      name: "Shortcuts test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(
      file("src/App.java", "public class App { public static void main(String[] args) {} }"),
    );
    workspaceMocks.workspaceListDir.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/App.java");

    // 1. Press Ctrl+Shift+N to open Search Everywhere (Files mode)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "N",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: true,
      });
    });

    const overlay1 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay1).toBeInTheDocument();

    // Close with Escape on the searchbox input
    await act(async () => {
      fireEvent.keyDown(within(overlay1).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });

    // 2. Press Ctrl+N to open Search Everywhere (Classes mode or fallback)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: false,
      });
    });

    const overlay2 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay2).toBeInTheDocument();

    // Close with Escape
    await act(async () => {
      fireEvent.keyDown(within(overlay2).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });
  });

  describe("P0-J1 completion identity host containment", () => {
    it("never renders inactive-provider completion candidates in a mounted editor", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      lspMocks.lspCompletion.mockResolvedValue({
        status: {
          path: "src/main.ts",
          uri: "file:///repo/app/src/main.ts",
          presetId: null,
          languageId: "typescript",
          displayName: "TypeScript",
          available: true,
          active: false,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        } satisfies LspDocumentStatus,
        isIncomplete: false,
        items: [{
          label: "StaleServerCandidate",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "StaleServerCandidate",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      });

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-inactive",
        workspaceInstanceId: "instance-completion-inactive",
        name: "Completion Inactive",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "valu" },
          selection: { anchor: view!.state.doc.length + 4 },
          userEvent: "input.type",
        });
        startCompletion(view!);
      });

      // Give the deferred provider response (inactive + stale items) time to
      // settle; whatever the popup shows, stale provider labels must not be
      // among the options.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const optionEls = rendered.container.querySelectorAll(".cm-tooltip-autocomplete li, .cm-completionLabel");
      for (const optionEl of optionEls) {
        expect(optionEl.textContent).not.toContain("StaleServerCandidate");
      }
    });
  });

  describe("N2.6 Ctrl+Tab Switcher", () => {
    it("opens on Ctrl+Tab, cycles with Shift, commits on Control release", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher",
        workspaceInstanceId: "instance-switcher",
        name: "Switcher",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("other.ts", "other.ts"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.click(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Ctrl+Tab opens the switcher with the previous file preselected.
      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher).toBeInTheDocument();
      // The previous file (main.ts) is preselected per IDEA MRU semantics.
      const selected = switcher.querySelector('[data-switcher-selected="true"]');
      expect(selected?.textContent).toContain("main.ts");

      // Releasing Control commits the preselected entry.
      fireEvent.keyUp(window, { key: "Control" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:src/main.ts");
      });
    });

    it("cancels with Escape without changing the active tab", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-cancel",
        workspaceInstanceId: "instance-switcher-cancel",
        name: "Switcher Cancel",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("other.ts", "other.ts"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        file(path, "const value = 1;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.click(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      await screen.findByTestId("workspace-tab-switcher");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
      expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
    });
  });

  describe("P0-S / N1.7 Atomic Save Commit Host Race Tests", () => {
    it("cancels save with 0 disk writes when user edits buffer during historySnapshot await", async () => {
      let resolveHistory: () => void = () => {};
      const historyDeferred = new Promise<null>((r) => {
        resolveHistory = () => r(null);
      });
      localHistoryMocks.historySnapshot.mockReturnValue(historyDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-history",
        workspaceInstanceId: "instance-save-race-history",
        name: "Save Race History",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "original_v1\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      // Make buffer dirty first by typing Ctrl+D (duplicate line)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-history",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.text).toBe("original_v1\noriginal_v1\n");
      });

      // Trigger Save (Ctrl+S) -> enters prepare phase and awaits historySnapshot
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

      await waitFor(() => {
        expect(localHistoryMocks.historySnapshot).toHaveBeenCalled();
      });

      // While historySnapshot is awaiting, user edits buffer again (Ctrl+D)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-history",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("original_v1\noriginal_v1\noriginal_v1\n");
      });

      // Now resolve historySnapshot
      await act(async () => {
        resolveHistory();
      });

      // Assert pre-write commit boundary cancelled save: zero disk writes
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(workspaceMocks.workspaceWriteLooseFileEncoded).not.toHaveBeenCalled();
      expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

      // Editor and store retain latest user edits, dirty remains true
      const finalFileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-history",
      ).openFiles["root:app:src/main.ts"];
      expect(finalFileState?.text).toBe("original_v1\noriginal_v1\noriginal_v1\n");
      expect(finalFileState?.dirty).toBe(true);
      expect(finalFileState?.saving).toBe(false);
    });

    it("preserves concurrent edits and marks dirty when disk write was in-flight", async () => {
      let resolveWrite: (res: any) => void = () => {};
      const writeDeferred = new Promise<any>((r) => {
        resolveWrite = r;
      });
      workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-inflight",
        workspaceInstanceId: "instance-save-race-inflight",
        name: "Save Race InFlight",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "initial_text\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      // Make buffer dirty (Ctrl+D)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-inflight",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.text).toBe("initial_text\ninitial_text\n");
      });

      // Trigger Save (Ctrl+S) -> historySnapshot resolves immediately, disk writer is called and deferred
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

      await waitFor(() => {
        expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
          "/repo/app",
          "src/main.ts",
          "initial_text\ninitial_text\n",
          "hash-src/main.ts",
          "UTF-8",
          false,
        );
      });

      // While write is in-flight, user edits buffer further (Ctrl+D)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-inflight",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("initial_text\ninitial_text\ninitial_text\n");
      });

      // Now resolve the disk writer with snapshot result
      await act(async () => {
        resolveWrite(writeAck(file("src/main.ts", "initial_text\ninitial_text\n", { hash: "hash-saved-snapshot" })));
      });

      // Assert writeback merged cleanly: savedText is updated, but buffer text keeps revision 11 edits and dirty is true
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-inflight",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("initial_text\ninitial_text\ninitial_text\n");
        expect(fileState?.savedText).toBe("initial_text\ninitial_text\n");
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.saving).toBe(false);
      });

      expect(useAppStore.getState().statusMessage).toContain("current changes remain unsaved");

      // P0-S3 stale-save ordering: the provider must never receive the stale
      // snapshot text via didSave; only the current buffer may be synced.
      const staleDidSave = lspMocks.lspSaveDocument.mock.calls.some(
        (call) => call.includes("initial_text\ninitial_text\n"),
      );
      expect(staleDidSave).toBe(false);
    });

    it("discards writeback and never recreates a closed buffer when writer resolves after close", async () => {
      let resolveWrite: (res: any) => void = () => {};
      const writeDeferred = new Promise<any>((r) => {
        resolveWrite = r;
      });
      workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-close",
        workspaceInstanceId: "instance-save-race-close",
        name: "Save Race Close",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "close_race\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      // Dirty the buffer, then start a save whose writer stays in flight.
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-close",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.dirty).toBe(true);
      });
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => {
        expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalled();
      });

      // Close the tab while the writer is pending (dialog mock confirms).
      const closeButton = rendered.container.querySelector<HTMLElement>(
        '[data-editor-tab-key="root:app:src/main.ts"] button[title="Close"]',
      );
      expect(closeButton).not.toBeNull();
      fireEvent.click(closeButton!);
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
        expect(ui.openFiles["root:app:src/main.ts"]).toBeUndefined();
      });

      // Writer finishes with the stale snapshot: writeback must be discarded.
      await act(async () => {
        resolveWrite(writeAck(file("src/main.ts", "close_race\nclose_race\n", { hash: "hash-closed-snapshot" })));
      });

      const uiAfter = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
      expect(uiAfter.openFiles["root:app:src/main.ts"]).toBeUndefined();
      expect(lspMocks.lspSaveDocument).not.toHaveBeenCalled();
    });
  });
});
