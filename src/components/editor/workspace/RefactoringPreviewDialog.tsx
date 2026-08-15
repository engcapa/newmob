import { useMemo, useState } from "react";
import { CheckSquare, ChevronDown, ChevronRight, FileCode, Square, X } from "lucide-react";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";
import {
  filterWorkspaceEditByUsages,
  type WorkspaceEditPreview,
  type WorkspaceEditPreviewUsage,
} from "./workspaceEditPreview";

export interface RefactoringPreviewDialogProps {
  open: boolean;
  title?: string;
  preview: WorkspaceEditPreview;
  originalEdit: LspWorkspaceEdit;
  onConfirm: (filteredEdit: LspWorkspaceEdit) => void;
  onCancel: () => void;
}

export function RefactoringPreviewDialog({
  open,
  title = "Refactoring Usages Preview",
  preview,
  originalEdit,
  onConfirm,
  onCancel,
}: RefactoringPreviewDialogProps) {
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = useState("");

  const usagesByFile = useMemo(() => {
    const map = new Map<string, WorkspaceEditPreviewUsage[]>();
    for (const usage of preview.usages) {
      const existing = map.get(usage.path) ?? [];
      existing.push(usage);
      map.set(usage.path, existing);
    }
    return map;
  }, [preview.usages]);

  const fileList = useMemo(() => Array.from(usagesByFile.keys()), [usagesByFile]);

  if (!open) return null;

  const totalUsages = preview.usages.length;
  const includedCount = totalUsages - excludedIds.size;

  const toggleUsage = (id: string) => {
    setExcludedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFile = (path: string) => {
    const usages = usagesByFile.get(path) ?? [];
    const allExcluded = usages.every((u) => excludedIds.has(u.id));
    setExcludedIds((current) => {
      const next = new Set(current);
      for (const u of usages) {
        if (allExcluded) next.delete(u.id);
        else next.add(u.id);
      }
      return next;
    });
  };

  const toggleCollapseFile = (path: string) => {
    setCollapsedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = () => setExcludedIds(new Set());
  const selectNone = () => setExcludedIds(new Set(preview.usages.map((u) => u.id)));

  const handleApply = () => {
    const filtered = filterWorkspaceEditByUsages(originalEdit, excludedIds);
    onConfirm(filtered);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="refactoring-preview-dialog-title"
      data-testid="refactoring-preview-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl text-[12px] text-[var(--taomni-code-fg)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-3">
          <div>
            <h2 id="refactoring-preview-dialog-title" className="text-[14px] font-semibold">
              {title}
            </h2>
            <p className="text-[11px] text-[var(--taomni-code-muted)] mt-0.5">
              {preview.affectedFileCount} file(s) affected · {includedCount} of {totalUsages} change(s) selected
              {preview.resourceOperationCount > 0 && ` · ${preview.resourceOperationCount} resource operation(s)`}
            </p>
          </div>
          <button
            type="button"
            data-testid="refactoring-preview-close"
            onClick={onCancel}
            aria-label="Close"
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/40 px-4 py-2 text-[11px]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="refactoring-preview-select-all"
              onClick={selectAll}
              className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)]"
            >
              <CheckSquare className="h-3.5 w-3.5 text-emerald-500" />
              <span>Select All</span>
            </button>
            <button
              type="button"
              data-testid="refactoring-preview-select-none"
              onClick={selectNone}
              className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)]"
            >
              <Square className="h-3.5 w-3.5 text-[var(--taomni-code-muted)]" />
              <span>Deselect All</span>
            </button>
          </div>
          <input
            type="text"
            data-testid="refactoring-preview-filter"
            placeholder="Filter files or text..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="h-6 w-52 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2 text-[11px]"
          />
        </div>

        {/* Usages Tree */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2 divide-y divide-[var(--taomni-code-border)]/40">
          {fileList.length === 0 && (
            <div className="p-4 text-center text-[var(--taomni-code-muted)]">
              No individual text changes to preview
            </div>
          )}

          {fileList.map((path) => {
            const usages = usagesByFile.get(path) ?? [];
            const filteredUsages = searchFilter
              ? usages.filter(
                  (u) =>
                    path.toLowerCase().includes(searchFilter.toLowerCase()) ||
                    u.newText.toLowerCase().includes(searchFilter.toLowerCase()),
                )
              : usages;

            if (searchFilter && filteredUsages.length === 0) return null;

            const isCollapsed = collapsedFiles.has(path);
            const allSelected = usages.every((u) => !excludedIds.has(u.id));
            const someSelected = usages.some((u) => !excludedIds.has(u.id));

            return (
              <div key={path} className="py-1">
                {/* File Header */}
                <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--taomni-code-active-line-bg)]">
                  <button
                    type="button"
                    onClick={() => toggleCollapseFile(path)}
                    aria-label={`Toggle collapse for ${path}`}
                    className="p-0.5 text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-fg)]"
                  >
                    {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  <input
                    type="checkbox"
                    data-testid={`refactoring-preview-file-${path}`}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={() => toggleFile(path)}
                    className="rounded border-[var(--taomni-code-border)]"
                  />
                  <FileCode className="h-3.5 w-3.5 text-[var(--taomni-code-muted)] shrink-0" />
                  <span className="font-mono text-[11px] font-medium truncate flex-1">{path}</span>
                  <span className="text-[10px] text-[var(--taomni-code-muted)] shrink-0">
                    {usages.length} change(s)
                  </span>
                </div>

                {/* Usages list under file */}
                {!isCollapsed && (
                  <div className="ml-8 space-y-0.5 mt-0.5">
                    {filteredUsages.map((usage) => {
                      const isIncluded = !excludedIds.has(usage.id);
                      return (
                        <label
                          key={usage.id}
                          className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--taomni-code-active-line-bg)] cursor-pointer font-mono text-[11px]"
                        >
                          <input
                            type="checkbox"
                            data-testid={`refactoring-preview-usage-${usage.id}`}
                            checked={isIncluded}
                            onChange={() => toggleUsage(usage.id)}
                            className="rounded border-[var(--taomni-code-border)]"
                          />
                          <span className="text-[var(--taomni-code-muted)] shrink-0 w-16">
                            L{usage.range.start.line + 1}:{usage.range.start.character + 1}
                          </span>
                          <span className="text-emerald-500 font-semibold shrink-0">
                            → {usage.newText || "(empty)"}
                          </span>
                          {usage.annotationLabel && (
                            <span className="rounded bg-sky-500/10 px-1.5 py-0.2 text-[9px] text-sky-400">
                              {usage.annotationLabel}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/20 px-4 py-3">
          <button
            type="button"
            data-testid="refactoring-preview-cancel"
            onClick={onCancel}
            className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-3 py-1.5 hover:bg-[var(--taomni-code-active-line-bg)]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="refactoring-preview-apply"
            onClick={handleApply}
            disabled={includedCount === 0 && preview.resourceOperationCount === 0}
            className="rounded bg-sky-600 px-4 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Do Refactor ({includedCount})
          </button>
        </div>
      </div>
    </div>
  );
}
