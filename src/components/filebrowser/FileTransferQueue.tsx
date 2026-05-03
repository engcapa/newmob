import { useEffect } from "react";
import { Trash2, X, Eraser, Pause, Play, RotateCw } from "lucide-react";
import { useTransferStore } from "../../stores/transferStore";
import { formatBytes, formatRate, formatEta, type TransferState } from "../../lib/sftp";

interface FileTransferQueueProps {
  sessionId?: string;
  onCancel: (transferId: string) => void;
  onPause?: (transferId: string) => void;
  onResume?: (transferId: string) => void;
  onRetry?: (transferId: string) => void;
  compact?: boolean;
}

export function FileTransferQueue({
  sessionId,
  onCancel,
  onPause,
  onResume,
  onRetry,
  compact,
}: FileTransferQueueProps) {
  const items = useTransferStore((s) => s.items);
  const remove = useTransferStore((s) => s.remove);
  const clearCompleted = useTransferStore((s) => s.clearCompleted);

  useEffect(() => {
    const id = window.setInterval(() => {
      // Auto-prune dones older than 60s
      const now = Date.now();
      for (const it of useTransferStore.getState().items) {
        if (
          (it.state === "done" || it.state === "cancelled") &&
          it.finishedAt &&
          now - it.finishedAt > 60_000
        ) {
          remove(it.id);
        }
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [remove]);

  const filtered = sessionId ? items.filter((it) => it.sessionId === sessionId) : items;

  return (
    <div data-testid="sftp-transfer-queue" className="border-t flex flex-col shrink-0" style={{ borderColor: "var(--moba-divider)", background: "var(--moba-panel-bg)" }}>
      <div className="h-5 px-2 flex items-center text-[11px] font-semibold gap-2"
        style={{ borderBottom: "1px solid var(--moba-divider)", background: "var(--moba-quick-bg)" }}>
        <span>Transfers</span>
        <span className="text-[var(--moba-text-muted)]">{filtered.length}</span>
        <div className="flex-1" />
        <button
          type="button"
          className="px-1 py-0.5 hover:bg-[var(--moba-hover)] rounded inline-flex items-center gap-1"
          title="Clear completed"
          onClick={clearCompleted}
        >
          <Eraser className="w-3 h-3" /> Clear
        </button>
      </div>
      <div
        className="overflow-auto text-[11px]"
        style={{ maxHeight: compact ? 90 : 140, minHeight: compact ? 40 : 60 }}
      >
        {filtered.length === 0 && (
          <div className="px-2 py-2 text-[var(--moba-text-muted)]">
            No active or recent transfers.
          </div>
        )}
        {filtered.map((it) => {
          const pct = it.size > 0 ? Math.min(100, (it.bytes / it.size) * 100) : 0;
          const isInFlight = it.state === "running" || it.state === "queued";
          const canPause = onPause && it.state === "running";
          const canResume = onResume && it.state === "paused";
          const canRetry =
            onRetry &&
            (it.state === "error" || it.state === "cancelled") &&
            !it.localPath.startsWith("OS:");
          return (
            <div
              key={it.id}
              className="px-2 py-1 border-b"
              style={{ borderColor: "var(--moba-divider)" }}
            >
              <div className="flex items-center gap-2 truncate">
                <span style={{ color: it.direction === "upload" ? "#3a7ac0" : "#3da064" }}>
                  {it.direction === "upload" ? "↑" : "↓"}
                </span>
                <span className="truncate flex-1">
                  {it.direction === "upload" ? it.localPath : it.remotePath}
                  {" → "}
                  {it.direction === "upload" ? it.remotePath : it.localPath}
                </span>
                <StateBadge state={it.state} />
                <span className="text-[var(--moba-text-muted)]">
                  {formatBytes(it.bytes)} / {formatBytes(it.size)}
                </span>
                {it.state === "running" && (
                  <span className="text-[var(--moba-text-muted)]">
                    {formatRate(it.rate)} • {formatEta(it.eta)}
                  </span>
                )}
                {canPause && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--moba-hover)] rounded"
                    title="Pause"
                    onClick={() => onPause!(it.id)}
                  >
                    <Pause className="w-3 h-3" />
                  </button>
                )}
                {canResume && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--moba-hover)] rounded"
                    title="Resume"
                    onClick={() => onResume!(it.id)}
                  >
                    <Play className="w-3 h-3" />
                  </button>
                )}
                {canRetry && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--moba-hover)] rounded"
                    title="Retry"
                    onClick={() => onRetry!(it.id)}
                  >
                    <RotateCw className="w-3 h-3" />
                  </button>
                )}
                {isInFlight || it.state === "paused" ? (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--moba-hover)] rounded"
                    title="Cancel"
                    onClick={() => onCancel(it.id)}
                  >
                    <X className="w-3 h-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--moba-hover)] rounded"
                    title="Remove from list"
                    onClick={() => remove(it.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div
                className="h-0.5 mt-1 rounded"
                style={{ background: "var(--moba-divider)" }}
              >
                <div
                  className="h-full rounded"
                  style={{
                    width: `${pct}%`,
                    background:
                      it.state === "error"
                        ? "#c0432a"
                        : it.state === "done"
                          ? "#3da064"
                          : it.state === "paused"
                            ? "#d99a2b"
                            : "var(--moba-accent)",
                  }}
                />
              </div>
              {it.error && (
                <div className="text-[10px] mt-0.5 text-red-500 truncate">{it.error}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: TransferState }) {
  const colors: Record<TransferState, string> = {
    queued: "bg-slate-500",
    running: "bg-[var(--moba-accent)]",
    paused: "bg-amber-500",
    done: "bg-emerald-600",
    error: "bg-red-600",
    cancelled: "bg-slate-400",
  };
  return (
    <span className={`text-white text-[10px] px-1 rounded ${colors[state]}`}>
      {state}
    </span>
  );
}
