import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import {
  sftpListRemote,
  sftpListLocal,
  sftpLocalHome,
  sftpLocalDrives,
  sftpAttach,
  sftpDetach,
  sftpRealpath,
  type FileEntry,
  type AttachOptions,
} from "../lib/sftp";

/**
 * Virtual path used by the local pane on Windows to display the list of
 * available drive letters as if they were folder entries. Reaching it via
 * the breadcrumb's "Up" / Home or via the new drives picker lets users
 * jump back from `C:\foo` to a drives view without typing.
 */
export const WINDOWS_DRIVES_ROOT = "\\\\";

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
  connectionOpts?: AttachOptions;
  remote: PaneState;
  local: PaneState;
}

/**
 * Minimal per-session shape that `FilePanel` reads. Both `useSftpStore` and
 * the object-storage store satisfy this, so `FilePanel` can be driven by
 * either via its optional `store` prop.
 */
export interface FilePanelSession {
  homeDir: string | null;
  local: PaneState;
  remote: PaneState;
}

/**
 * The slice of store actions `FilePanel` invokes. Kept deliberately small so a
 * non-SFTP store (e.g. object storage) only has to implement navigation +
 * selection, not the full attach/detach lifecycle.
 */
export interface FilePanelStore {
  sessions: Record<string, FilePanelSession>;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  navigateBack: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateForward: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateUp: (sessionId: string, side: PaneSide) => Promise<void>;
  refreshPane: (sessionId: string, side: PaneSide) => Promise<void>;
  setSelection: (sessionId: string, side: PaneSide, selection: string[]) => void;
  toggleHidden: (sessionId: string, side: PaneSide) => void;
}

/** A zustand bound-store hook that exposes the {@link FilePanelStore} surface. */
export type FilePanelStoreHook = UseBoundStore<StoreApi<FilePanelStore>>;

interface SftpStoreState {
  sessions: Record<string, SftpSessionState>;
  attach: (opts: AttachOptions) => Promise<void>;
  reconnect: (sessionId: string) => Promise<void>;
  /**
   * Attach a session id to the store without opening any SFTP channel —
   * used by the embedded local file-browser tab (File session type) so it
   * can reuse the same `FilePanel` plumbing as the SFTP local pane while
   * never touching the remote side.
   */
  attachLocalOnly: (sessionId: string, initialPath?: string) => Promise<void>;
  ensureSession: (sessionId: string) => SftpSessionState;
  detach: (sessionId: string) => Promise<void>;
  /** Counterpart to `attachLocalOnly` — drops the store entry, no backend. */
  detachLocalOnly: (sessionId: string) => void;
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
  if (side === "local" && path === WINDOWS_DRIVES_ROOT) {
    // Synthesize folder-like entries from the available Windows drives so
    // the standard file-list UI (sort, double-click to enter, etc.) works
    // unchanged for the virtual drives root.
    const drives = await sftpLocalDrives();
    return drives.map<FileEntry>((d) => ({
      name: d.label,
      path: d.path,
      fileType: "dir",
      size: 0,
      mtime: 0,
      mode: 0,
      isHidden: false,
    }));
  }
  return side === "remote"
    ? sftpListRemote(sessionId, path)
    : sftpListLocal(path);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isConnectionError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("connection closed") ||
    msg.includes("socket closed") ||
    msg.includes("channel closed") ||
    // russh-sftp raises this once its background I/O task ends (dropped
    // connection / idle timeout); the backend attempts a transparent
    // reconnect, but if that fails we still want the reconnect banner.
    msg.includes("session closed") ||
    msg.includes("sender dropped") ||
    msg.includes("broken pipe") ||
    msg.includes("connection reset") ||
    msg.includes("not attached") ||
    msg.includes("not connected") ||
    msg.includes("ssh error") ||
    msg.includes("io error") ||
    msg.includes("timed out") ||
    msg.includes("eof")
  );
}

function isSftpRefreshDirectorySignal(err: unknown): boolean {
  return errorMessage(err)
    .toLowerCase()
    .includes("character is changed please refresh directory");
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
          connectionOpts: opts,
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

  attachLocalOnly: async (sessionId, initialPath) => {
    // Set up store state for a session that only uses the local pane —
    // no backend SFTP channel is opened. The remote pane stays empty and
    // unused. Refcount mirrors `attach` so the matching `detachLocalOnly`
    // tears the entry down on the last consumer.
    sessionRefCounts.set(sessionId, (sessionRefCounts.get(sessionId) ?? 0) + 1);
    if (get().sessions[sessionId]?.attached) return;

    let path = initialPath?.trim() || "";
    if (!path) {
      path = await sftpLocalHome().catch(() => "");
    }
    const entries = path
      ? await listSide(sessionId, "local", path).catch(() => [])
      : [];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? freshSession(sessionId)),
          attached: true,
          attaching: false,
          homeDir: null,
          error: null,
          remote: emptyPane(),
          local: {
            ...emptyPane(),
            path,
            entries,
            history: path ? [path] : [],
            historyIndex: path ? 0 : -1,
          },
        },
      },
    }));
  },

  detachLocalOnly: (sessionId) => {
    const remaining = (sessionRefCounts.get(sessionId) ?? 0) - 1;
    if (remaining > 0) {
      sessionRefCounts.set(sessionId, remaining);
      return;
    }
    sessionRefCounts.delete(sessionId);
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
        const nextSession = {
          ...cur,
          [side]: { ...cur[side], loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(err)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
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
      let displayErr = err;
      if (side === "remote" && isSftpRefreshDirectorySignal(err)) {
        try {
          const entries = await listSide(sessionId, side, prev.path);
          set((state) => {
            const cur = state.sessions[sessionId];
            if (!cur) return state;
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...cur,
                  [side]: {
                    ...cur[side],
                    path: prev.path,
                    entries,
                    loading: false,
                    error: null,
                    selection: [],
                  },
                },
              },
            };
          });
          return;
        } catch (refreshErr) {
          displayErr = refreshErr;
        }
      }
      const message = errorMessage(displayErr);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const nextSession = {
          ...cur,
          [side]: { ...cur[side], loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(displayErr)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
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
        const nextSession = {
          ...cur,
          [side]: { ...cur[side], loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(err)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
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
        const nextSession = {
          ...cur,
          [side]: { ...cur[side], loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(err)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
          },
        };
      });
    }
  },

  navigateUp: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const path = sess[side].path;
    if (!path || path === "/" || path === WINDOWS_DRIVES_ROOT) return;
    const isWin = path.includes("\\");
    // Going "up" from a drive root on the local Windows pane lands on
    // the synthetic drives root so the user sees C:, D:, … as folders.
    if (side === "local" && /^[A-Z]:\\?$/i.test(path)) {
      await get().navigate(sessionId, side, WINDOWS_DRIVES_ROOT);
      return;
    }
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

  reconnect: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session || !session.connectionOpts) {
      throw new Error("No connection credentials cached for this session");
    }
    await get().detach(sessionId).catch(() => {});
    await get().attach(session.connectionOpts);
  },
}));
