import type { LspPosition, LspRange, LspSignatureInfo } from "../../../lib/editor/lsp";
import { validateExternalDocUrl } from "./referenceDocumentation";
import type { QuickDocContent } from "./referenceDocumentation";

/**
 * §8.20.2 W1 canonical names — the IDEA 2026.2 public classification
 * (Parameter Info / Quick Documentation / External Documentation / Type Info /
 * Expression Static Data). The v4.50-era `context-info` name is NOT carried
 * forward: it never matched Expression Static Data semantics, and persisted
 * or in-flight records under that name migrate to an explicit unavailable
 * state instead of being rebranded (see migrateLegacyContextInfoRecord).
 */
export type ReferenceKindV3 =
  | "parameter-info"
  | "quick-documentation"
  | "external-documentation"
  | "type-info"
  | "expression-static-data";

export const REFERENCE_KINDS_V3: readonly ReferenceKindV3[] = [
  "parameter-info",
  "quick-documentation",
  "external-documentation",
  "type-info",
  "expression-static-data",
];

/** Provider-declared static fact about one expression (branch/value/nullness…). */
export interface StaticExpressionFact {
  id: string;
  label: string;
  value: string;
  detail?: string | null;
}

export interface ReferenceSourceLocationRef {
  uri: string;
  path: string | null;
  range: LspRange;
}

/**
 * Typed per-kind payload (§8.20.2). Each kind owns its envelope — Parameter
 * Info never borrows the documentation body, Type Info / Expression Static
 * Data only ever carry provider-typed content (`source: "provider"` is part
 * of the type, so a text-derived payload cannot be constructed by accident).
 */
export type ReferencePayloadV3 =
  | {
    kind: "parameter-info";
    signatures: readonly LspSignatureInfo[];
    activeSignature: number;
    activeParameter: number;
  }
  | { kind: "quick-documentation"; markdown: string; source: ReferenceSourceLocationRef | null }
  | { kind: "external-documentation"; url: string; title: string }
  | { kind: "type-info"; display: string; source: "provider" }
  | { kind: "expression-static-data"; facts: readonly StaticExpressionFact[]; source: "provider" };

/**
 * What a provider adapter may hand back: a typed payload, an explicit
 * per-kind unavailability reason (e.g. the server exposes no type-info
 * channel), or `null` as the legacy shorthand for "no symbol here".
 */
export type ReferenceProviderOutcome =
  | { state: "payload"; payload: ReferencePayloadV3 }
  | { state: "unavailable"; reason: string };

/** Caller-supplied identity fields; the controller mints `requestId` itself. */
export interface ReferenceRequestIdentityFields {
  workspaceId: string;
  fileKey: string;
  uri: string;
  position: LspPosition;
  documentRevision: number;
  providerGeneration: number;
}

export interface ReferenceRequestIdentity extends ReferenceRequestIdentityFields {
  requestId: string;
}

export type ReferenceResultV3 =
  | { state: "ready"; kind: ReferenceKindV3; identity: ReferenceRequestIdentity; payload: ReferencePayloadV3 }
  | { state: "unavailable"; kind: ReferenceKindV3; reason: string }
  | { state: "cancelled" | "stale"; requestId: string }
  | { state: "failed"; kind: ReferenceKindV3; message: string };

export interface ReferenceInfoRequestV3 extends ReferenceRequestIdentityFields {
  kind: ReferenceKindV3;
  languageId: string;
  // No requestId field: the controller is the ONLY generator of reference
  // request ids in the repo (§8.20.2 DoD).
}

/**
 * §8.20.2 migration rule: a V2 `context-info` record (persisted or in
 * flight) must surface as an explicit unavailable state — it is not
 * Expression Static Data and must never be auto-mapped onto it.
 */
export const LEGACY_CONTEXT_INFO_REASON = "legacy-context-info-not-expression-static-data";

export function isLegacyContextInfoKind(kind: unknown): boolean {
  return kind === "context" || kind === "context-info";
}

/** Any record persisted or invoked under a legacy context-info kind surfaces
 * as this explicit unavailable state — never auto-mapped onto the real kind. */
export function migrateLegacyContextInfoRecord(): ReferenceResultV3 {
  return {
    state: "unavailable",
    kind: "expression-static-data",
    reason: LEGACY_CONTEXT_INFO_REASON,
  };
}

interface ReferenceRequestTicket {
  requestId: string;
  signal: AbortSignal;
}

export interface ReferenceHistorySnapshot {
  content: QuickDocContent | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

const MAX_HISTORY_ENTRIES = 50;

function sameRequestIdentity(left: ReferenceInfoRequestV3, right: ReferenceInfoRequestV3): boolean {
  return left.workspaceId === right.workspaceId
    && left.fileKey === right.fileKey
    && left.uri === right.uri
    && left.languageId === right.languageId
    && left.documentRevision === right.documentRevision
    && left.providerGeneration === right.providerGeneration;
}

function validatePayloadV3(payload: ReferencePayloadV3): string | null {
  switch (payload.kind) {
    case "parameter-info":
      return payload.signatures.length > 0 ? null : "empty-signatures";
    case "quick-documentation":
      return payload.markdown.trim().length > 0 ? null : "empty-documentation";
    case "type-info":
      return payload.display.trim().length > 0 ? null : "empty-type";
    case "expression-static-data":
      return payload.facts.length > 0 ? null : "empty-facts";
    case "external-documentation":
      // Scheme policy is enforced by the caller (validateExternalDocUrl);
      // nothing beyond non-emptiness to check here.
      return null;
  }
}

export class ReferenceInfoController {
  private disposed = false;
  private requestSequence = 0;
  private readonly active = new Map<ReferenceKindV3, {
    request: ReferenceInfoRequestV3;
    requestId: string;
    abort: AbortController;
  }>();
  private readonly lastReadyByKind = new Map<ReferenceKindV3, {
    identity: ReferenceRequestIdentity;
    payload: ReferencePayloadV3;
  }>();
  private history: QuickDocContent[] = [];
  private historyIndex = -1;

  constructor(readonly workspaceId: string) {}

  activate(): void {
    this.disposed = false;
  }

  /**
   * §8.20.2 single channel: every reference kind flows through this one
   * entry — same identity machinery, per-kind supersede/cancel, and the only
   * place reference request ids are ever minted.
   */
  async requestTyped(
    request: ReferenceInfoRequestV3,
    provider: (ticket: ReferenceRequestTicket) => Promise<ReferenceProviderOutcome | ReferencePayloadV3 | null>,
  ): Promise<ReferenceResultV3> {
    if (isLegacyContextInfoKind(request.kind)) {
      return migrateLegacyContextInfoRecord();
    }
    if (this.disposed || request.workspaceId !== this.workspaceId) {
      return { state: "cancelled", requestId: "disposed" };
    }
    if (!REFERENCE_KINDS_V3.includes(request.kind)) {
      return { state: "cancelled", requestId: "unknown-kind" };
    }
    this.active.get(request.kind)?.abort.abort();
    const abort = new AbortController();
    const requestId = `${this.workspaceId}:${request.kind}:${++this.requestSequence}`;
    this.active.set(request.kind, { request, requestId, abort });
    try {
      const raw = await provider({ requestId, signal: abort.signal });
      const current = this.active.get(request.kind);
      if (abort.signal.aborted || this.disposed) return { state: "cancelled", requestId };
      if (!current || current.requestId !== requestId || !sameRequestIdentity(current.request, request)) {
        return { state: "stale", requestId };
      }
      // Legacy shorthand kept for adapter ergonomics: null means the provider
      // found no symbol at this position.
      const outcome: ReferenceProviderOutcome | null = raw == null
        ? null
        : typeof raw === "object" && "state" in raw && ((raw as ReferenceProviderOutcome).state === "payload" || (raw as ReferenceProviderOutcome).state === "unavailable")
        ? raw as ReferenceProviderOutcome
        : { state: "payload", payload: raw as ReferencePayloadV3 };
      if (!outcome) return { state: "unavailable", kind: request.kind, reason: "no-symbol" };
      if (outcome.state === "unavailable") {
        return { state: "unavailable", kind: request.kind, reason: outcome.reason };
      }
      const payload = outcome.payload;
      if (payload.kind !== request.kind) {
        return { state: "failed", kind: request.kind, message: `payload kind ${payload.kind} does not match request ${request.kind}` };
      }
      if (payload.kind === "external-documentation") {
        const decision = validateExternalDocUrl(payload.url);
        if (decision.kind !== "allowed") {
          return { state: "unavailable", kind: request.kind, reason: `external-url-${decision.reason}` };
        }
      }
      const invalidReason = validatePayloadV3(payload);
      if (invalidReason) return { state: "unavailable", kind: request.kind, reason: invalidReason };
      const identity: ReferenceRequestIdentity = {
        workspaceId: request.workspaceId,
        fileKey: request.fileKey,
        uri: request.uri,
        position: request.position,
        documentRevision: request.documentRevision,
        providerGeneration: request.providerGeneration,
        requestId,
      };
      this.lastReadyByKind.set(request.kind, { identity, payload });
      return { state: "ready", kind: request.kind, identity, payload };
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return { state: "cancelled", requestId };
      return {
        state: "failed",
        kind: request.kind,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (this.active.get(request.kind)?.requestId === requestId) {
        this.active.delete(request.kind);
      }
    }
  }

  /** Latest ready result of a kind — the fact source for dependent entries
   * (External Documentation enables itself from a real provider URL found in
   * the last ready quick-documentation payload). */
  lastReady(kind: ReferenceKindV3): { identity: ReferenceRequestIdentity; payload: ReferencePayloadV3 } | null {
    return this.lastReadyByKind.get(kind) ?? null;
  }

  cancel(kind?: ReferenceKindV3): void {
    if (kind) {
      this.active.get(kind)?.abort.abort();
      this.active.delete(kind);
      return;
    }
    for (const request of this.active.values()) request.abort.abort();
    this.active.clear();
  }

  pushHistory(content: QuickDocContent): ReferenceHistorySnapshot {
    const current = this.history[this.historyIndex];
    if (
      current?.uri === content.uri
      && current?.title === content.title
      && current?.revision === content.revision
      && current?.generation === content.generation
    ) {
      this.history[this.historyIndex] = content;
      return this.historySnapshot();
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(content);
    if (this.history.length > MAX_HISTORY_ENTRIES) this.history.shift();
    this.historyIndex = this.history.length - 1;
    return this.historySnapshot();
  }

  goBack(): ReferenceHistorySnapshot {
    if (this.historyIndex > 0) this.historyIndex -= 1;
    return this.historySnapshot();
  }

  goForward(): ReferenceHistorySnapshot {
    if (this.historyIndex + 1 < this.history.length) this.historyIndex += 1;
    return this.historySnapshot();
  }

  historySnapshot(): ReferenceHistorySnapshot {
    return {
      content: this.history[this.historyIndex] ?? null,
      canGoBack: this.historyIndex > 0,
      canGoForward: this.historyIndex >= 0 && this.historyIndex + 1 < this.history.length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.lastReadyByKind.clear();
    this.history = [];
    this.historyIndex = -1;
  }
}
