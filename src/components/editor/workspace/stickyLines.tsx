import React from "react";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { Hash } from "lucide-react";

export interface StickyLine {
  /** 0-based line number in document */
  line: number;
  /** Trimmed/formatted line text for sticky display */
  text: string;
  /** Symbol name */
  name: string;
  /** SymbolKind */
  kind: number;
  /** Scope nesting depth: 0, 1, 2... */
  depth: number;
}

/**
 * Computes sticky scope headers given the document symbol tree, document lines,
 * and the top visible line in the viewport (0-based).
 */
export function computeStickyLines(
  symbols: LspDocumentSymbol[] | undefined,
  docLines: string[],
  topLine: number,
  maxLines: number = 3,
): StickyLine[] {
  if (!symbols || symbols.length === 0 || topLine <= 0) return [];

  const sticky: StickyLine[] = [];

  const enclosing = symbols
    .filter((sym) => sym.range.start.line < topLine && sym.range.end.line >= topLine)
    .sort((a, b) => a.depth - b.depth || a.range.start.line - b.range.start.line);

  for (const sym of enclosing) {
    if (sticky.length >= maxLines) break;
    const startLine = sym.range.start.line;
    const rawLine = docLines[startLine] ?? sym.name;
    const trimmed = rawLine.trim();
    sticky.push({
      line: startLine,
      text: trimmed || sym.name,
      name: sym.name,
      kind: sym.kind,
      depth: sym.depth,
    });
  }

  return sticky;
}

export interface StickyLinesOverlayProps {
  stickyLines: StickyLine[];
  onSelectLine: (line: number) => void;
}

export function StickyLinesOverlay({
  stickyLines,
  onSelectLine,
}: StickyLinesOverlayProps): React.JSX.Element | null {
  if (!stickyLines || stickyLines.length === 0) return null;

  return (
    <div
      data-testid="code-workspace-sticky-lines"
      className="absolute top-0 left-0 right-0 z-20 flex flex-col bg-[var(--taomni-code-bg)]/95 backdrop-blur border-b border-[var(--taomni-code-border)] shadow-sm pointer-events-auto select-none"
    >
      {stickyLines.map((item) => (
        <button
          key={`${item.line}:${item.name}`}
          type="button"
          data-testid="code-workspace-sticky-line-entry"
          className="flex items-center w-full px-3 py-0.5 text-left text-xs font-mono text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] transition-colors group cursor-pointer"
          style={{ paddingLeft: `${12 + item.depth * 16}px` }}
          onClick={() => onSelectLine(item.line)}
          title={`Line ${item.line + 1}: ${item.text}`}
        >
          <span className="w-8 shrink-0 text-right pr-2 text-[10px] text-[var(--taomni-code-muted)] group-hover:text-[var(--taomni-accent)]">
            {item.line + 1}
          </span>
          <Hash className="w-3 h-3 shrink-0 mr-1.5 text-[var(--taomni-accent)] opacity-75" />
          <span className="truncate min-w-0 font-medium">
            {item.text}
          </span>
        </button>
      ))}
    </div>
  );
}
