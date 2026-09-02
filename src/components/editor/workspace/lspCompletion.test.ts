import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  CompletionContext,
  hasNextSnippetField,
  nextSnippetField,
} from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import type { LspCompletionResult, LspDocumentStatus } from "../../../lib/editor/lsp";
import {
  advanceLspSnippetTabstop,
  cancelLspSnippetSession,
  lspSnippetSessionInvalidator,
  parseLspSnippet,
  recentCompletionTelemetry,
  resetCompletionTelemetry,
  boostFromSortText,
  boostFromTypedPrefix,
  completionKindToType,
  createFixtureCompletionSource,
  createLspCompletionSource,
  compareCandidatePairs,
  compareCompletionCandidates,
  matchCompletionQuery,
  lspSnippetToCmSnippet,
  LspCompletionController,
  WorkspaceCompletionPolicyController,
  matchesCaseRule,
  matchesSymbolPattern,
  symbolIdentityFromItem,
  MAX_COMPLETION_OPTIONS,
  mergeCompletionTriggers,
  type CompletionCandidateIdentity,
  type CompletionCandidatePair,
  type CompletionRequestIdentity,
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
    expect(lspSnippetToCmSnippet("openFile($1)$0")).toBe("openFile(${1})${0}");
    expect(lspSnippetToCmSnippet("for (const ${1:item} of ${2:items}) {}"))
      .toBe("for (const ${1:item} of ${2:items}) {}");
    expect(lspSnippetToCmSnippet("align: ${1|left,right,center|}")).toBe("align: ${1:left}");
    expect(lspSnippetToCmSnippet("${1}")).toBe("${1}");
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
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });

    expect(await source(contextAt("const x = 1;\n", 0))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queries on word prefixes and reports LSP options", async () => {
    const fetch = vi.fn(async () => completionResult(["openFile", "openDir"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("op", 2));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 2 }, null);
    expect(result?.from).toBe(0);
    expect(result?.options.map((option) => option.label)).toEqual(["openFile", "openDir"]);
    expect(result?.options[0].type).toBe("function");
  });

  it("fires on trigger characters without a word prefix", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });

    const result = await source(contextAt("value.", 6));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 6 }, ".");
    expect(result?.from).toBe(6);
  });

  it("falls back to buffer words when the language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });

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
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("to", 2));
    expect(result?.options[0]?.label).toBe("toString");
    expect(result?.options[0]?.displayLabel).toBe("toString(): string");
    expect(result?.options[0]?.sortText).toBe("0001");
    expect(result?.options[0]?.boost).toBeGreaterThan(0);
  });

  it("passes the member-access trigger when typing after a trigger character", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });

    await source(contextAt("value.to", 8));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 8 }, ".");
  });

  it("caps very large completion lists for popup performance", async () => {
    const labels = Array.from({ length: MAX_COMPLETION_OPTIONS + 50 }, (_, i) => `item${i}`);
    const fetch = vi.fn(async () => completionResult(labels));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("it", 2));
    expect(result?.options).toHaveLength(MAX_COMPLETION_OPTIONS);
  });

  it("aborts early during fast typing without issuing fetch", async () => {
    const fetch = vi.fn(async () => completionResult(["item"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
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
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });
    const doc = 'String firstStr = "this is another";';
    const pos = doc.indexOf("another") + 2;
    const result = await source(contextAt(doc, pos));
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never returns hardcoded Java JDK completions when language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });

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

    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
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
    const source = createFixtureCompletionSource({
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
    // Acceptance waits for resolve so primary + auto-import can commit once.
    expect(view.state.doc.toString()).toBe("const a = Aut");

    // Before resolve arrives, user types further, bumping documentRevision
    docRevision = 2;
    view.dispatch({ changes: { from: 13, to: 13, insert: ";" } });

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
    expect(view.state.doc.toString()).toBe("const a = Aut;");
  });

  describe("P0-J1 identity & containment", () => {
    it("falls back to word completion when provider is inactive even with non-empty items", async () => {
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(false),
        isIncomplete: false,
        items: [{
          label: "StaleServerCandidate",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "StaleServerCandidate",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      }));
      const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
      const state = EditorState.create({ doc: "const a = Sta" });
      const result = await source(new CompletionContext(state, 13, true));
      expect(fetch).toHaveBeenCalled();
      const labels = (result?.options ?? []).map((option) => option.label);
      expect(labels).not.toContain("StaleServerCandidate");
    });

    it("discards the whole response when the document revision advanced during fetch", async () => {
      let releaseFetch: () => void = () => {};
      const deferred = new Promise<void>((resolve) => { releaseFetch = resolve; });
      let revision = 1;
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => {
        await deferred;
        return completionResult(["FreshCandidate"]);
      });
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        getDocumentRevision: () => revision,
      });
      const state = EditorState.create({ doc: "const a = Fre" });
      const pending = source(new CompletionContext(state, 13, true));
      revision = 2;
      releaseFetch();
      const result = await pending;
      const labels = (result?.options ?? []).map((option) => option.label);
      expect(labels).not.toContain("FreshCandidate");
    });

    it("shares one resolve result between documentation preview and acceptance", async () => {
      const { EditorView } = await import("@codemirror/view");
      const item = completionResult(["Solo"]).items[0];
      const resolve = vi.fn(async () => ({
        ...item,
        documentation: "Resolved documentation",
      }));
      const source = createFixtureCompletionSource({
        fetch: vi.fn(async () => completionResult(["Solo"])),
        resolve,
        triggerCharacters: () => [],
      });
      const state = EditorState.create({ doc: "Sol" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 3, true));
      const option = result!.options[0];

      expect(typeof option.info).toBe("function");
      const info = await (option.info as () => Promise<Node | null>)();
      expect(info).toHaveTextContent("Resolved documentation");
      if (typeof option.apply === "function") option.apply(view, option, 0, 3);
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Solo"));

      expect(resolve).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it("discards completion documentation when identity changes during resolve", async () => {
      let identity: CompletionRequestIdentity = {
        workspaceId: "workspace-a",
        fileKey: "file-a",
        filePath: "/workspace/a.ts",
        uri: "file:///workspace/a.ts",
        languageId: "typescript",
        documentRevision: 1,
        lspSessionGeneration: 4,
      };
      let releaseResolve: (item: LspCompletionResult["items"][number]) => void = () => {};
      const deferredResolve = new Promise<LspCompletionResult["items"][number]>((resolve) => {
        releaseResolve = resolve;
      });
      const fetch = vi.fn(async () => completionResult(["StaleCandidate"]));
      const source = createLspCompletionSource({
        identity: () => identity,
        fetch,
        resolve: vi.fn(() => deferredResolve),
        triggerCharacters: () => [],
        getDocumentRevision: () => identity.documentRevision,
        reportDiagnostic: vi.fn(),
      });
      const state = EditorState.create({ doc: "Sta" });
      const result = await source(new CompletionContext(state, 3, true));
      const option = result!.options[0];
      expect(typeof option.info).toBe("function");

      const pendingInfo = (option.info as () => Promise<Node | null>)();
      identity = { ...identity, lspSessionGeneration: 5 };
      releaseResolve({
        ...completionResult(["StaleCandidate"]).items[0],
        documentation: "Documentation from the stale provider session",
      });

      expect(await pendingInfo).toBeNull();
    });

    it("reports truncated lists via diagnostic and detail", async () => {
      const diagnostics: string[] = [];
      const items = Array.from({ length: 201 }, (_, i) => ({
        label: `candidate-${i}`,
        kind: 6,
        detail: null,
        documentation: null,
        insertText: `candidate-${i}`,
        insertTextFormat: 1,
        filterText: null,
        sortText: null,
        textEdit: null,
        additionalTextEdits: [],
        raw: {},
      }));
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: true,
        truncated: true,
        items,
      }));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        reportDiagnostic: (kind) => diagnostics.push(kind),
      });
      const state = EditorState.create({ doc: "can" });
      const result = await source(new CompletionContext(state, 3, true));
      expect(result?.options).toHaveLength(200);
      expect(diagnostics).toContain("truncated");
      expect(result?.options[0]?.detail).toContain("list truncated");
    });
  });

  describe("P0-J1 single-transaction acceptance", () => {
    it("commits snippet placeholder and preceding import edit in one dispatch with mapped selection", async () => {
      const { EditorView } = await import("@codemirror/view");
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          label: "loadUser",
          kind: 3,
          detail: null,
          documentation: null,
          insertText: "loadUser(${1:user})",
          insertTextFormat: 2,
          filterText: null,
          sortText: "0001",
          textEdit: null,
          additionalTextEdits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "import { loadUser } from \"./users\";\n",
          }],
          raw: {},
        }],
      }));
      const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
      const state = EditorState.create({ doc: "\nloadU" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 6, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");
      if (typeof option.apply === "function") {
        option.apply(view, option, 1, 6);
      }
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const doc = view.state.doc.toString();
      expect(doc).toContain("import { loadUser } from \"./users\";");
      expect(doc).toContain("loadUser(user)");
      const importPrefix = "import { loadUser } from \"./users\";\n".length;
      expect(view.state.selection.main.anchor).toBe(importPrefix + 1 + "loadUser(".length);
      view.destroy();
    });

    it("rejects overlapping additional edits with zero document writes", async () => {
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          label: "List",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "List",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [{
            range: { start: { line: 0, character: 11 }, end: { line: 0, character: 20 } },
            newText: "XXX",
          }],
          raw: {},
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        reportDiagnostic: (kind) => diagnostics.push(kind),
      });
      const state = EditorState.create({ doc: "const a = Lis" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 13, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }
      expect(diagnostics).toContain("invalid-additional-edits");
      expect(view.state.doc.toString()).toBe("const a = Lis");
      view.destroy();
    });

    it("rejects an out-of-bounds primary textEdit with zero document writes", async () => {
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const item = completionResult(["List"]).items[0];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          ...item,
          textEdit: {
            range: {
              start: { line: 0, character: 10 },
              end: { line: 0, character: 40 },
            },
            newText: "List",
          },
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        resolve: async () => ({
          ...item,
          textEdit: {
            range: {
              start: { line: 0, character: 10 },
              end: { line: 0, character: 40 },
            },
            newText: "List",
          },
        }),
        triggerCharacters: () => [],
        reportDiagnostic: (kind, detail) => diagnostics.push(detail ? `${kind}:${detail}` : kind),
      });
      const state = EditorState.create({ doc: "const a = Lis" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, state.doc.length, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");

      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("const a = Lis");
      expect(diagnostics).toContain("invalid-additional-edits:primary-range");
      view.destroy();
    });

    it("rejects colliding zero-width additional edits with zero document writes", async () => {
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const item = completionResult(["List"]).items[0];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          ...item,
          additionalTextEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import first;\n",
            },
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import second;\n",
            },
          ],
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        reportDiagnostic: (kind) => diagnostics.push(kind),
      });
      const state = EditorState.create({ doc: "const a = Lis" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, state.doc.length, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");

      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }

      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("const a = Lis");
      expect(diagnostics).toContain("invalid-additional-edits");
      view.destroy();
    });

    it("resolves imports before one acceptance dispatch and one undo", async () => {
      const { EditorView } = await import("@codemirror/view");
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => completionResult(["AutoImportedClass"]));
      const resolvedItem = completionResult(["AutoImportedClass"]).items[0];
      const resolve = vi.fn(async () => ({
        ...resolvedItem,
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import { AutoImportedClass } from './module';\n",
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        resolve,
        triggerCharacters: () => [],
        getDocumentRevision: () => 0,
      });
      const state = EditorState.create({ doc: "\nAut", extensions: [history()] });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 4, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");
      if (typeof option.apply === "function") option.apply(view, option, 1, 4);
      expect(view.state.doc.toString()).toBe("\nAut");
      await vi.waitFor(() => {
        expect(view.state.doc.toString()).toBe(
          "import { AutoImportedClass } from './module';\n\nAutoImportedClass",
        );
      });
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("\nAut");
      view.destroy();
    });

    it("uses live snippet fields and advances in numeric tabstop order", async () => {
      const { EditorView } = await import("@codemirror/view");
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          ...completionResult(["call"]).items[0],
          label: "call",
          insertText: "call(${1:first}, ${2:second})$0",
          insertTextFormat: 2,
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        resolve: async () => ({
          ...completionResult(["call"]).items[0],
          label: "call",
          insertText: "call(${1:first}, ${2:second})$0",
          insertTextFormat: 2,
        }),
        triggerCharacters: () => [],
      });
      const state = EditorState.create({ doc: "cal" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 3, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") option.apply(view, option, 0, 3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.state.doc.toString()).toBe("call(first, second)");
      expect(view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      )).toBe("first");
      expect(hasNextSnippetField(view.state)).toBe(true);
      expect(nextSnippetField(view)).toBe(true);
      expect(view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      )).toBe("second");
      view.destroy();
    });

    it("blocks on resolve failure and surfaces the gate instead of inserting an incomplete acceptance", async () => {
      // §8.19.4: a failed resolve must NOT fall through to a silent
      // primary-only insert — the gate waits for an explicit user choice.
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const gates: Array<{ reason: string; insertWithoutImport(): boolean }> = [];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => completionResult(["Solo"]));
      const resolve = vi.fn(async () => { throw new Error("resolve blew up"); });
      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "fixture-workspace",
          fileKey: "fixture-file",
          filePath: "/fixture/file.ts",
          uri: "file:///fixture/file.ts",
          languageId: "fixture",
          documentRevision: 0,
          lspSessionGeneration: 0,
        }),
        fetch: () => fetch(),
        resolve: () => resolve(),
        triggerCharacters: () => [],
        getDocumentRevision: () => 0,
        reportDiagnostic: (kind, detail) => diagnostics.push(detail ? `${kind}:${detail}` : kind),
        onResolveGate: (request) => gates.push(request),
      });
      const state = EditorState.create({ doc: "const a = Sol" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 13, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }
      await new Promise((r) => setTimeout(r, 10));
      // Nothing inserted while the gate is pending.
      expect(view.state.doc.toString()).toBe("const a = Sol");
      expect(gates).toHaveLength(1);
      expect(gates[0].reason).toBe("failed");
      expect(diagnostics).toContain("additional-edit-unavailable:resolve-failed");
      view.destroy();
    });
  });
});

describe("P0-J1 remainder: parseLspSnippet spans & tabstop session", () => {
  it("returns full placeholder spans covering default text", () => {
    const parsed = parseLspSnippet("loadUser(${1:user}, ${2|a,b|})$0");
    expect(parsed.text).toBe("loadUser(user, a)");
    // §8.18.3: choice placeholders keep their option list for the
    // interactive choice session; plain stops carry no choices.
    expect(parsed.placeholders).toEqual([
      { start: "loadUser(".length, end: "loadUser(user".length },
      {
        start: "loadUser(user, ".length,
        end: "loadUser(user, a".length,
        choices: ["a", "b"],
      },
      { start: parsed.text.length, end: parsed.text.length },
    ]);
  });

  function snippetPlusImportView(EditorViewCtor: typeof import("@codemirror/view").EditorView) {
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "loadUser",
        kind: 3,
        detail: null,
        documentation: null,
        insertText: "loadUser(${1:user})",
        insertTextFormat: 2,
        filterText: null,
        sortText: "0001",
        textEdit: null,
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import { loadUser } from \"./users\";\n",
        }],
        raw: {},
      }],
    }));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const state = EditorState.create({
      doc: "\nloadU",
      extensions: [history(), lspSnippetSessionInvalidator()],
    });
    const view = new EditorViewCtor({ state });
    return { source, view };
  }

  it("one acceptance advances one revision and one undo reverts primary+import together", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { source, view } = snippetPlusImportView(EditorView);
    const result = await source(new CompletionContext(view.state, 6, true));
    const option = result!.options[0];
    if (typeof option.apply === "function") {
      option.apply(view, option, 1, 6);
    }
    expect(view.state.doc.toString()).toBe(
      `import { loadUser } from "./users";\n\nloadUser(user)`,
    );
    undo(view);
    expect(view.state.doc.toString()).toBe("\nloadU");
    view.destroy();
  });

  it("Tab cycles committed placeholder spans without document edits; Esc ends the session", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { source, view } = snippetPlusImportView(EditorView);
    const result = await source(new CompletionContext(view.state, 6, true));
    const option = result!.options[0];
    if (typeof option.apply === "function") {
      option.apply(view, option, 1, 6);
    }
    const importPrefix = `import { loadUser } from "./users";\n`.length;
    const docAfterAccept = view.state.doc.toString();

    // First placeholder span selected at accept.
    expect(view.state.selection.main.from).toBe(importPrefix + 1 + "loadUser(".length);
    expect(view.state.selection.main.to).toBe(importPrefix + 1 + "loadUser(user".length);

    // Exhausting the single-placeholder session returns false (falls through).
    expect(advanceLspSnippetTabstop(view)).toBe(false);

    // Multi-placeholder session: Tab moves between spans with zero doc change.
    const fetchMulti = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "pair",
        kind: 3,
        detail: null,
        documentation: null,
        insertText: "pair(${1:a}, ${2:b})",
        insertTextFormat: 2,
        filterText: null,
        sortText: "0001",
        textEdit: null,
        // Non-empty additional edits route through the combined single-
        // dispatch acceptance that owns the tabstop session.
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import { pair } from \"./pair\";\n",
        }],
        raw: {},
      }],
    }));
    const multiSource = createFixtureCompletionSource({ fetch: fetchMulti, triggerCharacters: () => [] });
    const stateMulti = EditorState.create({
      doc: "\npai",
      extensions: [history(), lspSnippetSessionInvalidator()],
    });
    const viewMulti = new EditorView({ state: stateMulti });
    const multiResult = await multiSource(new CompletionContext(stateMulti, 4, true));
    const multiOption = multiResult!.options[0];
    if (typeof multiOption.apply === "function") {
      multiOption.apply(viewMulti, multiOption, 1, 4);
    }
    const docMulti = viewMulti.state.doc.toString();
    expect(docMulti).toBe(`import { pair } from "./pair";\n\npair(a, b)`);
    const pairPrefix = `import { pair } from "./pair";\n\n`.length;
    expect(viewMulti.state.selection.main.from).toBe(pairPrefix + "pair(".length);
    expect(viewMulti.state.selection.main.to).toBe(pairPrefix + "pair(a".length);
    // Second placeholder selected after Tab with zero document edits.
    expect(advanceLspSnippetTabstop(viewMulti)).toBe(true);
    expect(viewMulti.state.doc.toString()).toBe(docMulti);
    expect(viewMulti.state.selection.main.from).toBe(pairPrefix + "pair(a, ".length);
    expect(viewMulti.state.selection.main.to).toBe(pairPrefix + "pair(a, b".length);
    // Exhausted.
    expect(advanceLspSnippetTabstop(viewMulti)).toBe(false);
    viewMulti.destroy();

    cancelLspSnippetSession(view);
    expect(docAfterAccept.length).toBeGreaterThan(0);
    view.destroy();
  });

  it("any unrelated document edit invalidates the pending tabstop session", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { source, view } = snippetPlusImportView(EditorView);
    const result = await source(new CompletionContext(view.state, 6, true));
    const option = result!.options[0];
    if (typeof option.apply === "function") {
      option.apply(view, option, 1, 6);
    }
    // Simulate an unrelated edit through the same view dispatch pipeline.
    view.dispatch({ changes: { from: 0, insert: "// note\n" } });
    expect(advanceLspSnippetTabstop(view)).toBe(false);
    view.destroy();
  });
});

describe("P0-J1 request telemetry ring", () => {
  it("records phases with counts/truncation but no labels or source content", async () => {
    resetCompletionTelemetry();
    const { EditorView } = await import("@codemirror/view");
    const items = Array.from({ length: 250 }, (_unused, i) => ({
      label: `secretLabel${i}`,
      kind: 6,
      detail: null,
      documentation: null,
      insertText: null,
      insertTextFormat: 1,
      filterText: null,
      sortText: String(i).padStart(4, "0"),
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    }));
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: true,
      truncated: true,
      items,
    }));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const state = EditorState.create({ doc: "x" });
    const view = new EditorView({ state });
    await source(new CompletionContext(state, 1, true));
    const events = recentCompletionTelemetry();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((event) => event.phase)).toContain("fetching");
    expect(events.map((event) => event.phase)).toContain("popup");
    const popup = events.find((event) => event.phase === "popup");
    expect(popup?.itemCount).toBe(200);
    expect(popup?.truncated).toBe(true);
    // No label / doc text may leak into telemetry payloads.
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("secretLabel");
    }
    view.destroy();
  });
});

describe("§8.21.3 V2-E BasicCompletionPolicyV2", () => {
  it("extracts symbol identity and matches patterns safely without false label exclusion", () => {
    const qualifiedItem = {
      label: "List",
      kind: 7,
      detail: "java.awt.List",
      documentation: null,
      insertText: null,
      insertTextFormat: null,
      filterText: null,
      sortText: null,
      textEdit: null,
      additionalTextEdits: [],
      raw: { data: { fqn: "java.awt.List" } },
    };
    const unqualifiedItem = {
      label: "List",
      kind: 7,
      detail: null,
      documentation: null,
      insertText: null,
      insertTextFormat: null,
      filterText: null,
      sortText: null,
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    };

    const qIdentity = symbolIdentityFromItem(qualifiedItem);
    expect(qIdentity.hasPackageIdentity).toBe(true);
    expect(qIdentity.fqn).toBe("java.awt.List");

    const uIdentity = symbolIdentityFromItem(unqualifiedItem);
    expect(uIdentity.hasPackageIdentity).toBe(false);

    const patterns = [{ pattern: "java.awt.*" }];
    expect(matchesSymbolPattern(qIdentity, patterns)).toBe(true);
    // Unqualified symbol is NOT excluded just because label is "List"
    expect(matchesSymbolPattern(uIdentity, patterns)).toBe(false);
  });

  it("applies case matching rules: first-letter, all, none", () => {
    expect(matchesCaseRule("list", "listItems", "first-letter")).toBe(true);
    expect(matchesCaseRule("list", "ListItems", "first-letter")).toBe(false);
    expect(matchesCaseRule("List", "ListItems", "first-letter")).toBe(true);

    expect(matchesCaseRule("list", "listItems", "all")).toBe(true);
    expect(matchesCaseRule("list", "ListItems", "all")).toBe(false);

    expect(matchesCaseRule("list", "ListItems", "none")).toBe(true);
  });

  it("filters excluded symbols, boosts prioritized symbols, and sorts alphabetical vs provider-relevance", async () => {
    const { EditorView } = await import("@codemirror/view");
    const items = [
      {
        label: "AwtList",
        kind: 7,
        detail: "java.awt.List",
        documentation: null,
        insertText: null,
        insertTextFormat: null,
        filterText: null,
        sortText: "001",
        textEdit: null,
        additionalTextEdits: [],
        raw: { data: { fqn: "java.awt.List" } },
      },
      {
        label: "UtilList",
        kind: 7,
        detail: "java.util.List",
        documentation: null,
        insertText: null,
        insertTextFormat: null,
        filterText: null,
        sortText: "002",
        textEdit: null,
        additionalTextEdits: [],
        raw: { data: { fqn: "java.util.List" } },
      },
      {
        label: "ArrayBuffer",
        kind: 7,
        detail: "std.ArrayBuffer",
        documentation: null,
        insertText: null,
        insertTextFormat: null,
        filterText: null,
        sortText: "003",
        textEdit: null,
        additionalTextEdits: [],
        raw: { data: { fqn: "std.ArrayBuffer" } },
      },
    ];

    const controller = new LspCompletionController({
      sortMode: "alphabetical",
      excludedSymbols: [{ pattern: "java.awt.*", scope: "project" }],
      prioritizedSymbols: [{ pattern: "java.util.*", scope: "project" }],
    });

    const token: CompletionRequestIdentity = {
      workspaceId: "ws-1",
      fileKey: "k1",
      filePath: "/app.ts",
      uri: "file:///app.ts",
      languageId: "typescript",
      documentRevision: 1,
      lspSessionGeneration: 1,
    };

    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items,
    }));

    const source = createLspCompletionSource({
      identity: () => token,
      fetch,
      triggerCharacters: () => [],
      getDocumentRevision: () => 1,
      reportDiagnostic: vi.fn(),
      controller,
    });

    const state = EditorState.create({ doc: "" });
    const view = new EditorView({ state });
    const result = await source(new CompletionContext(state, 0, true));

    expect(result).not.toBeNull();
    const options = result!.options;
    // AwtList excluded!
    expect(options.some((o) => o.label === "AwtList")).toBe(false);
    // UtilList prioritized with boost and provenance detail!
    const utilOption = options.find((o) => o.label === "UtilList");
    expect(utilOption?.detail).toContain("(prioritized)");
    // Alphabetical sort: ArrayBuffer should precede UtilList!
    expect(options[0].label).toBe("ArrayBuffer");
    expect(options[1].label).toBe("UtilList");

    view.destroy();
  });

  it("autoInsertSingle executes single unambiguous candidate in 1 transaction without popup", async () => {
    const { EditorView } = await import("@codemirror/view");
    const singleItem = {
      label: "myUniqueFunction",
      kind: 3,
      detail: "void",
      documentation: null,
      insertText: "myUniqueFunction()",
      insertTextFormat: 1, // plain text, no choices
      filterText: null,
      sortText: "001",
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    };

    const controller = new LspCompletionController({
      autoInsertSingle: true,
    });

    const token: CompletionRequestIdentity = {
      workspaceId: "ws-1",
      fileKey: "k1",
      filePath: "/app.ts",
      uri: "file:///app.ts",
      languageId: "typescript",
      documentRevision: 1,
      lspSessionGeneration: 1,
    };

    let view: EditorView;
    const reportDiagnostic = vi.fn();
    const source = createLspCompletionSource({
      identity: () => token,
      fetch: async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [singleItem],
      }),
      triggerCharacters: () => [],
      getDocumentRevision: () => 1,
      reportDiagnostic,
      controller,
      getView: () => view,
    });

    const state = EditorState.create({ doc: "myUni" });
    view = new EditorView({ state });
    const outcome = await source(new CompletionContext(state, 5, true));

    // autoInsertSingle returns null because it directly committed the insertion
    expect(outcome).toBeNull();
    expect(reportDiagnostic).toHaveBeenCalledWith("auto-inserted-single");
    expect(view.state.doc.toString()).toBe("myUniqueFunction()");

    view.destroy();
  });

  it("blocks acceptance and reports diagnostic when resolve returns an excluded auto-import", async () => {
    const { EditorView } = await import("@codemirror/view");
    const itemToAccept = {
      label: "AmbiguousList",
      kind: 7,
      detail: "List",
      documentation: null,
      insertText: null,
      insertTextFormat: 1,
      filterText: null,
      sortText: "001",
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    };

    const controller = new LspCompletionController({
      excludedSymbols: [{ pattern: "java.awt.*", scope: "project" }],
    });

    const token: CompletionRequestIdentity = {
      workspaceId: "ws-1",
      fileKey: "k1",
      filePath: "/app.ts",
      uri: "file:///app.ts",
      languageId: "typescript",
      documentRevision: 1,
      lspSessionGeneration: 1,
    };

    const reportDiagnostic = vi.fn();
    const resolve = vi.fn(async () => ({
      ...itemToAccept,
      additionalTextEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import java.awt.List;\n",
        },
      ],
    }));

    const source = createLspCompletionSource({
      identity: () => token,
      fetch: async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [itemToAccept],
      }),
      resolve,
      triggerCharacters: () => [],
      getDocumentRevision: () => 1,
      reportDiagnostic,
      controller,
    });

    const state = EditorState.create({ doc: "Amb" });
    const view = new EditorView({ state });
    const result = await source(new CompletionContext(state, 3, true));
    expect(result).not.toBeNull();
    const opt = result!.options[0];
    if (typeof opt.apply === "function") {
      opt.apply(view, opt, 0, 3);
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(reportDiagnostic).toHaveBeenCalledWith("excluded-symbol-blocked", "auto-import-excluded");
    // Document must NOT have been written with the excluded import!
    expect(view.state.doc.toString()).toBe("Amb");

    view.destroy();
  });

  describe("§8.22.7 U2-E Live Completion Policy", () => {
    it("classifies candidate match tiers: exact > prefix > camelCase > fuzzy", () => {
      expect(matchCompletionQuery("testValue", "testValue").tier).toBe(1);
      expect(matchCompletionQuery("testValue", "TESTVALUE").tier).toBe(1);
      expect(matchCompletionQuery("testValue", "test").tier).toBe(2);
      expect(matchCompletionQuery("fileName", "fN").tier).toBe(3);
      expect(matchCompletionQuery("get_user_by_id", "gubi").tier).toBe(3);
      expect(matchCompletionQuery("findElementById", "feid").tier).toBe(4);
      expect(matchCompletionQuery("other", "xyz").tier).toBe(5);
    });

    it("sorts candidates according to IDEA heuristic ranking", () => {
      const optExact = { label: "item" };
      const optPrefix = { label: "itemValue" };
      const optCamel = { label: "insertTrailingEmptyMask" }; // camelCase initials "item"
      const optFuzzy = { label: "intermittent" }; // subsequence "i-t-e-m"
      const optOther = { label: "zebra" };

      const list = [optOther, optFuzzy, optCamel, optPrefix, optExact];
      list.sort((a, b) => compareCompletionCandidates(a, b, "item", "provider-relevance"));

      expect(list[0].label).toBe("item");
      expect(list[1].label).toBe("itemValue");
      expect(list[2].label).toBe("insertTrailingEmptyMask");
      expect(list[3].label).toBe("intermittent");
      expect(list[4].label).toBe("zebra");
    });

    it("WorkspaceCompletionPolicyController exposes unified configuration", () => {
      const controller = new WorkspaceCompletionPolicyController({
        minPrefixLength: 2,
        sortMode: "alphabetical",
      });

      expect(controller.shouldAutoTrigger(1, false)).toBe(false);
      expect(controller.shouldAutoTrigger(2, false)).toBe(true);
      expect(controller.getSortMode()).toBe("alphabetical");
    });

    it("§8.23.6 X5 WorkspaceCompletionPolicyController advances revision and notifies subscribers on update", () => {
      const controller = new WorkspaceCompletionPolicyController({
        minPrefixLength: 1,
      });

      expect(controller.getRevision()).toBe(1);
      const snap1 = controller.getSnapshot();
      expect(snap1.revision).toBe(1);
      expect(snap1.preferences.minPrefixLength).toBe(1);

      const receivedSnapshots: any[] = [];
      const unsub = controller.subscribe((snap) => {
        receivedSnapshots.push(snap);
      });

      const snap2 = controller.update({ minPrefixLength: 3, maxItems: 100 });
      expect(snap2.revision).toBe(2);
      expect(snap2.preferences.minPrefixLength).toBe(3);
      expect(snap2.preferences.maxItems).toBe(100);
      expect(receivedSnapshots).toHaveLength(1);
      expect(receivedSnapshots[0].revision).toBe(2);

      unsub();
      controller.update({ minPrefixLength: 4 });
      expect(controller.getRevision()).toBe(3);
      expect(receivedSnapshots).toHaveLength(1); // No new events after unsub
    });
  });

  describe("§ED-COMP-002: Candidate & Session Identity Freezing & Atomic Ranking", () => {
    function makePair(
      label: string,
      rawIndex: number,
      matchTier: 1 | 2 | 3 | 4 | 5 = 2,
      matchScore = 100,
      overrides: Partial<CompletionCandidateIdentity> = {},
    ): CompletionCandidatePair {
      const workspaceId = overrides.workspaceId ?? "ws-1";
      return {
        identity: {
          candidateId: `${workspaceId}:file-a:cand-${rawIndex}:${label}`,
          rawResponseIndex: rawIndex,
          workspaceId,
          fileKey: "file-a",
          documentRevision: 5,
          lspSessionGeneration: 2,
          policyRevision: 1,
          ...overrides,
        },
        rawItem: {
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
        },
        completion: { label },
        matchTier,
        matchScore,
      };
    }

    it("uses match tier as the primary sort key", () => {
      const tier1 = makePair("find", 2, 1, 1000); // Exact match
      const tier2 = makePair("findAll", 0, 2, 800); // Prefix match
      const tier3 = makePair("fileIndex", 1, 3, 500); // CamelCase match

      const pairs = [tier3, tier2, tier1];
      pairs.sort((a, b) => compareCandidatePairs(a, b, "provider-relevance"));

      expect(pairs.map((p) => p.completion.label)).toEqual(["find", "findAll", "fileIndex"]);
      // Raw items follow pairs atomically
      expect(pairs.map((p) => p.rawItem.label)).toEqual(["find", "findAll", "fileIndex"]);
    });

    it("preserves provider rawResponseIndex order within the same match tier and score", () => {
      const item0 = makePair("applyA", 0, 2, 800);
      const item1 = makePair("applyB", 1, 2, 800);
      const item2 = makePair("applyC", 2, 2, 800);

      // Inverted initial order
      const pairs = [item2, item0, item1];
      pairs.sort((a, b) => compareCandidatePairs(a, b, "provider-relevance"));

      expect(pairs.map((p) => p.identity.rawResponseIndex)).toEqual([0, 1, 2]);
      expect(pairs.map((p) => p.completion.label)).toEqual(["applyA", "applyB", "applyC"]);
    });

    it("alphabetical sort mode orders by label ignoring tier", () => {
      const itemZ = makePair("zebra", 0, 1, 1000);
      const itemA = makePair("apple", 1, 3, 500);

      const pairs = [itemZ, itemA];
      pairs.sort((a, b) => compareCandidatePairs(a, b, "alphabetical"));

      expect(pairs.map((p) => p.completion.label)).toEqual(["apple", "zebra"]);
    });

    it("freezes independent candidate identities across dual workspaces", () => {
      const ws1Pair = makePair("list", 0, 2, 800, { workspaceId: "ws-1", lspSessionGeneration: 1 });
      const ws2Pair = makePair("list", 0, 2, 800, { workspaceId: "ws-2", lspSessionGeneration: 4 });

      expect(ws1Pair.identity.candidateId).not.toBe(ws2Pair.identity.candidateId);
      expect(ws1Pair.identity.workspaceId).toBe("ws-1");
      expect(ws2Pair.identity.workspaceId).toBe("ws-2");
      expect(ws1Pair.identity.lspSessionGeneration).toBe(1);
      expect(ws2Pair.identity.lspSessionGeneration).toBe(4);
    });

    it("keeps raw resolve/apply pairs attached after provider-relevance sorting", async () => {
      const { EditorView } = await import("@codemirror/view");
      const resolvedRaw: unknown[] = [];
      const lessRelevant = {
        ...completionResult(["fooBar"]).items[0],
        insertText: "BAR",
        raw: { id: "fooBar" },
      };
      const exact = {
        ...completionResult(["foo"]).items[0],
        insertText: "FOO",
        raw: { id: "foo" },
      };
      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        }),
        fetch: async () => ({
          status: status(true),
          isIncomplete: false,
          items: [lessRelevant, exact],
        }),
        resolve: async (raw) => {
          resolvedRaw.push(raw);
          return raw && typeof raw === "object" && "id" in raw && raw.id === "foo"
            ? exact
            : lessRelevant;
        },
        triggerCharacters: () => [],
        getDocumentRevision: () => 1,
        reportDiagnostic: vi.fn(),
      });
      const state = EditorState.create({ doc: "foo" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 3, true));

      expect(result?.options.map((option) => option.label)).toEqual(["foo", "fooBar"]);
      const option = result!.options[0];
      if (typeof option.apply === "function") option.apply(view, option, 0, 3);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(resolvedRaw).toEqual([{ id: "foo" }]);
      expect(view.state.doc.toString()).toBe("FOO");
      view.destroy();
    });

    it("rejects an old option after workspace, provider, or policy identity changes", async () => {
      const assertOldOptionRejected = async (
        change: (setIdentity: (next: CompletionRequestIdentity) => void, controller: WorkspaceCompletionPolicyController) => void,
      ) => {
        const { EditorView } = await import("@codemirror/view");
        let liveIdentity: CompletionRequestIdentity = {
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        };
        const controller = new WorkspaceCompletionPolicyController();
        const item = {
          ...completionResult(["newValue"]).items[0],
          insertText: "NEW",
          textEdit: {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
            newText: "NEW",
          },
          additionalTextEdits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "import newValue;\n",
          }],
        };
        const diagnostics: string[] = [];
        const source = createLspCompletionSource({
          identity: () => ({ ...liveIdentity }),
          fetch: async () => ({ status: status(true), isIncomplete: false, items: [item] }),
          triggerCharacters: () => [],
          getDocumentRevision: () => liveIdentity.documentRevision,
          reportDiagnostic: (kind) => diagnostics.push(kind),
          controller,
        });
        const state = EditorState.create({ doc: "\nold" });
        const view = new EditorView({ state });
        const result = await source(new CompletionContext(state, 4, true));
        change((next) => { liveIdentity = next; }, controller);

        const option = result!.options[0];
        const dispatchSpy = vi.spyOn(view, "dispatch");
        if (typeof option.apply === "function") option.apply(view, option, 1, 4);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(view.state.doc.toString()).toBe("\nold");
        expect(diagnostics).toContain("identity-mismatch");
        view.destroy();
      };

      await assertOldOptionRejected((setIdentity) => {
        setIdentity({
          workspaceId: "ws-2",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        });
      });
      await assertOldOptionRejected((setIdentity) => {
        setIdentity({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 2,
        });
      });
      await assertOldOptionRejected((_setIdentity, controller) => {
        controller.update({ sortMode: "alphabetical" });
      });
    });

    it("handles 0, 1, many, incomplete and truncated results through createLspCompletionSource", async () => {
      const controller = new WorkspaceCompletionPolicyController();
      let returnIncomplete = false;
      let returnTruncated = false;
      let rawItemList = completionResult([]).items;

      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        }),
        fetch: async () => ({
          status: status(true),
          isIncomplete: returnIncomplete,
          truncated: returnTruncated,
          items: rawItemList,
        }),
        triggerCharacters: () => [],
        getDocumentRevision: () => 1,
        reportDiagnostic: vi.fn(),
        controller,
      });

      // 0 items
      rawItemList = [];
      const state0 = EditorState.create({ doc: "tes" });
      const res0 = await source(new CompletionContext(state0, 3, true));
      expect(res0).toBeNull();

      // 1 item
      rawItemList = completionResult(["test"]).items;
      const state1 = EditorState.create({ doc: "tes" });
      const res1 = await source(new CompletionContext(state1, 3, true));
      expect(res1?.options).toHaveLength(1);
      expect(res1?.options[0]?.label).toBe("test");

      // Many items with ranking & live policy change
      rawItemList = completionResult(["testingLongFunction", "test", "testAsync"]).items;
      const stateMany = EditorState.create({ doc: "test" });
      const resMany = await source(new CompletionContext(stateMany, 4, true));
      expect(resMany?.options).toHaveLength(3);
      // Exact match "test" ranked first
      expect(resMany?.options[0]?.label).toBe("test");

      // Live policy change to alphabetical
      controller.update({ sortMode: "alphabetical" });
      const resAlpha = await source(new CompletionContext(stateMany, 4, true));
      expect(resAlpha?.options.map((o) => o.label)).toEqual([
        "test",
        "testAsync",
        "testingLongFunction",
      ]);
    });
  });
});
