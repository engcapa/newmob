/**
 * CodeMirror ⇄ WorkspaceActionHost keymap adapter (§8.18.2 P0-C1).
 *
 * The ONLY sanctioned bridge between CodeMirror key events and workspace
 * actions: a thin dom-event handler that resolves every business binding
 * through `host.prepareBinding()` / `host.executePrepared()`. No action
 * semantics live here, and no CodeMirror extension may install its own
 * workspace keybinding outside this adapter.
 */

import type { EditorView } from "@codemirror/view";
import {
  copyLineDown,
  defaultKeymap,
  deleteLine,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  redo,
  toggleBlockComment,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  searchKeymap,
  selectSelectionMatches,
} from "@codemirror/search";
import { workspaceEditorKeymap } from "./workspaceEditorCommands";
import {
  completeCurrentStatement,
  expandSyntaxSelection,
  joinLines,
  shrinkSyntaxSelection,
  tabJumpOut,
  toggleCase,
  unselectOccurrence,
} from "./workspaceEditorCommands";
import {
  virtualBackspaceCommand,
  virtualDeleteCommand,
  virtualEnterCommand,
  virtualHomeCommand,
  virtualLineEndCommand,
  virtualMoveLeftCommand,
  virtualMoveRightCommand,
  virtualTabCommand,
  virtualVerticalMoveCommand,
} from "./workspaceVirtualSpace";
import {
  type PreparedActionEvaluation,
  type ResolvedBindingSource,
  type WorkspaceActionHost,
} from "./workspaceActionHost";
import {
  type ActionDisabledReason,
  type ActionResult,
  type WorkspaceActionContext,
} from "./workspaceActionRegistry";

/** A CodeMirror command adapted into an ActionResult (§8.19.2). */
function commandResult(handled: boolean): ActionResult {
  return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
}

/**
 * Run a CodeMirror `Command` through the registering host mount's live view.
 * Handlers close over the mounted EditorView (same lifecycle as
 * registerActions), so no global context plumbing can go stale across
 * split-view remounts (§8.19.2).
 */
function runViaHandlers(
  handlers: EditorHostActionHandlers,
  command: (view: EditorView) => boolean,
): ActionResult {
  return commandResult(handlers.runEditorCommand(command));
}

function runSharedHistoryOrLocal(
  handlers: EditorHostActionHandlers,
  shared: (() => boolean | undefined) | undefined,
  local: (view: EditorView) => boolean,
): ActionResult {
  const handled = shared?.();
  return handled === undefined
    ? runViaHandlers(handlers, local)
    : commandResult(handled);
}

/** Options for the editor-scoped adapter. */
export interface CodeMirrorActionKeymapOptions {
  /** Only these action ids are dispatched inside the editor surface. */
  actionIds: readonly string[];
  /**
   * Fresh editor context for prepare-time evaluation (focus=editor plus
   * selection/read-only facts); invoked per event, never cached.
   */
  editorContextProvider: () => Partial<WorkspaceActionContext>;
}

/**
 * Build the single editor keymap adapter. Returned value is intended for
 * `EditorView.domEventHandlers({ keydown })` placed at Prec.high so resolved
 * actions run before generic CM primitives.
 */
export function createCodeMirrorActionKeymap(
  host: WorkspaceActionHost,
  options: CodeMirrorActionKeymapOptions,
): { keydown(event: KeyboardEvent, view: EditorView): boolean } {
  return {
    keydown(event: KeyboardEvent, _view: EditorView): boolean {
      const allowed = new Set(options.actionIds);
      const resolved = host.prepareBinding(event, {
        kind: "keyboard",
        context: { focus: "editor", ...options.editorContextProvider() },
        eventTarget: event.target as EventTarget | null,
      });
      if (resolved.resolution === "none") return false;
      // Only bindings whose winning candidate is one of the editor-scoped
      // action ids are consumed here; everything else falls through to the
      // global window dispatcher and CM primitives.
      const enabled = resolved.candidates.find(
        (candidate) => candidate.evaluation.state.availability === "available"
          && allowed.has(candidate.actionId),
      );
      if (!enabled || resolved.resolution === "conflict") {
        if (resolved.resolution === "conflict" && resolved.candidates.some((c) => allowed.has(c.actionId))) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      void host.executePrepared(enabled.evaluation).then((result: ActionResult) => {
        void result;
      });
      return true;
    },
  };
}

/**
 * Register the editor-host business actions that previously lived as inline
 * `{key, run}` entries inside CodeMirrorHost's spread keymap. Every entry is
 * an explicit `editor.*` action so it appears in the conflict graph, Search
 * Everywhere and the Keymap settings surface (§8.18.2 单一 catalog).
 */
export interface EditorHostActionHandlers {
  openReplacePanel(): boolean;
  expandSemanticSelection(): boolean;
  /**
   * Explicit Basic Completion (§8.19.4): opens the popup, or — when one is
   * already open at this caret — restarts the query so the repeated call
   * reaches the provider adapter as ordinal ≥ 2 / expanded scope.
   */
  startBasicCompletion(): boolean;
  /** Escape stack: snippet tabstop cancel → selection collapse → signature hide. */
  escapeStack(): boolean;
  /**
   * Run a CodeMirror command against this mount's live view (§8.19.2
   * migration channel for the previously inline keymap business bindings).
   */
  runEditorCommand(command: (view: EditorView) => boolean): boolean;
  /** Shared document history owner; undefined keeps standalone CM history. */
  undo?(): boolean | undefined;
  redo?(): boolean | undefined;
}

function editorAction(input: {
  id: string;
  title: string;
  category: "Edit" | "View" | "File";
  defaultKeybinding: string;
  secondary?: readonly string[];
  keywords?: readonly string[];
  requiresEditor: boolean;
  run: (context: WorkspaceActionContext) => Promise<ActionResult>;
}) {
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    keybinding: input.defaultKeybinding,
    ...(input.secondary ? { secondaryKeybindings: [...input.secondary] } : {}),
    ...(input.keywords ? { keywords: [...input.keywords] } : {}),
    provenance: "local" as const,
    when: input.requiresEditor
      ? (context: WorkspaceActionContext) => context.focus === "editor" && !!context.hasActiveFile
      : undefined,
    run: input.run,
  };
}

/**
 * Create the editor.* action definitions bound to the live CodeMirrorHost
 * handlers. Registration goes through the normal host channel so lifecycle,
 * conflicts and disabled reasons are uniform.
 */
export function buildEditorHostActions(handlers: EditorHostActionHandlers) {
  return [
    editorAction({
      id: "editor.replace",
      title: "Replace in File",
      category: "Edit",
      defaultKeybinding: "Ctrl+r",
      secondary: ["Meta+r"],
      keywords: ["search", "replace"],
      requiresEditor: true,
      run: async () => {
        const handled = handlers.openReplacePanel();
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
    }),
    // Parameter Info intentionally NOT duplicated here: the workspace-level
    // `workspace.parameterInfo` command (Ctrl+P) owns it and drives the
    // editor through parameterInfoRequestNonce (§8.18.2 单一 catalog).
    editorAction({
      id: "editor.expandSelection",
      title: "Extend Selection",
      category: "Edit",
      defaultKeybinding: "Ctrl+w",
      secondary: ["Meta+w"],
      keywords: ["select", "word", "semantic"],
      requiresEditor: true,
      run: async () => {
        // LSP-aware semantic selection first; expandSemanticSelection itself
        // falls back to the Lezer syntax pass when no handler/range exists,
        // keeping this action the single Ctrl+W owner.
        if (handlers.expandSemanticSelection()) return { kind: "applied" };
        return commandResult(handlers.runEditorCommand(expandSyntaxSelection));
      },
    }),
    editorAction({
      id: "editor.shrinkSelection",
      title: "Shrink Selection",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+w",
      secondary: ["Meta+Shift+w"],
      keywords: ["select", "shrink", "syntax"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, shrinkSyntaxSelection),
    }),
    // No default keybinding: Escape remains an editor-local primitive (CM
    // default keymap + snippet/signature stack). The action exists so the
    // capability is discoverable and command-dispatchable.
    editorAction({
      id: "editor.escapeSelectionStack",
      title: "Escape Selection Stack",
      category: "Edit",
      defaultKeybinding: "",
      keywords: ["cancel", "collapse", "deselect"],
      requiresEditor: true,
      run: async () => {
        const handled = handlers.escapeStack();
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
    }),

    // ---- §8.19.2 migration: business bindings previously spread straight
    // into CodeMirror via workspaceEditorKeymap / searchKeymap / historyKeymap.
    // Each visible command below is now an action so scheme editing, conflict
    // detection and every consumer surface share one runtime truth.
    editorAction({
      id: "editor.toggleLineComment",
      title: "Toggle Line Comment",
      category: "Edit",
      defaultKeybinding: "Ctrl+/",
      secondary: ["Meta+/"],
      keywords: ["comment"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, toggleComment),
    }),
    editorAction({
      id: "editor.toggleBlockComment",
      title: "Toggle Block Comment",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+/",
      secondary: ["Meta+Shift+/"],
      keywords: ["comment", "block"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, toggleBlockComment),
    }),
    editorAction({
      id: "editor.copyLineDown",
      title: "Duplicate Line",
      category: "Edit",
      defaultKeybinding: "Ctrl+d",
      secondary: ["Meta+d"],
      keywords: ["copy", "line", "duplicate"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, copyLineDown),
    }),
    editorAction({
      id: "editor.deleteLine",
      title: "Delete Line",
      category: "Edit",
      defaultKeybinding: "Ctrl+y",
      secondary: ["Meta+y", "Ctrl+Shift+k", "Meta+Shift+k"],
      keywords: ["line", "delete"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, deleteLine),
    }),
    editorAction({
      id: "editor.moveLineUp",
      title: "Move Line Up",
      category: "Edit",
      defaultKeybinding: "Alt+Shift+ArrowUp",
      keywords: ["line", "move"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, moveLineUp),
    }),
    editorAction({
      id: "editor.moveLineDown",
      title: "Move Line Down",
      category: "Edit",
      defaultKeybinding: "Alt+Shift+ArrowDown",
      keywords: ["line", "move"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, moveLineDown),
    }),
    editorAction({
      id: "editor.gotoLine",
      title: "Go to Line",
      category: "Edit",
      defaultKeybinding: "Ctrl+g",
      secondary: ["Meta+g"],
      keywords: ["jump", "line"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, gotoLine),
    }),
    editorAction({
      id: "editor.completeStatement",
      title: "Complete Current Statement",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+Enter",
      secondary: ["Meta+Shift+Enter"],
      keywords: ["complete", "statement", "heuristic"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, completeCurrentStatement),
    }),
    // §8.19.4 explicit Basic Completion (IDEA Ctrl+Space). While a popup is
    // already open the handler restarts the query at the same caret, which is
    // what makes the second call arrive as ordinal ≥ 2 / requestedScope
    // expanded instead of being swallowed by the active popup.
    editorAction({
      id: "editor.basicCompletion",
      title: "Basic Completion",
      category: "Edit",
      defaultKeybinding: "Ctrl+Space",
      keywords: ["complete", "suggest", "popup", "intellisense"],
      requiresEditor: true,
      run: async () => {
        const handled = handlers.startBasicCompletion();
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
    }),
    editorAction({
      id: "editor.joinLines",
      title: "Join Lines",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+j",
      secondary: ["Meta+Shift+j"],
      keywords: ["join", "lines"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, joinLines),
    }),
    editorAction({
      id: "editor.unselectLastOccurrence",
      title: "Unselect Occurrence",
      category: "Edit",
      defaultKeybinding: "Alt+Shift+j",
      keywords: ["occurrence", "selection"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, unselectOccurrence),
    }),
    editorAction({
      id: "editor.toggleCase",
      title: "Toggle Case",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+u",
      secondary: ["Meta+Shift+u"],
      keywords: ["case", "upper", "lower"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, toggleCase),
    }),
    // Tab is a reserved stroke (browser focus + completion/snippet precedence):
    // registered without a keybinding and dispatched through commands; the
    // retained CM Tab primitive owns the physical gesture (allowlist).
    editorAction({
      id: "editor.tabJumpOut",
      title: "Tab Jump Out",
      category: "Edit",
      defaultKeybinding: "",
      keywords: ["bracket", "jump", "tab"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, tabJumpOut),
    }),
    editorAction({
      id: "workspace.undo",
      title: "Undo",
      category: "Edit",
      defaultKeybinding: "Ctrl+z",
      secondary: ["Meta+z"],
      keywords: ["history", "undo"],
      requiresEditor: true,
      run: async () => runSharedHistoryOrLocal(handlers, handlers.undo, undo),
    }),
    editorAction({
      id: "workspace.redo",
      title: "Redo",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+z",
      secondary: ["Meta+Shift+z"],
      keywords: ["history", "redo"],
      requiresEditor: true,
      run: async () => runSharedHistoryOrLocal(handlers, handlers.redo, redo),
    }),
    editorAction({
      id: "editor.find",
      title: "Find in File",
      category: "Edit",
      defaultKeybinding: "Ctrl+f",
      secondary: ["Meta+f"],
      keywords: ["search", "find"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, openSearchPanel),
    }),
    editorAction({
      id: "editor.findNext",
      title: "Find Next Match",
      category: "Edit",
      defaultKeybinding: "F3",
      keywords: ["search", "next"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, findNext),
    }),
    editorAction({
      id: "editor.findPrevious",
      title: "Find Previous Match",
      category: "Edit",
      defaultKeybinding: "Shift+F3",
      keywords: ["search", "previous"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, findPrevious),
    }),
    editorAction({
      id: "editor.selectSelectionMatches",
      title: "Select All Occurrences of Selection",
      category: "Edit",
      defaultKeybinding: "Ctrl+Shift+l",
      secondary: ["Meta+Shift+l"],
      keywords: ["occurrence", "multi-caret", "selection"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, selectSelectionMatches),
    }),

    // ---- §ED-VSPACE-001: Unified Virtual Space & Movement actions ----
    editorAction({
      id: "editor.moveUp",
      title: "Up",
      category: "View",
      defaultKeybinding: "ArrowUp",
      keywords: ["up", "cursor", "line", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "up", false)),
    }),
    editorAction({
      id: "editor.moveDown",
      title: "Down",
      category: "View",
      defaultKeybinding: "ArrowDown",
      keywords: ["down", "cursor", "line", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "down", false)),
    }),
    editorAction({
      id: "editor.selectUp",
      title: "Select Up",
      category: "View",
      defaultKeybinding: "Shift+ArrowUp",
      keywords: ["up", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "up", true)),
    }),
    editorAction({
      id: "editor.selectDown",
      title: "Select Down",
      category: "View",
      defaultKeybinding: "Shift+ArrowDown",
      keywords: ["down", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "down", true)),
    }),
    editorAction({
      id: "editor.pageUp",
      title: "Page Up",
      category: "View",
      defaultKeybinding: "PageUp",
      keywords: ["page", "up", "scroll", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageUp", false)),
    }),
    editorAction({
      id: "editor.selectPageUp",
      title: "Select Page Up",
      category: "View",
      defaultKeybinding: "Shift+PageUp",
      keywords: ["page", "up", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageUp", true)),
    }),
    editorAction({
      id: "editor.pageDown",
      title: "Page Down",
      category: "View",
      defaultKeybinding: "PageDown",
      keywords: ["page", "down", "scroll", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageDown", false)),
    }),
    editorAction({
      id: "editor.selectPageDown",
      title: "Select Page Down",
      category: "View",
      defaultKeybinding: "Shift+PageDown",
      keywords: ["page", "down", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualVerticalMoveCommand(view, "pageDown", true)),
    }),
    editorAction({
      id: "editor.moveLeft",
      title: "Left",
      category: "View",
      defaultKeybinding: "ArrowLeft",
      keywords: ["left", "cursor", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualMoveLeftCommand(view, false)),
    }),
    editorAction({
      id: "editor.selectLeft",
      title: "Select Left",
      category: "View",
      defaultKeybinding: "Shift+ArrowLeft",
      keywords: ["left", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualMoveLeftCommand(view, true)),
    }),
    editorAction({
      id: "editor.moveRight",
      title: "Right",
      category: "View",
      defaultKeybinding: "ArrowRight",
      keywords: ["right", "cursor", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualMoveRightCommand(view, false)),
    }),
    editorAction({
      id: "editor.selectRight",
      title: "Select Right",
      category: "View",
      defaultKeybinding: "Shift+ArrowRight",
      keywords: ["right", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualMoveRightCommand(view, true)),
    }),
    editorAction({
      id: "editor.moveToLineStart",
      title: "Move to Line Start",
      category: "View",
      defaultKeybinding: "Home",
      keywords: ["home", "start", "line"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualHomeCommand),
    }),
    editorAction({
      id: "editor.moveToLineEnd",
      title: "Move to Line End",
      category: "View",
      defaultKeybinding: "End",
      keywords: ["end", "line", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualLineEndCommand(view, false)),
    }),
    editorAction({
      id: "editor.selectToLineEnd",
      title: "Select to Line End",
      category: "View",
      defaultKeybinding: "Shift+End",
      keywords: ["end", "line", "select", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, (view) => virtualLineEndCommand(view, true)),
    }),
    editorAction({
      id: "editor.deleteBackward",
      title: "Delete Backward",
      category: "Edit",
      defaultKeybinding: "Backspace",
      keywords: ["backspace", "delete", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualBackspaceCommand),
    }),
    editorAction({
      id: "editor.deleteForward",
      title: "Delete Forward",
      category: "Edit",
      defaultKeybinding: "Delete",
      keywords: ["delete", "forward", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualDeleteCommand),
    }),
    editorAction({
      id: "editor.insertNewline",
      title: "Insert Newline",
      category: "Edit",
      defaultKeybinding: "Enter",
      keywords: ["enter", "newline", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualEnterCommand),
    }),
    editorAction({
      id: "editor.insertTab",
      title: "Insert Tab",
      category: "Edit",
      defaultKeybinding: "Tab",
      keywords: ["tab", "indent", "virtual space"],
      requiresEditor: true,
      run: async () => runViaHandlers(handlers, virtualTabCommand),
    }),
  ];
}

/**
 * Action ids owned by the editor surface adapter. Escape/Tab stay
 * editor-local primitives (completion/snippet/local UI state own them), so
 * `editor.escapeSelectionStack` is registered WITHOUT a keybinding: visible
 * in Keymap/Search, dispatched through commands, never competing with the
 * CM primitive Escape stack.
 */
export const EDITOR_HOST_ACTION_IDS = [
  "editor.replace",
  "editor.expandSelection",
  "editor.escapeSelectionStack",
] as const;

/** Source label helper used by diagnostics surfaces. */
export function describeResolvedSource(source: ResolvedBindingSource): string {
  if (source === "user") return "User scheme";
  if (source === "builtin-editor") return "Built-in editor";
  return "Base scheme";
}

// ---------------------------------------------------------------------------
// §8.19.2 retained-binding allowlist. With an ActionHost present the CM spread
// keeps ONLY these primitives; every user-visible business binding lives in
// buildEditorHostActions above and resolves through the host dispatcher.
// Each entry explains why it cannot be a configurable action binding.
// ---------------------------------------------------------------------------

export interface RetainedBindingAllowlistEntry {
  /** CodeMirror key pattern (as written in keymap.of entries). */
  pattern: string;
  reason: string;
}

export const EDITOR_RETAINED_BINDING_ALLOWLIST: readonly RetainedBindingAllowlistEntry[] = [
  {
    pattern: "Escape",
    reason: "editor-local UI stack (search panel close → snippet cancel → selection collapse → signature hide) is not part of WorkspaceActionContext, and bare Escape must also cancel chord waits without executing an action",
  },
  {
    pattern: "Tab",
    reason: "browser focus navigation plus completion-accept/template/snippet precedence must run inside the editor transaction pipeline; Tab is a reserved stroke (workspaceKeymapScheme RESERVED_STROKE_CODES) so it can never be rebound",
  },
  {
    pattern: "Backspace",
    reason: "closeBrackets typing primitive — must run inside the CM input pipeline to stay IME-safe and transactional",
  },
  {
    pattern: "Enter",
    reason: "closeBrackets typing primitive — same IME-safe pipeline requirement as Backspace",
  },
  {
    pattern: "Ctrl/Cmd-click",
    reason: "platform navigation gesture owned by lspNavigationExtensions (go-to-definition); IDEA parity keeps it non-configurable rather than duplicating it as a second truth",
  },
  {
    pattern: "defaultKeymap command-primitives (Mod-Enter, Alt-l, Mod-i, Mod-[, Mod-], Alt-A, Ctrl-m)",
    reason: "generic CM editing/cursor primitives (insertBlankLine, selectLine, cursorSyntax*, indentLess/More, copyLine*, cursorMatchingBracket) stay inside the CM input pipeline; per-command migration decisions belong to later packages and must not silently rebind typing behavior",
  },
];

/**
 * Binding keys retained when an ActionHost owns dispatch. Used by the
 * inventory test to prove nothing outside this set (plus the generic
 * defaultKeymap cursor/selection primitives) reaches `keymap.of`.
 */
const RETAINED_ESCAPE_STACK = [
  { key: "Escape", run: (view: EditorView) => closeSearchPanel(view) },
] as const;

/**
 * Canonical binding identity: all lowercase tokens (modifiers + key) sorted
 * alphabetically, joined with "+". Order-insensitive so catalog strings
 * ("Alt+Shift+ArrowUp") and CM patterns ("Shift-Alt-ArrowUp") converge.
 */
export function canonicalBindingIdentity(tokens: readonly string[]): string {
  return tokens.map((token) => token.toLowerCase()).sort().join("+");
}

/** Canonicalize a CM key pattern, expanding "Mod" to its two platforms. */
function cmPatternIdentities(pattern: string): string[] {
  const parts = pattern.split("-").filter(Boolean);
  if (parts.length === 0) return [];
  const key = parts.pop()!;
  const mods = parts.map((mod) => mod.toLowerCase());
  const expand = (list: string[]): string => canonicalBindingIdentity([...list, key]);
  if (mods.includes("mod")) {
    const rest = mods.filter((mod) => mod !== "mod");
    return [expand([...rest, "ctrl"]), expand([...rest, "meta"])];
  }
  return [expand(mods)];
}

const PRIMITIVE_KEYS = new Set([
  "enter",
  "backspace",
  "delete",
  "tab",
  "escape",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/** Identities of every binding an action owns (host dispatch wins these). */
function actionOwnedPatterns(): Set<string> {
  const owned = new Set<string>();
  for (const action of buildEditorHostActions(NOOP_HANDLERS)) {
    for (const binding of [
      ...(typeof action.keybinding === "string" && action.keybinding ? [action.keybinding] : []),
      ...(action.secondaryKeybindings ?? []),
    ]) {
      if (!binding) continue;
      const parts = binding.split("+").map((part) => part.trim()).filter(Boolean);
      const key = parts.pop();
      if (!key) continue;
      if (parts.length === 0 && PRIMITIVE_KEYS.has(key.toLowerCase())) continue;
      owned.add(canonicalBindingIdentity([...parts, key]));
    }
  }
  return owned;
}

const NOOP_HANDLERS = {
  openReplacePanel: () => false,
  expandSemanticSelection: () => false,
  startBasicCompletion: () => false,
  escapeStack: () => false,
  runEditorCommand: () => false,
};

/**
 * defaultKeymap bundles a few command-level entries (e.g. Mod-/ toggleComment,
 * Shift-Mod-k deleteLine) that migrated actions now own. With a host, those
 * entries would be a second dispatch truth behind the capture-phase window
 * dispatcher — filtered out here so only genuine cursor/selection/input
 * primitives remain.
 */
function filterActionOwned(bindings: readonly unknown[]): readonly unknown[] {
  const owned = actionOwnedPatterns();
  return bindings.filter((binding) => {
    const key = (binding as { key?: string }).key;
    if (!key) return true;
    return !cmPatternIdentities(key).some((identity) => owned.has(identity));
  });
}

/**
 * Build the editor-surface primitive keymap.
 *
 * - With an ActionHost (`hasActionHost: true`): only the allowlisted Escape
 *   stack, closeBrackets typing primitives, action-owned-filtered
 *   defaultKeymap cursor/selection primitives and indentWithTab remain.
 *   Business bindings resolve through the host exclusively.
 * - Without a host (standalone embedders/tests): the legacy full spread,
 *   marked transitional — every real workspace mount provides a host.
 */
export function buildEditorPrimitiveKeybindings(hasActionHost: boolean): readonly unknown[] {
  if (!hasActionHost) {
    return LEGACY_UNHOSTED_SPREAD;
  }
  return [
    ...RETAINED_ESCAPE_STACK,
    ...closeBracketsKeymap,
    ...filterActionOwned(defaultKeymap),
    indentWithTab,
  ];
}

/**
 * Transitional spread for embedders that render the editor WITHOUT a
 * workspace action host. Every real workspace mount provides one, so this
 * branch is compatibility-only and must never grow new bindings.
 */
const LEGACY_UNHOSTED_SPREAD: readonly unknown[] = [
  { key: "Escape", run: (view: EditorView) => closeSearchPanel(view) },
  ...workspaceEditorKeymap,
  ...searchKeymap,
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...historyKeymap,
  indentWithTab,
];


/** Disabled-reason display policy shared by Keymap/Search surfaces. */
export function disabledReasonLabel(reason: ActionDisabledReason | undefined): string | null {
  switch (reason) {
    case "userDisabled": return "Disabled in Keymap";
    case "readOnly": return "Read-only file";
    case "noEditor": return "No active editor";
    case "noSelection": return "No selection";
    case "providerOffline": return "Language server offline";
    case "conflict": return "Binding conflict";
    case "busy": return "Already running";
    case "unsupported": return "Not supported yet";
    default: return null;
  }
}

export type { PreparedActionEvaluation };
