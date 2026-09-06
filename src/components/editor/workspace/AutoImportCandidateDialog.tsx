import { useEffect, useId, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import type { AutoImportCandidate } from "./autoImportModel";

export interface AutoImportCandidateDialogProps {
  open: boolean;
  candidates: readonly AutoImportCandidate[];
  onSelect: (candidate: AutoImportCandidate) => void;
  onClose: () => void;
}

export function AutoImportCandidateDialog({
  open,
  candidates,
  onSelect,
  onClose,
}: AutoImportCandidateDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      setSelectedIndex(0);
    }
  }, [open, candidates]);

  if (!open || candidates.length === 0) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % candidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = candidates[selectedIndex];
      if (chosen) {
        onSelect(chosen);
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onKeyDown={handleKeyDown}
      data-testid="auto-import-candidate-dialog"
    >
      <div className="relative w-full max-w-md rounded-xl border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-5 shadow-2xl text-[var(--taomni-code-text)] flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] pb-2">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-[var(--taomni-accent)]" />
            <h2 id={titleId} className="text-sm font-semibold">
              Select Class to Import
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-800 text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-text)]"
            title="Cancel (Escape)"
            data-testid="auto-import-candidate-cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <p className="text-xs text-[var(--taomni-code-muted)]">
          Multiple matching classes found for <code>{candidates[0]?.symbolName}</code>. Choose which one to import:
        </p>

        {/* Candidate List */}
        <div className="flex flex-col gap-1 max-h-60 overflow-y-auto rounded-lg border border-[var(--taomni-code-border)] p-1 bg-neutral-900/50">
          {candidates.map((cand, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={cand.fullyQualifiedName}
                type="button"
                onClick={() => onSelect(cand)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`flex items-center justify-between px-3 py-2 text-xs rounded text-left transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-[var(--taomni-accent)]/20 text-[var(--taomni-accent)] font-medium"
                    : "hover:bg-neutral-800 text-neutral-300"
                }`}
                data-testid="auto-import-candidate-option"
                data-candidate-fqn={cand.fullyQualifiedName}
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-mono truncate">{cand.fullyQualifiedName}</span>
                  <span className="text-[10px] text-[var(--taomni-code-muted)] truncate">
                    package {cand.sourcePackage}
                  </span>
                </div>
                {cand.priority !== undefined && cand.priority > 0 && (
                  <span className="text-[10px] text-neutral-500 font-mono shrink-0 ml-2">
                    prio {cand.priority}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--taomni-code-border)] text-xs">
          <span className="text-[10px] text-[var(--taomni-code-muted)]">
            Use ↑↓ to navigate, Enter to select
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 border border-[var(--taomni-code-border)] text-neutral-300 hover:bg-neutral-800 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const chosen = candidates[selectedIndex];
                if (chosen) onSelect(chosen);
              }}
              className="px-3 py-1 bg-[var(--taomni-accent)] text-black font-medium hover:brightness-110 rounded transition-colors"
              data-testid="auto-import-candidate-submit"
            >
              Select
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
