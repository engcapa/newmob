import { useEffect, useMemo, useState } from "react";
import { BoxSelect, X } from "lucide-react";
import { surroundKindsForLanguage, type SurroundKind } from "./workspaceSemanticEditing";

export interface SurroundWithDialogProps {
  open: boolean;
  /** Language of the active editor; kinds outside the adapter stay hidden. */
  languageId: string | null;
  onClose: () => void;
  /** Apply the chosen kind through the single action/dialog/one-undo path. */
  onPick: (kindId: SurroundKind["id"]) => void;
}

/**
 * §8.19.8 Surround With dialog. Lists ONLY kinds the language adapter
 * provides; every kind routes through the same plan builder and lands as one
 * undoable transaction. Local whole-line templates are labelled as such —
 * the dialog never presents them as Semantic.
 */
export function SurroundWithDialog({ open, languageId, onClose, onPick }: SurroundWithDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const kinds = useMemo(() => surroundKindsForLanguage(languageId), [languageId]);

  useEffect(() => {
    if (open) setSelectedIndex(0);
  }, [open, languageId]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1) % Math.max(1, kinds.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((idx) => (idx - 1 + kinds.length) % Math.max(1, kinds.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const kind = kinds[selectedIndex];
      if (kind) {
        onPick(kind.id);
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="surround-with-title"
      data-testid="surround-with-dialog"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
    >
      <div className="flex w-full max-w-md flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-fg)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <BoxSelect className="h-4 w-4 text-sky-400" />
            <h2 id="surround-with-title" className="text-[13px] font-semibold">Surround With…</h2>
          </div>
          <button
            type="button"
            data-testid="surround-with-close"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div role="listbox" aria-label="Surround kinds" data-testid="surround-with-kinds" className="max-h-72 overflow-y-auto p-1.5">
          {kinds.length === 0 ? (
            <div data-testid="surround-with-empty" className="px-3 py-6 text-center text-[11px] text-[var(--taomni-code-muted)]">
              No surround kinds are available for this language.
            </div>
          ) : (
            kinds.map((kind, idx) => (
              <button
                key={kind.id}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                data-testid={`surround-with-kind-${kind.id}`}
                onMouseEnter={() => setSelectedIndex(idx)}
                onClick={() => {
                  onPick(kind.id);
                  onClose();
                }}
                className={`flex w-full items-center justify-between rounded px-3 py-1.5 text-left ${
                  idx === selectedIndex
                    ? "bg-sky-500/15 text-[var(--taomni-code-fg)]"
                    : "hover:bg-[var(--taomni-code-active-line-bg)]"
                }`}
              >
                <span>{kind.title}</span>
                {/* Honest provenance up front: templates are applied from the
                    local adapter; syntax alignment is verified at apply time
                    and recorded in the edit evidence, not advertised here. */}
                <span className="rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                  template
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--taomni-code-border)] px-4 py-2 text-[10px] text-[var(--taomni-code-muted)]">
          <span>↑↓ Navigate · ↵ Apply · Esc Cancel</span>
          <span data-testid="surround-with-language">{languageId ?? "unknown"}</span>
        </div>
      </div>
    </div>
  );
}
