import type { LspPosition, LspRange, LspSignatureInfo } from "../../../lib/editor/lsp";
import { validateExternalDocUrl } from "./referenceDocumentation";
import type { QuickDocContent } from "./referenceDocumentation";

export type ReferenceInfoKind =
  | "parameter"
  | "documentation"
  | "type"
  | "context"
  | "external-documentation";

/** §8.19.7 canonical names for the five reference kinds. */
export type ReferenceKind =
  | "parameter"
  | "quick-documentation"
  | "type-info"
  | "context-info"
  | "external-documentation";

export function referenceKindFromInfoKind(kind: ReferenceInfoKind): ReferenceKind {
  switch (kind) {
    case "parameter": return "parameter";
    case "documentation": return "quick-documentation";
    case "type": return "type-info";
    case "context": return "context-info";
    case "external-documentation": return "external-documentation";
  }
}

/**
 * Typed per-kind payload (§8.19.7). Parameter Info carries its own signature
 * payload — it never reuses the documentation envelope — while Type/Context
 * stay plain text until a provider extension defines more.
 */
export type ReferencePayload =
  | {
    kind: "parameter";
    signatures: readonly LspSignatureInfo[];
    activeSignature: number;
    activeParameter: number;
  }
  | { kind: "quick-documentation"; markdown: string; sourceLocation: ReferenceSourceLocationRef | null }
  | { kind: "type-info"; text: string; languageId: string }
  | { kind: "context-info"; text: string; languageId: string }
  | { kind: "external-documentation"; url: string; title: string | null };

export interface ReferenceSourceLocationRef {
  uri: string;
  path: string | null;
  range: LspRange;
}

export interface ReferenceRequestIdentityV2 {
  workspaceId: string;
  fileKey: string;
  uri: string;
  position: LspPosition;
  documentRevision: number;
  providerGeneration: number;
  requestId: string;
}

export type ReferenceResultV2 =
  | {
    state: "ready";
    kind: ReferenceKind;
    identity: ReferenceRequestIdentityV2;
    payload: ReferencePayload;
  }
  | { state: "unavailable"; kind: ReferenceKind; reason: string }
  | { state: "cancelled" | "stale"; requestId: string }
  | { state: "failed"; kind: ReferenceKind; message: string };

export interface ReferenceInfoRequest {
  kind: ReferenceInfoKind;
  workspaceId: string;
  fileKey: string;
  uri: string;
  languageId: string;
  position: LspPosition;
  documentRevision: number;
  providerGeneration: number;
}

export type ReferenceInfoResult =
  | { kind: "available"; content: QuickDocContent }
  | { kind: "unavailable"; reason: "provider" | "capability" | "no-symbol" }
  | { kind: "stale" | "cancelled"; requestId: string }
  | { kind: "failed"; message: string; retryable: boolean };

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

function sameRequestIdentity(left: ReferenceInfoRequest, right: ReferenceInfoRequest): boolean {
  return left.workspaceId === right.workspaceId
    && left.fileKey === right.fileKey
    && left.uri === right.uri
    && left.languageId === right.languageId
    && left.documentRevision === right.documentRevision
    && left.providerGeneration === right.providerGeneration;
}

export class ReferenceInfoController {
  private disposed = false;
  private requestSequence = 0;
  private readonly active = new Map<ReferenceInfoKind, {
    request: ReferenceInfoRequest;
    requestId: string;
    abort: AbortController;
  }>();
  private history: QuickDocContent[] = [];
  private historyIndex = -1;

  constructor(readonly workspaceId: string) {}

  activate(): void {
    this.disposed = false;
  }

  async request(
    request: ReferenceInfoRequest,
    provider: (ticket: ReferenceRequestTicket) => Promise<QuickDocContent | null>,
  ): Promise<ReferenceInfoResult> {
    if (this.disposed || request.workspaceId !== this.workspaceId) {
      return { kind: "cancelled", requestId: "disposed" };
    }
    this.active.get(request.kind)?.abort.abort();
    const abort = new AbortController();
    const requestId = `${this.workspaceId}:${request.kind}:${++this.requestSequence}`;
    this.active.set(request.kind, { request, requestId, abort });
    try {
      const content = await provider({ requestId, signal: abort.signal });
      const current = this.active.get(request.kind);
      if (abort.signal.aborted || this.disposed) return { kind: "cancelled", requestId };
      if (!current || current.requestId !== requestId || !sameRequestIdentity(current.request, request)) {
        return { kind: "stale", requestId };
      }
      if (!content) return { kind: "unavailable", reason: "no-symbol" };
      return { kind: "available", content };
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return { kind: "cancelled", requestId };
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      if (this.active.get(request.kind)?.requestId === requestId) {
        this.active.delete(request.kind);
      }
    }
  }

  /**
   * §8.19.7 typed entry: all five kinds flow through the same identity /
   * AbortController / cancel machinery, but each returns its OWN payload —
   * Parameter Info never borrows the documentation envelope. Only
   * quick-documentation results feed the shared history stack.
   */
  async requestTyped(
    request: ReferenceInfoRequest,
    provider: (ticket: ReferenceRequestTicket) => Promise<ReferencePayload | null>,
  ): Promise<ReferenceResultV2> {
    const kind = referenceKindFromInfoKind(request.kind);
    if (this.disposed || request.workspaceId !== this.workspaceId) {
      return { state: "cancelled", requestId: "disposed" };
    }
    this.active.get(request.kind)?.abort.abort();
    const abort = new AbortController();
    const requestId = `${this.workspaceId}:${request.kind}:${++this.requestSequence}`;
    this.active.set(request.kind, { request, requestId, abort });
    try {
      const payload = await provider({ requestId, signal: abort.signal });
      const current = this.active.get(request.kind);
      if (abort.signal.aborted || this.disposed) return { state: "cancelled", requestId };
      if (!current || current.requestId !== requestId || !sameRequestIdentity(current.request, request)) {
        return { state: "stale", requestId };
      }
      if (!payload) return { state: "unavailable", kind, reason: "no-symbol" };
      if (payload.kind === "external-documentation") {
        // URL policy is enforced at the service boundary, not by callers.
        const decision = validateExternalDocUrl(payload.url);
        if (decision.kind !== "allowed") {
          return { state: "unavailable", kind, reason: `external-url-${decision.reason}` };
        }
      }
      if (payload.kind === "quick-documentation" && !payload.markdown.trim()) {
        return { state: "unavailable", kind, reason: "empty-documentation" };
      }
      return {
        state: "ready",
        kind,
        identity: {
          workspaceId: request.workspaceId,
          fileKey: request.fileKey,
          uri: request.uri,
          position: request.position,
          documentRevision: request.documentRevision,
          providerGeneration: request.providerGeneration,
          requestId,
        },
        payload,
      };
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return { state: "cancelled", requestId };
      return {
        state: "failed",
        kind,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (this.active.get(request.kind)?.requestId === requestId) {
        this.active.delete(request.kind);
      }
    }
  }

  cancel(kind?: ReferenceInfoKind): void {    if (kind) {
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
      && current.title === content.title
      && current.revision === content.revision
      && current.generation === content.generation
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
    this.history = [];
    this.historyIndex = -1;
  }
}
