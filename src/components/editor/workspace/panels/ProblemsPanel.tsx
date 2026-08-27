import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, Hammer, Info, Loader2 } from "lucide-react";
import type { LspDiagnostic } from "../../../../lib/editor/lsp";
import { writeText } from "../../../../lib/clipboard";
import { useContextMenu } from "../../../ContextMenu";

export interface ProblemFileGroup {
  key: string;
  title: string;
  subtitle: string;
  /** Stable path identity used by suppression and baseline matching. */
  path?: string;
  diagnostics: LspDiagnostic[];
}

export type ProblemsScope = "open" | "project";

interface ProblemsPanelProps {
  files: ProblemFileGroup[];
  onOpenProblem: (fileKey: string, diagnostic: LspDiagnostic) => void;
  onQuickFix?: (fileKey: string, diagnostic: LspDiagnostic) => void;
  onSuppress?: (fileKey: string, diagnostic: LspDiagnostic, scope: "file" | "line") => void;
  onAddToBaseline?: (fileKey: string, diagnostic: LspDiagnostic) => void;
  /** "open files" (default) vs "whole project" (M7-C). Omit to hide the toggle. */
  scope?: ProblemsScope;
  onScopeChange?: (scope: ProblemsScope) => void;
  /** Whole-project rebuild (jdtls java.buildWorkspace); shown only in project scope. */
  onRebuild?: () => void;
  rebuilding?: boolean;
  /** True while the project-scope diagnostics are (re)loading. */
  loading?: boolean;
  /** Display-only inspection transform. Callbacks still receive the provider diagnostic. */
  diagnosticTransform?: (diagnostic: LspDiagnostic, path?: string) => LspDiagnostic | null;
  onOpenRelatedInformation?: (diagnostic: LspDiagnostic) => void;
  /** §8.20.4 DoD: provider/scope/revision/completeness line per diagnostic. */
  evidenceLine?: (fileKey: string, diagnostic: LspDiagnostic) => string | null;
  /** True when the provider's own suppression edit applied ("Suppressed in source"). */
  suppressedInSource?: (fileKey: string, diagnostic: LspDiagnostic) => boolean;
  /**
   * §8.20.4 gate: shown verbatim when the server lacks workspace diagnostics —
   * full-project inspection stays "On-the-fly diagnostics only".
   */
  fullProjectNote?: string | null;
}

type SeverityKind = "error" | "warning" | "info";

function severityKind(severity: number | null): SeverityKind {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  return "info";
}

function SeverityIcon({ kind }: { kind: SeverityKind }) {
  if (kind === "error") return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  if (kind === "warning") return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  return <Info className="h-3.5 w-3.5 shrink-0 text-sky-500" />;
}

export function ProblemsPanel({
  files,
  onOpenProblem,
  onQuickFix,
  onSuppress,
  onAddToBaseline,
  scope,
  onScopeChange,
  onRebuild,
  rebuilding,
  loading,
  diagnosticTransform,
  onOpenRelatedInformation,
  evidenceLine,
  suppressedInSource,
  fullProjectNote = null,
}: ProblemsPanelProps) {
  const projectScope = scope === "project";
  const [visible, setVisible] = useState<Record<SeverityKind, boolean>>({
    error: true,
    warning: true,
    info: true,
  });
  const contextMenu = useContextMenu();
  const profiledFiles = useMemo(() => files.map((file) => ({
    ...file,
    diagnostics: file.diagnostics.flatMap((original) => {
      const display = diagnosticTransform ? diagnosticTransform(original, file.path ?? file.subtitle) : original;
      return display ? [{ original, display }] : [];
    }),
  })), [diagnosticTransform, files]);
  const counts = useMemo(() => {
    const next: Record<SeverityKind, number> = { error: 0, warning: 0, info: 0 };
    for (const file of profiledFiles) {
      for (const diagnostic of file.diagnostics) next[severityKind(diagnostic.display.severity)] += 1;
    }
    return next;
  }, [profiledFiles]);
  const filteredFiles = useMemo(
    () => profiledFiles
      .map((file) => ({
        ...file,
        diagnostics: file.diagnostics.filter(({ display }) => visible[severityKind(display.severity)]),
      }))
      .filter((file) => file.diagnostics.length > 0),
    [profiledFiles, visible],
  );

  return (
    <div data-testid="code-workspace-problems-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="h-8 shrink-0 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        {scope && onScopeChange ? (
          <div className="mr-1 inline-flex rounded border border-[var(--taomni-code-border)] text-[10px]">
            {(["open", "project"] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`problems-scope-${value}`}
                aria-pressed={scope === value}
                data-active={scope === value || undefined}
                className="px-1.5 py-0.5 text-[var(--taomni-code-muted)] first:rounded-l last:rounded-r data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
                onClick={() => onScopeChange(value)}
              >
                {value === "open" ? "Open files" : "Whole project"}
              </button>
            ))}
          </div>
        ) : (
          <span className="mr-1 text-[10px] text-[var(--taomni-code-muted)]">Open files</span>
        )}
        {fullProjectNote && projectScope && (
          <span
            data-testid="problems-full-project-note"
            className="mr-1 truncate text-[10px] text-amber-500"
            title={fullProjectNote}
          >
            {fullProjectNote}
          </span>
        )}
        {projectScope && onRebuild && (
          <button
            type="button"
            data-testid="problems-rebuild"
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onRebuild}
            disabled={rebuilding}
            title="Rebuild project (jdtls java.buildWorkspace)"
          >
            {rebuilding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Hammer className="h-3 w-3" />}
            Rebuild
          </button>
        )}
        {(["error", "warning", "info"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-label={`Show ${kind} diagnostics`}
            aria-pressed={visible[kind]}
            data-active={visible[kind] || undefined}
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
            onClick={() => setVisible((current) => ({ ...current, [kind]: !current[kind] }))}
          >
            <SeverityIcon kind={kind} />
            <span className="tabular-nums">{counts[kind]}</span>
          </button>
        ))}
        <span className="ml-auto text-[10px] text-[var(--taomni-code-muted)]">
          {counts.error + counts.warning + counts.info} problem{counts.error + counts.warning + counts.info === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {filteredFiles.length === 0 && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            {loading
              ? "Loading project problems…"
              : counts.error + counts.warning + counts.info === 0
                ? (projectScope ? "No problems in the project" : "No problems in open files")
                : "No matching problems"}
          </div>
        )}
        {filteredFiles.map((file) => (
          <section key={file.key}>
            <div className="h-6 flex items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)]" title={file.subtitle}>
              <span className="min-w-0 flex-1 truncate">{file.subtitle}</span>
              <span className="shrink-0 text-[10px] tabular-nums">{file.diagnostics.length}</span>
            </div>
            {file.diagnostics.map(({ original, display: diagnostic }, index) => {
              const kind = severityKind(diagnostic.severity);
              const detail = [diagnostic.source, diagnostic.code].filter(Boolean).join(" · ");
              return (
                <button
                  key={`${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}:${index}`}
                  type="button"
                  className="min-h-7 w-full min-w-0 flex items-start gap-2 px-4 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  onClick={() => onOpenProblem(file.key, original)}
                  onContextMenu={(event) => contextMenu.show(event, [
                    {
                      label: "Copy Message",
                      onClick: () => void writeText(diagnostic.message),
                    },
                    {
                      label: "Quick Fix",
                      disabled: !onQuickFix,
                      onClick: () => onQuickFix?.(file.key, original),
                    },
                    ...(onSuppress
                      ? [
                          // §8.20.4 naming rule: these hide the diagnostic in
                          // THIS client only. "Suppressed in source" is
                          // reserved for a provider suppression edit that
                          // actually applied.
                          {
                            label: "Hide this diagnostic locally (line)",
                            onClick: () => onSuppress(file.key, original, "line" as const),
                          },
                          {
                            label: "Hide this diagnostic locally (whole file)",
                            onClick: () => onSuppress(file.key, original, "file" as const),
                          },
                        ]
                      : []),
                    ...(onAddToBaseline
                      ? [{
                          label: "Add to inspection baseline",
                          onClick: () => onAddToBaseline(file.key, original),
                        }]
                      : []),
                    ...(diagnostic.relatedInformation?.length && onOpenRelatedInformation
                      ? [{
                          label: `Show related locations (${diagnostic.relatedInformation.length})`,
                          onClick: () => onOpenRelatedInformation(original),
                        }]
                      : []),
                  ])}
                >
                  <SeverityIcon kind={kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[var(--taomni-code-text)]">{diagnostic.message}</span>
                    {detail && <span className="block truncate text-[10px] text-[var(--taomni-code-muted)]">{detail}</span>}
                    {/* §8.20.4 DoD: provider/scope/revision/completeness on every row. */}
                    {evidenceLine && (
                      <span
                        data-testid="problems-evidence-line"
                        className="block truncate text-[10px] text-[var(--taomni-code-muted)]"
                      >
                        {evidenceLine(file.key, original)}
                      </span>
                    )}
                    {suppressedInSource?.(file.key, original) && (
                      <span
                        data-testid="problems-suppressed-in-source"
                        className="block text-[10px] text-emerald-500"
                      >
                        Suppressed in source
                      </span>
                    )}
                    {diagnostic.tags?.includes(1) && (
                      <span className="block text-[10px] text-[var(--taomni-code-muted)]">unnecessary</span>
                    )}
                    {diagnostic.tags?.includes(2) && (
                      <span className="block text-[10px] text-[var(--taomni-code-muted)]">deprecated</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                    {diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      {contextMenu.render}
    </div>
  );
}
