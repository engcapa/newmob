import { useCallback, useEffect, useRef, useState } from "react";
import {
  listCommonLocalDirectoriesWithRevision,
  listenWelcomeDirectoriesChanged,
  type LocalDirectoryShortcut,
} from "../lib/ipc";

export interface WelcomeDirectoriesState {
  directories: LocalDirectoryShortcut[];
  revision: number;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  reload: () => void;
}

/**
 * Directory list owner for Welcome. Keeps backend order (never locale-sorts),
 * merges rapid revision events, guards stale responses, and preserves the last
 * good list on load errors with an explicit retry.
 */
export function useWelcomeDirectories(active: boolean): WelcomeDirectoriesState {
  const [directories, setDirectories] = useState<LocalDirectoryShortcut[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const requestSeq = useRef(0);
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await listCommonLocalDirectoriesWithRevision();
      if (requestSeq.current !== seq) return;
      setDirectories(response.directories);
      setRevision(response.revision);
      setDirty(false);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(String(err));
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenWelcomeDirectoriesChanged(() => {
      if (cancelled) return;
      if (pendingRefresh.current) clearTimeout(pendingRefresh.current);
      // Coalesce bursts; hidden panels mark dirty and reload on visible.
      pendingRefresh.current = setTimeout(() => {
        pendingRefresh.current = null;
        void load();
      }, 250);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      if (pendingRefresh.current) clearTimeout(pendingRefresh.current);
      unlisten?.();
    };
  }, [load]);

  return { directories, revision, loading, error, dirty, reload: load };
}
