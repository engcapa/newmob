// FloatingToolbar — draggable, collapsible wrapper for tab-overlay toolbars
// (CaptureToolbar, SFTP toggle, VNC scaling button, etc).
//
// The toolbar floats absolutely inside its closest positioned ancestor. The
// caller is responsible for making that ancestor `position: relative`. Users
// can:
//   * drag the grip handle to move the toolbar anywhere within its parent
//   * click the collapse button to shrink it down to a single restore pill
//   * the position + collapsed state persist to localStorage by `storageKey`
//
// When collapsed the pill is itself draggable so it never gets stuck behind
// content the user wants to read.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChevronRight, EyeOff, GripVertical } from "lucide-react";

interface StoredState {
  top: number;
  right: number;
  collapsed: boolean;
}

export interface FloatingToolbarProps {
  /** Required. localStorage key used to persist position + collapsed state. */
  storageKey: string;
  /** Default placement when nothing is stored. Distance in px from the
   *  parent's top/right edges. */
  defaultTop?: number;
  defaultRight?: number;
  /** Tooltip on the collapse button. */
  collapseLabel?: string;
  /** Tooltip on the restore pill. */
  restoreLabel?: string;
  /** Optional test id forwarded to the outer container. */
  testId?: string;
  children: ReactNode;
}

const DEFAULT_TOP = 4;
const DEFAULT_RIGHT = 4;

function readStored(key: string): Partial<StoredState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota/serialization errors
  }
}

const HANDLE_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "#bbb",
  cursor: "grab",
  padding: 2,
  borderRadius: 3,
};

const ICON_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "#bbb",
  cursor: "pointer",
  padding: 2,
  borderRadius: 3,
};

const RESTORE_PILL_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ccc",
  borderRadius: 999,
  width: 22,
  height: 22,
  padding: 0,
  cursor: "pointer",
};

export function FloatingToolbar({
  storageKey,
  defaultTop = DEFAULT_TOP,
  defaultRight = DEFAULT_RIGHT,
  collapseLabel = "Hide toolbar",
  restoreLabel = "Show toolbar",
  testId,
  children,
}: FloatingToolbarProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [position, setPosition] = useState<{ top: number; right: number }>(() => {
    const stored = readStored(storageKey);
    return {
      top: typeof stored?.top === "number" ? stored.top : defaultTop,
      right: typeof stored?.right === "number" ? stored.right : defaultRight,
    };
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = readStored(storageKey);
    return typeof stored?.collapsed === "boolean" ? stored.collapsed : false;
  });

  // Persist whenever state changes.
  useEffect(() => {
    writeStored(storageKey, { top: position.top, right: position.right, collapsed });
  }, [storageKey, position.top, position.right, collapsed]);

  // Re-clamp position into the parent rect after layout (covers parent
  // shrink, e.g. the user closed the sidebar and the panel got narrower).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    let { top, right } = position;
    const maxTop = Math.max(0, parentRect.height - rect.height);
    const maxRight = Math.max(0, parentRect.width - rect.width);
    let next = position;
    if (top < 0) next = { ...next, top: 0 };
    else if (top > maxTop) next = { ...next, top: maxTop };
    if (right < 0) next = { ...next, right: 0 };
    else if (right > maxRight) next = { ...next, right: maxRight };
    if (next !== position) setPosition(next);
  }, [position, collapsed]);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTop: number;
    startRight: number;
  } | null>(null);

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const el = containerRef.current;
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTop: position.top,
        startRight: position.right,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    },
    [position.top, position.right],
  );

  const handleDragMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const el = containerRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const parentRect = parent ? parent.getBoundingClientRect() : null;
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    let nextTop = drag.startTop + dy;
    let nextRight = drag.startRight - dx;
    if (parentRect) {
      const maxTop = Math.max(0, parentRect.height - rect.height);
      const maxRight = Math.max(0, parentRect.width - rect.width);
      nextTop = Math.min(Math.max(0, nextTop), maxTop);
      nextRight = Math.min(Math.max(0, nextRight), maxRight);
    } else {
      nextTop = Math.max(0, nextTop);
      nextRight = Math.max(0, nextRight);
    }
    setPosition({ top: nextTop, right: nextRight });
  }, []);

  const handleDragEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  if (collapsed) {
    return (
      <div
        ref={containerRef}
        data-testid={testId}
        className="pointer-events-auto"
        style={{
          position: "absolute",
          top: position.top,
          right: position.right,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
      >
        <button
          type="button"
          aria-label="Drag toolbar"
          title="Drag"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          style={{ ...HANDLE_BUTTON_STYLE, opacity: 0.55 }}
        >
          <GripVertical size={12} />
        </button>
        <button
          type="button"
          aria-label={restoreLabel}
          title={restoreLabel}
          onClick={() => setCollapsed(false)}
          style={RESTORE_PILL_STYLE}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className="pointer-events-auto"
      style={{
        position: "absolute",
        top: position.top,
        right: position.right,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(20,20,28,0.55)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 6,
        padding: "2px 4px",
        backdropFilter: "blur(2px)",
      }}
    >
      <button
        type="button"
        aria-label="Drag toolbar"
        title="Drag toolbar"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        style={HANDLE_BUTTON_STYLE}
      >
        <GripVertical size={14} />
      </button>
      {children}
      <button
        type="button"
        aria-label={collapseLabel}
        title={collapseLabel}
        onClick={() => setCollapsed(true)}
        style={ICON_BUTTON_STYLE}
      >
        <EyeOff size={13} />
      </button>
    </div>
  );
}

export default FloatingToolbar;
