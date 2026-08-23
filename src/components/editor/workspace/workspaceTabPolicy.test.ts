import { describe, expect, it } from "vitest";
import {
  CLOSED_TAB_STACK_LIMIT,
  DEFAULT_WORKSPACE_TAB_POLICY,
  enforceTabPolicy,
  orderTabsForDisplay,
  pushClosedTab,
  selectActivateOnClose,
  type ClosedTabEntry,
  type TabEvictionMeta,
  type WorkspaceTabPolicyV2,
} from "./workspaceTabPolicy";

function meta(key: string, overrides: Partial<TabEvictionMeta> = {}): TabEvictionMeta {
  return { key, dirty: false, pinned: false, preview: false, lastUsedAt: 0, ...overrides };
}

function metaMap(entries: TabEvictionMeta[]): Map<string, TabEvictionMeta> {
  return new Map(entries.map((entry) => [entry.key, entry]));
}

describe("§8.18.5 tab policy", () => {
  const policy: WorkspaceTabPolicyV2 = { ...DEFAULT_WORKSPACE_TAB_POLICY, limitPerLeaf: 3 };

  it("keeps leaves within limit untouched", () => {
    const keys = ["a", "b", "c"];
    expect(enforceTabPolicy(keys, metaMap(keys.map((k) => meta(k))), policy)).toEqual({ kind: "within-limit" });
  });

  it("evicts clean previews first, then least-recently used", () => {
    const keys = ["old", "preview", "recent", "mid"];
    const result = enforceTabPolicy(keys, metaMap([
      meta("old", { lastUsedAt: 1 }),
      meta("preview", { preview: true, lastUsedAt: 100 }),
      meta("recent", { lastUsedAt: 50 }),
      meta("mid", { lastUsedAt: 10 }),
    ]), policy);
    // Overflow is 1: the clean preview goes first even though most recent.
    expect(result).toEqual({ kind: "evicted", evictedKeys: ["preview"] });
  });

  it("never evicts dirty or pinned tabs and reports over-limit-protected", () => {
    const keys = ["dirty1", "dirty2", "pinned", "dirty3"];
    const result = enforceTabPolicy(keys, metaMap([
      meta("dirty1", { dirty: true }),
      meta("dirty2", { dirty: true }),
      meta("pinned", { pinned: true }),
      meta("dirty3", { dirty: true }),
    ]), policy);
    expect(result.kind).toBe("over-limit-protected");
    if (result.kind === "over-limit-protected") {
      expect(result.reason).toContain("pinned");
      expect(result.reason).toContain(String(policy.limitPerLeaf));
    }
  });

  it("alphabetical order is a display projection that keeps pinned first when separated", () => {
    const entries = metaMap([
      meta("zeta", { pinned: true }),
      meta("alpha"),
      meta("mid"),
    ]);
    const ordered = orderTabsForDisplay(["zeta", "alpha", "mid"], entries, {
      ...policy,
      order: "alphabetical",
      pinnedRow: "separate",
    });
    expect(ordered).toEqual(["zeta", "alpha", "mid"]);
  });

  it("activateOnClose picks left/right/mru neighbor", () => {
    const keys = ["a", "b", "c"];
    const used = new Map([["a", 5], ["b", 9], ["c", 1]]);
    expect(selectActivateOnClose(keys, "b", "b", used, { ...policy, activateOnClose: "left" })).toBe("a");
    expect(selectActivateOnClose(keys, "b", "b", used, { ...policy, activateOnClose: "right" })).toBe("c");
    expect(selectActivateOnClose(keys, "b", "b", used, { ...policy, activateOnClose: "mru" })).toBe("a");
    expect(selectActivateOnClose(keys, "b", "a", used, policy)).toBeNull();
  });
});

describe("§8.18.5 closed-tab reopen stack", () => {
  function entry(identity: string): ClosedTabEntry {
    return {
      fileIdentity: identity,
      ref: null,
      title: identity,
      subtitle: identity,
      leafPath: ["primary"],
      closedAt: Date.now(),
    };
  }

  it("caps the session stack at 50 and dedupes by identity", () => {
    let stack: readonly ClosedTabEntry[] = [];
    for (let index = 0; index < CLOSED_TAB_STACK_LIMIT + 10; index += 1) {
      stack = pushClosedTab(stack, entry(`f-${index}`));
    }
    expect(stack.length).toBeLessThanOrEqual(CLOSED_TAB_STACK_LIMIT);
    expect(stack[0].fileIdentity).toBe(`f-${CLOSED_TAB_STACK_LIMIT + 9}`);

    const withDup = pushClosedTab(stack, entry(`f-${CLOSED_TAB_STACK_LIMIT + 9}`));
    expect(withDup.length).toBe(stack.length);
  });
});
