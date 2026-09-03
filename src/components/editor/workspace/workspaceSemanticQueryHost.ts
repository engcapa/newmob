import type { LspPosition } from "../../../lib/editor/lsp";

export type SemanticQueryKind =
  | "definitions"
  | "declarations"
  | "implementations"
  | "typeDefinitions"
  | "references"
  | "call-hierarchy"
  | "type-hierarchy"
  | "super-methods";

export interface SemanticQueryIdentity {
  workspaceId: string;
  fileKey: string;
  uri: string;
  position: LspPosition;
  documentRevision: number;
  lspSessionGeneration: number;
  projectGeneration?: number;
  requestId: string;
}

export interface SemanticQueryContext extends SemanticQueryIdentity {
  signal: AbortSignal;
}

export interface SemanticQueryLiveGuards {
  getLiveDocumentRevision?: () => number;
  getLiveLspGeneration?: () => number;
  getLiveProjectGeneration?: () => number;
  guardDelivery?: (identity: SemanticQueryIdentity) => boolean;
  // legacy compatibility
  generation?: number;
  getLiveGeneration?: () => number;
}

/** Metadata-only provider lifecycle facts used by the release observation seam. */
export interface WorkspaceSemanticQueryObservation {
  readonly kind: SemanticQueryKind;
  readonly queryId: string;
  readonly workspaceId: string;
  readonly fileKey: string;
}

export interface WorkspaceSemanticQueryObserver {
  readonly onRequest?: (observation: WorkspaceSemanticQueryObservation) => void;
  readonly onCancel?: (observation: WorkspaceSemanticQueryObservation) => void;
}

export interface SemanticQueryExecutionRequest<TItem> {
  kind: SemanticQueryKind;
  identity: Partial<SemanticQueryIdentity> & { uri: string; position: LspPosition };
  fetcher: (context: SemanticQueryContext) => Promise<TItem[] | null>;
  guards?: SemanticQueryLiveGuards;
}

export interface SemanticQueryResult<TItem> {
  queryId: string;
  kind: SemanticQueryKind;
  status: "success" | "cancelled" | "unavailable" | "error" | "stale";
  items: TItem[];
  truncated: boolean;
  totalCount: number;
  error?: string;
  durationMs: number;
  identity?: SemanticQueryIdentity;
}

export const MAX_SEMANTIC_QUERY_ITEMS = 1000;

interface ActiveQueryRecord {
  queryId: string;
  kind: SemanticQueryKind;
  workspaceId: string;
  fileKey: string;
  lspSessionGeneration: number;
  controller: AbortController;
  cancelNotified: boolean;
}

let querySequenceCounter = 0;

export class WorkspaceSemanticQueryHost {
  private activeQueries = new Map<string, ActiveQueryRecord>();
  private activeByKind = new Map<SemanticQueryKind, string>();

  constructor(private readonly observer: WorkspaceSemanticQueryObserver = {}) {}

  /**
   * §ED-QUERY-001: Execute semantic query with complete envelope passing,
   * four-phase live guards, and transport cancellation.
   */
  async executeEnvelope<TItem>(
    request: SemanticQueryExecutionRequest<TItem>,
  ): Promise<SemanticQueryResult<TItem>> {
    const startTime = Date.now();
    querySequenceCounter += 1;
    const queryId = request.identity.requestId ?? `query-${request.kind}-${Date.now().toString(36)}-${querySequenceCounter}`;
    const workspaceId = request.identity.workspaceId ?? "default-workspace";
    const fileKey = request.identity.fileKey ?? request.identity.uri;
    const documentRevision = request.identity.documentRevision ?? 1;
    const lspSessionGeneration = request.identity.lspSessionGeneration ?? 1;
    const projectGeneration = request.identity.projectGeneration;

    const fullIdentity: SemanticQueryIdentity = {
      workspaceId,
      fileKey,
      uri: request.identity.uri,
      position: request.identity.position,
      documentRevision,
      lspSessionGeneration,
      ...(projectGeneration !== undefined ? { projectGeneration } : {}),
      requestId: queryId,
    };

    const guards = request.guards;

    // === PHASE 1: Pre-flight Live Guard ===
    // Check document revision
    if (guards?.getLiveDocumentRevision && guards.getLiveDocumentRevision() !== documentRevision) {
      return {
        queryId,
        kind: request.kind,
        status: "stale",
        items: [],
        truncated: false,
        totalCount: 0,
        durationMs: Date.now() - startTime,
        identity: fullIdentity,
      };
    }
    // Check LSP session generation
    if (guards?.getLiveLspGeneration && guards.getLiveLspGeneration() !== lspSessionGeneration) {
      return {
        queryId,
        kind: request.kind,
        status: "stale",
        items: [],
        truncated: false,
        totalCount: 0,
        durationMs: Date.now() - startTime,
        identity: fullIdentity,
      };
    }
    // Check project generation
    if (
      projectGeneration !== undefined
      && guards?.getLiveProjectGeneration
      && guards.getLiveProjectGeneration() !== projectGeneration
    ) {
      return {
        queryId,
        kind: request.kind,
        status: "stale",
        items: [],
        truncated: false,
        totalCount: 0,
        durationMs: Date.now() - startTime,
        identity: fullIdentity,
      };
    }
    // Legacy generation check
    if (
      guards?.generation !== undefined
      && guards.getLiveGeneration
      && guards.generation !== guards.getLiveGeneration()
    ) {
      return {
        queryId,
        kind: request.kind,
        status: "stale",
        items: [],
        truncated: false,
        totalCount: 0,
        durationMs: Date.now() - startTime,
        identity: fullIdentity,
      };
    }

    // Cancel prior in-flight query of the same kind
    const previousQueryId = this.activeByKind.get(request.kind);
    if (previousQueryId) {
      const prev = this.activeQueries.get(previousQueryId);
      if (prev) {
        prev.controller.abort();
        this.notifyCancel(prev);
        this.activeQueries.delete(previousQueryId);
      }
    }

    const controller = new AbortController();
    const record: ActiveQueryRecord = {
      queryId,
      kind: request.kind,
      workspaceId,
      fileKey,
      lspSessionGeneration,
      controller,
      cancelNotified: false,
    };
    this.activeQueries.set(queryId, record);
    this.activeByKind.set(request.kind, queryId);
    this.notifyRequest(record);

    const context: SemanticQueryContext = {
      ...fullIdentity,
      signal: controller.signal,
    };

    try {
      // === PHASE 2: Transport & In-flight Execution ===
      if (controller.signal.aborted) {
        return {
          queryId,
          kind: request.kind,
          status: "cancelled",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      const rawItems = await request.fetcher(context);

      // === PHASE 3: Post-fetch Live Guard (dynamic re-evaluation) ===
      if (controller.signal.aborted) {
        return {
          queryId,
          kind: request.kind,
          status: "cancelled",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      if (guards?.getLiveDocumentRevision && guards.getLiveDocumentRevision() !== documentRevision) {
        return {
          queryId,
          kind: request.kind,
          status: "stale",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      if (guards?.getLiveLspGeneration && guards.getLiveLspGeneration() !== lspSessionGeneration) {
        return {
          queryId,
          kind: request.kind,
          status: "stale",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      if (
        projectGeneration !== undefined
        && guards?.getLiveProjectGeneration
        && guards.getLiveProjectGeneration() !== projectGeneration
      ) {
        return {
          queryId,
          kind: request.kind,
          status: "stale",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      if (
        guards?.generation !== undefined
        && guards.getLiveGeneration
        && guards.generation !== guards.getLiveGeneration()
      ) {
        return {
          queryId,
          kind: request.kind,
          status: "stale",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      if (rawItems === null) {
        return {
          queryId,
          kind: request.kind,
          status: "unavailable",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      // === PHASE 4: Delivery / Reveal Guard ===
      if (guards?.guardDelivery && !guards.guardDelivery(fullIdentity)) {
        return {
          queryId,
          kind: request.kind,
          status: "stale",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      const totalCount = rawItems.length;
      const truncated = totalCount > MAX_SEMANTIC_QUERY_ITEMS;
      const items = truncated ? rawItems.slice(0, MAX_SEMANTIC_QUERY_ITEMS) : rawItems;

      return {
        queryId,
        kind: request.kind,
        status: "success",
        items,
        truncated,
        totalCount,
        durationMs: Date.now() - startTime,
        identity: fullIdentity,
      };
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        this.notifyCancel(record);
        return {
          queryId,
          kind: request.kind,
          status: "cancelled",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
          identity: fullIdentity,
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        queryId,
        kind: request.kind,
        status: "error",
        items: [],
        truncated: false,
        totalCount: 0,
        error: msg,
        durationMs: Date.now() - startTime,
        identity: fullIdentity,
      };
    } finally {
      if (this.activeQueries.get(queryId) === record) {
        this.activeQueries.delete(queryId);
      }
      if (this.activeByKind.get(request.kind) === queryId) {
        this.activeByKind.delete(request.kind);
      }
    }
  }

  /**
   * Dispatches a semantic query (convenience / legacy compatible overload).
   */
  async execute<TItem>(
    kind: SemanticQueryKind,
    uri: string,
    position: LspPosition,
    fetcher: (signal: AbortSignal) => Promise<TItem[] | null>,
    options?: SemanticQueryLiveGuards & {
      workspaceId?: string;
      fileKey?: string;
      documentRevision?: number;
      lspSessionGeneration?: number;
      projectGeneration?: number;
      requestId?: string;
    },
  ): Promise<SemanticQueryResult<TItem>> {
    return this.executeEnvelope({
      kind,
      identity: {
        uri,
        position,
        workspaceId: options?.workspaceId,
        fileKey: options?.fileKey,
        documentRevision: options?.documentRevision ?? options?.generation,
        lspSessionGeneration: options?.lspSessionGeneration,
        projectGeneration: options?.projectGeneration,
        requestId: options?.requestId,
      },
      fetcher: (ctx) => fetcher(ctx.signal),
      guards: options,
    });
  }

  cancelQuery(queryId: string): void {
    const record = this.activeQueries.get(queryId);
    if (record) {
      record.controller.abort();
      this.notifyCancel(record);
      this.activeQueries.delete(queryId);
      if (this.activeByKind.get(record.kind) === queryId) {
        this.activeByKind.delete(record.kind);
      }
    }
  }

  cancelKind(kind: SemanticQueryKind): void {
    const queryId = this.activeByKind.get(kind);
    if (queryId) {
      this.cancelQuery(queryId);
    }
  }

  cancelFile(workspaceId: string, fileKey: string): void {
    for (const record of Array.from(this.activeQueries.values())) {
      if (record.workspaceId === workspaceId && record.fileKey === fileKey) {
        record.controller.abort();
        this.notifyCancel(record);
        this.activeQueries.delete(record.queryId);
        if (this.activeByKind.get(record.kind) === record.queryId) {
          this.activeByKind.delete(record.kind);
        }
      }
    }
  }

  cancelSession(workspaceId: string, lspSessionGeneration?: number): void {
    for (const record of Array.from(this.activeQueries.values())) {
      if (
        record.workspaceId === workspaceId
        && (lspSessionGeneration === undefined || record.lspSessionGeneration === lspSessionGeneration)
      ) {
        record.controller.abort();
        this.notifyCancel(record);
        this.activeQueries.delete(record.queryId);
        if (this.activeByKind.get(record.kind) === record.queryId) {
          this.activeByKind.delete(record.kind);
        }
      }
    }
  }

  cancelWorkspace(workspaceId: string): void {
    this.cancelSession(workspaceId);
  }

  cancelAll(): void {
    for (const record of Array.from(this.activeQueries.values())) {
      record.controller.abort();
      this.notifyCancel(record);
    }
    this.activeQueries.clear();
    this.activeByKind.clear();
  }

  private notifyRequest(record: ActiveQueryRecord): void {
    try {
      this.observer.onRequest?.({
        kind: record.kind,
        queryId: record.queryId,
        workspaceId: record.workspaceId,
        fileKey: record.fileKey,
      });
    } catch {
      // Observation subscribers cannot affect query execution.
    }
  }

  private notifyCancel(record: ActiveQueryRecord): void {
    if (record.cancelNotified) return;
    record.cancelNotified = true;
    try {
      this.observer.onCancel?.({
        kind: record.kind,
        queryId: record.queryId,
        workspaceId: record.workspaceId,
        fileKey: record.fileKey,
      });
    } catch {
      // Observation subscribers cannot affect query execution.
    }
  }
}
