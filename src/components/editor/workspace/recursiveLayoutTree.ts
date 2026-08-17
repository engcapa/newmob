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

/**
 * Pure reducer: Split a leaf node and return a new immutable LayoutNode tree.
 */
export function splitLeafNode(
  root: LayoutNode,
  leafId: string,
  orientation: "horizontal" | "vertical",
  newLeafId = `leaf-${Date.now()}`,
  newFileKey?: string,
): LayoutNode {
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

  return updateRecursive(root);
}

/**
 * Pure reducer: Close a leaf node and collapse parent split if only one child remains.
 */
export function closeLeafNode(root: LayoutNode, leafId: string): LayoutNode {
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

  return removeRecursive(root) ?? root;
}

/**
 * Pure reducer: Move a file key from one leaf to another.
 */
export function moveTabBetweenLeaves(
  root: LayoutNode,
  sourceLeafId: string,
  targetLeafId: string,
  fileKey: string,
): LayoutNode {
  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === sourceLeafId) {
        const filtered = node.openFileKeys.filter((k) => k !== fileKey);
        const activeKey = node.activeKey === fileKey ? (filtered[0] ?? null) : node.activeKey;
        return { ...node, openFileKeys: filtered, activeKey };
      }
      if (node.id === targetLeafId) {
        const keys = node.openFileKeys.includes(fileKey) ? node.openFileKeys : [...node.openFileKeys, fileKey];
        return { ...node, openFileKeys: keys, activeKey: fileKey };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(updateRecursive),
    };
  };

  return updateRecursive(root);
}

/**
 * Pure reducer: Set the active tab in a leaf node.
 */
export function setLeafActiveTab(root: LayoutNode, leafId: string, fileKey: string | null): LayoutNode {
  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === leafId) {
        return { ...node, activeKey: fileKey };
      }
      return node;
    }
    return { ...node, children: node.children.map(updateRecursive) };
  };
  return updateRecursive(root);
}

/**
 * Get all leaf nodes in preorder.
 */
export function getAllLeafNodes(root: LayoutNode): LeafGroupNode[] {
  if (root.type === "leaf") return [root];
  return root.children.flatMap(getAllLeafNodes);
}

/**
 * Find a specific leaf node by ID.
 */
export function findLeafNode(root: LayoutNode, leafId: string): LeafGroupNode | null {
  if (root.type === "leaf") return root.id === leafId ? root : null;
  for (const child of root.children) {
    const found = findLeafNode(child, leafId);
    if (found) return found;
  }
  return null;
}

/**
 * Migrate legacy flat or binary layout schemas into LayoutNode tree v2.
 */
export function migrateLayoutV1toV2(legacyLayout: unknown): LayoutNode {
  if (!legacyLayout || typeof legacyLayout !== "object") {
    return {
      type: "leaf",
      id: "leaf-primary",
      openFileKeys: [],
      activeKey: null,
    };
  }

  const rec = legacyLayout as Record<string, unknown>;
  if (rec.type === "leaf" || rec.type === "split") {
    return legacyLayout as LayoutNode;
  }

  // Legacy single split format
  if (typeof rec.orientation === "string" && Array.isArray(rec.groups)) {
    const orientation = rec.orientation === "vertical" ? "vertical" : "horizontal";
    const children: LayoutNode[] = (rec.groups as unknown[]).map((g, i) => {
      const grec = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
      return {
        type: "leaf" as const,
        id: typeof grec.id === "string" ? grec.id : `leaf-${i}`,
        openFileKeys: Array.isArray(grec.openFileKeys) ? (grec.openFileKeys as string[]) : [],
        activeKey: typeof grec.activeKey === "string" ? grec.activeKey : null,
      };
    });

    if (children.length === 1 && children[0]) return children[0];
    return {
      type: "split",
      id: "split-root",
      orientation,
      children,
      ratios: children.map(() => 1 / children.length),
    };
  }

  return {
    type: "leaf",
    id: "leaf-primary",
    openFileKeys: Array.isArray(rec.openFileKeys) ? (rec.openFileKeys as string[]) : [],
    activeKey: typeof rec.activeKey === "string" ? rec.activeKey : null,
  };
}
