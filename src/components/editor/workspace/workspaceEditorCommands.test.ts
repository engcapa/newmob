import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";
import {
  completeCurrentStatement,
  expandSyntaxSelection,
  expandSelectionFromLspRanges,
  selectionHistoryField,
  shrinkSyntaxSelection,
  toggleCase,
  unselectOccurrence,
  workspaceEditorKeymap,
} from "./workspaceEditorCommands";
import { selectNextOccurrence } from "@codemirror/search";

describe("workspace editor commands", () => {
  it("expands and shrinks syntax selections through selection history", () => {
    const doc = "const answer = value + 1;";
    const cursor = doc.indexOf("value") + 2;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: [javascript(), selectionHistoryField],
      }),
    });

    expect(expandSyntaxSelection(view)).toBe(true);
    const identifier = view.state.selection;
    expect(view.state.sliceDoc(identifier.main.from, identifier.main.to)).toBe("value");

    expect(expandSyntaxSelection(view)).toBe(true);
    expect(view.state.selection.eq(identifier)).toBe(false);

    expect(shrinkSyntaxSelection(view)).toBe(true);
    expect(view.state.selection.eq(identifier)).toBe(true);
    view.destroy();
  });

  it("registers the designed comment, selection, and statement completion shortcuts", () => {
    expect(workspaceEditorKeymap.map((binding) => binding.key)).toEqual([
      "Mod-/",
      "Mod-Shift-/",
      "Mod-d",
      "Mod-y",
      "Shift-Alt-ArrowUp",
      "Shift-Alt-ArrowDown",
      "Mod-w",
      "Mod-Shift-w",
      "Mod-g",
      "Mod-Shift-Enter",
      "Alt-j",
      "Shift-Alt-j",
      "Mod-Alt-Shift-j",
      "Ctrl-Alt-Shift-j",
      "Mod-Shift-u",
      "Ctrl-Shift-u",
    ]);
  });

  it("expands through semantic LSP ranges before shrinking from shared history", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "const value = 1;",
        selection: { anchor: 8 },
        extensions: [selectionHistoryField],
      }),
    });
    expect(expandSelectionFromLspRanges(view, [
      { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      { start: { line: 0, character: 0 }, end: { line: 0, character: 16 } },
    ])).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("value");
    expect(shrinkSyntaxSelection(view)).toBe(true);
    expect(view.state.selection.main.empty).toBe(true);
    view.destroy();
  });

  it("completes statement with semicolon and balances unclosed parentheses", () => {
    const doc = "  const msg = calculate(a, b";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 15 },
      }),
    });
    expect(completeCurrentStatement(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("  const msg = calculate(a, b);\n  ");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it("completes control flow headers with block braces", () => {
    const doc = "  if (isValid)";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 6 },
      }),
    });
    expect(completeCurrentStatement(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("  if (isValid) {\n    \n  }");
    view.destroy();
  });

  it("adds and removes multi-caret occurrences with Alt-J and Shift-Alt-J semantics", () => {
    const doc = "const alpha = 1;\nconst alpha = 2;\nconst alpha = 3;";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 8 }, // inside first 'alpha'
        extensions: [javascript(), EditorState.allowMultipleSelections.of(true)],
      }),
    });

    // 1st Alt-J: selects current word 'alpha'
    expect(selectNextOccurrence(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("alpha");
    expect(view.state.selection.ranges).toHaveLength(1);

    // 2nd Alt-J: adds 2nd occurrence of 'alpha'
    expect(selectNextOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(2);

    // 3rd Alt-J: adds 3rd occurrence of 'alpha'
    expect(selectNextOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(3);

    // Shift-Alt-J: unselects last occurrence
    expect(unselectOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(2);

    expect(unselectOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(1);

    expect(unselectOccurrence(view)).toBe(false);
    view.destroy();
  });

  it("toggles case of selected text or word under caret with Ctrl+Shift+U", () => {
    const doc = "const myVariable = 'hello';";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 6, head: 16 }, // 'myVariable'
      }),
    });

    // Lower/mixed -> UPPER
    expect(toggleCase(view)).toBe(true);
    expect(view.state.sliceDoc(6, 16)).toBe("MYVARIABLE");

    // UPPER -> lower
    expect(toggleCase(view)).toBe(true);
    expect(view.state.sliceDoc(6, 16)).toBe("myvariable");

    // Caret inside word without explicit range
    const caretView = new EditorView({
      state: EditorState.create({
        doc: "const identifier = 1;",
        selection: { anchor: 8 }, // inside 'identifier'
      }),
    });

    expect(toggleCase(caretView)).toBe(true);
    expect(caretView.state.doc.toString()).toBe("const IDENTIFIER = 1;");

    expect(toggleCase(caretView)).toBe(true);
    expect(caretView.state.doc.toString()).toBe("const identifier = 1;");

    view.destroy();
    caretView.destroy();
  });
});
