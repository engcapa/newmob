/**
 * Workspace tab policy model (§8.18.5 P0-C4).
 *
 * Pure reducer helpers for IDEA-like editor-tab behaviour: per-leaf limits
 * that never silently close dirty/pinned tabs, display ordering independent
 * of MRU, and the closed-tabs reopen stack. The store owns state; this module
 * only computes decisions so property tests can pin the semantics.
 */

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
): TabEvictionResult {
  if (policy.limitPerLeaf <= 0 || keys.length <= policy.limitPerLeaf) {
    return { kind: "within-limit" };
  }
  const overflow = keys.length - policy.limitPerLeaf;
  const evictable = [...keys]
    .reverse()
    .map((key) => meta.get(key))
    .filter((entry): entry is TabEvictionMeta => !!entry)
    .filter((entry) => !entry.dirty && !entry.pinned)
    .sort((left, right) => {
      if (left.preview !== right.preview) return left.preview ? -1 : 1;
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
