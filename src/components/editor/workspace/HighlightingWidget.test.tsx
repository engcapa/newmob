import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HighlightingWidget } from "./HighlightingWidget";
import type { LspDiagnostic } from "../../../lib/editor/lsp";

afterEach(() => {
  cleanup();
});

describe("HighlightingWidget", () => {
  const sampleDiagnostics: LspDiagnostic[] = [
    {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      severity: 1, // error
      message: "Type error",
      source: "ts",
      code: "2322",
    },
    {
      range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } },
      severity: 2, // warning
      message: "Unused variable",
      source: "ts",
      code: "6133",
    },
  ];

  it("renders error and warning badges accurately", () => {
    render(
      <HighlightingWidget
        diagnostics={sampleDiagnostics}
        level="all"
        onChangeLevel={vi.fn()}
      />,
    );

    expect(screen.getByTitle("1 error(s)")).toBeTruthy();
    expect(screen.getByTitle("1 warning(s)")).toBeTruthy();
    expect(screen.getByText("All Problems")).toBeTruthy();
  });

  it("navigates next and previous error", () => {
    const handleNext = vi.fn();
    const handlePrev = vi.fn();

    render(
      <HighlightingWidget
        diagnostics={sampleDiagnostics}
        level="all"
        onChangeLevel={vi.fn()}
        onNavigateNextError={handleNext}
        onNavigatePrevError={handlePrev}
      />,
    );

    fireEvent.click(screen.getByTestId("highlighting-widget-next-error"));
    expect(handleNext).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("highlighting-widget-prev-error"));
    expect(handlePrev).toHaveBeenCalledTimes(1);
  });

  it("opens menu and changes highlighting level", () => {
    const handleChangeLevel = vi.fn();
    const handleOpenSettings = vi.fn();

    render(
      <HighlightingWidget
        diagnostics={sampleDiagnostics}
        level="all"
        onChangeLevel={handleChangeLevel}
        providerName="TypeScript"
        providerActive={true}
        onOpenSettings={handleOpenSettings}
      />,
    );

    // Open menu
    fireEvent.click(screen.getByTestId("highlighting-widget-level-button"));
    expect(screen.getByTestId("highlighting-widget-menu")).toBeTruthy();
    expect(screen.getByText("Scope: TypeScript")).toBeTruthy();

    // Select Syntax level
    fireEvent.click(screen.getByTestId("highlighting-level-option-syntax"));
    expect(handleChangeLevel).toHaveBeenCalledWith("syntax");
  });
});
