import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  CirclePlay,
  FlameKindling,
  Pause,
  RotateCcw,
  Square,
} from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";

export interface DebugSessionControlsProps {
  debug: CodeDebugSession;
  activeRunning: boolean;
  stopped: boolean;
}

const verticalBtn =
  "h-6 w-6 inline-flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:pointer-events-none";

const stepBtn =
  "h-6 px-1.5 inline-flex items-center gap-1 rounded text-[10px] font-medium transition-colors disabled:opacity-30 disabled:pointer-events-none hover:bg-[var(--taomni-hover-bg)]";

/**
 * 竖排：Resume/Pause/Stop/Restart/HotReload — 放在左栏最左侧。
 *
 * Start/Attach live in the top configuration bar (rendered whenever no
 * session is live). Rendering them here too would duplicate their
 * data-testids once a terminated session still has state, so the vertical
 * strip only owns in-session controls and simply disables them when the
 * session is not running.
 */
export function DebugSessionControls({
  debug,
  activeRunning,
  stopped,
}: DebugSessionControlsProps) {
  return (
    <div
      data-testid="debug-session-controls"
      className="w-8 shrink-0 flex flex-col items-center py-1.5 gap-1 border-r border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/40"
    >
      <button
        type="button"
        data-testid="debug-continue"
        className={`${verticalBtn} hover:bg-emerald-500/15`}
        onClick={() => debug.step("continue")}
        disabled={!stopped}
        title="Resume Program"
      >
        <CirclePlay className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
      </button>
      <button
        type="button"
        data-testid="debug-pause"
        className={`${verticalBtn} hover:bg-amber-500/15`}
        onClick={() => debug.step("pause")}
        disabled={!activeRunning || stopped}
        title="Pause Program"
      >
        <Pause className="h-4 w-4 text-amber-500 dark:text-amber-400" />
      </button>
      <button
        type="button"
        data-testid="debug-stop"
        className={`${verticalBtn} hover:bg-rose-500/15`}
        onClick={() => debug.terminate()}
        disabled={!activeRunning}
        title="Stop"
      >
        <Square className="h-4 w-4 text-rose-500 dark:text-rose-400" />
      </button>
      {/* Restart only for a live session: once terminated, the top
          configuration bar owns the restart/rerun action, and rendering a
          second one here would duplicate its data-testid. */}
      {activeRunning && (
        <button
          type="button"
          data-testid="debug-restart"
          className={`${verticalBtn} hover:bg-emerald-500/15`}
          onClick={() => debug.restart()}
          title="Restart the debug session"
        >
          <RotateCcw className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
        </button>
      )}
      <button
        type="button"
        data-testid="debug-hot-reload"
        className={`${verticalBtn} hover:bg-orange-500/15`}
        onClick={() => debug.hotReload()}
        disabled={!activeRunning}
        title="Hot reload changed classes"
      >
        <FlameKindling className="h-4 w-4 text-orange-500 dark:text-orange-400" />
      </button>
    </div>
  );
}

export interface DebugStepControlsProps {
  debug: CodeDebugSession;
  stopped: boolean;
}

/** 横排：StepOver/StepInto/StepOut — 放在帧区上方或底部 */
export function DebugStepControls({ debug, stopped }: DebugStepControlsProps) {
  return (
    <div
      data-testid="debug-step-controls"
      className="flex items-center gap-1 px-2 py-1 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/30 shrink-0"
    >
      <button
        type="button"
        data-testid="debug-step-over"
        className={stepBtn}
        onClick={() => debug.step("stepOver")}
        disabled={!stopped}
        title="Step Over"
      >
        <ArrowRightToLine className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
        <span>Step Over</span>
      </button>
      <button
        type="button"
        data-testid="debug-step-in"
        className={stepBtn}
        onClick={() => debug.step("stepIn")}
        disabled={!stopped}
        title="Step Into"
      >
        <ArrowDownToLine className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
        <span>Into</span>
      </button>
      <button
        type="button"
        data-testid="debug-step-out"
        className={stepBtn}
        onClick={() => debug.step("stepOut")}
        disabled={!stopped}
        title="Step Out"
      >
        <ArrowUpFromLine className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400" />
        <span>Out</span>
      </button>
    </div>
  );
}
