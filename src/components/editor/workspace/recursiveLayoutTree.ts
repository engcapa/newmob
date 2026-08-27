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

import { selectActivateOnClose, type AnyWorkspaceTabPolicy } from "./workspaceTabPolicy";

export type LayoutMutationResult =
  | {
      kind: "changed";
      tree: LayoutNode;
      groups: Record<string, LayoutEditorGroupState>;
      activeGroupId: string;
      migration?: {
        destinationLeafId: string;
        migratedKeys: string[];
      };
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

/**
 * Single canonical single-leaf tree factory (§8.16.4): fresh mounts, legacy
 * synthesis and persistence defaults all materialize through this helper so
 * leaf ids and shape stay consistent across every creation path.
 */
export function createSingleLeafLayout(
  leafId: string,
  openFileKeys: readonly string[],
  activeKey: string | null,
): LeafGroupNode {
  return {
    type: "leaf",
    id: leafId,
    openFileKeys: [...openFileKeys],
    activeKey,
  };
}

/**
 * Bidirectionally sync a leaf's tab list from its legacy group (§8.16.4):
 * every `updateEditorGroup` write mirrors openOrder/activeKey into the
 * recursive tree so preview replacement, close-others and WorkspaceEdit
 * restore cannot desynchronize leaf and group truth.
 * Returns the same tree reference when the leaf is missing or unchanged.
 */
export function setLeafTabs(
  root: LayoutNode,
  leafId: string,
  openFileKeys: readonly string[],
  activeKey: string | null,
): LayoutNode {
  const leaf = findLeafNode(root, leafId);
  if (!leaf) return root;
  const sameKeys = leaf.openFileKeys.length === openFileKeys.length
    && leaf.openFileKeys.every((key, index) => key === openFileKeys[index]);
  if (sameKeys && leaf.activeKey === activeKey) return root;
  return updateLeafInTree(root, leafId, (target) => ({
    ...target,
    openFileKeys: [...openFileKeys],
    activeKey,
  }));
}

export function cloneLayoutTree(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") {
    return { ...node, openFileKeys: [...node.openFileKeys] };
  }
  return {
    ...node,
    ratios: [...node.ratios],
    children: node.children.map(cloneLayoutTree),
  };
}

/** Convert react-resizable-panels v4's keyed percentage map to normalized ratios. */
export function panelLayoutToRatios(
  layout: Readonly<Record<string, number>>,
  childIds: readonly string[],
): number[] | null {
  const values = childIds.map((id) => layout[`panel-${id}`]);
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return values.map((value) => value / sum);
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
 * Update ratios of a split node and normalize them.
 */
export function updateSplitNodeRatios(
  node: LayoutNode,
  splitId: string,
  rawRatios: number[],
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) {
    if (rawRatios.length !== node.children.length) return node;
    if (rawRatios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) return node;
    const sum = rawRatios.reduce((total, ratio) => total + ratio, 0);
    if (!Number.isFinite(sum) || sum <= 0) return node;
    const normalizedRatios = rawRatios.map((ratio) => ratio / sum);
    if (normalizedRatios.every((ratio, index) => ratio === node.ratios[index])) return node;
    return { ...node, ratios: normalizedRatios };
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateSplitNodeRatios(child, splitId, rawRatios);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...node, children } : node;
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
      for (let i = 0; i < rec.ratios.length; i++) {
        const r = (rec.ratios as number[])[i];
        if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) {
          errors.push(`${path}: ratio[${i}] must be a positive finite number, got ${r}`);
          return false;
        }
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

// ---------------------------------------------------------------------------
// §8.19.6 R5-b split management primitives: equalize / stretch / navigate /
// unsplit-all. All pure, atomic (unchanged reference on no-op), ratio-legal.
// ---------------------------------------------------------------------------

/**
 * Equalize the ratios of the split DIRECTLY containing `leafId` (§8.19.6:
 * equalize distributes evenly across same-layer children). Returns the same
 * tree reference when the leaf is missing or already equalized.
 */
export function equalizeLeafParentSplit(root: LayoutNode, leafId: string): LayoutNode {
  if (root.type === "leaf") return root;
  let changed = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") return node;
    const children = node.children.map(walk);
    const childChanged = children.some((child, index) => child !== node.children[index]);
    const direct = node.children.some((child) => child.type === "leaf" && child.id === leafId);
    const equalRatios = node.children.map(() => 1 / node.children.length);
    const ratiosChanged = direct
      && !node.ratios.every((ratio, index) => ratio === equalRatios[index]);
    if (!childChanged && !ratiosChanged) return node;
    changed = true;
    return {
      ...node,
      children: childChanged ? children : node.children,
      ratios: ratiosChanged ? equalRatios : [...node.ratios],
    };
  };
  const next = walk(root);
  return changed ? next : root;
}

/**
 * Grow one leaf's share inside its parent split by `step`, shrinking siblings
 * proportionally so ratios stay normalized (§8.19.6: repeatable with an upper
 * bound). No-op once the leaf reaches `max` or siblings have no space left.
 */
export function stretchLeafInTree(
  root: LayoutNode,
  leafId: string,
  options: { step?: number; max?: number } = {},
): LayoutNode {
  const rawStep = options.step ?? 0.1;
  const rawMax = options.max ?? 0.8;
  const step = Number.isFinite(rawStep) ? Math.min(Math.max(rawStep, 0.01), 0.5) : 0.1;
  const max = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 0.05), 0.99) : 0.8;

  const apply = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") return node;
    const directIndex = node.children.findIndex((child) => child.type === "leaf" && child.id === leafId);
    if (directIndex >= 0) {
      const current = node.ratios[directIndex] ?? 0;
      const target = Math.min(max, current + step);
      const grow = target - current;
      const otherTotal = node.ratios.reduce((sum, ratio, index) => (index === directIndex ? sum : sum + ratio), 0);
      if (grow <= 1e-9 || otherTotal <= grow + 1e-9) return node;
      const shrinkFactor = (otherTotal - grow) / otherTotal;
      const ratios = node.ratios.map((ratio, index) => (index === directIndex ? target : ratio * shrinkFactor));
      if (ratios.every((ratio, index) => ratio === node.ratios[index])) return node;
      return { ...node, ratios };
    }
    let changed = false;
    const children = node.children.map((child) => {
      const next = apply(child);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...node, children } : node;
  };
  return apply(root);
}

/**
 * Preorder next/previous leaf around `currentLeafId`, wrapping at the ends
 * (§8.19.6 go-to-next/previous-split navigation). Returns null for single-
 * leaf trees or unknown ids in one-leaf trees.
 */
export function navigateLeafOrder(
  tree: LayoutNode,
  currentLeafId: string,
  direction: 1 | -1,
): LeafGroupNode | null {
  const leaves = getAllLeafNodes(tree);
  if (leaves.length <= 1) return null;
  const index = leaves.findIndex((leaf) => leaf.id === currentLeafId);
  const base = index < 0 ? 0 : index;
  return leaves[(base + direction + leaves.length) % leaves.length] ?? null;
}

/**
 * Collapse the entire tree into its FIRST preorder leaf, migrating every
 * leaf's tabs into it with order-preserving dedup (§8.19.6 Unsplit All —
 * tabs migrate, never drop). The survivor keeps its id; the resulting active
 * tab comes from the globally active leaf when that tab survives the merge.
 * Returns null for single-leaf trees (already unsplit).
 */
export function unsplitAllLeaves(
  root: LayoutNode,
  activeLeafId: string | null,
): { tree: LeafGroupNode; mergedKeys: readonly string[] } | null {
  const leaves = getAllLeafNodes(root);
  const survivor = leaves[0];
  if (!survivor || leaves.length <= 1) return null;

  const keys: string[] = [];
  for (const leaf of leaves) {
    for (const key of leaf.openFileKeys) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const activeLeaf = activeLeafId != null ? leaves.find((leaf) => leaf.id === activeLeafId) : null;
  let activeKey = activeLeaf?.activeKey ?? survivor.activeKey;
  if (activeKey != null && !keys.includes(activeKey)) activeKey = null;

  return { tree: { type: "leaf", id: survivor.id, openFileKeys: keys, activeKey }, mergedKeys: keys };
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
 * Walk a layout tree and update a specific leaf node in-place (pure/immutable).
 */
function updateLeafInTree(
  node: LayoutNode,
  leafId: string,
  updater: (leaf: LeafGroupNode) => LeafGroupNode,
): LayoutNode {
  if (node.type === "leaf") {
    return node.id === leafId ? updater(node) : node;
  }
  return {
    ...node,
    children: node.children.map((child) => updateLeafInTree(child, leafId, updater)),
  };
}

/**
 * Validate bidirectional consistency between layout tree leaves and editor groups.
 * Every leaf must have a matching group with identical openFileKeys/activeKey,
 * and every group must correspond to a leaf in the tree.
 */
export function validateTreeGroupConsistency(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
): { consistent: boolean; errors: string[] } {
  const errors: string[] = [];
  const leaves = getAllLeafNodes(tree);
  const leafIds = new Set(leaves.map((l) => l.id));

  for (const leaf of leaves) {
    const group = groups[leaf.id];
    if (!group) {
      errors.push(`Leaf "${leaf.id}" has no matching group entry.`);
      continue;
    }
    const treeKeys = new Set(leaf.openFileKeys);
    const groupKeys = new Set(group.openOrder);
    for (const k of leaf.openFileKeys) {
      if (!groupKeys.has(k)) {
        errors.push(`Leaf "${leaf.id}" tree has key "${k}" not in group openOrder.`);
      }
    }
    for (const k of group.openOrder) {
      if (!treeKeys.has(k)) {
        errors.push(`Group "${leaf.id}" has key "${k}" not in tree openFileKeys.`);
      }
    }
    if (leaf.activeKey !== group.activeKey) {
      errors.push(`Leaf "${leaf.id}" activeKey mismatch: tree="${leaf.activeKey}" vs group="${group.activeKey}".`);
    }
  }

  for (const gid of Object.keys(groups)) {
    // An empty legacy group slot carries no layout truth and stays dormant
    // (e.g. the unused "secondary" group after fresh-mount materialization);
    // only non-empty groups require a matching leaf (§8.16.4).
    if (!leafIds.has(gid) && groups[gid].openOrder.length > 0) {
      errors.push(`Group "${gid}" has no matching leaf in tree.`);
    }
  }

  return { consistent: errors.length === 0, errors };
}

/**
 * Find the adjacent sibling leaf for a target leaf along the parent split (N6.5).
 * Priority: same-level index + 1, else index - 1.
 * If sibling is a split, returns the preorder first leaf in that split.
 */
export function findAdjacentSiblingLeaf(
  tree: LayoutNode,
  targetLeafId: string,
): LeafGroupNode | null {
  function search(node: LayoutNode): { sibling: LeafGroupNode | null; found: boolean } {
    if (node.type === "leaf") {
      return { sibling: null, found: node.id === targetLeafId };
    }

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.id === targetLeafId) {
        const siblingIdx = i + 1 < node.children.length ? i + 1 : i - 1 >= 0 ? i - 1 : -1;
        if (siblingIdx >= 0) {
          const siblingChild = node.children[siblingIdx];
          const leaf = siblingChild.type === "leaf" ? siblingChild : getAllLeafNodes(siblingChild)[0] ?? null;
          return { sibling: leaf, found: true };
        }
        return { sibling: null, found: true };
      }

      if (child.type === "split") {
        const res = search(child);
        if (res.found) {
          if (res.sibling) return res;
          const siblingIdx = i + 1 < node.children.length ? i + 1 : i - 1 >= 0 ? i - 1 : -1;
          if (siblingIdx >= 0) {
            const siblingChild = node.children[siblingIdx];
            const leaf = siblingChild.type === "leaf" ? siblingChild : getAllLeafNodes(siblingChild)[0] ?? null;
            return { sibling: leaf, found: true };
          }
          return { sibling: null, found: true };
        }
      }
    }
    return { sibling: null, found: false };
  }

  const { sibling } = search(tree);
  if (sibling) return sibling;

  const allLeaves = getAllLeafNodes(tree).filter((l) => l.id !== targetLeafId);
  return allLeaves[0] ?? null;
}

/**
 * Validate and commit a layout mutation (N6.5).
 * Validates tree structure and bidirectional tree-group consistency.
 * If validation fails, logs diagnostic and returns failed result.
 */
export function commitLayoutMutation(
  _currentTree: LayoutNode,
  _currentGroups: Record<string, LayoutEditorGroupState>,
  _currentActiveGroupId: string,
  result: LayoutMutationResult,
): LayoutMutationResult {
  if (result.kind !== "changed") {
    return result;
  }

  const treeValidation = validateLayoutTree(result.tree);
  if (!treeValidation.valid) {
    const errorMsg = `Layout tree validation failed: ${treeValidation.errors.join(", ")}`;
    console.error(`[LayoutDiagnostics] ${errorMsg}`);
    return { kind: "failed", reason: errorMsg };
  }

  const consistency = validateTreeGroupConsistency(result.tree, result.groups);
  if (!consistency.consistent) {
    const errorMsg = `Tree/group consistency validation failed: ${consistency.errors.join("; ")}`;
    console.error(`[LayoutDiagnostics] ${errorMsg}`);
    return { kind: "failed", reason: errorMsg };
  }

  return result;
}

/**
 * Atomic Close Leaf Mutation (N6.5).
 * Refuses to close the last remaining leaf or non-existent leaf.
 * Migrates tabs to adjacent sibling leaf along the parent split.
 * Never drops tabs silently and keeps tree/group bidirectionally consistent.
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

  const siblingLeaf = findAdjacentSiblingLeaf(tree, leafId);
  const targetSiblingId = siblingLeaf?.id ?? getAllLeafNodes(tree).find((l) => l.id !== leafId)?.id;
  if (!targetSiblingId) {
    return { kind: "no-op", reason: "Cannot determine destination leaf for migration." };
  }

  const newTree = closeLeafNode(tree, leafId);
  if (newTree === tree) {
    return { kind: "no-op", reason: "Tree close leaf resulted in identical tree." };
  }

  const closedGroup = groups[leafId];
  const nextGroups = { ...groups };
  delete nextGroups[leafId];

  // If destination group does not exist in groups dictionary, create it from tree leaf
  if (!nextGroups[targetSiblingId]) {
    const destLeafNode = findLeafNode(newTree, targetSiblingId);
    nextGroups[targetSiblingId] = {
      id: targetSiblingId,
      openOrder: destLeafNode ? [...destLeafNode.openFileKeys] : [],
      activeKey: destLeafNode?.activeKey ?? null,
      previewKey: null,
      pinnedKeys: [],
    };
  }

  const migratedKeys: string[] = [];
  if (closedGroup && closedGroup.openOrder.length > 0 && nextGroups[targetSiblingId]) {
    const targetGroup = nextGroups[targetSiblingId];
    const combinedOrder = [...targetGroup.openOrder];
    for (const key of closedGroup.openOrder) {
      if (!combinedOrder.includes(key)) {
        combinedOrder.push(key);
        migratedKeys.push(key);
      }
    }
    nextGroups[targetSiblingId] = {
      ...targetGroup,
      openOrder: combinedOrder,
      activeKey: targetGroup.activeKey ?? closedGroup.activeKey ?? combinedOrder[0] ?? null,
    };
  }

  const destGroup = nextGroups[targetSiblingId];
  const syncedTree = destGroup
    ? updateLeafInTree(newTree, targetSiblingId, (leaf) => ({
        ...leaf,
        openFileKeys: destGroup.openOrder,
        activeKey: destGroup.activeKey,
      }))
    : newTree;

  const nextActiveId = activeGroupId === leafId ? targetSiblingId : activeGroupId;

  return {
    kind: "changed",
    tree: syncedTree,
    groups: nextGroups,
    activeGroupId: nextActiveId,
    migration: {
      destinationLeafId: targetSiblingId,
      migratedKeys,
    },
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
  policy?: AnyWorkspaceTabPolicy,
  lastUsedByKey?: ReadonlyMap<string, number>,
): LayoutMutationResult {
  const leaf = findLeafNode(tree, leafId);
  const group = groups[leafId];
  if (!leaf || !group || !group.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not found in leaf "${leafId}".` };
  }

  const nextOrder = group.openOrder.filter((k) => k !== fileKey);
  const nextActive = policy
    ? selectActivateOnClose(group.openOrder, fileKey, group.activeKey, lastUsedByKey ?? new Map(), policy)
    : group.activeKey === fileKey ? (nextOrder[0] ?? null) : group.activeKey;

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

/**
 * Reconcile and remap file keys inside a LayoutNode tree when files are renamed or removed.
 */
export function remapLayoutTreeKeys(
  node: LayoutNode,
  keyChanges: Record<string, string | null>,
  validKeys: Set<string>,
  editorGroups: Record<string, LayoutEditorGroupState | undefined>,
): LayoutNode {
  if (node.type === "leaf") {
    const group = editorGroups[node.id];
    let nextKey = node.activeKey;
    if (nextKey && keyChanges[nextKey] !== undefined) {
      nextKey = keyChanges[nextKey];
    }
    if (nextKey && !validKeys.has(nextKey)) {
      nextKey = group?.activeKey ?? null;
    }
    const nextOpenFileKeys = node.openFileKeys
      .map((k) => (keyChanges[k] !== undefined ? keyChanges[k] : k))
      .filter((k): k is string => typeof k === "string" && validKeys.has(k));

    return {
      ...node,
      openFileKeys: nextOpenFileKeys,
      activeKey: nextKey,
    };
  }

  return {
    ...node,
    children: node.children.map((child) =>
      remapLayoutTreeKeys(child, keyChanges, validKeys, editorGroups),
    ),
  };
}
