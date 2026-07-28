import { BookOpen, GraduationCap, Sparkles, WandSparkles, X } from "lucide-react";

export type EditorAiAction = "explain" | "syntax" | "fix" | "rewrite";

interface EditorSelectionAiToolbarProps {
  visible: boolean;
  rect: { top: number; left: number; right: number; bottom: number } | null;
  selectionText: string;
  busy?: boolean;
  onAction: (action: EditorAiAction, text: string) => void;
  onDismiss: () => void;
}

export function EditorSelectionAiToolbar({
  visible,
  rect,
  selectionText,
  busy = false,
  onAction,
  onDismiss,
}: EditorSelectionAiToolbarProps) {
  if (!visible || !rect || selectionText.trim().length < 2) return null;

  const TOOLBAR_HEIGHT = 34;
  const PADDING = 8;
  const placeAbove = rect.top > TOOLBAR_HEIGHT + PADDING;
  const top = placeAbove ? rect.top - TOOLBAR_HEIGHT - PADDING : rect.bottom + PADDING;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 420));

  return (
    <div
      data-testid="code-workspace-ai-selection-toolbar"
      className="fixed z-[420] flex items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] px-1 py-0.5 shadow-xl"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="h-7 inline-flex items-center gap-1 rounded px-2 text-[11px] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
        disabled={busy}
        title="Explain selection with AI"
        onClick={() => onAction("explain", selectionText)}
      >
        <BookOpen className="h-3.5 w-3.5" />
        Explain
      </button>
      <button
        type="button"
        className="h-7 inline-flex items-center gap-1 rounded px-2 text-[11px] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
        disabled={busy}
        title="Explain the language syntax used in the selection"
        onClick={() => onAction("syntax", selectionText)}
      >
        <GraduationCap className="h-3.5 w-3.5" />
        Syntax
      </button>
      <button
        type="button"
        className="h-7 inline-flex items-center gap-1 rounded px-2 text-[11px] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
        disabled={busy}
        title="Ask AI to fix selection"
        onClick={() => onAction("fix", selectionText)}
      >
        <WandSparkles className="h-3.5 w-3.5" />
        Fix
      </button>
      <button
        type="button"
        className="h-7 inline-flex items-center gap-1 rounded px-2 text-[11px] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
        disabled={busy}
        title="Send selection to AI composer for rewrite"
        onClick={() => onAction("rewrite", selectionText)}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Ask AI
      </button>
      <button
        type="button"
        className="h-7 w-7 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
        title="Dismiss AI toolbar"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
