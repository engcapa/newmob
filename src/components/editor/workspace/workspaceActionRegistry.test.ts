import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ACTIONS,
  workspaceActionRegistry,
} from "./workspaceActionRegistry";

describe("workspaceActionRegistry", () => {
  beforeEach(() => {
    workspaceActionRegistry.clear();
  });

  it("registers and retrieves workspace actions", () => {
    const unregister = workspaceActionRegistry.register({
      id: "test.action",
      title: "Test Action",
      category: "Edit",
      provenance: "local",
      run: () => {},
    });

    expect(workspaceActionRegistry.get("test.action")?.title).toBe("Test Action");
    expect(workspaceActionRegistry.getByCategory("Edit").length).toBe(1);

    unregister();
    expect(workspaceActionRegistry.get("test.action")).toBeUndefined();
  });

  it("searches registered actions by keyword, title, and keybinding", () => {
    for (const def of DEFAULT_WORKSPACE_ACTIONS) {
      workspaceActionRegistry.register({
        ...def,
        run: () => {},
      });
    }

    const reformatMatches = workspaceActionRegistry.search("reformat");
    expect(reformatMatches.some((a) => a.id === "workspace.formatDocument")).toBe(true);

    const f2Matches = workspaceActionRegistry.search("F2");
    expect(f2Matches.some((a) => a.id === "workspace.nextDiagnostic")).toBe(true);

    const refactorCategory = workspaceActionRegistry.getByCategory("Refactor");
    expect(refactorCategory.length).toBeGreaterThanOrEqual(3);
  });
});
