import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugPanel } from "./DebugPanel";
import type { CodeDebugSession } from "../useCodeDebugSession";
import { initialDebugState, type DebugSessionState } from "../dapDebugModel";

function makeSession(overrides: Partial<CodeDebugSession> = {}): CodeDebugSession {
  return {
    state: null,
    breakpoints: {},
    breakpointRuntime: {},
    capabilities: {},
    availableExceptionFilters: [],
    enabledExceptionFilters: [],
    watchExpressions: [],
    startDebug: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn(),
    canRestart: false,
    toggleBreakpoint: vi.fn(),
    setBreakpointOptions: vi.fn(),
    setExceptionFilters: vi.fn(),
    addWatchExpression: vi.fn(),
    removeWatchExpression: vi.fn(),
    step: vi.fn(),
    runToCursor: vi.fn(),
    selectThread: vi.fn(),
    selectFrame: vi.fn(),
    restartFrame: vi.fn(),
    hotReload: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ value: "", variablesReference: 0, type: null }),
    setVariable: vi.fn().mockResolvedValue(null),
    logConsole: vi.fn(),
    fetchVariables: vi.fn().mockResolvedValue({ variables: [] }),
    fetchScopes: vi.fn().mockResolvedValue({ scopes: [] }),
    terminate: vi.fn(),
    currentLocation: null,
    ...overrides,
  };
}

function stoppedState(): DebugSessionState {
  return {
    ...initialDebugState("s1"),
    status: "stopped",
    stoppedThreadId: 1,
    stoppedReason: "breakpoint",
    threads: [{ id: 1, name: "main" }, { id: 2, name: "worker" }],
    frames: [{ id: 10, name: "App.main", path: "/repo/App.java", line: 9, column: 1 }],
    selectedThreadId: 1,
    selectedFrameId: 10,
  };
}

describe("DebugPanel", () => {
  afterEach(cleanup);

  it("shows an idle hint and a start button when no session", () => {
    const onStart = vi.fn();
    render(<DebugPanel debug={makeSession()} onStart={onStart} onOpenFrame={vi.fn()} />);
    expect(screen.getByText(/No debug session/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("debug-start"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("renders the call stack and dispatches step controls when stopped", () => {
    const step = vi.fn();
    const selectFrame = vi.fn();
    const onOpenFrame = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), step, selectFrame })}
        onStart={null}
        onOpenFrame={onOpenFrame}
      />,
    );
    // Clicking a frame selects it (variables context) and reveals its source.
    fireEvent.click(screen.getByTestId("debug-frame-10"));
    expect(selectFrame).toHaveBeenCalledWith(10);
    expect(onOpenFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 10, path: "/repo/App.java" }));
    // Step controls dispatch DAP actions.
    fireEvent.click(screen.getByTestId("debug-continue"));
    expect(step).toHaveBeenCalledWith("continue");
    fireEvent.click(screen.getByTestId("debug-step-over"));
    expect(step).toHaveBeenCalledWith("stepOver");
  });

  it("renders debuggee output in the console with categories", () => {
    const state = {
      ...stoppedState(),
      output: [
        { category: "stdout", text: "hello\n" },
        { category: "stderr", text: "boom\n" },
      ],
    };
    render(<DebugPanel debug={makeSession({ state })} onStart={null} onOpenFrame={vi.fn()} />);
    const console = screen.getByTestId("debug-console-output");
    expect(console.textContent).toContain("hello");
    expect(console.textContent).toContain("boom");
  });

  it("selects a thread from the threads section", () => {
    const selectThread = vi.fn();
    render(
      <DebugPanel debug={makeSession({ state: stoppedState(), selectThread })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    // The threads section is collapsed by default — open it first.
    fireEvent.click(screen.getByText(/Threads \(2\)/));
    fireEvent.click(screen.getByTestId("debug-thread-2"));
    expect(selectThread).toHaveBeenCalledWith(2);
  });

  it("shows the exception banner when stopped on an exception", () => {
    const state = {
      ...stoppedState(),
      exceptionInfo: {
        exceptionId: "java.lang.NullPointerException",
        description: "boom",
        details: "at App.main(App.java:9)",
      },
    };
    render(<DebugPanel debug={makeSession({ state })} onStart={null} onOpenFrame={vi.fn()} />);
    const banner = screen.getByTestId("debug-exception-info");
    expect(banner.textContent).toContain("NullPointerException");
    expect(banner.textContent).toContain("boom");
  });

  it("gates restart-frame on the adapter capability and restarts the frame", () => {
    const restartFrame = vi.fn();
    const { rerender } = render(
      <DebugPanel debug={makeSession({ state: stoppedState(), restartFrame })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    expect(screen.queryByTestId("debug-restart-frame-10")).toBeNull();
    rerender(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          restartFrame,
          capabilities: { supportsRestartFrame: true },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-restart-frame-10"));
    expect(restartFrame).toHaveBeenCalledWith(10);
  });

  it("adds a watch expression through the session", () => {
    const addWatchExpression = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), addWatchExpression })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    const input = screen.getByTestId("debug-watch-input");
    fireEvent.change(input, { target: { value: "x + 1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addWatchExpression).toHaveBeenCalledWith("x + 1");
  });

  it("offers a rerun button when a previous launch config exists", () => {
    const restart = vi.fn();
    render(
      <DebugPanel debug={makeSession({ canRestart: true, restart })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("debug-restart"));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("toggles an exception filter through the session", () => {
    const setExceptionFilters = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          availableExceptionFilters: [{ filter: "uncaught", label: "Uncaught Exceptions" }],
          enabledExceptionFilters: [],
          setExceptionFilters,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-exception-uncaught"));
    expect(setExceptionFilters).toHaveBeenCalledWith(["uncaught"]);
  });
});
