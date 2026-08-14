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
const { dataBreakpointKey } = await import("./dapDebugModel");

/** `setBreakpoints` payloads sent to the adapter, in call order. */
function breakpointCalls(): { sessionId: string; path: string; lines: number[] }[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setBreakpoints")
    .map((call) => {
      const args = call[2] as { source: { path: string }; breakpoints: { line: number }[] };
      return { sessionId: String(call[0]), path: args.source.path, lines: args.breakpoints.map((bp) => bp.line) };
    });
}

function functionBreakpointCalls(): {
  sessionId: string;
  breakpoints: { name: string; condition?: string; hitCondition?: string }[];
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setFunctionBreakpoints")
    .map((call) => ({
      sessionId: String(call[0]),
      breakpoints: (call[2] as {
        breakpoints: { name: string; condition?: string; hitCondition?: string }[];
      }).breakpoints,
    }));
}

function dataBreakpointCalls(): {
  sessionId: string;
  breakpoints: { dataId: string; accessType?: string; condition?: string; hitCondition?: string }[];
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setDataBreakpoints")
    .map((call) => ({
      sessionId: String(call[0]),
      breakpoints: (call[2] as {
        breakpoints: { dataId: string; accessType?: string; condition?: string; hitCondition?: string }[];
      }).breakpoints,
    }));
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

  it("persists and binds function breakpoints before configurationDone", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setFunctionBreakpoints") {
        return Promise.resolve({ breakpoints: [{ id: 41, verified: true }] });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    act(() => result.current.setFunctionBreakpointOptions("Service.run", {
      condition: "ready",
      hitCondition: "3",
    }));
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugFunctionBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual([{ name: "Service.run", condition: "ready", hitCondition: "3" }]);

    const emit = await startSession(result.current.startDebug, { supportsFunctionBreakpoints: true });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "verified",
      message: null,
    }));
    expect(functionBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      breakpoints: [{ name: "Service.run", condition: "ready", hitCondition: "3" }],
    }]);
    const commands = dapSendRequest.mock.calls.map((call) => call[1]);
    expect(commands.indexOf("setFunctionBreakpoints")).toBeLessThan(
      commands.indexOf("setExceptionBreakpoints"),
    );
    expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone");

    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          reason: "changed",
          breakpoint: {
            id: 41,
            verified: false,
            reason: "failed",
            message: "method unloaded",
          },
        },
      },
    }));
    expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "failed",
      message: "method unloaded",
    });
  });

  it("normalizes function-breakpoint fields before storing or syncing them", () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const longName = "n".repeat(1100);
    const longCondition = "c".repeat(4200);
    const longHitCondition = "7".repeat(4200);

    act(() => result.current.addFunctionBreakpoint(`  ${longName}  `));
    const name = result.current.functionBreakpoints[0].name;
    expect(name).toHaveLength(1024);
    act(() => result.current.setFunctionBreakpointOptions(name, {
      condition: `  ${longCondition}  `,
      hitCondition: `  ${longHitCondition}  `,
    }));

    expect(result.current.functionBreakpoints[0].condition).toHaveLength(4096);
    expect(result.current.functionBreakpoints[0].hitCondition).toHaveLength(4096);
    act(() => result.current.setFunctionBreakpointOptions(name, { condition: "   " }));
    expect(result.current.functionBreakpoints[0].condition).toBeUndefined();
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugFunctionBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual(result.current.functionBreakpoints);
  });

  it("ignores a stale function-breakpoint response after a newer edit", async () => {
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setFunctionBreakpoints") {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    const emit = await startSession(result.current.startDebug, { supportsFunctionBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolvers).toHaveLength(1));

    act(() => result.current.setFunctionBreakpointOptions("Service.run", { condition: "ready" }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ breakpoints: [{ id: 52, verified: true }] });
      resolvers[0]({
        breakpoints: [{ id: 51, verified: false, reason: "failed", message: "stale" }],
      });
      await Promise.resolve();
    });
    expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "verified",
      message: null,
    });
  });

  it("drops a function-breakpoint response that arrives after termination", async () => {
    let resolveFunctionBreakpoints: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setFunctionBreakpoints") {
        return new Promise((resolve) => { resolveFunctionBreakpoints = resolve; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    const emit = await startSession(result.current.startDebug, { supportsFunctionBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolveFunctionBreakpoints).not.toBeNull());
    expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "pending",
      message: null,
    });

    await act(async () => result.current.terminate());
    await waitFor(() => expect(result.current.state?.status).toBe("terminated"));
    expect(result.current.functionBreakpointRuntime).toEqual({});
    await act(async () => {
      resolveFunctionBreakpoints?.({ breakpoints: [{ id: 61, verified: true }] });
      await Promise.resolve();
    });
    expect(result.current.functionBreakpointRuntime).toEqual({});
  });

  it("keeps saved function breakpoints visible when the adapter is unsupported", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    const emit = await startSession(result.current.startDebug);
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "failed",
      message: "The selected debug adapter does not support function breakpoints",
    }));
    expect(functionBreakpointCalls()).toEqual([]);
    expect(result.current.functionBreakpoints).toEqual([{ name: "Service.run" }]);
  });

  it("restores persisted data breakpoints before configurationDone", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:Service.count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["write"],
        accessType: "write",
        condition: "ready",
        canPersist: true,
      }]),
    );
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setDataBreakpoints") {
        return Promise.resolve({ breakpoints: [{ id: 80, verified: true }] });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    expect(result.current.dataBreakpoints).toHaveLength(1);

    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));

    await waitFor(() => expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone"));
    expect(dataBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      breakpoints: [{
        dataId: "field:Service.count",
        accessType: "write",
        condition: "ready",
      }],
    }]);
    const setDataIndex = dapSendRequest.mock.calls.findIndex((call) => call[1] === "setDataBreakpoints");
    const configurationDoneIndex = dapSend.mock.calls.findIndex((call) => call[1] === "configurationDone");
    expect(dapSendRequest.mock.invocationCallOrder[setDataIndex]).toBeLessThan(
      dapSend.mock.invocationCallOrder[configurationDoneIndex],
    );
  });

  it("discovers, persists, arms, edits and removes a data breakpoint", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "dataBreakpointInfo") {
        return Promise.resolve({
          dataId: "field:Service.count",
          description: "Service.count",
          accessTypes: ["read", "write"],
          canPersist: true,
        });
      }
      if (command === "setDataBreakpoints") {
        const args = dapSendRequest.mock.calls.at(-1)?.[2] as { breakpoints: unknown[] };
        return Promise.resolve({
          breakpoints: args.breakpoints.map((_entry, index) => ({ id: 81 + index, verified: true })),
        });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(dataBreakpointCalls()).toHaveLength(1));
    expect(dataBreakpointCalls()[0].breakpoints).toEqual([]);

    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));
    let addResult: { added: boolean; message: string } | undefined;
    await act(async () => {
      addResult = await result.current.addDataBreakpoint({ name: "count", variablesReference: 2, frameId: 10 });
    });
    expect(addResult?.added).toBe(true);
    await waitFor(() => expect(result.current.dataBreakpoints).toHaveLength(1));
    const breakpoint = result.current.dataBreakpoints[0];
    const key = dataBreakpointKey(breakpoint);
    expect(breakpoint.canPersist).toBe(true);
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual(result.current.dataBreakpoints);
    expect(dapSendRequest.mock.calls.some((call) => (
      call[1] === "dataBreakpointInfo"
      && (call[2] as { name: string; variablesReference?: number }).name === "count"
      && (call[2] as { variablesReference?: number }).variablesReference === 2
      && !(call[2] as { frameId?: number }).frameId
    ))).toBe(true);
    await waitFor(() => expect(result.current.dataBreakpointRuntime[key]).toEqual({
      status: "verified",
      message: null,
    }));

    act(() => result.current.setDataBreakpointOptions(key, {
      accessType: "read",
      condition: "ready",
      hitCondition: "2",
    }));
    await waitFor(() => expect(dataBreakpointCalls().at(-1)?.breakpoints).toEqual([{
      dataId: "field:Service.count",
      accessType: "read",
      condition: "ready",
      hitCondition: "2",
    }]));
    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          breakpoint: { id: 81, verified: false, reason: "failed", message: "field unloaded" },
        },
      },
    }));
    expect(result.current.dataBreakpointRuntime[key]).toEqual({
      status: "failed",
      message: "field unloaded",
    });
    act(() => result.current.removeDataBreakpoint(key));
    await waitFor(() => expect(result.current.dataBreakpoints).toEqual([]));
    expect(dataBreakpointCalls().at(-1)?.breakpoints).toEqual([]);
  });

  it("rejects a data breakpoint when execution resumes during discovery", async () => {
    let resolveInfo: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "dataBreakpointInfo") {
        return new Promise((resolve) => { resolveInfo = resolve; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));

    let pending!: Promise<{ added: boolean; message: string }>;
    act(() => {
      pending = result.current.addDataBreakpoint({ name: "count", frameId: 10 });
    });
    await waitFor(() => expect(resolveInfo).not.toBeNull());
    act(() => emit({ sessionId: "sess-1", event: "continued", message: {} }));
    expect(result.current.state?.status).toBe("running");

    let addResult: { added: boolean; message: string } | undefined;
    await act(async () => {
      resolveInfo?.({
        dataId: "frame-local:count",
        description: "count",
        canPersist: false,
      });
      addResult = await pending;
    });
    expect(addResult).toEqual({
      added: false,
      message: "Execution resumed before the data breakpoint was resolved",
    });
    expect(result.current.dataBreakpoints).toEqual([]);
  });

  it("ignores a stale data-breakpoint response after a newer edit", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:Service.count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["read", "write"],
        accessType: "write",
        canPersist: true,
      }]),
    );
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setDataBreakpoints") {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    const key = dataBreakpointKey(result.current.dataBreakpoints[0]);

    act(() => result.current.setDataBreakpointOptions(key, { condition: "ready" }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ breakpoints: [{ id: 102, verified: true }] });
      resolvers[0]({
        breakpoints: [{ id: 101, verified: false, reason: "failed", message: "stale" }],
      });
      await Promise.resolve();
    });
    expect(result.current.dataBreakpointRuntime[key]).toEqual({
      status: "verified",
      message: null,
    });
  });

  it("drops a data-breakpoint response that arrives after termination", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:Service.count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["write"],
        accessType: "write",
        canPersist: true,
      }]),
    );
    let resolveDataBreakpoints: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setDataBreakpoints") {
        return new Promise((resolve) => { resolveDataBreakpoints = resolve; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolveDataBreakpoints).not.toBeNull());
    expect(Object.values(result.current.dataBreakpointRuntime)).toEqual([{
      status: "pending",
      message: null,
    }]);

    await act(async () => result.current.terminate());
    await waitFor(() => expect(result.current.state?.status).toBe("terminated"));
    expect(result.current.dataBreakpointRuntime).toEqual({});
    await act(async () => {
      resolveDataBreakpoints?.({ breakpoints: [{ id: 103, verified: true }] });
      await Promise.resolve();
    });
    expect(result.current.dataBreakpointRuntime).toEqual({});
  });

  it("keeps non-persistent data ids session-scoped and removes them on termination", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "dataBreakpointInfo") {
        return Promise.resolve({ dataId: "frame-local:count", description: "count", canPersist: false });
      }
      if (command === "setDataBreakpoints") return Promise.resolve({ breakpoints: [{ id: 91, verified: true }] });
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));
    await act(async () => {
      await result.current.addDataBreakpoint({ name: "count", frameId: 10 });
    });
    await waitFor(() => expect(result.current.dataBreakpoints).toHaveLength(1));
    expect(result.current.dataBreakpoints[0].canPersist).toBe(false);
    expect(result.current.dataBreakpoints[0].sessionId).toBe("sess-1");
    expect(window.localStorage.getItem("taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1")).toBe("[]");

    act(() => result.current.terminate());
    await waitFor(() => expect(result.current.dataBreakpoints).toEqual([]));
  });

  it("does not send persisted data ids to an unsupported adapter", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["write"],
        accessType: "write",
        canPersist: true,
      }]),
    );
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    expect(dataBreakpointCalls()).toEqual([]);
    await waitFor(() => expect(result.current.dataBreakpointRuntime).toEqual({
      [dataBreakpointKey(result.current.dataBreakpoints[0])]: {
        status: "failed",
        message: "The selected debug adapter does not support data breakpoints",
      },
    }));
    expect(result.current.dataBreakpoints).toHaveLength(1);
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

  it("carries startup lines reported in one React batch into the adapter session", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    let handler: ((payload: { sessionId: string; event: string; message: unknown }) => void) | null = null;
    listenDapEvents.mockImplementation((_id: string, callback: typeof handler) => {
      handler = callback;
      return Promise.resolve(() => {});
    });
    dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "App" },
    });

    await act(async () => {
      result.current.reportStartupProgress("Starting debug for App.java");
      result.current.reportStartupProgress("Building project…");
      result.current.reportStartupProgress("Launching com.acme.App…");
      await result.current.startDebug({ filePath: "/repo/App.java" });
    });

    expect(handler).not.toBeNull();
    expect(result.current.state?.sessionId).toBe("sess-1");
    expect(result.current.state?.output.map((line) => line.text)).toEqual([
      "Starting debug for App.java\n",
      "Building project…\n",
      "Launching com.acme.App…\n",
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
    await act(async () => result.current.terminate());

    // IDEA leaves the output visible after Stop; only the next run replaces it.
    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output).toEqual([{ category: "stdout", text: "hello\n" }]);
    expect(dapTerminate).toHaveBeenCalledWith("sess-1");

    act(() => result.current.clearConsole());
    expect(result.current.state?.output).toEqual([]);
  });

  it("starts parallel compound children and broadcasts breakpoints to every live session", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId),
      capabilities: { supportsFunctionBreakpoints: true },
      request: "launch",
      arguments: config,
    }));
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    let started!: Promise<void>;
    act(() => {
      started = result.current.startDebugGroup({
        id: "all",
        label: "All services",
        parallel: true,
        children: [
          { id: "api", label: "API", adapterId: "java", launchConfig: { sessionId: "sess-api" } },
          { id: "web", label: "Web", adapterId: "node", launchConfig: { sessionId: "sess-web" } },
        ],
      });
    });
    await waitFor(() => expect(handlers.size).toBe(2));
    expect(dapStartSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      handlers.get("sess-api")?.({ sessionId: "sess-api", event: "initialized", message: {} });
      handlers.get("sess-web")?.({ sessionId: "sess-web", event: "initialized", message: {} });
      await started;
    });
    expect(result.current.sessions.map((session) => session.label)).toEqual(["API", "Web"]);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    expect(breakpointCalls().map((call) => call.sessionId).sort()).toEqual(["sess-api", "sess-web"]);

    act(() => result.current.addFunctionBreakpoint("Service.run"));
    await waitFor(() => expect(functionBreakpointCalls()).toHaveLength(4));
    expect(functionBreakpointCalls().slice(-2).map((call) => call.sessionId).sort()).toEqual([
      "sess-api",
      "sess-web",
    ]);
    expect(functionBreakpointCalls().slice(-2).every((call) => (
      call.breakpoints[0]?.name === "Service.run"
    ))).toBe(true);

    act(() => {
      handlers.get("sess-web")?.({
        sessionId: "sess-web",
        event: "stopped",
        message: { body: { reason: "breakpoint", threadId: 7 } },
      });
    });
    await waitFor(() => expect(result.current.activeSessionId).toBe("sess-web"));
    expect(result.current.state?.status).toBe("stopped");

    act(() => {
      handlers.get("sess-web")?.({ sessionId: "sess-web", event: "terminated", message: {} });
    });
    await waitFor(() => expect(result.current.activeSessionId).toBe("sess-api"));
    expect(result.current.state?.status).toBe("running");

    await act(async () => result.current.terminate());
    expect(dapTerminate).toHaveBeenCalledWith("sess-api");
    expect(dapTerminate).toHaveBeenCalledWith("sess-web");
    expect(result.current.sessions.every((session) => session.status === "terminated")).toBe(true);
  });

  it("waits for each sequential compound child before starting the next", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId), capabilities: {}, request: "launch", arguments: config,
    }));
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    let started!: Promise<void>;
    act(() => {
      started = result.current.startDebugGroup({
        id: "all", label: "All", children: [
          { id: "one", label: "One", adapterId: "java", launchConfig: { sessionId: "sess-1" } },
          { id: "two", label: "Two", adapterId: "java", launchConfig: { sessionId: "sess-2" } },
        ],
      });
    });
    await waitFor(() => expect(handlers.has("sess-1")).toBe(true));
    expect(dapStartSession).toHaveBeenCalledTimes(1);
    act(() => handlers.get("sess-1")?.({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(handlers.has("sess-2")).toBe(true));
    expect(dapStartSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      handlers.get("sess-2")?.({ sessionId: "sess-2", event: "initialized", message: {} });
      await started;
    });
    expect(result.current.sessions.map((session) => session.targetId)).toEqual(["one", "two"]);
  });

  it("stops already-started children when a parallel compound child fails", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId), capabilities: {}, request: "launch", arguments: config,
    }));
    let rejectBadLaunch!: (error: Error) => void;
    dapSendRequest.mockImplementation((id: string, command: string) => {
      if (id === "sess-bad" && command === "launch") {
        return new Promise((_resolve, reject) => { rejectBadLaunch = reject; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const started = result.current.startDebugGroup({
      id: "all", label: "All", parallel: true, children: [
        { id: "ready", label: "Ready", adapterId: "java", launchConfig: { sessionId: "sess-ready" } },
        { id: "bad", label: "Bad", adapterId: "java", launchConfig: { sessionId: "sess-bad" } },
      ],
    });
    const failed = started.then(() => null, (error: unknown) => error);
    await waitFor(() => expect(handlers.size).toBe(2));
    act(() => {
      handlers.get("sess-ready")?.({ sessionId: "sess-ready", event: "initialized", message: {} });
      rejectBadLaunch(new Error("adapter rejected launch"));
    });
    await expect(failed).resolves.toMatchObject({ message: "adapter rejected launch" });
    await waitFor(() => expect(dapTerminate).toHaveBeenCalledWith("sess-ready"));
    expect(dapTerminate).toHaveBeenCalledWith("sess-bad");
    await waitFor(() => {
      expect(result.current.sessions.every((session) => session.status === "terminated")).toBe(true);
    });
  });

  it("keeps successful children alive when compound stopOnFailure is disabled", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId), capabilities: {}, request: "launch", arguments: config,
    }));
    let rejectBadLaunch!: (error: Error) => void;
    dapSendRequest.mockImplementation((id: string, command: string) => {
      if (id === "sess-bad" && command === "launch") {
        return new Promise((_resolve, reject) => { rejectBadLaunch = reject; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const started = result.current.startDebugGroup({
      id: "all", label: "All", parallel: true, stopOnFailure: false, children: [
        { id: "ready", label: "Ready", adapterId: "java", launchConfig: { sessionId: "sess-ready" } },
        { id: "bad", label: "Bad", adapterId: "java", launchConfig: { sessionId: "sess-bad" } },
      ],
    });
    const failed = started.then(() => null, (error: unknown) => error);
    await waitFor(() => expect(handlers.size).toBe(2));
    act(() => {
      handlers.get("sess-ready")?.({ sessionId: "sess-ready", event: "initialized", message: {} });
      rejectBadLaunch(new Error("adapter rejected launch"));
    });
    await expect(failed).resolves.toMatchObject({ message: "adapter rejected launch" });
    expect(dapTerminate).not.toHaveBeenCalledWith("sess-ready");
    expect(result.current.sessions.find((session) => session.id === "sess-ready")?.status).toBe("running");
    await waitFor(() => {
      expect(result.current.sessions.find((session) => session.id === "sess-bad")?.status).toBe("terminated");
    });
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
