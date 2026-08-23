import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeymapCheatSheetDialog } from "./KeymapCheatSheetDialog";
import type { ActionSnapshotItem, PreparedActionEvaluation } from "./workspaceActionHost";

afterEach(cleanup);

/** Snapshot-only fixture (§8.17.3): the commands array input is gone. */
function snapshotFixture(
  overrides: Partial<ActionSnapshotItem> & Pick<ActionSnapshotItem, "id" | "title" | "category" | "keybinding">,
): ActionSnapshotItem {
  return {
    keybindings: [],
    state: {
      availability: "available",
      disabledReason: undefined,
      source: "local",
      scope: "workspace",
      freshness: "current",
      completeness: "complete",
    },
    evaluation: {} as unknown as PreparedActionEvaluation,
    ...overrides,
  };
}

describe("KeymapCheatSheetDialog", () => {
  const sampleSnapshots: ActionSnapshotItem[] = [
    snapshotFixture({
      id: "workspace.toggleCase",
      title: "Toggle Case",
      category: "Edit",
      keybinding: "Ctrl+Shift+U",
    }),
    snapshotFixture({
      id: "workspace.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      keybinding: "Shift+F6",
    }),
    snapshotFixture({
      id: "workspace.runContextConfiguration",
      title: "Run Context Configuration",
      category: "Run",
      keybinding: "Ctrl+Shift+F10",
    }),
  ];

  it("renders keymap dialog with shortcuts and categories", () => {
    const onClose = vi.fn();
    render(
      <KeymapCheatSheetDialog
        open={true}
        actionSnapshots={sampleSnapshots}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Keyboard Shortcuts & Keymap")).toBeInTheDocument();
    expect(screen.getByText(/3 shortcut keybindings configured/)).toBeInTheDocument();
    expect(screen.getByText("Toggle Case")).toBeInTheDocument();
    expect(screen.getByText("Rename Symbol")).toBeInTheDocument();
    expect(screen.getByText("Run Context Configuration")).toBeInTheDocument();
    expect(screen.queryByText("Unbound Action")).toBeNull();
  });

  it("filters by search term", () => {
    const onClose = vi.fn();
    render(
      <KeymapCheatSheetDialog
        open={true}
        actionSnapshots={sampleSnapshots}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId("keymap-search-input");
    fireEvent.change(input, { target: { value: "rename" } });

    expect(screen.getByText("Rename Symbol")).toBeInTheDocument();
    expect(screen.queryByText("Toggle Case")).toBeNull();
    expect(screen.queryByText("Run Context Configuration")).toBeNull();
  });

  it("filters by category chip", () => {
    const onClose = vi.fn();
    render(
      <KeymapCheatSheetDialog
        open={true}
        actionSnapshots={sampleSnapshots}
        onClose={onClose}
      />,
    );

    const refactorChip = screen.getByTestId("keymap-category-Refactor");
    fireEvent.click(refactorChip);

    expect(screen.getByText("Rename Symbol")).toBeInTheDocument();
    expect(screen.queryByText("Toggle Case")).toBeNull();
  });



  it("shows disabled snapshot actions without exposing Run", () => {
    render(
      <KeymapCheatSheetDialog
        open
        actionSnapshots={[{
          id: "workspace.toggleCase",
          title: "Toggle Case",
          category: "Edit",
          keybinding: "Ctrl+Shift+U",
          keybindings: [],
          state: {
            availability: "disabled",
            disabledReason: "providerOffline",
            source: "provider",
            scope: "workspace",
            freshness: "current",
            completeness: "unavailable",
          },
          evaluation: {} as unknown as PreparedActionEvaluation,
        }]}
        onClose={vi.fn()}
        onExecuteCommand={vi.fn()}
      />,
    );

    expect(screen.getByText("Toggle Case")).toBeInTheDocument();
    expect(screen.queryByTestId("keymap-run-workspace.toggleCase")).not.toBeInTheDocument();
  });

  it("executes command when clicking run button", () => {
    const onClose = vi.fn();
    const onExecuteCommand = vi.fn();
    render(
      <KeymapCheatSheetDialog
        open={true}
        actionSnapshots={sampleSnapshots}
        onClose={onClose}
        onExecuteCommand={onExecuteCommand}
      />,
    );

    const runBtn = screen.getByTestId("keymap-run-workspace.toggleCase");
    fireEvent.click(runBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onExecuteCommand).toHaveBeenCalledWith("workspace.toggleCase");
  });
});
