import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_BOTTOM_DOCK_WINDOWS,
  listToolWindows,
  listToolWindowsForCycle,
  registerToolWindow,
  resetToolWindowRegistries,
  setToolWindowBadge,
  setToolWindowState,
  syncBottomDockToolWindows,
  touchToolWindow,
  unregisterAllToolWindows,
  unregisterToolWindow,
} from "./toolWindowRegistry";

afterEach(() => resetToolWindowRegistries());

function base(id: string, overrides = {}) {
  return {
    id,
    title: id,
    dock: "bottom" as const,
    state: "open" as const,
    lastActivatedAt: null,
    badge: null,
    canHide: true,
    ...overrides,
  };
}

describe("§8.19.6 tool window registry", () => {
  it("lists registered windows MRU-first with never-activated ones last", () => {
    registerToolWindow("ws", base("problems"));
    registerToolWindow("ws", { ...base("terminal"), lastActivatedAt: 100 });
    registerToolWindow("ws", { ...base("search"), lastActivatedAt: 200 });
    const ids = listToolWindows("ws").map((snapshot) => snapshot.id);
    expect(ids).toEqual(["search", "terminal", "problems"]);
  });

  it("keeps unavailable windows out of the cycle but visible to Search with a reason", () => {
    registerToolWindow("ws", {
      ...base("debug"),
      state: "unavailable",
      unavailableReason: "No debug session",
    });
    registerToolWindow("ws", base("terminal"));

    expect(listToolWindows("ws")).toHaveLength(2);
    const cycle = listToolWindowsForCycle("ws");
    expect(cycle.map((snapshot) => snapshot.id)).toEqual(["terminal"]);
    const debug = listToolWindows("ws").find((snapshot) => snapshot.id === "debug");
    expect(debug?.state).toBe("unavailable");
    expect(debug?.unavailableReason).toBe("No debug session");
  });

  it("tracks open/hide transitions and activation timestamps", () => {
    registerToolWindow("ws", base("terminal"));
    setToolWindowState("ws", "terminal", "hidden");
    expect(listToolWindows("ws")[0].state).toBe("hidden");
    setToolWindowState("ws", "terminal", "open", { activatedAt: 555 });
    expect(listToolWindows("ws")[0].lastActivatedAt).toBe(555);
    touchToolWindow("ws", "terminal", 999);
    expect(listToolWindows("ws")[0].lastActivatedAt).toBe(999);
  });

  it("updates badges and removes disposed panels entirely", () => {
    registerToolWindow("ws", base("problems"));
    setToolWindowBadge("ws", "problems", 3);
    expect(listToolWindows("ws")[0].badge).toBe(3);
    setToolWindowBadge("ws", "problems", null);
    expect(listToolWindows("ws")[0].badge).toBeNull();
    unregisterToolWindow("ws", "problems");
    expect(listToolWindows("ws")).toHaveLength(0);
    // Unknown ids are silent no-ops.
    expect(() => setToolWindowBadge("ws", "ghost", 1)).not.toThrow();
  });

  it("keeps workspaces isolated", () => {
    registerToolWindow("ws-a", base("terminal"));
    registerToolWindow("ws-b", base("search"));
    expect(listToolWindows("ws-a").map((s) => s.id)).toEqual(["terminal"]);
    expect(listToolWindows("ws-b").map((s) => s.id)).toEqual(["search"]);
  });

  it("mirrors the full bottom-dock catalog with open/hidden real state", () => {
    syncBottomDockToolWindows("ws", { open: true, activeTab: "terminal" });
    const snapshots = listToolWindows("ws");
    // listToolWindows orders MRU-first; compare as sets for coverage.
    expect([...snapshots.map((s) => s.id)].sort()).toEqual([
      ...WORKSPACE_BOTTOM_DOCK_WINDOWS.map((w) => w.id),
    ].sort());
    const terminal = snapshots.find((s) => s.id === "terminal");
    expect(terminal?.state).toBe("open");
    expect(terminal?.dock).toBe("bottom");
    // The active window is also the MRU head right after activation.
    expect(snapshots[0]?.id).toBe("terminal");
    for (const snapshot of snapshots.filter((s) => s.id !== "terminal")) {
      expect(snapshot.state).toBe("hidden");
    }
  });

  it("bumps activation on hidden→open transitions and preserves badges across re-syncs", () => {
    syncBottomDockToolWindows("ws", { open: true, activeTab: "problems" });
    setToolWindowBadge("ws", "problems", 4);
    const firstOpen = listToolWindows("ws").find((s) => s.id === "problems")!;
    expect(firstOpen.lastActivatedAt).not.toBeNull();

    // Re-sync to another tab: badge + timestamp survive; problems → hidden.
    syncBottomDockToolWindows("ws", { open: true, activeTab: "search" });
    let problems = listToolWindows("ws").find((s) => s.id === "problems")!;
    expect(problems.state).toBe("hidden");
    expect(problems.badge).toBe(4);
    expect(problems.lastActivatedAt).toBe(firstOpen.lastActivatedAt);

    // Back to problems: hidden→open bumps lastActivatedAt.
    syncBottomDockToolWindows("ws", { open: true, activeTab: "problems" });
    problems = listToolWindows("ws").find((s) => s.id === "problems")!;
    expect(problems.state).toBe("open");
    expect(problems.badge).toBe(4);
    expect(problems.lastActivatedAt!).toBeGreaterThanOrEqual(firstOpen.lastActivatedAt!);

    // Dock collapsed: every window is hidden but still registered.
    syncBottomDockToolWindows("ws", { open: false, activeTab: null });
    expect(listToolWindowsForCycle("ws")).toHaveLength(WORKSPACE_BOTTOM_DOCK_WINDOWS.length);
    expect(listToolWindows("ws").every((s) => s.state === "hidden")).toBe(true);
  });

  it("drops every window of one workspace on dispose without touching others", () => {
    registerToolWindow("other-ws", base("terminal"));
    syncBottomDockToolWindows("ws", { open: false, activeTab: null });
    unregisterAllToolWindows("ws");
    expect(listToolWindows("ws")).toHaveLength(0);
    expect(listToolWindows("other-ws").map((s) => s.id)).toEqual(["terminal"]);
  });
});
