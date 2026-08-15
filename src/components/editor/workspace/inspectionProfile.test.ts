import { beforeEach, describe, expect, it } from "vitest";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import {
  applyInspectionProfile,
  applyInspectionProfileToDiagnostics,
  addDiagnosticToInspectionBaseline,
  addInspectionSuppression,
  clearInspectionBaseline,
  defaultInspectionProfile,
  diagnosticInspectionId,
  importInspectionBaseline,
  inspectionBaselineEntryKey,
  inspectionSuppressionKey,
  normalizeInspectionProfile,
  readInspectionProfile,
  removeInspectionSuppression,
  serializeInspectionBaseline,
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
      version: 2,
      rules: {
        "typescript:unused-value": { enabled: false, severity: null },
        "rustc:E0308": { enabled: true, severity: 1 },
      },
      suppressions: [],
      baseline: { createdAt: null, entries: [] },
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

  it("migrates a v1 profile and persists v2 independently per workspace", () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.inspectionProfile.v1.legacy",
      JSON.stringify({ version: 1, rules: { "ts:E": { enabled: false } } }),
    );
    expect(readInspectionProfile("legacy")).toMatchObject({
      version: 2,
      rules: { "ts:E": { enabled: false, severity: null } },
      suppressions: [],
    });
  });

  it("suppresses a provider diagnostic by portable file path and line", () => {
    const original = diagnostic();
    let profile = addInspectionSuppression(defaultInspectionProfile(), original, "root:app:src/main.ts", "line");
    expect(inspectionSuppressionKey(profile.suppressions[0])).toContain("root:app");
    expect(applyInspectionProfile(original, profile, { path: "root:app:src/main.ts" })).toBeNull();
    expect(applyInspectionProfile({ ...original, range: { ...original.range, start: { line: 2, character: 2 } } }, profile, { path: "root:app:src/main.ts" })).not.toBeNull();
    profile = removeInspectionSuppression(profile, inspectionSuppressionKey(profile.suppressions[0]));
    expect(profile.suppressions).toHaveLength(0);
  });

  it("matches baseline by provider id, portable path, and normalized message without line numbers", () => {
    const original = diagnostic({ message: "  Value   is never read\n" });
    let profile = addDiagnosticToInspectionBaseline(defaultInspectionProfile(), original, "root:app:src/main.ts", 10);
    const moved = { ...original, range: { ...original.range, start: { line: 99, character: 0 } }, message: "Value is never read" };
    expect(applyInspectionProfile(moved, profile, { path: "root:app:src/main.ts" })).toBeNull();
    expect(serializeInspectionBaseline(profile)).toContain('"schema": "taomni.codeWorkspace.inspectionBaseline"');
    const imported = importInspectionBaseline(clearInspectionBaseline(profile), serializeInspectionBaseline(profile));
    expect(imported.baseline.entries.map(inspectionBaselineEntryKey)).toEqual(profile.baseline.entries.map(inspectionBaselineEntryKey));
  });

  it("rejects malformed or unsupported baseline imports", () => {
    expect(() => importInspectionBaseline(defaultInspectionProfile(), "{}" )).toThrow(/schema|version/i);
    expect(() => importInspectionBaseline(defaultInspectionProfile(), "not json" )).toThrow(/valid JSON/i);
  });

  it("drops malformed line suppressions instead of widening them to the whole file", () => {
    const profile = normalizeInspectionProfile({
      suppressions: [
        { inspectionId: "ts:E", path: "root:app:src/main.ts", line: "1" },
        { inspectionId: "ts:E", path: "root:app:src/main.ts", line: -1 },
      ],
    });
    expect(profile.suppressions).toEqual([]);
  });
});
