import type { LspPosition } from "../../../lib/editor/lsp";

export type SemanticQueryKind =
  | "references"
  | "implementation"
  | "super-methods"
  | "call-hierarchy"
  | "type-hierarchy";

export interface SemanticQueryRequest<T = unknown> {
  id: string;
  kind: SemanticQueryKind;
  uri: string;
  position: LspPosition;
  signal: AbortSignal;
  payload?: T;
}

export interface SemanticQueryResult<TItem> {
  queryId: string;
  kind: SemanticQueryKind;
  status: "success" | "cancelled" | "unavailable" | "error";
  items: TItem[];
  truncated: boolean;
  totalCount: number;
  error?: string;
  durationMs: number;
}

export const MAX_SEMANTIC_QUERY_ITEMS = 1000;

export class WorkspaceSemanticQueryHost {
  private activeControllers = new Map<SemanticQueryKind, AbortController>();

  /**
   * Dispatches a semantic query. Automatically cancels any prior in-flight query of the same kind.
   */
  async execute<TItem>(
    kind: SemanticQueryKind,
    _uri: string,
    _position: LspPosition,
    fetcher: (signal: AbortSignal) => Promise<TItem[] | null>,
  ): Promise<SemanticQueryResult<TItem>> {
    const startTime = Date.now();
    const queryId = `query-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // Cancel in-flight query for this kind
    const previous = this.activeControllers.get(kind);
    if (previous) {
      previous.abort();
    }

    const controller = new AbortController();
    this.activeControllers.set(kind, controller);

    try {
      if (controller.signal.aborted) {
        return {
          queryId,
          kind,
          status: "cancelled",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      const rawItems = await fetcher(controller.signal);

      if (controller.signal.aborted) {
        return {
          queryId,
          kind,
          status: "cancelled",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      if (rawItems === null) {
        return {
          queryId,
          kind,
          status: "unavailable",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      const totalCount = rawItems.length;
      const truncated = totalCount > MAX_SEMANTIC_QUERY_ITEMS;
      const items = truncated ? rawItems.slice(0, MAX_SEMANTIC_QUERY_ITEMS) : rawItems;

      return {
        queryId,
        kind,
        status: "success",
        items,
        truncated,
        totalCount,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return {
          queryId,
          kind,
          status: "cancelled",
          items: [],
          truncated: false,
          totalCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        queryId,
        kind,
        status: "error",
        items: [],
        truncated: false,
        totalCount: 0,
        error: msg,
        durationMs: Date.now() - startTime,
      };
    } finally {
      if (this.activeControllers.get(kind) === controller) {
        this.activeControllers.delete(kind);
      }
    }
  }

  cancelKind(kind: SemanticQueryKind): void {
    const controller = this.activeControllers.get(kind);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(kind);
    }
  }

  cancelAll(): void {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
  }
}
