import { useEffect, useState } from "react";
import { Loader2, Sparkles, X, RefreshCw } from "lucide-react";
import type { GenerateCandidate } from "./generateCodeWorkflow";

export type GenerateDialogPhase = "loading" | "ready" | "empty" | "running" | "error";

export interface GenerateCodeDialogProps {
  open: boolean;
  phase: GenerateDialogPhase;
  /** Provider-returned generate candidates — real titles/kinds only. */
  candidates: readonly GenerateCandidate[];
  error?: string | null;
  onApply: (ids: readonly string[]) => void;
  onRetry: () => void;
  onCancel: () => void;
}

/**
 * §8.19.8 Generate Code dialog. Lists ONLY what the provider returned as
 * source/generate CodeActions; placement, conflicts and imports are decided
 * by the provider's own WorkspaceEdit and land as one history entry. A
 * resolve/apply failure keeps the dialog open with Retry/Cancel — no fixed
 * local template is ever inserted as a fallback.
 */
export function GenerateCodeDialog({
  open,
  phase,
  candidates,
  error,
  onApply,
  onRetry,
  onCancel,
}: GenerateCodeDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && phase === "ready") {
      // Default to the first candidate checked, mirroring IDEA's dialog.
      setSelected(new Set(candidates.length > 0 ? [candidates[0].id] : []));
    }
    if (!open) setSelected(new Set());
  }, [open, phase, candidates]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const busy = phase === "loading" || phase === "running";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="generate-code-title"
      data-testid="generate-code-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
    >
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-fg)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sky-400" />
            <h2 id="generate-code-title" className="text-[13px] font-semibold">Generate Code</h2>
          </div>
          <button
            type="button"
            data-testid="generate-code-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div data-testid="generate-code-body" className="max-h-72 overflow-y-auto p-3">
          {phase === "loading" && (
            <div data-testid="generate-code-loading" className="flex items-center gap-2 px-1 py-6 text-[11px] text-[var(--taomni-code-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Requesting generation actions from the language server…
            </div>
          )}
          {phase === "empty" && (
            <div data-testid="generate-code-empty" className="px-1 py-6 text-center text-[11px] text-[var(--taomni-code-muted)]">
              The language server did not offer any generation actions here.
            </div>
          )}
          {phase === "error" && (
            <div data-testid="generate-code-error" className="space-y-1 px-1 py-2">
              <p className="text-[11px] text-red-400">{error ?? "Generation failed."}</p>
              <p className="text-[10px] text-[var(--taomni-code-muted)]">
                Nothing was inserted by Taomni itself; retry re-requests the provider.
              </p>
            </div>
          )}
          {(phase === "ready" || phase === "running") && candidates.length > 0 && (
            <div role="group" aria-label="Generation candidates" data-testid="generate-code-candidates" className="space-y-0.5">
              {candidates.map((candidate) => (
                <label
                  key={candidate.id}
                  data-testid={`generate-code-candidate-${candidate.id}`}
                  className={`flex items-start gap-2 rounded px-2 py-1.5 ${
                    phase === "running"
                      ? "opacity-60"
                      : "cursor-pointer hover:bg-[var(--taomni-code-active-line-bg)]"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3 w-3 accent-sky-500"
                    checked={selected.has(candidate.id)}
                    disabled={phase === "running"}
                    onChange={() => toggle(candidate.id)}
                    aria-label={candidate.title}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{candidate.title}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--taomni-code-muted)]">{candidate.kind}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {phase === "ready" && (
          <p className="border-t border-[var(--taomni-code-border)] px-4 py-1.5 text-[10px] text-[var(--taomni-code-muted)]">
            Placement and imports come from the provider edit; all selected actions apply as one history entry after a freshness re-check.
          </p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/20 px-4 py-2">
          {phase === "error" ? (
            <>
              <button
                type="button"
                data-testid="generate-code-retry"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-2.5 py-1 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
              >
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
              <button
                type="button"
                data-testid="generate-code-cancel"
                onClick={onCancel}
                className="rounded border border-[var(--taomni-code-border)] px-2.5 py-1 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="generate-code-cancel-footer"
                onClick={onCancel}
                disabled={busy}
                className="rounded border border-[var(--taomni-code-border)] px-2.5 py-1 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="generate-code-apply"
                onClick={() => onApply([...selected])}
                disabled={busy || selected.size === 0}
                className="rounded bg-sky-500/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {phase === "running" ? "Applying…" : "Generate"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
