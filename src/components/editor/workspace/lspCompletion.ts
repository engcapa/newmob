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
import {
  type BasicCompletionPolicyV2,
  type CompletionCaseMatching,
  type CompletionSortMode,
  type SymbolPatternRule,
  type WorkspaceCompletionPreferences,
  toBasicCompletionPolicyV2,
} from "./intelligencePreferences";

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
  | "identity-mismatch"
  | "excluded-symbol-blocked"
  | "auto-inserted-single";

export interface LspCompletionHooks {
  /** Live file/session identity; null means "no provable identity". */
  identity: () => CompletionRequestIdentity | null;
  fetch: (
    position: LspPosition,
    triggerCharacter: string | null,
    token: CompletionRequestToken,
    /** Repeated-call facts (§8.19.4); ordinal ≥ 2 requests expanded scope. */
    invocation?: CompletionInvocationRequest,
  ) => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown, token: CompletionRequestToken) => Promise<LspCompletionItem | null>;
  triggerCharacters: () => string[];
  getDocumentRevision: () => number;
  /**
   * Whether the provider advertises a scope-expansion channel for repeated
   * Basic calls. Standard LSP has none, so hosts omit this and every
   * expanded request is recorded honestly as providerScope:"unchanged".
   */
  advertisesScopeExpansion?: () => boolean;
  /** Observable acceptance diagnostics for status/QA surfaces. */
  reportDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  /**
   * Resolve gate surface (§8.19.4). When wired, a resolve timeout/failure
   * presents Retry / Insert-without-import instead of inserting anything.
   * Hosts without a gate surface get the block-only behaviour: nothing is
   * inserted and the diagnostic reports the unavailable import.
   */
  onResolveGate?: (request: CompletionResolveGateRequest) => void;
  controller?: LspCompletionController;
  getView?: () => EditorView | null;
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
  lastBasicInvocation.clear();
  completionInvocationRing.length = 0;
}

// ---------------------------------------------------------------------------
// §8.19.4 Basic invocation modes + repeated-invocation evidence
// ---------------------------------------------------------------------------

export type CompletionInvocationReason = "typing" | "trigger" | "explicit";

/**
 * Per-invocation facts the provider adapter receives and QA surfaces read
 * (§8.19.4). `requestedScope:"expanded"` marks a repeated explicit Basic call;
 * `providerScope` records what the provider actually did — LSP has no standard
 * expansion channel, so an unadvertised expansion stays honestly "unchanged"
 * instead of inheriting the requested scope.
 */
export interface CompletionInvocationEvidence {
  invocationOrdinal: number;
  requestedScope: "default" | "expanded";
  providerScope: "expanded" | "unchanged" | "unknown";
  itemCount: number;
  isIncomplete: boolean;
}

/** Facts handed to the fetch hook so they can travel to the backend. */
export interface CompletionInvocationRequest {
  invocationOrdinal: number;
  requestedScope: "default" | "expanded";
}

/** One recorded invocation in the bounded evidence ring. */
export interface RecordedCompletionInvocation extends CompletionInvocationEvidence {
  requestId: string;
  workspaceId: string;
  fileKey: string;
  languageId: string;
  documentRevision: number;
  providerGeneration: number;
  reason: CompletionInvocationReason;
  at: number;
}

interface LastBasicInvocation {
  revision: number;
  positionKey: string;
  providerGeneration: number;
  ordinal: number;
}

const lastBasicInvocation = new Map<string, LastBasicInvocation>();
const completionInvocationRing: RecordedCompletionInvocation[] = [];
const COMPLETION_INVOCATION_RING_MAX = 50;

/**
 * Record one Basic invocation and return its ordinal (§8.18.3 / §8.19.4).
 * Only EXPLICIT invocations advance the repeated-call counter — typing or
 * trigger-char popups inherit the live sequence without bumping it. Any edit
 * (revision change), caret move (position change) or provider restart
 * (generation change) resets the next explicit call back to ordinal 1.
 */
export function recordBasicCompletionInvocation(input: {
  workspaceId: string;
  fileKey: string;
  documentRevision: number;
  /** Approximate caret identity; callers pass `${line}:${character}`. */
  positionKey: string;
  reason: CompletionInvocationReason;
  providerGeneration?: number;
}): number {
  const key = `${input.workspaceId} ${input.fileKey}`;
  const previous = lastBasicInvocation.get(key);
  const generation = input.providerGeneration ?? previous?.providerGeneration ?? 0;
  const sameIdentity = !!previous
    && previous.revision === input.documentRevision
    && previous.positionKey === input.positionKey
    && previous.providerGeneration === generation;
  if (input.reason !== "explicit") {
    return sameIdentity ? previous!.ordinal : 1;
  }
  if (sameIdentity) {
    const ordinal = previous!.ordinal + 1;
    lastBasicInvocation.set(key, {
      revision: input.documentRevision,
      positionKey: input.positionKey,
      providerGeneration: generation,
      ordinal,
    });
    return ordinal;
  }
  lastBasicInvocation.set(key, {
    revision: input.documentRevision,
    positionKey: input.positionKey,
    providerGeneration: generation,
    ordinal: 1,
  });
  return 1;
}

/**
 * Popup closed: the repeated-call sequence ends, so the next explicit call is
 * a fresh ordinal-1 Basic request even at the same revision + position.
 */
export function resetBasicCompletionSession(workspaceId: string, fileKey: string): void {
  lastBasicInvocation.delete(`${workspaceId} ${fileKey}`);
}

/** What the provider did with a requested scope expansion. */
export function providerScopeFor(
  requestedScope: "default" | "expanded",
  providerAdvertisesExpansion: boolean,
): CompletionInvocationEvidence["providerScope"] {
  if (requestedScope !== "expanded") return "unknown";
  return providerAdvertisesExpansion ? "expanded" : "unchanged";
}

function recordCompletionInvocationEvidence(entry: RecordedCompletionInvocation): void {
  completionInvocationRing.push(entry);
  if (completionInvocationRing.length > COMPLETION_INVOCATION_RING_MAX) {
    completionInvocationRing.splice(0, completionInvocationRing.length - COMPLETION_INVOCATION_RING_MAX);
  }
}

/** Snapshot of recent invocation evidence (oldest first); copy, not live. */
export function recentCompletionInvocations(): readonly RecordedCompletionInvocation[] {
  return [...completionInvocationRing];
}

// ---------------------------------------------------------------------------
// §8.19.4 typed resolve state + acceptance plan (R3)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one item's completionItem/resolve round-trip (§8.19.4).
 * `timed-out` / `failed` never fall through to a silent primary-only insert:
 * they surface the resolve gate and wait for an explicit user choice.
 */
/**
 * Lifecycle of one item's completionItem/resolve round-trip (§8.19.4 / §ED-COMP-001).
 * `timed-out` / `failed` / `unavailable` never fall through to a silent primary-only insert:
 * they surface the resolve gate and wait for an explicit user choice.
 */
export type CompletionResolveState =
  | { kind: "not-required" }
  | { kind: "ready"; resolvedAt: number; hasAdditionalEdits: boolean }
  | { kind: "timed-out"; canRetry: true }
  | { kind: "failed"; canRetry: true; message: string }
  | { kind: "unavailable"; canRetry: boolean; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "stale" };

/**
 * 7 typed completion resolve outcome kinds (§ED-COMP-001 / BB7):
 * - resolved: provider delivered full item + additionalTextEdits
 * - not-required: item already contained complete additional edits without resolve
 * - unavailable: resolver is missing / returned null (resolver 缺失不推导 not-required)
 * - timeout: resolve timed out
 * - failed: resolver threw an error
 * - cancelled: resolve was aborted / cancelled
 * - stale: request token identity or doc revision changed during resolve
 */
export type CompletionResolveOutcomeKind =
  | "resolved"
  | "not-required"
  | "unavailable"
  | "timeout"
  | "failed"
  | "cancelled"
  | "stale";

export type CompletionResolveOutcome =
  | { kind: "resolved"; item: LspCompletionItem; edits: readonly LspTextEdit[] }
  | { kind: "not-required"; item: LspCompletionItem }
  | { kind: "unavailable"; reason: string; item: LspCompletionItem }
  | { kind: "timeout"; durationMs: number; item: LspCompletionItem }
  | { kind: "failed"; error: string; item: LspCompletionItem }
  | { kind: "cancelled"; reason: string; item: LspCompletionItem }
  | { kind: "stale"; expectedRevision: number; currentRevision: number; item: LspCompletionItem };

export interface ClassifyCompletionResolveInput {
  item: LspCompletionItem;
  resolvedItem?: LspCompletionItem | null;
  error?: unknown;
  timedOut?: boolean;
  cancelled?: boolean;
  hasResolver: boolean;
  isStale?: boolean;
  tokenRevision?: number;
  currentRevision?: number;
}

/**
 * Pure classification of completion resolve outcomes (§ED-COMP-001).
 * Enforces rule: "resolver 缺失不推导 not-required".
 */
export function classifyCompletionResolveOutcome(
  input: ClassifyCompletionResolveInput,
): CompletionResolveOutcome {
  const { item } = input;
  if (input.cancelled) {
    return { kind: "cancelled", reason: "operation-cancelled", item };
  }
  if (input.isStale) {
    return {
      kind: "stale",
      expectedRevision: input.tokenRevision ?? 0,
      currentRevision: input.currentRevision ?? -1,
      item,
    };
  }
  if (input.timedOut) {
    return { kind: "timeout", durationMs: RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS, item };
  }
  if (input.error !== undefined && input.error !== null) {
    const errorMsg = input.error instanceof Error ? input.error.message : String(input.error);
    return { kind: "failed", error: errorMsg, item };
  }
  if (input.resolvedItem) {
    return {
      kind: "resolved",
      item: input.resolvedItem,
      edits: input.resolvedItem.additionalTextEdits ?? [],
    };
  }
  if (item.additionalTextEdits && item.additionalTextEdits.length > 0) {
    return { kind: "not-required", item };
  }
  if (!input.hasResolver) {
    // ED-COMP-001: resolver 缺失不推导 not-required
    return { kind: "unavailable", reason: "missing-resolver", item };
  }
  return { kind: "unavailable", reason: "resolver-returned-null", item };
}

export interface ExecuteCompletionResolveOptions {
  item: LspCompletionItem;
  resolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
  token: CompletionRequestToken;
  isStillCurrent: (token: CompletionRequestToken) => boolean;
  timeoutMs?: number;
  getDocumentRevision?: () => number;
  signal?: AbortSignal;
}

/**
 * Executes an LSP item resolve with full typed outcome classification (§ED-COMP-001).
 */
export async function executeCompletionResolve(
  options: ExecuteCompletionResolveOptions,
): Promise<CompletionResolveOutcome> {
  const {
    item,
    resolve,
    token,
    isStillCurrent,
    timeoutMs = RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS,
    getDocumentRevision,
    signal,
  } = options;

  if (signal?.aborted) {
    return classifyCompletionResolveOutcome({ item, hasResolver: !!resolve, cancelled: true });
  }
  if (!isStillCurrent(token)) {
    return classifyCompletionResolveOutcome({
      item,
      hasResolver: !!resolve,
      isStale: true,
      tokenRevision: token.documentRevision,
      currentRevision: getDocumentRevision?.(),
    });
  }
  if (item.additionalTextEdits && item.additionalTextEdits.length > 0 && !resolve) {
    return classifyCompletionResolveOutcome({ item, hasResolver: false });
  }
  if (!resolve) {
    return classifyCompletionResolveOutcome({ item, hasResolver: false });
  }

  const startRevision = getDocumentRevision?.() ?? token.documentRevision;
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<{ timeout: true }>((res) => {
    timeoutId = window.setTimeout(() => res({ timeout: true }), timeoutMs);
  });

  const abortPromise = signal
    ? new Promise<{ aborted: true }>((res) => {
        signal.addEventListener("abort", () => res({ aborted: true }), { once: true });
      })
    : null;

  try {
    const rawToResolve = item.raw ?? item;
    const raceCompetitors: Promise<unknown>[] = [
      resolve(rawToResolve),
      timeoutPromise,
    ];
    if (abortPromise) raceCompetitors.push(abortPromise);

    const raceResult = await Promise.race(raceCompetitors);
    if (timeoutId !== null) window.clearTimeout(timeoutId);

    if (signal?.aborted || (typeof raceResult === "object" && raceResult !== null && "aborted" in raceResult)) {
      return classifyCompletionResolveOutcome({ item, hasResolver: true, cancelled: true });
    }
    if (typeof raceResult === "object" && raceResult !== null && "timeout" in raceResult) {
      return classifyCompletionResolveOutcome({ item, hasResolver: true, timedOut: true });
    }

    if (!isStillCurrent(token)) {
      return classifyCompletionResolveOutcome({
        item,
        hasResolver: true,
        isStale: true,
        tokenRevision: token.documentRevision,
        currentRevision: getDocumentRevision?.(),
      });
    }
    if (getDocumentRevision && getDocumentRevision() !== startRevision) {
      return classifyCompletionResolveOutcome({
        item,
        hasResolver: true,
        isStale: true,
        tokenRevision: startRevision,
        currentRevision: getDocumentRevision(),
      });
    }

    const resolved = raceResult as LspCompletionItem | null;
    if (!resolved) {
      return classifyCompletionResolveOutcome({ item, hasResolver: true, resolvedItem: null });
    }

    const mergedItem: LspCompletionItem = {
      ...item,
      ...resolved,
      additionalTextEdits: resolved.additionalTextEdits ?? item.additionalTextEdits,
    };

    return classifyCompletionResolveOutcome({
      item,
      hasResolver: true,
      resolvedItem: mergedItem,
    });
  } catch (err) {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (!isStillCurrent(token)) {
      return classifyCompletionResolveOutcome({
        item,
        hasResolver: true,
        isStale: true,
        tokenRevision: token.documentRevision,
        currentRevision: getDocumentRevision?.(),
      });
    }
    return classifyCompletionResolveOutcome({ item, hasResolver: true, error: err });
  }
}

/** Stable-enough identity for QA surfaces; providers rarely send item ids. */
export function completionItemId(item: LspCompletionItem): string {
  return [item.label, item.kind ?? "", item.sortText ?? ""].join("#");
}

export interface CompletionAcceptancePlanV2 {
  identity: CompletionRequestIdentity;
  itemId: string;
  primary: LspTextEdit;
  additional: readonly LspTextEdit[];
  /** Parsed placeholder spans when the primary is a snippet; null otherwise. */
  snippet: ReturnType<typeof parseLspSnippet>["placeholders"] | null;
  resolve: CompletionResolveState;
  disposition:
    | "ready"
    | "needs-explicit-primary-only"
    | "blocked-stale"
    | "blocked-overlap";
}

/**
 * Pure acceptance classifier (§8.19.4): given the item and its resolve state,
 * decide whether the merged acceptance may commit, must wait for an explicit
 * "insert without import" choice, or is blocked outright.
 */
export function buildCompletionAcceptancePlanV2(input: {
  identity: CompletionRequestIdentity;
  item: LspCompletionItem;
  resolveState: CompletionResolveState;
  /** Set when the range planner rejected provider edits as overlapping/illegal. */
  overlapRejected?: boolean;
}): CompletionAcceptancePlanV2 {
  const rawInsert = input.item.textEdit
    ? input.item.textEdit.newText
    : (input.item.insertText ?? input.item.label);
  const snippet = input.item.insertTextFormat === 2 ? parseLspSnippet(rawInsert).placeholders : null;
  const additional = input.item.additionalTextEdits ?? [];
  const disposition: CompletionAcceptancePlanV2["disposition"] = input.overlapRejected
    ? "blocked-overlap"
    : input.resolveState.kind === "stale" || input.resolveState.kind === "cancelled"
      ? "blocked-stale"
      : input.resolveState.kind === "timed-out" || input.resolveState.kind === "failed" || input.resolveState.kind === "unavailable"
        ? "needs-explicit-primary-only"
        : "ready";
  return {
    identity: input.identity,
    itemId: completionItemId(input.item),
    primary: input.item.textEdit ?? {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      newText: rawInsert,
    },
    additional,
    snippet,
    resolve: input.resolveState,
    disposition,
  };
}

/** Why the resolve gate opened; all mean the import edits are unavailable. */
export type CompletionResolveGateReason = "timeout" | "failed" | "unavailable";

/**
 * Handed to the host UI when an acceptance needs its import/additional edits
 * but the provider resolve did not deliver them in time (§8.19.4). The gate
 * keeps the item visible with Retry / Insert-without-import choices; nothing
 * is inserted until the user picks one.
 */
export interface CompletionResolveGateRequest {
  item: LspCompletionItem;
  range: { from: number; to: number };
  reason: CompletionResolveGateReason;
  message: string;
  /**
   * Fresh resolve attempt (bypasses the info-panel cache). Resolves to
   * `"committed"` when the merged acceptance landed in one dispatch, or
   * `"unavailable"` when the retry also failed to produce usable import
   * edits — the gate stays open in that case.
   */
  retry(): Promise<"committed" | "unavailable">;
  /** User chose primary-only insertion: one dispatch, no import edits. */
  insertWithoutImport(): boolean;
  /** Close the banner without inserting anything. */
  dismiss(): void;
}

// ---------------------------------------------------------------------------
// §8.18.3 typed provider result envelope + capability evidence
// ---------------------------------------------------------------------------
export type CapabilityLevel = "unavailable" | "available-partial" | "available-complete";
export type CompletionUnavailableReason =
  | "no-provider" | "capability-not-advertised" | "provider-starting"
  | "indexing" | "unsupported-language" | "stale" | "cancelled" | "disposed" | "unknown";

export interface CompletionCapabilityEvidence {
  source: "lsp" | "jdtls";
  providerId: string | null;
  providerVersion: string | null;
  workspaceId: string;
  fileKey: string;
  documentRevision: number;
  providerGeneration: number;
  scope: "file";
  completeness: CapabilityLevel;
  unavailableReason?: CompletionUnavailableReason;
}

export type CompletionProviderResult =
  | { kind: "available"; identity: CompletionRequestIdentity; items: LspCompletionItem[];
      isIncomplete: boolean; truncated: boolean; evidence: CompletionCapabilityEvidence }
  | { kind: "unavailable"; identity: CompletionRequestIdentity; reason: CompletionUnavailableReason }
  | { kind: "stale" | "cancelled"; identity: CompletionRequestIdentity }
  | { kind: "failed"; identity: CompletionRequestIdentity; retryable: boolean; message: string };

/**
 * Classify one raw provider round-trip into the typed envelope. UI must read
 * `kind`/`truncated` from here instead of inferring from empty arrays.
 */
export function toCompletionProviderResult(input: {
  identity: CompletionRequestIdentity;
  result: LspCompletionResult | null;
  statusActive: boolean;
  capabilityAdvertised: boolean;
}): CompletionProviderResult {
  const { identity, result } = input;
  if (!input.capabilityAdvertised) {
    return {
      kind: "unavailable",
      identity,
      reason: "capability-not-advertised",
    };
  }
  if (!input.statusActive) {
    return { kind: "unavailable", identity, reason: "no-provider" };
  }
  if (!result) {
    // A dropped/null response for an unchanged identity is cancellation-like:
    // never reported as "no candidates".
    return { kind: "stale", identity };
  }
  const items = result.items ?? [];
  return {
    kind: "available",
    identity,
    items: [...items],
    isIncomplete: result.isIncomplete === true,
    truncated: items.length >= MAX_COMPLETION_OPTIONS,
    evidence: {
      source: "lsp",
      providerId: result.status?.selectedCommandId ?? null,
      providerVersion: result.status?.displayName ?? null,
      workspaceId: identity.workspaceId,
      fileKey: identity.fileKey,
      documentRevision: identity.documentRevision,
      providerGeneration: identity.lspSessionGeneration,
      scope: "file",
      completeness: result.isIncomplete ? "available-partial" : "available-complete",
    },
  };
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

export interface CompletionPolicySnapshot {
  revision: number;
  policy: BasicCompletionPolicyV2;
  preferences: WorkspaceCompletionPreferences;
  provenance: Record<string, string>;
}

export class LspCompletionController {
  protected preferences: WorkspaceCompletionPreferences;
  protected revision = 1;
  protected listeners = new Set<(snapshot: CompletionPolicySnapshot) => void>();

  constructor(initialPreferences?: Partial<WorkspaceCompletionPreferences>) {
    this.preferences = {
      autoTrigger: true,
      triggerDelayMs: 50,
      minPrefixLength: 1,
      maxItems: 50,
      showDocumentation: true,
      documentationDelayMs: 250,
      caseMatching: "first-letter",
      sortMode: "provider-relevance",
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
      ...initialPreferences,
    };
  }

  getRevision(): number {
    return this.revision;
  }

  getPreferences(): WorkspaceCompletionPreferences {
    return { ...this.preferences };
  }

  getPolicy(): BasicCompletionPolicyV2 {
    return toBasicCompletionPolicyV2(this.preferences);
  }

  getSnapshot(): CompletionPolicySnapshot {
    return {
      revision: this.revision,
      policy: this.getPolicy(),
      preferences: this.getPreferences(),
      provenance: { source: "workspace-preferences" },
    };
  }

  subscribe(listener: (snapshot: CompletionPolicySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPreferences(next: Partial<WorkspaceCompletionPreferences>): void {
    this.update(next);
  }

  update(next: Partial<WorkspaceCompletionPreferences>): CompletionPolicySnapshot {
    this.preferences = {
      ...this.preferences,
      ...next,
    };
    this.revision += 1;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // Safe listener dispatch
      }
    }
    return snap;
  }

  shouldAutoTrigger(prefixLength: number, explicit: boolean): boolean {
    if (explicit) return true;
    if (!this.preferences.autoTrigger) return false;
    return prefixLength >= this.preferences.minPrefixLength;
  }

  getMaxItems(): number {
    return this.preferences.maxItems;
  }

  getTriggerDelayMs(): number {
    return this.preferences.triggerDelayMs;
  }

  getDocumentationDelayMs(): number {
    return this.preferences.documentationDelayMs;
  }

  shouldShowDocumentation(): boolean {
    return this.preferences.showDocumentation;
  }

  getCaseMatching(): CompletionCaseMatching {
    return this.preferences.caseMatching;
  }

  getSortMode(): CompletionSortMode {
    return this.preferences.sortMode;
  }

  getAutoInsertSingle(): boolean {
    return this.preferences.autoInsertSingle;
  }

  getExcludedSymbols(): readonly SymbolPatternRule[] {
    return this.preferences.excludedSymbols;
  }

  getPrioritizedSymbols(): readonly SymbolPatternRule[] {
    return this.preferences.prioritizedSymbols;
  }
}

/**
 * §8.23.6 X5: Canonical Workspace Completion Policy Controller with immutable snapshots,
 * monotonic revisions, and active subscriptions.
 */
export class WorkspaceCompletionPolicyController extends LspCompletionController {}

export type CompletionMatchTier =
  | 1 // Exact match
  | 2 // Prefix match
  | 3 // Word boundary / camelCase match
  | 4 // Subsequence / fuzzy match
  | 5; // No match

export function matchCompletionQuery(label: string, query: string): { tier: CompletionMatchTier; score: number } {
  if (!query) return { tier: 2, score: 0 };
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Tier 1: Exact match
  if (label === query) return { tier: 1, score: 1000 };
  if (lowerLabel === lowerQuery) return { tier: 1, score: 900 };

  // Tier 2: Prefix match
  if (label.startsWith(query)) return { tier: 2, score: 800 - label.length };
  if (lowerLabel.startsWith(lowerQuery)) return { tier: 2, score: 700 - label.length };

  // Tier 3: CamelCase / word boundary match
  const words = label.split(/(?=[A-Z])|[\_\-\.]/g).filter(Boolean);
  const wordPrefixes = words.map((w) => w[0]?.toLowerCase()).join("");
  if (wordPrefixes.startsWith(lowerQuery) || words.some((w) => w.toLowerCase().startsWith(lowerQuery))) {
    return { tier: 3, score: 500 - label.length };
  }

  // Tier 4: Subsequence fuzzy match
  let queryIdx = 0;
  for (let i = 0; i < lowerLabel.length && queryIdx < lowerQuery.length; i++) {
    if (lowerLabel[i] === lowerQuery[queryIdx]) {
      queryIdx++;
    }
  }
  if (queryIdx === lowerQuery.length) {
    return { tier: 4, score: 300 - label.length };
  }

  return { tier: 5, score: 0 };
}

export interface CompletionCandidateIdentity {
  candidateId: string;
  rawResponseIndex: number;
  workspaceId: string;
  fileKey: string;
  documentRevision: number;
  lspSessionGeneration: number;
  policyRevision: number;
}

export interface CompletionCandidatePair {
  identity: CompletionCandidateIdentity;
  rawItem: LspCompletionItem;
  completion: Completion;
  matchTier: CompletionMatchTier;
  matchScore: number;
}

/**
 * Pure comparator for completion candidate pairs (§ED-COMP-002).
 * Rule 1: Match tier is the primary sort key (Tier 1 < Tier 2 < Tier 3 < Tier 4 < Tier 5).
 * Rule 2: If sortMode is alphabetical, compare labels.
 * Rule 3: For provider-relevance within the same tier, strictly preserve provider order (rawResponseIndex).
 */
export function compareCandidatePairs(
  a: CompletionCandidatePair,
  b: CompletionCandidatePair,
  sortMode: CompletionSortMode = "provider-relevance",
): number {
  if (sortMode === "alphabetical") {
    return a.completion.label.localeCompare(b.completion.label);
  }

  // 1. Primary sort key: Match tier
  if (a.matchTier !== b.matchTier) {
    return a.matchTier - b.matchTier;
  }

  // 2. Explicit boost differences (e.g. prioritized symbols)
  const boostA = a.completion.boost ?? 0;
  const boostB = b.completion.boost ?? 0;
  if (boostA !== boostB) {
    return boostB - boostA;
  }

  // 3. Default tie-breaker within same tier: strictly preserve provider order (rawResponseIndex)
  return a.identity.rawResponseIndex - b.identity.rawResponseIndex;
}

export function compareCompletionCandidates(
  a: Completion,
  b: Completion,
  query: string,
  sortMode: CompletionSortMode = "provider-relevance",
): number {
  if (sortMode === "alphabetical") {
    return a.label.localeCompare(b.label);
  }

  const matchA = matchCompletionQuery(a.label, query);
  const matchB = matchCompletionQuery(b.label, query);

  if (matchA.tier !== matchB.tier) {
    return matchA.tier - matchB.tier;
  }

  // Preserve provider order within the same match tier
  return 0;
}

/**
 * §8.21.3 V2-E: Symbol identity extraction for exclusion and prioritization.
 * Uses provider item's FQN/detail/data; never relies solely on unqualified label.
 */
export function symbolIdentityFromItem(item: LspCompletionItem): {
  fqn: string | null;
  detail: string | null;
  label: string;
  hasPackageIdentity: boolean;
} {
  const rawObj = item.raw && typeof item.raw === "object" ? (item.raw as Record<string, unknown>) : null;
  const rawData = rawObj?.data && typeof rawObj.data === "object" ? (rawObj.data as Record<string, unknown>) : null;
  let fqn = (typeof rawData?.fqn === "string" ? rawData.fqn : null)
    ?? (typeof rawData?.symbol === "string" ? rawData.symbol : null);
  const detail = item.detail;
  if (!fqn && detail && detail.includes(".")) {
    const match = detail.match(/([a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)+)/);
    if (match) {
      fqn = match[1];
    }
  }
  const hasPackageIdentity = !!fqn || (!!detail && detail.includes("."));
  return { fqn, detail, label: item.label, hasPackageIdentity };
}

export function matchesSymbolPattern(
  identity: { fqn: string | null; detail: string | null; label: string; hasPackageIdentity: boolean },
  patterns: readonly { pattern: string }[],
): boolean {
  if (!patterns || patterns.length === 0) return false;
  // Identity insufficient: do NOT match on label alone (preventing false exclusion of same-named types)
  if (!identity.hasPackageIdentity) return false;
  const target = identity.fqn ?? identity.detail ?? "";
  return patterns.some((p) => {
    const pat = p.pattern.trim();
    if (!pat) return false;
    if (pat.endsWith(".*")) {
      const prefix = pat.slice(0, -2);
      return target === prefix || target.startsWith(`${prefix}.`);
    }
    if (pat.endsWith("*")) {
      const prefix = pat.slice(0, -1);
      return target.startsWith(prefix);
    }
    return target === pat || target.endsWith(`.${pat}`);
  });
}

export function matchesCaseRule(
  typed: string,
  label: string,
  mode: CompletionCaseMatching,
): boolean {
  if (!typed || !label) return true;
  if (mode === "none") return true;
  if (mode === "all") {
    return label.startsWith(typed);
  }
  if (mode === "first-letter") {
    const typedFirst = typed[0];
    const labelFirst = label[0];
    const isTypedUpper = typedFirst >= "A" && typedFirst <= "Z";
    const isTypedLower = typedFirst >= "a" && typedFirst <= "z";
    const isLabelUpper = labelFirst >= "A" && labelFirst <= "Z";
    const isLabelLower = labelFirst >= "a" && labelFirst <= "z";
    if (isTypedUpper && isLabelLower) return false;
    if (isTypedLower && isLabelUpper) return false;
    return true;
  }
  return true;
}

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

/** One committed placeholder span; `choices` present for ${n|a,b,c|} stops. */
export interface ParsedSnippetPlaceholder {
  start: number;
  end: number;
  /** Keyboard-cyclable options (§8.18.3 choice session); first is the default. */
  choices?: readonly string[];
}

/**
 * Flatten an LSP snippet into the literal text to insert plus placeholder
 * spans (defaults inlined, full [start,end) extents) so snippet + import
 * edits can be committed in a single transaction instead of the
 * helper-command double dispatch. Bare `$1`/`${1}` tabstops stay zero-width.
 * Choice placeholders keep their option list for the interactive session.
 */
export function parseLspSnippet(
  text: string,
): { text: string; placeholders: ParsedSnippetPlaceholder[] } {
  let out = "";
  const placeholders: Array<{ start: number; choices?: readonly string[] }> = [];
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
    const choice = rest.match(/^\$\{(\d+)\|([^|}]*)\|\}/);
    const placeholder = rest.match(/^\$\{(\d+):((?:[^{}]|\{\d+:?[^{}]*\})*)\}/);
    const bare = rest.match(/^\$\{(\d+)\}/) ?? rest.match(/^\$(\d+)/);
    if (choice || placeholder) {
      const body = (choice ? choice[2].split(",")[0] : placeholder![2]) ?? "";
      placeholders.push({
        start: out.length,
        ...(choice ? { choices: choice[2].split(",") } : {}),
      });
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
      ...(entry.choices ? { choices: entry.choices } : {}),
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
  /** Parallel option lists for choice placeholders (null = plain stop). */
  choices: Array<readonly string[] | null>;
  index: number;
  /** Doc length at commit; any foreign edit invalidates the session. */
  docLength: number;
}

const lspSnippetSessions = new WeakMap<EditorView, LspSnippetSessionState>();

/**
 * Set while the module's own choice-cycle dispatch is in flight so the
 * doc-change invalidator does not kill the session it belongs to.
 */
let choiceCycleInFlight = false;

export function activeLspSnippetSession(view: EditorView): boolean {
  return lspSnippetSessions.has(view);
}

/** Choice options for the ACTIVE tabstop, or null for a plain stop. */
export function activeLspSnippetChoices(view: EditorView): readonly string[] | null {
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) return null;
  return session.choices[session.index] ?? null;
}

/**
 * Interactive choice placeholder (§8.18.3): Tab on a choice stop swaps the
 * committed span text for the NEXT option in one transaction and keeps the
 * tabstop session alive with remapped spans. Escape accepts the current
 * option (handled by the host's existing snippet cancel).
 */
export function cycleLspSnippetChoice(view: EditorView): boolean {
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) {
    lspSnippetSessions.delete(view);
    return false;
  }
  const span = session.spans[session.index];
  const options = session.choices[session.index];
  if (!span || !options || options.length === 0) return false;

  const currentText = view.state.doc.sliceString(span.from, span.to);
  const currentIndex = options.indexOf(currentText);
  // Default (first option) shown → first Tab moves to the second option;
  // past the last option the cycle wraps back to the default.
  const nextIndex = currentIndex < 0 ? Math.min(1, options.length - 1) : (currentIndex + 1) % options.length;
  const nextText = options[nextIndex];

  choiceCycleInFlight = true;
  try {
    view.dispatch({
      changes: { from: span.from, to: span.to, insert: nextText },
      selection: { anchor: span.from, head: span.from + nextText.length },
      userEvent: "input.complete",
    });
  } finally {
    choiceCycleInFlight = false;
  }

  // Remap later spans for the length delta and keep the session usable.
  const delta = nextText.length - (span.to - span.from);
  if (delta !== 0) {
    session.spans = session.spans.map((entry, position) => (
      position === session.index
        ? { from: span.from, to: span.from + nextText.length }
        : entry.from >= span.to
          ? { from: entry.from + delta, to: entry.to + delta }
          : entry
    ));
    session.docLength += delta;
  } else {
    session.spans[session.index] = { from: span.from, to: span.from + nextText.length };
  }
  return true;
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
 * Test-only: seed a post-acceptance session exactly the way
 * `commitLspCompletion` registers one, so choice/tabstop behaviour can be
 * unit-tested without driving the full popup pipeline.
 */
export function seedLspSnippetSessionForTest(
  view: EditorView,
  snippetText: string,
): ParsedSnippetPlaceholder[] {
  const parsed = parseLspSnippet(snippetText);
  lspSnippetSessions.set(view, {
    spans: parsed.placeholders.map((placeholder) => ({ from: placeholder.start, to: placeholder.end })),
    choices: parsed.placeholders.map((placeholder) => placeholder.choices ?? null),
    index: 0,
    docLength: view.state.doc.length,
  });
  return parsed.placeholders;
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
    // The module's own choice-cycle dispatch updates the session state right
    // after the transaction; never treat it as a foreign edit.
    if (choiceCycleInFlight) return;
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
  excludedSymbols?: readonly SymbolPatternRule[],
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

  // §8.21.3 V2-E: Excluded symbol pattern check on item and additional import edits
  if (excludedSymbols && excludedSymbols.length > 0) {
    const identity = symbolIdentityFromItem(item);
    if (matchesSymbolPattern(identity, excludedSymbols)) {
      reportDiagnostic?.("excluded-symbol-blocked", "item-excluded");
      return false;
    }
    const additionalEdits = item.additionalTextEdits ?? [];
    for (const edit of additionalEdits) {
      for (const pat of excludedSymbols) {
        const cleanPat = pat.pattern.replace(/\*$/, "").trim();
        if (cleanPat && edit.newText.includes(cleanPat)) {
          reportDiagnostic?.("excluded-symbol-blocked", "auto-import-excluded");
          return false;
        }
      }
    }
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
      choices: (parsed?.placeholders ?? []).map((placeholder) => placeholder.choices ?? null),
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
  onResolveGate?: ((request: CompletionResolveGateRequest) => void) | undefined,
  excludedSymbols?: readonly SymbolPatternRule[],
): void {
  if (item.additionalTextEdits?.length || !resolve) {
    commitLspCompletion(view, item, from, to, token, isStillCurrent, reportDiagnostic, excludedSymbols);
    return;
  }

  const revisionAtAccept = getDocumentRevision?.();
  const docAtAccept = view.state.doc;

  // §8.19.4 resolve gate: a timeout/failure keeps the chosen item visible and
  // waits for an explicit Retry or Insert-without-import choice. Nothing is
  // inserted until the user picks; stale/overlap blocks stay hard no-ops.
  let settled = false;
  const guardCurrent = (): boolean => {
    if (!isStillCurrent(token)) {
      reportDiagnostic?.("identity-mismatch", "resolve-gate");
      return false;
    }
    if (
      view.state.doc !== docAtAccept
      || (getDocumentRevision && revisionAtAccept !== undefined && getDocumentRevision() !== revisionAtAccept)
    ) {
      reportDiagnostic?.("identity-mismatch", "resolve-gate-doc");
      return false;
    }
    return true;
  };
  const insertWithoutImport = (): boolean => {
    if (settled) return false;
    settled = true;
    if (!guardCurrent()) return false;
    return commitLspCompletion(
      view,
      { ...item, additionalTextEdits: [] },
      from,
      to,
      token,
      isStillCurrent,
      reportDiagnostic,
      excludedSymbols,
    );
  };
  const retryResolve = async (): Promise<"committed" | "unavailable"> => {
    if (settled) return "unavailable";
    if (!guardCurrent()) {
      settled = true;
      return "unavailable";
    }
    let resolved: LspCompletionItem | null;
    try {
      // Fresh round-trip: bypasses the info-panel's memoized promise so a
      // failed first attempt gets a real second chance.
      resolved = await resolve();
    } catch {
      return "unavailable";
    }
    if (settled) return "unavailable";
    if (!isStillCurrent(token) || view.state.doc !== docAtAccept) {
      reportDiagnostic?.("identity-mismatch", "resolve-retry");
      settled = true;
      return "unavailable";
    }
    if (!resolved) return "unavailable";
    settled = true;
    const committed = commitLspCompletion(
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
      excludedSymbols,
    );
    return committed ? "committed" : "unavailable";
  };
  const presentGate = (
    reason: CompletionResolveGateReason,
    detail: string,
  ): void => {
    if (settled) return;
    reportDiagnostic?.("additional-edit-unavailable", detail);
    if (!onResolveGate) {
      // No gate surface wired (isolated embedder): blocking beats silently
      // inserting an acceptance that lost its import edits.
      return;
    }
    onResolveGate({
      item,
      range: { from, to },
      reason,
      message: reason === "timeout"
        ? "Auto-import unavailable — provider resolve timed out"
        : "Auto-import unavailable — provider resolve failed",
      retry: retryResolve,
      insertWithoutImport,
      dismiss: () => {
        settled = true;
      },
    });
  };

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
        presentGate("timeout", "resolve-timeout");
        return;
      }
      const resolved = outcome.resolved;
      if (!resolved) {
        presentGate("failed", "resolve-empty");
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
        excludedSymbols,
      );
    })
    .catch(() => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (!isStillCurrent(token) || view.state.doc !== docAtAccept) {
        reportDiagnostic?.("identity-mismatch", "resolve");
        return;
      }
      presentGate("failed", "resolve-failed");
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

    // Check auto-trigger preference
    if (!context.explicit && hooks.controller) {
      const typedLen = word ? word.text.length : 0;
      if (!hooks.controller.shouldAutoTrigger(typedLen, false)) {
        return null;
      }
    }

    // For plain non-trigger typing (e.g. typing identifiers in Java without `.` or `:`),
    // settle briefly so rapid typing does not spam heavy LSP queries on every keystroke.
    if (!context.explicit && !triggerOnly && !afterTrigger) {
      const delayMs = hooks.controller?.getTriggerDelayMs() ?? 120;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, delayMs);
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
    // §8.19.4 invocation evidence: explicit repeated calls at one caret carry
    // requestedScope:"expanded" into the provider adapter; typing/trigger
    // popups inherit the live sequence without advancing it.
    const reason: CompletionInvocationReason = context.explicit
      ? "explicit"
      : (triggerOnly || afterTrigger)
        ? "trigger"
        : "typing";
    const position = lspPositionFromOffset(context.state.doc, context.pos);
    const invocationOrdinal = recordBasicCompletionInvocation({
      workspaceId: token.workspaceId,
      fileKey: token.fileKey,
      documentRevision: token.documentRevision,
      positionKey: `${position.line}:${position.character}`,
      reason,
      providerGeneration: token.lspSessionGeneration,
    });
    const requestedScope: CompletionInvocationRequest["requestedScope"] =
      invocationOrdinal >= 2 ? "expanded" : "default";
    let result: LspCompletionResult | null = null;
    try {
      result = await hooks.fetch(
        position,
        triggerCharacter,
        token,
        { invocationOrdinal, requestedScope },
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

    recordCompletionInvocationEvidence({
      requestId: token.requestId,
      workspaceId: token.workspaceId,
      fileKey: token.fileKey,
      languageId: token.languageId,
      documentRevision: token.documentRevision,
      providerGeneration: token.lspSessionGeneration,
      reason,
      invocationOrdinal,
      requestedScope,
      providerScope: providerScopeFor(
        requestedScope,
        hooks.advertisesScopeExpansion?.() ?? false,
      ),
      itemCount: result.items.length,
      isIncomplete: result.isIncomplete === true,
      at: Date.now(),
    });

    if (result.items.length === 0) {
      recordCompletionTelemetry(token, "popup", { itemCount: 0 });
      return null;
    }

    if (result.truncated) {
      hooks.reportDiagnostic?.("truncated", `${result.items.length}+`);
    }

    const typed = word ? word.text : "";
    const query = word ? context.state.doc.sliceString(word.from, context.pos) : "";
    const rawItems = result.items;
    const pairs: CompletionCandidatePair[] = [];
    const policyRev = hooks.controller?.getRevision?.() ?? 1;

    // The server response is already relevance ordered. Mapping more entries
    // than the popup can consume only allocates closures/documentation helpers
    // on the renderer thread, which is especially visible for jdtls lists.
    const policy = hooks.controller?.getPolicy?.() ?? {
      autoPopup: true,
      delayMs: 50,
      caseMatching: "none" as const,
      sortMode: "provider-relevance" as const,
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
      maxVisibleItems: MAX_COMPLETION_OPTIONS,
      documentation: { enabled: true, delayMs: 250 },
    };
    const maxItemsLimit = policy.maxVisibleItems ?? MAX_COMPLETION_OPTIONS;
    const maxItemsToProcess = Math.min(rawItems.length, maxItemsLimit);
    for (let i = 0; i < maxItemsToProcess; i += 1) {
      const item = rawItems[i];
      if (!item) continue;

      const identity = symbolIdentityFromItem(item);
      // §8.21.3 V2-E: Excluded symbols matching on provider item FQN/detail/data
      if (matchesSymbolPattern(identity, policy.excludedSymbols)) {
        continue;
      }

      const filterText = item.filterText?.trim() ? item.filterText : null;
      const label = filterText ?? item.label;

      // §8.21.3 V2-E: Case matching filter
      if (typed && !matchesCaseRule(typed, label, policy.caseMatching)) {
        continue;
      }

      // §8.21.3 V2-E: Prioritized symbols boost and provenance
      const isPrioritized = matchesSymbolPattern(identity, policy.prioritizedSymbols);
      let boost = boostFromTypedPrefix(typed, label, item.sortText);
      if (isPrioritized) {
        boost = (boost ?? 0) + 500;
      }

      const displayLabel = filterText && filterText !== item.label ? item.label : undefined;
      const truncatedDetail = result.truncated && i === 0
        ? `${item.detail ?? ""}${item.detail ? " · " : ""}list truncated — keep typing to refine`.trim()
        : isPrioritized
          ? `${item.detail ?? ""}${item.detail ? " · " : ""}(prioritized)`.trim()
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
      // Acceptance/retry resolver: reuses a successful memoized resolve but
      // gives a failed or empty one a real fresh round-trip (§8.19.4 Retry).
      const resolveFresh: CompletionItemResolver | undefined = hooks.resolve
        ? () => {
            if (!resolvedItemPromise) return hooks.resolve!(item.raw, token);
            return resolvedItemPromise.then((resolved) =>
              resolved ? resolved : hooks.resolve!(item.raw, token)
            );
          }
        : undefined;
      const showDoc = policy.documentation.enabled;
      const completion: Completion = {
        label,
        displayLabel,
        sortText: item.sortText ?? undefined,
        boost,
        type: completionKindToType(item.kind),
        detail: truncatedDetail,
        info: showDoc && (item.documentation || resolveItem)
          ? () => completionInfo(item, resolveItem, token, isStillCurrent)
          : undefined,
        apply: (view, _completion, from, to) =>
          applyLspCompletion(
            view,
            item,
            from,
            to,
            resolveFresh,
            token,
            isStillCurrent,
            hooks.getDocumentRevision,
            hooks.reportDiagnostic,
            hooks.onResolveGate,
            policy.excludedSymbols,
          ),
      };

      const match = matchCompletionQuery(label, query);
      const candidateId = `${token.workspaceId}:${token.fileKey}:cand-${i}:${item.label}`;
      const candidateIdentity: CompletionCandidateIdentity = {
        candidateId,
        rawResponseIndex: i,
        workspaceId: token.workspaceId,
        fileKey: token.fileKey,
        documentRevision: token.documentRevision,
        lspSessionGeneration: token.lspSessionGeneration,
        policyRevision: policyRev,
      };

      pairs.push({
        identity: candidateIdentity,
        rawItem: item,
        completion,
        matchTier: match.tier,
        matchScore: isPrioritized ? match.score + 500 : match.score,
      });
    }
    if (context.aborted) return null;

    // §ED-COMP-002: Sort atomic candidate pairs — never splits raw and mapped pairs
    pairs.sort((a, b) => compareCandidatePairs(a, b, policy.sortMode));

    const mapped = pairs.map((p) => p.completion);
    const mappedItems = pairs.map((p) => p.rawItem);

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

    // §8.24.6 Y5: autoInsertSingle executes in single transaction when conditions pass
    if (
      policy.autoInsertSingle
      && mapped.length === 1
      && !result.isIncomplete
      && !result.truncated
      && isStillCurrent(token)
    ) {
      const targetView = hooks.getView?.();
      if (targetView) {
        const singleItem = mappedItems[0];
        const isSnippet = singleItem.insertTextFormat === 2;
        const rawText = singleItem.textEdit?.newText ?? singleItem.insertText ?? singleItem.label;
        const parsedSnippet = isSnippet ? parseLspSnippet(rawText) : null;
        const hasAmbiguousChoices = parsedSnippet && parsedSnippet.placeholders.some((p) => (p.choices?.length ?? 0) > 1);
        if (!hasAmbiguousChoices) {
          let itemToCommit: LspCompletionItem | null = singleItem;
          if (hooks.resolve) {
            try {
              const resolved = await hooks.resolve(singleItem, token);
              if (resolved) {
                itemToCommit = resolved;
              } else {
                itemToCommit = null;
              }
            } catch {
              itemToCommit = null;
            }
          }
          if (itemToCommit) {
            if (!isStillCurrent(token)) return null;
            hooks.reportDiagnostic?.("auto-inserted-single");
            const applied = commitLspCompletion(
              targetView,
              itemToCommit,
              from,
              context.pos,
              token,
              isStillCurrent,
              hooks.reportDiagnostic,
              policy.excludedSymbols,
            );
            if (applied) {
              return null;
            }
          }
        }
      }
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
