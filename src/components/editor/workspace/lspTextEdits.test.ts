import { describe, expect, it } from "vitest";
import {
  applyLspTextEditsToString,
  buildIncrementalContentChange,
  offsetFromLspPositionInString,
  rangeIsEmpty,
} from "./lspTextEdits";
import type { LspTextEdit } from "../../../lib/editor/lsp";

function edit(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string,
): LspTextEdit {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    newText,
  };
}

describe("lspTextEdits", () => {
  it("maps LSP positions to string offsets across newlines", () => {
    const text = "ab\ncde\nf";
    expect(offsetFromLspPositionInString(text, { line: 0, character: 1 })).toBe(1);
    expect(offsetFromLspPositionInString(text, { line: 1, character: 2 })).toBe(5);
    expect(offsetFromLspPositionInString(text, { line: 2, character: 1 })).toBe(8);
  });

  it("applies a single formatting edit", () => {
    // Replace the bare `=` with spaced ` = `.
    expect(applyLspTextEditsToString("x=1", [edit(0, 1, 0, 2, " = ")])).toBe("x = 1");
  });

  it("applies multiple edits from the end so earlier offsets stay valid", () => {
    const text = "a=1\nb=2";
    const next = applyLspTextEditsToString(text, [
      edit(0, 1, 0, 2, " = "),
      edit(1, 1, 1, 2, " = "),
    ]);
    expect(next).toBe("a = 1\nb = 2");
  });

  it("replaces a whole-line range used by range formatting", () => {
    const text = "function f(){\nreturn 1\n}";
    const next = applyLspTextEditsToString(text, [
      edit(1, 0, 1, 8, "  return 1;"),
    ]);
    expect(next).toBe("function f(){\n  return 1;\n}");
  });

  it("returns the original text when there are no edits", () => {
    expect(applyLspTextEditsToString("unchanged", [])).toBe("unchanged");
  });

  it("detects empty ranges", () => {
    expect(rangeIsEmpty({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 4 },
    })).toBe(true);
    expect(rangeIsEmpty({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 5 },
    })).toBe(false);
  });

  it("builds a minimal multiline incremental content change", () => {
    expect(buildIncrementalContentChange(
      "fn main() {\n    old();\n}\n",
      "fn main() {\n    replacement();\n}\n",
    )).toEqual({
      range: {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 7 },
      },
      rangeLength: 3,
      text: "replacement",
    });
  });

  it("uses UTF-16 positions without splitting surrogate pairs", () => {
    expect(buildIncrementalContentChange("let icon = \"😀\";", "let icon = \"😁\";")).toEqual({
      range: {
        start: { line: 0, character: 12 },
        end: { line: 0, character: 14 },
      },
      rangeLength: 2,
      text: "😁",
    });
  });

  it("returns null when the text is unchanged", () => {
    expect(buildIncrementalContentChange("same", "same")).toBeNull();
  });

  it("positions an edit deep in a multi-line document (single-pass end offset)", () => {
    // 2000 identical lines; edit the last one. The end position must still be
    // correct even though the change span is far from offset 0.
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const previous = lines.join("\n");
    const next = `${previous}!`;
    expect(buildIncrementalContentChange(previous, next)).toEqual({
      range: {
        start: { line: 1999, character: 9 },
        end: { line: 1999, character: 9 },
      },
      rangeLength: 0,
      text: "!",
    });
  });

  it("computes a multi-line deletion range across the changed span", () => {
    // Delete two whole middle lines; end position spans multiple newlines from start.
    const previous = "a\nbbb\nccc\nd";
    const next = "a\nd";
    expect(buildIncrementalContentChange(previous, next)).toEqual({
      range: {
        start: { line: 1, character: 0 },
        end: { line: 3, character: 0 },
      },
      rangeLength: 8,
      text: "",
    });
  });
});
