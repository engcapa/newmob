import { describe, expect, it } from "vitest";
import {
  clipboardStoreForWorkspace,
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
