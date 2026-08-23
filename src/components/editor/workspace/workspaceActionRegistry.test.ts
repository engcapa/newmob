import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ACTIONS,
  workspaceActionRegistry,
  compileWhenExpr,
} from "./workspaceActionRegistry";

describe("workspaceActionRegistry", () => {
  beforeEach(() => {
    workspaceActionRegistry.clear();
  });

  it("registers and retrieves workspace actions with aliases", () => {
    const unregister = workspaceActionRegistry.register({
      id: "workspace.format",
      title: "Reformat Code",
      category: "Edit",
      provenance: "provider",
      run: () => {},
    });

    expect(workspaceActionRegistry.get("workspace.format")?.title).toBe("Reformat Code");
    // Alias lookup
    expect(workspaceActionRegistry.get("workspace.formatDocument")?.title).toBe("Reformat Code");
    expect(workspaceActionRegistry.getByCategory("Edit").length).toBe(1);

    unregister();
    expect(workspaceActionRegistry.get("workspace.format")).toBeUndefined();
  });

  it("evaluates structured WhenExpr AST conditions accurately", () => {
    const whenEditorAndSelection = compileWhenExpr({
      type: "all",
      exprs: [
        { type: "focusIs", target: "editor" },
        { type: "hasSelection" },
      ],
    });

    expect(whenEditorAndSelection({ focus: "editor", hasSelection: true })).toBe(true);
    expect(whenEditorAndSelection({ focus: "editor", hasSelection: false })).toBe(false);
    expect(whenEditorAndSelection({ focus: "tree", hasSelection: true })).toBe(false);

    const whenAnyFocus = compileWhenExpr({
      type: "any",
      exprs: [
        { type: "focusIs", target: "tree" },
        { type: "focusIs", target: "terminal" },
      ],
    });

    expect(whenAnyFocus({ focus: "tree" })).toBe(true);
    expect(whenAnyFocus({ focus: "terminal" })).toBe(true);
    expect(whenAnyFocus({ focus: "editor" })).toBe(false);
  });

  it("evaluates string when expressions", () => {
    const expr = compileWhenExpr("editorTextFocus && hasSelection");
    expect(expr({ focus: "editor", hasSelection: true })).toBe(true);
    expect(expr({ focus: "editor", hasSelection: false })).toBe(false);
    expect(expr({ focus: "tree", hasSelection: true })).toBe(false);
  });

  it("computes action states with disabled reasons", () => {
    workspaceActionRegistry.register({
      id: "workspace.save",
      title: "Save File",
      category: "File",
      provenance: "local",
      when: { type: "isDirty" },
      run: () => {},
    });

    const stateClean = workspaceActionRegistry.getState("workspace.save", { focus: "editor", isDirty: false });
    expect(stateClean.availability).toBe("disabled");

    const stateDirty = workspaceActionRegistry.getState("workspace.save", { focus: "editor", isDirty: true });
    expect(stateDirty.availability).toBe("available");
  });

  it("searches registered actions by keyword, title, and keybinding", () => {
    for (const def of DEFAULT_WORKSPACE_ACTIONS) {
      workspaceActionRegistry.register({
        ...def,
        run: () => {},
      });
    }

    const reformatMatches = workspaceActionRegistry.search("reformat");
    expect(reformatMatches.some((a) => a.id === "workspace.format" || a.id === "workspace.formatDocument")).toBe(true);

    const f2Matches = workspaceActionRegistry.search("F2");
    expect(f2Matches.some((a) => a.id === "workspace.nextError" || a.id === "workspace.nextDiagnostic")).toBe(true);

    const refactorCategory = workspaceActionRegistry.getByCategory("Refactor");
    expect(refactorCategory.length).toBeGreaterThanOrEqual(5);
  });

  it("notifies listeners on state changes and registrations", () => {
    let callCount = 0;
    const unsub = workspaceActionRegistry.subscribe(() => {
      callCount += 1;
    });

    workspaceActionRegistry.register({
      id: "test.event",
      title: "Event Test",
      category: "Help",
      provenance: "local",
      run: () => {},
    });

    expect(callCount).toBe(1);
    unsub();
  });

  it("restores previous owner action when top owner unregisters", () => {
    const unregisterA = workspaceActionRegistry.register({
      id: "workspace.toggleCase",
      title: "Toggle Case (Workspace A)",
      category: "Edit",
      provenance: "local",
      run: () => {},
    });

    expect(workspaceActionRegistry.get("workspace.toggleCase")?.title).toBe("Toggle Case (Workspace A)");

    const unregisterB = workspaceActionRegistry.register({
      id: "workspace.toggleCase",
      title: "Toggle Case (Workspace B)",
      category: "Edit",
      provenance: "local",
      run: () => {},
    });

    expect(workspaceActionRegistry.get("workspace.toggleCase")?.title).toBe("Toggle Case (Workspace B)");

    // Unregister B: should restore A
    unregisterB();
    expect(workspaceActionRegistry.get("workspace.toggleCase")?.title).toBe("Toggle Case (Workspace A)");

    // Unregister A: should remove
    unregisterA();
    expect(workspaceActionRegistry.get("workspace.toggleCase")).toBeUndefined();
  });

  it("treats recentChangedFiles as distinct from recentLocations", () => {
    let recentLocationsCalled = false;
    let recentChangedFilesCalled = false;

    workspaceActionRegistry.register({
      id: "workspace.recentLocations",
      title: "Recent Locations",
      category: "Navigation",
      provenance: "local",
      run: () => {
        recentLocationsCalled = true;
      },
    });

    workspaceActionRegistry.register({
      id: "workspace.recentChangedFiles",
      title: "Recently Changed Files",
      category: "Navigation",
      provenance: "local",
      run: () => {
        recentChangedFilesCalled = true;
      },
    });

    expect(workspaceActionRegistry.resolveId("workspace.recentChangedFiles")).toBe("workspace.recentChangedFiles");
    expect(workspaceActionRegistry.get("workspace.recentChangedFiles")?.title).toBe("Recently Changed Files");

    void workspaceActionRegistry.run("workspace.recentChangedFiles", { focus: "editor" });
    expect(recentChangedFilesCalled).toBe(true);
    expect(recentLocationsCalled).toBe(false);
  });

  it("emits registered event when unregister restores previous action definition", () => {
    const events: Array<{ type: string; actionId?: string }> = [];
    const unsub = workspaceActionRegistry.subscribe((e) => {
      events.push(e);
    });

    const unregA = workspaceActionRegistry.register({
      id: "test.action",
      title: "Action A",
      category: "Help",
      provenance: "local",
      run: () => {},
    });

    const unregB = workspaceActionRegistry.register({
      id: "test.action",
      title: "Action B",
      category: "Help",
      provenance: "local",
      run: () => {},
    });

    events.length = 0;
    // Unregister B: should restore A and emit both registered and state-changed
    unregB();

    expect(events.some((e) => e.type === "registered" && e.actionId === "test.action")).toBe(true);
    expect(events.some((e) => e.type === "state-changed" && e.actionId === "test.action")).toBe(true);

    unregA();
    unsub();
  });
});

