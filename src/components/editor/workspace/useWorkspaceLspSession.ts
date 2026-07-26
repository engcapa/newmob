import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  lspChangeDocument,
  lspCloseDocument,
  lspDetectServers,
  lspGetDiagnostics,
  lspOpenDocument,
  lspSaveDocument,
  lspSetJavaBundles,
  lspSetJavaHome,
  lspSetJavaSettings,
  lspSetJavaVmargs,
  lspStopWorkspace,
  type LspDiagnostic,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspServerStatus,
} from "../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { subscribeSdkRegistryChanged } from "../../../lib/editor/sdk";
import { buildIncrementalContentChange } from "./lspTextEdits";
import {
  CUSTOM_LSP_COMMAND_ID,
  customServerCommandFromConfig,
  emptyLspFileState,
  errorMessage,
  lspPresetIdForPath,
  readLspCommandPrefs,
  readLspCustomCommands,
  readLspJavaBundles,
  readLspJavaHome,
  readLspJavaSettings,
  readLspJavaVmargs,
  subscribeLspServerPrefs,
  writeLspCommandPrefs,
  writeLspCustomCommands,
  type LspCustomCommandConfig,
  type LspFileState,
  type OpenFileState,
} from "./codeWorkspaceModel";

type LspFilesUpdater = (
  updater: Record<string, LspFileState>
    | ((current: Record<string, LspFileState>) => Record<string, LspFileState>),
) => void;

interface UseWorkspaceLspSessionOptions {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  openFilesRef: MutableRefObject<Record<string, OpenFileState>>;
  updateLspFiles: LspFilesUpdater;
  onError: (message: string) => void;
}

interface PendingDocumentSync {
  file: OpenFileState;
  mode: "open" | "change";
}

interface DocumentSyncQueue {
  closed: boolean;
  pending: PendingDocumentSync | null;
}

const LSP_DIAGNOSTICS_IDLE_DELAY_MS = 750;

/**
 * LSP feature responses all carry a document status.  Most responses for an
 * already-open document repeat that exact status, and publishing a new store
 * map for each one makes the whole workspace chrome render again.  Keep the
 * comparison local and cheap (the capability summary is small) so feature
 * requests that do not change observable state are true no-ops.
 */
function sameDocumentStatus(left: LspDocumentStatus, right: LspDocumentStatus): boolean {
  return left === right || (
    left.path === right.path
    && left.uri === right.uri
    && left.presetId === right.presetId
    && left.languageId === right.languageId
    && left.displayName === right.displayName
    && left.available === right.available
    && left.active === right.active
    && left.selectedCommandId === right.selectedCommandId
    && left.selectedCommand === right.selectedCommand
    && left.installHint === right.installHint
    && left.error === right.error
    && JSON.stringify(left.capabilities ?? null) === JSON.stringify(right.capabilities ?? null)
  );
}

function sameDiagnostics(left: LspDiagnostic[], right: LspDiagnostic[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (
      a.message !== b.message
      || a.severity !== b.severity
      || a.code !== b.code
      || a.source !== b.source
      || a.range.start.line !== b.range.start.line
      || a.range.start.character !== b.range.start.character
      || a.range.end.line !== b.range.end.line
      || a.range.end.character !== b.range.end.character
    ) {
      return false;
    }
  }
  return true;
}

export interface WorkspaceLspSessionController {
  serverStatuses: LspServerStatus[];
  commandPrefs: Record<string, string>;
  customCommands: Record<string, LspCustomCommandConfig>;
  refreshServerStatuses: () => Promise<void>;
  updateCommandPref: (presetId: string, commandId: string) => void;
  updateCustomCommand: (presetId: string, patch: Partial<LspCustomCommandConfig>) => void;
  descriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  /**
   * Descriptor for a path that has no open buffer (library sources re-fetched from
   * the server). `documentUri` retargets the request at a virtual document.
   */
  descriptorForPath: (
    rootPath: string | null,
    filePath: string,
    documentUri?: string | null,
  ) => LspDocumentDescriptor;
  /** True when the language server has the given buffer and no didChange is in flight. */
  isDocumentSynced: (key: string, text: string) => boolean;
  syncDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  saveDocument: (file: OpenFileState, text: string) => Promise<void>;
  closeDocument: (file: OpenFileState) => void;
  forgetDocument: (key: string) => void;
  updateStatus: (file: OpenFileState, status: LspDocumentStatus) => void;
}

/** Centralizes the open/change/save/close lifecycle for one workspace instance. */
export function useWorkspaceLspSession({
  workspaceInstanceId,
  roots,
  openFilesRef,
  updateLspFiles,
  onError,
}: UseWorkspaceLspSessionOptions): WorkspaceLspSessionController {
  const [serverStatuses, setServerStatuses] = useState<LspServerStatus[]>([]);
  const [commandPrefs, setCommandPrefs] = useState<Record<string, string>>(() => readLspCommandPrefs());
  const [customCommands, setCustomCommands] = useState<Record<string, LspCustomCommandConfig>>(
    () => readLspCustomCommands(),
  );
  const [javaHome, setJavaHome] = useState(() => readLspJavaHome());
  const rootsRef = useRef(roots);
  const versionRef = useRef<Record<string, number>>({});
  const syncedTextRef = useRef<Record<string, string>>({});
  const incrementalSyncRef = useRef<Record<string, boolean>>({});
  /** Last known server-active flag per file (avoids store peeks before didChange). */
  const documentActiveRef = useRef<Record<string, boolean>>({});
  const diagnosticsTimersRef = useRef<Record<string, number>>({});
  const syncQueuesRef = useRef<Record<string, DocumentSyncQueue>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      Object.values(syncQueuesRef.current).forEach((queue) => { queue.closed = true; });
      syncQueuesRef.current = {};
      syncedTextRef.current = {};
      incrementalSyncRef.current = {};
      documentActiveRef.current = {};
      Object.values(diagnosticsTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      diagnosticsTimersRef.current = {};
    };
  }, []);

  useEffect(() => () => {
    void lspStopWorkspace(workspaceInstanceId);
  }, [workspaceInstanceId]);

  const refreshServerStatuses = useCallback(async () => {
    try {
      const home = readLspJavaHome().trim();
      await lspSetJavaHome(home || null);
      await lspSetJavaVmargs(readLspJavaVmargs());
      await lspSetJavaSettings(readLspJavaSettings());
      await lspSetJavaBundles(readLspJavaBundles());
      const statuses = await lspDetectServers({ javaHome: home || null });
      if (mountedRef.current) setServerStatuses(statuses);
    } catch (error) {
      if (mountedRef.current) onError(errorMessage(error));
    }
  }, [onError]);

  useEffect(() => {
    void refreshServerStatuses();
  }, [refreshServerStatuses]);

  const restartWorkspaceServers = useCallback(() => {
    if (!mountedRef.current) return;
    syncedTextRef.current = {};
    incrementalSyncRef.current = {};
    documentActiveRef.current = {};
    versionRef.current = {};
    updateLspFiles((current) => Object.fromEntries(
      Object.entries(current).map(([key, state]) => [key, { ...state, syncedText: null }]),
    ));
    void lspStopWorkspace(workspaceInstanceId)
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) void refreshServerStatuses();
      });
  }, [refreshServerStatuses, updateLspFiles, workspaceInstanceId]);

  // Settings is the primary editor for LSP preferences. Keep open workspaces
  // in sync without remounting and restart servers so command/runtime changes
  // take effect for already-open documents.
  useEffect(() => subscribeLspServerPrefs(() => {
    setCommandPrefs(readLspCommandPrefs());
    setCustomCommands(readLspCustomCommands());
    setJavaHome(readLspJavaHome());
    restartWorkspaceServers();
  }), [restartWorkspaceServers]);

  // SDK defaults and workspace bindings affect process environments and the
  // LSP session fingerprint. Restart now instead of waiting for another file
  // to be opened before the selected project/tooling SDK becomes effective.
  useEffect(() => subscribeSdkRegistryChanged(() => {
    restartWorkspaceServers();
  }), [restartWorkspaceServers]);

  const invalidateSyncedText = useCallback(() => {
    syncedTextRef.current = {};
    incrementalSyncRef.current = {};
    documentActiveRef.current = {};
    updateLspFiles((current) => Object.fromEntries(
      Object.entries(current).map(([key, state]) => [key, { ...state, syncedText: null }]),
    ));
  }, [updateLspFiles]);

  const updateCommandPref = useCallback((presetId: string, commandId: string) => {
    setCommandPrefs((current) => {
      const next = { ...current, [presetId]: commandId };
      writeLspCommandPrefs(next);
      return next;
    });
    invalidateSyncedText();
  }, [invalidateSyncedText]);

  const updateCustomCommand = useCallback((presetId: string, patch: Partial<LspCustomCommandConfig>) => {
    setCustomCommands((current) => {
      const existing = current[presetId] ?? { command: "", args: "" };
      const nextConfig = { ...existing, ...patch };
      const next = { ...current };
      if (nextConfig.command.trim() || nextConfig.args.trim()) next[presetId] = nextConfig;
      else delete next[presetId];
      writeLspCustomCommands(next);
      return next;
    });
    invalidateSyncedText();
  }, [invalidateSyncedText]);

  const descriptorForPath = useCallback((
    rootPath: string | null,
    filePath: string,
    documentUri: string | null = null,
  ): LspDocumentDescriptor => {
    const presetId = lspPresetIdForPath(filePath);
    const commandPref = presetId ? commandPrefs[presetId] ?? null : null;
    const serverCommandId = commandPref && commandPref !== CUSTOM_LSP_COMMAND_ID ? commandPref : null;
    const customServerCommand = presetId && commandPref === CUSTOM_LSP_COMMAND_ID
      ? customServerCommandFromConfig(customCommands[presetId])
      : null;
    return {
      workspaceId: workspaceInstanceId,
      rootPath,
      filePath,
      documentUri,
      serverCommandId,
      customServerCommand,
      javaHome: javaHome.trim() || null,
    };
  }, [commandPrefs, customCommands, javaHome, workspaceInstanceId]);

  const descriptorForFile = useCallback((file: OpenFileState): LspDocumentDescriptor | null => {
    // Library sources (jdt:// JDK / JAR classes) have no file of their own: keep the
    // origin project's path so the request lands on that project's session, and let
    // the server resolve the class from the virtual URI.
    if (file.library) {
      return descriptorForPath(
        file.library.originRootPath,
        file.library.originFilePath,
        file.library.uri,
      );
    }
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      const root = rootsRef.current.find((candidate) => candidate.id === rootId);
      if (!root) return null;
      return descriptorForPath(root.path, file.ref.path);
    }
    return descriptorForPath(null, file.ref.path);
  }, [descriptorForPath]);

  const updateStatus = useCallback((file: OpenFileState, status: LspDocumentStatus) => {
    if (!mountedRef.current) return;
    documentActiveRef.current[file.key] = status.active;
    updateLspFiles((current) => {
      const existing = current[file.key] ?? emptyLspFileState();
      if (existing.status && sameDocumentStatus(existing.status, status)
        && !existing.syncing && existing.error === null) {
        return current;
      }
      return {
        ...current,
        [file.key]: {
          ...existing,
          status,
          syncing: false,
          error: null,
        },
      };
    });
  }, [updateLspFiles]);

  const refreshDiagnostics = useCallback(async (file: OpenFileState) => {
    // Library sources are never opened on the server, so they publish no diagnostics.
    if (file.library) return;
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    try {
      const result = await lspGetDiagnostics(descriptor);
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => {
        const existing = current[file.key] ?? emptyLspFileState();
        const statusUnchanged = existing.status
          ? sameDocumentStatus(existing.status, result.status)
          : false;
        if (
          statusUnchanged
          && sameDiagnostics(existing.diagnostics, result.diagnostics)
          && !existing.syncing
          && existing.error === null
        ) {
          return current;
        }
        return {
          ...current,
          [file.key]: {
            ...existing,
            status: result.status,
            diagnostics: result.diagnostics,
            syncing: false,
            error: null,
          },
        };
      });
    } catch (error) {
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => {
        const existing = current[file.key] ?? emptyLspFileState();
        const message = errorMessage(error);
        if (!existing.syncing && existing.error === message) return current;
        return {
          ...current,
          [file.key]: {
            ...existing,
            syncing: false,
            error: message,
          },
        };
      });
    }
  }, [descriptorForFile, openFilesRef, updateLspFiles]);

  const scheduleDiagnostics = useCallback((key: string) => {
    const existing = diagnosticsTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    diagnosticsTimersRef.current[key] = window.setTimeout(() => {
      delete diagnosticsTimersRef.current[key];
      const latest = openFilesRef.current[key];
      // Only poll diagnostics while the server is actually serving this file.
      if (!latest || !documentActiveRef.current[key]) return;
      void refreshDiagnostics(latest);
    }, LSP_DIAGNOSTICS_IDLE_DELAY_MS);
  }, [openFilesRef, refreshDiagnostics]);

  /**
   * Live didChange traffic must not thrash the status pill spinner. Only show
   * "busy/starting" while the document is not yet active (first open or
   * server restart). Continuous typing otherwise keeps a queue.pending almost
   * always true, which used to leave the Java pill spinning on every key.
   */
  const isDocumentSynced = useCallback((key: string, text: string) => {
    if (syncedTextRef.current[key] !== text) return false;
    const queue = syncQueuesRef.current[key];
    return !queue || queue.closed;
  }, []);

  const syncDocument = useCallback(async (file: OpenFileState, mode: "open" | "change") => {
    if (file.loading) return;
    // Library sources are owned by the server, not by us: no didOpen/didChange.
    if (file.library) return;
    // No language-server preset for this extension → never open an IPC path.
    if (!lspPresetIdForPath(file.languagePath)) return;
    // didChange without an active session (and not mid-open) is a no-op.
    if (
      mode === "change"
      && !documentActiveRef.current[file.key]
      && !syncQueuesRef.current[file.key]
    ) {
      return;
    }

    const running = syncQueuesRef.current[file.key];
    if (running) {
      running.pending = { file, mode };
      return;
    }

    const queue: DocumentSyncQueue = { closed: false, pending: null };
    syncQueuesRef.current[file.key] = queue;
    let next: PendingDocumentSync | null = { file, mode };
    try {
      while (next && mountedRef.current && !queue.closed) {
        const currentSync: PendingDocumentSync = next;
        next = null;
        const descriptor = descriptorForFile(currentSync.file);
        if (!descriptor) break;
        const version = (versionRef.current[currentSync.file.key] ?? 0) + 1;
        versionRef.current[currentSync.file.key] = version;
        // Mark busy only for open / not-yet-active sessions. Active didChange
        // stays silent so the chrome does not re-render or spin per keystroke.
        const showBusy = currentSync.mode === "open"
          || !documentActiveRef.current[currentSync.file.key];
        if (showBusy) {
          updateLspFiles((current) => {
            const existing = current[currentSync.file.key] ?? emptyLspFileState();
            return {
              ...current,
              [currentSync.file.key]: {
                ...existing,
                syncing: true,
                error: null,
                // Drop a prior exit/start error so the pill can show "starting…"
                // for this attempt instead of the stale failure text.
                status: existing.status
                  ? { ...existing.status, error: null }
                  : existing.status,
              },
            };
          });
        }
        let active = false;
        try {
          const previousText = syncedTextRef.current[currentSync.file.key];
          const change = previousText === undefined
            ? null
            : buildIncrementalContentChange(previousText, currentSync.file.text);
          let status: LspDocumentStatus;
          if (currentSync.mode === "open") {
            status = await lspOpenDocument(descriptor, currentSync.file.text, version);
          } else {
            const omitFullText = incrementalSyncRef.current[currentSync.file.key] && change !== null;
            try {
              status = await lspChangeDocument(
                descriptor,
                omitFullText ? null : currentSync.file.text,
                version,
                change,
              );
            } catch (error) {
              if (!omitFullText) throw error;
              status = await lspChangeDocument(
                descriptor,
                currentSync.file.text,
                version,
                change,
              );
            }
          }
          active = status.active;
          documentActiveRef.current[currentSync.file.key] = active;
          const fileIsOpen = !!openFilesRef.current[currentSync.file.key];
          if (!mountedRef.current || queue.closed || !fileIsOpen) {
            if (mountedRef.current && (queue.closed || !fileIsOpen)) {
              void lspCloseDocument(descriptor);
            }
            break;
          }
          if (active) {
            syncedTextRef.current[currentSync.file.key] = currentSync.file.text;
            incrementalSyncRef.current[currentSync.file.key] =
              status.capabilities?.textDocumentSyncKind === 2;
          } else {
            // Unavailable / failed start: clear so typing does not keep a stale
            // "synced" view that features might misread.
            delete syncedTextRef.current[currentSync.file.key];
            delete incrementalSyncRef.current[currentSync.file.key];
          }
          const hasPending = queue.pending !== null;
          // Keep the spinner only while the server is still coming up. Once
          // active, mid-burst didChange completions stay out of the store so
          // typing does not re-render the whole workspace chrome; publish the
          // final syncedText when the queue drains.
          updateLspFiles((current) => {
            const existing = current[currentSync.file.key] ?? emptyLspFileState();
            const nextSyncing = !active && hasPending;
            const statusUnchanged = !!existing.status
              && sameDocumentStatus(existing.status, status);
            // Typing burst: more keystrokes are already queued. syncedTextRef
            // tracks progress; skip the React/Zustand publish until drain.
            if (
              active
              && hasPending
              && statusUnchanged
              && existing.error === null
              && !existing.syncing
            ) {
              return current;
            }
            if (
              statusUnchanged
              && existing.syncedText === currentSync.file.text
              && existing.syncing === nextSyncing
              && existing.error === null
            ) {
              return current;
            }
            return {
              ...current,
              [currentSync.file.key]: {
                ...existing,
                status,
                diagnostics: existing.diagnostics,
                syncing: nextSyncing,
                syncedText: currentSync.file.text,
                error: null,
              },
            };
          });
          // Diagnostics only matter for a live server; avoid polling after a
          // failed open (missing binary) on every subsequent keystroke burst.
          if (active) scheduleDiagnostics(currentSync.file.key);
        } catch (error) {
          if (!mountedRef.current || queue.closed || !openFilesRef.current[currentSync.file.key]) break;
          updateLspFiles((current) => ({
            ...current,
            [currentSync.file.key]: {
              ...(current[currentSync.file.key] ?? emptyLspFileState()),
              // Errors surface immediately; do not leave a sticky spinner for
              // follow-up keystrokes that are merely queued.
              syncing: false,
              error: errorMessage(error),
            },
          }));
        }
        next = queue.pending;
        queue.pending = null;
        if (next && active) next.mode = "change";
      }
    } finally {
      if (syncQueuesRef.current[file.key] === queue) delete syncQueuesRef.current[file.key];
    }
  }, [descriptorForFile, openFilesRef, scheduleDiagnostics, updateLspFiles]);

  const saveDocument = useCallback(async (file: OpenFileState, text: string) => {
    if (file.library) return;
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    try {
      const status = await lspSaveDocument(descriptor, text, versionRef.current[file.key] ?? 0);
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          status,
          syncing: false,
          syncedText: text,
          error: null,
        },
      }));
      scheduleDiagnostics(file.key);
    } catch (error) {
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          syncing: false,
          syncedText: text,
          error: errorMessage(error),
        },
      }));
    }
  }, [descriptorForFile, openFilesRef, scheduleDiagnostics, updateLspFiles]);

  const forgetDocument = useCallback((key: string) => {
    delete versionRef.current[key];
    delete syncedTextRef.current[key];
    delete incrementalSyncRef.current[key];
    delete documentActiveRef.current[key];
    const timer = diagnosticsTimersRef.current[key];
    if (timer) window.clearTimeout(timer);
    delete diagnosticsTimersRef.current[key];
  }, []);

  const closeDocument = useCallback((file: OpenFileState) => {
    const queue = syncQueuesRef.current[file.key];
    if (queue) {
      queue.closed = true;
      queue.pending = null;
      delete syncQueuesRef.current[file.key];
    }
    // Never opened by us (library source) → nothing to close on the server.
    const descriptor = file.library ? null : descriptorForFile(file);
    if (descriptor) void lspCloseDocument(descriptor);
    forgetDocument(file.key);
  }, [descriptorForFile, forgetDocument]);

  return {
    serverStatuses,
    commandPrefs,
    customCommands,
    refreshServerStatuses,
    updateCommandPref,
    updateCustomCommand,
    descriptorForFile,
    descriptorForPath,
    isDocumentSynced,
    syncDocument,
    saveDocument,
    closeDocument,
    forgetDocument,
    updateStatus,
  };
}
