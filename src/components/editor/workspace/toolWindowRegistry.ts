/**
 * §8.19.6 workspace-scoped ToolWindow registry.
 *
 * Every panel registers REAL state on mount/open/hide/dispose; the Switcher
 * consumes registry snapshots instead of constructing a hard-coded array.
 * Cycle lists (Alt-based tool-window switching) contain only open/hidden
 * windows ordered MRU-first; `unavailable` entries stay visible to Search
 * together with their reason but never enter the cycle.
 */

export interface ToolWindowSnapshot {
  id: string;
  title: string;
  dock: "left" | "right" | "bottom";
  state: "open" | "hidden" | "unavailable";
  lastActivatedAt: number | null;
  badge: number | null;
  canHide: boolean;
  /** Why the window is unavailable (Search-only display). */
  unavailableReason?: string;
}

export type ToolWindowState = ToolWindowSnapshot["state"];

interface RegistryEntry {
  snapshot: ToolWindowSnapshot;
}

const registries = new Map<string, Map<string, RegistryEntry>>();

function registryFor(workspaceId: string): Map<string, RegistryEntry> {
  let registry = registries.get(workspaceId);
  if (!registry) {
    registry = new Map();
    registries.set(workspaceId, registry);
  }
  return registry;
}

/** Register or update one tool window's real state (mount/open/hide). */
export function registerToolWindow(workspaceId: string, snapshot: ToolWindowSnapshot): void {
  registryFor(workspaceId).set(snapshot.id, { snapshot: { ...snapshot } });
}

/** Dispose-time removal: disposed panels vanish from Search as well. */
export function unregisterToolWindow(workspaceId: string, id: string): void {
  const registry = registries.get(workspaceId);
  registry?.delete(id);
  if (registry && registry.size === 0) registries.delete(workspaceId);
}

export function setToolWindowState(
  workspaceId: string,
  id: string,
  state: ToolWindowState,
  options: { unavailableReason?: string; activatedAt?: number } = {},
): void {
  const entry = registryFor(workspaceId).get(id);
  if (!entry) return;
  entry.snapshot = {
    ...entry.snapshot,
    state,
    ...(options.unavailableReason !== undefined ? { unavailableReason: options.unavailableReason } : {}),
    ...(options.activatedAt != null || state === "open"
      ? { lastActivatedAt: options.activatedAt ?? Date.now() }
      : {}),
  };
}

export function setToolWindowBadge(workspaceId: string, id: string, badge: number | null): void {
  const entry = registryFor(workspaceId).get(id);
  if (!entry) return;
  entry.snapshot = { ...entry.snapshot, badge };
}

/** Activation timestamp bump used when a tool window gains focus. */
export function touchToolWindow(workspaceId: string, id: string, at: number): void {
  const entry = registryFor(workspaceId).get(id);
  if (!entry) return;
  entry.snapshot = { ...entry.snapshot, lastActivatedAt: at };
}

/**
 * MRU-ordered snapshots of every REGISTERED window (open + hidden +
 * unavailable), most recently activated first; never-activated windows sort
 * last by title. This is the full Search listing.
 */
export function listToolWindows(workspaceId: string): readonly ToolWindowSnapshot[] {
  const registry = registries.get(workspaceId);
  if (!registry) return [];
  return [...registry.values()]
    .map((entry) => ({ ...entry.snapshot }))
    .sort((left, right) => (
      (right.lastActivatedAt ?? -1) - (left.lastActivatedAt ?? -1)
      || left.title.localeCompare(right.title)
    ));
}

/**
 * The cycle list: only windows that can actually receive focus (state !==
 * "unavailable"), MRU-first. Frozen by the caller at popup-open time.
 */
export function listToolWindowsForCycle(workspaceId: string): readonly ToolWindowSnapshot[] {
  return listToolWindows(workspaceId).filter((snapshot) => snapshot.state !== "unavailable");
}

/**
 * Canonical bottom-dock tool-window catalog (§8.19.6). Ids mirror
 * `BottomDockTabId` in codeWorkspaceStore; titles mirror the BottomDock tab
 * labels. The Switcher consumes registry snapshots — never a hard-coded list.
 */
export const WORKSPACE_BOTTOM_DOCK_WINDOWS: readonly { id: string; title: string }[] = [
  { id: "problems", title: "Problems" },
  { id: "analysis", title: "Analysis" },
  { id: "search", title: "Search" },
  { id: "references", title: "References" },
  { id: "call-hierarchy", title: "Call Hierarchy" },
  { id: "type-hierarchy", title: "Type Hierarchy" },
  { id: "todos", title: "TODOs" },
  { id: "terminal", title: "Terminal" },
  { id: "run", title: "Run" },
  { id: "build", title: "Build" },
  { id: "tests", title: "Tests" },
  { id: "coverage", title: "Coverage" },
  { id: "debug", title: "Debug" },
];

/**
 * Mirror REAL bottom-dock UI state into the registry: the visible tab is
 * "open", every other dock window is "hidden". Re-syncs preserve badges and
 * activation timestamps; a hidden→open transition bumps lastActivatedAt so
 * MRU ordering follows actual usage.
 */
export function syncBottomDockToolWindows(
  workspaceId: string,
  dock: { open: boolean; activeTab: string | null },
): void {
  const previous = new Map(listToolWindows(workspaceId).map((snapshot) => [snapshot.id, snapshot]));
  for (const window of WORKSPACE_BOTTOM_DOCK_WINDOWS) {
    const prev = previous.get(window.id);
    const state: ToolWindowState = dock.open && dock.activeTab === window.id ? "open" : "hidden";
    registerToolWindow(workspaceId, {
      id: window.id,
      title: window.title,
      dock: "bottom",
      state,
      lastActivatedAt: prev?.lastActivatedAt ?? null,
      badge: prev?.badge ?? null,
      canHide: true,
    });
    if (state === "open" && prev?.state !== "open") {
      touchToolWindow(workspaceId, window.id, Date.now());
    }
  }
}

/** Dispose-time removal of every registered window for one workspace. */
export function unregisterAllToolWindows(workspaceId: string): void {
  registries.delete(workspaceId);
}

/** Test/diagnostic reset. */
export function resetToolWindowRegistries(): void {
  registries.clear();
}
