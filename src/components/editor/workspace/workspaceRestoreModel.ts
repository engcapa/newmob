import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo } from "../../../types";
import { fileRefFromFileKey } from "./workspaceLayoutPersistence";
import type { EditorGroupId, PersistedEditorGroup, WorkspaceLayoutSnapshot } from "./workspaceLayoutSnapshot";

export interface RestoreTarget {
  key: string;
  ref: CodeWorkspaceFileRef;
  groupId: EditorGroupId;
  preview: boolean;
  active: boolean;
}

export interface WorkspaceRestorePlan {
  activeTargets: RestoreTarget[];
  backgroundTargets: RestoreTarget[];
  activeGroupId: EditorGroupId | null;
}

/**
 * Plan workspace restoration with first-screen prioritization (ED-PERF-003 / PERF-4.1).
 * Active tabs of each leaf editor group are identified first for immediate load,
 * followed by remaining background tabs to be loaded with bounded concurrency.
 */
export function planWorkspaceRestore(
  snapshot: WorkspaceLayoutSnapshot,
  looseFiles: readonly CodeWorkspaceLooseFileInfo[],
): WorkspaceRestorePlan {
  const activeTargets: RestoreTarget[] = [];
  const backgroundTargets: RestoreTarget[] = [];

  const groupEntries = Object.entries(snapshot.editorGroups) as Array<[EditorGroupId, PersistedEditorGroup]>;

  for (const [groupId, group] of groupEntries) {
    if (!group) continue;
    const activeKey = group.activeKey;

    for (const key of group.openOrder) {
      const ref = fileRefFromFileKey(key, looseFiles);
      if (!ref) continue;
      const isActive = key === activeKey;
      const target: RestoreTarget = {
        key,
        ref,
        groupId,
        preview: group.previewKey === key,
        active: isActive,
      };

      if (isActive) {
        activeTargets.push(target);
      } else {
        backgroundTargets.push(target);
      }
    }
  }

  return {
    activeTargets,
    backgroundTargets,
    activeGroupId: snapshot.activeEditorGroupId ?? null,
  };
}

/**
 * Execute an async task across an array of items with a fixed concurrency window (2-4).
 */
export async function executeBoundedAsyncQueue<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency = 3,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex]!;
      results[currentIndex] = await worker(item);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const pool = Array.from({ length: poolSize }, () => runner());
  await Promise.all(pool);
  return results;
}

/**
 * Generates cache key for git line diff calculation (§8.17.4 / ED-PERF-003).
 */
export function getLineDiffCacheKey(
  filePath: string,
  headOid: string | null,
  textVersion: number,
): string {
  return `${filePath}@${headOid ?? "untracked"}:${textVersion}`;
}
