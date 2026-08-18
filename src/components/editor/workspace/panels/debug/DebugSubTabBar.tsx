import type { ReactNode } from "react";
import { Bug, Terminal, CircleDot, Cpu } from "lucide-react";
import type { DebugSubTabId } from "../../../../../stores/codeWorkspaceStore";

export interface DebugSubTabBarProps {
  activeTab: DebugSubTabId;
  onTabChange: (tab: DebugSubTabId) => void;
  /** Badges for sub tabs, e.g. unread counts or number of items */
  badges?: Partial<Record<DebugSubTabId, number | string>>;
  statusText?: string | null;
  trailing?: ReactNode;
}

interface SubTabDefinition {
  id: DebugSubTabId;
  label: string;
  icon: typeof Bug;
  testId: string;
}

const SUB_TABS: SubTabDefinition[] = [
  { id: "debugger", label: "Debugger", icon: Bug, testId: "debug-subtab-debugger" },
  { id: "console", label: "Console", icon: Terminal, testId: "debug-subtab-console" },
  { id: "breakpoints", label: "Breakpoints", icon: CircleDot, testId: "debug-subtab-breakpoints" },
  { id: "memory", label: "Memory", icon: Cpu, testId: "debug-subtab-memory" },
];

export function DebugSubTabBar({
  activeTab,
  onTabChange,
  badges,
  statusText,
  trailing,
}: DebugSubTabBarProps) {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex = -1;
    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % SUB_TABS.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = (index - 1 + SUB_TABS.length) % SUB_TABS.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = SUB_TABS.length - 1;
    }

    if (nextIndex >= 0) {
      e.preventDefault();
      const nextTab = SUB_TABS[nextIndex];
      if (nextTab) {
        onTabChange(nextTab.id);
        const el = document.querySelector<HTMLButtonElement>(`[data-testid="${nextTab.testId}"]`);
        el?.focus();
      }
    }
  };

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      data-testid="debug-sub-tab-bar"
      className="h-6 shrink-0 flex items-center border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-1.5 text-[10px] select-none"
    >
      <div className="flex items-center gap-0.5" role="presentation">
        {SUB_TABS.map((tab, index) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          const badge = badges?.[tab.id];
          return (
            <button
              key={tab.id}
              id={`debug-subtab-${tab.id}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`debug-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              type="button"
              data-testid={tab.testId}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`h-5 px-2 rounded-t flex items-center gap-1.5 font-medium transition-colors ${
                isActive
                  ? "bg-[var(--taomni-code-bg)] text-[var(--taomni-text)] shadow-2xs border-b-2 border-b-[var(--taomni-accent)]"
                  : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover-bg)]"
              }`}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span>{tab.label}</span>
              {badge !== undefined && (
                <span
                  data-testid={`${tab.testId}-badge`}
                  className="rounded-full bg-[var(--taomni-code-border)] px-1 text-[9px] font-mono text-[var(--taomni-text-muted)]"
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {statusText && (
        <span className="ml-2 text-[10px] text-[var(--taomni-text-muted)] truncate">
          {statusText}
        </span>
      )}
      {trailing && <div className="ml-auto flex items-center gap-1">{trailing}</div>}
    </div>
  );
}
