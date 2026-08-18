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
 * Extract all openFileKeys from any tree structure (even partially corrupt ones).
 */
export function extractAllFileKeys(node: unknown): string[] {
  const keys: string[] = [];
  function walk(n: unknown) {
    if (!n || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (Array.isArray(rec.openFileKeys)) {
      for (const k of rec.openFileKeys) {
        if (typeof k === "string") keys.push(k);
      }
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) {
        walk(child);
      }
    }
    if (Array.isArray(rec.groups)) {
      for (const g of rec.groups) {
        walk(g);
      }
    }
  }
  walk(node);
  return keys;
}

/**
 * Validate a layout node tree for invariants:
 *  - Unique IDs
 *  - Valid leaf active keys (must be in openFileKeys or null)
 *  - Valid split children (length >= 2, matching normalized ratios)
 */
export function validateLayoutTree(root: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  function validateNode(node: unknown, path: string): boolean {
    if (!node || typeof node !== "object") {
      errors.push(`${path}: node is not an object`);
      return false;
    }
    const rec = node as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${path}: missing or invalid id`);
      return false;
    }
    if (seenIds.has(id)) {
      errors.push(`${path}: duplicate node id "${id}"`);
      return false;
    }
    seenIds.add(id);

    if (rec.type === "leaf") {
      if (!Array.isArray(rec.openFileKeys)) {
        errors.push(`${path}: openFileKeys must be an array`);
        return false;
      }
      const keys = rec.openFileKeys as string[];
      for (const k of keys) {
        if (typeof k !== "string") {
          errors.push(`${path}: openFileKeys contains non-string`);
          return false;
        }
      }
      if (rec.activeKey !== null && typeof rec.activeKey === "string") {
        if (keys.length > 0 && !keys.includes(rec.activeKey)) {
          errors.push(`${path}: activeKey "${rec.activeKey}" not found in openFileKeys [${keys.join(", ")}]`);
          return false;
        }
      } else if (rec.activeKey !== null) {
        errors.push(`${path}: activeKey must be string or null`);
        return false;
      }
      return true;
    }

    if (rec.type === "split") {
      if (rec.orientation !== "horizontal" && rec.orientation !== "vertical") {
        errors.push(`${path}: orientation must be "horizontal" or "vertical"`);
        return false;
      }
      if (!Array.isArray(rec.children) || rec.children.length < 2) {
        errors.push(`${path}: split must have at least 2 children`);
        return false;
      }
      if (!Array.isArray(rec.ratios) || rec.ratios.length !== rec.children.length) {
        errors.push(`${path}: ratios length must match children length`);
        return false;
      }
      for (let i = 0; i < rec.children.length; i++) {
        if (!validateNode(rec.children[i], `${path}.children[${i}]`)) {
          return false;
        }
      }
      return true;
    }

    errors.push(`${path}: unknown node type "${String(rec.type)}"`);
    return false;
  }

  const valid = validateNode(root, "root");
  return { valid, errors };
}

/**
 * Pure reducer: Split a leaf node and return a new immutable LayoutNode tree.
 * Atomically pre-validates target leaf existence.
 */
export function splitLeafNode(
  root: LayoutNode,
  leafId: string,
  orientation: "horizontal" | "vertical",
  newLeafId = `leaf-${Date.now()}`,
  newFileKey?: string,
): LayoutNode {
  const target = findLeafNode(root, leafId);
  if (!target) {
    return root; // Atomic no-op
  }

  // Ensure unique new leaf id
  const existingIds = new Set(getAllLeafNodes(root).map((l) => l.id));
  const finalNewLeafId = existingIds.has(newLeafId) ? `leaf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` : newLeafId;

  const newLeaf: LeafGroupNode = {
    type: "leaf",
    id: finalNewLeafId,
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
 * Atomically refuses to close the last remaining leaf in the tree.
 */
export function closeLeafNode(root: LayoutNode, leafId: string): LayoutNode {
  const totalLeaves = getAllLeafNodes(root).length;
  if (totalLeaves <= 1) {
    return root; // Atomic no-op: cannot close last leaf
  }

  const target = findLeafNode(root, leafId);
  if (!target) {
    return root; // Atomic no-op: target not found
  }

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
 * Atomically validates that BOTH source and target leaves exist,
 * and that sourceLeaf contains the fileKey before performing the move.
 */
export function moveTabBetweenLeaves(
  root: LayoutNode,
  sourceLeafId: string,
  targetLeafId: string,
  fileKey: string,
): LayoutNode {
  if (sourceLeafId === targetLeafId) {
    return root; // No-op
  }

  const sourceLeaf = findLeafNode(root, sourceLeafId);
  const targetLeaf = findLeafNode(root, targetLeafId);

  // Atomic pre-validation: both must exist and source must own fileKey
  if (!sourceLeaf || !targetLeaf || !sourceLeaf.openFileKeys.includes(fileKey)) {
    return root;
  }

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
 * Atomically validates that leaf exists and fileKey belongs to the leaf.
 */
export function setLeafActiveTab(root: LayoutNode, leafId: string, fileKey: string | null): LayoutNode {
  const leaf = findLeafNode(root, leafId);
  if (!leaf) {
    return root; // Atomic no-op
  }

  // Pre-validate: fileKey must belong to leaf (unless null)
  if (fileKey !== null && !leaf.openFileKeys.includes(fileKey)) {
    return root; // Atomic no-op
  }

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
 * Migrate legacy flat or binary layout schemas into LayoutNode tree v2,
 * with validation and fallback to a safe single leaf if corrupt.
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
    const { valid } = validateLayoutTree(legacyLayout);
    if (valid) {
      return legacyLayout as LayoutNode;
    }
    // If invalid/corrupt, safely recover into a single leaf with unique files
    const allFileKeys = extractAllFileKeys(legacyLayout);
    const uniqueKeys = Array.from(new Set(allFileKeys));
    return {
      type: "leaf",
      id: "leaf-primary",
      openFileKeys: uniqueKeys,
      activeKey: uniqueKeys[0] ?? null,
    };
  }

  // Legacy single split format
  if (typeof rec.orientation === "string" && Array.isArray(rec.groups)) {
    const orientation = rec.orientation === "vertical" ? "vertical" : "horizontal";
    const children: LayoutNode[] = (rec.groups as unknown[]).map((g, i) => {
      const grec = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
      const keys = Array.isArray(grec.openFileKeys) ? (grec.openFileKeys.filter((k): k is string => typeof k === "string")) : [];
      const act = typeof grec.activeKey === "string" && keys.includes(grec.activeKey) ? grec.activeKey : (keys[0] ?? null);
      return {
        type: "leaf" as const,
        id: typeof grec.id === "string" && grec.id ? grec.id : `leaf-${i}`,
        openFileKeys: keys,
        activeKey: act,
      };
    });

    if (children.length === 1 && children[0]) return children[0];
    if (children.length >= 2) {
      return {
        type: "split",
        id: "split-root",
        orientation,
        children,
        ratios: children.map(() => 1 / children.length),
      };
    }
  }

  const openFileKeys = Array.isArray(rec.openFileKeys)
    ? rec.openFileKeys.filter((k): k is string => typeof k === "string")
    : [];
  const activeKey = typeof rec.activeKey === "string" && openFileKeys.includes(rec.activeKey)
    ? rec.activeKey
    : (openFileKeys[0] ?? null);

  return {
    type: "leaf",
    id: "leaf-primary",
    openFileKeys,
    activeKey,
  };
}
