import { create } from "zustand";
import {
  listSessions,
  saveSession,
  deleteSession,
  markSessionConnected,
  type SessionConfig,
  type SessionGroup,
  listSessionGroups,
  saveSessionGroup,
  deleteSessionGroup,
} from "../lib/ipc";
import {
  ancestorGroupPaths,
  collectFolderPaths,
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  parentGroupPath,
  replaceGroupPathPrefix,
  resolveGroupPaths,
  toStoredGroupPath,
} from "../lib/sessionPaths";

interface SessionState {
  sessions: SessionConfig[];
  groups: SessionGroup[];
  loading: boolean;
  selectedSessionId: string | null;
  searchQuery: string;

  loadSessions: () => Promise<void>;
  addSession: (config: SessionConfig) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  updateSession: (config: SessionConfig) => Promise<void>;
  duplicateSession: (id: string) => Promise<void>;
  markConnected: (id: string) => Promise<void>;
  addGroup: (name: string, parentId?: string | null) => Promise<void>;
  createFolderPath: (path: string) => Promise<void>;
  renameFolderPath: (oldPath: string, newPath: string) => Promise<void>;
  deleteFolderPath: (path: string) => Promise<void>;
  moveSessionToGroup: (id: string, groupPath: string | null) => Promise<void>;
  importSessions: (configs: SessionConfig[]) => Promise<void>;
  setSelectedSession: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
}

let pendingLoadSessions: Promise<void> | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function groupForPath(path: string): SessionGroup {
  return {
    id: path,
    name: leafGroupName(path),
    parent_id: parentGroupPath(path),
    sort_order: 0,
    icon: null,
  };
}

async function reloadSessionState(setState: (state: Partial<SessionState>) => void) {
  const [sessions, groups] = await Promise.all([
    listSessions(),
    listSessionGroups(),
  ]);
  setState({ sessions, groups });
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  groups: [],
  loading: false,
  selectedSessionId: null,
  searchQuery: "",

  loadSessions: async () => {
    if (pendingLoadSessions) return pendingLoadSessions;

    set({ loading: true });
    pendingLoadSessions = (async () => {
      try {
        const [sessions, groups] = await Promise.all([
          listSessions(),
          listSessionGroups(),
        ]);
        set({ sessions, groups, loading: false });
      } catch (err) {
        console.error("Failed to load sessions:", err);
        set({ loading: false });
      } finally {
        pendingLoadSessions = null;
      }
    })();

    return pendingLoadSessions;
  },

  addSession: async (config) => {
    await saveSession(config);
    const [sessions, groups] = await Promise.all([
      listSessions(),
      listSessionGroups(),
    ]);
    set({ sessions, groups, selectedSessionId: config.id });
  },

  removeSession: async (id) => {
    await deleteSession(id);
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      selectedSessionId: s.selectedSessionId === id ? null : s.selectedSessionId,
    }));
  },

  updateSession: async (config) => {
    await saveSession(config);
    await reloadSessionState(set);
  },

  duplicateSession: async (id) => {
    const source = useSessionStore.getState().sessions.find((s) => s.id === id);
    if (!source) return;
    const now = Math.floor(Date.now() / 1000);
    const copy: SessionConfig = {
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} (copy)`,
      created_at: now,
      updated_at: now,
      last_connected_at: null,
    };
    await saveSession(copy);
    const sessions = await listSessions();
    set({ sessions, selectedSessionId: copy.id });
  },

  markConnected: async (id) => {
    if (!useSessionStore.getState().sessions.some((s) => s.id === id)) return;
    const ts = await markSessionConnected(id);
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, last_connected_at: ts } : session,
      ),
    }));
  },

  addGroup: async (name, parentId = null) => {
    const parentPath = parentId
      ? resolveGroupPaths(useSessionStore.getState().groups).find(({ group }) => group.id === parentId)?.path ?? parentId
      : null;
    const path = normalizeGroupPath(parentPath ? `${parentPath} / ${name}` : name);
    if (!path) return;
    await useSessionStore.getState().createFolderPath(path);
  },

  createFolderPath: async (path) => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return;

    const knownPaths = new Set(collectFolderPaths(
      useSessionStore.getState().sessions,
      useSessionStore.getState().groups,
    ));

    for (const ancestor of ancestorGroupPaths(normalized)) {
      if (knownPaths.has(ancestor)) continue;
      await saveSessionGroup(groupForPath(ancestor));
      knownPaths.add(ancestor);
    }

    await reloadSessionState(set);
  },

  renameFolderPath: async (oldPath, newPath) => {
    const oldNormalized = normalizeGroupPath(oldPath);
    const newNormalized = normalizeGroupPath(newPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) return;

    const state = useSessionStore.getState();
    const groupPaths = resolveGroupPaths(state.groups);
    const affectedGroups = groupPaths
      .filter(({ path }) => groupPathContains(oldNormalized, path))
      .sort((a, b) => b.path.length - a.path.length);
    const affectedSessions = state.sessions.filter((session) =>
      groupPathContains(oldNormalized, session.group_path),
    );

    for (const ancestor of ancestorGroupPaths(newNormalized)) {
      await saveSessionGroup(groupForPath(ancestor));
    }

    for (const { group } of affectedGroups) {
      await deleteSessionGroup(group.id);
    }

    const replacementGroupPaths = new Set<string>();
    for (const { path } of affectedGroups) {
      const replaced = replaceGroupPathPrefix(path, oldNormalized, newNormalized);
      if (replaced) {
        for (const ancestor of ancestorGroupPaths(replaced)) {
          replacementGroupPaths.add(ancestor);
        }
      }
    }

    for (const path of [...replacementGroupPaths].sort((a, b) => a.length - b.length)) {
      await saveSessionGroup(groupForPath(path));
    }

    for (const session of affectedSessions) {
      const replaced = replaceGroupPathPrefix(session.group_path, oldNormalized, newNormalized);
      await saveSession({
        ...session,
        group_path: toStoredGroupPath(replaced),
        updated_at: nowSeconds(),
      });
    }

    await reloadSessionState(set);
  },

  deleteFolderPath: async (path) => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return;

    const state = useSessionStore.getState();
    const affectedGroups = resolveGroupPaths(state.groups)
      .filter(({ path: groupPath }) => groupPathContains(normalized, groupPath))
      .sort((a, b) => b.path.length - a.path.length);
    const affectedSessions = state.sessions.filter((session) =>
      groupPathContains(normalized, session.group_path),
    );

    for (const session of affectedSessions) {
      await deleteSession(session.id);
    }
    for (const { group } of affectedGroups) {
      await deleteSessionGroup(group.id);
    }

    await reloadSessionState(set);
  },

  moveSessionToGroup: async (id, groupPath) => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === id);
    if (!session) return;

    const normalized = normalizeGroupPath(groupPath);
    if (normalized) {
      await useSessionStore.getState().createFolderPath(normalized);
    }

    const next: SessionConfig = {
      ...session,
      group_path: toStoredGroupPath(normalized),
      updated_at: nowSeconds(),
    };
    await saveSession(next);
    await reloadSessionState(set);
  },

  importSessions: async (configs) => {
    for (const config of configs) {
      if (config.group_path) {
        const normalized = normalizeGroupPath(config.group_path);
        if (normalized) {
          for (const ancestor of ancestorGroupPaths(normalized)) {
            await saveSessionGroup(groupForPath(ancestor));
          }
        }
      }
      await saveSession(config);
    }
    await reloadSessionState(set);
  },

  setSelectedSession: (id) => set({ selectedSessionId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
