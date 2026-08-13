export type WorkspaceSemanticIndexStatus = "building" | "ready" | "stale" | "error";

export type WorkspaceSemanticIndexProvider = "language-server" | "none";

export type WorkspaceSemanticIndexInvalidationReason =
  | "workspace-opened"
  | "roots-changed"
  | "document-edited"
  | "document-saved"
  | "external-file-change"
  | "resource-operation"
  | "workspace-edit"
  | "provider-command"
  | "language-server-restarted"
  | "provider-progress";

export interface WorkspaceSemanticIndexQuery {
  kind: "symbols" | "references" | "rename" | "safe-delete" | "code-action" | "refactor" | "analysis";
  generation: number;
  completedAt: number;
  resultCount: number | null;
  provider: WorkspaceSemanticIndexProvider;
}

export interface WorkspaceSemanticIndexSnapshot {
  status: WorkspaceSemanticIndexStatus;
  provider: WorkspaceSemanticIndexProvider;
  /** Monotonic async publication sequence; orders visible metadata, not freshness. */
  generation: number;
  /** Monotonic workspace content revision. */
  revision: number;
  /** Revision acknowledged by the latest successful provider-backed rebuild. */
  indexedRevision: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  staleReasons: WorkspaceSemanticIndexInvalidationReason[];
  /** Absolute or workspace-relative paths affected since the last ready snapshot. */
  invalidatedPaths: string[];
  /** Providers currently reporting indexing/building work through LSP progress. */
  activeProviders: string[];
  lastQuery: WorkspaceSemanticIndexQuery | null;
}

export interface WorkspaceSemanticIndexBuildToken {
  generation: number;
  revision: number;
}

export interface WorkspaceSemanticBufferVersion {
  path: string;
  text: string;
}

export const WORKSPACE_SEMANTIC_INDEX_PATH_LIMIT = 100;

export function createWorkspaceSemanticIndexSnapshot(): WorkspaceSemanticIndexSnapshot {
  return {
    status: "stale",
    provider: "none",
    generation: 0,
    revision: 0,
    indexedRevision: -1,
    startedAt: null,
    completedAt: null,
    error: null,
    staleReasons: ["workspace-opened"],
    invalidatedPaths: [],
    activeProviders: [],
    lastQuery: null,
  };
}

function appendUnique<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function appendPaths(current: readonly string[], paths: readonly string[]): string[] {
  const next = [...current];
  for (const rawPath of paths) {
    if (next.length >= WORKSPACE_SEMANTIC_INDEX_PATH_LIMIT) break;
    const path = rawPath.trim();
    if (!path || next.includes(path)) continue;
    next.push(path);
  }
  return next;
}

export function invalidateWorkspaceSemanticIndex(
  snapshot: WorkspaceSemanticIndexSnapshot,
  reason: WorkspaceSemanticIndexInvalidationReason,
  paths: readonly string[] = [],
): WorkspaceSemanticIndexSnapshot {
  return {
    ...snapshot,
    status: snapshot.status === "building" ? "building" : "stale",
    revision: snapshot.revision + 1,
    error: null,
    staleReasons: appendUnique(snapshot.staleReasons, reason),
    invalidatedPaths: appendPaths(snapshot.invalidatedPaths, paths),
  };
}

export function beginWorkspaceSemanticIndexBuild(
  snapshot: WorkspaceSemanticIndexSnapshot,
  provider: WorkspaceSemanticIndexProvider,
  now = Date.now(),
): { snapshot: WorkspaceSemanticIndexSnapshot; token: WorkspaceSemanticIndexBuildToken } {
  const generation = snapshot.generation + 1;
  return {
    snapshot: {
      ...snapshot,
      status: "building",
      provider,
      generation,
      startedAt: now,
      error: null,
    },
    token: { generation, revision: snapshot.revision },
  };
}

export function completeWorkspaceSemanticIndexBuild(
  snapshot: WorkspaceSemanticIndexSnapshot,
  token: WorkspaceSemanticIndexBuildToken,
  now = Date.now(),
): WorkspaceSemanticIndexSnapshot {
  if (snapshot.generation !== token.generation) return snapshot;
  // A file changed while the provider was rebuilding. Preserve the newer
  // invalidation instead of publishing an already-obsolete ready snapshot.
  if (snapshot.revision !== token.revision) {
    return { ...snapshot, status: "stale", completedAt: now };
  }
  if (snapshot.activeProviders.length > 0) {
    return { ...snapshot, status: "building", completedAt: now };
  }
  return {
    ...snapshot,
    status: "ready",
    indexedRevision: token.revision,
    completedAt: now,
    error: null,
    staleReasons: [],
    invalidatedPaths: [],
  };
}

export function abandonWorkspaceSemanticIndexBuild(
  snapshot: WorkspaceSemanticIndexSnapshot,
  token: WorkspaceSemanticIndexBuildToken,
  now = Date.now(),
): WorkspaceSemanticIndexSnapshot {
  if (snapshot.generation !== token.generation) return snapshot;
  const current = snapshot.indexedRevision === snapshot.revision
    && snapshot.provider === "language-server"
    && snapshot.activeProviders.length === 0
    && snapshot.staleReasons.length === 0;
  return {
    ...snapshot,
    status: snapshot.activeProviders.length > 0 ? "building" : current ? "ready" : "stale",
    completedAt: now,
    error: null,
  };
}

export function failWorkspaceSemanticIndexBuild(
  snapshot: WorkspaceSemanticIndexSnapshot,
  token: WorkspaceSemanticIndexBuildToken,
  error: string,
  now = Date.now(),
): WorkspaceSemanticIndexSnapshot {
  if (snapshot.generation !== token.generation) return snapshot;
  if (snapshot.revision !== token.revision) {
    return { ...snapshot, status: "stale", completedAt: now };
  }
  return {
    ...snapshot,
    status: "error",
    completedAt: now,
    error: error.trim() || "Semantic index rebuild failed",
  };
}

export function setWorkspaceSemanticIndexActiveProviders(
  snapshot: WorkspaceSemanticIndexSnapshot,
  providerKeys: readonly string[],
): WorkspaceSemanticIndexSnapshot {
  const activeProviders = [...new Set(providerKeys.map((key) => key.trim()).filter(Boolean))];
  if (activeProviders.length === snapshot.activeProviders.length
    && activeProviders.every((provider, index) => provider === snapshot.activeProviders[index])) {
    return snapshot;
  }
  return {
    ...snapshot,
    activeProviders,
    status: activeProviders.length > 0
      ? "building"
      : snapshot.activeProviders.length > 0
        ? "stale"
        : snapshot.status,
    staleReasons: activeProviders.length > 0
      ? appendUnique(snapshot.staleReasons, "provider-progress")
      : snapshot.staleReasons,
  };
}

export function recordWorkspaceSemanticIndexQuery(
  snapshot: WorkspaceSemanticIndexSnapshot,
  query: Omit<WorkspaceSemanticIndexQuery, "generation" | "completedAt" | "provider">,
  now = Date.now(),
): WorkspaceSemanticIndexSnapshot {
  return {
    ...snapshot,
    lastQuery: {
      ...query,
      generation: snapshot.generation,
      completedAt: now,
      provider: snapshot.provider,
    },
  };
}

export function workspaceSemanticIndexIsCurrent(
  snapshot: WorkspaceSemanticIndexSnapshot,
): boolean {
  return snapshot.status === "ready"
    && snapshot.provider === "language-server"
    && snapshot.indexedRevision === snapshot.revision
    && snapshot.activeProviders.length === 0
    && snapshot.staleReasons.length === 0
    && snapshot.error === null;
}

export function workspaceSemanticIndexBuildIsCurrent(
  snapshot: WorkspaceSemanticIndexSnapshot,
  token: WorkspaceSemanticIndexBuildToken,
): boolean {
  return (snapshot.status === "ready" || snapshot.status === "building")
    && snapshot.provider === "language-server"
    && snapshot.revision === token.revision
    && snapshot.indexedRevision === token.revision
    && snapshot.activeProviders.length === 0
    && snapshot.staleReasons.length === 0;
}

export function workspaceSemanticIndexStatusLabel(
  snapshot: WorkspaceSemanticIndexSnapshot,
): string {
  if (snapshot.status === "ready") return `Ready · generation ${snapshot.generation}`;
  if (snapshot.status === "building") return `Building · generation ${snapshot.generation}`;
  if (snapshot.status === "error") return `Error · generation ${snapshot.generation}`;
  return `Stale · generation ${snapshot.generation}`;
}

/** Detect text replacements made outside CodeMirror's immediate edit path. */
export function changedWorkspaceSemanticBufferPaths(
  previous: Readonly<Record<string, WorkspaceSemanticBufferVersion>>,
  next: Readonly<Record<string, WorkspaceSemanticBufferVersion>>,
): string[] {
  const paths: string[] = [];
  for (const [key, before] of Object.entries(previous)) {
    const after = next[key];
    // Opening/closing a view does not change workspace semantic content.
    if (!after || before.text === after.text) continue;
    const path = after.path.trim() || before.path.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
