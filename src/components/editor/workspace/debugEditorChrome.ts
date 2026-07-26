import { StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  hoverTooltip,
  keymap,
  WidgetType,
  type Tooltip,
} from "@codemirror/view";
import { hoverExpressionAt, inlineValueLabel, type DebugStepAction } from "./dapDebugModel";

/**
 * Debug editor chrome (M9 D3): a breakpoint gutter (click a line to toggle), a
 * "current execution line" highlight when the adapter is stopped, IDEA-style
 * inline variable values, hover evaluation, and the debugger keymap. Rendered as
 * a reconfigurable extension so the host swaps it via a compartment, mirroring
 * the Git gutter pattern. Everything here is language-agnostic — it renders DAP
 * state, never Java specifics.
 */

/** A breakpoint marker for the gutter; `conditional` styles it distinctly (D5). */
export interface DebugBreakpointMarker {
  line: number; // 1-based
  conditional: boolean;
  /** Logpoint (logs instead of breaking) — rendered as a diamond. */
  logpoint?: boolean;
  /** False when the adapter could not bind the line (grey hollow marker). */
  verified?: boolean;
  /** False for a breakpoint the user disabled or muted (hollow, not armed). */
  enabled?: boolean;
}

/**
 * Debugger actions the editor keymap and gutter drive. The session-dependent
 * ones return whether they handled the key, so the binding stays transparent
 * when no session is running.
 */
export interface DebugEditorActions {
  toggleBreakpoint: (line: number) => void;
  editBreakpoint: (line: number) => void;
  step?: (action: DebugStepAction) => boolean;
  runToCursor?: (line: number) => boolean;
  stop?: () => boolean;
}

export interface DebugEditorChromeOptions {
  markers: DebugBreakpointMarker[];
  /** 1-based line to highlight as the current execution point, or null. */
  currentLine: number | null;
  actions: DebugEditorActions;
  /** Selected-frame locals as `name → value`; drives inline values. */
  inlineValues?: Record<string, string>;
  /**
   * Evaluate an expression for a hover tooltip. Present only while stopped in
   * this file; resolves to null when the expression has no value.
   */
  evaluate?: ((expression: string) => Promise<{ value: string; type: string | null } | null>) | null;
}

class BreakpointGutterMarker extends GutterMarker {
  constructor(private readonly marker: DebugBreakpointMarker | null) {
    super();
  }

  override toDOM(): Node {
    const dot = document.createElement("span");
    const marker = this.marker ?? { line: 0, conditional: false };
    const disabled = marker.enabled === false;
    const verified = marker.verified !== false;
    dot.textContent = marker.logpoint ? "◆" : disabled || !verified ? "○" : "●";
    dot.style.color = disabled || !verified
      ? "#9ca3af"
      : marker.conditional
        ? "#f59e0b"
        : "#ef4444";
    dot.style.fontSize = "12px";
    dot.title = disabled
      ? "Breakpoint disabled"
      : !verified
        ? "Breakpoint not bound (line not executable or class not loaded yet)"
        : marker.logpoint
          ? "Logpoint"
          : marker.conditional
            ? "Conditional breakpoint"
            : "Breakpoint";
    return dot;
  }
}

/**
 * Build the debug chrome extension for the current session state. Optional
 * pieces (inline values, hover evaluation) are only installed when the caller
 * supplies the data, so a file with no live session pays for nothing but the
 * gutter.
 */
export function createDebugEditorChrome(options: DebugEditorChromeOptions): Extension {
  const { markers, currentLine, actions } = options;
  const byLine = new Map(markers.map((m) => [m.line, m]));
  const extensions: Extension[] = [
    gutter({
      class: "taomni-debug-gutter",
      lineMarker: (view, lineBlock) => {
        const line = view.state.doc.lineAt(lineBlock.from).number;
        const marker = byLine.get(line);
        return marker ? new BreakpointGutterMarker(marker) : null;
      },
      initialSpacer: () => new BreakpointGutterMarker(null),
      domEventHandlers: {
        mousedown: (view, lineBlock, event) => {
          const line = view.state.doc.lineAt(lineBlock.from).number;
          // Right-click (or ctrl-click) edits a breakpoint's condition/logpoint;
          // plain click toggles it (D5).
          const mouse = event as MouseEvent;
          if (mouse.button === 2 || mouse.ctrlKey) {
            actions.editBreakpoint(line);
          } else {
            actions.toggleBreakpoint(line);
          }
          return true;
        },
        contextmenu: (view, lineBlock) => {
          const line = view.state.doc.lineAt(lineBlock.from).number;
          actions.editBreakpoint(line);
          return true;
        },
      },
    }),
    debuggerKeymap(actions),
  ];
  if (currentLine != null) {
    extensions.push(currentLineHighlight(currentLine));
  }
  if (options.inlineValues && Object.keys(options.inlineValues).length > 0 && currentLine != null) {
    extensions.push(inlineValueChrome(options.inlineValues, currentLine));
  }
  if (options.evaluate) {
    extensions.push(debugHoverEvaluation(options.evaluate));
  }
  return extensions;
}

/**
 * IDEA's debugger keys. Bound at default precedence — CodeMirror's standard
 * keymaps claim none of these — and inert when no session is running, so the
 * same extension serves an idle editor.
 */
function debuggerKeymap(actions: DebugEditorActions): Extension {
  const stepWith = (action: DebugStepAction) => () => actions.step?.(action) ?? false;
  return keymap.of([
    { key: "F9", run: stepWith("continue") },
    { key: "F8", run: stepWith("stepOver") },
    { key: "F7", run: stepWith("stepIn") },
    { key: "Shift-F8", run: stepWith("stepOut") },
    {
      key: "Ctrl-F8",
      run: (view) => {
        actions.toggleBreakpoint(view.state.doc.lineAt(view.state.selection.main.head).number);
        return true;
      },
    },
    {
      key: "Ctrl-Shift-F8",
      run: (view) => {
        actions.editBreakpoint(view.state.doc.lineAt(view.state.selection.main.head).number);
        return true;
      },
    },
    {
      key: "Alt-F9",
      run: (view) => actions.runToCursor?.(
        view.state.doc.lineAt(view.state.selection.main.head).number,
      ) ?? false,
    },
    { key: "Ctrl-F2", run: () => actions.stop?.() ?? false },
  ]);
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

/** End-of-line widget showing `name = value` pairs (IDEA inline values). */
class InlineValueWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: InlineValueWidget): boolean {
    return other.label === this.label;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "taomni-debug-inline-value";
    span.textContent = `  ${this.label}`;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Inline values for the stopped frame, rendered at the end of each line that
 * mentions a local. Only lines up to the current execution point get them —
 * code that has not run yet has no values to show, which is what IDEA does.
 */
function inlineValueChrome(variables: Record<string, string>, currentLine: number): Extension {
  const build = (doc: Text) => {
    const decorations = [];
    const last = Math.min(currentLine, doc.lines);
    // Bound the scan so a huge file cannot cost more than a screenful of work.
    const first = Math.max(1, last - 500);
    for (let line = first; line <= last; line += 1) {
      const info = doc.line(line);
      const label = inlineValueLabel(info.text, variables);
      if (!label) continue;
      decorations.push(
        Decoration.widget({ widget: new InlineValueWidget(label), side: 1 }).range(info.to),
      );
    }
    return Decoration.set(decorations);
  };
  const field = StateField.define({
    create: (state) => build(state.doc),
    update: (value, tr) => (tr.docChanged ? build(tr.state.doc) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.baseTheme({
      ".taomni-debug-inline-value": {
        color: "#9ca3af",
        fontStyle: "italic",
        opacity: "0.9",
        pointerEvents: "none",
      },
    }),
  ];
}

/**
 * Hover a variable while stopped to see its value (IDEA's inspect-on-hover).
 * The expression under the pointer is extracted syntax-free so this works for
 * every language the DAP framework serves.
 */
function debugHoverEvaluation(
  evaluate: (expression: string) => Promise<{ value: string; type: string | null } | null>,
): Extension {
  return hoverTooltip((view, pos): Promise<Tooltip | null> => {
    const line = view.state.doc.lineAt(pos);
    const expression = hoverExpressionAt(line.text, pos - line.from);
    if (!expression) return Promise.resolve(null);
    return evaluate(expression).then((result) => {
      if (!result) return null;
      return {
        pos,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover taomni-debug-hover";
          const name = document.createElement("span");
          name.className = "taomni-debug-hover-expr";
          name.textContent = expression;
          const value = document.createElement("span");
          value.textContent = ` = ${result.value}`;
          dom.append(name, value);
          if (result.type) {
            const type = document.createElement("div");
            type.className = "taomni-debug-hover-type";
            type.textContent = result.type;
            dom.append(type);
          }
          return { dom };
        },
      };
    });
  });
}
