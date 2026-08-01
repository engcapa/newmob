import { afterEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { setLocale } from "../../../lib/i18n";
import {
  MAX_SELECTION_CHARS,
  buildEditorAiPrompt,
  describeScopeChain,
  extractImports,
  fenceLanguageFor,
  languageLabelFor,
  resolveAnswerLanguage,
  surroundingLines,
  truncateSelection,
  type EditorAiAction,
  type EditorAiContext,
} from "./editorAiPrompts";

function makeContext(overrides: Partial<EditorAiContext> = {}): EditorAiContext {
  return {
    action: "syntax",
    filePath: "src/cf-tun/certs/cloudflare_ca.rs",
    languageLabel: "Rust",
    fenceLanguage: "rust",
    selection: "impl CloudflareCertificateStore {",
    selectionStartLine: 20,
    selectionEndLine: 20,
    scopeChain: [],
    imports: [],
    linesBefore: [],
    linesAfter: [],
    hover: null,
    diagnostics: [],
    truncated: false,
    ...overrides,
  };
}

function symbol(overrides: Partial<LspDocumentSymbol> = {}): LspDocumentSymbol {
  return {
    name: "CloudflareCertificateStore",
    detail: null,
    kind: 23,
    depth: 0,
    range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    ...overrides,
  };
}

describe("resolveAnswerLanguage", () => {
  afterEach(() => setLocale("en"));

  it("honours an explicit preference regardless of locale", () => {
    setLocale("en");
    expect(resolveAnswerLanguage("zh-CN")).toBe("zh-CN");
    setLocale("zh-CN");
    expect(resolveAnswerLanguage("en")).toBe("en");
  });

  it("follows the app locale for auto", () => {
    setLocale("zh-CN");
    expect(resolveAnswerLanguage("auto")).toBe("zh-CN");
    setLocale("en");
    expect(resolveAnswerLanguage("auto")).toBe("en");
  });
});

describe("truncateSelection", () => {
  it("leaves short selections untouched", () => {
    const { text, truncated } = truncateSelection("fn main() {}");
    expect(text).toBe("fn main() {}");
    expect(truncated).toBe(false);
  });

  it("keeps the head and the tail when clipping", () => {
    const body = `HEAD${"x".repeat(MAX_SELECTION_CHARS * 2)}TAIL`;
    const { text, truncated } = truncateSelection(body);
    expect(truncated).toBe(true);
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text).toContain("characters omitted from the middle");
    expect(text.length).toBeLessThan(body.length);
  });

  it("respects an explicit budget", () => {
    const { text, truncated } = truncateSelection("abcdefghij", 4);
    expect(truncated).toBe(true);
    expect(text).toContain("6 characters omitted");
  });
});

describe("language identification", () => {
  it("prefers the LSP language id over the extension", () => {
    // A .txt buffer a server claims as Rust should be taught as Rust.
    expect(languageLabelFor("rust", "notes.txt")).toBe("Rust");
    expect(fenceLanguageFor("rust", "notes.txt")).toBe("rust");
  });

  it("maps LSP ids that differ from our extension keys", () => {
    expect(languageLabelFor("typescriptreact", "a.bin")).toBe("TypeScript (TSX)");
    expect(fenceLanguageFor("shellscript", "a.bin")).toBe("bash");
  });

  it("falls back to the extension when no server is attached", () => {
    expect(languageLabelFor(null, "src/main.rs")).toBe("Rust");
    expect(fenceLanguageFor(null, "src/App.tsx")).toBe("tsx");
    expect(languageLabelFor(null, "deploy/Dockerfile")).toBe("Dockerfile");
  });

  it("handles Windows paths and unknown extensions", () => {
    expect(languageLabelFor(null, "D:\\code\\person\\taomni\\src\\lib.rs")).toBe("Rust");
    expect(languageLabelFor(null, "mystery.qqq")).toBeNull();
    expect(fenceLanguageFor(null, "mystery.qqq")).toBe("");
  });
});

describe("extractImports", () => {
  it("picks up Rust use statements", () => {
    const file = [
      "use std::sync::Arc;",
      "pub use crate::certs::Store;",
      "",
      "pub struct Store;",
      "// use this later",
    ].join("\n");
    expect(extractImports(file, "rust")).toEqual([
      "use std::sync::Arc;",
      "pub use crate::certs::Store;",
    ]);
  });

  it("picks up JS/TS imports and requires", () => {
    const file = [
      "import { useState } from \"react\";",
      "const fs = require(\"fs\");",
      "export { helper } from \"./helper\";",
      "const value = 1;",
    ].join("\n");
    expect(extractImports(file, "typescript")).toEqual([
      "import { useState } from \"react\";",
      "const fs = require(\"fs\");",
      "export { helper } from \"./helper\";",
    ]);
  });

  it("picks up Python, Java, C and C# forms", () => {
    expect(extractImports("import os\nfrom sys import argv\nx = 1", "python"))
      .toEqual(["import os", "from sys import argv"]);
    expect(extractImports("import java.util.List;\nclass A {}", "java"))
      .toEqual(["import java.util.List;"]);
    expect(extractImports("#include <stdio.h>\nint main(){}", "c"))
      .toEqual(["#include <stdio.h>"]);
    expect(extractImports("using System;\nclass A {}", "csharp"))
      .toEqual(["using System;"]);
  });

  it("returns nothing for languages with no import concept", () => {
    expect(extractImports("key = value", "ini")).toEqual([]);
    expect(extractImports("use std::x;", "")).toEqual([]);
  });

  it("respects the line cap", () => {
    const file = Array.from({ length: 50 }, (_, i) => `use crate::m${i};`).join("\n");
    expect(extractImports(file, "rust", 3)).toHaveLength(3);
    expect(extractImports(file, "rust", 0)).toEqual([]);
  });
});

describe("surroundingLines", () => {
  const file = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");

  it("returns the neighbourhood of the selection", () => {
    const { before, after } = surroundingLines(file, 10, 12, 3);
    expect(before).toEqual(["line7", "line8", "line9"]);
    expect(after).toEqual(["line13", "line14", "line15"]);
  });

  it("clamps at the file boundaries", () => {
    expect(surroundingLines(file, 1, 1, 5).before).toEqual([]);
    expect(surroundingLines(file, 30, 30, 5).after).toEqual([]);
  });

  it("returns nothing for a zero radius", () => {
    const { before, after } = surroundingLines(file, 10, 12, 0);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
  });
});

describe("describeScopeChain", () => {
  it("orders outermost first and labels the kind", () => {
    const chain = describeScopeChain([
      symbol({ name: "new", kind: 6, depth: 1, detail: "() -> Self" }),
      symbol({ name: "CloudflareCertificateStore", kind: 23, depth: 0 }),
    ]);
    expect(chain).toEqual([
      "CloudflareCertificateStore (struct)",
      "new (method) — () -> Self",
    ]);
  });

  it("handles an empty chain", () => {
    expect(describeScopeChain([])).toEqual([]);
  });
});

describe("buildEditorAiPrompt", () => {
  afterEach(() => setLocale("en"));

  const actions: EditorAiAction[] = ["explain", "syntax", "fix", "rewrite"];

  it("puts the directive first and the code last for every action", () => {
    for (const action of actions) {
      for (const language of ["zh-CN", "en"] as const) {
        const prompt = buildEditorAiPrompt(makeContext({ action }), language);
        const fenceAt = prompt.indexOf("```rust");
        const selectionAt = prompt.indexOf("impl CloudflareCertificateStore {");
        expect(fenceAt).toBeGreaterThan(0);
        // Directive precedes the code, and the selection is in the final block.
        expect(prompt.trimStart().startsWith("```")).toBe(false);
        expect(selectionAt).toBeGreaterThan(prompt.indexOf("## "));
        expect(prompt.trimEnd().endsWith(
          language === "zh-CN" ? "请用中文回答。" : "Answer in English.",
        )).toBe(true);
      }
    }
  });

  it("never blockquotes the prompt", () => {
    // Regression: attachToComposer used to prefix every line with "> ", which
    // swallowed the instructions and the code fences into one quoted mass.
    const prompt = buildEditorAiPrompt(makeContext(), "en");
    expect(prompt.split("\n").some((line) => line.startsWith(">"))).toBe(false);
  });

  it("keeps the four teaching requirements for the syntax action", () => {
    const zh = buildEditorAiPrompt(makeContext({ action: "syntax" }), "zh-CN");
    expect(zh).toContain("1. 逐一说明用到的语法结构");
    expect(zh).toContain("2. 为什么这里会这样写");
    expect(zh).toContain("3. 还有哪些等价的其它写法");
    expect(zh).toContain("4. 在这个场景下哪种写法更合适");

    const en = buildEditorAiPrompt(makeContext({ action: "syntax" }), "en");
    expect(en).toContain("1. Go through each syntax construct");
    expect(en).toContain("4. Which style fits best in this context");
  });

  it("tells the model the selection may be a fragment", () => {
    expect(buildEditorAiPrompt(makeContext({ action: "syntax" }), "zh-CN"))
      .toContain("如果选区只是一个片段");
    expect(buildEditorAiPrompt(makeContext({ action: "syntax" }), "en"))
      .toContain("only a fragment");
  });

  it("follows the app locale when the preference is auto", () => {
    setLocale("zh-CN");
    expect(buildEditorAiPrompt(makeContext(), "auto")).toContain("请用中文回答。");
    setLocale("en");
    expect(buildEditorAiPrompt(makeContext(), "auto")).toContain("Answer in English.");
  });

  it("includes every context section that has content", () => {
    const prompt = buildEditorAiPrompt(makeContext({
      scopeChain: ["CloudflareCertificateStore (struct)", "new (method)"],
      imports: ["use std::sync::Arc;"],
      linesBefore: ["pub struct CloudflareCertificateStore {"],
      linesAfter: ["}"],
      hover: "struct CloudflareCertificateStore",
      diagnostics: ["L20 rustc: unused import [E0432]"],
    }), "en");

    expect(prompt).toContain("File: src/cf-tun/certs/cloudflare_ca.rs");
    expect(prompt).toContain("Language: Rust");
    expect(prompt).toContain("Selected lines: 20");
    expect(prompt).toContain("Enclosing scope (outermost first): CloudflareCertificateStore (struct) › new (method)");
    expect(prompt).toContain("File imports:");
    expect(prompt).toContain("use std::sync::Arc;");
    expect(prompt).toContain("Code before the selection:");
    expect(prompt).toContain("Code after the selection:");
    expect(prompt).toContain("Type information from the language server:");
    expect(prompt).toContain("Diagnostics inside the selection:");
    expect(prompt).toContain("L20 rustc: unused import [E0432]");
  });

  it("omits sections with no content", () => {
    const prompt = buildEditorAiPrompt(makeContext(), "en");
    expect(prompt).not.toContain("File imports:");
    expect(prompt).not.toContain("Enclosing scope");
    expect(prompt).not.toContain("Diagnostics inside the selection:");
    expect(prompt).not.toContain("Type information");
    expect(prompt).not.toContain("Code before the selection:");
  });

  it("renders a multi-line range and omits an unknown language", () => {
    const prompt = buildEditorAiPrompt(makeContext({
      selectionStartLine: 20,
      selectionEndLine: 59,
      languageLabel: null,
      fenceLanguage: "",
    }), "en");
    expect(prompt).toContain("Selected lines: 20-59");
    expect(prompt).not.toContain("Language:");
    // Unknown grammar degrades to a bare fence rather than claiming a language.
    expect(prompt).toContain("```\nimpl CloudflareCertificateStore {\n```");
  });

  it("flags a truncated selection so the gap is not read as a syntax error", () => {
    expect(buildEditorAiPrompt(makeContext({ truncated: true }), "en"))
      .toContain("that gap is not a syntax error");
    expect(buildEditorAiPrompt(makeContext({ truncated: true }), "zh-CN"))
      .toContain("这不是代码本身的语法错误");
  });

  it("carries the instruction for rewrite only", () => {
    const rewrite = buildEditorAiPrompt(
      makeContext({ action: "rewrite", instruction: "make it async" }),
      "en",
    );
    expect(rewrite).toContain("Instruction: make it async");

    const syntax = buildEditorAiPrompt(
      makeContext({ action: "syntax", instruction: "make it async" }),
      "en",
    );
    expect(syntax).not.toContain("Instruction: make it async");
  });

  it("clamps overlong hover text", () => {
    const prompt = buildEditorAiPrompt(makeContext({ hover: "T".repeat(5000) }), "en");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(4000);
  });

  it("caps the diagnostics list", () => {
    const diagnostics = Array.from({ length: 25 }, (_, i) => `L${i} problem ${i}`);
    const prompt = buildEditorAiPrompt(makeContext({ diagnostics }), "en");
    expect(prompt).toContain("L0 problem 0");
    expect(prompt).not.toContain("L20 problem 20");
  });
});
