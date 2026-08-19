import { describe, expect, it } from "vitest";
import {
  appendConsoleLine,
  breakpointModesFor,
  breakpointVerificationMap,
  buildDisassembleArgs,
  buildDataBreakpointInfoArgs,
  buildReadMemoryArgs,
  buildSetBreakpointsArgs,
  buildSetDataBreakpointsArgs,
  buildSetExceptionBreakpointsArgs,
  buildSetFunctionBreakpointsArgs,
  buildSetInstructionBreakpointsArgs,
  buildWriteMemoryArgs,
  currentLocation,
  dataBreakpointKey,
  dataBreakpointVerificationMap,
  decodeMemoryData,
  defaultDataBreakpointAccessType,
  exceptionBreakpointRuleLabel,
  exceptionBreakpointRuleVerificationMap,
  exceptionBreakpointVerificationMap,
  encodeMemoryData,
  functionBreakpointVerificationMap,
  instructionBreakpointKey,
  instructionBreakpointVerificationMap,
  hoverExpressionAt,
  initialDebugState,
  inlineValueLabel,
  markResumed,
  mergeExceptionBreakpointDefaults,
  parseBreakpointEvent,
  parseBreakpointModes,
  parseDataBreakpointInfo,
  parseDisassembleResponse,
  parseEvaluate,
  parseExceptionBreakpointFilters,
  parseExceptionInfo,
  parseSetBreakpointsResponse,
  parseSetDataBreakpointsResponse,
  parseSetExceptionBreakpointsResponse,
  parseSetFunctionBreakpointsResponse,
  parseSetInstructionBreakpointsResponse,
  parseReadMemoryResponse,
  parseWriteMemoryResponse,
  parseStackFrames,
  parseThreads,
  planBreakpointSync,
  planDataBreakpointSync,
  planExceptionBreakpointSync,
  planFunctionBreakpointSync,
  planInstructionBreakpointSync,
  reconcileBreakpointLines,
  resolveBreakpointMode,
  reduceDebugEvent,
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
    expect(stepCommandFor("stepBack")).toBe("stepBack");
    expect(stepCommandFor("reverseContinue")).toBe("reverseContinue");
  });

  it("builds and parses bounded memory and disassembly requests", () => {
    expect(buildReadMemoryArgs({ memoryReference: " 0x1000 ", offset: -4, count: 16 })).toEqual({
      memoryReference: "0x1000",
      offset: -4,
      count: 16,
    });
    expect(parseReadMemoryResponse({
      address: "0x1000",
      unreadableBytes: 2,
      data: "AAE=",
    })).toEqual({ address: "0x1000", unreadableBytes: 2, data: "AAE=" });
    expect(buildWriteMemoryArgs({
      memoryReference: "0x1000",
      offset: 2,
      data: "AQI=",
      allowPartial: false,
    })).toEqual({ memoryReference: "0x1000", offset: 2, data: "AQI=", allowPartial: false });
    expect(parseWriteMemoryResponse({ bytesWritten: 2 })).toEqual({ bytesWritten: 2 });
    expect(buildDisassembleArgs({
      memoryReference: "entry",
      offset: 4,
      instructionOffset: -1,
      instructionCount: 2,
      resolveSymbols: true,
    })).toEqual({
      memoryReference: "entry",
      offset: 4,
      instructionOffset: -1,
      instructionCount: 2,
      resolveSymbols: true,
    });
    expect(parseDisassembleResponse({
      instructions: [{
        address: "0x1000",
        instructionBytes: "55",
        instruction: "push rbp",
        symbol: "main",
        location: { path: "/repo/App.java", name: "App.java", sourceReference: null },
        line: 9,
        column: 2,
      }, { address: "0x1001", instruction: "ret" }],
    })).toEqual([
      {
        address: "0x1000",
        instructionBytes: "55",
        instruction: "push rbp",
        symbol: "main",
        location: { path: "/repo/App.java", name: "App.java", sourceReference: null },
        line: 9,
        column: 2,
        endLine: null,
        endColumn: null,
      },
      {
        address: "0x1001",
        instructionBytes: null,
        instruction: "ret",
        symbol: null,
        location: null,
        line: null,
        column: null,
        endLine: null,
        endColumn: null,
      },
    ]);
  });

  it("converts memory bytes between hexadecimal and DAP base64", () => {
    const encoded = encodeMemoryData("0x01 02 ff");
    expect(encoded).toBe("AQL/");
    expect(decodeMemoryData(encoded ?? "")).toBe("01 02 ff");
    expect(encodeMemoryData("01 2")).toBeNull();
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

  it("builds setBreakpoints args combining condition, hitCondition and logMessage on single breakpoint (D11.2)", () => {
    const args = buildSetBreakpointsArgs("/repo/src/App.java", planBreakpointSync([
      { line: 42, condition: "x > 10", hitCondition: "3", logMessage: "x is {x}" },
    ]));
    expect(args.breakpoints).toEqual([
      { line: 42, condition: "x > 10", hitCondition: "3", logMessage: "x is {x}" },
    ]);
  });

  it("parses breakpoint modes by applicability and uses the first applicable mode as default", () => {
    const modes = parseBreakpointModes({
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["source", "data"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["source"] },
        { mode: "software", label: "duplicate", appliesTo: ["exception"] },
        { mode: "invalid", label: "No applicability", appliesTo: [] },
        { mode: "", label: "empty", appliesTo: ["source"] },
      ],
    });
    expect(modes).toEqual([
      {
        mode: "software",
        label: "Software",
        description: undefined,
        appliesTo: ["source", "data", "exception"],
      },
      {
        mode: "hardware",
        label: "Hardware",
        description: undefined,
        appliesTo: ["source"],
      },
    ]);
    expect(breakpointModesFor(modes, "source").map((mode) => mode.mode)).toEqual([
      "software",
      "hardware",
    ]);
    expect(resolveBreakpointMode(undefined, modes, "source")).toBe("software");
    expect(resolveBreakpointMode("hardware", modes, "source")).toBe("hardware");
    // A stale mode from another adapter is rejected in favor of the default.
    expect(resolveBreakpointMode("hardware", modes, "data")).toBe("software");
  });

  it("adds a source mode only when it is advertised for that adapter", () => {
    const plan = planBreakpointSync([{
      line: 8,
      adapterModes: { java: "hardware", node: "not-advertised" },
    }]);
    const modes = parseBreakpointModes({
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["source"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["source"] },
      ],
    });
    expect(buildSetBreakpointsArgs("/repo/App.java", plan, {
      adapterId: "java",
      breakpointModes: modes,
    }).breakpoints).toEqual([{ line: 8, mode: "hardware" }]);
    expect(buildSetBreakpointsArgs("/repo/App.java", plan, {
      adapterId: "node",
      breakpointModes: modes,
    }).breakpoints).toEqual([{ line: 8, mode: "software" }]);
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

  it("plans and builds standard function breakpoints with conditions", () => {
    const stored = [
      { name: "Service.run", condition: " ready " },
      { name: "Controller.handle", hitCondition: " 3 " },
      { name: "Worker.skip", enabled: false },
    ];
    const plan = planFunctionBreakpointSync(stored);
    expect(plan.sorted.map((breakpoint) => breakpoint.name)).toEqual([
      "Controller.handle",
      "Service.run",
      "Worker.skip",
    ]);
    expect(buildSetFunctionBreakpointsArgs(plan)).toEqual({
      breakpoints: [
        { name: "Controller.handle", hitCondition: "3" },
        { name: "Service.run", condition: "ready" },
      ],
    });
    expect(planFunctionBreakpointSync(stored, { muted: true }).sent).toEqual([]);
  });

  it("parses function-breakpoint verification by request order", () => {
    const plan = planFunctionBreakpointSync([
      { name: "Service.run" },
      { name: "Controller.handle" },
    ]);
    const bindings = parseSetFunctionBreakpointsResponse(plan, {
      breakpoints: [
        { id: 7, verified: true },
        { id: 8, verified: false, reason: "failed", message: "method not found" },
      ],
    });
    expect(bindings).toEqual([
      {
        id: 7,
        verified: true,
        name: "Controller.handle",
        message: null,
        reason: null,
      },
      {
        id: 8,
        verified: false,
        name: "Service.run",
        message: "method not found",
        reason: "failed",
      },
    ]);
    expect(functionBreakpointVerificationMap(plan, bindings)).toEqual({
      "Controller.handle": { status: "verified", message: null },
      "Service.run": { status: "failed", message: "method not found" },
    });
  });

  it("plans adapter-scoped instruction breakpoints with signed offsets and modes", () => {
    const stored = [
      {
        adapterId: "java",
        instructionReference: "0x1000",
        offset: -4,
        condition: " ready ",
        mode: "hardware",
      },
      {
        adapterId: "java",
        instructionReference: "0x1000",
        offset: 8,
        hitCondition: " 2 ",
        enabled: false,
      },
      { adapterId: "node", instructionReference: "main:entry" },
    ];
    const plan = planInstructionBreakpointSync(stored, { adapterId: "java" });
    expect(plan.applicable).toHaveLength(2);
    expect(plan.sent).toHaveLength(1);
    const modes = parseBreakpointModes({
      breakpointModes: [{ mode: "hardware", label: "Hardware", appliesTo: ["instruction"] }],
    });
    expect(buildSetInstructionBreakpointsArgs(plan, modes)).toEqual({
      breakpoints: [{
        instructionReference: "0x1000",
        offset: -4,
        condition: "ready",
        mode: "hardware",
      }],
    });
    expect(buildSetInstructionBreakpointsArgs(
      planInstructionBreakpointSync(stored, { adapterId: "node" }),
      modes,
    )).toEqual({ breakpoints: [{ instructionReference: "main:entry", mode: "hardware" }] });
    expect(planInstructionBreakpointSync(stored, { adapterId: "java", muted: true }).sent).toEqual([]);
  });

  it("maps instruction breakpoint bindings and rejects stale mode metadata", () => {
    const plan = planInstructionBreakpointSync([{
      adapterId: "java",
      instructionReference: "0x1000",
      offset: 2,
      mode: "not-advertised",
    }], { adapterId: "java" });
    const modes = parseBreakpointModes({
      breakpointModes: [{ mode: "software", label: "Software", appliesTo: ["instruction"] }],
    });
    expect(buildSetInstructionBreakpointsArgs(plan, modes)).toEqual({
      breakpoints: [{ instructionReference: "0x1000", offset: 2, mode: "software" }],
    });
    const bindings = parseSetInstructionBreakpointsResponse(plan, {
      breakpoints: [{ id: 91, verified: false, reason: "failed", message: "not executable" }],
    });
    expect(bindings).toEqual([{
      id: 91,
      verified: false,
      key: instructionBreakpointKey(plan.sent[0]),
      message: "not executable",
      reason: "failed",
    }]);
    expect(instructionBreakpointVerificationMap(plan, bindings)).toEqual({
      [instructionBreakpointKey(plan.sent[0])]: { status: "failed", message: "not executable" },
    });
  });

  it("discovers and scopes standard DAP data breakpoints", () => {
    expect(buildDataBreakpointInfoArgs({ name: "count", variablesReference: 17, frameId: 3, mode: "hardware" })).toEqual({
      name: "count",
      variablesReference: 17,
      mode: "hardware",
    });
    expect(buildDataBreakpointInfoArgs({ name: "service.count", frameId: 3 })).toEqual({
      name: "service.count",
      frameId: 3,
    });
    const info = parseDataBreakpointInfo({
      dataId: "field:Service.count",
      description: "Service.count",
      accessTypes: ["read", "write", "write", "invalid"],
      canPersist: true,
    });
    expect(info).toEqual({
      dataId: "field:Service.count",
      description: "Service.count",
      accessTypes: ["read", "write"],
      canPersist: true,
    });
    expect(defaultDataBreakpointAccessType(info.accessTypes)).toBe("write");
    expect(parseDataBreakpointInfo({ dataId: null, description: "not watchable" }).dataId).toBeNull();
  });

  it("builds capability-gated address and byte-range discovery arguments", () => {
    expect(buildDataBreakpointInfoArgs({
      name: "0x7fff0000",
      frameId: 3,
      bytes: 16,
      asAddress: true,
      mode: "hardware",
    })).toEqual({
      name: "0x7fff0000",
      asAddress: true,
      bytes: 16,
      mode: "hardware",
    });
    expect(buildDataBreakpointInfoArgs({
      name: "buffer",
      variablesReference: 17,
      frameId: 3,
      bytes: 8,
    })).toEqual({
      name: "buffer",
      variablesReference: 17,
      bytes: 8,
    });
    expect(buildDataBreakpointInfoArgs({ name: "buffer", bytes: 0 })).toEqual({ name: "buffer" });
  });

  it("builds replacing data-breakpoint requests and maps verification", () => {
    const stored = [
      {
        dataId: "field:count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["read", "write"] as const,
        accessType: "write" as const,
        condition: " ready ",
        canPersist: true,
      },
      {
        dataId: "address:temp",
        description: "temporary",
        adapterId: "java",
        accessTypes: ["write"] as const,
        hitCondition: " 2 ",
        canPersist: false,
        sessionId: "session-1",
      },
      {
        dataId: "field:other",
        description: "Other.value",
        adapterId: "node",
        accessTypes: [] as const,
        canPersist: true,
      },
    ];
    const plan = planDataBreakpointSync(stored.map((entry) => ({
      ...entry,
      accessTypes: [...entry.accessTypes],
    })), {
      adapterId: "java",
      sessionId: "session-1",
    });
    expect(plan.applicable).toHaveLength(2);
    expect(buildSetDataBreakpointsArgs(plan)).toEqual({
      breakpoints: [
        { dataId: "field:count", accessType: "write", condition: "ready" },
        { dataId: "address:temp", hitCondition: "2" },
      ],
    });
    const bindings = parseSetDataBreakpointsResponse(plan, {
      breakpoints: [
        { id: 71, verified: true },
        { id: 72, verified: false, reason: "failed", message: "address expired" },
      ],
    });
    expect(bindings.map((binding) => binding.key)).toEqual(plan.sent.map(dataBreakpointKey));
    expect(dataBreakpointVerificationMap(plan, bindings)).toEqual({
      [dataBreakpointKey(plan.sent[0])]: { status: "verified", message: null },
      [dataBreakpointKey(plan.sent[1])]: { status: "failed", message: "address expired" },
    });
    expect(planDataBreakpointSync(plan.sorted, {
      adapterId: "java",
      sessionId: "session-1",
      muted: true,
    }).sent).toEqual([]);
  });

  it("places an advertised exception mode in filterOptions without inventing a condition", () => {
    const filters = parseExceptionBreakpointFilters({
      exceptionBreakpointFilters: [{ filter: "all", label: "All", default: true }],
    });
    const modes = parseBreakpointModes({
      breakpointModes: [{ mode: "hardware", label: "Hardware", appliesTo: ["exception"] }],
    });
    const plan = planExceptionBreakpointSync([
      { adapterId: "java", filterId: "all", enabled: true, mode: "hardware" },
    ], [], filters, {
      adapterId: "java",
      supportsFilterOptions: true,
      breakpointModes: modes,
    });
    expect(buildSetExceptionBreakpointsArgs(plan)).toEqual({
      filters: [],
      filterOptions: [{ filterId: "all", mode: "hardware" }],
    });
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
      { id: 1, verified: true, line: 4, message: null, reason: null },
      { id: 2, verified: false, line: 9, message: null, reason: null },
    ]);
    // Missing/short response arrays leave breakpoints unverified on their line.
    expect(parseSetBreakpointsResponse(plan, null)).toEqual([
      { id: null, verified: false, line: 3, message: null, reason: null },
      { id: null, verified: false, line: 9, message: null, reason: null },
    ]);
  });

  it("captures the adapter's message + reason for an unverified breakpoint", () => {
    const plan = planBreakpointSync([{ line: 7 }]);
    const [binding] = parseSetBreakpointsResponse(plan, {
      breakpoints: [{ id: 3, verified: false, line: 7, message: "No code at line 7", reason: "failed" }],
    });
    expect(binding).toEqual({
      id: 3,
      verified: false,
      line: 7,
      message: "No code at line 7",
      reason: "failed",
    });
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
      { id: 2, verified: false, line: 9, reason: "failed", message: "no code" },
    ]);
    // Keyed by the line the adapter bound; the disabled breakpoint has no entry.
    // Verified → verified; unverified+failed → failed (carries the reason).
    expect(map).toEqual({
      4: { status: "verified", message: null },
      9: { status: "failed", message: "no code" },
    });
  });

  it("parses breakpoint events (verification changes as classes load)", () => {
    expect(parseBreakpointEvent({
      body: { reason: "changed", breakpoint: { id: 7, verified: true, line: 12 } },
    })).toEqual({ reason: "changed", id: 7, verified: true, line: 12, message: null, bindReason: null });
    // An unverified re-bind carries the adapter's reason + message for the UI.
    expect(parseBreakpointEvent({
      body: {
        reason: "changed",
        breakpoint: { id: 8, verified: false, line: 20, reason: "failed", message: "class not loaded" },
      },
    })).toEqual({
      reason: "changed",
      id: 8,
      verified: false,
      line: 20,
      message: "class not loaded",
      bindReason: "failed",
    });
    expect(parseBreakpointEvent({ body: {} })).toBeNull();
    expect(parseBreakpointEvent(null)).toBeNull();
  });

  it("parses exception filters and seeds adapter defaults without overriding choices", () => {
    const caps = {
      exceptionBreakpointFilters: [
        {
          filter: "caught",
          label: "Caught Exceptions",
          description: "Pause on handled exceptions",
          default: true,
          supportsCondition: true,
          conditionDescription: "Exception class or expression",
        },
        { filter: "uncaught", label: "Uncaught Exceptions" },
        { filter: "caught", label: "duplicate" },
        { label: "invalid" },
      ],
    };
    const filters = parseExceptionBreakpointFilters(caps);
    expect(filters).toEqual([
      {
        filter: "caught",
        label: "Caught Exceptions",
        description: "Pause on handled exceptions",
        default: true,
        supportsCondition: true,
        conditionDescription: "Exception class or expression",
      },
      {
        filter: "uncaught",
        label: "Uncaught Exceptions",
        description: undefined,
        default: false,
        supportsCondition: false,
        conditionDescription: undefined,
      },
    ]);
    const seeded = mergeExceptionBreakpointDefaults([
      { adapterId: "java", filterId: "caught", enabled: false },
      { adapterId: "node", filterId: "all", enabled: true },
    ], "java", filters);
    expect(seeded).toEqual([
      { adapterId: "java", filterId: "caught", enabled: false },
      { adapterId: "node", filterId: "all", enabled: true },
      { adapterId: "java", filterId: "uncaught", enabled: false },
    ]);
    expect(mergeExceptionBreakpointDefaults(seeded, "java", filters)).toBe(seeded);
    expect(parseExceptionBreakpointFilters({})).toEqual([]);
  });

  it("builds conditional exception filters with a legacy fallback and positional bindings", () => {
    const filters = parseExceptionBreakpointFilters({
      exceptionBreakpointFilters: [
        { filter: "caught", label: "Caught", supportsCondition: true },
        { filter: "uncaught", label: "Uncaught" },
      ],
    });
    const settings = [
      { adapterId: "java", filterId: "caught", enabled: true, condition: " IOException " },
      { adapterId: "java", filterId: "uncaught", enabled: true },
      { adapterId: "node", filterId: "caught", enabled: true },
    ];
    const rules = [
      {
        id: "java-io",
        adapterId: "java",
        path: [
          { names: ["Java Exceptions"] },
          { names: ["java.io.IOException", "java.sql.SQLException"] },
          { names: ["sun.*"], negate: true },
        ],
        breakMode: "unhandled" as const,
        enabled: true,
      },
      {
        id: "node-error",
        adapterId: "node",
        path: [{ names: ["Error"] }],
        breakMode: "always" as const,
        enabled: true,
      },
    ];
    const plan = planExceptionBreakpointSync(settings, rules, filters, {
      adapterId: "java",
      supportsFilterOptions: true,
      supportsExceptionOptions: true,
    });
    expect(buildSetExceptionBreakpointsArgs(plan)).toEqual({
      filters: ["uncaught"],
      filterOptions: [{ filterId: "caught", condition: "IOException" }],
      exceptionOptions: [{
        path: [
          { names: ["Java Exceptions"] },
          { names: ["java.io.IOException", "java.sql.SQLException"] },
          { names: ["sun.*"], negate: true },
        ],
        breakMode: "unhandled",
      }],
    });
    expect(plan.sent.map((target) => (
      target.kind === "filter" ? target.breakpoint.filterId : target.rule.id
    ))).toEqual(["uncaught", "caught", "java-io"]);
    expect(exceptionBreakpointRuleLabel(rules[0])).toBe(
      "Java Exceptions / java.io.IOException | java.sql.SQLException / not (sun.*)",
    );
    expect(exceptionBreakpointRuleLabel({ path: [] })).toBe("All exceptions");

    const bindings = parseSetExceptionBreakpointsResponse(plan, {
      breakpoints: [
        { id: 7, verified: true },
        { id: 8, verified: false, reason: "failed", message: "Invalid condition" },
        { id: 9, verified: false, reason: "pending", message: "Class not loaded" },
      ],
    });
    expect(bindings.map((binding) => (
      binding.kind === "filter" ? binding.filterId : binding.ruleId
    ))).toEqual(["uncaught", "caught", "java-io"]);
    expect(exceptionBreakpointVerificationMap(plan, bindings)).toEqual({
      uncaught: { status: "verified", message: null },
      caught: { status: "failed", message: "Invalid condition" },
    });
    expect(exceptionBreakpointRuleVerificationMap(plan, bindings)).toEqual({
      "java-io": { status: "pending", message: "Class not loaded" },
    });

    const legacy = planExceptionBreakpointSync(settings, rules, filters, {
      adapterId: "java",
      supportsFilterOptions: false,
      supportsExceptionOptions: false,
    });
    expect(buildSetExceptionBreakpointsArgs(legacy)).toEqual({ filters: ["caught", "uncaught"] });
    expect(legacy.applicableRules).toEqual([rules[0]]);
    const muted = planExceptionBreakpointSync(settings, rules, filters, {
      adapterId: "java",
      muted: true,
      supportsFilterOptions: true,
      supportsExceptionOptions: true,
    });
    expect(buildSetExceptionBreakpointsArgs(muted)).toEqual({ filters: [] });
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

  it.each(["terminated", "exited"] as const)(
    "clears the whole inspectable stack on %s and keeps the console",
    (event) => {
      const stopped = {
        ...initialDebugState("s1"),
        status: "stopped" as const,
        stoppedThreadId: 1,
        stoppedReason: "breakpoint",
        threads: [{ id: 1, name: "main" }, { id: 2, name: "worker" }],
        frames: [{ id: 9, name: "f", path: "/a.java", line: 1, column: 1, sourceReference: 0, sourceName: null }],
        selectedThreadId: 1,
        selectedFrameId: 9,
        exceptionInfo: { exceptionId: "E", description: "", details: null },
        output: [{ category: "stdout", text: "hello\n" }],
      };

      const ended = reduceDebugEvent(stopped, event, { body: {} });
      expect(ended.status).toBe("terminated");
      expect(ended.threads).toEqual([]);
      expect(ended.frames).toEqual([]);
      expect(ended.stoppedThreadId).toBeNull();
      expect(ended.stoppedReason).toBeNull();
      expect(ended.selectedThreadId).toBeNull();
      expect(ended.selectedFrameId).toBeNull();
      expect(ended.exceptionInfo).toBeNull();
      // Console history is the one thing Stop keeps (IDEA does the same).
      expect(ended.output).toEqual([{ category: "stdout", text: "hello\n" }]);
    },
  );

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

  it("enforces 10,000 lines limit in appendConsoleLine (D7.4)", () => {
    let state = initialDebugState("s1");
    for (let i = 0; i < 10050; i++) {
      state = appendConsoleLine(state, "stdout", `line ${i}\n`, i);
    }
    expect(state.output).toHaveLength(10000);
    expect(state.output[0]?.text).toBe("line 50\n");
    expect(state.output[9999]?.text).toBe("line 10049\n");
  });

  it("enforces 2 MiB memory budget eviction in appendConsoleLine (D7.4)", () => {
    let state = initialDebugState("s1");
    // Append 3 lines each of 1 MiB (1,000,000 chars)
    const bigLine1 = "a".repeat(1000000);
    const bigLine2 = "b".repeat(1000000);
    const bigLine3 = "c".repeat(1000000);

    state = appendConsoleLine(state, "stdout", bigLine1, 1);
    state = appendConsoleLine(state, "stdout", bigLine2, 2);
    // At this point total is 2 MiB -> holds both lines
    expect(state.output).toHaveLength(2);

    state = appendConsoleLine(state, "stdout", bigLine3, 3);
    // Adding 3rd line exceeds 2 MiB -> line 1 must be evicted
    expect(state.output).toHaveLength(2);
    expect(state.output[0]?.text).toBe(bigLine2);
    expect(state.output[1]?.text).toBe(bigLine3);
  });
});
