import { describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import type { BreadcrumbPathSegment } from "./Breadcrumbs";
import {
  buildNavigationBarSegments,
  navigateSegments,
} from "./navigationBarModel";

describe("navigationBarModel", () => {
  const pathSegments: BreadcrumbPathSegment[] = [
    { kind: "root", label: "my-project", path: "/workspace" },
    { kind: "directory", label: "src", path: "src" },
    { kind: "file", label: "App.tsx", path: "src/App.tsx" },
  ];

  const symbols: LspDocumentSymbol[] = [
    {
      name: "App",
      kind: 12,
      depth: 0,
      detail: null,
      range: { start: { line: 10, character: 0 }, end: { line: 50, character: 1 } },
      selectionRange: { start: { line: 10, character: 16 }, end: { line: 10, character: 19 } },
    },
    {
      name: "handleClick",
      kind: 6,
      depth: 1,
      detail: null,
      range: { start: { line: 20, character: 2 }, end: { line: 30, character: 3 } },
      selectionRange: { start: { line: 20, character: 11 }, end: { line: 20, character: 22 } },
    },
  ];

  it("builds sequential segments matching path and nested symbols", () => {
    const segments = buildNavigationBarSegments(
      pathSegments,
      symbols,
      { line: 25, character: 4 },
    );

    expect(segments.map((s) => s.label)).toEqual(["my-project", "src", "App.tsx", "App", "handleClick"]);
    expect(segments[0].kind).toBe("root");
    expect(segments[1].kind).toBe("directory");
    expect(segments[2].kind).toBe("file");
    expect(segments[3].kind).toBe("symbol");
    expect(segments[4].kind).toBe("symbol");
  });

  it("handles empty symbols or positions outside symbols gracefully", () => {
    const segments = buildNavigationBarSegments(
      pathSegments,
      [],
      { line: 0, character: 0 },
    );
    expect(segments.map((s) => s.label)).toEqual(["my-project", "src", "App.tsx"]);
  });

  it("navigates left, right, first, and last with boundary clamping", () => {
    expect(navigateSegments(0, 5, "left")).toBe(0);
    expect(navigateSegments(2, 5, "left")).toBe(1);
    expect(navigateSegments(2, 5, "right")).toBe(3);
    expect(navigateSegments(4, 5, "right")).toBe(4);
    expect(navigateSegments(2, 5, "first")).toBe(0);
    expect(navigateSegments(2, 5, "last")).toBe(4);
  });
});
