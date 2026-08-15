import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeymapCheatSheetDialog } from "./KeymapCheatSheetDialog";
import type { WorkspaceCommand } from "./workspaceCommands";

afterEach(cleanup);

describe("KeymapCheatSheetDialog", () => {
  const sampleCommands: WorkspaceCommand[] = [
    {
      id: "workspace.toggleCase",
      title: "Toggle Case",
      category: "Edit",
      keybinding: "Ctrl+Shift+U",
      run: vi.fn(),
    },
    {
      id: "workspace.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      keybinding: "Shift+F6",
      run: vi.fn(),
    },
    {
      id: "workspace.runContextConfiguration",
      title: "Run Context Configuration",
      category: "Run",
      keybinding: "Ctrl+Shift+F10",
      run: vi.fn(),
    },
    {
      id: "workspace.unboundCommand",
      title: "Unbound Action",
      category: "View",
      run: vi.fn(),
    },
  ];

  it("renders keymap dialog with shortcuts and categories", () => {
    const onClose = vi.fn();
    render(
      <KeymapCheatSheetDialog
        open={true}
        commands={sampleCommands}
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
        commands={sampleCommands}
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
        commands={sampleCommands}
        onClose={onClose}
      />,
    );

    const refactorChip = screen.getByTestId("keymap-category-Refactor");
    fireEvent.click(refactorChip);

    expect(screen.getByText("Rename Symbol")).toBeInTheDocument();
    expect(screen.queryByText("Toggle Case")).toBeNull();
  });

  it("executes command when clicking run button", () => {
    const onClose = vi.fn();
    const onExecuteCommand = vi.fn();
    render(
      <KeymapCheatSheetDialog
        open={true}
        commands={sampleCommands}
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
