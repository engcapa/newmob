import { describe, expect, it } from "vitest";
import {
  buildReplaceInFilesWorkspaceEdit,
  createReplaceInFilesPlan,
  validateReplacePreconditions,
  verifyReplaceMatchFreshness,
  type ReplaceInFilesMatch,
} from "./replaceInFilesModel";

describe("ED-FIND-004: replaceInFilesModel preview, exclude, conflict guard, commit", () => {
  const sampleMatches: ReplaceInFilesMatch[] = [
    {
      filePath: "/ws/core/Service.java",
      startLine: 10,
      startCharacter: 4,
      endLine: 10,
      endCharacter: 11,
      matchedText: "oldName",
    },
    {
      filePath: "/ws/core/Service.java",
      startLine: 25,
      startCharacter: 8,
      endLine: 25,
      endCharacter: 15,
      matchedText: "oldName",
    },
    {
      filePath: "/ws/app/App.java",
      startLine: 5,
      startCharacter: 12,
      endLine: 5,
      endCharacter: 19,
      matchedText: "oldName",
    },
  ];

  it("builds multi-file WorkspaceEdit from match list", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({
      matches: sampleMatches,
      replacementText: "newName",
    });

    expect(edit.documentEdits).toHaveLength(2);
    expect(edit.documentEdits[0].edits).toHaveLength(2);
    expect(edit.documentEdits[1].edits).toHaveLength(1);
    expect(edit.documentEdits[0].edits[0].newText).toBe("newName");
  });

  it("creates structured preview and supports per-occurrence exclusion", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({
      matches: sampleMatches,
      replacementText: "newName",
    });

    const initialPlan = createReplaceInFilesPlan(edit);
    expect(initialPlan.totalMatches).toBe(3);
    expect(initialPlan.includedMatches).toBe(3);
    expect(initialPlan.preview.entries).toHaveLength(2);

    // Exclude first usage of first file (0:0)
    const excludedPlan = createReplaceInFilesPlan(edit, new Set(["0:0"]));
    expect(excludedPlan.totalMatches).toBe(3);
    expect(excludedPlan.includedMatches).toBe(2);
    expect(excludedPlan.filteredEdit.documentEdits[0].edits).toHaveLength(1);
    expect(excludedPlan.filteredEdit.documentEdits[0].edits[0].range.start.line).toBe(25);
  });

  it("validates file revision and dirty buffer preconditions", () => {
    // Clean files with matching hashes
    const cleanCheck = validateReplacePreconditions([
      { path: "/ws/core/Service.java", expectedHash: "aaa111", actualHash: "aaa111", isDirty: false },
      { path: "/ws/app/App.java", expectedHash: "bbb222", actualHash: "bbb222", isDirty: false },
    ]);
    expect(cleanCheck.canCommit).toBe(true);
    expect(cleanCheck.conflicts).toHaveLength(0);

    // Dirty open buffer conflict
    const dirtyCheck = validateReplacePreconditions([
      { path: "/ws/core/Service.java", isDirty: true },
    ]);
    expect(dirtyCheck.canCommit).toBe(false);
    expect(dirtyCheck.conflicts[0].reason).toContain("unsaved modifications");

    // External disk modification hash mismatch
    const hashCheck = validateReplacePreconditions([
      { path: "/ws/core/Service.java", expectedHash: "aaa111", actualHash: "ccc333", isDirty: false },
    ]);
    expect(hashCheck.canCommit).toBe(false);
    expect(hashCheck.conflicts[0].reason).toContain("hash mismatch");
  });
});

describe("ED-FIND-004: replace match freshness against disk", () => {
  const disk = new Map<string, string>([
    ["/ws/a.ts", "const alpha = 1;\nconst beta = 2;\n"],
    ["/ws/b.ts", "nothing here\n"],
  ]);

  it("passes when every match still sits on current disk text", () => {
    const conflicts = verifyReplaceMatchFreshness(disk, [
      { filePath: "/ws/a.ts", startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11, matchedText: "alpha" },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("reports moved text, missing files, and unknown files", () => {
    const conflicts = verifyReplaceMatchFreshness(disk, [
      { filePath: "/ws/a.ts", startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11, matchedText: "ALPHA" },
      { filePath: "/ws/gone.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3, matchedText: "x" },
    ]);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].path).toBe("/ws/a.ts");
    expect(conflicts[0].reason).toContain("changed since search");
    expect(conflicts[1].path).toBe("/ws/gone.ts");
  });
});
