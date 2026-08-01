import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Crosshair, Trash2, Radio, Star } from "lucide-react";
import { redisExec } from "../../lib/ipc";
import {
  displaySqlShortcut,
  loadSqlExecutionPreferences,
  subscribeSqlExecutionPreferences,
} from "../../lib/sqlExecutionPreferences";

interface RedisCliProps {
  sessionId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  input: string;
  onInputChange: (value: string) => void;
  onSaveQuery: () => void;
}

export interface RedisCliHandle {
  runCommand: (command: string) => Promise<void>;
}

interface CliLine {
  cmd?: string;
  reply: string;
  error?: boolean;
}

const KNOWN_COMMANDS = [
  "GET", "SET", "DEL", "EXPIRE", "TTL", "PERSIST", "KEYS", "SCAN", "TYPE",
  "HGET", "HSET", "HGETALL", "HDEL", "LPUSH", "RPUSH", "LRANGE", "LREM",
  "SADD", "SREM", "SMEMBERS", "ZADD", "ZRANGE", "ZREM", "XADD", "XRANGE",
  "INCR", "DECR", "EXISTS", "PING", "INFO", "DBSIZE", "FLUSHDB", "SELECT",
  "OBJECT", "MEMORY", "MONITOR",
];

export const RedisCli = forwardRef<RedisCliHandle, RedisCliProps>(function RedisCli({
  sessionId,
  collapsed,
  onToggleCollapse,
  input,
  onInputChange,
  onSaveQuery,
}, ref) {
  const [lines, setLines] = useState<CliLine[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);
  const historyRef = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  const monitorTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      if (monitorTimer.current) clearInterval(monitorTimer.current);
    };
  }, []);

  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );

  const append = useCallback((line: CliLine) => setLines((prev) => [...prev, line].slice(-500)), []);

  const runCommand = useCallback(async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    historyRef.current = [cmd, ...historyRef.current].slice(0, 200);
    historyIdx.current = -1;
    try {
      const reply = await redisExec(sessionId, cmd);
      append({ cmd, reply });
    } catch (err) {
      append({ cmd, reply: String(err), error: true });
    }
  }, [append, sessionId]);

  useImperativeHandle(ref, () => ({ runCommand }), [runCommand]);

  const tabComplete = () => {
    const upper = input.toUpperCase();
    const match = KNOWN_COMMANDS.find((c) => c.startsWith(upper) && c !== upper);
    if (match) onInputChange(match + " ");
  };

  const toggleMonitor = () => {
    // MONITOR streams server-side; we approximate by polling a lightweight
    // command set. A true streaming MONITOR needs a dedicated channel — here
    // we surface INFO commandstats deltas as a stand-in stream so the toggle
    // is functional without a long-lived subscription.
    if (monitoring) {
      if (monitorTimer.current) clearInterval(monitorTimer.current);
      monitorTimer.current = null;
      setMonitoring(false);
      append({ reply: "-- monitor stopped --" });
      return;
    }
    setMonitoring(true);
    append({ reply: "-- monitor started (polling INFO commandstats) --" });
    monitorTimer.current = setInterval(() => {
      redisExec(sessionId, "INFO commandstats")
        .then((reply) => {
          const firstLine = reply.split("\n").find((l) => l.includes("cmdstat")) ?? reply.split("\n")[0] ?? "";
          if (firstLine) append({ reply: firstLine });
        })
        .catch(() => undefined);
    }, 2000);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="h-7 shrink-0 w-full flex items-center gap-2 px-2 text-[11px]"
        style={{
          background: "var(--taomni-quick-bg)",
          borderTop: "1px solid var(--taomni-divider)",
          fontSize: "var(--taomni-db-font-size-sm, 11px)",
        }}
        onClick={onToggleCollapse}
      >
        <ChevronUp className="w-3.5 h-3.5" /> Redis CLI
      </button>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="redis-cli">
      <div
        className="h-7 shrink-0 flex items-center gap-2 px-2 text-[11px]"
        style={{
          background: "var(--taomni-quick-bg)",
          borderTop: "1px solid var(--taomni-divider)",
          borderBottom: "1px solid var(--taomni-divider)",
          fontSize: "var(--taomni-db-font-size-sm, 11px)",
        }}
      >
        <button type="button" className="inline-flex items-center gap-1" onClick={onToggleCollapse}>
          <ChevronDown className="w-3.5 h-3.5" /> Redis CLI
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40"
          data-testid="redis-run-current"
          title={`Run current command (${displaySqlShortcut(executionPreferences.runCurrent)})`}
          disabled={!input.trim()}
          onClick={() => {
            void runCommand(input);
            onInputChange("");
          }}
        >
          <Crosshair className="w-3.5 h-3.5" /> Current
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1.5 rounded hover:bg-[var(--taomni-hover)]"
          title="Save command to query library"
          data-testid="redis-save-query"
          onClick={onSaveQuery}
        >
          <Star className="w-3.5 h-3.5 text-[var(--taomni-accent)]" /> Save Query
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1.5 rounded hover:bg-[var(--taomni-hover)]"
          style={{ color: monitoring ? "#d9534f" : "var(--taomni-text-muted)" }}
          onClick={toggleMonitor}
          title="Toggle MONITOR"
        >
          <Radio className="w-3.5 h-3.5" /> {monitoring ? "Stop" : "Monitor"}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1.5 rounded hover:bg-[var(--taomni-hover)]"
          onClick={() => setLines([])}
          title="Clear output"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>
      </div>
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-2 font-mono text-[12px]"
        style={{
          background: "var(--taomni-term-bg)",
          color: "var(--taomni-term-text)",
          fontSize: "var(--taomni-db-font-size, 12px)",
        }}
      >
        {lines.map((line, i) => (
          <div key={i}>
            {line.cmd && <div style={{ color: "var(--taomni-accent)" }}>&gt; {line.cmd}</div>}
            <pre className="whitespace-pre-wrap" style={{ color: line.error ? "#ff6b6b" : undefined, margin: 0 }}>
              {line.reply}
            </pre>
          </div>
        ))}
      </div>
      <div className="shrink-0 flex items-center gap-1 px-2 py-1" style={{ borderTop: "1px solid var(--taomni-divider)" }}>
        <span
          className="text-[var(--taomni-accent)] font-mono text-[12px]"
          style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
        >
          &gt;
        </span>
        <input
          className="taomni-input flex-1 font-mono"
          style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
          value={input}
          placeholder="Type a Redis command and press Enter"
          aria-label="Redis command"
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void runCommand(input);
              onInputChange("");
            } else if (e.key === "Tab") {
              e.preventDefault();
              tabComplete();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (historyIdx.current < historyRef.current.length - 1) {
                historyIdx.current += 1;
                onInputChange(historyRef.current[historyIdx.current] ?? "");
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (historyIdx.current > 0) {
                historyIdx.current -= 1;
                onInputChange(historyRef.current[historyIdx.current] ?? "");
              } else {
                historyIdx.current = -1;
                onInputChange("");
              }
            }
          }}
        />
      </div>
    </div>
  );
});
