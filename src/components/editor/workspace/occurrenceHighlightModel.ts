import type { LspDocumentHighlight, LspPosition, LspRange } from "../../../lib/editor/lsp";

export type OccurrenceRole = "read" | "write" | "unknown";

export interface OccurrenceItem {
  id: string;
  range: LspRange;
  role: OccurrenceRole;
  index: number;
}

export interface OccurrenceHighlightSession {
  fileKey: string;
  documentRevision: number;
  word: string;
  items: OccurrenceItem[];
  currentIndex: number;
}

/**
 * Maps LSP document highlight kind to explicit semantic occurrence role.
 * 1 = Text (or fallback) -> unknown
 * 2 = Read -> read
 * 3 = Write -> write
 */
export function classifyHighlightRole(kind: number | null | undefined): OccurrenceRole {
  if (kind === 2) return "read";
  if (kind === 3) return "write";
  return "unknown";
}

export function sortOccurrences(items: LspDocumentHighlight[]): LspDocumentHighlight[] {
  return [...items].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return a.range.start.line - b.range.start.line;
    }
    return a.range.start.character - b.range.start.character;
  });
}

/**
 * Creates an active occurrence session from resolved highlights.
 */
export function createOccurrenceSession(
  fileKey: string,
  documentRevision: number,
  word: string,
  highlights: LspDocumentHighlight[],
  currentPosition?: LspPosition,
): OccurrenceHighlightSession {
  const sorted = sortOccurrences(highlights);
  const items: OccurrenceItem[] = sorted.map((hl, idx) => ({
    id: `${fileKey}:${hl.range.start.line}:${hl.range.start.character}`,
    range: hl.range,
    role: classifyHighlightRole(hl.kind),
    index: idx,
  }));

  let currentIndex = 0;
  if (currentPosition && items.length > 0) {
    const matchIdx = items.findIndex(
      (item) =>
        item.range.start.line === currentPosition.line
        && item.range.start.character <= currentPosition.character
        && item.range.end.character >= currentPosition.character,
    );
    if (matchIdx >= 0) {
      currentIndex = matchIdx;
    }
  }

  return {
    fileKey,
    documentRevision,
    word,
    items,
    currentIndex,
  };
}

/**
 * Advances or rewinds the active occurrence index with looping.
 */
export function stepOccurrence(
  session: OccurrenceHighlightSession,
  direction: "next" | "previous",
): { session: OccurrenceHighlightSession; current: OccurrenceItem | null } {
  if (session.items.length === 0) {
    return { session, current: null };
  }
  const total = session.items.length;
  const nextIndex = direction === "next"
    ? (session.currentIndex + 1) % total
    : (session.currentIndex - 1 + total) % total;

  const nextSession: OccurrenceHighlightSession = {
    ...session,
    currentIndex: nextIndex,
  };
  return {
    session: nextSession,
    current: nextSession.items[nextIndex] ?? null,
  };
}

/**
 * Formats user-facing status feedback for occurrence navigation and role breakdown.
 */
export function formatOccurrenceStatus(session: OccurrenceHighlightSession): string {
  if (session.items.length === 0) {
    return `No occurrences found for "${session.word}"`;
  }
  const current = session.items[session.currentIndex];
  const readCount = session.items.filter((i) => i.role === "read").length;
  const writeCount = session.items.filter((i) => i.role === "write").length;
  const unknownCount = session.items.filter((i) => i.role === "unknown").length;

  const parts: string[] = [];
  if (readCount > 0) parts.push(`${readCount} read`);
  if (writeCount > 0) parts.push(`${writeCount} write`);
  if (unknownCount > 0) parts.push(`${unknownCount} unknown`);

  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const roleLabel = current ? ` [${current.role}]` : "";

  return `Occurrence ${session.currentIndex + 1} of ${session.items.length}${roleLabel}${breakdown}`;
}

/**
 * Validates whether the active occurrence session is still fresh against the editor state.
 */
export function isOccurrenceSessionValid(
  session: OccurrenceHighlightSession | null,
  currentFileKey: string,
  currentDocumentRevision: number,
): boolean {
  if (!session) return false;
  return session.fileKey === currentFileKey && session.documentRevision === currentDocumentRevision;
}
