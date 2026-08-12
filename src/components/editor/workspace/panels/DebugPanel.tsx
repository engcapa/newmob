import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  Bug,
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Eraser,
  FlameKindling,
  Pause,
  Plug,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import type { CodeDebugSession } from "../useCodeDebugSession";
import { sortedBreakpoints, type DebugBreakpoint, type DebugStackFrame } from "../dapDebugModel";

interface DebugPanelProps {
  debug: CodeDebugSession;
  /** Start debugging the active file (parent builds the launch config). */
  onStart: (() => void) | null;
  /** Attach to a remote JVM (IDEA "Remote JVM Debug"); null when unavailable. */
  onAttach?: (() => void) | null;
  /** Reveal a stack frame's source location. */
  onOpenFrame: (frame: DebugStackFrame) => void;
  /** Reveal a breakpoint's line from the breakpoints view. */
  onOpenBreakpoint?: (path: string, line: number) => void;
  /**
   * Breakpoint whose editor should be open (gutter right-click / Ctrl+Shift+F8
   * routes here instead of opening a chain of modal prompts).
   */
  editingBreakpoint?: { path: string; line: number } | null;
  onEditingBreakpointChange?: (target: { path: string; line: number } | null) => void;
  /**
   * False in the browser dev-preview, where the DAP backend is unavailable.
   * The panel then explains the desktop requirement instead of implying that
   * pressing start would work.
   */
  runtimeAvailable?: boolean;
  /** Run/Debug configurations associated with the active source file. */
  configurations?: Array<{ id: string; label: string }>;
  activeConfigurationId?: string | null;
  onActiveConfigurationChange?: (configurationId: string) => void;
}

/** One expandable variables node (D4) — children fetched lazily on expand. */
interface VarNode {
  name: string;
  value: string;
  type: string | null;
  variablesReference: number;
  /** `variablesReference` of the container (scope/object) this node lives in. */
  parentRef: number;
  children: VarNode[] | null; // null = not yet loaded
  expanded: boolean;
}

function parseVariables(body: unknown, parentRef: number): VarNode[] {
  const list = body && typeof body === "object" ? (body as { variables?: unknown }).variables : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const rec = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    if (typeof rec.name !== "string") return [];
    return [{
      name: rec.name,
      value: typeof rec.value === "string" ? rec.value : "",
      type: typeof rec.type === "string" ? rec.type : null,
      variablesReference: typeof rec.variablesReference === "number" ? rec.variablesReference : 0,
      parentRef,
      children: null,
      expanded: false,
    }];
  });
}

/** Immutable tree update: replace `target` (by identity) via `update`. */
function updateNode(nodes: VarNode[], target: VarNode, update: (n: VarNode) => VarNode): VarNode[] {
  return nodes.map((n) => {
    if (n === target) return update(n);
    return n.children ? { ...n, children: updateNode(n.children, target, update) } : n;
  });
}

interface VarEditState {
  node: VarNode | null;
  value: string;
}

function VariableRow({
  node,
  depth,
  onExpand,
  onStartEdit,
  edit,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onRemove,
}: {
  node: VarNode;
  depth: number;
  onExpand: (node: VarNode) => void;
  /** Present when the value is editable (DAP setVariable). */
  onStartEdit?: (node: VarNode) => void;
  edit?: VarEditState;
  onEditChange?: (value: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
  /** Present on watch roots: remove the watch expression. */
  onRemove?: () => void;
}) {
  const expandable = node.variablesReference > 0;
  const editing = edit?.node === node;
  return (
    <>
      <div
        className="group flex items-start gap-1 py-0.5 pr-2 hover:bg-[var(--taomni-hover-bg)]"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {expandable ? (
          <button type="button" className="shrink-0" onClick={() => onExpand(node)}>
            {node.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        <span className="shrink-0 text-[var(--taomni-text)]" title={node.type ?? undefined}>{node.name}</span>
        {editing ? (
          <input
            autoFocus
            data-testid="debug-variable-edit-input"
            className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 font-mono text-[11px] outline-none"
            value={edit?.value ?? ""}
            onChange={(e) => onEditChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit?.();
              else if (e.key === "Escape") onEditCancel?.();
            }}
            onBlur={() => onEditCancel?.()}
          />
        ) : (
          <span
            className="truncate text-[var(--taomni-text-muted)]"
            title={onStartEdit ? "Double-click to change the value" : undefined}
            onDoubleClick={onStartEdit ? () => onStartEdit(node) : undefined}
          >
            = {node.value}
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            className="ml-auto shrink-0 text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
            onClick={onRemove}
            title="Remove watch"
          >
            ×
          </button>
        )}
      </div>
      {node.expanded && node.children?.map((child, i) => (
        <VariableRow
          key={`${child.name}:${i}`}
          node={child}
          depth={depth + 1}
          onExpand={onExpand}
          onStartEdit={onStartEdit}
          edit={edit}
          onEditChange={onEditChange}
          onEditSubmit={onEditSubmit}
          onEditCancel={onEditCancel}
        />
      ))}
    </>
  );
}

/**
 * Breakpoints view (IDEA's breakpoints dialog, inline): every breakpoint in the
 * workspace with enable/disable, condition / hit count / log message editing,
 * removal, and click-to-reveal. Language-agnostic — it renders the DAP fields.
 */
function BreakpointsView({
  debug,
  editing,
  setEditing,
  onOpenBreakpoint,
}: {
  debug: CodeDebugSession;
  editing: { path: string; line: number } | null;
  setEditing: (target: { path: string; line: number } | null) => void;
  onOpenBreakpoint?: (path: string, line: number) => void;
}) {
  const entries = Object.entries(debug.breakpoints)
    .flatMap(([path, list]) => sortedBreakpoints(list).map((bp) => ({ path, bp })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line);

  if (entries.length === 0) {
    return <Empty text="No breakpoints. Click a line's gutter, or press Ctrl+F8." />;
  }
  return (
    <>
      {entries.map(({ path, bp }) => {
        const open = editing?.path === path && editing.line === bp.line;
        const disabled = bp.enabled === false;
        // Adapter binding state for this line (in-session only): surface a
        // pending/failed reason so an unhittable breakpoint is not silent.
        const runtime = debug.breakpointRuntime[path]?.[bp.line];
        const sessionRunning = !!debug.state && debug.state.status !== "terminated";
        const bindingHint = sessionRunning && !disabled && runtime && runtime.status !== "verified"
          ? { status: runtime.status, message: runtime.message }
          : null;
        return (
          <div key={`${path}:${bp.line}`} className="border-b border-[var(--taomni-code-border)]/40 last:border-b-0">
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-breakpoint-enabled-${bp.line}`}
                checked={!disabled}
                title={disabled ? "Enable breakpoint" : "Disable breakpoint"}
                onChange={(e) => debug.setBreakpointOptions(path, bp.line, { enabled: e.target.checked })}
              />
              <button
                type="button"
                data-testid={`debug-breakpoint-${bp.line}`}
                className={`min-w-0 flex-1 truncate text-left ${disabled ? "text-[var(--taomni-text-muted)] line-through" : ""}`}
                onClick={() => onOpenBreakpoint?.(path, bp.line)}
                title={`${path}:${bp.line}`}
              >
                {path.split(/[\\/]/).pop()}:{bp.line}
                {bp.condition && <span className="ml-2 text-amber-500">if {bp.condition}</span>}
                {bp.hitCondition && <span className="ml-2 text-amber-500">hit {bp.hitCondition}</span>}
                {bp.logMessage && <span className="ml-2 text-sky-500">log</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-breakpoint-binding-${bp.line}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-testid={`debug-breakpoint-edit-${bp.line}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditing(open ? null : { path, line: bp.line })}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-breakpoint-remove-${bp.line}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                onClick={() => debug.removeBreakpoint(path, bp.line)}
                title="Remove breakpoint"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <BreakpointEditor
                breakpoint={bp}
                onChange={(options) => debug.setBreakpointOptions(path, bp.line, options)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** The condition / hit count / log message fields for one breakpoint. */
function BreakpointEditor({
  breakpoint,
  onChange,
}: {
  breakpoint: DebugBreakpoint;
  onChange: (options: Partial<DebugBreakpoint>) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  // Committed on blur / Enter so every keystroke does not re-push to the adapter.
  const commit = (key: keyof DebugBreakpoint) => (value: string) => {
    onChange({ [key]: value.trim() || undefined });
  };
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-breakpoint-condition-${breakpoint.line}`}
        className={field}
        placeholder="break only when true, e.g. i > 10"
        initialValue={breakpoint.condition ?? ""}
        onCommit={commit("condition")}
      />
      <CommitField
        label="Hit count"
        testId={`debug-breakpoint-hit-${breakpoint.line}`}
        className={field}
        placeholder="e.g. 5 — break on the 5th hit"
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={commit("hitCondition")}
      />
      <CommitField
        label="Log message"
        testId={`debug-breakpoint-log-${breakpoint.line}`}
        className={field}
        placeholder="log instead of breaking; {expr} interpolates"
        initialValue={breakpoint.logMessage ?? ""}
        onCommit={commit("logMessage")}
      />
    </div>
  );
}

/** Text field that reports its value on Enter or blur, not per keystroke. */
function CommitField({
  label,
  testId,
  className,
  placeholder,
  initialValue,
  onCommit,
}: {
  label: string;
  testId: string;
  className: string;
  placeholder: string;
  initialValue: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <label className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[var(--taomni-text-muted)]">{label}</span>
      <input
        data-testid={testId}
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== initialValue) onCommit(value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") setValue(initialValue);
        }}
      />
    </label>
  );
}

function consoleLineClass(category: string): string {
  switch (category) {
    case "stderr":
    case "error":
      return "text-rose-500 dark:text-rose-400";
    case "repl":
      return "text-sky-600 dark:text-sky-400";
    case "console":
    case "important":
      return "text-[var(--taomni-text-muted)] italic";
    default:
      return "text-[var(--taomni-text)]";
  }
}

export function DebugPanel({
  debug,
  onStart,
  onAttach,
  onOpenFrame,
  onOpenBreakpoint,
  editingBreakpoint = null,
  onEditingBreakpointChange,
  runtimeAvailable = true,
  configurations = [],
  activeConfigurationId = null,
  onActiveConfigurationChange,
}: DebugPanelProps) {
  const { state } = debug;
  const running = !!state && state.status !== "terminated";
  const stopped = state?.status === "stopped";
  const canSetVariable = debug.capabilities.supportsSetVariable === true;
  const canRestartFrame = debug.capabilities.supportsRestartFrame === true;
  const [variables, setVariables] = useState<VarNode[]>([]);
  const [watchNodes, setWatchNodes] = useState<VarNode[]>([]);
  const [watchTick, setWatchTick] = useState(0);
  const [watchInput, setWatchInput] = useState("");
  const [consoleInput, setConsoleInput] = useState("");
  const [edit, setEdit] = useState<VarEditState>({ node: null, value: "" });
  const consoleRef = useRef<HTMLDivElement | null>(null);

  // Stable hook callbacks (useCallback in useCodeDebugSession) — effects key on
  // these instead of the per-render `debug` object so a parent re-render does
  // not re-fetch scopes / re-evaluate watches against the adapter.
  const { fetchScopes, fetchVariables, evaluate, setVariable: sessionSetVariable } = debug;

  // On each stop, load the selected frame's scopes → variables (D4).
  const frameId = stopped ? state?.selectedFrameId ?? state?.frames[0]?.id ?? null : null;
  useEffect(() => {
    setEdit({ node: null, value: "" });
    if (frameId == null) {
      setVariables([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const scopesBody = await fetchScopes(frameId);
      const scopes = (scopesBody && typeof scopesBody === "object"
        ? (scopesBody as { scopes?: unknown }).scopes
        : null);
      const refs = Array.isArray(scopes)
        ? scopes.flatMap((s) => {
            const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
            return typeof rec.variablesReference === "number" && rec.variablesReference > 0
              ? [{ name: String(rec.name ?? "scope"), ref: rec.variablesReference }]
              : [];
          })
        : [];
      const roots: VarNode[] = [];
      for (const scope of refs) {
        const vars = parseVariables(await fetchVariables(scope.ref), scope.ref);
        roots.push({
          name: scope.name,
          value: "",
          type: null,
          variablesReference: scope.ref,
          parentRef: 0,
          children: vars,
          expanded: true,
        });
      }
      if (!cancelled) setVariables(roots);
    })();
    return () => { cancelled = true; };
  }, [fetchScopes, fetchVariables, frameId]);

  // Re-evaluate watch expressions on each stop / frame change / edit.
  const watchExpressions = debug.watchExpressions;
  useEffect(() => {
    let cancelled = false;
    if (!stopped || frameId == null) {
      setWatchNodes(watchExpressions.map((expr) => ({
        name: expr, value: "", type: null, variablesReference: 0, parentRef: 0, children: null, expanded: false,
      })));
      return;
    }
    void (async () => {
      const next = await Promise.all(watchExpressions.map(async (expr) => {
        const result = await evaluate(expr, "watch");
        return {
          name: expr,
          value: result.value,
          type: result.type,
          variablesReference: result.variablesReference,
          parentRef: 0,
          children: null,
          expanded: false,
        };
      }));
      if (!cancelled) setWatchNodes(next);
    })();
    return () => { cancelled = true; };
  }, [evaluate, stopped, frameId, watchExpressions, watchTick]);

  // Keep the console pinned to the latest output.
  const outputLength = state?.output.length ?? 0;
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outputLength]);

  const makeExpandHandler = useCallback((
    setNodes: React.Dispatch<React.SetStateAction<VarNode[]>>,
  ) => (node: VarNode) => {
    setNodes((current) => updateNode(current, node, (n) => ({ ...n, expanded: !n.expanded })));
    if (!node.expanded && node.children === null && node.variablesReference > 0) {
      void fetchVariables(node.variablesReference).then((body) => {
        const children = parseVariables(body, node.variablesReference);
        setNodes((current) => updateNode(current, node, (n) => ({ ...n, children, expanded: true })));
      });
    }
  }, [fetchVariables]);

  const expandVariable = makeExpandHandler(setVariables);
  const expandWatch = makeExpandHandler(setWatchNodes);

  const startEdit = useCallback((node: VarNode) => {
    setEdit({ node, value: node.value });
  }, []);

  const submitEdit = useCallback(() => {
    const node = edit.node;
    const value = edit.value;
    setEdit({ node: null, value: "" });
    if (!node) return;
    void sessionSetVariable(node.parentRef, node.name, value).then((result) => {
      if (!result) return;
      setVariables((current) => updateNode(current, node, (n) => ({
        ...n,
        value: result.value,
        type: result.type ?? n.type,
        variablesReference: result.variablesReference,
        children: null,
        expanded: false,
      })));
      // Watch values may depend on the changed variable.
      setWatchTick((tick) => tick + 1);
    });
  }, [sessionSetVariable, edit]);

  const cancelEdit = useCallback(() => setEdit({ node: null, value: "" }), []);

  const addWatch = useCallback(() => {
    const expr = watchInput.trim();
    if (!expr) return;
    setWatchInput("");
    debug.addWatchExpression(expr);
  }, [debug, watchInput]);

  const submitConsole = useCallback(() => {
    const expr = consoleInput.trim();
    if (!expr) return;
    setConsoleInput("");
    debug.logConsole("repl", `> ${expr}\n`);
    void debug.evaluate(expr, "repl").then((result) => {
      debug.logConsole("result", `${result.value}\n`);
    });
  }, [debug, consoleInput]);
  const controlBtn = "h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-30 disabled:pointer-events-none";
  return (
    <div data-testid="code-workspace-debug-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="h-8 shrink-0 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        <Bug className="h-4 w-4" />
        <span className="font-medium">Debug</span>
        {state && (
          <span className="ml-1 text-[10px] text-[var(--taomni-text-muted)]">
            {state.status}{state.stoppedReason ? ` · ${state.stoppedReason}` : ""}
          </span>
        )}
        {!running && configurations.length > 0 && (
          <select
            data-testid="debug-active-configuration"
            aria-label="Debug configuration"
            title="Select Run/Debug configuration"
            value={activeConfigurationId ?? configurations[0].id}
            onChange={(event) => onActiveConfigurationChange?.(event.target.value)}
            className="ml-2 h-6 min-w-0 max-w-52 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
          >
            {configurations.map((configuration) => (
              <option key={configuration.id} value={configuration.id}>{configuration.label}</option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-0.5 shadow-xs">
          {!running && (
            <>
              <button
                type="button"
                data-testid="debug-start"
                className={`${controlBtn} hover:bg-emerald-500/15`}
                onClick={() => onStart?.()}
                disabled={!onStart}
                title="Start debugging the active file"
              >
                <CirclePlay className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              </button>
              {onAttach && (
                <button
                  type="button"
                  data-testid="debug-attach"
                  className={`${controlBtn} hover:bg-sky-500/15`}
                  onClick={() => onAttach()}
                  title="Attach to a remote JVM (host:port)"
                >
                  <Plug className="h-4 w-4 text-sky-500 dark:text-sky-400" />
                </button>
              )}
              {debug.canRestart && (
                <button
                  type="button"
                  data-testid="debug-restart"
                  className={`${controlBtn} hover:bg-emerald-500/15`}
                  onClick={() => debug.restart()}
                  title="Rerun the last debug session"
                >
                  <RotateCcw className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
                </button>
              )}
            </>
          )}
          {running && (
            <>
              <button
                type="button"
                data-testid="debug-continue"
                className={`${controlBtn} hover:bg-emerald-500/15`}
                onClick={() => debug.step("continue")}
                disabled={!stopped}
                title="Continue"
              >
                <CirclePlay className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              </button>
              <button
                type="button"
                data-testid="debug-pause"
                className={`${controlBtn} hover:bg-amber-500/15`}
                onClick={() => debug.step("pause")}
                disabled={stopped}
                title="Pause"
              >
                <Pause className="h-4 w-4 text-amber-500 dark:text-amber-400" />
              </button>
              <button
                type="button"
                data-testid="debug-step-over"
                className={`${controlBtn} hover:bg-sky-500/15`}
                onClick={() => debug.step("stepOver")}
                disabled={!stopped}
                title="Step over"
              >
                <ArrowRightToLine className="h-4 w-4 text-sky-500 dark:text-sky-400" />
              </button>
              <button
                type="button"
                data-testid="debug-step-in"
                className={`${controlBtn} hover:bg-indigo-500/15`}
                onClick={() => debug.step("stepIn")}
                disabled={!stopped}
                title="Step into"
              >
                <ArrowDownToLine className="h-4 w-4 text-indigo-500 dark:text-indigo-400" />
              </button>
              <button
                type="button"
                data-testid="debug-step-out"
                className={`${controlBtn} hover:bg-violet-500/15`}
                onClick={() => debug.step("stepOut")}
                disabled={!stopped}
                title="Step out"
              >
                <ArrowUpFromLine className="h-4 w-4 text-violet-500 dark:text-violet-400" />
              </button>
              <button
                type="button"
                data-testid="debug-hot-reload"
                className={`${controlBtn} hover:bg-orange-500/15`}
                onClick={() => debug.hotReload()}
                title="Hot reload changed classes"
              >
                <FlameKindling className="h-4 w-4 text-orange-500 dark:text-orange-400" />
              </button>
              <button
                type="button"
                data-testid="debug-restart"
                className={`${controlBtn} hover:bg-emerald-500/15`}
                onClick={() => debug.restart()}
                title="Restart the debug session"
              >
                <RotateCcw className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              </button>
              <button
                type="button"
                data-testid="debug-stop"
                className={`${controlBtn} hover:bg-rose-500/15`}
                onClick={() => debug.terminate()}
                title="Stop"
              >
                <Square className="h-4 w-4 text-rose-500 dark:text-rose-400" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!state && (
          <div className="px-3 py-2 text-[var(--taomni-text-muted)]" data-testid="debug-empty-state">
            {runtimeAvailable
              ? "No debug session. Open a Java file and press start (requires the java-debug bundle)."
              : "Java debugging runs in the desktop app only. Start Taomni with the desktop runtime (pnpm tauri dev) to debug; the browser preview has no debug adapter."}
          </div>
        )}
        <Section
          title="Breakpoints"
          defaultOpen={!state}
          forceOpen={!!editingBreakpoint}
          actions={(
            <>
              <SectionAction
                testId="debug-mute-breakpoints"
                label={debug.breakpointsMuted ? "Unmute breakpoints" : "Mute breakpoints"}
                active={debug.breakpointsMuted}
                onClick={() => debug.setBreakpointsMuted(!debug.breakpointsMuted)}
              >
                <Eraser className="h-3 w-3" />
              </SectionAction>
              <SectionAction
                testId="debug-remove-all-breakpoints"
                label="Remove all breakpoints"
                onClick={() => debug.removeAllBreakpoints()}
              >
                <Trash2 className="h-3 w-3" />
              </SectionAction>
            </>
          )}
        >
          <BreakpointsView
            debug={debug}
            editing={editingBreakpoint}
            setEditing={(target) => onEditingBreakpointChange?.(target)}
            onOpenBreakpoint={onOpenBreakpoint}
          />
        </Section>
        {state && (
          <>
            {state.exceptionInfo && (
              <div
                data-testid="debug-exception-info"
                className="border-b border-[var(--taomni-code-border)] bg-rose-500/10 px-3 py-2"
              >
                <div className="font-medium text-rose-600 dark:text-rose-400">{state.exceptionInfo.exceptionId}</div>
                {state.exceptionInfo.description && (
                  <div className="text-rose-600/90 dark:text-rose-400/90">{state.exceptionInfo.description}</div>
                )}
                {state.exceptionInfo.details && (
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-[var(--taomni-text-muted)]">
                    {state.exceptionInfo.details}
                  </pre>
                )}
              </div>
            )}
            {state.threads.length > 0 && (
              <Section title={`Threads (${state.threads.length})`} defaultOpen={false}>
                {state.threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    data-testid={`debug-thread-${thread.id}`}
                    className={`w-full flex items-center gap-2 px-3 py-0.5 text-left hover:bg-[var(--taomni-hover-bg)] ${
                      thread.id === state.selectedThreadId ? "bg-[var(--taomni-hover-bg)]" : ""
                    }`}
                    onClick={() => debug.selectThread(thread.id)}
                    disabled={!stopped}
                  >
                    <span className="truncate">{thread.name}</span>
                    {thread.id === state.stoppedThreadId && (
                      <Pause className="ml-auto h-3 w-3 shrink-0 text-amber-500" />
                    )}
                  </button>
                ))}
              </Section>
            )}
            <Section title="Call Stack">
              {state.frames.length === 0
                ? <Empty text={stopped ? "No frames" : "Running…"} />
                : state.frames.map((frame) => (
                  <div
                    key={frame.id}
                    className={`group flex items-center hover:bg-[var(--taomni-hover-bg)] ${
                      frame.id === state.selectedFrameId ? "bg-[var(--taomni-hover-bg)]" : ""
                    }`}
                  >
                    <button
                      type="button"
                      data-testid={`debug-frame-${frame.id}`}
                      className="min-w-0 flex-1 flex items-center gap-2 px-3 py-0.5 text-left"
                      onClick={() => {
                        debug.selectFrame(frame.id);
                        // Library frames have no readable path but can still be
                        // opened via the adapter's `source` request.
                        if (frame.path || frame.sourceReference > 0) onOpenFrame(frame);
                      }}
                    >
                      <span
                        className={`truncate ${
                          frame.path || frame.sourceReference > 0 ? "" : "text-[var(--taomni-text-muted)]"
                        }`}
                      >
                        {frame.name}
                      </span>
                      {(frame.path || frame.sourceName) && (
                        <span className="ml-auto shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
                          {(frame.path?.split(/[\\/]/).pop()) ?? frame.sourceName}:{frame.line}
                        </span>
                      )}
                    </button>
                    {canRestartFrame && stopped && (
                      <button
                        type="button"
                        data-testid={`debug-restart-frame-${frame.id}`}
                        className="shrink-0 px-1 opacity-0 group-hover:opacity-100 hover:text-emerald-500"
                        onClick={() => debug.restartFrame(frame.id)}
                        title="Restart frame (re-enter from its start)"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
            </Section>
            <Section title="Variables">
              {variables.length === 0
                ? <Empty text={stopped ? "No variables" : "Stopped only"} />
                : variables.map((node, i) => (
                  <VariableRow
                    key={`${node.name}:${i}`}
                    node={node}
                    depth={0}
                    onExpand={expandVariable}
                    onStartEdit={canSetVariable && stopped ? startEdit : undefined}
                    edit={edit}
                    onEditChange={(value) => setEdit((current) => ({ ...current, value }))}
                    onEditSubmit={submitEdit}
                    onEditCancel={cancelEdit}
                  />
                ))}
            </Section>
            <Section title="Watch">
              <div className="flex items-center gap-1 px-3 py-1">
                <input
                  data-testid="debug-watch-input"
                  className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none"
                  placeholder="Add expression"
                  value={watchInput}
                  onChange={(e) => setWatchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addWatch(); }}
                />
              </div>
              {watchNodes.map((node, i) => (
                <VariableRow
                  key={`${node.name}:${i}`}
                  node={node}
                  depth={0}
                  onExpand={expandWatch}
                  onRemove={() => debug.removeWatchExpression(i)}
                />
              ))}
            </Section>
            <Section
              title="Console"
              actions={(
                <SectionAction
                  testId="debug-console-clear"
                  label="Clear console"
                  onClick={() => debug.clearConsole()}
                >
                  <Eraser className="h-3 w-3" />
                </SectionAction>
              )}
            >
              <div
                ref={consoleRef}
                data-testid="debug-console-output"
                className="max-h-40 overflow-auto px-3 font-mono text-[10px]"
              >
                {state.output.map((line, i) => (
                  <span key={i} className={`whitespace-pre-wrap ${consoleLineClass(line.category)}`}>
                    {line.text}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1 px-3 py-1">
                <input
                  data-testid="debug-console-input"
                  className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
                  placeholder="Evaluate expression"
                  value={consoleInput}
                  disabled={!stopped}
                  onChange={(e) => setConsoleInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitConsole(); }}
                />
              </div>
            </Section>
            {debug.availableExceptionFilters.length > 0 && (
              <Section title="Exception Breakpoints">
                {debug.availableExceptionFilters.map((f) => (
                  <label key={f.filter} className="flex items-center gap-2 px-3 py-0.5">
                    <input
                      type="checkbox"
                      data-testid={`debug-exception-${f.filter}`}
                      checked={debug.enabledExceptionFilters.includes(f.filter)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...debug.enabledExceptionFilters, f.filter]
                          : debug.enabledExceptionFilters.filter((id) => id !== f.filter);
                        debug.setExceptionFilters(next);
                      }}
                    />
                    {f.label}
                  </label>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  defaultOpen = true,
  forceOpen = false,
  actions,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /** Keep the section expanded regardless of the user's toggle (e.g. editing). */
  forceOpen?: boolean;
  /** Header-right controls (mute / clear …); they do not toggle the section. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const open = expanded || forceOpen;
  // Toggling starts from the *visible* state, so collapsing a force-opened
  // section works on the first click.
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    setExpanded(typeof next === "function" ? next(open) : next);
  };
  return (
    <div className="border-b border-[var(--taomni-code-border)]">
      <div className="flex items-center pr-2">
        <button
          type="button"
          className="min-w-0 flex-1 flex items-center gap-1 px-2 py-1 text-left font-medium text-[var(--taomni-text-muted)]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function SectionAction({
  testId,
  label,
  active = false,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-5 w-5 items-center justify-center rounded ${
        active ? "text-amber-500" : "text-[var(--taomni-text-muted)]"
      } hover:bg-[var(--taomni-hover-bg)]`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-1 text-[var(--taomni-text-muted)]">{text}</div>;
}
