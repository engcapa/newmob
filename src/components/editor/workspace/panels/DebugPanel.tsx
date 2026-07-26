import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  Bug,
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Pause,
  Square,
} from "lucide-react";
import type { CodeDebugSession } from "../useCodeDebugSession";
import type { DebugStackFrame } from "../dapDebugModel";

interface DebugPanelProps {
  debug: CodeDebugSession;
  /** Start debugging the active file (parent builds the launch config). */
  onStart: (() => void) | null;
  /** Reveal a stack frame's source location. */
  onOpenFrame: (frame: DebugStackFrame) => void;
}

/** One expandable variables node (D4) — children fetched lazily on expand. */
interface VarNode {
  name: string;
  value: string;
  variablesReference: number;
  children: VarNode[] | null; // null = not yet loaded
  expanded: boolean;
}

function parseVariables(body: unknown): VarNode[] {
  const list = body && typeof body === "object" ? (body as { variables?: unknown }).variables : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const rec = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    if (typeof rec.name !== "string") return [];
    return [{
      name: rec.name,
      value: typeof rec.value === "string" ? rec.value : "",
      variablesReference: typeof rec.variablesReference === "number" ? rec.variablesReference : 0,
      children: null,
      expanded: false,
    }];
  });
}
function VariableRow({
  node,
  depth,
  onExpand,
}: {
  node: VarNode;
  depth: number;
  onExpand: (node: VarNode) => void;
}) {
  const expandable = node.variablesReference > 0;
  return (
    <>
      <div
        className="flex items-start gap-1 py-0.5 pr-2 hover:bg-[var(--taomni-hover-bg)]"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {expandable ? (
          <button type="button" className="shrink-0" onClick={() => onExpand(node)}>
            {node.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        <span className="shrink-0 text-[var(--taomni-text)]">{node.name}</span>
        <span className="truncate text-[var(--taomni-text-muted)]">= {node.value}</span>
      </div>
      {node.expanded && node.children?.map((child) => (
        <VariableRow key={`${child.name}:${child.variablesReference}`} node={child} depth={depth + 1} onExpand={onExpand} />
      ))}
    </>
  );
}

export function DebugPanel({ debug, onStart, onOpenFrame }: DebugPanelProps) {
  const { state } = debug;
  const running = !!state && state.status !== "terminated";
  const stopped = state?.status === "stopped";
  const [variables, setVariables] = useState<VarNode[]>([]);
  const [watch, setWatch] = useState<{ expr: string; value: string }[]>([]);
  const [watchInput, setWatchInput] = useState("");
  const [consoleInput, setConsoleInput] = useState("");

  // On each stop, load the top frame's scopes → variables (D4).
  const topFrameId = stopped ? state?.frames[0]?.id ?? null : null;
  useEffect(() => {
    if (topFrameId == null) {
      setVariables([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const scopesBody = await debug.fetchScopes(topFrameId);
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
        const vars = parseVariables(await debug.fetchVariables(scope.ref));
        roots.push({ name: scope.name, value: "", variablesReference: scope.ref, children: vars, expanded: true });
      }
      if (!cancelled) setVariables(roots);
    })();
    return () => { cancelled = true; };
  }, [debug, topFrameId]);

  // Re-evaluate watch expressions whenever we stop on a new frame.
  useEffect(() => {
    if (!stopped) return;
    let cancelled = false;
    void (async () => {
      const next = await Promise.all(watch.map(async (w) => ({
        expr: w.expr,
        value: await debug.evaluate(w.expr, "watch"),
      })));
      if (!cancelled) setWatch(next);
    })();
    return () => { cancelled = true; };
    // Intentionally keyed on frame identity, not `watch`, to avoid a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debug, stopped, topFrameId]);

  const expandVariable = useCallback((node: VarNode) => {
    const toggle = (nodes: VarNode[]): VarNode[] => nodes.map((n) => {
      if (n !== node) return { ...n, children: n.children ? toggle(n.children) : n.children };
      return { ...n, expanded: !n.expanded };
    });
    setVariables((current) => toggle(current));
    if (!node.expanded && node.children === null && node.variablesReference > 0) {
      void debug.fetchVariables(node.variablesReference).then((body) => {
        const children = parseVariables(body);
        const assign = (nodes: VarNode[]): VarNode[] => nodes.map((n) => {
          if (n === node) return { ...n, children, expanded: true };
          return { ...n, children: n.children ? assign(n.children) : n.children };
        });
        setVariables((current) => assign(current));
      });
    }
  }, [debug]);

  const addWatch = useCallback(() => {
    const expr = watchInput.trim();
    if (!expr) return;
    setWatchInput("");
    void debug.evaluate(expr, "watch").then((value) => {
      setWatch((current) => [...current, { expr, value }]);
    });
  }, [debug, watchInput]);

  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const submitConsole = useCallback(() => {
    const expr = consoleInput.trim();
    if (!expr) return;
    setConsoleInput("");
    setConsoleLog((current) => [...current, `> ${expr}`]);
    void debug.evaluate(expr, "repl").then((value) => {
      setConsoleLog((current) => [...current, value]);
    });
  }, [debug, consoleInput]);
  const controlBtn = "taomni-btn h-6 w-6 inline-flex items-center justify-center disabled:opacity-30";
  return (
    <div data-testid="code-workspace-debug-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="h-8 shrink-0 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        <Bug className="h-3.5 w-3.5" />
        <span className="font-medium">Debug</span>
        {state && (
          <span className="ml-1 text-[10px] text-[var(--taomni-text-muted)]">
            {state.status}{state.stoppedReason ? ` · ${state.stoppedReason}` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!running && (
            <button
              type="button"
              data-testid="debug-start"
              className={controlBtn}
              onClick={() => onStart?.()}
              disabled={!onStart}
              title="Start debugging the active file"
            >
              <CirclePlay className="h-3.5 w-3.5 text-emerald-500" />
            </button>
          )}
          {running && (
            <>
              <button type="button" data-testid="debug-continue" className={controlBtn}
                onClick={() => debug.step("continue")} disabled={!stopped} title="Continue">
                <CirclePlay className="h-3.5 w-3.5" />
              </button>
              <button type="button" data-testid="debug-pause" className={controlBtn}
                onClick={() => debug.step("pause")} disabled={stopped} title="Pause">
                <Pause className="h-3.5 w-3.5" />
              </button>
              <button type="button" data-testid="debug-step-over" className={controlBtn}
                onClick={() => debug.step("stepOver")} disabled={!stopped} title="Step over">
                <ArrowRightToLine className="h-3.5 w-3.5" />
              </button>
              <button type="button" data-testid="debug-step-in" className={controlBtn}
                onClick={() => debug.step("stepIn")} disabled={!stopped} title="Step into">
                <ArrowDownToLine className="h-3.5 w-3.5" />
              </button>
              <button type="button" data-testid="debug-step-out" className={controlBtn}
                onClick={() => debug.step("stepOut")} disabled={!stopped} title="Step out">
                <ArrowUpFromLine className="h-3.5 w-3.5" />
              </button>
              <button type="button" data-testid="debug-stop" className={controlBtn}
                onClick={() => debug.terminate()} title="Stop">
                <Square className="h-3.5 w-3.5 text-red-500" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!state && (
          <div className="px-3 py-2 text-[var(--taomni-text-muted)]">
            No debug session. Open a Java file and press start (requires the java-debug bundle).
          </div>
        )}
        {state && (
          <>
            <Section title="Call Stack">
              {state.frames.length === 0
                ? <Empty text={stopped ? "No frames" : "Running…"} />
                : state.frames.map((frame) => (
                  <button
                    key={frame.id}
                    type="button"
                    data-testid={`debug-frame-${frame.id}`}
                    className="w-full flex items-center gap-2 px-3 py-0.5 text-left hover:bg-[var(--taomni-hover-bg)] disabled:opacity-50"
                    onClick={() => onOpenFrame(frame)}
                    disabled={!frame.path}
                  >
                    <span className="truncate">{frame.name}</span>
                    {frame.path && (
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
                        {frame.path.split(/[\\/]/).pop()}:{frame.line}
                      </span>
                    )}
                  </button>
                ))}
            </Section>
            <Section title="Variables">
              {variables.length === 0
                ? <Empty text={stopped ? "No variables" : "Stopped only"} />
                : variables.map((node) => (
                  <VariableRow key={`${node.name}:${node.variablesReference}`} node={node} depth={0} onExpand={expandVariable} />
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
              {watch.map((w, i) => (
                <div key={`${w.expr}:${i}`} className="flex items-start gap-2 px-3 py-0.5">
                  <span className="shrink-0 text-[var(--taomni-text)]">{w.expr}</span>
                  <span className="truncate text-[var(--taomni-text-muted)]">= {w.value}</span>
                  <button type="button" className="ml-auto shrink-0 text-[var(--taomni-text-muted)]"
                    onClick={() => setWatch((c) => c.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
            </Section>
            <Section title="Console">
              <div className="max-h-40 overflow-auto px-3 font-mono text-[10px] text-[var(--taomni-text-muted)]">
                {consoleLog.map((line, i) => <div key={i} className="whitespace-pre-wrap">{line}</div>)}
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-[var(--taomni-code-border)]">
      <button
        type="button"
        className="w-full flex items-center gap-1 px-2 py-1 text-left font-medium text-[var(--taomni-text-muted)]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-1 text-[var(--taomni-text-muted)]">{text}</div>;
}
