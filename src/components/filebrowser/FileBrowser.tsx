import {
  useEffect,
  useCallback,
  useState,
  useMemo,
  useRef,
} from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  Link2,
  Rows,
  Columns,
  Maximize2,
  X,
  ArrowLeftRight,
  Map,
} from "lucide-react";
import { FilePanel, isPreviewable } from "./FilePanel";
import { FileTransferQueue } from "./FileTransferQueue";
import { ChmodDialog } from "./ChmodDialog";
import { PathMappingsEditor, resolveRemoteByMapping, resolveLocalByMapping } from "./PathMappingsEditor";
import { useSftpStore, type PaneSide } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { joinPath, basename, parentPath, sftpStat, effectiveFileType, type FileEntry, type FsSide } from "../../lib/sftp";
import type { SftpPathMapping } from "../../types";
import {
  listenSshAuthPrompt,
  submitSshAuthResponse,
  type SshAuthPromptPayload,
} from "../../lib/ipc";
import type { MenuItem } from "../ContextMenu";
import { MfaPrompt } from "../session/MfaPrompt";
import { useAppStore } from "../../stores/appStore";
import { useT, type TranslateFn } from "../../lib/i18n";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { loadSftpPreferences } from "../../lib/sftpPreferences";

type Orientation = "horizontal" | "vertical";

const ORIENTATION_KEY_PREFIX = "taomni.sftp.orientation.";

function loadOrientation(scope: string, fallback: Orientation): Orientation {
  try {
    const v = localStorage.getItem(ORIENTATION_KEY_PREFIX + scope);
    return v === "horizontal" || v === "vertical" ? v : fallback;
  } catch {
    return fallback;
  }
}

function saveOrientation(scope: string, value: Orientation): void {
  try {
    localStorage.setItem(ORIENTATION_KEY_PREFIX + scope, value);
  } catch {
    /* noop */
  }
}

interface FileBrowserProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  networkSettingsJson?: string | null;
  initialPath?: string;
  onDetach?: () => void;
  onClose?: () => void;
  onTerminalSync?: (cwd: string) => void;
  cwdHint?: string | null;
  cwdHintVersion?: number;
  onRequestTerminalCwd?: () => boolean;
  detachable?: boolean;
  /** Default split direction; user can flip with the toolbar button. */
  defaultOrientation?: Orientation;
  /** Show a compact title-bar with detach/close buttons. */
  showHeader?: boolean;
  /** Title shown when `showHeader` is on. */
  title?: string;
  /** Persistence key for the orientation toggle. */
  orientationScope?: string;
  /** When set (attached sidebar), sends a `cd <path>\n` to the parent terminal. */
  onOpenTerminalHere?: (path: string) => void;
  /** Deployment path mappings for this session. */
  pathMappings?: import("../../types").SftpPathMapping[];
  /** One-shot upload request created by an attached SSH terminal paste/drop. */
  pendingUploadRequest?: SftpPendingUploadRequest | null;
  onPendingUploadRequestHandled?: (requestId: number) => void;
}

export interface SftpPendingUploadRequest {
  id: number;
  paths: string[];
  remoteDir: string;
}

export function FileBrowser(props: FileBrowserProps) {
  const t = useT();
  const session = useSftpStore((s) => s.sessions[props.sessionId]);
  const ensureSession = useSftpStore((s) => s.ensureSession);
  const attach = useSftpStore((s) => s.attach);
  const detach = useSftpStore((s) => s.detach);
  const navigate = useSftpStore((s) => s.navigate);
  const reconnect = useSftpStore((s) => s.reconnect);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(props.sessionId);
  const { confirm: confirmDialog, render: confirmDialogRender } = useConfirmDialog();
  const { promptText, render: textInputDialogRender } = useTextInputDialog();

  const [downloadPrompt, setDownloadPrompt] = useState<FileEntry | null>(null);
  const [previewing, setPreviewing] = useState<{ entry: FileEntry; side: FsSide; text: string } | null>(null);
  const [chmodPrompt, setChmodPrompt] = useState<{ entries: FileEntry[]; side: FsSide } | null>(null);
  const [mfaPrompt, setMfaPrompt] = useState<SshAuthPromptPayload | null>(null);
  // Per-pane filter strings (case-insensitive substring match).
  const [localFilter, setLocalFilter] = useState("");
  const [remoteFilter, setRemoteFilter] = useState("");
  // Path mappings panel state — local editable copy derived from props
  const [showMappings, setShowMappings] = useState(false);
  const [mappings, setMappings] = useState<SftpPathMapping[]>(props.pathMappings ?? []);

  const orientationScope = props.orientationScope ?? props.sessionId;
  const [orientation, setOrientationState] = useState<Orientation>(() =>
    loadOrientation(orientationScope, props.defaultOrientation ?? "horizontal"),
  );
  const setOrientation = useCallback(
    (next: Orientation) => {
      setOrientationState(next);
      saveOrientation(orientationScope, next);
    },
    [orientationScope],
  );

  const pendingTerminalSyncRef = useRef(false);
  const pendingMfaRequestIdRef = useRef<string | null>(null);
  const authPromptReadyRef = useRef<Promise<unknown>>(Promise.resolve());
  const requestedCwdVersionRef = useRef(props.cwdHintVersion ?? 0);
  const terminalSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledUploadRequestRef = useRef<number | null>(null);
  const onPendingUploadRequestHandledRef = useRef(props.onPendingUploadRequestHandled);

  useEffect(() => {
    onPendingUploadRequestHandledRef.current = props.onPendingUploadRequestHandled;
  }, [props.onPendingUploadRequestHandled]);

  const clearTerminalSyncTimeout = useCallback(() => {
    if (!terminalSyncTimeoutRef.current) return;
    clearTimeout(terminalSyncTimeoutRef.current);
    terminalSyncTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    let destroyed = false;
    let unlistenAuthPrompt: (() => void) | null = null;
    const sid = props.sessionId;

    setMfaPrompt(null);
    pendingMfaRequestIdRef.current = null;

    const ready = listenSshAuthPrompt(sid, (payload) => {
      if (destroyed) {
        void submitSshAuthResponse(payload.requestId, null).catch(() => {});
        return;
      }
      pendingMfaRequestIdRef.current = payload.requestId;
      setMfaPrompt(payload);
    })
      .then((unlisten) => {
        if (destroyed) {
          unlisten();
        } else {
          unlistenAuthPrompt = unlisten;
        }
      })
      .catch(() => undefined);

    authPromptReadyRef.current = ready;

    return () => {
      destroyed = true;
      unlistenAuthPrompt?.();
      if (pendingMfaRequestIdRef.current) {
        void submitSshAuthResponse(pendingMfaRequestIdRef.current, null).catch(() => {});
        pendingMfaRequestIdRef.current = null;
      }
    };
  }, [props.sessionId]);

  useEffect(() => {
    let cancelled = false;
    ensureSession(props.sessionId);
    void (async () => {
      await authPromptReadyRef.current.catch(() => undefined);
      if (cancelled) return;
      const current = useSftpStore.getState().sessions[props.sessionId];
      if (current?.attached || current?.attaching) return;
      attach({
        sessionId: props.sessionId,
        host: props.host,
        port: props.port,
        username: props.username,
        authMethod: props.authMethod,
        authData: props.authData,
        networkSettingsJson: props.networkSettingsJson ?? null,
      })
        .then(() => {
          if (!cancelled && props.initialPath) {
            void navigate(props.sessionId, "remote", props.initialPath);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setStatus(t("fileBrowser.statusSftpConnectFailed", { error: String(err) }));
          }
        });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // Tear down the SFTP channel when this view unmounts. The store
  // ref-counts attaches, so a sidebar + detached window with the same
  // session id are safe. We do not detach the attached sidebar session on
  // unmount so that the session, its navigated folders, and active transfers
  // are preserved when the user merely hides the sidebar.
  useEffect(() => {
    const sid = props.sessionId;
    const isAttachedSidebar = sid.startsWith("attached-") && !sid.endsWith("__detached");
    return () => {
      if (!isAttachedSidebar) {
        void detach(sid);
      }
    };
  }, [props.sessionId, detach]);

  useEffect(() => {
    const handleTerminalReconnected = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string }>;
      const targetTabId = customEvent.detail?.tabId;
      if (!targetTabId) return;

      const isAttachedSidebar = props.sessionId === `attached-${targetTabId}`;
      if (isAttachedSidebar) {
        void reconnect(props.sessionId).catch((err) => {
          console.error("Auto-reconnection of SFTP failed:", err);
        });
      }
    };

    window.addEventListener("taomni:terminal-reconnected", handleTerminalReconnected);
    return () => {
      window.removeEventListener("taomni:terminal-reconnected", handleTerminalReconnected);
    };
  }, [props.sessionId, reconnect]);

  useEffect(() => {
    pendingTerminalSyncRef.current = false;
    requestedCwdVersionRef.current = props.cwdHintVersion ?? 0;
    clearTerminalSyncTimeout();
  }, [clearTerminalSyncTimeout, props.sessionId]);

  useEffect(() => () => clearTerminalSyncTimeout(), [clearTerminalSyncTimeout]);

  const syncToTerminalCwd = useCallback(() => {
    if (props.onRequestTerminalCwd) {
      pendingTerminalSyncRef.current = true;
      requestedCwdVersionRef.current = props.cwdHintVersion ?? 0;
      clearTerminalSyncTimeout();
      const requested = props.onRequestTerminalCwd();
      if (!requested) {
        pendingTerminalSyncRef.current = false;
        return;
      }
      terminalSyncTimeoutRef.current = setTimeout(() => {
        if (!pendingTerminalSyncRef.current) return;
        pendingTerminalSyncRef.current = false;
        terminalSyncTimeoutRef.current = null;
        setStatus(t("fileBrowser.statusTerminalCwdSilent"));
      }, 5000);
      setStatus(t("fileBrowser.statusRequestingTerminalCwd"));
      return;
    }
    if (!props.cwdHint) {
      setStatus(t("fileBrowser.statusTerminalCwdUnknown"));
      return;
    }
    if (!session?.attached) return;
    if (session.remote.path === props.cwdHint) {
      setStatus(t("fileBrowser.statusAlreadyAt", { path: props.cwdHint }));
      return;
    }
    void navigate(props.sessionId, "remote", props.cwdHint);
  }, [
    clearTerminalSyncTimeout,
    navigate,
    props.cwdHint,
    props.cwdHintVersion,
    props.onRequestTerminalCwd,
    props.sessionId,
    session?.attached,
    session?.remote.path,
    setStatus,
  ]);

  useEffect(() => {
    if (!pendingTerminalSyncRef.current) return;
    if (!session?.attached) return;
    if (!props.cwdHint) return;
    const version = props.cwdHintVersion ?? 0;
    if (version <= requestedCwdVersionRef.current) return;

    pendingTerminalSyncRef.current = false;
    clearTerminalSyncTimeout();
    if (session.remote.path === props.cwdHint) {
      setStatus(t("fileBrowser.statusAlreadyAt", { path: props.cwdHint }));
      return;
    }
    void navigate(props.sessionId, "remote", props.cwdHint);
  }, [
    clearTerminalSyncTimeout,
    navigate,
    props.cwdHint,
    props.cwdHintVersion,
    props.sessionId,
    session?.attached,
    session?.remote.path,
    setStatus,
  ]);

  const handleDoubleClick = useCallback(
    async (side: PaneSide, entry: FileEntry) => {
      if (effectiveFileType(entry) === "dir") {
        await navigate(props.sessionId, side, entry.path);
        if (side === "remote") props.onTerminalSync?.(entry.path);
        return;
      }
      if (side === "remote") {
        setDownloadPrompt(entry);
        return;
      }
      // Local file: open or upload based on global SFTP preference (default: open).
      const { localDoubleClickAction } = loadSftpPreferences();
      if (localDoubleClickAction === "upload") {
        const remoteDir = session?.remote.path ?? "/";
        const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
        void controller.upload(entry, mappedRemote ?? remoteDir);
        return;
      }
      try {
        const { sftpOpenPath } = await import("../../lib/sftp");
        await sftpOpenPath(entry.path);
      } catch (err) {
        setStatus(t("fileBrowser.statusFailedToOpen", { name: entry.name, error: String(err) }));
      }
    },
    [
      controller,
      mappings,
      navigate,
      props.sessionId,
      props.onTerminalSync,
      session?.remote.path,
      setStatus,
      t,
    ],
  );

  const handleDownloadConfirmed = useCallback(
    (entry: FileEntry, openAfter: boolean) => {
      const localDir = session?.local.path ?? "";
      void controller.download(entry, localDir, { openAfter });
      setDownloadPrompt(null);
    },
    [controller, session?.local.path],
  );

  const handleOpenLocal = useCallback(
    async (entries: FileEntry[]) => {
      const { sftpOpenPath } = await import("../../lib/sftp");
      for (const entry of entries) {
        if (effectiveFileType(entry) === "dir") {
          await navigate(props.sessionId, "local", entry.path);
          return;
        }
        try {
          await sftpOpenPath(entry.path);
        } catch (err) {
          setStatus(t("fileBrowser.statusFailedToOpen", { name: entry.name, error: String(err) }));
        }
      }
    },
    [navigate, props.sessionId, setStatus, t],
  );

  const renameEntry = useCallback(
    async (entry: FileEntry, side: FsSide) => {
      const next = await promptText({
        title: t("fileBrowser.promptRenameTitle"),
        initialValue: entry.name,
      });
      if (next && next !== entry.name) {
        void controller.rename(entry.path, next, side);
      }
    },
    [controller, promptText, t],
  );

  const deleteEntries = useCallback(
    async (entries: FileEntry[], side: FsSide) => {
      if (entries.length === 0) return;
      const summary = entries.length === 1
        ? entries[0].name
        : t("fileBrowser.summaryItems", { count: entries.length });
      const message = side === "remote"
        ? t("fileBrowser.confirmDeleteRemoteSummary", { summary })
        : t("fileBrowser.confirmDeleteSummary", { summary });
      const confirmed = await confirmDialog({
        message,
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (!confirmed) return;
      for (const entry of entries) {
        void controller.remove(entry.path, side, true);
      }
    },
    [confirmDialog, controller, t],
  );

  const createFolder = useCallback(
    async (side: FsSide) => {
      const name = await promptText({
        title: t("fileBrowser.promptNewFolderTitle"),
        initialValue: t("fileBrowser.promptNewFolderDefault"),
      });
      if (!name) return;
      const dir = side === "remote" ? session?.remote.path ?? "/" : session?.local.path ?? "";
      void controller.mkdir(dir, name, side);
    },
    [controller, promptText, session?.local.path, session?.remote.path, t],
  );

  const createFile = useCallback(
    async (side: FsSide) => {
      const name = await promptText({
        title: t("fileBrowser.promptNewFileTitle"),
        initialValue: t("fileBrowser.promptNewFileDefault"),
      });
      if (!name) return;
      const dir = side === "remote" ? session?.remote.path ?? "/" : session?.local.path ?? "";
      void controller.createFile(dir, name, side);
    },
    [controller, promptText, session?.local.path, session?.remote.path, t],
  );

  const localContext = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number }, selectedEntries: FileEntry[]): MenuItem[] => {
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry];
      const target = targets[0] ?? entry;
      const multi = targets.length > 1;
      const items: MenuItem[] = [];
      items.push({
        label: effectiveFileType(entry) === "dir"
          ? t("fileBrowser.contextOpenFolder")
          : multi
            ? t("fileBrowser.contextOpenFiles", { count: targets.length })
            : t("fileBrowser.contextOpen"),
        onClick: () => void handleOpenLocal(targets),
      });
      items.push({
        label: multi ? t("fileBrowser.contextUploadCountToRemote", { count: targets.length }) : t("fileBrowser.contextUploadToRemote"),
        testId: multi ? `context-menu-item-upload-${targets.length}-selected-to-remote` : "context-menu-item-upload-to-remote",
        onClick: () => {
          const remoteDir = session?.remote.path ?? "/";
          for (const item of targets) {
            // Use path mapping if available — check if the local file's path matches a mapping
            const mappedRemote = resolveRemoteByMapping(item.path, mappings);
            void controller.upload(item, mappedRemote ?? remoteDir);
          }
        },
      });
      if (!multi) {
        items.push({
          label: t("fileBrowser.contextRename"),
          onClick: () => void renameEntry(target, "local"),
        });
      }
      items.push({
        label: multi ? t("fileBrowser.contextPermissionsCount", { count: targets.length }) : t("fileBrowser.contextPermissions"),
        onClick: () => setChmodPrompt({ entries: targets, side: "local" }),
      });
      items.push({
        label: multi ? t("fileBrowser.contextDeleteCount", { count: targets.length }) : t("fileBrowser.contextDelete"),
        onClick: () => void deleteEntries(targets, "local"),
        danger: true,
      });
      return items;
    },
    [controller, deleteEntries, handleOpenLocal, mappings, renameEntry, session?.remote.path, t],
  );

  const remoteContext = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number }, selectedEntries: FileEntry[]): MenuItem[] => {
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry];
      const target = targets[0] ?? entry;
      const multi = targets.length > 1;
      const items: MenuItem[] = [];
      items.push({
        label: multi ? t("fileBrowser.contextDownloadCountToLocal", { count: targets.length }) : t("fileBrowser.contextDownloadToLocal"),
        testId: multi ? `context-menu-item-download-${targets.length}-selected-to-local` : "context-menu-item-download-to-local",
        onClick: () => {
          const localDir = session?.local.path ?? "";
          for (const item of targets) {
            void controller.download(item, localDir, { openAfter: false });
          }
        },
      });
      if (!multi && target.fileType === "file") {
        items.push({
          label: t("fileBrowser.contextDownloadAndOpen"),
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(target, localDir, { openAfter: true });
          },
        });
      }
      if (!multi) {
        items.push({
          label: t("fileBrowser.contextRename"),
          onClick: () => void renameEntry(target, "remote"),
        });
      }
      items.push({
        label: multi ? t("fileBrowser.contextPermissionsCount", { count: targets.length }) : t("fileBrowser.contextPermissions"),
        onClick: () => setChmodPrompt({ entries: targets, side: "remote" }),
      });
      items.push({
        label: multi ? t("fileBrowser.contextDeleteCount", { count: targets.length }) : t("fileBrowser.contextDelete"),
        onClick: () => void deleteEntries(targets, "remote"),
        danger: true,
      });
      return items;
    },
    [controller, deleteEntries, renameEntry, session?.local.path, t],
  );

  const localEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: t("fileBrowser.contextNewFolder"),
        onClick: () => void createFolder("local"),
      },
      {
        label: t("fileBrowser.contextNewFile"),
        onClick: () => void createFile("local"),
      },
    ],
    [createFile, createFolder, t],
  );

  const remoteEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: t("fileBrowser.contextNewFolder"),
        onClick: () => void createFolder("remote"),
      },
      {
        label: t("fileBrowser.contextNewFile"),
        onClick: () => void createFile("remote"),
      },
    ],
    [createFile, createFolder, t],
  );

  const handleLocalFiles = useCallback(
    async (files: File[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const file of files) {
        await controller.uploadBlob(remoteDir, file);
      }
    },
    [controller, session?.remote.path],
  );

  const handleLocalPaths = useCallback(
    async (paths: string[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const path of paths) {
        try {
          const entry = await sftpStat(props.sessionId, path, "local");
          // Use path mapping if available
          const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
          await controller.upload(entry, mappedRemote ?? remoteDir);
        } catch (err) {
          setStatus(t("fileBrowser.statusUploadFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }
    },
    [controller, mappings, props.sessionId, session?.remote.path, setStatus, t],
  );

  useEffect(() => {
    const request = props.pendingUploadRequest;
    if (!request) return;
    if (handledUploadRequestRef.current === request.id) return;
    if (!session?.attached) return;

    handledUploadRequestRef.current = request.id;
    let cancelled = false;
    let finished = false;
    const finishRequest = () => {
      if (finished) return;
      finished = true;
      onPendingUploadRequestHandledRef.current?.(request.id);
    };

    void (async () => {
      const currentRemotePath = useSftpStore.getState().sessions[props.sessionId]?.remote.path ?? "/";
      const remoteDir = request.remoteDir || currentRemotePath;
      try {
        if (currentRemotePath !== remoteDir) {
          await navigate(props.sessionId, "remote", remoteDir);
        }
      } catch (err) {
        setStatus(t("fileBrowser.statusNavigateFailed", { error: String(err) }));
      }

      let localDir: string | null = null;
      for (const path of request.paths) {
        if (cancelled) return;
        try {
          const entry = await sftpStat(props.sessionId, path, "local");
          if (!localDir) {
            localDir = parentPath(entry.path);
            if (localDir) {
              await navigate(props.sessionId, "local", localDir);
            }
          }
          await controller.upload(entry, remoteDir);
        } catch (err) {
          setStatus(t("fileBrowser.statusUploadFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }

      finishRequest();
    })();

    return () => {
      cancelled = true;
      // The request is one-shot. Closing the sidebar discards paths that have
      // not started yet so remounting cannot enqueue the same batch again.
      finishRequest();
    };
  }, [
    controller.upload,
    navigate,
    props.pendingUploadRequest,
    props.sessionId,
    session?.attached,
    setStatus,
    t,
  ]);

  const handleCrossPaneToLocal = useCallback(
    async (entries: FileEntry[]) => {
      const localDir = session?.local.path ?? "";
      for (const entry of entries) {
        // Use path mapping if available — map remote path back to local
        const mappedLocal = resolveLocalByMapping(entry.path, mappings);
        const targetDir = mappedLocal
          ? (entry.fileType === "dir" ? mappedLocal : mappedLocal.replace(/[/\\][^/\\]*$/, "") || localDir)
          : localDir;
        await controller.download(entry, targetDir, { openAfter: false });
      }
    },
    [controller, mappings, session?.local.path],
  );

  const handleCrossPaneToRemote = useCallback(
    async (entries: FileEntry[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const entry of entries) {
        // Use path mapping if available
        const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
        await controller.upload(entry, mappedRemote ?? remoteDir);
      }
    },
    [controller, mappings, session?.remote.path],
  );

  const banner = useMemo(() => {
    if (!session) return null;
    if (session.attaching) return t("fileBrowser.bannerAttaching");
    if (session.error) return t("fileBrowser.bannerError", { error: session.error });
    if (!session.attached) return t("fileBrowser.bannerNotAttached");
    return null;
  }, [session, t]);

  const showCwdToolbar = !!props.onRequestTerminalCwd || props.cwdHint != null;

  return (
    <div data-testid="sftp-browser" className="w-full h-full flex flex-col" style={{ background: "var(--taomni-bg)" }}>
      {props.showHeader && (
        <div
          className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0 gap-1"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <span className="truncate flex-1">{props.title ?? t("fileBrowser.headerSftp")}</span>
          <OrientationToggle orientation={orientation} onChange={setOrientation} t={t} />
          {mappings.length > 0 && (
            <button
              data-testid="sftp-mappings-toggle"
              type="button"
              className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)]"
              title={t("fileBrowser.pathMappingsToggleTitle")}
              style={{ color: showMappings ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
              onClick={() => setShowMappings((v) => !v)}
            >
              <Map className="w-3 h-3" />
              <span className="text-[10px]">{t("fileBrowser.pathMappingsToggle")}</span>
              <span
                className="text-[10px] rounded-full px-1"
                style={{ background: "var(--taomni-accent)", color: "white", minWidth: "14px", textAlign: "center" }}
              >
                {mappings.length}
              </span>
            </button>
          )}
          {props.onDetach && (
            <button
              data-testid="sftp-detach"
              type="button"
              className="px-1 hover:bg-[var(--taomni-hover)] rounded"
              title={t("fileBrowser.detachOpenInWindow")}
              onClick={props.onDetach}
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          )}
          {props.onClose && (
            <button
              data-testid="sftp-close"
              type="button"
              className="px-1 hover:bg-[var(--taomni-hover)] rounded"
              title={t("fileBrowser.hideSftpPanel")}
              onClick={props.onClose}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
      {showCwdToolbar && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0 flex items-center gap-2"
          style={{
            borderColor: "var(--taomni-divider)",
            background: "var(--taomni-quick-bg)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <span className="shrink-0">{t("fileBrowser.terminalCwdLabel")}</span>
          <span className="font-mono truncate flex-1" title={props.cwdHint ?? ""}>
            {props.cwdHint ?? t("fileBrowser.terminalCwdNotRequested")}
          </span>
          <button
            type="button"
            className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] shrink-0"
            title={t("fileBrowser.terminalCwdQueryTitle")}
            onClick={syncToTerminalCwd}
            style={{ color: "var(--taomni-accent)" }}
          >
            <Link2 className="w-3 h-3" />
            <span>{t("fileBrowser.terminalCwdSync")}</span>
          </button>
          {!props.showHeader && (
            <OrientationToggle orientation={orientation} onChange={setOrientation} t={t} />
          )}
          {!props.showHeader && mappings.length > 0 && (
            <button
              data-testid="sftp-mappings-toggle"
              type="button"
              className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] shrink-0"
              title={t("fileBrowser.pathMappingsToggleTitle")}
              style={{ color: showMappings ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
              onClick={() => setShowMappings((v) => !v)}
            >
              <Map className="w-3 h-3" />
              <span>{t("fileBrowser.pathMappingsToggle")}</span>
              <span
                className="text-[10px] rounded-full px-1"
                style={{ background: "var(--taomni-accent)", color: "white", minWidth: "14px", textAlign: "center" }}
              >
                {mappings.length}
              </span>
            </button>
          )}
        </div>
      )}
      {/* Standalone mappings toolbar — shown for non-header tabs that have mappings */}
      {!props.showHeader && !showCwdToolbar && mappings.length > 0 && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0 flex items-center gap-2"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <OrientationToggle orientation={orientation} onChange={setOrientation} t={t} />
          <div className="flex-1" />
          <button
            data-testid="sftp-mappings-toggle"
            type="button"
            className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)]"
            title={t("fileBrowser.pathMappingsToggleTitle")}
            style={{ color: showMappings ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
            onClick={() => setShowMappings((v) => !v)}
          >
            <Map className="w-3 h-3" />
            <span>{t("fileBrowser.pathMappingsToggle")}</span>
            <span
              className="text-[10px] rounded-full px-1"
              style={{ background: "var(--taomni-accent)", color: "white", minWidth: "14px", textAlign: "center" }}
            >
              {mappings.length}
            </span>
          </button>
        </div>
      )}
      {/* Path mappings panel — shown when user toggles the Mappings button */}
      {showMappings && (
        <div
          data-testid="sftp-mappings-panel"
          className="border-b shrink-0 px-3 py-2"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <div className="text-[11px] font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: "var(--taomni-accent)" }}>
            <Map className="w-3 h-3" />
            {t("fileBrowser.pathMappingsTitle")}
          </div>
          <PathMappingsEditor
            mappings={mappings}
            onChange={setMappings}
            compact
          />
          {mappings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {mappings.map((m, i) => (
                m.localPath && m.remotePath ? (
                  <button
                    key={i}
                    type="button"
                    className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)] inline-flex items-center gap-1"
                    style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
                    title={`${t("fileBrowser.pathMappingsNavigateLocal")}: ${m.localPath}`}
                    onClick={() => {
                      if (m.localPath && session?.attached) {
                        void navigate(props.sessionId, "local", m.localPath);
                      }
                      if (m.remotePath && session?.attached) {
                        void navigate(props.sessionId, "remote", m.remotePath);
                      }
                    }}
                  >
                    <span className="font-mono truncate max-w-[120px]">{m.localPath}</span>
                    <span>→</span>
                    <span className="font-mono truncate max-w-[120px]">{m.remotePath}</span>
                  </button>
                ) : null
              ))}
            </div>
          )}
        </div>
      )}
      {banner && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0"
          style={{
            borderColor: "var(--taomni-divider)",
            background: session?.error ? "#fde7e2" : "var(--taomni-quick-bg)",
            color: session?.error ? "#7a1f0a" : "var(--taomni-text)",
          }}
        >
          {banner}
          {session?.error && (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                void reconnect(props.sessionId).catch((err) =>
                  setStatus(t("fileBrowser.statusReconnectFailed", { error: String(err) }))
                );
              }}
            >
              {t("fileBrowser.bannerRetry")}
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PanelGroup
          // Re-mount the panel group when orientation flips so
          // react-resizable-panels reads new sizes cleanly.
          key={orientation}
          orientation={orientation}
          id={`sftp-browser-v2-${orientationScope}-${orientation}`}
          defaultLayout={loadResizableLayout(`sftp-browser-v2-${orientationScope}-${orientation}`, ["remote", "local"])}
          onLayoutChanged={saveResizableLayout(`sftp-browser-v2-${orientationScope}-${orientation}`)}
        >
          <Panel id="remote" defaultSize="50%" minSize="15%" className="flex flex-col min-h-0 min-w-0">
            <FilePanel
              sessionId={props.sessionId}
              side="remote"
              subtitle={`${props.username}@${props.host}`}
              detachable={props.detachable}
              onDetach={props.onDetach}
              onItemDoubleClick={(e) => void handleDoubleClick("remote", e)}
              onItemContext={remoteContext}
              onEmptyContext={remoteEmptyContext}
              acceptCrossPane
              onCrossPaneDrop={handleCrossPaneToRemote}
              filterText={remoteFilter}
              onFilterTextChange={setRemoteFilter}
              onDownloadSelected={(entries) => {
                const localDir = session?.local.path ?? "";
                for (const entry of entries) {
                  void controller.download(entry, localDir, { openAfter: false });
                }
              }}
              onUploadFromDisk={(files) => void handleLocalFiles(files)}
              onUploadPathsFromDisk={(paths) => void handleLocalPaths(paths)}
              onDeleteSelected={(entries) => {
                void deleteEntries(entries, "remote");
              }}
              onChmodSelected={(entries) => {
                if (entries.length === 0) return;
                setChmodPrompt({ entries, side: "remote" });
              }}
              onPreviewSelected={(entry) => {
                if (!isPreviewable(entry)) {
                  setStatus(t("fileBrowser.statusPreviewUnsupported", { name: entry.name }));
                  return;
                }
                void (async () => {
                  try {
                    const { sftpReadFileText } = await import("../../lib/sftp");
                    const text = await sftpReadFileText(props.sessionId, entry.path, "remote");
                    setPreviewing({ entry, side: "remote", text });
                  } catch (err) {
                    setStatus(t("fileBrowser.statusPreviewFailed", { error: String(err) }));
                  }
                })();
              }}
              onNewFolder={() => void createFolder("remote")}
              onNewFile={() => void createFile("remote")}
              onOpenTerminalHere={props.onOpenTerminalHere}
            />
          </Panel>
          <PanelResizeHandle
            className={
              orientation === "horizontal"
                ? "w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"
                : "h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize"
            }
          />
          <Panel id="local" defaultSize="50%" minSize="15%" className="flex flex-col min-h-0 min-w-0">
            <FilePanel
              sessionId={props.sessionId}
              side="local"
              detachable={props.detachable}
              onDetach={props.onDetach}
              onItemDoubleClick={(e) => void handleDoubleClick("local", e)}
              onItemContext={localContext}
              onEmptyContext={localEmptyContext}
              acceptCrossPane
              onCrossPaneDrop={handleCrossPaneToLocal}
              onOpenLocalSelected={(entries) => void handleOpenLocal(entries)}
              onRevealInOs={(path) => {
                if (!path) return;
                void (async () => {
                  try {
                    const { sftpOpenPath } = await import("../../lib/sftp");
                    await sftpOpenPath(path);
                  } catch (err) {
                    setStatus(t("fileBrowser.statusOpenFailed", { error: String(err) }));
                  }
                })();
              }}
              filterText={localFilter}
              onFilterTextChange={setLocalFilter}
              onUploadSelected={(entries) => {
                const remoteDir = session?.remote.path ?? "/";
                for (const entry of entries) {
                  // Use path mapping if available
                  const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
                  void controller.upload(entry, mappedRemote ?? remoteDir);
                }
              }}
              onDeleteSelected={(entries) => {
                void deleteEntries(entries, "local");
              }}
              onChmodSelected={(entries) => {
                if (entries.length === 0) return;
                setChmodPrompt({ entries, side: "local" });
              }}
              onPreviewSelected={(entry) => {
                if (!isPreviewable(entry)) {
                  setStatus(t("fileBrowser.statusPreviewUnsupported", { name: entry.name }));
                  return;
                }
                void (async () => {
                  try {
                    const { sftpReadFileText } = await import("../../lib/sftp");
                    const text = await sftpReadFileText(props.sessionId, entry.path, "local");
                    setPreviewing({ entry, side: "local", text });
                  } catch (err) {
                    setStatus(t("fileBrowser.statusPreviewFailed", { error: String(err) }));
                  }
                })();
              }}
              onNewFolder={() => void createFolder("local")}
              onNewFile={() => void createFile("local")}
            />
          </Panel>
        </PanelGroup>
      </div>
      {/* Future: cross-host transfer (between two remote SFTP sessions).
          Disabled placeholder so the layout stays stable when the feature
          ships. */}
      <div
        className="text-[11px] px-2 py-1 border-t shrink-0 flex items-center gap-2"
        style={{
          borderColor: "var(--taomni-divider)",
          background: "var(--taomni-quick-bg)",
          color: "var(--taomni-text-muted)",
        }}
      >
        <ArrowLeftRight className="w-3 h-3" />
        <span className="truncate">
          {t("fileBrowser.crossHostBanner")}
        </span>
        <button
          type="button"
          disabled
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] opacity-50 cursor-not-allowed"
          style={{ border: "1px solid var(--taomni-divider)" }}
          title={t("fileBrowser.crossHostPickPeerTitle")}
        >
          {t("fileBrowser.crossHostPickPeer")}
        </button>
      </div>
      <FileTransferQueue
        sessionId={props.sessionId}
        onCancel={(id) => void controller.cancelTransfer(id)}
        onPause={(id) => void controller.pauseTransfer(id)}
        onResume={(id) => void controller.resumeTransfer(id)}
        onRetry={(id) => void controller.retryTransfer(id)}
      />

      {downloadPrompt && (
        <DownloadPrompt
          entry={downloadPrompt}
          localDir={session?.local.path ?? ""}
          onCancel={() => setDownloadPrompt(null)}
          onDownload={(openAfter) => handleDownloadConfirmed(downloadPrompt, openAfter)}
        />
      )}

      {chmodPrompt && (
        <ChmodDialog
          entries={chmodPrompt.entries}
          onCancel={() => setChmodPrompt(null)}
          onApply={(mode, recursive) => {
            const { entries, side } = chmodPrompt;
            for (const entry of entries) {
              if (recursive && entry.fileType === "dir") {
                void controller.chmodRecursive(entry.path, mode, side);
              } else {
                void controller.chmod(entry.path, mode, side);
              }
            }
            setChmodPrompt(null);
          }}
        />
      )}

      {previewing && (
        <PreviewModal
          path={previewing.entry.path}
          name={previewing.entry.name}
          text={previewing.text}
          onClose={() => setPreviewing(null)}
        />
      )}

      {confirmDialogRender}
      {textInputDialogRender}

      {mfaPrompt && (
        <MfaPrompt
          host={props.host}
          username={props.username}
          request={mfaPrompt}
          onSubmit={(responses) => {
            void submitSshAuthResponse(mfaPrompt.requestId, responses).catch(() => {});
            pendingMfaRequestIdRef.current = null;
            setMfaPrompt(null);
          }}
          onCancel={() => {
            void submitSshAuthResponse(mfaPrompt.requestId, null).catch(() => {});
            pendingMfaRequestIdRef.current = null;
            setMfaPrompt(null);
          }}
        />
      )}
    </div>
  );
}

function OrientationToggle({
  orientation,
  onChange,
  t,
}: {
  orientation: Orientation;
  onChange: (next: Orientation) => void;
  t: TranslateFn;
}) {
  const next: Orientation = orientation === "horizontal" ? "vertical" : "horizontal";
  return (
    <button
      data-testid="sftp-orientation-toggle"
      type="button"
      className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] shrink-0"
      title={
        orientation === "horizontal"
          ? t("fileBrowser.orientationToggleStackTitle")
          : t("fileBrowser.orientationToggleSideTitle")
      }
      onClick={() => onChange(next)}
      style={{ color: "var(--taomni-text-muted)" }}
    >
      {orientation === "horizontal" ? (
        <Columns className="w-3 h-3" />
      ) : (
        <Rows className="w-3 h-3" />
      )}
      <span className="text-[10px]">
        {orientation === "horizontal" ? t("fileBrowser.orientationSide") : t("fileBrowser.orientationStack")}
      </span>
    </button>
  );
}

function DownloadPrompt({
  entry,
  localDir,
  onCancel,
  onDownload,
}: {
  entry: FileEntry;
  localDir: string;
  onCancel: () => void;
  onDownload: (openAfter: boolean) => void;
}) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-2">{t("fileBrowser.downloadPromptTitle")}</div>
        <div className="text-[12px] mb-3 break-all" style={{ color: "var(--taomni-text-muted)" }}>
          {t("fileBrowser.downloadPromptDescription", { name: entry.name })}
          <div className="mt-1 font-mono text-[11px]">{joinPath(localDir, entry.name)}</div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {t("fileBrowser.chmodCancel")}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={() => onDownload(false)}
          >
            {t("fileBrowser.downloadPromptDownloadOnly")}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => onDownload(true)}
          >
            {t("fileBrowser.downloadPromptDownloadAndOpen")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewModal({
  path,
  name,
  text,
  onClose,
}: {
  path: string;
  name: string;
  text: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[80vw] h-[70vh] rounded shadow-lg flex flex-col"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-1.5 text-[12px] flex items-center border-b"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <span className="font-semibold">{name}</span>
          <span className="ml-2 text-[var(--taomni-text-muted)]">{path}</span>
          <div className="flex-1" />
          <button type="button" className="px-2 py-0.5 hover:bg-[var(--taomni-hover)] rounded" onClick={onClose}>
            {t("fileBrowser.previewClose")}
          </button>
        </div>
        <pre className="flex-1 overflow-auto px-3 py-2 text-[12px] font-mono whitespace-pre-wrap break-all"
          style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
{text}
        </pre>
      </div>
    </div>
  );
}

export { basename };
