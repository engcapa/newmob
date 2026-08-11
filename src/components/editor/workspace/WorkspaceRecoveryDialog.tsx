import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, HardDrive, RotateCcw, Trash2, X } from "lucide-react";
import type { WorkspaceRecoveryEntry } from "./workspaceRecovery";

export interface WorkspaceRecoveryDialogProps {
  entries: WorkspaceRecoveryEntry[];
  onRecover: (entry: WorkspaceRecoveryEntry) => void | Promise<void>;
  onDiscard: (entry: WorkspaceRecoveryEntry) => void;
  onRecoverAll: () => void | Promise<void>;
  onDiscardAll: () => void;
  onClose: () => void;
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function capturedLabel(timestamp: number): string {
  if (!timestamp) return "Unknown time";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown time";
  }
}

/** Lists unsaved buffers left by a previous renderer/process lifetime. */
export function WorkspaceRecoveryDialog({
  entries,
  onRecover,
  onDiscard,
  onRecoverAll,
  onDiscardAll,
  onClose,
}: WorkspaceRecoveryDialogProps) {
  const [selectedKey, setSelectedKey] = useState(entries[0]?.key ?? null);
  const [busy, setBusy] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!entries.some((entry) => entry.key === selectedKey)) {
      setSelectedKey(entries[0]?.key ?? null);
    }
    window.setTimeout(() => primaryRef.current?.focus(), 0);
  }, [entries, selectedKey]);

  const selected = useMemo(
    () => entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null,
    [entries, selectedKey],
  );

  const runRecoverAll = async () => {
    setBusy(true);
    try {
      await onRecoverAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[965] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace recovery"
        data-testid="workspace-recovery-dialog"
        className="flex h-[min(680px,90vh)] w-[min(980px,calc(100vw-32px))] flex-col overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[var(--taomni-code-text)]">
              Recover unsaved files
            </div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]">
              These buffers were captured before the previous workspace session ended.
            </div>
          </div>
          <button
            type="button"
            aria-label="Close workspace recovery"
            title="Decide later"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]">
          <aside className="min-h-0 overflow-auto border-b border-[var(--taomni-code-border)] md:border-b-0 md:border-r">
            <div className="border-b border-[var(--taomni-code-border)] px-3 py-2 text-[10px] text-[var(--taomni-code-muted)]">
              {entries.length} unsaved {entries.length === 1 ? "buffer" : "buffers"}
            </div>
            <ul className="py-1">
              {entries.map((entry) => (
                <li key={entry.key}>
                  <div
                    className="flex items-start gap-1 px-2 py-1 hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
                    data-selected={entry.key === selected?.key || undefined}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate px-1 py-1 text-left"
                      onClick={() => setSelectedKey(entry.key)}
                    >
                      <span className="block truncate text-[11px] text-[var(--taomni-code-text)]" title={entry.path}>
                        {entry.path}
                      </span>
                      <span className="block truncate text-[10px] text-[var(--taomni-code-muted)]">
                        {capturedLabel(entry.capturedAt)} · {lineCount(entry.text)} lines
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Discard recovery for ${entry.path}`}
                      title="Discard"
                      className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-red-500/15 hover:text-red-400"
                      onClick={() => onDiscard(entry)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </aside>

          <section className="flex min-h-0 flex-col">
            {selected ? (
              <>
                <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2">
                  <div className="truncate text-[11px] font-semibold text-[var(--taomni-code-text)]" title={selected.path}>
                    {selected.path}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                    {capturedLabel(selected.capturedAt)} · {selected.text.length.toLocaleString()} characters
                  </div>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-[var(--taomni-code-text)]">
                  {selected.text}
                </pre>
                <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
                    onClick={() => onDiscard(selected)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Discard selected
                  </button>
                  <button
                    ref={primaryRef}
                    type="button"
                    disabled={busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded bg-[var(--taomni-accent)] px-3 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                    onClick={() => void onRecover(selected)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Recover selected
                  </button>
                </footer>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-[var(--taomni-code-muted)]">
                No recovery buffers remain.
              </div>
            )}
          </section>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-[var(--taomni-code-muted)]">
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            Recovery data stays local to this workspace.
          </div>
          <button
            type="button"
            disabled={busy || entries.length === 0}
            className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            onClick={() => void runRecoverAll()}
          >
            Recover all
          </button>
          <button
            type="button"
            disabled={busy || entries.length === 0}
            className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            onClick={onDiscardAll}
          >
            Discard all
          </button>
          <button
            type="button"
            className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            Decide later
          </button>
        </footer>
      </div>
    </div>
  );
}

