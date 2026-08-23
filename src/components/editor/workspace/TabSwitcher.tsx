import { useEffect, useRef } from "react";
import { File, PanelBottom } from "lucide-react";

export interface TabSwitcherEntry {
  key: string;
  title: string;
  subtitle: string;
  dirty: boolean;
  active: boolean;
}

/** Open tool window entry sharing the switcher index space (§8.17.5 step 4). */
export interface TabSwitcherToolWindow {
  id: string;
  label: string;
}

interface TabSwitcherProps {
  open: boolean;
  entries: TabSwitcherEntry[];
  /** Rendered below editor entries; indices continue after `entries`. */
  toolWindows?: TabSwitcherToolWindow[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onCommit: (index: number) => void;
  onCancel: () => void;
}

/**
 * IDEA-style Ctrl+Tab Switcher surface (§8.16.5 N2.6).
 * Key handling (hold-to-cycle, release-to-commit, Esc cancel) lives in the
 * workspace tab; this component only renders the MRU list and forwards
 * pointer interactions. Preview (hover) never mutates the MRU order.
 */
export function TabSwitcher({
  open,
  entries,
  toolWindows = [],
  selectedIndex,
  onHover,
  onCommit,
  onCancel,
}: TabSwitcherProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-switcher-selected="true"]')
      ?.scrollIntoView?.({
        block: "nearest",
      });
  }, [open, selectedIndex]);

  if (!open || entries.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switcher"
      data-testid="workspace-tab-switcher"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-[420px] max-w-[80vw] overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] shadow-2xl text-[var(--taomni-code-text)]">
        <div className="border-b border-[var(--taomni-code-border)] px-3 py-1.5 text-[10px] text-[var(--taomni-code-muted)]">
          Switcher · Ctrl/Meta+Tab cycle · release modifier to open · Esc to cancel
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {entries.map((entry, index) => (
            <div
              key={entry.key}
              data-switcher-index={index}
              data-switcher-selected={index === selectedIndex ? "true" : undefined}
              data-testid={`workspace-tab-switcher-item-${entry.key}`}
              className={`flex items-center gap-2 px-3 py-1.5 ${
                index === selectedIndex
                  ? "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-text)]"
                  : "text-[var(--taomni-code-muted)]"
              }`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onCommit(index);
              }}
            >
              <File className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {entry.title}
                {entry.dirty && <span className="ml-1 text-[var(--taomni-accent)]">*</span>}
              </span>
              <span className="max-w-[45%] shrink-0 truncate text-[10px] text-[var(--taomni-code-muted)]">
                {entry.subtitle}
              </span>
            </div>
          ))}
          {toolWindows.length > 0 && (
            <>
              <div className="mt-1 border-t border-[var(--taomni-code-border)] px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-[var(--taomni-code-muted)]">
                Tool Windows
              </div>
              {toolWindows.map((toolWindow, toolIndex) => {
                const index = entries.length + toolIndex;
                return (
                  <div
                    key={`tool:${toolWindow.id}`}
                    data-switcher-index={index}
                    data-switcher-selected={index === selectedIndex ? "true" : undefined}
                    data-testid={`workspace-tab-switcher-tool-${toolWindow.id}`}
                    className={`flex items-center gap-2 px-3 py-1.5 ${
                      index === selectedIndex
                        ? "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-text)]"
                        : "text-[var(--taomni-code-muted)]"
                    }`}
                    onMouseEnter={() => onHover(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onCommit(index);
                    }}
                  >
                    <PanelBottom className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{toolWindow.label}</span>
                    <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">tool window</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
