import type { ChatDrawerPosition } from "../../stores/chatStore";

/**
 * How the chat drawer docks for a given position/pin state and viewport
 * (see tao-notes-feature-plan.md). Shared by MainLayout (placement) and
 * ChatDrawer (rendering) so both always agree.
 *
 * - "side-inline": left/right pinned — a full-height column beside the work area.
 * - "stacked-inline": top/bottom pinned — a full-width band above/below the work
 *   area. Falls back to "floating" on a narrow/short window (§8.2).
 * - "floating": an overlay panel (unpinned, or the narrow-window fallback).
 */
export type ChatDockMode = "side-inline" | "stacked-inline" | "floating";

/** Below this width, top/bottom pinning falls back to a floating panel. */
export const CHAT_DOCK_NARROW_WIDTH = 680;
/** Below this height, a stacked band would crowd the work area — fall back. */
export const CHAT_DOCK_MIN_STACK_HEIGHT = 420;

export function resolveChatDock(
  position: ChatDrawerPosition,
  pinned: boolean,
  width: number,
  height: number,
): ChatDockMode {
  const horizontal = position === "left" || position === "right";
  if (!pinned) return "floating";
  if (horizontal) return "side-inline";
  // top/bottom pinned → stacked band, unless the window is too small.
  if (width >= CHAT_DOCK_NARROW_WIDTH && height >= CHAT_DOCK_MIN_STACK_HEIGHT) {
    return "stacked-inline";
  }
  return "floating";
}
