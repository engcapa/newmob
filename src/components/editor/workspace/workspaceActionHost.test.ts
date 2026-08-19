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

  it("builds context with correct focus precedence and clean payload (Gate R0)", () => {
    const defaultCtx: Partial<WorkspaceActionContext> = { hasActiveFile: true };
    const mockTreeElement = { id: "tree-node" } as unknown as EventTarget;
    const mockTerminalElement = { id: "term" } as unknown as EventTarget;

    const host = new WorkspaceActionHost({
      workspaceId: "ws-test",
      getDefaultContext: () => defaultCtx,
      getDefaultFocus: () => "workspace",
      resolveFocus: (target) => {
        if (target === mockTreeElement) return "tree";
        if (target === mockTerminalElement) return "terminal";
        return "workspace";
      },
    });

    // 1. Default context with no invocation
    const ctx1 = host.buildContext();
    expect(ctx1.focus).toBe("workspace");
    expect(ctx1.hasActiveFile).toBe(true);

    // 2. Event target derived focus
    const ctx2 = host.buildContext({ eventTarget: mockTreeElement });
    expect(ctx2.focus).toBe("tree");

    // 3. Explicit context overrides eventTarget
    const ctx3 = host.buildContext({
      context: { focus: "editor" },
      eventTarget: mockTreeElement,
      payload: { rootId: "root-1", path: "src/index.ts" },
    });
    expect(ctx3.focus).toBe("editor");
    expect(ctx3.payload).toEqual({ rootId: "root-1", path: "src/index.ts" });

    // 4. Legacy wrapped object { focus: "tree", payload: { rootId: "r", path: "p" } }
    const ctx4 = host.buildContext({
      focus: "tree",
      payload: { rootId: "r", path: "p" },
    });
    expect(ctx4.focus).toBe("tree");
    expect(ctx4.payload).toEqual({ rootId: "r", path: "p" });
  });

  it("handles editor-only, tree-gated, and format commands with focus matrix (Gate R0)", async () => {
    let currentFocus: "workspace" | "editor" | "tree" | "terminal" = "workspace";
    const host = new WorkspaceActionHost({
      workspaceId: "ws-matrix",
      getDefaultContext: () => ({ focus: currentFocus, hasActiveFile: true }),
      getDefaultFocus: () => currentFocus,
    });

    const renameMock = vi.fn();
    const copyPathMock = vi.fn();
    const formatMock = vi.fn();

    // Editor-only command (Shift+F6)
    host.registerAction({
      id: "editor.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      provenance: "local",
      when: (ctx) => ctx.focus === "editor" && !!ctx.hasActiveFile,
      run: renameMock,
    });

    // Tree-gated command
    host.registerAction({
      id: "workspace.tree.copyPath",
      title: "Copy Path",
      category: "File",
      provenance: "local",
      when: (ctx) => ctx.focus === "tree",
      run: (ctx) => {
        copyPathMock(ctx.payload);
        return { kind: "applied" };
      },
    });

    // Format command with negative focus guard
    host.registerAction({
      id: "workspace.format",
      title: "Reformat Code",
      category: "Edit",
      provenance: "local",
      when: (ctx) => ctx.focus !== "tree" && ctx.focus !== "terminal" && !!ctx.hasActiveFile,
      run: formatMock,
    });

    // Case A: Tree focus
    currentFocus = "tree";
    expect(host.getState("editor.renameSymbol").availability).toBe("disabled");
    expect(host.getState("workspace.tree.copyPath").availability).toBe("available");
    expect(host.getState("workspace.format").availability).toBe("disabled");

    const copyRes = await host.execute("workspace.tree.copyPath", {
      focus: "tree",
      payload: { rootId: "rootA", path: "src/main.rs" },
    });
    expect(copyRes.kind).toBe("applied");
    expect(copyPathMock).toHaveBeenCalledWith({ rootId: "rootA", path: "src/main.rs" });

    // Case B: Terminal focus
    currentFocus = "terminal";
    expect(host.getState("editor.renameSymbol").availability).toBe("disabled");
    expect(host.getState("workspace.format").availability).toBe("disabled");

    // Case C: Editor focus
    currentFocus = "editor";
    expect(host.getState("editor.renameSymbol").availability).toBe("available");
    expect(host.getState("workspace.tree.copyPath").availability).toBe("disabled");
    expect(host.getState("workspace.format").availability).toBe("available");

    const renameRes = await host.execute("editor.renameSymbol");
    expect(renameRes.kind).toBe("applied");
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("handles disposal gracefully without throwing (Gate R0)", async () => {
    const host = new WorkspaceActionHost({
      workspaceId: "ws-dispose",
      getDefaultContext: () => ({ focus: "editor" }),
    });

    host.registerAction({
      id: "test.action",
      title: "Test Action",
      category: "Edit",
      provenance: "local",
      run: () => ({ kind: "applied" }),
    });

    expect(host.isDisposed()).toBe(false);
    host.dispose();
    expect(host.isDisposed()).toBe(true);

    const res = await host.execute("test.action");
    expect(res.kind).toBe("failed");
    expect((res as any).message).toContain("disposed");

    const keydownRes = await host.dispatchKeydown({
      key: "a",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(keydownRes).toBeNull();
  });
});
