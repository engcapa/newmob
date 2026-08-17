import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import { consoleLineClass } from "./debugPanelShared";

export interface DebugConsolePaneProps {
  debug: CodeDebugSession;
  stopped: boolean;
  /**
   * Whether this pane is the visible sub-tab. While hidden (display:none)
   * scrollHeight is 0, so auto-scroll must re-run when the pane becomes
   * visible again or the console appears stuck at the top.
   */
  visible?: boolean;
}

export function DebugConsolePane({ debug, stopped, visible = true }: DebugConsolePaneProps) {
  const { state } = debug;
  const [consoleInput, setConsoleInput] = useState("");
  const consoleRef = useRef<HTMLDivElement | null>(null);

  const outputLength = state?.output.length ?? 0;
  useEffect(() => {
    if (!visible) return;
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outputLength, visible]);

  const submitConsole = useCallback(() => {
    const expr = consoleInput.trim();
    if (!expr) return;
    setConsoleInput("");
    debug.logConsole("repl", `> ${expr}\n`);
    void debug.evaluate(expr, "repl").then((result) => {
      debug.logConsole("result", `${result.value}\n`);
    });
  }, [debug, consoleInput]);

  return (
    <div
      data-testid="debug-console-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px]"
    >
      {/* Console toolbar */}
      <div className="h-6 shrink-0 flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/40 px-2">
        <span className="font-medium text-[10px] text-[var(--taomni-text-muted)]">Console Output</span>
        <button
          type="button"
          data-testid="debug-console-clear"
          className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover-bg)] hover:text-[var(--taomni-text)] transition-colors"
          title="Clear console"
          onClick={() => debug.clearConsole()}
        >
          <Eraser className="h-3 w-3" />
          <span>Clear</span>
        </button>
      </div>

      {/* Output log */}
      <div
        ref={consoleRef}
        data-testid="debug-console-output"
        className="flex-1 min-h-0 overflow-auto p-2 font-mono text-[10px] space-y-0.5"
      >
        {!state || state.output.length === 0 ? (
          <div className="text-[var(--taomni-text-muted)] italic p-1">
            Console output will appear here when a debug session is running.
          </div>
        ) : (
          state.output.map((line, i) => (
            <div key={i} className={`whitespace-pre-wrap ${consoleLineClass(line.category)}`}>
              {line.text}
            </div>
          ))
        )}
      </div>

      {/* REPL prompt input */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/20 shrink-0">
        <span className="font-mono text-[11px] text-[var(--taomni-text-muted)]">&gt;</span>
        <input
          data-testid="debug-console-input"
          className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40"
          placeholder={stopped ? "Evaluate expression or command" : "REPL active when target is stopped"}
          value={consoleInput}
          disabled={!stopped}
          onChange={(e) => setConsoleInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitConsole();
          }}
        />
      </div>
    </div>
  );
}
