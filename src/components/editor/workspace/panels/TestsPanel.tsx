import { useCallback, useEffect, useState } from "react";
import { Bug, ChevronDown, ChevronRight, FlaskConical, Loader2, Play, RefreshCw } from "lucide-react";
import type { JavaTestItem } from "../../../../lib/editor/lsp";

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
  /** Debug a single class/method through the DAP path (M9 debug-test). */
  onDebug: (item: JavaTestItem) => void;
  /** True when the workspace has no Maven/Gradle runner (run disabled). */
  runDisabled: boolean;
}

function TestRow({
  item,
  depth,
  onRun,
  onDebug,
  runDisabled,
}: {
  item: JavaTestItem;
  depth: number;
  onRun: (item: JavaTestItem) => void;
  onDebug: (item: JavaTestItem) => void;
  runDisabled: boolean;
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
          className="shrink-0 opacity-0 group-hover:opacity-100"
          onClick={() => onDebug(item)}
          title="Debug test (requires java-debug + java-test bundles)"
        >
          <Bug className="h-3 w-3" />
        </button>
      </div>
      {open && hasChildren && item.children.map((child) => (
        <TestRow key={child.fullName} item={child} depth={depth + 1} onRun={onRun} onDebug={onDebug} runDisabled={runDisabled} />
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
  runDisabled,
}: TestsPanelProps) {
  const [items, setItems] = useState<JavaTestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

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

  // Auto-discover when the panel opens for a not-yet-loaded Java file.
  useEffect(() => {
    if (active && canDiscover && activeFileTitle && loadedFor !== activeFileTitle && !loading) {
      void discover();
    }
  }, [active, canDiscover, activeFileTitle, loadedFor, loading, discover]);

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
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
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
          <TestRow key={item.fullName} item={item} depth={0} onRun={onRun} onDebug={onDebug} runDisabled={runDisabled} />
        ))}
      </div>
    </div>
  );
}
