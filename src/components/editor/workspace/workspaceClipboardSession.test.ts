import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_HISTORY_MAX_ITEMS,
  acquireClipboardStore,
  clipboardStoreForWorkspace,
  planPaste,
  resetWorkspaceClipboardStores,
} from "./workspaceClipboardSession";

describe("workspaceClipboardSession (§8.17.6 step 1)", () => {
  it("keeps one single-slot session per workspace shared by any view id", () => {
    resetWorkspaceClipboardStores();
    const store = clipboardStoreForWorkspace("ws-1");
    const first = store.write({
      sourceViewId: "view-a",
      plainText: "a\nb",
      segments: ["a", "b"],
      rectangular: false,
      sourceEol: "lf",
    });

    // A copy from ANOTHER split view replaces the single slot.
    const second = store.write({
      sourceViewId: "view-b",
      plainText: "rect",
      rectangular: true,
      sourceEol: "lf",
    });
    expect(store.read()?.sessionId).toBe(second.sessionId);
    expect(first.sessionId).not.toBe(second.sessionId);

    // A different workspace has an independent slot.
    const other = clipboardStoreForWorkspace("ws-2");
    expect(other.read()).toBeNull();

    // Session payload survives for cross-view paste with segments intact.
    expect(store.read()?.rectangular).toBe(true);
  });

  it("records system-clipboard unavailability without dropping the payload", () => {
    resetWorkspaceClipboardStores();
    const store = clipboardStoreForWorkspace("ws-x");
    store.write({
      sourceViewId: null,
      plainText: "kept",
      rectangular: false,
      sourceEol: "lf",
      systemClipboardUnavailable: true,
    });
    const session = store.read();
    expect(session?.plainText).toBe("kept");
    expect(session?.systemClipboardUnavailable).toBe(true);
  });

  it("clear() empties the slot", () => {
    resetWorkspaceClipboardStores();
    const store = clipboardStoreForWorkspace("ws-c");
    store.write({ sourceViewId: null, plainText: "x", rectangular: false, sourceEol: "lf" });
    store.clear();
    expect(store.read()).toBeNull();
  });
});

describe("§8.18.4 refcounted clipboard handle lifecycle", () => {
  it("shares one slot across views of the same workspace and isolates workspaces", () => {
    resetWorkspaceClipboardStores();
    const a1 = acquireClipboardStore("ws-a");
    const a2 = acquireClipboardStore("ws-a");
    const b1 = acquireClipboardStore("ws-b");

    a1.write({ sourceViewId: "v1", plainText: "payload-a", rectangular: true, sourceEol: "crlf" });

    expect(a2.read()?.plainText).toBe("payload-a");
    expect(b1.read()).toBeNull();
    a1.release();
    a2.release();
    b1.release();
  });

  it("clears the payload only after the last release (deferred past remounts)", async () => {
    resetWorkspaceClipboardStores();
    const first = acquireClipboardStore("ws-life");
    first.write({ sourceViewId: null, plainText: "kept", rectangular: false, sourceEol: "lf" });

    // Simulate a synchronous remount: release then immediately re-acquire.
    first.release();
    const second = acquireClipboardStore("ws-life");
    await Promise.resolve();
    expect(second.read()?.plainText).toBe("kept");

    // Real teardown: last release clears within a microtask.
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = acquireClipboardStore("ws-life");
    expect(after.read()).toBeNull();
    after.release();
    resetWorkspaceClipboardStores();
  });

  it("keeps the session when the system clipboard failed (typed unavailable)", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-denied");
    handle.write({
      sourceViewId: null,
      plainText: "rect",
      segments: ["a", "b"],
      rectangular: true,
      sourceEol: "lf",
      systemClipboardUnavailable: true,
    });
    const session = handle.read();
    expect(session?.systemClipboardUnavailable).toBe(true);
    expect(session?.segments).toEqual(["a", "b"]);
    handle.clear("user");
    expect(handle.read()).toBeNull();
    handle.release();
    resetWorkspaceClipboardStores();
  });
});

describe("§8.18.4 C3b clipboard history ring", () => {
  it("records history up to 50 items and promotes paste-from-history to the slot", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-hist");
    for (let index = 0; index < CLIPBOARD_HISTORY_MAX_ITEMS + 5; index += 1) {
      handle.write({ sourceViewId: null, plainText: `item-${index}`, rectangular: false, sourceEol: "lf" });
    }
    expect(handle.historyEntries().length).toBeLessThanOrEqual(CLIPBOARD_HISTORY_MAX_ITEMS);
    expect(handle.historyEntries()[0].plainText).toBe(`item-${CLIPBOARD_HISTORY_MAX_ITEMS + 4}`);

    // Pasting an older entry promotes it back to the live slot.
    const promoted = handle.pasteFromHistory(2);
    expect(promoted?.plainText).toBe(`item-${CLIPBOARD_HISTORY_MAX_ITEMS + 2}`);
    expect(handle.read()?.plainText).toBe(`item-${CLIPBOARD_HISTORY_MAX_ITEMS + 2}`);
    handle.release();
    resetWorkspaceClipboardStores();
  });

  it("drops oversized items and everything on disable", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-hist-size");
    const oversized = "x".repeat(300 * 1024);
    handle.write({ sourceViewId: null, plainText: oversized, rectangular: false, sourceEol: "lf" });
    expect(handle.historyEntries()).toHaveLength(0);
    // The slot still owns the payload even though history skipped it.
    expect(handle.read()?.plainText).toBe(oversized);

    handle.setHistoryEnabled(false);
    handle.write({ sourceViewId: null, plainText: "no-history", rectangular: false, sourceEol: "lf" });
    expect(handle.isHistoryEnabled()).toBe(false);
    expect(handle.historyEntries()).toHaveLength(0);
    handle.release();
    resetWorkspaceClipboardStores();
  });
});

describe("§8.18.4 paste plan (documented segment/caret mapping)", () => {
  it("maps N segments × N carets one-to-one", () => {
    const plan = planPaste({
      segments: ["a", "b"],
      plainText: "a\nb",
      caretCount: 2,
      rectangular: true,
      sourceEol: "lf",
    });
    expect(plan.perCaret).toEqual(["a", "b"]);
    expect(plan.degraded).toBe(false);
  });

  it("cycles deterministically when there are fewer segments than carets", () => {
    const plan = planPaste({
      segments: ["x"],
      plainText: "x",
      caretCount: 3,
      rectangular: false,
      sourceEol: "crlf",
    });
    expect(plan.perCaret).toEqual(["x", "x", "x"]);
    expect(plan.degraded).toBe("fewer-segments-cycled");
  });

  it("flags extra segments instead of silently dropping them", () => {
    const plan = planPaste({
      segments: ["a", "b", "c"],
      plainText: "a\nb\nc",
      caretCount: 2,
      rectangular: true,
      sourceEol: "lf",
    });
    expect(plan.perCaret).toEqual(["a", "b"]);
    expect(plan.degraded).toBe("extra-segments-dropped");
  });

  it("falls back to whole-block insertion without segments", () => {
    const plan = planPaste({ segments: null, plainText: "block", caretCount: 2, rectangular: false, sourceEol: "lf" });
    expect(plan.perCaret).toEqual([null, null]);
    expect(plan.degraded).toBe("whole-block");
  });
});

describe("§8.27.2 BB1 clipboard lease model and permission epoch", () => {
  it("manages independent consumer leases and idempotent detach without releasing root", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-bb1-lease");
    const lease1 = handle.attachConsumer("split-1", "editor");
    const lease2 = handle.attachConsumer("split-2", "editor");

    expect(lease1.token).toBeDefined();
    expect(lease2.token).toBeDefined();
    expect(lease1.token).not.toBe(lease2.token);

    const snap = handle.getSnapshot();
    expect(snap.consumers).toHaveLength(2);
    expect(snap.lifecycleRevision).toBe(2);

    // Idempotent detach
    expect(lease1.detach()).toBe("detached");
    expect(lease1.detach()).toBe("already-detached");

    const snapAfter1 = handle.getSnapshot();
    expect(snapAfter1.consumers).toHaveLength(1);
    expect(snapAfter1.consumers[0].token).toBe(lease2.token);

    // Detaching lease2 does not destroy the root handle
    expect(lease2.detach()).toBe("detached");
    expect(handle.getSnapshot().consumers).toHaveLength(0);

    // Root write and read still work
    handle.write({ sourceViewId: null, plainText: "test", rectangular: false, sourceEol: "lf" });
    expect(handle.read()?.plainText).toBe("test");

    handle.release();
    resetWorkspaceClipboardStores();
  });

  it("updates permission generation ONLY on actual permission changes", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-bb1-perm");

    expect(handle.permission()).toBe("unknown");
    expect(handle.getSnapshot().permissionGeneration).toBe(1);

    // Setting the same permission does not bump generation
    handle.setPermission("unknown");
    expect(handle.getSnapshot().permissionGeneration).toBe(1);

    // Changing permission bumps generation
    handle.setPermission("granted");
    expect(handle.permission()).toBe("granted");
    expect(handle.getSnapshot().permissionGeneration).toBe(2);

    handle.setPermission("granted");
    expect(handle.getSnapshot().permissionGeneration).toBe(2);

    handle.setPermission("denied");
    expect(handle.permission()).toBe("denied");
    expect(handle.getSnapshot().permissionGeneration).toBe(3);

    handle.release();
    resetWorkspaceClipboardStores();
  });

  it("increments revisions accurately (no bump for same-value policy or pure read)", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-bb1-rev");

    const snap0 = handle.getSnapshot();
    expect(snap0.payloadRevision).toBe(0);
    expect(snap0.historyRevision).toBe(0);
    expect(snap0.policyRevision).toBe(0);

    // Pure read does not increment revisions
    handle.read();
    expect(handle.getSnapshot().payloadRevision).toBe(0);

    // Write increments payloadRevision and historyRevision (if eligible)
    handle.write({ sourceViewId: null, plainText: "hello", rectangular: false, sourceEol: "lf" });
    const snap1 = handle.getSnapshot();
    expect(snap1.payloadRevision).toBe(1);
    expect(snap1.historyRevision).toBe(1);

    // Sensitive write does not enter history and does not increment historyRevision
    handle.write({
      sourceViewId: null,
      plainText: "AKIAIOSFODNN7EXAMPLE",
      rectangular: false,
      sourceEol: "lf",
      sensitive: true,
    });
    const snap2 = handle.getSnapshot();
    expect(snap2.payloadRevision).toBe(2);
    expect(snap2.historyRevision).toBe(1); // unchanged

    // Setting same policy limits does not increment policyRevision
    handle.setHistoryLimits(CLIPBOARD_HISTORY_MAX_ITEMS, 1024 * 1024);
    expect(handle.getSnapshot().policyRevision).toBe(0);

    // Changing policy limits increments policyRevision
    handle.setHistoryLimits(10, 2048);
    expect(handle.getSnapshot().policyRevision).toBe(1);

    // Setting same limits again does not increment
    handle.setHistoryLimits(10, 2048);
    expect(handle.getSnapshot().policyRevision).toBe(1);

    // Failed remove does not increment historyRevision
    const removed = handle.removeHistoryEntry(999);
    expect(removed).toBe(false);
    expect(handle.getSnapshot().historyRevision).toBe(1);

    handle.release();
    resetWorkspaceClipboardStores();
  });

  it("isolates subscriber errors without breaking store operations", () => {
    resetWorkspaceClipboardStores();
    const handle = acquireClipboardStore("ws-bb1-sub-err");
    let goodListenerCalled = 0;

    handle.subscribe(() => {
      throw new Error("Subscriber crash!");
    });
    handle.subscribe(() => {
      goodListenerCalled += 1;
    });

    handle.write({ sourceViewId: null, plainText: "safe", rectangular: false, sourceEol: "lf" });
    expect(goodListenerCalled).toBe(1);
    expect(handle.read()?.plainText).toBe("safe");

    handle.release();
    resetWorkspaceClipboardStores();
  });
});

