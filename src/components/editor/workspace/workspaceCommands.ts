export type WorkspaceCommandFocus = "workspace" | "editor" | "tree" | "terminal";

export interface WorkspaceCommandContext {
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
  when?: (context: WorkspaceCommandContext) => boolean;
  run: (context: WorkspaceCommandContext) => void | Promise<void>;
}

export interface WorkspaceCommandMenuItem {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  enabled: boolean;
}

export interface WorkspaceCommandRegistration {
  items: WorkspaceCommandMenuItem[];
  execute: (commandId: string) => boolean;
}

interface KeyboardEventLike {
  key: string;
  /** Physical key code (e.g. ArrowLeft); used when `key` is unreliable under Alt. */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface ParsedKeybinding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

function normalizeKey(value: string): string {
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
  if (rawKey && rawKey !== "Unidentified" && rawKey !== "Process") {
    const normalized = normalizeKey(rawKey);
    // Single printable keys and named keys (ArrowLeft, F12, …).
    if (normalized.length > 0) return normalized;
  }
  const code = event.code ?? "";
  if (!code) return normalizeKey(rawKey);
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5).toLowerCase();
  if (code.startsWith("Numpad") && code.length > 6) return normalizeKey(code.slice(6));
  return normalizeKey(code);
}

function parseKeybinding(value: string): ParsedKeybinding | null {
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

export function dispatchWorkspaceCommandKeydown(
  commands: readonly WorkspaceCommand[],
  context: WorkspaceCommandContext,
  event: KeyboardEventLike,
): WorkspaceCommand | null {
  const command = commands.find((candidate) => (
    workspaceCommandEnabled(candidate, context)
    && workspaceCommandMatchesKeybinding(candidate, event)
  ));
  if (!command) return null;
  event.preventDefault();
  event.stopPropagation();
  void command.run(context);
  return command;
}

export function runWorkspaceCommand(
  commands: readonly WorkspaceCommand[],
  id: string,
  context: WorkspaceCommandContext,
): boolean {
  const command = commands.find((candidate) => candidate.id === id);
  if (!command || !workspaceCommandEnabled(command, context)) return false;
  void command.run(context);
  return true;
}

export function workspaceCommandMenuItems(
  commands: readonly WorkspaceCommand[],
  context: WorkspaceCommandContext,
): WorkspaceCommandMenuItem[] {
  return commands.map((command) => ({
    id: command.id,
    title: command.title,
    category: command.category,
    keybinding: command.keybinding,
    enabled: workspaceCommandEnabled(command, context),
  }));
}
