import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
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
  breakpointVerificationMap,
  buildSetBreakpointsArgs,
  currentLocation,
  initialDebugState,
  markResumed,
  parseBreakpointEvent,
  parseEvaluate,
  parseExceptionInfo,
  parseSetBreakpointsResponse,
  parseStackFrames,
  parseThreads,
  planBreakpointSync,
  reconcileBreakpointLines,
  reduceDebugEvent,
  selectExceptionFilters,
  stepCommandFor,
  toAdapterSourcePath,
  type BreakpointRuntimeState,
  type DebugBreakpoint,
  type DebugSessionState,
  type DebugStackFrame,
  type DebugStepAction,
  type EvaluateResult,
} from "./dapDebugModel";

/** Breakpoints keyed by absolute file path. */
export type BreakpointMap = Record<string, DebugBreakpoint[]>;

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
  /** Adapter capabilities from `initialize` — gates optional UI (restartFrame, setVariable…). */
  capabilities: Record<string, unknown>;
  /** Exception-breakpoint filter ids the adapter advertised (D5). */
  availableExceptionFilters: { filter: string; label: string }[];
  enabledExceptionFilters: string[];
  /** Persistent watch expressions (the panel evaluates them per stop). */
  watchExpressions: string[];
  /** IDEA "Mute Breakpoints": keep them listed but stop arming them. */
  breakpointsMuted: boolean;
  setBreakpointsMuted: (muted: boolean) => void;
  /** Remove every breakpoint in the workspace (IDEA's breakpoints dialog). */
  removeAllBreakpoints: () => void;
  /** Locals of the selected frame as `name → value`, for editor inline values. */
  frameVariables: Record<string, string>;
  /** Start a debug session with a resolved launch config (adapter defaults to Java). */
  startDebug: (launchConfig: Record<string, unknown>, adapterId?: string) => Promise<void>;
  /** Re-run the last launch config (IDEA rerun). */
  restart: () => void;
  canRestart: boolean;
  toggleBreakpoint: (path: string, line: number) => void;
  setBreakpointOptions: (path: string, line: number, options: Partial<DebugBreakpoint>) => void;
  /** Remove one breakpoint outright (breakpoints view). */
  removeBreakpoint: (path: string, line: number) => void;
  setExceptionFilters: (ids: string[]) => void;
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

function breakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugBreakpoints.v1.${workspaceInstanceId}`;
}

function watchesKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugWatches.v1.${workspaceInstanceId}`;
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
export function useCodeDebugSession(workspaceInstanceId: string): CodeDebugSession {
  const [state, setState] = useState<DebugSessionState | null>(null);
  const [breakpoints, setBreakpoints] = useState<BreakpointMap>(() => readBreakpoints(workspaceInstanceId));
  const [breakpointRuntime, setBreakpointRuntime] = useState<Record<string, Record<number, BreakpointRuntimeState>>>({});
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
  const [exceptionFilters, setExceptionFiltersState] = useState<string[]>([]);
  const [availableFilters, setAvailableFilters] = useState<{ filter: string; label: string }[]>([]);
  const [watchExpressions, setWatchExpressions] = useState<string[]>(() => readWatches(workspaceInstanceId));
  const [canRestart, setCanRestart] = useState(false);
  const [breakpointsMuted, setBreakpointsMutedState] = useState(false);
  const [frameVariables, setFrameVariables] = useState<Record<string, string>>({});

  const sessionIdRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<Record<string, unknown>>({});
  const breakpointsRef = useRef(breakpoints);
  const mutedRef = useRef(breakpointsMuted);
  const exceptionFiltersRef = useRef(exceptionFilters);
  const stateRef = useRef<DebugSessionState | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  /** Bumped on every `stopped` event; async work checks it to drop stale results. */
  const stopEpochRef = useRef(0);
  /** Adapter breakpoint id → file path, to route `breakpoint` events. */
  const bpIdIndexRef = useRef(new Map<number, { path: string }>());
  /** Per-path `setBreakpoints` generation, so a late response cannot win. */
  const syncGenerationRef = useRef(new Map<string, number>());
  /** Pending run-to-cursor: its transient breakpoint is removed on the next stop. */
  const tempRunToCursorRef = useRef<{ path: string } | null>(null);
  const lastLaunchRef = useRef<{ config: Record<string, unknown>; adapterId: string } | null>(null);
  /** Whether the adapter has emitted `initialized` for the current session. */
  const initializedRef = useRef(false);
  breakpointsRef.current = breakpoints;
  mutedRef.current = breakpointsMuted;
  exceptionFiltersRef.current = exceptionFilters;
  stateRef.current = state;

  useEffect(() => {
    // Set true on (re)mount: React 18 StrictMode runs mount→cleanup→remount, so
    // the cleanup below fires once during dev double-invoke. Without resetting to
    // true here, mountedRef stays false forever and every mounted-guarded setState
    // (e.g. initialDebugState in startDebug) is silently skipped.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unlistenRef.current?.();
      const id = sessionIdRef.current;
      if (id) void dapTerminate(id).catch(() => {});
    };
  }, []);

  // Inline values are only meaningful while stopped: drop them the moment the
  // debuggee resumes or the session ends, so stale numbers never sit in the
  // editor gutter.
  const debugStatus = state?.status ?? null;
  useEffect(() => {
    if (debugStatus !== "stopped") setFrameVariables({});
  }, [debugStatus]);

  const persistBreakpoints = useCallback((next: BreakpointMap) => {
    try {
      window.localStorage.setItem(breakpointsKey(workspaceInstanceId), JSON.stringify(next));
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

  const logConsole = useCallback((category: string, text: string) => {
    setState((prev) => {
      if (!prev || !text) return prev;
      return { ...prev, output: [...prev.output, { category, text }].slice(-2000) };
    });
  }, []);

  const clearConsole = useCallback(() => {
    setState((prev) => (prev && prev.output.length > 0 ? { ...prev, output: [] } : prev));
  }, []);

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
    setState((prev) => appendConsoleLine(
      prev
        ? { ...prev, status: "terminated" }
        : { ...initialDebugState(""), status: "terminated" },
      "stderr",
      text,
    ));
  }, []);

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
    options: { list?: DebugBreakpoint[]; extraTempLine?: number } = {},
  ) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const stored = options.list ?? breakpointsRef.current[path] ?? [];
    const plan = planBreakpointSync(stored, {
      muted: mutedRef.current,
      extraLine: options.extraTempLine,
    });
    // Two quick toggles on the same file put two requests in flight; an older
    // response landing last would otherwise re-apply the set it was built from
    // and undo the newer change.
    const generation = (syncGenerationRef.current.get(path) ?? 0) + 1;
    syncGenerationRef.current.set(path, generation);
    // Breakpoints are keyed by our internal (forward-slash) path, but the adapter
    // needs the OS-native form (Windows: lowercase drive + backslashes) or it
    // leaves them unverified.
    const args = buildSetBreakpointsArgs(path, plan);
    args.source.path = toAdapterSourcePath(path);
    const body = await dapSendRequest(id, "setBreakpoints", args).catch((error) => {
      // A failed setBreakpoints means the file's breakpoints are NOT armed —
      // previously silent, so the user saw red dots that could never bind.
      logConsole("stderr", `setBreakpoints for ${path.split(/[\\/]/).pop() ?? path} failed: ${errorText(error)}\n`);
      return null;
    });
    if (body == null || !mountedRef.current) return;
    if (syncGenerationRef.current.get(path) !== generation) return; // superseded
    const bindings = parseSetBreakpointsResponse(plan, body);
    for (const binding of bindings) {
      if (binding.id != null) bpIdIndexRef.current.set(binding.id, { path });
    }
    setBreakpointRuntime((prev) => ({ ...prev, [path]: breakpointVerificationMap(plan, bindings) }));
    if (options.extraTempLine == null) {
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
  }, [persistBreakpoints, logConsole]);

  /**
   * Single mutation path for the breakpoint map. Updates the ref synchronously
   * (so an immediately-following adapter sync sees the new set), persists, and
   * pushes the changed file to a live adapter.
   */
  const mutateBreakpoints = useCallback((
    path: string,
    updater: (list: DebugBreakpoint[]) => DebugBreakpoint[],
  ) => {
    const nextList = updater(breakpointsRef.current[path] ?? []);
    const next = { ...breakpointsRef.current };
    if (nextList.length > 0) next[path] = nextList;
    else delete next[path];
    breakpointsRef.current = next;
    setBreakpoints(next);
    persistBreakpoints(next);
    void syncBreakpointsForPath(path, { list: nextList });
  }, [persistBreakpoints, syncBreakpointsForPath]);

  /**
   * Snapshot the frame's local variables as `name → value` for the editor's
   * inline values (IDEA renders them next to the code). Only the first scope is
   * read: adapters list locals first, and globals/statics are neither on screen
   * nor worth an extra round trip on every step.
   */
  const refreshFrameVariables = useCallback(async (frameId: number, epoch: number) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const scopesBody = await dapSendRequest(id, "scopes", { frameId }).catch(() => null);
    const scopes = (scopesBody as { scopes?: unknown } | null)?.scopes;
    const localRef = Array.isArray(scopes)
      ? scopes
        .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
        .find((s) => typeof s.variablesReference === "number" && s.variablesReference > 0)
      : undefined;
    const ref = typeof localRef?.variablesReference === "number" ? localRef.variablesReference : 0;
    if (ref <= 0) {
      if (mountedRef.current && stopEpochRef.current === epoch) setFrameVariables({});
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
    if (mountedRef.current && stopEpochRef.current === epoch) setFrameVariables(map);
  }, []);

  /** After a `stopped` event, pull threads + stack + exception details for the UI. */
  const refreshStoppedContext = useCallback(async (
    threadId: number | null,
    reason: string | null,
    epoch: number,
  ) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const threadsBody = await dapSendRequest(id, "threads").catch(() => null);
    const threads = parseThreads(threadsBody);
    const tid = threadId ?? threads[0]?.id ?? null;
    let frames: DebugStackFrame[] = [];
    if (tid != null) {
      const stackBody = await dapSendRequest(id, "stackTrace", { threadId: tid, startFrame: 0, levels: 40 })
        .catch(() => null);
      frames = parseStackFrames(stackBody);
    }
    if (!mountedRef.current || stopEpochRef.current !== epoch) return;
    setState((prev) => (prev && prev.status === "stopped"
      ? { ...prev, threads, frames, selectedThreadId: tid, selectedFrameId: frames[0]?.id ?? null }
      : prev));
    if (frames[0]) void refreshFrameVariables(frames[0].id, epoch);
    // IDEA-style exception details when the stop is an exception break.
    if (
      tid != null
      && typeof reason === "string" && reason.toLowerCase().includes("exception")
      && capabilitiesRef.current.supportsExceptionInfoRequest === true
    ) {
      const info = parseExceptionInfo(
        await dapSendRequest(id, "exceptionInfo", { threadId: tid }).catch(() => null),
      );
      if (info && mountedRef.current && stopEpochRef.current === epoch) {
        setState((prev) => (prev && prev.status === "stopped" ? { ...prev, exceptionInfo: info } : prev));
      }
    }
  }, [refreshFrameVariables]);

  const handleEvent = useCallback((payload: DapEventPayload) => {
    if (payload.sessionId !== sessionIdRef.current) return;
    setState((prev) => (prev ? reduceDebugEvent(prev, payload.event, payload.message) : prev));
    if (payload.event === "initialized") {
      initializedRef.current = true;
      // Configure breakpoints before the debuggee runs, then release it.
      void (async () => {
        const id = sessionIdRef.current;
        if (!id) return;
        for (const path of Object.keys(breakpointsRef.current)) {
          if ((breakpointsRef.current[path] ?? []).length > 0) await syncBreakpointsForPath(path);
        }
        const filters = selectExceptionFilters(capabilitiesRef.current, exceptionFiltersRef.current);
        // Configuration-step failures used to be swallowed, leaving the session
        // stuck "running" with no clue why. Surface them on the console so the
        // user (and support) can see where setup broke.
        await dapSendRequest(id, "setExceptionBreakpoints", { filters }).catch((error) => {
          logConsole("stderr", `setExceptionBreakpoints failed: ${errorText(error)}\n`);
        });
        await dapSend(id, "configurationDone").catch((error) => {
          logConsole("stderr", `configurationDone failed: ${errorText(error)}\n`);
        });
      })();
    } else if (payload.event === "stopped") {
      stopEpochRef.current += 1;
      // Run-to-cursor's transient breakpoint is one-shot: restore the user set.
      const temp = tempRunToCursorRef.current;
      tempRunToCursorRef.current = null;
      if (temp) void syncBreakpointsForPath(temp.path);
      const body = (payload.message as { body?: { threadId?: number; reason?: string } })?.body;
      void refreshStoppedContext(body?.threadId ?? null, body?.reason ?? null, stopEpochRef.current);
    } else if (payload.event === "breakpoint") {
      const parsed = parseBreakpointEvent(payload.message);
      const entry = parsed?.id != null ? bpIdIndexRef.current.get(parsed.id) : undefined;
      if (parsed && parsed.line != null && entry) {
        const { path } = entry;
        const { line, verified } = parsed;
        const runtime: BreakpointRuntimeState = verified
          ? { status: "verified", message: null }
          : { status: parsed.bindReason === "failed" ? "failed" : "pending", message: parsed.message };
        setBreakpointRuntime((prev) => ({
          ...prev,
          [path]: { ...(prev[path] ?? {}), [line]: runtime },
        }));
      }
    } else if (payload.event === "terminated" || payload.event === "exited") {
      // Free the backend session (drops the adapter transport / child); the final
      // state stays visible in the panel until the next start.
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (id) void dapTerminate(id).catch(() => {});
      unlistenRef.current?.();
      unlistenRef.current = null;
      bpIdIndexRef.current.clear();
      tempRunToCursorRef.current = null;
      if (mountedRef.current) setBreakpointRuntime({});
    }
  }, [refreshStoppedContext, syncBreakpointsForPath, logConsole]);
  const startDebug = useCallback(async (
    launchConfig: Record<string, unknown>,
    adapterId = "java",
  ) => {
    // One session at a time: tear down any prior one first.
    const prior = sessionIdRef.current;
    sessionIdRef.current = null;
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (prior) await dapTerminate(prior).catch(() => {});
    bpIdIndexRef.current.clear();
    tempRunToCursorRef.current = null;
    if (mountedRef.current) setBreakpointRuntime({});

    lastLaunchRef.current = { config: launchConfig, adapterId };
    let result: Awaited<ReturnType<typeof dapStartSession>>;
    try {
      result = await dapStartSession(adapterId, launchConfig);
    } catch (error) {
      // Adapter resolution failures (no jdtls session, no main class, no
      // debug bundle, classpath/port resolution) reject here. Surface them in
      // the Debug panel — not just the caller's status bar — then rethrow so
      // existing callers keep their behavior.
      reportStartupFailure(`Debug failed to start: ${errorText(error)}`);
      throw error;
    }
    sessionIdRef.current = result.sessionId;
    capabilitiesRef.current = result.capabilities;
    const filters = Array.isArray(result.capabilities.exceptionBreakpointFilters)
      ? (result.capabilities.exceptionBreakpointFilters as { filter: string; label: string }[])
        .filter((f) => f && typeof f.filter === "string")
      : [];
    if (mountedRef.current) {
      setAvailableFilters(filters);
      setCapabilities(result.capabilities);
      setCanRestart(true);
      setState(initialDebugState(result.sessionId));
    }
    // Listen before firing launch so the `initialized` event can't be missed.
    unlistenRef.current = await listenDapEvents(result.sessionId, handleEvent);
    setState((prev) => (prev ? { ...prev, status: "running" } : prev));
    initializedRef.current = false;
    // Fire launch/attach as a correlated request but do NOT await it here: the
    // response only arrives after configurationDone (awaiting would deadlock
    // the initialized → setBreakpoints → configurationDone sequence). The
    // correlation exists to surface failures — when the launch fails the
    // adapter never emits `initialized`, so without this the error response is
    // silently dropped and the UI sits at "running" forever.
    const launchedSession = result.sessionId;
    void dapSendRequest(launchedSession, result.request, result.arguments).catch((error) => {
      if (sessionIdRef.current !== launchedSession) return; // already torn down
      const message = error instanceof Error ? error.message : String(error);
      sessionIdRef.current = null;
      unlistenRef.current?.();
      unlistenRef.current = null;
      void dapTerminate(launchedSession).catch(() => {});
      if (mountedRef.current) {
        setBreakpointRuntime({});
        setState((prev) => (prev && prev.sessionId === launchedSession
          ? appendConsoleLine({ ...prev, status: "terminated" }, "stderr", `Launch failed: ${message}\n`)
          : prev));
      }
    });
    // Watchdog: if the adapter never becomes ready, say so instead of showing
    // an eternally-running empty session.
    window.setTimeout(() => {
      if (sessionIdRef.current !== launchedSession || initializedRef.current) return;
      logConsole(
        "console",
        "Still waiting for the debug adapter to become ready (no 'initialized' event after 15s). "
          + "The project may have build errors, or the launch is stalled.\n",
      );
    }, 15_000);
  }, [handleEvent, logConsole, reportStartupFailure]);

  const restart = useCallback(() => {
    const last = lastLaunchRef.current;
    if (last) void startDebug(last.config, last.adapterId).catch(() => {});
  }, [startDebug]);

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

  /** IDEA "Mute Breakpoints": re-push every file with the new suppression. */
  const setBreakpointsMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    setBreakpointsMutedState(muted);
    for (const path of Object.keys(breakpointsRef.current)) {
      void syncBreakpointsForPath(path);
    }
  }, [syncBreakpointsForPath]);

  const removeAllBreakpoints = useCallback(() => {
    const paths = Object.keys(breakpointsRef.current);
    breakpointsRef.current = {};
    setBreakpoints({});
    persistBreakpoints({});
    for (const path of paths) void syncBreakpointsForPath(path, { list: [] });
  }, [persistBreakpoints, syncBreakpointsForPath]);

  const setExceptionFilters = useCallback((ids: string[]) => {
    setExceptionFiltersState(ids);
    const id = sessionIdRef.current;
    if (id) {
      const filters = selectExceptionFilters(capabilitiesRef.current, ids);
      void dapSendRequest(id, "setExceptionBreakpoints", { filters }).catch(() => {});
    }
  }, []);

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
    if (!id) return;
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
      const epoch = stopEpochRef.current;
      const tid = stateRef.current?.selectedThreadId ?? stateRef.current?.stoppedThreadId;
      try {
        await dapSendRequest(id, stepCommandFor(action), tid != null ? { threadId: tid } : {});
        // Adapters need not emit `continued` after an explicit resume/step —
        // flip to running optimistically unless a newer stop already landed.
        if (mountedRef.current && stopEpochRef.current === epoch) {
          setState((prev) => (prev && prev.status === "stopped" ? markResumed(prev) : prev));
        }
      } catch {
        // Request failed (e.g. already running): keep the current state.
      }
    })();
  }, []);

  const runToCursor = useCallback((path: string, line: number) => {
    const id = sessionIdRef.current;
    const current = stateRef.current;
    if (!id || !current || current.status !== "stopped") return;
    void (async () => {
      const needsTemp = !(breakpointsRef.current[path] ?? []).some(
        (bp) => bp.line === line && bp.enabled !== false,
      ) || mutedRef.current;
      if (needsTemp) {
        tempRunToCursorRef.current = { path };
        await syncBreakpointsForPath(path, { extraTempLine: line });
      }
      const epoch = stopEpochRef.current;
      const tid = current.selectedThreadId ?? current.stoppedThreadId;
      try {
        await dapSendRequest(id, "continue", tid != null ? { threadId: tid } : {});
        if (mountedRef.current && stopEpochRef.current === epoch) {
          setState((prev) => (prev && prev.status === "stopped" ? markResumed(prev) : prev));
        }
      } catch {
        // Continue failed: restore the user's breakpoints right away.
        if (needsTemp) {
          tempRunToCursorRef.current = null;
          await syncBreakpointsForPath(path);
        }
      }
    })();
  }, [syncBreakpointsForPath]);

  const selectThread = useCallback((threadId: number) => {
    const id = sessionIdRef.current;
    if (!id || stateRef.current?.status !== "stopped") return;
    void (async () => {
      const epoch = stopEpochRef.current;
      const stackBody = await dapSendRequest(id, "stackTrace", { threadId, startFrame: 0, levels: 40 })
        .catch(() => null);
      const frames = parseStackFrames(stackBody);
      if (!mountedRef.current || stopEpochRef.current !== epoch) return;
      setState((prev) => (prev && prev.status === "stopped"
        ? { ...prev, selectedThreadId: threadId, frames, selectedFrameId: frames[0]?.id ?? null }
        : prev));
      if (frames[0]) void refreshFrameVariables(frames[0].id, epoch);
    })();
  }, [refreshFrameVariables]);

  const selectFrame = useCallback((frameId: number) => {
    setState((prev) => (prev && prev.status === "stopped" ? { ...prev, selectedFrameId: frameId } : prev));
    // Inline values follow the frame the user is inspecting.
    void refreshFrameVariables(frameId, stopEpochRef.current);
  }, [refreshFrameVariables]);

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
    const id = sessionIdRef.current;
    unlistenRef.current?.();
    unlistenRef.current = null;
    sessionIdRef.current = null;
    bpIdIndexRef.current.clear();
    tempRunToCursorRef.current = null;
    if (id) void dapTerminate(id).catch(() => {});
    if (mountedRef.current) {
      // Mark terminated rather than clearing: IDEA keeps the console and the
      // final state readable after Stop, until the next run replaces it.
      setState((prev) => (prev
        ? {
          ...prev,
          status: "terminated",
          stoppedThreadId: null,
          selectedThreadId: null,
          selectedFrameId: null,
          frames: [],
          exceptionInfo: null,
        }
        : prev));
      setBreakpointRuntime({});
    }
  }, []);

  return {
    state,
    breakpoints,
    breakpointRuntime,
    capabilities,
    availableExceptionFilters: availableFilters,
    enabledExceptionFilters: exceptionFilters,
    watchExpressions,
    breakpointsMuted,
    setBreakpointsMuted,
    removeAllBreakpoints,
    frameVariables,
    startDebug,
    restart,
    canRestart,
    toggleBreakpoint,
    setBreakpointOptions,
    removeBreakpoint,
    setExceptionFilters,
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
    fetchVariables,
    fetchScopes,
    fetchSource,
    terminate,
    currentLocation: state ? currentLocation(state.frames, state.selectedFrameId) : null,
  };
}
