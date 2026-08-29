import { useEffect } from "react";
import { ArrowLeftRight, Check, Copy, X } from "lucide-react";
import type { EditorCompareSession } from "./editorCompareModel";

interface EditorCompareDialogProps {
  session: EditorCompareSession;
  onClose: () => void;
  onApplyRight?: (newText: string) => void;
}

export function EditorCompareDialog({
  session,
  onClose,
  onApplyRight,
}: EditorCompareDialogProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const leftLines = session.left.text.split("\n");
  const rightLines = session.right.text.split("\n");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={session.title}
      data-testid="code-workspace-compare-dialog"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--taomni-code-bg)]/95 backdrop-blur-sm p-4 text-[var(--taomni-code-text)]"
    >
      {/* Dialog Header */}
      <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] pb-3">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-[var(--taomni-accent)]" />
          <h2 className="text-sm font-semibold">{session.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {onApplyRight && !session.right.readOnly && (
            <button
              type="button"
              data-testid="compare-apply-left-to-right"
              onClick={() => onApplyRight(session.left.text)}
              className="inline-flex items-center gap-1 rounded bg-[var(--taomni-accent)] px-2.5 py-1 text-xs font-medium text-[var(--taomni-code-bg)] hover:brightness-110"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Apply Left to Right</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Close compare dialog"
            data-testid="compare-dialog-close"
            onClick={onClose}
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Diff Panes */}
      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* Left Side */}
        <div className="flex flex-1 flex-col rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
          <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-3 py-1.5 text-xs font-medium">
            <span className="truncate">{session.left.title}</span>
            <button
              type="button"
              data-testid="compare-copy-left"
              onClick={() => void navigator.clipboard.writeText(session.left.text)}
              className="inline-flex items-center gap-1 rounded p-1 text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-text)]"
              title="Copy left text"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2 font-mono text-xs leading-5">
            {leftLines.map((line, i) => {
              const isDifferent = line !== rightLines[i];
              return (
                <div
                  key={i}
                  data-testid={`compare-left-line-${i}`}
                  className={`flex gap-3 px-2 ${isDifferent ? "bg-red-500/10 text-red-300" : ""}`}
                >
                  <span className="w-8 shrink-0 select-none text-right text-[var(--taomni-code-muted)]">{i + 1}</span>
                  <span className="whitespace-pre">{line || " "}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Side */}
        <div className="flex flex-1 flex-col rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
          <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-3 py-1.5 text-xs font-medium">
            <span className="truncate">{session.right.title}</span>
            <button
              type="button"
              data-testid="compare-copy-right"
              onClick={() => void navigator.clipboard.writeText(session.right.text)}
              className="inline-flex items-center gap-1 rounded p-1 text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-text)]"
              title="Copy right text"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2 font-mono text-xs leading-5">
            {rightLines.map((line, i) => {
              const isDifferent = line !== leftLines[i];
              return (
                <div
                  key={i}
                  data-testid={`compare-right-line-${i}`}
                  className={`flex gap-3 px-2 ${isDifferent ? "bg-emerald-500/10 text-emerald-300" : ""}`}
                >
                  <span className="w-8 shrink-0 select-none text-right text-[var(--taomni-code-muted)]">{i + 1}</span>
                  <span className="whitespace-pre">{line || " "}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
