import { describe, expect, it } from "vitest";
import {
  buildSetBreakpointsArgs,
  currentLocation,
  initialDebugState,
  parseStackFrames,
  parseThreads,
  reduceDebugEvent,
  selectExceptionFilters,
  stepCommandFor,
} from "./dapDebugModel";

describe("dapDebugModel", () => {
  it("maps step actions to DAP commands", () => {
    expect(stepCommandFor("continue")).toBe("continue");
    expect(stepCommandFor("stepOver")).toBe("next");
    expect(stepCommandFor("stepIn")).toBe("stepIn");
    expect(stepCommandFor("stepOut")).toBe("stepOut");
    expect(stepCommandFor("pause")).toBe("pause");
  });

  it("builds setBreakpoints args sorted, with condition + logMessage (D5)", () => {
    const args = buildSetBreakpointsArgs("/repo/src/App.java", [
      { line: 20 },
      { line: 5, condition: " x > 1 " },
      { line: 12, logMessage: "hit {x}" },
    ]);
    expect(args.source).toEqual({ path: "/repo/src/App.java", name: "App.java" });
    expect(args.breakpoints).toEqual([
      { line: 5, condition: "x > 1" },
      { line: 12, logMessage: "hit {x}" },
      { line: 20 },
    ]);
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

  it("derives the current highlight location from the top frame with a path", () => {
    expect(currentLocation([
      { id: 1, name: "native", path: null, line: 0, column: 0 },
      { id: 2, name: "App.main", path: "/repo/App.java", line: 9, column: 1 },
    ])).toEqual({ path: "/repo/App.java", line: 9 });
    expect(currentLocation([])).toBeNull();
  });

  it("reduces stopped / continued / terminated / output events", () => {
    let state = initialDebugState("s1");
    state = reduceDebugEvent(state, "stopped", { body: { threadId: 7, reason: "breakpoint" } });
    expect(state.status).toBe("stopped");
    expect(state.stoppedThreadId).toBe(7);
    expect(state.stoppedReason).toBe("breakpoint");

    state = reduceDebugEvent(state, "output", { body: { output: "hello\n" } });
    expect(state.output).toEqual(["hello\n"]);

    state = reduceDebugEvent(state, "continued", { body: {} });
    expect(state.status).toBe("running");
    expect(state.stoppedThreadId).toBeNull();

    state = reduceDebugEvent(state, "terminated", {});
    expect(state.status).toBe("terminated");
  });

  it("ignores unknown events and empty output", () => {
    const state = initialDebugState("s1");
    expect(reduceDebugEvent(state, "module", {})).toBe(state);
    expect(reduceDebugEvent(state, "output", { body: { output: "" } })).toBe(state);
  });
});
