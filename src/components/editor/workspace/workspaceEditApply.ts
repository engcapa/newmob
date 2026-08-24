import type {
  LspChangeAnnotation,
  LspFileTextEdits,
  LspWorkspaceEdit,
  LspWorkspaceEditOperation,
} from "../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "./lspTextEdits";
import type { SaveCommitResult } from "./saveCommit";
import { normalizeLineEndings } from "./saveNormalizationPipeline";
import {
  buildWorkspaceEditPreview,
  workspaceEditOperations,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

export type WorkspaceEditApplyOutcome =
  | { operationIndex: number; path: string; status: "applied-open"; dirty: boolean }
  | { operationIndex: number; path: string; status: "applied-disk"; result?: SaveCommitResult }
  | { operationIndex: number; path: string; status: "applied-create" }
  | { operationIndex: number; path: string; status: "applied-rename" }
  | { operationIndex: number; path: string; status: "applied-delete" }
  | { operationIndex: number; path: string; status: "noop" }
  | { operationIndex: number | null; path: string; status: "skipped"; reason: string }
  | { operationIndex: number | null; path: string; status: "failed"; reason: string };

export interface WorkspaceEditApplyResponse {
  applied: boolean;
  failureReason: string | null;
  failedChange: number | null;
}

/**
 * Typed result of one settled resource operation (§8.19.1). Resource hooks
 * report success/failure through the shell, so the applier assembles the
 * same fact shape the save committer produces for text writes.
 */
export type ResourceOperationResult =
  | { kind: "committed"; diskEffect: "committed"; path: string }
  | {
    kind: "conflict" | "failed";
    diskEffect: "none" | "unknown";
    path: string;
    message: string;
    recoveryId: string | null;
  };

/** Per-operation effect fact (§8.19.1 WorkspaceEditOperationEffect). */
export interface WorkspaceEditOperationEffect {
  operationId: string;
  index: number;
  kind: "text" | "create" | "rename" | "delete";
  sourcePath: string | null;
  targetPath: string;
  /**
   * Full typed result when a disk transaction ran (closed-file write or
   * open-clean save pipeline). Null means the operation changed only
   * in-memory state (open dirty buffer) — no disk/provider effect occurred.
   */
  result: SaveCommitResult | ResourceOperationResult | null;
  undoState: "available" | "unavailable";
}

/** Whole-transaction apply result (§8.19.1 WorkspaceEditApplyResultV2). */
export interface WorkspaceEditApplyResultV2 {
  transactionId: string;
  disposition: "committed" | "partial" | "blocked" | "cancelled";
  effects: readonly WorkspaceEditOperationEffect[];
  nextOperationIndex: number | null;
  resumeToken: string | null;
}

export function workspaceEditResumeToken(transactionId: string, operationIndex: number): string {
  return `${transactionId}:${operationIndex}`;
}

export function parseWorkspaceEditResumeToken(token: string): {
  transactionId: string;
  operationIndex: number;
} | null {
  const match = token.match(/^(.*):(\d+)$/);
  if (!match || !match[1]) return null;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { transactionId: match[1], operationIndex: index };
}

/**
 * Slice an edit to the operations from `startOperationIndex` onward so a
 * resume re-runs only the unapplied suffix. Fresh per-operation hash/version
 * re-validation happens naturally because every remaining text operation
 * re-reads disk or re-checks the open buffer before writing (§8.19.1).
 */
export function sliceWorkspaceEditForResume(
  edit: LspWorkspaceEdit,
  startOperationIndex: number,
): LspWorkspaceEdit {
  if (edit.operations?.length) {
    return { ...edit, operations: edit.operations.slice(startOperationIndex) };
  }
  return { ...edit, documentEdits: edit.documentEdits.slice(startOperationIndex) };
}

/**
 * Assemble the v2 whole-transaction result from ordered outcomes (§8.19.1):
 * a first blocked/failed boundary stops the run, everything before it is
 * committed or a confirmed no-op, and the resume token names the boundary.
 */
export function buildWorkspaceEditApplyResultV2(input: {
  transactionId: string;
  operations: readonly LspWorkspaceEditOperation[];
  outcomes: readonly WorkspaceEditApplyOutcome[];
  /** Shell-reported per-operation undo availability; defaults to unavailable. */
  undoAvailability?: (
    index: number,
    kind: WorkspaceEditOperationEffect["kind"],
    targetPath: string,
  ) => "available" | "unavailable";
}): WorkspaceEditApplyResultV2 {
  const { transactionId, operations, outcomes, undoAvailability } = input;

  // A null operationIndex means validation/confirmation refused before any
  // mutation: declined previews are cancelled, hard failures are blocked.
  const preMutation = outcomes.find((outcome) => outcome.operationIndex === null);
  if (preMutation) {
    return {
      transactionId,
      disposition: preMutation.status === "skipped" ? "cancelled" : "blocked",
      effects: [],
      nextOperationIndex: null,
      resumeToken: null,
    };
  }

  const effects: WorkspaceEditOperationEffect[] = [];
  let failureBoundary: number | null = null;
  for (const outcome of outcomes) {
    if (outcome.operationIndex === null) continue;
    const index = outcome.operationIndex;
    const operation = operations[index];
    const kind = operation?.kind ?? "text";
    const targetPath = operation
      ? (operation.kind === "rename"
        ? operation.newPath ?? operation.newUri
        : operation.kind === "text"
          ? operation.document.path ?? operation.document.uri
          : operation.path ?? operation.uri)
      : outcome.path;
    const sourcePath = operation?.kind === "rename"
      ? operation.oldPath ?? operation.oldUri
      : null;
    const appliedOrSettled = outcome.status.startsWith("applied") || outcome.status === "noop";
    if (!appliedOrSettled && failureBoundary === null) {
      failureBoundary = index;
    }
    let result: WorkspaceEditOperationEffect["result"];
    if (outcome.status === "applied-disk") {
      result = outcome.result ?? null;
    } else if (kind !== "text") {
      result = outcome.status.startsWith("applied")
        ? { kind: "committed", diskEffect: "committed", path: targetPath }
        : {
          kind: "failed",
          diskEffect: "none",
          path: targetPath,
          message: outcome.status === "noop" ? "no-op" : ("reason" in outcome ? outcome.reason : "operation failed"),
          recoveryId: null,
        };
    } else {
      // Open-buffer-only edits carry no disk transaction fact.
      result = null;
    }
    effects.push({
      operationId: `${transactionId}:op-${index}`,
      index,
      kind,
      sourcePath,
      targetPath,
      result,
      undoState: appliedOrSettled
        ? undoAvailability?.(index, kind, targetPath) ?? "unavailable"
        : "unavailable",
    });
  }

  if (failureBoundary === null) {
    return {
      transactionId,
      disposition: "committed",
      effects,
      nextOperationIndex: null,
      resumeToken: null,
    };
  }
  return {
    transactionId,
    disposition: "partial",
    effects,
    nextOperationIndex: failureBoundary,
    resumeToken: workspaceEditResumeToken(transactionId, failureBoundary),
  };
}

export interface WorkspaceEditApplyHooks {
  /** Resolve absolute path from a file URI / server path. */
  resolvePath: (file: LspFileTextEdits) => string | null;
  /** Return open buffer text + dirty flag, or null if not open. */
  getOpenBuffer: (absolutePath: string) => {
    text: string;
    dirty: boolean;
    key: string;
    version?: number | null;
    /** True only when the LSP server has this exact buffer text. */
    lspSynced?: boolean;
  } | null;
  /**
   * Apply text to an open buffer.
   * For dirty buffers this leaves the buffer dirty; for clean buffers the
   * applier will call `saveOpenBuffer` immediately afterwards (§5.2.9).
   */
  applyToOpenBuffer: (key: string, nextText: string) => void;
  /**
   * Persist an open clean buffer after applying edits.
   * Must write `nextText` to disk and leave the open buffer clean (dirty=false).
   */
  saveOpenBuffer: (key: string, nextText: string) => Promise<void>;
  /** Read disk contents for a closed file. */
  readDisk: (absolutePath: string) => Promise<{
    text: string;
    hash: string;
    eol?: "lf" | "crlf" | "cr";
    encoding?: string;
    bom?: boolean;
  } | null>;
  /**
   * Write disk contents for a closed file through the shared save committer
   * (§8.19.1): the hook returns the full typed effect result — including
   * unknown-effect read-back classification and recovery ledger rows — and
   * the caller must consume it instead of assuming success.
   */
  writeDisk: (
    absolutePath: string,
    text: string,
    expectedHash: string | null,
    encoding?: string,
    bom?: boolean,
    eol?: "lf" | "crlf" | "cr",
  ) => Promise<SaveCommitResult>;
  /** Apply LSP CreateFile semantics and synchronize workspace UI state. */
  createFile?: (operation: Extract<LspWorkspaceEditOperation, { kind: "create" }>) => Promise<void>;
  /** Apply LSP RenameFile semantics and synchronize workspace UI state. */
  renameFile?: (operation: Extract<LspWorkspaceEditOperation, { kind: "rename" }>) => Promise<void>;
  /** Apply LSP DeleteFile semantics and synchronize workspace UI state. */
  deleteFile?: (operation: Extract<LspWorkspaceEditOperation, { kind: "delete" }>) => Promise<void>;
  /** Confirm a multi-file/resource edit before the first mutation. */
  confirmWorkspaceEdit?: (
    preview: WorkspaceEditPreview,
    edit: LspWorkspaceEdit,
  ) => Promise<boolean | LspWorkspaceEdit>;
  /** Confirm server-declared change annotations before any mutation is applied. */
  confirmChangeAnnotations?: (annotations: LspChangeAnnotation[]) => Promise<boolean>;
  /** Final consistency barrier after dialogs and immediately before mutation. */
  preflightMutation?: () => Promise<void> | void;
  /**
   * Validate every operation path before confirmation or mutation. Semantic
   * refactors use this to enforce workspace-root ownership and reject loose
   * file fallbacks for provider-supplied edits.
   */
  validateOperationPaths?: (operations: readonly LspWorkspaceEditOperation[]) => string | null;
  /**
   * Observes the edit actually applied after preview filtering/unchecking —
   * resume slicing must use this edit, never the pre-confirmation original.
   */
  onActiveEditResolved?: (edit: LspWorkspaceEdit) => void;
}

async function applyTextDocumentEdit(
  file: LspFileTextEdits,
  operationIndex: number,
  hooks: WorkspaceEditApplyHooks,
): Promise<WorkspaceEditApplyOutcome> {
  const path = hooks.resolvePath(file);
  if (!path) {
    return { operationIndex, path: file.uri, status: "skipped", reason: "unresolvable path" };
  }
  if (!file.edits.length) return { operationIndex, path, status: "noop" };
  try {
    const open = hooks.getOpenBuffer(path);
    if (file.version != null && !open) {
      return {
        operationIndex,
        path,
        status: "failed",
        reason: `versioned document ${file.version} is not open`,
      };
    }
    if (open) {
      if (file.version != null && open.version !== file.version) {
        return {
          operationIndex,
          path,
          status: "failed",
          reason: `document version mismatch (expected ${file.version}, current ${open.version ?? "unknown"})`,
        };
      }
      if (file.version != null && open.lspSynced !== true) {
        return {
          operationIndex,
          path,
          status: "failed",
          reason: `document version ${file.version} has unsynchronized buffer changes`,
        };
      }
      const next = applyLspTextEditsToString(open.text, file.edits);
      if (!open.dirty) {
        hooks.applyToOpenBuffer(open.key, next);
        await hooks.saveOpenBuffer(open.key, next);
        return { operationIndex, path, status: "applied-open", dirty: false };
      }
      hooks.applyToOpenBuffer(open.key, next);
      return { operationIndex, path, status: "applied-open", dirty: true };
    }
    const disk = await hooks.readDisk(path);
    if (!disk) {
      return { operationIndex, path, status: "failed", reason: "file not found on disk" };
    }
    const diskEol: "lf" | "crlf" | "cr" =
      disk.eol ??
      (disk.text.includes("\r\n") ? "crlf" : disk.text.includes("\r") && !disk.text.includes("\n") ? "cr" : "lf");
    const nextRaw = applyLspTextEditsToString(disk.text, file.edits);
    const next = normalizeLineEndings(nextRaw, diskEol);
    // §8.19.1: the shared committer's typed result decides the outcome — an
    // uncertain write is never reported as applied.
    const writeResult = await hooks.writeDisk(path, next, disk.hash, disk.encoding, disk.bom, diskEol);
    if (writeResult.diskEffect === "committed") {
      return { operationIndex, path, status: "applied-disk", result: writeResult };
    }
    const failureReason = writeResult.kind === "cancelled"
      ? `closed-file write cancelled before write: ${writeResult.reason}`
      : writeResult.error.message;
    return {
      operationIndex,
      path,
      status: "failed",
      reason: writeResult.diskEffect === "unknown"
        ? `${failureReason}; result unknown — resolve the file in the recovery center before retrying`
        : failureReason,
    };
  } catch (error) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function workspaceEditAnnotationPreflight(edit: LspWorkspaceEdit): {
  confirmations: LspChangeAnnotation[];
  error: string | null;
} {
  const referencedIds = new Set<string>();
  for (const operation of workspaceEditOperations(edit)) {
    if (operation.kind === "text") {
      for (const id of operation.document.annotationIds ?? []) referencedIds.add(id);
    } else if (operation.annotationId) {
      referencedIds.add(operation.annotationId);
    }
  }
  if (referencedIds.size === 0) return { confirmations: [], error: null };

  const annotations = new Map((edit.changeAnnotations ?? []).map((annotation) => (
    [annotation.id, annotation]
  )));
  const missing = [...referencedIds].filter((id) => !annotations.has(id));
  if (missing.length > 0) {
    return {
      confirmations: [],
      error: `WorkspaceEdit references unknown change annotation: ${missing.join(", ")}`,
    };
  }
  return {
    confirmations: [...referencedIds]
      .map((id) => annotations.get(id)!)
      .filter((annotation) => annotation.needsConfirmation),
    error: null,
  };
}

/**
 * Apply a WorkspaceEdit following §5.2.9 rules:
 * - open clean → apply to buffer and save (result dirty=false)
 * - open dirty → apply to buffer, keep dirty (result dirty=true)
 * - unopened → write disk with hash precheck when provided
 * Failures do not roll back already-applied files, but stop later ordered
 * documentChanges so failedChange identifies the first unapplied boundary.
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  hooks: WorkspaceEditApplyHooks,
): Promise<WorkspaceEditApplyOutcome[]> {
  const annotationPreflight = workspaceEditAnnotationPreflight(edit);
  if (annotationPreflight.error) {
    return [{
      operationIndex: null,
      path: "WorkspaceEdit",
      status: "failed",
      reason: annotationPreflight.error,
    }];
  }
  if (hooks.validateOperationPaths) {
    try {
      const validationError = hooks.validateOperationPaths(workspaceEditOperations(edit));
      if (validationError) {
        return [{
          operationIndex: null,
          path: "WorkspaceEdit",
          status: "failed",
          reason: validationError,
        }];
      }
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  }
  let activeEdit = edit;
  const preview = buildWorkspaceEditPreview(edit);
  hooks.onActiveEditResolved?.(activeEdit);
  if (preview.requiresConfirmation && hooks.confirmWorkspaceEdit) {
    try {
      const confirmed = await hooks.confirmWorkspaceEdit(preview, edit);
      if (!confirmed) {
        return [{
          operationIndex: null,
          path: "WorkspaceEdit",
          status: "skipped",
          reason: "WorkspaceEdit preview was declined",
        }];
      }
      if (typeof confirmed === "object" && confirmed !== null) {
        activeEdit = confirmed;
      }
      hooks.onActiveEditResolved?.(activeEdit);
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  } else if (annotationPreflight.confirmations.length > 0) {
    if (!hooks.confirmChangeAnnotations) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: "WorkspaceEdit requires change confirmation, but no confirmation UI is available",
      }];
    }
    try {
      const confirmed = await hooks.confirmChangeAnnotations(annotationPreflight.confirmations);
      if (!confirmed) {
        return [{
          operationIndex: null,
          path: "WorkspaceEdit",
          status: "skipped",
          reason: "WorkspaceEdit change confirmation was declined",
        }];
      }
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  }
  if (hooks.preflightMutation) {
    try {
      await hooks.preflightMutation();
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  }
  const outcomes: WorkspaceEditApplyOutcome[] = [];
  for (const [operationIndex, operation] of workspaceEditOperations(activeEdit).entries()) {
    if (operation.kind === "text") {
      const outcome = await applyTextDocumentEdit(operation.document, operationIndex, hooks);
      outcomes.push(outcome);
      if (outcome.status === "failed" || outcome.status === "skipped") break;
      continue;
    }
    const path = operation.kind === "rename"
      ? operation.newPath ?? operation.newUri
      : operation.path ?? operation.uri;
    try {
      if (operation.kind === "create") {
        if (!hooks.createFile) throw new Error("CreateFile is not supported by this workspace");
        await hooks.createFile(operation);
        outcomes.push({ operationIndex, path, status: "applied-create" });
      } else if (operation.kind === "rename") {
        if (!hooks.renameFile) throw new Error("RenameFile is not supported by this workspace");
        await hooks.renameFile(operation);
        outcomes.push({ operationIndex, path, status: "applied-rename" });
      } else {
        if (!hooks.deleteFile) throw new Error("DeleteFile is not supported by this workspace");
        await hooks.deleteFile(operation);
        outcomes.push({ operationIndex, path, status: "applied-delete" });
      }
    } catch (error) {
      outcomes.push({
        operationIndex,
        path,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return outcomes;
}

export function workspaceEditApplyResponse(
  outcomes: WorkspaceEditApplyOutcome[],
): WorkspaceEditApplyResponse {
  const failure = outcomes.find((outcome) => (
    outcome.status === "failed" || outcome.status === "skipped"
  ));
  if (!failure) {
    return { applied: true, failureReason: null, failedChange: null };
  }
  return {
    applied: false,
    failureReason: failure.reason,
    failedChange: failure.operationIndex,
  };
}

export function summarizeWorkspaceEditOutcomes(outcomes: WorkspaceEditApplyOutcome[]): string {
  const applied = outcomes.filter((item) => item.status.startsWith("applied")).length;
  const unchanged = outcomes.filter((item) => item.status === "noop").length;
  const failed = outcomes.filter((item) => item.status === "failed").length;
  const skipped = outcomes.filter((item) => item.status === "skipped").length;
  const firstReason = outcomes.find((item) => (
    item.status === "failed" || item.status === "skipped"
  ));
  const summary = `Applied ${applied}, unchanged ${unchanged}, failed ${failed}, skipped ${skipped}`;
  return firstReason ? `${summary}: ${firstReason.reason}` : summary;
}
