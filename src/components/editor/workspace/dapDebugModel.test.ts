import { describe, expect, it } from "vitest";
import {
  appendConsoleLine,
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
} from "./dapDebugModel";

describe("dapDebugModel", () => {
  it("converts Windows drive paths to lowercase drive + backslashes for the adapter", () => {
    // java-debug leaves breakpoints unverified unless the source path matches
    // JDT's native form (lowercase drive + backslashes).
    expect(toAdapterSourcePath("D:/code/ads/ique/src/App.java")).toBe("d:\\code\\ads\\ique\\src\\App.java");
    expect(toAdapterSourcePath("C:/Users/x/Main.java")).toBe("c:\\Users\\x\\Main.java");
  });

  it("leaves POSIX absolute paths unchanged", () => {
    expect(toAdapterSourcePath("/home/user/project/src/App.java")).toBe("/home/user/project/src/App.java");
  });

  it("maps step actions to DAP commands", () => {
    expect(stepCommandFor("continue")).toBe("continue");
    expect(stepCommandFor("stepOver")).toBe("next");
    expect(stepCommandFor("stepIn")).toBe("stepIn");
    expect(stepCommandFor("stepOut")).toBe("stepOut");
    expect(stepCommandFor("pause")).toBe("pause");
  });

  it("builds setBreakpoints args sorted, with condition + hitCondition + logMessage", () => {
    const args = buildSetBreakpointsArgs("/repo/src/App.java", [
      { line: 20 },
      { line: 5, condition: " x > 1 " },
      { line: 12, logMessage: "hit {x}" },
      { line: 8, hitCondition: " 5 " },
    ]);
    expect(args.source).toEqual({ path: "/repo/src/App.java", name: "App.java" });
    expect(args.breakpoints).toEqual([
      { line: 5, condition: "x > 1" },
      { line: 8, hitCondition: "5" },
      { line: 12, logMessage: "hit {x}" },
      { line: 20 },
    ]);
  });

  it("parses setBreakpoints responses aligned to the sorted request order", () => {
    const requested = sortedBreakpoints([{ line: 9 }, { line: 3 }]);
    const bindings = parseSetBreakpointsResponse(requested, {
      breakpoints: [
        { id: 1, verified: true, line: 4 },
        { id: 2, verified: false },
      ],
    });
    expect(bindings).toEqual([
      { id: 1, verified: true, line: 4 },
      { id: 2, verified: false, line: 9 },
    ]);
    // Missing/short response arrays leave breakpoints unverified on their line.
    expect(parseSetBreakpointsResponse(requested, null)).toEqual([
      { id: null, verified: false, line: 3 },
      { id: null, verified: false, line: 9 },
    ]);
  });

  it("adopts adapter-adjusted breakpoint lines and drops collapsed duplicates", () => {
    const requested = sortedBreakpoints([{ line: 3, condition: "x" }, { line: 5 }]);
    // The adapter moved line 3 → 5 (line 3 was not executable): both collapse to 5.
    const moved = reconcileBreakpointLines(requested, [
      { id: 1, verified: true, line: 5 },
      { id: 2, verified: true, line: 5 },
    ]);
    expect(moved).toEqual([{ line: 5, condition: "x" }]);
    // Unverified bindings do not move the breakpoint.
    const kept = reconcileBreakpointLines(requested, [
      { id: 1, verified: false, line: 7 },
      { id: 2, verified: true, line: 5 },
    ]);
    expect(kept).toEqual([{ line: 3, condition: "x" }, { line: 5 }]);
  });

  it("parses breakpoint events (verification changes as classes load)", () => {
    expect(parseBreakpointEvent({
      body: { reason: "changed", breakpoint: { id: 7, verified: true, line: 12 } },
    })).toEqual({ reason: "changed", id: 7, verified: true, line: 12 });
    expect(parseBreakpointEvent({ body: {} })).toBeNull();
    expect(parseBreakpointEvent(null)).toBeNull();
  });

  it("selects only exception filters the adapter advertises", () => {
    const caps = {
      exceptionBreakpointFilters: [
        { filter: "caught", label: "Caught Exceptions" },
        { filter: "uncaught", label: "Uncaught Exceptions" },
      ],
    };
    expect(selectExceptionFilters(caps, ["uncaught", "unknown"])).toEqual(["uncaught"]);
    expect(selectExceptionFilters({}, ["uncaught"])).toEqual([]);
  });

  it("parses threads and stack frames tolerantly", () => {
    expect(parseThreads({ threads: [{ id: 1, name: "main" }, { name: "x" }] }))
      .toEqual([{ id: 1, name: "main" }]);
    const frames = parseStackFrames({
      stackFrames: [
        { id: 3, name: "App.main", source: { path: "/repo/App.java" }, line: 9, column: 2 },
        { id: 4, name: "native", line: 0 },
      ],
    });
    expect(frames).toHaveLength(2);
    expect(frames[0].path).toBe("/repo/App.java");
    expect(frames[1].path).toBeNull();
  });

  it("parses exceptionInfo and evaluate responses", () => {
    expect(parseExceptionInfo({
      exceptionId: "java.lang.NullPointerException",
      description: "boom",
      details: { stackTrace: "at App.main(App.java:9)" },
    })).toEqual({
      exceptionId: "java.lang.NullPointerException",
      description: "boom",
      details: "at App.main(App.java:9)",
    });
    expect(parseExceptionInfo({})).toBeNull();

    expect(parseEvaluate({ result: "42", variablesReference: 5, type: "int" }))
      .toEqual({ value: "42", variablesReference: 5, type: "int" });
    expect(parseEvaluate(null)).toEqual({ value: "", variablesReference: 0, type: null });
  });

  it("derives the current highlight location from the selected frame, else the top frame", () => {
    const frames = [
      { id: 1, name: "native", path: null, line: 0, column: 0 },
      { id: 2, name: "App.main", path: "/repo/App.java", line: 9, column: 1 },
      { id: 3, name: "App.run", path: "/repo/Run.java", line: 30, column: 1 },
    ];
    expect(currentLocation(frames)).toEqual({ path: "/repo/App.java", line: 9 });
    expect(currentLocation(frames, 3)).toEqual({ path: "/repo/Run.java", line: 30 });
    // A pathless selected frame falls back to the top frame with a path.
    expect(currentLocation(frames, 1)).toEqual({ path: "/repo/App.java", line: 9 });
    expect(currentLocation([])).toBeNull();
  });

  it("reduces stopped / continued / terminated / output events", () => {
    let state = initialDebugState("s1");
    state = reduceDebugEvent(state, "stopped", { body: { threadId: 7, reason: "breakpoint" } });
    expect(state.status).toBe("stopped");
    expect(state.stoppedThreadId).toBe(7);
    expect(state.selectedThreadId).toBe(7);
    expect(state.stoppedReason).toBe("breakpoint");

    state = reduceDebugEvent(state, "output", { body: { output: "hello\n", category: "stderr" } });
    expect(state.output).toEqual([{ category: "stderr", text: "hello\n" }]);

    state = reduceDebugEvent(state, "continued", { body: {} });
    expect(state.status).toBe("running");
    expect(state.stoppedThreadId).toBeNull();
    expect(state.frames).toEqual([]);

    state = reduceDebugEvent(state, "terminated", {});
    expect(state.status).toBe("terminated");
  });

  it("marks resumed state: clears stack, selection, and exception details", () => {
    const stopped = {
      ...initialDebugState("s1"),
      status: "stopped" as const,
      stoppedThreadId: 1,
      stoppedReason: "breakpoint",
      frames: [{ id: 9, name: "f", path: "/a.java", line: 1, column: 1 }],
      selectedThreadId: 1,
      selectedFrameId: 9,
      exceptionInfo: { exceptionId: "E", description: "", details: null },
    };
    const resumed = markResumed(stopped);
    expect(resumed.status).toBe("running");
    expect(resumed.frames).toEqual([]);
    expect(resumed.selectedFrameId).toBeNull();
    expect(resumed.exceptionInfo).toBeNull();
  });

  it("logs the process exit code on the exited event (IDEA-style)", () => {
    const state = reduceDebugEvent(initialDebugState("s1"), "exited", { body: { exitCode: 3 } });
    expect(state.status).toBe("terminated");
    expect(state.output.at(-1)?.text).toContain("exit code 3");
  });

  it("appends client console lines and skips telemetry output", () => {
    let state = initialDebugState("s1");
    state = appendConsoleLine(state, "repl", "> 1 + 1\n");
    expect(state.output).toEqual([{ category: "repl", text: "> 1 + 1\n" }]);
    expect(appendConsoleLine(state, "repl", "")).toBe(state);
    expect(reduceDebugEvent(state, "output", { body: { output: "x", category: "telemetry" } })).toBe(state);
  });

  it("ignores unknown events and empty output", () => {
    const state = initialDebugState("s1");
    expect(reduceDebugEvent(state, "module", {})).toBe(state);
    expect(reduceDebugEvent(state, "output", { body: { output: "" } })).toBe(state);
  });
});
