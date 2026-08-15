import { describe, expect, it } from "vitest";
import type { LspWorkspaceEditOperation } from "../../../lib/editor/lsp";
import { validateSemanticWorkspaceEditPaths } from "./semanticWorkspaceEdit";

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

function text(path: string | null): LspWorkspaceEditOperation {
  return {
    kind: "text",
    document: { uri: path ? `file://${path}` : "untitled:buffer", path, edits: [{ range, newText: "x" }] },
  };
}

function rename(oldPath: string | null, newPath: string | null): LspWorkspaceEditOperation {
  return {
    kind: "rename",
    oldUri: oldPath ? `file://${oldPath}` : "untitled:old",
    oldPath,
    newUri: newPath ? `file://${newPath}` : "untitled:new",
    newPath,
    overwrite: false,
    ignoreIfExists: false,
    annotationId: null,
  };
}

describe("validateSemanticWorkspaceEditPaths", () => {
  it("accepts local edits across multiple workspace roots", () => {
    expect(validateSemanticWorkspaceEditPaths([
      text("/repo-a/src/a.ts"),
      rename("/repo-a/src/old.ts", "/repo-b/src/new.ts"),
    ], ["/repo-a", "/repo-b"])).toBeNull();
  });

  it("rejects dot-segment traversal before mutation", () => {
    expect(validateSemanticWorkspaceEditPaths([
      text("/repo/src/../../outside.ts"),
    ], ["/repo"])).toMatch(/outside the workspace.*\/outside\.ts/);
  });

  it("rejects missing, virtual, relative, and incomplete rename paths", () => {
    expect(validateSemanticWorkspaceEditPaths([text(null)], ["/repo"])).toMatch(/missing filesystem path/);
    expect(validateSemanticWorkspaceEditPaths([text("jdt://contents/String.class")], ["/repo"])).toMatch(/not an absolute local file/);
    expect(validateSemanticWorkspaceEditPaths([text("src/a.ts")], ["/repo"])).toMatch(/not an absolute local file/);
    expect(validateSemanticWorkspaceEditPaths([rename("/repo/a.ts", null)], ["/repo"])).toMatch(/missing filesystem path/);
  });

  it("handles Windows drive and UNC roots case-insensitively with component boundaries", () => {
    expect(validateSemanticWorkspaceEditPaths([
      text("c:\\REPO\\src\\..\\Main.java"),
    ], ["C:\\repo"])).toBeNull();
    expect(validateSemanticWorkspaceEditPaths([
      text("C:\\repository\\Main.java"),
    ], ["C:\\repo"])).toMatch(/outside the workspace/);
    expect(validateSemanticWorkspaceEditPaths([
      text("\\\\SERVER\\SHARE\\repo\\src\\Main.java"),
    ], ["\\\\server\\share\\repo"])).toBeNull();
  });
});
