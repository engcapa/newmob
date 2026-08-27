import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type StateCommand,
} from "@codemirror/state";
import {
  editorVirtualSpacePolicy,
  paddingForOverflow,
  setVirtualOverflow,
  virtualSpaceOverflowField,
  type VirtualOverflowMap,
} from "./workspaceVirtualSpace";
import {
  copyLineDown,
  deleteLine,
  moveLineDown,
  moveLineUp,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import {
  foldEffect,
  foldService,
  syntaxTree,
} from "@codemirror/language";
import { gotoLine, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { Command, KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { LspRange } from "../../../lib/editor/lsp";
import { offsetFromLspPosition } from "./lspPositions";

export type CommandOutcome = "applied" | "unavailable" | "readOnly" | "noSelection" | "cancelled";

export type ClipboardSourceEol = "lf" | "crlf" | "cr";

export interface EditorClipboardPayload {
  plainText: string;
  segments?: string[];
  sourceEol: ClipboardSourceEol;
  rectangular: boolean;
}

export interface NormalizedEditorSelection {
  ranges: readonly SelectionRange[];
  mainIndex: number;
}

export interface MultiCaretPastePlan {
  changes: readonly ChangeSpec[];
  selection: EditorSelection;
}

export interface EditorVirtualSpacePolicy {
  afterLineEnd: boolean;
  atFileBottom: boolean;
}

// §8.19.5: the facet itself lives beside the virtual-space StateField so the
// field can read it without an import cycle; re-exported here for the
// appearance/profile consumers.
export { editorVirtualSpacePolicy } from "./workspaceVirtualSpace";

export function detectClipboardSourceEol(text: string): ClipboardSourceEol {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "cr";
  return "lf";
}

export function editorClipboardPayload(
  state: EditorState,
  rectangular = false,
): EditorClipboardPayload | null {
  const normalized = normalizeEditorSelections(state.selection.ranges, state.selection.mainIndex);
  const segments = normalized.ranges.map((range) => state.sliceDoc(range.from, range.to));
  if (segments.every((segment) => segment.length === 0)) return null;
  const plainText = segments.join(state.lineBreak);
  return {
    plainText,
    segments,
    sourceEol: detectClipboardSourceEol(plainText),
    rectangular,
  };
}

export function plainTextClipboardPayload(text: string): EditorClipboardPayload {
  return {
    plainText: text,
    sourceEol: detectClipboardSourceEol(text),
    rectangular: false,
  };
}

/**
 * CodeMirror normally keeps selections ordered and non-overlapping. This
 * boundary also accepts synthetic or restored ranges and deterministically
 * merges overlap while retaining the range that owned the primary caret.
 */
export function normalizeEditorSelections(
  ranges: readonly SelectionRange[],
  mainIndex: number,
): NormalizedEditorSelection {
  if (ranges.length === 0) {
    return { ranges: [EditorSelection.cursor(0)], mainIndex: 0 };
  }
  const primary = ranges[Math.min(Math.max(mainIndex, 0), ranges.length - 1)];
  const ordered = ranges
    .map((range, index) => ({ range, index }))
    .sort((a, b) => (
      a.range.from - b.range.from
      || a.range.to - b.range.to
      || a.index - b.index
    ));
  const merged: Array<{ range: SelectionRange; ownsPrimary: boolean }> = [];
  for (const item of ordered) {
    const ownsPrimary = item.range === primary || item.index === mainIndex;
    const previous = merged[merged.length - 1];
    if (previous && item.range.from < previous.range.to) {
      const from = Math.min(previous.range.from, item.range.from);
      const to = Math.max(previous.range.to, item.range.to);
      const nextOwnsPrimary = previous.ownsPrimary || ownsPrimary;
      const anchor = nextOwnsPrimary && primary.anchor > primary.head ? to : from;
      const head = anchor === from ? to : from;
      previous.range = EditorSelection.range(anchor, head);
      previous.ownsPrimary = nextOwnsPrimary;
      continue;
    }
    merged.push({ range: item.range, ownsPrimary });
  }
  const normalizedMainIndex = Math.max(0, merged.findIndex((item) => item.ownsPrimary));
  return {
    ranges: merged.map((item) => item.range),
    mainIndex: normalizedMainIndex,
  };
}

function normalizeClipboardEol(text: string, lineBreak: string): string {
  return text.replace(/\r\n?|\n/g, lineBreak);
}

export function buildMultiCaretPastePlan(
  state: EditorState,
  payload: EditorClipboardPayload,
): MultiCaretPastePlan | null {
  if (state.readOnly) return null;
  const normalized = normalizeEditorSelections(state.selection.ranges, state.selection.mainIndex);
  const distributed = payload.segments?.length === normalized.ranges.length
    ? payload.segments
    : normalized.ranges.map(() => payload.plainText);
  const inserts = distributed.map((text) => normalizeClipboardEol(text, state.lineBreak));
  const changes = normalized.ranges.map((range, index) => ({
    from: range.from,
    to: range.to,
    insert: inserts[index] ?? "",
  }));
  const changeSet = state.changes(changes);
  const mappedRanges = normalized.ranges.map((range, index) => {
    const start = changeSet.mapPos(range.from, -1);
    return EditorSelection.cursor(start + (inserts[index]?.length ?? 0));
  });
  return {
    changes,
    selection: EditorSelection.create(mappedRanges, normalized.mainIndex),
  };
}

export function pasteEditorClipboardPayload(
  view: EditorView,
  payload: EditorClipboardPayload,
): boolean {
  if (view.composing) return false;
  const plan = buildMultiCaretPastePlan(view.state, payload);
  if (!plan) return false;
  // §8.19.5: carets parked in the virtual region get their padding spaces
  // manufactured in the SAME dispatch (multi-caret padding+text is one
  // transaction), and the overflow map collapses because the doc changed.
  let overflow: VirtualOverflowMap | null = null;
  if (view.state.field(virtualSpaceOverflowField, false)?.size) {
    overflow = new Map(view.state.field(virtualSpaceOverflowField)!);
  }
  let changes: readonly ChangeSpec[] = plan.changes;
  if (overflow && overflow.size > 0) {
    const padded = [...plan.changes];
    view.state.selection.ranges.forEach((range, index) => {
      const pad = paddingForOverflow(overflow!.get(range.from) ?? overflow!.get(range.head) ?? 0);
      if (pad) {
        const entry = padded[index] as { from: number; to: number; insert?: string };
        padded[index] = { ...entry, insert: `${pad}${entry.insert ?? ""}` };
      }
    });
    changes = padded;
  }
  view.dispatch({
    changes,
    selection: plan.selection,
    ...(overflow && overflow.size > 0
      ? { effects: setVirtualOverflow.of(new Map()) }
      : {}),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

export function cutEditorSelections(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const normalized = normalizeEditorSelections(
    view.state.selection.ranges,
    view.state.selection.mainIndex,
  );
  if (normalized.ranges.every((range) => range.empty)) return false;
  const changes = normalized.ranges
    .filter((range) => !range.empty)
    .map((range) => ({ from: range.from, to: range.to, insert: "" }));
  const changeSet = view.state.changes(changes);
  const ranges = normalized.ranges.map((range) => (
    EditorSelection.cursor(changeSet.mapPos(range.from, -1))
  ));
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges, normalized.mainIndex),
    userEvent: "delete.cut",
    scrollIntoView: true,
  });
  return true;
}

export function cloneCaretVertically(direction: -1 | 1): Command {
  return (view) => {
    if (view.composing || view.state.readOnly) return false;
    const state = view.state;
    const virtualSpace = state.facet(editorVirtualSpacePolicy);
    const normalized = normalizeEditorSelections(state.selection.ranges, state.selection.mainIndex);
    const additions: Array<{
      source: SelectionRange;
      targetLineNumber: number;
      targetColumn: number;
      padding: number;
    }> = [];
    for (const range of normalized.ranges) {
      const line = state.doc.lineAt(range.head);
      const desiredColumn = range.head - line.from;
      const targetLineNumber = line.number + direction;
      if (targetLineNumber < 1) continue;
      if (targetLineNumber > state.doc.lines) {
        if (!virtualSpace.atFileBottom || direction < 0) continue;
        additions.push({
          source: range,
          targetLineNumber,
          targetColumn: virtualSpace.afterLineEnd ? desiredColumn : 0,
          padding: virtualSpace.afterLineEnd ? desiredColumn : 0,
        });
        continue;
      }
      const target = state.doc.line(targetLineNumber);
      additions.push({
        source: range,
        targetLineNumber,
        targetColumn: virtualSpace.afterLineEnd
          ? desiredColumn
          : Math.min(desiredColumn, target.length),
        padding: virtualSpace.afterLineEnd
          ? Math.max(0, desiredColumn - target.length)
          : 0,
      });
    }
    if (additions.length === 0) return false;

    const paddingByLine = new Map<number, number>();
    for (const addition of additions) {
      if (addition.targetLineNumber > state.doc.lines) {
        paddingByLine.set(
          addition.targetLineNumber,
          Math.max(paddingByLine.get(addition.targetLineNumber) ?? 0, addition.padding),
        );
        continue;
      }
      if (addition.padding <= 0) continue;
      paddingByLine.set(
        addition.targetLineNumber,
        Math.max(paddingByLine.get(addition.targetLineNumber) ?? 0, addition.padding),
      );
    }
    const changes: ChangeSpec[] = [];
    for (const [lineNumber, padding] of paddingByLine) {
      if (lineNumber > state.doc.lines) {
        changes.push({ from: state.doc.length, insert: `${state.lineBreak}${" ".repeat(padding)}` });
      } else {
        changes.push({ from: state.doc.line(lineNumber).to, insert: " ".repeat(padding) });
      }
    }
    const changeSet = state.changes(changes);
    const originalRanges = normalized.ranges.map((range) => range.map(changeSet));
    const clonedRanges = additions.map((addition) => {
      if (addition.targetLineNumber > state.doc.lines) {
        const start = changeSet.mapPos(state.doc.length, 1) - addition.padding;
        return EditorSelection.cursor(start + addition.targetColumn);
      }
      const target = state.doc.line(addition.targetLineNumber);
      const mappedStart = changeSet.mapPos(target.from, 1);
      return EditorSelection.cursor(mappedStart + addition.targetColumn);
    });
    const merged = normalizeEditorSelections(
      [...originalRanges, ...clonedRanges],
      normalized.mainIndex,
    );
    view.dispatch({
      changes,
      selection: EditorSelection.create(merged.ranges, merged.mainIndex),
      scrollIntoView: true,
      userEvent: "select.cloneCaret",
    });
    return true;
  };
}

export const cloneCaretAbove = cloneCaretVertically(-1);
export const cloneCaretBelow = cloneCaretVertically(1);

export const foldSelection: Command = (view) => {
  const normalized = normalizeEditorSelections(
    view.state.selection.ranges,
    view.state.selection.mainIndex,
  );
  const effects = normalized.ranges
    .filter((range) => !range.empty && range.from < range.to)
    .map((range) => foldEffect.of({ from: range.from, to: range.to }));
  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

/**
 * Region marker grammar per language (§8.17.6 step 3). Markers are only
 * recognized behind the language's OWN comment token — a `#region` inside a
 * Python string or a `// region` in CSS never folds. Unknown languages yield
 * no region folding at all instead of scanning arbitrary text.
 */
interface RegionCommentGrammar {
  /** Regex source matching the comment opener (without trailing space). */
  lineToken: RegExp;
  /** Block-comment opener when the language folds regions inside blocks. */
  block?: { open: RegExp; close: RegExp };
}

const REGION_LINE_TOKENS: Record<string, RegExp> = {
  "//": /\/\//,
  "#": /#/,
  "--": /--/,
  "%": /%/,
  ";": /;/,
};

function regionGrammarForPath(path: string | null | undefined): RegionCommentGrammar | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const byLine = (token: RegExp): RegionCommentGrammar => ({ lineToken: token });
  switch (ext) {
    case "java":
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
    case "c":
    case "h":
    case "cpp":
    case "hpp":
    case "cc":
    case "cs":
    case "go":
    case "rs":
    case "swift":
    case "kt":
    case "kts":
    case "scala":
    case "php":
      return { lineToken: REGION_LINE_TOKENS["//"], block: { open: /\/\*/, close: /\*\// } };
    case "py":
    case "pyw":
    case "rb":
    case "sh":
    case "bash":
    case "zsh":
    case "yml":
    case "yaml":
    case "toml":
      return byLine(REGION_LINE_TOKENS["#"]);
    case "sql":
    case "lua":
    case "hs":
      return byLine(REGION_LINE_TOKENS["--"]);
    case "erl":
    case "hrl":
    case "tex":
      return byLine(REGION_LINE_TOKENS["%"]);
    case "clj":
    case "cljs":
    case "edn":
    case "ini":
    case "properties":
      return byLine(REGION_LINE_TOKENS[";"]);
    default:
      // XML/HTML family folds regions inside <!-- --> blocks; every other
      // language is region-fold unavailable.
      if (["xml", "html", "htm", "xhtml", "svg", "vue", "md", "markdown"].includes(ext)) {
        return { lineToken: /<!--/, block: { open: /<!--/, close: /-->/ } };
      }
      return null;
  }
}

function buildRegionMatchers(grammar: RegionCommentGrammar): { start: RegExp; end: RegExp } {
  const tokenSource = `(?:${grammar.lineToken.source}${grammar.block ? `|${grammar.block.open.source}` : ""})`;
  return {
    start: new RegExp(`^\\s*${tokenSource}\\s*#?region(?:\\s|$)`, "i"),
    end: new RegExp(`^\\s*${tokenSource}\\s*#?endregion(?:\\s|$)`, "i"),
  };
}

/**
 * True when the node name identifies a comment node (case-insensitive).
 * Exported for tests of the syntax-gated region folding decision.
 */
export function isCommentSyntaxNodeName(name: string): boolean {
  return /comment/i.test(name);
}

/**
 * Syntax gate for one candidate region marker (§8.18.4): returns
 * - `"reject"` when the parser proves the marker sits inside a string /
 *   template / other non-comment node,
 * - `"comment"` when it is provably inside a comment node,
 * - `"heuristic"` when no parser information exists (unknown language or
 *   parser not ready) — the extension-token table then decides, documented as
 *   text-marker HEURISTIC folding that does not count as semantic folding.
 */
export function classifyRegionMarker(
  node: { name: string } | null,
): "reject" | "comment" | "heuristic" {
  if (!node || node.name === "") return "heuristic";
  return isCommentSyntaxNodeName(node.name) ? "comment" : "reject";
}

export type RegionFoldingProvenance =
  | "explicit-comment"
  | "language-syntax"
  | "indent-fallback";

export function regionFoldingProvenance(
  node: { name: string } | null,
  context?: { isCommentMarker?: boolean; isIndent?: boolean },
): RegionFoldingProvenance {
  if (context?.isIndent) return "indent-fallback";
  if (context?.isCommentMarker || (node && node.name !== "" && isCommentSyntaxNodeName(node.name))) {
    return "explicit-comment";
  }
  if (node && node.name !== "") {
    return "language-syntax";
  }
  return "indent-fallback";
}

export function regionFoldingProvenanceLabel(provenance: RegionFoldingProvenance): string {
  switch (provenance) {
    case "explicit-comment":
      return "explicit-comment";
    case "language-syntax":
      return "language-syntax";
    case "indent-fallback":
      return "indent-fallback";
  }
}

/**
 * §8.21.3 V2-C: Detects region fold provenance for a given line:
 * - "explicit-comment": matches region comment marker and passes comment syntax check.
 * - "language-syntax": non-comment syntax tree node spanning beyond the line.
 * - "indent-fallback": indented block without parser grammar.
 */
export function detectLineFoldProvenance(
  state: EditorState,
  lineNumber: number,
  path?: string | null,
): RegionFoldingProvenance | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
  const line = state.doc.line(lineNumber);
  const grammar = regionGrammarForPath(path ?? null);
  if (grammar) {
    const matchers = buildRegionMatchers(grammar);
    if (matchers.start.test(line.text)) {
      const startMatch = line.text.match(matchers.start);
      const markerOffset = startMatch?.index ?? line.text.search(/\S/);
      const node = syntaxTree(state).resolveInner(line.from + Math.max(markerOffset, 0), -1);
      const verdict = classifyRegionMarker(node ?? null);
      if (verdict !== "reject") {
        return "explicit-comment";
      }
    }
  }

  // Syntax AST check
  const tree = syntaxTree(state);
  const nonWs = line.text.search(/\S/);
  if (nonWs >= 0) {
    const node = tree.resolveInner(line.from + nonWs, 1);
    if (node && node.name !== "" && !isCommentSyntaxNodeName(node.name) && node.to > line.to) {
      return "language-syntax";
    }
  }

  // Indent check
  if (lineNumber < state.doc.lines && line.text.trim().length > 0) {
    const currentIndent = line.text.match(/^\s*/)?.[0].length ?? 0;
    const nextLine = state.doc.line(lineNumber + 1);
    const nextIndent = nextLine.text.match(/^\s*/)?.[0].length ?? 0;
    if (nextIndent > currentIndent) {
      return "indent-fallback";
    }
  }

  return null;
}

/**
 * Language-aware region fold service factory (§8.17.6 step 3, gated §8.18.4).
 * The resolver runs per query so the service follows the host's current file
 * without rebuilding extensions. Unknown/unmapped languages produce no folds
 * instead of scanning arbitrary text. When a Lezer syntax tree IS available,
 * a marker must live inside a comment node — markers inside strings/templates
 * are rejected even when the token table would match them.
 */
export function createRegionFoldService(
  resolvePath: () => string | null | undefined,
): ReturnType<typeof foldService.of> {
  return foldService.of((state, lineStart, lineEnd) => {
    const grammar = regionGrammarForPath(resolvePath() ?? null);
    if (!grammar) return null;
    const matchers = buildRegionMatchers(grammar);
    const line = state.doc.lineAt(lineStart);
    const startMatch = line.text.match(matchers.start);
    if (!startMatch) return null;

    // Syntax gate: verify the matched marker position against the parse tree.
    const markerOffset = startMatch.index ?? line.text.search(/\S/);
    const node = syntaxTree(state).resolveInner(line.from + Math.max(markerOffset, 0), -1);
    const verdict = classifyRegionMarker(node ?? null);
    if (verdict === "reject") return null;

    // The end marker must pass the same gate when the parser can see it.
    let depth = 1;
    for (let number = line.number + 1; number <= state.doc.lines; number++) {
      const candidate = state.doc.line(number);
      if (matchers.start.test(candidate.text)) {
        const candidateStart = candidate.text.match(matchers.start);
        const candidateNode = syntaxTree(state).resolveInner(
          candidate.from + Math.max(candidateStart?.index ?? 0, 0),
          -1,
        );
        if (classifyRegionMarker(candidateNode ?? null) !== "reject") depth += 1;
      }
      if (!matchers.end.test(candidate.text)) continue;
      const endMatch = candidate.text.match(matchers.end);
      const endNode = syntaxTree(state).resolveInner(candidate.from + Math.max(endMatch?.index ?? 0, 0), -1);
      if (classifyRegionMarker(endNode ?? null) === "reject") continue;
      depth -= 1;
      if (depth === 0) {
        return {
          from: lineEnd,
          to: candidate.from,
        };
      }
    }
    return null;
  });
}

/** Grammar-table fixture for tests/diagnostics. */
export function regionFoldAvailableForPath(path: string): boolean {
  return regionGrammarForPath(path) !== null;
}

function statementNodeAt(state: EditorState, position: number) {
  let node = syntaxTree(state).resolveInner(position, -1);
  while (node.parent) {
    const name = node.name.toLowerCase();
    if (
      name.includes("statement")
      || name.includes("declaration")
      || name === "property"
      || name === "variabledefinition"
    ) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

export function moveStatement(direction: -1 | 1): Command {
  return (view) => {
    if (view.composing || view.state.readOnly) return false;
    const state = view.state;
    const main = state.selection.main;
    const node = statementNodeAt(state, main.head);
    if (!node) return direction < 0 ? moveLineUp(view) : moveLineDown(view);
    const sibling = direction < 0 ? node.prevSibling : node.nextSibling;
    if (!sibling || sibling.parent !== node.parent) {
      return direction < 0 ? moveLineUp(view) : moveLineDown(view);
    }
    const first = direction < 0 ? sibling : node;
    const second = direction < 0 ? node : sibling;
    const firstText = state.sliceDoc(first.from, first.to);
    const between = state.sliceDoc(first.to, second.from);
    const secondText = state.sliceDoc(second.from, second.to);
    const insert = `${secondText}${between}${firstText}`;
    const selectionOffset = direction < 0
      ? sibling.from - node.from
      : sibling.to - node.to;
    view.dispatch({
      changes: { from: first.from, to: second.to, insert },
      selection: EditorSelection.range(
        main.anchor + selectionOffset,
        main.head + selectionOffset,
      ),
      userEvent: "move.statement",
      scrollIntoView: true,
    });
    return true;
  };
}

export const moveStatementUp = moveStatement(-1);
export const moveStatementDown = moveStatement(1);

const setSelectionHistory = StateEffect.define<EditorSelection[]>();
const setOccurrenceSession = StateEffect.define<boolean>();

export const occurrenceSessionField = StateField.define<boolean>({
  create: () => false,
  update(active, transaction) {
    const controlled = transaction.effects.find((effect) => effect.is(setOccurrenceSession));
    if (controlled?.is(setOccurrenceSession)) return controlled.value;
    if (active && (transaction.docChanged || transaction.selection)) return false;
    return active;
  },
});

export const selectNextEditorOccurrence: Command = (view) => {
  const before = view.state.selection;
  if (!selectNextOccurrence(view) || view.state.selection.eq(before)) return false;
  view.dispatch({ effects: setOccurrenceSession.of(true) });
  return true;
};

export const selectAllEditorOccurrences: Command = (view) => {
  const before = view.state.selection;
  if (!selectSelectionMatches(view) || view.state.selection.eq(before)) return false;
  view.dispatch({ effects: setOccurrenceSession.of(true) });
  return true;
};

export const escapeEditorSelections: Command = (view) => {
  if (view.state.field(occurrenceSessionField, false)) {
    view.dispatch({ effects: setOccurrenceSession.of(false) });
    return true;
  }
  if (view.state.selection.ranges.length <= 1) return false;
  view.dispatch({
    selection: EditorSelection.create([view.state.selection.main]),
    scrollIntoView: true,
    userEvent: "select.collapse",
  });
  return true;
};

export const selectionHistoryField = StateField.define<EditorSelection[]>({
  create: () => [],
  update(history, transaction) {
    const controlled = transaction.effects.find((effect) => effect.is(setSelectionHistory));
    if (controlled?.is(setSelectionHistory)) return controlled.value;
    if (transaction.docChanged || transaction.selection) return [];
    return history;
  },
});

function expandedSelection(state: EditorState): EditorSelection | null {
  let changed = false;
  const ranges = state.selection.ranges.map((range) => {
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(range.head, -1);
    while (node) {
      const contains = node.from <= range.from && node.to >= range.to;
      const expands = node.from < range.from || node.to > range.to;
      if (contains && expands) {
        changed = true;
        return EditorSelection.range(node.from, node.to);
      }
      node = node.parent;
    }
    return range;
  });
  return changed ? EditorSelection.create(ranges, state.selection.mainIndex) : null;
}

export const expandSyntaxSelection: Command = (view) => {
  const selection = expandedSelection(view.state);
  if (!selection) return false;
  const history = view.state.field(selectionHistoryField);
  view.dispatch({
    selection,
    effects: setSelectionHistory.of([...history, view.state.selection]),
    scrollIntoView: true,
  });
  return true;
};

export function expandSelectionFromLspRanges(view: EditorView, ranges: LspRange[]): boolean {
  const current = view.state.selection.main;
  for (const range of ranges) {
    const from = offsetFromLspPosition(view.state.doc, range.start);
    const to = offsetFromLspPosition(view.state.doc, range.end);
    if (from > current.from || to < current.to) continue;
    if (from === current.from && to === current.to) continue;
    const history = view.state.field(selectionHistoryField);
    view.dispatch({
      selection: EditorSelection.range(from, to),
      effects: setSelectionHistory.of([...history, view.state.selection]),
      scrollIntoView: true,
    });
    return true;
  }
  return false;
}

export const shrinkSyntaxSelection: Command = (view) => {
  const history = view.state.field(selectionHistoryField);
  const previous = history[history.length - 1];
  if (!previous) return false;
  view.dispatch({
    selection: previous,
    effects: setSelectionHistory.of(history.slice(0, -1)),
    scrollIntoView: true,
  });
  return true;
};

export const unselectOccurrence: Command = (view) => {
  const ranges = view.state.selection.ranges;
  if (ranges.length <= 1) return false;
  const newRanges = ranges.slice(0, ranges.length - 1);
  const newMainIndex = Math.min(view.state.selection.mainIndex, newRanges.length - 1);
  view.dispatch({
    selection: EditorSelection.create(newRanges, newMainIndex),
    effects: setOccurrenceSession.of(true),
    scrollIntoView: true,
  });
  return true;
};

export const completeCurrentStatement: Command = (view) => {
  const state = view.state;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const lineText = line.text;
  const trimmed = lineText.trimEnd();
  const indent = lineText.match(/^\s*/)?.[0] ?? "";
  const trimmedContent = trimmed.trim();

  if (!trimmedContent || trimmedContent.startsWith("//") || trimmedContent.startsWith("#") || trimmedContent.startsWith("/*")) {
    const insertPos = line.to;
    const nextLineText = `\n${indent}`;
    view.dispatch({
      changes: { from: insertPos, insert: nextLineText },
      selection: { anchor: insertPos + nextLineText.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Control flow headers with parens without braces: if (...), for (...), while (...), switch (...), catch (...)
  const controlHeaderMatch = trimmed.match(/^(.*\b(?:if|for|while|switch|catch)\s*\(.*\))\s*$/);
  if (controlHeaderMatch && !trimmed.endsWith("{")) {
    const insertText = ` {\n${indent}  \n${indent}}`;
    const changeFrom = line.from + trimmed.length;
    const cursorTarget = line.from + trimmed.length + 3 + indent.length + 2;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: cursorTarget },
      scrollIntoView: true,
    });
    return true;
  }

  // Control flow keywords without braces: else, try, finally, do
  const controlKeywordMatch = trimmed.match(/^(.*\b(?:else|try|finally|do))\s*$/);
  if (controlKeywordMatch && !trimmed.endsWith("{")) {
    const insertText = ` {\n${indent}  \n${indent}}`;
    const changeFrom = line.from + trimmed.length;
    const cursorTarget = line.from + trimmed.length + 3 + indent.length + 2;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: cursorTarget },
      scrollIntoView: true,
    });
    return true;
  }

  // Line ends with '{' or ':' -> open block with indent
  if (trimmed.endsWith("{") || trimmed.endsWith(":")) {
    const insertText = `\n${indent}  `;
    const changeFrom = line.from + trimmed.length;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: changeFrom + insertText.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Line already ends with ';' -> newline below with same indent
  if (trimmed.endsWith(";")) {
    const insertText = `\n${indent}`;
    const changeFrom = line.from + trimmed.length;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: changeFrom + insertText.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Standard statement needing ';' and newline (balance unclosed parens/brackets if any)
  let openParens = 0;
  let openBrackets = 0;
  let inString: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (inString) {
      if (char === inString && trimmed[i - 1] !== "\\") inString = null;
    } else if (char === '"' || char === "'" || char === "`") {
      inString = char;
    } else if (char === "(") {
      openParens++;
    } else if (char === ")") {
      if (openParens > 0) openParens--;
    } else if (char === "[") {
      openBrackets++;
    } else if (char === "]") {
      if (openBrackets > 0) openBrackets--;
    }
  }

  let closing = "";
  while (openParens > 0) { closing += ")"; openParens--; }
  while (openBrackets > 0) { closing += "]"; openBrackets--; }
  const append = `${closing};\n${indent}`;
  const changeFrom = line.from + trimmed.length;
  view.dispatch({
    changes: { from: changeFrom, to: line.to, insert: append },
    selection: { anchor: changeFrom + append.length },
    scrollIntoView: true,
  });
  return true;
};

export const toggleCase: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const changes = [];
  const ranges = [];

  for (const range of state.selection.ranges) {
    let from = range.from;
    let to = range.to;

    if (from === to) {
      const word = state.wordAt(from);
      if (!word) continue;
      from = word.from;
      to = word.to;
    }

    const text = state.sliceDoc(from, to);
    if (!text) continue;
    const isAllUpper = text === text.toUpperCase() && text !== text.toLowerCase();
    const replacement = isAllUpper ? text.toLowerCase() : text.toUpperCase();

    changes.push({ from, to, insert: replacement });
    ranges.push(EditorSelection.range(from, from + replacement.length));
  }

  if (changes.length === 0) return false;

  dispatch(
    state.update({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      userEvent: "input.toggleCase",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Join selected lines or current line with the next line (IDEA Ctrl+Shift+J),
 * collapsing intervening whitespace. Multi-range aware.
 */
export const joinLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;

  const changes: ChangeSpec[] = [];
  const processedLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);

    const fromLineNum = startLine.number;
    const toLineNum = range.empty ? fromLineNum : endLine.number;

    for (let l = fromLineNum; l <= toLineNum; l++) {
      if (l >= state.doc.lines) break;
      if (processedLines.has(l)) continue;
      processedLines.add(l);

      const line = state.doc.line(l);
      const nextLine = state.doc.line(l + 1);
      const nextTrimmedStart = nextLine.from + (nextLine.text.match(/^\s*/)?.[0].length ?? 0);
      const deleteFrom = line.to;
      const deleteTo = nextTrimmedStart;

      const needsSpace = line.length > 0 && !/\s$/.test(line.text) && nextLine.length > 0;
      const insert = needsSpace ? " " : "";

      changes.push({ from: deleteFrom, to: deleteTo, insert });
    }
  }

  if (changes.length === 0) return false;

  dispatch(
    state.update({
      changes,
      userEvent: "delete.joinLines",
      scrollIntoView: true,
    }),
  );
  return true;
};

export interface SortLinesOptions {
  descending?: boolean;
  caseSensitive?: boolean;
  natural?: boolean;
}

/**
 * Sort lines in selection alphabetically. Multi-range aware.
 */
export function sortLinesWithOptions(options: SortLinesOptions = {}): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;

    const changes: ChangeSpec[] = [];

    for (const range of state.selection.ranges) {
      if (range.empty) continue;
      const startLine = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      if (startLine.number === endLine.number) continue;

      const lines: string[] = [];
      for (let i = startLine.number; i <= endLine.number; i++) {
        lines.push(state.doc.line(i).text);
      }

      const sorted = [...lines].sort((a, b) => {
        let cmp = 0;
        if (options.natural) {
          cmp = a.localeCompare(b, undefined, { numeric: true, sensitivity: options.caseSensitive ? "variant" : "base" });
        } else if (options.caseSensitive) {
          cmp = a < b ? -1 : a > b ? 1 : 0;
        } else {
          cmp = a.localeCompare(b, undefined, { sensitivity: "base" });
        }
        return options.descending ? -cmp : cmp;
      });

      const newText = sorted.join("\n");
      changes.push({ from: startLine.from, to: endLine.to, insert: newText });
    }

    if (changes.length === 0) return false;

    dispatch(
      state.update({
        changes,
        userEvent: "edit.sortLines",
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const sortLines: StateCommand = sortLinesWithOptions({});

/**
 * Reverse lines in selection. Multi-range aware.
 */
export const reverseLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;

  const changes: ChangeSpec[] = [];

  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    if (startLine.number === endLine.number) continue;

    const lines: string[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
      lines.push(state.doc.line(i).text);
    }

    const reversed = [...lines].reverse();
    const newText = reversed.join("\n");
    changes.push({ from: startLine.from, to: endLine.to, insert: newText });
  }

  if (changes.length === 0) return false;

  dispatch(
    state.update({
      changes,
      userEvent: "edit.reverseLines",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Transpose current line with next line, or transpose characters at cursor (IDEA Transpose).
 */
export const transposeLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);

  if (line.number < state.doc.lines) {
    // Transpose lines
    const nextLine = state.doc.line(line.number + 1);
    const text1 = line.text;
    const text2 = nextLine.text;
    const newText = `${text2}\n${text1}`;

    dispatch(
      state.update({
        changes: { from: line.from, to: nextLine.to, insert: newText },
        selection: { anchor: line.from + text2.length + 1 + (main.head - line.from) },
        userEvent: "edit.transpose",
        scrollIntoView: true,
      }),
    );
    return true;
  }
  return false;
};

/**
 * Tab Jump-Out: when cursor is right before a closing bracket/quote, Tab jumps past it.
 */
export const tabJumpOut: StateCommand = ({ state, dispatch }) => {
  const main = state.selection.main;
  if (!main.empty) return false;
  const pos = main.head;
  if (pos >= state.doc.length) return false;

  const nextChar = state.sliceDoc(pos, pos + 1);
  if ([")", "]", "}", '"', "'", "`", ";", ">"].includes(nextChar)) {
    dispatch(
      state.update({
        selection: { anchor: pos + 1 },
        scrollIntoView: true,
      }),
    );
    return true;
  }
  return false;
};

/**
 * Unwrap / Remove enclosing syntax constructs (parentheses, braces, brackets, quotes).
 */
export const unwrapRemove: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const main = state.selection.main;
  const pos = main.head;

  // Search around cursor for enclosing quotes or brackets
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  const col = pos - line.from;

  // Check quotes or parens surrounding cursor
  for (const [openChar, closeChar] of [["(", ")"], ["[", "]"], ["{", "}"], ['"', '"'], ["'", "'"], ["`", "`"]]) {
    const lastOpen = lineText.lastIndexOf(openChar, col - 1);
    const nextClose = lineText.indexOf(closeChar, col);

    if (lastOpen !== -1 && nextClose !== -1 && lastOpen < nextClose) {
      const openPos = line.from + lastOpen;
      const closePos = line.from + nextClose;

      dispatch(
        state.update({
          changes: [
            { from: openPos, to: openPos + 1, insert: "" },
            { from: closePos, to: closePos + 1, insert: "" },
          ],
          userEvent: "delete.unwrap",
          scrollIntoView: true,
        }),
      );
      return true;
    }
  }

  return false;
};

export const workspaceEditorKeymap: readonly KeyBinding[] = [
  { key: "Mod-/", run: toggleComment },
  { key: "Mod-Shift-/", run: toggleBlockComment },
  { key: "Mod-d", run: copyLineDown },
  { key: "Mod-y", run: deleteLine },
  { key: "Shift-Alt-ArrowUp", run: moveLineUp },
  { key: "Shift-Alt-ArrowDown", run: moveLineDown },
  { key: "Mod-w", run: expandSyntaxSelection },
  { key: "Mod-Shift-w", run: shrinkSyntaxSelection },
  { key: "Mod-g", run: gotoLine },
  { key: "Mod-Shift-Enter", run: completeCurrentStatement },
  { key: "Mod-Shift-j", run: joinLines },
  { key: "Ctrl-Shift-j", run: joinLines },
  { key: "Shift-Alt-j", run: unselectOccurrence },
  { key: "Mod-Shift-u", run: toggleCase },
  { key: "Ctrl-Shift-u", run: toggleCase },
  { key: "Tab", run: tabJumpOut },
];
