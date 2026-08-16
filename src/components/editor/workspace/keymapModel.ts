/**
 * Keymap Scheme & Conflict Graph Model (E2.1 & E2.2).
 *
 * Implements IntelliJ IDEA platform default schemes, copy-on-write user custom schemes,
 * key recording / formatting, conflict graph analysis, and JSON import/export.
 */

import {
  DEFAULT_WORKSPACE_ACTIONS,
  type WorkspaceActionMetadata,
} from "./workspaceActionRegistry";
import { type KeyboardEventLike } from "./workspaceCommands";

export interface KeymapScheme {
  id: string;
  name: string;
  parentSchemeId?: string;
  platform: "macos" | "windows" | "linux" | "all";
  bindings: Record<string, string[]>; // actionId -> array of keybinding strings
  disabledActions: string[];
  metadata?: Record<string, unknown>;
  isBuiltin: boolean;
  version: number;
}

export interface KeybindingConflict {
  keybinding: string;
  actionIds: string[];
  actionTitles: string[];
  contexts: string[];
  hasConflict: boolean;
}

/**
 * Built-in default schemes for macOS, Windows, and Linux.
 */
export function createDefaultIdeaScheme(
  platform: "macos" | "windows" | "linux" = "windows",
): KeymapScheme {
  const bindings: Record<string, string[]> = {};

  for (const action of DEFAULT_WORKSPACE_ACTIONS) {
    const list: string[] = [];
    if (typeof action.keybinding === "string") {
      list.push(action.keybinding);
    } else if (action.keybinding && typeof action.keybinding === "object") {
      const platKey = action.keybinding[platform] ?? action.keybinding.default;
      if (platKey) list.push(platKey);
    }
    if (action.secondaryKeybindings) {
      list.push(...action.secondaryKeybindings);
    }
    if (list.length > 0) {
      bindings[action.id] = list;
    }
  }

  const name =
    platform === "macos"
      ? "macOS (IntelliJ IDEA Classic)"
      : platform === "linux"
        ? "Linux (IntelliJ IDEA Default)"
        : "Windows (IntelliJ IDEA Default)";

  return {
    id: `idea-default-${platform}`,
    name,
    platform,
    bindings,
    disabledActions: [],
    isBuiltin: true,
    version: 1,
  };
}

/**
 * Create a custom copy-on-write user keymap scheme based on a parent scheme.
 */
export function createUserKeymapScheme(
  parentScheme: KeymapScheme,
  name: string = `${parentScheme.name} (Custom)`,
): KeymapScheme {
  return {
    id: `user-scheme-${Date.now()}`,
    name,
    parentSchemeId: parentScheme.id,
    platform: parentScheme.platform,
    bindings: JSON.parse(JSON.stringify(parentScheme.bindings)),
    disabledActions: [...parentScheme.disabledActions],
    isBuiltin: false,
    version: 1,
  };
}

/**
 * Format a keyboard event into a standardized keybinding string (e.g. "Ctrl+Alt+S", "Ctrl+Shift+F10").
 */
export function formatKeyboardEventToKeybinding(event: KeyboardEventLike): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Cmd");

  let key = event.key;
  if (key === " " || key === "Spacebar") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith("Arrow")) key = key.replace("Arrow", "");

  parts.push(key);
  return parts.join("+");
}

/**
 * Detect keybinding conflicts within a keymap scheme.
 */
export function detectKeybindingConflicts(
  scheme: KeymapScheme,
  actionCatalog: WorkspaceActionMetadata[] = DEFAULT_WORKSPACE_ACTIONS,
): KeybindingConflict[] {
  const bindingToActionMap = new Map<string, string[]>();

  for (const [actionId, keybindings] of Object.entries(scheme.bindings)) {
    if (scheme.disabledActions.includes(actionId)) continue;
    for (const kb of keybindings) {
      const normalized = kb.trim().toLowerCase();
      const existing = bindingToActionMap.get(normalized) ?? [];
      if (!existing.includes(actionId)) {
        existing.push(actionId);
      }
      bindingToActionMap.set(normalized, existing);
    }
  }

  const conflicts: KeybindingConflict[] = [];
  const actionMap = new Map(actionCatalog.map((a) => [a.id, a]));

  for (const [keybinding, actionIds] of bindingToActionMap.entries()) {
    if (actionIds.length > 1) {
      const titles = actionIds.map((id) => actionMap.get(id)?.title ?? id);
      const contexts = actionIds.map((id) => {
        const when = actionMap.get(id)?.when;
        return typeof when === "string" ? when : "default";
      });

      conflicts.push({
        keybinding,
        actionIds,
        actionTitles: titles,
        contexts,
        hasConflict: true,
      });
    }
  }

  return conflicts;
}

/**
 * Export keymap scheme to JSON string.
 */
export function exportKeymapSchemeToJson(scheme: KeymapScheme): string {
  return JSON.stringify(scheme, null, 2);
}

/**
 * Import keymap scheme from JSON string with validation.
 */
export function importKeymapSchemeFromJson(jsonStr: string): KeymapScheme {
  const parsed = JSON.parse(jsonStr);
  if (!parsed || typeof parsed !== "object" || !parsed.id || !parsed.name || !parsed.bindings) {
    throw new Error("Invalid KeymapScheme JSON structure.");
  }
  return {
    id: `imported-${Date.now()}`,
    name: String(parsed.name),
    parentSchemeId: parsed.parentSchemeId ? String(parsed.parentSchemeId) : undefined,
    platform: parsed.platform ?? "all",
    bindings: parsed.bindings ?? {},
    disabledActions: Array.isArray(parsed.disabledActions) ? parsed.disabledActions : [],
    isBuiltin: false,
    version: Number(parsed.version) || 1,
  };
}
