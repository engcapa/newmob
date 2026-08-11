import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { LspShowMessageRequest } from "../../../lib/editor/lsp";

interface LspMessageRequestDialogProps {
  request: LspShowMessageRequest;
  onSelect: (actionIndex: number | null) => void;
}

function messageTone(messageType: number): { border: string; label: string } {
  if (messageType === 1) return { border: "#b22222", label: "Language server error" };
  if (messageType === 2) return { border: "#b7791f", label: "Language server warning" };
  return { border: "var(--taomni-accent)", label: "Language server message" };
}

/** Modal for an LSP window/showMessageRequest. Actions are server-provided and
 * may be more than the usual two-button shape, so keep the list data-driven. */
export function LspMessageRequestDialog({
  request,
  onSelect,
}: LspMessageRequestDialogProps) {
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const tone = messageTone(request.messageType);

  useEffect(() => {
    firstActionRef.current?.focus();
  }, [request.requestId]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onSelect(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[960] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.42)" }}
      onClick={() => onSelect(null)}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tone.label}
        data-testid="lsp-message-request-dialog"
        className="w-[min(560px,calc(100vw-32px))] max-h-[min(80vh,520px)] overflow-auto rounded shadow-xl p-4"
        style={{
          background: "var(--taomni-bg)",
          border: `1px solid ${tone.border}`,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate">{request.serverLabel}</div>
            <div
              data-testid="lsp-message-request-message"
              className="mt-2 text-[13px] whitespace-pre-wrap break-words"
              style={{ color: "var(--taomni-text)" }}
            >
              {request.message}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss language server message"
            title="Dismiss"
            className="shrink-0 rounded p-1 hover:bg-[var(--taomni-hover)]"
            onClick={() => onSelect(null)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {request.actions.map((action, index) => (
            <button
              key={`${request.requestId}-${index}`}
              ref={index === 0 ? firstActionRef : undefined}
              type="button"
              className="max-w-full rounded px-3 py-1.5 text-[12px] font-medium whitespace-normal break-words hover:brightness-110"
              style={{ background: "var(--taomni-accent)", color: "white" }}
              onClick={() => onSelect(index)}
            >
              {action.title}
            </button>
          ))}
          <button
            type="button"
            className="rounded px-3 py-1.5 text-[12px] hover:bg-[var(--taomni-hover)]"
            style={{ border: "1px solid var(--taomni-divider)" }}
            onClick={() => onSelect(null)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
