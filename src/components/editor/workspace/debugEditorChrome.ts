import { StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
} from "@codemirror/view";

/**
 * Debug editor chrome (M9 D3): a breakpoint gutter (click a line to toggle) plus
 * a "current execution line" highlight when the adapter is stopped. Rendered as
 * a reconfigurable extension so the host swaps it via a compartment, mirroring
 * the Git gutter pattern.
 */

/** A breakpoint marker for the gutter; `conditional` styles it distinctly (D5). */
export interface DebugBreakpointMarker {
  line: number; // 1-based
  conditional: boolean;
}

class BreakpointGutterMarker extends GutterMarker {
  constructor(private readonly conditional: boolean) {
    super();
  }

  override toDOM(): Node {
    const dot = document.createElement("span");
    dot.textContent = "●";
    dot.style.color = this.conditional ? "#f59e0b" : "#ef4444";
    dot.style.fontSize = "12px";
    dot.title = this.conditional ? "Conditional breakpoint" : "Breakpoint";
    return dot;
  }
}

/**
 * Build the debug chrome extension: a clickable breakpoint gutter for the given
 * markers, and a background highlight on `currentLine` (1-based, or null).
 * `onToggle` receives the 1-based line clicked in the gutter.
 */
export function createDebugEditorChrome(
  markers: DebugBreakpointMarker[],
  currentLine: number | null,
  onToggle: (line: number) => void,
): Extension {
  const byLine = new Map(markers.map((m) => [m.line, m]));
  const extensions: Extension[] = [
    gutter({
      class: "taomni-debug-gutter",
      lineMarker: (view, lineBlock) => {
        const line = view.state.doc.lineAt(lineBlock.from).number;
        const marker = byLine.get(line);
        return marker ? new BreakpointGutterMarker(marker.conditional) : null;
      },
      initialSpacer: () => new BreakpointGutterMarker(false),
      domEventHandlers: {
        mousedown: (view, lineBlock) => {
          const line = view.state.doc.lineAt(lineBlock.from).number;
          onToggle(line);
          return true;
        },
      },
    }),
  ];
  if (currentLine != null) {
    extensions.push(currentLineHighlight(currentLine));
  }
  return extensions;
}
const currentLineDecoration = Decoration.line({ class: "taomni-debug-current-line" });

/** A static line-background highlight on the 1-based `line` (clamped to doc). */
function currentLineHighlight(line: number): Extension {
  const field = StateField.define({
    create: (state) => decorationFor(state.doc, line),
    update: (value, tr) => (tr.docChanged ? decorationFor(tr.state.doc, line) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.baseTheme({
      ".taomni-debug-current-line": { backgroundColor: "rgba(250, 204, 21, 0.18)" },
    }),
  ];
}

function decorationFor(doc: Text, line: number) {
  if (line < 1 || line > doc.lines) return Decoration.none;
  const lineInfo = doc.line(line);
  return Decoration.set([currentLineDecoration.range(lineInfo.from)]);
}

