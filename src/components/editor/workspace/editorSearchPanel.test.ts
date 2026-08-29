import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchQuery, search } from "@codemirror/search";
import {
  applyPreserveCase,
  detectCasing,
  replaceAllPreserveCase,
  replaceNextPreserveCase,
} from "./editorSearchPanel";

describe("§8.26 / ED-FIND-001: editorSearchPanel Preserve Case", () => {
  it("accurately detects casing styles across words and identifiers", () => {
    expect(detectCasing("FOO_BAR")).toBe("upper");
    expect(detectCasing("ALPHA")).toBe("upper");
    expect(detectCasing("foo_bar")).toBe("lower");
    expect(detectCasing("alpha")).toBe("lower");
    expect(detectCasing("Alpha")).toBe("title");
    expect(detectCasing("FooBar")).toBe("pascal");
    expect(detectCasing("fooBar")).toBe("camel");
    expect(detectCasing("123")).toBe("other");
    expect(detectCasing("")).toBe("other");
  });

  it("applies case preservation to replacement strings matching target patterns", () => {
    // UPPERCASE
    expect(applyPreserveCase("FOO", "bar")).toBe("BAR");
    expect(applyPreserveCase("HELLO_WORLD", "foo_bar")).toBe("FOO_BAR");

    // lowercase
    expect(applyPreserveCase("foo", "BAR")).toBe("bar");
    expect(applyPreserveCase("hello_world", "FOO_BAR")).toBe("foo_bar");

    // Title Case
    expect(applyPreserveCase("Foo", "bar")).toBe("Bar");
    expect(applyPreserveCase("Alpha", "omega")).toBe("Omega");

    // PascalCase
    expect(applyPreserveCase("FooBar", "alphaBeta")).toBe("AlphaBeta");

    // camelCase
    expect(applyPreserveCase("fooBar", "AlphaBeta")).toBe("alphaBeta");

    // Zero-length / empty
    expect(applyPreserveCase("", "fallback")).toBe("fallback");
  });

  it("replaces all matches in CodeMirror buffer with preserved casing", () => {
    const doc = "FOO foo Foo fooBar FooBar";
    const state = EditorState.create({
      doc,
      extensions: [search()],
    });
    const view = new EditorView({ state });

    const query = new SearchQuery({
      search: "foo",
      replace: "bar",
      caseSensitive: false,
      wholeWord: false,
    });

    const replaced = replaceAllPreserveCase(view, query, true);
    expect(replaced).toBe(true);
    expect(view.state.doc.toString()).toBe("BAR bar Bar barBar BarBar");
  });

  it("replaces next match sequentially while preserving case", () => {
    const doc = "FOO foo Foo";
    const state = EditorState.create({
      doc,
      extensions: [search()],
    });
    const view = new EditorView({ state });

    const query = new SearchQuery({
      search: "foo",
      replace: "bar",
      caseSensitive: false,
    });

    // First replace (FOO -> BAR)
    replaceNextPreserveCase(view, query, true);
    expect(view.state.doc.toString()).toBe("BAR foo Foo");

    // Second replace (foo -> bar)
    replaceNextPreserveCase(view, query, true);
    expect(view.state.doc.toString()).toBe("BAR bar Foo");

    // Third replace (Foo -> Bar)
    replaceNextPreserveCase(view, query, true);
    expect(view.state.doc.toString()).toBe("BAR bar Bar");
  });
});
