import {
  completeAnyWord,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspPosition,
  LspTextEdit,
} from "../../../lib/editor/lsp";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import { isInsideStringOrComment } from "./syntaxContext";

/**
 * Mandatory request identity for every production completion request
 * (§8.16.2). All fields are required: a request that cannot prove who it
 * belongs to must be treated as unavailable, never guessed.
 */
export interface CompletionRequestToken {
  workspaceId: string;
  fileKey: string;
  filePath: string;
  uri: string;
  languageId: string;
  documentRevision: number;
  lspSessionGeneration: number;
  requestId: string;
}

/** Live identity captured at request start; requestId is minted per request. */
export type CompletionRequestIdentity = Omit<CompletionRequestToken, "requestId">;

export type CompletionAcceptanceDiagnostic =
  | "truncated"
  | "invalid-additional-edits"
  | "additional-edit-unavailable"
  | "identity-mismatch";

export interface LspCompletionHooks {
  /** Live file/session identity; null means "no provable identity". */
  identity: () => CompletionRequestIdentity | null;
  fetch: (
    position: LspPosition,
    triggerCharacter: string | null,
    token: CompletionRequestToken,
  ) => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown, token: CompletionRequestToken) => Promise<LspCompletionItem | null>;
  triggerCharacters: () => string[];
  getDocumentRevision: () => number;
  /** Observable acceptance diagnostics for status/QA surfaces. */
  reportDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
}

/**
 * Test-fixture source contract: no identity proof, no session generation.
 * Production code must use `createLspCompletionSource`; tests that exercise
 * mapping logic use this entry so optionality never leaks into production.
 */
export interface FixtureCompletionHooks {
  fetch: (position: LspPosition, triggerCharacter: string | null)
    => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
  triggerCharacters?: () => string[];
  getDocumentRevision?: () => number;
  reportDiagnostic?: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
}

let completionRequestIdCounter = 0;

/**
 * Request-phase telemetry (§8.17.2 step 5). Only provider identity metadata,
 * phase transitions, latency, counts and truncation are recorded — never
 * source text, labels or import content. The bounded ring is readable by QA
 * surfaces and unit tests without any UI wiring.
 */
export type CompletionRequestPhase =
  | "fetching"
  | "popup"
  | "unavailable"
  | "stale"
  | "failed"
  | "applied";

export interface CompletionRequestTelemetryEvent {
  requestId: string;
  languageId: string;
  phase: CompletionRequestPhase;
  /** Milliseconds since the request token was minted. */
  durationMs: number;
  itemCount: number;
  truncated: boolean;
  reason?: string;
}

const completionTelemetryRing: CompletionRequestTelemetryEvent[] = [];
const COMPLETION_TELEMETRY_RING_MAX = 50;
const completionRequestStartedAt = new WeakMap<CompletionRequestToken, number>();

function telemetryElapsed(token: CompletionRequestToken): number {
  const startedAt = completionRequestStartedAt.get(token);
  return startedAt === undefined ? 0 : Math.max(0, Math.round(performance.now() - startedAt));
}

function recordCompletionTelemetry(
  token: CompletionRequestToken,
  phase: CompletionRequestPhase,
  options: { itemCount?: number; truncated?: boolean; reason?: string } = {},
): void {
  completionTelemetryRing.push({
    requestId: token.requestId,
    languageId: token.languageId,
    phase,
    durationMs: telemetryElapsed(token),
    itemCount: options.itemCount ?? 0,
    truncated: options.truncated ?? false,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  });
  if (completionTelemetryRing.length > COMPLETION_TELEMETRY_RING_MAX) {
    completionTelemetryRing.splice(0, completionTelemetryRing.length - COMPLETION_TELEMETRY_RING_MAX);
  }
}

/** Snapshot of recent request phases (oldest first); copy, caller cannot mutate. */
export function recentCompletionTelemetry(): readonly CompletionRequestTelemetryEvent[] {
  return [...completionTelemetryRing];
}

/** Test/diagnostic reset of the telemetry ring. */
export function resetCompletionTelemetry(): void {
  completionTelemetryRing.length = 0;
}

function sameCompletionIdentity(
  a: CompletionRequestIdentity,
  b: CompletionRequestIdentity,
): boolean {
  return a.workspaceId === b.workspaceId
    && a.fileKey === b.fileKey
    && a.filePath === b.filePath
    && a.uri === b.uri
    && a.languageId === b.languageId
    && a.documentRevision === b.documentRevision
    && a.lspSessionGeneration === b.lspSessionGeneration;
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
    const choice = rest.match(/^\$\{(\d+)\|([^|,}]*)[^|}]*\|\}/);
    if (choice) {
      out += `\${${choice[1]}:${choice[2]}}`;
      i += choice[0].length - 1;
      continue;
    }
    const placeholder = rest.match(/^\$\{(\d+):([^{}]*)\}/);
    if (placeholder) {
      out += `\${${placeholder[1]}:${placeholder[2]}}`;
      i += placeholder[0].length - 1;
      continue;
    }
    const tabstop = rest.match(/^\$\{(\d+)\}/) ?? rest.match(/^\$(\d+)/);
    if (tabstop) {
      out += `\${${tabstop[1]}}`;
      i += tabstop[0].length - 1;
      continue;
    }
    // Literal dollar; escape it when `${` would otherwise start a field.
    out += text[i + 1] === "{" ? "\\$" : "$";
  }
  return out;
}

/**
 * Flatten an LSP snippet into the literal text to insert plus placeholder
 * spans (defaults inlined, full [start,end) extents) so snippet + import
 * edits can be committed in a single transaction instead of the
 * helper-command double dispatch. Bare `$1`/`${1}` tabstops stay zero-width.
 */
export function parseLspSnippet(
  text: string,
): { text: string; placeholders: Array<{ start: number; end: number }> } {
  let out = "";
  const placeholders: Array<{ start: number }> = [];
  let placeholderEnds: Array<number> = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "\\" || next === "$" || next === "}") {
        out += next;
        i += 1;
        continue;
      }
      out += char;
      continue;
    }
    if (char !== "$") {
      out += char;
      continue;
    }
    const rest = text.slice(i);
    // Choice default is the FIRST option; the option list itself never
    // becomes literal text.
    const choice = rest.match(/^\$\{(\d+)\|([^|,}]*)[^|}]*\|\}/);
    const placeholder = rest.match(/^\$\{(\d+):((?:[^{}]|\{\d+:?[^{}]*\})*)\}/);
    const bare = rest.match(/^\$\{(\d+)\}/) ?? rest.match(/^\$(\d+)/);
    if (choice || placeholder) {
      const body = (choice ? choice[2] : placeholder![2]) ?? "";
      placeholders.push({ start: out.length });
      placeholderEnds.push(out.length + body.length);
      out += body;
      i += (choice ? choice[0].length : placeholder![0].length) - 1;
      continue;
    }
    if (bare) {
      placeholders.push({ start: out.length });
      placeholderEnds.push(out.length);
      i += bare[0].length - 1;
      continue;
    }
    out += char;
  }
  return {
    text: out,
    placeholders: placeholders.map((entry, index) => ({
      start: entry.start,
      end: placeholderEnds[index] ?? entry.start,
    })),
  };
}

/**
 * Post-acceptance tabstop session for the combined snippet+additional-edits
 * acceptance (§8.17.2 step 2). The document lands in ONE dispatch (one undo,
 * one revision bump); this store only moves the selection between the
 * committed placeholder spans, which never creates history entries.
 */
interface LspSnippetSessionState {
  /** Post-image placeholder spans in document order. */
  spans: Array<{ from: number; to: number }>;
  index: number;
  /** Doc length at commit; any document edit invalidates the session. */
  docLength: number;
}

const lspSnippetSessions = new WeakMap<EditorView, LspSnippetSessionState>();

export function activeLspSnippetSession(view: EditorView): boolean {
  return lspSnippetSessions.has(view);
}

/** Move the selection to the next placeholder span; false when exhausted. */
export function advanceLspSnippetTabstop(view: EditorView): boolean {
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) {
    lspSnippetSessions.delete(view);
    return false;
  }
  const nextIndex = session.index + 1;
  if (nextIndex >= session.spans.length) {
    lspSnippetSessions.delete(view);
    return false;
  }
  session.index = nextIndex;
  const span = session.spans[nextIndex];
  view.dispatch({
    selection: view.state.doc.length === session.docLength
      ? { anchor: Math.min(span.from, view.state.doc.length), head: Math.min(span.to, view.state.doc.length) }
      : { anchor: span.from },
    scrollIntoView: true,
  });
  return true;
}

/** Clear the active tabstop session (Escape semantics). */
export function cancelLspSnippetSession(view: EditorView): boolean {
  return lspSnippetSessions.delete(view);
}

/**
 * Update-listener fragment hosts must include so any document edit (outside
 * this module's own selection-only advances) drops the pending session
 * instead of navigating stale spans.
 */
export function lspSnippetSessionInvalidator(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (!lspSnippetSessions.has(update.view)) return;
    // Selection-only advances dispatched by advanceLspSnippetTabstop do not
    // change the doc; any other doc change ends the session.
    lspSnippetSessions.delete(update.view);
  });
}

interface PlannedChange {
  from: number;
  to: number;
  insert: string;
}

function strictOffsetFromLspPosition(doc: Text, position: LspPosition): number | null {
  if (
    !Number.isInteger(position.line)
    || !Number.isInteger(position.character)
    || position.line < 0
    || position.character < 0
    || position.line >= doc.lines
  ) {
    return null;
  }
  const line = doc.line(position.line + 1);
  if (position.character > line.length) return null;
  return line.from + position.character;
}

/**
 * Post-image offset of a point inside the primary insert, shifted by any
 * additional edits (e.g. an import) that landed before the primary span.
 * `offsetWithinInsert` may equal `insert.length` for the cursor-at-end case.
 */
function postImageAnchor(
  changes: PlannedChange[],
  primary: PlannedChange,
  offsetWithinInsert: number,
): number {
  let delta = 0;
  for (const change of changes) {
    if (change === primary) continue;
    if (change.to <= primary.from) {
      delta += change.insert.length - (change.to - change.from);
    }
  }
  return primary.from + offsetWithinInsert + delta;
}

interface PlanningChanges {
  list: PlannedChange[];
  ok: boolean;
}

/**
 * Validate additional edits against the primary span: ranges must be inside
 * the document, well-ordered and non-overlapping. Overlapping or illegal
 * ranges never partially apply: the entire completion is rejected and the
 * invalid-additional-edits diagnostic is reported.
 */
function planCompletionChanges(
  view: EditorView,
  primary: PlannedChange,
  additionalEdits: LspTextEdit[],
): PlanningChanges {
  const list: PlannedChange[] = [primary];
  let ok = true;
  const spans: Array<[number, number]> = [[primary.from, primary.to]];
  for (const edit of additionalEdits) {
    const from = strictOffsetFromLspPosition(view.state.doc, edit.range.start);
    const to = strictOffsetFromLspPosition(view.state.doc, edit.range.end);
    if (from === null || to === null || from > to) {
      ok = false;
      break;
    }
    if (spans.some(([start, end]) => (
      from === to
        ? (start === end ? from === start : from >= start && from <= end)
        : (start === end ? start >= from && start <= to : from < end && to > start)
    ))) {
      ok = false;
      break;
    }
    spans.push([from, to]);
    list.push({ from, to, insert: edit.newText });
  }
  list.sort((a, b) => a.from - b.from || a.to - b.to);
  return { list: ok ? list : [primary], ok };
}

function commitLspCompletion(
  view: EditorView,
  item: LspCompletionItem,
  from: number,
  to: number,
  token: CompletionRequestToken,
  isStillCurrent: (token: CompletionRequestToken) => boolean,
  reportDiagnostic: ((kind: CompletionAcceptanceDiagnostic, detail?: string) => void) | undefined,
): boolean {
  if (!isStillCurrent(token)) {
    reportDiagnostic?.("identity-mismatch", "accept");
    recordCompletionTelemetry(token, "stale", { reason: "accept" });
    return false;
  }
  if (
    !Number.isInteger(from)
    || !Number.isInteger(to)
    || from < 0
    || to < from
    || to > view.state.doc.length
  ) {
    reportDiagnostic?.("invalid-additional-edits", "primary-range");
    return false;
  }

  let replaceFrom = from;
  let replaceTo = to;
  if (item.textEdit) {
    const strictFrom = strictOffsetFromLspPosition(view.state.doc, item.textEdit.range.start);
    const strictTo = strictOffsetFromLspPosition(view.state.doc, item.textEdit.range.end);
    if (strictFrom === null || strictTo === null || strictFrom > strictTo) {
      reportDiagnostic?.("invalid-additional-edits", "primary-range");
      return false;
    }
    replaceFrom = strictFrom;
    replaceTo = strictTo;
  }

  const rawInsert = item.textEdit?.newText ?? item.insertText ?? item.label;
  const additionalEdits = item.additionalTextEdits ?? [];
  const isSnippet = item.insertTextFormat === 2;
  if (isSnippet && additionalEdits.length === 0) {
    snippet(lspSnippetToCmSnippet(rawInsert))(view, null, replaceFrom, replaceTo);
    recordCompletionTelemetry(token, "applied");
    return true;
  }

  const parsed = isSnippet ? parseLspSnippet(rawInsert) : null;
  const insert = parsed ? parsed.text : rawInsert;
  const planned = planCompletionChanges(
    view,
    { from: replaceFrom, to: replaceTo, insert },
    additionalEdits,
  );
  if (!planned.ok) {
    reportDiagnostic?.("invalid-additional-edits");
    return false;
  }

  const primaryChange = planned.list.find((change) => (
    change.insert === insert && change.from === replaceFrom && change.to === replaceTo
  )) ?? planned.list[0];

  // One dispatch carries primary, snippet body and additional edits: one
  // document revision, one Ctrl+Z, no second edit (§8.17.2 step 2/4).
  const placeholderSpans = parsed && parsed.placeholders.length > 0
    ? parsed.placeholders.map((span) => ({
      from: postImageAnchor(planned.list, primaryChange, span.start),
      to: postImageAnchor(planned.list, primaryChange, Math.max(span.end, span.start)),
    }))
    : null;
  const firstSpan = placeholderSpans?.[0];
  const firstPlaceholderStart = parsed?.placeholders[0]?.start;
  const anchor = parsed && parsed.placeholders.length > 0 && firstPlaceholderStart !== undefined
    ? postImageAnchor(planned.list, primaryChange, firstPlaceholderStart)
    : postImageAnchor(planned.list, primaryChange, insert.length);

  view.dispatch({
    changes: planned.list,
    selection: firstSpan
      ? { anchor: firstSpan.from, head: firstSpan.to }
      : { anchor },
    userEvent: "input.complete",
  });
  recordCompletionTelemetry(token, "applied");

  // Registered AFTER the acceptance dispatch so the doc-change invalidator
  // never consumes the acceptance itself; Tab now cycles the spans and any
  // unrelated edit drops the session.
  if (placeholderSpans && placeholderSpans.length > 0) {
    lspSnippetSessions.set(view, {
      spans: placeholderSpans,
      index: 0,
      docLength: view.state.doc.length,
    });
  }
  return true;
}

const RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS = 3000;

type CompletionItemResolver = () => Promise<LspCompletionItem | null>;

function applyLspCompletion(
  view: EditorView,
  item: LspCompletionItem,
  from: number,
  to: number,
  resolve: CompletionItemResolver | undefined,
  token: CompletionRequestToken,
  isStillCurrent: (token: CompletionRequestToken) => boolean,
  getDocumentRevision: (() => number) | undefined,
  reportDiagnostic: ((kind: CompletionAcceptanceDiagnostic, detail?: string) => void) | undefined,
): void {
  if (item.additionalTextEdits?.length || !resolve) {
    commitLspCompletion(view, item, from, to, token, isStillCurrent, reportDiagnostic);
    return;
  }

  const revisionAtAccept = getDocumentRevision?.();
  const docAtAccept = view.state.doc;
  let timeoutId: number | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolveTimeout) => {
    timeoutId = window.setTimeout(
      () => resolveTimeout({ kind: "timeout" }),
      RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS,
    );
  });
  void Promise.race([
    resolve().then((resolved) => ({ kind: "resolved" as const, resolved })),
    timeout,
  ])
    .then((outcome) => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (!isStillCurrent(token)) {
        reportDiagnostic?.("identity-mismatch", "resolve");
        return;
      }
      if (
        view.state.doc !== docAtAccept
        || (getDocumentRevision && revisionAtAccept !== undefined && getDocumentRevision() !== revisionAtAccept)
      ) {
        reportDiagnostic?.("additional-edit-unavailable", "revision-changed");
        return;
      }
      if (outcome.kind === "timeout") {
        reportDiagnostic?.("additional-edit-unavailable", "resolve-timeout");
        commitLspCompletion(view, item, from, to, token, isStillCurrent, reportDiagnostic);
        return;
      }
      const resolved = outcome.resolved;
      if (!resolved) {
        reportDiagnostic?.("additional-edit-unavailable", "resolve-empty");
        commitLspCompletion(view, item, from, to, token, isStillCurrent, reportDiagnostic);
        return;
      }
      commitLspCompletion(
        view,
        {
          ...item,
          ...resolved,
          additionalTextEdits: resolved.additionalTextEdits ?? item.additionalTextEdits,
        },
        from,
        to,
        token,
        isStillCurrent,
        reportDiagnostic,
      );
    })
    .catch(() => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (!isStillCurrent(token) || view.state.doc !== docAtAccept) {
        reportDiagnostic?.("identity-mismatch", "resolve");
        return;
      }
      reportDiagnostic?.("additional-edit-unavailable", "resolve-failed");
      commitLspCompletion(view, item, from, to, token, isStillCurrent, reportDiagnostic);
    });
}

async function completionInfo(
  item: LspCompletionItem,
  resolve: CompletionItemResolver | undefined,
  token: CompletionRequestToken,
  isStillCurrent: (token: CompletionRequestToken) => boolean,
): Promise<Node | null> {
  let documentation = item.documentation;
  let detail = item.detail;
  if (!documentation && resolve) {
    try {
      // Resolve may only run while the request identity still matches the
      // live buffer; stale popup docs from a previous file/session are
      // dropped instead of rendered.
      if (!isStillCurrent(token)) {
        if (!detail) return null;
        documentation = null;
      } else {
        const resolved = await resolve();
        if (!isStillCurrent(token)) return null;
        documentation = resolved?.documentation ?? null;
        detail = detail ?? resolved?.detail ?? null;
      }
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
  const isStillCurrent = (token: CompletionRequestToken): boolean => {
    const identity = hooks.identity();
    if (!identity) return false;
    if (!sameCompletionIdentity(identity, token)) return false;
    const revision = hooks.getDocumentRevision?.();
    if (revision !== undefined && revision !== token.documentRevision) return false;
    return true;
  };

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

    // Identity is captured at request start; a request without provable
    // identity is typed unavailable and falls back to buffer words.
    const identityAtStart = hooks.identity();
    if (!identityAtStart) return completeAnyWord(context);
    completionRequestIdCounter += 1;
    const token: CompletionRequestToken = {
      ...identityAtStart,
      requestId: `completion-${completionRequestIdCounter}`,
    };
    completionRequestStartedAt.set(token, performance.now());
    recordCompletionTelemetry(token, "fetching");

    // LSP responses are tied to a document version. Do not spend renderer time
    // mapping a response that became stale while the user kept typing.
    context.addEventListener("abort", () => {}, { onDocChange: true });

    // For plain non-trigger typing (e.g. typing identifiers in Java without `.` or `:`),
    // settle briefly so rapid typing does not spam heavy LSP queries on every keystroke.
    if (!context.explicit && !triggerOnly && !afterTrigger) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 120);
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
        token,
      );
    } catch {
      result = null;
    }
    if (context.aborted) return null;
    // Validate the request identity again after the await: file switch,
    // document revision change or session restart invalidates the response.
    if (!isStillCurrent(token)) {
      recordCompletionTelemetry(token, "stale", { reason: "identity-changed-after-fetch" });
      return completeAnyWord(context);
    }
    if (result === null) {
      recordCompletionTelemetry(token, "failed", { reason: "fetch-failed" });
      return completeAnyWord(context);
    }
    // Inactive/unavailable provider is unavailable regardless of item count:
    // stale non-empty items from a stopped/restarted session must never enter
    // the popup (§8.16.2 containment).
    if (!result.status.active) {
      recordCompletionTelemetry(token, "unavailable", { reason: "provider-inactive" });
      return completeAnyWord(context);
    }
    if (result.items.length === 0) {
      recordCompletionTelemetry(token, "popup", { itemCount: 0 });
      return null;
    }

    if (result.truncated) {
      hooks.reportDiagnostic?.("truncated", `${result.items.length}+`);
    }

    const typed = word ? word.text : "";
    const rawItems = result.items;
    const mapped: Completion[] = [];
    const mappedItems: LspCompletionItem[] = [];
    // The server response is already relevance ordered. Mapping more entries
    // than the popup can consume only allocates closures/documentation helpers
    // on the renderer thread, which is especially visible for jdtls lists.
    const maxItemsToProcess = Math.min(rawItems.length, MAX_COMPLETION_OPTIONS);
    for (let i = 0; i < maxItemsToProcess; i += 1) {
      const item = rawItems[i];
      if (!item) continue;
      const filterText = item.filterText?.trim() ? item.filterText : null;
      const label = filterText ?? item.label;
      const boost = boostFromTypedPrefix(typed, label, item.sortText);
      const displayLabel = filterText && filterText !== item.label ? item.label : undefined;
      const truncatedDetail = result.truncated && i === 0
        ? `${item.detail ?? ""}${item.detail ? " · " : ""}list truncated — keep typing to refine`.trim()
        : item.detail ?? undefined;
      let resolvedItemPromise: Promise<LspCompletionItem | null> | null = null;
      const resolveItem: CompletionItemResolver | undefined = hooks.resolve
        ? () => {
            if (!resolvedItemPromise) {
              resolvedItemPromise = hooks.resolve!(item.raw, token);
            }
            return resolvedItemPromise;
          }
        : undefined;
      mapped.push({
        label,
        displayLabel,
        sortText: item.sortText ?? undefined,
        boost,
        type: completionKindToType(item.kind),
        detail: truncatedDetail,
        info: item.documentation || resolveItem
          ? () => completionInfo(item, resolveItem, token, isStillCurrent)
          : undefined,
        apply: (view, _completion, from, to) =>
          applyLspCompletion(
            view,
            item,
            from,
            to,
            resolveItem,
            token,
            isStillCurrent,
            hooks.getDocumentRevision,
            hooks.reportDiagnostic,
          ),
      });
      mappedItems.push(item);
    }
    if (context.aborted) return null;

    // Prefer textEdit start when every item shares the same replace range so
    // CM's client-side filtering aligns with the server's replace span.
    let from = word ? word.from : context.pos;
    const firstEdit = mappedItems[0]?.textEdit;
    if (firstEdit && mappedItems.every((item) => (
      item.textEdit
      && item.textEdit.range.start.line === firstEdit.range.start.line
      && item.textEdit.range.start.character === firstEdit.range.start.character
      && item.textEdit.range.end.line === firstEdit.range.end.line
      && item.textEdit.range.end.character === firstEdit.range.end.character
    ))) {
      from = offsetFromLspPosition(context.state.doc, firstEdit.range.start);
    }

    // Keep server order for the head of the list, then cap for popup cost.
    recordCompletionTelemetry(token, "popup", {
      itemCount: mapped.length,
      truncated: result.truncated ?? false,
    });
    return {
      from,
      options: mapped,
      // Incomplete lists should re-query on further typing (no sticky validFor).
      // Complete lists stay open while the user continues the identifier.
      // Always filter client-side for camelCase/prefix quality on the cap —
      // incomplete lists still re-query because validFor is unset.
      filter: true,
      validFor: result.isIncomplete ? undefined : /^[\w$@]*$/,
    };
  };
}

/**
 * Fixture-only source (unit tests, perf benches). Wraps the legacy
 * no-identity hooks with a synthetic identity so mapping logic can be
 * exercised without a production host. Production code must never import
 * this helper.
 */
export function createFixtureCompletionSource(hooks: FixtureCompletionHooks): CompletionSource {
  const identity: CompletionRequestIdentity = {
    workspaceId: "fixture-workspace",
    fileKey: "fixture-file",
    filePath: "/fixture/file.ts",
    uri: "file:///fixture/file.ts",
    languageId: "fixture",
    documentRevision: 0,
    lspSessionGeneration: 0,
  };
  return createLspCompletionSource({
    identity: () => ({
      ...identity,
      documentRevision: hooks.getDocumentRevision?.() ?? identity.documentRevision,
    }),
    fetch: (position, triggerCharacter) => hooks.fetch(position, triggerCharacter),
    resolve: hooks.resolve
      ? (raw) => hooks.resolve!(raw)
      : undefined,
    triggerCharacters: () => hooks.triggerCharacters?.() ?? [],
    getDocumentRevision: hooks.getDocumentRevision ?? (() => identity.documentRevision),
    reportDiagnostic: hooks.reportDiagnostic ?? (() => {}),
  });
}
