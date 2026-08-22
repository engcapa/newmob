import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { createLspCompletionSource, MAX_COMPLETION_OPTIONS } from "./lspCompletion";
import { CodeMirrorHost } from "./CodeMirrorHost";
import type { LspCompletionResult, LspDiagnostic, LspDocumentStatus } from "../../../lib/editor/lsp";

function testDocStatus(active = true): LspDocumentStatus {
  return {
    path: "Main.java",
    uri: "file:///src/Main.java",
    presetId: "java",
    languageId: "java",
    displayName: "Java",
    available: true,
    active,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

function testCompletionResult(itemsCount = 500): LspCompletionResult {
  return {
    status: testDocStatus(true),
    isIncomplete: true,
    items: Array.from({ length: itemsCount }, (_, i) => ({
      label: `method${i}`,
      kind: 2,
      detail: `void method${i}()`,
      documentation: `Documentation for method ${i}`,
      insertText: `method${i}()`,
      insertTextFormat: 1,
      filterText: `method${i}`,
      sortText: `000${i}`,
      textEdit: null,
      additionalTextEdits: [],
      raw: { id: i },
    })),
  };
}

describe("Editor typing and completion performance verification", () => {
  it("debounces rapid continuous typing burst to avoid spamming LSP fetches", async () => {
    const fetch = vi.fn(async () => testCompletionResult(100));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [".", ":"] });

    // Simulate user typing 'String' rapidly (6 keystrokes, ~30ms apart)
    const typedWords = ["S", "St", "Str", "Stri", "Strin", "String"];
    const contexts: CompletionContext[] = [];
    const promises: Promise<unknown>[] = [];

    for (let i = 0; i < typedWords.length; i++) {
      const state = EditorState.create({ doc: typedWords[i] });
      const ctx = new CompletionContext(state, typedWords[i]!.length, false);
      contexts.push(ctx);

      // Previous context aborted when next keystroke arrives
      if (i > 0) {
        const prev = contexts[i - 1] as unknown as { abortListeners?: Array<() => void> };
        Object.defineProperty(contexts[i - 1], "aborted", { value: true, configurable: true });
        prev.abortListeners?.forEach((l) => l());
      }

      promises.push(Promise.resolve(source(ctx)));
    }

    const results = await Promise.all(promises);

    // All intermediate keystrokes should have aborted early with null
    for (let i = 0; i < typedWords.length - 1; i++) {
      expect(results[i]).toBeNull();
    }
    // Only the final completed keystroke should fetch
    expect(results[typedWords.length - 1]).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("processes large completion item lists (1000+ items) efficiently without main-thread stall", async () => {
    const fetch = vi.fn(async () => testCompletionResult(1500));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [".", ":"] });

    const state = EditorState.create({ doc: "obj.m" });
    const ctx = new CompletionContext(state, 5, false);

    const start = performance.now();
    const result = await source(ctx);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result?.options.length).toBeLessThanOrEqual(400);
    // Processing time must stay well within frame budget (<150ms)
    expect(elapsed).toBeLessThan(150);
  });

  it("materializes only the bounded visible head of oversized Java completion lists", async () => {
    const response = testCompletionResult(5_000);
    let mappedItems = 0;
    for (const item of response.items) {
      const filterText = item.filterText;
      Object.defineProperty(item, "filterText", {
        configurable: true,
        get: () => {
          mappedItems += 1;
          return filterText;
        },
      });
    }
    const source = createLspCompletionSource({
      fetch: vi.fn(async () => response),
      triggerCharacters: () => [".", ":"],
    });
    const state = EditorState.create({ doc: "service.m" });

    const result = await source(new CompletionContext(state, state.doc.length, false));

    expect(result?.options).toHaveLength(MAX_COMPLETION_OPTIONS);
    expect(mappedItems).toBe(MAX_COMPLETION_OPTIONS * 2);
  });

  it("prevents redundant CodeMirror compartment dispatches on parent re-renders with unchanged props", () => {
    const props = {
      path: "Main.java",
      doc: "public class Main {}",
      visible: true,
      diagnostics: [],
      reveal: null,
      readOnly: false,
      softWrap: false,
      onChange: vi.fn(),
      onSave: vi.fn(),
      onHover: vi.fn(async () => null),
      onDefinition: vi.fn(async () => false),
      onReferences: vi.fn(async () => {}),
    };

    const { rerender } = render(<CodeMirrorHost {...props} />);

    // Re-render multiple times with same props (simulating surrounding workspace state churn)
    rerender(<CodeMirrorHost {...props} />);
    rerender(<CodeMirrorHost {...props} />);
    rerender(<CodeMirrorHost {...props} />);

    expect(props.onChange).not.toHaveBeenCalled();
  });

  // The case above passes `diagnostics: []`, which satisfies the both-empty
  // short-circuit trivially. A real Java buffer almost always has diagnostics,
  // and a caller that rebuilt the array per render used to force a full
  // diagnostics-compartment reconfigure on every keystroke: a fresh
  // EditorView.theme (new StyleModule mount + editor-root class rewrite) plus
  // three rebuilt gutters.
  it("does not rebuild diagnostics chrome when re-rendered with an equal non-empty diagnostics array", () => {
    const diagnostic: LspDiagnostic = {
      range: { start: { line: 0, character: 13 }, end: { line: 0, character: 17 } },
      severity: 1,
      code: null,
      source: "jdtls",
      message: "cannot find symbol",
    };
    const onLightbulb = vi.fn();
    const baseProps = {
      path: "Main.java",
      doc: "public class Main {}",
      visible: true,
      reveal: null,
      readOnly: false,
      softWrap: false,
      onChange: vi.fn(),
      onSave: vi.fn(),
      onHover: vi.fn(async () => null),
      onDefinition: vi.fn(async () => false),
      onReferences: vi.fn(async () => {}),
      onLightbulb,
    };

    const { container, rerender } = render(
      <CodeMirrorHost {...baseProps} diagnostics={[diagnostic]} />,
    );
    const editorRoot = container.querySelector(".cm-editor") as HTMLElement;
    const themeClasses = editorRoot.className;
    const lightbulb = container.querySelector('[data-testid="code-workspace-lightbulb"]');
    expect(lightbulb).toBeTruthy();

    // Fresh array identity per render, identical contents.
    rerender(<CodeMirrorHost {...baseProps} diagnostics={[diagnostic]} />);
    rerender(<CodeMirrorHost {...baseProps} diagnostics={[diagnostic]} />);
    rerender(<CodeMirrorHost {...baseProps} diagnostics={[diagnostic]} />);

    // A reconfigure would mint a new theme class and swap the gutter DOM.
    expect(editorRoot.className).toBe(themeClasses);
    expect(container.querySelector('[data-testid="code-workspace-lightbulb"]')).toBe(lightbulb);

    // Genuinely different diagnostics must still reconfigure without minting a
    // new theme class: an EditorView.theme built per call would re-mount every
    // stylesheet and rewrite the editor root class each time.
    rerender(
      <CodeMirrorHost
        {...baseProps}
        diagnostics={[{ ...diagnostic, message: "incompatible types" }]}
      />,
    );
    expect(editorRoot.className).toBe(themeClasses);
  });
});
