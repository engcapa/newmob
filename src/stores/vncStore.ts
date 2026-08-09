import { create } from "zustand";
import type { VncClipboardPolicy } from "../types/vnc";

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
  security: string | null;
  protocol: string | null;
  encrypted: boolean;
  viewOnly: boolean;
  clipboardPolicy: VncClipboardPolicy;
  error: string | null;
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
    security?: string,
    protocol?: string,
    encrypted?: boolean,
    viewOnly?: boolean,
    clipboardPolicy?: VncClipboardPolicy,
  ) => void;
  setDimensions: (tabId: string, width: number, height: number) => void;
  setDisconnected: (tabId: string, reason?: string) => void;
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
          security: null,
          protocol: null,
          encrypted: false,
          viewOnly: false,
          clipboardPolicy: "bidirectional",
          error: null,
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

  setConnected(tabId, width, height, name, security, protocol, encrypted, viewOnly, clipboardPolicy) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? {}),
          status: "connected",
          width,
          height,
          name,
          security: security ?? null,
          protocol: protocol ?? null,
          encrypted: encrypted ?? false,
          viewOnly: viewOnly ?? false,
          clipboardPolicy: clipboardPolicy ?? "bidirectional",
          error: null,
        } as VncConnectionState,
      },
    }));
  },

  setDimensions(tabId, width, height) {
    set((s) => {
      const connection = s.connections[tabId];
      if (!connection) return s;
      return {
        connections: {
          ...s.connections,
          [tabId]: { ...connection, width, height },
        },
      };
    });
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

  removeConnection(tabId) {
    set((s) => {
      const next = { ...s.connections };
      delete next[tabId];
      return { connections: next };
    });
  },
}));
