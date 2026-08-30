import { beforeEach, describe, expect, it } from "vitest";
import {
  createOpenFileTodoScanner,
  findBookmarkByMnemonic,
  markWorkspaceBookmarksMissingForFile,
  mergeWorkspaceBookmarkSnapshot,
  renameWorkspaceBookmarkGroup,
  readWorkspaceBookmarks,
  removeBookmarksForFile,
  restoreWorkspaceBookmarksForFile,
  scanTodosInText,
  sameWorkspaceTodoItems,
  setMnemonicBookmark,
  toggleWorkspaceBookmark,
  updateBookmarksOnPathRename,
  writeWorkspaceBookmarks,
  type WorkspaceBookmark,
} from "./todoBookmarks";

describe("todoBookmarks", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("scans TODO/FIXME markers with positions", () => {
    const items = scanTodosInText(
      "root:app:src/main.ts",
      "app / src/main.ts",
      [
        "export function run() {",
        "  // TODO: implement feature",
        "  // FIXME remove hack",
        "  const x = 1; // not a marker",
        "}",
      ].join("\n"),
    );
    expect(items.map((item) => item.kind)).toEqual(["TODO", "FIXME"]);
    expect(items[0].line).toBe(1);
    expect(items[0].text).toContain("implement feature");
    expect(items[1].line).toBe(2);
  });

  it("toggles bookmarks for the same file/line", () => {
    const first = toggleWorkspaceBookmark("ws", {
      fileKey: "root:app:a.ts",
      pathLabel: "app / a.ts",
      line: 3,
      character: 0,
      label: "entry",
    });
    expect(first).toHaveLength(1);
    expect(readWorkspaceBookmarks("ws")).toHaveLength(1);
    const second = toggleWorkspaceBookmark(
      "ws",
      {
        fileKey: "root:app:a.ts",
        pathLabel: "app / a.ts",
        line: 3,
        character: 0,
        label: "entry",
      },
      first,
    );
    expect(second).toHaveLength(0);
  });

  it("caches unchanged open buffers while still updating the edited buffer", () => {
    const scanner = createOpenFileTodoScanner();
    const first = scanner.scan([
      { key: "a", pathLabel: "a.ts", text: "// TODO: first" },
      { key: "b", pathLabel: "b.ts", text: "// FIXME: second" },
    ]);
    const second = scanner.scan([
      { key: "a", pathLabel: "a.ts", text: "// TODO: changed" },
      { key: "b", pathLabel: "b.ts", text: "// FIXME: second" },
    ]);

    expect(second).toHaveLength(2);
    expect(second.find((item) => item.fileKey === "a")?.text).toBe("changed");
    expect(second.find((item) => item.fileKey === "b")).toBe(first.find((item) => item.fileKey === "b"));
    expect(sameWorkspaceTodoItems(first, second)).toBe(false);
    expect(sameWorkspaceTodoItems(second, scanner.scan([
      { key: "a", pathLabel: "a.ts", text: "// TODO: changed" },
      { key: "b", pathLabel: "b.ts", text: "// FIXME: second" },
    ]))).toBe(true);
  });

  it("supports mnemonic bookmarks with conflict replacement", () => {
    // Set mnemonic 1 on line 10
    const b1 = setMnemonicBookmark("ws", {
      fileKey: "a.ts",
      pathLabel: "a.ts",
      line: 10,
      character: 0,
      label: "line 10",
      mnemonic: "1",
    });
    expect(b1).toHaveLength(1);
    expect(b1[0].mnemonic).toBe("1");
    expect(findBookmarkByMnemonic(b1, "1")?.line).toBe(10);

    // Set mnemonic 1 on line 20 (conflict replacement: removes mnemonic from line 10)
    const b2 = setMnemonicBookmark(
      "ws",
      {
        fileKey: "a.ts",
        pathLabel: "a.ts",
        line: 20,
        character: 0,
        label: "line 20",
        mnemonic: "1",
      },
      b1,
    );
    expect(b2).toHaveLength(2);
    const line20 = b2.find((b) => b.line === 20);
    const line10 = b2.find((b) => b.line === 10);
    expect(line20?.mnemonic).toBe("1");
    expect(line10?.mnemonic).toBeNull();
    expect(findBookmarkByMnemonic(b2, "1")?.line).toBe(20);

    // Toggling exact line with same mnemonic removes it
    const b3 = setMnemonicBookmark(
      "ws",
      {
        fileKey: "a.ts",
        pathLabel: "a.ts",
        line: 20,
        character: 0,
        label: "line 20",
        mnemonic: "1",
      },
      b2,
    );
    expect(b3).toHaveLength(1);
    expect(b3.find((b) => b.line === 20)).toBeUndefined();
  });

  it("updates bookmarks on file rename and file deletion", () => {
    const initial = toggleWorkspaceBookmark("ws", {
      fileKey: "old/path.ts",
      pathLabel: "old/path.ts",
      line: 5,
      character: 0,
      label: "entry",
    });

    const renamed = updateBookmarksOnPathRename(initial, "old/path.ts", "new/path.ts", "new/path.ts");
    expect(renamed[0].fileKey).toBe("new/path.ts");
    expect(renamed[0].pathLabel).toBe("new/path.ts");

    const deleted = removeBookmarksForFile(renamed, "new/path.ts");
    expect(deleted).toHaveLength(0);
  });

  it("persists group renames without changing bookmark identity", () => {
    const initial = [
      ...toggleWorkspaceBookmark("ws", {
        fileKey: "root:app:a.ts",
        pathLabel: "app / a.ts",
        line: 3,
        character: 0,
        label: "entry",
        group: "Review",
      }),
      ...toggleWorkspaceBookmark("ws", {
        fileKey: "root:app:b.ts",
        pathLabel: "app / b.ts",
        line: 7,
        character: 0,
        label: "second",
        group: "Review",
      }, []),
    ];
    writeWorkspaceBookmarks("ws", initial);

    const renamed = renameWorkspaceBookmarkGroup("ws", "Review", "Release", initial);

    expect(renamed).toHaveLength(2);
    expect(renamed.map((bookmark) => bookmark.id)).toEqual(initial.map((bookmark) => bookmark.id));
    expect(renamed.every((bookmark) => bookmark.group === "Release")).toBe(true);
    expect(readWorkspaceBookmarks("ws")).toEqual(renamed);
  });

  it("keeps deleted bookmark identities visible and restores them on recreation", () => {
    const initial = setMnemonicBookmark("ws", {
      fileKey: "root:app:src/main.ts",
      pathLabel: "app / src/main.ts",
      line: 4,
      character: 2,
      label: "target",
      mnemonic: "m",
    });
    const missing = markWorkspaceBookmarksMissingForFile(initial, "root:app:src/main.ts");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      id: initial[0]?.id,
      state: "missing",
      mnemonic: "M",
    });

    writeWorkspaceBookmarks("ws", missing);
    const restored = restoreWorkspaceBookmarksForFile(
      readWorkspaceBookmarks("ws"),
      "root:app:src/main.ts",
      "app / src/main.ts",
    );
    expect(restored[0]).toMatchObject({
      id: initial[0]?.id,
      state: "current",
      pathLabel: "app / src/main.ts",
    });
  });

  it("merges only affected bookmark identities during workspace undo/redo", () => {
    const unaffected: WorkspaceBookmark = {
      id: "unaffected",
      fileKey: "root:app:other.ts",
      pathLabel: "app / other.ts",
      line: 1,
      character: 0,
      label: "leave alone",
      mnemonic: null,
      group: "General",
      state: "current",
      createdAt: 1,
    };
    const changed: WorkspaceBookmark = {
      ...unaffected,
      id: "changed",
      fileKey: "root:app:main.ts",
      pathLabel: "app / main.ts",
      label: "before",
    };
    const snapshot: WorkspaceBookmark = {
      ...changed,
      label: "after",
      state: "missing",
    };
    const addedBySnapshot: WorkspaceBookmark = {
      ...changed,
      id: "added-by-snapshot",
      line: 9,
      label: "new bookmark",
    };

    const merged = mergeWorkspaceBookmarkSnapshot(
      [unaffected, { ...changed, label: "live" }],
      [snapshot, addedBySnapshot],
      ["changed", "added-by-snapshot"],
    );

    expect(merged).toEqual([unaffected, snapshot, addedBySnapshot]);
  });
});
