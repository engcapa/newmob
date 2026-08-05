import type { CSSProperties } from "react";

/**
 * Tao Ribbon placement model (see tao-notes-feature-plan.md). The ribbon
 * docks to one of the four window edges at a fractional offset along that edge,
 * so its position stays relatively stable across window resizes.
 */
export type TaoRibbonEdge = "left" | "right" | "top" | "bottom";

export interface TaoRibbonPlacement {
  edge: TaoRibbonEdge;
  /** Position along the edge, 0..1 (top→bottom for left/right, left→right for top/bottom). */
  offsetRatio: number;
}

export const DEFAULT_RIBBON_PLACEMENT: TaoRibbonPlacement = {
  edge: "right",
  offsetRatio: 0.5,
};

/**
 * Per-edge clamp bounds that keep the ribbon clear of window chrome:
 * - top: macOS traffic lights (left) and the custom window controls (right)
 * - bottom: the status bar corners and the bottom-right resize handle
 * - left/right: the title bar (top) and status bar (bottom)
 */
const EDGE_CLAMP: Record<TaoRibbonEdge, readonly [number, number]> = {
  top: [0.2, 0.8],
  bottom: [0.1, 0.82],
  left: [0.12, 0.88],
  right: [0.12, 0.88],
};

/** Clamp an offset ratio into the safe band for the given edge. */
export function clampOffsetRatio(edge: TaoRibbonEdge, ratio: number): number {
  const [min, max] = EDGE_CLAMP[edge];
  if (!Number.isFinite(ratio)) return (min + max) / 2;
  return Math.min(max, Math.max(min, ratio));
}

/** Nearest window edge for a pointer at (x, y) within a w×h viewport. */
export function nearestEdge(x: number, y: number, w: number, h: number): TaoRibbonEdge {
  const width = w || 1;
  const height = h || 1;
  const distances: Array<[TaoRibbonEdge, number]> = [
    ["left", x],
    ["right", width - x],
    ["top", y],
    ["bottom", height - y],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

/** Project a pointer onto the chosen edge, returning a clamped offset ratio. */
export function offsetRatioForEdge(
  edge: TaoRibbonEdge,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const width = w || 1;
  const height = h || 1;
  const raw = edge === "left" || edge === "right" ? y / height : x / width;
  return clampOffsetRatio(edge, raw);
}

/** Full placement (edge + clamped offset) from a drop point. */
export function placementFromPoint(
  x: number,
  y: number,
  w: number,
  h: number,
): TaoRibbonPlacement {
  const edge = nearestEdge(x, y, w, h);
  return { edge, offsetRatio: offsetRatioForEdge(edge, x, y, w, h) };
}

/** Absolute-positioning CSS for a ribbon at the given placement. */
export function ribbonPositionStyle(placement: TaoRibbonPlacement): CSSProperties {
  const ratio = clampOffsetRatio(placement.edge, placement.offsetRatio);
  const pct = `${(ratio * 100).toFixed(4)}%`;
  switch (placement.edge) {
    case "left":
      return { left: 0, top: pct, transform: "translateY(-50%)" };
    case "right":
      return { right: 0, top: pct, transform: "translateY(-50%)" };
    case "top":
      return { top: 0, left: pct, transform: "translateX(-50%)" };
    case "bottom":
      return { bottom: 0, left: pct, transform: "translateX(-50%)" };
  }
}

/** Normalize a possibly-partial stored placement into a valid one. */
export function normalizePlacement(value: Partial<TaoRibbonPlacement> | null | undefined): TaoRibbonPlacement {
  const edge: TaoRibbonEdge =
    value?.edge === "left" || value?.edge === "right" || value?.edge === "top" || value?.edge === "bottom"
      ? value.edge
      : DEFAULT_RIBBON_PLACEMENT.edge;
  const ratio = clampOffsetRatio(edge, Number(value?.offsetRatio ?? DEFAULT_RIBBON_PLACEMENT.offsetRatio));
  return { edge, offsetRatio: ratio };
}
