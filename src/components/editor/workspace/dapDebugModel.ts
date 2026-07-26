/**
 * Pure debug-session model (M9). Argument builders, response parsers, and event
 * reducers for the DAP flow — all side-effect-free so they unit-test without a
 * live adapter. The orchestration hook (useCodeDebugSession) wires these to the
 * kernel commands + events.
 */

/** A user breakpoint on a source line (1-based), with optional D5 extras. */
export interface DebugBreakpoint {
  line: number;
  /** D5: only break when this expression is true. */
  condition?: string;
  /** D5: logpoint — log this message (with `{expr}` interpolation) instead of breaking. */
  logMessage?: string;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  /** Absolute source path, when the frame has one (library frames may not). */
  path: string | null;
  line: number;
  column: number;
}

export interface DebugThread {
  id: number;
  name: string;
}

export type DebugStatus = "starting" | "running" | "stopped" | "terminated";

export interface DebugSessionState {
  sessionId: string;
  status: DebugStatus;
  /** Thread the adapter last stopped on (for stackTrace / stepping). */
  stoppedThreadId: number | null;
  stoppedReason: string | null;
  threads: DebugThread[];
  frames: DebugStackFrame[];
  /** Console/stdout/stderr lines from `output` events. */
  output: string[];
}

export function initialDebugState(sessionId: string): DebugSessionState {
  return {
    sessionId,
    status: "starting",
    stoppedThreadId: null,
    stoppedReason: null,
    threads: [],
    frames: [],
    output: [],
  };
}

/** DAP `stepIn`/`stepOut`/`next`/`continue`/`pause` for a UI step action. */
export type DebugStepAction = "continue" | "pause" | "stepOver" | "stepIn" | "stepOut";

export function stepCommandFor(action: DebugStepAction): string {
  switch (action) {
    case "continue": return "continue";
    case "pause": return "pause";
    case "stepOver": return "next";
    case "stepIn": return "stepIn";
    case "stepOut": return "stepOut";
  }
}
/** Build DAP `setBreakpoints` arguments for one source file. */
export function buildSetBreakpointsArgs(path: string, breakpoints: DebugBreakpoint[]) {
  return {
    source: { path, name: path.split(/[\\/]/).pop() ?? path },
    breakpoints: breakpoints
      .slice()
      .sort((a, b) => a.line - b.line)
      .map((bp) => {
        const entry: Record<string, unknown> = { line: bp.line };
        if (bp.condition && bp.condition.trim()) entry.condition = bp.condition.trim();
        if (bp.logMessage && bp.logMessage.trim()) entry.logMessage = bp.logMessage.trim();
        return entry;
      }),
    // Ask the adapter to re-verify from source lines.
    sourceModified: false,
  };
}

/** Pick exception-breakpoint filters to enable from the adapter's advertised set. */
export function selectExceptionFilters(
  capabilities: Record<string, unknown>,
  enabledIds: string[],
): string[] {
  const filters = capabilities.exceptionBreakpointFilters;
  if (!Array.isArray(filters)) return [];
  const available = new Set(
    filters
      .map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>).filter : null))
      .filter((id): id is string => typeof id === "string"),
  );
  return enabledIds.filter((id) => available.has(id));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Parse a `threads` response body into our thread list. */
export function parseThreads(body: unknown): DebugThread[] {
  const threads = asRecord(body).threads;
  if (!Array.isArray(threads)) return [];
  return threads.flatMap((t) => {
    const rec = asRecord(t);
    return typeof rec.id === "number"
      ? [{ id: rec.id, name: typeof rec.name === "string" ? rec.name : `Thread ${rec.id}` }]
      : [];
  });
}

/** Parse a `stackTrace` response body into frames (source path + line). */
export function parseStackFrames(body: unknown): DebugStackFrame[] {
  const frames = asRecord(body).stackFrames;
  if (!Array.isArray(frames)) return [];
  return frames.flatMap((f) => {
    const rec = asRecord(f);
    if (typeof rec.id !== "number") return [];
    const source = asRecord(rec.source);
    return [{
      id: rec.id,
      name: typeof rec.name === "string" ? rec.name : `frame ${rec.id}`,
      path: typeof source.path === "string" && source.path ? source.path : null,
      line: typeof rec.line === "number" ? rec.line : 0,
      column: typeof rec.column === "number" ? rec.column : 0,
    }];
  });
}

/** The source location to highlight as "current" — the top frame that has a path. */
export function currentLocation(frames: DebugStackFrame[]): { path: string; line: number } | null {
  const frame = frames.find((f) => f.path);
  return frame && frame.path ? { path: frame.path, line: frame.line } : null;
}

/** Reduce an adapter event into new session state (pure). `output` accumulates. */
export function reduceDebugEvent(
  state: DebugSessionState,
  event: string,
  message: unknown,
): DebugSessionState {
  const body = asRecord(asRecord(message).body);
  switch (event) {
    case "stopped": {
      const threadId = typeof body.threadId === "number" ? body.threadId : state.stoppedThreadId;
      return {
        ...state,
        status: "stopped",
        stoppedThreadId: threadId,
        stoppedReason: typeof body.reason === "string" ? body.reason : "stopped",
      };
    }
    case "continued":
      return { ...state, status: "running", stoppedThreadId: null, stoppedReason: null, frames: [] };
    case "terminated":
    case "exited":
      return { ...state, status: "terminated", stoppedThreadId: null, frames: [] };
    case "output": {
      const text = typeof body.output === "string" ? body.output : "";
      if (!text) return state;
      // Cap retained output so a chatty debuggee cannot grow the store unbounded.
      const output = [...state.output, text].slice(-2000);
      return { ...state, output };
    }
    default:
      return state;
  }
}

