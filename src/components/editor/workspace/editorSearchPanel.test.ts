import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { SearchQuery, search } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { java } from "@codemirror/lang-java";
import {
  applyPreserveCase,
  detectCasing,
  getFilteredMatches,
  isSyntaxFilterAvailable,
  matchContextFilter,
  replaceAllPreserveCase,
  replaceNextPreserveCase,
  selectAllOccurrences,
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

  it("expands regex groups and composes preserve case with whole-word matching", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "FOOBAR fooBar foobarbaz",
        extensions: [search()],
      }),
    });
    const query = new SearchQuery({
      search: "(foo)(bar)",
      replace: "$2_$1",
      caseSensitive: false,
      wholeWord: true,
      regexp: true,
    });

    expect(replaceAllPreserveCase(view, query, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("BAR_FOO bar_foo foobarbaz");
  });

  it("records replace-all as one undo transaction", () => {
    const original = "FOO foo Foo";
    const view = new EditorView({
      state: EditorState.create({
        doc: original,
        extensions: [search(), history()],
      }),
    });
    const query = new SearchQuery({
      search: "foo",
      replace: "bar",
      caseSensitive: false,
    });

    expect(replaceAllPreserveCase(view, query, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("BAR bar Bar");
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
  });
});

describe("ED-FIND-002: selection / comments / strings search filtering", () => {
  it("determines syntax filter availability accurately", () => {
    const plainState = EditorState.create({ doc: "hello world" });
    expect(isSyntaxFilterAvailable(plainState)).toBe(false);

    const jsState = EditorState.create({
      doc: "const x = 1; // comment",
      extensions: [javascript()],
    });
    expect(isSyntaxFilterAvailable(jsState)).toBe(true);

    const javaState = EditorState.create({
      doc: "class App { String s = \"val\"; }",
      extensions: [java()],
    });
    expect(isSyntaxFilterAvailable(javaState)).toBe(true);
  });

  it("filters search matches by comments, strings, and excluding comments", () => {
    const code = `
      // findMe in single-line comment
      /* findMe in multi-line block */
      const findMe = "findMe inside string literal";
    `;
    const state = EditorState.create({
      doc: code,
      extensions: [javascript()],
    });

    const query = new SearchQuery({
      search: "findMe",
      caseSensitive: true,
    });

    // Anywhere -> 4 matches
    const allMatches = getFilteredMatches(state, query, { contextFilter: "anywhere" });
    expect(allMatches.length).toBe(4);

    // Comments only -> 2 matches
    const commentMatches = getFilteredMatches(state, query, { contextFilter: "comments" });
    expect(commentMatches.length).toBe(2);

    // Strings only -> 1 match
    const stringMatches = getFilteredMatches(state, query, { contextFilter: "strings" });
    expect(stringMatches.length).toBe(1);

    // Exclude comments -> 2 matches (code identifier + string literal)
    const noCommentMatches = getFilteredMatches(state, query, { contextFilter: "exclude-comments" });
    expect(noCommentMatches.length).toBe(2);

    // Direct matchContextFilter checks
    expect(matchContextFilter(state, commentMatches[0].from, commentMatches[0].to, "comments")).toBe(true);
    expect(matchContextFilter(state, stringMatches[0].from, stringMatches[0].to, "strings")).toBe(true);
    expect(matchContextFilter(state, stringMatches[0].from, stringMatches[0].to, "comments")).toBe(false);
  });

  it("bounds search to selection range when inSelection is enabled", () => {
    const code = "foo 123 foo 456 foo 789 foo";
    const state = EditorState.create({
      doc: code,
      extensions: [javascript()],
    });

    const query = new SearchQuery({
      search: "foo",
      caseSensitive: true,
    });

    // In selection between char 5 and 20 ("foo 456 foo")
    const inSelMatches = getFilteredMatches(state, query, {
      inSelection: true,
      selectionRange: { from: 5, to: 20 },
    });
    expect(inSelMatches.length).toBe(2);
  });

  it("selects all matching occurrences with multiple selections", () => {
    const code = "foo bar foo baz foo";
    const state = EditorState.create({
      doc: code,
      extensions: [javascript(), EditorState.allowMultipleSelections.of(true)],
    });
    const view = new EditorView({ state });

    const query = new SearchQuery({
      search: "foo",
      caseSensitive: true,
    });

    const success = selectAllOccurrences(view, query, { contextFilter: "anywhere" });
    expect(success).toBe(true);
    expect(view.state.selection.ranges.length).toBe(3);
    expect(view.state.selection.ranges[0].from).toBe(0);
    expect(view.state.selection.ranges[0].to).toBe(3);
  });
});
