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
