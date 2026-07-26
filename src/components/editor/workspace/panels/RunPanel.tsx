import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { Loader2, Play, Plus, RefreshCw } from "lucide-react";
import {
  workspaceDetectTasks,
  workspaceJavaRunTargets,
  type WorkspaceTask,
} from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";

export interface WorkspaceTaskItem extends WorkspaceTask {
  rootId: string;
  rootName: string;
  custom?: boolean;
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
  run: (task: WorkspaceTaskItem) => void;
  refresh: () => void;
}

interface RunPanelProps {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  active: boolean;
  onRun: (task: WorkspaceTaskItem, onExit: (exitCode: number) => void) => void;
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
}, ref) {
  const [detectedTasks, setDetectedTasks] = useState<WorkspaceTaskItem[]>([]);
  const [customTasks, setCustomTasks] = useState<WorkspaceTaskItem[]>(
    () => readCustomTasks(workspaceInstanceId),
  );
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [customCommand, setCustomCommand] = useState("");
  const [customRootId, setCustomRootId] = useState(roots[0]?.id ?? "");

  const refresh = useCallback(async () => {
    if (roots.length === 0) {
      setDetectedTasks([]);
      setLoaded(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const groups = await Promise.all(roots.map(async (root) => {
        const [tasks, javaTargets] = await Promise.all([
          workspaceDetectTasks(root.path),
          workspaceJavaRunTargets(root.path),
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
        }));
        return [...java, ...detected];
      }));
      setDetectedTasks(groups.flat());
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

  useEffect(() => {
    window.localStorage.setItem(customTasksKey(workspaceInstanceId), JSON.stringify(customTasks));
  }, [customTasks, workspaceInstanceId]);

  const tasks = useMemo(() => [...detectedTasks, ...customTasks], [customTasks, detectedTasks]);

  const runTask = useCallback((task: WorkspaceTaskItem) => {
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
            aria-label="Custom task root"
            value={customRootId}
            onChange={(event) => setCustomRootId(event.target.value)}
            className="h-6 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)]"
          >
            {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
          </select>
        )}
        <button type="button" aria-label="Add custom task" onClick={addCustomTask} className="h-6 w-6 rounded">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Refresh tasks" onClick={() => void refresh()} className="h-6 w-6 rounded">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)] divide-x divide-[var(--taomni-code-border)]">
        <div className="min-h-0 overflow-auto p-2">
          {error && <div className="mb-2 text-red-500">{error}</div>}
          {!loading && tasks.length === 0 && <div className="text-[var(--taomni-code-muted)]">No detected tasks</div>}
          {roots.map((root) => {
            const rootTasks = grouped.get(root.id) ?? [];
            if (rootTasks.length === 0) return null;
            return (
              <div key={root.id} className="mb-2">
                <div className="mb-1 font-semibold">{root.name}</div>
                {rootTasks.map((task) => (
                  <div key={task.id} className="group flex items-center gap-1 rounded hover:bg-[var(--taomni-code-active-line-bg)]">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
                      title={`${task.command} — ${task.cwd}`}
                      onClick={() => runTask(task)}
                    >
                      <Play className="h-3 w-3 shrink-0 text-emerald-500" />
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
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="min-h-0 overflow-auto p-2">
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
