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

  it("atomically prevents tab loss when moving to a non-existent target leaf", () => {
    const root: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["f1", "f2"],
      activeKey: "f1",
    };

    // Target "leaf-non-existent" does not exist
    const moved = moveTabBetweenLeaves(root, "leaf-1", "leaf-non-existent", "f2");
    expect(moved).toBe(root);
    const leaf = findLeafNode(moved, "leaf-1");
    expect(leaf?.openFileKeys).toEqual(["f1", "f2"]); // Tab was preserved!
  });

  it("atomically prevents activating keys not belonging to the leaf", () => {
    const root: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["f1", "f2"],
      activeKey: "f1",
    };

    const updated = setLeafActiveTab(root, "leaf-1", "foreign-file.ts");
    expect(updated).toBe(root);
    expect((updated as { activeKey: string }).activeKey).toBe("f1");
  });

  it("refuses to close the last remaining leaf node in the tree", () => {
    const root: LayoutNode = {
      type: "leaf",
      id: "leaf-1",
      openFileKeys: ["f1"],
      activeKey: "f1",
    };

    const closed = closeLeafNode(root, "leaf-1");
    expect(closed).toBe(root);
    expect(getAllLeafNodes(closed)).toHaveLength(1);
  });

  it("safely recovers corrupt tree structures during migration", () => {
    const corruptTree = {
      type: "split",
      id: "split-corrupt",
      orientation: "invalid-orientation",
      children: [{ type: "leaf", id: "l1", openFileKeys: ["f1.ts"], activeKey: "non-existent.ts" }],
      ratios: [1.0],
    };

    const recovered = migrateLayoutV1toV2(corruptTree);
    expect(recovered.type).toBe("leaf");
    expect(getAllLeafNodes(recovered)).toHaveLength(1);
    expect(getAllLeafNodes(recovered)[0].openFileKeys).toContain("f1.ts");
  });
});
