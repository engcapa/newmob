import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play, RefreshCw } from "lucide-react";
import {
  workspaceTaskTree,
  type WorkspaceTaskGroup,
} from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import type { WorkspaceTaskItem } from "./RunPanel";

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
      </div>
    </div>
  );
}
