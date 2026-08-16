import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  type DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import { offsetFromLspPosition } from "./lspPositions";

function severityRank(severity: number | null): number {
  if (severity === 1) return 3;
  if (severity === 2) return 2;
  return 1;
}

function severityColor(severity: number | null): string {
  if (severity === 1) return "#ef4444";
  if (severity === 2) return "#f59e0b";
  return "#38bdf8";
}

function severityGlyph(severity: number | null): string {
  if (severity === 1) return "●";
  if (severity === 2) return "▲";
  return "ℹ";
}

class DiagnosticGutterMarker extends GutterMarker {
  constructor(private readonly severity: number | null) {
    super();
  }

  eq(other: DiagnosticGutterMarker): boolean {
    return other.severity === this.severity;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-lsp-diag-gutter-mark";
    el.textContent = severityGlyph(this.severity);
    el.style.color = severityColor(this.severity);
    el.title = "Diagnostic";
    return el;
  }
}

class OverviewMarker extends GutterMarker {
  constructor(private readonly severity: number | null) {
    super();
  }

  eq(other: OverviewMarker): boolean {
    return other.severity === this.severity;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-lsp-overview-mark";
    el.style.background = severityColor(this.severity);
    return el;
  }
}

class LightbulbMarker extends GutterMarker {
  constructor(
    private readonly line: number,
    private readonly onLightbulb: (line: number) => void,
  ) {
    super();
  }

  /**
   * `markers` re-runs on every document change, so returning false here rebuilt
   * the button DOM on each keystroke. The handler is a per-chrome-instance
   * reference that callers keep fresh through a ref, so comparing it alongside
   * the line is enough to reuse the existing element.
   */
  eq(other: LightbulbMarker): boolean {
    return other.line === this.line && other.onLightbulb === this.onLightbulb;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cm-lsp-lightbulb";
    el.textContent = "💡";
    el.title = "Show quick fixes (Alt+Enter)";
    el.setAttribute("aria-label", "Show quick fixes");
    el.setAttribute("data-testid", "code-workspace-lightbulb");
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onLightbulb(this.line);
    });
    return el;
  }
}

function worstSeverityByLine(diagnostics: LspDiagnostic[]): Map<number, number | null> {
  const map = new Map<number, number | null>();
  for (const diagnostic of diagnostics) {
    const line = diagnostic.range.start.line;
    const current = map.get(line);
    if (current === undefined || severityRank(diagnostic.severity) > severityRank(current)) {
      map.set(line, diagnostic.severity);
    }
  }
  return map;
}

export function diagnosticClass(severity: number | null): string {
  if (severity === 1) return "cm-lsp-diagnostic-error";
  if (severity === 2) return "cm-lsp-diagnostic-warning";
  return "cm-lsp-diagnostic-info";
}

/**
 * Module-level so the extension identity stays stable across compartment
 * reconfigures. Building it per call would mint a fresh `StyleModule` name on
 * every keystroke, forcing CodeMirror to re-mount every stylesheet and rewrite
 * the editor root class (full-subtree style recalc).
 */
const LSP_DIAGNOSTIC_THEME = EditorView.theme({
  ".cm-lsp-diag-gutter": {
    width: "1.1rem",
  },
  ".cm-lsp-diag-gutter-mark": {
    fontSize: "9px",
    lineHeight: "1",
    display: "inline-flex",
    width: "100%",
    justifyContent: "center",
  },
  ".cm-lsp-lightbulb-gutter": {
    width: "1.2rem",
  },
  ".cm-lsp-lightbulb": {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: "11px",
    lineHeight: "1",
    padding: 0,
    width: "100%",
  },
  ".cm-lsp-overview-gutter": {
    width: "4px",
  },
  ".cm-lsp-overview-mark": {
    width: "3px",
    height: "4px",
    margin: "2px auto 0",
    borderRadius: "1px",
  },
});

export function diagnosticDecorations(view: EditorView, diagnostics: LspDiagnostic[]): DecorationSet {
  const ranges = diagnostics.flatMap((diagnostic) => {
    const from = offsetFromLspPosition(view.state.doc, diagnostic.range.start);
    const rawTo = offsetFromLspPosition(view.state.doc, diagnostic.range.end);
    const to = Math.max(rawTo, Math.min(view.state.doc.length, from + 1));
    if (from >= view.state.doc.length || to <= from) return [];
    return Decoration.mark({
      class: diagnosticClass(diagnostic.severity),
      attributes: { title: diagnostic.message },
    }).range(from, to);
  });
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

export function createDiagnosticChrome(
  diagnostics: LspDiagnostic[],
  onLightbulb?: (line: number) => void,
): Extension[] {
  const byLine = worstSeverityByLine(diagnostics);
  const linesWithDiagnostics = [...byLine.keys()].sort((a, b) => a - b);

  const severityGutter = gutter({
    class: "cm-lsp-diag-gutter",
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const lineNo of linesWithDiagnostics) {
        if (lineNo < 0 || lineNo >= view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNo + 1);
        builder.add(line.from, line.from, new DiagnosticGutterMarker(byLine.get(lineNo) ?? null));
      }
      return builder.finish();
    },
  });

  const overviewGutter = gutter({
    class: "cm-lsp-overview-gutter",
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const lineNo of linesWithDiagnostics) {
        if (lineNo < 0 || lineNo >= view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNo + 1);
        builder.add(line.from, line.from, new OverviewMarker(byLine.get(lineNo) ?? null));
      }
      return builder.finish();
    },
  });

  const lightbulbGutter = gutter({
    class: "cm-lsp-lightbulb-gutter",
    markers: (view) => {
      if (!onLightbulb || linesWithDiagnostics.length === 0) {
        return new RangeSetBuilder<GutterMarker>().finish();
      }
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const lineNo of linesWithDiagnostics) {
        if (lineNo < 0 || lineNo >= view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNo + 1);
        builder.add(line.from, line.from, new LightbulbMarker(lineNo, onLightbulb));
      }
      return builder.finish();
    },
  });

  return [
    EditorView.decorations.of((view) => diagnosticDecorations(view, diagnostics)),
    severityGutter,
    lightbulbGutter,
    overviewGutter,
    LSP_DIAGNOSTIC_THEME,
  ];
}
