import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import {
  breakpointModesFor,
  exceptionBreakpointRuleLabel,
  parseBreakpointModes,
  resolveBreakpointMode,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugExceptionBreakMode,
} from "../../dapDebugModel";
import {
  CommitField,
  EXCEPTION_BREAK_MODES,
  parseExceptionPathNames,
} from "./debugPanelShared";

export interface ExceptionBreakpointsViewProps {
  debug: CodeDebugSession;
}

/** Adapter-advertised exception filters with optional DAP filter conditions. */
export function ExceptionBreakpointsView({ debug }: ExceptionBreakpointsViewProps) {
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

export function ExceptionBreakpointRulesView({
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

export function ExceptionBreakpointRuleEditor({
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
