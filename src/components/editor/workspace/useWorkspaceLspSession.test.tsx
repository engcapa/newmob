import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import type { LspDiagnostic, LspDocumentStatus } from "../../../lib/editor/lsp";
import { SDK_REGISTRY_CHANGED_EVENT } from "../../../lib/editor/sdk";
import type { CodeWorkspaceRootInfo } from "../../../types";
import type { LspFileState, OpenFileState } from "./codeWorkspaceModel";
import {
  LSP_DIAGNOSTICS_REFRESH_EVENT,
  useWorkspaceLspSession,
} from "./useWorkspaceLspSession";

vi.mock("@tauri-apps/api/event", () => import("../../../stubs/tauri-event"));

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
}));

vi.mock("../../../lib/editor/lsp", () => lspMocks);

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

const status: LspDocumentStatus = {
  path: "/repo/src/main.ts",
  uri: "file:///repo/src/main.ts",
  presetId: "typescript",
  languageId: "typescript",
  displayName: "TypeScript",
  available: true,
  active: true,
  selectedCommandId: "typescript-language-server",
  selectedCommand: "typescript-language-server",
  installHint: null,
  error: null,
};

const incrementalStatus: LspDocumentStatus = {
  ...status,
  capabilities: {
    textDocumentSyncKind: 2,
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
    callHierarchy: false,
    typeHierarchy: false,
    inlayHint: false,
    selectionRange: false,
    semanticTokens: false,
    completionTriggerCharacters: [],
    signatureTriggerCharacters: [],
  },
};

const file: OpenFileState = {
  key: "root:root-1:src/main.ts",
  ref: { kind: "root", rootId: "root-1", path: "src/main.ts" },
  title: "main.ts",
  subtitle: "repo / src/main.ts",
  path: "src/main.ts",
  languagePath: "src/main.ts",
  text: "const value = 1;",
  savedText: "const value = 1;",
  eol: "LF",
  size: 16,
  mtime: 1,
  hash: "hash",
  loading: false,
  saving: false,
  dirty: false,
  documentRevision: 0,
  error: null,
};

describe("useWorkspaceLspSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    lspMocks.lspDetectServers.mockReset().mockResolvedValue([]);
    lspMocks.lspSetJavaHome.mockReset().mockResolvedValue(undefined);
    lspMocks.lspSetJavaVmargs.mockReset().mockResolvedValue("-Xms1024m -Xmx1024m");
    lspMocks.lspSetJavaSettings.mockReset().mockResolvedValue(0);
    lspMocks.lspSetJavaBundles.mockReset().mockResolvedValue(undefined);
    lspMocks.lspOpenDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspSaveDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspCloseDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspStopWorkspace.mockReset().mockResolvedValue(0);
    lspMocks.lspGetDiagnostics.mockReset().mockResolvedValue({ status, diagnostics: [] });
  });

  it("owns descriptor creation and the open/save/close document lifecycle", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalled());
    expect(result.current.descriptorForFile(file)).toMatchObject({
      workspaceId: "workspace-1",
      rootPath: "/repo",
      filePath: "src/main.ts",
      javaHome: null,
    });

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo" }),
      file.text,
      1,
    );
    expect(lspFiles[file.key]?.syncedText).toBe(file.text);

    await act(async () => result.current.saveDocument(file, "const value = 2;"));
    expect(lspMocks.lspSaveDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      "const value = 2;",
      2,
    );

    act(() => result.current.closeDocument(file));
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
  });

  it("keeps document identity retryable when awaited didClose fails", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-close-recovery",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(result.current.documentVersion(file.key)).toBe(1);

    lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("didClose transport failed"));
    await expect(result.current.closeDocumentAndWait(file)).rejects.toThrow("didClose transport failed");
    expect(result.current.documentVersion(file.key)).toBe(1);

    await result.current.closeDocumentAndWait(file);
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2);
    expect(result.current.documentVersion(file.key)).toBeNull();
  });

  it("refreshes active open-file diagnostics when the server invalidates pull results", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    lspMocks.lspGetDiagnostics.mockClear();
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-other" });
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-1" });
    });

    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalledOnce());
    expect(lspMocks.lspGetDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      filePath: "src/main.ts",
    }));
    unmount();
  });

  it("ED-PERF-002-A1: skips server detection while hidden and refreshes when shown", async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible }) => useWorkspaceLspSession({
        workspaceInstanceId: "workspace-hidden-detection",
        roots,
        openFilesRef: { current: {} },
        updateLspFiles: vi.fn(),
        onError,
        visible,
      }),
      { initialProps: { visible: false } },
    );

    await act(async () => Promise.resolve());
    expect(lspMocks.lspSetJavaHome).not.toHaveBeenCalled();
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    expect(result.current.serverStatuses).toEqual([]);

    rerender({ visible: true });
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspDetectServers).toHaveBeenCalledWith({ javaHome: null, forceRefresh: true });
    expect(result.current.serverStatuses).toEqual([]);
  });

  it("ED-PERF-002-A3: drops a slow detection result after the workspace is hidden", async () => {
    let resolveJavaHome!: () => void;
    lspMocks.lspSetJavaHome.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveJavaHome = resolve;
    }));
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible }) => useWorkspaceLspSession({
        workspaceInstanceId: "workspace-hidden-slow-detection",
        roots,
        openFilesRef: { current: {} },
        updateLspFiles: vi.fn(),
        onError,
        visible,
      }),
      { initialProps: { visible: true } },
    );

    await waitFor(() => expect(lspMocks.lspSetJavaHome).toHaveBeenCalledOnce());
    rerender({ visible: false });
    resolveJavaHome();
    await act(async () => Promise.resolve());
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    expect(result.current.serverStatuses).toEqual([]);

    rerender({ visible: true });
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspDetectServers).toHaveBeenCalledWith({ javaHome: null, forceRefresh: true });
  });

  it("records the file revision and provider session scope for diagnostics", async () => {
    const diagnostic: LspDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "Type error",
      source: "ts",
      code: "2322",
    };
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-diagnostic-scope",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-diagnostic-scope" });
    });

    await waitFor(() => expect(lspFiles[file.key]?.diagnostics).toHaveLength(1));
    expect(lspFiles[file.key]?.diagnosticScope).toEqual({
      fileKey: file.key,
      revision: 0,
      providerId: "typescript",
      providerGeneration: 0,
      uri: "file:///repo/src/main.ts",
    });
    unmount();
  });

  it("drops a diagnostics response when the buffer revision changes while it is pending", async () => {
    let resolveDiagnostics!: (value: { status: LspDocumentStatus; diagnostics: LspDiagnostic[] }) => void;
    lspMocks.lspGetDiagnostics.mockImplementation(() => new Promise((resolve) => {
      resolveDiagnostics = resolve;
    }));
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-diagnostic-revision",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-diagnostic-revision" });
    });
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled());

    openFilesRef.current[file.key] = { ...file, text: "const value = 2;", documentRevision: 1 };
    resolveDiagnostics({
      status,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        message: "Stale error",
        source: "ts",
        code: "2322",
      }],
    });
    await act(async () => Promise.resolve());

    expect(lspFiles[file.key]?.diagnostics).toEqual([]);
    expect(lspFiles[file.key]?.diagnosticScope).toBeNull();
    unmount();
  });

  it("routes library sources through the origin project session and never syncs them", async () => {
    const libraryFile: OpenFileState = {
      ...file,
      key: "loose:loose-jdt-string",
      ref: { kind: "loose", id: "loose-jdt-string", path: "jdt://contents/java.base/java.lang/String.class?=x" },
      title: "String.java",
      subtitle: "java.lang · java.base · String.java",
      path: "jdt://contents/java.base/java.lang/String.class?=x",
      languagePath: "String.java",
      library: {
        uri: "jdt://contents/java.base/java.lang/String.class?=x",
        container: "java.lang · java.base",
        originRootPath: "/repo",
        originFilePath: "src/Main.java",
      },
    };
    const openFilesRef = { current: { [libraryFile.key]: libraryFile } };
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalled());
    // Requests must ride the origin project's session but target the class URI.
    expect(result.current.descriptorForFile(libraryFile)).toMatchObject({
      rootPath: "/repo",
      filePath: "src/Main.java",
      documentUri: "jdt://contents/java.base/java.lang/String.class?=x",
    });

    await act(async () => result.current.syncDocument(libraryFile, "open"));
    await act(async () => result.current.saveDocument(libraryFile, "text"));
    act(() => result.current.closeDocument(libraryFile));
    expect(lspMocks.lspOpenDocument).not.toHaveBeenCalled();
    expect(lspMocks.lspSaveDocument).not.toHaveBeenCalled();
    expect(lspMocks.lspCloseDocument).not.toHaveBeenCalled();
  });

  it("does not commit an async response after its buffer was closed", async () => {
    let resolveOpen!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveOpen = resolve;
    }));
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.syncDocument(file, "open");
    });
    expect(lspFiles[file.key]?.syncing).toBe(true);
    openFilesRef.current = {};
    resolveOpen(status);
    await act(async () => pending);
    expect(lspFiles[file.key]?.syncedText).toBeNull();
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
    );
  });

  it("advances the error generation when the same provider failure recurs", async () => {
    lspMocks.lspOpenDocument.mockRejectedValue(new Error("server unavailable"));
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-error-generation",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspFiles[file.key]?.errorGeneration).toBe(1);

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspFiles[file.key]?.errorGeneration).toBe(2);
  });

  it("stops every backend LSP session when the workspace unmounts", () => {
    const { unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-stop",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    unmount();
    expect(lspMocks.lspStopWorkspace).toHaveBeenCalledOnce();
    expect(lspMocks.lspStopWorkspace).toHaveBeenCalledWith("workspace-stop");
  });

  it("restarts the workspace LSP session when SDK bindings change", async () => {
    const updateLspFiles = vi.fn();
    const onRestart = vi.fn();
    renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-sdk-change",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles,
      onError: vi.fn(),
      onRestart,
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalled());
    lspMocks.lspStopWorkspace.mockClear();
    window.dispatchEvent(new Event(SDK_REGISTRY_CHANGED_EVENT));

    await waitFor(() => expect(lspMocks.lspStopWorkspace).toHaveBeenCalledWith(
      "workspace-sdk-change",
    ));
    expect(updateLspFiles).toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("coalesces edits during open and follows with only the latest buffer", async () => {
    let resolveOpen!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveOpen = resolve;
    }));
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const latest = { ...file, text: "const value = 3;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    let initialSync!: Promise<void>;
    act(() => {
      initialSync = result.current.syncDocument(file, "open");
    });
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledOnce());
    await act(async () => {
      openFilesRef.current[file.key] = edited;
      await result.current.syncDocument(edited, "open");
      openFilesRef.current[file.key] = latest;
      await result.current.syncDocument(latest, "open");
    });
    expect(lspMocks.lspOpenDocument).toHaveBeenCalledOnce();
    expect(lspMocks.lspChangeDocument).not.toHaveBeenCalled();

    await act(async () => {
      resolveOpen(incrementalStatus);
      await initialSync;
    });
    expect(lspMocks.lspChangeDocument).toHaveBeenCalledOnce();
    expect(lspMocks.lspChangeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      null,
      2,
      {
        range: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 15 },
        },
        rangeLength: 1,
        text: "3",
      },
    );
    expect(lspFiles[file.key]?.syncedText).toBe(latest.text);
    expect(lspFiles[file.key]?.syncing).toBe(false);
  });

  it("retries with full text if an incremental-only change cannot be delivered", async () => {
    lspMocks.lspOpenDocument.mockResolvedValue(incrementalStatus);
    lspMocks.lspChangeDocument
      .mockRejectedValueOnce(new Error("full document text required"))
      .mockResolvedValueOnce(incrementalStatus);
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    openFilesRef.current[file.key] = edited;
    await act(async () => result.current.syncDocument(edited, "change"));

    expect(lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2);
    expect(lspMocks.lspChangeDocument.mock.calls[0]?.[1]).toBeNull();
    expect(lspMocks.lspChangeDocument.mock.calls[1]?.[1]).toBe(edited.text);
    expect(lspFiles[file.key]?.syncedText).toBe(edited.text);
  });

  it("does not flip syncing on active didChange so the status pill does not spin per key", async () => {
    let resolveChange!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveChange = resolve;
    }));
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspFiles[file.key]?.syncing).toBe(false);
    const publishesAfterOpen = updateLspFiles.mock.calls.length;

    openFilesRef.current[file.key] = edited;
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.syncDocument(edited, "change");
    });
    // Busy flag stays false while an already-active document is syncing.
    expect(lspFiles[file.key]?.syncing).toBe(false);
    expect(result.current.isDocumentSynced(file.key, edited.text)).toBe(false);

    await act(async () => {
      resolveChange(status);
      await pending;
    });
    expect(lspFiles[file.key]?.syncing).toBe(false);
    expect(lspFiles[file.key]?.syncedText).toBe(edited.text);
    expect(result.current.isDocumentSynced(file.key, edited.text)).toBe(true);
    // At least one publish for the drained change (syncedText).
    expect(updateLspFiles.mock.calls.length).toBeGreaterThan(publishesAfterOpen);
  });

  it("skips intermediate store publishes while a typing burst is still queued", async () => {
    let resolveFirstChange!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument
      .mockImplementationOnce(() => new Promise<LspDocumentStatus>((resolve) => {
        resolveFirstChange = resolve;
      }))
      .mockResolvedValue(status);
    const first = { ...file, text: "const value = 2;", dirty: true };
    const second = { ...file, text: "const value = 3;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    const publishesAfterOpen = updateLspFiles.mock.calls.length;

    openFilesRef.current[file.key] = first;
    let firstSync!: Promise<void>;
    act(() => {
      firstSync = result.current.syncDocument(first, "change");
    });
    openFilesRef.current[file.key] = second;
    await act(async () => {
      await result.current.syncDocument(second, "change");
    });

    // First change still in flight with a pending follow-up — no mid-burst
    // publish beyond the open lifecycle.
    const midBurstPublishes = updateLspFiles.mock.calls.length - publishesAfterOpen;
    expect(midBurstPublishes).toBe(0);
    expect(lspFiles[file.key]?.syncedText).toBe(file.text);

    await act(async () => {
      resolveFirstChange(status);
      await firstSync;
    });
    expect(lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2);
    expect(lspFiles[file.key]?.syncedText).toBe(second.text);
    expect(lspFiles[file.key]?.syncing).toBe(false);
    expect(result.current.isDocumentSynced(file.key, second.text)).toBe(true);
  });
});
