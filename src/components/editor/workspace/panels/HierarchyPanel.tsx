import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, LocateFixed, RefreshCw, RotateCcw } from "lucide-react";
import {
  lspCallHierarchyIncoming,
  lspCallHierarchyOutgoing,
  lspTypeHierarchySubtypes,
  lspTypeHierarchySupertypes,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspHierarchyItem,
  type LspLocation,
  type LspRange,
} from "../../../../lib/editor/lsp";
import { symbolKindLabel } from "../symbolKinds";

export type HierarchyMode = "call" | "type";
export type CallHierarchyDirection = "callers" | "callees";
export type TypeHierarchyDirection = "supertypes" | "subtypes";
type HierarchyDirection = CallHierarchyDirection | TypeHierarchyDirection;

export interface HierarchyRootState {
  descriptor: LspDocumentDescriptor;
  item: LspHierarchyItem;
  rootQueryId?: string;
  providerGeneration?: number;
  projectFingerprint?: string;
}

interface HierarchyNode {
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
}

interface HierarchyPanelProps {
  mode: HierarchyMode;
  root: HierarchyRootState | null;
  active: boolean;
  onOpenLocation: (location: LspLocation) => void;
  onStatus?: (status: LspDocumentStatus) => void;
  /**
   * §8.20.5 W4: set when the provider restarted or the project fingerprint
   * moved after this root was prepared — expanded nodes are stale and the
   * panel offers Rerun instead of silently trusting them.
   */
  staleReason?: string | null;
  onRerunStale?: () => void;
}

const MAX_HIERARCHY_DEPTH = 16;

export function hierarchyItemKey(item: LspHierarchyItem): string {
  return [
    item.uri,
    item.selectionRange.start.line,
    item.selectionRange.start.character,
    item.name,
  ].join(":");
}

function rootNode(item: LspHierarchyItem, rootState?: HierarchyRootState | null): HierarchyNode {
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
  };
}

function findNode(node: HierarchyNode | null, id: string): HierarchyNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function updateHierarchyNode(
  node: HierarchyNode,
  id: string,
  update: (current: HierarchyNode) => HierarchyNode,
): HierarchyNode {
  if (node.id === id) return update(node);
  if (!node.children) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateHierarchyNode(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function itemLocation(item: LspHierarchyItem, range = item.selectionRange): LspLocation {
  return { uri: item.uri, path: item.path, range };
}

function displayPath(item: LspHierarchyItem): string {
  const path = (item.path ?? item.uri).replace(/\\/g, "/");
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function HierarchyPanel({
  mode,
  root,
  active,
  onOpenLocation,
  onStatus,
  staleReason = null,
  onRerunStale,
}: HierarchyPanelProps) {
  const [direction, setDirection] = useState<HierarchyDirection>(
    mode === "call" ? "callers" : "supertypes",
  );
  const [rootItem, setRootItem] = useState<LspHierarchyItem | null>(root?.item ?? null);
  const [tree, setTree] = useState<HierarchyNode | null>(() => root?.item ? rootNode(root.item, root) : null);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  useEffect(() => {
    const nextDirection = mode === "call" ? "callers" : "supertypes";
    setDirection(nextDirection);
    setRootItem(root?.item ?? null);
    setTree(root?.item ? rootNode(root.item, root) : null);
    setError(null);
  }, [mode, root]);

  useEffect(() => {
    if (!rootItem) return;
    setTree(rootNode(rootItem, root));
    setError(null);
  }, [direction, root, rootItem]);

  const loadChildren = useCallback(async (id: string) => {
    if (!root) return;
    if (staleReason) return;
    const node = findNode(treeRef.current, id);
    if (!node || node.loading || node.cycle || node.depth >= MAX_HIERARCHY_DEPTH) return;
    if (node.children) {
      setTree((current) => current
        ? updateHierarchyNode(current, id, (item) => ({ ...item, expanded: !item.expanded }))
        : current);
      return;
    }
    setTree((current) => current
      ? updateHierarchyNode(current, id, (item) => ({ ...item, loading: true, expanded: true }))
      : current);
    setError(null);
    try {
      let status: LspDocumentStatus;
      let entries: Array<{
        item: LspHierarchyItem;
        callRanges: LspRange[];
        callSiteItem: LspHierarchyItem;
      }>;
      if (mode === "call") {
        const result = direction === "callers"
          ? await lspCallHierarchyIncoming(root.descriptor, node.item.raw)
          : await lspCallHierarchyOutgoing(root.descriptor, node.item.raw);
        status = result.status;
        entries = result.entries.map((entry) => ({
          item: entry.item,
          callRanges: entry.fromRanges,
          callSiteItem: direction === "callers" ? entry.item : node.item,
        }));
      } else {
        const result = direction === "supertypes"
          ? await lspTypeHierarchySupertypes(root.descriptor, node.item.raw)
          : await lspTypeHierarchySubtypes(root.descriptor, node.item.raw);
        status = result.status;
        entries = result.items.map((item) => ({ item, callRanges: [], callSiteItem: item }));
      }
      onStatus?.(status);
      const children = entries.map((entry, index): HierarchyNode => {
        const key = hierarchyItemKey(entry.item);
        return {
          id: `${id}/${key}/${index}`,
          item: entry.item,
          depth: node.depth + 1,
          pathKeys: [...node.pathKeys, key],
          cycle: node.pathKeys.includes(key),
          expanded: false,
          loading: false,
          children: null,
          callRanges: entry.callRanges,
          callSiteItem: entry.callSiteItem,
          rootQueryId: root.rootQueryId,
          providerGeneration: root.providerGeneration,
          projectFingerprint: root.projectFingerprint,
        };
      });
      setTree((current) => current
        ? updateHierarchyNode(current, id, (item) => ({
            ...item,
            loading: false,
            expanded: true,
            children,
          }))
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setTree((current) => current
        ? updateHierarchyNode(current, id, (item) => ({ ...item, loading: false }))
        : current);
    }
  }, [direction, mode, onStatus, root, staleReason]);

  const setNewRoot = (item: LspHierarchyItem) => {
    setRootItem(item);
    setTree(rootNode(item, root));
  };

  const renderNode = (node: HierarchyNode) => (
    <div key={node.id}>
      <div
        className="group flex h-7 min-w-0 items-center gap-1 pr-2 hover:bg-[var(--taomni-code-active-line-bg)]"
        style={{ paddingLeft: `${6 + node.depth * 14}px` }}
        onDoubleClick={() => onOpenLocation(itemLocation(node.item))}
      >
        <button
          type="button"
          aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.item.name}`}
          disabled={node.cycle || node.depth >= MAX_HIERARCHY_DEPTH}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center disabled:opacity-40"
          onClick={() => void loadChildren(node.id)}
        >
          {node.loading
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <ChevronRight className={`h-3 w-3 transition-transform ${node.expanded ? "rotate-90" : ""}`} />}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left"
          title={`${node.item.name} — ${node.item.path ?? node.item.uri}:${node.item.selectionRange.start.line + 1}`}
          onClick={() => onOpenLocation(itemLocation(node.item))}
        >
          <span className="font-medium">{node.item.name}</span>
          {node.item.detail && <span className="text-[var(--taomni-code-muted)]"> · {node.item.detail}</span>}
          <span className="text-[var(--taomni-code-muted)]"> — {displayPath(node.item)}:{node.item.selectionRange.start.line + 1}</span>
          {node.cycle && <span className="ml-1 text-amber-500">↻</span>}
        </button>
        <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">
          {symbolKindLabel(node.item.kind)}
        </span>
        <button
          type="button"
          aria-label={`Set ${node.item.name} as hierarchy root`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100"
          onClick={() => setNewRoot(node.item)}
        >
          <LocateFixed className="h-3 w-3" />
        </button>
      </div>
      {node.expanded && node.callRanges.map((range, index) => (
        <button
          key={`${node.id}:call:${index}`}
          type="button"
          className="flex h-6 w-full items-center gap-1 text-left text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
          style={{ paddingLeft: `${28 + node.depth * 14}px` }}
          onClick={() => onOpenLocation(itemLocation(node.callSiteItem, range))}
        >
          <span>call at</span>
          <span className="font-mono">{range.start.line + 1}:{range.start.character + 1}</span>
        </button>
      ))}
      {node.expanded && node.children?.map(renderNode)}
    </div>
  );

  const directions = mode === "call"
    ? (["callers", "callees"] as const)
    : (["supertypes", "subtypes"] as const);

  return (
    <section
      data-testid={`code-workspace-${mode}-hierarchy-panel`}
      data-active={active || undefined}
      className="flex h-full min-h-0 flex-col text-[11px]"
    >
      {/* §8.20.5 W4: provider restart / fingerprint change stale banner with
          an explicit Rerun affordance — never silently trust old expansions. */}
      {staleReason && root && (
        <div
          data-testid="hierarchy-stale-banner"
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-500"
        >
          <RotateCcw className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={staleReason}>{staleReason}</span>
          {onRerunStale && (
            <button
              type="button"
              data-testid="hierarchy-stale-rerun"
              className="rounded px-1.5 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)]"
              onClick={onRerunStale}
            >
              Rerun
            </button>
          )}
        </div>
      )}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        {directions.map((value) => (
          <button
            key={value}
            type="button"
            data-active={direction === value || undefined}
            className="rounded px-2 py-0.5 capitalize data-[active=true]:bg-[var(--taomni-code-selection-match-bg)]"
            onClick={() => setDirection(value)}
          >
            {value}
          </button>
        ))}
        <button
          type="button"
          aria-label="Refresh hierarchy"
          className="ml-auto inline-flex h-5 w-5 items-center justify-center"
          disabled={!rootItem}
          onClick={() => rootItem && setTree(rootNode(rootItem))}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        {root?.item && rootItem && hierarchyItemKey(root.item) !== hierarchyItemKey(rootItem) && (
          <button
            type="button"
            aria-label="Restore original hierarchy root"
            className="inline-flex h-5 w-5 items-center justify-center"
            onClick={() => setNewRoot(root.item)}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error && <div className="mx-2 rounded bg-red-500/10 p-2 text-red-500">{error}</div>}
        {!tree && !error && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            Place the cursor on a supported symbol and open {mode} hierarchy.
          </div>
        )}
        {tree && renderNode(tree)}
      </div>
    </section>
  );
}
