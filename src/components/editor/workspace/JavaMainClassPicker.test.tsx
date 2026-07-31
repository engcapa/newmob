import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JavaMainClassPicker } from "./JavaMainClassPicker";
import type { JavaMainClassOption } from "../../../lib/editor/dap";

const CANDIDATES: JavaMainClassOption[] = [
  { mainClass: "com.example.App", projectName: "demo", filePath: "/repo/src/App.java" },
  { mainClass: "com.example.Tool", projectName: "demo", filePath: "/repo/src/Tool.java" },
];

describe("JavaMainClassPicker", () => {
  afterEach(cleanup);

  it("is hidden when closed", () => {
    render(<JavaMainClassPicker open={false} candidates={CANDIDATES} onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.queryByTestId("code-workspace-java-main-picker")).toBeNull();
  });

  it("lists candidates and picks the chosen main class", () => {
    const onPick = vi.fn();
    render(<JavaMainClassPicker open candidates={CANDIDATES} onClose={vi.fn()} onPick={onPick} />);
    const panel = screen.getByTestId("code-workspace-java-main-picker");
    // Both fully-qualified names are shown so the user can disambiguate.
    expect(within(panel).getByText("com.example.App · demo")).toBeInTheDocument();
    expect(within(panel).getByText("com.example.Tool · demo")).toBeInTheDocument();
    // Filter to the second, then Enter picks exactly it.
    fireEvent.change(within(panel).getByLabelText("Select a main class to debug"), {
      target: { value: "Tool" },
    });
    fireEvent.keyDown(within(panel).getByLabelText("Select a main class to debug"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(CANDIDATES[1]);
  });
});
