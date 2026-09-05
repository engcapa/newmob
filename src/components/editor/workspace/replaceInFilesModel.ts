/**
 * ED-FIND-004: Replace in Files preview, exclude, conflict guard, and transactional commit.
 * Prohibits blind silent Replace All; requires structured WorkspaceEdit preview with
 * per-occurrence exclusion, dirty/disk hash conflict protection, and single-step undo.
 */

import type { LspFileTextEdits, LspTextEdit, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../lib/editor/workspaceSearch";
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

/** Absolute host path for a search match (mirrors buildReplaceEdits). */
export function replaceMatchAbsolutePath(match: WorkspaceSearchMatch): string {
  return match.path
    ? `${match.rootPath.replace(/\\/g, "/").replace(/\/+$/, "")}/${match.path.replace(/^\/+/, "")}`
    : match.rootPath;
}

/**
 * ED-FIND-004: shared search-match mapping used by the preview dialog owner
 * and the commit owner so both sides agree on file paths, ranges, and the
 * matched text the freshness recheck compares against disk.
 */
export function searchMatchesToReplaceInputs(matches: readonly WorkspaceSearchMatch[]): ReplaceInFilesMatch[] {
  return matches.map((match) => {
    const absolute = replaceMatchAbsolutePath(match);
    const line = Math.max(0, match.lineNumber - 1);
    return {
      filePath: absolute,
      fileUri: `file://${absolute}`,
      startLine: line,
      startCharacter: match.matchStart,
      endLine: line,
      endCharacter: match.matchEnd,
      matchedText: Array.from(match.lineText).slice(match.matchStart, match.matchEnd).join(""),
    };
  });
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

  // LspFileTextEdits is the app's normalized per-document shape (uri + resolved
  // path + optional version), not the wire-level VersionedTextDocumentIdentifier.
  // A null version accepts the current document version.
  const documentEdits: LspFileTextEdits[] = Array.from(groupedByPath.entries()).map(
    ([path, { uri, edits }]) => ({ uri, path, version: null, edits }),
  );

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

export interface ReplaceMatchFreshnessConflict {
  path: string;
  reason: string;
}

/**
 * ED-FIND-004 A2: pre-commit recheck that every match still sits on current
 * disk text. Catches external edits (and files deleted) between search and
 * commit without trusting the preview snapshot. Pure and unit-tested; the
 * caller supplies current disk text per affected path.
 */
export function verifyReplaceMatchFreshness(
  diskTexts: ReadonlyMap<string, string>,
  matches: readonly ReplaceInFilesMatch[],
): ReplaceMatchFreshnessConflict[] {
  const conflicts: ReplaceMatchFreshnessConflict[] = [];
  for (const match of matches) {
    const diskText = diskTexts.get(match.filePath);
    if (diskText === undefined) {
      conflicts.push({
        path: match.filePath,
        reason: "File is no longer readable on disk since search",
      });
      continue;
    }
    const lines = diskText.split("\n");
    const line = lines[match.startLine];
    if (
      line === undefined ||
      match.startLine !== match.endLine ||
      Array.from(line).slice(match.startCharacter, match.endCharacter).join("") !== match.matchedText
    ) {
      conflicts.push({
        path: match.filePath,
        reason: `Match "${match.matchedText}" changed since search (line ${match.startLine + 1})`,
      });
    }
  }
  return conflicts;
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
  const preview = buildWorkspaceEditPreview(filteredEdit, { label: "Replace in Files" });

  const totalPreview = buildWorkspaceEditPreview(originalEdit, { label: "Replace in Files (Total)" });

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
