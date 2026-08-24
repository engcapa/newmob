import { useMemo } from "react";
import { Activity, CheckCircle2, Circle, Download, ExternalLink, Info, RefreshCw, Route, Server, Trash2, Upload } from "lucide-react";
import type {
  LspDiagnostic,
  LspDiagnosticRelatedInformation,
  LspDocumentStatus,
  LspLocation,
} from "../../../../lib/editor/lsp";
import type { InspectionProfile, InspectionRule, InspectionSeverity } from "../inspectionProfile";
import {
  applyInspectionProfile,
  diagnosticInspectionId,
  inspectionBaselineEntryKey,
  inspectionRuleFor,
  inspectionSuppressionKey,
  type InspectionBaselineEntry,
} from "../inspectionProfile";
import type { ProblemFileGroup } from "./ProblemsPanel";
import { classifyProviderAnalysisEvidence } from "../inspectionEvidence";
import {
  workspaceSemanticIndexStatusLabel,
  type WorkspaceSemanticIndexSnapshot,
} from "../workspaceSemanticIndex";

interface AnalysisPanelProps {
  files: ProblemFileGroup[];
  status: LspDocumentStatus | null;
  semanticTokenCount: number;
  semanticIndex: WorkspaceSemanticIndexSnapshot;
  profile: InspectionProfile;
  onUpdateRule: (id: string, patch: Partial<InspectionRule>) => void;
  onCreateBaseline: () => void;
  onClearBaseline: () => void;
  onRemoveBaselineEntry: (key: string) => void;
  onRemoveSuppression: (key: string) => void;
  onExportBaseline: () => void;
  onImportBaseline: () => void;
  onOpenLocation: (location: LspLocation) => void;
  onOpenDiagnostic: (fileKey: string, diagnostic: LspDiagnostic) => void;
}

const SEVERITIES: Array<{ value: "inherit" | InspectionSeverity; label: string }> = [
  { value: "inherit", label: "Inherit" },
  { value: 1, label: "Error" },
  { value: 2, label: "Warning" },
  { value: 3, label: "Info" },
  { value: 4, label: "Hint" },
];

function capabilityRows(status: LspDocumentStatus | null): Array<[string, boolean]> {
  const capabilities = status?.capabilities;
  if (!capabilities) return [];
  return [
    ["Completion", capabilities.completion],
    ["Definition", capabilities.definition],
    ["References", capabilities.references],
    ["Rename", capabilities.rename],
    ["Code actions", capabilities.codeAction],
    ["Refactor kinds", (capabilities.codeActionKinds?.length ?? 0) > 0],
    ["Semantic tokens", capabilities.semanticTokens],
    ["Workspace diagnostics", capabilities.workspaceDiagnostics === true],
  ];
}

function relatedLabel(related: LspDiagnosticRelatedInformation): string {
  const path = related.location.path ?? related.location.uri;
  return `${path}:${related.location.range.start.line + 1}:${related.location.range.start.character + 1}`;
}

function flowStepLabel(step: { role: string; location: LspLocation | null }): string {
  const role = step.role === "unknown" ? "step" : step.role;
  if (!step.location) return role;
  const path = step.location.path ?? step.location.uri;
  return `${role} · ${path}:${step.location.range.start.line + 1}:${step.location.range.start.character + 1}`;
}

export function AnalysisPanel({
  files,
  status,
  semanticTokenCount,
  semanticIndex,
  profile,
  onUpdateRule,
  onCreateBaseline,
  onClearBaseline,
  onRemoveBaselineEntry,
  onRemoveSuppression,
  onExportBaseline,
  onImportBaseline,
  onOpenLocation,
  onOpenDiagnostic,
}: AnalysisPanelProps) {
  const diagnostics = useMemo(
    () => files.flatMap((file) => file.diagnostics.map((diagnostic) => ({ file, diagnostic }))),
    [files],
  );
  const ruleIds = useMemo(() => {
    const ids = new Set<string>(Object.keys(profile.rules));
    diagnostics.forEach(({ diagnostic }) => ids.add(diagnosticInspectionId(diagnostic)));
    return [...ids].sort((left, right) => left.localeCompare(right));
  }, [diagnostics, profile.rules]);
  const effectiveDiagnostics = useMemo(
    () => diagnostics.flatMap(({ diagnostic, file }) => {
      const display = applyInspectionProfile(diagnostic, profile, { path: file.path ?? file.subtitle });
      return display ? [display] : [];
    }),
    [diagnostics, profile],
  );
  const dataFlow = useMemo(
    () => diagnostics.flatMap(({ file, diagnostic }) => {
      const display = applyInspectionProfile(diagnostic, profile, { path: file.path ?? file.subtitle });
      const evidence = display ? classifyProviderAnalysisEvidence(diagnostic) : null;
      return display && evidence
        ? [{ file, diagnostic, display, evidence }]
        : [];
    }),
    [diagnostics, profile],
  );
  const capabilities = capabilityRows(status);
  const baselineEntries: InspectionBaselineEntry[] = profile.baseline.entries;

  return (
    <section data-testid="code-workspace-analysis-panel" className="flex h-full min-h-0 flex-col text-[11px]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-2">
        <Activity className="h-3.5 w-3.5 text-[var(--taomni-accent)]" />
        <span className="font-medium">Analysis</span>
        <span className="ml-auto text-[10px] text-[var(--taomni-code-muted)]">
          {effectiveDiagnostics.length}/{diagnostics.length} visible
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 space-y-3">
        <section data-testid="analysis-semantic-index" className="space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <RefreshCw className={`h-3.5 w-3.5 ${semanticIndex.status === "building" ? "animate-spin" : ""}`} />
            <span>Semantic index snapshot</span>
          </div>
          <div className="space-y-1 rounded border border-[var(--taomni-code-border)] p-2 text-[10px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{workspaceSemanticIndexStatusLabel(semanticIndex)}</span>
              <span className="text-[var(--taomni-code-muted)]">
                {semanticIndex.provider === "language-server" ? "Language server provider" : "No semantic provider"}
              </span>
            </div>
            <div className="text-[var(--taomni-code-muted)]">
              Revision {semanticIndex.indexedRevision}/{semanticIndex.revision}
              {semanticIndex.invalidatedPaths.length > 0
                ? ` · ${semanticIndex.invalidatedPaths.length} invalidated path${semanticIndex.invalidatedPaths.length === 1 ? "" : "s"}`
                : ""}
            </div>
            {semanticIndex.activeProviders.length > 0 && (
              <div className="text-[var(--taomni-code-muted)]">
                Active provider work: {semanticIndex.activeProviders.join(", ")}
              </div>
            )}
            {semanticIndex.staleReasons.length > 0 && (
              <div className="text-amber-500">
                Pending invalidation: {semanticIndex.staleReasons.join(", ")}
              </div>
            )}
            {semanticIndex.error && <div className="text-red-500">{semanticIndex.error}</div>}
            {semanticIndex.lastQuery && (
              <div className="text-[var(--taomni-code-muted)]">
                Last query: {semanticIndex.lastQuery.kind} · generation {semanticIndex.lastQuery.generation}
                {semanticIndex.lastQuery.resultCount !== null ? ` · ${semanticIndex.lastQuery.resultCount} results` : ""}
                {semanticIndex.lastQuery.coverage && (
                  <> · {semanticIndex.lastQuery.coverage.scope} coverage {semanticIndex.lastQuery.coverage.providerCount ?? "?"}/{semanticIndex.lastQuery.coverage.sessionCount ?? "?"} providers{semanticIndex.lastQuery.coverage.complete ? " · complete" : " · incomplete"}</>
                )}
              </div>
            )}
            {semanticIndex.lastQuery?.coverage && (semanticIndex.lastQuery.coverage.diagnostics?.length ?? 0) > 0 && (
              <div className="text-amber-500" title={semanticIndex.lastQuery.coverage.diagnostics?.join("\n")}>
                Query diagnostics: {semanticIndex.lastQuery.coverage.diagnostics?.length}
              </div>
            )}
            <div className="text-[var(--taomni-code-muted)]">
              Provider-backed consistency metadata only. IntelliJ PSI/stub guarantees are not available yet.
            </div>
          </div>
        </section>

        <section data-testid="analysis-lsp-status" className="space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <Server className="h-3.5 w-3.5" />
            <span>Language server</span>
          </div>
          {!status && <div className="text-[var(--taomni-code-muted)]">Open a supported file to inspect capabilities.</div>}
          {status && (
            <div className="space-y-1 rounded border border-[var(--taomni-code-border)] p-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{status.displayName ?? status.presetId ?? "LSP"}</span>
                <span className={status.active ? "text-emerald-500" : "text-amber-500"}>
                  {status.active ? "active" : status.error ?? "inactive"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                {capabilities.map(([label, enabled]) => (
                  <span key={label} className="inline-flex items-center gap-1">
                    {enabled ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <Circle className="h-3 w-3" />}
                    {label}
                  </span>
                ))}
              </div>
              {status.capabilities?.codeActionKinds && status.capabilities.codeActionKinds.length > 0 && (
                <div className="pt-1 text-[10px] text-[var(--taomni-code-muted)]">
                  Code action kinds: {status.capabilities.codeActionKinds.join(", ")}
                </div>
              )}
              <div className="pt-1 text-[10px] text-[var(--taomni-code-muted)]">
                Semantic tokens received: {semanticTokenCount}
              </div>
            </div>
          )}
        </section>

        <section data-testid="analysis-inspection-profile" className="space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <Info className="h-3.5 w-3.5" />
            {/* §8.18.6 分账: this is a client-side PRESENTATION layer over
                provider diagnostics — it never configures or runs an
                inspection engine. */}
            <span>Diagnostic presentation profile</span>
          </div>
          <div className="text-[10px] text-[var(--taomni-code-muted)]">
            Display/severity overrides only — analysis runs in the language server.
          </div>
          {ruleIds.length === 0 && (
            <div className="text-[var(--taomni-code-muted)]">No provider diagnostics have supplied inspection ids yet.</div>
          )}
          {ruleIds.map((id) => {
            const rule = inspectionRuleFor(profile, id);
            const severityValue = rule.severity ?? "inherit";
            return (
              <div key={id} className="flex items-center gap-2 rounded border border-[var(--taomni-code-border)] px-2 py-1">
                <input
                  type="checkbox"
                  data-testid={`analysis-inspection-enabled-${id}`}
                  aria-label={`Show ${id} diagnostics`}
                  checked={rule.enabled}
                  onChange={(event) => onUpdateRule(id, { enabled: event.target.checked })}
                />
                <span className="min-w-0 flex-1 truncate" title={id}>{id}</span>
                <select
                  data-testid={`analysis-inspection-severity-${id}`}
                  aria-label={`Severity for inspection ${id}`}
                  value={severityValue}
                  onChange={(event) => {
                    const value = event.target.value === "inherit"
                      ? null
                      : Number(event.target.value) as InspectionSeverity;
                    onUpdateRule(id, { severity: value });
                  }}
                  className="h-6 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
                >
                  {SEVERITIES.map((severity) => (
                    <option key={String(severity.value)} value={severity.value}>{severity.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
          <div data-testid="analysis-inspection-baseline" className="space-y-1 rounded border border-[var(--taomni-code-border)] p-2">
            <div className="flex items-center gap-1">
              <span className="font-medium">Baseline</span>
              <span className="text-[10px] text-[var(--taomni-code-muted)]">{baselineEntries.length} entries</span>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" data-testid="analysis-baseline-create" className="h-6 rounded px-1.5 text-[10px] hover:bg-[var(--taomni-code-active-line-bg)]" onClick={onCreateBaseline}>Create from scope</button>
                <button type="button" data-testid="analysis-baseline-import" aria-label="Import inspection baseline" title="Import inspection baseline" className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]" onClick={onImportBaseline}><Upload className="h-3 w-3" /></button>
                <button type="button" data-testid="analysis-baseline-export" aria-label="Export inspection baseline" title="Export inspection baseline" className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]" onClick={onExportBaseline} disabled={baselineEntries.length === 0}><Download className="h-3 w-3" /></button>
                <button type="button" data-testid="analysis-baseline-clear" aria-label="Clear inspection baseline" title="Clear inspection baseline" className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]" onClick={onClearBaseline} disabled={baselineEntries.length === 0}><Trash2 className="h-3 w-3" /></button>
              </span>
            </div>
            {baselineEntries.length === 0 && <div className="text-[10px] text-[var(--taomni-code-muted)]">No baseline entries. Add a provider diagnostic from Problems.</div>}
            {baselineEntries.slice(0, 100).map((entry) => (
              <div key={inspectionBaselineEntryKey(entry)} className="flex min-w-0 items-center gap-1 text-[10px]">
                <span className="min-w-0 flex-1 truncate" title={`${entry.path}: ${entry.message}`}>{entry.inspectionId} · {entry.path} · {entry.message}</span>
                <button type="button" aria-label={`Remove baseline ${entry.inspectionId}`} title="Remove baseline entry" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]" onClick={() => onRemoveBaselineEntry(inspectionBaselineEntryKey(entry))}><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            <div className="text-[10px] text-[var(--taomni-code-muted)]">Baseline suppresses matching provider messages only; it is not a native inspection engine.</div>
          </div>
          <div data-testid="analysis-inspection-suppressions" className="space-y-1 rounded border border-[var(--taomni-code-border)] p-2">
            <div className="font-medium">Suppressions · {profile.suppressions.length}</div>
            {profile.suppressions.length === 0 && <div className="text-[10px] text-[var(--taomni-code-muted)]">No file or line suppressions.</div>}
            {profile.suppressions.slice(0, 100).map((entry) => (
              <div key={inspectionSuppressionKey(entry)} className="flex min-w-0 items-center gap-1 text-[10px]">
                <span className="min-w-0 flex-1 truncate" title={`${entry.path}:${entry.line == null ? "file" : entry.line + 1}`}>{entry.inspectionId} · {entry.path} · {entry.line == null ? "file" : `line ${entry.line + 1}`}</span>
                <button type="button" aria-label={`Remove suppression ${entry.inspectionId}`} title="Remove suppression" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]" onClick={() => onRemoveSuppression(inspectionSuppressionKey(entry))}><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </section>

        <section data-testid="analysis-data-flow" className="space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <Route className="h-3.5 w-3.5" />
            <span>Data-flow / related locations</span>
          </div>
          {dataFlow.length === 0 && (
            <div className="text-[var(--taomni-code-muted)]">
              No provider-backed analysis evidence is available. The language server must return
              nullability, taint, data-flow, or related-location metadata.
            </div>
          )}
          {dataFlow.map(({ file, diagnostic, display, evidence }, index) => (
            <div key={`${file.key}:${diagnosticInspectionId(diagnostic)}:${index}`} className="rounded border border-[var(--taomni-code-border)] p-2">
              <button
                type="button"
                className="flex w-full items-start gap-1 text-left hover:text-[var(--taomni-accent)]"
                onClick={() => onOpenDiagnostic(file.key, diagnostic)}
              >
                <span className="min-w-0 flex-1 break-words">{display.message}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </button>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--taomni-code-muted)]">
                <span data-testid={`analysis-evidence-kind-${evidence.kind}`}>{evidence.label}</span>
                <span>{evidence.confidence} provider evidence</span>
                <span data-testid="analysis-evidence-proof-level">
                  {evidence.proofLevel}
                  {evidence.presentationHint ? ` (${evidence.presentationHint})` : ""}
                </span>
                <span>{evidence.source}</span>
              </div>
              {evidence.flowSteps.length > 0 && (
                <div data-testid="analysis-evidence-flow-steps" className="mt-1 space-y-0.5 border-l border-[var(--taomni-code-border)] pl-2">
                  {evidence.flowSteps.map((step, stepIndex) => {
                    const label = flowStepLabel(step);
                    return step.location
                      ? (
                        <button
                          key={`${label}:${stepIndex}`}
                          type="button"
                          className="flex w-full items-start gap-1 text-left text-[10px] text-[var(--taomni-code-muted)] hover:text-[var(--taomni-accent)]"
                          onClick={() => onOpenLocation(step.location!)}
                        >
                          <span className="min-w-0 flex-1 break-words">{step.message}</span>
                          <span className="shrink-0 font-mono">{label}</span>
                        </button>
                      )
                      : (
                        <div key={`${label}:${stepIndex}`} className="text-[10px] text-[var(--taomni-code-muted)]">
                          {step.message} · {label}
                        </div>
                      );
                  })}
                </div>
              )}
              {diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0 && <div className="mt-1 space-y-0.5 border-l border-[var(--taomni-code-border)] pl-2">
                {diagnostic.relatedInformation?.map((related, relatedIndex) => (
                  <button
                    key={`${relatedLabel(related)}:${relatedIndex}`}
                    type="button"
                    className="flex w-full items-start gap-1 text-left text-[10px] text-[var(--taomni-code-muted)] hover:text-[var(--taomni-accent)]"
                    onClick={() => onOpenLocation(related.location)}
                  >
                    <span className="min-w-0 flex-1 break-words">{related.message}</span>
                    <span className="shrink-0 font-mono">{relatedLabel(related)}</span>
                  </button>
                ))}
              </div>}
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}
