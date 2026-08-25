/**
 * W0 §8.20.1 — global shortcut root routing.
 *
 * The shell's window-level capture listener and the workspace action hosts
 * used to race for shared chords (Ctrl+Shift+T reached "new local terminal"
 * even when an active Code Workspace could still reopen a closed tab). This
 * module is the single routing decision: claims are collected from the
 * active surfaces, and `resolveShellShortcutRoute` deterministically picks
 * the one owner that executes — or explicitly blocks — the chord.
 *
 * Fixed priority: modal > active Code Workspace ActionHost >
 * active non-workspace tab > shell. The shell only handles a chord when no
 * claim routes or blocks it.
 */

export type ShellShortcutScope = "modal" | "active-workspace" | "active-tab" | "shell";

export interface ShellShortcutClaim {
  ownerId: string;
  actionId: string;
  scope: ShellShortcutScope;
  priority: number;
  enabled: boolean;
  canExecute: boolean;
  disabledReason: string | null;
}

export type ShellShortcutRoute =
  | { state: "dispatch"; ownerId: string; actionId: string }
  | { state: "blocked"; reason: string; preventDefault: boolean }
  | { state: "unclaimed" };

/** Lower rank wins; ties inside a scope break by higher `priority`. */
const SCOPE_RANK: Record<ShellShortcutScope, number> = {
  modal: 0,
  "active-workspace": 1,
  "active-tab": 2,
  shell: 3,
};

export function resolveShellShortcutRoute(
  claims: readonly ShellShortcutClaim[],
): ShellShortcutRoute {
  const enabled = claims.filter((claim) => claim.enabled);
  if (enabled.length === 0) return { state: "unclaimed" };
  const ranked = [...enabled].sort((a, b) => {
    const scopeDelta = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    if (scopeDelta !== 0) return scopeDelta;
    return b.priority - a.priority;
  });
  const top = ranked[0];
  if (top.canExecute) {
    return { state: "dispatch", ownerId: top.ownerId, actionId: top.actionId };
  }
  return {
    state: "blocked",
    reason: top.disabledReason ?? `${top.actionId} is not executable right now`,
    preventDefault: true,
  };
}

/** The shell chord shared by `workspace.reopenClosedTab` and new-terminal. */
export function isReopenTabChord(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  const primary = event.ctrlKey || event.metaKey;
  return primary && event.shiftKey && !event.altKey && event.key.toLowerCase() === "t";
}
