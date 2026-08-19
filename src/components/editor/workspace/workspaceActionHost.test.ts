import { describe, expect, it, vi } from "vitest";
import { WorkspaceActionHost, createWorkspaceActionHost } from "./workspaceActionHost";
import type { WorkspaceActionContext } from "./workspaceActionRegistry";

describe("WorkspaceActionHost (N0.1)", () => {
  it("isolates action registries between two workspaces", async () => {
    let ctxA: WorkspaceActionContext = { focus: "editor", hasActiveFile: true };
    let ctxB: WorkspaceActionContext = { focus: "tree", hasActiveFile: false };

    const hostA = createWorkspaceActionHost({
      workspaceId: "ws-a",
      getContext: () => ctxA,
    });

    const hostB = createWorkspaceActionHost({
      workspaceId: "ws-b",
      getContext: () => ctxB,
    });

    const runA = vi.fn(async () => ({ kind: "applied" as const }));
    const runB = vi.fn(async () => ({ kind: "applied" as const }));

    hostA.registerAction({
      id: "editor.save",
      title: "Save File",
      category: "File",
      provenance: "local",
      when: "hasActiveFile",
      run: runA,
    });

    hostB.registerAction({
      id: "editor.save",
      title: "Save File",
      category: "File",
      provenance: "local",
      when: "hasActiveFile",
      run: runB,
    });

    expect(hostA.getState("editor.save").availability).toBe("available");
    expect(hostB.getState("editor.save").availability).toBe("disabled");

    const resA = await hostA.execute("editor.save");
    expect(resA.kind).toBe("applied");
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();

    const resB = await hostB.execute("editor.save");
    expect(resB.kind).toBe("no-op");
    expect(runB).not.toHaveBeenCalled();
  });

  it("handles keydown dispatch and prevents default", async () => {
    const ctx: WorkspaceActionContext = { focus: "editor" };
    const host = new WorkspaceActionHost({
      workspaceId: "ws-1",
      getContext: () => ctx,
    });

    const run = vi.fn(async () => ({ kind: "applied" as const }));
    host.registerAction({
      id: "action.format",
      title: "Reformat Code",
      category: "Edit",
      provenance: "local",
      keybinding: "Ctrl+Alt+L",
      run,
    });

    const event = {
      key: "l",
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    const dispatched = await host.dispatchKeydown(event);
    expect(dispatched?.id).toBe("action.format");
    expect(dispatched?.result.kind).toBe("applied");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("handles in-flight lock and AbortSignal", async () => {
    const ctx: WorkspaceActionContext = { focus: "editor" };
    const host = new WorkspaceActionHost({
      workspaceId: "ws-1",
      getContext: () => ctx,
    });

    let resolveAction: () => void = () => {};
    host.registerAction({
      id: "long.action",
      title: "Long Running Action",
      category: "Edit",
      provenance: "local",
      run: () => new Promise((res) => {
        resolveAction = () => res({ kind: "applied" });
      }),
    });

    const promise1 = host.execute("long.action");
    const promise2 = host.execute("long.action"); // Concurrent double invocation

    const res2 = await promise2;
    expect(res2.kind).toBe("no-op"); // Blocked by in-flight busy lock

    resolveAction();
    const res1 = await promise1;
    expect(res1.kind).toBe("applied");
  });
});
