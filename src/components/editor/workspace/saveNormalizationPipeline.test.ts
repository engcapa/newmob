import { describe, expect, it, vi } from "vitest";
import {
  trimTrailingWhitespace,
  adjustFinalNewline,
  normalizeLineEndings,
  runSaveNormalizationPipeline,
} from "./saveNormalizationPipeline";
import type { EffectiveCodeStyle } from "./codeStyleModel";

describe("saveNormalizationPipeline", () => {
  it("trims trailing whitespace on every line", () => {
    const raw = "const x = 1;   \nconst y = 2;\t\t\n\nconst z = 3; ";
    const trimmed = trimTrailingWhitespace(raw);
    expect(trimmed).toBe("const x = 1;\nconst y = 2;\n\nconst z = 3;");
  });

  it("adjusts final newline correctly", () => {
    expect(adjustFinalNewline("hello\n\n\n", true)).toBe("hello\n");
    expect(adjustFinalNewline("hello", true)).toBe("hello\n");
    expect(adjustFinalNewline("hello\n\n", false)).toBe("hello");
  });

  it("normalizes line endings to LF, CRLF, and CR", () => {
    const mixed = "line1\r\nline2\rline3\nline4";
    expect(normalizeLineEndings(mixed, "lf")).toBe("line1\nline2\nline3\nline4");
    expect(normalizeLineEndings(mixed, "crlf")).toBe("line1\r\nline2\r\nline3\r\nline4");
    expect(normalizeLineEndings(mixed, "cr")).toBe("line1\rline2\rline3\rline4");
  });

  it("runs full normalization pipeline in sequence", async () => {
    const codeStyle: EffectiveCodeStyle = {
      tabSize: 4,
      indentSize: 4,
      continuationIndent: 8,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      endOfLine: "lf",
      source: "editorconfig",
      label: "Spaces: 4 (EditorConfig)",
    };

    const input = "function hello() {   \r\n    return 42;\t\r\n}\r\n\r\n";
    const result = await runSaveNormalizationPipeline({
      text: input,
      codeStyle,
    });

    expect(result.text).toBe("function hello() {\n    return 42;\n}\n");
    expect(result.whitespaceTrimmed).toBe(true);
    expect(result.eolNormalized).toBe(true);
    expect(result.cancelledDueToEdit).toBe(false);
  });

  it("aborts when buffer was modified concurrently during formatting", async () => {
    let currentBufferVersion = 1;

    const formatFn = vi.fn(async (text: string) => {
      // Simulate typing happening in parallel
      currentBufferVersion = 2;
      return text.replace("42", "100");
    });

    const codeStyle: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      source: "language-default",
      label: "Spaces: 2",
    };

    const result = await runSaveNormalizationPipeline({
      text: "const a = 42;",
      codeStyle,
      formatOnSave: true,
      formatFn,
      expectedVersion: 1,
      getLatestBufferVersion: () => currentBufferVersion,
    });

    expect(result.cancelledDueToEdit).toBe(true);
  });

  it("handles utf-8 and utf-8-bom charset normalization", async () => {
    // utf-8 strips BOM
    const utf8Style: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      charset: "utf-8",
      source: "editorconfig",
      label: "Spaces: 2",
    };
    const res1 = await runSaveNormalizationPipeline({
      text: "\uFEFFconst a = 1;",
      codeStyle: utf8Style,
    });
    expect(res1.text).toBe("const a = 1;");

    // utf-8-bom ensures BOM
    const utf8BomStyle: EffectiveCodeStyle = {
      ...utf8Style,
      charset: "utf-8-bom",
    };
    const res2 = await runSaveNormalizationPipeline({
      text: "const a = 1;",
      codeStyle: utf8BomStyle,
    });
    expect(res2.text).toBe("\uFEFFconst a = 1;");
  });
});
