import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  Bug,
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Crosshair,
  Eraser,
  FlameKindling,
  Pause,
  Plus,
  Plug,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import type { CodeDebugSession } from "../useCodeDebugSession";
import {
  breakpointModesFor,
  sortedBreakpoints,
  dataBreakpointKey,
  exceptionBreakpointRuleLabel,
  parseBreakpointModes,
  resolveBreakpointMode,
  type DebugBreakpoint,
  type DebugBreakpointMode,
  type DebugDataBreakpoint,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugExceptionBreakMode,
  type DebugFunctionBreakpoint,
  type DebugStackFrame,
} from "../dapDebugModel";

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
  configurations?: Array<{
    id: string;
    label: string;
    source?: "provider" | "shared" | "local";
    /** False when the adapter/configuration cannot be launched on this host. */
    available?: boolean;
    /** Human-readable reason surfaced when `available` is false. */
    diagnostic?: string;
  }>;
  activeConfigurationId?: string | null;
  onActiveConfigurationChange?: (configurationId: string) => void;
}

function configurationSourceLabel(
  source: NonNullable<DebugPanelProps["configurations"]>[number]["source"],
): string {
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

function configurationAvailabilityLabel(available: boolean | undefined): string {
  return available === false ? " [Unavailable]" : "";
}

/** One expandable variables node (D4) — children fetched lazily on expand. */
interface VarNode {
  name: string;
  value: string;
  type: string | null;
  variablesReference: number;
  /** `variablesReference` of the container (scope/object) this node lives in. */
  parentRef: number;
  /** Watch roots are expressions; scope roots are not valid data targets. */
  dataBreakpointExpression: boolean;
  children: VarNode[] | null; // null = not yet loaded
  expanded: boolean;
}

function variableDataBreakpointTargetKey(node: VarNode): string {
  return `${node.parentRef}:${node.dataBreakpointExpression ? "expression" : "variable"}:${node.name}`;
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
      dataBreakpointExpression: false,
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
  onAddDataBreakpoint,
  addingDataBreakpointKey,
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
  /** Present while stopped when the adapter supports data breakpoints. */
  onAddDataBreakpoint?: (node: VarNode) => void;
  addingDataBreakpointKey?: string | null;
}) {
  const expandable = node.variablesReference > 0;
  const editing = edit?.node === node;
  const dataTargetKey = variableDataBreakpointTargetKey(node);
  const dataBreakpointEligible = node.parentRef > 0 || node.dataBreakpointExpression;
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
        {(onRemove || (dataBreakpointEligible && onAddDataBreakpoint)) && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {dataBreakpointEligible && onAddDataBreakpoint && (
              <button
                type="button"
                data-testid="debug-variable-data-breakpoint"
                className="text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100 hover:text-rose-500 disabled:opacity-30"
                onClick={() => onAddDataBreakpoint(node)}
                disabled={addingDataBreakpointKey === dataTargetKey}
                title={`Add data breakpoint for ${node.name}`}
                aria-label={`Add data breakpoint for ${node.name}`}
              >
                <Crosshair className="h-3 w-3" />
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className="text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={onRemove}
                title="Remove watch"
              >
                ×
              </button>
            )}
          </div>
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
          onAddDataBreakpoint={onAddDataBreakpoint}
          addingDataBreakpointKey={addingDataBreakpointKey}
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
  dataBreakpointModes,
  dataBreakpointMode,
  onDataBreakpointModeChange,
}: {
  debug: CodeDebugSession;
  editing: { path: string; line: number } | null;
  setEditing: (target: { path: string; line: number } | null) => void;
  onOpenBreakpoint?: (path: string, line: number) => void;
  dataBreakpointModes: DebugBreakpointMode[];
  dataBreakpointMode: string | undefined;
  onDataBreakpointModeChange: (mode: string) => void;
}) {
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const sourceModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "source");
  const entries = Object.entries(debug.breakpoints)
    .flatMap(([path, list]) => sortedBreakpoints(list).map((bp) => ({ path, bp })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line);

  return (
    <>
      {entries.length === 0 && (
        <Empty text="No line breakpoints. Click a line's gutter, or press Ctrl+F8." />
      )}
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
        const sourceMode = activeSession
          ? resolveBreakpointMode(bp.adapterModes?.[activeSession.adapterId], sourceModes, "source")
          : undefined;
        const sourceModeMetadata = sourceModes.find((mode) => mode.mode === sourceMode);
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
                {sourceModeMetadata && (
                  <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                    {sourceModeMetadata.label}
                  </span>
                )}
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
                adapterId={activeSession?.adapterId ?? null}
                modes={sourceModes}
                onChange={(options) => debug.setBreakpointOptions(path, bp.line, options)}
                onModeChange={(mode) => debug.setBreakpointMode(path, bp.line, mode)}
              />
            )}
          </div>
        );
      })}
      <FunctionBreakpointsView debug={debug} />
      <DataBreakpointsView
        debug={debug}
        modes={dataBreakpointModes}
        newMode={dataBreakpointMode}
        onNewModeChange={onDataBreakpointModeChange}
      />
    </>
  );
}

/** DAP function/method breakpoints, configured independently of source files. */
function FunctionBreakpointsView({ debug }: { debug: CodeDebugSession }) {
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const entries = debug.functionBreakpoints
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  const active = !!debug.state && debug.state.status !== "terminated";
  const supported = debug.capabilities.supportsFunctionBreakpoints === true;
  const canAdd = !active || supported;
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed || !canAdd) return;
    debug.addFunctionBreakpoint(trimmed);
    setName("");
  };
  return (
    <div
      data-testid="debug-function-breakpoints"
      className="mt-1 border-t border-[var(--taomni-code-border)]/60 pt-1"
    >
      <div className="flex items-center gap-1 px-3 py-1">
        <span className="w-24 shrink-0 text-[10px] font-medium text-[var(--taomni-text-muted)]">
          Function / method
        </span>
        <input
          data-testid="debug-function-breakpoint-input"
          aria-label="Function breakpoint name"
          className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
          placeholder="Type a qualified function name"
          maxLength={1024}
          value={name}
          disabled={!canAdd}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") add(); }}
        />
        <button
          type="button"
          data-testid="debug-function-breakpoint-add"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
          title={canAdd ? "Add function breakpoint" : "The active adapter does not support function breakpoints"}
          aria-label="Add function breakpoint"
          disabled={!canAdd || !name.trim()}
          onClick={add}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      {active && !supported && (
        <div data-testid="debug-function-breakpoint-unsupported" className="px-3 pb-1 text-[10px] text-amber-500">
          The active debug adapter does not support function breakpoints.
        </div>
      )}
      {entries.length === 0 && <Empty text="No function breakpoints." />}
      {entries.map((breakpoint, index) => {
        const disabled = breakpoint.enabled === false;
        const runtime = debug.functionBreakpointRuntime[breakpoint.name];
        const bindingHint = active && !disabled && runtime && runtime.status !== "verified"
          ? runtime
          : null;
        const open = editingName === breakpoint.name;
        return (
          <div
            key={breakpoint.name}
            data-testid="debug-function-breakpoint-row"
            data-function-name={breakpoint.name}
            className="border-t border-[var(--taomni-code-border)]/40"
          >
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-function-breakpoint-enabled-${index}`}
                checked={!disabled}
                title={disabled ? "Enable function breakpoint" : "Disable function breakpoint"}
                onChange={(event) => debug.setFunctionBreakpointOptions(
                  breakpoint.name,
                  { enabled: event.target.checked },
                )}
              />
              <span className={`min-w-0 flex-1 truncate font-mono ${
                disabled ? "text-[var(--taomni-text-muted)] line-through" : ""
              }`} title={breakpoint.name}>
                {breakpoint.name}
                {breakpoint.condition && <span className="ml-2 text-amber-500">if {breakpoint.condition}</span>}
                {breakpoint.hitCondition && <span className="ml-2 text-amber-500">hit {breakpoint.hitCondition}</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-function-breakpoint-binding-${index}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              <button
                type="button"
                data-testid={`debug-function-breakpoint-edit-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditingName(open ? null : breakpoint.name)}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-function-breakpoint-remove-${index}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                title="Remove function breakpoint"
                onClick={() => debug.removeFunctionBreakpoint(breakpoint.name)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <FunctionBreakpointEditor
                breakpoint={breakpoint}
                index={index}
                onChange={(options) => debug.setFunctionBreakpointOptions(breakpoint.name, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FunctionBreakpointEditor({
  breakpoint,
  index,
  onChange,
}: {
  breakpoint: DebugFunctionBreakpoint;
  index: number;
  onChange: (options: Partial<DebugFunctionBreakpoint>) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-function-breakpoint-condition-${index}`}
        className={field}
        placeholder="break only when true"
        maxLength={4096}
        initialValue={breakpoint.condition ?? ""}
        onCommit={(value) => onChange({ condition: value.trim() || undefined })}
      />
      <CommitField
        label="Hit count"
        testId={`debug-function-breakpoint-hit-${index}`}
        className={field}
        placeholder="e.g. 5"
        maxLength={4096}
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={(value) => onChange({ hitCondition: value.trim() || undefined })}
      />
    </div>
  );
}

/** DAP data breakpoints/watchpoints discovered from Variables or Watch. */
function DataBreakpointsView({
  debug,
  modes,
  newMode,
  onNewModeChange,
}: {
  debug: CodeDebugSession;
  modes: DebugBreakpointMode[];
  newMode: string | undefined;
  onNewModeChange: (mode: string) => void;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetBytes, setTargetBytes] = useState("");
  const [targetAsAddress, setTargetAsAddress] = useState(false);
  const [addingTarget, setAddingTarget] = useState(false);
  const [targetNotice, setTargetNotice] = useState<{ added: boolean; message: string } | null>(null);
  const entries = debug.dataBreakpoints.slice().sort((left, right) => (
    left.adapterId < right.adapterId ? -1
      : left.adapterId > right.adapterId ? 1
        : left.description < right.description ? -1
          : left.description > right.description ? 1
            : left.dataId < right.dataId ? -1 : left.dataId > right.dataId ? 1 : 0
  ));
  const active = !!debug.state && debug.state.status !== "terminated";
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const supported = debug.capabilities.supportsDataBreakpoints === true;
  const supportsBytes = debug.capabilities.supportsDataBreakpointBytes === true;
  const stopped = debug.state?.status === "stopped";
  const canAddTarget = supported && stopped && !addingTarget;
  const appliesToActiveSession = (breakpoint: DebugDataBreakpoint) => (
    breakpoint.sessionId
      ? breakpoint.sessionId === activeSession?.id
      : breakpoint.adapterId === activeSession?.adapterId
  );
  const hasUnsupportedEntries = active && !supported && entries.some((breakpoint) => (
    appliesToActiveSession(breakpoint) && breakpoint.enabled !== false
  ));

  const addTarget = async () => {
    const name = targetName.trim();
    if (!name || !canAddTarget) return;
    const rawBytes = targetBytes.trim();
    const bytes = rawBytes ? Number(rawBytes) : undefined;
    if (rawBytes && (!Number.isInteger(bytes) || (bytes as number) <= 0)) {
      setTargetNotice({ added: false, message: "Byte count must be a positive integer" });
      return;
    }
    setAddingTarget(true);
    setTargetNotice(null);
    const result = await debug.addDataBreakpoint({
      name,
      frameId: targetAsAddress ? undefined : (debug.state?.selectedFrameId ?? debug.state?.frames[0]?.id ?? undefined),
      bytes: supportsBytes ? bytes : undefined,
      asAddress: supportsBytes && targetAsAddress ? true : undefined,
      mode: newMode,
    });
    setAddingTarget(false);
    setTargetNotice(result);
    if (result.added) {
      setTargetName("");
      setTargetBytes("");
      setTargetAsAddress(false);
    }
  };

  return (
    <div
      data-testid="debug-data-breakpoints"
      className="mt-1 border-t border-[var(--taomni-code-border)]/60 pt-1"
    >
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] font-medium text-[var(--taomni-text-muted)]">Data watchpoints</span>
        {modes.length > 0 && (
          <select
            data-testid="debug-data-breakpoint-mode"
            aria-label="Mode for new data breakpoint"
            title={modes.find((mode) => mode.mode === newMode)?.description
              ?? "Mode for new data breakpoints"}
            className="h-5 min-w-0 max-w-28 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            value={newMode ?? modes[0].mode}
            onChange={(event) => onNewModeChange(event.target.value)}
          >
            {modes.map((mode) => (
              <option key={mode.mode} value={mode.mode}>{mode.label}</option>
            ))}
          </select>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-[var(--taomni-text-muted)]">{entries.length}</span>
      </div>
      {canAddTarget && (
        <div className="space-y-1 px-3 pb-1" data-testid="debug-data-breakpoint-create">
          <div className="flex items-center gap-1">
            <input
              data-testid="debug-data-breakpoint-target"
              aria-label="Data breakpoint expression or address"
              className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none"
              placeholder={supportsBytes ? "Expression or address" : "Expression"}
              maxLength={4096}
              value={targetName}
              onChange={(event) => setTargetName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void addTarget(); }}
            />
            <button
              type="button"
              data-testid="debug-data-breakpoint-add"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
              title="Add data breakpoint for the expression or address"
              aria-label="Add data breakpoint"
              disabled={!targetName.trim() || addingTarget}
              onClick={() => void addTarget()}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          {supportsBytes && (
            <div className="flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
                <span className="shrink-0">Bytes</span>
                <input
                  data-testid="debug-data-breakpoint-bytes"
                  aria-label="Data breakpoint byte count"
                  className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none"
                  inputMode="numeric"
                  placeholder="optional range size"
                  value={targetBytes}
                  onChange={(event) => setTargetBytes(event.target.value)}
                />
              </label>
              <label className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]" title="Interpret the target as a decimal or hexadecimal memory address">
                <input
                  type="checkbox"
                  data-testid="debug-data-breakpoint-as-address"
                  aria-label="Treat target as memory address"
                  checked={targetAsAddress}
                  onChange={(event) => setTargetAsAddress(event.target.checked)}
                />
                Address
              </label>
            </div>
          )}
          {targetNotice && (
            <div
              data-testid="debug-data-breakpoint-create-notice"
              role="status"
              className={targetNotice.added ? "text-emerald-500" : "text-rose-500"}
            >
              {targetNotice.message}
            </div>
          )}
        </div>
      )}
      {hasUnsupportedEntries && (
        <div data-testid="debug-data-breakpoint-unsupported" className="px-3 pb-1 text-[10px] text-amber-500">
          The active debug adapter does not support data breakpoints.
        </div>
      )}
      {entries.length === 0 && <Empty text="No data watchpoints." />}
      {entries.map((breakpoint, index) => {
        const key = dataBreakpointKey(breakpoint);
        const disabled = breakpoint.enabled === false;
        const applicable = appliesToActiveSession(breakpoint);
        const runtime = debug.dataBreakpointRuntime[key];
        const bindingHint = active && applicable && !disabled && runtime && runtime.status !== "verified"
          ? runtime
          : null;
        const modeLabel = breakpoint.mode
          ? (breakpoint.adapterId === activeSession?.adapterId
            ? modes.find((mode) => mode.mode === breakpoint.mode)?.label ?? breakpoint.mode
            : breakpoint.mode)
          : null;
        const open = editingKey === key;
        return (
          <div
            key={key}
            data-testid="debug-data-breakpoint-row"
            data-data-breakpoint-persistent={breakpoint.canPersist ? "true" : "false"}
            className="border-t border-[var(--taomni-code-border)]/40"
          >
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-data-breakpoint-enabled-${index}`}
                checked={!disabled}
                title={disabled ? "Enable data breakpoint" : "Disable data breakpoint"}
                onChange={(event) => debug.setDataBreakpointOptions(key, { enabled: event.target.checked })}
              />
              <span
                className={`min-w-0 flex-1 truncate font-mono ${
                  disabled ? "text-[var(--taomni-text-muted)] line-through" : ""
                }`}
                title={breakpoint.description}
              >
                {breakpoint.description}
                {breakpoint.condition && <span className="ml-2 text-amber-500">if {breakpoint.condition}</span>}
                {breakpoint.hitCondition && <span className="ml-2 text-amber-500">hit {breakpoint.hitCondition}</span>}
                {breakpoint.asAddress && <span className="ml-2 text-sky-600 dark:text-sky-400">address</span>}
                {breakpoint.bytes && <span className="ml-2 text-sky-600 dark:text-sky-400">{breakpoint.bytes} bytes</span>}
                {modeLabel && <span className="ml-2 text-emerald-600 dark:text-emerald-400">{modeLabel}</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-data-breakpoint-binding-${index}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              {breakpoint.accessTypes.length > 0 ? (
                <select
                  data-testid={`debug-data-breakpoint-access-${index}`}
                  aria-label={`Access type for ${breakpoint.description}`}
                  className="h-5 max-w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
                  value={breakpoint.accessType ?? ""}
                  onChange={(event) => debug.setDataBreakpointOptions(key, {
                    accessType: event.target.value as DebugDataBreakpoint["accessType"],
                  })}
                >
                  {breakpoint.accessTypes.map((accessType) => (
                    <option key={accessType} value={accessType}>{dataAccessTypeLabel(accessType)}</option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">default</span>
              )}
              <span
                data-testid={`debug-data-breakpoint-scope-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]"
                title={breakpoint.canPersist
                  ? `Saved for ${breakpoint.adapterId} debug sessions`
                  : "Available only in the debug session that created it"}
              >
                {breakpoint.canPersist ? breakpoint.adapterId : "session"}
              </span>
              <button
                type="button"
                data-testid={`debug-data-breakpoint-edit-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditingKey(open ? null : key)}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-data-breakpoint-remove-${index}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                title="Remove data breakpoint"
                onClick={() => debug.removeDataBreakpoint(key)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <DataBreakpointEditor
                breakpoint={breakpoint}
                index={index}
                onChange={(options) => debug.setDataBreakpointOptions(key, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function dataAccessTypeLabel(accessType: NonNullable<DebugDataBreakpoint["accessType"]>): string {
  switch (accessType) {
    case "read": return "Read";
    case "write": return "Write";
    case "readWrite": return "Read/write";
  }
}

function DataBreakpointEditor({
  breakpoint,
  index,
  onChange,
}: {
  breakpoint: DebugDataBreakpoint;
  index: number;
  onChange: (options: Partial<DebugDataBreakpoint>) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-data-breakpoint-condition-${index}`}
        className={field}
        placeholder="break only when true"
        maxLength={4096}
        initialValue={breakpoint.condition ?? ""}
        onCommit={(value) => onChange({ condition: value.trim() || undefined })}
      />
      <CommitField
        label="Hit count"
        testId={`debug-data-breakpoint-hit-${index}`}
        className={field}
        placeholder="e.g. 5"
        maxLength={4096}
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={(value) => onChange({ hitCondition: value.trim() || undefined })}
      />
    </div>
  );
}

/** Adapter-advertised exception filters with optional DAP filter conditions. */
function ExceptionBreakpointsView({ debug }: { debug: CodeDebugSession }) {
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const settings = new Map(debug.exceptionBreakpoints
    .filter((breakpoint) => breakpoint.adapterId === activeSession?.adapterId)
    .map((breakpoint) => [breakpoint.filterId, breakpoint]));
  const supportsFilterOptions = debug.capabilities.supportsExceptionFilterOptions === true;
  const exceptionModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "exception");
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  return (
    <div data-testid="debug-exception-breakpoints">
      {debug.availableExceptionFilters.map((filter, index) => {
        const setting: DebugExceptionBreakpoint = settings.get(filter.filter) ?? {
          adapterId: activeSession?.adapterId ?? "",
          filterId: filter.filter,
          enabled: filter.default,
        };
        const runtime = debug.exceptionBreakpointRuntime[filter.filter];
        const bindingHint = setting.enabled
          && !debug.breakpointsMuted
          && runtime
          && runtime.status !== "verified"
          ? runtime
          : null;
        const canSetCondition = filter.supportsCondition && supportsFilterOptions;
        const canSetMode = supportsFilterOptions && exceptionModes.length > 0;
        const mode = resolveBreakpointMode(setting.mode, exceptionModes, "exception");
        return (
          <div
            key={filter.filter}
            data-testid="debug-exception-breakpoint-row"
            data-exception-filter={filter.filter}
            className="border-t border-[var(--taomni-code-border)]/40 first:border-t-0"
          >
            <label
              className="flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]"
              title={filter.description}
            >
              <input
                type="checkbox"
                data-testid={`debug-exception-breakpoint-enabled-${index}`}
                checked={setting.enabled}
                onChange={(event) => debug.setExceptionBreakpointOptions(
                  filter.filter,
                  { enabled: event.target.checked },
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {filter.label}
                {setting.condition && (
                  <span className="ml-2 text-amber-500">if {setting.condition}</span>
                )}
                {bindingHint && (
                  <span
                    data-testid={`debug-exception-breakpoint-binding-${index}`}
                    className={`ml-2 ${
                      bindingHint.status === "failed"
                        ? "text-rose-500"
                        : "text-[var(--taomni-text-muted)]"
                    }`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
            </label>
            {(canSetCondition || canSetMode) && (
              <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
                {canSetMode && (
                  <label className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[var(--taomni-text-muted)]">Mode</span>
                    <select
                      data-testid={`debug-exception-breakpoint-mode-${index}`}
                      aria-label={`Breakpoint mode for ${filter.label}`}
                      title={exceptionModes.find((entry) => entry.mode === mode)?.description}
                      className="h-5 min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 text-[11px] outline-none"
                      value={mode ?? exceptionModes[0].mode}
                      onChange={(event) => debug.setExceptionBreakpointOptions(
                        filter.filter,
                        { mode: event.target.value },
                      )}
                    >
                      {exceptionModes.map((entry) => (
                        <option key={entry.mode} value={entry.mode}>{entry.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {canSetCondition && (
                  <CommitField
                    label="Condition"
                    testId={`debug-exception-breakpoint-condition-${index}`}
                    className={field}
                    placeholder={filter.conditionDescription ?? "break only when true"}
                    maxLength={4096}
                    initialValue={setting.condition ?? ""}
                    onCommit={(value) => debug.setExceptionBreakpointOptions(
                      filter.filter,
                      { condition: value.trim() || undefined },
                    )}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      <ExceptionBreakpointRulesView debug={debug} adapterId={activeSession?.adapterId ?? null} />
    </div>
  );
}

const EXCEPTION_BREAK_MODES: Array<{ value: DebugExceptionBreakMode; label: string }> = [
  { value: "always", label: "Caught and uncaught" },
  { value: "unhandled", label: "Uncaught" },
  { value: "userUnhandled", label: "Unhandled in user code" },
  { value: "never", label: "Never" },
];

function parseExceptionPathNames(value: string): string[] {
  return Array.from(new Set(value.split(",").map((name) => name.trim()).filter(Boolean)));
}

function ExceptionBreakpointRuleEditor({
  rule,
  ruleIndex,
  onChange,
}: {
  rule: DebugExceptionBreakpointRule;
  ruleIndex: number;
  onChange: (options: Partial<DebugExceptionBreakpointRule>) => void;
}) {
  const [newSegment, setNewSegment] = useState("");
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  const setSegment = (segmentIndex: number, names: string[]) => {
    const path = names.length > 0
      ? rule.path.map((segment, index) => (index === segmentIndex ? { ...segment, names } : segment))
      : rule.path.filter((_, index) => index !== segmentIndex);
    onChange({ path });
  };
  const addSegment = () => {
    const names = parseExceptionPathNames(newSegment);
    if (names.length === 0) return;
    onChange({ path: [...rule.path, { names }] });
    setNewSegment("");
  };
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      {rule.path.map((segment, segmentIndex) => (
        <div key={`${rule.id}:${segmentIndex}`} className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <CommitField
              label={`Path ${segmentIndex + 1}`}
              testId={`debug-exception-rule-path-names-${ruleIndex}-${segmentIndex}`}
              className={field}
              placeholder="Exception class or package patterns"
              maxLength={4096}
              initialValue={segment.names.join(", ")}
              onCommit={(value) => setSegment(segmentIndex, parseExceptionPathNames(value))}
            />
          </div>
          <label
            className="inline-flex h-5 shrink-0 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]"
            title="Exclude these names from this path segment"
          >
            <input
              type="checkbox"
              data-testid={`debug-exception-rule-path-exclude-${ruleIndex}-${segmentIndex}`}
              checked={segment.negate === true}
              onChange={(event) => onChange({
                path: rule.path.map((entry, index) => (
                  index === segmentIndex
                    ? { ...entry, negate: event.target.checked || undefined }
                    : entry
                )),
              })}
            />
            Exclude
          </label>
          <button
            type="button"
            data-testid={`debug-exception-rule-path-remove-${ruleIndex}-${segmentIndex}`}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-rose-500/15 hover:text-rose-500"
            title="Remove path segment"
            aria-label="Remove path segment"
            onClick={() => setSegment(segmentIndex, [])}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <input
          data-testid={`debug-exception-rule-path-input-${ruleIndex}`}
          className={field}
          aria-label="New exception path segment"
          placeholder="Add path segment"
          value={newSegment}
          maxLength={4096}
          onChange={(event) => setNewSegment(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addSegment(); }}
        />
        <button
          type="button"
          data-testid={`debug-exception-rule-path-add-${ruleIndex}`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-emerald-500/15 hover:text-emerald-500 disabled:opacity-40"
          title="Add path segment"
          aria-label="Add path segment"
          disabled={parseExceptionPathNames(newSegment).length === 0}
          onClick={addSegment}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function ExceptionBreakpointRulesView({
  debug,
  adapterId,
}: {
  debug: CodeDebugSession;
  adapterId: string | null;
}) {
  const [newRule, setNewRule] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const supported = debug.capabilities.supportsExceptionOptions === true;
  const rules = debug.exceptionBreakpointRules.filter((rule) => rule.adapterId === adapterId);
  const addRule = () => {
    const names = parseExceptionPathNames(newRule);
    if (names.length === 0) return;
    const id = debug.addExceptionBreakpointRule([{ names }]);
    if (!id) return;
    setNewRule("");
    setEditingRuleId(id);
  };
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  return (
    <div data-testid="debug-exception-rules" className="border-t border-[var(--taomni-code-border)]/60 pt-1">
      {supported ? (
        <div className="flex items-center gap-1 px-3 pb-1">
          <input
            data-testid="debug-exception-rule-input"
            className={field}
            aria-label="Exception class or package patterns"
            placeholder="Exception class or package patterns"
            value={newRule}
            maxLength={4096}
            onChange={(event) => setNewRule(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") addRule(); }}
          />
          <button
            type="button"
            data-testid="debug-exception-rule-add"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-emerald-500/15 hover:text-emerald-500 disabled:opacity-40"
            title="Add exception path rule"
            aria-label="Add exception path rule"
            disabled={parseExceptionPathNames(newRule).length === 0}
            onClick={addRule}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div
          data-testid="debug-exception-rule-unsupported"
          className="px-3 py-1 text-[10px] text-[var(--taomni-text-muted)]"
        >
          This adapter does not support class or package exception rules.
        </div>
      )}
      {rules.map((rule, index) => {
        const runtime = debug.exceptionBreakpointRuleRuntime[rule.id];
        const bindingHint = rule.enabled
          && !debug.breakpointsMuted
          && runtime
          && runtime.status !== "verified"
          ? runtime
          : null;
        const editing = editingRuleId === rule.id;
        return (
          <div
            key={rule.id}
            data-testid="debug-exception-rule-row"
            data-exception-rule={rule.id}
            className="border-t border-[var(--taomni-code-border)]/40 first:border-t-0"
          >
            <div className="flex min-w-0 items-center gap-1 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-exception-rule-enabled-${index}`}
                aria-label={`Enable ${exceptionBreakpointRuleLabel(rule)}`}
                checked={rule.enabled}
                onChange={(event) => debug.setExceptionBreakpointRuleOptions(
                  rule.id,
                  { enabled: event.target.checked },
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono" title={exceptionBreakpointRuleLabel(rule)}>
                {exceptionBreakpointRuleLabel(rule)}
                {bindingHint && (
                  <span
                    data-testid={`debug-exception-rule-binding-${index}`}
                    className={`ml-2 font-sans ${
                      bindingHint.status === "failed"
                        ? "text-rose-500"
                        : "text-[var(--taomni-text-muted)]"
                    }`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              <select
                data-testid={`debug-exception-rule-mode-${index}`}
                aria-label={`Break mode for ${exceptionBreakpointRuleLabel(rule)}`}
                className="h-5 max-w-32 shrink-0 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
                value={rule.breakMode}
                onChange={(event) => debug.setExceptionBreakpointRuleOptions(rule.id, {
                  breakMode: event.target.value as DebugExceptionBreakMode,
                })}
              >
                {EXCEPTION_BREAK_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>{mode.label}</option>
                ))}
              </select>
              <button
                type="button"
                data-testid={`debug-exception-rule-edit-${index}`}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover-bg)]"
                title="Edit exception path"
                aria-label="Edit exception path"
                aria-expanded={editing}
                onClick={() => setEditingRuleId(editing ? null : rule.id)}
              >
                {editing ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <button
                type="button"
                data-testid={`debug-exception-rule-remove-${index}`}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-rose-500/15 hover:text-rose-500"
                title="Remove exception rule"
                aria-label="Remove exception rule"
                onClick={() => debug.removeExceptionBreakpointRule(rule.id)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {editing && (
              <ExceptionBreakpointRuleEditor
                rule={rule}
                ruleIndex={index}
                onChange={(options) => debug.setExceptionBreakpointRuleOptions(rule.id, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The condition / hit count / log message fields for one breakpoint. */
function BreakpointEditor({
  breakpoint,
  adapterId,
  modes,
  onChange,
  onModeChange,
}: {
  breakpoint: DebugBreakpoint;
  adapterId: string | null;
  modes: DebugBreakpointMode[];
  onChange: (options: Partial<DebugBreakpoint>) => void;
  onModeChange: (mode: string) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  // Committed on blur / Enter so every keystroke does not re-push to the adapter.
  const commit = (key: "condition" | "hitCondition" | "logMessage") => (value: string) => {
    onChange({ [key]: value.trim() || undefined });
  };
  const mode = adapterId
    ? resolveBreakpointMode(breakpoint.adapterModes?.[adapterId], modes, "source")
    : undefined;
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      {adapterId && modes.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[var(--taomni-text-muted)]">Mode</span>
          <select
            data-testid={`debug-breakpoint-mode-${breakpoint.line}`}
            aria-label={`Breakpoint mode at line ${breakpoint.line}`}
            title={modes.find((entry) => entry.mode === mode)?.description}
            className="h-5 min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 text-[11px] outline-none"
            value={mode ?? modes[0].mode}
            onChange={(event) => onModeChange(event.target.value)}
          >
            {modes.map((entry) => (
              <option key={entry.mode} value={entry.mode}>{entry.label}</option>
            ))}
          </select>
        </label>
      )}
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
  maxLength,
  initialValue,
  onCommit,
}: {
  label: string;
  testId: string;
  className: string;
  placeholder: string;
  maxLength?: number;
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
        maxLength={maxLength}
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
  const running = debug.sessions.length > 0
    ? debug.sessions.some((session) => session.status !== "terminated")
    : !!state && state.status !== "terminated";
  const activeRunning = !!state && state.status !== "terminated";
  const stopped = state?.status === "stopped";
  const canSetVariable = debug.capabilities.supportsSetVariable === true;
  const canRestartFrame = debug.capabilities.supportsRestartFrame === true;
  const [variables, setVariables] = useState<VarNode[]>([]);
  const [watchNodes, setWatchNodes] = useState<VarNode[]>([]);
  const [watchTick, setWatchTick] = useState(0);
  const [watchInput, setWatchInput] = useState("");
  const [consoleInput, setConsoleInput] = useState("");
  const [edit, setEdit] = useState<VarEditState>({ node: null, value: "" });
  const [addingDataBreakpointKey, setAddingDataBreakpointKey] = useState<string | null>(null);
  const [preferredDataBreakpointMode, setPreferredDataBreakpointMode] = useState("");
  const [dataBreakpointNotice, setDataBreakpointNotice] = useState<{
    added: boolean;
    message: string;
  } | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const activeConfiguration = configurations.find((configuration) => (
    configuration.id === (activeConfigurationId ?? configurations[0]?.id)
  )) ?? configurations[0] ?? null;
  const configurationDiagnostic = activeConfiguration && (
    activeConfiguration.diagnostic?.trim()
    || (activeConfiguration.available === false ? "Debug configuration is unavailable" : "")
  ) || null;

  // Stable hook callbacks (useCallback in useCodeDebugSession) — effects key on
  // these instead of the per-render `debug` object so a parent re-render does
  // not re-fetch scopes / re-evaluate watches against the adapter.
  const {
    addDataBreakpoint: sessionAddDataBreakpoint,
    fetchScopes,
    fetchVariables,
    evaluate,
    setVariable: sessionSetVariable,
  } = debug;

  // On each stop, load the selected frame's scopes → variables (D4).
  const frameId = stopped ? state?.selectedFrameId ?? state?.frames[0]?.id ?? null : null;
  const canAddDataBreakpoint = stopped && debug.capabilities.supportsDataBreakpoints === true;
  const dataBreakpointModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "data");
  const dataBreakpointMode = resolveBreakpointMode(
    preferredDataBreakpointMode || undefined,
    dataBreakpointModes,
    "data",
  );
  const addDataBreakpointForNode = useCallback(async (node: VarNode) => {
    const targetKey = variableDataBreakpointTargetKey(node);
    setAddingDataBreakpointKey(targetKey);
    setDataBreakpointNotice(null);
    const result = await sessionAddDataBreakpoint({
      name: node.name,
      variablesReference: node.parentRef > 0 ? node.parentRef : undefined,
      frameId: node.parentRef > 0 ? undefined : frameId ?? undefined,
      mode: dataBreakpointMode,
    });
    setDataBreakpointNotice(result);
    setAddingDataBreakpointKey((current) => current === targetKey ? null : current);
  }, [dataBreakpointMode, frameId, sessionAddDataBreakpoint]);
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
          dataBreakpointExpression: false,
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
        dataBreakpointExpression: true,
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
          dataBreakpointExpression: true,
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
              <option
                key={configuration.id}
                value={configuration.id}
                data-configuration-available={configuration.available === false ? "false" : "true"}
              >
                {configuration.label} [{configurationSourceLabel(configuration.source)}]
                {configurationAvailabilityLabel(configuration.available)}
              </option>
            ))}
          </select>
        )}
        {!running && configurationDiagnostic && (
          <div
            data-testid="debug-configuration-diagnostic"
            role="status"
            className="max-w-64 truncate text-[10px] text-amber-600 dark:text-amber-400"
            title={configurationDiagnostic}
          >
            {configurationDiagnostic}
          </div>
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
                disabled={!activeRunning || stopped}
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
                disabled={!activeRunning}
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
      {debug.sessions.length > 1 && (
        <div className="h-8 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-2">
          <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">Session</span>
          <select
            data-testid="debug-active-session"
            aria-label="Debug session"
            title="Select compound debug session"
            value={debug.activeSessionId ?? debug.sessions[0].id}
            onChange={(event) => debug.selectSession(event.target.value)}
            className="h-6 min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
          >
            {debug.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.label} [{session.status}{session.stoppedReason ? `: ${session.stoppedReason}` : ""}]
              </option>
            ))}
          </select>
          <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
            {debug.sessions.filter((session) => session.status !== "terminated").length}/{debug.sessions.length}
          </span>
        </div>
      )}
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
            dataBreakpointModes={dataBreakpointModes}
            dataBreakpointMode={dataBreakpointMode}
            onDataBreakpointModeChange={setPreferredDataBreakpointMode}
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
                    onAddDataBreakpoint={canAddDataBreakpoint ? addDataBreakpointForNode : undefined}
                    addingDataBreakpointKey={addingDataBreakpointKey}
                  />
                ))}
              {dataBreakpointNotice && (
                <div
                  data-testid="debug-data-breakpoint-notice"
                  role="status"
                  className={`px-3 py-1 text-[10px] ${
                    dataBreakpointNotice.added ? "text-emerald-500" : "text-rose-500"
                  }`}
                >
                  {dataBreakpointNotice.message}
                </div>
              )}
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
                  onAddDataBreakpoint={canAddDataBreakpoint ? addDataBreakpointForNode : undefined}
                  addingDataBreakpointKey={addingDataBreakpointKey}
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
                <ExceptionBreakpointsView debug={debug} />
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
