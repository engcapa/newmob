import { describe, expect, it } from "vitest";
import {
  LayoutTreeManager,
  splitLeafNode,
  closeLeafNode,
  moveTabBetweenLeaves,
  setLeafActiveTab,
  getAllLeafNodes,
  findLeafNode,
  migrateLayoutV1toV2,
  atomicSplitLeaf,
  atomicCloseLeaf,
  atomicMoveTab,
  atomicSetLeafActiveTab,
  atomicCloseTabInLeaf,
  validateLayoutTree,
  validateTreeGroupConsistency,
  remapLayoutTreeKeys,
  findAdjacentSiblingLeaf,
  commitLayoutMutation,
  type LayoutNode,
} from "./recursiveLayoutTree";

describe("recursiveLayoutTree", () => {
  it("creates a single leaf root by default", () => {
    const manager = new LayoutTreeManager();
    const root = manager.getRoot();
    expect(root.type).toBe("leaf");
    expect(manager.countLeaves()).toBe(1);
  });

  it("splits a leaf node and collapses when closed", () => {
    const manager = new LayoutTreeManager();
    manager.splitLeaf("leaf-primary", "horizontal", "file-1.ts");

    expect(manager.countLeaves()).toBe(2);
    const root = manager.getRoot();
    expect(root.type).toBe("split");

    manager.closeLeaf("leaf-primary");
    expect(manager.countLeaves()).toBe(1);
    expect(manager.getRoot().type).toBe("leaf");
  });

  it("pure reducers split and close without mutating input", () => {
    const initial: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["f1"],
      activeKey: "f1",
    };

    const splitTree = splitLeafNode(initial, "leaf-1", "vertical", "leaf-2", "f2");
    expect(splitTree.type).toBe("split");
    expect(initial.type).toBe("leaf");

    const leaves = getAllLeafNodes(splitTree);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.id)).toEqual(["leaf-1", "leaf-2"]);

    const closedTree = closeLeafNode(splitTree, "leaf-2");
    expect(closedTree.type).toBe("leaf");
    expect((closedTree as { id: string }).id).toBe("leaf-1");
  });

  it("moves tabs between leaves", () => {
    const root: LayoutNode = {
      type: "split",
      id: "split-1",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "leaf-1", openFileKeys: ["f1", "f2"], activeKey: "f1" },
        { type: "leaf", id: "leaf-2", openFileKeys: ["f3"], activeKey: "f3" },
      ],
    };

    const moved = moveTabBetweenLeaves(root, "leaf-1", "leaf-2", "f2");
    const leaf1 = findLeafNode(moved, "leaf-1");
    const leaf2 = findLeafNode(moved, "leaf-2");

    expect(leaf1?.openFileKeys).toEqual(["f1"]);
    expect(leaf2?.openFileKeys).toEqual(["f3", "f2"]);
    expect(leaf2?.activeKey).toBe("f2");
  });

  it("sets leaf active tab", () => {
    const root: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["f1", "f2"],
      activeKey: "f1",
    };

    const updated = setLeafActiveTab(root, "leaf-1", "f2");
    expect((updated as { activeKey: string }).activeKey).toBe("f2");
  });

  it("migrates legacy v1 layouts to v2 LayoutNode", () => {
    const legacyFlat = {
      orientation: "horizontal",
      groups: [
        { id: "g1", openFileKeys: ["a.ts"], activeKey: "a.ts" },
        { id: "g2", openFileKeys: ["b.ts"], activeKey: "b.ts" },
      ],
    };

    const migrated = migrateLayoutV1toV2(legacyFlat);
    expect(migrated.type).toBe("split");
    const leaves = getAllLeafNodes(migrated);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].id).toBe("g1");
    expect(leaves[1].id).toBe("g2");
  });

  it("atomicSplitLeaf creates a new group and returns changed outcome", () => {
    const tree: LayoutNode = {
      type: "leaf",
      id: "primary",
      openFileKeys: ["a.ts"],
      activeKey: "a.ts",
    };
    const groups = {
      primary: { id: "primary", openOrder: ["a.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
    };

    const res = atomicSplitLeaf(tree, groups, "primary", "primary", "horizontal", "b.ts", "leaf-secondary");
    expect(res.kind).toBe("changed");
    if (res.kind === "changed") {
      expect(res.activeGroupId).toBe("leaf-secondary");
      expect(res.groups["leaf-secondary"]).toBeDefined();
      expect(res.groups["leaf-secondary"].openOrder).toEqual(["b.ts"]);
      expect(getAllLeafNodes(res.tree)).toHaveLength(2);
    }
  });

  it("atomicCloseLeaf cleans up closed group and prevents closing last leaf", () => {
    const tree: LayoutNode = {
      type: "leaf",
      id: "primary",
      openFileKeys: ["a.ts"],
      activeKey: "a.ts",
    };
    const groups = {
      primary: { id: "primary", openOrder: ["a.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
    };

    const res1 = atomicCloseLeaf(tree, groups, "primary", "primary");
    expect(res1.kind).toBe("no-op");

    // With 2 leaves
    const splitTree: LayoutNode = {
      type: "split",
      id: "split-1",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "primary", openFileKeys: ["a.ts"], activeKey: "a.ts" },
        { type: "leaf", id: "secondary", openFileKeys: ["b.ts"], activeKey: "b.ts" },
      ],
    };
    const splitGroups = {
      primary: { id: "primary", openOrder: ["a.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
      secondary: { id: "secondary", openOrder: ["b.ts"], activeKey: "b.ts", previewKey: null, pinnedKeys: [] },
    };

    const res2 = atomicCloseLeaf(splitTree, splitGroups, "secondary", "secondary");
    expect(res2.kind).toBe("changed");
    if (res2.kind === "changed") {
      expect(res2.activeGroupId).toBe("primary");
      expect(res2.groups.secondary).toBeUndefined();
      expect(res2.groups.primary).toBeDefined();
      expect(getAllLeafNodes(res2.tree)).toHaveLength(1);
    }
  });

  it("atomicCloseTabInLeaf synchronizes tree and group openOrder", () => {
    const tree: LayoutNode = {
      type: "leaf",
      id: "primary",
      openFileKeys: ["a.ts", "b.ts"],
      activeKey: "a.ts",
    };
    const groups = {
      primary: { id: "primary", openOrder: ["a.ts", "b.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
    };

    const res = atomicCloseTabInLeaf(tree, groups, "primary", "primary", "a.ts");
    expect(res.kind).toBe("changed");
    if (res.kind === "changed") {
      expect(res.groups.primary.openOrder).toEqual(["b.ts"]);
      expect(res.groups.primary.activeKey).toBe("b.ts");
      const leaf = findLeafNode(res.tree, "primary");
      expect(leaf?.openFileKeys).toEqual(["b.ts"]);
      expect(leaf?.activeKey).toBe("b.ts");
    }
  });

  it("atomicMoveTab transfers tab across leaves and groups atomically", () => {
    const tree: LayoutNode = {
      type: "split",
      id: "split-1",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "l1", openFileKeys: ["f1.ts", "f2.ts"], activeKey: "f1.ts" },
        { type: "leaf", id: "l2", openFileKeys: ["f3.ts"], activeKey: "f3.ts" },
      ],
    };
    const groups = {
      l1: { id: "l1", openOrder: ["f1.ts", "f2.ts"], activeKey: "f1.ts", previewKey: null, pinnedKeys: [] },
      l2: { id: "l2", openOrder: ["f3.ts"], activeKey: "f3.ts", previewKey: null, pinnedKeys: [] },
    };

    const res = atomicMoveTab(tree, groups, "l1", "l1", "l2", "f2.ts");
    expect(res.kind).toBe("changed");
    if (res.kind === "changed") {
      expect(res.groups.l1.openOrder).toEqual(["f1.ts"]);
      expect(res.groups.l2.openOrder).toEqual(["f3.ts", "f2.ts"]);
    }
  });

  it("atomicSetLeafActiveTab updates active tab in leaf and group atomically", () => {
    const tree: LayoutNode = {
      type: "leaf",
      id: "l1",
      openFileKeys: ["f1.ts", "f2.ts"],
      activeKey: "f1.ts",
    };
    const groups = {
      l1: { id: "l1", openOrder: ["f1.ts", "f2.ts"], activeKey: "f1.ts", previewKey: null, pinnedKeys: [] },
    };

    const res = atomicSetLeafActiveTab(tree, groups, "l1", "l1", "f2.ts");
    expect(res.kind).toBe("changed");
    if (res.kind === "changed") {
      expect(res.groups.l1.activeKey).toBe("f2.ts");
      const leaf = findLeafNode(res.tree, "l1");
      expect(leaf?.activeKey).toBe("f2.ts");
    }
  });

  it("validateLayoutTree checks ratios sum tolerance", () => {
    const validTree: LayoutNode = {
      type: "split",
      id: "s1",
      orientation: "horizontal",
      children: [
        { type: "leaf", id: "l1", openFileKeys: [], activeKey: null },
        { type: "leaf", id: "l2", openFileKeys: [], activeKey: null },
      ],
      ratios: [0.5, 0.5],
    };
    expect(validateLayoutTree(validTree).valid).toBe(true);

    const invalidTree: LayoutNode = {
      type: "split",
      id: "s1",
      orientation: "horizontal",
      children: [
        { type: "leaf", id: "l1", openFileKeys: [], activeKey: null },
        { type: "leaf", id: "l2", openFileKeys: [], activeKey: null },
      ],
      ratios: [0.2, 0.2], // sum = 0.4 != 1.0
    };
    expect(validateLayoutTree(invalidTree).valid).toBe(false);

    // Reject non-positive ratios (<= 0)
    const negativeRatioTree: LayoutNode = {
      type: "split",
      id: "s1",
      orientation: "horizontal",
      children: [
        { type: "leaf", id: "l1", openFileKeys: [], activeKey: null },
        { type: "leaf", id: "l2", openFileKeys: [], activeKey: null },
      ],
      ratios: [-0.5, 1.5],
    };
    expect(validateLayoutTree(negativeRatioTree).valid).toBe(false);
  });

  it("atomicCloseLeaf migrates open tabs to sibling leaf to preserve view (N6.3)", () => {
    const splitTree: LayoutNode = {
      type: "split",
      id: "split-1",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "primary", openFileKeys: ["a.ts"], activeKey: "a.ts" },
        { type: "leaf", id: "secondary", openFileKeys: ["b.ts", "c.ts"], activeKey: "b.ts" },
      ],
    };
    const splitGroups = {
      primary: { id: "primary", openOrder: ["a.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
      secondary: { id: "secondary", openOrder: ["b.ts", "c.ts"], activeKey: "b.ts", previewKey: null, pinnedKeys: [] },
    };

    const res = atomicCloseLeaf(splitTree, splitGroups, "secondary", "secondary");
    expect(res.kind).toBe("changed");
    if (res.kind === "changed") {
      expect(res.groups.primary.openOrder).toEqual(["a.ts", "b.ts", "c.ts"]);
    }
  });

  it("remapLayoutTreeKeys correctly remaps file keys and activeKey across tree leaves (N6.3)", () => {
    const tree: LayoutNode = {
      type: "split",
      id: "split-root",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "primary", openFileKeys: ["oldA.ts", "keep.ts"], activeKey: "oldA.ts" },
        { type: "leaf", id: "secondary", openFileKeys: ["deleted.ts"], activeKey: "deleted.ts" },
      ],
    };

    const keyChanges = { "oldA.ts": "newA.ts" };
    const validKeys = new Set(["newA.ts", "keep.ts"]);
    const groups = {
      primary: { id: "primary", openOrder: ["newA.ts", "keep.ts"], activeKey: "newA.ts", previewKey: null, pinnedKeys: [] },
      secondary: { id: "secondary", openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] },
    };

    const remapped = remapLayoutTreeKeys(tree, keyChanges, validKeys, groups);
    if (remapped.type === "split") {
      const leaf0 = remapped.children[0];
      const leaf1 = remapped.children[1];
      if (leaf0.type === "leaf") {
        expect(leaf0.openFileKeys).toEqual(["newA.ts", "keep.ts"]);
        expect(leaf0.activeKey).toBe("newA.ts");
      }
      if (leaf1.type === "leaf") {
        expect(leaf1.openFileKeys).toEqual([]);
        expect(leaf1.activeKey).toBe(null);
      }
    }
  });

  it("atomicCloseLeaf syncs destination leaf openFileKeys/activeKey with group (N6.4)", () => {
    const tree: LayoutNode = {
      type: "split",
      id: "split-root",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "left", openFileKeys: ["a.ts"], activeKey: "a.ts" },
        { type: "leaf", id: "right", openFileKeys: ["b.ts"], activeKey: "b.ts" },
      ],
    };
    const groups = {
      left: { id: "left", openOrder: ["a.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
      right: { id: "right", openOrder: ["b.ts"], activeKey: "b.ts", previewKey: null, pinnedKeys: [] },
    };

    const result = atomicCloseLeaf(tree, groups, "right", "right");
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;

    // The surviving leaf should have both files in tree AND group
    const surviving = findLeafNode(result.tree, "left");
    expect(surviving).not.toBeNull();
    expect(surviving!.openFileKeys).toContain("a.ts");
    expect(surviving!.openFileKeys).toContain("b.ts");

    const survivingGroup = result.groups["left"];
    expect(survivingGroup.openOrder).toContain("a.ts");
    expect(survivingGroup.openOrder).toContain("b.ts");

    // Tree and group must agree
    expect(surviving!.openFileKeys).toEqual(survivingGroup.openOrder);
    expect(surviving!.activeKey).toBe(survivingGroup.activeKey);
  });

  it("validateTreeGroupConsistency detects divergence (N6.4)", () => {
    const tree: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["a.ts"],
      activeKey: "a.ts",
    };
    const groups = {
      "leaf-1": { id: "leaf-1", openOrder: ["a.ts", "b.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
    };

    const result = validateTreeGroupConsistency(tree, groups);
    expect(result.consistent).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.includes("b.ts"))).toBe(true);
  });

  it("validateTreeGroupConsistency passes on consistent state (N6.4)", () => {
    const tree: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["a.ts", "b.ts"],
      activeKey: "a.ts",
    };
    const groups = {
      "leaf-1": { id: "leaf-1", openOrder: ["a.ts", "b.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
    };

    const result = validateTreeGroupConsistency(tree, groups);
    expect(result.consistent).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("findAdjacentSiblingLeaf finds sibling along parent split (N6.5)", () => {
    const tree: LayoutNode = {
      type: "split",
      id: "s1",
      orientation: "horizontal",
      ratios: [0.33, 0.33, 0.34],
      children: [
        { type: "leaf", id: "leaf-0", openFileKeys: [], activeKey: null },
        { type: "leaf", id: "leaf-1", openFileKeys: [], activeKey: null },
        { type: "leaf", id: "leaf-2", openFileKeys: [], activeKey: null },
      ],
    };

    // leaf-0 -> prefers index+1 = leaf-1
    const sib0 = findAdjacentSiblingLeaf(tree, "leaf-0");
    expect(sib0?.id).toBe("leaf-1");

    // leaf-1 -> prefers index+1 = leaf-2
    const sib1 = findAdjacentSiblingLeaf(tree, "leaf-1");
    expect(sib1?.id).toBe("leaf-2");

    // leaf-2 -> index+1 is out of bounds, so index-1 = leaf-1
    const sib2 = findAdjacentSiblingLeaf(tree, "leaf-2");
    expect(sib2?.id).toBe("leaf-1");
  });

  it("atomicCloseLeaf returns migration metadata with destinationLeafId and migratedKeys (N6.5)", () => {
    const tree: LayoutNode = {
      type: "split",
      id: "s1",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "l1", openFileKeys: ["f1.ts"], activeKey: "f1.ts" },
        { type: "leaf", id: "l2", openFileKeys: ["f2.ts", "f3.ts"], activeKey: "f2.ts" },
      ],
    };
    const groups = {
      l1: { id: "l1", openOrder: ["f1.ts"], activeKey: "f1.ts", previewKey: null, pinnedKeys: [] },
      l2: { id: "l2", openOrder: ["f2.ts", "f3.ts"], activeKey: "f2.ts", previewKey: null, pinnedKeys: [] },
    };

    const res = atomicCloseLeaf(tree, groups, "l2", "l2");
    expect(res.kind).toBe("changed");
    if (res.kind === "changed") {
      expect(res.migration).toBeDefined();
      expect(res.migration?.destinationLeafId).toBe("l1");
      expect(res.migration?.migratedKeys).toEqual(["f2.ts", "f3.ts"]);
      expect(res.groups.l1.openOrder).toEqual(["f1.ts", "f2.ts", "f3.ts"]);
    }
  });

  it("commitLayoutMutation rejects inconsistent mutations", () => {
    const validTree: LayoutNode = {
      type: "leaf",
      id: "l1",
      openFileKeys: ["a.ts"],
      activeKey: "a.ts",
    };
    const validGroups = {
      l1: { id: "l1", openOrder: ["a.ts"], activeKey: "a.ts", previewKey: null, pinnedKeys: [] },
    };
    const badMutation = {
      kind: "changed" as const,
      tree: { type: "split" as const, id: "bad", orientation: "horizontal" as const, ratios: [0.5], children: [validTree] },
      groups: validGroups,
      activeGroupId: "l1",
    };
    const committed = commitLayoutMutation(validTree, validGroups, "l1", badMutation);
    expect(committed.kind).toBe("failed");
  });
});
