import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  charVisualWidth,
  measureVisualPositions,
  setVirtualHead,
  virtualBackspaceCommand,
  virtualLineEndCommand,
  virtualOverflowAt,
  virtualSpaceClickHandler,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
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
});
