import { beforeEach, describe, expect, it } from "vitest";
import { getAllLeafNodes } from "../components/editor/workspace/recursiveLayoutTree";
import {
  createDefaultCodeWorkspaceUi,
  selectCodeWorkspaceUi,
  useCodeWorkspaceStore,
} from "./codeWorkspaceStore";

describe("codeWorkspaceStore", () => {
  beforeEach(() => {
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
  });

  it("creates isolated UI state per workspace instance id", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws-a");
    store.ensureInstance("ws-b");
    store.patchInstance("ws-a", { bottomDockOpen: false, activeKey: "file:1" });
    store.patchInstance("ws-b", { rightPaneOpen: true, searchEverywhereMode: "classes" });

    const a = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-a");
    const b = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-b");
    expect(a.bottomDockOpen).toBe(false);
    expect(a.activeKey).toBe("file:1");
    expect(a.rightPaneOpen).toBe(false);
    expect(b.rightPaneOpen).toBe(true);
    expect(b.searchEverywhereMode).toBe("classes");
    expect(b.bottomDockOpen).toBe(true);
  });

  it("disposes instance state without affecting others", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("keep");
    store.ensureInstance("drop");
    store.patchInstance("keep", { languagePanelOpen: false });
    store.disposeInstance("drop");
    expect(useCodeWorkspaceStore.getState().byInstanceId.drop).toBeUndefined();
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "keep").languagePanelOpen).toBe(false);
  });

  it("tracks open-order and markdown modes on the instance slice", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws");
    store.setOpenOrder("ws", ["a", "b"]);
    store.setActiveKey("ws", "b");
    store.setMarkdownMode("ws", "b", "split");
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws");
    expect(ui.openOrder).toEqual(["a", "b"]);
    expect(ui.activeKey).toBe("b");
    expect(ui.markdownModes.b).toBe("split");
    expect(ui.editorGroups.primary.openOrder).toEqual(["a", "b"]);
    expect(ui.editorGroups.primary.activeKey).toBe("b");
  });

  it("keeps two editor groups isolated while mirroring the active group", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws");
    store.updateEditorGroup("ws", "primary", (group) => ({
      ...group,
      openOrder: ["a"],
      activeKey: "a",
      previewKey: "a",
    }));
    store.updateEditorGroup("ws", "secondary", (group) => ({
      ...group,
      openOrder: ["b"],
      activeKey: "b",
      pinnedKeys: ["b"],
    }));
    store.setSplitOrientation("ws", "vertical");
    store.setActiveEditorGroup("ws", "secondary");

    let ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws");
    expect(ui.openOrder).toEqual(["b"]);
    expect(ui.activeKey).toBe("b");
    expect(ui.editorGroups.primary.previewKey).toBe("a");
    expect(ui.splitOrientation).toBe("vertical");

    store.setOpenOrder("ws", ["b", "c"]);
    store.setActiveKey("ws", "c");
    ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws");
    expect(ui.editorGroups.secondary.openOrder).toEqual(["b", "c"]);
    expect(ui.editorGroups.secondary.activeKey).toBe("c");
    expect(ui.editorGroups.primary.openOrder).toEqual(["a"]);
  });

  it("reconciles renamed and removed file keys across both editor groups", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws");
    store.updateEditorGroup("ws", "primary", (group) => ({
      ...group,
      openOrder: ["src", "keep"],
      activeKey: "src",
      previewKey: "src",
      pinnedKeys: ["src"],
    }));
    store.updateEditorGroup("ws", "secondary", (group) => ({
      ...group,
      openOrder: ["removed", "src"],
      activeKey: "removed",
      previewKey: "removed",
      pinnedKeys: ["removed", "src"],
    }));
    store.setActiveEditorGroup("ws", "secondary");
    store.patchInstance("ws", {
      markdownModes: { src: "split", removed: "preview" },
      recentFilesOpen: true,
      recentEntries: [{
        key: "src",
        ref: { kind: "root", rootId: "r1", path: "src.ts" },
        title: "src.ts",
        subtitle: "repo / src.ts",
        open: true,
      }],
      locationPeek: { title: "old", locations: [] },
    });

    const source = {
      ref: { kind: "root" as const, rootId: "r1", path: "src.ts" },
      key: "renamed",
      path: "renamed.ts",
      title: "renamed.ts",
      subtitle: "repo / renamed.ts",
      languagePath: "renamed.ts",
      text: "x",
      savedText: "x",
      eol: "LF" as const,
      hash: "h",
      mtime: 1,
      size: 1,
      loading: false,
      saving: false,
      dirty: false,
      documentRevision: 0,
      error: null,
    };
    const keep = { ...source, key: "keep", path: "keep.ts", title: "keep.ts" };
    store.replaceFileState("ws", {
      openFiles: { renamed: source, keep },
      lspFiles: {},
      keyChanges: { src: "renamed", removed: null },
    });

    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws");
    expect(ui.editorGroups.primary).toMatchObject({
      openOrder: ["renamed", "keep"],
      activeKey: "renamed",
      previewKey: "renamed",
      pinnedKeys: ["renamed"],
    });
    expect(ui.editorGroups.secondary).toMatchObject({
      openOrder: ["renamed"],
      activeKey: "renamed",
      previewKey: null,
      pinnedKeys: ["renamed"],
    });
    expect(ui.openOrder).toEqual(["renamed"]);
    expect(ui.activeKey).toBe("renamed");
    expect(ui.markdownModes).toEqual({ renamed: "split" });
    expect(ui.recentFilesOpen).toBe(false);
    expect(ui.recentEntries).toEqual([]);
    expect(ui.locationPeek).toBeNull();
  });

  it("holds openFiles, lspFiles, and tree expand chrome on the instance slice", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws");
    store.updateOpenFiles("ws", {
      "root:a": {
        ref: { kind: "root", rootId: "r1", path: "a.ts" },
        key: "root:a",
        path: "a.ts",
        title: "a.ts",
        subtitle: "",
        languagePath: "a.ts",
        text: "x",
        savedText: "x",
        eol: "LF",
        hash: "h",
        mtime: 1,
        size: 1,
        loading: false,
        saving: false,
        dirty: false,
        documentRevision: 0,
        error: null,
      },
    });
    store.updateLspFiles("ws", {
      "root:a": {
        status: null,
        diagnostics: [],
        diagnosticScope: null,
        syncing: false,
        syncedText: null,
        error: null,
        errorGeneration: 0,
      },
    });
    store.updateExpandedRootIds("ws", ["r1"]);
    store.updateExpandedDirKeys("ws", ["r1:"]);
    store.patchInstance("ws", {
      treeFilter: "foo",
      treeSelection: { kind: "root", rootId: "r1" },
    });
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws");
    expect(ui.openFiles["root:a"]?.text).toBe("x");
    expect(ui.lspFiles["root:a"]?.syncing).toBe(false);
    expect(ui.expandedRootIds).toEqual(["r1"]);
    expect(ui.expandedDirKeys).toEqual(["r1:"]);
    expect(ui.treeFilter).toBe("foo");
    expect(ui.treeSelection).toEqual({ kind: "root", rootId: "r1" });
  });

  it("seeds tree expand only when still empty", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws");
    store.seedTreeExpandIfEmpty("ws", ["r1"], ["r1:"]);
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws").expandedRootIds).toEqual(["r1"]);
    store.seedTreeExpandIfEmpty("ws", ["r2"], ["r2:"]);
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws").expandedRootIds).toEqual(["r1"]);
  });

  it("exposes defaults for unknown instances without mutating the map", () => {
    const defaults = createDefaultCodeWorkspaceUi();
    const missing = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "missing");
    expect(missing.openOrder).toEqual(defaults.openOrder);
    expect(missing.openFiles).toEqual({});
    expect(missing.expandedRootIds).toEqual([]);
    expect(missing.layoutRevision).toBe(0);
    expect(useCodeWorkspaceStore.getState().byInstanceId.missing).toBeUndefined();
  });

  describe("layoutRevision single-truth store integration (§8.26.3 AA2 / ED-TABS-001)", () => {
    it("initializes layoutRevision to 0 on a fresh instance", () => {
      const store = useCodeWorkspaceStore.getState();
      store.ensureInstance("ws-fresh");
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-fresh");
      expect(ui.layoutRevision).toBe(0);
    });

    it("increments layoutRevision monotonically on every layout mutation type", () => {
      const store = useCodeWorkspaceStore.getState();
      store.ensureInstance("ws-mut");
      let currentRev = 0;
      const getRev = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-mut").layoutRevision;

      // 1. setOpenOrder
      store.setOpenOrder("ws-mut", ["file:1", "file:2"]);
      expect(getRev()).toBe(++currentRev);

      // 2. setActiveKey
      store.setActiveKey("ws-mut", "file:2");
      expect(getRev()).toBe(++currentRev);

      // 3. updateEditorGroup (pin/unpin/preview)
      store.updateEditorGroup("ws-mut", "primary", (g) => ({
        ...g,
        pinnedKeys: ["file:1"],
      }));
      expect(getRev()).toBe(++currentRev);

      // 4. splitLayoutLeaf
      store.splitLayoutLeaf("ws-mut", "primary", "vertical", "file:2");
      expect(getRev()).toBe(++currentRev);

      // Find split leaves from active layout tree
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-mut");
      const leafNodes = getAllLeafNodes(currentUi.layoutTreeV2);
      expect(leafNodes.length).toBeGreaterThanOrEqual(2);
      const leafA = leafNodes[0].id;
      const leafB = leafNodes[1].id;
      const sourceLeaf = leafNodes.find((l) => l.openFileKeys.includes("file:1"))?.id ?? leafA;
      const targetLeaf = leafNodes.find((l) => l.id !== sourceLeaf)?.id ?? leafB;

      // 5. setActiveEditorGroup (switch active focus from targetLeaf back to sourceLeaf)
      expect(currentUi.activeEditorGroupId).toBe(targetLeaf);
      store.setActiveEditorGroup("ws-mut", sourceLeaf);
      expect(getRev()).toBe(++currentRev);

      // 6. setLeafActiveTab
      store.setLeafActiveTab("ws-mut", sourceLeaf, "file:1");
      expect(getRev()).toBe(++currentRev);

      // 7. moveLayoutTab
      store.moveLayoutTab("ws-mut", sourceLeaf, targetLeaf, "file:1");
      expect(getRev()).toBe(++currentRev);

      // 8. closeLayoutTabInLeaf
      store.closeLayoutTabInLeaf("ws-mut", targetLeaf, "file:1");
      expect(getRev()).toBe(++currentRev);

      // 9. stretchLayoutLeaf
      store.stretchLayoutLeaf("ws-mut", sourceLeaf, { step: 0.1 });
      expect(getRev()).toBe(++currentRev);

      // 10. equalizeLayoutRatios
      store.equalizeLayoutRatios("ws-mut", sourceLeaf);
      expect(getRev()).toBe(++currentRev);

      // 11. setSplitOrientation
      store.setSplitOrientation("ws-mut", "horizontal");
      expect(getRev()).toBe(++currentRev);

      // 12. unsplitAllLayout
      store.unsplitAllLayout("ws-mut");
      expect(getRev()).toBe(++currentRev);

      // 13. replaceFileState
      store.replaceFileState("ws-mut", {
        openFiles: {},
        lspFiles: {},
        keyChanges: {},
      });
      expect(getRev()).toBe(++currentRev);

      // 14. bumpLayoutRevision
      const bumped = store.bumpLayoutRevision("ws-mut");
      expect(bumped).toBe(++currentRev);
      expect(getRev()).toBe(currentRev);
    });

    it("does not increment layoutRevision on no-op mutations", () => {
      const store = useCodeWorkspaceStore.getState();
      store.ensureInstance("ws-noop");
      store.setOpenOrder("ws-noop", ["file:1"]);
      store.setActiveKey("ws-noop", "file:1");
      const revAfterSetup = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-noop").layoutRevision;

      // Repeat identical setActiveKey
      store.setActiveKey("ws-noop", "file:1");
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-noop").layoutRevision).toBe(revAfterSetup);

      // Repeat identical setOpenOrder
      store.setOpenOrder("ws-noop", ["file:1"]);
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-noop").layoutRevision).toBe(revAfterSetup);

      // Repeat identical active group
      store.setActiveEditorGroup("ws-noop", "primary");
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-noop").layoutRevision).toBe(revAfterSetup);

      // Repeat identical split orientation
      store.setSplitOrientation("ws-noop", null);
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-noop").layoutRevision).toBe(revAfterSetup);

      // Non-layout patch should not increment layoutRevision
      store.patchInstance("ws-noop", { treeFilter: "some-filter" });
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-noop").layoutRevision).toBe(revAfterSetup);
    });

    it("keeps layoutRevision isolated between multiple workspaces", () => {
      const store = useCodeWorkspaceStore.getState();
      store.ensureInstance("ws-1");
      store.ensureInstance("ws-2");

      store.setOpenOrder("ws-1", ["a", "b"]);
      store.setActiveKey("ws-1", "b");
      store.splitLayoutLeaf("ws-1", "primary", "vertical");

      const rev1 = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-1").layoutRevision;
      const rev2 = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-2").layoutRevision;

      expect(rev1).toBeGreaterThan(0);
      expect(rev2).toBe(0);

      store.setOpenOrder("ws-2", ["x"]);
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-2").layoutRevision).toBe(1);
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-1").layoutRevision).toBe(rev1);
    });
  });
});
