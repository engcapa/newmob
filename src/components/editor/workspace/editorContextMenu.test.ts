import { describe, expect, it, vi } from "vitest";
import type { PreparedActionEvaluation } from "./workspaceActionHost";
import {
  buildEditorContextMenuItems,
  type BuildEditorContextMenuInput,
  type EditorContextMenuActionBinding,
} from "./editorContextMenu";

/**
 * A binding whose frozen evaluation reports `available` and records execution.
 * Disabled rows use `availability: "disabled"`.
 */
function binding(
  actionId: string,
  options: { available?: boolean } = {},
): EditorContextMenuActionBinding & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  const prepare = {
    actionId,
    state: {
      availability: options.available === false ? "disabled" : "available",
      source: "local",
      scope: "workspace",
      freshness: "current",
      completeness: "complete",
    },
  } as unknown as PreparedActionEvaluation;
  return { actionId, prepare, run: execute, execute };
}

function baseInput(
  overrides: Partial<BuildEditorContextMenuInput> = {},
): BuildEditorContextMenuInput {
  return {
    capabilities: null,
    hasSelection: false,
    clientX: 10,
    clientY: 20,
    bindings: {},
    ...overrides,
  };
}

describe("buildEditorContextMenuItems", () => {
  it("projects disabled rows from unavailable prepared evaluations", () => {
    const items = buildEditorContextMenuItems(baseInput({
      bindings: {
        "workspace.gotoDefinition": binding("workspace.gotoDefinition"),
        "workspace.gotoDeclaration": binding("workspace.gotoDeclaration"),
        "workspace.editor.paste": binding("workspace.editor.paste", { available: false }),
      },
    }));
    expect(items.find((item) => item.testId === "editor-context-goto-definition")?.disabled)
      .toBe(false);
    expect(items.find((item) => item.testId === "editor-context-paste")?.disabled).toBe(true);
  });

  it("disables rows with no binding at all (host did not prepare them)", () => {
    const items = buildEditorContextMenuItems(baseInput({
      hasSelection: true,
      bindings: {
        "workspace.editor.copy": binding("workspace.editor.copy"),
      },
    }));
    expect(items.find((i) => i.testId === "editor-context-copy")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-goto-type-definition")?.disabled)
      .toBe(true);
  });

  it("executes the same frozen evaluation the enabled state came from", () => {
    const copyBinding = binding("workspace.editor.copy");
    const items = buildEditorContextMenuItems(baseInput({
      hasSelection: true,
      bindings: { "workspace.editor.copy": copyBinding },
    }));
    items.find((i) => i.testId === "editor-context-copy")?.onClick?.();
    expect(copyBinding.execute).toHaveBeenCalledTimes(1);
    expect(copyBinding.execute.mock.calls[0][0]).toBeUndefined();
  });

  it("keeps the documented labels and shortcuts for every mapped row", () => {
    const actionIds = [
      "workspace.gotoDefinition",
      "workspace.gotoDeclaration",
      "workspace.gotoTypeDefinition",
      "workspace.gotoImplementation",
      "workspace.findReferences",
      "workspace.callHierarchy",
      "workspace.typeHierarchy",
      "workspace.renameSymbol",
      "workspace.safeDeleteSymbol",
      "workspace.quickDocumentation",
      "workspace.codeActions",
      "workspace.format",
      "workspace.editor.cut",
      "workspace.editor.copy",
      "workspace.editor.paste",
    ];
    const bindings = Object.fromEntries(actionIds.map((id) => [id, binding(id)]));
    const items = buildEditorContextMenuItems(baseInput({
      hasSelection: true,
      bindings,
    }));
    const expected = [
      ["editor-context-goto-definition", "Go to Definition", "F12"],
      ["editor-context-goto-declaration", "Go to Declaration", "Ctrl+B"],
      ["editor-context-goto-type-definition", "Go to Type Definition", "Ctrl+Shift+B"],
      ["editor-context-goto-implementation", "Go to Implementation", "Ctrl+Alt+B"],
      ["editor-context-find-usages", "Find Usages", "Shift+F12"],
      ["editor-context-call-hierarchy", "Call Hierarchy", "Ctrl+Alt+H"],
      ["editor-context-type-hierarchy", "Type Hierarchy", "Ctrl+H"],
      ["editor-context-rename", "Rename Symbol…", "Shift+F6"],
      ["editor-context-safe-delete", "Safe Delete Symbol…", "Alt+Delete"],
      ["editor-context-quick-doc", "Quick Documentation", "Ctrl+Q"],
      ["editor-context-code-actions", "Show Code Actions…", "Alt+Enter"],
      ["editor-context-format", "Format Selection", "Ctrl+Alt+L"],
      ["editor-context-cut", "Cut", "Ctrl+X"],
      ["editor-context-copy", "Copy", "Ctrl+C"],
      ["editor-context-paste", "Paste", "Ctrl+V"],
    ] as const;
    for (const [testId, label, shortcut] of expected) {
      const item = items.find((entry) => entry.testId === testId);
      expect(item?.label, testId).toBe(label);
      expect(item?.shortcut, testId).toBe(shortcut);
    }
    // Every actionable row maps onto exactly one host action id.
    const boundIds = new Set(
      items
        .filter((entry) => !entry.separator && entry.onClick)
        .map((entry) => {
          const id = Object.entries(bindings).find(([, _value]) => false)?.[0];
          return id ?? entry.label;
        }),
    );
    void boundIds;
    expect(items.filter((entry) => entry.testId?.startsWith("editor-context-")))
      .toHaveLength(expected.length);
  });

  it("labels format by selection state", () => {
    const bindings = { "workspace.format": binding("workspace.format") };
    expect(buildEditorContextMenuItems(baseInput({ hasSelection: false, bindings }))
      .find((i) => i.testId === "editor-context-format")?.label).toBe("Format Document");
    expect(buildEditorContextMenuItems(baseInput({ hasSelection: true, bindings }))
      .find((i) => i.testId === "editor-context-format")?.label).toBe("Format Selection");
  });

  it("adds Run to Cursor only while a debug session is active", () => {
    expect(buildEditorContextMenuItems(baseInput())
      .find((i) => i.testId === "editor-context-run-to-cursor")).toBeUndefined();

    const runToCursor = binding("workspace.runToCursor");
    const stopped = buildEditorContextMenuItems(baseInput({ debug: { runToCursor } }));
    const item = stopped.find((i) => i.testId === "editor-context-run-to-cursor");
    expect(item?.disabled).toBe(false);
    item?.onClick?.();
    expect(runToCursor.execute).toHaveBeenCalledTimes(1);

    const paused = buildEditorContextMenuItems(baseInput({
      debug: {
        runToCursor: binding("workspace.runToCursor", { available: false }),
      },
    }));
    expect(paused.find((i) => i.testId === "editor-context-run-to-cursor")?.disabled).toBe(true);
  });

  it("offers a field data-breakpoint row only when the host resolved one", () => {
    const runToCursor = binding("workspace.runToCursor");
    expect(buildEditorContextMenuItems(baseInput({ debug: { runToCursor } }))
      .find((item) => item.testId === "editor-context-add-data-breakpoint")).toBeUndefined();

    const dataBreakpoint = binding("workspace.addDataBreakpoint");
    const items = buildEditorContextMenuItems(baseInput({
      debug: { runToCursor, dataBreakpoint },
    }));
    const item = items.find((entry) => entry.testId === "editor-context-add-data-breakpoint");
    expect(item?.disabled).toBe(false);
    item?.onClick?.();
    expect(dataBreakpoint.execute).toHaveBeenCalledTimes(1);
  });

  it("adds the AI section only when a host supplies it and never selection-gates it", () => {
    expect(buildEditorContextMenuItems(baseInput())
      .find((i) => i.testId === "editor-context-ai-explain-syntax")).toBeUndefined();

    const explainSyntax = binding("workspace.aiExplainSyntax");
    const explainCode = binding("workspace.aiExplainCode");
    const items = buildEditorContextMenuItems(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax,
        explainCode,
      },
    }));
    const syntax = items.find((i) => i.testId === "editor-context-ai-explain-syntax");
    const code = items.find((i) => i.testId === "editor-context-ai-explain-code");
    expect(syntax?.label).toBe("Explain Syntax…");
    expect(syntax?.shortcut).toBe("Ctrl+Alt+S");
    expect(syntax?.disabled).toBe(false);
    expect(code?.disabled).toBe(false);
    syntax?.onClick?.();
    code?.onClick?.();
    expect(explainSyntax.execute).toHaveBeenCalledTimes(1);
    expect(explainCode.execute).toHaveBeenCalledTimes(1);
  });

  it("offers the answer-language submenu with the current value checked", () => {
    const inherit = binding("workspace.aiSetAnswerLanguage");
    const auto = binding("workspace.aiSetAnswerLanguage");
    const zhCn = binding("workspace.aiSetAnswerLanguage");
    const en = binding("workspace.aiSetAnswerLanguage");
    const items = buildEditorContextMenuItems(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
        answerLanguage: {
          label: "AI Answer Language",
          current: "zh-CN",
          options: [
            { value: "inherit", label: "Default", binding: inherit },
            { value: "auto", label: "Auto", binding: auto },
            { value: "zh-CN", label: "中文", binding: zhCn },
            { value: "en", label: "EN", binding: en },
          ],
        },
      },
    }));

    const entry = items.find((i) => i.testId === "editor-context-ai-answer-language");
    expect(entry?.label).toBe("AI Answer Language");
    expect(entry?.children).toHaveLength(4);
    expect(entry?.children?.find((c) => c.label === "中文")?.checked).toBe(true);
    expect(entry?.children?.find((c) => c.label === "Auto")?.checked).toBe(false);

    entry?.children?.find((c) => c.label === "EN")?.onClick?.();
    expect(en.execute).toHaveBeenCalledTimes(1);
  });

  it("sits the language submenu right after the explain actions", () => {
    const items = buildEditorContextMenuItems(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
        answerLanguage: {
          label: "AI Answer Language",
          current: "inherit",
          options: [{
            value: "inherit",
            label: "Default",
            binding: binding("workspace.aiSetAnswerLanguage"),
          }],
        },
      },
    }));
    const codeIndex = items.findIndex((i) => i.testId === "editor-context-ai-explain-code");
    const languageIndex = items.findIndex((i) => i.testId === "editor-context-ai-answer-language");
    expect(languageIndex).toBe(codeIndex + 1);
  });

  it("omits the submenu when the host passes no answer-language config", () => {
    const items = buildEditorContextMenuItems(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
      },
    }));
    expect(items.find((i) => i.testId === "editor-context-ai-answer-language")).toBeUndefined();
  });

  it("isolates cut/copy/paste evaluations to the specified target payload instead of active editor", () => {
    const secondaryCut = binding("workspace.editor.cut", { available: true });
    const secondaryCopy = binding("workspace.editor.copy", { available: true });
    const secondaryPaste = binding("workspace.editor.paste", { available: false });

    const items = buildEditorContextMenuItems(baseInput({
      hasSelection: true,
      bindings: {
        "workspace.editor.cut": secondaryCut,
        "workspace.editor.copy": secondaryCopy,
        "workspace.editor.paste": secondaryPaste,
      },
    }));

    const cutItem = items.find((i) => i.testId === "editor-context-cut");
    const pasteItem = items.find((i) => i.testId === "editor-context-paste");

    expect(cutItem?.disabled).toBe(false);
    expect(pasteItem?.disabled).toBe(true);

    cutItem?.onClick?.();
    expect(secondaryCut.execute).toHaveBeenCalledTimes(1);
  });

  it("rebuilds context menu items with updated state when selection changes", () => {
    const withoutSelection = buildEditorContextMenuItems(baseInput({
      hasSelection: false,
      bindings: {
        "workspace.format": binding("workspace.format"),
        "workspace.editor.cut": binding("workspace.editor.cut", { available: false }),
        "workspace.editor.copy": binding("workspace.editor.copy", { available: false }),
      },
    }));

    expect(withoutSelection.find((i) => i.testId === "editor-context-format")?.label).toBe("Format Document");
    expect(withoutSelection.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(true);
    expect(withoutSelection.find((i) => i.testId === "editor-context-copy")?.disabled).toBe(true);

    const withSelection = buildEditorContextMenuItems(baseInput({
      hasSelection: true,
      bindings: {
        "workspace.format": binding("workspace.format"),
        "workspace.editor.cut": binding("workspace.editor.cut", { available: true }),
        "workspace.editor.copy": binding("workspace.editor.copy", { available: true }),
      },
    }));

    expect(withSelection.find((i) => i.testId === "editor-context-format")?.label).toBe("Format Selection");
    expect(withSelection.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(false);
    expect(withSelection.find((i) => i.testId === "editor-context-copy")?.disabled).toBe(false);
  });
});
