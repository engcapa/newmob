import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultWorkspaceLayoutSnapshot,
  fileRefFromFileKey,
  normalizeWorkspaceLayoutSnapshot,
  pushWorkspaceSearchHistory,
  readWorkspaceLayoutSnapshot,
  readWorkspaceSearchHistory,
  uniqueOrderedKeys,
  writeWorkspaceLayoutSnapshot,
  type WorkspaceLayoutSnapshotV2,
} from "./workspaceLayoutPersistence";

describe("workspaceLayoutPersistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("normalizes and round-trips layout snapshots with schema v2", () => {
    const snapshot: WorkspaceLayoutSnapshotV2 = {
      version: 2,
      bottomDockOpen: false,
      bottomDockTab: "search",
      rightPaneOpen: true,
      rightPaneTab: "documentation",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "secondary",
      expandedRootIds: ["app"],
      expandedDirKeys: ["app:src"],
      layoutTreeV2: {
        type: "split",
        id: "split-1",
        orientation: "vertical",
        ratios: [0.5, 0.5],
        children: [
          { type: "leaf", id: "primary", openFileKeys: ["root:app:src/main.ts", "root:app:src/lib.ts"], activeKey: "root:app:src/main.ts" },
          { type: "leaf", id: "secondary", openFileKeys: ["root:app:README.md"], activeKey: "root:app:README.md" },
        ],
      },
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts", "root:app:src/lib.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: "root:app:src/lib.ts",
          pinnedKeys: ["root:app:src/main.ts"],
        },
        secondary: {
          openOrder: ["root:app:README.md"],
          activeKey: "root:app:README.md",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    };

    writeWorkspaceLayoutSnapshot("ws", snapshot);

    const restored = readWorkspaceLayoutSnapshot("ws");
    expect(restored?.version).toBe(2);
    expect(restored?.bottomDockOpen).toBe(false);
    expect(restored?.bottomDockTab).toBe("search");
    expect(restored?.rightPaneOpen).toBe(true);
    expect(restored?.splitOrientation).toBe("vertical");
    expect(restored?.layoutTreeV2.type).toBe("split");
    expect(restored?.editorGroups.primary.openOrder).toEqual([
      "root:app:src/main.ts",
      "root:app:src/lib.ts",
    ]);
    expect(restored?.editorGroups.secondary.activeKey).toBe("root:app:README.md");
  });

  it("falls back safely for invalid payloads", () => {
    const snapshot = normalizeWorkspaceLayoutSnapshot({
      bottomDockTab: "nope",
      splitOrientation: "diagonal",
      editorGroups: { primary: { openOrder: [1, "root:app:a.ts"], activeKey: "missing" } },
    });
    expect(snapshot.bottomDockTab).toBe(defaultWorkspaceLayoutSnapshot().bottomDockTab);
    expect(snapshot.splitOrientation).toBeNull();
    expect(snapshot.editorGroups.primary.openOrder).toEqual(["root:app:a.ts"]);
    expect(snapshot.editorGroups.primary.activeKey).toBe("root:app:a.ts");
    expect(snapshot.layoutTreeV2).toBeDefined();
  });

  it("parses file keys and dedupes restored open order", () => {
    expect(fileRefFromFileKey("root:app:src/main.ts")).toEqual({
      kind: "root",
      rootId: "app",
      path: "src/main.ts",
    });
    expect(fileRefFromFileKey("loose:file-1", [{
      id: "file-1",
      name: "notes.md",
      path: "/tmp/notes.md",
    }])).toEqual({
      kind: "loose",
      id: "file-1",
      path: "/tmp/notes.md",
    });
    expect(fileRefFromFileKey("loose:missing")).toBeNull();
    expect(uniqueOrderedKeys({
      primary: {
        openOrder: ["root:app:a.ts", "root:app:b.ts"],
        activeKey: "root:app:a.ts",
        previewKey: null,
        pinnedKeys: [],
      },
      secondary: {
        openOrder: ["root:app:b.ts", "root:app:c.ts"],
        activeKey: "root:app:c.ts",
        previewKey: null,
        pinnedKeys: [],
      },
    })).toEqual(["root:app:a.ts", "root:app:b.ts", "root:app:c.ts"]);
  });

  it("maintains search history with bounds and deduplication", () => {
    expect(readWorkspaceSearchHistory("ws")).toEqual([]);
    pushWorkspaceSearchHistory("ws", "first");
    pushWorkspaceSearchHistory("ws", "second");
    pushWorkspaceSearchHistory("ws", "first");
    expect(readWorkspaceSearchHistory("ws")).toEqual(["first", "second"]);
  });

  it("cleans up orphan groups not present in layout tree (N6.5)", () => {
    const rawSnapshot = {
      version: 2,
      layoutTreeV2: {
        type: "leaf",
        id: "leaf-main",
        openFileKeys: ["root:app:a.ts"],
        activeKey: "root:app:a.ts",
      },
      editorGroups: {
        "leaf-main": {
          openOrder: ["root:app:a.ts"],
          activeKey: "root:app:a.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        "leaf-orphan-1": {
          openOrder: ["root:app:b.ts"],
          activeKey: "root:app:b.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    };

    const normalized = normalizeWorkspaceLayoutSnapshot(rawSnapshot);
    expect(normalized.editorGroups["leaf-main"]).toBeDefined();
    expect(normalized.editorGroups["leaf-orphan-1"]).toBeUndefined();
  });

  it("recovers corrupted layout tree gracefully to single leaf (N6.5)", () => {
    const corrupted = {
      version: 2,
      layoutTreeV2: {
        type: "split",
        id: "bad-split",
        orientation: "horizontal",
        children: [], // Invalid: split with no children
        ratios: [],
      },
      editorGroups: {},
    };

    const normalized = normalizeWorkspaceLayoutSnapshot(corrupted);
    expect(normalized.layoutRecovered).toBe(true);
    expect(normalized.layoutTreeV2.type).toBe("leaf");
    expect(normalized.editorGroups[normalized.layoutTreeV2.id]).toBeDefined();
  });

  it("materializes a default v3 tab policy when the payload has none", () => {
    const normalized = normalizeWorkspaceLayoutSnapshot({ version: 2 });
    expect(normalized.tabPolicy).toEqual({
      schemaVersion: 3,
      limitPerLeaf: 12,
      order: "open-order",
      openPosition: "end",
      activateOnClose: "mru",
      pinnedRow: "same",
      previewMode: true,
      reusePreview: true,
    });
    expect(normalized.tabPolicyBackup).toBeUndefined();
  });

  it("round-trips a custom tab policy through localStorage", () => {
    writeWorkspaceLayoutSnapshot("ws-policy", {
      ...defaultWorkspaceLayoutSnapshot(),
      tabPolicy: {
        schemaVersion: 3,
        limitPerLeaf: 5,
        order: "alphabetical",
        openPosition: "after-active",
        activateOnClose: "left",
        pinnedRow: "separate",
        previewMode: false,
        reusePreview: false,
      },
    });
    const restored = readWorkspaceLayoutSnapshot("ws-policy");
    expect(restored?.tabPolicy).toMatchObject({
      schemaVersion: 3,
      limitPerLeaf: 5,
      order: "alphabetical",
      previewMode: false,
    });
    expect(restored?.tabPolicyBackup).toBeUndefined();
  });

  it("repairs corrupt/v2 policies on read and archives the raw payload as backup", () => {
    // v2 payload: previewEnabled migrates; limit survives.
    writeWorkspaceLayoutSnapshot("ws-v2", {
      ...defaultWorkspaceLayoutSnapshot(),
      tabPolicy: { schemaVersion: 2, limitPerLeaf: 7, previewEnabled: false } as never,
    });
    let restored = readWorkspaceLayoutSnapshot("ws-v2")!;
    expect(restored.tabPolicy).toMatchObject({ schemaVersion: 3, limitPerLeaf: 7, previewMode: false });
    expect(restored.tabPolicyBackup).toEqual({ schemaVersion: 2, limitPerLeaf: 7, previewEnabled: false });

    // Corrupt fields repair individually; backup keeps the exact raw payload.
    writeWorkspaceLayoutSnapshot("ws-corrupt", {
      ...defaultWorkspaceLayoutSnapshot(),
      tabPolicy: { schemaVersion: 9, limitPerLeaf: "many", order: "random" } as never,
    });
    restored = readWorkspaceLayoutSnapshot("ws-corrupt")!;
    expect(restored.tabPolicy!.limitPerLeaf).toBe(12);
    expect(restored.tabPolicy!.order).toBe("open-order");
    expect(restored.tabPolicyBackup).toEqual({ schemaVersion: 9, limitPerLeaf: "many", order: "random" });

    // Re-normalizing the repaired snapshot carries the archive forward…
    const renormalized = normalizeWorkspaceLayoutSnapshot(restored);
    expect(renormalized.tabPolicyBackup).toEqual(restored.tabPolicyBackup);
    // …until a clean live write (no backup field) replaces it.
    writeWorkspaceLayoutSnapshot("ws-corrupt", {
      ...defaultWorkspaceLayoutSnapshot(),
      // Normalization always materializes the policy; non-null assertion kept
      // local so a future type regression here still fails loudly.
      tabPolicy: restored.tabPolicy!,
    });
    restored = readWorkspaceLayoutSnapshot("ws-corrupt")!;
    expect(restored.tabPolicyBackup).toBeUndefined();
  });
});
