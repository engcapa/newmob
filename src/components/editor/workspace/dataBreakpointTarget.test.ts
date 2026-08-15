import { describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { fieldDeclarationAt, isDataBreakpointFieldSymbol } from "./dataBreakpointTarget";

function symbol(overrides: Partial<LspDocumentSymbol> = {}): LspDocumentSymbol {
  return {
    name: "count",
    detail: "int",
    kind: 8,
    depth: 1,
    range: { start: { line: 2, character: 2 }, end: { line: 2, character: 15 } },
    selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } },
    ...overrides,
  };
}

describe("dataBreakpointTarget", () => {
  it("recognizes field-like LSP symbol kinds but excludes locals and methods", () => {
    expect(isDataBreakpointFieldSymbol({ kind: 7 })).toBe(true);
    expect(isDataBreakpointFieldSymbol({ kind: 8 })).toBe(true);
    expect(isDataBreakpointFieldSymbol({ kind: 14 })).toBe(true);
    expect(isDataBreakpointFieldSymbol({ kind: 22 })).toBe(true);
    expect(isDataBreakpointFieldSymbol({ kind: 13 })).toBe(false);
    expect(isDataBreakpointFieldSymbol({ kind: 6 })).toBe(false);
  });

  it("prefers the smallest exact field declaration at the caret", () => {
    const outer = symbol({
      name: "outer",
      range: { start: { line: 0, character: 0 }, end: { line: 8, character: 1 } },
      selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 7 } },
      depth: 0,
    });
    const inner = symbol({ name: "count", depth: 2 });
    expect(fieldDeclarationAt([outer, inner], { line: 2, character: 8 })?.name).toBe("count");
  });

  it("supports declaration-line fallback when the language server narrows the range", () => {
    const field = symbol({
      range: { start: { line: 4, character: 10 }, end: { line: 4, character: 14 } },
      selectionRange: { start: { line: 4, character: 10 }, end: { line: 4, character: 14 } },
    });
    expect(fieldDeclarationAt([field], { line: 4, character: 0 })).toBe(field);
    expect(fieldDeclarationAt([field], { line: 5, character: 0 })).toBeNull();
  });
});

