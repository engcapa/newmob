import { describe, expect, it } from "vitest";
import {
  validateEditorReleaseScope,
  auditEditorReleaseScopeCompliance,
  type DailyEditorReleaseScope,
} from "./editorReleaseScope";
import scopeJson from "../../../../qa-ui-auto-tests/daily-editor-linux.scope.json";

describe("§ED-QA-001: editorReleaseScope", () => {
  it("validates the daily-editor-linux scope json against schema invariants", () => {
    const res = validateEditorReleaseScope(scopeJson);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.capabilityCount).toBeGreaterThanOrEqual(9);
  });

  it("fails validation if observationPolicy allows mutations or missing readOnly", () => {
    const invalidScope = {
      ...scopeJson,
      observationPolicy: {
        readOnly: false,
        productionDisabled: false,
        redaction: "unredacted",
        disallowedActions: [],
      },
    };
    const res = validateEditorReleaseScope(invalidScope);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("observationPolicy.readOnly must be strictly true");
    expect(res.errors).toContain("observationPolicy.productionDisabled must be strictly true");
    expect(res.errors).toContain("observationPolicy.redaction must be 'hashes-and-counts-only' or 'full-redaction'");
  });

  it("audits compliance against available controls and testcases", () => {
    const scope = scopeJson as unknown as DailyEditorReleaseScope;
    const availableTestcases = scope.capabilities.map((c) => c.testcaseId);

    const allControls = scope.capabilities.flatMap((c) => c.controls);
    const audit = auditEditorReleaseScopeCompliance(scope, availableTestcases, allControls);

    expect(audit.compliant).toBe(true);
    expect(audit.uncoveredCapabilities).toEqual([]);
    expect(audit.missingControls).toEqual([]);
    expect(audit.readOnlyEnforced).toBe(true);
    expect(audit.productionDisabledEnforced).toBe(true);
    expect(audit.redactionEnforced).toBe(true);
  });

  it("identifies uncovered capabilities when testcase is missing", () => {
    const scope = scopeJson as unknown as DailyEditorReleaseScope;
    const audit = auditEditorReleaseScopeCompliance(scope, ["TC-IDE-C0-01"], []);
    expect(audit.compliant).toBe(false);
    expect(audit.uncoveredCapabilities.length).toBeGreaterThan(0);
    expect(audit.missingControls.length).toBeGreaterThan(0);
  });
});

describe("§ED-QA-002: behavior case mapping quality", () => {
  const scope = scopeJson as unknown as DailyEditorReleaseScope;

  it("ED-QA-002-A1: every scoped capability maps to non-shallow assertions with required effects", () => {
    expect(scope.capabilities.length).toBeGreaterThanOrEqual(9);
    for (const cap of scope.capabilities) {
      expect(cap.requiredEffects.length).toBeGreaterThanOrEqual(2);
      for (const effect of cap.requiredEffects) {
        expect(effect.trim().length).toBeGreaterThan(0);
        // Effects must describe actual outcomes, not shallow presence
        expect(effect).not.toMatch(/^(exists|visible|screenshot)$/i);
      }
    }
  });

  it("ED-QA-002-A2: catalog and scope compliance audits pass without missing controls or uncovered capabilities", () => {
    const availableTestcases = scope.capabilities.map((c) => c.testcaseId);
    const allControls = scope.capabilities.flatMap((c) => c.controls);
    const audit = auditEditorReleaseScopeCompliance(scope, availableTestcases, allControls);

    expect(audit.compliant).toBe(true);
    expect(audit.uncoveredCapabilities).toHaveLength(0);
    expect(audit.missingControls).toHaveLength(0);
    expect(audit.disallowedActionsEnforced).toBe(true);
  });

  it("ED-QA-002-A3: browser, native, and provider boundaries are explicit", () => {
    for (const cap of scope.capabilities) {
      expect(cap.requiredLayers.length).toBeGreaterThanOrEqual(2);
      expect(cap.requiredLayers).toContain("unit");
      expect(cap.requiredLayers.some((layer) => layer === "browser" || layer === "native")).toBe(true);
      expect(cap.providerRequirement.trim().length).toBeGreaterThan(0);
    }
  });

  it("ED-QA-002-A4: screenshots are supplemental only and capabilities define effect boundaries", () => {
    for (const cap of scope.capabilities) {
      expect(cap.testcaseId).toMatch(/^TC-IDE-C[0-9]/);
      // All capabilities define controls and effects beyond visual captures
      expect(cap.controls.length).toBeGreaterThan(0);
      expect(cap.requiredEffects.length).toBeGreaterThan(0);
    }
  });
});
