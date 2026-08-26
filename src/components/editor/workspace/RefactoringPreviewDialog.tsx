import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileCode,
  Square,
  X,
} from "lucide-react";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";
import type { RefactorPlanV3 } from "./refactorPlan";
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
  plan?: RefactorPlanV3;
  onConfirm: (filteredEdit: LspWorkspaceEdit) => void;
  onCancel: () => void;
}

export function RefactoringPreviewDialog({
  open,
  title = "Refactoring Usages Preview",
  preview,
  originalEdit,
  plan,
  onConfirm,
  onCancel,
}: RefactoringPreviewDialogProps) {
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = useState("");

  const errorConflicts = useMemo(
    () => plan?.conflicts.filter((c) => c.severity === "error") ?? [],
    [plan?.conflicts],
  );
  const warningConflicts = useMemo(
    () => plan?.conflicts.filter((c) => c.severity === "warning") ?? [],
    [plan?.conflicts],
  );

  const requiredUsageIds = useMemo(() => {
    const set = new Set<string>();
    if (!plan) return set;
    for (const group of plan.excludableGroups) {
      if (group.required) {
        for (const idx of group.operationIndexes) {
          const op = plan.operations[idx];
          if (op && op.kind === "text") {
            for (const usage of preview.usages) {
              if (
                usage.path === op.document.path &&
                op.document.edits.some(
                  (edit) =>
                    usage.range.start.line === edit.range.start.line &&
                    usage.range.start.character === edit.range.start.character,
                )
              ) {
                set.add(usage.id);
              }
            }
          }
        }
      }
    }
    return set;
  }, [plan, preview.usages]);

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
    if (requiredUsageIds.has(id)) return;
    setExcludedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFile = (path: string) => {
    const usages = usagesByFile.get(path) ?? [];
    const excludable = usages.filter((u) => !requiredUsageIds.has(u.id));
    if (excludable.length === 0) return;
    const allExcluded = excludable.every((u) => excludedIds.has(u.id));
    setExcludedIds((current) => {
      const next = new Set(current);
      for (const u of excludable) {
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
  const selectNone = () =>
    setExcludedIds(
      new Set(preview.usages.filter((u) => !requiredUsageIds.has(u.id)).map((u) => u.id)),
    );

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
            <div className="flex items-center gap-2">
              <h2 id="refactoring-preview-dialog-title" className="text-[14px] font-semibold">
                {title}
              </h2>
              {plan && (
                <span
                  data-testid="refactoring-preview-completeness"
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    plan.completeness === "provider-complete"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : plan.completeness === "provider-partial"
                      ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      : "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-muted)] border border-[var(--taomni-code-border)]"
                  }`}
                >
                  {plan.completeness === "provider-complete"
                    ? "Provider Complete"
                    : plan.completeness === "provider-partial"
                    ? "Provider Partial"
                    : "Completeness Unknown"}
                </span>
              )}
            </div>
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

        {/* Conflicts Banner */}
        {errorConflicts.length > 0 && (
          <div
            data-testid="refactoring-preview-error-conflicts"
            className="mx-4 mt-2 flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
            <div>
              <div className="font-semibold">Refactoring Blocked by Conflicts:</div>
              <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
                {errorConflicts.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {warningConflicts.length > 0 && errorConflicts.length === 0 && (
          <div
            data-testid="refactoring-preview-warning-conflicts"
            className="mx-4 mt-2 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
            <div>
              <div className="font-semibold">Warnings:</div>
              <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
                {warningConflicts.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

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
                      const isRequired = requiredUsageIds.has(usage.id);
                      return (
                        <label
                          key={usage.id}
                          className={`flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--taomni-code-active-line-bg)] font-mono text-[11px] ${
                            isRequired ? "cursor-not-allowed opacity-80" : "cursor-pointer"
                          }`}
                        >
                          <input
                            type="checkbox"
                            data-testid={`refactoring-preview-usage-${usage.id}`}
                            checked={isIncluded}
                            disabled={isRequired}
                            title={isRequired ? "Required refactoring change (cannot be excluded)" : undefined}
                            onChange={() => toggleUsage(usage.id)}
                            className="rounded border-[var(--taomni-code-border)] disabled:opacity-60"
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
                          {isRequired && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.2 text-[9px] text-amber-400 font-sans">
                              required
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
            disabled={
              (includedCount === 0 && preview.resourceOperationCount === 0) ||
              errorConflicts.length > 0
            }
            title={
              errorConflicts.length > 0
                ? "Cannot apply refactoring with unresolved conflicts"
                : undefined
            }
            className="rounded bg-sky-600 px-4 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Do Refactor ({includedCount})
          </button>
        </div>
      </div>
    </div>
  );
}
