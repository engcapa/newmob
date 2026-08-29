import { useEffect, useRef, useState } from "react";
import { buildGitLineChanges, type GitLineChange } from "./gitEditorChrome";

export interface GitLineChangeSource {
  key: string;
  sourceKey: string;
  headText: string | null;
  bufferText: string;
}

type BuildGitLineChanges = (headText: string, bufferText: string) => GitLineChange[];

interface UseDeferredGitLineChangesOptions {
  delayMs?: number;
  buildChanges?: BuildGitLineChanges;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleWhenIdle(callback: () => void): () => void {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 1_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

function sameGitLineChanges(left: GitLineChange[], right: GitLineChange[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((change, index) => {
    const other = right[index];
    return change.kind === other?.kind
      && change.startLine === other.startLine
      && change.endLine === other.endLine
      && change.oldStartLine === other.oldStartLine
      && change.oldEndLine === other.oldEndLine
      && change.oldText === other.oldText
      && change.newText === other.newText;
  });
}

export function sameGitLineChangesByFile(
  left: Record<string, GitLineChange[]>,
  right: Record<string, GitLineChange[]>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => !!right[key] && sameGitLineChanges(left[key], right[key]));
}

export function sameGitLineChangeSources(
  left: readonly GitLineChangeSource[],
  right: readonly GitLineChangeSource[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((source, index) => {
    const other = right[index];
    return !!other
      && source.key === other.key
      && source.sourceKey === other.sourceKey
      && source.headText === other.headText
      && source.bufferText === other.bufferText;
  });
}

/**
 * Builds Git gutter changes outside the keypress render path.  A full
 * CodeMirror merge can be comparatively expensive on a large Rust source
 * file, so only visible editors are considered and the calculation waits for
 * both an editing pause and browser idle time.
 */
export function useDeferredGitLineChanges(
  sources: GitLineChangeSource[],
  {
    delayMs = 900,
    buildChanges = buildGitLineChanges,
  }: UseDeferredGitLineChangesOptions = {},
): Record<string, GitLineChange[]> {
  const [changesByFile, setChangesByFile] = useState<Record<string, GitLineChange[]>>({});
  const cacheRef = useRef(new Map<string, {
    sourceKey: string;
    bufferText: string;
    changes: GitLineChange[];
  }>());
  const scheduledSourcesRef = useRef<GitLineChangeSource[] | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelIdleRef = useRef<(() => void) | null>(null);
  const buildChangesRef = useRef(buildChanges);
  buildChangesRef.current = buildChanges;

  useEffect(() => {
    if (scheduledSourcesRef.current !== null && sameGitLineChangeSources(scheduledSourcesRef.current, sources)) {
      return;
    }

    scheduledSourcesRef.current = sources;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (cancelIdleRef.current !== null) {
      cancelIdleRef.current();
      cancelIdleRef.current = null;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      cancelIdleRef.current = scheduleWhenIdle(() => {
        cancelIdleRef.current = null;
        const currentSources = scheduledSourcesRef.current ?? sources;
        const next: Record<string, GitLineChange[]> = {};
        const nextCache = new Map<string, {
          sourceKey: string;
          bufferText: string;
          changes: GitLineChange[];
        }>();
        for (const source of currentSources) {
          if (source.headText === null) continue;
          const cached = cacheRef.current.get(source.key);
          const changes = cached
            && cached.sourceKey === source.sourceKey
            && cached.bufferText === source.bufferText
            ? cached.changes
            : buildChangesRef.current(source.headText, source.bufferText);
          next[source.key] = changes;
          nextCache.set(source.key, {
            sourceKey: source.sourceKey,
            bufferText: source.bufferText,
            changes,
          });
        }
        cacheRef.current = nextCache;
        setChangesByFile((current) => (sameGitLineChangesByFile(current, next) ? current : next));
      });
    }, delayMs);
  }, [delayMs, sources]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (cancelIdleRef.current !== null) {
        cancelIdleRef.current();
        cancelIdleRef.current = null;
      }
    };
  }, []);

  return changesByFile;
}
