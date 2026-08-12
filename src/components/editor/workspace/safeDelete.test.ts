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

  it("ignores virtual references that have no filesystem path", () => {
    const result = buildSafeDeleteWorkspaceEdit({
      uri: "file:///repo/a.ts",
      path: "/repo/a.ts",
      range: range(0, 0, 1),
    }, [{ uri: "jdt://contents/String.class", path: null, range: range(1, 0, 1) }]);
    expect(result.locations).toHaveLength(1);
    expect(result.usageCount).toBe(0);
  });
});
