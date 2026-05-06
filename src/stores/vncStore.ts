import { create } from "zustand";

export type VncConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface VncConnectionState {
  status: VncConnectionStatus;
  sessionId: string | null;
  wsPort: number | null;
  width: number;
  height: number;
  name: string;
  error: string | null;
  reconnectCount: number;
  encoding: string | null;
}

interface VncStore {
  connections: Record<string, VncConnectionState>;

  initConnection: (tabId: string) => void;
  setConnecting: (tabId: string, sessionId: string, wsPort: number) => void;
  setConnected: (
    tabId: string,
    width: number,
    height: number,
    name: string,
  ) => void;
  setDisconnected: (tabId: string, reason?: string) => void;
  setReconnectCount: (tabId: string, count: number) => void;
  setEncoding: (tabId: string, encoding: string) => void;
  removeConnection: (tabId: string) => void;
}

export const useVncStore = create<VncStore>((set) => ({
  connections: {},

  initConnection(tabId) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          status: "connecting",
          sessionId: null,
          wsPort: null,
          width: 0,
          height: 0,
          name: "",
          error: null,
          reconnectCount: 0,
          encoding: null,
        },
      },
    }));
  },

  setConnecting(tabId, sessionId, wsPort) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? {}),
          status: "connecting",
          sessionId,
          wsPort,
          error: null,
        } as VncConnectionState,
      },
    }));
  },

  setConnected(tabId, width, height, name) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? {}),
          status: "connected",
          width,
          height,
          name,
          error: null,
          reconnectCount: 0,
        } as VncConnectionState,
      },
    }));
  },

  setDisconnected(tabId, reason) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? {}),
          status: "disconnected",
          error: reason ?? null,
        } as VncConnectionState,
      },
    }));
  },

  setReconnectCount(tabId, count) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? {}),
          reconnectCount: count,
        } as VncConnectionState,
      },
    }));
  },

  setEncoding(tabId, encoding) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? {}),
          encoding,
        } as VncConnectionState,
      },
    }));
  },

  removeConnection(tabId) {
    set((s) => {
      const next = { ...s.connections };
      delete next[tabId];
      return { connections: next };
    });
  },
}));
