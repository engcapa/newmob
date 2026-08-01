import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface BottomDockTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  content: ReactNode;
}

interface BottomDockProps {
  open: boolean;
  activeTab: string;
  tabs: BottomDockTab[];
  onOpenChange: (open: boolean) => void;
  onActiveTabChange: (tabId: string) => void;
  /** Controlled height in px; when omitted, dock manages its own persisted height. */
  height?: number;
  onHeightChange?: (height: number) => void;
}

export const BOTTOM_DOCK_MIN_HEIGHT = 120;
export const BOTTOM_DOCK_MAX_HEIGHT = 640;
export const BOTTOM_DOCK_DEFAULT_HEIGHT = 192;
const BOTTOM_DOCK_HEIGHT_KEY = "taomni.codeWorkspace.bottomDockHeight.v1";

function clampHeight(value: number): number {
  return Math.max(BOTTOM_DOCK_MIN_HEIGHT, Math.min(BOTTOM_DOCK_MAX_HEIGHT, Math.round(value)));
}

function readStoredHeight(): number {
  try {
    const raw = window.localStorage.getItem(BOTTOM_DOCK_HEIGHT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) return clampHeight(parsed);
  } catch {
    // Ignore storage failures.
  }
  return BOTTOM_DOCK_DEFAULT_HEIGHT;
}

function writeStoredHeight(height: number): void {
  try {
    window.localStorage.setItem(BOTTOM_DOCK_HEIGHT_KEY, String(clampHeight(height)));
  } catch {
    // Ignore storage failures.
  }
}

export function BottomDock({
  open,
  activeTab,
  tabs,
  onOpenChange,
  onActiveTabChange,
  height: controlledHeight,
  onHeightChange,
}: BottomDockProps) {
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const [uncontrolledHeight, setUncontrolledHeight] = useState(readStoredHeight);
  const height = controlledHeight ?? uncontrolledHeight;
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const setHeight = useCallback((next: number) => {
    const clamped = clampHeight(next);
    if (onHeightChange) onHeightChange(clamped);
    else {
      setUncontrolledHeight(clamped);
      writeStoredHeight(clamped);
    }
  }, [onHeightChange]);

  useEffect(() => {
    if (controlledHeight != null) return;
    writeStoredHeight(uncontrolledHeight);
  }, [controlledHeight, uncontrolledHeight]);

  const selectTab = (tabId: string) => {
    if (open && tabId === active?.id) {
      onOpenChange(false);
      return;
    }
    onActiveTabChange(tabId);
    onOpenChange(true);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!open) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: height };

    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Dragging the top handle upward increases height.
      const delta = drag.startY - moveEvent.clientY;
      setHeight(drag.startHeight + delta);
    };
    const onUp = (upEvent: PointerEvent) => {
      dragRef.current = null;
      target.releasePointerCapture?.(upEvent.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section
      data-testid="code-workspace-bottom-dock"
      data-open={open || undefined}
      className="shrink-0 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
    >
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize bottom panel"
          data-testid="code-workspace-bottom-dock-resize"
          className="h-1.5 cursor-row-resize bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors"
          onPointerDown={onResizePointerDown}
        />
      )}
      <div className="h-8 flex items-center gap-0.5 overflow-x-auto px-1">
        {tabs.map((tab) => {
          const selected = tab.id === active?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid={`code-workspace-bottom-tab-${tab.id}`}
              aria-selected={selected && open}
              data-active={(selected && open) || undefined}
              className="h-7 shrink-0 inline-flex items-center gap-1.5 rounded px-2 text-[11px] font-medium text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              onClick={() => selectTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {(typeof tab.badge === "number" ? tab.badge > 0 : !!tab.badge) && (
                <span className="min-w-4 rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-center text-[10px] tabular-nums text-[var(--taomni-code-text)]">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        {active && (
          <button
            type="button"
            title={open ? "Collapse bottom panel" : "Expand bottom panel"}
            aria-label={open ? "Collapse bottom panel" : "Expand bottom panel"}
            className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => onOpenChange(!open)}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      {/* Keep every panel mounted so stateful tools (search, terminals)
          survive tab switches and dock collapse; hide inactive ones. */}
      <div
        hidden={!open || !active}
        data-testid="code-workspace-bottom-dock-body"
        className="min-h-0 overflow-hidden border-t border-[var(--taomni-code-border)]"
        style={{ height: open ? height : 0 }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={tab.label}
            hidden={tab.id !== active?.id}
            className="h-full min-h-0"
          >
            {tab.content}
          </div>
        ))}
      </div>
    </section>
  );
}
