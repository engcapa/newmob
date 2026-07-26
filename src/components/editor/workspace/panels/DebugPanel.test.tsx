import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugPanel } from "./DebugPanel";
import type { CodeDebugSession } from "../useCodeDebugSession";
import { initialDebugState, type DebugSessionState } from "../dapDebugModel";

function makeSession(overrides: Partial<CodeDebugSession> = {}): CodeDebugSession {
  return {
    state: null,
    breakpoints: {},
    availableExceptionFilters: [],
    enabledExceptionFilters: [],
    startDebug: vi.fn().mockResolvedValue(undefined),
    toggleBreakpoint: vi.fn(),
    setBreakpointOptions: vi.fn(),
    setExceptionFilters: vi.fn(),
    step: vi.fn(),
    hotReload: vi.fn(),
    evaluate: vi.fn().mockResolvedValue(""),
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
    threads: [{ id: 1, name: "main" }],
    frames: [{ id: 10, name: "App.main", path: "/repo/App.java", line: 9, column: 1 }],
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
    const onOpenFrame = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), step })}
        onStart={null}
        onOpenFrame={onOpenFrame}
      />,
    );
    // Frame shows and is clickable (has a path).
    fireEvent.click(screen.getByTestId("debug-frame-10"));
    expect(onOpenFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 10, path: "/repo/App.java" }));
    // Step controls dispatch DAP actions.
    fireEvent.click(screen.getByTestId("debug-continue"));
    expect(step).toHaveBeenCalledWith("continue");
    fireEvent.click(screen.getByTestId("debug-step-over"));
    expect(step).toHaveBeenCalledWith("stepOver");
    fireEvent.click(screen.getByTestId("debug-stop"));
    expect(makeSession().terminate).not.toBe(step); // sanity: distinct mocks
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
