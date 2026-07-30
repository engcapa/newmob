import { useState } from "react";
import { X } from "lucide-react";
import { redisSetKey } from "../../lib/ipc";

interface RedisNewKeyDialogProps {
  sessionId: string;
  onClose: () => void;
  onCreated: (key: string) => void;
}

type Kind = "string" | "hash" | "list" | "set" | "zset";

export function RedisNewKeyDialog({ sessionId, onClose, onCreated }: RedisNewKeyDialogProps) {
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<Kind>("string");
  const [value, setValue] = useState("");
  const [field, setField] = useState("");
  const [score, setScore] = useState("0");
  const [ttl, setTtl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!key.trim()) {
      setError("Key name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const ttlSecs = ttl.trim() ? parseInt(ttl, 10) : null;
      let payload: unknown;
      switch (kind) {
        case "string":
          payload = value;
          break;
        case "hash":
          payload = field ? [[field, value]] : [];
          break;
        case "zset":
          payload = value ? [[score, value]] : [];
          break;
        case "list":
        case "set":
          payload = value ? [value] : [];
          break;
      }
      await redisSetKey(sessionId, key.trim(), kind, payload, ttlSecs);
      onCreated(key.trim());
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.4)" }}>
      <div
        className="w-[440px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        <div className="h-7 flex shrink-0 items-center px-2 text-[12px] font-semibold" style={{ background: "linear-gradient(to bottom,#5895c8,#2b5d8b)", color: "#fff" }}>
          New Redis key
          <button type="button" className="ml-auto hover:bg-red-500 rounded p-0.5" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-3 grid grid-cols-4 gap-2 items-center text-[12px]">
          <label className="text-right">Key</label>
          <input className="taomni-input col-span-3" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Key name" autoFocus />

          <label className="text-right">Type</label>
          <select className="taomni-input col-span-3" value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Key type">
            <option value="string">String</option>
            <option value="hash">Hash</option>
            <option value="list">List</option>
            <option value="set">Set</option>
            <option value="zset">ZSet</option>
          </select>

          {kind === "hash" && (
            <>
              <label className="text-right">Field</label>
              <input className="taomni-input col-span-3" value={field} onChange={(e) => setField(e.target.value)} aria-label="Initial field" />
            </>
          )}
          {kind === "zset" && (
            <>
              <label className="text-right">Score</label>
              <input className="taomni-input col-span-3" value={score} onChange={(e) => setScore(e.target.value)} aria-label="Initial score" />
            </>
          )}

          <label className="text-right">{kind === "zset" ? "Member" : "Value"}</label>
          <input className="taomni-input col-span-3" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Initial value" />

          <label className="text-right">TTL (s)</label>
          <input className="taomni-input col-span-3" value={ttl} placeholder="(optional)" onChange={(e) => setTtl(e.target.value)} aria-label="TTL seconds" />

          {error && <div className="col-span-4 text-[11px]" style={{ color: "#d9534f" }}>{error}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <button type="button" className="taomni-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="taomni-btn" data-primary="true" disabled={saving} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
