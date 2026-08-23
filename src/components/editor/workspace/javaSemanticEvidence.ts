/**
 * Java semantic capability evidence (§8.18.7 P1-C6).
 *
 * A THIN adapter over provider results: it records identity, project
 * fingerprint, grouping/filter/batch decisions and refactor evidence for the
 * usages/diagnostics/refactor ledger. It never parses source itself and
 * never claims PSI/stub-index/data-flow parity — every claim is scoped to
 * what jdtls actually returned.
 */

import type { LspLocation, LspPosition, LspRange } from "../../../lib/editor/lsp";

export interface SemanticRequestIdentity {
  workspaceId: string;
  fileKey: string;
  uri: string;
  position: LspPosition;
  documentRevision: number;
  providerGeneration: number;
  /** Composition of root/build-file/classpath/provider state; see `projectFingerprint`. */
  projectFingerprint: string;
  requestId: string;
}

/** Inputs hashed into the project fingerprint (§8.18.7). */
export interface ProjectFingerprintInputs {
  workspaceRoots: readonly string[];
  buildFileStates: readonly { path: string; hash: string | null }[];
  languageLevel: string | null;
  jdkVersion: string | null;
  classpathGeneration: string | null;
  providerGeneration: number;
}

/**
 * Deterministic fingerprint over project state. Any pom/gradle/classpath/
 * JDK/provider change produces a new generation so stale semantic results
 * are rejected before apply.
 */
export function projectFingerprint(inputs: ProjectFingerprintInputs): string {
  const parts = [
    inputs.workspaceRoots.join("|"),
    inputs.buildFileStates.map((entry) => `${entry.path}@${entry.hash ?? "null"}`).join("|"),
    inputs.languageLevel ?? "",
    inputs.jdkVersion ?? "",
    inputs.classpathGeneration ?? "",
    String(inputs.providerGeneration),
  ];
  // FNV-1a keeps this dependency-free while staying stable within a session.
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash >>>= 0;
    hash = Math.imul(hash + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  return `pf-${hash.toString(16)}-${parts.length}`;
}

export type UsageRole = "declaration" | "read" | "write" | "unknown";
export type UsageOwner = "workspace" | "dependency-source" | "decompiled" | "external";

export interface UsageItem {
  id: string;
  uri: string;
  path: string | null;
  range: LspRange;
  role: UsageRole;
  owner: UsageOwner;
  previewLine: string | null;
}

export interface UsageGroup {
  key: string;
  label: string;
  itemIds: readonly string[];
}

export interface UsageFilters {
  reads: boolean;
  writes: boolean;
  declarations: boolean;
  libraries: boolean;
}

export const DEFAULT_USAGE_FILTERS: UsageFilters = {
  reads: true,
  writes: true,
  declarations: true,
  libraries: true,
};

export interface UsageSession {
  identity: SemanticRequestIdentity;
  symbol: { name: string; kind?: string; declaration?: LspLocation };
  scope: "file" | "module" | "workspace" | "workspace-and-dependencies";
  completeness: "unavailable" | "available-partial" | "available-complete";
  items: readonly UsageItem[];
  groups: readonly UsageGroup[];
  filters: UsageFilters;
  pinned: boolean;
  state: "loading" | "ready" | "stale" | "failed";
  /** True only when the provider classifies read/write roles (rare). */
  roleClassificationAvailable: boolean;
  truncated: boolean;
  evidence: {
    providerId: string | null;
    unresolvedCount: number;
  };
}

/** Batch size for Show/Find Usages first pages (§8.18.7: batches, not silent truncation). */
export const USAGE_BATCH_SIZE = 96;

/**
 * Build a session from a raw provider locations response. Roles stay
 * `unknown` unless a future provider contract supplies classification —
 * the UI surfaces those filters as unavailable rather than guessing.
 */
export function buildUsageSession(input: {
  identity: SemanticRequestIdentity;
  symbolName: string;
  locations: readonly LspLocation[];
  isLibraryUri?: (uri: string) => boolean;
  previewLines?: ReadonlyMap<string, string>;
}): UsageSession {
  const items: UsageItem[] = input.locations.map((location, index) => ({
    id: `${input.identity.requestId}:${index}`,
    uri: location.uri,
    path: location.path ?? null,
    range: location.range,
    role: "unknown",
    owner: classifyOwner(location.uri, input.isLibraryUri),
    previewLine: location.path ? input.previewLines?.get(`${location.path}:${location.range.start.line}`) ?? null : null,
  }));
  return {
    identity: input.identity,
    symbol: { name: input.symbolName },
    scope: "workspace",
    completeness: "available-partial",
    items,
    groups: groupUsageItems(items),
    filters: { ...DEFAULT_USAGE_FILTERS },
    pinned: false,
    state: "ready",
    roleClassificationAvailable: false,
    truncated: false,
    evidence: {
      providerId: null,
      unresolvedCount: 0,
    },
  };
}

function classifyOwner(uri: string, isLibraryUri?: (uri: string) => boolean): UsageOwner {
  if (!isLibraryUri) return "workspace";
  if (/\.jar[!/]|\/jrt-fs\//i.test(uri)) return "decompiled";
  return isLibraryUri(uri) ? "dependency-source" : "workspace";
}

/** Group items by file path (the one grouping every provider can support). */
export function groupUsageItems(items: readonly UsageItem[]): UsageGroup[] {
  const byPath = new Map<string, string[]>();
  for (const item of items) {
    const key = item.path ?? item.uri;
    const list = byPath.get(key) ?? [];
    list.push(item.id);
    byPath.set(key, list);
  }
  return [...byPath.entries()].map(([key, itemIds]) => ({ key, label: key, itemIds }));
}

/**
 * Apply the filter set. When roles are unclassified (the common case) the
 * read/write/declaration toggles cannot remove anything — callers must keep
 * them disabled in the UI instead of pretending they filtered.
 */
export function applyUsageFilters(
  session: UsageSession,
  filters: Partial<UsageFilters> = {},
): { visibleIds: ReadonlySet<string>; effectiveFilters: UsageFilters } {
  const merged: UsageFilters = { ...session.filters, ...filters };
  const visibleIds = new Set<string>();
  for (const item of session.items) {
    if (!merged.libraries && item.owner !== "workspace") continue;
    if (
      session.roleClassificationAvailable
      && ((item.role === "read" && !merged.reads)
        || (item.role === "write" && !merged.writes)
        || (item.role === "declaration" && !merged.declarations))
    ) {
      continue;
    }
    visibleIds.add(item.id);
  }
  return { visibleIds, effectiveFilters: merged };
}

/**
 * Windowed access over the visible set: each page carries an explicit
 * `hasMore` so the UI shows a Continue affordance instead of a silent cap.
 */
export function usageBatch(
  session: UsageSession,
  visibleIds: ReadonlySet<string>,
  cursor: number = 0,
): { items: readonly UsageItem[]; nextCursor: number | null; totalVisible: number } {
  const visible = session.items.filter((item) => visibleIds.has(item.id));
  const page = visible.slice(cursor, cursor + USAGE_BATCH_SIZE);
  const nextCursor = cursor + USAGE_BATCH_SIZE < visible.length ? cursor + USAGE_BATCH_SIZE : null;
  return { items: page, nextCursor, totalVisible: visible.length };
}

// ---------------------------------------------------------------------------
// Refactor evidence (§8.18.7)
// ---------------------------------------------------------------------------

export interface RefactorConflict {
  severity: "warning" | "error";
  message: string;
  location?: LspLocation;
}

export interface RefactorEvidence {
  actionId: string;
  kind: string;
  identity: SemanticRequestIdentity;
  scope: "selection" | "file" | "module" | "workspace";
  completeness: "unavailable" | "available-partial" | "available-complete";
  conflicts: readonly RefactorConflict[];
  /** Per-URI revision coverage captured BEFORE apply; apply re-validates. */
  editRevisionCoverage: readonly { uri: string; version: number | null }[];
}

/**
 * Hard gate (§8.18.7): Safe Delete without complete reference knowledge or
 * with external/dependency targets must refuse to apply.
 */
export function safeDeleteBlocked(evidence: RefactorEvidence): string | null {
  if (evidence.completeness !== "available-complete") {
    return "Safe Delete needs complete reference knowledge; the provider did not report completeness";
  }
  const blockingConflict = evidence.conflicts.find((conflict) => conflict.severity === "error");
  if (blockingConflict) return blockingConflict.message;
  return null;
}

/** Error-severity conflicts forbid apply outright; warnings need user confirm. */
export function refactorApplyGate(evidence: RefactorEvidence): { allowed: boolean; requiresConfirm: boolean; reason: string | null } {
  const error = evidence.conflicts.find((conflict) => conflict.severity === "error");
  if (error) return { allowed: false, requiresConfirm: false, reason: error.message };
  const warning = evidence.conflicts.find((conflict) => conflict.severity === "warning");
  return { allowed: true, requiresConfirm: !!warning, reason: warning?.message ?? null };
}
