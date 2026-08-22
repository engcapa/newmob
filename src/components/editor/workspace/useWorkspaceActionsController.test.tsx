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

  it("disposes the host on real unmount and never executes afterwards", async () => {
    const runMock = vi.fn();
    const commands: WorkspaceCommand[] = [
      { id: "workspace.disposeProbe", title: "Probe", category: "Edit", run: runMock },
    ];
    const { result, unmount } = renderHook(() =>
      useWorkspaceActionsController({ commands, activeFocus: "editor" }),
    );

    expect(result.current.host.isDisposed()).toBe(false);
    unmount();
    // After real unmount the captured host must answer typed failed and
    // must not re-run commands.
    const staleResult = await result.current.host.execute("workspace.disposeProbe");
    expect(staleResult.kind).toBe("failed");
    expect(runMock).not.toHaveBeenCalled();
  });

  it("self-heals after StrictMode transient dispose by minting a fresh host", async () => {
    const runMock = vi.fn();
    const commands: WorkspaceCommand[] = [
      { id: "workspace.healProbe", title: "Heal", category: "Edit", run: runMock },
    ];
    const { result } = renderHook(() =>
      useWorkspaceActionsController({ commands, activeFocus: "editor" }),
    );

    // Simulate StrictMode: effect cleanup disposes, then accessors self-heal.
    act(() => {
      result.current.host.dispose();
    });

    // The first accessor call after dispose mints a fresh host...
    let executed = false;
    act(() => {
      executed = result.current.executeCommand("workspace.healProbe");
    });
    // ...whose commands effect registers on the follow-up render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!executed) {
      act(() => {
        executed = result.current.executeCommand("workspace.healProbe");
      });
    }
    expect(executed).toBe(true);
    expect(result.current.host.isDisposed()).toBe(false);
    expect(runMock).toHaveBeenCalled();
    expect(result.current.snapshot.some((entry) => entry.id === "workspace.healProbe")).toBe(true);
  });

  it("exposes an instance snapshot with evaluated state per action", () => {
    const commands: WorkspaceCommand[] = [
      {
        id: "workspace.snapGated",
        title: "Gated",
        category: "Edit",
        keybinding: "Ctrl+G",
        when: (ctx) => ctx.focus === "editor",
        run: () => {},
      },
    ];
    const { result, rerender } = renderHook(
      ({ focus }: { focus: "editor" | "tree" }) =>
        useWorkspaceActionsController({ commands, activeFocus: focus }),
      { initialProps: { focus: "editor" as "editor" | "tree" } },
    );

    expect(result.current.snapshot).toHaveLength(1);
    expect(result.current.snapshot[0].state.availability).toBe("available");

    rerender({ focus: "tree" });
    expect(result.current.snapshot[0].state.availability).toBe("disabled");
  });
});
