import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDiagnostic } from "../../../../lib/editor/lsp";
import { ProblemsPanel, type ProblemFileGroup } from "./ProblemsPanel";

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock("../../../../lib/clipboard", () => clipboardMocks);

function diagnostic(message: string, severity: number | null, line: number): LspDiagnostic {
  return {
    range: {
      start: { line, character: 2 },
      end: { line, character: 5 },
    },
    severity,
    code: severity === 1 ? "E100" : null,
    source: "test-lsp",
    message,
  };
}

const files: ProblemFileGroup[] = [
  {
    key: "root:app:src/a.ts",
    title: "a.ts",
    subtitle: "app / src/a.ts",
    diagnostics: [
      diagnostic("Broken expression", 1, 3),
      diagnostic("Unused value", 2, 7),
      diagnostic("Type information", 3, 9),
    ],
  },
];

describe("ProblemsPanel", () => {
  afterEach(() => {
    cleanup();
    clipboardMocks.writeText.mockReset();
  });

  it("groups open-file diagnostics and filters by severity", () => {
    render(<ProblemsPanel files={files} onOpenProblem={vi.fn()} />);

    expect(screen.getByText("app / src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Broken expression")).toBeInTheDocument();
    expect(screen.getByText("Unused value")).toBeInTheDocument();
    expect(screen.getByText("Type information")).toBeInTheDocument();

    const warnings = screen.getByRole("button", { name: "Show warning diagnostics" });
    fireEvent.click(warnings);
    expect(warnings).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Unused value")).not.toBeInTheDocument();
    expect(screen.getByText("Broken expression")).toBeInTheDocument();
  });

  it("opens a selected problem and exposes diagnostic context actions", () => {
    const onOpenProblem = vi.fn();
    render(<ProblemsPanel files={files} onOpenProblem={onOpenProblem} />);

    const problem = screen.getByRole("button", { name: /Broken expression/ });
    fireEvent.click(problem);
    expect(onOpenProblem).toHaveBeenCalledWith(files[0].key, files[0].diagnostics[0]);

    fireEvent.contextMenu(problem, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("button", { name: "Copy Message" }));
    expect(clipboardMocks.writeText).toHaveBeenCalledWith("Broken expression");

    fireEvent.contextMenu(problem, { clientX: 12, clientY: 18 });
    expect(screen.getByRole("button", { name: "Quick Fix" })).toBeDisabled();
  });

  it("states the open-file boundary when there are no diagnostics", () => {
    render(<ProblemsPanel files={[]} onOpenProblem={vi.fn()} />);
    expect(screen.getByText("No problems in open files")).toBeInTheDocument();
  });

  it("switches scope and triggers a rebuild in project mode (M7-C)", () => {
    const onScopeChange = vi.fn();
    const onRebuild = vi.fn();
    const { rerender } = render(
      <ProblemsPanel
        files={files}
        onOpenProblem={vi.fn()}
        scope="open"
        onScopeChange={onScopeChange}
        onRebuild={onRebuild}
      />,
    );
    // Rebuild button is hidden in "open files" scope.
    expect(screen.queryByTestId("problems-rebuild")).toBeNull();
    fireEvent.click(screen.getByTestId("problems-scope-project"));
    expect(onScopeChange).toHaveBeenCalledWith("project");

    // Re-render in project scope: rebuild button appears and fires.
    rerender(
      <ProblemsPanel
        files={files}
        onOpenProblem={vi.fn()}
        scope="project"
        onScopeChange={onScopeChange}
        onRebuild={onRebuild}
      />,
    );
    fireEvent.click(screen.getByTestId("problems-rebuild"));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("shows a project-scope empty state and loading text", () => {
    const { rerender } = render(
      <ProblemsPanel files={[]} onOpenProblem={vi.fn()} scope="project" onScopeChange={vi.fn()} />,
    );
    expect(screen.getByText("No problems in the project")).toBeInTheDocument();
    rerender(
      <ProblemsPanel files={[]} onOpenProblem={vi.fn()} scope="project" onScopeChange={vi.fn()} loading />,
    );
    expect(screen.getByText("Loading project problems…")).toBeInTheDocument();
  });
});
