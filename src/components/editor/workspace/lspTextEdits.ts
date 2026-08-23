import type {
  LspDocumentContentChange,
  LspPosition,
  LspRange,
  LspTextEdit,
} from "../../../lib/editor/lsp";

/** Convert a 0-based LSP position into a string offset for any line ending (LF, CRLF, CR). */
export function offsetFromLspPositionInString(text: string, position: LspPosition): number {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length === 0) return 0;
  const lineIndex = Math.min(lines.length - 1, Math.max(0, position.line));
  let currentOffset = 0;
  let currentLine = 0;
  while (currentOffset < text.length && currentLine < lineIndex) {
    if (text.charCodeAt(currentOffset) === 13) {
      if (currentOffset + 1 < text.length && text.charCodeAt(currentOffset + 1) === 10) {
        currentOffset += 2;
      } else {
        currentOffset += 1;
      }
      currentLine += 1;
    } else if (text.charCodeAt(currentOffset) === 10) {
      currentOffset += 1;
      currentLine += 1;
    } else {
      currentOffset += 1;
    }
  }
  const line = lines[lineIndex] ?? "";
  return currentOffset + Math.min(line.length, Math.max(0, position.character));
}

/**
 * Apply LSP TextEdits to a document string.
 * Edits are applied from the end of the document to the start so earlier
 * offsets stay valid (standard client strategy for non-overlapping edits).
 */
export function applyLspTextEditsToString(text: string, edits: readonly LspTextEdit[]): string {
  if (!edits.length) return text;
  const ordered = [...edits].sort((a, b) => {
    const aStart = offsetFromLspPositionInString(text, a.range.start);
    const bStart = offsetFromLspPositionInString(text, b.range.start);
    if (aStart !== bStart) return bStart - aStart;
    const aEnd = offsetFromLspPositionInString(text, a.range.end);
    const bEnd = offsetFromLspPositionInString(text, b.range.end);
    return bEnd - aEnd;
  });
  let next = text;
  for (const edit of ordered) {
    const from = offsetFromLspPositionInString(next, edit.range.start);
    const to = offsetFromLspPositionInString(next, edit.range.end);
    next = next.slice(0, from) + edit.newText + next.slice(to);
  }
  return next;
}

export function rangeIsEmpty(range: LspRange): boolean {
  return range.start.line === range.end.line && range.start.character === range.end.character;
}

function positionFromStringOffset(text: string, offset: number): LspPosition {
  let line = 0;
  let lineStart = 0;
  let index = 0;
  while (index < offset && index < text.length) {
    if (text.charCodeAt(index) === 13) {
      if (index + 1 < text.length && text.charCodeAt(index + 1) === 10) {
        index += 2;
      } else {
        index += 1;
      }
      line += 1;
      lineStart = index;
    } else if (text.charCodeAt(index) === 10) {
      index += 1;
      line += 1;
      lineStart = index;
    } else {
      index += 1;
    }
  }
  return { line, character: offset - lineStart };
}

/**
 * Position at `toOffset` given the known position at `fromOffset` (`fromOffset <=
 * toOffset`). Scans only the `[fromOffset, toOffset)` span instead of restarting
 * from 0 — for an edit late in a large file this halves the total scan the diff
 * would otherwise pay to locate both endpoints. Output is identical to
 * `positionFromStringOffset(text, toOffset)`.
 */
function advanceStringPosition(
  text: string,
  from: LspPosition,
  fromOffset: number,
  toOffset: number,
): LspPosition {
  let { line, character } = from;
  let index = fromOffset;
  while (index < toOffset && index < text.length) {
    if (text.charCodeAt(index) === 13) {
      if (index + 1 < text.length && text.charCodeAt(index + 1) === 10) {
        index += 2;
      } else {
        index += 1;
      }
      line += 1;
      character = 0;
    } else if (text.charCodeAt(index) === 10) {
      index += 1;
      line += 1;
      character = 0;
    } else {
      index += 1;
      character += 1;
    }
  }
  return { line, character };
}

function offsetSplitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff
    && current >= 0xdc00 && current <= 0xdfff;
}

/** Build one minimal UTF-16 LSP edit that transforms `previousText` into `nextText`. */
export function buildIncrementalContentChange(
  previousText: string,
  nextText: string,
): LspDocumentContentChange | null {
  if (previousText === nextText) return null;

  const commonLength = Math.min(previousText.length, nextText.length);
  let start = 0;
  while (start < commonLength && previousText.charCodeAt(start) === nextText.charCodeAt(start)) {
    start += 1;
  }
  if (offsetSplitsSurrogatePair(previousText, start)
    || offsetSplitsSurrogatePair(nextText, start)) {
    start -= 1;
  }

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (previousEnd > start
    && nextEnd > start
    && previousText.charCodeAt(previousEnd - 1) === nextText.charCodeAt(nextEnd - 1)) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  if (offsetSplitsSurrogatePair(previousText, previousEnd)
    || offsetSplitsSurrogatePair(nextText, nextEnd)) {
    previousEnd += 1;
    nextEnd += 1;
  }

  const startPosition = positionFromStringOffset(previousText, start);
  return {
    range: {
      start: startPosition,
      // Continue from `start` over the (usually tiny) changed span rather than
      // re-scanning `previousText` from offset 0 a second time.
      end: advanceStringPosition(previousText, startPosition, start, previousEnd),
    },
    rangeLength: previousEnd - start,
    text: nextText.slice(start, nextEnd),
  };
}
