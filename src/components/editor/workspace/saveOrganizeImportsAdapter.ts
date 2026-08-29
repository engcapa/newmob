import type { LspTextEdit } from "../../../lib/editor/lsp";
import { offsetFromLspPositionInString, applyLspTextEditsToString } from "./lspTextEdits";
import {
  type ImmutableCodeActionPlan,
  extractAffectedUrisFromWorkspaceEdit,
} from "./codeActionProviderAdapter";

export interface SaveOrganizeImportsValidationResult {
  valid: boolean;
  status: "applied" | "unavailable" | "failed";
  reason?: string;
  plan?: ImmutableCodeActionPlan | null;
  transformedText: string | null;
}

/**
 * Validates and applies organize imports plan in plan-only mode (§ED-SAVE-002).
 * Verifies:
 * - Pure WorkspaceEdit (rejects command-only as unavailable)
 * - URI matching (rejects multi-file edits touching other files as unavailable)
 * - Non-negative, non-inverted ranges
 * - Non-overlapping edit spans
 * Returns pure in-memory transformed text with zero live buffer side effects.
 */
export function validateAndApplyOrganizeImportsPlan(
  text: string,
  targetUri: string,
  plan: ImmutableCodeActionPlan | null,
): SaveOrganizeImportsValidationResult {
  if (!plan) {
    return { valid: false, status: "unavailable", reason: "no-plan", plan: null, transformedText: null };
  }

  // 1. Check for edit vs command-only
  const hasDocEdits = Boolean(plan.edit?.documentEdits && plan.edit.documentEdits.length > 0);
  const hasOperations = Boolean(plan.edit?.operations && plan.edit.operations.length > 0);

  if (!plan.edit || (!hasDocEdits && !hasOperations)) {
    if (plan.command) {
      return {
        valid: false,
        status: "unavailable",
        reason: "command-only-not-supported-in-save-normalization",
        plan,
        transformedText: null,
      };
    }
    return { valid: false, status: "unavailable", reason: "empty-edit", plan, transformedText: null };
  }

  // 2. Validate URI matching & single vs multi-file
  const affectedUris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
  const normalizedTarget = targetUri.replace(/\\/g, "/");
  const isMatch = (uri: string | null | undefined) => {
    if (!uri) return false;
    const norm = uri.replace(/\\/g, "/");
    return norm === normalizedTarget || norm.endsWith(normalizedTarget) || normalizedTarget.endsWith(norm);
  };

  const foreignUris = affectedUris.filter((u) => !isMatch(u));
  if (foreignUris.length > 0) {
    return {
      valid: false,
      status: "unavailable",
      reason: `multi-file-edit-unsupported-in-single-file-save: foreign uri ${foreignUris.join(", ")}`,
      plan,
      transformedText: null,
    };
  }

  // Extract edits for target file
  const edits: LspTextEdit[] = [];
  if (plan.edit.documentEdits) {
    for (const doc of plan.edit.documentEdits) {
      if (isMatch(doc.uri) || isMatch(doc.path)) {
        edits.push(...doc.edits);
      }
    }
  }
  if (plan.edit.operations) {
    for (const op of plan.edit.operations) {
      if (op.kind === "text" && (isMatch(op.document.uri) || isMatch(op.document.path))) {
        edits.push(...op.document.edits);
      }
    }
  }

  if (edits.length === 0) {
    return { valid: false, status: "unavailable", reason: "no-edits-for-file", plan, transformedText: null };
  }

  // 3. Validate ranges & overlap
  const spans: Array<{ start: number; end: number; edit: LspTextEdit }> = [];
  for (const edit of edits) {
    const { start, end } = edit.range;
    if (start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) {
      return { valid: false, status: "failed", reason: "negative-range-coordinates", plan, transformedText: null };
    }
    if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
      return { valid: false, status: "failed", reason: "inverted-range", plan, transformedText: null };
    }
    const startOffset = offsetFromLspPositionInString(text, start);
    const endOffset = offsetFromLspPositionInString(text, end);
    spans.push({ start: startOffset, end: endOffset, edit });
  }

  // Sort by start offset ascending, then end offset
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < spans.length - 1; i++) {
    const current = spans[i]!;
    const next = spans[i + 1]!;
    if (current.end > next.start) {
      return {
        valid: false,
        status: "failed",
        reason: `overlapping-edits-detected: [${current.start}, ${current.end}) overlaps with [${next.start}, ${next.end})`,
        plan,
        transformedText: null,
      };
    }
  }

  // 4. Apply non-overlapping text edits in-memory
  const transformedText = applyLspTextEditsToString(text, edits);
  return {
    valid: true,
    status: transformedText !== text ? "applied" : "unavailable",
    plan,
    transformedText,
  };
}
