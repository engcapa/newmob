import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useMountedRef } from "../../../hooks/useMountedRef";
import {
  dapSend,
  dapSendRequest,
  dapStartSession,
  dapTerminate,
  listenDapEvents,
  type DapEventPayload,
} from "../../../lib/editor/dap";
import {
  appendConsoleLine,
  breakpointModesFor,
  breakpointVerificationMap,
  buildDataBreakpointInfoArgs,
  buildSetBreakpointsArgs,
  buildSetDataBreakpointsArgs,
  buildSetExceptionBreakpointsArgs,
  buildSetFunctionBreakpointsArgs,
  currentLocation,
  dataBreakpointKey,
  dataBreakpointVerificationMap,
  defaultDataBreakpointAccessType,
  exceptionBreakpointKey,
  exceptionBreakpointRuleKey,
  exceptionBreakpointRuleVerificationMap,
  exceptionBreakpointVerificationMap,
  functionBreakpointVerificationMap,
  initialDebugState,
  markResumed,
  mergeExceptionBreakpointDefaults,
  parseBreakpointEvent,
  parseBreakpointModes,
  parseDataBreakpointInfo,
  parseEvaluate,
  parseExceptionBreakpointFilters,
  parseExceptionInfo,
  parseSetBreakpointsResponse,
  parseSetDataBreakpointsResponse,
  parseSetExceptionBreakpointsResponse,
  parseSetFunctionBreakpointsResponse,
  parseStackFrames,
  parseThreads,
  planBreakpointSync,
  planDataBreakpointSync,
  planExceptionBreakpointSync,
  planFunctionBreakpointSync,
  reconcileBreakpointLines,
  reduceDebugEvent,
  resolveBreakpointMode,
  stepCommandFor,
  toAdapterSourcePath,
  type BreakpointRuntimeState,
  type DebugBreakpoint,
  type DebugDataBreakpoint,
  type DebugDataBreakpointTarget,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointFilter,
  type DebugExceptionBreakpointRule,
  type DebugExceptionBreakMode,
  type DebugExceptionPathSegment,
  type DebugFunctionBreakpoint,
  type DebugSessionState,
  type DebugStackFrame,
  type DebugStepAction,
  type EvaluateResult,
} from "./dapDebugModel";

/** Breakpoints keyed by absolute file path. */
export type BreakpointMap = Record<string, DebugBreakpoint[]>;

export interface DebugLaunchTarget {
  id: string;
  label: string;
  adapterId: string;
  launchConfig: Record<string, unknown>;
}

export interface DebugLaunchGroup {
  id: string;
  label: string;
  children: DebugLaunchNode[];
  parallel?: boolean;
  stopOnFailure?: boolean;
}

export type DebugLaunchNode = DebugLaunchTarget | DebugLaunchGroup;

export interface DebugSessionSummary {
  id: string;
  targetId: string;
  label: string;
  adapterId: string;
  status: DebugSessionState["status"];
  stoppedReason: string | null;
}

export interface DataBreakpointAddResult {
  added: boolean;
  message: string;
}

/** Message text from a rejected DAP request, for console surfacing. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodeDebugSession {
  /** Current session state (null when no debug session is active). */
  state: DebugSessionState | null;
  breakpoints: BreakpointMap;
  /** Adapter binding state per path → line → runtime status (session-scoped). */
  breakpointRuntime: Record<string, Record<number, BreakpointRuntimeState>>;
  /** Persistent DAP function/method breakpoints, shared by compound children. */
  functionBreakpoints: DebugFunctionBreakpoint[];
  /** Function binding state for the selected adapter session. */
  functionBreakpointRuntime: Record<string, BreakpointRuntimeState>;
  /** Persistent adapter-scoped and transient session-scoped data breakpoints. */
  dataBreakpoints: DebugDataBreakpoint[];
  /** Data-breakpoint binding state for the selected adapter session. */
  dataBreakpointRuntime: Record<string, BreakpointRuntimeState>;
  /** Persistent adapter-scoped exception-filter choices and conditions. */
  exceptionBreakpoints: DebugExceptionBreakpoint[];
  /** Exception-filter binding state for the selected adapter session. */
  exceptionBreakpointRuntime: Record<string, BreakpointRuntimeState>;
  /** Persistent adapter-scoped class/package exception rules. */
  exceptionBreakpointRules: DebugExceptionBreakpointRule[];
  /** Exception-rule binding state for the selected adapter session. */
  exceptionBreakpointRuleRuntime: Record<string, BreakpointRuntimeState>;
  /** Adapter capabilities from `initialize` — gates optional UI (restartFrame, setVariable…). */
  capabilities: Record<string, unknown>;
  /** Exception-breakpoint filter ids the adapter advertised (D5). */
  availableExceptionFilters: DebugExceptionBreakpointFilter[];
  /** Persistent watch expressions (the panel evaluates them per stop). */
  watchExpressions: string[];
  /** IDEA "Mute Breakpoints": keep them listed but stop arming them. */
  breakpointsMuted: boolean;
  setBreakpointsMuted: (muted: boolean) => void;
  /** Remove every breakpoint in the workspace (IDEA's breakpoints dialog). */
  removeAllBreakpoints: () => void;
  /** Locals of the selected frame as `name → value`, for editor inline values. */
  frameVariables: Record<string, string>;
  /** Every child in the current single or compound debug launch. */
  sessions: DebugSessionSummary[];
  /** Session shown by the stack, variables, watches and console views. */
  activeSessionId: string | null;
  selectSession: (sessionId: string) => void;
  /** Start a debug session with a resolved launch config (adapter defaults to Java). */
  startDebug: (launchConfig: Record<string, unknown>, adapterId?: string) => Promise<void>;
  /** Start a validated compound launch while retaining every child DAP session. */
  startDebugGroup: (plan: DebugLaunchGroup) => Promise<void>;
  /** Re-run the last launch config (IDEA rerun). */
  restart: () => void;
  canRestart: boolean;
  toggleBreakpoint: (path: string, line: number) => void;
  setBreakpointOptions: (path: string, line: number, options: Partial<DebugBreakpoint>) => void;
  /** Persist a source-breakpoint mode for the active adapter only. */
  setBreakpointMode: (path: string, line: number, mode: string) => void;
  /** Remove one breakpoint outright (breakpoints view). */
  removeBreakpoint: (path: string, line: number) => void;
  addFunctionBreakpoint: (name: string) => void;
  setFunctionBreakpointOptions: (name: string, options: Partial<DebugFunctionBreakpoint>) => void;
  removeFunctionBreakpoint: (name: string) => void;
  addDataBreakpoint: (target: DebugDataBreakpointTarget) => Promise<DataBreakpointAddResult>;
  setDataBreakpointOptions: (key: string, options: Partial<DebugDataBreakpoint>) => void;
  removeDataBreakpoint: (key: string) => void;
  setExceptionBreakpointOptions: (
    filterId: string,
    options: Partial<Pick<DebugExceptionBreakpoint, "enabled" | "condition" | "mode">>,
  ) => void;
  addExceptionBreakpointRule: (
    path: DebugExceptionPathSegment[],
    breakMode?: DebugExceptionBreakMode,
  ) => string | null;
  setExceptionBreakpointRuleOptions: (
    ruleId: string,
    options: Partial<Pick<DebugExceptionBreakpointRule, "enabled" | "path" | "breakMode">>,
  ) => void;
  removeExceptionBreakpointRule: (ruleId: string) => void;
  addWatchExpression: (expr: string) => void;
  removeWatchExpression: (index: number) => void;
  step: (action: DebugStepAction) => void;
  /** Continue to a line via a transient breakpoint (IDEA Run to Cursor). */
  runToCursor: (path: string, line: number) => void;
  /** Show another thread's stack while stopped. */
  selectThread: (threadId: number) => void;
  /** Pick the frame that variables / watches / evaluate target. */
  selectFrame: (frameId: number) => void;
  /** Re-enter a frame from its start (IDEA Drop Frame; capability-gated). */
  restartFrame: (frameId: number) => void;
  /** Hot-reload changed classes (java-debug `redefineClasses`); best-effort (D5). */
  hotReload: () => void;
  evaluate: (expression: string, context?: string) => Promise<EvaluateResult>;
  /**
   * Evaluate for an editor hover (IDEA's inspect-on-hover). Resolves to null
   * when the session is not stopped or the expression cannot be evaluated, so
   * the editor simply shows no tooltip.
   */
  hoverEvaluate: (expression: string) => Promise<EvaluateResult | null>;
  /** Change a variable's value (DAP `setVariable`; capability-gated). */
  setVariable: (variablesReference: number, name: string, value: string) => Promise<EvaluateResult | null>;
  /** Append a client-side line (REPL echo / result) to the session console. */
  logConsole: (category: string, text: string) => void;
  /** Empty the console without touching the session. */
  clearConsole: () => void;
  /**
   * Surface a launch/pre-launch failure in the Debug panel (not just the status
   * bar) so a debug attempt that dies before a session exists is visible rather
   * than looking like "nothing happened". Seeds a `terminated` session carrying
   * the message on the console when there is none yet.
   */
  reportStartupFailure: (message: string) => void;
  /**
   * Report a pre-launch step (save → build → resolve main class) in the Debug
   * panel. The phase before the adapter exists can take tens of seconds on a
   * cold project; without this the panel shows its "no debug session"
   * placeholder the whole time and the click looks ignored.
   */
  reportStartupProgress: (message: string) => void;
  /** Fetch variables for a `variablesReference` (D4 lazy tree). */
  fetchVariables: (variablesReference: number) => Promise<unknown>;
  /** Fetch scopes for a stack frame (D4). */
  fetchScopes: (frameId: number) => Promise<unknown>;
  /**
   * Fetch a library / decompiled frame's source text (DAP `source`), so a stack
   * frame outside the workspace still opens — IDEA's decompiled-source view.
   * Null when the adapter cannot produce it.
   */
  fetchSource: (sourceReference: number) => Promise<string | null>;
  terminate: () => void;
  /** Source location to highlight as "current" (selected frame, else top frame). */
  currentLocation: { path: string; line: number } | null;
}

interface DebugSessionRecord {
  id: string;
  order: number;
  targetId: string;
  label: string;
  adapterId: string;
  launchConfig: Record<string, unknown>;
  state: DebugSessionState;
  capabilities: Record<string, unknown>;
  availableFilters: DebugExceptionBreakpointFilter[];
  breakpointRuntime: Record<string, Record<number, BreakpointRuntimeState>>;
  functionBreakpointRuntime: Record<string, BreakpointRuntimeState>;
  dataBreakpointRuntime: Record<string, BreakpointRuntimeState>;
  exceptionBreakpointRuntime: Record<string, BreakpointRuntimeState>;
  exceptionBreakpointRuleRuntime: Record<string, BreakpointRuntimeState>;
  frameVariables: Record<string, string>;
  initialized: boolean;
  launchAccepted: boolean;
  live: boolean;
  unlisten: UnlistenFn | null;
  stopEpoch: number;
  bpIdIndex: Map<number,
    | { kind: "source"; path: string }
    | { kind: "function"; name: string }
    | { kind: "data"; key: string }
    | { kind: "exception-filter"; filterId: string }
    | { kind: "exception-rule"; ruleId: string }
  >;
  syncGeneration: Map<string, number>;
  functionSyncGeneration: number;
  dataSyncGeneration: number;
  exceptionSyncGeneration: number;
  tempRunToCursor: { path: string } | null;
  abortScopeIds: string[];
  ready: Promise<void>;
  readyResolve: () => void;
  readyReject: (error: unknown) => void;
  readySettled: boolean;
}

type LastDebugLaunch =
  | { kind: "single"; config: Record<string, unknown>; adapterId: string }
  | { kind: "group"; plan: DebugLaunchGroup };

function isDebugLaunchGroup(node: DebugLaunchNode): node is DebugLaunchGroup {
  return "children" in node;
}

function validateDebugLaunchGroup(plan: DebugLaunchGroup): void {
  const visiting = new Set<DebugLaunchNode>();
  const visit = (node: DebugLaunchNode) => {
    if (visiting.has(node)) throw new Error(`Compound Debug cycle at ${node.label}`);
    if (!node.id.trim()) throw new Error("Compound Debug contains an empty configuration id");
    if (!isDebugLaunchGroup(node)) {
      if (!node.adapterId.trim()) throw new Error(`Debug adapter is missing for ${node.label}`);
      return;
    }
    if (node.children.length === 0) throw new Error(`Compound Debug has no children: ${node.label}`);
    visiting.add(node);
    for (const child of node.children) visit(child);
    visiting.delete(node);
  };
  visit(plan);
}

function breakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugBreakpoints.v1.${workspaceInstanceId}`;
}

function watchesKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugWatches.v1.${workspaceInstanceId}`;
}

function functionBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugFunctionBreakpoints.v1.${workspaceInstanceId}`;
}

function dataBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugDataBreakpoints.v1.${workspaceInstanceId}`;
}

function exceptionBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugExceptionBreakpoints.v1.${workspaceInstanceId}`;
}

function exceptionBreakpointRulesKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugExceptionBreakpointRules.v1.${workspaceInstanceId}`;
}

const MAX_FUNCTION_BREAKPOINTS = 256;
const MAX_FUNCTION_BREAKPOINT_NAME_LENGTH = 1024;
const MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH = 4096;
const MAX_DATA_BREAKPOINTS = 256;
const MAX_DATA_BREAKPOINT_ID_LENGTH = 4096;
const MAX_DATA_BREAKPOINT_DESCRIPTION_LENGTH = 1024;
const MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH = 128;
const MAX_DATA_BREAKPOINT_BYTES = 0xffffffff;
const MAX_EXCEPTION_BREAKPOINTS = 512;
const MAX_EXCEPTION_BREAKPOINT_FILTER_ID_LENGTH = 1024;
const MAX_EXCEPTION_BREAKPOINT_RULES = 256;
const MAX_EXCEPTION_BREAKPOINT_RULE_ID_LENGTH = 128;
const MAX_EXCEPTION_PATH_SEGMENTS = 32;
const MAX_EXCEPTION_PATH_NAMES = 64;
const MAX_EXCEPTION_PATH_NAME_LENGTH = 1024;
const MAX_BREAKPOINT_MODE_ID_LENGTH = 1024;
const MAX_SOURCE_BREAKPOINT_ADAPTER_MODES = 64;
let exceptionBreakpointRuleSequence = 0;

function normalizeBreakpointModeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim();
  return mode && mode.length <= MAX_BREAKPOINT_MODE_ID_LENGTH ? mode : undefined;
}

function normalizeDataBreakpointBytes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value > 0 && value <= MAX_DATA_BREAKPOINT_BYTES ? value : undefined;
}

function isDataBreakpointAddress(value: string): boolean {
  return /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value);
}

function normalizeSourceBreakpointAdapterModes(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [rawAdapterId, rawMode] of Object.entries(value)) {
    const adapterId = rawAdapterId.trim();
    const mode = normalizeBreakpointModeId(rawMode);
    if (!adapterId || adapterId.length > MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH || !mode) continue;
    entries.push([adapterId, mode]);
    if (entries.length >= MAX_SOURCE_BREAKPOINT_ADAPTER_MODES) break;
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function createExceptionBreakpointRuleId(): string {
  exceptionBreakpointRuleSequence = (exceptionBreakpointRuleSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${exceptionBreakpointRuleSequence.toString(36)}`;
}

function normalizeFunctionBreakpoint(value: unknown): DebugFunctionBreakpoint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string"
    ? raw.name.trim().slice(0, MAX_FUNCTION_BREAKPOINT_NAME_LENGTH)
    : "";
  if (!name) return null;
  const normalizeExpression = (expression: unknown): string | undefined => {
    if (typeof expression !== "string") return undefined;
    return expression.trim().slice(0, MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH) || undefined;
  };
  return {
    name,
    condition: normalizeExpression(raw.condition),
    hitCondition: normalizeExpression(raw.hitCondition),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
  };
}

function normalizeFunctionBreakpoints(values: readonly unknown[]): DebugFunctionBreakpoint[] {
  const normalized: DebugFunctionBreakpoint[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const breakpoint = normalizeFunctionBreakpoint(value);
    if (!breakpoint || seen.has(breakpoint.name)) continue;
    seen.add(breakpoint.name);
    normalized.push(breakpoint);
    if (normalized.length >= MAX_FUNCTION_BREAKPOINTS) break;
  }
  return normalized;
}

function normalizeDataBreakpoint(value: unknown): DebugDataBreakpoint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const dataId = typeof raw.dataId === "string" && raw.dataId.length <= MAX_DATA_BREAKPOINT_ID_LENGTH
    ? raw.dataId
    : "";
  const description = typeof raw.description === "string"
    ? raw.description.trim().slice(0, MAX_DATA_BREAKPOINT_DESCRIPTION_LENGTH)
    : "";
  const adapterId = typeof raw.adapterId === "string"
    && raw.adapterId.trim().length <= MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH
    ? raw.adapterId.trim()
    : "";
  const canPersist = raw.canPersist === true;
  const sessionId = !canPersist
    && typeof raw.sessionId === "string"
    && raw.sessionId.length > 0
    && raw.sessionId.length <= MAX_DATA_BREAKPOINT_ID_LENGTH
    ? raw.sessionId
    : undefined;
  if (!dataId || !description || !adapterId || (!canPersist && !sessionId)) return null;
  const accessTypes = Array.isArray(raw.accessTypes)
    ? Array.from(new Set(raw.accessTypes.filter((accessType): accessType is "read" | "write" | "readWrite" => (
        accessType === "read" || accessType === "write" || accessType === "readWrite"
      ))))
    : [];
  const accessType = raw.accessType === "read" || raw.accessType === "write" || raw.accessType === "readWrite"
    ? raw.accessType
    : undefined;
  const bytes = normalizeDataBreakpointBytes(raw.bytes);
  const asAddress = raw.asAddress === true ? true : undefined;
  const normalizeExpression = (expression: unknown): string | undefined => (
    typeof expression === "string"
      ? expression.trim().slice(0, MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH) || undefined
      : undefined
  );
  return {
    dataId,
    description,
    adapterId,
    accessTypes,
    accessType: accessType && (accessTypes.length === 0 || accessTypes.includes(accessType))
      ? accessType
      : defaultDataBreakpointAccessType(accessTypes),
    condition: normalizeExpression(raw.condition),
    hitCondition: normalizeExpression(raw.hitCondition),
    bytes,
    asAddress,
    mode: normalizeBreakpointModeId(raw.mode),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    canPersist,
    sessionId,
  };
}

function normalizeDataBreakpoints(values: readonly unknown[]): DebugDataBreakpoint[] {
  const normalized: DebugDataBreakpoint[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const breakpoint = normalizeDataBreakpoint(value);
    if (!breakpoint) continue;
    const key = dataBreakpointKey(breakpoint);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(breakpoint);
    if (normalized.length >= MAX_DATA_BREAKPOINTS) break;
  }
  return normalized;
}

function normalizeExceptionBreakpoint(value: unknown): DebugExceptionBreakpoint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const adapterId = typeof raw.adapterId === "string"
    && raw.adapterId.trim().length <= MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH
    ? raw.adapterId.trim()
    : "";
  const filterId = typeof raw.filterId === "string"
    && !!raw.filterId.trim()
    && raw.filterId.length <= MAX_EXCEPTION_BREAKPOINT_FILTER_ID_LENGTH
    ? raw.filterId
    : "";
  if (!adapterId || !filterId || typeof raw.enabled !== "boolean") return null;
  const condition = typeof raw.condition === "string"
    ? raw.condition.trim().slice(0, MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH) || undefined
    : undefined;
  return {
    adapterId,
    filterId,
    enabled: raw.enabled,
    condition,
    mode: normalizeBreakpointModeId(raw.mode),
  };
}

function normalizeExceptionBreakpoints(values: readonly unknown[]): DebugExceptionBreakpoint[] {
  const normalized: DebugExceptionBreakpoint[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const breakpoint = normalizeExceptionBreakpoint(value);
    if (!breakpoint) continue;
    const key = exceptionBreakpointKey(breakpoint);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(breakpoint);
    if (normalized.length >= MAX_EXCEPTION_BREAKPOINTS) break;
  }
  return normalized;
}

function normalizeExceptionPath(value: unknown): DebugExceptionPathSegment[] | null {
  if (!Array.isArray(value)) return null;
  const path: DebugExceptionPathSegment[] = [];
  for (const rawSegment of value.slice(0, MAX_EXCEPTION_PATH_SEGMENTS)) {
    if (!rawSegment || typeof rawSegment !== "object") continue;
    const raw = rawSegment as Record<string, unknown>;
    if (!Array.isArray(raw.names)) continue;
    const names = Array.from(new Set(raw.names.flatMap((name) => {
      if (typeof name !== "string") return [];
      const normalized = name.trim().slice(0, MAX_EXCEPTION_PATH_NAME_LENGTH);
      return normalized ? [normalized] : [];
    }))).slice(0, MAX_EXCEPTION_PATH_NAMES);
    if (names.length === 0) continue;
    path.push({ names, ...(raw.negate === true ? { negate: true } : {}) });
  }
  if (value.length > 0 && path.length === 0) return null;
  return path;
}

function normalizeExceptionBreakpointRule(value: unknown): DebugExceptionBreakpointRule | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string"
    ? raw.id.trim().slice(0, MAX_EXCEPTION_BREAKPOINT_RULE_ID_LENGTH)
    : "";
  const adapterId = typeof raw.adapterId === "string"
    && raw.adapterId.trim().length <= MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH
    ? raw.adapterId.trim()
    : "";
  const path = normalizeExceptionPath(raw.path);
  const breakMode = raw.breakMode === "never"
    || raw.breakMode === "always"
    || raw.breakMode === "unhandled"
    || raw.breakMode === "userUnhandled"
    ? raw.breakMode
    : null;
  if (!id || !adapterId || !path || !breakMode || typeof raw.enabled !== "boolean") return null;
  return { id, adapterId, path, breakMode, enabled: raw.enabled };
}

function normalizeExceptionBreakpointRules(values: readonly unknown[]): DebugExceptionBreakpointRule[] {
  const normalized: DebugExceptionBreakpointRule[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const rule = normalizeExceptionBreakpointRule(value);
    if (!rule) continue;
    const key = exceptionBreakpointRuleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(rule);
    if (normalized.length >= MAX_EXCEPTION_BREAKPOINT_RULES) break;
  }
  return normalized;
}

function readBreakpoints(workspaceInstanceId: string): BreakpointMap {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(breakpointsKey(workspaceInstanceId)) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: BreakpointMap = {};
    for (const [path, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      out[path] = list
        .filter((bp): bp is DebugBreakpoint => !!bp && typeof (bp as DebugBreakpoint).line === "number")
        .map((bp) => ({
          line: bp.line,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
          enabled: bp.enabled,
          adapterModes: normalizeSourceBreakpointAdapterModes(bp.adapterModes),
        }));
    }
    return out;
  } catch {
    return {};
  }
}

function readWatches(workspaceInstanceId: string): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(watchesKey(workspaceInstanceId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readFunctionBreakpoints(workspaceInstanceId: string): DebugFunctionBreakpoint[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(functionBreakpointsKey(workspaceInstanceId)) ?? "[]",
    );
    return Array.isArray(parsed) ? normalizeFunctionBreakpoints(parsed) : [];
  } catch {
    return [];
  }
}

function readDataBreakpoints(workspaceInstanceId: string): DebugDataBreakpoint[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(dataBreakpointsKey(workspaceInstanceId)) ?? "[]",
    );
    return Array.isArray(parsed)
      ? normalizeDataBreakpoints(parsed).filter((breakpoint) => breakpoint.canPersist)
      : [];
  } catch {
    return [];
  }
}

function readExceptionBreakpoints(workspaceInstanceId: string): DebugExceptionBreakpoint[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(exceptionBreakpointsKey(workspaceInstanceId)) ?? "[]",
    );
    return Array.isArray(parsed) ? normalizeExceptionBreakpoints(parsed) : [];
  } catch {
    return [];
  }
}

function readExceptionBreakpointRules(workspaceInstanceId: string): DebugExceptionBreakpointRule[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(exceptionBreakpointRulesKey(workspaceInstanceId)) ?? "[]",
    );
    return Array.isArray(parsed) ? normalizeExceptionBreakpointRules(parsed) : [];
  } catch {
    return [];
  }
}
export function useCodeDebugSession(workspaceInstanceId: string): CodeDebugSession {
  const [state, setState] = useState<DebugSessionState | null>(null);
  const [breakpoints, setBreakpoints] = useState<BreakpointMap>(() => readBreakpoints(workspaceInstanceId));
  const [breakpointRuntime, setBreakpointRuntime] = useState<Record<string, Record<number, BreakpointRuntimeState>>>({});
  const [functionBreakpoints, setFunctionBreakpoints] = useState<DebugFunctionBreakpoint[]>(
    () => readFunctionBreakpoints(workspaceInstanceId),
  );
  const [functionBreakpointRuntime, setFunctionBreakpointRuntime] = useState<
    Record<string, BreakpointRuntimeState>
  >({});
  const [dataBreakpoints, setDataBreakpoints] = useState<DebugDataBreakpoint[]>(
    () => readDataBreakpoints(workspaceInstanceId),
  );
  const [dataBreakpointRuntime, setDataBreakpointRuntime] = useState<
    Record<string, BreakpointRuntimeState>
  >({});
  const [exceptionBreakpoints, setExceptionBreakpoints] = useState<DebugExceptionBreakpoint[]>(
    () => readExceptionBreakpoints(workspaceInstanceId),
  );
  const [exceptionBreakpointRuntime, setExceptionBreakpointRuntime] = useState<
    Record<string, BreakpointRuntimeState>
  >({});
  const [exceptionBreakpointRules, setExceptionBreakpointRules] = useState<
    DebugExceptionBreakpointRule[]
  >(() => readExceptionBreakpointRules(workspaceInstanceId));
  const [exceptionBreakpointRuleRuntime, setExceptionBreakpointRuleRuntime] = useState<
    Record<string, BreakpointRuntimeState>
  >({});
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
  const [availableFilters, setAvailableFilters] = useState<DebugExceptionBreakpointFilter[]>([]);
  const [watchExpressions, setWatchExpressions] = useState<string[]>(() => readWatches(workspaceInstanceId));
  const [canRestart, setCanRestart] = useState(false);
  const [breakpointsMuted, setBreakpointsMutedState] = useState(false);
  const [frameVariables, setFrameVariables] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<DebugSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const sessionsRef = useRef(new Map<string, DebugSessionRecord>());
  const abortedScopesRef = useRef(new Set<string>());
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<Record<string, unknown>>({});
  const breakpointsRef = useRef(breakpoints);
  const functionBreakpointsRef = useRef(functionBreakpoints);
  const dataBreakpointsRef = useRef(dataBreakpoints);
  const exceptionBreakpointsRef = useRef(exceptionBreakpoints);
  const exceptionBreakpointRulesRef = useRef(exceptionBreakpointRules);
  const mutedRef = useRef(breakpointsMuted);
  const stateRef = useRef<DebugSessionState | null>(null);
  const mountedRef = useMountedRef();
  /** Bumped on every `stopped` event; async work checks it to drop stale results. */
  const stopEpochRef = useRef(0);
  /** Adapter breakpoint id → file path, to route `breakpoint` events. */
  const bpIdIndexRef = useRef(new Map<number, { path: string }>());
  /** Per-path `setBreakpoints` generation, so a late response cannot win. */
  const syncGenerationRef = useRef(new Map<string, number>());
  /** Pending run-to-cursor: its transient breakpoint is removed on the next stop. */
  const tempRunToCursorRef = useRef<{ path: string } | null>(null);
  const lastLaunchRef = useRef<LastDebugLaunch | null>(null);
  /** Whether the adapter has emitted `initialized` for the current session. */
  const initializedRef = useRef(false);
  breakpointsRef.current = breakpoints;
  functionBreakpointsRef.current = functionBreakpoints;
  dataBreakpointsRef.current = dataBreakpoints;
  exceptionBreakpointsRef.current = exceptionBreakpoints;
  exceptionBreakpointRulesRef.current = exceptionBreakpointRules;
  mutedRef.current = breakpointsMuted;
  stateRef.current = state;

  const publishSessionList = useCallback(() => {
    if (!mountedRef.current) return;
    setSessions(Array.from(sessionsRef.current.values())
      .sort((left, right) => left.order - right.order)
      .map((record) => ({
        id: record.id,
        targetId: record.targetId,
        label: record.label,
        adapterId: record.adapterId,
        status: record.state.status,
        stoppedReason: record.state.stoppedReason,
      })));
  }, []);

  const publishActiveSession = useCallback((record: DebugSessionRecord | null) => {
    activeSessionIdRef.current = record?.id ?? null;
    sessionIdRef.current = record?.live ? record.id : null;
    capabilitiesRef.current = record?.capabilities ?? {};
    stopEpochRef.current = record?.stopEpoch ?? 0;
    bpIdIndexRef.current = record?.bpIdIndex ?? new Map();
    syncGenerationRef.current = record?.syncGeneration ?? new Map();
    tempRunToCursorRef.current = record?.tempRunToCursor ?? null;
    initializedRef.current = record?.initialized ?? false;
    stateRef.current = record?.state ?? null;
    if (!mountedRef.current) return;
    setActiveSessionId(record?.id ?? null);
    setState(record?.state ?? null);
    setCapabilities(record?.capabilities ?? {});
    setAvailableFilters(record?.availableFilters ?? []);
    setBreakpointRuntime(record?.breakpointRuntime ?? {});
    setFunctionBreakpointRuntime(record?.functionBreakpointRuntime ?? {});
    setDataBreakpointRuntime(record?.dataBreakpointRuntime ?? {});
    setExceptionBreakpointRuntime(record?.exceptionBreakpointRuntime ?? {});
    setExceptionBreakpointRuleRuntime(record?.exceptionBreakpointRuleRuntime ?? {});
    setFrameVariables(record?.frameVariables ?? {});
  }, []);

  const updateSessionState = useCallback((
    sessionId: string,
    updater: (current: DebugSessionState) => DebugSessionState,
  ) => {
    const record = sessionsRef.current.get(sessionId);
    if (!record) return;
    record.state = updater(record.state);
    if (activeSessionIdRef.current === sessionId) {
      stateRef.current = record.state;
      if (mountedRef.current) setState(record.state);
    }
    publishSessionList();
  }, [publishSessionList]);

  const selectSession = useCallback((sessionId: string) => {
    const record = sessionsRef.current.get(sessionId);
    if (record) publishActiveSession(record);
  }, [publishActiveSession]);

  // Drop the adapter session with the hook. `mountedRef` re-arms itself (see
  // useMountedRef) so the StrictMode dev double-invoke cannot leave it false.
  useEffect(() => () => {
    for (const record of sessionsRef.current.values()) {
      record.unlisten?.();
      if (record.live) void dapTerminate(record.id).catch(() => {});
    }
    sessionsRef.current.clear();
  }, []);

  // Inline values are only meaningful while stopped: drop them the moment the
  // debuggee resumes or the session ends, so stale numbers never sit in the
  // editor gutter.
  const debugStatus = state?.status ?? null;
  useEffect(() => {
    if (debugStatus !== "stopped") {
      const active = activeSessionIdRef.current
        ? sessionsRef.current.get(activeSessionIdRef.current)
        : undefined;
      if (active) active.frameVariables = {};
      setFrameVariables({});
    }
  }, [debugStatus]);

  const persistBreakpoints = useCallback((next: BreakpointMap) => {
    try {
      window.localStorage.setItem(breakpointsKey(workspaceInstanceId), JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  const persistFunctionBreakpoints = useCallback((next: DebugFunctionBreakpoint[]) => {
    try {
      window.localStorage.setItem(functionBreakpointsKey(workspaceInstanceId), JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  const persistDataBreakpoints = useCallback((next: DebugDataBreakpoint[]) => {
    try {
      window.localStorage.setItem(
        dataBreakpointsKey(workspaceInstanceId),
        JSON.stringify(next.filter((breakpoint) => breakpoint.canPersist)),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  const persistExceptionBreakpoints = useCallback((next: DebugExceptionBreakpoint[]) => {
    try {
      window.localStorage.setItem(
        exceptionBreakpointsKey(workspaceInstanceId),
        JSON.stringify(next),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  const persistExceptionBreakpointRules = useCallback((next: DebugExceptionBreakpointRule[]) => {
    try {
      window.localStorage.setItem(
        exceptionBreakpointRulesKey(workspaceInstanceId),
        JSON.stringify(next),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  const persistWatches = useCallback((next: string[]) => {
    try {
      window.localStorage.setItem(watchesKey(workspaceInstanceId), JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  const updateActiveState = useCallback((
    updater: (current: DebugSessionState) => DebugSessionState,
  ) => {
    const id = activeSessionIdRef.current;
    if (id && sessionsRef.current.has(id)) {
      updateSessionState(id, updater);
      return;
    }
    setState((prev) => (prev ? updater(prev) : prev));
  }, [updateSessionState]);

  const logConsole = useCallback((category: string, text: string) => {
    if (!text) return;
    updateActiveState((prev) => ({
      ...prev,
      output: [...prev.output, { category, text }].slice(-2000),
    }));
  }, [updateActiveState]);

  const clearConsole = useCallback(() => {
    updateActiveState((prev) => (prev.output.length > 0 ? { ...prev, output: [] } : prev));
  }, [updateActiveState]);

  /**
   * Show a launch failure in the Debug panel. When a session is already present
   * (e.g. `dapStartSession` succeeded but `launch` was rejected) the message is
   * appended and the session marked terminated; otherwise a minimal terminated
   * session is seeded so the panel renders its console instead of the empty
   * "no debug session" placeholder. The seeded session has an empty id, so it is
   * inert (no adapter events match it, terminate is a no-op) and the next Start
   * replaces it.
   */
  const reportStartupFailure = useCallback((message: string) => {
    if (!mountedRef.current) return;
    const text = message.endsWith("\n") ? message : `${message}\n`;
    const active = activeSessionIdRef.current;
    if (active && sessionsRef.current.has(active)) {
      const record = sessionsRef.current.get(active)!;
      updateSessionState(active, (prev) => appendConsoleLine(
        record.live ? prev : { ...prev, status: "terminated" },
        "stderr",
        text,
      ));
    } else {
      // Pre-adapter steps can complete in one React batch. Mirror the update
      // synchronously so a following startDebug can carry every queued line.
      const current = stateRef.current;
      const next = appendConsoleLine(
        current
          ? { ...current, status: "terminated" }
          : { ...initialDebugState(""), status: "terminated" },
        "stderr",
        text,
      );
      stateRef.current = next;
      setState(next);
    }
  }, [updateSessionState]);

  /**
   * Show a pre-launch step in the panel. Seeds a `starting` session (empty id →
   * inert: no adapter events match it and terminate is a no-op) so the console
   * is on screen from the first click; a prior terminated session is replaced
   * rather than appended to, so stale output from the last run is not mistaken
   * for this one.
   */
  const reportStartupProgress = useCallback((message: string) => {
    if (!mountedRef.current) return;
    const text = message.endsWith("\n") ? message : `${message}\n`;
    const active = activeSessionIdRef.current;
    if (active && sessionsRef.current.has(active)) {
      updateSessionState(active, (prev) => appendConsoleLine(prev, "console", text));
    } else {
      // Keep the inert startup session coherent before React flushes state.
      // Build, resolve and launch commonly finish inside the same async batch.
      const current = stateRef.current;
      const next = appendConsoleLine(
        current && current.status !== "terminated" ? current : initialDebugState(""),
        "console",
        text,
      );
      stateRef.current = next;
      setState(next);
    }
  }, [updateSessionState]);

  /**
   * Push a file's breakpoints to the adapter and record the bindings it
   * reports: verified flags feed the gutter (grey = not bound), verified line
   * adjustments are adopted back into the stored set (IDEA/VS Code move a
   * breakpoint on a blank line to the next executable one).
   *
   * `list` MUST be passed by callers that just changed the set — React state
   * (and the ref mirroring it) is not updated until the next render, so reading
   * it here would send the pre-change set and the new breakpoint would never
   * arm. `extraTempLine` injects the transient run-to-cursor breakpoint without
   * persisting it.
   */
  const syncBreakpointsForPath = useCallback(async (
    path: string,
    options: { list?: DebugBreakpoint[]; extraTempLine?: number; sessionIds?: readonly string[] } = {},
  ) => {
    const stored = options.list ?? breakpointsRef.current[path] ?? [];
    const plan = planBreakpointSync(stored, {
      muted: mutedRef.current,
      extraLine: options.extraTempLine,
    });
    const requestedIds = options.sessionIds ?? Array.from(sessionsRef.current.values())
      .filter((record) => record.live)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record = sessionsRef.current.get(id);
      if (!record?.live) return;
      // Two quick toggles on the same file put two requests in flight; an older
      // response landing last would otherwise re-apply the set it was built from.
      const generation = (record.syncGeneration.get(path) ?? 0) + 1;
      record.syncGeneration.set(path, generation);
      const args = buildSetBreakpointsArgs(path, plan, {
        adapterId: record.adapterId,
        breakpointModes: parseBreakpointModes(record.capabilities),
      });
      args.source.path = toAdapterSourcePath(path);
      const body = await dapSendRequest(id, "setBreakpoints", args).catch((error) => {
        updateSessionState(id, (current) => appendConsoleLine(
          current,
          "stderr",
          `setBreakpoints for ${path.split(/[\\/]/).pop() ?? path} failed: ${errorText(error)}\n`,
        ));
        return null;
      });
      if (body == null || !mountedRef.current) return;
      const current = sessionsRef.current.get(id);
      if (!current || current.syncGeneration.get(path) !== generation) return;
      const bindings = parseSetBreakpointsResponse(plan, body);
      for (const binding of bindings) {
        if (binding.id != null) current.bpIdIndex.set(binding.id, { kind: "source", path });
      }
      current.breakpointRuntime = {
        ...current.breakpointRuntime,
        [path]: breakpointVerificationMap(plan, bindings),
      };
      if (activeSessionIdRef.current === id) setBreakpointRuntime(current.breakpointRuntime);
      // Different adapters may bind the same source differently. Only the
      // selected session is allowed to move the persisted gutter breakpoint.
      if (options.extraTempLine == null && activeSessionIdRef.current === id) {
        const reconciled = reconcileBreakpointLines(plan, bindings);
        if (JSON.stringify(reconciled) !== JSON.stringify(plan.sorted)) {
          const next = { ...breakpointsRef.current };
          if (reconciled.length > 0) next[path] = reconciled;
          else delete next[path];
          breakpointsRef.current = next;
          setBreakpoints(next);
          persistBreakpoints(next);
        }
      }
    }));
  }, [persistBreakpoints, updateSessionState]);

  /** Push the workspace function/method breakpoints to every eligible session. */
  const syncFunctionBreakpoints = useCallback(async (
    options: {
      list?: DebugFunctionBreakpoint[];
      sessionIds?: readonly string[];
    } = {},
  ) => {
    const stored = options.list ?? functionBreakpointsRef.current;
    const plan = planFunctionBreakpointSync(stored, { muted: mutedRef.current });
    const requestedIds = options.sessionIds ?? Array.from(sessionsRef.current.values())
      .filter((record) => record.live && record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record = sessionsRef.current.get(id);
      if (!record?.live || !record.initialized) return;
      const generation = record.functionSyncGeneration + 1;
      record.functionSyncGeneration = generation;
      for (const [breakpointId, entry] of record.bpIdIndex) {
        if (entry.kind === "function") record.bpIdIndex.delete(breakpointId);
      }

      const publishRuntime = (runtime: Record<string, BreakpointRuntimeState>) => {
        const current = sessionsRef.current.get(id);
        if (!current?.live || current.functionSyncGeneration !== generation) return;
        current.functionBreakpointRuntime = runtime;
        if (activeSessionIdRef.current === id && mountedRef.current) {
          setFunctionBreakpointRuntime(runtime);
        }
      };

      if (record.capabilities.supportsFunctionBreakpoints !== true) {
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          breakpoint.name,
          {
            status: "failed" as const,
            message: "The selected debug adapter does not support function breakpoints",
          },
        ])));
        return;
      }

      publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
        breakpoint.name,
        { status: "pending" as const, message: null },
      ])));

      const body = await dapSendRequest(
        id,
        "setFunctionBreakpoints",
        buildSetFunctionBreakpointsArgs(plan),
      ).catch((error) => {
        const current = sessionsRef.current.get(id);
        if (!current?.live || current.functionSyncGeneration !== generation) return null;
        const message = errorText(error);
        updateSessionState(id, (current) => appendConsoleLine(
          current,
          "stderr",
          `setFunctionBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          breakpoint.name,
          { status: "failed" as const, message },
        ])));
        return null;
      });
      if (body == null || !mountedRef.current) return;
      const current = sessionsRef.current.get(id);
      if (!current?.live || current.functionSyncGeneration !== generation) return;
      const bindings = parseSetFunctionBreakpointsResponse(plan, body);
      for (const binding of bindings) {
        if (binding.id != null) {
          current.bpIdIndex.set(binding.id, { kind: "function", name: binding.name });
        }
      }
      publishRuntime(functionBreakpointVerificationMap(plan, bindings));
    }));
  }, [updateSessionState]);

  /** Replace the data-breakpoint set in every initialized adapter session. */
  const syncDataBreakpoints = useCallback(async (
    options: {
      list?: DebugDataBreakpoint[];
      sessionIds?: readonly string[];
    } = {},
  ) => {
    const stored = options.list ?? dataBreakpointsRef.current;
    const requestedIds = options.sessionIds ?? Array.from(sessionsRef.current.values())
      .filter((record) => record.live && record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record = sessionsRef.current.get(id);
      if (!record?.live || !record.initialized) return;
      const plan = planDataBreakpointSync(stored, {
        adapterId: record.adapterId,
        sessionId: record.id,
        muted: mutedRef.current,
      });
      const generation = record.dataSyncGeneration + 1;
      record.dataSyncGeneration = generation;
      for (const [breakpointId, entry] of record.bpIdIndex) {
        if (entry.kind === "data") record.bpIdIndex.delete(breakpointId);
      }

      const publishRuntime = (runtime: Record<string, BreakpointRuntimeState>) => {
        const current = sessionsRef.current.get(id);
        if (!current?.live || current.dataSyncGeneration !== generation) return;
        current.dataBreakpointRuntime = runtime;
        if (activeSessionIdRef.current === id && mountedRef.current) {
          setDataBreakpointRuntime(runtime);
        }
      };

      if (record.capabilities.supportsDataBreakpoints !== true) {
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          dataBreakpointKey(breakpoint),
          {
            status: "failed" as const,
            message: "The selected debug adapter does not support data breakpoints",
          },
        ])));
        return;
      }

      publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
        dataBreakpointKey(breakpoint),
        { status: "pending" as const, message: null },
      ])));
      const body = await dapSendRequest(
        id,
        "setDataBreakpoints",
        buildSetDataBreakpointsArgs(plan),
      ).catch((error) => {
        const current = sessionsRef.current.get(id);
        if (!current?.live || current.dataSyncGeneration !== generation) return null;
        const message = errorText(error);
        updateSessionState(id, (currentState) => appendConsoleLine(
          currentState,
          "stderr",
          `setDataBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          dataBreakpointKey(breakpoint),
          { status: "failed" as const, message },
        ])));
        return null;
      });
      if (body == null || !mountedRef.current) return;
      const current = sessionsRef.current.get(id);
      if (!current?.live || current.dataSyncGeneration !== generation) return;
      const bindings = parseSetDataBreakpointsResponse(plan, body);
      for (const binding of bindings) {
        if (binding.id != null) {
          current.bpIdIndex.set(binding.id, { kind: "data", key: binding.key });
        }
      }
      publishRuntime(dataBreakpointVerificationMap(plan, bindings));
    }));
  }, [updateSessionState]);

  /** Replace exception filters and class/package rules for initialized sessions. */
  const syncExceptionBreakpoints = useCallback(async (
    options: {
      list?: DebugExceptionBreakpoint[];
      rules?: DebugExceptionBreakpointRule[];
      sessionIds?: readonly string[];
    } = {},
  ) => {
    const stored = options.list ?? exceptionBreakpointsRef.current;
    const storedRules = options.rules ?? exceptionBreakpointRulesRef.current;
    const requestedIds = options.sessionIds ?? Array.from(sessionsRef.current.values())
      .filter((record) => record.live && record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record = sessionsRef.current.get(id);
      if (!record?.live || !record.initialized) return;
      const generation = record.exceptionSyncGeneration + 1;
      record.exceptionSyncGeneration = generation;
      for (const [breakpointId, entry] of record.bpIdIndex) {
        if (entry.kind === "exception-filter" || entry.kind === "exception-rule") {
          record.bpIdIndex.delete(breakpointId);
        }
      }

      const publishRuntime = (
        filterRuntime: Record<string, BreakpointRuntimeState>,
        ruleRuntime: Record<string, BreakpointRuntimeState>,
      ) => {
        const current = sessionsRef.current.get(id);
        if (!current?.live || current.exceptionSyncGeneration !== generation) return;
        current.exceptionBreakpointRuntime = filterRuntime;
        current.exceptionBreakpointRuleRuntime = ruleRuntime;
        if (activeSessionIdRef.current === id && mountedRef.current) {
          setExceptionBreakpointRuntime(filterRuntime);
          setExceptionBreakpointRuleRuntime(ruleRuntime);
        }
      };

      // DAP requires clients to call setExceptionBreakpoints only when the
      // adapter advertised at least one exception filter.
      if (record.availableFilters.length === 0) {
        publishRuntime({}, {});
        return;
      }
      const supportsExceptionOptions = record.capabilities.supportsExceptionOptions === true;
      const plan = planExceptionBreakpointSync(stored, storedRules, record.availableFilters, {
        adapterId: record.adapterId,
        muted: mutedRef.current,
        supportsFilterOptions: record.capabilities.supportsExceptionFilterOptions === true,
        supportsExceptionOptions,
        breakpointModes: parseBreakpointModes(record.capabilities),
      });
      const unsupportedRuleRuntime = !supportsExceptionOptions && !mutedRef.current
        ? Object.fromEntries(plan.applicableRules
          .filter((rule) => rule.enabled)
          .map((rule) => [
            rule.id,
            {
              status: "failed" as const,
              message: "The selected debug adapter does not support exception path rules",
            },
          ]))
        : {};
      const sentFilters = [...plan.plain, ...plan.options.map((entry) => entry.breakpoint)];
      publishRuntime(Object.fromEntries(sentFilters.map((breakpoint) => [
        breakpoint.filterId,
        { status: "pending" as const, message: null },
      ])), supportsExceptionOptions
        ? Object.fromEntries(plan.rules.map((rule) => [
          rule.id,
          { status: "pending" as const, message: null },
        ]))
        : unsupportedRuleRuntime);
      const body = await dapSendRequest(
        id,
        "setExceptionBreakpoints",
        buildSetExceptionBreakpointsArgs(plan),
      ).catch((error) => {
        const current = sessionsRef.current.get(id);
        if (!current?.live || current.exceptionSyncGeneration !== generation) return null;
        const message = errorText(error);
        updateSessionState(id, (currentState) => appendConsoleLine(
          currentState,
          "stderr",
          `setExceptionBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(sentFilters.map((breakpoint) => [
          breakpoint.filterId,
          { status: "failed" as const, message },
        ])), supportsExceptionOptions
          ? Object.fromEntries(plan.rules.map((rule) => [
            rule.id,
            { status: "failed" as const, message },
          ]))
          : unsupportedRuleRuntime);
        return null;
      });
      if (body == null || !mountedRef.current) return;
      const current = sessionsRef.current.get(id);
      if (!current?.live || current.exceptionSyncGeneration !== generation) return;
      const bindings = parseSetExceptionBreakpointsResponse(plan, body);
      for (const binding of bindings) {
        if (binding.id != null) {
          current.bpIdIndex.set(binding.id, binding.kind === "filter"
            ? { kind: "exception-filter", filterId: binding.filterId }
            : { kind: "exception-rule", ruleId: binding.ruleId });
        }
      }
      publishRuntime(
        exceptionBreakpointVerificationMap(plan, bindings),
        supportsExceptionOptions
          ? exceptionBreakpointRuleVerificationMap(plan, bindings)
          : unsupportedRuleRuntime,
      );
    }));
  }, [updateSessionState]);

  const dropSessionDataBreakpoints = useCallback((sessionIds: ReadonlySet<string>) => {
    const current = dataBreakpointsRef.current;
    const next = current.filter((breakpoint) => (
      !breakpoint.sessionId || !sessionIds.has(breakpoint.sessionId)
    ));
    if (next.length === current.length) return;
    dataBreakpointsRef.current = next;
    if (mountedRef.current) setDataBreakpoints(next);
  }, []);

  /**
   * Single mutation path for the breakpoint map. Updates the ref synchronously
   * (so an immediately-following adapter sync sees the new set), persists, and
   * pushes the changed file to a live adapter.
   */
  const mutateBreakpoints = useCallback((
    path: string,
    updater: (list: DebugBreakpoint[]) => DebugBreakpoint[],
    options: { sessionIds?: readonly string[] } = {},
  ) => {
    const nextList = updater(breakpointsRef.current[path] ?? []);
    const next = { ...breakpointsRef.current };
    if (nextList.length > 0) next[path] = nextList;
    else delete next[path];
    breakpointsRef.current = next;
    setBreakpoints(next);
    persistBreakpoints(next);
    void syncBreakpointsForPath(path, { list: nextList, sessionIds: options.sessionIds });
  }, [persistBreakpoints, syncBreakpointsForPath]);

  /**
   * Snapshot the frame's local variables as `name → value` for the editor's
   * inline values (IDEA renders them next to the code). Only the first scope is
   * read: adapters list locals first, and globals/statics are neither on screen
   * nor worth an extra round trip on every step.
   */
  const refreshFrameVariables = useCallback(async (frameId: number, epoch: number) => {
    const id = sessionIdRef.current;
    const record = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !record) return;
    const scopesBody = await dapSendRequest(id, "scopes", { frameId }).catch(() => null);
    const scopes = (scopesBody as { scopes?: unknown } | null)?.scopes;
    const localRef = Array.isArray(scopes)
      ? scopes
        .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
        .find((s) => typeof s.variablesReference === "number" && s.variablesReference > 0)
      : undefined;
    const ref = typeof localRef?.variablesReference === "number" ? localRef.variablesReference : 0;
    if (ref <= 0) {
      if (mountedRef.current && record.stopEpoch === epoch) {
        record.frameVariables = {};
        if (activeSessionIdRef.current === id) setFrameVariables({});
      }
      return;
    }
    const body = await dapSendRequest(id, "variables", { variablesReference: ref }).catch(() => null);
    const list = (body as { variables?: unknown } | null)?.variables;
    const map: Record<string, string> = {};
    if (Array.isArray(list)) {
      for (const entry of list) {
        const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        if (typeof rec.name === "string" && typeof rec.value === "string") map[rec.name] = rec.value;
      }
    }
    if (mountedRef.current && record.stopEpoch === epoch) {
      record.frameVariables = map;
      if (activeSessionIdRef.current === id) setFrameVariables(map);
    }
  }, []);

  /** After a `stopped` event, pull threads + stack + exception details for the UI. */
  const refreshStoppedContext = useCallback(async (
    sessionId: string,
    threadId: number | null,
    reason: string | null,
    epoch: number,
  ) => {
    const record = sessionsRef.current.get(sessionId);
    if (!record) return;
    const threadsBody = await dapSendRequest(sessionId, "threads").catch(() => null);
    const threads = parseThreads(threadsBody);
    const tid = threadId ?? threads[0]?.id ?? null;
    let frames: DebugStackFrame[] = [];
    if (tid != null) {
      const stackBody = await dapSendRequest(sessionId, "stackTrace", { threadId: tid, startFrame: 0, levels: 40 })
        .catch(() => null);
      frames = parseStackFrames(stackBody);
    }
    if (!mountedRef.current || record.stopEpoch !== epoch) return;
    updateSessionState(sessionId, (prev) => (prev.status === "stopped"
      ? { ...prev, threads, frames, selectedThreadId: tid, selectedFrameId: frames[0]?.id ?? null }
      : prev));
    if (frames[0] && activeSessionIdRef.current === sessionId) {
      void refreshFrameVariables(frames[0].id, epoch);
    }
    // IDEA-style exception details when the stop is an exception break.
    if (
      tid != null
      && typeof reason === "string" && reason.toLowerCase().includes("exception")
      && record.capabilities.supportsExceptionInfoRequest === true
    ) {
      const info = parseExceptionInfo(
        await dapSendRequest(sessionId, "exceptionInfo", { threadId: tid }).catch(() => null),
      );
      if (info && mountedRef.current && record.stopEpoch === epoch) {
        updateSessionState(sessionId, (prev) => (prev.status === "stopped" ? { ...prev, exceptionInfo: info } : prev));
      }
    }
  }, [refreshFrameVariables, updateSessionState]);

  const handleEvent = useCallback((payload: DapEventPayload) => {
    const record = sessionsRef.current.get(payload.sessionId);
    if (!record) return;
    updateSessionState(payload.sessionId, (prev) => reduceDebugEvent(prev, payload.event, payload.message));
    if (payload.event === "initialized") {
      record.initialized = true;
      if (record.launchAccepted && !record.readySettled) {
        record.readySettled = true;
        record.readyResolve();
      }
      if (activeSessionIdRef.current === record.id) initializedRef.current = true;
      // Configure breakpoints before the debuggee runs, then release it.
      void (async () => {
        const id = record.id;
        if (!record.live) return;
        for (const path of Object.keys(breakpointsRef.current)) {
          if ((breakpointsRef.current[path] ?? []).length > 0) {
            await syncBreakpointsForPath(path, { sessionIds: [id] });
          }
        }
        await syncFunctionBreakpoints({ sessionIds: [id] });
        await syncDataBreakpoints({ sessionIds: [id] });
        await syncExceptionBreakpoints({ sessionIds: [id] });
        await dapSend(id, "configurationDone").catch((error) => {
          updateSessionState(id, (current) => appendConsoleLine(
            current,
            "stderr",
            `configurationDone failed: ${errorText(error)}\n`,
          ));
        });
      })();
    } else if (payload.event === "stopped") {
      record.stopEpoch += 1;
      // Follow the child that actually paused, as IDEA does for compound runs.
      publishActiveSession(record);
      // Run-to-cursor's transient breakpoint is one-shot: restore the user set.
      const temp = record.tempRunToCursor;
      record.tempRunToCursor = null;
      tempRunToCursorRef.current = null;
      if (temp) void syncBreakpointsForPath(temp.path, { sessionIds: [record.id] });
      const body = (payload.message as { body?: { threadId?: number; reason?: string } })?.body;
      void refreshStoppedContext(record.id, body?.threadId ?? null, body?.reason ?? null, record.stopEpoch);
    } else if (payload.event === "breakpoint") {
      const parsed = parseBreakpointEvent(payload.message);
      const entry = parsed?.id != null ? record.bpIdIndex.get(parsed.id) : undefined;
      if (parsed && entry) {
        const { verified } = parsed;
        const runtime: BreakpointRuntimeState = verified
          ? { status: "verified", message: null }
          : { status: parsed.bindReason === "failed" ? "failed" : "pending", message: parsed.message };
        if (entry.kind === "source" && parsed.line != null) {
          record.breakpointRuntime = {
            ...record.breakpointRuntime,
            [entry.path]: {
              ...(record.breakpointRuntime[entry.path] ?? {}),
              [parsed.line]: runtime,
            },
          };
          if (activeSessionIdRef.current === record.id) setBreakpointRuntime(record.breakpointRuntime);
        } else if (entry.kind === "function") {
          record.functionBreakpointRuntime = {
            ...record.functionBreakpointRuntime,
            [entry.name]: runtime,
          };
          if (activeSessionIdRef.current === record.id) {
            setFunctionBreakpointRuntime(record.functionBreakpointRuntime);
          }
        } else if (entry.kind === "data") {
          record.dataBreakpointRuntime = {
            ...record.dataBreakpointRuntime,
            [entry.key]: runtime,
          };
          if (activeSessionIdRef.current === record.id) {
            setDataBreakpointRuntime(record.dataBreakpointRuntime);
          }
        } else if (entry.kind === "exception-filter") {
          record.exceptionBreakpointRuntime = {
            ...record.exceptionBreakpointRuntime,
            [entry.filterId]: runtime,
          };
          if (activeSessionIdRef.current === record.id) {
            setExceptionBreakpointRuntime(record.exceptionBreakpointRuntime);
          }
        } else if (entry.kind === "exception-rule") {
          record.exceptionBreakpointRuleRuntime = {
            ...record.exceptionBreakpointRuleRuntime,
            [entry.ruleId]: runtime,
          };
          if (activeSessionIdRef.current === record.id) {
            setExceptionBreakpointRuleRuntime(record.exceptionBreakpointRuleRuntime);
          }
        }
      }
    } else if (payload.event === "terminated" || payload.event === "exited") {
      // Free the backend session (drops the adapter transport / child); the final
      // state stays visible in the panel until the next start.
      record.live = false;
      record.functionSyncGeneration += 1;
      record.dataSyncGeneration += 1;
      record.exceptionSyncGeneration += 1;
      if (!record.readySettled) {
        record.readySettled = true;
        record.readyReject(new Error(`${record.label} terminated before the debug adapter became ready`));
      }
      record.unlisten?.();
      record.unlisten = null;
      record.bpIdIndex.clear();
      record.tempRunToCursor = null;
      record.breakpointRuntime = {};
      record.functionBreakpointRuntime = {};
      record.dataBreakpointRuntime = {};
      record.exceptionBreakpointRuntime = {};
      record.exceptionBreakpointRuleRuntime = {};
      record.frameVariables = {};
      void dapTerminate(record.id).catch(() => {});
      dropSessionDataBreakpoints(new Set([record.id]));
      if (activeSessionIdRef.current === record.id) {
        const fallback = Array.from(sessionsRef.current.values())
          .filter((candidate) => candidate.live)
          .sort((left, right) => left.order - right.order)[0] ?? record;
        publishActiveSession(fallback);
      } else {
        publishSessionList();
      }
    }
  }, [
    publishActiveSession,
    publishSessionList,
    refreshStoppedContext,
    syncBreakpointsForPath,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    syncFunctionBreakpoints,
    dropSessionDataBreakpoints,
    updateSessionState,
  ]);

  const terminateSessions = useCallback(async (scopeIds?: ReadonlySet<string>) => {
    const records = Array.from(sessionsRef.current.values()).filter((record) => (
      !scopeIds || record.abortScopeIds.some((scopeId) => scopeIds.has(scopeId))
    ));
    await Promise.all(records.map(async (record) => {
      record.unlisten?.();
      record.unlisten = null;
      const live = record.live;
      record.live = false;
      record.functionSyncGeneration += 1;
      record.dataSyncGeneration += 1;
      record.exceptionSyncGeneration += 1;
      record.state = {
        ...record.state,
        status: "terminated",
        stoppedThreadId: null,
        selectedThreadId: null,
        selectedFrameId: null,
        frames: [],
        exceptionInfo: null,
      };
      record.breakpointRuntime = {};
      record.functionBreakpointRuntime = {};
      record.dataBreakpointRuntime = {};
      record.exceptionBreakpointRuntime = {};
      record.exceptionBreakpointRuleRuntime = {};
      record.frameVariables = {};
      record.bpIdIndex.clear();
      record.tempRunToCursor = null;
      if (live) await dapTerminate(record.id).catch(() => {});
      if (!record.readySettled) {
        record.readySettled = true;
        record.readyReject(new Error(`${record.label} was stopped before startup completed`));
      }
    }));
    dropSessionDataBreakpoints(new Set(records.map((record) => record.id)));
    if (!scopeIds) {
      const active = activeSessionIdRef.current
        ? sessionsRef.current.get(activeSessionIdRef.current) ?? null
        : null;
      publishActiveSession(active);
    } else {
      const active = activeSessionIdRef.current
        ? sessionsRef.current.get(activeSessionIdRef.current) ?? null
        : null;
      if (active && !active.live) {
        const fallback = Array.from(sessionsRef.current.values()).find((record) => record.live)
          ?? active;
        publishActiveSession(fallback);
      }
    }
    publishSessionList();
  }, [dropSessionDataBreakpoints, publishActiveSession, publishSessionList]);

  const clearSessions = useCallback(async () => {
    await terminateSessions();
    sessionsRef.current.clear();
    abortedScopesRef.current.clear();
    publishActiveSession(null);
    publishSessionList();
  }, [publishActiveSession, publishSessionList, terminateSessions]);

  const launchTarget = useCallback(async (
    target: DebugLaunchTarget,
    order: number,
    abortScopeIds: string[],
  ): Promise<DebugSessionRecord> => {
    let result: Awaited<ReturnType<typeof dapStartSession>>;
    try {
      result = await dapStartSession(target.adapterId, target.launchConfig);
    } catch (error) {
      // Adapter resolution failures (no jdtls session, no main class, no
      // debug bundle, classpath/port resolution) reject here. Surface them in
      // the Debug panel — not just the caller's status bar — then rethrow so
      // existing callers keep their behavior.
      throw error;
    }
    if (abortScopeIds.some((scopeId) => abortedScopesRef.current.has(scopeId))) {
      await dapTerminate(result.sessionId).catch(() => {});
      throw new Error(`Debug launch was cancelled after another child failed: ${target.label}`);
    }
    const filters = parseExceptionBreakpointFilters(result.capabilities);
    const mergedExceptionBreakpoints = mergeExceptionBreakpointDefaults(
      exceptionBreakpointsRef.current,
      target.adapterId,
      filters,
    );
    if (mergedExceptionBreakpoints !== exceptionBreakpointsRef.current) {
      const next = normalizeExceptionBreakpoints(mergedExceptionBreakpoints);
      exceptionBreakpointsRef.current = next;
      if (mountedRef.current) setExceptionBreakpoints(next);
      persistExceptionBreakpoints(next);
    }
    const carried = sessionsRef.current.size === 0 && stateRef.current?.sessionId === ""
      ? stateRef.current.output
      : [];
    const initial = initialDebugState(result.sessionId);
    let readyResolve = () => {};
    let readyReject = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A single-session caller does not await readiness; keep a rejected launch
    // from becoming an unhandled promise while the DAP error is surfaced below.
    void ready.catch(() => {});
    const record: DebugSessionRecord = {
      id: result.sessionId,
      order,
      targetId: target.id,
      label: target.label,
      adapterId: target.adapterId,
      launchConfig: target.launchConfig,
      state: { ...initial, status: "running", output: carried },
      capabilities: result.capabilities,
      availableFilters: filters,
      breakpointRuntime: {},
      functionBreakpointRuntime: {},
      dataBreakpointRuntime: {},
      exceptionBreakpointRuntime: {},
      exceptionBreakpointRuleRuntime: {},
      frameVariables: {},
      initialized: false,
      launchAccepted: false,
      live: true,
      unlisten: null,
      stopEpoch: 0,
      bpIdIndex: new Map(),
      syncGeneration: new Map(),
      functionSyncGeneration: 0,
      dataSyncGeneration: 0,
      exceptionSyncGeneration: 0,
      tempRunToCursor: null,
      abortScopeIds,
      ready,
      readyResolve,
      readyReject,
      readySettled: false,
    };
    sessionsRef.current.set(record.id, record);
    publishSessionList();
    if (mountedRef.current) setCanRestart(true);
    if (!activeSessionIdRef.current) publishActiveSession(record);
    // Listen before firing launch so the `initialized` event can't be missed.
    try {
      record.unlisten = await listenDapEvents(result.sessionId, handleEvent);
    } catch (error) {
      sessionsRef.current.delete(record.id);
      record.live = false;
      record.functionSyncGeneration += 1;
      record.dataSyncGeneration += 1;
      record.exceptionSyncGeneration += 1;
      await dapTerminate(record.id).catch(() => {});
      publishSessionList();
      throw error;
    }
    // Fire launch/attach as a correlated request but do NOT await it here: the
    // response only arrives after configurationDone (awaiting would deadlock
    // the initialized → setBreakpoints → configurationDone sequence). The
    // correlation exists to surface failures — when the launch fails the
    // adapter never emits `initialized`, so without this the error response is
    // silently dropped and the UI sits at "running" forever.
    const launchedSession = result.sessionId;
    void dapSendRequest(launchedSession, result.request, result.arguments).then(() => {
      const launched = sessionsRef.current.get(launchedSession);
      if (!launched?.live) return;
      launched.launchAccepted = true;
      if (launched.initialized && !launched.readySettled) {
        launched.readySettled = true;
        launched.readyResolve();
      }
    }).catch((error) => {
      const launched = sessionsRef.current.get(launchedSession);
      if (!launched?.live) return;
      const message = error instanceof Error ? error.message : String(error);
      launched.live = false;
      launched.functionSyncGeneration += 1;
      launched.dataSyncGeneration += 1;
      launched.exceptionSyncGeneration += 1;
      if (!launched.readySettled) {
        launched.readySettled = true;
        launched.readyReject(error);
      }
      launched.unlisten?.();
      launched.unlisten = null;
      void dapTerminate(launchedSession).catch(() => {});
      launched.breakpointRuntime = {};
      launched.functionBreakpointRuntime = {};
      launched.dataBreakpointRuntime = {};
      launched.exceptionBreakpointRuntime = {};
      launched.exceptionBreakpointRuleRuntime = {};
      launched.frameVariables = {};
      updateSessionState(launchedSession, (prev) => appendConsoleLine(
        { ...prev, status: "terminated" },
        "stderr",
        `Launch failed: ${message}\n`,
      ));
      if (activeSessionIdRef.current === launchedSession) publishActiveSession(launched);
      dropSessionDataBreakpoints(new Set([launchedSession]));
    });
    // Watchdog: if the adapter never becomes ready, say so instead of showing
    // an eternally-running empty session.
    window.setTimeout(() => {
      const launched = sessionsRef.current.get(launchedSession);
      if (!launched?.live || launched.initialized) return;
      updateSessionState(launchedSession, (prev) => appendConsoleLine(
        prev,
        "console",
        "Still waiting for the debug adapter to become ready (no 'initialized' event after 15s). "
          + "The project may have build errors, or the launch is stalled.\n",
      ));
    }, 15_000);
    return record;
  }, [
    dropSessionDataBreakpoints,
    handleEvent,
    persistExceptionBreakpoints,
    publishActiveSession,
    publishSessionList,
    updateSessionState,
  ]);

  const startDebug = useCallback(async (
    launchConfig: Record<string, unknown>,
    adapterId = "java",
  ) => {
    const startupOutput = stateRef.current?.sessionId === "" ? stateRef.current.output : [];
    await clearSessions();
    if (startupOutput.length > 0) {
      const startup = { ...initialDebugState(""), output: startupOutput };
      stateRef.current = startup;
      if (mountedRef.current) setState(startup);
    }
    lastLaunchRef.current = { kind: "single", config: launchConfig, adapterId };
    try {
      await launchTarget({ id: "single", label: "Debug", adapterId, launchConfig }, 0, []);
      if (mountedRef.current) setCanRestart(true);
    } catch (error) {
      reportStartupFailure(`Debug failed to start: ${errorText(error)}`);
      throw error;
    }
  }, [clearSessions, launchTarget, reportStartupFailure]);

  const startDebugGroup = useCallback(async (plan: DebugLaunchGroup) => {
    validateDebugLaunchGroup(plan);
    const startupOutput = stateRef.current?.sessionId === "" ? stateRef.current.output : [];
    await clearSessions();
    if (startupOutput.length > 0) {
      const startup = { ...initialDebugState(""), output: startupOutput };
      stateRef.current = startup;
      if (mountedRef.current) setState(startup);
    }
    lastLaunchRef.current = { kind: "group", plan: structuredClone(plan) };
    let order = 0;
    const runNode = async (node: DebugLaunchNode, parentScopes: string[]): Promise<void> => {
      if (!isDebugLaunchGroup(node)) {
        const launchOrder = order;
        order += 1;
        const record = await launchTarget(node, launchOrder, parentScopes);
        await record.ready;
        return;
      }
      const scopes = [...parentScopes, node.id];
      const runChild = (child: DebugLaunchNode) => runNode(child, scopes);
      if (node.parallel) {
        if (node.stopOnFailure !== false) {
          try {
            await Promise.all(node.children.map(runChild));
          } catch (error) {
            abortedScopesRef.current.add(node.id);
            await terminateSessions(new Set([node.id]));
            throw error;
          }
        } else {
          const results = await Promise.allSettled(node.children.map(runChild));
          const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failure) throw failure.reason;
        }
        return;
      }
      let firstFailure: unknown = null;
      for (const child of node.children) {
        try {
          await runChild(child);
        } catch (error) {
          firstFailure ??= error;
          if (node.stopOnFailure !== false) {
            abortedScopesRef.current.add(node.id);
            await terminateSessions(new Set([node.id]));
            throw error;
          }
        }
      }
      if (firstFailure) throw firstFailure;
    };
    try {
      await runNode(plan, []);
      if (mountedRef.current) setCanRestart(true);
    } catch (error) {
      reportStartupFailure(`Compound Debug failed to start: ${errorText(error)}`);
      throw error;
    }
  }, [clearSessions, launchTarget, reportStartupFailure, terminateSessions]);

  const restart = useCallback(() => {
    const last = lastLaunchRef.current;
    if (!last) return;
    if (last.kind === "group") void startDebugGroup(last.plan).catch(() => {});
    else void startDebug(last.config, last.adapterId).catch(() => {});
  }, [startDebug, startDebugGroup]);

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    mutateBreakpoints(path, (list) => (
      list.some((bp) => bp.line === line)
        ? list.filter((bp) => bp.line !== line)
        : [...list, { line }]
    ));
  }, [mutateBreakpoints]);

  const removeBreakpoint = useCallback((path: string, line: number) => {
    mutateBreakpoints(path, (list) => list.filter((bp) => bp.line !== line));
  }, [mutateBreakpoints]);

  const setBreakpointOptions = useCallback((path: string, line: number, options: Partial<DebugBreakpoint>) => {
    mutateBreakpoints(path, (list) => (
      list.some((bp) => bp.line === line)
        ? list.map((bp) => (bp.line === line ? { ...bp, ...options } : bp))
        : list
    ));
  }, [mutateBreakpoints]);

  const setBreakpointMode = useCallback((path: string, line: number, rawMode: string) => {
    const sessionId = activeSessionIdRef.current;
    const active = sessionId ? sessionsRef.current.get(sessionId) : undefined;
    const mode = normalizeBreakpointModeId(rawMode);
    if (!active?.live || !mode) return;
    const applicable = breakpointModesFor(parseBreakpointModes(active.capabilities), "source");
    if (!applicable.some((candidate) => candidate.mode === mode)) return;
    const sessionIds = Array.from(sessionsRef.current.values())
      .filter((record) => record.live && record.initialized && record.adapterId === active.adapterId)
      .map((record) => record.id);
    mutateBreakpoints(path, (list) => list.map((breakpoint) => {
      if (breakpoint.line !== line) return breakpoint;
      const retained = Object.entries(breakpoint.adapterModes ?? {})
        .filter(([adapterId]) => adapterId !== active.adapterId)
        .slice(-(MAX_SOURCE_BREAKPOINT_ADAPTER_MODES - 1));
      return {
        ...breakpoint,
        adapterModes: Object.fromEntries([...retained, [active.adapterId, mode]]),
      };
    }), { sessionIds });
  }, [mutateBreakpoints]);

  const mutateFunctionBreakpoints = useCallback((
    updater: (current: DebugFunctionBreakpoint[]) => DebugFunctionBreakpoint[],
  ) => {
    const current = functionBreakpointsRef.current;
    const updated = updater(current);
    if (updated === current) return;
    const next = normalizeFunctionBreakpoints(updated);
    functionBreakpointsRef.current = next;
    setFunctionBreakpoints(next);
    persistFunctionBreakpoints(next);
    void syncFunctionBreakpoints({ list: next });
  }, [persistFunctionBreakpoints, syncFunctionBreakpoints]);

  const addFunctionBreakpoint = useCallback((rawName: string) => {
    const name = rawName.trim().slice(0, MAX_FUNCTION_BREAKPOINT_NAME_LENGTH);
    if (!name) return;
    mutateFunctionBreakpoints((current) => (
      current.some((breakpoint) => breakpoint.name === name)
        ? current
        : [...current, { name }]
    ));
  }, [mutateFunctionBreakpoints]);

  const setFunctionBreakpointOptions = useCallback((
    name: string,
    options: Partial<DebugFunctionBreakpoint>,
  ) => {
    mutateFunctionBreakpoints((current) => current.map((breakpoint) => (
      breakpoint.name === name
        ? { ...breakpoint, ...options, name: breakpoint.name }
        : breakpoint
    )));
  }, [mutateFunctionBreakpoints]);

  const removeFunctionBreakpoint = useCallback((name: string) => {
    mutateFunctionBreakpoints((current) => current.filter((breakpoint) => breakpoint.name !== name));
  }, [mutateFunctionBreakpoints]);

  const mutateDataBreakpoints = useCallback((
    updater: (current: DebugDataBreakpoint[]) => DebugDataBreakpoint[],
  ) => {
    const current = dataBreakpointsRef.current;
    const updated = updater(current);
    if (updated === current) return;
    const next = normalizeDataBreakpoints(updated);
    dataBreakpointsRef.current = next;
    setDataBreakpoints(next);
    persistDataBreakpoints(next);
    void syncDataBreakpoints({ list: next });
  }, [persistDataBreakpoints, syncDataBreakpoints]);

  const addDataBreakpoint = useCallback(async (
    target: DebugDataBreakpointTarget,
  ): Promise<DataBreakpointAddResult> => {
    const id = activeSessionIdRef.current;
    const record = id ? sessionsRef.current.get(id) : undefined;
    const name = target.name.trim();
    if (!id || !record?.live || record.state.status !== "stopped") {
      return { added: false, message: "Data breakpoints can only be created while execution is stopped" };
    }
    if (record.capabilities.supportsDataBreakpoints !== true) {
      return { added: false, message: "The selected debug adapter does not support data breakpoints" };
    }
    if (!name) return { added: false, message: "The data breakpoint target is empty" };
    if (name.length > MAX_DATA_BREAKPOINT_ID_LENGTH) {
      return { added: false, message: "The data breakpoint target is too long" };
    }
    if (dataBreakpointsRef.current.length >= MAX_DATA_BREAKPOINTS) {
      return { added: false, message: `Data breakpoint limit reached (${MAX_DATA_BREAKPOINTS})` };
    }
    const supportsDataBreakpointBytes = record.capabilities.supportsDataBreakpointBytes === true;
    const requestedBytes = normalizeDataBreakpointBytes(target.bytes);
    const requestedAsAddress = target.asAddress === true;
    if ((target.bytes !== undefined || requestedAsAddress) && !supportsDataBreakpointBytes) {
      return { added: false, message: "The selected debug adapter does not support address/range data breakpoints" };
    }
    if (target.bytes !== undefined && requestedBytes === undefined) {
      return { added: false, message: "Data breakpoint byte count must be an integer between 1 and 4294967295" };
    }
    if (requestedAsAddress && !isDataBreakpointAddress(name)) {
      return { added: false, message: "Address data breakpoints require a decimal or 0x-prefixed hexadecimal address" };
    }
    if (requestedAsAddress && (typeof target.variablesReference === "number" || typeof target.frameId === "number")) {
      return { added: false, message: "Address data breakpoints cannot be scoped to a variable or frame" };
    }
    const dataModes = breakpointModesFor(parseBreakpointModes(record.capabilities), "data");
    const requestedMode = normalizeBreakpointModeId(target.mode);
    if (requestedMode && !dataModes.some((candidate) => candidate.mode === requestedMode)) {
      return { added: false, message: "The selected data-breakpoint mode is not supported" };
    }
    const mode = resolveBreakpointMode(requestedMode, dataModes, "data");
    const epoch = record.stopEpoch;
    let body: unknown;
    try {
      body = await dapSendRequest(id, "dataBreakpointInfo", buildDataBreakpointInfoArgs({
        name,
        variablesReference: target.variablesReference,
        frameId: target.frameId,
        bytes: requestedBytes,
        asAddress: requestedAsAddress || undefined,
        mode,
      }));
    } catch (error) {
      const message = `Data breakpoint discovery failed: ${errorText(error)}`;
      updateSessionState(id, (current) => appendConsoleLine(current, "stderr", `${message}\n`));
      return { added: false, message };
    }
    const current = sessionsRef.current.get(id);
    if (!current?.live || current.stopEpoch !== epoch || current.state.status !== "stopped") {
      return { added: false, message: "Execution resumed before the data breakpoint was resolved" };
    }
    const info = parseDataBreakpointInfo(body);
    if (!info.dataId) {
      const message = info.description || "The selected value cannot be watched by this adapter";
      updateSessionState(id, (state) => appendConsoleLine(state, "stderr", `${message}\n`));
      return { added: false, message };
    }
    const breakpoint = normalizeDataBreakpoint({
      dataId: info.dataId,
      description: info.description || name,
      adapterId: record.adapterId,
      accessTypes: info.accessTypes,
      accessType: defaultDataBreakpointAccessType(info.accessTypes),
      bytes: requestedBytes,
      asAddress: requestedAsAddress || undefined,
      mode,
      canPersist: info.canPersist,
      sessionId: info.canPersist ? undefined : record.id,
    });
    if (!breakpoint) {
      return { added: false, message: "The debug adapter returned invalid data-breakpoint metadata" };
    }
    const key = dataBreakpointKey(breakpoint);
    if (dataBreakpointsRef.current.some((entry) => dataBreakpointKey(entry) === key)) {
      return { added: false, message: `${breakpoint.description} is already watched` };
    }
    mutateDataBreakpoints((entries) => [...entries, breakpoint]);
    return {
      added: true,
      message: breakpoint.canPersist
        ? `Watching ${breakpoint.description}`
        : `Watching ${breakpoint.description} for this debug session`,
    };
  }, [mutateDataBreakpoints, updateSessionState]);

  const setDataBreakpointOptions = useCallback((
    key: string,
    options: Partial<DebugDataBreakpoint>,
  ) => {
    mutateDataBreakpoints((current) => current.map((breakpoint) => (
      dataBreakpointKey(breakpoint) === key
        ? {
            ...breakpoint,
            ...options,
            dataId: breakpoint.dataId,
            adapterId: breakpoint.adapterId,
            bytes: breakpoint.bytes,
            asAddress: breakpoint.asAddress,
            mode: breakpoint.mode,
            canPersist: breakpoint.canPersist,
            sessionId: breakpoint.sessionId,
          }
        : breakpoint
    )));
  }, [mutateDataBreakpoints]);

  const removeDataBreakpoint = useCallback((key: string) => {
    mutateDataBreakpoints((current) => current.filter((breakpoint) => (
      dataBreakpointKey(breakpoint) !== key
    )));
  }, [mutateDataBreakpoints]);

  /** IDEA "Mute Breakpoints": re-push every file with the new suppression. */
  const setBreakpointsMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    setBreakpointsMutedState(muted);
    for (const path of Object.keys(breakpointsRef.current)) {
      void syncBreakpointsForPath(path);
    }
    void syncFunctionBreakpoints();
    void syncDataBreakpoints();
    void syncExceptionBreakpoints();
  }, [
    syncBreakpointsForPath,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    syncFunctionBreakpoints,
  ]);

  const removeAllBreakpoints = useCallback(() => {
    const paths = Object.keys(breakpointsRef.current);
    breakpointsRef.current = {};
    setBreakpoints({});
    persistBreakpoints({});
    for (const path of paths) void syncBreakpointsForPath(path, { list: [] });
    functionBreakpointsRef.current = [];
    setFunctionBreakpoints([]);
    persistFunctionBreakpoints([]);
    void syncFunctionBreakpoints({ list: [] });
    dataBreakpointsRef.current = [];
    setDataBreakpoints([]);
    persistDataBreakpoints([]);
    void syncDataBreakpoints({ list: [] });
    const nextExceptionBreakpoints = exceptionBreakpointsRef.current.map((breakpoint) => (
      breakpoint.enabled ? { ...breakpoint, enabled: false } : breakpoint
    ));
    exceptionBreakpointsRef.current = nextExceptionBreakpoints;
    setExceptionBreakpoints(nextExceptionBreakpoints);
    persistExceptionBreakpoints(nextExceptionBreakpoints);
    exceptionBreakpointRulesRef.current = [];
    setExceptionBreakpointRules([]);
    persistExceptionBreakpointRules([]);
    void syncExceptionBreakpoints({ list: nextExceptionBreakpoints, rules: [] });
  }, [
    persistBreakpoints,
    persistDataBreakpoints,
    persistExceptionBreakpoints,
    persistExceptionBreakpointRules,
    persistFunctionBreakpoints,
    syncBreakpointsForPath,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    syncFunctionBreakpoints,
  ]);

  const setExceptionBreakpointOptions = useCallback((
    filterId: string,
    options: Partial<Pick<DebugExceptionBreakpoint, "enabled" | "condition" | "mode">>,
  ) => {
    const sessionId = activeSessionIdRef.current;
    const active = sessionId ? sessionsRef.current.get(sessionId) : undefined;
    if (!active?.live) return;
    const filter = active.availableFilters.find((candidate) => candidate.filter === filterId);
    if (!filter) return;
    const current = exceptionBreakpointsRef.current;
    const key = exceptionBreakpointKey({ adapterId: active.adapterId, filterId });
    const index = current.findIndex((breakpoint) => exceptionBreakpointKey(breakpoint) === key);
    const existing = index >= 0
      ? current[index]
      : { adapterId: active.adapterId, filterId, enabled: filter.default };
    const canSetCondition = filter.supportsCondition
      && active.capabilities.supportsExceptionFilterOptions === true;
    const exceptionModes = breakpointModesFor(parseBreakpointModes(active.capabilities), "exception");
    const canSetMode = active.capabilities.supportsExceptionFilterOptions === true
      && exceptionModes.length > 0;
    const condition = Object.prototype.hasOwnProperty.call(options, "condition") && canSetCondition
      ? options.condition
      : existing.condition;
    const requestedMode = normalizeBreakpointModeId(options.mode);
    const mode = Object.prototype.hasOwnProperty.call(options, "mode")
      && canSetMode
      && requestedMode
      && exceptionModes.some((candidate) => candidate.mode === requestedMode)
      ? requestedMode
      : existing.mode;
    const updated = normalizeExceptionBreakpoint({
      ...existing,
      enabled: typeof options.enabled === "boolean" ? options.enabled : existing.enabled,
      condition,
      mode,
    });
    if (!updated) return;
    const next = normalizeExceptionBreakpoints(index >= 0
      ? current.map((breakpoint, position) => (position === index ? updated : breakpoint))
      : [...current, updated]);
    exceptionBreakpointsRef.current = next;
    setExceptionBreakpoints(next);
    persistExceptionBreakpoints(next);
    const sessionIds = Array.from(sessionsRef.current.values())
      .filter((record) => record.live && record.initialized && record.adapterId === active.adapterId)
      .map((record) => record.id);
    void syncExceptionBreakpoints({ list: next, sessionIds });
  }, [persistExceptionBreakpoints, syncExceptionBreakpoints]);

  const mutateExceptionBreakpointRules = useCallback((
    adapterId: string,
    updater: (current: DebugExceptionBreakpointRule[]) => DebugExceptionBreakpointRule[],
  ) => {
    const next = normalizeExceptionBreakpointRules(updater(exceptionBreakpointRulesRef.current));
    exceptionBreakpointRulesRef.current = next;
    setExceptionBreakpointRules(next);
    persistExceptionBreakpointRules(next);
    const sessionIds = Array.from(sessionsRef.current.values())
      .filter((record) => record.live && record.initialized && record.adapterId === adapterId)
      .map((record) => record.id);
    void syncExceptionBreakpoints({ rules: next, sessionIds });
  }, [persistExceptionBreakpointRules, syncExceptionBreakpoints]);

  const addExceptionBreakpointRule = useCallback((
    path: DebugExceptionPathSegment[],
    breakMode: DebugExceptionBreakMode = "always",
  ): string | null => {
    const sessionId = activeSessionIdRef.current;
    const active = sessionId ? sessionsRef.current.get(sessionId) : undefined;
    if (
      !active?.live
      || active.availableFilters.length === 0
      || active.capabilities.supportsExceptionOptions !== true
      || exceptionBreakpointRulesRef.current.length >= MAX_EXCEPTION_BREAKPOINT_RULES
    ) return null;
    const normalizedPath = normalizeExceptionPath(path);
    if (!normalizedPath) return null;
    let id = createExceptionBreakpointRuleId();
    const known = new Set(exceptionBreakpointRulesRef.current.map(exceptionBreakpointRuleKey));
    while (known.has(exceptionBreakpointRuleKey({ adapterId: active.adapterId, id }))) {
      id = createExceptionBreakpointRuleId();
    }
    const rule = normalizeExceptionBreakpointRule({
      id,
      adapterId: active.adapterId,
      path: normalizedPath,
      breakMode,
      enabled: true,
    });
    if (!rule) return null;
    mutateExceptionBreakpointRules(active.adapterId, (current) => [...current, rule]);
    return id;
  }, [mutateExceptionBreakpointRules]);

  const setExceptionBreakpointRuleOptions = useCallback((
    ruleId: string,
    options: Partial<Pick<DebugExceptionBreakpointRule, "enabled" | "path" | "breakMode">>,
  ) => {
    const sessionId = activeSessionIdRef.current;
    const active = sessionId ? sessionsRef.current.get(sessionId) : undefined;
    if (!active?.live) return;
    mutateExceptionBreakpointRules(active.adapterId, (current) => current.map((rule) => (
      rule.id === ruleId && rule.adapterId === active.adapterId
        ? {
            ...rule,
            ...(typeof options.enabled === "boolean" ? { enabled: options.enabled } : {}),
            ...(options.path ? { path: options.path } : {}),
            ...(options.breakMode ? { breakMode: options.breakMode } : {}),
          }
        : rule
    )));
  }, [mutateExceptionBreakpointRules]);

  const removeExceptionBreakpointRule = useCallback((ruleId: string) => {
    const sessionId = activeSessionIdRef.current;
    const active = sessionId ? sessionsRef.current.get(sessionId) : undefined;
    if (!active?.live) return;
    mutateExceptionBreakpointRules(active.adapterId, (current) => current.filter((rule) => (
      rule.adapterId !== active.adapterId || rule.id !== ruleId
    )));
  }, [mutateExceptionBreakpointRules]);

  const addWatchExpression = useCallback((expr: string) => {
    const trimmed = expr.trim();
    if (!trimmed) return;
    setWatchExpressions((current) => {
      if (current.includes(trimmed)) return current;
      const next = [...current, trimmed];
      persistWatches(next);
      return next;
    });
  }, [persistWatches]);

  const removeWatchExpression = useCallback((index: number) => {
    setWatchExpressions((current) => {
      const next = current.filter((_, i) => i !== index);
      persistWatches(next);
      return next;
    });
  }, [persistWatches]);

  const step = useCallback((action: DebugStepAction) => {
    const id = sessionIdRef.current;
    const record = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !record) return;
    void (async () => {
      if (action === "pause") {
        // `pause` requires a threadId; while running we may not have one yet.
        let tid = stateRef.current?.threads[0]?.id ?? null;
        if (tid == null) {
          tid = parseThreads(await dapSendRequest(id, "threads").catch(() => null))[0]?.id ?? null;
        }
        if (tid == null) return;
        await dapSendRequest(id, "pause", { threadId: tid }).catch(() => {});
        return; // The adapter answers with a `stopped` event.
      }
      const epoch = record.stopEpoch;
      const tid = stateRef.current?.selectedThreadId ?? stateRef.current?.stoppedThreadId;
      try {
        await dapSendRequest(id, stepCommandFor(action), tid != null ? { threadId: tid } : {});
        // Adapters need not emit `continued` after an explicit resume/step —
        // flip to running optimistically unless a newer stop already landed.
        if (mountedRef.current && record.stopEpoch === epoch) {
          updateSessionState(id, (prev) => (prev.status === "stopped" ? markResumed(prev) : prev));
        }
      } catch {
        // Request failed (e.g. already running): keep the current state.
      }
    })();
  }, [updateSessionState]);

  const runToCursor = useCallback((path: string, line: number) => {
    const id = sessionIdRef.current;
    const current = stateRef.current;
    const record = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !record || !current || current.status !== "stopped") return;
    void (async () => {
      const needsTemp = !(breakpointsRef.current[path] ?? []).some(
        (bp) => bp.line === line && bp.enabled !== false,
      ) || mutedRef.current;
      if (needsTemp) {
        record.tempRunToCursor = { path };
        tempRunToCursorRef.current = record.tempRunToCursor;
        await syncBreakpointsForPath(path, { extraTempLine: line, sessionIds: [id] });
      }
      const epoch = record.stopEpoch;
      const tid = current.selectedThreadId ?? current.stoppedThreadId;
      try {
        await dapSendRequest(id, "continue", tid != null ? { threadId: tid } : {});
        if (mountedRef.current && record.stopEpoch === epoch) {
          updateSessionState(id, (prev) => (prev.status === "stopped" ? markResumed(prev) : prev));
        }
      } catch {
        // Continue failed: restore the user's breakpoints right away.
        if (needsTemp) {
          record.tempRunToCursor = null;
          tempRunToCursorRef.current = null;
          await syncBreakpointsForPath(path, { sessionIds: [id] });
        }
      }
    })();
  }, [syncBreakpointsForPath, updateSessionState]);

  const selectThread = useCallback((threadId: number) => {
    const id = sessionIdRef.current;
    const record = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !record || stateRef.current?.status !== "stopped") return;
    void (async () => {
      const epoch = record.stopEpoch;
      const stackBody = await dapSendRequest(id, "stackTrace", { threadId, startFrame: 0, levels: 40 })
        .catch(() => null);
      const frames = parseStackFrames(stackBody);
      if (!mountedRef.current || record.stopEpoch !== epoch) return;
      updateSessionState(id, (prev) => (prev.status === "stopped"
        ? { ...prev, selectedThreadId: threadId, frames, selectedFrameId: frames[0]?.id ?? null }
        : prev));
      if (frames[0]) void refreshFrameVariables(frames[0].id, epoch);
    })();
  }, [refreshFrameVariables, updateSessionState]);

  const selectFrame = useCallback((frameId: number) => {
    const id = sessionIdRef.current;
    if (!id) return;
    updateSessionState(id, (prev) => (prev.status === "stopped" ? { ...prev, selectedFrameId: frameId } : prev));
    // Inline values follow the frame the user is inspecting.
    void refreshFrameVariables(frameId, stopEpochRef.current);
  }, [refreshFrameVariables, updateSessionState]);

  const restartFrame = useCallback((frameId: number) => {
    const id = sessionIdRef.current;
    if (!id || capabilitiesRef.current.supportsRestartFrame !== true) return;
    // The adapter re-stops at the frame entry and emits a `stopped` event.
    void dapSendRequest(id, "restartFrame", { frameId }).catch(() => {});
  }, []);

  const hotReload = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    // java-debug custom request; adapters without it just error (reported below).
    void dapSendRequest(id, "redefineClasses", {})
      .then((body) => {
        const changed = body && typeof body === "object"
          ? (body as { changedClasses?: unknown }).changedClasses
          : null;
        const count = Array.isArray(changed) ? changed.length : 0;
        logConsole("console", count > 0
          ? `Hot reloaded ${count} class${count === 1 ? "" : "es"}\n`
          : "Hot reload: no changed classes\n");
      })
      .catch((error) => {
        logConsole("stderr", `Hot reload failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }, [logConsole]);

  const evaluate = useCallback(async (expression: string, context = "repl"): Promise<EvaluateResult> => {
    const id = sessionIdRef.current;
    const current = stateRef.current;
    if (!id) return { value: "", variablesReference: 0, type: null };
    const frameId = current?.selectedFrameId ?? current?.frames[0]?.id;
    try {
      return parseEvaluate(await dapSendRequest(id, "evaluate", { expression, frameId, context }));
    } catch (error) {
      return {
        value: error instanceof Error ? error.message : String(error),
        variablesReference: 0,
        type: null,
      };
    }
  }, []);

  const hoverEvaluate = useCallback(async (expression: string): Promise<EvaluateResult | null> => {
    const id = sessionIdRef.current;
    const current = stateRef.current;
    if (!id || !expression.trim() || current?.status !== "stopped") return null;
    const frameId = current.selectedFrameId ?? current.frames[0]?.id;
    if (frameId == null) return null;
    // A hover over a non-expression (a keyword, a type name) legitimately fails;
    // resolve to null so the editor simply shows no tooltip.
    const body = await dapSendRequest(id, "evaluate", { expression, frameId, context: "hover" })
      .catch(() => null);
    if (body == null) return null;
    const result = parseEvaluate(body);
    return result.value ? result : null;
  }, []);

  const setVariable = useCallback(async (
    variablesReference: number,
    name: string,
    value: string,
  ): Promise<EvaluateResult | null> => {
    const id = sessionIdRef.current;
    if (!id) return null;
    try {
      const body = await dapSendRequest(id, "setVariable", { variablesReference, name, value });
      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      return {
        value: typeof rec.value === "string" ? rec.value : "",
        variablesReference: typeof rec.variablesReference === "number" ? rec.variablesReference : 0,
        type: typeof rec.type === "string" ? rec.type : null,
      };
    } catch (error) {
      logConsole("stderr", `Set value failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  }, [logConsole]);

  const fetchVariables = useCallback(async (variablesReference: number): Promise<unknown> => {
    const id = sessionIdRef.current;
    if (!id) return { variables: [] };
    return dapSendRequest(id, "variables", { variablesReference }).catch(() => ({ variables: [] }));
  }, []);

  const fetchScopes = useCallback(async (frameId: number): Promise<unknown> => {
    const id = sessionIdRef.current;
    if (!id) return { scopes: [] };
    return dapSendRequest(id, "scopes", { frameId }).catch(() => ({ scopes: [] }));
  }, []);

  const fetchSource = useCallback(async (sourceReference: number): Promise<string | null> => {
    const id = sessionIdRef.current;
    if (!id || sourceReference <= 0) return null;
    // The spec wants both the shorthand and the full `source` object; adapters
    // differ in which they read.
    const body = await dapSendRequest(id, "source", {
      sourceReference,
      source: { sourceReference },
    }).catch(() => null);
    const content = (body as { content?: unknown } | null)?.content;
    return typeof content === "string" && content ? content : null;
  }, []);

  const terminate = useCallback(() => {
    void terminateSessions();
  }, [terminateSessions]);

  return {
    state,
    breakpoints,
    breakpointRuntime,
    functionBreakpoints,
    functionBreakpointRuntime,
    dataBreakpoints,
    dataBreakpointRuntime,
    exceptionBreakpoints,
    exceptionBreakpointRuntime,
    exceptionBreakpointRules,
    exceptionBreakpointRuleRuntime,
    capabilities,
    availableExceptionFilters: availableFilters,
    watchExpressions,
    breakpointsMuted,
    setBreakpointsMuted,
    removeAllBreakpoints,
    frameVariables,
    sessions,
    activeSessionId,
    selectSession,
    startDebug,
    startDebugGroup,
    restart,
    canRestart,
    toggleBreakpoint,
    setBreakpointOptions,
    setBreakpointMode,
    removeBreakpoint,
    addFunctionBreakpoint,
    setFunctionBreakpointOptions,
    removeFunctionBreakpoint,
    addDataBreakpoint,
    setDataBreakpointOptions,
    removeDataBreakpoint,
    setExceptionBreakpointOptions,
    addExceptionBreakpointRule,
    setExceptionBreakpointRuleOptions,
    removeExceptionBreakpointRule,
    addWatchExpression,
    removeWatchExpression,
    step,
    runToCursor,
    selectThread,
    selectFrame,
    restartFrame,
    hotReload,
    evaluate,
    hoverEvaluate,
    setVariable,
    logConsole,
    clearConsole,
    reportStartupFailure,
    reportStartupProgress,
    fetchVariables,
    fetchScopes,
    fetchSource,
    terminate,
    currentLocation: state ? currentLocation(state.frames, state.selectedFrameId) : null,
  };
}
