import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DebugConsolePane } from "./DebugConsolePane";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import { initialDebugState } from "../../dapDebugModel";

function makeConsoleSession(overrides: Partial<CodeDebugSession> = {}): CodeDebugSession {
  return {
    state: initialDebugState("s1"),
    breakpoints: {},
    breakpointRuntime: {},
    functionBreakpoints: [],
    functionBreakpointRuntime: {},
    instructionBreakpoints: [],
    instructionBreakpointRuntime: {},
    dataBreakpoints: [],
    dataBreakpointRuntime: {},
    exceptionBreakpoints: [],
    exceptionBreakpointRuntime: {},
    exceptionBreakpointRules: [],
    exceptionBreakpointRuleRuntime: {},
    capabilities: {},
    availableExceptionFilters: [],
    watchExpressions: [],
    breakpointsMuted: false,
    setBreakpointsMuted: vi.fn(),
    removeAllBreakpoints: vi.fn(),
    frameVariables: {},
    sessions: [],
    activeSessionId: "s1",
    selectSession: vi.fn(),
    startDebug: vi.fn().mockResolvedValue(undefined),
    startDebugGroup: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn(),
    canRestart: false,
    toggleBreakpoint: vi.fn(),
    setBreakpointOptions: vi.fn(),
    setBreakpointMode: vi.fn(),
    removeBreakpoint: vi.fn(),
    addFunctionBreakpoint: vi.fn(),
    setFunctionBreakpointOptions: vi.fn(),
    removeFunctionBreakpoint: vi.fn(),
    addInstructionBreakpoint: vi.fn().mockReturnValue(true),
    setInstructionBreakpointOptions: vi.fn(),
    removeInstructionBreakpoint: vi.fn(),
    addDataBreakpoint: vi.fn().mockResolvedValue({ added: true, message: "Watching" }),
    setDataBreakpointOptions: vi.fn(),
    removeDataBreakpoint: vi.fn(),
    setExceptionBreakpointOptions: vi.fn(),
    addExceptionBreakpointRule: vi.fn().mockReturnValue(null),
    setExceptionBreakpointRuleOptions: vi.fn(),
    removeExceptionBreakpointRule: vi.fn(),
    addWatchExpression: vi.fn(),
    removeWatchExpression: vi.fn(),
    step: vi.fn().mockResolvedValue(undefined),
    runToCursor: vi.fn(),
    selectThread: vi.fn(),
    selectFrame: vi.fn(),
    restartFrame: vi.fn(),
    hotReload: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ value: "42", variablesReference: 0, type: "int" }),
    hoverEvaluate: vi.fn().mockResolvedValue(null),
    readMemory: vi.fn().mockResolvedValue(null),
    writeMemory: vi.fn().mockResolvedValue(null),
    disassemble: vi.fn().mockResolvedValue([]),
    setVariable: vi.fn().mockResolvedValue(null),
    logConsole: vi.fn(),
    clearConsole: vi.fn(),
    consoleGeneration: 0,
    reportStartupFailure: vi.fn(),
    reportStartupProgress: vi.fn(),
    fetchVariables: vi.fn().mockResolvedValue({ variables: [] }),
    fetchScopes: vi.fn().mockResolvedValue({ scopes: [] }),
    fetchSource: vi.fn().mockResolvedValue(null),
    terminate: vi.fn(),
    currentLocation: null,
    ...overrides,
  };
}

describe("DebugConsolePane", () => {
  afterEach(cleanup);

  it("submits console expression and logs REPL command and result", async () => {
    const logConsole = vi.fn();
    const evaluate = vi.fn().mockResolvedValue({ value: "100", variablesReference: 0, type: "int" });
    const debug = makeConsoleSession({ logConsole, evaluate, consoleGeneration: 1 });

    render(<DebugConsolePane debug={debug} visible={true} stopped={true} />);

    const input = screen.getByTestId("debug-console-input");
    fireEvent.change(input, { target: { value: "x + y" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(logConsole).toHaveBeenCalledWith("repl", "> x + y\n");
    expect(evaluate).toHaveBeenCalledWith("x + y", "repl");
    expect(logConsole).toHaveBeenCalledWith("result", "100\n");
  });

  it("discards evaluation result if console was cleared before evaluation completed", async () => {
    const logConsole = vi.fn();
    let resolveEval!: (value: { value: string; variablesReference: number; type: string }) => void;
    const evaluate = vi.fn().mockReturnValue(
      new Promise((res) => {
        resolveEval = res;
      }),
    );
    const debug = makeConsoleSession({ logConsole, evaluate, consoleGeneration: 1 });

    const { rerender } = render(<DebugConsolePane debug={debug} visible={true} stopped={true} />);

    const input = screen.getByTestId("debug-console-input");
    fireEvent.change(input, { target: { value: "slowExpr()" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(logConsole).toHaveBeenCalledWith("repl", "> slowExpr()\n");

    // Console was cleared / generation changed while slowExpr was evaluating
    debug.consoleGeneration = 2;
    rerender(<DebugConsolePane debug={debug} visible={true} stopped={true} />);

    // Now slow evaluation resolves
    await act(async () => {
      resolveEval({ value: "late_result", variablesReference: 0, type: "String" });
    });

    // logConsole should NOT have been called with late result
    expect(logConsole).not.toHaveBeenCalledWith("result", "late_result\n");
  });
});
