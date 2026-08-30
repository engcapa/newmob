import { describe, expect, it, vi } from "vitest";
import {
  trimTrailingWhitespace,
  adjustFinalNewline,
  normalizeLineEndings,
  runSaveNormalizationPipeline,
  WorkspaceSavePipeline,
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
    expect(result.stages.map((s) => ({ stage: s.stage, status: s.status }))).toEqual([
      { stage: "format", status: "applied" },
      { stage: "organize-imports", status: "applied" },
      { stage: "trim", status: "applied" },
      { stage: "final-newline", status: "disabled" },
      { stage: "eol", status: "disabled" },
      { stage: "charset-bom", status: "disabled" },
    ]);
    expect(result.stages[0]!.beforeHash).toBeDefined();
    expect(result.stages[0]!.afterHash).toBeDefined();
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
    expect(result.stages[1]).toMatchObject({ stage: "organize-imports", status: "skipped-prior-failure" });
    expect(result.stages[2]).toMatchObject({ stage: "trim", status: "applied" });
    // User text preserved with safe whitespace trimming, never dropped!
    expect(result.text).toBe("const draft = 42;\n");
  });

  it("respects EffectiveSavePolicyV4 exclusions and reports disabled status", async () => {
    const style: EffectiveCodeStyle = {
      tabSize: 2,
      indentSize: 2,
      continuationIndent: 4,
      insertSpaces: true,
      source: "scheme",
      label: "Spaces: 2",
    };

    const formatFn = vi.fn(async (t: string) => `formatted:\n${t}`);

    // Excluded path
    const resultPathExcluded = await runSaveNormalizationPipeline({
      text: "const a = 1;\n",
      codeStyle: style,
      filePath: "src/generated/code.ts",
      savePolicy: {
        format: { enabled: true, source: "scheme" },
        organizeImports: { enabled: false, source: "default" },
        exclusions: { patterns: ["**/generated/**"], formatterMarkers: true, source: "scheme" },
        unsupported: ["rearrange", "cleanup", "directory", "module"],
      },
      formatFn,
    });
    expect(resultPathExcluded.formatted).toBe(false);
    expect(formatFn).not.toHaveBeenCalled();
    expect(resultPathExcluded.stages[0]).toMatchObject({
      stage: "format",
      status: "disabled",
      reason: "path-excluded",
    });
    expect(resultPathExcluded.stages[1]).toMatchObject({
      stage: "organize-imports",
      status: "disabled",
    });

    // Formatter marker @formatter:off
    const resultMarkerOff = await runSaveNormalizationPipeline({
      text: "// @formatter:off\nconst b = 2;\n",
      codeStyle: style,
      filePath: "src/manual.ts",
      savePolicy: {
        format: { enabled: true, source: "scheme" },
        organizeImports: { enabled: false, source: "default" },
        exclusions: { patterns: [], formatterMarkers: true, source: "scheme" },
        unsupported: ["rearrange", "cleanup", "directory", "module"],
      },
      formatFn,
    });
    expect(resultMarkerOff.formatted).toBe(false);
    expect(resultMarkerOff.stages[0]).toMatchObject({
      stage: "format",
      status: "disabled",
      reason: "formatter-marker-off",
    });
  });

  describe("§8.22.6 U2-D Actions on Save Pipeline", () => {
    it("aborts organize imports stage immediately when buffer version advances concurrently", async () => {
      const style: EffectiveCodeStyle = {
        tabSize: 2,
        indentSize: 2,
        continuationIndent: 4,
        insertSpaces: true,
        source: "scheme",
        label: "Spaces: 2",
      };

      let currentVersion = 1;
      const organizeImportsFn = vi.fn(async (text: string) => {
        // User typed while organize imports was running
        currentVersion = 2;
        return `import Z;\n${text}`;
      });

      const initialText = "const a = 1;\n";
      const result = await WorkspaceSavePipeline.run({
        text: initialText,
        codeStyle: style,
        organizeImportsOnSave: true,
        organizeImportsFn,
        expectedVersion: 1,
        getLatestBufferVersion: () => currentVersion,
      });

      expect(result.cancelledDueToEdit).toBe(true);
      expect(result.importsOrganized).toBe(false);
      expect(result.text).toBe(initialText);
      expect(result.diagnostics[0]).toContain("Organize imports cancelled because buffer was modified concurrently");
    });

    it("executes complete pipeline sequence (Format -> Organize -> Whitespace -> EOL)", async () => {
      const style: EffectiveCodeStyle = {
        tabSize: 2,
        indentSize: 2,
        continuationIndent: 4,
        insertSpaces: true,
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
        endOfLine: "lf",
        source: "scheme",
        label: "Spaces: 2",
      };

      const formatFn = vi.fn(async (t: string) => `// Formatted\n${t}`);
      const organizeImportsFn = vi.fn(async (t: string) => `import A;\n${t}`);

      const result = await WorkspaceSavePipeline.run({
        text: "const hello = 'world';   ",
        codeStyle: style,
        formatOnSave: true,
        formatFn,
        organizeImportsOnSave: true,
        organizeImportsFn,
      });

      expect(result.formatted).toBe(true);
      expect(result.importsOrganized).toBe(true);
      expect(result.whitespaceTrimmed).toBe(true);
      expect(result.newlineAdjusted).toBe(true);
      expect(result.text).toBe("import A;\n// Formatted\nconst hello = 'world';\n");
    });
  });

  describe("§ED-SAVE-001: Six-Stage Immutable Save Plan", () => {
    it("freezes text, document, disk, policy, style, provider, project, and encoding identity into immutable plan", async () => {
      const style: EffectiveCodeStyle = {
        tabSize: 4,
        indentSize: 4,
        continuationIndent: 8,
        insertSpaces: true,
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
        endOfLine: "lf",
        charset: "utf-8",
        source: "editorconfig",
        label: "Spaces: 4",
      };

      const result = await runSaveNormalizationPipeline({
        text: "class App {\t\n}\n\n",
        codeStyle: style,
        filePath: "/repo/src/App.java",
        documentIdentity: {
          uri: "file:///repo/src/App.java",
          path: "/repo/src/App.java",
          revision: 7,
          languageId: "java",
        },
        diskIdentity: {
          mtimeMs: 1700000000000,
          sizeBytes: 120,
          exists: true,
          sha256: "hash-disk-1",
        },
        providerIdentity: {
          id: "jdtls",
          generation: 3,
        },
        projectIdentity: {
          fingerprint: "fp-save-plan-1",
          rootUri: "file:///repo",
        },
        savePolicy: {
          format: { enabled: true, source: "scheme" },
          organizeImports: { enabled: true, source: "scheme" },
          exclusions: { patterns: [], formatterMarkers: true, source: "scheme" },
          unsupported: [],
        },
        formatFn: async (t) => `/* fmt */\n${t}`,
        organizeImportsFn: async (t) => `import java.util.*;\n${t}`,
      });

      expect(result.plan).toBeDefined();
      expect(result.plan.planId).toMatch(/^save-plan-/);
      expect(result.plan.identity.document?.uri).toBe("file:///repo/src/App.java");
      expect(result.plan.identity.document?.revision).toBe(7);
      expect(result.plan.identity.disk?.exists).toBe(true);
      expect(result.plan.identity.provider?.id).toBe("jdtls");
      expect(result.plan.identity.project?.fingerprint).toBe("fp-save-plan-1");
      expect(result.plan.identity.encoding?.charset).toBe("UTF-8");

      // Verify all 6 stages present in exact order
      expect(result.plan.stages.map((s) => s.stage)).toEqual([
        "format",
        "organize-imports",
        "trim",
        "final-newline",
        "eol",
        "charset-bom",
      ]);

      // Every stage has valid SHA-256 beforeHash and afterHash
      for (const stage of result.plan.stages) {
        expect(stage.beforeHash).toMatch(/^[a-f0-9]{64}$/);
        expect(stage.afterHash).toMatch(/^[a-f0-9]{64}$/);
      }

      expect(result.plan.disposition).toBe("ready");
      expect(result.plan.finalHash).toBe(result.plan.stages[5]!.afterHash);
    });

    it("deep-freezes plan identities and stage reports against caller mutations", async () => {
      const style: EffectiveCodeStyle = {
        tabSize: 2,
        indentSize: 2,
        continuationIndent: 4,
        insertSpaces: true,
        trimTrailingWhitespace: true,
        source: "editorconfig",
        label: "Spaces: 2",
      };

      const result = await runSaveNormalizationPipeline({
        text: "const value = 1;\n",
        codeStyle: style,
      });

      expect(Object.isFrozen(result.plan.identity.style)).toBe(true);
      expect(Object.isFrozen(result.plan.stages[0])).toBe(true);

      style.trimTrailingWhitespace = false;
      expect(result.plan.identity.style.trimTrailingWhitespace).toBe(true);
    });

    it("isolates encoding failure to single failed stage with zero live buffer effect", async () => {
      const style: EffectiveCodeStyle = {
        tabSize: 2,
        indentSize: 2,
        continuationIndent: 4,
        insertSpaces: true,
        charset: "latin1",
        source: "editorconfig",
        label: "Spaces: 2",
      };

      const initialText = "const emoji = '🚀';\n"; // Contains non-Latin1 emoji!
      const result = await runSaveNormalizationPipeline({
        text: initialText,
        codeStyle: style,
      });

      expect(result.encodingError).toBe(true);
      // Zero live buffer effect: text returned strictly equals initialText
      expect(result.text).toBe(initialText);

      // Verify stages: only stage 6 (charset-bom) is failed
      expect(result.stages.map((s) => ({ stage: s.stage, status: s.status }))).toEqual([
        { stage: "format", status: "disabled" },
        { stage: "organize-imports", status: "disabled" },
        { stage: "trim", status: "disabled" },
        { stage: "final-newline", status: "disabled" },
        { stage: "eol", status: "disabled" },
        { stage: "charset-bom", status: "failed" },
      ]);
      expect(result.plan.disposition).toBe("failed");
    });
  });
});
