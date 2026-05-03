import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Home, RefreshCw } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import type { SessionConfig } from "../../lib/ipc";

interface QuickConnectProps {
  onConnectInput: (value: string) => void;
  onConnectSession: (session: SessionConfig) => void;
  onHome?: () => void;
}

export function QuickConnect({ onConnectInput, onConnectSession, onHome }: QuickConnectProps) {
  const [value, setValue] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const { sessions, loadSessions } = useSessionStore();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);

  const recent = useMemo(
    () =>
      sessions
        .filter((session) => session.last_connected_at)
        .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
        .slice(0, 3),
    [sessions],
  );

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    onConnectInput(next);
    setValue("");
  };

  const refreshSessions = async () => {
    if (refreshing) return;

    setRefreshing(true);
    setStatusMessage("Refreshing sessions...");
    try {
      await loadSessions();
      setStatusMessage("Sessions refreshed");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      data-testid="quick-connect"
      className="h-7 flex items-center gap-1 px-2 text-[12px]"
      style={{
        background: "var(--moba-quick-bg)",
        borderBottom: "1px solid var(--moba-divider)",
      }}
    >
      <button className="p-0.5 hover:bg-[var(--moba-control-hover)] rounded" title="Back" onClick={() => window.history.back()} type="button">
        <ArrowLeft className="w-3.5 h-3.5" />
      </button>
      <button className="p-0.5 hover:bg-[var(--moba-control-hover)] rounded" title="Forward" onClick={() => window.history.forward()} type="button">
        <ArrowRight className="w-3.5 h-3.5" />
      </button>
      <button className="p-0.5 hover:bg-[var(--moba-control-hover)] rounded" title="Home" onClick={onHome} type="button">
        <Home className="w-3.5 h-3.5" />
      </button>
      <span className="moba-divider-v h-4 mx-1" />
      <span className="text-[var(--moba-text-muted)]">Quick connect:</span>
      <input
        data-testid="qc-input"
        aria-label="Quick connect"
        className="moba-input flex-1 max-w-md"
        placeholder="ssh user@host  •  rdp://host  •  telnet host  •  paste session URL…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <button data-testid="qc-submit" className="moba-btn" onClick={submit} type="button">Go</button>
      <span className="moba-divider-v h-4 mx-2" />
      <span className="text-[var(--moba-text-muted)]">Recent:</span>
      {recent.length === 0 ? (
        <span className="text-[var(--moba-text-muted)]">none</span>
      ) : (
        recent.map((session) => (
          <button
            key={session.id}
            className="px-1.5 py-0.5 rounded hover:bg-[var(--moba-control-hover)] underline max-w-[110px] truncate"
            style={{ color: "var(--moba-link)" }}
            onClick={() => onConnectSession(session)}
            title={`${session.name} (${session.session_type})`}
            type="button"
          >
            {session.name}
          </button>
        ))
      )}
      <button
        className="p-0.5 hover:bg-[var(--moba-control-hover)] rounded disabled:opacity-50"
        title={refreshing ? "Refreshing sessions..." : "Refresh sessions"}
        onClick={() => void refreshSessions()}
        disabled={refreshing}
        type="button"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
      </button>
      {refreshing && <span className="text-[var(--moba-text-muted)]">refreshing...</span>}
    </div>
  );
}
