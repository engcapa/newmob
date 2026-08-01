import { describe, expect, it, vi } from "vitest";
import { buildEditorContextMenuItems } from "./editorContextMenu";

const actions = {
  goToDefinition: vi.fn(),
  goToTypeDefinition: vi.fn(),
  goToImplementation: vi.fn(),
  findReferences: vi.fn(),
  callHierarchy: vi.fn(),
  typeHierarchy: vi.fn(),
  rename: vi.fn(),
  quickDocumentation: vi.fn(),
  codeActions: vi.fn(),
  format: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
};

describe("buildEditorContextMenuItems", () => {
  it("disables LSP actions when the language service is unavailable", () => {
    const items = buildEditorContextMenuItems({
      capabilities: null,
      hasSelection: false,
      clientX: 10,
      clientY: 20,
      actions,
      lspAvailable: false,
    });
    const definition = items.find((item) => item.testId === "editor-context-goto-definition");
    const paste = items.find((item) => item.testId === "editor-context-paste");
    expect(definition?.disabled).toBe(true);
    expect(paste?.disabled).toBeFalsy();
  });

  it("gates hierarchy and rename by server capabilities", () => {
    const items = buildEditorContextMenuItems({
      capabilities: {
        definition: true,
        typeDefinition: false,
        implementation: true,
        references: true,
        callHierarchy: false,
        typeHierarchy: true,
        rename: false,
        hover: true,
        codeAction: true,
        formatting: true,
        rangeFormatting: false,
      },
      hasSelection: true,
      clientX: 1,
      clientY: 2,
      actions,
      lspAvailable: true,
    });

    expect(items.find((i) => i.testId === "editor-context-goto-definition")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-goto-type-definition")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-call-hierarchy")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-type-hierarchy")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-rename")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-format")?.label).toBe("Format Selection");
  });

  it("wires code actions with the click coordinates", () => {
    const items = buildEditorContextMenuItems({
      capabilities: { codeAction: true },
      hasSelection: false,
      clientX: 42,
      clientY: 84,
      actions,
      lspAvailable: true,
    });
    items.find((i) => i.testId === "editor-context-code-actions")?.onClick?.();
    expect(actions.codeActions).toHaveBeenCalledWith(42, 84);
  });

  it("adds Run to Cursor only while a debug session is active, enabled when stopped", () => {
    const base = { capabilities: null, hasSelection: false, clientX: 0, clientY: 0, actions };
    expect(buildEditorContextMenuItems(base).find((i) => i.testId === "editor-context-run-to-cursor"))
      .toBeUndefined();
    const runToCursor = vi.fn();
    const items = buildEditorContextMenuItems({ ...base, debug: { canRunToCursor: true, runToCursor } });
    const item = items.find((i) => i.testId === "editor-context-run-to-cursor");
    expect(item?.disabled).toBe(false);
    item?.onClick?.();
    expect(runToCursor).toHaveBeenCalledTimes(1);
    const running = buildEditorContextMenuItems({ ...base, debug: { canRunToCursor: false, runToCursor } });
    expect(running.find((i) => i.testId === "editor-context-run-to-cursor")?.disabled).toBe(true);
  });

  it("adds the AI section only when a host supplies it", () => {
    const base = { capabilities: null, hasSelection: false, clientX: 0, clientY: 0, actions };
    expect(buildEditorContextMenuItems(base).find((i) => i.testId === "editor-context-ai-explain-syntax"))
      .toBeUndefined();

    const explainSyntax = vi.fn();
    const explainCode = vi.fn();
    const items = buildEditorContextMenuItems({
      ...base,
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax,
        explainCode,
      },
    });
    const syntax = items.find((i) => i.testId === "editor-context-ai-explain-syntax");
    const code = items.find((i) => i.testId === "editor-context-ai-explain-code");
    expect(syntax?.label).toBe("Explain Syntax…");
    expect(syntax?.shortcut).toBe("Ctrl+Alt+S");
    // AI actions fall back to the enclosing symbol, so no selection is required.
    expect(syntax?.disabled).toBeFalsy();
    expect(code?.disabled).toBeFalsy();
    syntax?.onClick?.();
    code?.onClick?.();
    expect(explainSyntax).toHaveBeenCalledTimes(1);
    expect(explainCode).toHaveBeenCalledTimes(1);
  });
});
