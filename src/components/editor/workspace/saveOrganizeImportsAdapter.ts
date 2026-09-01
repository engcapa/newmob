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
 * - Exact action kind and pure WorkspaceEdit (rejects every command/resource operation)
 * - Frozen document URI/revision and versioned edit identity
 * - Exact target URI (rejects multi-file edits touching other files as unavailable)
 * - Non-negative, non-inverted, in-bounds ranges
 * - Non-overlapping edit spans
 * Returns pure in-memory transformed text with zero live buffer side effects.
 */
export function validateAndApplyOrganizeImportsPlan(
  text: string,
  targetUri: string,
  plan: ImmutableCodeActionPlan | null,
  expectedRevision?: number,
): SaveOrganizeImportsValidationResult {
  if (!plan) {
    return { valid: false, status: "unavailable", reason: "no-plan", plan: null, transformedText: null };
  }

  const normalizeUri = (uri: string) => uri.replace(/\\/g, "/");
  const normalizedTarget = normalizeUri(targetUri);
  if (normalizeUri(plan.document.uri) !== normalizedTarget) {
    return {
      valid: false,
      status: "unavailable",
      reason: "plan-document-uri-mismatch",
      plan,
      transformedText: null,
    };
  }
  if (expectedRevision !== undefined && plan.document.revision !== expectedRevision) {
    return {
      valid: false,
      status: "unavailable",
      reason: "plan-document-revision-mismatch",
      plan,
      transformedText: null,
    };
  }
  if (plan.kind !== "source.organizeImports") {
    return {
      valid: false,
      status: "unavailable",
      reason: "unexpected-code-action-kind",
      plan,
      transformedText: null,
    };
  }

  // 1. Check for edit vs command-only
  const hasDocEdits = Boolean(plan.edit?.documentEdits && plan.edit.documentEdits.length > 0);
  const hasOperations = Boolean(plan.edit?.operations && plan.edit.operations.length > 0);

  if (plan.command) {
    return {
      valid: false,
      status: "unavailable",
      reason: plan.edit && (hasDocEdits || hasOperations)
        ? "edit-with-command-not-supported-in-save-normalization"
        : "command-only-not-supported-in-save-normalization",
      plan,
      transformedText: null,
    };
  }

  if (!plan.edit || (!hasDocEdits && !hasOperations)) {
    return { valid: false, status: "unavailable", reason: "empty-edit", plan, transformedText: null };
  }
  if (plan.edit.operations?.some((operation) => operation.kind !== "text")) {
    return {
      valid: false,
      status: "unavailable",
      reason: "resource-operation-not-supported-in-save-normalization",
      plan,
      transformedText: null,
    };
  }

  // 2. Validate URI matching & single vs multi-file
  const affectedUris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
  const isMatch = (uri: string | null | undefined) => {
    if (!uri) return false;
    return normalizeUri(uri) === normalizedTarget;
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
  const targetRevision = expectedRevision ?? plan.document.revision;
  if (!plan.edit.operations?.length && plan.edit.documentEdits) {
    for (const doc of plan.edit.documentEdits) {
      if (doc.version != null && doc.version !== targetRevision) {
        return {
          valid: false,
          status: "unavailable",
          reason: "edit-document-version-mismatch",
          plan,
          transformedText: null,
        };
      }
      if (isMatch(doc.uri)) {
        edits.push(...doc.edits);
      }
    }
  }
  if (plan.edit.operations) {
    for (const op of plan.edit.operations) {
      if (op.kind === "text" && op.document.version != null && op.document.version !== targetRevision) {
        return {
          valid: false,
          status: "unavailable",
          reason: "edit-document-version-mismatch",
          plan,
          transformedText: null,
        };
      }
      if (op.kind === "text" && isMatch(op.document.uri)) {
        edits.push(...op.document.edits);
      }
    }
  }

  if (edits.length === 0) {
    return { valid: false, status: "unavailable", reason: "no-edits-for-file", plan, transformedText: null };
  }

  // 3. Validate ranges & overlap
  const spans: Array<{ start: number; end: number; edit: LspTextEdit }> = [];
  const lines = text.split("\n");
  const positionIsInBounds = (position: { line: number; character: number }) => (
    position.line < lines.length
      ? position.character <= lines[position.line]!.length
      : position.line === lines.length && position.character === 0
  );
  for (const edit of edits) {
    const { start, end } = edit.range;
    if (start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) {
      return { valid: false, status: "failed", reason: "negative-range-coordinates", plan, transformedText: null };
    }
    if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
      return { valid: false, status: "failed", reason: "inverted-range", plan, transformedText: null };
    }
    if (!positionIsInBounds(start) || !positionIsInBounds(end)) {
      return { valid: false, status: "failed", reason: "range-out-of-bounds", plan, transformedText: null };
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
