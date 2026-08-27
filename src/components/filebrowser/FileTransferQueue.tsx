import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Trash2, X, Eraser, Pause, Play, RotateCw, ChevronDown, ChevronUp, ArrowLeftRight } from "lucide-react";
import { useTransferStore } from "../../stores/transferStore";
import { formatBytes, formatRate, formatEta, type TransferState } from "../../lib/sftp";
import { useT } from "../../lib/i18n";

interface FileTransferQueueProps {
  sessionId?: string;
  onCancel: (transferId: string) => void;
  onPause?: (transferId: string) => void;
  onResume?: (transferId: string) => void;
  onRetry?: (transferId: string) => void;
  compact?: boolean;
  showCrossHostBanner?: boolean;
}

const STORAGE_KEY_PREFIX = "taomni.sftp.transferQueueHeight.";
const OPEN_STORAGE_KEY_PREFIX = "taomni.sftp.transferQueueOpen.";
const DEFAULT_HEIGHT = 220;
const DEFAULT_COMPACT_HEIGHT = 140;
const MIN_HEIGHT = 104;
const MIN_COMPACT_HEIGHT = 72;
const MAX_HEIGHT = 440;
const MAX_COMPACT_HEIGHT = 260;

function clampHeight(value: number, compact?: boolean): number {
  const min = compact ? MIN_COMPACT_HEIGHT : MIN_HEIGHT;
  const max = compact ? MAX_COMPACT_HEIGHT : MAX_HEIGHT;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function heightStorageKey(sessionId?: string): string {
  return `${STORAGE_KEY_PREFIX}${sessionId ?? "all"}`;
}

function openStorageKey(sessionId?: string): string {
  return `${OPEN_STORAGE_KEY_PREFIX}${sessionId ?? "all"}`;
}

function loadHeight(sessionId: string | undefined, compact: boolean | undefined): number {
  const fallback = compact ? DEFAULT_COMPACT_HEIGHT : DEFAULT_HEIGHT;
  try {
    const raw = window.localStorage.getItem(heightStorageKey(sessionId));
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampHeight(parsed, compact) : fallback;
  } catch {
    return fallback;
  }
}

function saveHeight(sessionId: string | undefined, value: number): void {
  try {
    window.localStorage.setItem(heightStorageKey(sessionId), String(value));
  } catch {
    /* noop */
  }
}

function loadOpen(sessionId?: string): boolean {
  try {
    const raw = window.localStorage.getItem(openStorageKey(sessionId));
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

function saveOpen(sessionId: string | undefined, open: boolean): void {
  try {
    window.localStorage.setItem(openStorageKey(sessionId), String(open));
  } catch {
    /* noop */
  }
}

export function FileTransferQueue({
  sessionId,
  onCancel,
  onPause,
  onResume,
  onRetry,
  compact,
  showCrossHostBanner,
}: FileTransferQueueProps) {
  const t = useT();
  const items = useTransferStore((s) => s.items);
  const remove = useTransferStore((s) => s.remove);
  const clearCompleted = useTransferStore((s) => s.clearCompleted);
  const [height, setHeight] = useState(() => loadHeight(sessionId, compact));
  const [isOpen, setIsOpen] = useState(() => loadOpen(sessionId));

  useEffect(() => {
    setHeight(loadHeight(sessionId, compact));
    setIsOpen(loadOpen(sessionId));
  }, [compact, sessionId]);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      saveOpen(sessionId, next);
      return next;
    });
  }, [sessionId]);

  const updateHeight = useCallback(
    (nextHeight: number) => {
      const clamped = clampHeight(nextHeight, compact);
      setHeight(clamped);
      saveHeight(sessionId, clamped);
    },
    [compact, sessionId],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        updateHeight(startHeight + startY - moveEvent.clientY);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
      document.addEventListener("pointercancel", onUp, { once: true });
    },
    [height, updateHeight],
  );

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
  const activeCount = filtered.filter((it) => it.state === "running" || it.state === "queued").length;
  const hasActive = activeCount > 0;

  const prevCountRef = useRef(filtered.length);
  useEffect(() => {
    if (filtered.length > prevCountRef.current) {
      const hasNewInFlight = filtered.some((it) => it.state === "running" || it.state === "queued");
      if (hasNewInFlight && !isOpen) {
        setIsOpen(true);
        saveOpen(sessionId, true);
      }
    }
    prevCountRef.current = filtered.length;
  }, [filtered, isOpen, sessionId]);

  if (!isOpen) {
    return (
      <div
        data-testid="sftp-transfer-queue-collapsed"
        className="h-6 border-t px-2 flex items-center gap-2 text-[11px] cursor-pointer hover:bg-[var(--taomni-hover)] select-none shrink-0 transition-colors"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        onClick={toggleOpen}
        title={t("fileBrowser.transferExpand")}
      >
        <ChevronUp className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
        <span className="font-semibold">{t("fileBrowser.transferTitle")}</span>
        <span className="text-[var(--taomni-text-muted)] text-[10px] px-1.5 py-0.5 rounded bg-[var(--taomni-hover)]">
          {filtered.length}
        </span>
        {hasActive && (
          <span className="text-emerald-500 text-[10px] flex items-center gap-1 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {t("fileBrowser.transferActive", { count: activeCount })}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          data-testid="sftp-transfer-queue-expand-btn"
          className="px-1.5 py-0.5 text-[10px] text-[var(--taomni-accent)] hover:underline rounded"
          title={t("fileBrowser.transferExpand")}
          onClick={(e) => {
            e.stopPropagation();
            toggleOpen();
          }}
        >
          {t("fileBrowser.transferExpand")}
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="sftp-transfer-queue"
      className="border-t flex flex-col shrink-0 relative"
      style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)", height }}
    >
      <div
        data-testid="sftp-transfer-queue-resize-handle"
        className="h-1.5 -mt-0.5 cursor-row-resize bg-[var(--taomni-divider)]/40 hover:bg-[var(--taomni-accent)] active:bg-[var(--taomni-accent)] transition-colors relative z-10 flex items-center justify-center group select-none"
        onPointerDown={startResize}
      >
        <div className="w-8 h-0.5 rounded-full bg-transparent group-hover:bg-white/50 transition-colors" />
      </div>

      {showCrossHostBanner && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0 flex items-center gap-2"
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
      )}

      <div
        className="h-6 px-2 flex items-center text-[11px] font-semibold gap-2 shrink-0 select-none"
        style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span>{t("fileBrowser.transferTitle")}</span>
        <span className="text-[var(--taomni-text-muted)] text-[10px] px-1.5 py-0.5 rounded bg-[var(--taomni-hover)]">
          {filtered.length}
        </span>
        {hasActive && (
          <span className="text-emerald-500 text-[10px] flex items-center gap-1 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {t("fileBrowser.transferActive", { count: activeCount })}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          className="px-1.5 py-0.5 hover:bg-[var(--taomni-hover)] rounded inline-flex items-center gap-1 text-[10px]"
          title={t("fileBrowser.transferClearTitle")}
          onClick={clearCompleted}
        >
          <Eraser className="w-3 h-3" /> {t("fileBrowser.transferClear")}
        </button>
        <button
          type="button"
          data-testid="sftp-transfer-queue-close"
          className="px-1 py-0.5 hover:bg-[var(--taomni-hover)] rounded inline-flex items-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
          title={t("fileBrowser.transferClose")}
          onClick={toggleOpen}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="overflow-auto text-[11px] flex-1 min-h-0">
        {filtered.length === 0 && (
          <div className="px-2 py-2 text-[var(--taomni-text-muted)]">
            {t("fileBrowser.transferEmptyText")}
          </div>
        )}
        {filtered.map((it) => {
          const pct =
            it.state === "done"
              ? 100
              : it.size > 0
                ? Math.min(100, (it.bytes / it.size) * 100)
                : 0;
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
              style={{ borderColor: "var(--taomni-divider)" }}
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
                <span className="text-[var(--taomni-text-muted)]">
                  {formatBytes(it.bytes)} / {formatBytes(it.size)}
                </span>
                {it.state === "running" && (
                  <span className="text-[var(--taomni-text-muted)]">
                    {formatRate(it.rate)} • {formatEta(it.eta)}
                  </span>
                )}
                {canPause && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferPause")}
                    onClick={() => onPause!(it.id)}
                  >
                    <Pause className="w-3 h-3" />
                  </button>
                )}
                {canResume && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferResume")}
                    onClick={() => onResume!(it.id)}
                  >
                    <Play className="w-3 h-3" />
                  </button>
                )}
                {canRetry && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferRetryTitle")}
                    onClick={() => onRetry!(it.id)}
                  >
                    <RotateCw className="w-3 h-3" />
                  </button>
                )}
                {isInFlight || it.state === "paused" ? (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferCancelTitle")}
                    onClick={() => onCancel(it.id)}
                  >
                    <X className="w-3 h-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferRemoveTitle")}
                    onClick={() => remove(it.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div
                className="h-0.5 mt-1 rounded"
                style={{ background: "var(--taomni-divider)" }}
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
                            : "var(--taomni-accent)",
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
    running: "bg-[var(--taomni-accent)]",
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
