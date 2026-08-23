import { describe, expect, it, vi } from "vitest";
import {
  workspaceCommandMatchesKeybinding,
  workspaceCommandToActionDefinition,
  type WorkspaceCommand,
} from "./workspaceCommands";
import { WorkspaceActionHost } from "./workspaceActionHost";

function command(overrides: Partial<WorkspaceCommand> = {}): WorkspaceCommand {
  return {
    id: "workspace.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "Ctrl+Shift+F",
    run: vi.fn(),
    ...overrides,
  };
}

describe("workspaceCommands", () => {
  it("matches exact modifier combinations, named arrows, and Numpad operators", () => {
    expect(workspaceCommandMatchesKeybinding(command(), {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    })).toBe(true);
    expect(workspaceCommandMatchesKeybinding(command(), {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: false,
    })).toBe(false);
    expect(workspaceCommandMatchesKeybinding(command({ keybinding: "Ctrl+Alt+Left" }), {
      key: "ArrowLeft",
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      metaKey: false,
    })).toBe(true);
    // Windows WebView2 can report unreliable event.key under Alt; fall back to code.
    expect(workspaceCommandMatchesKeybinding(command({ keybinding: "Ctrl+Alt+Left" }), {
      key: "Unidentified",
      code: "ArrowLeft",
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      metaKey: false,
    })).toBe(true);
    expect(workspaceCommandMatchesKeybinding(command({ keybinding: "Ctrl+Shift+NumpadAdd" }), {
      key: "+",
      code: "NumpadAdd",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    })).toBe(true);
  });

  it("registers commands into a host and executes by id with context gating", async () => {
    const run = vi.fn();
    const editorOnly = command({
      id: "editor-only",
      when: (context) => context.focus === "editor",
      run,
    });
    const host = new WorkspaceActionHost({ workspaceId: "ws-1" });
    host.registerCommands([editorOnly]);

    expect((await host.execute("editor-only", { focus: "tree" })).kind).toBe("no-op");
    const applied = await host.execute("editor-only", { focus: "editor" });
    expect(applied.kind).toBe("applied");
    expect(run).toHaveBeenCalledOnce();
  });

  it("forwards optional payload through the host (tree selection targets)", async () => {
    const run = vi.fn();
    const treeOpen = command({
      id: "workspace.tree.open",
      when: (context) => context.focus === "tree",
      run,
    });
    const payload = {
      selection: { kind: "file" as const, ref: { kind: "root" as const, rootId: "r1", path: "src/a.ts" } },
    };
    const host = new WorkspaceActionHost({ workspaceId: "ws-1" });
    host.registerCommands([treeOpen]);

    await host.execute("workspace.tree.open", { focus: "tree", payload });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ focus: "tree", payload }));
  });

  it("adapts commands into action definitions with default provenance", () => {
    const definition = workspaceCommandToActionDefinition(command({ id: "workspace.probe" }));
    expect(definition.id).toBe("workspace.probe");
    expect(definition.keybinding).toBe("Ctrl+Shift+F");
    expect(definition.run).toBeTypeOf("function");
  });

  it("adapts boolean command outcomes into typed action results", async () => {
    const definition = workspaceCommandToActionDefinition(command({
      id: "workspace.noop",
      run: () => false,
    }));
    expect(await definition.run({ focus: "workspace" })).toEqual({
      kind: "no-op",
      reason: "condition-not-met",
    });
  });

  it("dispatches keydown through the host and consumes the event", async () => {
    const run = vi.fn();
    const host = new WorkspaceActionHost({ workspaceId: "ws-1" });
    host.registerCommands([command({ run })]);
    const event = {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    const dispatched = await host.dispatchKeydown(event);
    expect(dispatched?.id).toBe("workspace.findInFiles");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
});
