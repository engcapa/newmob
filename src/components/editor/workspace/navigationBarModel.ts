import type { LspDocumentSymbol, LspPosition } from "../../../lib/editor/lsp";
import { type BreadcrumbPathSegment, symbolChainAtPosition } from "./Breadcrumbs";

export interface NavigationBarSegment {
  id: string;
  type: "path" | "symbol";
  label: string;
  kind: "root" | "directory" | "file" | "symbol";
  pathSegment?: BreadcrumbPathSegment;
  symbol?: LspDocumentSymbol;
}

export interface NavigationBarState {
  active: boolean;
  focusedSegmentIndex: number;
  segments: NavigationBarSegment[];
  popupOpen: boolean;
}

/**
 * Builds sequential navigation bar segments covering root, directory hierarchy,
 * file, and active document symbol chain for keyboard-driven navigation.
 */
export function buildNavigationBarSegments(
  pathSegments: BreadcrumbPathSegment[],
  symbols: LspDocumentSymbol[],
  position: LspPosition,
): NavigationBarSegment[] {
  const segments: NavigationBarSegment[] = [];

  for (const path of pathSegments) {
    segments.push({
      id: `path:${path.kind}:${path.label}`,
      type: "path",
      label: path.label,
      kind: path.kind,
      pathSegment: path,
    });
  }

  const symbolChain = symbolChainAtPosition(symbols, position);

  for (const sym of symbolChain) {
    segments.push({
      id: `symbol:${sym.name}:${sym.selectionRange.start.line}:${sym.selectionRange.start.character}`,
      type: "symbol",
      label: sym.name,
      kind: "symbol",
      symbol: sym,
    });
  }

  return segments;
}

/**
 * Navigates segment index left, right, first, or last with clamp boundaries.
 */
export function navigateSegments(
  currentIndex: number,
  totalCount: number,
  direction: "left" | "right" | "first" | "last",
): number {
  if (totalCount <= 0) return 0;
  if (direction === "first") return 0;
  if (direction === "last") return totalCount - 1;
  if (direction === "left") return Math.max(0, currentIndex - 1);
  if (direction === "right") return Math.min(totalCount - 1, currentIndex + 1);
  return currentIndex;
}
