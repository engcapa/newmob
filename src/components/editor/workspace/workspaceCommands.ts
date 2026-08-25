import type {
  ActionCategory,
  ActionProvenance,
  ActionResult,
  WorkspaceActionContext,
  WorkspaceActionDefinition,
  WorkspaceFocus,
} from "./workspaceActionRegistry";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import type { ShellShortcutClaim } from "./shellShortcutRouter";

export type WorkspaceCommandFocus = WorkspaceFocus;

export interface WorkspaceCommandContext extends WorkspaceActionContext {
  focus: WorkspaceCommandFocus;
  /** Optional caller-specific target (for example a tree selection or directory). */
  payload?: unknown;
}

export interface WorkspaceCommand {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  keybindings?: string[];
  keywords?: string[];
  provenance?: ActionProvenance;
  when?: (context: WorkspaceCommandContext) => boolean;
  run: (context: WorkspaceCommandContext) => void | boolean | Promise<void | boolean>;
}

export interface WorkspaceCommandMenuItem {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  enabled: boolean;
  provenance?: ActionProvenance;
}

export interface WorkspaceCommandRegistration {
  /** Snapshot-derived menu projection for compatibility surfaces. */
  items: WorkspaceCommandMenuItem[];
  /** The complete immutable instance-scoped action truth. */
  snapshot: readonly ActionSnapshotItem[];
  /** Typed execution through the owning WorkspaceActionHost. */
  executeAction: (commandId: string, payload?: unknown, signal?: AbortSignal) => Promise<ActionResult>;
  /** Deprecated synchronous adapter for legacy callers; result is intentionally not the truth. */
  execute: (commandId: string, payload?: unknown) => boolean;
  /**
   * W0 §8.20.1: chords this instance claims from the shell router while it is
   * the active workspace (e.g. Ctrl+Shift+T → workspace.reopenClosedTab when
   * the reopen stack is non-empty). Absent/empty = the instance makes no
   * shell claim and the chord falls through to the shell owner.
   */
  shellShortcutClaims?: readonly ShellShortcutClaim[];
}

export interface KeyboardEventLike {
  key: string;
  /** Physical key code (e.g. ArrowLeft); used when `key` is unreliable under Alt. */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** True while an IME composition is in flight (§8.19.2 dispatch gate). */
  isComposing?: boolean;
  /** Modifier-state probe used for AltGraph detection when provided. */
  getModifierState?: (key: string) => boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface ParsedKeybinding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export function normalizeKey(value: string): string {
  const key = value.toLowerCase();
  if (key === "left") return "arrowleft";
  if (key === "right") return "arrowright";
  if (key === "up") return "arrowup";
  if (key === "down") return "arrowdown";
  return key;
}

/**
 * Resolve the logical key for a keyboard event.
 * Prefer `event.key`, but fall back to `event.code` when Alt/Ctrl combinations
 * on Windows WebView2 yield an empty or non-arrow `key` for ArrowLeft/Right.
 */
export function eventLogicalKey(
  event: Pick<KeyboardEventLike, "key"> & { code?: string },
): string {
  const rawKey = (event.key ?? "").trim();
  const code = event.code ?? "";
  // Numpad operators report printable symbols in `key`, which cannot identify
  // the documented IDE binding. Preserve their physical key identity.
  if (code.startsWith("Numpad") && code.length > 6) {
    return normalizeKey(code);
  }
  if (rawKey && rawKey !== "Unidentified" && rawKey !== "Process") {
    const normalized = normalizeKey(rawKey);
    // Single printable keys and named keys (ArrowLeft, F12, …).
    if (normalized.length > 0) return normalized;
  }
  if (!code) return normalizeKey(rawKey);
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5).toLowerCase();
  return normalizeKey(code);
}

export function parseKeybinding(value: string): ParsedKeybinding | null {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  return {
    key: normalizeKey(parts[parts.length - 1]),
    ctrl: modifiers.has("ctrl"),
    shift: modifiers.has("shift"),
    alt: modifiers.has("alt"),
    meta: modifiers.has("meta") || modifiers.has("cmd"),
  };
}

export function workspaceCommandEnabled(
  command: WorkspaceCommand,
  context: WorkspaceCommandContext,
): boolean {
  return command.when?.(context) ?? true;
}

export function workspaceCommandMatchesKeybinding(
  command: WorkspaceCommand,
  event: Pick<KeyboardEventLike, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"> & {
    code?: string;
  },
): boolean {
  const bindings = [command.keybinding, ...(command.keybindings ?? [])].filter((value): value is string => !!value);
  const eventKey = eventLogicalKey(event);
  return bindings.some((value) => {
    const binding = parseKeybinding(value);
    return !!binding
      && binding.key === eventKey
      && binding.ctrl === event.ctrlKey
      && binding.shift === event.shiftKey
      && binding.alt === event.altKey
      && binding.meta === event.metaKey;
  });
}

/**
 * Adapter converting WorkspaceCommand to WorkspaceActionDefinition for registration.
 */
export function workspaceCommandToActionDefinition(
  cmd: WorkspaceCommand,
): WorkspaceActionDefinition {
  return {
    id: cmd.id,
    title: cmd.title,
    category: (cmd.category as ActionCategory) || "Edit",
    keywords: cmd.keywords,
    keybinding: cmd.keybinding,
    secondaryKeybindings: cmd.keybindings,
    provenance: cmd.provenance ?? "local",
    when: cmd.when,
    run: async (ctx) => {
      const result = await cmd.run(ctx as WorkspaceCommandContext);
      return result === false
        ? { kind: "no-op", reason: "condition-not-met" }
        : { kind: "applied" };
    },
  };
}
