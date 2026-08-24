import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import type { LspPosition, LspRange } from "../../../lib/editor/lsp";
import type { SemanticSyntaxFacts } from "./workspaceSemanticEditing";

/**
 * Monotonic generation counter for one editor view's document state (§8.19.8
 * `treeRevision`). Every document change bumps it, so a plan's evidence names
 * the exact generation its parse facts were observed against. Must be
 * registered on the view for `observeSyntaxFacts` to report real values.
 */
export const treeRevisionField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    return tr.docChanged ? value + 1 : value;
  },
});

export function lspPositionFromOffset(state: EditorState, offset: number): LspPosition {
  const line = state.doc.lineAt(Math.max(0, Math.min(offset, state.doc.length)));
  return { line: line.number - 1, character: offset - line.from };
}

export function lspRangeFromOffsets(state: EditorState, from: number, to: number): LspRange {
  return {
    start: lspPositionFromOffset(state, Math.min(from, to)),
    end: lspPositionFromOffset(state, Math.max(from, to)),
  };
}

/**
 * Smallest tree node whose range EXACTLY equals [from, to]. Boundary sides
 * matter: at the start edge `side=1` descends into nodes BEGINNING there,
 * while `side=-1` would stay on the whitespace-owning ancestor; mirrored at
 * the end edge.
 */
function exactAlignedNode(
  tree: ReturnType<typeof syntaxTree>,
  from: number,
  to: number,
): { name: string; from: number; to: number; node: SyntaxNodeTypeRef } | null {
  let best: { name: string; from: number; to: number; node: SyntaxNodeTypeRef } | null = null;
  for (const anchor of [tree.resolveInner(from, 1), tree.resolveInner(to, -1)]) {
    let node: SyntaxNodeTypeRef | null = anchor;
    while (node) {
      if (!best && node.from === from && node.to === to) {
        best = { name: node.name, from: node.from, to: node.to, node };
      }
      if (node.from < from || node.to > to) break;
      node = node.parent;
    }
  }
  return best;
}

/** Bounded subtree scan for Lezer error nodes (`type.isError`). */
function subtreeHasError(root: SyntaxNodeTypeRef | null): boolean {
  if (!root) return false;
  const budget = 512;
  const stack: SyntaxNodeTypeRef[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < budget) {
    const node = stack.pop();
    visited += 1;
    if (!node) continue;
    if (node.type.isError) return true;
    let child = node.firstChild;
    while (child) {
      stack.push(child);
      child = child.nextSibling;
    }
  }
  return false;
}
type SyntaxNodeTypeRef = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/**
 * Shrink [from, to] past surrounding whitespace so the observed range can
 * align to real statement/expression nodes — Lezer nodes exclude leading
 * indentation and trailing newlines, while editor surround selections are
 * usually expanded to whole lines.
 */
function trimmedBounds(state: EditorState, from: number, to: number): { from: number; to: number } {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(state.doc.sliceString(start, start + 1))) start += 1;
  while (end > start && /\s/.test(state.doc.sliceString(end - 1, end))) end -= 1;
  return { from: start, to: end };
}

/**
 * Observe §8.19.8 syntax facts around an edited range from the live Lezer
 * tree. Returns null when the tree is not parsed up to the range end yet —
 * callers must treat that as "no node evidence" and keep local provenance.
 * Never forces a synchronous reparse (see `isInsideStringOrComment`).
 */
export function observeSyntaxFacts(
  state: EditorState,
  rawFrom: number,
  rawTo: number,
): SemanticSyntaxFacts | null {
  if (rawTo <= rawFrom) return null;
  try {
    if (!syntaxTreeAvailable(state, rawTo)) return null;
    // Node boundaries ignore surrounding whitespace, so alignment is checked
    // against the trimmed content inside the edited range.
    const { from, to } = trimmedBounds(state, rawFrom, rawTo);
    if (to <= from) return null;
    const tree = syntaxTree(state);
    const aligned = exactAlignedNode(tree, from, to);
    // Scope for error detection: the aligned node when present, otherwise the
    // smallest ancestor spanning the whole edited range.
    let scope: SyntaxNodeTypeRef = aligned
      ? aligned.node
      : tree.resolveInner(from, 1);
    while (scope.parent && (scope.from > from || scope.to < to)) scope = scope.parent;
    return {
      alignedNodeType: aligned?.name ?? null,
      treeRevision: state.field(treeRevisionField, false) ?? 0,
      selectionNodeRange: aligned ? lspRangeFromOffsets(state, aligned.from, aligned.to) : null,
      parseErrorsInScope: subtreeHasError(scope),
    };
  } catch {
    return null;
  }
}
