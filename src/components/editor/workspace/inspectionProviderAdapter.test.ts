import { describe, expect, it } from "vitest";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import { evidencePresentationLine, buildCapabilityEvidence } from "./capabilityEvidence";
import { toProviderDiagnosticsV3, toProviderDiagnosticV3 } from "./inspectionProviderAdapter";

const diagnostic = (overrides: Partial<LspDiagnostic> = {}): LspDiagnostic => ({
  range: { start: { line: 3, character: 4 }, end: { line: 3, character: 12 } },
  severity: 2,
  code: "67108674",
  source: "Java",
  message: "The import org.apache.commons cannot be resolved",
  ...overrides,
});

const evidenceInput = {
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 2 },
  projectFingerprint: "a".repeat(64),
  uri: "file:///repo/A.java",
  revision: 7,
} as const;

describe("inspectionProviderAdapter §8.20.4 ProviderDiagnosticV3", () => {
  it("wraps diagnostics with evidence envelope, inspection id and clamped severity", () => {
    const wrapped = toProviderDiagnosticV3(diagnostic({ severity: 9 }), evidenceInput);
    expect(wrapped.inspectionId).toBe("Java:67108674");
    expect(wrapped.providerSeverity).toBeNull();
    expect(wrapped.evidence.capabilityId).toBe("diagnostics.Java:67108674");
    expect(wrapped.evidence.coverage.complete).toBe(false);
    expect(wrapped.evidence.coverage.reason).toContain("on-the-fly");
    expect(wrapped.evidence.requestId).toMatch(/^diagnostics\.Java:67108674:2:\d+$/);
    expect(wrapped.relatedLocations).toEqual([]);
  });

  it("collects related locations and unique request ids across bulk mapping", () => {
    const withRelated = diagnostic({
      relatedInformation: [{
        location: {
          uri: "file:///repo/B.java",
          path: "/repo/B.java",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        message: "declared here",
      }],
    });
    const wrapped = toProviderDiagnosticsV3([withRelated, diagnostic()], evidenceInput);
    expect(wrapped[0]!.relatedLocations).toHaveLength(1);
    expect(wrapped[0]!.providerSeverity).toBe(2);
    expect(wrapped[0]!.evidence.requestId).not.toBe(wrapped[1]!.evidence.requestId);
  });
});

describe("capabilityEvidence presentation line", () => {
  it("shows provider/scope/revision/completeness without source text", () => {
    const line = evidencePresentationLine(buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.quickfix",
    }));
    expect(line).toBe("jdtls 1.61.0 · gen 2 · scope document · rev 7 · incomplete");
  });

  it("claims completeness only when the caller can cite the provider", () => {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.quickfix",
      complete: true,
      reason: null,
    });
    expect(evidence.coverage.complete).toBe(true);
    expect(evidencePresentationLine(evidence)).toContain("complete");
  });
});
