import { useMemo, useState } from "react";
import { File, Loader2, Pin, PinOff, RefreshCw } from "lucide-react";
import type { LspLocation } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  workspaceSemanticIndexBuildIsCurrent,
  workspaceSemanticIndexStatusLabel,
  type WorkspaceSemanticIndexSnapshot,
} from "../workspaceSemanticIndex";
import { relativePathWithinRoot } from "../codeWorkspaceModel";
import {
  applyUsageFilters,
  buildUsageSession,
  DEFAULT_USAGE_FILTERS,
  usageBatch,
  type SemanticRequestIdentity,
  type UsageFilters,
  type UsageSession,
} from "../javaSemanticEvidence";

export interface ReferencesResultState {
  loading: boolean;
  origin: string | null;
  locations: LspLocation[];
  error: string | null;
  semanticGeneration?: number | null;
  semanticRevision?: number | null;
  /** §8.18.7: symbol identity for rerun; null disables the rerun affordance. */
  symbolName?: string | null;
  identity?: SemanticRequestIdentity;
}

interface ReferencesPanelProps {
  result: ReferencesResultState;
  roots: CodeWorkspaceRootInfo[];
  semanticIndex: WorkspaceSemanticIndexSnapshot;
  onOpenLocation: (location: LspLocation) => void;
  onRerun?: () => void;
  /**
   * §8.19.7 pin ownership lives above the panel so a new Find Usages request
   * can ask before replacing a pinned session instead of clobbering it.
   */
  pinned?: boolean;
  onPinChange?: (pinned: boolean) => void;
  /** §8.20.5 W4: the scope selection this result was produced under. */
  scopeSelection?: { scope: string; includeDeclaration: boolean; includeLibraries: boolean; includeTests: boolean } | null;
  /** Recent immutable sessions (bounded); restoring swaps the view only. */
  recentSessions?: ReadonlyArray<{ id: string; label: string }>;
  onRestoreRecent?: (id: string) => void;
  recentsRevision?: number;
}

function displayLocationPath(location: LspLocation, roots: CodeWorkspaceRootInfo[]): string {
  const path = location.path ?? location.uri;
  for (const root of roots) {
    const relative = location.path ? relativePathWithinRoot(root.path, location.path) : null;
    if (relative !== null) return `${root.name}/${relative}`;
  }
  return path;
}

/**
 * Find Usages tool-window panel (§8.18.7): grouped results with explicit
 * batch continuation (never a silent cap), pin, and provider-identity rerun.
 */
export function ReferencesPanel({ result, roots, semanticIndex, onOpenLocation, onRerun, pinned, onPinChange, scopeSelection = null, recentSessions = [], onRestoreRecent, recentsRevision = 0 }: ReferencesPanelProps) {
  const [pinState, setPinState] = useState(false);
  const isPinned = pinned ?? pinState;
  const [cursor, setCursor] = useState(0);
  const [filters, setFilters] = useState<UsageFilters>({ ...DEFAULT_USAGE_FILTERS });

  // The session model is derived from the flat provider response; roles stay
  // unknown because plain LSP references carry no read/write classification.
  // Library/external ownership uses the real URI-vs-roots test (§8.19.7).
  const session: UsageSession = useMemo(() => {
    // §8.19.7: library filter classifies by real URI owner — a location is a
    // workspace hit only when its file:// path resolves inside some root.
    const libraryUri = (uri: string) => {
      if (!/^file:/i.test(uri)) return true;
      let path = decodeURIComponent(uri.replace(/^file:\/\//i, ""));
      // file:///C:/… decodes to /C:/…; drop the leading slash so Windows
      // drive paths compare against root paths.
      if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
      return !roots.some((root) => relativePathWithinRoot(root.path, path) !== null);
    };
    if (!result.identity || !result.symbolName) {
      // Legacy shape: synthesize a minimal identity so grouping still works.
      return buildUsageSession({
        identity: {
          workspaceId: "",
          fileKey: "",
          uri: result.origin ?? "",
          position: { line: 0, character: 0 },
          documentRevision: result.semanticRevision ?? 0,
          providerGeneration: result.semanticGeneration ?? 0,
          projectFingerprint: "pf-legacy",
          requestId: "legacy",
        },
        symbolName: result.symbolName ?? "",
        locations: result.locations,
        isLibraryUri: libraryUri,
      });
    }
    return buildUsageSession({
      identity: result.identity,
      symbolName: result.symbolName,
      locations: result.locations,
      isLibraryUri: libraryUri,
    });
  }, [result, roots]);

  const { visibleIds } = applyUsageFilters(session, filters);
  const batch = usageBatch(session, visibleIds, cursor);
  const itemsById = new Map(session.items.map((item) => [item.id, item]));
  const groupsByKey = new Map(session.groups.map((group) => [group.key, group]));

  const resultToken = result.semanticGeneration == null || result.semanticRevision == null
    ? null
    : { generation: result.semanticGeneration, revision: result.semanticRevision };
  const resultCurrent = resultToken
    ? workspaceSemanticIndexBuildIsCurrent(semanticIndex, resultToken)
    : false;
  const semanticLabel = resultToken
    ? resultCurrent
      ? `Ready · generation ${resultToken.generation}`
      : `Stale · result generation ${resultToken.generation}`
    : workspaceSemanticIndexStatusLabel(semanticIndex);

  return (
    <div data-testid="code-workspace-references-panel" className="h-full min-h-0 overflow-auto py-1 text-[11px]">
      <div className="flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-3 py-1">
        <div
          data-testid="references-semantic-index"
          className={`min-w-0 flex-1 truncate text-[10px] ${resultCurrent ? "text-[var(--taomni-code-muted)]" : "text-amber-500"}`}
          title="References are supplied by the active language server. This is not an IntelliJ PSI index guarantee."
        >
          Provider snapshot: {semanticLabel}
        </div>
        <button
          type="button"
          data-testid="references-pin-toggle"
          aria-label={isPinned ? "Unpin usages result" : "Pin usages result"}
          className="rounded p-0.5 hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={() => {
            const next = !isPinned;
            if (pinned === undefined) setPinState(next);
            onPinChange?.(next);
          }}
        >
          {isPinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
        </button>
        {onRerun && (
          <button
            type="button"
            data-testid="references-rerun"
            aria-label="Rerun find usages for the same symbol identity"
            title={result.symbolName ? `Rerun: ${result.symbolName}` : "Rerun unavailable without a symbol identity"}
            disabled={!result.symbolName}
            className="rounded p-0.5 hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            onClick={() => {
              setCursor(0);
              onRerun();
            }}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
        {/* §8.20.5 W4: recent immutable sessions — restoring swaps the VIEW,
            never re-queries or mutates the pinned truth. */}
        {recentSessions.length > 1 && onRestoreRecent && (
          <select
            data-testid="references-recent-sessions"
            aria-label="Recent usages sessions"
            className="h-6 max-w-[140px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) onRestoreRecent(event.target.value);
              event.target.value = "";
            }}
            key={recentsRevision}
          >
            <option value="">Recent…</option>
            {recentSessions.map((session) => (
              <option key={session.id} value={session.id}>{session.label}</option>
            ))}
          </select>
        )}
      </div>
      {scopeSelection && (
        <div
          data-testid="references-scope-line"
          className="truncate px-3 pt-1 text-[10px] text-[var(--taomni-code-muted)]"
          title="Scope is a client-side selection over one document-scope provider response"
        >
          Scope: {scopeSelection.scope}
          {scopeSelection.includeDeclaration ? " · +declaration" : ""}
          {scopeSelection.includeLibraries ? " · +libraries" : " · libraries hidden"}
          {!scopeSelection.includeTests ? " · tests hidden" : ""}
        </div>
      )}
      {result.loading && (
        <div className="flex items-center gap-2 px-3 py-2 text-[var(--taomni-code-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Finding references...</span>
        </div>
      )}
      {result.origin && (
        <div className="truncate px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]" title={result.origin}>
          {result.origin}
        </div>
      )}
      {/* §8.19.7: read/write/declaration stay DISABLED while roles are
          unknown — plain LSP references carry no classification, so enabled
          toggles could only pretend to filter. The libraries toggle is real:
          it classifies by URI owner against the workspace roots. */}
      {!result.loading && result.locations.length > 0 && (
        <div
          className="flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]"
          data-testid="references-filters"
        >
          {(["reads", "writes", "declarations"] as const).map((key) => (
            <label
              key={key}
              className="cursor-not-allowed opacity-40"
              title="Read/write/declaration roles are unknown: the language server does not classify reference roles"
            >
              <input type="checkbox" disabled checked={false} className="mr-0.5 align-middle" />
              {key === "reads" ? "Reads" : key === "writes" ? "Writes" : "Declarations"}
            </label>
          ))}
          <label className="ml-auto flex items-center gap-0.5">
            <input
              type="checkbox"
              data-testid="references-filter-libraries"
              checked={filters.libraries}
              onChange={(event) => setFilters((current) => ({ ...current, libraries: event.target.checked }))}
              className="align-middle"
            />
            Libraries
          </label>
        </div>
      )}
      {result.error && (
        <div className="mx-2 mb-1 rounded border border-red-500/30 bg-red-500/10 p-2 text-red-500">
          {result.error}
        </div>
      )}
      {!result.loading && !result.error && result.locations.length === 0 && (
        <div className="px-3 py-2 text-[var(--taomni-code-muted)]">No references</div>
      )}
      {[...new Set(batch.items.map((item) => item.path ?? item.uri))].map((groupKey) => (
        <div key={groupKey}>
          {session.groups.length > 1 && (
            <div className="sticky top-0 bg-[var(--taomni-code-bg)] px-3 py-0.5 text-[9px] uppercase tracking-wide text-[var(--taomni-code-muted)]">
              {groupsByKey.get(groupKey)?.label ?? groupKey}
            </div>
          )}
          {batch.items
            .filter((item) => (item.path ?? item.uri) === groupKey)
            .map((item) => {
              const label = displayLocationPath(
                { uri: item.uri, path: item.path, range: item.range },
                roots,
              );
              return (
                <button
                  key={item.id}
                  type="button"
                  className="h-7 w-full min-w-0 flex items-center gap-2 px-3 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  title={`${label}:${item.range.start.line + 1}:${item.range.start.character + 1}${item.previewLine ? `\n${item.previewLine.trim()}` : ""}`}
                  onClick={() => onOpenLocation({ uri: item.uri, path: item.path, range: item.range })}
                >
                  <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                    {item.range.start.line + 1}:{item.range.start.character + 1}
                  </span>
                </button>
              );
            })}
        </div>
      ))}
      {batch.nextCursor !== null && (
        <button
          type="button"
          data-testid="references-show-more"
          className="mx-2 my-1 rounded border border-[var(--taomni-code-border)] px-2 py-1 hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={() => setCursor(batch.nextCursor!)}
        >
          Show more ({batch.totalVisible - batch.items.length} remaining of {batch.totalVisible})
        </button>
      )}
      {/* Pinned marker: ownership lives in the tab so new requests must ask
          before replacing this session (§8.19.7). */}
      {isPinned && (
        <div className="px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]">Result pinned — a new Find Usages will ask before replacing it.</div>
      )}
      {itemsById.size === 0 && !result.loading && null}
    </div>
  );
}
