import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search, X } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitBlobPair,
  gitCommitFiles,
  gitLog,
  type GitBlobPair,
  type GitBranch as GitBranchInfo,
  type GitChange,
  type GitLogEntry,
} from "../../lib/git";
import { buildGraph, graphColor, type GraphRow } from "../../lib/gitGraph";
import { DiffViewer } from "./DiffViewer";
import { BranchFilterSelect, type BranchFilterOption } from "./shared/BranchFilterSelect";
import { CommitMessageHover } from "./shared/CommitMessageHover";

const ROW_H = 88;
const LANE_W = 14;
const AUTO_PREVIEW_FILE_LIMIT = 300;

function GraphCell({ row, maxWidth }: { row: GraphRow; maxWidth: number }) {
  const width = Math.max(maxWidth, 1) * LANE_W;
  const cx = (col: number) => col * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  return (
    <svg width={width} height={ROW_H} className="shrink-0" style={{ display: "block" }}>
      {row.edges.map((e, i) => {
        const color = graphColor(e.color);
        const x1 = cx(e.fromColumn);
        const x2 = cx(e.toColumn);
        let d: string;
        if (e.fromColumn === row.column && e.toColumn === row.column) {
          d = `M ${x1} 0 L ${x1} ${ROW_H}`; // node lane passing straight through
        } else if (e.toColumn === row.column && e.fromColumn !== row.column) {
          d = `M ${x1} 0 C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${mid}`; // incoming into node
        } else if (e.fromColumn === row.column && e.toColumn !== row.column) {
          d = `M ${x1} ${mid} C ${x2} ${mid}, ${x2} ${mid}, ${x2} ${ROW_H}`; // outgoing from node
        } else {
          d = `M ${x1} 0 C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${ROW_H}`; // pass-through
        }
        return <path key={i} d={d} stroke={color} strokeWidth={1.5} fill="none" />;
      })}
      <circle cx={cx(row.column)} cy={mid} r={4} fill={graphColor(row.color)} stroke="var(--taomni-bg)" strokeWidth={1} />
    </svg>
  );
}

// COMMIT_LOG
export interface CommitLogProps {
  repoRoot: string;
  headOid: string | null;
  branches?: GitBranchInfo[];
  busy: boolean;
  onContextMenu: (entry: GitLogEntry, x: number, y: number) => void;
  pathFilter?: string | null;
  onClose?: () => void;
}

export function CommitLog({ repoRoot, headOid, branches = [], busy, onContextMenu, pathFilter, onClose }: CommitLogProps) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [branchFilter, setBranchFilter] = useState("__current__");
  const [limit, setLimit] = useState(200);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [files, setFiles] = useState<GitChange[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);

  // Debounce the message filter.
  useEffect(() => {
    const id = setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (branchFilter === "__current__" || branchFilter === "__all__") return;
    if (!branches.some((branch) => branch.name === branchFilter)) {
      setBranchFilter("__current__");
    }
  }, [branchFilter, branches]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const next = await gitLog(repoRoot, limit, {
        grep: appliedQuery || null,
        all: branchFilter === "__all__",
        branch: branchFilter === "__current__" || branchFilter === "__all__" ? null : branchFilter,
        path: pathFilter || null,
      });
      setEntries(next);
      setSelectedOid((current) =>
        current && next.some((e) => e.oid === current) ? current : next[0]?.oid ?? null,
      );
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [repoRoot, limit, appliedQuery, branchFilter, pathFilter]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, headOid]);

  const selected = useMemo(
    () => entries.find((e) => e.oid === selectedOid) ?? null,
    [entries, selectedOid],
  );
  const selectedCommitOid = selected?.oid ?? null;

  // Load the changed-files list for the selected commit.
  useEffect(() => {
    let cancelled = false;
    if (!selectedCommitOid) {
      setFiles([]);
      setFilePath(null);
      setPair(null);
      setPairLoading(false);
      return;
    }
    setFiles([]);
    setFilePath(null);
    setPair(null);
    setPairLoading(false);
    gitCommitFiles(repoRoot, selectedCommitOid)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setFilePath(list.length > AUTO_PREVIEW_FILE_LIMIT ? null : list[0]?.path ?? null);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selectedCommitOid]);

  // Load the diff for the selected file within the selected commit (parent ↔ commit).
  useEffect(() => {
    let cancelled = false;
    const file = files.find((f) => f.path === filePath) ?? null;
    if (!selectedCommitOid || !file) {
      setPair(null);
      setPairLoading(false);
      return;
    }
    setPairLoading(true);
    gitBlobPair(repoRoot, file.path, `${selectedCommitOid}^`, selectedCommitOid, file.oldPath)
      .then((p) => {
        if (!cancelled) setPair(p);
      })
      .catch(() => {
        if (!cancelled) setPair(null);
      })
      .finally(() => {
        if (!cancelled) setPairLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selectedCommitOid, filePath, files]);

  const graph = useMemo(() => buildGraph(entries), [entries]);
  const maxWidth = useMemo(() => graph.reduce((m, r) => Math.max(m, r.width), 1), [graph]);
  const branchOptions = useMemo<BranchFilterOption[]>(
    () => branches.map((branch) => ({
      value: branch.name,
      name: branch.name,
      date: branch.date,
      label: branch.current ? `${branch.name} (current)` : branch.name,
    })),
    [branches],
  );
  const diffEmptyLabel =
    files.length > AUTO_PREVIEW_FILE_LIMIT && !filePath
      ? `Large commit (${files.length} files). Select a file to preview its diff.`
      : "Select a file to preview its diff";

  // RENDER_LOG
  return (
    <div className="h-full min-h-0 flex flex-col">
      {pathFilter && (
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold text-[12px] truncate">History: {pathFilter}</span>
          <div className="flex-1" />
          {onClose && (
            <button className="taomni-btn h-7 px-2 inline-flex items-center gap-1" type="button" onClick={onClose}>
              <X className="w-3.5 h-3.5" /> Close
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PanelGroup orientation="horizontal" id="git-log-layout">
      <Panel id="log-list" defaultSize="42%" minSize="28%" className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
            <input
              type="search"
              className="taomni-input h-7 w-full pl-7"
              placeholder="Filter messages"
              aria-label="Filter messages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-1 text-[12px] select-none whitespace-nowrap">
            Branch
            <BranchFilterSelect
              value={branchFilter}
              onChange={setBranchFilter}
              branches={branchOptions}
              aria-label="Branch"
            />
          </label>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {entries.length === 0 ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {loading ? "Loading…" : "No commits"}
            </div>
          ) : (
            entries.map((entry, i) => (
              <CommitMessageHover
                key={entry.oid}
                content={commitHoverContent(entry)}
                className={`w-full flex items-start gap-2 pr-2 overflow-hidden cursor-pointer border-b border-[var(--taomni-divider)] ${
                  selectedOid === entry.oid ? "bg-[var(--taomni-hover)]" : "hover:bg-[var(--taomni-hover)]"
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  data-testid="git-log-commit"
                  data-oid={entry.oid}
                  style={{ height: ROW_H }}
                  className="w-full flex items-start gap-2 overflow-hidden"
                  onClick={() => setSelectedOid(entry.oid)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedOid(entry.oid);
                    onContextMenu(entry, e.clientX, e.clientY);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedOid(entry.oid);
                    }
                  }}
                >
                  <GraphCell row={graph[i]} maxWidth={maxWidth} />
                  <div className="min-w-0 flex-1 py-2">
                    <div className="flex items-start gap-1 min-w-0">
                      {entry.refs.map((ref) => (
                        <span
                          key={ref}
                          className="shrink-0 mt-0.5 text-[10px] px-1 rounded bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30"
                        >
                          {ref}
                        </span>
                      ))}
                      <span className="min-w-0 text-[12px] leading-4 font-medium line-clamp-2">{entry.subject}</span>
                    </div>
                    {commitBodyPreview(entry) && (
                      <div className="mt-0.5 text-[11px] leading-4 text-[var(--taomni-text-muted)] line-clamp-1">
                        {commitBodyPreview(entry)}
                      </div>
                    )}
                    <div className="mt-1 text-[11px] text-[var(--taomni-text-muted)] truncate">
                      <span className="taomni-mono text-[var(--taomni-accent)]">{entry.shortOid}</span> · {entry.authorName} · {formatDate(entry.date)}
                    </div>
                  </div>
                </div>
              </CommitMessageHover>
            ))
          )}
          {entries.length >= limit && (
            <button
              className="w-full py-2 text-[12px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] inline-flex items-center justify-center gap-1"
              type="button"
              disabled={loading || busy}
              onClick={() => setLimit((l) => l + 200)}
            >
              <ChevronDown className="w-3.5 h-3.5" /> Load more
            </button>
          )}
        </div>
      </Panel>
      <PanelResizeHandle
        id="git-log-list-resize-handle"
        data-testid="git-log-list-resize-handle"
        className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize"
      />
      <Panel id="log-details" defaultSize="58%" minSize="35%" className="min-w-0 min-h-0">
        <PanelGroup orientation="vertical" id="git-log-detail-layout">
          <Panel id="log-files" defaultSize="30%" minSize="15%" className="min-h-0 flex flex-col border-b border-[var(--taomni-divider)]">
            <div className="h-8 shrink-0 flex items-center px-3 border-b border-[var(--taomni-divider)] text-[12px] font-semibold">
              {selected ? `${selected.shortOid} · ${files.length} file(s)` : "Commit"}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {files.length === 0 ? (
                <div className="h-full min-h-16 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  {selected ? "No file changes" : "Select a commit"}
                </div>
              ) : (
                files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    data-testid="git-log-file"
                    data-path={file.path}
                    aria-pressed={filePath === file.path}
                    className={`w-full px-3 py-1 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${
                      filePath === file.path ? "bg-[var(--taomni-hover)]" : ""
                    }`}
                    onClick={() => setFilePath(file.path)}
                  >
                    <span className={`shrink-0 w-[58px] text-center rounded px-1 py-0.5 text-[10px] uppercase ${statusColor(file.status)}`}>
                      {file.status}
                    </span>
                    <span className="truncate text-[12px]">{file.path}</span>
                  </button>
                ))
              )}
            </div>
          </Panel>
          <PanelResizeHandle
            id="git-log-files-resize-handle"
            data-testid="git-log-files-resize-handle"
            className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-row-resize"
          />
          <Panel id="log-diff" defaultSize="70%" minSize="20%" className="min-h-0 flex flex-col">
            <DiffViewer pair={pair} loading={pairLoading} emptyLabel={diffEmptyLabel} />
          </Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
      </div>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "added":
      return "bg-emerald-500/15 text-emerald-500";
    case "deleted":
      return "bg-red-500/15 text-red-500";
    case "renamed":
    case "copied":
      return "bg-purple-500/15 text-purple-500";
    default:
      return "bg-blue-500/15 text-blue-500";
  }
}

function commitBodyPreview(entry: GitLogEntry): string {
  return entry.body.trim().replace(/\s+/g, " ");
}

function commitHoverContent(entry: GitLogEntry) {
  return {
    subject: entry.subject,
    body: entry.body,
    meta: `${entry.shortOid} · ${entry.authorName} <${entry.authorEmail}> · ${formatDate(entry.date)}`,
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
