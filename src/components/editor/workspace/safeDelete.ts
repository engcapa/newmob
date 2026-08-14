import type {
  LspLocation,
  LspRange,
  LspWorkspaceEdit,
} from "../../../lib/editor/lsp";
import {
  normalizeFsPath,
  relativePathWithinRoot,
} from "./codeWorkspaceModel";

export interface SafeDeleteTarget {
  uri: string;
  path: string;
  range: LspRange;
}

export interface SafeDeleteBuildOptions {
  /** Absolute workspace roots allowed to participate in a destructive edit. */
  workspaceRoots?: readonly string[];
}

export interface SafeDeleteWorkspaceEditResult {
  edit: LspWorkspaceEdit;
  locations: SafeDeleteTarget[];
  usageCount: number;
  /** References that could not be represented as local workspace edits. */
  unresolvedReferences: LspLocation[];
  /** False means the edit must not be applied. */
  complete: boolean;
  diagnostics: string[];
}

function rangeKey(range: LspRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function locationKey(location: SafeDeleteTarget): string {
  return `${location.path}\u0000${rangeKey(location.range)}`;
}

function normalizedLocation(location: LspLocation): SafeDeleteTarget | null {
  if (!location.path?.trim()) return null;
  return {
    uri: location.uri,
    path: normalizeFsPath(location.path),
    range: location.range,
  };
}

function pathWithinRoot(path: string, root: string): boolean {
  return relativePathWithinRoot(root, path) !== null;
}

/**
 * Create one multi-document delete edit from the declaration and every LSP
 * reference. Duplicate declaration/reference locations are removed before the
 * edit is built so overlapping text edits cannot corrupt a document.
 */
export function buildSafeDeleteWorkspaceEdit(
  declaration: SafeDeleteTarget,
  references: readonly LspLocation[],
  options: SafeDeleteBuildOptions = {},
): SafeDeleteWorkspaceEditResult {
  const workspaceRoots = (options.workspaceRoots ?? [])
    .map(normalizeFsPath)
    .filter(Boolean);
  const diagnostics: string[] = [];
  const unresolvedReferences: LspLocation[] = [];
  const normalizedDeclaration: SafeDeleteTarget = {
    ...declaration,
    path: normalizeFsPath(declaration.path),
  };
  const declarationInWorkspace = normalizedDeclaration.path.length > 0
    && (workspaceRoots.length === 0 || workspaceRoots.some((root) => pathWithinRoot(normalizedDeclaration.path, root)));
  if (!declarationInWorkspace) {
    diagnostics.push("The symbol declaration is not a local file inside the workspace");
  }
  const declarationKey = locationKey(normalizedDeclaration);
  const byLocation = declarationInWorkspace
    ? new Map<string, SafeDeleteTarget>([[declarationKey, normalizedDeclaration]])
    : new Map<string, SafeDeleteTarget>();
  for (const reference of references) {
    const normalized = normalizedLocation(reference);
    if (!normalized || (workspaceRoots.length > 0 && !workspaceRoots.some((root) => pathWithinRoot(normalized.path, root)))) {
      unresolvedReferences.push(reference);
      continue;
    }
    byLocation.set(locationKey(normalized), normalized);
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
  const complete = declarationInWorkspace && unresolvedReferences.length === 0;
  return {
    edit: {
      documentEdits: complete ? documentEdits : [],
      operations: complete
        ? documentEdits.map((document) => ({ kind: "text" as const, document }))
        : [],
    },
    locations,
    usageCount: locations.filter((location) => locationKey(location) !== declarationKey).length,
    unresolvedReferences,
    complete,
    diagnostics: unresolvedReferences.length > 0
      ? [...diagnostics, `${unresolvedReferences.length} reference${unresolvedReferences.length === 1 ? "" : "s"} cannot be resolved to workspace files`]
      : diagnostics,
  };
}

export function safeDeleteFileCount(locations: readonly SafeDeleteTarget[]): number {
  return new Set(locations.map((location) => location.path)).size;
}
