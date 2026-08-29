import { sha256Hex } from "./projectAnalysisModel";

/**
 * §ED-QA-001: Workspace Observation Bridge.
 * Dev/test-only read-only telemetry collector for Editor effects.
 * Exposes strictly revisions, request/cancel counts, write counts, lease counts,
 * history counts, and redacted SHA256 hashes.
 * Strictly blocks execution of actions, state injections, and raw sensitive text.
 */

export interface WorkspaceObservationSnapshot {
  readonly workspaceId: string;
  readonly isProduction: boolean;
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

  constructor(workspaceId: string, isProduction = false) {
    this.workspaceId = workspaceId;
    this.isProduction = isProduction;
  }

  getSnapshot(): WorkspaceObservationSnapshot {
    if (this.isProduction) {
      return {
        workspaceId: this.workspaceId,
        isProduction: true,
        documentRevisions: Object.freeze({}),
        providerRequestCounts: Object.freeze({}),
        providerCancelCounts: Object.freeze({}),
        diskWriteCount: 0,
        diskWriteSha256List: Object.freeze([]),
        resourceLeaseCount: 0,
        historyReceiptCount: 0,
        clipboardSessionRevision: 0,
        clipboardConsumerCount: 0,
        observedAt: Date.now(),
      };
    }

    return {
      workspaceId: this.workspaceId,
      isProduction: false,
      documentRevisions: Object.freeze(Object.fromEntries(this.documentRevisions)),
      providerRequestCounts: Object.freeze(Object.fromEntries(this.providerRequestCounts)),
      providerCancelCounts: Object.freeze(Object.fromEntries(this.providerCancelCounts)),
      diskWriteCount: this.diskWriteSha256List.length,
      diskWriteSha256List: Object.freeze([...this.diskWriteSha256List]),
      resourceLeaseCount: this.resourceLeaseCount,
      historyReceiptCount: this.historyReceiptCount,
      clipboardSessionRevision: this.clipboardSessionRevision,
      clipboardConsumerCount: this.clipboardConsumerCount,
      observedAt: Date.now(),
    };
  }

  recordDocumentRevision(fileKey: string, revision: number): void {
    if (this.isProduction) return;
    this.documentRevisions.set(fileKey, revision);
  }

  recordProviderRequest(queryKind: string): void {
    if (this.isProduction) return;
    const prev = this.providerRequestCounts.get(queryKind) ?? 0;
    this.providerRequestCounts.set(queryKind, prev + 1);
  }

  recordProviderCancel(queryKind: string): void {
    if (this.isProduction) return;
    const prev = this.providerCancelCounts.get(queryKind) ?? 0;
    this.providerCancelCounts.set(queryKind, prev + 1);
  }

  /**
   * Records a disk write event using ONLY the SHA256 digest of the payload
   * (plain text/buffer is never retained).
   */
  recordDiskWrite(rawContentOrSha: string): void {
    if (this.isProduction) return;
    // If it is already a 64-char hex sha, record directly; otherwise hash it
    const sha = /^[a-f0-9]{64}$/i.test(rawContentOrSha)
      ? rawContentOrSha
      : sha256Hex(rawContentOrSha);
    this.diskWriteSha256List.push(sha);
  }

  recordLeaseAcquired(): void {
    if (this.isProduction) return;
    this.resourceLeaseCount += 1;
  }

  recordLeaseReleased(): void {
    if (this.isProduction) return;
    this.resourceLeaseCount = Math.max(0, this.resourceLeaseCount - 1);
  }

  recordHistoryReceipt(): void {
    if (this.isProduction) return;
    this.historyReceiptCount += 1;
  }

  recordClipboardSession(revision: number, consumerCount: number): void {
    if (this.isProduction) return;
    this.clipboardSessionRevision = revision;
    this.clipboardConsumerCount = consumerCount;
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
  }
}
