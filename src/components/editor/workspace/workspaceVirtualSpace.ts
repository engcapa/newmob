import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Facet } from "@codemirror/state";

/**
 * §8.19.5 policy gates (canonical definition; re-exported by
 * workspaceEditorCommands for its existing consumers).
 */
export interface EditorVirtualSpacePolicy {
  afterLineEnd: boolean;
  atFileBottom: boolean;
}

export const editorVirtualSpacePolicy = Facet.define<
  EditorVirtualSpacePolicy,
  EditorVirtualSpacePolicy
>({
  combine(values) {
    return values[values.length - 1] ?? {
      afterLineEnd: false,
      atFileBottom: false,
    };
  },
});

/**
 * §8.19.5 Virtual Space. IDEA keeps carets BEYOND the end of a line (and
 * below the last line) without touching the document; padding spaces are
 * only manufactured when content is actually inserted. Model:
 *
 *   - The caret's real offset stays clamped at the legal document position
 *     (CodeMirror invariant).
 *   - `virtualSpaceOverflowField` records, per selection head, how many
 *     VISUAL columns past the line end the caret sits (`overflow`).
 *   - Navigation (End / Shift+End repeats, click past EOL) writes overflow
 *     with a selection-only dispatch: no doc change, no history entry.
 *   - Real inserts (typing via the input handler, paste plans) consume the
 *     overflow by manufacturing the exact padding spaces in the SAME
 *     dispatch — multi-caret padding+text is one transaction.
 *   - IME composition never manufactures padding.
 *   - When the policy disables both gates, every virtual position collapses
 *     back to its legal document column.
 */

export interface VisualColumnPosition {
  line: number;
  /** 0-based column within the line's actual text. */
  documentColumn: number;
  /** Rendered column including tab expansion and double-width characters. */
  visualColumn: number;
  /**
   * Visual columns available past this line's end under the active policy
   * (0 when disabled; capped so measurements stay finite).
   */
  virtualColumns: number;
}

/** Per-head overflow map keyed by the CLAMPED head offset. */
export type VirtualOverflowMap = ReadonlyMap<number, number>;

export const setVirtualOverflow = StateEffect.define<VirtualOverflowMap>();

const MAX_OVERFLOW_COLUMNS = 200;

export const virtualSpaceOverflowField = StateField.define<VirtualOverflowMap>({
  create: () => new Map<number, number>(),
  update(value, tr) {
    const policy = tr.state.facet(editorVirtualSpacePolicy);
    if (!policy.afterLineEnd && !policy.atFileBottom) return new Map();
    const effect = tr.effects.find((candidate) => candidate.is(setVirtualOverflow));
    if (effect) {
      // Drop entries whose clamped head no longer matches a selection head.
      const heads = new Set(tr.state.selection.ranges.map((range) => range.head));
      const pruned = new Map<number, number>();
      for (const [head, overflow] of effect.value) {
        if (heads.has(head) && overflow > 0) pruned.set(head, overflow);
      }
      return pruned;
    }
    if (!tr.docChanged) {
      // Selection-only moves keep overflow for heads that did not move away
      // from their line end; any document edit collapses everything.
      if (value.size === 0) return value;
      const retained = new Map<number, number>();
      for (const range of tr.state.selection.ranges) {
        const overflow = value.get(range.head);
        if (overflow != null) retained.set(range.head, overflow);
      }
      return retained.size === value.size ? value : retained;
    }
    return new Map();
  },
});

/** Read the overflow for one head offset (0 when none). */
export function virtualOverflowAt(state: EditorState, head: number): number {
  return state.field(virtualSpaceOverflowField, false)?.get(head) ?? 0;
}

/** Width of one character at a given visual column (tabs stop-aligned). */
export function charVisualWidth(char: string, column: number, tabWidth: number): number {
  if (char === "\t") return tabWidth - (column % tabWidth);
  const code = char.codePointAt(0) ?? 0;
  // Approximate double-width test: astral code points plus common wide ranges
  // (CJK, Hangul, fullwidth forms, emoji blocks).
  if (code > 0xffff || (code >= 0x1100 && (
    code <= 0x115f
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ))) {
    return 2;
  }
  return 1;
}

/** Visual column of a document column within one line's text. */
export function visualColumnFor(lineText: string, documentColumn: number, tabWidth: number): number {
  let column = 0;
  let index = 0;
  while (index < documentColumn && index < lineText.length) {
    const char = String.fromCodePoint(lineText.codePointAt(index)!);
    column += charVisualWidth(char, column, tabWidth);
    index += char.length;
  }
  return column;
}

/**
 * Document column within lineText that corresponds to the given target visual column.
 * Respects tab stops, CJK, and emoji double-width characters.
 */
export function documentColumnForVisualColumn(
  lineText: string,
  targetVisualColumn: number,
  tabWidth: number,
): number {
  if (targetVisualColumn <= 0) return 0;
  let visual = 0;
  let index = 0;
  while (index < lineText.length) {
    const codePoint = lineText.codePointAt(index);
    if (codePoint == null) break;
    const char = String.fromCodePoint(codePoint);
    const width = charVisualWidth(char, visual, tabWidth);
    if (visual + width > targetVisualColumn) {
      break;
    }
    visual += width;
    index += char.length;
  }
  return index;
}

/**
 * Measure §8.19.5 VisualColumnPosition facts for every selection head.
 * Pure observation — never mutates state or history.
 */
export function measureVisualPositions(
  state: EditorState,
  tabWidth: number,
): VisualColumnPosition[] {
  const policy = state.facet(editorVirtualSpacePolicy);
  return state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const documentColumn = range.head - line.from;
    const isLastLine = line.number === state.doc.lines;
    const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;
    const overflow = virtualOverflowAt(state, range.head);
    return {
      line: line.number - 1,
      documentColumn,
      visualColumn: visualColumnFor(line.text, documentColumn, tabWidth),
      virtualColumns: allowed ? Math.min(overflow || MAX_OVERFLOW_COLUMNS, MAX_OVERFLOW_COLUMNS) : 0,
    };
  });
}

/**
 * Place (or clear) a virtual caret at `head` with `overflow` columns past the
 * line end. Selection-only dispatch — never touches doc or history.
 */
export function setVirtualHead(
  view: EditorView,
  head: number,
  overflow: number,
  extend: boolean,
): void {
  const previous = view.state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  // Other carets keep both their positions and their overflow entries —
  // placing a virtual caret never silently collapses multi-caret state.
  const map = new Map(previous);
  map.delete(head);
  if (overflow > 0) map.set(head, Math.min(overflow, MAX_OVERFLOW_COLUMNS));
  const main = view.state.selection.main;
  const ranges = view.state.selection.ranges.map((range, index) => (
    index === view.state.selection.mainIndex
      ? (extend && mouse_anchorIsBehind(main)
          ? EditorSelection.range(main.anchor, head)
          : EditorSelection.cursor(head))
      : range
  ));
  view.dispatch({
    selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
    effects: setVirtualOverflow.of(map),
    scrollIntoView: true,
  });
}

function mouse_anchorIsBehind(main: { anchor: number; head: number }): boolean {
  return main.anchor <= main.head;
}

/**
 * End / Shift+End under an enabling policy: first press lands on the real
 * line end; presses while already AT the end walk deeper into the virtual
 * region one visual column at a time. Without the policy this defers to the
 * default keymap (returns false).
 */
export function virtualLineEndCommand(view: EditorView, extend: boolean): boolean {
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const state = view.state;
  // Defer while any caret still has real text ahead of it: the default keymap
  // owns the move to the (possibly soft-wrapped) boundary. This command only
  // walks the VIRTUAL region once every head already sits at its line end.
  const allAtEnd = state.selection.ranges.every((range) => range.head >= state.doc.lineAt(range.head).to);
  if (!allAtEnd) return false;
  const previous = state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  const nextOverflow = new Map(previous);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    const headLine = state.doc.lineAt(range.head);
    const oldOverflow = previous.get(range.head) ?? 0;
    const overflow = Math.min(oldOverflow + 1, MAX_OVERFLOW_COLUMNS);
    nextOverflow.set(headLine.to, overflow);
    changed = true;
    if (!extend) return EditorSelection.cursor(headLine.to);
    return range.anchor <= range.head
      ? EditorSelection.range(range.anchor, headLine.to)
      : EditorSelection.range(headLine.to, range.anchor);
  });
  if (!changed) return false;

  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(nextOverflow),
    scrollIntoView: true,
  });
  return true;
}

/**
 * Backspace inside the virtual region shrinks the overflow WITHOUT touching
 * the document; at zero overflow it defers to the normal delete command.
 */
export function virtualBackspaceCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const next = new Map(field);
  let touched = false;
  for (const range of view.state.selection.ranges) {
    const overflow = next.get(range.head);
    if (overflow == null) continue;
    touched = true;
    if (overflow - 1 <= 0) next.delete(range.head);
    else next.set(range.head, overflow - 1);
  }
  if (!touched) return false;
  view.dispatch({ effects: setVirtualOverflow.of(next) });
  return true;
}

/** Padding spaces that realize a virtual caret before a real insertion. */
export function paddingForOverflow(overflow: number): string {
  return overflow > 0 ? " ".repeat(overflow) : "";
}

/**
 * Typing consumption (§8.19.5): when a caret sits in the virtual region, the
 * first real insertion manufactures its padding spaces IN THE SAME
 * transaction. IME composition events are ignored (no padding while
 * composing); without overflow this defers to CodeMirror's default handler.
 */
export const virtualSpaceTypingHandler = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (view.composing || !text) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  let anyPadding = false;
  const result = state.changeByRange((range) => {
    const padding = paddingForOverflow(field.get(range.head) ?? 0);
    if (padding) anyPadding = true;
    const insert = `${padding}${text}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(Math.min(range.from + insert.length, state.doc.length + insert.length)),
    };
  });
  if (!anyPadding) return false;
  view.dispatch(result);
  return true;
});

/**
 * Click past end-of-line (and below the last line under `atFileBottom`):
 * estimates the target visual column from the pixel overshoot and places a
 * virtual caret with a selection-only dispatch.
 */
export const virtualSpaceClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return false;
    const policy = view.state.facet(editorVirtualSpacePolicy);
    if (!policy.afterLineEnd && !policy.atFileBottom) return false;
    const pos = view.posAtCoords({ x: mouse.clientX, y: mouse.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    if (pos < line.to) return false; // ordinary click inside the text
    const isLastLine = line.number === view.state.doc.lines;
    if (!(isLastLine ? policy.atFileBottom : policy.afterLineEnd)) return false;
    const endCoords = view.coordsAtPos(line.to);
    // Below the last line counts as overshoot too when the gate allows it.
    const belowFile = isLastLine && endCoords != null && mouse.clientY > endCoords.bottom + 2;
    const overshootPx = endCoords ? Math.max(0, mouse.clientX - endCoords.left) : 0;
    if (overshootPx < 4 && !belowFile) return false;
    const charWidth = Math.max(1, view.defaultCharacterWidth);
    const columns = Math.min(MAX_OVERFLOW_COLUMNS, Math.max(1, Math.round(overshootPx / charWidth)));
    setVirtualHead(view, line.to, columns, mouse.shiftKey);
    mouse.preventDefault();
    return true;
  },
});

/** Per-caret desired visual column tracked across vertical navigation. */
export const setDesiredVisualColumns = StateEffect.define<readonly number[]>();

export const desiredVisualColumnField = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    const effect = tr.effects.find((candidate) => candidate.is(setDesiredVisualColumns));
    if (effect) return effect.value;
    if (tr.selection) {
      const tabWidth = 4;
      return tr.state.selection.ranges.map((range) => {
        const line = tr.state.doc.lineAt(range.head);
        const docCol = range.head - line.from;
        const overflow = virtualOverflowAt(tr.state, range.head);
        return visualColumnFor(line.text, docCol, tabWidth) + overflow;
      });
    }
    return value;
  },
});

/**
 * Vertical movement (Up / Down / PageUp / PageDown) with per-caret desired visual column.
 * Unified across single and multi-caret, respecting tab/CJK/emoji visual widths and virtual space policy.
 */
export function virtualVerticalMoveCommand(
  view: EditorView,
  direction: "up" | "down" | "pageUp" | "pageDown",
  extend: boolean,
): boolean {
  const policy = view.state.facet(editorVirtualSpacePolicy);
  const state = view.state;
  const tabWidth = 4;
  const desired = state.field(desiredVisualColumnField, false) ?? [];
  const lineDelta = direction === "up" ? -1 : direction === "down" ? 1 : direction === "pageUp" ? -15 : 15;

  let changed = false;
  const nextRanges: ReturnType<typeof EditorSelection.cursor>[] = [];
  const nextOverflow = new Map<number, number>();
  const nextDesired: number[] = [];

  state.selection.ranges.forEach((range, idx) => {
    const currentLine = state.doc.lineAt(range.head);
    const targetLineNumber = Math.min(state.doc.lines, Math.max(1, currentLine.number + lineDelta));
    if (targetLineNumber === currentLine.number && (direction === "up" || direction === "down")) {
      nextRanges.push(range);
      nextDesired.push(desired[idx] ?? (
        visualColumnFor(currentLine.text, range.head - currentLine.from, tabWidth)
        + virtualOverflowAt(state, range.head)
      ));
      return;
    }

    changed = true;
    const targetLine = state.doc.line(targetLineNumber);
    const desiredCol = desired[idx] ?? (
      visualColumnFor(currentLine.text, range.head - currentLine.from, tabWidth)
      + virtualOverflowAt(state, range.head)
    );
    nextDesired.push(desiredCol);

    const lineVisualWidth = visualColumnFor(targetLine.text, targetLine.length, tabWidth);
    const isLastLine = targetLine.number === state.doc.lines;
    const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;

    let targetHead: number;
    if (desiredCol > lineVisualWidth) {
      targetHead = targetLine.to;
      if (allowed) {
        const overflow = Math.min(desiredCol - lineVisualWidth, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(targetHead, overflow);
      }
    } else {
      const docCol = documentColumnForVisualColumn(targetLine.text, desiredCol, tabWidth);
      targetHead = targetLine.from + docCol;
    }

    if (extend) {
      nextRanges.push(
        range.anchor <= targetHead
          ? EditorSelection.range(range.anchor, targetHead)
          : EditorSelection.range(targetHead, range.anchor)
      );
    } else {
      nextRanges.push(EditorSelection.cursor(targetHead));
    }
  });

  if (!changed) return false;

  view.dispatch({
    selection: EditorSelection.create(nextRanges, state.selection.mainIndex),
    effects: [
      setVirtualOverflow.of(nextOverflow),
      setDesiredVisualColumns.of(nextDesired),
    ],
    scrollIntoView: true,
  });
  return true;
}

export const virtualMoveUp = (view: EditorView) => virtualVerticalMoveCommand(view, "up", false);
export const virtualMoveDown = (view: EditorView) => virtualVerticalMoveCommand(view, "down", false);
export const virtualSelectUp = (view: EditorView) => virtualVerticalMoveCommand(view, "up", true);
export const virtualSelectDown = (view: EditorView) => virtualVerticalMoveCommand(view, "down", true);
export const virtualPageUp = (view: EditorView) => virtualVerticalMoveCommand(view, "pageUp", false);
export const virtualPageDown = (view: EditorView) => virtualVerticalMoveCommand(view, "pageDown", false);

/**
 * §8.21.3 V2-C Honest declaration of known gaps in virtual space and region folding:
 * - Soft-wrap conflict: Soft line wrapping breaks single physical lines into multiple visual lines.
 *   Virtual space overflow beyond physical line end is supported at the end of the physical paragraph,
 *   but intermediate wrapped lines wrap to the viewport margin and cannot host virtual space.
 * - Multi-column rectangular selection: Multi-caret block selection pads spaces upon character entry,
 *   but 2D block rendering beyond right margin does not draw continuous empty box glyphs.
 * - Indentation fold fallback: Uses strict indentation level heuristics when language grammar AST
 *   is unavailable, but does not identify block delimiters (e.g. end keywords or braces) without a parser.
 */
export const VIRTUAL_SPACE_KNOWN_GAPS = [
  {
    feature: "soft-wrap",
    behavior: "Virtual space after line end only applies to the final physical line end; intermediate visual wrap lines terminate at viewport boundary.",
  },
  {
    feature: "rectangular-selection",
    behavior: "Rectangular columns in virtual space pad spaces upon typing; full 2D block background box rendering is limited to document bounds.",
  },
  {
    feature: "indent-folding-fallback",
    behavior: "Pure indent fallback operates on indentation levels without grammar token analysis.",
  },
] as const;

