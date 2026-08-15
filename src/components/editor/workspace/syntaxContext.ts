import { type EditorState } from "@codemirror/state";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";

/**
 * Returns true if the given position in the editor document is inside a string
 * literal, character literal, or comment.
 *
 * Used to suppress keyword / live template / word-based completions inside
 * strings and comments where code-structure autocompletions cause intrusive
 * popup lag and layout thrashing.
 *
 * Only reads the tree if it is already parsed up to `pos` (syntaxTreeAvailable).
 * `syntaxTree(state).resolveInner()` would otherwise force CM6's incremental
 * parser to catch up to `pos` synchronously on the calling stack, which is a
 * visible per-keystroke stall on large Java files while typing outruns the
 * background parse worker. When the tree isn't ready yet, fall through to the
 * cheap lexical fallback below instead of blocking on a reparse.
 */
export function isInsideStringOrComment(state: EditorState, pos: number): boolean {
  try {
    if (syntaxTreeAvailable(state, pos)) {
      const tree = syntaxTree(state);
      let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1);
      while (node) {
        const name = node.name.toLowerCase();
        if (
          name.includes("string")
          || name.includes("comment")
          || name.includes("character")
          || (name.includes("literal") && (name.includes("str") || name.includes("char")))
        ) {
          return true;
        }
        node = node.parent;
      }
      return false;
    }
  } catch {
    // Fall back to lexical line inspection below
  }

  try {
    const line = state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    // Check if after single-line comment marker
    if (before.includes("//")) {
      const commentIdx = before.indexOf("//");
      const pre = before.slice(0, commentIdx);
      const quotes = (pre.match(/(?<!\\)"/g) || []).length;
      if (quotes % 2 === 0) return true;
    }
    // Check if inside double quotes
    const doubleQuotes = (before.match(/(?<!\\)"/g) || []).length;
    if (doubleQuotes % 2 === 1) return true;
    // Check if inside single quotes
    const singleQuotes = (before.match(/(?<!\\)'/g) || []).length;
    if (singleQuotes % 2 === 1) return true;
  } catch {
    // Ignore error and allow completion
  }

  return false;
}
