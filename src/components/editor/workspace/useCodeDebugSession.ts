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
  parseStackFrames,
  parseThreads,
  reduceDebugEvent,
  selectExceptionFilters,
  stepCommandFor,
  type DebugBreakpoint,
  type DebugSessionState,
  type DebugStepAction,
} from "./dapDebugModel";

/** Breakpoints keyed by absolute file path. */
export type BreakpointMap = Record<string, DebugBreakpoint[]>;

export interface CodeDebugSession {
  /** Current session state (null when no debug session is active). */
  state: DebugSessionState | null;
  breakpoints: BreakpointMap;
  /** Exception-breakpoint filter ids the adapter advertised (D5). */
  availableExceptionFilters: { filter: string; label: string }[];
  enabledExceptionFilters: string[];
  /** Start a Java debug session with a resolved launch config. */
  startDebug: (launchConfig: Record<string, unknown>) => Promise<void>;
  toggleBreakpoint: (path: string, line: number) => void;
  setBreakpointOptions: (path: string, line: number, options: Partial<DebugBreakpoint>) => void;
  setExceptionFilters: (ids: string[]) => void;
  step: (action: DebugStepAction) => void;
  evaluate: (expression: string, context?: string) => Promise<string>;
  /** Fetch variables for a `variablesReference` (D4 lazy tree). */
  fetchVariables: (variablesReference: number) => Promise<unknown>;
  /** Fetch scopes for a stack frame (D4). */
  fetchScopes: (frameId: number) => Promise<unknown>;
  terminate: () => void;
  /** Source location to highlight as "current" (top frame with a path). */
  currentLocation: { path: string; line: number } | null;
}

function breakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugBreakpoints.v1.${workspaceInstanceId}`;
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
        .map((bp) => ({ line: bp.line, condition: bp.condition, logMessage: bp.logMessage }));
    }
    return out;
  } catch {
    return {};
  }
}
export function useCodeDebugSession(workspaceInstanceId: string): CodeDebugSession {
  const [state, setState] = useState<DebugSessionState | null>(null);
  const [breakpoints, setBreakpoints] = useState<BreakpointMap>(() => readBreakpoints(workspaceInstanceId));
  const [exceptionFilters, setExceptionFiltersState] = useState<string[]>([]);
  const [availableFilters, setAvailableFilters] = useState<{ filter: string; label: string }[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<Record<string, unknown>>({});
  const breakpointsRef = useRef(breakpoints);
  const exceptionFiltersRef = useRef(exceptionFilters);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  breakpointsRef.current = breakpoints;
  exceptionFiltersRef.current = exceptionFilters;

  useEffect(() => () => {
    mountedRef.current = false;
    unlistenRef.current?.();
    const id = sessionIdRef.current;
    if (id) void dapTerminate(id).catch(() => {});
  }, []);

  const persistBreakpoints = useCallback((next: BreakpointMap) => {
    try {
      window.localStorage.setItem(breakpointsKey(workspaceInstanceId), JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }, [workspaceInstanceId]);

  /** Push current breakpoints for a file to the adapter (no-op without a session). */
  const syncBreakpointsForPath = useCallback(async (path: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    await dapSendRequest(id, "setBreakpoints", buildSetBreakpointsArgs(path, breakpointsRef.current[path] ?? []))
      .catch(() => {});
  }, []);

  /** After a `stopped` event, pull threads + top-of-stack frames for the UI. */
  const refreshStoppedContext = useCallback(async (threadId: number | null) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const threadsBody = await dapSendRequest(id, "threads").catch(() => null);
    const threads = parseThreads(threadsBody);
    const tid = threadId ?? threads[0]?.id ?? null;
    let frames: ReturnType<typeof parseStackFrames> = [];
    if (tid != null) {
      const stackBody = await dapSendRequest(id, "stackTrace", { threadId: tid, startFrame: 0, levels: 40 })
        .catch(() => null);
      frames = parseStackFrames(stackBody);
    }
    if (!mountedRef.current) return;
    setState((prev) => (prev ? { ...prev, threads, frames } : prev));
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
      const body = (payload.message as { body?: { threadId?: number } })?.body;
      void refreshStoppedContext(body?.threadId ?? null);
    }
  }, [refreshStoppedContext, syncBreakpointsForPath]);
  const startDebug = useCallback(async (launchConfig: Record<string, unknown>) => {
    // One session at a time: tear down any prior one first.
    const prior = sessionIdRef.current;
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (prior) await dapTerminate(prior).catch(() => {});

    const result = await dapStartSession("java", launchConfig);
    sessionIdRef.current = result.sessionId;
    capabilitiesRef.current = result.capabilities;
    const filters = Array.isArray(result.capabilities.exceptionBreakpointFilters)
      ? (result.capabilities.exceptionBreakpointFilters as { filter: string; label: string }[])
        .filter((f) => f && typeof f.filter === "string")
      : [];
    if (mountedRef.current) {
      setAvailableFilters(filters);
      setState(initialDebugState(result.sessionId));
    }
    // Listen before firing launch so the `initialized` event can't be missed.
    unlistenRef.current = await listenDapEvents(result.sessionId, handleEvent);
    setState((prev) => (prev ? { ...prev, status: "running" } : prev));
    // Fire launch/attach without awaiting (its response trails configurationDone).
    await dapSend(result.sessionId, result.request, result.arguments).catch(() => {});
  }, [handleEvent]);

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

  const step = useCallback((action: DebugStepAction) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const command = stepCommandFor(action);
    const threadId = state?.stoppedThreadId ?? undefined;
    // continue/step take a threadId; pause targets a running thread too.
    void dapSendRequest(id, command, threadId != null ? { threadId } : {}).catch(() => {});
  }, [state?.stoppedThreadId]);

  const evaluate = useCallback(async (expression: string, context = "repl"): Promise<string> => {
    const id = sessionIdRef.current;
    if (!id) return "";
    const frameId = state?.frames[0]?.id;
    const body = await dapSendRequest(id, "evaluate", {
      expression,
      frameId,
      context,
    }).catch((error) => ({ result: error instanceof Error ? error.message : String(error) }));
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    return typeof record.result === "string" ? record.result : "";
  }, [state?.frames]);

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
    if (id) void dapTerminate(id).catch(() => {});
    if (mountedRef.current) setState(null);
  }, []);

  return {
    state,
    breakpoints,
    availableExceptionFilters: availableFilters,
    enabledExceptionFilters: exceptionFilters,
    startDebug,
    toggleBreakpoint,
    setBreakpointOptions,
    setExceptionFilters,
    step,
    evaluate,
    fetchVariables,
    fetchScopes,
    terminate,
    currentLocation: state ? currentLocation(state.frames) : null,
  };
}
