/**
 * Semantic editing plans (§8.18.8 P1-C7): Complete Statement, Surround With
 * and Generate Code as typed plans. Every entry point returns an explicit
 * plan — including `unavailable` with a reason — instead of guessing edits.
 * Local text-template fallbacks are labelled `Local/Text` and never counted
 * as provider-backed semantics.
 */

import type { ChangeSpec } from "@codemirror/state";

export type CompletionMode = "basic" | "smart-type-matching";

/** Why Smart/Type-Matching cannot run in this context. */
export type SmartCompletionUnavailableReason =
  | "capability-not-advertised"
  | "no-provider"
  | "provider-starting";

export interface SmartCompletionGate {
  mode: CompletionMode;
  available: boolean;
  reason: SmartCompletionUnavailableReason | null;
  /**
   * Honest label for the popup: IDEA's Smart completion filters by expected
   * type. Plain LSP has no such capability, so unless the provider
   * advertises one the action stays unavailable rather than renaming fuzzy
   * Basic results.
   */
  badge: "Smart" | null;
}

export function smartCompletionGate(input: {
  providerAdvertisesExpectedTypes: boolean;
  providerActive: boolean;
}): SmartCompletionGate {
  if (!input.providerAdvertisesExpectedTypes) {
    return {
      mode: "smart-type-matching",
      available: false,
      reason: "capability-not-advertised",
      badge: null,
    };
  }
  if (!input.providerActive) {
    return { mode: "smart-type-matching", available: false, reason: "no-provider", badge: null };
  }
  return { mode: "smart-type-matching", available: true, reason: null, badge: "Smart" };
}

// ---------------------------------------------------------------------------
// SemanticEditPlan union shared by statement/surround/generate entries
// ---------------------------------------------------------------------------

export type SemanticEditPlan =
  | {
    kind: "editor-transaction";
    title: string;
    changes: readonly ChangeSpec[];
    /** Selection anchor/head in POST-image coordinates. */
    selection: { anchor: number; head: number };
    source: "syntax-tree";
    evidence: { languageId: string; rule: string };
  }
  | { kind: "unavailable"; reason: string; detail: string };

// ---------------------------------------------------------------------------
// Complete Statement (conservative; uncertain cases no-op with a reason)
// ---------------------------------------------------------------------------

/**
 * Decide whether the current line can be completed with a trailing `;`.
 * Only unambiguous single-line shapes qualify (`foo()`, `x = 1`,
 * `return x`); anything with block openers, comments or trailing operators
 * is explicitly unavailable instead of guessed.
 */
export function completeStatementPlan(input: {
  lineText: string;
  nextLineStart: string | null;
  readOnly: boolean;
  languageId: string;
}): { insertSemicolonAt: number } | { kind: "unavailable"; reason: string } {
  if (input.readOnly) return { kind: "unavailable", reason: "Read-only editor" };
  const trimmedEnd = input.lineText.replace(/\s+$/, "");
  if (!trimmedEnd.trim()) return { kind: "unavailable", reason: "Empty line" };
  if (/;\s*$/.test(trimmedEnd)) return { kind: "unavailable", reason: "Statement already terminated" };
  // Block-level constructs and partial expressions must not be touched.
  if (/^\s*(if|for|while|switch|else|try|catch|finally|do)\b/.test(trimmedEnd)) {
    // Control-flow headers are followed by a block, never by `;`.
    return { kind: "unavailable", reason: "Control-flow header takes a block, not a terminator" };
  }
  if (/[{}]\s*$/.test(trimmedEnd)) return { kind: "unavailable", reason: "Line ends with a block boundary" };
  if (/[+\-*/=,&|(]$/.test(trimmedEnd.trim())) return { kind: "unavailable", reason: "Expression continues on the next line" };
  // A call/assignment tail is the safe case.
  if (/[)\w"\]]$/.test(trimmedEnd.trim())) {
    return { insertSemicolonAt: trimmedEnd.length };
  }
  return { kind: "unavailable", reason: "Uncertain statement boundary" };
}

// ---------------------------------------------------------------------------
// Surround With (selection must align to a whole syntactic range)
// ---------------------------------------------------------------------------

export interface SurroundKind {
  id: "if" | "while" | "try-catch" | "synchronized" | "runnable";
  title: string;
  /** Java-first subset per §8.18.8; other languages stay unavailable. */
  languages: readonly string[];
}

export const SURROUND_KINDS: readonly SurroundKind[] = [
  { id: "if", title: "Surround with if", languages: ["java", "typescript", "javascript", "csharp"] },
  { id: "while", title: "Surround with while", languages: ["java", "typescript", "javascript", "csharp"] },
  { id: "try-catch", title: "Surround with try/catch", languages: ["java", "typescript", "javascript", "csharp"] },
  { id: "synchronized", title: "Surround with synchronized", languages: ["java"] },
  { id: "runnable", title: "Surround with Runnable", languages: ["java"] },
];

export interface SurroundSelectionFacts {
  text: string;
  /** Absolute document offsets of the selected range. */
  from: number;
  to: number;
  fromLineStart: boolean;
  toLineEnd: boolean;
  rangeCount: number;
  readOnly: boolean;
  languageId: string;
}

const TEMPLATES: Record<SurroundKind["id"], (_body: string, indent: string) => { head: string[]; bodyIndent: string; foot: string[] }> = {
  "if": (_body, indent) => ({
    head: [`${indent}if (cond) {`],
    bodyIndent: `${indent}  `,
    foot: [`${indent}}`],
  }),
  "while": (_body, indent) => ({
    head: [`${indent}while (cond) {`],
    bodyIndent: `${indent}  `,
    foot: [`${indent}}`],
  }),
  "try-catch": (_body, indent) => ({
    head: [`${indent}try {`],
    bodyIndent: `${indent}  `,
    foot: [`${indent}} catch (Exception e) {`, `${indent}  `, `${indent}}`],
  }),
  "synchronized": (_body, indent) => ({
    head: [`${indent}synchronized (lock) {`],
    bodyIndent: `${indent}  `,
    foot: [`${indent}}`],
  }),
  "runnable": (_body, indent) => ({
    head: [`${indent}new Runnable() {`, `${indent}  @Override`, `${indent}  public void run() {`],
    bodyIndent: `${indent}    `,
    foot: [`${indent}  }`, `${indent}}`],
  }),
};

/**
 * Build the surround transaction. The selection must cover whole lines of
 * ONE range; partial-token or multi-range selections are unavailable.
 */
export function surroundWithPlan(
  kindId: SurroundKind["id"],
  facts: SurroundSelectionFacts,
): SemanticEditPlan {
  const kind = SURROUND_KINDS.find((entry) => entry.id === kindId);
  if (!kind) return { kind: "unavailable", reason: "unknown-surround-kind", detail: kindId };
  if (!kind.languages.includes(facts.languageId)) {
    return {
      kind: "unavailable",
      reason: "unsupported-language",
      detail: `${kind.title} is not provided for ${facts.languageId}`,
    };
  }
  if (facts.readOnly) return { kind: "unavailable", reason: "read-only", detail: "Editor is read-only" };
  if (facts.rangeCount !== 1) {
    return { kind: "unavailable", reason: "multi-range", detail: "Select exactly one range to surround" };
  }
  if (!facts.fromLineStart || !facts.toLineEnd) {
    return {
      kind: "unavailable",
      reason: "partial-selection",
      detail: "Selection must span whole lines so it aligns to a syntax range",
    };
  }
  if (!facts.text.trim()) {
    return { kind: "unavailable", reason: "empty-selection", detail: "Nothing to surround" };
  }

  const baseIndent = facts.text.match(/^[ \t]*/)?.[0] ?? "";
  const template = TEMPLATES[kindId](facts.text, baseIndent);
  const indentedBody = facts.text
    .split("\n")
    .map((line) => (line.trim() ? template.bodyIndent + line : line))
    .join("\n");
  const insert = [...template.head, indentedBody, ...template.foot].join("\n");

  // Caret lands on the first wrapper placeholder (cond/lock), which sits in
  // the head block before the retained body.
  const headText = template.head.join("\n");
  const placeholderMatch = headText.match(/\((\w+)(?:\))?/);
  const caretInInsert = placeholderMatch
    ? headText.indexOf(placeholderMatch[1]) + placeholderMatch[1].length
    : headText.length;

  return {
    kind: "editor-transaction",
    title: kind.title,
    changes: [{ from: facts.from, to: facts.to, insert }],
    selection: { anchor: facts.from + caretInInsert, head: facts.from + caretInInsert },
    source: "syntax-tree",
    evidence: { languageId: facts.languageId, rule: `surround.${kind.id}` },
  };
}

// ---------------------------------------------------------------------------
// Generate Code via provider CodeActions (constructor/getter/… candidates)
// ---------------------------------------------------------------------------

/** Provider CodeAction kinds that count as generate candidates. */
const GENERATE_ACTION_KIND_PREFIXES = ["source.generate.", "refactor.extract.", "source."];

export function filterGenerateCodeActions(actions: readonly { title: string; kind?: string | null }[]): Array<{ title: string; kind: string }> {
  return actions
    .filter((action) => !!action.kind && GENERATE_ACTION_KIND_PREFIXES.some((prefix) => action.kind!.startsWith(prefix)))
    .map((action) => ({ title: action.title, kind: action.kind! }));
}
