import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { computeStickyLines, StickyLinesOverlay } from "./stickyLines";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";

describe("computeStickyLines", () => {
  const sampleSymbols: LspDocumentSymbol[] = [
    {
      name: "MyClass",
      kind: 5,
      range: {
        start: { line: 2, character: 0 },
        end: { line: 50, character: 1 },
      },
      selectionRange: {
        start: { line: 2, character: 6 },
        end: { line: 2, character: 13 },
      },
      children: [
        {
          name: "constructor",
          kind: 9,
          range: {
            start: { line: 5, character: 2 },
            end: { line: 15, character: 3 },
          },
          selectionRange: {
            start: { line: 5, character: 2 },
            end: { line: 5, character: 13 },
          },
        },
        {
          name: "calculateTotal",
          kind: 6,
          range: {
            start: { line: 20, character: 2 },
            end: { line: 40, character: 3 },
          },
          selectionRange: {
            start: { line: 20, character: 2 },
            end: { line: 20, character: 16 },
          },
          children: [
            {
              name: "innerHelper",
              kind: 12,
              range: {
                start: { line: 25, character: 4 },
                end: { line: 35, character: 5 },
              },
              selectionRange: {
                start: { line: 25, character: 4 },
                end: { line: 25, character: 15 },
              },
            },
          ],
        },
      ],
    },
  ];

  const docLines = [
    "// Header",
    "",
    "export class MyClass {",
    "  private value: number;",
    "",
    "  constructor() {",
    "    this.value = 42;",
    "  }",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "  }",
    "",
    "",
    "",
    "",
    "  public calculateTotal(): number {",
    "    const a = 10;",
    "    const b = 20;",
    "    ",
    "    function innerHelper() {",
    "      return a + b;",
    "    }",
    "    return innerHelper();",
    "  }",
    "}",
  ];

  it("returns empty array when at top of document or no symbols", () => {
    expect(computeStickyLines(undefined, docLines, 0)).toEqual([]);
    expect(computeStickyLines([], docLines, 10)).toEqual([]);
    expect(computeStickyLines(sampleSymbols, docLines, 0)).toEqual([]);
    expect(computeStickyLines(sampleSymbols, docLines, 1)).toEqual([]);
  });

  it("computes single enclosing class header when inside class before methods", () => {
    const sticky = computeStickyLines(sampleSymbols, docLines, 3);
    expect(sticky).toHaveLength(1);
    expect(sticky[0]).toEqual({
      line: 2,
      text: "export class MyClass {",
      name: "MyClass",
      kind: 5,
      depth: 0,
    });
  });

  it("computes nested sticky headers when inside inner function", () => {
    const sticky = computeStickyLines(sampleSymbols, docLines, 28);
    expect(sticky).toHaveLength(3);
    expect(sticky[0].name).toBe("MyClass");
    expect(sticky[0].line).toBe(2);
    expect(sticky[1].name).toBe("calculateTotal");
    expect(sticky[1].line).toBe(20);
    expect(sticky[2].name).toBe("innerHelper");
    expect(sticky[2].line).toBe(25);
  });

  it("respects maxLines boundary", () => {
    const sticky = computeStickyLines(sampleSymbols, docLines, 28, 2);
    expect(sticky).toHaveLength(2);
    expect(sticky[0].name).toBe("MyClass");
    expect(sticky[1].name).toBe("calculateTotal");
  });
});

describe("StickyLinesOverlay", () => {
  it("renders nothing when stickyLines is empty", () => {
    const { container } = render(
      <StickyLinesOverlay stickyLines={[]} onSelectLine={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders sticky lines and triggers onSelectLine on click", () => {
    const onSelectLine = vi.fn();
    render(
      <StickyLinesOverlay
        stickyLines={[
          {
            line: 2,
            text: "export class MyClass {",
            name: "MyClass",
            kind: 5,
            depth: 0,
          },
          {
            line: 20,
            text: "public calculateTotal(): number {",
            name: "calculateTotal",
            kind: 6,
            depth: 1,
          },
        ]}
        onSelectLine={onSelectLine}
      />,
    );

    expect(screen.getByTestId("code-workspace-sticky-lines")).toBeInTheDocument();
    const entries = screen.getAllByTestId("code-workspace-sticky-line-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("export class MyClass {");
    expect(entries[1]).toHaveTextContent("public calculateTotal(): number {");

    fireEvent.click(entries[1]);
    expect(onSelectLine).toHaveBeenCalledWith(20);
  });
});
