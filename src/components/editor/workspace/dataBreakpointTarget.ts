import type { LspDocumentSymbol, LspPosition, LspRange } from "../../../lib/editor/lsp";

/** LSP SymbolKind values that represent a source-level field/property. */
export const DATA_BREAKPOINT_FIELD_SYMBOL_KINDS = new Set([
  7, // Property
  8, // Field
  14, // Constant
  22, // EnumMember
]);

export function isDataBreakpointFieldSymbol(symbol: Pick<LspDocumentSymbol, "kind">): boolean {
  return DATA_BREAKPOINT_FIELD_SYMBOL_KINDS.has(symbol.kind);
}

function comparePosition(left: LspPosition, right: LspPosition): number {
  return left.line - right.line || left.character - right.character;
}

function contains(range: LspRange, position: LspPosition): boolean {
  return comparePosition(range.start, position) <= 0
    && comparePosition(position, range.end) <= 0;
}

function declarationLineDistance(symbol: LspDocumentSymbol, position: LspPosition): number {
  if (position.line < symbol.selectionRange.start.line) {
    return symbol.selectionRange.start.line - position.line;
  }
  if (position.line > symbol.selectionRange.end.line) {
    return position.line - symbol.selectionRange.end.line;
  }
  return 0;
}

function rangeSpan(range: LspRange): number {
  return Math.max(0, range.end.line - range.start.line) * 10000
    + Math.max(0, range.end.character - range.start.character);
}

/**
 * Find the nearest field/property declaration at an editor position.
 *
 * Language servers differ on whether a field's `range` covers the complete
 * declaration or only its identifier. We accept an exact range/selection hit
 * first, then the declaration line as a conservative fallback. Methods,
 * classes, and local variables are deliberately excluded.
 */
export function fieldDeclarationAt(
  symbols: readonly LspDocumentSymbol[],
  position: LspPosition,
): LspDocumentSymbol | null {
  const candidates = symbols.filter((symbol) => (
    isDataBreakpointFieldSymbol(symbol)
    && (contains(symbol.range, position) || contains(symbol.selectionRange, position))
  ));
  if (candidates.length > 0) {
    return candidates.slice().sort((left, right) => (
      rangeSpan(left.selectionRange) - rangeSpan(right.selectionRange)
      || right.depth - left.depth
    ))[0] ?? null;
  }
  return symbols
    .filter((symbol) => (
      isDataBreakpointFieldSymbol(symbol)
      && declarationLineDistance(symbol, position) === 0
    ))
    .sort((left, right) => (
      declarationLineDistance(left, position) - declarationLineDistance(right, position)
      || rangeSpan(left.selectionRange) - rangeSpan(right.selectionRange)
      || right.depth - left.depth
    ))[0] ?? null;
}

