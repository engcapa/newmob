import { describe, expect, it } from "vitest";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";
import {
  buildWorkspaceEditPreview,
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
});
