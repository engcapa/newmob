import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitBlobPair,
  gitCommitFiles,
  gitLog,
  type GitBlobPair,
  type GitChange,
  type GitLogEntry,
  type GitSnapshot,
} from "../../lib/git";
import { buildGraph, graphColor, type GraphRow } from "../../lib/gitGraph";
import { dateMs } from "../../lib/gitRefList";
import type { GitWorkspaceRootInfo } from "../../types";
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
          d = `M ${x1} 0 L ${x1} ${ROW_H}`;
        } else if (e.toColumn === row.column && e.fromColumn !== row.column) {
          d = `M ${x1} 0 C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${mid}`;
        } else if (e.fromColumn === row.column && e.toColumn !== row.column) {
          d = `M ${x1} ${mid} C ${x2} ${mid}, ${x2} ${mid}, ${x2} ${ROW_H}`;
        } else {
          d = `M ${x1} 0 C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${ROW_H}`;
        }
        return <path key={i} d={d} stroke={color} strokeWidth={1.5} fill="none" />;
      })}
      <circle cx={cx(row.column)} cy={mid} r={4} fill={graphColor(row.color)} stroke="var(--taomni-bg)" strokeWidth={1} />
    </svg>
  );
}

interface WorkspaceCommit extends GitLogEntry {
  repoRoot: string;
  repoName: string;
}

export interface WorkspaceCommitLogProps {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, { snapshot: GitSnapshot | null } | undefined>;
  busy: boolean;
}

export function WorkspaceCommitLog({ roots, snapshots, busy }: WorkspaceCommitLogProps) {
  const [entries, setEntries] = useState<WorkspaceCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [branchFilter, setBranchFilter] = useState("__current__");
  const [limit, setLimit] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [files, setFiles] = useState<GitChange[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const branchOptions = useMemo(
    () => workspaceBranchOptions(roots, snapshots),
    [roots, snapshots],
  );
  const visibleRoots = useMemo(() => {
    if (branchFilter === "__current__" || branchFilter === "__all__") return roots;
    return roots.filter((root) => (
      snapshots[root.repoRoot]?.snapshot?.branches.some((branch) => branch.name === branchFilter) ?? false
    ));
  }, [branchFilter, roots, snapshots]);

  useEffect(() => {
    if (branchFilter === "__current__" || branchFilter === "__all__") return;
    if (!branchOptions.some((branch) => branch.name === branchFilter)) {
      setBranchFilter("__current__");
    }
  }, [branchFilter, branchOptions]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(visibleRoots.map(async (root) => {
        const commits = await gitLog(root.repoRoot, limit, {
          grep: appliedQuery || null,
          all: branchFilter === "__all__",
          branch: branchFilter === "__current__" || branchFilter === "__all__" ? null : branchFilter,
        });
        return commits.map((entry) => ({
          ...entry,
          repoRoot: root.repoRoot,
          repoName: root.name,
        }));
      }));
      const loaded: WorkspaceCommit[] = [];
      const failures: string[] = [];
      results.forEach((result, index) => {
        const root = visibleRoots[index];
        if (result.status === "fulfilled") {
          loaded.push(...result.value);
        } else if (root) {
          failures.push(`${root.name}: ${errorMessage(result.reason)}`);
        }
      });
      loaded.sort((a, b) => commitTime(b.date) - commitTime(a.date));
      const next = loaded.slice(0, limit);
      setEntries(next);
      setSelectedKey((current) => (
        current && next.some((entry) => entryKey(entry) === current)
          ? current
          : next[0] ? entryKey(next[0]) : null
      ));
      setError(failures.length ? `${failures.length} repos failed to load` : null);
    } finally {
      setLoading(false);
    }
  }, [appliedQuery, branchFilter, limit, visibleRoots]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const selected = useMemo(
    () => entries.find((entry) => entryKey(entry) === selectedKey) ?? null,
    [entries, selectedKey],
  );
  const selectedRepoRoot = selected?.repoRoot ?? null;
  const selectedCommitOid = selected?.oid ?? null;
  const graphRows = useMemo(() => workspaceGraphRows(entries, roots), [entries, roots]);
  const maxGraphWidth = useMemo(
    () => [...graphRows.values()].reduce((max, row) => Math.max(max, row.width), 1),
    [graphRows],
  );

  useEffect(() => {
    let cancelled = false;
    if (!selectedRepoRoot || !selectedCommitOid) {
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
    gitCommitFiles(selectedRepoRoot, selectedCommitOid)
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
  }, [selectedRepoRoot, selectedCommitOid]);

  useEffect(() => {
    let cancelled = false;
    const file = files.find((entry) => entry.path === filePath) ?? null;
    if (!selectedRepoRoot || !selectedCommitOid || !file) {
      setPair(null);
      setPairLoading(false);
      return;
    }
    setPairLoading(true);
    gitBlobPair(selectedRepoRoot, file.path, `${selectedCommitOid}^`, selectedCommitOid, file.oldPath)
      .then((next) => {
        if (!cancelled) setPair(next);
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
  }, [selectedRepoRoot, selectedCommitOid, filePath, files]);

  const diffEmptyLabel =
    files.length > AUTO_PREVIEW_FILE_LIMIT && !filePath
      ? `Large commit (${files.length} files). Select a file to preview its diff.`
      : "Select a file to preview its diff";

  return (
    <div className="h-full min-h-0 flex flex-col">
      <PanelGroup orientation="horizontal" id="workspace-git-log-layout">
        <Panel id="workspace-log-list" defaultSize="42%" minSize="28%" className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
          <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
              <input
                type="search"
                className="taomni-input h-7 w-full pl-7"
                placeholder="Filter messages"
                aria-label="Filter messages"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <BranchFilterSelect
              value={branchFilter}
              onChange={setBranchFilter}
              branches={branchOptions}
              aria-label="Branch"
            />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          </div>
          {error && (
            <div className="shrink-0 px-3 py-1 text-[11px] text-red-500 border-b border-[var(--taomni-divider)]">
              {error}
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-auto">
            {entries.length === 0 ? (
              <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                {loading ? "Loading..." : "No commits"}
              </div>
            ) : entries.map((entry) => {
              const graphRow = graphRows.get(entryKey(entry)) ?? {
                oid: entry.oid,
                column: 0,
                color: 0,
                edges: [],
                width: 1,
              };
              return (
              <CommitMessageHover
                key={entryKey(entry)}
                content={commitHoverContent(entry)}
                className={`w-full flex items-start gap-2 pr-2 text-left overflow-hidden cursor-pointer border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${
                  selectedKey === entryKey(entry) ? "bg-[var(--taomni-hover)]" : ""
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  data-testid="git-log-commit"
                  data-oid={entry.oid}
                  style={{ height: ROW_H }}
                  className="w-full flex items-start gap-2 overflow-hidden"
                  onClick={() => setSelectedKey(entryKey(entry))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedKey(entryKey(entry));
                    }
                  }}
                >
                  <GraphCell row={graphRow} maxWidth={maxGraphWidth} />
                  <div className="min-w-0 flex-1 py-2">
                    <div className="flex items-start gap-1 min-w-0">
                      <span className="shrink-0 mt-0.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
                        {entry.repoName}
                      </span>
                      {entry.refs.slice(0, 3).map((ref) => (
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
              );
            })}
            {entries.length >= limit && (
              <button
                className="w-full py-2 text-[12px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] inline-flex items-center justify-center gap-1"
                type="button"
                disabled={loading || busy}
                onClick={() => setLimit((current) => current + 120)}
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
        <Panel id="workspace-log-details" defaultSize="58%" minSize="35%" className="min-w-0 min-h-0">
          <PanelGroup orientation="vertical" id="workspace-git-log-detail-layout">
            <Panel id="workspace-log-files" defaultSize="30%" minSize="15%" className="min-h-0 flex flex-col border-b border-[var(--taomni-divider)]">
              <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] text-[12px] font-semibold">
                {selected ? (
                  <>
                    <span className="shrink-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1.5 py-0.5 text-[10px] text-[var(--taomni-text-muted)]">
                      {selected.repoName}
                    </span>
                    <span className="min-w-0 truncate">{selected.shortOid} · {files.length} file(s)</span>
                  </>
                ) : "Commit"}
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                {files.length === 0 ? (
                  <div className="h-full min-h-16 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                    {selected ? "No file changes" : "Select a commit"}
                  </div>
                ) : files.map((file) => (
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
                ))}
              </div>
            </Panel>
            <PanelResizeHandle
              id="git-log-files-resize-handle"
              data-testid="git-log-files-resize-handle"
              className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-row-resize"
            />
            <Panel id="workspace-log-diff" defaultSize="70%" minSize="20%" className="min-h-0 flex flex-col">
              <DiffViewer pair={pair} loading={pairLoading} emptyLabel={diffEmptyLabel} />
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function entryKey(entry: WorkspaceCommit): string {
  return `${entry.repoRoot}\u0000${entry.oid}`;
}

function workspaceBranchOptions(
  roots: GitWorkspaceRootInfo[],
  snapshots: Record<string, { snapshot: GitSnapshot | null } | undefined>,
): BranchFilterOption[] {
  const byName = new Map<string, { count: number; date: string | null }>();
  for (const root of roots) {
    const branches = snapshots[root.repoRoot]?.snapshot?.branches ?? [];
    const seenInRepo = new Set<string>();
    for (const branch of branches) {
      if (seenInRepo.has(branch.name)) continue;
      seenInRepo.add(branch.name);
      const prev = byName.get(branch.name);
      const nextCount = (prev?.count ?? 0) + 1;
      const prevMs = dateMs(prev?.date);
      const branchMs = dateMs(branch.date);
      const nextDate = branchMs >= prevMs ? (branch.date ?? prev?.date ?? null) : (prev?.date ?? null);
      byName.set(branch.name, { count: nextCount, date: nextDate });
    }
  }
  return [...byName.entries()].map(([name, info]) => ({
    value: name,
    name,
    date: info.date,
    label: info.count > 1 ? `${name} (${info.count})` : name,
  }));
}

function workspaceGraphRows(entries: WorkspaceCommit[], roots: GitWorkspaceRootInfo[]): Map<string, GraphRow> {
  const rows = new Map<string, GraphRow>();
  for (const root of roots) {
    const repoEntries = entries.filter((entry) => entry.repoRoot === root.repoRoot);
    const graph = buildGraph(repoEntries);
    repoEntries.forEach((entry, index) => {
      const row = graph[index];
      if (row) rows.set(entryKey(entry), row);
    });
  }
  return rows;
}

function commitTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
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

function commitHoverContent(entry: WorkspaceCommit) {
  return {
    subject: entry.subject,
    body: entry.body,
    meta: `${entry.repoName} · ${entry.shortOid} · ${entry.authorName} <${entry.authorEmail}> · ${formatDate(entry.date)}`,
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
