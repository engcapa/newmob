import type { Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type {
  LspDocumentHighlight,
  LspInlayHint,
  LspPosition,
  LspRange,
  LspSemanticToken,
} from "../../../lib/editor/lsp";
import { offsetFromLspPosition } from "./lspPositions";

class InlayHintWidget extends WidgetType {
  constructor(private readonly hint: LspInlayHint) {
    super();
  }

  eq(other: InlayHintWidget): boolean {
    return other.hint.label === this.hint.label
      && other.hint.kind === this.hint.kind
      && other.hint.tooltip === this.hint.tooltip;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-lsp-inlay-hint cm-lsp-inlay-${this.hint.kind === 2 ? "parameter" : "type"}`;
    span.textContent = `${this.hint.paddingLeft ? " " : ""}${this.hint.label}${this.hint.paddingRight ? " " : ""}`;
    if (this.hint.tooltip) span.title = this.hint.tooltip;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function rangeOffsets(doc: Text, range: LspRange): { from: number; to: number } {
  return {
    from: offsetFromLspPosition(doc, range.start),
    to: offsetFromLspPosition(doc, range.end),
  };
}

function semanticTokenClass(token: LspSemanticToken): string {
  const type = token.tokenType.replace(/[^a-zA-Z0-9_-]/g, "-");
  const mods = token.modifiers
    .map((modifier) => modifier.replace(/[^a-zA-Z0-9_-]/g, "-"))
    .filter(Boolean)
    .map((modifier) => `cm-lsp-sem-mod-${modifier}`);
  return ["cm-lsp-sem", `cm-lsp-sem-${type}`, ...mods].join(" ");
}

export function buildLspIntelligenceDecorations(
  doc: Text,
  highlights: LspDocumentHighlight[],
  hints: LspInlayHint[],
  semanticTokens: LspSemanticToken[] = [],
): DecorationSet {
  const ranges = semanticTokens.flatMap((token) => {
    const { from, to } = rangeOffsets(doc, token.range);
    if (to <= from) return [];
    return [Decoration.mark({ class: semanticTokenClass(token) }).range(from, to)];
  });
  for (const highlight of highlights) {
    const { from, to } = rangeOffsets(doc, highlight.range);
    if (to <= from) continue;
    const suffix = highlight.kind === 3 ? "write" : highlight.kind === 2 ? "read" : "text";
    ranges.push(Decoration.mark({ class: `cm-lsp-usage cm-lsp-usage-${suffix}` }).range(from, to));
  }
  for (const hint of hints) {
    const position = offsetFromLspPosition(doc, hint.position);
    ranges.push(Decoration.widget({
      widget: new InlayHintWidget(hint),
      side: 1,
    }).range(position));
  }
  return Decoration.set(ranges, true);
}

/**
 * Semantic tokens are typically the largest LSP payload. Keep their
 * decorations separate from cursor-dependent highlights and viewport hints so
 * a highlight refresh does not rebuild the whole document's token chrome.
 */
export function buildLspSemanticTokenDecorations(
  doc: Text,
  semanticTokens: LspSemanticToken[] = [],
): DecorationSet {
  const ranges = semanticTokens.flatMap((token) => {
    const { from, to } = rangeOffsets(doc, token.range);
    if (to <= from) return [];
    return [Decoration.mark({ class: semanticTokenClass(token) }).range(from, to)];
  });
  return Decoration.set(ranges, true);
}

/** Cursor- and viewport-scoped intelligence chrome. */
export function buildLspOverlayDecorations(
  doc: Text,
  highlights: LspDocumentHighlight[],
  hints: LspInlayHint[],
): DecorationSet {
  const ranges = [];
  for (const highlight of highlights) {
    const { from, to } = rangeOffsets(doc, highlight.range);
    if (to <= from) continue;
    const suffix = highlight.kind === 3 ? "write" : highlight.kind === 2 ? "read" : "text";
    ranges.push(Decoration.mark({ class: `cm-lsp-usage cm-lsp-usage-${suffix}` }).range(from, to));
  }
  for (const hint of hints) {
    const position = offsetFromLspPosition(doc, hint.position);
    ranges.push(Decoration.widget({
      widget: new InlayHintWidget(hint),
      side: 1,
    }).range(position));
  }
  return Decoration.set(ranges, true);
}

export function createLspSemanticTokenChrome(
  doc: Text,
  semanticTokens: LspSemanticToken[] = [],
): Extension[] {
  return [EditorView.decorations.of(buildLspSemanticTokenDecorations(doc, semanticTokens))];
}

export function createLspOverlayChrome(
  doc: Text,
  highlights: LspDocumentHighlight[],
  hints: LspInlayHint[],
): Extension[] {
  return [EditorView.decorations.of(buildLspOverlayDecorations(doc, highlights, hints))];
}

export const LSP_INTELLIGENCE_THEME = EditorView.theme({
  ".cm-lsp-usage-text": { backgroundColor: "color-mix(in srgb, var(--taomni-accent) 10%, transparent)" },
  ".cm-lsp-usage-read": { backgroundColor: "color-mix(in srgb, var(--taomni-code-syntax-number, #38bdf8) 18%, transparent)" },
  ".cm-lsp-usage-write": { backgroundColor: "color-mix(in srgb, var(--taomni-code-syntax-keyword, #f59e0b) 22%, transparent)" },
  ".cm-lsp-inlay-hint": {
    margin: "0 2px",
    borderRadius: "3px",
    padding: "0 3px",
    color: "var(--taomni-code-muted)",
    backgroundColor: "var(--taomni-code-active-line-bg)",
    fontSize: "0.85em",
    fontStyle: "italic",
    userSelect: "none",
  },
  ".cm-lsp-inlay-parameter": { opacity: "0.82" },
  ".cm-lsp-inlay-type": { opacity: "0.68" },
  ".cm-lsp-sem-function, .cm-lsp-sem-method, .cm-lsp-sem-macro": { color: "var(--taomni-code-syntax-function, #7dd3fc)" },
  ".cm-lsp-sem-class, .cm-lsp-sem-struct, .cm-lsp-sem-interface, .cm-lsp-sem-type, .cm-lsp-sem-enum": { color: "var(--taomni-code-syntax-type, #f9a8d4)" },
  ".cm-lsp-sem-variable, .cm-lsp-sem-parameter, .cm-lsp-sem-property": { color: "var(--taomni-code-syntax-variable, #fde68a)" },
  ".cm-lsp-sem-namespace": { color: "var(--taomni-code-syntax-type, #c4b5fd)" },
  ".cm-lsp-sem-keyword, .cm-lsp-sem-modifier": { color: "var(--taomni-code-syntax-keyword, #fda4af)" },
  ".cm-lsp-sem-string": { color: "var(--taomni-code-syntax-string, #86efac)" },
  ".cm-lsp-sem-number": { color: "var(--taomni-code-syntax-number, #fdba74)" },
  ".cm-lsp-sem-comment": { color: "var(--taomni-code-syntax-comment, var(--taomni-code-muted))", fontStyle: "italic" },
  ".cm-lsp-sem-operator, .cm-lsp-sem-regexp": { color: "var(--taomni-code-syntax-operator, #a5b4fc)" },
  ".cm-lsp-sem-mod-deprecated": { textDecoration: "line-through", opacity: "0.75" },
  ".cm-lsp-sem-mod-readonly": { fontStyle: "italic" },
  ".cm-lsp-sem-mod-defaultLibrary": { opacity: "0.9" },
});

export function createLspIntelligenceChrome(
  doc: Text,
  highlights: LspDocumentHighlight[],
  hints: LspInlayHint[],
  semanticTokens: LspSemanticToken[] = [],
): Extension[] {
  return [
    ...createLspSemanticTokenChrome(doc, semanticTokens),
    ...createLspOverlayChrome(doc, highlights, hints),
    LSP_INTELLIGENCE_THEME,
  ];
}

function wordAt(text: string, offset: number): { from: number; to: number; word: string } | null {
  const isWord = (char: string) => /[\p{L}\p{N}_$]/u.test(char);
  if (!text || offset < 0 || offset > text.length) return null;
  let from = Math.min(offset, text.length - 1);
  if (!isWord(text[from] ?? "") && from > 0 && isWord(text[from - 1] ?? "")) from -= 1;
  if (!isWord(text[from] ?? "")) return null;
  let to = from + 1;
  while (from > 0 && isWord(text[from - 1])) from -= 1;
  while (to < text.length && isWord(text[to])) to += 1;
  return { from, to, word: text.slice(from, to) };
}

export function fallbackWordHighlights(text: string, position: LspPosition): LspDocumentHighlight[] {
  const lines = text.split("\n");
  let offset = 0;
  for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
    offset += lines[line].length + 1;
  }
  offset += Math.min(position.character, lines[position.line]?.length ?? 0);
  const token = wordAt(text, offset);
  if (!token || token.word.length < 2) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${token.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_$])`, "gu");
  const positionAt = (value: number): LspPosition => {
    const before = text.slice(0, value);
    const linesBefore = before.split("\n");
    return {
      line: linesBefore.length - 1,
      character: linesBefore.at(-1)?.length ?? 0,
    };
  };
  return [...text.matchAll(pattern)].map((match) => {
    const start = positionAt(match.index);
    const end = positionAt(match.index + token.word.length);
    return { range: { start, end }, kind: null };
  });
}
