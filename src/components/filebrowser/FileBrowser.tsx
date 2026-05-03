import {
  useEffect,
  useCallback,
  useState,
  useMemo,
  useRef,
} from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import {
  Link2,
  Rows,
  Columns,
  Maximize2,
  X,
  ArrowLeftRight,
} from "lucide-react";
import { FilePanel, isPreviewable } from "./FilePanel";
import { FileTransferQueue } from "./FileTransferQueue";
import { ChmodDialog } from "./ChmodDialog";
import { useSftpStore, type PaneSide } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { joinPath, basename, type FileEntry, type FsSide } from "../../lib/sftp";
import type { MenuItem } from "../ContextMenu";
import { useAppStore } from "../../stores/appStore";

type Orientation = "horizontal" | "vertical";

const ORIENTATION_KEY_PREFIX = "newmob.sftp.orientation.";

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
  initialPath?: string;
  onDetach?: () => void;
  onClose?: () => void;
  onTerminalSync?: (cwd: string) => void;
  cwdHint?: string | null;
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
}

export function FileBrowser(props: FileBrowserProps) {
  const session = useSftpStore((s) => s.sessions[props.sessionId]);
  const ensureSession = useSftpStore((s) => s.ensureSession);
  const attach = useSftpStore((s) => s.attach);
  const detach = useSftpStore((s) => s.detach);
  const navigate = useSftpStore((s) => s.navigate);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(props.sessionId);

  const [downloadPrompt, setDownloadPrompt] = useState<FileEntry | null>(null);
  const [previewing, setPreviewing] = useState<{ entry: FileEntry; side: FsSide; text: string } | null>(null);
  const [chmodPrompt, setChmodPrompt] = useState<{ entries: FileEntry[]; side: FsSide } | null>(null);
  // Per-pane filter strings (case-insensitive substring match).
  const [localFilter, setLocalFilter] = useState("");
  const [remoteFilter, setRemoteFilter] = useState("");

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

  // The follow logic was previously a *continuous* effect that snapped the
  // remote pane back to whatever cwd the terminal last reported, which made
  // it impossible to navigate inside the SFTP browser. The new behaviour is
  // strictly opt-in:
  //   1. one-shot initial sync the first time we see a cwd hint after the
  //      session attaches (so the panel opens at the shell's pwd), and
  //   2. an explicit "Sync to terminal cwd" toolbar button the user can
  //      click any time to jump back.
  const initialSyncDoneRef = useRef(false);

  useEffect(() => {
    ensureSession(props.sessionId);
    if (!session?.attached && !session?.attaching) {
      attach({
        sessionId: props.sessionId,
        host: props.host,
        port: props.port,
        username: props.username,
        authMethod: props.authMethod,
        authData: props.authData,
      })
        .then(() => {
          if (props.initialPath) {
            void navigate(props.sessionId, "remote", props.initialPath);
          }
        })
        .catch((err) => setStatus(`SFTP connection failed: ${err}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // Tear down the SFTP channel when this view unmounts. The store
  // ref-counts attaches, so a sidebar + detached window with the same
  // session id are safe.
  useEffect(() => {
    const sid = props.sessionId;
    return () => {
      void detach(sid);
    };
  }, [props.sessionId, detach]);

  // Reset the one-shot guard when this component is reused for a different
  // session (e.g. tab swap that reuses the same FileBrowser instance).
  useEffect(() => {
    initialSyncDoneRef.current = false;
  }, [props.sessionId]);

  // One-shot initial sync to terminal cwd, after attach completes.
  useEffect(() => {
    if (initialSyncDoneRef.current) return;
    if (!props.cwdHint) return;
    if (!session?.attached) return;
    initialSyncDoneRef.current = true;
    if (session.remote.path !== props.cwdHint) {
      void navigate(props.sessionId, "remote", props.cwdHint);
    }
  }, [props.cwdHint, props.sessionId, session?.attached, session?.remote.path, navigate]);

  const syncToTerminalCwd = useCallback(() => {
    if (!props.cwdHint) {
      setStatus("Terminal cwd is not known yet (waiting for OSC 7).");
      return;
    }
    if (!session?.attached) return;
    if (session.remote.path === props.cwdHint) {
      setStatus(`Already at ${props.cwdHint}`);
      return;
    }
    void navigate(props.sessionId, "remote", props.cwdHint);
  }, [props.cwdHint, props.sessionId, session?.attached, session?.remote.path, navigate, setStatus]);

  const handleDoubleClick = useCallback(
    async (side: PaneSide, entry: FileEntry) => {
      if (entry.fileType === "dir") {
        await navigate(props.sessionId, side, entry.path);
        if (side === "remote") props.onTerminalSync?.(entry.path);
        return;
      }
      if (side === "remote") {
        setDownloadPrompt(entry);
        return;
      }
      if (isPreviewable(entry)) {
        try {
          const { sftpReadFileText } = await import("../../lib/sftp");
          const text = await sftpReadFileText(props.sessionId, entry.path, "local");
          setPreviewing({ entry, side: "local", text });
        } catch (err) {
          setStatus(`Preview failed: ${err}`);
        }
      } else {
        setStatus(`Local: ${entry.path} (${entry.size} bytes)`);
      }
    },
    [navigate, props.sessionId, props.onTerminalSync, setStatus],
  );

  const handleDownloadConfirmed = useCallback(
    (entry: FileEntry, openAfter: boolean) => {
      const localDir = session?.local.path ?? "";
      void controller.download(entry, localDir, { openAfter });
      setDownloadPrompt(null);
    },
    [controller, session?.local.path],
  );

  const localContext = useCallback(
    (entry: FileEntry): MenuItem[] => {
      const items: MenuItem[] = [];
      if (entry.fileType === "file") {
        items.push({
          label: "Upload to remote",
          onClick: () => {
            const remoteDir = session?.remote.path ?? "/";
            void controller.upload(entry, remoteDir);
          },
        });
      }
      items.push({
        label: "Rename",
        onClick: () => {
          const next = window.prompt("Rename to", entry.name);
          if (next && next !== entry.name) {
            void controller.rename(entry.path, next, "local");
          }
        },
      });
      items.push({
        label: "Permissions…",
        onClick: () => setChmodPrompt({ entries: [entry], side: "local" }),
      });
      items.push({
        label: "Delete",
        onClick: () => {
          if (window.confirm(`Delete ${entry.name}?`)) {
            void controller.remove(entry.path, "local", true);
          }
        },
        danger: true,
      });
      return items;
    },
    [controller, session?.remote.path],
  );

  const remoteContext = useCallback(
    (entry: FileEntry): MenuItem[] => {
      const items: MenuItem[] = [];
      if (entry.fileType === "file") {
        items.push({
          label: "Download to local",
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(entry, localDir, { openAfter: false });
          },
        });
        items.push({
          label: "Download and open",
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(entry, localDir, { openAfter: true });
          },
        });
      }
      items.push({
        label: "Rename",
        onClick: () => {
          const next = window.prompt("Rename to", entry.name);
          if (next && next !== entry.name) {
            void controller.rename(entry.path, next, "remote");
          }
        },
      });
      items.push({
        label: "Permissions…",
        onClick: () => setChmodPrompt({ entries: [entry], side: "remote" }),
      });
      items.push({
        label: "Delete",
        onClick: () => {
          if (window.confirm(`Delete remote: ${entry.name}?`)) {
            void controller.remove(entry.path, "remote", true);
          }
        },
        danger: true,
      });
      return items;
    },
    [controller, session?.local.path],
  );

  const localEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: "New folder…",
        onClick: () => {
          const name = window.prompt("New folder name", "new-folder");
          if (name) void controller.mkdir(session?.local.path ?? "", name, "local");
        },
      },
      {
        label: "New file…",
        onClick: () => {
          const name = window.prompt("New file name", "new-file.txt");
          if (name) void controller.createFile(session?.local.path ?? "", name, "local");
        },
      },
    ],
    [controller, session?.local.path],
  );

  const remoteEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: "New folder…",
        onClick: () => {
          const name = window.prompt("New folder name", "new-folder");
          if (name) void controller.mkdir(session?.remote.path ?? "/", name, "remote");
        },
      },
      {
        label: "New file…",
        onClick: () => {
          const name = window.prompt("New file name", "new-file.txt");
          if (name) void controller.createFile(session?.remote.path ?? "/", name, "remote");
        },
      },
    ],
    [controller, session?.remote.path],
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

  const handleCrossPaneToLocal = useCallback(
    async (entries: FileEntry[]) => {
      const localDir = session?.local.path ?? "";
      for (const entry of entries) {
        await controller.download(entry, localDir, { openAfter: false });
      }
    },
    [controller, session?.local.path],
  );

  const handleCrossPaneToRemote = useCallback(
    async (entries: FileEntry[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const entry of entries) {
        await controller.upload(entry, remoteDir);
      }
    },
    [controller, session?.remote.path],
  );

  const banner = useMemo(() => {
    if (!session) return null;
    if (session.attaching) return "Attaching SFTP channel…";
    if (session.error) return `SFTP error: ${session.error}`;
    if (!session.attached) return "SFTP not attached.";
    return null;
  }, [session]);

  const showCwdToolbar = props.cwdHint !== undefined && props.cwdHint !== null;

  return (
    <div data-testid="sftp-browser" className="w-full h-full flex flex-col" style={{ background: "var(--moba-bg)" }}>
      {props.showHeader && (
        <div
          className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0 gap-1"
          style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
        >
          <span className="truncate flex-1">{props.title ?? "SFTP"}</span>
          <OrientationToggle orientation={orientation} onChange={setOrientation} />
          {props.onDetach && (
            <button
              type="button"
              className="px-1 hover:bg-[var(--moba-hover)] rounded"
              title="Open in its own window"
              onClick={props.onDetach}
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          )}
          {props.onClose && (
            <button
              type="button"
              className="px-1 hover:bg-[var(--moba-hover)] rounded"
              title="Hide SFTP panel"
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
            borderColor: "var(--moba-divider)",
            background: "var(--moba-quick-bg)",
            color: "var(--moba-text-muted)",
          }}
        >
          <span className="shrink-0">Terminal cwd:</span>
          <span className="font-mono truncate flex-1" title={props.cwdHint ?? ""}>
            {props.cwdHint}
          </span>
          <button
            type="button"
            className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--moba-hover)] shrink-0"
            title="Sync the remote pane to the terminal's current directory (one-shot)"
            onClick={syncToTerminalCwd}
            style={{ color: "var(--moba-accent)" }}
          >
            <Link2 className="w-3 h-3" />
            <span>Sync</span>
          </button>
          {!props.showHeader && (
            <OrientationToggle orientation={orientation} onChange={setOrientation} />
          )}
        </div>
      )}
      {banner && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0"
          style={{
            borderColor: "var(--moba-divider)",
            background: session?.error ? "#fde7e2" : "var(--moba-quick-bg)",
            color: session?.error ? "#7a1f0a" : "var(--moba-text)",
          }}
        >
          {banner}
          {session?.error && (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                void detach(props.sessionId).then(() =>
                  attach({
                    sessionId: props.sessionId,
                    host: props.host,
                    port: props.port,
                    username: props.username,
                    authMethod: props.authMethod,
                    authData: props.authData,
                  }).catch((err) => setStatus(`Reconnect failed: ${err}`))
                );
              }}
            >
              retry
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PanelGroup
          // Re-mount the panel group when orientation flips so
          // react-resizable-panels reads new sizes cleanly.
          key={orientation}
          direction={orientation}
          // v2: pane order changed (REMOTE on top/left). Bumping the
          // autoSaveId ensures any persisted v1 sizes don't flip the
          // visual order back the wrong way for returning users.
          autoSaveId={`sftp-browser-v2-${orientationScope}-${orientation}`}
        >
          <Panel defaultSize={50} minSize={15} className="flex flex-col min-h-0 min-w-0">
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
              onDeleteSelected={(entries) => {
                if (entries.length === 0) return;
                const summary = entries.length === 1
                  ? entries[0].name
                  : `${entries.length} items`;
                if (!window.confirm(`Delete remote: ${summary}?`)) return;
                for (const entry of entries) {
                  void controller.remove(entry.path, "remote", true);
                }
              }}
              onChmodSelected={(entries) => {
                if (entries.length === 0) return;
                setChmodPrompt({ entries, side: "remote" });
              }}
              onPreviewSelected={(entry) => {
                if (!isPreviewable(entry)) {
                  setStatus(`Preview not supported for ${entry.name}`);
                  return;
                }
                void (async () => {
                  try {
                    const { sftpReadFileText } = await import("../../lib/sftp");
                    const text = await sftpReadFileText(props.sessionId, entry.path, "remote");
                    setPreviewing({ entry, side: "remote", text });
                  } catch (err) {
                    setStatus(`Preview failed: ${err}`);
                  }
                })();
              }}
              onNewFile={() => {
                const name = window.prompt("New file name", "new-file.txt");
                if (name) void controller.createFile(session?.remote.path ?? "/", name, "remote");
              }}
              onOpenTerminalHere={props.onOpenTerminalHere}
            />
          </Panel>
          <PanelResizeHandle
            className={
              orientation === "horizontal"
                ? "w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize"
                : "h-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-row-resize"
            }
          />
          <Panel defaultSize={50} minSize={15} className="flex flex-col min-h-0 min-w-0">
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
              filterText={localFilter}
              onFilterTextChange={setLocalFilter}
              onUploadSelected={(entries) => {
                const remoteDir = session?.remote.path ?? "/";
                for (const entry of entries) {
                  void controller.upload(entry, remoteDir);
                }
              }}
              onDeleteSelected={(entries) => {
                if (entries.length === 0) return;
                const summary = entries.length === 1
                  ? entries[0].name
                  : `${entries.length} items`;
                if (!window.confirm(`Delete ${summary}?`)) return;
                for (const entry of entries) {
                  void controller.remove(entry.path, "local", true);
                }
              }}
              onChmodSelected={(entries) => {
                if (entries.length === 0) return;
                setChmodPrompt({ entries, side: "local" });
              }}
              onPreviewSelected={(entry) => {
                if (!isPreviewable(entry)) {
                  setStatus(`Preview not supported for ${entry.name}`);
                  return;
                }
                void (async () => {
                  try {
                    const { sftpReadFileText } = await import("../../lib/sftp");
                    const text = await sftpReadFileText(props.sessionId, entry.path, "local");
                    setPreviewing({ entry, side: "local", text });
                  } catch (err) {
                    setStatus(`Preview failed: ${err}`);
                  }
                })();
              }}
              onNewFile={() => {
                const name = window.prompt("New file name", "new-file.txt");
                if (name) void controller.createFile(session?.local.path ?? "", name, "local");
              }}
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
          borderColor: "var(--moba-divider)",
          background: "var(--moba-quick-bg)",
          color: "var(--moba-text-muted)",
        }}
      >
        <ArrowLeftRight className="w-3 h-3" />
        <span className="truncate">
          Cross-host transfer (remote ↔ remote) — coming soon
        </span>
        <button
          type="button"
          disabled
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] opacity-50 cursor-not-allowed"
          style={{ border: "1px solid var(--moba-divider)" }}
          title="Will let you move files directly between two SFTP sessions"
        >
          Pick peer…
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
    </div>
  );
}

function OrientationToggle({
  orientation,
  onChange,
}: {
  orientation: Orientation;
  onChange: (next: Orientation) => void;
}) {
  const next: Orientation = orientation === "horizontal" ? "vertical" : "horizontal";
  return (
    <button
      type="button"
      className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--moba-hover)] shrink-0"
      title={
        orientation === "horizontal"
          ? "Switch to top/bottom layout"
          : "Switch to side-by-side layout"
      }
      onClick={() => onChange(next)}
      style={{ color: "var(--moba-text-muted)" }}
    >
      {orientation === "horizontal" ? (
        <Columns className="w-3 h-3" />
      ) : (
        <Rows className="w-3 h-3" />
      )}
      <span className="text-[10px]">{orientation === "horizontal" ? "Side" : "Stack"}</span>
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-2">Open remote file?</div>
        <div className="text-[12px] mb-3 break-all" style={{ color: "var(--moba-text-muted)" }}>
          To open <strong>{entry.name}</strong>, MobaXterm-style we first download it to:
          <div className="mt-1 font-mono text-[11px]">{joinPath(localDir, entry.name)}</div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
            onClick={() => onDownload(false)}
          >
            Download only
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--moba-accent)" }}
            onClick={() => onDownload(true)}
          >
            Download &amp; open
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[80vw] h-[70vh] rounded shadow-lg flex flex-col"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-1.5 text-[12px] flex items-center border-b"
          style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}>
          <span className="font-semibold">{name}</span>
          <span className="ml-2 text-[var(--moba-text-muted)]">{path}</span>
          <div className="flex-1" />
          <button type="button" className="px-2 py-0.5 hover:bg-[var(--moba-hover)] rounded" onClick={onClose}>
            Close
          </button>
        </div>
        <pre className="flex-1 overflow-auto px-3 py-2 text-[12px] font-mono whitespace-pre-wrap break-all"
          style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}>
{text}
        </pre>
      </div>
    </div>
  );
}

export { basename };
