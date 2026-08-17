import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugSubTabBar } from "./DebugSubTabBar";

describe("DebugSubTabBar", () => {
  afterEach(cleanup);

  it("renders 4 sub tabs and switches active tab on click", () => {
    const onTabChange = vi.fn();
    render(
      <DebugSubTabBar
        activeTab="debugger"
        onTabChange={onTabChange}
        badges={{ console: 5, breakpoints: 2 }}
        statusText="stopped · breakpoint"
      />,
    );

    expect(screen.getByTestId("debug-subtab-debugger")).toBeInTheDocument();
    expect(screen.getByTestId("debug-subtab-console")).toBeInTheDocument();
    expect(screen.getByTestId("debug-subtab-breakpoints")).toBeInTheDocument();
    expect(screen.getByTestId("debug-subtab-memory")).toBeInTheDocument();

    expect(screen.getByTestId("debug-subtab-console-badge")).toHaveTextContent("5");
    expect(screen.getByTestId("debug-subtab-breakpoints-badge")).toHaveTextContent("2");
    expect(screen.getByText("stopped · breakpoint")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("debug-subtab-console"));
    expect(onTabChange).toHaveBeenCalledWith("console");

    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    expect(onTabChange).toHaveBeenCalledWith("breakpoints");

    fireEvent.click(screen.getByTestId("debug-subtab-memory"));
    expect(onTabChange).toHaveBeenCalledWith("memory");
  });
});
