import { describe, expect, it } from "vitest";
import {
  CLOSED_TAB_STACK_LIMIT,
  DEFAULT_WORKSPACE_TAB_POLICY,
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  applyWorkspaceTabPolicyTransaction,
  buildReopenTreeRoute,
  computeWorkspaceTabPolicyApplication,
  enforceTabPolicy,
  orderTabsForDisplay,
  pushClosedTab,
  resolveReopenLocation,
  selectActivateOnClose,
  type ClosedTabEntry,
  type TabEvictionMeta,
  type WorkspaceTabPolicyV2,
} from "./workspaceTabPolicy";
import type { LayoutNode } from "./recursiveLayoutTree";

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

describe("§8.19.6 ReopenLocationV2 resolution", () => {
  // root-split[ l-a | right-split[ l-b | inner-split[ l-c | l-d ] ] ]
  const tree: LayoutNode = {
    type: "split",
    id: "root",
    orientation: "horizontal",
    ratios: [0.5, 0.5],
    children: [
      { type: "leaf", id: "l-a", openFileKeys: ["a.ts"], activeKey: "a.ts" },
      {
        type: "split",
        id: "right",
        orientation: "vertical",
        ratios: [0.5, 0.5],
        children: [
          { type: "leaf", id: "l-b", openFileKeys: [], activeKey: null },
          {
            type: "split",
            id: "inner",
            orientation: "horizontal",
            ratios: [0.5, 0.5],
            children: [
              { type: "leaf", id: "l-c", openFileKeys: ["c.ts"], activeKey: "c.ts" },
              { type: "leaf", id: "l-d", openFileKeys: ["d.ts"], activeKey: null },
            ],
          },
        ],
      },
    ],
  };

  it("records first/second routes from the root to a leaf", () => {
    expect(buildReopenTreeRoute(tree, "l-a")).toEqual(["first"]);
    expect(buildReopenTreeRoute(tree, "l-b")).toEqual(["second", "first"]);
    expect(buildReopenTreeRoute(tree, "l-d")).toEqual(["second", "second", "second"]);
  });

  it("restores directly when the original leaf still exists", () => {
    expect(resolveReopenLocation(tree, { leafId: "l-c", treeRoute: ["second", "second", "second"], siblingFileKeys: [] }, "l-a"))
      .toEqual({ kind: "restored", leafId: "l-c" });
  });

  it("relocates along the nearest surviving ancestor route when the leaf is gone", () => {
    // l-d closed away; the whole right side collapsed to a single leaf l-b.
    const collapsed: LayoutNode = {
      type: "split",
      id: "root",
      orientation: "horizontal",
      ratios: [0.5, 0.5],
      children: [
        { type: "leaf", id: "l-a", openFileKeys: ["a.ts"], activeKey: "a.ts" },
        { type: "leaf", id: "l-b", openFileKeys: [], activeKey: null },
      ],
    };
    expect(resolveReopenLocation(collapsed, { leafId: "l-d", treeRoute: ["second", "second", "second"], siblingFileKeys: [] }, "l-a"))
      .toEqual({ kind: "relocated", leafId: "l-b", reason: "route" });
  });

  it("falls back to the leaf owning the most former siblings", () => {
    const single: LayoutNode = { type: "leaf", id: "only", openFileKeys: ["c.ts", "d.ts", "x.ts"], activeKey: "x.ts" };
    expect(resolveReopenLocation(single, { leafId: "l-d", treeRoute: ["second", "second", "second"], siblingFileKeys: ["c.ts", "d.ts"] }, null))
      .toEqual({ kind: "relocated", leafId: "only", reason: "sibling" });
  });

  it("finally falls back to the active leaf when nothing else matches", () => {
    const single: LayoutNode = { type: "leaf", id: "only", openFileKeys: [], activeKey: null };
    expect(resolveReopenLocation(single, { leafId: null, treeRoute: [], siblingFileKeys: [] }, "only"))
      .toEqual({ kind: "relocated", leafId: "only", reason: "active" });
  });
});

describe("§8.21.3 V2-B: computeWorkspaceTabPolicyApplication transaction", () => {
  it("normalizes limits and preserves dirty and pinned tabs during limit shrinking", () => {
    const res = computeWorkspaceTabPolicyApplication({
      rawPolicy: {
        schemaVersion: 3,
        limitPerLeaf: 2,
        order: "alphabetical",
        openPosition: "after-active",
        activateOnClose: "mru",
        pinnedRow: "separate",
        previewMode: true,
        reusePreview: true,
      },
      editorGroups: {
        g1: {
          openOrder: ["clean1", "clean2", "dirty1", "pinned1"],
          pinnedKeys: ["pinned1"],
          previewKey: null,
          activeKey: "clean1",
        },
      },
      openFiles: {
        clean1: { dirty: false },
        clean2: { dirty: false },
        dirty1: { dirty: true },
        pinned1: { dirty: false },
      },
      mruFileKeys: ["clean1", "clean2", "dirty1", "pinned1"],
    });

    expect(res.policy.limitPerLeaf).toBe(2);
    expect(res.evictionsByGroup.g1).toEqual(["clean2", "clean1"]);
    expect(res.allEvictedKeys).toEqual(["clean2", "clean1"]);
    expect(res.message).toContain("evicted 2 tabs");
  });

  it("handles over-limit protected scenarios where all excess tabs are unclosable", () => {
    const res = computeWorkspaceTabPolicyApplication({
      rawPolicy: {
        schemaVersion: 3,
        limitPerLeaf: 1,
        order: "open-order",
        openPosition: "end",
        activateOnClose: "mru",
        pinnedRow: "same",
        previewMode: true,
        reusePreview: true,
      },
      editorGroups: {
        g1: {
          openOrder: ["dirty1", "pinned1"],
          pinnedKeys: ["pinned1"],
          previewKey: null,
          activeKey: "dirty1",
        },
      },
      openFiles: {
        dirty1: { dirty: true },
        pinned1: { dirty: false },
      },
      mruFileKeys: ["dirty1", "pinned1"],
    });

    expect(res.allEvictedKeys).toEqual([]);
    expect(res.protectedCount).toBe(2);
    expect(res.message).toContain("limit: 1, order: open-order");
  });

  describe("§8.22.4 U2-B applyWorkspaceTabPolicyTransaction", () => {
    it("aborts entire multi-group transaction with zero mutations when user cancels dirty tab close", async () => {
      let committed = false;
      const initialGroups = {
        primary: {
          openOrder: ["dirty1", "dirty2"],
          pinnedKeys: [],
          previewKey: null,
          activeKey: "dirty2",
        },
        secondary: {
          openOrder: ["clean2", "clean3"],
          pinnedKeys: [],
          previewKey: null,
          activeKey: "clean3",
        },
      };

      const result = await applyWorkspaceTabPolicyTransaction({
        workspaceInstanceId: "ws-tab-tx-abort",
        nextPolicyRaw: { limitPerLeaf: 1, order: "open-order" },
        currentGroups: initialGroups,
        openFiles: {
          dirty1: { dirty: true },
          dirty2: { dirty: true },
          clean2: { dirty: false },
          clean3: { dirty: false },
        },
        mruFileKeys: ["dirty1", "dirty2", "clean2", "clean3"],
        confirmDirtyClose: async () => false, // User clicks Cancel
        commitAtomicUpdate: () => {
          committed = true;
        },
      });

      expect(result.status).toBe("aborted");
      expect(result.reason).toBe("user-cancelled");
      expect(committed).toBe(false);
    });

    it("commits atomically across all groups in a single update when confirmed", async () => {
      let committedResult: any = null;
      const initialGroups = {
        primary: {
          openOrder: ["clean1", "clean2"],
          pinnedKeys: [],
          previewKey: null,
          activeKey: "clean2",
        },
        secondary: {
          openOrder: ["clean3", "clean4"],
          pinnedKeys: [],
          previewKey: null,
          activeKey: "clean4",
        },
      };

      const result = await applyWorkspaceTabPolicyTransaction({
        workspaceInstanceId: "ws-tab-tx-commit",
        nextPolicyRaw: { limitPerLeaf: 1, order: "open-order" },
        currentGroups: initialGroups,
        openFiles: {
          clean1: { dirty: false },
          clean2: { dirty: false },
          clean3: { dirty: false },
          clean4: { dirty: false },
        },
        mruFileKeys: ["clean2", "clean1", "clean4", "clean3"],
        commitAtomicUpdate: (update) => {
          committedResult = update;
        },
      });

      expect(result.status).toBe("applied");
      expect(committedResult).not.toBeNull();
      expect(committedResult.nextGroups.primary.openOrder).toHaveLength(1);
      expect(committedResult.nextGroups.secondary.openOrder).toHaveLength(1);
      expect(result.allEvictedKeys).toHaveLength(2);
    });

    it("§8.23.3 X2 applies and commits policy update even with 0 evictions", async () => {
      let committedResult: any = null;
      const initialGroups = {
        primary: {
          openOrder: ["clean1"],
          pinnedKeys: [],
          previewKey: null,
          activeKey: "clean1",
        },
      };

      const result = await applyWorkspaceTabPolicyTransaction({
        workspaceInstanceId: "ws-tab-tx-zero-evict",
        nextPolicyRaw: { limitPerLeaf: 10, order: "alphabetical" },
        currentPolicy: { ...DEFAULT_WORKSPACE_TAB_POLICY_V3, order: "open-order" },
        currentGroups: initialGroups,
        openFiles: { clean1: { dirty: false } },
        mruFileKeys: ["clean1"],
        commitAtomicUpdate: (update) => {
          committedResult = update;
        },
      });

      expect(result.status).toBe("applied");
      expect(committedResult).not.toBeNull();
      expect(committedResult.policy.order).toBe("alphabetical");
      expect(committedResult.evictedKeys).toHaveLength(0);
    });

    it("§8.23.3 X2 aborts with 'stale' status when layout revision changed concurrently", async () => {
      let committed = false;
      const result = await applyWorkspaceTabPolicyTransaction({
        workspaceInstanceId: "ws-tab-tx-stale",
        nextPolicyRaw: { limitPerLeaf: 5 },
        baseLayoutRevision: 1,
        currentLayoutRevision: 2, // Changed concurrently
        currentGroups: { primary: { openOrder: ["f1"], pinnedKeys: [], previewKey: null, activeKey: "f1" } },
        openFiles: { f1: { dirty: false } },
        mruFileKeys: ["f1"],
        commitAtomicUpdate: () => {
          committed = true;
        },
      });

      expect(result.status).toBe("stale");
      expect(result.reason).toBe("layout-revision-changed");
      expect(committed).toBe(false);
    });

    it("§8.23.3 X2 calls onEvictClosedFile for evicted keys to purge open buffers", async () => {
      const closedFiles: string[] = [];
      const result = await applyWorkspaceTabPolicyTransaction({
        workspaceInstanceId: "ws-tab-tx-lifecycle",
        nextPolicyRaw: { limitPerLeaf: 1 },
        currentGroups: { primary: { openOrder: ["f1", "f2"], pinnedKeys: [], previewKey: null, activeKey: "f2" } },
        openFiles: { f1: { dirty: false }, f2: { dirty: false } },
        mruFileKeys: ["f2", "f1"],
        onEvictClosedFile: (k) => {
          closedFiles.push(k);
        },
        commitAtomicUpdate: () => {},
      });

      expect(result.status).toBe("applied");
      expect(result.allEvictedKeys).toEqual(["f1"]);
      expect(closedFiles).toEqual(["f1"]);
    });
  });
});
