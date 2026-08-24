import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Trash2, X } from "lucide-react";
import type { EditorClipboardSession } from "./workspaceClipboardSession";

export interface ClipboardHistoryPopupProps {
  open: boolean;
  entries: readonly EditorClipboardSession[];
  onPaste: (index: number) => void;
  onDelete: (index: number) => void;
  onClear: () => void;
  onClose: () => void;
}

function relativeTime(createdAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * §8.19.5 Paste from History: searchable session-only listbox. Shows the
 * first line, segment count and age of every entry; Enter pastes at the
 * caret as one transaction, Delete removes a single entry, Clear empties
 * the ring after confirmation. Nothing here is ever persisted.
 */
export function ClipboardHistoryPopup({
  open,
  entries,
  onPaste,
  onDelete,
  onClear,
  onClose,
}: ClipboardHistoryPopupProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries.map((entry, index) => ({ entry, index }));
    return entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.plainText.toLowerCase().includes(needle));
  }, [entries, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setConfirmingClear(false);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((idx) => Math.min(idx + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((idx) => Math.max(idx - 1, 0));
    } else if (e.key === "Delete") {
      e.preventDefault();
      const target = filtered[selectedIndex];
      if (target) onDelete(target.index);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[selectedIndex];
      if (target) {
        onPaste(target.index);
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clipboard-history-title"
      data-testid="clipboard-history-popup"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
    >
      <div className="flex w-full max-w-xl flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-fg)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-3 py-2">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-sky-400" />
            <h2 id="clipboard-history-title" className="text-[13px] font-semibold">Paste from History</h2>
            <span className="text-[10px] text-[var(--taomni-code-muted)]">session only</span>
          </div>
          <div className="flex items-center gap-1">
            {confirmingClear ? (
              <>
                <span className="px-1 text-[10px] text-[var(--taomni-code-muted)]">Clear all?</span>
                <button
                  type="button"
                  data-testid="clipboard-history-clear-confirm"
                  onClick={() => {
                    onClear();
                    setConfirmingClear(false);
                  }}
                  className="rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10"
                >
                  Clear
                </button>
                <button
                  type="button"
                  data-testid="clipboard-history-clear-abort"
                  onClick={() => setConfirmingClear(false)}
                  className="rounded border border-[var(--taomni-code-border)] px-2 py-0.5 text-[10px]"
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="clipboard-history-clear"
                onClick={() => setConfirmingClear(true)}
                disabled={entries.length === 0}
                aria-label="Clear history"
                title="Clear history"
                className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              data-testid="clipboard-history-close"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="border-b border-[var(--taomni-code-border)] px-3 py-2">
          <input
            type="text"
            autoFocus
            data-testid="clipboard-history-search"
            role="combobox"
            aria-expanded="true"
            aria-controls="clipboard-history-listbox"
            placeholder="Filter history…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2 text-[11px] focus:outline-none focus:border-sky-500"
          />
        </div>

        <div
          role="listbox"
          aria-label="Clipboard history entries"
          id="clipboard-history-listbox"
          data-testid="clipboard-history-listbox"
          className="max-h-72 overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <div data-testid="clipboard-history-empty" className="px-3 py-6 text-center text-[11px] text-[var(--taomni-code-muted)]">
              {entries.length === 0 ? "Clipboard history is empty." : "No entries match the filter."}
            </div>
          ) : (
            filtered.map(({ entry, index }, position) => (
              <div
                key={entry.sessionId}
                role="option"
                aria-selected={position === selectedIndex}
                data-testid={`clipboard-history-entry-${index}`}
                tabIndex={-1}
                onMouseEnter={() => setSelectedIndex(position)}
                onClick={() => {
                  onPaste(index);
                  onClose();
                }}
                className={`group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
                  position === selectedIndex ? "bg-sky-500/15" : "hover:bg-[var(--taomni-code-active-line-bg)]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                  {entry.plainText.split("\n")[0]?.slice(0, 120) || "(empty)"}
                </span>
                <span className="shrink-0 rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 text-[9px] text-[var(--taomni-code-muted)]">
                  {entry.segments?.length ?? 1} seg · {relativeTime(entry.createdAt)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete entry ${index + 1}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(index);
                  }}
                  className="shrink-0 rounded p-0.5 text-[var(--taomni-code-muted)] opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-[var(--taomni-code-border)] px-3 py-1.5 text-[10px] text-[var(--taomni-code-muted)]">
          ↑↓ Navigate · ↵ Paste at caret · Del Remove · Esc Close — never persisted, never polled from the system clipboard
        </div>
      </div>
    </div>
  );
}
