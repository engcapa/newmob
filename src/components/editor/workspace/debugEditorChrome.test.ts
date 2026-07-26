import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebugEditorChrome, type DebugEditorActions } from "./debugEditorChrome";
import type { DebugStepAction } from "./dapDebugModel";

const DOC = [
  "class App {",
  "  void run() {",
  "    int sum = 0;",
  "    sum += 1;",
  "  }",
  "}",
].join("\n");

let view: EditorView | null = null;

function mount(
  options: Partial<Parameters<typeof createDebugEditorChrome>[0]> & { actions: DebugEditorActions },
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      extensions: [createDebugEditorChrome({ markers: [], currentLine: null, ...options })],
    }),
  });
  return view;
}

/** Drive a key through the editor's keymap the way the browser would. */
function press(target: EditorView, key: string, modifiers: Partial<KeyboardEvent> = {}): void {
  target.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true, ...modifiers,
  }));
}

function noopActions(overrides: Partial<DebugEditorActions> = {}): DebugEditorActions {
  return { toggleBreakpoint: vi.fn(), editBreakpoint: vi.fn(), ...overrides };
}

describe("debugEditorChrome", () => {
  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = "";
  });

  it("binds IDEA's stepping keys to the session", () => {
    const actions: DebugStepAction[] = [];
    const editor = mount({
      actions: noopActions({ step: (action) => { actions.push(action); return true; } }),
    });
    press(editor, "F9");
    press(editor, "F8");
    press(editor, "F7");
    press(editor, "F8", { shiftKey: true });
    expect(actions).toEqual(["continue", "stepOver", "stepIn", "stepOut"]);
  });

  it("toggles and edits a breakpoint on the caret line via the keyboard", () => {
    const toggleBreakpoint = vi.fn();
    const editBreakpoint = vi.fn();
    const editor = mount({ actions: noopActions({ toggleBreakpoint, editBreakpoint }) });
    // Put the caret on line 4 ("sum += 1;").
    editor.dispatch({ selection: { anchor: editor.state.doc.line(4).from } });
    press(editor, "F8", { ctrlKey: true });
    expect(toggleBreakpoint).toHaveBeenCalledWith(4);
    press(editor, "F8", { ctrlKey: true, shiftKey: true });
    expect(editBreakpoint).toHaveBeenCalledWith(4);
  });

  it("runs to the caret line and stops the session", () => {
    const runToCursor = vi.fn(() => true);
    const stop = vi.fn(() => true);
    const editor = mount({ actions: noopActions({ runToCursor, stop }) });
    editor.dispatch({ selection: { anchor: editor.state.doc.line(3).from } });
    press(editor, "F9", { altKey: true });
    expect(runToCursor).toHaveBeenCalledWith(3);
    press(editor, "F2", { ctrlKey: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves the stepping keys alone when no session is running", () => {
    // No `step`/`stop` action: the keys must not be swallowed by the debugger.
    const editor = mount({ actions: noopActions() });
    const event = new KeyboardEvent("keydown", { key: "F8", bubbles: true, cancelable: true });
    editor.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders breakpoint state in the gutter", () => {
    const editor = mount({
      markers: [
        { line: 2, conditional: false },
        { line: 3, conditional: true },
        { line: 4, conditional: false, logpoint: true },
        { line: 5, conditional: false, enabled: false },
        { line: 6, conditional: false, verified: false },
      ],
      currentLine: null,
      actions: noopActions(),
    });
    const dots = [...editor.dom.querySelectorAll(".taomni-debug-gutter .cm-gutterElement span")]
      .map((el) => el.textContent)
      .filter((text) => text);
    // Solid = armed, diamond = logpoint, hollow = disabled or unbound.
    expect(dots).toEqual(expect.arrayContaining(["●", "●", "◆", "○", "○"]));
    const disabled = [...editor.dom.querySelectorAll("span")]
      .find((el) => el.title === "Breakpoint disabled");
    expect(disabled).toBeTruthy();
  });

  it("shows inline values up to the stopped line only", () => {
    const editor = mount({
      markers: [],
      currentLine: 3,
      inlineValues: { sum: "0" },
      actions: noopActions(),
    });
    const labels = [...editor.dom.querySelectorAll(".taomni-debug-inline-value")]
      .map((el) => el.textContent?.trim());
    // Line 3 declares `sum`; line 4 also mentions it but has not executed yet.
    expect(labels).toEqual(["sum = 0"]);
  });

  it("adds no inline values without a stopped location", () => {
    const editor = mount({
      markers: [],
      currentLine: null,
      inlineValues: { sum: "0" },
      actions: noopActions(),
    });
    expect(editor.dom.querySelectorAll(".taomni-debug-inline-value")).toHaveLength(0);
  });
});
