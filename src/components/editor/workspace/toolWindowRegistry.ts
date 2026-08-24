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

/** Test/diagnostic reset. */
export function resetToolWindowRegistries(): void {
  registries.clear();
}
