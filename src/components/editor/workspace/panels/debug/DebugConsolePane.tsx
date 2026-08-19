import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, CornerDownLeft, Eraser, Pin } from "lucide-react";
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
  onOpenLocation?: (filePath: string, line: number, column?: number) => void;
}

const MAX_REPL_HISTORY = 100;

function renderConsoleLine(
  text: string,
  onOpenLocation?: (filePath: string, line: number, column?: number) => void,
) {
  if (!onOpenLocation) return text;
  const regex = /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/g;
  const parts: (string | React.ReactNode)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const fullMatch = match[0];
    const path = match[1];
    const line = parseInt(match[2], 10) - 1;
    const col = match[3] ? parseInt(match[3], 10) - 1 : 0;

    parts.push(
      <button
        key={`${match.index}-${fullMatch}`}
        type="button"
        className="underline underline-offset-2 hover:text-[var(--taomni-accent)] text-sky-500 dark:text-sky-400 cursor-pointer inline font-mono"
        onClick={() => onOpenLocation(path, line, col)}
        title={`Jump to ${path}:${line + 1}`}
      >
        {fullMatch}
      </button>,
    );
    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

export function DebugConsolePane({ debug, stopped, visible = true, onOpenLocation }: DebugConsolePaneProps) {
  const { state } = debug;
  const [consoleInput, setConsoleInput] = useState("");
  const [followTail, setFollowTail] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draftInput, setDraftInput] = useState("");
  const lastSeenSeqRef = useRef<number>(0);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  const outputLength = state?.output.length ?? 0;
  const latestSeq = state?.output.length ? (state.output[state.output.length - 1].seq ?? state.output.length) : 0;

  // Auto-scroll when follow-tail is on and output updates
  useEffect(() => {
    if (!visible || !followTail) return;
    const el = consoleRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
      lastSeenSeqRef.current = latestSeq;
    }
  }, [outputLength, visible, followTail, latestSeq]);

  const handleScroll = useCallback(() => {
    const el = consoleRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    setIsAtBottom(atBottom);
    if (atBottom) {
      lastSeenSeqRef.current = latestSeq;
    }
  }, [latestSeq]);

  const scrollToBottom = useCallback(() => {
    const el = consoleRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
      setFollowTail(true);
      lastSeenSeqRef.current = latestSeq;
    }
  }, [latestSeq]);

  const submitConsole = useCallback(() => {
    const expr = consoleInput.trim();
    if (!expr) return;

    // Add to REPL history
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === expr) return prev;
      return [...prev, expr].slice(-MAX_REPL_HISTORY);
    });
    setHistoryIndex(-1);
    setDraftInput("");
    setConsoleInput("");

    const curGen = debug.consoleGeneration;
    const curSessionId = debug.state?.sessionId;
    const curStopEpoch = debug.state?.stopEpoch ?? debug.stopEpoch ?? 0;
    debug.logConsole("repl", `> ${expr}\n`);

    void debug.evaluate(expr, "repl").then((result) => {
      if (debug.consoleGeneration !== curGen) return;
      if (curSessionId && debug.state?.sessionId !== curSessionId) return;
      if (curStopEpoch != null && (debug.state?.stopEpoch ?? debug.stopEpoch ?? 0) !== curStopEpoch) return;
      if (result.value) {
        debug.logConsole("result", `${result.value}\n`);
      }
    });
  }, [debug, consoleInput]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      submitConsole();
    } else if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      if (historyIndex === -1) {
        setDraftInput(consoleInput);
        const newIdx = history.length - 1;
        setHistoryIndex(newIdx);
        setConsoleInput(history[newIdx]);
      } else if (historyIndex > 0) {
        const newIdx = historyIndex - 1;
        setHistoryIndex(newIdx);
        setConsoleInput(history[newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      if (historyIndex === -1) return;
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        const newIdx = historyIndex + 1;
        setHistoryIndex(newIdx);
        setConsoleInput(history[newIdx]);
      } else {
        setHistoryIndex(-1);
        setConsoleInput(draftInput);
      }
    } else if (e.key === "Escape") {
      if (historyIndex !== -1) {
        e.preventDefault();
        setHistoryIndex(-1);
        setConsoleInput(draftInput);
      }
    }
  };

  return (
    <div
      data-testid="debug-console-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px]"
    >
      {/* Console toolbar */}
      <div className="h-6 shrink-0 flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/40 px-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[10px] text-[var(--taomni-text-muted)]">Console Output</span>
          {outputLength > 0 && (
            <span className="text-[10px] text-[var(--taomni-text-muted)]/70">
              ({outputLength} lines)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="debug-console-follow-tail"
            className={`inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] transition-colors ${
              followTail
                ? "bg-sky-500/20 text-sky-400 font-medium"
                : "text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover-bg)]"
            }`}
            title="Follow tail (auto-scroll on new output)"
            onClick={() => setFollowTail((v) => !v)}
          >
            <Pin className="h-3 w-3" />
            <span>Tail</span>
          </button>
          {!isAtBottom && (
            <button
              type="button"
              data-testid="debug-console-scroll-bottom"
              className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover-bg)] hover:text-[var(--taomni-text)] transition-colors"
              title="Scroll to end"
              onClick={scrollToBottom}
            >
              <ArrowDown className="h-3 w-3" />
              <span>Bottom</span>
            </button>
          )}
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
      </div>

      {/* Output log */}
      <div
        ref={consoleRef}
        data-testid="debug-console-output"
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto p-2 font-mono text-[10px] space-y-0.5"
      >
        {!state || state.output.length === 0 ? (
          <div className="text-[var(--taomni-text-muted)] italic p-1">
            Console output will appear here when a debug session is running.
          </div>
        ) : (
          state.output.map((line, i) => (
            <div key={line.seq ?? i} className={`whitespace-pre-wrap ${consoleLineClass(line.category)}`}>
              {renderConsoleLine(line.text, onOpenLocation)}
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
          placeholder={stopped ? "Evaluate expression or command (↑↓ History)" : "REPL active when target is stopped"}
          value={consoleInput}
          disabled={!stopped}
          onChange={(e) => {
            setConsoleInput(e.target.value);
            if (historyIndex !== -1) {
              setDraftInput(e.target.value);
            }
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          data-testid="debug-console-submit"
          onClick={submitConsole}
          disabled={!stopped || !consoleInput.trim()}
          className="rounded p-1 text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover-bg)] hover:text-[var(--taomni-text)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
          title="Send (Enter)"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
