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
  reconcileBreakpointLines,
  reduceDebugEvent,
  selectExceptionFilters,
  sortedBreakpoints,
  stepCommandFor,
  toAdapterSourcePath,
  type DebugBreakpoint,
  type DebugSessionState,
  type DebugStackFrame,
  type DebugStepAction,
  type EvaluateResult,
} from "./dapDebugModel";

/** Breakpoints keyed by absolute file path. */
export type BreakpointMap = Record<string, DebugBreakpoint[]>;

export interface CodeDebugSession {
  /** Current session state (null when no debug session is active). */
  state: DebugSessionState | null;
  breakpoints: BreakpointMap;
  /** Adapter verification per path → line → verified (session-scoped). */
  breakpointRuntime: Record<string, Record<number, boolean>>;
  /** Adapter capabilities from `initialize` — gates optional UI (restartFrame, setVariable…). */
  capabilities: Record<string, unknown>;
  /** Exception-breakpoint filter ids the adapter advertised (D5). */
  availableExceptionFilters: { filter: string; label: string }[];
  enabledExceptionFilters: string[];
  /** Persistent watch expressions (the panel evaluates them per stop). */
  watchExpressions: string[];
  /** Start a debug session with a resolved launch config (adapter defaults to Java). */
  startDebug: (launchConfig: Record<string, unknown>, adapterId?: string) => Promise<void>;
  /** Re-run the last launch config (IDEA rerun). */
  restart: () => void;
  canRestart: boolean;
  toggleBreakpoint: (path: string, line: number) => void;
  setBreakpointOptions: (path: string, line: number, options: Partial<DebugBreakpoint>) => void;
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
  /** Change a variable's value (DAP `setVariable`; capability-gated). */
  setVariable: (variablesReference: number, name: string, value: string) => Promise<EvaluateResult | null>;
  /** Append a client-side line (REPL echo / result) to the session console. */
  logConsole: (category: string, text: string) => void;
  /** Fetch variables for a `variablesReference` (D4 lazy tree). */
  fetchVariables: (variablesReference: number) => Promise<unknown>;
  /** Fetch scopes for a stack frame (D4). */
  fetchScopes: (frameId: number) => Promise<unknown>;
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
  const [breakpointRuntime, setBreakpointRuntime] = useState<Record<string, Record<number, boolean>>>({});
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
  const [exceptionFilters, setExceptionFiltersState] = useState<string[]>([]);
  const [availableFilters, setAvailableFilters] = useState<{ filter: string; label: string }[]>([]);
  const [watchExpressions, setWatchExpressions] = useState<string[]>(() => readWatches(workspaceInstanceId));
  const [canRestart, setCanRestart] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<Record<string, unknown>>({});
  const breakpointsRef = useRef(breakpoints);
  const exceptionFiltersRef = useRef(exceptionFilters);
  const stateRef = useRef<DebugSessionState | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  /** Bumped on every `stopped` event; async work checks it to drop stale results. */
  const stopEpochRef = useRef(0);
  /** Adapter breakpoint id → file path, to route `breakpoint` events. */
  const bpIdIndexRef = useRef(new Map<number, { path: string }>());
  /** Pending run-to-cursor: its transient breakpoint is removed on the next stop. */
  const tempRunToCursorRef = useRef<{ path: string } | null>(null);
  const lastLaunchRef = useRef<{ config: Record<string, unknown>; adapterId: string } | null>(null);
  breakpointsRef.current = breakpoints;
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

  /**
   * Push current breakpoints for a file to the adapter and record the bindings
   * it reports: verified flags feed the gutter (grey = not bound), verified
   * line adjustments are adopted back into the stored set (IDEA/VS Code move a
   * breakpoint on a blank line to the next executable one). `extraTempLine`
   * injects the transient run-to-cursor breakpoint without persisting it.
   */
  const syncBreakpointsForPath = useCallback(async (path: string, extraTempLine?: number) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const stored = sortedBreakpoints(breakpointsRef.current[path] ?? []);
    const requested = extraTempLine != null && !stored.some((bp) => bp.line === extraTempLine)
      ? sortedBreakpoints([...stored, { line: extraTempLine }])
      : stored;
    // Breakpoints are keyed by our internal (forward-slash) path, but the adapter
    // needs the OS-native form (Windows: lowercase drive + backslashes) or it
    // leaves them unverified.
    const args = buildSetBreakpointsArgs(path, requested);
    args.source.path = toAdapterSourcePath(path);
    const body = await dapSendRequest(id, "setBreakpoints", args).catch(() => null);
    if (body == null || !mountedRef.current) return;
    const bindings = parseSetBreakpointsResponse(requested, body);
    for (const binding of bindings) {
      if (binding.id != null) bpIdIndexRef.current.set(binding.id, { path });
    }
    setBreakpointRuntime((prev) => ({
      ...prev,
      [path]: Object.fromEntries(requested.map((bp, i) => [
        bindings[i]?.line ?? bp.line,
        bindings[i]?.verified ?? false,
      ])),
    }));
    if (extraTempLine == null) {
      const reconciled = reconcileBreakpointLines(requested, bindings);
      if (JSON.stringify(reconciled) !== JSON.stringify(stored)) {
        setBreakpoints((current) => {
          const next = { ...current };
          if (reconciled.length > 0) next[path] = reconciled;
          else delete next[path];
          persistBreakpoints(next);
          return next;
        });
      }
    }
  }, [persistBreakpoints]);

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
  }, []);

  const handleEvent = useCallback((payload: DapEventPayload) => {
    if (payload.sessionId !== sessionIdRef.current) return;
    setState((prev) => (prev ? reduceDebugEvent(prev, payload.event, payload.message) : prev));
    if (payload.event === "initialized") {
      // Configure breakpoints before the debuggee runs, then release it.
      void (async () => {
        const id = sessionIdRef.current;
        if (!id) return;
        for (const path of Object.keys(breakpointsRef.current)) {
          if ((breakpointsRef.current[path] ?? []).length > 0) await syncBreakpointsForPath(path);
        }
        const filters = selectExceptionFilters(capabilitiesRef.current, exceptionFiltersRef.current);
        await dapSendRequest(id, "setExceptionBreakpoints", { filters }).catch(() => {});
        await dapSend(id, "configurationDone").catch(() => {});
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
        setBreakpointRuntime((prev) => ({
          ...prev,
          [path]: { ...(prev[path] ?? {}), [line]: verified },
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
  }, [refreshStoppedContext, syncBreakpointsForPath]);
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
    const result = await dapStartSession(adapterId, launchConfig);
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
    // Fire launch/attach without awaiting (its response trails configurationDone).
    await dapSend(result.sessionId, result.request, result.arguments).catch(() => {});
  }, [handleEvent]);

  const restart = useCallback(() => {
    const last = lastLaunchRef.current;
    if (last) void startDebug(last.config, last.adapterId).catch(() => {});
  }, [startDebug]);

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpoints((current) => {
      const list = current[path] ?? [];
      const exists = list.some((bp) => bp.line === line);
      const nextList = exists ? list.filter((bp) => bp.line !== line) : [...list, { line }];
      const next = { ...current };
      if (nextList.length > 0) next[path] = nextList;
      else delete next[path];
      persistBreakpoints(next);
      void syncBreakpointsForPath(path);
      return next;
    });
  }, [persistBreakpoints, syncBreakpointsForPath]);

  const setBreakpointOptions = useCallback((path: string, line: number, options: Partial<DebugBreakpoint>) => {
    setBreakpoints((current) => {
      const list = current[path] ?? [];
      if (!list.some((bp) => bp.line === line)) return current;
      const nextList = list.map((bp) => (bp.line === line ? { ...bp, ...options } : bp));
      const next = { ...current, [path]: nextList };
      persistBreakpoints(next);
      void syncBreakpointsForPath(path);
      return next;
    });
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
      const needsTemp = !(breakpointsRef.current[path] ?? []).some((bp) => bp.line === line);
      if (needsTemp) {
        tempRunToCursorRef.current = { path };
        await syncBreakpointsForPath(path, line);
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
    })();
  }, []);

  const selectFrame = useCallback((frameId: number) => {
    setState((prev) => (prev && prev.status === "stopped" ? { ...prev, selectedFrameId: frameId } : prev));
  }, []);

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

  const terminate = useCallback(() => {
    const id = sessionIdRef.current;
    unlistenRef.current?.();
    unlistenRef.current = null;
    sessionIdRef.current = null;
    bpIdIndexRef.current.clear();
    tempRunToCursorRef.current = null;
    if (id) void dapTerminate(id).catch(() => {});
    if (mountedRef.current) {
      setState(null);
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
    startDebug,
    restart,
    canRestart,
    toggleBreakpoint,
    setBreakpointOptions,
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
    setVariable,
    logConsole,
    fetchVariables,
    fetchScopes,
    terminate,
    currentLocation: state ? currentLocation(state.frames, state.selectedFrameId) : null,
  };
}
