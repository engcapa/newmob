import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { RefactoringPreviewDialog } from "./RefactoringPreviewDialog";
import { buildWorkspaceEditPreview } from "./workspaceEditPreview";

afterEach(cleanup);

describe("RefactoringPreviewDialog", () => {
  const sampleEdit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: "file:///repo/src/UserService.ts",
        path: "/repo/src/UserService.ts",
        edits: [
          { range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } }, newText: "authManager" },
          { range: { start: { line: 25, character: 8 }, end: { line: 25, character: 16 } }, newText: "authManager" },
        ],
      },
      {
        uri: "file:///repo/src/AuthController.ts",
        path: "/repo/src/AuthController.ts",
        edits: [
          { range: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } }, newText: "authManager" },
        ],
      },
    ],
  };

  it("renders preview with files and usage counts", () => {
    const preview = buildWorkspaceEditPreview(sampleEdit, { label: "Rename userManager to authManager" });
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <RefactoringPreviewDialog
        open={true}
        title="Rename userManager to authManager"
        preview={preview}
        originalEdit={sampleEdit}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("Rename userManager to authManager")).toBeInTheDocument();
    expect(screen.getByText(/2 file\(s\) affected · 3 of 3 change\(s\) selected/)).toBeInTheDocument();
    expect(screen.getByText("/repo/src/UserService.ts")).toBeInTheDocument();
    expect(screen.getByText("/repo/src/AuthController.ts")).toBeInTheDocument();
  });

  it("allows unchecking specific usages and confirms filtered edit", () => {
    const preview = buildWorkspaceEditPreview(sampleEdit);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <RefactoringPreviewDialog
        open={true}
        preview={preview}
        originalEdit={sampleEdit}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // Uncheck second usage in UserService.ts (id "0:1")
    const usage2 = screen.getByTestId("refactoring-preview-usage-0:1");
    fireEvent.click(usage2);

    expect(screen.getByText(/2 of 3 change\(s\) selected/)).toBeInTheDocument();

    // Click Apply
    fireEvent.click(screen.getByTestId("refactoring-preview-apply"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const filteredEdit: LspWorkspaceEdit = onConfirm.mock.calls[0][0];
    expect(filteredEdit.documentEdits[0].edits).toHaveLength(1);
    expect(filteredEdit.documentEdits[0].edits[0].range.start.line).toBe(10);
    expect(filteredEdit.documentEdits[1].edits).toHaveLength(1);
  });

  it("supports Select All and Deselect All", () => {
    const preview = buildWorkspaceEditPreview(sampleEdit);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <RefactoringPreviewDialog
        open={true}
        preview={preview}
        originalEdit={sampleEdit}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId("refactoring-preview-select-none"));
    expect(screen.getByText(/0 of 3 change\(s\) selected/)).toBeInTheDocument();
    expect(screen.getByTestId("refactoring-preview-apply")).toBeDisabled();

    fireEvent.click(screen.getByTestId("refactoring-preview-select-all"));
    expect(screen.getByText(/3 of 3 change\(s\) selected/)).toBeInTheDocument();
    expect(screen.getByTestId("refactoring-preview-apply")).not.toBeDisabled();
  });
});
