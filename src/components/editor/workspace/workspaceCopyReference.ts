/**
 * §8.19.5 Copy Reference candidate model.
 *
 * Candidates are built ONLY from facts the caller actually has: a
 * workspace-relative `path:line` from the file path, and a bare symbol name
 * when a provider symbol range exists. A qualified name is NEVER synthesized
 * from display text — without a provider qualified-name channel it stays an
 * explicit unavailable reason.
 */

export interface CopyReferenceInput {
  /** Absolute filesystem path of the active file, when it has one. */
  path: string | null;
  /** Library/decompiled buffers copy with their own explicit format. */
  isLibrary: boolean;
  roots: readonly string[];
  /** 0-based caret line (LSP coordinates). */
  line: number;
  /**
   * Symbol identity taken from the provider rename range (or null when the
   * provider declined / no server is attached) — never guessed from text.
   */
  symbolName: string | null;
}

export type CopyReferenceCandidate =
  | { id: "path-line"; label: string; text: string }
  | { id: "absolute-path-line"; label: string; text: string }
  | { id: "symbol"; label: string; text: string };

export type CopyReferenceOutcome =
  | { kind: "candidates"; candidates: readonly CopyReferenceCandidate[] }
  | { kind: "unavailable"; reason: string; detail: string };

/** Normalize Windows drive URIs/paths the same way the panels do. */
function normalizePath(path: string): string {
  return path.replace(/^\/([A-Za-z]:)/, "$1").replace(/\\/g, "/");
}

/** Smallest enclosing root path, or null when the file lies outside all roots. */
function relativeWithin(roots: readonly string[], path: string): string | null {
  const normalized = normalizePath(path);
  let best: string | null = null;
  for (const root of roots) {
    const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
    if (!normalizedRoot) continue;
    const rest = normalizedRoot + "/";
    if (!normalized.startsWith(rest)) continue;
    const relative = normalized.slice(rest.length);
    if (best === null || relative.length < best.length) best = relative;
  }
  return best;
}

export function copyReferenceCandidates(input: CopyReferenceInput): CopyReferenceOutcome {
  if (!input.path?.trim()) {
    return { kind: "unavailable", reason: "no-file", detail: "No file path to reference" };
  }
  const path = normalizePath(input.path);
  // IDEA-style 1-based display line in the copied reference.
  const displayLine = input.line + 1;

  if (input.isLibrary) {
    return {
      kind: "unavailable",
      reason: "library-source",
      detail: "References are not generated for library or decompiled sources",
    };
  }

  const candidates: CopyReferenceCandidate[] = [];
  const relative = relativeWithin(input.roots, path);
  if (relative !== null) {
    candidates.push({
      id: "path-line",
      label: "Workspace-relative path",
      text: `${relative}:${displayLine}`,
    });
  } else {
    // Outside every root: relativization is impossible — an absolute
    // reference is still honest, so it is offered under its own format.
    candidates.push({
      id: "absolute-path-line",
      label: "Absolute path (outside workspace roots)",
      text: `${path}:${displayLine}`,
    });
  }
  if (input.symbolName && input.symbolName.trim()) {
    candidates.push({
      id: "symbol",
      label: "Symbol name only",
      text: input.symbolName.trim(),
    });
  }
  return { kind: "candidates", candidates };
}
