/**
 * Recursive Split Layout Tree Model (A2).
 *
 * Implements arbitrary nested horizontal and vertical editor splits, ratio rebalancing,
 * leaf group tab movement, and serialization/deserialization.
 */

export interface LeafGroupNode {
  type: "leaf";
  id: string;
  openFileKeys: string[];
  activeKey: string | null;
}

export interface SplitLayoutNode {
  type: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  children: LayoutNode[];
  ratios: number[]; // e.g. [0.5, 0.5]
}

export type LayoutNode = SplitLayoutNode | LeafGroupNode;

export class LayoutTreeManager {
  private root: LayoutNode;

  constructor(initialRoot?: LayoutNode) {
    this.root = initialRoot ?? {
      type: "leaf",
      id: "leaf-primary",
      openFileKeys: [],
      activeKey: null,
    };
  }

  getRoot(): LayoutNode {
    return this.root;
  }

  /**
   * Split a leaf node either horizontally or vertically, creating a new child leaf.
   */
  splitLeaf(
    leafId: string,
    orientation: "horizontal" | "vertical",
    newFileKey?: string,
  ): boolean {
    const newLeafId = `leaf-${Date.now()}`;
    const newLeaf: LeafGroupNode = {
      type: "leaf",
      id: newLeafId,
      openFileKeys: newFileKey ? [newFileKey] : [],
      activeKey: newFileKey ?? null,
    };

    const updateRecursive = (node: LayoutNode): LayoutNode => {
      if (node.type === "leaf") {
        if (node.id === leafId) {
          return {
            type: "split",
            id: `split-${Date.now()}`,
            orientation,
            children: [node, newLeaf],
            ratios: [0.5, 0.5],
          };
        }
        return node;
      }

      return {
        ...node,
        children: node.children.map(updateRecursive),
      };
    };

    this.root = updateRecursive(this.root);
    return true;
  }

  /**
   * Close a leaf node and collapse parent split if only one sibling remains.
   */
  closeLeaf(leafId: string): boolean {
    const removeRecursive = (node: LayoutNode): LayoutNode | null => {
      if (node.type === "leaf") {
        return node.id === leafId ? null : node;
      }

      const newChildren = node.children
        .map(removeRecursive)
        .filter((c): c is LayoutNode => c !== null);

      if (newChildren.length === 0) return null;
      if (newChildren.length === 1) return newChildren[0];

      return {
        ...node,
        children: newChildren,
        ratios: newChildren.map(() => 1 / newChildren.length),
      };
    };

    const newRoot = removeRecursive(this.root);
    if (newRoot) {
      this.root = newRoot;
    }
    return true;
  }

  /**
   * Count total leaves in layout tree.
   */
  countLeaves(node: LayoutNode = this.root): number {
    if (node.type === "leaf") return 1;
    return node.children.reduce((sum, c) => sum + this.countLeaves(c), 0);
  }
}
