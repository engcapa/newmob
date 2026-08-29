/**
 * §8.27.3 / §ED-TABS-003: Workspace Resource Recovery Coordinator.
 *
 * Manages resource view leases (splits, previews, diffs, in-flight saves)
 * and coordinates the four-stage resource cleanup pipeline:
 *
 *   didClose -> watcher -> buffer -> history
 *
 * Execution begins ONLY when the last view lease on a resource is released.
 * If any stage fails, the coordinator records the failure, marks the resource
 * as `committed-with-recovery`, and supports idempotent replays without
 * repeating already completed stages or swallowing errors.
 */

export type ResourceCleanupStage = "didClose" | "watcher" | "buffer" | "history";

export const RESOURCE_CLEANUP_STAGES: readonly ResourceCleanupStage[] = Object.freeze([
  "didClose",
  "watcher",
  "buffer",
  "history",
]);

export type ResourceLeaseKind = "editor-group" | "preview" | "diff" | "save";

export interface ResourceLease {
  readonly id: string;
  readonly fileKey: string;
  readonly kind: ResourceLeaseKind;
  readonly groupId?: string;
}

export interface ResourceCleanupFailure {
  readonly stage: ResourceCleanupStage;
  readonly error: string;
  readonly timestamp: number;
}

export interface ResourceCleanupHandlers {
  readonly didClose?: (fileKey: string) => Promise<void> | void;
  readonly watcher?: (fileKey: string) => Promise<void> | void;
  readonly buffer?: (fileKey: string) => Promise<void> | void;
  readonly history?: (fileKey: string) => Promise<void> | void;
}

export type ResourceCleanupOutcome =
  | {
      readonly status: "committed";
      readonly fileKey: string;
      readonly completedStages: readonly ResourceCleanupStage[];
    }
  | {
      readonly status: "committed-with-recovery";
      readonly fileKey: string;
      readonly completedStages: readonly ResourceCleanupStage[];
      readonly failedStages: readonly ResourceCleanupFailure[];
      readonly message: string;
    }
  | {
      readonly status: "retained";
      readonly fileKey: string;
      readonly remainingLeaseCount: number;
      readonly activeLeases: readonly ResourceLease[];
    };

export interface ResourceRecoveryState {
  readonly fileKey: string;
  readonly completedStages: readonly ResourceCleanupStage[];
  readonly failedStages: readonly ResourceCleanupFailure[];
  readonly lastAttemptAt: number;
}

export class WorkspaceResourceRecoveryCoordinator {
  private readonly workspaceInstanceId: string;
  private readonly leasesById = new Map<string, ResourceLease>();
  private readonly leaseIdsByFileKey = new Map<string, Set<string>>();
  private readonly recoveryByFileKey = new Map<string, ResourceRecoveryState>();
  private leaseSequence = 0;

  constructor(workspaceInstanceId: string) {
    this.workspaceInstanceId = workspaceInstanceId;
  }

  getWorkspaceId(): string {
    return this.workspaceInstanceId;
  }

  /**
   * Acquire a view lease for a resource.
   */
  acquireLease(
    fileKey: string,
    kind: ResourceLeaseKind,
    options?: { id?: string; groupId?: string },
  ): {
    lease: ResourceLease;
    release: (handlers?: ResourceCleanupHandlers) => Promise<ResourceCleanupOutcome>;
  } {
    this.leaseSequence += 1;
    const id = options?.id ?? `lease-${this.workspaceInstanceId}-${this.leaseSequence}-${Math.random().toString(36).slice(2, 7)}`;
    const lease: ResourceLease = Object.freeze({
      id,
      fileKey,
      kind,
      groupId: options?.groupId,
    });

    this.leasesById.set(id, lease);
    let keySet = this.leaseIdsByFileKey.get(fileKey);
    if (!keySet) {
      keySet = new Set<string>();
      this.leaseIdsByFileKey.set(fileKey, keySet);
    }
    keySet.add(id);

    let released = false;
    const release = async (handlers?: ResourceCleanupHandlers): Promise<ResourceCleanupOutcome> => {
      if (released) {
        const remaining = this.getLeasesForFile(fileKey);
        return {
          status: "retained",
          fileKey,
          remainingLeaseCount: remaining.length,
          activeLeases: remaining,
        };
      }
      released = true;
      return this.releaseLease(id, handlers ?? {});
    };

    return { lease, release };
  }

  /**
   * Get all active leases across all resources.
   */
  getAllLeases(): readonly ResourceLease[] {
    return Array.from(this.leasesById.values());
  }

  /**
   * Get all active leases for a specific file key.
   */
  getLeasesForFile(fileKey: string): readonly ResourceLease[] {
    const ids = this.leaseIdsByFileKey.get(fileKey);
    if (!ids || ids.size === 0) return [];
    const result: ResourceLease[] = [];
    for (const id of ids) {
      const lease = this.leasesById.get(id);
      if (lease) result.push(lease);
    }
    return Object.freeze(result);
  }

  /**
   * Check if a resource has any active view leases.
   */
  hasActiveLeases(fileKey: string): boolean {
    const ids = this.leaseIdsByFileKey.get(fileKey);
    return Boolean(ids && ids.size > 0);
  }

  /**
   * Release a lease by its ID. If this was the last lease for the resource,
   * the 4-stage cleanup pipeline is executed.
   */
  async releaseLease(leaseId: string, handlers: ResourceCleanupHandlers): Promise<ResourceCleanupOutcome> {
    const lease = this.leasesById.get(leaseId);
    if (!lease) {
      return {
        status: "retained",
        fileKey: "",
        remainingLeaseCount: 0,
        activeLeases: [],
      };
    }

    const fileKey = lease.fileKey;
    this.leasesById.delete(leaseId);

    const keySet = this.leaseIdsByFileKey.get(fileKey);
    if (keySet) {
      keySet.delete(leaseId);
      if (keySet.size === 0) {
        this.leaseIdsByFileKey.delete(fileKey);
      }
    }

    const remaining = this.getLeasesForFile(fileKey);
    if (remaining.length > 0) {
      return {
        status: "retained",
        fileKey,
        remainingLeaseCount: remaining.length,
        activeLeases: remaining,
      };
    }

    // Last view lease released -> execute 4-stage cleanup
    return this.executeResourceCleanup(fileKey, handlers);
  }

  /**
   * Synchronize active leases with live editor groups, diffs, previews, and saves.
   * Any resource no longer referenced by ANY active lease will be cleaned up.
   */
  async reconcileActiveKeys(
    liveReferencedKeys: Iterable<string>,
    handlers: ResourceCleanupHandlers,
  ): Promise<ResourceCleanupOutcome[]> {
    const liveSet = new Set(liveReferencedKeys);
    const outcomes: ResourceCleanupOutcome[] = [];

    // Find all resources currently tracked in leases that are no longer referenced
    for (const [fileKey, ids] of Array.from(this.leaseIdsByFileKey.entries())) {
      if (!liveSet.has(fileKey)) {
        for (const id of Array.from(ids)) {
          this.leasesById.delete(id);
        }
        this.leaseIdsByFileKey.delete(fileKey);
        const outcome = await this.executeResourceCleanup(fileKey, handlers);
        outcomes.push(outcome);
      }
    }

    return outcomes;
  }

  /**
   * Execute the 4-stage cleanup pipeline in strict order:
   * didClose -> watcher -> buffer -> history
   */
  async executeResourceCleanup(
    fileKey: string,
    handlers: ResourceCleanupHandlers,
  ): Promise<ResourceCleanupOutcome> {
    const previous = this.recoveryByFileKey.get(fileKey);
    const completedSet = new Set<ResourceCleanupStage>(previous?.completedStages ?? []);
    const failedStages: ResourceCleanupFailure[] = [];

    for (const stage of RESOURCE_CLEANUP_STAGES) {
      if (completedSet.has(stage)) continue;

      const handler = handlers[stage];
      if (handler) {
        try {
          await handler(fileKey);
          completedSet.add(stage);
        } catch (error) {
          const errMessage = error instanceof Error ? error.message : String(error);
          failedStages.push({
            stage,
            error: errMessage,
            timestamp: Date.now(),
          });
        }
      } else {
        // Stage has no custom handler -> treated as completed
        completedSet.add(stage);
      }
    }

    const completedStages = Object.freeze(RESOURCE_CLEANUP_STAGES.filter((s) => completedSet.has(s)));

    if (failedStages.length > 0) {
      const state: ResourceRecoveryState = Object.freeze({
        fileKey,
        completedStages,
        failedStages: Object.freeze([...failedStages]),
        lastAttemptAt: Date.now(),
      });
      this.recoveryByFileKey.set(fileKey, state);

      const stageNames = failedStages.map((f) => f.stage).join(", ");
      return {
        status: "committed-with-recovery",
        fileKey,
        completedStages,
        failedStages: Object.freeze([...failedStages]),
        message: `Resource cleanup completed with recovery required for stages: [${stageNames}] on ${fileKey}`,
      };
    }

    // All stages succeeded
    this.recoveryByFileKey.delete(fileKey);
    return {
      status: "committed",
      fileKey,
      completedStages,
    };
  }

  /**
   * Get pending recovery states.
   */
  getPendingRecovery(fileKey?: string): ResourceRecoveryState | null | readonly ResourceRecoveryState[] {
    if (fileKey !== undefined) {
      return this.recoveryByFileKey.get(fileKey) ?? null;
    }
    return Object.freeze(Array.from(this.recoveryByFileKey.values()));
  }

  /**
   * Replay cleanup for a specific failed resource idempotently.
   */
  async replayRecovery(
    fileKey: string,
    handlers: ResourceCleanupHandlers,
  ): Promise<ResourceCleanupOutcome | null> {
    const recovery = this.recoveryByFileKey.get(fileKey);
    if (!recovery) return null;
    return this.executeResourceCleanup(fileKey, handlers);
  }

  /**
   * Replay cleanup for all pending failed resources.
   */
  async replayAllPendingRecoveries(
    handlers: ResourceCleanupHandlers,
  ): Promise<readonly ResourceCleanupOutcome[]> {
    const outcomes: ResourceCleanupOutcome[] = [];
    const keys = Array.from(this.recoveryByFileKey.keys());
    for (const key of keys) {
      const outcome = await this.executeResourceCleanup(key, handlers);
      outcomes.push(outcome);
    }
    return Object.freeze(outcomes);
  }

  /**
   * Clear all leases and pending recovery entries.
   */
  dispose(): void {
    this.leasesById.clear();
    this.leaseIdsByFileKey.clear();
    this.recoveryByFileKey.clear();
  }
}
