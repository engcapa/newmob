import { useMemo, useState } from "react";
import { Eye, EyeOff, FileCode, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { FileCoverage, WorkspaceCoverageReport } from "../coverageModel";

export interface CoveragePanelProps {
  report: WorkspaceCoverageReport | null;
  coverageEnabled: boolean;
  onToggleCoverage: () => void;
  onOpenFile: (path: string, line?: number) => void;
  onRefreshCoverage?: () => void;
}

export function CoveragePanel({
  report,
  coverageEnabled,
  onToggleCoverage,
  onOpenFile,
  onRefreshCoverage,
}: CoveragePanelProps) {
  const [search, setSearch] = useState("");

  const fileList = useMemo(() => {
    if (!report) return [];
    return Array.from(report.files.values()).sort((a, b) => a.percentage - b.percentage);
  }, [report]);

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return fileList;
    const q = search.toLowerCase();
    return fileList.filter((f) => f.path.toLowerCase().includes(q));
  }, [fileList, search]);

  const handleFileClick = (file: FileCoverage) => {
    // Find the first uncovered or partial line to jump to
    let targetLine = 1;
    for (const [nr, line] of file.lines) {
      if (line.status === "uncovered" || line.status === "partial") {
        targetLine = nr;
        break;
      }
    }
    onOpenFile(file.path, targetLine);
  };

  const getPercentageColor = (pct: number) => {
    if (pct >= 80) return "text-emerald-500 bg-emerald-500/10 border-emerald-500/30";
    if (pct >= 50) return "text-amber-500 bg-amber-500/10 border-amber-500/30";
    return "text-rose-500 bg-rose-500/10 border-rose-500/30";
  };

  const getBarColor = (pct: number) => {
    if (pct >= 80) return "bg-emerald-500";
    if (pct >= 50) return "bg-amber-500";
    return "bg-rose-500";
  };

  if (!report) {
    return (
      <div data-testid="coverage-panel-empty" className="flex h-full flex-col items-center justify-center p-6 text-[12px] text-[var(--taomni-code-muted)]">
        <ShieldCheck className="h-10 w-10 text-[var(--taomni-code-muted)] opacity-40 mb-2" />
        <p className="font-medium text-[var(--taomni-code-fg)]">No test coverage data loaded</p>
        <p className="text-[11px] mt-1 max-w-md text-center">
          Run tests with coverage enabled (e.g. `pnpm test --coverage`, `mvn test -Pjacoco`, or `pytest --cov`) to generate `lcov.info` or `jacoco.xml`.
        </p>
        {onRefreshCoverage && (
          <button
            type="button"
            data-testid="coverage-panel-reload-btn"
            onClick={onRefreshCoverage}
            className="mt-3 flex items-center gap-1.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-3 py-1 text-[11px] text-[var(--taomni-code-fg)] hover:bg-[var(--taomni-code-active-line-bg)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Scan for Coverage Reports</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div data-testid="coverage-panel" className="flex h-full flex-col text-[12px] text-[var(--taomni-code-fg)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/30 px-3 py-2 text-[11px]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-[var(--taomni-code-fg)]">Overall Coverage:</span>
            <span
              data-testid="coverage-overall-badge"
              className={`rounded border px-2 py-0.5 font-mono font-bold ${getPercentageColor(
                report.totalPercentage,
              )}`}
            >
              {report.totalPercentage}%
            </span>
          </div>
          <span className="text-[var(--taomni-code-muted)]">
            {report.totalCovered} / {report.totalLines} lines covered ({report.files.size} files)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex items-center">
            <Search className="absolute left-2 h-3 w-3 text-[var(--taomni-code-muted)]" />
            <input
              type="text"
              data-testid="coverage-search-input"
              placeholder="Filter file..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-6 w-44 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] pl-6 pr-2 text-[11px]"
            />
          </div>

          {/* Toggle Gutter */}
          <button
            type="button"
            data-testid="coverage-toggle-gutter-btn"
            onClick={onToggleCoverage}
            title={coverageEnabled ? "Hide coverage marks in editor gutter" : "Show coverage marks in editor gutter"}
            className={`flex items-center gap-1 rounded border px-2 py-0.5 transition-colors ${
              coverageEnabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-[var(--taomni-code-border)] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            }`}
          >
            {coverageEnabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            <span>Gutter Marks</span>
          </button>

          {onRefreshCoverage && (
            <button
              type="button"
              data-testid="coverage-refresh-btn"
              onClick={onRefreshCoverage}
              title="Refresh coverage data"
              className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Files Table */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-left border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[10px] text-[var(--taomni-code-muted)] uppercase tracking-wider">
            <tr>
              <th className="px-3 py-1.5 font-semibold">File</th>
              <th className="px-3 py-1.5 font-semibold w-28 text-right">Lines</th>
              <th className="px-3 py-1.5 font-semibold w-48 text-right">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--taomni-code-border)]/30">
            {filteredFiles.map((file) => (
              <tr
                key={file.path}
                data-testid={`coverage-row-${file.path}`}
                onClick={() => handleFileClick(file)}
                className="cursor-pointer hover:bg-[var(--taomni-code-active-line-bg)]/60 transition-colors"
              >
                <td className="px-3 py-1.5 truncate flex items-center gap-1.5">
                  <FileCode className="h-3.5 w-3.5 text-[var(--taomni-code-muted)] shrink-0" />
                  <span className="truncate">{file.path}</span>
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap text-[var(--taomni-code-muted)]">
                  {file.linesCovered} / {file.linesTotal}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-2 w-24 rounded-full bg-[var(--taomni-code-active-line-bg)] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${getBarColor(file.percentage)}`}
                        style={{ width: `${file.percentage}%` }}
                      />
                    </div>
                    <span className="w-9 font-semibold text-right">{file.percentage}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
