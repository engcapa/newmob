import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoImportCandidateDialog } from "./AutoImportCandidateDialog";
import type { AutoImportCandidate } from "./autoImportModel";

describe("ED-IMPORT-001: AutoImportCandidateDialog component", () => {
  afterEach(() => {
    cleanup();
  });

  const sampleCandidates: AutoImportCandidate[] = [
    {
      symbolName: "List",
      fullyQualifiedName: "java.util.List",
      sourcePackage: "java.util",
      origin: "provider",
      priority: 10,
    },
    {
      symbolName: "List",
      fullyQualifiedName: "java.awt.List",
      sourcePackage: "java.awt",
      origin: "provider",
      priority: 1,
    },
  ];

  it("does not render when closed or empty", () => {
    const { container: closedContainer } = render(
      <AutoImportCandidateDialog
        open={false}
        candidates={sampleCandidates}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(closedContainer.firstChild).toBeNull();

    const { container: emptyContainer } = render(
      <AutoImportCandidateDialog
        open={true}
        candidates={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(emptyContainer.firstChild).toBeNull();
  });

  it("renders candidates and selects with click (ED-IMPORT-001-A1)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <AutoImportCandidateDialog
        open={true}
        candidates={sampleCandidates}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId("auto-import-candidate-dialog")).toBeInTheDocument();
    const options = screen.getAllByTestId("auto-import-candidate-option");
    expect(options).toHaveLength(2);

    expect(screen.getByText("java.util.List")).toBeInTheDocument();
    expect(screen.getByText("java.awt.List")).toBeInTheDocument();

    // Click on second candidate
    fireEvent.click(options[1]);
    expect(onSelect).toHaveBeenCalledWith(sampleCandidates[1]);
  });

  it("navigates with keyboard and selects with Enter (ED-IMPORT-001-A1)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <AutoImportCandidateDialog
        open={true}
        candidates={sampleCandidates}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByTestId("auto-import-candidate-dialog");

    // ArrowDown to move to second candidate
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    // Press Enter to select
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(sampleCandidates[1]);
  });

  it("closes on Escape or Cancel button", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <AutoImportCandidateDialog
        open={true}
        candidates={sampleCandidates}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByTestId("auto-import-candidate-dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    const cancelBtn = screen.getByTestId("auto-import-candidate-cancel");
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
