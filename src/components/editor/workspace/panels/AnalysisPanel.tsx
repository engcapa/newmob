import { useMemo } from "react";
import { Activity, CheckCircle2, Circle, ExternalLink, Info, Route, Server } from "lucide-react";
import type {
  LspDiagnostic,
  LspDiagnosticRelatedInformation,
  LspDocumentStatus,
  LspLocation,
} from "../../../../lib/editor/lsp";
import type { InspectionProfile, InspectionRule, InspectionSeverity } from "../inspectionProfile";
import {
  applyInspectionProfile,
  applyInspectionProfileToDiagnostics,
  diagnosticInspectionId,
  inspectionRuleFor,
} from "../inspectionProfile";
import type { ProblemFileGroup } from "./ProblemsPanel";

interface AnalysisPanelProps {
  files: ProblemFileGroup[];
  status: LspDocumentStatus | null;
  semanticTokenCount: number;
  profile: InspectionProfile;
  onUpdateRule: (id: string, patch: Partial<InspectionRule>) => void;
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

export function AnalysisPanel({
  files,
  status,
  semanticTokenCount,
  profile,
  onUpdateRule,
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
    () => applyInspectionProfileToDiagnostics(
      diagnostics.map(({ diagnostic }) => diagnostic),
      profile,
    ),
    [diagnostics, profile],
  );
  const dataFlow = useMemo(
    () => diagnostics.flatMap(({ file, diagnostic }) => {
      const display = applyInspectionProfile(diagnostic, profile);
      return display && (diagnostic.relatedInformation?.length ?? 0) > 0
        ? [{ file, diagnostic, display }]
        : [];
    }),
    [diagnostics, profile],
  );
  const capabilities = capabilityRows(status);

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
            <span>Inspection profile</span>
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
                  aria-label={`Enable inspection ${id}`}
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
        </section>

        <section data-testid="analysis-data-flow" className="space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <Route className="h-3.5 w-3.5" />
            <span>Data-flow / related locations</span>
          </div>
          {dataFlow.length === 0 && (
            <div className="text-[var(--taomni-code-muted)]">
              No provider-backed data-flow path is available. LSP related locations are required.
            </div>
          )}
          {dataFlow.map(({ file, diagnostic, display }, index) => (
            <div key={`${file.key}:${diagnosticInspectionId(diagnostic)}:${index}`} className="rounded border border-[var(--taomni-code-border)] p-2">
              <button
                type="button"
                className="flex w-full items-start gap-1 text-left hover:text-[var(--taomni-accent)]"
                onClick={() => onOpenDiagnostic(file.key, diagnostic)}
              >
                <span className="min-w-0 flex-1 break-words">{display.message}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </button>
              <div className="mt-1 space-y-0.5 border-l border-[var(--taomni-code-border)] pl-2">
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
              </div>
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}
