import { create } from "zustand";
import {
  SERVER_ORDER,
  defaultConfig,
  loadServerConfigs,
  listServerStatuses,
  openServersWindow,
  saveServerConfig,
  startLocalServer,
  stopLocalServer,
  type ServerConfig,
  type ServerRunState,
  type ServerStatus,
  type ServerType,
} from "../lib/servers";
import { ensureVaultReady } from "../lib/vaultGate";

const MAX_LOG_LINES = 500;

export interface ServerRuntime {
  status: ServerRunState;
  pid?: number;
  startedAt?: number;
  error?: string;
  logLines: string[];
}

interface ServersStore {
  selectedServer: ServerType;
  configs: Record<ServerType, ServerConfig>;
  runtimes: Record<ServerType, ServerRuntime>;
  loaded: boolean;
  /** True when configs have unsaved edits since the last Apply / load. */
  dirty: boolean;

  /** Open (or focus) the Local servers OS window. Optional localized title. */
  openDialog: (title?: string) => void;
  selectServer: (t: ServerType) => void;
  setConfig: (t: ServerType, cfg: ServerConfig) => void;
  patchConfig: (t: ServerType, patch: Partial<ServerConfig>) => void;
  setStatus: (t: ServerType, s: ServerStatus) => void;
  appendLog: (t: ServerType, line: string) => void;
  clearLog: (t: ServerType) => void;
  markDirty: () => void;
  clearDirty: () => void;
  loadAll: () => Promise<void>;
  start: (t: ServerType) => Promise<void>;
  stop: (t: ServerType) => Promise<void>;
}

function initialConfigs(): Record<ServerType, ServerConfig> {
  const out = {} as Record<ServerType, ServerConfig>;
  for (const t of SERVER_ORDER) {
    out[t] = defaultConfig(t);
  }
  return out;
}

function initialRuntimes(): Record<ServerType, ServerRuntime> {
  const out = {} as Record<ServerType, ServerRuntime>;
  for (const t of SERVER_ORDER) {
    out[t] = { status: "stopped", logLines: [] };
  }
  return out;
}

function timestampLine(line: string): string {
  // Mirror the design's "[YYYY-MM-DD HH:MM:SS] message" log format.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `[${stamp}] ${line}`;
}

export const useServersStore = create<ServersStore>((set, get) => ({
  selectedServer: "ssh",
  configs: initialConfigs(),
  runtimes: initialRuntimes(),
  loaded: false,
  dirty: false,

  openDialog: (title) => {
    void openServersWindow(title).catch((err) => {
      console.error("[servers] failed to open Local servers window", err);
    });
  },
  selectServer: (t) => set({ selectedServer: t }),

  setConfig: (t, cfg) =>
    set((s) => ({ configs: { ...s.configs, [t]: cfg } })),

  patchConfig: (t, patch) =>
    set((s) => ({
      configs: { ...s.configs, [t]: { ...s.configs[t], ...patch } },
      dirty: true,
    })),

  setStatus: (t, status) =>
    set((s) => ({
      runtimes: {
        ...s.runtimes,
        [t]: {
          ...s.runtimes[t],
          status: status.status,
          pid: status.pid,
          startedAt: status.startedAt,
          error: status.error,
        },
      },
    })),

  appendLog: (t, line) =>
    set((s) => {
      const prev = s.runtimes[t]?.logLines ?? [];
      const next = [...prev, line];
      if (next.length > MAX_LOG_LINES) {
        next.splice(0, next.length - MAX_LOG_LINES);
      }
      return {
        runtimes: { ...s.runtimes, [t]: { ...s.runtimes[t], logLines: next } },
      };
    }),

  clearLog: (t) =>
    set((s) => ({
      runtimes: { ...s.runtimes, [t]: { ...s.runtimes[t], logLines: [] } },
    })),

  markDirty: () => set({ dirty: true }),
  clearDirty: () => set({ dirty: false }),

  loadAll: async () => {
    const configs = initialConfigs();
    try {
      const stored = await loadServerConfigs();
      for (const t of SERVER_ORDER) {
        const saved = stored[t];
        if (saved) configs[t] = { ...configs[t], ...saved };
      }
    } catch {
      // Backend not ready / no saved configs — keep defaults.
    }

    const runtimes = initialRuntimes();
    try {
      const statuses = await listServerStatuses();
      for (const st of statuses) {
        if (runtimes[st.serverType]) {
          runtimes[st.serverType] = {
            ...runtimes[st.serverType],
            status: st.status,
            pid: st.pid,
            startedAt: st.startedAt,
            error: st.error,
          };
        }
      }
    } catch {
      // Backend not ready — keep stopped defaults.
    }

    set({ configs, runtimes, loaded: true, dirty: false });
  },

  start: async (t) => {
    let cfg = get().configs[t];
    // Optimistic "starting" so the row reflects intent immediately.
    set((s) => ({
      runtimes: {
        ...s.runtimes,
        [t]: { ...s.runtimes[t], status: "starting", error: undefined },
      },
    }));
    try {
      if (t === "rdp" && !(await ensureVaultReady("Store the RDP server password securely"))) {
        throw new Error("RDP server start cancelled: credential vault is not ready");
      }
      cfg = await saveServerConfig(t, cfg);
      get().setConfig(t, cfg);
      const status = await startLocalServer(t, cfg);
      get().setStatus(t, status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        runtimes: {
          ...s.runtimes,
          [t]: { ...s.runtimes[t], status: "error", error: message },
        },
      }));
      get().appendLog(t, timestampLine(message));
    }
  },

  stop: async (t) => {
    try {
      const status = await stopLocalServer(t);
      get().setStatus(t, status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        runtimes: {
          ...s.runtimes,
          [t]: { ...s.runtimes[t], status: "error", error: message },
        },
      }));
      get().appendLog(t, timestampLine(message));
    }
  },
}));
