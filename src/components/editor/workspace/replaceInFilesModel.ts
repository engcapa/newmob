/**
 * ED-FIND-004: Replace in Files preview, exclude, conflict guard, and transactional commit.
 * Prohibits blind silent Replace All; requires structured WorkspaceEdit preview with
 * per-occurrence exclusion, dirty/disk hash conflict protection, and single-step undo.
 */

import type { LspTextEdit, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import {
  buildWorkspaceEditPreview,
  filterWorkspaceEditByUsages,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

export interface ReplaceInFilesMatch {
  filePath: string;
  fileUri?: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  matchedText: string;
}

export interface BuildReplaceEditParams {
  matches: readonly ReplaceInFilesMatch[];
  replacementText: string;
}

/**
 * Builds an LSP WorkspaceEdit from multi-file search matches and replacement text.
 */
export function buildReplaceInFilesWorkspaceEdit(params: BuildReplaceEditParams): LspWorkspaceEdit {
  const groupedByPath = new Map<string, { uri: string; edits: LspTextEdit[] }>();

  for (const match of params.matches) {
    const uri = match.fileUri || `file://${match.filePath.replace(/\\/g, "/")}`;
    if (!groupedByPath.has(match.filePath)) {
      groupedByPath.set(match.filePath, { uri, edits: [] });
    }

    const entry = groupedByPath.get(match.filePath)!;
    entry.edits.push({
      range: {
        start: { line: match.startLine, character: match.startCharacter },
        end: { line: match.endLine, character: match.endCharacter },
      },
      newText: params.replacementText,
    });
  }

  const documentEdits = Array.from(groupedByPath.entries()).map(([path, { uri, edits }]) => ({
    textDocument: { uri, version: null },
    edits,
  }));

  return {
    documentEdits,
  };
}

export interface FileRevisionGuard {
  path: string;
  expectedHash?: string | null;
  actualHash?: string | null;
  isDirty?: boolean;
}

export interface ConflictCheckResult {
  canCommit: boolean;
  conflicts: Array<{ path: string; reason: string }>;
}

/**
 * Validates file revisions and dirty state before executing Replace in Files transaction.
 */
export function validateReplacePreconditions(
  guards: readonly FileRevisionGuard[],
  allowDirty: boolean = false,
): ConflictCheckResult {
  const conflicts: Array<{ path: string; reason: string }> = [];

  for (const g of guards) {
    if (!allowDirty && g.isDirty) {
      conflicts.push({
        path: g.path,
        reason: "File has unsaved modifications in open buffer",
      });
    }

    if (g.expectedHash && g.actualHash && g.expectedHash !== g.actualHash) {
      conflicts.push({
        path: g.path,
        reason: `File modified on disk (hash mismatch: expected ${g.expectedHash.slice(0, 8)}, found ${g.actualHash.slice(0, 8)})`,
      });
    }
  }

  return {
    canCommit: conflicts.length === 0,
    conflicts,
  };
}

export interface ReplaceInFilesPlan {
  transactionId: string;
  originalEdit: LspWorkspaceEdit;
  filteredEdit: LspWorkspaceEdit;
  preview: WorkspaceEditPreview;
  excludedUsageIds: ReadonlySet<string>;
  totalMatches: number;
  includedMatches: number;
}

/**
 * Creates or updates a Replace in Files plan with usage exclusion.
 */
export function createReplaceInFilesPlan(
  originalEdit: LspWorkspaceEdit,
  excludedUsageIds: ReadonlySet<string> = new Set(),
): ReplaceInFilesPlan {
  const filteredEdit = filterWorkspaceEditByUsages(originalEdit, excludedUsageIds);
  const preview = buildWorkspaceEditPreview(filteredEdit, "Replace in Files");

  const totalPreview = buildWorkspaceEditPreview(originalEdit, "Replace in Files (Total)");

  return {
    transactionId: `replace-in-files-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    originalEdit,
    filteredEdit,
    preview,
    excludedUsageIds,
    totalMatches: totalPreview.textEditCount,
    includedMatches: preview.textEditCount,
  };
}
