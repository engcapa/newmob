import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface CommitMessageHoverContent {
  subject: string;
  body?: string;
  meta?: string;
}

export interface CommitMessageHoverProps {
  content: CommitMessageHoverContent;
  children: ReactNode;
  className?: string;
  /** Delay before showing (ms). Default 350. */
  openDelayMs?: number;
  /** Delay before hiding when pointer leaves (ms). Default 180. */
  closeDelayMs?: number;
}

interface PopupPos {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
}

const VIEW_PAD = 8;
const POPUP_GAP = 6;

/**
 * Hoverable commit message that becomes a sticky, selectable popup.
 * Pointer can move from the trigger onto the popup; Esc / outside click closes.
 */
export function CommitMessageHover({
  content,
  children,
  className = "",
  openDelayMs = 350,
  closeDelayMs = 180,
}: CommitMessageHoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopupPos | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const popupId = useId();

  const clearTimers = useCallback(() => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), openDelayMs);
  }, [clearTimers, openDelayMs]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), closeDelayMs);
  }, [clearTimers, closeDelayMs]);

  const keepOpen = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        clearTimers();
        setOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      clearTimers();
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [open, clearTimers]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;

    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const maxWidth = Math.min(420, vw - VIEW_PAD * 2);
      const maxHeight = Math.min(280, vh - VIEW_PAD * 2);

      // Prefer below the row; flip above if not enough space.
      let top = rect.bottom + POPUP_GAP;
      if (top + 120 > vh - VIEW_PAD) {
        top = Math.max(VIEW_PAD, rect.top - POPUP_GAP - Math.min(maxHeight, 160));
      }
      let left = rect.left;
      if (left + maxWidth > vw - VIEW_PAD) {
        left = Math.max(VIEW_PAD, vw - VIEW_PAD - maxWidth);
      }
      if (left < VIEW_PAD) left = VIEW_PAD;

      setPos({ top, left, maxWidth, maxHeight });
    };

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, content.subject, content.body, content.meta]);

  const body = content.body?.trim() ?? "";

  return (
    <div
      ref={triggerRef}
      className={className}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && (triggerRef.current?.contains(next) || popupRef.current?.contains(next))) {
          return;
        }
        scheduleClose();
      }}
      aria-describedby={open ? popupId : undefined}
    >
      {children}
      {open && pos && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          role="dialog"
          aria-label="Commit message"
          data-testid="commit-message-hover"
          className="fixed z-[600] rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)] shadow-xl"
          style={{
            top: pos.top,
            left: pos.left,
            maxWidth: pos.maxWidth,
            maxHeight: pos.maxHeight,
            width: "max-content",
            minWidth: 220,
          }}
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
        >
          <div
            className="overflow-auto p-3 select-text cursor-text"
            style={{ maxHeight: pos.maxHeight }}
          >
            <div className="text-[12px] leading-5 font-semibold whitespace-pre-wrap break-words">
              {content.subject}
            </div>
            {body ? (
              <div className="mt-1.5 text-[11px] leading-4 text-[var(--taomni-text-muted)] whitespace-pre-wrap break-words">
                {body}
              </div>
            ) : null}
            {content.meta ? (
              <div className="mt-2 pt-2 border-t border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)] select-text">
                {content.meta}
              </div>
            ) : null}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
