import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  charVisualWidth,
  desiredVisualColumnField,
  documentColumnForVisualColumn,
  measureVisualPositions,
  setVirtualHead,
  virtualBackspaceCommand,
  virtualDeleteCommand,
  virtualEnterCommand,
  virtualEscapeCommand,
  virtualHomeCommand,
  virtualLineEndCommand,
  virtualMoveDown,
  virtualMoveLeftCommand,
  virtualMoveRightCommand,
  virtualOverflowAt,
  virtualSelectDown,
  virtualSpaceClickHandler,
  virtualSpaceKeymap,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
  virtualTabCommand,
  VirtualSpaceController,
  VIRTUAL_SPACE_KNOWN_GAPS,
} from "./workspaceVirtualSpace";
import { editorVirtualSpacePolicy } from "./workspaceEditorCommands";

const POLICY = editorVirtualSpacePolicy.of({ afterLineEnd: true, atFileBottom: true });

function visualColumnOf(text: string, column: number, tabWidth: number): number {
  let visual = 0;
  for (let index = 0; index < column; index += 1) {
    visual += charVisualWidth(text[index], visual, tabWidth);
  }
  return visual;
}

function mount(doc: string, policyEnabled = true): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        // The host enables this globally (§8.18.2); without it CM collapses
        // every secondary caret and multi-caret assertions are meaningless.
        EditorState.allowMultipleSelections.of(true),
        virtualSpaceOverflowField,
        virtualSpaceTypingHandler,
        virtualSpaceClickHandler,
        ...(policyEnabled ? [POLICY] : []),
      ],
    }),
  });
}

describe("§8.19.5 visual column model", () => {
  it("expands tabs to stops and double-width characters", () => {
    expect(charVisualWidth("a", 0, 4)).toBe(1);
    expect(charVisualWidth("\t", 0, 4)).toBe(4);
    expect(charVisualWidth("\t", 3, 4)).toBe(1);
    expect(charVisualWidth("你", 0, 4)).toBe(2);
    expect(charVisualWidth("😀", 0, 4)).toBe(2);
    // Tab stop alignment inside mixed content: a,b at cols 0,1 then tab→4, c→5.
    expect(visualColumnOf("ab\tc", 4, 4)).toBe(5);
  });

  it("measures VisualColumnPosition per caret with policy gates", () => {
    const doc = "ab\nlonger line";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [virtualSpaceOverflowField, POLICY],
    });
    const positions = measureVisualPositions(state, 4);
    expect(positions).toHaveLength(1);
    expect(positions[0].line).toBe(1);
    expect(positions[0].documentColumn).toBe(11); // end of "longer line"
    // atFileBottom on the last line allows virtual columns.
    expect(positions[0].virtualColumns).toBeGreaterThan(0);

    const off = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [virtualSpaceOverflowField],
    });
    expect(measureVisualPositions(off, 4)[0].virtualColumns).toBe(0);
  });
});

describe("§8.19.5 virtual caret lifecycle", () => {
  it("records overflow without doc changes; typing materializes padding in one transaction", () => {
    const view = mount("abc\n");
    view.dispatch({ selection: { anchor: 3 } }); // end of first line

    setVirtualHead(view, 3, 6, false);
    // Caret clamped at the legal offset; overflow recorded; doc untouched.
    expect(view.state.selection.main.head).toBe(3);
    expect(virtualOverflowAt(view.state, 3)).toBe(6);

    // Typing one character consumes the overflow: six spaces + the char.
    // (@codemirror/view 6.43 internalized someProp — drive the facet directly.)
    const handlers = view.state.facet(EditorView.inputHandler);
    // Handlers that claim the input never call insert(); a typed stub keeps
    // the signature honest without building a real Transaction.
    const insertStub = (() => {
      throw new Error("insert() must not be called by a claiming handler");
    }) as unknown as Parameters<(typeof EditorView.inputHandler)["of"]>[0] extends
      (view: never, from: number, to: number, text: string, insert: infer T) => boolean ? T : never;
    let handled = false;
    for (const handler of handlers) {
      if (handler(view, 3, 3, "x", insertStub)) {
        handled = true;
        break;
      }
    }
    if (!handled) throw new Error("typing handler did not claim the input");
    // Caret sat at the end of "abc": padding + x append to THAT line.
    expect(view.state.doc.line(1).text).toBe(`abc${" ".repeat(6)}x`);
    // Overflow collapsed after the doc change (caret now after 'x').
    expect(virtualOverflowAt(view.state, view.state.selection.main.head)).toBe(0);
  });

  it("defers to default behaviour when no overflow exists", () => {
    const view = mount("abc\n");
    view.dispatch({ selection: { anchor: 1 } });
    const handlers = view.state.facet(EditorView.inputHandler);
    const insertStub = (() => {
      throw new Error("insert() must not be called by a claiming handler");
    }) as unknown as Parameters<Parameters<(typeof EditorView.inputHandler)["of"]>[0]>[4];
    const claimed = handlers.some((handler) => handler(view, 1, 1, "x", insertStub));
    expect(claimed).toBe(false);
    expect(view.state.doc.toString()).toBe("abc\n");
  });

  it("backspace inside the virtual region shrinks overflow without doc changes", () => {
    const view = mount("abc\n");
    view.dispatch({ selection: { anchor: 3 } });
    setVirtualHead(view, 3, 3, false);
    expect(virtualBackspaceCommand(view)).toBe(true);
    expect(virtualOverflowAt(view.state, 3)).toBe(2);
    expect(view.state.doc.toString()).toBe("abc\n");
    virtualBackspaceCommand(view);
    virtualBackspaceCommand(view);
    expect(virtualOverflowAt(view.state, 3)).toBe(0);
    // Zero overflow defers to the normal delete command.
    expect(virtualBackspaceCommand(view)).toBe(false);
  });

  it("End walks into the virtual region only past the real line end and only when enabled", () => {
    const view = mount("abc\ndef\n");
    view.dispatch({ selection: { anchor: 1 } });
    // Not at line end yet → defer (default keymap owns the move).
    expect(virtualLineEndCommand(view, false)).toBe(false);
    view.dispatch({ selection: { anchor: 3 } });
    expect(virtualLineEndCommand(view, false)).toBe(true);
    expect(virtualOverflowAt(view.state, 3)).toBe(1);
    virtualLineEndCommand(view, false);
    expect(virtualOverflowAt(view.state, 3)).toBe(2);

    // Policy disabled → no virtual walk, field stays empty.
    const disabled = mount("abc\n", false);
    disabled.dispatch({ selection: { anchor: 3 } });
    expect(virtualLineEndCommand(disabled, false)).toBe(false);
  });

  it("keeps multi-caret overflow maps so paste can pad every caret once", () => {
    const view = mount("ab\ncd\n");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(5)], 0),
    });
    setVirtualHead(view, 2, 4, false);
    expect(virtualOverflowAt(view.state, 2)).toBe(4);
    expect(view.state.selection.ranges).toHaveLength(2);
  });

  it("maps visual columns back to document character indices with tabs and wide characters", () => {
    // "ab\tc": cols 0, 1 -> 'a','b'; tab width is 4 so col 2..3 is tab, col 4 is 'c'
    expect(documentColumnForVisualColumn("ab\tc", 0, 4)).toBe(0);
    expect(documentColumnForVisualColumn("ab\tc", 1, 4)).toBe(1);
    expect(documentColumnForVisualColumn("ab\tc", 4, 4)).toBe(3); // index of 'c'
    // CJK character "你" takes 2 columns
    expect(documentColumnForVisualColumn("你好", 0, 4)).toBe(0);
    expect(documentColumnForVisualColumn("你好", 2, 4)).toBe("你".length);
  });

  it("moves vertically while preserving desired visual column across short and long lines", () => {
    // Line 0: "hello world" (length 11)
    // Line 1: "hi" (length 2)
    // Line 2: "goodbye world" (length 13)
    const doc = "hello world\nhi\ngoodbye world";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          virtualSpaceOverflowField,
          desiredVisualColumnField,
          POLICY,
        ],
      }),
    });

    // Start at end of line 0 (offset 11)
    view.dispatch({ selection: { anchor: 11 } });
    expect(view.state.selection.main.head).toBe(11);

    // Move down to Line 1 ("hi"): since line 1 has length 2 < 11, caret clamps to line end (offset 14),
    // and virtual overflow is 11 - 2 = 9.
    expect(virtualMoveDown(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(14); // "hello world\nhi" -> 11 + 1 + 2 = 14
    expect(virtualOverflowAt(view.state, 14)).toBe(9);

    // Move down to Line 2 ("goodbye world"): desired column 11 is remembered!
    // Since Line 2 has length 13 > 11, caret lands on column 11 of line 2, overflow collapses to 0.
    expect(virtualMoveDown(view)).toBe(true);
    const line2 = view.state.doc.line(3);
    expect(view.state.selection.main.head).toBe(line2.from + 11);
    expect(virtualOverflowAt(view.state, line2.from + 11)).toBe(0);
  });

  it("extends selection into virtual space with virtualSelectDown", () => {
    const doc = "first line\nshort\nthird line here";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          virtualSpaceOverflowField,
          desiredVisualColumnField,
          POLICY,
        ],
      }),
    });

    // Start anchor at offset 0, cursor at offset 10 (end of line 1)
    view.dispatch({ selection: EditorSelection.range(0, 10) });

    // Select down into line 2 ("short" length 5 < 10)
    expect(virtualSelectDown(view)).toBe(true);
    // Selection anchor remains 0, head moves to line 2 EOL (offset 16) with virtual overflow 5
    expect(view.state.selection.main.anchor).toBe(0);
    expect(view.state.selection.main.head).toBe(16);
    expect(virtualOverflowAt(view.state, 16)).toBe(5);
  });

  it("documents known gaps honestly in VIRTUAL_SPACE_KNOWN_GAPS", () => {
    expect(VIRTUAL_SPACE_KNOWN_GAPS).toBeInstanceOf(Array);
    const features = VIRTUAL_SPACE_KNOWN_GAPS.map((g) => g.feature);
    expect(features).toContain("soft-wrap");
    expect(features).toContain("rectangular-selection");
    expect(features).toContain("indent-folding-fallback");
  });

  describe("§8.22.5 U2-C Virtual Space Keymap Closure", () => {
    it("handles virtualMoveLeft and virtualMoveRight within virtual space", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "line",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      // Place cursor at line end (offset 4)
      view.dispatch({ selection: EditorSelection.cursor(4) });

      // Move right into virtual space
      expect(virtualMoveRightCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(1);
      expect(virtualMoveRightCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(2);

      // Move left back towards real line end
      expect(virtualMoveLeftCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(1);
      expect(virtualMoveLeftCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(0);
    });

    it("clears virtual overflow on Home without dirtying document", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "  indented text",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 15, 10, false);
      expect(virtualOverflowAt(view.state, 15)).toBe(10);

      expect(virtualHomeCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, view.state.selection.main.head)).toBe(0);
      expect(view.state.selection.main.head).toBe(2); // Indent position
      expect(view.state.doc.toString()).toBe("  indented text");
    });

    it("clears virtual overflow on Escape without modifying document", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "const answer = 42;",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 18, 8, false);
      expect(virtualOverflowAt(view.state, 18)).toBe(8);

      expect(virtualEscapeCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, 18)).toBe(0);
      expect(view.state.doc.toString()).toBe("const answer = 42;");
    });

    it("pads line with trailing spaces and newline on virtual Enter", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "hello",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 5, 4, false);
      expect(virtualEnterCommand(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("hello    \n");
    });

    it("snaps to next tab stop on virtual Tab", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "abc",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      view.dispatch({ selection: EditorSelection.cursor(3) });
      expect(virtualTabCommand(view)).toBe(true);
      // "abc" has length 3, tab stop is 4, so overflow becomes 1
      expect(virtualOverflowAt(view.state, 3)).toBe(1);

      // Second tab snaps from visual 4 to visual 8 (overflow +4 -> 5)
      expect(virtualTabCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, 3)).toBe(5);
    });

    it("exports complete virtualSpaceKeymap and VirtualSpaceController", () => {
      expect(virtualSpaceKeymap.length).toBeGreaterThanOrEqual(15);
      const keys = virtualSpaceKeymap.map((b) => b.key);
      expect(keys).toContain("ArrowUp");
      expect(keys).toContain("ArrowDown");
      expect(keys).toContain("ArrowLeft");
      expect(keys).toContain("ArrowRight");
      expect(keys).toContain("Home");
      expect(keys).toContain("End");
      expect(keys).toContain("Backspace");
      expect(keys).toContain("Delete");
      expect(keys).toContain("Enter");
      expect(keys).toContain("Tab");
      expect(keys).toContain("Escape");

      expect(VirtualSpaceController.keymap).toBe(virtualSpaceKeymap);
    });
  });
});
