import type { LspDiagnostic, LspLocation } from "../../../lib/editor/lsp";
import { diagnosticInspectionId } from "./inspectionProfile";
import {
  buildCapabilityEvidence,
  type BuildEvidenceInput,
  type CapabilityEvidenceV3,
} from "./capabilityEvidence";

/**
 * §8.20.4 W3 provider adapter: wraps raw LSP diagnostics into the typed
 * ProviderDiagnosticV3 envelope. This is a PRESENTATION-layer adapter — it
 * never runs inspections, never parses source, and keyword inference stays a
 * presentationHint that never enters evidence completeness.
 */

export interface ProviderDiagnosticV3 {
  diagnostic: LspDiagnostic;
  evidence: CapabilityEvidenceV3;
  inspectionId: string;
  providerSeverity: 1 | 2 | 3 | 4 | null;
  relatedLocations: readonly LspLocation[];
}

function clampProviderSeverity(severity: number | null | undefined): 1 | 2 | 3 | 4 | null {
  return severity === 1 || severity === 2 || severity === 3 || severity === 4 ? severity : null;
}

export function toProviderDiagnosticV3(
  diagnostic: LspDiagnostic,
  evidenceInput: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">,
): ProviderDiagnosticV3 {
  const evidence = buildCapabilityEvidence({
    ...evidenceInput,
    capabilityId: `diagnostics.${diagnosticInspectionId(diagnostic)}`,
    // On-the-fly provider diagnostics never claim completeness by default.
    complete: false,
    reason: "on-the-fly diagnostic; completeness not claimed",
  });
  return {
    diagnostic,
    evidence,
    inspectionId: diagnosticInspectionId(diagnostic),
    providerSeverity: clampProviderSeverity(diagnostic.severity),
    relatedLocations: (diagnostic.relatedInformation ?? []).map((related) => related.location),
  };
}

/** Bulk mapping preserving order; evidence request ids stay unique. */
export function toProviderDiagnosticsV3(
  diagnostics: readonly LspDiagnostic[],
  evidenceInput: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">,
): ProviderDiagnosticV3[] {
  return diagnostics.map((diagnostic) => toProviderDiagnosticV3(diagnostic, evidenceInput));
}
