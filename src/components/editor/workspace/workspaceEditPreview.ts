import type {
  LspChangeAnnotation,
  LspWorkspaceEdit,
  LspWorkspaceEditOperation,
} from "../../../lib/editor/lsp";

export interface WorkspaceEditPreviewEntry {
  operationIndex: number;
  kind: "text" | "create" | "rename" | "delete";
  path: string;
  secondaryPath: string | null;
  editCount: number;
  annotationLabel: string | null;
}

export interface WorkspaceEditPreviewUsage {
  id: string;
  operationIndex: number;
  editIndex: number;
  path: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
  annotationLabel: string | null;
}

export interface WorkspaceEditPreview {
  label: string | null;
  entries: WorkspaceEditPreviewEntry[];
  usages: WorkspaceEditPreviewUsage[];
  operationCount: number;
  affectedFileCount: number;
  textEditCount: number;
  resourceOperationCount: number;
  annotations: LspChangeAnnotation[];
  /** True when applying the edit can touch more than one file or mutate paths. */
  requiresConfirmation: boolean;
}

function displayPath(path: string | null | undefined, uri: string | null | undefined): string {
  const value = path?.trim() || uri?.trim() || "<unknown file>";
  return value;
}

export function workspaceEditOperations(edit: LspWorkspaceEdit): LspWorkspaceEditOperation[] {
  if (edit.operations?.length) return edit.operations;
  return edit.documentEdits.map((document) => ({ kind: "text", document }));
}

/**
 * Filter an LSP WorkspaceEdit by excluding specific usage IDs (e.g. unchecked in preview dialog).
 */
export function filterWorkspaceEditByUsages(
  edit: LspWorkspaceEdit,
  excludedUsageIds: ReadonlySet<string>,
): LspWorkspaceEdit {
  if (excludedUsageIds.size === 0) return edit;

  if (edit.operations && edit.operations.length > 0) {
    const operations: LspWorkspaceEditOperation[] = [];
    for (const [opIdx, op] of edit.operations.entries()) {
      if (op.kind !== "text") {
        operations.push(op);
        continue;
      }
      const filteredEdits = op.document.edits.filter(
        (_, editIdx) => !excludedUsageIds.has(`${opIdx}:${editIdx}`),
      );
      if (filteredEdits.length > 0) {
        operations.push({
          ...op,
          document: {
            ...op.document,
            edits: filteredEdits,
          },
        });
      }
    }
    return {
      ...edit,
      operations,
    };
  }

  const documentEdits = edit.documentEdits
    .map((doc, opIdx) => ({
      ...doc,
      edits: doc.edits.filter((_, editIdx) => !excludedUsageIds.has(`${opIdx}:${editIdx}`)),
    }))
    .filter((doc) => doc.edits.length > 0);

  return {
    ...edit,
    documentEdits,
  };
}

/**
 * Build a non-mutating summary of an LSP WorkspaceEdit.
 *
 * The operation order is intentionally retained. LSP documentChanges are
 * ordered and a preview that groups files alphabetically can hide a failing
 * resource operation boundary.
 */
export function buildWorkspaceEditPreview(
  edit: LspWorkspaceEdit,
  options: { label?: string | null } = {},
): WorkspaceEditPreview {
  const annotationsById = new Map(
    (edit.changeAnnotations ?? []).map((annotation) => [annotation.id, annotation]),
  );
  const referencedAnnotationIds = new Set<string>();
  const affectedPaths = new Set<string>();
  const entries: WorkspaceEditPreviewEntry[] = [];
  const usages: WorkspaceEditPreviewUsage[] = [];
  let textEditCount = 0;
  let resourceOperationCount = 0;

  for (const [operationIndex, operation] of workspaceEditOperations(edit).entries()) {
    if (operation.kind === "text") {
      const path = displayPath(operation.document.path, operation.document.uri);
      affectedPaths.add(path);
      textEditCount += operation.document.edits.length;
      entries.push({
        operationIndex,
        kind: "text",
        path,
        secondaryPath: null,
        editCount: operation.document.edits.length,
        annotationLabel: (operation.document.annotationIds ?? [])
          .map((id) => annotationsById.get(id)?.label ?? id)
          .join(", ") || null,
      });
      for (const [editIndex, item] of operation.document.edits.entries()) {
        const annotationLabel = item.annotationId
          ? annotationsById.get(item.annotationId)?.label ?? item.annotationId
          : null;
        usages.push({
          id: `${operationIndex}:${editIndex}`,
          operationIndex,
          editIndex,
          path,
          range: item.range,
          newText: item.newText,
          annotationLabel,
        });
      }
      for (const id of operation.document.annotationIds ?? []) referencedAnnotationIds.add(id);
      continue;
    }

    resourceOperationCount += 1;
    if (operation.kind === "create") {
      const path = displayPath(operation.path, operation.uri);
      affectedPaths.add(path);
      entries.push({
        operationIndex,
        kind: "create",
        path,
        secondaryPath: null,
        editCount: 0,
        annotationLabel: operation.annotationId
          ? annotationsById.get(operation.annotationId)?.label ?? operation.annotationId
          : null,
      });
      if (operation.annotationId) referencedAnnotationIds.add(operation.annotationId);
    } else if (operation.kind === "rename") {
      const oldPath = displayPath(operation.oldPath, operation.oldUri);
      const newPath = displayPath(operation.newPath, operation.newUri);
      affectedPaths.add(oldPath);
      affectedPaths.add(newPath);
      entries.push({
        operationIndex,
        kind: "rename",
        path: oldPath,
        secondaryPath: newPath,
        editCount: 0,
        annotationLabel: operation.annotationId
          ? annotationsById.get(operation.annotationId)?.label ?? operation.annotationId
          : null,
      });
      if (operation.annotationId) referencedAnnotationIds.add(operation.annotationId);
    } else {
      const path = displayPath(operation.path, operation.uri);
      affectedPaths.add(path);
      entries.push({
        operationIndex,
        kind: "delete",
        path,
        secondaryPath: null,
        editCount: 0,
        annotationLabel: operation.annotationId
          ? annotationsById.get(operation.annotationId)?.label ?? operation.annotationId
          : null,
      });
      if (operation.annotationId) referencedAnnotationIds.add(operation.annotationId);
    }
  }

  const annotations = (edit.changeAnnotations ?? []).filter((annotation) => (
    annotation.needsConfirmation && referencedAnnotationIds.has(annotation.id)
  ));
  const affectedFileCount = affectedPaths.size;
  return {
    label: options.label?.trim() || null,
    entries,
    usages,
    operationCount: entries.length,
    affectedFileCount,
    textEditCount,
    resourceOperationCount,
    annotations,
    requiresConfirmation: resourceOperationCount > 0 || affectedFileCount > 1,
  };
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function entryLabel(entry: WorkspaceEditPreviewEntry): string {
  if (entry.kind === "text") {
    return `Edit ${entry.path} (${plural(entry.editCount, "change")})`;
  }
  if (entry.kind === "create") return `Create ${entry.path}`;
  if (entry.kind === "delete") return `Delete ${entry.path}`;
  return `Rename ${entry.path} -> ${entry.secondaryPath ?? "<unknown file>"}`;
}

/** Format a compact, readable preview for the app's cross-platform confirm dialog. */
export function formatWorkspaceEditPreview(
  preview: WorkspaceEditPreview,
  options: { maxEntries?: number } = {},
): string {
  const lines = [
    `${plural(preview.affectedFileCount, "file")} affected; `
      + `${plural(preview.textEditCount, "text change")} and `
      + `${plural(preview.resourceOperationCount, "resource operation")}.`,
    "Changes are applied in order. A later failure may leave earlier changes applied.",
  ];
  const maxEntries = Math.max(1, options.maxEntries ?? 12);
  for (const entry of preview.entries.slice(0, maxEntries)) {
    const annotation = entry.annotationLabel ? ` [${entry.annotationLabel}]` : "";
    lines.push(`${entry.operationIndex + 1}. ${entryLabel(entry)}${annotation}`);
  }
  if (preview.entries.length > maxEntries) {
    lines.push(`...and ${preview.entries.length - maxEntries} more operations.`);
  }
  if (preview.annotations.length > 0) {
    lines.push("", "Server confirmation:");
    for (const annotation of preview.annotations.slice(0, 6)) {
      lines.push(annotation.description
        ? `- ${annotation.label}: ${annotation.description}`
        : `- ${annotation.label}`);
    }
    if (preview.annotations.length > 6) {
      lines.push(`- ...and ${preview.annotations.length - 6} more confirmations.`);
    }
  }
  return lines.join("\n");
}
