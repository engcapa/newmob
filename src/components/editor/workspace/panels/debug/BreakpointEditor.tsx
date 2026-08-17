import {
  resolveBreakpointMode,
  type DebugBreakpoint,
  type DebugBreakpointMode,
} from "../../dapDebugModel";
import { CommitField } from "./debugPanelShared";

export interface BreakpointEditorProps {
  breakpoint: DebugBreakpoint;
  adapterId: string | null;
  modes: DebugBreakpointMode[];
  onChange: (options: Partial<DebugBreakpoint>) => void;
  onModeChange: (mode: string) => void;
}

/** The condition / hit count / log message fields for one breakpoint. */
export function BreakpointEditor({
  breakpoint,
  adapterId,
  modes,
  onChange,
  onModeChange,
}: BreakpointEditorProps) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  // Committed on blur / Enter so every keystroke does not re-push to the adapter.
  const commit = (key: "condition" | "hitCondition" | "logMessage") => (value: string) => {
    onChange({ [key]: value.trim() || undefined });
  };
  const mode = adapterId
    ? resolveBreakpointMode(breakpoint.adapterModes?.[adapterId], modes, "source")
    : undefined;
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      {adapterId && modes.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[var(--taomni-text-muted)]">Mode</span>
          <select
            data-testid={`debug-breakpoint-mode-${breakpoint.line}`}
            aria-label={`Breakpoint mode at line ${breakpoint.line}`}
            title={modes.find((entry) => entry.mode === mode)?.description}
            className="h-5 min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 text-[11px] outline-none"
            value={mode ?? modes[0].mode}
            onChange={(event) => onModeChange(event.target.value)}
          >
            {modes.map((entry) => (
              <option key={entry.mode} value={entry.mode}>{entry.label}</option>
            ))}
          </select>
        </label>
      )}
      <CommitField
        label="Condition"
        testId={`debug-breakpoint-condition-${breakpoint.line}`}
        className={field}
        placeholder="break only when true, e.g. i > 10"
        initialValue={breakpoint.condition ?? ""}
        onCommit={commit("condition")}
      />
      <CommitField
        label="Hit count"
        testId={`debug-breakpoint-hit-${breakpoint.line}`}
        className={field}
        placeholder="e.g. 5 — break on the 5th hit"
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={commit("hitCondition")}
      />
      <CommitField
        label="Log message"
        testId={`debug-breakpoint-log-${breakpoint.line}`}
        className={field}
        placeholder="log instead of breaking; {expr} interpolates"
        initialValue={breakpoint.logMessage ?? ""}
        onCommit={commit("logMessage")}
      />
    </div>
  );
}
