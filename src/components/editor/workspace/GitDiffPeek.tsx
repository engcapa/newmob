import { RotateCcw, X } from "lucide-react";
import type { GitLineChange } from "./gitEditorChrome";

function lineLabel(start: number, end: number): string {
  return start === end ? `${start + 1}` : `${start + 1}-${end + 1}`;
}

export function GitDiffPeek({
  change,
  onClose,
  onRollback,
}: {
  change: GitLineChange;
  onClose: () => void;
  onRollback?: (change: GitLineChange) => void;
}) {
  return (
    <aside
      data-testid="code-workspace-git-diff-peek"
      className="absolute left-10 top-3 z-20 max-h-[70%] w-[min(640px,calc(100%-4rem))] overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-2xl"
    >
      <div className="flex h-8 items-center gap-2 border-b border-[var(--taomni-code-border)] px-2 text-[10px] text-[var(--taomni-code-muted)]">
        <span className="font-semibold capitalize text-[var(--taomni-code-text)]">{change.kind} lines</span>
        <span>HEAD {lineLabel(change.oldStartLine, change.oldEndLine)}</span>
        <span>→ Buffer {lineLabel(change.startLine, change.endLine)}</span>
        {onRollback && (
          <button
            type="button"
            data-testid="git-diff-peek-rollback-btn"
            aria-label="Rollback this change"
            title="Rollback this change to HEAD"
            className="ml-auto inline-flex items-center gap-1 rounded bg-[var(--taomni-code-active-line-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--taomni-code-text)] hover:opacity-80"
            onClick={() => {
              onRollback(change);
              onClose();
            }}
          >
            <RotateCcw className="h-3 w-3" />
            <span>Rollback</span>
          </button>
        )}
        <button
          type="button"
          aria-label="Close inline Git diff"
          className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)] ${onRollback ? "" : "ml-auto"}`}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-[360px] overflow-auto font-mono text-[11px] leading-5">
        {change.oldText && change.oldText.split("\n").map((line, index) => (
          <div key={`old:${index}`} className="flex bg-red-500/10 text-red-400">
            <span className="w-7 shrink-0 select-none text-center opacity-60">−</span>
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{line || " "}</pre>
          </div>
        ))}
        {change.newText && change.newText.split("\n").map((line, index) => (
          <div key={`new:${index}`} className="flex bg-green-500/10 text-green-400">
            <span className="w-7 shrink-0 select-none text-center opacity-60">+</span>
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{line || " "}</pre>
          </div>
        ))}
      </div>
    </aside>
  );
}
