import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  historyAppend as ipcHistoryAppend,
  historyClear as ipcHistoryClear,
  historyListRecent,
} from "./ipc";

const PREWARM_LIMIT = 500;

export interface CommandHistory {
  /** Returns up to `limit` items whose prefix matches `prefix`, most-recent first. */
  match: (prefix: string, limit?: number) => string[];
  /** Records the command as "just used". Updates cache + DB async. */
  commit: (command: string) => void;
  /** Drops the history for the current host only. */
  clearHost: () => Promise<void>;
  /** Drops history for every host. */
  clearAll: () => Promise<void>;
}

/**
 * Keeps an in-memory, recency-ordered list of the top-N recent commands for
 * `hostKey` and answers prefix queries from it. Cheap + offline.
 *
 * Cache is scoped to this hook instance (per-tab). Multiple tabs on the same
 * host each prewarm their own copy; that's fine — DB is the source of truth
 * and `commit` updates both.
 */
export function useCommandHistory(hostKey: string, maxEntries: number): CommandHistory {
  // The ref is the authoritative cache: mutations visible within the same tick,
  // so a command committed on Enter is matchable on the very next keystroke.
  // `cacheVersion` just forces re-render when the list changes, so consumers'
  // effects (e.g. refreshSuggestion after prewarm) rerun.
  const cacheRef = useRef<string[]>([]);
  const [, setCacheVersion] = useState(0);
  const bumpCache = useCallback(() => setCacheVersion((v) => v + 1), []);
  const hostKeyRef = useRef(hostKey);
  const maxRef = useRef(maxEntries);

  useEffect(() => {
    hostKeyRef.current = hostKey;
    maxRef.current = maxEntries;
  }, [hostKey, maxEntries]);

  useEffect(() => {
    let cancelled = false;
    cacheRef.current = [];
    bumpCache();
    historyListRecent(hostKey, PREWARM_LIMIT)
      .then((items) => {
        if (cancelled) return;
        cacheRef.current = items;
        bumpCache();
      })
      .catch(() => {
        if (cancelled) return;
        cacheRef.current = [];
        bumpCache();
      });
    return () => {
      cancelled = true;
    };
  }, [hostKey, bumpCache]);

  const match = useCallback((prefix: string, limit = 1): string[] => {
    if (!prefix) return [];
    const out: string[] = [];
    const cache = cacheRef.current;
    for (const item of cache) {
      if (item.length > prefix.length && item.startsWith(prefix)) {
        out.push(item);
        if (out.length >= limit) break;
      }
    }
    return out;
  }, []);

  const commit = useCallback((command: string) => {
    const trimmed = command.replace(/[\r\n]+$/, "");
    if (!trimmed) return;
    const prev = cacheRef.current;
    const filtered = prev.filter((c) => c !== trimmed);
    filtered.unshift(trimmed);
    cacheRef.current =
      filtered.length > PREWARM_LIMIT ? filtered.slice(0, PREWARM_LIMIT) : filtered;
    bumpCache();
    ipcHistoryAppend(hostKeyRef.current, trimmed, maxRef.current).catch(() => {
      // Persistence failure is non-fatal for UX; the in-memory cache still
      // serves this session.
    });
  }, [bumpCache]);

  const clearHost = useCallback(async () => {
    await ipcHistoryClear(hostKeyRef.current);
    cacheRef.current = [];
    bumpCache();
  }, [bumpCache]);

  const clearAll = useCallback(async () => {
    await ipcHistoryClear(null);
    cacheRef.current = [];
    bumpCache();
  }, [bumpCache]);

  return useMemo(
    () => ({ match, commit, clearHost, clearAll }),
    [match, commit, clearHost, clearAll],
  );
}

/** Build a stable host key from SSH connection info (or "local"). */
export function makeHostKey(ssh?: { host: string; port: number; username: string }): string {
  if (!ssh) return "local";
  return `ssh:${ssh.host.toLowerCase()}:${ssh.port}:${ssh.username}`;
}
