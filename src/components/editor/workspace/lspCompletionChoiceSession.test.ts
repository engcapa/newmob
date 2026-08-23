import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  activeLspSnippetChoices,
  advanceLspSnippetTabstop,
  cycleLspSnippetChoice,
  lspSnippetSessionInvalidator,
  seedLspSnippetSessionForTest,
} from "./lspCompletion";

function mountView(initial: string) {
  const state = EditorState.create({
    doc: initial,
    extensions: [lspSnippetSessionInvalidator()],
    selection: EditorSelection.cursor(0),
  });
  return new EditorView({ state, parent: document.body });
}

describe("§8.18.3 interactive choice session", () => {
  it("reports choice options for the active stop", () => {
    const view = mountView("Alpha(args);");
    seedLspSnippetSessionForTest(view, "${1|Alpha,Beta|}(args);");
    expect(activeLspSnippetChoices(view)).toEqual(["Alpha", "Beta"]);
    view.destroy();
  });

  it("Tab cycles to the next option in one transaction and keeps the session", () => {
    const view = mountView("Alpha(x);");
    seedLspSnippetSessionForTest(view, "${1|Alpha,Beta,Gamma|}(x);");
    expect(cycleLspSnippetChoice(view)).toBe(true);
    // First cycle from the default moves to the SECOND option.
    expect(view.state.doc.toString()).toBe("Beta(x);");
    expect(view.state.selection.main.head).toBe(4);
    // Session survived its own edit and can keep cycling.
    expect(activeLspSnippetChoices(view)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(cycleLspSnippetChoice(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Gamma(x);");
    expect(cycleLspSnippetChoice(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Alpha(x);");
    view.destroy();
  });

  it("later tabstops remap when a choice changes the length", () => {
    const view = mountView("AaB;");
    seedLspSnippetSessionForTest(view, "A${1|a,bbbb|}B;");
    expect(cycleLspSnippetChoice(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("AbbbbB;");
    // Only one placeholder exists; after cycling there is no next stop.
    expect(advanceLspSnippetTabstop(view)).toBe(false);
    view.destroy();
  });

  it("plain stops without options fall through to normal tabstop advance", () => {
    const view = mountView("name;;");
    seedLspSnippetSessionForTest(view, "${1:name};$2");
    expect(activeLspSnippetChoices(view)).toBeNull();
    expect(cycleLspSnippetChoice(view)).toBe(false);
    // Plain stops still advance normally (to the bare $2), then exhaust.
    expect(advanceLspSnippetTabstop(view)).toBe(true);
    expect(advanceLspSnippetTabstop(view)).toBe(false);
    view.destroy();
  });
});
