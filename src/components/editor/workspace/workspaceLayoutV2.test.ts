import { beforeEach, describe, expect, it } from "vitest";
import { useCodeWorkspaceStore, selectCodeWorkspaceUi } from "../../../stores/codeWorkspaceStore";
import {
  createSingleLeafLayout,
  getAllLeafNodes,
  setLeafTabs,
  validateTreeGroupConsistency,
} from "./recursiveLayoutTree";

type LayoutEditorGroupStateLike = {
  id: string;
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
};
import {
  defaultWorkspaceLayoutSnapshot,
  normalizeWorkspaceLayoutSnapshot,
} from "./workspaceLayoutPersistence";

describe("N6.6 recursive layout v2 production boundaries", () => {
  beforeEach(() => {
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
  });

  it("createSingleLeafLayout produces a valid single-leaf tree", () => {
    const tree = createSingleLeafLayout("primary", ["a", "b"], "a");
    expect(tree).toEqual({ type: "leaf", id: "primary", openFileKeys: ["a", "b"], activeKey: "a" });
    const groups: Record<string, LayoutEditorGroupStateLike> = {
      primary: { id: "primary", openOrder: ["a", "b"], activeKey: "a", previewKey: null, pinnedKeys: [] },
      secondary: { id: "secondary", openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] },
    };
    const { consistent, errors } = validateTreeGroupConsistency(tree, groups);
    // Dormant empty legacy groups carry no layout truth and stay tolerated.
    expect(errors).toEqual([]);
    expect(consistent).toBe(true);
  });

  it("setLeafTabs mirrors group writes into the leaf and keeps references stable", () => {
    const tree = createSingleLeafLayout("primary", [], null);
    const updated = setLeafTabs(tree, "primary", ["k1"], "k1");
    expect(updated).not.toBe(tree);
    expect(getAllLeafNodes(updated)[0].openFileKeys).toEqual(["k1"]);
    // No change → same reference (no-op render).
    expect(setLeafTabs(updated, "primary", ["k1"], "k1")).toBe(updated);
    // Unknown leaf → unchanged.
    expect(setLeafTabs(updated, "missing", ["x"], "x")).toBe(updated);
  });

  it("updateEditorGroup mirrors legacy group writes into the recursive tree", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("n66-sync");
    store.setLayoutTreeV2("n66-sync", createSingleLeafLayout("primary", [], null));
    store.updateEditorGroup("n66-sync", "primary", (group) => ({
      ...group,
      openOrder: ["root:app:a.ts"],
      activeKey: "root:app:a.ts",
    }));
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "n66-sync");
    expect(ui.layoutTreeV2).toEqual({
      type: "leaf",
      id: "primary",
      openFileKeys: ["root:app:a.ts"],
      activeKey: "root:app:a.ts",
    });
  });

  it("splitLayoutLeaf materializes from legacy groups when the tree is null", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("n66-split");
    store.updateEditorGroup("n66-split", "primary", (group) => ({
      ...group,
      openOrder: ["k1"],
      activeKey: "k1",
    }));
    store.splitLayoutLeaf("n66-split", "primary", "vertical", "k1");
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "n66-split");
    expect(ui.layoutTreeV2?.type).toBe("split");
    expect(ui.splitOrientation).toBe("vertical");
    const leaves = getAllLeafNodes(ui.layoutTreeV2!);
    expect(leaves.map((leaf) => leaf.activeKey)).toEqual(["k1", "k1"]);
  });

  it("materializes a canonical leaf in every fresh store instance", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("n66-default");
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "n66-default");
    expect(ui.layoutTreeV2).toEqual({
      type: "leaf",
      id: "primary",
      openFileKeys: [],
      activeKey: null,
    });
  });

  it("keeps the store snapshot unchanged for invalid and same-reference tree writes", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("n66-noop");
    const before = useCodeWorkspaceStore.getState();
    const tree = selectCodeWorkspaceUi(before, "n66-noop").layoutTreeV2;
    store.setLayoutTreeV2("n66-noop", tree);
    expect(useCodeWorkspaceStore.getState()).toBe(before);
    store.setLayoutTreeV2("n66-noop", {
      type: "split",
      id: "invalid",
      orientation: "horizontal",
      children: [],
      ratios: [],
    });
    expect(useCodeWorkspaceStore.getState()).toBe(before);
  });

  it("normalizeWorkspaceLayoutSnapshot clones the input tree instead of mutating it", () => {
    const snapshot = defaultWorkspaceLayoutSnapshot();
    snapshot.layoutTreeV2 = createSingleLeafLayout("primary", ["k1"], "k1");
    const inputTree = snapshot.layoutTreeV2;
    const persisted = { ...snapshot, editorGroups: {
      primary: { openOrder: ["k1"], activeKey: "k1", previewKey: null, pinnedKeys: [] },
      secondary: { openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] },
    } };
    const normalized = normalizeWorkspaceLayoutSnapshot(persisted);
    expect(normalized.layoutTreeV2).not.toBe(inputTree);
    expect(inputTree.openFileKeys).toEqual(["k1"]);
    if (normalized.layoutTreeV2.type === "leaf") {
      expect(normalized.layoutTreeV2.openFileKeys).toEqual(["k1"]);
    }
  });
});
