import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceActionsController } from "./useWorkspaceActionsController";
import type { WorkspaceCommand } from "./workspaceCommands";

describe("useWorkspaceActionsController", () => {
  it("registers commands and executes them by id", () => {
    const runMock = vi.fn();
    const commands: WorkspaceCommand[] = [
      {
        id: "workspace.customAction",
        title: "Custom Action",
        category: "Edit",
        keybinding: "Ctrl+Alt+C",
        run: runMock,
      },
    ];

    const { result } = renderHook(() =>
      useWorkspaceActionsController({
        commands,
        activeFocus: "editor",
      })
    );

    expect(result.current.menuItems.length).toBe(1);
    expect(result.current.menuItems[0].id).toBe("workspace.customAction");

    act(() => {
      const executed = result.current.executeCommand("workspace.customAction");
      expect(executed).toBe(true);
    });

    expect(runMock).toHaveBeenCalled();
  });

  it("dispatches matching keyboard shortcuts", async () => {
    const runMock = vi.fn();
    const commands: WorkspaceCommand[] = [
      {
        id: "workspace.save",
        title: "Save",
        category: "File",
        keybinding: "Ctrl+S",
        run: runMock,
      },
    ];

    const { result } = renderHook(() =>
      useWorkspaceActionsController({
        commands,
        activeFocus: "editor",
      })
    );

    const event = {
      key: "s",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      const dispatched = await result.current.dispatchKeydown(event);
      expect(dispatched?.id).toBe("workspace.save");
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });
});
