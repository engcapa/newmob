import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { AlertTriangle, Check, CopyPlus, Loader2, Play, Plus, RefreshCw, Settings2, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  workspaceReadLooseFile,
  workspaceDetectTasks,
  workspaceExecutionModel,
  workspaceJavaRunTargets,
  type ExecutionRunConfiguration,
  type WorkspaceTask,
  type WorkspaceToolConfig,
} from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  createNamedRunConfiguration,
  formatEnvironmentLines,
  parseDotEnv,
  parseEnvironmentLines,
  readRunConfigurationOverrides,
  readActiveRunConfigurationSelections,
  resolveEnvironmentFilePath,
  materializeRunConfigurations,
  javaRunTargetToExecutionRunConfiguration,
  writeRunConfigurationOverride,
  writeActiveRunConfigurationSelection,
} from "../runConfigurationPersistence";
import {
  executeCompoundConfiguration,
  executeTaskPlan,
  resolveBuildTargetPlan,
} from "../executionPlan";
import type { ExecutionBuildTarget } from "../../../../lib/editor/workspace";

export interface WorkspaceTaskItem extends WorkspaceTask {
  rootId: string;
  rootName: string;
  custom?: boolean;
  configuration?: boolean;
  runConfiguration?: ExecutionRunConfiguration;
  /** Provider/shared values before workspace-local overrides. */
  runConfigurationDefaults?: ExecutionRunConfiguration;
  dependsOn?: string[];
  /** Explicit target catalog for toolbar-launched configurations. */
  buildTargets?: ExecutionBuildTarget[];
  /** Structured target identity retained by the Build panel. */
  projectId?: string;
  buildKind?: ExecutionBuildTarget["kind"];
  /** Full configuration catalog used when a toolbar launch starts a compound
   * before the Run panel has performed its own discovery. */
  configurationCatalog?: ExecutionRunConfiguration[];
}

interface RunHistoryEntry {
  id: string;
  task: WorkspaceTaskItem;
  startedAt: number;
  status: "running" | "passed" | "failed";
  exitCode: number | null;
  message?: string;
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

function configurationSourceLabel(source: ExecutionRunConfiguration["configurationSource"]): string {
  switch (source) {
    case "shared":
      return "Shared";
    case "local":
      return "Local";
    case "provider":
      return "Provider";
    default:
      return "Detected";
  }
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

function taskForExecutionConfiguration(
  configuration: ExecutionRunConfiguration,
  root: Pick<CodeWorkspaceRootInfo, "id" | "name">,
  source: string,
  buildTargets: ExecutionBuildTarget[],
  defaults: ExecutionRunConfiguration = configuration,
): WorkspaceTaskItem {
  return {
    id: configuration.id,
    label: configuration.label,
    command: configuration.command.display,
    cwd: configuration.command.cwd,
    source,
    rootId: root.id,
    rootName: root.name,
    configuration: true,
    runConfiguration: configuration,
    runConfigurationDefaults: defaults,
    execution: {
      executable: configuration.command.executable,
      args: configuration.command.args,
      source: configuration.command.source,
      error: configuration.command.error,
    },
    environment: Object.fromEntries(Object.entries(configuration.command.env).map(([name, value]) => [
      name,
      { value, mode: configuration.environmentModes?.[name] ?? "replace" },
    ])),
    dependsOn: configuration.preLaunchTargets,
    buildTargets,
  };
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
  const [editingConfiguration, setEditingConfiguration] = useState<{
    rootId: string;
    configurationId: string;
  } | null>(null);
  const [configurationDraft, setConfigurationDraft] = useState({
    name: "",
    cwd: "",
    args: "",
    vmOptions: "",
    env: "",
    envFile: "",
    preLaunchTargets: "",
  });
  const [buildTargetsByRoot, setBuildTargetsByRoot] = useState<Record<string, ExecutionBuildTarget[]>>({});
  const [executionDiagnostics, setExecutionDiagnostics] = useState<Record<string, string[]>>({});

  const openConfigurationEditor = useCallback((task: WorkspaceTaskItem) => {
    const override = readRunConfigurationOverrides(workspaceInstanceId, task.rootId)[task.id];
    setEditingConfiguration({ rootId: task.rootId, configurationId: task.id });
    setConfigurationDraft({
      name: override?.name ?? task.label,
      cwd: override?.cwd ?? "",
      args: override?.args.join("\n") ?? "",
      vmOptions: (override?.vmOptions ?? task.runConfiguration?.runtimeOptions ?? []).join("\n"),
      env: formatEnvironmentLines(override?.env ?? {}),
      envFile: override?.envFile ?? task.runConfiguration?.envFile ?? "",
      preLaunchTargets: (override?.preLaunchTargets ?? task.runConfiguration?.preLaunchTargets ?? []).join("\n"),
    });
  }, [workspaceInstanceId]);

  const configuredTask = useCallback(async (task: WorkspaceTaskItem): Promise<WorkspaceTaskItem> => {
    const envFile = task.runConfiguration?.envFile?.trim();
    if (!envFile) return task;
    const path = resolveEnvironmentFilePath(task.cwd, envFile);
    const file = await workspaceReadLooseFile(path, 1024 * 1024);
    const fromFile = parseDotEnv(file.text);
    return {
      ...task,
      environment: {
        ...Object.fromEntries(Object.entries(fromFile).map(([name, value]) => [
          name,
          { value, mode: "replace" as const },
        ])),
        ...(task.environment ?? {}),
      },
    };
  }, []);

  const runBeforeLaunch = useCallback(async (task: WorkspaceTaskItem): Promise<number> => {
    const targetIds = task.runConfiguration?.preLaunchTargets ?? [];
    if (targetIds.length === 0) return 0;
    const targets = task.buildTargets ?? buildTargetsByRoot[task.rootId] ?? [];
    const resolved = resolveBuildTargetPlan(targetIds, targets);
    const plan = resolved.map((target): WorkspaceTaskItem => ({
        id: target.id,
        label: target.label,
        command: target.command.display,
        cwd: target.command.cwd,
        source: "Before launch",
        rootId: task.rootId,
        rootName: task.rootName,
        execution: {
          executable: target.command.executable,
          args: target.command.args,
          source: target.command.source as "wrapper" | "configured" | "path",
          error: target.command.error,
        },
        environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
          name,
          { value, mode: "replace" as const },
        ])),
    }));
    const result = await executeTaskPlan(plan, (next, done) => onRun(next, done));
    return result.exitCode;
  }, [buildTargetsByRoot, onRun]);

  const runSingleTask = useCallback(async (task: WorkspaceTaskItem): Promise<number> => {
    const beforeLaunchExit = await runBeforeLaunch(task);
    if (beforeLaunchExit !== 0) return beforeLaunchExit;
    const launchTask = await configuredTask(task);
    const result = await executeTaskPlan([launchTask], (next, done) => onRun(next, done));
    return result.exitCode;
  }, [configuredTask, onRun, runBeforeLaunch]);

  const refresh = useCallback(async () => {
    if (roots.length === 0) {
      setDetectedTasks([]);
      setRunConfigurations([]);
      setBuildTargetsByRoot({});
      setExecutionDiagnostics({});
      setLoaded(true);
      return;
    }
    setLoading(true);
    setError(null);
    setExecutionDiagnostics({});
    try {
      const groups = await Promise.all(roots.map(async (root) => {
        const overrides = readRunConfigurationOverrides(workspaceInstanceId, root.id);
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
        const projectById = new Map(executionModel.projects.map((project) => [project.id, project]));
        const javaConfigurations = javaTargets.map(javaRunTargetToExecutionRunConfiguration);
        const javaSourceFiles = new Set(javaConfigurations.flatMap((configuration) => (
          configuration.sourceFile ? [configuration.sourceFile.replace(/\\/g, "/")] : []
        )));
        const discoveredConfigurations = [
          ...executionModel.runConfigurations.filter((configuration) => (
            configuration.configurationSource === "shared"
            || !configuration.sourceFile
            || !javaSourceFiles.has(configuration.sourceFile.replace(/\\/g, "/"))
          )),
          ...javaConfigurations,
        ];
        const defaultsById = new Map(discoveredConfigurations.map((configuration) => [
          configuration.id,
          configuration,
        ]));
        const configurations = materializeRunConfigurations(
          discoveredConfigurations,
          overrides,
        ).map((configuration): WorkspaceTaskItem => {
          const project = projectById.get(configuration.projectId);
          return taskForExecutionConfiguration(
            configuration,
            root,
            project ? `${project.languages.join("/")} · ${project.provider}` : "Run configuration",
            executionModel.buildTargets,
            defaultsById.get(configuration.baseConfigurationId ?? configuration.id),
          );
        });
        return {
          tasks: detected,
          configurations,
          buildTargets: executionModel.buildTargets,
          diagnostics: executionModel.diagnostics ?? [],
        };
      }));
      setDetectedTasks(groups.flatMap((group) => group.tasks));
      setRunConfigurations(groups.flatMap((group) => group.configurations));
      setBuildTargetsByRoot(Object.fromEntries(roots.map((root, index) => [
        root.id,
        groups[index]?.buildTargets ?? [],
      ])));
      setExecutionDiagnostics(Object.fromEntries(roots.map((root, index) => [
        root.id,
        groups[index]?.diagnostics ?? [],
      ])));
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [roots, toolConfig, workspaceInstanceId]);

  const deleteNamedConfiguration = useCallback((configuration: WorkspaceTaskItem) => {
    const override = readRunConfigurationOverrides(workspaceInstanceId, configuration.rootId)[configuration.id];
    if (!override?.baseConfigurationId) return;
    writeRunConfigurationOverride(workspaceInstanceId, configuration.id, null, configuration.rootId);
    const selections = readActiveRunConfigurationSelections(workspaceInstanceId);
    for (const [sourceFile, selectedId] of Object.entries(selections)) {
      if (selectedId === configuration.id) {
        writeActiveRunConfigurationSelection(
          workspaceInstanceId,
          sourceFile,
          override.baseConfigurationId,
        );
      }
    }
    setEditingConfiguration(null);
    void refresh();
  }, [refresh, workspaceInstanceId]);

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
    const finishHistory = (exitCode: number, message?: string) => {
      setHistory((current) => current.map((historyEntry) => historyEntry.id === historyId
        ? {
            ...historyEntry,
            status: exitCode === 0 ? "passed" : "failed",
            exitCode,
            message,
          }
        : historyEntry));
      afterExit?.(exitCode);
    };
    if (task.execution?.error) {
      finishHistory(1, task.execution.error);
      return;
    }
    const compoundIds = task.runConfiguration?.compoundConfigurationIds;
    if (task.runConfiguration?.kind === "compound" && (
      !compoundIds?.length || !!task.runConfiguration.command.error
    )) {
      finishHistory(
        1,
        task.runConfiguration.command.error ?? "Compound configuration has no valid Run children",
      );
      return;
    }
    if (compoundIds?.length) {
      const candidates = task.configurationCatalog !== undefined
        ? task.configurationCatalog.map((configuration) => taskForExecutionConfiguration(
            configuration,
            { id: task.rootId, name: task.rootName },
            "Run configuration",
            task.buildTargets ?? buildTargetsByRoot[task.rootId] ?? [],
          ))
        : runConfigurations.filter((item) => item.rootId === task.rootId);
      const configurationNodes = candidates
        .filter((item) => item.id !== task.id && item.runConfiguration)
        .map((item) => ({
          ...item.runConfiguration!,
          id: item.id,
        }));
      const rootNode = {
        ...task.runConfiguration,
        id: task.id,
      };
      const taskById = new Map(candidates.map((item) => [item.id, item]));
      const run = async () => {
        try {
          const result = await executeCompoundConfiguration(
            rootNode,
            configurationNodes,
            async (node) => {
              const candidate = node.id === task.id ? task : taskById.get(node.id);
              if (!candidate) return 1;
              return runBeforeLaunch(candidate);
            },
            async (node) => {
              const candidate = node.id === task.id ? task : taskById.get(node.id);
              if (!candidate) return 1;
              const launchTask = await configuredTask(candidate);
              const result = await executeTaskPlan([launchTask], (next, done) => onRun(next, done));
              return result.exitCode;
            },
          );
          finishHistory(result.exitCode);
        } catch (error) {
          finishHistory(1, error instanceof Error ? error.message : String(error));
        }
      };
      void run();
      return;
    }
    // Keep the common task path synchronous. This preserves the integrated
    // terminal's immediate-start behavior; only configured env files or
    // Before launch targets need asynchronous planning.
    if (!task.runConfiguration?.envFile?.trim() && !task.runConfiguration?.preLaunchTargets?.length) {
      onRun(task, finishHistory);
      return;
    }
    const run = async () => {
      try {
        const exitCode = await runSingleTask(task);
        finishHistory(exitCode);
      } catch (error) {
        finishHistory(1, error instanceof Error ? error.message : String(error));
      }
    };
    void run();
  }, [buildTargetsByRoot, configuredTask, onRun, runBeforeLaunch, runConfigurations, runSingleTask]);

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
    const isCompound = !!task.runConfiguration?.compoundConfigurationIds?.length;
    const toolError = task.execution?.error;
    return (
      <div key={`${task.rootId}:${task.id}`} className="group flex items-center gap-1 rounded hover:bg-[var(--taomni-code-active-line-bg)]">
        <button
          type="button"
          data-testid={task.configuration ? `run-panel-configuration-${task.id}` : undefined}
          data-configuration-kind={isCompound ? "compound" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
          title={toolError ? toolError : isCompound ? "Compound configuration" : `${task.command} — ${task.cwd}`}
          onClick={() => runTask(task)}
          disabled={!!toolError}
        >
          {toolError
            ? <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
            : <Play className="h-3 w-3 shrink-0 text-emerald-500" />}
          <span className="truncate">{task.label}</span>
          <span className="ml-auto shrink-0 text-[10px] text-[var(--taomni-code-muted)]">{task.source}</span>
          {task.runConfiguration && (
            <span
              data-testid={`run-panel-configuration-source-${task.id}`}
              data-configuration-source={task.runConfiguration.configurationSource ?? "detected"}
              className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]"
              title={`Configuration source: ${configurationSourceLabel(task.runConfiguration.configurationSource)}`}
            >
              {configurationSourceLabel(task.runConfiguration.configurationSource)}
            </span>
          )}
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
            data-testid={`run-panel-configuration-copy-${task.id}`}
            aria-label={`Copy run configuration ${task.label}`}
            title="Create named run configuration"
            className="h-6 w-6 shrink-0 rounded opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={() => {
              const base = task.runConfiguration;
              if (!base) return;
              const copyName = `${task.label} copy`;
              const id = createNamedRunConfiguration(workspaceInstanceId, base, copyName, task.rootId);
              const copy = readRunConfigurationOverrides(workspaceInstanceId, task.rootId)[id];
              setEditingConfiguration({ rootId: task.rootId, configurationId: id });
              setConfigurationDraft({
                name: copy?.name ?? copyName,
                cwd: copy?.cwd ?? "",
                args: copy?.args.join("\n") ?? "",
                vmOptions: copy?.vmOptions?.join("\n") ?? "",
                env: formatEnvironmentLines(copy?.env ?? {}),
                envFile: copy?.envFile ?? "",
                preLaunchTargets: (copy?.preLaunchTargets ?? base.preLaunchTargets).join("\n"),
              });
              void refresh();
            }}
          >
            <CopyPlus className="mx-auto h-3.5 w-3.5" />
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
              openConfigurationEditor(task);
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
          {Object.values(executionDiagnostics).some((items) => items.length > 0) && (
            <div
              data-testid="run-panel-execution-diagnostics"
              role="status"
              className="mb-2 space-y-1 border-b border-amber-500/30 pb-2 text-amber-600 dark:text-amber-400"
            >
              <div className="font-medium">Execution configuration diagnostics</div>
              {roots.flatMap((root) => (executionDiagnostics[root.id] ?? []).map((diagnostic) => (
                <div key={`${root.id}:${diagnostic}`} className="whitespace-pre-wrap">
                  {root.name}: {diagnostic}
                </div>
              )))}
            </div>
          )}
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
          {editingConfiguration && (() => {
            const configuration = runConfigurations.find((item) => (
              item.id === editingConfiguration.configurationId
              && item.rootId === editingConfiguration.rootId
            ));
            if (!configuration) return null;
            return (
              <div data-testid="run-configuration-editor" className="mb-3 space-y-2 border-b border-[var(--taomni-code-border)] pb-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{configuration.label}</span>
                  {configuration.runConfiguration?.baseConfigurationId ? (
                    <button
                      type="button"
                      data-testid="run-configuration-delete"
                      aria-label="Delete run configuration"
                      title="Delete run configuration"
                      className="h-6 w-6 rounded text-red-500"
                      onClick={() => deleteNamedConfiguration(configuration)}
                    >
                      <Trash2 className="mx-auto h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="run-configuration-reset"
                      aria-label="Reset run configuration overrides"
                      title="Reset run configuration overrides"
                      className="h-6 w-6 rounded"
                      onClick={() => {
                        const defaults = configuration.runConfigurationDefaults
                          ?? configuration.runConfiguration;
                        writeRunConfigurationOverride(
                          workspaceInstanceId,
                          configuration.id,
                          null,
                          configuration.rootId,
                        );
                        setConfigurationDraft({
                          name: defaults?.label ?? configuration.label,
                          cwd: "",
                          args: "",
                          vmOptions: defaults?.runtimeOptions?.join("\n") ?? "",
                          env: "",
                          envFile: defaults?.envFile ?? "",
                          preLaunchTargets: defaults?.preLaunchTargets.join("\n") ?? "",
                        });
                        void refresh();
                      }}
                    >
                      <RefreshCw className="mx-auto h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="run-configuration-save"
                    aria-label="Save run configuration"
                    title="Save run configuration"
                    className="h-6 w-6 rounded"
                    onClick={() => {
                      const existing = readRunConfigurationOverrides(
                        workspaceInstanceId,
                        configuration.rootId,
                      )[configuration.id];
                      writeRunConfigurationOverride(workspaceInstanceId, configuration.id, {
                        name: configurationDraft.name,
                        baseConfigurationId: existing?.baseConfigurationId ?? "",
                        args: configurationDraft.args.split(/\r?\n/).filter((value) => value.length > 0),
                        vmOptions: configurationDraft.vmOptions.split(/\r?\n/).filter((value) => value.length > 0),
                        cwd: configurationDraft.cwd,
                        env: parseEnvironmentLines(configurationDraft.env),
                        envFile: configurationDraft.envFile,
                        preLaunchTargets: configurationDraft.preLaunchTargets
                          .split(/\r?\n/)
                          .map((value) => value.trim())
                          .filter(Boolean),
                      }, configuration.rootId);
                      void refresh();
                    }}
                  >
                    <Check className="mx-auto h-3.5 w-3.5" />
                  </button>
                </div>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Name</span>
                  <input
                    data-testid="run-configuration-name"
                    value={configurationDraft.name}
                    onChange={(event) => setConfigurationDraft((current) => ({ ...current, name: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5"
                  />
                </label>
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
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">VM / runtime options</span>
                  <textarea
                    data-testid="run-configuration-vm-options"
                    value={configurationDraft.vmOptions}
                    onChange={(event) => setConfigurationDraft((current) => ({ ...current, vmOptions: event.target.value }))}
                    rows={2}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
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
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Environment file</span>
                  <input
                    data-testid="run-configuration-env-file"
                    value={configurationDraft.envFile}
                    placeholder=".env or an absolute path"
                    onChange={(event) => setConfigurationDraft((current) => ({ ...current, envFile: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 font-mono"
                  />
                </label>
                <fieldset className="space-y-1" data-testid="run-configuration-before-launch">
                  <legend className="text-[10px] text-[var(--taomni-code-muted)]">Before launch</legend>
                  {(buildTargetsByRoot[configuration.rootId] ?? []).map((target) => {
                    const selected = configurationDraft.preLaunchTargets.split(/\r?\n/).includes(target.id);
                    return (
                      <label key={target.id} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          data-testid={`run-configuration-before-launch-${target.id}`}
                          checked={selected}
                          onChange={(event) => setConfigurationDraft((current) => {
                            const ids = current.preLaunchTargets
                              .split(/\r?\n/)
                              .map((value) => value.trim())
                              .filter(Boolean);
                            const next = event.target.checked
                              ? [...new Set([...ids, target.id])]
                              : ids.filter((id) => id !== target.id);
                            return { ...current, preLaunchTargets: next.join("\n") };
                          })}
                        />
                        <span>{target.label}</span>
                      </label>
                    );
                  })}
                </fieldset>
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
              {entry.message && (
                <span className="max-w-[45%] truncate text-red-500" title={entry.message}>
                  {entry.message}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
});
