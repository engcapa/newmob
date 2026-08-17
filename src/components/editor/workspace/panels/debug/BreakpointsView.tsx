import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import {
  breakpointModesFor,
  dataBreakpointKey,
  instructionBreakpointKey,
  parseBreakpointModes,
  resolveBreakpointMode,
  sortedBreakpoints,
  type DebugBreakpointMode,
  type DebugDataBreakpoint,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
} from "../../dapDebugModel";
import { CommitField, dataAccessTypeLabel, Empty } from "./debugPanelShared";
import { BreakpointEditor } from "./BreakpointEditor";

export interface BreakpointsViewProps {
  debug: CodeDebugSession;
  editing: { path: string; line: number } | null;
  setEditing: (target: { path: string; line: number } | null) => void;
  onOpenBreakpoint?: (path: string, line: number) => void;
  dataBreakpointModes: DebugBreakpointMode[];
  dataBreakpointMode: string | undefined;
  onDataBreakpointModeChange: (mode: string) => void;
  /** Whether to show child views (Function, Instruction, Data) - true by default */
  includeChildViews?: boolean;
}

/**
 * Breakpoints view (IDEA's breakpoints dialog, inline): every breakpoint in the
 * workspace with enable/disable, condition / hit count / log message editing,
 * removal, and click-to-reveal. Language-agnostic — it renders the DAP fields.
 */
export function BreakpointsView({
  debug,
  editing,
  setEditing,
  onOpenBreakpoint,
  dataBreakpointModes,
  dataBreakpointMode,
  onDataBreakpointModeChange,
  includeChildViews = true,
}: BreakpointsViewProps) {
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
      {includeChildViews && (
        <>
          <FunctionBreakpointsView debug={debug} />
          <InstructionBreakpointsView debug={debug} />
          <DataBreakpointsView
            debug={debug}
            modes={dataBreakpointModes}
            newMode={dataBreakpointMode}
            onNewModeChange={onDataBreakpointModeChange}
          />
        </>
      )}
    </>
  );
}

/** DAP function/method breakpoints, configured independently of source files. */
export function FunctionBreakpointsView({ debug }: { debug: CodeDebugSession }) {
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

export function FunctionBreakpointEditor({
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

/** DAP instruction breakpoints keyed by an adapter-owned reference and offset. */
export function InstructionBreakpointsView({ debug }: { debug: CodeDebugSession }) {
  const [reference, setReference] = useState("");
  const [offset, setOffset] = useState("");
  const [preferredMode, setPreferredMode] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeSession = debug.sessions.find((session) => session.id === debug.activeSessionId)
    ?? debug.sessions[0]
    ?? null;
  const active = !!debug.state && debug.state.status !== "terminated";
  const supported = debug.capabilities.supportsInstructionBreakpoints === true;
  const modes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "instruction");
  const mode = resolveBreakpointMode(preferredMode || undefined, modes, "instruction");
  const canAdd = active && supported;
  const entries = debug.instructionBreakpoints.slice().sort((left, right) => (
    left.adapterId.localeCompare(right.adapterId)
    || left.instructionReference.localeCompare(right.instructionReference)
    || (left.offset ?? 0) - (right.offset ?? 0)
  ));

  const add = () => {
    const instructionReference = reference.trim();
    if (!instructionReference || !canAdd) return;
    const rawOffset = offset.trim();
    if (rawOffset && !/^[+-]?\d+$/.test(rawOffset)) {
      setNotice("Instruction offset must be a signed decimal integer");
      return;
    }
    const parsedOffset = rawOffset ? Number(rawOffset) : undefined;
    if (parsedOffset !== undefined && !Number.isSafeInteger(parsedOffset)) {
      setNotice("Instruction offset is outside the safe integer range");
      return;
    }
    const added = debug.addInstructionBreakpoint({
      instructionReference,
      offset: parsedOffset,
      mode,
    });
    if (!added) {
      setNotice("Instruction breakpoint is invalid, duplicated, or unsupported");
      return;
    }
    setReference("");
    setOffset("");
    setNotice(null);
  };

  return (
    <div
      data-testid="debug-instruction-breakpoints"
      className="mt-1 border-t border-[var(--taomni-code-border)]/60 pt-1"
    >
      <div className="space-y-1 px-3 py-1">
        <div className="flex items-center gap-1">
          <span className="w-24 shrink-0 text-[10px] font-medium text-[var(--taomni-text-muted)]">
            Instruction
          </span>
          <input
            data-testid="debug-instruction-breakpoint-reference"
            aria-label="Instruction reference"
            className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
            placeholder="Address or instruction reference"
            maxLength={4096}
            value={reference}
            disabled={!canAdd}
            onChange={(event) => setReference(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") add(); }}
          />
          <button
            type="button"
            data-testid="debug-instruction-breakpoint-add"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
            title={canAdd ? "Add instruction breakpoint" : "The active adapter does not support instruction breakpoints"}
            aria-label="Add instruction breakpoint"
            disabled={!canAdd || !reference.trim()}
            onClick={add}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-1">
          <span aria-hidden="true" />
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <label className="flex min-w-0 flex-1 basis-24 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
              <span className="shrink-0">Offset</span>
              <input
                data-testid="debug-instruction-breakpoint-offset"
                aria-label="Instruction breakpoint offset"
                className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
                inputMode="numeric"
                placeholder="optional"
                value={offset}
                disabled={!canAdd}
                onChange={(event) => setOffset(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") add(); }}
              />
            </label>
            {modes.length > 0 && (
              <select
                data-testid="debug-instruction-breakpoint-mode"
                aria-label="Instruction breakpoint mode"
                title={modes.find((entry) => entry.mode === mode)?.description}
                className="h-5 min-w-0 max-w-full flex-1 basis-24 truncate rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 text-[10px]"
                value={mode ?? modes[0].mode}
                disabled={!canAdd}
                onChange={(event) => setPreferredMode(event.target.value)}
              >
                {modes.map((entry) => (
                  <option key={entry.mode} value={entry.mode}>{entry.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
      {active && !supported && (
        <div data-testid="debug-instruction-breakpoint-unsupported" className="px-3 pb-1 text-[10px] text-amber-500">
          The active debug adapter does not support instruction breakpoints.
        </div>
      )}
      {notice && (
        <div data-testid="debug-instruction-breakpoint-notice" role="status" className="px-3 pb-1 text-[10px] text-rose-500">
          {notice}
        </div>
      )}
      {entries.length === 0 && <Empty text="No instruction breakpoints." />}
      {entries.map((breakpoint, index) => {
        const key = instructionBreakpointKey(breakpoint);
        const disabled = breakpoint.enabled === false;
        const belongsToActiveAdapter = activeSession?.adapterId === breakpoint.adapterId;
        const runtime = belongsToActiveAdapter ? debug.instructionBreakpointRuntime[key] : undefined;
        const bindingHint = active && !disabled && runtime && runtime.status !== "verified"
          ? runtime
          : null;
        const open = editingKey === key;
        const rowMode = belongsToActiveAdapter
          ? resolveBreakpointMode(breakpoint.mode, modes, "instruction")
          : breakpoint.mode;
        const rowModeLabel = modes.find((entry) => entry.mode === rowMode)?.label ?? rowMode;
        return (
          <div
            key={key}
            data-testid="debug-instruction-breakpoint-row"
            data-instruction-reference={breakpoint.instructionReference}
            className="border-t border-[var(--taomni-code-border)]/40"
          >
            <div className="group flex items-center gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover-bg)]">
              <input
                type="checkbox"
                data-testid={`debug-instruction-breakpoint-enabled-${index}`}
                checked={!disabled}
                title={disabled ? "Enable instruction breakpoint" : "Disable instruction breakpoint"}
                onChange={(event) => debug.setInstructionBreakpointOptions(
                  key,
                  { enabled: event.target.checked },
                )}
              />
              <span className={`min-w-0 flex-1 truncate font-mono ${
                disabled ? "text-[var(--taomni-text-muted)] line-through" : ""
              }`} title={`${breakpoint.adapterId}: ${breakpoint.instructionReference}`}>
                {breakpoint.instructionReference}
                {breakpoint.offset !== undefined && (
                  <span className="ml-1 text-[var(--taomni-text-muted)]">
                    {breakpoint.offset >= 0 ? "+" : ""}{breakpoint.offset}
                  </span>
                )}
                <span className="ml-2 text-[10px] text-[var(--taomni-text-muted)]">{breakpoint.adapterId}</span>
                {breakpoint.condition && <span className="ml-2 text-amber-500">if {breakpoint.condition}</span>}
                {breakpoint.hitCondition && <span className="ml-2 text-amber-500">hit {breakpoint.hitCondition}</span>}
                {rowModeLabel && <span className="ml-2 text-emerald-600 dark:text-emerald-400">{rowModeLabel}</span>}
                {bindingHint && (
                  <span
                    data-testid={`debug-instruction-breakpoint-binding-${index}`}
                    className={`ml-2 ${bindingHint.status === "failed" ? "text-rose-500" : "text-[var(--taomni-text-muted)]"}`}
                    title={bindingHint.message ?? undefined}
                  >
                    {bindingHint.status === "failed" ? "not bound" : "pending"}
                  </span>
                )}
              </span>
              <button
                type="button"
                data-testid={`debug-instruction-breakpoint-edit-${index}`}
                className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={() => setEditingKey(open ? null : key)}
              >
                {open ? "Done" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`debug-instruction-breakpoint-remove-${index}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                title="Remove instruction breakpoint"
                onClick={() => debug.removeInstructionBreakpoint(key)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {open && (
              <InstructionBreakpointEditor
                breakpoint={breakpoint}
                index={index}
                modes={belongsToActiveAdapter ? modes : []}
                onChange={(options) => debug.setInstructionBreakpointOptions(key, options)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function InstructionBreakpointEditor({
  breakpoint,
  index,
  modes,
  onChange,
}: {
  breakpoint: DebugInstructionBreakpoint;
  index: number;
  modes: DebugBreakpointMode[];
  onChange: (
    options: Partial<Pick<DebugInstructionBreakpoint, "condition" | "hitCondition" | "mode">>,
  ) => void;
}) {
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none";
  const mode = resolveBreakpointMode(breakpoint.mode, modes, "instruction");
  return (
    <div className="space-y-1 bg-[var(--taomni-code-bg)] px-3 pb-1.5 pt-1">
      <CommitField
        label="Condition"
        testId={`debug-instruction-breakpoint-condition-${index}`}
        className={field}
        placeholder="break only when true"
        maxLength={4096}
        initialValue={breakpoint.condition ?? ""}
        onCommit={(value) => onChange({ condition: value.trim() || undefined })}
      />
      <CommitField
        label="Hit count"
        testId={`debug-instruction-breakpoint-hit-${index}`}
        className={field}
        placeholder="e.g. 5"
        maxLength={4096}
        initialValue={breakpoint.hitCondition ?? ""}
        onCommit={(value) => onChange({ hitCondition: value.trim() || undefined })}
      />
      {modes.length > 0 && (
        <label className="flex items-center gap-2 text-[10px] text-[var(--taomni-text-muted)]">
          <span className="w-20 shrink-0">Mode</span>
          <select
            data-testid={`debug-instruction-breakpoint-row-mode-${index}`}
            aria-label={`Instruction breakpoint mode for ${breakpoint.instructionReference}`}
            className={field}
            value={mode ?? modes[0].mode}
            onChange={(event) => onChange({ mode: event.target.value })}
          >
            {modes.map((entry) => (
              <option key={entry.mode} value={entry.mode}>{entry.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** DAP data breakpoints/watchpoints discovered from Variables or Watch. */
export function DataBreakpointsView({
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

export function DataBreakpointEditor({
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
