import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Plus, TerminalSquare, X } from "lucide-react";
import { TerminalPanel } from "../../../terminal/TerminalPanel";
import { getTerminal } from "../../../../lib/terminal/terminalRegistry";
import {
  buildInteractiveCommandInput,
  renderTerminalExecutionCommand,
  renderTerminalTask,
  type TerminalTaskVariables,
} from "../../../../lib/terminal/commandInput";
import { getAppPlatform } from "../../../../lib/runtime";
import type { WorkspaceTaskExecution } from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";

interface WorkspaceTerminalInstance {
  id: string;
  title: string;
  initialCwd: string;
  workspaceRoot: string | null;
  cwd: string;
  pendingCommand: string | null;
  pendingExecution: WorkspaceTaskExecution | null;
  pendingEnvironment: TerminalTaskVariables | undefined;
  onTaskExit: ((exitCode: number) => void) | null;
}

function rootForCwd(roots: CodeWorkspaceRootInfo[], cwd: string): string | null {
  const windows = getAppPlatform() === "windows";
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const normalizedCwd = normalize(cwd);
  return roots
    .filter((root) => {
      const path = normalize(root.path);
      return normalizedCwd === path || normalizedCwd.startsWith(`${path}/`);
    })
    .sort((left, right) => right.path.length - left.path.length)[0]?.path ?? null;
}

export interface TerminalDockHandle {
  openAt: (cwd: string, title?: string) => string;
  runCommand: (
    command: string,
    cwd: string,
    title?: string,
    onExit?: (exitCode: number) => void,
    environment?: TerminalTaskVariables,
    execution?: WorkspaceTaskExecution,
  ) => string;
  focus: () => void;
}

interface TerminalDockPanelProps {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  defaultCwd: string;
  active: boolean;
}

function terminalId(workspaceInstanceId: string, sequence: number): string {
  return `workspace-terminal-${workspaceInstanceId}-${sequence}`;
}

export const TerminalDockPanel = forwardRef<TerminalDockHandle, TerminalDockPanelProps>(
  function TerminalDockPanel({ workspaceInstanceId, roots, defaultCwd, active }, ref) {
    const [instances, setInstances] = useState<WorkspaceTerminalInstance[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [selectedRootId, setSelectedRootId] = useState(roots[0]?.id ?? "");
    const sequenceRef = useRef(0);
    const rootById = useMemo(() => new Map(roots.map((root) => [root.id, root])), [roots]);

    useEffect(() => {
      if (selectedRootId && rootById.has(selectedRootId)) return;
      setSelectedRootId(roots[0]?.id ?? "");
    }, [rootById, roots, selectedRootId]);

    const createInstance = useCallback((
      cwd: string,
      title?: string,
      pendingCommand: string | null = null,
      onTaskExit: ((exitCode: number) => void) | null = null,
      pendingEnvironment: TerminalTaskVariables | undefined = undefined,
      pendingExecution: WorkspaceTaskExecution | null = null,
    ) => {
      sequenceRef.current += 1;
      const id = terminalId(workspaceInstanceId, sequenceRef.current);
      const next: WorkspaceTerminalInstance = {
        id,
        title: title?.trim() || `Terminal ${sequenceRef.current}`,
        initialCwd: cwd,
        workspaceRoot: rootForCwd(roots, cwd),
        cwd,
        pendingCommand,
        pendingExecution,
        pendingEnvironment,
        onTaskExit,
      };
      setInstances((current) => [...current, next]);
      setActiveId(id);
      return id;
    }, [roots, workspaceInstanceId]);

    useEffect(() => {
      if (!active || instances.length > 0) return;
      createInstance(defaultCwd || roots[0]?.path || "", roots[0]?.name || "Terminal");
    }, [active, createInstance, defaultCwd, instances.length, roots]);

    useImperativeHandle(ref, () => ({
      openAt: (cwd, title) => createInstance(cwd, title),
      runCommand: (command, cwd, title, onExit, environment, execution) => createInstance(
        cwd,
        title,
        command,
        onExit ?? null,
        environment,
        execution ?? null,
      ),
      focus: () => {
        if (instances.length > 0) setActiveId((current) => current ?? instances[0].id);
      },
    }), [createInstance, instances]);

    const closeInstance = useCallback((id: string) => {
      setInstances((current) => {
        const index = current.findIndex((item) => item.id === id);
        const next = current.filter((item) => item.id !== id);
        setActiveId((activeTerminalId) => activeTerminalId === id
          ? next[Math.min(index, next.length - 1)]?.id ?? null
          : activeTerminalId);
        return next;
      });
    }, []);

    const deliverPendingCommand = useCallback((id: string) => {
      let attempts = 0;
      const tryWrite = () => {
        const instance = instances.find((item) => item.id === id);
        if (!instance?.pendingCommand) return;
        const terminal = getTerminal(id);
        if (terminal) {
          const command = instance.pendingExecution
            ? renderTerminalExecutionCommand(instance.pendingExecution, terminal.localEnvironment)
            : instance.pendingCommand;
          if (terminal.runTask) {
            terminal.runTask(command, instance.pendingEnvironment);
          } else {
            // Backward-compatible path for lightweight registrants and tests.
            const task = renderTerminalTask(
              command,
              terminal.localEnvironment ?? { platform: getAppPlatform() },
              instance.pendingEnvironment,
            );
            terminal.writeInput(buildInteractiveCommandInput(task.input));
          }
          setInstances((current) => current.map((item) => item.id === id
            ? { ...item, pendingCommand: null, pendingExecution: null }
            : item));
          return;
        }
        attempts += 1;
        if (attempts < 40) window.setTimeout(tryWrite, 50);
      };
      window.setTimeout(tryWrite, 0);
    }, [instances]);

    const selectedRoot = rootById.get(selectedRootId) ?? roots[0] ?? null;

    return (
      <section
        data-testid="code-workspace-terminal-dock"
        data-workspace-focus="terminal"
        className="flex h-full min-h-0 flex-col bg-[var(--taomni-code-bg)]"
      >
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--taomni-code-border)] px-1">
          {instances.map((instance) => (
            <div
              key={instance.id}
              data-active={instance.id === activeId || undefined}
              className="flex h-7 shrink-0 items-center rounded data-[active=true]:bg-[var(--taomni-code-selection-match-bg)]"
            >
              <button
                type="button"
                className="inline-flex h-full max-w-44 items-center gap-1 px-2 text-[11px]"
                onClick={() => setActiveId(instance.id)}
                title={instance.cwd || instance.initialCwd}
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                <span className="truncate">{instance.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${instance.title}`}
                className="inline-flex h-full w-6 items-center justify-center"
                onClick={() => closeInstance(instance.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="flex-1" />
          {roots.length > 1 && (
            <select
              aria-label="Terminal root directory"
              className="h-6 max-w-40 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[11px]"
              value={selectedRootId}
              onChange={(event) => setSelectedRootId(event.target.value)}
            >
              {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
            </select>
          )}
          <button
            type="button"
            aria-label="New workspace terminal"
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => createInstance(
              selectedRoot?.path || defaultCwd,
              selectedRoot?.name || undefined,
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {instances.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-[var(--taomni-code-muted)]">
              Open the Terminal tab to start a workspace shell
            </div>
          ) : instances.map((instance) => (
            <div
              key={instance.id}
              hidden={instance.id !== activeId}
              className="absolute inset-0"
            >
              <TerminalPanel
                tabId={instance.id}
                tabTitle={instance.title}
                initialCwd={instance.initialCwd || undefined}
                workspaceRoot={instance.workspaceRoot ?? undefined}
                visible={active && instance.id === activeId}
                activeForShortcuts={active && instance.id === activeId}
                onCwdChange={(cwd) => setInstances((current) => current.map((item) => item.id === instance.id
                  ? { ...item, cwd }
                  : item))}
                onSessionReady={() => deliverPendingCommand(instance.id)}
                onTaskExit={(exitCode) => instance.onTaskExit?.(exitCode)}
              />
            </div>
          ))}
        </div>
      </section>
    );
  },
);
