import { useEffect, useRef, useState, useCallback } from "react";
import {
  Users, X, Send, ChevronUp, ChevronDown, Maximize2, Clock, CornerDownLeft,
} from "lucide-react";

// Module-level history shared between compact bar and expanded panel
const _history: string[] = [];

export function getMultiExecHistory(): readonly string[] {
  return _history;
}

function pushHistory(cmd: string) {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  const idx = _history.indexOf(trimmed);
  if (idx !== -1) _history.splice(idx, 1);
  _history.push(trimmed);
}

// ─── Expanded editor panel ────────────────────────────────────────────────────

const MIN_HEIGHT = 180;
const MAX_HEIGHT_RATIO = 0.85;
const DEFAULT_HEIGHT = 340;

interface ExpandedEditorProps {
  initialValue: string;
  onSend: (data: string) => void;
  onClose: () => void;
  onApplyToBar: (value: string) => void;
}

function ExpandedEditor({ initialValue, onSend, onClose, onApplyToBar }: ExpandedEditorProps) {
  const [value, setValue] = useState(initialValue);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragStartY = useRef<number | null>(null);
  const dragStartHeight = useRef(DEFAULT_HEIGHT);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard: Escape closes, Enter sends (when not in textarea)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Drag-resize from top edge
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartHeight.current = panelHeight;

    const onMove = (ev: MouseEvent) => {
      if (dragStartY.current === null) return;
      const delta = dragStartY.current - ev.clientY; // dragging up = taller
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
      const next = Math.max(MIN_HEIGHT, Math.min(maxH, dragStartHeight.current + delta));
      setPanelHeight(next);
    };
    const onUp = () => {
      dragStartY.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  const handleSend = useCallback(() => {
    if (!value.trim()) return;
    pushHistory(value.trim());
    const lines = value.split("\n");
    onSend(lines.join("\r\n") + "\r");
    onClose();
  }, [value, onSend, onClose]);

  const handleApply = useCallback(() => {
    onApplyToBar(value);
    onClose();
  }, [value, onApplyToBar, onClose]);

  const handleHistoryClick = (cmd: string, idx: number) => {
    setValue(cmd);
    setSelectedIdx(idx);
    textareaRef.current?.focus();
  };

  const history = getMultiExecHistory();
  const lineCount = value.split("\n").length;

  return (
    // True modal backdrop — pointer events blocked, no click-to-close
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,0.45)", pointerEvents: "all" }}
    >
      <div
        className="flex flex-col shadow-2xl overflow-hidden"
        style={{
          width: "min(900px, 96vw)",
          height: panelHeight,
          background: "var(--moba-bg)",
          border: "1px solid var(--moba-divider)",
          borderBottom: "none",
          borderRadius: "6px 6px 0 0",
        }}
      >
        {/* Drag-resize handle on top edge */}
        <div
          className="flex-shrink-0 flex items-center justify-center"
          style={{
            height: 6,
            cursor: "ns-resize",
            background: "var(--moba-chrome-bg)",
            borderBottom: "1px solid var(--moba-divider)",
          }}
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize"
        >
          <div
            style={{
              width: 32,
              height: 3,
              borderRadius: 2,
              background: "var(--moba-divider)",
            }}
          />
        </div>

        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0"
          style={{
            background: "var(--moba-chrome-bg)",
            borderBottom: "1px solid var(--moba-divider)",
          }}
        >
          <Users className="w-3.5 h-3.5" style={{ color: "#7a3d9d" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--moba-text)" }}>
            MultiExec — Command Editor
          </span>
          <span className="text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
            Shift+Enter for newline · Enter to send · Esc to close
          </span>
          <div className="flex-1" />
          <button
            className="w-5 h-5 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)]"
            onClick={onClose}
            type="button"
            title="Close (Esc)"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {/* Body: editor + history sidebar */}
        <div className="flex flex-1 min-h-0">
          {/* Editor */}
          <div className="flex flex-col flex-1 min-w-0 p-2 gap-2">
            <textarea
              ref={textareaRef}
              className="moba-input flex-1 resize-none leading-5 p-2 font-mono text-xs"
              style={{ height: "100%", minHeight: 0 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
                // Escape handled by window listener above
              }}
              spellCheck={false}
              placeholder={"Enter command(s) to broadcast…\nShift+Enter for multiple lines"}
            />
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                className="moba-btn flex items-center gap-1"
                data-primary="true"
                onClick={handleSend}
                disabled={!value.trim()}
                type="button"
              >
                <Send className="w-3 h-3" />
                {lineCount > 1 ? `Send (${lineCount} lines)` : "Send"}
              </button>
              <button
                className="moba-btn flex items-center gap-1"
                onClick={handleApply}
                type="button"
                title="Copy to compact bar without sending"
              >
                <CornerDownLeft className="w-3 h-3" />
                Apply to bar
              </button>
              <span className="text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
                {lineCount} line{lineCount !== 1 ? "s" : ""}
              </span>
            </div>
          </div>

          {/* History sidebar */}
          {history.length > 0 && (
            <div
              className="flex flex-col flex-shrink-0 overflow-hidden"
              style={{ width: 240, borderLeft: "1px solid var(--moba-divider)" }}
            >
              <div
                className="px-2 py-1 text-[11px] font-semibold flex-shrink-0"
                style={{
                  background: "var(--moba-chrome-bg)",
                  borderBottom: "1px solid var(--moba-divider)",
                  color: "var(--moba-text-muted)",
                }}
              >
                <Clock className="w-3 h-3 inline mr-1" />
                History ({history.length})
              </div>
              <div className="flex-1 overflow-y-auto moba-scroll-y">
                {[...history].reverse().map((cmd, i) => {
                  const originalIdx = history.length - 1 - i;
                  const isSelected = selectedIdx === originalIdx;
                  const preview = cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
                  return (
                    <button
                      key={originalIdx}
                      type="button"
                      className="w-full text-left px-2 py-1.5 flex flex-col gap-0.5"
                      style={{
                        background: isSelected ? "var(--moba-selected)" : undefined,
                        borderBottom: "1px solid var(--moba-divider)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) (e.currentTarget as HTMLElement).style.background = "var(--moba-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) (e.currentTarget as HTMLElement).style.background = "";
                      }}
                      onClick={() => handleHistoryClick(cmd, originalIdx)}
                    >
                      <span
                        className="text-[11px] font-mono truncate block"
                        style={{ color: "var(--moba-text)" }}
                      >
                        {preview}
                      </span>
                      <span className="text-[10px]" style={{ color: "var(--moba-text-muted)" }}>
                        #{originalIdx + 1}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Compact bar ─────────────────────────────────────────────────────────────

interface MultiExecBarProps {
  selectedCount: number;
  totalTerminalCount: number;
  onSend: (data: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onClose: () => void;
}

export function MultiExecBar({
  selectedCount,
  totalTerminalCount,
  onSend,
  onSelectAll,
  onClearSelection,
  onClose,
}: MultiExecBarProps) {
  const [value, setValue] = useState("");
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  // Stash the in-progress value when navigating history
  const draftRef = useRef("");
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
  }, [value]);

  const handleSend = useCallback(() => {
    if (!value.trim()) return;
    pushHistory(value.trim());
    setHistoryIdx(null);
    draftRef.current = "";
    const lines = value.split("\n");
    onSend(lines.join("\r\n") + "\r");
    setValue("");
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
    textareaRef.current?.focus();
  }, [value, onSend]);

  const navigateHistory = useCallback((direction: "up" | "down") => {
    const history = getMultiExecHistory();
    if (history.length === 0) return;

    if (historyIdx === null) {
      // Save current draft before entering history
      draftRef.current = value;
    }

    let nextIdx: number | null;
    if (direction === "up") {
      if (historyIdx === null) {
        nextIdx = history.length - 1;
      } else {
        nextIdx = historyIdx > 0 ? historyIdx - 1 : historyIdx;
      }
    } else {
      if (historyIdx === null) return;
      if (historyIdx >= history.length - 1) {
        // Back to draft
        nextIdx = null;
        setValue(draftRef.current);
        setHistoryIdx(null);
        return;
      }
      nextIdx = historyIdx + 1;
    }

    setHistoryIdx(nextIdx);
    if (nextIdx !== null) setValue(history[nextIdx]);
  }, [historyIdx, value]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowUp" && !e.shiftKey) {
      // Only navigate history when on the first line
      const el = textareaRef.current;
      if (el && el.selectionStart === 0 && !value.includes("\n")) {
        e.preventDefault();
        navigateHistory("up");
      }
    } else if (e.key === "ArrowDown" && !e.shiftKey) {
      const el = textareaRef.current;
      const atEnd = el && el.selectionStart === el.value.length;
      if (atEnd && !value.includes("\n")) {
        e.preventDefault();
        navigateHistory("down");
      }
    }
  }, [handleSend, onClose, navigateHistory, value]);

  const handleValueChange = (newVal: string) => {
    setValue(newVal);
    // If user edits while in history, exit history mode
    if (historyIdx !== null) {
      setHistoryIdx(null);
      draftRef.current = "";
    }
  };

  const lineCount = value.split("\n").length;
  const history = getMultiExecHistory();

  return (
    <>
      {expanded && (
        <ExpandedEditor
          initialValue={value}
          onSend={(data) => { onSend(data); }}
          onClose={() => setExpanded(false)}
          onApplyToBar={(v) => { setValue(v); setHistoryIdx(null); }}
        />
      )}
      <div
        className="flex items-start gap-1.5 px-2 py-1 flex-shrink-0"
        style={{
          minHeight: 34,
          background: "var(--moba-chrome-bg)",
          borderTop: "1px solid var(--moba-divider)",
        }}
      >
        <Users
          className="w-3.5 h-3.5 flex-shrink-0 mt-1"
          style={{ color: "#7a3d9d" }}
        />
        <div className="flex-1 flex items-start gap-1 min-w-0">
          <textarea
            ref={textareaRef}
            className="moba-input flex-1 resize-none leading-5 py-0.5"
            style={{ minHeight: 22, maxHeight: 100, overflow: "auto" }}
            rows={1}
            placeholder="Send to selected terminals… (Enter to send, Shift+Enter for newline)"
            value={value}
            onChange={(e) => handleValueChange(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          {/* History navigation arrows */}
          <div className="flex flex-col flex-shrink-0" style={{ marginTop: 1 }}>
            <button
              type="button"
              className="w-4 h-3.5 inline-flex items-center justify-center rounded-t hover:bg-[var(--moba-hover)] disabled:opacity-30"
              style={{ border: "1px solid var(--moba-divider)", borderBottom: "none", background: "var(--moba-button-to)" }}
              onClick={() => navigateHistory("up")}
              disabled={history.length === 0}
              title="Previous command (↑)"
            >
              <ChevronUp className="w-2.5 h-2.5" />
            </button>
            <button
              type="button"
              className="w-4 h-3.5 inline-flex items-center justify-center rounded-b hover:bg-[var(--moba-hover)] disabled:opacity-30"
              style={{ border: "1px solid var(--moba-divider)", background: "var(--moba-button-to)" }}
              onClick={() => navigateHistory("down")}
              disabled={historyIdx === null}
              title="Next command (↓)"
            >
              <ChevronDown className="w-2.5 h-2.5" />
            </button>
          </div>
          {/* Expand button */}
          <button
            type="button"
            className="w-5 h-5 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] flex-shrink-0 mt-0.5"
            style={{ border: "1px solid var(--moba-divider)" }}
            onClick={() => setExpanded(true)}
            title="Open expanded editor"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
          <button
            className="moba-btn flex items-center"
            data-primary="true"
            onClick={handleSend}
            disabled={!value.trim()}
            type="button"
            title={lineCount > 1 ? `Send ${lineCount} lines (Enter)` : "Send (Enter)"}
          >
            <Send className="w-3 h-3 mr-1" />
            {lineCount > 1 ? `Send (${lineCount})` : "Send"}
          </button>
          <span className="moba-pill flex-shrink-0" style={{ fontSize: 11 }}>
            {selectedCount} / {totalTerminalCount}
          </span>
          <button
            className="text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--moba-hover)] flex-shrink-0"
            style={{ color: "var(--moba-text-muted)" }}
            onClick={onSelectAll}
            type="button"
            title="Select all terminals"
          >
            All
          </button>
          <button
            className="text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--moba-hover)] flex-shrink-0"
            style={{ color: "var(--moba-text-muted)" }}
            onClick={onClearSelection}
            type="button"
            title="Clear selection"
          >
            Clear
          </button>
          <button
            className="w-5 h-5 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] flex-shrink-0"
            onClick={onClose}
            type="button"
            title="Close MultiExec"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    </>
  );
}
