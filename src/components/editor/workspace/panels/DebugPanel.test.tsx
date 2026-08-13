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
    breakpointsMuted: false,
    setBreakpointsMuted: vi.fn(),
    removeAllBreakpoints: vi.fn(),
    frameVariables: {},
    startDebug: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn(),
    canRestart: false,
    toggleBreakpoint: vi.fn(),
    setBreakpointOptions: vi.fn(),
    removeBreakpoint: vi.fn(),
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
    hoverEvaluate: vi.fn().mockResolvedValue(null),
    setVariable: vi.fn().mockResolvedValue(null),
    logConsole: vi.fn(),
    clearConsole: vi.fn(),
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

function stoppedState(): DebugSessionState {
  return {
    ...initialDebugState("s1"),
    status: "stopped",
    stoppedThreadId: 1,
    stoppedReason: "breakpoint",
    threads: [{ id: 1, name: "main" }, { id: 2, name: "worker" }],
    frames: [{ id: 10, name: "App.main", path: "/repo/App.java", line: 9, column: 1, sourceReference: 0, sourceName: null }],
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

  it("selects the active Run/Debug configuration from the panel", () => {
    const onActiveConfigurationChange = vi.fn();
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={vi.fn()}
        onOpenFrame={vi.fn()}
        configurations={[
          { id: "run:default", label: "Default" },
          { id: "run:local", label: "Local" },
        ]}
        activeConfigurationId="run:default"
        onActiveConfigurationChange={onActiveConfigurationChange}
      />,
    );
    fireEvent.change(screen.getByTestId("debug-active-configuration"), {
      target: { value: "run:local" },
    });
    expect(onActiveConfigurationChange).toHaveBeenCalledWith("run:local");
  });

  it("labels shared and local configuration provenance in the chooser", () => {
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={vi.fn()}
        onOpenFrame={vi.fn()}
        configurations={[
          { id: "shared-run:team", label: "Team", source: "shared" },
          { id: "run:local", label: "Local", source: "local" },
        ]}
        activeConfigurationId="shared-run:team"
      />,
    );
    expect(screen.getByRole("option", { name: "Team [Shared]" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Local [Local]" })).toBeInTheDocument();
  });

  it("surfaces an unavailable configuration diagnostic without hiding the choice", () => {
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={null}
        onOpenFrame={vi.fn()}
        configurations={[{
          id: "compound-debug",
          label: "All services",
          source: "shared",
          available: false,
          diagnostic: "Compound Debug requires grouped multi-session DAP support",
        }]}
        activeConfigurationId="compound-debug"
      />,
    );
    expect(screen.getByRole("option", { name: /All services \[Shared\] \[Unavailable\]/ })).toBeInTheDocument();
    expect(screen.getByTestId("debug-configuration-diagnostic")).toHaveTextContent(
      "Compound Debug requires grouped multi-session DAP support",
    );
  });

  it("explains the desktop requirement in the browser preview", () => {
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={null}
        onOpenFrame={vi.fn()}
        runtimeAvailable={false}
      />,
    );
    // The empty state must say debugging is desktop-only, not the generic
    // "press start" hint that implies it would work here.
    const empty = screen.getByTestId("debug-empty-state");
    expect(empty.textContent).toMatch(/desktop app only/i);
    expect(empty.textContent).not.toMatch(/press start/i);
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

  it("lists every workspace breakpoint and reveals one on click", () => {
    const onOpenBreakpoint = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: {
            "/repo/A.java": [{ line: 12, condition: "i > 3" }],
            "/repo/B.java": [{ line: 4, enabled: false }],
          },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        onOpenBreakpoint={onOpenBreakpoint}
      />,
    );
    expect(screen.getByTestId("debug-breakpoint-12")).toHaveTextContent("A.java:12");
    expect(screen.getByTestId("debug-breakpoint-12")).toHaveTextContent("if i > 3");
    fireEvent.click(screen.getByTestId("debug-breakpoint-4"));
    expect(onOpenBreakpoint).toHaveBeenCalledWith("/repo/B.java", 4);
  });

  it("enables, disables and removes breakpoints from the breakpoints view", () => {
    const setBreakpointOptions = vi.fn();
    const removeBreakpoint = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointOptions,
          removeBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-breakpoint-enabled-12"));
    expect(setBreakpointOptions).toHaveBeenCalledWith("/repo/A.java", 12, { enabled: false });
    fireEvent.click(screen.getByTestId("debug-breakpoint-remove-12"));
    expect(removeBreakpoint).toHaveBeenCalledWith("/repo/A.java", 12);
  });

  it("edits a breakpoint's condition inline instead of through modal prompts", () => {
    const setBreakpointOptions = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointOptions,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        editingBreakpoint={{ path: "/repo/A.java", line: 12 }}
      />,
    );
    const condition = screen.getByTestId("debug-breakpoint-condition-12");
    fireEvent.change(condition, { target: { value: "i > 3" } });
    fireEvent.keyDown(condition, { key: "Enter" });
    expect(setBreakpointOptions).toHaveBeenCalledWith("/repo/A.java", 12, { condition: "i > 3" });
    // Hit count and log message live in the same editor.
    const hit = screen.getByTestId("debug-breakpoint-hit-12");
    fireEvent.change(hit, { target: { value: "5" } });
    fireEvent.keyDown(hit, { key: "Enter" });
    expect(setBreakpointOptions).toHaveBeenCalledWith("/repo/A.java", 12, { hitCondition: "5" });
  });

  it("mutes and clears breakpoints from the section header", () => {
    const setBreakpointsMuted = vi.fn();
    const removeAllBreakpoints = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointsMuted,
          removeAllBreakpoints,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-mute-breakpoints"));
    expect(setBreakpointsMuted).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("debug-remove-all-breakpoints"));
    expect(removeAllBreakpoints).toHaveBeenCalledTimes(1);
  });

  it("offers remote attach only when the parent supplies it", () => {
    const onAttach = vi.fn();
    const { rerender } = render(
      <DebugPanel debug={makeSession()} onStart={null} onOpenFrame={vi.fn()} onAttach={onAttach} />,
    );
    fireEvent.click(screen.getByTestId("debug-attach"));
    expect(onAttach).toHaveBeenCalledTimes(1);
    rerender(<DebugPanel debug={makeSession()} onStart={null} onOpenFrame={vi.fn()} onAttach={null} />);
    expect(screen.queryByTestId("debug-attach")).toBeNull();
  });

  it("clears the console from the section header", () => {
    const clearConsole = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), clearConsole })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-console-clear"));
    expect(clearConsole).toHaveBeenCalledTimes(1);
  });
});
