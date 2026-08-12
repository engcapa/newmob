import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, ChevronDown, ChevronRight, Loader2, Play, Package, RefreshCw } from "lucide-react";
import {
  workspaceDependencyTree,
  workspaceExecutionModel,
  workspaceTaskTree,
  type DependencyNode,
  type WorkspaceTaskGroup,
  type WorkspaceToolConfig,
} from "../../../../lib/editor/workspace";
import type { JavaModule } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import type { WorkspaceTaskItem } from "./RunPanel";
import { executeTaskPlan, resolveBuildTargetPlan } from "../executionPlan";

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
  targets: WorkspaceTaskItem[];
}

interface BuildPanelProps {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  active: boolean;
  onRunTask: (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => void;
  /** Resolve Java modules for a root via jdtls (M7 F-4); omitted → no Modules section. */
  onLoadModules?: (rootPath: string) => Promise<JavaModule[]>;
  /** Per-workspace Maven/Gradle executable overrides (wrapper still wins). */
  toolConfig?: WorkspaceToolConfig;
}

/**
 * Build panel (M7 F): the task tree (F-2) grouped root -> source -> task.
 * Dependency tree (F-1) and module view (F-4) attach as further sections.
 */
export function BuildPanel({ roots, active, onRunTask, onLoadModules, toolConfig }: BuildPanelProps) {
  const [trees, setTrees] = useState<RootTaskTree[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Dependency trees are on-demand per root (they spawn Maven/Gradle).
  const [deps, setDeps] = useState<Record<string, DependencyNode[]>>({});
  const [depsLoading, setDepsLoading] = useState<Record<string, boolean>>({});
  const [depsError, setDepsError] = useState<Record<string, string | null>>({});

  const [modules, setModules] = useState<Record<string, JavaModule[]>>({});
  const [modulesLoading, setModulesLoading] = useState<Record<string, boolean>>({});
  const [modulesError, setModulesError] = useState<Record<string, string | null>>({});

  const loadModules = useCallback(async (rootId: string, rootPath: string) => {
    if (!onLoadModules) return;
    setModulesLoading((current) => ({ ...current, [rootId]: true }));
    setModulesError((current) => ({ ...current, [rootId]: null }));
    try {
      const loaded = await onLoadModules(rootPath);
      setModules((current) => ({ ...current, [rootId]: loaded }));
    } catch (reason) {
      setModulesError((current) => ({
        ...current,
        [rootId]: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      setModulesLoading((current) => ({ ...current, [rootId]: false }));
    }
  }, [onLoadModules]);

  const loadDependencies = useCallback(async (rootId: string, rootPath: string) => {
    setDepsLoading((current) => ({ ...current, [rootId]: true }));
    setDepsError((current) => ({ ...current, [rootId]: null }));
    try {
      const tree = await workspaceDependencyTree(rootPath, toolConfig);
      setDeps((current) => ({ ...current, [rootId]: tree }));
    } catch (reason) {
      setDepsError((current) => ({
        ...current,
        [rootId]: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      setDepsLoading((current) => ({ ...current, [rootId]: false }));
    }
  }, [toolConfig]);

  const refresh = useCallback(async () => {
    if (roots.length === 0) {
      setTrees([]);
      setLoaded(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await Promise.all(roots.map(async (root): Promise<RootTaskTree> => {
        const [groups, executionModel] = await Promise.all([
          workspaceTaskTree(root.path, toolConfig),
          workspaceExecutionModel(root.path, undefined, toolConfig),
        ]);
        const projectById = new Map(executionModel.projects.map((project) => [project.id, project]));
        return {
          rootId: root.id,
          rootName: root.name,
          rootPath: root.path,
          groups,
          targets: executionModel.buildTargets.map((target) => {
            const project = projectById.get(target.projectId);
            return {
              id: target.id,
              label: target.label,
              command: target.command.display,
              cwd: target.command.cwd,
              source: project ? `${project.languages.join("/")} · ${project.provider}` : "Build target",
              modulePath: project?.module,
              rootId: root.id,
              rootName: root.name,
              execution: {
                executable: target.command.executable,
                args: target.command.args,
                source: target.command.source,
                error: target.command.error,
              },
              environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
                name,
                { value, mode: "replace" as const },
              ])),
              dependsOn: target.dependsOn,
              projectId: target.projectId,
              buildKind: target.kind,
            };
          }),
        };
      }));
      setTrees(next);
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [roots, toolConfig]);
  useEffect(() => {
    if (active && !loaded && !loading) void refresh();
  }, [active, loaded, loading, refresh]);

  // Re-detect tasks (and clear resolved dependency trees) when the tool config
  // changes so the Build panel reflects the new wrapper/executable resolution.
  useEffect(() => {
    if (active && loaded) void refresh();
    setDeps({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolConfig]);

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const hasTasks = useMemo(
    () => trees.some((tree) => tree.targets.length > 0 || tree.groups.some((group) => group.tasks.length > 0)),
    [trees],
  );
  const showRootNames = trees.length > 1;
  const preferredBuildTasks = useMemo(() => trees.flatMap((tree) => {
    const projectIds = [...new Set(tree.targets.flatMap((target) => target.projectId ? [target.projectId] : []))];
    const structured = projectIds.flatMap((projectId) => {
      const candidates = tree.targets.filter((target) => target.projectId === projectId && target.buildKind === "build");
      const preferred = candidates.find((target) => /(^|\b)(build|compile|classes)(\b|$)/i.test(target.label))
        ?? candidates[0];
      return preferred ? [preferred] : [];
    });
    if (structured.length > 0) return structured;
    const preferred = [
      ["Maven", "compile"],
      ["Gradle", "classes"],
      ["Gradle", "build"],
      ["Cargo.toml", "build"],
      ["package.json", "build"],
      ["Makefile", "build"],
    ] as const;
    for (const [source, label] of preferred) {
      const task = tree.groups
        .find((group) => group.source === source)
        ?.tasks.find((candidate) => candidate.label === label);
      if (task) {
        return [{
          ...task,
          rootId: tree.rootId,
          rootName: tree.rootName,
        }];
      }
    }
    return [];
  }), [trees]);
  const preferredRebuildTasks = useMemo(() => trees.flatMap((tree) => {
    const projectIds = [...new Set(tree.targets.flatMap((target) => target.projectId ? [target.projectId] : []))];
    const structured = projectIds.flatMap((projectId) => {
      const clean = tree.targets.find((target) => target.projectId === projectId && target.buildKind === "clean");
      const builds = tree.targets.filter((target) => target.projectId === projectId && target.buildKind === "build");
      const build = builds.find((target) => /(^|\b)(build|compile|classes)(\b|$)/i.test(target.label))
        ?? builds[0];
      return clean && build ? [clean, build] : [];
    });
    if (structured.length > 0) return structured;
    for (const source of ["Maven", "Gradle"]) {
      const task = tree.groups
        .find((group) => group.source === source)
        ?.tasks.find((candidate) => candidate.label === "rebuild");
      if (task) {
        return [{
          ...task,
          rootId: tree.rootId,
          rootName: tree.rootName,
        }];
      }
    }
    return [];
  }), [trees]);

  const runBuildTargets = useCallback(async (requested: readonly WorkspaceTaskItem[]) => {
    if (executing || requested.length === 0) return;
    setExecutionError(null);
    setExecuting(true);
    try {
      const queue = new Map<string, WorkspaceTaskItem[]>();
      for (const task of requested) {
        queue.set(task.rootId, [...(queue.get(task.rootId) ?? []), task]);
      }
      const plan = [...queue.entries()].flatMap(([rootId, rootRequests]) => {
        const structured = trees.find((tree) => tree.rootId === rootId)?.targets ?? [];
        const candidates = [...structured];
        for (const task of rootRequests) {
          if (!candidates.some((candidate) => candidate.id === task.id)) candidates.push(task);
        }
        const resolved = resolveBuildTargetPlan(
          rootRequests.map((task) => task.id),
          candidates.map((task) => ({
            id: task.id,
            projectId: `build-panel:${rootId}`,
            label: task.label,
            kind: "build" as const,
            command: {
              executable: task.execution?.executable ?? task.command.split(/\s+/, 1)[0] ?? task.command,
              args: task.execution?.args ?? [],
              cwd: task.cwd,
              env: Object.fromEntries(Object.entries(task.environment ?? {}).map(([name, item]) => [name, item.value])),
              display: task.command,
              source: task.execution?.source ?? "path",
              error: task.execution?.error,
            },
            dependsOn: task.dependsOn ?? [],
          })),
        );
        const taskById = new Map(candidates.map((task) => [task.id, task]));
        return resolved
          .map((target) => taskById.get(target.id))
          .filter((task): task is WorkspaceTaskItem => !!task);
      });
      const result = await executeTaskPlan(
        plan,
        (next, onExit) => onRunTask(next, onExit),
      );
      if (result.exitCode !== 0) {
        setExecutionError(
          `Build stopped at ${result.failed?.label ?? "target"} (exit ${result.exitCode})`,
        );
      }
    } catch (reason) {
      setExecutionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExecuting(false);
    }
  }, [executing, onRunTask, trees]);

  const runBuildTarget = useCallback((task: WorkspaceTaskItem) => {
    void runBuildTargets([task]);
  }, [runBuildTargets]);

  return (
    <div data-testid="code-workspace-build-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="h-8 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-2">
        <span className="font-medium">Build</span>
        <button
          type="button"
          data-testid="build-panel-build-project"
          className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
          onClick={() => void runBuildTargets(preferredBuildTasks)}
          disabled={loading || executing || preferredBuildTasks.length === 0}
          title="Compile all detected project roots"
        >
          <Play className="h-3 w-3" />
          Build project
        </button>
        <button
          type="button"
          data-testid="build-panel-rebuild-project"
          className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
          onClick={() => void runBuildTargets(preferredRebuildTasks)}
          disabled={loading || executing || preferredRebuildTasks.length === 0}
          title="Clean and build all supported project roots"
        >
          <RefreshCw className="h-3 w-3" />
          Rebuild
        </button>
        <button
          type="button"
          data-testid="build-panel-refresh"
          className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
          onClick={() => void refresh()}
          disabled={loading || executing}
          title="Refresh tasks"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error && (
          <div className="px-2 py-1 text-red-500" data-testid="build-panel-error">{error}</div>
        )}
        {executionError && (
          <div className="px-2 py-1 text-red-500" data-testid="build-panel-execution-error">
            {executionError}
          </div>
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
                  disabled={executing}
                  onClick={() => runBuildTarget({
                    ...task,
                    rootId: tree.rootId,
                    rootName: tree.rootName,
                  })}
                >
                  <Play className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
                  {task.modulePath && task.modulePath !== "." && (
                    <span className="shrink-0 rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-[9px] text-[var(--taomni-text-muted)]">
                      {task.modulePath}
                    </span>
                  )}
                  <span className="truncate">{task.label}</span>
                  <span className="ml-auto truncate text-[10px] text-[var(--taomni-text-muted)]">{task.command}</span>
                </button>
              ))}
            </div>
          );
        }))}

        {trees.filter((tree) => tree.targets.length > 0).map((tree) => {
          const key = `${tree.rootId}:structured-build-targets`;
          const isCollapsed = collapsed[key];
          const heading = showRootNames ? `${tree.rootName} · Build targets` : "Build targets";
          return (
            <div key={key} className="select-none border-b border-[var(--taomni-code-border)] pb-1">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-[var(--taomni-hover-bg)]"
                onClick={() => toggle(key)}
              >
                {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                <span className="font-medium text-[var(--taomni-text-muted)]">{heading}</span>
                <span className="ml-auto text-[10px] text-[var(--taomni-text-muted)]">{tree.targets.length}</span>
              </button>
              {!isCollapsed && tree.targets.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  data-testid={`build-panel-target-${task.id}`}
                  className="group flex w-full items-center gap-1.5 py-0.5 pl-6 pr-2 text-left hover:bg-[var(--taomni-hover-bg)] disabled:opacity-60"
                  title={task.execution?.error ?? task.command}
                  disabled={executing || !!task.execution?.error}
                  onClick={() => runBuildTarget(task)}
                >
                  {task.execution?.error
                    ? <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                    : <Play className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />}
                  {task.modulePath && <span className="shrink-0 rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-[9px] text-[var(--taomni-text-muted)]">{task.modulePath}</span>}
                  <span className="truncate">{task.label}</span>
                  <span className="ml-auto truncate text-[10px] text-[var(--taomni-text-muted)]">{task.source}</span>
                </button>
              ))}
            </div>
          );
        })}

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

        {onLoadModules && trees
          .filter((tree) => tree.groups.some((group) => group.source === "Maven" || group.source === "Gradle"))
          .map((tree) => {
            const key = `modules:${tree.rootId}`;
            const isCollapsed = collapsed[key];
            const loaded = modules[tree.rootId];
            const heading = showRootNames ? `${tree.rootName} · Modules` : "Modules";
            return (
              <div key={key} className="mt-1 select-none border-t border-[var(--taomni-code-border)] pt-1">
                <div className="flex items-center gap-1 px-2 py-0.5">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-left"
                    onClick={() => toggle(key)}
                  >
                    {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                    <Boxes className="h-3 w-3 shrink-0" />
                    <span className="font-medium text-[var(--taomni-text-muted)]">{heading}</span>
                  </button>
                  <button
                    type="button"
                    data-testid={`build-panel-modules-load-${tree.rootId}`}
                    className="taomni-btn ml-auto h-5 px-1.5 text-[10px] inline-flex items-center gap-1"
                    onClick={() => void loadModules(tree.rootId, tree.rootPath)}
                    disabled={modulesLoading[tree.rootId]}
                  >
                    {modulesLoading[tree.rootId]
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />}
                    {loaded ? "Reload" : "Load"}
                  </button>
                </div>
                {!isCollapsed && (
                  <div data-testid={`build-panel-modules-${tree.rootId}`}>
                    {modulesError[tree.rootId] && (
                      <div className="px-2 py-1 text-red-500">{modulesError[tree.rootId]}</div>
                    )}
                    {loaded && loaded.length === 0 && !modulesError[tree.rootId] && (
                      <div className="px-2 py-1 text-[var(--taomni-text-muted)]">No modules reported.</div>
                    )}
                    {loaded && loaded.map((module) => (
                      <div
                        key={module.uri}
                        className="flex items-center gap-1.5 py-0.5 pl-6 pr-2"
                        title={module.path}
                      >
                        <span className="truncate">{module.name}</span>
                        <span className="ml-auto truncate text-[10px] text-[var(--taomni-text-muted)]">{module.path}</span>
                      </div>
                    ))}
                    {!loaded && !modulesLoading[tree.rootId] && !modulesError[tree.rootId] && (
                      <div className="px-2 py-1 text-[10px] text-[var(--taomni-text-muted)]">
                        Load to list Java modules (requires an active language server).
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
