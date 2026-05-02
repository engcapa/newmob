import { create } from "zustand";
import {
  sftpListRemote,
  sftpListLocal,
  sftpLocalHome,
  sftpAttach,
  sftpDetach,
  sftpRealpath,
  type FileEntry,
  type AttachOptions,
} from "../lib/sftp";

export type PaneSide = "local" | "remote";

export interface PaneState {
  path: string;
  entries: FileEntry[];
  selection: string[];
  loading: boolean;
  error: string | null;
  history: string[];
  historyIndex: number;
  showHidden: boolean;
}

export interface SftpSessionState {
  sessionId: string;
  attached: boolean;
  attaching: boolean;
  homeDir: string | null;
  error: string | null;
  remote: PaneState;
  local: PaneState;
}

interface SftpStoreState {
  sessions: Record<string, SftpSessionState>;
  attach: (opts: AttachOptions) => Promise<void>;
  ensureSession: (sessionId: string) => SftpSessionState;
  detach: (sessionId: string) => Promise<void>;
  refreshPane: (sessionId: string, side: PaneSide) => Promise<void>;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  navigateBack: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateForward: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateUp: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateHome: (sessionId: string, side: PaneSide) => Promise<void>;
  setSelection: (sessionId: string, side: PaneSide, selection: string[]) => void;
  toggleHidden: (sessionId: string, side: PaneSide) => void;
  setError: (sessionId: string, error: string | null) => void;
}

function emptyPane(): PaneState {
  return {
    path: "",
    entries: [],
    selection: [],
    loading: false,
    error: null,
    history: [],
    historyIndex: -1,
    showHidden: false,
  };
}

function freshSession(sessionId: string): SftpSessionState {
  return {
    sessionId,
    attached: false,
    attaching: false,
    homeDir: null,
    error: null,
    remote: emptyPane(),
    local: emptyPane(),
  };
}

function pushHistory(pane: PaneState, path: string): PaneState {
  if (pane.history[pane.historyIndex] === path) {
    return pane;
  }
  const trimmed = pane.history.slice(0, pane.historyIndex + 1);
  trimmed.push(path);
  return {
    ...pane,
    history: trimmed,
    historyIndex: trimmed.length - 1,
  };
}

async function listSide(
  sessionId: string,
  side: PaneSide,
  path: string,
): Promise<FileEntry[]> {
  return side === "remote"
    ? sftpListRemote(sessionId, path)
    : sftpListLocal(path);
}

/**
 * Per-session reference counts. Each component that calls `attach` for a
 * session id holds one reference until it calls `detach`. The backend
 * channel + zustand entry are torn down only when the count reaches zero.
 *
 * This guards against React StrictMode double-invocation (mount → cleanup
 * → mount) where the cleanup detach would otherwise yank the channel out
 * from under the immediately-following remount attach. It also lets two
 * legitimate consumers — e.g. an attached sidebar and a detached window
 * that happen to share an `attached-${tabId}` session id — coexist
 * without one tearing down the other.
 */
const sessionRefCounts = new Map<string, number>();

/**
 * In-flight backend attach promises, keyed by session id. When a second
 * consumer calls attach before the first one finishes the backend handshake,
 * we await the same promise instead of issuing a duplicate `sftpAttach`
 * IPC call. Keeps the backend channel count at exactly one per session id
 * regardless of how many UI consumers race to mount.
 */
const inFlightAttaches = new Map<string, Promise<void>>();

export const useSftpStore = create<SftpStoreState>((set, get) => ({
  sessions: {},

  ensureSession: (sessionId) => {
    const existing = get().sessions[sessionId];
    if (existing) return existing;
    const next = freshSession(sessionId);
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: next } }));
    return next;
  },

  attach: async (opts) => {
    const sid = opts.sessionId;
    // Record this consumer up front so a concurrent unmount cleanup can't
    // race ahead and tear the session down before we finish attaching.
    sessionRefCounts.set(sid, (sessionRefCounts.get(sid) ?? 0) + 1);

    // If a backend attach is already in flight (another consumer kicked
    // it off and we got here while it was awaiting), join the same
    // promise instead of issuing a duplicate `sftpAttach`. This keeps
    // backend channel count at exactly one per session id even under
    // racing mounts and StrictMode.
    const inFlight = inFlightAttaches.get(sid);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // The original attach failed; mirror that to this caller too.
        const remaining = (sessionRefCounts.get(sid) ?? 1) - 1;
        if (remaining > 0) sessionRefCounts.set(sid, remaining);
        else sessionRefCounts.delete(sid);
        const existingErr = get().sessions[sid]?.error;
        throw new Error(existingErr ?? "SFTP attach failed");
      }
      return;
    }

    // If the channel is already attached (another consumer brought it up
    // first and we're past the in-flight phase), don't re-issue the
    // backend attach — just inherit the live session. The unconditional
    // backend re-attach was wasteful and would also blow away pane state
    // for the existing consumer.
    const existing = get().sessions[sid];
    if (existing?.attached) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sid]: {
          ...(state.sessions[sid] ?? freshSession(sid)),
          attaching: true,
          error: null,
        },
      },
    }));

    const attachPromise = (async () => {
      try {
        const result = await sftpAttach(opts);
        const home = result.homeDir || "/";
        let realHome = home;
        try {
          realHome = await sftpRealpath(sid, home);
        } catch {
          /* keep home as-is */
        }
        const localHome = await sftpLocalHome().catch(() => "");
        const remoteEntries = await sftpListRemote(sid, realHome).catch(() => []);
        const localEntries = await sftpListLocal(localHome).catch(() => []);
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sid]: {
              ...(state.sessions[sid] ?? freshSession(sid)),
              attached: true,
              attaching: false,
              homeDir: realHome,
              remote: {
                ...emptyPane(),
                path: realHome,
                entries: remoteEntries,
                history: [realHome],
                historyIndex: 0,
              },
              local: {
                ...emptyPane(),
                path: localHome,
                entries: localEntries,
                history: [localHome],
                historyIndex: 0,
              },
            },
          },
        }));
        // The session is officially up. If the refcount fell to zero
        // while we were awaiting (last consumer unmounted mid-attach),
        // tear the channel back down to honour their detach intent.
        if ((sessionRefCounts.get(sid) ?? 0) === 0) {
          try {
            await sftpDetach(sid);
          } catch (err) {
            console.warn("[sftp-store] post-attach cleanup detach failed:", err);
          }
          set((state) => {
            const next = { ...state.sessions };
            delete next[sid];
            return { sessions: next };
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sid]: {
              ...(state.sessions[sid] ?? freshSession(sid)),
              attaching: false,
              error: message,
            },
          },
        }));
        throw err;
      }
    })();
    inFlightAttaches.set(sid, attachPromise);

    try {
      await attachPromise;
    } catch (err) {
      // Roll back the refcount so a follow-up retry can attempt attach
      // again without leaking a phantom consumer.
      const remaining = (sessionRefCounts.get(sid) ?? 1) - 1;
      if (remaining > 0) sessionRefCounts.set(sid, remaining);
      else sessionRefCounts.delete(sid);
      throw err;
    } finally {
      // Always clear the in-flight slot; future attaches either inherit
      // the now-attached state or, if attach failed, kick off a fresh one.
      if (inFlightAttaches.get(sid) === attachPromise) {
        inFlightAttaches.delete(sid);
      }
    }
  },

  detach: async (sessionId) => {
    // Refcount-aware teardown: one detach call cancels one attach call.
    // The actual backend channel + store entry only go away when the
    // last consumer releases its reference, so a StrictMode cleanup
    // followed by a remount attach is safe (count goes 1 → 0 → 1 with
    // no backend side effect).
    const remaining = (sessionRefCounts.get(sessionId) ?? 0) - 1;
    if (remaining > 0) {
      sessionRefCounts.set(sessionId, remaining);
      return;
    }
    sessionRefCounts.delete(sessionId);
    // If a backend attach is mid-flight, defer to its post-attach
    // cleanup branch which will detect the zero refcount and tear down.
    // Calling sftpDetach here would race the still-running sftpAttach
    // and could leave the backend in an undefined state.
    if (inFlightAttaches.has(sessionId)) {
      return;
    }
    try {
      await sftpDetach(sessionId);
    } catch (err) {
      console.warn("[sftp-store] detach failed:", err);
    }
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    });
  },

  refreshPane: async (sessionId, side) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    const pane = session[side];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          [side]: { ...pane, loading: true, error: null },
        },
      },
    }));
    try {
      const entries = await listSide(sessionId, side, pane.path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], entries, loading: false, error: null },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], loading: false, error: message },
            },
          },
        };
      });
    }
  },

  navigate: async (sessionId, side, path) => {
    const sess = get().ensureSession(sessionId);
    const prev = sess[side];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          [side]: { ...prev, loading: true, error: null, path },
        },
      },
    }));
    try {
      const entries = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const after = pushHistory(
          { ...cur[side], path, entries, loading: false, error: null, selection: [] },
          path,
        );
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...cur, [side]: after },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], loading: false, error: message },
            },
          },
        };
      });
    }
  },

  navigateBack: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const pane = sess[side];
    if (pane.historyIndex <= 0) return;
    const idx = pane.historyIndex - 1;
    const path = pane.history[idx];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...sess,
          [side]: { ...pane, historyIndex: idx, path, loading: true },
        },
      },
    }));
    try {
      const entries = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], entries, loading: false, error: null, selection: [] },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], loading: false, error: message },
            },
          },
        };
      });
    }
  },

  navigateForward: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const pane = sess[side];
    if (pane.historyIndex >= pane.history.length - 1) return;
    const idx = pane.historyIndex + 1;
    const path = pane.history[idx];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...sess,
          [side]: { ...pane, historyIndex: idx, path, loading: true },
        },
      },
    }));
    try {
      const entries = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], entries, loading: false, error: null, selection: [] },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: { ...cur[side], loading: false, error: message },
            },
          },
        };
      });
    }
  },

  navigateUp: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const path = sess[side].path;
    const isWin = path.includes("\\");
    if (!path || path === "/" || /^[A-Z]:\\?$/i.test(path)) return;
    const sep = isWin ? "\\" : "/";
    const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
    const idx = trimmed.lastIndexOf(sep);
    let parent: string;
    if (idx <= 0) {
      parent = isWin ? path.slice(0, 3) : "/";
    } else {
      parent = trimmed.slice(0, idx);
    }
    await get().navigate(sessionId, side, parent);
  },

  navigateHome: async (sessionId, side) => {
    if (side === "remote") {
      const sess = get().sessions[sessionId];
      if (!sess?.homeDir) return;
      await get().navigate(sessionId, side, sess.homeDir);
    } else {
      const home = await sftpLocalHome().catch(() => "");
      if (home) await get().navigate(sessionId, side, home);
    }
  },

  setSelection: (sessionId, side, selection) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, [side]: { ...cur[side], selection } },
        },
      };
    });
  },

  toggleHidden: (sessionId, side) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...cur,
            [side]: { ...cur[side], showHidden: !cur[side].showHidden },
          },
        },
      };
    });
  },

  setError: (sessionId, error) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, error },
        },
      };
    });
  },
}));
