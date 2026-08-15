import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceEditHistory,
  buildWorkspacePathSnapshotEdit,
  buildWorkspaceTextSnapshotEdit,
} from "./workspaceEditHistory";

describe("WorkspaceEditHistory", () => {
  it("groups one multi-file transaction and moves it between stacks", async () => {
    const calls: string[] = [];
    const history = new WorkspaceEditHistory();
    history.push({
      id: "edit-1",
      label: "Rename symbol",
      affectedPaths: ["a.ts", "b.ts"],
      undo: async () => { calls.push("undo"); },
      redo: async () => { calls.push("redo"); },
    });

    expect(history.state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: "Rename symbol",
    });
    expect(await history.undo()).toMatchObject({ action: "undo" });
    expect(calls).toEqual(["undo"]);
    expect(history.state()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: "Rename symbol" });
    expect(await history.redo()).toMatchObject({ action: "redo" });
    expect(calls).toEqual(["undo", "redo"]);
  });

  it("keeps a failed action on its original stack", async () => {
    const undo = vi.fn(async () => { throw new Error("changed on disk"); });
    const history = new WorkspaceEditHistory();
    history.push({ id: "edit-1", label: "Format", affectedPaths: ["a.ts"], undo, redo: async () => {} });

    await expect(history.undo()).rejects.toThrow("changed on disk");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, busy: false });
  });

  it("clears redo when a new transaction is pushed and respects the limit", async () => {
    const history = new WorkspaceEditHistory(2);
    const entry = (id: string) => ({ id, label: id, affectedPaths: [], undo: async () => {}, redo: async () => {} });
    history.push(entry("one"));
    history.push(entry("two"));
    history.push(entry("three"));
    expect(history.state().undoLabel).toBe("three");
    await history.undo();
    expect(history.state().redoLabel).toBe("three");
    history.push(entry("four"));
    expect(history.state()).toMatchObject({ canRedo: false, undoLabel: "four" });
  });
});

describe("buildWorkspacePathSnapshotEdit", () => {
  it("restores rename-like path changes by deleting, creating, then writing", () => {
    const edit = buildWorkspacePathSnapshotEdit(
      [
        { path: "/repo/old.ts", exists: false, text: null },
        { path: "/repo/new.ts", exists: true, text: "new contents" },
      ],
      [
        { path: "/repo/old.ts", exists: true, text: "old contents" },
        { path: "/repo/new.ts", exists: false, text: null },
      ],
    );

    expect(edit.operations?.map((operation) => operation.kind)).toEqual([
      "delete",
      "create",
      "text",
    ]);
    expect(edit.documentEdits[0]?.edits[0]?.newText).toBe("old contents");
  });

  it("rejects directory or special-resource snapshots", () => {
    expect(() => buildWorkspacePathSnapshotEdit(
      [{ path: "/repo/src", exists: false, text: null }],
      [{ path: "/repo/src", exists: true, text: null }],
    )).toThrow("non-file resource");
  });
});

describe("buildWorkspaceTextSnapshotEdit", () => {
  it("creates full-document replacements with CRLF-aware positions", () => {
    const edit = buildWorkspaceTextSnapshotEdit(
      [
        { path: "/tmp/a.ts", text: "one\r\ntwo\r\n" },
        { path: "/tmp/b.ts", text: "single" },
      ],
      [
        { path: "/tmp/a.ts", text: "old" },
        { path: "/tmp/b.ts", text: "target" },
      ],
    );
    expect(edit.operations).toHaveLength(2);
    expect(edit.documentEdits[0]?.edits[0]?.range.end).toEqual({ line: 2, character: 0 });
    expect(edit.documentEdits[1]?.edits[0]?.range.end).toEqual({ line: 0, character: 6 });
  });
});
