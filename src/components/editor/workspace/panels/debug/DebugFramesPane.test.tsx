import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugFramesPane } from "./DebugFramesPane";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import { initialDebugState } from "../../dapDebugModel";

function makeSession(overrides: Partial<CodeDebugSession> = {}): CodeDebugSession {
  return {
    state: null,
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
    watchItems: [],
    isStepping: false,
    breakpointsMuted: false,
    setBreakpointsMuted: vi.fn(),
    removeAllBreakpoints: vi.fn(),
    frameVariables: {},
    sessions: [],
    activeSessionId: null,
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
    addDataBreakpoint: vi.fn().mockResolvedValue({ added: true, message: "Watching value" }),
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
    evaluate: vi.fn().mockResolvedValue({ value: "", variablesReference: 0, type: null }),
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

describe("DebugFramesPane", () => {
  afterEach(cleanup);

  it("renders threads and frames tree and allows selection and step actions", async () => {
    const selectThread = vi.fn();
    const selectFrame = vi.fn();
    const onOpenFrame = vi.fn();
    const step = vi.fn().mockResolvedValue(undefined);

    const state = {
      ...initialDebugState("s1"),
      status: "stopped" as const,
      stoppedThreadId: 1,
      threads: [
        { id: 1, name: "main" },
        { id: 2, name: "worker" },
      ],
      frames: [
        { id: 101, name: "Main.main", path: "/src/Main.java", line: 15, column: 1, sourceReference: 0, sourceName: null },
        { id: 102, name: "App.run", path: "/src/App.java", line: 42, column: 1, sourceReference: 0, sourceName: null },
      ],
      selectedThreadId: 1,
      selectedFrameId: 101,
    };

    const debug = makeSession({ state, selectThread, selectFrame, step });

    render(
      <DebugFramesPane
        debug={debug}
        activeRunning={true}
        stopped={true}
        onOpenFrame={onOpenFrame}
      />,
    );

    expect(screen.getByTestId("debug-thread-1")).toBeInTheDocument();
    expect(screen.getByTestId("debug-thread-2")).toBeInTheDocument();
    expect(screen.getByTestId("debug-frame-101")).toBeInTheDocument();
    expect(screen.getByTestId("debug-frame-102")).toBeInTheDocument();

    // Click frame to select and open
    fireEvent.click(screen.getByTestId("debug-frame-101"));
    expect(selectFrame).toHaveBeenCalledWith(101);
    expect(onOpenFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));

    // Click thread 2
    fireEvent.click(screen.getByTestId("debug-thread-2"));
    expect(selectThread).toHaveBeenCalledWith(2);

    // Step controls
    await act(async () => {
      fireEvent.click(screen.getByTestId("debug-step-over"));
    });
    expect(step).toHaveBeenCalledWith("stepOver");

    await act(async () => {
      fireEvent.click(screen.getByTestId("debug-step-in"));
    });
    expect(step).toHaveBeenCalledWith("stepIn");

    await act(async () => {
      fireEvent.click(screen.getByTestId("debug-step-out"));
    });
    expect(step).toHaveBeenCalledWith("stepOut");

    // Session controls
    await act(async () => {
      fireEvent.click(screen.getByTestId("debug-continue"));
    });
    expect(step).toHaveBeenCalledWith("continue");
  });
});
