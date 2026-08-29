import { describe, expect, it, vi } from "vitest";
import {
  RESOURCE_CLEANUP_STAGES,
  WorkspaceResourceRecoveryCoordinator,
  type ResourceCleanupHandlers,
  type ResourceCleanupStage,
} from "./workspaceResourceRecoveryCoordinator";

describe("§ED-TABS-003 WorkspaceResourceRecoveryCoordinator", () => {
  it("maintains strict 4-stage pipeline execution order: didClose -> watcher -> buffer -> history", async () => {
    const coordinator = new WorkspaceResourceRecoveryCoordinator("ws-test-order");
    const executionOrder: ResourceCleanupStage[] = [];

    const handlers: ResourceCleanupHandlers = {
      didClose: vi.fn(async () => {
        executionOrder.push("didClose");
      }),
      watcher: vi.fn(async () => {
        executionOrder.push("watcher");
      }),
      buffer: vi.fn(async () => {
        executionOrder.push("buffer");
      }),
      history: vi.fn(async () => {
        executionOrder.push("history");
      }),
    };

    const { release } = coordinator.acquireLease("fileA.ts", "editor-group", { groupId: "primary" });
    const outcome = await release(handlers);

    expect(outcome.status).toBe("committed");
    if (outcome.status === "committed") {
      expect(outcome.completedStages).toEqual(RESOURCE_CLEANUP_STAGES);
    }
    expect(executionOrder).toEqual(["didClose", "watcher", "buffer", "history"]);
  });

  it("handles same-file dual split: retains resource on first split close, executes cleanup only on last split close", async () => {
    const coordinator = new WorkspaceResourceRecoveryCoordinator("ws-test-dual-split");
    const executed: string[] = [];

    const handlers: ResourceCleanupHandlers = {
      didClose: vi.fn(async (k) => { executed.push(`didClose:${k}`); }),
      watcher: vi.fn(async (k) => { executed.push(`watcher:${k}`); }),
      buffer: vi.fn(async (k) => { executed.push(`buffer:${k}`); }),
      history: vi.fn(async (k) => { executed.push(`history:${k}`); }),
    };

    const leasePrimary = coordinator.acquireLease("shared.ts", "editor-group", { groupId: "primary" });
    const leaseSecondary = coordinator.acquireLease("shared.ts", "editor-group", { groupId: "secondary" });

    expect(coordinator.getLeasesForFile("shared.ts")).toHaveLength(2);

    // Release primary split lease: resource is still leased by secondary split!
    const outcome1 = await leasePrimary.release(handlers);
    expect(outcome1.status).toBe("retained");
    if (outcome1.status === "retained") {
      expect(outcome1.remainingLeaseCount).toBe(1);
    }
    expect(executed).toHaveLength(0); // 0 cleanup handlers executed

    // Release secondary split lease: last lease released -> 4 stages executed!
    const outcome2 = await leaseSecondary.release(handlers);
    expect(outcome2.status).toBe("committed");
    if (outcome2.status === "committed") {
      expect(outcome2.completedStages).toEqual(RESOURCE_CLEANUP_STAGES);
    }
    expect(executed).toEqual([
      "didClose:shared.ts",
      "watcher:shared.ts",
      "buffer:shared.ts",
      "history:shared.ts",
    ]);
  });

  it("retains resource when diff/preview/save leases are active and cleans up when all leases release", async () => {
    const coordinator = new WorkspaceResourceRecoveryCoordinator("ws-test-save-lease");
    const bufferCleaned: string[] = [];

    const handlers: ResourceCleanupHandlers = {
      buffer: vi.fn(async (k) => { bufferCleaned.push(k); }),
    };

    const editorLease = coordinator.acquireLease("target.rs", "editor-group", { groupId: "primary" });
    const saveLease = coordinator.acquireLease("target.rs", "save");
    const diffLease = coordinator.acquireLease("target.rs", "diff");

    expect(coordinator.getLeasesForFile("target.rs")).toHaveLength(3);

    // Editor tab closes while save & diff are in-flight
    const o1 = await editorLease.release(handlers);
    expect(o1.status).toBe("retained");
    expect(bufferCleaned).toHaveLength(0);

    // Diff closes
    const o2 = await diffLease.release(handlers);
    expect(o2.status).toBe("retained");
    expect(bufferCleaned).toHaveLength(0);

    // In-flight save completes
    const o3 = await saveLease.release(handlers);
    expect(o3.status).toBe("committed");
    expect(bufferCleaned).toEqual(["target.rs"]);
  });

  it("handles failure at any step by returning committed-with-recovery and supports idempotent replay", async () => {
    const coordinator = new WorkspaceResourceRecoveryCoordinator("ws-test-failure");
    let didCloseAttempts = 0;
    let watcherAttempts = 0;
    let bufferAttempts = 0;
    let historyAttempts = 0;

    const failingHandlers: ResourceCleanupHandlers = {
      didClose: vi.fn(async () => {
        didCloseAttempts += 1;
        throw new Error("LSP connection dropped");
      }),
      watcher: vi.fn(async () => {
        watcherAttempts += 1;
      }),
      buffer: vi.fn(async () => {
        bufferAttempts += 1;
      }),
      history: vi.fn(async () => {
        historyAttempts += 1;
      }),
    };

    const lease = coordinator.acquireLease("fail.java", "editor-group");
    const outcome1 = await lease.release(failingHandlers);

    expect(outcome1.status).toBe("committed-with-recovery");
    if (outcome1.status === "committed-with-recovery") {
      expect(outcome1.completedStages).toEqual(["watcher", "buffer", "history"]);
      expect(outcome1.failedStages).toHaveLength(1);
      expect(outcome1.failedStages[0].stage).toBe("didClose");
      expect(outcome1.failedStages[0].error).toContain("LSP connection dropped");
    }

    // Pending recovery state recorded
    const pending = coordinator.getPendingRecovery("fail.java");
    expect(pending).not.toBeNull();

    // Now replay recovery with fixed didClose handler
    const fixedHandlers: ResourceCleanupHandlers = {
      didClose: vi.fn(async () => {
        didCloseAttempts += 1;
      }),
      watcher: vi.fn(async () => {
        watcherAttempts += 1;
      }),
      buffer: vi.fn(async () => {
        bufferAttempts += 1;
      }),
      history: vi.fn(async () => {
        historyAttempts += 1;
      }),
    };

    const replayOutcome = await coordinator.replayRecovery("fail.java", fixedHandlers);
    expect(replayOutcome?.status).toBe("committed");
    if (replayOutcome?.status === "committed") {
      expect(replayOutcome.completedStages).toEqual(RESOURCE_CLEANUP_STAGES);
    }

    // didClose was retried (total 2), but watcher, buffer, and history were NOT re-executed (total 1 each)!
    expect(didCloseAttempts).toBe(2);
    expect(watcherAttempts).toBe(1);
    expect(bufferAttempts).toBe(1);
    expect(historyAttempts).toBe(1);

    // Pending recovery cleared
    expect(coordinator.getPendingRecovery("fail.java")).toBeNull();
  });

  it("reconciles active keys by cleaning up unreferenced leases", async () => {
    const coordinator = new WorkspaceResourceRecoveryCoordinator("ws-test-reconcile");
    const cleanedKeys: string[] = [];

    const handlers: ResourceCleanupHandlers = {
      buffer: vi.fn(async (k) => { cleanedKeys.push(k); }),
    };

    coordinator.acquireLease("file1.ts", "editor-group");
    coordinator.acquireLease("file2.ts", "editor-group");
    coordinator.acquireLease("file3.ts", "editor-group");

    // Live layout now only references file1 and file3
    const outcomes = await coordinator.reconcileActiveKeys(["file1.ts", "file3.ts"], handlers);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].fileKey).toBe("file2.ts");
    expect(outcomes[0].status).toBe("committed");
    expect(cleanedKeys).toEqual(["file2.ts"]);
    expect(coordinator.hasActiveLeases("file2.ts")).toBe(false);
    expect(coordinator.hasActiveLeases("file1.ts")).toBe(true);
  });
});
