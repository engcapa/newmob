import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCompareDialog } from "./EditorCompareDialog";
import type { EditorCompareSession } from "./editorCompareModel";

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(async (_text: string) => undefined),
}));

vi.mock("../../../lib/clipboard", () => clipboardMocks);

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

  it("renders metadata and typed unavailable states without enabling unsafe actions", () => {
    const unavailableSession: EditorCompareSession = {
      ...sampleSession,
      source: "file",
      left: {
        title: "Binary.bin",
        path: "/tmp/Binary.bin",
        text: "",
        source: "file",
        readOnly: true,
        unavailable: {
          reason: "binary",
          message: "Binary content cannot be compared as text.",
        },
      },
      right: {
        ...sampleSession.right,
        encoding: "UTF-8",
        eol: "CRLF",
        bom: true,
        sizeBytes: 18,
      },
    };

    render(
      <EditorCompareDialog
        session={unavailableSession}
        onClose={vi.fn()}
        onApplyRight={vi.fn()}
      />,
    );

    expect(screen.getByTestId("compare-session-metadata")).toHaveTextContent("file");
    expect(screen.getByTestId("compare-left-unavailable")).toHaveTextContent("binary");
    expect(screen.getByTestId("compare-left-unavailable")).toHaveTextContent(
      "Binary content cannot be compared as text.",
    );
    expect(screen.getByTestId("compare-apply-left-to-right")).toBeDisabled();
    expect(screen.getByTestId("compare-copy-left")).toBeDisabled();
    expect(screen.getByLabelText("Active.ts comparison side")).toHaveTextContent(
      "UTF-8 · CRLF · BOM · 18 B",
    );
  });

  it("reports copy success and native/browser clipboard failures", async () => {
    clipboardMocks.writeText.mockReset().mockResolvedValue(undefined);
    render(<EditorCompareDialog session={sampleSession} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("compare-copy-left"));
    expect(clipboardMocks.writeText).toHaveBeenCalledWith("line A\nline B");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");

    cleanup();
    clipboardMocks.writeText.mockReset().mockRejectedValue(new Error("permission denied"));
    render(<EditorCompareDialog session={sampleSession} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("compare-copy-right"));
    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed: permission denied");
  });

  it("keeps apply failures visible and traps keyboard focus in the dialog", async () => {
    const handleClose = vi.fn();
    const handleApply = vi.fn(async () => {
      throw new Error("buffer changed");
    });
    render(
      <EditorCompareDialog
        session={sampleSession}
        onClose={handleClose}
        onApplyRight={handleApply}
      />,
    );

    const applyButton = screen.getByTestId("compare-apply-left-to-right");
    const closeButton = screen.getByTestId("compare-dialog-close");
    await vi.waitFor(() => expect(document.activeElement).toBe(applyButton));
    fireEvent.keyDown(applyButton, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(applyButton);

    fireEvent.click(applyButton);
    expect(await screen.findByTestId("compare-apply-error")).toHaveTextContent("buffer changed");
    expect(screen.getByTestId("code-workspace-compare-dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
