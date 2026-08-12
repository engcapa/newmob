import type { MenuItem } from "../../ContextMenu";
import type { LspCapabilitySummary } from "../../../lib/editor/lsp";

export interface EditorContextMenuCapabilities {
  definition?: boolean;
  typeDefinition?: boolean;
  implementation?: boolean;
  references?: boolean;
  callHierarchy?: boolean;
  typeHierarchy?: boolean;
  rename?: boolean;
  hover?: boolean;
  codeAction?: boolean;
  formatting?: boolean;
  rangeFormatting?: boolean;
}

export interface EditorContextMenuActions {
  goToDefinition: () => void;
  goToTypeDefinition: () => void;
  goToImplementation: () => void;
  findReferences: () => void;
  callHierarchy: () => void;
  typeHierarchy: () => void;
  rename: () => void;
  safeDelete: () => void;
  quickDocumentation: () => void;
  codeActions: (clientX: number, clientY: number) => void;
  format: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
}

/** AI entry points. Omitted entirely when AI is unavailable/disabled. */
export interface EditorContextMenuAiSection {
  explainSyntaxLabel: string;
  explainCodeLabel: string;
  explainSyntax: () => void;
  explainCode: () => void;
  /**
   * Answer-language picker. Present here as well as on the selection toolbar
   * because the context menu is reachable without a selection, and was
   * previously the one path with no way to change the language.
   */
  answerLanguage?: {
    label: string;
    current: string;
    options: Array<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  };
}

export interface BuildEditorContextMenuInput {
  capabilities: EditorContextMenuCapabilities | LspCapabilitySummary | null | undefined;
  hasSelection: boolean;
  clientX: number;
  clientY: number;
  actions: EditorContextMenuActions;
  /** When true, LSP navigation items stay enabled even if capabilities are unknown. */
  lspAvailable?: boolean;
  /** Present while a debug session is active — adds Run to Cursor (IDEA Alt+F9). */
  debug?: { canRunToCursor: boolean; runToCursor: () => void } | null;
  /** Present when AI is available — adds the Explain Syntax / Explain Code pair. */
  ai?: EditorContextMenuAiSection | null;
}

function capEnabled(
  capabilities: EditorContextMenuCapabilities | LspCapabilitySummary | null | undefined,
  key: keyof EditorContextMenuCapabilities,
  lspAvailable: boolean,
): boolean {
  if (!lspAvailable) return false;
  if (!capabilities) return true;
  return !!capabilities[key];
}

/**
 * Build the editor symbol / buffer context menu (IDEA-style).
 * Pure helper so unit tests do not need CodeMirror or React.
 */
export function buildEditorContextMenuItems(input: BuildEditorContextMenuInput): MenuItem[] {
  const { capabilities, hasSelection, clientX, clientY, actions } = input;
  const lspAvailable = input.lspAvailable ?? true;

  const debugItems: MenuItem[] = input.debug
    ? [
      { separator: true, label: "" },
      {
        label: "Run to Cursor",
        shortcut: "Alt+F9",
        testId: "editor-context-run-to-cursor",
        disabled: !input.debug.canRunToCursor,
        onClick: input.debug.runToCursor,
      },
    ]
    : [];

  // AI actions work without a selection (they fall back to the enclosing symbol
  // at the caret), so these are never capability- or selection-gated.
  const answerLanguage = input.ai?.answerLanguage;
  const aiItems: MenuItem[] = input.ai
    ? [
      { separator: true, label: "" },
      {
        label: input.ai.explainSyntaxLabel,
        shortcut: "Ctrl+Alt+S",
        testId: "editor-context-ai-explain-syntax",
        onClick: input.ai.explainSyntax,
      },
      {
        label: input.ai.explainCodeLabel,
        shortcut: "Ctrl+Alt+E",
        testId: "editor-context-ai-explain-code",
        onClick: input.ai.explainCode,
      },
      ...(answerLanguage
        ? [{
          label: answerLanguage.label,
          testId: "editor-context-ai-answer-language",
          children: answerLanguage.options.map((option) => ({
            label: option.label,
            testId: `editor-context-ai-answer-language-${option.value}`,
            checked: option.value === answerLanguage.current,
            onClick: () => answerLanguage.onSelect(option.value),
          })),
        }]
        : []),
    ]
    : [];

  return [
    {
      label: "Go to Definition",
      shortcut: "F12",
      testId: "editor-context-goto-definition",
      disabled: !capEnabled(capabilities, "definition", lspAvailable),
      onClick: actions.goToDefinition,
    },
    {
      label: "Go to Type Definition",
      shortcut: "Ctrl+Shift+B",
      testId: "editor-context-goto-type-definition",
      disabled: !capEnabled(capabilities, "typeDefinition", lspAvailable),
      onClick: actions.goToTypeDefinition,
    },
    {
      label: "Go to Implementation",
      shortcut: "Ctrl+Alt+B",
      testId: "editor-context-goto-implementation",
      disabled: !capEnabled(capabilities, "implementation", lspAvailable),
      onClick: actions.goToImplementation,
    },
    {
      label: "Find Usages",
      shortcut: "Shift+F12",
      testId: "editor-context-find-usages",
      disabled: !capEnabled(capabilities, "references", lspAvailable),
      onClick: actions.findReferences,
    },
    {
      label: "Call Hierarchy",
      shortcut: "Ctrl+Alt+H",
      testId: "editor-context-call-hierarchy",
      disabled: !capEnabled(capabilities, "callHierarchy", lspAvailable),
      onClick: actions.callHierarchy,
    },
    {
      label: "Type Hierarchy",
      shortcut: "Ctrl+H",
      testId: "editor-context-type-hierarchy",
      disabled: !capEnabled(capabilities, "typeHierarchy", lspAvailable),
      onClick: actions.typeHierarchy,
    },
    { separator: true, label: "" },
    {
      label: "Rename Symbol…",
      shortcut: "Shift+F6",
      testId: "editor-context-rename",
      disabled: !capEnabled(capabilities, "rename", lspAvailable),
      onClick: actions.rename,
    },
    {
      label: "Safe Delete Symbol…",
      shortcut: "Alt+Delete",
      testId: "editor-context-safe-delete",
      disabled: !capEnabled(capabilities, "references", lspAvailable)
        || !capEnabled(capabilities, "rename", lspAvailable),
      onClick: actions.safeDelete,
    },
    {
      label: "Quick Documentation",
      shortcut: "Ctrl+Q",
      testId: "editor-context-quick-doc",
      disabled: !capEnabled(capabilities, "hover", lspAvailable),
      onClick: actions.quickDocumentation,
    },
    {
      label: "Show Code Actions…",
      shortcut: "Alt+Enter",
      testId: "editor-context-code-actions",
      disabled: !capEnabled(capabilities, "codeAction", lspAvailable),
      onClick: () => actions.codeActions(clientX, clientY),
    },
    {
      label: hasSelection ? "Format Selection" : "Format Document",
      shortcut: "Ctrl+Alt+L",
      testId: "editor-context-format",
      disabled: !capEnabled(capabilities, "formatting", lspAvailable)
        && !capEnabled(capabilities, "rangeFormatting", lspAvailable),
      onClick: actions.format,
    },
    ...debugItems,
    ...aiItems,
    { separator: true, label: "" },
    {
      label: "Cut",
      shortcut: "Ctrl+X",
      testId: "editor-context-cut",
      disabled: !hasSelection,
      onClick: actions.cut,
    },
    {
      label: "Copy",
      shortcut: "Ctrl+C",
      testId: "editor-context-copy",
      disabled: !hasSelection,
      onClick: actions.copy,
    },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      testId: "editor-context-paste",
      onClick: actions.paste,
    },
  ];
}
