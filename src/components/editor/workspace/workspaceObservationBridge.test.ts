import { describe, expect, it, vi } from "vitest";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";
import { WorkspaceSemanticQueryHost } from "./workspaceSemanticQueryHost";
import { WorkspaceObservationBridge } from "./workspaceObservationBridge";

const HASH = "a".repeat(64);

describe("§ED-QA-001: WorkspaceObservationBridge", () => {
  it("receives metadata from production document and query owners", async () => {
    const bridge = new WorkspaceObservationBridge("ws-production-path");
    const owner = new WorkspaceDocumentTransactionOwner({
      onTransaction: ({ fileKey, revision }) => bridge.observeDocumentRevision(fileKey, revision),
      onHistoryReceipt: ({ fileKey, revision }) => bridge.observeHistoryReceipt(`${fileKey}:${revision}`),
      onViewLeaseChanged: ({ delta }) => bridge.observeLeaseDelta(delta),
    });
    owner.acquireView("file-1.ts", "primary", "before");
    owner.dispatchTransaction("file-1.ts", "primary", [{ from: 6, to: 6, insert: "!" }]);
    owner.undo("file-1.ts", "primary");

    const queryHost = new WorkspaceSemanticQueryHost({
      onRequest: ({ kind }) => bridge.observeProviderRequest(kind),
      onCancel: ({ kind }) => bridge.observeProviderCancel(kind),
    });
    await queryHost.executeEnvelope({
      kind: "definitions",
      identity: {
        workspaceId: "ws-production-path",
        fileKey: "file-1.ts",
        uri: "file:///repo/file-1.ts",
        position: { line: 0, character: 0 },
        documentRevision: 1,
        lspSessionGeneration: 1,
        requestId: "query-1",
      },
      fetcher: async () => [],
    });

    const snapshot = bridge.getSnapshot();
    expect(snapshot.source).toBe("workspace-production-owners");
    expect(snapshot.observationStatus).toBe("ready");
    expect(snapshot.documentRevisions["file-1.ts"]).toBe(2);
    expect(snapshot.providerRequestCounts.definitions).toBe(1);
    expect(snapshot.resourceLeaseCount).toBe(1);
    expect(snapshot.historyReceiptCount).toBe(2);
    expect(snapshot).not.toHaveProperty("execute");

    owner.releaseView("file-1.ts", "primary");
    expect(bridge.getSnapshot().resourceLeaseCount).toBe(0);
  });

  it("observes a settled save only through its receipt hash and history identity", () => {
    const bridge = new WorkspaceObservationBridge("ws-save");
    bridge.observeSaveResult({
      fileKey: "file-1.ts",
      bufferRevision: 4,
      result: {
        transactionId: "tx-1",
        diskEffect: "committed",
        receipt: {
          transactionId: "tx-1",
          encodedBytesSha256: HASH,
          historyId: "history-1",
        },
      },
    });

    const snapshot = bridge.getSnapshot();
    expect(snapshot.diskWriteCount).toBe(1);
    expect(snapshot.diskWriteSha256List).toEqual([HASH]);
    expect(snapshot.historyReceiptCount).toBe(1);
    expect(snapshot.documentRevisions["file-1.ts"]).toBe(4);
  });

  it("keeps cancelled/unknown saves observable without inventing a disk write", () => {
    const bridge = new WorkspaceObservationBridge("ws-save-negative");
    bridge.observeSaveResult({
      fileKey: "file-1.ts",
      bufferRevision: 5,
      result: { transactionId: "tx-cancelled", diskEffect: "none" },
    });
    bridge.observeSaveResult({
      fileKey: "file-1.ts",
      bufferRevision: 6,
      result: { transactionId: "tx-unknown", diskEffect: "unknown" },
    });

    const snapshot = bridge.getSnapshot();
    expect(snapshot.documentRevisions["file-1.ts"]).toBe(6);
    expect(snapshot.diskWriteCount).toBe(0);
    expect(snapshot.historyReceiptCount).toBe(0);
  });

  it("fails closed for missing and stale owner observations", () => {
    const bridge = new WorkspaceObservationBridge("ws-stale");
    expect(bridge.getSnapshot().observationStatus).toBe("missing");
    expect(bridge.getSnapshot().providerRequestCounts).toEqual({});

    bridge.observeProviderRequest("references");
    const observedAt = bridge.getSnapshot().observedAt;
    const stale = bridge.getSnapshot({ maxAgeMs: 0, now: observedAt + 1 });
    expect(stale.observationStatus).toBe("stale");
    expect(stale.isFresh).toBe(false);
    expect(stale.providerRequestCounts).toEqual({});
    expect(stale.diskWriteCount).toBe(0);
  });

  it("keeps production mode disabled and never exposes owner telemetry", () => {
    const bridge = new WorkspaceObservationBridge("ws-prod", true);
    const listener = vi.fn();
    bridge.subscribe(listener);
    bridge.observeProviderRequest("definitions");
    bridge.observeDiskWriteHash(HASH);
    bridge.observeLeaseAcquired();

    const snapshot = bridge.getSnapshot();
    expect(snapshot.observationStatus).toBe("disabled");
    expect(snapshot.isProduction).toBe(true);
    expect(snapshot.source).toBe("workspace-production-owners");
    expect(snapshot.providerRequestCounts).toEqual({});
    expect(snapshot.diskWriteSha256List).toHaveLength(0);
    expect(snapshot.resourceLeaseCount).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects non-redacted disk values and isolates subscribers", () => {
    const bridge = new WorkspaceObservationBridge("ws-redaction");
    const failingListener = vi.fn(() => {
      throw new Error("subscriber failure");
    });
    const healthyListener = vi.fn();
    bridge.subscribe(failingListener);
    bridge.subscribe(healthyListener);

    bridge.observeDiskWriteHash("source text must not cross the observation boundary");
    bridge.observeDiskWriteHash(HASH);

    expect(bridge.getSnapshot().diskWriteSha256List).toEqual([HASH]);
    expect(failingListener).toHaveBeenCalledTimes(1);
    expect(healthyListener).toHaveBeenCalledTimes(1);
  });
});
