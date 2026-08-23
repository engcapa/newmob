/**
 * P0-S3 Save Commit types and pure helpers (§8.16.1).
 *
 * A PreparedSave owns the exact text/revision/hash/policy for one save
 * transaction. Every disk-write path (open-buffer save, open-clean
 * WorkspaceEdit, closed-file WorkspaceEdit, replay) must build its policy
 * through `resolveWritePolicy` and classify its writeback through
 * `classifySaveWriteback`, so cancellation, stale snapshots and closed
 * buffers behave identically across paths.
 */

import {
  parseWorkspaceWriteError,
  type WorkspaceFile,
  type WorkspaceWriteErrorData,
} from "../../../lib/editor/workspace";
import type { OpenFileEol } from "./editorGroupTypes";

export type SaveEol = "lf" | "crlf" | "cr";

export interface SaveCommitPolicy {
  eol: SaveEol;
  encoding: string;
  bom: boolean;
}

/** Immutable snapshot of everything one save transaction commits. */
export interface PreparedSave {
  transactionId: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  text: string;
  bufferRevision: number;
  styleGeneration: number;
  expectedDiskHash: string | null;
  policy: SaveCommitPolicy;
}

/**
 * Disk/memory/provider effect axes (§8.18.1). Every settled save reports all
 * three so "bytes landed", "buffer merged" and "provider observed" are never
 * conflated: a `cancelled` result can never follow a disk write, and an
 * uncertain IPC failure reports `diskEffect: "unknown"` instead of pretending
 * zero side effects.
 */
export type DiskEffect = "none" | "committed" | "unknown";
export type MemoryEffect = "unchanged" | "saved-current" | "kept-dirty" | "writeback-discarded";
export type ProviderEffect = "not-sent" | "did-save" | "did-change-current" | "discarded" | "failed" | "unknown";

/**
 * Single host/controller-level save result (§8.18.1): six kinds only, each
 * self-describing through the three effect axes. Bytes-landed paths are
 * always one of the three `diskEffect: "committed"` kinds; plain
 * `cancelled` proves nothing reached the disk.
 */
export type SaveCommitResult =
  | { kind: "saved-current"; transactionId: string; diskEffect: "committed";
      memoryEffect: "saved-current"; providerEffect: "did-save" | "not-sent" | "failed"; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; transactionId: string; diskEffect: "committed";
      memoryEffect: "kept-dirty"; providerEffect: "did-change-current" | "not-sent" | "failed";
      file: WorkspaceFile; savedRevision: number; currentRevision: number }
  | { kind: "committed-writeback-discarded"; transactionId: string; diskEffect: "committed";
      memoryEffect: "writeback-discarded"; providerEffect: "discarded"; file: WorkspaceFile; reason: string }
  | { kind: "cancelled"; transactionId: string; diskEffect: "none";
      memoryEffect: "unchanged"; providerEffect: "not-sent"; phase: "prepare" | "pre-write"; reason: string }
  | { kind: "conflict"; transactionId: string; diskEffect: "none";
      memoryEffect: "unchanged"; providerEffect: "not-sent"; error: WorkspaceWriteErrorData }
  | { kind: "failed"; transactionId: string; diskEffect: "none" | "unknown";
      memoryEffect: "unchanged"; providerEffect: "not-sent" | "unknown";
      error: WorkspaceWriteErrorData; recoveryId?: string };

/** Prepare-phase output: either a frozen PreparedSave or a terminal failure. */
export type PrepareSaveResult =
  | { kind: "prepared"; value: PreparedSave }
  | Extract<SaveCommitResult, { kind: "cancelled" | "conflict" | "failed" }>;

/** The one writer contract: commit a frozen PreparedSave, report full facts. */
export type PreparedSaveCommitter = (prepared: PreparedSave) => Promise<SaveCommitResult>;

/**
 * Illegal-transition guard used by tests and debug assertions. Note: a
 * `diskEffect: "committed"` result is structurally incapable of being
 * `cancelled`/`conflict` in `SaveCommitResult` itself — the union encodes
 * that invariant, this guard only checks cross-result regressions.
 */
export function isLegalSaveCommitTransition(
  before: SaveCommitResult["kind"] | null,
  after: SaveCommitResult,
): boolean {
  // Once disk is committed the result can never regress to cancelled/conflict.
  if (
    (before === "saved-current" || before === "saved-stale-snapshot"
      || before === "committed-writeback-discarded")
    && (after.kind === "cancelled" || after.kind === "conflict")
  ) {
    return false;
  }
  return true;
}

let saveTransactionCounter = 0;

/** Monotonic within a session; combined with a timestamp for uniqueness. */
export function nextSaveTransactionId(prefix = "tx-save"): string {
  saveTransactionCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${saveTransactionCounter}`;
}

export function normalizeSaveEol(eol: OpenFileEol | SaveEol | undefined): SaveEol | null {
  if (!eol) return null;
  const lowered = eol.toLowerCase() as SaveEol;
  return lowered === "lf" || lowered === "crlf" || lowered === "cr" ? lowered : null;
}

export interface WritePolicyInputs {
  /** Explicit request-level policy (save dialog, applier-provided values). */
  explicit?: { eol?: OpenFileEol | SaveEol; encoding?: string; bom?: boolean };
  /** Replay metadata recorded for this absolute path (WorkspaceEdit undo). */
  replay?: { eol?: OpenFileEol | SaveEol; encoding?: string; bom?: boolean } | null;
  /** Open-buffer file metadata fallback. */
  file?: { eol?: OpenFileEol; encoding?: string; bom?: boolean } | null;
}

/**
 * Single policy resolution point. Precedence: explicit > replay > file
 * metadata > defaults. Every field is always present after resolution so no
 * writer path re-reads stale metadata past the prepare boundary.
 */
export function resolveWritePolicy(inputs: WritePolicyInputs): SaveCommitPolicy {
  const eol =
    normalizeSaveEol(inputs.explicit?.eol) ??
    normalizeSaveEol(inputs.replay?.eol) ??
    normalizeSaveEol(inputs.file?.eol) ??
    "lf";
  const encoding =
    inputs.explicit?.encoding ??
    inputs.replay?.encoding ??
    inputs.file?.encoding ??
    "UTF-8";
  const bomExplicit = inputs.explicit?.bom;
  const bom = bomExplicit !== undefined
    ? bomExplicit
    : (inputs.replay?.bom ?? inputs.file?.bom ?? false);
  return { eol, encoding, bom };
}

export interface PreparedSaveBoundary {
  filePath: string;
  documentRevision: number;
  styleGeneration: number;
}

/**
 * Synchronous pre-write boundary check. Returns a cancellation reason or
 * null when the prepared save may proceed to the byte writer. Callers must
 * invoke the writer in the same synchronous turn after this returns null.
 */
export function validatePreparedSaveBoundary(
  prepared: PreparedSave,
  live: PreparedSaveBoundary | null,
): string | null {
  if (!live) return "Open buffer was closed before write";
  if (live.filePath !== prepared.filePath) return "File path changed during save preparation";
  if (live.documentRevision !== prepared.bufferRevision) {
    return `Buffer revision changed (${prepared.bufferRevision} -> ${live.documentRevision}) during save preparation`;
  }
  if (live.styleGeneration !== prepared.styleGeneration) {
    return `Style generation changed (${prepared.styleGeneration} -> ${live.styleGeneration}) during save preparation`;
  }
  return null;
}

export type SaveWritebackClassification =
  | { kind: "saved-current" }
  | { kind: "saved-stale-snapshot"; currentRevision: number }
  | { kind: "discarded"; reason: string };

/**
 * Writeback classification. The disk write already happened by the time this
 * runs; it decides only what merges back into the buffer and whether the
 * provider may observe a `didSave`. A closed buffer discards everything.
 */
export function classifySaveWriteback(
  prepared: PreparedSave,
  live: { documentRevision: number } | null,
): SaveWritebackClassification {
  if (!live) {
    return { kind: "discarded", reason: "Open buffer closed while writer was in flight" };
  }
  if (live.documentRevision === prepared.bufferRevision) {
    return { kind: "saved-current" };
  }
  return {
    kind: "saved-stale-snapshot",
    currentRevision: live.documentRevision,
  };
}

/** Maps a thrown IPC/write error into the typed conflict/failed result. */
export function saveCommitResultFromError(
  transactionId: string,
  error: unknown,
): { kind: "conflict" | "failed"; transactionId: string; diskEffect: DiskEffect | undefined;
    memoryEffect: "unchanged"; providerEffect: ProviderEffect | undefined;
    error: WorkspaceWriteErrorData } {
  const parsed = parseWorkspaceWriteError(error);
  return {
    kind: parsed.kind === "hash-mismatch" ? "conflict" : "failed",
    transactionId,
    diskEffect: parsed.effect,
    memoryEffect: "unchanged",
    providerEffect: parsed.effect === "unknown" ? "unknown" : "not-sent",
    error: {
      kind: parsed.kind,
      message: parsed.message,
      ...(parsed.expectedHash !== undefined ? { expectedHash: parsed.expectedHash } : {}),
      ...(parsed.actualHash !== undefined ? { actualHash: parsed.actualHash } : {}),
      ...(parsed.effect !== undefined ? { effect: parsed.effect } : {}),
      ...(parsed.writtenHash !== undefined ? { writtenHash: parsed.writtenHash } : {}),
      ...(parsed.writtenByteLength !== undefined ? { writtenByteLength: parsed.writtenByteLength } : {}),
    },
  };
}

/**
 * Classification of an unknown-effect IPC failure after the frontend re-read
 * the file (§8.18.1 native contract): equal to the written hash proves the
 * intended bytes landed; equal to the old hash proves nothing was written;
 * anything else is an unresolved foreign state that must create a recovery
 * ledger entry and never auto-retry.
 */
export type UnknownDiskEffectVerification =
  | { outcome: "committed" }
  | { outcome: "none" }
  | { outcome: "foreign"; observedHash: string };

export function classifyUnknownDiskEffect(input: {
  writtenHash: string | null | undefined;
  expectedOldHash: string | null;
  observedHash: string | null;
}): UnknownDiskEffectVerification {
  const observed = input.observedHash?.toLowerCase() ?? null;
  const written = input.writtenHash?.toLowerCase() ?? null;
  const old = input.expectedOldHash?.toLowerCase() ?? null;
  if (observed && written && observed === written) return { outcome: "committed" };
  if (observed && old && observed === old) return { outcome: "none" };
  return { outcome: "foreign", observedHash: input.observedHash ?? "" };
}

/**
 * Single construction point for every save path (§8.17.1 step 1). Callers
 * resolve their policy inputs through `resolveWritePolicy`; this helper only
 * assembles the immutable record so all paths share one identity shape.
 */
export function buildPreparedSave(input: {
  transactionId: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  text: string;
  bufferRevision: number;
  styleGeneration: number;
  expectedDiskHash: string | null;
  policy: SaveCommitPolicy;
}): PreparedSave {
  return { ...input, policy: { ...input.policy } };
}

/** Owner identity captured when a transaction registers (§8.17.1 step 4). */
export interface SaveTransactionOwner {
  workspaceId: string;
  transactionId: string;
  /** Buffer key owning the writeback, or a synthetic `closed:<path>` owner for disk-only writes. */
  fileKey: string;
  /** Epoch snapshot at registration time. */
  ownerEpoch: number;
}

export type SaveOwnerCheck =
  | { active: true }
  | { active: false; reason: string };

function ownerEpochKey(workspaceId: string, fileKey: string): string {
  return `${workspaceId}\u0000${fileKey}`;
}

function liveEntryKey(workspaceId: string, transactionId: string): string {
  return `${workspaceId}\u0000${transactionId}`;
}

/**
 * Tracks in-flight save transactions per `(workspaceId, transactionId)` with
 * an owner generation per `(workspaceId, fileKey)`. Closing a tab, renaming a
 * file or unmounting the workspace bumps the epoch so an in-flight writer's
 * writeback, watcher notify and LSP `didSave`/`didChange` are discarded as
 * `cancelled/writeback-discarded` instead of resurrecting buffer state.
 */
export class SaveTransactionRegistry {
  private readonly epochs = new Map<string, number>();
  private readonly discardReasons = new Map<string, string>();
  private readonly live = new Map<string, SaveTransactionOwner>();

  begin(workspaceId: string, fileKey: string, transactionId: string): SaveTransactionOwner {
    const epochKey = ownerEpochKey(workspaceId, fileKey);
    const ownerEpoch = this.epochs.get(epochKey) ?? 0;
    const owner: SaveTransactionOwner = { workspaceId, transactionId, fileKey, ownerEpoch };
    this.live.set(liveEntryKey(workspaceId, transactionId), owner);
    return owner;
  }

  /**
   * Bump the owner epoch for one buffer (close tab / rename). Every
   * transaction registered before this call becomes discarded.
   */
  discardFile(workspaceId: string, fileKey: string, reason = `Buffer ${fileKey} was closed or renamed`): void {
    const epochKey = ownerEpochKey(workspaceId, fileKey);
    const next = (this.epochs.get(epochKey) ?? 0) + 1;
    this.epochs.set(epochKey, next);
    this.discardReasons.set(epochKey, reason);
    // Live entries are intentionally kept: a late `check` must observe the
    // typed discard reason via the epoch mismatch, not a generic settle.
  }

  /** Drop every live transaction of a workspace (unmount / instance dispose). */
  discardWorkspace(workspaceId: string): void {
    for (const [key, owner] of [...this.live.entries()]) {
      if (owner.workspaceId === workspaceId) this.live.delete(key);
    }
  }

  check(owner: SaveTransactionOwner): SaveOwnerCheck {
    if (!this.live.has(liveEntryKey(owner.workspaceId, owner.transactionId))) {
      return { active: false, reason: "Save transaction already settled" };
    }
    const epochKey = ownerEpochKey(owner.workspaceId, owner.fileKey);
    const current = this.epochs.get(epochKey) ?? 0;
    if (current !== owner.ownerEpoch) {
      return {
        active: false,
        reason: this.discardReasons.get(epochKey) ?? "Save transaction owner changed",
      };
    }
    return { active: true };
  }

  /** Settle (forget) a finished transaction so late checks cannot pass. */
  settle(owner: SaveTransactionOwner): void {
    this.live.delete(liveEntryKey(owner.workspaceId, owner.transactionId));
  }

  /** Test/diagnostic view of live transactions for a workspace. */
  listActive(workspaceId: string): SaveTransactionOwner[] {
    return [...this.live.values()].filter((owner) => owner.workspaceId === workspaceId);
  }
}
