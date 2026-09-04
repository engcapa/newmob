import { useMemo, useState } from "react";
import {
  createReplaceInFilesPlan,
} from "../replaceInFilesModel";
import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";

/**
 * ED-FIND-004 A1: structured Replace in Files preview. Groups the frozen
 * plan usages by file with per-match and per-file exclusion checkboxes, live
 * included/total counts, and an explicit commit/cancel boundary.
 *
 * Exclusion is keyed by STABLE content keys (path + range), never by the
 * positional `opIdx:editIdx` usage ids: those shift when an exclusion
 * rebuilds the plan, which would silently re-include or misattribute rows.
 * The positional ids are derived per render for the model call only.
 */
export interface ReplacePreviewDialogProps {
  /** Frozen source edit the preview was built from (rebuilt immutably on exclusion). */
  edit: LspWorkspaceEdit;
  /** Replacement text shown in the header. */
  replacement: string;
  committing: boolean;
  commitError: string | null;
  onCommit: (excludedKeys: ReadonlySet<string>) => void;
  onCancel: () => void;
}

export function stableUsageKey(path: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): string {
  return `${path}:${startLine}:${startCharacter}:${endLine}:${endCharacter}`;
}

export function ReplacePreviewDialog({
  edit,
  replacement,
  committing,
  commitError,
  onCommit,
  onCancel,
}: ReplacePreviewDialogProps) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const live = useMemo(() => {
    const excludedUsageIds = new Set<string>();
    for (const usage of createReplaceInFilesPlan(edit).preview.usages) {
      const key = stableUsageKey(
        usage.path,
        usage.range.start.line,
        usage.range.start.character,
        usage.range.end.line,
        usage.range.end.character,
      );
      if (excluded.has(key)) excludedUsageIds.add(usage.id);
    }
    return createReplaceInFilesPlan(edit, excludedUsageIds);
  }, [edit, excluded]);
  const byFile = useMemo(() => {
    const groups = new Map<string, typeof live.preview.usages>();
    for (const usage of live.preview.usages) {
      const list = groups.get(usage.path);
      if (list) list.push(usage);
      else groups.set(usage.path, [usage]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [live]);

  const keyOf = (usage: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }) => stableUsageKey(
    usage.path,
    usage.range.start.line,
    usage.range.start.character,
    usage.range.end.line,
    usage.range.end.character,
  );
  const toggleUsageKey = (key: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleFile = (path: string, checked: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      for (const usage of live.preview.usages) {
        if (usage.path !== path) continue;
        if (checked) next.delete(keyOf(usage));
        else next.add(keyOf(usage));
      }
      return next;
    });
  };

  return (
    <div
      data-testid="code-workspace-replace-preview"
      role="dialog"
      aria-label="Replace in files preview"
      className="flex max-h-[70vh] min-h-0 w-[560px] max-w-[90vw] flex-col rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-text)]"
    >
      <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2">
        <div className="font-medium">Replace in files preview</div>
        <div
          data-testid="code-workspace-replace-counts"
          className="mt-0.5 text-[11px] text-[var(--taomni-code-muted)]"
        >
          {live.includedMatches} of {live.totalMatches} occurrences · replace with “{replacement}”
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {byFile.map(([path, usages]) => {
          const excludedCount = usages.filter((usage) => excluded.has(keyOf(usage))).length;
          const allExcluded = excludedCount === usages.length;
          return (
            <section key={path}>
              <label className="flex h-6 items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)]">
                <input
                  type="checkbox"
                  checked={!allExcluded}
                  aria-label={`Include all matches in ${path}`}
                  data-testid="code-workspace-replace-file-toggle"
                  data-path={path}
                  onChange={(event) => toggleFile(path, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate text-left">{path}</span>
                <span className="shrink-0 text-[10px] tabular-nums">
                  {usages.length - excludedCount}/{usages.length}
                </span>
              </label>
              {usages.map((usage) => {
                const key = keyOf(usage);
                return (
                  <label
                    key={key}
                    className="flex h-6 items-center gap-2 px-6 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  >
                    <input
                      type="checkbox"
                      checked={!excluded.has(key)}
                      aria-label={`Include occurrence at ${usage.path}:${usage.range.start.line + 1}`}
                      data-testid="code-workspace-replace-usage"
                      data-usage-id={usage.id}
                      onChange={() => toggleUsageKey(key)}
                    />
                    <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                      {usage.range.start.line + 1}:{usage.range.start.character}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                      → {usage.newText}
                    </span>
                  </label>
                );
              })}
            </section>
          );
        })}
        {byFile.length === 0 && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            Every occurrence is excluded — nothing will be replaced.
          </div>
        )}
      </div>
      {commitError && (
        <div
          data-testid="code-workspace-replace-commit-error"
          role="alert"
          className="shrink-0 border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500"
        >
          {commitError}
        </div>
      )}
      <div className="shrink-0 flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
        <button
          type="button"
          data-testid="code-workspace-replace-cancel"
          className="h-7 rounded px-3 hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={onCancel}
          disabled={committing}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="code-workspace-replace-commit"
          className="h-7 rounded bg-[var(--taomni-accent)] px-3 font-medium text-white disabled:opacity-50"
          disabled={committing || live.includedMatches === 0}
          onClick={() => onCommit(excluded)}
        >
          {committing ? "Replacing…" : `Replace ${live.includedMatches}`}
        </button>
      </div>
    </div>
  );
}
