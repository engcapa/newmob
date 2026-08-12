import { beforeEach, describe, expect, it } from "vitest";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import {
  applyInspectionProfile,
  applyInspectionProfileToDiagnostics,
  defaultInspectionProfile,
  diagnosticInspectionId,
  normalizeInspectionProfile,
  readInspectionProfile,
  updateInspectionRule,
  writeInspectionProfile,
} from "./inspectionProfile";

function diagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return {
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 5 },
    },
    severity: 2,
    code: "unused-value",
    source: "typescript",
    message: "Value is never read",
    ...overrides,
  };
}

describe("inspectionProfile", () => {
  beforeEach(() => window.localStorage.clear());

  it("normalizes malformed profiles and stores only meaningful overrides", () => {
    expect(normalizeInspectionProfile(null)).toEqual(defaultInspectionProfile());
    expect(normalizeInspectionProfile({
      rules: {
        "typescript:unused-value": { enabled: false, severity: 99 },
        "rustc:E0308": { enabled: true, severity: 1 },
        "default:rule": { enabled: true, severity: null },
        "": { enabled: false },
      },
    })).toEqual({
      version: 1,
      rules: {
        "typescript:unused-value": { enabled: false, severity: null },
        "rustc:E0308": { enabled: true, severity: 1 },
      },
    });
  });

  it("round-trips profiles independently per workspace", () => {
    const profile = updateInspectionRule(defaultInspectionProfile(), "rustc:dead_code", {
      enabled: false,
    });
    writeInspectionProfile("one", profile);
    expect(readInspectionProfile("one")).toEqual(profile);
    expect(readInspectionProfile("two")).toEqual(defaultInspectionProfile());
  });

  it("uses source and code as the stable inspection id with explicit fallbacks", () => {
    expect(diagnosticInspectionId(diagnostic())).toBe("typescript:unused-value");
    expect(diagnosticInspectionId(diagnostic({ source: null, code: null })))
      .toBe("language-server:*");
  });

  it("suppresses and overrides diagnostics without mutating the provider value", () => {
    const original = diagnostic();
    let profile = updateInspectionRule(defaultInspectionProfile(), diagnosticInspectionId(original), {
      severity: 1,
    });
    const overridden = applyInspectionProfile(original, profile);
    expect(overridden).toMatchObject({ severity: 1, message: original.message });
    expect(overridden).not.toBe(original);
    expect(original.severity).toBe(2);

    profile = updateInspectionRule(profile, diagnosticInspectionId(original), { enabled: false });
    expect(applyInspectionProfile(original, profile)).toBeNull();
    expect(applyInspectionProfileToDiagnostics([original, diagnostic({ code: "other" })], profile))
      .toHaveLength(1);
  });

  it("removes a rule once it returns to inherited defaults", () => {
    const id = "typescript:unused-value";
    const changed = updateInspectionRule(defaultInspectionProfile(), id, { enabled: false, severity: 3 });
    const reset = updateInspectionRule(changed, id, { enabled: true, severity: null });
    expect(reset.rules).toEqual({});
  });
});
