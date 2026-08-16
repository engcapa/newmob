import { useState } from "react";
import { Eraser, Trash2 } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import {
  breakpointModesFor,
  parseBreakpointModes,
  resolveBreakpointMode,
} from "../../dapDebugModel";
import { BreakpointsView } from "./BreakpointsView";
import { ExceptionBreakpointsView } from "./ExceptionBreakpointsView";
import { Section, SectionAction } from "./debugPanelShared";

export interface DebugBreakpointsPaneProps {
  debug: CodeDebugSession;
  onOpenBreakpoint?: (path: string, line: number) => void;
  editingBreakpoint?: { path: string; line: number } | null;
  onEditingBreakpointChange?: (target: { path: string; line: number } | null) => void;
  preferredDataBreakpointMode?: string;
  onPreferredDataBreakpointModeChange?: (mode: string) => void;
}

export function DebugBreakpointsPane({
  debug,
  onOpenBreakpoint,
  editingBreakpoint = null,
  onEditingBreakpointChange,
  preferredDataBreakpointMode = "",
  onPreferredDataBreakpointModeChange,
}: DebugBreakpointsPaneProps) {
  const [localMode, setLocalMode] = useState("");
  const currentMode = preferredDataBreakpointMode || localMode;
  const setMode = onPreferredDataBreakpointModeChange ?? setLocalMode;

  const dataBreakpointModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "data");
  const dataBreakpointMode = resolveBreakpointMode(
    currentMode || undefined,
    dataBreakpointModes,
    "data",
  );

  return (
    <div
      data-testid="debug-breakpoints-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px]"
    >
      {/* Breakpoints toolbar */}
      <div className="h-6 shrink-0 flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/40 px-2">
        <span className="font-medium text-[10px] text-[var(--taomni-text-muted)]">
          Manage Breakpoints
        </span>
        <div className="flex items-center gap-1">
          <SectionAction
            testId="debug-mute-breakpoints"
            label={debug.breakpointsMuted ? "Unmute breakpoints" : "Mute breakpoints"}
            active={debug.breakpointsMuted}
            onClick={() => debug.setBreakpointsMuted(!debug.breakpointsMuted)}
          >
            <Eraser className="h-3 w-3" />
          </SectionAction>
          <SectionAction
            testId="debug-remove-all-breakpoints"
            label="Remove all breakpoints"
            onClick={() => debug.removeAllBreakpoints()}
          >
            <Trash2 className="h-3 w-3" />
          </SectionAction>
        </div>
      </div>

      {/* Breakpoints content */}
      <div className="flex-1 min-h-0 overflow-auto">
        <Section
          title="Breakpoints"
          defaultOpen={true}
          forceOpen={!!editingBreakpoint}
        >
          <BreakpointsView
            debug={debug}
            editing={editingBreakpoint}
            setEditing={(target) => onEditingBreakpointChange?.(target)}
            onOpenBreakpoint={onOpenBreakpoint}
            dataBreakpointModes={dataBreakpointModes}
            dataBreakpointMode={dataBreakpointMode}
            onDataBreakpointModeChange={setMode}
          />
        </Section>

        {debug.availableExceptionFilters.length > 0 && (
          <Section title="Exception Breakpoints" defaultOpen={true}>
            <ExceptionBreakpointsView debug={debug} />
          </Section>
        )}
      </div>
    </div>
  );
}
