import { create } from "zustand";
import type { Tab } from "../types";

export type SideTab = "sessions" | "tools" | "macros" | "games";

const COMPACT_MODE_KEY = "newmob.compactMode";

interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  compactMode: boolean;
  activeSideTab: SideTab;
  xServerEnabled: boolean;
  statusMessage: string;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;

  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  removeTabs: (ids: string[]) => void;
  updateTabTitle: (id: string, title: string) => void;
  setActiveTab: (id: string) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleCompactMode: () => void;
  setCompactMode: (compact: boolean) => void;
  setActiveSideTab: (tab: SideTab) => void;
  toggleXServer: () => void;
  setStatusMessage: (message: string) => void;
  toggleMultiExec: () => void;
  toggleMultiExecTab: (tabId: string) => void;
  selectAllTerminalTabs: () => void;
  clearMultiExecSelection: () => void;
  setTabHasNewOutput: (tabId: string, hasNewOutput: boolean) => void;
}

function readCompactMode() {
  try {
    return window.localStorage.getItem(COMPACT_MODE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCompactMode(compact: boolean) {
  try {
    window.localStorage.setItem(COMPACT_MODE_KEY, compact ? "true" : "false");
  } catch {
    // Ignore storage failures; compact mode still works for this run.
  }
}

export const useAppStore = create<AppState>((set) => ({
  tabs: [
    {
      id: "welcome",
      type: "welcome",
      title: "Welcome",
      closable: false,
    },
  ],
  activeTabId: "welcome",
  sidebarCollapsed: false,
  compactMode: readCompactMode(),
  activeSideTab: "sessions",
  xServerEnabled: false,
  statusMessage: "Ready",
  multiExecActive: false,
  multiExecSelectedTabIds: new Set(),

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      statusMessage: `Opened ${tab.title}`,
    })),

  removeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const next = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeTabId;
      if (activeId === id) {
        activeId = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      return { tabs: next, activeTabId: activeId, statusMessage: "Closed tab" };
    }),

  removeTabs: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const activeIndex = s.tabs.findIndex((t) => t.id === s.activeTabId);
      const next = s.tabs.filter((t) => !idSet.has(t.id));
      let activeId = s.activeTabId;
      if (!activeId || idSet.has(activeId)) {
        activeId = next[Math.min(activeIndex, next.length - 1)]?.id ?? null;
      }
      return { tabs: next, activeTabId: activeId, statusMessage: "Closed tabs" };
    }),

  updateTabTitle: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
      statusMessage: `Renamed tab to ${title}`,
    })),

  setActiveTab: (id) => set({ activeTabId: id }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleCompactMode: () =>
    set((s) => {
      const compactMode = !s.compactMode;
      writeCompactMode(compactMode);
      return {
        compactMode,
        statusMessage: `Compact mode ${compactMode ? "enabled" : "disabled"}`,
      };
    }),
  setCompactMode: (compactMode) => {
    writeCompactMode(compactMode);
    set({
      compactMode,
      statusMessage: `Compact mode ${compactMode ? "enabled" : "disabled"}`,
    });
  },
  setActiveSideTab: (tab) => set({ activeSideTab: tab, sidebarCollapsed: false }),

  toggleXServer: () =>
    set((s) => ({
      xServerEnabled: !s.xServerEnabled,
      statusMessage: `X server ${!s.xServerEnabled ? "enabled" : "disabled"}`,
    })),

  setStatusMessage: (message) => set({ statusMessage: message }),

  toggleMultiExec: () =>
    set((s) => {
      const next = !s.multiExecActive;
      return {
        multiExecActive: next,
        multiExecSelectedTabIds: new Set(),
        tabs: next ? s.tabs : s.tabs.map((t) => ({ ...t, hasNewOutput: false })),
        statusMessage: next ? "MultiExec enabled" : "MultiExec disabled",
      };
    }),

  toggleMultiExecTab: (tabId) =>
    set((s) => {
      const next = new Set(s.multiExecSelectedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return { multiExecSelectedTabIds: next };
    }),

  selectAllTerminalTabs: () =>
    set((s) => ({
      multiExecSelectedTabIds: new Set(
        s.tabs.filter((t) => t.type === "terminal").map((t) => t.id),
      ),
    })),

  clearMultiExecSelection: () =>
    set({ multiExecSelectedTabIds: new Set() }),

  setTabHasNewOutput: (tabId, hasNewOutput) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.hasNewOutput === hasNewOutput) return s;
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hasNewOutput } : t)) };
    }),
}));
