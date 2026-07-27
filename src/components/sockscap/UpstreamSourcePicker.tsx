import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, RefreshCw } from "lucide-react";
import type { LocalProxyCandidate } from "../../lib/sockscap";

/** A saved SSH/proxy session offered as an upstream source. */
export interface SessionSource {
  id: string;
  name: string;
  host: string;
  port: number;
  kind: "proxy" | "ssh";
}

/** What the user picked. The panel translates this into an UpstreamRef patch. */
export type UpstreamChoice =
  | { source: "manual" }
  | { source: "detected"; candidate: LocalProxyCandidate }
  | { source: "session"; session: SessionSource };

export interface UpstreamSourcePickerProps {
  /** Restricts which sources make sense for the current upstream kind. */
  mode: "ssh" | "proxy";
  /** Detected running local proxies (already fetched by the panel). */
  detected: LocalProxyCandidate[];
  /** Saved SSH/proxy sessions. */
  sessions: SessionSource[];
  /** Current upstream, used to render the selected state. */
  current: { sessionId?: string; host?: string; port?: number; kind: string };
  onSelect: (choice: UpstreamChoice) => void;
  /** Re-run detection; the picker shows a spinner while awaited. */
  onRescan: () => Promise<void>;
  busy?: boolean;
  t: (key: string, vars?: Record<string, string>) => string;
  testId?: string;
}

const MANUAL_KEY = "__manual__";

/** Internal flat row: either a group header or a selectable option. */
type Row =
  | { type: "header"; key: string; label: string }
  | { type: "option"; key: string; label: string; sub: string; choice: UpstreamChoice };

function candidateKey(c: LocalProxyCandidate): string {
  return `detected:${c.host}:${c.port}:${c.pid}`;
}
function sessionKey(s: SessionSource): string {
  return `session:${s.id}`;
}

/** Build the grouped, flattened row list for the given sources + mode. */
function buildRows(
  mode: "ssh" | "proxy",
  detected: LocalProxyCandidate[],
  sessions: SessionSource[],
  t: (key: string, vars?: Record<string, string>) => string,
): Row[] {
  const rows: Row[] = [];

  // Detected local proxies only make sense for native SOCKS5/HTTP upstreams.
  if (mode === "proxy" && detected.length > 0) {
    // Group by client family; "unknown" sinks to the bottom under a generic label.
    const groups = new Map<string, LocalProxyCandidate[]>();
    for (const c of detected) {
      const label =
        c.clientLabel || (c.client && c.client !== "unknown" ? c.client : "");
      const key = label || t("sockscap.picker.otherLocal");
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }
    const otherLabel = t("sockscap.picker.otherLocal");
    const ordered = [...groups.entries()].sort(([a], [b]) => {
      if (a === otherLabel) return 1;
      if (b === otherLabel) return -1;
      return a.localeCompare(b);
    });
    for (const [groupLabel, list] of ordered) {
      rows.push({ type: "header", key: `h:detected:${groupLabel}`, label: groupLabel });
      for (const c of list) {
        rows.push({
          type: "option",
          key: candidateKey(c),
          label: `${c.host}:${c.port}`,
          sub: `${c.kind.toUpperCase()}${c.process ? ` · ${c.process}` : ""}`,
          choice: { source: "detected", candidate: c },
        });
      }
    }
  }

  // Saved sessions relevant to this upstream kind.
  const relevant = sessions.filter((s) => (mode === "ssh" ? s.kind === "ssh" : s.kind === "proxy"));
  if (relevant.length > 0) {
    rows.push({
      type: "header",
      key: "h:sessions",
      label: mode === "ssh" ? t("sockscap.picker.sshSessions") : t("sockscap.picker.proxySessions"),
    });
    for (const s of relevant) {
      rows.push({
        type: "option",
        key: sessionKey(s),
        label: s.name,
        sub: `${s.host}:${s.port}`,
        choice: { source: "session", session: s },
      });
    }
  }

  // Manual entry is always available.
  rows.push({ type: "header", key: "h:manual", label: t("sockscap.picker.manualGroup") });
  rows.push({
    type: "option",
    key: MANUAL_KEY,
    label: t("sockscap.manualUpstream"),
    sub: t("sockscap.picker.manualHint"),
    choice: { source: "manual" },
  });

  return rows;
}

/** Which row key matches the current upstream selection. */
function selectedKey(
  current: { sessionId?: string; host?: string; port?: number },
  detected: LocalProxyCandidate[],
): string {
  if (current.sessionId) {
    return `session:${current.sessionId}`;
  }
  // A detected candidate is "selected" when host+port match and no session is set.
  const match = detected.find((c) => c.host === current.host && c.port === current.port);
  if (match) {
    return candidateKey(match);
  }
  if (!current.host) {
    return MANUAL_KEY;
  }
  return MANUAL_KEY;
}

export function UpstreamSourcePicker({
  mode,
  detected,
  sessions,
  current,
  onSelect,
  onRescan,
  busy = false,
  t,
  testId = "sockscap-upstream-source",
}: UpstreamSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [rescanning, setRescanning] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allRows = useMemo(
    () => buildRows(mode, detected, sessions, t),
    [mode, detected, sessions, t],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    // Keep a header only if it has at least one matching option beneath it.
    const kept: Row[] = [];
    let pendingHeader: Row | null = null;
    for (const row of allRows) {
      if (row.type === "header") {
        pendingHeader = row;
        continue;
      }
      const hay = `${row.label} ${row.sub}`.toLowerCase();
      if (hay.includes(q)) {
        if (pendingHeader) {
          kept.push(pendingHeader);
          pendingHeader = null;
        }
        kept.push(row);
      }
    }
    return kept;
  }, [allRows, query]);

  // Indices of selectable option rows (skip headers for keyboard nav).
  const optionIdxs = useMemo(
    () => filtered.map((r, i) => (r.type === "option" ? i : -1)).filter((i) => i >= 0),
    [filtered],
  );

  const curKey = useMemo(() => selectedKey(current, detected), [current, detected]);

  const selectedLabel = useMemo(() => {
    const row = allRows.find((r) => r.type === "option" && r.key === curKey);
    if (row && row.type === "option") {
      return row.key === MANUAL_KEY ? row.label : `${row.label}`;
    }
    return t("sockscap.manualUpstream");
  }, [allRows, curKey, t]);

  // On open: focus filter, seed active row to the current selection.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sel = filtered.findIndex((r) => r.type === "option" && r.key === curKey);
    setActiveIdx(sel >= 0 ? sel : (optionIdxs[0] ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the active row scrolled into view. `scrollIntoView` is absent under
  // jsdom, so guard it rather than crashing the effect in tests.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx, open]);

  const moveActive = (dir: 1 | -1) => {
    if (optionIdxs.length === 0) return;
    const pos = optionIdxs.indexOf(activeIdx);
    const nextPos =
      pos < 0
        ? dir === 1
          ? 0
          : optionIdxs.length - 1
        : (pos + dir + optionIdxs.length) % optionIdxs.length;
    setActiveIdx(optionIdxs[nextPos]);
  };

  const commit = (row: Row) => {
    if (row.type !== "option") return;
    onSelect(row.choice);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = filtered[activeIdx];
      if (row) commit(row);
    }
  };

  const doRescan = async () => {
    setRescanning(true);
    try {
      await onRescan();
    } finally {
      setRescanning(false);
    }
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-left inline-flex items-center gap-1"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
      </button>
      {open && (
        <div
          role="listbox"
          data-testid={`${testId}-menu`}
          className="absolute left-0 top-full z-50 mt-1 w-full max-h-72 flex flex-col overflow-hidden rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg"
          onKeyDown={onKeyDown}
        >
          <div className="shrink-0 border-b border-[var(--taomni-divider)] p-1.5 flex gap-1.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
              <input
                ref={inputRef}
                type="search"
                data-testid={`${testId}-filter`}
                className="w-full text-[12px] pl-7 pr-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                placeholder={t("sockscap.picker.filterPh")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
            <button
              type="button"
              data-testid={`${testId}-rescan`}
              className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0 inline-flex items-center gap-1"
              onClick={() => void doRescan()}
              disabled={busy || rescanning}
              title={t("sockscap.picker.rescan")}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rescanning ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-0.5">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
                {t("sockscap.picker.noMatch")}
              </div>
            ) : (
              filtered.map((row, idx) =>
                row.type === "header" ? (
                  <div
                    key={row.key}
                    className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]"
                  >
                    {row.label}
                  </div>
                ) : (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={row.key === curKey}
                    data-idx={idx}
                    data-testid={`${testId}-option`}
                    data-value={row.key}
                    className={`w-full px-2 py-1.5 text-left rounded flex items-center gap-2 cursor-pointer outline-none ${
                      idx === activeIdx
                        ? "bg-[var(--taomni-accent)]/15"
                        : "hover:bg-[var(--taomni-hover)]"
                    } ${row.key === curKey ? "text-[var(--taomni-accent)]" : ""}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => commit(row)}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px]">{row.label}</span>
                    {row.sub && (
                      <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)] truncate max-w-[55%]">
                        {row.sub}
                      </span>
                    )}
                  </button>
                ),
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

