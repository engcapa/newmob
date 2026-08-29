import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCompareDialog } from "./EditorCompareDialog";
import type { EditorCompareSession } from "./editorCompareModel";

afterEach(() => {
  cleanup();
});

describe("EditorCompareDialog", () => {
  const sampleSession: EditorCompareSession = {
    id: "comp-1",
    title: "Compare file with Clipboard",
    left: {
      title: "Clipboard",
      text: "line A\nline B",
      readOnly: true,
    },
    right: {
      title: "Active.ts",
      text: "line A\nline C",
      readOnly: false,
    },
  };

  it("renders side-by-side diff with line comparison", () => {
    render(<EditorCompareDialog session={sampleSession} onClose={vi.fn()} />);

    expect(screen.getByTestId("code-workspace-compare-dialog")).toBeTruthy();
    expect(screen.getByText("Compare file with Clipboard")).toBeTruthy();
    expect(screen.getByText("Clipboard")).toBeTruthy();
    expect(screen.getByText("Active.ts")).toBeTruthy();
  });

  it("handles apply and close callbacks", () => {
    const handleClose = vi.fn();
    const handleApply = vi.fn();

    render(
      <EditorCompareDialog
        session={sampleSession}
        onClose={handleClose}
        onApplyRight={handleApply}
      />,
    );

    const applyBtn = screen.getByTestId("compare-apply-left-to-right");
    fireEvent.click(applyBtn);
    expect(handleApply).toHaveBeenCalledWith("line A\nline B");

    const closeBtn = screen.getByTestId("compare-dialog-close");
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
