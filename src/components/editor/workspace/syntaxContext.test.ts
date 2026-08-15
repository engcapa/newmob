import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { java } from "@codemirror/lang-java";
import { isInsideStringOrComment } from "./syntaxContext";

describe("isInsideStringOrComment", () => {
  it("detects positions inside Java string literals", () => {
    const code = 'String firstStr = "this is another ";';
    const state = EditorState.create({
      doc: code,
      extensions: [java()],
    });
    // Position inside the string literal
    const posInside = code.indexOf("another") + 2;
    expect(isInsideStringOrComment(state, posInside)).toBe(true);

    // Position outside the string literal
    const posOutside = code.indexOf("firstStr");
    expect(isInsideStringOrComment(state, posOutside)).toBe(false);
  });

  it("detects positions inside single-line comments", () => {
    const code = 'int x = 10; // this is a comment with if\nint y = 20;';
    const state = EditorState.create({
      doc: code,
      extensions: [java()],
    });
    const posComment = code.indexOf("comment");
    expect(isInsideStringOrComment(state, posComment)).toBe(true);

    const posCode = code.indexOf("int y");
    expect(isInsideStringOrComment(state, posCode)).toBe(false);
  });

  it("detects positions inside double quotes on unparsed / plain states using lexical fallback", () => {
    const code = 'String s = "hello world";';
    const state = EditorState.create({
      doc: code,
    });
    const posInside = code.indexOf("world");
    expect(isInsideStringOrComment(state, posInside)).toBe(true);

    const posOutside = code.indexOf("String");
    expect(isInsideStringOrComment(state, posOutside)).toBe(false);
  });
});
