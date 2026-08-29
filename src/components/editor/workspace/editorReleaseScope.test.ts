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
    const availableTestcases = [
      "TC-IDE-C0-01-save-pipeline",
      "TC-IDE-C3-01-clipboard-multicaret",
      "TC-IDE-C4-01-tab-policy-lifecycle",
      "TC-IDE-C5-01-completion-resolve",
      "TC-IDE-C6-01-quick-fix-execution",
      "TC-IDE-C6-02-semantic-query-cancellation",
      "TC-IDE-C6-03-safe-delete-disabled",
      "TC-IDE-C7-01-project-descriptor-discovery",
      "TC-IDE-C8-01-shared-document-sync",
    ];

    const allControls = scope.capabilities.flatMap((c) => c.controls);
    const audit = auditEditorReleaseScopeCompliance(scope, availableTestcases, allControls);

    expect(audit.compliant).toBe(true);
    expect(audit.uncoveredCapabilities).toEqual([]);
    expect(audit.missingControls).toEqual([]);
    expect(audit.readOnlyEnforced).toBe(true);
    expect(audit.redactionEnforced).toBe(true);
  });

  it("identifies uncovered capabilities when testcase is missing", () => {
    const scope = scopeJson as unknown as DailyEditorReleaseScope;
    const audit = auditEditorReleaseScopeCompliance(scope, ["TC-IDE-C0-01-save-pipeline"], []);
    expect(audit.compliant).toBe(false);
    expect(audit.uncoveredCapabilities.length).toBeGreaterThan(0);
    expect(audit.missingControls.length).toBeGreaterThan(0);
  });
});
