/**
 * Pure debug-session model (M9). Argument builders, response parsers, and event
 * reducers for the DAP flow — all side-effect-free so they unit-test without a
 * live adapter. The orchestration hook (useCodeDebugSession) wires these to the
 * kernel commands + events. Everything here is DAP-standard and language-agnostic;
 * language-specific behavior stays in the Rust adapters.
 */

/** A user breakpoint on a source line (1-based), with optional D5 extras. */
export interface DebugBreakpoint {
  line: number;
  /** D5: only break when this expression is true. */
  condition?: string;
  /** Break only when the hit count matches (DAP `hitCondition`, e.g. "5"). */
  hitCondition?: string;
  /** D5: logpoint — log this message (with `{expr}` interpolation) instead of breaking. */
  logMessage?: string;
  /**
   * IDEA-style disable: the breakpoint stays in the list and the gutter but is
   * not sent to the adapter. `undefined` means enabled (breakpoints persisted
   * before this field existed stay armed).
   */
  enabled?: boolean;
  /** Adapter-specific source-breakpoint mode ids (for example hardware/software). */
  adapterModes?: Record<string, string>;
}

/** A DAP function/method breakpoint, independent of any source path. */
export interface DebugFunctionBreakpoint {
  name: string;
  condition?: string;
  hitCondition?: string;
  /** Undefined means enabled, matching source-breakpoint persistence. */
  enabled?: boolean;
}

/** A DAP instruction breakpoint scoped to the adapter that owns the reference. */
export interface DebugInstructionBreakpoint {
  adapterId: string;
  /** Opaque instruction/memory reference supplied by the adapter or user. */
  instructionReference: string;
  /** Signed byte offset from `instructionReference`. */
  offset?: number;
  condition?: string;
  hitCondition?: string;
  /** Adapter-advertised instruction breakpoint mode. */
  mode?: string;
  /** Undefined means enabled, matching every other persisted breakpoint type. */
  enabled?: boolean;
}

export type DebugDataBreakpointAccessType = "read" | "write" | "readWrite";

export type DebugBreakpointModeApplicability =
  | "source"
  | "exception"
  | "data"
  | "instruction"
  | (string & {});

/** One breakpoint mode advertised by the adapter's initialize response. */
export interface DebugBreakpointMode {
  mode: string;
  label: string;
  description?: string;
  appliesTo: DebugBreakpointModeApplicability[];
}

/**
 * A DAP data breakpoint/watchpoint. Persistent data ids are scoped to one
 * adapter; non-persistent ids are scoped to the suspended session that issued
 * `dataBreakpointInfo` and are never written to workspace storage.
 */
export interface DebugDataBreakpoint {
  dataId: string;
  description: string;
  adapterId: string;
  accessTypes: DebugDataBreakpointAccessType[];
  accessType?: DebugDataBreakpointAccessType;
  condition?: string;
  hitCondition?: string;
  /** Number of bytes covered by the data id when the adapter supports ranges. */
  bytes?: number;
  /** Whether the discovery name was interpreted as a decimal/hex address. */
  asAddress?: boolean;
  /** Mode used when resolving this adapter-owned data id. */
  mode?: string;
  enabled?: boolean;
  canPersist: boolean;
  sessionId?: string;
}

export interface DebugDataBreakpointTarget {
  name: string;
  variablesReference?: number;
  frameId?: number;
  /** Optional range size, sent only with supportsDataBreakpointBytes. */
  bytes?: number;
  /** Interpret name as a decimal/hex memory address. */
  asAddress?: boolean;
  /** Sent only in the capability-gated `dataBreakpointInfo` request. */
  mode?: string;
}

export interface DebugDataBreakpointInfo {
  dataId: string | null;
  description: string;
  accessTypes: DebugDataBreakpointAccessType[];
  canPersist: boolean;
}

/** One exception filter advertised by the adapter's initialize response. */
export interface DebugExceptionBreakpointFilter {
  filter: string;
  label: string;
  description?: string;
  default: boolean;
  supportsCondition: boolean;
  conditionDescription?: string;
}

/** Workspace-persisted exception-breakpoint choice, scoped to one adapter. */
export interface DebugExceptionBreakpoint {
  adapterId: string;
  filterId: string;
  enabled: boolean;
  condition?: string;
  /** Adapter-advertised mode sent through `ExceptionFilterOptions`. */
  mode?: string;
}

export type DebugExceptionBreakMode = "never" | "always" | "unhandled" | "userUnhandled";

/** One segment in the adapter-defined DAP exception tree. */
export interface DebugExceptionPathSegment {
  names: string[];
  negate?: boolean;
}

/**
 * A user-defined exception class/package rule sent through DAP
 * `exceptionOptions`. Rules are persisted per workspace and adapter because
 * exception-tree names and wildcard syntax are adapter-specific.
 */
export interface DebugExceptionBreakpointRule {
  id: string;
  adapterId: string;
  path: DebugExceptionPathSegment[];
  breakMode: DebugExceptionBreakMode;
  enabled: boolean;
}

/** True unless the breakpoint was explicitly disabled. */
export function isBreakpointEnabled(bp: DebugBreakpoint): boolean {
  return bp.enabled !== false;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  /** Absolute source path, when the frame has one (library frames may not). */
  path: string | null;
  line: number;
  column: number;
  /**
   * Non-zero when the source is not a file the client can read and must be
   * fetched with the DAP `source` request — library / decompiled frames
   * (java-debug hands back attached or decompiled sources this way).
   */
  sourceReference: number;
  /** Display name from the adapter (`String.java`), for a library buffer's tab. */
  sourceName: string | null;
}

export interface DebugThread {
  id: number;
  name: string;
}

export type DebugStatus = "starting" | "running" | "stopped" | "terminated";

/** One console line: a debuggee `output` event or a client-side REPL echo. */
export interface DebugConsoleLine {
  /** DAP output category (`stdout`/`stderr`/`console`…) or client-side `repl`/`result`. */
  category: string;
  text: string;
}

/** Parsed `exceptionInfo` response (shown when stopped on an exception). */
export interface DebugExceptionInfo {
  exceptionId: string;
  description: string;
  /** Full stack trace text when the adapter provides one. */
  details: string | null;
}

/** Result of `evaluate` (and `setVariable`): display value + expandable ref. */
export interface EvaluateResult {
  value: string;
  /** Non-zero when the value is structured and expandable via `variables`. */
  variablesReference: number;
  type: string | null;
}

/** DAP `readMemory` request. Memory references are opaque adapter strings. */
export interface DebugMemoryReadRequest {
  memoryReference: string;
  offset?: number;
  count: number;
}

/** Bounded result of a DAP `readMemory` response. `data` remains base64. */
export interface DebugMemoryReadResult {
  address: string | null;
  unreadableBytes: number;
  data: string;
}

/** DAP `writeMemory` request. `data` is base64 as required by the protocol. */
export interface DebugMemoryWriteRequest {
  memoryReference: string;
  offset?: number;
  data: string;
  allowPartial?: boolean;
}

/** Result of a DAP `writeMemory` request. */
export interface DebugMemoryWriteResult {
  bytesWritten: number | null;
}

/** DAP `disassemble` request. All offsets are signed byte/instruction offsets. */
export interface DebugDisassembleRequest {
  memoryReference: string;
  offset?: number;
  instructionOffset?: number;
  instructionCount: number;
  resolveSymbols?: boolean;
}

/** Source location attached to a disassembled instruction, when available. */
export interface DebugDisassemblyLocation {
  path: string | null;
  name: string | null;
  sourceReference: number | null;
}

/** Bounded DAP `DisassembledInstruction` projection for the memory view. */
export interface DebugDisassembledInstruction {
  address: string;
  instruction: string;
  instructionBytes: string | null;
  symbol: string | null;
  location: DebugDisassemblyLocation | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
}

export interface DebugSessionState {
  sessionId: string;
  status: DebugStatus;
  /** Thread the adapter last stopped on (for stackTrace / stepping). */
  stoppedThreadId: number | null;
  stoppedReason: string | null;
  threads: DebugThread[];
  frames: DebugStackFrame[];
  /** Thread whose stack is displayed (defaults to the stopped thread). */
  selectedThreadId: number | null;
  /** Frame that variables / watches / evaluate target (defaults to the top frame). */
  selectedFrameId: number | null;
  /** Populated via `exceptionInfo` when stopped on an exception. */
  exceptionInfo: DebugExceptionInfo | null;
  /** Console lines from `output` events + client-side REPL echoes. */
  output: DebugConsoleLine[];
}

export function initialDebugState(sessionId: string): DebugSessionState {
  return {
    sessionId,
    status: "starting",
    stoppedThreadId: null,
    stoppedReason: null,
    threads: [],
    frames: [],
    selectedThreadId: null,
    selectedFrameId: null,
    exceptionInfo: null,
    output: [],
  };
}

/**
 * State transition when the debuggee resumes. Also applied optimistically after
 * a successful continue/step response: adapters are not required to emit a
 * `continued` event for explicit resumes, so waiting for one leaves the UI
 * frozen on a stale stack.
 */
export function markResumed(state: DebugSessionState): DebugSessionState {
  return {
    ...state,
    status: "running",
    stoppedThreadId: null,
    stoppedReason: null,
    frames: [],
    selectedThreadId: null,
    selectedFrameId: null,
    exceptionInfo: null,
  };
}

/** Cap retained console lines so a chatty debuggee cannot grow the store unbounded. */
const MAX_CONSOLE_LINES = 2000;

/** Append a console line (no-op for empty text). */
export function appendConsoleLine(
  state: DebugSessionState,
  category: string,
  text: string,
): DebugSessionState {
  if (!text) return state;
  return { ...state, output: [...state.output, { category, text }].slice(-MAX_CONSOLE_LINES) };
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

const MAX_MEMORY_REFERENCE_LENGTH = 4096;
const MAX_MEMORY_READ_BYTES = 65536;
const MAX_DISASSEMBLY_INSTRUCTIONS = 4096;
const MAX_MEMORY_DATA_LENGTH = 131072;

/** Build a standard DAP `readMemory` request. */
export function buildReadMemoryArgs(request: DebugMemoryReadRequest) {
  const args: {
    memoryReference: string;
    offset?: number;
    count: number;
  } = {
    memoryReference: request.memoryReference.trim().slice(0, MAX_MEMORY_REFERENCE_LENGTH),
    count: request.count,
  };
  if (request.offset !== undefined) args.offset = request.offset;
  return args;
}

/** Parse a DAP `readMemory` response without trusting adapter field types. */
export function parseReadMemoryResponse(body: unknown): DebugMemoryReadResult {
  const rec = asRecord(body);
  const unreadableBytes = typeof rec.unreadableBytes === "number"
    && Number.isSafeInteger(rec.unreadableBytes)
    && rec.unreadableBytes >= 0
    ? Math.min(rec.unreadableBytes, MAX_MEMORY_READ_BYTES)
    : 0;
  return {
    address: typeof rec.address === "string" && rec.address
      ? rec.address.slice(0, MAX_MEMORY_REFERENCE_LENGTH)
      : null,
    unreadableBytes,
    data: typeof rec.data === "string" ? rec.data.slice(0, MAX_MEMORY_DATA_LENGTH) : "",
  };
}

/** Build a standard DAP `writeMemory` request. */
export function buildWriteMemoryArgs(request: DebugMemoryWriteRequest) {
  const args: {
    memoryReference: string;
    offset?: number;
    data: string;
    allowPartial?: boolean;
  } = {
    memoryReference: request.memoryReference.trim().slice(0, MAX_MEMORY_REFERENCE_LENGTH),
    data: request.data.slice(0, MAX_MEMORY_DATA_LENGTH),
  };
  if (request.offset !== undefined) args.offset = request.offset;
  if (request.allowPartial !== undefined) args.allowPartial = request.allowPartial;
  return args;
}

/** Parse a DAP `writeMemory` response. */
export function parseWriteMemoryResponse(body: unknown): DebugMemoryWriteResult {
  const bytesWritten = asRecord(body).bytesWritten;
  return {
    bytesWritten: typeof bytesWritten === "number"
      && Number.isSafeInteger(bytesWritten)
      && bytesWritten >= 0
      ? Math.min(bytesWritten, MAX_MEMORY_READ_BYTES)
      : null,
  };
}

/** Build a standard DAP `disassemble` request. */
export function buildDisassembleArgs(request: DebugDisassembleRequest) {
  const args: {
    memoryReference: string;
    offset?: number;
    instructionOffset?: number;
    instructionCount: number;
    resolveSymbols?: boolean;
  } = {
    memoryReference: request.memoryReference.trim().slice(0, MAX_MEMORY_REFERENCE_LENGTH),
    instructionCount: request.instructionCount,
  };
  if (request.offset !== undefined) args.offset = request.offset;
  if (request.instructionOffset !== undefined) args.instructionOffset = request.instructionOffset;
  if (request.resolveSymbols !== undefined) args.resolveSymbols = request.resolveSymbols;
  return args;
}

/** Parse and bound a DAP `disassemble` response. */
export function parseDisassembleResponse(body: unknown): DebugDisassembledInstruction[] {
  const instructions = asRecord(body).instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions.slice(0, MAX_DISASSEMBLY_INSTRUCTIONS).flatMap((value) => {
    const rec = asRecord(value);
    if (typeof rec.address !== "string" || !rec.address.trim()) return [];
    const source = asRecord(rec.location);
    const location = Object.keys(source).length > 0
      ? {
          path: typeof source.path === "string" && source.path ? source.path.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
          name: typeof source.name === "string" && source.name ? source.name.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
          sourceReference: typeof source.sourceReference === "number"
            && Number.isSafeInteger(source.sourceReference)
            && source.sourceReference > 0
            ? source.sourceReference
            : null,
        }
      : null;
    return [{
      address: rec.address.slice(0, MAX_MEMORY_REFERENCE_LENGTH),
      instruction: typeof rec.instruction === "string" ? rec.instruction.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : "",
      instructionBytes: typeof rec.instructionBytes === "string" ? rec.instructionBytes.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
      symbol: typeof rec.symbol === "string" && rec.symbol ? rec.symbol.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
      location,
      line: typeof rec.line === "number" && rec.line > 0 ? rec.line : null,
      column: typeof rec.column === "number" && rec.column > 0 ? rec.column : null,
      endLine: typeof rec.endLine === "number" && rec.endLine > 0 ? rec.endLine : null,
      endColumn: typeof rec.endColumn === "number" && rec.endColumn > 0 ? rec.endColumn : null,
    }];
  });
}

/** Decode DAP base64 memory into a compact, readable hexadecimal string. */
export function decodeMemoryData(data: string): string {
  if (!data) return "";
  try {
    const binary = globalThis.atob(data);
    return Array.from(binary, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  } catch {
    return "";
  }
}

/** Encode user-entered hexadecimal bytes into DAP base64. Returns null on invalid input. */
export function encodeMemoryData(value: string): string | null {
  const source = value.trim();
  if (!source) return null;
  const tokens = source.split(/[\s,]+/).filter(Boolean);
  const compact = tokens.length === 1 ? tokens[0].replace(/^0x/i, "") : "";
  const bytes = compact && /^(?:[0-9a-f]{2})+$/i.test(compact)
    ? compact.match(/[0-9a-f]{2}/gi) ?? []
    : tokens.map((token) => token.replace(/^0x/i, ""));
  if (bytes.some((token) => !/^(?:[0-9a-f]{2})$/i.test(token))) return null;
  if (bytes.length === 0 || bytes.length > MAX_MEMORY_READ_BYTES) return null;
  const binary = bytes.map((token) => String.fromCharCode(Number.parseInt(token, 16))).join("");
  try {
    return globalThis.btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Normalize a source path to the OS-native form the debug adapter expects.
 * On Windows, java-debug matches breakpoint source paths against JDT's records,
 * which use a lowercase drive letter and backslashes — a forward-slash /
 * uppercase-drive path (our internal normalized form) leaves breakpoints
 * `verified: false` and they never bind. Detected by a `X:` drive prefix, so
 * POSIX absolute paths (`/…`) are returned unchanged.
 */
export function toAdapterSourcePath(path: string): string {
  if (!/^[A-Za-z]:/.test(path)) return path; // not a Windows drive path
  return path
    .replace(/^([A-Za-z]):/, (_m, drive) => `${drive.toLowerCase()}:`)
    .replace(/\//g, "\\");
}

/** Breakpoints in the exact order sent to the adapter (sorted by line). */
export function sortedBreakpoints(list: DebugBreakpoint[]): DebugBreakpoint[] {
  return list.slice().sort((a, b) => a.line - b.line);
}

/**
 * What one `setBreakpoints` call for a file will send. DAP has no "disabled"
 * flag on a breakpoint, so disabled (and, when breakpoints are muted, all)
 * entries are simply left out of the request while staying in the stored list —
 * `indexes` maps each sent entry back to its slot in `sorted` so the positional
 * response can be applied to the right stored breakpoint.
 */
export interface BreakpointSyncPlan {
  /** The full stored set for the file, sorted by line. */
  sorted: DebugBreakpoint[];
  /** The subset actually sent, in request order. */
  sent: DebugBreakpoint[];
  /** `sent[k]` is `sorted[indexes[k]]`; -1 for a transient (run-to-cursor) entry. */
  indexes: number[];
}

/**
 * Decide which of a file's breakpoints go to the adapter.
 * `muted` suppresses all of them (IDEA "Mute Breakpoints"); `extraLine` adds a
 * transient run-to-cursor breakpoint that is never stored.
 */
export function planBreakpointSync(
  list: DebugBreakpoint[],
  options: { muted?: boolean; extraLine?: number } = {},
): BreakpointSyncPlan {
  const sorted = sortedBreakpoints(list);
  const sent: DebugBreakpoint[] = [];
  const indexes: number[] = [];
  if (!options.muted) {
    sorted.forEach((bp, index) => {
      if (!isBreakpointEnabled(bp)) return;
      sent.push(bp);
      indexes.push(index);
    });
  }
  const extra = options.extraLine;
  if (extra != null && !sent.some((bp) => bp.line === extra)) {
    // Keep the request sorted by line, as the response corresponds positionally.
    const at = sent.findIndex((bp) => bp.line > extra);
    const insertAt = at === -1 ? sent.length : at;
    sent.splice(insertAt, 0, { line: extra });
    indexes.splice(insertAt, 0, -1);
  }
  return { sorted, sent, indexes };
}

export interface FunctionBreakpointSyncPlan {
  /** Full persisted set, sorted deterministically by function name. */
  sorted: DebugFunctionBreakpoint[];
  /** Enabled entries sent to an adapter that supports function breakpoints. */
  sent: DebugFunctionBreakpoint[];
}

/** Decide which function breakpoints are armed for one adapter session. */
export function planFunctionBreakpointSync(
  list: DebugFunctionBreakpoint[],
  options: { muted?: boolean } = {},
): FunctionBreakpointSyncPlan {
  const sorted = list.slice().sort((left, right) => compareText(left.name, right.name));
  return {
    sorted,
    sent: options.muted ? [] : sorted.filter((breakpoint) => breakpoint.enabled !== false),
  };
}

/** Build standard DAP `setFunctionBreakpoints` request arguments. */
export function buildSetFunctionBreakpointsArgs(plan: FunctionBreakpointSyncPlan) {
  return {
    breakpoints: plan.sent.map((breakpoint) => {
      const entry: Record<string, unknown> = { name: breakpoint.name };
      if (breakpoint.condition?.trim()) entry.condition = breakpoint.condition.trim();
      if (breakpoint.hitCondition?.trim()) entry.hitCondition = breakpoint.hitCondition.trim();
      return entry;
    }),
  };
}

/** Stable identity for one adapter-owned instruction location. */
export function instructionBreakpointKey(
  breakpoint: Pick<DebugInstructionBreakpoint, "adapterId" | "instructionReference" | "offset">,
): string {
  return JSON.stringify([
    breakpoint.adapterId,
    breakpoint.instructionReference,
    breakpoint.offset ?? 0,
  ]);
}

export interface InstructionBreakpointSyncPlan {
  /** Full persisted set, sorted deterministically across adapters. */
  sorted: DebugInstructionBreakpoint[];
  /** Entries owned by the selected adapter, including disabled ones. */
  applicable: DebugInstructionBreakpoint[];
  /** Enabled and unmuted entries sent in request order. */
  sent: DebugInstructionBreakpoint[];
}

/** Scope instruction references to their adapter and apply global muting. */
export function planInstructionBreakpointSync(
  list: DebugInstructionBreakpoint[],
  context: { adapterId: string; muted?: boolean },
): InstructionBreakpointSyncPlan {
  const sorted = list.slice().sort((left, right) => (
    compareText(left.adapterId, right.adapterId)
    || compareText(left.instructionReference, right.instructionReference)
    || (left.offset ?? 0) - (right.offset ?? 0)
  ));
  const applicable = sorted.filter((breakpoint) => breakpoint.adapterId === context.adapterId);
  return {
    sorted,
    applicable,
    sent: context.muted
      ? []
      : applicable.filter((breakpoint) => breakpoint.enabled !== false),
  };
}

/** Build the replacing DAP `setInstructionBreakpoints` request. */
export function buildSetInstructionBreakpointsArgs(
  plan: InstructionBreakpointSyncPlan,
  breakpointModes: readonly DebugBreakpointMode[] = [],
) {
  return {
    breakpoints: plan.sent.map((breakpoint) => {
      const entry: Record<string, unknown> = {
        instructionReference: breakpoint.instructionReference,
      };
      if (breakpoint.offset !== undefined) entry.offset = breakpoint.offset;
      if (breakpoint.condition?.trim()) entry.condition = breakpoint.condition.trim();
      if (breakpoint.hitCondition?.trim()) entry.hitCondition = breakpoint.hitCondition.trim();
      const mode = resolveBreakpointMode(breakpoint.mode, breakpointModes, "instruction");
      if (mode) entry.mode = mode;
      return entry;
    }),
  };
}

/** Parse, de-duplicate, and merge DAP breakpoint-mode capability metadata. */
export function parseBreakpointModes(
  capabilities: Record<string, unknown>,
): DebugBreakpointMode[] {
  const advertised = capabilities.breakpointModes;
  if (!Array.isArray(advertised)) return [];
  const out: DebugBreakpointMode[] = [];
  const byId = new Map<string, DebugBreakpointMode>();
  for (const value of advertised) {
    const raw = asRecord(value);
    const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
    if (!mode || mode.length > 1024 || !Array.isArray(raw.appliesTo)) continue;
    const appliesTo = Array.from(new Set(raw.appliesTo.flatMap((entry) => (
      typeof entry === "string" && entry.trim() && entry.length <= 128
        ? [entry.trim() as DebugBreakpointModeApplicability]
        : []
    ))));
    if (appliesTo.length === 0) continue;
    const existing = byId.get(mode);
    if (existing) {
      existing.appliesTo = Array.from(new Set([...existing.appliesTo, ...appliesTo]));
      continue;
    }
    const label = typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim().slice(0, 1024)
      : mode;
    const parsed: DebugBreakpointMode = {
      mode,
      label,
      description: typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim().slice(0, 4096)
        : undefined,
      appliesTo,
    };
    byId.set(mode, parsed);
    out.push(parsed);
  }
  return out;
}

/** Modes in adapter order; the first is the protocol-recommended UI default. */
export function breakpointModesFor(
  modes: readonly DebugBreakpointMode[],
  applicability: DebugBreakpointModeApplicability,
): DebugBreakpointMode[] {
  return modes.filter((mode) => mode.appliesTo.includes(applicability));
}

/** Keep a valid saved mode, otherwise use the first applicable advertised mode. */
export function resolveBreakpointMode(
  preferred: string | undefined,
  modes: readonly DebugBreakpointMode[],
  applicability: DebugBreakpointModeApplicability,
): string | undefined {
  const applicable = breakpointModesFor(modes, applicability);
  return applicable.some((candidate) => candidate.mode === preferred)
    ? preferred
    : applicable[0]?.mode;
}

/** Build a standard DAP `dataBreakpointInfo` request from a variable/expression. */
export function buildDataBreakpointInfoArgs(target: DebugDataBreakpointTarget) {
  const args: Record<string, unknown> = { name: target.name };
  if (target.asAddress === true) {
    args.asAddress = true;
  } else {
    if (typeof target.variablesReference === "number" && target.variablesReference > 0) {
      args.variablesReference = target.variablesReference;
    } else if (typeof target.frameId === "number") {
      args.frameId = target.frameId;
    }
  }
  if (Number.isInteger(target.bytes) && (target.bytes as number) > 0) {
    args.bytes = target.bytes;
  }
  if (target.mode?.trim()) args.mode = target.mode.trim();
  return args;
}

/** Parse adapter-owned data id and access modes without inventing a fallback id. */
export function parseDataBreakpointInfo(body: unknown): DebugDataBreakpointInfo {
  const rec = asRecord(body);
  const accessTypes: DebugDataBreakpointAccessType[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.accessTypes)) {
    for (const value of rec.accessTypes) {
      if (
        (value === "read" || value === "write" || value === "readWrite")
        && !seen.has(value)
      ) {
        seen.add(value);
        accessTypes.push(value);
      }
    }
  }
  return {
    dataId: typeof rec.dataId === "string" && rec.dataId.length > 0 ? rec.dataId : null,
    description: typeof rec.description === "string" ? rec.description : "",
    accessTypes,
    canPersist: rec.canPersist === true,
  };
}

/** IDEA defaults a watchpoint to modification when the adapter offers it. */
export function defaultDataBreakpointAccessType(
  accessTypes: readonly DebugDataBreakpointAccessType[],
): DebugDataBreakpointAccessType | undefined {
  if (accessTypes.includes("write")) return "write";
  return accessTypes[0];
}

/** Stable identity for UI/runtime maps; the opaque data id is never parsed. */
export function dataBreakpointKey(breakpoint: DebugDataBreakpoint): string {
  return JSON.stringify([
    breakpoint.sessionId ? "session" : "adapter",
    breakpoint.sessionId ?? breakpoint.adapterId,
    breakpoint.dataId,
  ]);
}

export interface DataBreakpointSyncPlan {
  sorted: DebugDataBreakpoint[];
  /** Breakpoints owned by this adapter/session, including disabled entries. */
  applicable: DebugDataBreakpoint[];
  /** Enabled and unmuted entries sent in request order. */
  sent: DebugDataBreakpoint[];
}

/** Scope persistent data ids by adapter and transient ids by their owner session. */
export function planDataBreakpointSync(
  list: DebugDataBreakpoint[],
  context: { adapterId: string; sessionId: string; muted?: boolean },
): DataBreakpointSyncPlan {
  const sorted = list.slice().sort((left, right) => (
    compareText(left.adapterId, right.adapterId)
    || compareText(left.description, right.description)
    || compareText(left.dataId, right.dataId)
  ));
  const applicable = sorted.filter((breakpoint) => (
    breakpoint.sessionId
      ? breakpoint.sessionId === context.sessionId
      : breakpoint.canPersist && breakpoint.adapterId === context.adapterId
  ));
  return {
    sorted,
    applicable,
    sent: context.muted
      ? []
      : applicable.filter((breakpoint) => breakpoint.enabled !== false),
  };
}

/** Build the replacing `setDataBreakpoints` payload required by DAP. */
export function buildSetDataBreakpointsArgs(plan: DataBreakpointSyncPlan) {
  return {
    breakpoints: plan.sent.map((breakpoint) => {
      const entry: Record<string, unknown> = { dataId: breakpoint.dataId };
      if (breakpoint.accessType) entry.accessType = breakpoint.accessType;
      if (breakpoint.condition?.trim()) entry.condition = breakpoint.condition.trim();
      if (breakpoint.hitCondition?.trim()) entry.hitCondition = breakpoint.hitCondition.trim();
      return entry;
    }),
  };
}

/**
 * Build DAP `setBreakpoints` arguments for one source file from a sync plan.
 * The response's `breakpoints` array corresponds 1:1, in order, to `plan.sent`
 * (see parseSetBreakpointsResponse).
 */
export function buildSetBreakpointsArgs(
  path: string,
  plan: BreakpointSyncPlan,
  options: {
    adapterId?: string;
    breakpointModes?: readonly DebugBreakpointMode[];
  } = {},
) {
  return {
    source: { path, name: path.split(/[\\/]/).pop() ?? path },
    breakpoints: plan.sent.map((bp) => {
      const entry: Record<string, unknown> = { line: bp.line };
      if (bp.condition && bp.condition.trim()) entry.condition = bp.condition.trim();
      if (bp.hitCondition && bp.hitCondition.trim()) entry.hitCondition = bp.hitCondition.trim();
      if (bp.logMessage && bp.logMessage.trim()) entry.logMessage = bp.logMessage.trim();
      const mode = resolveBreakpointMode(
        options.adapterId ? bp.adapterModes?.[options.adapterId] : undefined,
        options.breakpointModes ?? [],
        "source",
      );
      if (mode) entry.mode = mode;
      return entry;
    }),
    // Ask the adapter to re-verify from source lines.
    sourceModified: false,
  };
}

/** Adapter-reported binding of one requested breakpoint. */
export interface BreakpointBinding {
  /** Adapter breakpoint id (routes later `breakpoint` events), or null. */
  id: number | null;
  verified: boolean;
  /** Line the adapter actually bound (requested line when it reports none). */
  line: number;
  /** DAP `message`: why a breakpoint could not be verified (shown to the user). */
  message?: string | null;
  /** DAP `reason`: `"pending"` (may verify later) or `"failed"` (needs action). */
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setFunctionBreakpoints`. */
export interface FunctionBreakpointBinding {
  id: number | null;
  verified: boolean;
  name: string;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setInstructionBreakpoints`. */
export interface InstructionBreakpointBinding {
  id: number | null;
  verified: boolean;
  key: string;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setDataBreakpoints`. */
export interface DataBreakpointBinding {
  id: number | null;
  verified: boolean;
  key: string;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/**
 * Runtime state of one armed breakpoint for the gutter + breakpoints view.
 * `verified` = bound in the running VM; `pending` = sent but the class is not
 * loaded / not yet confirmed (grey, may still hit); `failed` = the adapter
 * cannot bind it (grey, carries a reason). A breakpoint with no entry while a
 * session is active is treated as pending, never as verified.
 */
export interface BreakpointRuntimeState {
  status: "verified" | "pending" | "failed";
  message: string | null;
}

/**
 * Parse a `setBreakpoints` response. Per the DAP spec the response array
 * corresponds 1:1, in order, to the requested breakpoints — so it is indexed
 * against `plan.sent`.
 */
export function parseSetBreakpointsResponse(
  plan: BreakpointSyncPlan,
  body: unknown,
): BreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((bp, i) => {
    const rec = asRecord(list[i]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      line: typeof rec.line === "number" && rec.line > 0 ? rec.line : bp.line,
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Parse the positional response to `setFunctionBreakpoints`. */
export function parseSetFunctionBreakpointsResponse(
  plan: FunctionBreakpointSyncPlan,
  body: unknown,
): FunctionBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((breakpoint, index) => {
    const rec = asRecord(list[index]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      name: breakpoint.name,
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Parse `setInstructionBreakpoints`; response order matches the request. */
export function parseSetInstructionBreakpointsResponse(
  plan: InstructionBreakpointSyncPlan,
  body: unknown,
): InstructionBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((breakpoint, index) => {
    const rec = asRecord(list[index]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      key: instructionBreakpointKey(breakpoint),
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Parse `setDataBreakpoints`; response order matches the replacing request. */
export function parseSetDataBreakpointsResponse(
  plan: DataBreakpointSyncPlan,
  body: unknown,
): DataBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((breakpoint, index) => {
    const rec = asRecord(list[index]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      key: dataBreakpointKey(breakpoint),
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Map a raw binding's `verified`/`reason` to a display runtime status. */
export function bindingRuntimeStatus(
  binding: Pick<BreakpointBinding, "verified" | "message" | "reason">,
): BreakpointRuntimeState {
  if (binding.verified) return { status: "verified", message: null };
  // Unverified: `failed` means the adapter gave up; anything else (incl. an
  // explicit `pending`, or no reason yet) is treated as pending so the gutter
  // shows "not bound yet" rather than a hard failure.
  const status = binding.reason === "failed" ? "failed" : "pending";
  return { status, message: binding.message ?? null };
}

/** Verification state per persisted function name for the active session. */
export function functionBreakpointVerificationMap(
  plan: FunctionBreakpointSyncPlan,
  bindings: FunctionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  plan.sent.forEach((breakpoint, index) => {
    const binding = bindings[index];
    out[breakpoint.name] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

/** Verification state per adapter-scoped instruction location. */
export function instructionBreakpointVerificationMap(
  plan: InstructionBreakpointSyncPlan,
  bindings: InstructionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  plan.sent.forEach((breakpoint, index) => {
    const binding = bindings[index];
    out[instructionBreakpointKey(breakpoint)] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

/** Verification state per data-breakpoint identity for the selected session. */
export function dataBreakpointVerificationMap(
  plan: DataBreakpointSyncPlan,
  bindings: DataBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  plan.sent.forEach((breakpoint, index) => {
    const binding = bindings[index];
    out[dataBreakpointKey(breakpoint)] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

/**
 * Adopt adapter-adjusted lines: a breakpoint on a non-executable line gets
 * moved to the line the adapter actually bound (IDEA/VS Code behavior). Only
 * verified bindings move a breakpoint; entries collapsing onto an already-used
 * line are dropped. Breakpoints the plan did not send (disabled / muted) are
 * carried through untouched.
 */
export function reconcileBreakpointLines(
  plan: BreakpointSyncPlan,
  bindings: BreakpointBinding[],
): DebugBreakpoint[] {
  const boundLines = new Map<number, number>(); // index in `sorted` → bound line
  plan.indexes.forEach((index, k) => {
    const binding = bindings[k];
    if (index >= 0 && binding && binding.verified) boundLines.set(index, binding.line);
  });
  const out: DebugBreakpoint[] = [];
  const seen = new Set<number>();
  plan.sorted.forEach((bp, index) => {
    const line = boundLines.get(index) ?? bp.line;
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line === bp.line ? bp : { ...bp, line });
  });
  return out;
}

/**
 * Verification state per bound line, for the gutter. Only sent breakpoints have
 * one — a disabled or muted breakpoint is rendered from its stored state.
 */
export function breakpointVerificationMap(
  plan: BreakpointSyncPlan,
  bindings: BreakpointBinding[],
): Record<number, BreakpointRuntimeState> {
  const out: Record<number, BreakpointRuntimeState> = {};
  plan.sent.forEach((bp, k) => {
    const binding = bindings[k];
    const line = binding?.line ?? bp.line;
    out[line] = binding
      ? bindingRuntimeStatus(binding)
      // No binding element at all (short/missing response) → not yet confirmed.
      : { status: "pending", message: null };
  });
  return out;
}

/** Parse a `breakpoint` event (adapters re-verify bindings as classes load). */
export function parseBreakpointEvent(
  message: unknown,
): {
  reason: string;
  id: number | null;
  verified: boolean;
  line: number | null;
  /** Adapter explanation for an unverified breakpoint, when provided. */
  message: string | null;
  /** DAP breakpoint `reason` field (distinct from the event's `reason`). */
  bindReason: "pending" | "failed" | null;
} | null {
  const body = asRecord(asRecord(message).body);
  const bp = asRecord(body.breakpoint);
  if (Object.keys(bp).length === 0) return null;
  return {
    reason: typeof body.reason === "string" ? body.reason : "changed",
    id: typeof bp.id === "number" ? bp.id : null,
    verified: bp.verified === true,
    line: typeof bp.line === "number" ? bp.line : null,
    message: typeof bp.message === "string" && bp.message ? bp.message : null,
    bindReason: bp.reason === "pending" || bp.reason === "failed" ? bp.reason : null,
  };
}

/** Parse and de-duplicate the adapter's exception-filter capability metadata. */
export function parseExceptionBreakpointFilters(
  capabilities: Record<string, unknown>,
): DebugExceptionBreakpointFilter[] {
  const filters = capabilities.exceptionBreakpointFilters;
  if (!Array.isArray(filters)) return [];
  const out: DebugExceptionBreakpointFilter[] = [];
  const seen = new Set<string>();
  for (const value of filters) {
    const filter = asRecord(value);
    const id = typeof filter.filter === "string" ? filter.filter : "";
    if (!id.trim() || seen.has(id)) continue;
    seen.add(id);
    const label = typeof filter.label === "string" && filter.label.trim()
      ? filter.label.trim()
      : id;
    out.push({
      filter: id,
      label,
      description: typeof filter.description === "string" && filter.description.trim()
        ? filter.description.trim()
        : undefined,
      default: filter.default === true,
      supportsCondition: filter.supportsCondition === true,
      conditionDescription: typeof filter.conditionDescription === "string"
        && filter.conditionDescription.trim()
        ? filter.conditionDescription.trim()
        : undefined,
    });
  }
  return out;
}

/** Stable identity for persisted adapter-specific exception settings. */
export function exceptionBreakpointKey(
  breakpoint: Pick<DebugExceptionBreakpoint, "adapterId" | "filterId">,
): string {
  return JSON.stringify([breakpoint.adapterId, breakpoint.filterId]);
}

/** Stable identity for a persisted adapter-specific exception path rule. */
export function exceptionBreakpointRuleKey(
  rule: Pick<DebugExceptionBreakpointRule, "adapterId" | "id">,
): string {
  return JSON.stringify([rule.adapterId, rule.id]);
}

/** Compact path label for the exception-breakpoints view. */
export function exceptionBreakpointRuleLabel(
  rule: Pick<DebugExceptionBreakpointRule, "path">,
): string {
  if (rule.path.length === 0) return "All exceptions";
  return rule.path.map((segment) => {
    const names = segment.names.join(" | ");
    return segment.negate ? `not (${names})` : names;
  }).join(" / ");
}

/**
 * Seed newly advertised filters from the adapter's `default` flag while
 * retaining every explicit user choice (including disabled filters).
 */
export function mergeExceptionBreakpointDefaults(
  list: DebugExceptionBreakpoint[],
  adapterId: string,
  filters: readonly DebugExceptionBreakpointFilter[],
): DebugExceptionBreakpoint[] {
  const known = new Set(list.map(exceptionBreakpointKey));
  const additions = filters.flatMap((filter) => {
    const breakpoint: DebugExceptionBreakpoint = {
      adapterId,
      filterId: filter.filter,
      enabled: filter.default,
    };
    return known.has(exceptionBreakpointKey(breakpoint)) ? [] : [breakpoint];
  });
  return additions.length > 0 ? [...list, ...additions] : list;
}

export interface ExceptionBreakpointSyncPlan {
  /** Settings matching filters advertised by this adapter, in advertised order. */
  applicable: DebugExceptionBreakpoint[];
  /** Persisted class/package rules matching this adapter, in user order. */
  applicableRules: DebugExceptionBreakpointRule[];
  /** Enabled filters sent through the backward-compatible `filters` array. */
  plain: DebugExceptionBreakpoint[];
  /** Enabled filters sent with a condition and/or mode through `filterOptions`. */
  options: ExceptionBreakpointFilterOption[];
  /** Enabled rules sent through capability-gated `exceptionOptions`. */
  rules: DebugExceptionBreakpointRule[];
  /** Positional response order: `filters`, `filterOptions`, then `exceptionOptions`. */
  sent: ExceptionBreakpointSyncTarget[];
}

export type ExceptionBreakpointSyncTarget =
  | { kind: "filter"; breakpoint: DebugExceptionBreakpoint }
  | { kind: "rule"; rule: DebugExceptionBreakpointRule };

export interface ExceptionBreakpointFilterOption {
  breakpoint: DebugExceptionBreakpoint;
  condition?: string;
  mode?: string;
}

/** Plan a replacing exception-breakpoint request for one adapter session. */
export function planExceptionBreakpointSync(
  list: DebugExceptionBreakpoint[],
  ruleList: DebugExceptionBreakpointRule[],
  filters: readonly DebugExceptionBreakpointFilter[],
  context: {
    adapterId: string;
    muted?: boolean;
    supportsFilterOptions?: boolean;
    supportsExceptionOptions?: boolean;
    breakpointModes?: readonly DebugBreakpointMode[];
  },
): ExceptionBreakpointSyncPlan {
  const byKey = new Map(list.map((breakpoint) => [exceptionBreakpointKey(breakpoint), breakpoint]));
  const applicable = filters.map((filter) => {
    const fallback: DebugExceptionBreakpoint = {
      adapterId: context.adapterId,
      filterId: filter.filter,
      enabled: filter.default,
    };
    return byKey.get(exceptionBreakpointKey(fallback)) ?? fallback;
  });
  const enabled = context.muted ? [] : applicable.filter((breakpoint) => breakpoint.enabled);
  const metadata = new Map(filters.map((filter) => [filter.filter, filter]));
  const options = context.supportsFilterOptions
    ? enabled.flatMap((breakpoint): ExceptionBreakpointFilterOption[] => {
        const condition = metadata.get(breakpoint.filterId)?.supportsCondition === true
          ? breakpoint.condition?.trim() || undefined
          : undefined;
        const mode = resolveBreakpointMode(
          breakpoint.mode,
          context.breakpointModes ?? [],
          "exception",
        );
        return condition || mode ? [{ breakpoint, condition, mode }] : [];
      })
    : [];
  const optionIds = new Set(options.map((entry) => entry.breakpoint.filterId));
  const plain = enabled.filter((breakpoint) => !optionIds.has(breakpoint.filterId));
  const applicableRules = ruleList.filter((rule) => rule.adapterId === context.adapterId);
  const rules = context.supportsExceptionOptions && !context.muted
    ? applicableRules.filter((rule) => rule.enabled)
    : [];
  const sent: ExceptionBreakpointSyncTarget[] = [
    ...plain.map((breakpoint) => ({ kind: "filter" as const, breakpoint })),
    ...options.map(({ breakpoint }) => ({ kind: "filter" as const, breakpoint })),
    ...rules.map((rule) => ({ kind: "rule" as const, rule })),
  ];
  return { applicable, applicableRules, plain, options, rules, sent };
}

/** Build standard DAP `setExceptionBreakpoints` arguments with legacy fallback. */
export function buildSetExceptionBreakpointsArgs(plan: ExceptionBreakpointSyncPlan) {
  const args: {
    filters: string[];
    filterOptions?: Array<{ filterId: string; condition?: string; mode?: string }>;
    exceptionOptions?: Array<{
      path?: Array<{ names: string[]; negate?: boolean }>;
      breakMode: DebugExceptionBreakMode;
    }>;
  } = {
    filters: plan.plain.map((breakpoint) => breakpoint.filterId),
  };
  if (plan.options.length > 0) {
    args.filterOptions = plan.options.map(({ breakpoint, condition, mode }) => ({
      filterId: breakpoint.filterId,
      ...(condition ? { condition } : {}),
      ...(mode ? { mode } : {}),
    }));
  }
  if (plan.rules.length > 0) {
    args.exceptionOptions = plan.rules.map((rule) => ({
      ...(rule.path.length > 0
        ? {
            path: rule.path.map((segment) => ({
              names: [...segment.names],
              ...(segment.negate ? { negate: true } : {}),
            })),
          }
        : {}),
      breakMode: rule.breakMode,
    }));
  }
  return args;
}

interface ExceptionBreakpointBindingBase {
  id: number | null;
  verified: boolean;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setExceptionBreakpoints`. */
export type ExceptionBreakpointBinding =
  | (ExceptionBreakpointBindingBase & { kind: "filter"; filterId: string })
  | (ExceptionBreakpointBindingBase & { kind: "rule"; ruleId: string });

/** Parse bindings in `filters`, `filterOptions`, then `exceptionOptions` order. */
export function parseSetExceptionBreakpointsResponse(
  plan: ExceptionBreakpointSyncPlan,
  body: unknown,
): ExceptionBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((target, index) => {
    const rec = asRecord(list[index]);
    const reason: "pending" | "failed" | null = rec.reason === "pending" || rec.reason === "failed"
      ? rec.reason
      : null;
    const binding: ExceptionBreakpointBindingBase = {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason,
    };
    return target.kind === "filter"
      ? { ...binding, kind: "filter" as const, filterId: target.breakpoint.filterId }
      : { ...binding, kind: "rule" as const, ruleId: target.rule.id };
  });
}

/** Verification state per exception filter for the selected adapter session. */
export function exceptionBreakpointVerificationMap(
  plan: ExceptionBreakpointSyncPlan,
  bindings: ExceptionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  const filterBindings = bindings.filter((binding) => binding.kind === "filter");
  [...plan.plain, ...plan.options.map((entry) => entry.breakpoint)].forEach((breakpoint, index) => {
    const binding = filterBindings[index];
    out[breakpoint.filterId] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

/** Verification state per user-defined exception path rule. */
export function exceptionBreakpointRuleVerificationMap(
  plan: ExceptionBreakpointSyncPlan,
  bindings: ExceptionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  const ruleBindings = bindings.filter((binding) => binding.kind === "rule");
  plan.rules.forEach((rule, index) => {
    const binding = ruleBindings[index];
    out[rule.id] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
      sourceReference: typeof source.sourceReference === "number" ? source.sourceReference : 0,
      sourceName: typeof source.name === "string" && source.name ? source.name : null,
    }];
  });
}

/** Parse an `exceptionInfo` response body (null when the adapter has nothing). */
export function parseExceptionInfo(body: unknown): DebugExceptionInfo | null {
  const rec = asRecord(body);
  const exceptionId = typeof rec.exceptionId === "string" ? rec.exceptionId : "";
  const description = typeof rec.description === "string" ? rec.description : "";
  if (!exceptionId && !description) return null;
  const details = asRecord(rec.details);
  return {
    exceptionId: exceptionId || "Exception",
    description,
    details: typeof details.stackTrace === "string" ? details.stackTrace : null,
  };
}

/** Parse an `evaluate` response body into display value + expandable ref. */
export function parseEvaluate(body: unknown): EvaluateResult {
  const rec = asRecord(body);
  return {
    value: typeof rec.result === "string" ? rec.result : "",
    variablesReference: typeof rec.variablesReference === "number" ? rec.variablesReference : 0,
    type: typeof rec.type === "string" ? rec.type : null,
  };
}

/**
 * The source location to highlight as "current" — the selected frame when set,
 * else the top frame that has a path.
 */
export function currentLocation(
  frames: DebugStackFrame[],
  selectedFrameId?: number | null,
): { path: string; line: number } | null {
  if (selectedFrameId != null) {
    const selected = frames.find((f) => f.id === selectedFrameId);
    if (selected?.path) return { path: selected.path, line: selected.line };
  }
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
        selectedThreadId: threadId,
        stoppedReason: typeof body.reason === "string" ? body.reason : "stopped",
        exceptionInfo: null,
      };
    }
    case "continued":
      return markResumed(state);
    case "exited": {
      const next: DebugSessionState = {
        ...state,
        status: "terminated",
        stoppedThreadId: null,
        selectedThreadId: null,
        selectedFrameId: null,
        frames: [],
      };
      // IDEA-style closing line with the process exit code.
      return typeof body.exitCode === "number"
        ? appendConsoleLine(next, "console", `\nProcess finished with exit code ${body.exitCode}\n`)
        : next;
    }
    case "terminated":
      return {
        ...state,
        status: "terminated",
        stoppedThreadId: null,
        selectedThreadId: null,
        selectedFrameId: null,
        frames: [],
      };
    case "output": {
      const text = typeof body.output === "string" ? body.output : "";
      const category = typeof body.category === "string" && body.category ? body.category : "stdout";
      if (!text || category === "telemetry") return state;
      return appendConsoleLine(state, category, text);
    }
    case "thread": {
      // Keep the thread list live while running — adapters report starts/exits
      // as they happen, and a `threads` request is only allowed while stopped.
      const threadId = typeof body.threadId === "number" ? body.threadId : null;
      if (threadId == null) return state;
      if (body.reason === "exited") {
        return { ...state, threads: state.threads.filter((t) => t.id !== threadId) };
      }
      if (state.threads.some((t) => t.id === threadId)) return state;
      return { ...state, threads: [...state.threads, { id: threadId, name: `Thread ${threadId}` }] };
    }
    default:
      return state;
  }
}

/**
 * The expression under `pos` in a line of source, for hover evaluation: a
 * dotted identifier chain (`order.items.size`) plus any trailing `[i]` index,
 * which is what IDEA evaluates when you hover a variable. Returns null when the
 * position is not on an identifier. Pure — deliberately syntax-free so it works
 * for every language the DAP framework serves.
 */
export function hoverExpressionAt(lineText: string, pos: number): string | null {
  if (pos < 0 || pos > lineText.length) return null;
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  // The character under the caret, or the one just before it at a boundary.
  let end = pos;
  if (end < lineText.length && isWord(lineText[end])) {
    while (end < lineText.length && isWord(lineText[end])) end += 1;
  } else if (pos > 0 && isWord(lineText[pos - 1])) {
    end = pos;
  } else {
    return null;
  }
  let start = end;
  while (start > 0 && (isWord(lineText[start - 1]) || lineText[start - 1] === ".")) start -= 1;
  // A leading dot or a numeric literal is not something worth evaluating.
  const expression = lineText.slice(start, end).replace(/^\.+/, "");
  if (!expression || /^[0-9]/.test(expression)) return null;
  // Include a simple array/list index directly after the identifier.
  const rest = lineText.slice(end);
  const index = /^\[[^[\]]*\]/.exec(rest);
  return index ? `${expression}${index[0]}` : expression;
}

/**
 * Inline value label for one source line (IDEA shows evaluated locals next to
 * the code). Returns `name = value` pairs for every known variable mentioned on
 * the line, in order of appearance, or null when none are.
 */
export function inlineValueLabel(
  lineText: string,
  variables: Record<string, string>,
): string | null {
  const names = Object.keys(variables);
  if (names.length === 0) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  // Scan identifiers left to right so the label reads in source order. Skip
  // anything after a line comment and inside string literals is out of scope
  // for a syntax-free scan — a stale extra pair is harmless, a missing one is not.
  const code = lineText.split("//")[0];
  for (const match of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = match[0];
    // A member access (`obj.field`) is not the local `field`.
    if (match.index > 0 && code[match.index - 1] === ".") continue;
    if (seen.has(name) || !(name in variables)) continue;
    seen.add(name);
    parts.push(`${name} = ${variables[name]}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
