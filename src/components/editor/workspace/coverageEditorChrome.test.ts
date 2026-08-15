import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createCoverageEditorChrome } from "./coverageEditorChrome";
import type { FileCoverage } from "./coverageModel";

describe("coverageEditorChrome", () => {
  it("renders coverage gutter markers for covered, partial, and uncovered lines", () => {
    const coverage: FileCoverage = {
      path: "src/demo.ts",
      linesTotal: 3,
      linesCovered: 2,
      percentage: 67,
      lines: new Map([
        [1, { line: 1, hits: 2, status: "covered" }],
        [2, { line: 2, hits: 1, branchesTotal: 2, branchesCovered: 1, status: "partial" }],
        [3, { line: 3, hits: 0, status: "uncovered" }],
      ]),
    };

    const extensions = createCoverageEditorChrome(coverage, true);
    const parent = document.createElement("div");
    const state = EditorState.create({
      doc: "const a = 1;\nif (a) return;\nconsole.log(2);\n",
      extensions,
    });
    const view = new EditorView({ state, parent });

    const markers = parent.querySelectorAll(".cm-coverage-marker");
    expect(markers.length).toBe(3);
    expect(markers[0]?.classList.contains("cm-coverage-covered")).toBe(true);
    expect(markers[1]?.classList.contains("cm-coverage-partial")).toBe(true);
    expect(markers[2]?.classList.contains("cm-coverage-uncovered")).toBe(true);

    view.destroy();
  });

  it("returns empty extension array when disabled or no coverage data", () => {
    expect(createCoverageEditorChrome(null, true)).toHaveLength(0);
    const coverage: FileCoverage = {
      path: "src/demo.ts",
      linesTotal: 0,
      linesCovered: 0,
      percentage: 100,
      lines: new Map(),
    };
    expect(createCoverageEditorChrome(coverage, false)).toHaveLength(0);
  });
});
