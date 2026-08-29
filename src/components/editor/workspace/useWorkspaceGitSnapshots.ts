import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceDetectGitRoots,
  type WorkspaceGitRoot,
} from "../../../lib/editor/workspace";
import { gitSnapshot } from "../../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../../lib/gitRefresh";
import type { CodeWorkspaceRootInfo } from "../../../types";
import {
  errorMessage,
  gitRootForWorkspacePath,
  type WorkspaceGitSnapshotState,
} from "./codeWorkspaceModel";

interface UseWorkspaceGitSnapshotsOptions {
  roots: CodeWorkspaceRootInfo[];
  onError: (message: string) => void;
  visible?: boolean;
}

export interface WorkspaceGitSnapshotsController {
  gitRoots: WorkspaceGitRoot[];
  gitRootsLoading: boolean;
  gitSnapshots: Record<string, WorkspaceGitSnapshotState>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
}

const gitSnapshotInFlight = new Map<string, Promise<Awaited<ReturnType<typeof gitSnapshot>>>>();

export function fetchGitSnapshotDeduplicated(repoRoot: string): Promise<Awaited<ReturnType<typeof gitSnapshot>>> {
  const existing = gitSnapshotInFlight.get(repoRoot);
  if (existing) return existing;

  const promise = gitSnapshot(repoRoot).finally(() => {
    if (gitSnapshotInFlight.get(repoRoot) === promise) {
      gitSnapshotInFlight.delete(repoRoot);
    }
  });

  gitSnapshotInFlight.set(repoRoot, promise);
  return promise;
}

export function clearGitSnapshotInFlight(): void {
  gitSnapshotInFlight.clear();
}

function sameGitSnapshotState(a: WorkspaceGitSnapshotState | undefined, b: WorkspaceGitSnapshotState): boolean {
  if (!a) return false;
  if (a.loading !== b.loading || a.error !== b.error) return false;
  if (a.headOid !== b.headOid || a.currentBranch !== b.currentBranch) return false;
  if (a.ahead !== b.ahead || a.behind !== b.behind) return false;
  if (a.changes.length !== b.changes.length) return false;
  for (let i = 0; i < a.changes.length; i++) {
    const ca = a.changes[i];
    const cb = b.changes[i];
    if (
      ca.path !== cb.path
      || ca.status !== cb.status
      || ca.staged !== cb.staged
      || ca.unstaged !== cb.unstaged
      || ca.conflict !== cb.conflict
    ) {
      return false;
    }
  }
  return true;
}

export function useWorkspaceGitSnapshots({
  roots,
  onError,
  visible = true,
}: UseWorkspaceGitSnapshotsOptions): WorkspaceGitSnapshotsController {
  const [gitRoots, setGitRoots] = useState<WorkspaceGitRoot[]>([]);
  const [gitRootsLoading, setGitRootsLoading] = useState(false);
  const [gitSnapshots, setGitSnapshots] = useState<Record<string, WorkspaceGitSnapshotState>>({});
  const rootsRef = useRef(roots);
  const gitRootsRef = useRef(gitRoots);
  const visibleRef = useRef(visible);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    gitRootsRef.current = gitRoots;
  }, [gitRoots]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const refreshSnapshots = useCallback(async (targets = gitRootsRef.current) => {
    await Promise.all(targets.map(async (root) => {
      setGitSnapshots((current) => {
        const prev = current[root.repoRoot];
        if (prev?.loading) return current;
        return {
          ...current,
          [root.repoRoot]: {
            changes: prev?.changes ?? [],
            headOid: prev?.headOid ?? null,
            currentBranch: prev?.currentBranch ?? null,
            ahead: prev?.ahead ?? 0,
            behind: prev?.behind ?? 0,
            loading: true,
            error: null,
          },
        };
      });
      try {
        const snapshot = await fetchGitSnapshotDeduplicated(root.repoRoot);
        const nextState: WorkspaceGitSnapshotState = {
          changes: snapshot.changes,
          headOid: snapshot.headOid,
          currentBranch: snapshot.currentBranch,
          ahead: snapshot.ahead,
          behind: snapshot.behind,
          loading: false,
          error: null,
        };
        setGitSnapshots((current) => {
          if (sameGitSnapshotState(current[root.repoRoot], nextState)) return current;
          return { ...current, [root.repoRoot]: nextState };
        });
      } catch (error) {
        const err = errorMessage(error);
        setGitSnapshots((current) => {
          const prev = current[root.repoRoot];
          const nextState: WorkspaceGitSnapshotState = {
            changes: prev?.changes ?? [],
            headOid: prev?.headOid ?? null,
            currentBranch: prev?.currentBranch ?? null,
            ahead: prev?.ahead ?? 0,
            behind: prev?.behind ?? 0,
            loading: false,
            error: err,
          };
          if (sameGitSnapshotState(prev, nextState)) return current;
          return { ...current, [root.repoRoot]: nextState };
        });
      }
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (roots.length === 0) {
      gitRootsRef.current = [];
      setGitRoots([]);
      setGitRootsLoading(false);
      setGitSnapshots({});
      return () => {
        cancelled = true;
      };
    }

    setGitRootsLoading(true);
    void workspaceDetectGitRoots(roots.map((root) => ({
      id: root.id,
      name: root.name,
      path: root.path,
    }))).then((detected) => {
      if (cancelled) return;
      gitRootsRef.current = detected;
      setGitRoots(detected);
      setGitSnapshots((current) => Object.fromEntries(
        Object.entries(current).filter(([repoRoot]) => (
          detected.some((root) => root.repoRoot === repoRoot)
        )),
      ));
    }).catch((error) => {
      if (cancelled) return;
      gitRootsRef.current = [];
      setGitRoots([]);
      onError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setGitRootsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [onError, roots]);

  useEffect(() => {
    if (gitRoots.length === 0) return;
    if (!visible) return;
    void refreshSnapshots(gitRoots);
    const timer = window.setInterval(() => {
      if (visibleRef.current) {
        void refreshSnapshots(gitRootsRef.current);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [gitRoots, refreshSnapshots, visible]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    const root = gitRootsRef.current.find((item) => item.repoRoot === repoRoot);
    if (root && visibleRef.current) void refreshSnapshots([root]);
  }), [refreshSnapshots]);

  const notifyWorkspacePathGitChanged = useCallback((rootId: string, path: string) => {
    const root = rootsRef.current.find((item) => item.id === rootId);
    if (!root) return;
    const repo = gitRootForWorkspacePath(root, path, gitRootsRef.current);
    if (repo) notifyGitRepoChanged(repo.repoRoot);
  }, []);

  return {
    gitRoots,
    gitRootsLoading,
    gitSnapshots,
    notifyWorkspacePathGitChanged,
  };
}
