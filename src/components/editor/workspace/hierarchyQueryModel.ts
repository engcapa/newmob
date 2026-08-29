import type {
  LspCallHierarchyIncomingEntry,
  LspCallHierarchyOutgoingEntry,
  LspDocumentDescriptor,
  LspDocumentStatus,
  LspHierarchyItem,
  LspPosition,
  LspRange,
} from "../../../lib/editor/lsp";
import {
  lspCallHierarchyIncoming,
  lspCallHierarchyOutgoing,
  lspPrepareCallHierarchy,
  lspPrepareTypeHierarchy,
  lspTypeHierarchySubtypes,
  lspTypeHierarchySupertypes,
} from "../../../lib/editor/lsp";
import {
  WorkspaceSemanticQueryHost,
  type SemanticQueryLiveGuards,
} from "./workspaceSemanticQueryHost";

export type HierarchyMode = "call" | "type";
export type CallHierarchyDirection = "callers" | "callees";
export type TypeHierarchyDirection = "supertypes" | "subtypes";
export type HierarchyDirection = CallHierarchyDirection | TypeHierarchyDirection;

export interface HierarchyRootState {
  descriptor: LspDocumentDescriptor;
  item: LspHierarchyItem;
  rootQueryId?: string;
  providerGeneration?: number;
  projectFingerprint?: string;
}

export interface HierarchyNode {
  id: string;
  item: LspHierarchyItem;
  depth: number;
  pathKeys: string[];
  cycle: boolean;
  expanded: boolean;
  loading: boolean;
  children: HierarchyNode[] | null;
  callRanges: LspRange[];
  callSiteItem: LspHierarchyItem;
  rootQueryId?: string;
  providerGeneration?: number;
  projectFingerprint?: string;
  error?: string | null;
}

export interface HierarchyPrepareResult {
  status: LspDocumentStatus;
  items: LspHierarchyItem[];
  root: HierarchyRootState | null;
  cancelled: boolean;
}

export interface HierarchyExpandResult {
  status?: LspDocumentStatus;
  entries: Array<{
    item: LspHierarchyItem;
    callRanges: LspRange[];
    callSiteItem: LspHierarchyItem;
  }>;
  children: HierarchyNode[];
  stale: boolean;
  cancelled: boolean;
  error?: string | null;
}

export function hierarchyItemKey(item: LspHierarchyItem): string {
  return [
    item.uri,
    item.selectionRange.start.line,
    item.selectionRange.start.character,
    item.name,
  ].join(":");
}

export function createHierarchyRootNode(
  item: LspHierarchyItem,
  rootState?: HierarchyRootState | null,
): HierarchyNode {
  const key = hierarchyItemKey(item);
  return {
    id: key,
    item,
    depth: 0,
    pathKeys: [key],
    cycle: false,
    expanded: false,
    loading: false,
    children: null,
    callRanges: [],
    callSiteItem: item,
    rootQueryId: rootState?.rootQueryId,
    providerGeneration: rootState?.providerGeneration,
    projectFingerprint: rootState?.projectFingerprint,
    error: null,
  };
}

/**
 * Prepares call or type hierarchy root via WorkspaceSemanticQueryHost envelope.
 */
export async function executeHierarchyPrepare(
  queryHost: WorkspaceSemanticQueryHost,
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  mode: HierarchyMode,
  context: {
    workspaceId: string;
    fileKey: string;
    documentRevision: number;
    lspSessionGeneration: number;
    projectFingerprint?: string;
    guards?: SemanticQueryLiveGuards;
  },
): Promise<HierarchyPrepareResult> {
  const kind = mode === "call" ? "call-hierarchy" : "type-hierarchy";

  const envelope = await queryHost.executeEnvelope(
    {
      kind,
      identity: {
        workspaceId: context.workspaceId,
        fileKey: context.fileKey,
        uri: descriptor.uri,
        position,
        documentRevision: context.documentRevision,
        lspSessionGeneration: context.lspSessionGeneration,
      },
      guards: context.guards,
    },
    async (ctx) => {
      if (ctx.signal.aborted) {
        return { status: { languageId: descriptor.languageId, syncing: false, queueLength: 0 }, items: [] };
      }
      return mode === "call"
        ? await lspPrepareCallHierarchy(descriptor, position)
        : await lspPrepareTypeHierarchy(descriptor, position);
    },
  );

  if (envelope.status === "cancelled" || envelope.status === "stale") {
    return {
      status: { languageId: descriptor.languageId, syncing: false, queueLength: 0 },
      items: [],
      root: null,
      cancelled: true,
    };
  }

  const rawResult = envelope.result;
  const items = rawResult?.items ?? [];
  const firstItem = items[0] ?? null;

  const root: HierarchyRootState | null = firstItem
    ? {
        descriptor,
        item: firstItem,
        rootQueryId: envelope.identity.requestId,
        providerGeneration: context.lspSessionGeneration,
        projectFingerprint: context.projectFingerprint,
      }
    : null;

  return {
    status: rawResult?.status ?? { languageId: descriptor.languageId, syncing: false, queueLength: 0 },
    items,
    root,
    cancelled: false,
  };
}

/**
 * Expands a hierarchy node via WorkspaceSemanticQueryHost envelope.
 */
export async function executeHierarchyExpand(
  queryHost: WorkspaceSemanticQueryHost,
  descriptor: LspDocumentDescriptor,
  node: HierarchyNode,
  mode: HierarchyMode,
  direction: HierarchyDirection,
  context: {
    workspaceId: string;
    fileKey: string;
    documentRevision: number;
    lspSessionGeneration: number;
    liveLspGeneration?: () => number;
    guards?: SemanticQueryLiveGuards;
  },
): Promise<HierarchyExpandResult> {
  // Check generation staleness before issuing request
  if (context.liveLspGeneration) {
    const liveGen = context.liveLspGeneration();
    if (node.providerGeneration !== undefined && node.providerGeneration !== liveGen) {
      return {
        entries: [],
        children: [],
        stale: true,
        cancelled: false,
        error: "Provider session changed; node is stale",
      };
    }
  }

  const kind = mode === "call" ? "call-hierarchy" : "type-hierarchy";

  try {
    const envelope = await queryHost.executeEnvelope(
      {
        kind,
        identity: {
          workspaceId: context.workspaceId,
          fileKey: context.fileKey,
          uri: descriptor.uri,
          position: node.item.selectionRange.start,
          documentRevision: context.documentRevision,
          lspSessionGeneration: context.lspSessionGeneration,
        },
        guards: context.guards,
      },
      async (ctx) => {
        if (ctx.signal.aborted) throw new Error("Query aborted");

        if (mode === "call") {
          return direction === "callers"
            ? await lspCallHierarchyIncoming(descriptor, node.item.raw)
            : await lspCallHierarchyOutgoing(descriptor, node.item.raw);
        } else {
          return direction === "supertypes"
            ? await lspTypeHierarchySupertypes(descriptor, node.item.raw)
            : await lspTypeHierarchySubtypes(descriptor, node.item.raw);
        }
      },
    );

    if (envelope.status === "cancelled" || envelope.status === "stale") {
      return {
        entries: [],
        children: [],
        stale: envelope.status === "stale",
        cancelled: envelope.status === "cancelled",
      };
    }

    let entries: Array<{
      item: LspHierarchyItem;
      callRanges: LspRange[];
      callSiteItem: LspHierarchyItem;
    }> = [];
    let status: LspDocumentStatus | undefined;

    if (mode === "call") {
      const callResult = envelope.result as {
        status: LspDocumentStatus;
        entries: LspCallHierarchyIncomingEntry[] | LspCallHierarchyOutgoingEntry[];
      };
      status = callResult?.status;
      entries = (callResult?.entries ?? []).map((entry) => ({
        item: entry.item,
        callRanges: "fromRanges" in entry ? entry.fromRanges : entry.fromRanges,
        callSiteItem: direction === "callers" ? entry.item : node.item,
      }));
    } else {
      const typeResult = envelope.result as {
        status: LspDocumentStatus;
        items: LspHierarchyItem[];
      };
      status = typeResult?.status;
      entries = (typeResult?.items ?? []).map((item) => ({
        item,
        callRanges: [],
        callSiteItem: item,
      }));
    }

    const children = entries.map((entry, index): HierarchyNode => {
      const key = hierarchyItemKey(entry.item);
      return {
        id: `${node.id}/${key}/${index}`,
        item: entry.item,
        depth: node.depth + 1,
        pathKeys: [...node.pathKeys, key],
        cycle: node.pathKeys.includes(key),
        expanded: false,
        loading: false,
        children: null,
        callRanges: entry.callRanges,
        callSiteItem: entry.callSiteItem,
        rootQueryId: node.rootQueryId,
        providerGeneration: node.providerGeneration,
        projectFingerprint: node.projectFingerprint,
        error: null,
      };
    });

    return {
      status,
      entries,
      children,
      stale: false,
      cancelled: false,
    };
  } catch (err) {
    return {
      entries: [],
      children: [],
      stale: false,
      cancelled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
