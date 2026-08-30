import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import {
  Facet,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import {
  extractDocComments,
  type DocCommentRange,
  isDocCommentRenderingSupported,
} from "./renderedDocCommentsModel";
import {
  openExternalDocumentation,
  referenceHrefFromEventTarget,
} from "./referenceDocumentation";

export interface RenderedDocDecorationConfig {
  languageId: string | null | undefined;
  enabled: boolean;
  onToggleRaw?: () => void;
}

const DEFAULT_RENDERED_DOC_CONFIG: RenderedDocDecorationConfig = {
  languageId: null,
  enabled: false,
};

/** Configuration is reconfigured without replacing the editor document. */
export const renderedDocDecorationConfig = Facet.define<
  RenderedDocDecorationConfig,
  RenderedDocDecorationConfig
>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_RENDERED_DOC_CONFIG,
});

export class RenderedDocWidget extends WidgetType {
  constructor(
    readonly docRange: DocCommentRange,
    readonly onToggleRaw?: () => void,
  ) {
    super();
  }

  eq(other: RenderedDocWidget): boolean {
    return this.docRange.id === other.docRange.id && this.docRange.renderedHtml === other.docRange.renderedHtml;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-rendered-doc-comment";
    container.setAttribute("data-testid", `rendered-doc-${this.docRange.id}`);
    container.setAttribute("aria-label", "Rendered documentation");

    const header = document.createElement("div");
    header.className = "cm-rendered-doc-header";

    const title = document.createElement("span");
    title.className = "cm-rendered-doc-title";
    title.textContent = "Documentation";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "cm-rendered-doc-toggle-btn";
    toggleBtn.textContent = "Raw";
    toggleBtn.title = "View raw doc comment";
    toggleBtn.setAttribute("aria-label", "View raw documentation comment");
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onToggleRaw?.();
    });

    header.append(title, toggleBtn);

    const body = document.createElement("div");
    body.className = "cm-rendered-doc-body";
    body.innerHTML = this.docRange.renderedHtml;
    body.addEventListener("click", (event) => {
      const href = referenceHrefFromEventTarget(event.target);
      if (href) {
        event.preventDefault();
        event.stopPropagation();
        void openExternalDocumentation(href);
        return;
      }
      event.stopPropagation();
      this.onToggleRaw?.();
    });

    container.append(header, body);
    return container;
  }
}

export function buildRenderedDocDecorations(
  text: string,
  languageId: string,
  enabled: boolean,
  onToggleRaw?: () => void,
): DecorationSet {
  if (!enabled || !isDocCommentRenderingSupported(languageId)) {
    return Decoration.none;
  }

  const comments = extractDocComments(text, languageId);
  if (comments.length === 0) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const doc of comments) {
    builder.add(
      doc.from,
      doc.to,
      Decoration.replace({
        widget: new RenderedDocWidget(doc, onToggleRaw),
        block: true,
      }),
    );
  }

  return builder.finish();
}

/**
 * Rebuilds decorations from the live CodeMirror document. This keeps widget
 * ranges and rendered HTML aligned after user edits, remote edits, and disk
 * snapshots while the underlying document/selection remains untouched.
 */
export const renderedDocDecorationField = StateField.define<DecorationSet>({
  create: (state) => {
    const config = state.facet(renderedDocDecorationConfig);
    return buildRenderedDocDecorations(
      state.doc.toString(),
      config.languageId ?? "",
      config.enabled,
      config.onToggleRaw,
    );
  },
  update: (decorations, transaction) => {
    const config = transaction.state.facet(renderedDocDecorationConfig);
    const previousConfig = transaction.startState.facet(renderedDocDecorationConfig);
    if (transaction.docChanged || config !== previousConfig) {
      return buildRenderedDocDecorations(
        transaction.state.doc.toString(),
        config.languageId ?? "",
        config.enabled,
        config.onToggleRaw,
      );
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const RENDERED_DOC_THEME = EditorView.theme({
  ".cm-rendered-doc-comment": {
    margin: "4px 0",
    padding: "8px 12px",
    background: "var(--taomni-code-gutter-bg)",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "6px",
    color: "var(--taomni-code-text)",
    fontSize: "12px",
    lineHeight: "1.5",
  },
  ".cm-rendered-doc-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "6px",
    paddingBottom: "4px",
    borderBottom: "1px solid var(--taomni-code-border)",
  },
  ".cm-rendered-doc-title": {
    fontSize: "11px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--taomni-code-muted)",
  },
  ".cm-rendered-doc-toggle-btn": {
    fontSize: "11px",
    padding: "1px 6px",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "3px",
    background: "var(--taomni-code-bg)",
    color: "var(--taomni-code-text)",
    cursor: "pointer",
  },
  ".cm-rendered-doc-toggle-btn:hover": {
    background: "var(--taomni-code-active-line-bg)",
  },
  ".cm-rendered-doc-body": {
    userSelect: "text",
  },
  ".cm-rendered-doc-body p": {
    margin: "4px 0",
  },
  ".cm-rendered-doc-body code": {
    background: "var(--taomni-code-bg)",
    padding: "1px 4px",
    borderRadius: "3px",
    fontFamily: "var(--taomni-code-font-family)",
    fontSize: "11px",
  },
  ".cm-rendered-doc-body img": {
    maxWidth: "100%",
    maxHeight: "240px",
    objectFit: "contain",
    verticalAlign: "middle",
  },
  ".cm-rendered-doc-image-placeholder": {
    display: "inline-block",
    padding: "2px 6px",
    border: "1px dashed var(--taomni-code-border)",
    color: "var(--taomni-code-muted)",
  },
});
