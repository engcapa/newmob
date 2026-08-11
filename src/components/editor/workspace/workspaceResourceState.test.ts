import { describe, expect, it } from "vitest";
import {
  transformWorkspaceResourceExpandedDirKeys,
  transformWorkspaceResourceFileKey,
  transformWorkspaceResourceFileRef,
  transformWorkspaceResourceTreeSelection,
  type WorkspaceResourceUiChange,
} from "./workspaceResourceState";

describe("workspaceResourceState", () => {
  it("removes every file and tree reference below a deleted path", () => {
    const change: WorkspaceResourceUiChange = {
      kind: "remove",
      target: { rootId: "r1", path: "src/generated" },
    };
    expect(transformWorkspaceResourceFileKey("root:r1:src/generated/a.ts", change)).toBeNull();
    expect(transformWorkspaceResourceFileKey("root:r1:src/main.ts", change)).toBe("root:r1:src/main.ts");
    expect(transformWorkspaceResourceExpandedDirKeys(new Set([
      "r1:src",
      "r1:src/generated",
      "r1:src/generated/nested",
      "r2:src/generated",
    ]), change)).toEqual(new Set(["r1:src", "r2:src/generated"]));
  });

  it("moves references between roots and drops overwritten destination references", () => {
    const change: WorkspaceResourceUiChange = {
      kind: "move",
      source: { rootId: "r1", path: "src/pkg" },
      destination: { rootId: "r2", path: "lib/pkg" },
    };
    expect(transformWorkspaceResourceFileRef({
      kind: "root",
      rootId: "r1",
      path: "src/pkg/A.java",
    }, change)).toEqual({ kind: "root", rootId: "r2", path: "lib/pkg/A.java" });
    expect(transformWorkspaceResourceFileKey("root:r2:lib/pkg/old.ts", change)).toBeNull();
    expect(transformWorkspaceResourceTreeSelection({
      kind: "dir",
      rootId: "r1",
      path: "src/pkg/internal",
    }, change)).toEqual({ kind: "dir", rootId: "r2", path: "lib/pkg/internal" });
  });

  it("treats a same-path move as a no-op instead of removing the source", () => {
    const change: WorkspaceResourceUiChange = {
      kind: "move",
      source: { rootId: "r1", path: "src/a.ts" },
      destination: { rootId: "r1", path: "src/a.ts" },
    };
    expect(transformWorkspaceResourceFileKey("root:r1:src/a.ts", change)).toBe("root:r1:src/a.ts");
  });
});
