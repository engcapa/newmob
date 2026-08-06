import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Search, RefreshCw } from "lucide-react";
import type { LocalProxyCandidate } from "../../lib/sockscap";
import { splitGroupPath } from "../../lib/sessionPaths";

/** A saved SSH/proxy session offered as an upstream source. */
export interface SessionSource {
  id: string;
  name: string;
  host: string;
  port: number;
  kind: "proxy" | "ssh";
  /** Folder path (e.g. "User sessions / Work / Proxies"); groups the tree. */
  groupPath?: string | null;
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
  /** Lock the trigger (e.g. capture running — upstream can't change live). */
  disabled?: boolean;
  /** Tooltip shown on the disabled trigger explaining why. */
  lockedTooltip?: string;
  t: (key: string, vars?: Record<string, string>) => string;
  testId?: string;
}

const MANUAL_KEY = "__manual__";
const SEC_DETECTED = "sec:detected";
const SEC_SESSIONS = "sec:sessions";

/** A node in the picker tree: a selectable leaf or a collapsible group. */
type TreeNode =
  | { type: "option"; key: string; label: string; sub: string; choice: UpstreamChoice }
  | { type: "group"; key: string; label: string; children: TreeNode[] };

function candidateKey(c: LocalProxyCandidate): string {
  return `detected:${c.host}:${c.port}:${c.pid}`;
}
function sessionKey(s: SessionSource): string {
  return `session:${s.id}`;
}
/** Stable key for a folder node, scoped to the session tree. */
function folderKey(segments: string[]): string {
  return `folder:${segments.join(" / ")}`;
}

/** Nest sessions into folder groups by their group_path; ungrouped sit at root. */
function buildSessionChildren(relevant: SessionSource[]): TreeNode[] {
  // Ordered folder map at each level keeps a stable, first-seen folder order.
  interface Dir {
    children: Map<string, Dir>;
    options: TreeNode[];
  }
  const root: Dir = { children: new Map(), options: [] };

  for (const s of relevant) {
    const segments = splitGroupPath(s.groupPath);
    let dir = root;
    for (const seg of segments) {
      let next = dir.children.get(seg);
      if (!next) {
        next = { children: new Map(), options: [] };
        dir.children.set(seg, next);
      }
      dir = next;
    }
    dir.options.push({
      type: "option",
      key: sessionKey(s),
      label: s.name,
      sub: `${s.host}:${s.port}`,
      choice: { source: "session", session: s },
    });
  }

  const emit = (dir: Dir, trail: string[]): TreeNode[] => {
    const nodes: TreeNode[] = [];
    // Folders first (alphabetical), then this level's own ungrouped sessions.
    const folderNames = [...dir.children.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of folderNames) {
      const path = [...trail, name];
      nodes.push({
        type: "group",
        key: folderKey(path),
        label: name,
        children: emit(dir.children.get(name)!, path),
      });
    }
    const opts = [...dir.options].sort((a, b) => a.label.localeCompare(b.label));
    nodes.push(...opts);
    return nodes;
  };

  return emit(root, []);
}

/** Build the picker tree: Manual first, then detected proxies, then sessions. */
function buildTree(
  mode: "ssh" | "proxy",
  detected: LocalProxyCandidate[],
  sessions: SessionSource[],
  t: (key: string, vars?: Record<string, string>) => string,
): TreeNode[] {
  const tree: TreeNode[] = [];

  // Manual entry is always available and pinned at the very top.
  tree.push({
    type: "option",
    key: MANUAL_KEY,
    label: t("sockscap.manualUpstream"),
    sub: t("sockscap.picker.manualHint"),
    choice: { source: "manual" },
  });

  // Detected local proxies only make sense for native SOCKS5/HTTP upstreams.
  if (mode === "proxy" && detected.length > 0) {
    const children: TreeNode[] = detected.map((c) => {
      const client = c.clientLabel || (c.client && c.client !== "unknown" ? c.client : "");
      const sub = `${c.kind.toUpperCase()}${client ? ` · ${client}` : c.process ? ` · ${c.process}` : ""}`;
      return {
        type: "option" as const,
        key: candidateKey(c),
        label: `${c.host}:${c.port}`,
        sub,
        choice: { source: "detected", candidate: c },
      };
    });
    tree.push({ type: "group", key: SEC_DETECTED, label: t("sockscap.picker.detectedGroup"), children });
  }

  // Saved sessions relevant to this upstream kind, nested by folder.
  const relevant = sessions.filter((s) => (mode === "ssh" ? s.kind === "ssh" : s.kind === "proxy"));
  if (relevant.length > 0) {
    tree.push({
      type: "group",
      key: SEC_SESSIONS,
      label: mode === "ssh" ? t("sockscap.picker.sshSessions") : t("sockscap.picker.proxySessions"),
      children: buildSessionChildren(relevant),
    });
  }

  return tree;
}

/** Which option key matches the current upstream selection. */
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
  return MANUAL_KEY;
}

/** Find an option node anywhere in the tree by its key. */
function findOption(nodes: TreeNode[], key: string): Extract<TreeNode, { type: "option" }> | null {
  for (const node of nodes) {
    if (node.type === "option") {
      if (node.key === key) return node;
    } else {
      const hit = findOption(node.children, key);
      if (hit) return hit;
    }
  }
  return null;
}

/** Keys of every group node that is an ancestor of the option with `key`. */
function ancestorGroupKeys(nodes: TreeNode[], key: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.type === "option") {
      if (node.key === key) return trail;
    } else {
      const hit = ancestorGroupKeys(node.children, key, [...trail, node.key]);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Prune the tree to nodes matching `q`. A group is kept if its label matches
 * (all children retained) or if any descendant option matches.
 */
function pruneTree(nodes: TreeNode[], q: string): TreeNode[] {
  const kept: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "option") {
      if (`${node.label} ${node.sub}`.toLowerCase().includes(q)) kept.push(node);
    } else if (node.label.toLowerCase().includes(q)) {
      kept.push(node);
    } else {
      const children = pruneTree(node.children, q);
      if (children.length > 0) kept.push({ ...node, children });
    }
  }
  return kept;
}

/** Collect every group key in the tree (used to auto-expand while filtering). */
function allGroupKeys(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "group") {
      acc.push(node.key);
      allGroupKeys(node.children, acc);
    }
  }
  return acc;
}

/** A flattened, currently-visible row derived from the tree + expand state. */
type VisibleRow =
  | { type: "group"; key: string; label: string; depth: number; expanded: boolean }
  | {
      type: "option";
      key: string;
      label: string;
      sub: string;
      depth: number;
      choice: UpstreamChoice;
    };

/** Walk the tree, emitting rows for expanded branches only. */
function flattenVisible(nodes: TreeNode[], expanded: Set<string>, depth = 0): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const node of nodes) {
    if (node.type === "group") {
      const isOpen = expanded.has(node.key);
      rows.push({ type: "group", key: node.key, label: node.label, depth, expanded: isOpen });
      if (isOpen) rows.push(...flattenVisible(node.children, expanded, depth + 1));
    } else {
      rows.push({ type: "option", key: node.key, label: node.label, sub: node.sub, depth, choice: node.choice });
    }
  }
  return rows;
}

export function UpstreamSourcePicker({
  mode,
  detected,
  sessions,
  current,
  onSelect,
  onRescan,
  busy = false,
  disabled = false,
  lockedTooltip,
  t,
  testId = "sockscap-upstream-source",
}: UpstreamSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [rescanning, setRescanning] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [manualSelected, setManualSelected] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(
    () => buildTree(mode, detected, sessions, t),
    [mode, detected, sessions, t],
  );

  const curKey = useMemo(
    () => (manualSelected ? MANUAL_KEY : selectedKey(current, detected)),
    [current, detected, manualSelected],
  );

  const q = query.trim().toLowerCase();
  const pruned = useMemo(() => (q ? pruneTree(tree, q) : tree), [tree, q]);

  // While filtering, force-expand every surviving group so matches are visible.
  const effectiveExpanded = useMemo(
    () => (q ? new Set(allGroupKeys(pruned)) : expanded),
    [q, pruned, expanded],
  );

  const rows = useMemo(
    () => flattenVisible(pruned, effectiveExpanded),
    [pruned, effectiveExpanded],
  );

  const selectedLabel = useMemo(() => {
    const opt = findOption(tree, curKey);
    return opt ? opt.label : t("sockscap.manualUpstream");
  }, [tree, curKey, t]);

  // On open: focus filter; expand both sections plus the current selection's
  // folders, and seed the active row to the current selection.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const seed = new Set<string>([SEC_DETECTED, SEC_SESSIONS]);
    for (const k of ancestorGroupKeys(tree, curKey) ?? []) seed.add(k);
    setExpanded(seed);

    const visible = flattenVisible(pruned, seed);
    const sel = visible.findIndex((r) => r.type === "option" && r.key === curKey);
    const firstOpt = visible.findIndex((r) => r.type === "option");
    setActiveIdx(sel >= 0 ? sel : Math.max(0, firstOpt));

    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The profile editor is scrollable, so render the popup in document.body and
  // anchor it with viewport coordinates. Otherwise rows extending past the
  // editor's overflow boundary are painted but do not receive pointer events.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gutter = 4;
      const width = Math.max(0, Math.min(rect.width, window.innerWidth - gutter * 2));
      const left = Math.min(Math.max(gutter, rect.left), Math.max(gutter, window.innerWidth - width - gutter));
      setMenuPos({ top: rect.bottom + gutter, left, width });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  // Keep the active index in range as rows appear/disappear (filter, collapse).
  useEffect(() => {
    if (rows.length === 0) {
      if (activeIdx !== 0) setActiveIdx(0);
    } else if (activeIdx > rows.length - 1) {
      setActiveIdx(rows.length - 1);
    }
  }, [rows.length, activeIdx]);

  // Keep the active row scrolled into view. `scrollIntoView` is absent under
  // jsdom, so guard it rather than crashing the effect in tests.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx, open]);

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const commit = (row: VisibleRow) => {
    if (row.type === "group") {
      if (!q) toggleGroup(row.key);
      return;
    }
    setManualSelected(row.choice.source === "manual");
    onSelect(row.choice);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rows.length) setActiveIdx((i) => (i + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length) setActiveIdx((i) => (i - 1 + rows.length) % rows.length);
    } else if (event.key === "ArrowRight") {
      const row = rows[activeIdx];
      if (row?.type === "group" && !row.expanded && !q) {
        event.preventDefault();
        toggleGroup(row.key);
      }
    } else if (event.key === "ArrowLeft") {
      const row = rows[activeIdx];
      if (row?.type === "group" && row.expanded && !q) {
        event.preventDefault();
        toggleGroup(row.key);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIdx];
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
        aria-haspopup="tree"
        aria-expanded={open}
        data-testid={testId}
        disabled={disabled}
        title={disabled ? lockedTooltip : undefined}
        className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-left inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="tree"
            data-testid={`${testId}-menu`}
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            className="taomni-sockscap-popover fixed z-[100] max-h-72 flex flex-col overflow-hidden rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg"
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
            {rows.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
                {t("sockscap.picker.noMatch")}
              </div>
            ) : (
              rows.map((row, idx) => {
                const pad = { paddingLeft: `${8 + row.depth * 14}px` };
                return row.type === "group" ? (
                  <div
                    key={row.key}
                    role="treeitem"
                    aria-expanded={row.expanded}
                    aria-level={row.depth + 1}
                    data-idx={idx}
                    data-testid={`${testId}-group`}
                    data-value={row.key}
                    style={pad}
                    className={`w-full pr-2 py-1.5 text-left rounded flex items-center gap-1 cursor-pointer select-none outline-none ${
                      idx === activeIdx ? "bg-[var(--taomni-accent)]/15" : "hover:bg-[var(--taomni-hover)]"
                    }`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => commit(row)}
                  >
                    <ChevronRight
                      className={`w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)] transition-transform ${row.expanded ? "rotate-90" : ""}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
                      {row.label}
                    </span>
                  </div>
                ) : (
                  <div
                    key={row.key}
                    role="treeitem"
                    aria-selected={row.key === curKey}
                    aria-level={row.depth + 1}
                    data-idx={idx}
                    data-testid={`${testId}-option`}
                    data-value={row.key}
                    style={pad}
                    className={`w-full pr-2 py-1.5 text-left rounded flex items-center gap-2 cursor-pointer outline-none ${
                      idx === activeIdx ? "bg-[var(--taomni-accent)]/15" : "hover:bg-[var(--taomni-hover)]"
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
                  </div>
                );
              })
            )}
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
