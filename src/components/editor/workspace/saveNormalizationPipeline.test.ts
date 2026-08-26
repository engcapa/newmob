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

  it("preserves CRLF and bare CR during whitespace trimming when endOfLine is not configured", async () => {
    const noEolStyle: EffectiveCodeStyle = {
      tabSize: 4,
      indentSize: 4,
      continuationIndent: 8,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      source: "language-default",
      label: "Spaces: 4",
    };

    const crlfInput = "const x = 1;  \r\nconst y = 2;  \r\n";
    const crlfResult = await runSaveNormalizationPipeline({
      text: crlfInput,
      codeStyle: noEolStyle,
    });
    expect(crlfResult.text).toBe("const x = 1;\r\nconst y = 2;\r\n");

    const bareCrInput = "const x = 1;  \rconst y = 2;  \r";
    const bareCrResult = await runSaveNormalizationPipeline({
      text: bareCrInput,
      codeStyle: noEolStyle,
    });
    expect(bareCrResult.text).toBe("const x = 1;\rconst y = 2;\r");
  });

  it("blocks saving when characters cannot be represented in Latin-1", async () => {
    const latin1Style: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      charset: "latin1",
      source: "editorconfig",
      label: "Spaces: 2",
    };

    const result = await runSaveNormalizationPipeline({
      text: "const message = '你好世界';", // Chinese characters exceed Latin-1 (code > 255)
      codeStyle: latin1Style,
    });

    expect(result.encodingError).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain("cannot be represented in Latin-1");
  });

  it("populates resolvedEol, resolvedCharset, and resolvedBom in result", async () => {
    const style: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      endOfLine: "crlf",
      charset: "utf-8-bom",
      source: "editorconfig",
      label: "Spaces: 2",
    };

    const result = await runSaveNormalizationPipeline({
      text: "hello world",
      codeStyle: style,
    });

    expect(result.resolvedEol).toBe("crlf");
    expect(result.resolvedCharset).toBe("UTF-8");
    expect(result.resolvedBom).toBe(true);
  });

  it("reports stages executed in order format -> organize-imports -> normalization", async () => {
    const style: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      source: "scheme",
      label: "Spaces: 2",
    };

    const formatFn = vi.fn(async (text: string) => `/* formatted */\n${text}`);
    const organizeImportsFn = vi.fn(async (text: string) => `import A;\n${text}`);

    const result = await runSaveNormalizationPipeline({
      text: "const x = 1;   \n",
      codeStyle: style,
      formatOnSave: true,
      formatFn,
      organizeImportsOnSave: true,
      organizeImportsFn,
    });

    expect(result.formatted).toBe(true);
    expect(result.importsOrganized).toBe(true);
    expect(result.whitespaceTrimmed).toBe(true);
    expect(result.stages).toEqual([
      { stage: "format", status: "executed" },
      { stage: "organize-imports", status: "executed" },
      { stage: "normalization", status: "executed" },
    ]);
    expect(result.text).toBe("import A;\n/* formatted */\nconst x = 1;\n");
  });

  it("stops subsequent effectful provider stages on format error but preserves user text through normalization", async () => {
    const style: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      source: "scheme",
      label: "Spaces: 2",
    };

    const formatFn = vi.fn(async () => {
      throw new Error("LSP formatter crashed");
    });
    const organizeImportsFn = vi.fn(async (text: string) => `import B;\n${text}`);

    const userText = "const draft = 42;   \n";
    const result = await runSaveNormalizationPipeline({
      text: userText,
      codeStyle: style,
      formatOnSave: true,
      formatFn,
      organizeImportsOnSave: true,
      organizeImportsFn,
    });

    expect(result.formatted).toBe(false);
    expect(organizeImportsFn).not.toHaveBeenCalled();
    expect(result.stages[0]).toMatchObject({ stage: "format", status: "failed" });
    expect(result.stages[1]).toMatchObject({ stage: "organize-imports", status: "failed" });
    expect(result.stages[2]).toMatchObject({ stage: "normalization", status: "executed" });
    // User text preserved with safe whitespace trimming, never dropped!
    expect(result.text).toBe("const draft = 42;\n");
  });
});
