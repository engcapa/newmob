import type {
  FinalBytesReceipt,
  SaveCommitPolicy,
  SaveCommitResult,
  SaveEol,
} from "./saveCommit";
import { encodeSaveBytes } from "./saveCommit";
import { sha256Hex, sha256HexBytes } from "./projectAnalysisModel";

export type SaveObservationState =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "stale"
  | "conflict"
  | "error"
  | "recovery";

export interface SaveEncodingMatrixEntry {
  encoding: string;
  bom: boolean;
  eol: SaveEol;
  rawText: string;
  expectedByteLength: number;
  expectedBytesSha256: string;
  expectedTextSha256: string;
}

export interface SaveObservationReceiptReconciliation {
  matched: boolean;
  receiptId: string;
  filePath: string;
  finalTextMatchesDisk: boolean;
  byteLengthMatches: boolean;
  hashMatches: boolean;
  observedBytesSha256: string | null;
  mismatches: string[];
}

export interface SaveObservationRecord {
  fileKey: string;
  filePath: string;
  uri: string;
  state: SaveObservationState;
  transactionId: string;
  resultKind: SaveCommitResult["kind"];
  diskEffect: SaveCommitResult["diskEffect"];
  memoryEffect: SaveCommitResult["memoryEffect"];
  providerEffect: SaveCommitResult["providerEffect"];
  bufferRevision: number;
  isDirty: boolean;
  latestReceipt: FinalBytesReceipt | null;
  recoverySnapshotId?: string;
  undoHash?: string;
  lastVerifiedAt: number;
}

export interface PlatformNativeSaveProof {
  platform: "linux" | "macos" | "windows" | "browser-vfs-unsupported";
  isNativeFs: boolean;
  workspacePath: string;
  verifiedFiles: string[];
  blockedReason?: string;
}

export interface SaveObservationRecordInput {
  result: SaveCommitResult;
  fileKey: string;
  filePath: string;
  uri: string;
  bufferRevision: number;
  isDirty: boolean;
  observedAt?: number;
}

function stateForSaveResult(
  result: SaveCommitResult,
  isDirty: boolean,
): SaveObservationState {
  if (result.kind === "saved-current") return isDirty ? "dirty" : "saved";
  if (result.kind === "saved-stale-snapshot") return "stale";
  if (result.kind === "committed-writeback-discarded") return "recovery";
  if (result.kind === "conflict") return "conflict";
  if (result.kind === "failed") {
    return result.diskEffect === "unknown" ? "recovery" : "error";
  }
  return isDirty ? "dirty" : "clean";
}

/**
 * Projects a settled production result into metadata safe for UI/runner
 * observation. The projection deliberately carries hashes and identities but
 * never the buffer or disk source text.
 */
export function createSaveObservationRecord(
  input: SaveObservationRecordInput,
): SaveObservationRecord {
  const receipt = input.result.diskEffect === "committed"
    ? {
        ...input.result.receipt,
        policy: { ...input.result.receipt.policy },
      }
    : null;
  const recoverySnapshotId = "recoveryId" in input.result
    ? input.result.recoveryId
    : undefined;

  return {
    fileKey: input.fileKey,
    filePath: receipt?.filePath ?? input.filePath,
    uri: input.uri,
    state: stateForSaveResult(input.result, input.isDirty),
    transactionId: input.result.transactionId,
    resultKind: input.result.kind,
    diskEffect: input.result.diskEffect,
    memoryEffect: input.result.memoryEffect,
    providerEffect: input.result.providerEffect,
    bufferRevision: input.bufferRevision,
    isDirty: input.isDirty,
    latestReceipt: receipt,
    ...(recoverySnapshotId ? { recoverySnapshotId } : {}),
    ...(receipt?.diskPreSha256 ? { undoHash: receipt.diskPreSha256 } : {}),
    lastVerifiedAt: input.observedAt ?? Date.now(),
  };
}

/**
 * Reconciles a live buffer state and its disk content against the writer's FinalBytesReceipt (§ED-SAVE-004).
 */
export function reconcileSaveObservationReceipt(
  receipt: FinalBytesReceipt,
  observedDiskText: string,
  observedDiskBytes?: Uint8Array,
): SaveObservationReceiptReconciliation {
  const mismatches: string[] = [];
  const textSha = sha256Hex(observedDiskText);
  const finalTextMatchesDisk = textSha === receipt.finalTextSha256;
  if (!finalTextMatchesDisk) {
    mismatches.push(`Final text SHA mismatch: expected ${receipt.finalTextSha256}, got ${textSha}`);
  }

  let byteLengthMatches = true;
  let hashMatches = true;
  let observedBytesSha256: string | null = null;

  if (observedDiskBytes) {
    observedBytesSha256 = sha256HexBytes(observedDiskBytes);
    if (observedDiskBytes.length !== receipt.encodedByteLength) {
      byteLengthMatches = false;
      mismatches.push(`Byte length mismatch: expected ${receipt.encodedByteLength}, got ${observedDiskBytes.length}`);
    }
    if (observedBytesSha256 !== receipt.encodedBytesSha256) {
      hashMatches = false;
      mismatches.push(`Encoded bytes SHA mismatch: expected ${receipt.encodedBytesSha256}, got ${observedBytesSha256}`);
    }
    if (observedBytesSha256 !== receipt.diskPostSha256) {
      hashMatches = false;
      mismatches.push(`Disk post SHA mismatch: expected ${receipt.diskPostSha256}, got ${observedBytesSha256}`);
    }
  }

  return {
    matched: mismatches.length === 0,
    receiptId: receipt.receiptId,
    filePath: receipt.filePath,
    finalTextMatchesDisk,
    byteLengthMatches,
    hashMatches,
    observedBytesSha256,
    mismatches,
  };
}

/**
 * Generates matrix test vector for all supported encodings & line endings (§ED-SAVE-004).
 */
export function generateSaveEncodingMatrix(): SaveEncodingMatrixEntry[] {
  const encodings: Array<{ encoding: string; bom: boolean; sample: string }> = [
    { encoding: "UTF-8", bom: false, sample: "hello world\n" },
    { encoding: "UTF-8", bom: true, sample: "hello world with bom\n" },
    { encoding: "ISO-8859-1", bom: false, sample: "café au lait\n" },
    { encoding: "US-ASCII", bom: false, sample: "ascii only text\n" },
    { encoding: "UTF-16LE", bom: false, sample: "utf-16le text\n" },
    { encoding: "UTF-16BE", bom: false, sample: "utf-16be text\n" },
  ];
  const eols: SaveEol[] = ["lf", "crlf"];

  const matrix: SaveEncodingMatrixEntry[] = [];
  for (const enc of encodings) {
    for (const eol of eols) {
      const eolChar = eol === "crlf" ? "\r\n" : "\n";
      const normalizedText = enc.sample.replace(/\r?\n/g, eolChar);
      const policy: SaveCommitPolicy = { encoding: enc.encoding, bom: enc.bom, eol };
      const encoded = encodeSaveBytes(normalizedText, policy);
      matrix.push({
        encoding: enc.encoding,
        bom: enc.bom,
        eol,
        rawText: normalizedText,
        expectedByteLength: encoded.byteLength,
        expectedBytesSha256: encoded.bytesSha256,
        expectedTextSha256: encoded.textSha256,
      });
    }
  }
  return matrix;
}

/**
 * Validates platform observation contract ensuring browser VFS is never passed as native proof (§ED-SAVE-004).
 */
export function validatePlatformNativeSaveProof(
  proof: PlatformNativeSaveProof,
): { valid: boolean; status: "verified" | "blocked"; reason?: string } {
  if (proof.platform === "browser-vfs-unsupported" || !proof.isNativeFs) {
    return {
      valid: false,
      status: "blocked",
      reason: proof.blockedReason ?? "Browser VFS stubs cannot prove real host disk effects; native gate remains blocked.",
    };
  }
  if (proof.verifiedFiles.length === 0) {
    return {
      valid: false,
      status: "blocked",
      reason: "No verified native files recorded in platform proof.",
    };
  }
  return {
    valid: true,
    status: "verified",
  };
}
