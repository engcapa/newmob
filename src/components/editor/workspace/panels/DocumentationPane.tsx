import { BookOpen, ChevronLeft, ChevronRight, Pin, PinOff } from "lucide-react";
import { renderFormatted } from "../../../../lib/chat/renderFormatted";
import { ReferenceContentFooter, useReferenceBodyLinkHandler } from "../ReferenceContentFooter";
import type { QuickDocContent } from "../referenceDocumentation";

interface DocumentationPaneProps {
  content: QuickDocContent | null;
  locked?: boolean;
  onUnlock?: () => void;
  onClear?: () => void;
  onOpenSource?: (content: QuickDocContent) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

export function DocumentationPane({
  content,
  locked = false,
  onUnlock,
  onClear,
  onOpenSource,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: DocumentationPaneProps) {
  const { linkError, onClick: onBodyClick } = useReferenceBodyLinkHandler();
  if (!content) {
    return (
      <div
        data-testid="code-workspace-documentation-pane"
        className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-[var(--taomni-code-muted)]"
      >
        <BookOpen className="h-5 w-5 opacity-60" />
        <p>No pinned documentation.</p>
        <p className="text-[10px] opacity-80">
          Press Ctrl+Q (or F1) on a symbol, then pin the quick doc here.
        </p>
      </div>
    );
  }

  const html = renderFormatted(content.body, "md") ?? content.body;

  return (
    <div
      data-testid="code-workspace-documentation-pane"
      className="flex h-full min-h-0 flex-col text-[12px]"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        <button
          type="button"
          aria-label="Previous documentation"
          disabled={!canGoBack}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-30"
          onClick={onBack}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Next documentation"
          disabled={!canGoForward}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-30"
          onClick={onForward}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--taomni-code-text)]">
          {content.title}
        </span>
        {locked && (
          <Pin className="h-3 w-3 shrink-0 text-[var(--taomni-code-muted)]" aria-label="Pinned" />
        )}
        {locked && onUnlock && (
          <button
            type="button"
            aria-label="Unpin documentation"
            title="Unpin (resume cursor-linked refresh)"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onUnlock}
          >
            <PinOff className="h-3.5 w-3.5" />
          </button>
        )}
        {onClear && (
          <button
            type="button"
            aria-label="Clear documentation"
            className="h-6 rounded px-1.5 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
      <div
        className="taomni-chat-md min-h-0 flex-1 overflow-auto px-3 py-2 leading-relaxed text-[var(--taomni-code-text)]"
        onClick={onBodyClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {linkError && <div role="status" className="px-2 pb-1 text-[10px] text-red-400">{linkError}</div>}
      <ReferenceContentFooter content={content} onOpenSource={onOpenSource} />
    </div>
  );
}
