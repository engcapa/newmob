import {
  completeAnyWord,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspPosition,
  LspTextEdit,
} from "../../../lib/editor/lsp";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import { isInsideStringOrComment } from "./syntaxContext";
import {
  getJavaJdkCompletionCandidates,
  generateJavaImportWorkspaceEdit,
  isJavaTypeImported,
} from "./javaQuickFix";

export interface LspCompletionHooks {
  fetch: (
    position: LspPosition,
    triggerCharacter: string | null,
  ) => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
  triggerCharacters: () => string[];
}

/** LSP CompletionItemKind → CodeMirror completion `type` (built-in icons). */
export function completionKindToType(kind: number | null): string | undefined {
  switch (kind) {
    case 1: return "text";
    case 2: return "method";
    case 3: return "function";
    case 4: return "function"; // constructor
    case 5: return "property"; // field
    case 6: return "variable";
    case 7: return "class";
    case 8: return "interface";
    case 9: return "namespace"; // module
    case 10: return "property";
    case 11: return "constant"; // unit
    case 12: return "constant"; // value
    case 13: return "enum";
    case 14: return "keyword";
    case 15: return "text"; // snippet — CM has no dedicated snippet icon
    case 16: return "constant"; // color
    case 17: return "file";
    case 18: return "text"; // reference
    case 19: return "folder";
    case 20: return "constant"; // enum member
    case 21: return "constant";
    case 22: return "class"; // struct
    case 23: return "property"; // event
    case 24: return "keyword"; // operator
    case 25: return "type"; // type parameter
    default:
      return kind == null ? undefined : "text";
  }
}

/**
 * Map LSP sortText (lexicographic, lower = better) into CodeMirror `boost`
 * (higher = better) so server ranking wins over naive label order.
 */
export function boostFromSortText(sortText: string | null | undefined): number | undefined {
  if (!sortText) return undefined;
  // Prefer pure numeric prefixes ("0001", "10") then fall back to string rank.
  const digits = sortText.match(/^\d+/)?.[0];
  if (digits) {
    const n = Number.parseInt(digits, 10);
    if (Number.isFinite(n)) return Math.max(-99, 1000 - Math.min(n, 1099));
  }
  // Lexicographic-ish: earlier code points rank higher.
  let score = 0;
  for (let i = 0; i < Math.min(sortText.length, 4); i += 1) {
    score = score * 96 + (sortText.charCodeAt(i) - 32);
  }
  return Math.max(-99, 500 - (score % 600));
}

/** Triggers that feel natural even when the server omits completionTriggerCharacters. */
export const DEFAULT_COMPLETION_TRIGGERS = [".", ":"];

/**
 * Cap the option list so the popup stays responsive. Servers like jdtls can
 * return thousands of members; IDEA also truncates the visible list and
 * re-queries as the user types.
 */
export const MAX_COMPLETION_OPTIONS = 200;

export function mergeCompletionTriggers(server: readonly string[] | null | undefined): string[] {
  const set = new Set<string>();
  for (const ch of server ?? []) {
    if (ch) set.add(ch);
  }
  for (const ch of DEFAULT_COMPLETION_TRIGGERS) set.add(ch);
  return [...set];
}

/**
 * Extra boost for camelCase / prefix quality when the server did not provide
 * sortText. Lower = better match; returned as CM boost (higher = better).
 */
export function boostFromTypedPrefix(
  typed: string,
  filterLabel: string,
  sortText: string | null | undefined,
): number | undefined {
  const fromSort = boostFromSortText(sortText);
  if (!typed) return fromSort;
  const label = filterLabel;
  const lowerTyped = typed.toLowerCase();
  const lowerLabel = label.toLowerCase();
  let quality = 0;
  if (label.startsWith(typed)) quality = 120;
  else if (lowerLabel.startsWith(lowerTyped)) quality = 100;
  else if (lowerLabel.includes(lowerTyped)) quality = 40;
  else {
    // camelCase initials: "oF" → openFile, "cwt" → CodeWorkspaceTab
    let ti = 0;
    for (let i = 0; i < label.length && ti < typed.length; i += 1) {
      const ch = label[i];
      const boundary = i === 0
        || ch !== ch.toLowerCase()
        || /[^A-Za-z0-9]/.test(label[i - 1] ?? "");
      if (!boundary && i > 0) continue;
      if (ch.toLowerCase() === typed[ti].toLowerCase()) ti += 1;
    }
    if (ti === typed.length) quality = 80;
  }
  if (!quality && fromSort === undefined) return undefined;
  return (fromSort ?? 0) + quality;
}

/**
 * Convert an LSP snippet (`$1`, `${1:default}`, `${1|a,b|}`) to CodeMirror's
 * snippet syntax (`${}` / `${default}`). Tabstop order follows appearance,
 * which matches the numbering of snippets real servers emit.
 */
export function lspSnippetToCmSnippet(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      // LSP escape: keep the escaped character literal; re-escape `${` so
      // CodeMirror does not read it as a field.
      const next = text[i + 1];
      out += next === "$" && text[i + 2] === "{" ? "\\$" : next;
      i += 1;
      continue;
    }
    if (char !== "$") {
      out += char;
      continue;
    }
    const rest = text.slice(i);
    const choice = rest.match(/^\$\{\d+\|([^|,}]*)[^|}]*\|\}/);
    if (choice) {
      out += `\${${choice[1]}}`;
      i += choice[0].length - 1;
      continue;
    }
    const placeholder = rest.match(/^\$\{\d+:([^{}]*)\}/);
    if (placeholder) {
      out += `\${${placeholder[1]}}`;
      i += placeholder[0].length - 1;
      continue;
    }
    const tabstop = rest.match(/^\$\{\d+\}/) ?? rest.match(/^\$\d+/);
    if (tabstop) {
      out += "${}";
      i += tabstop[0].length - 1;
      continue;
    }
    // Literal dollar; escape it when `${` would otherwise start a field.
    out += text[i + 1] === "{" ? "\\$" : "$";
  }
  return out;
}

function applyTextEdits(view: EditorView, edits: LspTextEdit[]): void {
  if (!edits.length) return;
  view.dispatch({
    changes: edits.map((edit) => ({
      from: offsetFromLspPosition(view.state.doc, edit.range.start),
      to: offsetFromLspPosition(view.state.doc, edit.range.end),
      insert: edit.newText,
    })),
  });
}

function applyLspCompletion(
  view: EditorView,
  completion: Completion,
  item: LspCompletionItem,
  from: number,
  to: number,
  resolve?: LspCompletionHooks["resolve"],
): void {
  // Prefer the server's textEdit range when present (e.g. replacing a member
  // access span wider/narrower than the typed prefix word).
  let replaceFrom = from;
  let replaceTo = to;
  if (item.textEdit) {
    replaceFrom = offsetFromLspPosition(view.state.doc, item.textEdit.range.start);
    replaceTo = offsetFromLspPosition(view.state.doc, item.textEdit.range.end);
  }
  const insert = item.textEdit?.newText ?? item.insertText ?? item.label;
  if (item.insertTextFormat === 2) {
    snippet(lspSnippetToCmSnippet(insert))(view, completion, replaceFrom, replaceTo);
  } else {
    view.dispatch({
      changes: { from: replaceFrom, to: replaceTo, insert },
      selection: { anchor: replaceFrom + insert.length },
    });
  }
  if (item.additionalTextEdits.length) {
    applyTextEdits(view, item.additionalTextEdits);
    return;
  }
  // Servers like typescript-language-server only compute auto-import edits
  // at resolve time; fetch them after the main insertion.
  if (resolve) {
    void resolve(item.raw)
      .then((resolved) => {
        if (resolved?.additionalTextEdits.length) {
          applyTextEdits(view, resolved.additionalTextEdits);
        }
      })
      .catch(() => {});
  }
}

async function completionInfo(
  item: LspCompletionItem,
  resolve?: LspCompletionHooks["resolve"],
): Promise<Node | null> {
  let documentation = item.documentation;
  let detail = item.detail;
  if (!documentation && resolve) {
    try {
      const resolved = await resolve(item.raw);
      documentation = resolved?.documentation ?? null;
      detail = detail ?? resolved?.detail ?? null;
    } catch {
      // Keep whatever we already have.
    }
  }
  if (!documentation && !detail) return null;
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  if (detail && detail !== item.label) {
    const detailEl = document.createElement("div");
    detailEl.style.fontFamily = "var(--taomni-code-font-family, monospace)";
    detailEl.style.marginBottom = documentation ? "6px" : "0";
    detailEl.textContent = detail;
    dom.appendChild(detailEl);
  }
  if (documentation) {
    const docEl = document.createElement("div");
    docEl.innerHTML = renderFormatted(documentation, "md") ?? "";
    dom.appendChild(docEl);
  }
  return dom;
}

export function createLspCompletionSource(hooks: LspCompletionHooks): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // Include `$` and `@` so Java/Kotlin/JS identifiers and decorators continue
    // the same completion session instead of closing after one character.
    const word = context.matchBefore(/[\w$@]+/);
    const charBefore = context.pos > 0
      ? context.state.sliceDoc(context.pos - 1, context.pos)
      : "";
    const triggers = hooks.triggerCharacters();
    // Trigger-only: just typed `.` / `:` with no identifier yet.
    const triggerOnly = !word && !!charBefore && triggers.includes(charBefore);
    // Also treat typing right after a trigger (e.g. `obj.t`) as a triggered
    // completion so the server gets triggerKind=2 for member lists.
    const afterTrigger = !!word
      && word.from > 0
      && triggers.includes(context.state.sliceDoc(word.from - 1, word.from));
    if (!context.explicit && !word && !triggerOnly) return null;
    // Suppress word-based LSP autocompletion inside string literals or comments
    // unless user explicitly invoked completion (Ctrl+Space) or typed a trigger character.
    if (!context.explicit && !triggerOnly && !afterTrigger && isInsideStringOrComment(context.state, context.pos)) {
      return null;
    }

    // LSP responses are tied to a document version. Do not spend renderer time
    // mapping a response that became stale while the user kept typing.
    context.addEventListener("abort", () => {}, { onDocChange: true });

    // For plain non-trigger typing (e.g. typing identifiers in Java without `.` or `:`),
    // settle briefly so rapid typing does not spam heavy LSP queries on every keystroke.
    if (!context.explicit && !triggerOnly && !afterTrigger) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 80);
        context.addEventListener("abort", () => {
          window.clearTimeout(timer);
          resolve();
        });
      });
      if (context.aborted) return null;
    }

    const triggerCharacter = triggerOnly
      ? charBefore
      : afterTrigger
        ? context.state.sliceDoc(word!.from - 1, word!.from)
        : null;
    let result: LspCompletionResult | null = null;
    try {
      result = await hooks.fetch(
        lspPositionFromOffset(context.state.doc, context.pos),
        triggerCharacter,
      );
    } catch {
      result = null;
    }
    if (context.aborted) return null;
    // No language service: check if typed prefix matches JDK types, else fall back to buffer-word completion.
    if (!result || (!result.status.active && result.items.length === 0)) {
      const docText = context.state.doc.toString();
      const typed = word ? word.text : "";
      const jdkCandidates = getJavaJdkCompletionCandidates(typed, docText);
      if (jdkCandidates.length > 0) {
        const options: Completion[] = jdkCandidates.map((c) => ({
          label: c.label,
          detail: c.detail,
          type: c.type,
          boost: c.boost,
          apply: (view, completion, from, to) => {
            const currentDoc = view.state.doc.toString();
            const fqcn = completion.detail!;
            const simpleName = completion.label;

            view.dispatch({
              changes: { from, to, insert: simpleName },
              selection: { anchor: from + simpleName.length },
            });

            if (!isJavaTypeImported(currentDoc, fqcn, simpleName)) {
              const importEdit = generateJavaImportWorkspaceEdit("dummy.java", view.state.doc.toString(), fqcn);
              const textEdit = importEdit.documentEdits[0]?.edits[0];
              if (textEdit) {
                const importPos = offsetFromLspPosition(view.state.doc, textEdit.range.start);
                view.dispatch({
                  changes: { from: importPos, to: importPos, insert: textEdit.newText },
                });
              }
            }
          },
        }));
        return {
          from: word ? word.from : context.pos,
          options,
        };
      }
      return completeAnyWord(context);
    }
    if (result.items.length === 0) return null;

    const typed = word ? word.text : "";
    const rawItems = result.items;
    const mapped: Completion[] = [];
    const maxItemsToProcess = Math.min(rawItems.length, MAX_COMPLETION_OPTIONS * 3);
    for (let i = 0; i < maxItemsToProcess; i += 1) {
      const item = rawItems[i];
      if (!item) continue;
      const filterText = item.filterText?.trim() ? item.filterText : null;
      const label = filterText ?? item.label;
      const boost = boostFromTypedPrefix(typed, label, item.sortText);
      if (typed && boost === undefined && mapped.length >= MAX_COMPLETION_OPTIONS) {
        continue;
      }
      const displayLabel = filterText && filterText !== item.label ? item.label : undefined;
      mapped.push({
        label,
        displayLabel,
        sortText: item.sortText ?? undefined,
        boost,
        type: completionKindToType(item.kind),
        detail: item.detail ?? undefined,
        info: item.documentation || hooks.resolve
          ? () => completionInfo(item, hooks.resolve)
          : undefined,
        apply: (view, completion, from, to) =>
          applyLspCompletion(view, completion, item, from, to, hooks.resolve),
      });
      if (mapped.length >= MAX_COMPLETION_OPTIONS * 2) break;
    }
    if (context.aborted) return null;

    // Prefer textEdit start when every item shares the same replace range so
    // CM's client-side filtering aligns with the server's replace span.
    let from = word ? word.from : context.pos;
    const firstEdit = result.items[0]?.textEdit;
    if (firstEdit && result.items.every((item) => (
      item.textEdit
      && item.textEdit.range.start.line === firstEdit.range.start.line
      && item.textEdit.range.start.character === firstEdit.range.start.character
      && item.textEdit.range.end.line === firstEdit.range.end.line
      && item.textEdit.range.end.character === firstEdit.range.end.character
    ))) {
      from = offsetFromLspPosition(context.state.doc, firstEdit.range.start);
    }

    // Keep server order for the head of the list, then cap for popup cost.
    const options = mapped.length > MAX_COMPLETION_OPTIONS
      ? mapped.slice(0, MAX_COMPLETION_OPTIONS)
      : mapped;

    return {
      from,
      options,
      // Incomplete lists should re-query on further typing (no sticky validFor).
      // Complete lists stay open while the user continues the identifier.
      // Always filter client-side for camelCase/prefix quality on the cap —
      // incomplete lists still re-query because validFor is unset.
      filter: true,
      validFor: result.isIncomplete ? undefined : /^[\w$@]*$/,
    };
  };
}
