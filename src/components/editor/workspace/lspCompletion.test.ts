import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import type { LspCompletionResult, LspDocumentStatus } from "../../../lib/editor/lsp";
import {
  boostFromSortText,
  boostFromTypedPrefix,
  completionKindToType,
  createLspCompletionSource,
  lspSnippetToCmSnippet,
  MAX_COMPLETION_OPTIONS,
  mergeCompletionTriggers,
} from "./lspCompletion";

function status(active: boolean): LspDocumentStatus {
  return {
    path: "a.ts",
    uri: "file:///a.ts",
    presetId: "typescript-javascript",
    languageId: "typescript",
    displayName: "TypeScript",
    available: true,
    active,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

function completionResult(labels: string[], active = true): LspCompletionResult {
  return {
    status: status(active),
    isIncomplete: false,
    items: labels.map((label) => ({
      label,
      kind: 3,
      detail: null,
      documentation: null,
      insertText: null,
      insertTextFormat: null,
      filterText: null,
      sortText: null,
      textEdit: null,
      additionalTextEdits: [],
      raw: { label },
    })),
  };
}

function contextAt(docText: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: docText });
  return new CompletionContext(state, pos, explicit);
}

describe("lspSnippetToCmSnippet", () => {
  it("converts tabstops, placeholders, and choices", () => {
    expect(lspSnippetToCmSnippet("openFile($1)$0")).toBe("openFile(${})${}");
    expect(lspSnippetToCmSnippet("for (const ${1:item} of ${2:items}) {}"))
      .toBe("for (const ${item} of ${items}) {}");
    expect(lspSnippetToCmSnippet("align: ${1|left,right,center|}")).toBe("align: ${left}");
    expect(lspSnippetToCmSnippet("${1}")).toBe("${}");
  });

  it("keeps escaped dollars literal and protects would-be fields", () => {
    // Unescaped $<digit> is a tabstop per the LSP spec; literals need \$.
    expect(lspSnippetToCmSnippet("price: \\$5")).toBe("price: $5");
    expect(lspSnippetToCmSnippet("\\$1 stays")).toBe("$1 stays");
    expect(lspSnippetToCmSnippet("template \\${literal}")).toBe("template \\${literal}");
    expect(lspSnippetToCmSnippet("plain $ dollar")).toBe("plain $ dollar");
  });
});

describe("completionKindToType", () => {
  it("maps LSP kinds to CodeMirror types", () => {
    expect(completionKindToType(2)).toBe("method");
    expect(completionKindToType(7)).toBe("class");
    expect(completionKindToType(14)).toBe("keyword");
    expect(completionKindToType(15)).toBe("text");
    expect(completionKindToType(17)).toBe("file");
    expect(completionKindToType(null)).toBeUndefined();
    expect(completionKindToType(99)).toBe("text");
  });
});

describe("boostFromSortText", () => {
  it("ranks lower numeric sortText higher", () => {
    const a = boostFromSortText("0001") ?? 0;
    const b = boostFromSortText("0010") ?? 0;
    expect(a).toBeGreaterThan(b);
  });

  it("returns undefined for empty sortText", () => {
    expect(boostFromSortText(null)).toBeUndefined();
    expect(boostFromSortText("")).toBeUndefined();
  });
});

describe("mergeCompletionTriggers", () => {
  it("always includes default triggers and server triggers", () => {
    expect(mergeCompletionTriggers(["("])).toEqual(expect.arrayContaining([".", ":", "("]));
    expect(mergeCompletionTriggers(null)).toEqual(expect.arrayContaining([".", ":"]));
  });
});

describe("boostFromTypedPrefix", () => {
  it("prefers exact and camelCase prefix matches", () => {
    const exact = boostFromTypedPrefix("open", "openFile", null) ?? 0;
    const camel = boostFromTypedPrefix("oF", "openFile", null) ?? 0;
    const weak = boostFromTypedPrefix("zz", "openFile", null);
    expect(exact).toBeGreaterThan(camel);
    expect(camel).toBeGreaterThan(0);
    expect(weak).toBeUndefined();
  });

  it("stacks with sortText boost", () => {
    const withSort = boostFromTypedPrefix("to", "toString", "0001") ?? 0;
    const sortOnly = boostFromSortText("0001") ?? 0;
    expect(withSort).toBeGreaterThan(sortOnly);
  });
});

describe("createLspCompletionSource", () => {
  it("skips silently when there is nothing to complete", async () => {
    const fetch = vi.fn();
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => ["."] });

    expect(await source(contextAt("const x = 1;\n", 0))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queries on word prefixes and reports LSP options", async () => {
    const fetch = vi.fn(async () => completionResult(["openFile", "openDir"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("op", 2));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 2 }, null);
    expect(result?.from).toBe(0);
    expect(result?.options.map((option) => option.label)).toEqual(["openFile", "openDir"]);
    expect(result?.options[0].type).toBe("function");
  });

  it("fires on trigger characters without a word prefix", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => ["."] });

    const result = await source(contextAt("value.", 6));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 6 }, ".");
    expect(result?.from).toBe(6);
  });

  it("falls back to buffer words when the language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("workspace wor", 13));

    expect(result?.options.some((option) => option.label === "workspace")).toBe(true);
  });

  it("uses filterText for matching and sortText for ordering metadata", async () => {
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "toString(): string",
        kind: 2,
        detail: null,
        documentation: null,
        insertText: "toString",
        insertTextFormat: 1,
        filterText: "toString",
        sortText: "0001",
        textEdit: null,
        additionalTextEdits: [],
        raw: {},
      }],
    }));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("to", 2));
    expect(result?.options[0]?.label).toBe("toString");
    expect(result?.options[0]?.displayLabel).toBe("toString(): string");
    expect(result?.options[0]?.sortText).toBe("0001");
    expect(result?.options[0]?.boost).toBeGreaterThan(0);
  });

  it("passes the member-access trigger when typing after a trigger character", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => ["."] });

    await source(contextAt("value.to", 8));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 8 }, ".");
  });

  it("caps very large completion lists for popup performance", async () => {
    const labels = Array.from({ length: MAX_COMPLETION_OPTIONS + 50 }, (_, i) => `item${i}`);
    const fetch = vi.fn(async () => completionResult(labels));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("it", 2));
    expect(result?.options).toHaveLength(MAX_COMPLETION_OPTIONS);
  });

  it("aborts early during fast typing without issuing fetch", async () => {
    const fetch = vi.fn(async () => completionResult(["item"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });
    const context = contextAt("it", 2);
    const promise = source(context);
    // Simulate another keystroke arriving immediately (aborting previous context)
    const raw = context as unknown as { abortListeners?: Array<() => void> };
    Object.defineProperty(context, "aborted", { value: true, configurable: true });
    raw.abortListeners?.forEach((l) => l());
    const result = await promise;
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses word-based LSP autocompletion inside string literals", async () => {
    const fetch = vi.fn(async () => completionResult(["another"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => ["."] });
    const doc = 'String firstStr = "this is another";';
    const pos = doc.indexOf("another") + 2;
    const result = await source(contextAt(doc, pos));
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never returns hardcoded Java JDK completions when language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("Lis", 3));
    // Should fall back to completeAnyWord, without synthetic JDK imports like java.util.List
    const labels = result?.options.map((opt) => opt.label) ?? [];
    expect(labels).not.toContain("ArrayList");
    expect(labels).not.toContain("HashMap");
  });

  it("applies primary textEdit and additionalTextEdits in a single atomic dispatch", async () => {
    const { EditorView } = await import("@codemirror/view");
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "List",
        kind: 7,
        detail: "java.util.List",
        documentation: null,
        insertText: "List",
        insertTextFormat: 1,
        filterText: "List",
        sortText: "0001",
        textEdit: {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          newText: "List",
        },
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import java.util.List;\n",
        }],
        raw: {},
      }],
    }));

    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });
    const initialText = "\nLis";
    const state = EditorState.create({ doc: initialText });
    const view = new EditorView({ state });

    const result = await source(new CompletionContext(state, 4, true));
    expect(result?.options).toHaveLength(1);

    const option = result!.options[0];
    const dispatchSpy = vi.spyOn(view, "dispatch");

    if (typeof option.apply === "function") {
      option.apply(view, option, 1, 4);
    }

    // Assert single atomic dispatch
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("import java.util.List;\n\nList");
  });

  it("guards against stale async resolve when document changes before resolve completes", async () => {
    const { EditorView } = await import("@codemirror/view");
    let resolvePromise: (item: any) => void = () => {};
    const deferredResolve = new Promise<any>((r) => { resolvePromise = r; });

    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "AutoImportedClass",
        kind: 7,
        detail: null,
        documentation: null,
        insertText: "AutoImportedClass",
        insertTextFormat: 1,
        filterText: "AutoImportedClass",
        sortText: "0001",
        textEdit: null,
        additionalTextEdits: [],
        raw: {},
      }],
    }));

    const resolve = vi.fn(() => deferredResolve);
    let docRevision = 1;
    const source = createLspCompletionSource({
      fetch,
      resolve,
      triggerCharacters: () => [],
      getDocumentRevision: () => docRevision,
    });

    const initialText = "const a = Aut";
    const state = EditorState.create({ doc: initialText });
    const view = new EditorView({ state });

    const result = await source(new CompletionContext(state, 13, true));
    const option = result!.options[0];

    // User accepts completion
    if (typeof option.apply === "function") {
      option.apply(view, option, 10, 13);
    }
    expect(view.state.doc.toString()).toBe("const a = AutoImportedClass");

    // Before resolve arrives, user types further, bumping documentRevision
    docRevision = 2;
    view.dispatch({ changes: { from: 27, to: 27, insert: ";" } });

    // Now resolve arrives with additionalTextEdits
    resolvePromise({
      additionalTextEdits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import { AutoImportedClass } from './module';\n",
      }],
    });
    await deferredResolve;
    await new Promise((r) => setTimeout(r, 10));

    // Stale additionalTextEdits should NOT be applied to mutated revision
    expect(view.state.doc.toString()).toBe("const a = AutoImportedClass;");
  });
});
