import type {
  LspChangeAnnotation,
  LspFileTextEdits,
  LspWorkspaceEdit,
  LspWorkspaceEditOperation,
} from "../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "./lspTextEdits";
import {
  buildWorkspaceEditPreview,
  workspaceEditOperations,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

export type WorkspaceEditApplyOutcome =
  | { operationIndex: number; path: string; status: "applied-open"; dirty: boolean }
  | { operationIndex: number; path: string; status: "applied-disk" }
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
    encoding?: string;
    bom?: boolean;
  } | null>;
  /** Write disk contents for a closed file (with hash precheck when available). */
  writeDisk: (
    absolutePath: string,
    text: string,
    expectedHash: string | null,
    encoding?: string,
    bom?: boolean,
  ) => Promise<void>;
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
    const next = applyLspTextEditsToString(disk.text, file.edits);
    if (disk.encoding !== undefined || disk.bom !== undefined) {
      await hooks.writeDisk(path, next, disk.hash, disk.encoding, disk.bom);
    } else {
      // Preserve the compact legacy hook call for integrations that have not
      // opted into charset metadata yet.
      await hooks.writeDisk(path, next, disk.hash);
    }
    return { operationIndex, path, status: "applied-disk" };
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
