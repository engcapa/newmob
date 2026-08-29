import { describe, expect, it } from "vitest";
import { WorkspaceObservationBridge } from "./workspaceObservationBridge";

describe("§ED-QA-001: WorkspaceObservationBridge", () => {
  it("collects read-only telemetry counters and redacts raw disk text into SHA256 hashes", () => {
    const bridge = new WorkspaceObservationBridge("ws-test", false);

    bridge.recordDocumentRevision("file-1.ts", 4);
    bridge.recordProviderRequest("definitions");
    bridge.recordProviderRequest("definitions");
    bridge.recordProviderCancel("definitions");
    bridge.recordDiskWrite("const secret = 'do-not-leak';\n");
    bridge.recordLeaseAcquired();
    bridge.recordHistoryReceipt();
    bridge.recordClipboardSession(2, 3);

    const snap = bridge.getSnapshot();
    expect(snap.workspaceId).toBe("ws-test");
    expect(snap.isProduction).toBe(false);
    expect(snap.documentRevisions["file-1.ts"]).toBe(4);
    expect(snap.providerRequestCounts["definitions"]).toBe(2);
    expect(snap.providerCancelCounts["definitions"]).toBe(1);
    expect(snap.diskWriteCount).toBe(1);
    // Verifies SHA256 hash length and no plain text leaked
    expect(snap.diskWriteSha256List[0]).toHaveLength(64);
    expect(snap.diskWriteSha256List[0]).not.toContain("secret");
    expect(snap.resourceLeaseCount).toBe(1);
    expect(snap.historyReceiptCount).toBe(1);
    expect(snap.clipboardSessionRevision).toBe(2);
    expect(snap.clipboardConsumerCount).toBe(3);
  });

  it("freezes and returns empty telemetry in production mode", () => {
    const bridge = new WorkspaceObservationBridge("ws-prod", true);

    bridge.recordDocumentRevision("file-1.ts", 10);
    bridge.recordProviderRequest("definitions");
    bridge.recordDiskWrite("sensitive-prod-data");

    const snap = bridge.getSnapshot();
    expect(snap.isProduction).toBe(true);
    expect(snap.diskWriteCount).toBe(0);
    expect(snap.diskWriteSha256List).toHaveLength(0);
    expect(Object.keys(snap.providerRequestCounts)).toHaveLength(0);
    expect(Object.keys(snap.documentRevisions)).toHaveLength(0);
  });

  it("supports reset without mutating any outside state", () => {
    const bridge = new WorkspaceObservationBridge("ws-test", false);
    bridge.recordProviderRequest("hover");
    expect(bridge.getSnapshot().providerRequestCounts["hover"]).toBe(1);

    bridge.reset();
    expect(bridge.getSnapshot().providerRequestCounts["hover"]).toBeUndefined();
    expect(bridge.getSnapshot().diskWriteCount).toBe(0);
  });
});
