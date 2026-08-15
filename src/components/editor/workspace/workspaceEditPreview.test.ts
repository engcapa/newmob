import { describe, expect, it } from "vitest";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";
import {
  buildWorkspaceEditPreview,
  filterWorkspaceEditByUsages,
  formatWorkspaceEditPreview,
  workspaceEditOperations,
} from "./workspaceEditPreview";

function textEdit(path: string, newText = "next") {
  return {
    uri: `file://${path}`,
    path,
    edits: [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      newText,
    }],
  };
}

describe("workspaceEditPreview", () => {
  it("retains ordered operations and summarizes resource paths", () => {
    const edit: LspWorkspaceEdit = {
      documentEdits: [],
      operations: [
        { kind: "text", document: textEdit("/repo/a.ts") },
        {
          kind: "rename",
          oldUri: "file:///repo/a.ts",
          oldPath: "/repo/a.ts",
          newUri: "file:///repo/b.ts",
          newPath: "/repo/b.ts",
          overwrite: false,
          ignoreIfExists: false,
          annotationId: "rename",
        },
        {
          kind: "delete",
          uri: "file:///repo/c.ts",
          path: "/repo/c.ts",
          recursive: false,
          ignoreIfNotExists: true,
          annotationId: null,
        },
      ],
      changeAnnotations: [{
        id: "rename",
        label: "Rename generated file",
        needsConfirmation: true,
        description: "The server will update imports.",
      }],
    };

    const preview = buildWorkspaceEditPreview(edit, { label: "Refactor" });
    expect(workspaceEditOperations(edit)).toHaveLength(3);
    expect(preview.label).toBe("Refactor");
    expect(preview.operationCount).toBe(3);
    expect(preview.affectedFileCount).toBe(3);
    expect(preview.textEditCount).toBe(1);
    expect(preview.resourceOperationCount).toBe(2);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.entries[1]).toMatchObject({
      kind: "rename",
      path: "/repo/a.ts",
      secondaryPath: "/repo/b.ts",
      annotationLabel: "Rename generated file",
    });
    expect(preview.annotations[0]?.label).toBe("Rename generated file");
  });

  it("does not require confirmation for a single-file text edit", () => {
    const preview = buildWorkspaceEditPreview({ documentEdits: [textEdit("/repo/a.ts")] });
    expect(preview.affectedFileCount).toBe(1);
    expect(preview.requiresConfirmation).toBe(false);
    expect(formatWorkspaceEditPreview(preview)).toContain("1 file affected");
  });

  it("limits long previews while retaining the omitted operation count", () => {
    const edit: LspWorkspaceEdit = {
      documentEdits: Array.from({ length: 4 }, (_, index) => textEdit(`/repo/${index}.ts`)),
    };
    const message = formatWorkspaceEditPreview(buildWorkspaceEditPreview(edit), { maxEntries: 2 });
    expect(message).toContain("...and 2 more operations.");
    expect(message).toContain("1. Edit /repo/0.ts");
    expect(message).not.toContain("3. Edit /repo/2.ts");
  });

  it("extracts individual usage items and filters workspace edits", () => {
    const edit: LspWorkspaceEdit = {
      documentEdits: [
        {
          uri: "file:///repo/a.ts",
          path: "/repo/a.ts",
          edits: [
            { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: "newName" },
            { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 3 } }, newText: "newName" },
          ],
        },
        {
          uri: "file:///repo/b.ts",
          path: "/repo/b.ts",
          edits: [
            { range: { start: { line: 5, character: 4 }, end: { line: 5, character: 7 } }, newText: "newName" },
          ],
        },
      ],
    };

    const preview = buildWorkspaceEditPreview(edit);
    expect(preview.usages).toHaveLength(3);
    expect(preview.usages[0]).toMatchObject({
      id: "0:0",
      path: "/repo/a.ts",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
      newText: "newName",
    });

    // Exclude usage "0:1" (the second edit in a.ts)
    const filtered = filterWorkspaceEditByUsages(edit, new Set(["0:1"]));
    expect(filtered.documentEdits[0].edits).toHaveLength(1);
    expect(filtered.documentEdits[0].edits[0].range.start.line).toBe(1);
    expect(filtered.documentEdits[1].edits).toHaveLength(1);

    // Exclude all edits in b.ts ("1:0")
    const filteredOutB = filterWorkspaceEditByUsages(edit, new Set(["1:0"]));
    expect(filteredOutB.documentEdits).toHaveLength(1);
    expect(filteredOutB.documentEdits[0].path).toBe("/repo/a.ts");
  });
});
