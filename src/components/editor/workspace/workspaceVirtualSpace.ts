import { EditorSelection, StateEffect, StateField, findClusterBreak } from "@codemirror/state";
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
  const first = String.fromCodePoint(code);
  if (/^\p{Mark}$/u.test(first) || code === 0x200d) return 0;
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
    const next = findClusterBreak(lineText, index, true, true);
    if (next <= index || next > documentColumn) break;
    column += charVisualWidth(lineText.slice(index, next), column, tabWidth);
    index = next;
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
    const next = findClusterBreak(lineText, index, true, true);
    if (next <= index) break;
    const width = charVisualWidth(lineText.slice(index, next), visual, tabWidth);
    if (visual + width > targetVisualColumn) {
      break;
    }
    visual += width;
    index = next;
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
      ? (extend
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

/**
 * End / Shift+End under an enabling policy: first press lands on the real
 * line end; presses while already AT the end walk deeper into the virtual
 * region one visual column at a time. Without the policy this defers to the
 * default keymap (returns false).
 */
export function virtualLineEndCommand(view: EditorView, extend: boolean): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const state = view.state;
  const anyAtEndOrVirtual = state.selection.ranges.some((range) => {
    const line = state.doc.lineAt(range.head);
    return range.head >= line.to;
  });
  if (!anyAtEndOrVirtual) return false;
  const previous = state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  const nextOverflow = new Map(previous);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    const headLine = state.doc.lineAt(range.head);
    const oldOverflow = previous.get(range.head) ?? 0;
    let targetHead = headLine.to;
    if (range.head >= headLine.to || oldOverflow > 0) {
      const isLastLine = headLine.number === state.doc.lines;
      const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;
      if (allowed) {
        const overflow = Math.min(oldOverflow + 1, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(headLine.to, overflow);
        changed = true;
      }
    } else {
      targetHead = headLine.to;
      changed = true;
    }
    if (!extend) return EditorSelection.cursor(targetHead);
    return EditorSelection.range(range.anchor, targetHead);
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
    // WebKitGTK's native pointer path can leave focus on BODY. This handler
    // may consume a click past EOL before later host handlers are reached.
    if (!view.hasFocus) view.focus();
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
      const tabWidth = tr.state.tabSize;
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
 * Check whether CodeMirror line block and viewport geometry are ready.
 * Geometry is ready when viewport height and line height are positive non-zero numbers
 * and line block lookup methods are available.
 */
export function isEditorGeometryReady(view: EditorView): boolean {
  if (!view.dom || !view.scrollDOM) return false;
  const viewportHeight = view.scrollDOM.clientHeight || view.dom.clientHeight;
  const lineHeight = view.defaultLineHeight;
  return viewportHeight > 0 && lineHeight > 0 && typeof view.lineBlockAt === "function" && typeof view.lineBlockAtHeight === "function";
}

export interface TargetVisualBlock {
  from: number;
  to: number;
  /** Exact caret returned by CodeMirror's rendered-geometry navigation. */
  head?: number;
  /** Rendered horizontal goal returned by CodeMirror, in CSS pixels. */
  goalColumn?: number;
}

/**
 * Locate target visual block based on real display geometry, supporting soft wrapping,
 * dynamic line height, and viewport height.
 */
export function resolveTargetVisualBlock(
  view: EditorView,
  head: number,
  direction: "up" | "down" | "pageUp" | "pageDown",
  goalColumn?: number,
): TargetVisualBlock | null {
  const state = view.state;
  const currentLine = state.doc.lineAt(head);

  if (isEditorGeometryReady(view)) {
    try {
      const viewportHeight = view.scrollDOM.clientHeight || view.dom.clientHeight;
      const pageDistance = Math.max(view.defaultLineHeight, viewportHeight - view.defaultLineHeight);
      const start = EditorSelection.cursor(head, 1, undefined, goalColumn);
      const forward = direction === "down" || direction === "pageDown";
      const target = direction === "pageUp" || direction === "pageDown"
        ? view.moveVertically(start, forward, pageDistance)
        : view.moveVertically(start, forward);
      const targetLine = state.doc.lineAt(target.head);
      return {
        from: targetLine.from,
        to: targetLine.to,
        head: target.head,
        goalColumn: target.goalColumn ?? undefined,
      };
    } catch {
      // Fall through to non-geometry fallback
    }
  }

  // When geometry is NOT ready:
  // For Page movement: return null so caller yields to default handler without guessing fixed 15 lines (§ED-VSPACE-002).
  if (direction === "pageUp" || direction === "pageDown") {
    return null;
  }

  // Single line fallback (line arithmetic):
  const delta = direction === "up" ? -1 : 1;
  const targetLineNumber = Math.min(state.doc.lines, Math.max(1, currentLine.number + delta));
  const targetLine = state.doc.line(targetLineNumber);
  return { from: targetLine.from, to: targetLine.to };
}

/**
 * Vertical movement (Up / Down / PageUp / PageDown) with per-caret desired visual column.
 * Unified across single and multi-caret, respecting real display geometry, soft wrap,
 * tab/CJK/emoji visual widths and virtual space policy.
 */
export function virtualVerticalMoveCommand(
  view: EditorView,
  direction: "up" | "down" | "pageUp" | "pageDown",
  extend: boolean,
): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  const state = view.state;
  const tabWidth = state.tabSize;
  const desired = state.field(desiredVisualColumnField, false) ?? [];

  // For PageUp / PageDown without ready geometry, yield to default handler (§ED-VSPACE-002)
  if ((direction === "pageUp" || direction === "pageDown") && !isEditorGeometryReady(view)) {
    return false;
  }

  let changed = false;
  const nextRanges: ReturnType<typeof EditorSelection.cursor>[] = [];
  const nextOverflow = new Map<number, number>();
  const nextDesired: number[] = [];

  for (let idx = 0; idx < state.selection.ranges.length; idx++) {
    const range = state.selection.ranges[idx];
    const currentLine = state.doc.lineAt(range.head);
    const currentOverflow = virtualOverflowAt(state, range.head);
    const initialDesiredCol = desired[idx] ?? (
      visualColumnFor(currentLine.text, range.head - currentLine.from, tabWidth)
      + currentOverflow
    );
    const requestedGoalColumn = range.goalColumn
      ?? (currentOverflow > 0
        ? initialDesiredCol * Math.max(1, view.defaultCharacterWidth)
        : undefined);

    const targetBlock = resolveTargetVisualBlock(
      view,
      range.head,
      direction,
      requestedGoalColumn,
    );
    if (!targetBlock) return false;

    const desiredCol = view.lineWrapping && targetBlock.goalColumn != null
      ? Math.max(0, Math.round(targetBlock.goalColumn / Math.max(1, view.defaultCharacterWidth)))
      : initialDesiredCol;
    nextDesired.push(desiredCol);

    const geometryTargetHead = targetBlock.head;
    const targetPhysLine = state.doc.lineAt(geometryTargetHead ?? targetBlock.from);
    const isEndOfPhysLine = (geometryTargetHead ?? targetBlock.to) === targetPhysLine.to;
    const isLastLine = targetPhysLine.number === state.doc.lines;
    const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;

    const blockText = state.sliceDoc(targetBlock.from, targetBlock.to);
    const blockVisualWidth = visualColumnFor(blockText, blockText.length, tabWidth);

    let targetHead: number;
    if (view.lineWrapping && geometryTargetHead != null) {
      targetHead = geometryTargetHead;
      if (desiredCol > blockVisualWidth && allowed && isEndOfPhysLine) {
        const overflow = Math.min(desiredCol - blockVisualWidth, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(targetHead, overflow);
      }
    } else if (desiredCol > blockVisualWidth) {
      targetHead = targetBlock.to;
      if (allowed && isEndOfPhysLine) {
        const overflow = Math.min(desiredCol - blockVisualWidth, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(targetHead, overflow);
      }
    } else {
      const docCol = documentColumnForVisualColumn(blockText, desiredCol, tabWidth);
      targetHead = targetBlock.from + docCol;
    }

    if (targetHead !== range.head || virtualOverflowAt(state, range.head) !== (nextOverflow.get(targetHead) ?? 0)) {
      changed = true;
    }

    if (extend) {
      nextRanges.push(EditorSelection.range(
        range.anchor,
        targetHead,
        targetBlock.goalColumn,
      ));
    } else {
      nextRanges.push(EditorSelection.cursor(targetHead, 1, undefined, targetBlock.goalColumn));
    }
  }

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
export const virtualSelectPageUp = (view: EditorView) => virtualVerticalMoveCommand(view, "pageUp", true);
export const virtualSelectPageDown = (view: EditorView) => virtualVerticalMoveCommand(view, "pageDown", true);

export function virtualMoveLeftCommand(view: EditorView, extend: boolean): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  const next = new Map(field);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    if (!extend && !range.empty) {
      next.delete(range.head);
      changed = true;
      return EditorSelection.cursor(range.from);
    }
    const overflow = next.get(range.head);
    let targetHead = range.head;
    if (overflow != null && overflow > 0) {
      changed = true;
      if (overflow - 1 <= 0) next.delete(range.head);
      else next.set(range.head, overflow - 1);
    } else {
      const line = state.doc.lineAt(range.head);
      if (range.head > line.from) {
        targetHead = range.head - 1;
        changed = true;
      }
    }

    if (!extend) return EditorSelection.cursor(targetHead);
    return EditorSelection.range(range.anchor, targetHead);
  });

  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(next),
    scrollIntoView: true,
  });
  return true;
}

export function virtualMoveRightCommand(view: EditorView, extend: boolean): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const state = view.state;
  const previous = state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  const anyAtEndOrVirtual = state.selection.ranges.some((range) => {
    const line = state.doc.lineAt(range.head);
    return range.head >= line.to || (previous.get(range.head) ?? 0) > 0;
  });
  if (!anyAtEndOrVirtual) return false;

  const next = new Map(previous);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    if (!extend && !range.empty) {
      next.delete(range.head);
      changed = true;
      return EditorSelection.cursor(range.to);
    }
    const headLine = state.doc.lineAt(range.head);
    const oldOverflow = previous.get(range.head) ?? 0;
    let targetHead = range.head;
    if (range.head >= headLine.to || oldOverflow > 0) {
      const isLastLine = headLine.number === state.doc.lines;
      const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;
      if (allowed) {
        const overflow = Math.min(oldOverflow + 1, MAX_OVERFLOW_COLUMNS);
        next.set(headLine.to, overflow);
        targetHead = headLine.to;
        changed = true;
      }
    } else {
      targetHead = Math.min(headLine.to, range.head + 1);
      changed = true;
    }

    if (!extend) return EditorSelection.cursor(targetHead);
    return EditorSelection.range(range.anchor, targetHead);
  });

  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(next),
    scrollIntoView: true,
  });
  return true;
}

export function virtualHomeCommand(view: EditorView, extend: boolean = false): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  const ranges = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const match = /^\s*/.exec(line.text);
    const indentCol = match ? match[0].length : 0;
    const target = range.head === line.from + indentCol ? line.from : line.from + indentCol;
    if (!extend) return EditorSelection.cursor(target);
    return EditorSelection.range(range.anchor, target);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(new Map()),
    scrollIntoView: true,
  });
  return true;
}

export function virtualDeleteCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  return true;
}

export function virtualEnterCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  let anyPadding = false;
  const result = state.changeByRange((range) => {
    const padding = paddingForOverflow(field.get(range.head) ?? 0);
    if (padding) anyPadding = true;
    const insert = `${padding}\n`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  if (!anyPadding) return false;
  view.dispatch(result);
  return true;
}

export function virtualTabCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  const state = view.state;
  const allAtEnd = state.selection.ranges.every((range) => range.head >= state.doc.lineAt(range.head).to);
  if (!allAtEnd && (!field || field.size === 0)) return false;

  const tabWidth = state.tabSize;
  const next = new Map(field ?? new Map());
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const curOverflow = field?.get(range.head) ?? 0;
    const curVisual = visualColumnFor(line.text, line.length, tabWidth) + curOverflow;
    const delta = tabWidth - (curVisual % tabWidth) || tabWidth;
    const newOverflow = Math.min(curOverflow + delta, MAX_OVERFLOW_COLUMNS);
    next.set(line.to, newOverflow);
    changed = true;
    return EditorSelection.cursor(line.to);
  });

  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(next),
  });
  return true;
}

export function virtualEscapeCommand(view: EditorView): boolean {
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  view.dispatch({
    effects: setVirtualOverflow.of(new Map()),
  });
  return true;
}

export const VirtualSpaceController = {
  measureVisualPositions,
  virtualOverflowAt,
  setVirtualHead,
  typingHandler: virtualSpaceTypingHandler,
  clickHandler: virtualSpaceClickHandler,
  paddingForOverflow,
};

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
