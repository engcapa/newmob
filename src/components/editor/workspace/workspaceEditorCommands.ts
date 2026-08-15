import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
} from "@codemirror/state";
import {
  copyLineDown,
  deleteLine,
  moveLineDown,
  moveLineUp,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { gotoLine, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { Command, KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { LspRange } from "../../../lib/editor/lsp";
import { offsetFromLspPosition } from "./lspPositions";

const setSelectionHistory = StateEffect.define<EditorSelection[]>();

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
  { key: "Alt-j", run: selectNextOccurrence },
  { key: "Shift-Alt-j", run: unselectOccurrence },
  { key: "Mod-Alt-Shift-j", run: selectSelectionMatches },
  { key: "Ctrl-Alt-Shift-j", run: selectSelectionMatches },
  { key: "Mod-Shift-u", run: toggleCase },
  { key: "Ctrl-Shift-u", run: toggleCase },
];
