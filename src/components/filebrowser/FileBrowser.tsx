import { useEffect, useCallback, useState, useMemo } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { Link2, Link2Off } from "lucide-react";
import { FilePanel, isPreviewable } from "./FilePanel";
import { FileTransferQueue } from "./FileTransferQueue";
import { useSftpStore, type PaneSide } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { joinPath, basename, type FileEntry, type FsSide } from "../../lib/sftp";
import type { MenuItem } from "../ContextMenu";
import { useAppStore } from "../../stores/appStore";

interface FileBrowserProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  initialPath?: string;
  onDetach?: () => void;
  onTerminalSync?: (cwd: string) => void;
  cwdHint?: string | null;
  detachable?: boolean;
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
  // Per-view toggle that gates the OSC 7 follow effect below; the user can
  // disable it from the banner so the panel stays where they navigate.
  const [followCwd, setFollowCwd] = useState(true);
  // Per-pane filter strings (case-insensitive substring match).
  const [localFilter, setLocalFilter] = useState("");
  const [remoteFilter, setRemoteFilter] = useState("");

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

  // Tear down the SFTP channel when this view is the last consumer of the
  // session: the standalone tab and detached window each own their own
  // session id, so unmounting the view should free the backend resources
  // (channel handle + transfer registrations) that came with attach().
  // The attached SFTP sidebar uses a *separate* sessionId so there is no
  // risk of pulling the rug out from under a still-mounted terminal.
  useEffect(() => {
    const sid = props.sessionId;
    return () => {
      void detach(sid);
    };
  }, [props.sessionId, detach]);

  // Follow the terminal's cwd (OSC 7) when running in attached mode and the
  // user hasn't disabled the per-view follow toggle.
  useEffect(() => {
    if (!followCwd) return;
    if (!props.cwdHint) return;
    if (!session?.attached) return;
    if (session.remote.path === props.cwdHint) return;
    void navigate(props.sessionId, "remote", props.cwdHint);
  }, [followCwd, props.cwdHint, props.sessionId, session?.attached, session?.remote.path, navigate]);

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
        onClick: () => {
          const current = entry.mode != null
            ? (entry.mode & 0o777).toString(8).padStart(3, "0")
            : "644";
          const input = window.prompt(`Octal mode for ${entry.name}`, current);
          if (!input) return;
          const mode = parseInt(input, 8);
          if (!Number.isFinite(mode)) {
            setStatus(`Invalid mode: ${input}`);
            return;
          }
          void controller.chmod(entry.path, mode, "local");
        },
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
        onClick: () => {
          const current = entry.mode != null
            ? (entry.mode & 0o777).toString(8).padStart(3, "0")
            : "644";
          const input = window.prompt(`Octal mode for ${entry.name}`, current);
          if (!input) return;
          const mode = parseInt(input, 8);
          if (!Number.isFinite(mode)) {
            setStatus(`Invalid mode: ${input}`);
            return;
          }
          void controller.chmod(entry.path, mode, "remote");
        },
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

  return (
    <div className="w-full h-full flex flex-col" style={{ background: "var(--moba-bg)" }}>
      {props.cwdHint !== undefined && props.cwdHint !== null && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0 flex items-center gap-2"
          style={{
            borderColor: "var(--moba-divider)",
            background: "var(--moba-quick-bg)",
            color: "var(--moba-text-muted)",
          }}
        >
          <span>Terminal cwd:</span>
          <span className="font-mono truncate flex-1">{props.cwdHint}</span>
          <button
            type="button"
            className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--moba-hover)]"
            title={followCwd ? "Stop following terminal cwd" : "Follow terminal cwd"}
            onClick={() => setFollowCwd((v) => !v)}
            style={{ color: followCwd ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
          >
            {followCwd ? <Link2 className="w-3 h-3" /> : <Link2Off className="w-3 h-3" />}
            <span>{followCwd ? "Following" : "Free"}</span>
          </button>
        </div>
      )}
      {banner && (
        <div className="text-[11px] px-2 py-1 border-b shrink-0"
          style={{
            borderColor: "var(--moba-divider)",
            background: session?.error ? "#fde7e2" : "var(--moba-quick-bg)",
            color: session?.error ? "#7a1f0a" : "var(--moba-text)",
          }}>
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
        <PanelGroup direction="horizontal" autoSaveId={`sftp-browser-${props.sessionId}`}>
          <Panel defaultSize={50} minSize={20}>
            <FilePanel
              sessionId={props.sessionId}
              side="local"
              title={`Local — ${session?.local.path ?? "—"}`}
              detachable={props.detachable}
              onDetach={props.onDetach}
              onItemDoubleClick={(e) => void handleDoubleClick("local", e)}
              onItemContext={localContext}
              onEmptyContext={localEmptyContext}
              onPaneFiles={handleLocalFiles}
              acceptCrossPane
              onCrossPaneDrop={handleCrossPaneToLocal}
              filterText={localFilter}
              onFilterTextChange={setLocalFilter}
            />
          </Panel>
          <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />
          <Panel defaultSize={50} minSize={20}>
            <FilePanel
              sessionId={props.sessionId}
              side="remote"
              title={`Remote — ${session?.remote.path ?? "—"}`}
              detachable={props.detachable}
              onDetach={props.onDetach}
              onItemDoubleClick={(e) => void handleDoubleClick("remote", e)}
              onItemContext={remoteContext}
              onEmptyContext={remoteEmptyContext}
              onPaneFiles={(files) => void handleLocalFiles(files)}
              acceptCrossPane
              onCrossPaneDrop={handleCrossPaneToRemote}
              filterText={remoteFilter}
              onFilterTextChange={setRemoteFilter}
            />
          </Panel>
        </PanelGroup>
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
