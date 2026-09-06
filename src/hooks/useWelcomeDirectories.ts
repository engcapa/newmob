import { useCallback, useEffect, useRef, useState } from "react";
import {
  listCommonLocalDirectories,
  listenWelcomeDirectoriesChanged,
  type LocalDirectoryShortcut,
} from "../lib/ipc";

export type WelcomeDirectoriesStatus =
  | "loading"
  | "ready"
  | "error";

export interface WelcomeDirectoriesState {
  directories: LocalDirectoryShortcut[];
  status: WelcomeDirectoriesStatus;
  /** Last load/refresh error message; empty when ready. */
  error: string | null;
  reload: () => void;
}

/**
 * Loads the backend-sorted Welcome directory listing.
 *
 * Contract (design §4.1.5):
 * - The backend order is authoritative; the hook never re-sorts.
 * - Load errors keep the last successful array and surface a retry.
 * - `welcome-directories-changed` events merge rapid refreshes while the
 *   Welcome tab is visible and mark dirty while hidden (loaded on activate).
 * - Request sequence numbers stop stale responses from overwriting newer
 *   data, and the event listener is released on unmount.
 */
export function useWelcomeDirectories(active: boolean): WelcomeDirectoriesState {
  const [directories, setDirectories] = useState<LocalDirectoryShortcut[]>([]);
  const [status, setStatus] = useState<WelcomeDirectoriesStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const requestSeqRef = useRef(0);
  const dirtyRef = useRef(false);
  const visibleRef = useRef(active);
  const revisionRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);

  visibleRef.current = active;

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const response = await listCommonLocalDirectories();
      // The ipc wrapper normalizes to {directories, revision}; tolerate a raw
      // array (older wrappers/fixtures) so a malformed shape can't blank the
      // list.
      const next = Array.isArray(response)
        ? response
        : Array.isArray(response?.directories)
          ? response.directories
          : [];
      const revision = Array.isArray(response) ? 0 : (response?.revision ?? 0);
      if (requestSeqRef.current !== seq) return; // stale response
      setDirectories(next);
      revisionRef.current = revision;
      dirtyRef.current = false;
      setStatus("ready");
      setError(null);
    } catch (err) {
      if (requestSeqRef.current !== seq) return;
      // Keep the last successful list; only a first-load failure shows the
      // error state instead of a fake empty list.
      setStatus((prev) => (prev === "ready" ? "ready" : "error"));
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      dirtyRef.current = true;
      return;
    }
    void load();
  }, [active, reloadTick, load]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const scheduleRefresh = () => {
      if (!visibleRef.current) {
        dirtyRef.current = true;
        return;
      }
      // Merge bursts of revision events into one refresh.
      if (refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void load();
      }, 150);
    };

    listenWelcomeDirectoriesChanged((revision) => {
      if (cancelled) return;
      if (revision && revision <= revisionRef.current) return;
      scheduleRefresh();
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load]);

  const reload = useCallback(() => {
    setReloadTick((tick) => tick + 1);
  }, []);

  return { directories, status, error, reload };
}
