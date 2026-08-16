import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import type { FileCoverage, LineCoverage } from "./coverageModel";

class CoverageGutterMarker extends GutterMarker {
  constructor(private readonly lineCov: LineCoverage) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-coverage-marker cm-coverage-${this.lineCov.status}`;
    let tip = `Line ${this.lineCov.line}: `;
    if (this.lineCov.status === "covered") {
      tip += `Covered (${this.lineCov.hits} hit${this.lineCov.hits === 1 ? "" : "s"})`;
    } else if (this.lineCov.status === "partial") {
      tip += `Partially covered (${this.lineCov.branchesCovered ?? 0}/${this.lineCov.branchesTotal ?? 0} branches)`;
    } else {
      tip += "Not covered";
    }
    el.title = tip;
    el.setAttribute("aria-label", tip);
    return el;
  }
}

/** Module-level to keep the extension identity stable across reconfigures. */
const COVERAGE_THEME = EditorView.theme({
  ".cm-coverage-gutter": {
    width: "4px",
    minWidth: "4px",
    marginRight: "2px",
  },
  ".cm-coverage-gutter .cm-gutterElement": {
    padding: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-coverage-marker": {
    width: "3px",
    height: "100%",
    minHeight: "1.2em",
    borderRadius: "1px",
    transition: "background-color 0.15s ease",
  },
  ".cm-coverage-marker.cm-coverage-covered": {
    backgroundColor: "#10b981", // Emerald 500
  },
  ".cm-coverage-marker.cm-coverage-partial": {
    backgroundColor: "#f59e0b", // Amber 500
  },
  ".cm-coverage-marker.cm-coverage-uncovered": {
    backgroundColor: "#ef4444", // Rose 500
  },
});

export function createCoverageEditorChrome(
  coverage: FileCoverage | null,
  enabled = true,
): Extension[] {
  if (!enabled || !coverage || coverage.lines.size === 0) return [];

  const coverageGutter = gutter({
    class: "cm-coverage-gutter",
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const sortedLines = [...coverage.lines.entries()].sort(([a], [b]) => a - b);
      for (const [lineNr, lineCov] of sortedLines) {
        if (lineNr < 1 || lineNr > view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNr);
        builder.add(line.from, line.from, new CoverageGutterMarker(lineCov));
      }
      return builder.finish();
    },
  });

  return [coverageGutter, COVERAGE_THEME];
}
