import { useEffect, useMemo, useRef, useState } from "react";
import { historyListRecent } from "../../lib/ipc";
import type { PresetCommand } from "../../lib/commonCommandsPresets";
import type { UserCommonCommand } from "../../lib/terminalProfile";

const HISTORY_LIMIT = 50;

export type CommandSource = "history" | "user" | "preset";

export interface Candidate {
  command: string;
  description?: string;
  source: CommandSource;
}

export interface CommonCommandsPaletteProps {
  open: boolean;
  historyHostKey: string;
  userCommands: ReadonlyArray<UserCommonCommand>;
  presets: ReadonlyArray<PresetCommand>;
  onPick: (command: string) => void;
  onClose: () => void;
}

const SOURCE_LABEL: Record<CommandSource, string> = {
  history: "历史",
  user: "用户",
  preset: "预置",
};

export function mergeCandidates(
  history: ReadonlyArray<string>,
  userCommands: ReadonlyArray<UserCommonCommand>,
  presets: ReadonlyArray<PresetCommand>,
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const cmd of history) {
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push({ command: cmd, source: "history" });
  }
  for (const item of userCommands) {
    if (!item.command || seen.has(item.command)) continue;
    seen.add(item.command);
    out.push({
      command: item.command,
      description: item.description,
      source: "user",
    });
  }
  for (const item of presets) {
    if (!item.command || seen.has(item.command)) continue;
    seen.add(item.command);
    out.push({
      command: item.command,
      description: item.description,
      source: "preset",
    });
  }
  return out;
}

export function filterCandidates(items: ReadonlyArray<Candidate>, query: string): Candidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((c) => {
    const hay = (c.command + " " + (c.description ?? "")).toLowerCase();
    return hay.includes(q);
  });
}

export function CommonCommandsPalette({
  open,
  historyHostKey,
  userCommands,
  presets,
  onPick,
  onClose,
}: CommonCommandsPaletteProps) {
  const [history, setHistory] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset state on open and fetch a fresh history snapshot.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    let cancelled = false;
    historyListRecent(historyHostKey, HISTORY_LIMIT)
      .then((items) => {
        if (!cancelled) setHistory(items);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    // Defer focus past the render so the input exists.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, historyHostKey]);

  const candidates = useMemo(
    () => mergeCandidates(history, userCommands, presets),
    [history, userCommands, presets],
  );
  const filtered = useMemo(() => filterCandidates(candidates, query), [candidates, query]);

  // Clamp selection when filter shrinks the list.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((idx) => Math.min(idx, filtered.length - 1));
  }, [filtered.length]);

  // Keep selected row in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const node = list.children[selectedIndex] as HTMLElement | undefined;
    if (typeof node?.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[selectedIndex];
      if (item) onPick(item.command);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length === 0) return;
      setSelectedIndex((i) => (i + 1) % filtered.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSelectedIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (filtered.length > 0) setSelectedIndex(filtered.length - 1);
      return;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onMouseDown={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label="Common commands"
        data-testid="commands-palette"
        className="w-[560px] max-w-[92vw] rounded shadow-lg flex flex-col"
        style={{
          background: "var(--moba-panel-bg)",
          border: "1px solid var(--moba-divider)",
          maxHeight: "60vh",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-2 border-b" style={{ borderColor: "var(--moba-divider)" }}>
          <input
            ref={inputRef}
            data-testid="commands-search"
            className="moba-input w-full"
            placeholder="搜索常用命令…   (↑↓ 选择, Enter 插入, Esc 关闭)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter commands"
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-auto" data-testid="commands-list">
          {filtered.length === 0 ? (
            <div
              className="px-3 py-4 text-[12px]"
              style={{ color: "var(--moba-text-muted)" }}
            >
              没有匹配的命令
            </div>
          ) : (
            <ul ref={listRef} className="text-[12px]" role="listbox">
              {filtered.map((c, i) => (
                <li
                  key={`${c.source}:${c.command}`}
                  role="option"
                  aria-selected={i === selectedIndex}
                  className="px-3 py-1.5 cursor-pointer flex items-baseline gap-2"
                  style={{
                    background: i === selectedIndex ? "var(--moba-hover)" : "transparent",
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onMouseDown={(e) => {
                    // Mousedown to preempt the backdrop's onMouseDown handler.
                    e.preventDefault();
                    e.stopPropagation();
                    onPick(c.command);
                  }}
                >
                  <span className="font-mono whitespace-pre" style={{ color: "var(--moba-text)" }}>
                    {c.command}
                  </span>
                  {c.description && (
                    <span
                      className="truncate flex-1"
                      style={{ color: "var(--moba-text-muted)" }}
                      title={c.description}
                    >
                      {c.description}
                    </span>
                  )}
                  <span
                    className="ml-auto shrink-0 px-1.5 py-0 rounded text-[10px]"
                    style={{
                      background: "var(--moba-card-bg)",
                      color: "var(--moba-text-muted)",
                      border: "1px solid var(--moba-divider)",
                    }}
                  >
                    {SOURCE_LABEL[c.source]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div
          className="px-3 py-1.5 text-[11px] border-t"
          style={{
            color: "var(--moba-text-muted)",
            borderColor: "var(--moba-divider)",
          }}
        >
          选中后插入到当前输入行（不回车），可继续编辑后再执行
        </div>
      </div>
    </div>
  );
}

export const __testing = { mergeCandidates, filterCandidates };
