import { File, Loader2 } from "lucide-react";
import type { LspLocation } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  workspaceSemanticIndexBuildIsCurrent,
  workspaceSemanticIndexStatusLabel,
  type WorkspaceSemanticIndexSnapshot,
} from "../workspaceSemanticIndex";
import { relativePathWithinRoot } from "../codeWorkspaceModel";

export interface ReferencesResultState {
  loading: boolean;
  origin: string | null;
  locations: LspLocation[];
  error: string | null;
  semanticGeneration?: number | null;
  semanticRevision?: number | null;
}

interface ReferencesPanelProps {
  result: ReferencesResultState;
  roots: CodeWorkspaceRootInfo[];
  semanticIndex: WorkspaceSemanticIndexSnapshot;
  onOpenLocation: (location: LspLocation) => void;
}

function displayLocationPath(location: LspLocation, roots: CodeWorkspaceRootInfo[]): string {
  const path = location.path ?? location.uri;
  for (const root of roots) {
    const relative = location.path ? relativePathWithinRoot(root.path, location.path) : null;
    if (relative !== null) return `${root.name}/${relative}`;
  }
  return path;
}

export function ReferencesPanel({ result, roots, semanticIndex, onOpenLocation }: ReferencesPanelProps) {
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
      <div
        data-testid="references-semantic-index"
        className={`border-b border-[var(--taomni-code-border)] px-3 py-1 text-[10px] ${resultCurrent ? "text-[var(--taomni-code-muted)]" : "text-amber-500"}`}
        title="References are supplied by the active language server. This is not an IntelliJ PSI index guarantee."
      >
        Provider snapshot: {semanticLabel}
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
      {result.locations.map((location, index) => {
        const label = displayLocationPath(location, roots);
        return (
          <button
            key={`${location.uri}:${location.range.start.line}:${location.range.start.character}:${index}`}
            type="button"
            className="h-7 w-full min-w-0 flex items-center gap-2 px-3 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
            title={`${label}:${location.range.start.line + 1}:${location.range.start.character + 1}`}
            onClick={() => onOpenLocation(location)}
          >
            <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
              {location.range.start.line + 1}:{location.range.start.character + 1}
            </span>
          </button>
        );
      })}
    </div>
  );
}
