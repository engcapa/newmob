import { describe, expect, it } from "vitest";
import {
  appendConsoleLine,
  breakpointVerificationMap,
  buildSetBreakpointsArgs,
  currentLocation,
  hoverExpressionAt,
  initialDebugState,
  inlineValueLabel,
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
  type DebugStackFrame,
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
    const args = buildSetBreakpointsArgs("/repo/src/App.java", planBreakpointSync([
      { line: 20 },
      { line: 5, condition: " x > 1 " },
      { line: 12, logMessage: "hit {x}" },
      { line: 8, hitCondition: " 5 " },
    ]));
    expect(args.source).toEqual({ path: "/repo/src/App.java", name: "App.java" });
    expect(args.breakpoints).toEqual([
      { line: 5, condition: "x > 1" },
      { line: 8, hitCondition: "5" },
      { line: 12, logMessage: "hit {x}" },
      { line: 20 },
    ]);
  });

  it("omits disabled and muted breakpoints from the request but keeps them stored", () => {
    const stored = [{ line: 5 }, { line: 9, enabled: false }, { line: 12 }];
    const plan = planBreakpointSync(stored);
    expect(plan.sent.map((bp) => bp.line)).toEqual([5, 12]);
    // `indexes` maps each sent entry back to its slot in the stored, sorted list.
    expect(plan.indexes).toEqual([0, 2]);
    expect(plan.sorted.map((bp) => bp.line)).toEqual([5, 9, 12]);
    // Muting suppresses every breakpoint without forgetting any of them.
    const muted = planBreakpointSync(stored, { muted: true });
    expect(muted.sent).toEqual([]);
    expect(muted.sorted).toHaveLength(3);
  });

  it("inserts a run-to-cursor breakpoint in line order without storing it", () => {
    const plan = planBreakpointSync([{ line: 3 }, { line: 20 }], { extraLine: 11 });
    expect(plan.sent.map((bp) => bp.line)).toEqual([3, 11, 20]);
    expect(plan.indexes).toEqual([0, -1, 1]);
    expect(plan.sorted.map((bp) => bp.line)).toEqual([3, 20]);
    // A transient line that already has a breakpoint is not duplicated.
    expect(planBreakpointSync([{ line: 3 }], { extraLine: 3 }).sent).toHaveLength(1);
    // Muted + run-to-cursor: only the transient one is armed.
    const muted = planBreakpointSync([{ line: 3 }], { muted: true, extraLine: 8 });
    expect(muted.sent.map((bp) => bp.line)).toEqual([8]);
  });

  it("parses setBreakpoints responses aligned to the sorted request order", () => {
    const plan = planBreakpointSync([{ line: 9 }, { line: 3 }]);
    const bindings = parseSetBreakpointsResponse(plan, {
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
    expect(parseSetBreakpointsResponse(plan, null)).toEqual([
      { id: null, verified: false, line: 3 },
      { id: null, verified: false, line: 9 },
    ]);
  });

  it("adopts adapter-adjusted breakpoint lines and drops collapsed duplicates", () => {
    const plan = planBreakpointSync([{ line: 3, condition: "x" }, { line: 5 }]);
    // The adapter moved line 3 → 5 (line 3 was not executable): both collapse to 5.
    const moved = reconcileBreakpointLines(plan, [
      { id: 1, verified: true, line: 5 },
      { id: 2, verified: true, line: 5 },
    ]);
    expect(moved).toEqual([{ line: 5, condition: "x" }]);
    // Unverified bindings do not move the breakpoint.
    const kept = reconcileBreakpointLines(plan, [
      { id: 1, verified: false, line: 7 },
      { id: 2, verified: true, line: 5 },
    ]);
    expect(kept).toEqual([{ line: 3, condition: "x" }, { line: 5 }]);
  });

  it("keeps unsent breakpoints intact when reconciling a partial request", () => {
    // Disabled entries are not in the response; they must survive untouched and
    // must not consume a binding meant for the next enabled breakpoint.
    const plan = planBreakpointSync([{ line: 3 }, { line: 5, enabled: false }, { line: 9 }]);
    const reconciled = reconcileBreakpointLines(plan, [
      { id: 1, verified: true, line: 4 },
      { id: 2, verified: true, line: 10 },
    ]);
    expect(reconciled).toEqual([{ line: 4 }, { line: 5, enabled: false }, { line: 10 }]);
  });

  it("reports verification per bound line for the gutter", () => {
    const plan = planBreakpointSync([{ line: 3 }, { line: 5, enabled: false }, { line: 9 }]);
    const map = breakpointVerificationMap(plan, [
      { id: 1, verified: true, line: 4 },
      { id: 2, verified: false, line: 9 },
    ]);
    // Keyed by the line the adapter bound; the disabled breakpoint has no entry.
    expect(map).toEqual({ 4: true, 9: false });
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
        // A library frame: no readable path, fetched via the `source` request.
        {
          id: 5,
          name: "java.util.ArrayList.get",
          source: { name: "ArrayList.java", sourceReference: 1001 },
          line: 427,
        },
      ],
    });
    expect(frames).toHaveLength(3);
    expect(frames[0].path).toBe("/repo/App.java");
    expect(frames[0].sourceReference).toBe(0);
    expect(frames[1].path).toBeNull();
    expect(frames[2]).toMatchObject({
      path: null,
      sourceReference: 1001,
      sourceName: "ArrayList.java",
      line: 427,
    });
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
    const frames: DebugStackFrame[] = [
      { id: 1, name: "native", path: null, line: 0, column: 0, sourceReference: 0, sourceName: null },
      { id: 2, name: "App.main", path: "/repo/App.java", line: 9, column: 1, sourceReference: 0, sourceName: null },
      { id: 3, name: "App.run", path: "/repo/Run.java", line: 30, column: 1, sourceReference: 0, sourceName: null },
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
      frames: [{ id: 9, name: "f", path: "/a.java", line: 1, column: 1, sourceReference: 0, sourceName: null }],
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

  it("tracks threads as the adapter starts and exits them", () => {
    // `threads` may only be requested while stopped, so the running thread list
    // is maintained from the events.
    let state = initialDebugState("s1");
    state = reduceDebugEvent(state, "thread", { body: { reason: "started", threadId: 4 } });
    state = reduceDebugEvent(state, "thread", { body: { reason: "started", threadId: 7 } });
    expect(state.threads.map((t) => t.id)).toEqual([4, 7]);
    // A repeated start is not a duplicate row.
    expect(reduceDebugEvent(state, "thread", { body: { reason: "started", threadId: 4 } })).toBe(state);
    state = reduceDebugEvent(state, "thread", { body: { reason: "exited", threadId: 4 } });
    expect(state.threads.map((t) => t.id)).toEqual([7]);
    // A malformed thread event changes nothing.
    expect(reduceDebugEvent(state, "thread", { body: {} })).toBe(state);
  });

  it("extracts the hovered expression, including dotted chains and indexes", () => {
    const line = "    total = order.items.get(i) + prices[i];";
    expect(hoverExpressionAt(line, line.indexOf("total") + 2)).toBe("total");
    // A dotted chain resolves to the full receiver path under the caret.
    expect(hoverExpressionAt(line, line.indexOf("items") + 1)).toBe("order.items");
    // An index directly after the identifier belongs to the expression.
    expect(hoverExpressionAt(line, line.indexOf("prices") + 1)).toBe("prices[i]");
    // Whitespace, operators and numeric literals are not expressions.
    expect(hoverExpressionAt(line, 1)).toBeNull();
    expect(hoverExpressionAt("x + 42", 4)).toBeNull();
    expect(hoverExpressionAt("x", -1)).toBeNull();
  });

  it("builds an inline value label from the locals mentioned on a line", () => {
    const variables = { sum: "10", i: "3", other: "9" };
    expect(inlineValueLabel("sum += values[i];", variables)).toBe("sum = 10, i = 3");
    // Field access is not the local of the same name, and comments are ignored.
    expect(inlineValueLabel("node.sum = 1; // i", variables)).toBeNull();
    // Each variable appears once even when mentioned twice.
    expect(inlineValueLabel("i = i + 1;", variables)).toBe("i = 3");
    expect(inlineValueLabel("System.out.println();", variables)).toBeNull();
    expect(inlineValueLabel("sum = 1;", {})).toBeNull();
  });
});
