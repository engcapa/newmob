import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HighlightingWidget } from "./HighlightingWidget";
import type { DiagnosticScope } from "./diagnosticScopeModel";
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

  it("exposes menu radio semantics and the active provider scope", () => {
    const scope: DiagnosticScope = {
      fileKey: "root:repo:src/main.ts",
      revision: 3,
      providerId: "typescript",
      providerGeneration: 1,
      uri: "file:///repo/src/main.ts",
    };
    render(
      <HighlightingWidget
        diagnostics={sampleDiagnostics}
        fileKey={scope.fileKey}
        diagnosticScope={scope}
        level="syntax"
        onChangeLevel={vi.fn()}
        providerName="TypeScript"
        providerActive
      />,
    );

    expect(screen.getByTestId("code-workspace-highlighting-widget")).toHaveAttribute(
      "data-diagnostic-revision",
      "3",
    );
    fireEvent.click(screen.getByTestId("highlighting-widget-level-button"));
    expect(screen.getByRole("menu")).toHaveAccessibleName("Highlighting level options");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.getByTestId("highlighting-level-option-syntax")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("highlighting-widget-provider")).toHaveTextContent("Scope: TypeScript");
    expect(screen.getByTestId("highlighting-widget-diagnostic-status")).toHaveTextContent("1 error(s), 1 warning(s)");
  });

  it("reports the no-provider state without claiming a local parser", () => {
    render(
      <HighlightingWidget
        diagnostics={[]}
        diagnosticsReady={false}
        level="all"
        onChangeLevel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("highlighting-widget-level-button"));
    expect(screen.getByTestId("highlighting-widget-provider")).toHaveTextContent("No active language server");
    expect(screen.getByTestId("highlighting-widget-diagnostic-status")).toHaveTextContent(
      "Diagnostics unavailable without a language server",
    );
    expect(screen.queryByText("Local syntax parser")).not.toBeInTheDocument();
    expect(screen.getByTestId("highlighting-widget-next-error")).toBeDisabled();
  });

  it("restores editor focus after changing the level", () => {
    let editor: HTMLElement;
    const restoreFocus = vi.fn(() => editor.focus());
    render(
      <div>
        <div data-testid="editor-focus-target" tabIndex={0} ref={(node) => { if (node) editor = node; }} />
        <HighlightingWidget
          diagnostics={sampleDiagnostics}
          level="all"
          onChangeLevel={vi.fn()}
          onRestoreEditorFocus={restoreFocus}
        />
      </div>,
    );
    editor = screen.getByTestId("editor-focus-target");

    fireEvent.click(screen.getByTestId("highlighting-widget-level-button"));
    fireEvent.click(screen.getByTestId("highlighting-level-option-none"));
    expect(restoreFocus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(editor);
  });

  it("keeps navigation disabled while the displayed diagnostics are stale", () => {
    render(
      <HighlightingWidget
        diagnostics={sampleDiagnostics}
        diagnosticsReady={false}
        providerActive
        level="all"
        onChangeLevel={vi.fn()}
        onNavigateNextError={vi.fn()}
      />,
    );

    expect(screen.getByTestId("highlighting-widget-next-error")).toBeDisabled();
  });

  it("moves through level options with the keyboard and returns focus on escape", () => {
    render(
      <HighlightingWidget
        diagnostics={[]}
        level="all"
        onChangeLevel={vi.fn()}
      />,
    );

    const levelButton = screen.getByTestId("highlighting-widget-level-button");
    fireEvent.click(levelButton);
    const allOption = screen.getByTestId("highlighting-level-option-all");
    const syntaxOption = screen.getByTestId("highlighting-level-option-syntax");
    const noneOption = screen.getByTestId("highlighting-level-option-none");

    expect(document.activeElement).toBe(allOption);
    fireEvent.keyDown(allOption, { key: "ArrowDown" });
    expect(document.activeElement).toBe(syntaxOption);
    fireEvent.keyDown(syntaxOption, { key: "End" });
    expect(document.activeElement).toBe(noneOption);
    fireEvent.keyDown(noneOption, { key: "Home" });
    expect(document.activeElement).toBe(allOption);
    fireEvent.keyDown(allOption, { key: "Escape" });
    expect(screen.queryByTestId("highlighting-widget-menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(levelButton);
  });
});
