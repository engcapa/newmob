import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, X } from "lucide-react";
import { renderFormatted } from "../../../lib/chat/renderFormatted";

export interface QuickDocContent {
  /** Symbol or path label shown in the header. */
  title: string;
  /** Markdown / plaintext body from LSP hover. */
  body: string;
}

interface QuickDocPopupProps {
  open: boolean;
  content: QuickDocContent | null;
  onClose: () => void;
  onPin: (content: QuickDocContent) => void;
}

const MIN_WIDTH = 280;
const MIN_HEIGHT = 140;
const DEFAULT_WIDTH = 460;
const DEFAULT_HEIGHT = 320;

export function QuickDocPopup({ open, content, onClose, onPin }: QuickDocPopupProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
  const isResizingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.focus();
  }, [open, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (isResizingRef.current) return;
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", onPointer, true);
    return () => window.removeEventListener("mousedown", onPointer, true);
  }, [onClose, open]);

  const handleResizeMouseDown = useCallback((corner: "se" | "sw" | "ne" | "nw" = "se") => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = rootRef.current?.getBoundingClientRect();
    const startWidth = startRect?.width && startRect.width > 0 ? startRect.width : size.width;
    const startHeight = startRect?.height && startRect.height > 0 ? startRect.height : size.height;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const maxWidth = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth * 0.95 : 1600;
      const maxHeight = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight * 0.85 : 1200;

      let newWidth = startWidth;
      let newHeight = startHeight;

      if (corner === "se") {
        newWidth = startWidth + deltaX;
        newHeight = startHeight + deltaY;
      } else if (corner === "sw") {
        newWidth = startWidth - deltaX;
        newHeight = startHeight + deltaY;
      } else if (corner === "ne") {
        newWidth = startWidth + deltaX;
        newHeight = startHeight - deltaY;
      } else if (corner === "nw") {
        newWidth = startWidth - deltaX;
        newHeight = startHeight - deltaY;
      }

      newWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, newWidth));
      newHeight = Math.max(MIN_HEIGHT, Math.min(maxHeight, newHeight));

      setSize({ width: Math.round(newWidth), height: Math.round(newHeight) });
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [size.height, size.width]);

  if (!open || !content) return null;

  const html = renderFormatted(content.body, "md") ?? content.body;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Quick documentation"
      tabIndex={0}
      data-testid="code-workspace-quick-doc"
      className="absolute right-6 top-16 z-40 flex flex-col overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-xl outline-none"
      style={{
        width: `${size.width}px`,
        height: `${size.height}px`,
        maxWidth: "95vw",
        maxHeight: "85vh",
        minWidth: `${MIN_WIDTH}px`,
        minHeight: `${MIN_HEIGHT}px`,
      }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2 select-none">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--taomni-code-text)]">
          {content.title}
        </span>
        <button
          type="button"
          title="Pin to Documentation pane"
          aria-label="Pin to Documentation pane"
          data-testid="code-workspace-quick-doc-pin"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          onClick={() => onPin(content)}
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Close"
          aria-label="Close quick documentation"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="taomni-chat-md min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--taomni-code-text)]"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* 4-corner resize handles */}
      <div
        className="absolute top-0 left-0 h-4 w-4 cursor-nw-resize z-10 select-none"
        onMouseDown={handleResizeMouseDown("nw")}
      />
      <div
        className="absolute top-0 right-0 h-4 w-4 cursor-ne-resize z-10 select-none"
        onMouseDown={handleResizeMouseDown("ne")}
      />
      <div
        className="absolute bottom-0 left-0 h-4 w-4 cursor-sw-resize z-10 select-none"
        onMouseDown={handleResizeMouseDown("sw")}
      />
      <div
        data-testid="code-workspace-quick-doc-resize-handle"
        aria-label="Resize documentation dialog"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize flex items-end justify-end p-0.5 opacity-40 hover:opacity-100 z-10 select-none"
        onMouseDown={handleResizeMouseDown("se")}
      >
        <svg viewBox="0 0 6 6" className="h-2.5 w-2.5 fill-current text-[var(--taomni-code-muted)]">
          <path d="M5 1L1 5M5 3L3 5M5 5L5 5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
