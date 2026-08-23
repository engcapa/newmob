import type { LspPosition } from "../../../lib/editor/lsp";
import type { QuickDocContent } from "./referenceDocumentation";

export type ReferenceInfoKind =
  | "parameter"
  | "documentation"
  | "type"
  | "context"
  | "external-documentation";

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

  cancel(kind?: ReferenceInfoKind): void {
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
