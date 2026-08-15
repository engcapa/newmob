import { describe, expect, it } from "vitest";
import type { LspLocation } from "../../../lib/editor/lsp";
import { buildSafeDeleteWorkspaceEdit, safeDeleteFileCount } from "./safeDelete";

const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

describe("buildSafeDeleteWorkspaceEdit", () => {
  it("deduplicates the declaration and groups references by document", () => {
    const references: LspLocation[] = [
      { uri: "file:///repo/a.ts", path: "/repo/a.ts", range: range(0, 6, 11) },
      { uri: "file:///repo/b.ts", path: "/repo/b.ts", range: range(3, 2, 7) },
      { uri: "file:///repo/b.ts", path: "/repo/b.ts", range: range(9, 4, 9) },
    ];
    const result = buildSafeDeleteWorkspaceEdit({
      uri: "file:///repo/a.ts",
      path: "/repo/a.ts",
      range: range(0, 6, 11),
    }, references);

    expect(result.usageCount).toBe(2);
    expect(result.locations).toHaveLength(3);
    expect(result.edit.documentEdits).toHaveLength(2);
    expect(result.edit.documentEdits[1]?.edits).toHaveLength(2);
    expect(result.edit.documentEdits.flatMap((document) => document.edits).every((edit) => edit.newText === "")).toBe(true);
    expect(safeDeleteFileCount(result.locations)).toBe(2);
  });

  it("does not silently discard virtual references", () => {
    const result = buildSafeDeleteWorkspaceEdit({
      uri: "file:///repo/a.ts",
      path: "/repo/a.ts",
      range: range(0, 0, 1),
    }, [{ uri: "jdt://contents/String.class", path: null, range: range(1, 0, 1) }], {
      workspaceRoots: ["/repo"],
    });
    expect(result.locations).toHaveLength(1);
    expect(result.usageCount).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.unresolvedReferences).toHaveLength(1);
    expect(result.edit.operations).toHaveLength(0);
  });

  it("blocks references outside every workspace root", () => {
    const result = buildSafeDeleteWorkspaceEdit({
      uri: "file:///repo/a.ts",
      path: "/repo/a.ts",
      range: range(0, 0, 1),
    }, [{ uri: "file:///other/b.ts", path: "/other/b.ts", range: range(1, 0, 1) }], {
      workspaceRoots: ["/repo"],
    });
    expect(result.complete).toBe(false);
    expect(result.unresolvedReferences).toHaveLength(1);
    expect(result.diagnostics[0]).toMatch(/cannot be resolved/);
  });

  it("rejects a declaration outside the workspace before creating an edit", () => {
    const result = buildSafeDeleteWorkspaceEdit({
      uri: "file:///outside/a.ts",
      path: "/outside/a.ts",
      range: range(0, 0, 1),
    }, [], { workspaceRoots: ["/repo"] });
    expect(result.complete).toBe(false);
    expect(result.locations).toHaveLength(0);
    expect(result.edit.documentEdits).toHaveLength(0);
  });

  it("rejects lexical traversal that escapes a workspace root", () => {
    const reference: LspLocation = {
      uri: "file:///outside.ts",
      path: "/repo/src/../../outside.ts",
      range: range(1, 0, 1),
    };
    const result = buildSafeDeleteWorkspaceEdit({
      uri: "file:///repo/a.ts",
      path: "/repo/a.ts",
      range: range(0, 0, 1),
    }, [reference], { workspaceRoots: ["/repo"] });
    expect(result.complete).toBe(false);
    expect(result.unresolvedReferences).toEqual([reference]);
    expect(result.edit.operations).toHaveLength(0);
  });

  it("matches Windows drive and UNC roots case-insensitively", () => {
    const drive = buildSafeDeleteWorkspaceEdit({
      uri: "file:///C:/Repo/a.ts",
      path: "C:\\Repo\\a.ts",
      range: range(0, 0, 1),
    }, [{
      uri: "file:///c:/repo/src/b.ts",
      path: "c:\\repo\\src\\b.ts",
      range: range(1, 0, 1),
    }], { workspaceRoots: ["C:\\REPO"] });
    expect(drive.complete).toBe(true);
    expect(drive.edit.documentEdits).toHaveLength(2);

    const unc = buildSafeDeleteWorkspaceEdit({
      uri: "file://server/share/repo/a.ts",
      path: "\\\\SERVER\\SHARE\\repo\\a.ts",
      range: range(0, 0, 1),
    }, [], { workspaceRoots: ["\\\\server\\share\\repo"] });
    expect(unc.complete).toBe(true);
  });
});
