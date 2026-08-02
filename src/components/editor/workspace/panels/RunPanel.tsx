import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { AlertTriangle, Check, Loader2, Play, Plus, RefreshCw, Settings2, SlidersHorizontal } from "lucide-react";
import {
  workspaceDetectTasks,
  workspaceExecutionModel,
  workspaceJavaRunTargets,
  type ExecutionRunConfiguration,
  type WorkspaceTask,
  type WorkspaceToolConfig,
} from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  applyRunConfigurationOverride,
  formatEnvironmentLines,
  parseEnvironmentLines,
  readRunConfigurationOverrides,
  writeRunConfigurationOverride,
} from "../runConfigurationPersistence";

export interface WorkspaceTaskItem extends WorkspaceTask {
  rootId: string;
  rootName: string;
  custom?: boolean;
  configuration?: boolean;
  runConfiguration?: ExecutionRunConfiguration;
  dependsOn?: string[];
}

interface RunHistoryEntry {
  id: string;
  task: WorkspaceTaskItem;
  startedAt: number;
  status: "running" | "passed" | "failed";
  exitCode: number | null;
}

export interface RunPanelHandle {
  rerunLast: () => boolean;
  run: (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => void;
  refresh: () => void;
}

interface RunPanelProps {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  active: boolean;
  onRun: (task: WorkspaceTaskItem, onExit: (exitCode: number) => void) => void;
  /** Per-workspace build/runtime/adapter executable overrides. */
  toolConfig?: WorkspaceToolConfig;
  /** Open the Build/Run tools settings dialog. */
  onConfigureTools?: () => void;
}

function customTasksKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.customTasks.v1.${workspaceInstanceId}`;
}

function readCustomTasks(workspaceInstanceId: string): WorkspaceTaskItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(customTasksKey(workspaceInstanceId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((task): task is WorkspaceTaskItem => (
      !!task && typeof task.command === "string" && typeof task.cwd === "string"
    )) : [];
  } catch {
    return [];
  }
}

export const RunPanel = forwardRef<RunPanelHandle, RunPanelProps>(function RunPanel({
  workspaceInstanceId,
  roots,
  active,
  onRun,
  toolConfig,
  onConfigureTools,
}, ref) {
  const [detectedTasks, setDetectedTasks] = useState<WorkspaceTaskItem[]>([]);
  const [runConfigurations, setRunConfigurations] = useState<WorkspaceTaskItem[]>([]);
  const [customTasks, setCustomTasks] = useState<WorkspaceTaskItem[]>(
    () => readCustomTasks(workspaceInstanceId),
  );
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [customCommand, setCustomCommand] = useState("");
  const [customRootId, setCustomRootId] = useState(roots[0]?.id ?? "");
  const [editingConfigurationId, setEditingConfigurationId] = useState<string | null>(null);
  const [configurationDraft, setConfigurationDraft] = useState({ cwd: "", args: "", env: "" });

  const refresh = useCallback(async () => {
    if (roots.length === 0) {
      setDetectedTasks([]);
      setRunConfigurations([]);
      setLoaded(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const overrides = readRunConfigurationOverrides(workspaceInstanceId);
      const groups = await Promise.all(roots.map(async (root) => {
        const [tasks, javaTargets, executionModel] = await Promise.all([
          workspaceDetectTasks(root.path, toolConfig),
          workspaceJavaRunTargets(root.path, toolConfig),
          workspaceExecutionModel(root.path, undefined, toolConfig),
        ]);
        const detected = tasks.map((task): WorkspaceTaskItem => ({
          ...task,
          rootId: root.id,
          rootName: root.name,
        }));
        const java = javaTargets.map((target): WorkspaceTaskItem => ({
          id: target.id,
          label: target.label,
          command: target.command,
          cwd: target.cwd,
          source: `Java · ${target.buildSystem === "source-file" ? "JDK" : target.buildSystem}`,
          rootId: root.id,
          rootName: root.name,
          execution: target.execution,
          environment: target.environment,
        }));
        const projectById = new Map(executionModel.projects.map((project) => [project.id, project]));
        const configurations = executionModel.runConfigurations.map((detectedConfiguration): WorkspaceTaskItem => {
          const configuration = applyRunConfigurationOverride(
            detectedConfiguration,
            overrides[detectedConfiguration.id],
          );
          const project = projectById.get(configuration.projectId);
          return {
            id: configuration.id,
            label: configuration.label,
            command: configuration.command.display,
            cwd: configuration.command.cwd,
            source: project ? `${project.languages.join("/")} · ${project.provider}` : "Run configuration",
            rootId: root.id,
            rootName: root.name,
            configuration: true,
            runConfiguration: configuration,
            execution: {
              executable: configuration.command.executable,
              args: configuration.command.args,
              source: configuration.command.source,
              error: configuration.command.error,
            },
            environment: Object.fromEntries(Object.entries(configuration.command.env).map(([name, value]) => [
              name,
              { value, mode: "replace" as const },
            ])),
          };
        });
        return { tasks: [...java, ...detected], configurations };
      }));
      setDetectedTasks(groups.flatMap((group) => group.tasks));
      setRunConfigurations(groups.flatMap((group) => group.configurations));
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [roots, toolConfig, workspaceInstanceId]);

  useEffect(() => {
    if (active && !loaded && !loading) void refresh();
  }, [active, loaded, loading, refresh]);

  // Re-detect when the tool config changes so wrapper/executable resolution and
  // any "tool not found" diagnostics reflect the new settings immediately.
  useEffect(() => {
    if (active && loaded) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolConfig]);

  useEffect(() => {
    window.localStorage.setItem(customTasksKey(workspaceInstanceId), JSON.stringify(customTasks));
  }, [customTasks, workspaceInstanceId]);

  const tasks = useMemo(() => [...detectedTasks, ...customTasks], [customTasks, detectedTasks]);

  const runTask = useCallback((task: WorkspaceTaskItem, afterExit?: (exitCode: number) => void) => {
    const historyId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: RunHistoryEntry = {
      id: historyId,
      task,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
    };
    setHistory((current) => [entry, ...current].slice(0, 20));
    onRun(task, (exitCode) => {
      setHistory((current) => current.map((entry) => entry.id === historyId
        ? {
            ...entry,
            status: exitCode === 0 ? "passed" : "failed",
            exitCode,
          }
        : entry));
      afterExit?.(exitCode);
    });
  }, [onRun]);

  useImperativeHandle(ref, () => ({
    run: runTask,
    refresh: () => {
      void refresh();
    },
    rerunLast: () => {
      const last = history[0]?.task;
      if (!last) return false;
      runTask(last);
      return true;
    },
  }), [history, refresh, runTask]);

  const grouped = useMemo(() => {
    const map = new Map<string, WorkspaceTaskItem[]>();
    for (const task of tasks) map.set(task.rootId, [...(map.get(task.rootId) ?? []), task]);
    return map;
  }, [tasks]);
  const groupedConfigurations = useMemo(() => {
    const map = new Map<string, WorkspaceTaskItem[]>();
    for (const task of runConfigurations) {
      map.set(task.rootId, [...(map.get(task.rootId) ?? []), task]);
    }
    return map;
  }, [runConfigurations]);

  const renderTask = (task: WorkspaceTaskItem) => {
    const toolError = task.execution?.error;
    return (
      <div key={task.id} className="group flex items-center gap-1 rounded hover:bg-[var(--taomni-code-active-line-bg)]">
        <button
          type="button"
          data-testid={task.configuration ? `run-panel-configuration-${task.id}` : undefined}
          className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
          title={toolError ? toolError : `${task.command} — ${task.cwd}`}
          onClick={() => runTask(task)}
          disabled={!!toolError}
        >
          {toolError
            ? <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
            : <Play className="h-3 w-3 shrink-0 text-emerald-500" />}
          <span className="truncate">{task.label}</span>
          <span className="ml-auto shrink-0 text-[10px] text-[var(--taomni-code-muted)]">{task.source}</span>
        </button>
        {task.custom && (
          <button
            type="button"
            aria-label={`Remove custom task ${task.label}`}
            className="px-1 text-red-500 opacity-0 group-hover:opacity-100"
            onClick={() => setCustomTasks((current) => current.filter((item) => item.id !== task.id))}
          >
            ×
          </button>
        )}
        {task.configuration && (
          <button
            type="button"
            data-testid={`run-panel-configuration-edit-${task.id}`}
            aria-label={`Edit run configuration ${task.label}`}
            title="Edit run configuration"
            className="h-6 w-6 shrink-0 rounded opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={() => {
              const override = readRunConfigurationOverrides(workspaceInstanceId)[task.id];
              setEditingConfigurationId(task.id);
              setConfigurationDraft({
                cwd: override?.cwd ?? "",
                args: override?.args.join("\n") ?? "",
                env: formatEnvironmentLines(override?.env ?? {}),
              });
            }}
          >
            <SlidersHorizontal className="mx-auto h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  const addCustomTask = () => {
    const command = customCommand.trim();
    const root = roots.find((candidate) => candidate.id === customRootId) ?? roots[0];
    if (!command || !root) return;
    const task: WorkspaceTaskItem = {
      id: `custom:${Date.now()}`,
      label: command,
      command,
      cwd: root.path,
      source: "Custom",
      rootId: root.id,
      rootName: root.name,
      custom: true,
    };
    setCustomTasks((current) => [...current, task]);
    setCustomCommand("");
  };

  return (
    <section data-testid="code-workspace-run-panel" className="flex h-full min-h-0 flex-col text-[11px]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        <input
          data-testid="run-panel-custom-command"
          aria-label="Custom task command"
          value={customCommand}
          onChange={(event) => setCustomCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addCustomTask();
          }}
          placeholder="Custom command"
          className="h-6 min-w-40 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2"
        />
        {roots.length > 1 && (
          <select
            data-testid="run-panel-custom-root"
            aria-label="Custom task root"
            value={customRootId}
            onChange={(event) => setCustomRootId(event.target.value)}
            className="h-6 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)]"
          >
            {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
          </select>
        )}
        <button
          type="button"
          data-testid="run-panel-add-custom-task"
          aria-label="Add custom task"
          onClick={addCustomTask}
          className="h-6 w-6 rounded"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        {onConfigureTools && (
          <button
            type="button"
            data-testid="run-panel-configure-tools"
            aria-label="Configure build and run tools"
            title="Configure build, runtime, and debug tools"
            onClick={onConfigureTools}
            className="h-6 w-6 rounded"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          data-testid="run-panel-refresh"
          aria-label="Refresh tasks"
          onClick={() => void refresh()}
          className="h-6 w-6 rounded"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)] divide-x divide-[var(--taomni-code-border)]">
        <div className="min-h-0 overflow-auto p-2">
          {error && <div className="mb-2 text-red-500">{error}</div>}
          {!loading && tasks.length === 0 && runConfigurations.length === 0 && (
            <div className="text-[var(--taomni-code-muted)]">No run configurations or tasks detected</div>
          )}
          {roots.map((root) => {
            const rootTasks = grouped.get(root.id) ?? [];
            const rootConfigurations = groupedConfigurations.get(root.id) ?? [];
            if (rootTasks.length === 0 && rootConfigurations.length === 0) return null;
            return (
              <div key={root.id} className="mb-2">
                <div className="mb-1 font-semibold">{root.name}</div>
                {rootConfigurations.length > 0 && (
                  <div data-testid={`run-panel-configurations-${root.id}`}>
                    <div className="px-1 pb-0.5 text-[10px] font-medium uppercase text-[var(--taomni-code-muted)]">
                      Run configurations
                    </div>
                    {rootConfigurations.map(renderTask)}
                  </div>
                )}
                {rootTasks.length > 0 && (
                  <div className={rootConfigurations.length > 0 ? "mt-2" : ""}>
                    <div className="px-1 pb-0.5 text-[10px] font-medium uppercase text-[var(--taomni-code-muted)]">
                      Tasks
                    </div>
                    {rootTasks.map(renderTask)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="min-h-0 overflow-auto p-2">
          {editingConfigurationId && (() => {
            const configuration = runConfigurations.find((item) => item.id === editingConfigurationId);
            if (!configuration) return null;
            return (
              <div data-testid="run-configuration-editor" className="mb-3 space-y-2 border-b border-[var(--taomni-code-border)] pb-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{configuration.label}</span>
                  <button
                    type="button"
                    data-testid="run-configuration-reset"
                    aria-label="Reset run configuration"
                    title="Reset run configuration"
                    className="h-6 w-6 rounded"
                    onClick={() => {
                      writeRunConfigurationOverride(workspaceInstanceId, configuration.id, null);
                      setConfigurationDraft({ cwd: "", args: "", env: "" });
                      void refresh();
                    }}
                  >
                    <RefreshCw className="mx-auto h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    data-testid="run-configuration-save"
                    aria-label="Save run configuration"
                    title="Save run configuration"
                    className="h-6 w-6 rounded"
                    onClick={() => {
                      writeRunConfigurationOverride(workspaceInstanceId, configuration.id, {
                        args: configurationDraft.args.split(/\r?\n/).filter((value) => value.length > 0),
                        cwd: configurationDraft.cwd,
                        env: parseEnvironmentLines(configurationDraft.env),
                      });
                      void refresh();
                    }}
                  >
                    <Check className="mx-auto h-3.5 w-3.5" />
                  </button>
                </div>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Working directory</span>
                  <input
                    data-testid="run-configuration-cwd"
                    value={configurationDraft.cwd}
                    placeholder={configuration.cwd}
                    onChange={(event) => setConfigurationDraft((current) => ({ ...current, cwd: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Program arguments</span>
                  <textarea
                    data-testid="run-configuration-args"
                    value={configurationDraft.args}
                    onChange={(event) => setConfigurationDraft((current) => ({ ...current, args: event.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Environment</span>
                  <textarea
                    data-testid="run-configuration-env"
                    value={configurationDraft.env}
                    onChange={(event) => setConfigurationDraft((current) => ({ ...current, env: event.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
                  />
                </label>
              </div>
            );
          })()}
          <div className="mb-1 font-semibold">Run History</div>
          {history.length === 0 && <div className="text-[var(--taomni-code-muted)]">No tasks run yet</div>}
          {history.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
              onClick={() => runTask(entry.task)}
              title="Run again"
            >
              <span className={entry.status === "running"
                ? "text-sky-500"
                : entry.status === "passed" ? "text-emerald-500" : "text-red-500"}
              >
                {entry.status === "running" ? "●" : entry.status === "passed" ? "✓" : "×"}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.task.rootName} · {entry.task.label}</span>
              <span className="shrink-0 tabular-nums text-[var(--taomni-code-muted)]">
                {entry.exitCode === null ? "running" : `exit ${entry.exitCode}`}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
});
