import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Play, Package, RefreshCw } from "lucide-react";
import {
  workspaceDependencyTree,
  workspaceTaskTree,
  type DependencyNode,
  type WorkspaceTaskGroup,
} from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import type { WorkspaceTaskItem } from "./RunPanel";

/** One row of the dependency tree; children expand lazily via local state. */
function DependencyRow({ node, depth }: { node: DependencyNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5 pr-2 hover:bg-[var(--taomni-hover-bg)]"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {hasChildren ? (
          <button type="button" className="shrink-0" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        <span className="truncate">
          {node.group}:<span className="text-[var(--taomni-text)]">{node.artifact}</span>
          <span className="text-[var(--taomni-text-muted)]">:{node.version}</span>
          {node.scope && <span className="ml-1 text-[10px] text-[var(--taomni-text-muted)]">({node.scope})</span>}
        </span>
        {node.conflict && (
          <span
            className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-amber-500"
            title={node.conflict}
          >
            <AlertTriangle className="h-3 w-3" />
            conflict
          </span>
        )}
      </div>
      {open && hasChildren && node.children.map((child, index) => (
        <DependencyRow key={`${child.group}:${child.artifact}:${index}`} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

interface RootTaskTree {
  rootId: string;
  rootName: string;
  rootPath: string;
  groups: WorkspaceTaskGroup[];
}

interface BuildPanelProps {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  active: boolean;
  onRunTask: (task: WorkspaceTaskItem) => void;
}

/**
 * Build panel (M7 F): the task tree (F-2) grouped root -> source -> task.
 * Dependency tree (F-1) and module view (F-4) attach as further sections.
 */
export function BuildPanel({ roots, active, onRunTask }: BuildPanelProps) {
  const [trees, setTrees] = useState<RootTaskTree[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Dependency trees are on-demand per root (they spawn Maven/Gradle).
  const [deps, setDeps] = useState<Record<string, DependencyNode[]>>({});
  const [depsLoading, setDepsLoading] = useState<Record<string, boolean>>({});
  const [depsError, setDepsError] = useState<Record<string, string | null>>({});

  const loadDependencies = useCallback(async (rootId: string, rootPath: string) => {
    setDepsLoading((current) => ({ ...current, [rootId]: true }));
    setDepsError((current) => ({ ...current, [rootId]: null }));
    try {
      const tree = await workspaceDependencyTree(rootPath);
      setDeps((current) => ({ ...current, [rootId]: tree }));
    } catch (reason) {
      setDepsError((current) => ({
        ...current,
        [rootId]: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      setDepsLoading((current) => ({ ...current, [rootId]: false }));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (roots.length === 0) {
      setTrees([]);
      setLoaded(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await Promise.all(roots.map(async (root): Promise<RootTaskTree> => ({
        rootId: root.id,
        rootName: root.name,
        rootPath: root.path,
        groups: await workspaceTaskTree(root.path),
      })));
      setTrees(next);
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [roots]);
  useEffect(() => {
    if (active && !loaded && !loading) void refresh();
  }, [active, loaded, loading, refresh]);

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const hasTasks = useMemo(
    () => trees.some((tree) => tree.groups.some((group) => group.tasks.length > 0)),
    [trees],
  );
  const showRootNames = trees.length > 1;

  return (
    <div data-testid="code-workspace-build-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="h-8 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-2">
        <span className="font-medium">Build</span>
        <button
          type="button"
          data-testid="build-panel-refresh"
          className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh tasks"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error && (
          <div className="px-2 py-1 text-red-500" data-testid="build-panel-error">{error}</div>
        )}
        {!error && loaded && !hasTasks && (
          <div className="px-2 py-1 text-[var(--taomni-text-muted)]">
            No build tasks detected in this workspace.
          </div>
        )}
        {trees.map((tree) => tree.groups.filter((group) => group.tasks.length > 0).map((group) => {
          const key = `${tree.rootId}:${group.source}`;
          const isCollapsed = collapsed[key];
          const heading = showRootNames ? `${tree.rootName} · ${group.source}` : group.source;
          return (
            <div key={key} className="select-none">
              <button
                type="button"
                className="w-full flex items-center gap-1 px-2 py-0.5 text-left hover:bg-[var(--taomni-hover-bg)]"
                onClick={() => toggle(key)}
              >
                {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                <span className="font-medium text-[var(--taomni-text-muted)]">{heading}</span>
                <span className="ml-auto text-[10px] text-[var(--taomni-text-muted)]">{group.tasks.length}</span>
              </button>
              {!isCollapsed && group.tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  data-testid={`build-panel-task-${task.id}`}
                  className="group w-full flex items-center gap-1.5 py-0.5 pl-6 pr-2 text-left hover:bg-[var(--taomni-hover-bg)]"
                  title={task.command}
                  onClick={() => onRunTask({
                    ...task,
                    rootId: tree.rootId,
                    rootName: tree.rootName,
                  })}
                >
                  <Play className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
                  <span className="truncate">{task.label}</span>
                  <span className="ml-auto truncate text-[10px] text-[var(--taomni-text-muted)]">{task.command}</span>
                </button>
              ))}
            </div>
          );
        }))}

        {trees.map((tree) => {
          const key = `deps:${tree.rootId}`;
          const isCollapsed = collapsed[key];
          const loaded = deps[tree.rootId];
          const heading = showRootNames ? `${tree.rootName} · Dependencies` : "Dependencies";
          return (
            <div key={key} className="mt-1 select-none border-t border-[var(--taomni-code-border)] pt-1">
              <div className="flex items-center gap-1 px-2 py-0.5">
                <button
                  type="button"
                  className="flex items-center gap-1 text-left"
                  onClick={() => toggle(key)}
                >
                  {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                  <Package className="h-3 w-3 shrink-0" />
                  <span className="font-medium text-[var(--taomni-text-muted)]">{heading}</span>
                </button>
                <button
                  type="button"
                  data-testid={`build-panel-deps-load-${tree.rootId}`}
                  className="taomni-btn ml-auto h-5 px-1.5 text-[10px] inline-flex items-center gap-1"
                  onClick={() => void loadDependencies(tree.rootId, tree.rootPath)}
                  disabled={depsLoading[tree.rootId]}
                >
                  {depsLoading[tree.rootId]
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                  {loaded ? "Reload" : "Load"}
                </button>
              </div>
              {!isCollapsed && (
                <div data-testid={`build-panel-deps-${tree.rootId}`}>
                  {depsError[tree.rootId] && (
                    <div className="px-2 py-1 text-red-500">{depsError[tree.rootId]}</div>
                  )}
                  {loaded && loaded.length === 0 && !depsError[tree.rootId] && (
                    <div className="px-2 py-1 text-[var(--taomni-text-muted)]">No dependencies resolved.</div>
                  )}
                  {loaded && loaded.map((node, index) => (
                    <DependencyRow key={`${node.group}:${node.artifact}:${index}`} node={node} depth={0} />
                  ))}
                  {!loaded && !depsLoading[tree.rootId] && !depsError[tree.rootId] && (
                    <div className="px-2 py-1 text-[10px] text-[var(--taomni-text-muted)]">
                      Load to resolve the dependency tree (runs Maven/Gradle).
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
