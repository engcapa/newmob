import { afterEach, describe, expect, it } from "vitest";
import {
  acquireClipboardStore,
  CLIPBOARD_HISTORY_MAX_ITEM_BYTES,
  resetWorkspaceClipboardStores,
  type ClipboardHistoryExclusion,
} from "./workspaceClipboardSession";

afterEach(() => resetWorkspaceClipboardStores());

function writeText(handle: ReturnType<typeof acquireClipboardStore>, text: string) {
  return handle.write({
    sourceViewId: "v1",
    plainText: text,
    segments: undefined,
    rectangular: false,
    sourceEol: "lf" as const,
  });
}

describe("§8.19.5 clipboard history ring", () => {
  it("keeps the ring session-only: last handle release clears everything", async () => {
    const handle = acquireClipboardStore("ws-history");
    writeText(handle, "alpha");
    handle.release();
    // Second handle in the same workspace keeps state alive (refcount).
    const first = acquireClipboardStore("ws-refcount");
    const second = acquireClipboardStore("ws-refcount");
    writeText(first, "beta");
    expect(second.historyEntries()).toHaveLength(1);
    first.release();
    expect(second.historyEntries()).toHaveLength(1);
    second.release();
    // Release cleanup is deferred one microtask (remount safety).
    await Promise.resolve();
    // Slot gone: a fresh acquire sees an empty ring.
    const fresh = acquireClipboardStore("ws-refcount");
    expect(fresh.historyEntries()).toHaveLength(0);
  });

  it("evicts oldest entries beyond item and total-byte limits", () => {
    const handle = acquireClipboardStore("ws-evict");
    for (let i = 0; i < 60; i += 1) writeText(handle, `entry-${i}`);
    expect(handle.historyEntries().length).toBeLessThanOrEqual(50);
    expect(handle.historyEntries()[0].plainText).toBe("entry-59");
    handle.setHistoryLimits(5, 1024 * 1024);
    expect(handle.historyEntries().length).toBe(5);
    // Limits clamp into the documented 1–50 range.
    handle.setHistoryLimits(500, 1024 * 1024);
    expect(handle.historyLimits().maxItems).toBe(50);
    handle.setHistoryLimits(0, 512);
    expect(handle.historyLimits().maxItems).toBe(1);
    expect(handle.historyLimits().maxTotalBytes).toBe(1024);
  });

  it("excludes sensitive payloads from history but keeps the live slot", () => {
    const handle = acquireClipboardStore("ws-sensitive");
    handle.write({
      sourceViewId: "v1",
      plainText: "hunter2",
      segments: undefined,
      rectangular: false,
      sourceEol: "lf",
      sensitive: true,
    });
    expect(handle.read()?.plainText).toBe("hunter2");
    expect(handle.historyEntries()).toHaveLength(0);
    expect(handle.historyExclusion()).toBe<ClipboardHistoryExclusion>("sensitive");
  });

  it("excludes oversized payloads with a typed non-blocking notice", () => {
    const handle = acquireClipboardStore("ws-oversize");
    handle.write({
      sourceViewId: "v1",
      plainText: "x".repeat(CLIPBOARD_HISTORY_MAX_ITEM_BYTES + 10),
      segments: undefined,
      rectangular: false,
      sourceEol: "lf",
    });
    expect(handle.historyEntries()).toHaveLength(0);
    expect(handle.historyExclusion()).toBe("oversized-item");
  });

  it("supports Delete of a single entry and dedupe promotes duplicates", () => {
    const handle = acquireClipboardStore("ws-delete");
    writeText(handle, "one");
    writeText(handle, "two");
    writeText(handle, "three");
    expect(handle.removeHistoryEntry(1)).toBe(true);
    expect(handle.historyEntries().map((entry) => entry.plainText)).toEqual(["three", "one"]);
    expect(handle.removeHistoryEntry(9)).toBe(false);
    // Re-writing "one" moves it to the top instead of duplicating.
    writeText(handle, "one");
    expect(handle.historyEntries().map((entry) => entry.plainText)).toEqual(["one", "three"]);
  });

  it("pasting from history promotes the entry to the live slot", () => {
    const handle = acquireClipboardStore("ws-promote");
    writeText(handle, "older");
    writeText(handle, "newer");
    const promoted = handle.pasteFromHistory(1);
    expect(promoted?.plainText).toBe("older");
    expect(handle.read()?.plainText).toBe("older");
  });

  it("disable wipes the ring; clear removes entries but keeps the slot", () => {
    const handle = acquireClipboardStore("ws-disable");
    writeText(handle, "keep-in-slot");
    handle.setHistoryEnabled(false);
    expect(handle.historyEntries()).toHaveLength(0);
    expect(handle.isHistoryEnabled()).toBe(false);
    expect(handle.read()?.plainText).toBe("keep-in-slot");

    const other = acquireClipboardStore("ws-clear");
    writeText(other, "a");
    other.clearHistory();
    expect(other.historyEntries()).toHaveLength(0);
    expect(other.read()?.plainText).toBe("a");
  });
});
