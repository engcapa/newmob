/**
 * Unified Workspace Action Registry (E0.1 & E0.3).
 *
 * Consolidates actions from Editor, Navigation, Refactoring, Run, Debug, View, File, Git, and Tools
 * into a single queryable metadata & execution model with structured when-contexts, provenance,
 * alias resolution, state tracking, and execution handlers.
 */

import type { EditorView } from "@codemirror/view";

export type ActionCategory =
  | "Edit"
  | "Navigate"
  | "Navigation"
  | "Refactor"
  | "Run"
  | "Build"
  | "Debug"
  | "Analyze"
  | "View"
  | "File"
  | "Git"
  | "Help"
  | "Search";

export type ActionProvenance =
  | "local"        // Implemented natively in client editor/workspace
  | "index"        // Powered by local semantic index
  | "provider"     // Delegated to external Language Server / DAP / Toolchain
  | "partial"      // Partially implemented / heuristic
  | "unsupported"; // Action placeholder / unsupported in current context

export type ActionAvailability = "available" | "disabled" | "unsupported" | "stale" | "busy";

export type ActionDisabledReason =
  | "noEditor"
  | "noSelection"
  | "readOnly"
  | "capability"
  | "providerOffline"
  | "stale"
  | "conflict"
  | "busy"
  | "disposed"
  | "invalidCondition"
  | "userDisabled"
  | "unsupported"
  | (string & {});

export interface ActionPlatformKeybindings {
  macos?: string;
  windows?: string;
  linux?: string;
  default: string;
}

export type WorkspaceFocus =
  | "workspace"
  | "editor"
  | "tree"
  | "terminal"
  | "search"
  | "completion"
  | "snippet"
  | "modal";

export interface WorkspaceActionContext {
  focus: WorkspaceFocus;
  /** Live editor view when the context carries editor focus (§8.19.2). */
  editorView?: EditorView;
  hasActiveFile?: boolean;
  hasSelection?: boolean;
  isDirty?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  splitActive?: boolean;
  debugActive?: boolean;
  modalOpen?: boolean;
  readOnly?: boolean;
  languageId?: string;
  activeCapabilities?: Record<string, boolean>;
  payload?: unknown;
  [key: string]: unknown;
}

export type WhenExpr =
  | { type: "all"; exprs: WhenExpr[] }
  | { type: "any"; exprs: WhenExpr[] }
  | { type: "not"; expr: WhenExpr }
  | { type: "focusIs"; target: WorkspaceFocus }
  | { type: "hasSelection" }
  | { type: "hasActiveFile" }
  | { type: "isDirty" }
  | { type: "canUndo" }
  | { type: "canRedo" }
  | { type: "splitActive" }
  | { type: "debugActive" }
  | { type: "modalOpen" }
  | { type: "readOnly"; value?: boolean }
  | { type: "capability"; name: string }
  | { type: "languageIs"; languageId: string }
  | { type: "custom"; predicate: (context: WorkspaceActionContext) => boolean };

/**
 * Compile a structured WhenExpr, string expression, or predicate function into a runtime predicate.
 */
export function compileWhenExpr(
  when?: string | WhenExpr | ((context: WorkspaceActionContext) => boolean),
): (context: WorkspaceActionContext) => boolean {
  if (!when) return () => true;
  if (typeof when === "function") return when;
  if (typeof when === "object") {
    return evaluateWhenExpr(when);
  }

  // Parse string expression
  const str = when.trim();
  if (!str) return () => true;

  // Handle simple logical combinations: "a && b", "a || b", "!a"
  if (str.includes("&&")) {
    const parts = str.split("&&").map((p) => compileWhenExpr(p.trim()));
    return (ctx) => parts.every((p) => p(ctx));
  }
  if (str.includes("||")) {
    const parts = str.split("||").map((p) => compileWhenExpr(p.trim()));
    return (ctx) => parts.some((p) => p(ctx));
  }
  if (str.startsWith("!")) {
    const inner = compileWhenExpr(str.slice(1).trim());
    return (ctx) => !inner(ctx);
  }

  // Predefined context string aliases
  switch (str) {
    case "editorTextFocus":
    case "editorFocus":
      return (ctx) => ctx.focus === "editor";
    case "treeFocus":
      return (ctx) => ctx.focus === "tree";
    case "terminalFocus":
      return (ctx) => ctx.focus === "terminal";
    case "editorHasSelection":
    case "hasSelection":
      return (ctx) => Boolean(ctx.hasSelection);
    case "hasActiveFile":
      return (ctx) => Boolean(ctx.hasActiveFile);
    case "isDirty":
      return (ctx) => Boolean(ctx.isDirty);
    case "canUndo":
      return (ctx) => Boolean(ctx.canUndo);
    case "canRedo":
      return (ctx) => Boolean(ctx.canRedo);
    case "splitActive":
      return (ctx) => Boolean(ctx.splitActive);
    case "debugActive":
      return (ctx) => Boolean(ctx.debugActive);
    case "modalOpen":
      return (ctx) => Boolean(ctx.modalOpen);
    case "readOnly":
      return (ctx) => Boolean(ctx.readOnly);
    default:
      return (ctx) => Boolean(ctx[str]);
  }
}

function evaluateWhenExpr(expr: WhenExpr): (context: WorkspaceActionContext) => boolean {
  switch (expr.type) {
    case "all": {
      const compiled = expr.exprs.map(evaluateWhenExpr);
      return (ctx) => compiled.every((c) => c(ctx));
    }
    case "any": {
      const compiled = expr.exprs.map(evaluateWhenExpr);
      return (ctx) => compiled.some((c) => c(ctx));
    }
    case "not": {
      const inner = evaluateWhenExpr(expr.expr);
      return (ctx) => !inner(ctx);
    }
    case "focusIs":
      return (ctx) => ctx.focus === expr.target;
    case "hasSelection":
      return (ctx) => Boolean(ctx.hasSelection);
    case "hasActiveFile":
      return (ctx) => Boolean(ctx.hasActiveFile);
    case "isDirty":
      return (ctx) => Boolean(ctx.isDirty);
    case "canUndo":
      return (ctx) => Boolean(ctx.canUndo);
    case "canRedo":
      return (ctx) => Boolean(ctx.canRedo);
    case "splitActive":
      return (ctx) => Boolean(ctx.splitActive);
    case "debugActive":
      return (ctx) => Boolean(ctx.debugActive);
    case "modalOpen":
      return (ctx) => Boolean(ctx.modalOpen);
    case "readOnly":
      return (ctx) => ctx.readOnly === (expr.value ?? true);
    case "capability":
      return (ctx) => Boolean(ctx.activeCapabilities?.[expr.name]);
    case "languageIs":
      return (ctx) => ctx.languageId === expr.languageId;
    case "custom":
      return expr.predicate;
  }
}

export interface ActionState {
  availability: ActionAvailability;
  disabledReason?: ActionDisabledReason;
  source: ActionProvenance;
  scope: "editor" | "file" | "workspace" | "session";
  freshness: "current" | "stale" | "unknown";
  completeness: "complete" | "truncated" | "partial" | "unavailable" | "failed";
}

export type ActionResultReason =
  | "aborted"
  | "busy"
  | "condition-not-met"
  | "disabled"
  | "disposed"
  | "exception"
  | "stale-owner"
  | "unknown-action"
  | "unsupported";

export interface ActionResult {
  kind: "applied" | "opened" | "no-op" | "cancelled" | "failed";
  reason?: ActionResultReason;
  undoGroupId?: string;
  message?: string;
  retryable?: boolean;
}

export interface WorkspaceActionMetadata {
  id: string;
  title: string;
  description?: string;
  category: ActionCategory;
  keybinding?: string | ActionPlatformKeybindings;
  secondaryKeybindings?: string[];
  when?: string | WhenExpr | ((context: WorkspaceActionContext) => boolean);
  provenance: ActionProvenance;
  capabilityRequirement?: string;
  keywords?: string[];
}

export interface WorkspaceActionDefinition<Ctx = WorkspaceActionContext> extends WorkspaceActionMetadata {
  getState?: (context: Ctx) => ActionState;
  run: (context: Ctx, signal?: AbortSignal) => void | Promise<ActionResult | void> | ActionResult;
  isEnabled?: (context: Ctx) => boolean;
}

export type ActionRegistryEventType = "registered" | "unregistered" | "state-changed";

export interface ActionRegistryEvent {
  type: ActionRegistryEventType;
  actionId?: string;
}

class ActionRegistry {
  private actions = new Map<string, WorkspaceActionDefinition>();
  private actionStacks = new Map<string, WorkspaceActionDefinition[]>();
  private aliases = new Map<string, string>();
  private listeners = new Set<(event: ActionRegistryEvent) => void>();

  constructor() {
    this.setupDefaultAliases();
  }

  private setupDefaultAliases(): void {
    this.aliases.set("workspace.formatDocument", "workspace.format");
    this.aliases.set("workspace.nextDiagnostic", "workspace.nextError");
    this.aliases.set("workspace.prevDiagnostic", "workspace.prevError");
    this.aliases.set("workspace.quickDefinitionPeek", "workspace.quickDefinition");
    this.aliases.set("workspace.rename", "workspace.renameSymbol");
    this.aliases.set("workspace.safeDelete", "workspace.safeDeleteSymbol");
  }

  registerAlias(aliasId: string, targetId: string): void {
    this.aliases.set(aliasId, targetId);
  }

  resolveId(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  register(action: WorkspaceActionDefinition): () => void {
    const resolvedId = action.id;
    let stack = this.actionStacks.get(resolvedId);
    if (!stack) {
      stack = [];
      this.actionStacks.set(resolvedId, stack);
    }
    stack.push(action);
    this.actions.set(resolvedId, action);
    this.notify({ type: "registered", actionId: resolvedId });
    return () => {
      const currentStack = this.actionStacks.get(resolvedId);
      if (currentStack) {
        const index = currentStack.indexOf(action);
        if (index !== -1) {
          currentStack.splice(index, 1);
        }
        if (currentStack.length > 0) {
          const restored = currentStack[currentStack.length - 1];
          this.actions.set(resolvedId, restored);
          this.notify({ type: "registered", actionId: resolvedId });
          this.notify({ type: "state-changed", actionId: resolvedId });
        } else {
          this.actionStacks.delete(resolvedId);
          this.actions.delete(resolvedId);
          this.notify({ type: "unregistered", actionId: resolvedId });
        }
      } else if (this.actions.get(resolvedId) === action) {
        this.actions.delete(resolvedId);
        this.notify({ type: "unregistered", actionId: resolvedId });
      }
    };
  }

  get(id: string): WorkspaceActionDefinition | undefined {
    const resolved = this.resolveId(id);
    return this.actions.get(resolved) ?? this.actions.get(id);
  }

  getAll(): WorkspaceActionDefinition[] {
    return Array.from(this.actions.values());
  }

  getByCategory(category: ActionCategory): WorkspaceActionDefinition[] {
    return this.getAll().filter((a) => a.category === category);
  }

  getState(id: string, context: WorkspaceActionContext): ActionState {
    const action = this.get(id);
    if (!action) {
      return {
        availability: "unsupported",
        disabledReason: "unsupported",
        source: "unsupported",
        scope: "workspace",
        freshness: "unknown",
        completeness: "unavailable",
      };
    }
    if (action.getState) {
      return action.getState(context);
    }
    const compiledWhen = compileWhenExpr(action.when);
    const enabled = (action.isEnabled ? action.isEnabled(context) : true) && compiledWhen(context);
    return {
      availability: enabled ? "available" : "disabled",
      disabledReason: enabled ? undefined : (context.readOnly ? "readOnly" : (!context.hasActiveFile ? "noEditor" : "conflict")),
      source: action.provenance,
      scope: "workspace",
      freshness: "current",
      completeness: action.provenance === "unsupported" ? "unavailable" : "complete",
    };
  }

  async run(id: string, context: WorkspaceActionContext, signal?: AbortSignal): Promise<ActionResult> {
    const action = this.get(id);
    if (!action) {
      return { kind: "failed", message: `Action "${id}" not found` };
    }
    const state = this.getState(id, context);
    if (state.availability === "disabled" || state.availability === "unsupported") {
      return { kind: "no-op", message: `Action "${id}" is ${state.availability} (${state.disabledReason ?? "context blocked"})` };
    }
    try {
      this.notify({ type: "state-changed", actionId: action.id });
      const result = await action.run(context, signal);
      if (result && typeof result === "object" && "kind" in result) {
        return result;
      }
      return { kind: "applied" };
    } catch (err) {
      return {
        kind: "failed",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }

  search(query: string, context?: WorkspaceActionContext): WorkspaceActionDefinition[] {
    const q = query.trim().toLowerCase();
    const all = this.getAll();
    if (!q) {
      if (!context) return all;
      return all.filter((a) => {
        const when = compileWhenExpr(a.when);
        return when(context);
      });
    }
    return all.filter((a) => {
      const aliasTarget = this.resolveId(a.id);
      if (a.id.toLowerCase().includes(q) || aliasTarget.toLowerCase().includes(q)) return true;
      if (a.title.toLowerCase().includes(q)) return true;
      if (a.category.toLowerCase().includes(q)) return true;
      if (a.description?.toLowerCase().includes(q)) return true;
      if (a.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      const kb = typeof a.keybinding === "string" ? a.keybinding : a.keybinding?.default;
      if (kb && kb.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  subscribe(listener: (event: ActionRegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(event: ActionRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("ActionRegistry listener error:", e);
      }
    }
  }

  clear(): void {
    this.actions.clear();
    this.actionStacks.clear();
    this.setupDefaultAliases();
    this.notify({ type: "state-changed" });
  }
}

export const workspaceActionRegistry = new ActionRegistry();

/**
 * Standard default action catalog for Code Workspace.
 * Comprehensive catalog of all standard IntelliJ IDEA and Taomni editing actions.
 */
export const DEFAULT_WORKSPACE_ACTIONS: WorkspaceActionMetadata[] = [
  // --- Editor Movement & Virtual Space ---
  {
    id: "editor.moveUp",
    title: "Up",
    description: "Move caret up one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "ArrowUp",
    provenance: "local",
    keywords: ["up", "cursor", "line", "virtual space"],
  },
  {
    id: "editor.moveDown",
    title: "Down",
    description: "Move caret down one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "ArrowDown",
    provenance: "local",
    keywords: ["down", "cursor", "line", "virtual space"],
  },
  {
    id: "editor.selectUp",
    title: "Select Up",
    description: "Extend selection up one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "Shift+ArrowUp",
    provenance: "local",
    keywords: ["up", "select", "virtual space"],
  },
  {
    id: "editor.selectDown",
    title: "Select Down",
    description: "Extend selection down one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "Shift+ArrowDown",
    provenance: "local",
    keywords: ["down", "select", "virtual space"],
  },
  {
    id: "editor.pageUp",
    title: "Page Up",
    description: "Move caret up one page",
    category: "Navigate",
    keybinding: "PageUp",
    provenance: "local",
    keywords: ["page", "up", "scroll", "virtual space"],
  },
  {
    id: "editor.selectPageUp",
    title: "Select Page Up",
    description: "Extend selection up one page",
    category: "Navigate",
    keybinding: "Shift+PageUp",
    provenance: "local",
    keywords: ["page", "up", "select", "virtual space"],
  },
  {
    id: "editor.pageDown",
    title: "Page Down",
    description: "Move caret down one page",
    category: "Navigate",
    keybinding: "PageDown",
    provenance: "local",
    keywords: ["page", "down", "scroll", "virtual space"],
  },
  {
    id: "editor.selectPageDown",
    title: "Select Page Down",
    description: "Extend selection down one page",
    category: "Navigate",
    keybinding: "Shift+PageDown",
    provenance: "local",
    keywords: ["page", "down", "select", "virtual space"],
  },
  {
    id: "editor.moveLeft",
    title: "Left",
    description: "Move caret left",
    category: "Navigate",
    keybinding: "ArrowLeft",
    provenance: "local",
    keywords: ["left", "cursor", "virtual space"],
  },
  {
    id: "editor.selectLeft",
    title: "Select Left",
    description: "Extend selection left",
    category: "Navigate",
    keybinding: "Shift+ArrowLeft",
    provenance: "local",
    keywords: ["left", "select", "virtual space"],
  },
  {
    id: "editor.moveRight",
    title: "Right",
    description: "Move caret right",
    category: "Navigate",
    keybinding: "ArrowRight",
    provenance: "local",
    keywords: ["right", "cursor", "virtual space"],
  },
  {
    id: "editor.selectRight",
    title: "Select Right",
    description: "Extend selection right",
    category: "Navigate",
    keybinding: "Shift+ArrowRight",
    provenance: "local",
    keywords: ["right", "select", "virtual space"],
  },
  {
    id: "editor.moveToLineStart",
    title: "Move to Line Start",
    description: "Move caret to line start",
    category: "Navigate",
    keybinding: "Home",
    provenance: "local",
    keywords: ["home", "start", "line"],
  },
  {
    id: "editor.moveToLineEnd",
    title: "Move to Line End",
    description: "Move caret to line end or past EOL in virtual space",
    category: "Navigate",
    keybinding: "End",
    provenance: "local",
    keywords: ["end", "line", "virtual space"],
  },
  {
    id: "editor.selectToLineEnd",
    title: "Select to Line End",
    description: "Extend selection to line end or past EOL in virtual space",
    category: "Navigate",
    keybinding: "Shift+End",
    provenance: "local",
    keywords: ["end", "line", "select", "virtual space"],
  },
  {
    id: "editor.deleteBackward",
    title: "Delete Backward",
    description: "Delete previous character or virtual column",
    category: "Edit",
    keybinding: "Backspace",
    provenance: "local",
    keywords: ["backspace", "delete", "virtual space"],
  },
  {
    id: "editor.deleteForward",
    title: "Delete Forward",
    description: "Delete next character or collapse virtual column",
    category: "Edit",
    keybinding: "Delete",
    provenance: "local",
    keywords: ["delete", "forward", "virtual space"],
  },
  {
    id: "editor.insertNewline",
    title: "Insert Newline",
    description: "Insert newline, materializing virtual space if active",
    category: "Edit",
    keybinding: "Enter",
    provenance: "local",
    keywords: ["enter", "newline", "virtual space"],
  },
  {
    id: "editor.insertTab",
    title: "Insert Tab",
    description: "Insert tab or snap to next tab stop in virtual space",
    category: "Edit",
    keybinding: "Tab",
    provenance: "local",
    keywords: ["tab", "indent", "virtual space"],
  },

  // --- Edit ---
  {
    id: "workspace.toggleCase",
    title: "Toggle Case",
    description: "Cycle uppercase, lowercase, and camelCase for selection or word under cursor",
    category: "Edit",
    keybinding: "Ctrl+Shift+U",
    provenance: "local",
    keywords: ["case", "uppercase", "lowercase", "capitalize", "toggle case"],
  },
  {
    id: "workspace.joinLines",
    title: "Join Lines",
    description: "Join lines in the selection into a single line",
    category: "Edit",
    keybinding: "Ctrl+Shift+J",
    provenance: "local",
    keywords: ["join", "merge", "lines"],
  },
  {
    id: "workspace.sortLines",
    title: "Sort Lines",
    description: "Sort selected lines alphabetically",
    category: "Edit",
    provenance: "local",
    keywords: ["sort", "alphabetical", "lines", "order"],
  },
  {
    id: "workspace.reverseLines",
    title: "Reverse Lines",
    description: "Reverse the order of selected lines",
    category: "Edit",
    provenance: "local",
    keywords: ["reverse", "lines", "flip", "order"],
  },
  {
    id: "workspace.transpose",
    title: "Transpose Lines / Characters",
    description: "Transpose characters at cursor or swap current line with next line",
    category: "Edit",
    keybinding: "Ctrl+T",
    provenance: "local",
    keywords: ["transpose", "swap", "lines", "characters"],
  },
  {
    id: "workspace.unwrap",
    title: "Unwrap / Remove Enclosing Construct",
    description: "Unwrap enclosing parentheses, braces, brackets, or quotes around cursor",
    category: "Edit",
    keybinding: "Ctrl+Shift+Delete",
    provenance: "local",
    keywords: ["unwrap", "remove", "parentheses", "braces", "quotes"],
  },
  {
    id: "workspace.format",
    title: "Reformat Code",
    description: "Format active document or selection using effective code style and language formatter",
    category: "Edit",
    keybinding: "Ctrl+Alt+L",
    provenance: "provider",
    keywords: ["format", "reformat", "indent", "prettify", "style"],
  },
  {
    id: "workspace.formatDocument",
    title: "Reformat Code (Alias)",
    description: "Alias for workspace.format",
    category: "Edit",
    keybinding: "Ctrl+Alt+L",
    provenance: "provider",
    keywords: ["format", "reformat", "indent", "prettify"],
  },
  {
    id: "workspace.toggleFormatOnSave",
    title: "Toggle Format on Save",
    description: "Automatically format file when saving",
    category: "Edit",
    provenance: "local",
    keywords: ["format", "save", "auto format"],
  },
  {
    id: "workspace.optimizeImports",
    title: "Optimize Imports",
    description: "Organize and clean up unused import statements",
    category: "Edit",
    keybinding: "Ctrl+Alt+O",
    provenance: "provider",
    keywords: ["import", "organize", "unused"],
  },
  {
    id: "workspace.parameterInfo",
    title: "Parameter Info",
    description: "Show active method or function signature and parameters",
    category: "Edit",
    keybinding: "Ctrl+P",
    secondaryKeybindings: ["Ctrl+Shift+Space"],
    provenance: "provider",
    keywords: ["parameter", "signature", "arguments", "help"],
  },
  {
    id: "workspace.completeCurrentStatement",
    title: "Complete Current Statement",
    description: "Insert missing semicolons, closing brackets, or block braces",
    category: "Edit",
    keybinding: "Ctrl+Shift+Enter",
    provenance: "partial",
    keywords: ["statement", "semicolon", "brace", "complete"],
  },
  {
    id: "workspace.undoWorkspaceEdit",
    title: "Undo Workspace Edit",
    description: "Undo multi-file refactoring transaction",
    category: "Edit",
    keybinding: "Ctrl+Z",
    provenance: "local",
    keywords: ["undo", "transaction", "rollback"],
  },
  {
    id: "workspace.redoWorkspaceEdit",
    title: "Redo Workspace Edit",
    description: "Redo multi-file refactoring transaction",
    category: "Edit",
    keybinding: "Ctrl+Shift+Z",
    provenance: "local",
    keywords: ["redo", "transaction"],
  },

  // --- Navigate ---
  {
    id: "workspace.goToFile",
    title: "Go to File",
    description: "Find and open any file in the workspace",
    category: "Navigate",
    keybinding: "Ctrl+Shift+N",
    provenance: "local",
    keywords: ["file", "open", "find", "search"],
  },
  {
    id: "workspace.goToClass",
    title: "Go to Class",
    description: "Find and jump to class, interface, enum, or struct definition",
    category: "Navigate",
    keybinding: "Ctrl+N",
    provenance: "provider",
    keywords: ["class", "type", "interface", "struct", "enum"],
  },
  {
    id: "workspace.goToSymbol",
    title: "Go to Symbol",
    description: "Search workspace symbols across all indexed files",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Shift+N",
    provenance: "provider",
    keywords: ["symbol", "function", "method", "variable", "field"],
  },
  {
    id: "workspace.searchEverywhere",
    title: "Search Everywhere",
    description: "Search all files, classes, symbols, and actions across the workspace",
    category: "Navigate",
    keybinding: "Shift+Shift",
    provenance: "local",
    keywords: ["search", "find", "everywhere", "symbol", "double shift"],
  },
  {
    id: "workspace.recentFiles",
    title: "Recent Files",
    description: "List recently opened files and switch with rapid navigation",
    category: "Navigate",
    keybinding: "Ctrl+E",
    provenance: "local",
    keywords: ["recent", "switcher", "history", "files"],
  },
  {
    id: "workspace.recentLocations",
    title: "Recent Locations",
    description: "Navigate to recently visited and edited code positions with context preview",
    category: "Navigate",
    keybinding: "Ctrl+Shift+E",
    provenance: "local",
    keywords: ["recent", "locations", "context", "history", "edit"],
  },
  {
    id: "workspace.recentChangedFiles",
    title: "Recently Changed Files",
    description: "Navigate to recently modified locations with context preview",
    category: "Navigate",
    keybinding: "Ctrl+Shift+E",
    provenance: "local",
    keywords: ["recent", "changed", "modified", "history"],
  },
  {
    id: "workspace.lastEditLocation",
    title: "Last Edit Location",
    description: "Jump to the previous edit position in the editor",
    category: "Navigate",
    keybinding: "Ctrl+Shift+Backspace",
    provenance: "local",
    keywords: ["last", "edit", "location", "cursor", "back"],
  },
  {
    id: "workspace.nextError",
    title: "Next Highlighted Error",
    description: "Navigate to the next error or warning in the active file",
    category: "Navigate",
    keybinding: "F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "next"],
  },
  {
    id: "workspace.nextDiagnostic",
    title: "Next Highlighted Error (Alias)",
    description: "Alias for workspace.nextError",
    category: "Navigate",
    keybinding: "F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "next"],
  },
  {
    id: "workspace.prevError",
    title: "Previous Highlighted Error",
    description: "Navigate to the previous error or warning in the active file",
    category: "Navigate",
    keybinding: "Shift+F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "prev"],
  },
  {
    id: "workspace.prevDiagnostic",
    title: "Previous Highlighted Error (Alias)",
    description: "Alias for workspace.prevError",
    category: "Navigate",
    keybinding: "Shift+F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "prev"],
  },
  {
    id: "workspace.quickDefinition",
    title: "Quick Definition Peek",
    description: "Preview symbol definition inline without losing editor focus",
    category: "Navigate",
    keybinding: "Ctrl+Shift+I",
    provenance: "provider",
    keywords: ["definition", "peek", "preview", "quick"],
  },
  {
    id: "workspace.quickDefinitionPeek",
    title: "Quick Definition Peek (Alias)",
    description: "Alias for workspace.quickDefinition",
    category: "Navigate",
    keybinding: "Ctrl+Shift+I",
    provenance: "provider",
    keywords: ["definition", "peek", "preview"],
  },
  {
    id: "workspace.quickDocumentation",
    title: "Quick Documentation",
    description: "Show documentation popup for symbol under cursor",
    category: "Navigate",
    keybinding: "Ctrl+Q",
    secondaryKeybindings: ["F1"],
    provenance: "provider",
    keywords: ["doc", "documentation", "hover", "help"],
  },
  {
    id: "workspace.revealActiveFileInTree",
    title: "Select in Project View",
    description: "Reveal and focus the active file in the project file tree",
    category: "Navigate",
    keybinding: "Alt+F1",
    provenance: "local",
    keywords: ["reveal", "tree", "project", "locate", "select in"],
  },
  {
    id: "workspace.navigateBack",
    title: "Navigate Back",
    description: "Navigate back to previous cursor position in history",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Left",
    provenance: "local",
    keywords: ["back", "navigation", "history"],
  },
  {
    id: "workspace.navigateForward",
    title: "Navigate Forward",
    description: "Navigate forward in cursor position history",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Right",
    provenance: "local",
    keywords: ["forward", "navigation", "history"],
  },
  {
    id: "workspace.fileStructure",
    title: "File Structure Popup",
    description: "Show popup outline of symbols in current file",
    category: "Navigate",
    keybinding: "Ctrl+F12",
    provenance: "provider",
    keywords: ["structure", "outline", "symbols", "members"],
  },
  {
    id: "workspace.gotoTypeDefinition",
    title: "Go to Type Definition",
    description: "Jump to the type definition of the symbol under cursor",
    category: "Navigate",
    keybinding: "Ctrl+Shift+B",
    provenance: "provider",
    keywords: ["type", "definition", "jump"],
  },
  {
    id: "workspace.gotoImplementation",
    title: "Go to Implementation(s)",
    description: "Jump to implementations of interface or abstract method",
    category: "Navigate",
    keybinding: "Ctrl+Alt+B",
    provenance: "provider",
    keywords: ["implementation", "interface", "override"],
  },
  {
    id: "workspace.callHierarchy",
    title: "Call Hierarchy",
    description: "Explore callers and callees of active function/method",
    category: "Navigate",
    keybinding: "Ctrl+Alt+H",
    provenance: "provider",
    keywords: ["call", "hierarchy", "callers", "callees"],
  },
  {
    id: "workspace.typeHierarchy",
    title: "Type Hierarchy",
    description: "Explore supertypes and subtypes hierarchy",
    category: "Navigate",
    keybinding: "Ctrl+H",
    provenance: "provider",
    keywords: ["type", "hierarchy", "supertypes", "subtypes"],
  },
  {
    id: "workspace.findReferences",
    title: "Find Usages",
    description: "Find usages and references across the project or scoped selection",
    category: "Navigate",
    keybinding: "Shift+F12",
    provenance: "provider",
    keywords: ["usages", "references", "callers", "find"],
  },
  {
    id: "workspace.showUsages",
    title: "Show Usages",
    description: "Show usages in a lightweight popup over the shared usages session",
    category: "Navigate",
    keybinding: "Ctrl+Alt+F7",
    provenance: "provider",
    keywords: ["usages", "popup", "lightweight"],
  },
  {
    id: "workspace.previousMethod",
    title: "Previous Method",
    description: "Navigate to previous method or function declaration",
    category: "Navigate",
    keybinding: "Alt+Up",
    provenance: "unsupported",
    keywords: ["previous", "method", "function", "navigate"],
  },
  {
    id: "workspace.nextMethod",
    title: "Next Method",
    description: "Navigate to next method or function declaration",
    category: "Navigate",
    keybinding: "Alt+Down",
    provenance: "unsupported",
    keywords: ["next", "method", "function", "navigate"],
  },
  {
    id: "workspace.previousSibling",
    title: "Previous Sibling",
    description: "Navigate to previous sibling element or node",
    category: "Navigate",
    provenance: "unsupported",
    keywords: ["previous", "sibling", "element", "navigate"],
  },
  {
    id: "workspace.nextSibling",
    title: "Next Sibling",
    description: "Navigate to next sibling element or node",
    category: "Navigate",
    provenance: "unsupported",
    keywords: ["next", "sibling", "element", "navigate"],
  },

  // --- Search ---
  {
    id: "workspace.findInFiles",
    title: "Find in Files",
    description: "Search text across the whole workspace with regex and filters",
    category: "Search",
    keybinding: "Ctrl+Shift+F",
    provenance: "local",
    keywords: ["find", "search", "grep", "files"],
  },
  {
    id: "workspace.replaceInFiles",
    title: "Replace in Files",
    description: "Replace text across multiple files with preview",
    category: "Search",
    keybinding: "Ctrl+Shift+R",
    provenance: "local",
    keywords: ["replace", "substitute", "files"],
  },

  // --- Refactor ---
  {
    id: "workspace.refactorThis",
    title: "Refactor This…",
    description: "Open context popup with all applicable refactoring actions",
    category: "Refactor",
    keybinding: "Ctrl+Alt+Shift+T",
    provenance: "provider",
    keywords: ["refactor", "extract", "inline", "rename", "change signature"],
  },
  {
    id: "workspace.renameSymbol",
    title: "Rename Symbol",
    description: "Rename symbol across references with conflict verification",
    category: "Refactor",
    keybinding: "Shift+F6",
    provenance: "provider",
    keywords: ["rename", "symbol", "refactor"],
  },
  {
    id: "workspace.rename",
    title: "Rename Symbol (Alias)",
    description: "Alias for workspace.renameSymbol",
    category: "Refactor",
    keybinding: "Shift+F6",
    provenance: "provider",
    keywords: ["rename", "symbol"],
  },
  {
    id: "workspace.safeDeleteSymbol",
    title: "Safe Delete",
    description: "Check usages across workspace before deleting symbol",
    category: "Refactor",
    keybinding: "Alt+Delete",
    provenance: "provider",
    keywords: ["delete", "safe", "usages", "check"],
  },
  {
    id: "workspace.safeDelete",
    title: "Safe Delete (Alias)",
    description: "Alias for workspace.safeDeleteSymbol",
    category: "Refactor",
    keybinding: "Alt+Delete",
    provenance: "provider",
    keywords: ["delete", "safe"],
  },
  {
    id: "workspace.extractMethod",
    title: "Extract Method",
    description: "Extract selection into a new method or function",
    category: "Refactor",
    keybinding: "Ctrl+Alt+M",
    provenance: "provider",
    keywords: ["extract", "method", "function"],
  },
  {
    id: "workspace.extractVariable",
    title: "Extract Variable",
    description: "Extract expression into a local variable",
    category: "Refactor",
    keybinding: "Ctrl+Alt+V",
    provenance: "provider",
    keywords: ["extract", "variable", "constant"],
  },
  {
    id: "workspace.inline",
    title: "Inline",
    description: "Inline method, variable, or constant at call sites",
    category: "Refactor",
    keybinding: "Ctrl+Alt+N",
    provenance: "provider",
    keywords: ["inline", "substitute"],
  },
  {
    id: "workspace.changeSignature",
    title: "Change Signature",
    description: "Modify parameters, return type, and visibility of method",
    category: "Refactor",
    keybinding: "Ctrl+F6",
    provenance: "provider",
    keywords: ["signature", "parameters", "modify"],
  },
  {
    id: "workspace.moveRefactor",
    title: "Move…",
    description: "Move class, function, or file to another package or directory",
    category: "Refactor",
    keybinding: "F6",
    provenance: "provider",
    keywords: ["move", "refactor", "package"],
  },
  {
    id: "workspace.codeActions",
    title: "Show Intention Actions / Quick Fixes",
    description: "Show available quick fixes and intention actions at cursor",
    category: "Refactor",
    keybinding: "Alt+Enter",
    provenance: "provider",
    keywords: ["quick fix", "intention", "lightbulb", "action", "fix"],
  },

  // --- Run & Build ---
  {
    id: "workspace.runContextConfiguration",
    title: "Run Context Configuration",
    description: "Execute the main target or test associated with the active file",
    category: "Run",
    keybinding: "Ctrl+Shift+F10",
    provenance: "local",
    keywords: ["run", "execute", "launch", "context"],
  },
  {
    id: "workspace.buildProject",
    title: "Build Project",
    description: "Build or compile all modules in active workspace",
    category: "Build",
    keybinding: "Ctrl+F9",
    provenance: "local",
    keywords: ["build", "compile", "make", "project"],
  },
  {
    id: "workspace.recompileActiveFile",
    title: "Recompile Active File",
    description: "Trigger incremental recompile of the active file or module",
    category: "Build",
    keybinding: "Ctrl+Shift+F9",
    provenance: "local",
    keywords: ["compile", "build", "recompile", "single file"],
  },
  {
    id: "workspace.showRunTasks",
    title: "Show Run Tasks",
    description: "Open the Run tasks dock panel",
    category: "Run",
    provenance: "local",
    keywords: ["run", "tasks", "scripts"],
  },
  {
    id: "workspace.rerunLastTask",
    title: "Rerun Last Task",
    description: "Rerun the most recently executed workspace task",
    category: "Run",
    keybinding: "Ctrl+F5",
    provenance: "local",
    keywords: ["rerun", "repeat", "last task"],
  },

  // --- Debug ---
  {
    id: "workspace.toggleBreakpoint",
    title: "Toggle Line Breakpoint",
    description: "Toggle line breakpoint on the current cursor line",
    category: "Debug",
    keybinding: "Ctrl+F8",
    provenance: "local",
    keywords: ["breakpoint", "debug", "line"],
  },
  {
    id: "workspace.viewBreakpoints",
    title: "View Breakpoints",
    description: "Manage, filter, and edit all breakpoints in workspace",
    category: "Debug",
    keybinding: "Ctrl+Shift+F8",
    provenance: "local",
    keywords: ["breakpoint", "manage", "condition", "logpoint"],
  },
  {
    id: "workspace.toggleMuteBreakpoints",
    title: "Mute / Unmute Breakpoints",
    description: "Temporarily mute all breakpoints during debugger execution",
    category: "Debug",
    provenance: "local",
    keywords: ["mute", "breakpoints", "debug", "pause"],
  },
  {
    id: "workspace.openDapAdapterGuide",
    title: "DAP Debug Adapter Setup Guide",
    description: "View installation guides and launch configurations for debug adapters",
    category: "Debug",
    provenance: "local",
    keywords: ["dap", "debug", "adapter", "guide", "lldb", "dlv", "debugpy"],
  },

  // --- View ---
  {
    id: "workspace.toggleProjectTree",
    title: "Toggle Project Tree",
    description: "Show or hide the project explorer file tree",
    category: "View",
    provenance: "local",
    keywords: ["tree", "explorer", "sidebar", "project"],
  },
  {
    id: "workspace.toggleDocumentationPane",
    title: "Toggle Documentation Tool Window",
    description: "Show or hide the right-side Documentation pane",
    category: "View",
    provenance: "local",
    keywords: ["documentation", "doc", "pane", "sidebar"],
  },
  {
    id: "workspace.toggleTodosPane",
    title: "Toggle TODOs & Bookmarks Tool Window",
    description: "Show or hide the right-side TODOs and Bookmarks pane",
    category: "View",
    provenance: "local",
    keywords: ["todo", "bookmarks", "pane"],
  },
  {
    id: "workspace.toggleBookmark",
    title: "Toggle Bookmark",
    description: "Toggle a bookmark at cursor line",
    category: "View",
    keybinding: "F11",
    provenance: "local",
    keywords: ["bookmark", "mark", "line"],
  },
  {
    id: "workspace.toggleBookmarkWithMnemonic",
    title: "Toggle Bookmark with Mnemonic",
    description: "Toggle a mnemonic (0-9 or A-Z) bookmark at cursor line",
    category: "View",
    keybinding: "Ctrl+F11",
    provenance: "local",
    keywords: ["bookmark", "mnemonic", "mark", "digit"],
  },
  {
    id: "workspace.showBookmarks",
    title: "Show Bookmarks",
    description: "Open the bookmarks tool window",
    category: "View",
    keybinding: "Shift+F11",
    provenance: "local",
    keywords: ["bookmark", "list", "show"],
  },
  {
    id: "workspace.activateNavigationBar",
    title: "Jump to Navigation Bar",
    description: "Focus and navigate the project and symbol navigation bar",
    category: "Navigate",
    keybinding: "Alt+Home",
    provenance: "local",
    keywords: ["navbar", "navigation", "bar", "breadcrumbs", "jump"],
  },
  {
    id: "workspace.toggleInlayHints",
    title: "Toggle Inlay Hints",
    description: "Show or hide parameter names and type inlay hints",
    category: "View",
    provenance: "provider",
    keywords: ["inlay", "hints", "types", "parameters"],
  },
  {
    id: "workspace.toggleInlineBlame",
    title: "Toggle Git Inline Blame",
    description: "Show or hide author and commit message on current line",
    category: "View",
    provenance: "local",
    keywords: ["git", "blame", "author", "commit"],
  },
  {
    id: "workspace.toggleSoftWrap",
    title: "Toggle Soft Wrap",
    description: "Wrap long code lines visually to fit editor window",
    category: "View",
    provenance: "local",
    keywords: ["wrap", "soft wrap", "lines"],
  },
  {
    id: "workspace.toggleColumnSelection",
    title: "Toggle Column Selection Mode",
    description: "Enable rectangular / column-based multi-cursor selection",
    category: "View",
    keybinding: "Alt+Shift+Insert",
    provenance: "local",
    keywords: ["column", "rectangular", "selection", "block"],
  },
  {
    id: "workspace.toggleSyncSplitScroll",
    title: "Toggle Synchronized Split Scrolling",
    description: "Synchronize viewport scroll between left and right editor panes",
    category: "View",
    provenance: "local",
    keywords: ["scroll", "split", "sync", "mirror"],
  },
  {
    id: "workspace.showCoverage",
    title: "Show Code Coverage",
    description: "Scan workspace and display test coverage reports and gutters",
    category: "Analyze",
    provenance: "local",
    keywords: ["coverage", "jacoco", "lcov", "gutter", "tests"],
  },
  {
    id: "workspace.showAnalysis",
    title: "Show Code Analysis",
    description: "Open the Problems & Analysis dock window",
    category: "Analyze",
    provenance: "local",
    keywords: ["analysis", "problems", "diagnostics", "inspections"],
  },

  // --- File ---
  {
    id: "workspace.save",
    title: "Save Active File",
    description: "Save changes in the current editor tab to disk",
    category: "File",
    keybinding: "Ctrl+S",
    provenance: "local",
    keywords: ["save", "write", "disk"],
  },
  {
    id: "workspace.reload",
    title: "Reload Active File",
    description: "Discard unsaved buffer changes and reload from disk",
    category: "File",
    provenance: "local",
    keywords: ["reload", "revert", "disk"],
  },
  {
    id: "workspace.closeActiveEditorTab",
    title: "Close Active Editor Tab",
    description: "Close the currently focused tab in the active editor group",
    category: "File",
    keybinding: "Ctrl+F4",
    provenance: "local",
    keywords: ["close", "tab"],
  },
  {
    id: "workspace.refreshTree",
    title: "Refresh Project Tree",
    description: "Scan disk and refresh the project file tree",
    category: "File",
    provenance: "local",
    keywords: ["refresh", "tree", "reload"],
  },
  {
    id: "workspace.tree.openLooseFile",
    title: "Open Loose File",
    description: "Open a standalone file outside workspace roots",
    category: "File",
    provenance: "local",
    keywords: ["open", "loose", "standalone"],
  },
  {
    id: "workspace.tree.addFolder",
    title: "Add Folder to Workspace",
    description: "Add a new root folder into the current multi-root workspace",
    category: "File",
    provenance: "local",
    keywords: ["add", "folder", "root"],
  },

  // --- Git ---
  {
    id: "workspace.openGit",
    title: "Open Git Manager",
    description: "Open full Git repository manager and version control panel",
    category: "Git",
    provenance: "local",
    keywords: ["git", "vcs", "branch", "commit", "log"],
  },

  // --- Terminal ---
  {
    id: "workspace.toggleTerminal",
    title: "Toggle Integrated Terminal",
    description: "Open or hide the embedded terminal dock panel",
    category: "View",
    keybinding: "Alt+F12",
    provenance: "local",
    keywords: ["terminal", "shell", "pty", "bash"],
  },

  // --- Help ---
  {
    id: "workspace.openKeymapCheatsheet",
    title: "Keyboard Shortcuts (Keymap)",
    description: "Open shortcut reference and command executor dialog",
    category: "Help",
    keybinding: "Ctrl+Alt+/",
    secondaryKeybindings: ["Ctrl+K Ctrl+S"],
    provenance: "local",
    keywords: ["keymap", "shortcuts", "cheat sheet", "keyboard", "intellij"],
  },
];
