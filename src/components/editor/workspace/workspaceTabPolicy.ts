/**
 * Workspace tab policy model (§8.18.5 P0-C4).
 *
 * Pure reducer helpers for IDEA-like editor-tab behaviour: per-leaf limits
 * that never silently close dirty/pinned tabs, display ordering independent
 * of MRU, and the closed-tabs reopen stack. The store owns state; this module
 * only computes decisions so property tests can pin the semantics.
 */

import { getAllLeafNodes, type LayoutNode, type LeafGroupNode } from "./recursiveLayoutTree";

export interface WorkspaceTabPolicyV2 {
  schemaVersion: 2;
  limitPerLeaf: number;
  order: "mru" | "alphabetical" | "open-order";
  openPosition: "end" | "after-active";
  activateOnClose: "mru" | "left" | "right";
  pinnedRow: "same" | "separate";
  previewEnabled: boolean;
  reusePreview: boolean;
}

export const DEFAULT_WORKSPACE_TAB_POLICY: WorkspaceTabPolicyV2 = {
  schemaVersion: 2,
  limitPerLeaf: 12,
  order: "open-order",
  openPosition: "end",
  activateOnClose: "mru",
  pinnedRow: "same",
  previewEnabled: true,
  reusePreview: true,
};

// ---------------------------------------------------------------------------
// §8.19.6 Tab Policy V3: per-workspace persistence with field-level repair
// ---------------------------------------------------------------------------

export interface WorkspaceTabPolicyV3 {
  schemaVersion: 3;
  limitPerLeaf: number;
  order: "mru" | "alphabetical" | "open-order";
  openPosition: "end" | "after-active";
  activateOnClose: "mru" | "left" | "right";
  pinnedRow: "same" | "separate";
  /** §8.19.6 previewMode: single-click opens a reusable preview tab. */
  previewMode: boolean;
  reusePreview: boolean;
}

export const DEFAULT_WORKSPACE_TAB_POLICY_V3: WorkspaceTabPolicyV3 = {
  schemaVersion: 3,
  limitPerLeaf: 12,
  order: "open-order",
  openPosition: "end",
  activateOnClose: "mru",
  pinnedRow: "same",
  previewMode: true,
  reusePreview: true,
};

/** Helpers accept either generation — they only read shared fields. */
export type AnyWorkspaceTabPolicy = WorkspaceTabPolicyV2 | WorkspaceTabPolicyV3;

const POLICY_ORDERS: readonly WorkspaceTabPolicyV3["order"][] = ["mru", "alphabetical", "open-order"];
const POLICY_OPEN_POSITIONS: readonly WorkspaceTabPolicyV3["openPosition"][] = ["end", "after-active"];
const POLICY_ACTIVATE_ON_CLOSE: readonly WorkspaceTabPolicyV3["activateOnClose"][] = ["mru", "left", "right"];
const POLICY_PINNED_ROWS: readonly WorkspaceTabPolicyV3["pinnedRow"][] = ["same", "separate"];

/**
 * §8.19.6 migration/normalization. Accepts persisted JSON of any shape:
 * v2 objects migrate (previewEnabled→previewMode), v3 passes through, and
 * every unknown/corrupt field falls back individually to its default. The
 * raw payload is returned as `backup` whenever ANY repair happened, so the
 * caller can keep the original on disk before overwriting.
 */
export function migrateWorkspaceTabPolicy(raw: unknown): {
  policy: WorkspaceTabPolicyV3;
  repairedFields: readonly string[];
  backup: unknown;
} {
  const repairedFields: string[] = [];
  const source = (raw != null && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { policy: { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 }, repairedFields: ["*"], backup: raw ?? null };
  }

  const pickEnum = <T extends string>(field: string, allowed: readonly T[], fallback: T): T => {
    const value = source[field];
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    repairedFields.push(field);
    return fallback;
  };
  const pickNumber = (field: string, fallback: number, min: number, max: number): number => {
    const value = source[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      const clamped = Math.min(max, Math.max(min, Math.round(value)));
      if (clamped !== value) repairedFields.push(field);
      return clamped;
    }
    repairedFields.push(field);
    return fallback;
  };
  const pickBoolean = (field: string, fallback: boolean): boolean => {
    const value = source[field];
    if (typeof value === "boolean") return value;
    repairedFields.push(field);
    return fallback;
  };

  // v2 payloads carry previewEnabled instead of previewMode.
  let previewMode = pickBoolean("previewMode", DEFAULT_WORKSPACE_TAB_POLICY_V3.previewMode);
  if (!("previewMode" in source) && typeof source.previewEnabled === "boolean") {
    previewMode = source.previewEnabled;
    repairedFields.push("previewMode(migrated-from-v2)");
  }

  const schemaVersion: WorkspaceTabPolicyV3["schemaVersion"] = source.schemaVersion === 3
    ? 3
    : (() => {
      repairedFields.push("schemaVersion");
      return 3 as const;
    })();

  const policy: WorkspaceTabPolicyV3 = {
    schemaVersion,
    limitPerLeaf: pickNumber("limitPerLeaf", DEFAULT_WORKSPACE_TAB_POLICY_V3.limitPerLeaf, 1, 100),
    order: pickEnum("order", POLICY_ORDERS, DEFAULT_WORKSPACE_TAB_POLICY_V3.order),
    openPosition: pickEnum("openPosition", POLICY_OPEN_POSITIONS, DEFAULT_WORKSPACE_TAB_POLICY_V3.openPosition),
    activateOnClose: pickEnum("activateOnClose", POLICY_ACTIVATE_ON_CLOSE, DEFAULT_WORKSPACE_TAB_POLICY_V3.activateOnClose),
    pinnedRow: pickEnum("pinnedRow", POLICY_PINNED_ROWS, DEFAULT_WORKSPACE_TAB_POLICY_V3.pinnedRow),
    previewMode,
    reusePreview: pickBoolean("reusePreview", DEFAULT_WORKSPACE_TAB_POLICY_V3.reusePreview),
  };
  return {
    policy,
    repairedFields,
    backup: repairedFields.length > 0 ? raw : null,
  };
}

/** Metadata the eviction decision needs for one open tab. */
export interface TabEvictionMeta {
  key: string;
  dirty: boolean;
  pinned: boolean;
  preview: boolean;
  /** Larger = more recently used (e.g. Date.now() at activation). */
  lastUsedAt: number;
}

export type TabEvictionResult =
  | { kind: "within-limit" }
  | { kind: "evicted"; evictedKeys: readonly string[] }
  /**
   * Every candidate is protected (dirty/pinned): the leaf is allowed over
   * limit and surfaces show a reason instead of silently closing work.
   */
  | { kind: "over-limit-protected"; reason: string };

/**
 * Evict candidates when `keys` exceeds `policy.limitPerLeaf`. Priority:
 * clean previews first, then least-recently used; dirty/pinned tabs are never
 * touched (§8.18.5).
 */
export function enforceTabPolicy(
  keys: readonly string[],
  meta: ReadonlyMap<string, TabEvictionMeta>,
  policy: AnyWorkspaceTabPolicy,
  options?: { allowDirty?: boolean },
): TabEvictionResult {
  if (policy.limitPerLeaf <= 0 || keys.length <= policy.limitPerLeaf) {
    return { kind: "within-limit" };
  }
  const overflow = keys.length - policy.limitPerLeaf;
  const evictable = [...keys]
    .reverse()
    .map((key) => meta.get(key))
    .filter((entry): entry is TabEvictionMeta => !!entry)
    .filter((entry) => (options?.allowDirty ? !entry.pinned : !entry.dirty && !entry.pinned))
    .sort((left, right) => {
      if (left.preview !== right.preview) return left.preview ? -1 : 1;
      if (left.dirty !== right.dirty) return left.dirty ? 1 : -1;
      return left.lastUsedAt - right.lastUsedAt;
    })
    .slice(0, overflow)
    .map((entry) => entry.key);
  if (evictable.length === 0) {
    return {
      kind: "over-limit-protected",
      reason: `Tab limit (${policy.limitPerLeaf}) reached with no closable tab — all tabs are pinned or have unsaved changes`,
    };
  }
  return { kind: "evicted", evictedKeys: evictable };
}

/**
 * Display order for one leaf's tabs. MRU order stays untouched in storage —
 * alphabetical/display orders are projections only (§8.18.5).
 */
export function orderTabsForDisplay(
  keys: readonly string[],
  meta: ReadonlyMap<string, TabEvictionMeta>,
  policy: AnyWorkspaceTabPolicy,
): readonly string[] {
  if (policy.order === "open-order") return keys;
  const sorted = [...keys].sort((left, right) => {
    const leftMeta = meta.get(left);
    const rightMeta = meta.get(right);
    if (!leftMeta || !rightMeta) return 0;
    if (policy.pinnedRow === "separate") {
      if (leftMeta.pinned !== rightMeta.pinned) return leftMeta.pinned ? -1 : 1;
    }
    if (policy.order === "alphabetical") {
      return left.localeCompare(right);
    }
    // mru projection: most recent first.
    return rightMeta.lastUsedAt - leftMeta.lastUsedAt;
  });
  return sorted;
}

/**
 * Which neighbor becomes active after closing `closedKey` under the policy.
 * Returns null when the closed key was not active.
 */
export function selectActivateOnClose(
  keys: readonly string[],
  closedKey: string,
  activeKey: string | null,
  lastUsedByKey: ReadonlyMap<string, number>,
  policy: AnyWorkspaceTabPolicy,
): string | null {
  if (activeKey !== closedKey) return null;
  const index = keys.indexOf(closedKey);
  const remaining = keys.filter((key) => key !== closedKey);
  if (remaining.length === 0) return null;
  if (policy.activateOnClose === "left") {
    return remaining[Math.max(0, index - 1)] ?? remaining[0];
  }
  if (policy.activateOnClose === "right") {
    return remaining[Math.min(index, remaining.length - 1)];
  }
  // mru: most recently used among the survivors.
  let best: string | null = null;
  let bestUsedAt = -1;
  for (const key of remaining) {
    const usedAt = lastUsedByKey.get(key) ?? 0;
    if (usedAt > bestUsedAt) {
      bestUsedAt = usedAt;
      best = key;
    }
  }
  return best ?? remaining[0];
}

// ---------------------------------------------------------------------------
// Closed-tab reopen stack (§8.18.5, session-only, never persisted to disk)
// ---------------------------------------------------------------------------

export const CLOSED_TAB_STACK_LIMIT = 50;

export interface ClosedTabEntry {
  /** Stable identity (`root:<rootId>:<path>` / `loose:<id>:<path>`). */
  fileIdentity: string;
  ref: unknown;
  title: string;
  subtitle: string;
  leafPath: readonly string[];
  closedAt: number;
}

export interface ClosedTabEntry {
  /** Stable identity (`root:<rootId>:<path>` / `loose:<id>:<path>`). */
  fileIdentity: string;
  ref: unknown;
  title: string;
  subtitle: string;
  leafPath: readonly string[];
  closedAt: number;
  /**
   * §8.19.6 structured relocation evidence captured at close time; entries
   * without one fall back to plain reactivation.
   */
  location?: ReopenLocationV2;
}

/**
 * §8.19.6 structured location of a closed tab, resolved against the CURRENT
 * tree at reopen time so splits closed/reshuffled afterwards still land the
 * file in the closest surviving editor.
 */
export interface ReopenLocationV2 {
  /** Leaf that owned the tab at close time (may no longer exist). */
  leafId: string | null;
  /** Child-index route from the root, recorded as first/second steps. */
  treeRoute: readonly ("first" | "second")[];
  /** Other tabs that shared the closed tab's leaf — relocation evidence. */
  siblingFileKeys: readonly string[];
}

/** Record the root→leaf child-index route as first/second steps. */
export function buildReopenTreeRoute(
  tree: LayoutNode,
  leafId: string,
): ReadonlyArray<"first" | "second"> {
  const route: Array<"first" | "second"> = [];
  let node: LayoutNode = tree;
  while (node.type === "split") {
    const index = node.children.findIndex((child) => containsLeaf(child, leafId));
    if (index < 0) break;
    route.push(index === 0 ? "first" : "second");
    node = node.children[Math.min(Math.max(index, 0), node.children.length - 1)];
  }
  return route;
}

function containsLeaf(node: LayoutNode, leafId: string): boolean {
  if (node.type === "leaf") return node.id === leafId;
  return node.children.some((child) => containsLeaf(child, leafId));
}

export type ReopenResolution =
  | { kind: "restored"; leafId: string }
  | { kind: "relocated"; leafId: string; reason: "route" | "sibling" | "active" };

/**
 * Resolve where a closed tab should reopen against the LIVE tree (§8.19.6
 * order): original leafId → nearest surviving ancestor along treeRoute →
 * leaf owning the most siblingFileKeys → active leaf. Always resolves to a
 * real leaf of a non-empty tree.
 */
export function resolveReopenLocation(
  tree: LayoutNode,
  location: ReopenLocationV2,
  activeLeafId: string | null,
): ReopenResolution {
  const leaves = getAllLeafNodes(tree);
  if (leaves.length === 0) {
    // Unreachable while §8.16.4 guarantees a materialized single-leaf tree.
    throw new Error("resolveReopenLocation requires a non-empty layout tree");
  }
  if (location.leafId != null) {
    const original = leaves.find((leaf) => leaf.id === location.leafId);
    if (original) return { kind: "restored", leafId: original.id };
  }

  // Nearest surviving ancestor along the recorded route — only counts as a
  // route match when we actually DESCENDED from the root; a fully-collapsed
  // tree carries no route signal and defers to sibling/active evidence.
  let node: LayoutNode = tree;
  let descended = false;
  for (const step of location.treeRoute) {
    if (node.type !== "split") break;
    const index = step === "first" ? 0 : Math.min(1, node.children.length - 1);
    const next = node.children[index];
    if (!next) break;
    node = next;
    descended = true;
  }
  if (descended) {
    const byRoute = node.type === "leaf"
      ? node
      : getAllLeafNodes(node)[0] ?? null;
    if (byRoute) return { kind: "relocated", leafId: byRoute.id, reason: "route" };
  }

  // Leaf currently owning the most sibling tabs.
  let best: LeafGroupNode | null = null;
  let bestCount = 0;
  for (const leaf of leaves) {
    const count = leaf.openFileKeys.filter((key) => location.siblingFileKeys.includes(key)).length;
    if (count > bestCount) {
      bestCount = count;
      best = leaf;
    }
  }
  if (best) return { kind: "relocated", leafId: best.id, reason: "sibling" };

  const fallback = leaves.find((leaf) => leaf.id === activeLeafId) ?? leaves[0];
  return { kind: "relocated", leafId: fallback!.id, reason: "active" };
}

/**
 * Push onto the reopen stack with the session cap. Returns the new stack so
 * callers stay pure.
 */
export function pushClosedTab(
  stack: readonly ClosedTabEntry[],
  entry: ClosedTabEntry,
): readonly ClosedTabEntry[] {
  const next = [entry, ...stack.filter((existing) => existing.fileIdentity !== entry.fileIdentity)];
  return next.slice(0, CLOSED_TAB_STACK_LIMIT);
}

// ---------------------------------------------------------------------------
// §8.21.3 V2-B: Tab Policy Transaction
// ---------------------------------------------------------------------------

export interface ApplyWorkspaceTabPolicyInput {
  rawPolicy: unknown;
  editorGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }>;
  openFiles: Record<string, { dirty?: boolean; title?: string }>;
  mruFileKeys: readonly string[];
  allowDirtyCandidates?: boolean;
}

export interface ApplyWorkspaceTabPolicyExecution {
  policy: WorkspaceTabPolicyV3;
  evictionsByGroup: Record<string, readonly string[]>;
  allEvictedKeys: readonly string[];
  protectedCount: number;
  message: string;
}

/**
 * §8.21.3 V2-B: Transactional helper that normalizes the policy draft,
 * evaluates eviction candidates per leaf group with dirty/pinned protection,
 * and compiles the resulting eviction schedule.
 */
export function computeWorkspaceTabPolicyApplication(
  input: ApplyWorkspaceTabPolicyInput,
): ApplyWorkspaceTabPolicyExecution {
  const { policy } = migrateWorkspaceTabPolicy(input.rawPolicy);
  const normalizedPolicy: WorkspaceTabPolicyV3 = {
    ...policy,
    limitPerLeaf: Math.max(1, Math.min(50, Math.round(policy.limitPerLeaf))),
  };

  const evictionsByGroup: Record<string, string[]> = {};
  const allEvictedKeys: string[] = [];
  let protectedCount = 0;

  for (const [groupId, group] of Object.entries(input.editorGroups)) {
    const meta = new Map<string, TabEvictionMeta>(
      group.openOrder.map((k) => [
        k,
        {
          key: k,
          dirty: !!input.openFiles[k]?.dirty,
          pinned: group.pinnedKeys.includes(k),
          preview: group.previewKey === k,
          lastUsedAt: 1_000_000 - input.mruFileKeys.indexOf(k),
        },
      ]),
    );

    const eviction = enforceTabPolicy(group.openOrder, meta, normalizedPolicy, {
      allowDirty: input.allowDirtyCandidates,
    });
    if (eviction.kind === "evicted") {
      evictionsByGroup[groupId] = [...eviction.evictedKeys];
      allEvictedKeys.push(...eviction.evictedKeys);
    } else if (eviction.kind === "over-limit-protected") {
      protectedCount += group.openOrder.length;
    }
  }

  const message = allEvictedKeys.length > 0
    ? `Saved editor tab policy (limit: ${normalizedPolicy.limitPerLeaf}, evicted ${allEvictedKeys.length} tabs)`
    : `Saved editor tab policy (limit: ${normalizedPolicy.limitPerLeaf}, order: ${normalizedPolicy.order})`;

  return {
    policy: normalizedPolicy,
    evictionsByGroup,
    allEvictedKeys,
    protectedCount,
    message,
  };
}

export interface WorkspaceTabPolicyTransactionResult {
  status: "applied" | "no-op" | "aborted" | "stale";
  reason?: "user-cancelled" | "empty" | "layout-revision-changed";
  policy: WorkspaceTabPolicyV3;
  evictedKeysByGroup: Record<string, readonly string[]>;
  allEvictedKeys: readonly string[];
  message: string;
}

/**
 * §8.23.3 X2: Top-level atomic tab policy transaction.
 * Pre-computes evictions across all groups, confirms dirty closures asynchronously,
 * aborts without partial mutations if cancelled or layout is stale, commits policy
 * on zero-eviction policy changes, and closes evicted files completely through lifecycle.
 */
export async function applyWorkspaceTabPolicyTransaction(params: {
  workspaceInstanceId: string;
  nextPolicyRaw: unknown;
  currentPolicy?: WorkspaceTabPolicyV3;
  baseLayoutRevision?: number;
  currentLayoutRevision?: number;
  currentGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }>;
  openFiles: Record<string, { dirty?: boolean; title?: string; text?: string }>;
  mruFileKeys: readonly string[];
  allowDirtyCandidates?: boolean;
  confirmDirtyClose?: (dirtyKeys: readonly string[]) => Promise<boolean>;
  onEvictClosedFile?: (fileKey: string) => Promise<void> | void;
  commitAtomicUpdate: (result: {
    nextGroups: Record<string, {
      openOrder: readonly string[];
      pinnedKeys: readonly string[];
      previewKey: string | null;
      activeKey: string | null;
    }>;
    evictedKeys: readonly string[];
    policy: WorkspaceTabPolicyV3;
  }) => void;
}): Promise<WorkspaceTabPolicyTransactionResult> {
  // Stale check
  if (
    params.baseLayoutRevision != null &&
    params.currentLayoutRevision != null &&
    params.baseLayoutRevision !== params.currentLayoutRevision
  ) {
    const { policy } = migrateWorkspaceTabPolicy(params.nextPolicyRaw);
    return {
      status: "stale",
      reason: "layout-revision-changed",
      policy,
      evictedKeysByGroup: {},
      allEvictedKeys: [],
      message: "Layout changed concurrently; tab policy application aborted",
    };
  }

  const execution = computeWorkspaceTabPolicyApplication({
    rawPolicy: params.nextPolicyRaw,
    editorGroups: params.currentGroups,
    openFiles: params.openFiles,
    mruFileKeys: params.mruFileKeys,
    allowDirtyCandidates: params.allowDirtyCandidates ?? Boolean(params.confirmDirtyClose),
  });

  if (execution.allEvictedKeys.length === 0) {
    const policyChanged =
      !params.currentPolicy ||
      JSON.stringify(params.currentPolicy) !== JSON.stringify(execution.policy);

    if (policyChanged) {
      params.commitAtomicUpdate({
        nextGroups: params.currentGroups,
        evictedKeys: [],
        policy: execution.policy,
      });
      return {
        status: "applied",
        policy: execution.policy,
        evictedKeysByGroup: {},
        allEvictedKeys: [],
        message: "Tab policy updated successfully with 0 evictions",
      };
    }

    return {
      status: "no-op",
      policy: execution.policy,
      evictedKeysByGroup: {},
      allEvictedKeys: [],
      message: execution.message,
    };
  }

  // Pre-check for any dirty evicted keys across all groups
  const dirtyEvictedKeys = execution.allEvictedKeys.filter(
    (k) => params.openFiles[k]?.dirty,
  );

  if (dirtyEvictedKeys.length > 0 && params.confirmDirtyClose) {
    const confirmed = await params.confirmDirtyClose(dirtyEvictedKeys);
    if (!confirmed) {
      return {
        status: "aborted",
        reason: "user-cancelled",
        policy: execution.policy,
        evictedKeysByGroup: {},
        allEvictedKeys: [],
        message: "Tab policy application cancelled: dirty tabs preserved",
      };
    }
  }

  // Atomically compute new group state for all groups
  const nextGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }> = {};

  for (const [groupId, group] of Object.entries(params.currentGroups)) {
    const evicted = execution.evictionsByGroup[groupId] ?? [];
    const remainingOpenOrder = group.openOrder.filter((k) => !evicted.includes(k));
    const nextActive = group.activeKey && evicted.includes(group.activeKey)
      ? remainingOpenOrder[remainingOpenOrder.length - 1] ?? null
      : group.activeKey;
    const nextPreview = group.previewKey && evicted.includes(group.previewKey)
      ? null
      : group.previewKey;

    nextGroups[groupId] = {
      openOrder: remainingOpenOrder,
      pinnedKeys: group.pinnedKeys.filter((k) => !evicted.includes(k)),
      activeKey: nextActive,
      previewKey: nextPreview,
    };
  }

  // Purge closed files via lifecycle only when unreferenced in post-commit nextGroups
  if (params.onEvictClosedFile) {
    const allRemainingKeys = new Set(
      Object.values(nextGroups).flatMap((g) => g.openOrder)
    );
    for (const evictedKey of execution.allEvictedKeys) {
      if (!allRemainingKeys.has(evictedKey)) {
        await params.onEvictClosedFile(evictedKey);
      }
    }
  }

  // Single atomic store commit
  params.commitAtomicUpdate({
    nextGroups,
    evictedKeys: execution.allEvictedKeys,
    policy: execution.policy,
  });

  return {
    status: "applied",
    policy: execution.policy,
    evictedKeysByGroup: execution.evictionsByGroup,
    allEvictedKeys: execution.allEvictedKeys,
    message: execution.message,
  };
}

