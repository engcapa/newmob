import { beforeEach, describe, expect, it } from "vitest";
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
        syncing: false,
        syncedText: null,
        error: null,
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
    expect(useCodeWorkspaceStore.getState().byInstanceId.missing).toBeUndefined();
  });
});
