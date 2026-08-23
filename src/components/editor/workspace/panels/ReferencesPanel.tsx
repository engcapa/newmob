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
  usageBatch,
  type SemanticRequestIdentity,
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
export function ReferencesPanel({ result, roots, semanticIndex, onOpenLocation, onRerun }: ReferencesPanelProps) {
  const [pinned, setPinned] = useState(false);
  const [cursor, setCursor] = useState(0);

  // The session model is derived from the flat provider response; roles stay
  // unknown because plain LSP references carry no read/write classification.
  const session: UsageSession = useMemo(() => {
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
      });
    }
    return buildUsageSession({
      identity: result.identity,
      symbolName: result.symbolName,
      locations: result.locations,
    });
  }, [result]);

  const { visibleIds } = applyUsageFilters(session);
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
          aria-label={pinned ? "Unpin usages result" : "Pin usages result"}
          className="rounded p-0.5 hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={() => setPinned((value) => !value)}
        >
          {pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
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
      </div>
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
      {/* Pinned marker is informational; the store keeps the session alive. */}
      {pinned && (
        <div className="px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]">Result pinned — navigation will not replace it.</div>
      )}
      {itemsById.size === 0 && !result.loading && null}
    </div>
  );
}
