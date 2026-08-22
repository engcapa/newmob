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

export type SaveCommitResult =
  | { kind: "saved-current"; transactionId: string; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; transactionId: string; file: WorkspaceFile; currentRevision: number }
  | { kind: "cancelled"; transactionId: string; phase: "prepare" | "pre-write" | "writeback"; reason: string }
  | { kind: "conflict"; transactionId: string; error: WorkspaceWriteErrorData }
  | { kind: "failed"; transactionId: string; error: WorkspaceWriteErrorData };

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
): { kind: "conflict" | "failed"; transactionId: string; error: WorkspaceWriteErrorData } {
  const parsed = parseWorkspaceWriteError(error);
  return {
    kind: parsed.kind === "hash-mismatch" ? "conflict" : "failed",
    transactionId,
    error: {
      kind: parsed.kind,
      message: parsed.message,
      ...(parsed.expectedHash !== undefined ? { expectedHash: parsed.expectedHash } : {}),
      ...(parsed.actualHash !== undefined ? { actualHash: parsed.actualHash } : {}),
    },
  };
}
