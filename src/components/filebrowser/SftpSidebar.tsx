import { useEffect, useCallback, useState } from "react";
import { FilePanel } from "./FilePanel";
import { FileTransferQueue } from "./FileTransferQueue";
import { useSftpStore } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { type FileEntry, joinPath } from "../../lib/sftp";
import type { MenuItem } from "../ContextMenu";
import { useAppStore } from "../../stores/appStore";
import { Maximize2, Link2, Link2Off, X } from "lucide-react";

interface SftpSidebarProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  cwdHint?: string | null;
  onClose?: () => void;
  onDetach?: () => void;
  title?: string;
}

export function SftpSidebar(props: SftpSidebarProps) {
  const session = useSftpStore((s) => s.sessions[props.sessionId]);
  const ensureSession = useSftpStore((s) => s.ensureSession);
  const attach = useSftpStore((s) => s.attach);
  const detach = useSftpStore((s) => s.detach);
  const navigate = useSftpStore((s) => s.navigate);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(props.sessionId);
  const [downloadPrompt, setDownloadPrompt] = useState<FileEntry | null>(null);
  const [filterText, setFilterText] = useState("");
  // Per-view toggle: when on, the sidebar follows the terminal's reported
  // cwd (OSC 7). The user can turn it off to navigate freely without being
  // pulled back to whatever the shell last printed.
  const [followCwd, setFollowCwd] = useState(true);

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
      }).catch((err) => setStatus(`SFTP attach failed: ${err}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // Free the backend SFTP channel when the sidebar is dismissed (toggled
  // off, terminal tab closed, or replaced with a detached window). The
  // sidebar owns its own session id, so detaching here doesn't affect the
  // standalone tab.
  useEffect(() => {
    const sid = props.sessionId;
    return () => {
      void detach(sid);
    };
  }, [props.sessionId, detach]);

  useEffect(() => {
    if (!followCwd) return;
    if (!props.cwdHint || !session?.attached) return;
    if (session.remote.path === props.cwdHint) return;
    void navigate(props.sessionId, "remote", props.cwdHint);
  }, [followCwd, props.cwdHint, props.sessionId, session?.attached, session?.remote.path, navigate]);

  const remoteContext = useCallback(
    (entry: FileEntry): MenuItem[] => {
      const items: MenuItem[] = [];
      if (entry.fileType === "file") {
        items.push({
          label: "Download to local",
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(entry, localDir);
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
          if (next && next !== entry.name) void controller.rename(entry.path, next, "remote");
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
    [controller, session?.local.path, setStatus],
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

  const handleFiles = useCallback(
    async (files: File[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const file of files) {
        await controller.uploadBlob(remoteDir, file);
      }
    },
    [controller, session?.remote.path],
  );

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--moba-bg)" }}>
      <div className="h-6 px-2 flex items-center text-[11px] font-semibold border-b"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}>
        <span className="truncate">{props.title ?? "SFTP"}</span>
        <div className="flex-1" />
        {props.cwdHint !== undefined && (
          <button
            type="button"
            className="px-1 hover:bg-[var(--moba-hover)] rounded"
            title={followCwd ? "Stop following terminal cwd" : "Follow terminal cwd"}
            onClick={() => setFollowCwd((v) => !v)}
            style={{ color: followCwd ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
          >
            {followCwd ? <Link2 className="w-3 h-3" /> : <Link2Off className="w-3 h-3" />}
          </button>
        )}
        {props.onDetach && (
          <button
            type="button"
            className="px-1 hover:bg-[var(--moba-hover)] rounded"
            title="Open in its own tab"
            onClick={props.onDetach}
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        )}
        {props.onClose && (
          <button
            type="button"
            className="px-1 hover:bg-[var(--moba-hover)] rounded"
            title="Hide SFTP sidebar"
            onClick={props.onClose}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {session?.attaching && (
        <div className="px-2 py-1 text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
          Attaching SFTP channel…
        </div>
      )}
      {session?.error && (
        <div className="px-2 py-1 text-[11px]" style={{ color: "#7a1f0a" }}>
          {session.error}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        <FilePanel
          sessionId={props.sessionId}
          side="remote"
          title={`Remote — ${session?.remote.path ?? "—"}`}
          onItemDoubleClick={(entry) => {
            if (entry.fileType === "dir") {
              void navigate(props.sessionId, "remote", entry.path);
            } else {
              setDownloadPrompt(entry);
            }
          }}
          onItemContext={remoteContext}
          onEmptyContext={remoteEmptyContext}
          onPaneFiles={handleFiles}
          filterText={filterText}
          onFilterTextChange={setFilterText}
        />
      </div>
      <FileTransferQueue
        sessionId={props.sessionId}
        onCancel={(id) => void controller.cancelTransfer(id)}
        onPause={(id) => void controller.pauseTransfer(id)}
        onResume={(id) => void controller.resumeTransfer(id)}
        onRetry={(id) => void controller.retryTransfer(id)}
        compact
      />

      {downloadPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setDownloadPrompt(null)}
        >
          <div
            className="w-[420px] rounded shadow-lg p-4"
            style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold mb-2">Open remote file?</div>
            <div className="text-[12px] mb-3 break-all" style={{ color: "var(--moba-text-muted)" }}>
              {downloadPrompt.name} will be saved to:
              <div className="mt-1 font-mono text-[11px]">
                {joinPath(session?.local.path ?? "", downloadPrompt.name)}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
                onClick={() => setDownloadPrompt(null)}>Cancel</button>
              <button type="button" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
                onClick={() => {
                  void controller.download(downloadPrompt, session?.local.path ?? "", { openAfter: false });
                  setDownloadPrompt(null);
                }}>Download only</button>
              <button type="button" className="px-3 py-1 text-[12px] rounded text-white"
                style={{ background: "var(--moba-accent)" }}
                onClick={() => {
                  void controller.download(downloadPrompt, session?.local.path ?? "", { openAfter: true });
                  setDownloadPrompt(null);
                }}>Download &amp; open</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
