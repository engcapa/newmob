import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { foldable } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import {
  buildMultiCaretPastePlan,
  cloneCaretAbove,
  cloneCaretBelow,
  completeCurrentStatement,
  detectClipboardSourceEol,
  editorClipboardPayload,
  editorVirtualSpacePolicy,
  escapeEditorSelections,
  expandSyntaxSelection,
  occurrenceSessionField,
  expandSelectionFromLspRanges,
  foldSelection,
  joinLines,
  moveStatementDown,
  normalizeEditorSelections,
  pasteEditorClipboardPayload,
  pasteEditorWithAutoImports,
  plainTextClipboardPayload,
  createRegionFoldService,
  regionFoldAvailableForPath,
  regionFoldingProvenance,
  regionFoldingProvenanceLabel,
  reverseLines,
  selectNextEditorOccurrence,
  selectionHistoryField,
  shrinkSyntaxSelection,
  sortLines,
  toggleCase,
  transposeLines,
  tabJumpOut,
  unwrapRemove,
  unselectOccurrence,
  workspaceEditorKeymap,
} from "./workspaceEditorCommands";
import {
  virtualOverflowAt,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
} from "./workspaceVirtualSpace";


/** Region services bound to concrete paths (grammar comes from the path). */
const tsRegionFoldService = createRegionFoldService(() => "src/Main.ts");
const pyRegionFoldService = createRegionFoldService(() => "src/block.py");
const sqlRegionFoldService = createRegionFoldService(() => "src/query.sql");

describe("workspace editor commands", () => {
  it("normalizes overlapping ranges and keeps the primary owner", () => {
    const primary = EditorSelection.range(7, 2);
    const normalized = normalizeEditorSelections([
      EditorSelection.range(0, 4),
      primary,
      EditorSelection.cursor(12),
    ], 1);

    expect(normalized.ranges).toHaveLength(2);
    expect(normalized.ranges[0]).toMatchObject({ from: 0, to: 7, anchor: 7, head: 0 });
    expect(normalized.mainIndex).toBe(0);
  });

  it("serializes one segment per selection and detects source EOL", () => {
    const state = EditorState.create({
      doc: "alpha\nbeta",
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 10),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    expect(editorClipboardPayload(state)).toEqual({
      plainText: "alpha\nbeta",
      segments: ["alpha", "beta"],
      sourceEol: "lf",
      rectangular: false,
    });
    expect(detectClipboardSourceEol("a\r\nb")).toBe("crlf");
    expect(detectClipboardSourceEol("a\rb")).toBe("cr");
  });

  it("distributes matching clipboard segments in one transaction and one undo", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "one two",
        selection: EditorSelection.create([
          EditorSelection.cursor(0),
          EditorSelection.cursor(4),
        ], 1),
        extensions: [history(), EditorState.allowMultipleSelections.of(true)],
      }),
    });

    expect(pasteEditorClipboardPayload(view, {
      plainText: "A\nB",
      segments: ["A", "B"],
      sourceEol: "lf",
      rectangular: false,
    })).toBe(true);
    expect(view.state.doc.toString()).toBe("Aone Btwo");
    expect(view.state.selection.mainIndex).toBe(1);
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("one two");
    view.destroy();
  });

  it("ED-IMPORT-001 A4: paste with auto-imports executes in one transaction and undoes in one step", () => {
    const initialDoc = "package com.example;\n\npublic class App {\n  void test() {\n    \n  }\n}\n";
    const cursorOffset = initialDoc.indexOf("    \n") + 4;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        selection: EditorSelection.cursor(cursorOffset),
        extensions: [history()],
      }),
    });

    const pasteText = "List<String> list = new ArrayList<>();";
    const importStatements = ["import java.util.List;\n", "import java.util.ArrayList;\n"];

    const ok = pasteEditorWithAutoImports(view, {
      pastedText: pasteText,
      importStatements,
    });
    expect(ok).toBe(true);

    const updated = view.state.doc.toString();
    expect(updated).toContain("import java.util.List;\nimport java.util.ArrayList;\n");
    expect(updated).toContain("List<String> list = new ArrayList<>();");
    // One transaction => undoDepth is 1
    expect(undoDepth(view.state)).toBe(1);

    // One undo reverts BOTH imports and pasted text
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(initialDoc);
    expect(undoDepth(view.state)).toBe(0);

    view.destroy();
  });

  it("replicates one external payload to every caret and normalizes EOL", () => {
    const state = EditorState.create({
      doc: "ab\ncd",
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(3),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const plan = buildMultiCaretPastePlan(
      state,
      plainTextClipboardPayload("x\r\ny"),
    );

    expect(plan).not.toBeNull();
    const transaction = state.update({
      changes: plan!.changes,
      selection: plan!.selection,
    });
    expect(transaction.newDoc.toString()).toBe("x\nyab\nx\nycd");
    expect(transaction.newSelection.ranges.map((range) => range.head)).toEqual([3, 9]);
  });

  it("replaces multi-selections while retaining primary selection identity", () => {
    const state = EditorState.create({
      doc: "red green blue",
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(10, 14),
      ], 1),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const plan = buildMultiCaretPastePlan(state, {
      plainText: "R\nB",
      segments: ["R", "B"],
      sourceEol: "lf",
      rectangular: true,
    });
    const transaction = state.update({ changes: plan!.changes, selection: plan!.selection });

    expect(transaction.newDoc.toString()).toBe("R green B");
    expect(transaction.newSelection.mainIndex).toBe(1);
    expect(transaction.newSelection.ranges.map((range) => range.head)).toEqual([1, 9]);
  });

  it("clones carets vertically and clamps columns on short lines", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "abcdef\nx\n12345",
        selection: EditorSelection.cursor(5),
        extensions: [EditorState.allowMultipleSelections.of(true)],
      }),
    });

    expect(cloneCaretBelow(view)).toBe(true);
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([5, 8]);
    expect(view.state.selection.main.head).toBe(5);
    expect(cloneCaretAbove(view)).toBe(true);
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([1, 5, 8]);
    expect(view.state.selection.main.head).toBe(5);
    view.destroy();
  });

  it("records short-line virtual overflow without padding the document", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "abcdef\nx",
        selection: EditorSelection.cursor(5),
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          editorVirtualSpacePolicy.of({ afterLineEnd: true, atFileBottom: false }),
          virtualSpaceOverflowField,
        ],
      }),
    });

    expect(cloneCaretBelow(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("abcdef\nx");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([5, 8]);
    expect(virtualOverflowAt(view.state, 8)).toBe(4);
    expect(view.state.selection.main.head).toBe(5);
    view.destroy();
  });

  it("defers cloned-caret padding until typing so one undo removes padding and payload", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "abcdef\nx",
        selection: EditorSelection.cursor(5),
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          editorVirtualSpacePolicy.of({ afterLineEnd: true, atFileBottom: false }),
          virtualSpaceOverflowField,
          virtualSpaceTypingHandler,
          history(),
        ],
      }),
    });

    expect(cloneCaretBelow(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("abcdef\nx");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([5, 8]);
    expect(virtualOverflowAt(view.state, 8)).toBe(4);

    expect((virtualSpaceTypingHandler as any).value(view, 5, 5, "X")).toBe(true);
    expect(view.state.doc.toString()).toBe("abcdeXf\nx    X");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("abcdef\nx");
    view.destroy();
  });

  it("does not manufacture a final line merely to clone a caret", () => {
    const disabled = new EditorView({
      state: EditorState.create({ doc: "last", selection: EditorSelection.cursor(4) }),
    });
    expect(cloneCaretBelow(disabled)).toBe(false);
    expect(disabled.state.doc.toString()).toBe("last");
    disabled.destroy();

    const enabled = new EditorView({
      state: EditorState.create({
        doc: "last",
        selection: EditorSelection.cursor(4),
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          editorVirtualSpacePolicy.of({ afterLineEnd: true, atFileBottom: true }),
        ],
      }),
    });
    expect(cloneCaretBelow(enabled)).toBe(false);
    expect(enabled.state.doc.toString()).toBe("last");
    expect(enabled.state.selection.ranges.map((range) => range.head)).toEqual([4]);
    enabled.destroy();
  });

  it("moves a syntax statement and falls back to line movement", () => {
    const syntaxView = new EditorView({
      state: EditorState.create({
        doc: "const first = 1;\nconst second = 2;",
        selection: EditorSelection.cursor(3),
        extensions: [javascript()],
      }),
    });
    expect(moveStatementDown(syntaxView)).toBe(true);
    expect(syntaxView.state.doc.toString()).toBe("const second = 2;\nconst first = 1;");
    syntaxView.destroy();

    const textView = new EditorView({
      state: EditorState.create({ doc: "first\nsecond", selection: EditorSelection.cursor(1) }),
    });
    expect(moveStatementDown(textView)).toBe(true);
    expect(textView.state.doc.toString()).toBe("second\nfirst");
    textView.destroy();
  });

  it("provides nested named region folding", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "//region outer\na\n//region inner\nb\n//endregion\nc\n//endregion",
        extensions: [tsRegionFoldService],
      }),
    });
    const outer = view.state.doc.line(1);
    const inner = view.state.doc.line(3);
    expect(foldable(view.state, outer.from, outer.to)).toEqual({
      from: outer.to,
      to: view.state.doc.line(7).from,
    });
    expect(foldable(view.state, inner.from, inner.to)).toEqual({
      from: inner.to,
      to: view.state.doc.line(5).from,
    });
    view.destroy();
  });

  it("folds an explicit selection without changing the document", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "line one\nline two",
        selection: EditorSelection.range(0, 8),
      }),
    });
    expect(foldSelection(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("line one\nline two");
    view.destroy();
  });

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

  it("keeps only unowned local editor shortcuts in the CodeMirror keymap", () => {
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
      "Mod-Shift-j",
      "Ctrl-Shift-j",
      "Shift-Alt-j",
      "Mod-Shift-u",
      "Ctrl-Shift-u",
      "Tab",
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
        extensions: [
          javascript(),
          EditorState.allowMultipleSelections.of(true),
          occurrenceSessionField,
        ],
      }),
    });

    // 1st Alt-J: selects current word 'alpha'
    expect(selectNextEditorOccurrence(view)).toBe(true);
    expect(view.state.field(occurrenceSessionField)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("alpha");
    expect(view.state.selection.ranges).toHaveLength(1);

    // 2nd Alt-J: adds 2nd occurrence of 'alpha'
    expect(selectNextEditorOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(2);

    // 3rd Alt-J: adds 3rd occurrence of 'alpha'
    expect(selectNextEditorOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(3);

    // Shift-Alt-J: unselects last occurrence
    expect(unselectOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(2);

    expect(unselectOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(1);

    expect(unselectOccurrence(view)).toBe(false);
    view.destroy();
  });

  it("clears an occurrence session before collapsing to the primary caret", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "alpha alpha alpha",
        selection: EditorSelection.cursor(2),
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          occurrenceSessionField,
        ],
      }),
    });
    expect(selectNextEditorOccurrence(view)).toBe(true);
    expect(selectNextEditorOccurrence(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(2);

    expect(escapeEditorSelections(view)).toBe(true);
    expect(view.state.field(occurrenceSessionField)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(2);
    const primary = view.state.selection.main;

    expect(escapeEditorSelections(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main.eq(primary)).toBe(true);
    expect(escapeEditorSelections(view)).toBe(false);
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
        doc,
        selection: { anchor: 8 }, // inside 'identifier'
      }),
    });

    expect(toggleCase(caretView)).toBe(true);
    expect(caretView.state.doc.toString()).toBe("const MYVARIABLE = 'hello';");

    view.destroy();
    caretView.destroy();
  });

  it("joins current line with next line collapsing whitespace with Ctrl+Shift+J", () => {
    const doc = "const a = 1;\n  const b = 2;\nconst c = 3;";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 5 }, // on line 1
      }),
    });

    expect(joinLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("const a = 1; const b = 2;\nconst c = 3;");
    view.destroy();
  });

  it("sorts selected lines alphabetically with sortLines", () => {
    const doc = "zebra\napple\nbanana";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: doc.length },
      }),
    });

    expect(sortLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("apple\nbanana\nzebra");
    view.destroy();
  });

  it("reverses selected lines with reverseLines", () => {
    const doc = "first\nsecond\nthird";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: doc.length },
      }),
    });

    expect(reverseLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("third\nsecond\nfirst");
    view.destroy();
  });

  it("transposes adjacent lines with transposeLines", () => {
    const doc = "line 1\nline 2\nline 3";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 2 }, // on line 1
      }),
    });

    expect(transposeLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("line 2\nline 1\nline 3");
    view.destroy();
  });

  it("jumps out of closing brackets with Tab key", () => {
    const doc = "foo()";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 4 }, // between ( and )
      }),
    });

    expect(tabJumpOut(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(5); // jumped past )
    view.destroy();
  });

  it("unwraps enclosing parentheses and quotes with unwrapRemove", () => {
    const doc = 'const name = ("hello");';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 16 }, // inside "hello"
      }),
    });

    expect(unwrapRemove(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('const name = "hello";');
    view.destroy();
  });

  it("folds regions defined with Python, SQL, and HTML comment styles", () => {
    const pyView = new EditorView({
      state: EditorState.create({
        doc: "# region Python Block\nx = 1\n# endregion",
        extensions: [pyRegionFoldService],
      }),
    });
    const pyLine = pyView.state.doc.line(1);
    expect(foldable(pyView.state, pyLine.from, pyLine.to)).toEqual({
      from: pyLine.to,
      to: pyView.state.doc.line(3).from,
    });
    pyView.destroy();

    const sqlView = new EditorView({
      state: EditorState.create({
        doc: "-- #region SQL Block\nSELECT 1;\n-- #endregion",
        extensions: [sqlRegionFoldService],
      }),
    });
    const sqlLine = sqlView.state.doc.line(1);
    expect(foldable(sqlView.state, sqlLine.from, sqlLine.to)).toEqual({
      from: sqlLine.to,
      to: sqlView.state.doc.line(3).from,
    });
    sqlView.destroy();
  });

  it("builds rectangular paste plan preserving column geometry across lines", () => {
    const state = EditorState.create({
      doc: "aaa\nbbb\nccc",
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(4),
        EditorSelection.cursor(8),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const plan = buildMultiCaretPastePlan(state, {
      plainText: "1\n2\n3",
      segments: ["1", "2", "3"],
      sourceEol: "lf",
      rectangular: true,
    });

    expect(plan).not.toBeNull();
    expect(plan?.changes).toHaveLength(3);
    const updated = state.update({ changes: plan!.changes });
    expect(updated.state.doc.toString()).toBe("1aaa\n2bbb\n3ccc");
  });
});

describe("N9.3/N14.4 region grammar strategy", () => {
  it("never folds regions in unknown languages (typed unavailable)", () => {
    const cssService = createRegionFoldService(() => "src/theme.css");
    const view = new EditorView({
      state: EditorState.create({
        doc: "// #region styles\n.a {}\n// #endregion",
        extensions: [cssService],
      }),
    });
    const line = view.state.doc.line(1);
    expect(foldable(view.state, line.from, line.to)).toBeNull();
    expect(regionFoldAvailableForPath("src/theme.css")).toBe(false);
    expect(regionFoldAvailableForPath("src/Main.java")).toBe(true);
    view.destroy();
  });

  it("does not fold a marker behind another language's comment token", () => {
    // Python file containing a Java-style marker: the '#' grammar must not
    // accept '// #region'.
    const view = new EditorView({
      state: EditorState.create({
        doc: "// #region java style\nx = 1\n// #endregion",
        extensions: [pyRegionFoldService],
      }),
    });
    const line = view.state.doc.line(1);
    expect(foldable(view.state, line.from, line.to)).toBeNull();
    view.destroy();
  });

  it("marks region folding provenance as explicit-comment, language-syntax, or indent-fallback", () => {
    // Comment node present -> explicit-comment
    const commentNode = { name: "LineComment" };
    expect(regionFoldingProvenance(commentNode)).toBe("explicit-comment");
    expect(regionFoldingProvenanceLabel(regionFoldingProvenance(commentNode))).toBe("explicit-comment");

    // Syntax block node present -> language-syntax
    const syntaxNode = { name: "Block" };
    expect(regionFoldingProvenance(syntaxNode)).toBe("language-syntax");
    expect(regionFoldingProvenanceLabel(regionFoldingProvenance(syntaxNode))).toBe("language-syntax");

    // Null / empty node / indent -> indent-fallback
    expect(regionFoldingProvenance(null)).toBe("indent-fallback");
    expect(regionFoldingProvenanceLabel(regionFoldingProvenance(null))).toBe("indent-fallback");

    const emptyNode = { name: "" };
    expect(regionFoldingProvenance(emptyNode)).toBe("indent-fallback");
    expect(regionFoldingProvenanceLabel(regionFoldingProvenance(emptyNode))).toBe("indent-fallback");
  });
});
