import type {
  LspLocation,
  LspRange,
  LspWorkspaceEdit,
} from "../../../lib/editor/lsp";

export interface SafeDeleteTarget {
  uri: string;
  path: string;
  range: LspRange;
}

function rangeKey(range: LspRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function locationKey(location: SafeDeleteTarget): string {
  return `${location.path}\u0000${rangeKey(location.range)}`;
}

function normalizedLocation(location: LspLocation): SafeDeleteTarget | null {
  if (!location.path) return null;
  return {
    uri: location.uri,
    path: location.path.replace(/\\/g, "/"),
    range: location.range,
  };
}

/**
 * Create one multi-document delete edit from the declaration and every LSP
 * reference. Duplicate declaration/reference locations are removed before the
 * edit is built so overlapping text edits cannot corrupt a document.
 */
export function buildSafeDeleteWorkspaceEdit(
  declaration: SafeDeleteTarget,
  references: readonly LspLocation[],
): { edit: LspWorkspaceEdit; locations: SafeDeleteTarget[]; usageCount: number } {
  const normalizedDeclaration: SafeDeleteTarget = {
    ...declaration,
    path: declaration.path.replace(/\\/g, "/"),
  };
  const declarationKey = locationKey(normalizedDeclaration);
  const byLocation = new Map<string, SafeDeleteTarget>([[declarationKey, normalizedDeclaration]]);
  for (const reference of references) {
    const normalized = normalizedLocation(reference);
    if (normalized) byLocation.set(locationKey(normalized), normalized);
  }
  const locations = [...byLocation.values()];
  const byDocument = new Map<string, { uri: string; path: string; ranges: LspRange[] }>();
  for (const location of locations) {
    const current = byDocument.get(location.path);
    if (current) current.ranges.push(location.range);
    else byDocument.set(location.path, { uri: location.uri, path: location.path, ranges: [location.range] });
  }
  const documentEdits = [...byDocument.values()].map((document) => ({
    uri: document.uri,
    path: document.path,
    version: null,
    edits: document.ranges.map((range) => ({ range, newText: "" })),
  }));
  return {
    edit: {
      documentEdits,
      operations: documentEdits.map((document) => ({ kind: "text" as const, document })),
    },
    locations,
    usageCount: locations.filter((location) => locationKey(location) !== declarationKey).length,
  };
}

export function safeDeleteFileCount(locations: readonly SafeDeleteTarget[]): number {
  return new Set(locations.map((location) => location.path)).size;
}
