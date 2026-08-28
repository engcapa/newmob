import { create } from "zustand";
import {
  sftpListLocalDetailed,
  sftpLocalHome,
  sftpLocalDrives,
  type DirectoryListing,
  type FileEntry,
} from "../lib/sftp";
import {
  storageAttach,
  storageDetach,
  storageListBuckets,
  storageListObjects,
} from "../lib/objectStorage";
import {
  normalizeObjectStorageConfig,
  type ObjectEntry,
  type ObjectStorageConfig,
  type BucketEntry,
} from "../types/objectStorage";
import { WINDOWS_DRIVES_ROOT, type PaneSide, type PaneState } from "./sftpStore";

// Remote path scheme: "/" is the bucket-list root; "/{bucket}/{prefix...}"
// addresses a prefix inside a bucket. Folder entry paths keep a trailing "/".
export const OBJ_ROOT = "/";

/** Parse a remote path into bucket + key-prefix, or null for the bucket root. */
export function parseRemotePath(path: string): { bucket: string; prefix: string } | null {
  const trimmed = path.replace(/^\/+/, "");
  if (!trimmed) return null;
  const parts = trimmed.split("/").filter(Boolean);
  const bucket = parts[0];
  const rest = parts.slice(1).join("/");
  return { bucket, prefix: rest ? `${rest}/` : "" };
}

function mapBucket(b: BucketEntry): FileEntry {
  return {
    name: b.name,
    path: `/${b.name}`,
    size: 0,
    mtime: b.createdAt ?? 0,
    mode: 0,
    fileType: "dir",
    isHidden: false,
  };
}

function mapObject(bucket: string, e: ObjectEntry): FileEntry {
  return {
    name: e.name,
    path: `/${bucket}/${e.key}`,
    size: e.size,
    mtime: e.lastModified ?? 0,
    mode: 0,
    fileType: e.isDir ? "dir" : "file",
    isHidden: false,
  };
}

/** Cap pagination so a pathological bucket can't lock up the UI. */
const MAX_PAGES = 50;
const MAX_ENTRIES = 20000;

async function listRemote(sessionId: string, path: string): Promise<FileEntry[]> {
  const parsed = parseRemotePath(path);
  if (!parsed) {
    const buckets = await storageListBuckets(sessionId);
    return buckets.map(mapBucket);
  }
  const { bucket, prefix } = parsed;
  const out: FileEntry[] = [];
  let token: string | null = null;
  let pages = 0;
  do {
    const page = await storageListObjects(sessionId, bucket, prefix, token);
    for (const e of page.entries) out.push(mapObject(bucket, e));
    token = page.nextToken ?? null;
    pages += 1;
  } while (token && pages < MAX_PAGES && out.length < MAX_ENTRIES);
  return out;
}

async function listSide(sessionId: string, side: PaneSide, path: string): Promise<DirectoryListing> {
  if (side === "remote") {
    return {
      entries: await listRemote(sessionId, path),
      skippedCount: 0,
      diagnostics: [],
    };
  }
  if (path === WINDOWS_DRIVES_ROOT) {
    const drives = await sftpLocalDrives();
    return {
      entries: drives.map<FileEntry>((d) => ({
        name: d.label,
        path: d.path,
        fileType: "dir",
        size: 0,
        mtime: 0,
        mode: 0,
        isHidden: false,
      })),
      skippedCount: 0,
      diagnostics: [],
    };
  }
  return sftpListLocalDetailed(path);
}

export interface ObjStorageSessionState {
  sessionId: string;
  attached: boolean;
  attaching: boolean;
  homeDir: string | null;
  error: string | null;
  remote: PaneState;
  local: PaneState;
  config: ObjectStorageConfig | null;
}

interface ObjStorageStoreState {
  sessions: Record<string, ObjStorageSessionState>;
  attach: (sessionId: string, config: ObjectStorageConfig) => Promise<void>;
  detach: (sessionId: string) => Promise<void>;
  ensureSession: (sessionId: string) => ObjStorageSessionState;
  refreshPane: (sessionId: string, side: PaneSide) => Promise<void>;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  navigateBack: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateForward: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateUp: (sessionId: string, side: PaneSide) => Promise<void>;
  navigateHome: (sessionId: string, side: PaneSide) => Promise<void>;
  setSelection: (sessionId: string, side: PaneSide, selection: string[]) => void;
  toggleHidden: (sessionId: string, side: PaneSide) => void;
  upsertRemoteEntry: (sessionId: string, entry: FileEntry) => void;
  removeRemoteEntries: (sessionId: string, paths: string[]) => void;
}

function emptyPane(): PaneState {
  return {
    path: "",
    entries: [],
    selection: [],
    loading: false,
    error: null,
    skippedEntryCount: 0,
    entryDiagnostics: [],
    history: [],
    historyIndex: -1,
    showHidden: false,
  };
}

function freshSession(sessionId: string): ObjStorageSessionState {
  return {
    sessionId,
    attached: false,
    attaching: false,
    homeDir: null,
    error: null,
    remote: emptyPane(),
    local: emptyPane(),
    config: null,
  };
}

function pushHistory(pane: PaneState, path: string): PaneState {
  if (pane.history[pane.historyIndex] === path) return pane;
  const trimmed = pane.history.slice(0, pane.historyIndex + 1);
  trimmed.push(path);
  return { ...pane, history: trimmed, historyIndex: trimmed.length - 1 };
}

function upsertPaneEntry(pane: PaneState, entry: FileEntry): PaneState {
  const idx = pane.entries.findIndex((e) => e.path === entry.path);
  const entries =
    idx >= 0
      ? pane.entries.map((e, i) => (i === idx ? entry : e))
      : [...pane.entries, entry];
  return { ...pane, entries, error: null };
}

function removePaneEntries(pane: PaneState, paths: string[]): PaneState {
  const remove = new Set(paths);
  return {
    ...pane,
    entries: pane.entries.filter((e) => !remove.has(e.path)),
    selection: pane.selection.filter((path) => !remove.has(path)),
    error: null,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listingState(listing: DirectoryListing): Pick<
  PaneState,
  "entries" | "skippedEntryCount" | "entryDiagnostics"
> {
  return {
    entries: listing.entries,
    skippedEntryCount: listing.skippedCount,
    entryDiagnostics: listing.diagnostics,
  };
}

function emptyListing(): DirectoryListing {
  return { entries: [], skippedCount: 0, diagnostics: [] };
}

async function loadInitialListing(
  sessionId: string,
  side: PaneSide,
  path: string,
): Promise<{ listing: DirectoryListing; error: string | null }> {
  if (!path) return { listing: emptyListing(), error: null };
  try {
    return { listing: await listSide(sessionId, side, path), error: null };
  } catch (error) {
    return { listing: emptyListing(), error: errMsg(error) };
  }
}

const refCounts = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

// CONTINUED below — store body appended via the editor.
export const useObjectStorageStore = create<ObjStorageStoreState>((set, get) => ({
  sessions: {},

  ensureSession: (sessionId) => {
    const existing = get().sessions[sessionId];
    if (existing) return existing;
    const next = freshSession(sessionId);
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: next } }));
    return next;
  },

  attach: async (sessionId, config) => {
    const effectiveConfig = normalizeObjectStorageConfig(config);
    refCounts.set(sessionId, (refCounts.get(sessionId) ?? 0) + 1);
    const pending = inFlight.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch {
        const remaining = (refCounts.get(sessionId) ?? 1) - 1;
        if (remaining > 0) refCounts.set(sessionId, remaining);
        else refCounts.delete(sessionId);
        throw new Error(get().sessions[sessionId]?.error ?? "attach failed");
      }
      return;
    }
    if (get().sessions[sessionId]?.attached) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...(state.sessions[sessionId] ?? freshSession(sessionId)), attaching: true, error: null, config: effectiveConfig },
      },
    }));

    const attachPromise = (async () => {
      try {
        await storageAttach(sessionId, effectiveConfig);
        const home = effectiveConfig.defaultBucket || effectiveConfig.defaultContainer;
        const remotePath = home ? `/${home}` : OBJ_ROOT;
        let localHome = "";
        let localHomeError: string | null = null;
        try {
          localHome = await sftpLocalHome();
        } catch (error) {
          localHomeError = errMsg(error);
        }
        const [remoteLoad, localLoad] = await Promise.all([
          loadInitialListing(sessionId, "remote", remotePath),
          localHomeError
            ? Promise.resolve({ listing: emptyListing(), error: localHomeError })
            : loadInitialListing(sessionId, "local", localHome),
        ]);
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...(state.sessions[sessionId] ?? freshSession(sessionId)),
              attached: true,
              attaching: false,
              homeDir: remotePath,
              config: effectiveConfig,
              remote: {
                ...emptyPane(),
                path: remotePath,
                ...listingState(remoteLoad.listing),
                error: remoteLoad.error,
                history: [remotePath],
                historyIndex: 0,
              },
              local: {
                ...emptyPane(),
                path: localHome,
                ...listingState(localLoad.listing),
                error: localLoad.error,
                history: localHome ? [localHome] : [],
                historyIndex: localHome ? 0 : -1,
              },
            },
          },
        }));
        if ((refCounts.get(sessionId) ?? 0) === 0) {
          await storageDetach(sessionId).catch(() => {});
          set((state) => {
            const next = { ...state.sessions };
            delete next[sessionId];
            return { sessions: next };
          });
        }
      } catch (err) {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: { ...(state.sessions[sessionId] ?? freshSession(sessionId)), attaching: false, error: errMsg(err) },
          },
        }));
        throw err;
      }
    })();
    inFlight.set(sessionId, attachPromise);
    try {
      await attachPromise;
    } catch (err) {
      const remaining = (refCounts.get(sessionId) ?? 1) - 1;
      if (remaining > 0) refCounts.set(sessionId, remaining);
      else refCounts.delete(sessionId);
      throw err;
    } finally {
      if (inFlight.get(sessionId) === attachPromise) inFlight.delete(sessionId);
    }
  },

  detach: async (sessionId) => {
    const remaining = (refCounts.get(sessionId) ?? 0) - 1;
    if (remaining > 0) {
      refCounts.set(sessionId, remaining);
      return;
    }
    refCounts.delete(sessionId);
    if (inFlight.has(sessionId)) return;
    await storageDetach(sessionId).catch((err) => console.warn("[oss-store] detach failed:", err));
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
        [sessionId]: { ...session, [side]: { ...pane, loading: true, error: null } },
      },
    }));
    try {
      const listing = await listSide(sessionId, side, pane.path);
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
                ...listingState(listing),
                loading: false,
                error: null,
              },
            },
          },
        };
      });
    } catch (err) {
      const message = errMsg(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...cur, [side]: { ...cur[side], loading: false, error: message } },
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
          [side]: {
            ...prev,
            path,
            entries: [],
            selection: [],
            skippedEntryCount: 0,
            entryDiagnostics: [],
            loading: true,
            error: null,
          },
        },
      },
    }));
    try {
      const listing = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const after = pushHistory(
          {
            ...cur[side],
            path,
            ...listingState(listing),
            loading: false,
            error: null,
            selection: [],
          },
          path,
        );
        return { sessions: { ...state.sessions, [sessionId]: { ...cur, [side]: after } } };
      });
    } catch (err) {
      const message = errMsg(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...cur, [side]: { ...prev, loading: false, error: message } },
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
    await applyHistoryNav(set, get, sessionId, side, idx, path);
  },

  navigateForward: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const pane = sess[side];
    if (pane.historyIndex >= pane.history.length - 1) return;
    const idx = pane.historyIndex + 1;
    const path = pane.history[idx];
    await applyHistoryNav(set, get, sessionId, side, idx, path);
  },

  navigateUp: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const path = sess[side].path;
    if (!path || path === "/" || path === WINDOWS_DRIVES_ROOT) return;
    if (side === "local" && /^[A-Z]:\\?$/i.test(path)) {
      await get().navigate(sessionId, side, WINDOWS_DRIVES_ROOT);
      return;
    }
    const isWin = side === "local" && path.includes("\\");
    const sep = isWin ? "\\" : "/";
    const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
    const idx = trimmed.lastIndexOf(sep);
    let parent: string;
    if (idx <= 0) parent = isWin ? path.slice(0, 3) : "/";
    else parent = trimmed.slice(0, idx);
    await get().navigate(sessionId, side, parent);
  },

  navigateHome: async (sessionId, side) => {
    if (side === "remote") {
      const sess = get().sessions[sessionId];
      await get().navigate(sessionId, side, sess?.homeDir ?? OBJ_ROOT);
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
          [sessionId]: { ...cur, [side]: { ...cur[side], showHidden: !cur[side].showHidden } },
        },
      };
    });
  },

  upsertRemoteEntry: (sessionId, entry) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, remote: upsertPaneEntry(cur.remote, entry) },
        },
      };
    });
  },

  removeRemoteEntries: (sessionId, paths) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, remote: removePaneEntries(cur.remote, paths) },
        },
      };
    });
  },
}));

/** Shared history-navigation (back/forward) body: list `path`, update pane. */
async function applyHistoryNav(
  set: (fn: (state: ObjStorageStoreState) => Partial<ObjStorageStoreState>) => void,
  get: () => ObjStorageStoreState,
  sessionId: string,
  side: PaneSide,
  idx: number,
  path: string,
): Promise<void> {
  const sess = get().sessions[sessionId];
  if (!sess) return;
  const pane = sess[side];
  set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...sess,
        [side]: {
          ...pane,
          historyIndex: idx,
          path,
          entries: [],
          selection: [],
          skippedEntryCount: 0,
          entryDiagnostics: [],
          loading: true,
          error: null,
        },
      },
    },
  }));
  try {
    const listing = await listSide(sessionId, side, path);
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
              ...listingState(listing),
              loading: false,
              error: null,
              selection: [],
            },
          },
        },
      };
    });
  } catch (err) {
    const message = errMsg(err);
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, [side]: { ...pane, loading: false, error: message } },
        },
      };
    });
  }
}
