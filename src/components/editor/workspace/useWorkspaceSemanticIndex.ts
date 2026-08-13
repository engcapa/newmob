import { useCallback, useEffect, useRef, useState } from "react";
import {
  abandonWorkspaceSemanticIndexBuild,
  beginWorkspaceSemanticIndexBuild,
  completeWorkspaceSemanticIndexBuild,
  createWorkspaceSemanticIndexSnapshot,
  failWorkspaceSemanticIndexBuild,
  invalidateWorkspaceSemanticIndex,
  recordWorkspaceSemanticIndexQuery,
  setWorkspaceSemanticIndexActiveProviders,
  type WorkspaceSemanticIndexBuildToken,
  type WorkspaceSemanticIndexInvalidationReason,
  type WorkspaceSemanticIndexProvider,
  type WorkspaceSemanticIndexQuery,
  type WorkspaceSemanticIndexSnapshot,
} from "./workspaceSemanticIndex";

export interface WorkspaceSemanticIndexController {
  snapshot: WorkspaceSemanticIndexSnapshot;
  current: () => WorkspaceSemanticIndexSnapshot;
  invalidate: (
    reason: WorkspaceSemanticIndexInvalidationReason,
    paths?: readonly string[],
  ) => WorkspaceSemanticIndexSnapshot;
  /** Advance the consistency revision without forcing a React render. */
  invalidateSilently: (
    reason: WorkspaceSemanticIndexInvalidationReason,
    paths?: readonly string[],
  ) => WorkspaceSemanticIndexSnapshot;
  publishCurrent: () => void;
  beginBuild: (provider: WorkspaceSemanticIndexProvider) => WorkspaceSemanticIndexBuildToken;
  abandonBuild: (
    token: WorkspaceSemanticIndexBuildToken,
  ) => WorkspaceSemanticIndexSnapshot;
  failBuild: (
    token: WorkspaceSemanticIndexBuildToken,
    error: string,
  ) => WorkspaceSemanticIndexSnapshot;
  finishQuery: (
    token: WorkspaceSemanticIndexBuildToken,
    query: Omit<WorkspaceSemanticIndexQuery, "generation" | "completedAt" | "provider">,
  ) => WorkspaceSemanticIndexQueryCompletion;
  setActiveProviders: (providerKeys: readonly string[]) => WorkspaceSemanticIndexSnapshot;
}

export interface WorkspaceSemanticIndexQueryCompletion {
  /** True when the query's workspace revision is still current. */
  accepted: boolean;
  snapshot: WorkspaceSemanticIndexSnapshot;
}

/**
 * Owns semantic-result provenance for one workspace. The snapshot is an
 * explicit consistency contract around provider-backed LSP data; it is not a
 * claim that Taomni has an IntelliJ PSI/stub index.
 */
export function useWorkspaceSemanticIndex(
  workspaceInstanceId: string,
): WorkspaceSemanticIndexController {
  const [snapshot, setSnapshot] = useState(createWorkspaceSemanticIndexSnapshot);
  const snapshotRef = useRef(snapshot);
  const workspaceIdRef = useRef(workspaceInstanceId);

  const publish = useCallback((
    update: (current: WorkspaceSemanticIndexSnapshot) => WorkspaceSemanticIndexSnapshot,
  ): WorkspaceSemanticIndexSnapshot => {
    const next = update(snapshotRef.current);
    if (next !== snapshotRef.current) {
      snapshotRef.current = next;
      setSnapshot(next);
    }
    return next;
  }, []);

  useEffect(() => {
    if (workspaceIdRef.current === workspaceInstanceId) return;
    workspaceIdRef.current = workspaceInstanceId;
    const next = createWorkspaceSemanticIndexSnapshot();
    snapshotRef.current = next;
    setSnapshot(next);
  }, [workspaceInstanceId]);

  const current = useCallback(() => snapshotRef.current, []);
  const invalidate = useCallback((
    reason: WorkspaceSemanticIndexInvalidationReason,
    paths: readonly string[] = [],
  ) => publish((value) => invalidateWorkspaceSemanticIndex(value, reason, paths)), [publish]);
  const invalidateSilently = useCallback((
    reason: WorkspaceSemanticIndexInvalidationReason,
    paths: readonly string[] = [],
  ) => {
    const next = invalidateWorkspaceSemanticIndex(snapshotRef.current, reason, paths);
    snapshotRef.current = next;
    return next;
  }, []);
  const publishCurrent = useCallback(() => {
    setSnapshot(snapshotRef.current);
  }, []);
  const beginBuild = useCallback((provider: WorkspaceSemanticIndexProvider) => {
    let token: WorkspaceSemanticIndexBuildToken | null = null;
    publish((value) => {
      const build = beginWorkspaceSemanticIndexBuild(value, provider);
      token = build.token;
      return build.snapshot;
    });
    return token!;
  }, [publish]);
  const abandonBuild = useCallback((token: WorkspaceSemanticIndexBuildToken) => (
    publish((value) => abandonWorkspaceSemanticIndexBuild(value, token))
  ), [publish]);
  const failBuild = useCallback((token: WorkspaceSemanticIndexBuildToken, error: string) => (
    publish((value) => failWorkspaceSemanticIndexBuild(value, token, error))
  ), [publish]);
  const finishQuery = useCallback((
    token: WorkspaceSemanticIndexBuildToken,
    query: Omit<WorkspaceSemanticIndexQuery, "generation" | "completedAt" | "provider">,
  ): WorkspaceSemanticIndexQueryCompletion => {
    let accepted = false;
    const next = publish((value) => {
      if (value.revision !== token.revision) {
        if (value.generation !== token.generation) return value;
        return recordWorkspaceSemanticIndexQuery(
          completeWorkspaceSemanticIndexBuild(value, token),
          query,
        );
      }
      accepted = true;
      if (value.generation !== token.generation) {
        // A newer query owns the visible generation and last-query metadata,
        // but this provider response still proves the unchanged revision was
        // processed. Keep both results usable without letting the older one
        // overwrite newer UI provenance.
        return {
          ...value,
          provider: "language-server",
          indexedRevision: token.revision,
          staleReasons: value.activeProviders.length > 0 ? ["provider-progress"] : [],
          invalidatedPaths: [],
        };
      }
      return recordWorkspaceSemanticIndexQuery(
        completeWorkspaceSemanticIndexBuild(value, token),
        query,
      );
    });
    return { accepted, snapshot: next };
  }, [publish]);
  const setActiveProviders = useCallback((providerKeys: readonly string[]) => (
    publish((value) => setWorkspaceSemanticIndexActiveProviders(value, providerKeys))
  ), [publish]);

  return {
    snapshot,
    current,
    invalidate,
    invalidateSilently,
    publishCurrent,
    beginBuild,
    abandonBuild,
    failBuild,
    finishQuery,
    setActiveProviders,
  };
}
