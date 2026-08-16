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
});
