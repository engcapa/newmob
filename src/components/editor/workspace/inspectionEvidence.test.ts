import { describe, expect, it } from "vitest";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import { classifyProviderAnalysisEvidence } from "./inspectionEvidence";

function diagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 2,
    code: "provider-rule",
    source: "provider",
    message: "Diagnostic",
    ...overrides,
  };
}

describe("inspectionEvidence", () => {
  it("prefers explicit nullability metadata", () => {
    expect(classifyProviderAnalysisEvidence(diagnostic({
      data: { analysisKind: "nullability", nullable: true },
      message: "Value may be null",
    }))).toMatchObject({
      kind: "nullability",
      confidence: "explicit",
      label: "Nullability",
    });
  });

  it("recognizes taint and data-flow evidence from provider text", () => {
    expect(classifyProviderAnalysisEvidence(diagnostic({ message: "Untrusted value reaches a sink" }))?.kind).toBe("taint");
    expect(classifyProviderAnalysisEvidence(diagnostic({ message: "Data-flow path crosses a call" }))?.kind).toBe("data-flow");
  });

  it("falls back to related-location evidence without inventing a flow category", () => {
    expect(classifyProviderAnalysisEvidence(diagnostic({
      relatedInformation: [{
        location: { uri: "file:///repo/a.ts", path: "/repo/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
        message: "Related source",
      }],
    }))).toMatchObject({ kind: "related-location", confidence: "explicit", relatedCount: 1 });
  });

  it("returns no evidence when the provider supplies no analysis signal", () => {
    expect(classifyProviderAnalysisEvidence(diagnostic())).toBeNull();
  });
});
