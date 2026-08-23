import { ExternalLink, FileCode2 } from "lucide-react";
import { useState, type MouseEvent } from "react";
import {
  openExternalDocumentation,
  referenceHrefFromEventTarget,
  validateExternalDocUrl,
  type QuickDocContent,
} from "./referenceDocumentation";

interface ReferenceContentFooterProps {
  content: QuickDocContent;
  onOpenSource?: (content: QuickDocContent) => void;
}

export function ReferenceContentFooter({ content, onOpenSource }: ReferenceContentFooterProps) {
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <div className="flex min-h-7 shrink-0 items-center gap-2 border-t border-[var(--taomni-code-border)] px-2 py-1 text-[10px] text-[var(--taomni-code-muted)]">
      <span className="min-w-0 flex-1 truncate" title={content.uri ?? content.source}>
        {content.source}
      </span>
      {openError && (
        <span role="status" className="truncate text-red-400" title={openError}>
          {openError}
        </span>
      )}
      {content.sourceLocation && onOpenSource && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          onClick={() => onOpenSource(content)}
        >
          <FileCode2 className="h-3 w-3" />
          Source
        </button>
      )}
      {content.links?.map((link) => {
        const decision = validateExternalDocUrl(link.url);
        return (
          <button
            key={`${link.label}:${link.url}`}
            type="button"
            aria-label={`Open external documentation: ${link.label}`}
            title={decision.kind === "allowed"
              ? `${link.label} (${new URL(decision.url).host})`
              : `External Documentation unavailable (${decision.reason})`}
            disabled={decision.kind !== "allowed"}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={() => {
              setOpenError(null);
              void openExternalDocumentation(link.url).then((result) => {
                if (result.kind === "unavailable") {
                  setOpenError(`External Documentation unavailable (${result.reason})`);
                }
              });
            }}
          >
            <ExternalLink className="h-3 w-3" />
            {link.label}
          </button>
        );
      })}
    </div>
  );
}

export function useReferenceBodyLinkHandler() {
  const [linkError, setLinkError] = useState<string | null>(null);
  const onClick = (event: MouseEvent<HTMLElement>) => {
    const href = referenceHrefFromEventTarget(event.target);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkError(null);
    void openExternalDocumentation(href).then((result) => {
      if (result.kind === "unavailable") {
        setLinkError(`Link unavailable (${result.reason})`);
      }
    });
  };
  return { linkError, onClick };
}
