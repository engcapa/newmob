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
  type PreparedActionEvaluation,
  type ResolvedBindingSource,
  type WorkspaceActionHost,
} from "./workspaceActionHost";
import {
  type ActionDisabledReason,
  type ActionResult,
  type WorkspaceActionContext,
} from "./workspaceActionRegistry";

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
  save(): void;
  openReplacePanel(view: unknown): boolean;
  expandSemanticSelection(view: unknown): boolean;
  /** Escape stack: snippet tabstop cancel → selection collapse → signature hide. */
  escapeStack(view: unknown): boolean;
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
      id: "editor.save",
      title: "Save File",
      category: "File",
      defaultKeybinding: "Ctrl+s",
      secondary: ["Meta+s"],
      keywords: ["write", "persist"],
      requiresEditor: true,
      run: async () => {
        handlers.save();
        return { kind: "applied" };
      },
    }),
    editorAction({
      id: "editor.replace",
      title: "Replace in File",
      category: "Edit",
      defaultKeybinding: "Ctrl+r",
      secondary: ["Meta+r"],
      keywords: ["search", "replace"],
      requiresEditor: true,
      run: async (context) => {
        const handled = handlers.openReplacePanel(context.editorView);
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
      run: async (context) => {
        const handled = handlers.expandSemanticSelection(context.editorView);
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
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
      run: async (context) => {
        const handled = handlers.escapeStack(context.editorView);
        return handled ? { kind: "applied" } : { kind: "no-op", reason: "condition-not-met" };
      },
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
  "editor.save",
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
