import { useEffect, useMemo, useState } from "react";
import { History, Loader2, X } from "lucide-react";
import {
  formatLocalHistoryTime,
  historyList,
  historyRead,
  type LocalHistoryEntry,
} from "../../../lib/localHistory";

interface LocalHistoryDialogProps {
  path: string;
  onClose: () => void;
  onRestore: (text: string) => void;
  onCompare?: (entry: LocalHistoryEntry, text: string) => void;
}

export function LocalHistoryDialog({
  path,
  onClose,
  onRestore,
  onCompare,
}: LocalHistoryDialogProps) {
  const [entries, setEntries] = useState<LocalHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void historyList(path)
      .then((items) => {
        if (cancelled) return;
        setEntries(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (selectedId == null) {
      setPreviewText(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    void historyRead(selectedId)
      .then((text) => {
        if (!cancelled) setPreviewText(text);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Local History for ${path}`}
      data-testid="code-workspace-local-history-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(720px,90vh)] w-[min(960px,95vw)] flex-col overflow-hidden rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <History className="h-4 w-4 text-[var(--taomni-code-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[var(--taomni-code-text)]">Local History</div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]">{path}</div>
          </div>
          <button
            type="button"
            aria-label="Close local history"
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 grid grid-cols-[240px_1fr]">
          <aside className="min-h-0 overflow-auto border-r border-[var(--taomni-code-border)]">
            {loading ? (
              <div className="flex items-center gap-2 p-3 text-[11px] text-[var(--taomni-code-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading history…
              </div>
            ) : entries.length === 0 ? (
              <div className="p-3 text-[11px] text-[var(--taomni-code-muted)]">No snapshots yet for this file.</div>
            ) : (
              <ul className="py-1">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      data-selected={entry.id === selectedId || undefined}
                      className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
                      onClick={() => setSelectedId(entry.id)}
                    >
                      <span className="text-[11px] text-[var(--taomni-code-text)]">
                        {formatLocalHistoryTime(entry.createdAt)}
                      </span>
                      <span className="text-[10px] text-[var(--taomni-code-muted)]">
                        {entry.reason} · {entry.byteLen} B
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="min-h-0 flex flex-col">
            <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2 text-[11px] text-[var(--taomni-code-muted)]">
              {selected
                ? `Snapshot vs current buffer · ${formatLocalHistoryTime(selected.createdAt)} · ${selected.reason}`
                : "Select a snapshot"}
            </div>
            <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5">
              {previewLoading ? (
                <div className="flex items-center gap-2 p-3 text-[var(--taomni-code-muted)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading snapshot…
                </div>
              ) : previewText == null ? (
                <div className="p-3 text-[var(--taomni-code-muted)]">No snapshot selected.</div>
              ) : (
                <div className="p-3 text-[var(--taomni-code-muted)]">
                  Snapshot loaded. Open Compare to inspect the revision against the current buffer.
                </div>
              )}
            </div>
            {error && (
              <div className="shrink-0 border-t border-[var(--taomni-code-border)] px-3 py-2 text-[11px] text-amber-500">
                {error}
              </div>
            )}
            <div className="shrink-0 flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
              <button
                type="button"
                className="h-7 rounded px-2 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="code-workspace-local-history-compare"
                disabled={previewText == null || selected == null || !onCompare}
                className="h-7 rounded bg-[var(--taomni-accent)] px-2 text-[11px] text-white disabled:opacity-40"
                onClick={() => {
                  if (previewText == null || selected == null || !onCompare) return;
                  onCompare(selected, previewText);
                  onClose();
                }}
              >
                Compare snapshot
              </button>
              <button
                type="button"
                data-testid="code-workspace-local-history-restore"
                disabled={previewText == null}
                className="h-7 rounded bg-[var(--taomni-accent)] px-2 text-[11px] text-white disabled:opacity-40"
                onClick={() => {
                  if (previewText == null) return;
                  onRestore(previewText);
                  onClose();
                }}
              >
                Restore snapshot
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
