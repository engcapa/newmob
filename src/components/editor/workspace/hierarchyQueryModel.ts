import type {
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
  nextLspRequestSequence,
} from "../../../lib/editor/lsp";
import {
  WorkspaceSemanticQueryHost,
  type SemanticQueryContext,
  type SemanticQueryLiveGuards,
} from "./workspaceSemanticQueryHost";

export type HierarchyMode = "call" | "type";
export type CallHierarchyDirection = "callers" | "callees";
export type TypeHierarchyDirection = "supertypes" | "subtypes";
export type HierarchyDirection = CallHierarchyDirection | TypeHierarchyDirection;

export interface HierarchyRootState {
  descriptor: LspDocumentDescriptor;
  item: LspHierarchyItem;
  fileKey?: string;
  documentRevision?: number;
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
    requestId?: string;
    cancelKey?: string;
    requestSeq?: number;
    guards?: SemanticQueryLiveGuards;
  },
): Promise<HierarchyPrepareResult> {
  const kind = mode === "call" ? "call-hierarchy" : "type-hierarchy";
  const uri = descriptor.documentUri ?? (descriptor.filePath ? `file://${descriptor.filePath}` : "file:///");
  let capturedStatus: LspDocumentStatus = {
    path: descriptor.filePath,
    uri,
    presetId: null,
    languageId: descriptor.languageId ?? null,
    displayName: null,
    available: true,
    active: true,
    selectedCommandId: descriptor.serverCommandId ?? null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
  const cancelKey = context.cancelKey ?? `${context.workspaceId}|${context.fileKey}`;
  const requestSeq = context.requestSeq ?? nextLspRequestSequence();

  const envelope = await queryHost.executeEnvelope<LspHierarchyItem>({
    kind,
    identity: {
      workspaceId: context.workspaceId,
      fileKey: context.fileKey,
      uri,
      position,
      documentRevision: context.documentRevision,
      lspSessionGeneration: context.lspSessionGeneration,
      requestId: context.requestId,
    },
    guards: context.guards,
    fetcher: async (ctx: SemanticQueryContext) => {
      if (ctx.signal.aborted) return null;
      const res = mode === "call"
        ? await lspPrepareCallHierarchy(descriptor, position, {
          signal: ctx.signal,
          cancelKey,
          requestSeq,
        })
        : await lspPrepareTypeHierarchy(descriptor, position, {
          signal: ctx.signal,
          cancelKey,
          requestSeq,
        });
      capturedStatus = res.status;
      return res.items;
    },
  });

  if (envelope.status === "cancelled" || envelope.status === "stale") {
    return {
      status: capturedStatus,
      items: [],
      root: null,
      cancelled: true,
    };
  }

  const items = envelope.items ?? [];
  const firstItem = items[0] ?? null;

  const root: HierarchyRootState | null = firstItem
      ? {
        descriptor,
        item: firstItem,
        fileKey: context.fileKey,
        documentRevision: context.documentRevision,
        rootQueryId: envelope.queryId,
        providerGeneration: context.lspSessionGeneration,
        projectFingerprint: context.projectFingerprint,
      }
    : null;

  return {
    status: capturedStatus,
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
    requestId?: string;
    cancelKey?: string;
    requestSeq?: number;
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
  const uri = descriptor.documentUri ?? (descriptor.filePath ? `file://${descriptor.filePath}` : "file:///");
  let capturedStatus: LspDocumentStatus | undefined;
  const cancelKey = context.cancelKey ?? `${context.workspaceId}|${context.fileKey}`;
  const requestSeq = context.requestSeq ?? nextLspRequestSequence();

  try {
    interface ExpandedEntry {
      item: LspHierarchyItem;
      callRanges: LspRange[];
      callSiteItem: LspHierarchyItem;
    }

    const envelope = await queryHost.executeEnvelope<ExpandedEntry>({
      kind,
      identity: {
        workspaceId: context.workspaceId,
        fileKey: context.fileKey,
        uri,
        position: node.item.selectionRange.start,
        documentRevision: context.documentRevision,
        lspSessionGeneration: context.lspSessionGeneration,
        requestId: context.requestId,
      },
      guards: context.guards,
      fetcher: async (ctx: SemanticQueryContext) => {
        if (ctx.signal.aborted) return null;

        if (mode === "call") {
          const res = direction === "callers"
            ? await lspCallHierarchyIncoming(descriptor, node.item.raw, {
              signal: ctx.signal,
              cancelKey,
              requestSeq,
            })
            : await lspCallHierarchyOutgoing(descriptor, node.item.raw, {
              signal: ctx.signal,
              cancelKey,
              requestSeq,
            });
          capturedStatus = res.status;
          return res.entries.map((entry) => ({
            item: entry.item,
            callRanges: entry.fromRanges,
            callSiteItem: direction === "callers" ? entry.item : node.item,
          }));
        } else {
          const res = direction === "supertypes"
            ? await lspTypeHierarchySupertypes(descriptor, node.item.raw, {
              signal: ctx.signal,
              cancelKey,
              requestSeq,
            })
            : await lspTypeHierarchySubtypes(descriptor, node.item.raw, {
              signal: ctx.signal,
              cancelKey,
              requestSeq,
            });
          capturedStatus = res.status;
          return res.items.map((item) => ({
            item,
            callRanges: [],
            callSiteItem: item,
          }));
        }
      },
    });

    if (envelope.status === "cancelled" || envelope.status === "stale") {
      return {
        entries: [],
        children: [],
        stale: envelope.status === "stale",
        cancelled: envelope.status === "cancelled",
      };
    }

    const entries = envelope.items ?? [];
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
      status: capturedStatus,
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
