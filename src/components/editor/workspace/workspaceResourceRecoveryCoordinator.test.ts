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

  it.each(RESOURCE_CLEANUP_STAGES)(
    "records and idempotently replays a failure at %s without running later stages early",
    async (failedStage) => {
      const coordinator = new WorkspaceResourceRecoveryCoordinator(`ws-test-failure-${failedStage}`);
      const attempts: Record<ResourceCleanupStage, number> = {
        didClose: 0,
        watcher: 0,
        buffer: 0,
        history: 0,
      };
      const failedIndex = RESOURCE_CLEANUP_STAGES.indexOf(failedStage);
      const handlers = (fail: boolean): ResourceCleanupHandlers => Object.fromEntries(
        RESOURCE_CLEANUP_STAGES.map((stage) => [stage, vi.fn(async () => {
          attempts[stage] += 1;
          if (fail && stage === failedStage) throw new Error(`${stage} cleanup failed`);
        })]),
      );

      const lease = coordinator.acquireLease(`fail-${failedStage}.java`, "editor-group");
      const failed = await lease.release(handlers(true));

      expect(failed.status).toBe("committed-with-recovery");
      if (failed.status !== "committed-with-recovery") return;
      expect(failed.recoveryId).toMatch(/^resource-recovery-/);
      expect(failed.nextStage).toBe(failedStage);
      expect(failed.completedStages).toEqual(RESOURCE_CLEANUP_STAGES.slice(0, failedIndex));
      expect(failed.failedStages).toEqual([
        expect.objectContaining({ stage: failedStage, error: `${failedStage} cleanup failed` }),
      ]);

      for (const [index, stage] of RESOURCE_CLEANUP_STAGES.entries()) {
        expect(attempts[stage]).toBe(index <= failedIndex ? 1 : 0);
      }

      const pending = coordinator.getPendingRecovery(`fail-${failedStage}.java`);
      expect(pending).toEqual(expect.objectContaining({
        recoveryId: failed.recoveryId,
        nextStage: failedStage,
      }));
      expect(await coordinator.replayRecoveryById("unknown-recovery", handlers(false))).toBeNull();

      const replayed = await coordinator.replayRecoveryById(failed.recoveryId, handlers(false));
      expect(replayed).toEqual(expect.objectContaining({
        status: "committed",
        recoveryId: failed.recoveryId,
        completedStages: RESOURCE_CLEANUP_STAGES,
      }));
      for (const stage of RESOURCE_CLEANUP_STAGES) {
        expect(attempts[stage]).toBe(stage === failedStage ? 2 : 1);
      }

      const replayedAgain = await coordinator.replayRecoveryById(failed.recoveryId, handlers(false));
      expect(replayedAgain).toEqual(replayed);
      for (const stage of RESOURCE_CLEANUP_STAGES) {
        expect(attempts[stage]).toBe(stage === failedStage ? 2 : 1);
      }
      expect(coordinator.getPendingRecovery(`fail-${failedStage}.java`)).toBeNull();
    },
  );

  it("coalesces concurrent cleanup for one resource so each stage executes once", async () => {
    const coordinator = new WorkspaceResourceRecoveryCoordinator("ws-test-concurrent");
    let releaseDidClose!: () => void;
    const didCloseGate = new Promise<void>((resolve) => {
      releaseDidClose = resolve;
    });
    const handlers: ResourceCleanupHandlers = {
      didClose: vi.fn(() => didCloseGate),
      watcher: vi.fn(),
      buffer: vi.fn(),
      history: vi.fn(),
    };

    const first = coordinator.executeResourceCleanup("shared-concurrent.ts", handlers);
    const second = coordinator.executeResourceCleanup("shared-concurrent.ts", handlers);
    await vi.waitFor(() => expect(handlers.didClose).toHaveBeenCalledTimes(1));
    releaseDidClose();

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(secondOutcome).toEqual(firstOutcome);
    expect(firstOutcome.status).toBe("committed");
    expect(handlers.didClose).toHaveBeenCalledTimes(1);
    expect(handlers.watcher).toHaveBeenCalledTimes(1);
    expect(handlers.buffer).toHaveBeenCalledTimes(1);
    expect(handlers.history).toHaveBeenCalledTimes(1);
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
