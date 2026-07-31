import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dapSendRequest = vi.fn();
const dapSend = vi.fn();
const dapStartSession = vi.fn();
const dapTerminate = vi.fn();
const listenDapEvents = vi.fn();

vi.mock("../../../lib/editor/dap", () => ({
  dapSendRequest: (...args: unknown[]) => dapSendRequest(...args),
  dapSend: (...args: unknown[]) => dapSend(...args),
  dapStartSession: (...args: unknown[]) => dapStartSession(...args),
  dapTerminate: (...args: unknown[]) => dapTerminate(...args),
  listenDapEvents: (...args: unknown[]) => listenDapEvents(...args),
}));

const { useCodeDebugSession } = await import("./useCodeDebugSession");

/** `setBreakpoints` payloads sent to the adapter, in call order. */
function breakpointCalls(): { path: string; lines: number[] }[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setBreakpoints")
    .map((call) => {
      const args = call[2] as { source: { path: string }; breakpoints: { line: number }[] };
      return { path: args.source.path, lines: args.breakpoints.map((bp) => bp.line) };
    });
}

/** Start a session and return the adapter's event handler. */
async function startSession(
  start: (config: Record<string, unknown>) => Promise<void>,
  capabilities: Record<string, unknown> = {},
): Promise<(payload: { sessionId: string; event: string; message: unknown }) => void> {
  let handler: ((payload: { sessionId: string; event: string; message: unknown }) => void) | null = null;
  listenDapEvents.mockImplementation((_id: string, cb: typeof handler) => {
    handler = cb;
    return Promise.resolve(() => {});
  });
  dapStartSession.mockResolvedValue({
    sessionId: "sess-1",
    capabilities,
    request: "launch",
    arguments: { mainClass: "App" },
  });
  await act(async () => {
    await start({ filePath: "/repo/App.java" });
  });
  if (!handler) throw new Error("no event handler registered");
  return handler;
}

describe("useCodeDebugSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    dapSendRequest.mockReset().mockResolvedValue({ breakpoints: [] });
    dapSend.mockReset().mockResolvedValue(undefined);
    dapStartSession.mockReset();
    dapTerminate.mockReset().mockResolvedValue(undefined);
    listenDapEvents.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the post-change breakpoint set when one is added mid-session", async () => {
    // Regression: the sync used to run inside the setState updater and read the
    // pre-change map, so a breakpoint added while debugging was never armed.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));
    expect(breakpointCalls()[0].lines).toEqual([12]);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 7));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    // Both breakpoints, in line order — not just the one that existed before.
    expect(breakpointCalls()[1].lines).toEqual([7, 12]);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(3));
    expect(breakpointCalls()[2].lines).toEqual([7]);
  });

  it("pushes a condition as soon as it is set, without a second toggle", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));

    act(() => result.current.setBreakpointOptions("/repo/App.java", 12, { condition: "i > 3" }));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    const request = dapSendRequest.mock.calls.filter((c) => c[1] === "setBreakpoints").at(-1);
    expect((request?.[2] as { breakpoints: { condition?: string }[] }).breakpoints[0].condition).toBe("i > 3");
  });

  it("keeps disabled breakpoints listed but does not arm them", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));

    act(() => result.current.setBreakpointOptions("/repo/App.java", 12, { enabled: false }));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    expect(breakpointCalls()[1].lines).toEqual([]);
    expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 12, enabled: false }]);
  });

  it("mutes every file's breakpoints and restores them on unmute", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/A.java", 3));
    act(() => result.current.toggleBreakpoint("/repo/B.java", 9));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));

    act(() => result.current.setBreakpointsMuted(true));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(4));
    expect(breakpointCalls().slice(2).every((call) => call.lines.length === 0)).toBe(true);
    expect(result.current.breakpointsMuted).toBe(true);

    act(() => result.current.setBreakpointsMuted(false));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(6));
    expect(breakpointCalls().slice(4).map((c) => c.lines)).toEqual([[3], [9]]);
  });

  it("ignores a stale setBreakpoints response when a newer one is in flight", async () => {
    // Two quick toggles: the first response resolves last and must not revive
    // the set it was built from.
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setBreakpoints") return Promise.resolve({});
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    act(() => result.current.toggleBreakpoint("/repo/App.java", 20));
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => {
      // Newest first, then the stale one — the adapter moved line 12 to 13.
      resolvers[1]({ breakpoints: [{ id: 2, verified: true, line: 12 }, { id: 3, verified: true, line: 20 }] });
      resolvers[0]({ breakpoints: [{ id: 1, verified: true, line: 13 }] });
      await Promise.resolve();
    });
    expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 12 }, { line: 20 }]);
  });

  it("adopts the line the adapter actually bound and reports verification", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setBreakpoints") return Promise.resolve({});
      // The adapter moved the breakpoint to the next executable line.
      return Promise.resolve({ breakpoints: [{ id: 5, verified: true, line: 14 }] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));

    await waitFor(() => expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 14 }]));
    expect(result.current.breakpointRuntime["/repo/App.java"]).toEqual({
      14: { status: "verified", message: null },
    });
  });

  it("marks an unbindable breakpoint failed with the adapter's reason", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setBreakpoints") return Promise.resolve({});
      return Promise.resolve({
        breakpoints: [{ id: 6, verified: false, line: 12, reason: "failed", message: "No executable code" }],
      });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));

    // Unverified must NOT read as verified: it carries a failed status + reason.
    await waitFor(() => expect(result.current.breakpointRuntime["/repo/App.java"]).toEqual({
      12: { status: "failed", message: "No executable code" },
    }));
  });

  it("configures breakpoints before releasing the debuggee on `initialized`", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.toggleBreakpoint("/repo/App.java", 4));
    const emit = await startSession(result.current.startDebug, {
      exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught" }],
    });

    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone"));
    // Order matters: an adapter that resumes on configurationDone must already
    // have the breakpoints.
    const commands = dapSendRequest.mock.calls.map((call) => call[1]);
    expect(commands.indexOf("setBreakpoints")).toBeLessThan(commands.indexOf("setExceptionBreakpoints"));
    expect(breakpointCalls()[0].lines).toEqual([4]);
  });

  it("surfaces a failed configuration step on the console instead of swallowing it", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setExceptionBreakpoints") return Promise.reject(new Error("adapter rejected filters"));
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    // The failure is visible in the debug console (was previously silent).
    await waitFor(() =>
      expect(result.current.state?.output.some(
        (line) => line.category === "stderr" && line.text.includes("setExceptionBreakpoints failed"),
      )).toBe(true));
  });

  it("seeds a visible terminated session when a pre-launch failure is reported", async () => {
    // A failure before any session exists (no active jdtls / no main class /
    // no debug bundle) must render in the Debug panel, not vanish — the panel
    // only shows its console when `state` is non-null.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    expect(result.current.state).toBeNull();

    act(() => result.current.reportStartupFailure("No runnable main class found"));

    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output).toEqual([
      { category: "stderr", text: "No runnable main class found\n" },
    ]);
  });

  it("shows pre-launch progress before an adapter session exists", async () => {
    // Save → build → resolve-main-class all run before `dapStartSession`, and on
    // a cold project that is tens of seconds. Without a seeded session the panel
    // shows its "no debug session" placeholder and the click looks ignored.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.reportStartupProgress("Building project…"));
    expect(result.current.state?.status).toBe("starting");
    expect(result.current.state?.output).toEqual([
      { category: "console", text: "Building project…\n" },
    ]);

    act(() => result.current.reportStartupProgress("Resolving main class…"));
    expect(result.current.state?.output.map((line) => line.text)).toEqual([
      "Building project…\n",
      "Resolving main class…\n",
    ]);

    // The real session adopts those lines, so the console reads as one log.
    await startSession(result.current.startDebug);
    expect(result.current.state?.sessionId).toBe("sess-1");
    expect(result.current.state?.output.map((line) => line.text)).toEqual([
      "Building project…\n",
      "Resolving main class…\n",
    ]);
  });

  it("replaces a terminated run's console when the next start reports progress", () => {
    // Progress from a new attempt must not read as output of the finished one.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.reportStartupFailure("Launch failed: boom"));
    expect(result.current.state?.status).toBe("terminated");

    act(() => result.current.reportStartupProgress("Starting debug for App.java"));
    expect(result.current.state?.status).toBe("starting");
    expect(result.current.state?.output).toEqual([
      { category: "console", text: "Starting debug for App.java\n" },
    ]);
  });

  it("surfaces a dapStartSession rejection in the debug console", async () => {
    // Adapter resolution failures reject `dapStartSession`; the panel must show
    // the reason (previously only the transient status bar did) and the call
    // must still reject so callers keep their existing error handling.
    dapStartSession.mockRejectedValue(new Error("No Java language server session is active"));
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));

    await act(async () => {
      await expect(result.current.startDebug({ filePath: "/repo/App.java" })).rejects.toThrow(
        "No Java language server session is active",
      );
    });

    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output.some(
      (line) => line.category === "stderr" && line.text.includes("Debug failed to start")
        && line.text.includes("No Java language server session is active"),
    )).toBe(true);
  });

  it("keeps the console readable after an explicit stop", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => {
      emit({
        sessionId: "sess-1",
        event: "output",
        message: { body: { category: "stdout", output: "hello\n" } },
      });
    });
    act(() => result.current.terminate());

    // IDEA leaves the output visible after Stop; only the next run replaces it.
    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output).toEqual([{ category: "stdout", text: "hello\n" }]);
    expect(dapTerminate).toHaveBeenCalledWith("sess-1");

    act(() => result.current.clearConsole());
    expect(result.current.state?.output).toEqual([]);
  });

  it("only evaluates hovers while stopped", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    // Running: no frame to evaluate against, so no tooltip and no round trip.
    await expect(result.current.hoverEvaluate("total")).resolves.toBeNull();
    expect(dapSendRequest.mock.calls.some((c) => c[1] === "evaluate")).toBe(false);

    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "threads") return Promise.resolve({ threads: [{ id: 1, name: "main" }] });
      if (command === "stackTrace") {
        return Promise.resolve({
          stackFrames: [{ id: 10, name: "App.main", line: 9, source: { path: "/repo/App.java" } }],
        });
      }
      if (command === "scopes") return Promise.resolve({ scopes: [{ name: "Local", variablesReference: 2 }] });
      if (command === "variables") return Promise.resolve({ variables: [{ name: "total", value: "42" }] });
      if (command === "evaluate") return Promise.resolve({ result: "42", variablesReference: 0 });
      return Promise.resolve({});
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "stopped", message: { body: { threadId: 1, reason: "breakpoint" } } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));

    await expect(result.current.hoverEvaluate("total")).resolves.toMatchObject({ value: "42" });
    // The stopped frame's locals feed the editor's inline values.
    await waitFor(() => expect(result.current.frameVariables).toEqual({ total: "42" }));
  });
});
