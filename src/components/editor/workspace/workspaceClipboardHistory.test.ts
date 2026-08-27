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

  it("shrinks history immediately when limit is lowered below current length", () => {
    const handle = acquireClipboardStore("ws-shrink");
    for (let i = 0; i < 10; i++) writeText(handle, `item-${i}`);
    expect(handle.historyEntries()).toHaveLength(10);
    handle.setHistoryLimits(3, 1024 * 1024);
    expect(handle.historyEntries()).toHaveLength(3);
    expect(handle.historyEntries().map((e) => e.plainText)).toEqual(["item-9", "item-8", "item-7"]);
  });

  it("guarantees persistence isolation: localStorage never contains clipboard payload", () => {
    const wsId = "ws-no-storage-leak";
    const handle = acquireClipboardStore(wsId);
    const secretText = "ultra-secret-token-payload-xyz123";
    writeText(handle, secretText);

    // Assert that nowhere in localStorage is the clipboard payload stored
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const val = localStorage.getItem(key);
        expect(val).not.toContain(secretText);
      }
    }
  });

  it("§8.22.3 U2-A guarantees canonical workspace clipboard ownership across multiple splits", () => {
    const wsInstanceId = "ws-canonical-owner";
    const splitA = acquireClipboardStore(wsInstanceId);
    const splitB = acquireClipboardStore(wsInstanceId);

    // Split A copies multi-caret rectangular selection
    splitA.write({
      sourceViewId: "split-a-editor",
      plainText: "col1\ncol2",
      segments: ["col1", "col2"],
      rectangular: true,
      sourceEol: "lf",
    });

    // Split B immediately reads the exact same session and segments
    const readFromB = splitB.read();
    expect(readFromB).not.toBeNull();
    expect(readFromB?.plainText).toBe("col1\ncol2");
    expect(readFromB?.rectangular).toBe(true);
    expect(readFromB?.segments).toEqual(["col1", "col2"]);

    // Both splits see identical history entries
    expect(splitA.historyEntries()).toHaveLength(1);
    expect(splitB.historyEntries()).toHaveLength(1);
    expect(splitB.historyEntries()[0].plainText).toBe("col1\ncol2");

    splitA.release();
    splitB.release();
  });

  it("§8.22.3 U2-A auto-detects private keys and API tokens as sensitive and excludes them from history", () => {
    const handle = acquireClipboardStore("ws-auto-sensitive");
    const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
    handle.write({
      sourceViewId: "editor",
      plainText: privateKey,
      rectangular: false,
      sourceEol: "lf",
    });

    expect(handle.read()?.plainText).toBe(privateKey);
    expect(handle.read()?.sensitive).toBe(true);
    expect(handle.historyEntries()).toHaveLength(0);
    expect(handle.historyExclusion()).toBe<ClipboardHistoryExclusion>("sensitive");
    handle.release();
  });

  it("§8.23.2 X1 ensures full isolation between workspace A and workspace B and proper refcount disposal", async () => {
    const wsA1 = acquireClipboardStore("ws-alpha");
    const wsA2 = acquireClipboardStore("ws-alpha");
    const wsB = acquireClipboardStore("ws-beta");

    // Copy in workspace Alpha
    wsA1.write({
      sourceViewId: "view-a1",
      plainText: "secret alpha data",
      rectangular: false,
      sourceEol: "lf",
    });

    // Workspace Beta cannot see workspace Alpha data
    expect(wsB.read()).toBeNull();
    expect(wsB.historyEntries()).toHaveLength(0);

    // Split 1 of workspace Alpha unmounts/releases, but Split 2 keeps the store alive
    wsA1.release();
    expect(wsA2.read()?.plainText).toBe("secret alpha data");
    expect(wsA2.historyEntries()).toHaveLength(1);

    // Split 2 releases, now the store for Alpha is disposed after microtask
    wsA2.release();
    await new Promise((r) => setTimeout(r, 5));

    // Re-acquiring workspace Alpha gets a fresh, empty session store (session-only lifetime)
    const wsAFresh = acquireClipboardStore("ws-alpha");
    expect(wsAFresh.read()).toBeNull();
    expect(wsAFresh.historyEntries()).toHaveLength(0);
    wsAFresh.release();
    wsB.release();
  });
});
