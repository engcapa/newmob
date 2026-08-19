/**
 * Recursive Split Layout Tree Model (A2 / N6.1).
 *
 * Implements arbitrary nested horizontal and vertical editor splits, ratio rebalancing,
 * leaf group tab movement, atomic layout mutation commits, and schema v2 serialization/deserialization.
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

export interface LayoutEditorGroupState {
  id: string;
  openOrder: string[];
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
}

export type LayoutMutationResult =
  | {
      kind: "changed";
      tree: LayoutNode;
      groups: Record<string, LayoutEditorGroupState>;
      activeGroupId: string;
    }
  | { kind: "no-op" | "failed"; reason: string };

let layoutMonotonicCounter = 0;

/**
 * Generate a workspace-scoped monotonic unique ID for layout leaves and splits.
 */
export function generateLayoutId(prefix: "leaf" | "split", workspaceId?: string): string {
  layoutMonotonicCounter += 1;
  const wsPart = workspaceId ? `${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "")}-` : "";
  return `${prefix}-${wsPart}${Date.now()}-${layoutMonotonicCounter}`;
}

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
    const newLeafId = generateLayoutId("leaf");
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
            id: generateLayoutId("split"),
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
 *  - Positive finite ratios summing within tolerance [0.99, 1.01]
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
      const sum = (rec.ratios as number[]).reduce((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
      if (Math.abs(sum - 1.0) > 0.05) {
        errors.push(`${path}: ratios must sum close to 1.0 (actual: ${sum})`);
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
  newLeafId = generateLayoutId("leaf"),
  newFileKey?: string,
): LayoutNode {
  const target = findLeafNode(root, leafId);
  if (!target) {
    return root; // Atomic no-op
  }

  // Ensure unique new leaf id
  const existingIds = new Set(getAllLeafNodes(root).map((l) => l.id));
  const finalNewLeafId = existingIds.has(newLeafId) ? generateLayoutId("leaf") : newLeafId;

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
          id: generateLayoutId("split"),
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
 * Atomic Split Leaf Mutation.
 * Returns { kind: "changed", tree, groups, activeGroupId } or { kind: "no-op" | "failed", reason }.
 */
export function atomicSplitLeaf(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  _activeGroupId: string,
  leafId: string,
  orientation: "horizontal" | "vertical",
  newFileKey?: string,
  customNewLeafId?: string,
): LayoutMutationResult {
  const targetLeaf = findLeafNode(tree, leafId);
  if (!targetLeaf) {
    return { kind: "no-op", reason: `Target leaf "${leafId}" not found in layout tree.` };
  }

  const newLeafId = customNewLeafId ?? generateLayoutId("leaf");
  const newTree = splitLeafNode(tree, leafId, orientation, newLeafId, newFileKey);
  if (newTree === tree) {
    return { kind: "no-op", reason: "Tree split failed." };
  }

  const newGroup: LayoutEditorGroupState = {
    id: newLeafId,
    openOrder: newFileKey ? [newFileKey] : [],
    activeKey: newFileKey ?? null,
    previewKey: null,
    pinnedKeys: [],
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: {
      ...groups,
      [newLeafId]: newGroup,
    },
    activeGroupId: newLeafId,
  };
}

/**
 * Atomic Close Leaf Mutation.
 * Refuses to close the last remaining leaf or non-existent leaf.
 * Cleans up the closed group and selects a remaining leaf as active if needed.
 */
export function atomicCloseLeaf(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  activeGroupId: string,
  leafId: string,
): LayoutMutationResult {
  const totalLeaves = getAllLeafNodes(tree);
  if (totalLeaves.length <= 1) {
    return { kind: "no-op", reason: "Cannot close the last remaining editor leaf." };
  }

  const targetLeaf = findLeafNode(tree, leafId);
  if (!targetLeaf) {
    return { kind: "no-op", reason: `Target leaf "${leafId}" not found in layout tree.` };
  }

  const newTree = closeLeafNode(tree, leafId);
  if (newTree === tree) {
    return { kind: "no-op", reason: "Tree close leaf resulted in identical tree." };
  }

  const remainingLeaves = getAllLeafNodes(newTree);
  const nextGroups = { ...groups };
  delete nextGroups[leafId];

  const nextActiveId =
    activeGroupId === leafId
      ? remainingLeaves[0]?.id ?? Object.keys(nextGroups)[0] ?? "primary"
      : activeGroupId;

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId: nextActiveId,
  };
}

/**
 * Atomic Move Tab Mutation.
 * Validates source and target existence and moves tab in both tree and editor groups atomically.
 */
export function atomicMoveTab(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  _activeGroupId: string,
  sourceLeafId: string,
  targetLeafId: string,
  fileKey: string,
): LayoutMutationResult {
  if (sourceLeafId === targetLeafId) {
    return { kind: "no-op", reason: "Source and target leaf are identical." };
  }

  const sourceLeaf = findLeafNode(tree, sourceLeafId);
  const targetLeaf = findLeafNode(tree, targetLeafId);
  if (!sourceLeaf || !targetLeaf) {
    return { kind: "no-op", reason: "Source or target leaf not found in tree." };
  }

  const sourceGroup = groups[sourceLeafId];
  if (!sourceGroup || !sourceGroup.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not found in source leaf "${sourceLeafId}".` };
  }

  const newTree = moveTabBetweenLeaves(tree, sourceLeafId, targetLeafId, fileKey);
  if (newTree === tree) {
    return { kind: "no-op", reason: "moveTabBetweenLeaves returned unchanged tree." };
  }

  const targetGroup = groups[targetLeafId] ?? {
    id: targetLeafId,
    openOrder: [],
    activeKey: null,
    previewKey: null,
    pinnedKeys: [],
  };

  const nextSourceOrder = sourceGroup.openOrder.filter((k) => k !== fileKey);
  const nextSourceActive = sourceGroup.activeKey === fileKey ? (nextSourceOrder[0] ?? null) : sourceGroup.activeKey;
  const nextTargetOrder = targetGroup.openOrder.includes(fileKey) ? targetGroup.openOrder : [...targetGroup.openOrder, fileKey];

  const nextGroups = {
    ...groups,
    [sourceLeafId]: {
      ...sourceGroup,
      openOrder: nextSourceOrder,
      activeKey: nextSourceActive,
      previewKey: sourceGroup.previewKey === fileKey ? null : sourceGroup.previewKey,
      pinnedKeys: sourceGroup.pinnedKeys.filter((k) => k !== fileKey),
    },
    [targetLeafId]: {
      ...targetGroup,
      openOrder: nextTargetOrder,
      activeKey: fileKey,
    },
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId: targetLeafId,
  };
}

/**
 * Atomic Set Leaf Active Tab Mutation.
 */
export function atomicSetLeafActiveTab(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  activeGroupId: string,
  leafId: string,
  fileKey: string | null,
): LayoutMutationResult {
  const leaf = findLeafNode(tree, leafId);
  if (!leaf) {
    return { kind: "no-op", reason: `Leaf "${leafId}" not found in tree.` };
  }

  const group = groups[leafId];
  if (fileKey !== null && group && !group.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not in group "${leafId}".` };
  }

  if (group && group.activeKey === fileKey && activeGroupId === leafId) {
    return { kind: "no-op", reason: "Tab is already active." };
  }

  const newTree = setLeafActiveTab(tree, leafId, fileKey);
  const nextGroups = {
    ...groups,
    [leafId]: {
      ...(group ?? { id: leafId, openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] }),
      activeKey: fileKey,
    },
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId: leafId,
  };
}

/**
 * Atomic Close Tab in Leaf Mutation.
 * Synchronizes leaf openFileKeys and group openOrder / activeKey together.
 */
export function atomicCloseTabInLeaf(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  activeGroupId: string,
  leafId: string,
  fileKey: string,
): LayoutMutationResult {
  const leaf = findLeafNode(tree, leafId);
  const group = groups[leafId];
  if (!leaf || !group || !group.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not found in leaf "${leafId}".` };
  }

  const nextOrder = group.openOrder.filter((k) => k !== fileKey);
  const nextActive = group.activeKey === fileKey ? (nextOrder[0] ?? null) : group.activeKey;

  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === leafId) {
        return {
          ...node,
          openFileKeys: nextOrder,
          activeKey: nextActive,
        };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(updateRecursive),
    };
  };

  const newTree = updateRecursive(tree);
  const nextGroups = {
    ...groups,
    [leafId]: {
      ...group,
      openOrder: nextOrder,
      activeKey: nextActive,
      previewKey: group.previewKey === fileKey ? null : group.previewKey,
      pinnedKeys: group.pinnedKeys.filter((k) => k !== fileKey),
    },
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId,
  };
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
