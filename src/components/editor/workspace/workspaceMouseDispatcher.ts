/**
 * Workspace mouse dispatcher (§8.19.2). A single workspace-root capture
 * listener resolves mouse shortcuts (button + click count + modifiers)
 * against the same ActionHost that owns keyboard dispatch. Only strokes that
 * match a registered, currently-available action are consumed; everything
 * else — including text selection and editing gestures — passes through
 * untouched, so the dispatcher can never swallow an unbound interaction.
 *
 * Ctrl/Cmd-click navigation (go-to-definition) is deliberately NOT routed
 * here: it is an lspNavigationExtensions platform gesture listed in
 * EDITOR_RETAINED_BINDING_ALLOWLIST rather than a second binding truth.
 */

import type { WorkspaceActionHost } from "./workspaceActionHost";
import { type Shortcut, type ShortcutStroke, strokesEqual } from "./workspaceKeymapScheme";

export interface AttachedMouseDispatcher {
  dispose(): void;
}

function modifiersOf(event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): Omit<ShortcutStroke, "code" | "key"> {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/**
 * Attach the dispatcher to a workspace root element. Returns a disposer that
 * removes both listeners; callers must invoke it on unmount so a remounted
 * workspace never keeps two dispatchers alive.
 */
export function attachWorkspaceMouseDispatcher(
  host: WorkspaceActionHost,
  root: HTMLElement,
): AttachedMouseDispatcher {
  const handle = (event: MouseEvent) => {
    if (host.isDisposed()) return;
    // Left button clicks only for now (schema supports other buttons once an
    // action actually registers one); dblclick supplies clickCount 2.
    if (event.button !== 0) return;
    const clickCount = event.type === "dblclick" ? 2 : 1;
    const modifiers = modifiersOf(event);
    const snapshot = host.getSnapshot({ kind: "snapshot", eventTarget: event.target });
    for (const item of snapshot) {
      if (item.state.availability !== "available") continue;
      const mouseMatch = host.effectiveShortcuts(item.id).shortcuts.find((shortcut): shortcut is Shortcut =>
        shortcut.kind === "mouse"
        && shortcut.button === 0
        && shortcut.clickCount === clickCount
        && strokesEqual(
          { code: "", ...shortcut.modifiers },
          { code: "", ...modifiers },
        ));
      if (!mouseMatch || mouseMatch.kind !== "mouse") continue;
      // Consume exactly one matching action per gesture.
      const evaluation = item.evaluation.state.availability === "available"
        ? item.evaluation
        : null;
      if (!evaluation) continue;
      event.preventDefault();
      event.stopPropagation();
      void host.executePrepared(evaluation);
      return;
    }
  };
  root.addEventListener("click", handle, true);
  root.addEventListener("dblclick", handle, true);
  return {
    dispose() {
      root.removeEventListener("click", handle, true);
      root.removeEventListener("dblclick", handle, true);
    },
  };
}
