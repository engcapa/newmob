import { useCallback, useEffect, useMemo, useState } from "react";
import { Bug, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleDashed, CircleX, FlaskConical, Loader2, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import type { JavaTestItem } from "../../../../lib/editor/lsp";
import type { StructuredTestResult, StructuredTestResults } from "../../../../lib/editor/workspace";
import { formatTestDuration, groupTestResults, resultStatusLabel } from "./testResultTree";

interface TestsPanelProps {
  /** Label for the active file being inspected (empty → no Java file active). */
  activeFileTitle: string | null;
  /** True when the active file can carry Java tests (drives the discover call). */
  canDiscover: boolean;
  active: boolean;
  /** Discover tests for the active file (parent supplies the descriptor + uri). */
  onDiscover: () => Promise<JavaTestItem[]>;
  /** Run a single class/method through the integrated terminal. */
  onRun: (item: JavaTestItem) => void;
  /** Re-run a result, including results that are no longer in discovery output. */
  onRerun?: (result: StructuredTestResult) => void;
  /** Load the latest provider report after a test command exits. */
  onLoadResults?: () => Promise<StructuredTestResults | null>;
  /** Parent-owned result cache, updated when a task exits. */
  results?: StructuredTestResults | null;
  /** Open a provider-reported source location. */
  onOpenFailure?: (result: StructuredTestResult) => void;
  /** Debug a single class/method through the DAP path (M9 debug-test). */
  onDebug: (item: JavaTestItem) => void;
  /** True when the workspace has no Maven/Gradle runner (run disabled). */
  runDisabled: boolean;
}

function statusIcon(status: StructuredTestResult["status"]) {
  if (status === "passed") return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
  if (status === "failed") return <CircleX className="h-3 w-3 text-red-500" />;
  if (status === "error") return <CircleAlert className="h-3 w-3 text-orange-500" />;
  if (status === "skipped") return <Square className="h-3 w-3 text-amber-500" />;
  return <CircleDashed className="h-3 w-3 text-[var(--taomni-text-muted)]" />;
}

function TestRow({
  item,
  depth,
  onRun,
  onDebug,
  runDisabled,
  resultStatus,
  resultStatusFor,
}: {
  item: JavaTestItem;
  depth: number;
  onRun: (item: JavaTestItem) => void;
  onDebug: (item: JavaTestItem) => void;
  runDisabled: boolean;
  resultStatus?: StructuredTestResult["status"];
  resultStatusFor?: (selector: string) => StructuredTestResult["status"] | undefined;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = item.children.length > 0;
  return (
    <>
      <div
        className="group flex items-center gap-1 py-0.5 pr-2 hover:bg-[var(--taomni-hover-bg)]"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        data-testid={`tests-item-${item.fullName}`}
      >
        {hasChildren ? (
          <button type="button" className="shrink-0" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        {resultStatus && <span className="shrink-0">{statusIcon(resultStatus)}</span>}
        <span className="truncate">{item.name}</span>
        <button
          type="button"
          data-testid={`tests-run-${item.fullName}`}
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 disabled:opacity-30"
          onClick={() => onRun(item)}
          disabled={runDisabled}
          title={runDisabled ? "No Maven/Gradle runner detected" : "Run in terminal"}
        >
          <Play className="h-3 w-3" />
        </button>
        <button
          type="button"
          data-testid={`tests-debug-${item.fullName}`}
          className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors"
          onClick={() => onDebug(item)}
          title="Debug test (requires java-debug + java-test bundles)"
        >
          <Bug className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && hasChildren && item.children.map((child) => (
        <TestRow
          key={child.fullName}
          item={child}
          depth={depth + 1}
          onRun={onRun}
          onDebug={onDebug}
          runDisabled={runDisabled}
          resultStatus={resultStatusFor?.(child.fullName)}
          resultStatusFor={resultStatusFor}
        />
      ))}
    </>
  );
}
export function TestsPanel({
  activeFileTitle,
  canDiscover,
  active,
  onDiscover,
  onRun,
  onDebug,
  onRerun,
  onLoadResults,
  results,
  onOpenFailure,
  runDisabled,
}: TestsPanelProps) {
  const [items, setItems] = useState<JavaTestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<StructuredTestResults | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);

  const resultById = useMemo(
    () => new Map((testResults?.results ?? []).map((result) => [result.selector, result])),
    [testResults],
  );
  const resultGroups = useMemo(() => groupTestResults(testResults), [testResults]);

  useEffect(() => {
    setTestResults(results ?? null);
    setResultsError(null);
  }, [results]);

  const discover = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await onDiscover());
      setLoadedFor(activeFileTitle);
    } catch (reason) {
      setItems([]);
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoadedFor(activeFileTitle);
    } finally {
      setLoading(false);
    }
  }, [activeFileTitle, onDiscover]);

  const loadResults = useCallback(async () => {
    if (!onLoadResults) return;
    setResultsLoading(true);
    setResultsError(null);
    try {
      setTestResults(await onLoadResults());
    } catch (reason) {
      setResultsError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResultsLoading(false);
    }
  }, [onLoadResults]);

  // Auto-discover when the panel opens for a not-yet-loaded Java file.
  useEffect(() => {
    if (active && canDiscover && activeFileTitle && loadedFor !== activeFileTitle && !loading) {
      void discover();
    }
  }, [active, canDiscover, activeFileTitle, loadedFor, loading, discover]);

  const resultTree = resultGroups.map((group) => (
    <div key={group.className} data-testid={`tests-result-group-${group.className}`}>
      <div className="flex items-center gap-1 px-2 py-1 font-medium text-[var(--taomni-code-muted)]">
        <ChevronDown className="h-3 w-3" />
        <span className="truncate">{group.className}</span>
      </div>
      {group.results.map((result) => {
        return (
          <div
            key={result.id}
            data-testid={`tests-result-${result.id}`}
            className="group border-b border-[var(--taomni-code-border)]/40 px-2 py-1"
          >
            <div className="flex items-center gap-1">
              {statusIcon(result.status)}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:underline"
                title={resultStatusLabel(result.status)}
                onClick={() => onOpenFailure?.(result)}
                disabled={!onOpenFailure || !result.filePath}
              >
                {result.name}
              </button>
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{formatTestDuration(result.durationMs)}</span>
              {onRerun && (
                <button
                  type="button"
                  data-testid={`tests-rerun-${result.id}`}
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                  title="Rerun test"
                  onClick={() => onRerun(result)}
                  disabled={runDisabled}
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              )}
            </div>
            {(result.message || result.details) && (
              <button
                type="button"
                data-testid={`tests-failure-details-${result.id}`}
                className="mt-0.5 block w-full whitespace-pre-wrap break-words border-l-2 border-red-500/50 pl-2 text-left text-[10px] text-red-500 hover:bg-[var(--taomni-hover-bg)]"
                onClick={() => onOpenFailure?.(result)}
              >
                {result.message ?? result.details}
                {result.message && result.details ? `\n${result.details}` : ""}
              </button>
            )}
          </div>
        );
      })}
    </div>
  ));

  return (
    <div data-testid="code-workspace-tests-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="h-8 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-2">
        <FlaskConical className="h-3.5 w-3.5" />
        <span className="font-medium">Tests</span>
        {activeFileTitle && <span className="truncate text-[10px] text-[var(--taomni-text-muted)]">{activeFileTitle}</span>}
        <button
          type="button"
          data-testid="tests-refresh"
          className="taomni-btn ml-auto h-6 px-1.5 inline-flex items-center gap-1"
          onClick={() => void discover()}
          disabled={loading || !canDiscover}
          title="Discover tests"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
        <button
          type="button"
          data-testid="tests-load-results"
          className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
          onClick={() => void loadResults()}
          disabled={resultsLoading || !onLoadResults || !canDiscover}
          title={!canDiscover ? "Open a Java file to load test results" : "Load test results"}
        >
          {resultsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {(testResults || resultsError) && (
          <div data-testid="tests-result-summary" className="mx-2 mb-1 rounded border border-[var(--taomni-code-border)] px-2 py-1 text-[10px]">
            {testResults && <div className="flex items-center gap-2">
              <span className="font-medium">Results</span>
              <span>{testResults.summary.total} total</span>
              <span className="text-emerald-500">{testResults.summary.passed} passed</span>
              <span className="text-red-500">{testResults.summary.failed + testResults.summary.errors} failed</span>
              <span className="text-amber-500">{testResults.summary.skipped} skipped</span>
              <span className="ml-auto">{formatTestDuration(testResults.summary.durationMs)}</span>
            </div>}
            {testResults?.diagnostics.map((diagnostic) => <div key={diagnostic} className="mt-1 whitespace-pre-wrap text-amber-600" data-testid="tests-result-diagnostic">{diagnostic}</div>)}
            {resultsError && <div className="mt-1 text-red-500" data-testid="tests-result-error">{resultsError}</div>}
          </div>
        )}
        {resultTree}
        {!canDiscover && (
          <div className="px-3 py-2 text-[var(--taomni-text-muted)]">
            Open a Java file to discover its tests.
          </div>
        )}
        {canDiscover && error && (
          <div className="px-3 py-2 text-red-500" data-testid="tests-error">{error}</div>
        )}
        {canDiscover && !error && !loading && items.length === 0 && loadedFor && (
          <div className="px-3 py-2 text-[var(--taomni-text-muted)]">No tests found in this file.</div>
        )}
        {items.map((item) => (
          <TestRow
            key={item.fullName}
            item={item}
            depth={0}
            onRun={onRun}
            onDebug={onDebug}
            runDisabled={runDisabled}
            resultStatus={resultById.get(item.fullName)?.status}
            resultStatusFor={(selector) => resultById.get(selector)?.status}
          />
        ))}
      </div>
    </div>
  );
}
