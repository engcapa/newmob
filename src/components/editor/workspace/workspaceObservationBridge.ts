import type { SaveCommitResult } from "./saveCommit";

/**
 * §ED-QA-001: Workspace Observation Bridge.
 * Dev/test-only read-only telemetry collector for Editor effects.
 * Exposes strictly revisions, request/cancel counts, write counts, lease counts,
 * history counts, and redacted SHA256 hashes.
 * Strictly blocks execution of actions, state injections, and raw sensitive text.
 */

export interface WorkspaceObservationSnapshot {
  readonly schemaVersion: "workspace-observation/v1";
  readonly source: "workspace-production-owners";
  readonly workspaceId: string;
  readonly isProduction: boolean;
  /** Missing/stale/disabled observations are not valid evidence. */
  readonly observationStatus: WorkspaceObservationStatus;
  /** Alias kept explicit for consumers that use a generic status field. */
  readonly status: WorkspaceObservationStatus;
  readonly isFresh: boolean;
  readonly observationRevision: number;
  readonly documentRevisions: Readonly<Record<string, number>>;
  readonly providerRequestCounts: Readonly<Record<string, number>>;
  readonly providerCancelCounts: Readonly<Record<string, number>>;
  readonly diskWriteCount: number;
  readonly diskWriteSha256List: readonly string[];
  readonly resourceLeaseCount: number;
  readonly historyReceiptCount: number;
  readonly clipboardSessionRevision: number;
  readonly clipboardConsumerCount: number;
  readonly observedAt: number;
}

export type WorkspaceObservationStatus = "missing" | "ready" | "stale" | "disabled";

export interface WorkspaceObservationReadOptions {
  /** Maximum age of the last owner event before the snapshot fails closed. */
  maxAgeMs?: number;
  /** Deterministic clock override for tests and runner validation. */
  now?: number;
}

export const DEFAULT_WORKSPACE_OBSERVATION_MAX_AGE_MS = 10_000;

export interface WorkspaceSaveObservationInput {
  result: WorkspaceSaveObservationResult;
  fileKey: string;
  bufferRevision: number;
}

/** Only settled save metadata may cross into the observation adapter. */
export interface WorkspaceSaveObservationResult {
  readonly transactionId: string;
  readonly diskEffect: SaveCommitResult["diskEffect"];
  readonly receipt?: {
    readonly transactionId: string;
    readonly encodedBytesSha256: string;
    readonly historyId?: string;
  };
}

function validRevision(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalizedLabel(value: string): string | null {
  const label = value.trim();
  return label.length > 0 && label.length <= 160 ? label : null;
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export class WorkspaceObservationBridge {
  private readonly workspaceId: string;
  private readonly isProduction: boolean;

  private documentRevisions = new Map<string, number>();
  private providerRequestCounts = new Map<string, number>();
  private providerCancelCounts = new Map<string, number>();
  private diskWriteSha256List: string[] = [];
  private resourceLeaseCount = 0;
  private historyReceiptCount = 0;
  private clipboardSessionRevision = 0;
  private clipboardConsumerCount = 0;
  private observationRevision = 0;
  private lastObservedAt = 0;
  private readonly listeners = new Set<(snapshot: WorkspaceObservationSnapshot) => void>();
  private readonly observedTransactionIds = new Set<string>();
  private readonly observedHistoryIds = new Set<string>();

  constructor(workspaceId: string, isProduction = false) {
    this.workspaceId = workspaceId;
    this.isProduction = isProduction;
  }

  getSnapshot(options: WorkspaceObservationReadOptions = {}): WorkspaceObservationSnapshot {
    const now = options.now ?? Date.now();
    const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_WORKSPACE_OBSERVATION_MAX_AGE_MS);
    const status: WorkspaceObservationStatus = this.isProduction
      ? "disabled"
      : this.observationRevision === 0
        ? "missing"
        : now - this.lastObservedAt > maxAgeMs
          ? "stale"
          : "ready";
    const available = status === "ready";

    return Object.freeze({
      schemaVersion: "workspace-observation/v1" as const,
      source: "workspace-production-owners" as const,
      workspaceId: this.workspaceId,
      isProduction: this.isProduction,
      observationStatus: status,
      status,
      isFresh: available,
      observationRevision: this.observationRevision,
      // A stale or missing source must not be mistaken for a valid zero.
      documentRevisions: Object.freeze(available ? Object.fromEntries(this.documentRevisions) : {}),
      providerRequestCounts: Object.freeze(available ? Object.fromEntries(this.providerRequestCounts) : {}),
      providerCancelCounts: Object.freeze(available ? Object.fromEntries(this.providerCancelCounts) : {}),
      diskWriteCount: available ? this.diskWriteSha256List.length : 0,
      diskWriteSha256List: Object.freeze(available ? [...this.diskWriteSha256List] : []),
      resourceLeaseCount: available ? this.resourceLeaseCount : 0,
      historyReceiptCount: available ? this.historyReceiptCount : 0,
      clipboardSessionRevision: available ? this.clipboardSessionRevision : 0,
      clipboardConsumerCount: available ? this.clipboardConsumerCount : 0,
      observedAt: this.lastObservedAt,
    });
  }

  subscribe(listener: (snapshot: WorkspaceObservationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observeDocumentRevision(fileKey: string, revision: number): void {
    const key = normalizedLabel(fileKey);
    if (!key || !validRevision(revision)) return;
    this.commitObservation(() => {
      const previous = this.documentRevisions.get(key) ?? 0;
      this.documentRevisions.set(key, Math.max(previous, Math.floor(revision)));
    });
  }

  observeProviderRequest(queryKind: string): void {
    this.incrementLabelCount(this.providerRequestCounts, queryKind);
  }

  observeProviderCancel(queryKind: string): void {
    this.incrementLabelCount(this.providerCancelCounts, queryKind);
  }

  observeDiskWriteHash(diskPostSha256: string): void {
    if (!validSha256(diskPostSha256)) return;
    this.commitObservation(() => {
      this.diskWriteSha256List.push(diskPostSha256.toLowerCase());
    });
  }

  observeLeaseDelta(delta: number): void {
    if (!Number.isInteger(delta) || delta === 0) return;
    this.commitObservation(() => {
      this.resourceLeaseCount = Math.max(0, this.resourceLeaseCount + delta);
    });
  }

  observeLeaseAcquired(): void {
    this.observeLeaseDelta(1);
  }

  observeLeaseReleased(): void {
    this.observeLeaseDelta(-1);
  }

  observeHistoryReceipt(receiptId?: string): void {
    const normalizedReceiptId = receiptId ? normalizedLabel(receiptId) : null;
    this.commitObservation(() => {
      if (normalizedReceiptId && this.observedHistoryIds.has(normalizedReceiptId)) return;
      if (normalizedReceiptId) this.observedHistoryIds.add(normalizedReceiptId);
      this.historyReceiptCount += 1;
    });
  }

  observeClipboardSession(revision: number, consumerCount: number): void {
    if (!validRevision(revision) || !validRevision(consumerCount)) return;
    this.commitObservation(() => {
      this.clipboardSessionRevision = Math.floor(revision);
      this.clipboardConsumerCount = Math.floor(consumerCount);
    });
  }

  /**
   * Feed one settled save result from the production save owner. Only the
   * final receipt hash and history identity cross the observation boundary;
   * buffer and disk source text never do.
   */
  observeSaveResult(input: WorkspaceSaveObservationInput): void {
    const fileKey = normalizedLabel(input.fileKey);
    if (!fileKey || !validRevision(input.bufferRevision)) return;
    if (this.isProduction) return;
    const transactionId = normalizedLabel(input.result.transactionId);
    if (!transactionId || this.observedTransactionIds.has(transactionId)) return;
    this.observedTransactionIds.add(transactionId);
    this.commitObservation(() => {
      const previous = this.documentRevisions.get(fileKey) ?? 0;
      this.documentRevisions.set(fileKey, Math.max(previous, Math.floor(input.bufferRevision)));
      const receipt = input.result.receipt;
      if (
        input.result.diskEffect !== "committed"
        || !receipt
        || normalizedLabel(receipt.transactionId) !== transactionId
      ) return;
      if (validSha256(receipt.encodedBytesSha256)) {
        this.diskWriteSha256List.push(receipt.encodedBytesSha256.toLowerCase());
      }
      const historyId = receipt.historyId ? normalizedLabel(receipt.historyId) : null;
      if (historyId && !this.observedHistoryIds.has(historyId)) {
        this.observedHistoryIds.add(historyId);
        this.historyReceiptCount += 1;
      }
    });
  }

  reset(): void {
    if (this.isProduction) return;
    this.documentRevisions.clear();
    this.providerRequestCounts.clear();
    this.providerCancelCounts.clear();
    this.diskWriteSha256List = [];
    this.resourceLeaseCount = 0;
    this.historyReceiptCount = 0;
    this.clipboardSessionRevision = 0;
    this.clipboardConsumerCount = 0;
    this.observationRevision = 0;
    this.lastObservedAt = 0;
    this.observedTransactionIds.clear();
    this.observedHistoryIds.clear();
    this.notifyListeners();
  }

  private incrementLabelCount(target: Map<string, number>, rawLabel: string): void {
    const label = normalizedLabel(rawLabel);
    if (!label) return;
    this.commitObservation(() => {
      target.set(label, (target.get(label) ?? 0) + 1);
    });
  }

  private commitObservation(update: () => void): void {
    if (this.isProduction) return;
    update();
    this.observationRevision += 1;
    this.lastObservedAt = Date.now();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observation subscribers cannot affect the production owner.
      }
    }
  }
}
